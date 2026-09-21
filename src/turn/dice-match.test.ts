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

  it("a single die can never match", () => {
    const attack = d20.plus(5).ac(17).onHit(roll(1, d8));
    const { hit, crit } = attack.diceMatchInfo();
    // Hit pool is 1 die (can't match); crit pool auto-doubles to 2 dice (can).
    expect(hit).toBeNull();
    expect(crit).not.toBeNull();
  });
});

describe("dice-match trigger — validation", () => {
  it("naming a bare PMF source is a no-dice-descriptor TurnSpecError", () => {
    const attack = chromaticOrb(3);
    expect(() =>
      turn(attack).onDiceMatch(["attack 1"], chromaticOrb(3)).rider({
        damage: chromaticOrb(3),
        on: "dice-match",
        of: ["nonexistent"],
      })
    ).toThrow(TurnSpecError);
  });

  it("naming a keep()-pool source is a no-dice-descriptor TurnSpecError", () => {
    const ambiguous = d20.plus(5).ac(17).onHit(roll(4, d8).keepHighest(4, 3));
    expect(() => turn(ambiguous).onDiceMatch(["attack 1"], chromaticOrb(3))).toThrow(TurnSpecError);
    try {
      turn(ambiguous).onDiceMatch(["attack 1"], chromaticOrb(3));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TurnSpecError);
      expect((e as TurnSpecError).code).toBe("no-dice-descriptor");
    }
  });

  it("a turn with no dice-match trigger never computes match info (no thrown error, no slicing)", () => {
    const t = turn(chromaticOrb(3)).onFirstHit(roll(1, d8));
    expect(() => t.mean()).not.toThrow();
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
