/**
 * Vitest setup file: while the repo's own test suite runs, records `PMF` method calls (inputs and
 * result) as fixtures for the Rust port. Run via `yarn vitest run -c rust/dice/fixtures/vitest.record.config.ts`,
 * then `node rust/dice/fixtures/merge.mjs`.
 *
 * Each record: {"op", "a"?: receiver, "args": [...], "out"} with values encoded by `enc`:
 * PMF -> {"$pmf": toJSON()}, non-finite or -0 number -> {"$num": "NaN" | "Infinity" | "-Infinity" | "-0"},
 * Map -> {"$map": [[k, v], ...]}, undefined -> {"$undefined": true}, throw -> out {"$error": message}.
 * Calls with a function argument are skipped. Only outermost PMF calls are recorded (a call made
 * inside another recorded PMF method is part of that method's behavior).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll } from "vitest";
import { PMF } from "../../../src/pmf/pmf";
import { DiceQuery } from "../../../src/pmf/query";

const OUT_DIR = new URL("./recorded/", import.meta.url);
const CAP = 300; // per op per test file; merge.mjs dedupes and caps globally

const INSTANCE = [
  "outcomeMass", "normalize", "compact", "mass", "mean", "variance", "stdev", "min", "max", "support",
  "add", "addScaled", "applyHitFrequency", "splitByDealt", "maxOfTwo", "scaleMass", "scaleDamage",
  "fingerprint", "convolve", "convolveRaw", "combineRaw", "prune", "pAt", "hitProbability",
  "missProbability", "rebin", "denseSupport", "cdfAt", "quantile", "outcomeAt", "outcomes",
  "outcomeProbability", "outcomeAttributionAt", "binAt", "hasOutcome", "tailProbGE", "tailProbGT",
  "filterOutcome", "power", "gate", "withAttribution", "hasAttribution", "faceTotal",
  "attributionByValue", "damageAttributionChartModel", "mapValues", "outcomeAttributionAt",
];
const QUERY = [
  "combinedWithAttribution", "attributionByValue", "countSinglesWith", "mean", "variance", "stddev", "stdev",
  "cdf", "probTotalAtMost", "ccdf", "probTotalAtLeast", "percentiles", "min", "max", "probAtLeastK",
  "probAtLeastOne", "probExactlyK", "probAtMostK", "expectedDamageFrom", "damageStatsFrom",
  "combinedDamageStats", "probabilityOf", "missChance", "toChartSeries", "toCDFSeries", "toCCDFSeries",
  "probDamageGreaterThan", "outcomeKeys", "snapshot", "normalize", "compact", "addScaled", "scaleMass",
  "totalMass", "convolve", "firstSuccessSplit",
  "toLabeledTable", "toStackedChartData", "outcomeTotals", "outcomeDamageRanges", "outcomeStats", "scaleDamage",
];
const STATIC = ["firstSuccessWeights", "branch", "withProbability", "exclusive", "mix", "mixN", "delta", "zero", "empty", "missNone", "emptyMass", "convolveMany"];

class Skip extends Error {}

/** `encode` with recording paused: serializing a PMF calls its own (wrapped) methods. */
function enc(v: unknown): unknown {
  state.depth++;
  try {
    return encode(v);
  } finally {
    state.depth--;
  }
}

function encode(v: unknown): unknown {
  // epsilon is not in toJSON() but changes results (e.g. power and convolve default to it).
  if (v instanceof DiceQuery) {
    // Private fields read by name: the recorder rebuilds `new DiceQuery(singles, combined?, eps)`.
    const fields = v as unknown as { _eps: number; _combinedProvided: boolean; _combined?: PMF };
    return {
      $query: {
        singles: v.singles.map(encode),
        eps: encode(fields._eps),
        ...(fields._combinedProvided ? { combined: encode(fields._combined) } : {}),
      },
    };
  }
  if (v instanceof PMF) return { $pmf: { ...v.toJSON(), epsilon: encode(v.epsilon) } };
  if (typeof v === "number") {
    if (Number.isFinite(v) && !Object.is(v, -0)) return v;
    return { $num: Object.is(v, -0) ? "-0" : String(v) };
  }
  if (v === undefined) return { $undefined: true };
  if (typeof v === "function") throw new Skip();
  if (Array.isArray(v)) return v.map(encode);
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encode(k), encode(x)]) };
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}

// The PMF module outlives one test file in a worker while this setup file runs per file: wrap
// once per module, and let each file's run flush to its own `lines`.
const WRAPPED = Symbol.for("rust-dice.record-pmf");
type State = { counts: Map<string, number>; lines: string[]; depth: number; depthByKind: Map<string, number> };
const holder = PMF as unknown as Record<symbol, State | undefined>; // a tag on the class, not a PMF field
const fresh: State = { counts: new Map(), lines: [], depth: 0, depthByKind: new Map() };
const state = holder[WRAPPED] ?? fresh;
const firstWrap = holder[WRAPPED] === undefined;
holder[WRAPPED] = state;
state.counts.clear();
state.lines.length = 0;

type Method = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Wraps `target[name]`. `kind` names the class: an outermost call of that class is recorded even
 * inside a call of another class (a PMF method called by a DiceQuery method is a PMF case).
 * `state.depth` > 0 means a value is being serialized: nothing is recorded then.
 */
function wrap(target: Record<string, unknown>, name: string, isStatic: boolean, kind: "PMF" | "DiceQuery"): void {
  const original = target[name];
  if (typeof original !== "function") throw new Error(`record-pmf: ${kind} ${isStatic ? "static " : ""}${name} is not a function`);
  const call = original as Method; // checked to be a function just above
  const op = kind === "PMF" ? name : `${kind}.${name}`;
  const run = (self: unknown, args: unknown[]): unknown => {
    state.depthByKind.set(kind, (state.depthByKind.get(kind) ?? 0) + 1);
    try {
      return call.apply(self, args);
    } finally {
      state.depthByKind.set(kind, (state.depthByKind.get(kind) ?? 1) - 1);
    }
  };
  target[name] = function (this: unknown, ...args: unknown[]) {
    const take = state.depth === 0 && (state.depthByKind.get(kind) ?? 0) === 0 && (state.counts.get(op) ?? 0) < CAP;
    if (!take) return run(this, args);
    let input: string;
    try {
      input = JSON.stringify({ op, ...(isStatic ? {} : { a: enc(this) }), args: enc(args) });
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      return run(this, args);
    }
    let result: unknown;
    try {
      result = run(this, args);
    } catch (e) {
      state.lines.push(input.slice(0, -1) + `,"out":${JSON.stringify({ $error: (e as Error).message })}}`);
      state.counts.set(op, (state.counts.get(op) ?? 0) + 1);
      throw e;
    }
    try {
      state.lines.push(input.slice(0, -1) + `,"out":${JSON.stringify(enc(result))}}`);
      state.counts.set(op, (state.counts.get(op) ?? 0) + 1);
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
    }
    return result;
  };
}

// PMF's prototype and constructor are patched by name; the names are checked to be functions.
if (firstWrap) for (const name of INSTANCE) wrap(PMF.prototype as unknown as Record<string, unknown>, name, false, "PMF");
if (firstWrap) for (const name of STATIC) wrap(PMF as unknown as Record<string, unknown>, name, true, "PMF");
if (firstWrap) for (const name of QUERY) wrap(DiceQuery.prototype as unknown as Record<string, unknown>, name, false, "DiceQuery");

afterAll(() => {
  const lines = state.lines.splice(0);
  if (lines.length === 0) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(new URL(`${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`, OUT_DIR), lines.join("\n") + "\n");
});
