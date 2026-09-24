// config/eslint-no-discarded-builder.test.ts
//
// R24: exercises the local/no-discarded-builder rule (config/eslint-no-discarded-builder.mjs)
// against config/eslint-no-discarded-builder.fixture.ts through the real, type-aware ESLint
// API — not a hand-rolled AST check — so a regression in the rule's logic (e.g. losing the
// AssignmentExpression escape hatch, or failing to descend into `Turn | undefined` unions)
// fails this test instead of silently passing lint.
import path from "node:path";
import { fileURLToPath } from "node:url";
// typescript-eslint (through 8.x) crashes on load against the Go-native TypeScript 7 API;
// this redirects every `require("typescript")` inside this process to the TS 6.0 bridge, the
// same workaround `yarn lint`/`yarn format` apply via `node -r`. `vitest run` has no `-r` hook,
// so this test imports the shim itself, before anything below can trigger a `require("typescript")`.
import "./eslint-ts6-alias.cjs";
import tsParser from "@typescript-eslint/parser";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { noDiscardedBuilder } from "./eslint-no-discarded-builder.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "eslint-no-discarded-builder.fixture.ts");

// Every line in the fixture's `violations()` function is marked `// VIOLATION` in source;
// this list is that marker set, kept independent so the test still pins the exact lines
// even if the fixture's comments ever drift.
const EXPECTED_VIOLATION_LINES = [74, 75, 76, 77, 78, 79, 80, 81];

async function lintFixture(): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            project: ["./eslint-no-discarded-builder.fixture.tsconfig.json"],
            tsconfigRootDir: here,
          },
        },
        plugins: { local: { rules: { "no-discarded-builder": noDiscardedBuilder } } },
        rules: { "local/no-discarded-builder": "error" },
      },
    ],
  });
  const [result] = await eslint.lintFiles([fixturePath]);
  return result.messages;
}

describe("local/no-discarded-builder", () => {
  it("flags exactly the marked discarded-builder lines in the fixture, and nothing else", async () => {
    const messages = await lintFixture();
    const ruleMessages = messages.filter((m) => m.ruleId === "local/no-discarded-builder");

    expect(ruleMessages.map((m) => m.line).sort((a, b) => a - b)).toEqual(
      EXPECTED_VIOLATION_LINES,
    );
    // No other rule ran in this override config, so this also proves the fixture's
    // `cleanEscapes()` function — assignment, `void`, a plain void-returning call, and
    // ordinary arithmetic — produced zero reports.
    expect(messages.length).toBe(EXPECTED_VIOLATION_LINES.length);
  });

  it("names every watched builder type across the flagged lines", async () => {
    const messages = await lintFixture();
    const typeNames = messages
      .map((m) => /value is a (\w+),/.exec(m.message)?.[1])
      .filter((name): name is string => Boolean(name));

    expect(new Set(typeNames)).toEqual(
      new Set(["Turn", "PMF", "RollBuilder", "AttackBuilder", "ACBuilder"]),
    );
  });
});
