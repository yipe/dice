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
 *   `max` caps it: the rider applies to at most `max` landings among `of`, in turn order
 *   (Superiority dice, "the first three hits"). A positive integer; omit it for no cap.
 *   `max: 1` IS `first-hit`: the plan lowers it, so `otherwise`, `not-fired`, transforms and
 *   the numbers are exactly `onFirstHit`'s. `perSource` gives a payload that depends on the
 *   landing source, on `first-hit` and `every-hit`. A capped or per-source rider that watches
 *   an `any-miss` reroll is refused (`unsupported-trigger`): that reroll resolves after every
 *   declared attack, so a cap would count its landing in the wrong order; use `first-miss`.
 *   `fireProbability` of an every-hit rider is P(at least one landing);
 *   `Turn.expectedApplications` reports the expected count for any rider.
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
  | { on: Exclude<AttackTriggerOn, "first-hit" | "every-hit">; of?: readonly string[] }
  | { on: "first-hit"; of?: readonly string[]; perSource?: PerSource }
  | { on: "every-hit"; of?: readonly string[]; max?: number; perSource?: PerSource }
  | { on: "not-fired"; of: string }
  | { on: "dice-match"; of: readonly string[] };

/**
 * A payload that depends on which source landed: source id → the payload dealt when that
 * source lands (its damage type, the target's scale for it). A source not listed deals the
 * rider's own `damage`. Keys are attack or attack-shaped rider ids the rider watches; a tag
 * is not accepted. Only `first-hit` and `every-hit` riders take one.
 */
export type PerSource = Readonly<Record<string, RiderPayload>>;

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

/**
 * How a rider reads a save row among its sources, since a save has no hit or crit to land on:
 *
 * - `fail`: a failed save lands, whatever damage it dealt; a success never does.
 * - `damage`: "when you deal damage". A failed save that dealt damage lands, and so does a success
 *   under `saveHalf()` that dealt some. A save that dealt nothing (a failure of 0, a pass whose
 *   half floors to 0, a pass with no `saveHalf()`) does not.
 *
 * Everything else is a miss to the rider: `first-miss` and `any-miss` fire on it. It applies to the
 * save rows among a rider's sources only; an attack lands on a hit or a crit whatever it says. A
 * save row is unwatchable without it (`not-an-attack`). A landed save is a hit and never a crit, so
 * `any-crit` never fires over one. Riders may read one save row under different kinds.
 */
export type SaveLanding = "fail" | "damage";

/**
 * The payload a rider deals when one particular source lands: its own damage and, if the
 * doubled-dice default is wrong for it, its own crit damage. Self-contained: a listed
 * source never falls back to the rider's `critDamage`.
 */
export interface RiderPayload {
  damage: RiderDamage;
  critDamage?: RiderDamage;
}

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
  /**
   * How this rider reads a save row among its `of` (see {@link SaveLanding}). Attack
   * sources ignore it. A `not-fired` rider carrying one is `unsupported-trigger`: it
   * watches a rider, not attacks.
   */
  landing?: SaveLanding;
}

export type Rider = Trigger & {
  id?: string;
  damage: RiderDamage;
  critDamage?: RiderDamage;
  landing?: SaveLanding;
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
  /**
   * The probability the attack happens at all, in `[0, 1]`; defaults to 1. With
   * `1 − chance` probability the attack does **not** happen: it deals no damage,
   * is **not** a miss for `any-miss` / `first-miss`, and is **not** a landing for
   * a hit trigger — the turn proceeds as if the attack were never declared. It
   * replaces gating a source's PMF in place (`applyHitFrequency`), which a
   * not-happened attack must not do: that folds the skipped mass into the
   * missNone outcome and lets a skipped round spend a `next-attack` grant or fire
   * a miss trigger.
   */
  chance?: number;
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

/**
 * A probability the walk reports without adding any damage: read it with
 * {@link Turn.fireProbability}. JSON-safe. Only `any-crit` exists today: P(at least one of `of`
 * crit), from the walk itself, so a `critOnHit` grant, a reroll, a substitute and a
 * `chance` on the attack are all accounted for. A row that cannot crit (a save, a flat
 * payload) is skipped, so the default `of` works on a mixed turn; a probe with no source
 * that can crit reports 0.
 *
 * `of` takes the same names as a rider's (attack ids, attack-shaped rider ids, tags) and
 * defaults to every declared attack plus every attack-shaped `any-miss` / `first-miss` rider,
 * the way a condition's does. `id` defaults to `probe 1`, `probe 2`, … in declaration order. A
 * probe keeps its source group live to the end of the walk, so it counts against
 * {@link MAX_TRIGGER_GROUPS} for the whole turn, and no `of` can name it.
 */
export interface ProbeSpec {
  id?: string;
  on: "any-crit";
  of?: readonly string[];
}

export interface TurnSpec {
  attacks: readonly Attack[];
  riders?: readonly Rider[];
  substitutes?: readonly SubstituteSpec[];
  conditions?: readonly ConditionSpec[];
  /** Probabilities to report; see {@link ProbeSpec}. They add no damage. */
  observe?: readonly ProbeSpec[];
}

export type TurnSpecErrorCode =
  | "unknown-id"
  | "duplicate-id"
  | "self-reference"
  | "cycle"
  | "not-an-attack"
  | "unused-crit-damage"
  | "too-many-groups"
  | "too-many-counters"
  | "no-dice-descriptor"
  | "duplicate-substitute"
  | "attack-after-rider"
  | "no-rebindable-source"
  | "unsupported-trigger"
  | "unsupported-policy"
  | "too-many-flags"
  | "unknown-key"
  | "non-string-id";

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
 * How many distinct `of` sets a single turn may keep live at once.
 *
 * A group is live from the first step that can advance it to the last step that reads it (to the
 * end of the walk, for an `every-hit` rider or a probe), and two groups whose lives do not overlap
 * share one slot, so a turn may name more than this many source sets as long as no more than this
 * many are live together. A `bounce()` chain has two live at a time whatever its length: each
 * beam's group dies after its one reader.
 *
 * Each live group multiplies the state space, so the cap is a cost ceiling rather than a modelling
 * limit. Measured on four attacks with two riders per group (every group fed by multiple
 * independent sources, the expensive dense case): 2.1ms for one group, 3.1 for two, 5.9 for
 * three, 23.5 for four, roughly 4x per group. A `bounce()` chain is the opposite case: each group
 * is fed by exactly ONE step, and the chain is strictly sequential (group N+1 only ever reads a
 * nonzero state once group N has already resolved), so its reachable state space grows close to
 * linearly rather than combinatorially; see `dice-match.test.ts`'s latency measurement.
 *
 * 9, not 4: a turn tracking 9 independent dense groups is the pathological case the latency table
 * above warns about, but every turn 0.14 accepted stays valid, and real builds use one or two (the
 * goliath rogue/monk/paladin uses one).
 */
export const MAX_TRIGGER_GROUPS = 9;

/**
 * How many capped `every-hit` riders may watch one attack, counting riders that share their
 * sources and their `max` once (they apply on the same landings, so they share a counter).
 *
 * Every attack a capped rider watches carries a with-rider and a without-rider draw set per
 * such rider, so the draws double with each one: a cost ceiling, not a modelling limit. Six
 * counters means 64 draw sets on an attack; real builds use one or two (a maneuver die pool,
 * a hex).
 */
export const MAX_CAPPED_COUNTERS = 6;
