// Synthetic DiceQuery cases for methods the test suite never calls (recorded-query.jsonl has none).
// Same encoding as record-pmf.ts. Run from the repo root: npx -y tsx rust/dice/fixtures/gen-query.mts
import { writeFileSync } from "node:fs";
import { parse } from "../../../src/parser/parser";
import { PMF } from "../../../src/pmf/pmf";
import { DiceQuery } from "../../../src/pmf/query";

const num = (v: number) => (Number.isFinite(v) && !Object.is(v, -0) ? v : { $num: Object.is(v, -0) ? "-0" : String(v) });
// Same encoding as record-pmf.ts: Maps (also nested) as {$map}, undefined as {$undefined}.
const enc = (v: unknown): unknown =>
  typeof v === "number" ? num(v) : v === undefined ? { $undefined: true } : Array.isArray(v) ? v.map(enc)
  : v instanceof Map ? { $map: [...v].map(([k, x]) => [enc(k), enc(x)]) }
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;
const encQuery = (q: DiceQuery) => ({ $query: { singles: q.singles.map((p: PMF) => ({ $pmf: { ...p.toJSON(), epsilon: num(p.epsilon) } })), eps: 1e-12 } });

const queries = [
  ["(d20 + 5 AC 15) * (1d8 + 3)"],
  ["(d20 + 5 AC 15) * (1d8 + 3)", "(d20 + 5 AC 15) * (2d6)"],
  ["(d20 + 2 DC 15) * (8d6) save half"],
  ["(d20 + 10 AC 18) * (6d6 + 5) crit (12d6 + 5)", "1d4"],
].map((exprs) => new DiceQuery(exprs.map((e) => parse(e) as PMF)));

const lines: string[] = [];
for (const q of queries) {
  for (const op of ["toCDFSeries", "toCCDFSeries"] as const) {
    lines.push(JSON.stringify({ op: `DiceQuery.${op}`, a: encQuery(q), args: [], out: enc(q[op]()) }));
    for (const pct of [true, false]) lines.push(JSON.stringify({ op: `DiceQuery.${op}`, a: encQuery(q), args: [pct], out: enc(q[op](pct)) }));
  }
  lines.push(JSON.stringify({ op: "DiceQuery.probTotalAtMost", a: encQuery(q), args: [10], out: enc(q.probTotalAtMost(10)) }));
  // Methods the test suite barely calls (recorded-gaps.jsonl has few cases).
  const keys = q.outcomeKeys();
  const encMap = (m: Map<unknown, unknown>) => ({ $map: [...m].map(([k, v]) => [k, enc(v)]) });
  const encNested = (m: Map<string, Map<number, number>>) => ({ $map: [...m].map(([k, v]) => [k, encMap(v)]) });
  const add = (op: string, args: unknown[], out: unknown) => lines.push(JSON.stringify({ op: `DiceQuery.${op}`, a: encQuery(q), args, out }));
  for (const labels of [[], keys, ["hit"], ["crit", "hit", "missNone"]]) {
    add("toLabeledTable", [labels], enc(q.toLabeledTable(labels as never)));
    add("toStackedChartData", [labels], enc(q.toStackedChartData(labels as never)));
  }
  add("outcomeTotals", [], encMap(q.outcomeTotals()));
  add("outcomeTotals", [["hit", "crit"]], encMap(q.outcomeTotals(["hit", "crit"] as never)));
  add("outcomeDamageRanges", [], encMap(q.outcomeDamageRanges()));
  add("outcomeStats", [], encMap(q.outcomeStats()));
  add("outcomeStats", [keys], encMap(q.outcomeStats(keys)));
  for (const [f, r, d] of [[0.5, "floor", 1], [0.5, "round", 1], [0.5, "ceil", 1], [1.5, "round", 1], [1, "floor", 3]] as const) {
    add("scaleDamage", [f, r, d], encQuery(q.scaleDamage(f, r, d)));
  }
  add("attributionByValue", [], encNested(q.attributionByValue()));
  const p = q.combined;
  const encP = { $pmf: { ...p.toJSON(), epsilon: num(p.epsilon) } };
  lines.push(JSON.stringify({ op: "attributionByValue", a: encP, args: [], out: encNested(p.attributionByValue()) }));
  for (const options of [{}, { maxBuckets: 5 }, { stackOrder: ["crit", "hit"] }, { maxBuckets: 3, epsilon: 1e-3 }]) {
    lines.push(JSON.stringify({ op: "damageAttributionChartModel", a: encP, args: [options], out: enc(p.damageAttributionChartModel(options)) }));
  }
}
for (const [s, sp, n] of [[0.5, 0.05, 1], [0.6, 0.1, 3], [1, 0.2, 2], [0, 0, 4], [0.3, 0.3, 2], [0.5, 0.6, 2], [0.5, 0.05, 0]]) {
  let out: unknown;
  try { out = enc(PMF.firstSuccessWeights(s, sp, n)); } catch (e) { out = { $error: (e as Error).message }; }
  lines.push(JSON.stringify({ op: "firstSuccessWeights", args: [s, sp, n], out }));
}
// Gap methods (ported after the first pass) go to their own file until their replay arms exist.
const GAP = /"op":"(attributionByValue|damageAttributionChartModel|firstSuccessWeights|DiceQuery\.(toLabeledTable|toStackedChartData|outcomeTotals|outcomeDamageRanges|outcomeStats|scaleDamage|attributionByValue))"/;
writeFileSync(new URL("./synthetic-query.jsonl", import.meta.url), lines.filter((l) => !GAP.test(l)).join("\n") + "\n");
writeFileSync(new URL("./synthetic-gaps.jsonl", import.meta.url), lines.filter((l) => GAP.test(l)).join("\n") + "\n");
console.log(`wrote ${lines.length} cases`);
