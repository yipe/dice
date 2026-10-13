import { d6, d8, d20, turn } from "@yipe/dice/builder";
import { saveDC, stunningStrike, vex } from "@yipe/dice/dnd5e";

const attack = d20.plus(7).ac(15);
const sword = attack.onHit(d8.plus(4)).tagged("finesse");
const vexSword = sword.onEveryHit(vex());
const scimitar = attack.onHit(d8).tagged("finesse");
const fist = attack.onHit(d8.plus(4)).tagged("unarmed");

const sneak = [d6, { of: "finesse" }] as const;                                     // Sneak Attack
const stun = [stunningStrike(saveDC(14, { con: +3 })), { of: "unarmed" }] as const; // Stunning Strike

turn([sword, sword, scimitar, fist, fist]).onFirstHit(...sneak).mean();                           // 29.7576
turn([vexSword, vexSword, scimitar, fist, fist]).onFirstHit(...sneak).mean();                     // 32.1409
turn([vexSword, vexSword, scimitar, fist, fist]).onFirstHit(...sneak).onFirstHit(...stun).mean(); // 33.5367
turn([fist, fist, vexSword, vexSword, scimitar]).onFirstHit(...sneak).onFirstHit(...stun).mean(); // 35.3698
