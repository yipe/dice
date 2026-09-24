import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import type { AttackBuilder } from "../src/builder/attack";
import { d4, d6, d8, d20, roll } from "../src/builder/factory";
import { parse } from "../src/parser/parser";
import type { PMF } from "../src/pmf/pmf";

/**
 * An attack's `toExpression()` re-parses to the attack's own outcomes. The grammar has no
 * natural-1 miss or natural-20 hit, so every check here misses on a natural 1 and hits on a natural
 * 20 by its total alone; the two readings then agree bin for bin. Expected distributions are exact
 * enumerations over the natural roll, the bonus dice and the payload, written without the library.
 */

type Dist = Map<number, number>;

function uniform(sides: number): Dist {
  return new Map(Array.from({ length: sides }, (_, i) => [i + 1, 1 / sides] as [number, number]));
}

function combine(a: Dist, b: Dist, op: (x: number, y: number) => number): Dist {
  const out: Dist = new Map();
  for (const [x, px] of a) for (const [y, py] of b) out.set(op(x, y), (out.get(op(x, y)) ?? 0) + px * py);
  return out;
}

const add = (a: Dist, b: Dist) => combine(a, b, (x, y) => x + y);
const best = (a: Dist, b: Dist) => combine(a, b, Math.max);
const sumOf = (count: number, sides: number, flat = 0) =>
  Array.from({ length: count }, () => uniform(sides)).reduce(add, new Map([[flat, 1]]));

type Attack = {
  natural: Dist;
  bonus: Dist;
  ac: number;
  critFrom: number;
  hit: Dist;
  crit: Dist;
  alwaysCrits?: boolean;
  alwaysHits?: boolean;
};

/** Damage outcome by outcome: a hit at or above AC, a crit on a hit whose natural roll is in range. */
function attack({ natural, bonus, ac, critFrom, hit, crit, alwaysCrits, alwaysHits }: Attack): Dist {
  const out: Dist = new Map();
  const mix = (payload: Dist, weight: number) => {
    for (const [v, p] of payload) out.set(v, (out.get(v) ?? 0) + weight * p);
  };
  for (const [n, pn] of natural) {
    for (const [b, pb] of bonus) {
      const lands = alwaysHits || n + b >= ac;
      const crits = lands && (alwaysCrits || n >= critFrom);
      mix(crits ? crit : lands ? hit : new Map([[0, 1]]), pn * pb);
    }
  }
  return out;
}

function expectBins(actual: PMF, expected: Dist, context: string): void {
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `${context}: bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
}

function expectRoundTrip(built: AttackBuilder, expected: Dist, exactMean: number): void {
  const expression = built.toExpression();
  expectBins(built.toPMF(), expected, `builder ${expression}`);
  expectBins(parse(expression), expected, expression);
  expect(parse(expression).mean(), expression).toBeCloseTo(exactMean, 12);
}

const noBonus: Dist = new Map([[0, 1]]);

describe("the crit clause of a printed attack", () => {
  it("noCrit() re-parses without a doubled crit", () => {
    const payload = sumOf(2, 6, 3);
    expectRoundTrip(
      d20.plus(5).ac(15).onHit(roll(2, d6).plus(3)).noCrit(),
      attack({ natural: uniform(20), bonus: new Map([[5, 1]]), ac: 15, critFrom: 21, hit: payload, crit: payload }),
      11 / 2
    );
  });

  it("noCrit() on a keep payload re-parses (the keep has no doubled reading)", () => {
    const expression = d20.plus(5).ac(15).onHit(roll(4, d6).keepHighest(4, 3)).noCrit().toExpression();
    expect(parse(expression).mean()).toBeCloseTo(11 / 20 * (15869 / 1296), 12);
  });

  it("a crit that deals nothing stays nothing, at the attack's crit range", () => {
    const zero: Dist = new Map([[0, 1]]);
    const check = { natural: uniform(20), bonus: new Map([[5, 1]]), ac: 15, hit: sumOf(2, 6), crit: zero };
    expectRoundTrip(d20.plus(5).ac(15).onHit(roll(2, d6)).onCrit(roll.flat(0)), attack({ ...check, critFrom: 20 }), 7 / 2);
    expectRoundTrip(
      d20.plus(5).ac(15).critOn(18).onHit(roll(2, d6)).onCrit(roll.flat(0)),
      attack({ ...check, critFrom: 18 }),
      14 / 5
    );
  });
});

describe("the check of a printed attack", () => {
  it("a negative modifier before a bonus die", () => {
    expectRoundTrip(
      d20.minus(5).plus(roll(1, 8)).ac(6).onHit(d8),
      attack({ natural: uniform(20), bonus: sumOf(1, 8, -5), ac: 6, critFrom: 20, hit: sumOf(1, 8), crit: sumOf(2, 8) }),
      279 / 80
    );
  });

  it("a bonus die rolled with advantage", () => {
    expectRoundTrip(
      d20.plus(5).plus(d4.withAdvantage()).ac(15).onHit(d8),
      attack({
        natural: uniform(20),
        bonus: add(new Map([[5, 1]]), best(uniform(4), uniform(4))),
        ac: 15,
        critFrom: 20,
        hit: sumOf(1, 8),
        crit: sumOf(2, 8),
      }),
      1089 / 320
    );
  });

  it("three-dice advantage rolls three d20s", () => {
    const threeDice = best(best(uniform(20), uniform(20)), uniform(20));
    const built = d20.withAdvantage().plus(5).ac(15).threeDiceAdvantage().onHit(d8);
    const expected = attack({ natural: threeDice, bonus: new Map([[5, 1]]), ac: 15, critFrom: 20, hit: sumOf(1, 8), crit: sumOf(2, 8) });
    expectRoundTrip(built, expected, 18927 / 4000);
  });

  it("alwaysCrits() keeps the AC and crits on every hit", () => {
    expectRoundTrip(
      d20.plus(5).ac(10).alwaysCrits().onHit(d8),
      attack({ natural: uniform(20), bonus: new Map([[5, 1]]), ac: 10, critFrom: 21, hit: sumOf(1, 8), crit: sumOf(2, 8), alwaysCrits: true }),
      36 / 5
    );
  });

  it("alwaysHits() hits even where its total is 0", () => {
    const hit = sumOf(1, 8);
    const crit = sumOf(2, 8);
    const check = { natural: uniform(20), bonus: noBonus, ac: 0, hit, crit, alwaysHits: true };
    expectRoundTrip(d20.minus(5).alwaysHits().onHit(d8), attack({ ...check, critFrom: 20 }), 189 / 40);
    expectRoundTrip(d20.minus(5).alwaysHits().critOn(18).onHit(d8), attack({ ...check, critFrom: 18 }), 207 / 40);
    expectRoundTrip(
      d20.minus(5).alwaysHits().alwaysCrits().onHit(d8),
      attack({ ...check, critFrom: 1, alwaysCrits: true }),
      9
    );
  });
});
