import { describe, expect, it } from "vitest";
import { FIXTURES } from "./helpers/fixtures";
import { gTest } from "./helpers/gtest";
import { lcgRng } from "./helpers/lcg";
import { sampleFallbacks } from "../src/turn/sample"; // test seam: { count: number }, reset per test

// Samples per fixture; lower for a quick local run, e.g. `DICE_SAMPLES=20000 yarn vitest run tests/sample-conformance.test.ts`.
const N = Number(process.env["DICE_SAMPLES"] ?? 100_000);

describe("Turn.sample agrees with Turn.pmf", () => {
  for (const [name, build] of Object.entries(FIXTURES)) {
    it(name, () => {
      const t = build();
      const exact = t.pmf;
      const rng = lcgRng(0x5eed0001 + name.length);
      sampleFallbacks.count = 0;
      const counts = new Map<number, number>();
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const { total } = t.sample(rng);
        sum += total;
        counts.set(total, (counts.get(total) ?? 0) + 1);
      }
      const { p, g, df } = gTest(counts, exact, N);
      // Deterministic seed: the result is the same every run, so the threshold is a one-time calibration, not a flake budget.
      // 15 fixtures: Bonferroni on alpha 0.001 is 6.7e-5; use 1e-6 to leave room for the mean check below.
      expect(p, `G=${g.toFixed(1)} df=${df}`).toBeGreaterThan(1e-6);
      const se = exact.stdev() / Math.sqrt(N);
      expect(Math.abs(sum / N - exact.mean())).toBeLessThan(5 * se);
      expect(sampleFallbacks.count, "structural fallback to chips must not fire on fixtures").toBe(0);
    });
  }
  it("rider fire frequency matches fireProbability", () => {
    const t = FIXTURES["two attacks + sneak attack"]();
    const rng = lcgRng(42);
    let fired = 0;
    for (let i = 0; i < N; i++) {
      if (t.sample(rng).waves.some((w) => w.outcomes.some((o) => o.source === "sneak" && o.result === "fired"))) {
        fired++;
      }
    }
    const p = t.fireProbability("sneak");
    expect(Math.abs(fired / N - p)).toBeLessThan(5 * Math.sqrt((p * (1 - p)) / N));
  });
});
