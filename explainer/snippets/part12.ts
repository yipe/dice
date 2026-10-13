import { d6, d8, d20, turn } from "@yipe/dice/builder";
import { saveDC, stunningStrike, vex } from "@yipe/dice/dnd5e";

const attack = d20.plus(7).ac(15);
const sword = attack.onHit(d8.plus(4)).tagged("finesse");
const vexSword = sword.onEveryHit(vex());
const scimitar = attack.onHit(d8).tagged("finesse");
const fist = attack.onHit(d8.plus(4)).tagged("unarmed");

const sneak = [d6, { of: "finesse" }] as const;
const stun = [stunningStrike(saveDC(14, { con: +3 })), { of: "unarmed" }] as const;

const normal = turn([sword, sword, scimitar, fist, fist]);
const vexed = turn([vexSword, vexSword, scimitar, fist, fist]);
const fistsFirst = turn([fist, fist, vexSword, vexSword, scimitar]);

normal.onFirstHit(...sneak).mean();                         // 29.7576
vexed.onFirstHit(...sneak).mean();                          // 32.1409
vexed.onFirstHit(...sneak).onFirstHit(...stun).mean();      // 33.5367
fistsFirst.onFirstHit(...sneak).onFirstHit(...stun).mean(); // 35.3698
