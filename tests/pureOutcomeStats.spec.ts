import { describe, expect, it } from "vitest";
import { parse } from "../src/index";
import { DiceQuery } from "../src/query";

function pmf(expr: string) {
  return parse(expr);
}

function createQuery(expr: string): DiceQuery {
  const singlePMF = pmf(expr);
  return new DiceQuery([singlePMF]);
}

describe("combinedDamageStats", () => {
  it("should calculate pure hit stats for single attack", () => {
    const query = createQuery("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
    const stats = query.combinedDamageStats("hit");

    expect(stats.min).toBe(6); // Min hit damage: 2d6+4 = 2+4 = 6
    expect(stats.max).toBe(16); // Max hit damage: 2d6+4 = 12+4 = 16
    expect(stats.avg).toBe(11); // Average hit damage: (6+16)/2 + 1 = 11
    expect(stats.count).toBeCloseTo(0.75, 2); // 75% hit chance at AC 15 with +10
  });

  it("should calculate pure crit stats for single attack", () => {
    const query = createQuery("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
    const stats = query.combinedDamageStats("crit");

    expect(stats.min).toBe(8); // Min crit damage: 4d6+4 = 4+4 = 8
    expect(stats.max).toBe(28); // Max crit damage: 4d6+4 = 24+4 = 28
    expect(stats.avg).toBeCloseTo(18, 1); // Average crit damage
    expect(stats.count).toBeCloseTo(0.05, 2); // 5% crit chance (natural 20)
  });

  it("should scale correctly for two identical attacks", () => {
    const attack = pmf("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
    const twoAttacks = new DiceQuery([attack, attack]);

    const hitStats = twoAttacks.combinedDamageStats("hit");
    expect(hitStats.min).toBe(12); // 6 + 6
    expect(hitStats.max).toBe(32); // 16 + 16
    expect(hitStats.avg).toBe(22); // 11 + 11
    expect(hitStats.count).toBeCloseTo(0.5625, 3); // 0.75 * 0.75

    const critStats = twoAttacks.combinedDamageStats("crit");
    expect(critStats.min).toBe(16); // 8 + 8
    expect(critStats.max).toBe(56); // 28 + 28
    expect(critStats.avg).toBeCloseTo(36, 1); // 18 + 18
    expect(critStats.count).toBeCloseTo(0.0025, 4); // 0.05 * 0.05
  });

  it("should return zeros for impossible outcomes", () => {
    const query = createQuery("(d20 + 10 AC 15) * (2d6 + 4)"); // No crit specified
    const stats = query.combinedDamageStats("crit");

    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.avg).toBe(0);
    expect(stats.count).toBe(0);
  });

  it("should handle three attacks correctly", () => {
    const attack = pmf("(d20 + 10 AC 15) * (2d6 + 4) crit (4d6 + 4)");
    const threeAttacks = new DiceQuery([attack, attack, attack]);

    const hitStats = threeAttacks.combinedDamageStats("hit");
    expect(hitStats.min).toBe(18); // 6 + 6 + 6
    expect(hitStats.max).toBe(48); // 16 + 16 + 16
    expect(hitStats.avg).toBe(33); // 11 + 11 + 11
    expect(hitStats.count).toBeCloseTo(0.421875, 3); // 0.75^3
  });
});
