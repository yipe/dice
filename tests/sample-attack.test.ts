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

describe("AttackBuilder.sample", () => {
  const sword = d20.plus(5).ac(15).onHit(roll(2, 6, 3));

  it("misses below AC and rolls no damage", () => {
    const s = sword.sample(dice([9])); // 9 + 5 = 14 < 15
    expect(s).toMatchObject({ outcome: "miss", total: 0 });
    expect(s.damage).toEqual([]);
    expect(s.check).toEqual([{ sides: 20, face: 9, kept: true }]);
  });

  it("hits at AC and rolls the base pool", () => {
    const s = sword.sample(dice([10, 3, 4]));
    expect(s).toMatchObject({ outcome: "hit", total: 10 });
    expect(s.damage.map((x) => x.face)).toEqual([3, 4]);
  });

  it("crits on a natural 20 with doubled dice", () => {
    const s = sword.sample(dice([20, 1, 2, 3, 4]));
    expect(s).toMatchObject({ outcome: "crit", total: 13 });
    expect(s.damage).toHaveLength(4);
  });

  it("a natural 1 misses even when it would reach AC", () => {
    expect(d20.plus(30).ac(10).onHit(d(6)).sample(dice([1])).outcome).toBe("miss");
  });

  it("honours critOn range and critOnHit from the context", () => {
    expect(d20.plus(5).ac(15).critOn(19).onHit(d(6)).sample(dice([19, 2, 2])).outcome).toBe("crit");
    expect(sword.sample(dice([12, 1, 1, 1, 1]), { ...flat, critOnHit: true }).outcome).toBe("crit");
    // crit-on-hit still has to reach the AC, and a natural 1 still misses
    expect(sword.sample(dice([9]), { ...flat, critOnHit: true }).outcome).toBe("miss");
    expect(sword.sample(dice([1]), { ...flat, critOnHit: true }).outcome).toBe("miss");
  });

  it("rolls advantage from the context unless pinned", () => {
    const ctx: RowContext = { ...flat, rollType: "advantage" };
    const s = sword.sample(dice([3, 17, 6, 6]), ctx);
    expect(s.outcome).toBe("hit");
    expect(s.check.map((x) => x.kept)).toEqual([false, true]);
    const pinned = d20.plus(5).pinned().ac(15).onHit(roll(2, 6, 3));
    expect(pinned.sample(dice([3]), ctx).outcome).toBe("miss");
  });

  it("rolls three dice for a three-dice advantage attacker", () => {
    const elf = d20.plus(5).withAdvantage().ac(15).threeDiceAdvantage().onHit(d(6));
    const s = elf.sample(dice([2, 3, 18, 4]));
    expect(s.outcome).toBe("hit");
    expect(s.check.map((x) => x.kept)).toEqual([false, false, true]);
  });

  it("draws bonus dice after the d20 and adds them to the check", () => {
    const blessed = d20.plus(d(4)).plus(3).ac(15).onHit(d(6));
    const s = blessed.sample(dice([10, 2, 5])); // 10 + 2 + 3 = 15 hits
    expect(s.outcome).toBe("hit");
    expect(s.check.map((x) => [x.sides, x.face])).toEqual([
      [20, 10],
      [4, 2],
    ]);
    expect(blessed.sample(dice([10, 1])).outcome).toBe("miss");
  });

  it("doubles a vulnerable landing as a whole roll", () => {
    expect(sword.sample(dice([10, 3, 4]), { ...flat, vulnerable: true }).total).toBe(20);
  });

  it("halfOnMiss floors half the hit payload", () => {
    const s = d20.plus(5).ac(15).onHit(roll(2, 6, 3)).halfOnMiss().sample(dice([2, 4, 5]));
    expect(s).toMatchObject({ outcome: "miss", total: 6 });
  });

  it("onMiss draws the miss payload", () => {
    const s = sword.onMiss(d(4)).sample(dice([2, 3]));
    expect(s).toMatchObject({ outcome: "miss", total: 3 });
    expect(s.damage).toEqual([{ sides: 4, face: 3, kept: true }]);
  });

  it("separate channels follow the base pool and double on a crit", () => {
    const a = d20.plus(5).ac(15).onHit(d(8)).plusSeparateDamage(d(6));
    expect(a.sample(dice([10, 5, 2]))).toMatchObject({ outcome: "hit", total: 7 });
    const crit = a.sample(dice([20, 5, 5, 2, 2]));
    expect(crit).toMatchObject({ outcome: "crit", total: 14 });
    expect(crit.damage.map((x) => x.sides)).toEqual([8, 8, 6, 6]);
  });

  it("noCrit() lands a natural 20 as a hit", () => {
    const s = sword.noCrit().sample(dice([20, 3, 4]));
    expect(s).toMatchObject({ outcome: "hit", total: 10 });
  });

  it("alwaysHits() never misses and crits in the crit range", () => {
    const sure = d20.plus(5).ac(15).alwaysHits().onHit(d(6));
    expect(sure.sample(dice([1, 2]))).toMatchObject({ outcome: "hit", total: 2 });
    expect(sure.sample(dice([20, 2, 3]))).toMatchObject({ outcome: "crit", total: 5 });
    // an autoHit context on a plain attack is the same
    expect(sword.sample(dice([1, 2, 2]), { ...flat, autoHit: true })).toMatchObject({ outcome: "hit", total: 7 });
  });

  it("alwaysCrits() crits every hit but still needs the AC and misses a natural 1", () => {
    const brutal = d20.plus(5).ac(15).alwaysCrits().onHit(d(6));
    expect(brutal.sample(dice([10, 2, 3]))).toMatchObject({ outcome: "crit", total: 5 });
    expect(brutal.sample(dice([9])).outcome).toBe("miss");
    expect(brutal.sample(dice([1])).outcome).toBe("miss");
    // alwaysHits().alwaysCrits() draws no check at all
    const sure = d20.plus(5).ac(15).alwaysHits().alwaysCrits().onHit(d(6));
    const s = sure.sample(dice([2, 3]));
    expect(s).toMatchObject({ outcome: "crit", total: 5 });
    expect(s.check).toEqual([]);
  });

  it("rollUnder returns the attack re-derived in the context", () => {
    expect(sword.rollUnder({ ...flat, rollType: "advantage" }).check.rollType).toBe("advantage");
    expect(sword.rollUnder(flat)).toBe(sword);
  });

  it("tracks the PMF mean", () => {
    let st = 99;
    const rng: Rng = {
      die: (n) => {
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        return (st % n) + 1;
      },
      chance: () => false,
    };
    const a = d20.plus(7).withAdvantage().ac(16).critOn(19).onHit(roll(2, 8, 4)).plusSeparateDamage(roll(1, 6));
    let sum = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) sum += a.sample(rng).total;
    expect(sum / N).toBeCloseTo(a.pmf.mean(), 0);
  });

  it("tracks under(context) for every context flag", () => {
    const rng = mulberry32(5);
    const a = d20.plus(d(4)).plus(6).ac(17).critOn(19).onHit(roll(1, 10, 4)).plusSeparateDamage(roll(2, 6)).halfOnMiss();
    const contexts: RowContext[] = [
      { ...flat, rollType: "advantage" },
      { ...flat, rollType: "disadvantage", vulnerable: true },
      { ...flat, rollType: "elven accuracy", critOnHit: true },
      { ...flat, autoHit: true },
      { ...flat, autoHit: true, critOnHit: true, vulnerable: true },
    ];
    const N = 20000;
    for (const ctx of contexts) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += a.sample(rng, ctx).total;
      expect(sum / N, JSON.stringify(ctx)).toBeCloseTo(a.under(ctx).mean(), 0);
    }
  });
});
