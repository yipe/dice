import { describe, expect, it } from "vitest";
import { critOnHit, d20, d8, roll, turn } from "../builder";
import { prone, saveDC } from "../dnd5e";

const sword = d20.plus(7).ac(16).melee().onHit(roll(1, d8).plus(4));
const topple = sword.onEveryHit(prone().untilEndOfTurn(), { save: saveDC(15, { con: 3 }) });

describe("ConditionGate.targetHas on an attached condition", () => {
  it("C6 = 18.3886695, bit for bit equal to the Turn-level form", () => {
    const attached = turn([topple, sword.onEveryHit(critOnHit().untilEndOfTurn(), { targetHas: "prone" }), sword]);
    const turnLevel = turn([topple, sword, sword]).onEveryHit(critOnHit().untilEndOfTurn(), {
      of: ["attack 2"],
      targetHas: "prone",
    });
    expect(Math.abs(attached.mean() - 18.3886695)).toBeLessThanOrEqual(1e-12);
    expect(attached.mean()).toBe(turnLevel.mean());
  });
});
