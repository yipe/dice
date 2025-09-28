import { describe, expect, it } from "vitest";
import { parse } from "../";
import { d20PMF, d20RollPMF } from "./d20";
import { d20 } from "./factory";

describe("d20SinglePMF", () => {
  it("should create a normal d20 PMF", () => {
    const pmf = d20PMF(false);
    expect(pmf.support().length).toBe(20);
    for (let i = 1; i <= 20; i++) {
      expect(pmf.pAt(i)).toBeCloseTo(0.05);
    }
    expect(pmf.mean()).toBeCloseTo(10.5);
  });

  it("should create a halfling d20 PMF", () => {
    const pmf = d20PMF(true);
    expect(pmf.support().length).toBe(20);
    expect(pmf.pAt(1)).toBeCloseTo(1 / 400);
    for (let i = 2; i <= 20; i++) {
      expect(pmf.pAt(i)).toBeCloseTo(21 / 400);
    }
    expect(pmf.mean()).toBeCloseTo(10.975);
  });
});

describe("d20WithRollTypePMF", () => {
  describe("with normal d20", () => {
    it('should handle "flat" roll type', () => {
      const pmf = d20RollPMF("flat");
      const singlePmf = d20PMF(false);
      expect(pmf.map).toEqual(singlePmf.map);
    });

    it("should handle undefined roll type", () => {
      const pmf = d20RollPMF(undefined);
      const singlePmf = d20PMF(false);
      expect(pmf.map).toEqual(singlePmf.map);
    });

    it('should handle "advantage"', () => {
      const pmf = d20RollPMF("advantage");
      expect(pmf.pAt(1)).toBeCloseTo(0.0025); // (1/20)^2
      expect(pmf.pAt(20)).toBeCloseTo(0.0975); // 1 - (19/20)^2
      expect(pmf.mean()).toBeCloseTo(13.825);
    });

    it('should handle "disadvantage"', () => {
      const pmf = d20RollPMF("disadvantage");
      expect(pmf.pAt(1)).toBeCloseTo(0.0975); // 1 - (19/20)^2
      expect(pmf.pAt(20)).toBeCloseTo(0.0025); // (1/20)^2
      expect(pmf.mean()).toBeCloseTo(7.175);
    });

    it('should handle "elven accuracy"', () => {
      const pmf = d20RollPMF("elven accuracy");
      expect(pmf.pAt(1)).toBeCloseTo(1 / 8000); // (1/20)^3
      expect(pmf.pAt(20)).toBeCloseTo(1 - (19 / 20) ** 3);
      expect(pmf.mean()).toBeCloseTo(15.4875);
    });

    it("should return cached PMF", () => {
      const pmf = d20RollPMF("advantage");
      const cachedPmf = d20RollPMF("advantage", false);
      const otherPMF = d20RollPMF("advantage", true);
      expect(pmf.map).toEqual(cachedPmf.map);
      expect(pmf.map).not.toEqual(otherPMF.map);
    });
  });

  describe("with halfling d20", () => {
    it('should handle "flat" roll type', () => {
      const pmf = d20RollPMF("flat", true);
      const singlePmf = d20PMF(true);
      expect(pmf.map).toEqual(singlePmf.map);
    });

    it('should handle "advantage"', () => {
      const pmf = d20RollPMF("advantage", true);
      const normalMean = d20RollPMF("flat", true).mean();
      expect(pmf.mean()).toBeGreaterThan(normalMean);
      expect(pmf.mean()).toBeCloseTo(14.1420625, 5);
    });

    it('should handle "disadvantage"', () => {
      const pmf = d20RollPMF("disadvantage", true);
      const normalMean = d20RollPMF("flat", true).mean();
      expect(pmf.mean()).toBeLessThan(normalMean);
      expect(pmf.mean()).toBeCloseTo(7.8079375);
    });

    it('should handle "elven accuracy"', () => {
      const pmf = d20RollPMF("elven accuracy", true);
      const parsedPMF = parse(
        "(d20 reroll 1) > (d20 reroll 1) > (d20 reroll 1)"
      );
      const normalMean = d20RollPMF("flat", true).mean();
      expect(pmf.mean()).toBeGreaterThan(normalMean);
      expect(pmf.mean()).toBeCloseTo(15.72497);
      expect(pmf.mean()).toBeCloseTo(parsedPMF.mean(), 5);
    });
  });

  describe('d20 hit', () => {
    it('should handle d20 hit', () => {
      const pmf = d20.alwaysHits().onHit(1).onCrit(1).onMiss(1).pmf
    
      const critChance = 1 / 20
      const hitChance = 1 - critChance
      expect(pmf.mean()).toBeCloseTo(hitChance * 1 + critChance * 1)
    })
  })
});
