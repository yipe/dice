import { describe, expect, it } from "vitest";
import { EPS } from "../common/types";
import type { PMF } from "../pmf/pmf";
import type { RowCheck, RowContext } from "../turn/types";
import { bits, pmfBits } from "../../tests/fixtures/save-half-cases";
import * as examples from "./example";
import { AttackBuilder, combine, d20, d4, d6, d8, d10, d12, flat, roll, SaveBuilder } from "./index";
import type { Check, RollBuilder, RollType } from "./index";

const PLAIN: RowContext = {
  rollType: "flat",
  autoHit: false,
  critOnHit: false,
  autoFail: false,
  vulnerable: false,
  penaltyDice: [],
  joined: [],
};
const ctx = (fields: Partial<RowContext>): RowContext => ({ ...PLAIN, ...fields });

const ATTACK: RowCheck = {
  kind: "attack",
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
};
const SAVE: RowCheck = { ...ATTACK, kind: "save" };

const hit = roll(2, d6).plus(3);

describe("row facts: each verb's RowCheck", () => {
  const cases: [string, { rowCheck: RowCheck }, RowCheck][] = [
    ["plain attack", d20.plus(5).ac(15).onHit(hit), ATTACK],
    ["ACBuilder.ranged()", d20.plus(5).ac(15).ranged().onHit(hit), { ...ATTACK, range: "ranged" }],
    ["ACBuilder.melee()", d20.plus(5).ac(15).melee().onHit(hit), { ...ATTACK, range: "melee" }],
    ["AttackBuilder.ranged()", d20.plus(5).ac(15).onHit(hit).ranged(), { ...ATTACK, range: "ranged" }],
    ["AttackBuilder.melee()", d20.plus(5).ac(15).onHit(hit).melee(), { ...ATTACK, range: "melee" }],
    ["the last range wins", d20.plus(5).ac(15).ranged().onHit(hit).melee(), { ...ATTACK, range: "melee" }],
    ["range survives critOn()", d20.plus(5).ac(15).ranged().critOn(19).onHit(hit), { ...ATTACK, range: "ranged" }],
    [
      "range survives alwaysCrits()",
      d20.plus(5).ac(15).ranged().alwaysCrits().onHit(hit),
      { ...ATTACK, range: "ranged", autoCrit: true },
    ],
    [
      "AlwaysHitBuilder.ranged()",
      d20.plus(5).alwaysHits().ranged().critOn(19).alwaysCrits().onHit(hit),
      { ...ATTACK, range: "ranged", autoHit: true, autoCrit: true },
    ],
    [
      "RollBuilder.pinned() before ac()",
      d20.plus(8).withAdvantage().pinned().ac(16).onHit(hit),
      { ...ATTACK, rollType: "advantage", pinned: true },
    ],
    ["ACBuilder.pinned()", d20.plus(8).ac(16).pinned().onHit(hit), { ...ATTACK, pinned: true }],
    ["AttackBuilder.pinned()", d20.plus(8).ac(16).onHit(hit).pinned(), { ...ATTACK, pinned: true }],
    [
      "AlwaysHitBuilder.pinned()",
      d20.plus(8).alwaysHits().pinned().onHit(hit),
      { ...ATTACK, pinned: true, autoHit: true },
    ],
    [
      "own three dice: withAdvantage() + threeDiceAdvantage()",
      d20.plus(8).withAdvantage().ac(16).threeDiceAdvantage().onHit(hit),
      { ...ATTACK, rollType: "elven accuracy", advantageDice: 3 },
    ],
    [
      "threeDiceAdvantage() alone",
      d20.plus(8).ac(16).threeDiceAdvantage().onHit(hit),
      { ...ATTACK, advantageDice: 3 },
    ],
    [
      "withElvenAccuracy()",
      d20.withElvenAccuracy().plus(8).ac(16).onHit(hit),
      { ...ATTACK, rollType: "elven accuracy", advantageDice: 3 },
    ],
    ["withDisadvantage()", d20.plus(8).withDisadvantage().ac(16).onHit(hit), { ...ATTACK, rollType: "disadvantage" }],
    ["alwaysHits()", d20.plus(5).alwaysHits().onHit(hit), { ...ATTACK, autoHit: true }],
    ["ac().alwaysCrits()", d20.plus(5).ac(15).alwaysCrits().onHit(hit), { ...ATTACK, autoCrit: true }],
    [
      "alwaysHits().alwaysCrits()",
      d20.plus(5).alwaysHits().alwaysCrits().onHit(hit),
      { ...ATTACK, autoHit: true, autoCrit: true },
    ],
    [
      "facts survive withCheck()",
      d20.plus(5).pinned().ac(15).ranged().onHit(hit).withCheck((check) => ({ ...check, ac: 18 })),
      { ...ATTACK, range: "ranged", pinned: true },
    ],
    ["plain save", d20.plus(5).dc(15).onSaveFailure(hit), SAVE],
    ["DCBuilder.ability('con')", d20.plus(5).dc(15).ability("con").onSaveFailure(hit), { ...SAVE, ability: "constitution" }],
    ["DCBuilder.ability(full name)", d20.plus(5).dc(15).ability("wisdom").onSaveFailure(hit), { ...SAVE, ability: "wisdom" }],
    ["SaveBuilder.ability('dex')", d20.plus(5).dc(15).onSaveFailure(hit).saveHalf().ability("dex"), { ...SAVE, ability: "dexterity" }],
    ["DCBuilder.alwaysFails()", d20.plus(5).dc(15).alwaysFails().onSaveFailure(hit), { ...SAVE, autoFail: true }],
    ["SaveBuilder.alwaysFails()", d20.plus(5).dc(15).onSaveFailure(hit).alwaysFails(), { ...SAVE, autoFail: true }],
    ["DCBuilder.pinned()", d20.plus(5).withAdvantage().dc(15).pinned().onSaveFailure(hit), { ...SAVE, rollType: "advantage", pinned: true }],
    ["SaveBuilder.pinned()", d20.plus(5).dc(15).onSaveFailure(hit).pinned(), { ...SAVE, pinned: true }],
    ["save withDisadvantage()", d20.plus(5).withDisadvantage().dc(15).onSaveFailure(hit), { ...SAVE, rollType: "disadvantage" }],
    [
      "save facts survive dc() and add()",
      d20.plus(5).dc(15).ability("str").alwaysFails().pinned().dc(16).add(d4).onSaveFailure(hit),
      { ...SAVE, ability: "strength", autoFail: true, pinned: true },
    ],
  ];

  it.each(cases)("%s", (_name, builder, expected) => {
    expect(builder.rowCheck).toStrictEqual(expected);
  });

  it.each(["s", "CON", "Strength", "constitutionx", "", "luck"])("ability(%j) throws a TypeError naming the value", (name) => {
    const call = () => d20.plus(5).dc(15).ability(name as "con");
    expect(call).toThrow(TypeError);
    expect(call).toThrow(JSON.stringify(name));
  });

  it("pinned() refuses a roll with no die to pin", () => {
    expect(() => flat(5).pinned()).toThrow(/no natural roll/);
  });

  it("verbs are immutable", () => {
    const check = d20.plus(5).ac(15);
    const attack = check.onHit(hit);
    const dc = d20.plus(5).dc(15);
    const save = dc.onSaveFailure(hit);
    const derived = [check.ranged(), check.pinned(), attack.melee(), attack.pinned()];
    const derivedSaves = [dc.ability("con"), dc.alwaysFails(), save.ability("dex"), save.alwaysFails()];
    expect(derived.every((builder) => builder !== check && builder !== attack)).toBe(true);
    expect(derivedSaves.every((builder) => builder !== dc && builder !== save)).toBe(true);
    expect(attack.rowCheck).toStrictEqual(ATTACK);
    expect(save.rowCheck).toStrictEqual(SAVE);
    expect(check.attackConfig.range).toBeUndefined();
    expect(dc.saveAbility).toBeUndefined();
    expect(dc.autoFail).toBe(false);
  });

  it("range, ability and pinned leave the distribution alone", () => {
    const attack = d20.plus(5).ac(15).onHit(hit);
    for (const variant of [attack.ranged(), attack.melee(), attack.pinned(), d20.plus(5).pinned().ac(15).onHit(hit)]) {
      expect(pmfBits(variant.toPMF())).toEqual(pmfBits(attack.toPMF()));
    }
    const save = d20.plus(5).dc(15).onSaveFailure(hit).saveHalf();
    for (const variant of [save.ability("con"), save.pinned()]) {
      expect(pmfBits(variant.toPMF())).toEqual(pmfBits(save.toPMF()));
    }
  });

  it("alwaysFails() is a save that always fails, and has no expression", () => {
    const save = d20.plus(5).dc(15).onSaveFailure(hit).saveHalf();
    const certain = d20.plus(5).dc(1000).onSaveFailure(hit).saveHalf();
    expect(pmfBits(save.alwaysFails().toPMF())).toEqual(pmfBits(certain.toPMF()));
    expect(d20.plus(5).dc(15).alwaysFails().saveProbabilities()).toEqual({ pSuccess: 0, pFail: 1 });
    expect(() => save.alwaysFails().toExpression()).toThrow(/alwaysFails/);
  });
});

describe("under(context): each RowContext field equals the builder re-derived by hand", () => {
  const same = (actual: PMF, expected: PMF) => expect(pmfBits(actual)).toEqual(pmfBits(expected));
  /** The mass `pmf` puts on `label` at each damage value, bit for bit (a bin's `p` also holds other labels). */
  const branch = (pmf: PMF, label: string, scale = 1) =>
    [...pmf]
      .filter(([, bin]) => (bin.count[label] ?? 0) > 0)
      .map(([value, bin]) => [value * scale, bits(bin.count[label] as number)])
      .sort(([a], [b]) => (a as number) - (b as number));
  const sword = d20.plus(5).ac(15).onHit(hit);

  it("the plain context is toPMF(), at any eps", () => {
    same(sword.under(PLAIN), sword.toPMF());
    same(sword.under(PLAIN, 1e-6), sword.toPMF(1e-6));
  });

  it("rollType is taken literally", () => {
    same(sword.under(ctx({ rollType: "advantage" })), d20.plus(5).withAdvantage().ac(15).onHit(hit).toPMF());
    same(sword.under(ctx({ rollType: "disadvantage" })), d20.plus(5).withDisadvantage().ac(15).onHit(hit).toPMF());
    same(
      sword.under(ctx({ rollType: "elven accuracy" })),
      d20.plus(5).withAdvantage().ac(15).threeDiceAdvantage().onHit(hit).toPMF()
    );
    // `advantage` is two dice even for an attacker with three-dice advantage: the turn upgrades it.
    const three = d20.plus(5).ac(15).threeDiceAdvantage().onHit(hit);
    same(three.under(ctx({ rollType: "advantage" })), d20.plus(5).withAdvantage().ac(15).onHit(hit).toPMF());
    // An attacker that rolls with advantage on its own rolls flat when the context says so.
    const own = d20.plus(5).withAdvantage().ac(15).onHit(hit);
    same(own.under(PLAIN), sword.toPMF());
  });

  it("pinned keeps the attack's own roll", () => {
    const pinned = d20.plus(5).withAdvantage().pinned().ac(15).onHit(hit);
    for (const rollType of ["flat", "advantage", "disadvantage", "elven accuracy"] as const) {
      same(pinned.under(ctx({ rollType })), pinned.toPMF());
    }
    same(pinned.under(ctx({ rollType: "disadvantage", critOnHit: true })), d20.plus(5).withAdvantage().ac(15).alwaysCrits().onHit(hit).toPMF());
  });

  it("autoHit is alwaysHits()", () => {
    same(sword.under(ctx({ autoHit: true })), d20.plus(5).alwaysHits().onHit(hit).toPMF());
    const keen = d20.plus(5).ac(15).critOn(19).onHit(hit);
    same(keen.under(ctx({ autoHit: true, rollType: "advantage" })), d20.plus(5).withAdvantage().alwaysHits().critOn(19).onHit(hit).toPMF());
  });

  it("critOnHit is alwaysCrits(): every hit crits, a natural 1 still misses", () => {
    same(sword.under(ctx({ critOnHit: true })), d20.plus(5).ac(15).alwaysCrits().onHit(hit).toPMF());
    expect(sword.under(ctx({ critOnHit: true })).outcomeProbability("missNone")).toBeGreaterThan(0);
    same(sword.under(ctx({ autoHit: true, critOnHit: true })), d20.plus(5).alwaysHits().alwaysCrits().onHit(hit).toPMF());
  });

  it("the attack's own autoHit / autoCrit stay on", () => {
    const always = d20.plus(5).alwaysHits().onHit(hit);
    same(always.under(PLAIN), always.toPMF());
    same(always.under(ctx({ rollType: "advantage" })), d20.plus(5).withAdvantage().alwaysHits().onHit(hit).toPMF());
    const crits = d20.plus(5).ac(15).alwaysCrits().onHit(hit);
    same(crits.under(ctx({ rollType: "advantage" })), d20.plus(5).withAdvantage().ac(15).alwaysCrits().onHit(hit).toPMF());
  });

  it("vulnerable doubles hit and crit damage as a whole roll; a miss is unchanged", () => {
    same(
      sword.under(ctx({ vulnerable: true })),
      d20.plus(5).ac(15).onHit(hit.scaleResult(2)).onCrit(hit.doubleDice().scaleResult(2)).toPMF()
    );
    const grazing = d20.plus(5).ac(15).onHit(hit).halfOnMiss();
    const vulnerable = grazing.under(ctx({ vulnerable: true }));
    expect(branch(vulnerable, "missDamage")).toEqual(branch(grazing.toPMF(), "missDamage"));
    expect(branch(vulnerable, "hit")).toEqual(branch(grazing.toPMF(), "hit", 2));
    expect(branch(vulnerable, "crit")).toEqual(branch(grazing.toPMF(), "crit", 2));
  });

  it("autoFail, penaltyDice and joined do not touch an attack", () => {
    same(sword.under(ctx({ autoFail: true, penaltyDice: [{ count: 1, sides: 4 }], joined: ["sneak"] })), sword.toPMF());
  });

  it("range survives a re-derivation", () => {
    const bow = d20.plus(5).ac(15).ranged().onHit(hit);
    expect(bow.withCheck((check) => ({ ...check, rollType: "advantage" })).rowCheck.range).toBe("ranged");
  });

  const save = d20.plus(5).dc(15).onSaveFailure(roll(4, d6)).saveHalf();

  it("a save: the plain context is toPMF()", () => {
    same(save.under(PLAIN), save.toPMF());
    same(save.under(PLAIN, EPS), save.toPMF(EPS));
  });

  it("a save: rollType is the target's roll", () => {
    same(save.under(ctx({ rollType: "advantage" })), d20.plus(5).withAdvantage().dc(15).onSaveFailure(roll(4, d6)).saveHalf().toPMF());
    same(save.under(ctx({ rollType: "disadvantage" })), d20.plus(5).withDisadvantage().dc(15).onSaveFailure(roll(4, d6)).saveHalf().toPMF());
    expect(() => save.under(ctx({ rollType: "elven accuracy" }))).toThrow(RangeError);
  });

  it("a save: penaltyDice come off the roll", () => {
    same(
      save.under(ctx({ penaltyDice: [{ count: 1, sides: 4 }] })),
      d20.plus(5).minus(1, d4).dc(15).onSaveFailure(roll(4, d6)).saveHalf().toPMF()
    );
    same(
      save.under(ctx({ penaltyDice: [{ count: 1, sides: 4 }, { count: 2, sides: 6 }], rollType: "disadvantage" })),
      d20.plus(5).withDisadvantage().minus(1, d4).minus(2, d6).dc(15).onSaveFailure(roll(4, d6)).saveHalf().toPMF()
    );
  });

  it("a save: autoFail is alwaysFails()", () => {
    same(save.under(ctx({ autoFail: true })), save.alwaysFails().toPMF());
    same(save.under(ctx({ autoFail: true })), d20.plus(5).dc(1000).onSaveFailure(roll(4, d6)).saveHalf().toPMF());
    const fails = save.alwaysFails();
    same(fails.under(ctx({ rollType: "advantage" })), fails.toPMF());
  });

  it("a save: pinned keeps the target's own roll", () => {
    const pinned = save.pinned();
    same(pinned.under(ctx({ rollType: "advantage" })), save.toPMF());
  });

  it("a save: vulnerable doubles the failure damage; the success is unchanged", () => {
    const plain = d20.plus(5).dc(15).onSaveFailure(roll(4, d6));
    same(plain.under(ctx({ vulnerable: true })), d20.plus(5).dc(15).onSaveFailure(roll(4, d6).scaleResult(2)).toPMF());
    const vulnerable = save.under(ctx({ vulnerable: true }));
    expect(branch(vulnerable, "saveHalf")).toEqual(branch(save.toPMF(), "saveHalf"));
    expect(branch(vulnerable, "saveFail")).toEqual(branch(save.toPMF(), "saveFail", 2));
  });

  it("a save: autoHit, critOnHit and joined do not touch it", () => {
    same(save.under(ctx({ autoHit: true, critOnHit: true, joined: ["x"] })), save.toPMF());
  });
});

/**
 * The 0.16 path a `Turn` takes for a source that reads a granted modifier (src/turn/plan.ts,
 * `rederive`): the modifier key's flags combined into the source's own roll type through `withCheck`,
 * and the plain source itself wherever the resolved context equals the plain one.
 */
function rebinding(source: AttackBuilder, advantage: boolean, disadvantage: boolean, critOnHit: boolean, eps: number) {
  let combined!: { rollType: RollType; dice: number };
  let samePlain = false;
  const rederived = source.withCheck((base: Check) => {
    combined = combine(base.rollType, base.advantageDice, { advantage, disadvantage });
    const plain = combine(base.rollType, base.advantageDice, { advantage: false, disadvantage: false });
    const next = { ...base, rollType: combined.rollType, critOnHit: base.critOnHit || critOnHit };
    samePlain = next.rollType === plain.rollType && next.critOnHit === base.critOnHit;
    return next;
  });
  const expected = samePlain ? source.toPMF(eps) : rederived.toPMF(eps);
  // What the walk hands `under`: the combined roll, upgraded to three dice where the attacker has them.
  const rollType: RollType = combined.rollType === "advantage" && combined.dice === 3 ? "elven accuracy" : combined.rollType;
  return { expected, context: ctx({ rollType, critOnHit }) };
}

function expectMatchesRebinding(source: AttackBuilder) {
  for (const eps of [0, EPS]) {
    for (let key = 0; key < 8; key++) {
      const { expected, context } = rebinding(source, (key & 1) !== 0, (key & 2) !== 0, (key & 4) !== 0, eps);
      expect(pmfBits(source.under(context, eps)), `key ${key} eps ${eps}`).toEqual(pmfBits(expected));
    }
  }
}

/** mulberry32: a small seeded generator, so the sweep is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("under(context) is bit-exact with the 0.16 withCheck rebinding", () => {
  const rebindable = Object.entries(examples).filter(
    (entry): entry is [string, AttackBuilder] => entry[1] instanceof AttackBuilder && !entry[1].rowCheck.autoHit
  );
  // Every other example row (saves, attacks with no AC) had no 0.16 rebinding: in its own context it is its toPMF().
  const others = Object.entries(examples).filter(
    (entry): entry is [string, AttackBuilder | SaveBuilder] =>
      (entry[1] instanceof AttackBuilder && entry[1].rowCheck.autoHit) || entry[1] instanceof SaveBuilder
  );

  it("example.ts has rows of both kinds to check", () => {
    expect(rebindable.length).toBeGreaterThanOrEqual(4);
    expect(others.length).toBeGreaterThanOrEqual(2);
  });

  it.each(others)("example %s, its own context", (_name, source) => {
    const own = source.rowCheck;
    for (const eps of [0, EPS]) {
      const context = ctx({ rollType: own.rollType, autoHit: own.autoHit, critOnHit: own.autoCrit, autoFail: own.autoFail });
      expect(pmfBits(source.under(context, eps))).toEqual(pmfBits(source.toPMF(eps)));
    }
  });

  it.each(rebindable)("example %s, every advantage/disadvantage/critOnHit combination", (_name, source) => {
    expectMatchesRebinding(source);
  });

  it("200 seeded random attacks, every combination", () => {
    const random = seeded(0x0b4);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const dice = [d4, d6, d8, d10, d12];
    for (let i = 0; i < 200; i++) {
      let roll20: RollBuilder = d20.plus(pick([-2, 0, 3, 5, 8, 12]));
      if (random() < 0.3) roll20 = random() < 0.5 ? roll20.plus(d4) : roll20.minus(d4);
      roll20 = pick([
        (r: RollBuilder) => r,
        (r: RollBuilder) => r.withAdvantage(),
        (r: RollBuilder) => r.withDisadvantage(),
        (r: RollBuilder) => r.withElvenAccuracy(),
        (r: RollBuilder) => r.reroll(1),
      ])(roll20);
      let check = roll20.ac(pick([10, 13, 15, 17, 20, 22])).critOn(pick([18, 19, 20]));
      if (random() < 0.3) check = check.threeDiceAdvantage();
      if (random() < 0.3) check = random() < 0.5 ? check.ranged() : check.melee();
      const damage = roll(1 + Math.floor(random() * 3), pick(dice)).plus(Math.floor(random() * 6));
      let attack = random() < 0.15 ? check.alwaysCrits().onHit(damage) : check.onHit(damage);
      const shape = random();
      if (shape < 0.15) attack = attack.onCrit(roll(3, pick(dice)));
      else if (shape < 0.25) attack = attack.noCrit();
      const miss = random();
      if (miss < 0.15) attack = attack.halfOnMiss();
      else if (miss < 0.3) attack = attack.onMiss(pick([1, 2, 3]));
      if (random() < 0.2) attack = attack.plusSeparateDamage(roll(1, pick(dice)));
      if (random() < 0.15) attack = attack.rerollDamage(2);
      if (random() < 0.15) attack = attack.minimumDamageDie(2);
      expectMatchesRebinding(attack);
    }
  });
});
