import { LRUCache } from "../../../../src/common/lru-cache";
import type { LRUCacheOptions } from "../../../../src/common/lru-cache";
import type { Bin, OutcomeLabelMap, Rounding } from "../../../../src/common/types";
import { ALL_OUTCOME_TYPES, EPS, MISS_NONE_OUTCOME, sortOutcomes } from "../../../../src/common/types";
import { labelText, type BinTable } from "../../../../src/pmf/dense";
import { native, type NativePmfHandle } from "../native";
import { DiceQuery } from "./query";

/**
 * Facade over the Rust `NativePmf` (rust/dice-node/src/lib.rs): same public API as
 * `src/pmf/pmf.ts`. Arithmetic runs in Rust; the members the Rust crate does not expose yet
 * (attribution chart model, bin table, ...) are verbatim copies of the TypeScript, marked below.
 */

/** Library caches hand the same PMF to every caller, so entries are frozen as they are stored. */
const sharedPMFCacheOptions: LRUCacheOptions<PMF> = {
  onInsert: (pmf) => pmf.freeze(),
  followsCachingToggle: true,
};

/** A Rust cache seen from JS: `size` and `clear()` (the entries live in `rust/dice/src/pmf/cache.rs`). */
export class NativeCacheView {
  constructor(private readonly name: string) {}

  get size(): number {
    return native.cacheSize(this.name) as number;
  }

  clear(): void {
    native.clearCache(this.name);
  }
}

/** `pmfCache`: convolutions, powers and the d20 PMFs. */
export const pmfCache = new NativeCacheView("pmf");

/**
 * Cached results come back as one JS object per Rust cache entry: the address of the shared
 * allocation (`NativePmf.sharedId`) maps to a weakly held wrapper.
 */
const sharedWrappers = new Map<number, WeakRef<PMF>>();
const sharedCleanup = new FinalizationRegistry<number>((id) => {
  if (sharedWrappers.get(id)?.deref() === undefined) sharedWrappers.delete(id);
});

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

/** `JsChartModel` (rust/dice-node/src/pmf.rs). */
interface NativeChartModel {
  labels: number[];
  binRanges?: { start: number; end: number }[] | null;
  outcomes: string[];
  series: { key: string; values: number[] }[];
  shares: { key: string; values: number[] }[];
  totals: number[];
  percentiles: { p80: number; p50: number; p20: number };
  mean: number;
}

type Options = Array<{ pmf: PMF; weight: number } | [PMF, number]>;

/** `PMF.exclusive`/`mix`/`mixN` take `{pmf, weight}` or `[pmf, weight]`: split into parallel arrays. */
function unzip(options: Options): [NativePmfHandle[], number[]] {
  const items = options.map((o) => (Array.isArray(o) ? { pmf: o[0], weight: o[1] } : o));
  return [items.map((i) => i.pmf._handle), items.map((i) => i.weight)];
}

/**
 * `NativeBins` (rust/dice-node/src/pmf.rs): a PMF's bins as flat typed arrays in map order, with
 * each bin's `count` and `attr` entries as label indexes and values. Lossless for NaN, ±Infinity
 * and -0.
 */
interface NativeBins {
  damages: Float64Array;
  p: Float64Array;
  hasAttr: Uint8Array;
  countStart: Int32Array;
  countLabel: Int32Array;
  countValue: Float64Array;
  attrStart: Int32Array;
  attrLabel: Int32Array;
  attrValue: Float64Array;
  labels: string[];
}

function binsIn(map: ReadonlyMap<number, Bin>): NativeBins {
  const n = map.size;
  const labels: string[] = [];
  const index = new Map<string, number>();
  const damages = new Float64Array(n);
  const p = new Float64Array(n);
  const hasAttr = new Uint8Array(n);
  const countStart = new Int32Array(n + 1);
  const attrStart = new Int32Array(n + 1);
  const countLabel: number[] = [];
  const countValue: number[] = [];
  const attrLabel: number[] = [];
  const attrValue: number[] = [];
  const list = (m: OutcomeLabelMap, into: number[], values: number[]): void => {
    for (const key in m) {
      const value = m[key];
      if (value === undefined) continue;
      let i = index.get(key);
      if (i === undefined) {
        i = labels.push(key) - 1;
        index.set(key, i);
      }
      into.push(i);
      values.push(value);
    }
  };
  let i = 0;
  for (const [damage, bin] of map) {
    damages[i] = damage;
    p[i] = bin.p;
    countStart[i] = countLabel.length;
    attrStart[i] = attrLabel.length;
    list(bin.count, countLabel, countValue);
    if (bin.attr !== undefined) {
      hasAttr[i] = 1;
      list(bin.attr, attrLabel, attrValue);
    }
    i++;
  }
  countStart[n] = countLabel.length;
  attrStart[n] = attrLabel.length;
  return {
    damages,
    p,
    hasAttr,
    countStart,
    countLabel: Int32Array.from(countLabel),
    countValue: Float64Array.from(countValue),
    attrStart,
    attrLabel: Int32Array.from(attrLabel),
    attrValue: Float64Array.from(attrValue),
    labels,
  };
}

function mapOut(b: NativeBins): Map<number, Bin> {
  const map = new Map<number, Bin>();
  const { labels } = b;
  for (let i = 0; i < b.damages.length; i++) {
    const count: OutcomeLabelMap = {};
    for (let k = b.countStart[i]; k < b.countStart[i + 1]; k++) count[labels[b.countLabel[k]]] = b.countValue[k];
    let attr: OutcomeLabelMap | undefined;
    if (b.hasAttr[i] !== 0) {
      attr = {};
      for (let k = b.attrStart[i]; k < b.attrStart[i + 1]; k++) attr[labels[b.attrLabel[k]]] = b.attrValue[k];
    }
    // No own `attr` key when the bin has none: the TS bins never carry one.
    map.set(b.damages[i], attr === undefined ? { p: b.p[i], count } : { p: b.p[i], count, attr });
  }
  return map;
}

function decode(_key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  switch (value) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
    default:
      return value;
  }
}

/** `JSON.parse` of native output; the reviver only runs when a special number is present. */
function parseNative<T>(json: string): T {
  return JSON.parse(json, /"(?:NaN|-?Infinity|-0)"/.test(json) ? decode : undefined) as T;
}

/**
 * Probability Mass Function for discrete damage distributions. Holds a Rust `NativePmf`;
 * PMFs are immutable, so `map` is materialized from the handle once and cached.
 */
export class PMF {
  /** @internal the native handle. */
  _handle!: NativePmfHandle;
  private _map?: ReadonlyMap<number, Bin>;
  private _fingerprint?: string;
  private _binTable?: BinTable;
  private _frozen = false;
  /** Cached PMFs are frozen as the TS freezes them on insert; here when `map` is first read. */
  private _lazyFreeze = false;
  private _preservedProvenance = true;
  private _support?: number[];
  private _outcomeSlices?: Map<string, PMF>;

  /**
   * @param map Damage value → bin. Typed read-only: a PMF is immutable once built. A PMF returned
   *   from the library's caches is frozen: its bins, its map and the `map` property itself reject
   *   writes (see {@link freeze}).
   * @param identifier A name to keep for debugging, such as a parsed expression. Left out, the
   *   {@link identifier} is derived from the content.
   */
  constructor(
    map: ReadonlyMap<number, Bin> = new Map(),
    epsilon = EPS,
    normalized = false,
    identifier?: string,
    preservedProvenance = true
  ) {
    this._map = map;
    this._preservedProvenance = preservedProvenance;
    this._handle = native.NativePmf.fromBins(binsIn(map), epsilon, normalized, identifier);
  }

  /**
   * @internal Wraps a native handle that may be a Rust cache entry: the same entry always gives
   * the same (frozen) object, as the TS caches do.
   */
  static _wrapShared(handle: NativePmfHandle): PMF {
    const id = handle.sharedId() as number;
    if (id === 0) return PMF._wrap(handle);
    const known = sharedWrappers.get(id)?.deref();
    if (known !== undefined) return known;
    const pmf = PMF._wrap(handle);
    pmf._lazyFreeze = true;
    sharedWrappers.set(id, new WeakRef(pmf));
    sharedCleanup.register(pmf, id);
    return pmf;
  }

  /**
   * @internal The wrapper of the shared PMF at `address` (`Arc::as_ptr`, what `sharedId` answers) when
   * one is alive; else `make()`'s handle wrapped and registered. An address names one PMF for as long
   * as a wrapper of it lives (the wrapper's handle holds the `Arc`, so the allocation cannot be freed
   * and reused), and a dead wrapper reads as a miss: the same argument as `sharedId`.
   */
  static _wrapAt(address: number, make: () => NativePmfHandle): PMF {
    return sharedWrappers.get(address)?.deref() ?? PMF._wrapShared(make());
  }

  /** @internal Wraps a native handle without copying its bins. */
  static _wrap(handle: NativePmfHandle): PMF {
    const pmf = Object.create(PMF.prototype) as PMF;
    pmf._handle = handle;
    pmf._frozen = false;
    pmf._preservedProvenance = true;
    return pmf;
  }

  /** Damage value → bin, in the native PMF's map order. */
  get map(): ReadonlyMap<number, Bin> {
    if (this._map === undefined) {
      this._map = mapOut(this._handle.toBins() as NativeBins);
      if (this._lazyFreeze) {
        this._lazyFreeze = false;
        this.freeze();
        return this.map;
      }
    }
    return this._map;
  }

  get epsilon(): number {
    return this._handle.epsilon();
  }

  get normalized(): boolean {
    return this._handle.normalized();
  }

  /**
   * A name for debugging and `toJSON`. Nothing in the library reads it as a cache key or as an
   * ordering key: both come from {@link fingerprint}, the content.
   */
  get identifier(): string {
    return this._handle.identifier();
  }

  /**
   * A PMF cache that freezes every stored PMF and follows `setCachingEnabled`. The library's
   * own caches are built with this.
   */
  static createCache(maxSize: number): LRUCache<string, PMF> {
    return new LRUCache<string, PMF>(maxSize, sharedPMFCacheOptions);
  }

  // --- verbatim from src/pmf/pmf.ts (not in the Rust crate yet) ---
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
    return PMF._wrap(native.NativePmf.empty(epsilon).withIdentifier(identifier));
  }

  // This has a single bin at value 0, mass of 1
  static zero(epsilon = EPS): PMF {
    return PMF._wrap(native.NativePmf.zero(epsilon));
  }

  static delta(value: number, epsilon = EPS): PMF {
    return PMF._wrap(native.NativePmf.delta(value, epsilon));
  }

  /** Point mass at damage 0 tagged with the canonical `missNone` outcome. */
  static missNone(epsilon = EPS): PMF {
    return PMF._wrap(native.NativePmf.missNone(epsilon));
  }

  // This creates a single bin at value 0, but with weight 0.
  static emptyMass(): PMF {
    return PMF._wrap(native.NativePmf.emptyMass());
  }

  //  Makes PMF iterable over [damage, bin] pairs.
  [Symbol.iterator](): IterableIterator<[number, Bin]> {
    return this.map[Symbol.iterator]();
  }

  static clearCache() {
    pmfCache.clear();
  }

  /** A conditional PMF from two branches (success and failure) and a probability. */
  static branch(successPMF: PMF, failurePMF: PMF, successProbability: number): PMF {
    return PMF._wrap(native.NativePmf.branch(successPMF._handle, failurePMF._handle, successProbability));
  }

  static withProbability(successPMF: PMF, probability: number): PMF {
    return PMF._wrap(native.NativePmf.withProbability(successPMF._handle, probability));
  }

  gate(p: number, fallback: PMF) {
    return PMF._wrap(this._handle.gate(p, fallback._handle));
  }

  static exclusive(options: Options, eps = EPS): PMF {
    const [pmfs, weights] = unzip(options);
    return PMF._wrap(native.NativePmf.exclusive(pmfs, weights, eps));
  }

  static mix(options: Options, eps = EPS): PMF {
    const [pmfs, weights] = unzip(options);
    return PMF._wrap(native.NativePmf.mix(pmfs, weights, eps));
  }

  hasAttribution(): boolean {
    return this._handle.hasAttribution();
  }

  withAttribution(): PMF {
    if (this.hasAttribution()) return this;
    return PMF._wrap(this._handle.withAttribution());
  }

  static mixN(weights: [number, PMF][], eps = EPS): PMF {
    return PMF._wrap(
      native.NativePmf.mixN(
        weights.map(([, p]) => p._handle),
        weights.map(([w]) => w),
        eps
      )
    );
  }

  public preservedProvenance(): boolean {
    return this._preservedProvenance;
  }

  power(n: number, eps = this.epsilon): PMF {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("power(n): n must be a positive integer");
    }
    if (n === 1) return this;
    const powered = PMF._wrapShared(this._handle.power(n, eps));
    // A folded power loses its provenance; the cached object says so (TS `new PMF(.., false)`).
    powered._preservedProvenance = false;
    return powered;
  }

  replicate(n: number): PMF[] {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("replicate(n): n must be a positive integer");
    }
    if (n === 1) return [this];
    return Array.from({ length: n }, () => this);
  }

  mass(): number {
    return this._handle.mass();
  }

  outcomeMass(outcome: string): number {
    return this._handle.outcomeMass(outcome);
  }

  faceTotal(): number {
    return this._handle.faceTotal();
  }

  normalize(): PMF {
    if (this.normalized || this.mass() === 0) return this;
    return PMF._wrap(this._handle.normalize());
  }

  compact(eps = this.epsilon, keepFinalBin = false): PMF {
    return PMF._wrap(this._handle.compact(eps, keepFinalBin));
  }

  support(): number[] {
    return (this._support ??= this._handle.support());
  }

  min(): number {
    return this._handle.min();
  }

  max(): number {
    return this._handle.max();
  }

  mean(): number {
    return this._handle.mean();
  }

  variance(): number {
    return this._handle.variance();
  }

  stdev(): number {
    return this._handle.stdev();
  }

  // Convenience method
  add(other: PMF): PMF {
    return this.addScaled(other, 1);
  }

  addScaled(branch: PMF, probability: number): PMF {
    if (probability === 0) return this;
    return PMF._wrap(this._handle.addScaled(branch._handle, probability));
  }

  applyHitFrequency(frequency: number): PMF {
    if (!Number.isFinite(frequency) || frequency >= 1) return this;
    return PMF._wrap(this._handle.applyHitFrequency(frequency));
  }

  splitByFactor(factor: (damage: number) => number): [PMF, PMF] {
    const [a, b] = this._handle.splitByFactor(factor) as NativePmfHandle[];
    return [PMF._wrap(a), PMF._wrap(b)];
  }

  splitByDealt(): [PMF, PMF] {
    const [dealt, none] = this._handle.splitByDealt();
    return [PMF._wrap(dealt), PMF._wrap(none)];
  }

  maxOfTwo(): PMF {
    if (this.mass() <= 0) return this;
    return PMF._wrap(this._handle.maxOfTwo());
  }

  scaleMass(factor: number): PMF {
    if (factor === 1) return this;
    return PMF._wrap(this._handle.scaleMass(factor));
  }

  mapDamage(damageTransformFunction: (damageValue: number) => number): PMF {
    return PMF._wrap(this._handle.mapDamage(damageTransformFunction));
  }

  /**
   * Multiplies every damage value by `factor / denominator` and rounds: `floor`
   * (toward −∞, the default), `ceil` (toward +∞) or `round` (to nearest, halves toward +∞).
   */
  scaleDamage(factor: number, rounding: "floor" | "round" | "ceil" = "floor", denominator = 1): PMF {
    if (!Number.isFinite(factor)) {
      throw new RangeError(`scaleDamage() factor must be finite, got ${factor}`);
    }
    if (!Number.isFinite(denominator) || denominator === 0) {
      throw new RangeError(`scaleDamage() denominator must be finite and non-zero, got ${denominator}`);
    }
    return PMF._wrap(this._handle.scaleDamage(factor, rounding, denominator));
  }

  /** A content fingerprint of every bin (probability, `count`, `attr`) plus the `normalized` flag. */
  fingerprint(): string {
    return (this._fingerprint ??= this._handle.fingerprint());
  }

  // --- verbatim from src/pmf/pmf.ts (not in the Rust crate yet) ---
  /**
   * One bin's part of the {@link fingerprint}: `damage:p[count labels]{attr labels}`.
   * @internal
   */
  static binSegment(damage: number, bin: Bin): string {
    return `${damage}:${bin.p}[${labelText(bin.count)}]{${labelText(bin.attr)}}`;
  }

  /** Whether `A`'s {@link fingerprint} sorts at or before `B`'s. @internal */
  static contentAtOrBefore(A: PMF, B: PMF): boolean {
    return A.fingerprint() <= B.fingerprint();
  }

  /** The distribution of the sum of this PMF and `other` (see `src/pmf/pmf.ts`). */
  convolve(other: PMF, eps?: number, raw = false): PMF {
    return PMF._wrapShared(this._handle.convolve(other._handle, eps, raw));
  }

  convolveRaw(other: PMF, eps?: number): PMF {
    return PMF._wrap(this._handle.convolveRaw(other._handle, eps));
  }

  // --- verbatim from src/pmf/pmf.ts (not in the Rust crate yet) ---
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

  combineRaw(other: PMF, eps?: number): PMF {
    return this.convolve(other, eps, true);
  }

  static convolveMany(pmfList: PMF[], eps = EPS): PMF {
    if (pmfList.length === 0) return PMF.empty(eps);
    if (pmfList.length === 1) return pmfList[0];
    return PMF._wrapShared(
      native.NativePmf.convolveMany(
        pmfList.map((p) => p._handle),
        eps
      )
    );
  }

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

  static fromJSON(jsonData: { bins: Array<[number, Bin]>; normalized?: boolean; identifier?: string }) {
    return new PMF(new Map(jsonData.bins), EPS, !!jsonData.normalized, jsonData.identifier || "fromJSON");
  }

  prune(epsRel: number, minBins = 0): PMF {
    return PMF._wrap(this._handle.prune(epsRel, minBins));
  }

  pAt(x: number): number {
    return this._handle.pAt(x);
  }

  hitProbability(): number {
    return this._handle.hitProbability();
  }

  missProbability(): number {
    return this._handle.missProbability();
  }

  rebin(maxBuckets: number): PMF {
    if (!(maxBuckets > 0)) return this;
    const support = this.support();
    if (support.length === 0) return this;
    if (support[support.length - 1] - support[0] + 1 <= maxBuckets) return this;
    return PMF._wrap(this._handle.rebin(maxBuckets));
  }

  denseSupport(): number[] {
    return this._handle.denseSupport();
  }

  cdfAt(x: number): number {
    return this._handle.cdfAt(x);
  }

  quantile(p: number): number {
    return this._handle.quantile(p);
  }

  outcomeAt(damage: number, outcome: string): number {
    return this._handle.outcomeAt(damage, outcome);
  }

  outcomes(): string[] {
    return this._handle.outcomes();
  }

  outcomeProbability(outcome: string): number {
    return this._handle.outcomeProbability(outcome);
  }

  outcomeAttributionAt(damage: number, outcome: string): number {
    return this._handle.outcomeAttributionAt(damage, outcome);
  }

  binAt(damage: number): {
    p: number;
    count: Record<string, number>;
    attr?: Record<string, number>;
  } | null {
    const json: string | null | undefined = this._handle.binAt(damage);
    if (json === null || json === undefined) return null;
    const bin = parseNative<{ p: number; count: Record<string, number>; attr?: Record<string, number> }>(json);
    return { p: bin.p, count: bin.count, attr: bin.attr };
  }

  hasOutcome(outcome: string): boolean {
    return this._handle.hasOutcome(outcome);
  }

  attributionByValue(): Map<string, Map<number, number>> {
    const result = new Map<string, Map<number, number>>();
    for (const { key, values } of this._handle.attributionByValue() as Array<{ key: string; values: number[] }>) {
      const series = new Map<number, number>();
      for (let i = 0; i < values.length; i += 2) series.set(values[i], values[i + 1]);
      result.set(key, series);
    }
    return result;
  }

  damageAttributionChartModel(
    options: { maxBuckets?: number; stackOrder?: readonly string[]; epsilon?: number } = {}
  ): DamageAttributionChartModel {
    const m = this._handle.damageAttributionChartModel(
      options.maxBuckets,
      options.stackOrder === undefined ? undefined : [...options.stackOrder],
      options.epsilon
    ) as NativeChartModel;
    const model: DamageAttributionChartModel = {
      labels: m.labels,
      outcomes: m.outcomes,
      series: new Map(m.series.map((s) => [s.key, s.values])),
      shares: new Map(m.shares.map((s) => [s.key, s.values])),
      totals: m.totals,
      percentiles: m.percentiles,
      mean: m.mean,
    };
    if (m.binRanges !== undefined && m.binRanges !== null) model.binRanges = m.binRanges;
    return model;
  }

  tailProbGE(t: number): number {
    return this._handle.tailProbGe(t);
  }

  tailProbGT(t: number): number {
    return this._handle.tailProbGt(t);
  }

  filterOutcome(outcome: string): PMF {
    const memo = (this._outcomeSlices ??= new Map());
    let known = memo.get(outcome);
    if (known === undefined) memo.set(outcome, (known = PMF._wrap(this._handle.filterOutcome(outcome))));
    return known;
  }

  public static firstSuccessWeights(pSuccess: number, pSpecial: number, n: number) {
    return native.NativePmf.firstSuccessWeights(pSuccess, pSpecial, n) as {
      pSpecificSuccess: number;
      pGeneralSuccess: number;
      pNone: number;
      pAny: number;
    };
  }


  mapValues(
    f: (v: number) => number,
    eps: number = EPS,
    opts?: { rounding?: Rounding; preserveCounts?: boolean }
  ): PMF {
    return PMF._wrap(this._handle.mapValues(f, eps, opts?.rounding ?? "none", opts?.preserveCounts ?? true));
  }

  static fromMap(
    m: Map<number, number>,
    eps: number = EPS,
    { requireIntegerValues = true }: { requireIntegerValues?: boolean } = {}
  ): PMF {
    return PMF._wrap(
      native.NativePmf.fromMap([...m.keys()], [...m.values()], eps, requireIntegerValues)
    );
  }

  query(): DiceQuery {
    return new DiceQuery(this);
  }
}
