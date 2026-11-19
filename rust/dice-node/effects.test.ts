import { describe, expect, it } from "vitest";
import { d, d20, roll } from "../../src/builder";
import {
  advantage,
  condition,
  critOnHit,
  disadvantage,
  effectSpec,
  gateFields,
  grantSaveSpec,
  grantSpec,
  isDCCheck,
  isGrant,
  isSaveGated,
  isTransform,
  keepBestDamage,
  lastingForTurn,
  save,
  saveDisadvantage,
  savePenalty,
  substituteFields,
  unpackSave,
  vulnerability,
} from "../../src/turn/effects";
import { TurnSpecError } from "../../src/turn/types";

/** Runs under both configs (`yarn vitest run` and `-c rust/dice-node/vitest.rust.config.ts`): same results. */
describe("turn effects", () => {
  it("modifiers and grants", () => {
    expect(grantSpec(advantage().untilNextAttack())).toEqual({ advantage: true, until: "next-attack" });
    expect(grantSpec(critOnHit().disadvantage().advantage().untilEndOfTurn())).toEqual({
      advantage: true,
      disadvantage: true,
      critOnHit: true,
      until: "end-of-turn",
    });
    const grant = disadvantage().untilEndOfTurn();
    expect(grantSpec(grant.to("a", "b"))).toEqual({ disadvantage: true, until: "end-of-turn", to: ["a", "b"] });
    expect(grantSpec(grant)).toEqual({ disadvantage: true, until: "end-of-turn" });
    expect(isGrant(grant)).toBe(true);
    expect(isGrant({ kind: "grant" })).toBe(false);
    expect(lastingForTurn(advantage())).toEqual(advantage().untilEndOfTurn());
    expect(lastingForTurn(grant)).toBe(grant);
  });

  it("conditions, vulnerability, save modifiers", () => {
    const rule = {
      attack: { melee: ["advantage"], ranged: ["disadvantage"] },
      save: { dexterity: ["autoFail"], str: ["saveDisadvantage"] },
      own: { attack: ["disadvantage"] },
      d20Penalty: 2,
      onEnd: { condition: "prone", rule: { attack: { melee: ["advantage"] } } },
    } as const;
    expect(effectSpec(condition("x", rule).untilDamaged())).toEqual({ condition: "x", rule, until: "until-damaged" });
    expect(effectSpec(condition("x", {}).untilEndOfTurn())).toEqual({ condition: "x", rule: {}, until: "end-of-turn" });
    expect(effectSpec(vulnerability().untilNextHit())).toEqual({ vulnerability: true, until: "next-hit" });
    expect(isGrant(vulnerability().untilNextHit())).toBe(true);
    expect(effectSpec(saveDisadvantage().untilNextSave().to("spells"))).toEqual({
      saveDisadvantage: true,
      until: "next-save",
      to: ["spells"],
    });
    expect(effectSpec(savePenalty(d(4)).untilEndOfTurn())).toEqual({ savePenalty: { count: 1, sides: 4 }, until: "end-of-turn" });
    expect(effectSpec(savePenalty(roll(2, d(6))).untilNextSave())).toEqual({ savePenalty: { count: 2, sides: 6 }, until: "next-save" });
    expect(() => savePenalty(d(4).plus(1))).toThrow("savePenalty takes one plain die group");
    expect(() => savePenalty(roll(2, d(4)).plus(d(6)))).toThrow(Error);
    expect(lastingForTurn(saveDisadvantage())).toEqual(saveDisadvantage().untilEndOfTurn());
    expect(effectSpec(lastingForTurn(condition("x", {})))).toEqual({ condition: "x", rule: {}, until: "end-of-turn" });
  });

  it("transforms", () => {
    const t = keepBestDamage();
    expect(isTransform(t)).toBe(true);
    expect(substituteFields(t)).toEqual({ substitute: "reroll-keep-higher" });
    expect(substituteFields(t.ifBelow(10))).toEqual({ substitute: "reroll-keep-higher", policy: { kind: "below", hit: 10, crit: 10 } });
    expect(substituteFields(t.ifBelow({ hit: 10, crit: 18 }))).toEqual({
      substitute: "reroll-keep-higher",
      policy: { kind: "below", hit: 10, crit: 18 },
    });
    expect(() => t.ifBelow(NaN)).toThrow(RangeError);
    expect(() => t.optimally()).toThrow(TurnSpecError);
    expect(() => t.optimally()).toThrow(/optimally\(\) is not supported/);
    expect(isTransform({ kind: "transform" })).toBe(false);
  });

  it("grantSaveSpec", () => {
    const plain = d20.plus(3).dc(15).ability("con");
    expect(isDCCheck(plain)).toBe(true);
    expect(grantSaveSpec(plain)).toEqual({ ability: "constitution", dc: 15, bonus: 3 });
    expect(grantSaveSpec(d20.withAdvantage().plus(3).dc(15))).toEqual({ dc: 15, bonus: 3, rollType: "advantage" });
    const spec = { ability: "wis", dc: 12, bonus: 1 };
    expect(grantSaveSpec(spec)).toBe(spec);
    const odd = d20.plus(3).plus(d(4)).dc(15);
    const fail = grantSaveSpec(odd, 0);
    expect(Object.keys(fail).sort()).toEqual(["failChance"]);
    const context = { rollType: "flat", autoHit: false, critOnHit: false, autoFail: false, vulnerable: false, penaltyDice: [], joined: [] } as const;
    const flat = (fail as { failChance(c: typeof context): number }).failChance(context);
    expect(flat).toBeCloseTo(odd.toPMF(0).pAt(1), 12);
    expect((fail as { failChance(c: typeof context): number }).failChance({ ...context, autoFail: true })).toBeCloseTo(1, 12);
    expect((fail as { failChance(c: typeof context): number }).failChance({ ...context, rollType: "disadvantage" })).toBeGreaterThan(flat);
  });

  it("save() and unpackSave", () => {
    const check = d20.plus(3).dc(14).ability("con");
    const gated = save(check, { fail: advantage().untilNextAttack(), pass: [critOnHit().untilEndOfTurn()] });
    expect(isSaveGated(gated)).toBe(true);
    expect(isSaveGated({ kind: "save-gated" })).toBe(false);
    expect(gated.kind).toBe("save-gated");
    expect(gated.check).toBe(check);
    expect(gated.fail.map(effectSpec)).toEqual([{ advantage: true, until: "next-attack" }]);
    expect(gated.pass).toHaveLength(1);
    expect(Object.isFrozen(gated)).toBe(true);
    const listed = save([check, { dc: 10, bonus: 0 }], { fail: [advantage().untilNextAttack()] });
    expect(listed.check).toHaveLength(2);
    expect(listed.pass).toEqual([]);
    expect(() => save([], { fail: advantage().untilNextAttack() })).toThrow(TypeError);
    expect(() => save(check, { fail: [] })).toThrow(TypeError);
    expect(() => save(check, { fail: { kind: "grant" } as never })).toThrow(TypeError);
    const unpacked = unpackSave(gated, { landing: "fail" as const });
    expect(unpacked.effects).toBe(gated.fail);
    expect(unpacked.options.save).toBe(check);
    expect(unpacked.options.onSave).toBe(gated.pass);
    expect(unpacked.options.landing).toBe("fail");
    expect(() => unpackSave(gated, { chance: 0.5 })).toThrow(/carries its own save/);
    expect(Object.keys(unpackSave(listed, {}).options)).toEqual(["save"]);
  });

  it("gateFields", () => {
    const check = d20.plus(3).dc(14).ability("con");
    const grant = advantage().untilNextAttack();
    expect(gateFields({}, 0)).toEqual({});
    expect(gateFields({ chance: 0.5, onSave: grant, landing: "damage", dealing: "fire", optional: true, targetHas: "prone" }, 0)).toEqual({
      chance: 0.5,
      landing: "damage",
      dealing: "fire",
      onSave: [{ advantage: true, until: "next-attack" }],
      optional: true,
      targetHas: ["prone"],
    });
    expect(gateFields({ save: check }, 0)).toEqual({ save: { ability: "constitution", dc: 14, bonus: 3 } });
    expect(gateFields({ save: [check, { dc: 1, bonus: 2 }] }, 0)).toEqual({
      save: [{ ability: "constitution", dc: 14, bonus: 3 }, { dc: 1, bonus: 2 }],
    });
    expect(() => gateFields({ save: check, chance: 0.1 }, 0)).toThrow("Pass either save or chance");
    expect(() => gateFields({ onSave: grant }, 0)).toThrow("onSave needs a save or a chance");
    expect(() => gateFields({ save: 3 as never }, 0)).toThrow("save must be a DC check");
    expect(() => gateFields({ target: "x" } as never, 0)).toThrow(TurnSpecError);
  });
});
