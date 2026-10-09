/**
 * L0 compat recorder (vitest setup file). Inert unless `COMPAT` is `capture` or `check`.
 *
 * When active it wraps the public readers of `Turn` — the `pmf` getter, `mean()`,
 * `fireProbability(id)`, `expectedApplications(id)`, `stepStats(id)` and `toQuery()` (its `singles`) — and records
 * every outermost call as `{ ordinal, reader, args, value }` under the running test
 * file and test name, with every number as its float64 bit pattern.
 *
 * - `capture`: hands the records to the global teardown, which writes
 *   `tests/compat/fixtures-0.16.json`.
 * - `check`: compares each call to the fixture, bit-exactly on the Node major it was captured
 *   on (see `toleranceFor` for the readers and runtimes compared at 1e-12). A differing or unexpected
 *   call fails its test; a fixture call never reached fails the file. A test file with
 *   no entries in the fixture is not a 0.16 test (or never read a `Turn` under 0.16)
 *   and is skipped entirely: nothing is wrapped, recorded or failed. A test listed in
 *   `tests/compat/retired.json` is no longer required (see `loadRetired`).
 */
import { writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, afterEach, expect, inject } from "vitest";
import {
  loadRetired,
  MODE,
  NODE_MAJOR,
  readFixture,
  ROOT,
  recordsName,
  serializeLeaves,
  serializePMF,
  stableJSON,
  unhex,
  type Entry,
  type Serialized,
  toleranceFor,
  withinTolerance,
} from "./format";
import type { DiceQuery } from "../../src/pmf/query";
import type { StepStats } from "../../src/turn/turn";

if (MODE !== undefined) await install();

async function install(): Promise<void> {
  const testPath = expect.getState().testPath;
  if (testPath === undefined) throw new Error("compat: expect.getState().testPath is undefined");
  const file = relative(ROOT, testPath).split(sep).join("/");

  let expected: Record<string, readonly Entry[]> = {};
  let sameRuntime = true;
  if (MODE === "check") {
    const { capturedOn, files: fixture } = readFixture();
    sameRuntime = capturedOn === NODE_MAJOR;
    const inFixture = fixture[file];
    if (inFixture === undefined) return;
    expected = { ...inFixture };
    for (const [retiredFile, test] of loadRetired(fixture)) if (retiredFile === file) delete expected[test];
  }

  // Loaded only when active, so an ordinary `vitest run` evaluates nothing extra.
  const { Turn } = await import("../../src/turn/turn");

  const recorded: Record<string, Entry[]> = {};
  const failures: Record<string, string[]> = {};
  const unexpected: string[] = [];

  const where = (test: string, ordinal: number, reader: string): string =>
    `${file} > ${JSON.stringify(test)} #${ordinal} ${reader}`;

  const compare = (test: string, entry: Entry): void => {
    const want = expected[test]?.[entry.ordinal];
    if (want === undefined) {
      const message = `${where(test, entry.ordinal, entry.reader)}: no fixture entry`;
      unexpected.push(message);
      (failures[test] ??= []).push(message);
      return;
    }
    if (stableJSON(want) === stableJSON(entry)) return;
    const tolerance = toleranceFor(entry.reader, sameRuntime);
    if (
      tolerance !== undefined &&
      want.reader === entry.reader &&
      stableJSON(want.args) === stableJSON(entry.args) &&
      withinTolerance(want.value, entry.value, tolerance)
    ) {
      return;
    }
    (failures[test] ??= []).push(`${where(test, entry.ordinal, entry.reader)}: ${firstDifference(want, entry)}`);
  };

  const record = (reader: string, args: readonly unknown[], value: Serialized): void => {
    const test = expect.getState().currentTestName ?? "";
    const entries = (recorded[test] ??= []);
    const entry: Entry = { ordinal: entries.length, reader, args: args.map(serializeLeaves), value };
    entries.push(entry);
    if (MODE === "check") compare(test, entry);
  };

  // Only the outermost reader call is recorded: `mean()` reads `pmf` itself.
  let depth = 0;
  const observe = <T>(read: () => T, reader: string, args: readonly unknown[], serialize: (value: T) => Serialized): T => {
    depth++;
    let value: T;
    try {
      value = read();
    } finally {
      depth--;
    }
    if (depth === 0) record(reader, args, serialize(value));
    return value;
  };

  // Reflect.defineProperty returns a boolean rather than the (immutable-builder) prototype.
  const wrap = (reader: string, descriptor: PropertyDescriptor): void => {
    if (!Reflect.defineProperty(Turn.prototype, reader, descriptor)) throw new Error(`compat: cannot wrap Turn.${reader}`);
  };
  const pmf = Object.getOwnPropertyDescriptor(Turn.prototype, "pmf");
  if (pmf?.get === undefined) throw new Error("compat: Turn.prototype.pmf is not a getter");
  const getPMF = pmf.get;
  wrap("pmf", {
    ...pmf,
    get(this: unknown) {
      return observe(() => getPMF.call(this), "pmf", [], serializePMF);
    },
  });
  // 0.17 adds fields to `stepStats` (every effect's odds and sources, `conditions`): the fixture
  // holds the 0.16 fields, and those must stay bit for bit, so only they are compared.
  const serializers: Record<string, (value: unknown) => Serialized> = {
    toQuery: (value) => (value as DiceQuery).singles.map(serializePMF),
    stepStats: (value) => {
      const { rolled, hit, crit, live } = value as StepStats;
      return serializeLeaves({
        rolled,
        hit,
        crit,
        live: { advantage: live.advantage, disadvantage: live.disadvantage, critOnHit: live.critOnHit },
      });
    },
  };
  for (const reader of ["mean", "fireProbability", "expectedApplications", "stepStats", "toQuery"] as const) {
    const original = Turn.prototype[reader] as (this: unknown, ...args: unknown[]) => unknown;
    wrap(reader, {
      ...Object.getOwnPropertyDescriptor(Turn.prototype, reader),
      value: function (this: unknown, ...args: unknown[]): unknown {
        return observe(() => original.apply(this, args), reader, args, serializers[reader] ?? serializeLeaves);
      },
    });
  }

  afterEach(() => {
    const test = expect.getState().currentTestName ?? "";
    const messages = failures[test];
    if (messages === undefined) return;
    delete failures[test];
    throw new Error(`compat: ${messages.length} call(s) differ from the 0.16 fixture:\n${messages.join("\n")}`);
  });

  afterAll(() => {
    writeFileSync(join(inject("compatDir"), recordsName(file)), JSON.stringify({ file, tests: recorded }));
    if (MODE !== "check") return;
    const unreached: string[] = [];
    for (const [test, entries] of Object.entries(expected)) {
      for (const entry of entries.slice(recorded[test]?.length ?? 0)) {
        unreached.push(`${where(test, entry.ordinal, entry.reader)}: fixture entry never reached`);
      }
    }
    // Calls outside any test (collection, beforeAll) are not seen by afterEach.
    const outside = Object.values(failures).flat();
    if (unexpected.length === 0 && unreached.length === 0 && outside.length === 0) return;
    throw new Error(
      [
        `compat: ${file} does not match the 0.16 fixture.`,
        `No fixture entry (${unexpected.length}):`,
        ...unexpected,
        `Fixture entry never reached (${unreached.length}):`,
        ...unreached,
        ...(outside.length > 0 ? [`Differing outside a test (${outside.length}):`, ...outside] : []),
      ].join("\n")
    );
  });
}

/** The first place `want` and `got` differ, as a readable sentence. */
function firstDifference(want: Entry, got: Entry): string {
  if (want.reader !== got.reader) return `reader ${want.reader} expected, got ${got.reader}`;
  if (stableJSON(want.args) !== stableJSON(got.args)) {
    return `args ${stableJSON(want.args)} expected, got ${stableJSON(got.args)}`;
  }
  return firstLeafDifference(want.value, got.value, "value");
}

function firstLeafDifference(want: Serialized, got: Serialized, path: string): string {
  if (Array.isArray(want) && Array.isArray(got)) {
    // A PMF is `[value, probHex, count, attr][]`: name the first differing support entry.
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      if (i >= want.length) return `${path}[${i}] unexpected ${stableJSON(got[i])}`;
      if (i >= got.length) return `${path}[${i}] ${stableJSON(want[i])} missing`;
      if (stableJSON(want[i]) !== stableJSON(got[i])) return firstLeafDifference(want[i], got[i], `${path}[${i}]`);
    }
  }
  if (typeof want === "object" && want !== null && typeof got === "object" && got !== null) {
    // stepStats: name the first differing leaf.
    const w = want as Record<string, Serialized>;
    const g = got as Record<string, Serialized>;
    for (const key of [...new Set([...Object.keys(w), ...Object.keys(g)])].sort()) {
      if (stableJSON(w[key]) !== stableJSON(g[key])) {
        return firstLeafDifference(w[key] ?? null, g[key] ?? null, `${path}.${key}`);
      }
    }
  }
  const show = (value: Serialized): string =>
    typeof value === "string" && /^[0-9a-f]{16}$/.test(value) ? `${value} (${unhex(value)})` : stableJSON(value);
  return `${path} ${show(want)} expected, got ${show(got)}`;
}
