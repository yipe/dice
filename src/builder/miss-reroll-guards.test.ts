import { describe, expect, it } from "vitest";
import { d20, d4, d8, roll } from "./";
import { parse } from "../parser/parser";

describe("rerollMisses guards", () => {
  it("refuses a d20 minimum above 20", () => {
    expect(() => d20.minimum(21).ac(50).rerollMisses().onHit(1, d8).mean()).toThrow(/rerollMisses.*minimum/);
  });

  it("refuses an exploding d20", () => {
    expect(() => d20.explode(1).ac(15).rerollMisses().onHit(1, d8).mean()).toThrow(/rerollMisses.*explodes/);
  });

  it("refuses to render a kept-one bonus pool", () => {
    const attack = d20.plus(roll(2, 4).bestOf(1)).ac(15).rerollMisses().onHit(1, d8);
    expect(() => attack.toExpression()).toThrow(/toExpression/);
  });

  it("still renders a plain bonus and parses back exactly (case A)", () => {
    const attack = d20.plus(5).plus(1, d4).ac(15).rerollMisses("add-d20").onHit(1, d8);
    const expr = attack.toExpression();
    expect(expr).toContain("d20 reroll");
    expect(Math.abs(parse(expr).mean() - attack.mean())).toBeLessThan(1e-12);
  });
});
