/**
 * Serialization shared by the compat recorder (worker side) and its global setup
 * (main process side). Every number a reader returns is stored as its float64 bit
 * pattern, so a comparison is bit-exact by construction, unless {@link toleranceFor}
 * gives its reader one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type CompatMode = "capture" | "check";

export const MODE: CompatMode | undefined =
  process.env.COMPAT === "capture" || process.env.COMPAT === "check" ? process.env.COMPAT : undefined;

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const FIXTURE_PATH = fileURLToPath(new URL("./fixtures-0.16.json", import.meta.url));
/** Fixture tests retired on purpose (see {@link loadRetired}). */
export const RETIRED_PATH = fileURLToPath(new URL("./retired.json", import.meta.url));

/** One retired fixture test: `key` is `<file> > <full test name>`; `reason` says why it no longer runs. */
export interface Retired {
  readonly key: string;
  readonly reason: string;
}

/**
 * The retired fixture tests of `fixture`, as `[file, test]` pairs. `check` mode does not require
 * a retired test: its fixture calls may go unreached. Every key must name a test the fixture has,
 * so a typo cannot silently retire nothing.
 */
export function loadRetired(fixture: Fixture): Array<readonly [file: string, test: string]> {
  const retired = JSON.parse(readFileSync(RETIRED_PATH, "utf8")) as readonly Retired[];
  return retired.map(({ key, reason }) => {
    const split = key.indexOf(" > ");
    const file = split === -1 ? "" : key.slice(0, split);
    const test = split === -1 ? "" : key.slice(split + 3);
    if (!reason) throw new Error(`compat: retired key ${JSON.stringify(key)} gives no reason`);
    if (fixture[file]?.[test] === undefined) {
      throw new Error(`compat: retired key ${JSON.stringify(key)} is not in the 0.16 fixture`);
    }
    return [file, test] as const;
  });
}

/** A JSON value whose numeric leaves are already hex strings (PMF values excepted). */
export type Serialized = string | number | null | readonly Serialized[] | { readonly [key: string]: Serialized };

/** One recorded reader call. `ordinal` is the call's index within its test. */
export interface Entry {
  readonly ordinal: number;
  readonly reader: string;
  readonly args: readonly Serialized[];
  readonly value: Serialized;
}

/** file (repo-relative, posix) → full test name → calls in order. */
export type Fixture = Record<string, Record<string, readonly Entry[]>>;

/** The Node major version this process runs on. */
export const NODE_MAJOR = Number(process.versions.node.split(".")[0]);

/**
 * The fixture file: its calls, and the Node major they were captured on. On disk `capturedOn` is a top-level key beside
 * the file paths, so the per-call lines stay as captured.
 */
export interface FixtureFile {
  readonly capturedOn: number;
  readonly files: Fixture;
}

export function readFixture(): FixtureFile {
  const { capturedOn, ...files } = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
  if (typeof capturedOn !== "number") throw new Error("compat: the fixture has no capturedOn (the Node major it was captured on)");
  return { capturedOn, files: files as Fixture };
}

/** What one test file's worker hands the global teardown. */
export interface FileRecords {
  readonly file: string;
  readonly tests: Record<string, readonly Entry[]>;
}

const scratch = new DataView(new ArrayBuffer(8));

/** The float64 bit pattern of `n` as 16 lowercase hex chars. */
export function hex(n: number): string {
  scratch.setFloat64(0, n);
  return (
    scratch.getUint32(0).toString(16).padStart(8, "0") + scratch.getUint32(4).toString(16).padStart(8, "0")
  );
}

/** Inverse of {@link hex}, for readable failure messages. */
export function unhex(bits: string): number {
  scratch.setUint32(0, Number.parseInt(bits.slice(0, 8), 16));
  scratch.setUint32(4, Number.parseInt(bits.slice(8), 16));
  return scratch.getFloat64(0);
}

/** Every numeric leaf as hex, object keys sorted. */
export function serializeLeaves(value: unknown): Serialized {
  if (typeof value === "number") return hex(value);
  if (typeof value === "string" || value === null) return value;
  if (typeof value === "object") {
    const out: Record<string, Serialized> = {};
    for (const key of Object.keys(value).sort()) out[key] = serializeLeaves((value as Record<string, unknown>)[key]);
    return out;
  }
  throw new TypeError(`compat: cannot serialize ${typeof value}`);
}

/** A bin's outcome-label map (`count` or `attr`) with its unset labels dropped; `null` when absent. */
function serializeLabels(labels: Readonly<Record<string, number | undefined>> | undefined): Serialized {
  if (labels === undefined) return null;
  return serializeLeaves(Object.fromEntries(Object.entries(labels).filter(([, v]) => v !== undefined)));
}

/**
 * A PMF as `[value, probHex, count, attr]` entries sorted by value: each bin's mass and its outcome labels (the
 * per-outcome mass and damage attribution that `outcomeTotals` and the attribution charts read).
 */
export function serializePMF(pmf: {
  readonly map: ReadonlyMap<
    number,
    { readonly p: number; readonly count: Readonly<Record<string, number | undefined>>; readonly attr?: Readonly<Record<string, number | undefined>> }
  >;
}): Serialized {
  return [...pmf.map]
    .sort(([a], [b]) => a - b)
    .map(([value, bin]): Serialized => [value, hex(bin.p), serializeLabels(bin.count), serializeLabels(bin.attr)]);
}

/** JSON with object keys sorted at every depth. */
export function stableJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, (v as Record<string, unknown>)[key]]))
      : v
  );
}

/** The fixture file's text: `capturedOn` first, then sorted keys, one call per line so diffs stay readable. */
export function formatFixture({ capturedOn, files: fixture }: FixtureFile): string {
  const files = Object.keys(fixture).sort();
  const lines = ["{", `  "capturedOn": ${capturedOn},`];
  files.forEach((file, fileIndex) => {
    lines.push(`  ${JSON.stringify(file)}: {`);
    const tests = Object.keys(fixture[file]).sort();
    tests.forEach((test, testIndex) => {
      lines.push(`    ${JSON.stringify(test)}: [`);
      const entries = fixture[file][test];
      entries.forEach((entry, entryIndex) => {
        lines.push(`      ${stableJSON(entry)}${entryIndex < entries.length - 1 ? "," : ""}`);
      });
      lines.push(`    ]${testIndex < tests.length - 1 ? "," : ""}`);
    });
    lines.push(`  }${fileIndex < files.length - 1 ? "," : ""}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/**
 * Per reader, the relative tolerance its numbers are compared at (|a − b| ≤ tol · max(1, |b|));
 * a reader not listed is bit-exact. These readers are read from the mass walk, not the
 * joint PMF walk, so they agree with 0.16 to rounding, not to the bit. `pmf`, `mean` and
 * `toQuery` stay bit-exact.
 */
const TOLERANCE: Readonly<Record<string, number>> = {
  stepStats: 1e-12,
  fireProbability: 1e-12,
  expectedApplications: 1e-12,
};

/** The relative tolerance every reader is compared at on a Node major other than the capture's. */
export const CROSS_RUNTIME_TOLERANCE = 1e-12;

/**
 * The relative tolerance `reader` is compared at, or `undefined` for bit-exact. Bit-exactness holds only on the Node
 * major the fixture was captured on (V8's math functions differ by an ULP or two across majors), so on another major
 * every reader is compared at {@link CROSS_RUNTIME_TOLERANCE}.
 */
export function toleranceFor(reader: string, sameRuntime: boolean): number | undefined {
  return sameRuntime ? TOLERANCE[reader] : CROSS_RUNTIME_TOLERANCE;
}

/** Whether `got` matches `want` with every numeric leaf within `tolerance` (relative, see {@link toleranceFor}). */
export function withinTolerance(want: Serialized, got: Serialized, tolerance: number): boolean {
  if (typeof want === "string" && typeof got === "string" && /^[0-9a-f]{16}$/.test(want) && /^[0-9a-f]{16}$/.test(got)) {
    const [a, b] = [unhex(got), unhex(want)];
    return a === b || Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
  }
  if (Array.isArray(want) && Array.isArray(got)) {
    return want.length === got.length && want.every((each, i) => withinTolerance(each, got[i], tolerance));
  }
  if (typeof want === "object" && want !== null && typeof got === "object" && got !== null && !Array.isArray(want) && !Array.isArray(got)) {
    const w = want as Record<string, Serialized>;
    const g = got as Record<string, Serialized>;
    const keys = new Set([...Object.keys(w), ...Object.keys(g)]);
    return [...keys].every((key) => key in w && key in g && withinTolerance(w[key], g[key], tolerance));
  }
  return want === got;
}

/** A per-file name for the records a worker hands over. */
export function recordsName(file: string): string {
  return `${createHash("sha1").update(file).digest("hex")}.json`;
}
