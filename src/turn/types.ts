import type { DiceMatchInfo, HasDiceMatchInfo } from "../common/types";
import type { PMF } from "../pmf/pmf";

export type { DiceMatchInfo, HasDiceMatchInfo };

/**
 * Triggers that read the outcomes of source attacks, as opposed to `not-fired`,
 * which reads another rider. Includes `any-miss`/`first-miss`, so this is not "hit triggers".
 */
export type AttackTriggerOn =
  | "first-hit"
  | "any-crit"
  | "any-miss"
  | "first-miss"
  | "every-hit";

/**
 * When a rider fires. JSON-safe, so a consumer can persist this verbatim and hand
 * it straight back in a {@link TurnSpec}.
 *
 * - `first-hit` — the first source that lands. Fires in that source's mode, so a
 *   crit on the *first* landing attack doubles the rider's dice (Sneak Attack).
 * - `any-crit` — at least one source crit. Always fires in crit mode (Divine Smite).
 * - `any-miss` — at least one source missed. Its step runs after every declared attack,
 *   which is exact only when the reroll is identically distributed to every attack after
 *   the one it replaces. An attack-shaped `any-miss` rider that reads a granted modifier
 *   or applies a condition's grants is refused (`unsupported-trigger`): at the end of the
 *   turn it would see the wrong grants. Use `first-miss` for such rerolls.
 * - `first-miss` — the FIRST source in `of` that missed. Its step runs immediately after
 *   that attack (one slot per watched source, sharing one fire bit), so a reroll lands in
 *   turn order and anything that reads order — a `first-hit` rider's crit mode, or a
 *   granted modifier — sees it where it happened. The exact model of "when you miss, you
 *   may reroll" (Unerring Accuracy, Lucky).
 * - `every-hit` — once per landing source, in that hit's mode (Hunter's Mark, Hex, Rage).
 * - `dice-match` — at least one named source's own damage dice showed a duplicate
 *   value on hit or crit (Chromatic Orb's bounce). `of` is REQUIRED — unlike the
 *   other attack triggers, "every declared attack" has no coherent single meaning
 *   for "the dice matched", so there is no default. Each named source must expose
 *   a {@link HasDiceMatchInfo} descriptor (an `AttackBuilder`-shaped source does);
 *   naming one that doesn't (a bare `PMF`, a `keep`/`bestOf` pool, a string-parsed
 *   expression) is a `TurnSpecError`, not a silent "never matches". A damage rider
 *   fires in crit mode, its dice doubled, when a crit's dice matched (with several
 *   sources, when any matching landing was a crit); otherwise in hit mode.
 * - `not-fired` — the named rider did **not** fire ("flurry of blows if I didn't smite").
 *   It may also name a substitute: it then fires when the substitute was never spent.
 *
 * For the attack triggers besides `dice-match`, `of` is a list of attack ids,
 * attack-shaped rider ids, or declaration tags (see {@link Attack}); a tag expands to
 * every attack carrying it. A rider whose damage is a list of several attacks is not
 * attack-shaped: naming it is `not-an-attack`, and it never joins a default `of`.
 *
 * `of` defaults to every declared attack plus every attack-shaped `any-miss` /
 * `first-miss` rider before it — a reroll continues the attacks it watches. `Turn`'s
 * chaining methods snapshot that at the call that adds the rider (the attacks and
 * rerolls declared so far); a {@link TurnSpec} resolves it when the plan is built,
 * giving a rider the rerolls listed before it in `riders` and a substitute or
 * condition every reroll. Both spellings of one turn therefore watch the same
 * sources. For `not-fired` it is the single required id of the rider being negated —
 * negating a set of riders has no unambiguous meaning, so the type does not offer it.
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
 * Rider or attack damage. Raw strings are not accepted; wrap one in `d("…")`. On a
 * crit, a rider's dice double and its flats do not: a builder through
 * `doubleDice()`, a `d("…")` string by rewriting its dice terms (`d("2d6+5")` crits
 * as `4d6+5`), a pool inside, then pooled. A bare `PMF` is a fixed distribution with
 * no dice to double, so it is added as-is on a crit. A `d("…")` attack string crits on
 * its own roll: with no crit clause, at its natural 20, with its hit dice doubled.
 */
export type Damage = PMF | ToPMF;

/**
 * Same shape as {@link Damage}, named separately because the requirement is
 * stronger: a source must resolve to an *outcome-labelled* PMF carrying
 * hit/crit/miss, which no type can express. Supplying one that does not is a
 * `not-an-attack` {@link TurnSpecError} at build time, not a compile error.
 */
export type Source = Damage;

/**
 * One payload, or several to convolve: Flurry of Blows is `[flurry, flurry]`. A list of
 * several attacks deals their exact summed damage, but it is one payload, not attacks
 * that each land: nothing can watch it in `of`, and it never joins a default `of`. To
 * watch each strike, declare each as its own rider.
 */
export type RiderDamage = Damage | readonly Damage[];

/** Everything about a rider except what it does and when — see `Turn.onFirstHit`. */
export interface RiderOptions {
  /** Required only if another rider names this one in `of`. */
  id?: string;
  /**
   * Which attacks to watch: attack ids, attack-shaped rider ids, or declaration tags.
   * Defaults to the attacks declared so far, plus any attack-shaped `any-miss` /
   * `first-miss` rider declared so far (see {@link Trigger}).
   */
  of?: readonly string[];
  /**
   * Defaults to `damage` with its dice doubled (builders and `d("…")` strings that can double);
   * an attack or save builder or string, or a bare `PMF` part, is added as-is. A rider that
   * rolls its own attack — one attack, or a list of several — crits on its own roll, so
   * giving it one is an `unused-crit-damage` error.
   */
  critDamage?: RiderDamage;
}

export type Rider = Trigger & {
  id?: string;
  damage: RiderDamage;
  critDamage?: RiderDamage;
};

/** How an attack is declared: `id` names it for `of`; `tag` groups it with others. */
export interface AttackOptions {
  id?: string;
  /**
   * A name several attacks can share. An `of` entry that is not an id expands to
   * every attack carrying that tag, so a reordered turn cannot silently retarget
   * the way a positional `attack 2` can. A tag matching nothing is `unknown-id`.
   */
  tag?: string;
}

/**
 * A bare source gets the id `attack 1`, `attack 2`, … in declaration order.
 *
 * Unlike {@link Rider}, the id lives in a wrapper rather than on the value
 * itself: an attack's value is a builder or PMF that this module does not own,
 * so there is nowhere to hang a field.
 */
export type Attack = Source | (AttackOptions & { source: Source });

/**
 * When a substitute may be spent: on the first landing it sees (`always`, the
 * default), only when the base payload total (dice plus the payload's own flat
 * bonus, excluding separate-damage channels) is below the threshold for that
 * mode (`below`; a landing spends regardless when no later watched step can
 * still land in that turn state), or by backward induction (`optimal` — not
 * supported in this release).
 */
export type SubstitutePolicy =
  | { kind: "always" }
  | { kind: "below"; hit: number; crit: number }
  | { kind: "optimal" };

/**
 * A once-per-turn payload transform: at the first watched landing the policy
 * accepts, the attack's base payload is replaced by a transform of itself. The
 * JSON-safe form of `Turn.onFirstHit(keepBestDamage())`; callers write the
 * factory, never the string.
 */
export interface SubstituteSpec {
  id?: string;
  on: "first-hit";
  /**
   * Omit it: defaults to every declared attack plus every attack-shaped `any-miss` /
   * `first-miss` rider, the same sources the chaining spelling watches (see {@link Trigger}).
   */
  of?: readonly string[];
  /** Named transform, so a {@link TurnSpec} stays JSON-safe and persistable. */
  substitute: "reroll-keep-higher";
  /** Defaults to `{ kind: "always" }`. */
  policy?: SubstitutePolicy;
}

/**
 * One granted modifier: what it does to the attack rolls that read it, how long it
 * lasts, and which attack rolls read it. JSON-safe — the persisted form of a
 * `Grant` built with `advantage().untilNextAttack()` and friends.
 *
 * - `advantage` / `disadvantage` combine with the reading attack's own roll type by
 *   cancellation; a net advantage rolls as many dice as that attacker's
 *   `advantageDice` (`ACBuilder.threeDiceAdvantage()`).
 * - `critOnHit` makes every landing attack a crit; a natural 1 still misses.
 * - `until: "next-attack"` is consumed by the next attack roll that reads it, hit or
 *   miss; `"end-of-turn"` lasts for the rest of the turn.
 * - `to` lists attack ids, attack-shaped rider ids or tags. Omitted, every later
 *   attack roll reads it, attack-shaped riders included (an attack-shaped `any-miss`
 *   rider that would read it is refused; see {@link Trigger}).
 */
export interface GrantSpec {
  advantage?: true;
  disadvantage?: true;
  critOnHit?: true;
  until: "next-attack" | "end-of-turn";
  to?: readonly string[];
}

/**
 * Grants applied by the outcomes of earlier attacks to later attack rolls: "a hit
 * gives the next attack advantage". The JSON-safe form of `Turn.onEveryHit(grant)`.
 *
 * `on` says which outcome among `of` applies the grants: `every-hit` on each
 * landing, `first-hit` on the first landing only, `any-crit` on each crit,
 * `first-miss` on the first miss, `any-miss` on each miss. Miss damage
 * (`halfOnMiss`, `onMiss`) is a miss, never a landing.
 *
 * `chance` is the probability each application takes (a target's failed save);
 * `grants` apply on that branch and `onSave` on the other one. Each application
 * rolls it afresh, except that an application whose grants are all `end-of-turn`
 * and all already in force is skipped: nothing is rolled and `onSave` does not
 * apply. An application with any `next-attack` grant is always rolled.
 */
export interface ConditionSpec {
  id?: string;
  on: AttackTriggerOn;
  /**
   * Omit it: defaults to every declared attack plus every attack-shaped `any-miss` /
   * `first-miss` rider (see {@link Trigger}).
   */
  of?: readonly string[];
  /** In `[0, 1]`; defaults to 1. */
  chance?: number;
  /** Applied on the fail branch, or with probability `chance`. */
  grants: readonly GrantSpec[];
  /** Applied on the success branch. Requires `chance`. */
  onSave?: readonly GrantSpec[];
}

export interface TurnSpec {
  attacks: readonly Attack[];
  riders?: readonly Rider[];
  substitutes?: readonly SubstituteSpec[];
  conditions?: readonly ConditionSpec[];
}

export type TurnSpecErrorCode =
  | "unknown-id"
  | "duplicate-id"
  | "self-reference"
  | "cycle"
  | "not-an-attack"
  | "unused-crit-damage"
  | "too-many-groups"
  | "no-dice-descriptor"
  | "duplicate-substitute"
  | "attack-after-rider"
  | "no-rebindable-source"
  | "unsupported-trigger"
  | "unsupported-policy"
  | "too-many-flags";

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
