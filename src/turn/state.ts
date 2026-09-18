/**
 * Per-group trigger state, packed into one byte.
 *
 * A "group" is one distinct set of source ids referenced by a trigger. Everything
 * any trigger needs to know about a group is which outcome landed *first*, whether
 * anything crit, and whether anything missed — so the whole turn state is one byte
 * per group and the state space stays small (12 codes per group, ~10 reachable).
 *
 * Layout: `first << 2 | anyCrit << 1 | anyMiss`, where `first` is one of
 * {@link FIRST_NONE} / {@link FIRST_HIT} / {@link FIRST_CRIT}. Readers decode with
 * `code >> 2`, `code & CRIT_BIT`, `code & MISS_BIT`.
 */
export const FIRST_NONE = 0;
export const FIRST_HIT = 1;
export const FIRST_CRIT = 2;

export const CRIT_BIT = 2;
export const MISS_BIT = 1;

/** A group that has seen nothing yet: no first landing, no crit, no miss. */
export const START_CODE = FIRST_NONE << 2;

export type StepOutcome = "hit" | "crit" | "miss";

/** Fold one source outcome into a group's state. */
export function advance(code: number, outcome: StepOutcome): number {
  if (outcome === "miss") return code | MISS_BIT;

  const first = code >> 2;
  const withCrit = outcome === "crit" ? code | CRIT_BIT : code;
  if (first !== FIRST_NONE) return withCrit;

  const nextFirst = outcome === "crit" ? FIRST_CRIT : FIRST_HIT;
  return (nextFirst << 2) | (withCrit & (CRIT_BIT | MISS_BIT));
}
