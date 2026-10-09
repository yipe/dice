import type { PMF } from "../pmf/pmf";
import type { RollType } from "../common/types";
import type { RollBuilder } from "./roll";

export type { RollType };

export type RollFactory = {
  (count: number, sides?: number, modifier?: number): RollBuilder;
  (count: number, die: RollBuilder, modifier?: number): RollBuilder;
  d(sides: number | string): RollBuilder;
  hd20(): RollBuilder;
  d4(): RollBuilder;
  d6(): RollBuilder;
  d8(): RollBuilder;
  d10(): RollBuilder;
  d12(): RollBuilder;
  d20(): RollBuilder;
  d100(): RollBuilder;
  flat(n: number): RollBuilder;
};

export type KeepMode = "highest" | "lowest";

// Intermediate Representation, gets converetd into an AST as needed
export type RollConfig = {
  count: number;
  sides: number;
  modifier: number;
  reroll: number; // Reroll threshold k (k >= 0). Implements one-pass, reroll-once, must-keep on faces {1..k}.
  explode: number;
  // Pool-wide exploding-dice budget: at most this many extra dice may be added to the WHOLE
  // pool (shared across all dice in it), as opposed to `explode`'s per-die cap. Mutually
  // exclusive with `explode` on the same config — see `RollBuilder.explodePool()`.
  explodePoolBudget: number;
  minimum: number;
  bestOf: number;
  keep: { total: number; count: number; mode: KeepMode } | undefined;
  rollType: RollType;
  isSubtraction?: boolean; // true if this negative count should be treated as subtraction
  // Set only on a check's natural roll by `pinned()`: no grant or condition in a turn changes
  // this roll's type. A row fact, not part of the distribution; absent (never `false`) otherwise.
  pinned?: true;
};

export type Resolution = {
  pmf: PMF;
  check: PMF;
  weights: { [key: string]: number };
};

export type AttackResolution = Resolution & {
  hit: PMF;
  crit: PMF;
  miss: PMF;
  // Base payload only, before `plusSeparateDamage` channels are convolved in — equal to hit/crit
  // when the attack has no separate-damage channels.
  hitBase: PMF;
  critBase: PMF;
  // The convolved `plusSeparateDamage` channels only — PMF.delta(0) when there are none.
  // critSeparate carries the channels' DOUBLED dice (same doubling hit/crit already use, in
  // both the auto-double and the explicit `onCrit` branch).
  hitSeparate: PMF;
  critSeparate: PMF;
  weights: { hit: number; crit: number; miss: number };
};

/** Melee or ranged, for a turn's condition rules keyed by range: `ranged()` / `melee()`. */
export type AttackRange = "melee" | "ranged";

/** A save's ability, as `ability()` stores it: always the full name. */
export type Ability = "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma";

/** What `ability()` accepts: a full name or its three-letter form. */
export type AbilityName = Ability | "str" | "dex" | "con" | "int" | "wis" | "cha";

/**
 * The one re-derivation surface `AttackBuilder.withCheck(fn)` accepts. `roll` is the
 * to-hit + bonus-dice descriptor (AC and crit threshold live alongside it, not inside it);
 * `rollType`/`advantageDice` are the SOURCE's own values (before any grant is combined in —
 * see `combine()` in `ac.ts`); `critOnHit` mirrors the `alwaysCrits()` path.
 */
export interface Check {
  roll: RollBuilder;
  ac: number;
  critThreshold: number;
  rollType: RollType;
  advantageDice: 2 | 3;
  critOnHit: boolean;
}

export type SaveResolution = Resolution & {
  saveFail: PMF;
  saveSuccess: PMF;
  weights: { success: number; fail: number };
};

export interface CheckBuilder {
  resolve(eps?: number): Resolution;
  toExpression(): string;
  readonly pmf: PMF;
  mean(): number;
}
