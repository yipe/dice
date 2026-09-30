import type { Check } from "../builder/types";
import { PMF } from "../pmf/pmf";
import { DiceQuery } from "../pmf/query";
import type { ConditionOptions, EveryHitOptions, FirstHitOptions, Grant, Transform } from "./effects";
import { grantSpec, isGrant, isTransform, substituteFields } from "./effects";
import type { FireMode, TurnPlan } from "./plan";
import { buildPlan, fireMode, grantApplies, released } from "./plan";
import { advance, CRIT_BIT, FIRST_NONE, START_CODE } from "./state";
import type {
  Attack,
  AttackOptions,
  ConditionSpec,
  Damage,
  ProbeSpec,
  Rider,
  RiderDamage,
  RiderOptions,
  Source,
  SubstituteSpec,
  ToPMF,
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
  /**
   * A chaining call defaulted some rider's, substitute's or condition's `of`.
   * Appending an attack now would leave it out of that set silently, so it throws
   * instead.
   */
  defaulted: boolean;
  /** What the last chaining call added — the target of {@link Turn.otherwise}. */
  last: { kind: "rider" | "substitute"; index: number } | null;
}

/** What a trigger verb accepts: damage, grants, or both in one list. */
type Effect = RiderDamage | Grant | readonly (Damage | Grant)[];

/**
 * Per-step statistics of a turn's walk, for one attack or attack-shaped rider.
 * Every field is a probability (mass): `rolled` is the mass in which the step
 * drew at all — 1 for a declared attack, a rider's fire mass for an attack-shaped
 * rider — `hit`/`crit` the mass of those draws that landed (crit included) / were
 * crits, and `live` the mass in which each granted modifier was in force when the
 * step read its flags, before the step consumes anything.
 */
export interface StepStats {
  rolled: number;
  hit: number;
  crit: number;
  live: { advantage: number; disadvantage: number; critOnHit: number };
}

/** Test seam: the plan and walk size of a turn. Not exported from the package. */
const inspections = new WeakMap<Turn, { plan: TurnPlan; stateCounts?: readonly number[] }>();

/**
 * The number of trigger groups `t` tracks and, per step, the number of distinct
 * walk states after it. Resolves `t` if it has not been resolved yet.
 */
export function inspectTurn(t: Turn): { groupCount: number; stateCounts: readonly number[] } {
  t.mean();
  const inspection = inspections.get(t) as { plan: TurnPlan; stateCounts: readonly number[] };
  return { groupCount: inspection.plan.groupCount, stateCounts: inspection.stateCounts };
}

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
  /** `damage` with a draw's sub-mass `slice` (or a pure-damage payload) folded in. */
  convolve(damage: D, slice: PMF): D;
}

function pmfLedger(eps: number): Ledger<PMF> {
  return {
    start: PMF.delta(0, eps),
    mass: (damage) => damage.mass(),
    add: (a, b) => a.add(b),
    scale: (damage, factor) => damage.scaleMass(factor),
    convolve: (damage, slice) => damage.convolve(slice, eps, true),
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
  private readonly plan: TurnPlan;
  private resolved?: {
    pmf: PMF;
    fireMass: ReadonlyMap<string, number>;
    applications: ReadonlyMap<string, number>;
    stepStats: ReadonlyMap<string, StepStats>;
  };
  /** Firing masses from a walk that carried no damage; see {@link Turn.fireProbability}. */
  private massed?: ReadonlyMap<string, number>;
  /** The plan without probes, built on first use when there are probes (see {@link Turn.resolve}). */
  private plainPlan?: TurnPlan;

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
    this.plan = buildPlan(this.state, eps);
    inspections.set(this, { plan: this.plan });
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
      { attacks: spec.attacks, riders, substitutes, conditions, observe, defaulted: false, last },
      eps
    );
  }

  private with(changes: Partial<TurnState>): Turn {
    return new Turn({ ...this.state, ...changes }, this.eps);
  }

  /** What a chaining call's omitted `of` means: the attacks so far, plus any reroll so far. */
  private defaultOf(): readonly string[] {
    return [...this.plan.attackIds, ...this.plan.rerollIds];
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
    const { id, tag, chance } =
      typeof options === "string" ? { id: options, tag: undefined, chance: undefined } : (options ?? {});
    const entry: Attack =
      id === undefined && tag === undefined && chance === undefined
        ? source
        : { id, tag, chance, source };
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
  private addEffect(on: ConditionSpec["on"], effect: Effect, options: EveryHitOptions): Turn {
    const { save, chance, onSave, ...riderOptions } = options;
    const gated = save !== undefined || chance !== undefined || onSave !== undefined;
    const parts: readonly unknown[] = Array.isArray(effect) ? effect : [effect];
    const grants = parts.filter(isGrant);
    if (grants.length === 0) {
      if (gated) {
        throw new Error(
          "save, chance and onSave gate grants only, and this call has none: damage is never gated by them. Pass a SaveBuilder as the damage for damage that depends on a save."
        );
      }
      return this.rider({ ...riderOptions, damage: effect as RiderDamage, on });
    }
    if (riderOptions.max !== undefined || riderOptions.perSource !== undefined) {
      throw new Error(
        "max and perSource shape a damage rider, and this call has grants: a grant is never capped and has no payload. Add the damage in its own call."
      );
    }
    if (save !== undefined && chance !== undefined) {
      throw new Error("Pass either save or chance, not both: each is the chance the grants take.");
    }
    if (onSave !== undefined && save === undefined && chance === undefined) {
      throw new Error("onSave needs a save or a chance: without one there is no other branch to apply it on.");
    }
    if (save !== undefined && typeof (save as Partial<ToPMF>).toPMF !== "function") {
      throw new Error("save must be a DC check such as d20.plus(2).dc(15).");
    }
    const damage = parts.filter((part) => !isGrant(part)) as Damage[];
    if (damage.length === 0 && riderOptions.critDamage !== undefined) {
      throw new TurnSpecError(
        "unused-crit-damage",
        riderOptions.id ?? "",
        "A grant deals no damage, so critDamage has nothing to apply to."
      );
    }
    if (damage.length === 0 && riderOptions.landing !== undefined) {
      throw new TurnSpecError(
        "unsupported-trigger",
        riderOptions.id ?? "",
        "A grant is a condition, which reads attack rolls and cannot watch a save row; landing says how a damage rider reads one."
      );
    }

    const of = riderOptions.of ?? this.defaultOf();
    // A save's P(fail): the DC check's PMF puts it at 1. `vsAC` leaves it alone —
    // it is the target's save bonus, not its AC.
    const probability = save === undefined ? chance : save.toPMF(this.eps).pAt(1);
    const saved = onSave === undefined ? [] : Array.isArray(onSave) ? onSave : [onSave as Grant];
    const condition: ConditionSpec = {
      ...(damage.length === 0 && riderOptions.id !== undefined ? { id: riderOptions.id } : {}),
      on,
      of,
      ...(probability === undefined ? {} : { chance: probability }),
      grants: grants.map(grantSpec),
      ...(saved.length === 0 ? {} : { onSave: saved.map(grantSpec) }),
    };
    const riders =
      damage.length === 0
        ? this.state.riders
        : [...this.state.riders, { ...riderOptions, of, damage, on } as Rider];
    return this.with({
      riders,
      conditions: [...this.state.conditions, condition],
      defaulted: this.state.defaulted || riderOptions.of === undefined,
      last: damage.length === 0 ? null : { kind: "rider", index: this.state.riders.length },
    });
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
    const rebind = (damage: Damage): Damage => {
      const attack = damage as {
        check?: { attackConfig?: { ac?: number } };
        withCheck?: (fn: (check: Check) => Check) => Damage;
      };
      if (typeof attack.withCheck !== "function") return damage;
      if (typeof attack.check?.attackConfig?.ac !== "number") return damage;
      rebound++;
      return attack.withCheck((check) => ({ ...check, ac }));
    };
    const rebindAll = (damage: RiderDamage): RiderDamage =>
      Array.isArray(damage) ? damage.map(rebind) : rebind(damage as Damage);

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
    return this.resolve().pmf;
  }

  /** Mean damage for the turn. */
  mean(): number {
    return this.pmf.mean();
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
    return this.plan.attackIds;
  }

  /**
   * Rider ids in declaration order, including the `rider 1`, `rider 2`, …
   * defaults. These are the names {@link Turn.fireProbability} accepts.
   */
  get riderIds(): readonly string[] {
    return this.plan.riderIds;
  }

  /**
   * Substitute ids in declaration order, including the `substitute 1`, … defaults.
   * {@link Turn.fireProbability} accepts these too.
   */
  get substituteIds(): readonly string[] {
    return this.plan.substituteIds;
  }

  /**
   * Condition ids in declaration order, including the `condition 1`, … defaults.
   * {@link Turn.fireProbability} accepts these too.
   */
  get conditionIds(): readonly string[] {
    return this.plan.conditionIds;
  }

  /**
   * Probe ids in declaration order, including the `probe 1`, … defaults.
   * {@link Turn.fireProbability} accepts these too.
   */
  get probeIds(): readonly string[] {
    return this.plan.probeIds;
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
   * A probe is read from a walk that carries no damage distribution, only masses,
   * so it costs no damage arithmetic; every other id is read from the full walk,
   * bit for bit as before. The two agree to rounding, and exactly as a probe's
   * value does not depend on which was resolved first, neither does anyone else's.
   * With a pruning `eps` above 0 the probe's masses ignore the pruned damage bins.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not a rider, substitute,
   * condition or probe (attack ids included, since attacks always happen and
   * have no firing probability).
   */
  fireProbability(id: string): number {
    const masses = this.plan.probes.has(id) ? this.resolveMasses() : this.resolve().fireMass;
    const mass = masses.get(id);
    if (mass === undefined) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not a rider, substitute, condition or probe in this turn. Riders: ${[
          ...this.plan.riderIds,
          ...this.plan.substituteIds,
          ...this.plan.conditionIds,
          ...this.plan.probeIds,
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
    const resolved = this.resolve();
    const mass = resolved.applications.get(id) ?? (this.plan.riderIds.includes(id) ? resolved.fireMass.get(id) : undefined);
    if (mass === undefined) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not a rider in this turn. Riders: ${this.plan.riderIds
          .map((each) => `"${each}"`)
          .join(", ")}.`
      );
    }
    return mass;
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
    const resolved = this.resolve();
    const stats = resolved.stepStats.get(id);
    if (stats === undefined) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not an attack or attack-shaped rider in this turn. Attacks: ${[
          ...resolved.stepStats.keys(),
        ]
          .map((each) => `"${each}"`)
          .join(", ")}.`
      );
    }
    // The cached entry is shared by every later call; hand out a copy so a caller
    // mutating the result cannot change what the next read reports.
    return { ...stats, live: { ...stats.live } };
  }

  private get walkPlan(): TurnPlan {
    if (this.state.observe.length === 0) return this.plan;
    this.plainPlan ??= buildPlan({ ...this.state, observe: [] }, this.eps);
    return this.plainPlan;
  }

  private resolve(): {
    pmf: PMF;
    fireMass: ReadonlyMap<string, number>;
    applications: ReadonlyMap<string, number>;
    stepStats: ReadonlyMap<string, StepStats>;
  } {
    if (this.resolved) return this.resolved;

    // The damage walks a plan without the probes, so a probe's group never splits its states:
    // what `pmf`, every other id and `stepStats` report is what the turn without probes reports.
    const plan = this.walkPlan;
    const eps = this.eps;
    const ledger = pmfLedger(eps);
    const {
      states,
      stateCounts,
      rolled,
      hitMass,
      critMass,
      liveAdvantage,
      liveDisadvantage,
      liveCritOnHit,
      applicationMass,
    } = this.walk(ledger, plan);
    inspections.set(this, { plan: this.plan, stateCounts });

    // Collapse: sum every terminal state, and tally per-rider firing mass.
    const fireMass = this.tally(states, ledger, plan);
    const applications = new Map<string, number>(
      plan.everyHitIds.map((id, rider) => [id, applicationMass[rider]])
    );
    let total: PMF | undefined;
    for (const state of states.values()) {
      total = total ? total.add(state.damage) : state.damage;
    }

    const pmf = total ?? PMF.delta(0, eps);
    const totalMass = pmf.mass();
    const normalizing = needsNormalizing(totalMass, eps);

    // Firing masses are accumulated in the same unnormalized units as the
    // terminal states, so they have to follow the distribution through
    // normalization or `fireProbability` stops agreeing with `pmf`. Reachable
    // whenever a caller supplies a source PMF whose own mass is not 1.
    if (normalizing) {
      for (const [id, mass] of fireMass) fireMass.set(id, mass / totalMass);
      for (const [id, mass] of applications) applications.set(id, mass / totalMass);
    }

    // Per-step stats live in the same mass units, so they follow the same
    // normalization. Only attack-shaped steps (a declared attack, or a rider that
    // rolls its own attack — anything with variants) are reportable. A rider that
    // fires at several positions in the rail (a `first-miss` reroll watching many
    // attacks) has one step per position under one id; those steps are mutually
    // exclusive, so their masses sum.
    const scale = (mass: number): number => (normalizing ? mass / totalMass : mass);
    const stepStats = new Map<string, StepStats>();
    plan.steps.forEach((step, stepIndex) => {
      if (step.variants.length === 0) return;
      const next: StepStats = {
        rolled: scale(rolled[stepIndex]),
        hit: scale(hitMass[stepIndex]),
        crit: scale(critMass[stepIndex]),
        live: {
          advantage: scale(liveAdvantage[stepIndex]),
          disadvantage: scale(liveDisadvantage[stepIndex]),
          critOnHit: scale(liveCritOnHit[stepIndex]),
        },
      };
      const existing = stepStats.get(step.id);
      if (existing === undefined) {
        stepStats.set(step.id, next);
      } else {
        stepStats.set(step.id, {
          rolled: existing.rolled + next.rolled,
          hit: existing.hit + next.hit,
          crit: existing.crit + next.crit,
          live: {
            advantage: existing.live.advantage + next.live.advantage,
            disadvantage: existing.live.disadvantage + next.live.disadvantage,
            critOnHit: existing.live.critOnHit + next.live.critOnHit,
          },
        });
      }
    });

    this.resolved = {
      pmf: normalizing ? pmf.normalize() : pmf,
      fireMass,
      applications,
      stepStats,
    };
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
        if (((state.codes[group] >> 2) & 0b11) !== FIRST_NONE) {
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
      plan.conditionIds.forEach((id, c) => {
        fireMass.set(id, (fireMass.get(id) as number) + state.applied[c]);
      });
    }
    return fireMass;
  }

  /**
   * Walks the plan's steps, carrying `ledger`'s damage in each state, and returns the terminal
   * states with the per-step statistics, in the same unnormalized mass units as the states.
   */
  private walk<D>(ledger: Ledger<D>, plan: TurnPlan): {
    states: Map<string, WalkState<D>>;
    stateCounts: number[];
    rolled: number[];
    hitMass: number[];
    critMass: number[];
    liveAdvantage: number[];
    liveDisadvantage: number[];
    liveCritOnHit: number[];
    applicationMass: number[];
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
      flags: 0,
      applied: new Array<number>(conditionCount).fill(0),
      counts: new Array<number>(counterCount).fill(0),
    };
    let states = new Map<string, State>([[String.fromCharCode(), start]]);
    const stateCounts: number[] = [];

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
      // left out of the key, so a stale bit can never be read back.
      let liveFlags = 0;
      plan.flagLastReadStep.forEach((last, bit) => {
        if (last > stepIndex) liveFlags |= 1 << bit;
      });

      const merge = (state: State): void => {
        // A slot whose group dies at this step is reset too, for the same reason, so the group
        // that reuses the slot starts from nothing.
        const codes = released(state.codes, step.releases);
        // Whether each rider fired (and each substitute was spent) is part of the
        // state: two paths that agree on group codes but disagree on a slot must
        // not merge — `not-fired`, `first-miss`, a substitute's variant choice AND
        // the final `fireMass` collapse all read `state.fired`.
        let codesKey = "";
        for (const g of liveGroups) codesKey += String.fromCharCode(codes[g]);
        const flags = state.flags & liveFlags;
        // A count the cap can no longer reach is the same as none: both take every later
        // with-rider draw. Zeroing it lets those states merge, so a cap at or above the
        // number of watched attacks walks exactly the states of an uncapped rider.
        const counts = counterCount
          ? state.counts.map((count, counter) => (count <= step.settled[counter] ? 0 : count))
          : state.counts;
        const key =
          codesKey +
          "\u0001" +
          state.fired.map((mode) => (mode === null ? "-" : "+")).join("") +
          "\u0002" +
          String.fromCharCode(flags) +
          (counterCount ? "\u0003" + String.fromCharCode(...counts) : "");
        const existing = next.get(key);
        if (existing) {
          existing.damage = ledger.add(existing.damage, state.damage);
          if (conditionCount) {
            existing.applied = existing.applied.map((mass, c) => mass + state.applied[c]);
          }
        } else {
          next.set(key, { ...state, codes, flags, counts });
        }
      };

      for (const state of states.values()) {
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
          merge({
            ...state,
            damage: ledger.convolve(state.damage, mode === "crit" ? payload.crit : payload.hit),
            fired,
          });
          continue;
        }

        // Order at a step: read the flags to select the variant, clear the
        // `next-attack` flags this roll consumes, draw, advance the groups, then
        // apply this outcome's grants.
        const draws = step.variants[step.select(state.codes, fired, state.flags, state.counts)];
        const flags = state.flags & ~step.consumes;
        for (const { outcome, matched, spends, applies, bumps, fires, slice, byKind } of draws) {
          const sliceMass = slice.mass();
          if (sliceMass <= eps) continue;

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

          const codes = [...state.codes];
          step.updates.forEach((group, index) => {
            const kind = step.updateKinds[index];
            codes[group] = advance(
              codes[group],
              kind === null || byKind === undefined ? outcome : byKind[kind],
              matched
            );
          });
          let drawFired = fired;
          if (spends) {
            drawFired = [...fired];
            drawFired[step.spendSlot] = outcome === "crit" ? "crit" : "hit";
          }
          if (fires.length !== 0) {
            if (drawFired === fired) drawFired = [...fired];
            for (const slot of fires) drawFired[slot] = outcome === "crit" ? "crit" : "hit";
          }
          const damage = ledger.convolve(state.damage, slice);
          if (step.grants.length === 0) {
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

          // Each qualifying condition splits the draw by its chance: its grants on
          // one part, its onSave grants on the other. Splits compose, since each
          // condition rolls its own save.
          let parts: { flags: number; share: number; applied: number[] }[] = [
            { flags, share: 1, applied: [] },
          ];
          for (const app of step.grants) {
            if (!grantApplies(app, outcome, state.codes)) continue;
            parts = parts.flatMap((part) => {
              if (app.inForce !== 0 && (part.flags & app.inForce) === app.inForce) return [part];
              const applied = app.effective ? [...part.applied, app.condition] : part.applied;
              const taken = { flags: part.flags | app.grants, share: part.share * app.chance, applied };
              const saved = { ...part, flags: part.flags | app.onSave, share: part.share * (1 - app.chance) };
              return [taken, saved].filter((each) => each.share > 0);
            });
          }
          for (const part of parts) {
            const scale = sliceMass * part.share;
            merge({
              codes,
              damage: part.share === 1 ? damage : ledger.scale(damage, part.share),
              fired: drawFired,
              flags: part.flags,
              counts,
              applied: state.applied.map((mass, c) =>
                part.applied.includes(c) ? stateMass * scale : mass * scale
              ),
            });
          }
        }
      }

      states = next;
      stateCounts.push(next.size);
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
export function bounce({ source, max }: { source: Source; max: number }): Turn {
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
