import { combine } from "../builder/ac";
import type { AttachedCondition } from "../builder/attack";
import { ParsedRollBuilder } from "../builder/roll";
import type { AttackResolution, Check } from "../builder/types";
import { EPS } from "../common/types";
import type { DiceMatchInfo, HasDiceMatchInfo } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import { grantSpec, isGrant, isTransform } from "./effects";
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
  AttackTriggerOn,
  ConditionSpec,
  Damage,
  GrantSpec,
  PerSource,
  ProbeSpec,
  Rider,
  RiderDamage,
  RiderPayload,
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
 * How many granted-modifier flags a turn may carry in its walk state at once. Each
 * doubles the state space in the worst case, so like {@link MAX_TRIGGER_GROUPS} it
 * is a cost ceiling, not a modelling limit. Flags nothing reads are not counted.
 */
const MAX_LIVE_FLAGS = 8;

/** Which payload a rider used when it fired, or `null` while it has not fired. */
export type FireMode = "hit" | "crit" | null;

/**
 * A resolved, validated turn: the ordered steps to walk, plus the trigger
 * groups it tracks. Building this is where every {@link TurnSpecError} is raised,
 * so the walk itself can assume a well-formed plan.
 */
export interface TurnPlan {
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
   * The LAST step index that reads each flag bit, the twin of `groupLastReadStep`:
   * past it the bit no longer changes any decision, so the walk drops it from the
   * merge key. A turn with no conditions has no bits.
   */
  flagLastReadStep: readonly number[];
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
   * Set on a save row's draws only: a group keyed by a landing kind advances by that kind's
   * entry instead of `outcome`, which is what step statistics and grants read.
   */
  byKind?: ByKind;
}

/** What a save row's draw is to a rider reading the row under each landing kind. */
export type ByKind = Readonly<Record<SaveLanding, StepOutcome>>;

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
        other.byKind === draw.byKind
    );
    if (index === -1) merged.push(draw);
    else merged[index] = { ...merged[index], slice: merged[index].slice.add(draw.slice) };
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
  on: AttackTriggerOn;
  /** Group whose pre-draw code `first-hit` / `first-miss` reads, else -1. */
  reads: number;
  chance: number;
  /** Flag bits set on the `chance` branch. */
  grants: number;
  /** Flag bits set on the other branch. */
  onSave: number;
  /** Non-zero when the application is skipped once all of these bits are set. */
  inForce: number;
  /** Whether a later step reads one of `grants` — what `fireProbability` counts. */
  effective: boolean;
}

/** Whether `outcome`, drawn in a state whose pre-draw group codes are `codes`, applies `app`. */
export function grantApplies(
  app: GrantApplication,
  outcome: StepOutcome,
  codes: readonly number[]
): boolean {
  // A "none" outcome (an attack that did not happen) is no landing and no miss,
  // so it applies no condition's grants.
  if (outcome === "none") return false;
  switch (app.on) {
    case "every-hit":
      return outcome !== "miss";
    case "first-hit":
      return outcome !== "miss" && ((codes[app.reads] >> 2) & 0b11) === FIRST_NONE;
    case "any-crit":
      return outcome === "crit";
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
  /** Conditions this step's outcome may apply, in declaration order. */
  grants: readonly GrantApplication[];
  /** Flag bits this step reads that grant advantage. */
  readAdvantage: number;
  /** Flag bits this step reads that grant disadvantage. */
  readDisadvantage: number;
  /** Flag bits this step reads that grant crit-on-hit. */
  readCritOnHit: number;
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
 * Triggers a condition accepts. Only `first-hit` and `first-miss` read a group —
 * whether this is the first such outcome — so only they allocate one.
 */
const GRANT_TRIGGERS: Record<string, { readsGroup: boolean }> = {
  "every-hit": { readsGroup: false },
  "first-hit": { readsGroup: true },
  "any-crit": { readsGroup: false },
  "any-miss": { readsGroup: false },
  "first-miss": { readsGroup: true },
};

/** A read flag's modifiers, as a 3-bit key: which roll context a set of flags selects. */
const MOD_ADVANTAGE = 1;
const MOD_DISADVANTAGE = 2;
const MOD_CRIT_ON_HIT = 4;

/** One granted modifier of one condition, as the plan tracks it. */
interface Flag {
  /** For messages: the condition and which of its grants. */
  name: string;
  condition: string;
  grant: GrantSpec;
  /** Steps whose variant it selects; a `next-attack` flag is consumed by each. */
  readers: number[];
  /** The last step that reads it, for a variant or a skip check; -1 if none. */
  lastRead: number;
  /** Its bit in the walk's flag word, or -1 when nothing reads it. */
  bit: number;
}

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
const ATTACK_KEYS: Record<string, true> = { source: true, id: true, tag: true, chance: true };

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
        `Attack "${typeof wrapper.id === "string" ? wrapper.id : id}" carries an unknown key "${key}". Valid keys are source, id, tag and chance.`
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
 * The one {@link ConditionSpec} an {@link AttachedCondition} becomes: `of` is the
 * carrying attack's id, the gate's `save` becomes `chance` (its P(fail)), and its
 * `onSave` grants become the success-branch grants. Mirrors `Turn`'s trigger verbs.
 */
function conditionFromAttached(
  slotId: string,
  index: number,
  attached: AttachedCondition,
  eps: number
): ConditionSpec {
  const gate = attached.gate;
  const save = gate?.save;
  const chance = gate?.chance;
  const onSave = gate?.onSave;
  if (save !== undefined && chance !== undefined) {
    throw new Error(
      "An attached condition takes either save or chance, not both: each is the chance the grants take."
    );
  }
  if (onSave !== undefined && save === undefined && chance === undefined) {
    throw new Error(
      "An attached condition's onSave needs a save or a chance: without one there is no other branch to apply it on."
    );
  }
  if (save !== undefined && typeof (save as Partial<ToPMF>).toPMF !== "function") {
    throw new Error("An attached condition's save must be a DC check such as d20.plus(2).dc(15).");
  }
  // A save's P(fail): the DC check's PMF puts it at 1. `vsAC` leaves it alone —
  // it is the target's save bonus, not its AC.
  const probability = save === undefined ? chance : save.toPMF(eps).pAt(1);
  const grants = (Array.isArray(attached.grants) ? attached.grants : [attached.grants]).map(
    grantSpec
  );
  const saved = onSave === undefined ? [] : Array.isArray(onSave) ? [...onSave] : [onSave];
  return {
    id: `${slotId}:${index}`,
    on: attached.on,
    of: [slotId],
    ...(probability === undefined ? {} : { chance: probability }),
    grants,
    ...(saved.length === 0 ? {} : { onSave: saved.map(grantSpec) }),
  };
}

/** A rider's payload per source; a spec that is not typed can carry one on any trigger. */
function perSourceOf(rider: Rider): PerSource | undefined {
  return "perSource" in rider ? rider.perSource : undefined;
}

/** A `first-hit` rider with a payload per source: folded into its sources' draws, not a step. */
function isFirstHitFold(rider: Rider): boolean {
  return rider.on === "first-hit" && perSourceOf(rider) !== undefined;
}

export function buildPlan(spec: TurnSpec, eps: number = EPS): TurnPlan {
  const fail = (code: TurnSpecErrorCode, id: string, message: string): never => {
    throw new TurnSpecError(code, id, message);
  };

  const declaredRiders = spec.riders ?? [];
  // `every-hit` capped at 1 IS `first-hit`: lowered here, before anything reads the riders, so
  // it takes the same step, fire slot, `otherwise` / `not-fired`, `of` naming and arithmetic.
  const riders: readonly Rider[] = declaredRiders.map((rider) => {
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
  const declaredConditions: readonly ConditionSpec[] = spec.conditions ?? [];
  const probes: readonly ProbeSpec[] = spec.observe ?? [];

  // --- attacks -------------------------------------------------------------
  const attackIds: string[] = [];
  const attackSources: Damage[] = [];
  const attackPMFs: PMF[] = [];
  const attackSingles: PMF[] = [];
  const attackSlices: (SourceSlices | null)[] = [];
  const attackChances: number[] = [];
  const attackIdsByTag = new Map<string, string[]>();

  spec.attacks.forEach((entry, index) => {
    const { id, tag, source, chance } = attackEntry(entry, index);
    if (!(chance >= 0 && chance <= 1)) {
      throw new RangeError(`Attack "${id}" needs a chance in [0, 1], got ${chance}.`);
    }
    const pmf = toPMF(source, eps, id);
    attackIds.push(id);
    attackSources.push(source);
    attackPMFs.push(pmf);
    // The toQuery() single is the attack's marginal: gated by its occurrence
    // probability. The walk uses the full slices plus a "none" draw instead, so
    // a not-happened attack never reads as a miss or a landing.
    attackSingles.push(chance === 1 ? pmf : pmf.applyHitFrequency(chance));
    attackSlices.push(sliceSource(pmf));
    attackChances.push(chance);
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
  const attachedConditions: ConditionSpec[] = [];
  attackIds.forEach((slotId, index) => {
    const attached = attachedConditionsOf(attackSources[index]);
    if (!attached) return;
    attached.forEach((entry, entryIndex) => {
      attachedConditions.push(conditionFromAttached(slotId, entryIndex, entry, eps));
    });
  });
  const conditions: readonly ConditionSpec[] = [...declaredConditions, ...attachedConditions];

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
      if (rider.landing !== "fail" && rider.landing !== "damage") {
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
      if (declared.on !== "every-hit") {
        fail(
          "unsupported-trigger",
          id,
          `Rider "${id}" has a max on "${declared.on}". Only every-hit riders are capped; first-hit already applies once.`
        );
      }
      if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
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
        `Condition "${id}" triggers on "${condition.on}"; a condition reads every-hit, first-hit, any-crit, first-miss or any-miss.`
      );
    }
    const { chance } = condition;
    if (chance !== undefined && !(chance >= 0 && chance <= 1)) {
      throw new RangeError(`Condition "${id}" needs a chance in [0, 1], got ${chance}.`);
    }
    if (condition.onSave !== undefined && chance === undefined) {
      throw new Error(
        `Condition "${id}" has onSave grants but no save or chance: there is no other branch to apply them on.`
      );
    }
    for (const grant of [...condition.grants, ...(condition.onSave ?? [])]) {
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
          fail(
            "no-dice-descriptor",
            sourceId,
            `Rider "${ownerId}" reads "${sourceId}" for "dice-match", but "${sourceId}" has no dice descriptor to match against — a bare PMF, a string-parsed expression, or a keep()/bestOf() pool (ambiguous "the dice" under crit doubling) cannot be matched.`
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
  const sourceIdsByNode: string[][] = [
    ...riders.map((rider, index) => {
      const id = riderIds[index];
      if (rider.on !== "not-fired") {
        return resolveSources(id, rider.of ?? defaultOf(index), rider.on === "dice-match", rider.landing);
      }
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
  const conditionSources = conditions.map((condition, index) =>
    resolveSources(conditionIds[index], condition.of ?? defaultOf(riderCount), false)
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
    // A landing kind splits a group only through the save rows among its sources: two riders
    // over the same sources with different kinds read the row differently, so they cannot share.
    const kind = landing !== undefined && sourceIds.some(isSaveRow) ? landing : null;
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
    const group = groupOf(sourceIdsByNode[node], rider.landing);
    readsByRider.set(node, group);
    if (rider.on === "every-hit") everyHitGroups.set(riderIds[node], group);
  }
  // A condition reuses the group its `of` already has: a first-hit grant and a first-hit
  // rider over the same attacks share one. Only first-hit / first-miss read it.
  const conditionGroups = conditions.map((condition, index) =>
    GRANT_TRIGGERS[condition.on].readsGroup ? groupOf(conditionSources[index]) : -1
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
  const rollsAttack = sequence.map((entry) =>
    entry.attack !== -1
      ? attackSlices[entry.attack] !== null
      : slicesOf(entry.id) !== null || attackLists[entry.rider]
  );
  const conditionFlags = conditions.map((condition, index) => {
    const id = conditionIds[index];
    const sources = new Set(conditionSources[index]);
    const applyAt = sequence.flatMap((entry, position) => (sources.has(entry.id) ? [position] : []));
    const flagOf = (grant: GrantSpec, label: string): Flag => {
      const targets = grant.to === undefined ? null : new Set(resolveSources(id, grant.to, false));
      // Every attack roll after the condition's first source, attack-shaped riders included.
      const readers = sequence.flatMap((entry, position) =>
        position > applyAt[0] && rollsAttack[position] && (targets === null || targets.has(entry.id))
          ? [position]
          : []
      );
      if (targets !== null && readers.length === 0) {
        fail(
          "unknown-id",
          id,
          `Condition "${id}"'s ${label} is read by ${grant.to?.map((to) => `"${to}"`).join(", ")}, none of which rolls an attack after "${sequence[applyAt[0]].id}".`
        );
      }
      return {
        name: `"${id}" ${label}`,
        condition: id,
        grant,
        readers,
        lastRead: readers.length ? readers[readers.length - 1] : -1,
        bit: -1,
      };
    };
    const main = condition.grants.map((grant, grantIndex) => flagOf(grant, `grant ${grantIndex + 1}`));
    const onSave = (condition.onSave ?? []).map((grant, grantIndex) =>
      flagOf(grant, `onSave grant ${grantIndex + 1}`)
    );
    // An application whose grants are all end-of-turn and all in force is skipped,
    // onSave with it. With an onSave to skip, that check reads the grants at every source.
    const lastingOnly = main.length > 0 && main.every((flag) => flag.grant.until === "end-of-turn");
    if (lastingOnly && onSave.length > 0) {
      for (const flag of main) flag.lastRead = Math.max(flag.lastRead, applyAt[applyAt.length - 1]);
    }
    return { main, onSave, lastingOnly, applyAt };
  });

  const liveFlags = conditionFlags.flatMap(({ main, onSave }) =>
    [...main, ...onSave].filter((flag) => flag.lastRead !== -1)
  );
  if (liveFlags.length > MAX_LIVE_FLAGS) {
    fail(
      "too-many-flags",
      liveFlags[MAX_LIVE_FLAGS].condition,
      `A turn may carry at most ${MAX_LIVE_FLAGS} granted modifiers that a later attack reads; this one has ${liveFlags.length}: ${liveFlags.map((flag) => flag.name).join(", ")}.`
    );
  }
  liveFlags.forEach((flag, bit) => {
    flag.bit = bit;
  });
  const bitsOf = (flags: readonly Flag[]): number =>
    flags.reduce((mask, flag) => (flag.bit === -1 ? mask : mask | (1 << flag.bit)), 0);
  const modifiersOfBit = liveFlags.map(
    ({ grant }) =>
      (grant.advantage ? MOD_ADVANTAGE : 0) |
      (grant.disadvantage ? MOD_DISADVANTAGE : 0) |
      (grant.critOnHit ? MOD_CRIT_ON_HIT : 0)
  );
  const readMaskAt = new Array<number>(sequence.length).fill(0);
  const consumesAt = new Array<number>(sequence.length).fill(0);
  for (const flag of liveFlags) {
    for (const reader of flag.readers) {
      readMaskAt[reader] |= 1 << flag.bit;
      if (flag.grant.until === "next-attack") consumesAt[reader] |= 1 << flag.bit;
    }
  }

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
  });
  conditions.forEach((_, index) => {
    const { main, onSave, applyAt } = conditionFlags[index];
    if ((bitsOf(main) | bitsOf(onSave)) === 0) return;
    // A first-hit / first-miss grant reads its group's pre-draw code at each source step.
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

  const grantsAt: GrantApplication[][] = sequence.map(() => []);
  conditions.forEach((condition, index) => {
    const { main, onSave, lastingOnly, applyAt } = conditionFlags[index];
    const grants = bitsOf(main);
    const onSaveBits = bitsOf(onSave);
    if ((grants | onSaveBits) === 0) return;
    for (const position of applyAt) {
      grantsAt[position].push({
        condition: index,
        on: condition.on,
        reads: slotOf(conditionGroups[index]),
        chance: condition.chance ?? 1,
        grants,
        onSave: onSaveBits,
        inForce: lastingOnly ? grants : 0,
        effective: main.some((flag) => flag.readers.some((reader) => reader > position)),
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
    /** The fire slot a first-hit rider marks when it applies, or -1. */
    slot: number;
    /** The rider's counter's bit in a source's variant mask, or 0 when uncapped. */
    bit: number;
    /** How the rider reads a save row among its sources (see {@link SaveLanding}). */
    landing: SaveLanding | undefined;
    hit: PMF;
    crit: PMF;
  }
  const everyHitIds = riderIds.filter((_, index) => riders[index].on === "every-hit");
  const counterMax: number[] = [];
  /** Per counter, the landing kind its riders read a save row under; undefined when no source is a save row. */
  const counterLanding: (SaveLanding | undefined)[] = [];
  const counterIdByKey = new Map<string, number>();
  const perHitBySource = new Map<string, HitPayload[]>();
  /**
   * Per source, the distinct counters that watch it, in payload order: bit i of a variant mask
   * says whether counter i's riders apply in that variant.
   */
  const countersBySource = new Map<string, number[]>();
  const payloadOf = (payload: RiderPayload, id: string): { hit: PMF; crit: PMF } => {
    const hit = toPMF(payload.damage, eps, id);
    return { hit, crit: critPMF(payload, hit, eps) };
  };
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
    let shared: { hit: PMF; crit: PMF } | undefined;
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
      const kind = rider.landing !== undefined && sources.some(isSaveRow) ? rider.landing : undefined;
      const key = JSON.stringify([[...sources].sort(), cap, kind ?? null]);
      let known = counterIdByKey.get(key);
      if (known === undefined) {
        known = counterMax.push(cap) - 1;
        counterLanding.push(kind);
        counterIdByKey.set(key, known);
      }
      counter = known;
    }
    const applyIndex = everyHitIds.indexOf(id);
    const slot = rider.on === "first-hit" ? (fireSlots.get(id) as number) : -1;
    for (const sourceId of sources) {
      const each = own.get(sourceId);
      const payload = each ? payloadOf(each, id) : (shared ??= payloadOf(rider, id));
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
      const entry = { rider: applyIndex, slot, bit, landing: rider.landing, ...payload };
      const existing = perHitBySource.get(sourceId);
      if (existing) existing.push(entry);
      else perHitBySource.set(sourceId, [entry]);
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
  /** `slice` with the every-hit riders of variant `mask` folded in: every uncapped one, and each capped one whose bit is set. */
  const fold = (sourceId: string, outcome: "hit" | "crit", slice: PMF, mask: number): PMF => {
    let folded = slice;
    for (const payload of perHitBySource.get(sourceId) ?? []) {
      if (payload.bit !== 0 && (mask & payload.bit) === 0) continue;
      folded = folded.convolve(payload[outcome], eps, true);
    }
    return folded;
  };
  /** What a hit or crit drawn from variant `mask` of `sourceId` applies, counts and marks as fired. */
  const landingOf = (
    sourceId: string,
    mask: number
  ): { applies: number[]; bumps: number[]; fires: number[] } => {
    const active = (perHitBySource.get(sourceId) ?? []).filter(
      (payload) => payload.bit === 0 || (mask & payload.bit) !== 0
    );
    return {
      applies: active.flatMap((payload) => (payload.rider === -1 ? [] : [payload.rider])),
      bumps: (countersBySource.get(sourceId) ?? []).filter((_, local) => (mask & (1 << local)) !== 0),
      fires: active.flatMap((payload) => (payload.slot === -1 ? [] : [payload.slot])),
    };
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
    mask: number
  ): { fixed: Draw[]; choices: HoldChoice[] } => {
    const { applies, bumps, fires } = landingOf(sourceId, mask);
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
      const finish = (part: PMF): PMF =>
        fold(sourceId, outcome, separate ? part.convolve(separate, eps, true) : part, mask);
      /** `part`'s draws: split by match odds on its value, unless its dice's match status is `known`. */
      const drawsOf = (part: PMF, spends: boolean, known?: boolean): Draw[] => {
        if (!info || known !== undefined) {
          return [{ outcome, matched: known ?? false, spends, applies, bumps, fires, slice: finish(part) }];
        }
        const [matched, unmatched] = part.splitByFactor(
          (damage) => info.matchProbabilityByDamage.get(damage) ?? 0
        );
        return [
          { outcome, matched: true, spends, applies, bumps, fires, slice: finish(matched) },
          { outcome, matched: false, spends, applies, bumps, fires, slice: finish(unmatched) },
        ];
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
    fixed.push({ outcome: "miss", matched: false, spends: false, applies: [], bumps: [], fires: [], slice: slices.miss });
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
      existing.kinds.push(isSaveRow(sourceId) ? groupLandings[group] : null);
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
      if (draw?.byKind !== undefined && draw.byKind[payload.landing ?? "fail"] !== "hit") continue;
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
  const saveRowDraws = (sourceId: string, mask: number): Draw[] =>
    classesOf(sourceId).map((slice, index) => {
      // The riders that apply on this class: every uncapped one, and each capped one whose bit is
      // set in `mask`, and only where the class lands under the rider's own kind.
      const active = (perHitBySource.get(sourceId) ?? []).filter(
        (payload) =>
          (payload.bit === 0 || (mask & payload.bit) !== 0) && CLASS_LANDS[index][payload.landing ?? "fail"]
      );
      let folded = slice;
      for (const payload of active) folded = folded.convolve(payload.hit, eps, true);
      return {
        outcome: "hit",
        matched: false,
        spends: false,
        applies: active.flatMap((payload) => (payload.rider === -1 ? [] : [payload.rider])),
        // A counter counts the landings of its riders: the classes that land under its kind.
        bumps: (countersBySource.get(sourceId) ?? []).filter(
          (counter, local) => (mask & (1 << local)) !== 0 && CLASS_LANDS[index][counterLanding[counter] ?? "fail"]
        ),
        fires: active.flatMap((payload) => (payload.slot === -1 ? [] : [payload.slot])),
        slice: folded,
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
    if (readMask !== 0) {
      for (let bit = 0; bit < modifiersOfBit.length; bit++) {
        if (readMask & (1 << bit)) {
          const modifiers = modifiersOfBit[bit];
          if (modifiers & MOD_ADVANTAGE) readAdvantage |= 1 << bit;
          if (modifiers & MOD_DISADVANTAGE) readDisadvantage |= 1 << bit;
          if (modifiers & MOD_CRIT_ON_HIT) readCritOnHit |= 1 << bit;
        }
      }
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

    /**
     * The plain draws and, under a substitute, one variant per hold mask (variant 1 +
     * mask: bit i set ⇔ choice i is held; only a threshold policy has choices), for
     * one roll context's slices, with the capped riders of `cap` folded in.
     */
    const tableAt = (
      contextSlices: SourceSlices,
      cap: number
    ): { variants: StepVariant[]; select: Step["select"] } => {
      const plain = drawsFor(entry.id, contextSlices, null, cap).fixed;
      if (substitute === undefined) return { variants: [plain], select: plainSelect };
      const { fixed, choices } = drawsFor(
        entry.id,
        contextSlices,
        substitutes[substitute].policy ?? { kind: "always" },
        cap
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
      const blocks = Array.from({ length: 1 << capped.length }, (_, cap) => make(cap));
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
          return cap * size + local(codes, fired, flags, counts);
        },
      };
    };
    const table = (contextSlices: SourceSlices): { variants: StepVariant[]; select: Step["select"] } =>
      blocked((cap) => tableAt(contextSlices, cap));

    if (watchedKinds !== undefined) {
      // A watched save row has one set of class draws per cap mask, and no roll context or hold choice.
      ({ variants, select } = blocked((cap) => ({ variants: [saveRowDraws(entry.id, cap)], select: plainSelect })));
    } else if (slices && readMask === 0) {
      ({ variants, select } = table(slices));
    } else if (slices) {
      // Read flags select a roll context: the source re-derived through `withCheck` with
      // the granted modifiers combined into its own roll type. One table per distinct
      // resolved context the read flags can reach, not per flag set.
      const source = damageOf(entry.id);
      const rebindable = source as { withCheck?: (fn: (check: Check) => Check) => Damage };
      /** The source re-derived under modifier key `key`, and its resolved context. */
      const rederive = (key: number): { source: Damage; signature: string } => {
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
        return { source: rederived, signature };
      };
      let plain: string | undefined;
      if (!Array.isArray(source) && typeof rebindable.withCheck === "function") {
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
      modifiersOfBit.forEach((modifiers, bit) => {
        if (readMask & (1 << bit)) {
          reachable = [...new Set([...reachable, ...reachable.map((key) => key | modifiers)])];
        }
      });
      const tables = [table(slices)];
      const tableByContext = new Map([[plain as string, 0]]);
      const tableOfKey = new Array<number>(MOD_CRIT_ON_HIT << 1).fill(0);
      for (const key of reachable) {
        const variant = rederive(key);
        let index = tableByContext.get(variant.signature);
        if (index === undefined) {
          index = tables.length;
          tables.push(table(sliceSource(toPMF(variant.source, eps, entry.id)) as SourceSlices));
          tableByContext.set(variant.signature, index);
        }
        tableOfKey[key] = index;
      }
      const offsets: number[] = [];
      for (const each of tables) {
        offsets.push(variants.length);
        variants.push(...each.variants);
      }
      select = (codes, fired, flags, counts) => {
        const read = flags & readMask;
        let key = 0;
        for (let bit = 0; read >> bit !== 0; bit++) {
          if (read & (1 << bit)) key |= modifiersOfBit[bit];
        }
        const index = tableOfKey[key];
        return offsets[index] + tables[index].select(codes, fired, flags, counts);
      };
    } else if (readMask !== 0) {
      fail(
        "no-rebindable-source",
        entry.id,
        `"${entry.id}" reads a granted modifier, but it is a list of several attacks, with no single attack check to re-derive. Declare each attack as its own rider, or scope the grant with \`to\`.`
      );
    }

    // Occurrence probability: with probability 1 - chance the attack does not
    // happen at all. That branch is a "none" draw — no miss, no landing, no
    // crit, no match, 0 damage — labelled missNone so the chart conserves mass
    // the way applyHitFrequency's freed mass does. Declared attacks only;
    // riders already fire on their trigger's terms.
    const chance = entry.attack !== -1 ? attackChances[entry.attack] : 1;
    if (chance < 1) {
      const none: Draw = {
        outcome: "none",
        matched: false,
        spends: false,
        applies: [],
        bumps: [],
        fires: [],
        slice: PMF.missNone(eps).scaleMass(1 - chance),
      };
      variants = variants.map((variant) =>
        mergeDraws([
          ...variant.map((draw) => ({ ...draw, slice: draw.slice.scaleMass(chance) })),
          none,
        ])
      );
    }

    const hit = rider && !slices ? riderPMF(entry.rider) : null;
    const negated =
      rider?.on === "not-fired" ? (fireSlots.get(rider.of) as number) : -1;
    steps.push({
      id: entry.id,
      trigger: rider,
      variants,
      select,
      damage: hit && rider ? { hit, crit: critPMF(rider, hit, eps) } : null,
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
      grants: grantsAt[stepIndex],
      readAdvantage,
      readDisadvantage,
      readCritOnHit,
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
    probes: new Map(
      probeIds.map((id, index): [string, number] => [id, slotOf(probeGroups[index])])
    ),
    everyHitIds,
    counterMax,
    groupLastReadStep: slotLastStep,
    conditionIds,
    flagLastReadStep: liveFlags.map((flag) => flag.lastRead),
  };
}
