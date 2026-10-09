/**
 * Riders. The oracle families (cappedRiders, alongside, gated, grantFormat's rider
 * shapes) are the acceptance suite; these pin what the library enforces on its own.
 */
import { describe, expect, it } from "vitest";
import { d20, d6, d8, roll, Turn } from "../src/builder";
import type { PMF } from "../src/pmf/pmf";
import type { ContextualSource, RowCheck, RowContext } from "../src/turn/types";

const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
const withD6 = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3).plus(1, d6));
const check: RowCheck = {
  kind: "attack",
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
};

function maxDiff(a: PMF, b: PMF): number {
  let diff = 0;
  for (const value of new Set([...a.support(), ...b.support()])) diff = Math.max(diff, Math.abs(a.pAt(value) - b.pAt(value)));
  return diff;
}

describe("riders: joins", () => {
  it("a joining rider deals nothing beside the row it joins, whatever its damage says; its landing still counts", () => {
    const seen: (readonly string[])[] = [];
    // The row rolls the rider's d6 in its own damage when the rider joins it.
    const row: ContextualSource = {
      rowCheck: check,
      under: (context: RowContext) => (seen.push(context.joined), context.joined.includes("r") ? withD6 : sword).toPMF(),
    };
    // A plain PMF payload that is not zero: the library, not the payload, must keep it off the joined row.
    const payload = roll(1, d6).toPMF();
    const t = Turn.from({
      attacks: [{ id: "a", source: row }],
      riders: [{ id: "r", on: "first-hit", damage: payload, joins: ["a"] }],
    });
    expect(maxDiff(t.pmf, withD6.toPMF())).toBeLessThan(1e-12);
    expect(t.marginal("r").pmf.mean()).toBe(0);
    expect(t.fireProbability("r")).toBeCloseTo(0.7, 12);
    expect(seen.some((joined) => joined.includes("r"))).toBe(true);
  });

  it("on a row it does not join it deals its payload as ever", () => {
    const row: ContextualSource = { rowCheck: check, under: (context) => (context.joined.includes("r") ? withD6 : sword).toPMF() };
    const t = Turn.from({
      attacks: [
        { id: "a", source: row },
        { id: "b", source: sword },
      ],
      riders: [{ id: "r", on: "first-hit", damage: roll(1, d6), joins: ["a"] }],
    });
    // Attack a lands (0.7): the d6 is in a's roll. Otherwise b's hit lands the rider with its own
    // d6, doubled on b's crit.
    expect(Math.abs(t.mean() - (withD6.mean() + sword.mean() + 0.3 * (0.65 * 3.5 + 0.05 * 7)))).toBeLessThan(1e-12);
  });
});

describe("riders: dealing", () => {
  it("every case that needs a damage type dealt reads its mean exactly and refuses its joint", async () => {
    const { FAMILIES } = await import("./oracle/v2/cases/index");
    const { enumerateSyntheticTurn } = await import("./oracle/bruteForce");
    const { TurnSpecError } = await import("../src/turn/types");
    const cases = Object.values(FAMILIES)
      .flat()
      .filter((c) => (c.spec.conditions ?? []).some((condition) => condition.dealing !== undefined));
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases.slice(0, 12)) {
      const t = Turn.from(c.spec);
      let code: string | undefined;
      try {
        void t.pmf;
      } catch (error) {
        code = error instanceof TurnSpecError ? error.code : String(error);
      }
      expect(code, c.name).toBe("dealing-joint-unsupported");
      expect(Math.abs(t.mean() - enumerateSyntheticTurn(c.synthetic).mean), c.name).toBeLessThan(1e-12);
    }
  });
});
