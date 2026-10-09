// Conditions: what the target has, and what it gets. The same turns are pinned to the
// brute-force oracle in src/builder/example.test.ts; docs/guide.md has the prose.
import { advantage, d20, d4, d6, d8, flat, roll, savePenalty, turn, vulnerability } from "../src/builder";
import { contestLossChance, prone, restrained, saveDC, stunned, unconscious } from "../src/dnd5e";

const sword = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));
const fist = d20.plus(8).ac(16).onHit(d6.plus(4));
const show = (label: string, value: number) => console.log(`${label.padEnd(48)} ${value.toFixed(4)}`);

// Vex: a hit gives the next attack advantage.
show("Vex: mean", turn([sword.onEveryHit(advantage().untilNextAttack()), sword]).mean());

// Topple: a toppling hit may knock the target Prone (CON save). Prone helps the swords after it and
// costs the bow, so the player topples with the first sword and not with the third.
const topple = (optional: boolean) =>
  sword.onEveryHit(prone().untilEndOfTurn(), { save: saveDC(15, { con: 3 }), ...(optional ? { optional: true as const } : {}) });
show("Topple (optional): mean", turn([topple(true), sword, topple(true), bow]).mean());
show("Topple (every time): mean", turn([topple(false), sword, topple(false), bow]).mean());

// 2024 Stunning Strike: once a turn, a failed save stuns; a pass still gives the next attack advantage.
const monk = turn([fist, fist, fist]).onFirstHit(stunned().untilEndOfTurn(), {
  id: "stun", save: saveDC(15, { con: 2 }), onSave: advantage().untilNextAttack(),
});
show("Stunning Strike: mean", monk.mean());
show("Stunning Strike: P(stun read by a later fist)", monk.fireProbability("stun"));
show("Stunning Strike: P(fist 3 has advantage)", monk.stepStats("attack 3").live.advantage);

// 2024 Grappler: the target saves with STR or DEX, whichever it passes more often.
const saves = saveDC(15, { str: 5, dex: 1 });
show("Grappler (2024): mean", turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), { save: saves }).mean());

// 2014 shove: an Athletics contest (+5 against +7; ties go to the defender) replaces the first attack and
// knocks the target Prone, so the melee attack after it has advantage. (A 2014 grapple gives no advantage.)
const shove = d20.alwaysHits().melee().onHit(flat(0))
  .onEveryHit(prone().untilEndOfTurn(), { chance: contestLossChance({ attacker: 5, defender: 7 }) });
show("Shove to Prone (2014), then a sword: mean", turn([shove, sword]).mean());

// Cunning Strike (Knock Out): on the hit that carries Sneak Attack, a CON save or Unconscious until damaged.
const rogue = turn([sword, sword, sword])
  .onFirstHit(roll(3, d6), { id: "sneak" })
  .onFirstHit(unconscious().untilDamaged(), { of: ["sneak"], save: saveDC(15, { con: 2 }) });
show("Knock Out: mean", rogue.mean());

// Cold Caster's Frostbite: once a turn, a cold hit takes 1d4 off the target's next save. `typed()`
// says the ray's whole damage is cold. Read the marginal or the mean: the joint pmf of a turn
// using `dealing` throws `dealing-joint-unsupported`.
const ray = d20.plus(7).ac(16).onHit(roll(2, d8)).typed("cold");
const breath = d20.plus(5).dc(15).ability("dex").onSaveFailure(roll(4, d6)).saveHalf();
const caster = turn().attack(ray, "ray").attack(breath, "breath")
  .onFirstHit(savePenalty(d4).untilNextSave(), { of: ["ray"], dealing: "cold" });
show("Frostbite: breath save's mean damage", caster.marginal("breath").pmf.mean());

// 2014 Path to the Grave: the cursed creature is vulnerable to the next hit's whole damage.
show("Path to the Grave: mean", turn([sword, sword]).atStart(vulnerability().untilNextHit()).mean());

// The target starts the turn Restrained; a second creature has its own state.
const restrainedTurn = turn().attacks(2, sword).attack(sword, { target: "second" }).atStart(restrained());
show("Starts Restrained, third attack elsewhere: mean", restrainedTurn.mean());
