/**
 * Per-group trigger state, packed into one byte.
 *
 * A "group" is one distinct set of source ids referenced by a trigger. Everything
 * any trigger needs to know about a group is which outcome landed *first*, whether
 * anything crit, whether anything missed, and whether anything's dice matched — so
 * the whole turn state stays small (up to 24 codes per group, ~14 reachable) per
 * group.
 *
 * Layout: `first << 2 | anyCrit << 1 | anyMiss | anyMatch << 4`, where `first` is
 * one of {@link FIRST_NONE} / {@link FIRST_HIT} / {@link FIRST_CRIT}. Readers decode
 * with `code >> 2 & 0b11`, `code & CRIT_BIT`, `code & MISS_BIT`, `code & MATCH_BIT`.
 */
export const FIRST_NONE = 0;
export const FIRST_HIT = 1;
export const FIRST_CRIT = 2;

export const CRIT_BIT = 2;
export const MISS_BIT = 1;
/**
 * Bit 4 — `FIRST_CRIT` (2) shifted left by 2 is `0b1000` (bit 3), so bits 0-3 are
 * occupied by first/crit/miss. Max reachable code is `8|2|1|16 = 27`, still < 256,
 * so `turn.ts`'s `String.fromCharCode` per-group state key is unaffected.
 */
export const MATCH_BIT = 16;

/** A group that has seen nothing yet: no first landing, no crit, no miss, no match. */
export const START_CODE = FIRST_NONE << 2;

export type StepOutcome = "hit" | "crit" | "miss";

/** Fold one source outcome into a group's state. `matched` only has an effect on
 * `"hit"`/`"crit"` — a miss rolls no dice, so it can never match. */
export function advance(code: number, outcome: StepOutcome, matched = false): number {
  if (outcome === "miss") return code | MISS_BIT;

  const first = code >> 2;
  const withCrit = outcome === "crit" ? code | CRIT_BIT : code;
  const withMatch = matched ? withCrit | MATCH_BIT : withCrit;
  if (first !== FIRST_NONE) return withMatch;

  const nextFirst = outcome === "crit" ? FIRST_CRIT : FIRST_HIT;
  return (nextFirst << 2) | (withMatch & (MATCH_BIT | CRIT_BIT | MISS_BIT));
}
