import { LRUCache } from "../common/lru-cache";
import type { LRUCacheOptions } from "../common/lru-cache";
import type { Bin, OutcomeLabelMap, Rounding } from "../common/types";
import {
  ALL_OUTCOME_TYPES,
  EPS,
  MISS_NONE_OUTCOME,
  sortOutcomes,
} from "../common/types";
import { denseConvolution, denseMap, labelText, type BinTable } from "./dense";
import { DiceQuery } from "./query";

/** Library caches hand the same PMF to every caller, so entries are frozen as they are stored. */
const sharedPMFCacheOptions: LRUCacheOptions<PMF> = {
  onInsert: (pmf) => pmf.freeze(),
  followsCachingToggle: true,
};

export const pmfCache = new LRUCache<string, PMF>(1000, sharedPMFCacheOptions);

/**
 * Relative slack when comparing a float-summed CDF with a target probability. Float running
 * sums drift by a few ulps; a target within this fraction of the CDF counts as reached.
 */
const QUANTILE_RELATIVE_SLACK = 1e-12;

/**
 * The map of a frozen PMF: a copy of the map it was built with that reads like any `Map` but whose
 * `set`, `delete` and `clear` throw a `TypeError`, so a PMF shared through a cache cannot be
 * changed through it. Only frozen PMFs pay for the copy; the unfrozen hot paths keep their own map.
 */
class FrozenBinMap extends Map<number, Bin> {
  constructor(source: ReadonlyMap<number, Bin>) {
    super();
    for (const [value, bin] of source) super.set(value, bin);
  }

  override set(value: number): never {
    throw new TypeError(`Cannot set damage value ${value}: this PMF is frozen (shared through a cache)`);
  }

  override delete(value: number): never {
    throw new TypeError(`Cannot delete damage value ${value}: this PMF is frozen (shared through a cache)`);
  }

  override clear(): never {
    throw new TypeError("Cannot clear the map: this PMF is frozen (shared through a cache)");
  }
}

/**
 * A 64-bit text hash (two 32-bit lanes, cyrb53 style) as 16 hex digits. It only names a PMF for
 * debugging (see {@link PMF.identifier}); nothing keys or orders on it, so a collision costs a
 * confusing name and never a wrong number.
 */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** JSON-quoted label keys, memoized: a fingerprint quotes the same few labels on every bin. */
/**
 * Complete numeric model for the stacked damage-attribution chart, produced by
 * {@link PMF.damageAttributionChartModel}. Carries every dice-and-probability
 * value the chart needs; a renderer only maps these numbers into its own format
 * (colors, human labels, axis units, dataset objects).
 */
export interface DamageAttributionChartModel {
  /** Bucket-start value for each column. Numeric; the caller stringifies for labels. */
  labels: number[];
  /** Present only when the distribution was coarsened; [start,end] inclusive, per bucket. */
  binRanges?: { start: number; end: number }[];
  /** Discovered outcome labels in stack order. Empty for pure (unattributed) distributions. */
  outcomes: string[];
  /** outcome → per-bucket probability mass (fraction 0..1). Bar heights. Σ over outcomes ≈ totals[i]. */
  series: Map<string, number[]>;
  /**
   * outcome → per-bucket conditional share (fraction 0..1) of that bucket's total.
   * Tooltip signal. 0 where the bucket total is below `epsilon`; otherwise Σ over
   * outcomes ≈ 1.
   */
  shares: Map<string, number[]>;
  /** Per-bucket total probability mass (fraction 0..1). The only signal for pure distributions. */
  totals: number[];
  /** Reversed-convention CCDF markers: damage at which P(X ≥ x) crosses 80/50/20%. */
  percentiles: { p80: number; p50: number; p20: number };
  /** Distribution mean, `this.mean()`. */
  mean: number;
}

/**
 * Probability Mass Function for discrete damage distributions.
 */
export class PMF {
  // Cached computed values
  private _support?: number[];
  private _min?: number;
  private _max?: number;
  private _totalMass?: number;
  private _mean?: number;
  private _variance?: number;
  private _stdev?: number;
  private _fingerprint?: string;
  private _binTable?: BinTable;
  private _contentId?: string;
  private readonly _identifier?: string;
  private _cumulative?: { values: number[]; below: number[]; above: number[] };
  private _frozen = false;
  /** {@link filterOutcome} results by outcome; a PMF is immutable, so each slice is built once. */
  private _outcomeSlices?: Map<string, PMF>;
  /** {@link splitByDealt}'s halves, built once. */
  private _dealtSplit?: [PMF, PMF];
  /** {@link outcomes}, built once. */
  private _outcomes?: string[];
  /**
   * {@link convolve}'s shared-cache key by operand identity, under `"RAW"|"N"@epsilon`: the key
   * is a function of the operands' content, so a repeat of the same two instances skips rebuilding
   * it. Weak on the operand, so a partner this PMF outlives is not held.
   */
  private _convolveKeys?: Map<string, WeakMap<PMF, string>>;

  /**
   * @param map Damage value → bin. Typed read-only: a PMF is immutable once built. A PMF returned
   *   from the library's caches is frozen: its bins, its map and the `map` property itself reject
   *   writes (see {@link freeze}).
   * @param identifier A name to keep for debugging, such as a parsed expression. Left out, the
   *   {@link identifier} is derived from the content.
   */
  constructor(
    public readonly map: ReadonlyMap<number, Bin> = new Map(),
    public readonly epsilon = EPS,
    public readonly normalized = false,
    identifier?: string,
    private readonly _preservedProvenance = true
  ) {
    this._identifier = identifier;
  }

  /**
   * A name for debugging and `toJSON`. Nothing in the library reads it as a cache key or as an
   * ordering key: both come from {@link fingerprint}, the content.
   *
   * A name given at construction is kept (a parsed expression, `"zero"`, `"empty"`), and
   * `normalize()` and `compact()` hand theirs on. Every other PMF is named from its content,
   * `pmf#` and 16 hex digits, so equal content reads the same however the PMF was built, and a
   * name never grows with the number of operations behind it.
   */
  get identifier(): string {
    return this._identifier ?? (this._contentId ??= `pmf#${hashText(this.fingerprint())}`);
  }

  /**
   * A PMF cache that freezes every stored PMF and follows `setCachingEnabled`. The library's
   * own caches are built with this.
   */
  static createCache(maxSize: number): LRUCache<string, PMF> {
    return new LRUCache<string, PMF>(maxSize, sharedPMFCacheOptions);
  }

  /**
   * Freezes this PMF so it can be shared through a cache. Every bin is deep-frozen, including its
   * `count` and `attr` maps, so writing to one throws a `TypeError`. The map is replaced by a copy
   * whose `set`/`delete`/`clear` throw a `TypeError` (the map this PMF was built with stays the
   * caller's), and the `map` property becomes read-only, so assigning it throws too.
   * Returns this PMF.
   */
  freeze(): this {
    if (this._frozen) return this;
    const map = new FrozenBinMap(this.map);
    for (const bin of map.values()) {
      Object.freeze(bin.count);
      if (bin.attr) Object.freeze(bin.attr);
      Object.freeze(bin);
    }
    // Frozen too, so no own `set`/`delete`/`clear` can be installed over the throwing ones.
    Object.freeze(map);
    // `as object`: `defineProperty` returns its target, which is not a derived PMF to keep.
    Object.defineProperty(this as object, "map", { value: map, writable: false, enumerable: true, configurable: false });
    this._frozen = true;
    return this;
  }

  static empty(epsilon = EPS, identifier = "empty") {
    return new PMF(new Map(), epsilon, false, identifier);
  }

  // This has a single bin at value 0, mass of 1
  static zero(epsilon = EPS): PMF {
    const m = new Map();
    m.set(0, { p: 1, count: { miss: 1 }, attr: {} });
    return new PMF(m, epsilon, false, "zero");
  }

  static delta(value: number, epsilon = EPS): PMF {
    return PMF.fromMap(new Map([[value, 1]]), epsilon);
  }

  /**
   * Point mass at damage 0 tagged with the canonical `missNone` outcome.
   *
   * Differs from {@link PMF.zero}, which labels its zero bin `miss` — the
   * builder's attack-resolution vocabulary. This uses the `missNone`
   * {@link OutcomeType} that the attribution charts and outcome stats key on,
   * so it is the correct "clean miss / no damage" delta for provenance-aware
   * mixtures feeding those consumers.
   */
  static missNone(epsilon = EPS): PMF {
    const m = new Map<number, Bin>();
    m.set(0, { p: 1, count: { [MISS_NONE_OUTCOME]: 1 }, attr: {} });
    return new PMF(m, epsilon, false, "missNone");
  }

  // This creates a single bin at value 0, but with weight 0.
  static emptyMass(): PMF {
    return PMF.zero().scaleMass(0);
  }

  //  Makes PMF iterable over [damage, bin] pairs.
  [Symbol.iterator](): IterableIterator<[number, Bin]> {
    return this.map[Symbol.iterator]();
  }

  static clearCache() {
    pmfCache.clear();
  }

  /**
   * Creates a conditional PMF from two branches (success and failure) and a probability.
   * This is the core logic for modeling any probabilistic event where there are two
   * distinct outcomes.
   */
  static branch(
    successPMF: PMF,
    failurePMF: PMF,
    successProbability: number
  ): PMF {
    let p = successProbability;
    if (!Number.isFinite(p)) p = 0;
    if (p < 0) p = 0;
    if (p > 1) p = 1;

    const q = 1 - p;

    // Fast paths. scaleMass(1) returns the same instance, so these hand back the
    // branch PMF unchanged. That is safe because PMFs are treated as immutable
    // (compact() and the other transforms now clone bins rather than mutate).
    if (p === 0) return failurePMF.scaleMass(1);
    if (p === 1) return successPMF.scaleMass(1);

    // Choose epsilon. You can also pick Math.min for a tighter threshold.
    const eps = successPMF.epsilon ?? failurePMF.epsilon;

    // Proper Bernoulli mixture: q·failure ⊕ p·success, assembled in a single
    // pass. The previous `empty().addScaled(failure,q).addScaled(success,p)`
    // chain copied failurePMF's bins twice (into the intermediate, then again
    // when the intermediate was copied by the second addScaled). Merging both
    // scaled branches directly into one fresh map keeps the same accumulation
    // order — q·failure first, then p·success — so the result is bit-identical.
    const resultMap = new Map<number, Bin>();
    for (const [damageValue, bin] of failurePMF.map) {
      PMF.mergeInto(resultMap, damageValue, PMF.scaleBin(bin, q));
    }
    for (const [damageValue, bin] of successPMF.map) {
      PMF.mergeInto(resultMap, damageValue, PMF.scaleBin(bin, p));
    }

    return new PMF(resultMap, eps, false);
  }

  /**
   * withProbability()
   *
   * A convenience wrapper around branch() for the common case where the "failure" branch is always zero().
   *
   *  Think of this as a shortcut for:
   *    pmf.gate(p, PMF.zero())
   *
   * Use this to model a *single* Bernoulli event — an outcome that either happens or doesn't,
   * like an opportunity attack that occurs with probability p, or a single attack that either hits or misses.
   *
   * This is **not** for combining multiple independent attacks or mutually exclusive multi-outcome scenarios.
   * - For multiple independent swings, use DiceQuery with separate PMFs for each attack.
   * - For modeling "first success" logic across multiple attacks (like Sneak Attack or Smite)
   *   use query.firstSuccessSplit() to get the exact probabilities.
   * - For scenarios with several mutually exclusive outcomes (like crit vs hit vs none), use PMF.exclusive().
   *
   */
  static withProbability(successPMF: PMF, probability: number): PMF {
    return PMF.branch(successPMF, PMF.zero(), probability);
  }

  /**
   * gate()
   *
   * A conditional wrapper around branch() that applies this PMF with probability `p`,
   * and applies a provided fallback PMF otherwise.
   *
   * This is useful for modeling a binary choice between two outcomes:
   * - The "success" outcome (this PMF) happens with probability `p`.
   * - The "failure" outcome (fallback PMF) happens with probability `1 - p`.
   *
   * Examples:
   * - 25% chance to include an opportunity attack, otherwise nothing:
   *     attackPMF.gate(0.25, PMF.zero())
   *
   * - 50% chance to deal fireball damage, otherwise cone of cold damage:
   *     fireballPMF.gate(0.5, coneOfColdPMF)
   *
   * Relationship to other helpers:
   * - **withProbability()** is a shortcut for the common case where the fallback is `PMF.zero()`.
   * - **exclusive()** is for three or more mutually exclusive outcomes (e.g., crit vs hit vs none).
   *
   * @param p Probability of applying this PMF (between 0 and 1).
   * @param fallback PMF to apply when this PMF is *not* selected.
   * @returns A new PMF representing the weighted mixture of this PMF and the fallback.
   */
  gate(p: number, fallback: PMF) {
    return PMF.branch(this, fallback, p);
  }

  /**
   * PMF.exclusive()
   *
   * Builds a single PMF from a set of mutually exclusive weighted outcomes.
   * Exactly one of the provided options will occur.
   *
   * Each option has:
   *  - A PMF representing its outcome (e.g., damage dice).
   *  - A weight representing its probability of being selected.
   *
   * Notes:
   *  - If total weight < 1 (within eps), leftover mass is assumed to be PMF.zero()
   *
   * @param options Array of `{ pmf, weight }` or `[PMF, number]`.
   * @param eps Optional tolerance for floating point rounding.
   */
  static exclusive(
    options: Array<{ pmf: PMF; weight: number } | [PMF, number]>,
    eps = EPS
  ): PMF {
    const items = options.map((o) =>
      Array.isArray(o) ? { pmf: o[0], weight: o[1] } : o
    );

    // Validate weights
    for (const { weight } of items) {
      if (!Number.isFinite(weight) || weight < -eps) {
        throw new Error(`PMF.exclusive: invalid weight ${weight}.`);
      }
    }

    // Sum and check
    let totalWeight = items.reduce((s, { weight }) => s + weight, 0);

    // Normalize tiny negatives to 0 and tiny overshoot to 1 when within eps
    if (Math.abs(totalWeight) <= eps) totalWeight = 0;
    if (Math.abs(1 - totalWeight) <= eps) totalWeight = 1;

    if (totalWeight > 1 + EPS) {
      throw new Error(
        `PMF.exclusive: total weight ${totalWeight} exceeds 1. (epsilon: ${eps})`
      );
    }

    // Accumulate scaled components, skipping near-zero weights
    let out = PMF.empty(eps);
    for (const { pmf, weight } of items) {
      if (weight > eps) out = out.addScaled(pmf, weight);
    }

    // Add leftover mass at zero outcome
    const leftover = Math.max(0, 1 - totalWeight);
    if (leftover > eps) {
      out = out.addScaled(PMF.zero(), leftover);
    }

    return out;
  }

  /**
   * PMF.mix()
   *
   * Builds a PMF as a linear combination of input PMFs with the given weights.
   * Unlike `exclusive`, this does NOT:
   *  - enforce that weights sum to 1
   *  - add leftover probability to δ0 (PMF.zero())
   *
   * Use when outcomes are not mutually exclusive, or for interpolation/blending.
   *
   * @param options Array of `{ pmf, weight }` or `[PMF, number]`.
   * @param eps Optional tolerance for skipping tiny weights.
   */
  static mix(
    options: Array<{ pmf: PMF; weight: number } | [PMF, number]>,
    eps = EPS
  ): PMF {
    const items = options.map((o) =>
      Array.isArray(o) ? { pmf: o[0], weight: o[1] } : o
    );

    // Validate weights, but do not constrain their sum.
    for (const { weight } of items) {
      if (!Number.isFinite(weight)) {
        throw new Error(`PMF.mix: invalid weight ${weight}.`);
      }
    }

    let out = PMF.empty(eps);
    for (const { pmf, weight } of items) {
      if (Math.abs(weight) <= eps) continue; // ignore crumbs
      out = out.addScaled(pmf, weight);
    }
    return out;
  }
  /**
   * Adds damage attribution metadata to this PMF based on existing count metadata.
   * For each bin, sets attr[outcome] = damage × count[outcome] for every
   * damage-dealing outcome; `missNone` (a clean miss, 0 damage) is never
   * attributed.
   *
   * This enables damage attribution charts to work with builder-generated PMFs.
   * The parser generates attr automatically, but builder PMFs only have count.
   *
   * @returns New PMF with attr field populated in each bin
   */
  /**
   * Returns true if this PMF already carries damage attribution metadata.
   *
   * Only the first positive-damage bin is inspected (parser-generated PMFs
   * populate `attr` uniformly), so this is O(1) in practice.
   */
  hasAttribution(): boolean {
    for (const [damage, bin] of this.map) {
      if (damage !== 0 && bin.attr && Object.keys(bin.attr).length > 0) {
        return true;
      }
      // Only check the first non-zero bin for performance
      if (damage > 0) break;
    }
    return false;
  }

  withAttribution(): PMF {
    // Fast path: if attr already exists, return this PMF unchanged
    if (this.hasAttribution()) return this;

    const newMap = new Map<number, Bin>();

    for (const [damage, bin] of this.map) {
      const attr: OutcomeLabelMap = {};

      // For each outcome type in count, compute its damage contribution.
      // `missNone` is the clean-miss label: it deals 0 damage, so it is never
      // attributed. After convolution the `count` channel folds `missNone` into
      // damage-bearing bins (a miss + hit pair), where `damage × count[missNone]`
      // would fabricate phantom missNone damage that the damage-share split then
      // drops. Skipping it keeps `attr` honest and matches the parser, which
      // never attributes `missNone` either.
      for (const outcome in bin.count) {
        if (outcome === MISS_NONE_OUTCOME) continue;
        const probability = bin.count[outcome] as number;
        if (probability > 0) {
          attr[outcome] = damage * probability;
        }
      }

      // Create new bin with attribution
      newMap.set(damage, {
        p: bin.p,
        count: { ...bin.count },
        attr: Object.keys(attr).length > 0 ? attr : undefined,
      });
    }

    return new PMF(newMap, this.epsilon, this.normalized);
  }

  /**
   * General-purpose N-way mixture.
   * weights: Array of [weight, PMF].
   *
   * Example: PMF.mixN([
   *   [pMiss, zero],
   *   [pHit, hitPMF],
   *   [pCrit, critPMF],
   * ]);
   */
  static mixN(weights: [number, PMF][], eps = EPS): PMF {
    // Treat tiny/negative as zero; keep performance clean
    const filtered = weights.filter(([w]) => w > eps);

    if (filtered.length === 0) {
      return PMF.emptyMass(); // not PMF.zero(): we want "no mass" mixture
    }

    // No need to normalize up front; accumulation blends by relative weight
    let acc: PMF | null = null;
    let sum = 0;

    for (const [w, pmf] of filtered) {
      if (acc === null) {
        acc = pmf;
        sum = w;
      } else {
        const q = w / (sum + w); // relative weight of the new component
        acc = PMF.branch(pmf, acc, q); // success=new pmf, failure=acc
        sum += w;
      }
    }

    // If everything got filtered out (all ~0), return empty mass
    return acc ?? PMF.emptyMass();
  }

  /**
   * False for a PMF produced by {@link power}, which folds independent attacks into one
   * distribution and cannot say which attack produced which label.
   */
  public preservedProvenance(): boolean {
    return this._preservedProvenance;
  }

  private getPowerCacheKey(n: number, eps: number): string {
    // Content, like convolve()'s key: `mapDamage`/`scaleDamage`, `normalize()` and `compact()`
    // can give two numerically different PMFs the same name, and equal PMFs built apart
    // should share an entry. `n` stands for the `n` operands the key used to spell out.
    return `pow${n}@${eps}|${this.fingerprint()}`;
  }

  /**
   * Convolves this PMF with itself `n` times, by exponentiation by squaring. `n` must be a
   * positive integer.
   *
   * NOTE: this folds `n` independent, identical attacks into one PMF, so it loses data
   * provenance. It is only safe when computing masses; for `atLeast`-style queries use a
   * `DiceQuery` instead of `power()`.
   */
  power(n: number, eps = this.epsilon): PMF {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("power(n): n must be a positive integer");
    }
    if (n === 1) return this;

    const epsilon = eps ?? this.epsilon;

    // Keyed on, and computed from, the normalized base: `normalize()` divides by `mass()`, which
    // sums in map order, so two equal unnormalized PMFs can normalize to different last bits and
    // must not share an entry keyed on their (equal) fingerprint.
    let base: PMF = this.normalized ? this : this.normalize();
    const key = base.getPowerCacheKey(n, epsilon);
    const cached = pmfCache.get(key);
    if (cached) return cached;

    // Start from the base PMF and accumulate n-1 additional powers
    let result: PMF = base;
    let exp = n - 1;

    while (exp > 0) {
      if (exp & 1) {
        result = result.convolve(base, epsilon);
      }
      exp >>= 1;
      if (exp > 0) {
        base = base.convolve(base, epsilon);
      }
    }

    // A copy carries the flag: `result` may be a convolution shared through the cache.
    const folded = new PMF(
      result.map,
      result.epsilon,
      result.normalized,
      undefined,
      false
    );
    pmfCache.set(key, folded);
    return folded;
  }

  /*
   * Helper for chaining multiple identical attacks
   */
  replicate(n: number): PMF[] {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("replicate(n): n must be a positive integer");
    }
    if (n === 1) return [this];
    return Array.from({ length: n }, () => this);
  }

  mass(): number {
    if (this._totalMass === undefined) {
      let totalProbabilityMass = 0;
      for (const { p } of this.map.values()) {
        totalProbabilityMass += p;
      }
      this._totalMass = totalProbabilityMass;
    }
    return this._totalMass;
  }

  outcomeMass(outcome: string): number {
    let totalProbabilityMass = 0;
    for (const { p, count } of this.map.values()) {
      totalProbabilityMass += p * ((count[outcome] as number) ?? 0);
    }
    return totalProbabilityMass;
  }

  // Helper for testing
  faceTotal(): number {
    return [...this.map.keys()].reduce((sum, key) => sum + key, 0);
  }

  normalize(): PMF {
    if (this.normalized) return this;
    const normalizationFactor = this.mass();
    if (normalizationFactor === 0) return this;

    // Note: this divides by normalizationFactor rather than multiplying by its
    // reciprocal, to keep results bit-identical to direct division.
    const normalizedMap = new Map<number, Bin>();
    for (const [damageValue, probabilityBin] of this.map) {
      const normalizedCount: OutcomeLabelMap = {};
      for (const labelKey in probabilityBin.count) {
        normalizedCount[labelKey] =
          (probabilityBin.count[labelKey] as number) / normalizationFactor;
      }

      let normalizedAttributes: OutcomeLabelMap | undefined;
      if (probabilityBin.attr) {
        normalizedAttributes = {};
        for (const labelKey in probabilityBin.attr) {
          normalizedAttributes[labelKey] =
            (probabilityBin.attr[labelKey] as number) / normalizationFactor;
        }
      }

      normalizedMap.set(damageValue, {
        p: probabilityBin.p / normalizationFactor,
        count: normalizedCount,
        attr: normalizedAttributes,
      });
    }
    return new PMF(normalizedMap, this.epsilon, true, this._identifier);
  }

  /**
   * Returns a copy with negligible probabilities removed (p < eps).
   * If keepFinalBin is true, the bin with the largest key is always kept,
   * even if its probability is below eps. count/attr submaps are still cleaned.
   */
  compact(eps = this.epsilon, keepFinalBin = false): PMF {
    let maxKey = -Infinity;
    if (keepFinalBin) {
      for (const key of this.map.keys()) {
        if (key > maxKey) maxKey = key;
      }
    }

    const compactedMap = new Map<number, Bin>();

    for (const [damageValue, probabilityBin] of this.map) {
      const shouldKeep =
        probabilityBin.p >= eps || (keepFinalBin && damageValue === maxKey);

      if (!shouldKeep) continue;

      // Build a fresh Bin rather than mutating the source. Bins are shared by
      // reference across PMFs (e.g. branch()/addScaled()/scaleMass() fast paths
      // can carry another PMF's bin objects), so deleting sub-eps entries in
      // place would silently corrupt the source PMF's count/attr.
      const cleanedBin = PMF.cloneBin(probabilityBin);

      for (const labelKey in cleanedBin.count) {
        if (Math.abs(cleanedBin.count[labelKey] || 0) < eps) {
          delete cleanedBin.count[labelKey];
        }
      }

      if (cleanedBin.attr) {
        for (const labelKey in cleanedBin.attr) {
          if (Math.abs(cleanedBin.attr[labelKey] || 0) < eps) {
            delete cleanedBin.attr[labelKey];
          }
        }
        if (Object.keys(cleanedBin.attr).length === 0) {
          cleanedBin.attr = undefined;
        }
      }

      compactedMap.set(damageValue, cleanedBin);
    }

    return new PMF(compactedMap, eps, this.normalized, this._identifier);
  }

  // Note: The "support" of a PMF is the set of all non-zero probability outcomes.
  // This returns all damage values with non-zero probability, sorted ascending.
  support(): number[] {
    if (this._support === undefined) {
      this._support = [...this.map.keys()].sort((a, b) => a - b);
    }
    return this._support!;
  }

  // Minimum possible damage value.
  min(): number {
    if (this._min === undefined) {
      const support = this.support();
      this._min = support.length > 0 ? support[0] : 0;
    }
    return this._min;
  }

  // Maximum possible damage value.
  max(): number {
    if (this._max === undefined) {
      const support = this.support();
      this._max = support.length > 0 ? support[support.length - 1] : 0;
    }
    return this._max;
  }

  /**
   * Returns the expected (mean) damage value, Σ v·p. Cached.
   *
   * On a PMF whose mass is not 1 this is the partial expectation (the slice's contribution to
   * the whole distribution's mean), not the conditional mean; `DiceQuery.mean()` divides by the
   * mass instead.
   */
  mean(): number {
    if (this._mean === undefined) {
      let totalSum = 0;
      for (const [damageValue, probabilityBin] of this.map) {
        totalSum += damageValue * probabilityBin.p;
      }
      this._mean = totalSum;
    }
    return this._mean;
  }

  /**
   * Returns the variance of the damage distribution. Cached.
   *
   * On a PMF whose mass is not 1 (a slice such as {@link filterOutcome}'s output) this is the
   * variance of the distribution conditioned on the slice, Σ (v − μ)²·p / m with μ = Σ v·p / m
   * and m = {@link mass}, the same quantity `DiceQuery.variance()` reports for that PMF. Note
   * that {@link mean} is not conditioned: it stays the partial expectation Σ v·p, so slices add
   * up. Within 1e-12 of unit mass (or at zero or negative mass) no conditioning is applied.
   */
  variance(): number {
    if (this._variance === undefined) {
      const mass = this.mass();
      const conditional = mass > 0 && Math.abs(mass - 1) > EPS;
      const meanValue = conditional ? this.mean() / mass : this.mean();
      let varianceSum = 0;
      for (const [damageValue, probabilityBin] of this.map) {
        const deviationFromMean = damageValue - meanValue;
        varianceSum += deviationFromMean * deviationFromMean * probabilityBin.p;
      }
      this._variance = conditional ? varianceSum / mass : varianceSum;
    }
    return this._variance;
  }

  /**
   * Returns the standard deviation of the damage distribution.
   */
  stdev(): number {
    if (this._stdev === undefined) {
      this._stdev = Math.sqrt(this.variance());
    }
    return this._stdev;
  }

  /** Deep-copies a Bin, cloning its count and (optional) attr maps. */
  private static cloneBin(bin: Bin): Bin {
    return {
      p: bin.p,
      count: { ...bin.count },
      attr: bin.attr ? { ...bin.attr } : undefined,
    };
  }

  /** Returns a new Bin with p, count, and attr all multiplied by `factor`. */
  private static scaleBin(bin: Bin, factor: number): Bin {
    const count: OutcomeLabelMap = {};
    for (const k in bin.count) {
      count[k] = (bin.count[k] as number) * factor;
    }

    let attr: OutcomeLabelMap | undefined;
    if (bin.attr) {
      attr = {};
      for (const k in bin.attr) {
        attr[k] = (bin.attr[k] as number) * factor;
      }
    }

    return { p: bin.p * factor, count, attr };
  }

  private static mergeInto(
    destinationMap: Map<number, Bin>,
    damageValue: number,
    binToAdd: Bin
  ) {
    const existingBin = destinationMap.get(damageValue);
    if (!existingBin) {
      destinationMap.set(damageValue, PMF.cloneBin(binToAdd));
      return;
    }

    existingBin.p += binToAdd.p;

    for (const labelKey in binToAdd.count) {
      existingBin.count[labelKey] =
        (existingBin.count[labelKey] || 0) +
        (binToAdd.count[labelKey] as number);
    }

    if (binToAdd.attr) {
      if (!existingBin.attr) {
        existingBin.attr = {};
      }
      for (const labelKey in binToAdd.attr) {
        existingBin.attr[labelKey] =
          (existingBin.attr[labelKey] || 0) +
          (binToAdd.attr[labelKey] as number);
      }
    }
  }

  // Convenience method
  add(other: PMF): PMF {
    return this.addScaled(other, 1);
  }

  /**
   * Returns a new PMF with `branch` added to this one, scaled by `probability` before merging —
   * the primitive for conditional effects. Example: `pmf.addScaled(critBranch, 0.05)` → a PMF
   * including a 5% crit slice.
   *
   * One pass: each of this PMF's bins is copied with the branch's bin at the same damage added
   * into it (its labels after this bin's, in the branch's order), then the branch's other bins
   * are copied after them. The same sums as copying every bin first and merging the branch in.
   */
  addScaled(branch: PMF, probability: number): PMF {
    if (probability === 0) return this;

    // `x * 1` is `x`: an unscaled branch merges its bins as they are. A scaled one has each value
    // multiplied as it is read — the same product `scaleBin` would store, without the bin it would build.
    const resultMap = new Map<number, Bin>();
    for (const [dmg, bin] of this.map) {
      const added = branch.map.get(dmg);
      if (added === undefined) {
        resultMap.set(dmg, PMF.cloneBin(bin));
        continue;
      }
      const count: OutcomeLabelMap = { ...bin.count };
      for (const labelKey in added.count) {
        const value = probability === 1 ? (added.count[labelKey] as number) : (added.count[labelKey] as number) * probability;
        count[labelKey] = (count[labelKey] || 0) + value;
      }
      let attr = bin.attr ? { ...bin.attr } : undefined;
      if (added.attr) {
        attr ??= {};
        for (const labelKey in added.attr) {
          const value = probability === 1 ? (added.attr[labelKey] as number) : (added.attr[labelKey] as number) * probability;
          attr[labelKey] = (attr[labelKey] || 0) + value;
        }
      }
      resultMap.set(dmg, { p: bin.p + (probability === 1 ? added.p : added.p * probability), count, attr });
    }
    for (const [dmg, bin] of branch.map) {
      if (!this.map.has(dmg)) resultMap.set(dmg, probability === 1 ? PMF.cloneBin(bin) : PMF.scaleBin(bin, probability));
    }

    return new PMF(resultMap, this.epsilon, false);
  }

  /**
   * Bernoulli thinning: the effect this PMF describes happens with probability
   * `frequency` and otherwise deals nothing — a conditional attack, an on-hit
   * rider, or a sub-one AoE target fraction. The result is
   * `frequency · X + (1 − frequency) · δ0`.
   *
   * Every bin (negative damage included) keeps `frequency` of its probability
   * mass, per-label `count` and per-label `attr`; the zero bin keeps its labels
   * at that share too. The freed mass, `(1 − frequency) · mass()`, is added to
   * the damage-0 bin under the canonical `missNone` outcome, so the total mass
   * is unchanged, also for a slice whose mass is not 1.
   *
   * Unlike a bare {@link scaleMass} or {@link mapDamage}, this keeps damage
   * attribution (`attr`) intact, so a frequency-scaled PMF still renders
   * correctly in the damage-attribution charts.
   *
   * `frequency >= 1` (or non-finite) returns this PMF unchanged; `frequency <= 0`
   * leaves only the damage-0 bin, holding all of the mass as `missNone`.
   *
   * @param frequency Probability in [0, 1] that the effect occurs.
   */
  applyHitFrequency(frequency: number): PMF {
    if (!Number.isFinite(frequency) || frequency >= 1) return this;
    const freq = Math.max(0, frequency);
    const freedMass = (1 - freq) * this.mass();

    const newMap = new Map<number, Bin>();
    if (freq > 0) {
      for (const [damage, bin] of this.map) {
        newMap.set(damage, PMF.scaleBin(bin, freq));
      }
    }
    if (freedMass > 0) {
      PMF.mergeInto(newMap, 0, {
        p: freedMass,
        count: { [MISS_NONE_OUTCOME]: freedMass },
        attr: {},
      });
    }

    return new PMF(newMap, this.epsilon, false);
  }

  /**
   * Splits this PMF into two complementary PMFs by an arbitrary per-damage-value factor in
   * `[0, 1]` — bin `d`'s mass, `count`, and `attr` split `factor(d)` / `1 - factor(d)` between the
   * two results (via the same proportional scaling {@link applyHitFrequency} uses, `scaleBin`), so
   * `a.add(b)` recovers this PMF exactly and both halves stay chart-attributable. Unlike
   * {@link applyHitFrequency}, mass is NOT redistributed to a miss bin at 0 — each bin stays at its
   * own damage value in whichever half it lands in. `factor` outside `[0, 1]` is clamped.
   *
   * Built for `dice-match` trigger slicing: splitting a hit/crit sub-PMF into "matched" and
   * "did not match" halves by the exact per-damage-value match probability.
   */
  splitByFactor(factor: (damage: number) => number): [PMF, PMF] {
    const a = new Map<number, Bin>();
    const b = new Map<number, Bin>();
    for (const [damage, bin] of this.map) {
      const f = Math.min(1, Math.max(0, factor(damage)));
      if (f > 0) a.set(damage, PMF.scaleBin(bin, f));
      if (f < 1) b.set(damage, PMF.scaleBin(bin, 1 - f));
    }
    return [
      new PMF(a, this.epsilon, false),
      new PMF(b, this.epsilon, false),
    ];
  }

  /**
   * {@link splitByFactor} by whether damage was dealt: `[above 0, at or below 0]`, each bin whole in
   * one half. Memoized: a turn plan splits the same slice at every fold block and every plan over it.
   */
  splitByDealt(): [PMF, PMF] {
    return (this._dealtSplit ??= this.splitByFactor((damage) => (damage > 0 ? 1 : 0)));
  }

  /**
   * Max of two i.i.d. copies of this PMF's distribution: normalize, square
   * the CDF, then restore the original mass. The engine's damage-reroll
   * substitution (`onFirstHit(keepBestDamage())`) applies this to a landing
   * attack's base payload slice — "roll it again, keep the better total".
   *
   * PRESERVES outcome labels and attribution. A max, unlike a sum, is
   * literally one of the two draws: the value that wins was drawn from this
   * same distribution, so its `count`/`attr` composition is unchanged in
   * *proportion* — only that bin's total mass is recomputed (via the
   * squared-CDF step) and every label is rescaled by the same factor. This
   * is why {@link power}'s documented provenance loss does not apply here:
   * for a sum, one output value arises from many `(x1, x2)` pairs with
   * different attribution mixes, so provenance is genuinely ambiguous; for a
   * max, there is exactly one realized draw per bin. A naive rebuild through
   * {@link fromMap} would silently discard both `count` and `attr`.
   *
   * Works on a non-unit-mass slice (e.g. {@link filterOutcome}'s output):
   * the CDF is squared on the NORMALIZED distribution, then the result is
   * rescaled back to this PMF's original total mass, not to 1.
   */
  maxOfTwo(): PMF {
    const totalMass = this.mass();
    if (totalMass <= 0) return this;

    const resultMap = new Map<number, Bin>();
    let cdf = 0; // running NORMALIZED cdf through the previous support value

    for (const damage of this.support()) {
      const bin = this.map.get(damage)!;
      const normalizedP = bin.p / totalMass;
      if (normalizedP <= 0) continue;

      const prevCdf = cdf;
      cdf += normalizedP;

      // P(max = damage), normalized: F(damage)² − F(damage⁻)², factored as
      // p·(F(damage) + F(damage⁻)). The difference of squares near 1 would
      // cancel the tail bins away; the factored form keeps full precision.
      // It also is the scale factor from the original bin to the new one:
      // reusing the bin's count/attr via scaleBin (rather than rebuilding from
      // a bare number) is what keeps every label's proportion intact.
      resultMap.set(damage, PMF.scaleBin(bin, cdf + prevCdf));
    }

    return new PMF(resultMap, this.epsilon, this.normalized);
  }

  scaleMass(factor: number): PMF {
    if (factor === 1) return this;

    const scaledMap = new Map<number, Bin>();
    for (const [damageValue, probabilityBin] of this.map) {
      scaledMap.set(damageValue, PMF.scaleBin(probabilityBin, factor));
    }
    return new PMF(scaledMap, this.epsilon, false);
  }

  mapDamage(damageTransformFunction: (damageValue: number) => number): PMF {
    const transformedMap = new Map<number, Bin>();
    for (const [originalDamage, probabilityBin] of this.map) {
      const transformedDamage = damageTransformFunction(originalDamage);
      PMF.mergeInto(
        transformedMap,
        transformedDamage,
        PMF.cloneBin(probabilityBin)
      );
    }
    return new PMF(transformedMap, this.epsilon, this.normalized);
  }

  /**
   * Multiplies every damage value by `factor / denominator` and rounds: `floor`
   * (toward −∞, the default), `ceil` (toward +∞) or `round` (to nearest, halves
   * toward +∞). Values that land on the same result merge, labels included.
   *
   * With an integer `factor` and `denominator` the rounding is exact: `v·factor`
   * is an exact integer, and one division of two integers below 2^53 lands on
   * the correct side of every integer. Pass a ratio that way, e.g.
   * `scaleDamage(9, "ceil", 7)`; `scaleDamage(9 / 7, "ceil")` rounds the factor
   * to a double first, so 21·(9/7) = 27.000000000000004 would round up to 28.
   */
  scaleDamage(
    factor: number,
    rounding: "floor" | "round" | "ceil" = "floor",
    denominator = 1
  ): PMF {
    if (!Number.isFinite(factor)) {
      throw new RangeError(`scaleDamage() factor must be finite, got ${factor}`);
    }
    if (!Number.isFinite(denominator) || denominator === 0) {
      throw new RangeError(`scaleDamage() denominator must be finite and non-zero, got ${denominator}`);
    }
    const exact = Number.isInteger(factor) && Number.isInteger(denominator);
    return this.mapDamage((damageValue) => {
      if (exact && Number.isInteger(damageValue)) {
        const numerator = damageValue * factor;
        if (rounding === "round") {
          return Math.floor((2 * numerator + denominator) / (2 * denominator));
        }
        const quotient = numerator / denominator;
        return rounding === "ceil" ? Math.ceil(quotient) : Math.floor(quotient);
      }
      const scaled = (damageValue * factor) / denominator;
      return rounding === "round"
        ? Math.round(scaled)
        : rounding === "ceil"
        ? Math.ceil(scaled)
        : Math.floor(scaled);
    });
  }

  /**
   * A content fingerprint of every bin (probability, per-label `count`, per-label `attr`) plus
   * the `normalized` flag. It is the key of the convolution and power caches and the order of a
   * convolve's operands, so it changes whenever the underlying numbers do. Mass/bin-count/
   * face-sum alone are not content-unique: `mapDamage` variants can share a name, support, mass
   * and face sum while differing in per-bin probabilities or in the `count`/`attr` channels
   * `convolve()`/`power()` actually propagate. Memoized because a PMF is immutable once
   * constructed, so a convolve() or power() call, cache hits included, does not rebuild it. Bin
   * order is sorted by damage value (and label keys sorted within each bin) so two equal-content
   * PMFs built via different code paths fingerprint identically regardless of Map insertion
   * order. Label keys are JSON-encoded, so a label containing the separators cannot make two
   * different bins read the same.
   */
  fingerprint(): string {
    if (this._fingerprint === undefined) {
      const damages = this.support();
      let text = this.normalized ? "1|" : "0|";
      for (let i = 0; i < damages.length; i++) {
        if (i > 0) text += ";";
        text += PMF.binSegment(damages[i], this.map.get(damages[i]) as Bin);
      }
      this._fingerprint = text;
    }
    return this._fingerprint;
  }

  /**
   * One bin's part of the {@link fingerprint}: `damage:p[count labels]{attr labels}`.
   * @internal
   */
  static binSegment(damage: number, bin: Bin): string {
    return `${damage}:${bin.p}[${labelText(bin.count)}]{${labelText(bin.attr)}}`;
  }

  /**
   * Whether `A`'s {@link fingerprint} sorts at or before `B`'s, as `A.fingerprint() <=
   * B.fingerprint()` would say, reading no further than the first bin that differs: the operand
   * order of a convolve whose operands are one-off, so no fingerprint is built for them.
   * @internal
   */
  static contentAtOrBefore(A: PMF, B: PMF): boolean {
    if (A._fingerprint !== undefined && B._fingerprint !== undefined) return A._fingerprint <= B._fingerprint;
    if (A.normalized !== B.normalized) return !A.normalized;
    const a = A.support();
    const b = B.support();
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = PMF.binSegment(a[i], A.map.get(a[i]) as Bin);
      const y = PMF.binSegment(b[i], B.map.get(b[i]) as Bin);
      if (x === y) continue;
      // The full strings go on with ";" and the next bin, or end here; comparing the segments
      // with that next character appended is comparing the full strings.
      return x + (i + 1 < a.length ? ";" : "") <= y + (i + 1 < b.length ? ";" : "");
    }
    return a.length <= b.length;
  }

  /**
   * The distribution of the sum of this PMF and `other`. The operands are ordered by
   * {@link fingerprint} (their content) and each is walked in ascending damage order, so the
   * result does not depend on which PMF was created first, on which operand is `this` or on how
   * either map was built: a float sum depends on the order its terms are added in, and
   * `a.convolve(b)` and `b.convolve(a)` add the same terms in the same order. The map-order
   * dependence left is in `mass()`, which adds in map order: a non-raw convolve first normalizes
   * an operand whose mass is not 1, and the mass invariant below rescales the result when the
   * operands' masses do not multiply out. So a cache hit, keyed on content alone, can hand back
   * a result an equal-content operand in another map order computed, a few ulps apart; a walk
   * that wants its own operands' bits every time uses {@link convolveRaw}.
   */
  convolve(other: PMF, eps?: number, raw = false): PMF {
    const epsilon = eps ?? this.epsilon;

    // The shared cache's key for these two operands is a function of their content, so it is
    // remembered by operand identity: a turn plan convolves the same slice with the same payloads
    // once per fold block, and a sweep repeats the same operands at every AC, so a repeat skips
    // normalizing, fingerprinting and building (and re-hashing) the key. The shared cache stays
    // the one place results live: its eviction and the caching toggle are unchanged.
    const identityKey = `${raw ? "RAW" : "N"}@${epsilon}`;
    let byOperand = this._convolveKeys?.get(identityKey);
    let cacheKey = byOperand?.get(other);
    if (cacheKey !== undefined) {
      const cached = pmfCache.get(cacheKey);
      if (cached) return cached;
    }

    // Normalize-by-value on non-raw path
    const norm = (x: PMF) =>
      raw ? x : Math.abs(x.mass() - 1) <= epsilon ? x : x.normalize();
    const A0 = norm(this);
    const B0 = norm(other);

    const [A, B] = A0.fingerprint() <= B0.fingerprint() ? [A0, B0] : [B0, A0];
    if (cacheKey === undefined) {
      cacheKey = `v5:${raw ? "RAW" : "N"}@${epsilon}|${A.fingerprint()}|${B.fingerprint()}`;
      if (byOperand === undefined) (this._convolveKeys ??= new Map()).set(identityKey, (byOperand = new WeakMap()));
      byOperand.set(other, cacheKey);
      const cached = pmfCache.get(cacheKey);
      if (cached) return cached;
    }

    const result = PMF.convolveOrdered(A, B, epsilon, raw);
    pmfCache.set(cacheKey, result);
    return result;
  }

  /**
   * `this ⊛ other` without renormalizing (`convolve` with `raw`), bypassing the shared cache:
   * the operands are ordered as {@link convolve} orders them and every sum is added in the same
   * order, so the result is the same bit for bit, but no fingerprint is built and nothing is
   * stored or frozen. For a walk whose running totals are each convolved once and never again.
   */
  convolveRaw(other: PMF, eps?: number): PMF {
    const epsilon = eps ?? this.epsilon;
    const [A, B] = PMF.contentAtOrBefore(this, other) ? [this, other] : [other, this];
    return PMF.convolveOrdered(A, B, epsilon, true);
  }

  /** `A ⊛ B` for operands already in content order, with the mass invariant enforced. */
  private static convolveOrdered(A: PMF, B: PMF, epsilon: number, raw: boolean): PMF {
    const map = PMF.convolveBins(A, B);
    // Enforce mass invariant: mass(out) = (raw? A.mass():1) * (raw? B.mass():1). The map is this
    // call's own, so it is rescaled in place: each value times the factor, as `scaleMass` would,
    // and like `scaleMass`'s result the rescaled PMF is not `normalized` (so the non-raw path
    // then divides it through, as it always has).
    const mExp = (raw ? A.mass() : 1) * (raw ? B.mass() : 1);
    const mGot = PMF.massOf(map);
    // Guard mGot !== 0: a zero-mass operand convolves to the zero measure
    // (mass 0). Without this guard the non-raw path would scaleMass(mExp/0) =
    // scaleMass(Infinity), poisoning every bin to 0*Infinity = NaN.
    const rescaled = mExp !== 0 && mGot !== 0 && Math.abs(mGot - mExp) > epsilon;
    if (rescaled) PMF.scaleInPlace(map, mExp / mGot);
    let result = new PMF(map, epsilon, !raw && !rescaled);
    if (!raw && mGot !== 0 && Math.abs(result.mass() - 1) > epsilon)
      result = result.normalize();
    return result;
  }

  /** The mass of `map`: its bins' `p` summed in map order, as {@link mass} sums them. */
  private static massOf(map: ReadonlyMap<number, Bin>): number {
    let total = 0;
    for (const { p } of map.values()) total += p;
    return total;
  }

  /** Every value of every bin of `map` times `factor`, in place: {@link scaleBin} without the copy. */
  private static scaleInPlace(map: ReadonlyMap<number, Bin>, factor: number): void {
    for (const bin of map.values()) {
      bin.p *= factor;
      const count = bin.count;
      for (const k in count) count[k] = (count[k] as number) * factor;
      const attr = bin.attr;
      if (attr) for (const k in attr) attr[k] = (attr[k] as number) * factor;
    }
  }

  /**
   * The bins of `A ⊛ B`. Both operands are walked in ascending damage order (`support()`,
   * memoized), so the terms of every float sum are added in an order that depends on content
   * alone, not on how a map was built: for each A bin, each B bin; within a pair, A's labels
   * then B's. The result map lists damage values in the order the walk first reaches them.
   *
   * Integer-valued operands accumulate in flat typed arrays indexed by `damage - lo` and by
   * label slot, which is what makes a convolution cheap; any other support takes the map-and-
   * object walk below, with the same sums in the same order.
   */
  private static convolveBins(A: PMF, B: PMF): Map<number, Bin> {
    const aDamages = A.support();
    const bDamages = B.support();
    if (aDamages.length === 0 || bDamages.length === 0) return new Map();
    if (aDamages.length === 1 || bDamages.length === 1) return PMF.convolveBinsShifted(A, B);
    const dense = denseConvolution(aDamages, A.binTable(), bDamages, B.binTable());
    return dense === null ? PMF.convolveBinsSparse(A, B) : denseMap(dense);
  }

  /**
   * {@link convolveBins} where one operand has a single bin (a slice that is one damage value: a
   * miss, a flat payload): every pair reaches its own damage, so each result bin is one pair's
   * terms, added to 0 as the walks above add them (`0 + x`, which is what keeps a `-0` out), in the
   * same label order: A's labels then B's. No slot arrays: the bins are built directly, in the
   * order the walk reaches them. Two pairs that round to one damage (a non-integer support) take
   * the map walk instead.
   */
  private static convolveBinsShifted(A: PMF, B: PMF): Map<number, Bin> {
    const combinedMap = new Map<number, Bin>();
    for (const aVal of A.support()) {
      const aBin = A.map.get(aVal) as Bin;
      const ap = aBin.p;
      for (const bVal of B.support()) {
        const bBin = B.map.get(bVal) as Bin;
        const bp = bBin.p;
        const dmg = aVal + bVal;
        if (combinedMap.has(dmg)) return PMF.convolveBinsSparse(A, B);
        const count: OutcomeLabelMap = {};
        for (const k in aBin.count) count[k] = 0 + (aBin.count[k] as number) * bp;
        for (const k in bBin.count) count[k] = (count[k] || 0) + (bBin.count[k] as number) * ap;
        const bin: Bin = { p: 0 + ap * bp, count };
        if (aBin.attr || bBin.attr) {
          const attr: OutcomeLabelMap = {};
          if (aBin.attr) for (const k in aBin.attr) attr[k] = 0 + (aBin.attr[k] as number) * bp;
          if (bBin.attr) for (const k in bBin.attr) attr[k] = (attr[k] || 0) + (bBin.attr[k] as number) * ap;
          bin.attr = attr;
        }
        combinedMap.set(dmg, bin);
      }
    }
    return combinedMap;
  }

  /**
   * This PMF's bins as flat arrays, in `support()` order: bin `i`'s probability, and its
   * `count` (`attr`) labels as local label indexes and values at `countStart[i]..countStart[i +
   * 1]` (`attrStart`), labels in each bin's own key order. Memoized: a PMF is immutable, and a
   * slice is convolved into many running totals.
   * @internal Also what a walk's {@link DenseTotal} convolves a slice from.
   */
  binTable(): BinTable {
    if (this._binTable === undefined) {
      const damages = this.support();
      const n = damages.length;
      const countLabels: string[] = [];
      const attrLabels: string[] = [];
      const p = new Float64Array(n);
      const hasAttr = new Uint8Array(n);
      const countStart = new Int32Array(n + 1);
      const attrStart = new Int32Array(n + 1);
      const countLabel: number[] = [];
      const countValue: number[] = [];
      const attrLabel: number[] = [];
      const attrValue: number[] = [];
      const list = (labels: string[], index: number[], value: number[], m: OutcomeLabelMap): void => {
        for (const key of Object.keys(m)) {
          const known = labels.indexOf(key);
          index.push(known === -1 ? labels.push(key) - 1 : known);
          value.push(m[key] as number);
        }
      };
      for (let i = 0; i < n; i++) {
        const bin = this.map.get(damages[i]) as Bin;
        p[i] = bin.p;
        countStart[i] = countLabel.length;
        attrStart[i] = attrLabel.length;
        list(countLabels, countLabel, countValue, bin.count);
        if (bin.attr !== undefined) {
          hasAttr[i] = 1;
          list(attrLabels, attrLabel, attrValue, bin.attr);
        }
      }
      countStart[n] = countLabel.length;
      attrStart[n] = attrLabel.length;
      this._binTable = {
        p,
        countLabels,
        attrLabels,
        hasAttr,
        countStart,
        countLabel: Int32Array.from(countLabel),
        countValue: Float64Array.from(countValue),
        attrStart,
        attrLabel: Int32Array.from(attrLabel),
        attrValue: Float64Array.from(attrValue),
      };
    }
    return this._binTable;
  }

  /** {@link convolveBins} for a non-integer (or very wide) support: the same walk over a map and label objects. */
  private static convolveBinsSparse(A: PMF, B: PMF): Map<number, Bin> {
    const keysOf = (m: OutcomeLabelMap | undefined): string[] | undefined =>
      m === undefined ? undefined : Object.keys(m);
    const valuesOf = (
      m: OutcomeLabelMap | undefined,
      keys: string[] | undefined
    ): number[] | undefined =>
      m === undefined || keys === undefined ? undefined : keys.map((key) => m[key] as number);
    const bDamages = B.support();
    const bProbability = new Array<number>(bDamages.length);
    const bCountKeys = new Array<string[]>(bDamages.length);
    const bCountValues = new Array<number[]>(bDamages.length);
    const bAttrKeys = new Array<string[] | undefined>(bDamages.length);
    const bAttrValues = new Array<number[] | undefined>(bDamages.length);
    bDamages.forEach((bVal, j) => {
      const bBin = B.map.get(bVal) as Bin;
      bProbability[j] = bBin.p;
      bCountKeys[j] = keysOf(bBin.count) as string[];
      bCountValues[j] = valuesOf(bBin.count, bCountKeys[j]) as number[];
      bAttrKeys[j] = keysOf(bBin.attr);
      bAttrValues[j] = valuesOf(bBin.attr, bAttrKeys[j]);
    });
    const combinedMap = new Map<number, Bin>();
    for (const aVal of A.support()) {
      const aBin = A.map.get(aVal) as Bin;
      const ap = aBin.p;
      const aCountKeys = keysOf(aBin.count) as string[];
      const aCountValues = valuesOf(aBin.count, aCountKeys) as number[];
      const aAttrKeys = keysOf(aBin.attr);
      const aAttrValues = valuesOf(aBin.attr, aAttrKeys);
      for (let j = 0; j < bDamages.length; j++) {
        const bp = bProbability[j];
        const dmg = aVal + bDamages[j];

        let dest = combinedMap.get(dmg);
        if (dest === undefined) {
          dest = { p: 0, count: {} };
          combinedMap.set(dmg, dest);
        }

        dest.p += ap * bp;

        const dc = dest.count;
        for (let i = 0; i < aCountKeys.length; i++) {
          const k = aCountKeys[i];
          dc[k] = (dc[k] || 0) + aCountValues[i] * bp;
        }
        const bCK = bCountKeys[j];
        const bCV = bCountValues[j];
        for (let i = 0; i < bCK.length; i++) {
          const k = bCK[i];
          dc[k] = (dc[k] || 0) + bCV[i] * ap;
        }

        const bAK = bAttrKeys[j];
        if (aAttrKeys || bAK) {
          let da = dest.attr;
          if (da === undefined) {
            da = {};
            dest.attr = da;
          }
          if (aAttrKeys && aAttrValues) {
            for (let i = 0; i < aAttrKeys.length; i++) {
              const k = aAttrKeys[i];
              da[k] = (da[k] || 0) + aAttrValues[i] * bp;
            }
          }
          const bAV = bAttrValues[j];
          if (bAK && bAV) {
            for (let i = 0; i < bAK.length; i++) {
              const k = bAK[i];
              da[k] = (da[k] || 0) + bAV[i] * ap;
            }
          }
        }
      }
    }
    return combinedMap;
  }

  /** {@link convolve} with `raw`: through the shared cache, unlike {@link convolveRaw}. */
  combineRaw(other: PMF, eps?: number): PMF {
    return this.convolve(other, eps, true);
  }

  /**
   * Convolves multiple PMFs left to right, each step through the convolution cache: every
   * prefix (A+B, (A+B)+C, …) is a stable cache key, so lists sharing a prefix share the work.
   */
  static convolveMany(pmfList: PMF[], eps = EPS): PMF {
    if (pmfList.length === 0) return PMF.empty(eps);
    let result = pmfList[0];
    for (let i = 1; i < pmfList.length; i++) {
      result = result.convolve(pmfList[i], eps);
    }
    return result;
  }

  /**
   * Returns a plain, JSON-serializable representation of this PMF.
   *
   * Follows the standard `toJSON` contract, so `JSON.stringify(pmf)` produces
   * the expected output (no double-encoding). Use {@link PMF.fromJSON} to
   * reconstruct, or {@link PMF.toJSONString} if you need the string directly.
   */
  toJSON(): {
    bins: Array<[number, Bin]>;
    normalized: boolean;
    identifier: string;
  } {
    return {
      bins: [...this.map.entries()],
      normalized: this.normalized,
      identifier: this.identifier,
    };
  }

  /** Serializes this PMF to a JSON string (equivalent to `JSON.stringify(pmf)`). */
  toJSONString(): string {
    return JSON.stringify(this);
  }

  static fromJSON(jsonData: {
    bins: Array<[number, Bin]>;
    normalized?: boolean;
    identifier?: string;
  }) {
    return new PMF(
      new Map(jsonData.bins),
      EPS,
      !!jsonData.normalized,
      jsonData.identifier || "fromJSON"
    );
  }

  /**
   * Relative pruning with optional top-K floor.
   * Keeps bins with p >= epsRel * peak, always keeps min and max damage,
   * optionally guarantees at least `minBins` survivors by adding top-K.
   * Returns a new, non-normalized PMF.
   */
  prune(epsRel: number, minBins = 0): PMF {
    const size = this.map.size;
    if (size === 0) return this;

    // One pass: peak, min, max
    let peak = 0;
    let minDamage = Number.POSITIVE_INFINITY;
    let maxDamage = Number.NEGATIVE_INFINITY;
    for (const [dmg, bin] of this.map) {
      if (bin.p > peak) peak = bin.p;
      if (dmg < minDamage) minDamage = dmg;
      if (dmg > maxDamage) maxDamage = dmg;
    }
    if (peak === 0)
      return new PMF(new Map(this.map), epsRel, false, this._identifier);

    const thresh = epsRel * peak;
    const entries = [...this.map.entries()];

    // Protect endpoints
    const survivorsByDmg = new Map<number, Bin>();
    const protect = (d: number) => {
      const b = this.map.get(d);
      if (b) survivorsByDmg.set(d, b);
    };
    protect(minDamage);
    if (maxDamage !== minDamage) protect(maxDamage);

    // Relative survivors
    for (const [dmg, bin] of entries) {
      if (bin.p >= thresh) survivorsByDmg.set(dmg, bin);
    }

    // Enforce minBins via top-K if requested
    if (minBins > 0 && survivorsByDmg.size < minBins) {
      // Sort all entries by probability desc (or replace with Quickselect for O(n))
      entries.sort((a, b) => b[1].p - a[1].p);
      for (const [dmg, bin] of entries) {
        if (!survivorsByDmg.has(dmg)) {
          survivorsByDmg.set(dmg, bin);
          if (survivorsByDmg.size >= minBins) break;
        }
      }
    }

    // Rebuild map, pruning tiny count/attr entries with the same threshold
    const prunedMap = new Map<number, Bin>();
    for (const [dmg, bin] of survivorsByDmg) {
      const newCount: OutcomeLabelMap = {};
      for (const k in bin.count) {
        const v = bin.count[k] as number;
        if (Math.abs(v) >= thresh) newCount[k] = v;
      }
      let newAttr: OutcomeLabelMap | undefined;
      if (bin.attr) {
        for (const k in bin.attr) {
          const v = bin.attr[k] as number;
          if (Math.abs(v) >= thresh) {
            if (!newAttr) newAttr = {};
            newAttr[k] = v;
          }
        }
      }
      prunedMap.set(dmg, { p: bin.p, count: newCount, attr: newAttr });
    }

    // Return non-normalized PMF
    return new PMF(prunedMap, epsRel, false);
  }

  /** Probability mass at exactly x. */
  pAt(x: number): number {
    return this.map.get(x)?.p ?? 0;
  }

  /**
   * P(any damage) — the mass on all non-zero outcomes, i.e. `1 - P(0)`.
   * Assumes a miss is encoded as the damage-0 bin (the convention used across
   * attack/save PMFs). The dual of {@link missProbability}.
   */
  hitProbability(): number {
    return 1 - this.pAt(0);
  }

  /** P(no damage) — the mass at damage 0. The dual of {@link hitProbability}. */
  missProbability(): number {
    return this.pAt(0);
  }

  /**
   * Coarsen the distribution into at most `maxBuckets` contiguous, equal-width
   * damage buckets, aggregating probability mass (and `count`/`attr`
   * provenance) into each bucket's start value. Returns this PMF unchanged when
   * its integer support already fits within `maxBuckets`.
   *
   * This is a lossy display/downsampling transform (bucket start replaces the
   * exact damage value) — use it for charting wide distributions, not for DPR
   * math.
   */
  rebin(maxBuckets: number): PMF {
    if (!(maxBuckets > 0)) return this;
    const support = this.support();
    if (support.length === 0) return this;
    const min = support[0];
    const max = support[support.length - 1];
    const range = max - min;
    if (range + 1 <= maxBuckets) return this;
    const binSize = Math.ceil((range + 1) / maxBuckets);
    return this.mapDamage((d) => min + Math.floor((d - min) / binSize) * binSize);
  }

  /** Dense integer support from min..max (inclusive). Useful for showing empty bars in charts. */
  denseSupport(): number[] {
    if (this.map.size === 0) return [];
    // `support()` is sorted, so its ends are the range; spreading it into Math.min/max would
    // overflow the stack on a wide distribution.
    const lo = this.min();
    const hi = this.max();
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }

  /** CDF at x: P(X ≤ x). */
  cdfAt(x: number): number {
    let acc = 0;
    for (const [val, bin] of this.map) if (val <= x) acc += bin.p;
    return acc;
  }

  /**
   * Quantile / inverse CDF: the smallest support value x with P(X ≤ x) ≥ p·mass().
   * `p <= 0` gives the smallest support value; `p >= 1` or NaN gives the largest.
   *
   * A float running sum can land an ulp short of a CDF that is exactly p (a d20's CDF(10) sums
   * to 0.49999999999999994), so the comparison allows a relative slack of a few ulps per bin.
   * Below the median it compares the CDF summed from the low end; above it, the mass strictly
   * above x summed from the high end. A sum of non-negative terms is accurate relative to its
   * own size, so the tail that decides the answer is never swamped by the rest of the mass.
   */
  quantile(p: number): number {
    const { values, below, above } = this.cumulative();
    const n = values.length;
    if (n === 0) return 0;
    const total = below[n - 1];
    if (!(total > 0)) return 0;
    if (p <= 0) return values[0];
    if (p >= 1) return values[n - 1];

    const slack = Math.max(QUANTILE_RELATIVE_SLACK, 4 * n * Number.EPSILON);
    const lowTarget = p * total * (1 - slack);
    const highTarget = (1 - p) * total * (1 + slack);
    const lowSide = p <= 0.5;

    // Smallest index whose CDF reaches p; the test is monotone in the index.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const reached = lowSide ? below[mid] >= lowTarget : above[mid] <= highTarget;
      if (reached) hi = mid;
      else lo = mid + 1;
    }
    return values[Math.min(lo, n - 1)];
  }

  /**
   * Sorted support with `below[i]` = Σ p over values ≤ values[i], summed from the low end,
   * and `above[i]` = Σ p over values > values[i], summed from the high end. Cached.
   */
  private cumulative(): { values: number[]; below: number[]; above: number[] } {
    if (this._cumulative === undefined) {
      const values = this.support();
      const n = values.length;
      const below = new Array<number>(n);
      const above = new Array<number>(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += (this.map.get(values[i]) as Bin).p;
        below[i] = sum;
      }
      sum = 0;
      for (let i = n - 1; i >= 0; i--) {
        above[i] = sum;
        sum += (this.map.get(values[i]) as Bin).p;
      }
      this._cumulative = { values, below, above };
    }
    return this._cumulative;
  }

  /** Get outcome probability at specific damage value. */
  outcomeAt(damage: number, outcome: string): number {
    return (this.map.get(damage)?.count[outcome] as number) ?? 0;
  }

  /** Get all outcome types present in this PMF. */
  outcomes(): string[] {
    if (this._outcomes !== undefined) return this._outcomes.slice();
    const outcomeSet = new Set<string>();
    for (const [, bin] of this.map) {
      for (const outcome in bin.count) {
        if ((bin.count[outcome] as number) > 0) {
          outcomeSet.add(outcome);
        }
      }
    }
    // Memoized (a PMF is immutable); each call hands out its own copy, as it always has.
    this._outcomes = Array.from(outcomeSet).sort();
    return this._outcomes.slice();
  }

  /** Get total probability of an outcome across all damage values. */
  outcomeProbability(outcome: string): number {
    let total = 0;
    for (const [, bin] of this.map) {
      total += (bin.count[outcome] as number) ?? 0;
    }
    return total;
  }

  /** Get damage attribution for an outcome at specific damage value. */
  outcomeAttributionAt(damage: number, outcome: string): number {
    return (this.map.get(damage)?.attr?.[outcome] as number) ?? 0;
  }

  /** Get all outcome data at specific damage value. */
  binAt(damage: number): {
    p: number;
    count: Record<string, number>;
    attr?: Record<string, number>;
  } | null {
    const bin = this.map.get(damage);
    if (!bin) return null;

    return {
      p: bin.p,
      count: { ...bin.count } as Record<string, number>,
      attr: bin.attr ? ({ ...bin.attr } as Record<string, number>) : undefined,
    };
  }

  /** Check if outcome exists in this PMF. */
  hasOutcome(outcome: string): boolean {
    for (const [, bin] of this.map) {
      if (((bin.count[outcome] as number) ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Split each damage value's probability mass across outcome labels, returning
   * per-label maps of `damage value → probability mass attributable to that
   * label`. Summing over labels at a given value recovers that value's `p`.
   *
   * Damage-bearing bins are split by `attr` weight — the damage each outcome
   * contributed (`attr[outcome]`). A hit and a crit that share a bin therefore
   * split it by the damage they each dealt, not by how many of them there were
   * (a fixed crit 11 + hit 6 that sum to 17 splits 11/17 crit, 6/17 hit). The
   * denominator is the attr of the labels actually drawn, so the drawn shares
   * sum to `p` exactly and mass is conserved. `missNone` contributes 0 damage,
   * so it never appears in a damage-bearing bin's split. The damage-0 bin
   * splits by `count` across every label present: `missNone` keeps its count
   * share, and a hit or crit that lands at 0 (a zero-damage attack, damage
   * reduced to 0 by resistance or a negative modifier, an effect-only attack)
   * keeps its own count share too, so the 0 bin's drawn shares still sum to
   * `p`. For an ordinary PMF whose hits always deal at least 1, the 0 bin holds
   * only `missNone`, so nothing changes there.
   *
   * Attribution is computed on demand via {@link withAttribution} when absent,
   * so builder-generated PMFs work too. Only when a damage bin genuinely
   * carries no usable attr — absent, all-zero, or containing a negative
   * contribution (a source whose damage was reduced below 0 by resistance or a
   * negative modifier) — does the split fall back to `count` for that bin,
   * still excluding `missNone`, so that bin's mass is not dropped.
   *
   * This is the provenance core of the stacked damage-attribution chart — the
   * caller only maps these series into its rendering format (colors, binning,
   * axis labels).
   */
  attributionByValue(): Map<string, Map<number, number>> {
    const src = this.hasAttribution() ? this : this.withAttribution();
    const result = new Map<string, Map<number, number>>();

    const add = (label: string, damage: number, mass: number): void => {
      if (!(mass > 0)) return;
      let series = result.get(label);
      if (!series) {
        series = new Map<number, number>();
        result.set(label, series);
      }
      series.set(damage, (series.get(damage) ?? 0) + mass);
    };

    for (const [damage, bin] of src.map) {
      const p = bin.p || 0;
      if (p <= 0) continue;

      // Damage-0 bin: split by count across every label present. `missNone`
      // keeps its count share; a hit or crit that lands at 0 (a zero-damage
      // attack, damage reduced to 0, an effect-only attack) keeps its own count
      // share too, so the drawn shares sum to p. For an ordinary PMF (hits
      // always deal at least 1) the 0 bin holds only `missNone`, so nothing
      // changes there.
      if (damage === 0) {
        let totalCount = 0;
        for (const k in bin.count) totalCount += (bin.count[k] as number) || 0;
        if (totalCount > 0) {
          for (const k in bin.count) {
            add(k, damage, (((bin.count[k] as number) || 0) / totalCount) * p);
          }
        }
        continue;
      }

      // Damage-bearing bin: split by damage share. `missNone` is excluded from
      // both the numerator and the denominator (it dealt 0 damage), so the
      // drawn shares always sum to p.
      const attr = bin.attr;
      let totalAttr = 0;
      let attrUsable = attr !== undefined;
      if (attr) {
        for (const k in attr) {
          if (k === MISS_NONE_OUTCOME) continue;
          const v = (attr[k] as number) || 0;
          // A negative contribution — a source whose damage was reduced below
          // 0 (resistance, a negative modifier) — makes the damage-share split
          // an invalid probability distribution: normalizing by a total that
          // includes it would give that label a negative share, which `add`
          // drops, drawing more than p. Fall back to the count split instead.
          if (v < 0) {
            attrUsable = false;
            break;
          }
          totalAttr += v;
        }
      }
      if (attrUsable && totalAttr > 0) {
        for (const k in attr) {
          if (k === MISS_NONE_OUTCOME) continue;
          add(k, damage, (((attr[k] as number) || 0) / totalAttr) * p);
        }
        continue;
      }

      // attr genuinely cannot say (absent, all-zero, or a negative
      // contribution): fall back to a count split — still excluding missNone —
      // so this bin's mass is conserved.
      let totalCount = 0;
      for (const k in bin.count) {
        if (k !== MISS_NONE_OUTCOME) totalCount += (bin.count[k] as number) || 0;
      }
      if (totalCount > 0) {
        for (const k in bin.count) {
          if (k === MISS_NONE_OUTCOME) continue;
          add(k, damage, (((bin.count[k] as number) || 0) / totalCount) * p);
        }
      }
    }

    return result;
  }

  /**
   * Reversed-convention CCDF percentile markers used by the attribution chart:
   * for each target probability t, the largest damage x still reached with
   * P(X ≥ x) > t%, falling back to the smallest/largest support value at the
   * edges. Ported verbatim from the app so `p80/p50/p20` keep their intentional
   * reversed meaning (p80 is the low-damage end). Computed on the full, un-binned
   * support. Assumes a non-empty map.
   */
  private attributionPercentiles(): { p80: number; p50: number; p20: number } {
    const sortedKeys = [...this.map.keys()].sort((a, b) => a - b);
    const sparseCCDF: { x: number; y: number }[] = [];
    let cumulativeP = 0;
    for (let i = sortedKeys.length - 1; i >= 0; i--) {
      const key = sortedKeys[i];
      const bin = this.map.get(key);
      if (!bin) continue;
      cumulativeP += bin.p;
      sparseCCDF.unshift({ x: key, y: cumulativeP * 100 });
    }
    const findDamageAtProbability = (targetProb: number): number => {
      for (let i = 0; i < sparseCCDF.length; i++) {
        if (sparseCCDF[i].y <= targetProb) {
          return i > 0 ? sparseCCDF[i - 1].x : sparseCCDF[i].x;
        }
      }
      return sparseCCDF[sparseCCDF.length - 1].x;
    };
    return {
      p80: findDamageAtProbability(80),
      p50: findDamageAtProbability(50),
      p20: findDamageAtProbability(20),
    };
  }

  /**
   * Full numeric model for the stacked damage-attribution chart — bar-height
   * masses, tooltip shares, bucket labels/ranges, percentile markers, and the
   * mean. The caller only maps these into a rendering format (colors, labels,
   * axis units); all of the dice-and-probability logic lives here.
   *
   * Built split-first-then-bin: the attribution split ({@link attributionByValue})
   * runs on the un-binned distribution, then the resulting series are coarsened.
   * {@link rebin} is deliberately *not* used — splitting the un-binned
   * distribution first keeps each outcome's damage share attached to its exact
   * damage value until the series are coarsened into buckets, rather than
   * folding sub-`binSize` damage into the damage-0 bucket before the split.
   *
   * @param options.maxBuckets Coarsen to at most this many equal-width buckets
   *   when the integer support is wider (`range > maxBuckets`); omit for a dense,
   *   per-integer model.
   * @param options.stackOrder Preferred outcome order (defaults to
   *   {@link ALL_OUTCOME_TYPES}); labels outside it sort alphabetically after.
   * @param options.epsilon Bucket-total floor below which a `shares` entry is 0
   *   (divide-by-~0 guard). Defaults to 1e-9.
   */
  damageAttributionChartModel(
    options: {
      maxBuckets?: number;
      stackOrder?: readonly string[];
      epsilon?: number;
    } = {}
  ): DamageAttributionChartModel {
    const { maxBuckets, stackOrder = ALL_OUTCOME_TYPES, epsilon = 1e-9 } = options;

    const empty: DamageAttributionChartModel = {
      labels: [],
      outcomes: [],
      series: new Map(),
      shares: new Map(),
      totals: [],
      percentiles: { p80: 0, p50: 0, p20: 0 },
      mean: 0,
    };
    if (this.map.size === 0) return empty;

    // Split on the un-binned distribution: outcome → (damage → probability mass).
    const split = this.attributionByValue();

    // Discover outcomes across BOTH count and attr keys so any all-zero legend
    // entries survive (matches the app's discovery), then order for stacking.
    const discovered = new Set<string>();
    for (const [, bin] of this.map) {
      for (const k in bin.count) discovered.add(k);
      if (bin.attr) for (const k in bin.attr) discovered.add(k);
    }
    const outcomes = sortOutcomes([...discovered], stackOrder);
    const hasAttribution = outcomes.length > 0;

    // Support window over values carrying positive mass (the app's allDamageValues):
    // from the split for attributed PMFs, from positive-p bins for pure ones.
    let min = Infinity;
    let max = -Infinity;
    const widen = (d: number): void => {
      if (d < min) min = d;
      if (d > max) max = d;
    };
    if (hasAttribution) {
      for (const s of split.values())
        for (const [d, m] of s) if (m > 0) widen(d);
    } else {
      for (const [d, bin] of this.map) if ((bin.p || 0) > 0) widen(d);
    }
    if (max < min) return empty; // nothing carried positive mass
    const range = max - min;

    // Binning geometry — dense (per-integer) unless range > maxBuckets.
    const binned =
      maxBuckets !== undefined && maxBuckets > 0 && range > maxBuckets;
    const binSize = binned ? Math.ceil((range + 1) / maxBuckets!) : 1;
    const numBins = binned ? Math.ceil((range + 1) / binSize) : range + 1;
    const bucketOf = (d: number): number => Math.floor((d - min) / binSize);

    const labels: number[] = [];
    const binRanges: { start: number; end: number }[] | undefined = binned
      ? []
      : undefined;
    for (let i = 0; i < numBins; i++) {
      const start = min + i * binSize;
      labels.push(start);
      if (binRanges)
        binRanges.push({ start, end: Math.min(start + binSize - 1, max) });
    }

    // Aggregate per-outcome masses into buckets.
    const series = new Map<string, number[]>();
    for (const outcome of outcomes) {
      const arr = new Array<number>(numBins).fill(0);
      const s = split.get(outcome);
      if (s) {
        for (const [d, m] of s) {
          const b = bucketOf(d);
          if (b >= 0 && b < numBins) arr[b] += m;
        }
      }
      series.set(outcome, arr);
    }

    // Per-bucket totals: sum of the attributed series, or (pure) of raw p.
    const totals = new Array<number>(numBins).fill(0);
    if (hasAttribution) {
      for (const arr of series.values())
        for (let i = 0; i < numBins; i++) totals[i] += arr[i];
    } else {
      for (const [d, bin] of this.map) {
        const p = bin.p || 0;
        if (p <= 0) continue;
        const b = bucketOf(d);
        if (b >= 0 && b < numBins) totals[b] += p;
      }
    }

    // Conditional shares for tooltips (guarded against a ~zero bucket total).
    const shares = new Map<string, number[]>();
    for (const outcome of outcomes) {
      const arr = series.get(outcome)!;
      const sh = new Array<number>(numBins).fill(0);
      for (let i = 0; i < numBins; i++) {
        sh[i] = totals[i] > epsilon ? arr[i] / totals[i] : 0;
      }
      shares.set(outcome, sh);
    }

    return {
      labels,
      binRanges,
      outcomes,
      series,
      shares,
      totals,
      percentiles: this.attributionPercentiles(),
      mean: this.mean(),
    };
  }

  tailProbGE(t: number): number {
    let s = 0;
    for (const [x, bin] of this) {
      if (bin.p > 0 && x >= t) s += bin.p;
    }
    return s;
  }

  tailProbGT(t: number): number {
    let s = 0;
    for (const [x, rec] of this) {
      if (x > t) s += rec.p;
    }
    return s;
  }

  /**
   * Returns a new PMF containing only bins where the specified outcome has non-zero probability.
   * This creates a marginal distribution for the given outcome type, with probabilities
   * scaled to represent the unconditional mass attributable to that outcome.
   *
   * Memoized: a PMF is immutable, and a turn plan slices the same source PMF by its outcomes
   * once per build (a DPR sweep builds thousands of plans over a few hundred PMFs). The first
   * call slices every outcome the bins carry in one pass; each slice is what a pass for that
   * outcome alone builds, bin by bin, in the same order. An outcome no bin carries is empty.
   */
  filterOutcome(outcome: string): PMF {
    const memo = (this._outcomeSlices ??= this.sliceEveryOutcome());
    let known = memo.get(outcome);
    if (known === undefined) memo.set(outcome, (known = new PMF(new Map(), this.epsilon, false)));
    return known;
  }

  private sliceEveryOutcome(): Map<string, PMF> {
    const maps = new Map<string, Map<number, Bin>>();
    for (const [damageValue, bin] of this.map) {
      const count = bin.count;
      // total paths that reached this bin (sum across labels)
      let totalCount = 0;
      for (const k in count) totalCount += (count[k] as number) ?? 0;
      if (!(totalCount > 0)) continue;
      for (const outcome in count) {
        const outcomeCount = (count[outcome] as number) ?? 0;
        if (!(outcomeCount > 0)) continue;

        // proportion of this bin's mass attributable to the outcome
        const proportion = outcomeCount / totalCount;

        // downweight p to the unconditional mass from the outcome only
        const newP = bin.p * proportion;

        const newCount: OutcomeLabelMap = { [outcome]: outcomeCount };

        let newAttr: OutcomeLabelMap | undefined;
        if (bin.attr && bin.attr[outcome] !== undefined) {
          // A count-like attr accumulator is scaled by the same proportion; a per-outcome-only
          // attr carries over as-is.
          newAttr = { [outcome]: (bin.attr[outcome] as number) * proportion };
        }

        let filteredMap = maps.get(outcome);
        if (filteredMap === undefined) maps.set(outcome, (filteredMap = new Map()));
        filteredMap.set(damageValue, { p: newP, count: newCount, attr: newAttr });
      }
    }
    const slices = new Map<string, PMF>();
    for (const [outcome, filteredMap] of maps) slices.set(outcome, new PMF(filteredMap, this.epsilon, false));
    return slices;
  }
  /**
   * Calculates probabilities for first-success outcomes across n independent attempts.
   *
   * @param pSuccess - Total probability of any success on a single attempt.
   * @param pSpecial - Probability of a specific subset of successes (e.g., critical success).
   * @param n - Number of independent attempts.
   *
   * Returns:
   *  - pSpecificSuccess: Probability that the first success was of the "special" type
   *  - pGeneralSuccess: Probability that the first success was of the non-special type
   *  - pNone: Probability that no successes occurred
   *  - pAny: Probability that at least one success occurred
   */
  public static firstSuccessWeights(
    pSuccess: number,
    pSpecial: number,
    n: number
  ) {
    // Preconditions: the "special" successes are a subset of all successes, so
    // 0 <= pSpecial <= pSuccess <= 1. Without this guard, violating inputs
    // silently produce probabilities outside [0,1].
    if (
      !Number.isFinite(pSuccess) ||
      !Number.isFinite(pSpecial) ||
      pSuccess < 0 ||
      pSuccess > 1 ||
      pSpecial < 0 ||
      pSpecial - pSuccess > EPS
    ) {
      throw new Error(
        `firstSuccessWeights: require 0 <= pSpecial <= pSuccess <= 1 (got pSuccess=${pSuccess}, pSpecial=${pSpecial})`
      );
    }

    const pFail = 1 - pSuccess;
    const pFailAll = Math.pow(pFail, n);

    // Probability of at least one success
    const pAny = 1 - pFailAll;

    // Avoid divide-by-zero if pSuccess is 0
    const denom = pSuccess === 0 ? 1 : pSuccess;

    // Breakdown of first success type
    const pSpecificSuccess = (pSpecial * pAny) / denom;
    const pGeneralSuccess = ((pSuccess - pSpecial) * pAny) / denom;

    const pNone = 1 - pSpecificSuccess - pGeneralSuccess; // Should equal pFailAll

    return { pSpecificSuccess, pGeneralSuccess, pNone, pAny };
  }

  /**
   * Maps every damage value through `f`, then optionally rounds it (`rounding`, default
   * `"none"`). Values that land on the same result merge their probability and, unless
   * `preserveCounts` is false, their per-label `count`. Damage attribution (`attr`) is dropped,
   * because it is tied to the old values. Nothing is pruned and the mass is unchanged.
   *
   * @param eps Epsilon carried by the result.
   * @throws Error when a mapped value is not a finite integer.
   */
  mapValues(
    f: (v: number) => number,
    eps: number = EPS,
    opts?: { rounding?: Rounding; preserveCounts?: boolean }
  ): PMF {
    const rounding = opts?.rounding ?? "none";
    const preserveCounts = opts?.preserveCounts ?? true;

    const round = (x: number) =>
      rounding === "floor"
        ? Math.floor(x)
        : rounding === "ceil"
        ? Math.ceil(x)
        : rounding === "round"
        ? Math.round(x)
        : x;

    const merged = new Map<number, Bin>();
    for (const [v, bin] of this) {
      if (bin.p === 0) continue;
      const u = round(f(v));
      if (!Number.isInteger(u)) {
        throw new Error(`mapValues: ${v} maps to ${u}, not a finite integer`);
      }
      PMF.mergeInto(merged, u, {
        p: bin.p,
        count: preserveCounts ? bin.count : {},
      });
    }

    const sorted = new Map([...merged.entries()].sort((a, b) => a[0] - b[0]));
    return new PMF(sorted, eps, this.normalized);
  }

  static fromMap(
    m: Map<number, number>,
    eps: number = EPS,
    { requireIntegerValues = true }: { requireIntegerValues?: boolean } = {}
  ): PMF {
    const filtered: Array<[number, number]> = [];
    for (const [v, p] of m) {
      if (!Number.isFinite(v) || !Number.isFinite(p)) continue;
      if (p <= 0 || Math.abs(p) < eps) continue;
      if (requireIntegerValues && !Number.isInteger(v)) {
        throw new Error(`fromMap: non-integer outcome ${v}`);
      }
      filtered.push([v, p]);
    }

    if (filtered.length === 0) {
      throw new Error("fromMap: empty or invalid input map");
    }

    // Kahan sum for stability
    let sum = 0;
    let c = 0;
    for (const [, p] of filtered) {
      const y = p - c;
      const t = sum + y;
      c = t - sum - y;
      sum = t;
    }
    if (sum <= 0) throw new Error("pmfFromMap: probabilities sum to 0");

    filtered.sort((a, b) => a[0] - b[0]);

    const internal = new Map<number, Bin>();
    for (const [v, p] of filtered) {
      internal.set(v, { p: p / sum, count: {} }); // keep count object present for consistency
    }
    return new PMF(internal, eps);
  }

  query(): DiceQuery {
    return new DiceQuery(this);
  }
}
