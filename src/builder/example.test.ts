import { describe, expect, it } from "vitest";
import { d6, roll } from "./";
import * as examples from "./example";

const builderMap: Record<string, any> = {
  basic2d6Plus3: examples.basic2d6Plus3,
  basicShorthandRoll: examples.basicShorthandRoll,
  shortcutDie: examples.shortcutDie,
  flatFive: examples.flatFive,
  negativeBaseDieInline: examples.negativeBaseDieInline,
  negativeBaseDie: examples.negativeBaseDie,
  subtractBonusDie: examples.subtractBonusDie,
  singleD20: examples.singleD20,
  addAWholeBunch: examples.addAWholeBunch,
  subtractAWholeBunch: examples.subtractAWholeBunch,
  halflingD20: examples.halflingD20,
  halflingD20Shorthand: examples.halflingD20Shorthand,
  twoD6Reroll12: examples.twoD6Reroll12,
  min2OnD6: examples.min2OnD6,
  kh3Of4d6: examples.kh3Of4d6,
  kl2Of4d8: examples.kl2Of4d8,
  advD20: examples.advD20,
  halflingAdv: examples.halflingAdv,
  disD20: examples.disD20,
  complexDamage: examples.complexDamage,
  doubledD8: examples.doubledD8,
  bestOfExample: examples.bestOfExample,
  basicAttackCheck: examples.basicAttackCheck,
  blessedAttack: examples.blessedAttack,
  elvenAccuracyAttack: examples.elvenAccuracyAttack,
  basicAttack: examples.basicAttack,
  detailedAttack: examples.detailedAttack,
  basicSaveCheck: examples.basicSaveCheck,
  saveFailOnly: examples.saveFailOnly,
  saveHalf: examples.saveHalf,
  disadvantagedSave: examples.disadvantagedSave,
  factoryOverload: examples.factoryOverload,
  doubleD6: examples.doubleD6,
  doubleD6Plus1: examples.doubleD6Plus1,
  double2d6: examples.double2d6,
  double2d6plus3: examples.double2d6plus3,
  tripleComplexRoll: examples.tripleComplexRoll,
  realisticChaining: examples.realisticChaining,
  fullAttack: examples.fullAttack,
  fullAttackWithCrit: examples.fullAttackWithCrit,
  fullAttackWithCritAndMiss: examples.fullAttackWithCritAndMiss,
  basicDamageRoll: examples.basicDamageRoll,
  basicShorthandD6Roll: examples.basicShorthandD6Roll,
  basicShorthandD6Plus3Roll: examples.basicShorthandD6Plus3Roll,
};

const expectedExpressions: Record<string, string> = {
  basic2d6Plus3: examples.basic2d6Plus3ExprExpected,
  basicShorthandRoll: examples.basicShorthandRollExprExpected,
  shortcutDie: examples.shortcutDieExprExpected,
  flatFive: examples.flatFiveExprExpected,
  negativeBaseDieInline: examples.negativeBaseDieInlineExprExpected,
  negativeBaseDie: examples.negativeBaseDieExprExpected,
  subtractBonusDie: examples.subtractBonusDieExprExpected,
  singleD20: examples.singleD20ExprExpected,
  addAWholeBunch: examples.addAWholeBunchExprExpected,
  subtractAWholeBunch: examples.subtractAWholeBunchExprExpected,
  halflingD20: examples.halflingD20ExprExpected,
  halflingD20Shorthand: examples.halflingD20ShorthandExprExpected,
  twoD6Reroll12: examples.twoD6Reroll12ExprExpected,
  min2OnD6: examples.min2OnD6ExprExpected,
  kh3Of4d6: examples.kh3Of4d6ExprExpected,
  kl2Of4d8: examples.kl2Of4d8ExprExpected,
  advD20: examples.advD20ExprExpected,
  halflingAdv: examples.halflingAdvExprExpected,
  disD20: examples.disD20ExprExpected,
  complexDamage: examples.complexDamageExprExpected,
  doubledD8: examples.doubledD8ExprExpected,
  bestOfExample: examples.bestOfExampleExprExpected,
  basicAttackCheck: examples.basicAttackCheckExprExpected,
  blessedAttack: examples.blessedAttackExprExpected,
  elvenAccuracyAttack: examples.elvenAccuracyAttackExprExpected,
  basicAttack: examples.basicAttackExprExpected,
  detailedAttack: examples.detailedAttackExprExpected,
  basicSaveCheck: examples.basicSaveCheckExprExpected,
  saveFailOnly: examples.saveFailOnlyExprExpected,
  saveHalf: examples.saveHalfExprExpected,
  disadvantagedSave: examples.disadvantagedSaveExprExpected,
  factoryOverload: examples.factoryOverloadExprExpected,
  doubleD6: examples.doubleD6ExprExpected,
  doubleD6Plus1: examples.doubleD6Plus1ExprExpected,
  double2d6: examples.double2d6ExprExpected,
  double2d6plus3: examples.double2d6plus3ExprExpected,
  tripleComplexRoll: examples.tripleComplexRollExprExpected,
  realisticChaining: examples.realisticChainingExprExpected,
  fullAttack: examples.fullAttackExprExpected,
  fullAttackWithCrit: examples.fullAttackWithCritExprExpected,
  fullAttackWithCritAndMiss: examples.fullAttackWithCritAndMissExprExpected,
  basicDamageRoll: examples.basicDamageRollExprExpected,
  basicShorthandD6Roll: examples.basicShorthandD6RollExprExpected,
  basicShorthandD6Plus3Roll: examples.basicShorthandD6Plus3RollExprExpected,
};

describe("Builder examples integration", () => {
  it("should produce expected expressions for all catalog examples", () => {
    for (const [key, expectedExpr] of Object.entries(expectedExpressions)) {
      const builder = builderMap[key];
      expect(builder).toBeDefined();
      expect(builder.toExpression()).toBe(expectedExpr);
    }
  });

  it("should confirm that halfling d20 shorthand and longhand expressions match", () => {
    expect(examples.halflingD20Shorthand.toExpression()).toBe(
      examples.halflingD20.toExpression()
    );
  });

  it("should analyze a roll PMF with threshold queries", () => {
    const res = examples.analyzeRoll(roll(2).d6().plus(3), 10);
    expect(res.expr).toBe("2d6 + 3");
    expect(res.min).toBe(5);
    expect(res.max).toBe(15);
    expect(res.mean).toBeCloseTo(10, 5);
    expect(res.pAtLeastThreshold).toBeGreaterThan(0);
    expect(res.pAtLeastThreshold).toBeLessThanOrEqual(1);
  });

  it("should analyze a single attack via DiceQuery", () => {
    const stats = examples.analyzeAttack(examples.basicAttack);
    expect(stats.expr).toBe(examples.basicAttackExprExpected);
    expect(stats.dpr).toBeGreaterThan(0);
    expect(stats.pHitOrCrit).toBeGreaterThan(0);
    expect(stats.pHitOrCrit).toBeLessThanOrEqual(1);
    expect(stats.pCrit).toBeCloseTo(0.05, 2);
    expect(stats.hitDamage.min).toBeGreaterThan(0);
    expect(stats.critDamage.min).toBeGreaterThan(0);
  });

  it("should compare disadvantage/normal/advantage correctly", () => {
    const damage = roll(2).d6().plus(4);
    const res = examples.compareAdvantageStates(6, 16, damage);

    expect(res.disadvantage.dpr).toBeGreaterThan(0);
    expect(res.normal.dpr).toBeGreaterThan(res.disadvantage.dpr);
    expect(res.advantage.dpr).toBeGreaterThan(res.normal.dpr);

    expect(res.disadvantage.pHitOrCrit).toBeLessThan(res.normal.pHitOrCrit);
    expect(res.advantage.pHitOrCrit).toBeGreaterThan(res.normal.pHitOrCrit);
  });

  it("should aggregate two attacks", () => {
    const out = examples.analyzeTwoAttacks(examples.basicAttack);
    expect(out.attacks).toBe(2);
    expect(out.dpr).toBeGreaterThan(0);
    expect(out.pAtLeastOneHitOrCrit).toBeGreaterThan(0);
    expect(out.pAtLeastOneHitOrCrit).toBeLessThanOrEqual(1);
    expect(out.pAtLeastOneCrit).toBeGreaterThan(0);
  });

  it("should quantify bless what-if", () => {
    const damage = roll(2, d6).plus(4);
    const res = examples.blessWhatIf(6, 16, damage);
    // the bonusDice stuff doesn't work anymore.
    // When we create a new ACBuilder, we should create and pass in bonusDice
    expect(res.blessed.dpr).toBeGreaterThan(res.normal.dpr);
    expect(res.blessed.pHitOrCrit).toBeGreaterThan(res.normal.pHitOrCrit);
    expect(res.lift.dpr).toBeCloseTo(res.blessed.dpr - res.normal.dpr, 8);
  });

  it("should analyze saves via resolve() and query", () => {
    const res = examples.analyzeSave(examples.saveHalf);
    expect(res.expr).toBe(examples.saveHalfExprExpected);
    expect(res.resolved.mean).toBeGreaterThanOrEqual(0);
    expect(res.query.mean).toBeGreaterThanOrEqual(0);
    // Sanity: save outcomes partition probability
    expect(res.query.pFail + res.query.pHalf).toBeCloseTo(1, 5);
  });

  it("should resolve a save example and return stats", () => {
    const res = examples.resolveSaveExample();
    expect(res.pmfMean).toBeGreaterThan(0);
    expect(res.weights).toBeDefined();
    expect(Object.keys(res.weights).length).toBeGreaterThan(0);
  });

  it("should run demo analyses without errors and with sensible bounds", () => {
    const out = examples.demoAnalyses();
    expect(out.basicAtk.dpr).toBeGreaterThan(0);
    expect(out.advCompare.advantage.dpr).toBeGreaterThan(
      out.advCompare.disadvantage.dpr
    );
    expect(out.complexRoll.min).toBeGreaterThanOrEqual(0);
    expect(out.saveInfo.resolved.mean).toBeGreaterThanOrEqual(0);
  });

  it("should handle a roll with bestOf", () => {
    expect(roll(4).d6().bestOf(3).toExpression()).toBe("4d6kh3");
  });

  it("should ignore bestOf if it is not less than count", () => {
    expect(roll(3).d6().bestOf(3).toExpression()).toBe("3d6");
    expect(roll(3).d6().bestOf(4).toExpression()).toBe("3d6");
  });

  it("should handle a complex expression with parts", () => {
    expect(roll(2).d6().plus(3).toExpression()).toBe("2d6 + 3");
    expect(roll(2).d6().minus(2).toExpression()).toBe("2d6 - 2");
  });
});
