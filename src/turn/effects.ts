import type { DCBuilder } from "../builder/dc";
import type { GrantSpec, RiderOptions, SubstitutePolicy, SubstituteSpec } from "./types";
import { TurnSpecError } from "./types";

/**
 * A payload transform a trigger verb accepts, as opposed to damage (a rider).
 * Built only by a named factory such as {@link keepBestDamage}, so the wire kind
 * never appears at a call site. Immutable: every method returns a new value.
 */
export interface Transform {
  readonly kind: "transform";
  /**
   * Spend only when the base payload total (dice plus the payload's own flat
   * bonus, excluding separate-damage channels) is below `threshold` in the mode
   * that landed; otherwise hold for the next watched attack. The threshold
   * applies only while a later watched step can still land in the current turn
   * state; when none can, any landing spends, since holding is worth nothing.
   * A single number applies to both modes, which for a crit's doubled dice
   * usually means "hold" — pass `{ hit, crit }` to set each.
   *
   * Compares the payload's own values, so it works on any payload: a builder, a
   * parsed string or a bare `PMF`.
   */
  ifBelow(threshold: number | { hit: number; crit: number }): Transform;
  /**
   * Spend by backward induction over the remaining steps. Not supported in this
   * release: throws `TurnSpecError("unsupported-policy")`.
   */
  optimally(): Transform;
}

class SubstituteTransform implements Transform {
  readonly kind = "transform" as const;

  constructor(
    readonly substitute: SubstituteSpec["substitute"],
    readonly policy: SubstitutePolicy
  ) {}

  ifBelow(threshold: number | { hit: number; crit: number }): Transform {
    const { hit, crit } =
      typeof threshold === "number" ? { hit: threshold, crit: threshold } : threshold;
    if (Number.isNaN(hit) || Number.isNaN(crit)) {
      throw new RangeError("ifBelow() needs numeric thresholds, got NaN.");
    }
    return new SubstituteTransform(this.substitute, { kind: "below", hit, crit });
  }

  optimally(): Transform {
    throw new TurnSpecError(
      "unsupported-policy",
      "",
      "optimally() is not supported in this release; use ifBelow({ hit, crit }) with the thresholds you want."
    );
  }
}

/**
 * Roll the watched attack's whole base payload again and keep the better total —
 * once per turn. Pass it to `Turn.onFirstHit`:
 *
 * ```ts
 * turn([sword, sword]).onFirstHit(keepBestDamage());
 * ```
 *
 * The transform reads the attack's own damage, so no dice are restated. It never
 * touches `plusSeparateDamage` channels, `every-hit` rider damage, or the miss
 * branch, and a crit transforms the crit payload (the already-doubled dice).
 *
 * **Policy.** The default spends on the first watched attack that lands, whatever
 * it rolled. That is a named policy, not optimal play: a player who sees a high
 * roll holds the reroll for a later attack. The figure is therefore a lower bound.
 * Two `d20+5` attacks against AC 12 dealing `2d6+3` score 15.9849 under this
 * policy against 16.1889 for the optimal hold/use policy (14.7000 without the
 * transform); {@link Transform.ifBelow} with `{ hit: 10, crit: 18 }` reaches the
 * optimum on that turn.
 */
export function keepBestDamage(): Transform {
  return new SubstituteTransform("reroll-keep-higher", { kind: "always" });
}

/** True for a {@link Transform} built by a factory in this module. */
export function isTransform(value: unknown): value is Transform {
  return value instanceof SubstituteTransform;
}

/** The JSON-safe fields a {@link Transform} contributes to a {@link SubstituteSpec}. */
export function substituteFields(
  transform: Transform
): Pick<SubstituteSpec, "substitute" | "policy"> {
  const { substitute, policy } = transform as SubstituteTransform;
  return policy.kind === "always" ? { substitute } : { substitute, policy };
}

/**
 * What a grant does to the attack rolls that read it, before it has a lifetime.
 * Not yet a {@link Grant}: a trigger verb refuses it at compile time, so a
 * forgotten lifetime is a type error rather than a silent default. Immutable.
 */
export interface Modifiers {
  /** Adds advantage; repeating a modifier is a no-op. */
  advantage(): Modifiers;
  disadvantage(): Modifiers;
  /** Every landing attack is a crit; a natural 1 still misses. */
  critOnHit(): Modifiers;
  /** Consumed by the next attack roll that reads it, hit or miss. */
  untilNextAttack(): Grant;
  /** Lasts for the rest of the turn. */
  untilEndOfTurn(): Grant;
}

/**
 * A modifier with a lifetime: the only thing a trigger verb accepts besides damage
 * and transforms. Pass several in an array to have one outcome (and one save)
 * apply them together. Immutable.
 */
export interface Grant {
  readonly kind: "grant";
  /**
   * The attack ids, attack-shaped rider ids or tags that read it. Omitted, every
   * later attack roll does. Naming nothing that comes after the condition's
   * sources is `unknown-id`.
   */
  to(...targets: readonly string[]): Grant;
}

type Modifier = "advantage" | "disadvantage" | "critOnHit";

class ModifierSet implements Modifiers {
  constructor(private readonly set: Readonly<Partial<Record<Modifier, true>>>) {}

  advantage(): Modifiers {
    return new ModifierSet({ ...this.set, advantage: true });
  }

  disadvantage(): Modifiers {
    return new ModifierSet({ ...this.set, disadvantage: true });
  }

  critOnHit(): Modifiers {
    return new ModifierSet({ ...this.set, critOnHit: true });
  }

  untilNextAttack(): Grant {
    return new GrantValue({ ...this.set, until: "next-attack" });
  }

  untilEndOfTurn(): Grant {
    return new GrantValue({ ...this.set, until: "end-of-turn" });
  }
}

class GrantValue implements Grant {
  readonly kind = "grant" as const;

  constructor(readonly spec: GrantSpec) {}

  to(...targets: readonly string[]): Grant {
    return new GrantValue({ ...this.spec, to: [...targets] });
  }
}

/** Advantage on the attack rolls that read the grant: `advantage().untilNextAttack()`. */
export function advantage(): Modifiers {
  return new ModifierSet({ advantage: true });
}

/** Disadvantage on the attack rolls that read the grant; cancels an advantage. */
export function disadvantage(): Modifiers {
  return new ModifierSet({ disadvantage: true });
}

/** Every landing attack that reads the grant is a crit: `critOnHit().untilEndOfTurn()`. */
export function critOnHit(): Modifiers {
  return new ModifierSet({ critOnHit: true });
}

/** True for a {@link Grant} built by a factory in this module. */
export function isGrant(value: unknown): value is Grant {
  return value instanceof GrantValue;
}

/** The JSON-safe form of a {@link Grant}. */
export function grantSpec(grant: Grant): GrantSpec {
  return (grant as GrantValue).spec;
}

/**
 * Rider options plus what gates a call's grants. The gate applies to grants only:
 * damage passed in the same call lands whatever the save does.
 */
export interface ConditionOptions extends RiderOptions {
  /** The target's save; its P(fail) is the chance the grants take. */
  save?: DCBuilder;
  /** In `[0, 1]`; mutually exclusive with `save`. */
  chance?: number;
  /** Grants applied on the other branch: the save succeeded (or `1 - chance`). */
  onSave?: Grant | readonly Grant[];
}
