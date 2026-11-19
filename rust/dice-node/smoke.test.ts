import { describe, expect, it } from "vitest";
import { PMF } from "../../src/pmf/pmf";
import { parse } from "../../src/parser/parser";
import { DiceQuery } from "../../src/pmf/query";

/** Proves `src/` imports are served by the facade; skipped under the plain TS config. */
const facade = "_wrap" in PMF;

describe("rust facade smoke", () => {
  it.skipIf(!facade)("serves PMF and DiceQuery from native handles", () => {
    const pmf = parse("2d6+3");
    expect((pmf as unknown as { _handle?: unknown })._handle).toBeDefined();
    expect(pmf.mean()).toBeCloseTo(10, 9);
    const query = new DiceQuery([pmf, pmf]);
    expect((query as unknown as { _handle?: unknown })._handle).toBeDefined();
    expect(query.mean()).toBeCloseTo(20, 9);
  });
});
