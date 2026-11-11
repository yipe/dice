import { describe, expect, it } from "vitest";
import {
  enumerateSyntheticTurn,
  type AttackSpec,
  type RiderSpec,
  type SyntheticTurn,
} from "../../tests/oracle/bruteForce";
import { lcgRng } from "../../tests/helpers/lcg";
import { critOnHit, d, d20, d6, d8, flat, roll, turn, Turn, TurnSpecError } from "../builder";
import { exhaustion, frightened, prone, RULES, saveDC } from "../dnd5e";
import type { ConditionSpec, Rider, TurnSpec } from "./types";

const TOLERANCE = 1e-12;
const close = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE);
};

const sword = d20.plus(7).ac(16).melee().onHit(roll(1, d8).plus(4));
const fear = d20.plus(2).dc(15).ability("wis").onSaveFailure(0);
const topple = sword.onEveryHit(prone().untilEndOfTurn(), { save: saveDC(15, { con: 3 }) });

const codeOf = (build: () => unknown): string | undefined => {
  try {
    build();
    return undefined;
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : error instanceof RangeError ? "RangeError" : String(error);
  }
};

/** The oracle turns of C1, C2 and C6 (tests/oracle/bruteForce.ts shares no code with the library). */
const swordSpec: AttackSpec = {
  toHit: 7,
  ac: 16,
  critRange: 20,
  advantage: "flat",
  range: "melee",
  damage: { count: 1, sides: 8, flat: 4 },
};
const toppleGrant = {
  of: [0],
  trigger: "hit",
  cap: "unlimited",
  save: { ability: "constitution", dc: 15, saveBonus: 3 },
  effects: [{ kind: "condition", condition: "prone" }],
} as const;
const gated = (extra: Partial<RiderSpec>): RiderSpec => ({
  of: [1],
  trigger: "hit",
  max: Infinity,
  damage: { count: 1, sides: 6 },
  ...extra,
});
const oracleC1: SyntheticTurn = {
  attacks: [swordSpec, swordSpec],
  saves: [{ dc: 15, saveBonus: 2, onSuccess: "none", damage: { count: 0, sides: 1 }, ability: "wisdom" }],
  order: [2, 0, 1],
  grants: [{ of: [2], trigger: "failedSave", cap: "unlimited", effects: [{ kind: "condition", condition: "frightened" }] }],
  riders: [gated({ of: [0, 1], damage: { count: 0, sides: 1, flat: 4 }, targetHas: ["frightened"] })],
};
const oracleC2: SyntheticTurn = {
  attacks: [swordSpec, swordSpec],
  grants: [toppleGrant],
  riders: [gated({ targetHas: ["prone"] })],
};
const oracleC6: SyntheticTurn = {
  attacks: [swordSpec, swordSpec, swordSpec],
  grants: [
    toppleGrant,
    { of: [1], trigger: "hit", cap: "unlimited", targetHas: ["prone"], effects: [{ kind: "critOnHit", lifetime: "turn" }] },
  ],
};

describe("the oracle's targetHas", () => {
  it("gives C1 = 13.53, C2 = 12.47655 and C6 = 18.3886695", () => {
    close(enumerateSyntheticTurn(oracleC1).mean, 13.53);
    close(enumerateSyntheticTurn(oracleC2).mean, 12.47655);
    close(enumerateSyntheticTurn(oracleC6).mean, 18.3886695);
  });
});

/** C1: Frightened by a failed save, then two swords, a rider on each hit of a frightened target. */
const fearSpec = (rider: Partial<Rider> = {}): TurnSpec => ({
  attacks: [
    { id: "fear", source: fear },
    { id: "a", source: sword },
    { id: "b", source: sword },
  ],
  riders: [{ id: "rider", on: "every-hit", of: ["a", "b"], damage: flat(4), targetHas: ["frightened"], ...rider } as Rider],
  conditions: [
    {
      on: "every-hit",
      of: ["fear"],
      landing: "fail",
      grants: [{ condition: "frightened", rule: RULES.frightened, until: "end-of-turn" }],
    },
  ],
});
const fearFluent = (targetHas: string | readonly string[] = "frightened"): Turn =>
  turn([{ id: "fear", source: fear }, { id: "a", source: sword }, { id: "b", source: sword }])
    .onEveryHit(frightened().untilEndOfTurn(), { of: "fear", landing: "fail" })
    .onEveryHit(flat(4), { id: "rider", of: ["a", "b"], targetHas });

/** C2: Topple (attack 1) may knock the target Prone, then a sword whose rider reads it. */
const toppleSpec = (of: readonly string[], targetHas: readonly string[]): TurnSpec => ({
  attacks: [
    { id: "attack 1", source: sword },
    { id: "attack 2", source: sword },
  ],
  riders: [{ id: "rider", on: "every-hit", of, damage: d("1d6"), targetHas }],
  conditions: [
    {
      on: "every-hit",
      of: ["attack 1"],
      save: { dc: 15, bonus: 3, ability: "constitution" },
      grants: [{ condition: "prone", rule: RULES.prone, until: "end-of-turn" }],
    },
  ],
});
const toppleFluent = (of: string | readonly string[], targetHas: string | readonly string[]): Turn =>
  turn([sword, sword])
    .onEveryHit(prone().untilEndOfTurn(), { of: "attack 1", save: saveDC(15, { con: 3 }) })
    .onEveryHit(roll(1, d6), { id: "rider", of, targetHas });

describe("targetHas on riders", () => {
  it("C1: a rider reads a condition a failed save left on the target", () => {
    const spec = Turn.from(fearSpec());
    close(spec.mean(), 13.53);
    close(spec.mean(), enumerateSyntheticTurn(oracleC1).mean);
    close(spec.fireProbability("rider"), 0.504);
    expect(fearFluent().mean()).toBe(spec.mean());
    expect(fearFluent(["frightened"]).fireProbability("rider")).toBe(spec.fireProbability("rider"));
  });

  it("C2: Prone on attack 1 gates the rider on attack 2", () => {
    const spec = Turn.from(toppleSpec(["attack 2"], ["prone"]));
    close(spec.mean(), 12.47655);
    close(spec.mean(), enumerateSyntheticTurn(oracleC2).mean);
    close(spec.fireProbability("rider"), 0.2772);
    expect(toppleFluent(["attack 2"], "prone").mean()).toBe(spec.mean());
    expect(toppleFluent("attack 2", ["prone"]).mean()).toBe(spec.mean());
  });

  it("C2b: a hit's own Prone does not gate that hit's rider (DW5)", () => {
    const both = Turn.from(toppleSpec(["attack 1", "attack 2"], ["prone"]));
    close(both.mean(), 12.47655);
    expect(both.mean()).toBe(Turn.from(toppleSpec(["attack 2"], ["prone"])).mean());
    expect(toppleFluent(["attack 1", "attack 2"], "prone").mean()).toBe(both.mean());
  });

  it("C3: targetHas is any-of", () => {
    const anyOf = Turn.from(toppleSpec(["attack 2"], ["frightened", "prone"]));
    close(anyOf.mean(), 12.47655);
    expect(toppleFluent(["attack 2"], ["frightened", "prone"]).mean()).toBe(anyOf.mean());
  });

  it("C4: a condition the target starts with leaves the gate always open: the ungated rider", () => {
    const start = Turn.from({
      attacks: [
        { id: "a", source: sword },
        { id: "b", source: sword },
      ],
      riders: [{ id: "rider", on: "every-hit", of: ["a", "b"], damage: flat(4), targetHas: ["frightened"] }],
      conditions: [{ on: "start", grants: [{ condition: "frightened", rule: RULES.frightened, until: "end-of-turn" }] }],
    });
    close(start.mean(), 15.45);
    close(
      start.mean(),
      turn([sword, sword])
        .onEveryHit(flat(4))
        .mean()
    );
    const fluent = turn([{ id: "a", source: sword }, { id: "b", source: sword }])
      .atStart(frightened())
      .onEveryHit(flat(4), { of: ["a", "b"], targetHas: "frightened" });
    expect(fluent.mean()).toBe(start.mean());
  });

  it("C5: a name nothing in the turn applies never opens the gate", () => {
    const never = Turn.from(fearSpec({ targetHas: ["charmed"] }));
    close(never.mean(), 10.65);
    close(never.fireProbability("rider"), 0);
  });

  it("a first-hit rider lands on the first landing the gate opens", () => {
    // Prone from attack 1 on: attack 2 is the first row the gate can open on, and only it can land.
    const first = Turn.from({
      ...toppleSpec(["attack 2"], ["prone"]),
      riders: [{ id: "rider", on: "first-hit", of: ["attack 2"], damage: d("1d6"), targetHas: ["prone"] }],
    });
    close(first.mean(), 12.47655);
    // Over both attacks the closed gate on attack 1 spends nothing, so it is the same turn.
    const both = Turn.from({
      ...toppleSpec(["attack 1", "attack 2"], ["prone"]),
      riders: [{ id: "rider", on: "first-hit", of: ["attack 1", "attack 2"], damage: d("1d6"), targetHas: ["prone"] }],
    });
    close(both.mean(), 12.47655);
    expect(turn([sword, sword])
      .onEveryHit(prone().untilEndOfTurn(), { of: "attack 1", save: saveDC(15, { con: 3 }) })
      .onFirstHit(roll(1, d6), { of: ["attack 1", "attack 2"], targetHas: "prone" })
      .mean()).toBe(both.mean());
  });

  it("a gated rider with max 1 counts only the landings its gate opened", () => {
    const capped = Turn.from({
      attacks: [
        { id: "a", source: sword },
        { id: "b", source: sword },
        { id: "c", source: sword },
      ],
      riders: [{ id: "rider", on: "every-hit", max: 1, of: ["a", "b", "c"], damage: flat(4), targetHas: ["frightened"] }],
      conditions: [
        {
          on: "every-hit",
          of: ["a"],
          chance: 0.5,
          grants: [{ condition: "frightened", rule: RULES.frightened, until: "end-of-turn" }],
        },
      ],
    });
    const oracle: SyntheticTurn = {
      attacks: [swordSpec, swordSpec, swordSpec],
      grants: [{ of: [0], trigger: "hit", chance: 0.5, cap: "unlimited", effects: [{ kind: "condition", condition: "frightened" }] }],
      riders: [{ of: [0, 1, 2], trigger: "hit", max: 1, damage: { count: 0, sides: 1, flat: 4 }, targetHas: ["frightened"] }],
    };
    close(capped.mean(), enumerateSyntheticTurn(oracle).mean);
  });
});

describe("targetHas on grants", () => {
  it("C6: a grant applies only where the target has the condition", () => {
    const fluent = turn([topple, sword, sword]).onEveryHit(critOnHit().untilEndOfTurn(), {
      of: ["attack 2"],
      targetHas: "prone",
    });
    close(fluent.mean(), 18.3886695);
    close(fluent.mean(), enumerateSyntheticTurn(oracleC6).mean);
    const spec: TurnSpec = {
      attacks: [
        { id: "attack 1", source: sword },
        { id: "attack 2", source: sword },
        { id: "attack 3", source: sword },
      ],
      conditions: [
        {
          on: "every-hit",
          of: ["attack 1"],
          save: { dc: 15, bonus: 3, ability: "constitution" },
          grants: [{ condition: "prone", rule: RULES.prone, until: "end-of-turn" }],
        },
        {
          on: "every-hit",
          of: ["attack 2"],
          targetHas: ["prone"],
          grants: [{ critOnHit: true, until: "end-of-turn" }],
        },
      ],
    };
    expect(Turn.from(spec).mean()).toBe(fluent.mean());
  });
});

describe("Turn.sample", () => {
  it("agrees with the walk on C1 and C6 within 0.2", () => {
    const samples = 20_000;
    const meanOf = (t: Turn, seed: number): number => {
      const rng = lcgRng(seed);
      let sum = 0;
      for (let i = 0; i < samples; i++) sum += t.sample(rng).total;
      return sum / samples;
    };
    expect(Math.abs(meanOf(fearFluent(), 0x5eed) - 13.53)).toBeLessThan(0.2);
    const c6 = turn([topple, sword, sword]).onEveryHit(critOnHit().untilEndOfTurn(), { of: ["attack 2"], targetHas: "prone" });
    expect(Math.abs(meanOf(c6, 0xc6) - 18.3886695)).toBeLessThan(0.3);
  });
});

describe("d20Penalty (2024 Exhaustion)", () => {
  const conSave = d20.plus(3).dc(15).ability("con").onSaveFailure(roll(8, d6)).saveHalf();

  it("C0: no start effect", () => {
    close(turn([conSave]).mean(), 21.5875);
  });
  it("C7: level 2 takes 4 off the save", () => {
    const exhausted = turn([conSave]).atStart(exhaustion(2, "2024"));
    close(exhausted.mean(), 24.4375);
  });
  it("C8: 2014 level 3 is disadvantage on the save", () => {
    const exhausted = turn([conSave]).atStart(exhaustion(3, "2014"));
    close(exhausted.mean(), 25.114375);
  });
  it("refuses a negative or fractional penalty", () => {
    for (const d20Penalty of [-1, 1.5]) {
      const spec: TurnSpec = {
        attacks: [conSave],
        conditions: [{ on: "start", grants: [{ condition: "exhaustion", rule: { d20Penalty }, until: "end-of-turn" }] }],
      };
      expect(codeOf(() => Turn.from(spec))).toBe("RangeError");
    }
  });
});

describe("serialization", () => {
  it("the same mean bit for bit after the conditions and the gate went through JSON", () => {
    const spec = fearSpec();
    const roundTripped: TurnSpec = {
      ...spec,
      conditions: JSON.parse(JSON.stringify(spec.conditions)) as readonly ConditionSpec[],
      riders: spec.riders?.map((rider) => ({ ...rider, targetHas: JSON.parse(JSON.stringify(rider.targetHas)) as readonly string[] })),
    };
    expect(Turn.from(roundTripped).mean()).toBe(Turn.from(spec).mean());
  });

  it("a gated grant is plain data", () => {
    const spec: TurnSpec = {
      attacks: [
        { id: "attack 1", source: sword },
        { id: "attack 2", source: sword },
        { id: "attack 3", source: sword },
      ],
      conditions: [
        {
          on: "every-hit",
          of: ["attack 1"],
          save: { dc: 15, bonus: 3, ability: "constitution" },
          grants: [{ condition: "prone", rule: RULES.prone, until: "end-of-turn" }],
        },
        { on: "every-hit", of: ["attack 2"], targetHas: ["prone"], grants: [{ critOnHit: true, until: "end-of-turn" }] },
      ],
    };
    const viaJson: TurnSpec = { ...spec, conditions: JSON.parse(JSON.stringify(spec.conditions)) as readonly ConditionSpec[] };
    expect(Turn.from(viaJson).mean()).toBe(Turn.from(spec).mean());
    close(Turn.from(spec).mean(), 18.3886695);
  });
});

describe("refusals", () => {
  it("an empty targetHas is non-string-id", () => {
    expect(codeOf(() => Turn.from(fearSpec({ targetHas: [] })))).toBe("non-string-id");
    expect(codeOf(() => fearFluent([]))).toBe("non-string-id");
    expect(codeOf(() => Turn.from(fearSpec({ targetHas: [7 as never] })))).toBe("non-string-id");
  });
  it("targetHas on an any-crit rider is unsupported-trigger", () => {
    expect(codeOf(() => Turn.from(fearSpec({ on: "any-crit", targetHas: ["frightened"] } as never)))).toBe(
      "unsupported-trigger"
    );
  });
  it("targetHas on a rider whose damage rolls an attack is unsupported-trigger", () => {
    const rolls = d20.plus(5).ac(15).onHit(d6);
    expect(codeOf(() => Turn.from(fearSpec({ damage: rolls })))).toBe("unsupported-trigger");
  });
  it("targetHas on a first-hit grant is unsupported-trigger", () => {
    const spec: TurnSpec = {
      attacks: [
        { id: "a", source: sword },
        { id: "b", source: sword },
      ],
      conditions: [{ on: "first-hit", of: ["a"], targetHas: ["prone"], grants: [{ critOnHit: true, until: "end-of-turn" }] }],
    };
    expect(codeOf(() => Turn.from(spec))).toBe("unsupported-trigger");
  });
});
