import { d20, d8 } from "@yipe/dice/builder";

const shortsword = (ac: number) => d20.plus(7).ac(ac).onHit(d8.plus(4));

const q = shortsword(15).toQuery();
q.expectedDamageFrom("hit");  // 5.1
q.expectedDamageFrom("crit"); // 0.65
shortsword(15).mean();        // 5.75
shortsword(25).mean();        // 1.5, needs 18 or more
