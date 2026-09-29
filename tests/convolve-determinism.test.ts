import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d20, d6, d8, roll, turn } from "../src/builder";
import type { Bin } from "../src/index";
import { EPS, PMF, pmfCache } from "../src/index";

/**
 * A float sum depends on the order its terms are added in, so a convolve that walks its operands
 * in an order set by creation order or by what is cached returns a different last bit for the
 * same inputs. These tests build the same content in different orders and compare every bit.
 */

/** Weights that are not round in binary, so a reordered sum can differ. */
function weightsFor(seed: number, size: number): number[] {
  let state = seed;
  return Array.from({ length: size }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return 1 + (state % 9973) / 9973;
  });
}

/** A labelled, attributed PMF over damage 1..size. `order` is the order its bins go into the map. */
function build(seed: number, size: number, order: "ascending" | "descending" | "interleaved"): PMF {
  const weights = weightsFor(seed, size);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const bins: [number, Bin][] = weights.map((weight, index) => {
    const p = weight / total;
    const damage = index + 1;
    return [
      damage,
      {
        p,
        count: { hit: p * 0.7, crit: p * 0.2, miss: p * 0.1 },
        attr: { hit: damage * p * 0.7, crit: damage * p * 0.2 },
      },
    ];
  });
  const ordered =
    order === "ascending"
      ? bins
      : order === "descending"
        ? [...bins].reverse()
        : [...bins.filter((_, i) => i % 2 === 1), ...bins.filter((_, i) => i % 2 === 0)];
  return new PMF(new Map(ordered), EPS, true);
}

/** Every number of the PMF, at full precision, in damage order. */
function bits(pmf: PMF): string {
  return pmf.fingerprint();
}

describe("convolve is a function of content", () => {
  it("does not depend on which equal PMF was created first", () => {
    for (const raw of [false, true]) {
      PMF.clearCache();
      const x1 = build(1, 12, "ascending");
      const y1 = build(2, 12, "ascending");
      const first = x1.convolve(y1, undefined, raw);

      PMF.clearCache();
      // Same content, created in the other order: the other one now has the smaller counter.
      const y2 = build(2, 12, "ascending");
      const x2 = build(1, 12, "ascending");
      const second = x2.convolve(y2, undefined, raw);

      expect(bits(second)).toBe(bits(first));
      expect(second.identifier).toBe(first.identifier);
    }
  });

  it("gives a.convolve(b) and b.convolve(a) the same bits, cold", () => {
    for (const raw of [false, true]) {
      const a = build(3, 15, "ascending");
      const b = build(4, 15, "ascending");
      PMF.clearCache();
      const ab = a.convolve(b, undefined, raw);
      PMF.clearCache();
      const ba = b.convolve(a, undefined, raw);
      expect(bits(ba)).toBe(bits(ab));
    }
  });

  it("does not depend on the order the operands' maps were built in", () => {
    const reference = (() => {
      PMF.clearCache();
      return build(5, 14, "ascending").convolve(build(6, 14, "ascending"), undefined, true);
    })();
    for (const orderA of ["ascending", "descending", "interleaved"] as const) {
      for (const orderB of ["ascending", "descending", "interleaved"] as const) {
        PMF.clearCache();
        const result = build(5, 14, orderA).convolve(build(6, 14, orderB), undefined, true);
        expect(bits(result), `${orderA} x ${orderB}`).toBe(bits(reference));
      }
    }
  });

  it("does not depend on what the cache holds", () => {
    const a = build(7, 13, "ascending");
    const b = build(8, 13, "ascending");
    PMF.clearCache();
    const cold = a.convolve(b, undefined, true);

    // Push the entry out of the cache (capacity 1000), then compute it again.
    for (let i = 0; i < 1100; i++) {
      const filler = build(100 + i, 3, "ascending").convolve(build(2000 + i, 3, "ascending"), undefined, true);
      expect(filler.mass()).toBeCloseTo(1, 12);
    }
    expect(pmfCache.size).toBe(1000);
    const recomputed = a.convolve(b, undefined, true);
    expect(recomputed).not.toBe(cold);
    expect(bits(recomputed)).toBe(bits(cold));
  });

  it("gives power() the same bits from equal PMFs built apart", () => {
    PMF.clearCache();
    const first = build(9, 6, "ascending").power(5);
    PMF.clearCache();
    const second = build(9, 6, "descending").power(5);
    expect(bits(second)).toBe(bits(first));
  });
});

describe("power() of an unnormalized PMF", () => {
  /** Equal content, opposite map order: `mass()` sums in map order, so the two masses differ in the last bit. */
  function unnormalized(descending: boolean): PMF {
    let state = 7;
    const entries = Array.from({ length: 8 }, (_, index): [number, Bin] => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const p = 0.01 + (state % 9973) / 40000;
      return [index + 1, { p, count: { hit: p } }];
    });
    return new PMF(new Map(descending ? entries.reverse() : entries), EPS, false);
  }

  it("does not depend on whether an equal PMF was raised first", () => {
    const a = unnormalized(false);
    const b = unnormalized(true);
    expect(a.fingerprint()).toBe(b.fingerprint());
    expect(a.mass()).not.toBe(b.mass()); // the premise: normalizing them differs in the last bit

    PMF.clearCache();
    const cold = bits(b.power(3));
    PMF.clearCache();
    const raisedFirst = a.power(3);
    expect(raisedFirst.mass()).toBeCloseTo(1, 12);
    const warm = bits(b.power(3));
    expect(warm).toBe(cold);
  });
});

describe("a Turn is a function of its spec", () => {
  const sword = d20.plus(9).ac(16).onHit(d6.plus(5));
  const spec = () =>
    turn()
      .attacks(9, sword)
      .onFirstHit(roll(3, d6), { id: "sneak" })
      .onAnyCrit(roll(2, d8), { id: "smite" })
      .onEveryHit(d6);

  it("walks to the same bits whatever was built or cached before", () => {
    PMF.clearCache();
    const first = spec().pmf;

    // Other work first: PMFs are created and the cache fills with unrelated entries.
    PMF.clearCache();
    const unrelated = Array.from({ length: 25 }, (_, i) => build(300 + i, 7, "ascending"));
    for (let i = 1; i < unrelated.length; i++) {
      expect(unrelated[i - 1].convolve(unrelated[i], undefined, true).mass()).toBeCloseTo(1, 12);
    }
    expect(turn().attacks(3, sword).onEveryHit(d8).mean()).toBeGreaterThan(0);
    const second = spec().pmf;

    expect(bits(second)).toBe(bits(first));
  });
});
