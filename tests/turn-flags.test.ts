/**
 * Single-creature flags with lifetimes, row contexts, `first-crit`, `landing:
 * "damage"` on attack rows, `next-hit` vulnerability and the state limit. Each shape runs through
 * `Turn.from` and the brute-force oracle and must agree at 1e-12 on the joint PMF and on every
 * row's marginal.
 */
import { describe, expect, it } from "vitest";
import { advantage, d4, d8, d20, roll, turn, Turn, TurnSpecError } from "../src/builder";
import type { PMF } from "../src/pmf/pmf";
import { enumerateSyntheticTurn, type AttackSpec, type GrantSpec, type SyntheticTurn } from "./oracle/bruteForce";
import { attack, grant, NEXT_ADVANTAGE } from "./oracle/v2/shapes";
import { oracleTurnToSpec, rowId } from "./oracle/v2/toSpec";

const TOLERANCE = 1e-12;

function worst(actual: PMF, expected: ReadonlyMap<number, number>): number {
  let diff = 0;
  for (const value of new Set([...actual.support(), ...expected.keys()])) {
    diff = Math.max(diff, Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)));
  }
  return diff;
}

function expectOracle(synthetic: SyntheticTurn): void {
  const t = Turn.from(oracleTurnToSpec(synthetic));
  const oracle = enumerateSyntheticTurn(synthetic);
  expect(worst(t.pmf, oracle.pmf)).toBeLessThanOrEqual(TOLERANCE);
  oracle.sources.forEach((pmf, k) => expect(worst(t.marginal(rowId(k)).pmf, pmf)).toBeLessThanOrEqual(TOLERANCE));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
}

const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
/** A hit that deals 0 half the time: 1d4 - 2, floored at 0. */
const weak = attack({ damage: { count: 1, sides: 4, flat: -2, floorAtZero: true } });
const crit = (extra: Partial<GrantSpec> = {}): GrantSpec => grant({ trigger: "crit", ...extra });

describe("flags: flags and lifetimes against the oracle", () => {
  it.each<[string, SyntheticTurn]>([
    ["first-crit: the first crit grants the next attack advantage", { attacks: [attack(), attack(), attack()], grants: [crit({ of: [0, 1], cap: "once" })] }],
    ["any-crit: every crit does", { attacks: [attack(), attack(), attack()], grants: [crit({ of: [0, 1] })] }],
    ["landing damage: a hit that deals 0 lands nothing", { attacks: [weak, attack(), attack()], grants: [grant({ trigger: "damage", of: [0, 1] })] }],
    ["landing damage, once", { attacks: [weak, weak, attack()], grants: [grant({ trigger: "damage", of: [0, 1], cap: "once" })] }],
    [
      "vulnerability: the next hit doubles, a miss leaves it",
      { attacks: [attack(), attack(), attack(), attack()], grants: [grant({ of: [0], effects: [{ kind: "vulnerability", lifetime: "next-hit" }] })] },
    ],
    [
      "a crit grant feeds crit-on-hit, which feeds a crit grant",
      {
        attacks: [attack(), attack(), attack()],
        grants: [
          grant({ of: [0], effects: [{ kind: "critOnHit", lifetime: "turn" }] }),
          crit({ of: [1], effects: [{ kind: "advantage", lifetime: "turn" }] }),
        ],
      },
    ],
    [
      "Elven Accuracy: own advantage stays two dice until the state grants one",
      {
        attacks: [attack(), attack({ advantage: "advantage", elvenAccuracy: true } as Partial<AttackSpec>)],
        grants: [grant({ of: [0], effects: [{ kind: "advantage", lifetime: "turn" }] })],
      },
    ],
    [
      "a pinned roll ignores granted advantage but still uses it up",
      {
        attacks: [attack(), attack({ rollOverride: "disadvantage" } as Partial<AttackSpec>), attack()],
        grants: [grant({ of: [0], effects: [NEXT_ADVANTAGE] })],
      },
    ],
    [
      "next-attack flags with disjoint lives share a bit",
      {
        attacks: Array.from({ length: 6 }, () => attack()),
        grants: Array.from({ length: 5 }, (_, i) => grant({ of: [i], effects: [{ kind: "advantage", lifetime: "next-attack", to: [i + 1] }] })),
      },
    ],
  ])("%s", (_name, synthetic) => {
    expectOracle(synthetic);
  });
});

describe("flags: limits", () => {
  it("nine live flags walk; thirty-one live at once is too-many-states", () => {
    const once = turn([sword, sword]).onEveryHit(advantage().untilNextAttack(), { of: ["attack 1"] });
    let t = turn([sword, sword]);
    for (let i = 0; i < 9; i++) t = t.onEveryHit(advantage().untilNextAttack(), { of: ["attack 1"] });
    expect(t.mean()).toBeCloseTo(once.mean(), 12);
    let wide = turn([sword, sword]);
    for (let i = 0; i < 30; i++) wide = wide.onEveryHit(advantage().untilNextAttack(), { of: ["attack 1"] });
    expect(wide.mean()).toBeCloseTo(once.mean(), 12);
    expect(codeOf(() => wide.onEveryHit(advantage().untilNextAttack(), { of: ["attack 1"] }))).toBe("too-many-states");
  });

  it("forty chained next-attack grants reuse two bits", () => {
    const attacks = Array.from({ length: 41 }, (_, i) => ({ id: `a${i}`, source: sword }));
    const conditions = attacks.slice(0, 40).map((_, i) => ({
      on: "every-hit" as const,
      of: [`a${i}`],
      grants: [{ advantage: true as const, until: "next-attack" as const, to: [`a${i + 1}`] }],
    }));
    // A Markov chain on "the previous attack landed": attack i+1 has advantage with probability q_i, where
    // q_0 = 0 and q_{i+1} = q_i * L_adv + (1 - q_i) * L_flat (d20 + 5 vs AC 12 lands on 7..20).
    const landFlat = 0.7;
    const landAdv = 1 - 0.3 ** 2;
    const flatMean = sword.mean();
    const advMean = d20.withAdvantage().plus(5).ac(12).onHit(roll(1, d8).plus(3)).mean();
    let q = 0;
    let expected = 0;
    for (let i = 0; i < 41; i++) {
      expected += q * advMean + (1 - q) * flatMean;
      q = q * landAdv + (1 - q) * landFlat;
    }
    expect(Turn.from({ attacks, conditions }).mean()).toBeCloseTo(expected, 10);
  });

  it("a walk past the turn's stateLimit is too-many-states", () => {
    const spec = {
      attacks: [sword, sword, sword],
      conditions: [{ on: "every-hit" as const, of: ["attack 1"], grants: [{ advantage: true as const, until: "end-of-turn" as const }] }],
      riders: [{ on: "first-hit" as const, damage: roll(1, d4) }],
    };
    // Attack 1 lands (0.7) and gives attacks 2 and 3 advantage; the d4 (doubled on a crit) rides the first landing,
    // which is attack 1, 2 or 3 after 0, 1 or 2 flat misses (no advantage without a landing).
    const advMean = d20.withAdvantage().plus(5).ac(12).onHit(roll(1, d8).plus(3)).mean();
    const attacksMean = sword.mean() + 0.7 * 2 * advMean + 0.3 * 2 * sword.mean();
    const riderMean = (0.05 * 5 + 0.65 * 2.5) * (1 + 0.3 + 0.3 ** 2);
    expect(Turn.from(spec).mean()).toBeCloseTo(attacksMean + riderMean, 12);
    expect(codeOf(() => Turn.from({ ...spec, stateLimit: 1 }).mean())).toBe("too-many-states");
    expect(() => Turn.from({ ...spec, stateLimit: 0 })).toThrow(RangeError);
  });
});

function maxDiff(a: PMF, b: PMF): number {
  let diff = 0;
  for (const value of new Set([...a.support(), ...b.support()])) diff = Math.max(diff, Math.abs(a.pAt(value) - b.pAt(value)));
  return diff;
}

describe("flags: references that read nothing", () => {
  it("a `to` with no attack roll after the condition's sources is a no-op; a missing id is unknown-id", () => {
    const unreachable = turn([sword, sword]).onEveryHit(advantage().untilNextAttack().to("attack 1"), { of: ["attack 2"] });
    expect(maxDiff(unreachable.pmf, turn([sword, sword]).pmf)).toBe(0);
    expect(codeOf(() => turn([sword, sword]).onEveryHit(advantage().untilNextAttack().to("nowhere")))).toBe("unknown-id");
  });

  it("an explicit `of: []` never lands; an omitted `of` keeps its default; a missing id still fails", () => {
    const t = Turn.from({
      attacks: [{ id: "a", source: sword }],
      riders: [{ id: "never", on: "first-hit", of: [], damage: roll(2, d8) }],
      conditions: [{ id: "c", on: "every-hit", of: [], grants: [{ advantage: true, until: "end-of-turn" }] }],
    });
    expect(t.fireProbability("never")).toBe(0);
    expect(t.fireProbability("c")).toBe(0);
    expect(t.marginal("never").pmf.mean()).toBe(0);
    expect(t.mean()).toBeCloseTo(sword.mean(), 12);
    const defaulted = Turn.from({ attacks: [{ id: "a", source: sword }], riders: [{ id: "r", on: "first-hit", damage: roll(2, d8) }] });
    expect(defaulted.fireProbability("r")).toBeCloseTo(0.7, 12);
    expect(
      codeOf(() => Turn.from({ attacks: [{ id: "a", source: sword }], riders: [{ on: "first-hit", of: ["missing"], damage: roll(2, d8) }] }))
    ).toBe("unknown-id");
    expect(codeOf(() => turn().onFirstHit(roll(2, d8)))).toBe("unknown-id");
  });
});
