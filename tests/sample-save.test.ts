import { describe, expect, it } from "vitest";
import { d, d20, roll } from "../src/builder";
import type { Rng } from "../src/common/rng";
import type { RowContext } from "../src/turn/types";

const dice = (faces: number[]): Rng => ({
  die: () => {
    if (faces.length === 0) throw new Error("no faces left");
    return faces.shift()!;
  },
  chance: () => {
    throw new Error("no coins");
  },
});

/** A seeded rng whose consecutive draws are independent enough for a two-die keep (an LCG's low bits are not). */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    die: (n) => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n) + 1;
    },
    chance: () => {
      throw new Error("no coins");
    },
  };
}

const flat: RowContext = {
  rollType: "flat",
  autoHit: false,
  critOnHit: false,
  autoFail: false,
  vulnerable: false,
  penaltyDice: [],
  joined: [],
};

describe("DCBuilder.sampleCheck", () => {
  const check = d20.plus(3).dc(15);

  it("fails below the DC and passes at it", () => {
    expect(check.sampleCheck(dice([11]))).toEqual({ check: [{ sides: 20, face: 11, kept: true }], total: 14, failed: true });
    expect(check.sampleCheck(dice([12]))).toMatchObject({ total: 15, failed: false });
  });

  it("subtracts penalty dice from the context and auto-fails without a draw", () => {
    const s = check.sampleCheck(dice([13, 2]), { ...flat, penaltyDice: [{ count: 1, sides: 4 }] });
    expect(s).toMatchObject({ total: 14, failed: true });
    expect(s.check.map((x) => x.sides)).toEqual([20, 4]);
    expect(check.sampleCheck(dice([]), { ...flat, autoFail: true })).toEqual({ check: [], total: 0, failed: true });
    expect(check.alwaysFails().sampleCheck(dice([]))).toEqual({ check: [], total: 0, failed: true });
  });

  it("rolls the context's roll type unless pinned", () => {
    const s = check.sampleCheck(dice([4, 12]), { ...flat, rollType: "advantage" });
    expect(s).toMatchObject({ total: 15, failed: false });
    expect(s.check.map((x) => x.kept)).toEqual([false, true]);
    expect(d20.plus(3).pinned().dc(15).sampleCheck(dice([4]), { ...flat, rollType: "advantage" }).failed).toBe(true);
  });
});

describe("SaveBuilder.sample", () => {
  const fireball = d20.plus(3).dc(15).onSaveFailure(roll(8, 6)).saveHalf();

  it("fails below the DC and rolls full damage by the enemy", () => {
    const s = fireball.sample(dice([11, 1, 1, 1, 1, 1, 1, 1, 1]));
    expect(s).toMatchObject({ outcome: "save-fail", total: 8 });
    expect(s.check).toEqual([{ sides: 20, face: 11, kept: true }]);
    expect(s.damage).toHaveLength(8);
  });

  it("passes at the DC and floors half", () => {
    const s = fireball.sample(dice([12, 1, 1, 1, 1, 1, 1, 1, 2])); // 12+3=15 >= 15 passes; 9 dmg -> 4
    expect(s).toMatchObject({ outcome: "save-pass", total: 4 });
    expect(s.damage).toHaveLength(8);
  });

  it("subtracts penalty dice and auto-fails from the context", () => {
    const ctx: RowContext = { ...flat, penaltyDice: [{ count: 1, sides: 4 }] };
    expect(fireball.sample(dice([13, 2, 1, 1, 1, 1, 1, 1, 1, 1]), ctx).outcome).toBe("save-fail"); // 13+3-2 = 14 < 15
    expect(fireball.sample(dice([1, 1, 1, 1, 1, 1, 1, 1]), { ...flat, autoFail: true }).outcome).toBe("save-fail");
  });

  it("has no natural 20 rule", () => {
    expect(d20.plus(0).dc(25).onSaveFailure(roll(1, 4)).sample(dice([20, 1])).outcome).toBe("save-fail");
  });

  it("doubles a vulnerable failure and leaves a pass alone", () => {
    const ctx: RowContext = { ...flat, vulnerable: true };
    expect(fireball.sample(dice([11, 1, 1, 1, 1, 1, 1, 1, 1]), ctx).total).toBe(16);
    expect(fireball.sample(dice([12, 1, 1, 1, 1, 1, 1, 1, 1]), ctx).total).toBe(4);
  });

  it("a plain pass still draws the failure dice and deals 0", () => {
    const s = d20.plus(3).dc(15).onSaveFailure(roll(2, 6)).sample(dice([12, 4, 5]));
    expect(s).toMatchObject({ outcome: "save-pass", total: 0 });
    expect(s.damage.map((x) => x.face)).toEqual([4, 5]);
  });

  it("onSaveSuccess draws its own payload after the failure dice", () => {
    const s = d20.plus(3).dc(15).onSaveFailure(roll(2, 6)).onSaveSuccess(d(4)).sample(dice([12, 4, 5, 3]));
    expect(s).toMatchObject({ outcome: "save-pass", total: 3 });
    expect(s.damage).toEqual([{ sides: 4, face: 3, kept: true }]);
  });

  it("rollUnder returns the save re-derived in the context", () => {
    expect(fireball.rollUnder({ ...flat, autoFail: true }).check.autoFail).toBe(true);
    expect(fireball.rollUnder(flat)).toBe(fireball);
  });

  it("tracks the PMF mean", () => {
    let st = 7;
    const rng: Rng = {
      die: (n) => {
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        return (st % n) + 1;
      },
      chance: () => false,
    };
    const save = d20.plus(4).withDisadvantage().dc(16).onSaveFailure(roll(3, 8, 2)).saveHalf();
    let sum = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) sum += save.sample(rng).total;
    expect(sum / N).toBeCloseTo(save.pmf.mean(), 0);
  });

  it("tracks under(context) for every context flag", () => {
    const rng = mulberry32(11);
    const save = d20.plus(d(4)).plus(2).dc(14).onSaveFailure(roll(4, 6)).saveHalf();
    const contexts: RowContext[] = [
      { ...flat, rollType: "advantage", vulnerable: true },
      { ...flat, rollType: "disadvantage", penaltyDice: [{ count: 1, sides: 4 }] },
      { ...flat, autoFail: true, vulnerable: true },
    ];
    const N = 20000;
    for (const ctx of contexts) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += save.sample(rng, ctx).total;
      expect(sum / N, JSON.stringify(ctx)).toBeCloseTo(save.under(ctx).mean(), 0);
    }
  });
});
