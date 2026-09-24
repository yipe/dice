import { combine } from "../builder/ac";
import { ParsedRollBuilder } from "../builder/roll";
import type { AttackResolution, Check } from "../builder/types";
import { EPS } from "../common/types";
import type { DiceMatchInfo, HasDiceMatchInfo } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import { isGrant, isTransform } from "./effects";
import type { StepOutcome } from "./state";
import { advance, CRIT_BIT, FIRST_CRIT, FIRST_NONE, MATCH_BIT, MISS_BIT } from "./state";
import type {
  Attack,
  AttackTriggerOn,
  ConditionSpec,
  Damage,
  GrantSpec,
  Rider,
  SubstitutePolicy,
  SubstituteSpec,
  ToPMF,
  Trigger,
  TurnSpec,
  TurnSpecErrorCode,
} from "./types";
import { MAX_TRIGGER_GROUPS, TurnSpecError } from "./types";

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
  /** One entry per distinct `of` set; each holds the step indices that update it. */
  groupCount: number;
  /** Declared attacks only, in order — what `DiceQuery.singles` gets. */
  attackPMFs: readonly PMF[];
  /** Every attack id, in declaration order. */
  attackIds: readonly string[];
  /** Every rider id, in declaration order, including `every-hit` riders. */
  riderIds: readonly string[];
  /** Every substitute id, in declaration order. */
  substituteIds: readonly string[];
  /**
   * Ids of the attack-shaped `any-miss` / `first-miss` riders, in declaration
   * order: a reroll continues the attacks it watches, so `Turn`'s chaining
   * methods add these to a later rider's defaulted `of`.
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
   * `every-hit` rider id → the group index whose "something landed" bit answers
   * P(it fired at least once). Such riders are folded into their sources' slices
   * rather than becoming steps, so they have no step index.
   */
  perHitGroups: ReadonlyMap<string, number>;
  /**
   * The LAST step index (in final walk order) that reads each group, by group
   * index — `steps.length` for a group `perHitGroups` still needs at the final
   * collapse. Once the walk passes a group's last reader, its specific code
   * stops discriminating any future decision, so `Turn.resolve`'s `merge` stops
   * keying on it past that point — the dominant cost fix for a long `dice-match`
   * chain (a group read by exactly one downstream step, the common shape, would
   * otherwise keep splitting states for every step after that single read).
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
 * substitute, and the sub-mass PMF itself.
 */
export interface Draw {
  outcome: StepOutcome;
  matched: boolean;
  spends: boolean;
  slice: PMF;
}

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
        other.spends === draw.spends
    );
    if (index === -1) merged.push(draw);
    else merged[index] = { ...merged[index], slice: merged[index].slice.add(draw.slice) };
  }
  return merged;
}

/** `codes` with `outcome` folded into each group in `updates`. */
function advanced(
  codes: readonly number[],
  updates: readonly number[],
  outcome: StepOutcome,
  matched: boolean
): number[] {
  const next = [...codes];
  for (const group of updates) next[group] = advance(next[group], outcome, matched);
  return next;
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
   * Every precomputed draw set for this step; index 0 is the plain one. A step with
   * no state dependence has exactly one. Nothing is transformed inside the walk:
   * {@link Step.select} picks one of these at the draw site.
   */
  variants: readonly StepVariant[];
  /**
   * Which variant to draw from, given the state's group codes, its fire slots with
   * this step's own firing already recorded, and its flag bits before this step
   * consumes any.
   */
  select: (codes: readonly number[], fired: readonly FireMode[], flags: number) => number;
  /** Pure-damage payloads, mass 1 each. */
  damage: { hit: PMF; crit: PMF } | null;
  /** Group indices this step's outcome advances. */
  updates: readonly number[];
  /** Group index this step's trigger reads, or -1 for `not-fired` / always-fires. */
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
      // An attack-shaped rider (the only kind a `dice-match` trigger can fire —
      // it always has variants, never `step.damage`) ignores the returned
      // mode entirely; "hit" is just the truthy sentinel meaning "fires".
      return (code & MATCH_BIT) !== 0 ? "hit" : null;
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
    if (part instanceof PMF) return part;
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
function critPMF(rider: Rider, base: PMF, eps: number): PMF {
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
 * Split a source into hit / crit / miss sub-mass PMFs, or return null when the
 * source is not attack-shaped (a plain damage roll is not an attack).
 *
 * The shape comes from the PMF's outcome labels, with one exception for a rider's
 * `damage`: a parsed string whose dice can double is damage, although `parse()` labels
 * its whole PMF 'hit' (so it doubles on a crit and takes `critDamage`, exactly like
 * the equivalent builder). In a list, only the other parts' labels decide. A parsed
 * string with a check stays label-shaped, as do attack builders and labelled PMFs; so
 * does one `canDoubleDice()` rejects for another reason (a dice-valued repeat count, `d4d6`).
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

/** A declared attack, unwrapped. */
function attackEntry(entry: Attack, index: number): { id: string; tag?: string; source: Damage } {
  const id = `attack ${index + 1}`;
  // A wrapper with no source falls through as a would-be source, so it fails
  // `not-an-attack` in toPMF rather than as a bare TypeError.
  if (!("source" in entry) || entry.source === undefined) return { id, source: entry as Damage };
  return { id: entry.id ?? id, tag: entry.tag, source: entry.source };
}

export function buildPlan(spec: TurnSpec, eps: number = EPS): TurnPlan {
  const fail = (code: TurnSpecErrorCode, id: string, message: string): never => {
    throw new TurnSpecError(code, id, message);
  };

  const riders = spec.riders ?? [];
  const substitutes: readonly SubstituteSpec[] = spec.substitutes ?? [];
  const conditions: readonly ConditionSpec[] = spec.conditions ?? [];

  // --- attacks -------------------------------------------------------------
  const attackIds: string[] = [];
  const attackSources: Damage[] = [];
  const attackPMFs: PMF[] = [];
  const attackSlices: (SourceSlices | null)[] = [];
  const attackIdsByTag = new Map<string, string[]>();

  spec.attacks.forEach((entry, index) => {
    const { id, tag, source } = attackEntry(entry, index);
    const pmf = toPMF(source, eps, id);
    attackIds.push(id);
    attackSources.push(source);
    attackPMFs.push(pmf);
    attackSlices.push(sliceSource(pmf));
    if (tag !== undefined) {
      const tagged = attackIdsByTag.get(tag);
      if (tagged) tagged.push(id);
      else attackIdsByTag.set(tag, [id]);
    }
  });

  // --- ids -----------------------------------------------------------------
  const riderIds = riders.map((rider, index) => rider.id ?? `rider ${index + 1}`);
  const substituteIds = substitutes.map(
    (substitute, index) => substitute.id ?? `substitute ${index + 1}`
  );
  const conditionIds = conditions.map((condition, index) => condition.id ?? `condition ${index + 1}`);
  const seen = new Set<string>();
  for (const id of [...attackIds, ...riderIds, ...substituteIds, ...conditionIds]) {
    if (seen.has(id)) fail("duplicate-id", id, `Duplicate id "${id}".`);
    seen.add(id);
  }

  riders.forEach((rider, index) => {
    // Every trigger but `not-fired` reads a group, so READS_GROUP names them all; anything else
    // would build a step `fireMode` never fires.
    if (rider.on !== "not-fired" && !Object.prototype.hasOwnProperty.call(READS_GROUP, rider.on)) {
      fail(
        "unsupported-trigger",
        riderIds[index],
        `Rider "${riderIds[index]}" triggers on "${String(rider.on)}", which is not a trigger. Use first-hit, any-crit, any-miss, first-miss, every-hit, dice-match or not-fired.`
      );
    }
    if (isTransform(rider.damage)) {
      fail(
        "unsupported-trigger",
        riderIds[index],
        `Rider "${riderIds[index]}" carries a transform on "${rider.on}". A transform is only accepted by onFirstHit.`
      );
    }
    const parts: readonly unknown[] = Array.isArray(rider.damage) ? rider.damage : [rider.damage];
    if (parts.some(isGrant)) {
      fail(
        "unsupported-trigger",
        riderIds[index],
        `Rider "${riderIds[index]}" carries a grant on "${rider.on}". A grant is only accepted by onEveryHit, onFirstHit and onAnyCrit.`
      );
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
    watchesDice: boolean
  ): string[] => {
    const sourceIds: string[] = [];
    for (const entry of of) {
      if (attackIndexById.has(entry) || riderIndexById.has(entry)) {
        sourceIds.push(entry);
      } else if (substituteIndexById.has(entry) || conditionIdSet.has(entry)) {
        const kind = substituteIndexById.has(entry) ? "substitute" : "condition";
        fail(
          "not-an-attack",
          entry,
          `"${ownerId}" watches "${entry}", a ${kind}. A ${kind} changes ${kind === "substitute" ? "damage" : "later attack rolls"}; it rolls no attack to watch.`
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
      const slices = slicesOf(sourceId);
      if (!slices) {
        fail(
          "not-an-attack",
          sourceId,
          `"${ownerId}" triggers on "${sourceId}", which has no hit/crit outcomes.`
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
    return unique;
  };

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
        return resolveSources(id, rider.of ?? attackIds, rider.on === "dice-match");
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
      resolveSources(substituteIds[index], substitute.of ?? attackIds, false)
    ),
  ];
  // Per condition: the source ids whose outcomes apply its grants.
  const conditionSources = conditions.map((condition, index) =>
    resolveSources(conditionIds[index], condition.of ?? attackIds, false)
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
  // Substitutes allocate none: each owns a fire slot instead.
  const groupIndexByKey = new Map<string, number>();
  const groupSources: string[][] = [];
  const groupOf = (sourceIds: readonly string[]): number => {
    // JSON, not a delimiter join: an id is consumer-supplied, and a delimiter
    // that can appear inside one makes the encoding non-injective, so two
    // distinct source sets could share a group.
    const key = JSON.stringify([...sourceIds].sort());
    const existing = groupIndexByKey.get(key);
    if (existing !== undefined) return existing;
    if (groupSources.length >= MAX_TRIGGER_GROUPS) {
      fail(
        "too-many-groups",
        key,
        `A turn may track at most ${MAX_TRIGGER_GROUPS} distinct trigger source sets.`
      );
    }
    const index = groupSources.length;
    groupIndexByKey.set(key, index);
    groupSources.push([...sourceIds]);
    return index;
  };

  const readsByRider = new Map<number, number>();
  const perHitGroups = new Map<string, number>();
  for (const node of order) {
    if (node >= riderCount) continue;
    const rider = riders[node];
    if (!READS_GROUP[rider.on]) continue;
    const group = groupOf(sourceIdsByNode[node]);
    readsByRider.set(node, group);
    if (rider.on === "every-hit") perHitGroups.set(riderIds[node], group);
  }
  // A condition reuses the group its `of` already has: a first-hit grant and a first-hit
  // rider over the same attacks share one. Only first-hit / first-miss read it.
  const conditionGroups = conditions.map((condition, index) =>
    GRANT_TRIGGERS[condition.on].readsGroup ? groupOf(conditionSources[index]) : -1
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
    if (rider.on === "every-hit" || rider.on === "first-miss") continue;
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
  const rollsAttack = sequence.map((entry) =>
    entry.attack !== -1 ? attackSlices[entry.attack] !== null : slicesOf(entry.id) !== null
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
    // An application whose end-of-turn grants are all in force is skipped, onSave
    // with it. With an onSave to skip, that check reads the grants at every source.
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
        reads: conditionGroups[index],
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
  const perHitBySource = new Map<string, { hit: PMF; crit: PMF }[]>();
  for (const node of order) {
    if (node >= riderCount) continue;
    const rider = riders[node];
    if (rider.on !== "every-hit") continue;
    const hit = toPMF(rider.damage, eps, riderIds[node]);
    const payload = { hit, crit: critPMF(rider, hit, eps) };
    for (const sourceId of sourceIdsByNode[node]) {
      const existing = perHitBySource.get(sourceId);
      if (existing) existing.push(payload);
      else perHitBySource.set(sourceId, [payload]);
    }
  }
  const fold = (sourceId: string, outcome: "hit" | "crit", slice: PMF): PMF => {
    let folded = slice;
    for (const payload of perHitBySource.get(sourceId) ?? []) {
      folded = folded.convolve(payload[outcome], eps, true);
    }
    return folded;
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
   * substitute's `policy`; then the separate channels; then the `every-hit` fold;
   * then miss. Every split happens on the base payload, so neither the match odds
   * nor the transform ever see a separate channel's or the fold's dice.
   *
   * `fixed` draws belong to every variant. Each of `choices` is an above-threshold
   * landing that is held or spent depending on the walk state, so a variant takes
   * either its `hold` or its `spend` draws.
   */
  const drawsFor = (
    sourceId: string,
    slices: SourceSlices,
    policy: SubstitutePolicy | null
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
      const finish = (part: PMF): PMF =>
        fold(sourceId, outcome, separate ? part.convolve(separate, eps, true) : part);
      /** `part`'s draws: split by match odds on its value, unless its dice's match status is `known`. */
      const drawsOf = (part: PMF, spends: boolean, known?: boolean): Draw[] => {
        if (!info || known !== undefined) {
          return [{ outcome, matched: known ?? false, spends, slice: finish(part) }];
        }
        const [matched, unmatched] = part.splitByFactor(
          (damage) => info.matchProbabilityByDamage.get(damage) ?? 0
        );
        return [
          { outcome, matched: true, spends, slice: finish(matched) },
          { outcome, matched: false, spends, slice: finish(unmatched) },
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
    fixed.push({ outcome: "miss", matched: false, spends: false, slice: slices.miss });
    return { fixed, choices };
  };

  // --- steps -----------------------------------------------------------------
  const updatesById = new Map<string, number[]>();
  groupSources.forEach((sourceIds, groupIndex) => {
    for (const sourceId of sourceIds) {
      const existing = updatesById.get(sourceId);
      if (existing) existing.push(groupIndex);
      else updatesById.set(sourceId, [groupIndex]);
    }
  });

  /**
   * Per substitute: can a step it watches still land, from step `from` on, in the
   * state (`codes`, `fired`)? Exact reachability over the walk's own transitions —
   * every positive-mass draw of each later step's plain variant — memoized on the
   * state. It reads the same group codes and fire slots the walk keys on, so a
   * threshold never holds for a watched step that can no longer fire.
   */
  const steps: Step[] = [];
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
        result = canLand(from + 1, codes, fired);
      } else {
        const next = step.slot === -1 ? fired : fired.map((slot, index) => (index === step.slot ? mode : slot));
        result =
          step.variants.length === 0
            ? canLand(from + 1, codes, next)
            : step.variants[0].some(
                (draw) =>
                  draw.slice.mass() > eps &&
                  ((draw.outcome !== "miss" && watched.has(step.id)) ||
                    canLand(from + 1, advanced(codes, step.updates, draw.outcome, draw.matched), next))
              );
      }
      memo.set(key, result);
      return result;
    };
    return canLand;
  });

  const plainSelect = (): number => 0;
  sequence.forEach((entry, stepIndex) => {
    const rider = entry.rider === -1 ? null : riders[entry.rider];
    const slices =
      entry.attack !== -1
        ? (attackSlices[entry.attack] ?? {
            hit: attackPMFs[entry.attack],
            crit: PMF.emptyMass(),
            miss: PMF.emptyMass(),
          })
        : slicesOf(entry.id);

    if (rider && slices && rider.critDamage !== undefined) {
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

    const updates = updatesById.get(entry.id) ?? [];
    let variants: StepVariant[] = [];
    let select: Step["select"] = plainSelect;
    const substitute = slices ? substituteBySource.get(entry.id) : undefined;
    const spendSlot =
      substitute === undefined ? -1 : (fireSlots.get(substituteIds[substitute]) as number);

    /**
     * The plain draws and, under a substitute, one variant per hold mask (variant 1 +
     * mask: bit i set ⇔ choice i is held; only a threshold policy has choices), for
     * one roll context's slices.
     */
    const table = (
      contextSlices: SourceSlices
    ): { variants: StepVariant[]; select: (codes: readonly number[], fired: readonly FireMode[]) => number } => {
      const plain = drawsFor(entry.id, contextSlices, null).fixed;
      if (substitute === undefined) return { variants: [plain], select: plainSelect };
      const { fixed, choices } = drawsFor(
        entry.id,
        contextSlices,
        substitutes[substitute].policy ?? { kind: "always" }
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
        // substitute unspent. Otherwise holding is worth nothing, so it spends.
        select: (codes, fired) => {
          if (fired[spendSlot] !== null) return 0;
          let mask = 0;
          choices.forEach((choice, bit) => {
            if (canLand(stepIndex + 1, advanced(codes, updates, choice.outcome, choice.matched), fired)) {
              mask |= 1 << bit;
            }
          });
          return 1 + mask;
        },
      };
    };

    const readMask = readMaskAt[stepIndex];
    if (slices && readMask === 0) {
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
      select = (codes, fired, flags) => {
        const read = flags & readMask;
        let key = 0;
        for (let bit = 0; read >> bit !== 0; bit++) {
          if (read & (1 << bit)) key |= modifiersOfBit[bit];
        }
        const index = tableOfKey[key];
        return offsets[index] + tables[index].select(codes, fired);
      };
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
      reads: rider ? (readsByRider.get(entry.rider) ?? -1) : -1,
      slot: rider ? (fireSlots.get(entry.id) as number) : -1,
      negates: negated,
      spendSlot,
      consumes: consumesAt[stepIndex],
      grants: grantsAt[stepIndex],
    });
  });

  // Group last-read indices (see the `groupLastReadStep` field docs). `perHitGroups` groups are
  // read only at the final collapse, so they stay live the whole walk.
  const groupLastReadStep = new Array<number>(groupSources.length).fill(-1);
  steps.forEach((step, stepIndex) => {
    // A first-hit / first-miss grant reads its group's pre-draw code at its source step.
    for (const reads of [step.reads, ...step.grants.map((app) => app.reads)]) {
      if (reads !== -1) groupLastReadStep[reads] = Math.max(groupLastReadStep[reads], stepIndex);
    }
  });
  for (const group of perHitGroups.values()) {
    groupLastReadStep[group] = steps.length;
  }

  const rerollIds = riderIds.filter((id, index) => {
    const on = riders[index].on;
    return (on === "any-miss" || on === "first-miss") && slicesOf(id) !== null;
  });

  return {
    steps,
    groupCount: groupSources.length,
    attackPMFs,
    attackIds,
    riderIds,
    substituteIds,
    rerollIds,
    fireSlots,
    slotCount: fireSlots.size,
    perHitGroups,
    groupLastReadStep,
    conditionIds,
    flagLastReadStep: liveFlags.map((flag) => flag.lastRead),
  };
}
