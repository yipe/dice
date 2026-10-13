import { d20, d8, turn } from "@yipe/dice/builder";

const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4));
const scimitar = d20.plus(7).ac(15).onHit(d8);     // the extra Light attack adds no Dexterity
const fist = d20.plus(7).ac(15).onHit(d8.plus(4)); // Unarmed Strike (Flurry of Blows), Martial Arts d8

// no weapon masteries yet: each attack rolls on its own
const fiveAttacks = turn([shortsword, shortsword, scimitar, fist, fist]);
fiveAttacks.mean(); // 26.15, the five averages added
