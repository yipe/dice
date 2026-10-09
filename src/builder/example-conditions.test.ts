// The guide's conditions examples, pinned to the oracle. Apart from example.test.ts because that file's Turn reads
// are checked call by call against the 0.16 fixture (tests/compat), and these examples are new in 0.17.
import { describe, expect, it } from "vitest";
import {
  enumerateSyntheticTurn,
  type AttackSpec,
  type EffectSpec,
  type GrantSpec,
  type SyntheticTurn,
} from "../../tests/oracle/bruteForce";
import type { PMF } from "../pmf/pmf";
import * as examples from "./example";
/**
 * The guide's conditions examples, each against its own oracle turn (tests/oracle/bruteForce.ts) at 1e-12. The oracle
 * shares no code with the library: it enumerates every d20 and damage face of the turn as the rules read it.
 */
describe("Conditions examples, against the oracle", () => {
  const TOLERANCE = 1e-12;
  /** The +8 vs AC 16 attacks of the examples (`longsword`, `longbow`, `smallFist`). */
  const strike = (damage: AttackSpec["damage"], extra: Partial<AttackSpec> = {}): AttackSpec => ({
    toHit: 8,
    ac: 16,
    critRange: 20,
    advantage: "flat",
    damage,
    ...extra,
  });
  const longsword = strike({ count: 1, sides: 8, flat: 4 }, { range: "melee" });
  const longbow = strike({ count: 1, sides: 8, flat: 4 }, { range: "ranged" });
  const smallFist = strike({ count: 1, sides: 6, flat: 4 });
  const advantageFor = (lifetime: "turn" | "next-attack"): EffectSpec => ({ kind: "advantage", lifetime });
  /** A grant on the first hit among `of`, as `turn.onFirstHit` spells it. */
  const firstHit = (of: number[], rest: Omit<GrantSpec, "of" | "trigger" | "cap">): GrantSpec => ({
    of,
    trigger: "hit",
    cap: "once",
    ...rest,
  });
  /** Topple on the first and third swords: a CON save or Prone, optional or forced. */
  const toppleGrants = (optional: boolean): GrantSpec[] =>
    [0, 2].map(
      (k): GrantSpec => ({
        of: [k],
        trigger: "hit",
        cap: "unlimited",
        ...(optional ? { optional: true } : {}),
        save: { ability: "constitution", dc: 15, saveBonus: 3 },
        effects: [{ kind: "condition", condition: "prone" }],
      })
    );
  const oracle = (synthetic: SyntheticTurn) => enumerateSyntheticTurn(synthetic, { detail: true });
  const expectMarginal = (actual: PMF, expected: Map<number, number>): void => {
    for (const value of new Set([...expected.keys(), ...actual.support()])) {
      expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `at ${value}`).toBeLessThanOrEqual(TOLERANCE);
    }
  };

  const means: [string, () => number, SyntheticTurn][] = [
    [
      "vex",
      () => examples.vex.mean(),
      {
        attacks: [longsword, longsword],
        grants: [{ of: [0], trigger: "hit", cap: "unlimited", effects: [advantageFor("next-attack")] }],
      },
    ],
    [
      "topple",
      () => examples.topple().mean(),
      { attacks: [longsword, longsword, longsword, longbow], grants: toppleGrants(true) },
    ],
    [
      "toppleForced",
      () => examples.toppleForced.mean(),
      { attacks: [longsword, longsword, longsword, longbow], grants: toppleGrants(false) },
    ],
    [
      "grappler",
      () => examples.grappler.mean(),
      {
        attacks: [longsword, longsword],
        grants: [
          firstHit([0, 1], {
            save: { ability: "strength", dc: 15, saveBonus: 5, alternatives: [{ ability: "dexterity", saveBonus: 1 }] },
            effects: [advantageFor("turn")],
          }),
        ],
      },
    ],
    [
      // The oracle rolls the contest itself (`contest`), so this checks `contestLossChance` too.
      "shove2014",
      () => examples.shove2014.mean(),
      {
        attacks: [strike({ count: 0, sides: 1, flat: 0 }, { toHit: 0, autoHit: true, range: "melee" }), longsword],
        grants: [
          {
            of: [0],
            trigger: "hit",
            cap: "unlimited",
            save: { ability: "strength", dc: 0, saveBonus: 7, contest: 5 },
            effects: [{ kind: "condition", condition: "prone" }],
          },
        ],
      },
    ],
    [
      "pathToTheGrave",
      () => examples.pathToTheGrave.mean(),
      {
        attacks: [longsword, longsword],
        grants: [{ of: [0], trigger: "start", cap: "once", effects: [{ kind: "vulnerability", lifetime: "next-hit" }] }],
      },
    ],
    [
      "startsRestrained",
      () => examples.startsRestrained.mean(),
      { attacks: [longsword, longsword, { ...longsword, target: 1 }], startingCondition: "restrained" },
    ],
  ];

  it.each(means)("%s: mean() is the oracle's", (_name, mean, synthetic) => {
    expect(Math.abs(mean() - oracle(synthetic).mean)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("topple: optional beats both toppling every time and never toppling", () => {
    const optional = examples.topple().mean();
    expect(optional).toBeGreaterThan(examples.toppleForced.mean() + 0.1);
    expect(optional).toBeGreaterThan(oracle({ attacks: [longsword, longsword, longsword, longbow] }).mean + 0.1);
  });

  it("stunningStrike: mean() and the third fist's advantage odds (stepStats) are the oracle's", () => {
    const t = examples.stunningStrike;
    const want = oracle({
      attacks: [smallFist, smallFist, smallFist],
      grants: [
        firstHit([0, 1, 2], {
          save: { ability: "constitution", dc: 15, saveBonus: 2 },
          effects: [{ kind: "condition", condition: "stunned" }],
          onPass: [advantageFor("next-attack")],
        }),
      ],
    });
    expect(Math.abs(t.mean() - want.mean)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(t.stepStats("attack 3").live.advantage - want.detail!.rows[2]!.effects.advantage.odds)).toBeLessThanOrEqual(
      TOLERANCE
    );
  });

  it("stunningStrike: P(the stun lands where a later fist reads it) is its closed form", () => {
    // The oracle reports per-row effect odds, not a grant's fire probability, so this one is derived by hand. A fist
    // (d20 + 8 vs AC 16) hits on 8..20: 13/20. The stun is read later only when the turn's first hit is fist 1 or 2,
    // 1 - (7/20)^2, and the CON save (d20 + 2 vs DC 15) fails on 1..12: 12/20. The two are independent.
    const hit = 13 / 20;
    const fail = 12 / 20;
    expect(Math.abs(examples.stunningStrike.fireProbability("stun") - (1 - (1 - hit) ** 2) * fail)).toBeLessThanOrEqual(
      TOLERANCE
    );
  });

  it("knockOut: mean() and the Sneak Attack rider's marginal are the oracle's", () => {
    const t = examples.knockOut;
    const want = oracle({
      attacks: [longsword, longsword, longsword],
      riders: [{ of: [0, 1, 2], trigger: "hit", damage: { count: 3, sides: 6 } }],
      grants: [
        {
          of: [0, 1, 2],
          trigger: "rider",
          rider: 0,
          cap: "once",
          save: { ability: "constitution", dc: 15, saveBonus: 2 },
          effects: [{ kind: "condition", condition: "unconscious", lifetime: "until-damaged" }],
        },
      ],
    });
    expect(Math.abs(t.mean() - want.mean)).toBeLessThanOrEqual(TOLERANCE);
    expectMarginal(t.marginal("sneak").pmf, want.detail!.riders[0]!.pmf);
  });

  it("frostbite: mean() and the breath save's marginal are the oracle's", () => {
    const t = examples.frostbite;
    const want = oracle({
      attacks: [strike({ count: 0, sides: 0, parts: [{ count: 2, sides: 8, type: "cold" }] }, { toHit: 7 })],
      saves: [{ dc: 15, saveBonus: 5, ability: "dexterity", onSuccess: "half", damage: { count: 4, sides: 6 } }],
      grants: [
        firstHit([0], { dealing: "cold", effects: [{ kind: "savePenalty", count: 1, sides: 4, lifetime: "next-save" }] }),
      ],
    });
    expect(Math.abs(t.mean() - want.mean)).toBeLessThanOrEqual(TOLERANCE);
    expectMarginal(t.marginal("breath").pmf, want.sources[1]!);
  });
});
