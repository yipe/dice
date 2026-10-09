import { describe, expect, it } from "vitest";
import { d, d20, flat, Turn } from "../builder";
import type { ContextualSource, RowContext, TurnSpec } from "../builder";
import { RULES } from "../dnd5e";
import { PMF } from "../pmf/pmf";

// A `dealing` condition (Cold Caster's Frostbite: the first hit that deals cold gives the next save
// a 1d4 penalty) over an attack a rider lands on. The rider's dice are damage of the hit, so its
// cold makes the hit a cold hit. Every expected value is a mixture of the save's own PMFs with odds
// worked out by hand.

const own = { advantageDice: 2, pinned: false, autoHit: false, autoCrit: false, autoFail: false } as const;
const d20Under = (context: RowContext) =>
  context.rollType === "advantage" ? d20.withAdvantage() : context.rollType === "disadvantage" ? d20.withDisadvantage() : d20;

/** A DC 14 Dexterity save at +3, 3d6 and half on a pass; an automatic fail where the context says so. */
const saveUnder = (context: RowContext): PMF => {
  let roll = d20Under(context).plus(3);
  for (const die of context.penaltyDice) roll = roll.minus(die.count, d(die.sides));
  return roll.dc(context.autoFail ? 1000 : 14).onSaveFailure(d("3d6")).saveHalf().toPMF();
};
const save: ContextualSource = { rowCheck: { kind: "save", ability: "dexterity", rollType: "flat", ...own }, under: saveUnder };

const contextOf = (extra: Partial<RowContext> = {}): RowContext => ({
  rollType: "flat",
  autoHit: false,
  critOnHit: false,
  autoFail: false,
  vulnerable: false,
  penaltyDice: [],
  joined: [],
  ...extra,
});
const PENALTY = { penaltyDice: [{ count: 1, sides: 4 }] };

/** The save's PMF in each state, mixed by its odds. */
const mixture = (states: ReadonlyArray<[number, Partial<RowContext>]>): PMF =>
  states.reduce((all, [p, extra]) => all.add(saveUnder(contextOf(extra)).scaleMass(p)), PMF.emptyMass());

function pmfMaxDiff(actual: PMF, expected: PMF): number {
  let worst = 0;
  for (const value of new Set([...actual.support(), ...expected.support()])) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - expected.pAt(value)));
  }
  return worst;
}

const typedAs = (type: string, odds: { hit: number; crit: number }) => (asked: string) =>
  asked === type ? odds : { hit: 0, crit: 0 };
const frostbite = (of: string) => ({
  id: "frostbite",
  on: "first-hit" as const,
  of: [of],
  dealing: "cold",
  grants: [{ savePenalty: { count: 1, sides: 4 }, until: "next-save" as const }],
});

describe("a rider that lands on any outcome deals the type on the hit it lands on", () => {
  // +5 against AC 15, 1d8+3 slashing: a hit 0.5, a crit 0.05.
  const sword: ContextualSource = {
    rowCheck: { kind: "attack", range: "melee", rollType: "flat", ...own },
    under: (context) => d20Under(context).plus(5).ac(15).onHit(d("1d8+3")).toPMF(),
    dealt: typedAs("slashing", { hit: 1, crit: 1 }),
  };
  const payload = (dealt: { hit: number; crit: number }) => {
    const onHit = d("1d6").toPMF();
    const onCrit = d("2d6").toPMF();
    const doubled = (pmf: PMF) => pmf.mapDamage((value) => 2 * value);
    return {
      at: () => ({ onHit, onCrit, vulnerable: { onHit: doubled(onHit), onCrit: doubled(onCrit) } }),
      dealt: typedAs("cold", dealt),
    };
  };
  const spec = (landing: "hit" | "any", dealt: { hit: number; crit: number }): TurnSpec => ({
    attacks: [
      { id: "sword", source: sword },
      { id: "save", source: save },
    ],
    riders: [{ id: "polar", on: "first-hit", of: ["sword"], ...(landing === "any" ? { landing } : {}), damage: payload(dealt) }],
    conditions: [frostbite("sword")],
  });
  const landed = mixture([
    [0.55, PENALTY],
    [0.45, {}],
  ]);

  it.each(["hit", "any"] as const)("landing %s: the penalty is on the save with the odds the sword lands", (landing) => {
    const turn = Turn.from(spec(landing, { hit: 1, crit: 1 }));
    expect(turn.stepStats("save").live.savePenalty).toBeCloseTo(0.55, 12);
    expect(pmfMaxDiff(turn.marginal("save").pmf, landed)).toBeLessThan(1e-12);
  });

  it("on a crit it deals its plain payload, so its plain hit's odds say whether it dealt the type", () => {
    // Cold on a plain hit only: the `any` rider's crit is its plain payload, a cold one.
    const turn = Turn.from(spec("any", { hit: 1, crit: 0 }));
    expect(turn.stepStats("save").live.savePenalty).toBeCloseTo(0.55, 12);
    expect(pmfMaxDiff(turn.marginal("save").pmf, landed)).toBeLessThan(1e-12);
  });
});

describe("a rider landing that wakes the creature and deals the type is one event", () => {
  // `club`: +5 against AC 15; its first hit knocks the target out until it takes damage (0.55).
  // `bolt`: ranged, deals nothing itself; on a sleeping target its Advantage and Prone's Disadvantage
  // cancel, so it hits 0.5 and crits 0.05 either way. Its rider deals cold: 1d2 halved on a hit
  // (0 or 1) and 2d2 halved on a crit (1 or 2), the only damage the target takes there. The save
  // after it fails automatically on a sleeping target.
  const attackUnder = (damage: ReturnType<typeof flat>) => (context: RowContext) => {
    const roll = d20Under(context).plus(5).ac(15);
    return (context.critOnHit ? roll.alwaysCrits() : roll).onHit(damage).toPMF();
  };
  const club: ContextualSource = {
    rowCheck: { kind: "attack", range: "melee", rollType: "flat", ...own },
    under: attackUnder(d("1d8+3")),
    dealt: typedAs("bludgeoning", { hit: 1, crit: 1 }),
  };
  const bolt: ContextualSource = {
    rowCheck: { kind: "attack", range: "ranged", rollType: "flat", ...own },
    under: attackUnder(flat(0)),
    dealt: () => ({ hit: 0, crit: 0 }),
  };
  const onHit = PMF.fromMap(
    new Map([
      [0, 0.5],
      [1, 0.5],
    ])
  );
  const onCrit = PMF.fromMap(
    new Map([
      [1, 0.75],
      [2, 0.25],
    ])
  );
  const doubled = (pmf: PMF) => pmf.mapDamage((value) => 2 * value);
  const spec: TurnSpec = {
    attacks: [
      { id: "club", source: club },
      { id: "bolt", source: bolt },
      { id: "save", source: save },
    ],
    riders: [
      {
        id: "polar",
        on: "first-hit",
        of: ["bolt"],
        damage: {
          at: () => ({ onHit, onCrit, vulnerable: { onHit: doubled(onHit), onCrit: doubled(onCrit) } }),
          dealt: typedAs("cold", { hit: 0.5, crit: 1 }),
        },
      },
    ],
    conditions: [
      { id: "knockOut", on: "first-hit", of: ["club"], grants: [{ condition: "unconscious", rule: RULES.unconscious, until: "until-damaged" }] },
      frostbite("bolt"),
    ],
  };

  it("the save rolls asleep, awake with the penalty, or awake without it", () => {
    // The rider deals cold (0.5 x 1/2 + 0.05 = 0.3) exactly where it wakes the target: asleep
    // 0.55 x 0.7, awake with the penalty 0.3, awake without it the rest.
    const turn = Turn.from(spec);
    const { live } = turn.stepStats("save");
    expect(live.autoFail).toBeCloseTo(0.385, 12);
    expect(live.savePenalty).toBeCloseTo(0.3, 12);
    const want = mixture([
      [0.385, { autoFail: true }],
      [0.3, PENALTY],
      [0.315, {}],
    ]);
    expect(pmfMaxDiff(turn.marginal("save").pmf, want)).toBeLessThan(1e-12);
  });

  it("the rider's own marginal is its payload where it lands", () => {
    // Asleep the bolt lands 0.55 (hit 0.5, crit 0.05), awake the same: flat either way.
    const want = onHit.scaleMass(0.5).add(onCrit.scaleMass(0.05)).add(PMF.delta(0).scaleMass(0.45));
    expect(pmfMaxDiff(Turn.from(spec).marginal("polar").pmf, want)).toBeLessThan(1e-12);
  });
});
