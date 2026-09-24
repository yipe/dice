import { describe, expect, it } from "vitest";
import { advantage, d20, d8, roll, turn, TurnSpecError, type Turn } from "../src/builder";

// d20+5 vs AC 12: miss 6/20, hit 13/20, crit 1/20; 1d8+3, 2d8+3 on a crit.
const sword = d20.plus(5).ac(12).onHit(roll(1, d8).plus(3));

function errorOf(build: () => Turn): TurnSpecError | undefined {
  try {
    build().mean();
  } catch (error) {
    if (error instanceof TurnSpecError) return error;
    throw error;
  }
  return undefined;
}

describe("an any-miss reroll and granted modifiers", () => {
  it("refuses a reroll that would read a grant at the end of the turn", () => {
    const vex = errorOf(() =>
      turn([sword, sword, sword])
        .onEveryHit(advantage().untilNextAttack(), { id: "c" })
        .onAnyMiss(sword, { id: "rr" })
    );
    expect(vex?.code).toBe("unsupported-trigger");
    expect(vex?.id).toBe("rr");
    expect(vex?.message).toMatch(/onFirstMiss/);

    const topple = errorOf(() =>
      turn([sword, sword, sword])
        .onEveryHit(advantage().untilEndOfTurn(), { chance: 0.5, id: "c" })
        .onAnyMiss(sword, { id: "rr" })
    );
    expect(topple?.code).toBe("unsupported-trigger");
  });

  it("refuses a reroll whose landing would apply a grant", () => {
    const source = errorOf(() =>
      turn([sword, sword, sword])
        .onAnyMiss(sword, { id: "rr" })
        .onEveryHit(advantage().untilNextAttack().to("attack 3"))
    );
    expect(source?.code).toBe("unsupported-trigger");
    expect(source?.id).toBe("rr");
  });

  it("resolves the same turns exactly as first-miss rerolls", () => {
    const vex = turn([sword, sword, sword])
      .onEveryHit(advantage().untilNextAttack(), { id: "c" })
      .onFirstMiss(sword, { id: "rr" });
    expect(vex.mean()).toBeCloseTo(21493503 / 1000000, 12);
    const topple = turn([sword, sword, sword])
      .onEveryHit(advantage().untilEndOfTurn(), { chance: 0.5, id: "c" })
      .onFirstMiss(sword, { id: "rr" });
    expect(topple.mean()).toBeCloseTo(1681580259 / 80000000, 12);
  });

  it("accepts an any-miss reroll that no grant reaches", () => {
    const scoped = turn()
      .attacks(3, sword, { tag: "main" })
      .onEveryHit(advantage().untilNextAttack().to("main"), { id: "c" })
      .onAnyMiss(sword, { id: "rr" });
    expect(scoped.mean()).toBeCloseTo(21493503 / 1000000, 12);
    expect(scoped.fireProbability("rr")).toBeCloseTo(42033 / 100000, 14);
  });
});
