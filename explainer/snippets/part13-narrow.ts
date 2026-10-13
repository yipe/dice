import {
  d6, d8, d20, turn,
} from "@yipe/dice/builder";
import {
  saveDC, stunningStrike, vex,
} from "@yipe/dice/dnd5e";

const pb = 3;
const mod = 4;
const monkDie = d8;
const attack = d20.plus(pb + mod).ac(15);

const shortsword = attack
  .onHit(monkDie.plus(mod))
  .tagged("finesse")
  .onEveryHit(vex());
// Nick: no Dex mod
const scimitar = attack
  .onHit(monkDie)
  .tagged("finesse");
const fist = attack
  .onHit(monkDie.plus(mod))
  .tagged("unarmed");

turn([
  fist, fist,
  shortsword, shortsword, scimitar,
])
  // Sneak Attack
  .onFirstHit(d6, { of: "finesse" })
  // Stunning Strike
  .onFirstHit(
    stunningStrike(saveDC(14, { con: +3 })),
    { of: "unarmed" },
  )
  .mean(); // 35.3698
