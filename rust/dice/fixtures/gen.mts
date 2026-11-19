// Fixture generator: runs the TypeScript PMF on realistic inputs and writes JSONL cases the Rust
// port must reproduce. Run: npx -y tsx rust/dice/fixtures/gen.mts  (from the repo root).
// Each line: {"op": name, "a": pmfJSON, "b"?: pmfJSON, "x"?: number|string, "out": result}.
// A PMF result is {"pmf": toJSON()}; numbers that are NaN/Infinity are written as strings.
import { writeFileSync } from "node:fs";
import { parse } from "../../../src/parser/parser";
import { PMF } from "../../../src/pmf/pmf";

const exprs = [
  "1d6", "2d6", "1d8 + 4", "4d6", "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)",
  "(d20 > d20 + 8 AC 16) * (2(d6 reroll d2) + 4) crit (4(d6 reroll d2) + 4)",
  "(d20 + 5 AC 15) * (4kh3d6 + 3 > d6 + 2) xcrit19 (8kh6d6 + 2) miss (4)",
  "(d20 + 2 DC 15) * (8d6) save half", "(d20 + 10 AC 18) * (6d6 + 5) crit (12d6 + 5)",
];
const lines: string[] = [];
const pmfs = exprs.map((e) => parse(e) as PMF);

// Hand-built operands for the convolution kernels' edge cases (ADR-014): attr absent vs `{}` vs
// present, zero-valued labels, labels on one side only, negative damage, a single bin, and
// fractional damage (the sparse fallback).
const bins = (rows: Array<[number, Record<string, unknown>]>) => PMF.fromJSON({ bins: rows as never });
const edge: Array<[string, PMF]> = [
  ["noAttr", bins([[0, { p: 0.5, count: { miss: 0.5 } }], [3, { p: 0.5, count: { hit: 0.5 } }]])],
  ["emptyAttr", bins([[1, { p: 0.25, count: { hit: 0.25 }, attr: {} }], [2, { p: 0.75, count: { crit: 0.75 }, attr: {} }]])],
  ["mixedAttr", bins([[0, { p: 0.4, count: { missNone: 0.4 } }], [5, { p: 0.6, count: { hit: 0.6, rider: 0 }, attr: { hit: 3 } }]])],
  ["negative", bins([[-2, { p: 0.3, count: { hit: 0.3 } }], [0, { p: 0.2, count: { miss: 0.2 } }], [4, { p: 0.5, count: { crit: 0.5 }, attr: { crit: 2 } }]])],
  ["single", bins([[7, { p: 1, count: { hit: 1 }, attr: { hit: 7 } }]])],
  ["fractional", bins([[0.5, { p: 0.5, count: { hit: 0.5 } }], [17.875, { p: 0.5, count: { crit: 0.5 } }]])],
];
for (const [, a] of edge) for (const [, b] of edge) {
  lines.push(JSON.stringify({ op: "convolve", a: a.toJSON(), b: b.toJSON(), out: { pmf: a.convolve(b).toJSON() } }));
}
const num = (v: number) => (Number.isFinite(v) ? v : String(v));
// `out` is a thunk so a throw is recorded as {"error": message} instead of aborting.
const emit = (op: string, a: PMF, out: () => unknown, extra: Record<string, unknown> = {}) => {
  let result: unknown;
  try { result = out(); } catch (e) { result = { error: (e as Error).message }; }
  lines.push(JSON.stringify({ op, a: a.toJSON(), ...extra, out: result }));
};
const P = (p: PMF) => ({ pmf: p.toJSON() });

for (const a of pmfs) {
  for (const op of ["mass", "mean", "variance", "stdev", "min", "max", "hitProbability", "missProbability"] as const)
    emit(op, a, () => num((a as any)[op]()));
  emit("support", a, () => a.support());
  emit("fingerprint", a, () => a.fingerprint());
  emit("outcomes", a, () => a.outcomes());
  for (const o of a.outcomes()) emit("outcomeProbability", a, () => num(a.outcomeProbability(o)), { x: o });
  const [lo, hi] = [a.min(), a.max()];
  for (const x of [lo - 1, lo, Math.floor((lo + hi) / 2), hi, hi + 1]) {
    emit("pAt", a, () => num(a.pAt(x)), { x });
    emit("cdfAt", a, () => num(a.cdfAt(x)), { x });
    emit("tailProbGE", a, () => num(a.tailProbGE(x)), { x });
  }
  for (const q of [0, 0.1, 0.5, 0.9, 1]) emit("quantile", a, () => num(a.quantile(q)), { x: q });
  emit("normalize", a, () => P(a.normalize()));
  for (const f of [0, 0.5, 2]) emit("scaleMass", a, () => P(a.scaleMass(f)), { x: f });
  emit("maxOfTwo", a, () => P(a.maxOfTwo()));
  for (const n of [0, 1, 2, 3]) emit("power", a, () => P(a.power(n)), { x: n });
  for (const o of a.outcomes()) emit("filterOutcome", a, () => P(a.filterOutcome(o)), { x: o });
  for (const b of pmfs.slice(0, 5)) {
    emit("convolve", a, () => P(a.convolve(b)), { b: b.toJSON() });
    emit("add", a, () => P(a.add(b)), { b: b.toJSON() });
    emit("addScaled", a, () => P(a.addScaled(b, 0.3)), { b: b.toJSON(), x: 0.3 });
  }
}
writeFileSync(new URL("./cases.jsonl", import.meta.url), lines.join("\n") + "\n");
console.log(`wrote ${lines.length} cases`);
