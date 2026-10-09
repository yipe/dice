/**
 * Global side of the compat recorder (see `recorder.ts`). Inert unless `COMPAT` is
 * `capture` or `check`. Hands each worker a scratch directory for its records; on
 * teardown, both modes fail if a fixture file was never run (so a filtered `capture`
 * cannot overwrite the fixture with a partial one); otherwise `capture` writes the
 * fixture from the records (per-call comparison happens in the workers).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { CROSS_RUNTIME_TOLERANCE, FIXTURE_PATH, formatFixture, loadRetired, MODE, NODE_MAJOR, readFixture, type FileRecords, type Fixture } from "./format";

declare module "vitest" {
  export interface ProvidedContext {
    compatDir: string;
  }
}

export default function setup(project: TestProject): (() => void) | undefined {
  if (MODE === undefined) return undefined;
  if (MODE === "check") {
    const { capturedOn } = readFixture();
    if (capturedOn !== NODE_MAJOR) {
      console.log(`compat: Node v${NODE_MAJOR} differs from capture (v${capturedOn}); comparing at ${CROSS_RUNTIME_TOLERANCE} relative`);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "dice-compat-"));
  project.provide("compatDir", dir);

  return () => {
    const records = readdirSync(dir).map(
      (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as FileRecords
    );
    rmSync(dir, { recursive: true, force: true });

    const ran = new Set(records.map(({ file }) => file));
    const previous = readFixture().files;
    const missing = Object.keys(previous).filter((file) => !ran.has(file));
    if (missing.length > 0) {
      // A filtered run must not replace the full fixture with a partial one. vitest logs a teardown throw but still
      // exits 0, so fail the run explicitly. A test file that is gone for good: delete its entry from the fixture.
      const action = MODE === "capture" ? "not captured (run every test file)" : "never run";
      console.error(`compat: ${action}; fixture files missing from this run:\n${missing.map((file) => `  ${file}`).join("\n")}`);
      process.exitCode = 1;
      return;
    }

    if (MODE === "capture") {
      const fixture: Fixture = {};
      for (const { file, tests } of records) {
        if (Object.keys(tests).length > 0) fixture[file] = tests;
      }
      writeFileSync(FIXTURE_PATH, formatFixture({ capturedOn: NODE_MAJOR, files: fixture }));
      const calls = Object.values(fixture).reduce(
        (sum, tests) => sum + Object.values(tests).reduce((n, entries) => n + entries.length, 0),
        0
      );
      console.log(`compat: captured ${calls} reader calls from ${Object.keys(fixture).length} files`);
      return;
    }

    try {
      loadRetired(previous);
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
      return;
    }
    console.log(`compat: checked ${ran.size} files against ${Object.keys(previous).length} fixture files`);
  };
}
