/**
 * Global side of the compat recorder (see `recorder.ts`). Inert unless `COMPAT` is
 * `capture` or `check`. Hands each worker a scratch directory for its records; on
 * teardown, `capture` merges them into the fixture and `check` fails if a fixture file
 * was never run at all (per-call comparison happens in the workers).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { FIXTURE_PATH, formatFixture, loadRetired, MODE, type FileRecords, type Fixture } from "./format";

declare module "vitest" {
  export interface ProvidedContext {
    compatDir: string;
  }
}

export default function setup(project: TestProject): (() => void) | undefined {
  if (MODE === undefined) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "dice-compat-"));
  project.provide("compatDir", dir);

  return () => {
    const records = readdirSync(dir).map(
      (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as FileRecords
    );
    rmSync(dir, { recursive: true, force: true });

    if (MODE === "capture") {
      const fixture: Fixture = {};
      for (const { file, tests } of records) {
        if (Object.keys(tests).length > 0) fixture[file] = tests;
      }
      writeFileSync(FIXTURE_PATH, formatFixture(fixture));
      const calls = Object.values(fixture).reduce(
        (sum, tests) => sum + Object.values(tests).reduce((n, entries) => n + entries.length, 0),
        0
      );
      console.log(`compat: captured ${calls} reader calls from ${Object.keys(fixture).length} files`);
      return;
    }

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
    try {
      loadRetired(fixture);
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
      return;
    }
    const ran = new Set(records.map(({ file }) => file));
    const missing = Object.keys(fixture).filter((file) => !ran.has(file));
    if (missing.length > 0) {
      // vitest logs a teardown throw but still exits 0, so fail the run explicitly.
      console.error(`compat: fixture files never run:\n${missing.map((file) => `  ${file}`).join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`compat: checked ${ran.size} files against ${Object.keys(fixture).length} fixture files`);
  };
}
