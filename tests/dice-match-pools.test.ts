import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttackBuilder, RollBuilder } from "../src/builder";
import { bounce, d20, d4, d6, d8, d10, flat, roll, turn, TurnSpecError } from "../src/builder";
import { rerollUpToMatch } from "../src/builder/reroll-pool";
import { calculateBounceOdds } from "../src/common/bounce";
import { setCachingEnabled } from "../src/common/lru-cache";
import type { DiceMatchInfo } from "../src/common/types";
import type { PMF } from "../src/pmf/pmf";
import { poolMatchOracle, type MatchOracle } from "./enumerate-match";

/**
 * A dice-match descriptor over the pools a caster really rolls: groups of dice with the same faces
 * (`roll(2, d8).plus(roll(1, d8))` is 3d8) and pools that reroll up to k dice, alone or as the best
 * of several rolls. `enumerate-match.ts` is the oracle: it lists every roll, tries every subset of
 * dice to reroll and lists every fresh die, sharing no code with the library.
 */

// The oracle lists every roll of a pool, and a pool too big to walk is refused only after its work limit.
vi.setConfig({ testTimeout: 60_000 });

const dieOf = { 4: d4, 6: d6, 8: d8, 10: d10 } as const;

/** The most an attack's damage pool can differ from the oracle: both are sums of a few thousand terms. */
const PRECISION = 12;

function attackWith(payload: RollBuilder): AttackBuilder {
  return d20.plus(5).ac(15).onHit(payload);
}

function codeOf(fn: () => unknown): { code: string; message: string } | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TurnSpecError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

function descriptor(info: DiceMatchInfo | null): DiceMatchInfo {
  expect(info).not.toBeNull();
  return info as DiceMatchInfo;
}

/** The descriptor's map as sorted [damage, probability] rows, to compare two descriptors exactly. */
function rows(info: DiceMatchInfo | null): [number, number][] {
  return [...descriptor(info).matchProbabilityByDamage].sort(([a], [b]) => a - b);
}

/**
 * The branch's own PMF, cut by the descriptor, is the oracle's law: for every damage, P(damage) is
 * the oracle's total and P(damage) times P(match | damage) is its match mass.
 */
function expectAgrees(pmf: PMF, info: DiceMatchInfo | null, oracle: MatchOracle, modifier = 0): void {
  const { matchProbabilityByDamage } = descriptor(info);
  const damages = new Set([...pmf.support(), ...[...oracle.total.keys()].map((sum) => sum + modifier)]);
  for (const damage of damages) {
    expect(pmf.pAt(damage)).toBeCloseTo(oracle.total.get(damage - modifier) ?? 0, PRECISION);
    expect(pmf.pAt(damage) * (matchProbabilityByDamage.get(damage) ?? 0)).toBeCloseTo(
      oracle.match.get(damage - modifier) ?? 0,
      PRECISION
    );
  }
}

/** P(match) of the branch: the descriptor averaged over the branch's own PMF. */
function pMatch(pmf: PMF, info: DiceMatchInfo | null): number {
  const { matchProbabilityByDamage } = descriptor(info);
  return pmf.support().reduce((sum, damage) => sum + pmf.pAt(damage) * (matchProbabilityByDamage.get(damage) ?? 0), 0);
}

describe("groups of dice with the same faces are one pool", () => {
  const pairs: [string, RollBuilder, RollBuilder][] = [
    ["2d6 as 1d6 + 1d6", roll(1, d6).plus(roll(1, d6)), roll(2, d6)],
    ["3d8 as 2d8 + 1d8", roll(2, d8).plus(roll(1, d8)), roll(3, d8)],
    ["3d8 + 4 as 1d8 + 2d8 + 4", roll(1, d8).plus(roll(2, d8)).plus(4), roll(3, d8).plus(4)],
    ["4d6 as three groups", roll(1, d6).plus(roll(2, d6)).plus(roll(1, d6)), roll(4, d6)],
    ["3d8 beside a group of no dice", roll(0, d6).plus(roll(3, d8)), roll(3, d8)],
    ["3d8 whose 1d8 has a minimum of 1, which floors nothing", roll(2, d8).plus(roll(1, d8.minimum(1))), roll(3, d8)],
    ["2d8 with a minimum of 2 in two groups", roll(1, d8.minimum(2)).plus(roll(1, d8.minimum(2))), roll(2, d8.minimum(2))],
    ["2d8 with a reroll of 1 in two groups", roll(1, d8.reroll(1)).plus(roll(1, d8.reroll(1))), roll(2, d8.reroll(1))],
  ];

  for (const [name, split, whole] of pairs) {
    it(`${name} has the descriptor of the whole pool, on the hit and on the crit`, () => {
      const a = attackWith(split).diceMatchInfo();
      const b = attackWith(whole).diceMatchInfo();
      expect(rows(a.hit)).toEqual(rows(b.hit));
      expect(rows(a.crit)).toEqual(rows(b.crit));
    });
  }

  it("agrees with every roll listed, on the hit and on the doubled crit", () => {
    const attack = attackWith(roll(2, d6).plus(roll(1, d6)).plus(2));
    const { hit, crit } = attack.diceMatchInfo();
    const { hit: hitPMF, crit: critPMF } = attack.resolve();
    expectAgrees(hitPMF, hit, poolMatchOracle({ sides: 6, count: 3, budget: 0 }), 2);
    expectAgrees(critPMF, crit, poolMatchOracle({ sides: 6, count: 6, budget: 0 }), 2);
  });

  it("agrees on an explicit crit written as two groups", () => {
    const attack = attackWith(roll(2, d6)).onCrit(roll(3, d6).plus(roll(2, d6)));
    expectAgrees(attack.resolve().crit, attack.diceMatchInfo().crit, poolMatchOracle({ sides: 6, count: 5, budget: 0 }));
  });

  it("a bounce chain over the split pool is the chain over the whole pool", () => {
    const split = attackWith(roll(2, d8).plus(roll(1, d8)));
    const whole = attackWith(roll(3, d8));
    expect(bounce({ source: split, max: 3 }).mean()).toBeCloseTo(bounce({ source: whole, max: 3 }).mean(), 12);
  });

  it("the single-group descriptor is the one 0.15.0 built: a lone group, a lone die, a group of none", () => {
    expect(rows(attackWith(roll(3, d8)).diceMatchInfo().hit)).toHaveLength(22);
    expect(descriptor(attackWith(roll(1, d8)).diceMatchInfo().hit).matchProbabilityByDamage.size).toBe(0);
    expect(descriptor(attackWith(roll(0, d8)).diceMatchInfo().hit).matchProbabilityByDamage.size).toBe(0);
  });
});

describe("dice of different kinds are not a pool to match", () => {
  const mixed: [string, RollBuilder, RegExp][] = [
    ["2d8 + 1d6", roll(2, d8).plus(roll(1, d6)), /different kinds \(d8 and d6\)/],
    ["2d8 with a minimum of 2 + 1d8", roll(2, d8.minimum(2)).plus(roll(1, d8)), /different kinds \(d8 minimum 2 and d8\)/],
    ["2d8 with a reroll of 1 + 1d8", roll(2, d8.reroll(1)).plus(roll(1, d8)), /different kinds \(d8 reroll 1 and d8\)/],
  ];

  for (const [name, payload, message] of mixed) {
    it(`${name}: no descriptor, and a bounce chain says why`, () => {
      const attack = attackWith(payload);
      expect(attack.diceMatchInfo().hit).toBeNull();
      expect(attack.diceMatchRefusals().hit).toMatch(message);
      const refused = codeOf(() => bounce({ source: attack, max: 1 }).mean());
      expect(refused?.code).toBe("no-dice-descriptor");
      expect(refused?.message).toMatch(message);
    });
  }

  it("a reroll pool of two kinds has none either", () => {
    const attack = attackWith(roll(2, d8).plus(roll(1, d6))).rerollDamageUpTo(1);
    expect(attack.diceMatchInfo()).toEqual({ hit: null, crit: null });
    expect(attack.diceMatchRefusals().hit).toMatch(/different kinds/);
  });
});

describe("a pool that rerolls up to k dice matches on the dice that land", () => {
  interface Case {
    name: string;
    sides: 4 | 6 | 8;
    count: number;
    budget: number;
    minimum?: number;
    reroll?: number;
    rolls?: number;
    /** Also check the doubled crit against the oracle (a pool of twice the dice, which costs more to list). */
    crit: boolean;
  }
  const cases: Case[] = [
    { name: "2d4, reroll 1", sides: 4, count: 2, budget: 1, crit: true },
    { name: "2d6, reroll 1", sides: 6, count: 2, budget: 1, crit: true },
    { name: "3d6, reroll 2", sides: 6, count: 3, budget: 2, crit: true },
    { name: "2d8, reroll 1", sides: 8, count: 2, budget: 1, crit: true },
    { name: "3d8, reroll 1", sides: 8, count: 3, budget: 1, crit: false },
    { name: "2d8 with a minimum of 2, reroll 1", sides: 8, count: 2, budget: 1, minimum: 2, crit: true },
    { name: "2d6 with a reroll of 1, reroll 2", sides: 6, count: 2, budget: 2, reroll: 1, crit: true },
    { name: "3d6, a budget of every die", sides: 6, count: 3, budget: 3, crit: false },
    { name: "2d4, best of two rolls, reroll 1", sides: 4, count: 2, budget: 1, rolls: 2, crit: true },
    { name: "2d6, best of two rolls, reroll 1", sides: 6, count: 2, budget: 1, rolls: 2, crit: false },
    { name: "3d4, best of two rolls, reroll 2", sides: 4, count: 3, budget: 2, rolls: 2, crit: false },
    { name: "3d4, best of two rolls, no reroll", sides: 4, count: 3, budget: 0, rolls: 2, crit: false },
  ];

  for (const c of cases) {
    const faces = dieOf[c.sides].reroll(c.reroll ?? 0).minimum(c.minimum ?? 0);
    const spec = { sides: c.sides, minimum: c.minimum, reroll: c.reroll, budget: c.budget, rolls: c.rolls };
    const options = c.rolls ? { rolls: c.rolls } : undefined;

    it(`${c.name}: agrees with every roll listed`, () => {
      const attack = attackWith(roll(c.count, faces).plus(3)).rerollDamageUpTo(c.budget, options);
      const { hit, crit } = attack.diceMatchInfo();
      const resolved = attack.resolve();
      expectAgrees(resolved.hit, hit, poolMatchOracle({ ...spec, count: c.count }), 3);
      // The crit doubles the dice and keeps the budget.
      expect(crit).not.toBeNull();
      if (c.crit) expectAgrees(resolved.crit, crit, poolMatchOracle({ ...spec, count: 2 * c.count }), 3);
    });

    it(`${c.name}: a rerollUpTo payload has the descriptor of the attack-level budget`, () => {
      const viaAttack = attackWith(roll(c.count, faces).plus(3)).rerollDamageUpTo(c.budget, options);
      const viaPayload = attackWith(roll(c.count, faces).plus(3).rerollUpTo(c.budget, options));
      expect(rows(viaPayload.diceMatchInfo().hit)).toEqual(rows(viaAttack.diceMatchInfo().hit));
      expect(rows(viaPayload.diceMatchInfo().crit)).toEqual(rows(viaAttack.diceMatchInfo().crit));
    });
  }

  it("the crit of an explicit onCrit pool matches on that pool's dice, with the attack's budget", () => {
    const attack = attackWith(roll(2, d6)).onCrit(roll(3, d6).plus(1)).rerollDamageUpTo(1);
    expectAgrees(
      attack.resolve().crit,
      attack.diceMatchInfo().crit,
      poolMatchOracle({ sides: 6, count: 3, budget: 1 }),
      1
    );
  });

  it("a budget of none, or of a pool no bigger than the dice, reads the pool it names", () => {
    const plain = attackWith(roll(3, d6)).diceMatchInfo();
    expect(rows(attackWith(roll(3, d6)).rerollDamageUpTo(0).diceMatchInfo().hit)).toEqual(rows(plain.hit));
    expect(rows(attackWith(roll(3, d6)).rerollDamageUpTo(0, { rolls: 2 }).diceMatchInfo().hit)).toEqual(rows(plain.hit));
    const all = attackWith(roll(2, d6)).rerollDamageUpTo(2).diceMatchInfo();
    expect(rows(attackWith(roll(2, d6)).rerollDamageUpTo(9).diceMatchInfo().hit)).toEqual(rows(all.hit));
  });

  it("one die can never match, however it rerolls, and its doubled crit can", () => {
    const attack = attackWith(roll(1, d8)).rerollDamageUpTo(1);
    const { hit, crit } = attack.diceMatchInfo();
    expect(descriptor(hit).matchProbabilityByDamage.size).toBe(0);
    expectAgrees(attack.resolve().crit, crit, poolMatchOracle({ sides: 8, count: 2, budget: 1 }));
  });

  it("a total that cannot hold a repeated face has no match odds, and one that must has all of them", () => {
    // 2d4 rerolling 1 (the mean is 2.5): 8 is two 4s, both kept. 2 is two 1s, one rerolled and shown as 1
    // again, since no other roll makes 2. 3 is a 1 and a 2, and no two dice make 3 with a repeat.
    const info = descriptor(attackWith(roll(2, d4)).rerollDamageUpTo(1).diceMatchInfo().hit).matchProbabilityByDamage;
    expect(info.get(8)).toBe(1);
    expect(info.get(2)).toBeCloseTo(1, 12);
    expect(info.get(3)).toBeCloseTo(0, 12);
  });

  describe("the policy is the one that maximises damage", () => {
    it("2d8 rerolling 1 matches 5/32 of the time: a match of low dice is rerolled away, and a roll with no match and a die below the mean rerolls too", () => {
      // Sort the two dice. With the lower one 1-4 (48 of 64 rolls) it is rerolled, even when it matches
      // the higher: the new die then matches the kept one 1 time in 8. With both dice 5-8 (16 rolls)
      // nothing is rerolled and they match when equal (4 rolls). (48/8 + 4) / 64 = 5/32.
      const attack = attackWith(roll(2, d8)).rerollDamageUpTo(1);
      expect(pMatch(attack.resolve().hit, attack.diceMatchInfo().hit)).toBeCloseTo(5 / 32, 12);
    });

    it("a caster who rerolls to make the dice match does better, and that is not what is modelled", () => {
      const attack = attackWith(roll(2, d8)).rerollDamageUpTo(1);
      const damagePolicy = pMatch(attack.resolve().hit, attack.diceMatchInfo().hit);
      // A matching roll stands, and the caster rerolls a die of a distinct roll to hit the other: 1/8 + 7/8 * 1/8.
      const matchPolicy = calculateBounceOdds(2, 8, { rerollDamageDice: 1 });
      expect(matchPolicy).toBeCloseTo(15 / 64, 12);
      expect(damagePolicy).toBeLessThan(matchPolicy);
      // The same pool with no reroll matches 1 time in 8: rerolling for damage moves the match too.
      expect(pMatch(attackWith(roll(2, d8)).resolve().hit, attackWith(roll(2, d8)).diceMatchInfo().hit)).toBeCloseTo(
        1 / 8,
        12
      );
    });

    it("a chain of beams follows the damage policy's odds: mean = m * (1 + P + P^2 + P^3)", () => {
      const attack = attackWith(roll(3, d6)).rerollDamageUpTo(1);
      const { weights, hit, crit } = attack.resolve();
      const { hit: hitInfo, crit: critInfo } = attack.diceMatchInfo();
      const perLanding =
        weights.hit * pMatch(hit, hitInfo) + weights.crit * pMatch(crit, critInfo);
      // P is also the oracle's, hit and crit, however the descriptor got there.
      const oracleHit = [...poolMatchOracle({ sides: 6, count: 3, budget: 1 }).match.values()].reduce((a, b) => a + b, 0);
      const oracleCrit = [...poolMatchOracle({ sides: 6, count: 6, budget: 1 }).match.values()].reduce((a, b) => a + b, 0);
      expect(perLanding).toBeCloseTo(weights.hit * oracleHit + weights.crit * oracleCrit, 12);
      const beam = attack.toPMF().mean();
      let expected = 0;
      for (let k = 0; k <= 3; k++) expected += beam * perLanding ** k;
      expect(bounce({ source: attack, max: 3 }).mean()).toBeCloseTo(expected, 10);
    });

    it("a chain over a best-of-two-rolls pool follows the same rule", () => {
      const attack = attackWith(roll(2, d4)).rerollDamageUpTo(1, { rolls: 2 });
      const { weights, hit, crit } = attack.resolve();
      const { hit: hitInfo, crit: critInfo } = attack.diceMatchInfo();
      const perLanding = weights.hit * pMatch(hit, hitInfo) + weights.crit * pMatch(crit, critInfo);
      const beam = attack.toPMF().mean();
      expect(bounce({ source: attack, max: 2 }).mean()).toBeCloseTo(beam * (1 + perLanding + perLanding ** 2), 10);
    });
  });

  it("a rider over a reroll pool reads the dice after the rerolls", () => {
    const source = attackWith(roll(2, d4)).rerollDamageUpTo(1);
    const t = turn(source).onDiceMatch(["attack 1"], roll(1, 1), { id: "on match" });
    const { weights, hit, crit } = source.resolve();
    const { hit: hitInfo, crit: critInfo } = source.diceMatchInfo();
    // The rider's 1d1 doubles on a crit; it fires when the branch matches.
    const expected =
      source.toPMF().mean() + weights.hit * pMatch(hit, hitInfo) * 1 + weights.crit * pMatch(crit, critInfo) * 2;
    expect(t.mean()).toBeCloseTo(expected, 12);
  });
});

describe("a pool that cannot be made exact is refused, and says why", () => {
  it("a reroll pool too big to enumerate has no descriptor", () => {
    const attack = attackWith(roll(6, 1000)).rerollDamageUpTo(2);
    expect(attack.diceMatchInfo().hit).toBeNull();
    expect(attack.diceMatchRefusals().hit).toMatch(/a rerollUpTo pool of 6 dice, too many to enumerate/);
  });

  it("a reroll pool the size of a 9th-level Chromatic Orb crit is not too big", () => {
    const attack = attackWith(roll(11, d8)).rerollDamageUpTo(5);
    expect(attack.diceMatchInfo().hit).not.toBeNull();
    expect(attack.diceMatchInfo().crit).not.toBeNull();
  });

  const refused: [string, () => AttackBuilder, "hit" | "crit", RegExp][] = [
    ["a string payload", () => d20.plus(5).ac(15).onHit("2d6+3"), "hit", /string expression/],
    ["a halved payload", () => attackWith(roll(4, d6).half()), "hit", /half\(\), scaleResult\(\), maxOf\(\)/],
    ["a rerollUpTo payload with a flat added after it", () => attackWith(roll(3, d8).rerollUpTo(1).plus(2)), "hit", /summed roll/],
    ["a keep pool", () => attackWith(roll(4, d8).keepHighest(4, 3)), "hit", /keeps some of its dice/],
    ["an exploding pool", () => attackWith(roll(3, d8).explode(1)), "hit", /explodes/],
    ["an advantaged pool", () => attackWith(roll(3, d8).withAdvantage()).noCrit(), "hit", /advantage or disadvantage/],
    ["a subtracted pool", () => attackWith(flat(30).minus(roll(3, d8))), "hit", /subtracts dice/],
    ["a minimum above the die's faces", () => attackWith(roll(3, d4.minimum(6))), "hit", /minimum of 6 on a d4/],
    ["a flat payload", () => attackWith(roll.flat(7)), "hit", /rolls no dice/],
    ["noCrit()", () => attackWith(roll(3, d8)).noCrit(), "crit", /cannot crit/],
    ["a crit that cannot double", () => attackWith(roll(4, d8).keepHighest(4, 3)), "crit", /no single doubled form|keeps some of its dice/],
  ];

  for (const [name, build, branch, message] of refused) {
    it(`${name}: no ${branch} descriptor, and the refusal names the cause`, () => {
      const attack = build();
      expect(attack.diceMatchInfo()[branch]).toBeNull();
      expect(attack.diceMatchRefusals()[branch]).toMatch(message);
    });
  }

  it("a minimum above the faces only matters to a pool of more than one die", () => {
    const lone = attackWith(roll(1, d4.minimum(6))).diceMatchInfo().hit;
    expect(descriptor(lone).matchProbabilityByDamage.size).toBe(0);
    // Every die shows 6, so three of them always match: the descriptor refused is the one that said never.
    const attack = attackWith(roll(3, d4.minimum(6)));
    expect(attack.resolve().hit.support()).toEqual([18]);
    expect(attack.diceMatchInfo().hit).toBeNull();
  });

  it("a branch with a descriptor has no refusal", () => {
    const attack = attackWith(roll(3, d8));
    expect(attack.diceMatchRefusals()).toEqual({ hit: null, crit: null });
  });

  it("a bounce chain's error carries the reason of the branch it needed", () => {
    const refused = codeOf(() => bounce({ source: attackWith(roll(3, d8).explode(1)), max: 1 }).mean());
    expect(refused?.code).toBe("no-dice-descriptor");
    expect(refused?.message).toMatch(/\(hit and crit: the damage explodes, so extra dice/);
  });

  it("a source that cannot say why keeps the generic message", () => {
    const bare = codeOf(() => turn(attackWith(roll(3, d8)).toPMF()).onDiceMatch(["attack 1"], roll(1, d6)).mean());
    expect(bare?.code).toBe("no-dice-descriptor");
    expect(bare?.message).toMatch(/a bare PMF, a string-parsed expression/);
  });
});

describe("the reroll-pool match cache follows setCachingEnabled", () => {
  afterEach(() => setCachingEnabled(true));

  const pool = { values: [1, 2, 3, 4, 5, 6], probs: new Array<number>(6).fill(1 / 6), count: 4 };

  it("reuses a walked pool while caching is on", () => {
    expect(rerollUpToMatch(pool, 2, 1)).toBe(rerollUpToMatch(pool, 2, 1));
  });

  it("reuses nothing while caching is off, and drops what it held", () => {
    const held = rerollUpToMatch(pool, 2, 1);
    setCachingEnabled(false);
    const first = rerollUpToMatch(pool, 2, 1);
    expect(first).not.toBe(rerollUpToMatch(pool, 2, 1));
    expect(first).not.toBe(held);
    expect([...(first?.total ?? [])]).toEqual([...(held?.total ?? [])]);
    setCachingEnabled(true);
    const fresh = rerollUpToMatch(pool, 2, 1);
    expect(fresh).not.toBe(held);
    expect(rerollUpToMatch(pool, 2, 1)).toBe(fresh);
  });
});
