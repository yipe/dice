import { describe, expect, it } from "vitest";
import { advantage, condition, d20, d4, d6, d8, keepBestDamage, roll, Turn, turn, TurnSpecError, vulnerability } from "../src/builder";
import { paralyzed, prone, restrained, RULES } from "../src/dnd5e";
import { grantSaveSpec, type TriggerSave } from "../src/turn/effects";

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));

describe("SaveBuilder verbs keep attached conditions", () => {
  const base = d20.plus(2).dc(15).onSaveFailure([roll(8, d6), prone().untilEndOfTurn()]);
  const verbs = {
    ability: (s: typeof base) => s.ability("dex"),
    alwaysFails: (s: typeof base) => s.alwaysFails(),
    pinned: (s: typeof base) => s.pinned(),
    saveHalf: (s: typeof base) => s.saveHalf(),
    onSaveSuccess: (s: typeof base) => s.onSaveSuccess(3),
  };
  it.each(Object.entries(verbs))("%s", (_, verb) => {
    expect(verb(base).attached).toEqual(base.attached);
    expect(base.attached).toHaveLength(1);
  });
});

describe("a DC check's ability gates a condition by the target's state", () => {
  const gated = (gate: { save: TriggerSave } | { chance: number }) =>
    turn([sword, sword]).atStart(restrained()).onFirstHit(vulnerability().untilNextHit(), gate);

  it("matches the plain-data spelling and differs from the fixed-chance gate", () => {
    const fluent = gated({ save: d20.plus(1).dc(15).ability("dex") }).mean();
    const plain = gated({ save: { ability: "dexterity", dc: 15, bonus: 1 } }).mean();
    const fixed = gated({ chance: d20.plus(1).dc(15).toPMF().pAt(1) }).mean();
    expect(fluent).toBe(plain);
    expect(fluent).not.toBeCloseTo(fixed, 6);
  });
});

describe("Turn.attack passes every AttackOptions field", () => {
  it("after, target and chance match Turn.from", () => {
    // Prone is on the default target only, so `target: "other"` changes the second attack's roll.
    const fluent = turn()
      .attack(sword, "first")
      .attack(sword, { id: "second", after: { of: "first", landing: "hit" }, target: "other", chance: 0.5 })
      .atStart(prone());
    const plain = Turn.from({
      attacks: [
        { id: "first", source: sword },
        { id: "second", source: sword, after: { of: "first", landing: "hit" }, target: "other", chance: 0.5 },
      ],
      conditions: [{ on: "start", grants: [{ condition: "prone", rule: RULES.prone, until: "end-of-turn" }] }],
    });
    expect(fluent.pmf.mean()).toBe(plain.pmf.mean());
    const ungated = turn()
      .attack(sword, "first")
      .attack(sword, { id: "second", target: "other", chance: 0.5 })
      .atStart(prone());
    expect(fluent.pmf.mean()).not.toBeCloseTo(ungated.pmf.mean(), 6);
    const untargeted = turn()
      .attack(sword, "first")
      .attack(sword, { id: "second", after: { of: "first", landing: "hit" }, chance: 0.5 })
      .atStart(prone());
    expect(fluent.pmf.mean()).not.toBeCloseTo(untargeted.pmf.mean(), 6);
    const uncoined = turn()
      .attack(sword, "first")
      .attack(sword, { id: "second", after: { of: "first", landing: "hit" }, target: "other" })
      .atStart(prone());
    expect(fluent.pmf.mean()).not.toBeCloseTo(uncoined.pmf.mean(), 6);
  });
});

describe("ranged() is an attack from beyond 5 feet for condition rules", () => {
  it("a ranged attack against a prone target has disadvantage", () => {
    const expected = d20.plus(8).withDisadvantage().ac(16).ranged().onHit(d8.plus(4)).mean();
    expect(turn([bow]).atStart(prone()).mean()).toBeCloseTo(expected, 12);
  });

  it("a ranged attack against a paralyzed target has advantage but no automatic crit", () => {
    const expected = d20.plus(8).withAdvantage().ac(16).ranged().onHit(d8.plus(4)).mean();
    expect(turn([bow]).atStart(paralyzed()).mean()).toBeCloseTo(expected, 12);
  });
});

const codeOf = (build: () => unknown): string | undefined => {
  try {
    build();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
};

describe("a DC check used as a trigger's save keeps its own fail odds", () => {
  const gated = (save: TriggerSave | readonly TriggerSave[]) =>
    turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { save }).mean();
  const checks = {
    bless: () => d20.plus(2).plus(d4).dc(15),
    bane: () => d20.plus(2).minus(d4).dc(15),
    halfling: () => d20.reroll(1).plus(2).dc(15),
    alwaysFails: () => d20.plus(2).dc(15).alwaysFails(),
    pinnedAdvantage: () => d20.plus(2).withAdvantage().pinned().dc(15),
  };
  it.each(Object.entries(checks))("%s: ability(...) and the list form match the bare check", (_, check) => {
    const bare = gated(check());
    expect(gated(check().ability("con"))).toBeCloseTo(bare, 12);
    expect(gated([check()])).toBeCloseTo(bare, 12);
    expect(gated([check().ability("con")])).toBeCloseTo(bare, 12);
  });

  it("the plain check keeps its plain-data form", () => {
    expect(grantSaveSpec(d20.plus(2).dc(15).ability("con"))).toEqual({ ability: "constitution", dc: 15, bonus: 2 });
  });

  it("is rolled in the target's state: Restrained gives a Bless-boosted DEX save disadvantage", () => {
    const restrainedTurn = (save: TriggerSave) =>
      turn([sword, sword]).atStart(restrained()).onFirstHit(vulnerability().untilNextHit(), { save }).mean();
    // Restrained leaves a CON save alone, so a CON check with its own roll is the comparator.
    const stateAware = restrainedTurn(d20.plus(1).plus(d4).dc(15).ability("dex"));
    const fixedDisadvantage = restrainedTurn(d20.plus(1).plus(d4).withDisadvantage().dc(15).ability("con"));
    expect(stateAware).toBeCloseTo(fixedDisadvantage, 12);
    // A pinned save keeps its own (flat) roll.
    const pinned = restrainedTurn(d20.plus(1).plus(d4).pinned().dc(15).ability("dex"));
    expect(pinned).toBeCloseTo(restrainedTurn(d20.plus(1).plus(d4).dc(15).ability("con")), 12);
  });
});

describe("target is taken by atStart and attacks only", () => {
  it("a trigger condition naming a target is a TurnSpecError", () => {
    const spec = {
      attacks: [sword],
      conditions: [{ on: "first-hit" as const, target: "target", grants: [{ advantage: true as const, until: "end-of-turn" as const }] }],
    };
    expect(codeOf(() => Turn.from(spec))).toBe("unsupported-trigger");
    // @ts-expect-error -- trigger verbs take no target
    expect(codeOf(() => turn([sword]).onFirstHit(prone().untilEndOfTurn(), { target: "target" }))).toBe("unsupported-trigger");
  });

  it("atStart's target must be a creature some row is aimed at", () => {
    expect(codeOf(() => turn([sword]).atStart(prone(), { target: "secnod" }).mean())).toBe("unknown-id");
    expect(codeOf(() => turn([sword]).atStart(prone(), { target: "target" }).mean())).toBeUndefined();
    expect(
      codeOf(() => turn().attack(sword).attack(sword, { target: "second" }).atStart(prone(), { target: "second" }).mean())
    ).toBeUndefined();
  });
});

describe("ability names are normalised", () => {
  const save = d20.plus(2).dc(15).ability("str").onSaveFailure(roll(8, d6));
  it("a rule keyed by a short name applies to a save made with the full name", () => {
    const short = turn([save]).atStart(condition("held", { save: { str: ["autoFail"] } })).mean();
    const full = turn([save]).atStart(condition("held", { save: { strength: ["autoFail"] } })).mean();
    expect(full).toBeCloseTo(28, 12);
    expect(short).toBeCloseTo(full, 12);
  });

  it("a GrantSaveSpec with a short ability reads the target's state as the full name does", () => {
    const gated = (ability: string) =>
      turn([sword, sword]).atStart(restrained()).onFirstHit(vulnerability().untilNextHit(), { save: { ability, dc: 15, bonus: 1 } }).mean();
    expect(gated("dex")).toBeCloseTo(gated("dexterity"), 12);
  });

  it("a rule keyed by no known ability is unknown-ability", () => {
    expect(codeOf(() => turn([save]).atStart(condition("mad", { save: { sanity: ["autoFail"] } })).mean())).toBe("unknown-ability");
  });
});

describe("ACBuilder.alwaysHits() keeps the row's facts", () => {
  it("keeps the range and the crit threshold", () => {
    expect(d20.plus(8).ac(16).melee().alwaysHits().onHit(d8).rowCheck.range).toBe("melee");
    expect(d20.plus(8).ac(16).critOn(19).alwaysHits().onHit(d8).mean()).toBeCloseTo(
      d20.plus(8).alwaysHits().critOn(19).onHit(d8).mean(),
      12
    );
  });
});

describe("rider and transform options are kept or refused", () => {
  const a = d20.plus(5).ac(15).onHit(d8.plus(3));
  it("every-hit max: 1 keeps happens", () => {
    const lowered = turn([a, a]).onEveryHit(roll(2, d6), { max: 1, happens: 0.5 }).mean();
    const firstHit = Turn.from({ attacks: [a, a], riders: [{ on: "first-hit", damage: roll(2, d6), happens: 0.5 }] }).mean();
    expect(firstHit).toBeCloseTo(11.745, 3);
    expect(lowered).toBeCloseTo(firstHit, 12);
  });

  it("onFirstHit(transform) refuses happens, dealing and optional", () => {
    expect(codeOf(() => turn([a, a]).onFirstHit(keepBestDamage(), { happens: 0.1 }))).toBe("unsupported-trigger");
    expect(codeOf(() => turn([a, a]).onFirstHit(keepBestDamage(), { dealing: "fire" }))).toBe("unsupported-trigger");
    expect(codeOf(() => turn([a, a]).onFirstHit(keepBestDamage(), { optional: true }))).toBe("unsupported-trigger");
  });

  it("a start condition is applied once when a coin splits the start state", () => {
    const m = d20.plus(5).ac(15).melee().onHit(d8.plus(3));
    const t = turn([m, m]).atStart(restrained()).onEveryHit(roll(2, d6), { happens: 0.5 });
    expect(t.fireProbability("condition 1")).toBeCloseTo(1, 12);
  });

  it("joins on a row whose source cannot pool the rider's dice is a TurnSpecError", () => {
    const m = d20.plus(5).ac(15).melee().onHit(d8.plus(3));
    const rider = { id: "sa", on: "first-hit" as const, damage: roll(2, d6), of: ["attack 1", "attack 2"] };
    expect(codeOf(() => Turn.from({ attacks: [m, m], riders: [{ ...rider, joins: ["attack 1"] }] }).mean())).toBe(
      "no-rebindable-source"
    );
    const save = d20.plus(2).dc(15).ability("con").onSaveFailure(roll(2, d6));
    expect(
      codeOf(() =>
        Turn.from({ attacks: [save], riders: [{ id: "r", on: "first-hit", landing: "fail", damage: d6, joins: ["attack 1"] }] }).mean()
      )
    ).toBe("no-rebindable-source");
  });
});
