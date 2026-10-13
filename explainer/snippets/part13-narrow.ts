import {
  d6, d8, d20, turn,
} from "@yipe/dice/builder";
import {
  saveDC, stunningStrike, vex,
} from "@yipe/dice/dnd5e";

// +3 proficiency, +4 Dex
const attack = d20.plus(7).ac(15);

const shortsword = attack
  .onHit(d8.plus(4))
  .tagged("finesse")
  .onEveryHit(vex());
// Nick: no Dex mod
const scimitar = attack
  .onHit(d8)
  .tagged("finesse");
const fist = attack
  .onHit(d8.plus(4))
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
