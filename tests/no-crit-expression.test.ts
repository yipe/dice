import { describe, expect, it } from "vitest";
import type { AttackBuilder } from "../src/builder";
import { d20, d8, flat, roll, turn } from "../src/builder";
import type { PMF } from "../src/index";
import { parse } from "../src/index";

/** Outcome label → total probability, over every bin. */
function labelMass(pmf: PMF): Record<string, number> {
  const mass: Record<string, number> = {};
  for (const [, bin] of pmf.map) {
    for (const [label, p] of Object.entries(bin.count)) mass[label] = (mass[label] ?? 0) + (p ?? 0);
  }
  return mass;
}

/** Same bins and the same labels in every bin, to 1e-12. */
function expectSameLabelledPMF(actual: PMF, expected: PMF, context: string): void {
  const values = new Set([...actual.support(), ...expected.support()]);
  for (const value of values) {
    const a = actual.map.get(value);
    const e = expected.map.get(value);
    expect(Math.abs((a?.p ?? 0) - (e?.p ?? 0)), `${context}: bin ${value}`).toBeLessThanOrEqual(1e-12);
    const labels = new Set([...Object.keys(a?.count ?? {}), ...Object.keys(e?.count ?? {})]);
    for (const label of labels) {
      const got = a?.count[label] ?? 0;
      const want = e?.count[label] ?? 0;
      expect(Math.abs(got - want), `${context}: bin ${value} label ${label}`).toBeLessThanOrEqual(1e-12);
    }
  }
}

describe("noCrit() prints a clause that parses with no crit", () => {
  it("prints xcrit0 with the hit payload", () => {
    const attack = d20.plus(5).ac(15).onHit(roll(1, d8)).noCrit();
    expect(attack.toExpression()).toBe("(d20 + 5 AC 15) * (1d8) xcrit0 (1d8)");
  });

  it("the parsed string labels the natural 20 a hit, like the builder", () => {
    const attack = d20.plus(5).ac(15).onHit(roll(1, d8)).noCrit();
    const parsed = parse(attack.toExpression());
    const labels = labelMass(parsed);
    expect(labels.hit).toBeCloseTo(11 / 20, 12);
    expect(labels.missNone).toBeCloseTo(9 / 20, 12);
    expect(labels.crit ?? 0).toBe(0);
    expectSameLabelledPMF(parsed, attack.toPMF(), attack.toExpression());
  });

  it("a crit rider never fires on the parsed string", () => {
    const attack = d20.plus(5).ac(15).onHit(roll(1, d8)).noCrit();
    const fromString = turn([parse(attack.toExpression())]).onAnyCrit(roll(1, d8), { id: "rider" });
    expect(fromString.fireProbability("rider")).toBe(0);
    expect(fromString.pmf.mean()).toBeCloseTo((11 / 20) * 4.5, 12);
  });

  const shapes: [string, () => AttackBuilder][] = [
    ["an expanded crit range", () => d20.plus(5).ac(15).critOn(19).onHit(roll(2, d8)).noCrit()],
    ["every hit crits", () => d20.plus(5).ac(15).alwaysCrits().onHit(roll(2, d8)).noCrit()],
    ["an always-hitting check", () => d20.plus(5).alwaysHits().onHit(roll(2, d8)).noCrit()],
    ["an always-hitting check where every hit crits", () => d20.plus(5).alwaysHits().alwaysCrits().onHit(roll(2, d8)).noCrit()],
    ["a miss payload", () => d20.plus(5).ac(15).onHit(roll(2, d8)).onMiss(roll(1, d8)).noCrit()],
    ["a check with no die", () => flat(15).ac(12).onHit(roll(2, d8)).noCrit()],
  ];
  it.each(shapes)("%s re-parses with the builder's bins and labels", (_name, build) => {
    const attack = build();
    const expression = attack.toExpression();
    expect(expression).toContain(" xcrit0 (");
    expectSameLabelledPMF(parse(expression), attack.toPMF(), expression);
  });

  it("an attack that can crit still prints its crit clause", () => {
    expect(d20.plus(5).ac(15).onHit(roll(1, d8)).toExpression()).toBe("(d20 + 5 AC 15) * (1d8) crit (2d8)");
    expect(d20.plus(5).ac(15).critOn(19).onHit(roll(1, d8)).toExpression()).toBe(
      "(d20 + 5 AC 15) * (1d8) xcrit2 (2d8)"
    );
  });
});

describe("the xcrit0 clause", () => {
  it("never crits, whatever its payload", () => {
    const parsed = parse("(d20 + 5 AC 15) * (1d8) xcrit0 (10d8)");
    expect(parsed.mean()).toBeCloseTo((11 / 20) * 4.5, 12);
    expect(labelMass(parsed).crit ?? 0).toBe(0);
  });

  it("needs no single natural roll, since nothing crits", () => {
    const parsed = parse("(d20 + 1d20 AC 25) * (1d8) xcrit0 (1d8)");
    // d20 + d20 reaches 25 on 136 of its 400 rolls.
    expect(parsed.mean()).toBeCloseTo((136 / 400) * 4.5, 12);
    expect(labelMass(parsed).hit).toBeCloseTo(136 / 400, 12);
    expect(labelMass(parsed).crit ?? 0).toBe(0);
  });

  it("a string with no clause still crits with its hit dice doubled", () => {
    const parsed = parse("(d20 + 5 AC 15) * (1d8)");
    expect(labelMass(parsed).crit).toBeCloseTo(1 / 20, 12);
    expect(parsed.mean()).toBeCloseTo((10 / 20) * 4.5 + (1 / 20) * 9, 12);
  });
});
