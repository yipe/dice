import type { ACBuilder } from "./ac";
import type { CritConfig } from "../common/types";
import type { DCBuilder } from "./dc";
import { LRUCache } from "../common/lru-cache";
import { parse } from "../parser/parser";
import { AmbiguousCritDoublingError, scaleParsedDice, UndoubleableExpressionError } from "../parser/scaleDice";
import type { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { astFromRollConfigs, pmfFromRollBuilder, resolveRootD20 } from "./ast";
import { configTerms, joinTerms, nodeRange, printScale, rootDieExpression, type ExpressionTerm } from "./expression";
import { AttackBuilder } from "./attack";
import type { ExpressionNode, KeepNode, SumNode } from "./nodes";
import type { RollConfig, RollType } from "./types";

/** Validates a `scaleDice`/`doubleDice` multiplier: must be a positive integer. Shared by
 * `RollBuilder.scaleDice` and every subclass's override (Half/Scale/MaxOf/Composite/Parsed/Pooled). */
function validateScaleInt(scale: number): number {
  const scaleInt = Math.floor(scale);
  if (scaleInt !== scale) throw new Error("Scale must be an integer");
  if (scaleInt <= 0) throw new Error("Scale must be > 0");
  return scaleInt;
}

/**
 * Why scaling `config`'s dice by `scale` has no single meaning, or `undefined` when it has one.
 * `astFromRollConfigs` reads a per-die keep through the die count, so multiplying that count only
 * means "double the dice" for keep-highest-of-1 ("roll it N times, keep the best", which then
 * doubles its dice inside each trial). Any other keep, a `bestOf()` that is (or becomes) a keep, and
 * a die rolled with advantage/disadvantage/elven accuracy (whose count the AST ignores) do not.
 */
function ambiguousScaling(config: RollConfig, scale: number): string | undefined {
  const die = `d${config.sides}`;
  if (config.rollType !== "flat") {
    return `a ${die} rolled with ${config.rollType} ignores its dice count, so a doubled crit would equal the hit`;
  }
  if (config.keep) {
    const { total, count, mode } = config.keep;
    if (count === 1 && mode === "highest") return undefined;
    return (
      `the per-die keep \`${total}${mode === "highest" ? "kh" : "kl"}${count}\` of ${die} has no single doubled meaning ` +
      `(only keep-highest-of-1, "roll it N times, keep the best", doubles its dice inside each trial)`
    );
  }
  const dice = Math.abs(config.count);
  if (config.bestOf > 0 && config.bestOf < dice * scale) {
    return `bestOf(${config.bestOf}) on ${dice}${die} keeps individual dice from the scaled pool, which has no single doubled meaning`;
  }
  return undefined;
}

/**
 * Plain-roll PMF cache, the sibling of {@link attackPMFCache}. `toPMF()` re-runs the whole AST convolution
 * every call, and a DPR sweep rebuilds the SAME damage roll thousands of times — a Paladin's smite damage,
 * a Wizard's Fireball. Keyed by {@link RollBuilder.cacheKey} plus `eps`; a `null` key (half/scale/max/parsed/
 * pooled/composite, whose PMF is not captured by `subRollConfigs`) resolves uncached, because a conservative
 * miss is always safe and a wrong key would corrupt DPR.
 *
 * Subclasses that override `toPMF` (Half/Scale/MaxOf/Composite) never reach this — and all of them return a
 * `null` key anyway, so they are uncacheable by the same rule either way.
 */
const rollPMFCache = new LRUCache<string, PMF>(4000);

/** Clears the plain-roll PMF cache (test/bench seam; mirrors {@link clearAttackCache}). */
export function clearRollCache(): void {
  rollPMFCache.clear();
}

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

// Fluent builder for dice to create PMFs with an AST
export class RollBuilder {
  protected readonly subRollConfigs: readonly RollConfig[];

  constructor(countOrConfigs: number | readonly RollConfig[] = 1) {
    if (typeof countOrConfigs === "number") {
      const count = countOrConfigs;
      if (isNaN(count)) throw new Error("Invalid NaN value for count");
      this.subRollConfigs = [
        { ...defaultConfig, count, isSubtraction: count < 0 },
      ];
    } else {
      this.subRollConfigs = countOrConfigs.map((c) => ({ ...c }));
    }
  }

  protected create(configs: readonly RollConfig[]): RollBuilder {
    return new RollBuilder(configs);
  }

  protected get lastConfig() {
    return this.subRollConfigs[this.subRollConfigs.length - 1];
  }

  hasHiddenState(): boolean {
    return false;
  }

  getSubRollConfigs(): readonly RollConfig[] {
    return this.subRollConfigs.map((c: RollConfig) => ({ ...c }));
  }

  /**
   * A cheap, stable string that FULLY identifies this builder's PMF — used by {@link AttackBuilder.toPMF}
   * to cache resolved attack PMFs across rebuilds without walking the AST via {@link toExpression}. A plain
   * roll is fully determined by its {@link RollConfig} array (count/sides/modifier/reroll/explode/minimum/
   * bestOf/keep/rollType/isSubtraction), so serializing that is sound. Subclasses whose PMF depends on
   * hidden state NOT captured by `subRollConfigs` (half/scale/max/parsed/pooled/composite transforms) return
   * `null` to opt OUT of caching — a conservative miss is always safe; a wrong key would corrupt DPR.
   */
  cacheKey(): string | null {
    return JSON.stringify(this.subRollConfigs);
  }

  // for testing
  static fromConfig(config: Partial<RollConfig>): RollBuilder {
    return new RollBuilder([{ ...defaultConfig, ...config }]);
  }

  static fromConfigs(configs: Partial<RollConfig>[]): RollBuilder {
    return new RollBuilder(
      configs.map((config) => ({ ...defaultConfig, ...config }))
    );
  }

  static fromArgs(...args: any[]): RollBuilder {
    if (args.length === 1) {
      const arg = args[0];
      if (typeof arg === "number") {
        if (isNaN(arg)) throw new Error("Invalid NaN value for argument");
        return new RollBuilder(0).plus(arg);
      }
      if (typeof arg === "string") {
        return new ParsedRollBuilder(arg);
      }
      if (arg instanceof RollBuilder) {
        return arg;
      }
    }

    if (args.length === 2 || args.length === 3) {
      const [count, sidesOrDie, modifier] = args;

      if (typeof count !== "number") {
        throw new Error("First argument must be a number for multi-arg call");
      }
      if (isNaN(count)) throw new Error("Invalid NaN value for count argument");

      if (sidesOrDie instanceof RollBuilder) {
        if (sidesOrDie.hasHiddenState()) {
          throw new Error(
            "Cannot use a roll with hidden state (like a pooled roll) as a die type."
          );
        }
        const subRollConfigs = sidesOrDie.getSubRollConfigs();
        if (subRollConfigs.length === 0) {
          const result = new RollBuilder(0);
          return modifier !== undefined ? result.plus(modifier) : result;
        }

        const absCount = Math.abs(count);

        const newConfigs = subRollConfigs.map((config) => ({
          ...config,
          count: config.count * absCount,
          modifier: config.modifier * absCount,
        }));

        let resultBuilder = new RollBuilder(newConfigs);

        if (count < 0) {
          const negatedConfigs = resultBuilder
            .getSubRollConfigs()
            .map((c) => ({ ...c, isSubtraction: !c.isSubtraction }));
          resultBuilder = new RollBuilder(negatedConfigs);
        }

        return modifier !== undefined
          ? resultBuilder.plus(modifier)
          : resultBuilder;
      } else if (typeof sidesOrDie === "number" || sidesOrDie === undefined) {
        if (typeof sidesOrDie === "number" && isNaN(sidesOrDie))
          throw new Error("Invalid NaN value for sides argument");
        let builder = new RollBuilder(count);
        if (sidesOrDie && sidesOrDie > 0) {
          builder = builder.d(sidesOrDie);
        }
        return modifier !== undefined ? builder.plus(modifier) : builder;
      }
    }

    throw new Error(`Invalid arguments passed: ${args.join(", ")}`);
  }

  // --- Core Dice Methods ---
  d(sides: number | undefined): RollBuilder {
    if (sides !== undefined && isNaN(sides))
      throw new Error("Invalid NaN value for sides");
    if (sides === undefined) return this;
    if (this.lastConfig.sides && this.lastConfig.sides > 0) {
      throw new Error("Cannot add a die after adding a die");
    }
    if (sides === 0) return this;
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].sides = sides;
    return this.create(newConfigs);
  }

  plus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
  plus(count: number, die: RollBuilder): RollBuilder;
  plus(
    modOrRoll: number | RollBuilder | undefined,
    die?: RollBuilder
  ): RollBuilder {
    if (typeof modOrRoll === "number" && isNaN(modOrRoll))
      throw new Error("Invalid NaN value for modOrRoll");
    if (die instanceof RollBuilder && typeof modOrRoll === "number") {
      if (die.hasHiddenState()) {
        throw new Error(
          "Cannot use a roll with hidden state (like a pooled roll) as a die type."
        );
      }
      const count = modOrRoll;
      const subRollConfigs = die.getSubRollConfigs();
      if (subRollConfigs.length === 0) return this;

      const absCount = Math.abs(count);

      const newConfigs = subRollConfigs.map((config) => ({
        ...config,
        count: config.count * absCount,
        modifier: config.modifier * absCount,
      }));

      let rollToAdd = new RollBuilder(newConfigs);

      if (count < 0) {
        const negatedConfigs = rollToAdd
          .getSubRollConfigs()
          .map((c) => ({ ...c, isSubtraction: !c.isSubtraction }));
        rollToAdd = new RollBuilder(negatedConfigs);
      }
      return this.add(rollToAdd);
    }

    if (die !== undefined) {
      throw new Error("Invalid arguments to plus()");
    }

    if (modOrRoll === undefined) return this;
    if (typeof modOrRoll === "number") {
      if (modOrRoll === 0) return this;
      const newConfigs = this.getSubRollConfigs();
      newConfigs[newConfigs.length - 1].modifier += modOrRoll;
      return this.create(newConfigs);
    }
    return this.add(modOrRoll as RollBuilder);
  }

  minus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
  minus(count: number, die: RollBuilder): RollBuilder;
  minus(
    modOrRoll: number | RollBuilder | undefined,
    die?: RollBuilder
  ): RollBuilder {
    const isNumber = typeof modOrRoll === "number";
    const dieIsRoll = die instanceof RollBuilder;
    if (dieIsRoll && isNumber) return this.plus(-modOrRoll, die);

    if (die !== undefined) throw new Error("Invalid arguments to minus()");
    if (modOrRoll === undefined) return this;

    return isNumber
      ? this.plus(-modOrRoll)
      : this.plus(-1, modOrRoll as RollBuilder);
  }

  /** Apply one-pass reroll threshold (k): reroll faces 1..k once, must keep. */
  reroll(value: number): RollBuilder {
    if (isNaN(value)) throw new Error("Invalid NaN value for reroll");
    if (value === this.lastConfig.reroll) return this;

    const newConfigs = this.getSubRollConfigs();

    newConfigs[newConfigs.length - 1].reroll = value;
    return this.create(newConfigs);
  }

  /** Set finite explode count for max-face explosions (Infinity allowed). */
  explode(count: number | undefined = Infinity): RollBuilder {
    if (count !== undefined && isNaN(count))
      throw new Error("Invalid NaN value for explode count");
    if (count === undefined) return this;
    if (count === 0) return this;
    if (count < 0) throw new Error("Explode count must be >= 0");
    if (this.lastConfig.explodePoolBudget > 0) {
      throw new Error(
        "Cannot set explode() on a config that already has a pool-wide explodePool() budget — the two exploding-dice semantics (per-die vs pool-wide) are mutually exclusive on one config."
      );
    }

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].explode = count;
    return this.create(newConfigs);
  }

  /**
   * Set a pool-wide exploding-dice budget: at most `budget` extra dice may be added across the
   * WHOLE pool (shared), as opposed to {@link explode}'s per-die cap (`n` dice each individually
   * allowed up to `explode(k)` extra dice). `budget` must be a finite non-negative integer —
   * unlike `explode()`, `Infinity` is not accepted (it would make the pool-wide DP non-terminating).
   */
  explodePool(budget: number): RollBuilder {
    if (isNaN(budget)) throw new Error("Invalid NaN value for explodePool budget");
    if (!Number.isFinite(budget)) throw new Error("explodePool budget must be finite");
    if (budget < 0) throw new Error("explodePool budget must be >= 0");
    if (budget === 0) return this;
    if (this.lastConfig.explode > 0) {
      throw new Error(
        "Cannot set explodePool() on a config that already has a per-die explode() cap — the two exploding-dice semantics (per-die vs pool-wide) are mutually exclusive on one config."
      );
    }

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].explodePoolBudget = Math.floor(budget);
    return this.create(newConfigs);
  }

  /** Apply per-die minimum value (floors each die roll at `val`, e.g. `minimum(3)` treats a 1 or
   * 2 as a 3 -- the 2024 Great Weapon Fighting style). */
  minimum(val: number | undefined): RollBuilder {
    if (val !== undefined && isNaN(val))
      throw new Error("Invalid NaN value for minimum");
    if (val === undefined) return this;
    if (val === 0) return this;
    if (val < 0) throw new Error("Minimum value must be >= 0");

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].minimum = val;
    return this.create(newConfigs);
  }

  bestOf(count: number | undefined): RollBuilder {
    if (count !== undefined && isNaN(count))
      throw new Error("Invalid NaN value for bestOf count");
    if (count === undefined) return this;
    if (count <= 0) throw new Error("Best of count must be > 0");

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].bestOf = count;
    return this.create(newConfigs);
  }

  keepHighest(total: number, count: number): RollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighest");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].keep = { total, count, mode: "highest" };
    return this.create(newConfigs);
  }

  keepLowest(total: number, count: number): RollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepLowest");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].keep = { total, count, mode: "lowest" };
    return this.create(newConfigs);
  }

  keepHighestAll(total: number, count: number): PooledRollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighestAll");
    const currentAST = this.toAST();
    // Wrap in SumNode to represent trials, then KeepNode
    const trialPool: SumNode = {
      type: "sum",
      count: total,
      child: currentAST,
    };
    const keepNode: KeepNode = {
      type: "keep",
      mode: "highest",
      count,
      child: trialPool,
    };
    return new PooledRollBuilder(
      keepNode,
      () => (Math.floor(total) <= 0 || count <= 0 ? "0" : `${total}kh${count}(${this.toExpression()})`),
      [],
      (scale) => this.scaleDice(scale).keepHighestAll(total, count)
    );
  }

  keepLowestAll(total: number, count: number): PooledRollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepLowestAll");
    const currentAST = this.toAST();
    const trialPool: SumNode = {
      type: "sum",
      count: total,
      child: currentAST,
    };
    const keepNode: KeepNode = {
      type: "keep",
      mode: "lowest",
      count,
      child: trialPool,
    };
    return new PooledRollBuilder(
      keepNode,
      () => (Math.floor(total) <= 0 || count <= 0 ? "0" : `${total}kl${count}(${this.toExpression()})`),
      [],
      (scale) => this.scaleDice(scale).keepLowestAll(total, count)
    );
  }

  withAdvantage(): RollBuilder {
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].rollType = "advantage";
    return this.create(newConfigs);
  }

  withDisadvantage(): RollBuilder {
    const configs = this.getSubRollConfigs();
    configs[configs.length - 1].rollType = "disadvantage";
    return this.create(configs);
  }

  add(anotherRoll: RollBuilder | undefined): RollBuilder {
    if (anotherRoll === undefined) return this;
    if (anotherRoll.hasHiddenState()) {
      throw new Error(
        "Cannot add a roll with hidden state (like a pooled roll) to a standard roll. Try adding the standard roll to the pooled roll instead: pool.plus(roll)."
      );
    }
    const configs = [...this.subRollConfigs, ...anotherRoll.subRollConfigs];
    return this.create(configs);
  }

  withBonus(anotherRoll: RollBuilder): RollBuilder {
    const configs = [...this.subRollConfigs, ...anotherRoll.subRollConfigs];
    return this.create(configs);
  }

  addRoll(count: number = 1): RollBuilder {
    if (isNaN(count)) throw new Error("Invalid NaN value for count");
    const configs = [
      ...this.subRollConfigs,
      {
        ...defaultConfig,
        count,
        isSubtraction: count < 0,
      },
    ];
    return this.create(configs);
  }

  /**
   * Multiplies every die group's count by `scale` (crit doubling); flats stay. Throws an
   * {@link AmbiguousCritDoublingError} for a group whose scaled meaning is ambiguous (see
   * {@link ambiguousScaling}): the caller must give the crit explicitly.
   */
  scaleDice(scale: number): RollBuilder {
    const scaleInt = validateScaleInt(scale);

    const newConfigs = this.getSubRollConfigs().map((config) => {
      if (!config.sides || config.sides <= 0) return config;
      const ambiguity = ambiguousScaling(config, scaleInt);
      if (ambiguity !== undefined) {
        throw new AmbiguousCritDoublingError(
          `Cannot double the dice of "${this.toExpression()}" on a crit: ${ambiguity}. ` +
            `Give the crit explicitly: onCrit(...) on an attack, critDamage on a rider, or noCrit().`
        );
      }
      return { ...config, count: config.count * scaleInt };
    });
    return this.create(newConfigs);
  }

  doubleDice(): RollBuilder {
    return this.scaleDice(2);
  }

  alwaysHits() {
    return new AlwaysHitBuilder(this);
  }

  alwaysCrits() {
    return new AlwaysCritBuilder(this);
  }

  copy(): RollBuilder {
    return this.create(this.getSubRollConfigs());
  }

  // --- Dice Shortcut Methods ---
  d4 = () => this.d(4);
  d6 = () => this.d(6);
  d8 = () => this.d(8);
  d10 = () => this.d(10);
  d12 = () => this.d(12);
  d20 = () => this.d(20);
  d100 = () => this.d(100);

  withElvenAccuracy() {
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].rollType = "elven accuracy";
    return this.create(newConfigs);
  }

  toExpression(): string {
    return joinTerms(configTerms(this.subRollConfigs, this.getRootDieConfig()));
  }

  // Main AST entry point. Cached by the cheap config key across identical rebuilds; see `rollPMFCache`.
  toPMF(eps: number = 0): PMF {
    const key = this.cacheKey();
    if (key === null) return pmfFromRollBuilder(this, eps);
    const fullKey = `${key}*e${eps}`;
    const cached = rollPMFCache.get(fullKey);
    if (cached) return cached;
    const pmf = pmfFromRollBuilder(this, eps);
    rollPMFCache.set(fullKey, pmf);
    return pmf;
  }

  get pmf() {
    return this.toPMF();
  }

  toQuery(eps: number = 0): DiceQuery {
    return this.toPMF(eps).query();
  }

  toAST(): ExpressionNode {
    const configs = this.getSubRollConfigs();
    return (
      astFromRollConfigs(configs) ||
      ({ type: "constant", value: 0 } as ExpressionNode)
    );
  }

  getRootDieConfig(): RollConfig | undefined {
    const configs = this.subRollConfigs;
    return configs.find((config) => config.sides > 0) || configs[0];
  }

  getAllDieConfigs(): readonly RollConfig[] {
    return this.getSubRollConfigs();
  }

  /**
   * The check's dice other than its root die (Bless, Bane, Guidance), each WITHOUT its flat
   * modifier. `.plus(n)` stores `n` on whichever group came last, so `d20.plus(d4).plus(5)` holds
   * the 5 on the d4 group; every check resolver already adds all flats once via {@link modifier},
   * so a bonus group that kept its own would count it twice and make the check order-dependent.
   */
  getBonusDiceConfigs(): RollConfig[] {
    const allConfigs = this.subRollConfigs;
    const rootConfig =
      allConfigs.find((config) => config.sides > 0) || allConfigs[0];
    if (!rootConfig) return [];
    return allConfigs
      .filter((config) => config.sides > 0 && config !== rootConfig)
      .map((config) => ({ ...config, modifier: 0 }));
  }

  getBonusDicePMFs(check: RollBuilder, eps: number = 0): PMF[] {
    return check
      .getBonusDiceConfigs()
      .map((config) =>
        pmfFromRollBuilder(RollBuilder.fromConfigs([config]), eps)
      );
  }

  get modifier(): number {
    return this.subRollConfigs.reduce(
      (sum, config) => sum + config.modifier,
      0
    );
  }

  get rollType(): RollType {
    const rootConfig = this.getRootDieConfig();
    return rootConfig?.rollType || "flat";
  }

  get baseReroll(): number {
    const rootConfig = this.getRootDieConfig();
    return rootConfig?.reroll || 0;
  }

  half(): HalfRollBuilder {
    return new HalfRollBuilder(this);
  }

  /**
   * Scale this roll's result by `numerator / denominator`, rounding each outcome.
   * A general, composable form of {@link half} — used to model damage-type resistance
   * (`scaleResult(1, 2)` → `(expr) // 2`) and vulnerability (`scaleResult(2)` → `2 * (expr)`).
   * Compose several of these (and plain rolls) into one payload with {@link sumRolls}.
   */
  scaleResult(
    numerator: number,
    denominator: number = 1,
    rounding: "floor" | "round" | "ceil" = "floor"
  ): ScaleRollBuilder {
    return new ScaleRollBuilder(this, numerator, denominator, rounding);
  }

  // Create a "max of N rolls" version of this roll for crit damage with keep operations
  maxOf(count: number): MaxOfRollBuilder {
    return new MaxOfRollBuilder(this, count);
  }

  // These methods are implemented via prototype augmentation in ac.ts and dc.ts
  // They are declared here to provide proper TypeScript types
  ac(_targetAC: number): ACBuilder {
    throw new Error("ac() should be implemented via prototype augmentation");
  }

  dc(_saveDC: number): DCBuilder {
    throw new Error("dc() should be implemented via prototype augmentation");
  }
}

export class HalfRollBuilder extends RollBuilder {
  constructor(private readonly innerRoll: RollBuilder) {
    super(0); // dummy, we override methods
  }

  override hasHiddenState(): boolean {
    return this.innerRoll.hasHiddenState();
  }

  override cacheKey(): string | null {
    return null; // half-of transform not captured by subRollConfigs
  }

  // Inherits `create()` and the `.plus()` family from `RollBuilder`, so chaining one of those on
  // a HalfRollBuilder returns a plain `RollBuilder` rather than a HalfRollBuilder.

  override get lastConfig(): RollConfig {
    // `lastConfig` is protected on the base class; reach it on the wrapped
    // instance via a typed view rather than `any`.
    return (this.innerRoll as unknown as { lastConfig: RollConfig }).lastConfig;
  }

  getSubRollConfigs(): readonly RollConfig[] {
    return this.innerRoll.getSubRollConfigs();
  }

  toExpression(): string {
    const innerExpression = this.innerRoll.toExpression();
    return `(${innerExpression}) // 2`;
  }

  toAST(): ExpressionNode {
    return {
      type: "half",
      child: this.innerRoll.toAST(),
    };
  }

  toPMF(eps: number = 0): PMF {
    return pmfFromRollBuilder(this, eps);
  }

  // Scale the dice, keep the same // 2 (half) transform applied on top -- delegating to the
  // base class's `create()`-based scaleDice would drop the halving entirely, e.g. a doubled-dice
  // crit on a resisted hit payload silently losing the resistance.
  override scaleDice(scale: number): RollBuilder {
    return new HalfRollBuilder(this.innerRoll.scaleDice(scale));
  }

  copy(): HalfRollBuilder {
    return new HalfRollBuilder(this.innerRoll.copy());
  }
}

/**
 * A roll whose result is scaled by `numerator / denominator` and rounded — the composable
 * generalization of {@link HalfRollBuilder}. Renders as `N ** (inner)`, `(inner) // D`, or
 * `(inner) ** N // D`. Terminal (like `half`): use {@link sumRolls} to combine with other rolls.
 */
export class ScaleRollBuilder extends RollBuilder {
  constructor(
    private readonly innerRoll: RollBuilder,
    private readonly numerator: number,
    private readonly denominator: number = 1,
    private readonly rounding: "floor" | "round" | "ceil" = "floor"
  ) {
    super(0); // dummy, we override methods
  }

  override hasHiddenState(): boolean {
    return this.innerRoll.hasHiddenState();
  }

  override cacheKey(): string | null {
    return null; // scale transform not captured by subRollConfigs
  }

  override get lastConfig(): RollConfig {
    return (this.innerRoll as unknown as { lastConfig: RollConfig }).lastConfig;
  }

  getSubRollConfigs(): readonly RollConfig[] {
    return this.innerRoll.getSubRollConfigs();
  }

  toExpression(): string {
    return printScale(this.innerRoll.toExpression(), this.numerator, this.denominator, this.rounding);
  }

  toAST(): ExpressionNode {
    return {
      type: "scale",
      numerator: this.numerator,
      denominator: this.denominator,
      rounding: this.rounding,
      child: this.innerRoll.toAST(),
    };
  }

  toPMF(eps: number = 0): PMF {
    return pmfFromRollBuilder(this, eps);
  }

  // Scale the dice, keep the same numerator/denominator/rounding transform applied on top --
  // delegating to the base class's `create()`-based scaleDice would drop the scale entirely,
  // e.g. a doubled-dice crit on a vulnerable hit payload silently losing the vulnerability.
  override scaleDice(scale: number): RollBuilder {
    return new ScaleRollBuilder(
      this.innerRoll.scaleDice(scale),
      this.numerator,
      this.denominator,
      this.rounding
    );
  }

  copy(): ScaleRollBuilder {
    return new ScaleRollBuilder(
      this.innerRoll.copy(),
      this.numerator,
      this.denominator,
      this.rounding
    );
  }
}

export class MaxOfRollBuilder extends RollBuilder {
  constructor(
    private readonly innerRoll: RollBuilder,
    private readonly count: number,
    private readonly diceCount?: number,
    private readonly diceSides?: number
  ) {
    super(0); // dummy, we override methods
  }

  override hasHiddenState(): boolean {
    return this.innerRoll.hasHiddenState();
  }

  override cacheKey(): string | null {
    return null; // max-of transform not captured by subRollConfigs
  }

  override get lastConfig(): RollConfig {
    // `lastConfig` is protected on the base class; reach it on the wrapped
    // instance via a typed view rather than `any`.
    return (this.innerRoll as unknown as { lastConfig: RollConfig }).lastConfig;
  }

  getSubRollConfigs(): readonly RollConfig[] {
    return this.innerRoll.getSubRollConfigs();
  }

  /** `NkhK(X)` keeps the highest K of N independent copies of X: the max of N rolls is `Nkh1(X)`. */
  toExpression(): string {
    const count = Math.max(1, Math.floor(this.count));
    const inner = this.innerRoll.toExpression();
    return count === 1 ? inner : `${count}kh1(${inner})`;
  }

  toAST(): ExpressionNode {
    // Use the stored dice info if available
    if (this.diceCount && this.diceSides) {
      const sumChild: ExpressionNode = {
        type: "sum",
        count: this.diceCount,
        child: { type: "die", sides: this.diceSides },
      };
      return {
        type: "maxOf",
        count: this.count,
        child: sumChild,
      };
    }

    // Fallback: try to get from innerRoll
    try {
      const configs = this.innerRoll.getSubRollConfigs();
      if (configs.length === 1 && configs[0].sides) {
        const config = configs[0];
        const sumChild: ExpressionNode = {
          type: "sum",
          count: config.count,
          child: { type: "die", sides: config.sides },
        };
        return {
          type: "maxOf",
          count: this.count,
          child: sumChild,
        };
      }
    } catch {
      // Last resort: try parsing the expression (though this shouldn't work with current RollBuilder)
    }

    // Fallback - this shouldn't happen in normal usage
    throw new Error(
      `MaxOfRollBuilder.toAST(): Unsupported innerRoll configuration`
    );
  }

  toPMF(eps: number = 0): PMF {
    return pmfFromRollBuilder(this, eps);
  }

  // Scale the dice INSIDE each trial (e.g. maxOf(2, 1d12) -> maxOf(2, 2d12)), keeping the same
  // trial count -- delegating to the base class's `create()`-based scaleDice would collapse
  // straight to plain dice, losing the "take the highest of N trials" semantics entirely.
  override scaleDice(scale: number): RollBuilder {
    const scaleInt = validateScaleInt(scale);
    return new MaxOfRollBuilder(
      this.innerRoll.scaleDice(scaleInt),
      this.count,
      this.diceCount ? this.diceCount * scaleInt : undefined,
      this.diceSides
    );
  }

  copy(): MaxOfRollBuilder {
    return new MaxOfRollBuilder(this.innerRoll.copy(), this.count);
  }
}

export class AlwaysHitBuilder extends RollBuilder {
  readonly attackConfig: CritConfig;

  constructor(baseRoll: RollBuilder, attackConfig?: CritConfig) {
    if (baseRoll.hasHiddenState()) {
      throw new Error(
        "Cannot create AlwaysHitBuilder from a roll with hidden state."
      );
    }
    super(baseRoll.getSubRollConfigs());

    if (attackConfig) {
      this.attackConfig = { ...attackConfig };
    } else {
      this.attackConfig = { critThreshold: 20 };
    }
  }

  protected create(configs: readonly RollConfig[]): RollBuilder {
    return new RollBuilder(configs);
  }

  onHit(val: number): AttackBuilder;
  onHit(val: string): AttackBuilder;
  onHit(val: RollBuilder): AttackBuilder;
  onHit(count: number, die: RollBuilder): AttackBuilder;
  onHit(count: number, sides: number): AttackBuilder;
  onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onHit(count: number, sides: number, modifier: number): AttackBuilder;
  onHit(...args: any[]): AttackBuilder {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(this, damageRoll);
  }

  get critThreshold(): number {
    return this.attackConfig.critThreshold;
  }

  override cacheKey(): string | null {
    const base = super.cacheKey();
    return base === null ? null : `H|${this.attackConfig.critThreshold}|${base}`;
  }

  /** Sets the crit threshold for this always-hitting check: a natural roll at or above it crits. */
  critOn(critThreshold: number): AlwaysHitBuilder {
    const newConfig = { critThreshold };
    return new AlwaysHitBuilder(this, newConfig);
  }

  alwaysCrits(): AlwaysCritBuilder {
    return new AlwaysCritBuilder(this, undefined, true);
  }

  /** The check's natural roll, which is all this builder's own PMF reads (see {@link toPMF}). */
  override toExpression(): string {
    return rootDieExpression(this) ?? super.toExpression();
  }

  override toPMF(): PMF {
    return resolveRootD20(this);
  }

  override copy(): AlwaysHitBuilder {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const critThreshold = this.critThreshold;
    const newConfig = { critThreshold };
    return new AlwaysHitBuilder(baseCopy, newConfig);
  }
}

export class AlwaysCritBuilder extends RollBuilder {
  readonly attackConfig: CritConfig & { ac?: number };
  readonly fromAlwaysHit: boolean;

  constructor(
    baseRoll: RollBuilder,
    attackConfig?: CritConfig & { ac?: number },
    fromAlwaysHit: boolean = false
  ) {
    if (baseRoll.hasHiddenState()) {
      throw new Error(
        "Cannot create AlwaysCritBuilder from a roll with hidden state."
      );
    }
    super(baseRoll.getSubRollConfigs());

    if (attackConfig) {
      this.attackConfig = { ...attackConfig };
    } else {
      this.attackConfig = { critThreshold: 20 };
    }
    this.fromAlwaysHit = fromAlwaysHit || baseRoll instanceof AlwaysHitBuilder;
  }

  protected create(configs: readonly RollConfig[]): RollBuilder {
    return new RollBuilder(configs);
  }

  onHit(val: number): AttackBuilder;
  onHit(val: string): AttackBuilder;
  onHit(val: RollBuilder): AttackBuilder;
  onHit(count: number, die: RollBuilder): AttackBuilder;
  onHit(count: number, sides: number): AttackBuilder;
  onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onHit(count: number, sides: number, modifier: number): AttackBuilder;
  onHit(...args: any[]): AttackBuilder {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(this, damageRoll);
  }

  get critThreshold(): number {
    return this.attackConfig.critThreshold;
  }

  override cacheKey(): string | null {
    const base = super.cacheKey();
    return base === null ? null : `C|${this.fromAlwaysHit ? 1 : 0}|${this.attackConfig.critThreshold}|${this.attackConfig.ac ?? ""}|${base}`;
  }

  critOn(critThreshold: number): AlwaysCritBuilder {
    const newConfig = { critThreshold, ac: this.attackConfig.ac };
    return new AlwaysCritBuilder(this, newConfig, this.fromAlwaysHit);
  }

  /** The check's natural roll, which is all this builder's own PMF reads (see {@link toPMF}). */
  override toExpression(): string {
    return rootDieExpression(this) ?? super.toExpression();
  }

  override toPMF(): PMF {
    return resolveRootD20(this);
  }

  override copy(): AlwaysCritBuilder {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const critThreshold = this.critThreshold;
    const newConfig = { critThreshold, ac: this.attackConfig.ac };
    return new AlwaysCritBuilder(baseCopy, newConfig, this.fromAlwaysHit);
  }
}

export class ParsedRollBuilder extends RollBuilder {
  private readonly cachedPMF: PMF;
  private readonly originalExpression: string;

  constructor(expression: string) {
    super([]); // Empty configs since we're bypassing the normal builder flow
    this.originalExpression = expression;
    this.cachedPMF = parse(expression, 0);
  }

  override hasHiddenState(): boolean {
    return true;
  }

  override cacheKey(): string | null {
    return null; // parsed expression not captured by subRollConfigs
  }

  protected create(configs: readonly RollConfig[]): RollBuilder {
    return new RollBuilder(configs);
  }

  override toPMF(_eps: number = 0): PMF {
    // The PMF is pre-computed at construction with eps=0; epsilon is not re-applied here.
    return this.cachedPMF;
  }

  override toExpression(): string {
    return this.originalExpression;
  }

  override toAST(): ExpressionNode {
    // Parsed expressions carry no AST; they are terminal damage payloads, so AST conversion is
    // unsupported rather than reconstructed.
    throw new Error(
      "ParsedRollBuilder does not support AST conversion. Use the builder API instead."
    );
  }

  override copy(): ParsedRollBuilder {
    return new ParsedRollBuilder(this.originalExpression);
  }

  /**
   * Whether this is a damage expression whose dice a crit doubles: false for one with an AC/DC
   * check or a crit/save/pc/miss clause, or a dice-valued repeat count (`d4d6`), which a crit adds
   * as-is. True for every other expression, including one whose doubling is ambiguous (a keep other
   * than keep-highest-of-1, a min of two dice terms): that is still damage, and {@link doubleDice}
   * refuses it with an `AmbiguousCritDoublingError` so no crit is approximated. Reads the string
   * only; nothing is parsed into a PMF.
   */
  canDoubleDice(): boolean {
    try {
      scaleParsedDice(this.originalExpression, 2);
      return true;
    } catch (error) {
      if (error instanceof UndoubleableExpressionError) return false;
      if (error instanceof AmbiguousCritDoublingError) return true;
      throw error;
    }
  }

  /**
   * A crit doubles every dice term of the expression; flats and operators stay. Throws when
   * {@link canDoubleDice} is false, and for an ambiguous keep (see {@link canDoubleDice}).
   */
  override doubleDice(): ParsedRollBuilder {
    return this.scaleDice(2);
  }

  override scaleDice(scale: number): ParsedRollBuilder {
    return new ParsedRollBuilder(scaleParsedDice(this.originalExpression, validateScaleInt(scale)));
  }
}

/**
 * Rebuilds a pool from its pre-pool roll with that roll's dice scaled. This is how a pool's dice
 * double on a crit: `roll(2,d6).plus(3).keepHighestAll(2,1)` crits as
 * `roll(4,d6).plus(3).keepHighestAll(2,1)`, never as the whole pool rolled twice.
 */
type RepoolScaled = (scale: number) => PooledRollBuilder;

export class PooledRollBuilder extends RollBuilder {
  constructor(
    private readonly baseAST: ExpressionNode,
    /** Prints the pool itself; called only when the expression is asked for. */
    private readonly baseExpression: () => string,
    configs: readonly RollConfig[] = [],
    private readonly repoolScaled?: RepoolScaled
  ) {
    // Initialize with empty config if none provided
    super(configs.length > 0 ? configs : 0);
  }

  protected create(configs: readonly RollConfig[]): PooledRollBuilder {
    // Preserves the base AST and expression; only the configs change.
    return new PooledRollBuilder(this.baseAST, this.baseExpression, configs, this.repoolScaled);
  }

  override hasHiddenState(): boolean {
    return true;
  }

  override cacheKey(): string | null {
    return null; // pooled keep-highest not captured by subRollConfigs
  }

  override d(_sides: number | undefined): RollBuilder {
    throw new Error("Cannot add dice to a pooled roll. The pool is finalized.");
  }

  override reroll(_value: number): RollBuilder {
    throw new Error("Cannot set reroll on a pooled roll.");
  }

  override explode(_count: number | undefined = Infinity): RollBuilder {
    throw new Error("Cannot set explode on a pooled roll.");
  }

  override explodePool(_budget: number): RollBuilder {
    throw new Error("Cannot set explodePool on a pooled roll.");
  }

  override minimum(_val: number | undefined): RollBuilder {
    throw new Error("Cannot set minimum on a pooled roll.");
  }

  override bestOf(_count: number | undefined): RollBuilder {
    throw new Error("Cannot set bestOf on a pooled roll.");
  }

  override keepHighest(_total: number, _count: number): RollBuilder {
    throw new Error(
      "Cannot use keepHighest on a pooled roll. Use keepHighestAll again if you want nested pooling."
    );
  }

  override keepLowest(_total: number, _count: number): RollBuilder {
    throw new Error(
      "Cannot use keepLowest on a pooled roll. Use keepLowestAll again if you want nested pooling."
    );
  }

  override withAdvantage(): RollBuilder {
    throw new Error("Cannot set advantage on a pooled roll.");
  }

  override withDisadvantage(): RollBuilder {
    throw new Error("Cannot set disadvantage on a pooled roll.");
  }

  override withElvenAccuracy(): RollBuilder {
    throw new Error("Cannot set elven accuracy on a pooled roll.");
  }

  override toAST(): ExpressionNode {
    const configsAST = super.toAST();

    // Check if configsAST is effectively zero/empty
    const isZero = configsAST.type === "constant" && configsAST.value === 0;

    if (isZero) {
      return this.baseAST;
    }

    const children: { node: ExpressionNode; sign: 1 | -1 }[] = [
      { node: this.baseAST, sign: 1 },
      { node: configsAST, sign: 1 },
    ];

    return { type: "add", children };
  }

  override toExpression(): string {
    const base: ExpressionTerm = { text: this.baseExpression(), sign: 1, range: nodeRange(this.baseAST) };
    return joinTerms([base, ...configTerms(this.subRollConfigs, this.getRootDieConfig())]);
  }

  override copy(): PooledRollBuilder {
    return this.create(this.getSubRollConfigs());
  }

  /**
   * Scales the dice inside the pool, then pools — the pool is rebuilt from its own pre-pool roll
   * with that roll's dice scaled, so its trial count and flats never multiply. Dice added after
   * pooling (`pool.plus(roll(1, d4))`) scale too; flat modifiers do not.
   */
  override scaleDice(scale: number): PooledRollBuilder {
    const scaleInt = validateScaleInt(scale);
    if (!this.repoolScaled) {
      throw new Error(
        "This pool has no pre-pool roll to scale its dice inside; build it with keepHighestAll(), keepLowestAll() or times()."
      );
    }
    const repooled = this.repoolScaled(scaleInt);
    const configs = super.scaleDice(scaleInt).getSubRollConfigs();
    return new PooledRollBuilder(repooled.baseAST, repooled.baseExpression, configs, repooled.repoolScaled);
  }

  times(count: number): PooledRollBuilder {
    if (isNaN(count)) throw new Error("Invalid NaN value for times");
    if (Math.floor(count) !== count)
      throw new Error("times() requires an integer");
    if (count < 0) throw new Error("times() requires a non-negative integer");

    // Wraps the current state (base + modifiers) into a new pool repeated N times.
    const sumNode: SumNode = {
      type: "sum",
      count,
      child: this.toAST(),
    };
    const expression = () =>
      count === 0 ? "0" : count === 1 ? this.toExpression() : `${count}(${this.toExpression()})`;

    return new PooledRollBuilder(sumNode, expression, [], (scale) => this.scaleDice(scale).times(count));
  }
}

/**
 * An additive composite of independent rolls that preserves each part's AST — the piece
 * that lets a scaled/halved sub-roll (which the flat `.plus()` merge would otherwise drop)
 * sit beside plain rolls in one damage payload. Its PMF convolves the parts; its expression
 * sums them, each part one term of the sum. Built via {@link sumRolls}; terminal (used as an
 * onHit/onCrit/onSaveFailure payload), so it reports hidden state to reject accidental flat merges.
 */
class CompositeSumRollBuilder extends RollBuilder {
  constructor(private readonly parts: readonly RollBuilder[]) {
    super(0); // dummy, we override methods
  }

  override hasHiddenState(): boolean {
    return true;
  }

  override cacheKey(): string | null {
    return null; // composite sum not captured by subRollConfigs
  }

  override getSubRollConfigs(): readonly RollConfig[] {
    return [];
  }

  override toAST(): ExpressionNode {
    return {
      type: "add",
      children: this.parts.map((p) => ({
        node: p.toAST(),
        sign: 1 as const,
      })),
    };
  }

  override toExpression(): string {
    return joinTerms(
      this.parts.map((part) => {
        let range: [number, number] | undefined;
        try {
          range = nodeRange(part.toAST());
        } catch {
          // A parsed part has no AST: its range is unknown, so the next part always adds (`~+`).
        }
        return { text: part.toExpression(), sign: 1, range };
      })
    );
  }

  override toPMF(eps: number = 0): PMF {
    return pmfFromRollBuilder(this, eps);
  }

  // Scaling a composite (mixed damage types, e.g. base + resisted) must scale each PART's own
  // dice while preserving its own half/scale wrapper -- delegating to the base class's
  // `create()`-based scaleDice would lose every part's transform, collapsing straight to plain
  // dice. This is what auto-crit doubling (attack.ts's `hitEffect.copy().doubleDice()`) relies
  // on for a mixed-resistance hit payload.
  override scaleDice(scale: number): RollBuilder {
    validateScaleInt(scale);
    return new CompositeSumRollBuilder(
      this.parts.map((p) => p.scaleDice(scale))
    );
  }

  override copy(): CompositeSumRollBuilder {
    return new CompositeSumRollBuilder(this.parts.map((p) => p.copy()));
  }
}

/**
 * Combine several rolls into one additive payload whose PMF is their convolution and whose
 * expression is their sum. Unlike `a.plus(b)`, this preserves parts that carry
 * hidden state (e.g. `roll.scaleResult(1, 2)` / `roll.half()`), so per-damage-type resistance
 * and vulnerability survive into both the distribution and the rendered expression.
 * Empty parts collapse to `0`; a single part is returned unwrapped.
 */
export function sumRolls(parts: readonly RollBuilder[]): RollBuilder {
  const meaningful = parts.filter((p): p is RollBuilder => p !== undefined);
  if (meaningful.length === 0) return new RollBuilder(0);
  if (meaningful.length === 1) return meaningful[0];
  return new CompositeSumRollBuilder(meaningful);
}
