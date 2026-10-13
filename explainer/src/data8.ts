import { parse } from "@yipe/dice";
import { DAMAGE } from "./attackData";

// Parts 1-2: the monk's Martial Arts die (d8) and two of them (a crit). Numbers come from @yipe/dice.
export const SIDES = 8;
const d8 = parse("1d8");
const twoD8 = parse("2d8");

export const FACES = Array.from({ length: SIDES }, (_, i) => i + 1);
export const FACE_P = FACES.map((f) => d8.pAt(f)); // each 1/8
export const SUMS = Array.from({ length: 2 * SIDES - 1 }, (_, i) => i + 2); // 2..16
export const SUM_P = SUMS.map((s) => twoD8.pAt(s));
export const PAIR_COUNT = SIDES * SIDES; // 64
export const SUM_WAYS = SUM_P.map((p) => Math.round(p * PAIR_COUNT));
export const MEAN = twoD8.mean(); // 9
export const PAIRS = FACES.flatMap((a) => FACES.map((b) => ({ a, b, sum: a + b })));
// a crit adds the damage modifier once: 2d8 + 4 is the same triangle, shifted right by 4
export const MOD = DAMAGE.dex;
const crit = parse(`2d8 + ${MOD}`);
export const CRIT_MEAN = crit.mean(); // 13
if (SUMS.some((s, i) => Math.abs(crit.pAt(s + MOD) - SUM_P[i]) > 1e-12)) throw new Error("2d8 + mod must be 2d8 shifted");
export const ROLL_1 = 5;
export const ROLL_2 = 4;

if (SUM_WAYS.reduce((a, b) => a + b, 0) !== PAIR_COUNT) throw new Error("2d8 ways must total 64");
if (FACE_P.some((p) => Math.abs(p - 1 / SIDES) > 1e-12)) throw new Error("d8 must be uniform");

// colour by distance from the peak: equally likely totals share a colour (midnight chart palette)
const RAMP = ["#ffc078", "#ffe889", "#87dda8", "#06a6bd", "#6e9bc6", "#4a6fa5", "#3a5070", "#2b3f62"];
export const sumColor = (s: number) => RAMP[Math.abs(s - (SIDES + 1))];
