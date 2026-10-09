/**
 * The readers and the library invariants: the readers agree with each other and
 * with the joint walk, on the oracle's port-ready cases and on builder turns.
 */
import { describe, expect, it, vi } from "vitest";
import { advantage, critOnHit, d20, d4, d6, d8, roll, turn } from "../src/builder";
import { prone, stunned } from "../src/dnd5e";
import { DenseTotal } from "../src/pmf/dense-total";
import { PMF } from "../src/pmf/pmf";
import {
  Turn,
  type AttackMarginal,
  type LandingPattern,
  type Rider,
  type RiderMarginal,
  type Source,
  type TurnSpec,
} from "../src/turn/index";
import { inspectPlan } from "../src/turn/turn";
import { FAMILIES } from "./oracle/v2/cases/index";

const TOLERANCE = 1e-12;
const READY = Object.entries(FAMILIES).map(
  ([family, cases]) => [family, cases.filter((c) => c.engineOnly === undefined && c.gaps.length === 0)] as const
);
const idsOf = (t: Turn): string[] => [...t.attackIds, ...t.riderIds];
const marginalMean = (t: Turn): number => idsOf(t).reduce((sum, id) => sum + t.marginal(id).pmf.mean(), 0);

function expectSamePmf(actual: PMF, expected: PMF, label: string): void {
  for (const value of new Set([...actual.support(), ...expected.support()])) {
    expect(Math.abs(actual.pAt(value) - expected.pAt(value)), `${label} at ${value}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

/** `with` × p + `without` × (1 − p), value by value. */
function expectMixture(actual: PMF, withIt: PMF, without: PMF, p: number, label: string): void {
  for (const value of new Set([...actual.support(), ...withIt.support(), ...without.support()])) {
    const want = p * withIt.pAt(value) + (1 - p) * without.pAt(value);
    expect(Math.abs(actual.pAt(value) - want), `${label} at ${value}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));
const fist = d20.plus(8).ac(16).onHit(d6.plus(4));

describe("mean() is the sum of the marginal means (L2)", () => {
  for (const [family, cases] of READY) {
    it(`every port-ready ${family} case`, () => {
      for (const c of cases) {
        const t = Turn.from(c.spec);
        if (inspectPlan(t).dealing) continue; // its mean is that sum by definition
        const mean = t.mean();
        expect(Math.abs(mean - marginalMean(t)), c.name).toBeLessThanOrEqual(TOLERANCE * Math.max(1, mean));
      }
    });
  }
});

describe("a marginal does not change when other rows' damage is zeroed (L2)", () => {
  const zeroed = d20.plus(8).ac(16).melee().onHit(0 as never);
  const shapes: Record<string, (other: typeof sword) => Turn> = {
    vex: (other) => turn([sword.onEveryHit(advantage().untilNextAttack()), other, sword]),
    topple: (other) =>
      turn([sword, other, sword]).onFirstHit(prone().untilEndOfTurn(), { id: "topple", save: d20.plus(3).dc(15).ability("con") }),
    sneak: (other) => turn([sword, other, sword]).onFirstHit(roll(3, d6), { id: "sneak" }).onEveryHit(d6, { max: 2, id: "capped" }),
  };
  for (const [name, build] of Object.entries(shapes)) {
    it(name, () => {
      const whole = build(sword);
      const zero = build(zeroed);
      for (const id of idsOf(whole)) {
        if (id === "attack 2") continue;
        expectSamePmf(zero.marginal(id).pmf, whole.marginal(id).pmf, `${name} ${id}`);
      }
    });
  }
});

describe("happens and chance are mixtures (L2)", () => {
  const p = 0.3;
  const spec = (happens: number | undefined, riders = true): TurnSpec => ({
    attacks: [
      { id: "a", source: sword },
      { id: "b", source: sword },
    ],
    riders: riders ? [{ id: "r", damage: d6, on: "every-hit", ...(happens === undefined ? {} : { happens }) }] : [],
    conditions: [{ id: "vex", on: "every-hit", of: ["a"], grants: [{ advantage: true, until: "next-attack" }] }],
  });
  it("a rider's happens: p mixes the turn with and without it", () => {
    const some = Turn.from(spec(p));
    const always = Turn.from(spec(undefined));
    const never = Turn.from(spec(undefined, false));
    expectMixture(some.pmf, always.pmf, never.pmf, p, "joint");
    for (const id of ["a", "b"]) expectSamePmf(some.marginal(id).pmf, always.marginal(id).pmf, id);
    expectMixture(some.marginal("r").pmf, always.marginal("r").pmf, PMF.delta(0), p, "r");
    expect(some.mean()).toBeCloseTo(p * always.mean() + (1 - p) * never.mean(), 12);
  });
  it("an attack's chance: p mixes the turn with and without it", () => {
    const chanceSpec = (chance: number | undefined): TurnSpec => ({
      attacks: [
        { id: "a", source: sword, ...(chance === undefined ? {} : { chance }) },
        { id: "b", source: sword },
      ],
      conditions: [{ id: "vex", on: "every-hit", of: ["a"], grants: [{ advantage: true, until: "next-attack" }] }],
    });
    const some = Turn.from(chanceSpec(p));
    const present = Turn.from(chanceSpec(undefined));
    const absent = Turn.from(chanceSpec(0));
    expectMixture(some.pmf, present.pmf, absent.pmf, p, "joint");
    expectMixture(some.marginal("b").pmf, present.marginal("b").pmf, absent.marginal("b").pmf, p, "b");
    const a = some.marginal("a") as AttackMarginal;
    expect(a.occurs).toBeCloseTo(p, 15);
    expectSamePmf(a.whenHappens, (present.marginal("a") as AttackMarginal).whenHappens, "a when it happens");
  });
});

describe("bit placement (L2, property over every port-ready case)", () => {
  for (const [family, cases] of READY) {
    it(`every ${family} plan: flags fit the key, never alias at a read, and stay live until read`, () => {
      for (const c of cases) {
        const plan = inspectPlan(Turn.from(c.spec));
        plan.steps.forEach((step, s) => {
          const bits = step.flagReads.map(({ bit }) => bit);
          // The state key holds 30 flag bits.
          for (const bit of bits) expect(bit, `${c.name} ${step.id}`).toBeLessThan(30);
          // Two flags a row reads never share a bit.
          expect(new Set(bits).size, `${c.name} ${step.id}`).toBe(bits.length);
          // A flag read here was kept live by the step before (or is in force from the start).
          const live = s === 0 ? -1 : plan.flagLiveAfter[s - 1];
          for (const bit of bits) expect((live & (1 << bit)) !== 0, `${c.name} ${step.id} bit ${bit}`).toBe(true);
        });
      }
    });
  }
});

describe("the readers agree with each other", () => {
  const stunning = (): Turn =>
    turn([fist, fist, fist]).onFirstHit(stunned().untilEndOfTurn(), { id: "stun", save: d20.plus(2).dc(15).ability("con") });
  const hit = 0.65;
  const fail = 0.6;

  it("attemptProbability: a first-hit condition is tried on the first landing a later attack can use", () => {
    // As the engine counts it: attack 3 has no later attack to stun for, so it is not tried there.
    expect(stunning().attemptProbability("stun")).toBeCloseTo(1 - (1 - hit) ** 2, 12);
  });

  it("stepStats.conditions: attempted on a row's landing, taken on a failed save", () => {
    const [stun] = stunning().stepStats("attack 2").conditions;
    expect(stun.id).toBe("stun");
    expect(stun.attempted).toBeCloseTo((1 - hit) * hit, 12);
    expect(stun.taken).toBeCloseTo((1 - hit) * hit * fail, 12);
  });

  it("stepStats.live: the advantage a stun puts in force, with its source", () => {
    const { live } = stunning().stepStats("attack 2");
    expect(live.advantage).toBeCloseTo(hit * fail, 12);
    expect(live.sources.advantage).toEqual([{ source: { kind: "grant", grant: "stun" }, odds: live.sources.advantage[0].odds }]);
    expect(live.sources.advantage[0].odds).toBeCloseTo(hit * fail, 12);
  });

  it("a rider's landings add up to its anyLanding, which is fireProbability; patterns too", () => {
    const t = turn([sword, sword, bow]).onFirstHit(roll(3, d6), { id: "sneak" }).onEveryHit(d6, { max: 2, id: "capped" });
    const sneak = t.marginal("sneak") as RiderMarginal;
    expect(sneak.anyLanding).toBeCloseTo(t.fireProbability("sneak"), 12);
    const landed = [...sneak.landings.values()].reduce((sum, { hit: h, crit }) => sum + h + crit, 0);
    expect(landed).toBeCloseTo(sneak.anyLanding, 12);
    const patterns = t.attackIds.flatMap((id) => t.landings(id)).filter(({ riders }) => riders.includes("sneak"));
    expect(patterns.reduce((sum, { mass }) => sum + mass, 0)).toBeCloseTo(sneak.anyLanding, 12);
    const capped = t.marginal("capped") as RiderMarginal;
    expect(capped.anyLanding).toBeCloseTo(t.fireProbability("capped"), 12);
    // Its marginal mean is what it adds to the turn's.
    const without = turn([sword, sword, bow]).onFirstHit(roll(3, d6), { id: "sneak" });
    expect(capped.pmf.mean()).toBeCloseTo(t.mean() - without.mean(), 12);
  });

  it("an attack's marginal is whenHappens thinned by occurs, with its d20's odds", () => {
    const t = Turn.from({
      attacks: [
        { id: "a", source: sword },
        { id: "b", source: sword, chance: 0.4 },
      ],
      conditions: [{ id: "vex", on: "every-hit", of: ["a"], grants: [{ advantage: true, until: "next-attack" }] }],
    });
    const b = t.marginal("b") as AttackMarginal;
    expect(b.occurs).toBeCloseTo(0.4, 15);
    expectSamePmf(b.pmf, b.whenHappens.applyHitFrequency(0.4), "b");
    expect(b.rollType.advantage).toBeCloseTo(hit, 12);
    expect(b.rollType.flat).toBeCloseTo(1 - hit, 12);
    expect(t.peakStates).toBeGreaterThan(0);
  });
});

describe("landing patterns name a row's branches as the engine does", () => {
  const anyRider = { id: "r", damage: d6, on: "every-hit" as const, of: ["row"], landing: "any" as const };
  const patternsOf = (source: Source, rider: Rider = anyRider): readonly LandingPattern[] =>
    Turn.from({ attacks: [{ id: "row", source }], riders: [rider] }).landings("row");
  const expectPatterns = (actual: readonly LandingPattern[], expected: [string, boolean, number][]): void => {
    expect(actual.map(({ label, dealt, riders }) => [label, dealt, riders])).toEqual(expected.map(([label, dealt]) => [label, dealt, ["r"]]));
    actual.forEach(({ mass }, i) => expect(mass).toBeCloseTo(expected[i][2], 12));
  };
  // d20 + 2 against DC 15 fails on 1-12: 0.6.
  it("a half-damage save that can halve to 0: saveHalf dealt and saveHalf not dealt", () => {
    // d4 halved rounds 1 down to 0.
    expectPatterns(patternsOf(d20.plus(2).dc(15).onSaveFailure(d4).saveHalf()), [
      ["saveFail", true, 0.6],
      ["saveHalf", true, 0.4 * 0.75],
      ["saveHalf", false, 0.4 * 0.25],
    ]);
  });
  it("a failure that can deal 0: saveFail not dealt", () => {
    // d4 − 1 is 0 on a 1; halved, 0 on a 1 or 2.
    expectPatterns(patternsOf(d20.plus(2).dc(15).onSaveFailure(d4.plus(-1)).saveHalf()), [
      ["saveFail", true, 0.6 * 0.75],
      ["saveFail", false, 0.6 * 0.25],
      ["saveHalf", true, 0.4 * 0.5],
      ["saveHalf", false, 0.4 * 0.5],
    ]);
  });
  it("a save without half damage: its pass is savePass, never dealt", () => {
    expectPatterns(patternsOf(d20.plus(2).dc(15).onSaveFailure(d4)), [
      ["saveFail", true, 0.6],
      ["savePass", false, 0.4],
    ]);
  });
  it("an attack: hit and crit by damage dealt, its miss is miss, never dealt (a miss payload included)", () => {
    // d20 + 8 against AC 16: hits on 8-19 (0.6), crits on 20 (0.05), misses 0.35.
    expectPatterns(patternsOf(d20.plus(8).ac(16).onHit(d8.plus(4)).onMiss(d4)), [
      ["hit", true, 0.6],
      ["crit", true, 0.05],
      ["miss", false, 0.35],
    ]);
  });
  it("a rider's happens does not hide where it lands", () => {
    const rider = { id: "r", damage: d6, on: "every-hit" as const, of: ["row"], happens: 0.5 };
    expectPatterns(patternsOf(d20.plus(8).ac(16).onHit(d8.plus(4)), rider), [
      ["hit", true, 0.6],
      ["crit", true, 0.05],
    ]);
  });
});

describe("probability readers never walk the joint distribution", () => {
  it("stepStats, marginal, attemptProbability, landings, peakStates, fireProbability and expectedApplications convolve no damage", () => {
    const t = turn([fist, fist, fist])
      .onEveryHit(advantage().untilNextAttack(), { id: "vex" })
      .onFirstHit(stunned().untilEndOfTurn(), { id: "stun", save: d20.plus(2).dc(15).ability("con") })
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onEveryHit(d6, { max: 2, id: "capped" });
    // The joint walk convolves damage in every state; the mass walks never do.
    const convolve = vi.spyOn(PMF.prototype, "convolve");
    const convolveRaw = vi.spyOn(PMF.prototype, "convolveRaw");
    const dense = vi.spyOn(DenseTotal.prototype, "convolve");
    try {
      for (const id of t.attackIds) {
        t.stepStats(id);
        t.landings(id);
      }
      for (const id of idsOf(t)) t.marginal(id);
      for (const id of t.riderIds) {
        t.fireProbability(id);
        t.expectedApplications(id);
      }
      for (const id of t.conditionIds) {
        t.attemptProbability(id);
        t.fireProbability(id);
      }
      expect(t.peakStates).toBeGreaterThan(0);
      expect(convolve).not.toHaveBeenCalled();
      expect(convolveRaw).not.toHaveBeenCalled();
      expect(dense).not.toHaveBeenCalled();
      t.mean();
      expect(dense).toHaveBeenCalled();
    } finally {
      convolve.mockRestore();
      convolveRaw.mockRestore();
      dense.mockRestore();
    }
  });
});

describe("a probe or a rider is read without damage arithmetic (moved from probes.test.ts)", () => {
  it("reading a probe or a rider does no damage arithmetic; only pmf, mean and toQuery convolve", () => {
    const t = turn([fist, fist, fist])
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onEveryHit(critOnHit().untilNextAttack(), { chance: 0.5 })
      .observeAnyCrit("crit");
    const convolve = vi.spyOn(PMF.prototype, "convolve");
    const convolveRaw = vi.spyOn(PMF.prototype, "convolveRaw");
    const add = vi.spyOn(PMF.prototype, "add");
    const dense = vi.spyOn(DenseTotal.prototype, "convolve");
    try {
      const crit = t.fireProbability("crit");
      expect(t.fireProbability("crit")).toBe(crit);
      t.fireProbability("sneak");
      expect(convolve).not.toHaveBeenCalled();
      expect(convolveRaw).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(dense).not.toHaveBeenCalled();
      t.mean();
      expect(dense).toHaveBeenCalled();
    } finally {
      convolve.mockRestore();
      convolveRaw.mockRestore();
      add.mockRestore();
      dense.mockRestore();
    }
  });
});
