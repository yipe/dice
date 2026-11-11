import { describe, expect, it } from "vitest";
import { d20, d6, d8, keepBestDamage, roll, turn, TurnSpecError } from "../builder";
import { prone } from "../dnd5e";
import { saveDC } from "../dnd5e";

const sword = d20.plus(7).ac(16).melee().onHit(roll(1, d8).plus(4));

describe("onFirstHit with targetHas", () => {
  it("refuses a transform, at the type level and at runtime", () => {
    // @ts-expect-error a transform takes no targetHas
    const typed = () => turn([sword, sword]).onFirstHit(keepBestDamage(), { targetHas: "prone" });
    expect(typed).toThrow(TurnSpecError);
    try {
      typed();
    } catch (error) {
      expect((error as TurnSpecError).code).toBe("unsupported-trigger");
      expect((error as Error).message).toContain("targetHas");
    }
    const untyped = () => (turn([sword, sword]).onFirstHit as any)(keepBestDamage(), { targetHas: ["prone"] });
    expect(untyped).toThrow(/targetHas/);
  });

  it("still gates a first-hit grant-free rider by targetHas", () => {
    const mean = turn([sword, sword])
      .onEveryHit(prone().untilEndOfTurn(), { of: "attack 1", save: saveDC(15, { con: 3 }) })
      .onFirstHit(roll(1, d6), { of: ["attack 1", "attack 2"], targetHas: "prone" })
      .mean();
    expect(Math.abs(mean - 12.47655)).toBeLessThanOrEqual(1e-12);
  });
});
