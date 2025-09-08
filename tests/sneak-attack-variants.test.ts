import { describe, expect, it } from "vitest";
import {
  simpleVariantA,
  simpleVariantB,
  SneakAttackInputs,
  variant1_mainDirectBlend,
  variant2_mainCheckMixtures,
  variant3_closedFormN,
  variant4_stateMachine,
  variant5_evOnly,
  variant6_sequencePartitioning,
} from "../examples/sneak-attack-examples";
import { TEST_EPS } from "../src/types";

describe("Sneak Attack Variants", () => {
  it("should match the expected values", () => {
    const inputs: SneakAttackInputs = {
      check: "(d20 + 8 AC 16)",
      hitDamage: "1d4 + 4",
      critDamage: "2d4 + 4",
      saDamage: "3d6",
      saCritDamage: "6d6",
      expression: "(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)",
      attempts: 2,
      expectedValue: 18.6225,
    };

    const va = simpleVariantA(inputs);
    const vb = simpleVariantB(inputs);
    const v1 = variant1_mainDirectBlend(inputs);
    const v2 = variant2_mainCheckMixtures(inputs);
    const v3 = variant3_closedFormN(inputs);
    const v4 = variant4_stateMachine(inputs);
    const v5 = variant5_evOnly(inputs);
    const v6 = variant6_sequencePartitioning(inputs);

    expect(va).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(vb).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v1).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v2).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v3).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v4).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v5).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v6).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
  });

  it("should work with advantage", () => {
    const inputs: SneakAttackInputs = {
      check: "(d20 > d20 + 8 AC 16)",
      hitDamage: "1d4 + 4",
      critDamage: "2d4 + 4",
      saDamage: "3d6",
      saCritDamage: "6d6",
      expression: "(d20 > d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)",
      attempts: 2,
      expectedValue: 23.3866,
    };

    const va = simpleVariantA(inputs);
    const vb = simpleVariantB(inputs);
    const v1 = variant1_mainDirectBlend(inputs);
    const v2 = variant2_mainCheckMixtures(inputs);
    const v3 = variant3_closedFormN(inputs);
    const v4 = variant4_stateMachine(inputs);
    const v5 = variant5_evOnly(inputs);
    const v6 = variant6_sequencePartitioning(inputs);

    expect(va).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(vb).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v1).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v2).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v3).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v4).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v5).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v6).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
  });

  it("should work with disadvantage", () => {
    const inputs: SneakAttackInputs = {
      check: "(d20 < d20 + 8 AC 16)",
      hitDamage: "1d4 + 4",
      critDamage: "2d4 + 4",
      saDamage: "3d6",
      saCritDamage: "6d6",
      expression: "(d20 < d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)",
      attempts: 2,
      expectedValue: 12.5445,
    };

    const va = simpleVariantA(inputs);
    const vb = simpleVariantB(inputs);
    const v1 = variant1_mainDirectBlend(inputs);
    const v2 = variant2_mainCheckMixtures(inputs);
    const v3 = variant3_closedFormN(inputs);
    const v4 = variant4_stateMachine(inputs);
    const v5 = variant5_evOnly(inputs);
    const v6 = variant6_sequencePartitioning(inputs);

    expect(va).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(vb).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v1).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v2).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v3).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v4).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v5).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
    expect(v6).toBeCloseTo(inputs.expectedValue!, TEST_EPS);
  });
});

/*

*/
