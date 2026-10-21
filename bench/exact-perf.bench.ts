/**
 * Hot paths behind the build-guide optimizer: cache hits on freshly built builders (cache-key
 * serialization, LRU reads), `PMF.mix` of labelled context PMFs, and a Turn's marginal readers.
 * Run with `yarn bench`.
 */
import { bench, describe } from "vitest";
import { advantage, d20, d6, d8, roll, turn } from "../src/builder";
import { PMF, type Bin } from "../src/pmf/pmf";

/** ~40 bins, each carrying count and attr labels. */
const labelled = (seed: number): PMF => {
  const map = new Map<number, Bin>();
  for (let d = -3; d < 37; d++) {
    const p = (1 + ((d * 7 + seed * 13) % 11)) / 440;
    map.set(d, { p, count: { hit: p * 0.75, crit: p * 0.25 }, attr: { hit: d * p * 0.75, crit: d * p * 0.25 } });
  }
  return new PMF(map, 0, false);
};
const contexts = (n: number) => Array.from({ length: n }, (_, i) => ({ pmf: labelled(i), weight: (i + 1) / (n * (n + 1)) * 2 }));
const mix4 = contexts(4);
const mix8 = contexts(8);

const attack = (): ReturnType<typeof d20.plus> => d20.plus(8);
const sword = () => attack().ac(16).onHit(d8.plus(4));
const vex = () => sword().onEveryHit(advantage().untilNextAttack());

// Warm the caches so the timed loops measure hits.
roll(2, d6).plus(4).toPMF();
roll(4, d6).reroll(2).toPMF();
roll(2, d6).plus(roll(1, d8)).plus(3).toPMF();
sword().toPMF(0);

describe("fresh builder, cached PMF", () => {
  bench("RollBuilder 2d6+4", () => {
    roll(2, d6).plus(4).toPMF();
  });
  bench("RollBuilder 4d6 reroll 2", () => {
    roll(4, d6).reroll(2).toPMF();
  });
  bench("RollBuilder multi-config", () => {
    roll(2, d6).plus(roll(1, d8)).plus(3).toPMF();
  });
  bench("AttackBuilder.toPMF(0)", () => {
    sword().toPMF(0);
  });
});

describe("PMF.mix", () => {
  bench("4 contexts x ~40 bins", () => {
    PMF.mix(mix4, 0);
  });
  bench("8 contexts x ~40 bins", () => {
    PMF.mix(mix8, 0);
  });
});

describe("Turn marginals, fresh turn", () => {
  bench("vex + sneak rider, every marginal", () => {
    const t = turn([vex(), sword()]).onFirstHit(roll(3, d6), { id: "sneak" });
    for (const id of [...t.attackIds, ...t.riderIds]) t.marginal(id);
  });
});
