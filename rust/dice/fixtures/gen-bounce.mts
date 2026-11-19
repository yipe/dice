// Regenerates fixtures/bounce.jsonl (97 MB, gitignored) from fixtures/bounce-inputs.jsonl (kept):
// runs each recorded call on the TypeScript bounce functions. Run from the repo root:
//   npx -y tsx rust/dice/fixtures/gen-bounce.mts
// Encoding as the recorder writes it: {"fn", "args", "ok"} or {"fn", "args", "error"};
// numbers that are not finite (or -0) as {"$num": "..."}; JS Maps as {"$map": [[k, v], ...]}.
// Sizes above the ADR-007 limits throw "size exceeds limit" here, as the Rust port does.
import { readFileSync, writeFileSync } from "node:fs";
import * as bounce from "../../../src/common/bounce";
import { critProbability } from "../../../src/common/types";

const LIMIT = 10_000;
const FACE_WEIGHTS_LIMIT = 10_000_000;
const guard = (limit: number, ...values: unknown[]) => {
  for (const v of values) if (typeof v === "number" && Math.abs(v) > limit) throw new RangeError("size exceeds limit");
};
type Fn = (...a: never[]) => unknown;
const fns: Record<string, (args: unknown[]) => unknown> = {
  faceWeights: (a) => (guard(FACE_WEIGHTS_LIMIT, a[0]), (bounce.faceWeights as Fn)(...(a as never[]))),
  calculateBounceOdds: (a) => (guard(LIMIT, a[0], a[1]), (bounce.calculateBounceOdds as Fn)(...(a as never[]))),
  diceSumDistribution: (a) => (guard(LIMIT, a[0]), (bounce.diceSumDistribution as Fn)(...(a as never[]))),
  jointSumAndMatch: (a) => (guard(LIMIT, a[0]), (bounce.jointSumAndMatch as Fn)(...(a as never[]))),
  explodingPoolMatchProbability: (a) => (guard(LIMIT, a[1], a[2]), (bounce.explodingPoolMatchProbability as Fn)(...(a as never[]))),
  critProbability: (a) => (critProbability as Fn)(...(a as never[])),
};

const decode = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(decode)
  : v !== null && typeof v === "object" && "$num" in v ? Number(v.$num)
  : v !== null && typeof v === "object" && "$undefined" in v ? undefined
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]))
  : v;
const encode = (v: unknown): unknown =>
  typeof v === "number" ? (Number.isFinite(v) && !Object.is(v, -0) ? v : { $num: Object.is(v, -0) ? "-0" : String(v) })
  : v instanceof Map ? { $map: [...v].map(([k, x]) => [encode(k), encode(x)]) }
  : Array.isArray(v) ? v.map(encode)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]))
  : v;

const out: string[] = [];
for (const line of readFileSync(new URL("./bounce-inputs.jsonl", import.meta.url), "utf8").split("\n")) {
  if (!line) continue;
  const { fn, args } = JSON.parse(line) as { fn: string; args: unknown[] };
  const call = fns[fn];
  if (!call) throw new Error(`gen-bounce: unknown fn ${fn}`);
  let rec: Record<string, unknown>;
  try {
    rec = { fn, args, ok: encode(call(decode(args) as unknown[])) };
  } catch (e) {
    rec = { fn, args, error: (e as Error).message };
  }
  out.push(JSON.stringify(rec));
}
writeFileSync(new URL("./bounce.jsonl", import.meta.url), out.join("\n") + "\n");
console.log(`wrote ${out.length} cases`);
