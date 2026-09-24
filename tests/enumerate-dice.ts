import { expect } from "vitest";
import type { PMF } from "../src/pmf/pmf";

/**
 * Brute-force distributions for exactness tests: every outcome is enumerated explicitly, so a test
 * checks the library against arithmetic that shares none of its code.
 */
export type Dist = Map<number, number>;

export function point(value: number): Dist {
  return new Map([[value, 1]]);
}

export function uniform(sides: number): Dist {
  const out: Dist = new Map();
  for (let face = 1; face <= sides; face++) out.set(face, 1 / sides);
  return out;
}

/** Distribution of `f(a, b)` for independent `a ~ x`, `b ~ y`. */
export function combine(x: Dist, y: Dist, f: (a: number, b: number) => number): Dist {
  const out: Dist = new Map();
  for (const [a, pa] of x) {
    for (const [b, pb] of y) {
      const v = f(a, b);
      out.set(v, (out.get(v) ?? 0) + pa * pb);
    }
  }
  return out;
}

export function add(...parts: Dist[]): Dist {
  return parts.reduce((acc, part) => combine(acc, part, (a, b) => a + b), point(0));
}

export function repeat(x: Dist, times: number): Dist {
  return add(...Array.from({ length: times }, () => x));
}

export function map(x: Dist, f: (v: number) => number): Dist {
  const out: Dist = new Map();
  for (const [v, p] of x) out.set(f(v), (out.get(f(v)) ?? 0) + p);
  return out;
}

export function negate(x: Dist): Dist {
  return map(x, (v) => -v);
}

export function shift(x: Dist, by: number): Dist {
  return map(x, (v) => v + by);
}

export function max(...parts: Dist[]): Dist {
  return parts.reduce((acc, part) => combine(acc, part, Math.max));
}

export function min(...parts: Dist[]): Dist {
  return parts.reduce((acc, part) => combine(acc, part, Math.min));
}

/** Sum of the `keep` highest (or lowest) of `total` independent draws from `x`, by listing every tuple. */
export function keep(x: Dist, total: number, keepCount: number, highest: boolean): Dist {
  let tuples: [number[], number][] = [[[], 1]];
  for (let i = 0; i < total; i++) {
    const next: [number[], number][] = [];
    for (const [values, p] of tuples) {
      for (const [v, pv] of x) next.push([[...values, v], p * pv]);
    }
    tuples = next;
  }
  const out: Dist = new Map();
  for (const [values, p] of tuples) {
    const sorted = [...values].sort((a, b) => (highest ? b - a : a - b));
    const sum = sorted.slice(0, keepCount).reduce((s, v) => s + v, 0);
    out.set(sum, (out.get(sum) ?? 0) + p);
  }
  return out;
}

export function mean(x: Dist): number {
  let m = 0;
  for (const [v, p] of x) m += v * p;
  return m;
}

/** Every bin of `actual` equals `expected` to 1e-12, with no extra or missing support. */
export function expectDist(actual: PMF, expected: Dist): void {
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    expect(Math.abs(actual.pAt(value) - (expected.get(value) ?? 0)), `bin ${value}`).toBeLessThanOrEqual(1e-12);
  }
  expect(Math.abs(actual.mass() - 1)).toBeLessThanOrEqual(1e-12);
}
