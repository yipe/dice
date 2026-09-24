import { afterEach, describe, expect, it } from "vitest";
import { builderPMFCache, clearRollCache, d, roll } from "../src/builder";
import type { Bin } from "../src/index";
import { LRUCache, PMF, pmfCache, setCachingEnabled } from "../src/index";

describe("cached PMFs are immutable", () => {
  it("a cached die PMF rejects bin mutation and later rolls stay exact", () => {
    const die = roll(1, d(6)).toPMF();
    const bin = die.map.get(3) as Bin;
    expect(Object.isFrozen(bin)).toBe(true);
    expect(() => {
      bin.p = 99;
    }).toThrow(TypeError);
    expect(() => {
      bin.count.hit = 1;
    }).toThrow(TypeError);
    expect(roll(3, d(6)).toPMF().mean()).toBeCloseTo(21 / 2, 12);
  });

  it("convolution results are frozen when cached", () => {
    const a = roll(1, d(4)).toPMF();
    const sum = a.convolve(roll(1, d(8)).toPMF());
    for (const [, bin] of sum) {
      expect(Object.isFrozen(bin)).toBe(true);
      expect(Object.isFrozen(bin.count)).toBe(true);
    }
  });

  it("clearRollCache also drops the single-die cache", () => {
    const before = roll(1, d(10)).toPMF();
    builderPMFCache.clear();
    clearRollCache();
    const after = roll(1, d(10)).toPMF();
    expect(after).not.toBe(before);
    expect(after.pAt(7)).toBe(before.pAt(7));
  });
});

describe("convolution cache keys", () => {
  it("label keys containing separators do not collide", () => {
    // Without escaping, both bins serialize their labels as `x:0.5,y:0.5`.
    const twoLabels = new PMF(
      new Map<number, Bin>([[1, { p: 1, count: { x: 0.5, y: 0.5 } }]]),
      1e-12,
      true,
      "crafted"
    );
    const oneLabel = new PMF(
      new Map<number, Bin>([[1, { p: 1, count: { "x:0.5,y": 0.5 } }]]),
      1e-12,
      true,
      "crafted"
    );
    expect(twoLabels.fingerprint()).not.toBe(oneLabel.fingerprint());
    expect(twoLabels.convolve(twoLabels).outcomeAt(2, "x")).toBeCloseTo(1, 15);
    const sum = oneLabel.convolve(oneLabel);
    expect(sum.outcomeAt(2, "x:0.5,y")).toBeCloseTo(1, 15);
    expect(sum.outcomeAt(2, "x")).toBe(0);
  });
});

describe("power() provenance", () => {
  it("does not mark a shared cached convolution as provenance-free", () => {
    const base = new PMF(
      new Map<number, Bin>([
        [1, { p: 0.5, count: { hit: 0.5 } }],
        [2, { p: 0.5, count: { crit: 0.5 } }],
      ]),
      1e-12,
      true,
      "provenance-base"
    );
    const folded = base.power(2);
    const convolved = base.convolve(base);
    expect(folded.preservedProvenance()).toBe(false);
    expect(convolved.preservedProvenance()).toBe(true);
    expect(folded.pAt(3)).toBe(convolved.pAt(3));
  });
});

describe("LRUCache capacity", () => {
  it("a zero or negative capacity stores nothing", () => {
    for (const capacity of [0, -1]) {
      const cache = new LRUCache<string, number>(capacity);
      cache.set("a", 1);
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    }
  });

  it("a capacity of 1 keeps only the newest entry", () => {
    const cache = new LRUCache<string, number>(1);
    cache.set("a", 1).set("b", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("b")).toBe(2);
  });
});

describe("setCachingEnabled", () => {
  afterEach(() => setCachingEnabled(true));

  it("disables the convolution cache too", () => {
    setCachingEnabled(false);
    expect(pmfCache.size).toBe(0);
    const a = roll(1, d(6)).toPMF();
    const b = roll(1, d(8)).toPMF();
    const first = a.convolve(b);
    const second = a.convolve(b);
    expect(second).not.toBe(first);
    expect(pmfCache.size).toBe(0);
    expect(second.pAt(9)).toBe(first.pAt(9));
  });
});

describe("caches that follow the caching toggle", () => {
  afterEach(() => setCachingEnabled(true));

  it("are emptied by turning caching off, even when created before any other cache", () => {
    const cache = new LRUCache<string, number>(10, { followsCachingToggle: true });
    cache.set("a", 1);
    setCachingEnabled(false);
    setCachingEnabled(true);
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    cache.set("b", 2);
    expect(cache.get("b")).toBe(2);
  });

  it("a cache that does not follow the toggle keeps its entries", () => {
    const cache = new LRUCache<string, number>(10);
    cache.set("a", 1);
    setCachingEnabled(false);
    setCachingEnabled(true);
    expect(cache.get("a")).toBe(1);
  });
});
