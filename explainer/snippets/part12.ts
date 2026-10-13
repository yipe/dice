import { d6, d8, d20, turn } from "@yipe/dice/builder";
import { saveDC, stunningStrike, vex } from "@yipe/dice/dnd5e";

const attack = d20.plus(7).ac(15);
const sword = attack.onHit(d8.plus(4)).tagged("finesse");
const vexSword = sword.onEveryHit(vex());
const scimitar = attack.onHit(d8).tagged("finesse");
const fist = attack.onHit(d8.plus(4)).tagged("unarmed");

const sneak = (a: (typeof sword)[]) => turn(a).onFirstHit(d6, { of: "finesse" });
const stun = (t: ReturnType<typeof sneak>) => t.onFirstHit(stunningStrike(saveDC(14, { con: +3 })), { of: "unarmed" });

const normal = sneak([sword, sword, scimitar, fist, fist]);
const vexed = sneak([vexSword, vexSword, scimitar, fist, fist]);
const fistsFirst = sneak([fist, fist, vexSword, vexSword, scimitar]);

normal.mean();           // 29.7576
vexed.mean();            // 32.1409
stun(vexed).mean();      // 33.5367
stun(fistsFirst).mean(); // 35.3698
