import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";
import { saveDC, stunned } from "@yipe/dice/dnd5e";

// The whole turn: Vex, Nick, Flurry of Blows, Sneak Attack and Stunning Strike
const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4)).onEveryHit(advantage().untilNextAttack()); // Vex
const scimitar = d20.plus(7).ac(15).onHit(d8);
const fist = d20.plus(7).ac(15).onHit(d8.plus(4));

const myTurn = turn([shortsword, shortsword, scimitar, fist, fist])
  .onFirstHit(d6, { of: ["attack 1", "attack 2", "attack 3"] }) // Sneak Attack
  .onFirstHit(stunned().untilEndOfTurn(), {                     // Stunning Strike
    of: ["attack 4", "attack 5"],
    save: saveDC(14, { con: 3 }),
    onSave: advantage().untilNextAttack(),
  });
