import { beforeEach, describe, expect, it } from "vitest";
import { d20, roll } from "../src/builder";
import { clearRollCache } from "../src/builder/roll";
import { clearDCCache } from "../src/builder/dc";
import { clearSaveCache } from "../src/builder/save";

/**
 * PMF caches for the non-attack builders, the siblings of the resolved-attack cache in
 * `AttackCache.test.ts`. Same three obligations for each: return the SAME instance for an identical rebuild,
 * fork the key on ANY PMF-affecting difference, and stay byte-identical to the uncached resolution. Plus the
 * one that matters most for correctness — a builder whose PMF is not captured by its `RollConfig`s must
 * refuse to cache rather than risk a wrong hit.
 */
describe("RollBuilder plain-roll PMF cache", () => {
  beforeEach(() => clearRollCache());

  it("returns the SAME cached PMF for a freshly rebuilt identical roll", () => {
    const a = roll(2, 6).plus(3).toPMF();
    const b = roll(2, 6).plus(3).toPMF(); // distinct builder tree, identical configs
    expect(b).toBe(a);
  });

  it("is byte-identical (mean) to an uncached resolution", () => {
    const cached = roll(2, 6).plus(3).toPMF().mean();
    clearRollCache();
    const fresh = roll(2, 6).plus(3).toPMF().mean();
    expect(cached).toBeCloseTo(fresh, 12);
  });

  it("forks the key on dice count, sides, modifier, reroll and minimum", () => {
    const base = roll(2, 6).plus(3).toPMF();
    expect(roll(3, 6).plus(3).toPMF()).not.toBe(base); // count
    expect(roll(2, 8).plus(3).toPMF()).not.toBe(base); // sides
    expect(roll(2, 6).plus(4).toPMF()).not.toBe(base); // modifier
    expect(roll(2, 6).plus(3).reroll(1).toPMF()).not.toBe(base); // reroll
    expect(roll(2, 6).plus(3).minimum(2).toPMF()).not.toBe(base); // minimum
  });

  it("forks the key on eps", () => {
    expect(roll(2, 6).toPMF(0.01)).not.toBe(roll(2, 6).toPMF(0.02));
  });

  it("keeps distinct rolls numerically distinct (no cross-contamination)", () => {
    const small = roll(1, 4).toPMF();
    const big = roll(10, 10).toPMF();
    expect(small.mean()).toBeLessThan(big.mean());
    expect(roll(1, 4).toPMF()).toBe(small); // still the small one after the big one was cached
  });

  it("never serves a WRONG PMF for a builder that opts out of caching (null cacheKey)", () => {
    // `half()` returns a null cacheKey, so this cache refuses it. Note the guarantee being asserted is
    // VALUE correctness, not instance distinctness: HalfRollBuilder overrides `toPMF` and resolves through
    // the AST, which already returns a shared immutable PMF for identical input. Two different half-rolls
    // must therefore still produce two different, correct means — that is what a bad key would break.
    expect(roll(2, 8).half().cacheKey()).toBeNull();
    expect(roll(2, 8).half().toPMF().mean()).toBeCloseTo(4.25, 6); // 2d8 avg 9 → floor-halved
    expect(roll(3, 8).half().toPMF().mean()).toBeCloseTo(6.5, 6); // 3d8 avg 13.5 → floor-halved
    // ...and the plain (cached) sibling is untouched by them.
    expect(roll(2, 8).toPMF().mean()).toBeCloseTo(9, 6);
  });
});

describe("DCBuilder check PMF cache", () => {
  beforeEach(() => clearDCCache());

  const check = () => d20.plus(5).dc(15);

  it("returns the SAME cached PMF for a freshly rebuilt identical check", () => {
    expect(check().toPMF()).toBe(check().toPMF());
  });

  it("is byte-identical to an uncached resolution", () => {
    const cached = check().toPMF().mean();
    clearDCCache();
    expect(check().toPMF().mean()).toBeCloseTo(cached, 12);
  });

  it("forks the key on the DC and on the save modifier", () => {
    const base = check().toPMF();
    expect(d20.plus(5).dc(18).toPMF()).not.toBe(base); // DC
    expect(d20.plus(7).dc(15).toPMF()).not.toBe(base); // modifier
  });

  it("moves failure probability the right way when the DC changes", () => {
    // outcome 1 == failure, so a higher DC must fail more often.
    // The PMF is over outcomes {0 = success, 1 = failure}, so its mean IS P(fail).
    expect(d20.plus(5).dc(20).toPMF().mean()).toBeGreaterThan(d20.plus(5).dc(10).toPMF().mean());
  });

  it("distinguishes advantage and disadvantage on the save", () => {
    const normal = d20.plus(5).dc(15).toPMF();
    const adv = d20.withAdvantage().plus(5).dc(15).toPMF();
    expect(adv).not.toBe(normal);
    // Advantage on the SAVE means the target fails less often (outcome 1 = fail).
    expect(adv.mean()).toBeLessThan(normal.mean());
  });
});

describe("SaveBuilder resolved-save PMF cache", () => {
  beforeEach(() => {
    clearSaveCache();
    clearDCCache();
    clearRollCache();
  });

  const save = () => d20.plus(5).dc(15).onSaveFailure(roll(8, 6));

  it("returns the SAME cached PMF for a freshly rebuilt identical save", () => {
    expect(save().toPMF()).toBe(save().toPMF());
  });

  it("is byte-identical to the uncached resolve()", () => {
    const cached = save().toPMF().mean();
    expect(save().resolve().pmf.mean()).toBeCloseTo(cached, 12);
  });

  it("forks the key on the DC, the failure damage, and save-for-half", () => {
    const base = save().toPMF();
    expect(d20.plus(5).dc(20).onSaveFailure(roll(8, 6)).toPMF()).not.toBe(base); // DC
    expect(d20.plus(5).dc(15).onSaveFailure(roll(9, 6)).toPMF()).not.toBe(base); // damage dice
    expect(save().saveHalf().toPMF()).not.toBe(base); // outcome
  });

  it("save-for-half scores strictly higher than an all-or-nothing save", () => {
    // The distinguishing case for the `saveOutcome` term: same check, same damage, different model.
    const allOrNothing = save().toPMF().mean();
    const half = save().saveHalf().toPMF().mean();
    expect(half).toBeGreaterThan(allOrNothing);
  });

  it("forks the key on eps", () => {
    expect(save().toPMF(0.01)).not.toBe(save().toPMF(0.02));
  });

  it("does NOT cache when the failure effect opts out (parsed / half)", () => {
    const parsedA = d20.plus(5).dc(15).onSaveFailure("8d6").toPMF();
    const parsedB = d20.plus(5).dc(15).onSaveFailure("8d6").toPMF();
    expect(parsedB).not.toBe(parsedA);
    expect(parsedB.mean()).toBeCloseTo(parsedA.mean(), 12);

    const halfA = d20.plus(5).dc(15).onSaveFailure(roll(8, 6).half()).toPMF();
    const halfB = d20.plus(5).dc(15).onSaveFailure(roll(8, 6).half()).toPMF();
    expect(halfB).not.toBe(halfA);
    expect(halfB.mean()).toBeCloseTo(halfA.mean(), 12);
  });
});
