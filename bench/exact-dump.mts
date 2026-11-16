/** Dumps N random first-miss-reroll turns as exact bits. Run in two builds and `diff`: `npx tsx bench/exact-dump.mts 300 > out.txt` */
import { dumpTurn, randomCase } from "../tests/helpers/exactDump";

const n = Number(process.argv[2] ?? 300);
for (let seed = 1; seed <= n; seed++) {
  const c = randomCase(seed);
  console.log(`== ${c.name}`);
  // Twice: the second build's rows are new objects of equal content (a warm cache in the cached build).
  for (const line of dumpTurn(c.build())) console.log(line);
  for (const line of dumpTurn(c.build())) console.log(line);
}
