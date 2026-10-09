import { describe, expect, expectTypeOf, it } from "vitest";
import { d8, d20, roll, turn, Turn, TurnSpecError } from "../builder";
import type {
  AttackOptions,
  ConditionRule,
  ConditionSpec,
  ContextualPayload,
  ContextualSource,
  EffectSpec,
  GrantSaveSpec,
  LandingPayload,
  Modifier,
  Rider,
  RowCheck,
  RowContext,
  Source,
  TurnSpec,
  TurnSpecErrorCode,
} from "../builder";
import { CONTRACT_REVISION } from "../builder";
import { RULES } from "../dnd5e";
import type { PMF } from "../pmf/pmf";

const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));
const smite = roll(2, d8);

const check: RowCheck = {
  kind: "attack",
  range: "melee",
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
};
const contextual: ContextualSource = { rowCheck: check, under: () => sword.toPMF() };

function refusal(spec: TurnSpec): TurnSpecError {
  let accepted: Turn;
  try {
    accepted = Turn.from(spec);
  } catch (error) {
    if (error instanceof TurnSpecError) return error;
    throw error;
  }
  throw new Error(`Turn.from accepted the spec (mean ${accepted.mean()})`);
}

const smitePMF = smite.toPMF();
const payload: ContextualPayload = {
  at: () => ({ onHit: smitePMF, onCrit: smitePMF, vulnerable: { onHit: smitePMF, onCrit: smitePMF } }),
};

const grantAdvantage: EffectSpec = { advantage: true, until: "next-attack" };
const onHit = (extra: Partial<ConditionSpec>): ConditionSpec => ({
  on: "every-hit",
  grants: [grantAdvantage],
  ...extra,
});

describe("TurnSpec v2 validation", () => {
  it("a rider's where must name a partner in its of", () => {
    expect(refusal({ attacks: [sword], riders: [{ id: "smite", on: "first-hit", damage: smite, where: { "attack 1": [] } }] }).id).toBe(
      "attack 1"
    );
  });

  it("a condition's where must name the rider in its of", () => {
    expect(refusal({ attacks: [sword], conditions: [onHit({ where: { "attack 1": [] } })] }).code).toBe("unknown-id");
  });

  it("dealing needs a source that can say the odds it deals the type (ContextualSource.dealt)", () => {
    const error = refusal({ attacks: [sword], conditions: [onHit({ dealing: "fire" })] });
    expect(error.code).toBe("not-an-attack");
    expect(error.id).toBe("attack 1");
  });

  it("leaves a spec that sets no new field unchanged, unset optional keys included", () => {
    const plain = Turn.from({ attacks: [sword, sword], riders: [{ on: "first-hit", damage: smite }] });
    const withUndefined = Turn.from({
      attacks: [{ source: sword, target: undefined }, sword],
      riders: [{ on: "first-hit", damage: smite, happens: undefined, joins: undefined }],
      conditions: [{ on: "every-hit", grants: [grantAdvantage], landing: undefined, save: undefined }],
      stateLimit: undefined,
    });
    const withCondition = Turn.from({
      attacks: [sword, sword],
      riders: [{ on: "first-hit", damage: smite }],
      conditions: [{ on: "every-hit", grants: [grantAdvantage] }],
    });
    expect(withUndefined.mean()).toBe(withCondition.mean());
    expect(withCondition.mean()).toBeGreaterThan(plain.mean());
  });

  it("still rejects an unknown attack key", () => {
    const spec = { attacks: [{ source: sword, aim: "ogre" }] } as unknown as TurnSpec;
    expect(refusal(spec).code).toBe("unknown-key");
  });

  it("accepts a rider payload per attack (ContextualPayload)", () => {
    expect(Turn.from({ attacks: [sword], riders: [{ on: "first-hit", damage: payload }] }).mean()).toBeGreaterThanOrEqual(
      Turn.from({ attacks: [sword] }).mean()
    );
  });

  it("accepts a ContextualSource: a ContextualSource rolls its own context", () => {
    expect(Turn.from({ attacks: [contextual], stateLimit: 64 }).mean()).toBeCloseTo(sword.mean(), 12);
    expect(turn(sword).attack(contextual).mean()).toBeCloseTo(2 * sword.mean(), 12);
  });
});

describe("TurnSpec v2 types", () => {
  it("exports the revision", () => {
    expect(CONTRACT_REVISION).toBe(4);
  });

  it("exports every new type from the builder entry", () => {
    expectTypeOf<RowContext["joined"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<RowCheck["advantageDice"]>().toEqualTypeOf<2 | 3>();
    expectTypeOf<ContextualSource["under"]>().toEqualTypeOf<(context: RowContext) => PMF>();
    expectTypeOf<ContextualSource>().toExtend<Source>();
    expectTypeOf<Modifier>().toEqualTypeOf<
      "advantage" | "disadvantage" | "critOnHit" | "autoFail" | "saveDisadvantage" | "vulnerable"
    >();
    expectTypeOf<ConditionRule["onEnd"]>().toEqualTypeOf<{ condition: string; rule: ConditionRule } | undefined>();
    expectTypeOf<GrantSaveSpec>().toExtend<{ ability?: string }>();
    expectTypeOf<ConditionSpec["on"]>().toExtend<string>();
    expectTypeOf<"first-crit" | "start">().toExtend<ConditionSpec["on"]>();
    expectTypeOf<ConditionSpec["grants"]>().toEqualTypeOf<readonly EffectSpec[]>();
    expectTypeOf<AttackOptions["target"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Rider["happens"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Rider["joins"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<AttackOptions["after"]>().toEqualTypeOf<{ of: string; landing: "hit" | "damage" | "any" } | undefined>();
    expectTypeOf<ContextualSource["rowCheck"]>().toEqualTypeOf<RowCheck>();
    expectTypeOf<ContextualPayload["at"]>().returns.toEqualTypeOf<LandingPayload>();
    expectTypeOf<Rider["where"]>().toEqualTypeOf<Readonly<Record<string, readonly string[]>> | undefined>();
    expectTypeOf<ConditionSpec["where"]>().toEqualTypeOf<Readonly<Record<string, readonly string[]>> | undefined>();
    expectTypeOf<TurnSpec["stateLimit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<"dealing-joint-unsupported" | "too-many-states">().toExtend<TurnSpecErrorCode>();
  });

  it("requires a lifetime on every effect", () => {
    // @ts-expect-error: a condition effect without `until`
    void ({ condition: "prone", rule: RULES.prone } satisfies EffectSpec);
    // @ts-expect-error: a vulnerability without `until`
    void ({ vulnerability: true } satisfies EffectSpec);
    // @ts-expect-error: `until-damaged` is for conditions only
    void ({ savePenalty: { count: 1, sides: 4 }, until: "until-damaged" } satisfies EffectSpec);
  });

});
