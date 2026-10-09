import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { d20, d4, d6, d8, roll } from "../builder";
import {
  blinded,
  paralyzed,
  prone,
  restrained,
  RULES,
  stunned,
  unconscious,
} from "../dnd5e";
import type { Lasting } from "./effects";
import {
  advantage,
  condition,
  critOnHit,
  effectSpec,
  saveDisadvantage,
  savePenalty,
  vulnerability,
} from "./effects";
import type * as Plan from "./plan";
import { turn } from "./turn";
import type { ConditionRule, TurnSpec } from "./types";
import { TurnSpecError } from "./types";

// These tests read what the fluent verbs write: the spec each `Turn` hands to `buildPlan`, which
// is then built without its conditions and `stateLimit`, so a turn whose sources cannot evaluate a
// field (a builder has no `dealt`) still constructs; `codeOf` evaluates for real.
const seen = vi.hoisted(() => ({
  spec: undefined as unknown,
  evaluate: false,
}));
vi.mock("./plan", async (importOriginal) => {
  const actual = await importOriginal<typeof Plan>();
  return {
    ...actual,
    buildPlan: (spec: TurnSpec, eps?: number) => {
      seen.spec = spec;
      if (seen.evaluate) return actual.buildPlan(spec, eps);
      const riders = (spec.riders ?? []).map(
        ({ happens: _, ...rider }) => rider,
      );
      return actual.buildPlan(
        { ...spec, riders, conditions: [], stateLimit: undefined },
        eps,
      );
    },
  };
});

/** The plain `TurnSpec` the last built turn carries. */
function specOf(build: () => unknown): TurnSpec {
  build();
  const { attacks, riders, substitutes, conditions, observe, stateLimit } =
    seen.spec as TurnSpec;
  return {
    attacks,
    riders,
    substitutes,
    conditions,
    observe,
    ...(stateLimit === undefined ? {} : { stateLimit }),
  };
}

function codeOf(build: () => unknown): string | undefined {
  seen.evaluate = true;
  try {
    build();
    return undefined;
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : String(error);
  } finally {
    seen.evaluate = false;
  }
}

const sword = d20.plus(5).ac(15).onHit(d8);
const both = ["attack 1", "attack 2"];
const frightened: ConditionRule = { attack: { melee: ["disadvantage"] } };
const proneSpec = {
  condition: "prone",
  rule: RULES.prone,
  until: "end-of-turn",
} as const;

describe("effects", () => {
  it("each factory writes its EffectSpec", () => {
    expect(effectSpec(prone().untilEndOfTurn())).toEqual(proneSpec);
    expect(effectSpec(unconscious().untilDamaged())).toEqual({
      condition: "unconscious",
      rule: RULES.unconscious,
      until: "until-damaged",
    });
    expect(
      effectSpec(condition("frightened", frightened).untilEndOfTurn()),
    ).toEqual({
      condition: "frightened",
      rule: frightened,
      until: "end-of-turn",
    });
    expect(effectSpec(vulnerability().untilNextHit())).toEqual({
      vulnerability: true,
      until: "next-hit",
    });
    expect(effectSpec(saveDisadvantage().untilNextSave().to("spells"))).toEqual(
      {
        saveDisadvantage: true,
        until: "next-save",
        to: ["spells"],
      },
    );
    expect(effectSpec(saveDisadvantage().untilEndOfTurn())).toEqual({
      saveDisadvantage: true,
      until: "end-of-turn",
    });
    expect(effectSpec(savePenalty(d4).untilNextSave())).toEqual({
      savePenalty: { count: 1, sides: 4 },
      until: "next-save",
    });
    expect(
      effectSpec(savePenalty(roll(2, d4)).untilEndOfTurn().to("attack 2")),
    ).toEqual({
      savePenalty: { count: 2, sides: 4 },
      until: "end-of-turn",
      to: ["attack 2"],
    });
  });

  it("the dnd5e factories are condition(name, RULES[name])", () => {
    const factories = {
      blinded,
      paralyzed,
      prone,
      restrained,
      stunned,
      unconscious,
    };
    for (const [name, factory] of Object.entries(factories)) {
      expect(effectSpec(factory().untilEndOfTurn())).toEqual(
        effectSpec(
          condition(name, RULES[name as keyof typeof RULES]).untilEndOfTurn(),
        ),
      );
    }
  });

  it("savePenalty takes one plain die group", () => {
    expect(() => savePenalty(d4.plus(1))).toThrow(/one plain die group/);
    expect(() => savePenalty(d4.add(d6))).toThrow(/one plain die group/);
  });

  it("types: a lifetime is required, untilDamaged is a condition's, vulnerability ends on the next hit", () => {
    // Compiled, never run: the checks are the `@ts-expect-error`s.
    void (() => {
      // @ts-expect-error — a condition without a lifetime is not an effect a trigger takes.
      turn([sword]).onFirstHit(prone()).mean();
      // @ts-expect-error — nor is a save modifier without one.
      turn([sword]).onEveryHit(saveDisadvantage()).mean();
      // @ts-expect-error — only conditions offer untilDamaged().
      advantage().untilDamaged();
      // @ts-expect-error — only conditions offer untilDamaged().
      saveDisadvantage().untilDamaged();
      // @ts-expect-error — vulnerability's only lifetime is the next hit.
      vulnerability().untilEndOfTurn();
      // @ts-expect-error — a condition goes on the creature; it is not scoped to rows.
      prone().untilEndOfTurn().to("attack 2");
      // @ts-expect-error — atStart takes no damage.
      turn([sword]).atStart(d6).mean();
    });
    expectTypeOf(prone().untilDamaged()).toEqualTypeOf<Lasting>();
  });
});

describe("triggers on the turn", () => {
  it("onFirstCrit writes a first-crit condition", () => {
    expect(
      specOf(() =>
        turn([sword, sword]).onFirstCrit(prone().untilEndOfTurn(), {
          id: "topple",
        }),
      ),
    ).toEqual({
      attacks: [sword, sword],
      riders: [],
      substitutes: [],
      conditions: [
        { id: "topple", on: "first-crit", of: both, grants: [proneSpec] },
      ],
      observe: [],
    });
  });

  it("onFirstCrit refuses damage: damage on a crit is onAnyCrit", () => {
    // @ts-expect-error — onFirstCrit applies effects only.
    expect(codeOf(() => turn([sword]).onFirstCrit(d6))).toBe(
      "unsupported-trigger",
    );
  });

  it("passes landing, dealing, optional, chance and onSave through", () => {
    const { conditions } = specOf(() =>
      turn([sword, sword])
        .onFirstHit(prone().untilEndOfTurn(), {
          landing: "damage",
          optional: true,
        })
        .onEveryHit(savePenalty(d4).untilNextSave(), {
          dealing: "cold",
          of: ["attack 1"],
        })
        .onAnyCrit(stunned().untilEndOfTurn(), {
          chance: 0.4,
          onSave: vulnerability().untilNextHit(),
        }),
    );
    expect(conditions).toEqual([
      {
        on: "first-hit",
        of: both,
        landing: "damage",
        grants: [proneSpec],
        optional: true,
      },
      {
        on: "every-hit",
        of: ["attack 1"],
        dealing: "cold",
        grants: [{ savePenalty: { count: 1, sides: 4 }, until: "next-save" }],
      },
      {
        on: "any-crit",
        of: both,
        chance: 0.4,
        grants: [
          { condition: "stunned", rule: RULES.stunned, until: "end-of-turn" },
        ],
        onSave: [{ vulnerability: true, until: "next-hit" }],
      },
    ]);
  });

  it("refuses a target on a trigger: its effects go on the creature of the row that lands them", () => {
    expect(
      codeOf(() => turn([sword]).onFirstHit(prone().untilEndOfTurn(), { target: "ogre" } as never)),
    ).toBe("unsupported-trigger");
  });

  it("damage and effects in one call: happens goes on the rider, the rest on the condition", () => {
    const sneak = roll(3, d6);
    const spec = specOf(() =>
      turn([sword, sword]).onFirstHit([sneak, prone().untilEndOfTurn()], {
        id: "sneak",
        happens: 0.5,
        dealing: "piercing",
      }),
    );
    expect(spec.riders).toEqual([
      { id: "sneak", happens: 0.5, of: both, damage: [sneak], on: "first-hit" },
    ]);
    expect(spec.conditions).toEqual([
      { on: "first-hit", of: both, dealing: "piercing", grants: [proneSpec] },
    ]);
  });

  it("happens on a damage-only call", () => {
    const sneak = roll(3, d6);
    expect(specOf(() => turn([sword]).onFirstHit(sneak, { happens: 0.5 })).riders).toEqual([
      { happens: 0.5, damage: sneak, on: "first-hit", of: ["attack 1"] },
    ]);
  });

  it("a condition may watch where a rider landed", () => {
    const save = { ability: "con", dc: 15, bonus: 2 };
    const { conditions } = specOf(() =>
      turn([sword, sword])
        .onFirstHit(roll(3, d6), { id: "sneak" })
        .onFirstHit(prone().untilEndOfTurn(), { of: ["sneak"], save }),
    );
    expect(conditions).toEqual([
      { on: "first-hit", of: ["sneak"], save, grants: [proneSpec] },
    ]);
  });

  it("atStart: an effect without a lifetime lasts the turn", () => {
    const { conditions } = specOf(() =>
      turn([sword])
        .atStart(restrained())
        .atStart(vulnerability().untilNextHit(), { target: "ogre" })
        .atStart([advantage().critOnHit(), saveDisadvantage()]),
    );
    expect(conditions).toEqual([
      {
        on: "start",
        grants: [
          {
            condition: "restrained",
            rule: RULES.restrained,
            until: "end-of-turn",
          },
        ],
      },
      {
        on: "start",
        target: "ogre",
        grants: [{ vulnerability: true, until: "next-hit" }],
      },
      {
        on: "start",
        grants: [
          { advantage: true, critOnHit: true, until: "end-of-turn" },
          { saveDisadvantage: true, until: "end-of-turn" },
        ],
      },
    ]);
  });

  it("stateLimit sets the turn's", () => {
    // A turn with no state builds its plan on first use: reading `pmf` builds it.
    expect(specOf(() => turn([sword]).stateLimit(4096).pmf).stateLimit).toBe(4096);
  });

  it("evaluates every new field, and names what a source cannot say", () => {
    expect(codeOf(() => turn([sword]).stateLimit(4096))).toBeUndefined();
    // Prone differs by range, and this sword declares none.
    expect(codeOf(() => turn([sword]).atStart(prone()))).toBe("unknown-range");
    expect(
      codeOf(() =>
        turn([sword]).onFirstHit(critOnHit().untilEndOfTurn(), {
          dealing: "cold",
        }),
      ),
    ).toBe("not-an-attack"); // a builder cannot say the odds it deals cold (ContextualSource.dealt)
    expect(codeOf(() => turn([sword]).onFirstHit(d6, { happens: 0.5 }))).toBeUndefined();
  });
});

describe("saves on a trigger", () => {
  const grant = advantage().untilEndOfTurn();
  const grants = [{ advantage: true, until: "end-of-turn" }];

  it("a DC check without an ability is a plain save, rolled in the target's state", () => {
    const { conditions } = specOf(() =>
      turn([sword]).onFirstHit(grant, { save: d20.plus(2).dc(15) }),
    );
    expect(conditions).toEqual([
      { on: "first-hit", of: ["attack 1"], save: { dc: 15, bonus: 2 }, grants },
    ]);
  });

  it("a DC check that names an ability is a state-aware GrantSaveSpec", () => {
    const con = d20.plus(2).dc(15).ability("con");
    const dex = d20.plus(1).withAdvantage().dc(14).ability("dex");
    expect(
      specOf(() => turn([sword]).onFirstHit(grant, { save: con })).conditions,
    ).toEqual([
      {
        on: "first-hit",
        of: ["attack 1"],
        save: { ability: "constitution", dc: 15, bonus: 2 },
        grants,
      },
    ]);
    expect(
      specOf(() => turn([sword]).onFirstHit(grant, { save: [con, dex] }))
        .conditions,
    ).toEqual([
      {
        on: "first-hit",
        of: ["attack 1"],
        save: [
          { ability: "constitution", dc: 15, bonus: 2 },
          { ability: "dexterity", dc: 14, bonus: 1, rollType: "advantage" },
        ],
        grants,
      },
    ]);
  });

  it("a plain GrantSaveSpec, or a list mixing one with a DC check, passes through", () => {
    const failChance = () => 0.3;
    const { conditions } = specOf(() =>
      turn([sword]).onFirstHit(grant, {
        save: [{ ability: "str", failChance }, d20.plus(3).dc(12)],
      }),
    );
    expect(conditions).toEqual([
      {
        on: "first-hit",
        of: ["attack 1"],
        save: [
          { ability: "str", failChance },
          { dc: 12, bonus: 3 },
        ],
        grants,
      },
    ]);
  });
});

describe("triggers attached to builders", () => {
  it("an attack carries onFirstCrit with its options", () => {
    const shove = sword.onFirstCrit(prone().untilEndOfTurn(), {
      dealing: "bludgeoning",
    });
    expect(shove.attached).toEqual([
      {
        on: "first-crit",
        grants: prone().untilEndOfTurn(),
        gate: { dealing: "bludgeoning", onSave: undefined },
      },
    ]);
    expect(codeOf(() => turn([shove]))).toBe("not-an-attack");
  });

  it("onSaveFailure takes effects beside its damage: every-hit on this save, landing fail", () => {
    const fireball = d20
      .plus(2)
      .dc(15)
      .onSaveFailure([roll(8, d6), prone().untilEndOfTurn()]);
    expect(fireball.toExpression()).toBe(
      d20.plus(2).dc(15).onSaveFailure(roll(8, d6)).toExpression(),
    );
    expect(fireball.attached).toEqual([
      {
        on: "every-hit",
        grants: [prone().untilEndOfTurn()],
        gate: { landing: "fail" },
      },
    ]);
    expect(fireball.saveHalf().attached).toEqual(fireball.attached);
    expect(codeOf(() => turn([fireball]))).toBeUndefined();
  });

  it("0.16 attachments still build", () => {
    expect(
      codeOf(() =>
        turn([
          sword.onEveryHit(advantage().untilNextAttack(), { chance: 0.5 }),
          sword,
        ]),
      ),
    ).toBeUndefined();
  });
});
