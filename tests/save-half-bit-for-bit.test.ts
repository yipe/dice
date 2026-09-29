import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clearDCCache } from "../src/builder/dc";
import { clearRollCache } from "../src/builder/roll";
import { clearSaveCache } from "../src/builder/save";
import { digest, saveCases } from "./fixtures/save-half-cases";

/**
 * `saveHalf()` and the plain save must not move when a success can carry its own payload (`onSaveSuccess`).
 * `fixtures/save-half-golden.json` holds a SHA-256 of everything a consumer reads off each save of
 * `fixtures/save-half-cases.ts` (160 saves: 8 checks x 10 payloads x plain and half), captured from the
 * 0.14.2 implementation before `onSaveSuccess` existed: the expression, and at eps default, 0 and 1e-6 the
 * mixture, the check PMF, both payloads and the weights (`resolve`) plus `toPMF()`. Each digest covers every
 * bit of every bin's `p`, `count` and `attr`, so a change of one ulp anywhere fails.
 */
const golden = JSON.parse(readFileSync(new URL("./fixtures/save-half-golden.json", import.meta.url), "utf8")) as Record<
  string,
  string
>;

describe("saveHalf() and the plain save are bit for bit what 0.14.2 computed", () => {
  beforeEach(() => {
    clearSaveCache();
    clearDCCache();
    clearRollCache();
  });

  it("pins every case", () => {
    expect(Object.keys(golden)).toHaveLength(2 * saveCases().length);
  });

  for (const { name, build } of saveCases()) {
    for (const kind of ["half", "normal"] as const) {
      it(`${name} ${kind}`, () => {
        expect(digest(build(kind))).toBe(golden[`${name} ${kind}`]);
      });
    }
  }
});
