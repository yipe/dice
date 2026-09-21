import type { DiceMatchInfo, HasDiceMatchInfo } from "../common/types";
import type { PMF } from "../pmf/pmf";

export type { DiceMatchInfo, HasDiceMatchInfo };

/**
 * Triggers that read the outcomes of source attacks, as opposed to `not-fired`,
 * which reads another rider. Includes `any-miss`, so this is not "hit triggers".
 */
export type AttackTriggerOn =
  | "first-hit"
  | "any-crit"
  | "any-miss"
  | "every-hit";

/**
 * When a rider fires. JSON-safe, so a consumer can persist this verbatim and hand
 * it straight back in a {@link TurnSpec}.
 *
 * - `first-hit` — the first source that lands. Fires in that source's mode, so a
 *   crit on the *first* landing attack doubles the rider's dice (Sneak Attack).
 * - `any-crit` — at least one source crit. Always fires in crit mode (Divine Smite).
 * - `any-miss` — at least one source missed. The reroll gate (Unerring Accuracy, Lucky).
 * - `every-hit` — once per landing source, in that hit's mode (Hunter's Mark, Hex, Rage).
 * - `dice-match` — at least one named source's own damage dice showed a duplicate
 *   value on hit or crit (Chromatic Orb's bounce). `of` is REQUIRED — unlike the
 *   other attack triggers, "every declared attack" has no coherent single meaning
 *   for "the dice matched", so there is no default. Each named source must expose
 *   a {@link HasDiceMatchInfo} descriptor (an `AttackBuilder`-shaped source does);
 *   naming one that doesn't (a bare `PMF`, a `keep`/`bestOf` pool, a string-parsed
 *   expression) is a `TurnSpecError`, not a silent "never matches".
 * - `not-fired` — the named rider did **not** fire ("flurry of blows if I didn't smite").
 *
 * For the attack triggers besides `dice-match`, `of` is a list of attack ids and
 * defaults to every declared attack, which is what most riders mean. For
 * `not-fired` it is the single required id of the rider being negated — negating
 * a set of riders has no unambiguous meaning, so the type does not offer it.
 */
export type Trigger =
  | { on: AttackTriggerOn; of?: readonly string[] }
  | { on: "not-fired"; of: string }
  | { on: "dice-match"; of: readonly string[] };

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

/**
 * Same shape as {@link Damage}, named separately because the requirement is
 * stronger: a source must resolve to an *outcome-labelled* PMF carrying
 * hit/crit/miss, which no type can express. Supplying one that does not is a
 * `not-an-attack` {@link TurnSpecError} at build time, not a compile error.
 */
export type Source = Damage;

/** One payload, or several to convolve: Flurry of Blows is `[flurry, flurry]`. */
export type RiderDamage = Damage | readonly Damage[];

/** Everything about a rider except what it does and when — see `Turn.onFirstHit`. */
export interface RiderOptions {
  /** Required only if another rider names this one in `of`. */
  id?: string;
  /** Which attacks to watch. Defaults to every declared attack. */
  of?: readonly string[];
  /** Defaults to `damage` with dice doubled when that is possible, else `damage`. */
  critDamage?: RiderDamage;
}

export type Rider = Trigger & {
  id?: string;
  damage: RiderDamage;
  critDamage?: RiderDamage;
};

/**
 * A bare source gets the id `attack 1`, `attack 2`, … in declaration order.
 *
 * Unlike {@link Rider}, the id lives in a wrapper rather than on the value
 * itself: an attack's value is a builder or PMF that this module does not own,
 * so there is nowhere to hang a field.
 */
export type Attack = Source | { id: string; source: Source };

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
  | "unused-crit-damage"
  | "too-many-groups"
  | "no-dice-descriptor";

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

/**
 * How many distinct `of` sets a single turn may track.
 *
 * Each group multiplies the state space, so the cap is a cost ceiling rather
 * than a modelling limit. Measured on four attacks with two riders per group
 * (every group fed by multiple independent sources — the expensive, dense
 * case): 2.1ms for one group, 3.1 for two, 5.9 for three, 23.5 for four —
 * roughly 4x per group. A `bounce()` chain is the opposite case — each group
 * is fed by exactly ONE step, and the chain is strictly sequential (group N+1
 * only ever reads a nonzero state once group N has already resolved), so its
 * reachable state space grows close to linearly rather than combinatorially;
 * see `dice-match.test.ts`'s latency measurement.
 *
 * 9, not 4: Chromatic Orb's `effectCountScaling: 'spell_level_plus_one'` needs
 * up to `1 + 9 = 10` beams at a 9th-level slot — 9 additional bounces beyond
 * the first. A non-bounce turn tracking 9 independent dense groups would be
 * the pathological case the latency table above warns about; real builds use
 * one or two (the goliath rogue/monk/paladin uses one).
 */
export const MAX_TRIGGER_GROUPS = 9;
