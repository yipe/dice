import { combine } from "../builder/ac";
import type { AttachedCondition } from "../builder/attack";
import { ParsedRollBuilder } from "../builder/roll";
import type { AttackResolution, Check } from "../builder/types";
import { EPS } from "../common/types";
import type { RollType } from "../common/types";
import type { DiceMatchInfo, HasDiceMatchInfo } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import {
  byDie,
  combineRollType,
  contextKey,
  contextOf,
  isContextual,
  MOD_ADVANTAGE,
  MOD_AUTO_FAIL,
  MOD_CRIT_ON_HIT,
  MOD_DISADVANTAGE,
  MOD_PENALTY_SHIFT,
  MOD_SAVE_DISADVANTAGE,
  MOD_VULNERABLE,
  type PenaltyDice,
  rowCheckOf,
  saveFailChance,
} from "./context";
import type { Lasting } from "./effects";
import { effectSpec, gateFields, isGrant, isTransform } from "./effects";
import type { StepOutcome } from "./state";
import {
  advance,
  CRIT_BIT,
  CRIT_MATCH_BIT,
  FIRST_CRIT,
  FIRST_NONE,
  MATCH_BIT,
  MISS_BIT,
  START_CODE,
} from "./state";
import type {
  Attack,
  AttackOptions,
  ConditionRule,
  ContextualPayload,
  ContextualSource,
  GrantSaveSpec,
  ConditionSpec,
  Damage,
  GrantSpec,
  PerSource,
  ProbeSpec,
  Rider,
  RiderDamage,
  RiderPayload,
  RowCheck,
  RowContext,
  SaveLanding,
  SubstitutePolicy,
  SubstituteSpec,
  ToPMF,
  Trigger,
  TurnSpec,
  TurnSpecErrorCode,
} from "./types";
import { MAX_CAPPED_COUNTERS, MAX_TRIGGER_GROUPS, TurnSpecError } from "./types";

/**
 * How many flag bits a walk state may carry: JS bit operations are 32-bit signed and the sign
 * bit stays clear. Flags whose lives do not overlap share a bit, so this bounds the flags live
 * at once, not the flags a turn names; past it the turn is `too-many-states`.
 */
const MAX_FLAG_BITS = 30;

/** The creature an attack, or a `start` condition, is on when it names none. */
const DEFAULT_CREATURE = "target";

/** The default `TurnSpec.stateLimit`: the engine's `MAX_CONDITION_STATES`. */
export const MAX_TURN_STATES = 16_384;

/** Which payload a rider used when it fired, or `null` while it has not fired. */
export type FireMode = "hit" | "crit" | null;

/**
 * A resolved, validated turn: the ordered steps to walk, plus the trigger
 * groups it tracks. Building this is where every {@link TurnSpecError} is raised,
 * so the walk itself can assume a well-formed plan.
 */
/** Where an effect in force comes from: the starting condition, or a condition by its id. */
export type EffectSource = { kind: "starting" } | { kind: "grant"; grant: string };

export interface TurnPlan {
  /** Where effects come from, as {@link Step.flagReads} index them. */
  effectSources: readonly EffectSource[];
  /** The optional ("you can") conditions, declared and attached, by id in declaration order. */
  optionalIds: readonly string[];
  steps: readonly Step[];
  /**
   * How many slots of group codes the walk carries per state: the PEAK number of groups live
   * at once, not the number of distinct `of` sets. A group is live from the first step that
   * can advance it to the last step that reads it, and groups whose lives do not overlap
   * share a slot (see `releases`).
   */
  groupCount: number;
  /** Declared attacks only, in order — the walk's full (ungated) marginals. */
  attackPMFs: readonly PMF[];
  /** Declared attacks gated by their `chance`, in order — what `DiceQuery.singles` gets. */
  attackSingles: readonly PMF[];
  /** Every attack id, in declaration order. */
  attackIds: readonly string[];
  /** Every rider id, in declaration order, including `every-hit` riders. */
  riderIds: readonly string[];
  /** Every substitute id, in declaration order. */
  substituteIds: readonly string[];
  /** Every probe id, in declaration order. */
  probeIds: readonly string[];
  /**
   * Ids of the attack-shaped `any-miss` / `first-miss` riders, in declaration
   * order: a reroll continues the attacks it watches, so `Turn`'s chaining
   * methods add these to a later rider's defaulted `of`. A list of several
   * attacks is not attack-shaped, so it is never among them.
   */
  rerollIds: readonly string[];
  /**
   * Rider or substitute id → its fire slot: the index into the walk's per-state
   * `fired` array. A rider's slot records the mode it fired in; a substitute's
   * records the mode it was spent in. `every-hit` riders have none (see
   * `perHitGroups`); a `first-miss` rider's several steps share one.
   */
  fireSlots: ReadonlyMap<string, number>;
  slotCount: number;
  /**
   * `every-hit` rider id → the group slot whose "something landed" bit answers
   * P(it fired at least once). Such riders are folded into their sources' slices
   * rather than becoming steps, so they have no step index.
   */
  perHitGroups: ReadonlyMap<string, number>;
  /** The `perHitGroups` riders that land on crits only: they fired iff something crit. */
  perHitCritOnly: ReadonlySet<string>;
  /** The `perHitGroups` riders that land on anything: they fired iff a watched row happened. */
  perHitAny: ReadonlySet<string>;
  /** Per rider, the declared attacks it watches, in declaration order (where `landings` books it). */
  riderRows: ReadonlyMap<string, readonly string[]>;
  /**
   * Probe id → the group slot whose "something crit" bit answers its probability. Read at
   * the final collapse like `perHitGroups`, so its group stays live the whole walk.
   */
  probes: ReadonlyMap<string, number>;
  /**
   * Every `every-hit` rider id, in declaration order: the index space of `Draw.applies`
   * and of the expected-application tallies.
   */
  everyHitIds: readonly string[];
  /**
   * Per counter, the cap of the `every-hit` riders that share it. A capped rider's counter
   * counts landings it applied to among its sources, so two riders with the same sources
   * and the same `max` share one. A step watched by a counter draws from its
   * with-rider variant while the walk's count is below the cap.
   */
  counterMax: readonly number[];
  /**
   * The LAST step index (in final walk order) that reads each group slot (for a slot several
   * groups share in turn, the last read of the last group), and `steps.length` for a slot
   * `perHitGroups` or `probes` still need at the final collapse. Once the walk passes a slot's
   * last reader, its specific code stops discriminating any future decision, so `Turn.resolve`'s
   * `merge` stops keying on it past that point: the dominant cost fix for a long `dice-match`
   * chain (a group read by exactly one downstream step, the common shape, would otherwise keep
   * splitting states for every step after that single read).
   */
  groupLastReadStep: readonly number[];
  /** Every condition id, in declaration order. */
  conditionIds: readonly string[];
  /**
   * Per step, the flag bits still needed once the step is done: the walk clears every other
   * bit, so a dead flag never splits states and a bit is free for the next flag that shares it.
   */
  flagLiveAfter: readonly number[];
  /** The coins of riders that may not happen and can land several times: each splits the start state. */
  coins: readonly { id: string; bit: number; happens: number }[];
  /** The flag bits of the `start` conditions: in force before the first step. */
  startFlags: number;
  /** The `start` conditions some step reads (indexes into {@link TurnPlan.conditionIds}): applied for certain. */
  startConditions: readonly number[];
  /** The most distinct states the walk may carry after a step; more is `too-many-states`. */
  stateLimit: number;
  /** Whether a condition needs a damage type dealt: the joint is then not available (see {@link Draw.typed}). */
  dealing: boolean;
  /** Per condition: whether its later attack rolls lean melee (the optional fallback, see `Turn`). */
  meleeLeaning: readonly boolean[];
}

/** Outcome-labelled sub-mass PMFs for one source, masses summing to 1. */
interface SourceSlices {
  hit: PMF;
  crit: PMF;
  miss: PMF;
}

/**
 * One outcome a step's walk convolves in: which group-state outcome it advances,
 * whether it counts as a dice-match, whether drawing it spends the step's
 * substitute, the every-hit riders it applies (indices into
 * {@link TurnPlan.everyHitIds}, hit and crit draws only) and the counters those
 * advance, and the sub-mass PMF itself.
 */
export interface Draw {
  outcome: StepOutcome;
  matched: boolean;
  spends: boolean;
  applies: readonly number[];
  /** Indices into {@link TurnPlan.counterMax}: each a capped rider's landings so far. */
  bumps: readonly number[];
  /** Fire slots a first-hit rider with a payload per source marks when this draw applies it. */
  fires: readonly number[];
  slice: PMF;
  /**
   * Set on a save row's draws, and on an attack row's split by damage dealt: a group keyed by a
   * landing kind advances by that kind's entry instead of `outcome`, and so does a condition
   * that declares that `landing`.
   */
  byKind?: ByKind;
  /**
   * Set where riders are folded into `slice`: the row's own sub-mass part before the fold, and
   * each folded rider's id with the (mass 1) payload it adds. What a per-id marginal reads.
   */
  own?: PMF;
  riders?: ReadonlyArray<readonly [id: string, payload: PMF]>;
  /**
   * Set on the draws of a row that finds a condition damage ends: whether the row (or a rider that
   * lands on it) dealt its creature more than 0, which ends those conditions.
   */
  wounded?: boolean;
  /**
   * Set on the hits and crits of a row a `dealing` condition reads: whether the landing dealt the
   * condition's damage type (the row's own, or a rider's that landed with it). The split is by the
   * odds alone, so it is exact for each row's and rider's marginal, not for the turn's joint.
   */
  typed?: boolean;
}

/** `draw` with its mass scaled by `factor`, its own part with it. */
function scaleDraw(draw: Draw, factor: number): Draw {
  const scaled = { ...draw, slice: draw.slice.scaleMass(factor) };
  return draw.own === undefined ? scaled : { ...scaled, own: draw.own.scaleMass(factor) };
}

/**
 * `draw` split by whether it dealt more than 0: the row's own damage, or a folded rider's. A
 * draw with folded riders splits its own part first; where that dealt nothing the riders decide,
 * and each rider's payload is then conditioned on what the split says.
 */
function splitWounded(draw: Draw): Draw[] {
  if (draw.outcome === "none") return [{ ...draw, wounded: false }];
  const byDealt = (pmf: PMF): [PMF, PMF] => pmf.splitByFactor((damage) => (damage > 0 ? 1 : 0)) as [PMF, PMF];
  const pieces: Draw[] = [];
  if (draw.own === undefined || draw.riders === undefined) {
    const [dealt, none] = byDealt(draw.slice);
    if (dealt.mass() > 0) pieces.push({ ...draw, slice: dealt, wounded: true });
    if (none.mass() > 0) pieces.push({ ...draw, slice: none, wounded: false });
    return pieces;
  }
  const riders = draw.riders;
  const fold = (part: PMF): PMF => riders.reduce((all, [, payload]) => all.convolve(payload, 0, true), part);
  // Wounded where the row's own roll dealt more than 0, or else where a rider's payload did.
  const [ownDealt, ownNone] = byDealt(draw.own);
  if (ownDealt.mass() > 0) pieces.push({ ...draw, own: ownDealt, slice: fold(ownDealt), wounded: true });
  const noneMass = ownNone.mass();
  if (noneMass <= 0) return pieces;
  // The own roll dealt nothing: the turn is wounded where some rider dealt more than 0.
  const zero = riders.map(([, payload]) => payload.pAt(0));
  const allZero = zero.reduce((product, p) => product * p, 1);
  const quiet = riders.map(([id]): readonly [string, PMF] => [id, PMF.delta(0, 0)]);
  if (1 - allZero > 0) {
    const loud = riders.map(([id, payload], k): readonly [string, PMF] => {
      // P(this payload, and the riders together dealt more than 0) / P(the riders dealt more than 0).
      const othersZero = zero.reduce((product, p, j) => (j === k ? product : product * p), 1);
      return [id, payload.splitByFactor((value) => (value > 0 ? 1 : 1 - othersZero))[0].scaleMass(1 / (1 - allZero))];
    });
    // What the riders dealt together, where that was more than 0, beside the own roll's.
    const together = riders.reduce((all, [, payload]) => all.convolve(payload, 0, true), PMF.delta(0, 0));
    const dealt = together.splitByFactor((value) => (value > 0 ? 1 : 0))[0];
    pieces.push({ ...draw, own: ownNone.scaleMass(1 - allZero), riders: loud, slice: ownNone.convolve(dealt, 0, true), wounded: true });
  }
  if (allZero > 0) {
    pieces.push({ ...draw, own: ownNone.scaleMass(allZero), riders: quiet, slice: ownNone.scaleMass(allZero), wounded: false });
  }
  return pieces;
}

/** What a save row's draw is to a rider reading the row under each landing kind. */
export type ByKind = Readonly<Record<SaveLanding, StepOutcome>>;

/**
 * What an attack row's hit or crit is under each landing kind once it is split by its own damage:
 * one that dealt more than 0 lands either way; one that dealt 0 lands for `fail` (an attack lands
 * on a hit, whatever it deals) and is no landing, and no miss, for `damage`. Shared objects, so
 * {@link mergeDraws} can tell equal kinds apart by identity.
 */
const DEALT: Readonly<Record<"hit" | "crit", ByKind>> = {
  hit: { fail: "hit", damage: "hit" },
  crit: { fail: "crit", damage: "crit" },
};
const NOT_DEALT: Readonly<Record<"hit" | "crit", ByKind>> = {
  hit: { fail: "hit", damage: "none" },
  crit: { fail: "crit", damage: "none" },
};

/**
 * The draws of one attack step under one state-dependent context. Masses sum to 1.
 *
 * Hit and crit expand into two draws each when the source is match-sliced (a
 * `dice-match` trigger names it) and into more when a substitute's policy splits
 * them into spend and hold parts; every other step walks the same three draws —
 * hit, crit, miss — so turns without those features pay nothing extra.
 */
export type StepVariant = readonly Draw[];

/**
 * An above-threshold landing of a substitute's watched step: `hold` keeps the
 * roll, `spend` rerolls it. Which one a variant carries depends on whether a
 * later watched step can still land.
 */
interface HoldChoice {
  outcome: "hit" | "crit";
  matched: boolean;
  hold: Draw[];
  spend: Draw[];
}

/** `draws` with every pair that advances the walk identically summed into one draw. */
function mergeDraws(draws: readonly Draw[]): Draw[] {
  const merged: Draw[] = [];
  for (const draw of draws) {
    const index = merged.findIndex(
      (other) =>
        other.outcome === draw.outcome &&
        other.matched === draw.matched &&
        other.spends === draw.spends &&
        other.byKind === draw.byKind &&
        other.wounded === draw.wounded &&
        other.typed === draw.typed &&
        // A wound split conditions the riders' payloads; parts with different conditions stay apart.
        (draw.wounded === undefined || other.riders === draw.riders)
    );
    if (index === -1) merged.push(draw);
    else {
      const other = merged[index];
      const sum = { ...other, slice: other.slice.add(draw.slice) };
      merged[index] =
        other.own === undefined && draw.own === undefined
          ? sum
          : { ...sum, own: (other.own ?? other.slice).add(draw.own ?? draw.slice) };
    }
  }
  return merged;
}

/**
 * `codes` with `outcome` folded into each group in `updates`; a group with a landing kind (in
 * `kinds`, aligned with `updates`) folds in the draw's `byKind` entry for it instead.
 */
function advanced(
  codes: readonly number[],
  updates: readonly number[],
  kinds: readonly (SaveLanding | null)[],
  outcome: StepOutcome,
  matched: boolean,
  byKind?: ByKind
): number[] {
  const next = [...codes];
  updates.forEach((group, index) => {
    const kind = kinds[index];
    next[group] = advance(
      next[group],
      kind === null || byKind === undefined ? outcome : byKind[kind],
      matched
    );
  });
  return next;
}

/**
 * `codes` with every slot in `releases` reset to the code of a group that has seen nothing;
 * `codes` itself when none of them needs it.
 */
export function released<Codes extends readonly number[]>(
  codes: Codes,
  releases: readonly number[]
): Codes | number[] {
  let next: number[] | undefined;
  for (const slot of releases) {
    if (codes[slot] === START_CODE) continue;
    next ??= [...codes];
    next[slot] = START_CODE;
  }
  return next ?? codes;
}

/**
 * One condition, applied at one of its source steps. When the drawn outcome
 * qualifies, the draw splits by `chance`: `grants` are set on one part, `onSave`
 * on the other.
 */
export interface GrantApplication {
  /** Index into {@link TurnPlan.conditionIds}. */
  condition: number;
  on: Exclude<ConditionSpec["on"], "start">;
  /** Group whose pre-draw code `first-hit` / `first-crit` / `first-miss` reads, else -1. */
  reads: number;
  /**
   * How a save row, or an attack row whose draws are split by damage dealt, lands the condition:
   * the draw's `byKind` entry for it replaces its outcome. Undefined: the outcome as drawn.
   */
  landing: SaveLanding | undefined;
  chance: number;
  /** With a grant save: its fail chance in the state's flags, replacing `chance`. */
  chanceOf: ((flags: number) => number) | undefined;
  /** Flag bits set on the `chance` branch. */
  grants: number;
  /** Flag bits set on the other branch. */
  onSave: number;
  /** Non-zero when the application is skipped once all of these bits are set. */
  inForce: number;
  /** Whether a later step reads one of `grants` — what `fireProbability` counts. */
  effective: boolean;
  /**
   * For a once-per-turn condition that waits for a reader: the bit that says it was tried
   * (`first-*` then reads it instead of its group), or -1 where no later row reads it, so it is not
   * tried here at all. 0: the group decides, as ever.
   */
  tried: number;
  /** For a condition that fires where a folded rider landed: that rider's id, which the draw must carry. */
  rider: string | undefined;
  /** For a condition that needs a damage type dealt (`dealing`): only a `typed` draw lands it. */
  dealing: boolean;
  /**
   * Whether the engine counts a try here (`stepStats` conditions, `attemptProbability`): a
   * once-per-turn condition only where a later row reads one of its effects; any other always.
   */
  counted: boolean;
  /** Whether a try the walk skips because its effects are in force still counts (the engine skips only one with `onSave`). */
  countedInForce: boolean;
  /** Bookkeeping only: nothing reads the condition, so a try sets nothing and only counts. */
  countOnly: boolean;
}

/**
 * Whether `outcome` (with the draw's `byKind`), drawn in a state whose pre-draw group codes are
 * `codes`, applies `app`.
 */
export function grantApplies(
  app: GrantApplication,
  drawn: StepOutcome,
  codes: readonly number[],
  byKind?: ByKind,
  flags = 0,
  riders?: Draw["riders"],
  typed?: boolean
): boolean {
  if (app.dealing && typed !== true) return false;
  if (app.rider !== undefined) {
    // It fires where its rider landed, once where it is once per turn.
    if (!riders?.some(([id]) => id === app.rider)) return false;
    return app.tried === 0 || (app.tried !== -1 && (flags & app.tried) === 0);
  }
  const outcome = app.landing !== undefined && byKind !== undefined ? byKind[app.landing] : drawn;
  // A "none" outcome (an attack that did not happen) is no landing and no miss,
  // so it applies no condition's grants.
  if (outcome === "none") return false;
  if (app.tried !== 0) {
    // Tried at most once, and only where a later row reads it.
    if (app.tried === -1 || (flags & app.tried) !== 0) return false;
    if (app.on === "first-crit") return outcome === "crit";
    return app.on === "first-miss" ? outcome === "miss" : outcome !== "miss";
  }
  switch (app.on) {
    case "every-hit":
      return outcome !== "miss";
    case "first-hit":
      return outcome !== "miss" && ((codes[app.reads] >> 2) & 0b11) === FIRST_NONE;
    case "any-crit":
      return outcome === "crit";
    case "first-crit":
      return outcome === "crit" && (codes[app.reads] & CRIT_BIT) === 0;
    case "any-miss":
      return outcome === "miss";
    case "first-miss":
      return outcome === "miss" && (codes[app.reads] & MISS_BIT) === 0;
  }
}

/**
 * One step of the turn. A non-empty `variants` ⇒ the step rolls its own attack and
 * advances the groups listed in `updates`; empty ⇒ it is pure damage whose amount
 * depends only on the mode it fires in.
 */
export interface Step {
  id: string;
  /** Declared attacks always fire; riders consult their trigger. */
  trigger: Trigger | null;
  /**
   * Every precomputed draw set for this step; index 0 is the plain one, with no capped
   * rider applying. A step with no state dependence has exactly one. Nothing is
   * transformed inside the walk:
   * {@link Step.select} picks one of these at the draw site.
   */
  variants: readonly StepVariant[];
  /**
   * Which variant to draw from, given the state's group codes, its fire slots with
   * this step's own firing already recorded, its flag bits before this step
   * consumes any, and its counters of capped `every-hit` landings so far.
   */
  select: (
    codes: readonly number[],
    fired: readonly FireMode[],
    flags: number,
    counts: readonly number[]
  ) => number;
  /** Pure-damage payloads, mass 1 each. */
  damage: { hit: PMF; crit: PMF } | null;
  /** Group slots this step's outcome advances. */
  updates: readonly number[];
  /** Per entry of `updates`, the landing kind of the group's rider when this step is a save row, else null. */
  updateKinds: readonly (SaveLanding | null)[];
  /**
   * Per counter, the count at or below which it is equivalent to 0 once this step has run:
   * the cap minus the watched steps still to come, since below that the cap can never
   * bind again. Lets the walk merge states that differ only by such a count.
   */
  settled: readonly number[];
  /**
   * Slots whose group is last read at this step and which a later group reuses: the walk
   * resets them to the start code once the step is done, whether or not it fired, so the
   * next group starts from nothing.
   */
  releases: readonly number[];
  /** Group slot this step's trigger reads, or -1 for `not-fired` / always-fires. */
  reads: number;
  /** Fire slot this step writes when it fires, or -1 for a declared attack. */
  slot: number;
  /** For `not-fired`: the fire slot of the rider or substitute being negated. */
  negates: number;
  /** Fire slot a `spends` draw sets — the watching substitute's — or -1. */
  spendSlot: number;
  /** `next-attack` flag bits this step reads, and so clears when it rolls. */
  consumes: number;
  /** `next-hit` flag bits (a vulnerability) this step reads, and so clears when it hits or crits. */
  hitConsumes: number;
  /** Bits of the conditions damage ends that this step finds set: a `wounded` draw clears them. */
  wounds: number;
  /**
   * For an attack gated on an earlier one (`AttackOptions.after`): the group slot it reads, and
   * whether any outcome opens it (else a landing). Where it is closed the attack does not happen.
   */
  gate: { slot: number; any: boolean } | undefined;
  /** Conditions this step's outcome may apply, in declaration order. */
  grants: readonly GrantApplication[];
  /** Flag bits this step reads that grant advantage. */
  readAdvantage: number;
  /** Flag bits this step reads that grant disadvantage. */
  readDisadvantage: number;
  /** Flag bits this step reads that grant crit-on-hit. */
  readCritOnHit: number;
  /**
   * The flags this step reads, each with what it puts in force here (`MOD_*` bits, and whether it
   * takes penalty dice off a save) and its source: an index into {@link TurnPlan.effectSources}.
   */
  flagReads: readonly { bit: number; modifiers: number; penalty: boolean; source: number }[];
  /**
   * The row's own PMF in each context it can roll in (none for a pure-damage step). A context past
   * the first is built when a state first rolls in it: until then its entry is empty (a hole).
   */
  contextPmfs: readonly PMF[];
  /** Per context, the d20 the row rolls there. */
  contextRollTypes: readonly RollType[];
  /** Per context, whether the row's target is vulnerable there (its landings deal double). */
  contextVulnerable: readonly boolean[];
  /** Which of {@link Step.contextPmfs} a state rolls in. */
  contextIndexOf: (codes: readonly number[], fired: readonly FireMode[], flags: number, counts: readonly number[]) => number;
  /** Whether a substitute rewrites the row's own damage, so it is not its context's PMF. */
  transformed: boolean;
}

/** Trigger kinds that read a group's accumulated state (as opposed to `not-fired`,
 * which reads another rider's fire/not-fire bit directly). */
const READS_GROUP: Record<string, true> = {
  "first-hit": true,
  "any-crit": true,
  "any-miss": true,
  "first-miss": true,
  "every-hit": true,
  "dice-match": true,
};

/**
 * Triggers a condition accepts. Only `first-hit`, `first-crit` and `first-miss` read a group —
 * whether this is the first such outcome — so only they allocate one.
 */
const GRANT_TRIGGERS: Record<string, { readsGroup: boolean }> = {
  "every-hit": { readsGroup: false },
  "first-hit": { readsGroup: true },
  "any-crit": { readsGroup: false },
  "first-crit": { readsGroup: true },
  "any-miss": { readsGroup: false },
  "first-miss": { readsGroup: true },
  start: { readsGroup: false },
};

/**
 * The effects this release's walk puts on a creature: a {@link GrantSpec} or a vulnerability to
 * the next hit (read by attack rolls), or a save disadvantage or penalty dice (read by saves).
 */
type WalkEffect =
  | GrantSpec
  | { condition: string; rule: ConditionRule; until: "end-of-turn" | "until-damaged" }
  | { vulnerability: true; until: "next-hit" }
  | { saveDisadvantage: true; until: "end-of-turn" | "next-save"; to?: readonly string[] }
  | { savePenalty: { count: number; sides: number }; until: "end-of-turn" | "next-save"; to?: readonly string[] };

/** One effect of one condition, as the plan tracks it. */
interface Flag {
  /** For messages: the condition and which of its grants. */
  name: string;
  condition: string;
  /** The creature it is on. */
  creature: string;
  /** What it puts in force on a row that reads it (`MOD_*` bits). */
  modifiers: number;
  /** The dice it takes off a save that reads it. */
  penalty: PenaltyDice | undefined;
  /** The rows that read it: attack rolls, saves, or (a condition) whichever its rule changes. */
  side: "attack" | "save" | "both";
  /** Per reading step, what it puts in force there (`MOD_*` bits). */
  reads: ReadonlyMap<number, number>;
  /** Whether a grant's own save reads it: an effect on saves that lasts and is not scoped with `to`. */
  grantSaveReads: boolean;
  /** What it puts in force on a grant's own save made with `ability`. */
  saveRead: (ability: string | undefined) => number;
  until: WalkEffect["until"];
  /** Steps whose variant it selects; a `next-*` flag is consumed by each (a `next-hit` flag by each hit). */
  readers: number[];
  /** The first step that can set it: the condition's first source. */
  first: number;
  /** The last step that reads it, for a variant, a skip check or a grant's save; -1 if none. */
  lastRead: number;
  /** Its bit in the walk's flag word, or -1 when nothing reads it. */
  bit: number;
}

/** What a {@link ConditionRule}'s modifiers put in force on an attack roll, and on a save. */
const ATTACK_MODIFIERS: Readonly<Record<string, number>> = {
  advantage: MOD_ADVANTAGE,
  disadvantage: MOD_DISADVANTAGE,
  critOnHit: MOD_CRIT_ON_HIT,
  vulnerable: MOD_VULNERABLE,
};
const SAVE_MODIFIERS: Readonly<Record<string, number>> = {
  autoFail: MOD_AUTO_FAIL,
  saveDisadvantage: MOD_SAVE_DISADVANTAGE,
  disadvantage: MOD_SAVE_DISADVANTAGE,
};

/** The `MOD_*` bits of a rule's `modifiers` in `table` (modifiers the row kind ignores add nothing). */
function maskOf(modifiers: readonly string[], table: Readonly<Record<string, number>>): number {
  return modifiers.reduce((mask, modifier) => mask | (table[modifier] ?? 0), 0);
}

/** The abilities a save may name without a rule naming it. */
const ABILITIES: Readonly<Record<string, true>> = {
  strength: true,
  dexterity: true,
  constitution: true,
  intelligence: true,
  wisdom: true,
  charisma: true,
};

/** Whether a flag is still needed once step `step` is done: set by then, and read later. */
const liveAfter = (flag: Flag, step: number): boolean => flag.first <= step && step < flag.lastRead;

/**
 * Decide whether `step` fires in state `codes`, and in which mode.
 *
 * Every group a trigger reads is fully determined before its own step runs
 * (sources always precede dependents), so a trigger can be evaluated once, at
 * its step, and again at the end for `Turn.fireProbability` — both give the
 * same answer. The walk calls this at every step; a threshold policy's
 * look-ahead calls it for the steps still to come.
 */
export function fireMode(
  step: Step,
  codes: readonly number[],
  fired: readonly FireMode[]
): FireMode {
  const trigger = step.trigger;
  if (!trigger) return "hit";

  if (trigger.on === "not-fired") {
    return fired[step.negates] === null ? "hit" : null;
  }

  const code = codes[step.reads];
  const first = (code >> 2) & 0b11;

  switch (trigger.on) {
    case "first-hit":
      if (first === FIRST_NONE) return null;
      return first === FIRST_CRIT ? "crit" : "hit";
    case "any-crit":
      return (code & CRIT_BIT) !== 0 ? "crit" : null;
    case "any-miss":
      return (code & MISS_BIT) !== 0 ? "hit" : null;
    case "first-miss":
      // One step per watched source, each right after it, sharing one fire slot:
      // the first one to see a miss fires, and the rest see the slot taken.
      return (code & MISS_BIT) !== 0 && fired[step.slot] === null ? "hit" : null;
    case "dice-match":
      // Crit mode when a crit's dice matched, so damage-shaped rider dice double
      // like every other rider's on a crit. An attack-shaped rider rolls its own
      // attack and reads the mode only as "it fired".
      if ((code & MATCH_BIT) === 0) return null;
      return (code & CRIT_MATCH_BIT) !== 0 ? "crit" : "hit";
    default:
      // `every-hit` never becomes a step — it is folded into its sources' slices.
      return null;
  }
}

function toPMF(
  damage: Damage | readonly Damage[],
  eps: number,
  id = ""
): PMF {
  const parts = Array.isArray(damage) ? damage : [damage as Damage];
  if (parts.length === 0) return PMF.delta(0, eps);
  const pmfs = parts.map((part) => {
    if (part instanceof PMF) {
      // A bare PMF is a caller-supplied distribution, and its mass is not
      // guaranteed to be 1. Normalize it so the walk stays in probability space:
      // step statistics and fire masses are unconditional probabilities, which
      // only hold when every source contributes unit mass. A builder's toPMF()
      // already returns unit mass.
      const mass = part.mass();
      return Math.abs(mass - 1) <= EPS ? part : part.normalize();
    }
    // A contextual source rolls its own row's context when nothing in the state changes it.
    if (isContextual(part)) return rollUnder(part, contextOf(rowCheckOf(part) as RowCheck, 0), eps, id);
    // `Damage` rules this out, but a consumer deserializing UI state reaches
    // here untyped. Reporting it as a spec error beats a bare TypeError from
    // calling a method that isn't there.
    if (typeof (part as Partial<ToPMF>).toPMF !== "function") {
      throw new TurnSpecError(
        "not-an-attack",
        id,
        `"${id}" is neither a PMF nor a builder with toPMF().`
      );
    }
    // Also checked on the way out: a callable `toPMF` that returns something
    // else would otherwise reach PMF.convolveMany and fail deep inside it.
    const resolved = part.toPMF(eps);
    if (!(resolved instanceof PMF)) {
      throw new TurnSpecError(
        "not-an-attack",
        id,
        `"${id}" has a toPMF() that did not return a PMF.`
      );
    }
    return resolved;
  });
  return PMF.convolveMany(pmfs, eps);
}

/** `source`'s PMF under `context`, checked like a `toPMF()` result. */
function rollUnder(source: ContextualSource, context: RowContext, eps: number, id: string): PMF {
  const resolved = (source.under as (context: RowContext, eps?: number) => unknown)(context, eps);
  if (!(resolved instanceof PMF)) {
    throw new TurnSpecError("not-an-attack", id, `"${id}" has an under() that did not return a PMF.`);
  }
  return resolved;
}

/**
 * Crit payload for a rider: an explicit `critDamage` wins; otherwise every part with dice
 * doubles them — a builder via `doubleDice()`, which for a pool doubles inside then pools and for
 * a parsed string rewrites its dice terms. A part with no dice to double is added as-is on a crit,
 * like the builder it stands for: a bare `PMF`, a `ToPMF` without `doubleDice()` (an attack or save
 * builder), and a parsed string `doubleDice()` cannot rewrite (an attack or save string, `d4d6`).
 */
function critPMF(rider: RiderPayload, base: PMF, eps: number): PMF {
  if (rider.critDamage !== undefined) return toPMF(rider.critDamage, eps);

  const parts = Array.isArray(rider.damage)
    ? rider.damage
    : [rider.damage as Damage];
  if (!parts.some(hasDoubleDice)) return base;
  return PMF.convolveMany(
    parts.map((part) => toPMF(hasDoubleDice(part) ? part.doubleDice() : part, eps)),
    eps
  );
}

/** A `Damage` whose dice can double: a `RollBuilder`, or a parsed string that is a damage expression. */
function hasDoubleDice(part: Damage): part is Damage & { doubleDice(): Damage } {
  if (part instanceof ParsedRollBuilder) return part.canDoubleDice();
  return "doubleDice" in part && typeof part.doubleDice === "function";
}

/** Duck-typed lookup of a `Damage` source's `dice-match` descriptor. Absence
 * (a bare `PMF`, or a `ToPMF` that does not implement {@link HasDiceMatchInfo})
 * is a defined "no match info" state — `{ hit: null, crit: null }` — not a crash. */
function diceMatchInfoOf(
  source: Damage,
  eps: number
): { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } {
  const capable = source as Partial<HasDiceMatchInfo>;
  if (typeof capable.diceMatchInfo === "function") {
    return capable.diceMatchInfo(eps);
  }
  return { hit: null, crit: null };
}

/** Duck-typed lookup of why a `Damage` source has no `dice-match` descriptor on the branches in
 * `missing`, one phrase per cause ("hit and crit: ..."); none for a source that cannot say. */
function diceMatchRefusalsOf(source: Damage, missing: readonly ("hit" | "crit")[]): string[] {
  const capable = source as Partial<HasDiceMatchInfo>;
  if (typeof capable.diceMatchRefusals !== "function") return [];
  const refusals = capable.diceMatchRefusals();
  if (missing.length === 2 && refusals.hit !== null && refusals.hit === refusals.crit) {
    return [`hit and crit: ${refusals.hit}`];
  }
  return missing.flatMap((branch) => {
    const reason = refusals[branch];
    return reason === null ? [] : [`${branch}: ${reason}`];
  });
}

/**
 * How many parts of a list payload roll their own attack: their PMF carries hit or crit
 * outcomes. A parsed string whose dice can double is damage despite its 'hit' label.
 */
function attackPartCount(damage: readonly Damage[], eps: number, id = ""): number {
  return damage.filter((part) => {
    if (part instanceof ParsedRollBuilder && part.canDoubleDice()) return false;
    const labels = toPMF(part, eps, id).outcomes();
    return labels.includes("hit") || labels.includes("crit");
  }).length;
}

/**
 * Split a source into hit / crit / miss sub-mass PMFs, or return null when the
 * source is not attack-shaped (a plain damage roll is not an attack).
 *
 * The shape comes from the PMF's outcome labels, with one exception for a rider's
 * `damage`: a parsed string whose dice can double is damage, although `parse()` labels
 * its whole PMF 'hit' (so it doubles on a crit and takes `critDamage`, exactly like
 * the equivalent builder). In a list, only the other parts' labels decide. A parsed
 * string with a check stays label-shaped, as do attack builders and labelled PMFs; so
 * does one `canDoubleDice()` rejects for another reason (a dice-valued repeat count, `d4d6`).
 *
 * A list holding more than one attack is not one attack: convolving it averages its
 * attacks' outcome labels, so its slices would describe a single strike landing at the
 * mean per-strike chance. It returns null — its damage is still the exact sum of its
 * parts, but nothing can watch it as a source.
 */
function sliceSource(
  pmf: PMF,
  damage?: Damage | readonly Damage[],
  eps: number = EPS
): SourceSlices | null {
  if (damage === undefined) {
    // A PMF slices the same way every time: a row in several contexts, or on several rows, reuses it.
    let known = slicesOfPmf.get(pmf);
    if (known === undefined) slicesOfPmf.set(pmf, (known = slicePmf(pmf, pmf.outcomes(), pmf.outcomes())));
    return known;
  }
  const labels = pmf.outcomes();
  let shapeLabels = labels;
  if (damage !== undefined) {
    const parts = Array.isArray(damage) ? damage : [damage as Damage];
    if (Array.isArray(damage) && attackPartCount(parts, eps) > 1) return null;
    const others = parts.filter((part) => !(part instanceof ParsedRollBuilder && part.canDoubleDice()));
    if (others.length < parts.length) {
      shapeLabels = others.length === 0 ? [] : toPMF(others, eps).outcomes();
    }
  }
  return slicePmf(pmf, labels, shapeLabels);
}

const slicesOfPmf = new WeakMap<PMF, SourceSlices | null>();

/** `pmf` by outcome, or null where its shape (`shapeLabels`) has no hit or crit. */
function slicePmf(pmf: PMF, labels: readonly string[], shapeLabels: readonly string[]): SourceSlices | null {
  if (!shapeLabels.includes("hit") && !shapeLabels.includes("crit")) return null;

  const missParts = ["missNone", "missDamage"]
    .filter((label) => labels.includes(label))
    .map((label) => pmf.filterOutcome(label));

  const hit = labels.includes("hit") ? pmf.filterOutcome("hit") : PMF.emptyMass();
  const crit = labels.includes("crit") ? pmf.filterOutcome("crit") : PMF.emptyMass();
  const miss = missParts.length
    ? missParts.reduce((all, part) => all.add(part))
    : PMF.emptyMass();

  return { hit, crit, miss };
}

/**
 * Whether a declared attack with no hit or crit outcome is a save: its PMF carries a save's
 * labels, or, when a save that cannot fail deals nothing on success (only `missNone`), the
 * builder resolves to a save's `weights`.
 */
function isSaveShaped(source: Damage, pmf: PMF, eps: number): boolean {
  // A source that declares its row is what it declares, whatever its PMF in one context holds.
  const declared = rowCheckOf(source);
  if (declared !== undefined) return declared.kind === "save";
  const labels = pmf.outcomes();
  if (labels.includes("saveFail") || labels.includes("saveHalf")) return true;
  const resolvable = source as { resolve?: (eps?: number) => { weights?: { fail?: unknown } } };
  if (typeof resolvable.resolve !== "function") return false;
  try {
    return typeof resolvable.resolve(eps).weights?.fail === "number";
  } catch {
    // Not a builder whose resolution says: it is no save, and the caller reports why.
    return false;
  }
}

/**
 * A save row split into the four classes its landing kinds tell apart, by outcome label and by
 * whether damage was dealt: it failed and dealt damage; it failed and dealt none; it passed and
 * dealt damage (`saveHalf`); everything else. Their masses sum to the row's.
 */
type SaveClasses = readonly [PMF, PMF, PMF, PMF];

/**
 * Whether each class lands under each kind. `fail` is decided by the label alone. `damage` is
 * "when you deal damage": a failure or a pass that dealt some.
 */
const CLASS_LANDS: readonly Readonly<Record<SaveLanding, boolean>>[] = [
  { fail: true, damage: true },
  { fail: true, damage: false },
  { fail: false, damage: true },
  { fail: false, damage: false },
];

const CLASS_OUTCOMES: readonly ByKind[] = CLASS_LANDS.map((lands) => ({
  fail: lands.fail ? "hit" : "miss",
  damage: lands.damage ? "hit" : "miss",
}));

function saveClasses(pmf: PMF): SaveClasses {
  const labels = pmf.outcomes();
  const label = (name: string): PMF => (labels.includes(name) ? pmf.filterOutcome(name) : PMF.emptyMass());
  const dealt = (part: PMF): [PMF, PMF] => part.splitByFactor((value) => (value > 0 ? 1 : 0));
  const [failed, failedForNothing] = dealt(label("saveFail"));
  const [passed, passedForNothing] = dealt(label("saveHalf"));
  const rest = labels
    .filter((name) => name !== "saveFail" && name !== "saveHalf")
    .reduce((all, name) => all.add(pmf.filterOutcome(name)), passedForNothing);
  return [failed, failedForNothing, passed, rest];
}

/**
 * A source's payload split at the base: what transforms and match odds may read,
 * and the `plusSeparateDamage` channels convolved in after them.
 *
 * Duck-typed like {@link diceMatchInfoOf}: an `AttackBuilder` resolves to
 * `hitBase`/`critBase`/`hitSeparate`/`critSeparate`; anything else (a bare `PMF`,
 * a list of payloads) is all base.
 */
interface BasePayload {
  /** Unit-mass base payloads, or `null` when the slices already are the base. */
  base: { hit: PMF; crit: PMF } | null;
  /** Unit-mass separate channels; `null` when there are none. */
  separate: { hit: PMF; crit: PMF } | null;
}

function basePayloadOf(source: Damage | readonly Damage[], eps: number): BasePayload {
  const resolvable = source as { resolve?: (eps?: number) => Partial<AttackResolution> };
  if (Array.isArray(source) || typeof resolvable.resolve !== "function") {
    return { base: null, separate: null };
  }
  // A `SaveBuilder` resolves too, without the base-payload fields.
  const { hit, hitBase, critBase, hitSeparate, critSeparate } = resolvable.resolve(eps);
  // `hitBase` is the very same PMF as `hit` exactly when there are no channels.
  if (!(hitBase instanceof PMF) || hitBase === hit) return { base: null, separate: null };
  return {
    base: { hit: hitBase, crit: critBase as PMF },
    separate: { hit: hitSeparate as PMF, crit: critSeparate as PMF },
  };
}

/**
 * The better of `x` and a fresh draw from `base`, for every `x` in `spend` — the
 * spend branch of a threshold policy: P(v) = spend(v)·F(v) + spend(<v)·f(v), with F
 * and f taken from `base` normalized. Returned as its two terms: `kept`, where the
 * original roll stands (ties included), and `beaten`, where the fresh roll won.
 * The dice kept in `kept` are the original ones, so any match status known for
 * `spend` carries over; `beaten` holds fresh dice. When `spend` is all of `base`
 * the sum is `base.maxOfTwo()`. Built from rescaled bins of the two inputs, so
 * outcome labels and attribution survive.
 */
function keepBetterOfFresh(spend: PMF, base: PMF): { kept: PMF; beaten: PMF } {
  const baseMass = base.mass();
  const cdf = new Map<number, number>();
  const spendBelow = new Map<number, number>();
  let running = 0;
  let spendRunning = 0;
  for (const value of base.support()) {
    spendBelow.set(value, spendRunning);
    running += base.pAt(value) / baseMass;
    spendRunning += spend.pAt(value);
    cdf.set(value, running);
  }
  const [kept] = spend.splitByFactor((value) => cdf.get(value) ?? 0);
  const [beaten] = base.splitByFactor((value) => (spendBelow.get(value) ?? 0) / baseMass);
  return { kept, beaten };
}

/** The keys a declared-attack wrapper may carry. */
const ATTACK_KEYS: Record<string, true> = { source: true, id: true, tag: true, chance: true, target: true, after: true };

/** A declared attack, unwrapped. */
function attackEntry(
  entry: Attack,
  index: number
): { id: string; tag?: string; source: Damage; chance: number } {
  const id = `attack ${index + 1}`;
  // A wrapper with no source falls through as a would-be source, so it fails
  // `not-an-attack` in toPMF rather than as a bare TypeError.
  if (!("source" in entry) || entry.source === undefined) {
    return { id, source: entry as Damage, chance: 1 };
  }

  const wrapper = entry as unknown as Record<string, unknown>;
  for (const key of Object.keys(wrapper)) {
    if (!ATTACK_KEYS[key]) {
      throw new TurnSpecError(
        "unknown-key",
        typeof wrapper.id === "string" ? wrapper.id : id,
        `Attack "${typeof wrapper.id === "string" ? wrapper.id : id}" carries an unknown key "${key}". Valid keys are source, id, tag, chance and target.`
      );
    }
  }
  if (wrapper.id !== undefined && typeof wrapper.id !== "string") {
    throw new TurnSpecError("non-string-id", id, `Attack "${id}" has a non-string id.`);
  }
  if (wrapper.tag !== undefined && typeof wrapper.tag !== "string") {
    throw new TurnSpecError("non-string-id", id, `Attack "${id}" has a non-string tag.`);
  }

  return {
    id: (wrapper.id as string) ?? id,
    tag: wrapper.tag as string | undefined,
    source: wrapper.source as Damage,
    chance: (wrapper.chance as number) ?? 1,
  };
}

/**
 * The attached conditions a source carries, or `undefined` when it has none.
 * Duck-typed: the only sources that carry `attached` are `AttackBuilder`s, whose
 * field is exactly `readonly AttachedCondition[]`.
 */
function attachedConditionsOf(source: unknown): readonly AttachedCondition[] | undefined {
  if (typeof source !== "object" || source === null || !("attached" in source)) return undefined;
  const attached: unknown = source.attached;
  if (!Array.isArray(attached) || attached.length === 0) return undefined;
  return attached as readonly AttachedCondition[];
}

/**
 * The one {@link EvaluatedCondition} an {@link AttachedCondition} becomes: `of` is the
 * carrying attack's id and the gate's fields are read as `Turn`'s trigger verbs read them
 * ({@link gateFields}).
 */
function conditionFromAttached(
  slotId: string,
  index: number,
  attached: AttachedCondition,
  eps: number
): EvaluatedCondition {
  const grants = (Array.isArray(attached.grants) ? attached.grants : [attached.grants]) as readonly Lasting[];
  const condition: ConditionSpec = {
    id: `${slotId}:${index}`,
    on: attached.on,
    of: [slotId],
    ...gateFields(attached.gate ?? {}, eps),
    grants: grants.map(effectSpec),
  };
  return condition as EvaluatedCondition;
}

/** A rider's payload per source; a spec that is not typed can carry one on any trigger. */
function perSourceOf(rider: EvaluatedRider): PerSource | undefined {
  return "perSource" in rider ? rider.perSource : undefined;
}

/** A `first-hit` rider with a payload per source: folded into its sources' draws, not a step. */
function isFirstHitFold(rider: EvaluatedRider): boolean {
  return rider.on === "first-hit" && perSourceOf(rider) !== undefined;
}

/** A condition's grant save as a list of the options the target picks from; empty without a save. */
function saveOptionsOf(condition: { save?: GrantSaveSpec | readonly GrantSaveSpec[] }): readonly GrantSaveSpec[] {
  const { save } = condition;
  if (save === undefined) return [];
  return Array.isArray(save) ? save : [save as GrantSaveSpec];
}

/** A {@link ConditionSpec} with its effects as the walk reads them. */
type EvaluatedCondition = Omit<ConditionSpec, "on" | "grants" | "onSave"> & {
  on: ConditionSpec["on"];
  grants: readonly WalkEffect[];
  onSave?: readonly WalkEffect[];
};

/** A {@link Rider} whose damage is a {@link RiderDamage} (a `ContextualPayload` is read per attack instead). */
type EvaluatedRider = Rider extends infer R
  ? R extends unknown
    ? Omit<R, "damage" | "landing"> & { damage: RiderDamage; landing?: SaveLanding | "any" }
    : never
  : never;

/** A rider payload that only {@link ContextualPayload.at} can read. */
function isContextualPayload(damage: unknown): boolean {
  if (typeof damage !== "object" || damage === null || Array.isArray(damage) || damage instanceof PMF) return false;
  const candidate = damage as { at?: unknown; toPMF?: unknown };
  return typeof candidate.at === "function" && typeof candidate.toPMF !== "function";
}

/**
 * Builds the plan of `spec`. `declined` names optional conditions the turn does not attempt
 * (see `Turn`): each stays, with no row it watches, so it never lands.
 */
export function buildPlan(
  spec: TurnSpec,
  eps: number = EPS,
  declined: ReadonlySet<string> = new Set(),
  /**
   * `"joint"`: each draw's slice has its riders' payloads convolved in, as the joint `pmf` walk
   * needs. `"masses"`: the slice is the row's own part at the folded mass, for the walks that carry
   * only mass (every reader but `pmf`): the same plan, none of the fold convolutions.
   */
  folds: "joint" | "masses" = "joint"
): TurnPlan {
  const declaredConditions = (spec.conditions ?? []) as readonly EvaluatedCondition[];
  const { stateLimit } = spec;
  if (stateLimit !== undefined && !(Number.isInteger(stateLimit) && stateLimit >= 1)) {
    throw new RangeError(`A turn's stateLimit must be a whole number of 1 or more, got ${stateLimit}.`);
  }
  const fail = (code: TurnSpecErrorCode, id: string, message: string): never => {
    throw new TurnSpecError(code, id, message);
  };

  // A rider's `ContextualPayload` damage is replaced below (`placed`): from there on every damage is a `RiderDamage`.
  const declaredRiders = (spec.riders ?? []) as readonly EvaluatedRider[];
  // `every-hit` capped at 1 IS `first-hit`: lowered here, before anything reads the riders, so
  // it takes the same step, fire slot, `otherwise` / `not-fired`, `of` naming and arithmetic.
  const lowered: readonly EvaluatedRider[] = declaredRiders.map((rider): EvaluatedRider => {
    if (rider.on !== "every-hit" || rider.max !== 1) return rider;
    const { id, of, damage, critDamage, perSource, landing } = rider;
    return {
      on: "first-hit",
      damage,
      ...(landing === undefined ? {} : { landing }),
      ...(id === undefined ? {} : { id }),
      ...(of === undefined ? {} : { of }),
      ...(critDamage === undefined ? {} : { critDamage }),
      ...(perSource === undefined ? {} : { perSource }),
    };
  });
  const substitutes: readonly SubstituteSpec[] = spec.substitutes ?? [];
  const probes: readonly ProbeSpec[] = spec.observe ?? [];
  // A rider that lands on a row ends that row's conditions damage ends, so with any such condition
  // a first-hit damage rider is folded into its sources' draws (a payload per source, the same on
  // each): it lands on the row itself, not in a step after every attack. Not one another entry names.
  // A rider whose payload depends on the attack it lands on (`ContextualPayload`) is folded into
  // its sources' draws, where that attack is known; its `damage` stands in as nothing (the fold
  // reads the payload per attack). An `any-crit` rider with such a payload or a `max` is folded too,
  // landing on its first `max` crits only.
  /** By rider index: the {@link ContextualPayload} a folded rider reads per attack. */
  const contextualPayloads = new Map<number, ContextualPayload>();
  /** By rider index: the riders folded to land on crits only. */
  const critOnly = new Set<number>();
  const placed = lowered.map((rider, index): EvaluatedRider => {
    const contextual = isContextualPayload(rider.damage) ? (rider.damage as unknown as ContextualPayload) : undefined;
    const declaredMax = rider.on === "any-crit" && "max" in rider ? rider.max : undefined;
    // `Infinity` lands on every crit: uncapped.
    const max = declaredMax === Infinity ? undefined : declaredMax;
    const everyCrit = declaredMax === Infinity;
    if (contextual) contextualPayloads.set(index, contextual);
    const damage = contextual ? PMF.delta(0, eps) : rider.damage;
    if (rider.on === "any-crit" && (contextual !== undefined || declaredMax !== undefined)) {
      critOnly.add(index);
      return (
        everyCrit
          ? { ...rider, damage, on: "every-hit", max: undefined }
          : max === undefined || max === 1
            ? { ...rider, damage, on: "first-hit", perSource: {} }
            : { ...rider, damage, on: "every-hit", max }
      ) as EvaluatedRider;
    }
    if (contextual === undefined) return rider;
    if (rider.on === "first-hit") return { ...rider, damage, perSource: perSourceOf(rider) ?? {} };
    if (rider.on === "every-hit") return { ...rider, damage };
    const id = rider.id ?? `rider ${index + 1}`;
    return fail(
      "unsupported-trigger",
      id,
      `Rider "${id}" has a payload per attack on "${rider.on}". Only first-hit, every-hit and any-crit riders take one.`
    );
  });
  const wakes = (spec.conditions ?? []).some((condition) =>
    [...condition.grants, ...(condition.onSave ?? [])].some((effect) => effect.until === "until-damaged")
  );
  // A rider that another rider or a substitute watches stays a step; one a condition watches
  // ("where that rider landed") is folded, so the condition can fire on the row it lands on.
  const named = new Set<string>([
    ...lowered.flatMap((rider) => (typeof rider.of === "string" ? [rider.of] : (rider.of ?? []))),
    ...substitutes.flatMap((substitute) => substitute.of ?? []),
  ]);
  const watchedByConditions = new Set((spec.conditions ?? []).flatMap((condition) => condition.of ?? []));
  const riders: readonly EvaluatedRider[] = placed.map((rider) =>
    rider.on === "first-hit" &&
    perSourceOf(rider) === undefined &&
    (wakes ||
      rider.landing === "any" ||
      rider.joins !== undefined ||
      (rider.id !== undefined && watchedByConditions.has(rider.id))) &&
    (rider.id === undefined || !named.has(rider.id)) &&
    !Array.isArray(rider.damage) &&
    sliceSource(toPMF(rider.damage as Damage, eps), rider.damage as Damage, eps) === null
      ? { ...rider, perSource: {} }
      : rider
  );

  // --- attacks -------------------------------------------------------------
  const attackIds: string[] = [];
  const attackSources: Damage[] = [];
  const attackPMFs: PMF[] = [];
  const attackSingles: PMF[] = [];
  const attackSlices: (SourceSlices | null)[] = [];
  const attackChances: number[] = [];
  const attackIdsByTag = new Map<string, string[]>();
  /** The creature each declared attack is aimed at (`AttackOptions.target`). */
  const attackTargets: string[] = [];
  /** Per declared attack, the earlier attack whose landing gates it (`AttackOptions.after`). */
  const attackAfters: (AttackOptions["after"] | undefined)[] = [];

  /** One source declared as several rows (`attacks(12, sword)`) resolves and slices once. */
  const resolvedSources = new Map<Damage, { pmf: PMF; slices: SourceSlices | null }>();
  spec.attacks.forEach((entry, index) => {
    const { id, tag, source, chance } = attackEntry(entry, index);
    if (!(chance >= 0 && chance <= 1)) {
      throw new RangeError(`Attack "${id}" needs a chance in [0, 1], got ${chance}.`);
    }
    let resolved = resolvedSources.get(source);
    if (resolved === undefined) {
      const resolvedPmf = toPMF(source, eps, id);
      // A declared attack (or a row that lands without a roll) whose PMF holds no landing in this
      // context (every roll misses) still is one: it simply never lands. Validity is structural.
      const declared = rowCheckOf(source);
      resolved = {
        pmf: resolvedPmf,
        slices:
          sliceSource(resolvedPmf) ??
          (declared !== undefined && declared.kind !== "save"
            ? { hit: PMF.emptyMass(), crit: PMF.emptyMass(), miss: resolvedPmf }
            : null),
      };
      resolvedSources.set(source, resolved);
    }
    const pmf = resolved.pmf;
    attackIds.push(id);
    attackSources.push(source);
    attackPMFs.push(pmf);
    // The toQuery() single is the attack's marginal: gated by its occurrence
    // probability. The walk uses the full slices plus a "none" draw instead, so
    // a not-happened attack never reads as a miss or a landing.
    attackSingles.push(chance === 1 ? pmf : pmf.applyHitFrequency(chance));
    attackSlices.push(resolved.slices);
    attackChances.push(chance);
    const target =
      typeof entry === "object" && entry !== null && "source" in entry && "target" in entry ? entry.target : undefined;
    if (target !== undefined && typeof target !== "string") {
      throw new TurnSpecError("non-string-id", id, `Attack "${id}" has a non-string target.`);
    }
    attackTargets.push(target ?? DEFAULT_CREATURE);
    const after = typeof entry === "object" && entry !== null && "source" in entry && "after" in entry ? entry.after : undefined;
    attackAfters.push(after);
    if (tag !== undefined) {
      const tagged = attackIdsByTag.get(tag);
      if (tagged) tagged.push(id);
      else attackIdsByTag.set(tag, [id]);
    }
  });

  // --- attached conditions --------------------------------------------------
  // A builder can carry conditions (`AttackBuilder.onEveryHit` / `onAnyCrit`):
  // each entry becomes one ConditionSpec whose `of` is that attack's id. Declared
  // conditions come first, so their default `condition N` ids never collide with
  // the `${slotId}:${index}` ids the attached entries get.
  const attachedConditions: EvaluatedCondition[] = [];
  attackIds.forEach((slotId, index) => {
    const attached = attachedConditionsOf(attackSources[index]);
    if (!attached) return;
    attached.forEach((entry, entryIndex) => {
      attachedConditions.push(conditionFromAttached(slotId, entryIndex, entry, eps));
    });
  });
  const conditions: readonly EvaluatedCondition[] = [...declaredConditions, ...attachedConditions];

  // --- ids -----------------------------------------------------------------
  const stringId = (value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== "string") {
      fail("non-string-id", String(value), `An id must be a string, got ${typeof value}.`);
    }
    return value as string;
  };
  const riderIds = riders.map((rider, index) => stringId(rider.id, `rider ${index + 1}`));
  const substituteIds = substitutes.map((substitute, index) =>
    stringId(substitute.id, `substitute ${index + 1}`)
  );
  const conditionIds = conditions.map((condition, index) =>
    stringId(condition.id, `condition ${index + 1}`)
  );
  const probeIds = probes.map((probe, index) => stringId(probe.id, `probe ${index + 1}`));
  // Where an effect comes from, as the engine reports it: the starting condition (a `start`
  // condition with no id on the primary target, putting one condition on it for the turn), then
  // each other condition in order.
  const startingIndex = conditions.findIndex(
    (condition) =>
      condition.on === "start" &&
      condition.id === undefined &&
      (condition.target ?? DEFAULT_CREATURE) === DEFAULT_CREATURE &&
      condition.grants.length === 1 &&
      "rule" in condition.grants[0] &&
      condition.grants[0].until === "end-of-turn"
  );
  const effectSources: EffectSource[] = [
    ...(startingIndex === -1 ? [] : [{ kind: "starting" as const }]),
    ...conditionIds.flatMap((id, index) => (index === startingIndex ? [] : [{ kind: "grant" as const, grant: id }])),
  ];
  /** The index into `effectSources` of the effects condition `id` puts in force. */
  const effectSourceOf = (id: string): number => {
    const index = conditionIds.indexOf(id);
    if (index === startingIndex) return 0;
    return effectSources.findIndex((source) => source.kind === "grant" && source.grant === id);
  };
  const seen = new Set<string>();
  for (const id of [...attackIds, ...riderIds, ...substituteIds, ...conditionIds, ...probeIds]) {
    if (seen.has(id)) fail("duplicate-id", id, `Duplicate id "${id}".`);
    seen.add(id);
  }

  /** Refuses a payload no rider can carry: a transform, a grant, or a source's attached condition. */
  const refusePayload = (id: string, on: string, damage: Damage | readonly Damage[]): void => {
    if (isTransform(damage)) {
      fail(
        "unsupported-trigger",
        id,
        `Rider "${id}" carries a transform on "${on}". A transform is only accepted by onFirstHit.`
      );
    }
    const parts: readonly unknown[] = Array.isArray(damage) ? damage : [damage];
    if (parts.some(isGrant)) {
      fail(
        "unsupported-trigger",
        id,
        `Rider "${id}" carries a grant on "${on}". A grant is only accepted by onEveryHit, onFirstHit and onAnyCrit.`
      );
    }
    if (parts.some((part) => attachedConditionsOf(part) !== undefined)) {
      fail(
        "unsupported-trigger",
        id,
        `Rider "${id}" carries a condition attached to its source (AttackBuilder.onEveryHit / onAnyCrit). Attachment is only read from declared attacks; spell this condition with the turn's verbs instead.`
      );
    }
  };

  riders.forEach((rider, index) => {
    const id = riderIds[index];
    // Every trigger but `not-fired` reads a group, so READS_GROUP names them all; anything else
    // would build a step `fireMode` never fires.
    if (rider.on !== "not-fired" && !Object.prototype.hasOwnProperty.call(READS_GROUP, rider.on)) {
      fail(
        "unsupported-trigger",
        id,
        `Rider "${id}" triggers on "${String(rider.on)}", which is not a trigger. Use first-hit, any-crit, any-miss, first-miss, every-hit, dice-match or not-fired.`
      );
    }
    if (rider.landing !== undefined) {
      if (rider.landing !== "fail" && rider.landing !== "damage" && rider.landing !== "any") {
        fail(
          "unsupported-trigger",
          id,
          `Rider "${id}" declares landing "${String(rider.landing)}". Use "fail" or "damage".`
        );
      }
      if (rider.on === "not-fired") {
        fail(
          "unsupported-trigger",
          id,
          `Rider "${id}" declares a landing on "not-fired", which watches a rider, not attacks. A landing says how to read a save among attack sources.`
        );
      }
    }
    refusePayload(id, rider.on, rider.damage);
    // `max` and `perSource` are spelled on the rider, so a spec that is not typed can put them on
    // any trigger: refuse rather than ignore, which would deal uncapped damage.
    const declared = declaredRiders[index];
    const max = "max" in declared ? declared.max : undefined;
    if (max !== undefined) {
      if (declared.on !== "every-hit" && declared.on !== "any-crit") {
        fail(
          "unsupported-trigger",
          id,
          `Rider "${id}" has a max on "${declared.on}". Only every-hit riders are capped; first-hit already applies once.`
        );
      }
      if (typeof max !== "number" || !(Number.isInteger(max) || (declared.on === "any-crit" && max === Infinity)) || max < 1) {
        throw new RangeError(`Rider "${id}" needs a positive integer max, got ${String(max)}.`);
      }
    }
    const perSource = perSourceOf(rider);
    if (perSource !== undefined) {
      if (rider.on !== "every-hit" && rider.on !== "first-hit") {
        fail(
          "unsupported-trigger",
          id,
          `Rider "${id}" has a payload per source on "${rider.on}". Only first-hit and every-hit riders take one.`
        );
      }
      for (const [sourceId, payload] of Object.entries(perSource)) {
        if (typeof payload !== "object" || payload === null || payload.damage === undefined) {
          fail("not-an-attack", sourceId, `Rider "${id}" has no damage in its payload for "${sourceId}".`);
        }
        refusePayload(id, rider.on, payload.damage);
      }
    }
  });
  conditions.forEach((condition, index) => {
    const id = conditionIds[index];
    if (!GRANT_TRIGGERS[condition.on]) {
      fail(
        "unsupported-trigger",
        id,
        `Condition "${id}" triggers on "${condition.on}"; a condition reads every-hit, first-hit, any-crit, first-crit, first-miss or any-miss.`
      );
    }
    const { chance } = condition;
    if (chance !== undefined && !(chance >= 0 && chance <= 1)) {
      throw new RangeError(`Condition "${id}" needs a chance in [0, 1], got ${chance}.`);
    }
    const options = saveOptionsOf(condition);
    if (options.length > 0 && chance !== undefined) {
      throw new Error(`Condition "${id}" has both a save and a chance; the save is the chance its grants take.`);
    }
    for (const option of options) {
      const valid =
        "failChance" in option
          ? typeof option.failChance === "function"
          : Number.isFinite(option.dc) && Number.isFinite(option.bonus);
      if (!valid) throw new Error(`Condition "${id}" has a save that is neither { dc, bonus } nor { failChance }.`);
    }
    if (condition.on === "start") {
      const tried = (["save", "chance", "onSave", "landing", "dealing"] as const).find((field) => condition[field] !== undefined);
      if (tried !== undefined) {
        throw new Error(`Condition "${id}" is in force from the start, so nothing tries it: it takes no "${tried}".`);
      }
    } else if (condition.target !== undefined) {
      throw new Error(`Condition "${id}" names a target, which only a "start" condition takes: the others are on the creature of the row that lands them.`);
    }
    if (condition.onSave !== undefined && chance === undefined && options.length === 0) {
      throw new Error(
        `Condition "${id}" has onSave grants but no save or chance: there is no other branch to apply them on.`
      );
    }
    if (condition.landing !== undefined && condition.landing !== "fail" && condition.landing !== "damage") {
      fail("unsupported-trigger", id, `Condition "${id}" declares landing "${String(condition.landing)}". Use "fail" or "damage".`);
    }
    for (const grant of [...condition.grants, ...(condition.onSave ?? [])]) {
      if ("vulnerability" in grant) {
        const until: unknown = grant.until;
        if (until !== "next-hit") {
          throw new Error(`Condition "${id}" has a vulnerability lasting "${String(until)}"; use "next-hit".`);
        }
        continue;
      }
      if ("saveDisadvantage" in grant || "savePenalty" in grant) {
        const until: unknown = grant.until;
        if (until !== "end-of-turn" && until !== "next-save") {
          throw new Error(`Condition "${id}" has a save effect lasting "${String(until)}"; use "end-of-turn" or "next-save".`);
        }
        if ("savePenalty" in grant) {
          const { count, sides } = grant.savePenalty;
          if (!(Number.isInteger(count) && count >= 1 && Number.isInteger(sides) && sides >= 1)) {
            throw new RangeError(`Condition "${id}" has a save penalty of ${count}d${sides}; use whole dice of 1 or more.`);
          }
        }
        continue;
      }
      if ("rule" in grant) {
        const until: unknown = grant.until;
        if (until !== "end-of-turn" && until !== "until-damaged") {
          throw new Error(`Condition "${id}" has a condition lasting "${String(until)}"; use "end-of-turn" or "until-damaged".`);
        }
        continue;
      }
      if (!grant.advantage && !grant.disadvantage && !grant.critOnHit) {
        throw new Error(`Condition "${id}" has a grant that sets no modifier.`);
      }
      if (grant.until !== "next-attack" && grant.until !== "end-of-turn") {
        throw new Error(
          `Condition "${id}" has a grant lasting "${String(grant.until)}"; use "next-attack" or "end-of-turn".`
        );
      }
    }
  });
  probes.forEach((probe, index) => {
    if ((probe.on as string) !== "any-crit") {
      fail(
        "unsupported-trigger",
        probeIds[index],
        `Probe "${probeIds[index]}" observes "${String(probe.on)}", which is not a probe. Use any-crit.`
      );
    }
  });
  substitutes.forEach((substitute, index) => {
    const id = substituteIds[index];
    if (substitute.on !== "first-hit" || substitute.substitute !== "reroll-keep-higher") {
      fail(
        "unsupported-trigger",
        id,
        `Substitute "${id}" must be { on: "first-hit", substitute: "reroll-keep-higher" }.`
      );
    }
    if (substitute.policy?.kind === "optimal") {
      fail(
        "unsupported-policy",
        id,
        `Substitute "${id}" asks for the optimal policy, which this release does not support.`
      );
    }
  });

  const attackIndexById = new Map(attackIds.map((id, index) => [id, index]));
  const riderIndexById = new Map(riderIds.map((id, index) => [id, index]));
  const substituteIndexById = new Map(substituteIds.map((id, index) => [id, index]));
  const conditionIdSet = new Set(conditionIds);
  const probeIdSet = new Set(probeIds);

  // Riders' own PMFs and slices, built on first use: validation, `rerollIds` and
  // the steps all need them, and resolving a builder is not free.
  const riderPMFs: (PMF | undefined)[] = [];
  const riderSlices: (SourceSlices | null | undefined)[] = [];
  const riderPMF = (index: number): PMF => {
    riderPMFs[index] ??= toPMF(riders[index].damage, eps, riderIds[index]);
    return riderPMFs[index];
  };
  const slicesOf = (sourceId: string): SourceSlices | null => {
    const attackIndex = attackIndexById.get(sourceId);
    if (attackIndex !== undefined) return attackSlices[attackIndex];
    const riderIndex = riderIndexById.get(sourceId) as number;
    if (riderSlices[riderIndex] === undefined) {
      riderSlices[riderIndex] = sliceSource(riderPMF(riderIndex), riders[riderIndex].damage, eps);
    }
    return riderSlices[riderIndex] as SourceSlices | null;
  };
  /**
   * Whether `sourceId` is a save row: a declared attack with no hit or crit outcome that is a
   * save. A rider can watch one only by declaring how it lands.
   */
  const saveRows = new Map<string, boolean>();
  const isSaveRow = (sourceId: string): boolean => {
    let known = saveRows.get(sourceId);
    if (known === undefined) {
      const index = attackIndexById.get(sourceId);
      known =
        index !== undefined &&
        attackSlices[index] === null &&
        isSaveShaped(attackSources[index], attackPMFs[index], eps);
      saveRows.set(sourceId, known);
    }
    return known;
  };
  const classesById = new Map<string, SaveClasses>();
  const classesOf = (sourceId: string): SaveClasses => {
    let classes = classesById.get(sourceId);
    if (classes === undefined) {
      classes = saveClasses(attackPMFs[attackIndexById.get(sourceId) as number]);
      classesById.set(sourceId, classes);
    }
    return classes;
  };
  /** The landing kinds riders declare for each watched save row. */
  const landingKinds = new Map<string, Set<SaveLanding>>();
  /**
   * `sourceId`'s slices as a rider reading it under `landing` sees them (only for checking what
   * the rider can do with it: the walk draws the row by class), or null when it is no save row or
   * no kind is declared.
   */
  const saveSlices = (sourceId: string, landing: SaveLanding | undefined): SourceSlices | null => {
    if (landing === undefined || !isSaveRow(sourceId)) return null;
    const kinds = landingKinds.get(sourceId) ?? new Set<SaveLanding>();
    kinds.add(landing);
    landingKinds.set(sourceId, kinds);
    const classes = classesOf(sourceId);
    const sum = (wanted: boolean): PMF =>
      classes.reduce(
        (all, part, index) => (CLASS_LANDS[index][landing] === wanted ? all.add(part) : all),
        PMF.emptyMass()
      );
    return { hit: sum(true), crit: PMF.emptyMass(), miss: sum(false) };
  };
  /**
   * Per rider: whether its payload is a list of more than one attack (a flurry's two
   * strikes). It rolls attacks, so it crits on its own terms and reads grants, but it
   * is no single source: nothing can watch it, and it never joins a default `of`.
   */
  const attackLists = riders.map(
    (rider, index) =>
      Array.isArray(rider.damage) && attackPartCount(rider.damage, eps, riderIds[index]) > 1
  );
  /** The damage a source id rolls: a declared attack's source or a rider's payload. */
  const damageOf = (sourceId: string): Damage | readonly Damage[] => {
    const attackIndex = attackIndexById.get(sourceId);
    if (attackIndex !== undefined) return attackSources[attackIndex];
    return riders[riderIndexById.get(sourceId) as number].damage;
  };
  const matchInfoOf = (
    sourceId: string
  ): { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } => {
    const damage = damageOf(sourceId);
    return Array.isArray(damage)
      ? { hit: null, crit: null }
      : diceMatchInfoOf(damage as Damage, eps);
  };

  // --- references ----------------------------------------------------------
  /**
   * Resolves an `of` list — attack ids, rider ids, or declaration tags — to the
   * source ids it names, and checks each can be watched. Shared by riders and
   * substitutes, so both resolve, expand and fail identically.
   */
  const resolveSources = (
    ownerId: string,
    of: readonly string[],
    watchesDice: boolean,
    landing?: SaveLanding,
    skipUncrittable = false
  ): string[] => {
    const sourceIds: string[] = [];
    const skipped = new Set<string>();
    for (const entry of of) {
      if (attackIndexById.has(entry) || riderIndexById.has(entry)) {
        sourceIds.push(entry);
      } else if (
        substituteIndexById.has(entry) ||
        conditionIdSet.has(entry) ||
        probeIdSet.has(entry)
      ) {
        const kind = substituteIndexById.has(entry)
          ? "substitute"
          : conditionIdSet.has(entry)
            ? "condition"
            : "probe";
        const effect =
          kind === "substitute"
            ? "changes damage"
            : kind === "condition"
              ? "changes later attack rolls"
              : "only reports a probability";
        fail(
          "not-an-attack",
          entry,
          `"${ownerId}" watches "${entry}", a ${kind}. A ${kind} ${effect}; it rolls no attack to watch.`
        );
      } else if (attackIdsByTag.has(entry)) {
        sourceIds.push(...(attackIdsByTag.get(entry) as string[]));
      } else {
        fail("unknown-id", entry, `"${ownerId}" depends on "${entry}", which is not in this turn.`);
      }
    }
    // Deduplicated, so `of: ["a", "a"]` shares a trigger group with `of: ["a"]`
    // instead of consuming a second slot and tripping `too-many-groups` on a
    // turn that is really tracking one source set. Repeats are otherwise
    // harmless: advancing a group twice for one outcome is idempotent.
    const unique = [...new Set(sourceIds)];
    if (unique.length === 0) {
      fail("unknown-id", ownerId, `"${ownerId}" has no sources.`);
    }
    for (const sourceId of unique) {
      if (sourceId === ownerId) {
        fail("self-reference", ownerId, `"${ownerId}" cannot depend on itself.`);
      }
      const riderIndex = riderIndexById.get(sourceId);
      if (riderIndex !== undefined && riders[riderIndex].on === "every-hit") {
        fail(
          "not-an-attack",
          sourceId,
          `"${ownerId}" triggers on "${sourceId}", an every-hit rider. Those are folded into their own sources rather than resolved separately, so they cannot be triggered on — point at the attacks instead.`
        );
      }
      if (riderIndex !== undefined && isFirstHitFold(riders[riderIndex])) {
        fail(
          "not-an-attack",
          sourceId,
          `"${ownerId}" triggers on "${sourceId}", a first-hit rider with a payload per source. Those are folded into their own sources rather than resolved separately, so they cannot be triggered on — point at the attacks instead.`
        );
      }
      if (riderIndex !== undefined && attackLists[riderIndex]) {
        fail(
          "not-an-attack",
          sourceId,
          `"${ownerId}" watches "${sourceId}", a list of several attacks. A list rider resolves as one payload, not as attacks that each land, so it cannot be watched. Declare each attack as its own rider with its own id, and name those.`
        );
      }
      const slices = slicesOf(sourceId) ?? saveSlices(sourceId, landing);
      if (!slices) {
        // A probe over `crit` skips the rows that cannot crit: a save or a flat payload.
        if (skipUncrittable && attackIndexById.has(sourceId)) {
          skipped.add(sourceId);
          continue;
        }
        fail(
          "not-an-attack",
          sourceId,
          `"${ownerId}" triggers on "${sourceId}", which has no hit/crit outcomes.${
            landing === undefined && isSaveRow(sourceId)
              ? ' It is a save: a rider can watch a save row by declaring `landing` ("fail" or "damage").'
              : ""
          }`
        );
      } else if (watchesDice) {
        const info = matchInfoOf(sourceId);
        const missingHit = slices.hit.mass() > 0 && info.hit === null;
        const missingCrit = slices.crit.mass() > 0 && info.crit === null;
        if (missingHit || missingCrit) {
          const missing: ("hit" | "crit")[] = [];
          if (missingHit) missing.push("hit");
          if (missingCrit) missing.push("crit");
          const reasons = diceMatchRefusalsOf(damageOf(sourceId) as Damage, missing);
          fail(
            "no-dice-descriptor",
            sourceId,
            reasons.length > 0
              ? `Rider "${ownerId}" reads "${sourceId}" for "dice-match", but "${sourceId}" has no dice descriptor to match against (${reasons.join("; ")}).`
              : `Rider "${ownerId}" reads "${sourceId}" for "dice-match", but "${sourceId}" has no dice descriptor to match against — a bare PMF, a string-parsed expression, or a keep()/bestOf() pool (ambiguous "the dice" under crit doubling) cannot be matched.`
          );
        }
      }
    }
    return skipped.size === 0 ? unique : unique.filter((sourceId) => !skipped.has(sourceId));
  };

  // Attack-shaped `any-miss` / `first-miss` riders: a reroll continues the attacks it
  // watches, so an omitted `of` includes it (see `Trigger`).
  const isReroll = riders.map(
    (rider, index) =>
      (rider.on === "any-miss" || rider.on === "first-miss") && slicesOf(riderIds[index]) !== null
  );
  const rerollIds = riderIds.filter((_, index) => isReroll[index]);
  /**
   * An omitted `of`: every declared attack, plus the rerolls among the first `before`
   * riders — for a rider, those listed before it, as `Turn`'s chaining methods snapshot.
   */
  const defaultOf = (before: number): string[] => [
    ...attackIds,
    ...riderIds.filter((_, index) => index < before && isReroll[index]),
  ];

  // Nodes of the dependency graph: riders first, then substitutes.
  const riderCount = riders.length;
  const nodeIds = [...riderIds, ...substituteIds];
  const nodeIndexById = new Map(nodeIds.map((id, index) => [id, index]));

  // Per rider: the source ids a trigger watches, or for `not-fired` the negated
  // node's id. Per substitute: the source ids it watches.
  // A folded rider named in another rider's `of` is a partner: that rider lands on the partner's
  // rows (those in `where`) only where the partner lands too (Spellfire Adept on a smite).
  const partnersOf = riders.map((rider) =>
    !Array.isArray(rider.of)
      ? []
      : (rider.of as readonly string[]).filter((entry) => {
          const index = riderIndexById.get(entry);
          // A partner lands once: a first-hit rider folded into its sources (a smite).
          return index !== undefined && isFirstHitFold(riders[index]);
        })
  );
  const ownSourcesOf = (rider: EvaluatedRider, index: number): string[] => {
    const id = riderIds[index];
    // An explicit `of: []` watches nothing, so the rider never lands; an omitted `of` defaults.
    if (Array.isArray(rider.of) && rider.of.length === 0) return [];
    const declared = typeof rider.of === "string" ? [rider.of] : (rider.of ?? defaultOf(index));
    const of = declared.filter((entry) => !partnersOf[index].includes(entry));
    // Only partners: the rider lands on no row of its own.
    if (of.length === 0 && partnersOf[index].length > 0) return [];
    return resolveSources(id, of, rider.on === "dice-match", rider.landing === "any" ? "fail" : rider.landing);
  };
  /** Per rider, the rows a partner opens to it, with the partners that open each. */
  const openedBy = riders.map((rider, index) => {
    const opened = new Map<string, string[]>();
    for (const partner of partnersOf[index]) {
      const partnerIndex = riderIndexById.get(partner) as number;
      const rows = rider.where?.[partner] ?? ownSourcesOf(riders[partnerIndex], partnerIndex);
      for (const row of rows) opened.set(row, [...(opened.get(row) ?? []), partner]);
    }
    return opened;
  });
  riders.forEach((rider, index) => {
    for (const key of Object.keys(rider.where ?? {})) {
      if (!partnersOf[index].includes(key)) {
        fail("unknown-id", key, `Rider "${riderIds[index]}" has "where" for "${key}", which is not a partner in its "of".`);
      }
    }
    if (partnersOf[index].length > 0 && rider.on !== "first-hit") {
      fail("unsupported-trigger", riderIds[index], `Rider "${riderIds[index]}" lands alongside a partner, so it lands once: use first-hit.`);
    }
  });
  const sourceIdsByNode: string[][] = [
    ...riders.map((rider, index) => {
      if (rider.on !== "not-fired") {
        const own = ownSourcesOf(rider, index);
        return [...own, ...[...openedBy[index].keys()].filter((row) => !own.includes(row))];
      }
      const id = riderIds[index];
      const target = rider.of;
      if (target === id) {
        fail("self-reference", id, `Rider "${id}" cannot depend on itself.`);
      }
      const targetIndex = nodeIndexById.get(target);
      if (targetIndex === undefined) {
        fail(
          "unknown-id",
          target,
          `Rider "${id}" negates "${target}", which is not a rider or substitute in this turn.`
        );
      }
      if (targetIndex! < riderCount && riders[targetIndex!].on === "every-hit") {
        fail(
          "not-an-attack",
          target,
          `Rider "${id}" negates "${target}", an every-hit rider, which can fire more than once and so has no single "did not fire" branch.`
        );
      }
      return [target];
    }),
    ...substitutes.map((substitute, index) =>
      resolveSources(substituteIds[index], substitute.of ?? defaultOf(riderCount), false)
    ),
  ];
  // Per condition: the source ids whose outcomes apply its grants.
  /** Whether rider `index` is folded into its sources' draws, where a landing of it is known. */
  const foldedRider = (index: number): boolean => riders[index].on === "every-hit" || isFirstHitFold(riders[index]);
  // Per condition: the folded rider whose landing fires it (`of: [rider id]`, the attacks in `where`), if any.
  const conditionRiders = conditions.map((condition, index): string | undefined => {
    const named = (condition.of ?? []).filter((entry) => {
      const riderIndex = riderIndexById.get(entry);
      return riderIndex !== undefined && foldedRider(riderIndex);
    });
    if (named.length === 0) return undefined;
    if (named.length !== (condition.of ?? []).length || named.length > 1) {
      fail(
        "not-an-attack",
        conditionIds[index],
        `Condition "${conditionIds[index]}" names a rider beside other entries in "of"; a condition fires where one rider landed, or on its rows.`
      );
    }
    return named[0];
  });
  conditions.forEach((condition, index) => {
    for (const key of Object.keys(condition.where ?? {})) {
      if (key !== conditionRiders[index]) {
        fail("unknown-id", key, `Condition "${conditionIds[index]}" has "where" for "${key}", which is not the rider in its "of".`);
      }
    }
  });
  const conditionSources = conditions.map((condition, index) => {
    if (condition.on === "start" || (Array.isArray(condition.of) && condition.of.length === 0)) return [];
    if (declined.has(conditionIds[index])) return [];
    const rider = conditionRiders[index];
    if (rider === undefined) {
      return resolveSources(conditionIds[index], condition.of ?? defaultOf(riderCount), false, condition.landing);
    }
    // The rows the rider can land on, in `where` when the condition lists them.
    const sources = sourceIdsByNode[riderIndexById.get(rider) as number];
    const where = condition.where?.[rider];
    if (where === undefined) return sources;
    // An id must exist; one the rider does not watch is never a landing of it, so it counts nothing.
    for (const entry of where) {
      if (!attackIndexById.has(entry) && !riderIndexById.has(entry)) {
        fail("unknown-id", entry, `Condition "${conditionIds[index]}" counts "${rider}" landing on "${entry}", which is not in this turn.`);
      }
    }
    return sources.filter((sourceId) => where.includes(sourceId));
  });
  // Attack rows a condition reads under `landing: "damage"`: their hits and crits split by
  // whether the row's own damage was above 0, so the condition lands only where it was.
  // So are the attack rows a rider reads under `landing: "damage"`: "when you deal damage".
  riders.forEach((rider, index) => {
    if (rider.joins === undefined) return;
    const id = riderIds[index];
    if (rider.landing === "any") {
      fail("unsupported-trigger", id, `Rider "${id}" joins rows but lands on anything: a miss has no roll to join.`);
    }
    for (const joined of rider.joins) {
      if (!attackIndexById.has(joined)) fail("unknown-id", joined, `Rider "${id}" joins "${joined}", which is not an attack in this turn.`);
    }
  });
  // An attack gated on an earlier one: validated here, before the parent's draws are split.
  attackAfters.forEach((after, index) => {
    if (after === undefined) return;
    const id = attackIds[index];
    const parent = attackIndexById.get(after.of);
    if (parent === undefined) fail("unknown-id", after.of, `Attack "${id}" happens after "${after.of}", which is not an attack in this turn.`);
    if ((parent as number) >= index) fail("unknown-id", after.of, `Attack "${id}" happens after "${after.of}", which does not come before it.`);
    if (after.landing !== "hit" && after.landing !== "damage" && after.landing !== "any") {
      fail("unsupported-trigger", id, `Attack "${id}" happens after a landing of "${String(after.landing)}". Use "hit", "damage" or "any".`);
    }
  });
  const dealtSources = new Set([
    ...attackAfters.flatMap((after) => (after?.landing === "damage" && !isSaveRow(after.of) ? [after.of] : [])),
    ...conditions.flatMap((condition, index) =>
      condition.landing === "damage" ? conditionSources[index].filter((id) => !isSaveRow(id)) : []
    ),
    ...riders.flatMap((rider, index) =>
      rider.on !== "not-fired" && rider.landing === "damage" ? sourceIdsByNode[index].filter((id) => !isSaveRow(id)) : []
    ),
  ]);
  // Attack rows a condition reads under `dealing`: their hits and crits split by whether the
  // landing dealt that damage type. A turn names one type, as the engine's does.
  const dealingTypes = [...new Set(conditions.flatMap((condition) => (condition.dealing === undefined ? [] : [condition.dealing])))];
  if (dealingTypes.length > 1) {
    fail("unsupported-trigger", conditionIds[0], `A turn may name one damage type a landing must deal; this one names ${dealingTypes.join(", ")}.`);
  }
  const dealingType = dealingTypes[0];
  conditions.forEach((condition, index) => {
    if (condition.dealing === undefined) return;
    if (!["every-hit", "first-hit", "any-crit", "first-crit"].includes(condition.on) || conditionRiders[index] !== undefined) {
      fail(
        "unsupported-trigger",
        conditionIds[index],
        `Condition "${conditionIds[index]}" needs ${condition.dealing} damage dealt, which only a hit or crit of an attack row can say.`
      );
    }
  });
  const dealingSources = new Set(
    conditions.flatMap((condition, index) =>
      condition.dealing === undefined ? [] : conditionSources[index].filter((id) => !isSaveRow(id))
    )
  );
  // Per probe: the source ids whose crits it reports.
  const probeSources = probes.map((probe, index) =>
    resolveSources(probeIds[index], probe.of ?? defaultOf(riderCount), false, undefined, true)
  );

  // --- ordering ------------------------------------------------------------
  // A node may only reference nodes that resolve before it.
  const order: number[] = [];
  const visiting = new Set<number>();
  const done = new Set<number>();

  const visit = (node: number): void => {
    if (done.has(node)) return;
    const id = nodeIds[node];
    if (visiting.has(node)) {
      fail("cycle", id, `"${id}" is part of a dependency cycle.`);
    }
    visiting.add(node);
    for (const sourceId of sourceIdsByNode[node]) {
      const dependency = nodeIndexById.get(sourceId);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(node);
    done.add(node);
    order.push(node);
  };
  nodeIds.forEach((_, node) => visit(node));

  // --- substitutes: one transform per source ---------------------------------
  // Overlapping `of` sets would transform the same slice twice — max-of-four, not
  // max-of-two — so they are refused rather than applied in sequence.
  const substituteBySource = new Map<string, number>();
  substitutes.forEach((_, index) => {
    for (const sourceId of sourceIdsByNode[riderCount + index]) {
      const other = substituteBySource.get(sourceId);
      if (other !== undefined) {
        fail(
          "duplicate-substitute",
          substituteIds[index],
          `Substitutes "${substituteIds[other]}" and "${substituteIds[index]}" both watch "${sourceId}". One transform per source: two would apply to the same payload.`
        );
      }
      substituteBySource.set(sourceId, index);
    }
  });

  // --- groups --------------------------------------------------------------
  // One group per distinct source set. Sharing matters: sneak attack and Fire's
  // Burn over the same two daggers are ONE group, so they resolve jointly.
  // Substitutes allocate none: each owns a fire slot instead. The cap counts groups
  // live at once, not source sets: see the group slots below.
  const groupIndexByKey = new Map<string, number>();
  const groupSources: string[][] = [];
  const groupKeys: string[] = [];
  const groupLandings: (SaveLanding | null)[] = [];
  const groupOf = (sourceIds: readonly string[], landing?: SaveLanding): number => {
    // A landing kind splits a group only through the save rows among its sources, or the attack
    // rows a `damage` condition splits by damage dealt: two readers over the same sources with
    // different kinds read those rows differently, so they cannot share.
    const kind =
      landing !== undefined && sourceIds.some((id) => isSaveRow(id) || (landing === "damage" && dealtSources.has(id)))
        ? landing
        : null;
    // JSON, not a delimiter join: an id is consumer-supplied, and a delimiter
    // that can appear inside one makes the encoding non-injective, so two
    // distinct source sets could share a group.
    const key = JSON.stringify([[...sourceIds].sort(), kind]);
    const existing = groupIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = groupSources.length;
    groupIndexByKey.set(key, index);
    groupSources.push([...sourceIds]);
    groupKeys.push(key);
    groupLandings.push(kind);
    return index;
  };

  const readsByRider = new Map<number, number>();
  const everyHitGroups = new Map<string, number>();
  for (const node of order) {
    if (node >= riderCount) continue;
    const rider = riders[node];
    // A folded first-hit rider needs no group: it is applied inside its sources' draws.
    if (!READS_GROUP[rider.on] || isFirstHitFold(rider)) continue;
    // A rider that lands on anything reads a save's every class: a failure or a pass advances its group alike.
    const group = groupOf(sourceIdsByNode[node], rider.landing === "any" ? "fail" : rider.landing);
    readsByRider.set(node, group);
    if (rider.on === "every-hit") everyHitGroups.set(riderIds[node], group);
  }
  // A condition reuses the group its `of` already has: a first-hit grant and a first-hit
  // rider over the same attacks share one. Only first-hit / first-miss read it.
  // A gated attack reads its parent's group: a hit (`first`), damage dealt (`first` under the
  // `damage` kind), or anything (a failure or a pass of a save alike, any change of its code).
  const gateGroups = attackAfters.map((after) =>
    after === undefined ? -1 : groupOf([after.of], after.landing === "hit" ? undefined : after.landing === "any" ? "fail" : "damage")
  );
  const conditionGroups = conditions.map((condition, index) =>
    GRANT_TRIGGERS[condition.on].readsGroup ? groupOf(conditionSources[index], condition.landing) : -1
  );
  // A probe reads the crit bit of its sources' group at the final collapse, sharing the group
  // any rider over the same sources has.
  const probeGroups = probes.map((_, index) =>
    probeSources[index].length === 0 ? -1 : groupOf(probeSources[index])
  );

  // --- fire slots ----------------------------------------------------------
  const fireSlots = new Map<string, number>();
  riders.forEach((rider, index) => {
    if (rider.on !== "every-hit") fireSlots.set(riderIds[index], fireSlots.size);
  });
  for (const id of substituteIds) fireSlots.set(id, fireSlots.size);

  // --- sequence --------------------------------------------------------------
  // Declared attacks in order, then riders in dependency order — except that a
  // `first-miss` rider gets one slot directly after each step of every source it
  // watches, so its reroll lands where the miss happened.
  type Entry = { id: string; attack: number; rider: number };
  const sequence: Entry[] = attackIds.map((id, index) => ({ id, attack: index, rider: -1 }));
  for (const node of order) {
    if (node >= riderCount) continue;
    const rider = riders[node];
    if (rider.on === "every-hit" || rider.on === "first-miss" || isFirstHitFold(rider)) continue;
    sequence.push({ id: riderIds[node], attack: -1, rider: node });
  }
  for (const node of order) {
    if (node >= riderCount || riders[node].on !== "first-miss") continue;
    const watched = new Set(sourceIdsByNode[node]);
    const slot: Entry = { id: riderIds[node], attack: -1, rider: node };
    for (let position = sequence.length - 1; position >= 0; position--) {
      if (!watched.has(sequence[position].id)) continue;
      // After the source, and after any first-miss slots already placed behind it.
      let after = position + 1;
      while (after < sequence.length && riders[sequence[after].rider]?.on === "first-miss") after++;
      sequence.splice(after, 0, slot);
    }
  }

  // --- flags -------------------------------------------------------------------
  // One flag per granted modifier: each of a condition's grants and each of its
  // onSave grants, keyed by (condition, grant) rather than by step, so `next-attack`
  // and `end-of-turn` are distinct flags even for the same modifier. A flag read by
  // no later step gets no bit at all: setting it could change nothing.
  // A list of several attacks rolls attacks too, so a grant does not skip it silently.
  // What each row declares about itself: its range or the ability it saves with, which decide
  // what a condition's rule does to it.
  const rowFacts = sequence.map((entry) => rowCheckOf(damageOf(entry.id)));
  // A row that lands without a roll (`kind: "auto"`) rolls no d20: no effect reads it.
  const rollsAttack = sequence.map(
    (entry, position) =>
      rowFacts[position]?.kind !== "auto" &&
      (entry.attack !== -1 ? attackSlices[entry.attack] !== null : slicesOf(entry.id) !== null || attackLists[entry.rider])
  );
  const savesAt = sequence.map((entry) => entry.attack !== -1 && isSaveRow(entry.id));
  const rules = conditions.flatMap((condition) =>
    [...condition.grants, ...(condition.onSave ?? [])].flatMap((effect) =>
      "rule" in effect ? [effect.rule, ...(effect.rule.onEnd ? [effect.rule.onEnd.rule] : [])] : []
    )
  );
  const ruledAbilities = new Set(rules.flatMap((rule) => Object.keys(rule.save ?? {})));
  /** Checks a save's ability against the turn's rules: needed where a rule reads saves by ability, and known. */
  const checkAbility = (owner: string, ability: string | undefined): void => {
    if (ability === undefined) {
      if (ruledAbilities.size > 0) {
        fail(
          "save-without-ability",
          owner,
          `"${owner}" is a save with no ability, but a condition in this turn changes saves by ability (${[...ruledAbilities].join(", ")}).`
        );
      }
      return;
    }
    if (!ABILITIES[ability] && !ruledAbilities.has(ability)) {
      fail("unknown-ability", owner, `"${owner}" saves with "${ability}", which is neither a 5e ability nor one a condition's rule names.`);
    }
  };
  sequence.forEach((entry, position) => {
    if (savesAt[position] && rowFacts[position] !== undefined) checkAbility(entry.id, rowFacts[position]?.ability);
  });
  conditions.forEach((condition, index) => {
    for (const option of saveOptionsOf(condition)) checkAbility(conditionIds[index], option.ability);
  });

  // The creature each step is aimed at: a declared attack's `target`; a rider's, its first source's.
  const creatureOf = (sourceId: string): string => {
    const attackIndex = attackIndexById.get(sourceId);
    if (attackIndex !== undefined) return attackTargets[attackIndex];
    const watched = sourceIdsByNode[riderIndexById.get(sourceId) as number] ?? [];
    return watched.length > 0 && riders[riderIndexById.get(sourceId) as number].on !== "not-fired"
      ? creatureOf(watched[0])
      : DEFAULT_CREATURE;
  };
  const creatureAt = sequence.map((entry) => creatureOf(entry.id));

  const conditionFlags = conditions.map((condition, index) => {
    const id = conditionIds[index];
    const sources = new Set(conditionSources[index]);
    const start = condition.on === "start";
    const applyAt = start ? [] : sequence.flatMap((entry, position) => (sources.has(entry.id) ? [position] : []));
    // Its effects are per creature: each source puts them on the creature it is aimed at; a
    // `start` condition has them on its `target` from before the first row.
    const creatures = start
      ? [condition.target ?? DEFAULT_CREATURE]
      : [...new Set(applyAt.map((position) => creatureAt[position]))];
    /** What a condition's rule puts in force on the row at `position` (`MOD_*` bits). */
    const ruleRead = (name: string, rule: ConditionRule, position: number): number => {
      if (savesAt[position]) {
        const ability = rowFacts[position]?.ability;
        return ability === undefined ? 0 : maskOf(rule.save?.[ability] ?? [], SAVE_MODIFIERS);
      }
      if (!rollsAttack[position] || rule.attack === undefined) return 0;
      const range = rowFacts[position]?.range;
      if (range === "melee" || range === "ranged") return maskOf(rule.attack[range] ?? [], ATTACK_MODIFIERS);
      const melee = maskOf(rule.attack.melee ?? [], ATTACK_MODIFIERS);
      if (range === undefined && melee === maskOf(rule.attack.ranged ?? [], ATTACK_MODIFIERS)) return melee;
      return fail(
        "unknown-range",
        sequence[position].id,
        `"${sequence[position].id}" is read by the condition "${name}", whose rule differs by range, but its row declares ${range === undefined ? "no range" : `the range "${String(range)}"`}. Use "melee" or "ranged".`
      );
    };
    const flagOf = (effect: WalkEffect, label: string, creature: string, first: number): Flag => {
      const to = "to" in effect ? effect.to : undefined;
      // A `to` id must exist, but one with no row after the condition's first source that reads
      // the effect (an earlier row, an attack for a save effect) is simply never read: a no-op there.
      const targets =
        to === undefined
          ? null
          : new Set(
              to.flatMap((entry) => {
                if (attackIndexById.has(entry) || riderIndexById.has(entry)) return [entry];
                const tagged = attackIdsByTag.get(entry);
                if (tagged) return tagged;
                return resolveSources(id, [entry], false);
              })
            );
      const side = "rule" in effect ? "both" : "saveDisadvantage" in effect || "savePenalty" in effect ? "save" : "attack";
      const modifiers =
        "vulnerability" in effect
          ? MOD_VULNERABLE
          : "saveDisadvantage" in effect
            ? MOD_SAVE_DISADVANTAGE
            : "savePenalty" in effect || "rule" in effect
              ? 0
              : (effect.advantage ? MOD_ADVANTAGE : 0) |
                (effect.disadvantage ? MOD_DISADVANTAGE : 0) |
                (effect.critOnHit ? MOD_CRIT_ON_HIT : 0);
      // Every attack roll on the creature after the condition's first source there, attack-shaped
      // riders included; for a save effect, every save row; for a condition, every row its rule changes.
      const reads = new Map<number, number>();
      sequence.forEach((entry, position) => {
        if (!(position > first) || creatureAt[position] !== creature) return;
        if (targets !== null && !targets.has(entry.id)) return;
        if ("rule" in effect) {
          const read = ruleRead(effect.condition, effect.rule, position);
          if (read !== 0) reads.set(position, read);
        } else if (side === "attack" ? rollsAttack[position] : savesAt[position]) {
          reads.set(position, modifiers);
        }
      });
      const readers = [...reads.keys()];
      return {
        name: `"${id}" ${label}${creatures.length > 1 ? ` on "${creature}"` : ""}`,
        condition: id,
        creature,
        modifiers,
        reads,
        penalty: "savePenalty" in effect ? effect.savePenalty : undefined,
        side,
        // A grant's own save is no row: it reads what lasts (not a `next-save` effect) and is not scoped with `to`.
        grantSaveReads: side !== "attack" && to === undefined && effect.until !== "next-save",
        saveRead: (ability) =>
          "rule" in effect
            ? ability === undefined
              ? 0
              : maskOf(effect.rule.save?.[ability] ?? [], SAVE_MODIFIERS)
            : modifiers,
        until: effect.until,
        readers,
        first,
        lastRead: readers.length ? readers[readers.length - 1] : -1,
        bit: -1,
      };
    };
    /** An effect's flags: a condition that damage ends brings the one it leaves behind (`onEnd`), lasting the turn. */
    const flagsOf = (effect: WalkEffect, label: string, creature: string, first: number): Flag[] => [
      flagOf(effect, label, creature, first),
      ...("rule" in effect && effect.until === "until-damaged" && effect.rule.onEnd
        ? [
            flagOf(
              { condition: effect.rule.onEnd.condition, rule: effect.rule.onEnd.rule, until: "end-of-turn" },
              `${label} onEnd`,
              creature,
              first
            ),
          ]
        : []),
    ];
    const byCreature = new Map(
      creatures.map((creature) => {
        const at = applyAt.filter((position) => creatureAt[position] === creature);
        const first = start ? -1 : at[0];
        const main = condition.grants.flatMap((grant, grantIndex) => flagsOf(grant, `grant ${grantIndex + 1}`, creature, first));
        const onSave = (condition.onSave ?? []).flatMap((grant, grantIndex) =>
          flagsOf(grant, `onSave grant ${grantIndex + 1}`, creature, first)
        );
        // An application whose grants are all end-of-turn and all in force is skipped,
        // onSave with it. With an onSave to skip, that check reads the grants at every source.
        if (main.length > 0 && main.every((flag) => flag.until === "end-of-turn") && onSave.length > 0) {
          for (const flag of main) flag.lastRead = Math.max(flag.lastRead, at[at.length - 1]);
        }
        return [creature, { main, onSave }] as const;
      })
    );
    const main = [...byCreature.values()].flatMap((flags) => flags.main);
    const onSave = [...byCreature.values()].flatMap((flags) => flags.onSave);
    const lastingOnly = main.length > 0 && main.every((flag) => flag.until === "end-of-turn");
    return { main, onSave, lastingOnly, applyAt, byCreature, start };
  });

  // A grant's own save reads the effects that last on its target and were set before the row
  // that tries it, so those stay live through every row that can try it.
  const allFlags = conditionFlags.flatMap(({ main, onSave }) => [...main, ...onSave]);
  conditions.forEach((condition, index) => {
    const options = saveOptionsOf(condition);
    if (options.length === 0) return;
    for (const position of conditionFlags[index].applyAt) {
      for (const flag of allFlags) {
        if (
          flag.grantSaveReads &&
          flag.creature === creatureAt[position] &&
          flag.first < position &&
          (flag.penalty !== undefined || options.some((option) => flag.saveRead(option.ability) !== 0))
        ) {
          flag.lastRead = Math.max(flag.lastRead, position);
        }
      }
    }
  });

  // A once-per-turn condition (`first-*`) is tried only on a landing where a later row on that
  // landing's creature reads one of its effects: a landing with no reader after it keeps the try
  // for a later one (the engine's rule). With one creature the readers only thin out along the turn,
  // so the first landing decides either way and the condition's group says it; otherwise a bit of
  // its own says it was tried.
  // A rider that may not happen (`happens`): one coin for the turn. A rider that lands once at most
  // has it folded into its payload; one that can land several times keeps the coin as a bit from
  // before the first row to its last landing, so all its landings share it.
  const happensOf = riders.map((rider, index) => {
    const happens = rider.happens ?? 1;
    if (!(happens >= 0 && happens <= 1)) {
      throw new RangeError(`Rider "${riderIds[index]}" needs happens in [0, 1], got ${happens}.`);
    }
    return happens;
  });
  const coinFlags = riders.map((rider, index): Flag | undefined => {
    if (happensOf[index] === 1 || rider.on !== "every-hit") return undefined;
    const watched = new Set(sourceIdsByNode[index]);
    const positions = sequence.flatMap((entry, position) => (watched.has(entry.id) ? [position] : []));
    return {
      name: `"${riderIds[index]}" happens`,
      condition: riderIds[index],
      creature: DEFAULT_CREATURE,
      modifiers: 0,
      reads: new Map(),
      penalty: undefined,
      side: "attack",
      grantSaveReads: false,
      saveRead: () => 0,
      until: "end-of-turn",
      readers: [],
      first: -1,
      lastRead: positions.length === 0 ? -1 : positions[positions.length - 1],
      bit: -1,
    };
  });

  const triedFlags = conditions.map((condition, index): Flag | undefined => {
    if (condition.on !== "first-hit" && condition.on !== "first-crit" && condition.on !== "first-miss") return undefined;
    const { applyAt, byCreature } = conditionFlags[index];
    const follows = applyAt.map((position) => {
      const flags = byCreature.get(creatureAt[position]);
      return [...(flags?.main ?? []), ...(flags?.onSave ?? [])].some((flag) => flag.readers.some((reader) => reader > position));
    });
    // A condition on a rider's landing has no group of the rider's landings to read: it always keeps a bit.
    // Nor does one that needs a damage type dealt: an untyped landing must not spend it.
    if (
      conditionRiders[index] === undefined &&
      condition.dealing === undefined &&
      follows.every((follow, k) => k === 0 || follow <= follows[k - 1])
    ) {
      return undefined;
    }
    const tries = applyAt.filter((_, k) => follows[k]);
    return {
      name: `"${conditionIds[index]}" tried`,
      condition: conditionIds[index],
      creature: DEFAULT_CREATURE,
      modifiers: 0,
      reads: new Map(),
      penalty: undefined,
      side: "attack",
      grantSaveReads: false,
      saveRead: () => 0,
      until: "end-of-turn",
      readers: [],
      first: tries[0],
      lastRead: tries[tries.length - 1],
      bit: -1,
    };
  });
  // A flag lives from its first setter to its last reader. Flags whose lives do not overlap share
  // a bit (the engine's `placeBits`): the walk clears a bit once its flag is dead, so the next
  // flag on it starts clear. A flag nothing reads gets no bit at all: setting it could change nothing.
  const liveFlags = [
    ...conditionFlags.flatMap(({ main, onSave }) => [...main, ...onSave].filter((flag) => flag.lastRead !== -1)),
    ...triedFlags.filter((flag): flag is Flag => flag !== undefined && flag.lastRead > flag.first),
    ...coinFlags.filter((flag): flag is Flag => flag !== undefined && flag.lastRead > flag.first),
  ];
  const busyUntil: number[] = [];
  for (const flag of [...liveFlags].sort((a, b) => a.first - b.first)) {
    let bit = busyUntil.findIndex((last) => last < flag.first);
    if (bit === -1) bit = busyUntil.length;
    busyUntil[bit] = flag.lastRead;
    flag.bit = bit;
  }
  if (busyUntil.length > MAX_FLAG_BITS) {
    fail(
      "too-many-states",
      liveFlags[0].condition,
      `A turn may carry at most ${MAX_FLAG_BITS} effects live at once; this one needs ${busyUntil.length}: ${liveFlags.map((flag) => flag.name).join(", ")}.`
    );
  }
  /** The bits of `flags` still needed once step `step` is done. */
  const liveBitsOf = (flags: readonly Flag[], step: number): number =>
    flags.reduce((mask, flag) => (flag.bit !== -1 && liveAfter(flag, step) ? mask | (1 << flag.bit) : mask), 0);
  const flagLiveAfter = sequence.map((_, step) => liveBitsOf(liveFlags, step));
  /** Per step, the flags it reads with what each puts in force there, in declaration order. */
  const readsAt: { flag: Flag; modifiers: number }[][] = sequence.map(() => []);
  const readMaskAt = new Array<number>(sequence.length).fill(0);
  const consumesAt = new Array<number>(sequence.length).fill(0);
  const hitConsumesAt = new Array<number>(sequence.length).fill(0);
  for (const flag of liveFlags) {
    for (const [reader, modifiers] of flag.reads) {
      readsAt[reader].push({ flag, modifiers });
      readMaskAt[reader] |= 1 << flag.bit;
      if (flag.until === "next-attack" || flag.until === "next-save") consumesAt[reader] |= 1 << flag.bit;
      if (flag.until === "next-hit") hitConsumesAt[reader] |= 1 << flag.bit;
    }
  }
  // Per step, the bits of the conditions that damage ends and that the step finds set: cleared
  // once the step has read them, where it dealt damage.
  const woundsAt = sequence.map((_, step) =>
    liveFlags.reduce(
      (mask, flag) =>
        flag.until === "until-damaged" && flag.creature === creatureAt[step] && flag.first < step && step <= flag.lastRead
          ? mask | (1 << flag.bit)
          : mask,
      0
    )
  );

  // --- group slots -----------------------------------------------------------
  // A group is live from the first step that can advance it to the last step that reads it: the
  // end of the walk for an `every-hit` rider or a probe, which read theirs at the final collapse.
  // Groups whose lives do not overlap share one slot of the walk's per-state group codes, so the
  // cap counts live groups rather than source sets: each beam of a bounce chain dies after its
  // one reader. A slot is reset when its group dies (`Step.releases`), so the next group starts
  // from a group that has seen nothing. A group nothing reads (a grant no later attack reads)
  // gets no slot.
  const groupFirstStep = groupSources.map((sourceIds) => {
    const watched = new Set(sourceIds);
    return sequence.findIndex((entry) => watched.has(entry.id));
  });
  const groupLastStep = new Array<number>(groupSources.length).fill(-1);
  const readAt = (group: number, position: number): void => {
    if (group !== -1) groupLastStep[group] = Math.max(groupLastStep[group], position);
  };
  sequence.forEach((entry, position) => {
    if (entry.rider !== -1) readAt(readsByRider.get(entry.rider) ?? -1, position);
    if (entry.attack !== -1) readAt(gateGroups[entry.attack], position);
  });
  conditions.forEach((_, index) => {
    const { main, onSave, applyAt } = conditionFlags[index];
    if (![...main, ...onSave].some((flag) => flag.bit !== -1)) return;
    // A first-* grant reads its group's pre-draw code at each source step.
    for (const position of applyAt) readAt(conditionGroups[index], position);
  });
  for (const group of [...everyHitGroups.values(), ...probeGroups]) readAt(group, sequence.length);

  const slotOfGroup = new Array<number>(groupSources.length).fill(-1);
  const slotLastStep: number[] = [];
  const slotGroups: number[][] = [];
  const firstStepOf = (group: number): number => Math.min(groupFirstStep[group], groupLastStep[group]);
  groupSources
    .map((_, group) => group)
    .filter((group) => groupLastStep[group] !== -1)
    .sort((a, b) => firstStepOf(a) - firstStepOf(b) || a - b)
    .forEach((group) => {
      // The lowest slot whose group is dead by the time this one first advances. Strictly
      // dead: a step reads its group before it advances another, but the release comes after.
      let slot = slotLastStep.findIndex((last) => last < firstStepOf(group));
      if (slot === -1) {
        if (slotLastStep.length >= MAX_TRIGGER_GROUPS) {
          fail(
            "too-many-groups",
            groupKeys[group],
            `A turn may keep at most ${MAX_TRIGGER_GROUPS} trigger source sets live at once; ${groupKeys[group]} would be the ${MAX_TRIGGER_GROUPS + 1}th.`
          );
        }
        slot = slotLastStep.length;
        slotLastStep.push(-1);
        slotGroups.push([]);
      }
      slotLastStep[slot] = groupLastStep[group];
      slotGroups[slot].push(group);
      slotOfGroup[group] = slot;
    });
  const slotOf = (group: number): number => (group === -1 ? -1 : slotOfGroup[group]);
  const releasesAt: number[][] = sequence.map(() => []);
  slotGroups.forEach((groups, slot) => {
    for (const group of groups.slice(0, -1)) releasesAt[groupLastStep[group]].push(slot);
  });

  /**
   * The chance a condition's grant save fails at step `position`, as a function of the state's
   * flags; undefined without a save. The save reads what lasts the turn on its target and was set
   * before this row (not a `next-save` effect, which belongs to the save rows, nor one scoped with
   * `to`); the target saves with the option it fails least.
   */
  const grantSaveChance = (
    id: string,
    options: readonly GrantSaveSpec[],
    position: number
  ): ((flags: number) => number) | undefined => {
    if (options.length === 0) return undefined;
    const reads = allFlags.filter(
      (flag) =>
        flag.grantSaveReads &&
        flag.bit !== -1 &&
        flag.creature === creatureAt[position] &&
        flag.first < position &&
        position <= flag.lastRead
    );
    const known = new Map<number, number>();
    return (flags) => {
      let key = 0;
      for (const flag of reads) key |= flags & (1 << flag.bit);
      const cached = known.get(key);
      if (cached !== undefined) return cached;
      const read = reads.filter((flag) => (flags & (1 << flag.bit)) !== 0);
      const penaltyDice = read.flatMap((flag) => (flag.penalty ? [flag.penalty] : [])).sort(byDie);
      let fail = 1;
      for (const option of options) {
        // The option's ability decides what the target's conditions do to this save.
        const modifiers = read.reduce((mask, flag) => mask | flag.saveRead(option.ability), 0);
        const context: RowContext = {
          rollType: combineRollType(
            "rollType" in option ? (option.rollType ?? "flat") : "flat",
            false,
            (modifiers & MOD_SAVE_DISADVANTAGE) !== 0,
            false
          ),
          autoHit: false,
          critOnHit: false,
          autoFail: (modifiers & MOD_AUTO_FAIL) !== 0,
          vulnerable: false,
          penaltyDice,
          joined: [],
        };
        // An automatic failure never reaches a `failChance`.
        const chance = context.autoFail
          ? 1
          : "failChance" in option
            ? option.failChance(context)
            : saveFailChance(option.bonus, option.dc, context);
        if (!(chance >= 0 && chance <= 1)) {
          throw new RangeError(`Condition "${id}" has a save whose fail chance is ${chance}, not a probability.`);
        }
        fail = Math.min(fail, chance);
      }
      known.set(key, fail);
      return fail;
    };
  };
  const grantsAt: GrantApplication[][] = sequence.map(() => []);
  conditions.forEach((condition, index) => {
    const { main, onSave, applyAt, byCreature, start } = conditionFlags[index];
    if (start) return;
    const once = condition.on.startsWith("first-");
    const countedInForce = (condition.onSave ?? []).length === 0;
    if (![...main, ...onSave].some((flag) => flag.bit !== -1)) {
      // Nothing reads it: it changes nothing, but a condition that may land again and again is
      // still tried on every landing, as the engine counts it. A once-per-turn one is never tried.
      if (once) return;
      for (const position of applyAt) {
        grantsAt[position].push({
          condition: index,
          on: condition.on as Exclude<ConditionSpec["on"], "start">,
          reads: -1,
          landing: condition.landing,
          chance: condition.chance ?? 1,
          chanceOf: grantSaveChance(conditionIds[index], saveOptionsOf(condition), position),
          grants: 0,
          onSave: 0,
          inForce: 0,
          effective: false,
          tried: 0,
          rider: conditionRiders[index],
          dealing: condition.dealing !== undefined,
          counted: true,
          countedInForce,
          countOnly: true,
        });
      }
      return;
    }
    const tried = triedFlags[index];
    // A condition tried at one row only needs no bit that lives: one above the flag word, set and dropped.
    const triedBit = tried === undefined ? 0 : tried.bit !== -1 ? 1 << tried.bit : 1 << MAX_FLAG_BITS;
    for (const position of applyAt) {
      // The flags on the creature this source is aimed at.
      const flags = byCreature.get(creatureAt[position]) as { main: Flag[]; onSave: Flag[] };
      const held = flags.main.filter((flag) => flag.bit !== -1);
      const lastingOnly = flags.main.length > 0 && flags.main.every((flag) => flag.until === "end-of-turn");
      // Only bits still needed after this step are set: a dead flag's bit may be another's by then.
      const grants = liveBitsOf(flags.main, position);
      // In force: every held grant was set before this step and is still read, so its bit is its own.
      const inForce =
        lastingOnly && held.length > 0 && held.every((flag) => flag.first < position && position <= flag.lastRead)
          ? held.reduce((mask, flag) => mask | (1 << flag.bit), 0)
          : 0;
      const follows = [...flags.main, ...flags.onSave].some((flag) => flag.readers.some((reader) => reader > position));
      // A once-per-turn condition puts nothing in force where no later row reads it (the engine's
      // `readerFollows`): a later condition's save alone does not make it worth trying.
      const puts = !once || follows;
      grantsAt[position].push({
        condition: index,
        on: condition.on as Exclude<ConditionSpec["on"], "start">,
        reads: slotOf(conditionGroups[index]),
        landing: condition.landing,
        chance: condition.chance ?? 1,
        chanceOf: grantSaveChance(conditionIds[index], saveOptionsOf(condition), position),
        grants: puts ? grants : 0,
        onSave: puts ? liveBitsOf(flags.onSave, position) : 0,
        inForce,
        effective: flags.main.some((flag) => flag.readers.some((reader) => reader > position)),
        tried: tried === undefined ? 0 : follows ? triedBit : -1,
        rider: conditionRiders[index],
        dealing: condition.dealing !== undefined,
        counted: !once || follows,
        countedInForce,
        countOnly: false,
      });
    }
  });

  // --- per-hit fold ----------------------------------------------------------
  // `every-hit` riders are not steps: they are convolved into each source's own
  // hit/crit slices, so one hit means one application with no extra state.
  //
  // A capped rider (`max`) is folded the same way but only into a source step's
  // WITH-rider variants. Every source step it watches carries a variant with the rider
  // and one without, and `Step.select` picks the with-rider one while the rider's
  // counter is below `max`; a hit or crit drawn from it advances the counter. Riders
  // with the same sources and the same `max` share one counter, since they apply on
  // exactly the same landings. The walk state holds one count per counter.
  interface HitPayload {
    /** Index into `everyHitIds`, or -1 for a first-hit rider. */
    rider: number;
    /** The rider's id. */
    id: string;
    /** The fire slot a first-hit rider marks when it applies, or -1. */
    slot: number;
    /** The rider's counter's bit in a source's variant mask, or 0 when uncapped. */
    bit: number;
    /** How the rider reads a save row among its sources (see {@link SaveLanding}); `any` lands on every outcome. */
    landing: SaveLanding | "any" | undefined;
    /** Lands on crits only (a folded `any-crit` rider). */
    critOnly: boolean;
    hit: PMF;
    crit: PMF;
    /** Its payloads where the row's hit used up a vulnerability: doubled with the attack. */
    vulnerable: () => { hit: PMF; crit: PMF };
    /** The bit of a source's variant mask that says its coin (`happens`) came up, or 0 when it has none. */
    coinBit: number;
    /** On a row a partner opens to it: the partners, one of which must land in the same draw. */
    partners: readonly string[];
    /** P(its payload on this row deals `type`), as a plain hit and as a crit; for a `dealing` condition. */
    typedOdds: ((type: string) => { hit: number; crit: number }) | undefined;
  }
  const everyHitIds = riderIds.filter((_, index) => riders[index].on === "every-hit");
  const counterMax: number[] = [];
  /** Per counter, the landing kind its riders read a save row under; undefined when no source is a save row. */
  const counterLanding: (SaveLanding | "any" | undefined)[] = [];
  /** Per counter, whether its riders land on crits only. */
  const counterCritOnly: boolean[] = [];
  /** Per counter, whether its riders land only where an attack row dealt damage (`landing: "damage"`). */
  const counterDealt: boolean[] = [];
  /** Per counter, whether its riders land alongside a partner on some row. */
  const counterPartnered: boolean[] = [];
  const counterIdByKey = new Map<string, number>();
  const perHitBySource = new Map<string, HitPayload[]>();
  /**
   * Per source, the distinct counters that watch it, in payload order: bit i of a variant mask
   * says whether counter i's riders apply in that variant.
   */
  const countersBySource = new Map<string, number[]>();
  const payloadOf = (payload: RiderPayload, id: string): Pick<HitPayload, "hit" | "crit" | "vulnerable"> => {
    const hit = toPMF(payload.damage, eps, id);
    const crit = critPMF(payload, hit, eps);
    let doubled: { hit: PMF; crit: PMF } | undefined;
    // A plain payload doubles with the attack it lands on, as the whole roll does.
    const vulnerable = () => (doubled ??= { hit: hit.mapDamage((d) => 2 * d), crit: crit.mapDamage((d) => 2 * d) });
    return { hit, crit, vulnerable };
  };
  /** `pmf` dealt with probability `happens`, else nothing: one landing of a rider that may not happen. */
  const thin = (pmf: PMF, happens: number): PMF =>
    happens === 1 ? pmf : pmf.scaleMass(happens).add(PMF.delta(0, eps).scaleMass(1 - happens));
  /** Per source, the coins (rider indexes) whose riders fold into it, in payload order. */
  const coinsBySource = new Map<string, number[]>();
  for (const node of order) {
    if (node >= riderCount) continue;
    const rider = riders[node];
    if (rider.on !== "every-hit" && !isFirstHitFold(rider)) continue;
    const id = riderIds[node];
    const sources = sourceIdsByNode[node];
    const own = new Map(Object.entries(perSourceOf(rider) ?? {}));
    for (const key of own.keys()) {
      if (!sources.includes(key)) {
        fail(
          "unknown-id",
          key,
          `Rider "${id}" has a payload for "${key}", which it does not watch. Watched: ${sources.map((each) => `"${each}"`).join(", ")}.`
        );
      }
    }
    // A capped rider, or one with a payload per source, is folded into its sources' draws (a
    // per-source first hit always is). A rider that rolls its own attack needs its own step:
    // grants, step statistics and the crit check live there, and a fold skips all three. A
    // plain every-hit rider keeps folding whatever it rolls, as it always has.
    const folded =
      rider.on === "first-hit" || (rider.on === "every-hit" && rider.max !== undefined) || own.size > 0;
    if (folded) {
      const payloads: [string, RiderDamage | undefined][] = [
        ["its damage", rider.damage],
        ["its critDamage", rider.critDamage],
        ...[...own].flatMap(([sourceId, payload]): [string, RiderDamage | undefined][] => [
          [`its payload for "${sourceId}"`, payload.damage],
          [`its critDamage for "${sourceId}"`, payload.critDamage],
        ]),
      ];
      for (const [name, damage] of payloads) {
        if (damage === undefined) continue;
        const parts = Array.isArray(damage) ? damage : [damage as Damage];
        if (attackPartCount(parts, eps, id) > 0) {
          const kind = rider.on === "first-hit" ? "a payload per source" : "a cap or a payload per source";
          fail(
            "unsupported-trigger",
            id,
            `Rider "${id}" has ${kind} and ${name} rolls an attack. Such a rider is folded into its attacks' draws, which skips granted modifiers, step statistics and the critDamage check. Declare the attack as a plain onFirstHit rider instead.`
          );
        }
      }
    }
    let shared: Pick<HitPayload, "hit" | "crit" | "vulnerable"> | undefined;
    const contextual = contextualPayloads.get(node);
    const ownRows = partnersOf[node].length === 0 ? sources : ownSourcesOf(rider, node);
    let counter = -1;
    // The cap: an every-hit rider's `max`, or 1 for a first-hit rider (a `max: 1` every-hit rider
    // was lowered to one, so a folded first-hit rider is the per-source spelling of it).
    const cap = rider.on === "every-hit" ? rider.max : 1;
    // A cap at or above the number of watched steps never binds: the count before any watched
    // step is below that number, so every step draws with the rider. It is folded like an
    // uncapped rider, which is what makes `max: n` over n attacks `onEveryHit` bit for bit.
    const watched = new Set(sources);
    const watchCount = sequence.filter((entry) => watched.has(entry.id)).length;
    if (cap !== undefined && cap < watchCount) {
      // A cap counts landings in turn order. An `any-miss` reroll resolves after every declared
      // attack, so it would be counted at the end of the turn instead of where it happens.
      const late = sources.find((sourceId) => {
        const riderIndex = riderIndexById.get(sourceId);
        return riderIndex !== undefined && riders[riderIndex].on === "any-miss";
      });
      if (late !== undefined) {
        fail(
          "unsupported-trigger",
          id,
          `Rider "${id}" ${rider.on === "every-hit" ? "is capped" : "has a payload per source"} and watches "${late}", an any-miss reroll. An any-miss rider resolves after every declared attack, so the cap would count its landing at the end of the turn instead of right after the miss. Use onFirstMiss (on: "first-miss"), which resolves directly after the attack that missed.`
        );
      }
      // Riders share a counter only when they land on the same rows: over a save row, on the same
      // classes of it, so the landing kind is part of the key there.
      const kind =
        rider.landing === "any" ? "any" : rider.landing !== undefined && sources.some(isSaveRow) ? rider.landing : undefined;
      const dealtOnly = rider.landing === "damage" && sources.some((sourceId) => dealtSources.has(sourceId));
      const key = JSON.stringify([
        [...sources].sort(),
        cap,
        kind ?? null,
        ...(critOnly.has(node) ? ["crit"] : []),
        ...(dealtOnly ? ["dealt"] : []),
        ...(partnersOf[node].length > 0 ? [riderIds[node]] : []),
      ]);
      let known = counterIdByKey.get(key);
      if (known === undefined) {
        known = counterMax.push(cap) - 1;
        counterLanding.push(kind);
        counterCritOnly.push(critOnly.has(node));
        counterDealt.push(dealtOnly);
        counterPartnered.push(partnersOf[node].length > 0);
        counterIdByKey.set(key, known);
      }
      counter = known;
    }
    const applyIndex = everyHitIds.indexOf(id);
    const slot = rider.on === "first-hit" ? (fireSlots.get(id) as number) : -1;
    for (const sourceId of sources) {
      const each = own.get(sourceId);
      const landing = contextual?.at(sourceId);
      const payload = landing
        ? { hit: landing.onHit, crit: landing.onCrit, vulnerable: () => ({ hit: landing.vulnerable.onHit, crit: landing.vulnerable.onCrit }) }
        : each
          ? payloadOf(each, id)
          : (shared ??= payloadOf(rider, id));
      let bit = 0;
      if (counter !== -1) {
        const counters = countersBySource.get(sourceId) ?? [];
        let local = counters.indexOf(counter);
        if (local === -1) {
          local = counters.length;
          counters.push(counter);
          countersBySource.set(sourceId, counters);
        }
        bit = 1 << local;
      }
      // A rider that lands once at most takes its coin in its payload; one with a coin bit, in its variant.
      const coined = coinFlags[node] !== undefined && coinFlags[node].bit !== -1;
      const happens = coined ? 1 : happensOf[node];
      const thinned =
        happens === 1
          ? payload
          : {
              hit: thin(payload.hit, happens),
              crit: thin(payload.crit, happens),
              vulnerable: () => {
                const doubled = payload.vulnerable();
                return { hit: thin(doubled.hit, happens), crit: thin(doubled.crit, happens) };
              },
            };
      if (coined) {
        const coins = coinsBySource.get(sourceId) ?? [];
        coins.push(node);
        coinsBySource.set(sourceId, coins);
      }
      const entry = {
        rider: applyIndex,
        id,
        slot,
        bit,
        landing: rider.landing,
        critOnly: critOnly.has(node),
        coinBit: coined ? -1 : 0,
        // A row of its own it lands on for its trigger; a row only a partner opens, alongside that partner.
        partners: ownRows.includes(sourceId) ? [] : (openedBy[node].get(sourceId) ?? []),
        typedOdds:
          contextual?.dealt === undefined
            ? undefined
            : (type: string) => {
                const odds = (contextual.dealt as NonNullable<ContextualPayload["dealt"]>)(type, sourceId);
                return { hit: odds.hit * happens, crit: odds.crit * happens };
              },
        ...thinned,
      };
      const existing = perHitBySource.get(sourceId);
      if (existing) existing.push(entry);
      else perHitBySource.set(sourceId, [entry]);
    }
  }
  // A coin's bit in a source's variant mask comes after its counters' bits.
  for (const [sourceId, coins] of coinsBySource) {
    const base = (countersBySource.get(sourceId) ?? []).length;
    for (const payload of perHitBySource.get(sourceId) ?? []) {
      if (payload.coinBit === -1) payload.coinBit = 1 << (base + coins.indexOf(riderIndexById.get(payload.id) as number));
    }
  }
  for (const [sourceId, counters] of countersBySource) {
    if (counters.length > MAX_CAPPED_COUNTERS) {
      fail(
        "too-many-counters",
        sourceId,
        `"${sourceId}" is watched by ${counters.length} capped every-hit riders with different caps or sources; a turn may have at most ${MAX_CAPPED_COUNTERS} per attack. Each doubles the draws that attack carries.`
      );
    }
  }
  /**
   * `slice` with the every-hit riders of variant `mask` folded in: every uncapped one, and each
   * capped one whose bit is set; with the own part and the riders' payloads when any is folded.
   */
  /**
   * The payloads of `sourceId` that land on a draw of `outcome` from variant `mask`: within their
   * cap, on a crit for a crit-only rider, where damage was dealt for a `damage` rider, on a miss only
   * for an `any` rider, and on a row a partner opens only where that partner lands too. With
   * `coins`, a rider whose coin did not come up is left out (it lands, but deals nothing).
   */
  const activeAt = (
    sourceId: string,
    mask: number,
    outcome: "hit" | "crit" | "miss",
    dealt: boolean | undefined,
    coins: boolean
  ): HitPayload[] => {
    const lands = (perHitBySource.get(sourceId) ?? []).filter(
      (payload) =>
        (payload.bit === 0 || (mask & payload.bit) !== 0) &&
        (!payload.critOnly || outcome === "crit") &&
        // "When you deal damage": a hit that dealt nothing is no landing for it.
        !(dealt === false && payload.landing === "damage") &&
        (outcome !== "miss" || (payload.landing === "any" && !payload.critOnly))
    );
    const landed = new Set(lands.filter((payload) => payload.partners.length === 0).map((payload) => payload.id));
    return lands.filter(
      (payload) =>
        (payload.partners.length === 0 || payload.partners.some((partner) => landed.has(partner))) &&
        (!coins || payload.coinBit === 0 || (mask & payload.coinBit) !== 0)
    );
  };
  /**
   * `slice` with the riders that land on it folded in (see {@link activeAt}); with the own part and
   * the riders' payloads when any is folded.
   */
  /** Per builder, its re-derivation under each modifier key (see the step's `rederive`). */
  const rederivedBuilders = new Map<unknown, Map<number, { pmf: () => PMF; signature: string }>>();
  /** Per source, its PMF under each context signature (see the step's `rederive`). */
  const pmfsUnder = new Map<unknown, Map<string, PMF>>();
  /** Folds already made: several rows fold the same payload into the same slice. */
  const foldsMade = new WeakMap<PMF, WeakMap<PMF, PMF>>();
  const fold = (
    sourceId: string,
    outcome: "hit" | "crit" | "miss",
    slice: PMF,
    mask: number,
    vulnerable = false,
    dealt?: boolean,
    joined: readonly string[] = []
  ): Pick<Draw, "slice" | "own" | "riders"> => {
    let folded = slice;
    const parts: [string, PMF][] = [];
    for (const payload of activeAt(sourceId, mask, outcome, dealt, true)) {
      // A rider that lands on anything is no part of the attack's damage: its plain payload, never doubled.
      const any = payload.landing === "any" && !payload.critOnly;
      // A rider whose dice joined the row's roll (`joins`) deals nothing beside it there; its landing still counts.
      const paid = joined.includes(payload.id)
        ? PMF.delta(0, eps)
        : any
          ? payload.hit
          : vulnerable
            ? payload.vulnerable()[outcome as "hit" | "crit"]
            : payload[outcome as "hit" | "crit"];
      if (folds === "joint") {
        let byPaid = foldsMade.get(folded);
        if (byPaid === undefined) foldsMade.set(folded, (byPaid = new WeakMap()));
        let next = byPaid.get(paid);
        if (next === undefined) byPaid.set(paid, (next = folded.convolve(paid, eps, true)));
        folded = next;
      } else {
        const paidMass = paid.mass();
        if (paidMass !== 1) folded = folded.scaleMass(paidMass);
      }
      parts.push([payload.id, paid]);
    }
    return parts.length === 0 ? { slice: folded } : { slice: folded, own: slice, riders: parts };
  };
  /** What a draw of `outcome` from variant `mask` of `sourceId` applies, counts and marks as fired. */
  const landingOf = (
    sourceId: string,
    mask: number,
    outcome: "hit" | "crit" | "miss",
    dealt?: boolean
  ): { applies: number[]; bumps: number[]; fires: number[] } => {
    const active = activeAt(sourceId, mask, outcome, dealt, false);
    return {
      applies: active.flatMap((payload) => (payload.rider === -1 ? [] : [payload.rider])),
      bumps: (countersBySource.get(sourceId) ?? []).filter(
        (counter, local) =>
          (mask & (1 << local)) !== 0 &&
          (!counterCritOnly[counter] || outcome === "crit") &&
          !(dealt === false && counterDealt[counter]) &&
          (outcome !== "miss" || (counterLanding[counter] === "any" && !counterCritOnly[counter])) &&
          // A counter of a rider a partner gates here counts only where it landed.
          (!counterPartnered[counter] || active.some((payload) => payload.bit === 1 << local))
      ),
      fires: active.flatMap((payload) => (payload.slot === -1 ? [] : [payload.slot])),
    };
  };

  /**
   * `draws` of a hit or crit of `sourceId`, split by whether the landing dealt the `dealing` type:
   * the row's own odds in its context (within a part that dealt damage, scaled to it), or a rider's
   * that landed with it, each independent. The split is by odds alone: exact for every marginal.
   */
  const typedSplit = (
    sourceId: string,
    outcome: "hit" | "crit",
    draws: Draw[],
    rowContext: RowContext | undefined
  ): Draw[] => {
    const type = dealingType as string;
    const source = damageOf(sourceId);
    const dealt = isContextual(source) ? source.dealt : undefined;
    if (rowContext === undefined || dealt === undefined) {
      fail(
        "not-an-attack",
        sourceId,
        `"${sourceId}" is read by a condition that needs ${type} damage dealt, but its source cannot say the odds it deals it (ContextualSource.dealt).`
      );
    }
    const rowOdds = (dealt as NonNullable<ContextualSource["dealt"]>).call(source, type, rowContext as RowContext)[outcome];
    const whole = draws.reduce((sum, draw) => sum + (draw.own ?? draw.slice).mass(), 0);
    const dealtMass = draws.reduce((sum, draw) => sum + (draw.byKind === NOT_DEALT[outcome] ? 0 : (draw.own ?? draw.slice).mass()), 0);
    return draws.flatMap((draw) => {
      // Typed damage above 0 is damage dealt: a part that dealt none is typed only by a rider.
      const own = draw.byKind === NOT_DEALT[outcome] ? 0 : Math.min(1, dealtMass > 0 ? (rowOdds * whole) / dealtMass : 0);
      let untyped = 1 - own;
      for (const [id] of draw.riders ?? []) {
        const payload = (perHitBySource.get(sourceId) ?? []).find((each) => each.id === id);
        if (payload === undefined || payload.landing === "any") continue;
        if (payload.typedOdds === undefined) {
          fail(
            "not-an-attack",
            id,
            `Rider "${id}" lands on "${sourceId}", which a condition needing ${type} damage reads, but it cannot say the odds it deals it (ContextualPayload.dealt).`
          );
        }
        untyped *= 1 - (payload.typedOdds as NonNullable<HitPayload["typedOdds"]>)(type)[outcome];
      }
      const typed = 1 - untyped;
      return [
        ...(typed > 0 ? [{ ...scaleDraw(draw, typed), typed: true }] : []),
        ...(untyped > 0 ? [{ ...scaleDraw(draw, untyped), typed: false }] : []),
      ];
    });
  };

  // --- draws -----------------------------------------------------------------
  const matchNeeded = new Set<string>();
  riders.forEach((rider, index) => {
    if (rider.on === "dice-match") for (const id of sourceIdsByNode[index]) matchNeeded.add(id);
  });

  const basePayloads = new Map<string, BasePayload>();
  const basePayload = (sourceId: string): BasePayload => {
    let payload = basePayloads.get(sourceId);
    if (!payload) {
      payload = basePayloadOf(damageOf(sourceId), eps);
      basePayloads.set(sourceId, payload);
    }
    return payload;
  };

  /**
   * The draws for `sourceId`: hit and crit, each split by exact match probability
   * when a `dice-match` trigger reads it, and into spend/hold parts under a
   * substitute's `policy`; then the separate channels; then the `every-hit` fold
   * (the capped riders selected by `mask`, see {@link fold}); then miss. Every split
   * happens on the base payload, so neither the match odds nor the transform ever
   * see a separate channel's or the fold's dice.
   *
   * `fixed` draws belong to every variant. Each of `choices` is an above-threshold
   * landing that is held or spent depending on the walk state, so a variant takes
   * either its `hold` or its `spend` draws.
   */
  const drawsFor = (
    sourceId: string,
    slices: SourceSlices,
    policy: SubstitutePolicy | null,
    mask: number,
    vulnerable = false,
    joined: readonly string[] = [],
    rowContext?: RowContext
  ): { fixed: Draw[]; choices: HoldChoice[] } => {
    const match = matchNeeded.has(sourceId) ? matchInfoOf(sourceId) : null;
    // With neither split, the slices already carry the channels — draw them as they are.
    const payload = policy || match ? basePayload(sourceId) : null;
    const fixed: Draw[] = [];
    const choices: HoldChoice[] = [];
    for (const outcome of ["hit", "crit"] as const) {
      const slice = slices[outcome];
      const mass = slice.mass();
      const separate = payload?.separate?.[outcome];
      // The base payload as an outcome-labelled slice of this outcome's mass.
      const base =
        payload?.base && mass > 0
          ? Mixture.mix([[outcome, payload.base[outcome], 1]], eps).scaleMass(mass)
          : slice;
      const info = match?.[outcome] ?? null;
      const own = (part: PMF): PMF => (separate ? part.convolve(separate, eps, true) : part);
      /** `part` as draws: one, or, for a row a `damage` condition reads, split by whether its own damage was above 0. */
      const draw = (part: PMF, matched: boolean, spends: boolean): Draw[] =>
        dealingSources.has(sourceId) ? typedSplit(sourceId, outcome, plainDraw(part, matched, spends), rowContext) : plainDraw(part, matched, spends);
      const plainDraw = (part: PMF, matched: boolean, spends: boolean): Draw[] => {
        if (!dealtSources.has(sourceId)) {
          return [
            {
              outcome,
              matched,
              spends,
              ...landingOf(sourceId, mask, outcome),
              ...fold(sourceId, outcome, own(part), mask, vulnerable, undefined, joined),
            },
          ];
        }
        const whole = own(part);
        const [dealt, none] = whole.splitByFactor((damage) => (damage > 0 ? 1 : 0));
        // A part that is all of it stays the very PMF.
        const pieces: [PMF, boolean][] =
          none.mass() <= 0 ? [[whole, true]] : dealt.mass() <= 0 ? [[whole, false]] : [[dealt, true], [none, false]];
        return pieces.map(([piece, isDealt]) => ({
          outcome,
          matched,
          spends,
          ...landingOf(sourceId, mask, outcome, isDealt),
          ...fold(sourceId, outcome, piece, mask, vulnerable, isDealt, joined),
          byKind: isDealt ? DEALT[outcome] : NOT_DEALT[outcome],
        }));
      };
      /** `part`'s draws: split by match odds on its value, unless its dice's match status is `known`. */
      const drawsOf = (part: PMF, spends: boolean, known?: boolean): Draw[] => {
        if (!info || known !== undefined) return draw(part, known ?? false, spends);
        const [matched, unmatched] = part.splitByFactor(
          (damage) => info.matchProbabilityByDamage.get(damage) ?? 0
        );
        return [...draw(matched, true, spends), ...draw(unmatched, false, spends)];
      };

      if (!policy || mass <= 0) {
        fixed.push(...drawsOf(base, false));
        continue;
      }
      if (policy.kind !== "below") {
        fixed.push(...drawsOf(base.maxOfTwo(), true));
        continue;
      }
      // The threshold reads the base payload total as it stands — dice plus the
      // payload's own flat bonus — so each mode splits on its own values.
      const threshold = policy[outcome];
      const [below, above] = base.splitByFactor((value) => (value < threshold ? 1 : 0));
      if (below.mass() > 0) {
        const { kept, beaten } = keepBetterOfFresh(below, base);
        fixed.push(...drawsOf(kept.add(beaten), true));
      }
      // Holding keeps these very dice, so with match odds in play their match
      // status is part of what a later step can still do with them.
      const heldParts: [boolean, PMF][] = info
        ? above
            .splitByFactor((damage) => info.matchProbabilityByDamage.get(damage) ?? 0)
            .map((part, index): [boolean, PMF] => [index === 0, part])
        : [[false, above]];
      for (const [matched, part] of heldParts) {
        if (part.mass() <= 0) continue;
        const { kept, beaten } = keepBetterOfFresh(part, base);
        choices.push({
          outcome,
          matched,
          hold: drawsOf(part, false, matched),
          spend: info
            ? [...drawsOf(kept, true, matched), ...drawsOf(beaten, true)]
            : drawsOf(kept.add(beaten), true, false),
        });
      }
    }
    // A miss lands the riders that land on anything; the rest it lands nothing.
    if ((perHitBySource.get(sourceId) ?? []).some((payload) => payload.landing === "any" && !payload.critOnly)) {
      fixed.push({
        outcome: "miss",
        matched: false,
        spends: false,
        ...landingOf(sourceId, mask, "miss"),
        ...fold(sourceId, "miss", slices.miss, mask, false, undefined, joined),
      });
    } else {
      fixed.push({ outcome: "miss", matched: false, spends: false, applies: [], bumps: [], fires: [], slice: slices.miss });
    }
    return { fixed, choices };
  };

  // --- steps -----------------------------------------------------------------
  const updatesById = new Map<string, { slots: number[]; kinds: (SaveLanding | null)[] }>();
  groupSources.forEach((sourceIds, group) => {
    const slot = slotOfGroup[group];
    if (slot === -1) return;
    for (const sourceId of sourceIds) {
      const existing = updatesById.get(sourceId) ?? { slots: [], kinds: [] };
      updatesById.set(sourceId, existing);
      existing.slots.push(slot);
      existing.kinds.push(isSaveRow(sourceId) || dealtSources.has(sourceId) ? groupLandings[group] : null);
    }
  });

  const steps: Step[] = [];
  /**
   * `fired` after `sourceId` lands: a first-hit rider with a payload per source is folded into its
   * sources' draws, so it is not a step and marks its fire slot only there. The look-ahead reads
   * the plain variant, which does not carry it, so it applies the slots itself: one that is still
   * empty is the first landing among that rider's sources.
   */
  const withFolded = (fired: readonly FireMode[], sourceId: string, draw?: Draw): readonly FireMode[] => {
    // A draw that is no landing marks nothing. A save row's draws are all "hit" and say whether they
    // land per landing kind, so each rider reads its own kind there.
    if (draw !== undefined && draw.byKind === undefined && draw.outcome !== "hit" && draw.outcome !== "crit") {
      return fired;
    }
    let marked: FireMode[] | null = null;
    for (const payload of perHitBySource.get(sourceId) ?? []) {
      if (payload.slot === -1 || (marked ?? fired)[payload.slot] !== null) continue;
      if (draw?.byKind !== undefined && payload.landing !== "any" && draw.byKind[payload.landing ?? "fail"] !== "hit") continue;
      marked ??= [...fired];
      marked[payload.slot] = "hit";
    }
    return marked ?? fired;
  };
  /**
   * A watched save row's draws, one per class (see {@link SaveClasses}): every class carries what
   * it is to a rider reading the row under each kind, and the `every-hit` riders that land on it
   * under their own kind are folded in. Every class keeps the `outcome` a row nobody watches has,
   * a hit, so the row's own statistics do not depend on which riders read it.
   */
  const saveRowDraws = (sourceId: string, mask: number, classes: SaveClasses = classesOf(sourceId)): Draw[] =>
    classes.map((slice, index) => {
      // The riders that apply on this class: every uncapped one, and each capped one whose bit is
      // set in `mask`, and only where the class lands under the rider's own kind.
      const active = (perHitBySource.get(sourceId) ?? []).filter(
        (payload) =>
          (payload.bit === 0 || (mask & payload.bit) !== 0) &&
          (payload.coinBit === 0 || (mask & payload.coinBit) !== 0) &&
          !payload.critOnly &&
          (payload.landing === "any" || CLASS_LANDS[index][payload.landing ?? "fail"])
      );
      let folded = slice;
      const parts: [string, PMF][] = active.map((payload) => [payload.id, payload.hit]);
      for (const payload of active) folded = folded.convolve(payload.hit, eps, true);
      return {
        outcome: "hit",
        matched: false,
        spends: false,
        applies: active.flatMap((payload) => (payload.rider === -1 ? [] : [payload.rider])),
        // A counter counts the landings of its riders: the classes that land under its kind.
        bumps: (countersBySource.get(sourceId) ?? []).filter(
          (counter, local) =>
            (mask & (1 << local)) !== 0 &&
            !counterCritOnly[counter] &&
            (counterLanding[counter] === "any" || CLASS_LANDS[index][(counterLanding[counter] as SaveLanding | undefined) ?? "fail"])
        ),
        fires: active.flatMap((payload) => (payload.slot === -1 ? [] : [payload.slot])),
        slice: folded,
        ...(parts.length === 0 ? {} : { own: slice, riders: parts }),
        byKind: CLASS_OUTCOMES[index],
      };
    });

  /**
   * Per substitute: can a step it watches still land, from step `from` on, in the
   * state (`codes`, `fired`)? Exact reachability over the walk's own transitions —
   * every positive-mass draw of each later step's plain variant — memoized on the
   * state. It reads the same group codes and fire slots the walk keys on, so a
   * threshold never holds for a watched step that can no longer fire.
   */
  const laterLandings = substitutes.map((_, substitute) => {
    const watched = new Set(sourceIdsByNode[riderCount + substitute]);
    let lastWatched = -1;
    sequence.forEach((entry, stepIndex) => {
      if (watched.has(entry.id)) lastWatched = stepIndex;
    });
    const memo = new Map<string, boolean>();
    const canLand = (from: number, codes: readonly number[], fired: readonly FireMode[]): boolean => {
      if (from > lastWatched) return false;
      const key = `${from}|${codes.join(",")}|${fired.map((mode) => (mode === null ? "-" : "+")).join("")}`;
      const known = memo.get(key);
      if (known !== undefined) return known;
      const step = steps[from];
      const mode = fireMode(step, codes, fired);
      let result: boolean;
      if (mode === null) {
        result = canLand(from + 1, released(codes, step.releases), fired);
      } else {
        const next = step.slot === -1 ? fired : fired.map((slot, index) => (index === step.slot ? mode : slot));
        result =
          step.variants.length === 0
            ? canLand(from + 1, released(codes, step.releases), next)
            : step.variants[0].some(
                (draw) =>
                  draw.slice.mass() > eps &&
                  (((draw.outcome === "hit" || draw.outcome === "crit") && watched.has(step.id)) ||
                    canLand(
                      from + 1,
                      released(
                        advanced(codes, step.updates, step.updateKinds, draw.outcome, draw.matched, draw.byKind),
                        step.releases
                      ),
                      withFolded(next, step.id, draw)
                    ))
              );
      }
      memo.set(key, result);
      return result;
    };
    return canLand;
  });

  const plainSelect = (): number => 0;
  /** Per counter, the sequence positions of the steps that watch it. */
  const watchPositions: number[][] = counterMax.map(() => []);
  sequence.forEach((entry, position) => {
    for (const counter of countersBySource.get(entry.id) ?? []) watchPositions[counter].push(position);
  });
  sequence.forEach((entry, stepIndex) => {
    const rider = entry.rider === -1 ? null : riders[entry.rider];
    const slices =
      entry.attack !== -1
        ? (attackSlices[entry.attack] ??
          {
            hit: attackPMFs[entry.attack],
            crit: PMF.emptyMass(),
            miss: PMF.emptyMass(),
          })
        : slicesOf(entry.id);

    if (rider && (slices || attackLists[entry.rider]) && rider.critDamage !== undefined) {
      // An attack-shaped rider rolls its own d20 and crits on its own terms —
      // a bonus attack triggered by a crit does not deal doubled dice — so
      // there is nothing for `critDamage` to mean. Silently dropping it would
      // hide a real misunderstanding.
      fail(
        "unused-crit-damage",
        entry.id,
        `Rider "${entry.id}" rolls its own attack, so its critDamage would never be used. Remove it, or pass plain damage dice instead.`
      );
    }

    const readMask = readMaskAt[stepIndex];
    let readAdvantage = 0;
    let readDisadvantage = 0;
    let readCritOnHit = 0;
    for (const { flag, modifiers } of readsAt[stepIndex]) {
      if (modifiers & MOD_ADVANTAGE) readAdvantage |= 1 << flag.bit;
      if (modifiers & MOD_DISADVANTAGE) readDisadvantage |= 1 << flag.bit;
      if (modifiers & MOD_CRIT_ON_HIT) readCritOnHit |= 1 << flag.bit;
    }
    if (rider?.on === "any-miss" && slices) {
      // Its step runs after every declared attack, but in play the reroll happens right
      // after the miss: it would read, or grant to, the wrong attack rolls.
      const grantSource = conditionSources.some((sources) => sources.includes(entry.id));
      if (readMask !== 0 || grantSource) {
        fail(
          "unsupported-trigger",
          entry.id,
          `Rider "${entry.id}" rerolls on any miss and ${readMask !== 0 ? "reads a granted modifier" : "applies a condition's grants"}. An any-miss rider resolves after every declared attack, so it would see the grants in force at the end of the turn instead of right after the miss. Use onFirstMiss (on: "first-miss"), which resolves directly after the attack that missed.`
        );
      }
    }

    const { slots: updates, kinds: updateKinds } = updatesById.get(entry.id) ?? { slots: [], kinds: [] };
    const watchedKinds = entry.attack !== -1 ? landingKinds.get(entry.id) : undefined;
    let variants: StepVariant[] = [];
    let select: Step["select"] = plainSelect;
    const substitute = slices ? substituteBySource.get(entry.id) : undefined;
    const spendSlot =
      substitute === undefined ? -1 : (fireSlots.get(substituteIds[substitute]) as number);

    /** The distinct capped counters watching this step's source: bit i of a cap mask is `capped[i]`'s with-rider flag. */
    const capped = countersBySource.get(entry.id) ?? [];
    /** The coins of the riders folded here: bit `capped.length + k` of a variant mask says coin k came up. */
    const coined = coinsBySource.get(entry.id) ?? [];

    /**
     * The plain draws and, under a substitute, one variant per hold mask (variant 1 +
     * mask: bit i set ⇔ choice i is held; only a threshold policy has choices), for
     * one roll context's slices, with the capped riders of `cap` folded in.
     */
    const tableAt = (
      contextSlices: SourceSlices,
      cap: number,
      vulnerable: boolean,
      joined: readonly string[],
      rowContext: RowContext | undefined
    ): { variants: StepVariant[]; select: Step["select"] } => {
      const plain = drawsFor(entry.id, contextSlices, null, cap, vulnerable, joined, rowContext).fixed;
      if (substitute === undefined) return { variants: [plain], select: plainSelect };
      const { fixed, choices } = drawsFor(
        entry.id,
        contextSlices,
        substitutes[substitute].policy ?? { kind: "always" },
        cap,
        vulnerable,
        joined,
        rowContext
      );
      const own: StepVariant[] = [plain];
      for (let mask = 0; mask < 1 << choices.length; mask++) {
        own.push(
          mergeDraws([
            ...fixed,
            ...choices.flatMap((choice, bit) => (mask & (1 << bit) ? choice.hold : choice.spend)),
          ])
        );
      }
      const canLand = laterLandings[substitute];
      return {
        variants: own,
        // Hold an above-threshold landing only while a later watched step can still
        // land in the state holding leaves: this step's outcome recorded, the
        // substitute unspent, and the fire slot of any per-source first hit this
        // landing marks. Otherwise holding is worth nothing, so it spends.
        select: (codes, fired) => {
          if (fired[spendSlot] !== null) return 0;
          const landed = withFolded(fired, entry.id);
          let mask = 0;
          choices.forEach((choice, bit) => {
            const after = released(
              advanced(codes, updates, updateKinds, choice.outcome, choice.matched),
              releasesAt[stepIndex]
            );
            if (canLand(stepIndex + 1, after, landed)) {
              mask |= 1 << bit;
            }
          });
          return 1 + mask;
        },
      };
    };

    /**
     * One roll context's variants for every cap mask, block by block: variant `cap * size + i`
     * is `tableAt`'s variant `i` with the riders of `cap` folded in. A block is chosen by which
     * capped counters are still below their cap, so variant 0 (cap 0) applies no capped rider.
     * An uncapped step is one block, `tableAt` itself.
     */
    const blocked = (
      make: (cap: number) => { variants: StepVariant[]; select: Step["select"] }
    ): { variants: StepVariant[]; select: Step["select"] } => {
      const blocks = Array.from({ length: 1 << (capped.length + coined.length) }, (_, cap) => make(cap));
      if (blocks.length === 1) return blocks[0];
      // Every block has the same hold choices (they read the base payload, not the fold), so
      // block 0's variant count and choice rule serve for all.
      const size = blocks[0].variants.length;
      const local = blocks[0].select;
      return {
        variants: blocks.flatMap((block) => block.variants),
        select: (codes, fired, flags, counts) => {
          let cap = 0;
          capped.forEach((counter, bit) => {
            if (counts[counter] < counterMax[counter]) cap |= 1 << bit;
          });
          coined.forEach((node, k) => {
            if (flags & (1 << (coinFlags[node] as Flag).bit)) cap |= 1 << (capped.length + k);
          });
          return cap * size + local(codes, fired, flags, counts);
        },
      };
    };
    const table = (
      contextSlices: SourceSlices,
      vulnerable = false,
      joined: readonly string[] = [],
      rowContext: RowContext | undefined = baseContext
    ): { variants: StepVariant[]; select: Step["select"] } =>
      blocked((cap) => tableAt(contextSlices, cap, vulnerable, joined, rowContext));

    // A watched save row draws by class (one set per cap mask, no hold choice); any other row by
    // its hit / crit / miss slices (an unwatched save row is one "hit" draw of its whole PMF).
    const unwatchedSave = entry.attack !== -1 && attackSlices[entry.attack] === null;
    const baseCheck = rowCheckOf(damageOf(entry.id));
    /** The row's own context, where no flag is read: what the base table rolls in. */
    const baseContext = baseCheck === undefined ? undefined : contextOf(baseCheck, 0);
    const baseRollType: RollType = baseContext?.rollType ?? "flat";
    /** The step's d20 by state; its own roll unless read flags pick a context. */
    /** The row's own PMF in each context its tables roll in, and which context a state picks. */
    const ownPmf =
      entry.attack !== -1 ? attackPMFs[entry.attack] : slices ? riderPMF(entry.rider) : undefined;
    const contextPmfs: PMF[] = ownPmf === undefined ? [] : [ownPmf];
    const contextVulnerable: boolean[] = ownPmf === undefined ? [] : [false];
    const contextRollTypes: RollType[] = ownPmf === undefined ? [] : [baseRollType];
    let contextIndexOf: Step["contextIndexOf"] = () => 0;
    const tableOf = (
      pmf: PMF | undefined,
      vulnerable = false,
      joined: readonly string[] = [],
      rowContext: RowContext | undefined = baseContext
    ): { variants: StepVariant[]; select: Step["select"] } => {
      if (watchedKinds !== undefined) {
        const classes = pmf === undefined ? undefined : saveClasses(pmf);
        return blocked((cap) => ({ variants: [saveRowDraws(entry.id, cap, classes)], select: plainSelect }));
      }
      if (pmf === undefined) return table(slices as SourceSlices);
      return table(
        unwatchedSave ? { hit: pmf, crit: PMF.emptyMass(), miss: PMF.emptyMass() } : (sliceSource(pmf) as SourceSlices),
        vulnerable,
        joined,
        rowContext
      );
    };

    // Occurrence probability: with probability 1 - chance the attack does not
    // happen at all. That branch is a "none" draw — no miss, no landing, no
    // crit, no match, 0 damage — labelled missNone so the chart conserves mass
    // the way applyHitFrequency's freed mass does. Declared attacks only;
    // riders already fire on their trigger's terms.
    const chance = entry.attack !== -1 ? attackChances[entry.attack] : 1;
    const none: Draw = {
      outcome: "none",
      matched: false,
      spends: false,
      applies: [],
      bumps: [],
      fires: [],
      slice: PMF.missNone(eps).scaleMass(1 - chance),
    };
    /**
     * A variant as the walk draws it: a row that finds a condition damage ends splits each draw by
     * whether it dealt damage, and a row that may not happen draws "none" beside its outcomes.
     */
    const finish = (variant: StepVariant): StepVariant => {
      const split = woundsAt[stepIndex] !== 0 ? variant.flatMap(splitWounded) : variant;
      return chance < 1 ? mergeDraws([...split.map((draw) => scaleDraw(draw, chance)), none]) : split;
    };
    /** Whether `variants` are finished already (a row that builds its context tables as it goes). */
    let finished = false;

    // The riders whose dice join this row's roll while they have a landing left (`Rider.joins`).
    const joiners = riders.flatMap((rider, index) =>
      (rider.joins ?? []).includes(entry.id) && sourceIdsByNode[index].includes(entry.id) ? [index] : []
    );
    if ((watchedKinds !== undefined || slices) && readMask === 0 && joiners.length === 0) {
      ({ variants, select } = tableOf(undefined));
    } else if (watchedKinds !== undefined || slices) {
      // Read flags select a roll context. A contextual source rolls under it; a builder is
      // re-derived through `withCheck` with the granted modifiers combined into its own roll
      // type. One table per distinct resolved context the read flags can reach, not per flag set.
      const source = damageOf(entry.id);
      const check = rowCheckOf(source);
      const rebindable = source as { withCheck?: (fn: (check: Check) => Check) => Damage };
      const reads = readsAt[stepIndex];
      // Each penalty flag the step reads has a key bit of its own above the modifiers.
      const penaltyFlags = reads.filter(({ flag }) => flag.penalty !== undefined).map(({ flag }) => flag);
      const keyOf = ({ flag, modifiers }: { flag: Flag; modifiers: number }): number =>
        flag.penalty === undefined ? modifiers : 1 << (MOD_PENALTY_SHIFT + penaltyFlags.indexOf(flag));
      // Each joining rider has a key bit above the penalties: set while it has a landing left.
      const joinerBit = (j: number): number => 1 << (MOD_PENALTY_SHIFT + penaltyFlags.length + j);
      const joinedOf = (key: number): string[] =>
        joiners.flatMap((index, j) => (key & joinerBit(j) ? [riderIds[index]] : [])).sort();
      /** Whether joining rider `index` has a landing left: its first landing not made, or its cap not reached. */
      const leftAt = joiners.map((index) => {
        const payload = (perHitBySource.get(entry.id) ?? []).find((each) => each.id === riderIds[index]);
        if (payload === undefined) return () => false;
        if (payload.bit !== 0) {
          const counter = (countersBySource.get(entry.id) ?? [])[Math.log2(payload.bit)];
          return (_fired: readonly FireMode[], counts: readonly number[]) => counts[counter] < counterMax[counter];
        }
        if (payload.slot !== -1) return (fired: readonly FireMode[]) => fired[payload.slot] === null;
        return () => true;
      });
      /** The source's PMF under context key `key`, and its resolved context. */
      const rederive = (key: number): { pmf: () => PMF; signature: string } => {
        if (check !== undefined) {
          const penalties = penaltyFlags.flatMap((flag, j) =>
            key & (1 << (MOD_PENALTY_SHIFT + j)) ? [flag.penalty as PenaltyDice] : []
          );
          const context = { ...contextOf(check, key, penalties), joined: joinedOf(key) };
          return {
            pmf: () => rollUnder(source as unknown as ContextualSource, context, eps, entry.id),
            signature: contextKey(context),
          };
        }
        if (key & ~(MOD_ADVANTAGE | MOD_DISADVANTAGE | MOD_CRIT_ON_HIT)) {
          fail(
            "no-rebindable-source",
            entry.id,
            `"${entry.id}" reads a vulnerability or a save effect, or a rider joins its roll, which only a source that rolls under a row context (\`under\`) can take.`
          );
        }
        // Rows of one builder re-derive it once per key: the key holds only builder modifiers here.
        let byKey = rederivedBuilders.get(source);
        if (byKey === undefined) rederivedBuilders.set(source, (byKey = new Map()));
        const known = byKey.get(key);
        if (known !== undefined) return known;
        let signature = "";
        const rederived = (rebindable as Required<typeof rebindable>).withCheck((base) => {
          const next: Check = {
            ...base,
            rollType: combine(base.rollType, base.advantageDice, {
              advantage: (key & MOD_ADVANTAGE) !== 0,
              disadvantage: (key & MOD_DISADVANTAGE) !== 0,
            }).rollType,
            critOnHit: base.critOnHit || (key & MOD_CRIT_ON_HIT) !== 0,
          };
          signature = `${next.rollType}|${next.critOnHit}`;
          return next;
        });
        const variant = { pmf: () => toPMF(rederived, eps, entry.id), signature };
        byKey.set(key, variant);
        return variant;
      };
      let plain: string | undefined;
      if (check !== undefined || (!Array.isArray(source) && typeof rebindable.withCheck === "function")) {
        try {
          plain = rederive(0).signature;
        } catch {
          plain = undefined;
        }
      }
      if (plain === undefined) {
        fail(
          "no-rebindable-source",
          entry.id,
          `"${entry.id}" reads a granted modifier, but it has no attack check to re-derive (an attack that always hits, a bare PMF or a list of payloads). Scope the grant with \`to\`.`
        );
      }
      let reachable = [0];
      for (const flag of reads) {
        reachable = [...new Set([...reachable, ...reachable.map((key) => key | keyOf(flag))])];
      }
      joiners.forEach((_, j) => {
        reachable = [...new Set([...reachable, ...reachable.map((key) => key | joinerBit(j))])];
      });
      // The base context's table is built now (it validates the row); every other context's the
      // first time a state rolls in it, as the engine compiles a context only where one is reached.
      const base = tableOf(undefined);
      const tables: ({ variants: StepVariant[]; select: Step["select"] } | undefined)[] = [base];
      const offsets: number[] = [0];
      finished = true;
      variants.push(...base.variants.map(finish));
      const tableByContext = new Map([[plain as string, 0]]);
      const tableOfKey = new Map<number, number>();
      /** Per context index past the base, the key it was first reached with and its re-derivation. */
      const pending = new Map<number, { key: number; variant: { pmf: () => PMF; signature: string } }>();
      const rollTypeIn = (key: number, signature: string): RollType =>
        check !== undefined ? contextOf(check, key).rollType : (signature.split("|")[0] as RollType);
      const rowContextOf = (key: number): RowContext | undefined =>
        check === undefined
          ? undefined
          : {
              ...contextOf(
                check,
                key,
                penaltyFlags.flatMap((flag, j) => (key & (1 << (MOD_PENALTY_SHIFT + j)) ? [flag.penalty as PenaltyDice] : []))
              ),
              joined: joinedOf(key),
            };
      contextRollTypes[0] = rollTypeIn(0, plain as string);
      for (const key of reachable) {
        const variant = rederive(key);
        let index = tableByContext.get(variant.signature);
        if (index === undefined) {
          index = tables.length;
          tables.push(undefined);
          offsets.push(-1);
          pending.set(index, { key, variant });
          contextVulnerable.push(rowContextOf(key)?.vulnerable ?? false);
          contextRollTypes.push(rollTypeIn(key, variant.signature));
          tableByContext.set(variant.signature, index);
        }
        tableOfKey.set(key, index);
      }
      contextPmfs.length = tables.length;
      /** Context `index`'s table, built (and its variants appended) the first time it is asked for. */
      const tableIn = (index: number): { variants: StepVariant[]; select: Step["select"] } => {
        const known = tables[index];
        if (known !== undefined) return known;
        const { key, variant } = pending.get(index) as { key: number; variant: { pmf: () => PMF; signature: string } };
        const rowContext = rowContextOf(key);
        // Rows of one source roll the same PMF in the same context: re-derive it once.
        let bySignature = pmfsUnder.get(source);
        if (bySignature === undefined) pmfsUnder.set(source, (bySignature = new Map()));
        let pmf = bySignature.get(variant.signature);
        if (pmf === undefined) bySignature.set(variant.signature, (pmf = variant.pmf()));
        contextPmfs[index] = pmf;
        const built = tableOf(pmf, rowContext?.vulnerable ?? false, joinedOf(key), rowContext);
        tables[index] = built;
        offsets[index] = variants.length;
        variants.push(...built.variants.map(finish));
        return built;
      };
      const keyIn = (fired: readonly FireMode[], flags: number, counts: readonly number[]): number => {
        let key = 0;
        for (const read of reads) if (flags & (1 << read.flag.bit)) key |= keyOf(read);
        leftAt.forEach((left, j) => {
          if (left(fired, counts)) key |= joinerBit(j);
        });
        return key;
      };
      select = (codes, fired, flags, counts) => {
        const index = tableOfKey.get(keyIn(fired, flags, counts)) as number;
        const built = tableIn(index);
        return offsets[index] + built.select(codes, fired, flags, counts);
      };
      contextIndexOf = (_codes, fired, flags, counts) => tableOfKey.get(keyIn(fired, flags, counts)) as number;
    } else if (readMask !== 0) {
      fail(
        "no-rebindable-source",
        entry.id,
        `"${entry.id}" reads a granted modifier, but it is a list of several attacks, with no single attack check to re-derive. Declare each attack as its own rider, or scope the grant with \`to\`.`
      );
    }

    if (!finished) variants = variants.map(finish);

    const happens = rider ? happensOf[entry.rider] : 1;
    if (happens < 1 && slices) {
      fail("unsupported-trigger", entry.id, `Rider "${entry.id}" rolls its own attack and sets "happens"; only a damage rider may not happen.`);
    }
    const hit = rider && !slices ? riderPMF(entry.rider) : null;
    const negated =
      rider?.on === "not-fired" ? (fireSlots.get(rider.of) as number) : -1;
    steps.push({
      id: entry.id,
      trigger: rider,
      variants,
      select,
      damage: hit && rider ? { hit: thin(hit, happens), crit: thin(critPMF(rider, hit, eps), happens) } : null,
      updates,
      updateKinds,
      releases: releasesAt[stepIndex],
      settled: counterMax.map(
        (max, counter) => max - watchPositions[counter].filter((position) => position > stepIndex).length
      ),
      reads: rider ? slotOf(readsByRider.get(entry.rider) ?? -1) : -1,
      slot: rider ? (fireSlots.get(entry.id) as number) : -1,
      negates: negated,
      spendSlot,
      consumes: consumesAt[stepIndex],
      hitConsumes: hitConsumesAt[stepIndex],
      wounds: woundsAt[stepIndex],
      gate:
        entry.attack !== -1 && gateGroups[entry.attack] !== -1
          ? { slot: slotOf(gateGroups[entry.attack]), any: attackAfters[entry.attack]?.landing === "any" }
          : undefined,
      grants: grantsAt[stepIndex],
      readAdvantage,
      readDisadvantage,
      readCritOnHit,
      flagReads: readsAt[stepIndex].map(({ flag, modifiers }) => ({
        bit: flag.bit,
        modifiers,
        penalty: flag.penalty !== undefined,
        source: effectSourceOf(flag.condition),
      })),
      contextPmfs,
      contextVulnerable,
      contextRollTypes,
      contextIndexOf,
      transformed: substitute !== undefined,
    });
  });

  return {
    steps,
    groupCount: slotLastStep.length,
    attackPMFs,
    attackSingles,
    attackIds,
    riderIds,
    substituteIds,
    probeIds,
    rerollIds,
    fireSlots,
    slotCount: fireSlots.size,
    perHitGroups: new Map(
      [...everyHitGroups].map(([id, group]): [string, number] => [id, slotOfGroup[group]])
    ),
    perHitCritOnly: new Set([...critOnly].map((index) => riderIds[index])),
    perHitAny: new Set(riders.flatMap((rider, index) => (rider.landing === "any" && !critOnly.has(index) ? [riderIds[index]] : []))),
    riderRows: new Map(
      riderIds.map((id, index) => {
        const watched = new Set(riders[index].on === "not-fired" ? [] : sourceIdsByNode[index]);
        return [id, attackIds.filter((attackId) => watched.has(attackId))];
      })
    ),
    probes: new Map(
      probeIds.map((id, index): [string, number] => [id, slotOf(probeGroups[index])])
    ),
    everyHitIds,
    counterMax,
    groupLastReadStep: slotLastStep,
    conditionIds,
    flagLiveAfter,
    coins: coinFlags.flatMap((flag, index) =>
      flag !== undefined && flag.bit !== -1 ? [{ id: riderIds[index], bit: 1 << flag.bit, happens: happensOf[index] }] : []
    ),
    startFlags: conditionFlags.reduce(
      (mask, { start, main }) => (start ? main.reduce((bits, flag) => (flag.bit === -1 ? bits : bits | (1 << flag.bit)), mask) : mask),
      0
    ),
    startConditions: conditionFlags.flatMap(({ start, main }, index) =>
      start && main.some((flag) => flag.bit !== -1) ? [index] : []
    ),
    stateLimit: spec.stateLimit ?? MAX_TURN_STATES,
    dealing: dealingType !== undefined,
    effectSources,
    optionalIds: conditionIds.filter((_, index) => conditions[index].optional === true),
    // The engine's fallback for optional conditions past the search (`evaluate.ts` `meleeLeaning`):
    // attempted where the later attack rolls on the creature of its first source are at least as
    // often melee as not.
    meleeLeaning: conditions.map((_, index) => {
      const first = conditionFlags[index].applyAt[0];
      if (first === undefined) return false;
      let melee = 0;
      let ranged = 0;
      sequence.forEach((entry, position) => {
        if (position <= first || entry.attack === -1 || creatureAt[position] !== creatureAt[first]) return;
        const facts = rowFacts[position];
        if (facts !== undefined && facts.kind !== "attack") return;
        if (facts === undefined && !rollsAttack[position]) return;
        if (facts?.range === "melee") melee++;
        else ranged++;
      });
      return melee >= ranged;
    }),
  };
}
