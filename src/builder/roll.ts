import type { ACBuilder } from "./ac";
import type { CritConfig } from "../common/types";
import type { DCBuilder } from "./dc";
import { LRUCache } from "../common/lru-cache";
import { parse } from "../parser/parser";
import { AmbiguousCritDoublingError, scaleParsedDice, UndoubleableExpressionError } from "../parser/scaleDice";
import type { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { astFromRollConfigs, pmfFromRollBuilder, resolveRootD20 } from "./ast";
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

const rollConfigsEqual = (a: RollConfig, b: RollConfig) => {
  return (
    a.count === b.count &&
    a.sides === b.sides &&
    a.modifier === b.modifier &&
    a.reroll === b.reroll &&
    a.explode === b.explode &&
    a.explodePoolBudget === b.explodePoolBudget &&
    a.minimum === b.minimum &&
    a.bestOf === b.bestOf &&
    a.keep === b.keep &&
    a.rollType === b.rollType
  );
};

const configComplexityScore = (config: RollConfig) => {
  return (
    (config.reroll > 0 ? 1 : 0) +
    (config.explode > 0 ? 1 : 0) +
    (config.explodePoolBudget > 0 ? 1 : 0) +
    (config.minimum > 0 ? 1 : 0) +
    (config.bestOf > 0 ? 1 : 0) +
    (config.keep !== undefined ? 1 : 0) +
    (config.rollType !== "flat" ? 1 : 0)
  );
};

/**
 * Index of the config holding a check's natural roll — the die whose 1 misses and whose 20 hits and
 * crits — or -1 when no config can be one. Only a rolled, added die can: a subtracted or zero-count
 * group never is. A d20 outranks every other die (a d30 or d100 beside it is a bonus die); with no
 * d20 the largest die does, and the first of equal dice wins. The same rule the string parser uses
 * to pick a check's natural roll, so `d4.plus(d20)` and `(1d4 + d20 AC n)` agree.
 */
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
    const currentExpr = this.toExpression();
    const expression = `${total}kh${count}(${currentExpr})`;
    return new PooledRollBuilder(keepNode, expression, [], (scale) =>
      this.scaleDice(scale).keepHighestAll(total, count)
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
    const currentExpr = this.toExpression();
    const expression = `${total}kl${count}(${currentExpr})`;
    return new PooledRollBuilder(keepNode, expression, [], (scale) =>
      this.scaleDice(scale).keepLowestAll(total, count)
    );
  }

  withAdvantage(): RollBuilder {
    return this.withRollType("advantage");
  }

  withDisadvantage(): RollBuilder {
    return this.withRollType("disadvantage");
  }

  /**
   * Sets a roll type. On a roll with a natural d20 (a check: see {@link naturalRollIndex}) it
   * applies to that d20 whatever the call order, so `d20.plus(d4).withAdvantage()` advantages the
   * d20, not the Bless die. Otherwise it applies to the last group.
   */
  private withRollType(rollType: RollType): RollBuilder {
    const configs = this.getSubRollConfigs();
    const rootIdx = naturalRollIndex(configs);
    const idx = rootIdx !== -1 && configs[rootIdx].sides === 20 ? rootIdx : configs.length - 1;
    configs[idx].rollType = rollType;
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
    return this.withRollType("elven accuracy");
  }

  toExpression(): string {
    const originalDiceConfigs = this.subRollConfigs.filter(
      (config) => config.sides && config.sides > 0
    );

    type Group = { config: RollConfig; totalCount: number };
    const configGroups = new Map<string, Group>();

    for (const config of originalDiceConfigs) {
      const keyConfig: Partial<RollConfig> = { ...config };
      delete keyConfig.count;
      delete keyConfig.modifier;
      const key = JSON.stringify(keyConfig);

      const existingGroup = configGroups.get(key);
      if (existingGroup) {
        existingGroup.totalCount += config.count;
      } else {
        configGroups.set(key, { config, totalCount: config.count });
      }
    }

    const rootConfig = this.getRootDieConfig();
    const groupedConfigs = Array.from(configGroups.values());
    let rootD20Group: Group | undefined;

    if (rootConfig && rootConfig.sides === 20) {
      const rootIndex = groupedConfigs.findIndex(
        ({ config }) =>
          rollConfigsEqual(config, rootConfig) &&
          JSON.stringify(config.keep) === JSON.stringify(rootConfig.keep)
      );

      if (rootIndex !== -1) {
        rootD20Group = groupedConfigs.splice(rootIndex, 1)[0];
      }
    }

    const sortedDiceConfigs = groupedConfigs
      .map(({ config, totalCount }) => ({
        ...config,
        count: totalCount,
      }))
      .sort((a, b) => {
        const aHasPriority = a.reroll > 0 || a.minimum > 0;
        const bHasPriority = b.reroll > 0 || b.minimum > 0;
        if (aHasPriority !== bHasPriority) return aHasPriority ? -1 : 1;
        if (b.sides !== a.sides) return b.sides - a.sides;
        return configComplexityScore(b) - configComplexityScore(a);
      });

    const diceConfigs = rootD20Group
      ? [
          { ...rootD20Group.config, count: rootD20Group.totalCount },
          ...sortedDiceConfigs,
        ]
      : sortedDiceConfigs;

    const totalModifier = this.subRollConfigs.reduce(
      (sum, config) => sum + config.modifier,
      0
    );
    if (diceConfigs.length === 0) return totalModifier.toString();

    const rootDieConfig = this.getRootDieConfig();
    const newRootConfig = rootDieConfig
      ? diceConfigs.find((c) => rollConfigsEqual(c, rootDieConfig))
      : undefined;

    // Generate dice expressions without individual modifiers
    const diceExpressions = diceConfigs.map((config) =>
      this.configToSingleExpressionWithoutModifier(
        config,
        config === newRootConfig
      )
    );

    // Join dice expressions with appropriate operators based on their count
    let result = "";
    for (let i = 0; i < diceExpressions.length; i++) {
      const config = diceConfigs[i];
      const expression = diceExpressions[i];

      if (i === 0) {
        result = (config.isSubtraction ? "-" : "") + expression;

        // Add constants right after the root d20 die (if it's a d20)
        if (config.sides === 20 && totalModifier !== 0) {
          if (totalModifier > 0) result += ` + ${totalModifier}`;
          else result += ` - ${Math.abs(totalModifier)}`;
        }
      } else {
        // Use minus sign for negative subtraction, plus sign otherwise
        const operator = config.isSubtraction ? " - " : " + ";
        result += operator + expression;
      }
    }

    // If constants weren't added after d20, add them at the end
    if (diceConfigs.length === 0 || diceConfigs[0].sides !== 20) {
      if (totalModifier > 0) result += ` + ${totalModifier}`;
      else if (totalModifier < 0) result += ` - ${Math.abs(totalModifier)}`;
    }

    return result.replace(/\+ -/g, "-");
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

  private configToSingleExpressionWithoutModifier(
    config: RollConfig,
    isRootDie: boolean
  ): string {
    if (!config.sides || config.sides <= 0) return "";

    // The string grammar has no explode token at all (see parser.ts/dice.ts) -- there is no
    // representable syntax that round-trips an exploding die's distribution. Silently rendering
    // a plain (non-exploding) die here would re-parse to a materially different, WRONG
    // distribution with no indication anything was lost. Fail loudly instead.
    if (config.explode && Number.isFinite(config.explode) && config.explode > 0) {
      throw new Error(
        `toExpression() cannot represent an exploding die (d${config.sides} explode(${config.explode})): the string grammar has no explode syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().`
      );
    }
    if (config.explodePoolBudget && config.explodePoolBudget > 0) {
      throw new Error(
        `toExpression() cannot represent a pool-wide exploding-dice budget (d${config.sides} explodePool(${config.explodePoolBudget})): the string grammar has no explode syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().`
      );
    }

    let baseDie = `d${config.sides}`;

    // A reroll(k) config means "reroll faces 1..k once, must keep" (see resolveSingleDie) — a
    // THRESHOLD, not a literal face value. The parser's `reroll <n>` for a bare number n rerolls
    // ONLY face value n (matches k=1, where the threshold and the literal face coincide); for
    // k>=2 the threshold must be expressed as `reroll d{k}`, using a k-sided die's face SET
    // {1..k} as the reroll operator's argument — chaining `reroll 1 reroll 2 ... reroll k` as
    // separate clauses re-parses as k SEQUENTIAL reroll passes, a different (and wrong)
    // distribution. `rerollClause` is shared by every placement below (with/without minimum,
    // with/without explode) since the clause's own content never depends on where it sits.
    const rerollClause = config.reroll > 0 ? (config.reroll === 1 ? " reroll 1" : ` reroll d${config.reroll}`) : "";

    if (config.reroll > 0) {
      if (config.minimum > 0 && config.explode > 0) {
        // Complex single roll case: minimum + explode + reroll
        // Apply reroll after minimum is applied
      } else {
        baseDie += rerollClause;
      }
    }

    if (config.minimum > 0) {
      if (config.reroll > 0 && !config.explode) {
        baseDie = `${config.minimum}>(${baseDie})`;
      } else {
        baseDie = `${config.minimum}>${baseDie}`;
      }
      if (config.reroll > 0 && config.explode > 0) {
        baseDie += rerollClause;
      }
    }

    // Check for hd20 shorthand AFTER adding explode
    if (baseDie === "d20 reroll 1" && config.minimum <= 1) baseDie = "hd20";

    let mainExpression = "";
    switch (config.rollType) {
      case "advantage":
        mainExpression = `${baseDie} > ${baseDie}`;
        break;
      case "disadvantage":
        mainExpression = `${baseDie} < ${baseDie}`;
        break;
      case "elven accuracy":
        mainExpression = `${baseDie} > ${baseDie} > ${baseDie}`;
        break;
      case "flat":
        if (config.keep) {
          const mode = config.keep.mode === "highest" ? "kh" : "kl";

          // The inner expression must match astFromRollConfigs' own per-trial shape (see
          // resolve()'s "keep" case, which reads it back out as `node.child.child`), not just
          // echo `config.count`. astFromRollConfigs collapses to "N individual dice, keep top K"
          // (a bare per-trial die) exactly when the die count equals the trial count (`baseCount
          // === trials`) -- UNLESS it's the kh1 case (count 1, highest), which always keeps its
          // per-trial die multiplied by baseCount even when baseCount happens to equal trials
          // (`3kh1` on 3d6-per-trial means "max of three 3d6 sums", not "max of 3 individual
          // d6"). Getting this wrong previously serialized `roll(4,d6).keepHighest(4,3)` as
          // `4kh3(4d6)` ("keep 3 of four 4d6 sums") instead of the correct `4kh3(1d6)` ("keep 3
          // of four individual d6 rolls") -- a ~3.7x overstatement on re-parse.
          const baseCount = Math.max(1, Math.floor(Math.abs(config.count || 1)));
          const trials = Math.max(1, Math.floor(config.keep.total));
          const isMaxOfShape = config.keep.count === 1 && config.keep.mode === "highest";
          const innerCount = trials === baseCount && !isMaxOfShape ? 1 : baseCount;

          const baseDieExpression =
            this.configToSingleExpressionWithoutModifier(
              {
                ...config,
                count: innerCount,
                modifier: 0,
                rollType: "flat",
                keep: undefined,
              },
              false
            );
          mainExpression = `${config.keep.total}${mode}${config.keep.count}(${baseDieExpression})`;
        } else {
          const isComplex = baseDie.length > `d${config.sides}`.length;
          const isHalflingShorthand = baseDie === "hd20";
          const isD20Shorthand = baseDie === "d20" && isRootDie;
          const hasMinimum = config.minimum > 0;
          const hasReroll = config.reroll > 0;
          // For negative subtraction, use absolute value for display
          // For negative counts from factory function, treat as 1 (legacy behavior)
          const effectiveCount = config.isSubtraction
            ? Math.abs(config.count)
            : config.count < 0
            ? 1
            : Math.abs(config.count);

          if (effectiveCount > 1) {
            const shouldAddParentheses = isComplex;
            mainExpression = shouldAddParentheses
              ? `${effectiveCount}(${baseDie})`
              : `${effectiveCount}${baseDie}`;
          } else if (effectiveCount === 1) {
            const needsParens = hasReroll && hasMinimum;
            if (config.isSubtraction) {
              mainExpression = needsParens ? `1(${baseDie})` : `1${baseDie}`;
            } else if (
              isComplex ||
              isHalflingShorthand ||
              isD20Shorthand ||
              config.count < 0
            ) {
              mainExpression = needsParens ? `1(${baseDie})` : baseDie;
            } else {
              mainExpression = needsParens ? `1(${baseDie})` : `1${baseDie}`;
            }
          } else {
            mainExpression = baseDie;
          }
        }
        if (config.bestOf && config.count && config.bestOf < config.count) {
          const pool = Math.max(1, Math.floor(Math.abs(config.count)));
          const baseDieExpression = this.configToSingleExpressionWithoutModifier(
            {
              ...config,
              count: 1,
              modifier: 0,
              bestOf: 0,
              keep: undefined,
              rollType: "flat",
            },
            false
          );
          mainExpression = `${pool}kh${Math.floor(config.bestOf)}(${baseDieExpression})`;
        }
        break;
    }

    return mainExpression;
  }

  /**
   * The config carrying this roll's natural die — see {@link naturalRollIndex} — or, with no
   * such die, the first config (so `rollType`/`baseReroll` still read a flat roll's own fields).
   */
  getRootDieConfig(): RollConfig | undefined {
    const configs = this.subRollConfigs;
    const idx = naturalRollIndex(configs);
    return idx === -1 ? configs[0] : configs[idx];
  }

  getAllDieConfigs(): readonly RollConfig[] {
    return this.getSubRollConfigs();
  }

  /**
   * The check's dice other than its natural die (Bless, Bane, Guidance), each WITHOUT its flat
   * modifier. `.plus(n)` stores `n` on whichever group came last, so `d20.plus(d4).plus(5)` holds
   * the 5 on the d4 group; every check resolver already adds all flats once via {@link modifier},
   * so a bonus group that kept its own would count it twice and make the check order-dependent.
   * A check with no natural die has every die as a bonus die.
   */
  getBonusDiceConfigs(): RollConfig[] {
    const allConfigs = this.subRollConfigs;
    const rootIdx = naturalRollIndex(allConfigs);
    return allConfigs
      .filter((config, i) => config.sides > 0 && i !== rootIdx)
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
 * generalization of {@link HalfRollBuilder}. Renders as `N * (inner)`, `(inner) // D`, or
 * `(inner) * N // D`. Terminal (like `half`): use {@link sumRolls} to combine with other rolls.
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
    const inner = this.innerRoll.toExpression();
    const denominator = this.denominator === 0 ? 1 : this.denominator;
    if (denominator === 1) return `${this.numerator} ** (${inner})`;
    // The grammar has only floor (`//`) and ceil (`/`) division; there is no round-half token.
    if (this.rounding === "round") {
      throw new Error(
        `toExpression() cannot represent scaleResult(${this.numerator}, ${this.denominator}, "round"): the string grammar has only floor (//) and ceil (/) division. Use the builder's own PMF (.toPMF()/.pmf) instead.`
      );
    }
    const div = this.rounding === "ceil" ? "/" : "//";
    // `*` in this grammar is `conditionalApply` (an attack-gate operator: "if the left side is
    // nonzero, take the right side"), NOT multiplication -- `**` is. A scale of e.g. `2/1`
    // (vulnerability) previously rendered as `2 * (inner)`, which re-parsed as "if 2 (always
    // nonzero) then take `inner`", silently dropping the multiplier entirely on round-trip.
    if (this.numerator === 1) return `(${inner}) ${div} ${denominator}`;
    return `(${inner}) ** ${this.numerator} ${div} ${denominator}`;
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

  toExpression(): string {
    // Use the stored dice info to create the expression directly
    if (this.diceCount && this.diceSides) {
      return `max${this.count}(${this.diceCount}d${this.diceSides})`;
    }

    // If no stored dice info, fallback to simple max expression
    return `max${this.count}(?d?)`;
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

  // Legacy expressions
  override toExpression(): string {
    const configs = this.getSubRollConfigs();
    return new RollBuilder(configs).toExpression();
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

  // Legacy expressions
  override toExpression(): string {
    const configs = this.getSubRollConfigs();
    return new RollBuilder(configs).toExpression();
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
    private readonly baseExpression: string,
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
    const configsExpression = super.toExpression();

    // If no configs added, just return base expression
    if (configsExpression === "0") {
      return this.baseExpression;
    }

    // Clean up the join
    if (configsExpression.startsWith("-")) {
      // If it's a negative number/expression, format as " - value"
      // configsExpression is like "-2" or "-1d6"
      return `${this.baseExpression} - ${configsExpression.substring(1)}`;
    }
    return `${this.baseExpression} + ${configsExpression}`;
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
    const currentAST = this.toAST();
    const currentExpr = this.toExpression();

    const sumNode: SumNode = {
      type: "sum",
      count,
      child: currentAST,
    };

    const newExpr = count === 1 ? currentExpr : `${count}(${currentExpr})`;

    return new PooledRollBuilder(sumNode, newExpr, [], (scale) => this.scaleDice(scale).times(count));
  }
}

/**
 * An additive composite of independent rolls that preserves each part's AST — the piece
 * that lets a scaled/halved sub-roll (which the flat `.plus()` merge would otherwise drop)
 * sit beside plain rolls in one damage payload. Its PMF convolves the parts; its expression
 * joins them with ` + `. Built via {@link sumRolls}; terminal (used as an onHit/onCrit/
 * onSaveFailure payload), so it reports hidden state to reject accidental flat merges.
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
    const exprs = this.parts
      .map((p) => p.toExpression())
      .filter((e) => e && e !== "0");
    if (exprs.length === 0) return "0";
    let result = exprs[0];
    for (let i = 1; i < exprs.length; i++) {
      const e = exprs[i];
      result += e.startsWith("-") ? ` - ${e.substring(1)}` : ` + ${e}`;
    }
    return result.replace(/\+ -/g, "-");
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
 * expression is them joined with ` + `. Unlike `a.plus(b)`, this preserves parts that carry
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
