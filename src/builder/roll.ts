import type { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { astFromRollConfigs, pmfFromRollBuilder } from "./ast";
import type { ExpressionNode } from "./nodes";
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

  protected get lastConfig() {
    return this.subRollConfigs[this.subRollConfigs.length - 1];
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
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
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
      return new (this.constructor as new (
        configs: readonly RollConfig[]
      ) => RollBuilder)(newConfigs);
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
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
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
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
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
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  bestOf(count: number | undefined): RollBuilder {
    if (count !== undefined && isNaN(count))
      throw new Error("Invalid NaN value for bestOf count");
    if (count === undefined) return this;
    if (count <= 0) throw new Error("Best of count must be > 0");

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].bestOf = count;
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  keepHighest(total: number, count: number): RollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighest");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].keep = { total, count, mode: "highest" };
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  keepLowest(total: number, count: number): RollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepLowest");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].keep = { total, count, mode: "lowest" };
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  withAdvantage(): RollBuilder {
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].rollType = "advantage";
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  withDisadvantage(): RollBuilder {
    const configs = this.getSubRollConfigs();
    configs[configs.length - 1].rollType = "disadvantage";
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(configs);
  }

  add(anotherRoll: RollBuilder | undefined): RollBuilder {
    if (anotherRoll === undefined) return this;
    const configs = [...this.subRollConfigs, ...anotherRoll.subRollConfigs];
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(configs);
  }

  withBonus(anotherRoll: RollBuilder): RollBuilder {
    const configs = [...this.subRollConfigs, ...anotherRoll.subRollConfigs];
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(configs);
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
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(configs);
  }

  doubleDice(): RollBuilder {
    const newConfigs = this.getSubRollConfigs().map((config) => {
      if (!config.sides || config.sides <= 0) return config;
      return { ...config, count: config.count * 2 };
    });
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  copy(): RollBuilder {
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(this.getSubRollConfigs());
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
    return new (this.constructor as new (
      configs: readonly RollConfig[]
    ) => RollBuilder)(newConfigs);
  }

  toExpression(): string {
    const originalDiceConfigs = this.subRollConfigs.filter(
      (config) => config.sides && config.sides > 0
    );

    const configGroups = new Map<
      string,
      { config: RollConfig; totalCount: number }
    >();

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
    let rootD20Group: { config: RollConfig; totalCount: number } | undefined;

    if (rootConfig && rootConfig.sides === 20) {
      const rootIndex = groupedConfigs.findIndex(
        ({ config }) =>
          config.sides === rootConfig.sides &&
          config.rollType === rootConfig.rollType &&
          config.reroll === rootConfig.reroll &&
          config.explode === rootConfig.explode &&
          config.minimum === rootConfig.minimum &&
          config.bestOf === rootConfig.bestOf &&
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
      } else {
        // Use minus sign for negative subtraction, plus sign otherwise
        const operator = config.isSubtraction ? " - " : " + ";
        result += operator + expression;
      }
    }

    if (totalModifier > 0) result += ` + ${totalModifier}`;
    else if (totalModifier < 0) result += ` - ${Math.abs(totalModifier)}`;
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
          const hasExplode = false; //baseDie.includes('^')
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
}
