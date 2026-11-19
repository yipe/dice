// Parser fixtures from the test suite's own inputs. The parser's API is module functions (not
// patchable like class methods), and pure in its string argument, so instead of recording calls
// this harvests every string literal in the repo's test files, runs the TypeScript parser on each,
// and records the result or the error. Run from the repo root:
//   npx -y tsx rust/dice/fixtures/gen-parser.mts
// Output: fixtures/parser.jsonl, one {"op", "args", "out"} per line, values encoded as in
// record-pmf.ts ({"$pmf"}, {"$num"}, out {"$error"}).
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../../../src/parser/parser";
import { tryParse, withRollType } from "../../../src/parser/rollType";
import { scaleParsedDice } from "../../../src/parser/scaleDice";
import type { PMF } from "../../../src/pmf/pmf";

const ROOT = new URL("../../../", import.meta.url).pathname;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(name) ? [path] : [];
  });
}

// Double-, single- and backtick-quoted literals without interpolation.
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g;
const literals = new Set<string>();
for (const file of [...testFiles(join(ROOT, "src")), ...testFiles(join(ROOT, "tests"))]) {
  for (const m of readFileSync(file, "utf8").matchAll(LITERAL)) {
    const raw = m[1] ?? m[2] ?? m[3];
    let text: string;
    try {
      text = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
    } catch {
      continue;
    }
    // Something the parser could plausibly be handed: has a die or a digit, and is short.
    if (text.length > 0 && text.length <= 200 && /\d|d/i.test(text)) literals.add(text);
  }
}

// Semantic traps no test may spell out (ADR-014): case, whitespace, unicode, odd numbers.
for (const t of [
  "", " ", "D6", " 2 D 6 + 3 ", "1d6\t+\n1", "d20", "0d6", "-1d6", "1d0", "1d1", "100d1",
  "1d6+", "+1d6", "1d6--2", "((1d6))", "(1d6", "1d6)", "1d６", "１d6", "1d6 + 🎲", "1.5d6", "1d6.5",
  "1e3", "2^3", "1d6/2", "1d6*2", "9007199254740993", "1d6 crit", "(d20 + 5 AC 15) * (1d6) crit",
]) literals.add(t);

const num = (v: number) => (Number.isFinite(v) && !Object.is(v, -0) ? v : { $num: Object.is(v, -0) ? "-0" : String(v) });
const encPmf = (p: PMF) => ({ $pmf: { ...p.toJSON(), epsilon: num(p.epsilon) } });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const lines: string[] = [];
const record = (op: string, args: unknown[], fn: () => unknown, enc: (v: never) => unknown) => {
  let out: unknown;
  try {
    out = enc(fn() as never);
  } catch (e) {
    out = { $error: errorText(e) };
  }
  lines.push(JSON.stringify({ op, args, out }));
};

let parsed = 0;
for (const text of [...literals].sort()) {
  let ok = true;
  try {
    parse(text);
  } catch {
    ok = false;
  }
  if (ok) parsed++;
  record("parse", [text], () => parse(text), encPmf);
  if (ok) {
    record("parse", [text, 1], () => parse(text, 1), encPmf);
    record("tryParse", [text], () => tryParse(text), encPmf);
    for (const rt of ["flat", "advantage", "disadvantage", "elven accuracy"] as const) {
      record("withRollType", [text, rt], () => withRollType(text, rt), (s: string) => s);
    }
    for (const scale of [0, 1, 2, 3]) {
      record("scaleParsedDice", [text, scale], () => scaleParsedDice(text, scale), (s: string) => s);
    }
  } else {
    record("tryParse", [text], () => tryParse(text), encPmf);
  }
}
writeFileSync(new URL("./parser.jsonl", import.meta.url), lines.join("\n") + "\n");
console.log(`${literals.size} literals, ${parsed} parse, ${lines.length} cases`);
