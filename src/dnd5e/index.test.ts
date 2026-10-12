import { describe, expect, it } from "vitest";
import { advantage, d20, d6, d8, turn, type Turn } from "../builder";
import { contestLossChance, RULES, saveDC, stunned, stunningStrike, TAGS, vex } from "./index";

const faces = (t: Turn) => t.pmf.support().map((x) => [x, t.pmf.pAt(x)]);

/** The contest enumerated independently: P(d20 + defender < d20 + attacker), ties to the defender. */
function enumerated(attacker: number, defender: number): number {
  let lost = 0;
  for (let d = 1; d <= 20; d++) {
    for (let a = 1; a <= 20; a++) {
      if (a + attacker > d + defender) lost++;
    }
  }
  return lost / 400;
}

describe("@yipe/dice/dnd5e", () => {
  it("has the six conditions", () => {
    expect(Object.keys(RULES).sort()).toEqual([
      "blinded",
      "paralyzed",
      "prone",
      "restrained",
      "stunned",
      "unconscious",
    ]);
    expect(RULES.unconscious.onEnd).toEqual({ condition: "prone", rule: RULES.prone });
  });

  it("favours the bigger bonus", () => {
    expect(contestLossChance({ attacker: 10, defender: 0 })).toBeGreaterThan(0.5);
  });

  it("gives ties to the defender", () => {
    // 190 of the 400 pairs have the attacker strictly ahead; the 20 ties go to the defender.
    expect(contestLossChance({ attacker: 0, defender: 0 })).toBe(enumerated(0, 0));
    expect(enumerated(0, 0)).toBe(190 / 400);
  });

  it("matches the enumeration and the closed form for bonuses -5..+15", () => {
    // The attacker wins where its d20 beats the defender's by more than `lead = defender − attacker`:
    // the pairs with yours − theirs ≥ m (m = lead + 1) number (20 − m)(21 − m)/2 for 1 ≤ m ≤ 20, and
    // 400 less the mirror count (19 + m)(20 + m)/2 for −19 ≤ m ≤ 0.
    const closedForm = (attacker: number, defender: number): number => {
      const m = defender - attacker + 1;
      if (m > 20) return 0;
      if (m < -19) return 1;
      return (m >= 1 ? ((20 - m) * (21 - m)) / 2 : 400 - ((19 + m) * (20 + m)) / 2) / 400;
    };
    expect(closedForm(0, 0)).toBe(190 / 400);
    for (let attacker = -5; attacker <= 15; attacker++) {
      for (let defender = -5; defender <= 15; defender++) {
        expect(contestLossChance({ attacker, defender })).toBe(enumerated(attacker, defender));
        expect(contestLossChance({ attacker, defender })).toBe(closedForm(attacker, defender));
      }
    }
  });

  it("the README turn: tags, vex() and stunningStrike() are the id-based turn they stand for", () => {
    const prof = +3;
    const mod = +4;
    const monkDie = d8;
    const attack = d20.plus(prof + mod).ac(15);

    const shortsword = attack.onHit(monkDie.plus(mod)).tagged("finesse").onEveryHit(vex());
    const scimitar = attack.onHit(monkDie).tagged("finesse"); // Nick: no Dex mod
    const fist = attack.onHit(monkDie.plus(mod)).tagged("unarmed"); // Flurry of Blows

    const myTurn = turn([shortsword, shortsword, scimitar, fist, fist])
      .onFirstHit(d6, { of: "finesse" }) // Sneak Attack
      .onFirstHit(stunningStrike(saveDC(14, { con: +3 })), { of: "unarmed" }); // Stunning Strike

    const plainSword = attack.onHit(d8.plus(4)).onEveryHit(advantage().untilNextAttack());
    const plainScimitar = attack.onHit(d8);
    const plainFist = attack.onHit(d8.plus(4));
    const spelled = turn([plainSword, plainSword, plainScimitar, plainFist, plainFist])
      .onFirstHit(d6, { of: ["attack 1", "attack 2", "attack 3"] })
      .onFirstHit(stunned().untilEndOfTurn(), {
        of: ["attack 4", "attack 5"],
        save: saveDC(14, { con: +3 }),
        onSave: advantage().untilNextAttack(),
      });

    expect(faces(myTurn)).toEqual(faces(spelled));
    expect(myTurn.mean()).toBeCloseTo(33.5367, 4);
  });

  it("names the tags its rules use, once each", () => {
    expect(new Set(TAGS).size).toBe(TAGS.length);
    expect(TAGS).toEqual(expect.arrayContaining(["finesse", "unarmed", "monk-weapon", "weapon", "spell"]));
  });
});
