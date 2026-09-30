import { describe, expect, it } from "vitest";
import {
  advantage,
  bounce,
  d6,
  d8,
  d20,
  flat,
  keepBestDamage,
  roll,
  turn,
} from "../builder";
import type { PMF } from "../pmf/pmf";
import { inspectTurn } from "./turn";
import { MAX_TRIGGER_GROUPS } from "./types";

// `d20+5` vs AC 12: miss 0.30, hit 0.65 (`1d8+3`), crit 0.05 (`2d8+3`).
const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
// A Chromatic Orb: `d20+5` vs AC 17: miss 0.55, hit 0.40 (`3d8`), crit 0.05 (`6d8`).
const orb = d20.plus(5).ac(17).onHit(roll(3, d8));

type Dist = Map<number, number>;

function fromPMF(pmf: PMF): Dist {
  return new Map(pmf.support().map((value) => [value, pmf.pAt(value)]));
}

function maxDiff(actual: PMF, expected: Dist): number {
  let worst = 0;
  for (const value of new Set([...actual.support(), ...expected.keys()])) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)));
  }
  return worst;
}

/** Every roll of `dice` d`faces`, as the mass of each sum split by whether two dice matched. */
function bruteForceMatch(dice: number, faces: number): { matched: Dist; unmatched: Dist } {
  const matched: Dist = new Map();
  const unmatched: Dist = new Map();
  const total = faces ** dice;
  for (let n = 0; n < total; n++) {
    const rolls: number[] = [];
    for (let rest = n, i = 0; i < dice; i++, rest = Math.floor(rest / faces)) rolls.push((rest % faces) + 1);
    const sum = rolls.reduce((all, each) => all + each, 0);
    const target = new Set(rolls).size < dice ? matched : unmatched;
    target.set(sum, (target.get(sum) ?? 0) + 1 / total);
  }
  return { matched, unmatched };
}

describe("a bounce chain keeps two groups live, however long", () => {
  // Beams past the first are dice-match riders: beam i + 1 fires iff beam i's dice matched. The
  // oracle is a recursion over brute-forced per-sum match masses, with no walk in it:
  // chain(k) = sum over a beam's outcomes of (its damage) + (chain(k - 1) if its dice matched).
  const hit = bruteForceMatch(3, 8);
  const crit = bruteForceMatch(6, 8);
  const outcomes: { p: number; damage: number; matched: boolean }[] = [{ p: 0.55, damage: 0, matched: false }];
  for (const [chance, { matched, unmatched }] of [[0.4, hit], [0.05, crit]] as const) {
    for (const [damage, mass] of matched) outcomes.push({ p: chance * mass, damage, matched: true });
    for (const [damage, mass] of unmatched) outcomes.push({ p: chance * mass, damage, matched: false });
  }
  const pMatch = outcomes.filter((each) => each.matched).reduce((all, each) => all + each.p, 0);

  function chain(beams: number): Dist {
    if (beams === 0) {
      const first: Dist = new Map();
      for (const { p, damage } of outcomes) first.set(damage, (first.get(damage) ?? 0) + p);
      return first;
    }
    const rest = chain(beams - 1);
    const out: Dist = new Map();
    for (const { p, damage, matched } of outcomes) {
      if (!matched) {
        out.set(damage, (out.get(damage) ?? 0) + p);
        continue;
      }
      for (const [more, q] of rest) out.set(damage + more, (out.get(damage + more) ?? 0) + p * q);
    }
    return out;
  }

  it("resolves a chain past the old budget of total groups", () => {
    for (const max of [MAX_TRIGGER_GROUPS + 1, MAX_TRIGGER_GROUPS + 3]) {
      const t = bounce({ source: orb, max });
      expect(maxDiff(t.pmf, chain(max))).toBeLessThan(1e-12);
      expect(t.pmf.mass()).toBeCloseTo(1, 12);
    }
  });

  it("holds two live groups at a time: the group count is the peak, not the number of beams", () => {
    expect(inspectTurn(bounce({ source: orb, max: 1 })).groupCount).toBe(1);
    for (const max of [2, 5, 9, 12]) {
      expect(inspectTurn(bounce({ source: orb, max })).groupCount).toBe(2);
    }
  });

  it("beam k fires with probability P(match)^k", () => {
    const t = bounce({ source: orb, max: 11 });
    for (const k of [1, 4, 10, 11]) {
      expect(t.fireProbability(`bounce ${k}`)).toBeCloseTo(pMatch ** k, 12);
    }
  });
});

describe("groups with disjoint lives share a slot", () => {
  // "On a hit, a bonus attack": link k + 1 is an attack-shaped rider that fires on the first landing
  // of link k, and each link's group dies after that one reader. No dice-match involved. The
  // oracle is a recursion over one swing's outcomes:
  // chain(k) = sum over a swing's outcomes of its damage + (chain(k - 1) if it landed).
  const swing = fromPMF(sword.toPMF());
  const P_LAND = 0.7;

  function chain(links: number, perLanding: number): Dist {
    const out: Dist = new Map();
    const rest = links === 1 ? undefined : chain(links - 1, perLanding);
    for (const [value, mass] of swing) {
      if (value === 0) {
        out.set(0, (out.get(0) ?? 0) + mass);
        continue;
      }
      for (const [more, q] of rest ?? new Map([[0, 1]])) {
        out.set(value + perLanding + more, (out.get(value + perLanding + more) ?? 0) + mass * q);
      }
    }
    return out;
  }

  function hitChain(links: number) {
    let t = turn(sword);
    let previous = "attack 1";
    for (let k = 2; k <= links; k++) {
      t = t.onFirstHit(sword, { of: [previous], id: `link ${k}` });
      previous = `link ${k}`;
    }
    return t;
  }

  it("resolves more source sets than the budget when no more than the budget are live", () => {
    const links = MAX_TRIGGER_GROUPS + 3;
    const t = hitChain(links);
    expect(maxDiff(t.pmf, chain(links, 0))).toBeLessThan(1e-12);
    expect(inspectTurn(t).groupCount).toBe(2);
    for (const k of [2, 6, links]) {
      expect(t.fireProbability(`link ${k}`)).toBeCloseTo(P_LAND ** (k - 1), 12);
    }
  });

  it("a group that lives to the end shares the walk with dying ones", () => {
    // Every-hit reads its group at the final collapse, so its slot is never reused.
    const links = MAX_TRIGGER_GROUPS + 1;
    const ids = ["attack 1", ...Array.from({ length: links - 1 }, (_, i) => `link ${i + 2}`)];
    const t = hitChain(links).onEveryHit(flat(2), { of: ids, id: "mark" });
    expect(maxDiff(t.pmf, chain(links, 2))).toBeLessThan(1e-12);
    expect(inspectTurn(t).groupCount).toBe(3);
    expect(t.fireProbability("mark")).toBeCloseTo(P_LAND, 12);
  });

  it("a reused slot starts from a group that has seen nothing", () => {
    // Attack i's grant is `first-hit` over attack i alone, which is "attack i landed": the
    // next attack has advantage exactly when it did. A stale code from the group before, still
    // in the slot, would read as "already landed" and skip the grant. The oracle needs no group.
    let grants = turn().attacks(6, sword);
    for (let i = 1; i <= 5; i++) {
      grants = grants.onFirstHit(advantage().untilNextAttack(), { of: [`attack ${i}`] });
    }
    const everyHit = turn().attacks(6, sword).onEveryHit(advantage().untilNextAttack());
    expect(maxDiff(grants.pmf, fromPMF(everyHit.pmf))).toBeLessThan(1e-12);
    expect(inspectTurn(grants).groupCount).toBe(1);
    expect(inspectTurn(everyHit).groupCount).toBe(0);
  });

  it("a group nothing reads is not live: a grant no later attack reads takes no slot", () => {
    const granted = turn([sword, sword]).onFirstHit(advantage().untilNextAttack(), { of: ["attack 2"] });
    expect(inspectTurn(granted).groupCount).toBe(0);
    expect(maxDiff(granted.pmf, fromPMF(turn([sword, sword]).pmf))).toBe(0);
  });
});

describe("a threshold substitute's look-ahead reads released slots as empty", () => {
  // The substitute holds a landing only while a later step it watches can still land, which it
  // decides by simulating the steps ahead over the same group codes. Attack 2 never happens, so
  // nothing after attack 1 can land and the substitute must spend on any landing: exactly
  // `keepBestDamage()` on attack 1. A stale code in a reused slot would let `bonus` (a rider over
  // attack 2's group) look able to fire, and the substitute would hold instead.
  const low = { hit: 1, crit: 1 };
  const never = { id: "attack 2", chance: 0 };
  const oracle = turn().attack(sword, "attack 1").attack(sword, never).onFirstHit(keepBestDamage(), {
    of: ["attack 1"],
  });

  it("across a step that does not fire, whose group's last read releases the slot", () => {
    const t = turn()
      .attack(sword, "attack 1")
      .attack(sword, never)
      .onFirstMiss(sword, { of: ["attack 1"], id: "reroll" })
      .onFirstHit(sword, { of: ["attack 2"], id: "bonus" })
      .onFirstHit(keepBestDamage().ifBelow(low), { of: ["attack 1", "bonus"], id: "keep" });
    expect(inspectTurn(t).groupCount).toBe(1);
    // The reroll adds its own damage on a miss; the substitute only rewrites attack 1's landing.
    const rerolled = turn()
      .attack(sword, "attack 1")
      .attack(sword, never)
      .onFirstMiss(sword, { of: ["attack 1"], id: "reroll" })
      .onFirstHit(keepBestDamage(), { of: ["attack 1"], id: "keep" });
    expect(maxDiff(t.pmf, fromPMF(rerolled.pmf))).toBeLessThan(1e-12);
    expect(t.fireProbability("keep")).toBeCloseTo(0.7, 12);
  });

  it("at the step whose own group is released", () => {
    // attack 1's grant reads its group at attack 1's own step and is done there.
    const t = turn()
      .attack(sword, "attack 1")
      .attack(sword, never)
      .onFirstHit(advantage().untilNextAttack(), { of: ["attack 1"] })
      .onFirstHit(sword, { of: ["attack 2"], id: "bonus" })
      .onFirstHit(keepBestDamage().ifBelow(low), { of: ["attack 1", "bonus"], id: "keep" });
    expect(inspectTurn(t).groupCount).toBe(1);
    expect(maxDiff(t.pmf, fromPMF(oracle.pmf))).toBeLessThan(1e-12);
  });

  it("across a step that fires, which releases its own group's slot", () => {
    // Attacks 1 and 2 each have a grant over just themselves: two groups, one slot, each dead
    // after its own step. Attack 2 lands (or not) in the look-ahead and would leave a stale
    // "landed" code behind for `bonus`'s group, which reuses the slot.
    const grants = (t: ReturnType<typeof turn>) =>
      t
        .onFirstHit(advantage().untilNextAttack(), { of: ["attack 1"] })
        .onFirstHit(advantage().untilNextAttack(), { of: ["attack 2"] });
    const base = () => turn().attack(sword, "attack 1").attack(sword, "attack 2").attack(sword, { id: "attack 3", chance: 0 });
    const t = grants(base())
      .onFirstHit(sword, { of: ["attack 3"], id: "bonus" })
      .onFirstHit(keepBestDamage().ifBelow(low), { of: ["attack 1", "bonus"], id: "keep" });
    const spent = grants(base()).onFirstHit(keepBestDamage(), { of: ["attack 1"] });
    expect(inspectTurn(t).groupCount).toBe(1);
    expect(maxDiff(t.pmf, fromPMF(spent.pmf))).toBeLessThan(1e-12);
  });

  it("across a damage rider that is the last to read a group", () => {
    // `damage` reads attack 1's group and deals plain damage; `flurry` fires only when it did not
    // (never, once attack 1 has landed), and `follow` reads the flurry's group, in the same slot.
    const chain = () =>
      turn(sword)
        .onFirstHit(flat(1), { of: ["attack 1"], id: "damage" })
        .otherwise(sword, { id: "flurry" })
        .onFirstHit(sword, { of: ["flurry"], id: "follow" });
    const t = chain().onFirstHit(keepBestDamage().ifBelow(low), { of: ["attack 1", "follow"], id: "keep" });
    const spent = chain().onFirstHit(keepBestDamage(), { of: ["attack 1", "follow"] });
    expect(inspectTurn(t).groupCount).toBe(1);
    expect(maxDiff(t.pmf, fromPMF(spent.pmf))).toBeLessThan(1e-12);
  });
});

describe("turns that fit the old cap are bit for bit what the walk gave before groups shared slots", () => {
  // Recorded from 6a6233f (#20: 0.14.2 plus content-addressed PMF identifiers): the same turns, before groups shared slots.
  const pin = (t: { pmf: PMF }, expected: { mean: number; variance: number; p0: number }): void => {
    expect(t.pmf.mean()).toBe(expected.mean);
    expect(t.pmf.variance()).toBe(expected.variance);
    expect(t.pmf.pAt(0)).toBe(expected.p0);
  };

  it("a 9-beam bounce chain", () => {
    const t = bounce({ source: orb, max: 9 });
    pin(t, { mean: 8.268560386709098, variance: 138.0756075547243, p0: 0.55 });
    expect(t.fireProbability("bounce 1")).toBe(0.1836547851562501);
    expect(t.fireProbability("bounce 9")).toBe(2.3769510383393754e-7);
  });

  it("nine overlapping first-hit groups, over four attacks", () => {
    const ids = ["attack 1", "attack 2", "attack 3", "attack 4"];
    const sets: string[][] = [];
    for (let mask = 1; mask < 1 << ids.length; mask++) sets.push(ids.filter((_, bit) => mask & (1 << bit)));
    let t = turn([sword, sword, sword, sword]);
    sets.slice(0, MAX_TRIGGER_GROUPS).forEach((of, i) => {
      t = t.onFirstHit(roll(1, d6), { of, id: `group ${i + 1}` });
    });
    pin(t, { mean: 49.69874999999998, variance: 250.84099843749993, p0: 0.008100000000000008 });
    expect(inspectTurn(t).groupCount).toBe(MAX_TRIGGER_GROUPS);
  });

  it("a reroll per attack, with a threshold substitute reading the walk ahead", () => {
    // The substitute's look-ahead simulates the later steps' group codes, across the slot reuse.
    let t = turn().attacks(5, sword);
    for (let i = 1; i <= 4; i++) t = t.onFirstMiss(sword, { of: [`attack ${i}`], id: `re ${i}` });
    t = t.onFirstHit(keepBestDamage().ifBelow({ hit: 9, crit: 20 }), { id: "keep" });
    pin(t, { mean: 35.899652185697796, variance: 63.87095718219878, p0: 0.000019683 });
    expect(t.fireProbability("keep")).toBe(0.9917782308532256);
    expect(inspectTurn(t).groupCount).toBe(1);
  });

  it("grants over disjoint source sets, half of them behind a save", () => {
    let t = turn().attacks(6, sword);
    for (let i = 1; i <= 5; i++) {
      t = t.onFirstHit(advantage().untilNextAttack(), { of: [`attack ${i}`], chance: i % 2 ? 1 : 0.5 });
    }
    pin(t, { mean: 38.45982264174283, variance: 113.43905373544192, p0: 0.0007289999999999989 });
  });
});
