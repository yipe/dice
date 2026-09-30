import { describe, expect, it } from "vitest";
import {
  advantage,
  bounce,
  d4,
  d6,
  d8,
  d10,
  d20,
  flat,
  keepBestDamage,
  MAX_CAPPED_COUNTERS,
  roll,
  turn,
  Turn,
  TurnSpecError,
} from "../builder";
import type { AttackBuilder, Damage, Rider } from "../builder";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import { inspectTurn } from "./turn";
import { MAX_TRIGGER_GROUPS } from "./types";

// --- an oracle that shares no code with the walk ---------------------------------------------
// A distribution is a plain Map; nothing below touches PMF arithmetic. It enumerates every
// outcome sequence of the attacks (miss, hit, crit, or "did not happen") and applies each
// capped rider to the first `max` landings in turn order.

type Dist = Map<number, number>;

const point = (value: number): Dist => new Map([[value, 1]]);

function convolve(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [x, p] of a) for (const [y, q] of b) out.set(x + y, (out.get(x + y) ?? 0) + p * q);
  return out;
}

const scaled = (dist: Dist, by: number): Dist => new Map([...dist].map(([value, p]) => [value, p * by]));

/** `count` dice with `sides` faces plus a flat bonus. */
function dice(count: number, sides: number, bonus = 0): Dist {
  let dist = point(bonus);
  for (let i = 0; i < count; i++) {
    const face: Dist = new Map(Array.from({ length: sides }, (_, k): [number, number] => [k + 1, 1 / sides]));
    dist = convolve(dist, face);
  }
  return dist;
}

interface Odds {
  hit: number;
  crit: number;
}

interface OracleAttack extends Odds {
  hitDamage: Dist;
  critDamage: Dist;
  /** Chance the attack happens at all; 1 when omitted. */
  chance?: number;
  /** Odds when the attack before it landed, for a grant of advantage on the next attack. */
  afterLanding?: Odds;
}

interface Payload {
  hit: Dist;
  crit: Dist;
}

interface OracleRider {
  /** Indices of the attacks it watches. */
  of: number[];
  /** Applies to at most this many landings; unlimited when omitted. */
  max?: number;
  /** The payload when attack `index` lands. */
  payload: (index: number) => Payload;
}

const MISS = 0;
const HIT = 1;
const CRIT = 2;
const NONE = 3;

/** d20 + `bonus` against `ac`: a natural 20 crits, a natural 1 misses. */
function odds(bonus: number, ac: number): Odds {
  let hit = 0;
  for (let face = 2; face <= 19; face++) if (face + bonus >= ac) hit += 1 / 20;
  return { hit, crit: 1 / 20 };
}

/** The same roll with advantage: the better of two d20s. */
function advantageOdds(bonus: number, ac: number): Odds {
  const { hit, crit } = odds(bonus, ac);
  const miss = 1 - hit - crit;
  return { hit: 1 - miss ** 2 - (1 - (1 - crit) ** 2), crit: 1 - (1 - crit) ** 2 };
}

function oracle(
  attacks: OracleAttack[],
  riders: OracleRider[],
  order: (outcomes: number[]) => number[] = (outcomes) => outcomes.map((_, index) => index)
): Dist {
  const total: Dist = new Map();
  const walk = (outcomes: number[], probability: number): void => {
    if (outcomes.length === attacks.length) {
      let damage = point(0);
      const applied = riders.map(() => 0);
      for (const index of order(outcomes)) {
        const outcome = outcomes[index];
        if (outcome !== HIT && outcome !== CRIT) continue;
        damage = convolve(damage, outcome === HIT ? attacks[index].hitDamage : attacks[index].critDamage);
        riders.forEach((rider, r) => {
          if (!rider.of.includes(index)) return;
          if (rider.max !== undefined && applied[r] >= rider.max) return;
          applied[r]++;
          const payload = rider.payload(index);
          damage = convolve(damage, outcome === HIT ? payload.hit : payload.crit);
        });
      }
      for (const [value, p] of damage) total.set(value, (total.get(value) ?? 0) + p * probability);
      return;
    }
    const index = outcomes.length;
    const attack = attacks[index];
    const previous = outcomes[index - 1];
    const own = attack.afterLanding && (previous === HIT || previous === CRIT) ? attack.afterLanding : attack;
    const chance = attack.chance ?? 1;
    const branches: [number, number][] = [
      [MISS, chance * (1 - own.hit - own.crit)],
      [HIT, chance * own.hit],
      [CRIT, chance * own.crit],
      [NONE, 1 - chance],
    ];
    for (const [outcome, p] of branches) if (p > 0) walk([...outcomes, outcome], probability * p);
  };
  walk([], 1);
  return total;
}

function expectMatches(actual: PMF, expected: Dist, tolerance = 1e-12): void {
  const support = new Set([...actual.support(), ...expected.keys()]);
  let worst = 0;
  for (const value of support) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)));
  }
  expect(worst).toBeLessThan(tolerance);
}

function maxDiff(a: PMF, b: PMF): number {
  let worst = 0;
  for (const value of new Set([...a.support(), ...b.support()])) {
    worst = Math.max(worst, Math.abs(a.pAt(value) - b.pAt(value)));
  }
  return worst;
}

function bins(pmf: PMF): [number, number][] {
  return [...pmf.support()].sort((x, y) => x - y).map((value): [number, number] => [value, pmf.pAt(value)]);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TurnSpecError);
    return (error as TurnSpecError).code;
  }
  return undefined;
}

// --- the sources -------------------------------------------------------------------------------

const sword = d20.plus(7).ac(15).onHit(d8.plus(4)); // hit 0.6, crit 0.05
const swordOracle: OracleAttack = {
  ...odds(7, 15),
  hitDamage: dice(1, 8, 4),
  critDamage: dice(2, 8, 4),
};
/** The sword when a landing before it grants advantage on the next attack. */
const advantagedOracle: OracleAttack = { ...swordOracle, afterLanding: advantageOdds(7, 15) };

const knife = d20.plus(5).ac(14).onHit(d6.plus(3)); // hit 0.55, crit 0.05
const knifeOracle: OracleAttack = {
  ...odds(5, 14),
  hitDamage: dice(1, 6, 3),
  critDamage: dice(2, 6, 3),
};

/** A payload that doubles its dice on a crit. */
const doubling = (count: number, sides: number): (() => Payload) => () => ({
  hit: dice(count, sides),
  crit: dice(2 * count, sides),
});

describe("onEveryHit max: an exact cap on applications", () => {
  describe("hand-computed: at most 2 over 3 attacks, with crits", () => {
    // Each attack: hit 1/2 for 1, crit 1/4 for 2, miss 1/4. The rider adds 10 on a hit and 30 on a
    // crit, to the first two landings only.
    const attack = Mixture.mix([
      ["hit", PMF.delta(1), 0.5],
      ["crit", PMF.delta(2), 0.25],
      ["missNone", PMF.delta(0), 0.25],
    ]);
    const capped = turn([attack, attack, attack]).onEveryHit(PMF.delta(10), {
      id: "dice",
      max: 2,
      critDamage: PMF.delta(30),
    });

    it("prices each ordering of landings by which two the rider reaches", () => {
      const pmf = capped.pmf;
      // MMM: 0.
      expect(pmf.pAt(0)).toBeCloseTo(1 / 64, 14);
      // One landing, a hit: 1 + 10. Three positions, two misses.
      expect(pmf.pAt(11)).toBeCloseTo(3 * 0.5 * 0.25 * 0.25, 14);
      // HHH: base 3, the rider on the first two hits only: 3 + 20.
      expect(pmf.pAt(23)).toBeCloseTo(0.125, 14);
      // HHC: 4 + 10 + 10 (the crit is third).
      expect(pmf.pAt(24)).toBeCloseTo(0.0625, 14);
      // HCH and CHH: the crit is among the first two landings, 4 + 10 + 30.
      expect(pmf.pAt(44)).toBeCloseTo(0.125, 14);
      expect(pmf.mass()).toBeCloseTo(1, 14);
    });

    it("reports P(applied at least once) and the expected applications", () => {
      // P(some landing) = 1 - (1/4)^3.
      expect(capped.fireProbability("dice")).toBeCloseTo(63 / 64, 14);
      // K landings ~ Bin(3, 3/4): E[min(K, 2)] = P(K = 1) + 2 P(K >= 2).
      expect(capped.expectedApplications("dice")).toBeCloseTo(9 / 64 + 2 * (27 / 64 + 27 / 64), 14);
    });

    it("has the mean of its parts: base plus applications times a landing's payload", () => {
      const perLanding = (2 / 3) * 10 + (1 / 3) * 30;
      expect(capped.mean()).toBeCloseTo(3 * 1 + capped.expectedApplications("dice") * perLanding, 12);
    });
  });

  describe("against the enumeration oracle", () => {
    for (const [attacks, max] of [
      [3, 2],
      [4, 1],
      [4, 2],
      [4, 3],
      [5, 2],
      [5, 4],
    ] as const) {
      it(`${attacks} identical attacks, at most ${max}`, () => {
        const actual = turn().attacks(attacks, sword).onEveryHit(roll(3, d6), { max });
        const expected = oracle(Array<OracleAttack>(attacks).fill(swordOracle), [
          { of: [...Array(attacks).keys()], max, payload: doubling(3, 6) },
        ]);
        expectMatches(actual.pmf, expected);
      });
    }

    it("mixed attacks with different odds and damage", () => {
      const actual = turn([sword, knife, sword, knife]).onEveryHit(d10, { max: 2 });
      const expected = oracle(
        [swordOracle, knifeOracle, swordOracle, knifeOracle],
        [{ of: [0, 1, 2, 3], max: 2, payload: doubling(1, 10) }]
      );
      expectMatches(actual.pmf, expected);
    });

    it("counts only the attacks it watches", () => {
      const actual = turn([sword, knife, sword, knife]).onEveryHit(d10, { max: 1, of: ["attack 2", "attack 4"] });
      const expected = oracle(
        [swordOracle, knifeOracle, swordOracle, knifeOracle],
        [{ of: [1, 3], max: 1, payload: doubling(1, 10) }]
      );
      expectMatches(actual.pmf, expected);
    });

    it("expands a tag in `of`", () => {
      const actual = turn()
        .attacks(3, sword, { tag: "melee" })
        .attack(knife, "bow")
        .onEveryHit(d10, { max: 2, of: ["melee"] });
      const expected = oracle(
        [swordOracle, swordOracle, swordOracle, knifeOracle],
        [{ of: [0, 1, 2], max: 2, payload: doubling(1, 10) }]
      );
      expectMatches(actual.pmf, expected);
    });

    it("does not count an attack that did not happen", () => {
      const actual = turn([{ source: sword, chance: 0.5 }, sword, { source: sword, chance: 0.25 }]).onEveryHit(
        d10,
        { max: 1 }
      );
      const expected = oracle(
        [{ ...swordOracle, chance: 0.5 }, swordOracle, { ...swordOracle, chance: 0.25 }],
        [{ of: [0, 1, 2], max: 1, payload: doubling(1, 10) }]
      );
      expectMatches(actual.pmf, expected);
    });

    it("keeps riders with different caps, and one uncapped, apart", () => {
      const actual = turn([sword, sword, sword, sword])
        .onEveryHit(d10, { max: 1, id: "one" })
        .onEveryHit(roll(2, d4), { max: 3, id: "three" })
        .onEveryHit(d6, { id: "all" });
      const all = [0, 1, 2, 3];
      const expected = oracle(Array<OracleAttack>(4).fill(swordOracle), [
        { of: all, max: 1, payload: doubling(1, 10) },
        { of: all, max: 3, payload: doubling(2, 4) },
        { of: all, payload: doubling(1, 6) },
      ]);
      expectMatches(actual.pmf, expected);
      expect(actual.fireProbability("one")).toBeCloseTo(1 - 0.35 ** 4, 12);
      expect(actual.expectedApplications("one")).toBeCloseTo(1 - 0.35 ** 4, 12);
      // E[min(K, 3)] with K ~ Bin(4, 0.65).
      const pk = (k: number): number => [1, 4, 6, 4, 1][k] * 0.65 ** k * 0.35 ** (4 - k);
      expect(actual.expectedApplications("three")).toBeCloseTo(pk(1) + 2 * pk(2) + 3 * (pk(3) + pk(4)), 12);
      expect(actual.expectedApplications("all")).toBeCloseTo(4 * 0.65, 12);
    });

    it("gives riders over different sources different counters", () => {
      const actual = turn([sword, sword, sword, sword])
        .onEveryHit(d10, { max: 1, of: ["attack 1", "attack 2"], id: "early" })
        .onEveryHit(d6, { max: 2, of: ["attack 2", "attack 3", "attack 4"], id: "late" });
      const expected = oracle(Array<OracleAttack>(4).fill(swordOracle), [
        { of: [0, 1], max: 1, payload: doubling(1, 10) },
        { of: [1, 2, 3], max: 2, payload: doubling(1, 6) },
      ]);
      expectMatches(actual.pmf, expected);
    });

    it("shares one counter between riders with the same sources and cap", () => {
      const actual = turn([sword, sword, sword]).onEveryHit(d10, { max: 2 }).onEveryHit(roll(2, d4), { max: 2 });
      const all = [0, 1, 2];
      const expected = oracle(Array<OracleAttack>(3).fill(swordOracle), [
        { of: all, max: 2, payload: doubling(1, 10) },
        { of: all, max: 2, payload: doubling(2, 4) },
      ]);
      expectMatches(actual.pmf, expected);
    });

    it("uses an explicit critDamage on the landings it applies to", () => {
      const actual = turn([sword, sword, sword]).onEveryHit(d10, { max: 2, critDamage: flat(25) });
      const expected = oracle(Array<OracleAttack>(3).fill(swordOracle), [
        { of: [0, 1, 2], max: 2, payload: () => ({ hit: dice(1, 10), crit: point(25) }) },
      ]);
      expectMatches(actual.pmf, expected);
    });

    it("applies a list payload as one application", () => {
      const actual = turn([sword, sword, sword]).onEveryHit([d10, d4], { max: 2 });
      const expected = oracle(Array<OracleAttack>(3).fill(swordOracle), [
        {
          of: [0, 1, 2],
          max: 2,
          payload: () => ({ hit: convolve(dice(1, 10), dice(1, 4)), crit: convolve(dice(2, 10), dice(2, 4)) }),
        },
      ]);
      expectMatches(actual.pmf, expected);
    });

    it("follows turn order through a reroll that resolves right after the miss", () => {
      // Two swords and a reroll of the first miss, placed directly after it: the cap of 2 counts
      // landings as sword 1, the reroll, sword 2 when sword 1 missed. The oracle draws the reroll's
      // outcome always and drops it from the turn when no sword missed.
      const actual = turn([sword, sword])
        .onFirstMiss(sword, { id: "reroll" })
        .onEveryHit(d10, { max: 2, of: ["attack 1", "attack 2", "reroll"] });
      const expected = oracle(
        [swordOracle, swordOracle, swordOracle],
        [{ of: [0, 1, 2], max: 2, payload: doubling(1, 10) }],
        (outcomes) => {
          if (outcomes[0] === MISS) return [0, 2, 1];
          if (outcomes[1] === MISS) return [0, 1, 2];
          return [0, 1];
        }
      );
      expectMatches(actual.pmf, expected);
    });

    it("selects the roll context and the cap together: advantage granted by a landing", () => {
      // A landing gives the next attack advantage, and the rider covers the first two landings.
      const actual = turn([sword, sword, sword])
        .onEveryHit(advantage().untilNextAttack())
        .onEveryHit(d10, { max: 2, id: "dice" });
      const expected = oracle(Array<OracleAttack>(3).fill(advantagedOracle), [
        { of: [0, 1, 2], max: 2, payload: doubling(1, 10) },
      ]);
      expectMatches(actual.pmf, expected);
    });
  });

  describe("equal to the uncapped rider when the cap cannot bind (bit for bit)", () => {
    for (const attacks of [1, 2, 3, 4]) {
      // A cap of 1 is a first hit (see below), so the cap that cannot bind starts at 2.
      for (const max of [attacks, attacks + 1, 50].filter((cap) => cap > 1)) {
        it(`${attacks} attacks, max ${max}`, () => {
          const every = turn().attacks(attacks, sword).onEveryHit(roll(3, d6), { id: "r" });
          const capped = turn().attacks(attacks, sword).onEveryHit(roll(3, d6), { id: "r", max });
          expect(bins(capped.pmf)).toEqual(bins(every.pmf));
          expect(capped.fireProbability("r")).toBe(every.fireProbability("r"));
          expect(capped.expectedApplications("r")).toBe(every.expectedApplications("r"));
          expect(capped.stepStats("attack 1")).toEqual(every.stepStats("attack 1"));
        });
      }
    }

    it("with granted advantage and a substitute in the same turn", () => {
      const build = (max?: number): Turn =>
        turn([sword, sword, sword])
          .onEveryHit(advantage().untilNextAttack())
          .onFirstHit(keepBestDamage().ifBelow({ hit: 9, crit: 15 }))
          .onEveryHit(d6, { id: "r", ...(max === undefined ? {} : { max }) });
      expect(bins(build(3).pmf)).toEqual(bins(build().pmf));
    });
  });

  describe("max: 1 is onFirstHit, bit for bit", () => {
    /** Every observable of a turn: its whole distribution, fire probabilities and step statistics. */
    const observe = (t: Turn): unknown => ({
      bins: bins(t.pmf),
      fires: [...t.riderIds, ...t.substituteIds, ...t.conditionIds].map((id) => t.fireProbability(id)),
      applications: t.riderIds.map((id) => t.expectedApplications(id)),
      stats: t.attackIds.map((id) => t.stepStats(id)),
    });

    const cases: [string, (rider: (t: Turn) => Turn) => Turn][] = [
      ["several attacks, crits included", (rider) => rider(turn([sword, sword, sword]))],
      ["mixed attacks", (rider) => rider(turn([knife, sword, knife]))],
      [
        "granted advantage changing later attack rolls",
        (rider) => rider(turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack())),
      ],
      [
        "a threshold substitute beside it",
        (rider) => rider(turn([sword, sword, sword]).onFirstHit(keepBestDamage().ifBelow({ hit: 9, crit: 15 }))),
      ],
      ["a first-miss reroll", (rider) => rider(turn([sword, sword]).onFirstMiss(knife))],
      ["an attack that only happens sometimes", (rider) => rider(turn([{ source: sword, chance: 0.5 }, sword]))],
    ];
    for (const [name, build] of cases) {
      it(name, () => {
        const first = build((t) => t.onFirstHit(roll(3, d6), { id: "r", critDamage: flat(25) }));
        const capped = build((t) => t.onEveryHit(roll(3, d6), { id: "r", critDamage: flat(25), max: 1 }));
        expect(observe(capped)).toEqual(observe(first));
      });
    }

    it("is the same rider in a spec", () => {
      const first = Turn.from({ attacks: [sword, sword], riders: [{ on: "first-hit", damage: d10 }] });
      const capped = Turn.from({ attacks: [sword, sword], riders: [{ on: "every-hit", max: 1, damage: d10 }] });
      expect(observe(capped)).toEqual(observe(first));
    });

    it("can be negated by otherwise, as onFirstHit is", () => {
      const first = turn([sword, sword]).onFirstHit(d10, { id: "r" }).otherwise(d4, { id: "alt" });
      const capped = turn([sword, sword]).onEveryHit(d10, { id: "r", max: 1 }).otherwise(d4, { id: "alt" });
      expect(observe(capped)).toEqual(observe(first));
      expect(capped.fireProbability("alt")).toBeCloseTo(0.35 ** 2, 12);
    });

    it("can be negated by a not-fired rider in a spec", () => {
      const riders = (on: "first-hit" | "every-hit"): Rider[] => [
        on === "first-hit"
          ? { on, id: "r", damage: d10 }
          : { on, id: "r", damage: d10, max: 1 },
        { on: "not-fired", of: "r", damage: d4 },
      ];
      const first = Turn.from({ attacks: [sword, sword], riders: riders("first-hit") });
      const capped = Turn.from({ attacks: [sword, sword], riders: riders("every-hit") });
      expect(observe(capped)).toEqual(observe(first));
    });

    it("can be watched by another rider, when it rolls its own attack", () => {
      const rider = (verb: "onFirstHit" | "onEveryHit"): Turn => {
        const t = turn([sword, sword]);
        const bonus =
          verb === "onFirstHit"
            ? t.onFirstHit(knife, { id: "bonus" })
            : t.onEveryHit(knife, { id: "bonus", max: 1 });
        return bonus.onEveryHit(d6, { of: ["attack 1", "attack 2", "bonus"], id: "mark" });
      };
      expect(observe(rider("onEveryHit"))).toEqual(observe(rider("onFirstHit")));
    });

    it("is bit for bit onFirstHit when the arithmetic is exact, too", () => {
      const attack = Mixture.mix([
        ["hit", PMF.delta(3), 0.5],
        ["crit", PMF.delta(6), 0.25],
        ["missNone", PMF.delta(0), 0.25],
      ]);
      const first = turn([attack, attack, attack]).onFirstHit(PMF.delta(8), { critDamage: PMF.delta(16) });
      const capped = turn([attack, attack, attack]).onEveryHit(PMF.delta(8), {
        max: 1,
        critDamage: PMF.delta(16),
      });
      expect(bins(capped.pmf)).toEqual(bins(first.pmf));
    });
  });

  describe("the walk", () => {
    it("drops a count once the remaining attacks cannot reach the cap", () => {
      // After the last watched attack no cap can bind, so the walk's final states are the
      // uncapped rider's: a count that split them would mean the cap still shaped a decision.
      const last = (t: Turn): number => {
        const { stateCounts } = inspectTurn(t);
        return stateCounts[stateCounts.length - 1];
      };
      const every = last(turn().attacks(6, sword).onEveryHit(d6));
      for (const max of [2, 4, 5]) {
        expect(last(turn().attacks(6, sword).onEveryHit(d6, { max }))).toBe(every);
      }
    });
  });

  describe("a payload per landing source", () => {
    const fire = d10;
    const cold = roll(2, d4);

    it("deals each source's own payload, with its own crit default", () => {
      const actual = turn([sword, knife, sword]).onEveryHit(d6, {
        max: 2,
        perSource: { "attack 2": { damage: fire }, "attack 3": { damage: cold } },
      });
      const expected = oracle(
        [swordOracle, knifeOracle, swordOracle],
        [
          {
            of: [0, 1, 2],
            max: 2,
            payload: (index) => [doubling(1, 6), doubling(1, 10), doubling(2, 4)][index](),
          },
        ]
      );
      expectMatches(actual.pmf, expected);
    });

    it("is a first-hit payload per landing source with max: 1", () => {
      const actual = turn([sword, knife, sword]).onEveryHit(d6, {
        max: 1,
        perSource: { "attack 2": { damage: fire, critDamage: flat(40) } },
      });
      const expected = oracle(
        [swordOracle, knifeOracle, swordOracle],
        [
          {
            of: [0, 1, 2],
            max: 1,
            payload: (index) =>
              index === 1 ? { hit: dice(1, 10), crit: point(40) } : doubling(1, 6)(),
          },
        ]
      );
      expectMatches(actual.pmf, expected);
    });

    it("works without a cap: a payload per row for an every-hit rider", () => {
      const actual = turn([sword, knife]).onEveryHit(d6, { perSource: { "attack 2": { damage: fire } } });
      const expected = oracle(
        [swordOracle, knifeOracle],
        [{ of: [0, 1], payload: (index) => (index === 1 ? doubling(1, 10)() : doubling(1, 6)()) }]
      );
      expectMatches(actual.pmf, expected);
    });

    it("first-hit with a payload per source equals the plain first hit when every payload is the same", () => {
      const plain = turn([sword, sword, sword]).onFirstHit(d6, { id: "r" });
      const same = turn([sword, sword, sword]).onFirstHit(d6, {
        id: "r",
        perSource: { "attack 2": { damage: d6 }, "attack 3": { damage: d6 } },
      });
      expect(maxDiff(same.pmf, plain.pmf)).toBeLessThan(1e-15);
      expect(same.fireProbability("r")).toBeCloseTo(plain.fireProbability("r"), 15);
      const negated = (t: Turn): Turn => t.otherwise(d4, { id: "alt" });
      expect(maxDiff(negated(same).pmf, negated(plain).pmf)).toBeLessThan(1e-15);
      expect(negated(same).fireProbability("alt")).toBeCloseTo(negated(plain).fireProbability("alt"), 15);
    });

    it("a per-source first hit is one rider: fireProbability, expectedApplications, otherwise", () => {
      const first = turn([sword, knife, sword]).onFirstHit(d6, {
        id: "first",
        perSource: { "attack 2": { damage: fire } },
      });
      const pSome = 1 - 0.35 * 0.4 * 0.35;
      expect(first.fireProbability("first")).toBeCloseTo(pSome, 12);
      expect(first.expectedApplications("first")).toBe(first.fireProbability("first"));
      const either = first.otherwise(d4, { id: "none" });
      expect(either.fireProbability("none")).toBeCloseTo(1 - pSome, 12);
    });

    it("first-hit takes a payload per source, in the chained and the spec spelling", () => {
      const chained = turn([sword, knife, sword]).onFirstHit(d6, {
        perSource: { "attack 2": { damage: fire, critDamage: flat(40) } },
      });
      const spec = Turn.from({
        attacks: [sword, knife, sword],
        riders: [
          {
            on: "first-hit",
            damage: d6,
            perSource: { "attack 2": { damage: fire, critDamage: flat(40) } },
          },
        ],
      });
      const expected = oracle(
        [swordOracle, knifeOracle, swordOracle],
        [
          {
            of: [0, 1, 2],
            max: 1,
            payload: (index) => (index === 1 ? { hit: dice(1, 10), crit: point(40) } : doubling(1, 6)()),
          },
        ]
      );
      expectMatches(chained.pmf, expected);
      expect(bins(spec.pmf)).toEqual(bins(chained.pmf));
    });

    it("a per-source first hit beside a granted advantage that changes later attack rolls", () => {
      const actual = turn([sword, knife, sword])
        .onEveryHit(advantage().untilNextAttack())
        .onFirstHit(d6, { perSource: { "attack 2": { damage: fire } } });
      const shifted = (ac: OracleAttack): OracleAttack => ({ ...ac, afterLanding: advantageOdds(7, 15) });
      const expected = oracle(
        [shifted(swordOracle), { ...knifeOracle, afterLanding: advantageOdds(5, 14) }, shifted(swordOracle)],
        [
          {
            of: [0, 1, 2],
            max: 1,
            payload: (index) => (index === 1 ? doubling(1, 10)() : doubling(1, 6)()),
          },
        ]
      );
      expectMatches(actual.pmf, expected);
    });

    it("follows turn order through a first-miss reroll", () => {
      const actual = turn([sword, sword])
        .onFirstMiss(sword, { id: "reroll" })
        .onFirstHit(d10, {
          of: ["attack 1", "attack 2", "reroll"],
          perSource: { reroll: { damage: flat(100), critDamage: flat(100) } },
        });
      const expected = oracle(
        [swordOracle, swordOracle, swordOracle],
        [
          {
            of: [0, 1, 2],
            max: 1,
            payload: (index) => (index === 2 ? { hit: point(100), crit: point(100) } : doubling(1, 10)()),
          },
        ],
        (outcomes) => {
          if (outcomes[0] === MISS) return [0, 2, 1];
          if (outcomes[1] === MISS) return [0, 1, 2];
          return [0, 1];
        }
      );
      expectMatches(actual.pmf, expected);
    });

    describe("an any-miss reroll resolves after every declared attack, so an ordered rider cannot watch it", () => {
      const reroll = { of: ["attack 1", "attack 2", "reroll"] };

      it("refuses a first-hit payload per source", () => {
        const build = (): Turn =>
          turn([sword, knife])
            .onAnyMiss(sword, { id: "reroll" })
            .onEveryHit(flat(1), { ...reroll, max: 1, perSource: { "attack 2": { damage: flat(100) } } });
        expect(codeOf(build)).toBe("unsupported-trigger");
        expect(() => build()).toThrow(/onFirstMiss/);
        const first = (): Turn =>
          turn([sword, knife])
            .onAnyMiss(sword, { id: "reroll" })
            .onFirstHit(flat(1), { ...reroll, perSource: { "attack 2": { damage: flat(100) } } });
        expect(codeOf(first)).toBe("unsupported-trigger");
      });

      it("refuses a cap that can bind", () => {
        const build = (max: number): Turn =>
          turn([sword, sword, knife]).onAnyMiss(sword, { id: "reroll" }).onEveryHit(d6, { of: [...reroll.of, "attack 3"], max });
        expect(codeOf(() => build(2))).toBe("unsupported-trigger");
        expect(codeOf(() => build(3))).toBe("unsupported-trigger");
      });

      it("allows what does not read the order: no cap, a cap that cannot bind, a plain first hit", () => {
        const base = (): Turn => turn([sword, knife]).onAnyMiss(sword, { id: "reroll" });
        expect(() => base().onEveryHit(d6, reroll)).not.toThrow();
        expect(() => base().onEveryHit(d6, { ...reroll, max: 3 })).not.toThrow();
        expect(() => base().onEveryHit(d6, { ...reroll, perSource: { "attack 2": { damage: d8 } } })).not.toThrow();
        expect(() => base().onEveryHit(d6, { ...reroll, max: 1 })).not.toThrow();
        expect(() => base().onFirstHit(d6, reroll)).not.toThrow();
      });
    });

    describe("a per-source first hit beside a threshold substitute that watches what it negates", () => {
      // F is the per-source first hit, N its negation (a bonus attack when F never applied), and S a
      // threshold reroll over the attacks and N. The look-ahead has to know F's fire slot, or N
      // looks like it can still fire after F applied and S holds a roll it can never spend.
      const build = (attacks: number, perSource: boolean): Turn => {
        let t = turn().attack(sword, "a1");
        if (attacks > 1) t = t.attack(sword, "a2");
        const of = attacks > 1 ? ["a1", "a2", "N"] : ["a1", "N"];
        return t
          .onFirstHit(roll(2, d6), {
            id: "F",
            ...(perSource ? { perSource: { a1: { damage: roll(2, d6) } } } : {}),
          })
          .otherwise(knife, { id: "N" })
          .onFirstHit(keepBestDamage().ifBelow({ hit: 8, crit: 14 }), { id: "S", of });
      };

      for (const attacks of [1, 2]) {
        it(`${attacks} attack${attacks > 1 ? "s" : ""}: the same as the step spelling`, () => {
          const folded = build(attacks, true);
          const step = build(attacks, false);
          expect(maxDiff(folded.pmf, step.pmf)).toBeLessThan(1e-14);
          expect(folded.mean()).toBeCloseTo(step.mean(), 12);
          for (const id of ["F", "N", "S"]) {
            expect(folded.fireProbability(id)).toBeCloseTo(step.fireProbability(id), 13);
          }
        });
      }

      it("sees a later attack that always lands mark the first hit it negates", () => {
        // a2 always lands, so F applies there and N never fires: S holding a1's roll for N is
        // worthless. The look-ahead reaches that through a2's draws, not through the walk state.
        const always = d20.alwaysHits().onHit(d6);
        const build = (perSource: boolean): Turn =>
          turn()
            .attack(sword, "a1")
            .attack(always, "a2")
            .onFirstHit(roll(2, d6), {
              id: "F",
              of: ["a2"],
              ...(perSource ? { perSource: { a2: { damage: roll(2, d6) } } } : {}),
            })
            .otherwise(knife, { id: "N" })
            .onFirstHit(keepBestDamage().ifBelow({ hit: 8, crit: 14 }), { id: "S", of: ["a1", "N"] });
        const folded = build(true);
        const step = build(false);
        expect(maxDiff(folded.pmf, step.pmf)).toBeLessThan(1e-14);
        for (const id of ["F", "N", "S"]) {
          expect(folded.fireProbability(id)).toBeCloseTo(step.fireProbability(id), 13);
        }
      });
    });

    describe("a per-source first hit that rolls its own attack", () => {
      it("is refused, in the rider's own damage and in a payload, and in a list", () => {
        const own = (): Turn => turn([sword, sword]).onFirstHit(knife, { perSource: { "attack 2": { damage: d6 } } });
        const payload = (): Turn => turn([sword, sword]).onFirstHit(d6, { perSource: { "attack 2": { damage: knife } } });
        const list = (): Turn =>
          turn([sword, sword]).onFirstHit(d6, { perSource: { "attack 2": { damage: [knife, knife] } } });
        for (const build of [own, payload, list]) {
          expect(codeOf(build)).toBe("unsupported-trigger");
          expect(build).toThrow(/plain onFirstHit/);
        }
      });

      it("is refused for a capped or per-source every-hit rider too, but not for a plain one", () => {
        const capped = (): Turn => turn([sword, sword, sword]).onEveryHit(knife, { max: 2 });
        const cappedPayload = (): Turn =>
          turn([sword, sword, sword]).onEveryHit(d6, { max: 2, perSource: { "attack 2": { damage: knife } } });
        const perSource = (): Turn =>
          turn([sword, sword]).onEveryHit(d6, { perSource: { "attack 2": { damage: [knife, d6] } } });
        const cannotBind = (): Turn => turn([sword, sword]).onEveryHit(knife, { max: 2 });
        for (const build of [capped, cappedPayload, perSource, cannotBind]) {
          expect(codeOf(build)).toBe("unsupported-trigger");
          expect(build).toThrow(/plain onFirstHit/);
        }
        expect(() => turn([sword, sword]).onEveryHit(knife)).not.toThrow();
        expect(() => turn([sword, sword]).onEveryHit(knife, { max: 1 })).not.toThrow();
      });

      it("is refused when only the critDamage rolls an attack, rider-level or per source", () => {
        const swordAt = (ac: number): AttackBuilder => d20.plus(7).ac(ac).onHit(d8.plus(4));
        const knifeAt = (ac: number): AttackBuilder => d20.plus(5).ac(ac).onHit(d6.plus(3));
        const spellings: (() => Turn)[] = [
          () => turn([sword, sword, sword]).onEveryHit(d6, { max: 2, critDamage: knifeAt(14) }),
          () => turn([sword, sword, sword]).onEveryHit(d6, { max: 2, critDamage: [d6, knifeAt(14)] }),
          () =>
            turn([sword, sword]).onEveryHit(d6, {
              perSource: { "attack 2": { damage: d6, critDamage: knifeAt(14) } },
            }),
          () =>
            turn([sword, sword]).onFirstHit(d6, {
              perSource: { "attack 2": { damage: d6, critDamage: knifeAt(14) } },
            }),
          () => turn([sword, sword]).onFirstHit(d6, { critDamage: knifeAt(14), perSource: { "attack 2": { damage: d8 } } }),
        ];
        for (const build of spellings) {
          expect(codeOf(build)).toBe("unsupported-trigger");
          expect(build).toThrow(/critDamage/);
        }
        // What is not folded still takes an attack as its crit damage, and vsAC still rebinds it.
        const plainFirst = (sword: Damage, crit: Damage): Turn => turn([sword, sword]).onFirstHit(d6, { critDamage: crit });
        const plainEvery = (sword: Damage, crit: Damage): Turn => turn([sword, sword]).onEveryHit(d6, { critDamage: crit });
        for (const build of [plainFirst, plainEvery]) {
          expect(build(swordAt(15), knifeAt(14)).vsAC(20).mean()).toBeCloseTo(build(swordAt(20), knifeAt(20)).mean(), 12);
          expect(build(swordAt(15), knifeAt(14)).vsAC(20).mean()).not.toBeCloseTo(
            build(swordAt(20), knifeAt(14)).mean(),
            3
          );
        }
        expect(() => turn([sword, sword]).onEveryHit(d6, { max: 1, critDamage: knifeAt(14) })).not.toThrow();
      });

      it("is what the plain onFirstHit step spelling is for", () => {
        const t = turn([sword, sword]).onFirstHit(knife, { id: "bonus" });
        expect(t.stepStats("bonus").rolled).toBeCloseTo(1 - 0.35 ** 2, 12);
      });
    });
  });

  describe("JSON spec", () => {
    it("`{ on: 'every-hit', of, max }` is the chained cap", () => {
      const spec = Turn.from({
        attacks: [sword, sword, sword],
        riders: [{ on: "every-hit", of: ["attack 1", "attack 2", "attack 3"], max: 2, damage: d6, id: "dice" }],
      });
      const chained = turn([sword, sword, sword]).onEveryHit(d6, { max: 2, id: "dice" });
      expect(bins(spec.pmf)).toEqual(bins(chained.pmf));
      expect(spec.expectedApplications("dice")).toBe(chained.expectedApplications("dice"));
    });

    it("an omitted `of` watches every declared attack", () => {
      const spec = Turn.from({
        attacks: [sword, sword, sword],
        riders: [{ on: "every-hit", max: 2, damage: d6 }],
      });
      const chained = turn([sword, sword, sword]).onEveryHit(d6, { max: 2 });
      expect(bins(spec.pmf)).toEqual(bins(chained.pmf));
    });
  });

  describe("beside a bounce chain long enough to reuse trigger group slots", () => {
    // A ten-link bounce chain has ten dice-match source sets and the capped rider adds another:
    // more than MAX_TRIGGER_GROUPS, so the plan shares slots between groups whose lives do not
    // overlap. The cap's count and the per-source first hit's fire slot are not group slots, so a
    // slot that is released and reused cannot reset them; the enumeration resolves the same turn.
    const orb = d20.plus(5).ac(17).onHit(roll(3, d8));
    const links = 10;
    const orbOdds = odds(5, 17);

    /** Joint (total, dice matched) mass of `count` d8s: the orb's damage given a landing. */
    const diceTable = (count: number): Record<"matched" | "unmatched", Dist> => {
      const out = { matched: new Map<number, number>(), unmatched: new Map<number, number>() };
      const walk = (left: number, total: number, seen: number, matched: boolean): void => {
        if (left === 0) {
          const into = matched ? out.matched : out.unmatched;
          into.set(total, (into.get(total) ?? 0) + 8 ** -count);
          return;
        }
        for (let face = 1; face <= 8; face++) {
          walk(left - 1, total + face, seen | (1 << face), matched || (seen & (1 << face)) !== 0);
        }
      };
      walk(count, 0, 0, false);
      return out;
    };
    const hitDice = diceTable(3);
    const critDice = diceTable(6);

    const capBeams = [0, 2, 3, 5, 6, 8, 10]; // beam 0 is "attack 1", beam k is "bounce k"
    const capIds = capBeams.map((beam) => (beam === 0 ? "attack 1" : `bounce ${beam}`));
    const firstBeams = [3, 4, 9];
    const firstIds = firstBeams.map((beam) => `bounce ${beam}`);

    const build = (): Turn =>
      bounce({ source: orb, max: links })
        .onEveryHit(d6, { max: 2, of: capIds, id: "dice" })
        .onFirstHit(d4, {
          of: firstIds,
          id: "first",
          perSource: { "bounce 4": { damage: d10 }, "bounce 9": { damage: flat(7), critDamage: flat(20) } },
        });

    const payloadFor = (beam: number): Payload => {
      if (beam === 4) return doubling(1, 10)();
      if (beam === 9) return { hit: point(7), crit: point(20) };
      return doubling(1, 4)();
    };

    /** Forward enumeration over the beams; state: chain alive, cap applications used, first hit used. */
    const enumerate = (): { total: Dist; pFirst: number; pCap: number; eCap: number } => {
      let states = new Map<string, Dist>([["1|0|0", point(0)]]);
      for (let beam = 0; beam <= links; beam++) {
        const next = new Map<string, Dist>();
        const put = (key: string, dist: Dist): void => {
          const known = next.get(key);
          if (!known) next.set(key, dist);
          else for (const [value, p] of dist) known.set(value, (known.get(value) ?? 0) + p);
        };
        for (const [key, dist] of states) {
          const [alive, count, first] = key.split("|").map(Number);
          if (!alive) {
            put(key, dist);
            continue;
          }
          put(`0|${count}|${first}`, scaled(dist, 1 - orbOdds.hit - orbOdds.crit));
          for (const [mode, p, table] of [
            ["hit", orbOdds.hit, hitDice],
            ["crit", orbOdds.crit, critDice],
          ] as const) {
            for (const matched of ["matched", "unmatched"] as const) {
              let landed = convolve(dist, scaled(table[matched], p));
              let used = count;
              let firstUsed = first;
              if (capBeams.includes(beam) && used < 2) {
                landed = convolve(landed, doubling(1, 6)()[mode]);
                used++;
              }
              if (firstBeams.includes(beam) && !firstUsed) {
                landed = convolve(landed, payloadFor(beam)[mode]);
                firstUsed = 1;
              }
              put(`${matched === "matched" ? 1 : 0}|${used}|${firstUsed}`, landed);
            }
          }
        }
        states = next;
      }
      const total: Dist = new Map();
      let pFirst = 0;
      let pCap = 0;
      let eCap = 0;
      for (const [key, dist] of states) {
        const [, count, first] = key.split("|").map(Number);
        let mass = 0;
        for (const [value, p] of dist) {
          total.set(value, (total.get(value) ?? 0) + p);
          mass += p;
        }
        if (first) pFirst += mass;
        if (count > 0) pCap += mass;
        eCap += count * mass;
      }
      return { total, pFirst, pCap, eCap };
    };

    it("really shares slots", () => {
      const t = build();
      const sourceSets = t.riderIds.filter((id) => id.startsWith("bounce")).length + 1;
      expect(sourceSets).toBeGreaterThan(MAX_TRIGGER_GROUPS);
      expect(inspectTurn(t).groupCount).toBeLessThanOrEqual(MAX_TRIGGER_GROUPS);
    });

    it("matches the enumeration at 1e-12 with the cap and the per-source first hit both binding", () => {
      const expected = enumerate();
      const t = build();
      expectMatches(t.pmf, expected.total, 1e-12);
      expect(t.fireProbability("first")).toBeCloseTo(expected.pFirst, 12);
      expect(t.fireProbability("dice")).toBeCloseTo(expected.pCap, 12);
      expect(t.expectedApplications("dice")).toBeCloseTo(expected.eCap, 12);
      expect(t.expectedApplications("first")).toBeCloseTo(expected.pFirst, 12);
    });
  });

  describe("over save rows, by landing kind", () => {
    // A save has no hit or crit: a rider reads it under `landing`. `fail` counts a failed save
    // whatever it dealt; `damage` counts a failure or a saveHalf pass that dealt more than 0. Each
    // capped rider counts its own landings, so two kinds over one row keep two counters.
    const halfSave = d20.dc(13).onSaveFailure(d4.plus(-1)).saveHalf();
    const plainSave = d20.dc(13).onSaveFailure(d4.plus(-1));

    /** One way a row can turn out: its probability, its damage, and where it lands for a rider. */
    interface RowOutcome {
      p: number;
      dist: Dist;
      /** Lands for a rider reading the row under `fail`, and under `damage`. */
      fail: boolean;
      hurt: boolean;
      crit: boolean;
    }
    const attackRow = (odds_: Odds, damage: Dist, critDamage: Dist): (() => RowOutcome[]) => () => [
      { p: 1 - odds_.hit - odds_.crit, dist: point(0), fail: false, hurt: false, crit: false },
      { p: odds_.hit, dist: damage, fail: true, hurt: true, crit: false },
      { p: odds_.crit, dist: critDamage, fail: true, hurt: true, crit: true },
    ];
    /** A save: the failure damage is d4 - 1 (0 to 3); a pass under saveHalf takes half of it, floored. */
    const saveRow = (saveHalf: boolean): (() => RowOutcome[]) => () => {
      const outcomes: RowOutcome[] = [];
      for (let face = 0; face <= 3; face++) {
        outcomes.push({ p: 0.6 / 4, dist: point(face), fail: true, hurt: face > 0, crit: false });
        const passed = saveHalf ? Math.floor(face / 2) : 0;
        outcomes.push({ p: 0.4 / 4, dist: point(passed), fail: false, hurt: passed > 0, crit: false });
      }
      return outcomes;
    };

    const rows = [
      attackRow(odds(7, 15), dice(1, 8, 4), dice(2, 8, 4)),
      saveRow(true),
      attackRow(odds(7, 15), dice(1, 8, 4), dice(2, 8, 4)),
      saveRow(false),
    ];
    const ids = ["attack 1", "attack 2", "attack 3", "attack 4"];
    const source = (): Turn => turn([sword, halfSave, sword, plainSave]);

    interface Rule {
      id: string;
      landing: "fail" | "damage";
      max: number;
      payload: (row: number) => Payload;
    }
    const capDamage: Rule = { id: "cap damage", landing: "damage", max: 2, payload: doubling(1, 6) };
    const capFail: Rule = { id: "cap fail", landing: "fail", max: 2, payload: doubling(2, 4) };
    const first: Rule = {
      id: "first",
      landing: "fail",
      max: 1,
      payload: (row) => (row === 1 ? doubling(1, 10)() : doubling(1, 4)()),
    };

    const withRiders = (base: Turn): Turn =>
      base
        .onEveryHit(d6, { id: capDamage.id, landing: capDamage.landing, max: capDamage.max, of: ids })
        .onEveryHit(roll(2, d4), { id: capFail.id, landing: capFail.landing, max: capFail.max, of: ids })
        .onFirstHit(d4, {
          id: first.id,
          landing: first.landing,
          of: ids,
          perSource: { "attack 2": { damage: d10 } },
        });

    /** Forward enumeration over the rows; state: applications used by each rule. */
    const enumerate = (rules: Rule[]): { total: Dist; used: number[]; applied: number[] } => {
      let states = new Map<string, Dist>([[rules.map(() => 0).join("|"), point(0)]]);
      rows.forEach((row, rowIndex) => {
        const next = new Map<string, Dist>();
        for (const [key, dist] of states) {
          const counts = key.split("|").map(Number);
          for (const outcome of row()) {
            let landed = convolve(dist, scaled(outcome.dist, outcome.p));
            const used = [...counts];
            rules.forEach((rule, r) => {
              const lands = rule.landing === "fail" ? outcome.fail : outcome.hurt;
              if (!lands || used[r] >= rule.max) return;
              used[r]++;
              const payload = rule.payload(rowIndex);
              landed = convolve(landed, outcome.crit ? payload.crit : payload.hit);
            });
            const to = used.join("|");
            const known = next.get(to);
            if (!known) next.set(to, landed);
            else for (const [value, p] of landed) known.set(value, (known.get(value) ?? 0) + p);
          }
        }
        states = next;
      });
      const total: Dist = new Map();
      const usedAtLeastOnce = rules.map(() => 0);
      const applied = rules.map(() => 0);
      for (const [key, dist] of states) {
        const counts = key.split("|").map(Number);
        let mass = 0;
        for (const [value, p] of dist) {
          total.set(value, (total.get(value) ?? 0) + p);
          mass += p;
        }
        counts.forEach((count, r) => {
          if (count > 0) usedAtLeastOnce[r] += mass;
          applied[r] += count * mass;
        });
      }
      return { total, used: usedAtLeastOnce, applied };
    };

    it("matches the enumeration at 1e-12: two capped kinds and a per-source first hit over attacks and saves", () => {
      const expected = enumerate([capDamage, capFail, first]);
      const t = withRiders(source());
      expectMatches(t.pmf, expected.total, 1e-12);
      [capDamage, capFail, first].forEach((rule, r) => {
        expect(t.fireProbability(rule.id)).toBeCloseTo(expected.used[r], 12);
        expect(t.expectedApplications(rule.id)).toBeCloseTo(expected.applied[r], 12);
      });
    });

    it("`damage` and `fail` over one row are different riders: a zero-damage failure lands only under `fail`", () => {
      const one = (landing: "fail" | "damage"): Turn =>
        turn(plainSave).onEveryHit(flat(10), { landing, max: 1, id: "rider" });
      // P(fail) = 0.6; a failure lands for `damage` only when it dealt more than 0 (3 of 4 faces).
      expect(one("fail").fireProbability("rider")).toBeCloseTo(0.6, 12);
      expect(one("damage").fireProbability("rider")).toBeCloseTo(0.6 * 0.75, 12);
    });

    it("a per-source first hit over a save row marks its fire slot only when the row lands under its kind", () => {
      const build = (landing: "fail" | "damage"): Turn =>
        turn([halfSave, sword])
          .onFirstHit(d6, { landing, of: ["attack 1", "attack 2"], id: "first", perSource: { "attack 1": { damage: d8 } } })
          .otherwise(d4, { id: "none" });
      for (const landing of ["fail", "damage"] as const) {
        const t = build(landing);
        // The save lands for `fail` on a failure (0.6), for `damage` on a failure of 1 to 3 or a pass of 2 to 3.
        const pSave = landing === "fail" ? 0.6 : 0.6 * 0.75 + 0.4 * 0.5;
        const pAny = 1 - (1 - pSave) * 0.35;
        expect(t.fireProbability("first")).toBeCloseTo(pAny, 12);
        expect(t.fireProbability("none")).toBeCloseTo(1 - pAny, 12);
      }
    });

    it("the threshold look-ahead reads a save row's landing under the kind of the fold that watches it", () => {
      // F is a first hit over the save row (folded, because it has a payload per source), N its
      // negation, S a threshold reroll over the sword and N. Holding the sword's roll is only worth
      // it while N can still fire, which depends on whether the save landed under F's kind.
      const build = (folded: boolean, landing: "fail" | "damage"): Turn =>
        turn([sword, halfSave])
          .onFirstHit(d6, {
            id: "F",
            landing,
            of: ["attack 2"],
            ...(folded ? { perSource: { "attack 2": { damage: d6 } } } : {}),
          })
          .otherwise(knife, { id: "N" })
          .onFirstHit(keepBestDamage().ifBelow({ hit: 9, crit: 15 }), { id: "S", of: ["attack 1", "N"] });
      for (const landing of ["fail", "damage"] as const) {
        const folded = build(true, landing);
        const step = build(false, landing);
        expect(maxDiff(folded.pmf, step.pmf)).toBeLessThan(1e-13);
        for (const id of ["F", "N", "S"]) {
          expect(folded.fireProbability(id)).toBeCloseTo(step.fireProbability(id), 12);
        }
      }
    });

    it("a probe beside the capped riders reads the same walk and leaves everything else alone", () => {
      const plain = withRiders(source());
      const probed = withRiders(source()).observeAnyCrit("crit", { of: ["attack 1", "attack 3"] });
      expect(probed.fireProbability("crit")).toBeCloseTo(1 - 0.95 ** 2, 12);
      expect(bins(probed.pmf)).toEqual(bins(plain.pmf));
      for (const id of [capDamage.id, capFail.id, first.id]) {
        expect(probed.fireProbability(id)).toBe(plain.fireProbability(id));
        expect(probed.expectedApplications(id)).toBe(plain.expectedApplications(id));
      }
      // A probe over the rows a capped rider watches, read before anything else: same number.
      const probeFirst = withRiders(source()).observeAnyCrit("crit", { of: ["attack 1", "attack 3"] });
      expect(probeFirst.fireProbability("crit")).toBeCloseTo(1 - 0.95 ** 2, 12);
      expect(probeFirst.expectedApplications(capDamage.id)).toBeCloseTo(plain.expectedApplications(capDamage.id), 15);
    });

    it("a save row with a landing kind is still refused without one, capped or not", () => {
      const code = (build: () => Turn): string | undefined => codeOf(build);
      expect(code(() => turn([sword, halfSave]).onEveryHit(d6, { max: 1 }))).toBe("not-an-attack");
      expect(code(() => turn([sword, halfSave]).onEveryHit(d6, { max: 2 }))).toBe("not-an-attack");
    });
  });

  describe("refusals", () => {
    it("needs a positive integer max", () => {
      for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => turn([sword]).onEveryHit(d6, { max })).toThrow(RangeError);
      }
    });

    it("refuses a max on any other trigger", () => {
      // @ts-expect-error a first-hit rider has no max: it already applies once
      const spec: Rider = { on: "first-hit", max: 1, damage: d6 };
      expect(codeOf(() => Turn.from({ attacks: [sword], riders: [spec] }))).toBe("unsupported-trigger");
      // @ts-expect-error onFirstHit has no max option
      expect(codeOf(() => turn([sword]).onFirstHit(d6, { max: 1 }))).toBe("unsupported-trigger");
      // @ts-expect-error onAnyCrit has no max option
      expect(codeOf(() => turn([sword]).onAnyCrit(d6, { max: 1 }))).toBe("unsupported-trigger");
    });

    it("refuses a max or a payload per source beside a grant", () => {
      const grant = advantage().untilNextAttack();
      expect(() => turn([sword, sword]).onEveryHit(grant, { max: 1 })).toThrow(/never capped/);
      expect(() => turn([sword, sword]).onEveryHit([d6, grant], { max: 1 })).toThrow(/never capped/);
      expect(() =>
        turn([sword, sword]).onEveryHit(grant, { perSource: { "attack 1": { damage: d6 } } })
      ).toThrow(/no payload/);
      expect(() =>
        turn([sword, sword]).onFirstHit(grant, { perSource: { "attack 1": { damage: d6 } } })
      ).toThrow(/no payload/);
    });

    it("refuses a payload per source beside a transform", () => {
      expect(() =>
        turn([sword, sword]).onFirstHit(keepBestDamage(), { perSource: { "attack 1": { damage: d6 } } })
      ).toThrow(/no payload per source/);
    });

    it("refuses a payload for a source the rider does not watch", () => {
      for (const verb of ["onEveryHit", "onFirstHit"] as const) {
        expect(
          codeOf(() =>
            turn([sword, sword])[verb](d6, { of: ["attack 1"], perSource: { "attack 2": { damage: d4 } } })
          )
        ).toBe("unknown-id");
        expect(
          codeOf(() => turn([sword, sword])[verb](d6, { perSource: { nowhere: { damage: d4 } } }))
        ).toBe("unknown-id");
      }
    });

    it("refuses a payload per source on a trigger that takes none", () => {
      // @ts-expect-error an any-crit rider has no payload per source
      const spec: Rider = { on: "any-crit", damage: d6, perSource: { "attack 1": { damage: d4 } } };
      expect(codeOf(() => Turn.from({ attacks: [sword], riders: [spec] }))).toBe("unsupported-trigger");
      // @ts-expect-error onAnyCrit has no payload per source
      expect(codeOf(() => turn([sword]).onAnyCrit(d6, { perSource: { "attack 1": { damage: d4 } } }))).toBe(
        "unsupported-trigger"
      );
    });

    it("cannot negate or watch a rider that can apply more than once, or one folded per source", () => {
      const capped = turn([sword, sword, sword]).onEveryHit(d6, { max: 2, id: "capped" });
      expect(codeOf(() => capped.otherwise(d4))).toBe("not-an-attack");
      expect(codeOf(() => capped.onFirstHit(d4, { of: ["capped"] }))).toBe("not-an-attack");
      const perSource = turn([sword, sword]).onFirstHit(d6, {
        id: "folded",
        perSource: { "attack 2": { damage: d8 } },
      });
      expect(codeOf(() => perSource.onFirstHit(d4, { of: ["folded"] }))).toBe("not-an-attack");
    });

    it("bounds the capped riders that watch one attack", () => {
      // Caps of 1 are first hits and take no counter, so the counters start at 2.
      let t = turn().attacks(9, sword);
      for (let cap = 2; cap < 2 + MAX_CAPPED_COUNTERS; cap++) t = t.onEveryHit(d4, { max: cap });
      expect(codeOf(() => t.onEveryHit(d4, { max: 2 + MAX_CAPPED_COUNTERS }))).toBe("too-many-counters");
    });

    it("answers expectedApplications for every rider, and only for riders", () => {
      const t = turn([sword, sword])
        .onFirstHit(d6, { id: "sneak" })
        .onEveryHit(d4, { id: "mark" })
        .onAnyCrit(d8, { id: "smite" });
      expect(t.expectedApplications("mark")).toBeCloseTo(2 * 0.65, 12);
      expect(t.expectedApplications("sneak")).toBe(t.fireProbability("sneak"));
      expect(t.expectedApplications("smite")).toBe(t.fireProbability("smite"));
      expect(codeOf(() => t.expectedApplications("attack 1"))).toBe("unknown-id");
      const substituted = turn([sword, sword]).onFirstHit(keepBestDamage(), { id: "reroll" });
      expect(codeOf(() => substituted.expectedApplications("reroll"))).toBe("unknown-id");
    });
  });
});
