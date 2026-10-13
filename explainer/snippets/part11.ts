import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";
import { saveDC, stunned } from "@yipe/dice/dnd5e";

const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4)).onEveryHit(advantage().untilNextAttack());
const scimitar = d20.plus(7).ac(15).onHit(d8);
const fist = d20.plus(7).ac(15).onHit(d8.plus(4));

// Same attacks, Unarmed Strikes first: the stun can now help the weapon attacks
const stunFirst = turn([fist, fist, shortsword, shortsword, scimitar])
  .onFirstHit(stunned().untilEndOfTurn(), {
    of: ["attack 1", "attack 2"], id: "stun",
    save: saveDC(14, { con: 3 }), onSave: advantage().untilNextAttack(),
  })
  .onFirstHit(d6, { of: ["attack 3", "attack 4", "attack 5"], id: "sneak" });
stunFirst.fireProbability("stun");  // 0.4388
stunFirst.fireProbability("sneak"); // 0.9783
stunFirst.mean();                   // 35.3698
