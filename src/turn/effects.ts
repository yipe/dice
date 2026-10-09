import type { DCBuilder } from "../builder/dc";
import type { RollBuilder } from "../builder/roll";
import type {
  ConditionRule,
  ConditionSpec,
  EffectSpec,
  GrantSaveSpec,
  GrantSpec,
  PerSource,
  RiderOptions,
  SubstitutePolicy,
  SubstituteSpec,
} from "./types";
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
 *
 * **Ties.** When the fresh total ties the original, the original roll is kept. The
 * total is the same either way, but a `dice-match` trigger reading the attack sees
 * the kept dice's match status: a player who would take a tied roll because its
 * dice matched is not modelled.
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
 * Any effect with a lifetime: what a trigger verb accepts besides damage and transforms.
 * Pass several in an array to have one outcome (and one save) apply them together. Immutable.
 */
export interface Lasting {
  readonly kind: "grant";
}

/** A {@link Lasting} effect that can be scoped to the rows that read it. Immutable. */
export interface Grant extends Lasting {
  /**
   * The attack ids, attack-shaped rider ids or tags that read it. Omitted, every
   * later row does. Naming nothing that comes after the condition's
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

class LastingValue implements Lasting {
  readonly kind = "grant" as const;

  constructor(readonly spec: EffectSpec) {}
}

class GrantValue extends LastingValue implements Grant {
  to(...targets: readonly string[]): Grant {
    return new GrantValue({ ...this.spec, to: [...targets] } as EffectSpec);
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

/** True for a {@link Lasting} effect built by a factory in this module. */
export function isGrant(value: unknown): value is Grant {
  return value instanceof LastingValue;
}

/** The JSON-safe form of a {@link Grant} built by `advantage()`, `disadvantage()` or `critOnHit()`. */
export function grantSpec(grant: Grant): GrantSpec {
  return effectSpec(grant) as GrantSpec;
}

/** The JSON-safe form of any {@link Lasting} effect. */
export function effectSpec(effect: Lasting): EffectSpec {
  return (effect as LastingValue).spec;
}

/** A condition before it has a lifetime: `prone()`, `condition("frightened", rule)`. Immutable. */
export interface ConditionEffect {
  /** Lasts for the rest of the turn. */
  untilEndOfTurn(): Lasting;
  /** Ends when the creature takes damage; the rule's `onEnd` condition is left for the rest of the turn. */
  untilDamaged(): Lasting;
}

/** Vulnerability before it has a lifetime; its only lifetime is the next hit. */
export interface VulnerabilityEffect {
  /** The next hit against the creature deals double damage, then it ends. */
  untilNextHit(): Lasting;
}

/** A modifier on the creature's saves before it has a lifetime. Immutable. */
export interface SaveModifier {
  /** Consumed by the creature's next save. */
  untilNextSave(): Grant;
  /** Lasts for the rest of the turn. */
  untilEndOfTurn(): Grant;
}

/** What {@link Turn.atStart} accepts: an effect with a lifetime, or one without (meaning the turn). */
export type StartEffect = Lasting | Modifiers | ConditionEffect | SaveModifier;

class PendingCondition implements ConditionEffect {
  constructor(
    private readonly name: string,
    private readonly rule: ConditionRule
  ) {}

  untilEndOfTurn(): Lasting {
    return new LastingValue({ condition: this.name, rule: this.rule, until: "end-of-turn" });
  }

  untilDamaged(): Lasting {
    return new LastingValue({ condition: this.name, rule: this.rule, until: "until-damaged" });
  }
}

type SaveFields = { saveDisadvantage: true } | { savePenalty: { count: number; sides: number } };

class PendingSaveModifier implements SaveModifier {
  constructor(private readonly fields: SaveFields) {}

  untilNextSave(): Grant {
    return new GrantValue({ ...this.fields, until: "next-save" });
  }

  untilEndOfTurn(): Grant {
    return new GrantValue({ ...this.fields, until: "end-of-turn" });
  }
}

/** A condition the creature has, by name and rule: `condition("frightened", rule).untilEndOfTurn()`. */
export function condition(name: string, rule: ConditionRule): ConditionEffect {
  return new PendingCondition(name, rule);
}

/** The next hit against the creature deals double damage: `vulnerability().untilNextHit()`. */
export function vulnerability(): VulnerabilityEffect {
  return { untilNextHit: () => new LastingValue({ vulnerability: true, until: "next-hit" }) };
}

/** Disadvantage on the creature's saves: `saveDisadvantage().untilNextSave().to("spells")`. */
export function saveDisadvantage(): SaveModifier {
  return new PendingSaveModifier({ saveDisadvantage: true });
}

/**
 * A die subtracted from the creature's saves: `savePenalty(d4).untilNextSave()`. Takes one
 * plain die group, `d4` or `roll(2, d4)`.
 */
export function savePenalty(die: RollBuilder): SaveModifier {
  const configs = die.getSubRollConfigs();
  const [config] = configs;
  if (configs.length !== 1 || config === undefined || config.modifier !== 0 || config.count < 1) {
    throw new Error("savePenalty takes one plain die group, such as d4 or roll(1, d4).");
  }
  return new PendingSaveModifier({ savePenalty: { count: config.count, sides: config.sides } });
}

/** A {@link StartEffect} as a lasting effect: one without a lifetime lasts the turn. */
export function lastingForTurn(effect: StartEffect): Lasting {
  return isGrant(effect) ? effect : (effect as Exclude<StartEffect, Lasting>).untilEndOfTurn();
}

/**
 * A trigger's save: a DC check whose `ability` (when it has one) and numbers become a
 * state-aware {@link GrantSaveSpec}, or that spec itself.
 */
export type TriggerSave = DCBuilder | GrantSaveSpec;

/** The {@link GrantSaveSpec} of a {@link TriggerSave}. Reads an `ability` string off a DC check when it carries one. */
export function grantSaveSpec(save: TriggerSave): GrantSaveSpec {
  if (!isDCCheck(save)) return save;
  const ability = "ability" in save ? save.ability : undefined;
  const rollType = save.rollType;
  return {
    ...(typeof ability === "string" ? { ability } : {}),
    dc: save.saveDC,
    bonus: save.modifier,
    ...(rollType === "flat" ? {} : { rollType }),
  };
}

/** True for a DC check (a `DCBuilder`), as opposed to a plain {@link GrantSaveSpec}. */
export function isDCCheck(save: unknown): save is DCBuilder {
  return typeof save === "object" && save !== null && "toPMF" in save && typeof save.toPMF === "function";
}

/**
 * The fields of a {@link ConditionSpec} that a trigger verb's options (or a builder's attached
 * gate) set, beside `on`, `of` and `grants`. A lone DC check with no ability is the 0.16 gate:
 * its P(fail), which the DC check's PMF puts at 1 (`vsAC` leaves it alone — it is the target's
 * save bonus, not its AC). Any other save is state-aware, rolled by the walk.
 */
export function gateFields(
  options: Pick<ConditionOptions, "save" | "chance" | "onSave" | "landing" | "dealing" | "target" | "optional">,
  eps: number
): Omit<ConditionSpec, "on" | "of" | "grants" | "id"> {
  const { save, chance, onSave, landing, dealing, target, optional } = options;
  if (save !== undefined && chance !== undefined) {
    throw new Error("Pass either save or chance, not both: each is the chance the grants take.");
  }
  if (onSave !== undefined && save === undefined && chance === undefined) {
    throw new Error("onSave needs a save or a chance: without one there is no other branch to apply it on.");
  }
  // `Array.isArray` does not narrow a readonly array out of the union.
  const saves = (save === undefined ? [] : Array.isArray(save) ? save : [save]) as readonly TriggerSave[];
  if (saves.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new Error("save must be a DC check such as d20.plus(2).dc(15), or a GrantSaveSpec.");
  }
  const [lone] = saves;
  const legacy = !Array.isArray(save) && isDCCheck(lone) && grantSaveSpec(lone).ability === undefined;
  const probability = legacy && isDCCheck(lone) ? lone.toPMF(eps).pAt(1) : chance;
  const grantSaves = legacy ? [] : saves.map(grantSaveSpec);
  const saved = (onSave === undefined ? [] : Array.isArray(onSave) ? onSave : [onSave]) as readonly Lasting[];
  return {
    ...(probability === undefined ? {} : { chance: probability }),
    ...(landing === undefined ? {} : { landing }),
    ...(dealing === undefined ? {} : { dealing }),
    ...(target === undefined ? {} : { target }),
    ...(grantSaves.length === 0 ? {} : { save: Array.isArray(save) ? grantSaves : grantSaves[0] }),
    ...(saved.length === 0 ? {} : { onSave: saved.map(effectSpec) }),
    ...(optional === undefined ? {} : { optional }),
  };
}

/**
 * Rider options plus what gates a call's grants. The gate applies to grants only:
 * damage passed in the same call lands whatever the save does.
 */
export interface ConditionOptions extends RiderOptions {
  /**
   * The target's save. A DC check with no `ability` is the 0.16 gate: its P(fail) is the chance
   * the grants take. One that names an ability, a plain {@link GrantSaveSpec}, or a list of
   * them (the target picks the one it passes most) is rolled in the target's state.
   */
  save?: TriggerSave | readonly TriggerSave[];
  /** In `[0, 1]`; mutually exclusive with `save`. */
  chance?: number;
  /** Effects applied on the other branch: the save succeeded (or `1 - chance`). */
  onSave?: Lasting | readonly Lasting[];
  /** The landing must deal damage of this type. */
  dealing?: string;
  /** The creature the effects go on. */
  target?: string;
  /** "You can": the turn takes the effects only where that raises the mean. */
  optional?: true;
  /** The probability, in `[0, 1]`, that the call's damage happens at all this turn. */
  happens?: number;
}

/**
 * What {@link Turn.onFirstHit} accepts: a condition's options, plus a payload per landing
 * source. A call that carries grants or a transform refuses it: neither has a payload, so
 * put the damage in its own call.
 */
export interface FirstHitOptions extends ConditionOptions {
  /**
   * The damage dealt when a particular source lands first, for a payload that depends on the
   * landing attack (its damage type, the target's scale for it). A source not listed deals the
   * call's damage. Keys are ids the rider watches; a tag is not accepted.
   */
  perSource?: PerSource;
}

/**
 * What {@link Turn.onEveryHit} accepts: the first-hit options, plus a cap. A call that carries
 * grants refuses both: a grant is never capped and has no payload.
 */
export interface EveryHitOptions extends FirstHitOptions {
  /**
   * Applies the damage to at most this many landings among `of`, in turn order: a positive
   * integer. Superiority dice are `max: n` over the turn's attacks; `max: 1` is `onFirstHit`.
   * Omit it for every landing.
   */
  max?: number;
}
