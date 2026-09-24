import type { ACBuilder } from "./ac";
import type { CritConfig } from "../common/types";
import type { DCBuilder } from "./dc";
import { parse } from "../parser/parser";
import { AmbiguousCritDoublingError, scaleParsedDice, UndoubleableExpressionError } from "../parser/scaleDice";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import {
  astFromRollConfigs,
  clearDieCaches,
  perDieKeepReading,
  pmfFromRollBuilder,
  resolveRootD20,
} from "./ast";
import { configTerms, joinTerms, nodeRange, printScale, rootDieExpression, type ExpressionTerm } from "./expression";
import { AttackBuilder } from "./attack";
import type { ExpressionNode, KeepNode, SumNode } from "./nodes";
import type { RollConfig, RollType } from "./types";

export { AmbiguousKeepError } from "./ast";

/** Throws for ±Infinity (NaN has its own, earlier message at each call site). */
function requireFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new Error(`${what} must be finite, got ${value}`);
}

/**
 * Thrown when a parsed string (`d("d20+5")`, `RollBuilder.fromArgs("d20+5")`) is used as an attack
 * or save check. A parsed builder carries only its PMF, not the dice and flats a check reads, so
 * the check would silently lose them.
 */
export class ParsedCheckError extends Error {
  constructor(readonly expression: string, verb: "ac" | "dc") {
    const example = verb === "ac" ? "d20.plus(5).ac(15)" : "d20.plus(5).dc(15)";
    const full = verb === "ac" ? "(d20 + 5 AC 15) * (1d8)" : "(d20 + 5 DC 15) * (8d6) save half";
    super(
      `Cannot use the parsed string "${expression}" as a check with .${verb}(): a parsed roll carries no ` +
        `dice or flats for the check to read. Build the check with the builder API (${example}) or ` +
        `parse a full attack or save string ("${full}").`
    );
    this.name = "ParsedCheckError";
    Object.setPrototypeOf(this, ParsedCheckError.prototype);
  }
}

/** A group that `roll(N, X)` must copy N times rather than scale: its dice count is part of its meaning. */
function repeatsByCopy(config: RollConfig): boolean {
  return config.keep !== undefined || config.bestOf > 0 || config.explodePoolBudget > 0;
}

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
 * a die rolled with advantage/disadvantage/elven accuracy (doubled as twice the advantaged dice, or
 * as advantage over the doubled sum) do not.
 */
function ambiguousScaling(config: RollConfig, scale: number): string | undefined {
  const die = `d${config.sides}`;
  if (config.rollType !== "flat") {
    return (
      `a ${die} rolled with ${config.rollType} has no single doubled meaning ` +
      `(twice as many dice each rolled with ${config.rollType}, or ${config.rollType} over the doubled sum)`
    );
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
const rollPMFCache = PMF.createCache(4000);

/** Clears the plain-roll and single-die PMF caches (test/bench seam; mirrors {@link clearAttackCache}). */
export function clearRollCache(): void {
  rollPMFCache.clear();
  clearDieCaches();
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
      requireFinite(count, "count");
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
    // Non-finite numbers are kept distinct: JSON.stringify alone writes ±Infinity and NaN as null.
    return JSON.stringify(this.subRollConfigs, (_key, value: unknown) =>
      typeof value === "number" && !Number.isFinite(value) ? `#${value}` : value
    );
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
        const repeated = RollBuilder.repeated(sidesOrDie, count);
        return modifier !== undefined ? repeated.plus(modifier) : repeated;
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

  /**
   * `count` independent copies of `die`, subtracted when `count` is negative. A plain group scales
   * its dice count; a group whose count is part of its meaning (a keep, `bestOf()`, a pool-wide
   * `explodePool()` budget) is copied, so `roll(2, d6.keepHighest(2, 1))` is two best-of-two d6.
   * Each copy brings its own flat modifier, negated with the dice when subtracted.
   */
  protected static repeated(die: RollBuilder, count: number): RollBuilder {
    if (die instanceof TransformedRollBuilder) {
      const copies = Math.abs(count);
      if (copies === 0) return new RollBuilder(0);
      const total = sumRolls(Array.from({ length: copies }, () => die));
      return count < 0 ? new ScaleRollBuilder(total, -1) : total;
    }
    if (die.hasHiddenState()) {
      throw new Error(
        "Cannot use a roll with hidden state (like a pooled roll) as a die type."
      );
    }
    const configs = die.getSubRollConfigs();
    if (configs.length === 0) return new RollBuilder(0);

    const copies = Math.abs(count);
    const negate = count < 0;
    const repeatedConfigs: RollConfig[] = [];
    for (const config of configs) {
      const isSubtraction = (config.isSubtraction === true || config.count < 0) !== negate;
      const dice = Math.abs(config.count);
      const modifier = (negate ? -1 : 1) * config.modifier * copies;
      if (copies > 1 && repeatsByCopy(config)) {
        for (let i = 0; i < copies; i++) {
          repeatedConfigs.push({ ...config, count: dice, isSubtraction, modifier: i === 0 ? modifier : 0 });
        }
      } else {
        repeatedConfigs.push({ ...config, count: dice * copies, isSubtraction, modifier });
      }
    }
    return new RollBuilder(repeatedConfigs);
  }

  // --- Core Dice Methods ---
  d(sides: number | undefined): RollBuilder {
    if (sides !== undefined && isNaN(sides))
      throw new Error("Invalid NaN value for sides");
    if (sides === undefined) return this;
    requireFinite(sides, "sides");
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
    if (typeof modOrRoll === "number") requireFinite(modOrRoll, "plus()/minus() argument");
    if (die instanceof RollBuilder && typeof modOrRoll === "number") {
      return this.add(RollBuilder.repeated(die, modOrRoll));
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

  /**
   * Reroll faces 1..`value` once and keep the second roll (Great Weapon Fighting in the 2014
   * rules). The reroll decides on the die's raw face: on a group that also has a {@link minimum},
   * the floor applies to the kept face afterwards, whichever of the two was called first.
   */
  reroll(value: number): RollBuilder {
    if (isNaN(value)) throw new Error("Invalid NaN value for reroll");
    requireFinite(value, "reroll()");
    if (value === this.lastConfig.reroll) return this;

    const newConfigs = this.getSubRollConfigs();

    newConfigs[newConfigs.length - 1].reroll = value;
    return this.create(newConfigs);
  }

  /**
   * Let each die explode: a roll of its highest face adds another die, at most `count` extra dice
   * per die. The cap is required and must be finite; `explode(0)` is a no-op. For one budget
   * shared by the whole pool, use {@link explodePool}.
   */
  explode(count: number): RollBuilder {
    if (count === undefined) {
      throw new Error(
        "explode() needs an explicit cap: explode(k) lets each die add at most k extra dice."
      );
    }
    if (isNaN(count)) throw new Error("Invalid NaN value for explode count");
    requireFinite(count, "explode() cap");
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
   * allowed up to `explode(k)` extra dice). `budget` must be a finite non-negative integer.
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

  /**
   * Floor each die at `val`: `minimum(3)` treats a 1 or 2 as a 3 (the 2024 Great Weapon Fighting
   * style). On a group that also has a {@link reroll}, the reroll decides on the raw face and this
   * floor applies to the kept face afterwards, whichever of the two was called first.
   */
  minimum(val: number | undefined): RollBuilder {
    if (val !== undefined && isNaN(val))
      throw new Error("Invalid NaN value for minimum");
    if (val === undefined) return this;
    requireFinite(val, "minimum()");
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
    requireFinite(count, "bestOf()");
    if (count <= 0) throw new Error("Best of count must be > 0");

    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].bestOf = count;
    return this.create(newConfigs);
  }

  /**
   * Keep the highest `count` of `total`. On one die, that is `count` of `total` rolls of the die;
   * on N dice it is `count` of the N dice when `total` is N and `count` >= 2, or the best of
   * `total` rolls of the whole N-dice group when `count` is 1. Any other shape on N > 1 dice has
   * more than one reading and throws an {@link AmbiguousKeepError}; use {@link keepHighestAll}
   * or a keep on each die instead.
   */
  keepHighest(total: number, count: number): RollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighest");
    return this.withKeep({ total, count, mode: "highest" });
  }

  /**
   * Keep the lowest `count` of `total`; the mirror of {@link keepHighest}. On N > 1 dice,
   * `keepLowest(N, 1)` throws an {@link AmbiguousKeepError}: the lowest single die and the worse
   * of N rolls of the whole group are both plausible readings.
   */
  keepLowest(total: number, count: number): RollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepLowest");
    return this.withKeep({ total, count, mode: "lowest" });
  }

  private withKeep(keep: NonNullable<RollConfig["keep"]>): RollBuilder {
    requireFinite(keep.total, "keep total");
    requireFinite(keep.count, "keep count");
    const newConfigs = this.getSubRollConfigs();
    const last = newConfigs[newConfigs.length - 1];
    if (last.sides > 0 && last.rollType === "flat") perDieKeepReading(last.count, last.sides, keep);
    last.keep = keep;
    return this.create(newConfigs);
  }

  keepHighestAll(total: number, count: number): PooledRollBuilder {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighestAll");
    requireFinite(total, "keepHighestAll() total");
    requireFinite(count, "keepHighestAll() count");
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
    requireFinite(total, "keepLowestAll() total");
    requireFinite(count, "keepLowestAll() count");
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
    if (anotherRoll instanceof TransformedRollBuilder) return sumRolls([this, anotherRoll]);
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
        // An exploding die has no string form; the ambiguity, not the missing spelling, is the error.
        let shown = "this roll";
        try {
          shown = `"${this.toExpression()}"`;
        } catch {
          // keep the generic name
        }
        throw new AmbiguousCritDoublingError(
          `Cannot double the dice of ${shown} on a crit: ${ambiguity}. ` +
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

  /**
   * The highest of `count` independent rolls of this whole roll (dice, flats, rerolls and all):
   * `roll(2, d6).plus(3).maxOf(2)` is the better of two 2d6 + 3. Given another roll instead, the
   * higher of this roll and that one: `roll(3, d8).maxOf(roll(2, d10))`.
   */
  maxOf(count: number): MaxOfRollBuilder;
  maxOf(other: RollBuilder): RollBuilder;
  maxOf(countOrOther: number | RollBuilder): RollBuilder {
    if (countOrOther instanceof RollBuilder) return new MaxOfRollsBuilder([this, countOrOther]);
    if (isNaN(countOrOther)) throw new Error("Invalid NaN value for maxOf count");
    requireFinite(countOrOther, "maxOf() count");
    return new MaxOfRollBuilder(this, countOrOther);
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

/**
 * A roll whose value is a transform of whole rolls: halved, scaled, the highest of several, or a
 * sum that keeps such parts. Arithmetic on it (`plus`, `minus`, `add`) composes as a sum that
 * keeps the transform, so `roll(2, d6).half().plus(1)` is floor(2d6 / 2) + 1. Verbs that edit the
 * underlying dice (`reroll`, `minimum`, `keepHighest`, advantage, ...) throw instead: set them on
 * the roll before transforming it.
 */
abstract class TransformedRollBuilder extends RollBuilder {
  /** The call that made this roll, for error messages (e.g. `half()`). */
  protected abstract readonly verb: string;

  protected override create(_configs: readonly RollConfig[]): RollBuilder {
    throw new Error(
      `Cannot change the dice of a ${this.verb} roll: that would drop the ${this.verb} transform. ` +
        `Set reroll/minimum/explode/keep/advantage on the roll before calling ${this.verb}.`
    );
  }

  override plus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
  override plus(count: number, die: RollBuilder): RollBuilder;
  override plus(modOrRoll: number | RollBuilder | undefined, die?: RollBuilder): RollBuilder {
    if (typeof modOrRoll === "number" && isNaN(modOrRoll))
      throw new Error("Invalid NaN value for modOrRoll");
    if (typeof modOrRoll === "number") requireFinite(modOrRoll, "plus()/minus() argument");
    if (die instanceof RollBuilder && typeof modOrRoll === "number") {
      return this.add(RollBuilder.repeated(die, modOrRoll));
    }
    if (die !== undefined) throw new Error("Invalid arguments to plus()");
    if (modOrRoll === undefined || modOrRoll === 0) return this;
    if (typeof modOrRoll === "number") return sumRolls([this, new RollBuilder(0).plus(modOrRoll)]);
    return this.add(modOrRoll);
  }

  override add(anotherRoll: RollBuilder | undefined): RollBuilder {
    return anotherRoll === undefined ? this : sumRolls([this, anotherRoll]);
  }
}

export class HalfRollBuilder extends TransformedRollBuilder {
  protected readonly verb = "half()";

  constructor(private readonly innerRoll: RollBuilder) {
    super(0); // dummy, we override methods
  }

  override hasHiddenState(): boolean {
    return this.innerRoll.hasHiddenState();
  }

  override cacheKey(): string | null {
    return null; // half-of transform not captured by subRollConfigs
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
 * `(inner) ** N // D`. Arithmetic after it keeps the scale (see {@link sumRolls}).
 */
export class ScaleRollBuilder extends TransformedRollBuilder {
  protected readonly verb = "scaleResult()";

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

export class MaxOfRollBuilder extends TransformedRollBuilder {
  protected readonly verb = "maxOf()";

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
    return { type: "maxOf", count: this.count, child: this.innerRoll.toAST() };
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

  /** Refused: a parsed roll has no dice or flats for a check to read (see {@link ParsedCheckError}). */
  override ac(_targetAC: number): ACBuilder {
    throw new ParsedCheckError(this.originalExpression, "ac");
  }

  /** Refused: a parsed roll has no dice or flats for a check to read (see {@link ParsedCheckError}). */
  override dc(_saveDC: number): DCBuilder {
    throw new ParsedCheckError(this.originalExpression, "dc");
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

  override explode(_count: number): RollBuilder {
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
 * that lets a scaled/halved sub-roll sit beside plain rolls in one damage payload. Its PMF
 * convolves the parts; its expression sums them, each part one term of the sum. Built via
 * {@link sumRolls} and by arithmetic on a transformed roll; it reports hidden state so it is never
 * merged as dice.
 */
class CompositeSumRollBuilder extends TransformedRollBuilder {
  protected readonly verb = "sumRolls()";

  constructor(readonly parts: readonly RollBuilder[]) {
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

/** The higher of independent, possibly different rolls: `roll(3, d8).maxOf(roll(2, d10))`. */
class MaxOfRollsBuilder extends TransformedRollBuilder {
  protected readonly verb = "maxOf()";

  constructor(private readonly rolls: readonly RollBuilder[]) {
    super(0); // dummy, we override methods
  }

  override hasHiddenState(): boolean {
    return true;
  }

  override cacheKey(): string | null {
    return null; // max of rolls not captured by subRollConfigs
  }

  override getSubRollConfigs(): readonly RollConfig[] {
    return [];
  }

  override toAST(): ExpressionNode {
    return { type: "max", children: this.rolls.map((r) => r.toAST()) };
  }

  override toExpression(): string {
    return this.rolls.map((r) => `(${r.toExpression()})`).join(" > ");
  }

  override toPMF(eps: number = 0): PMF {
    return pmfFromRollBuilder(this, eps);
  }

  /** Scales each roll's dice; the result is still the higher of the scaled rolls. */
  override scaleDice(scale: number): RollBuilder {
    validateScaleInt(scale);
    return new MaxOfRollsBuilder(this.rolls.map((r) => r.scaleDice(scale)));
  }

  override copy(): MaxOfRollsBuilder {
    return new MaxOfRollsBuilder(this.rolls.map((r) => r.copy()));
  }
}

/**
 * Combine several rolls into one additive payload whose PMF is their convolution and whose
 * expression is their sum. Unlike merging plain dice, this preserves parts that carry
 * a transform (e.g. `roll.scaleResult(1, 2)` / `roll.half()`), so per-damage-type resistance
 * and vulnerability survive into both the distribution and the rendered expression.
 * Empty parts collapse to `0`; a single part is returned unwrapped; nested sums are flattened.
 */
export function sumRolls(parts: readonly RollBuilder[]): RollBuilder {
  const meaningful = parts
    .filter((p): p is RollBuilder => p !== undefined)
    .flatMap((p) => (p instanceof CompositeSumRollBuilder ? p.parts : [p]));
  if (meaningful.length === 0) return new RollBuilder(0);
  if (meaningful.length === 1) return meaningful[0];
  return new CompositeSumRollBuilder(meaningful);
}
