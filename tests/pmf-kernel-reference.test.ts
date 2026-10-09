/**
 * The convolution and merge kernels, pinned bit for bit to a plain reference: the map walk
 * `PMF.convolve` is specified as (for each A bin in damage order, each B bin; within a pair, A's
 * labels then B's; every cell starts at 0), the mass invariant as `scaleBin` applies it, and
 * `addScaled` as "copy every bin of this, then merge the branch's bins in". The library's
 * kernels take shortcuts (flat arrays, a one-bin operand built directly, the rescale in place,
 * one merge pass); these random PMFs — bins with differing label sets in differing key orders,
 * attributions that are negative or missing, zero-mass bins, single bins, non-integer supports,
 * masses that are not 1 — must come out the same to the bit, map order and key order included.
 */
import { describe, expect, it } from "vitest";
import type { Bin } from "../src/index";
import { EPS, PMF } from "../src/index";
import { DenseTotal } from "../src/pmf/dense-total";

type Labels = Partial<Record<string, number>>;

/** A seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ["hit", "crit", "missNone", "missDamage", "saveFail"];

/** Some of `LABELS` in a random order, with random values (negative allowed where `signed`). */
function randomLabels(random: () => number, signed: boolean): Labels {
  const labels = LABELS.filter(() => random() < 0.6).sort(() => random() - 0.5);
  const out: Labels = {};
  for (const label of labels) {
    const value = random() < 0.1 ? 0 : random() * (signed && random() < 0.3 ? -1 : 1);
    out[label] = value;
  }
  return out;
}

interface Shape {
  bins?: number;
  integer?: boolean;
  normalized?: boolean;
  zeroMass?: boolean;
}

/** A random PMF: `bins` damages (random, integer or not), bins in a random map order. */
function randomPmf(random: () => number, shape: Shape = {}): PMF {
  const n = shape.bins ?? 1 + Math.floor(random() * 12);
  const integer = shape.integer ?? random() < 0.8;
  const damages = new Set<number>();
  while (damages.size < n) damages.add(integer ? Math.floor(random() * 40) - 5 : Math.round(random() * 400) / 8 - 5);
  const entries: [number, Bin][] = [...damages].map((damage) => {
    const p = shape.zeroMass || random() < 0.08 ? 0 : random();
    const bin: Bin = { p, count: randomLabels(random, false) };
    if (random() < 0.5) bin.attr = randomLabels(random, true);
    return [damage, bin];
  });
  const map = new Map(entries.sort(() => random() - 0.5));
  if (shape.normalized === true) {
    let total = 0;
    for (const { p } of map.values()) total += p;
    for (const bin of map.values()) {
      bin.p = total === 0 ? 0 : bin.p / total;
    }
  }
  return new PMF(map, EPS, shape.normalized === true);
}

/** Every number as its float64 bits (so `-0` and `+0` differ), map order and key order kept. */
function bitsOf(pmf: PMF): string {
  const view = new DataView(new ArrayBuffer(8));
  const hex = (value: number): string => {
    view.setFloat64(0, value);
    return view.getBigUint64(0).toString(16);
  };
  const labels = (m: Labels | undefined): string =>
    m === undefined ? "-" : Object.keys(m).map((key) => `${key}=${hex(m[key] as number)}`).join(",");
  return [...pmf.map].map(([damage, bin]) => `${damage}:${hex(bin.p)}[${labels(bin.count)}]{${labels(bin.attr)}}`).join(";");
}

// --- the reference ---------------------------------------------------------------------------

/** The map walk, as specified: pairs in damage order, A's labels then B's, cells from 0. */
function referenceConvolveBins(A: PMF, B: PMF): Map<number, Bin> {
  const out = new Map<number, Bin>();
  const aDamages = [...A.map.keys()].sort((x, y) => x - y);
  const bDamages = [...B.map.keys()].sort((x, y) => x - y);
  for (const aVal of aDamages) {
    const a = A.map.get(aVal) as Bin;
    for (const bVal of bDamages) {
      const b = B.map.get(bVal) as Bin;
      let dest = out.get(aVal + bVal);
      if (dest === undefined) out.set(aVal + bVal, (dest = { p: 0, count: {} }));
      dest.p += a.p * b.p;
      for (const k in a.count) dest.count[k] = (dest.count[k] || 0) + (a.count[k] as number) * b.p;
      for (const k in b.count) dest.count[k] = (dest.count[k] || 0) + (b.count[k] as number) * a.p;
      if (a.attr || b.attr) {
        dest.attr ??= {};
        if (a.attr) for (const k in a.attr) dest.attr[k] = (dest.attr[k] || 0) + (a.attr[k] as number) * b.p;
        if (b.attr) for (const k in b.attr) dest.attr[k] = (dest.attr[k] || 0) + (b.attr[k] as number) * a.p;
      }
    }
  }
  return out;
}

/** The operand order a convolve uses, read off the fingerprints the reference does not need. */
const ordered = (x: PMF, y: PMF): [PMF, PMF] => (x.fingerprint() <= y.fingerprint() ? [x, y] : [y, x]);

const massOf = (map: ReadonlyMap<number, Bin>): number => {
  let total = 0;
  for (const { p } of map.values()) total += p;
  return total;
};

/** `scaleBin`, as the mass invariant copies a bin. */
function scaleBin(bin: Bin, factor: number): Bin {
  const count: Labels = {};
  for (const k in bin.count) count[k] = (bin.count[k] as number) * factor;
  const out: Bin = { p: bin.p * factor, count };
  if (bin.attr) {
    const attr: Labels = {};
    for (const k in bin.attr) attr[k] = (bin.attr[k] as number) * factor;
    out.attr = attr;
  }
  return out;
}

/** `convolveRaw` as specified: the walk, then the mass invariant `mass(out) = mass(A) · mass(B)`. */
function referenceConvolveRaw(A: PMF, B: PMF, eps: number): PMF {
  let map = referenceConvolveBins(A, B);
  const mExp = A.mass() * B.mass();
  const mGot = massOf(map);
  if (mExp !== 0 && mGot !== 0 && Math.abs(mGot - mExp) > eps) {
    const factor = mExp / mGot;
    map = new Map([...map].map(([damage, bin]) => [damage, scaleBin(bin, factor)]));
  }
  return new PMF(map, eps, false);
}

/**
 * `convolve` (not raw) as specified: an operand whose mass is not 1 is normalized first; the
 * walk; the mass invariant toward 1, which leaves the result unnormalized; then a normalize
 * where the mass is still off.
 */
function referenceConvolve(x: PMF, y: PMF, eps: number): PMF {
  const norm = (pmf: PMF): PMF => (Math.abs(pmf.mass() - 1) <= eps ? pmf : pmf.normalize());
  const [A, B] = ordered(norm(x), norm(y));
  let map = referenceConvolveBins(A, B);
  const mGot = massOf(map);
  let normalized = true;
  if (mGot !== 0 && Math.abs(mGot - 1) > eps) {
    const factor = 1 / mGot;
    map = new Map([...map].map(([damage, bin]) => [damage, scaleBin(bin, factor)]));
    normalized = false;
  }
  let result = new PMF(map, eps, normalized);
  if (mGot !== 0 && Math.abs(result.mass() - 1) > eps) result = result.normalize();
  return result;
}

const cloneBin = (bin: Bin): Bin => ({ p: bin.p, count: { ...bin.count }, attr: bin.attr ? { ...bin.attr } : undefined });

/** `addScaled` as specified: copy every bin of this, then merge each branch bin (scaled) in. */
function referenceAddScaled(self: PMF, branch: PMF, probability: number): PMF {
  if (probability === 0) return self;
  const out = new Map<number, Bin>();
  for (const [damage, bin] of self.map) out.set(damage, cloneBin(bin));
  for (const [damage, bin] of branch.map) {
    const add = probability === 1 ? bin : scaleBin(bin, probability);
    const existing = out.get(damage);
    if (existing === undefined) {
      out.set(damage, cloneBin(add));
      continue;
    }
    existing.p += add.p;
    for (const k in add.count) existing.count[k] = (existing.count[k] || 0) + (add.count[k] as number);
    if (add.attr) {
      existing.attr ??= {};
      for (const k in add.attr) existing.attr[k] = (existing.attr[k] || 0) + (add.attr[k] as number);
    }
  }
  return new PMF(out, self.epsilon, false);
}

// --- the pins --------------------------------------------------------------------------------

describe("the convolution kernel is the reference walk, bit for bit", () => {
  const SEEDS = Array.from({ length: 400 }, (_, i) => 7000 + i);

  it.each(SEEDS)("seed %i", (seed) => {
    const random = rng(seed);
    const x = randomPmf(random);
    const y = randomPmf(random);
    const [A, B] = ordered(x, y);
    // At the default epsilon and at 0, where the mass invariant rescales on any drift.
    for (const eps of [EPS, 0]) {
      const expected = bitsOf(referenceConvolveRaw(A, B, eps));
      expect(bitsOf(x.convolveRaw(y, eps)), `raw eps ${eps}`).toBe(expected);
      expect(bitsOf(y.convolveRaw(x, eps)), `raw eps ${eps}`).toBe(expected);
      // The cached, normalizing convolve too (the builders' path), its normalize and rescale included.
      PMF.clearCache();
      const normalized = bitsOf(referenceConvolve(x, y, eps));
      expect(bitsOf(x.convolve(y, eps)), `eps ${eps}`).toBe(normalized);
      PMF.clearCache();
      expect(bitsOf(y.convolve(x, eps)), `eps ${eps}`).toBe(normalized);
    }
  });

  it.each(SEEDS.slice(0, 200))("one-bin operand, seed %i", (seed) => {
    const random = rng(seed);
    const one = randomPmf(random, { bins: 1, integer: random() < 0.7 });
    const many = randomPmf(random, { integer: random() < 0.7 });
    const [A, B] = ordered(one, many);
    const expected = bitsOf(referenceConvolveRaw(A, B, EPS));
    expect(bitsOf(one.convolveRaw(many))).toBe(expected);
    expect(bitsOf(many.convolveRaw(one))).toBe(expected);
    const [C, D] = ordered(one, one);
    expect(bitsOf(one.convolveRaw(one))).toBe(bitsOf(referenceConvolveRaw(C, D, EPS)));
  });

  it("a one-bin operand whose pairs round to one damage takes the map walk", () => {
    // 2^53 + 1 and 2^53 + 2 are 2^53 + 2 and 2^53 + 2 once a half is added and rounded.
    const big = new PMF(new Map([[2 ** 53, { p: 0.5, count: { hit: 0.5 } }], [2 ** 53 + 2, { p: 0.5, count: { hit: 0.5 } }]]), EPS, false);
    const half = new PMF(new Map([[1, { p: 1, count: { hit: 1 } }]]), EPS, false);
    const [A, B] = ordered(big, half);
    expect(bitsOf(big.convolveRaw(half))).toBe(bitsOf(referenceConvolveRaw(A, B, EPS)));
  });

  it.each(SEEDS.slice(0, 100))("zero-mass operands, seed %i", (seed) => {
    const random = rng(seed);
    const zero = randomPmf(random, { zeroMass: true });
    const other = randomPmf(random);
    const [A, B] = ordered(zero, other);
    expect(bitsOf(zero.convolveRaw(other))).toBe(bitsOf(referenceConvolveRaw(A, B, EPS)));
  });
});

describe("the merge kernel is the reference merge, bit for bit", () => {
  const SEEDS = Array.from({ length: 400 }, (_, i) => 9000 + i);

  it.each(SEEDS)("seed %i", (seed) => {
    const random = rng(seed);
    const self = randomPmf(random);
    // The branch shares some damages with this PMF and brings others.
    const branch = randomPmf(random);
    const probability = random() < 0.5 ? 1 : random() < 0.1 ? 0 : random();
    expect(bitsOf(self.addScaled(branch, probability))).toBe(bitsOf(referenceAddScaled(self, branch, probability)));
    expect(bitsOf(self.add(branch))).toBe(bitsOf(referenceAddScaled(self, branch, 1)));
    expect(bitsOf(branch.add(self))).toBe(bitsOf(referenceAddScaled(branch, self, 1)));
  });
});

describe("a dense total is the PMF it stands for, bit for bit, after every operation", () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => 11000 + i);

  /** A random walk of the joint ledger's operations, the PMF beside the dense total at each step. */
  it.each(SEEDS)("seed %i", (seed) => {
    const random = rng(seed);
    const eps = random() < 0.5 ? 0 : EPS;
    let pmf = PMF.delta(0, eps);
    let total = DenseTotal.of(pmf, eps);
    // A second running total to merge in, built the same way.
    let otherPmf = PMF.delta(0, eps);
    let other = DenseTotal.of(otherPmf, eps);
    const steps = 2 + Math.floor(random() * 6);
    for (let step = 0; step < steps; step++) {
      const op = random();
      if (op < 0.55) {
        // A slice: mostly integer, sometimes one bin, sometimes non-integer (the PMF path), sometimes zero mass.
        const slice = randomPmf(random, {
          bins: random() < 0.25 ? 1 : undefined,
          integer: random() < 0.85,
          normalized: random() < 0.3,
          zeroMass: random() < 0.05,
        });
        pmf = pmf.convolveRaw(slice, eps);
        total = total.convolve(slice);
      } else if (op < 0.75) {
        const factor = random() < 0.2 ? 1 : random();
        pmf = pmf.scaleMass(factor);
        total = total.scale(factor);
      } else if (op < 0.9) {
        const slice = randomPmf(random, { integer: true });
        otherPmf = otherPmf.convolveRaw(slice, eps);
        other = other.convolve(slice);
        pmf = pmf.add(otherPmf);
        total = total.add(other);
      } else {
        pmf = otherPmf.add(pmf);
        total = other.add(total);
      }
      expect(bitsOf(total.toPMF()), `step ${step}`).toBe(bitsOf(pmf));
      expect(total.mass(), `step ${step} mass`).toBe(pmf.mass());
      expect(total.toPMF().normalized, `step ${step} normalized`).toBe(pmf.normalized);
    }
  });
});
