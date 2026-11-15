import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { d6, d8, d20, roll } from "../src/builder";
import { clearAttackCache } from "../src/builder/attack";
import { bits, dumpTurn, pmfBits, randomCase } from "./helpers/exactDump";

/**
 * The rerolled-miss PMF cache (`AttackBuilder.missRerolled`) must change no bit of any answer. Three checks:
 * a cold cache and a warm one give identical dumps, the dump's hash is the one 0.25.1 (no cache) gave, and rows of
 * equal content share one PMF.
 */
const CASES = 60;
/** sha256 of `dumpTurn` over seeds 1..60, captured on 0.25.1 (382fdeb), before the cache existed. */
const PINNED_0_25_1 = "a8980874d3eb85d0f2da6803adb41bf7225b66b7378a59c2fd769dc4dd0e6f51";

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

  it("matches the hash 0.25.1 produced without the cache", () => {
    const hash = createHash("sha256");
    for (let seed = 1; seed <= CASES; seed++) for (const line of dumpTurn(randomCase(seed).build())) hash.update(`${line}\n`);
    expect(hash.digest("hex")).toBe(PINNED_0_25_1);
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
