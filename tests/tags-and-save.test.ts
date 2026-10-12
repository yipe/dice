import { describe, expect, it } from "vitest";
import { advantage, d20, d4, d6, d8, keepBestDamage, roll, save, turn, TurnSpecError, type Turn } from "../src/builder";
import { prone, saveDC, stunned } from "../src/dnd5e";

const attack = d20.plus(7).ac(15);
const sword = attack.onHit(d8.plus(4));
const fist = attack.onHit(d6.plus(4));
const check = d20.plus(3).dc(14).ability("con");

const faces = (t: Turn) => t.pmf.support().map((x) => [x, t.pmf.pAt(x)]);

const codeOf = (build: () => unknown): string | undefined => {
  try {
    build();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
};

describe("AttackBuilder.tagged()", () => {
  it("names the attacks an `of` watches, as ids do", () => {
    const tagged = turn([sword.tagged("blade"), sword.tagged("blade"), fist]).onFirstHit(roll(2, d6), { of: ["blade"] });
    const byId = turn([sword, sword, fist]).onFirstHit(roll(2, d6), { of: ["attack 1", "attack 2"] });
    expect(faces(tagged)).toEqual(faces(byId));
    // Not every attack: the fist is left out.
    expect(tagged.mean()).not.toBeCloseTo(turn([sword, sword, fist]).onFirstHit(roll(2, d6)).mean(), 3);
  });

  it("changes no number the attack resolves", () => {
    expect(faces(turn([sword.tagged("blade")]))).toEqual(faces(turn([sword])));
  });

  it("matches beside a declaration tag, each attack once", () => {
    const both = turn()
      .attack(sword.tagged("blade"), { tag: "blade" })
      .attack(sword, { tag: "blade" })
      .attack(fist.tagged("blade", "fist"))
      .onEveryHit(d4, { of: ["blade", "fist"] });
    const byId = turn([sword, sword, fist]).onEveryHit(d4, { of: ["attack 1", "attack 2", "attack 3"] });
    expect(faces(both)).toEqual(faces(byId));
  });

  it("adds to the tags on a second call, whatever the order around onEveryHit", () => {
    const vex = advantage().untilNextAttack();
    const before = sword.tagged("blade").onEveryHit(vex).tagged("finesse");
    const after = sword.onEveryHit(vex).tagged("finesse", "blade");
    expect(before.tags).toEqual(["blade", "finesse"]);
    expect(after.tags).toEqual(["finesse", "blade"]);
    const of = { of: ["blade"] };
    expect(faces(turn([before, before]).onFirstHit(d6, of))).toEqual(faces(turn([after, after]).onFirstHit(d6, of)));
  });

  it("survives vsAC and every rebuilding method", () => {
    const tagged = sword.tagged("blade").melee().rerollDamage(1).halfOnMiss();
    expect(tagged.tags).toEqual(["blade"]);
    const t = turn([tagged, fist]).onFirstHit(d6, { of: "blade" }).vsAC(18);
    const byId = turn([sword.melee().rerollDamage(1).halfOnMiss(), fist]).onFirstHit(d6, { of: ["attack 1"] }).vsAC(18);
    expect(faces(t)).toEqual(faces(byId));
  });

  it("reads in a grant's `to`", () => {
    const grant = advantage().untilEndOfTurn().to("fist");
    const tagged = turn([sword, fist.tagged("fist"), sword]).onFirstHit(grant, { of: ["attack 1"] });
    const byId = turn([sword, fist, sword]).onFirstHit(advantage().untilEndOfTurn().to("attack 2"), { of: ["attack 1"] });
    // Not every later attack: the third sword rolls plain.
    expect(tagged.mean()).not.toBeCloseTo(turn([sword, fist, sword]).onFirstHit(advantage().untilEndOfTurn(), { of: ["attack 1"] }).mean(), 3);
    expect(faces(tagged)).toEqual(faces(byId));
  });

  it("refuses no tag or an empty one; a tag that matches nothing is unknown-id", () => {
    expect(() => sword.tagged()).toThrow(TypeError);
    expect(() => sword.tagged("")).toThrow(TypeError);
    // @ts-expect-error a plain-JS caller can pass undefined
    expect(() => sword.tagged("blade", undefined)).toThrow(TypeError);
    expect(codeOf(() => turn([sword.tagged("blade")]).onFirstHit(d6, { of: "axe" }).mean())).toBe("unknown-id");
  });

  it("names a tagged reroll too, as an omitted `of` includes it", () => {
    const blade = sword.tagged("blade");
    const rerolled = turn([blade]).onFirstMiss(blade, { id: "reroll" });
    const byTag = rerolled.onFirstHit(d6, { of: "blade", id: "sa" });
    const byId = rerolled.onFirstHit(d6, { of: ["attack 1", "reroll"], id: "sa" });
    expect(byTag.fireProbability("sa")).toBeCloseTo(byId.fireProbability("sa"), 12);
    // The reroll lands where the first swing missed: 0.65 + 0.35 × 0.65.
    expect(byTag.fireProbability("sa")).toBeCloseTo(0.8775, 12);
    expect(faces(byTag)).toEqual(faces(byId));
    // Given as a list (one attack beside flat damage), the reroll is still named by its tag.
    const listed = turn([blade]).onFirstMiss([blade, d4], { id: "reroll" });
    const listedByTag = listed.onFirstHit(d6, { of: "blade", id: "sa" }).fireProbability("sa");
    expect(listedByTag).toBeCloseTo(listed.onFirstHit(d6, { of: ["attack 1", "reroll"], id: "sa" }).fireProbability("sa"), 12);
    expect(listedByTag).toBeCloseTo(0.8775, 12);
  });

  it("lets a tagged reroll watch its own tag without watching itself", () => {
    const blade = sword.tagged("blade");
    expect(faces(turn([blade]).onFirstMiss(blade, { of: "blade" }))).toEqual(faces(turn([blade]).onFirstMiss(blade)));
  });

  it("reaches, for a rider, only the rerolls declared before it, as an omitted `of` does", () => {
    const blade = sword.tagged("blade");
    // Two rerolls naming their tag: the second watches the first, not the other way round (no cycle).
    const byTag = turn([blade]).onFirstMiss(blade, { id: "a", of: "blade" }).onFirstMiss(blade, { id: "b", of: "blade" });
    const byId = turn([blade]).onFirstMiss(blade, { id: "a", of: ["attack 1"] }).onFirstMiss(blade, { id: "b", of: ["attack 1", "a"] });
    expect(faces(byTag)).toEqual(faces(byId));
    // A rider before the reroll does not reach it; one after does.
    const before = turn([blade]).onFirstHit(d6, { id: "sa", of: "blade" }).onFirstMiss(blade, { id: "r" });
    const omitted = turn([blade]).onFirstHit(d6, { id: "sa" }).onFirstMiss(blade, { id: "r" });
    expect(before.fireProbability("sa")).toBeCloseTo(omitted.fireProbability("sa"), 12);
    expect(before.fireProbability("sa")).toBeCloseTo(0.65, 12);
  });

  it("refuses a non-string tag on a source as non-string-id", () => {
    const forged = Object.assign(Object.create(Object.getPrototypeOf(sword) as object) as object, sword, { tags: [7] });
    expect(codeOf(() => turn([forged as typeof sword]).mean())).toBe("non-string-id");
  });
});

describe("`of` as one name", () => {
  it("is the list of that one name, on every verb that takes RiderOptions", () => {
    const t = turn([sword.tagged("blade"), fist]);
    const same = (a: Turn, b: Turn) => expect(faces(a)).toEqual(faces(b));
    same(t.onFirstHit(d6, { of: "blade" }), t.onFirstHit(d6, { of: ["blade"] }));
    same(t.onFirstHit(keepBestDamage(), { of: "blade" }), t.onFirstHit(keepBestDamage(), { of: ["blade"] }));
    same(t.onEveryHit(d4, { of: "attack 2" }), t.onEveryHit(d4, { of: ["attack 2"] }));
    same(t.onAnyCrit(d6, { of: "blade" }), t.onAnyCrit(d6, { of: ["blade"] }));
    const grant = advantage().untilEndOfTurn();
    same(t.onFirstCrit(grant, { of: "blade" }), t.onFirstCrit(grant, { of: ["blade"] }));
    same(t.onFirstMiss(sword, { of: "blade" }), t.onFirstMiss(sword, { of: ["blade"] }));
    same(t.onAnyMiss(d4, { of: "blade" }), t.onAnyMiss(d4, { of: ["blade"] }));
  });
});

describe("save(check, { fail, pass })", () => {
  const options = { save: check, onSave: advantage().untilNextAttack() };

  it("is the trigger's save and onSave, on Turn verbs", () => {
    const gated = save(check, { fail: stunned().untilEndOfTurn(), pass: advantage().untilNextAttack() });
    const t = turn([fist, fist, sword]);
    expect(faces(t.onFirstHit(gated))).toEqual(faces(t.onFirstHit(stunned().untilEndOfTurn(), options)));
    expect(faces(t.onEveryHit(gated, { of: "attack 1" }))).toEqual(
      faces(t.onEveryHit(stunned().untilEndOfTurn(), { ...options, of: ["attack 1"] }))
    );
    expect(faces(t.onAnyCrit(gated))).toEqual(faces(t.onAnyCrit(stunned().untilEndOfTurn(), options)));
    expect(faces(t.onFirstCrit(gated))).toEqual(faces(t.onFirstCrit(stunned().untilEndOfTurn(), options)));
  });

  it("is the attached gate, on AttackBuilder verbs (Topple)", () => {
    const topple = sword.melee().onEveryHit(save(saveDC(15, { con: +2 }), { fail: prone().untilEndOfTurn() }));
    const gate = sword.melee().onEveryHit(prone().untilEndOfTurn(), { save: saveDC(15, { con: +2 }) });
    expect(faces(turn([topple, topple, sword.melee()]))).toEqual(faces(turn([gate, gate, sword.melee()])));
    const onCrit = save(check, { fail: prone().untilEndOfTurn() });
    for (const verb of ["onAnyCrit", "onFirstCrit"] as const) {
      const sugared = sword.melee()[verb](onCrit);
      const plain = sword.melee()[verb](prone().untilEndOfTurn(), { save: check });
      expect(faces(turn([sugared, sword.melee()]))).toEqual(faces(turn([plain, sword.melee()])));
    }
  });

  it("without pass gates the fail effects only", () => {
    const t = turn([fist, sword]);
    expect(faces(t.onFirstHit(save(check, { fail: stunned().untilEndOfTurn() })))).toEqual(
      faces(t.onFirstHit(stunned().untilEndOfTurn(), { save: check }))
    );
  });

  it("refuses a second gate in the options, damage among its effects, no fail effect, or no check", () => {
    const gated = save(check, { fail: stunned().untilEndOfTurn() });
    expect(() => turn([fist]).onFirstHit(gated, { save: check })).toThrow(/save\(\) value/);
    expect(() => turn([fist]).onFirstHit(gated, { chance: 0.5 })).toThrow(/save\(\) value/);
    expect(() => sword.onEveryHit(gated, { onSave: advantage().untilNextAttack() })).toThrow(/save\(\) value/);
    // @ts-expect-error damage is not an effect with a lifetime
    expect(() => save(check, { fail: d6 })).toThrow(TypeError);
    expect(() => save(check, { fail: [] })).toThrow(TypeError);
    // No check would drop the save and apply `fail` every time.
    expect(() => save([], { fail: stunned().untilEndOfTurn() })).toThrow(TypeError);
    // @ts-expect-error a plain-JS caller can pass undefined
    expect(() => save(undefined, { fail: stunned().untilEndOfTurn() })).toThrow(TypeError);
  });

  it("takes a list of checks, of which the target makes the one it passes most", () => {
    const either = [check, { ability: "dexterity", dc: 14, bonus: 6 }] as const;
    const t = turn([fist, sword]);
    expect(faces(t.onFirstHit(save(either, { fail: stunned().untilEndOfTurn() })))).toEqual(
      faces(t.onFirstHit(stunned().untilEndOfTurn(), { save: either }))
    );
  });

  it("is only what save() built: a look-alike object is refused, not run ungated", () => {
    const forged = { kind: "save-gated", check, fail: [], pass: [] } as const;
    expect(() => turn([fist, sword]).onFirstHit(forged).mean()).toThrow();
    expect(() => turn([sword.onEveryHit(forged), sword]).mean()).toThrow();
  });
});
