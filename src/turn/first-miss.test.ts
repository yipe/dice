import { describe, expect, it } from "vitest";
import { d4, d6, d10, d12, d20, roll, turn, Turn } from "../builder";
import type { AttackBuilder } from "../builder";
import type { PMF } from "../pmf/pmf";

function expectSamePMF(actual: PMF, expected: PMF, tolerance = 1e-12): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  let worst = 0;
  for (const value of support) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - expected.pAt(value)));
  }
  expect(worst).toBeLessThan(tolerance);
}

type Mode = "miss" | "hit" | "crit";

/** P(miss/hit/crit) for `d20 + bonus` against `ac`, crit on a natural 20 only. */
function outcomeOdds(bonus: number, ac: number): Record<Mode, number> {
  const odds: Record<Mode, number> = { miss: 0, hit: 0, crit: 0 };
  for (let r = 1; r <= 20; r++) {
    const mode: Mode = r === 20 ? "crit" : r === 1 || r + bonus < ac ? "miss" : "hit";
    odds[mode] += 1 / 20;
  }
  return odds;
}

/**
 * Enumerating the rules text: two muskets (`d20+9`, `1d12+18`), then two unarmed
 * strikes (`d20+11`, `1d10+5`), one reroll of the first missed musket, and a `1d10` rider on
 * the first landing among the muskets and the reroll — plus the unarmed strikes when
 * `riderWatchesUnarmed` — doubled on a crit. `firstMiss` places the reroll directly after the
 * musket it replaces; otherwise it happens after every declared attack.
 */
function o16Mean(ac: number, firstMiss: boolean, riderWatchesUnarmed = false): number {
  const musket = outcomeOdds(9, ac);
  const unarmed = outcomeOdds(11, ac);
  const musketDamage = { miss: 0, hit: 24.5, crit: 31 };
  const unarmedDamage = { miss: 0, hit: 10.5, crit: 16 };
  const riderDamage = { miss: 0, hit: 5.5, crit: 11 };
  const modes: Mode[] = ["miss", "hit", "crit"];

  let mean = 0;
  for (const one of modes) {
    for (const two of modes) {
      for (const three of modes) {
        for (const four of modes) {
          for (const reroll of modes) {
            const rerolls = one === "miss" || two === "miss";
            // The reroll's own outcome only exists when a musket missed.
            const pReroll = rerolls ? musket[reroll] : reroll === "miss" ? 1 : 0;
            const p = musket[one] * musket[two] * unarmed[three] * unarmed[four] * pReroll;
            if (p === 0) continue;
            const strikes: Mode[] = riderWatchesUnarmed ? [three, four] : [];
            const rerollSlot: Mode[] = rerolls ? [reroll] : [];
            const sequence: Mode[] =
              firstMiss && one === "miss"
                ? [...rerollSlot, two, ...strikes]
                : firstMiss
                  ? [one, two, ...rerollSlot, ...strikes]
                  : [one, two, ...strikes, ...rerollSlot];
            const first = sequence.find((mode) => mode !== "miss") ?? "miss";
            const damage =
              musketDamage[one] +
              musketDamage[two] +
              unarmedDamage[three] +
              unarmedDamage[four] +
              (rerolls ? musketDamage[reroll] : 0) +
              riderDamage[first];
            mean += p * damage;
          }
        }
      }
    }
  }
  return mean;
}

function o16Turn(ac: number, firstMiss: boolean, riderWatchesUnarmed = false): Turn {
  const musket = d20.plus(9).ac(ac).onHit(roll(1, d12).plus(18));
  const unarmed = d20.plus(11).ac(ac).onHit(roll(1, d10).plus(5));
  const base = turn()
    .attack(musket, { tag: "musket" })
    .attack(musket, { tag: "musket" })
    .attacks(2, unarmed, { tag: "unarmed" });
  const withReroll = firstMiss
    ? base.onFirstMiss(musket, { id: "reroll", of: ["musket"] })
    : base.onAnyMiss(musket, { id: "reroll", of: ["musket"] });
  const watched = riderWatchesUnarmed ? ["musket", "reroll", "unarmed"] : ["musket", "reroll"];
  return withReroll.onFirstHit(roll(1, d10), { of: watched });
}

describe("first-miss (R27)", () => {
  it("O13: identical to any-miss on two identical muskets — the symmetry argument", () => {
    const rows = [
      { ac: 15, base: 46.9, withReroll: 56.23125 },
      { ac: 18, base: 38.305, withReroll: 49.533 },
      { ac: 21, base: 29.4625, withReroll: 40.342875 },
    ];
    for (const row of rows) {
      const musket = d20.plus(9).ac(row.ac).onHit(roll(1, d12).plus(1, d4).plus(18));
      const pair = turn([musket, musket]);
      expect(pair.onFirstHit(roll(1, d10)).mean()).toBeCloseTo(row.base, 4);
      const anyMiss = pair.onAnyMiss(musket).onFirstHit(roll(1, d10));
      const firstMiss = pair.onFirstMiss(musket).onFirstHit(roll(1, d10));
      // Exact rational value (no /3 term survives a dice-total mean); the mean sits exactly
      // 5e-5 from the 4dp figure at AC 15, a toBeCloseTo(…, 4) boundary that passes or fails on
      // float noise. Assert precisely.
      expect(anyMiss.mean()).toBeCloseTo(row.withReroll, 10);
      expect(firstMiss.mean()).toBeCloseTo(row.withReroll, 10);
      expectSamePMF(firstMiss.pmf, anyMiss.pmf, 1e-12);
    }
  });

  it("O16: identical to any-miss too — the only order-reading rider watches the muskets and the reroll, which are i.i.d.", () => {
    const planAnyMiss: Record<number, number> = { 15: 69.75625, 18: 60.493, 21: 48.946 };
    for (const ac of [15, 18, 21]) {
      const anyMiss = o16Turn(ac, false);
      const firstMiss = o16Turn(ac, true);
      // Exact rational value; AC 15 sits exactly 5e-5 from the 4dp figure (69.7563), a
      // toBeCloseTo(…, 4) boundary that passes or fails on float noise. Assert precisely.
      expect(anyMiss.mean()).toBeCloseTo(planAnyMiss[ac], 10);
      expect(Math.abs(anyMiss.mean() - o16Mean(ac, false))).toBeLessThan(1e-9);
      expect(Math.abs(firstMiss.mean() - o16Mean(ac, true))).toBeLessThan(1e-9);
      expectSamePMF(firstMiss.pmf, anyMiss.pmf, 1e-12);
    }
  });

  it("differs from any-miss once an order-reading rider also watches attacks the reroll is not i.i.d. with", () => {
    for (const ac of [15, 18, 21]) {
      const anyMiss = o16Turn(ac, false, true).mean();
      const firstMiss = o16Turn(ac, true, true).mean();
      expect(Math.abs(anyMiss - o16Mean(ac, false, true))).toBeLessThan(1e-9);
      expect(Math.abs(firstMiss - o16Mean(ac, true, true))).toBeLessThan(1e-9);
      expect(firstMiss).not.toBeCloseTo(anyMiss, 4);
    }
  });

  it("fires once, on the first miss: as often as any-miss, and never twice", () => {
    const sword: AttackBuilder = d20.plus(5).ac(15).onHit(roll(1, d6).plus(3));
    const three = turn([sword, sword, sword]);
    const first = three.onFirstMiss(roll(2, d6), { id: "consolation" });
    const any = three.onAnyMiss(roll(2, d6), { id: "consolation" });
    expect(first.fireProbability("consolation")).toBeCloseTo(1 - 0.55 ** 3, 12);
    expect(first.fireProbability("consolation")).toBeCloseTo(any.fireProbability("consolation"), 12);
    expectSamePMF(first.pmf, any.pmf);
  });

  it("an attack-shaped first-miss rider joins later defaulted `of` sets (R18)", () => {
    const sword = d20.plus(5).ac(15).onHit(roll(1, d6).plus(3));
    const joined = turn([sword, sword]).onFirstMiss(sword, { id: "reroll" }).onFirstHit(roll(1, d10));
    const explicit = turn([sword, sword])
      .onFirstMiss(sword, { id: "reroll" })
      .onFirstHit(roll(1, d10), { of: ["attack 1", "attack 2", "reroll"] });
    expectSamePMF(joined.pmf, explicit.pmf);
  });

  it("round-trips through Turn.from as plain data", () => {
    const sword = d20.plus(5).ac(15).onHit(roll(1, d6).plus(3));
    const fromSpec = Turn.from({
      attacks: [sword, sword],
      riders: [{ id: "reroll", on: "first-miss", damage: sword }],
    });
    expectSamePMF(fromSpec.pmf, turn([sword, sword]).onFirstMiss(sword, { id: "reroll" }).pmf);
  });
});
