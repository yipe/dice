import { describe, expect, it } from "vitest";
import { roll } from "./";

describe("SaveBuilder.computePMF() method", () => {
  it("should compute PMF for save half scenario", () => {
    const damage = roll(6).d6().plus(3);
    const builder = roll.d20().plus(5).dc(15).onSaveFailure(damage).saveHalf();

    const pmf = builder.resolve().pmf;
    const parsedPMF = builder.toPMF();

    expect(parsedPMF).toBeDefined();
    expect(parsedPMF.mean()).toBeCloseTo(pmf.mean(), 5);

    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeGreaterThan(0);
    expect(pmf.min()).toBeGreaterThanOrEqual(0); // Can be 0 or half damage
  });

  it("should compute PMF for no save half scenario", () => {
    const damage = roll(6).d6().plus(3);
    const builder = roll.d20().plus(5).dc(15).onSaveFailure(damage);

    const pmf = builder.resolve().pmf;
    const parsedPMF = builder.toPMF();

    expect(parsedPMF).toBeDefined();
    expect(parsedPMF.mean()).toBeCloseTo(pmf.mean(), 5);

    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeGreaterThan(0);
    expect(pmf.min()).toBeGreaterThanOrEqual(0); // Can be 0 or half damage
  });

  it("should compute PMF for normal save scenario", () => {
    const damage = roll(4).d8().plus(2);
    const builder = roll.d20().plus(3).dc(12).onSaveFailure(damage);

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBeGreaterThan(0);

    const parsedPMF = builder.toPMF();
    expect(parsedPMF).toBeDefined();
    expect(parsedPMF.mean()).toBeCloseTo(pmf.mean(), 5);
  });

  it("should handle save with no failure effect", () => {
    const builder = roll.d20().plus(4).dc(10).onSaveFailure(roll.flat(0));

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBe(0); // No damage on success, no effect on failure

    const parsedPMF = builder.toPMF();
    expect(parsedPMF).toBeDefined();
    expect(parsedPMF.mean()).toBeCloseTo(pmf.mean(), 5);
  });

  it("should handle save half with zero damage", () => {
    const builder = roll
      .d20()
      .plus(2)
      .dc(8)
      .onSaveFailure(roll.flat(0))
      .saveHalf();

    const pmf = builder.resolve().pmf;
    expect(pmf).toBeDefined();
    expect(pmf.mean()).toBe(0);

    const parsedPMF = builder.toPMF();
    expect(parsedPMF).toBeDefined();
    expect(parsedPMF.mean()).toBeCloseTo(pmf.mean(), 5);
  });

  it("should handle different save outcomes correctly", () => {
    const damage = roll(2).d6();

    // Test normal save (no damage on success)
    const normalSave = roll.d20().plus(3).dc(11).onSaveFailure(damage);
    const normalPMF = normalSave.resolve().pmf;

    // Test save half (half damage on success)
    const halfSave = roll.d20().plus(3).dc(11).onSaveFailure(damage).saveHalf();
    const halfPMF = halfSave.resolve().pmf;

    expect(normalPMF).toBeDefined();
    expect(halfPMF).toBeDefined();

    expect(halfPMF.mean()).not.toBe(normalPMF.mean());

    expect(normalSave.toPMF().mean()).toBeCloseTo(
      normalSave.toPMF()?.mean(),
      5
    );
    expect(halfSave.toPMF().mean()).toBeCloseTo(halfSave.toPMF()?.mean(), 5);

    expect(normalSave.toPMF().mean()).toBeCloseTo(2.45, 5);
    expect(halfSave.toPMF().mean()).toBeCloseTo(4.5625, 5);
  });
});
