import { beforeEach, describe, expect, it } from "vitest";
import { d6, d8, d20, roll } from "../src/builder";
import { clearAttackCache, setMissRerolledCacheEnabled } from "../src/builder/attack";
import { bits, dumpTurn, pmfBits, randomCase } from "./helpers/exactDump";

/**
 * The rerolled-miss PMF cache (`AttackBuilder.missRerolled`) must change no bit of any answer. Three checks:
 * a cold cache and a warm one give identical dumps, the cached path equals the uncached one on the same runtime, and rows
 * of equal content share one PMF. The uncached comparison runs in-process rather than against a pinned hash: V8's Math
 * differs in the last bits between Node majors (0.25.1 itself hashes differently on Node 20/22 and 24).
 */
const CASES = 60;

describe("missRerolled cache is exact", () => {
  beforeEach(() => clearAttackCache());

  it("randomized dpr-shaped turns: cold == warm, Object.is on every probability and mean", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const c = randomCase(seed);
      clearAttackCache();
      const cold = dumpTurn(c.build());
      const warm = dumpTurn(c.build());
      expect(warm, c.name).toEqual(cold);
    }
  });

  it("equals the uncached path bit for bit (what 0.25.1 computed)", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const c = randomCase(seed);
      setMissRerolledCacheEnabled(false);
      let uncached: string[];
      try {
        uncached = dumpTurn(c.build());
      } finally {
        setMissRerolledCacheEnabled(true);
      }
      clearAttackCache();
      dumpTurn(c.build());
      expect(dumpTurn(c.build()), c.name).toEqual(uncached);
    }
  });

  it("the generator exercises a real substitute beside the first-miss rerolls", () => {
    let seen = 0;
    for (let seed = 1; seed <= CASES; seed++) if (randomCase(seed).build().substituteIds.includes("x")) seen++;
    expect(seen).toBeGreaterThan(0);
  });

  it("equal rows share one rerolled PMF; a different mode, AC or eps does not", () => {
    const row = (ac = 15) => d20.plus(7).withAdvantage().ac(ac).critOn(19).onHit(roll(1, d8).plus(4)).plusSeparateDamage(roll(1, d6));
    const first = row().missRerolled("reroll");
    const cold = pmfBits(first);
    expect(row().missRerolled("reroll")).toBe(first);
    expect(row().missRerolled("add-d20")).not.toBe(first);
    expect(row(16).missRerolled("reroll")).not.toBe(first);
    expect(row().missRerolled("reroll", undefined, 1e-12)).not.toBe(first);
    clearAttackCache();
    const fresh = row().missRerolled("reroll");
    expect(fresh).not.toBe(first);
    expect(pmfBits(fresh)).toEqual(cold);
    expect(Object.is(fresh.mean(), first.mean())).toBe(true);
    expect(bits(fresh.mass())).toBe(bits(first.mass()));
  });
});
