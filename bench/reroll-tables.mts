/**
 * Micro-benchmark: a first-miss reroll (Heroic Inspiration + 2014 Lucky) over many attack rows, the shape of dprcalc's
 * Human "Resourceful" groups: rows rebuilt per Turn (new builder objects, equal content), read by per-row marginals.
 * Run: npx tsx bench/reroll-tables.mts   (CPU ms per Turn, median of 40)
 */
import { d4, d6, d8, d10, d20, roll, turn } from "../src/builder";

const row = (i: number) =>
  i % 3 === 0
    ? d20.plus(9).withAdvantage().ac(16).threeDiceAdvantage().critOn(19).onHit(roll(1, d8).plus(5))
    : i % 3 === 1
      ? d20.plus(9).ac(16).onHit(roll(1, d10).plus(4))
      : d20.plus(7).plus(1, d4).ac(16).onHit(roll(2, d6).plus(3));
const build = (n: number) =>
  turn(Array.from({ length: n }, (_, i) => row(i)))
    .rerollFirstMiss({ id: "hi" })
    .rerollFirstMiss({ id: "lucky", mode: "add-d20" });
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
for (const n of [1, 4, 10]) {
  const t: number[] = [];
  let check = 0;
  for (let k = 0; k < 43; k++) {
    const s = cpu();
    const x = build(n);
    check = x.attackIds.reduce((a, id) => a + x.marginal(id).pmf.mean(), 0) + (x.fireProbability("hi") ?? 0);
    if (k >= 3) t.push(cpu() - s);
  }
  t.sort((a, b) => a - b);
  console.log(`rows=${n} median ${t[20].toFixed(2)} ms  check=${check}`);
}
