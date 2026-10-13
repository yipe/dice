import {
  d6, d8, d20, turn,
} from "@yipe/dice/builder";
import {
  saveDC, stunningStrike, vex,
} from "@yipe/dice/dnd5e";

const attack = d20.plus(7).ac(15);
const hit = attack.onHit(d8.plus(4));
const sword = hit.tagged("finesse");
const vexSword = sword.onEveryHit(vex());
const scimitar = attack
  .onHit(d8)
  .tagged("finesse");
const fist = hit.tagged("unarmed");

const action = [sword, sword, scimitar];
const vexAction = [
  vexSword, vexSword, scimitar,
];
const flurry = [fist, fist];

const sneak = [
  d6, { of: "finesse" },
] as const;
const stun = [
  stunningStrike(saveDC(14, { con: +3 })),
  { of: "unarmed" },
] as const;

const normal = turn([...action, ...flurry]);
const vexed = turn([...vexAction, ...flurry]);
const flurryFirst = turn([
  ...flurry, ...vexAction,
]);

normal.onFirstHit(...sneak).mean(); // 29.7576
vexed.onFirstHit(...sneak).mean(); // 32.1409
vexed.onFirstHit(...sneak)
  .onFirstHit(...stun).mean(); // 33.5367
flurryFirst.onFirstHit(...sneak)
  .onFirstHit(...stun).mean(); // 35.3698
