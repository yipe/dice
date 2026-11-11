/**
 * Turn-level first-miss rerolls (`substitute: "reroll"`, `Turn.rerollFirstMiss`): Heroic Inspiration (`reroll`) and 2014 Lucky
 * (`add-d20`), stackable in declaration order, exact. Every pin is checked twice: against the number worked out by exact
 * enumeration of every d20 face while the plan was written, and against the brute-force oracle (`tests/oracle/bruteForce.ts`,
 * which shares no code with the library), both at 1e-12.
 */
import { describe, expect, it } from "vitest";
import { d4, d6, d8, d10, d20, keepBestDamage, roll, turn, Turn, TurnSpecError } from "../builder";
import type { AttackBuilder, ContextualSource, RowContext } from "../builder";
import { vex } from "../dnd5e";
import { enumerateSyntheticTurn } from "../../tests/oracle/bruteForce";
import type { AttackSpec, SyntheticTurn } from "../../tests/oracle/bruteForce";
import { lcgRng } from "../../tests/helpers/lcg";
import type { TurnSpec } from "./types";

const TOLERANCE = 1e-12;

type Mode = "reroll" | "add-d20";

const r7 = d20.plus(7).ac(16).onHit(roll(1, d8).plus(4));
const r6 = d20.plus(6).ac(16).onHit(roll(1, d10).plus(3));
const r5 = d20.plus(5).ac(15).onHit(roll(1, d8).plus(4));

const o7: AttackSpec = { toHit: 7, ac: 16, critRange: 20, advantage: "flat", damage: { count: 1, sides: 8, flat: 4 } };
const o6: AttackSpec = { toHit: 6, ac: 16, critRange: 20, advantage: "flat", damage: { count: 1, sides: 10, flat: 3 } };
const o5: AttackSpec = { toHit: 5, ac: 15, critRange: 20, advantage: "flat", damage: { count: 1, sides: 8, flat: 4 } };

const everyRow = (count: number): number[] => Array.from({ length: count }, (_, i) => i);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TurnSpecError);
    return (error as TurnSpecError).code;
  }
  return undefined;
}

/** The library's mean and fire probabilities against the pin and the oracle's, all at 1e-12. */
function expectPinned(
  t: Turn,
  synthetic: SyntheticTurn,
  mean: number,
  fires: readonly number[] = [],
  ids: readonly string[] = []
): void {
  expect(t.mean()).toBeCloseTo(mean, 11);
  expect(Math.abs(t.mean() - mean)).toBeLessThanOrEqual(TOLERANCE);
  const oracle = enumerateSyntheticTurn(synthetic);
  expect(Math.abs(oracle.mean - mean)).toBeLessThanOrEqual(TOLERANCE);
  fires.forEach((fire, i) => {
    expect(Math.abs(t.fireProbability(ids[i])! - fire), `fire ${ids[i]}`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs((oracle.rerollSpent as number[])[i] - fire), `oracle fire ${i}`).toBeLessThanOrEqual(TOLERANCE);
  });
  for (const value of new Set([...t.pmf.support(), ...oracle.pmf.keys()])) {
    expect(Math.abs(t.pmf.pAt(value) - (oracle.pmf.get(value) ?? 0)), `pmf at ${value}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

describe("rerollFirstMiss: pinned means, each against the oracle", () => {
  it("T1: two +7 swings, Sneak Attack on the first landing, one reroll over both", () => {
    const base = turn([r7, r7]).onFirstHit(roll(2, d6));
    expectPinned(base, { attacks: [o7, o7], riders: [{ of: [0, 1], trigger: "hit", damage: { count: 2, sides: 6 } }] }, 17.02);
    expectPinned(
      base.rerollFirstMiss({ id: "luck" }),
      {
        attacks: [o7, o7],
        riders: [{ of: [0, 1], trigger: "hit", damage: { count: 2, sides: 6 } }],
        rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }],
      },
      21.156,
      [0.64],
      ["luck"]
    );
  });

  it("T2: add-d20 over an advantage swing and a flat one, both with a 1d4 to hit", () => {
    const adv = d20.plus(5).plus(1, d4).withAdvantage().ac(17).onHit(roll(1, d8).plus(4));
    const flat = d20.plus(5).plus(1, d4).ac(17).onHit(roll(1, d8).plus(4));
    const bonus = [{ count: 1, sides: 4, sign: 1 as const }];
    const damage = { count: 1, sides: 8, flat: 4 };
    const oa: AttackSpec = { toHit: 5, ac: 17, critRange: 20, advantage: "advantage", damage, toHitDice: bonus };
    const of: AttackSpec = { toHit: 5, ac: 17, critRange: 20, advantage: "flat", damage, toHitDice: bonus };
    expectPinned(
      turn([adv, flat]).rerollFirstMiss({ id: "lucky", mode: "add-d20" }),
      { attacks: [oa, of], rerollFirstMiss: [{ of: [0, 1], mode: "add-d20" }] },
      15.1580953125,
      [0.53065625],
      ["lucky"]
    );
  });

  it("T3: three swings, Heroic Inspiration then 2014 Lucky, each takes a different miss", () => {
    const attacks = [o6, o6, o6];
    const both: SyntheticTurn = {
      attacks,
      rerollFirstMiss: [
        { of: [0, 1, 2], mode: "reroll" },
        { of: [0, 1, 2], mode: "add-d20" },
      ],
    };
    expectPinned(
      turn([r6, r6, r6]).rerollFirstMiss({ id: "hi" }).rerollFirstMiss({ id: "lucky", mode: "add-d20" }),
      both,
      21.08143125,
      [0.833625, 0.42525],
      ["hi", "lucky"]
    );
    expectPinned(
      turn([r6, r6, r6]).rerollFirstMiss({ id: "hi" }),
      { attacks, rerollFirstMiss: [{ of: [0, 1, 2], mode: "reroll" }] },
      18.97644375,
      [0.833625],
      ["hi"]
    );
  });

  it("T4: a disadvantage swing: `reroll` keeps the higher die in play, `add-d20` keeps the best of all three", () => {
    const dis = d20.plus(6).withDisadvantage().ac(14).onHit(roll(1, d8).plus(4));
    const od: AttackSpec = { toHit: 6, ac: 14, critRange: 20, advantage: "disadvantage", damage: { count: 1, sides: 8, flat: 4 } };
    expectPinned(
      turn([dis]).rerollFirstMiss({ id: "hi" }),
      { attacks: [od], rerollFirstMiss: [{ of: [0], mode: "reroll" }] },
      6.12425,
      [0.5775],
      ["hi"]
    );
    expectPinned(
      turn([dis]).rerollFirstMiss({ id: "lucky", mode: "add-d20" }),
      { attacks: [od], rerollFirstMiss: [{ of: [0], mode: "add-d20" }] },
      8.426375,
      [0.5775],
      ["lucky"]
    );
  });

  it("T5: a rerolled hit lands Vex like any hit", () => {
    expectPinned(
      turn([r5.onEveryHit(vex()), r5]).rerollFirstMiss({ id: "hi" }),
      {
        attacks: [o5, o5],
        grants: [{ of: [0], trigger: "hit", cap: "unlimited", effects: [{ kind: "advantage", lifetime: "next-attack" }] }],
        rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }],
      },
      14.39894375,
      [0.561375],
      ["hi"]
    );
  });

  it("T6: a reroll that watches only attack 2 never spends on attack 1", () => {
    expectPinned(
      turn([r7, r7]).rerollFirstMiss({ id: "hi", of: "attack 2" }),
      { attacks: [o7, o7], rerollFirstMiss: [{ of: [1], mode: "reroll" }] },
      12.78,
      [0.4],
      ["hi"]
    );
  });

  it("T7: a rerolled landing spends an unspent Savage Attacker (keep-higher) like any landing", () => {
    const savage = { of: [0, 1] };
    expectPinned(
      turn([r7, r7]).onFirstHit(keepBestDamage()),
      { attacks: [o7, o7], keepHigherFirstHit: savage },
      11.78982421875
    );
    expectPinned(
      turn([r7, r7]).onFirstHit(keepBestDamage()).rerollFirstMiss({ id: "hi" }),
      { attacks: [o7, o7], keepHigherFirstHit: savage, rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }] },
      15.32808984375,
      [0.64],
      ["hi"]
    );
  });
});

describe("rerollFirstMiss: the mixture shapes dpr reuses", () => {
  const row = d20.plus(5).ac(15).onHit(roll(1, d4).plus(7));
  const vexRow = row.onEveryHit(vex());
  const oracleRow: AttackSpec = { toHit: 5, ac: 15, critRange: 20, advantage: "flat", damage: { count: 1, sides: 4, flat: 7 } };

  const CASES: ReadonlyArray<readonly [n: number, vexed: boolean, mean: number, none: number, fire: number]> = [
    [1, false, 7.7575, 5.35, 0.45],
    [2, false, 14.431625, 10.7, 0.6975],
    [2, true, 15.67318125, 12.0585, 0.561375],
    [3, false, 20.50989375, 16.05, 0.833625],
    [3, true, 23.495711234375, 19.10322875, 0.6501965625],
  ];

  it.each(CASES)("%i rows, vex %s", (n, vexed, mean, none, fire) => {
    const rows = Array.from({ length: n }, () => (vexed ? vexRow : row));
    const synthetic: SyntheticTurn = {
      attacks: Array.from({ length: n }, () => oracleRow),
      ...(vexed ? { grants: [{ of: everyRow(n), trigger: "hit" as const, cap: "unlimited" as const, effects: [{ kind: "advantage" as const, lifetime: "next-attack" as const }] }] } : {}),
    };
    expectPinned(turn(rows), synthetic, none);
    expectPinned(
      turn(rows).rerollFirstMiss({ id: "hi" }),
      { ...synthetic, rerollFirstMiss: [{ of: everyRow(n), mode: "reroll" }] },
      mean,
      [fire],
      ["hi"]
    );
  });
});

describe("rerollFirstMiss: cross-checks", () => {
  const damage = { count: 1, sides: 8, flat: 4 };
  const plain = (advantage: "flat" | "advantage" | "disadvantage"): AttackSpec => ({ toHit: 7, ac: 16, critRange: 20, advantage, damage });
  const sword = (type: "flat" | "advantage" | "disadvantage"): AttackBuilder => {
    const base = d20.plus(7);
    const rolled = type === "advantage" ? base.withAdvantage() : type === "disadvantage" ? base.withDisadvantage() : base;
    return rolled.ac(16).onHit(roll(1, d8).plus(4));
  };

  it.each<[string, "flat" | "advantage" | "disadvantage", Mode[], number]>([
    ["flat, reroll", "flat", ["reroll"], 14.058],
    ["advantage, reroll", "advantage", ["reroll"], 16.72518],
    ["advantage, add-d20 (the kept die already missed, so the new one decides alone)", "advantage", ["add-d20"], 16.72518],
    ["disadvantage, reroll", "disadvantage", ["reroll"], 9.48402],
    ["disadvantage, add-d20", "disadvantage", ["add-d20"], 13.22946],
    ["flat, reroll then add-d20", "flat", ["reroll", "add-d20"], 14.91],
  ])("two rows +7 vs 16, 1d8+4: %s", (_name, type, modes, mean) => {
    let t = turn([sword(type), sword(type)]);
    modes.forEach((mode, i) => (t = t.rerollFirstMiss({ id: `r${i}`, mode })));
    expectPinned(t, { attacks: [plain(type), plain(type)], rerollFirstMiss: modes.map((mode) => ({ of: [0, 1], mode })) }, mean);
  });

  it("disadvantage without a reroll is 6.1425", () => {
    expect(turn([sword("disadvantage"), sword("disadvantage")]).mean()).toBeCloseTo(6.1425, 12);
  });

  it("a rerolled miss keeps the miss payload (Graze), and a row that may not happen is not a miss", () => {
    const graze = d20.plus(7).ac(16).onHit(roll(1, d8).plus(4)).onMiss(roll(1, d4));
    const grazeSpec: AttackSpec = { ...o7, missDamage: { kind: "dice", damage: { count: 1, sides: 4 } } };
    expectPinned(
      turn([graze, graze]).rerollFirstMiss({ id: "hi" }),
      { attacks: [grazeSpec, grazeSpec], rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }] },
      turn([graze, graze]).rerollFirstMiss({ id: "hi" }).mean(),
      [turn([graze, graze]).rerollFirstMiss({ id: "hi" }).fireProbability("hi") as number],
      ["hi"]
    );
    const sometimes = turn([r7, r7]).rerollFirstMiss({ id: "hi" });
    const chancy = Turn.from({
      attacks: [{ id: "a", source: r7, chance: 0.5 }, { id: "b", source: r7 }],
      substitutes: [{ id: "hi", on: "first-miss", substitute: "reroll" }],
    });
    const oracle = enumerateSyntheticTurn({
      attacks: [{ ...o7, chance: 0.5 }, o7],
      rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }],
    });
    expect(Math.abs(chancy.mean() - oracle.mean)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(chancy.fireProbability("hi") - (oracle.rerollSpent as number[])[0])).toBeLessThanOrEqual(TOLERANCE);
    expect(sometimes.mean()).toBeGreaterThan(chancy.mean());
  });

  it("a vulnerable row's rerolled hit doubles", () => {
    const sword2 = d20.plus(7).ac(16).onHit(roll(1, d8).plus(4));
    const t = Turn.from({
      attacks: [{ id: "a", source: sword2 }, { id: "b", source: sword2 }],
      conditions: [{ id: "curse", on: "first-hit", of: ["a"], grants: [{ advantage: true, until: "next-attack" }] }],
      substitutes: [{ id: "hi", on: "first-miss", substitute: "reroll", of: ["a", "b"] }],
    });
    const oracle = enumerateSyntheticTurn({
      attacks: [o7, o7],
      grants: [{ of: [0], trigger: "hit", cap: "unlimited", effects: [{ kind: "advantage", lifetime: "next-attack" }] }],
      rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }],
    });
    expect(Math.abs(t.mean() - oracle.mean)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("a reroll whose `of` is empty is refused like any substitute with no sources", () => {
    expect(codeOf(() => turn([r7, r7]).rerollFirstMiss({ id: "hi", of: [] }))).toBe("unknown-id");
  });

  it("reports a rerolled row's marginal as what it dealt", () => {
    const t = turn([r7, r7]).rerollFirstMiss({ id: "hi" });
    const oracle = enumerateSyntheticTurn({ attacks: [o7, o7], rerollFirstMiss: [{ of: [0, 1], mode: "reroll" }] });
    oracle.sources.forEach((expected, k) => {
      const marginal = t.marginal(`attack ${k + 1}`).pmf;
      for (const value of new Set([...marginal.support(), ...expected.keys()])) {
        expect(Math.abs(marginal.pAt(value) - (expected.get(value) ?? 0)), `attack ${k + 1} at ${value}`).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  });
});

describe("rerollFirstMiss: serialization and sources", () => {
  const spec: TurnSpec = {
    attacks: [
      { id: "a", source: r7 },
      { id: "b", source: r7 },
    ],
    riders: [{ id: "sa", on: "first-hit", damage: roll(2, d6) }],
    substitutes: [{ id: "luck", on: "first-miss", substitute: "reroll", mode: "reroll", of: ["a", "b"] }],
  };

  it("round-trips through JSON bit for bit, and equals the fluent spelling", () => {
    const viaJson = Turn.from({ ...spec, substitutes: JSON.parse(JSON.stringify(spec.substitutes)) });
    const fluent = turn([r7, r7]).onFirstHit(roll(2, d6)).rerollFirstMiss({ id: "luck" });
    expect(viaJson.mean()).toBe(Turn.from(spec).mean());
    expect(viaJson.mean()).toBeCloseTo(21.156, 12);
    expect(fluent.mean()).toBe(viaJson.mean());
  });

  it("`mode` defaults to reroll", () => {
    const withMode = Turn.from(spec);
    const without = Turn.from({ ...spec, substitutes: [{ id: "luck", on: "first-miss", substitute: "reroll", of: ["a", "b"] }] });
    expect(without.mean()).toBe(withMode.mean());
  });

  it("a ContextualSource with only under/rowCheck/rollUnder rerolls through its rollUnder builder", () => {
    const source: ContextualSource = {
      rowCheck: r7.rowCheck,
      under: (context: RowContext) => r7.under(context),
      rollUnder: (context: RowContext) => r7.rollUnder(context),
    };
    const t = Turn.from({
      attacks: [{ id: "a", source }, { id: "b", source }],
      riders: [{ id: "sa", on: "first-hit", damage: roll(2, d6) }],
      substitutes: [{ id: "luck", on: "first-miss", substitute: "reroll" }],
    });
    expect(Math.abs(t.mean() - 21.156)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("missRerolledUnder supplies the rerolled PMF where the source has no builder", () => {
    const source: ContextualSource = {
      rowCheck: r7.rowCheck,
      under: (context: RowContext) => r7.under(context),
      missRerolledUnder: (context: RowContext, mode) => r7.missRerolled(mode, context),
    };
    const t = Turn.from({
      attacks: [{ id: "a", source }, { id: "b", source }],
      riders: [{ id: "sa", on: "first-hit", damage: roll(2, d6) }],
      substitutes: [{ id: "luck", on: "first-miss", substitute: "reroll" }],
    });
    expect(Math.abs(t.mean() - 21.156)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("a source with neither rollUnder nor missRerolledUnder is refused", () => {
    const source: ContextualSource = { rowCheck: r7.rowCheck, under: (context: RowContext) => r7.under(context) };
    const build = (): Turn =>
      Turn.from({ attacks: [{ id: "a", source }], substitutes: [{ id: "luck", on: "first-miss", substitute: "reroll" }] });
    expect(codeOf(() => build().mean())).toBe("no-rebindable-source");
  });
});

describe("rerollFirstMiss: refusals", () => {
  const attacks = [
    { id: "a", source: r7 },
    { id: "b", source: r7 },
  ];
  const code = (substitutes: unknown[], extra: Partial<TurnSpec> = {}): string | undefined =>
    codeOf(() => Turn.from({ attacks, substitutes, ...extra } as TurnSpec).mean());

  it("a hit conversion beside a reroll, and two first-hit transforms, share a source: duplicate-substitute", () => {
    expect(code([{ id: "c", on: "first-miss", substitute: "hit" }, { id: "r", on: "first-miss", substitute: "reroll" }])).toBe("duplicate-substitute");
    expect(code([{ id: "r", on: "first-miss", substitute: "reroll" }, { id: "c", on: "first-miss", substitute: "hit" }])).toBe("duplicate-substitute");
    expect(
      code([
        { id: "k1", on: "first-hit", substitute: "reroll-keep-higher" },
        { id: "k2", on: "first-hit", substitute: "reroll-keep-higher" },
      ])
    ).toBe("duplicate-substitute");
    expect(
      code([
        { id: "c1", on: "first-miss", substitute: "hit" },
        { id: "c2", on: "first-miss", substitute: "hit" },
      ])
    ).toBe("duplicate-substitute");
  });

  it("allows several rerolls and one `always` keep-higher on one source", () => {
    expect(
      code([
        { id: "r1", on: "first-miss", substitute: "reroll" },
        { id: "r2", on: "first-miss", substitute: "reroll", mode: "add-d20" },
        { id: "k", on: "first-hit", substitute: "reroll-keep-higher", policy: { kind: "always" } },
      ])
    ).toBeUndefined();
  });

  it("a `below` policy beside a reroll is unsupported-policy", () => {
    expect(
      code([
        { id: "r", on: "first-miss", substitute: "reroll" },
        { id: "k", on: "first-hit", substitute: "reroll-keep-higher", policy: { kind: "below", hit: 8, crit: 16 } },
      ])
    ).toBe("unsupported-policy");
  });

  it("a policy on a reroll is unsupported-policy", () => {
    expect(code([{ id: "r", on: "first-miss", substitute: "reroll", policy: { kind: "always" } }])).toBe("unsupported-policy");
  });

  it("a `mode` on another substitute, or an unknown mode, is unsupported-trigger", () => {
    expect(code([{ id: "k", on: "first-hit", substitute: "reroll-keep-higher", mode: "reroll" }])).toBe("unsupported-trigger");
    expect(code([{ id: "c", on: "first-miss", substitute: "hit", mode: "reroll" }])).toBe("unsupported-trigger");
    expect(code([{ id: "r", on: "first-miss", substitute: "reroll", mode: "double" }])).toBe("unsupported-trigger");
    expect(code([{ id: "r", on: "first-hit", substitute: "reroll" }])).toBe("unsupported-trigger");
  });

  it("a reroll watching a row that rolls no attack is not-an-attack", () => {
    const fireball = d20.plus(3).dc(15).onSaveFailure(roll(8, d6)).saveHalf();
    expect(codeOf(() => turn([fireball]).rerollFirstMiss().mean())).toBe("not-an-attack");
  });

  it("a reroll watching a row an attack-shaped first-miss rider rerolls is refused", () => {
    expect(codeOf(() => turn([r7]).onFirstMiss(r7, { id: "again" }).rerollFirstMiss({ of: "attack 1" }).mean())).toBe("unsupported-trigger");
  });

  it("a row whose check already rerolls its misses is unsupported-trigger", () => {
    const lucky = d20.plus(7).ac(16).onHit(roll(1, d8).plus(4)).rerollMisses();
    expect(codeOf(() => turn([lucky, r7]).rerollFirstMiss().mean())).toBe("unsupported-trigger");
  });
});

describe("rerollFirstMiss: Turn.sample", () => {
  it("20,000 seeded samples of T1 average within 0.15 of 21.156", () => {
    const t = turn([r7, r7]).onFirstHit(roll(2, d6)).rerollFirstMiss({ id: "luck" });
    const rng = lcgRng(0xd2d2);
    let sum = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) sum += t.sample(rng).total;
    expect(Math.abs(sum / N - 21.156)).toBeLessThan(0.15);
  });

  it("samples a stack with Savage Attacker near its exact mean", () => {
    const t = turn([r7, r7]).onFirstHit(keepBestDamage()).rerollFirstMiss({ id: "hi" }).rerollFirstMiss({ id: "lucky", mode: "add-d20" });
    const rng = lcgRng(0xbeef);
    let sum = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) sum += t.sample(rng).total;
    expect(Math.abs(sum / N - t.mean())).toBeLessThan(0.2);
  });
});
