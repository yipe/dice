// Merges recorded/*.jsonl into recorded.jsonl: dedupes identical inputs, caps each op at CAP
// cases, and drops the per-worker files. Run from anywhere: node rust/dice/fixtures/merge.mjs
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const CAP = 400;
const dir = new URL("./recorded/", import.meta.url);
const seen = new Set();
const perOp = new Map();
const out = [];
for (const f of readdirSync(dir).sort()) {
  for (const line of readFileSync(new URL(f, dir), "utf8").split("\n")) {
    if (!line) continue;
    const c = JSON.parse(line);
    const key = JSON.stringify([c.op, c.a, c.args]);
    if (seen.has(key) || (perOp.get(c.op) ?? 0) >= CAP) continue;
    seen.add(key);
    perOp.set(c.op, (perOp.get(c.op) ?? 0) + 1);
    out.push(line);
  }
}
writeFileSync(new URL("./recorded.jsonl", import.meta.url), out.join("\n") + "\n");
rmSync(dir, { recursive: true });
console.log(`${out.length} cases`);
for (const [op, n] of [...perOp].sort()) console.log(op.padEnd(22), n);
