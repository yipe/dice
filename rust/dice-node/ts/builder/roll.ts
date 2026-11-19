import type { Rng } from "../../../../src/common/rng";
import type { CritConfig } from "../../../../src/common/types";
import type { ExpressionNode } from "../../../../src/builder/nodes";
import type { CheckDice, RollSample } from "../../../../src/builder/sample";
import type { Ability, AbilityName, AttackRange, MissRerollMode, RollConfig, RollType } from "../../../../src/builder/types";
import type { Lasting } from "../../../../src/turn/effects";
import type { RowContext } from "../../../../src/turn/types";
import { native, type NativeRollHandle } from "../native";
import { PMF } from "../pmf/pmf";
import { AttackBuilder } from "./attack";
import { AmbiguousKeepError, ParsedCheckError } from "./errors";
import { SaveBuilder } from "./save";

/**
 * Facade over the Rust `NativeRoll` (rust/dice-node/src/roll.rs, roll_check.rs). Every TS subclass of
 * `RollBuilder` is a facade subclass over a native handle whose `kind()` names it; each method is
 * one native call, and the Rust builder decides what a given kind refuses. The classes live in one
 * module (as `ACBuilder` and `DCBuilder` do through `ac.ts` and `dc.ts` re-exports) so their
 * `extends` chain never depends on module order.
 */

export { AmbiguousKeepError, ParsedCheckError };

export const defaultConfig: RollConfig = {
  count: 1,
  sides: 0,
  modifier: 0,
  reroll: 0,
  explode: 0,
  explodePoolBudget: 0,
  minimum: 0,
  bestOf: 0,
  keep: undefined,
  rollType: "flat",
};

/** Options of {@link RollBuilder.rerollUpTo} and `AttackBuilder.rerollDamageUpTo`. */
export interface RerollUpToOptions {
  /** Roll the dice this many times and keep the roll that is worth most. Default 1. */
  rolls?: number;
}

/** Options of {@link RollBuilder.rerollUpTo}: {@link RerollUpToOptions} and the dice rolled once. */
export interface RollRerollUpToOptions extends RerollUpToOptions {
  rolledOnce?: RollBuilder;
}

/** Empties the plain-roll, single-die and d20-lift PMF caches. */
export function clearRollCache(): void {
  native.clearCache("roll");
  native.clearCache("singleDie");
  native.clearCache("d20Lift");
}

/** Index of the config holding a check's natural roll, or -1 when no config can be one. */
export function naturalRollIndex(configs: readonly RollConfig[]): number {
  let best = -1;
  for (let i = 0; i < configs.length; i++) {
    const { sides, count, isSubtraction } = configs[i];
    if (!(sides > 0) || !(count > 0) || isSubtraction) continue;
    if (best === -1) {
      best = i;
      continue;
    }
    const top = configs[best].sides;
    if (top !== 20 && (sides === 20 || sides > top)) best = i;
  }
  return best;
}

type Handle = NativeRollHandle;

/** The facade class of each native `kind()`; filled in below the class declarations. */
const classOfKind: Record<string, { prototype: object }> = {};

function wrap(handle: Handle): RollBuilder {
  const proto = (classOfKind[handle.kind()] ?? RollBuilder).prototype;
  const roll = Object.create(proto) as RollBuilder;
  roll._handle = handle;
  return roll;
}

/** @internal Wraps a native roll handle as the facade subclass its kind names. */
export function wrapRoll(handle: Handle): RollBuilder {
  return wrap(handle);
}

function configIn(configs: readonly RollConfig[]): unknown[] {
  return configs.map((c) => ({ ...c }));
}

/** Fluent builder for dice. Holds a native roll; see the module comment. */
export class RollBuilder {
  /** @internal the native handle. */
  _handle!: Handle;

  constructor(countOrConfigs: number | readonly RollConfig[] | Handle = 1) {
    if (typeof countOrConfigs === "number") {
      this._handle = native.NativeRoll.fromCount(countOrConfigs);
    } else if (countOrConfigs instanceof native.NativeRoll) {
      this._handle = countOrConfigs;
    } else {
      this._handle = native.NativeRoll.fromFullConfigs(configIn(countOrConfigs as readonly RollConfig[]));
    }
  }

  hasHiddenState(): boolean {
    return this._handle.hasHiddenState();
  }

  getSubRollConfigs(): readonly RollConfig[] {
    return this._handle.getSubRollConfigs() as RollConfig[];
  }

  /** A string that fully identifies this builder's PMF, or null when hidden state is not captured. */
  cacheKey(): string | null {
    return this._handle.cacheKey() ?? null;
  }

  static fromConfig(config: Partial<RollConfig>): RollBuilder {
    return wrap(native.NativeRoll.fromConfig({ ...config }));
  }

  static fromConfigs(configs: Partial<RollConfig>[]): RollBuilder {
    return wrap(native.NativeRoll.fromConfigs(configs.map((c) => ({ ...c }))));
  }

  static fromArgs(...args: unknown[]): RollBuilder {
    return wrap(native.NativeRoll.fromArgs(args.map(argIn)));
  }

  protected static repeated(die: RollBuilder, count: number): RollBuilder {
    return wrap(native.NativeRoll.repeated(die._handle, count));
  }

  d(sides: number | undefined): RollBuilder {
    return wrap(this._handle.d(sides));
  }

  d4(): RollBuilder {
    return this.d(4);
  }

  d6(): RollBuilder {
    return this.d(6);
  }

  d8(): RollBuilder {
    return this.d(8);
  }

  d10(): RollBuilder {
    return this.d(10);
  }

  d12(): RollBuilder {
    return this.d(12);
  }

  d20(): RollBuilder {
    return this.d(20);
  }

  d100(): RollBuilder {
    return this.d(100);
  }


  plus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
  plus(count: number, die: RollBuilder): RollBuilder;
  plus(modOrRoll: number | RollBuilder | undefined, die?: RollBuilder): RollBuilder {
    if (die instanceof RollBuilder && typeof modOrRoll === "number") {
      return wrap(this._handle.plusDice(modOrRoll, die._handle));
    }
    if (die !== undefined) throw new Error("Invalid arguments to plus()");
    if (modOrRoll === undefined) return this;
    if (typeof modOrRoll === "number") return wrap(this._handle.plus(modOrRoll));
    return wrap(this._handle.plusRoll(modOrRoll._handle));
  }

  minus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
  minus(count: number, die: RollBuilder): RollBuilder;
  minus(modOrRoll: number | RollBuilder | undefined, die?: RollBuilder): RollBuilder {
    if (die instanceof RollBuilder && typeof modOrRoll === "number") {
      return wrap(this._handle.minusDice(modOrRoll, die._handle));
    }
    if (die !== undefined) throw new Error("Invalid arguments to minus()");
    if (modOrRoll === undefined) return this;
    if (typeof modOrRoll === "number") return wrap(this._handle.minus(modOrRoll));
    return wrap(this._handle.minusRoll(modOrRoll._handle));
  }

  reroll(value: number): RollBuilder {
    return wrap(this._handle.reroll(value));
  }

  explode(count: number): RollBuilder {
    if (count === undefined) {
      throw new Error("explode() needs an explicit cap: explode(k) lets each die add at most k extra dice.");
    }
    return wrap(this._handle.explode(count));
  }

  explodePool(budget: number): RollBuilder {
    return wrap(this._handle.explodePool(budget));
  }

  minimum(val: number | undefined): RollBuilder {
    if (val === undefined) return this;
    return wrap(this._handle.minimum(val));
  }

  bestOf(count: number | undefined): RollBuilder {
    if (count === undefined) return this;
    return wrap(this._handle.bestOf(count));
  }

  keepHighest(total: number, count: number): RollBuilder {
    return wrap(this._handle.keepHighest(total, count));
  }

  keepLowest(total: number, count: number): RollBuilder {
    return wrap(this._handle.keepLowest(total, count));
  }

  keepHighestAll(total: number, count: number): PooledRollBuilder {
    return wrap(this._handle.keepHighestAll(total, count)) as PooledRollBuilder;
  }

  keepLowestAll(total: number, count: number): PooledRollBuilder {
    return wrap(this._handle.keepLowestAll(total, count)) as PooledRollBuilder;
  }

  withAdvantage(): RollBuilder {
    return wrap(this._handle.withAdvantage());
  }

  withDisadvantage(): RollBuilder {
    return wrap(this._handle.withDisadvantage());
  }

  withElvenAccuracy() {
    return wrap(this._handle.withElvenAccuracy());
  }

  add(anotherRoll: RollBuilder | undefined): RollBuilder {
    if (anotherRoll === undefined) return this;
    return wrap(this._handle.add(anotherRoll._handle));
  }

  withBonus(anotherRoll: RollBuilder): RollBuilder {
    return wrap(this._handle.withBonus(anotherRoll._handle));
  }

  addRoll(count: number = 1): RollBuilder {
    return wrap(this._handle.addRoll(count));
  }

  scaleDice(scale: number): RollBuilder {
    return wrap(this._handle.scaleDice(scale));
  }

  doubleDice(): RollBuilder {
    return wrap(this._handle.doubleDice());
  }

  alwaysHits() {
    return wrap(this._handle.alwaysHits()) as AlwaysHitBuilder;
  }

  alwaysCrits() {
    return wrap(this._handle.alwaysCrits()) as AlwaysCritBuilder;
  }

  pinned(): RollBuilder {
    return wrap(this._handle.pinned());
  }

  copy(): RollBuilder {
    return wrap(this._handle.copy());
  }

  toExpression(): string {
    return this._handle.toExpression();
  }

  /** The distribution of this roll. */
  toPMF(eps: number = 0): PMF {
    return PMF._wrapShared(this._handle.toPmf(eps));
  }

  get pmf() {
    return this.toPMF();
  }

  toQuery(eps: number = 0) {
    return this.toPMF(eps).query();
  }

  sample(rng: Rng): RollSample {
    return this._handle.sample((n: number) => rng.die(n), (p: number) => rng.chance(p));
  }

  toAST(): ExpressionNode {
    return JSON.parse(this._handle.toAstJson()) as ExpressionNode;
  }

  getRootDieConfig(): RollConfig | undefined {
    return (this._handle.getRootDieConfig() ?? undefined) as RollConfig | undefined;
  }

  getAllDieConfigs(): readonly RollConfig[] {
    return this._handle.getAllDieConfigs() as RollConfig[];
  }

  getBonusDiceConfigs(): RollConfig[] {
    return this._handle.getBonusDiceConfigs() as RollConfig[];
  }

  getBonusDicePMFs(check: RollBuilder, eps: number = 0): PMF[] {
    return (this._handle.getBonusDicePmfs(check._handle, eps) as Handle[]).map((h) => PMF._wrap(h));
  }

  get modifier(): number {
    return this._handle.modifier();
  }

  get rollType(): RollType {
    return this._handle.rollType() as RollType;
  }

  get baseReroll(): number {
    return this._handle.baseReroll();
  }

  half(): HalfRollBuilder {
    return wrap(this._handle.half()) as HalfRollBuilder;
  }

  scaleResult(numerator: number, denominator: number = 1, rounding: "floor" | "round" | "ceil" = "floor"): ScaleRollBuilder {
    return wrap(this._handle.scaleResult(numerator, denominator, rounding)) as ScaleRollBuilder;
  }

  maxOf(count: number): MaxOfRollBuilder;
  maxOf(other: RollBuilder): RollBuilder;
  maxOf(countOrOther: number | RollBuilder): RollBuilder {
    if (typeof countOrOther === "number") return wrap(this._handle.maxOf(countOrOther));
    return wrap(this._handle.maxOfRoll(countOrOther._handle));
  }

  rerollUpTo(budget: number, options?: RollRerollUpToOptions): RerollUpToRollBuilder {
    return wrap(
      this._handle.rerollUpTo(budget, options?.rolls, options?.rolledOnce?._handle)
    ) as RerollUpToRollBuilder;
  }

  ac(targetAC: number): ACBuilder {
    return wrap(this._handle.ac(targetAC)) as ACBuilder;
  }

  dc(saveDC: number): DCBuilder {
    return wrap(this._handle.dc(saveDC)) as DCBuilder;
  }
}

/** One `...args` element of `fromArgs` / `onHit`: a RollBuilder crosses as its handle. */
function argIn(arg: unknown): unknown {
  return arg instanceof RollBuilder ? arg._handle : arg;
}

abstract class TransformedRollBuilder extends RollBuilder {}

export class HalfRollBuilder extends TransformedRollBuilder {
  constructor(inner: RollBuilder | Handle) {
    super(inner instanceof RollBuilder ? inner.half()._handle : inner);
  }

  override copy(): HalfRollBuilder {
    return wrap(this._handle.copy()) as HalfRollBuilder;
  }
}

export class ScaleRollBuilder extends TransformedRollBuilder {
  constructor(
    inner: RollBuilder | Handle,
    numerator?: number,
    denominator: number = 1,
    rounding: "floor" | "round" | "ceil" = "floor"
  ) {
    super(inner instanceof RollBuilder ? inner.scaleResult(numerator as number, denominator, rounding)._handle : inner);
  }

  override copy(): ScaleRollBuilder {
    return wrap(this._handle.copy()) as ScaleRollBuilder;
  }
}

export class MaxOfRollBuilder extends TransformedRollBuilder {
  constructor(inner: RollBuilder | Handle, count?: number) {
    super(inner instanceof RollBuilder ? inner.maxOf(count as number)._handle : inner);
  }

  override copy(): MaxOfRollBuilder {
    return wrap(this._handle.copy()) as MaxOfRollBuilder;
  }
}

export class RerollUpToRollBuilder extends TransformedRollBuilder {
  constructor(inner: RollBuilder | Handle, budget?: number, options?: RollRerollUpToOptions) {
    super(inner instanceof RollBuilder ? inner.rerollUpTo(budget as number, options)._handle : inner);
  }

  override copy(): RerollUpToRollBuilder {
    return wrap(this._handle.copy()) as RerollUpToRollBuilder;
  }
}

class CompositeSumRollBuilder extends TransformedRollBuilder {}

class MaxOfRollsBuilder extends TransformedRollBuilder {}

/** Sum of independent rolls, each keeping its own transform (see `src/builder/roll.ts`). */
export function sumRolls(parts: readonly RollBuilder[]): RollBuilder {
  if (parts.length === 1) return parts[0];
  return wrap(native.NativeRoll.sumRolls(parts.map((p) => p._handle)));
}

type AttackConfigOf = CritConfig & { range?: AttackRange };

/** The attack config of an always-hit, always-crit or AC check, as the TS `attackConfig` field. */
function attackConfigOf(handle: Handle, withDice: boolean): Record<string, unknown> {
  const c = handle.attackConfig() as { critThreshold: number; ac?: number; range?: AttackRange; missReroll?: MissRerollMode };
  return withDice ? { ...c, advantageDice: handle.advantageDice() } : c;
}

abstract class CheckRollBuilder extends RollBuilder {
  onHit(val: number): AttackBuilder;
  onHit(val: string): AttackBuilder;
  onHit(val: RollBuilder): AttackBuilder;
  onHit(count: number, die: RollBuilder): AttackBuilder;
  onHit(count: number, sides: number): AttackBuilder;
  onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onHit(count: number, sides: number, modifier: number): AttackBuilder;
  onHit(...args: unknown[]): AttackBuilder {
    return AttackBuilder._wrap(this._handle.onHit(args.map(argIn)));
  }

  get critThreshold(): number {
    return this._handle.critThreshold() as number;
  }

  sampleCheck(rng: Rng): CheckDice {
    return this._handle.sampleCheck((n: number) => rng.die(n), (p: number) => rng.chance(p));
  }
}

export class AlwaysHitBuilder extends CheckRollBuilder {
  constructor(baseRoll: RollBuilder | Handle, attackConfig?: AttackConfigOf) {
    super(
      baseRoll instanceof RollBuilder
        ? native.NativeRoll.alwaysHitWith(baseRoll._handle, { critThreshold: 20, ...attackConfig })
        : baseRoll
    );
  }

  get attackConfig(): AttackConfigOf {
    return attackConfigOf(this._handle, false) as AttackConfigOf;
  }

  critOn(critThreshold: number): AlwaysHitBuilder {
    return wrap(this._handle.critOn(critThreshold)) as AlwaysHitBuilder;
  }

  override alwaysCrits(): AlwaysCritBuilder {
    return wrap(this._handle.alwaysCrits()) as AlwaysCritBuilder;
  }

  ranged(): AlwaysHitBuilder {
    return wrap(this._handle.ranged()) as AlwaysHitBuilder;
  }

  melee(): AlwaysHitBuilder {
    return wrap(this._handle.melee()) as AlwaysHitBuilder;
  }

  override pinned(): AlwaysHitBuilder {
    return wrap(this._handle.pinned()) as AlwaysHitBuilder;
  }

  override copy(): AlwaysHitBuilder {
    return wrap(this._handle.copy()) as AlwaysHitBuilder;
  }
}

export class AlwaysCritBuilder extends CheckRollBuilder {
  constructor(
    baseRoll: RollBuilder | Handle,
    attackConfig?: CritConfig & { ac?: number; range?: AttackRange; missReroll?: MissRerollMode },
    fromAlwaysHit: boolean = false
  ) {
    super(
      baseRoll instanceof RollBuilder
        ? native.NativeRoll.alwaysCritWith(baseRoll._handle, { critThreshold: 20, ...attackConfig }, fromAlwaysHit)
        : baseRoll
    );
  }

  get attackConfig(): CritConfig & { ac?: number; range?: AttackRange; missReroll?: MissRerollMode } {
    return attackConfigOf(this._handle, false) as CritConfig & { ac?: number; range?: AttackRange; missReroll?: MissRerollMode };
  }

  get fromAlwaysHit(): boolean {
    return this._handle.fromAlwaysHit() as boolean;
  }

  critOn(critThreshold: number): AlwaysCritBuilder {
    return wrap(this._handle.critOn(critThreshold)) as AlwaysCritBuilder;
  }

  ranged(): AlwaysCritBuilder {
    return wrap(this._handle.ranged()) as AlwaysCritBuilder;
  }

  melee(): AlwaysCritBuilder {
    return wrap(this._handle.melee()) as AlwaysCritBuilder;
  }

  override pinned(): AlwaysCritBuilder {
    return wrap(this._handle.pinned()) as AlwaysCritBuilder;
  }

  override copy(): AlwaysCritBuilder {
    return wrap(this._handle.copy()) as AlwaysCritBuilder;
  }
}

/** A roll parsed from a string: it carries only its PMF. */
export class ParsedRollBuilder extends RollBuilder {
  constructor(expression: string | Handle) {
    super(typeof expression === "string" ? native.NativeRoll.parsed(expression) : expression);
  }

  canDoubleDice(): boolean {
    return this._handle.canDoubleDice();
  }

  override doubleDice(): ParsedRollBuilder {
    return wrap(this._handle.doubleDice()) as ParsedRollBuilder;
  }

  override scaleDice(scale: number): ParsedRollBuilder {
    return wrap(this._handle.scaleDice(scale)) as ParsedRollBuilder;
  }

  override copy(): ParsedRollBuilder {
    return wrap(this._handle.copy()) as ParsedRollBuilder;
  }
}

/** A pool of dice kept as one (`keepHighestAll`, `times`). Construct with those methods. */
export class PooledRollBuilder extends RollBuilder {
  times(count: number): PooledRollBuilder {
    return wrap(this._handle.times(count)) as PooledRollBuilder;
  }

  override scaleDice(scale: number): PooledRollBuilder {
    return wrap(this._handle.scaleDice(scale)) as PooledRollBuilder;
  }

  override copy(): PooledRollBuilder {
    return wrap(this._handle.copy()) as PooledRollBuilder;
  }
}

/** `ACBuilder.attackConfig`. */
export interface AcAttackConfig {
  ac: number;
  critThreshold: number;
  advantageDice: 2 | 3;
  range?: AttackRange;
  missReroll?: MissRerollMode;
}

/** An attack check: `d20.plus(5).ac(15)`. */
export class ACBuilder extends CheckRollBuilder {
  constructor(baseRoll: RollBuilder | Handle, ac?: number, attackConfig?: Record<string, unknown>) {
    super(baseRoll instanceof RollBuilder ? ACBuilder.build(baseRoll, ac as number, attackConfig) : baseRoll);
  }

  private static build(base: RollBuilder, ac: number, attackConfig?: Record<string, unknown>): Handle {
    let check = base._handle.ac(ac);
    if (attackConfig?.range === "ranged") check = check.ranged();
    else if (attackConfig?.range === "melee") check = check.melee();
    if (attackConfig?.critThreshold !== undefined && attackConfig.critThreshold !== 20) {
      check = check.critOn(attackConfig.critThreshold as number);
    }
    if (attackConfig?.advantageDice === 3) check = check.threeDiceAdvantage();
    if (attackConfig?.missReroll !== undefined) check = check.rerollMisses(attackConfig.missReroll as string);
    return check;
  }

  get attackConfig(): AcAttackConfig {
    return attackConfigOf(this._handle, true) as unknown as AcAttackConfig;
  }

  threeDiceAdvantage(): ACBuilder {
    return wrap(this._handle.threeDiceAdvantage()) as ACBuilder;
  }

  ranged(): ACBuilder {
    return wrap(this._handle.ranged()) as ACBuilder;
  }

  melee(): ACBuilder {
    return wrap(this._handle.melee()) as ACBuilder;
  }

  override pinned(): ACBuilder {
    return wrap(this._handle.pinned()) as ACBuilder;
  }

  rerollMisses(mode: MissRerollMode = "add-d20"): ACBuilder {
    return wrap(this._handle.rerollMisses(mode)) as ACBuilder;
  }

  critOn(threshold: number): ACBuilder {
    return wrap(this._handle.critOn(threshold)) as ACBuilder;
  }

  override alwaysHits(): AlwaysHitBuilder {
    return wrap(this._handle.alwaysHits()) as AlwaysHitBuilder;
  }

  override alwaysCrits(): AlwaysCritBuilder {
    return wrap(this._handle.alwaysCrits()) as AlwaysCritBuilder;
  }

  override copy(ac?: number): ACBuilder {
    return wrap(this._handle.copyWithAc(ac)) as ACBuilder;
  }
}

/** A save check: `d20.plus(5).dc(15)`. */
export class DCBuilder extends RollBuilder {
  constructor(baseRoll: RollBuilder | Handle, saveConfig?: { dc: number; ability?: Ability; autoFail?: true }) {
    super(baseRoll instanceof RollBuilder ? DCBuilder.build(baseRoll, saveConfig) : baseRoll);
  }

  private static build(base: RollBuilder, saveConfig?: { dc: number; ability?: Ability; autoFail?: true }): Handle {
    let check = base._handle.dc(saveConfig ? saveConfig.dc : 10);
    if (saveConfig?.ability) check = check.ability(saveConfig.ability);
    if (saveConfig?.autoFail) check = check.alwaysFails();
    return check;
  }

  override dc(saveDC: number): DCBuilder {
    return wrap(this._handle.dc(saveDC)) as DCBuilder;
  }

  get saveDC(): number {
    return this._handle.saveDc() as number;
  }

  get saveAbility(): Ability | undefined {
    return (this._handle.saveAbility() ?? undefined) as Ability | undefined;
  }

  get autoFail(): boolean {
    return this._handle.autoFail();
  }

  ability(name: AbilityName): DCBuilder {
    return wrap(this._handle.ability(name)) as DCBuilder;
  }

  alwaysFails(): DCBuilder {
    return wrap(this._handle.alwaysFails()) as DCBuilder;
  }

  override pinned(): DCBuilder {
    return wrap(this._handle.pinned()) as DCBuilder;
  }

  get isPlainSave(): boolean {
    return this._handle.isPlainSave();
  }

  rolledIn(context: Pick<RowContext, "rollType" | "autoFail" | "penaltyDice">): DCBuilder {
    return wrap(
      this._handle.rolledIn(context.rollType, context.autoFail, context.penaltyDice.map((p) => ({ ...p })))
    ) as DCBuilder;
  }

  inContext(context: RowContext): DCBuilder {
    const moved = this._handle.inContext({ ...context, penaltyDice: context.penaltyDice.map((p) => ({ ...p })), joined: [...context.joined] });
    return moved === null || moved === undefined ? this : (wrap(moved) as DCBuilder);
  }

  override add(anotherRoll: RollBuilder): DCBuilder {
    return wrap(this._handle.add(anotherRoll._handle)) as DCBuilder;
  }

  override addRoll(count?: number): DCBuilder {
    return wrap(this._handle.addRoll(count ?? 1)) as DCBuilder;
  }

  onSaveFailure(val: number): SaveBuilder;
  onSaveFailure(val: string): SaveBuilder;
  onSaveFailure(val: RollBuilder): SaveBuilder;
  onSaveFailure(count: number, die: RollBuilder): SaveBuilder;
  onSaveFailure(count: number, sides: number): SaveBuilder;
  onSaveFailure(count: number, die: RollBuilder, modifier: number): SaveBuilder;
  onSaveFailure(count: number, sides: number, modifier: number): SaveBuilder;
  onSaveFailure(effects: Lasting | readonly (RollBuilder | Lasting)[]): SaveBuilder;
  onSaveFailure(...args: unknown[]): SaveBuilder {
    return SaveBuilder._fromDcFailure(this, args);
  }

  override withElvenAccuracy(): never {
    // The Rust builder refuses (an Elven Accuracy save has no meaning); its message is the TS one.
    this._handle.withElvenAccuracy();
    throw new Error("unreachable: a save cannot roll with Elven Accuracy");
  }

  saveProbabilities(): { pSuccess: number; pFail: number } {
    return this._handle.saveProbabilities() as { pSuccess: number; pFail: number };
  }

  sampleCheck(rng: Rng, context?: RowContext) {
    return this._handle.sampleDcCheck(
      (n: number) => rng.die(n),
      (p: number) => rng.chance(p),
      context === undefined ? undefined : { ...context, penaltyDice: context.penaltyDice.map((p) => ({ ...p })), joined: [...context.joined] }
    );
  }
}

Object.assign(classOfKind, {
  plain: RollBuilder,
  half: HalfRollBuilder,
  scale: ScaleRollBuilder,
  maxOf: MaxOfRollBuilder,
  rerollUpTo: RerollUpToRollBuilder,
  alwaysHit: AlwaysHitBuilder,
  alwaysCrit: AlwaysCritBuilder,
  parsed: ParsedRollBuilder,
  pooled: PooledRollBuilder,
  compositeSum: CompositeSumRollBuilder,
  maxOfRolls: MaxOfRollsBuilder,
  ac: ACBuilder,
  dc: DCBuilder,
});
