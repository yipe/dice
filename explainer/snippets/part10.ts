import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";
import { saveDC, stunned } from "@yipe/dice/dnd5e";

const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4)).onEveryHit(advantage().untilNextAttack());
const scimitar = d20.plus(7).ac(15).onHit(d8);
const fist = d20.plus(7).ac(15).onHit(d8.plus(4));

// Stunning Strike on the first Unarmed Strike that hits: fail the save and be stunned, pass and the next attack still has advantage
const stunLast = turn([shortsword, shortsword, scimitar, fist, fist])
  .onFirstHit(d6, { of: ["attack 1", "attack 2", "attack 3"], id: "sneak" })
  .onFirstHit(stunned().untilEndOfTurn(), {
    of: ["attack 4", "attack 5"], id: "stun",
    save: saveDC(14, { con: 3 }), onSave: advantage().untilNextAttack(),
  });
stunLast.stepStats("attack 5").live.advantage; // 0.65
stunLast.fireProbability("stun");              // 0.325
stunLast.mean();                               // 33.5367
