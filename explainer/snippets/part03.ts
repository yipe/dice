import { d20, d8 } from "@yipe/dice/builder";

// Dexterity +4, proficiency +3, against AC 15
const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4));
const q = shortsword.toQuery();
q.probAtLeastOne(["hit", "crit"]); // 0.65
q.probAtLeastOne("crit");          // 0.05
