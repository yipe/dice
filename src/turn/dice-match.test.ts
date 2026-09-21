import { describe, expect, it } from "vitest";
import { calculateBounceOdds } from "../common/bounce";
import type { DiceMatchInfo } from "../common/types";
import { bounce, d8, d20, roll, turn, TurnSpecError } from "../builder";
import type { AttackBuilder } from "../builder";
import { MAX_TRIGGER_GROUPS } from "./types";

/** Mass-weighted average of `info`'s per-damage match probability over `pmf`'s own bins — the
 * aggregate P(match) an attack's hit or crit branch realizes, cross-checked against
 * `calculateBounceOdds` (an independent implementation of the same marginal). */
function aggregateMatchProbability(hitOrCritPMF: { support(): number[]; pAt(d: number): number; mass(): number }, info: DiceMatchInfo): number {
  const mass = hitOrCritPMF.mass();
  if (mass <= 0) return 0;
  let weighted = 0;
  for (const d of hitOrCritPMF.support()) {
    weighted += hitOrCritPMF.pAt(d) * (info.matchProbabilityByDamage.get(d) ?? 0);
  }
  return weighted / mass;
}

function chromaticOrb(baseDice: number, attackBonus = 5, targetAC = 17): AttackBuilder {
  return d20.plus(attackBonus).ac(targetAC).onHit(roll(baseDice, d8));
}

describe("AttackBuilder.diceMatchInfo() — per-level Chromatic Orb match odds", () => {
  // Oracles from the plan: baseDice(level) = level + 2, crit dice = 2 * baseDice.
  const rows: { level: number; baseDice: number; hitP: number; critP: number }[] = [
    { level: 1, baseDice: 3, hitP: 0.343750, critP: 0.923096 },
    { level: 2, baseDice: 4, hitP: calculateBounceOdds(4, 8), critP: 0.997597 },
    { level: 3, baseDice: 5, hitP: calculateBounceOdds(5, 8), critP: 1.0 },
  ];

  for (const { level, baseDice, hitP, critP } of rows) {
    it(`level ${level}: hit pool ${baseDice}d8, crit pool ${baseDice * 2}d8`, () => {
      const attack = chromaticOrb(baseDice);
      const { hit: hitPMF, crit: critPMF } = attack.resolve();
      const { hit, crit } = attack.diceMatchInfo();

      expect(hit).not.toBeNull();
      expect(crit).not.toBeNull();
      expect(aggregateMatchProbability(hitPMF, hit!)).toBeCloseTo(hitP, 5);
      expect(aggregateMatchProbability(critPMF, crit!)).toBeCloseTo(critP, 5);

      // Cross-check against the independent calculateBounceOdds implementation directly.
      expect(aggregateMatchProbability(hitPMF, hit!)).toBeCloseTo(calculateBounceOdds(baseDice, 8), 10);
      expect(aggregateMatchProbability(critPMF, crit!)).toBeCloseTo(calculateBounceOdds(baseDice * 2, 8), 10);
    });
  }

  it("noCrit() has no crit branch and no crit match info", () => {
    const attack = chromaticOrb(3).noCrit();
    const { crit } = attack.diceMatchInfo();
    expect(crit).toBeNull();
  });

  it("a keep()/bestOf() pool has no match info (ambiguous under crit doubling)", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(4, d8).keepHighest(4, 3));
    const { hit } = attack.diceMatchInfo();
    expect(hit).toBeNull();
  });

  it("a single die is a supported source with zero match probability, not a missing descriptor", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(1, d8));
    const { hit, crit } = attack.diceMatchInfo();
    // Hit pool is 1 die: supported, but can never match — non-null, empty map.
    expect(hit).not.toBeNull();
    expect(hit!.matchProbabilityByDamage.size).toBe(0);
    // Crit pool auto-doubles to 2 dice: can match.
    expect(crit).not.toBeNull();
    expect(crit!.matchProbabilityByDamage.size).toBeGreaterThan(0);
  });
});

describe("dice-match trigger — validation", () => {
  it("naming a bare PMF source (no diceMatchInfo() capability) is a no-dice-descriptor TurnSpecError", () => {
    // An outcome-labelled PMF, but a bare PMF has no diceMatchInfo() capability at all — distinct
    // from a supported source that simply can't match (e.g. a single die), which must NOT throw.
    const barePMF = chromaticOrb(3).toPMF();
    expect(() => turn(barePMF).onDiceMatch(["attack 1"], chromaticOrb(3))).toThrow(TurnSpecError);
    try {
      turn(barePMF).onDiceMatch(["attack 1"], chromaticOrb(3));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TurnSpecError);
      expect((e as TurnSpecError).code).toBe("no-dice-descriptor");
    }
  });

  it("a one-die hit pool with a matchable auto-doubled crit pool does NOT throw (regression: null used to mean both 'unsupported' and 'can't match')", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(1, d8));
    expect(() => turn(attack).onDiceMatch(["attack 1"], chromaticOrb(3)).mean()).not.toThrow();
  });

  it("a turn with no dice-match trigger never computes match info (no thrown error, no slicing)", () => {
    const t = turn(chromaticOrb(3)).onFirstHit(roll(1, d8));
    expect(() => t.mean()).not.toThrow();
  });
});

describe("dice-match trigger — MATCH_BIT sharing a group with a first-hit trigger (regression)", () => {
  it("a first-hit rider still fires in crit mode when its group also matched", () => {
    // Deterministic: every landed attack crits (alwaysHits().alwaysCrits()), so `first` is ALWAYS
    // FIRST_CRIT once the attack lands, independent of whether the dice also matched. Sharing the
    // group with a `dice-match` rider sets MATCH_BIT (bit 4) on the SAME code whenever a match also
    // occurs — bit 4 must not corrupt the `first` field's `code >> 2` decode (bits 2-3). Buggy
    // decode: a matched crit reads `first` as non-FIRST_CRIT and fires the first-hit rider in the
    // WRONG (undoubled) mode.
    const attack = d20.alwaysHits().alwaysCrits().onHit(roll(3, d8));
    const pMatch = calculateBounceOdds(6, 8); // crit doubles 3d8 -> 6d8

    const t = turn(attack)
      .onFirstHit(roll(1, 4), { of: ["attack 1"] }) // crit-doubles to 2d4 (mean 5) on a crit
      .onDiceMatch(["attack 1"], roll(1, 1), { id: "match-marker" }); // deterministic +1 when matched

    // attack mean(6d8)=27 + firstHit ALWAYS crit-mode mean(2d4)=5 + match-marker fires w.p. pMatch
    const expectedMean = 27 + 5 + pMatch * 1;
    expect(t.mean()).toBeCloseTo(expectedMean, 9);

    // The buggy decode instead read a matched crit as non-crit, undercounting toward
    // 27 + (pMatch * 2.5 + (1 - pMatch) * 5) + pMatch — a materially different, WRONG total.
    const buggyMean = 27 + (pMatch * 2.5 + (1 - pMatch) * 5) + pMatch * 1;
    expect(t.mean()).not.toBeCloseTo(buggyMean, 2);
  });
});

describe("dice-match trigger — brute-force enumeration agreement, pools <= 5d8", () => {
  // 8^5 = 32768 explicit rolls — cheap. Compares FULL distributions, not just means, since a
  // mean-only check is exactly what a broken scalar-gate model already gets right.
  function bruteForceMatchDistribution(dice: number, faces: number): Map<number, number> {
    const total = faces ** dice;
    const dist = new Map<number, number>();
    const rolls = new Array<number>(dice).fill(1);
    for (let n = 0; n < total; n++) {
      let sum = 0;
      const seen = new Set<number>();
      let matched = false;
      for (const r of rolls) {
        sum += r;
        if (seen.has(r)) matched = true;
        seen.add(r);
      }
      if (matched) dist.set(sum, (dist.get(sum) ?? 0) + 1 / total);

      // odometer increment
      let i = 0;
      while (i < dice) {
        rolls[i]++;
        if (rolls[i] <= faces) break;
        rolls[i] = 1;
        i++;
      }
    }
    return dist;
  }

  for (const dice of [2, 3, 4, 5]) {
    it(`${dice}d8: exact per-sum match distribution matches brute-force enumeration`, () => {
      const attack = d20.alwaysHits().onHit(roll(dice, d8));
      const { hit } = attack.diceMatchInfo();
      expect(hit).not.toBeNull();

      const { hit: hitPMF } = attack.resolve();
      const brute = bruteForceMatchDistribution(dice, 8);

      const allSums = new Set([...hitPMF.support(), ...brute.keys()]);
      for (const sum of allSums) {
        const exactMatchMass = hitPMF.pAt(sum) * (hit!.matchProbabilityByDamage.get(sum) ?? 0);
        const bruteMass = brute.get(sum) ?? 0;
        expect(exactMatchMass).toBeCloseTo(bruteMass, 9);
      }
    });
  }
});

describe("bounce() sugar and two-beam correlation", () => {
  it("expands to a first attack plus max attack-shaped dice-match riders", () => {
    const source = chromaticOrb(3);
    const t = bounce({ source, max: 2 });
    expect(t.attackIds).toEqual(["attack 1"]);
    expect(t.riderIds).toEqual(["bounce 1", "bounce 2"]);
  });

  it("max: 0 is just the first beam, no riders", () => {
    const t = bounce({ source: chromaticOrb(3), max: 0 });
    expect(t.riderIds).toEqual([]);
  });

  it("rejects a negative or non-integer max", () => {
    expect(() => bounce({ source: chromaticOrb(3), max: -1 })).toThrow(RangeError);
    expect(() => bounce({ source: chromaticOrb(3), max: 1.5 })).toThrow(RangeError);
  });

  it("a chain longer than the trigger-group budget throws too-many-groups", () => {
    expect(() => bounce({ source: chromaticOrb(3), max: MAX_TRIGGER_GROUPS + 1 })).toThrow(TurnSpecError);
  });

  it("two-beam chain at pHit=0.6, 3d8: mean 9.770625, variance 92.944 (not the scalar-gate 74.902)", () => {
    // The oracle (spec D3b) is the SIMPLE two-outcome model: X1 = 1{hit}*S1 where S1 is a plain
    // 3d8 sum, no crit-doubling. noCrit() folds crit mass into hit at the same 3d8 dice, matching
    // that model exactly. An AC where exactly 12 of 20 face values (9-20) succeed gives pHit = 0.6
    // precisely.
    const attack = d20.plus(0).ac(9).onHit(roll(3, d8)).noCrit();
    const resolution = attack.resolve();
    expect(resolution.weights.hit).toBeCloseTo(0.6, 10);
    expect(resolution.weights.crit).toBe(0);

    const t = bounce({ source: attack, max: 1 });
    const pmf = t.pmf;

    expect(pmf.mean()).toBeCloseTo(9.770625, 3);
    expect(pmf.variance()).toBeCloseTo(92.944, 1);
    expect(pmf.variance()).not.toBeCloseTo(74.902, 0);
  });
});

describe("dice-match walk latency at MAX_TRIGGER_GROUPS depth (measurement only, never fails the build)", () => {
  it(`reports latency for a ${MAX_TRIGGER_GROUPS}-deep bounce chain`, () => {
    const source = chromaticOrb(3);
    const start = performance.now();
    const t = bounce({ source, max: MAX_TRIGGER_GROUPS });
    t.mean();
    const elapsedMs = performance.now() - start;
    console.log(`bounce({max: ${MAX_TRIGGER_GROUPS}}) resolve latency: ${elapsedMs.toFixed(2)}ms`);
    expect(t.riderIds.length).toBe(MAX_TRIGGER_GROUPS);
  });
});
