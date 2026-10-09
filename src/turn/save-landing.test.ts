import { describe, expect, it } from "vitest";
import { advantage, d4, d6, d8, d20, flat, keepBestDamage, roll, turn, Turn, TurnSpecError } from "../builder";
import type { PMF } from "../pmf/pmf";
import { inspectTurn } from "./turn";

// The attack: `d20+5` vs AC 12: miss 0.30, hit 0.65, crit 0.05; mean damage 5.475 (`1d8+3`, `2d8+3` on a crit).
// The saves: `d20` vs DC 13: the target fails 0.60 and passes 0.40. On a failure it takes 8d6 (mean 28);
// under saveHalf a pass takes half, floored. Means: 16.8 without saveHalf, 22.3 with it.
const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
const SWORD = 5.475;
const normal = d20.dc(13).onSaveFailure(roll(8, d6));
const half = normal.saveHalf();
const NORMAL = 16.8;
const HALF = 22.3;

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

describe("a rider over a save row, by landing kind", () => {
  it("`fail`: a failed save lands, a pass never does", () => {
    for (const save of [normal, half]) {
      const t = turn(save).onFirstHit(flat(10), { landing: "fail", id: "rider" });
      expect(t.fireProbability("rider")).toBeCloseTo(0.6, 12);
    }
    const t = turn(normal).onFirstHit(flat(10), { landing: "fail" });
    expect(t.mean()).toBeCloseTo(NORMAL + 0.6 * 10, 12);
  });

  it("`damage`: a failed save lands, and so does a pass that deals save-for-half damage", () => {
    const withHalf = turn(half).onFirstHit(flat(10), { landing: "damage", id: "rider" });
    expect(withHalf.fireProbability("rider")).toBeCloseTo(1, 12);
    expect(withHalf.mean()).toBeCloseTo(HALF + 10, 12);
    // Without saveHalf a pass deals nothing: it is no landing under either kind.
    const without = turn(normal).onFirstHit(flat(10), { landing: "damage", id: "rider" });
    expect(without.fireProbability("rider")).toBeCloseTo(0.6, 12);
  });

  it("a save beside an attack: the first landing of either fires the rider", () => {
    // Fires unless the attack missed (0.30) and the target passed (0.40).
    const t = turn([sword, normal]).onFirstHit(flat(10), { landing: "damage", id: "rider" });
    expect(t.fireProbability("rider")).toBeCloseTo(1 - 0.3 * 0.4, 12);
    expect(t.mean()).toBeCloseTo(SWORD + NORMAL + 0.88 * 10, 12);
  });

  it("the first landing decides the mode: an attack's crit doubles the rider's dice, a save's landing does not", () => {
    // 2d6 has mean 7, and 4d6 on a crit has mean 14.
    const attackFirst = turn([sword, normal]).onFirstHit(roll(2, d6), { landing: "damage" });
    expect(attackFirst.mean()).toBeCloseTo(SWORD + NORMAL + (0.05 * 14 + 0.65 * 7 + 0.3 * 0.6 * 7), 12);
    // The save lands first (0.60): mode hit. Otherwise the attack is the first landing.
    const saveFirst = turn([normal, sword]).onFirstHit(roll(2, d6), { landing: "damage" });
    expect(saveFirst.mean()).toBeCloseTo(SWORD + NORMAL + (0.6 * 7 + 0.4 * (0.05 * 14 + 0.65 * 7)), 12);
  });

  it("`every-hit` fires once per landing, the save's included", () => {
    const t = turn([sword, normal]).onEveryHit(flat(2), { landing: "fail", id: "mark" });
    expect(t.mean()).toBeCloseTo(SWORD + NORMAL + 2 * (0.7 + 0.6), 12);
    expect(t.fireProbability("mark")).toBeCloseTo(1 - 0.3 * 0.4, 12);
  });

  it("`first-miss` and `any-miss` fire on a save the rider does not count as landed", () => {
    const failed = turn(normal).onAnyMiss(flat(3), { landing: "fail", id: "rider" });
    expect(failed.fireProbability("rider")).toBeCloseTo(0.4, 12);
    const afterPass = turn(normal).onFirstMiss(flat(3), { landing: "fail", id: "rider" });
    expect(afterPass.fireProbability("rider")).toBeCloseTo(0.4, 12);
    // A pass under saveHalf lands for a `damage` rider, so there is no miss to fire on.
    const dealt = turn(half).onAnyMiss(flat(3), { landing: "damage", id: "rider" });
    expect(dealt.fireProbability("rider")).toBeCloseTo(0, 12);
  });

  it("a save never crits: `any-crit` over a save and an attack fires on the attack's crit alone", () => {
    const t = turn([sword, normal]).onAnyCrit(flat(9), { landing: "damage", id: "rider" });
    expect(t.fireProbability("rider")).toBeCloseTo(0.05, 12);
  });

  it("an attack that may not happen, a save row that may not happen: a skipped row lands nothing", () => {
    const t = turn().attack(normal, { chance: 0.5 }).onFirstHit(flat(1), { landing: "fail", id: "rider" });
    expect(t.fireProbability("rider")).toBeCloseTo(0.5 * 0.6, 12);
  });

  it("a save that cannot fail, or cannot pass, is still a save row", () => {
    const immune = d20.plus(30).dc(5).onSaveFailure(roll(3, d6));
    expect(immune.toPMF().outcomes()).toEqual(["missNone"]);
    const never = turn(immune).onFirstHit(flat(1), { landing: "fail", id: "rider" });
    expect(never.fireProbability("rider")).toBeCloseTo(0, 12);
    const doomed = d20.plus(-30).dc(40).onSaveFailure(roll(3, d6)).saveHalf();
    const always = turn(doomed).onFirstHit(flat(1), { landing: "damage", id: "rider" });
    expect(always.fireProbability("rider")).toBeCloseTo(1, 12);
  });

  it("a save row's own stepStats do not depend on the riders that watch it", () => {
    const bare = turn([sword, normal]).stepStats("attack 2");
    expect(bare.hit).toBeCloseTo(1, 12);
    expect(bare.crit).toBe(0);
    const watched = [
      turn([sword, normal]).onFirstHit(flat(1), { landing: "fail" }),
      turn([sword, normal]).onFirstHit(flat(1), { landing: "damage" }),
      turn([sword, normal])
        .onFirstHit(flat(1), { landing: "fail" })
        .onEveryHit(flat(2), { landing: "damage" }),
    ];
    // Splitting the row's draws by class changes the last bit of a sum, never the value.
    for (const t of watched) {
      const stats = t.stepStats("attack 2");
      expect(stats.rolled).toBeCloseTo(bare.rolled, 12);
      expect(stats.hit).toBeCloseTo(bare.hit, 12);
      expect(stats.crit).toBe(0);
    }
  });
});

describe("a save's landing is what an attack that lands with the same odds does", () => {
  // The rider's own contribution, `mean(with) - mean(without)`, and its fire probability, must
  // not depend on whether the source is a save or an attack landing with the same probability.
  const contribution = (rows: () => Turn, rider: (t: Turn) => Turn): number =>
    rider(rows()).mean() - rows().mean();

  it("`fail` on a 0.60 save is an attack that hits 0.60 and never crits", () => {
    const attack = d20.plus(0).ac(9).onHit(d6).noCrit();
    expect(attack.resolve().weights.hit).toBeCloseTo(0.6, 12);
    const viaSave = (t: Turn) => t.onFirstHit(roll(2, d6), { landing: "fail", id: "rider" });
    const viaAttack = (t: Turn) => t.onFirstHit(roll(2, d6), { id: "rider" });
    expect(contribution(() => turn([sword, normal]), viaSave)).toBeCloseTo(
      contribution(() => turn([sword, attack]), viaAttack),
      12
    );
    expect(viaSave(turn([sword, normal])).fireProbability("rider")).toBeCloseTo(
      viaAttack(turn([sword, attack])).fireProbability("rider"),
      12
    );
  });

  it("`damage` on a save-for-half is an attack that always lands", () => {
    const always = d20.alwaysHits().onHit(d6).noCrit();
    const viaSave = (t: Turn) => t.onFirstHit(roll(2, d6), { landing: "damage", id: "rider" });
    const viaAttack = (t: Turn) => t.onFirstHit(roll(2, d6), { id: "rider" });
    expect(contribution(() => turn([sword, half]), viaSave)).toBeCloseTo(
      contribution(() => turn([sword, always]), viaAttack),
      12
    );
  });

  it("a landing kind on attack sources changes nothing", () => {
    const plain = turn([sword, sword]).onFirstHit(roll(3, d6));
    const declared = turn([sword, sword]).onFirstHit(roll(3, d6), { landing: "damage" });
    expect(maxDiff(declared.pmf, plain.pmf)).toBe(0);
  });

  it("the row itself is walked exactly as before: a rider over other rows leaves the save's damage alone", () => {
    const withRider = turn([sword, half]).onFirstHit(flat(4), { of: ["attack 1"], id: "rider" });
    expect(withRider.mean()).toBeCloseTo(SWORD + HALF + 4 * 0.7, 12);
  });
});

describe("watching a save is refused unless the rider says how it lands", () => {
  it("without a landing kind a save row is `not-an-attack`, and the error says how to watch it", () => {
    expect(codeOf(() => turn([sword, normal]).onFirstHit(d6))).toBe("not-an-attack");
    expect(() => turn([sword, normal]).onFirstHit(d6)).toThrow(/landing/);
    // A reader of another kind cannot borrow the landing another rider declared.
    expect(
      codeOf(() =>
        turn([sword, normal])
          .onFirstHit(d6, { landing: "fail", of: ["attack 2"] })
          .onEveryHit(advantage().untilNextAttack(), { of: ["attack 2"] })
      )
    ).toBe("not-an-attack");
    expect(codeOf(() => turn([sword, normal]).onFirstHit(keepBestDamage(), { of: ["attack 2"] }))).toBe(
      "not-an-attack"
    );
  });

  it("refuses a landing kind that means nothing", () => {
    const spec = (rider: object) => () =>
      Turn.from({ attacks: [sword, normal], riders: [{ damage: d6, ...rider } as never] });
    expect(codeOf(spec({ on: "first-hit", of: ["attack 2"], landing: "nope" }))).toBe("unsupported-trigger");
    expect(codeOf(spec({ id: "x", on: "not-fired", of: "y", landing: "fail" }))).toBe("unsupported-trigger");
    expect(codeOf(() => turn([sword, normal]).onFirstHit(d6, { landing: "fail" }).otherwise(d6, { landing: "fail" }))).toBe(
      "unsupported-trigger"
    );
  });

  it("refuses a landing kind on a transform; on a grant it is a condition field 0.17 evaluates", () => {
    expect(codeOf(() => turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { landing: "fail" }))).toBeUndefined();
    expect(codeOf(() => turn([sword, sword]).onFirstHit(keepBestDamage(), { landing: "fail" }))).toBe(
      "unsupported-trigger"
    );
  });

  it("dice-match still needs dice: a save has no descriptor", () => {
    expect(codeOf(() => turn([sword, normal]).onDiceMatch(["attack 2"], d6, { landing: "fail" }))).toBe(
      "no-dice-descriptor"
    );
  });
});

describe("a landing needs damage: `damage` is 'when you deal damage'", () => {
  it("a pass that deals nothing is no landing, though its label is saveHalf", () => {
    // 1d4 on a failure, half floored on a pass: a pass after a 1 deals 0. The target passes 0.4,
    // and a quarter of those passes rolled a 1, so 0.3 of the turns deal half damage.
    const small = d20.dc(13).onSaveFailure(roll(1, d4)).saveHalf();
    const damage = turn(small).onFirstHit(flat(10), { landing: "damage", id: "r" });
    expect(damage.fireProbability("r")).toBeCloseTo(0.6 + 0.4 * 0.75, 12);
    const fail = turn(small).onFirstHit(flat(10), { landing: "fail", id: "r" });
    expect(fail.fireProbability("r")).toBeCloseTo(0.6, 12);
  });
});

describe("two riders read one save row under different landing kinds", () => {
  // The failure deals 0, 1, 2 or 3 (d4 - 1), so every class of the row occurs: a failure that
  // deals damage, a failure that deals none, a pass that deals damage, a pass that deals none.
  // The oracle enumerates the eight (outcome, payload) cases by hand.
  const save = d20.dc(13).onSaveFailure(roll(1, d4).plus(-1)).saveHalf();
  const payloads = [0, 1, 2, 3];

  function enumerate(perCase: (failed: boolean, dealt: number) => number): Map<number, number> {
    const out = new Map<number, number>();
    for (const payload of payloads) {
      for (const failed of [true, false]) {
        const dealt = failed ? payload : Math.floor(payload / 2);
        const total = dealt + perCase(failed, dealt);
        out.set(total, (out.get(total) ?? 0) + (failed ? 0.6 : 0.4) / payloads.length);
      }
    }
    return out;
  }

  function expectSame(pmf: PMF, expected: Map<number, number>): void {
    for (const value of new Set([...pmf.support(), ...expected.keys()])) {
      expect(pmf.pAt(value)).toBeCloseTo(expected.get(value) ?? 0, 12);
    }
  }

  it("first-hit riders: one on failure (`fail`), one on damage (`damage`)", () => {
    const t = turn(save)
      .onFirstHit(flat(10), { landing: "fail", id: "failure" })
      .onFirstHit(flat(20), { landing: "damage", id: "damage" });
    expectSame(t.pmf, enumerate((failed, dealt) => (failed ? 10 : 0) + (dealt > 0 ? 20 : 0)));
    expect(t.fireProbability("failure")).toBeCloseTo(0.6, 12);
    expect(t.fireProbability("damage")).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.5, 12);
  });

  it("an every-hit rider on one kind beside a first-hit rider on the other", () => {
    const t = turn(save)
      .onEveryHit(flat(3), { landing: "fail", id: "mark" })
      .onFirstHit(flat(10), { landing: "damage", id: "damage" });
    expectSame(t.pmf, enumerate((failed, dealt) => (failed ? 3 : 0) + (dealt > 0 ? 10 : 0)));
    expect(t.fireProbability("mark")).toBeCloseTo(0.6, 12);
    expect(t.fireProbability("damage")).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.5, 12);
  });

  it("a save row that happens half the time", () => {
    const t = turn()
      .attack(save, { id: "row", chance: 0.5 })
      .onFirstHit(flat(10), { landing: "fail", of: ["row"] })
      .onFirstHit(flat(20), { landing: "damage", of: ["row"] });
    const happens = enumerate((failed, dealt) => (failed ? 10 : 0) + (dealt > 0 ? 20 : 0));
    const expected = new Map([...happens].map(([total, mass]) => [total, mass * 0.5]));
    expected.set(0, (expected.get(0) ?? 0) + 0.5);
    expectSame(t.pmf, expected);
  });

  it("beside an attack, each rider reads the save as its own kind says", () => {
    const t = turn([sword, save])
      .onFirstHit(flat(10), { landing: "fail", id: "failure" })
      .onFirstHit(flat(20), { landing: "damage", id: "damage" });
    // Both fire unless the attack missed (0.30); then the save decides each.
    expect(t.fireProbability("failure")).toBeCloseTo(1 - 0.3 * 0.4, 12);
    expect(t.fireProbability("damage")).toBeCloseTo(1 - 0.3 * (1 - (0.6 * 0.75 + 0.4 * 0.5)), 12);
  });
});

describe("landing kinds as plain data", () => {
  it("Turn.from reads `landing` on a rider like the fluent verb does", () => {
    const fromData = Turn.from({
      attacks: [sword, half],
      riders: [{ id: "rider", on: "first-hit", damage: roll(2, d6), landing: "damage" }],
    });
    const fluent = turn([sword, half]).onFirstHit(roll(2, d6), { landing: "damage", id: "rider" });
    expect(maxDiff(fromData.pmf, fluent.pmf)).toBe(0);
    expect(fromData.fireProbability("rider")).toBe(fluent.fireProbability("rider"));
    expect(JSON.parse(JSON.stringify({ on: "first-hit", landing: "damage" }))).toEqual({
      on: "first-hit",
      landing: "damage",
    });
  });

  it("a watched save row takes no group of its own beyond the rider's source set", () => {
    const t = turn([sword, normal]).onFirstHit(d6, { landing: "damage" });
    expect(inspectTurn(t).groupCount).toBe(1);
  });
});
