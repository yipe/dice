import { describe, expect, it } from "vitest";
import { DiceQuery, parse, PMF } from "../src/index";

/**
 * These tests lock in the statistical performance optimizations in DiceQuery:
 *  - mean()/variance() use moment additivity (no convolution required)
 *  - `combined` is built lazily, so stats-only queries never convolve
 *  - combinedWithAttribution() reuses `combined` when singles already carry attr
 */
describe("Statistical performance optimizations", () => {
  const exprs = [
    "(d20 + 6 AC 15) * (2d6 + 4)",
    "(d20 +11 AC 10) * (4d8 + 5) crit (8d8 + 5)",
    "(d20 + 6 DC 15) * 8d6 save half",
  ];

  describe("mean()/variance() are additive and match the convolution", () => {
    for (const expr of exprs) {
      for (const n of [1, 2, 4]) {
        it(`${expr} ×${n}`, () => {
          const singles = parse(expr).replicate(n);
          const q = new DiceQuery(singles);

          // Reference values derived from the fully-convolved distribution.
          const combined = q.combined;
          let refMean = 0;
          for (const [d, bin] of combined) refMean += d * bin.p;
          let refVar = 0;
          for (const [d, bin] of combined)
            refVar += (d - refMean) * (d - refMean) * bin.p;

          expect(q.mean()).toBeCloseTo(refMean, 9);
          expect(q.variance()).toBeCloseTo(refVar, 6);
          expect(q.stdev()).toBeCloseTo(Math.sqrt(refVar), 6);
        });
      }
    }
  });

  it("mean() does not build the combined distribution (stays lazy)", () => {
    const q = new DiceQuery(parse("(d20 +60 AC 25) * (672) crit (24d6 + 600)").replicate(4));
    q.mean();
    q.variance();
    q.stdev();
    // `combined` is computed lazily; stats-only access must not materialize it.
    expect((q as unknown as { _combined?: PMF })._combined).toBeUndefined();

    // Accessing combined materializes and caches it.
    void q.combined;
    expect((q as unknown as { _combined?: PMF })._combined).toBeDefined();
  });

  it("combinedWithAttribution equals combined when singles carry attribution", () => {
    const singles = parse("(d20 +11 AC 10) * (4d8 + 5) crit (8d8 + 5)").replicate(3);
    const q = new DiceQuery(singles);
    const attributed = q.combinedWithAttribution();

    // Parser PMFs already carry attr, so this is the fast path: same object.
    expect(attributed).toBe(q.combined);
  });
});
