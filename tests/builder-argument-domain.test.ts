import { describe, expect, it } from "vitest";
import { d, d20, d6, roll } from "../src/builder";

const attack = () => d20.plus(5).ac(15).onHit(roll(2, d6));
const nonFinite = [Infinity, -Infinity, NaN] as const;

describe("scaleResult() refuses a numerator or denominator it cannot scale by", () => {
  it.each(nonFinite)("numerator %s", (value) => {
    expect(() => roll(2, d6).scaleResult(value, 2)).toThrow(/scaleResult\(\) numerator/);
  });

  it.each(nonFinite)("denominator %s", (value) => {
    expect(() => roll(2, d6).scaleResult(1, value)).toThrow(/scaleResult\(\) denominator/);
  });

  it("a zero denominator", () => {
    expect(() => roll(2, d6).scaleResult(1, 0)).toThrow(/scaleResult\(\) denominator must not be 0/);
  });

  it("still scales by finite fractions, negative numerators included", () => {
    // floor(3x / 2) over 2d6 sums to 369 across its 36 rolls.
    expect(roll(2, d6).scaleResult(3, 2).toPMF().mean()).toBeCloseTo(369 / 36, 12);
    expect(roll(1, d6).scaleResult(-1).toPMF().mean()).toBeCloseTo(-7 / 2, 12);
  });
});

describe("attack payload transforms refuse infinite arguments", () => {
  it.each([Infinity, -Infinity])("minimumDamageDie(%s)", (value) => {
    expect(() => attack().minimumDamageDie(value)).toThrow(/minimumDamageDie\(\) must be finite/);
  });

  it.each([Infinity, -Infinity])("rerollDamage(%s)", (value) => {
    expect(() => attack().rerollDamage(value)).toThrow(/rerollDamage\(\) threshold must be finite/);
  });
});

describe("checks refuse an infinite AC, DC or crit threshold", () => {
  it.each([Infinity, -Infinity])("ac(%s)", (value) => {
    expect(() => d20.plus(5).ac(value)).toThrow(/ac\(\) must be finite/);
  });

  it.each([Infinity, -Infinity])("dc(%s)", (value) => {
    expect(() => d20.plus(5).dc(value)).toThrow(/dc\(\) must be finite/);
  });

  it.each(nonFinite)("critOn(%s) on an AC check", (value) => {
    expect(() => d20.plus(5).ac(15).critOn(value)).toThrow(/critOn\(\)/);
  });

  it.each(nonFinite)("critOn(%s) on an always-hitting check", (value) => {
    expect(() => d20.plus(5).alwaysHits().critOn(value)).toThrow(/critOn\(\)/);
  });

  it.each(nonFinite)("critOn(%s) on an always-critting check", (value) => {
    expect(() => d20.plus(5).ac(15).alwaysCrits().critOn(value)).toThrow(/critOn\(\)/);
  });

  it.each([Infinity, -Infinity])("withCheck() returning ac %s", (value) => {
    expect(() => attack().withCheck((check) => ({ ...check, ac: value }))).toThrow(/AC in withCheck\(\) must be finite/);
  });

  it.each(nonFinite)("withCheck() returning critThreshold %s", (value) => {
    expect(() => attack().withCheck((check) => ({ ...check, critThreshold: value }))).toThrow(
      /crit threshold in withCheck\(\)/
    );
  });

  it("a finite rebind still resolves exactly", () => {
    const rebound = attack().withCheck((check) => ({ ...check, ac: 16, critThreshold: 19 }));
    // Hits on 11..18 (8/20) for 2d6, crits on 19..20 (2/20) for 4d6.
    expect(rebound.toPMF().mean()).toBeCloseTo((8 / 20) * 7 + (2 / 20) * 14, 12);
  });
});

describe("dice sides must be a non-negative finite number", () => {
  it.each([-Infinity, -6, -1])("roll(2, %s)", (sides) => {
    expect(() => roll(2, sides)).toThrow(/sides/);
  });

  it.each([-Infinity, -6])("d(%s)", (sides) => {
    expect(() => d(sides)).toThrow(/sides/);
  });

  it("zero sides keeps its meaning: no die, a sum of 0", () => {
    expect(roll(2, 0).toPMF().mean()).toBe(0);
    expect(roll(2, 0).plus(3).toPMF().mean()).toBe(3);
  });
});
