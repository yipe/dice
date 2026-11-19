/**
 * Vitest setup file: while the oracle-backed condition tests run, records what the brute-force oracle
 * (`tests/oracle/bruteForce.ts` `enumerateSyntheticTurn`) returned for each synthetic turn, keyed by test
 * name, for the Rust translations (`src/turn/tests/{flags,turn_conditions,creatures,saves}.rs`). Run from the
 * repo root:
 *   yarn vitest run -c rust/dice/fixtures/vitest.oracle.config.ts \
 *     tests/turn-flags.test.ts tests/turn-conditions.test.ts tests/turn-creatures.test.ts tests/turn-saves.test.ts
 * Numbers are float64 bits (16 hex digits), PMFs are [value, bits] pairs sorted by value, as compat/format.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, expect, vi } from "vitest";

const OUT = new URL("./oracle-conditions.json", import.meta.url);

type Pmf = Map<number, number>;
const hex = (n: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};
const pmf = (m: Pmf): Array<[number, string]> => [...m].sort(([a], [b]) => a - b).map(([v, p]) => [v, hex(p)]);

interface Recorded {
  synthetic: unknown;
  mean: string;
  pmf: Array<[number, string]>;
  sources: Array<Array<[number, string]>>;
  riders?: Array<Array<[number, string]>>;
}
const recorded: Record<string, Recorded[]> = {};

vi.mock("../../../tests/oracle/bruteForce", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../tests/oracle/bruteForce")>();
  return {
    ...original,
    enumerateSyntheticTurn: (turn: never, options?: { detail?: boolean }) => {
      const result = original.enumerateSyntheticTurn(turn, options);
      const test = expect.getState().currentTestName ?? "";
      const file = (expect.getState().testPath ?? "").replace(/^.*\/(tests\/[^/]+)$/, "$1");
      (recorded[`${file} > ${test}`] ??= []).push({
        synthetic: JSON.parse(JSON.stringify(turn)),
        mean: hex(result.mean),
        pmf: pmf(result.pmf),
        sources: result.sources.map(pmf),
        ...(result.detail ? { riders: result.detail.riders.map((r) => pmf(r.pmf)) } : {}),
      });
      return result;
    },
  };
});

afterAll(() => {
  let all: Record<string, Recorded[]> = {};
  try {
    all = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    mkdirSync(new URL(".", OUT), { recursive: true });
  }
  Object.assign(all, recorded);
  writeFileSync(OUT, `${JSON.stringify(all, null, 1)}\n`);
});
