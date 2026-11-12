import { describe, expect, it } from "vitest";
import { d20, d8, roll, turn } from "../builder";
import { condition } from "../turn/effects";
import { invisibleRule } from "./index";

const sword = d20.plus(7).ac(16).melee().onHit(roll(1, d8).plus(4));

describe("invisibleRule", () => {
  it("is the no-condition mean when the attacker sees the target", () => {
    const base = turn([sword]).mean();
    const seen = turn([sword]).atStart(condition("invisible", invisibleRule({ attackerSees: true }))).mean();
    expect(Math.abs(seen - base)).toBeLessThan(1e-12);
  });
  it("is the disadvantaged pin when the attacker cannot see it", () => {
    const m = turn([sword]).atStart(condition("invisible", invisibleRule({ attackerSees: false }))).mean();
    expect(Math.abs(m - 3.07125)).toBeLessThan(1e-12);
  });
});
