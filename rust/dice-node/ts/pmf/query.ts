import type { OutcomeType } from "../../../../src/common/types";
import { ALL_OUTCOME_TYPES, EPS } from "../../../../src/common/types";
import { fromNative, native, type NativeQueryHandle } from "../native";
import { PMF } from "./pmf";
import type { DamageAttributionChartModel } from "./pmf";

export type { OutcomeSnapshot, Snapshot } from "../../../../src/pmf/query";
import type { OutcomeSnapshot, Snapshot } from "../../../../src/pmf/query";

/**
 * Query interface for analyzing dice roll probability distributions. Holds a Rust `NativeQuery`;
 * same public API as `src/pmf/query.ts`.
 */
export class DiceQuery {
  public readonly singles: PMF[];
  private readonly _eps: number;
  /** @internal the native handle. */
  _handle: NativeQueryHandle;
  private _combined?: PMF;
  private _combinedWithAttr?: PMF;
  private readonly _combinedProvided: boolean;

  constructor(singles: PMF | PMF[], combined?: PMF, eps = EPS) {
    this.singles = Array.isArray(singles) ? singles : [singles];
    if (this.singles.some((s) => s === undefined)) {
      throw new Error("DiceQuery contains undefined singles");
    }
    this._eps = eps;
    this._combinedProvided = combined !== undefined;
    if (combined !== undefined) {
      this._combined = Math.abs(combined.mass() - 1) <= eps ? combined : combined.normalize();
    }
    this._handle = new native.NativeQuery(
      this.singles.map((s) => s._handle),
      combined?._handle,
      eps
    );
  }

  /**
   * The combined damage distribution of all single PMFs (their convolution), normalized to mass 1.
   * Computed on first access; `combined` passed to the constructor is used as given (normalized
   * unless within `eps` of mass 1).
   */
  get combined(): PMF {
    if (this._combined === undefined) {
      const c = PMF.convolveMany(this.singles);
      this._combined = Math.abs(c.mass() - 1) <= this._eps ? c : c.normalize();
    }
    return this._combined;
  }

  /** PMF with damage attribution metadata populated (see `src/pmf/query.ts`). */
  combinedWithAttribution(): PMF {
    if (this._combinedWithAttr === undefined) {
      // Every single already carries attribution: the attributed convolution is `combined` itself.
      this._combinedWithAttr =
        !this._combinedProvided && this.singles.every((pmf) => pmf.hasAttribution())
          ? this.combined
          : PMF._wrap(this._handle.combinedWithAttribution());
    }
    return this._combinedWithAttr;
  }

  attributionByValue(): Map<string, Map<number, number>> {
    return this.combinedWithAttribution().attributionByValue();
  }

  damageAttributionChartModel(options?: {
    maxBuckets?: number;
    stackOrder?: readonly string[];
    epsilon?: number;
  }): DamageAttributionChartModel {
    return this.combinedWithAttribution().damageAttributionChartModel(options);
  }

  countSinglesWith(label: string): number {
    return this._handle.countSinglesWith(label);
  }

  mean(): number {
    return this._handle.mean();
  }

  variance(): number {
    return this._handle.variance();
  }

  stddev(): number {
    return this._handle.stddev();
  }

  stdev(): number {
    return this.stddev();
  }

  cdf(x: number): number {
    return this._handle.cdf(x);
  }

  probTotalAtMost(x: number): number {
    return this._handle.probTotalAtMost(x);
  }

  ccdf(x: number): number {
    return this._handle.ccdf(x);
  }

  probTotalAtLeast(threshold: number): number {
    return this._handle.probTotalAtLeast(threshold);
  }

  percentiles(percentileValues: number[]): number[] {
    return this._handle.percentiles(percentileValues);
  }

  min(): number {
    return this._handle.min();
  }

  max(): number {
    return this._handle.max();
  }

  probAtLeastK(labels: OutcomeType | OutcomeType[], k: number): number {
    return this._handle.probAtLeastK(labels, k);
  }

  probAtLeastOne(labels: OutcomeType | OutcomeType[]): number {
    return this._handle.probAtLeastOne(labels);
  }

  probExactlyK(labels: OutcomeType | OutcomeType[], k: number): number {
    return fromNative(() => this._handle.probExactlyK(labels, k));
  }

  probAtMostK(labels: OutcomeType | OutcomeType[], k: number): number {
    return fromNative(() => this._handle.probAtMostK(labels, k));
  }

  expectedDamageFrom(labels: OutcomeType | OutcomeType[]): number {
    return this._handle.expectedDamageFrom(labels);
  }

  damageStatsFrom(labels: OutcomeType | OutcomeType[]): { min: number; max: number; avg: number; count: number } {
    return this._handle.damageStatsFrom(labels);
  }

  combinedDamageStats(targetLabel: OutcomeType): { min: number; max: number; avg: number; count: number } {
    return this._handle.combinedDamageStats(targetLabel);
  }

  probabilityOf(labels: OutcomeType | OutcomeType[]): number {
    return this._handle.probabilityOf(labels);
  }

  missChance(): number {
    return this._handle.missChance();
  }

  toChartSeries(): Array<{ x: number; y: number }> {
    const flat: number[] = this._handle.toChartSeries();
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
    return out;
  }

  toLabeledTable(labels: OutcomeType[] = []): Array<Record<string, number>> {
    const rows = this._handle.toLabeledTable(labels) as Array<Array<{ key: string; value: number }>>;
    return rows.map((row) => {
      const out: Record<string, number> = {};
      for (const { key, value } of row) out[key] = value;
      return out;
    });
  }

  toStackedChartData(
    labels: OutcomeType[] = [],
    epsilon = EPS
  ): { labels: number[]; datasets: Array<{ label: string; data: number[] }> } {
    const d = this._handle.toStackedChartData(labels, epsilon) as {
      labels: number[];
      datasets: Array<{ key: string; values: number[] }>;
    };
    return { labels: d.labels, datasets: d.datasets.map((s) => ({ label: s.key, data: s.values })) };
  }

  toCDFSeries(asPercentages: boolean = true): { support: number[]; data: number[] } {
    return this._handle.toCdfSeries(asPercentages);
  }

  toCCDFSeries(asPercentages: boolean = true): { support: number[]; data: number[] } {
    return this._handle.toCcdfSeries(asPercentages);
  }

  probDamageGreaterThan(threshold = 0): number {
    return this._handle.probDamageGreaterThan(threshold);
  }

  outcomeKeys(order?: OutcomeType[]): OutcomeType[] {
    return this._handle.outcomeKeys(order);
  }

  /** Total probability per outcome across the PMF. */
  outcomeTotals(outcomes?: OutcomeType[]): Map<OutcomeType, number> {
    const rows = this._handle.outcomeTotals(outcomes) as Array<{ key: string; value: number }>;
    return new Map(rows.map((r) => [r.key as OutcomeType, r.value]));
  }

  /** Conditional damage range per outcome (min/avg/max of X | outcome). */
  outcomeDamageRanges(outcomes?: OutcomeType[]): Map<OutcomeType, { min: number; avg: number; max: number }> {
    const rows = this._handle.outcomeDamageRanges(outcomes) as Array<{ key: string; min: number; avg: number; max: number }>;
    return new Map(rows.map((r) => [r.key as OutcomeType, { min: r.min, avg: r.avg, max: r.max }]));
  }

  outcomeStats(outcomes?: readonly OutcomeType[]): Map<OutcomeType, OutcomeSnapshot> {
    const rows = this._handle.outcomeStats(outcomes === undefined ? undefined : [...outcomes]) as Array<{
      key: string;
      atLeastOneProbability: number;
      allProbability: number;
      damageMin: number;
      damageAvg: number;
      damageMax: number;
    }>;
    return new Map(
      rows.map((o) => [
        o.key as OutcomeType,
        {
          atLeastOneProbability: o.atLeastOneProbability,
          allProbability: o.allProbability,
          damageRange: { min: o.damageMin, avg: o.damageAvg, max: o.damageMax },
        },
      ])
    );
  }

  snapshot(order?: readonly OutcomeType[]): Snapshot {
    const s = this._handle.snapshot(order === undefined ? undefined : [...order]);
    const outcomes = new Map<OutcomeType, OutcomeSnapshot>();
    for (const o of s.outcomes) {
      outcomes.set(o.key as OutcomeType, {
        atLeastOneProbability: o.atLeastOneProbability,
        allProbability: o.allProbability,
        damageRange: { min: o.damageMin, avg: o.damageAvg, max: o.damageMax },
      });
    }
    return {
      averageDPR: s.averageDpr,
      damageChance: s.damageChance,
      percentiles: { p25: s.p25, p50: s.p50, p75: s.p75 },
      outcomes,
    };
  }

  /** Returns a new DiceQuery with normalized probabilities. */
  normalize(): DiceQuery {
    return new DiceQuery([this.combined.normalize()]);
  }

  compact(eps?: number, keepFinalBin?: boolean): DiceQuery {
    return new DiceQuery([this.combined.compact(eps, keepFinalBin)]);
  }

  addScaled(branch: DiceQuery, probability: number): DiceQuery {
    return new DiceQuery([this.combined.addScaled(branch.combined, probability)]);
  }

  scaleMass(factor: number): DiceQuery {
    return new DiceQuery([this.combined.scaleMass(factor)]);
  }

  totalMass(): number {
    return this.combined.mass();
  }

  /** A new DiceQuery over the combined distribution with damage values mapped (Rust `map_damage`, through the PMF). */
  mapDamage(damageTransformFunction: (damageValue: number) => number): DiceQuery {
    return new DiceQuery([this.combined.mapDamage(damageTransformFunction)]);
  }

  /** A new DiceQuery with damage scaled by `factor / denominator` (see {@link PMF.scaleDamage}). */
  scaleDamage(factor: number, rounding: "floor" | "round" | "ceil" = "floor", denominator = 1): DiceQuery {
    return new DiceQuery([this.combined.scaleDamage(factor, rounding, denominator)]);
  }

  /** A new DiceQuery whose singles are this query's followed by `other`'s. */
  convolve(other: DiceQuery): DiceQuery {
    return new DiceQuery([...this.singles, ...other.singles]);
  }

  public firstSuccessSplit(
    successOutcome: OutcomeType | OutcomeType[],
    subsetOutcome: OutcomeType | OutcomeType[],
    eps = EPS
  ): readonly [pSuccess: number, pSubset: number, pAny: number, pNone: number] {
    const r: number[] = this._handle.firstSuccessSplit(successOutcome, subsetOutcome, eps);
    return [r[0], r[1], r[2], r[3]] as const;
  }
}
