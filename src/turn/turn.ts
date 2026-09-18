import { EPS } from "../common/types";
import { PMF } from "../pmf/pmf";
import { DiceQuery } from "../pmf/query";
import type { Step, TurnPlan } from "./plan";
import { buildPlan } from "./plan";
import type { StepOutcome } from "./state";
import {
  advance,
  CRIT_BIT,
  FIRST_CRIT,
  FIRST_NONE,
  MISS_BIT,
  START_CODE,
} from "./state";
import type {
  Attack,
  Rider,
  RiderDamage,
  RiderOptions,
  Source,
  TurnSpec,
} from "./types";
import { TurnSpecError } from "./types";

/** Which payload a rider uses when it fires, or `null` when it doesn't fire. */
type FireMode = "hit" | "crit" | null;

const OUTCOMES: readonly StepOutcome[] = ["hit", "crit", "miss"];

/**
 * Decide whether `step` fires in state `codes`, and in which mode.
 *
 * Every group a trigger reads is fully determined before its own step runs
 * (sources always precede dependents), so a trigger can be evaluated once, at
 * its step, and again at the end for {@link Turn.fireProbability} — both give the
 * same answer.
 */
function fireMode(
  step: Step,
  codes: readonly number[],
  firedByStep: readonly FireMode[]
): FireMode {
  const trigger = step.trigger;
  if (!trigger) return "hit";

  if (trigger.on === "not-fired") {
    return firedByStep[step.negates] === null ? "hit" : null;
  }

  const code = codes[step.reads];
  const first = code >> 2;

  switch (trigger.on) {
    case "first-hit":
      if (first === FIRST_NONE) return null;
      return first === FIRST_CRIT ? "crit" : "hit";
    case "any-crit":
      return (code & CRIT_BIT) !== 0 ? "crit" : null;
    case "any-miss":
      return (code & MISS_BIT) !== 0 ? "hit" : null;
    default:
      // `every-hit` never becomes a step — it is folded into its sources' slices.
      return null;
  }
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
  private readonly declaredAttacks: readonly Attack[];
  private readonly riders: readonly Rider[];
  private readonly plan: TurnPlan;
  private resolved?: { pmf: PMF; fireMass: ReadonlyMap<string, number> };

  private constructor(
    attacks: readonly Attack[],
    riders: readonly Rider[],
    eps: number
  ) {
    // Copied, because a caller can hand in an array they still hold and keep
    // mutating it. Shallow is the right depth: the entries are builders and
    // PMFs this module does not own and which are immutable by convention
    // throughout this library.
    this.declaredAttacks = [...attacks];
    this.riders = [...riders];
    this.eps = eps;
    // Built here, not on first use, so every way of constructing a Turn
    // validates at the same moment: the call that introduced the mistake.
    this.plan = buildPlan({ attacks: this.declaredAttacks, riders: this.riders }, eps);
  }

  /**
   * Builds a turn from plain data, throwing {@link TurnSpecError} if it is
   * malformed. Use this from a UI, where `error.code` maps to the field state to
   * show.
   */
  static from(spec: TurnSpec, eps: number = EPS): Turn {
    return new Turn(spec.attacks, spec.riders ?? [], eps);
  }

  /**
   * Appends an attack, throwing {@link TurnSpecError} if that makes the turn
   * invalid.
   *
   * A rider with no explicit `of` watches every declared attack *including ones
   * appended after it*, because `of` is resolved when the plan is built rather
   * than when the rider is added. Pass an explicit `of` to pin a rider to the
   * attacks it already saw. One attack must exist before a rider with a default
   * `of` is added, or the build fails `unknown-id`.
   */
  attack(source: Source, id?: string): Turn {
    const entry: Attack = id === undefined ? source : { id, source };
    return new Turn([...this.declaredAttacks, entry], this.riders, this.eps);
  }

  /**
   * Appends `count` copies of the same attack — the Extra Attack case, which is
   * most of 5e. Argument order mirrors `roll(count, die)`.
   *
   * ```ts
   * turn().attacks(4, greatsword).onEveryHit(d6); // fighter 20 + hunter's mark
   * ```
   *
   * @throws {RangeError} if `count` is not a positive integer.
   */
  attacks(count: number, source: Source): Turn {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(
        `attacks(count) needs a positive integer, got ${count}.`
      );
    }
    const added: Attack[] = new Array<Attack>(count).fill(source);
    return new Turn([...this.declaredAttacks, ...added], this.riders, this.eps);
  }

  /**
   * Appends a rider, throwing {@link TurnSpecError} if that makes the turn
   * invalid. The `onX` methods below are the readable way to call this.
   */
  rider(rider: Rider): Turn {
    return new Turn(this.declaredAttacks, [...this.riders, rider], this.eps);
  }

  /**
   * Fires once, on the first source that lands, in that source's mode — so a
   * crit on the first landing attack doubles the rider's dice. Sneak Attack.
   */
  onFirstHit(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "first-hit" });
  }

  /**
   * Fires once if any source crit, always in crit mode. Divine Smite: nothing is
   * lost by holding it for a crit, so this is "any", not "first".
   */
  onAnyCrit(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "any-crit" });
  }

  /**
   * Fires once if any source missed. The reroll gate: a reroll is a fresh attack,
   * so pass one as the damage. Kensei's Unerring Accuracy, Lucky.
   */
  onAnyMiss(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "any-miss" });
  }

  /**
   * Fires once per source that lands, in that hit's mode — so it can fire several
   * times in a turn. Hunter's Mark, Hex, Rage.
   */
  onEveryHit(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "every-hit" });
  }

  /**
   * Damage for the turns where the rider added just before this one did *not*
   * fire: "flurry of blows if I didn't smite".
   *
   * ```ts
   * turn([dagger, dagger])
   *   .onAnyCrit(roll(2, d8))      // smite
   *   .otherwise([flurry, flurry]) // ... or two more attacks
   * ```
   *
   * Always binds to the *immediately* preceding rider, so the two are branches of
   * one decision and can never both land. Note that chaining it therefore
   * alternates rather than laddering: `a.otherwise(b).otherwise(c)` makes `c`
   * fire whenever `b` did not, which is exactly when `a` did. For a genuine
   * three-way priority chain, name the riders and use explicit `not-fired`
   * triggers against the right one.
   */
  otherwise(
    damage: RiderDamage,
    options: Omit<RiderOptions, "of"> = {}
  ): Turn {
    const index = this.riders.length - 1;
    if (index < 0) {
      throw new TurnSpecError(
        "unknown-id",
        "",
        "otherwise() needs a preceding rider to negate."
      );
    }
    const previous = this.riders[index];
    if (previous.on === "every-hit") {
      throw new TurnSpecError(
        "not-an-attack",
        previous.id ?? `rider ${index + 1}`,
        "otherwise() cannot negate an every-hit rider: it can fire more than once."
      );
    }

    // `of` must name the previous rider, so give it the id `buildPlan` would.
    const target = previous.id ?? `rider ${index + 1}`;
    const riders: Rider[] = [...this.riders];
    riders[index] = { ...previous, id: target };
    riders.push({ ...options, damage, on: "not-fired", of: target });
    return new Turn(this.declaredAttacks, riders, this.eps);
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
    return new DiceQuery([...this.plan.attackPMFs], this.pmf, this.eps);
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
   * P(this rider fired). For an `every-hit` rider it is P(at least one source
   * hit), since that rider can fire more than once in a turn.
   *
   * @throws {TurnSpecError} `unknown-id` if `id` is not a rider — attack ids
   * included, since attacks always happen and have no firing probability.
   */
  fireProbability(id: string): number {
    const mass = this.resolve().fireMass.get(id);
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

  private resolve(): { pmf: PMF; fireMass: ReadonlyMap<string, number> } {
    if (this.resolved) return this.resolved;

    const plan = this.plan;
    const eps = this.eps;
    const width = plan.groupCount;

    // state key -> { codes, accumulated sub-mass damage, per-step firing }
    type State = {
      codes: number[];
      pmf: PMF;
      fired: FireMode[];
    };

    const start: State = {
      codes: new Array<number>(width).fill(START_CODE),
      pmf: PMF.delta(0, eps),
      fired: new Array<FireMode>(plan.steps.length).fill(null),
    };
    let states = new Map<string, State>([[String.fromCharCode(), start]]);

    plan.steps.forEach((step, stepIndex) => {
      const next = new Map<string, State>();

      const merge = (state: State): void => {
        // Whether each rider fired is part of the state: two paths that agree on
        // group codes but disagree on a rider's firing must not merge, or a
        // `not-fired` rider downstream would see an ill-defined predicate.
        //
        // Only the fired/not-fired bit belongs in the key, though — nothing
        // reads the mode back, and keying on it would split otherwise identical
        // states and multiply the convolutions for no change in the result.
        const key =
          String.fromCharCode(...state.codes) +
          "\u0001" +
          state.fired.map((mode) => (mode === null ? "-" : "+")).join("");
        const existing = next.get(key);
        if (existing) existing.pmf = existing.pmf.add(state.pmf);
        else next.set(key, state);
      };

      for (const state of states.values()) {
        const mode = fireMode(step, state.codes, state.fired);
        const fired = [...state.fired];
        fired[stepIndex] = mode;

        if (mode === null) {
          merge({ codes: state.codes, pmf: state.pmf, fired });
          continue;
        }

        if (!step.slices) {
          const payload = step.damage as { hit: PMF; crit: PMF };
          merge({
            codes: state.codes,
            pmf: state.pmf.convolve(
              mode === "crit" ? payload.crit : payload.hit,
              eps,
              true
            ),
            fired,
          });
          continue;
        }

        for (const outcome of OUTCOMES) {
          const slice = step.slices[outcome];
          const sliceMass = slice.mass();
          if (sliceMass <= eps) continue;

          const codes = [...state.codes];
          for (const group of step.updates) {
            codes[group] = advance(codes[group], outcome);
          }
          merge({
            codes,
            pmf: state.pmf.convolve(slice, eps, true),
            fired,
          });
        }
      }

      states = next;
    });

    // Collapse: sum every terminal state, and tally per-rider firing mass.
    const fireMass = new Map<string, number>();
    for (const id of plan.riderSteps.keys()) fireMass.set(id, 0);
    for (const id of plan.perHitGroups.keys()) fireMass.set(id, 0);

    let total: PMF | undefined;
    for (const state of states.values()) {
      total = total ? total.add(state.pmf) : state.pmf;
      const mass = state.pmf.mass();
      for (const [id, stepIndex] of plan.riderSteps) {
        if (state.fired[stepIndex] !== null) {
          fireMass.set(id, (fireMass.get(id) as number) + mass);
        }
      }
      // `every-hit` riders have no step: they fired iff something landed.
      for (const [id, group] of plan.perHitGroups) {
        if (state.codes[group] >> 2 !== FIRST_NONE) {
          fireMass.set(id, (fireMass.get(id) as number) + mass);
        }
      }
    }

    const pmf = total ?? PMF.delta(0, eps);
    const totalMass = pmf.mass();
    const needsNormalizing = Math.abs(totalMass - 1) > eps && totalMass > 0;

    // Firing masses are accumulated in the same unnormalized units as the
    // terminal states, so they have to follow the distribution through
    // normalization or `fireProbability` stops agreeing with `pmf`. Reachable
    // whenever a caller supplies a source PMF whose own mass is not 1.
    if (needsNormalizing) {
      for (const [id, mass] of fireMass) fireMass.set(id, mass / totalMass);
    }

    this.resolved = {
      pmf: needsNormalizing ? pmf.normalize() : pmf,
      fireMass,
    };
    return this.resolved;
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
  eps: number = EPS
): Turn {
  return Turn.from(
    { attacks: Array.isArray(attacks) ? attacks : [attacks as Attack] },
    eps
  );
}
