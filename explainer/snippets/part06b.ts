import { d20, d8 } from "@yipe/dice/builder";

const shortsword = d20.plus(7).ac(15).onHit(d8.plus(4));

// every pair of results: chances multiplied, damage added, poured into buckets by total
const twoSwords = shortsword.pmf.convolve(shortsword.pmf);
twoSwords.pAt(0);  // 0.1225, both miss
twoSwords.mean();  // 11.5, the two averages added
