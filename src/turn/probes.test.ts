import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advantage,
  bounce,
  critOnHit,
  d6,
  d8,
  d20,
  keepBestDamage,
  roll,
  turn,
  Turn,
  TurnSpecError,
} from "../builder";
import { calculateBounceOdds } from "../common/bounce";
import { PMF } from "../pmf/pmf";
import { inspectTurn } from "./turn";
import { MAX_TRIGGER_GROUPS } from "./types";

// `d20+5` vs AC 12: miss 0.30, hit 0.65, crit 0.05 (advantage: 0.09 / 0.8125 / 0.0975); `1d8+3`
// on a hit, `2d8+3` on a crit. Every expected probability below is worked by hand from those.
const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
const advSword = d20.withAdvantage().plus(5).ac(12).onHit(roll(1, d8).plus(3));
const nothing = PMF.delta(0);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
}

function maxDiff(a: PMF, b: PMF): number {
  let worst = 0;
  for (const value of new Set([...a.support(), ...b.support()])) {
    worst = Math.max(worst, Math.abs(a.pAt(value) - b.pAt(value)));
  }
  return worst;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("observeAnyCrit: P(at least one of the sources crit)", () => {
  it("is 1 - 0.95^N over N plain swings", () => {
    for (const swings of [1, 2, 4]) {
      const t = turn().attacks(swings, sword).observeAnyCrit("crit");
      expect(t.fireProbability("crit")).toBeCloseTo(1 - 0.95 ** swings, 12);
    }
  });

  it("reads only the sources named in `of`", () => {
    const t = turn([sword, sword, sword]).observeAnyCrit("outer", { of: ["attack 1", "attack 3"] });
    expect(t.fireProbability("outer")).toBeCloseTo(1 - 0.95 ** 2, 12);
  });

  it("follows each source's own crit odds: advantage doubles a swing's 0.05 to 0.0975", () => {
    const t = turn([advSword, sword]).observeAnyCrit("crit");
    expect(t.fireProbability("crit")).toBeCloseTo(1 - 0.9025 * 0.95, 12);
  });

  it("counts an attack that only happens half the time at half its crit odds", () => {
    const t = turn().attack(sword).attack(sword, { chance: 0.5 }).observeAnyCrit("crit");
    expect(t.fireProbability("crit")).toBeCloseTo(1 - 0.95 * (1 - 0.5 * 0.05), 12);
  });

  it("sees a crit-on-hit grant: a first hit makes the next landing a crit", () => {
    // attack 1 crits (0.05), or hits (0.65) and attack 2 then crits when it lands (0.70), or
    // misses (0.30) and attack 2 crits on a natural 20 (0.05).
    const t = turn([sword, sword]).onFirstHit(critOnHit().untilEndOfTurn()).observeAnyCrit("crit");
    expect(t.fireProbability("crit")).toBeCloseTo(0.05 + 0.65 * 0.7 + 0.3 * 0.05, 12);
  });

  it("sees a crit-on-hit grant that takes only with probability `chance`", () => {
    const t = turn([sword, sword])
      .onFirstHit(critOnHit().untilEndOfTurn(), { chance: 0.4 })
      .observeAnyCrit("crit");
    expect(t.fireProbability("crit")).toBeCloseTo(0.05 + 0.65 * (0.4 * 0.7 + 0.6 * 0.05) + 0.3 * 0.05, 12);
  });

  it("counts a reroll's crit when the reroll is named, and not when it is not", () => {
    const base = turn(sword).onFirstMiss(sword, { id: "reroll" });
    // The default `of` is the attacks plus the rerolls declared so far.
    expect(base.observeAnyCrit("all").fireProbability("all")).toBeCloseTo(0.05 + 0.3 * 0.05, 12);
    expect(base.observeAnyCrit("both", { of: ["attack 1", "reroll"] }).fireProbability("both")).toBeCloseTo(
      0.05 + 0.3 * 0.05,
      12
    );
    expect(base.observeAnyCrit("first", { of: ["attack 1"] }).fireProbability("first")).toBeCloseTo(0.05, 12);
  });

  it("sees a bounce chain's beams: a beam fires only after the one before matched", () => {
    // No crit anywhere: a beam misses (0.55), or hits (0.40) and either stops (dice unmatched) or
    // goes on (matched, 3d8 matches with calculateBounceOdds(3, 8)); a crit ends the search.
    const orb = d20.plus(5).ac(17).onHit(roll(3, d8));
    const matches = calculateBounceOdds(3, 8);
    let noCrit = 0.95;
    for (let follow = 1; follow <= 3; follow++) {
      noCrit = 0.55 + 0.4 * (1 - matches) + 0.4 * matches * noCrit;
    }
    const t = bounce({ source: orb, max: 3 }).observeAnyCrit("crit", {
      of: ["attack 1", "bounce 1", "bounce 2", "bounce 3"],
    });
    expect(t.fireProbability("crit")).toBeCloseTo(1 - noCrit, 12);
  });
});

describe("a probe agrees with the zero-damage `onAnyCrit` rider that used to stand in for it", () => {
  const orb = d20.plus(5).ac(17).onHit(roll(3, d8));
  const beams = ["attack 1", "bounce 1", "bounce 2", "bounce 3"];
  const cases: { name: string; base: () => Turn; of?: string[] }[] = [
    { name: "plain", base: () => turn([sword, sword, sword]) },
    { name: "advantage and plain", base: () => turn([advSword, sword]) },
    { name: "an attack that may not happen", base: () => turn().attack(sword).attack(sword, { chance: 0.5 }) },
    {
      name: "a saved crit-on-hit grant and a next-attack grant",
      base: () =>
        turn([sword, sword, sword])
          .onFirstHit(critOnHit().untilEndOfTurn(), { chance: 0.4 })
          .onEveryHit(advantage().untilNextAttack()),
    },
    { name: "a first-miss reroll", base: () => turn([sword, sword]).onFirstMiss(sword, { id: "reroll" }) },
    { name: "an any-miss reroll", base: () => turn([sword, sword]).onAnyMiss(sword, { id: "reroll" }) },
    {
      name: "a threshold substitute",
      base: () => turn([sword, sword]).onFirstHit(keepBestDamage().ifBelow({ hit: 9, crit: 20 })),
    },
    { name: "a sneak attack beside it", base: () => turn([sword, sword]).onFirstHit(roll(3, d6)) },
    { name: "a bounce chain", base: () => bounce({ source: orb, max: 3 }), of: beams },
  ];

  for (const { name, base, of } of cases) {
    it(`${name}: same probability at 1e-12, and the same damage as without it`, () => {
      const options = of === undefined ? {} : { of };
      const probed = base().observeAnyCrit("probe", options);
      const stood = base().onAnyCrit(nothing, { id: "ref", ...options });
      expect(probed.fireProbability("probe")).toBeCloseTo(stood.fireProbability("ref"), 12);
      // No damage is added: the probe's turn deals exactly what the same turn without it deals.
      expect(maxDiff(probed.pmf, base().pmf)).toBeLessThan(1e-12);
      expect(probed.mean()).toBeCloseTo(base().mean(), 12);
    });
  }
});

describe("a probe is read from a walk that carries no damage", () => {
  const convolving = (): Turn =>
    turn([sword, sword, sword])
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onEveryHit(critOnHit().untilNextAttack(), { chance: 0.5 })
      .observeAnyCrit("crit");

  it("agrees with the full walk's value for a rider over the same sources", () => {
    const stood = turn([sword, sword, sword])
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onEveryHit(critOnHit().untilNextAttack(), { chance: 0.5 })
      .onAnyCrit(nothing, { id: "ref" });
    expect(convolving().fireProbability("crit")).toBeCloseTo(stood.fireProbability("ref"), 12);
  });

  it("does not depend on whether the damage was resolved first", () => {
    const first = convolving();
    const before = first.fireProbability("crit");
    first.mean();
    expect(first.fireProbability("crit")).toBe(before);
  });
});

describe("probes as plain data", () => {
  it("Turn.from takes `observe` and reads the same as the fluent spelling", () => {
    const observe = [
      { id: "crit", on: "any-crit", of: ["a", "b"] },
      { on: "any-crit", of: ["a"] },
    ] as const;
    const attacks = [
      { id: "a", source: sword },
      { id: "b", source: sword },
    ];
    const fromData = Turn.from({ attacks, observe: JSON.parse(JSON.stringify(observe)) });
    expect(fromData.probeIds).toEqual(["crit", "probe 2"]);
    expect(fromData.fireProbability("crit")).toBeCloseTo(1 - 0.95 ** 2, 12);
    expect(fromData.fireProbability("probe 2")).toBeCloseTo(0.05, 12);

    const fluent = turn().attack(sword, "a").attack(sword, "b").observeAnyCrit("crit");
    expect(fluent.fireProbability("crit")).toBe(fromData.fireProbability("crit"));
  });

  it("an omitted `of` watches every attack plus every attack-shaped reroll", () => {
    const t = Turn.from({
      attacks: [sword, sword],
      riders: [{ id: "reroll", on: "first-miss", damage: sword }],
      observe: [{ id: "crit", on: "any-crit" }],
    });
    // No crit anywhere: attack 1 crits (0.05) or not; on a miss (0.30) the reroll and attack 2
    // both fail to crit (0.95 each); on a hit (0.65) attack 2 either lands non-crit (0.65), or
    // misses (0.30) and the reroll fails to crit (0.95). Without the reroll it would be 0.0975.
    const noCrit = 0.3 * 0.95 * 0.95 + 0.65 * (0.65 + 0.3 * 0.95);
    expect(t.fireProbability("crit")).toBeCloseTo(1 - noCrit, 12);
    expect(1 - noCrit).toBeCloseTo(0.1215, 12);
  });

  it("the chaining call snapshots the default `of`, so an attack added after it throws", () => {
    expect(codeOf(() => turn(sword).observeAnyCrit("crit").attack(sword))).toBe("attack-after-rider");
    expect(() => turn(sword).observeAnyCrit("crit", { of: ["attack 1"] }).attack(sword)).not.toThrow();
  });

  it("vsAC keeps the probes", () => {
    const t = turn([advSword]).observeAnyCrit("crit").vsAC(9);
    expect(t.fireProbability("crit")).toBeCloseTo(0.0975, 12);
  });
});

describe("probe validation", () => {
  it("refuses a probe that observes anything but any-crit", () => {
    const spec = { attacks: [sword], observe: [{ id: "p", on: "any-miss" }] };
    expect(codeOf(() => Turn.from(spec as never))).toBe("unsupported-trigger");
  });

  it("shares one id space with attacks, riders, substitutes and conditions", () => {
    expect(codeOf(() => turn(sword).onFirstHit(d6, { id: "x" }).observeAnyCrit("x"))).toBe("duplicate-id");
    expect(codeOf(() => turn(sword).observeAnyCrit("attack 1"))).toBe("duplicate-id");
    expect(codeOf(() => turn(sword).observeAnyCrit("x").observeAnyCrit("x"))).toBe("duplicate-id");
    expect(codeOf(() => Turn.from({ attacks: [sword], observe: [{ id: 7 as never, on: "any-crit" }] }))).toBe(
      "non-string-id"
    );
  });

  it("cannot be watched, and its `of` follows a rider's rules", () => {
    expect(codeOf(() => turn(sword).observeAnyCrit("p").onFirstHit(d6, { of: ["p"] }))).toBe("not-an-attack");
    expect(codeOf(() => turn(sword).observeAnyCrit("p", { of: ["nowhere"] }))).toBe("unknown-id");
    expect(codeOf(() => turn(sword).observeAnyCrit("p", { of: [] }))).toBe("unknown-id");
    expect(codeOf(() => turn(sword).onFirstHit(d6, { id: "dmg" }).observeAnyCrit("p", { of: ["dmg"] }))).toBe(
      "not-an-attack"
    );
  });

  it("is named by fireProbability's unknown-id error", () => {
    const t = turn(sword).observeAnyCrit("crit");
    expect(codeOf(() => t.fireProbability("attack 1"))).toBe("unknown-id");
    expect(() => t.fireProbability("nothing")).toThrow(/"crit"/);
  });
});

describe("a probe keeps its group live to the end, and the cap counts it", () => {
  const orb = d20.plus(5).ac(17).onHit(roll(3, d8));

  it("keeps each probed beam's group live to the end: one slot per probed source set", () => {
    const beams = bounce({ source: orb, max: 3 });
    expect(inspectTurn(beams).groupCount).toBe(2);
    // A probe over the last beam takes a slot a dead group has freed, so it costs nothing extra.
    expect(inspectTurn(beams.observeAnyCrit("last", { of: ["bounce 3"] })).groupCount).toBe(2);
    let probed = beams;
    for (const beam of [1, 2, 3]) probed = probed.observeAnyCrit(`beam ${beam}`, { of: [`bounce ${beam}`] });
    expect(inspectTurn(probed).groupCount).toBe(3);
  });

  it("shares the group a rider over the same sources already has", () => {
    const t = turn([sword, sword]).onFirstHit(d6).observeAnyCrit("crit");
    expect(inspectTurn(t).groupCount).toBe(1);
  });

  it("lets a group that would die in the chain live on: nine probes over a long chain no longer fit", () => {
    const chain = bounce({ source: orb, max: 12 });
    expect(inspectTurn(chain).groupCount).toBe(2);
    const probeBeams = (count: number): Turn => {
      let t = chain;
      for (let k = 1; k <= count; k++) t = t.observeAnyCrit(`probe ${k}`, { of: [`bounce ${k}`] });
      return t;
    };
    expect(() => probeBeams(1).fireProbability("probe 1")).not.toThrow();
    expect(codeOf(() => probeBeams(MAX_TRIGGER_GROUPS))).toBe("too-many-groups");
  });

  it("a tenth source set live at once throws", () => {
    const ids = ["attack 1", "attack 2", "attack 3", "attack 4"];
    const sets: string[][] = [];
    for (let mask = 1; mask < 1 << ids.length; mask++) sets.push(ids.filter((_, bit) => mask & (1 << bit)));
    let t = turn([sword, sword, sword, sword]);
    sets.slice(0, MAX_TRIGGER_GROUPS).forEach((of, i) => {
      t = t.onFirstHit(d6, { of, id: `group ${i + 1}` });
    });
    expect(codeOf(() => t.observeAnyCrit("tenth", { of: sets[MAX_TRIGGER_GROUPS] }))).toBe("too-many-groups");
    expect(inspectTurn(t.observeAnyCrit("shared", { of: sets[0] })).groupCount).toBe(MAX_TRIGGER_GROUPS);
  });
});

describe("a probe skips the rows that cannot crit", () => {
  const save = d20.dc(13).onSaveFailure(roll(8, d6)).saveHalf();

  it("a save row beside an attack, by default `of`", () => {
    expect(turn([sword, save]).observeAnyCrit("crit").fireProbability("crit")).toBeCloseTo(0.05, 12);
  });

  it("a flat payload beside an attack, by default `of`", () => {
    expect(turn([sword, PMF.delta(7)]).observeAnyCrit("crit").fireProbability("crit")).toBeCloseTo(0.05, 12);
  });

  it("the same turn as plain data", () => {
    const t = Turn.from({
      attacks: [sword, save, PMF.delta(7), sword],
      observe: [{ id: "crit", on: "any-crit" }],
    });
    expect(t.fireProbability("crit")).toBeCloseTo(1 - 0.95 ** 2, 12);
  });

  it("an explicit `of` names such rows too, and a probe with nothing that can crit reports 0", () => {
    const t = turn([sword, save]).observeAnyCrit("crit", { of: ["attack 1", "attack 2"] });
    expect(t.fireProbability("crit")).toBeCloseTo(0.05, 12);
    const none = turn([sword, save]).observeAnyCrit("none", { of: ["attack 2"] });
    expect(none.fireProbability("none")).toBe(0);
    expect(inspectTurn(none).groupCount).toBe(0);
  });
});

describe("a probe leaves everything else the turn reports as it was, bit for bit", () => {
  const plain = (): Turn =>
    turn([sword, sword, sword])
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onEveryHit(critOnHit().untilNextAttack(), { chance: 0.5 });

  it("the distribution, other ids and stepStats are exactly the same with a probe", () => {
    const without = plain();
    const probed = plain().observeAnyCrit("crit");
    expect(probed.fireProbability("sneak")).toBe(without.fireProbability("sneak"));
    expect(probed.stepStats("attack 2")).toEqual(without.stepStats("attack 2"));
    expect(probed.pmf.mean()).toBe(without.pmf.mean());
    expect(probed.pmf.variance()).toBe(without.pmf.variance());
    for (const value of without.pmf.support()) {
      expect(probed.pmf.pAt(value)).toBe(without.pmf.pAt(value));
    }
  });
});
