import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ACBuilder } from "../src/builder";
import {
  d20,
  d4,
  d6,
  d8,
  d10,
  keepBestDamage,
  RollBuilder,
  RerollUpToRollBuilder,
  roll,
  turn,
} from "../src/builder";
import { PMF } from "../src/pmf/pmf";
import { expectDist, mean, type Dist } from "./enumerate-dice";
import { bruteForceRerollUpTo, ruleDie, type OracleDie } from "./enumerate-reroll";

/**
 * `rerollUpTo(k)`: see every die, reroll up to k of them for the most expected damage, keep the
 * new rolls. Every distribution is checked against `enumerate-reroll.ts`, which lists every roll
 * and tries every subset of dice to reroll.
 */

interface Group {
  count: number;
  sides: number;
  minimum?: number;
  reroll?: number;
  minus?: boolean;
}

function pool(groups: readonly Group[], flat = 0): RollBuilder {
  const built = RollBuilder.fromConfigs(
    groups.map((g) => ({
      count: g.count,
      sides: g.sides,
      minimum: g.minimum ?? 0,
      reroll: g.reroll ?? 0,
      isSubtraction: g.minus === true,
    }))
  );
  return flat === 0 ? built : built.plus(flat);
}

function oracleDice(groups: readonly Group[]): OracleDie[] {
  return groups.flatMap((g) =>
    Array.from({ length: g.count }, () => ruleDie(g.sides, { minimum: g.minimum, reroll: g.reroll, negate: g.minus }))
  );
}

function distOf(pmf: PMF): Dist {
  return new Map(pmf.support().map((value) => [value, pmf.pAt(value)]));
}

function shifted(dist: Dist, by: number): Dist {
  return new Map([...dist].map(([value, p]) => [value + by, p]));
}

/** The distribution of a single roll of `sides`, `minimum` and `reroll`, as an oracle die. */
function singleDie(sides: number, options: { minimum?: number; reroll?: number } = {}): Dist {
  return ruleDie(sides, options).faces;
}

describe("rerollUpTo: oracle", () => {
  it("2d6 with one reroll has mean 8.2361, above the best-of-two-on-the-first-die 7.9722", () => {
    const reroll = roll(2, d6).rerollUpTo(1).toPMF();
    // The lower die is rerolled when it shows 3 or less: mean = E[max] + E[max(min, 3.5)].
    expect(reroll.mean()).toBeCloseTo((161 + 135.5) / 36, 12);
    expect(reroll.mean()).toBeCloseTo(8.2361, 4);
    expectDist(reroll, bruteForceRerollUpTo(oracleDice([{ count: 2, sides: 6 }]), 1));
    // The first die's best of two, plus the second die untouched, is a weaker guess.
    expect(roll(1, d6).maxOf(2).plus(d6).toPMF().mean()).toBeCloseTo(7.9722, 4);
  });

  const singleGroup: Group[][] = [
    [{ count: 3, sides: 6 }],
    [{ count: 4, sides: 4 }],
    [{ count: 3, sides: 8 }],
    [{ count: 3, sides: 6, minimum: 3 }],
    [{ count: 3, sides: 6, reroll: 2 }],
    [{ count: 3, sides: 8, reroll: 1, minimum: 3 }],
    // A d5 face of 3 sits exactly on the mean: rerolling it gains nothing, so it stays.
    [{ count: 3, sides: 5 }],
  ];
  for (const groups of singleGroup) {
    for (const budget of [0, 1, 2, 3, 5]) {
      it(`${JSON.stringify(groups)} with a budget of ${budget}`, () => {
        expectDist(pool(groups).rerollUpTo(budget).toPMF(), bruteForceRerollUpTo(oracleDice(groups), budget));
      });
    }
  }

  const mixed: Group[][] = [
    [
      { count: 2, sides: 6 },
      { count: 1, sides: 8 },
    ],
    [
      { count: 1, sides: 8 },
      { count: 2, sides: 6 },
    ],
    [
      { count: 1, sides: 6 },
      { count: 1, sides: 8 },
    ],
    [
      { count: 2, sides: 4 },
      { count: 1, sides: 6 },
      { count: 1, sides: 10 },
    ],
    [
      { count: 2, sides: 6, minimum: 2 },
      { count: 2, sides: 8, reroll: 1 },
    ],
    [
      { count: 1, sides: 6 },
      { count: 1, sides: 8 },
      { count: 1, sides: 6 },
    ],
    [
      { count: 3, sides: 6 },
      { count: 1, sides: 8, minus: true },
    ],
    [
      { count: 2, sides: 6, minus: true },
      { count: 2, sides: 4, minus: true },
      { count: 1, sides: 8 },
    ],
  ];
  for (const groups of mixed) {
    for (const budget of [1, 2, 3]) {
      it(`mixed dice ${JSON.stringify(groups)} with a budget of ${budget}`, () => {
        expectDist(pool(groups).rerollUpTo(budget).toPMF(), bruteForceRerollUpTo(oracleDice(groups), budget));
      });
    }
  }

  it("does not depend on the order the dice were added in, even where gains tie across kinds", () => {
    // A d6 showing 1 and a d8 showing 2 both gain 2.5 from a reroll: one budget, two choices.
    const dieThenD8 = roll(1, d6).plus(roll(1, d8)).rerollUpTo(1).toPMF();
    const d8ThenDie = roll(1, d8).plus(roll(1, d6)).rerollUpTo(1).toPMF();
    expectDist(dieThenD8, distOf(d8ThenDie));
    expectDist(
      dieThenD8,
      bruteForceRerollUpTo(oracleDice([{ count: 1, sides: 6 }, { count: 1, sides: 8 }]), 1)
    );
  });

  it("keeps a flat outside the pool", () => {
    const groups: Group[] = [{ count: 2, sides: 6 }];
    expectDist(pool(groups, 5).rerollUpTo(1).toPMF(), shifted(bruteForceRerollUpTo(oracleDice(groups), 1), 5));
  });

  it("a subtracted die is rerolled when it shows high", () => {
    // 1d6 - 1d6 with one reroll: the subtracted die is the one worth rerolling on a 4+.
    const groups: Group[] = [
      { count: 1, sides: 6 },
      { count: 1, sides: 6, minus: true },
    ];
    const reroll = pool(groups).rerollUpTo(1).toPMF();
    expectDist(reroll, bruteForceRerollUpTo(oracleDice(groups), 1));
    expect(reroll.mean()).toBeGreaterThan(0);
  });
});

describe("rerollUpTo: a budget covering every die is the per-die must-use reroll", () => {
  // Each die shows X; when X is below its mean it is replaced by a fresh roll, otherwise it stays.
  function perDie(faces: Dist): Dist {
    const dieMean = mean(faces);
    let below = 0;
    for (const [value, p] of faces) if (value < dieMean) below += p;
    return new Map([...faces].map(([value, p]) => [value, (value < dieMean ? 0 : p) + below * p]));
  }
  function total(faces: Dist, dice: number): Dist {
    let dist: Dist = new Map([[0, 1]]);
    for (let i = 0; i < dice; i++) {
      const next: Dist = new Map();
      for (const [a, pa] of dist) for (const [b, pb] of faces) next.set(a + b, (next.get(a + b) ?? 0) + pa * pb);
      dist = next;
    }
    return dist;
  }

  for (const [sides, options, dice] of [
    [6, {}, 4],
    [8, {}, 3],
    [20, {}, 3],
    [6, { minimum: 3 }, 4],
    [6, { reroll: 1 }, 4],
    [8, { reroll: 2, minimum: 3 }, 3],
  ] as const) {
    it(`${dice}d${sides} ${JSON.stringify(options)}`, () => {
      const groups: Group[] = [{ count: dice, sides, ...options }];
      expectDist(pool(groups).rerollUpTo(dice).toPMF(), total(perDie(singleDie(sides, options)), dice));
      expectDist(pool(groups).rerollUpTo(dice + 4).toPMF(), total(perDie(singleDie(sides, options)), dice));
    });
  }

  it("is reroll(f) on each die, f the faces below its mean", () => {
    expectDist(roll(4, d6).rerollUpTo(4).toPMF(), distOf(roll(4, d6).reroll(3).toPMF()));
    expectDist(roll(3, d8).rerollUpTo(3).toPMF(), distOf(roll(3, d8).reroll(4).toPMF()));
    expectDist(
      roll(3, d6).minimum(3).rerollUpTo(3).toPMF(),
      distOf(roll(3, d6).minimum(3).reroll(3).toPMF())
    );
  });

  it("a budget of 0 is the plain roll", () => {
    expectDist(
      roll(3, d6).plus(2).rerollUpTo(0).toPMF(),
      distOf(roll(3, d6).plus(2).toPMF())
    );
  });
});

describe("rerollUpTo: best of several rolls, then rerolled", () => {
  const cases: [Group[], number, number][] = [
    [[{ count: 2, sides: 6 }], 1, 2],
    [[{ count: 3, sides: 4 }], 1, 2],
    [[{ count: 3, sides: 4 }], 2, 2],
    [[{ count: 2, sides: 6 }], 1, 3],
    [
      [
        { count: 1, sides: 6 },
        { count: 1, sides: 8 },
      ],
      1,
      2,
    ],
    [
      [
        { count: 2, sides: 4 },
        { count: 1, sides: 6 },
      ],
      2,
      2,
    ],
    [
      [
        { count: 2, sides: 4, minimum: 2 },
        { count: 1, sides: 6, minus: true },
      ],
      1,
      2,
    ],
    [[{ count: 3, sides: 6 }], 0, 2],
    // Three d6 with two rerolls: (4, 4, 4) and (1, 1, 5) are both worth 12 after their rerolls, and
    // the two rolls are equally worth keeping, yet finish differently.
    [[{ count: 3, sides: 6 }], 2, 2],
  ];
  for (const [groups, budget, rolls] of cases) {
    it(`${JSON.stringify(groups)}, budget ${budget}, best of ${rolls} rolls`, () => {
      expectDist(
        pool(groups).rerollUpTo(budget, { rolls }).toPMF(),
        bruteForceRerollUpTo(oracleDice(groups), budget, rolls)
      );
    });
  }

  it("with no reroll budget it is the best of the rolls by total", () => {
    expectDist(
      roll(3, d6).rerollUpTo(0, { rolls: 2 }).toPMF(),
      distOf(roll(3, d6).maxOf(2).toPMF())
    );
  });

  it("one roll is the plain reroll pool", () => {
    expectDist(
      roll(2, d6).rerollUpTo(1, { rolls: 1 }).toPMF(),
      distOf(roll(2, d6).rerollUpTo(1).toPMF())
    );
  });

  it("is worth more than one roll and no more than rerolling every roll then keeping the best", () => {
    const one = roll(2, d6).plus(3).rerollUpTo(1).toPMF().mean();
    const composed = roll(2, d6).plus(3).rerollUpTo(1, { rolls: 2 }).toPMF().mean();
    const rerollBoth = roll(2, d6).plus(3).rerollUpTo(1).maxOf(2).toPMF().mean();
    expect(composed).toBeGreaterThan(one + 0.1);
    expect(rerollBoth).toBeGreaterThan(composed + 0.01);
  });

  it("the roll is chosen before the reroll, by its expected total after the reroll", () => {
    // 1d8: a roll of 3 is worth 4.5 after its reroll and so is a 4; a 5 beats both. The choice is
    // by that worth, not by the face shown.
    const reroll = roll(1, d8).rerollUpTo(1, { rolls: 2 }).toPMF();
    expectDist(reroll, bruteForceRerollUpTo(oracleDice([{ count: 1, sides: 8 }]), 1, 2));
  });
});

describe("rerollUpTo: builder", () => {
  it("doubles the dice on a crit and keeps the budget", () => {
    const doubled = roll(2, d6).plus(3).rerollUpTo(1).doubleDice();
    expect(doubled).toBeInstanceOf(RerollUpToRollBuilder);
    expectDist(
      doubled.toPMF(),
      shifted(bruteForceRerollUpTo(oracleDice([{ count: 4, sides: 6 }]), 1), 3)
    );
    expectDist(
      roll(1, d6).rerollUpTo(1, { rolls: 2 }).scaleDice(2).toPMF(),
      bruteForceRerollUpTo(oracleDice([{ count: 2, sides: 6 }]), 1, 2)
    );
  });

  it("adds a roll outside the pool", () => {
    const together = roll(2, d6).rerollUpTo(1).plus(roll(1, d8)).toPMF();
    const apart = roll(2, d6).rerollUpTo(1).toPMF().convolve(roll(1, d8).toPMF());
    expectDist(together, distOf(apart));
    expect(together.mean()).toBeCloseTo(roll(2, d6).rerollUpTo(1).toPMF().mean() + 4.5, 12);
  });

  it("copies of a pool are independent pools", () => {
    const twice = roll(2, d4.rerollUpTo(1)).toPMF();
    const once = d4.rerollUpTo(1).toPMF();
    expectDist(twice, distOf(once.convolve(once)));
  });

  it("copy() keeps the pool", () => {
    const pooled = roll(2, d6).rerollUpTo(1, { rolls: 2 });
    expectDist(pooled.copy().toPMF(), distOf(pooled.toPMF()));
  });

  it("refuses a budget or roll count that is not a whole number", () => {
    expect(() => roll(2, d6).rerollUpTo(-1)).toThrow(/non-negative integer/);
    expect(() => roll(2, d6).rerollUpTo(1.5)).toThrow(/non-negative integer/);
    expect(() => roll(2, d6).rerollUpTo(NaN)).toThrow(/NaN/);
    expect(() => roll(2, d6).rerollUpTo(Infinity)).toThrow(/finite/);
    expect(() => roll(2, d6).rerollUpTo(1, { rolls: 0 })).toThrow(/positive integer/);
    expect(() => roll(2, d6).rerollUpTo(1, { rolls: 1.5 })).toThrow(/positive integer/);
  });

  it("refuses dice a reroll has no single meaning for", () => {
    expect(() => roll(2, d6).explode(1).rerollUpTo(1)).toThrow(/exploding/);
    expect(() => roll(2, d6).explodePool(1).rerollUpTo(1)).toThrow(/exploding/);
    expect(() => roll(4, d6).keepHighest(4, 3).rerollUpTo(1)).toThrow(/keep/);
    expect(() => roll(4, d6).bestOf(3).rerollUpTo(1)).toThrow(/keep/);
    expect(() => roll(2, d6).withAdvantage().rerollUpTo(1)).toThrow(/advantage/);
    expect(() => roll(2, d6).keepHighest(2, 1).rerollUpTo(1)).toThrow(/keep/);
  });

  it("refuses a roll that is already transformed, pooled or parsed", () => {
    expect(() => roll(2, d6).half().rerollUpTo(1)).toThrow(/Cannot rerollUpTo/);
    expect(() => roll(2, d6).maxOf(2).rerollUpTo(1)).toThrow(/Cannot rerollUpTo/);
    expect(() => roll(2, d6).keepHighestAll(2, 1).rerollUpTo(1)).toThrow(/Cannot rerollUpTo/);
    expect(() => RollBuilder.fromArgs("2d6+3").rerollUpTo(1)).toThrow(/Cannot rerollUpTo/);
    expect(() => roll(2, d6).rerollUpTo(1).rerollUpTo(1)).toThrow(/already has a rerollUpTo\(\) pool/);
    expect(() => roll(2, d6).rerollUpTo(1).reroll(1)).toThrow(/Cannot change the dice/);
  });

  it("has no string spelling", () => {
    expect(() => roll(2, d6).rerollUpTo(1).toExpression()).toThrow(/rerollUpTo/);
  });
});

describe("rerollDamageUpTo: attack base payload", () => {
  const attack = (): ACBuilder => d20.plus(5).ac(15);
  const dice = (count: number, sides: number): OracleDie[] => oracleDice([{ count, sides }]);

  it("rerolls the hit's dice, and a crit's doubled dice with the same budget", () => {
    const resolved = attack().onHit(roll(2, d6).plus(3)).rerollDamageUpTo(1).resolve();
    expectDist(resolved.hitBase, shifted(bruteForceRerollUpTo(dice(2, 6), 1), 3));
    expectDist(resolved.critBase, shifted(bruteForceRerollUpTo(dice(4, 6), 1), 3));
  });

  it("with rolls: 2 it is Savage Attacker's best of two with a reroll budget, on the hit and the crit", () => {
    const resolved = attack().onHit(roll(2, d6).plus(3)).rerollDamageUpTo(1, { rolls: 2 }).resolve();
    expectDist(resolved.hitBase, shifted(bruteForceRerollUpTo(dice(2, 6), 1, 2), 3));
    expectDist(resolved.critBase, shifted(bruteForceRerollUpTo(dice(4, 6), 1, 2), 3));
  });

  it("a pool given as the payload doubles its dice on a crit like the attack verb", () => {
    const viaPayload = attack().onHit(roll(2, d6).plus(3).rerollUpTo(1, { rolls: 2 })).resolve();
    const viaVerb = attack().onHit(roll(2, d6).plus(3)).rerollDamageUpTo(1, { rolls: 2 }).resolve();
    expectDist(viaPayload.hitBase, distOf(viaVerb.hitBase));
    expectDist(viaPayload.critBase, distOf(viaVerb.critBase));
    expect(() => attack().onHit(roll(2, d6).rerollUpTo(1)).rerollDamageUpTo(1)).toThrow(/requires a dice descriptor/);
  });

  it("does not depend on whether onCrit, noCrit, plusSeparateDamage, rerollDamage or minimumDamageDie comes first", () => {
    const first = attack().onHit(3, d6).rerollDamageUpTo(1).onCrit(3, d8).minimumDamageDie(2).rerollDamage(1);
    const last = attack().onHit(3, d6).minimumDamageDie(2).rerollDamage(1).onCrit(3, d8).rerollDamageUpTo(1);
    const a = first.resolve();
    const b = last.resolve();
    expectDist(a.hitBase, distOf(b.hitBase));
    expectDist(a.critBase, distOf(b.critBase));
    // The explicit crit rerolls too, the floor and the low-face reroll included.
    expectDist(a.critBase, bruteForceRerollUpTo(oracleDice([{ count: 3, sides: 8, minimum: 2, reroll: 1 }]), 1));
    expectDist(a.hitBase, bruteForceRerollUpTo(oracleDice([{ count: 3, sides: 6, minimum: 2, reroll: 1 }]), 1));
  });

  it("leaves separate damage channels alone", () => {
    const resolved = attack().onHit(2, d6).plusSeparateDamage(roll(2, d4)).rerollDamageUpTo(1).resolve();
    expectDist(resolved.hitBase, bruteForceRerollUpTo(dice(2, 6), 1));
    expectDist(resolved.hitSeparate, bruteForceRerollUpTo(oracleDice([{ count: 2, sides: 4 }]), 0));
    expectDist(resolved.critSeparate, bruteForceRerollUpTo(oracleDice([{ count: 4, sides: 4 }]), 0));
    const together = bruteForceRerollUpTo(dice(2, 6), 1);
    expect(resolved.hit.mean()).toBeCloseTo(mean(together) + 5, 12);
  });

  it("noCrit keeps its hit reroll, and a repeat is a no-op while a different budget throws", () => {
    const noCrit = attack().onHit(2, d6).noCrit().rerollDamageUpTo(1);
    expectDist(noCrit.resolve().hitBase, bruteForceRerollUpTo(dice(2, 6), 1));
    const once = attack().onHit(2, d6).rerollDamageUpTo(1);
    expect(once.rerollDamageUpTo(1)).toBe(once);
    expect(() => once.rerollDamageUpTo(2)).toThrow(/Conflicting rerollDamageUpTo/);
    expect(() => once.rerollDamageUpTo(1, { rolls: 2 })).toThrow(/Conflicting rerollDamageUpTo/);
  });

  it("changes the attack's PMF, and two budgets do not share a cached attack", () => {
    const plain = attack().onHit(2, d6);
    const one = plain.rerollDamageUpTo(1);
    const two = plain.rerollDamageUpTo(2);
    expect(one.toPMF().mean()).toBeGreaterThan(plain.toPMF().mean());
    expect(two.toPMF().mean()).toBeGreaterThan(one.toPMF().mean());
    expect(plain.toPMF().mean()).toBeCloseTo(attack().onHit(2, d6).toPMF().mean(), 15);
  });

  it("refuses a payload with no plain dice at the call, and a crit payload set later", () => {
    expect(() => attack().onHit("2d6+3").rerollDamageUpTo(1)).toThrow(/requires a dice descriptor/);
    expect(() => attack().onHit(roll(2, d6).half()).rerollDamageUpTo(1)).toThrow(/requires a dice descriptor/);
    expect(() => attack().onHit(2, d6).rerollDamageUpTo(1).onCrit("4d6")).toThrow(/requires a dice descriptor/);
    expect(() => attack().onHit(roll(4, d6).keepHighest(4, 3)).rerollDamageUpTo(1)).toThrow(/rerollDamageUpTo\(\) rerolls plain dice.*keep/);
    expect(() => attack().onHit(2, d6).noCrit().rerollDamageUpTo(1).onCrit(roll(2, d6).explode(1))).toThrow(/exploding/);
    expect(() => attack().onHit(2, d6).rerollDamageUpTo(-1)).toThrow(/non-negative integer/);
  });

  it("has no string spelling and no dice-match descriptor", () => {
    const rerolled = attack().onHit(3, d6).rerollDamageUpTo(1);
    expect(() => rerolled.toExpression()).toThrow(/rerollDamageUpTo/);
    expect(rerolled.diceMatchInfo()).toEqual({ hit: null, crit: null });
    expect(attack().onHit(3, d6).diceMatchInfo().hit).not.toBeNull();
  });

  it("runs through a Turn", () => {
    const rerolled = attack().onHit(2, d6).rerollDamageUpTo(1);
    expect(turn([rerolled]).mean()).toBeCloseTo(rerolled.toPMF().mean(), 12);
    const saved = turn([rerolled]).onFirstHit(keepBestDamage()).mean();
    expect(saved).toBeGreaterThan(rerolled.toPMF().mean());
  });
});

describe("existing behaviour is unchanged", () => {
  const digest = (pmfs: readonly PMF[]): string =>
    createHash("sha1")
      .update(
        JSON.stringify(
          pmfs.map((pmf) => [...pmf.support()].sort((a, b) => a - b).map((v) => [v, pmf.pAt(v), pmf.outcomeAt(v, "hit"), pmf.outcomeAt(v, "crit")]))
        )
      )
      .digest("hex");

  it("resolves the same bits for attacks, pools, keeps and rerolls without a reroll budget", () => {
    const check = d20.plus(7).ac(14);
    const pmfs = [
      check.onHit(roll(2, d6).plus(3)).toPMF(),
      check.onHit(roll(3, d8).plus(2)).noCrit().toPMF(),
      check.onHit(roll(2, d6).plus(3).keepHighestAll(2, 1)).toPMF(),
      check.onHit(roll(2, d10).plus(4)).onCrit(3, d10).onMiss(1, d4).toPMF(),
      check.onHit(2, d6).rerollDamage(2).minimumDamageDie(2).plusSeparateDamage(roll(1, d4)).halfOnMiss().toPMF(),
      d20.plus(5).withAdvantage().ac(12).onHit(roll(1, d8).maxOf(2).plus(3)).toPMF(),
      roll(4, d6).keepHighest(4, 3).plus(1).toPMF(),
      roll(3, d6).reroll(2).minimum(2).toPMF(),
      turn([check.onHit(2, d6), check.onHit(1, d8)]).onFirstHit(keepBestDamage()).pmf,
    ];
    expect(digest(pmfs)).toBe("0baa42379c5f4006b5a439d9a582e1d4e21d8d92");
  });
});
