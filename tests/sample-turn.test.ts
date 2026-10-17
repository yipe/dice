import { describe, expect, it } from "vitest";
import { d, d6, d8, d20, roll } from "../src/builder/factory";
import { advantage, critOnHit, keepBestDamage, turn, vulnerability } from "../src/turn";
import type { Turn } from "../src/turn";
import { sampleFallbacks } from "../src/turn/sample";
import type { Rng } from "../src/common/rng";

const script = (faces: number[], coins: boolean[] = []): Rng => ({
  die: () => {
    const f = faces.shift();
    if (f === undefined) throw new Error("out of dice");
    return f;
  },
  chance: () => {
    const c = coins.shift();
    if (c === undefined) throw new Error("out of coins");
    return c;
  },
});
const sword = d20.plus(5).ac(15).onHit(roll(1, 8, 3));

describe("Turn.sample", () => {
  it("one attack: a hit wave with its dice and outcome", () => {
    const t = turn([{ source: sword, id: "sword" }]);
    const trace = t.sample(script([12, 6]));
    expect(trace.total).toBe(9);
    expect(trace.waves).toHaveLength(1);
    expect(trace.waves[0].outcomes).toEqual([{ source: "sword", result: "hit", damage: 9 }]);
    expect(trace.waves[0].dice.map((x) => [x.sides, x.face, x.role])).toEqual([
      [20, 12, "attack"],
      [8, 6, "damage"],
    ]);
  });
  it("first-hit rider fires once, on the first landing, doubled on a crit", () => {
    const t = turn([
      { source: sword, id: "a" },
      { source: sword, id: "b" },
    ]).onFirstHit(roll(2, 6), { id: "sneak" });
    // a: d20=3 misses (no damage). b: d20=20 crits -> 1d8 doubled = 2 dice (4,4). sneak 2d6 doubled on the crit = 4 dice (1,2,3,4).
    const trace = t.sample(script([3, 20, 4, 4, 1, 2, 3, 4]));
    expect(trace.waves.map((w) => w.outcomes.map((o) => o.result))).toEqual([["miss"], ["crit"], ["fired"]]);
  });
  it("any-miss reroll fires only after a miss and reads the miss bit", () => {
    const t = turn([{ source: sword, id: "a" }]).onAnyMiss(sword, { id: "reroll" });
    const hitTrace = t.sample(script([15, 2]));
    expect(hitTrace.waves[hitTrace.waves.length - 1].outcomes[0]).toMatchObject({ source: "reroll", result: "skipped" });
    const missTrace = t.sample(script([2, 16, 5]));
    expect(missTrace.waves[missTrace.waves.length - 1].outcomes[0]).toMatchObject({ source: "reroll", result: "hit", damage: 8 });
  });
  it("a chance attack that does not happen is skipped and spends nothing", () => {
    const t = turn([{ source: sword, id: "a", chance: 0.5 }]);
    const trace = t.sample(script([], [false]));
    expect(trace.waves[0].outcomes[0]).toMatchObject({ result: "skipped", damage: 0 });
    expect(trace.total).toBe(0);
  });
  it("a parsed string source is a chip (no dice)", () => {
    // `d("…")` with an attack clause is a ParsedRollBuilder: its sample() is samplePMF over the labelled PMF (A2), no dice.
    const t = turn([{ source: d("(d20 + 5 AC 15) * (2d6)"), id: "parsed" }]);
    const alwaysLast = {
      die: () => {
        throw new Error("no dice expected");
      },
      chance: () => false,
    }; // inverse CDF picks the last bin
    const trace = t.sample(alwaysLast);
    expect(trace.waves[0].dice).toEqual([]);
    expect(trace.waves[0].outcomes[0].source).toBe("parsed");
  });
  it("returns the sampler version", () => {
    expect(turn([sword]).sample(script([1])).samplerVersion).toBe(1);
  });
});

/** A seeded rng whose consecutive draws are independent enough for a two-die keep (an LCG's low bits are not). */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const unit = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { die: (n) => Math.floor(unit() * n) + 1, chance: (p) => unit() < p };
}

/** The sample mean of `n` plays, and the mean of every outcome and die the traces carry. */
function sampleMean(t: Turn, n: number, seed: number): number {
  const rng = mulberry32(seed);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const trace = t.sample(rng);
    const outcomes = trace.waves.reduce((all, wave) => all + wave.outcomes.reduce((s, o) => s + o.damage, 0), 0);
    if (outcomes !== trace.total) throw new Error(`total ${trace.total} is not the sum of its outcomes ${outcomes}`);
    sum += trace.total;
  }
  return sum / n;
}

describe("Turn.sample law", () => {
  const N = 20_000;
  const axe = d20.plus(6).ac(16).onHit(roll(2, 6, 4));
  const cases: [string, Turn][] = [
    ["first-hit rider step", turn([sword, sword]).onFirstHit(roll(3, 6))],
    ["every-hit rider folded", turn([{ source: sword, id: "a" }, { source: sword, id: "b" }]).onEveryHit(roll(1, 6))],
    ["every-hit rider with a coin", turn([sword, sword]).rider({ on: "every-hit", damage: roll(1, 6), happens: 0.5 })],
    ["first-hit rider that may not happen", turn([sword, sword]).rider({ on: "first-hit", damage: roll(2, 6), happens: 0.3 })],
    ["capped every-hit rider", turn([sword, sword, sword]).rider({ on: "every-hit", damage: d6, max: 2 })],
    ["any-miss reroll", turn([sword, sword]).onAnyMiss(sword)],
    ["first-miss reroll then first-hit", turn([sword, sword]).onFirstMiss(sword).onFirstHit(roll(2, 6))],
    ["chance attacks", turn([{ source: sword, chance: 0.5 }, { source: axe, chance: 0.25 }])],
    ["advantage granted until next attack", turn([sword.onEveryHit(advantage().untilNextAttack()), sword, sword])],
    ["crit-on-hit granted for the turn", turn([sword.onEveryHit(critOnHit().untilEndOfTurn()), axe])],
    ["a grant gated by a chance", turn([sword, sword]).onFirstHit(advantage().untilNextAttack(), { chance: 0.4 })],
    ["vulnerability until next hit", turn([sword.onEveryHit(vulnerability().untilNextHit()), axe, axe])],
    ["substitute: keep best damage", turn([axe, axe]).onFirstHit(keepBestDamage())],
    ["substitute: keep best below a threshold", turn([axe, axe, axe]).onFirstHit(keepBestDamage().ifBelow({ hit: 10, crit: 16 }))],
    ["substitute with separate channels", turn([axe.plusSeparateDamage(roll(1, 8)), axe]).onFirstHit(keepBestDamage())],
    ["dice-match rider", turn([{ source: axe, id: "orb" }]).onDiceMatch(["orb"], roll(3, 8))],
    ["dice-match attack-shaped rider", turn([{ source: axe, id: "orb" }]).onDiceMatch(["orb"], axe)],
    ["save row with a rider", turn([{ source: d20.plus(5).dc(15).ability("dex").onSaveFailure(roll(4, d6)).saveHalf(), id: "breath" }, sword]).onFirstHit(roll(2, 6), { landing: "damage" })],
    ["gated attack", turn([{ source: sword, id: "a" }, { source: axe, after: { of: "a", landing: "hit" } }])],
    ["parsed string rows", turn([d("(d20 + 5 AC 15) * (2d6)"), d("(d20 + 5 AC 15) * (1d8 + 3)")]).onFirstHit(roll(2, 6))],
    ["reroll budget on the base pool", turn([axe.rerollDamageUpTo(1), axe]).onFirstHit(keepBestDamage())],
    ["advantage of its own under a granted advantage", turn([d20.plus(6).withAdvantage().ac(16).onHit(roll(2, 6, 4)).onEveryHit(advantage().untilNextAttack()), axe])],
    ["chip riders: a PMF payload, folded and as a step that may not happen", turn([sword, sword]).onEveryHit(roll(1, 6).toPMF()).rider({ on: "first-hit", damage: roll(2, 6).toPMF(), happens: 0.3 })],
  ];
  it.each(cases)("%s: the sample mean is the turn's mean, with no fallback", (_name, t) => {
    const before = sampleFallbacks.count;
    const mean = t.mean();
    const sampled = sampleMean(t, N, 7);
    // Within 4.5 standard errors of the exact mean (at N = 200 000 every case is within 1.2).
    const z = (sampled - mean) / Math.sqrt(t.pmf.variance() / N);
    expect(Math.abs(z), `sampled ${sampled} vs mean ${mean}`).toBeLessThan(4.5);
    expect(sampleFallbacks.count - before).toBe(0);
  });
  it("tracks the whole distribution of a turn with riders and grants", () => {
    const t = turn([sword.onEveryHit(advantage().untilNextAttack()), sword, sword]).onFirstHit(roll(2, 6)).onFirstMiss(sword);
    const rng = mulberry32(11);
    const counts = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const { total } = t.sample(rng);
      counts.set(total, (counts.get(total) ?? 0) + 1);
    }
    const pmf = t.pmf;
    let drift = 0;
    for (const value of pmf.support()) drift += Math.abs((counts.get(value) ?? 0) / N - pmf.pAt(value));
    expect(drift).toBeLessThan(0.08);
  });
});

describe("Turn.sample path details", () => {
  it("a folded every-hit rider rolls beside each landing, in the row's wave", () => {
    const t = turn([{ source: sword, id: "a" }, { source: sword, id: "b" }]).onEveryHit(roll(1, 6), { id: "flame" });
    // a: 15 hits, d8=2, flame d6=4. b: 20 crits: 2d8 (1,1), flame doubled 2d6 (6,6).
    const trace = t.sample(script([15, 2, 4, 20, 1, 1, 6, 6]));
    expect(trace.waves.map((w) => w.outcomes)).toEqual([
      [{ source: "a", result: "hit", damage: 5 }, { source: "flame", result: "fired", damage: 4 }],
      [{ source: "b", result: "crit", damage: 5 }, { source: "flame", result: "fired", damage: 12 }],
    ]);
    expect(trace.waves[1].dice.map((x) => x.role)).toEqual(["attack", "damage", "damage", "rider", "rider"]);
    expect(trace.total).toBe(26);
  });
  it("a grant save is a chip outcome in the row's wave and sets the flag the next row reads", () => {
    const t = turn([sword.onEveryHit(advantage().untilNextAttack(), { chance: 0.5 }), { source: sword, id: "next" }]);
    // Hit, the chance coin comes up: the next row rolls two d20s and keeps the higher.
    const taken = t.sample(script([15, 2, 3, 18, 4], [true]));
    expect(taken.waves[0].outcomes[1]).toMatchObject({ result: "save-fail", damage: 0 });
    expect(taken.waves[1].dice.filter((x) => x.sides === 20).map((x) => [x.face, x.kept])).toEqual([[3, false], [18, true]]);
    expect(taken.waves[1].outcomes[0]).toMatchObject({ source: "next", result: "hit", damage: 7 });
    // The coin fails: one d20.
    const saved = t.sample(script([15, 2, 18, 4], [false]));
    expect(saved.waves[0].outcomes[1]).toMatchObject({ result: "save-pass" });
    expect(saved.waves[1].dice.filter((x) => x.sides === 20)).toHaveLength(1);
  });
  it("keepBestDamage re-rolls the base payload once and keeps the better roll's dice", () => {
    const t = turn([{ source: sword, id: "a" }, { source: sword, id: "b" }]).onFirstHit(keepBestDamage());
    // a hits with a 2, re-rolls a 7: the 2 is dropped. b hits with a 3 and is not re-rolled: the substitute is spent.
    const trace = t.sample(script([15, 2, 7, 15, 3]));
    expect(trace.waves[0].outcomes[0]).toEqual({ source: "a", result: "hit", damage: 10 });
    expect(trace.waves[0].dice.map((x) => [x.face, x.kept])).toEqual([[15, true], [2, false], [7, true]]);
    expect(trace.waves[1].outcomes[0]).toEqual({ source: "b", result: "hit", damage: 6 });
    expect(trace.waves[1].dice).toHaveLength(2);
    // A tie keeps the original roll; the fresh dice are shown dropped.
    const tie = t.sample(script([15, 5, 5, 15, 3]));
    expect(tie.waves[0].dice.map((x) => [x.face, x.kept])).toEqual([[15, true], [5, true], [5, false]]);
  });
  it("ifBelow holds a roll at or above the threshold while a later watched attack can still land", () => {
    const t = turn([{ source: sword, id: "a" }, { source: sword, id: "b" }]).onFirstHit(keepBestDamage().ifBelow(8));
    // a hits for 8 (5 + 3): held. b hits for 4 (1 + 3), the last watched attack: spent regardless, re-rolled 6.
    const trace = t.sample(script([15, 5, 15, 1, 6]));
    expect(trace.waves[0].outcomes[0].damage).toBe(8);
    expect(trace.waves[1].outcomes[0].damage).toBe(9);
    expect(trace.waves[1].dice.map((x) => [x.face, x.kept])).toEqual([[15, true], [1, false], [6, true]]);
  });
  it("a dice-match rider fires when the base dice show a pair, doubled when the pair was a crit's", () => {
    const orb = d20.plus(6).ac(16).onHit(roll(2, 8));
    const t = turn([{ source: orb, id: "orb" }]).onDiceMatch(["orb"], roll(2, 6), { id: "bounce" });
    expect(t.sample(script([15, 4, 4, 2, 3])).waves.map((w) => w.outcomes[0].result)).toEqual(["hit", "fired"]);
    expect(t.sample(script([15, 4, 5])).waves.map((w) => w.outcomes[0].result)).toEqual(["hit", "skipped"]);
    // A crit rolls 4d8: a pair among them matches, and the rider's 2d6 double.
    const crit = t.sample(script([20, 1, 2, 3, 3, 1, 1, 1, 1]));
    expect(crit.waves[1].outcomes[0]).toEqual({ source: "bounce", result: "fired", damage: 4 });
    expect(crit.waves[1].dice).toHaveLength(4);
  });
  it("a save row reports the save's own outcome, the enemy's d20 and the rider's landing kind", () => {
    const breath = d20.plus(5).dc(15).ability("dex").onSaveFailure(roll(2, d6)).saveHalf();
    const t = turn([{ source: breath, id: "breath" }]).onFirstHit(roll(1, 6), { landing: "damage" });
    // The target rolls a 3 (+5 = 8 < 15): failed. 2d6 = 2 + 3. The rider lands (damage dealt): d6 = 4.
    const failed = t.sample(script([3, 2, 3, 4]));
    expect(failed.waves[0].outcomes[0]).toEqual({ source: "breath", result: "save-fail", damage: 5 });
    expect(failed.waves[0].dice[0]).toMatchObject({ sides: 20, face: 3, role: "save", by: "enemy" });
    expect(failed.waves[1].outcomes[0]).toMatchObject({ result: "fired", damage: 4 });
    // A pass halves 2 + 3 to 2: still damage dealt, so the rider lands.
    const passed = t.sample(script([18, 2, 3, 4]));
    expect(passed.waves[0].outcomes[0]).toEqual({ source: "breath", result: "save-pass", damage: 2 });
    expect(passed.waves[1].outcomes[0]).toMatchObject({ result: "fired" });
  });
  it("a rider that may not happen takes its coin and is skipped when it fails", () => {
    const t = turn([sword]).rider({ on: "first-hit", damage: roll(2, 6), happens: 0.5, id: "maybe" });
    expect(t.sample(script([15, 2], [false])).waves[1].outcomes[0]).toMatchObject({ source: "maybe", result: "skipped" });
    expect(t.sample(script([15, 2, 1, 1], [true])).waves[1].outcomes[0]).toMatchObject({ source: "maybe", result: "fired", damage: 2 });
  });
  it("refuses a turn with a dealing condition, as the joint pmf does", () => {
    const ray = d20.plus(7).ac(16).onHit(roll(2, d8)).typed("cold");
    const t = turn([ray.onEveryHit(advantage().untilNextAttack(), { dealing: "cold" }), ray]);
    expect(() => t.sample(script([]))).toThrow(/dealing/);
  });
});
