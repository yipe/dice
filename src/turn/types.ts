import type { PMF } from "../pmf/pmf";

/** Triggers that read the outcomes of source attacks. */
export type HitTriggerOn = "first-hit" | "any-crit" | "any-miss" | "every-hit";

export type TriggerOn = HitTriggerOn | "not-fired";

/**
 * When a rider fires. JSON-safe, so a consumer can persist this verbatim and hand
 * it straight back in a {@link TurnSpec}.
 *
 * - `first-hit` — the first source that lands. Fires in that source's mode, so a
 *   crit on the *first* landing attack doubles the rider's dice (Sneak Attack).
 * - `any-crit` — at least one source crit. Always fires in crit mode (Divine Smite).
 * - `any-miss` — at least one source missed. The reroll gate (Unerring Accuracy, Lucky).
 * - `every-hit` — once per landing source, in that hit's mode (Hunter's Mark, Hex, Rage).
 * - `not-fired` — the named rider did **not** fire ("flurry of blows if I didn't smite").
 *
 * `of` defaults to every declared attack, which is what most riders mean.
 */
export type Trigger =
  | { on: HitTriggerOn; of?: readonly string[] }
  | { on: "not-fired"; of: string };

/** Anything that can produce a PMF: `RollBuilder`, `AttackBuilder`, `SaveBuilder`, or a `PMF`. */
export interface ToPMF {
  toPMF(eps?: number): PMF;
}

/**
 * Rider or attack damage. Strings are not accepted: a parsed expression cannot
 * have its dice doubled, so a string rider would deal single dice on a crit. Call
 * `parse()` yourself if that is what you want.
 */
export type Damage = PMF | ToPMF;

/** A source must resolve to an *outcome-labelled* PMF (hit/crit/miss). */
export type Source = Damage;

export type Rider = Trigger & {
  /** Required only if another rider names this one in `of`. */
  id?: string;
  /** An array is convolved: Flurry of Blows is `[flurry, flurry]`. */
  damage: Damage | readonly Damage[];
  /** Defaults to `damage` with dice doubled when that is possible, else `damage`. */
  critDamage?: Damage | readonly Damage[];
};

/** A bare source gets the id `attack 1`, `attack 2`, … in declaration order. */
export type Attack = Source | { id: string; attack: Source };

export interface TurnSpec {
  attacks: readonly Attack[];
  riders?: readonly Rider[];
}

export type TurnSpecErrorCode =
  | "unknown-id"
  | "duplicate-id"
  | "self-reference"
  | "cycle"
  | "not-an-attack"
  | "too-many-groups";

/**
 * A malformed turn. `code` is a stable contract: consumer UIs map it to their own
 * states (greyed dropdown option, "trigger missing" row error, …) instead of
 * re-implementing validation.
 */
export class TurnSpecError extends Error {
  constructor(
    readonly code: TurnSpecErrorCode,
    readonly id: string,
    message: string
  ) {
    super(message);
    this.name = "TurnSpecError";
  }
}

/** How many distinct `of` sets a single turn may track. */
export const MAX_TRIGGER_GROUPS = 4;
