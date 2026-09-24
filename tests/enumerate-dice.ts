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

/** Value → outcome label → probability: the labelled distribution of an attack. */
export type LabelledDist = Map<number, Record<string, number>>;

export interface AttackSpec {
  /** The natural roll a crit is read from: `uniform(20)`, or `max(uniform(20), uniform(20))` with advantage. */
  natural: Dist;
  /** The rest of the check total, added to the natural roll: its flats and bonus dice. */
  bonus: Dist;
  /** The AC: the check lands where its total is at least this. */
  target: number;
  /** A landing on a natural face of this or more crits; 21 never crits. */
  critFrom: number;
  hit: Dist;
  crit: Dist;
  /** What a miss deals, under `missLabel` (default `missDamage`); with none a miss is 0, `missNone`. */
  miss?: Dist;
  missLabel?: string;
}

/**
 * An attack under parse()'s rules, by listing every natural roll and bonus: it lands where its
 * total meets the target (no natural-1 miss, no natural-20 hit) and crits where it lands on a
 * natural face of `critFrom` or more.
 */
export function attack(spec: AttackSpec): LabelledDist {
  const out: LabelledDist = new Map();
  const put = (value: number, label: string, p: number): void => {
    const bin = out.get(value) ?? {};
    bin[label] = (bin[label] ?? 0) + p;
    out.set(value, bin);
  };
  for (const [natural, pn] of spec.natural) {
    for (const [bonus, pb] of spec.bonus) {
      const p = pn * pb;
      if (natural + bonus >= spec.target) {
        const [label, damage] = natural >= spec.critFrom ? ["crit", spec.crit] : ["hit", spec.hit];
        for (const [value, pv] of damage) put(value, label, p * pv);
      } else if (spec.miss) {
        for (const [value, pv] of spec.miss) put(value, spec.missLabel ?? "missDamage", p * pv);
      } else {
        put(0, "missNone", p);
      }
    }
  }
  return out;
}

/** An `&` mix of labelled distributions, each weighted by its share. */
export function mixLabelled(...parts: [LabelledDist, number][]): LabelledDist {
  const out: LabelledDist = new Map();
  for (const [part, weight] of parts) {
    for (const [value, labels] of part) {
      const bin = out.get(value) ?? {};
      for (const [label, p] of Object.entries(labels)) bin[label] = (bin[label] ?? 0) + weight * p;
      out.set(value, bin);
    }
  }
  return out;
}

/** Every bin of `actual` and every label in it equals `expected` to 1e-12, with no extra or missing support. */
export function expectLabelled(actual: PMF, expected: LabelledDist): void {
  const support = new Set([...actual.support(), ...expected.keys()]);
  for (const value of support) {
    const want = expected.get(value) ?? {};
    const total = Object.values(want).reduce((sum, p) => sum + p, 0);
    expect(Math.abs(actual.pAt(value) - total), `bin ${value}`).toBeLessThanOrEqual(1e-12);
    const got = (actual.map.get(value)?.count ?? {}) as Record<string, number | undefined>;
    for (const label of new Set([...Object.keys(got), ...Object.keys(want)])) {
      expect(Math.abs((got[label] ?? 0) - (want[label] ?? 0)), `bin ${value} ${label}`).toBeLessThanOrEqual(1e-12);
    }
  }
  expect(Math.abs(actual.mass() - 1)).toBeLessThanOrEqual(1e-12);
}

/** Two PMFs agree bin for bin and label for label, to 1e-12. */
export function expectSameLabelled(actual: PMF, expected: PMF): void {
  const labelled: LabelledDist = new Map();
  for (const value of expected.support()) {
    labelled.set(value, { ...(expected.map.get(value)?.count ?? {}) } as Record<string, number>);
  }
  expectLabelled(actual, labelled);
}
