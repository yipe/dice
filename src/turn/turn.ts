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
  private plan?: TurnPlan;
  private resolved?: { pmf: PMF; fireMass: ReadonlyMap<string, number> };

  private constructor(
    private readonly attacks: readonly Attack[],
    private readonly riders: readonly Rider[],
    eps: number = EPS,
    plan?: TurnPlan
  ) {
    this.eps = eps;
    this.plan = plan;
  }

  /**
   * Validates eagerly and throws {@link TurnSpecError} — use this from a UI, where
   * `error.code` maps to the row/field state to show.
   */
  static from(spec: TurnSpec, eps: number = EPS): Turn {
    const plan = buildPlan(spec, eps);
    return new Turn(spec.attacks, spec.riders ?? [], eps, plan);
  }

  /** Appends an attack. Validation is deferred to the first `pmf` access. */
  attack(source: Source, id?: string): Turn {
    const entry: Attack = id === undefined ? source : { id, attack: source };
    return new Turn([...this.attacks, entry], this.riders, this.eps, undefined);
  }

  /** Appends a rider. Validation is deferred to the first `pmf` access. */
  rider(rider: Rider): Turn {
    return new Turn(
      this.attacks,
      [...this.riders, rider],
      this.eps,
      undefined
    );
  }

  /** 3d6 on the first dagger that lands — Sneak Attack. */
  onFirstHit(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "first-hit" });
  }

  /** 2d8 whenever anything crits — Divine Smite. */
  onAnyCrit(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "any-crit" });
  }

  /** A fresh attack when something missed — Unerring Accuracy, Lucky. */
  onAnyMiss(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.rider({ ...options, damage, on: "any-miss" });
  }

  /** 1d6 on each attack that lands — Hunter's Mark, Hex, Rage. */
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
  otherwise(damage: RiderDamage, options: RiderOptions = {}): Turn {
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
    return new Turn(this.attacks, riders, this.eps, undefined);
  }

  /** The exact joint distribution: mass 1, outcome-labelled. Computed once. */
  get pmf(): PMF {
    return this.resolve().pmf;
  }

  /**
   * A query whose `singles` are the **declared attacks** and whose combined
   * distribution is the exact turn PMF.
   *
   * Riders are inside the combined PMF, not in `singles`, so singles-based
   * helpers (`probAtLeastOne`, `countSinglesWith`) describe the attacks only.
   * Read rider-inclusive statistics off the combined PMF —
   * `outcomeTotals`, `outcomeDamageRanges`, `damageAttributionChartModel`.
   */
  query(): DiceQuery {
    const plan = this.ensurePlan();
    return new DiceQuery([...plan.attackPMFs], this.pmf, this.eps);
  }

  mean(): number {
    return this.pmf.mean();
  }

  /**
   * P(rider fires). For `every-hit` riders this is P(at least one source hit) —
   * such a rider can fire more than once per turn.
   */
  fireProbability(id: string): number {
    const mass = this.resolve().fireMass.get(id);
    if (mass === undefined) {
      throw new TurnSpecError(
        "unknown-id",
        id,
        `"${id}" is not a rider in this turn.`
      );
    }
    return mass;
  }

  private ensurePlan(): TurnPlan {
    if (!this.plan) {
      this.plan = buildPlan(
        { attacks: this.attacks, riders: this.riders },
        this.eps
      );
    }
    return this.plan;
  }

  private resolve(): { pmf: PMF; fireMass: ReadonlyMap<string, number> } {
    if (this.resolved) return this.resolved;

    const plan = this.ensurePlan();
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

/** Starts a {@link Turn}, optionally with its attacks already declared. */
export function turn(attacks: readonly Attack[] = [], eps: number = EPS): Turn {
  return Turn.from({ attacks, riders: [] }, eps);
}
