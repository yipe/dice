import { describe, expect, it } from "vitest";
import { advantage, d20, d4, d6, d8, keepBestDamage, roll, save, turn, TurnSpecError, type Turn } from "../src/builder";
import { prone, stunned } from "../src/dnd5e";

const attack = d20.plus(7).ac(15);
const sword = attack.onHit(d8.plus(4));
const fist = attack.onHit(d6.plus(4));
const blade = sword.tagged("blade");
const check = d20.plus(3).dc(14).ability("con");

const faces = (t: Turn) => t.pmf.support().map((x) => [x, t.pmf.pAt(x)]);
/** The two turns resolve to the same distribution, bit for bit. */
const same = (a: Turn, b: Turn) => expect(faces(a)).toEqual(faces(b));

const codeOf = (build: () => unknown): string | undefined => {
  try {
    build();
  } catch (error) {
    return error instanceof TurnSpecError ? error.code : `not a TurnSpecError: ${String(error)}`;
  }
  return undefined;
};

describe("AttackBuilder.tagged()", () => {
  it("names the attacks an `of` watches, as ids do, and changes no number", () => {
    const tagged = turn([blade, blade, fist]).onFirstHit(roll(2, d6), { of: ["blade"] });
    same(tagged, turn([sword, sword, fist]).onFirstHit(roll(2, d6), { of: ["attack 1", "attack 2"] }));
    // Not every attack: the fist is left out.
    expect(tagged.mean()).not.toBeCloseTo(turn([sword, sword, fist]).onFirstHit(roll(2, d6)).mean(), 3);
  });

  it("matches beside a declaration tag, each attack once", () => {
    const both = turn()
      .attack(blade, { tag: "blade" })
      .attack(sword, { tag: "blade" })
      .attack(fist.tagged("blade", "fist"))
      .onEveryHit(d4, { of: ["blade", "fist"] });
    same(both, turn([sword, sword, fist]).onEveryHit(d4, { of: ["attack 1", "attack 2", "attack 3"] }));
  });

  it("adds to the tags on a second call, whatever the order around onEveryHit", () => {
    const vex = advantage().untilNextAttack();
    const before = blade.onEveryHit(vex).tagged("finesse");
    const after = sword.onEveryHit(vex).tagged("finesse", "blade");
    expect(before.tags).toEqual(["blade", "finesse"]);
    expect(after.tags).toEqual(["finesse", "blade"]);
    same(turn([before, before]).onFirstHit(d6, { of: "blade" }), turn([after, after]).onFirstHit(d6, { of: "blade" }));
  });

  it("survives vsAC and every rebuilding method", () => {
    const tagged = blade.melee().rerollDamage(1).halfOnMiss();
    expect(tagged.tags).toEqual(["blade"]);
    same(
      turn([tagged, fist]).onFirstHit(d6, { of: "blade" }).vsAC(18),
      turn([sword.melee().rerollDamage(1).halfOnMiss(), fist]).onFirstHit(d6, { of: ["attack 1"] }).vsAC(18)
    );
  });

  it("reads in a grant's `to`", () => {
    const grant = advantage().untilEndOfTurn();
    const tagged = turn([sword, fist.tagged("fist"), sword]).onFirstHit(grant.to("fist"), { of: ["attack 1"] });
    same(tagged, turn([sword, fist, sword]).onFirstHit(grant.to("attack 2"), { of: ["attack 1"] }));
    // Not every later attack: the third sword rolls plain.
    expect(tagged.mean()).not.toBeCloseTo(turn([sword, fist, sword]).onFirstHit(grant, { of: ["attack 1"] }).mean(), 3);
  });

  it("names a tagged reroll too, given alone or in a list, as an omitted `of` includes it", () => {
    for (const reroll of [blade, [blade, d4]] as const) {
      const rerolled = turn([blade]).onFirstMiss(reroll, { id: "reroll" });
      const byTag = rerolled.onFirstHit(d6, { of: "blade", id: "sa" });
      same(byTag, rerolled.onFirstHit(d6, { of: ["attack 1", "reroll"], id: "sa" }));
      // The reroll lands where the first swing missed: 0.65 + 0.35 × 0.65.
      expect(byTag.fireProbability("sa")).toBeCloseTo(0.8775, 12);
    }
  });

  it("reaches, for a rider, only the rerolls declared before it, as an omitted `of` does", () => {
    // Never itself: a reroll naming its own tag watches the attack only.
    same(turn([blade]).onFirstMiss(blade, { of: "blade" }), turn([blade]).onFirstMiss(blade));
    // Two rerolls naming their tag: the second watches the first, not the other way round (no cycle).
    same(
      turn([blade]).onFirstMiss(blade, { id: "a", of: "blade" }).onFirstMiss(blade, { id: "b", of: "blade" }),
      turn([blade]).onFirstMiss(blade, { id: "a", of: ["attack 1"] }).onFirstMiss(blade, { id: "b", of: ["attack 1", "a"] })
    );
    // A rider before the reroll does not reach it.
    const before = turn([blade]).onFirstHit(d6, { id: "sa", of: "blade" }).onFirstMiss(blade, { id: "r" });
    expect(before.fireProbability("sa")).toBeCloseTo(0.65, 12);
  });

  it("refuses no tag, an empty or a non-string one; a tag that matches nothing is unknown-id", () => {
    expect(() => sword.tagged()).toThrow(TypeError);
    expect(() => sword.tagged("")).toThrow(TypeError);
    // @ts-expect-error a plain-JS caller can pass undefined
    expect(() => sword.tagged("blade", undefined)).toThrow(TypeError);
    const forged = Object.assign(Object.create(Object.getPrototypeOf(sword) as object) as object, sword, { tags: [7] });
    expect(codeOf(() => turn([forged as typeof sword]).mean())).toBe("non-string-id");
    expect(codeOf(() => turn([blade]).onFirstHit(d6, { of: "axe" }).mean())).toBe("unknown-id");
  });
});

describe("`of` as one name", () => {
  it("is the list of that one name, on every verb that takes RiderOptions", () => {
    const t = turn([blade, fist]);
    const grant = advantage().untilEndOfTurn();
    same(t.onFirstHit(d6, { of: "blade" }), t.onFirstHit(d6, { of: ["blade"] }));
    same(t.onFirstHit(keepBestDamage(), { of: "blade" }), t.onFirstHit(keepBestDamage(), { of: ["blade"] }));
    same(t.onEveryHit(d4, { of: "attack 2" }), t.onEveryHit(d4, { of: ["attack 2"] }));
    same(t.onAnyCrit(d6, { of: "blade" }), t.onAnyCrit(d6, { of: ["blade"] }));
    same(t.onFirstCrit(grant, { of: "blade" }), t.onFirstCrit(grant, { of: ["blade"] }));
    same(t.onFirstMiss(sword, { of: "blade" }), t.onFirstMiss(sword, { of: ["blade"] }));
    same(t.onAnyMiss(d4, { of: "blade" }), t.onAnyMiss(d4, { of: ["blade"] }));
  });
});

describe("save(check, { fail, pass })", () => {
  const stun = stunned().untilEndOfTurn();
  const next = advantage().untilNextAttack();

  it("is the trigger's save and onSave in the options, on every Turn verb", () => {
    const t = turn([fist, fist, sword]);
    const either = [check, { ability: "dexterity", dc: 14, bonus: 6 }] as const;
    const gated = save(check, { fail: stun, pass: next });
    const options = { save: check, onSave: next };
    same(t.onFirstHit(gated), t.onFirstHit(stun, options));
    same(t.onEveryHit(gated, { of: "attack 1" }), t.onEveryHit(stun, { ...options, of: ["attack 1"] }));
    same(t.onAnyCrit(gated), t.onAnyCrit(stun, options));
    same(t.onFirstCrit(gated), t.onFirstCrit(stun, options));
    // Without `pass`, only the fail effects are gated; a list of checks is the target's likeliest pass.
    same(t.onFirstHit(save(check, { fail: stun })), t.onFirstHit(stun, { save: check }));
    same(t.onFirstHit(save(either, { fail: stun })), t.onFirstHit(stun, { save: either }));
  });

  it("is the attached gate, on every AttackBuilder verb (Topple)", () => {
    const melee = sword.melee();
    const topple = save(check, { fail: prone().untilEndOfTurn() });
    for (const verb of ["onEveryHit", "onAnyCrit", "onFirstCrit"] as const) {
      same(turn([melee[verb](topple), melee]), turn([melee[verb](prone().untilEndOfTurn(), { save: check }), melee]));
    }
  });

  it("refuses a second gate in the options, damage among its effects, no fail effect, or no check", () => {
    const gated = save(check, { fail: stun });
    expect(() => turn([fist]).onFirstHit(gated, { save: check })).toThrow(/save\(\) value/);
    expect(() => turn([fist]).onFirstHit(gated, { chance: 0.5 })).toThrow(/save\(\) value/);
    expect(() => sword.onEveryHit(gated, { onSave: next })).toThrow(/save\(\) value/);
    // @ts-expect-error damage is not an effect with a lifetime
    expect(() => save(check, { fail: d6 })).toThrow(TypeError);
    expect(() => save(check, { fail: [] })).toThrow(TypeError);
    // No check would drop the save and apply `fail` every time.
    expect(() => save([], { fail: stun })).toThrow(TypeError);
    // @ts-expect-error a plain-JS caller can pass undefined
    expect(() => save(undefined, { fail: stun })).toThrow(TypeError);
  });

  it("is only what save() built: a look-alike object is refused, not run ungated", () => {
    const forged = { kind: "save-gated", check, fail: [], pass: [] } as const;
    expect(() => turn([fist, sword]).onFirstHit(forged).mean()).toThrow();
    expect(() => turn([sword.onEveryHit(forged), sword]).mean()).toThrow();
  });
});
