import { describe, expect, it } from "vitest";
import { advantage, d20, turn, Turn } from "../builder";
import type { AttackBuilder } from "../builder";

// Every oracle below is +8 vs AC 16, crit on 20: shortsword 1d6+5, dagger 1d4+5,
// staff 1d8+5. Expected means are the §3 oracles, pinned to 4 decimals.
const ss = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d6+5");
const dg = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d4+5");
const staff = (): AttackBuilder => d20.plus(8).ac(16).onHit("1d8+5");

describe("AttackBuilder.onEveryHit / onAnyCrit", () => {
  it("returns a new builder carrying the condition and leaves the receiver unchanged", () => {
    const bare = ss();
    const granting = bare.onEveryHit(advantage().untilNextAttack());

    expect(granting).not.toBe(bare);
    // Attaching to a copy must not change the bare weapon: bare ×3 stays 17.1000.
    expect(turn([bare, bare, bare]).mean()).toBeCloseTo(17.1, 4);
    // The attached copy: three shortswords each granting the next advantage = 20.1405.
    expect(turn([granting, granting, granting]).mean()).toBeCloseTo(20.1405, 4);
  });

  it("turn([v, v, d]) equals F1 (19.2211)", () => {
    const v = ss().onEveryHit(advantage().untilNextAttack());
    expect(turn([v, v, dg()]).mean()).toBeCloseTo(19.2211, 4);
  });

  it("turn([v, v, v, v]) equals F3 (27.5867)", () => {
    const v = ss().onEveryHit(advantage().untilNextAttack());
    expect(turn([v, v, v, v]).mean()).toBeCloseTo(27.5867, 4);
  });

  it("agrees across turn(), Turn.from() and the chained attack() spelling", () => {
    const v = ss().onEveryHit(advantage().untilNextAttack());
    const viaTurn = turn([v, v, dg()]).mean();
    const viaFrom = Turn.from({ attacks: [v, v, dg()] }).mean();
    const viaChained = turn().attack(v).attack(v).attack(dg()).mean();

    expect(viaTurn).toBeCloseTo(19.2211, 4);
    expect(viaFrom).toBeCloseTo(viaTurn, 10);
    expect(viaChained).toBeCloseTo(viaTurn, 10);
  });

  it("a save gate equals F6 (19.7207)", () => {
    const saveGated = staff().onEveryHit(advantage().untilEndOfTurn(), {
      save: d20.plus(3).dc(15),
    });
    expect(turn([saveGated, saveGated, dg()]).mean()).toBeCloseTo(19.7207, 4);
  });

  it("onAnyCrit carries a crit-gated condition", () => {
    const bare = ss();
    const onCrit = bare.onAnyCrit(advantage().untilNextAttack());
    expect(onCrit).not.toBe(bare);
    // A single shortsword has no later attack to read its crit advantage, so the
    // mean is unchanged; two shortswords gain a little from the first critting.
    expect(turn([onCrit]).mean()).toBeCloseTo(turn([bare]).mean(), 10);
    expect(turn([onCrit, onCrit]).mean()).toBeGreaterThan(turn([bare, bare]).mean());
  });
});
