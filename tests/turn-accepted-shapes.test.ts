/**
 * Shapes 0.16 refused and 0.17 accepts, pinned to the numbers they evaluate to. (The refusal tests in
 * src/turn/every-hit-max.test.ts and src/turn/save-landing.test.ts only check that they are accepted; those files are
 * 0.16 compat fixtures, so the numbers live here.)
 */
import { describe, expect, it } from "vitest";
import { advantage, d4, d6, d8, d20, turn } from "../src/builder";

const sword = d20.plus(7).ac(15).onHit(d8.plus(4)); // hit 0.6, crit 0.05: lands 0.65

describe("shapes 0.17 accepts", () => {
  it("an any-crit rider with a max applies to its first `max` crits", () => {
    // onAnyCrit has no max option in its type; a spec's any-crit rider takes one. An any-crit rider applies once, so
    // `max: 1` changes nothing and `max: 2` adds the second crit's (doubled) d6.
    const anyCrit = (options: object) => turn([sword, sword]).onAnyCrit(d6, options as never).mean();
    const plain = turn([sword, sword]).mean();
    expect(anyCrit({})).toBeCloseTo(plain + (1 - 0.95 ** 2) * 7, 12);
    expect(anyCrit({ max: 1 })).toBeCloseTo(anyCrit({}), 12);
    expect(anyCrit({ max: 2 })).toBeCloseTo(plain + 2 * 0.05 * 7, 12);
  });

  it("a first-hit rider naming one folded per source is its partner: it lands alongside it", () => {
    const partner = turn([sword, sword])
      .onFirstHit(d6, { id: "folded", perSource: { "attack 2": { damage: d8 } } })
      .onFirstHit(d4, { of: ["folded"], id: "partner" });
    expect(partner.fireProbability("folded")).toBeCloseTo(1 - 0.35 ** 2, 12);
    expect(partner.fireProbability("partner")).toBeCloseTo(partner.fireProbability("folded"), 12);
  });

  it("a partner lands only where its partner lands: `where` on a subset, and on a save row", () => {
    // The partner (a step rider before the fix) fired on every hit of attack 3; it lands there only
    // where "folded" lands, i.e. when attack 3 is the first hit.
    const subset = turn([sword, sword, sword])
      .onFirstHit(d6, { id: "folded", perSource: { "attack 2": { damage: d8 } } })
      .onFirstHit(d4, { of: ["folded"], where: { folded: ["attack 3"] }, id: "partner" });
    expect(subset.fireProbability("partner")).toBeCloseTo(0.35 * 0.35 * 0.65, 12);

    // On a save row the partner landed on every class, a passed save included.
    const breath = d20.plus(5).dc(15).onSaveFailure(d8).saveHalf(); // fails on d20 <= 9: 0.45
    const save = turn([breath, sword])
      .onFirstHit(d6, { id: "folded", landing: "fail", perSource: { "attack 2": { damage: d8 } } })
      .onFirstHit(d4, { of: ["folded"], id: "partner" });
    expect(save.fireProbability("folded")).toBeCloseTo(1 - 0.55 * 0.35, 12);
    expect(save.fireProbability("partner")).toBeCloseTo(save.fireProbability("folded"), 12);
    const base = turn([breath, sword]).onFirstHit(d6, { id: "folded", landing: "fail", perSource: { "attack 2": { damage: d8 } } });
    // d4 (2.5) where it lands, doubled (5) where the landing is attack 2's crit: 0.55 * 0.05.
    expect(save.mean() - base.mean()).toBeCloseTo(2.5 * (1 - 0.55 * 0.35) + 2.5 * 0.55 * 0.05, 12);
  });

  it("a partner of a partner is refused", () => {
    expect(() =>
      turn([sword, sword])
        .onFirstHit(d6, { id: "folded", perSource: { "attack 2": { damage: d8 } } })
        .onFirstHit(d4, { of: ["folded"], id: "partner" })
        .onFirstHit(d4, { of: ["partner"], id: "chained" })
    ).toThrow(/lands alongside "partner"/);
  });

  it("a grant with `landing: 'fail'` over attacks alone lands on a hit, as by default", () => {
    const grant = advantage().untilEndOfTurn();
    const failing = turn([sword, sword]).onFirstHit(grant, { landing: "fail" }).mean();
    expect(failing).toBeCloseTo(turn([sword, sword]).onFirstHit(grant).mean(), 12);
    expect(failing).toBeGreaterThan(turn([sword, sword]).mean());
  });
});
