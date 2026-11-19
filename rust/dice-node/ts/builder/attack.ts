import type { Rng } from "../../../../src/common/rng";
import type { DiceMatchInfo } from "../../../../src/common/types";
import { EPS } from "../../../../src/common/types";
import type { SampledDie, RollSample } from "../../../../src/builder/sample";
import type {
  AttackRange,
  AttackResolution,
  Check,
  CheckBuilder,
  MissRerollMode,
  RollType,
} from "../../../../src/builder/types";
import type { ConditionOptions, Lasting, SaveGated } from "../../../../src/turn/effects";
import type { ContextualSource, RowCheck, RowContext } from "../../../../src/turn/types";
import { IGNORES_JOINED } from "../../../../src/turn/context";
import { native, type NativeAttackHandle, type NativeRollHandle } from "../native";
import { PMF } from "../pmf/pmf";
import { gateToNative, grantsToNative, isSaveGated, unpackSave } from "../turn/effects";
import type { ACBuilder } from "./ac";
import type { RerollUpToOptions, AlwaysCritBuilder, AlwaysHitBuilder } from "./roll";
import { clearMatchCache } from "./reroll-pool";
import { RollBuilder, wrapRoll } from "./roll";

/**
 * Facade over the Rust `NativeAttack` (rust/dice-node/src/attack.rs). One native call per method;
 * the Rust builder owns every payload, so the getters below read the handle (and cache on the
 * immutable object) instead of holding fields. `withCheck(fn)` hands `fn` to Rust as a callback:
 * Rust calls it once, synchronously, with the check (its roll as a native handle, wrapped here as a
 * `RollBuilder`), and a throw in `fn` surfaces unchanged after the Rust call returns.
 *
 * Gaps against `src/builder/attack.ts`: the public constructor takes only `(check, hitEffect?)`
 * (the other positional parts are built through the fluent methods).
 */

type ActionEffect = RollBuilder;
type CheckRoll = ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder;

/** A condition a builder carries into a turn: see `src/builder/attack.ts`. */
export interface AttachedCondition {
  on: "every-hit" | "any-crit" | "first-crit";
  grants: Lasting | readonly Lasting[];
  gate?: ConditionGate;
}

/** What gates an attached condition's grants: the same fields `Turn`'s trigger verbs accept. */
export type ConditionGate = Pick<
  ConditionOptions,
  "save" | "chance" | "onSave" | "landing" | "dealing" | "optional" | "targetHas"
>;

/** Test seam: with `false`, `missRerolled` bypasses its Rust cache. */
export function setMissRerolledCacheEnabled(enabled: boolean): void {
  native.setMissRerolledCacheEnabled(enabled);
}

/** Empties the resolved-attack, rerolled-miss and reroll-pool match caches. */
export function clearAttackCache(): void {
  native.clearCache("attack");
  native.clearCache("missRerolled");
  clearMatchCache();
}

/** One roll of an attack: the check dice, the payload dice and what landed. */
export interface AttackSample {
  outcome: "hit" | "crit" | "miss";
  /** The d20s (dropped ones `kept: false`), then the bonus dice; empty for `alwaysHits().alwaysCrits()`. */
  check: SampledDie[];
  /** The base payload's dice (the doubled pool on a crit), then each separate channel's, or the miss payload's. */
  damage: SampledDie[];
  total: number;
  /** On a landing, the payload split at the base (see {@link AttackBuilder.samplePayload}); absent on a miss. */
  payload?: AttackPayloadSample;
}

/** One landing's payload dice, split at the base, and the whole-roll scale its total takes. */
export interface AttackPayloadSample {
  base: RollSample;
  separate: RollSample[];
  scale: 1 | 2;
}

/** `Check` as the native callback sees it: the roll is a native handle. */
interface NativeCheck {
  roll: NativeRollHandle;
  ac: number;
  critThreshold: number;
  rollType: RollType;
  advantageDice: number;
  critOnHit: boolean;
  missReroll?: MissRerollMode | null;
}

interface NativeMatchInfo {
  damages: number[];
  probabilities: number[];
}

/** Every value of a lazily read field a wrapped (immutable) attack caches. */
interface Cache {
  check?: CheckRoll;
  hitEffect?: { value: ActionEffect | undefined };
  critEffect?: { value: ActionEffect | null | undefined };
  missEffect?: { value: ActionEffect | undefined };
  separateDamage?: readonly ActionEffect[];
  natural20Damage?: readonly ActionEffect[];
  rowCheck?: RowCheck;
  /** `toPMF(eps)` by `eps`: the attack is immutable, so one PMF per object stands for the TS resolved-attack cache. */
  pmfs?: Map<number, PMF>;
}

/** What a facade attack keeps beside its handle. */
interface State {
  attached: readonly AttachedCondition[];
  tags: readonly string[];
  damageType?: string;
  rerollThreshold?: number;
  minimumDieValue?: number;
}

function contextIn(context: RowContext): unknown {
  return { ...context, penaltyDice: context.penaltyDice.map((p) => ({ ...p })), joined: [...context.joined] };
}

function contextOpt(context: RowContext | undefined): unknown {
  return context === undefined ? undefined : contextIn(context);
}

/** A native `(die, chance)` callback pair over `rng`: the user's `this` survives. */
function dice(rng: Rng): [(sides: number) => number, (p: number) => boolean] {
  return [(n: number) => rng.die(n), (p: number) => rng.chance(p)];
}

export class AttackBuilder implements CheckBuilder, ContextualSource {
  /** @internal the native handle. */
  _handle!: NativeAttackHandle;
  private _cache?: Cache;
  /** Conditions carried into a turn, as the caller gave them (a single `Lasting` stays single). */
  declare readonly attached: readonly AttachedCondition[];
  /** The one damage type of the whole row, set by {@link typed}. */
  declare readonly damageType?: string;
  /** Names a turn's `of` and `to` can watch this attack by, set by {@link tagged}. */
  declare readonly tags: readonly string[];
  /** The raw argument `rerollDamage()` was last called with: a repeat of it is a no-op returning `this`. */
  declare private readonly rerollThreshold?: number;
  /** The `minimumDamageDie()` argument, likewise. */
  declare private readonly minimumDieValue?: number;

  /** `new AttackBuilder(check, hitEffect?)`: the check and a hit payload; the rest are fluent verbs. */
  constructor(check: CheckRoll, hitEffect?: ActionEffect) {
    this._handle =
      hitEffect === undefined
        ? native.NativeAttack.createWithoutDamage(check._handle)
        : native.NativeAttack.create(check._handle, hitEffect._handle);
    AttackBuilder.setState(this, { attached: [], tags: [] });
  }

  /** The facts the Rust builder also holds, kept here as plain data so reading them crosses nothing. */
  private static setState(target: AttackBuilder, state: State): void {
    Object.assign(target, state);
    if (state.damageType !== undefined) {
      const handle = target._handle as NativeAttackHandle;
      Object.defineProperty(target, "dealt", {
        enumerable: true,
        value: (type: string, context: RowContext) =>
          handle.dealt(type, contextIn(context)) as { hit: number; crit: number },
      });
    }
  }

  /** @internal Wraps a native attack handle that carries no attached conditions, tags or damage type. */
  static _wrap(handle: NativeAttackHandle): AttackBuilder {
    const a = Object.create(AttackBuilder.prototype) as AttackBuilder;
    a._handle = handle;
    AttackBuilder.setState(a, { attached: [], tags: [] });
    return a;
  }

  private get state(): State {
    return {
      attached: this.attached,
      tags: this.tags,
      damageType: this.damageType,
      rerollThreshold: this.rerollThreshold,
      minimumDieValue: this.minimumDieValue,
    };
  }

  /** The attack `handle` derived from this one: it keeps this one's state, but for `change`. */
  private derive(handle: NativeAttackHandle, change: Partial<State> = {}): AttackBuilder {
    const next = Object.create(AttackBuilder.prototype) as AttackBuilder;
    next._handle = handle;
    AttackBuilder.setState(next, { ...this.state, ...change });
    return next;
  }

  private cache(): Cache {
    return (this._cache ??= {});
  }

  /**
   * Present only on a {@link typed} attack, so an untyped row cannot say what type it deals
   * (a `dealing` condition that reads one is `not-an-attack`). See {@link ContextualSource.dealt}.
   */
  declare readonly dealt?: (type: string, context: RowContext) => { hit: number; crit: number };

  /** The check: an `ac()`, `alwaysHits()` or `alwaysCrits()` roll. */
  get check(): CheckRoll {
    return (this.cache().check ??= wrapRoll(this._handle.check()) as CheckRoll);
  }

  private get hitEffect(): ActionEffect | undefined {
    const c = this.cache();
    return (c.hitEffect ??= { value: optRoll(this._handle.hitEffect()) }).value;
  }

  /** `undefined`: the hit dice doubled; `null`: `noCrit()`; else the explicit crit roll. */
  private get critEffect(): ActionEffect | null | undefined {
    const c = this.cache();
    if (c.critEffect === undefined) {
      const kind = this._handle.critEffectKind() as "auto" | "none" | "roll";
      c.critEffect = {
        value: kind === "auto" ? undefined : kind === "none" ? null : optRoll(this._handle.critEffectRoll()),
      };
    }
    return c.critEffect.value;
  }

  private get missEffect(): ActionEffect | undefined {
    const c = this.cache();
    return (c.missEffect ??= { value: optRoll(this._handle.missEffect()) }).value;
  }

  private get separateDamage(): readonly ActionEffect[] {
    return (this.cache().separateDamage ??= (this._handle.separateDamage() as NativeRollHandle[]).map(wrapRoll));
  }

  private get natural20Damage(): readonly ActionEffect[] {
    return (this.cache().natural20Damage ??= (this._handle.natural20Damage() as NativeRollHandle[]).map(wrapRoll));
  }

  private get halfOnMissFlag(): boolean {
    return this._handle.halfOnMissFlag() as boolean;
  }

  private get rerollPool(): { readonly budget: number; readonly rolls: number } | undefined {
    return (this._handle.rerollPool() ?? undefined) as { budget: number; rolls: number } | undefined;
  }

  private get landingScale(): 1 | 2 {
    return this._handle.landingScale() as 1 | 2;
  }

  typed(damageType: string): AttackBuilder {
    if (typeof damageType !== "string" || damageType.length === 0) {
      throw new TypeError('typed() takes a damage type name, such as "cold".');
    }
    return this.derive(this._handle.typed(damageType), { damageType });
  }

  tagged(...tags: string[]): AttackBuilder {
    if (tags.length === 0) throw new TypeError('tagged() takes at least one tag, such as "finesse".');
    const bad = tags.findIndex((tag) => typeof tag !== "string" || tag.length === 0);
    if (bad !== -1) throw new TypeError(`tagged() takes non-empty strings, got ${String(JSON.stringify(tags[bad]))}.`);
    return this.derive(this._handle.tagged(tags), { tags: [...new Set([...this.tags, ...tags])] });
  }

  onCrit(val: number): AttackBuilder;
  onCrit(val: string): AttackBuilder;
  onCrit(val: RollBuilder): AttackBuilder;
  onCrit(count: number, die: RollBuilder): AttackBuilder;
  onCrit(count: number, sides: number): AttackBuilder;
  onCrit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onCrit(count: number, sides: number, modifier: number): AttackBuilder;
  onCrit(...args: unknown[]): AttackBuilder {
    return this.derive(this._handle.onCrit(args.map(argIn)));
  }

  onMiss(val: number): AttackBuilder;
  onMiss(val: string): AttackBuilder;
  onMiss(val: RollBuilder): AttackBuilder;
  onMiss(count: number, die: RollBuilder): AttackBuilder;
  onMiss(count: number, sides: number): AttackBuilder;
  onMiss(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onMiss(count: number, sides: number, modifier: number): AttackBuilder;
  onMiss(...args: unknown[]): AttackBuilder {
    return this.derive(this._handle.onMiss(args.map(argIn)));
  }

  noCrit(): AttackBuilder {
    return this.derive(this._handle.noCrit());
  }

  plusSeparateDamage(damage: RollBuilder): AttackBuilder {
    return this.derive(this._handle.plusSeparateDamage(damage._handle));
  }

  plusNatural20Damage(damage: RollBuilder): AttackBuilder {
    return this.derive(this._handle.plusNatural20Damage(damage._handle));
  }

  rerollDamage(threshold: number): AttackBuilder {
    const next = this._handle.rerollDamage(threshold);
    return threshold === this.rerollThreshold ? this : this.derive(next, { rerollThreshold: threshold });
  }

  minimumDamageDie(minimum: number): AttackBuilder {
    const next = this._handle.minimumDamageDie(minimum);
    return minimum === this.minimumDieValue ? this : this.derive(next, { minimumDieValue: minimum });
  }

  rerollDamageUpTo(budget: number, options?: RerollUpToOptions): AttackBuilder {
    const before = this.rerollPool;
    const next = this._handle.rerollDamageUpTo(budget, options?.rolls);
    return before !== undefined && before.budget === budget && before.rolls === (options?.rolls ?? 1)
      ? this
      : this.derive(next);
  }

  halfOnMiss(): AttackBuilder {
    const next = this._handle.halfOnMiss();
    return next == null ? this : this.derive(next);
  }

  rerollMisses(mode: MissRerollMode = "add-d20"): AttackBuilder {
    const next = this._handle.rerollMisses(mode);
    return next == null ? this : this.derive(next);
  }

  missRerolled(mode: MissRerollMode, context?: RowContext, eps: number = 0): PMF {
    return PMF._wrapShared(this._handle.missRerolled(mode, contextOpt(context), eps));
  }

  withCheck(fn: (check: Check) => Check): AttackBuilder {
    return this.derive(
      this._handle.withCheck((current: NativeCheck): NativeCheck => {
        const { roll, missReroll, ...rest } = current;
        // The facade `RollBuilder` is the value of the source `Check.roll` type (the types come from `src/`).
        const facadeRoll = wrapRoll(roll) as unknown as Check["roll"];
        const next = fn({
          ...rest,
          roll: facadeRoll,
          advantageDice: rest.advantageDice as 2 | 3,
          ...(missReroll == null ? {} : { missReroll }),
        });
        return { ...next, roll: wrapHandle(next.roll) };
      })
    );
  }

  ranged(): AttackBuilder {
    return this.derive(this._handle.ranged());
  }

  melee(): AttackBuilder {
    return this.derive(this._handle.melee());
  }

  pinned(): AttackBuilder {
    return this.derive(this._handle.pinned());
  }

  /** What this attack declares to a turn ({@link ContextualSource}). */
  get rowCheck(): RowCheck {
    return (this.cache().rowCheck ??= this._handle.rowCheck() as RowCheck);
  }

  under(context: RowContext, eps: number = 0): PMF {
    // As the TS: a context that changes nothing is this attack, whose `toPMF` is one PMF per `eps`.
    return this.rollUnder(context).toPMF(eps);
  }

  rollUnder(context: RowContext): AttackBuilder {
    const next = this._handle.rollUnder(contextIn(context));
    return next == null ? this : this.derive(next);
  }

  sample(rng: Rng, context?: RowContext): AttackSample {
    return this._handle.sample(...dice(rng), contextOpt(context)) as AttackSample;
  }

  sampleMissReroll(first: AttackSample, mode: MissRerollMode, rng: Rng, context?: RowContext): AttackSample {
    return this._handle.sampleMissReroll(first, mode, ...dice(rng), contextOpt(context)) as AttackSample;
  }

  samplePayload(outcome: "hit" | "crit", rng: Rng, context?: RowContext, natural20 = false): AttackPayloadSample {
    return this._handle.samplePayload(outcome, ...dice(rng), contextOpt(context), natural20) as AttackPayloadSample;
  }

  onEveryHit(grants: Lasting | readonly Lasting[] | SaveGated, gate?: ConditionGate): AttackBuilder {
    return this.attach("every-hit", grants, gate);
  }

  onAnyCrit(grants: Lasting | readonly Lasting[] | SaveGated, gate?: ConditionGate): AttackBuilder {
    return this.attach("any-crit", grants, gate);
  }

  onFirstCrit(grants: Lasting | readonly Lasting[] | SaveGated, gate?: ConditionGate): AttackBuilder {
    return this.attach("first-crit", grants, gate);
  }

  /**
   * The shared implementation of the attachment verbs. The `grants` array and the gate (its `onSave`
   * array included) are caller-owned and mutable, so they are copied: the returned builder must not
   * change if the caller mutates them. A `save()` value is unpacked into grants and gate.
   */
  private attach(
    on: AttachedCondition["on"],
    grants: Lasting | readonly Lasting[] | SaveGated,
    gate?: ConditionGate
  ): AttackBuilder {
    if (isSaveGated(grants)) {
      const unpacked = unpackSave(grants, gate ?? {});
      return this.attach(on, unpacked.effects, unpacked.options);
    }
    const kept: AttachedCondition = {
      on,
      grants: Array.isArray(grants) ? [...grants] : (grants as Lasting),
      gate:
        gate === undefined
          ? undefined
          : { ...gate, onSave: Array.isArray(gate.onSave) ? [...gate.onSave] : gate.onSave },
    };
    const verb = on === "every-hit" ? "onEveryHit" : on === "any-crit" ? "onAnyCrit" : "onFirstCrit";
    return this.derive(this._handle[verb](grantsToNative(grants), gateToNative(gate)), { attached: [...this.attached, kept] });
  }

  toExpression(): string {
    return this._handle.toExpression() as string;
  }

  resolveProbabilities(
    check: CheckRoll,
    eps: number = 0
  ): { pSuccess: number; pHit: number; pCrit: number; pMiss: number } {
    return native.NativeAttack.resolveProbabilities(check._handle, eps) as {
      pSuccess: number;
      pHit: number;
      pCrit: number;
      pMiss: number;
    };
  }

  /** Resolves the attack into its weighted slices. `eps` defaults to 0, as for {@link toPMF}. */
  resolve(eps: number = 0): AttackResolution {
    const r = this._handle.resolve(eps) as Record<
      "pmf" | "check" | "hit" | "crit" | "miss" | "hitBase" | "critBase" | "hitSeparate" | "critSeparate",
      unknown
    > & { weights: AttackResolution["weights"]; noChannels: boolean };
    // Without channels `hit` is `hitBase`, the same PMF: a turn tells "no channels" by that identity.
    const hitBase = PMF._wrap(r.hitBase);
    const critBase = PMF._wrap(r.critBase);
    return {
      pmf: PMF._wrap(r.pmf),
      check: PMF._wrap(r.check),
      hit: r.noChannels ? hitBase : PMF._wrap(r.hit),
      crit: r.noChannels ? critBase : PMF._wrap(r.crit),
      miss: PMF._wrap(r.miss),
      weights: { hit: r.weights.hit, crit: r.weights.crit, miss: r.weights.miss },
      hitBase,
      critBase,
      hitSeparate: PMF._wrap(r.hitSeparate),
      critSeparate: PMF._wrap(r.critSeparate),
    };
  }

  diceMatchInfo(eps: number = EPS): { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } {
    const r = this._handle.diceMatchInfo(eps) as { hit?: NativeMatchInfo | null; crit?: NativeMatchInfo | null };
    return { hit: matchInfoOut(r.hit), crit: matchInfoOut(r.crit) };
  }

  diceMatchRefusals(): { hit: string | null; crit: string | null } {
    const r = this._handle.diceMatchRefusals() as { hit?: string | null; crit?: string | null };
    return { hit: r.hit ?? null, crit: r.crit ?? null };
  }

  toPMF(eps: number = 0): PMF {
    const cache = (this.cache().pmfs ??= new Map<number, PMF>());
    let pmf = cache.get(eps);
    if (pmf === undefined) {
      pmf = PMF._wrapShared(this._handle.toPmf(eps));
      cache.set(eps, pmf);
    }
    return pmf;
  }

  get pmf() {
    return this.toPMF();
  }

  /** Expected damage of the attack (its DPR when it is the round's only attack), from the exact PMF. */
  mean(): number {
    return this._handle.mean() as number;
  }

  toQuery(eps: number = 0) {
    return this.toPMF(eps).query();
  }
}

/** A turn rolls no rider's dice into this row (`Rider.joins`): `under` ignores `context.joined`. */
Object.defineProperty(AttackBuilder.prototype, IGNORES_JOINED, { value: true });

/** The native handle of a facade roll typed as the source `RollBuilder`. */
function wrapHandle(roll: Check["roll"]): NativeRollHandle {
  return (roll as unknown as RollBuilder)._handle;
}

function optRoll(handle: NativeRollHandle | null | undefined): ActionEffect | undefined {
  return handle == null ? undefined : wrapRoll(handle);
}

function matchInfoOut(info: NativeMatchInfo | null | undefined): DiceMatchInfo | null {
  if (info == null) return null;
  return {
    matchProbabilityByDamage: new Map(info.damages.map((d, i) => [d, info.probabilities[i]] as const)),
  };
}

/** One `...args` element of `RollBuilder.fromArgs` / `onCrit` / `onMiss` as the native side takes it. */
function argIn(arg: unknown): unknown {
  return arg instanceof RollBuilder ? arg._handle : arg;
}

export type { AttackRange };
