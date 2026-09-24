import { describe, expect, it } from "vitest";
import { d20, d4, d6, roll } from "../src/builder";
import { parse } from "../src/index";
import type { Dist } from "./enumerate-dice";
import { add, attack, expectLabelled, expectSameLabelled, map, point, repeat, uniform } from "./enumerate-dice";

/**
 * A term joined by `+` after an attack's payload is part of the payload: it is added to every
 * landed outcome, hit or crit, one whose payload rolled 0 included, and never to a miss (a
 * `miss (…)` clause's damage takes it like any payload). The oracle is enumerated under parse()'s
 * rules: the check lands where its total meets the AC, and crits on a natural 20 (or its `xcrit`
 * range) when it lands.
 */

const D20 = uniform(20);
const D4 = uniform(4);
const D6 = uniform(6);
const plus = (...parts: (Dist | number)[]): Dist => add(...parts.map((part) => (typeof part === "number" ? point(part) : part)));
const onD20Plus5 = (target: number, hit: Dist, crit: Dist, critFrom = 20) =>
  attack({ natural: D20, bonus: point(5), target, critFrom, hit, crit });

describe("a trailing `+` adds to every landed outcome of an attack", () => {
  it("(d20 + 5 AC 12) * (1d4 - 1) + 1d6 adds the 1d6 to a hit whose payload rolled 0, like the builder", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) + 1d6");
    // The crit doubles every die of the whole payload: 2d4 - 1 + 2d6.
    expectLabelled(parsed, onD20Plus5(12, plus(D4, -1, D6), plus(repeat(D4, 2), -1, repeat(D6, 2))));
    expectSameLabelled(parsed, d20.plus(5).ac(12).onHit(roll(1, d4).minus(1).plus(d6)).toPMF());
    expect(parsed.mean()).toBeCloseTo(3.8, 12);
  });

  it("a trailing flat is added once, on hits and crits alike", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) + 3");
    expectLabelled(parsed, onD20Plus5(12, plus(D4, 2), plus(repeat(D4, 2), 2)));
    expectSameLabelled(parsed, d20.plus(5).ac(12).onHit(roll(1, d4).minus(1).plus(3)).toPMF());
  });

  it("each of several trailing terms adds, even where the running payload is 0", () => {
    // 1d2 - 1 is 0 half the time: the payload is 0 until the 1d6.
    const coin = plus(uniform(2), -1);
    const parsed = parse("(d20 + 5 AC 12) * (1d2 - 1) + (1d2 - 1) + 1d6");
    const doubledCoin = plus(repeat(uniform(2), 2), -1);
    expectLabelled(parsed, onD20Plus5(12, plus(coin, coin, D6), plus(doubledCoin, doubledCoin, repeat(D6, 2))));
  });

  it("after a crit clause the term is added to the crit as written, a crit of 0 included", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) crit (1d4 - 1) + 1d6");
    expectLabelled(parsed, onD20Plus5(12, plus(D4, -1, D6), plus(D4, -1, D6)));
    const built = d20.plus(5).ac(12).onHit(roll(1, d4).minus(1).plus(d6)).onCrit(roll(1, d4).minus(1).plus(d6));
    expectSameLabelled(parsed, built.toPMF());
  });

  it("after xcrit0 every landing is a hit that takes the term", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4 - 1) xcrit0 (1d4 - 1) + 1d6");
    expectLabelled(parsed, onD20Plus5(12, plus(D4, -1, D6), point(0), 21));
    expectSameLabelled(parsed, d20.plus(5).ac(12).onHit(roll(1, d4).minus(1).plus(d6)).noCrit().toPMF());
  });

  it("a `// 2` payload that rounds to 0 still takes the term", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d4) // 2 + 1d6");
    const halve = (dist: Dist) => map(dist, (value) => Math.floor(value / 2));
    expectLabelled(parsed, onD20Plus5(12, plus(halve(D4), D6), plus(halve(repeat(D4, 2)), repeat(D6, 2))));
  });

  it("a miss stays 0, and a miss clause's damage takes the term, a miss of 0 included", () => {
    const parsed = parse("(d20 + 5 AC 12) * (1d6) miss (1d4 - 1) + 3");
    const spec = { natural: D20, bonus: point(5), target: 12, critFrom: 20, hit: plus(D6, 3), crit: plus(repeat(D6, 2), 3), miss: plus(D4, 2) };
    expectLabelled(parsed, attack(spec));
    expectSameLabelled(parsed, d20.plus(5).ac(12).onHit(roll(1, d6).plus(3)).onMiss(roll(1, d4).minus(1).plus(3)).toPMF());
  });

  it("a check that lands at a total of 0 takes the term on its 0-damage hits too", () => {
    const parsed = parse("(d20 - 5 AC 0) * (1d4 - 1) + 1d6");
    const spec = { natural: D20, bonus: point(-5), target: 0, critFrom: 20, hit: plus(D4, -1, D6), crit: plus(repeat(D4, 2), -1, repeat(D6, 2)) };
    expectLabelled(parsed, attack(spec));
    expectSameLabelled(parsed, d20.minus(5).ac(0).onHit(roll(1, d4).minus(1).plus(d6)).toPMF());
  });
});

describe("a trailing `+` adds to every other outcome that carries a payload, one that rolled 0 included", () => {
  /** A parsed PMF's bins as { value: { label: p } }, labels rounded to 1e-12. */
  const bins = (expr: string): Record<number, Record<string, number>> => {
    const pmf = parse(expr);
    const out: Record<number, Record<string, number>> = {};
    for (const v of pmf.support()) {
      const count = (pmf.map.get(v)?.count ?? {}) as Record<string, number>;
      out[v] = Object.fromEntries(Object.entries(count).map(([k, p]) => [k, Math.round(p * 1e12) / 1e12]));
    }
    return out;
  };

  it("a potent-cantrip half that rounds to 0 takes the term", () => {
    // +5 vs AC 15 lands on 10..20: hit 1/2, crit 1/20, miss 9/20 dealing half of the pc (1), i.e. 0.
    expect(bins("(d20 + 5 AC 15) * (1d2) pc (1) + 3")).toEqual({
      3: { pc: 0.45 },
      4: { hit: 0.25 },
      5: { hit: 0.25, crit: 0.0125 },
      6: { crit: 0.025 },
      7: { crit: 0.0125 },
    });
  });

  it("a failed save whose payload rolled 0 takes the term, like onSaveFailure(x.plus(3)); a success stays 0", () => {
    // d20 vs DC 15 fails on 1..14 (7/10); 1d2 - 1 is 0 or 1.
    expect(bins("(d20 DC 15) * (1d2 - 1) + 3")).toEqual({
      0: { missNone: 0.3 },
      3: { saveFail: 0.35 },
      4: { saveFail: 0.35 },
    });
    expect(parse("(d20 DC 15) * (1d2 - 1) + 3").mean()).toBeCloseTo(0.7 * 3.5, 12);
  });

  it("a halved save that rounds to 0 takes the term like every other halved result", () => {
    // Success 3/10 halves 1d2 to 0 or 1; failure 7/10 deals 1d2.
    expect(bins("(d20 DC 15) * (1d2) save half + 3")).toEqual({
      3: { saveHalf: 0.15 },
      4: { saveHalf: 0.15, saveFail: 0.35 },
      5: { saveFail: 0.35 },
    });
  });
});
