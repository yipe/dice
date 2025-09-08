import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "../src/parser";
import { PMF } from "../src/pmf";
import { DiceQuery } from "../src/query";
import { Bin, OutcomeType } from "../src/types";

// Helper function to create a uniform die PMF
function uniformDie(sides: number): PMF {
  const m = new Map<number, Bin>();
  for (let i = 1; i <= sides; i++) {
    m.set(i, { p: 1 / sides, count: {} });
  }
  return new PMF(m, 1e-15, true);
}

// Helper function to create PMF with labeled outcomes
function pmfWithLabels(
  map: Record<
    number,
    { p: number; labels?: Partial<Record<OutcomeType, number>> }
  >
): PMF {
  const m = new Map<number, Bin>();
  for (const [damage, { p, labels = {} }] of Object.entries(map)) {
    m.set(Number(damage), { p, count: labels });
  }
  return new PMF(m, 1e-15, true);
}

describe("DiceQuery Advanced Methods", () => {
  let simpleQuery: DiceQuery;
  let labeledQuery: DiceQuery;

  beforeEach(() => {
    // Simple query with uniform d6
    const d6 = uniformDie(6);
    simpleQuery = new DiceQuery([d6]);

    // Complex query with labeled outcomes
    const critPMF = pmfWithLabels({
      0: { p: 0.5, labels: { missNone: 0.5 } },
      6: { p: 0.3, labels: { hit: 0.3 } },
      12: { p: 0.2, labels: { crit: 0.2 } },
    });
    labeledQuery = new DiceQuery([critPMF]);
  });

  describe("toChartSeries", () => {
    it("should return correct chart data structure", () => {
      const chartData = simpleQuery.toChartSeries();

      expect(chartData).toHaveLength(6); // d6 has 6 faces

      // Check structure of each data point
      for (const point of chartData) {
        expect(point).toHaveProperty("x");
        expect(point).toHaveProperty("y");
        expect(typeof point.x).toBe("number");
        expect(typeof point.y).toBe("number");
      }
    });

    it("should have x values matching damage support", () => {
      const chartData = simpleQuery.toChartSeries();
      const xValues = chartData.map((p) => p.x);

      expect(xValues).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("should have y values as probabilities", () => {
      const chartData = simpleQuery.toChartSeries();

      // All faces should have equal probability for d6
      for (const point of chartData) {
        expect(point.y).toBeCloseTo(1 / 6, 12);
      }
    });

    it("should sum to 1 for total probability", () => {
      const chartData = simpleQuery.toChartSeries();
      const totalProbability = chartData.reduce(
        (sum, point) => sum + point.y,
        0
      );

      expect(totalProbability).toBeCloseTo(1, 12);
    });

    it("should handle complex distributions", () => {
      const chartData = labeledQuery.toChartSeries();

      expect(chartData).toHaveLength(3); // 0, 6, 12 damage

      const pointMap = Object.fromEntries(chartData.map((p) => [p.x, p.y]));
      expect(pointMap[0]).toBeCloseTo(0.5, 12);
      expect(pointMap[6]).toBeCloseTo(0.3, 12);
      expect(pointMap[12]).toBeCloseTo(0.2, 12);
    });

    it("should handle empty query", () => {
      const emptyPMF = PMF.empty();
      const emptyQuery = new DiceQuery([emptyPMF]);
      const chartData = emptyQuery.toChartSeries();

      expect(chartData).toEqual([]);
    });

    it("should maintain order by damage value", () => {
      const unsortedPMF = pmfWithLabels({
        10: { p: 0.3 },
        1: { p: 0.4 },
        5: { p: 0.3 },
      });
      const query = new DiceQuery([unsortedPMF]);
      const chartData = query.toChartSeries();

      const xValues = chartData.map((p) => p.x);
      expect(xValues).toEqual([1, 5, 10]); // Should be sorted
    });

    it("should handle fractional damage values", () => {
      const fractionalPMF = pmfWithLabels({
        1.5: { p: 0.6 },
        2.7: { p: 0.4 },
      });
      const query = new DiceQuery([fractionalPMF]);
      const chartData = query.toChartSeries();

      expect(chartData[0].x).toBe(1.5);
      expect(chartData[1].x).toBe(2.7);
    });
  });

  describe("toLabeledTable", () => {
    it("should return correct table structure", () => {
      const table = simpleQuery.toLabeledTable();

      expect(table).toHaveLength(6);

      for (const row of table) {
        expect(row).toHaveProperty("damage");
        expect(row).toHaveProperty("total");
        expect(typeof row.damage).toBe("number");
        expect(typeof row.total).toBe("number");
      }
    });

    it("should have damage values matching support", () => {
      const table = simpleQuery.toLabeledTable();
      const damages = table.map((row) => row.damage);

      expect(damages).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("should have total probabilities matching PMF", () => {
      const table = simpleQuery.toLabeledTable();

      for (const row of table) {
        expect(row.total).toBeCloseTo(1 / 6, 12);
      }
    });

    it("should include requested outcome labels", () => {
      const table = labeledQuery.toLabeledTable(["hit", "crit", "missNone"]);

      for (const row of table) {
        expect(row).toHaveProperty("hit");
        expect(row).toHaveProperty("crit");
        expect(row).toHaveProperty("missNone");
      }
    });

    it("should show correct outcome probabilities", () => {
      const table = labeledQuery.toLabeledTable(["hit", "crit", "missNone"]);

      const rowMap = Object.fromEntries(table.map((row) => [row.damage, row]));

      // Check specific outcome probabilities
      expect(rowMap[0].missNone).toBeCloseTo(0.5, 12);
      expect(rowMap[0].hit).toBe(0);
      expect(rowMap[0].crit).toBe(0);

      expect(rowMap[6].hit).toBeCloseTo(0.3, 12);
      expect(rowMap[6].missNone).toBe(0);
      expect(rowMap[6].crit).toBe(0);

      expect(rowMap[12].crit).toBeCloseTo(0.2, 12);
      expect(rowMap[12].hit).toBe(0);
      expect(rowMap[12].missNone).toBe(0);
    });

    it("should handle unlabeled outcomes as zero", () => {
      const table = simpleQuery.toLabeledTable(["hit", "crit"]);

      for (const row of table) {
        expect(row.hit).toBe(0);
        expect(row.crit).toBe(0);
      }
    });

    it("should handle empty labels array", () => {
      const table = simpleQuery.toLabeledTable([]);

      for (const row of table) {
        expect(Object.keys(row)).toEqual(["damage", "total"]);
      }
    });

    it("should handle partial outcome coverage", () => {
      const partialPMF = pmfWithLabels({
        1: { p: 0.4, labels: { hit: 0.2 } }, // Only half the probability is labeled
        6: { p: 0.6, labels: { crit: 0.6 } }, // All probability is labeled
      });
      const query = new DiceQuery([partialPMF]);
      const table = query.toLabeledTable(["hit", "crit"]);

      const rowMap = Object.fromEntries(table.map((row) => [row.damage, row]));
      expect(rowMap[1].hit).toBeCloseTo(0.2, 12);
      expect(rowMap[1].crit).toBe(0);
      expect(rowMap[6].hit).toBe(0);
      expect(rowMap[6].crit).toBeCloseTo(0.6, 12);
    });

    it("should maintain numerical precision", () => {
      const table = labeledQuery.toLabeledTable(["hit", "crit", "missNone"]);
      const totalSum = table.reduce((sum, row) => sum + row.total, 0);

      expect(totalSum).toBeCloseTo(1, 12);
    });
  });

  describe("toStackedChartData", () => {
    it("should return correct structure", () => {
      const stackedData = labeledQuery.toStackedChartData([
        "hit",
        "crit",
        "missNone",
      ]);

      expect(stackedData).toHaveProperty("labels");
      expect(stackedData).toHaveProperty("datasets");
      expect(Array.isArray(stackedData.labels)).toBe(true);
      expect(Array.isArray(stackedData.datasets)).toBe(true);
    });

    it("should have labels matching damage support", () => {
      const stackedData = labeledQuery.toStackedChartData([
        "hit",
        "crit",
        "missNone",
      ]);

      expect(stackedData.labels).toEqual([0, 6, 12]);
    });

    it("should create datasets for each outcome", () => {
      const stackedData = labeledQuery.toStackedChartData([
        "hit",
        "crit",
        "missNone",
      ]);

      expect(stackedData.datasets).toHaveLength(3);

      const datasetLabels = stackedData.datasets.map((ds) => ds.label);
      expect(datasetLabels).toEqual(["hit", "crit", "missNone"]);
    });

    it("should have data arrays matching labels length", () => {
      const stackedData = labeledQuery.toStackedChartData([
        "hit",
        "crit",
        "missNone",
      ]);

      for (const dataset of stackedData.datasets) {
        expect(dataset.data).toHaveLength(stackedData.labels.length);
      }
    });

    it("should show correct stacked values", () => {
      const stackedData = labeledQuery.toStackedChartData([
        "hit",
        "crit",
        "missNone",
      ]);

      const datasets = Object.fromEntries(
        stackedData.datasets.map((ds) => [ds.label, ds.data])
      );

      // For damage 0: only missNone should have value
      expect(datasets.missNone[0]).toBeCloseTo(0.5, 12); // Index 0 = damage 0
      expect(datasets.hit[0]).toBe(0);
      expect(datasets.crit[0]).toBe(0);

      // For damage 6: only hit should have value
      expect(datasets.hit[1]).toBeCloseTo(0.3, 12); // Index 1 = damage 6
      expect(datasets.missNone[1]).toBe(0);
      expect(datasets.crit[1]).toBe(0);

      // For damage 12: only crit should have value
      expect(datasets.crit[2]).toBeCloseTo(0.2, 12); // Index 2 = damage 12
      expect(datasets.hit[2]).toBe(0);
      expect(datasets.missNone[2]).toBe(0);
    });

    it("should sum to total probability for each damage value", () => {
      const stackedData = labeledQuery.toStackedChartData([
        "hit",
        "crit",
        "missNone",
      ]);

      for (let i = 0; i < stackedData.labels.length; i++) {
        const damage = stackedData.labels[i];
        const stackedSum = stackedData.datasets.reduce(
          (sum, ds) => sum + ds.data[i],
          0
        );
        const expectedTotal = labeledQuery.combined.pAt(damage);

        expect(stackedSum).toBeCloseTo(expectedTotal, 10);
      }
    });

    it("should handle empty labels array", () => {
      const stackedData = labeledQuery.toStackedChartData([]);

      expect(stackedData.datasets).toHaveLength(0);
      expect(stackedData.labels).toEqual([0, 6, 12]); // Still shows damage values
    });

    it("should handle epsilon filtering", () => {
      const tinyPMF = pmfWithLabels({
        1: { p: 1e-15, labels: { hit: 1e-15 } },
        6: { p: 0.999999999999999, labels: { hit: 0.999999999999999 } },
      });
      const query = new DiceQuery([tinyPMF]);
      const stackedData = query.toStackedChartData(["hit"], 1e-12);

      const hitData = stackedData.datasets.find(
        (ds) => ds.label === "hit"
      )!.data;
      expect(hitData[0]).toBe(0); // Should be filtered out due to epsilon
      expect(hitData[1]).toBeGreaterThan(0.9); // Should remain
    });

    it("should correct floating-point drift", () => {
      // Create a case where floating-point arithmetic might cause drift
      const driftPMF = pmfWithLabels({
        1: { p: 1 / 3, labels: { hit: 1 / 6, crit: 1 / 6 } },
        2: { p: 2 / 3, labels: { hit: 1 / 3, crit: 1 / 3 } },
      });
      const query = new DiceQuery([driftPMF]);
      const stackedData = query.toStackedChartData(["hit", "crit"]);

      // Check that each damage value sums to its expected total
      for (let i = 0; i < stackedData.labels.length; i++) {
        const damage = stackedData.labels[i];
        const stackedSum = stackedData.datasets.reduce(
          (sum, ds) => sum + ds.data[i],
          0
        );
        const expectedTotal = query.combined.pAt(damage);

        expect(stackedSum).toBeCloseTo(expectedTotal, 10);
      }
    });

    it("should handle mixed labeled and unlabeled outcomes", () => {
      const mixedPMF = pmfWithLabels({
        1: { p: 0.5, labels: { hit: 0.3 } }, // Partial labeling
        6: { p: 0.5, labels: { crit: 0.5 } }, // Full labeling
      });
      const query = new DiceQuery([mixedPMF]);
      const stacked = query.toStackedChartData(["hit", "crit"]);

      const hitDataset = stacked.datasets.find((ds) => ds.label === "hit");
      expect(hitDataset?.data).toEqual([0.3, 0]);

      const byLabel = Object.fromEntries(
        stacked.datasets.map((d) => [d.label, d.data])
      );

      // Label masses per bucket
      expect(byLabel.hit).toEqual([0.3, 0]);
      expect(byLabel.crit).toEqual([0, 0.5]);

      // Optional: verify each bucket’s total mass if you expose pAt(x)
      expect(query.toChartSeries().map((d) => d.y)).toEqual([0.5, 0.5]);
    });

    it("produces multiple buckets when inputs have spread", () => {
      // 3 with 0.5, 4 with 0.5
      const pmf1 = pmfWithLabels({
        3: { p: 0.5, labels: { hit: 0.5 } },
        4: { p: 0.5, labels: { hit: 0.5 } },
      });
      // 5 with 0.5, 6 with 0.5
      const pmf2 = pmfWithLabels({
        5: { p: 0.5, labels: { hit: 0.5 } },
        6: { p: 0.5, labels: { hit: 0.5 } },
      });

      const q = new DiceQuery([pmf1, pmf2]);
      const chartData = q.toChartSeries();

      // Sums: 3+5=8, 3+6=9, 4+5=9, 4+6=10 -> buckets at 8, 9, 10
      expect(chartData.length).toBe(3);
      const map = Object.fromEntries(chartData.map((d) => [d.x, d.y]));
      expect(map[8]).toBeCloseTo(0.25, 12);
      expect(map[9]).toBeCloseTo(0.5, 12);
      expect(map[10]).toBeCloseTo(0.25, 12);
    });

    it("should convolve to a single bucket when both inputs are degenerate", () => {
      const pmf1 = pmfWithLabels({ 3: { p: 1, labels: { hit: 1 } } });
      const pmf2 = pmfWithLabels({ 6: { p: 1, labels: { hit: 1 } } });
      const multiQuery = new DiceQuery([pmf1, pmf2]);

      const chartData = multiQuery.toChartSeries();
      expect(chartData.length).toBe(1);
      expect(chartData[0].x).toBe(9);
      expect(chartData[0].y).toBeCloseTo(1, 12);

      // Label semantics depend on your design:
      // If "hit" is a boolean-occurs label aggregated with OR:
      const table = multiQuery.toLabeledTable(["hit"]);

      expect(table[0].hit).toEqual(2);
      expect(table[0].damage).toEqual(9);
      expect(table[0].total).toEqual(1);

      // If instead "hit" is a COUNT label that sums across attacks,
      // then you should expect a total of 2 here. Pick one convention and keep it consistent.
      // expect(hitSum).toBeCloseTo(2, 12);
    });
  });

  describe("toAttributionChartSeries", () => {
    it("should return correct structure", () => {
      const attribution = labeledQuery.toAttributionChartSeries();

      expect(attribution).toHaveProperty("support");
      expect(attribution).toHaveProperty("outcomes");
      expect(attribution).toHaveProperty("data");
      expect(Array.isArray(attribution.support)).toBe(true);
      expect(Array.isArray(attribution.outcomes)).toBe(true);
      expect(typeof attribution.data).toBe("object");
    });

    it("should create complete integer range for support", () => {
      const attribution = labeledQuery.toAttributionChartSeries();

      // Should create range from 0 to 12
      expect(attribution.support).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
    });

    it("should discover all outcome types", () => {
      const attribution = labeledQuery.toAttributionChartSeries();

      expect(attribution.outcomes).toContain("hit");
      expect(attribution.outcomes).toContain("crit");
      expect(attribution.outcomes).toContain("missNone");
    });

    it("should respect stack order", () => {
      const attribution = labeledQuery.toAttributionChartSeries({
        stackOrder: ["crit", "hit", "missNone"],
      });

      expect(attribution.outcomes).toEqual(["crit", "hit", "missNone"]);
    });

    it("should apply filter rules", () => {
      const attribution = labeledQuery.toAttributionChartSeries({
        filterRules: (outcome, damage) =>
          outcome !== "missNone" || damage === 0,
      });

      // missNone should only appear for damage 0
      const missNoneData = attribution.data.missNone;
      expect(missNoneData[0]).toBeGreaterThan(0); // damage 0
      for (let i = 1; i < missNoneData.length; i++) {
        expect(missNoneData[i]).toBe(0); // other damages
      }
    });

    it("should return percentages by default", () => {
      const attribution = labeledQuery.toAttributionChartSeries();

      // Sum should be around 100% for each damage value that exists
      const missNoneData = attribution.data.missNone;
      const hitData = attribution.data.hit;
      const critData = attribution.data.crit;

      // For damage 0: should be 50% (0.5 * 100)
      expect(missNoneData[0]).toBeCloseTo(50, 10);

      // For damage 6: should be 30% (0.3 * 100)
      expect(hitData[6]).toBeCloseTo(30, 10);

      // For damage 12: should be 20% (0.2 * 100)
      expect(critData[12]).toBeCloseTo(20, 10);
    });

    it("should return probabilities when asPercentages is false", () => {
      const attribution = labeledQuery.toAttributionChartSeries({
        asPercentages: false,
      });

      const missNoneData = attribution.data.missNone;
      expect(missNoneData[0]).toBeCloseTo(0.5, 12);
    });

    it("should handle empty PMF", () => {
      const emptyPMF = PMF.empty();
      const emptyQuery = new DiceQuery([emptyPMF]);
      const attribution = emptyQuery.toAttributionChartSeries();

      expect(attribution.support).toEqual([]);
      expect(attribution.outcomes).toEqual([]);
      expect(attribution.data).toEqual({});
    });

    it("should handle PMF with no outcomes", () => {
      const attribution = simpleQuery.toAttributionChartSeries();

      // Should still create support range
      expect(attribution.support).toEqual([1, 2, 3, 4, 5, 6]);
      expect(attribution.outcomes).toEqual([]);
      expect(attribution.data).toEqual({});
    });

    it("should fill gaps in support with zeros", () => {
      const gappyPMF = pmfWithLabels({
        1: { p: 0.5, labels: { hit: 0.5 } },
        10: { p: 0.5, labels: { hit: 0.5 } },
        // Gap from 2-9
      });
      const query = new DiceQuery([gappyPMF]);
      const attribution = query.toAttributionChartSeries();

      expect(attribution.support).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const hitData = attribution.data.hit;
      expect(hitData[0]).toBeGreaterThan(0); // damage 1
      expect(hitData[9]).toBeGreaterThan(0); // damage 10

      // Gaps should be zero
      for (let i = 1; i < 9; i++) {
        expect(hitData[i]).toBe(0);
      }
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle very small probabilities", () => {
      const tinyPMF = pmfWithLabels({
        1: { p: Number.MIN_VALUE, labels: { hit: Number.MIN_VALUE } },
      });
      const query = new DiceQuery([tinyPMF]);

      const chartData = query.toChartSeries();
      expect(chartData[0].y).toBe(Number.MIN_VALUE);

      const table = query.toLabeledTable(["hit"]);
      expect(table[0].hit).toBe(Number.MIN_VALUE);
    });

    it("should handle very large damage values", () => {
      const hugePMF = pmfWithLabels({
        [Number.MAX_SAFE_INTEGER]: { p: 1, labels: { hit: 1 } },
      });
      const query = new DiceQuery([hugePMF]);

      const chartData = query.toChartSeries();
      expect(chartData[0].x).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("should handle fractional damage values in tables", () => {
      const fractionalPMF = pmfWithLabels({
        1.5: { p: 0.7, labels: { hit: 0.5, crit: 0.2 } },
        2.7: { p: 0.3, labels: { hit: 0.3 } },
      });
      const query = new DiceQuery([fractionalPMF]);

      const table = query.toLabeledTable(["hit", "crit"]);
      expect(table[0].damage).toBe(1.5);
      expect(table[0].hit).toBeCloseTo(0.5, 12);
      expect(table[0].crit).toBeCloseTo(0.2, 12);
    });

    it("should handle negative damage values", () => {
      const negativePMF = pmfWithLabels({
        [-5]: { p: 0.3, labels: { hit: 0.3 } },
        0: { p: 0.4, labels: { missNone: 0.4 } },
        3: { p: 0.3, labels: { hit: 0.3 } },
      });
      const query = new DiceQuery([negativePMF]);

      const chartData = query.toChartSeries();
      expect(chartData[0].x).toBe(-5);

      const attribution = query.toAttributionChartSeries();
      expect(attribution.support[0]).toBe(-5);
    });

    it("should maintain precision with complex outcome distributions", () => {
      const complexPMF = pmfWithLabels({
        1: { p: 1 / 3, labels: { hit: 1 / 6, crit: 1 / 12, missNone: 1 / 12 } },
        2: { p: 1 / 3, labels: { hit: 1 / 4, crit: 1 / 12 } },
        3: { p: 1 / 3, labels: { hit: 1 / 3 } },
      });
      const query = new DiceQuery(complexPMF);

      const table = query.toLabeledTable(["hit", "crit", "missNone"]);
      const totalSum = table.reduce((sum, row) => sum + row.total, 0);

      expect(totalSum).toBeCloseTo(1, 12);

      // Check that outcome probabilities sum correctly
      const hitSum = table.reduce((sum, row) => sum + row.hit, 0);
      const critSum = table.reduce((sum, row) => sum + row.crit, 0);
      const missSum = table.reduce((sum, row) => sum + row.missNone, 0);

      expect(hitSum).toBeCloseTo(1 / 6 + 1 / 4 + 1 / 3, 12);
      expect(critSum).toBeCloseTo(1 / 12 + 1 / 12, 12);
      expect(missSum).toBeCloseTo(1 / 12, 12);
    });

    it("should handle queries with multiple PMFs", () => {
      const pmf1 = pmfWithLabels({ 3: { p: 1, labels: { hit: 1 } } });
      const pmf2 = pmfWithLabels({ 6: { p: 1, labels: { hit: 1 } } });
      const multiQuery = new DiceQuery([pmf1, pmf2]);

      const chartData = multiQuery.toChartSeries();
      expect(chartData.length).toEqual(1); // Should have combined distribution

      const table = multiQuery.toLabeledTable(["hit"]);
      expect(table[0].damage).toEqual(9);
      expect(table[0].total).toEqual(1);
      expect(table[0].hit).toEqual(2);
    });

    it("should handle damage rider with OA", () => {
      const attackExpression = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
      const smiteDamageExpression = "3d6";
      const smiteCritDamageExpression = "6d6";
      const oaChance = 0.25;

      const attack = parse(attackExpression);
      const mains = new DiceQuery([attack, attack]);

      // Per-attack odds
      const pH = new DiceQuery([attack]).probAtLeastOne(["hit", "crit"]); // 0.65
      const pC = new DiceQuery([attack]).probAtLeastOne(["crit"]); // 0.05

      // First-hit decomposition
      const pFirstCrit = pC * (2 - pH); // 0.0675
      const pFirstNonCrit = (pH - pC) * (2 - pH); // 0.81
      // Optional: sanity
      const pAnyMain = mains.probAtLeastOne(["hit", "crit"]); // 0.8775
      console.assert(Math.abs(pFirstCrit + pFirstNonCrit - pAnyMain) < 1e-12);

      // Smite once: 6d6 if first hit is crit, else 3d6
      const smiteCrit = PMF.withProbability(
        parse(smiteCritDamageExpression),
        pFirstCrit
      );
      const smiteNorm = PMF.withProbability(
        parse(smiteDamageExpression),
        pFirstNonCrit
      );

      // OA happens with 25% chance (safe to reuse `attack` if PMF is immutable)
      const oa = PMF.withProbability(parse(attackExpression), oaChance);

      // Final query
      const fullTurn = new DiceQuery([
        attack,
        attack,
        smiteNorm,
        smiteCrit,
        oa,
      ]);

      console.log("DPR:", fullTurn.mean().toFixed(4));
      console.log("2x Sword DPR (no smite):", mains.mean().toFixed(4));
      console.log("Smite DPR:", new DiceQuery(smiteNorm).mean().toFixed(4));
      console.log(
        "Smite Crit DPR:",
        new DiceQuery(smiteCrit).mean().toFixed(4)
      );
      console.log("Opportunity attack DPR:", oa.mean().toFixed(4));
    });
  });
});
