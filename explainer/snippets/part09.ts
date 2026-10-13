import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";

const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4)).onEveryHit(advantage().untilNextAttack());
const scimitar = d20.plus(7).ac(15).onHit(d8);
const fist = d20.plus(7).ac(15).onHit(d8.plus(4));

// Sneak Attack: once per turn, on the first finesse-weapon hit (an ally is next to the target)
const monkRogue = turn([shortsword, shortsword, scimitar, fist, fist])
  .onFirstHit(d6, { of: ["attack 1", "attack 2", "attack 3"], id: "sneak" });
monkRogue.fireProbability("sneak"); // 0.9571
monkRogue.mean();                   // 32.1409
