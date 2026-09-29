import { describe, expect, it } from "vitest";
import { d, roll } from "../src/builder";
import type { Bin } from "../src/index";
import { EPS, PMF } from "../src/index";

// A name is `pmf#` and 16 hex digits.
const DERIVED_NAME = /^pmf#[0-9a-f]{16}$/;

function fromWeights(weights: number[], labels = true): PMF {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const map = new Map<number, Bin>();
  weights.forEach((weight, damage) => {
    const p = weight / total;
    map.set(damage, { p, count: labels ? { hit: p } : {} });
  });
  return new PMF(map, EPS, true);
}

describe("PMF.identifier", () => {
  it("is derived from the content when no name was given", () => {
    const pmf = fromWeights([1, 2, 3]);
    expect(pmf.identifier).toMatch(DERIVED_NAME);
  });

  it("reads the same for equal content however the PMF was built", () => {
    const first = fromWeights([1, 2, 3]);
    const second = fromWeights([1, 2, 3]);
    const descending = new PMF(new Map([...second.map].reverse()), EPS, true);
    expect(second.identifier).toBe(first.identifier);
    expect(descending.identifier).toBe(first.identifier);
  });

  it("differs when the content differs, in probabilities, labels or the normalized flag", () => {
    const base = fromWeights([1, 2, 3]);
    const skewed = fromWeights([1, 2, 4]);
    const unlabelled = fromWeights([1, 2, 3], false);
    const unnormalized = new PMF(base.map, EPS, false);
    const names = [base, skewed, unlabelled, unnormalized].map((pmf) => pmf.identifier);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps a name given at construction, through normalize() and compact()", () => {
    const named = new PMF(new Map([[1, { p: 0.5, count: {} }]]), EPS, false, "my dice");
    expect(named.identifier).toBe("my dice");
    expect(named.normalize().identifier).toBe("my dice");
    expect(named.compact().identifier).toBe("my dice");
    expect(PMF.empty().identifier).toBe("empty");
    expect(PMF.zero().identifier).toBe("zero");
    expect(PMF.missNone().identifier).toBe("missNone");
  });

  it("names a derived PMF from its content, not from the PMFs it came from", () => {
    const die = roll(2, d(6)).toPMF();
    const derived = [
      die.mapDamage((damage) => damage + 1),
      die.scaleMass(0.5),
      die.addScaled(die, 0.25),
      die.applyHitFrequency(0.5),
      die.maxOfTwo(),
      die.prune(0.1),
      die.convolve(die),
      PMF.branch(die, PMF.zero(), 0.3),
      die.splitByFactor(() => 0.5)[0],
    ];
    for (const pmf of derived) expect(pmf.identifier).toMatch(DERIVED_NAME);
  });

  it("stays the same length however many operations were chained", () => {
    // Each of these used to embed its operand's whole identifier; `add(self)` and
    // `branch(self, self)` doubled it every step and threw `Invalid string length` near step 30.
    let doubled = PMF.zero();
    let mixed = PMF.zero();
    let scaled = PMF.zero();
    for (let step = 0; step < 64; step++) {
      doubled = doubled.add(doubled);
      mixed = PMF.branch(mixed, mixed, 0.5);
      scaled = scaled.scaleMass(0.5).mapDamage((damage) => damage + 1);
    }
    for (const pmf of [doubled, mixed, scaled]) expect(pmf.identifier).toMatch(DERIVED_NAME);
    expect(mixed.mass()).toBeCloseTo(1, 12);
    expect(doubled.mass()).toBe(2 ** 64);
  });

  it("round-trips through toJSON", () => {
    const pmf = roll(2, d(6)).toPMF().convolve(roll(1, d(4)).toPMF());
    const json = JSON.parse(pmf.toJSONString());
    expect(json.identifier).toBe(pmf.identifier);
    expect(PMF.fromJSON(json).identifier).toBe(pmf.identifier);
  });
});

describe("PMF.power cache key", () => {
  it("separates the exponent: each power is its own result", () => {
    const die = roll(1, d(6)).toPMF();
    const expected = (n: number) => {
      let acc = die;
      for (let i = 1; i < n; i++) acc = acc.convolve(die);
      return acc;
    };
    for (const n of [2, 3, 4, 5, 8, 9]) {
      const power = die.power(n);
      expect(power.mean()).toBeCloseTo(3.5 * n, 12);
      expect(power.max()).toBe(6 * n);
      for (const value of expected(n).support()) {
        expect(power.pAt(value)).toBeCloseTo(expected(n).pAt(value), 12);
      }
    }
  });

  it("does not hand one PMF's power to another that shares a name", () => {
    const a = new PMF(fromWeights([1, 1, 1, 1]).map, EPS, true, "shared");
    const b = new PMF(fromWeights([4, 3, 2, 1]).map, EPS, true, "shared");
    expect(a.power(3).mean()).toBeCloseTo(3 * 1.5, 12);
    expect(b.power(3).mean()).toBeCloseTo(3 * 1.0, 12);
  });
});
