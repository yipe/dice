import { describe, expect, it } from "vitest";
import type { Bin } from "../common/types";
import { PMF } from "./pmf";

type Option = { pmf: PMF; weight: number } | [PMF, number];

/** The pre-optimization definition: validate, then chain the public `addScaled`. */
function referenceMix(options: Option[], eps: number): PMF {
  const items = options.map((o) => (Array.isArray(o) ? { pmf: o[0], weight: o[1] } : o));
  for (const { weight } of items) {
    if (!Number.isFinite(weight)) throw new Error(`PMF.mix: invalid weight ${weight}.`);
  }
  return items.reduce((o, { pmf, weight }) => (Math.abs(weight) <= eps ? o : o.addScaled(pmf, weight)), PMF.empty(eps));
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ["hit", "crit", "miss", "a", "b", "c"];

function randomPMF(r: () => number, eps: number): PMF {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const n = 1 + Math.floor(r() * 40);
  const map = new Map<number, Bin>();
  const mass = pick([1, 1, 0.5, 2.5, 0.01]);
  for (let i = 0; i < n; i++) {
    const dmg = Math.floor(r() * 50) - 15;
    if (map.has(dmg)) continue;
    const value = (): number => pick([0, -0, r() * mass, r() * mass, r() * mass / 7]);
    const labels = (): Record<string, number> => {
      const out: Record<string, number> = {};
      const k = Math.floor(r() * 4);
      for (let j = 0; j < k; j++) out[pick(LABELS)] = value();
      return out;
    };
    const kind = r();
    const bin: Bin = { p: pick([value(), r() * mass / n]), count: labels() };
    if (kind < 0.4) bin.attr = labels();
    else if (kind < 0.55) bin.attr = {};
    map.set(dmg, bin);
  }
  return new PMF(map, eps, r() < 0.5);
}

function randomWeight(r: () => number, eps: number): number {
  const c = [0, 1, 1, -1, -0.5, eps / 2, -eps / 2, r(), r() * 3, -r(), 1e-12, 2];
  return c[Math.floor(r() * c.length)] as number;
}

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    if (x instanceof Map) for (const v of x.values()) deepFreeze(v);
    for (const v of Object.values(x as object)) deepFreeze(v);
  }
  return x;
}

/** The first way `actual` differs from `expected` (compared with `Object.is`), or undefined. */
function firstDifference(actual: PMF, expected: PMF): string | undefined {
  const ak = [...actual.map.keys()];
  const ek = [...expected.map.keys()];
  if (ak.join() !== ek.join()) return `bin order ${ak.join()} vs ${ek.join()}`;
  for (const [dmg, e] of expected.map) {
    const a = actual.map.get(dmg) as Bin;
    if (!Object.is(a.p, e.p)) return `p at ${dmg}: ${a.p} vs ${e.p}`;
    for (const part of ["count", "attr"] as const) {
      const av = a[part];
      const ev = e[part];
      if ((av === undefined) !== (ev === undefined)) return `${part} presence at ${dmg}`;
      if (!av || !ev) continue;
      if (Object.keys(av).join() !== Object.keys(ev).join()) return `${part} label order at ${dmg}`;
      for (const k of Object.keys(ev)) if (!Object.is(av[k], ev[k])) return `${part}.${k} at ${dmg}: ${av[k]} vs ${ev[k]}`;
    }
  }
  if (actual.identifier !== expected.identifier) return "identifier";
  if (actual.epsilon !== expected.epsilon) return "epsilon";
  if (actual.normalized !== expected.normalized) return "normalized";
  if (actual.fingerprint() !== expected.fingerprint()) return "fingerprint";
  if (!Object.is(actual.mean(), expected.mean())) return "mean";
  return undefined;
}

function expectIdentical(actual: PMF, expected: PMF): void {
  expect(firstDifference(actual, expected)).toBeUndefined();
}

describe("PMF.mix is bit-identical to chained addScaled", () => {
  it("matches on 2000 seeded random cases", () => {
    const r = rng(20261021);
    for (let c = 0; c < 2000; c++) {
      const eps = [0, 0, 1e-9, 1e-3][Math.floor(r() * 4)] as number;
      const count = 1 + Math.floor(r() * 8);
      const pool = Array.from({ length: Math.max(1, Math.floor(count / 2)) }, () => randomPMF(r, eps));
      const options: Option[] = Array.from({ length: count }, () => {
        const pmf = pool[Math.floor(r() * pool.length)] as PMF;
        const weight = randomWeight(r, eps);
        return r() < 0.5 ? { pmf, weight } : [pmf, weight];
      });
      expectIdentical(PMF.mix(options, eps), referenceMix(options, eps));
    }
  });

  it("repeats the same instance", () => {
    const p = randomPMF(rng(1), 0);
    const options: Option[] = [{ pmf: p, weight: 0.3 }, [p, 1], { pmf: p, weight: -0.2 }];
    expectIdentical(PMF.mix(options, 0), referenceMix(options, 0));
  });

  it("keeps -0 labels and zeroes them on merge exactly like addScaled", () => {
    const mk = (v: number) => new PMF(new Map([[0, { p: 1, count: { x: v }, attr: { x: v } }]]), 0, false);
    for (const [a, b] of [[-0, -0], [-0, 0], [NaN, 1], [0, -0]] as const) {
      for (const w of [1, 0.5]) {
        const options: Option[] = [{ pmf: mk(a), weight: w }, { pmf: mk(b), weight: w }];
        expectIdentical(PMF.mix(options, 0), referenceMix(options, 0));
      }
    }
    expectIdentical(PMF.mix([[mk(-0), 1]], 0), referenceMix([[mk(-0), 1]], 0));
  });

  it("neither mutates nor aliases frozen inputs", () => {
    const r = rng(7);
    const a = deepFreeze(randomPMF(r, 0));
    const b = deepFreeze(randomPMF(r, 0));
    const before = JSON.stringify([...a.map, ...b.map]);
    const out = PMF.mix([[a, 1], [b, 1], [a, 0.5]], 0);
    expect(JSON.stringify([...a.map, ...b.map])).toBe(before);
    const inputBins = new Set<Bin>([...a.map.values(), ...b.map.values()]);
    for (const bin of out.map.values()) {
      expect(inputBins.has(bin)).toBe(false);
      for (const ib of inputBins) {
        expect(bin.count).not.toBe(ib.count);
        if (bin.attr) expect(bin.attr).not.toBe(ib.attr);
      }
    }
  });

  it("returns the empty PMF when every weight is skipped", () => {
    const p = randomPMF(rng(3), 1e-3);
    const out = PMF.mix([[p, 0], [p, 1e-4], [p, -1e-4]], 1e-3);
    expectIdentical(out, referenceMix([[p, 0], [p, 1e-4], [p, -1e-4]], 1e-3));
    expect(out.identifier).toBe("empty");
    expectIdentical(PMF.mix([], 0), referenceMix([], 0));
  });

  it("returns a new PMF for a single option", () => {
    const p = randomPMF(rng(5), 0);
    const out = PMF.mix([[p, 1]], 0);
    expect(out).not.toBe(p);
    expectIdentical(out, referenceMix([[p, 1]], 0));
  });

  it("keeps an empty non-skipped option unnamed, like addScaled", () => {
    const empty = new PMF(new Map(), 0, false);
    expectIdentical(PMF.mix([[empty, 0.5]], 0), referenceMix([[empty, 0.5]], 0));
  });

  it("rejects invalid weights with the same message", () => {
    const p = randomPMF(rng(9), 0);
    for (const w of [NaN, Infinity, -Infinity]) {
      expect(() => PMF.mix([[p, 0.5], [p, w]], 0)).toThrow(`PMF.mix: invalid weight ${w}.`);
      expect(() => PMF.mix([{ pmf: p, weight: w }, [p, 0]], 1)).toThrow(`PMF.mix: invalid weight ${w}.`);
    }
  });
});
