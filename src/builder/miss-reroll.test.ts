import { describe, expect, it } from "vitest";
import { d12, d20, d4, d8, flat, hd20, type ACBuilder, type AttackBuilder } from "./";
import { missRerollOdds } from "./miss-reroll";
import { parse } from "../parser/parser";
import type { RowContext } from "../turn/types";
import type { MissRerollMode } from "./types";
import { lcgRng } from "../../tests/helpers/lcg";
import { rowOdds, type RowCase } from "../../tests/oracle/missReroll";

const TOLERANCE = 1e-12;

interface Pinned {
  name: string;
  check: () => ACBuilder;
  mode: MissRerollMode;
  /** The row as the oracle reads it. */
  row: RowCase;
  hit: number;
  crit: number;
  rerolledHit: number;
  rerolledCrit: number;
  mean: number;
}

/** A row's hit and crit damage: 1d8, doubled on a crit. */
const attackOf = (check: ACBuilder, mode: MissRerollMode): AttackBuilder => check.rerollMisses(mode).onHit(1, d8);

const bonus1d4 = [{ count: 1, sides: 4, sign: 1 as const }];

const CASES: Pinned[] = [
  {
    name: "A flat +5 +1d4 vs 15, add-d20",
    check: () => d20.plus(5).plus(d4).ac(15),
    mode: "add-d20",
    row: { toHit: 5, toHitDice: bonus1d4, ac: 15, critRange: 20, advantage: "flat" },
    hit: 0.825,
    crit: 0.06625,
    rerolledHit: 0.2,
    rerolledCrit: 0.01625,
    mean: 4.30875,
  },
  {
    name: "C flat +6 vs 15, add-d20",
    check: () => d20.plus(6).ac(15),
    mode: "add-d20",
    row: { toHit: 6, ac: 15, critRange: 20, advantage: "flat" },
    hit: 0.77,
    crit: 0.07,
    rerolledHit: 0.22,
    rerolledCrit: 0.02,
    mean: 4.095,
  },
  {
    name: "D disadvantage +5 +1d4 vs 15, reroll",
    check: () => d20.plus(5).plus(d4).withDisadvantage().ac(15),
    mode: "reroll",
    row: { toHit: 5, toHitDice: bonus1d4, ac: 15, critRange: 20, advantage: "disadvantage", mode: "reroll" },
    hit: 0.744375,
    crit: 0.004125,
    rerolledHit: 0.288125,
    rerolledCrit: 0.001625,
    mean: 3.3868125,
  },
  {
    name: "E disadvantage +5 +1d4 vs 15, add-d20",
    check: () => d20.plus(5).plus(d4).withDisadvantage().ac(15),
    mode: "add-d20",
    row: { toHit: 5, toHitDice: bonus1d4, ac: 15, critRange: 20, advantage: "disadvantage" },
    hit: 0.9021875,
    crit: 0.0604375,
    rerolledHit: 0.4459375,
    rerolledCrit: 0.0579375,
    mean: 4.60378125,
  },
  {
    name: "F advantage +7 +1d4 +1d12 vs 20, add-d20",
    check: () => d20.plus(7).plus(d4).plus(d12).withAdvantage().ac(20),
    mode: "add-d20",
    row: {
      toHit: 7,
      toHitDice: [...bonus1d4, { count: 1, sides: 12, sign: 1 }],
      ac: 20,
      critRange: 20,
      advantage: "advantage",
    },
    hit: 0.88121875,
    crit: 0.100177083333333,
    rerolledHit: 0.032260416666667,
    rerolledCrit: 0.002677083333333,
    mean: 4.867078125,
  },
  {
    name: "G elven accuracy +5 vs 18, crit 19, reroll",
    check: () => d20.plus(5).withElvenAccuracy().ac(18).critOn(19),
    mode: "reroll",
    row: { toHit: 5, ac: 18, critRange: 19, advantage: "elven", mode: "reroll" },
    hit: 0.5778,
    crit: 0.2926,
    rerolledHit: 0.0648,
    rerolledCrit: 0.0216,
    mean: 5.2335,
  },
  {
    name: "H halfling +4 -1d4 vs 14, add-d20",
    check: () => hd20.plus(4).minus(d4).ac(14),
    mode: "add-d20",
    row: {
      toHit: 4,
      toHitDice: [{ count: 1, sides: 4, sign: -1 }],
      ac: 14,
      critRange: 20,
      advantage: "flat",
      rerollOnes: true,
    },
    hit: 0.60834375,
    crit: 0.081571875,
    rerolledHit: 0.21459375,
    rerolledCrit: 0.029071875,
    mean: 3.47169375,
  },
  {
    name: "I flat +6 +1d4 vs 26, crit 19, add-d20",
    check: () => d20.plus(6).plus(d4).ac(26).critOn(19),
    mode: "add-d20",
    row: { toHit: 6, toHitDice: bonus1d4, ac: 26, critRange: 19, advantage: "flat" },
    hit: 0.13375,
    crit: 0.1825,
    rerolledHit: 0.05875,
    rerolledCrit: 0.0825,
    mean: 2.244375,
  },
  {
    name: "A-adv advantage +5 +1d4 vs 15, add-d20",
    check: () => d20.plus(5).plus(d4).withAdvantage().ac(15),
    mode: "add-d20",
    row: { toHit: 5, toHitDice: bonus1d4, ac: 15, critRange: 20, advantage: "advantage" },
    hit: 0.8596875,
    crit: 0.1029375,
    rerolledHit: 0.0659375,
    rerolledCrit: 0.0054375,
    mean: 4.79503125,
  },
  {
    name: "A-elven elven accuracy +5 +1d4 vs 15, add-d20",
    check: () => d20.plus(5).plus(d4).withElvenAccuracy().ac(15),
    mode: "add-d20",
    row: { toHit: 5, toHitDice: bonus1d4, ac: 15, critRange: 20, advantage: "elven" },
    hit: 0.842353125,
    crit: 0.14449375,
    rerolledHit: 0.022353125,
    rerolledCrit: 0.00186875,
    mean: 5.0910328125,
  },
];

const flatContext: RowContext = {
  rollType: "flat",
  autoHit: false,
  critOnHit: false,
  autoFail: false,
  vulnerable: false,
  penaltyDice: [],
  joined: [],
};

const A = (): AttackBuilder => attackOf(d20.plus(5).plus(d4).ac(15), "add-d20");
const B = (): AttackBuilder => d20.plus(5).plus(d4).ac(15).onHit(1, d8);

describe("rerollMisses: pinned odds, each checked against the oracle", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const odds = missRerollOdds(c.check().rerollMisses(c.mode), c.mode);
      expect(odds.hit).toBeCloseTo(c.rerolledHit, 12);
      expect(odds.crit).toBeCloseTo(c.rerolledCrit, 12);
      const oracle = rowOdds(c.row);
      for (const key of ["hit", "crit", "miss", "natural20"] as const) {
        expect(Math.abs(odds[key] - oracle[key])).toBeLessThan(TOLERANCE);
      }

      const attack = attackOf(c.check(), c.mode);
      const { weights } = attack.resolve();
      expect(weights.hit).toBeCloseTo(c.hit, 12);
      expect(weights.crit).toBeCloseTo(c.crit, 12);
      expect(weights.hit + weights.crit + weights.miss).toBeCloseTo(1, 12);
      expect(attack.mean()).toBeCloseTo(c.mean, 12);
    });
  }

  it("B: the same row without rerollMisses", () => {
    const { weights } = B().resolve();
    expect(weights.hit).toBeCloseTo(0.625, 12);
    expect(weights.crit).toBeCloseTo(0.05, 12);
    expect(B().mean()).toBeCloseTo(3.2625, 12);
  });

  it("J: crit on hit, reroll", () => {
    const attack = d20.plus(5).plus(d4).ac(15).rerollMisses("reroll").alwaysCrits().onHit(1, d8);
    const { weights } = attack.resolve();
    expect(weights.hit).toBeCloseTo(0, 12);
    expect(weights.crit).toBeCloseTo(0.89125, 12);
    expect(attack.mean()).toBeCloseTo(8.02125, 12);
    const oracle = rowOdds({ toHit: 5, toHitDice: bonus1d4, ac: 15, critRange: 20, advantage: "flat", autoCrit: true, mode: "reroll" });
    expect(Math.abs(missRerollOdds(attack.check as ACBuilder, "reroll").crit - oracle.crit)).toBeLessThan(TOLERANCE);
    expect(oracle.crit).toBeCloseTo(0.21625, 12);
  });

  it("K: natural-20 damage rides the reroll's own natural 20s", () => {
    const attack = d20.plus(5).ac(15).onHit(1, d8).plusNatural20Damage(flat(5)).rerollMisses("add-d20");
    const { weights } = attack.resolve();
    expect(weights.hit).toBeCloseTo(0.725, 12);
    expect(weights.crit).toBeCloseTo(0.0725, 12);
    expect(attack.mean()).toBeCloseTo(4.2775, 12);
  });
});

describe("rerollMisses: contexts and slices", () => {
  it("under() re-derives the check in a context", () => {
    const advantage = d20.plus(5).plus(d4).withAdvantage().ac(15).rerollMisses("add-d20").onHit(1, d8);
    const under = A().under({ ...flatContext, rollType: "advantage" });
    const expected = advantage.toPMF();
    expect(under.mean()).toBeCloseTo(expected.mean(), 12);
    expect(under.mean()).toBeCloseTo(4.79503125, 12);
    for (const value of expected.support()) expect(under.pAt(value)).toBeCloseTo(expected.pAt(value), 12);
  });

  it("missRerolled: the miss branch once its d20 is rolled again", () => {
    const rerolled = B().missRerolled("add-d20");
    expect(rerolled.mass()).toBeCloseTo(0.325, 12);
    expect(rerolled.filterOutcome("hit").mass()).toBeCloseTo(0.2, 12);
    expect(rerolled.filterOutcome("crit").mass()).toBeCloseTo(0.01625, 12);
    expect(rerolled.filterOutcome("missNone").mass()).toBeCloseTo(0.10875, 12);
    // The landing parts carry the row's own hit payload.
    const hit = rerolled.filterOutcome("hit").normalize();
    const own = B().resolve().hit;
    for (const value of own.support()) expect(Math.abs(hit.pAt(value) - own.pAt(value))).toBeLessThan(TOLERANCE);
  });

  it("missRerolled under disadvantage, reroll mode (case D)", () => {
    const rerolled = d20.plus(5).plus(d4).withDisadvantage().ac(15).onHit(1, d8).missRerolled("reroll");
    expect(rerolled.filterOutcome("hit").mass()).toBeCloseTo(0.288125, 12);
    expect(rerolled.filterOutcome("crit").mass()).toBeCloseTo(0.001625, 12);
  });

  it("missRerolled is empty for an always-hit check", () => {
    expect(d20.plus(5).alwaysHits().onHit(1, d8).missRerolled("add-d20").support()).toHaveLength(0);
  });

  it("missRerolled refuses a check that already rerolls its misses", () => {
    expect(() => A().missRerolled("add-d20")).toThrow(/rerollMisses/);
  });

  it("rerollMisses on an always-hit attack is that attack", () => {
    const always = d20.plus(5).alwaysHits().onHit(1, d8);
    expect(always.rerollMisses()).toBe(always);
  });

  it("rerollMisses refuses a check with no d20", () => {
    expect(() => flat(5).ac(10).rerollMisses()).toThrow(/d20/);
  });

  it("withCheck keeps the reroll", () => {
    const same = A().withCheck((c) => c);
    expect(same.mean()).toBeCloseTo(A().mean(), 12);
    expect(A().withCheck((c) => ({ ...c, ac: 12 })).mean()).toBeGreaterThan(A().mean());
  });

  it("cacheKey tells the modes apart", () => {
    const key = (check: ACBuilder) => check.cacheKey();
    const plain = d20.plus(5).plus(d4).ac(15);
    expect(key(plain.rerollMisses("add-d20"))).not.toBe(key(plain));
    expect(key(plain.rerollMisses("add-d20"))).not.toBe(key(plain.rerollMisses("reroll")));
  });

  it("critOn and copy keep the reroll", () => {
    const check = d20.plus(5).ac(15).rerollMisses("reroll");
    expect(check.copy().attackConfig.missReroll).toBe("reroll");
    expect(check.critOn(19).attackConfig.missReroll).toBe("reroll");
    expect(check.pinned().attackConfig.missReroll).toBe("reroll");
    expect(check.alwaysCrits().attackConfig.missReroll).toBe("reroll");
  });
});

describe("rerollMisses: expression round trip", () => {
  it("C prints one rerolled d20", () => {
    const attack = attackOf(d20.plus(6).ac(15), "add-d20");
    expect(attack.toExpression()).toBe("(d20 reroll d8 + 6 AC 15) * (1d8) crit (2d8)");
  });

  it("A prints one term per bonus outcome", () => {
    expect(A().toExpression()).toBe(
      "(((d20 reroll d8) + 6) & ((d20 reroll d7) + 7) & ((d20 reroll d6) + 8) & ((d20 reroll d5) + 9) AC 15) * (1d8) crit (2d8)"
    );
  });

  it("I prints and parses back exactly", () => {
    const attack = attackOf(d20.plus(6).plus(d4).ac(26).critOn(19), "add-d20");
    expect(attack.toExpression()).toBe(
      "(((d20 reroll d18) + 7) & ((d20 reroll d17) + 8) & ((d20 reroll d16) + 9) & ((d20 reroll d15) + 10) AC 26) * (1d8) xcrit2 (2d8)"
    );
    expect(parse(attack.toExpression()).mean()).toBeCloseTo(attack.mean(), 12);
  });

  it("H prints the halfling die", () => {
    const attack = attackOf(hd20.plus(4).minus(d4).ac(14), "add-d20");
    expect(attack.toExpression()).toBe(
      "((hd20 reroll d13) & ((hd20 reroll d12) + 1) & ((hd20 reroll d11) + 2) & ((hd20 reroll d10) + 3) AC 14) * (1d8) crit (2d8)"
    );
  });

  it("parses back to the same mean (A, C, H, I)", () => {
    for (const [attack, mean] of [
      [A(), 4.30875],
      [attackOf(d20.plus(6).ac(15), "add-d20"), 4.095],
      [attackOf(hd20.plus(4).minus(d4).ac(14), "add-d20"), 3.47169375],
      [attackOf(d20.plus(6).plus(d4).ac(26).critOn(19), "add-d20"), 2.244375],
    ] as const) {
      expect(Math.abs(parse(attack.toExpression()).mean() - attack.mean())).toBeLessThan(TOLERANCE);
      expect(attack.mean()).toBeCloseTo(mean, 12);
    }
  });

  it("refuses a spelling the grammar lacks", () => {
    const rows: AttackBuilder[] = [
      attackOf(d20.plus(5).plus(d4).withDisadvantage().ac(15), "reroll"),
      attackOf(d20.plus(5).plus(d4).withDisadvantage().ac(15), "add-d20"),
      attackOf(d20.plus(7).plus(d4).plus(d12).withAdvantage().ac(20), "add-d20"),
      attackOf(d20.plus(5).withElvenAccuracy().ac(18).critOn(19), "reroll"),
      attackOf(d20.plus(5).plus(d4).withAdvantage().ac(15), "add-d20"),
    ];
    for (const row of rows) expect(() => row.toExpression()).toThrow(/rerollMisses/);
  });

  it("refuses a d20 minimum and a bonus die over 400 outcomes", () => {
    const withMinimum = d20.minimum(5).plus(5).ac(15).rerollMisses("add-d20");
    expect(() => withMinimum.toExpression()).toThrow(/rerollMisses/);
    expect(() => d20.plus(5).plus(1, d12).plus(1, d4).ac(15).rerollMisses().toExpression()).not.toThrow();
    expect(() => d20.plus(5).plus(2, d12).plus(1, d4).ac(15).rerollMisses().toExpression()).toThrow(/rerollMisses/);
  });
});

describe("rerollMisses: sampling", () => {
  it("sample() lands the hit share of the PMF", () => {
    const rng = lcgRng(1);
    const draws = 20_000;
    let hits = 0;
    for (let i = 0; i < draws; i++) if (A().sample(rng).outcome === "hit") hits++;
    expect(Math.abs(hits / draws - 0.825)).toBeLessThan(0.01);
  });

  it("sampleMissReroll lands a sampled miss in the proportions of missRerolled", () => {
    const rng = lcgRng(2);
    const attack = B();
    let misses = 0;
    let hits = 0;
    while (misses < 20_000) {
      const first = attack.sample(rng);
      if (first.outcome !== "miss") continue;
      misses++;
      const again = attack.sampleMissReroll(first, "add-d20", rng);
      if (again.outcome === "hit") hits++;
    }
    expect(Math.abs(hits / misses - 0.2 / 0.325)).toBeLessThan(0.01);
  });
});
