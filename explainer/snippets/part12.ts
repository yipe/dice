import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";
import { saveDC, stunned } from "@yipe/dice/dnd5e";

const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4));
const vexSword = shortsword.onEveryHit(advantage().untilNextAttack());
const scimitar = d20.plus(7).ac(15).onHit(d8);
const fist = d20.plus(7).ac(15).onHit(d8.plus(4));
const sneak = (...n: number[]) => ({ of: n.map((i) => `attack ${i}`) });
const stun = (...n: number[]) => ({ of: n.map((i) => `attack ${i}`), save: saveDC(14, { con: 3 }), onSave: advantage().untilNextAttack() });

const normal = turn([shortsword, shortsword, scimitar, fist, fist]).onFirstHit(d6, sneak(1, 2, 3));
const vex = turn([vexSword, vexSword, scimitar, fist, fist]).onFirstHit(d6, sneak(1, 2, 3));
const vexThenStun = vex.onFirstHit(stunned().untilEndOfTurn(), stun(4, 5));
const stunThenVex = turn([fist, fist, vexSword, vexSword, scimitar]).onFirstHit(d6, sneak(3, 4, 5)).onFirstHit(stunned().untilEndOfTurn(), stun(1, 2));

normal.mean();      // 29.7576
vex.mean();         // 32.1409
vexThenStun.mean(); // 33.5367
stunThenVex.mean(); // 35.3698
// at least one crit: a probe sees advantage, toQuery's per-attack singles do not
stunThenVex.observe({ on: "any-crit", id: "crit" }).fireProbability("crit"); // 0.3315
