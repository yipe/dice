// Loads every data module, so their asserts run: hand-built charts must equal the engine, the turn's pieces must add up
// to its DPR, the tree's expected value must equal the engine's mean, and so on. Any mismatch throws, and the check fails.
// (The episodes add a few more asserts of their own; scripts/smoke.mjs catches those when it loads the built page.)
import * as attack from "../src/attackData";
import * as advanced from "../src/advancedData";
import * as stun from "../src/stunData";
import * as d8 from "../src/data8";

const f = (x: number) => x.toFixed(4);
console.log(`one attack at AC 15: ${f(attack.AT_AC.dpr)} DPR`);
console.log(`five independent attacks: ${f(advanced.TURN.independent)}, with Vex: ${f(advanced.TURN.vex)}, with Sneak Attack: ${f(advanced.TURN.full)}`);
console.log(`Stunning Strike, Unarmed Strikes last: ${f(stun.STATS.vexStun.dpr)}, first: ${f(stun.STATS.stunVex.dpr)}`);
console.log(`2d8 + 4 mean: ${d8.CRIT_MEAN}`);
console.log("all data asserts passed");
