import { beforeEach, describe, expect, it } from "vitest";
import { d20, roll } from "../src/builder";
import { clearAttackCache } from "../src/builder/attack";

/**
 * The resolved-attack PMF cache keyed by the cheap config `cacheKey()` (not the AST-walking
 * `toExpression`). A DPR sweep rebuilds identical attack trees thousands of times; these assert the cache
 * returns the SAME instance for an identical rebuild, forks the key on any DPR-affecting difference, and is
 * byte-identical to the uncached resolution.
 */
describe("AttackBuilder resolved-PMF cache", () => {
  beforeEach(() => clearAttackCache());

  const attack = () => d20.plus(8).ac(16).onHit(roll(1, 8).plus(4));

  it("returns the SAME cached PMF for a freshly rebuilt identical attack", () => {
    const a = attack().toPMF();
    const b = attack().toPMF(); // a distinct builder tree with identical config
    expect(b).toBe(a);
  });

  it("is byte-identical (mean) to the uncached resolve()", () => {
    const cached = attack().toPMF().mean();
    const uncached = attack().resolve().pmf.mean();
    expect(cached).toBeCloseTo(uncached, 12);
  });

  it("forks the key on AC, to-hit, crit range, and damage differences", () => {
    const base = attack().toPMF();
    expect(d20.plus(8).ac(20).onHit(roll(1, 8).plus(4)).toPMF()).not.toBe(base); // AC
    expect(d20.plus(9).ac(16).onHit(roll(1, 8).plus(4)).toPMF()).not.toBe(base); // to-hit
    expect(d20.plus(8).ac(16).critOn(19).onHit(roll(1, 8).plus(4)).toPMF()).not.toBe(base); // crit range
    expect(d20.plus(8).ac(16).onHit(roll(1, 8).plus(5)).toPMF()).not.toBe(base); // damage mod
    expect(d20.plus(8).ac(16).onHit(roll(2, 8).plus(4)).toPMF()).not.toBe(base); // dice count
  });

  it("distinguishes advantage / disadvantage / normal", () => {
    const normal = d20.plus(8).ac(16).onHit(roll(1, 8)).toPMF();
    const adv = d20.withAdvantage().plus(8).ac(16).onHit(roll(1, 8)).toPMF();
    const dis = d20.withDisadvantage().plus(8).ac(16).onHit(roll(1, 8)).toPMF();
    expect(adv).not.toBe(normal);
    expect(dis).not.toBe(normal);
    expect(adv.mean()).toBeGreaterThan(normal.mean());
    expect(dis.mean()).toBeLessThan(normal.mean());
  });

  it("distinguishes noCrit / auto-double-crit / explicit crit", () => {
    const auto = d20.plus(8).ac(16).onHit(roll(1, 8).plus(4)).toPMF();
    const none = d20.plus(8).ac(16).onHit(roll(1, 8).plus(4)).noCrit().toPMF();
    const explicit = d20.plus(8).ac(16).onHit(roll(1, 8).plus(4)).onCrit(roll(3, 8).plus(4)).toPMF();
    expect(none).not.toBe(auto);
    expect(explicit).not.toBe(auto);
    expect(auto.mean()).toBeGreaterThan(none.mean());
  });

  it("forks the key on the miss effect and on eps", () => {
    const base = attack().toPMF();
    expect(attack().onMiss(2).toPMF()).not.toBe(base); // miss damage
    expect(attack().toPMF(0.01)).not.toBe(attack().toPMF(0.01 * 2)); // eps
  });

  it("does NOT cache when an effect opts out (null cacheKey) — half/parsed transforms", () => {
    // HalfRollBuilder and a parsed-string effect both return null cacheKey, forcing the whole attack
    // uncached: two identical rebuilds must be DISTINCT instances (no false cache hit), yet still correct.
    const halfA = d20.plus(8).ac(16).onHit(roll(2, 8).half()).toPMF();
    const halfB = d20.plus(8).ac(16).onHit(roll(2, 8).half()).toPMF();
    expect(halfB).not.toBe(halfA);
    expect(halfB.mean()).toBeCloseTo(halfA.mean(), 12);

    const parsedA = d20.plus(8).ac(16).onHit("1d8+4").toPMF();
    const parsedB = d20.plus(8).ac(16).onHit("1d8+4").toPMF();
    expect(parsedB).not.toBe(parsedA);
    expect(parsedB.mean()).toBeCloseTo(parsedA.mean(), 12);
  });
});
