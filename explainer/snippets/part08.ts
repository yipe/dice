import { advantage, d20, d8, turn } from "@yipe/dice/builder";

// add Vex: a shortsword hit grants advantage on your next attack
const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4)).onEveryHit(advantage().untilNextAttack());
const scimitar = d20.plus(7).ac(15).onHit(d8);
const fist = d20.plus(7).ac(15).onHit(d8.plus(4));

const withVex = turn([shortsword, shortsword, scimitar, fist, fist]);
withVex.stepStats("attack 2").live.advantage; // 0.65
withVex.stepStats("attack 3").live.advantage; // 0.7979
withVex.mean();                               // 28.5332, up from 26.15
