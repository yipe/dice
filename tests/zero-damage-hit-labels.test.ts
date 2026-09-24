import { describe, expect, it } from "vitest";
import type { AttackBuilder } from "../src/builder";
import { d20, d4, roll, turn } from "../src/builder";
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

/** The labels of the bin at 0: which outcomes deal no damage, and how often. */
function labelsAtZero(pmf: PMF): Record<string, number> {
  return { ...(pmf.map.get(0)?.count ?? {}) } as Record<string, number>;
}

function expectLabels(actual: Record<string, number>, expected: Record<string, number>, context: string): void {
  const labels = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const label of labels) {
    expect(Math.abs((actual[label] ?? 0) - (expected[label] ?? 0)), `${context}: ${label}`).toBeLessThanOrEqual(1e-12);
  }
}

describe("a landed hit that deals 0 damage is a hit in a parsed attack", () => {
  it("a hit payload that rolls 0 is labelled hit, not missNone", () => {
    // d20 + 5 vs AC 12: hits on 7..19 (13/20), crits on 20; 1d4 - 1 rolls 0 a quarter of the time.
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1)");
    expectLabels(labelMass(parsed), { hit: 13 / 20, crit: 1 / 20, missNone: 6 / 20 }, "totals");
    expectLabels(labelsAtZero(parsed), { hit: 13 / 80, missNone: 6 / 20 }, "bin 0");
  });

  it("matches the builder it was printed from, bin by bin", () => {
    const attack = d20.plus(5).ac(12).onHit(roll(1, d4).minus(1));
    const expression = attack.toExpression();
    expect(expression).toBe("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1)");
    const parsed = parse(expression);
    const built = attack.toPMF();
    for (const value of new Set([...parsed.support(), ...built.support()])) {
      expect(Math.abs(parsed.pAt(value) - built.pAt(value)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
      expectLabels(
        { ...(parsed.map.get(value)?.count ?? {}) } as Record<string, number>,
        { ...(built.map.get(value)?.count ?? {}) } as Record<string, number>,
        `bin ${value}`
      );
    }
  });

  it("a first-hit rider fires on every landed hit of the parsed string", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1)");
    const riders = turn([parsed]).onFirstHit(roll(1, d4), { id: "rider" });
    expect(riders.fireProbability("rider")).toBeCloseTo(14 / 20, 12);
    // The attack's own 1.175, plus the rider's 1d4 on each hit (13/20) and 2d4 on the crit (1/20).
    expect(riders.pmf.mean()).toBeCloseTo(1.175 + (13 / 20) * 2.5 + (1 / 20) * 5, 12);
  });

  it("a crit that rolls 0 stays a crit", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) crit (1d4 - 1)");
    expectLabels(labelMass(parsed), { hit: 13 / 20, crit: 1 / 20, missNone: 6 / 20 }, "totals");
    expectLabels(labelsAtZero(parsed), { hit: 13 / 80, crit: 1 / 80, missNone: 6 / 20 }, "bin 0");
  });

  it("a payload of 0 hits and crits for nothing", () => {
    const parsed = parse("(d20 + 5 AC 12) * (0) crit (0)");
    expectLabels(labelsAtZero(parsed), { hit: 13 / 20, crit: 1 / 20, missNone: 6 / 20 }, "bin 0");
  });

  it("with a miss payload, the 0-damage hits are hits and the misses are missDamage", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1) miss (1d4 - 1)");
    expectLabels(labelMass(parsed), { hit: 13 / 20, crit: 1 / 20, missDamage: 6 / 20 }, "totals");
    expectLabels(labelsAtZero(parsed), { hit: 13 / 80, missDamage: 6 / 80 }, "bin 0");
  });

  it("an attack with no crit clause labels its 0-damage hits too", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1)");
    expectLabels(labelMass(parsed), { hit: 13 / 20, crit: 1 / 20, missNone: 6 / 20 }, "totals");
  });

  it("a trailing hit-only term keeps the 0-damage hits labelled", () => {
    // `+ 3` adds to non-zero totals only, so the 0-damage hits stay at 0 (and stay hits).
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1) + 3");
    expectLabels(labelsAtZero(parsed), { hit: 13 / 80, missNone: 6 / 20 }, "bin 0");
  });

  it("a trailing term that brings a landed hit to 0 keeps it a hit", () => {
    // 1d4 // 4 is 0 on 1..3 and 1 on a 4.
    const parsed = parse("(d20 + 5 AC 12) * (1d4) crit (2d4) // 4");
    expectLabels(labelsAtZero(parsed), { hit: (13 / 20) * (3 / 4), crit: (1 / 20) * (3 / 16), missNone: 6 / 20 }, "bin 0");
  });

  it("a check with no die labels its 0-damage hits", () => {
    const parsed = parse("(15 AC 12) * (1d4 - 1)");
    expectLabels(labelsAtZero(parsed), { hit: 1 / 4 }, "bin 0");
  });

  const printed: [string, () => AttackBuilder][] = [
    ["noCrit()", () => d20.plus(5).ac(12).onHit(roll(1, d4).minus(1)).noCrit()],
    ["an expanded crit range", () => d20.plus(5).ac(12).critOn(18).onHit(roll(1, d4).minus(1))],
    ["advantage", () => d20.withAdvantage().plus(5).ac(12).onHit(roll(1, d4).minus(1))],
  ];
  it.each(printed)("%s re-parses with the builder's labels", (_name, build) => {
    const attack = build();
    expectLabels(labelMass(parse(attack.toExpression())), labelMass(attack.toPMF()), attack.toExpression());
  });
});

describe("outcomes that deal no damage elsewhere keep their labels", () => {
  it("a plain roll that can be 0 still labels its 0 missNone", () => {
    expectLabels(labelsAtZero(parse("1d4 - 1")), { missNone: 1 / 4 }, "bin 0");
  });

  it("a save that fails for 0 damage is saveFail", () => {
    const parsed = parse("(d20 + 3 DC 15) * (1d4 - 1) save half");
    expect(labelsAtZero(parsed).saveFail).toBeGreaterThan(0);
    expect(labelsAtZero(parsed).hit ?? 0).toBe(0);
  });
});
