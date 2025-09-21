import { DiceQuery } from "../pmf/query";

// eslint-disable-next-line import/no-unassigned-import
import "./ac"; // for side effects of prototype augmentation
import type { ACBuilder } from "./ac";
// eslint-disable-next-line import/no-unassigned-import
import "./dc"; // for side effects of prototype augmentation
import type { DCBuilder } from "./dc";
import { d10, d12, d20, d4, d6, d8, flat, hd20, roll } from "./factory";
import type { RollBuilder } from "./roll";
import type { SaveBuilder } from "./save";

// ------------------------------
// Basic dice and attacks
// There are a number of ways to specify a roll.
// This optimizes for a fluent readable syntax, but the more explicit syntax can also be used for more advanced rolls.
// ------------------------------

//const query = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)").toQuery();

/* A basic attack. Note that it auto-creates a crit roll. */
export const fullAttack = d20.plus(5).ac(10).onHit(2, d6);
export const fullAttackExprExpected = "(d20 + 5 AC 10) * (2d6) crit (4d6)";

/* A basic attack with a crit roll override */
export const fullAttackWithCrit = d20.plus(5).ac(10).onHit(2, d6).onCrit(5, d6);
export const fullAttackWithCritExprExpected =
  "(d20 + 5 AC 10) * (2d6) crit (5d6)";

/* A basic attack with a crit roll and a miss roll */
export const fullAttackWithCritAndMiss = d20
  .plus(5)
  .ac(10)
  .onHit(2, d6)
  .onMiss(5);
export const fullAttackWithCritAndMissExprExpected =
  "(d20 + 5 AC 10) * (2d6) crit (4d6) miss (5)";

/* Basic damage roll */
export const basicDamageRoll = d6.plus(3);
export const basicDamageRollExprExpected = "1d6 + 3";

/** Basic 2d6 + 3 damage roll
 * For multiple dice, you need to use roll().
 */
export const basic2d6Plus3 = roll(2, d6).plus(3);
export const basic2d6Plus3ExprExpected = "2d6 + 3";

/** Rollling 2 x (1d6+3) */
export const basicShorthandD6Plus3Roll = roll(2, d6.plus(3));
export const basicShorthandD6Plus3RollExprExpected = "2d6 + 6";

/** Same as above using no shorthand */
export const another2d6Plus3 = roll(2).d6().plus(3);
export const another2d6Plus3ExprExpected = "2d6 + 3";

/** Same as above using the shorthand factory signature */
export const basicShorthandRoll = roll(2, 6, 3);
export const basicShorthandRollExprExpected = "2d6 + 3";

/** Same as above using the shorthand factory signature */
export const basicShorthandD6Roll = roll(2, d6, 3);
export const basicShorthandD6RollExprExpected = "2d6 + 3";

/** Using die shortcuts without roll() */
export const shortcutDie = d8.plus(2);
export const shortcutDieExprExpected = "1d8 + 2";

/** Flat modifier only (no dice)
 * You can also use roll.flat(n) if you prefer.
 * Many methods take pure numbers, so this may not even be needed in many cases.
 * */
export const flatFive = flat(5);
export const flatFiveExprExpected = "5";

/** Negative base dice */
export const negativeBaseDieInline = roll(-1, d8);
export const negativeBaseDieInlineExprExpected = "-1d8";

/** Negative base dice explicit */
export const negativeBaseDie = roll(-1).d8();
export const negativeBaseDieExprExpected = "-1d8";

/** Subtracting a bonus die via negative roll part.
 * Useful for effects like Bane
 */
export const subtractBonusDie = d20.minus(d4);
export const subtractBonusDieExprExpected = "d20 - 1d4";

/** A single d20 roll */
export const singleD20 = d20;
export const singleD20ExprExpected = "d20";

// ------------------------------
// Basic chaining
// ------------------------------

/** Adding a bunch */
export const addAWholeBunch = d6.plus(d8).plus(d10).plus(d12).plus(d20);
export const addAWholeBunchExprExpected = "1d20 + 1d12 + 1d10 + 1d8 + 1d6";

/** Subtracting a bunch */
export const subtractAWholeBunch = d6
  .minus(d8)
  .minus(d10)
  .minus(d12)
  .minus(d20);
export const subtractAWholeBunchExprExpected =
  "-1d20 - 1d12 - 1d10 - 1d8 + 1d6"; // For now it just sorts by die size

export const addingMultipleConstants = d6.plus(2).plus(4);
export const addingMultipleConstantsExprExpected = "1d6 + 6";

//** More realistic chaining example */
export const realisticChaining = roll(3, d6).plus(2, d8).plus(4);
export const realisticChainingExprExpected = "2d8 + 3d6 + 4";

// ------------------------------
// Reroll, minimum, keep mechanics, advantage/disadvantage
// ------------------------------

/** Halfling die using the `roll.hd20()` shorthand */
export const halflingD20Shorthand = hd20;
export const halflingD20ShorthandExprExpected = "hd20";

/** Halfling die shorthand: d20 reroll 1. */
export const halflingD20 = d20.reroll(1);
export const halflingD20ExprExpected = "hd20"; // Should be smart enough to convert it to this

/** Halfling die with advantage. */
export const halflingAdv = d20.reroll(1).withAdvantage();
export const halflingAdvExprExpected = "hd20 > hd20";

/** Reroll 1s and 2s on 2d6. */
export const twoD6Reroll12 = roll(2, d6).reroll(2);
export const twoD6Reroll12ExprExpected = "2(d6 reroll 1 reroll 2)";

/** Minimum 2 on a d6. */
export const min2OnD6 = d6.minimum(1);
export const min2OnD6ExprExpected = "2>d6";

/** Keep highest 3 of 4d6. */
export const kh3Of4d6 = roll(4, d6).keepHighest(4, 3);
export const kh3Of4d6ExprExpected = "4kh3(d6)";

/** Keep lowest 2 of 4d8. */
export const kl2Of4d8 = roll(4, d8).keepLowest(4, 2);
export const kl2Of4d8ExprExpected = "4kl2(d8)";

/** Advantage on d20. */
export const advD20 = d20.withAdvantage();
export const advD20ExprExpected = "d20 > d20";

/** Disadvantage on d20. */
export const disD20 = d20.withDisadvantage();
export const disD20ExprExpected = "d20 < d20";

/** Advantage on hd20. */
export const advHd20 = hd20.withAdvantage();
export const advHd20ExprExpected = "hd20 > hd20";

/** Complex chain: 2d6 + 1d8 + 4(d4 reroll 1) + 5
 * Note that reroll(1) applies to the immediate roll before it.
 */
export const complexDamage = roll(2, d6).plus(d8).plus(4, d4).reroll(1).plus(5);
export const complexDamageExprExpected = "1d8 + 2d6 + 4(d4 reroll 1) + 5";

/** Double dice (useful for crit damage duplication) */
export const doubledD8 = d8.plus(5).doubleDice();
export const doubledD8ExprExpected = "2d8 + 5";

/**
 * Best-of example.
 * Roll a set of dice and take the highest N dice rolls.
 */
export const bestOfExample = roll(4, d6).bestOf(3);
export const bestOfExampleExprExpected = "4d6kh3";

// ------------------------------
// Multiplying dice rolls
// ------------------------------

/** Double a d6 roll, resulting in 2d6. */
export const doubleD6 = roll(2, d6);
export const doubleD6ExprExpected = "2d6";

/** Double a d6+1 roll, resulting in 2d6+2. Note that modifiers are also doubled. */
export const doubleD6Plus1 = roll(2, d6.plus(1));
export const doubleD6Plus1ExprExpected = "2d6 + 2";

/** Double a 2d6 roll, resulting in 4d6. */
export const double2d6 = roll(2, roll(2, d6));
export const double2d6ExprExpected = "4d6";

/** Double a 2d6+3 roll, resulting in 4d6+6. */
export const double2d6plus3 = roll(2, roll(2, d6).plus(3));
export const double2d6plus3ExprExpected = "4d6 + 6";

/** Triple a complex roll of 1d8+1d4+2, resulting in 3d8+3d4+6. */
export const tripleComplexRoll = roll(3, d8.plus(d4).plus(2));
export const tripleComplexRollExprExpected = "3d8 + 3d4 + 6";

// ------------------------------
// Attacks (AC checks) and effects
// ------------------------------

/**
 * Basic attack check: d20 + 7 vs AC 15.
 * Returns an ACBuilder; use `onHit()` to attach damage.
 */
export const basicAttackCheck: ACBuilder = d20.plus(7).ac(15);
export const basicAttackCheckExprExpected = "(d20 + 7 AC 15)";

/** Attack with bless (bonus-to-hit via 1d4). */
export const blessedAttack: ACBuilder = d20.plus(d4).plus(7).ac(15);
export const blessedAttackExprExpected = "(d20 + 1d4 + 7 AC 15)";

/** Elven Accuracy (3d20 keep highest) attack to-hit. */
export const elvenAccuracyAttack: ACBuilder = d20
  .withElvenAccuracy()
  .plus(8)
  .ac(18);
export const elvenAccuracyAttackExprExpected = "(d20 > d20 > d20 + 8 AC 18)";

/**
 * Full attack: to-hit check multiplied by effects.
 * - Hit: 2d6 + 4
 * - Crit: default doubling of hit dice if not explicitly provided
 */
export const basicAttack: ReturnType<ACBuilder["onHit"]> = d20
  .plus(6)
  .ac(16)
  .onHit(roll(2, d6).plus(4));
export const basicAttackExprExpected =
  "(d20 + 6 AC 16) * (2d6 + 4) crit (4d6 + 4)";

/** Attack with explicit crit and miss effects; crits on 19–20. */
export const detailedAttack: ReturnType<ACBuilder["onHit"]> = d20
  .plus(9)
  .ac(17)
  .critOn(19)
  .onHit(d12.plus(5))
  .onCrit(roll(2, d12).plus(5))
  .onMiss(0);
export const detailedAttackExprExpected =
  "(d20 + 9 AC 17) * (1d12 + 5) xcrit2 (2d12 + 5) miss (0)";

// ------------------------------
// Saves (DC checks) and effects
// ------------------------------

/**
 * Basic save: d20 + 5 vs DC 15; on failure, take 3d6.
 * Use `saveHalf()` to apply half damage on success.
 */
export const basicSaveCheck: DCBuilder = d20.plus(5).dc(15);
export const basicSaveCheckExprExpected = "(d20 + 5 DC 15)";

/** Save with failure effect (no half on success). */
export const saveFailOnly = basicSaveCheck.onSaveFailure(roll(3, d6));
export const saveFailOnlyExprExpected = "(d20 + 5 DC 15) * (3d6)";

/** Save that deals half damage on success. */
export const saveHalf = basicSaveCheck.onSaveFailure(roll(3, d6)).saveHalf();
export const saveHalfExprExpected = "(d20 + 5 DC 15) * (3d6) save half";

/** Save at disadvantage (apply before turning into DC builder). */
export const disadvantagedSave: DCBuilder = d20.withDisadvantage().dc(14);
export const disadvantagedSaveExprExpected = "(d20 < d20 DC 14)";

/** Example of resolving save PMFs and weights from structured computation. */
export function resolveSaveExample() {
  const res = saveHalf.resolve();
  return {
    pmfMean: res.pmf.mean(),
    weights: res.weights,
  };
}

// ------------------------------
// Factory overload with die parameter
// ------------------------------

export const factoryOverload = roll(4, d4, 1); // Can also do roll(4).d4().plus(1) or roll(4, 4, 1)
export const factoryOverloadExprExpected = "4d4 + 1";

export function analyzeRoll(builder: RollBuilder, threshold: number = 10) {
  const pmf = builder.toPMF();
  return {
    expr: builder.toExpression(),
    min: pmf.min(),
    max: pmf.max(),
    mean: pmf.mean(),
    pAtLeastThreshold: pmf.tailProbGE(threshold),
  };
}

/**
 * Summarizes a single attack using DiceQuery utilities.
 * Returns DPR, hit/crit odds, and per-outcome damage stats.
 */
export function analyzeAttack(attack: ReturnType<ACBuilder["onHit"]>) {
  const pmf = attack.toPMF();
  const query = new DiceQuery(pmf);

  const pCrit = query.probAtLeastOne("crit");
  const pNonCritHit = query.probAtLeastOne("hit");
  const pHitOrCrit = query.probAtLeastOne(["hit", "crit"]);

  const hitStats = query.combinedDamageStats("hit");
  const critStats = query.combinedDamageStats("crit");

  return {
    expr: attack.toExpression(),
    dpr: query.mean(),
    pNonCritHit,
    pCrit,
    pHitOrCrit,
    hitDamage: hitStats, // { min, max, avg, count }
    critDamage: critStats,
  };
}

/**
 * Compares three variants of the same attack: disadvantage, normal, advantage.
 */
export function compareAdvantageStates(
  baseToHit: number,
  ac: number,
  damage: RollBuilder
) {
  const normal = d20.plus(baseToHit).ac(ac).onHit(damage);
  const adv = d20.withAdvantage().plus(baseToHit).ac(ac).onHit(damage);
  const dis = d20.withDisadvantage().plus(baseToHit).ac(ac).onHit(damage);

  const normalQ = normal.toQuery();
  const advQ = adv.toQuery();
  const disQ = dis.toQuery();

  return {
    normal: {
      dpr: normalQ.mean(),
      pHitOrCrit: normalQ.probAtLeastOne(["hit", "crit"]),
      pCrit: normalQ.probAtLeastOne("crit"),
    },
    advantage: {
      dpr: advQ.mean(),
      pHitOrCrit: advQ.probAtLeastOne(["hit", "crit"]),
      pCrit: advQ.probAtLeastOne("crit"),
    },
    disadvantage: {
      dpr: disQ.mean(),
      pHitOrCrit: disQ.probAtLeastOne(["hit", "crit"]),
      pCrit: disQ.probAtLeastOne("crit"),
    },
  };
}

/**
 * Demonstrates multi-attack aggregation (e.g., two swings) with combined DPR and crit odds.
 */
export function analyzeTwoAttacks(attack: ReturnType<ACBuilder["onHit"]>) {
  const pmf = attack.toPMF();
  const query = new DiceQuery([pmf, pmf]);
  return {
    expr: attack.toExpression(),
    attacks: 2,
    dpr: query.mean(),
    pAtLeastOneCrit: query.probAtLeastOne("crit"),
    pAtLeastOneHitOrCrit: query.probAtLeastOne(["hit", "crit"]),
  };
}

/**
 * Compares a blessed attack (bonus-to-hit d4) to the same attack without bless.
 */
export function blessWhatIf(
  baseToHit: number,
  ac: number,
  damage: RollBuilder
) {
  const base = d20.plus(baseToHit);
  const blessed = base.plus(d4).ac(ac).onHit(damage);
  const normal = base.ac(ac).onHit(damage);

  const qN = normal.toQuery();
  const qB = blessed.toQuery();

  return {
    normal: { dpr: qN.mean(), pHitOrCrit: qN.probAtLeastOne(["hit", "crit"]) },
    blessed: { dpr: qB.mean(), pHitOrCrit: qB.probAtLeastOne(["hit", "crit"]) },
    lift: {
      dpr: qB.mean() - qN.mean(),
      pHitOrCrit:
        qB.probAtLeastOne(["hit", "crit"]) - qN.probAtLeastOne(["hit", "crit"]),
    },
  };
}

export function analyzeSave(save: SaveBuilder) {
  const resolved = save.resolve();
  const pmf = save.toPMF();
  const query = pmf.query();

  const pFail = query.probAtLeastOne("saveFail");
  const pHalf = query.probAtLeastOne("saveHalf");

  return {
    expr: save.toExpression(),

    resolved: {
      mean: resolved.pmf.mean(),
      weights: resolved.weights,
    },

    query: {
      mean: query.mean(),
      pFail,
      pHalf,
    },
  };
}

// TODO make some of these interactive UI examples?
export function demoAnalyses() {
  const damage = roll(2, d6).plus(4);
  const advCompare = compareAdvantageStates(6, 16, damage);
  const basicAtk = analyzeAttack(basicAttack);
  const twoSwings = analyzeTwoAttacks(basicAttack);
  const blessCompare = blessWhatIf(6, 16, damage);
  const complexRoll = analyzeRoll(complexDamage, 10);
  const saveInfo = analyzeSave(saveHalf);

  return {
    advCompare,
    basicAtk,
    twoSwings,
    blessCompare,
    complexRoll,
    saveInfo,
  };
}
