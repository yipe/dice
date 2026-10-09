import type { Check } from "../builder/types";
import type { Bin, RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import { DiceQuery } from "../pmf/query";
import type { ConditionOptions, EveryHitOptions, FirstHitOptions, Lasting, StartEffect, Transform } from "./effects";
import { effectSpec, gateFields, isGrant, isTransform, lastingForTurn, substituteFields } from "./effects";
import type { Draw, EffectSource, FireMode, Step, TurnPlan } from "./plan";
import { ReaderTally, canonicalCodes, cappedPmf, codeNeeds, readerLedger, EFFECT_NAMES } from "./readers";
import type { EffectName, LandingPattern, ReaderDamage, RowLanding } from "./readers";
import { buildPlan, checkDuplicateIds, checkSaveRowAbility, checkStateLimit, declaredAttacks, fireMode, grantApplies, isStateless, released } from "./plan";
import { contextOf, rowCheckOf } from "./context";
import { advance, CRIT_BIT, FIRST_NONE, START_CODE } from "./state";
import type {
  Attack,
  AttackOptions,
  AttackTriggerOn,
  ConditionSpec,
  Damage,
  ProbeSpec,
  Rider,
  RiderDamage,
  RiderOptions,
  Source,
  SubstituteSpec,
  TurnSpec,
} from "./types";
import { TurnSpecError } from "./types";

/** Everything a `Turn` is built from, plus what its chaining methods remember. */
interface TurnState {
  attacks: readonly Attack[];
  riders: readonly Rider[];
  substitutes: readonly SubstituteSpec[];
  conditions: readonly ConditionSpec[];
  observe: readonly ProbeSpec[];
  /** See {@link TurnSpec.stateLimit}; set by {@link Turn.stateLimit}. */
  stateLimit?: number;
  /** Set on the turns an optional search walks: their optional conditions are already decided. */
  optionalDecided?: true;
  /** The optional conditions such a turn does not attempt, by id. */
  declined?: readonly string[];
  /**
   * A chaining call defaulted some rider's, substitute's or condition's `of`.
   * Appending an attack now would leave it out of that set silently, so it throws
   * instead.
   */
  defaulted: boolean;
  /** What the last chaining call added — the target of {@link Turn.otherwise}. */
  last: { kind: "rider" | "substitute"; index: number } | null;
}

/** What a trigger verb accepts: damage, effects with a lifetime, or both in one list. */
type Effect = RiderDamage | Lasting | readonly (Damage | Lasting)[];

/**
 * Per-step statistics of a turn's walk, for one attack or attack-shaped rider.
 * Every field is a probability (mass): `rolled` is the mass in which the step
 * drew at all — 1 for a declared attack, a rider's fire mass for an attack-shaped
 * rider — `hit`/`crit` the mass of those draws that landed (crit included) / were
 * crits, and `live` the mass in which each effect was in force when the step read
 * its flags, before the step consumes anything (for a declared attack, whether or
 * not it happens), with the part each source accounts for (sources overlap, so they
 * need not add up). `conditions` lists each condition the step tried: the mass in
 * which it was attempted here and in which it took (no save, or the save failed).
 */
export interface StepStats {
  rolled: number;
  hit: number;
  crit: number;
  live: LiveOdds;
  conditions: readonly ConditionAttempt[];
}

/** What every walk counts as it goes, in its unnormalized mass units, per step (per every-hit rider for applications). */
interface WalkCounts {
  stateCounts: number[];
  /** The mass in which a step drew at all. */
  rolled: number[];
  /** The mass of its hit (crit included) / crit draws. */
  hitMass: number[];
  critMass: number[];
  /** The mass in which the matching modifier flag was set when the step read its flags. */
  liveAdvantage: number[];
  liveDisadvantage: number[];
  liveCritOnHit: number[];
  /** Per every-hit rider, the mass of the draws it applied to: its expected number of applications. */
  applicationMass: number[];
}

/** What a walk counts per attack-shaped id: the 0.16 `stepStats` fields. */
type WalkStats = Pick<StepStats, "rolled" | "hit" | "crit"> & {
  live: { advantage: number; disadvantage: number; critOnHit: number };
};

/** The odds of each effect in force when a row rolls, and the part each source accounts for. */
export type LiveOdds = Readonly<Record<EffectName, number>> & {
  sources: Readonly<Record<EffectName, readonly { source: EffectSource; odds: number }[]>>;
};

/** A condition a row can try: the odds it is attempted there and the odds it takes. */
export interface ConditionAttempt {
  id: string;
  attempted: number;
  taken: number;
}

/** An attack's (or attack-shaped rider's) marginal. */
export interface AttackMarginal {
  /** Its damage: `whenHappens` thinned by `occurs`. */
  pmf: PMF;
  /** Its damage in the states where it happens. */
  whenHappens: PMF;
  /** The odds it happens: its `chance`, its gate, and for an attack-shaped rider the odds it fires. */
  occurs: number;
  /** The odds of the d20 it rolls, in every state (for a declared attack, whether or not it happens). */
  rollType: Readonly<Record<RollType, number>>;
}

/** A damage rider's marginal; `landings` by attack id, before its `happens`. */
export interface RiderMarginal {
  pmf: PMF;
  landings: ReadonlyMap<string, RowLanding>;
  /** P(it lands at least once), before its `happens`: {@link Turn.fireProbability}. */
  anyLanding: number;
}

/** The reader walk's tallies (see {@link Turn.resolveReaders}). */
interface Readers {
  tally: ReaderTally;
  states: readonly ReaderDamage[];
  /** The masses' divisor: the terminal mass where it drifts from 1, else 1. */
  total: number;
  /** Firing masses and expected applications, already divided by `total`. */
  fireMass: ReadonlyMap<string, number>;
  applications: ReadonlyMap<string, number>;
  /** Per attack-shaped id, what the walk counted of it, divided by `total`. */
  stepStats: ReadonlyMap<string, WalkStats>;
  unexact: ReadonlySet<string>;
  peakStates: number;
}

/** Test seam: the plan a turn walks and, once resolved, its walk size. Not exported from the package. */
const inspections = new WeakMap<Turn, { plan: () => TurnPlan; stateCounts?: readonly number[] }>();

/**
 * Test seam: whether every turn walks its plan, stateless or not. Not exported from the
 * package; `tests` set it to prove the stateless path reads what the walk reads.
 */
export const walkEverything = { forced: false };

/** Test seam: the plan `t` walks (built on first use for a stateless turn). Not exported from the package. */
export function inspectPlan(t: Turn): TurnPlan {
  return (inspections.get(t) as { plan: () => TurnPlan }).plan();
}

/**
 * The number of trigger groups `t` tracks and, per step, the number of distinct
 * walk states after it. Resolves `t` if it has not been resolved yet.
 */
export function inspectTurn(t: Turn): { groupCount: number; stateCounts: readonly number[] } {
  t.mean();
  const inspection = inspections.get(t) as { plan: () => TurnPlan; stateCounts: readonly number[] };
  return { groupCount: inspection.plan().groupCount, stateCounts: inspection.stateCounts };
}

/**
 * One declared attack of a stateless turn: what its readers are closed forms of. `hit` and
 * `crit` are the masses of its landings given it happens (`hit` crit included), as the walk draws
 * them: a row with no hit or crit outcome (a save, a plain roll) is one "hit" draw of its whole PMF.
 */
interface StatelessRow {
  id: string;
  pmf: PMF;
  chance: number;
  rollType: RollType;
  hit: number;
  crit: number;
}

/**
 * The rows of a stateless turn (`isStateless`), validated as `buildPlan` validates them and in
 * the same order: the state limit, each attack in turn, duplicate ids, then each save row's
 * ability. A row's d20 is its own (no effect is ever in force): what its source declares, or
 * `flat` for one that declares none.
 */
function statelessRows(spec: TurnSpec, eps: number): StatelessRow[] {
  checkStateLimit(spec.stateLimit);
  const declared = declaredAttacks(spec, eps);
  checkDuplicateIds(declared.map((row) => row.id));
  for (const row of declared) checkSaveRowAbility(row, eps);
  return declared.map(({ id, source, chance, pmf, slices }) => {
    const check = rowCheckOf(source);
    return {
      id,
      pmf,
      chance,
      rollType: check === undefined ? "flat" : contextOf(check, 0).rollType,
      hit: slices === null ? pmf.mass() : slices.hit.mass() + slices.crit.mass(),
      crit: slices === null ? 0 : slices.crit.mass(),
    };
  });
}

/** What a stateless turn's readers list for what it has none of: ids, attempts. */
const NONE: readonly never[] = Object.freeze([]);

/** The effects in force on a stateless turn's rows: none, from no source. */
const NO_LIVE: LiveOdds = Object.freeze({
  ...(Object.fromEntries(EFFECT_NAMES.map((name) => [name, 0])) as Record<EffectName, number>),
  sources: Object.freeze(Object.fromEntries(EFFECT_NAMES.map((name) => [name, NONE])) as Record<EffectName, readonly never[]>),
});

/** How many optional conditions a turn searches over (the engine's `MAX_SEARCHED_OPTIONAL_GRANTS`). */
const MAX_SEARCHED_OPTIONAL = 3;

/**
 * What a walk state carries for the damage dealt so far. The full walk carries a PMF; a walk
 * that reads probabilities alone carries only the mass of the paths a state stands for, so no
 * damage arithmetic runs at all.
 */
interface Ledger<D> {
  start: D;
  mass(damage: D): number;
  add(a: D, b: D): D;
  scale(damage: D, factor: number): D;
  /**
   * `damage` with a draw's sub-mass `slice` (or a pure-damage payload) folded in. `step` and
   * `draw` say where it came from, for a ledger that keeps one id's damage alone.
   */
  convolve(damage: D, slice: PMF, step: Step, draw?: Draw): D;
}

function pmfLedger(eps: number): Ledger<PMF> {
  return {
    start: PMF.delta(0, eps),
    mass: (damage) => damage.mass(),
    add: (a, b) => a.add(b),
    scale: (damage, factor) => damage.scaleMass(factor),
    // Uncached: a running total is convolved once and never seen again.
    convolve: (damage, slice) => damage.convolveRaw(slice, eps),
  };
}

const massLedger: Ledger<number> = {
  start: 1,
  mass: (damage) => damage,
  add: (a, b) => a + b,
  scale: (damage, factor) => damage * factor,
  convolve: (damage, slice) => damage * slice.mass(),
};

/**
 * A ledger that keeps the damage of one id alone (a row's own roll, or a rider's payloads) and
 * the mass of every path: walked like the joint, its terminal states sum to that id's marginal.
 */
function marginalLedger(id: string, eps: number): Ledger<PMF> {
  return {
    ...pmfLedger(eps),
    convolve: (damage, slice, step, draw) => {
      if (draw === undefined) return step.id === id ? damage.convolveRaw(slice, eps) : damage;
      if (step.id === id) return damage.convolveRaw(draw.own ?? slice, eps);
      const payload = draw.riders?.find(([rider]) => rider === id)?.[1];
      const scaled = damage.scaleMass(slice.mass());
      return payload === undefined ? scaled : scaled.convolveRaw(payload, eps);
    },
  };
}

/**
 * The walk's state: the group codes, the damage so far, which riders fired, the flag word and
 * the per-condition applied mass.
 */
interface WalkState<D> {
  codes: number[];
  damage: D;
  fired: FireMode[];
  flags: number;
  /**
   * Per condition, the part of `damage`'s mass in which it was applied at least once
   * while a later step read it. Carried as mass rather than as a key bit: whether
   * it was applied changes no later transition, so it must not split states.
   */
  applied: number[];
  /**
   * Per counter, how many landings its capped riders have applied to so far. It is what selects
   * a with-rider or a without-rider draw, so it splits states, but only while the cap can still
   * bind (see `Step.settled`).
   */
  counts: number[];
}

/** `pmf` given that it happens: its `missNone` mass at 0 beyond `1 - occurs` kept, the rest scaled up. */
function unthinned(pmf: PMF, occurs: number): PMF {
  const bins = new Map<number, Bin>();
  const freed = 1 - occurs;
  for (const [damage, bin] of pmf.map) {
    if (damage !== 0) {
      bins.set(damage, { ...bin, p: bin.p / occurs });
      continue;
    }
    const missNone = Math.max(0, (bin.count.missNone ?? 0) - freed);
    const p = Math.max(0, bin.p - freed) / occurs;
    if (p > 0) bins.set(0, { ...bin, p, count: { ...bin.count, missNone: missNone / occurs } });
  }
  return new PMF(bins, pmf.epsilon);
}

/**
 * Per attack-shaped id (a declared attack, or a rider that rolls its own attack: anything with
 * variants), what a walk counted of its steps, divided by `total`. A rider that fires at several
 * positions in the rail (a `first-miss` reroll watching many attacks) has one step per position
 * under one id; those steps are mutually exclusive, so their masses sum.
 */
function stepStatsOf(
  plan: TurnPlan,
  walked: Pick<WalkCounts, "rolled" | "hitMass" | "critMass" | "liveAdvantage" | "liveDisadvantage" | "liveCritOnHit">,
  total: number
): Map<string, WalkStats> {
  const stats = new Map<string, WalkStats>();
  plan.steps.forEach((step, s) => {
    if (step.variants.length === 0) return;
    const known = stats.get(step.id);
    const add = (counted: number, before = 0): number => before + counted / total;
    stats.set(step.id, {
      rolled: add(walked.rolled[s], known?.rolled),
      hit: add(walked.hitMass[s], known?.hit),
      crit: add(walked.critMass[s], known?.crit),
      live: {
        advantage: add(walked.liveAdvantage[s], known?.live.advantage),
        disadvantage: add(walked.liveDisadvantage[s], known?.live.disadvantage),
        critOnHit: add(walked.liveCritOnHit[s], known?.live.critOnHit),
      },
    });
  });
  return stats;
}

const noneFirstOf = new WeakMap<readonly Draw[], readonly Draw[]>();
/** `draws` with its "none" draw (the row did not happen), if any, first. */
function noneFirst(draws: readonly Draw[]): readonly Draw[] {
  let ordered = noneFirstOf.get(draws);
  if (ordered === undefined) {
    const none = draws.filter((draw) => draw.outcome === "none");
    ordered = none.length === 0 ? draws : [...none, ...draws.filter((draw) => draw.outcome !== "none")];
    noneFirstOf.set(draws, ordered);
  }
  return ordered;
}

/**
 * Whether a walk's terminal masses (which are unconditional probabilities, summing to 1)
 * drift from 1 by more than `eps` and so need dividing through. With `eps` 0, any drift does.
 */
function needsNormalizing(totalMass: number, eps: number): boolean {
  return Math.abs(totalMass - 1) > eps && totalMass > 0;
}

/**
 * A turn of attacks plus conditional damage riders, resolved to one **exact**
 * joint distribution.
 *
 * Riders are correlated with the attacks that trigger them, so a rider cannot be
 * a separate `DiceQuery` single convolved in afterwards: that preserves the mean
 * but corrupts the distribution (two daggers + Sneak Attack report P(0 damage) of
 * 0.015 instead of the true 0.1225). `Turn` owns the sources and enumerates the
 * joint outcome space instead, carrying one byte of state per trigger group.
 *
 * @example
 * const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
 * const rogue = turn([dagger, dagger]).rider({ damage: roll(3, d6), on: "first-hit" });
 * rogue.mean();     // 18.6225
 */
export class Turn {
  private readonly eps: number;
  private readonly state: TurnState;
  /** The plan every walk reads; built on first use for a stateless turn (see {@link Turn.rows}). */
  private built?: TurnPlan;
  /**
   * The rows of a turn that needs no walk state (`isStateless`): no rider, substitute, condition,
   * probe or gate. Every reader of such a turn is a closed form of its rows, so no plan is built
   * and nothing is walked unless a reader needs the plan (`pmf`, `toQuery`, `landings`).
   * `undefined` for a turn that carries state, or when {@link walkEverything} is forced.
   */
  private readonly rows?: { ids: readonly string[]; byId: ReadonlyMap<string, StatelessRow> };
  private resolved?: { pmf: PMF };
  /** Firing masses from a walk that carried no damage; see {@link Turn.fireProbability}. */
  private massed?: ReadonlyMap<string, number>;
  /** Per-id marginals, read from the reader walk; see {@link Turn.marginal}. */
  private readonly marginals = new Map<string, AttackMarginal | RiderMarginal>();
  private readers?: Readers;
  private patterns?: ReadonlyMap<string, ReadonlyMap<string, LandingPattern>>;
  /** The plan without probes, built on first use when there are probes (see {@link Turn.resolve}). */
  private plainPlan?: TurnPlan;
  /** The state the plan is built from: optional conditions decided (see {@link optionalChoice}). */
  private readonly planned: TurnState;

  private constructor(state: TurnState, eps: number) {
    // Copied, because a caller can hand in an array they still hold and keep
    // mutating it. Shallow is the right depth: the entries are builders and
    // PMFs this module does not own and which are immutable by convention
    // throughout this library.
    this.state = {
      ...state,
      attacks: [...state.attacks],
      riders: [...state.riders],
      substitutes: [...state.substitutes],
      conditions: [...state.conditions],
      observe: [...state.observe],
    };
    this.eps = eps;
    // Built here, not on first use, so every way of constructing a Turn
    // validates at the same moment: the call that introduced the mistake.
    if (eps === 0 && !walkEverything.forced && isStateless(this.state)) {
      // A stateless turn has no optional condition to decide: its plan, if a reader ever needs
      // it, is its own state's.
      const rows = statelessRows(this.state, eps);
      this.rows = { ids: rows.map((row) => row.id), byId: new Map(rows.map((row) => [row.id, row])) };
      this.planned = this.state;
    } else {
      ({ planned: this.planned, plan: this.built } = Turn.optionalChoice(this.state, eps));
    }
    inspections.set(this, { plan: () => this.plan });
  }

  private get plan(): TurnPlan {
    this.built ??= buildPlan(this.planned, this.eps, new Set(this.planned.declined), "masses");
    return this.built;
  }

  /**
   * `state` with its optional ("you can") conditions decided, as the engine decides them
   * (`optionalGrants.ts`): with up to {@link MAX_SEARCHED_OPTIONAL} of them, each subset is
   * attempted and the one with the highest mean is kept, the full set first so a tie (within
   * 1e-12) keeps it; past that, with no search, each is attempted where the later attack rolls on
   * its creature lean melee ({@link TurnPlan.meleeLeaning}). A declined one stays in the turn with
   * an explicit `of: []`, so it never lands and its id still reads.
   */
  private static optionalChoice(state: TurnState, eps: number): { planned: TurnState; plan: TurnPlan } {
    // The plan says which conditions are optional: declared ones and those attached to a source.
    const full = buildPlan(state, eps, new Set(state.declined), "masses");
    const optional = full.optionalIds;
    if (state.optionalDecided || optional.length === 0) return { planned: state, plan: full };
    const variant = (attempted: (id: string) => boolean): TurnState => ({
      ...state,
      optionalDecided: true,
      declined: optional.filter((id) => !attempted(id)),
    });
    if (optional.length > MAX_SEARCHED_OPTIONAL) {
      const planned = variant((id) => full.meleeLeaning[full.conditionIds.indexOf(id)]);
      return { planned, plan: buildPlan(planned, eps, new Set(planned.declined), "masses") };
    }
    // Each subset is scored as the engine scores it: the sum of the marginal means.
    let best: { turn: Turn; mean: number } | undefined;
    for (let mask = (1 << optional.length) - 1; mask >= 0; mask--) {
      const turn = new Turn(
        variant((id) => (mask & (1 << optional.indexOf(id))) !== 0),
        eps
      );
      const mean = turn.marginalMean();
      if (best === undefined || mean > best.mean + 1e-12) best = { turn, mean };
    }
    const { turn } = best as { turn: Turn };
    return { planned: turn.planned, plan: turn.plan };
  }

  /**
   * Builds a turn from plain data, throwing {@link TurnSpecError} if it is
   * malformed. Use this from a UI, where `error.code` maps to the field state to
   * show.
   *
   * A rider, substitute or condition with no `of` watches every declared attack
   * plus the attack-shaped `any-miss` / `first-miss` rerolls — for a rider, those
   * listed before it — the same sources the chaining spelling snapshots.
   */
  static from(spec: TurnSpec, eps: number = 0): Turn {
    const riders = spec.riders ?? [];
    const substitutes = spec.substitutes ?? [];
    const conditions = spec.conditions ?? [];
    const observe = spec.observe ?? [];
    const last: TurnState["last"] = riders.length
      ? { kind: "rider", index: riders.length - 1 }
      : substitutes.length
        ? { kind: "substitute", index: substitutes.length - 1 }
        : null;
    return new Turn(
      {
        attacks: spec.attacks,
        riders,
        substitutes,
        conditions,
        observe,
        defaulted: false,
        last,
        ...(spec.stateLimit === undefined ? {} : { stateLimit: spec.stateLimit }),
      },
      eps
    );
  }

  private with(changes: Partial<TurnState>): Turn {
    return new Turn({ ...this.state, ...changes }, this.eps);
  }

  /**
   * What a chaining call's omitted `of` means: the attacks so far, plus any reroll so far. With
   * none yet it stays omitted, so the call fails as having no sources (an explicit `of: []` is a
   * reader of nothing instead).
   */
  private defaultOf(): readonly string[] | undefined {
    const of = this.rows === undefined ? [...this.plan.attackIds, ...this.plan.rerollIds] : this.attackIds;
    return of.length === 0 ? undefined : of;
  }

  /**
   * Appends an attack, throwing {@link TurnSpecError} if that makes the turn
   * invalid. Pass an id (or `{ id, tag }`) to name it in `of`; a `tag` can be
   * shared by several attacks and names all of them at once.
   *
   * Declare attacks before the riders that watch them. A rider added without an
   * `of` watches the attacks declared *so far*, so appending one after it throws
   * `attack-after-rider` rather than silently leaving the new attack out. Give
   * that rider an explicit `of` to pin it to the attacks it already saw.
   */
  attack(source: Source, options?: string | AttackOptions): Turn {
    this.refuseAttackAfterRider();
    const opts: AttackOptions = typeof options === "string" ? { id: options } : (options ?? {});
    const { id, tag, chance, ...rest } = opts;
    const extra = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    const entry: Attack =
      id === undefined && tag === undefined && chance === undefined && Object.keys(extra).length === 0
        ? source
        : { id, tag, chance, ...extra, source };
    return this.with({ attacks: [...this.state.attacks, entry] });
  }

  /**
   * Appends `count` copies of the same attack — the Extra Attack case, which is
   * most of 5e. Argument order mirrors `roll(count, die)`. `tag` names every copy
   * at once in a later `of`.
   *
   * ```ts
   * turn().attacks(4, greatsword).onEveryHit(d6); // fighter 20 + hunter's mark
   * ```
   *
   * @throws {RangeError} if `count` is not a positive integer.
   */
  attacks(count: number, source: Source, options: { tag?: string; chance?: number } = {}): Turn {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(
        `attacks(count) needs a positive integer, got ${count}.`
      );
    }
    this.refuseAttackAfterRider();
    const entry: Attack =
      options.tag === undefined && options.chance === undefined
        ? source
        : { tag: options.tag, chance: options.chance, source };
    const added: Attack[] = new Array<Attack>(count).fill(entry);
    return this.with({ attacks: [...this.state.attacks, ...added] });
  }

  private refuseAttackAfterRider(): void {
    if (!this.state.defaulted) return;
    throw new TurnSpecError(
      "attack-after-rider",
      "",
      "An attack was added after a rider or substitute whose `of` defaulted to the attacks declared before it, so the new attack would be silently left out. Declare attacks first, or give that rider an explicit `of`."
    );
  }

  /**
   * Appends a rider, throwing {@link TurnSpecError} if that makes the turn
   * invalid. The `onX` methods below are the readable way to call this.
   *
   * An omitted `of` is filled in here, not when the plan is built: the attacks
   * declared so far, plus any attack-shaped `any-miss` / `first-miss` rider
   * declared so far. Nothing else joins — not `every-hit` riders, not
   * damage-shaped riders, not a list of several attacks, not `dice-match` beams
   * (name those explicitly).
   */
  rider(rider: Rider): Turn {
    const defaults =
      rider.on !== "not-fired" && rider.on !== "dice-match" && rider.of === undefined;
    const entry = (defaults ? { ...rider, of: this.defaultOf() } : rider) as Rider;
    return this.with({
      riders: [...this.state.riders, entry],
      defaulted: this.state.defaulted || defaults,
      last: { kind: "rider", index: this.state.riders.length },
    });
  }

  /**
   * Adds what one trigger-verb call describes: its damage as a rider, its grants as
   * a condition over the same `of`. The gate (`save` / `chance` / `onSave`) applies
   * to the grants only; the damage lands whatever the save does. With both, `id`
   * names the rider and the condition takes the default `condition N`.
   */
  private addEffect(on: AttackTriggerOn | "first-crit", effect: Effect, options: EveryHitOptions): Turn {
    const { save, chance, onSave, dealing, optional, happens, ...riderOptions } = options;
    const parts: readonly unknown[] = Array.isArray(effect) ? effect : [effect];
    const grants = parts.filter(isGrant);
    const damage = parts.filter((part) => !isGrant(part)) as Damage[];
    if (on === "first-crit" && damage.length > 0) {
      throw new TurnSpecError(
        "unsupported-trigger",
        riderOptions.id ?? "",
        "onFirstCrit applies effects; damage on a crit is onAnyCrit."
      );
    }
    const coin = happens === undefined ? {} : { happens };
    if (grants.length === 0) {
      if ([save, chance, onSave, dealing, optional].some((field) => field !== undefined)) {
        throw new Error(
          "save, chance, onSave, dealing and optional shape effects only, and this call has none: damage is never gated by them. Pass a SaveBuilder as the damage for damage that depends on a save."
        );
      }
      return this.rider({ ...riderOptions, ...coin, damage: effect as RiderDamage, on: on as AttackTriggerOn });
    }
    if (riderOptions.max !== undefined || riderOptions.perSource !== undefined) {
      throw new Error(
        "max and perSource shape a damage rider, and this call has grants: a grant is never capped and has no payload. Add the damage in its own call."
      );
    }
    if (damage.length === 0 && riderOptions.critDamage !== undefined) {
      throw new TurnSpecError(
        "unused-crit-damage",
        riderOptions.id ?? "",
        "A grant deals no damage, so critDamage has nothing to apply to."
      );
    }
    if (damage.length === 0 && happens !== undefined) {
      throw new Error("happens is a damage rider's coin, and this call has no damage; use chance for effects.");
    }
    if (damage.length === 0 && riderOptions.joins !== undefined) {
      throw new Error("joins pools a damage rider's dice into a row, and this call has no damage.");
    }

    const of = riderOptions.of ?? this.defaultOf();
    const condition: ConditionSpec = {
      ...(damage.length === 0 && riderOptions.id !== undefined ? { id: riderOptions.id } : {}),
      on,
      of,
      ...(riderOptions.where === undefined ? {} : { where: riderOptions.where }),
      ...gateFields(options, this.eps),
      grants: grants.map(effectSpec),
    };
    const riders =
      damage.length === 0
        ? this.state.riders
        : [...this.state.riders, { ...riderOptions, ...coin, of, damage, on } as Rider];
    return this.with({
      riders,
      conditions: [...this.state.conditions, condition],
      defaulted: this.state.defaulted || riderOptions.of === undefined,
      last: damage.length === 0 ? null : { kind: "rider", index: this.state.riders.length },
    });
  }

  /**
   * Applies effects on the first crit among `of` only — beside {@link Turn.onAnyCrit}, which
   * applies them on every crit. Damage on a crit is `onAnyCrit`.
   */
  onFirstCrit(effect: Lasting | readonly Lasting[], options: ConditionOptions = {}): Turn {
    return this.addEffect("first-crit", effect, options);
  }

  /**
   * What a creature already has when the turn starts: `atStart(restrained())`. An effect
   * without a lifetime lasts the turn. `target` names the creature; omitted, the target.
   */
  atStart(effect: StartEffect | readonly StartEffect[], options: { target?: string } = {}): Turn {
    const effects: readonly StartEffect[] = Array.isArray(effect) ? effect : [effect as StartEffect];
    const condition: ConditionSpec = {
      on: "start",
      ...(options.target === undefined ? {} : { target: options.target }),
      grants: effects.map((entry) => effectSpec(lastingForTurn(entry))),
    };
    return this.with({ conditions: [...this.state.conditions, condition] });
  }

  /** The most distinct turn states the walk may carry; more is `too-many-states`. */
  stateLimit(limit: number): Turn {
    return this.with({ stateLimit: limit });
  }

  /**
   * Fires once, on the first source that lands, in that source's mode — so a
   * crit on the first landing attack doubles the rider's dice. Sneak Attack.
   *
   * Given a {@link Transform} such as `keepBestDamage()` instead of damage, it
   * adds a once-per-turn substitute: the first watched landing its policy accepts
   * draws the transformed base payload instead. One call covers every watched
   * attack; a second over any of the same attacks is `duplicate-substitute`. A
   * substitute allocates no trigger group. `fireProbability(id)` is P(spent).
   *
   * Given a {@link Grant}, the first landing applies it once — a passed save is
   * final for the turn:
   *
   * ```ts
   * turn([fist, fist, fist]).onFirstHit(advantage().critOnHit().untilEndOfTurn(), { chance: 0.4 });
   * ```
   *
   * `perSource` gives a payload that depends on which attack landed first: the row's damage
   * type or the target's scale for it. A watched attack not listed deals `effect`.
   *
   * ```ts
   * turn([fire, cold]).onFirstHit(d6, { perSource: { "attack 2": { damage: d8 } } });
   * ```
   *
   * A per-source rider is one rider like any other: `fireProbability`, `otherwise` and
   * `not-fired` read it as they read a plain first hit.
   */
  onFirstHit(effect: Effect | Transform, options: FirstHitOptions = {}): Turn {
    if (!isTransform(effect)) return this.addEffect("first-hit", effect, options);
    if (options.save !== undefined || options.chance !== undefined || options.onSave !== undefined) {
      throw new Error("save, chance and onSave gate grants only; a transform is not gated by them.");
    }
    if (options.perSource !== undefined) {
      throw new Error("A transform rewrites the attack's own payload, so it has no payload per source.");
    }
    const ignored = (["happens", "dealing", "optional", "where", "joins"] as const).find((field) => options[field] !== undefined);
    if (ignored !== undefined) {
      throw new TurnSpecError(
        "unsupported-trigger",
        options.id ?? "",
        `A transform is a once-per-turn substitute for the attack's own payload, so it takes no "${ignored}".`
      );
    }
    if (options.critDamage !== undefined) {
      throw new TurnSpecError(
        "unused-crit-damage",
        options.id ?? "",
        "A transform rewrites the attack's own payload, so critDamage has nothing to apply to."
      );
    }
    if (options.landing !== undefined) {
      throw new TurnSpecError(
        "unsupported-trigger",
        options.id ?? "",
        "A transform rewrites the attack's own payload, so a landing kind (how a rider reads a save row) has nothing to apply to."
      );
    }
    const substitute: SubstituteSpec = {
      ...(options.id === undefined ? {} : { id: options.id }),
      on: "first-hit",
      of: options.of ?? this.defaultOf(),
      ...substituteFields(effect),
    };
    return this.with({
      substitutes: [...this.state.substitutes, substitute],
      defaulted: this.state.defaulted || options.of === undefined,
      last: { kind: "substitute", index: this.state.substitutes.length },
    });
  }

  /**
   * Fires once if any source crit, always in crit mode. Divine Smite: nothing is
   * lost by holding it for a crit, so this is "any", not "first".
   *
   * Given a {@link Grant}, every crit applies it.
   */
  onAnyCrit(effect: Effect, options: ConditionOptions = {}): Turn {
    return this.addEffect("any-crit", effect, options);
  }

  /**
   * Fires once if any source missed. A reroll is a fresh attack, so pass one as
   * the damage.
   *
   * Its step runs after every declared attack. That is exact when the reroll is
   * identically distributed to the attacks after the one it replaces; when it is
   * not, or a later rider reads the order things landed in, use
   * {@link Turn.onFirstMiss}. A reroll that reads a granted modifier or applies a
   * condition's grants throws `unsupported-trigger`: use {@link Turn.onFirstMiss}.
   */
  onAnyMiss(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "any-miss" });
  }

  /**
   * Fires once, on the first source that misses, and resolves directly after that
   * attack — so a reroll lands in turn order, before the attacks that follow it,
   * and reads the grants in force at that point. The exact model of "when you
   * miss, you may reroll": Kensei's Unerring Accuracy, Lucky.
   */
  onFirstMiss(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "first-miss" });
  }

  /**
   * Fires once per source that lands, in that hit's mode — so it can fire several
   * times in a turn. Hunter's Mark, Hex, Rage.
   *
   * `max` caps it: the damage applies to at most `max` landings among `of`, in turn
   * order, each in its own hit's mode (a crit doubles that application's dice). Superiority
   * dice, "the first two hits". Each watched attack carries a with-rider and a
   * without-rider draw, chosen by how many landings the rider has already applied to,
   * so the result is exact, and `max: 1` is {@link Turn.onFirstHit} spelled as a cap.
   * `fireProbability(id)` is P(applied at least once), which is P(some watched source
   * landed); {@link Turn.expectedApplications} is the expected number of applications.
   *
   * ```ts
   * turn().attacks(3, sword).onEveryHit(d6, { max: 2, id: "dice" }); // two of the three hits
   * ```
   *
   * `perSource` gives a payload that depends on which attack landed: the row's damage type
   * or the target's scale for it. A watched attack not listed deals `effect`. With `max: 1`
   * it is a first-hit payload per landing source.
   *
   * ```ts
   * turn([fire, cold]).onEveryHit(d6, { max: 1, perSource: { "attack 2": { damage: d8 } } });
   * ```
   *
   * Given a {@link Grant}, every landing applies it, and a `save` or `chance` is
   * rolled again on each landing until it takes; `max` and `perSource` are refused, since
   * a grant is never capped:
   *
   * ```ts
   * turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack());
   * turn([axe, axe]).onEveryHit(advantage().untilEndOfTurn(), { save: d20.plus(2).dc(15) });
   * ```
   *
   * @throws {RangeError} if `max` is not a positive integer.
   */
  onEveryHit(effect: Effect, options: EveryHitOptions = {}): Turn {
    return this.addEffect("every-hit", effect, options);
  }

  /**
   * Damage for the turns where the rider added just before this one did *not*
   * fire: "flurry of blows if I didn't smite". After a transform, it fires when
   * the transform was never spent — under the default policy, when no watched
   * attack landed.
   *
   * ```ts
   * turn([dagger, dagger])
   *   .onAnyCrit(roll(2, d8))      // smite
   *   .otherwise([flurry, flurry]) // ... or two more attacks
   * ```
   *
   * Always binds to the *immediately* preceding rider, so the two are branches of
   * one decision and can never both land. Chaining it therefore alternates rather
   * than laddering: `a.otherwise(b).otherwise(c)` makes `c` fire whenever `b` did
   * not, which is exactly when `a` did. For a genuine three-way priority chain,
   * name the riders and use explicit `not-fired` triggers against the right one.
   */
  otherwise(
    damage: RiderDamage,
    options: Omit<RiderOptions, "of"> = {}
  ): Turn {
    const last = this.state.last;
    if (last === null) {
      throw new TurnSpecError(
        "unknown-id",
        "",
        "otherwise() needs a preceding rider to negate."
      );
    }

    // `of` must name the negated node, so give it the id `buildPlan` would.
    let target: string;
    const riders: Rider[] = [...this.state.riders];
    const substitutes: SubstituteSpec[] = [...this.state.substitutes];
    if (last.kind === "substitute") {
      const previous = substitutes[last.index];
      target = previous.id ?? `substitute ${last.index + 1}`;
      substitutes[last.index] = { ...previous, id: target };
    } else {
      const previous = riders[last.index];
      target = previous.id ?? `rider ${last.index + 1}`;
      if (previous.on === "every-hit" && previous.max !== 1) {
        throw new TurnSpecError(
          "not-an-attack",
          target,
          "otherwise() cannot negate an every-hit rider: it can fire more than once. `max: 1` is a first hit and can be negated."
        );
      }
      riders[last.index] = { ...previous, id: target };
    }
    riders.push({ ...options, damage, on: "not-fired", of: target });
    return this.with({
      riders,
      substitutes,
      last: { kind: "rider", index: riders.length - 1 },
    });
  }

  /**
   * Fires once if any of `of`'s named sources' own damage dice matched (showed a
   * duplicate value) on hit or crit — Chromatic Orb's bounce. Unlike the other
   * `onX` triggers, `of` is required: "the dice matched" has no coherent meaning
   * defaulted across every declared attack. Each named source must expose a
   * dice-match descriptor (an `AttackBuilder`-shaped source does); naming one
   * that doesn't is a `TurnSpecError("no-dice-descriptor", ...)`.
   *
   * Most callers want {@link bounce} instead of calling this directly — it
   * builds the whole depth-capped chain of attack-shaped riders.
   */
  onDiceMatch(
    of: readonly string[],
    damage: RiderDamage,
    options: Omit<RiderOptions, "of"> = {}
  ): Turn {
    return this.rider({ ...options, damage, on: "dice-match", of });
  }

  /**
   * Adds a probe: a probability the walk reports without adding any damage, read with
   * {@link Turn.fireProbability} under `probe.id` (see {@link ProbeSpec}). An omitted `of` is
   * filled in here like a rider's: the attacks declared so far, plus any attack-shaped
   * `any-miss` / `first-miss` rider declared so far.
   *
   * A probe keeps its source set live to the end of the walk, so it counts against
   * {@link MAX_TRIGGER_GROUPS} for the whole turn.
   */
  observe(probe: ProbeSpec): Turn {
    return this.with({
      observe: [
        ...this.state.observe,
        probe.of === undefined ? { ...probe, of: this.defaultOf() } : probe,
      ],
      defaulted: this.state.defaulted || probe.of === undefined,
    });
  }

  /**
   * P(at least one of `of` crit), reported as `fireProbability(id)`: `turn(rows).observeAnyCrit("crit")`.
   * It comes from the walk itself, so a `critOnHit` grant, a reroll, a substitute and an attack's
   * `chance` are all accounted for, and it adds no damage. Reading only probes never builds a damage
   * distribution.
   */
  observeAnyCrit(id: string, options: { of?: readonly string[] } = {}): Turn {
    return this.observe({ ...options, id, on: "any-crit" });
  }

  /**
   * The same turn against a target with armor class `ac`: every attack with an
   * AC — declared, or carried by a rider (a reroll, a bonus attack) — is rebuilt
   * through `withCheck`. Saves, attacks with no AC to rebind, and bare PMFs pass
   * through unchanged, so a mixed attack/save turn still sweeps.
   *
   * ```ts
   * const base = turn([sword, sword]).onFirstHit(roll(3, d6));
   * [12, 14, 16, 18].map((ac) => base.vsAC(ac).mean());
   * ```
   *
   * @throws {TurnSpecError} `no-rebindable-source` if nothing in the turn has an AC.
   */
  vsAC(ac: number): Turn {
    if (!Number.isFinite(ac)) throw new RangeError(`vsAC(ac) needs a finite number, got ${ac}.`);
    let rebound = 0;
    // A source on several rows rebinds once, so the rows still share it (and the plan resolves it once).
    const reboundSources = new Map<Source, Source>();
    const rebind = <T extends Source>(damage: T): T => {
      const attack = damage as {
        check?: { attackConfig?: { ac?: number } };
        withCheck?: (fn: (check: Check) => Check) => T;
      };
      if (typeof attack.withCheck !== "function") return damage;
      if (typeof attack.check?.attackConfig?.ac !== "number") return damage;
      rebound++;
      let rebuilt = reboundSources.get(damage) as T | undefined;
      if (rebuilt === undefined) {
        rebuilt = attack.withCheck((check) => ({ ...check, ac }));
        reboundSources.set(damage, rebuilt);
      }
      return rebuilt;
    };
    const rebindAll = <T extends Rider["damage"]>(damage: T): T =>
      (Array.isArray(damage) ? damage.map(rebind) : rebind(damage as Damage)) as T;

    const attacks = this.state.attacks.map(
      (entry): Attack =>
        "source" in entry ? { ...entry, source: rebind(entry.source) } : rebind(entry)
    );
    const riders = this.state.riders.map(
      (rider): Rider => ({
        ...rider,
        damage: rebindAll(rider.damage),
        ...(rider.critDamage === undefined ? {} : { critDamage: rebindAll(rider.critDamage) }),
      })
    );
    if (rebound === 0) {
      throw new TurnSpecError(
        "no-rebindable-source",
        "",
        "vsAC() found nothing with an AC to rebind: every source is a save, an attack that always hits, or a bare PMF."
      );
    }
    return this.with({ attacks, riders });
  }

  /**
   * The exact joint distribution: mass 1, outcome-labelled. Resolved once and
   * cached.
   *
   * There is no `toPMF(eps)` to match the builders: a turn's epsilon is fixed
   * when it is constructed, because the plan is validated and its sources are
   * resolved at that point.
   */
  get pmf(): PMF {
    if (this.plan.dealing) {
      throw new TurnSpecError(
        "dealing-joint-unsupported",
        this.plan.conditionIds.join(", "),
        "A condition in this turn needs a damage type dealt (`dealing`): the turn knows only the odds a landing dealt it, so it reads every attack's and rider's marginal and the mean, but not the joint distribution."
      );
    }
    return this.resolve().pmf;
  }

  /**
   * Mean damage for the turn. With a `dealing` condition, the sum of every attack's and rider's
   * marginal mean (the mean is linear, so it is exact where the joint is not available).
   */
  mean(): number {
    return this.plan.dealing ? this.marginalMean() : this.pmf.mean();
  }

  /** The sum of every attack's and rider's marginal mean: the mean, from the reader walk alone. */
  private marginalMean(): number {
    return [...this.attackIds, ...this.riderIds].reduce((sum, id) => sum + this.marginal(id).pmf.mean(), 0);
  }

  /**
   * A query whose `singles` are the **declared attacks** and whose combined
   * distribution is the exact turn PMF.
   *
   * Riders are inside the combined PMF, not in `singles`, so singles-based
   * helpers (`probAtLeastOne`, `countSinglesWith`, `outcomeStats`) describe the
   * attacks only. Read rider-inclusive statistics off the combined PMF —
   * `outcomeTotals`, `outcomeDamageRanges`, `damageAttributionChartModel`.
   */
  toQuery(): DiceQuery {
    return new DiceQuery([...this.plan.attackSingles], this.pmf, this.eps);
  }

  /**
   * Attack ids in declaration order, including the `attack 1`, `attack 2`, …
   * defaults given to bare sources. These are the names `of` accepts.
   */
  get attackIds(): readonly string[] {
    return this.rows === undefined ? this.plan.attackIds : this.rows.ids;
  }

  /**
   * Rider ids in declaration order, including the `rider 1`, `rider 2`, …
   * defaults. These are the names {@link Turn.fireProbability} accepts.
   */
  get riderIds(): readonly string[] {
    return this.rows === undefined ? this.plan.riderIds : NONE;
  }

  /**
   * Substitute ids in declaration order, including the `substitute 1`, … defaults.
   * {@link Turn.fireProbability} accepts these too.
   */
  get substituteIds(): readonly string[] {
    return this.rows === undefined ? this.plan.substituteIds : NONE;
  }

  /**
   * Condition ids in declaration order, including the `condition 1`, … defaults.
   * {@link Turn.fireProbability} accepts these too.
   */
  get conditionIds(): readonly string[] {
    return this.rows === undefined ? this.plan.conditionIds : NONE;
  }

  /**
   * Probe ids in declaration order, including the `probe 1`, … defaults.
   * {@link Turn.fireProbability} accepts these too.
   */
  get probeIds(): readonly string[] {
    return this.rows === undefined ? this.plan.probeIds : NONE;
  }

  /**
   * The damage one attack, attack-shaped rider or rider deals this turn on its own: its
   * marginal distribution (a row's own roll in the contexts the turn puts it in, with its
   * `chance`; a rider's payloads wherever it lands), with the rest of the mass at 0. The means
   * of every attack's and rider's marginal add up to {@link Turn.mean}.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not an attack or a rider.
   */
  marginal(id: string): AttackMarginal | RiderMarginal {
    const known = this.marginals.get(id);
    if (known !== undefined) return known;
    if (!this.attackIds.includes(id) && !this.riderIds.includes(id)) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not an attack or rider in this turn. Attacks and riders: ${[...this.attackIds, ...this.riderIds]
          .map((each) => `"${each}"`)
          .join(", ")}.`
      );
    }
    const row = this.rows?.byId.get(id);
    if (row !== undefined) {
      // No state ever changes the row's context: it rolls its own PMF whenever it happens.
      const { pmf, chance, rollType } = row;
      const result: AttackMarginal = {
        pmf: pmf.applyHitFrequency(chance),
        whenHappens: pmf,
        occurs: chance,
        rollType: { flat: 0, advantage: 0, disadvantage: 0, "elven accuracy": 0, [rollType]: 1 },
      };
      this.marginals.set(id, result);
      return result;
    }
    const readers = this.resolveReaders();
    const plan = this.walkPlan;
    const rows = plan.steps.flatMap((step, s) => (step.id === id && step.contextPmfs.length !== 0 ? [s] : []));
    const result = rows.length !== 0 ? this.rowMarginal(id, rows, readers) : this.riderMarginal(id, readers);
    this.marginals.set(id, result);
    return result;
  }

  /**
   * A row's marginal from the reader walk: the mass of each context it rolls in times that
   * context's PMF. A row a substitute rewrites is not its contexts' PMFs, so its own damage is
   * walked instead.
   */
  private rowMarginal(id: string, rows: readonly number[], readers: Readers): AttackMarginal {
    const { tally, total } = readers;
    const steps = this.walkPlan.steps;
    let rolled = 0;
    let happened = 0;
    const rollType: Record<RollType, number> = { flat: 0, advantage: 0, disadvantage: 0, "elven accuracy": 0 };
    const contexts: [PMF, number][] = [];
    for (const s of rows) {
      happened += tally.happened[s];
      for (const type of Object.keys(rollType) as RollType[]) rollType[type] += tally.rollTypes[s][type] / total;
      steps[s].contextPmfs.forEach((pmf, context) => {
        const mass = tally.contextMass[s][context];
        if (mass <= 0) return;
        rolled += mass;
        contexts.push([pmf, mass]);
      });
    }
    const occurs = Math.min(1, happened / total);
    if (rows.some((s) => steps[s].transformed)) {
      const pmf = this.projectedMarginal(id);
      return { pmf, whenHappens: occurs > 0 ? unthinned(pmf, occurs) : PMF.delta(0, this.eps), occurs, rollType };
    }
    const whenHappens =
      contexts.length === 0
        ? PMF.delta(0, this.eps)
        : contexts.length === 1
          ? contexts[0][0]
          : PMF.mix(
              contexts.map(([pmf, mass]) => [pmf, mass / rolled]),
              0
            );
    const pmf = contexts.length === 0 ? PMF.missNone(this.eps) : whenHappens.applyHitFrequency(occurs);
    return { pmf, whenHappens, occurs, rollType };
  }

  /**
   * A damage rider's marginal from the reader walk: a capped rider's carried damage, or the mass
   * of each payload a rider that lands once lands with; the rest of the mass at 0.
   */
  private riderMarginal(id: string, readers: Readers): RiderMarginal {
    const { tally, total, states } = readers;
    const plan = this.walkPlan;
    const coin = plan.coins.find((each) => each.id === id);
    // A rider whose coin did not come up lands but carries no payload: its landings are counted
    // on the coin's side alone, and the coin is independent of them.
    const perLanding = coin === undefined ? total : total * coin.happens;
    // Every attack the rider watches, in declaration order, as the engine books it: one it never
    // lands on has zeros.
    const booked = tally.landings.get(id);
    const landings = new Map(
      (plan.riderRows.get(id) ?? []).map((row): [string, RowLanding] => {
        const landing = booked?.get(row) ?? { hit: 0, crit: 0, doubled: { hit: 0, crit: 0 } };
        return [
          row,
          {
            hit: landing.hit / perLanding,
            crit: landing.crit / perLanding,
            doubled: { hit: landing.doubled.hit / perLanding, crit: landing.doubled.crit / perLanding },
          },
        ];
      })
    );
    const anyLanding = (readers.fireMass.get(id) ?? 0) / total;
    const capped = plan.everyHitIds.indexOf(id);
    let pmf: PMF;
    if (capped !== -1 && readers.unexact.has(id)) pmf = this.projectedMarginal(id);
    else if (capped !== -1) pmf = cappedPmf(states, capped, total);
    else {
      const weights = [...(tally.onceWeights.get(id) ?? [])].map(([payload, mass]): [PMF, number] => [payload, mass / total]);
      const landed = weights.reduce((sum, [, weight]) => sum + weight, 0);
      pmf = PMF.mix([...weights, [PMF.missNone(this.eps), Math.max(0, 1 - landed)]], 0);
    }
    return { pmf, landings, anyLanding };
  }

  /** `id`'s marginal by a walk that carries its damage alone: for what the reader walk cannot read. */
  private projectedMarginal(id: string): PMF {
    const { states } = this.walk(marginalLedger(id, this.eps), this.walkPlan);
    let total = PMF.emptyMass();
    for (const state of states.values()) total = total.add(state.damage);
    return needsNormalizing(total.mass(), this.eps) ? total.normalize() : total;
  }

  /**
   * The reader walk: one walk carrying mass (and each capped rider's damage as a plain array)
   * that tallies every marginal reader. Cached, like the other walks.
   */
  private resolveReaders(): Readers {
    if (this.readers) return this.readers;
    const plan = this.walkPlan;
    const ledger = readerLedger(plan.everyHitIds);
    const tally = new ReaderTally(plan.steps, new Set(plan.everyHitIds), plan.perHitAny);
    const walked = this.walk(ledger, plan, tally);
    const { states, stateCounts } = walked;
    let mass = 0;
    for (const state of states.values()) mass += state.damage.mass;
    const total = needsNormalizing(mass, this.eps) ? mass : 1;
    const fireMass = this.tally(states, ledger, plan);
    const applications = new Map(plan.everyHitIds.map((id, rider) => [id, walked.applicationMass[rider]]));
    if (total !== 1) {
      for (const [id, each] of fireMass) fireMass.set(id, each / total);
      for (const [id, each] of applications) applications.set(id, each / total);
    }
    this.readers = {
      tally,
      states: [...states.values()].map((state) => state.damage),
      total,
      fireMass,
      applications,
      stepStats: stepStatsOf(plan, walked, total),
      unexact: ledger.unexact,
      peakStates: Math.max(1, ...stateCounts),
    };
    return this.readers;
  }

  /**
   * P(this rider fired). For an `every-hit` rider, capped or not, it is P(at least one
   * source hit): the first landing always applies it, since a cap is at least 1. It can
   * fire more than once in a turn; {@link Turn.expectedApplications} counts how often.
   * For a substitute it
   * is P(it was spent). For a condition it is P(its grants were applied at least
   * once where a later attack roll reads them) — on the fail branch of its save,
   * not the `onSave` one. Two attacks with "a hit gives the next attack
   * advantage" give P(attack 1 landed), since nothing reads attack 2's grant.
   * For a probe it is the probability the probe reports: `any-crit` is P(at
   * least one source crit).
   *
   * Read from a walk that carries no damage distribution, only masses, so it costs no
   * damage arithmetic; it agrees with the joint `pmf` walk to rounding (≤ 1e-12 relative).
   * With a pruning `eps` above 0 the masses ignore the pruned damage bins.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not a rider, substitute,
   * condition or probe (attack ids included, since attacks always happen and
   * have no firing probability).
   */
  fireProbability(id: string): number {
    // A stateless turn has nothing that fires.
    const mass =
      this.rows !== undefined
        ? undefined
        : (this.plan.probes.has(id) ? this.resolveMasses() : this.resolveReaders().fireMass).get(id);
    if (mass === undefined) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not a rider, substitute, condition or probe in this turn. Riders: ${[
          ...this.riderIds,
          ...this.substituteIds,
          ...this.conditionIds,
          ...this.probeIds,
        ]
          .map((each) => `"${each}"`)
          .join(", ")}.`
      );
    }
    return mass;
  }

  /**
   * The expected number of times a damage rider applies in a turn: for an uncapped
   * `every-hit` rider, the expected number of landings among its sources; for `max: n`, the
   * expected number of the first `n`. Every other rider applies at most once, so its
   * answer is its `fireProbability`: `max: 1` and `onFirstHit` are one rider, and give one
   * number. Substitutes and conditions are not damage riders.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not a rider.
   */
  expectedApplications(id: string): number {
    const mass = this.rows !== undefined ? undefined : this.walkedApplications(id);
    if (mass === undefined) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not a rider in this turn. Riders: ${this.riderIds
          .map((each) => `"${each}"`)
          .join(", ")}.`
      );
    }
    return mass;
  }

  /** The expected applications of `id` from the reader walk, or `undefined` for an id that is no rider. */
  private walkedApplications(id: string): number | undefined {
    const readers = this.resolveReaders();
    return readers.applications.get(id) ?? (this.plan.riderIds.includes(id) ? readers.fireMass.get(id) : undefined);
  }

  /**
   * Per-step statistics for one declared attack or attack-shaped rider: P(landed,
   * crit included), P(crit), and the mass in which each granted modifier was in
   * force when it read its flags. `rolled` is 1 for a declared attack and the
   * rider's fire mass for an attack-shaped rider.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not a declared attack or an
   * attack-shaped rider — a damage-shaped rider, substitute, condition or unknown
   * id included, since only those roll their own attack and have hit/crit odds.
   */
  stepStats(id: string): StepStats {
    const unknown = (attacks: Iterable<string>): TurnSpecError =>
      new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not an attack or attack-shaped rider in this turn. Attacks: ${[...attacks]
          .map((each) => `"${each}"`)
          .join(", ")}.`
      );
    if (this.rows !== undefined) {
      const row = this.rows.byId.get(id);
      if (row === undefined) throw unknown(this.rows.ids);
      // Nothing is ever in force, nothing is tried; the row draws in every state (`rolled` 1) and
      // lands where it happens.
      return { rolled: 1, hit: row.chance * row.hit, crit: row.chance * row.crit, live: NO_LIVE, conditions: NONE };
    }
    const { tally, total, stepStats } = this.resolveReaders();
    const stats = stepStats.get(id);
    if (stats === undefined) throw unknown(stepStats.keys());
    // All of it from the reader walk: no damage arithmetic. The 0.16 fields agree with the joint
    // walk's to rounding.
    const plan = this.walkPlan;
    const rows = plan.steps.flatMap((step, s) => (step.id === id && step.variants.length !== 0 ? [s] : []));
    const odds = {} as Record<EffectName, number>;
    const sources = {} as Record<EffectName, { source: EffectSource; odds: number }[]>;
    EFFECT_NAMES.forEach((name, e) => {
      odds[name] = rows.reduce((sum, s) => sum + tally.effects[s][e], 0) / total;
      const bySource = new Map<number, number>();
      for (const s of rows) {
        for (const [source, masses] of tally.effectSources[s]) {
          if (masses[e] > 0) bySource.set(source, (bySource.get(source) ?? 0) + masses[e]);
        }
      }
      sources[name] = [...bySource]
        .sort(([a], [b]) => a - b)
        .map(([source, mass]) => ({ source: plan.effectSources[source], odds: mass / total }));
    });
    const conditions = new Map<number, { attempted: number; taken: number }>();
    for (const s of rows) {
      for (const [c, { attempted, taken }] of tally.attempts[s]) {
        const known = conditions.get(c) ?? { attempted: 0, taken: 0 };
        conditions.set(c, { attempted: known.attempted + attempted, taken: known.taken + taken });
      }
    }
    return {
      ...stats,
      live: { ...odds, ...stats.live, sources },
      conditions: [...conditions].map(([c, { attempted, taken }]) => ({
        id: plan.conditionIds[c],
        attempted: attempted / total,
        taken: taken / total,
      })),
    };
  }

  /**
   * The expected number of times condition `id` is attempted this turn (for a `first-*`
   * condition, the odds it is): each landing it watches that finds it not already spent or in
   * force. 0 for a `start` condition, which is never tried.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not a condition.
   */
  attemptProbability(id: string): number {
    const c = this.conditionIds.indexOf(id);
    if (c === -1) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not a condition in this turn. Conditions: ${this.conditionIds.map((each) => `"${each}"`).join(", ")}.`
      );
    }
    const { tally, total } = this.resolveReaders();
    return tally.attempts.reduce((sum, attempts) => sum + (attempts.get(c)?.attempted ?? 0), 0) / total;
  }

  /**
   * The ways riders land on attack `id`: per outcome label (`hit`, `crit`, `saveFail`, …), whether
   * the attack's own roll dealt damage, and the riders that landed with it, with its odds.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not an attack.
   */
  landings(id: string): readonly LandingPattern[] {
    if (!this.attackIds.includes(id)) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not an attack in this turn. Attacks: ${this.attackIds.map((each) => `"${each}"`).join(", ")}.`
      );
    }
    if (this.patterns === undefined) {
      // Patterns cost a little on every landing, so only this reader tallies them, on a walk of its
      // own. A rider's landing does not depend on its `happens`, so the walk takes every rider as
      // happening: a coin that did not come up would hide where the rider landed.
      const plan =
        this.walkPlan.coins.length === 0
          ? this.walkPlan
          : buildPlan(
              {
                ...this.planned,
                observe: [],
                riders: this.planned.riders.map(({ happens: _happens, ...rider }) => rider),
              },
              this.eps,
              new Set(this.planned.declined),
              "masses"
            );
      const tally = new ReaderTally(
        plan.steps,
        new Set(plan.everyHitIds),
        plan.perHitAny,
        new Map(plan.riderIds.map((id, index) => [id, index]))
      );
      this.walk(massLedger, plan, tally);
      this.patterns = tally.patterns;
    }
    const { total } = this.resolveReaders();
    return [...(this.patterns.get(id)?.values() ?? [])].map((pattern) => ({
      ...pattern,
      mass: pattern.mass / total,
    }));
  }

  /** The most states the walk held after any step: 1 for a turn that needs no state. */
  get peakStates(): number {
    return this.rows === undefined ? this.resolveReaders().peakStates : 1;
  }

  private get walkPlan(): TurnPlan {
    if (this.state.observe.length === 0) return this.plan;
    this.plainPlan ??= buildPlan({ ...this.planned, observe: [] }, this.eps, new Set(this.planned.declined), "masses");
    return this.plainPlan;
  }

  /**
   * The joint walk: the only one that carries a damage PMF in every state, read by `pmf` (and
   * `mean`, `toQuery`) alone. Every other reader comes from the mass walks.
   */
  private resolve(): { pmf: PMF } {
    if (this.resolved) return this.resolved;

    // The damage walks a plan without the probes, so a probe's group never splits its states:
    // what `pmf` reports is what the turn without probes reports. Its draws carry their riders'
    // payloads convolved in; the plan the mass walks read does not, so it is built here, once.
    const plan = buildPlan({ ...this.planned, observe: [] }, this.eps, new Set(this.planned.declined), "joint");
    const eps = this.eps;
    const { states, stateCounts } = this.walk(pmfLedger(eps), plan);
    inspections.set(this, { plan: () => this.plan, stateCounts });

    let total: PMF | undefined;
    for (const state of states.values()) {
      total = total ? total.add(state.damage) : state.damage;
    }
    const pmf = total ?? PMF.delta(0, eps);
    this.resolved = { pmf: needsNormalizing(pmf.mass(), eps) ? pmf.normalize() : pmf };
    return this.resolved;
  }

  /**
   * The firing masses, from a walk that carries only mass in place of a damage PMF: the same
   * states and transitions as {@link Turn.resolve}, none of its convolutions. What
   * {@link Turn.fireProbability} reads for a probe.
   */
  private resolveMasses(): ReadonlyMap<string, number> {
    if (this.massed) return this.massed;
    const { states } = this.walk(massLedger, this.plan);
    const fireMass = this.tally(states, massLedger, this.plan);
    let totalMass = 0;
    for (const state of states.values()) totalMass += state.damage;
    if (needsNormalizing(totalMass, this.eps)) {
      for (const [id, mass] of fireMass) fireMass.set(id, mass / totalMass);
    }
    this.massed = fireMass;
    return fireMass;
  }

  /** Every rider, substitute, condition and probe's unnormalized firing mass over the terminal `states`. */
  private tally<D>(
    states: ReadonlyMap<string, WalkState<D>>,
    ledger: Ledger<D>,
    plan: TurnPlan
  ): Map<string, number> {
    const fireMass = new Map<string, number>();
    for (const id of plan.fireSlots.keys()) fireMass.set(id, 0);
    for (const id of plan.perHitGroups.keys()) fireMass.set(id, 0);
    for (const id of plan.probes.keys()) fireMass.set(id, 0);
    for (const id of plan.conditionIds) fireMass.set(id, 0);

    for (const state of states.values()) {
      const mass = ledger.mass(state.damage);
      for (const [id, slot] of plan.fireSlots) {
        if (state.fired[slot] !== null) {
          fireMass.set(id, (fireMass.get(id) as number) + mass);
        }
      }
      // `every-hit` riders have no step: they fired iff something landed.
      for (const [id, group] of plan.perHitGroups) {
        const landed = plan.perHitCritOnly.has(id)
          ? (state.codes[group] & CRIT_BIT) !== 0
          : plan.perHitAny.has(id)
            ? state.codes[group] !== START_CODE
            : ((state.codes[group] >> 2) & 0b11) !== FIRST_NONE;
        if (landed) {
          fireMass.set(id, (fireMass.get(id) as number) + mass);
        }
      }
      // A probe's group is live to the end of the walk, so its code is still the group's own.
      for (const [id, group] of plan.probes) {
        // A probe over sources that cannot crit has no group and reports 0.
        if (group !== -1 && (state.codes[group] & CRIT_BIT) !== 0) {
          fireMass.set(id, (fireMass.get(id) as number) + mass);
        }
      }
      // The reader walk carries no applied masses (it reads riders' alone).
      if (state.applied.length !== 0) {
        plan.conditionIds.forEach((id, c) => {
          fireMass.set(id, (fireMass.get(id) as number) + state.applied[c]);
        });
      }
    }
    return fireMass;
  }

  /**
   * Walks the plan's steps, carrying `ledger`'s damage in each state, and returns the terminal
   * states with the per-step statistics, in the same unnormalized mass units as the states.
   */
  private walk<D>(ledger: Ledger<D>, plan: TurnPlan, tally?: ReaderTally): WalkCounts & {
    states: Map<string, WalkState<D>>;
  } {
    const eps = this.eps;
    const width = plan.groupCount;
    const conditionCount = plan.conditionIds.length;
    const counterCount = plan.counterMax.length;

    // Per-step stat accumulators, in the same unnormalized mass units as the walk's
    // states. `rolled` counts the mass in which a step drew at all; `hit`/`crit` the
    // mass of its hit (crit included) / crit draws; `live*` the mass in which the
    // matching modifier flag was set when the step read its flags.
    const rolled = new Array<number>(plan.steps.length).fill(0);
    const hitMass = new Array<number>(plan.steps.length).fill(0);
    const critMass = new Array<number>(plan.steps.length).fill(0);
    const liveAdvantage = new Array<number>(plan.steps.length).fill(0);
    const liveDisadvantage = new Array<number>(plan.steps.length).fill(0);
    const liveCritOnHit = new Array<number>(plan.steps.length).fill(0);
    // Per every-hit rider, the mass of the draws it applied to, in the same units:
    // its expected number of applications.
    const applicationMass = new Array<number>(plan.everyHitIds.length).fill(0);

    type State = WalkState<D>;

    const start: State = {
      codes: new Array<number>(width).fill(START_CODE),
      damage: ledger.start,
      fired: new Array<FireMode>(plan.slotCount).fill(null),
      flags: plan.startFlags,
      applied: new Array<number>(conditionCount).fill(0).map((_, c) => (plan.startConditions.includes(c) ? 1 : 0)),
      counts: new Array<number>(counterCount).fill(0),
    };
    let states = new Map<string, State>([[String.fromCharCode(), start]]);
    // A rider that may not happen splits the turn before its first row: its coin came up, or not.
    for (const { bit, happens } of plan.coins) {
      const split = new Map<string, State>();
      for (const [key, state] of states) {
        if (happens > 0) {
          split.set(`${key}+`, {
            ...state,
            flags: state.flags | bit,
            damage: ledger.scale(state.damage, happens),
            applied: state.applied.map((mass) => mass * happens),
          });
        }
        if (happens < 1) {
          split.set(`${key}-`, {
            ...state,
            damage: ledger.scale(state.damage, 1 - happens),
            applied: state.applied.map((mass) => mass * (1 - happens)),
          });
        }
      }
      states = split;
    }
    const stateCounts: number[] = [];
    // The reader walk keeps of each group code only what a later reader needs.
    const needs = tally === undefined ? undefined : codeNeeds(plan);

    plan.steps.forEach((step, stepIndex) => {
      const next = new Map<string, State>();

      // Groups with no reader at a LATER step are dead weight in the key: once the walk passes a
      // group's last reader, its specific code can no longer change any future decision, so two
      // states differing only in a dead group's code are behaviorally identical from here on.
      // Filtering them out (recomputed per step, since "later" shifts as the walk advances) keeps
      // a long `dice-match` chain's state count from growing — a group read by exactly one
      // downstream step would otherwise keep splitting states after nothing reads it again.
      const liveGroups: number[] = [];
      for (let g = 0; g < plan.groupCount; g++) {
        if (plan.groupLastReadStep[g] > stepIndex) liveGroups.push(g);
      }
      // Flags get the same treatment, and a dead flag is cleared rather than merely
      // left out of the key, so a stale bit can never be read back (or misread by the
      // next flag that shares its bit).
      const liveFlags = plan.flagLiveAfter[stepIndex];
      const keyUnits: number[] = [];

      const merge = (state: State): void => {
        // A slot whose group dies at this step is reset too, for the same reason, so the group
        // that reuses the slot starts from nothing.
        const codes = needs === undefined
          ? released(state.codes, step.releases)
          : (canonicalCodes(released(state.codes, step.releases), needs[stepIndex]) as number[]);
        // Whether each rider fired (and each substitute was spent) is part of the
        // state: two paths that agree on group codes but disagree on a slot must
        // not merge — `not-fired`, `first-miss`, a substitute's variant choice AND
        // the final `fireMass` collapse all read `state.fired`.
        const flags = state.flags & liveFlags;
        // A count the cap can no longer reach is the same as none: both take every later
        // with-rider draw. Zeroing it lets those states merge, so a cap at or above the
        // number of watched attacks walks exactly the states of an uncapped rider.
        const counts = counterCount
          ? state.counts.map((count, counter) => (count <= step.settled[counter] ? 0 : count))
          : state.counts;
        // The key, built as one flat string: the live group codes, "\u0001", "+"/"-" per fire slot,
        // "\u0002", the flags (up to 30 bits: two UTF-16 units, so the key stays injective), then
        // "\u0003" and the counts.
        keyUnits.length = 0;
        for (const g of liveGroups) keyUnits.push(codes[g]);
        keyUnits.push(1);
        for (const mode of state.fired) keyUnits.push(mode === null ? 45 : 43);
        keyUnits.push(2, flags & 0xffff, flags >>> 16);
        if (counterCount) keyUnits.push(3, ...counts);
        const key = String.fromCharCode(...keyUnits);
        const existing = next.get(key);
        if (existing) {
          existing.damage = ledger.add(existing.damage, state.damage);
          if (conditionCount) {
            existing.applied = existing.applied.map((mass, c) => mass + state.applied[c]);
          }
        } else {
          // Every state merges once, so it can be the merged state itself.
          state.codes = codes;
          state.flags = flags;
          state.counts = counts;
          next.set(key, state);
        }
      };

      const declaredRow = tally !== undefined && step.slot === -1 && step.variants.length !== 0;
      const contexts = step.contextPmfs.length > 1;
      for (const state of states.values()) {
        // A row's d20 and effects count in every state, whether or not it happens. A declared
        // attack fires no slot, so the context it reads here is the one it rolls in.
        let context = 0;
        if (declaredRow) {
          if (contexts) context = step.contextIndexOf(state.codes, state.fired, state.flags, state.counts);
          tally.reach(stepIndex, context, state.flags, ledger.mass(state.damage));
        }
        // A gated attack whose parent did not land does not happen: it deals, lands and consumes nothing.
        if (step.gate !== undefined) {
          const code = state.codes[step.gate.slot];
          if (step.gate.any ? code === START_CODE : ((code >> 2) & 0b11) === FIRST_NONE) {
            merge(state);
            continue;
          }
        }
        const mode = fireMode(step, state.codes, state.fired);

        if (mode === null) {
          merge(state);
          continue;
        }

        const stateMass = ledger.mass(state.damage);
        rolled[stepIndex] += stateMass;
        if (step.readAdvantage !== 0 && (state.flags & step.readAdvantage) !== 0) {
          liveAdvantage[stepIndex] += stateMass;
        }
        if (step.readDisadvantage !== 0 && (state.flags & step.readDisadvantage) !== 0) {
          liveDisadvantage[stepIndex] += stateMass;
        }
        if (step.readCritOnHit !== 0 && (state.flags & step.readCritOnHit) !== 0) {
          liveCritOnHit[stepIndex] += stateMass;
        }

        let fired = state.fired;
        if (step.slot !== -1) {
          fired = [...fired];
          fired[step.slot] = mode;
        }

        if (step.variants.length === 0) {
          const payload = step.damage as { hit: PMF; crit: PMF };
          tally?.fire(step, mode === "crit" ? payload.crit : payload.hit, stateMass);
          merge({
            ...state,
            damage: ledger.convolve(state.damage, mode === "crit" ? payload.crit : payload.hit, step),
            fired,
          });
          continue;
        }

        // Order at a step: read the flags to select the variant, clear the
        // `next-attack` flags this roll consumes (and the `next-hit` ones a hit or crit
        // consumes), draw, advance the groups, then apply this outcome's grants. An
        // attack that did not happen ("none") rolls nothing, so it consumes nothing.
        if (tally !== undefined) {
          if (!declaredRow) {
            if (contexts) context = step.contextIndexOf(state.codes, fired, state.flags, state.counts);
            tally.reach(stepIndex, context, state.flags, stateMass);
          }
          tally.roll(stepIndex, context, stateMass);
        }
        const variant = step.variants[step.select(state.codes, fired, state.flags, state.counts)];
        // The reader walk puts "the row did not happen" first, as the engine does, so the states it
        // reaches (and the order conditions are first tried in) follow the engine's.
        const draws = tally === undefined ? variant : noneFirst(variant);
        const consumed = state.flags & ~step.consumes;
        for (const draw of draws) {
          const { outcome, matched, spends, applies, bumps, fires, slice, byKind } = draw;
          const sliceMass = slice.mass();
          if (sliceMass <= eps) continue;
          // A row that dealt damage ends the conditions damage ends, after it has read them.
          const flags =
            (outcome === "none" ? state.flags : outcome === "miss" ? consumed : consumed & ~step.hitConsumes) &
            (draw.wounded ? ~step.wounds : ~0);

          const contribution = stateMass * sliceMass;
          if (outcome === "crit") {
            critMass[stepIndex] += contribution;
            hitMass[stepIndex] += contribution;
          } else if (outcome === "hit") {
            hitMass[stepIndex] += contribution;
          }
          for (const rider of applies) applicationMass[rider] += contribution;
          let counts = state.counts;
          if (bumps.length !== 0) {
            counts = [...counts];
            for (const counter of bumps) counts[counter]++;
          }

          const codes = state.codes.slice();
          for (let index = 0; index < step.updates.length; index++) {
            const group = step.updates[index];
            const kind = step.updateKinds[index];
            codes[group] = advance(
              codes[group],
              kind === null || byKind === undefined ? outcome : byKind[kind],
              matched
            );
          }
          tally?.draw(stepIndex, draw, contribution, context, state.codes, codes);
          let drawFired = fired;
          if (spends) {
            drawFired = [...fired];
            drawFired[step.spendSlot] = outcome === "crit" ? "crit" : "hit";
          }
          if (fires.length !== 0) {
            if (drawFired === fired) drawFired = [...fired];
            for (const slot of fires) drawFired[slot] = outcome === "crit" ? "crit" : "hit";
          }
          const damage = ledger.convolve(state.damage, slice, step, draw);
          // Each qualifying condition splits the draw by its chance: its grants on
          // one part, its onSave grants on the other. Splits compose, since each
          // condition rolls its own save. With none, the draw is one part.
          let parts: { flags: number; share: number; applied: number[] }[] | undefined;
          for (const app of step.grants) {
            if (!grantApplies(app, outcome, state.codes, byKind, state.flags, draw.riders, draw.typed)) continue;
            // A grant save fails by the state the row started in; a fixed chance is the same everywhere.
            // A save forced by a row that dealt damage is made once it is dealt: what that ended is gone.
            const chance =
              app.chanceOf === undefined
                ? app.chance
                : app.chanceOf(draw.wounded ? state.flags & ~step.wounds : state.flags);
            if (app.countOnly) {
              // Nothing reads it, so it splits nothing: only the try is counted.
              if (tally !== undefined) {
                for (const part of parts ?? [{ share: 1 }]) tally.attempt(stepIndex, app.condition, contribution * part.share, chance);
              }
              continue;
            }
            const split: NonNullable<typeof parts> = [];
            for (const part of parts ?? [{ flags, share: 1, applied: [] }]) {
              if (app.inForce !== 0 && (part.flags & app.inForce) === app.inForce) {
                if (app.counted && app.countedInForce) tally?.attempt(stepIndex, app.condition, contribution * part.share, chance);
                split.push(part);
                continue;
              }
              if (app.counted) tally?.attempt(stepIndex, app.condition, contribution * part.share, chance);
              const applied = app.effective ? [...part.applied, app.condition] : part.applied;
              // A once-per-turn try is spent on both branches of its save.
              const tried = app.tried > 0 ? app.tried : 0;
              const taken = part.share * chance;
              const saved = part.share * (1 - chance);
              if (taken > 0) split.push({ flags: part.flags | app.grants | tried, share: taken, applied });
              if (saved > 0) split.push({ flags: part.flags | app.onSave | tried, share: saved, applied: part.applied });
            }
            parts = split;
          }
          if (parts === undefined) {
            merge({
              codes,
              damage,
              fired: drawFired,
              flags,
              applied: conditionCount ? state.applied.map((mass) => mass * sliceMass) : state.applied,
              counts,
            });
            continue;
          }
          for (const part of parts) {
            const scale = sliceMass * part.share;
            merge({
              codes,
              damage: part.share === 1 ? damage : ledger.scale(damage, part.share),
              fired: drawFired,
              flags: part.flags,
              counts,
              applied: conditionCount
                ? state.applied.map((mass, c) => (part.applied.includes(c) ? stateMass * scale : mass * scale))
                : state.applied,
            });
          }
        }
      }

      states = next;
      stateCounts.push(next.size);
      if (next.size > plan.stateLimit) {
        throw new TurnSpecError(
          "too-many-states",
          step.id,
          `The walk holds ${next.size} states after "${step.id}", more than the turn's stateLimit of ${plan.stateLimit}.`
        );
      }
    });

    return {
      states,
      stateCounts,
      rolled,
      hitMass,
      critMass,
      liveAdvantage,
      liveDisadvantage,
      liveCritOnHit,
      applicationMass,
    };
  }
}

/**
 * Starts a {@link Turn}. Takes one attack or a list of them, so the two common
 * shapes both read straight:
 *
 * ```ts
 * turn(greatsword).onAnyCrit(roll(4, d8));      // one attack
 * turn([dagger, dagger]).onFirstHit(roll(3, d6)); // two
 * turn().attacks(4, greatsword);                 // four
 * ```
 */
export function turn(
  attacks: Attack | readonly Attack[] = [],
  eps: number = 0
): Turn {
  return Turn.from(
    { attacks: Array.isArray(attacks) ? attacks : [attacks as Attack] },
    eps
  );
}

/**
 * `bounce({ source, max })` — sugar for a depth-capped chain of attack-shaped
 * `dice-match` riders, so no caller hand-writes the chain by hand: beam 1 is
 * `source` itself as the turn's only declared attack; beam `i + 1` (for
 * `i = 1..max`) is `source` again, as a rider fired only when beam `i`'s own
 * dice matched. Every beam shares `source`'s exact profile (same to-hit, same
 * damage dice) — the natural reading of "the orb leaps to a new target, same
 * damage profile, and repeats."
 *
 * `max` is required and MUST be a non-negative integer: match probability alone
 * does not terminate the recursion (Chromatic Orb bounces are not literally
 * unbounded — DMs cap them by fiat or table size — and something has to).
 *
 * Each beam after the first is its own trigger group (`of: [<previous beam's id>]` is a
 * distinct source set every time), but a beam's group dies after its one reader, so only two
 * are live at once and any `max` fits {@link MAX_TRIGGER_GROUPS}: the walk grows with `max`,
 * not against the group cap.
 */
export function bounce({ source, max }: { source: Damage; max: number }): Turn {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError(`bounce({ max }) needs a non-negative integer, got ${max}.`);
  }

  let result = turn(source);
  let previousId = result.attackIds[0];
  for (let i = 0; i < max; i++) {
    const riderId = `bounce ${i + 1}`;
    result = result.onDiceMatch([previousId], source, { id: riderId });
    previousId = riderId;
  }
  return result;
}
