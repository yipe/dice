/**
 * Facade over `rust/dice-node/src/effects.rs` for `src/turn/effects.ts`: the same exports, each
 * effect value a TS object over a native handle (`_handle`, non-enumerable).
 *
 * - `Lasting`/`Grant`: `spec` (a condition's `rule` as the caller gave it) is an own enumerable property computed (and cached) on first read, so
 *   `toEqual` between two effects compares specs as in the TS. `effectSpec`/`grantSpec` return the
 *   exact plain objects the TS builds.
 * - A DC check passed as a trigger save crosses as its handle, a plain `GrantSaveSpec` as plain data.
 *   A JS `failChance` function cannot be called from Rust: it is kept in `failChances` and crosses
 *   as its index (`failChanceKey`); the save-spec readback maps the index back to the same function.
 *   The table only grows (one entry per distinct function).
 * - `gateFields` and `unpackSave` are plain TS over the facade values, as in the source; the one
 *   engine step in them, a DC check's `GrantSaveSpec`, is a native call (`grantSaveSpec`).
 * - `gateToNative` / `grantsToNative` / `lastingFromNative` are for the attack and save facades: they
 *   convert a TS `ConditionGate` / grants to the `JsConditionGate` / `JsGrants` of `effects.rs`, and
 *   lastings back.
 */
import type { DCBuilder } from "../builder/dc";
import type { RollBuilder } from "../builder/roll";
import { wrapRoll } from "../builder/roll";
import { native } from "../native";
import "./errors";
import type { NativeRollHandle } from "../native";
import type {
  ConditionRule,
  ConditionSpec,
  EffectSpec,
  GrantSaveSpec,
  GrantSpec,
  RowContext,
  SaveLanding,
  SubstitutePolicy,
  SubstituteSpec,
} from "../../../../src/turn/types";
import { TurnSpecError } from "../../../../src/turn/types";
import type {
  ConditionEffect,
  ConditionOptions,
  Grant,
  Lasting,
  Modifiers,
  SaveGated,
  SaveModifier,
  StartEffect,
  Transform,
  TriggerSave,
  VulnerabilityEffect,
} from "../../../../src/turn/effects";

export type {
  ConditionEffect,
  ConditionOptions,
  EveryHitOptions,
  FirstHitOptions,
  Grant,
  Lasting,
  Modifiers,
  SaveGated,
  SaveModifier,
  StartEffect,
  Transform,
  TriggerSave,
  VulnerabilityEffect,
} from "../../../../src/turn/effects";

// ---- native handle surfaces -------------------------------------------------------------------------

interface LastingHandle {
  spec(): string;
  isGrant(): boolean;
  to(targets: string[]): LastingHandle;
}

interface ModifiersHandle {
  advantage(): ModifiersHandle;
  disadvantage(): ModifiersHandle;
  critOnHit(): ModifiersHandle;
  untilNextAttack(): LastingHandle;
  untilEndOfTurn(): LastingHandle;
}

interface ConditionHandle {
  untilEndOfTurn(): LastingHandle;
  untilDamaged(): LastingHandle;
}

interface SaveModifierHandle {
  untilNextSave(): LastingHandle;
  untilEndOfTurn(): LastingHandle;
}

interface SubstituteFields {
  substitute: SubstituteSpec["substitute"];
  policy?: SubstitutePolicy;
}

interface TransformHandle {
  ifBelow(hit: number, crit: number): TransformHandle;
  optimally(): TransformHandle;
  fields(): SubstituteFields;
  policy(): SubstitutePolicy;
}

type SaveGatedHandle = object;

/** `JsSaveSpec`: `GrantSaveSpec` as plain data. */
interface NativeSaveSpec {
  ability?: string;
  dc?: number;
  bonus?: number;
  rollType?: string;
  failChanceKey?: number;
}

type NativeTriggerSave = NativeRollHandle | NativeSaveSpec;

/** `JsConditionGate` of `effects.rs`. */
interface NativeGate {
  save?: NativeTriggerSave | NativeTriggerSave[];
  chance?: number;
  onSave?: LastingHandle[];
  landing?: string;
  dealing?: string;
  optional?: boolean;
  targetHas?: string[];
}

const NativeLasting = native.NativeLasting as { vulnerability(): LastingHandle };
const NativeModifiers = native.NativeModifiers as { empty(): ModifiersHandle };
const NativeCondition = native.NativeCondition as { create(name: string, ruleJson: string): ConditionHandle };
const NativeSaveModifier = native.NativeSaveModifier as {
  disadvantage(): SaveModifierHandle;
  penalty(die: NativeRollHandle): SaveModifierHandle;
};
const NativeTransform = native.NativeTransform as { keepBestDamage(): TransformHandle };
const NativeSaveGated = native.NativeSaveGated as {
  create(check: NativeTriggerSave | NativeTriggerSave[], fail: LastingHandle[], pass: LastingHandle[]): SaveGatedHandle;
};

/** Defines the non-enumerable `_handle` of a facade value. */
function withHandle<T extends object>(target: T, handle: object): void {
  Object.defineProperty(target, "_handle", { value: handle });
}

// ---- Transform ---------------------------------------------------------------------------------------------

class SubstituteTransform implements Transform {
  readonly kind = "transform" as const;
  declare readonly _handle: TransformHandle;
  declare readonly substitute: SubstituteSpec["substitute"];
  declare readonly policy: SubstitutePolicy;

  constructor(handle: TransformHandle) {
    withHandle(this, handle);
    let fields: SubstituteFields | undefined;
    Object.defineProperty(this, "substitute", {
      enumerable: true,
      get: () => (fields ??= handle.fields()).substitute,
    });
    Object.defineProperty(this, "policy", { enumerable: true, get: () => handle.policy() });
  }

  ifBelow(threshold: number | { hit: number; crit: number }): Transform {
    const { hit, crit } = typeof threshold === "number" ? { hit: threshold, crit: threshold } : threshold;
    return new SubstituteTransform(this._handle.ifBelow(hit, crit));
  }

  optimally(): Transform {
    return new SubstituteTransform(this._handle.optimally());
  }
}

/** Roll the watched attack's whole base payload again and keep the better total; see `src/turn/effects.ts`. */
export function keepBestDamage(): Transform {
  return new SubstituteTransform(NativeTransform.keepBestDamage());
}

/** True for a {@link Transform} built by a factory in this module. */
export function isTransform(value: unknown): value is Transform {
  return value instanceof SubstituteTransform;
}

/** The JSON-safe fields a {@link Transform} contributes to a {@link SubstituteSpec}. */
export function substituteFields(transform: Transform): Pick<SubstituteSpec, "substitute" | "policy"> {
  return (transform as SubstituteTransform)._handle.fields();
}

// ---- Lasting / Grant -----------------------------------------------------------------------------------------

/** The `count`, `sides` and `d20Penalty` of a spec are strings when not finite (see `effects.rs`). */
const SPEC_NUMBERS: Record<string, true> = { count: true, sides: true, d20Penalty: true };

function parseSpec(json: string): EffectSpec {
  return JSON.parse(json, (key, value: unknown) =>
    SPEC_NUMBERS[key] === true && typeof value === "string" ? Number(value) : value
  ) as EffectSpec;
}

function ruleJson(rule: ConditionRule): string {
  return JSON.stringify(rule, (key, value: unknown) =>
    key === "d20Penalty" && typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))
      ? Object.is(value, -0)
        ? "-0"
        : String(value)
      : value
  );
}

class LastingValue implements Lasting {
  readonly kind = "grant" as const;
  declare readonly _handle: LastingHandle;
  declare readonly spec: EffectSpec;

  /** `rule`: a condition's rule as the caller gave it, which `spec` reports instead of Rust's typed copy. */
  constructor(handle: LastingHandle, rule?: ConditionRule) {
    withHandle(this, handle);
    let spec: EffectSpec | undefined;
    Object.defineProperty(this, "spec", {
      enumerable: true,
      get: () => (spec ??= rule === undefined ? parseSpec(handle.spec()) : { ...parseSpec(handle.spec()), rule }),
    });
  }
}

class GrantValue extends LastingValue implements Grant {
  to(...targets: readonly string[]): Grant {
    return new GrantValue(this._handle.to([...targets]));
  }
}

/** A native effect as the facade class the TS builds it with: a grant or save modifier is a `Grant`. */
export function lastingFromNative(handle: LastingHandle): Lasting {
  return handle.isGrant() ? new GrantValue(handle) : new LastingValue(handle);
}

/** @internal The native handle of an effect built by this module. */
export function lastingHandle(effect: Lasting): LastingHandle {
  return (effect as LastingValue)._handle;
}

class ModifierSet implements Modifiers {
  declare readonly _handle: ModifiersHandle;

  constructor(handle: ModifiersHandle) {
    withHandle(this, handle);
  }

  advantage(): Modifiers {
    return new ModifierSet(this._handle.advantage());
  }

  disadvantage(): Modifiers {
    return new ModifierSet(this._handle.disadvantage());
  }

  critOnHit(): Modifiers {
    return new ModifierSet(this._handle.critOnHit());
  }

  untilNextAttack(): Grant {
    return new GrantValue(this._handle.untilNextAttack());
  }

  untilEndOfTurn(): Grant {
    return new GrantValue(this._handle.untilEndOfTurn());
  }
}

/** Advantage on the attack rolls that read the grant: `advantage().untilNextAttack()`. */
export function advantage(): Modifiers {
  return new ModifierSet(NativeModifiers.empty().advantage());
}

/** Disadvantage on the attack rolls that read the grant; cancels an advantage. */
export function disadvantage(): Modifiers {
  return new ModifierSet(NativeModifiers.empty().disadvantage());
}

/** Every landing attack that reads the grant is a crit: `critOnHit().untilEndOfTurn()`. */
export function critOnHit(): Modifiers {
  return new ModifierSet(NativeModifiers.empty().critOnHit());
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

// ---- conditions, vulnerability, save modifiers ---------------------------------------------------------------

class PendingCondition implements ConditionEffect {
  constructor(
    private readonly handle: ConditionHandle,
    private readonly rule: ConditionRule
  ) {
    withHandle(this, handle);
  }

  untilEndOfTurn(): Lasting {
    return new LastingValue(this.handle.untilEndOfTurn(), this.rule);
  }

  untilDamaged(): Lasting {
    return new LastingValue(this.handle.untilDamaged(), this.rule);
  }
}

class PendingSaveModifier implements SaveModifier {
  constructor(private readonly handle: SaveModifierHandle) {
    withHandle(this, handle);
  }

  untilNextSave(): Grant {
    return new GrantValue(this.handle.untilNextSave());
  }

  untilEndOfTurn(): Grant {
    return new GrantValue(this.handle.untilEndOfTurn());
  }
}

/** A condition the creature has, by name and rule: `condition("frightened", rule).untilEndOfTurn()`. */
export function condition(name: string, rule: ConditionRule): ConditionEffect {
  return new PendingCondition(NativeCondition.create(name, ruleJson(rule)), rule);
}

/** The next hit against the creature deals double damage: `vulnerability().untilNextHit()`. */
export function vulnerability(): VulnerabilityEffect {
  return { untilNextHit: () => new LastingValue(NativeLasting.vulnerability()) };
}

/** Disadvantage on the creature's saves: `saveDisadvantage().untilNextSave().to("spells")`. */
export function saveDisadvantage(): SaveModifier {
  return new PendingSaveModifier(NativeSaveModifier.disadvantage());
}

/** A die subtracted from the creature's saves: `savePenalty(d4).untilNextSave()`. One plain die group. */
export function savePenalty(die: RollBuilder): SaveModifier {
  return new PendingSaveModifier(NativeSaveModifier.penalty(die._handle));
}

/** A {@link StartEffect} as a lasting effect: one without a lifetime lasts the turn. */
export function lastingForTurn(effect: StartEffect): Lasting {
  return isGrant(effect) ? effect : (effect as Exclude<StartEffect, Lasting>).untilEndOfTurn();
}

// ---- trigger saves -------------------------------------------------------------------------------------------

/** True for a DC check (a `DCBuilder`), as opposed to a plain {@link GrantSaveSpec}. */
export function isDCCheck(save: unknown): save is DCBuilder {
  return typeof save === "object" && save !== null && "toPMF" in save && typeof save.toPMF === "function";
}

/**
 * The {@link GrantSaveSpec} of a {@link TriggerSave}. A plain DC check (a d20 plus a flat bonus) is
 * `{ ability, dc, bonus, rollType }`; any other is a `failChance` that rolls the check itself in
 * the target's state. Either way its odds are read off the check's own PMF at `eps`.
 */
export function grantSaveSpec(save: TriggerSave, eps: number = 0): GrantSaveSpec {
  if (!isDCCheck(save)) return save;
  const handle = save._handle;
  const spec = native.grantSaveSpec(handle, eps) as NativeSaveSpec;
  const named = spec.ability === undefined ? {} : { ability: spec.ability };
  if (spec.dc !== undefined && spec.bonus !== undefined) {
    return { ...named, dc: spec.dc, bonus: spec.bonus, ...(spec.rollType === undefined ? {} : { rollType: spec.rollType as GrantSpecRollType }) };
  }
  return { ...named, failChance: (context: RowContext) => native.grantSaveFailChance(handle, eps, context) as number };
}

type GrantSpecRollType = Extract<GrantSaveSpec, { dc: number }>["rollType"] & string;

const failChances: ((context: RowContext) => number)[] = [];
const failChanceKeys = new WeakMap<object, number>();

function failChanceKey(fn: (context: RowContext) => number): number {
  let key = failChanceKeys.get(fn);
  if (key === undefined) {
    key = failChances.push(fn) - 1;
    failChanceKeys.set(fn, key);
  }
  return key;
}

function saveToNative(save: TriggerSave): NativeTriggerSave {
  if (isDCCheck(save)) return save._handle;
  const named = save.ability === undefined ? {} : { ability: save.ability };
  if ("failChance" in save) return { ...named, failChanceKey: failChanceKey(save.failChance) };
  return { ...named, dc: save.dc, bonus: save.bonus, ...(save.rollType === undefined ? {} : { rollType: save.rollType }) };
}

function savesToNative(save: TriggerSave | readonly TriggerSave[]): NativeTriggerSave | NativeTriggerSave[] {
  return Array.isArray(save) ? (save as readonly TriggerSave[]).map(saveToNative) : saveToNative(save as TriggerSave);
}

function saveFromNative(save: NativeTriggerSave): TriggerSave {
  if (save instanceof native.NativeRoll) return wrapRoll(save) as DCBuilder;
  const spec = save as NativeSaveSpec;
  const named = spec.ability === undefined ? {} : { ability: spec.ability };
  if (spec.failChanceKey !== undefined) return { ...named, failChance: failChances[spec.failChanceKey] };
  return {
    ...named,
    dc: spec.dc as number,
    bonus: spec.bonus as number,
    ...(spec.rollType === undefined ? {} : { rollType: spec.rollType as GrantSpecRollType }),
  };
}

// ---- SaveGated ---------------------------------------------------------------------------------------------------

class SaveGatedValue implements SaveGated {
  readonly kind = "save-gated";
  declare readonly _handle: SaveGatedHandle;

  constructor(
    readonly check: TriggerSave | readonly TriggerSave[],
    readonly fail: readonly Lasting[],
    readonly pass: readonly Lasting[]
  ) {
    withHandle(this, NativeSaveGated.create(savesToNative(check), fail.map(lastingHandle), pass.map(lastingHandle)));
    Object.freeze(this);
  }
}

/** One value or a list of them, as a fresh list. */
function listOf<T>(value: T | readonly T[]): T[] {
  // `Array.isArray` does not narrow a readonly array out of the union.
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

/** `effects` as a fresh list, each one checked to be an effect with a lifetime (not damage). */
function asList(effects: Lasting | readonly Lasting[]): readonly Lasting[] {
  const list = listOf(effects);
  if (!list.every(isGrant)) {
    throw new TypeError("save() takes effects with a lifetime, such as advantage().untilNextAttack(); damage goes in its own call.");
  }
  return list;
}

/**
 * The target saves against `check`; `fail` applies on a failure, `pass` (if given) on a success.
 *
 * @throws {TypeError} on no check (an empty list, or none at all), or a `fail` with no effect.
 */
export function save(
  check: TriggerSave | readonly TriggerSave[],
  outcomes: { fail: Lasting | readonly Lasting[]; pass?: Lasting | readonly Lasting[] }
): SaveGated {
  const checks = listOf(check);
  // Without a check, gateFields would drop the save and the `fail` effects would always apply.
  if (checks.length === 0 || checks.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new TypeError("save() needs a DC check such as d20.plus(2).dc(15), a GrantSaveSpec, or a non-empty list of them.");
  }
  const fail = asList(outcomes.fail);
  if (fail.length === 0) throw new TypeError("save() needs at least one effect on a failed save.");
  return new SaveGatedValue(
    Array.isArray(check) ? checks : checks[0],
    fail,
    outcomes.pass === undefined ? [] : asList(outcomes.pass)
  );
}

/** True for a value built by {@link save}; a look-alike object is not one. */
export function isSaveGated(value: unknown): value is SaveGated {
  return value instanceof SaveGatedValue;
}

/**
 * The options a trigger verb's `effect` and `options` stand for once a {@link save} value is
 * unpacked into them: its `fail` as the effects, its check and `pass` as `save` and `onSave`.
 *
 * @throws {Error} where `options` already gates the call (`save`, `chance` or `onSave`).
 */
export function unpackSave<O extends Pick<ConditionOptions, "save" | "chance" | "onSave">>(
  gated: SaveGated,
  options: O
): { effects: readonly Lasting[]; options: O } {
  if (options.save !== undefined || options.chance !== undefined || options.onSave !== undefined) {
    throw new Error("A save() value carries its own save and pass effects: drop save, chance and onSave from the options.");
  }
  return {
    effects: gated.fail,
    options: { ...options, save: gated.check, ...(gated.pass.length === 0 ? {} : { onSave: gated.pass }) },
  };
}

/**
 * The fields of a {@link ConditionSpec} that a trigger verb's options (or a builder's attached
 * gate) set, beside `on`, `of` and `grants`. Every save, a DC check included, is rolled by the walk
 * in the target's state; `chance` is the only fixed gate.
 */
export function gateFields(
  options: Pick<ConditionOptions, "save" | "chance" | "onSave" | "landing" | "dealing" | "optional" | "targetHas">,
  eps: number
): Omit<ConditionSpec, "on" | "of" | "grants" | "id"> {
  const { save, chance, onSave, landing, dealing, optional, targetHas } = options;
  // A plain-JS caller can still pass the `target` the types no longer offer: refuse it rather than drop it.
  if ("target" in options && options.target !== undefined) {
    throw new TurnSpecError(
      "unsupported-trigger",
      "",
      "A trigger takes no target: its effects go on the creature of the row that lands them. Use atStart(effect, { target }) for a creature's starting state."
    );
  }
  if (save !== undefined && chance !== undefined) {
    throw new Error("Pass either save or chance, not both: each is the chance the grants take.");
  }
  if (onSave !== undefined && save === undefined && chance === undefined) {
    throw new Error("onSave needs a save or a chance: without one there is no other branch to apply it on.");
  }
  const saves = save === undefined ? [] : listOf(save);
  if (saves.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new Error("save must be a DC check such as d20.plus(2).dc(15), or a GrantSaveSpec.");
  }
  const grantSaves = saves.map((entry) => grantSaveSpec(entry, eps));
  const saved = onSave === undefined ? [] : listOf(onSave);
  return {
    ...(chance === undefined ? {} : { chance }),
    ...(landing === undefined ? {} : { landing }),
    ...(dealing === undefined ? {} : { dealing }),
    ...(grantSaves.length === 0 ? {} : { save: Array.isArray(save) ? grantSaves : grantSaves[0] }),
    ...(saved.length === 0 ? {} : { onSave: saved.map(effectSpec) }),
    ...(optional === undefined ? {} : { optional }),
    ...(targetHas === undefined ? {} : { targetHas: listOf(targetHas) }),
  };
}

// ---- for the attack and save facades -------------------------------------------------------------------------------

type ConditionGate = Pick<ConditionOptions, "save" | "chance" | "onSave" | "landing" | "dealing" | "optional" | "targetHas">;

/** A TS `ConditionGate` as the `JsConditionGate` of `effects.rs`; `undefined` stays `undefined`. */
export function gateToNative(gate: ConditionGate | undefined): NativeGate | undefined {
  if (gate === undefined) return undefined;
  return {
    ...(gate.save === undefined ? {} : { save: savesToNative(gate.save) }),
    ...(gate.chance === undefined ? {} : { chance: gate.chance }),
    ...(gate.onSave === undefined ? {} : { onSave: listOf(gate.onSave).map(lastingHandle) }),
    ...(gate.landing === undefined ? {} : { landing: gate.landing }),
    ...(gate.dealing === undefined ? {} : { dealing: gate.dealing }),
    ...(gate.optional === undefined ? {} : { optional: gate.optional }),
    ...(gate.targetHas === undefined ? {} : { targetHas: listOf(gate.targetHas) }),
  };
}

/** What `onEveryHit` / `onAnyCrit` / `onFirstCrit` take, as the `JsGrants` of `effects.rs`. */
export function grantsToNative(grants: Lasting | readonly Lasting[] | SaveGated): LastingHandle | LastingHandle[] | SaveGatedHandle {
  if (isSaveGated(grants)) return (grants as SaveGatedValue)._handle;
  return Array.isArray(grants) ? (grants as readonly Lasting[]).map(lastingHandle) : lastingHandle(grants as Lasting);
}
