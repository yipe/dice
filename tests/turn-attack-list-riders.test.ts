import { describe, expect, it } from "vitest";
import {
  advantage,
  d10,
  d20,
  d4,
  d6,
  keepBestDamage,
  roll,
  turn,
  TurnSpecError,
  type Turn,
} from "../src/builder";

// Dagger and unarmed strike: miss 7/20, hit 12/20, crit 1/20 each.
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));

function codeOf(build: () => Turn): string | undefined {
  try {
    build().mean();
  } catch (error) {
    if (error instanceof TurnSpecError) return error.code;
    throw error;
  }
  return undefined;
}

/** The dagger's outcome slices, each a sub-mass PMF. */
const daggerSlices = {
  hit: dagger.pmf.filterOutcome("hit"),
  crit: dagger.pmf.filterOutcome("crit"),
  miss: dagger.pmf.filterOutcome("missNone"),
};

describe("a rider whose damage is a list of several attacks", () => {
  it("cannot be watched: naming it in `of` is not-an-attack", () => {
    const flurry = () => turn([dagger]).onAnyMiss([unarmed, unarmed], { id: "flurry" });
    expect(codeOf(() => flurry().onFirstHit(d10, { of: ["flurry"] }))).toBe("not-an-attack");
    expect(codeOf(() => flurry().onEveryHit(d10, { of: ["flurry"] }))).toBe("not-an-attack");
    expect(codeOf(() => flurry().onAnyCrit(d10, { of: ["flurry"] }))).toBe("not-an-attack");
    expect(codeOf(() => flurry().onFirstHit(keepBestDamage(), { of: ["flurry"] }))).toBe(
      "not-an-attack"
    );
    expect(() => flurry().onFirstHit(d10, { of: ["flurry"] })).toThrow(/its own rider/);
  });

  it("never joins a later rider's default `of`", () => {
    // Hunter's mark watches the dagger only: miss → the flurry's damage; hit/crit → the mark.
    const t = turn([dagger]).onAnyMiss([unarmed, unarmed]).onEveryHit(d6);
    const pair = unarmed.pmf.convolve(unarmed.pmf);
    const expected = daggerSlices.miss
      .convolve(pair, undefined, true)
      .add(daggerSlices.hit.convolve(d6.pmf, undefined, true))
      .add(daggerSlices.crit.convolve(roll(2, 6).pmf, undefined, true));
    const support = new Set([...t.pmf.support(), ...expected.support()]);
    for (const value of support) expect(t.pmf.pAt(value)).toBeCloseTo(expected.pAt(value), 12);
    expect(t.mean()).toBeCloseTo(2067 / 200, 12);
  });

  it("still deals the exact sum of its attacks", () => {
    const t = turn([dagger]).onAnyMiss([unarmed, unarmed], { id: "flurry" });
    const expected = daggerSlices.miss
      .convolve(unarmed.pmf.convolve(unarmed.pmf), undefined, true)
      .add(daggerSlices.hit)
      .add(daggerSlices.crit);
    for (const value of expected.support()) expect(t.pmf.pAt(value)).toBeCloseTo(expected.pAt(value), 12);
    expect(t.fireProbability("flurry")).toBeCloseTo(7 / 20, 14);
  });

  it("refuses a granted modifier it would read rather than ignoring it", () => {
    expect(
      codeOf(() =>
        turn([dagger, dagger])
          .onAnyCrit(roll(2, 8), { id: "smite" })
          .otherwise([unarmed, unarmed])
          .onEveryHit(advantage().untilNextAttack(), { of: ["attack 1", "attack 2"] })
      )
    ).toBe("no-rebindable-source");
  });
});
