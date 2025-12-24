import type { CritConfig } from "../common/types";
import { parse } from "../parser/parser";
import type { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { astFromRollConfigs, pmfFromRollBuilder } from "./ast";
import { AttackBuilder } from "./attack";
import { d20RollPMF } from "./d20";
import type { ExpressionNode, KeepNode, SumNode } from "./nodes";
import type { RollConfig, RollType } from "./types";

export const defaultConfig: RollConfig = {
  count: 1,
  sides: 0,
  modifier: 0,
  reroll: 0,
  explode: 0,
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
    (config.minimum > 0 ? 1 : 0) +
    (config.bestOf > 0 ? 1 : 0) +
    (config.keep !== undefined ? 1 : 0) +
    (config.rollType !== "flat" ? 1 : 0)
  );
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

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].explode = count;
    return this.create(newConfigs);
  }

  /** Apply per-die minimum value (min > 0). */
  minimum(val: number | undefined): RollBuilder {
    if (val !== undefined && isNaN(val))
      throw new Error("Invalid NaN value for minimum");
    if (val === undefined) return this;
    if (val === 0) return this;
    if (val < 0) throw new Error("Minimum value must be >= 0");

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].minimum = val + 1;
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
    return new PooledRollBuilder(keepNode, expression);
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
    return new PooledRollBuilder(keepNode, expression);
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

  scaleDice(scale: number): RollBuilder {
    const scaleInt = Math.floor(scale);
    if (scaleInt !== scale) throw new Error("Scale must be an integer");
    if (scaleInt <= 0) throw new Error("Scale must be > 0");

    const newConfigs = this.getSubRollConfigs().map((config) => {
      if (!config.sides || config.sides <= 0) return config;
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

  toPMF(eps: number = 0): PMF {
    // Main AST entry point
    return pmfFromRollBuilder(this, eps);
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

    let baseDie = `d${config.sides}`;

    if (config.reroll > 0) {
      if (config.minimum > 0 && config.explode > 0) {
        // Complex single roll case: minimum + explode + reroll
        // Apply reroll after minimum is applied
      } else if (config.minimum > 0) {
        // When there's a minimum but no explode, use descending order and apply before minimum
        for (let i = config.reroll; i >= 1; i--) baseDie += ` reroll ${i}`;
      } else {
        // When there's no minimum, use ascending order
        for (let i = 1; i <= config.reroll; i++) baseDie += ` reroll ${i}`;
      }
    }

    if (config.minimum > 0) {
      if (config.reroll > 0 && !config.explode) {
        baseDie = `${config.minimum}>(${baseDie})`;
      } else {
        baseDie = `${config.minimum}>${baseDie}`;
      }
      if (config.reroll > 0 && config.explode > 0) {
        for (let i = 1; i <= config.reroll; i++) {
          baseDie += ` reroll ${i}`;
        }
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
          const baseDieExpression =
            this.configToSingleExpressionWithoutModifier(
              {
                ...config,
                count: config.count,
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
          mainExpression += `kh${config.bestOf}`;
        }
        break;
    }

    return mainExpression;
  }

  getRootDieConfig(): RollConfig | undefined {
    const configs = this.subRollConfigs;
    return configs.find((config) => config.sides > 0) || configs[0];
  }

  getAllDieConfigs(): readonly RollConfig[] {
    return this.getSubRollConfigs();
  }

  getBonusDiceConfigs(): RollConfig[] {
    const allConfigs = this.subRollConfigs;
    const rootConfig =
      allConfigs.find((config) => config.sides > 0) || allConfigs[0];
    if (!rootConfig) return [];
    return allConfigs
      .filter((config) => config.sides > 0)
      .filter((config) => config !== rootConfig);
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

  // Create a "max of N rolls" version of this roll for crit damage with keep operations
  maxOf(count: number): MaxOfRollBuilder {
    return new MaxOfRollBuilder(this, count);
  }

  // These methods are implemented via prototype augmentation in ac.ts and dc.ts
  // They are declared here to provide proper TypeScript types
  ac(targetAC: number): import("./ac").ACBuilder {
    throw new Error("ac() should be implemented via prototype augmentation");
  }

  dc(saveDC: number): import("./dc").DCBuilder {
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

  // No need to override create if we don't expose RollBuilder methods that use it,
  // but HalfRollBuilder extends RollBuilder so it does.
  // However, HalfRollBuilder seems to just wrap another roll.
  // If we call .plus() on HalfRollBuilder, it returns a HalfRollBuilder?
  // No, RollBuilder.plus returns RollBuilder.
  // The inheritance here is a bit tricky.
  // Existing code for HalfRollBuilder doesn't seem to implement plus/etc.
  // So .plus() on a HalfRollBuilder would return a RollBuilder (base class).
  // Which is fine.
  // The only issue is if we want it to return HalfRollBuilder, but it doesn't seem designed for that.

  get lastConfig() {
    return (this.innerRoll as any).lastConfig;
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

  copy(): HalfRollBuilder {
    return new HalfRollBuilder(this.innerRoll.copy());
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

  get lastConfig() {
    return (this.innerRoll as any).lastConfig;
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

  // TODO - move this to AC Builder… or if we create a DC builder that has critOn, throw an error?
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
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    return d20RollPMF(rollType, rerollOne);
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
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    return d20RollPMF(rollType, rerollOne);
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

  protected create(configs: readonly RollConfig[]): RollBuilder {
    return new RollBuilder(configs);
  }

  override toPMF(_eps: number = 0): PMF {
    // Return the pre-computed PMF, ignoring epsilon for now
    // The parse() function was already called with eps=0
    return this.cachedPMF;
  }

  override toExpression(): string {
    return this.originalExpression;
  }

  override toAST(): ExpressionNode {
    // Since we don't have the actual AST structure, return a constant node
    // This is a limitation but shouldn't matter for terminal damage expressions
    throw new Error(
      "ParsedRollBuilder does not support AST conversion. Use the builder API instead."
    );
  }

  override copy(): ParsedRollBuilder {
    return new ParsedRollBuilder(this.originalExpression);
  }

  override doubleDice(): ParsedRollBuilder {
    throw new Error(
      "ParsedRollBuilder does not support doubleDice(). Use explicit onCrit() with the crit damage expression instead."
    );
  }
}

export class PooledRollBuilder extends RollBuilder {
  constructor(
    private readonly baseAST: ExpressionNode,
    private readonly baseExpression: string,
    configs: readonly RollConfig[] = []
  ) {
    // Initialize with empty config if none provided
    super(configs.length > 0 ? configs : 0);
  }

  protected create(configs: readonly RollConfig[]): PooledRollBuilder {
    // This is the key fix: we preserve the baseAST and baseExpression
    // and only update the configs
    return new PooledRollBuilder(this.baseAST, this.baseExpression, configs);
  }

  override hasHiddenState(): boolean {
    return true;
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
    return new PooledRollBuilder(
      this.baseAST,
      this.baseExpression,
      this.getSubRollConfigs()
    );
  }

  override scaleDice(scale: number): RollBuilder {
    const scaleInt = Math.floor(scale);
    if (scaleInt !== scale) throw new Error("Scale must be an integer");
    if (scaleInt <= 0) throw new Error("Scale must be > 0");

    // Scale the base pool (treat it as a die/unit)
    // We wrap the base AST in a SumNode
    const newBaseAST: SumNode = {
      type: "sum",
      count: scaleInt,
      child: this.baseAST,
    };
    const newBaseExpr =
      scaleInt === 1
        ? this.baseExpression
        : `${scaleInt}(${this.baseExpression})`;

    // We preserve the existing modifiers (subRollConfigs) without scaling them,
    // because scaleDice() generally only scales "dice", not flat modifiers.
    // Since we forbid adding dice to PooledRollBuilder, subRollConfigs are only modifiers.
    return new PooledRollBuilder(
      newBaseAST,
      newBaseExpr,
      this.getSubRollConfigs()
    );
  }

  times(count: number): PooledRollBuilder {
    if (isNaN(count)) throw new Error("Invalid NaN value for times");
    if (Math.floor(count) !== count)
      throw new Error("times() requires an integer");
    if (count < 0) throw new Error("times() requires a non-negative integer");

    // We wrap the current state (base + modifiers) into a new pool repeated N times
    const currentAST = this.toAST();
    const currentExpr = this.toExpression();

    const sumNode: SumNode = {
      type: "sum",
      count,
      child: currentAST,
    };

    const newExpr = count === 1 ? currentExpr : `${count}(${currentExpr})`;

    return new PooledRollBuilder(sumNode, newExpr);
  }
}
