import { describe, expect, it } from "vitest";
import { advantage, d, d20, turn, TurnSpecError } from "../builder";
import type { AttackBuilder, StepStats } from "../builder";

// Every oracle below is +8 vs AC 16, crit on 20: shortsword 1d6+5, dagger 1d4+5,
// rapier 1d8+5, fist 1d6+4. Expected values are the §3 per-swing tables, pinned
// to 4 decimals.
const ss = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d6+5");
const dg = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d4+5");
const rapier = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d8+5");
const fist = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d6+4");

function expectStats(
  stats: StepStats,
  hit: number,
  crit: number,
  advantage: number
): void {
  expect(stats.rolled).toBeCloseTo(1, 10);
  expect(stats.hit).toBeCloseTo(hit, 4);
  expect(stats.crit).toBeCloseTo(crit, 4);
  expect(stats.live.advantage).toBeCloseTo(advantage, 4);
  expect(stats.live.disadvantage).toBeCloseTo(0, 10);
  expect(stats.live.critOnHit).toBeCloseTo(0, 10);
}

describe("Turn.stepStats", () => {
  it("reports F2's per-swing table", () => {
    const v = ss().onEveryHit(advantage().untilNextAttack());
    const t = turn([{ id: "s1", source: v }, { id: "s2", source: v }, { id: "d", source: dg() }]);

    expectStats(t.stepStats("s1"), 0.65, 0.05, 0);
    expectStats(t.stepStats("s2"), 0.7979, 0.0809, 0.65);
    expectStats(t.stepStats("d"), 0.8315, 0.0879, 0.7979);
  });

  it("reports F3's per-swing table", () => {
    const v = ss().onEveryHit(advantage().untilNextAttack());
    const t = turn([
      { id: "s1", source: v },
      { id: "s2", source: v },
      { id: "s3", source: v },
      { id: "s4", source: v },
    ]);

    expectStats(t.stepStats("s1"), 0.65, 0.05, 0);
    expectStats(t.stepStats("s2"), 0.7979, 0.0809, 0.65);
    expectStats(t.stepStats("s3"), 0.8315, 0.0879, 0.7979);
    expectStats(t.stepStats("s4"), 0.8392, 0.0895, 0.8315);
  });

  it("reports F12's advantage column", () => {
    const v = rapier().onEveryHit(advantage().untilNextAttack());
    const t = turn([
      { id: "r1", source: v },
      { id: "r2", source: v },
      { id: "f1", source: fist() },
      { id: "f2", source: fist() },
    ])
      .onFirstHit(d("1d6"))
      .onFirstHit(advantage().untilEndOfTurn(), {
        save: d20.plus(2).dc(15),
        onSave: advantage().untilNextAttack(),
      });

    expect(t.mean()).toBeCloseTo(30.8749, 4);
    expect(t.stepStats("r1").live.advantage).toBeCloseTo(0, 4);
    expect(t.stepStats("r2").live.advantage).toBeCloseTo(0.65, 4);
    // §3 lists f1 as 84.56%; the exact walk mass is 84.565% (0.84565), within 1e-4.
    expect(t.stepStats("f1").live.advantage).toBeCloseTo(0.8456, 3);
    expect(t.stepStats("f2").live.advantage).toBeCloseTo(0.6061, 4);
  });

  it("reports source probabilities with live.* = 0 on a turn with no conditions", () => {
    const t = turn([{ id: "a", source: ss() }, { id: "b", source: dg() }]);
    expectStats(t.stepStats("a"), 0.65, 0.05, 0);
    expectStats(t.stepStats("b"), 0.65, 0.05, 0);
  });

  it("reports an attack-shaped rider's fire mass as rolled", () => {
    // A reroll that rolls its own attack: on the first miss, reroll the same attack.
    const t = turn([{ id: "a", source: ss() }]).onFirstMiss(ss(), { id: "reroll" });
    const reroll = t.stepStats("reroll");
    // It fires iff the first attack missed (0.35), and lands at the source's own 0.65.
    expect(reroll.rolled).toBeCloseTo(0.35, 4);
    expect(reroll.hit).toBeCloseTo(0.35 * 0.65, 4);
    expect(reroll.crit).toBeCloseTo(0.35 * 0.05, 4);
  });

  it("throws unknown-id for a damage rider, condition, substitute or unknown id", () => {
    const t = turn([{ id: "a", source: ss() }]).onAnyCrit(d("2d6"), { id: "smite" });
    for (const id of ["smite", "condition 1", "nope"]) {
      let caught: unknown;
      try {
        t.stepStats(id);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TurnSpecError);
      expect((caught as TurnSpecError).code).toBe("unknown-id");
    }
  });

  it("sums a first-miss rider's several steps under one id", () => {
    const t = turn([{ id: "a", source: ss() }, { id: "b", source: ss() }]).onFirstMiss(ss(), {
      id: "reroll",
    });
    const reroll = t.stepStats("reroll");
    // Fires iff a misses (0.35) or a hits and b misses (0.65 × 0.35).
    const fired = 0.35 + 0.65 * 0.35;
    expect(reroll.rolled).toBeCloseTo(fired, 4);
    expect(reroll.hit).toBeCloseTo(fired * 0.65, 4);
    expect(reroll.crit).toBeCloseTo(fired * 0.05, 4);
  });

  it("reports unit-mass stats when a later source PMF has mass other than 1", () => {
    const doubled = ss().toPMF().scaleMass(2);
    const t = turn([{ id: "a", source: ss().toPMF() }, { id: "b", source: doubled }]);
    const stats = t.stepStats("a");
    expect(stats.rolled).toBeCloseTo(1, 10);
    expect(stats.hit).toBeCloseTo(0.65, 4);
    expect(stats.crit).toBeCloseTo(0.05, 4);
    expect(stats.live.advantage).toBeCloseTo(0, 10);
  });

  it("returns a copy, so mutating the result cannot change later reads", () => {
    const v = ss().onEveryHit(advantage().untilNextAttack());
    const t = turn([{ id: "s1", source: v }, { id: "s2", source: v }]);
    const first = t.stepStats("s2");
    first.hit = 0;
    first.live.advantage = 0;
    expectStats(t.stepStats("s2"), 0.7979, 0.0809, 0.65);
  });
});
