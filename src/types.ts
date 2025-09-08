/** Mapping from outcome label to probability mass or damage attribution. */
export type OutcomeLabelMap = Partial<Record<string, number>>;

/** Computational epsilon for pruning negligible probabilities. */
export const COMPUTATIONAL_EPS = 1e-40;

/** Test tolerance for floating-point precision errors. */
export const TEST_EPS = 1e-10;

/** A probability bin for a specific damage value. */
export interface Bin {
  /** Total probability mass at this damage value. */
  p: number;
  /** Per-outcome probability mass contributions at this damage. */
  count: OutcomeLabelMap;
  /** Optional per-outcome damage attribution at this damage. */
  attr?: OutcomeLabelMap;
}

/** Simple mapping from damage value to probability. */
export type DamageDistribution = Record<number, number>;
/** Canonical outcome labels supported by the query helpers. */
export type OutcomeType =
  | "crit"
  | "hit"
  | "missNone"
  | "missDamage"
  | "saveHalf"
  | "saveFail"
  | "pc";
