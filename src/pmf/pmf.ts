import { LRUCache } from "../common/lru-cache";
import type { Bin, OutcomeLabelMap, Rounding } from "../common/types";
import {
  ALL_OUTCOME_TYPES,
  EPS,
  MISS_NONE_OUTCOME,
  sortOutcomes,
} from "../common/types";
import { DiceQuery } from "./query";

const cacheEnabled = true;

export const pmfCache = new LRUCache<string, PMF>(1000);

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
  // Unique ID generator for anonymous PMFs to avoid cache key collisions
  private static __anonIdCounter = 1;

  // Cached computed values
  private _support?: number[];
  private _min?: number;
  private _max?: number;
  private _totalMass?: number;
  private _mean?: number;
  private _variance?: number;
  private _stdev?: number;
  private _fingerprint?: string;

  constructor(
    public readonly map: Map<number, Bin> = new Map(),
    public readonly epsilon = EPS,
    public readonly normalized = false,
    public readonly identifier: string = `anon#${PMF.__anonIdCounter++}`,
    private _preservedProvenance = true
  ) {}

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
    const id = `branch(${failurePMF.identifier}*${q.toFixed(6)} + ${
      successPMF.identifier
    }*${p.toFixed(6)})`;

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

    return new PMF(resultMap, eps, false, id);
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
   * For each bin, sets attr[outcome] = damage × count[outcome].
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

      // For each outcome type in count, compute its damage contribution
      for (const outcome in bin.count) {
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

    // Use a different identifier to avoid cache collisions with non-attributed version
    return new PMF(
      newMap,
      this.epsilon,
      this.normalized,
      `${this.identifier}~attr`
    );
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

    // No need to normalize up front; we accumulate and blend by relative weight
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

  // This is a convenience method for when we use power
  // TODO: It can be smarter in the future, and we can also add it to query
  // That way statistics operations on invalid PMFs can throw an error
  // TODO… how can we detect if manually merging two queries' combined PMFs, as that loses provenance?
  private setPreservedProvenance(preserved: boolean) {
    if (!this._preservedProvenance && preserved) {
      throw new Error(
        "Preserved provenance is already set to false, cannot fix that"
      );
    }
    this._preservedProvenance = preserved;
  }

  public preservedProvenance(): boolean {
    return this._preservedProvenance;
  }

  private getPowerCacheKey(n: number, eps: number): string {
    const id = this.identifier;
    let key = `${id}`;
    for (let i = 1; i < n; i++) key += `+${id}`;
    return `${key}@${eps}`;
  }

  /**
   * Efficiently computes this PMF convolved with itself `n` times.
   * Uses exponentiation by squaring to reduce total convolutions.
   * n must be a positive integer.
   * *
   * * NOTE: This folds multiple independent attacks into a single PMF.
   * As a result, The power() method causes a loss of data provenance.
   * This is ONLY SAFE if you are trying to calculate masses.
   * If you want to query any atLeast probabilities, you should use the DiceQuery class instead without power().
   */
  power(n: number, eps = this.epsilon): PMF {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("power(n): n must be a positive integer");
    }
    if (n === 1) return this;

    const epsilon = eps ?? this.epsilon;

    const key = this.getPowerCacheKey(n, epsilon);
    if (cacheEnabled) {
      const cached = pmfCache?.get(key);
      if (cached) return cached;
    }

    // Start from the base PMF and accumulate n-1 additional powers
    let base: PMF = this.normalized ? this : this.normalize();
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

    result.setPreservedProvenance(false);
    if (cacheEnabled) {
      pmfCache?.set(key, result);
    }
    return result;
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
    return new PMF(normalizedMap, this.epsilon, true, this.identifier);
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

    return new PMF(compactedMap, eps, this.normalized, this.identifier);
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
   * Returns the expected (mean) damage value.
   * Cached for performance since this requires iterating through all bins.
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
   * Returns the variance of the damage distribution.
   * Cached for performance since this requires mean calculation plus iteration.
   */
  variance(): number {
    if (this._variance === undefined) {
      const meanValue = this.mean();
      let varianceSum = 0;
      for (const [damageValue, probabilityBin] of this.map) {
        const deviationFromMean = damageValue - meanValue;
        varianceSum += deviationFromMean * deviationFromMean * probabilityBin.p;
      }
      this._variance = varianceSum;
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
   * Returns a new PMF with a scaled branch added to this one.
   * The branch PMF is scaled by the given probability before merging
   * This will be very useful for conditional effects and for being
   * able to model "I can probably have this opportunity attack 40% of rounds"
   * Example: `pmf.addScaled(critBranch, 0.05)` → PMF including 5% crit outcomes
   */
  addScaled(branch: PMF, probability: number): PMF {
    if (probability === 0) return this;

    const resultMap = new Map<number, Bin>();
    for (const [dmg, bin] of this.map) {
      resultMap.set(dmg, PMF.cloneBin(bin));
    }

    for (const [damageValue, probabilityBin] of branch.map) {
      PMF.mergeInto(
        resultMap,
        damageValue,
        PMF.scaleBin(probabilityBin, probability)
      );
    }

    return new PMF(
      resultMap,
      this.epsilon,
      false,
      `${this.identifier}+scaled(${branch.identifier},${probability})`
    );
  }

  /**
   * Redistributes probability mass to model an effect that only occurs with
   * probability `frequency` — a conditional attack, an on-hit rider, or a
   * sub-one AoE target fraction.
   *
   * Every hit outcome (damage > 0) is scaled by `frequency` — probability mass,
   * per-label `count`, AND per-label `attr` — and the freed mass is moved into
   * the miss bin at damage 0, tagged with the canonical `missNone` outcome.
   * Total probability mass is preserved.
   *
   * Unlike a bare {@link scaleMass} or {@link mapDamage}, this keeps damage
   * attribution (`attr`) intact, so a frequency-scaled PMF still renders
   * correctly in the damage-attribution charts.
   *
   * `frequency >= 1` (or non-finite) returns this PMF unchanged; `frequency <= 0`
   * collapses all mass into the miss bin. The miss outcome is assumed to be
   * encoded at damage value 0.
   *
   * @param frequency Probability in [0, 1] that the effect occurs.
   */
  applyHitFrequency(frequency: number): PMF {
    if (!Number.isFinite(frequency) || frequency >= 1) return this;
    const freq = Math.max(0, frequency);

    const pMiss = this.pAt(0);
    const pHit = 1 - pMiss;
    const newMissMass = pMiss + (1 - freq) * pHit;

    const newMap = new Map<number, Bin>();
    newMap.set(0, {
      p: newMissMass,
      count: { [MISS_NONE_OUTCOME]: newMissMass },
      attr: {},
    });

    for (const [damage, bin] of this.map) {
      if (damage <= 0) continue;
      newMap.set(damage, PMF.scaleBin(bin, freq));
    }

    return new PMF(
      newMap,
      this.epsilon,
      false,
      `freq(${this.identifier},${freq})`
    );
  }

  scaleMass(factor: number): PMF {
    if (factor === 1) return this;

    const scaledMap = new Map<number, Bin>();
    for (const [damageValue, probabilityBin] of this.map) {
      scaledMap.set(damageValue, PMF.scaleBin(probabilityBin, factor));
    }
    return new PMF(
      scaledMap,
      this.epsilon,
      false,
      `scale(${this.identifier},${factor})`
    );
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
    return new PMF(
      transformedMap,
      this.epsilon,
      this.normalized,
      `map(${this.identifier})`
    );
  }

  scaleDamage(
    factor: number,
    rounding: "floor" | "round" | "ceil" = "floor"
  ): PMF {
    const roundFunction =
      rounding === "round"
        ? Math.round
        : rounding === "ceil"
        ? Math.ceil
        : Math.floor;
    return this.mapDamage((damageValue) => roundFunction(damageValue * factor));
  }

  private getPMFCombineCacheKey(
    p1: PMF,
    p2: PMF,
    eps: number,
    raw: boolean
  ): string {
    const [id1, id2] = [p1.identifier, p2.identifier].sort();

    return `v4:${raw ? "RAW" : "N"}:${id1}+${id2}@${eps}|${p1.fingerprint()}|${p2.fingerprint()}`;
  }

  /**
   * A small content fingerprint (mass + bin count + face sum) so convolution
   * cache keys change if the underlying numbers do. Memoized because a PMF is
   * immutable once constructed — this avoids re-summing every key on each
   * convolve() call (including cache hits).
   */
  fingerprint(): string {
    if (this._fingerprint === undefined) {
      let faceSum = 0;
      for (const k of this.map.keys()) faceSum += k;
      this._fingerprint = `${this.mass().toFixed(12)}|${this.map.size}|${faceSum}`;
    }
    return this._fingerprint;
  }

  convolve(other: PMF, eps?: number, raw = false): PMF {
    const epsilon = eps ?? this.epsilon;

    // Normalize-by-value on non-raw path
    const norm = (x: PMF) =>
      raw ? x : Math.abs(x.mass() - 1) <= epsilon ? x : x.normalize();
    const A0 = norm(this);
    const B0 = norm(other);

    const [A, B] = A0.identifier <= B0.identifier ? [A0, B0] : [B0, A0];
    const cacheKey = this.getPMFCombineCacheKey(A, B, epsilon, raw);
    const cached = pmfCache?.get(cacheKey);
    if (cached) return cached;

    // Accumulate directly into each destination bin instead of building a
    // temporary Bin per (a,b) pair and merging it. The probability channel
    // (`dest.p += ap*bp`) accumulates in the same order as before, so it is
    // bit-identical; only the per-label `count`/`attr` sums re-associate, which
    // shifts them by at most a few ULP (far below the eps pruning threshold).
    const combinedMap = new Map<number, Bin>();
    for (const [aVal, aBin] of A.map) {
      const ap = aBin.p;
      const aCount = aBin.count;
      const aAttr = aBin.attr;
      for (const [bVal, bBin] of B.map) {
        const bp = bBin.p;
        const dmg = aVal + bVal;

        let dest = combinedMap.get(dmg);
        if (dest === undefined) {
          dest = { p: 0, count: {} };
          combinedMap.set(dmg, dest);
        }

        dest.p += ap * bp;

        const dc = dest.count;
        for (const k in aCount) dc[k] = (dc[k] || 0) + (aCount[k] as number) * bp;
        for (const k in bBin.count)
          dc[k] = (dc[k] || 0) + (bBin.count[k] as number) * ap;

        if (aAttr || bBin.attr) {
          let da = dest.attr;
          if (da === undefined) {
            da = {};
            dest.attr = da;
          }
          if (aAttr)
            for (const k in aAttr) da[k] = (da[k] || 0) + (aAttr[k] as number) * bp;
          if (bBin.attr)
            for (const k in bBin.attr)
              da[k] = (da[k] || 0) + (bBin.attr[k] as number) * ap;
        }
      }
    }

    let result = new PMF(
      combinedMap,
      epsilon,
      !raw,
      `${A.identifier}${raw ? "*" : "+"}${B.identifier}`
    );

    // Enforce mass invariant: mass(out) = (raw? A.mass():1) * (raw? B.mass():1)
    const mExp = (raw ? A.mass() : 1) * (raw ? B.mass() : 1);
    const mGot = result.mass();
    // Guard mGot !== 0: a zero-mass operand convolves to the zero measure
    // (mass 0). Without this guard the non-raw path would scaleMass(mExp/0) =
    // scaleMass(Infinity), poisoning every bin to 0*Infinity = NaN.
    if (mExp !== 0 && mGot !== 0 && Math.abs(mGot - mExp) > epsilon) {
      result = result.scaleMass(mExp / mGot);
    }
    if (!raw && mGot !== 0 && Math.abs(result.mass() - 1) > epsilon)
      result = result.normalize();

    pmfCache?.set(cacheKey, result);
    return result;
  }

  // 3) Nice wrapper so you can call pmf.combineRaw(other)
  combineRaw(other: PMF, eps?: number): PMF {
    return this.convolve(other, eps, true);
  }

  // Reduce a list of PMFs by left-folding convolve() with the given eps
  private static reduceConvolveLeft(pmfList: PMF[], eps: number): PMF {
    let result = pmfList[0];
    for (let i = 1; i < pmfList.length; i++) {
      result = result.convolve(pmfList[i], eps);
    }
    return result;
  }

  /**
   * Convolves multiple PMFs using linear convolution with automatic caching.
   * Uses a left-to-right accumulation approach for maximum cache reuse.
   * Each convolve() call automatically uses the convolution cache for performance.
   *
   * This linear approach provides better cache hits than pairwise because:
   * - Intermediate results are more predictable and stable
   * - Similar PMF lists share common prefixes (A+B, (A+B)+C, etc.)
   * - Order-independent cache keys work better with consistent build patterns
   */
  static convolveMany(pmfList: PMF[], eps = EPS): PMF {
    if (pmfList.length === 0) return PMF.empty(eps);
    if (pmfList.length === 1) return pmfList[0];

    // Linear combination with automatic intermediate caching: each prefix
    // (A+B, (A+B)+C, ...) is a stable cache key, maximizing reuse.
    return PMF.reduceConvolveLeft(pmfList, eps);
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
      return new PMF(new Map(this.map), epsRel, false, this.identifier);

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
    return new PMF(prunedMap, epsRel, false, `prune(${this.identifier})`);
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

  /** Dense integer support from min..max (inclusive).
   * Useful for showing empty bars in charts.
   */
  denseSupport(): number[] {
    const s = this.support();
    if (s.length === 0) return [];
    const lo = Math.min(...s),
      hi = Math.max(...s);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).sort(
      (a, b) => a - b
    );
  }

  /** CDF at x: P(X ≤ x). */
  cdfAt(x: number): number {
    let acc = 0;
    for (const [val, bin] of this.map) if (val <= x) acc += bin.p;
    return acc;
  }

  /** Quantile / inverse CDF for p in [0,1]. Returns smallest x with CDF ≥ p. */
  quantile(p: number): number {
    if (this.map.size === 0) return 0;
    const s = this.support().sort((a, b) => a - b);
    let acc = 0;
    for (const x of s) {
      acc += this.pAt(x);
      if (acc >= p) return x;
    }
    return s[s.length - 1];
  }

  /** Get outcome probability at specific damage value. */
  outcomeAt(damage: number, outcome: string): number {
    return (this.map.get(damage)?.count[outcome] as number) ?? 0;
  }

  /** Get all outcome types present in this PMF. */
  outcomes(): string[] {
    const outcomeSet = new Set<string>();
    for (const [, bin] of this.map) {
      for (const outcome in bin.count) {
        if ((bin.count[outcome] as number) > 0) {
          outcomeSet.add(outcome);
        }
      }
    }
    return Array.from(outcomeSet).sort();
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
   * Damage-bearing bins are split by `attr` weight (the share of damage each
   * outcome contributed); the clean-miss bin at 0 is split by `count` weight
   * (there is no damage to attribute). Attribution is computed on demand via
   * {@link withAttribution} when absent, so builder-generated PMFs work too.
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
      const isMissBin = damage === 0;

      // Damage-0 (clean miss): split by count, crediting the missNone label.
      if (isMissBin) {
        let totalCount = 0;
        for (const k in bin.count) totalCount += (bin.count[k] as number) || 0;
        if (totalCount > 0) {
          const c = (bin.count[MISS_NONE_OUTCOME] as number) || 0;
          add(MISS_NONE_OUTCOME, damage, (c / totalCount) * p);
        }
        continue;
      }

      // Damage-bearing bin: split by attribution weight.
      let totalAttr = 0;
      if (bin.attr) for (const k in bin.attr) totalAttr += (bin.attr[k] as number) || 0;
      if (bin.attr && totalAttr > 0) {
        for (const k in bin.attr) {
          if (k === MISS_NONE_OUTCOME) continue;
          add(k, damage, (((bin.attr[k] as number) || 0) / totalAttr) * p);
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
   * {@link rebin} is deliberately *not* used — rebinning first would fold any
   * sub-`binSize` damage into the damage-0 bucket, which the split then mistakes
   * for a clean miss and drops.
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
   */
  filterOutcome(outcome: string): PMF {
    const filteredMap = new Map<number, Bin>();

    for (const [damageValue, bin] of this.map) {
      const outcomeCount = (bin.count[outcome] as number) ?? 0;

      // total paths that reached this bin (sum across labels)
      const totalCount = Object.values(bin.count ?? {}).reduce(
        (a, b) => (a ?? 0) + ((b as number) ?? 0),
        0
      );

      if (outcomeCount > 0 && totalCount !== undefined && totalCount > 0) {
        // proportion of this bin's mass attributable to the outcome
        const proportion = outcomeCount / totalCount;

        // downweight p to the unconditional mass from the outcome only
        const newP = bin.p * proportion;

        const newCount: OutcomeLabelMap = { [outcome]: outcomeCount };

        let newAttr: OutcomeLabelMap | undefined;
        if (bin.attr && bin.attr[outcome] !== undefined) {
          // If attr is a count-like accumulator, scale it too.
          // If attr is already per-outcome only, you can just carry it over.
          newAttr = { [outcome]: (bin.attr[outcome] as number) * proportion };
        }

        filteredMap.set(damageValue, {
          p: newP,
          count: newCount,
          attr: newAttr,
        });
      }
    }

    return new PMF(
      filteredMap,
      this.epsilon,
      false, // don't normalize by default
      `filter(${this.identifier},${outcome})`
    );
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

    // Accumulate probs and merged counts
    const probs = new Map<number, number>();
    const counts = new Map<number, Record<string, number>>();

    for (const [v, bin] of this) {
      if (Math.abs(bin.p) < eps) continue;
      const u = round(f(v));
      probs.set(u, (probs.get(u) ?? 0) + bin.p);

      if (preserveCounts) {
        // Merge counts if present
        const src = bin.count;
        if (src) {
          const dest = counts.get(u) ?? {};
          for (const k in src) {
            dest[k] = (dest[k] ?? 0) + (src[k] as number);
          }
          counts.set(u, dest);
        }
      }
    }

    // Build PMF with merged counts, then normalize
    const internal = new Map<number, Bin>();
    for (const [u, p] of probs) {
      internal.set(u, { p, count: counts.get(u) ?? {} });
    }
    // Normalize via pmfFromMap to keep one source of truth
    return PMF.fromMap(
      new Map(Array.from(internal, ([u, b]) => [u, b.p] as [number, number])),
      eps
    );
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
