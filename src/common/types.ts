/** Mapping from outcome label to probability mass or damage attribution. */
export type OutcomeLabelMap = Partial<Record<string, number>>;

/** Computational epsilon for pruning negligible probabilities. */
export const EPS = 1e-12;

/** A probability bin for a specific damage value. */
export interface Bin {
  /** Total probability mass at this damage value. */
  p: number;
  /** Per-outcome probability mass contributions at this damage. */
  count: OutcomeLabelMap;
  /** Optional per-outcome damage attribution at this damage. */
  attr?: OutcomeLabelMap;
}

export interface CritConfig {
    critThreshold: number;
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

export type Rounding = "none" | "floor" | "round" | "ceil";

/** How a d20 attack roll resolves: single die, keep-highest of 2/3, or keep-lowest of 2. */
export type RollType = "flat" | "advantage" | "disadvantage" | "elven accuracy";

/**
 * P(critical hit) for the given crit window and d20 {@link RollType}.
 *
 * `critRange` is the number of top faces that crit (1 for a natural 20, 2 for
 * 19–20, …), so a single die crits with probability `critRange / 20`. Advantage
 * rolls two d20s / elven accuracy three, keeping the best; disadvantage keeps
 * the worst of two.
 */
export function critProbability(critRange: number, rollType: RollType = "flat"): number {
  const base = critRange / 20;
  switch (rollType) {
    case "advantage":
      return 1 - (1 - base) ** 2;
    case "elven accuracy":
      return 1 - (1 - base) ** 3;
    case "disadvantage":
      return base ** 2;
    case "flat":
    default:
      return base;
  }
}

/**
 * The canonical "clean miss" outcome — a point of zero damage with no rider.
 * This is the {@link OutcomeType} that attribution charts and outcome stats key
 * on, and is distinct from the builder's attack-resolution `miss` weight label.
 */
export const MISS_NONE_OUTCOME: OutcomeType = "missNone";

/**
 * All outcome types in canonical severity order — clean miss → crit. This is
 * also the natural stacking order for attribution charts (least- to
 * most-impactful, bottom → top). Enumerates every {@link OutcomeType} exactly
 * once; use it instead of hand-maintained per-consumer outcome tables.
 */
export const ALL_OUTCOME_TYPES: OutcomeType[] = [
  "missNone",
  "missDamage",
  "saveFail",
  "saveHalf",
  "pc",
  "hit",
  "crit",
];

/**
 * Outcome types in display order for stats / breakdown rows — most prominent
 * first (crit, hit, …) down to the clean miss.
 */
export const OUTCOME_DISPLAY_ORDER: OutcomeType[] = [
  "crit",
  "hit",
  "missDamage",
  "saveHalf",
  "saveFail",
  "pc",
  "missNone",
];

/**
 * Sort outcome labels by a canonical order (defaults to {@link ALL_OUTCOME_TYPES}).
 * Labels not present in `order` sort after known ones, alphabetically — so
 * ad-hoc/test labels outside the {@link OutcomeType} union stay stable.
 */
export function sortOutcomes<T extends string>(
  outcomes: Iterable<T>,
  order: readonly string[] = ALL_OUTCOME_TYPES
): T[] {
  const rank = new Map(order.map((o, i) => [o, i]));
  return [...outcomes].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export const onAnyHit: OutcomeType[] = ["hit", "crit"];
export const onCritOnly: OutcomeType[] = ["crit"];
export const onHitOnly: OutcomeType[] = ["hit"];
export const onMissOnly: OutcomeType[] = ["missNone", "missDamage"];
export const onMissDamageOnly: OutcomeType[] = ["missDamage"];
export const onSaveHalfOnly: OutcomeType[] = ["saveHalf"];
export const onSaveFailOnly: OutcomeType[] = ["saveFail"];
export const onPotentCantripOnly: OutcomeType[] = ["pc"];
