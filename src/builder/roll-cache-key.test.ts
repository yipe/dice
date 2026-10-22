import { describe, expect, it } from "vitest";
import { d20, d6, roll, RollBuilder } from "./index";
import { jsonRollKey, rollConfigsKey } from "./roll-cache-key";
import type { RollConfig } from "./types";

const oldKey = (configs: readonly RollConfig[]): string =>
  JSON.stringify(configs, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? `#${v}` : v));

const FIELDS = ["count", "sides", "modifier", "reroll", "explode", "explodePoolBudget", "minimum", "bestOf", "keep", "rollType", "isSubtraction", "pinned"] as const;

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

const NUMS = [0, -0, 1, 2, 6, 20, -3, 0.5, 1e21, 1e-7, NaN, Infinity, -Infinity, undefined];
const MODES = ["highest", "lowest", "normal", "advantage", "disadvantage", "a_b", "x*y", undefined];

function randomConfig(r: () => number): RollConfig {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const c: Record<string, unknown> = {};
  for (const f of ["count", "sides", "modifier", "reroll", "explode", "explodePoolBudget", "minimum", "bestOf"]) {
    if (r() < 0.9) c[f] = pick(NUMS);
  }
  const k = r();
  if (k < 0.3) c["keep"] = { total: pick(NUMS), count: pick(NUMS), mode: pick(MODES) };
  else if (k < 0.4) c["keep"] = undefined;
  if (r() < 0.8) c["rollType"] = pick(["normal", "advantage", "disadvantage", undefined]);
  if (r() < 0.5) c["isSubtraction"] = pick([true, false, undefined]);
  if (r() < 0.3) c["pinned"] = pick([true, undefined]);
  return c as unknown as RollConfig;
}

/** Field values compared with `Object.is`, except that -0 equals 0. */
const same = (a: unknown, b: unknown): boolean => (a === 0 && b === 0) || Object.is(a, b);
function equalConfigs(a: RollConfig[], b: RollConfig[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] as RollConfig;
    return FIELDS.every((f) => {
      if (f === "keep") {
        const kx = x.keep;
        const ky = y.keep;
        if (kx === undefined || ky === undefined) return kx === ky;
        return same(kx.total, ky.total) && same(kx.count, ky.count) && same(kx.mode, ky.mode);
      }
      return same(x[f], y[f]);
    });
  });
}

const cfg = (c: Record<string, unknown>) => c as unknown as RollConfig;

describe("rollConfigsKey", () => {
  it("is an exact refinement of the old key on seeded random configs", () => {
    const r = rng(42);
    const pool: RollConfig[][] = [];
    for (let i = 0; i < 400; i++) {
      pool.push(Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomConfig(r)));
    }
    // Near-duplicates so equal keys actually occur.
    for (let i = 0; i < 200; i++) pool.push(structuredClone(pool[Math.floor(r() * 400)] as RollConfig[]));
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i] as RollConfig[];
      const ka = rollConfigsKey(a);
      if (ka.startsWith("~")) expect(ka).not.toMatch(/[*|]/);
      else expect(ka).toBe(oldKey(a));
      for (let j = i; j < pool.length; j += 3) {
        const b = pool[j] as RollConfig[];
        const kb = rollConfigsKey(b);
        if (oldKey(a) === oldKey(b)) expect(ka).toBe(kb);
        if (ka === kb) expect(equalConfigs(a, b)).toBe(true);
      }
    }
  });

  it("keeps NaN, Infinity and -Infinity distinct from each other and from finite numbers", () => {
    const keys = [NaN, Infinity, -Infinity, 0, 1, -1, 1e308].map((v) => rollConfigsKey([cfg({ count: v })]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("shares a key between -0 and 0", () => {
    expect(rollConfigsKey([cfg({ modifier: -0 })])).toBe(rollConfigsKey([cfg({ modifier: 0 })]));
  });

  it("treats absent and undefined alike, and distinct from every present value", () => {
    const absent = rollConfigsKey([cfg({ count: 1 })]);
    expect(rollConfigsKey([cfg({ count: 1, explodePoolBudget: undefined })])).toBe(absent);
    for (const v of [0, NaN, 1]) expect(rollConfigsKey([cfg({ count: 1, explodePoolBudget: v })])).not.toBe(absent);
    const sub = (v: unknown) => rollConfigsKey([cfg({ count: 1, isSubtraction: v })]);
    expect(sub(undefined)).toBe(absent);
    expect(sub(false)).not.toBe(sub(undefined));
    expect(sub(true)).not.toBe(sub(false));
    expect(rollConfigsKey([cfg({ count: 1, rollType: "_" })])).not.toBe(absent);
    expect(rollConfigsKey([cfg({ count: 1, pinned: true })])).not.toBe(absent);
  });

  it("separates keep unset, undefined and each field", () => {
    const k = (keep: unknown) => rollConfigsKey([cfg({ count: 4, sides: 6, keep })]);
    expect(k(undefined)).toBe(rollConfigsKey([cfg({ count: 4, sides: 6 })]));
    const set = k({ total: 4, count: 3, mode: "highest" });
    expect(set).not.toBe(k(undefined));
    expect(set).not.toBe(k({ total: 4, count: 3, mode: "lowest" }));
    expect(set).not.toBe(k({ total: 4, count: 2, mode: "highest" }));
    expect(set).not.toBe(k({ total: 3, count: 4, mode: "highest" }));
  });

  it("distinguishes configs by position in a multi-config array", () => {
    const a = cfg({ count: 1, sides: 6 });
    const b = cfg({ count: 2, sides: 8 });
    expect(rollConfigsKey([a, b])).not.toBe(rollConfigsKey([b, a]));
    expect(rollConfigsKey([a])).not.toBe(rollConfigsKey([a, a]));
    expect(rollConfigsKey([])).toBe("~");
  });

  it("falls back to JSON for an unknown config key, keep key or field type", () => {
    const cases: RollConfig[][] = [
      [cfg({ count: 1, mystery: 3 })],
      [cfg({ count: 1, keep: { total: 1, count: 1, mode: "highest", extra: 1 } })],
      [cfg({ count: "1" })],
      [cfg({ count: 1, rollType: 5 })],
      [cfg({ count: 1, rollType: "a|b" })],
      [cfg({ count: 1, isSubtraction: 1 })],
      [cfg({ count: 1, pinned: "yes" })],
      [cfg({ count: 1, keep: { total: 1, count: 1, mode: 7 } })],
    ];
    for (const c of cases) {
      expect(rollConfigsKey(c)).toBe(jsonRollKey(c));
      expect(rollConfigsKey(c)).toBe(oldKey(c));
    }
  });

  it("never equals a JSON-fallback key", () => {
    const r = rng(9);
    for (let i = 0; i < 300; i++) {
      const c = [randomConfig(r)];
      if (!rollConfigsKey(c).startsWith("~")) continue; // a fallback key is the JSON key by design
      expect(rollConfigsKey(c)).not.toBe(oldKey(c));
      expect(oldKey(c).startsWith("~")).toBe(false);
    }
  });

  it("does not let extra '*', '|' or a trailing e<eps> blur a composite", () => {
    const a = [cfg({ count: 1, sides: 6 })];
    const b = [cfg({ count: 1, sides: 6, modifier: 1 })];
    const wrap = (k: string, e: number) => `${k}*e${e}`;
    expect(wrap(rollConfigsKey(a), 0)).not.toBe(wrap(rollConfigsKey(b), 0));
    expect(wrap(rollConfigsKey(a), 1)).not.toBe(wrap(rollConfigsKey(a), 10));
    expect(rollConfigsKey(a).endsWith("]")).toBe(true);
  });
});

describe("RollBuilder.cacheKey", () => {
  it("uses the new key, memoized, and equal builders agree", () => {
    const a = roll(2, d6).plus(4);
    expect(a.cacheKey()).toBe(rollConfigsKey(a.getSubRollConfigs()));
    expect(a.cacheKey()).toBe(roll(2, d6).plus(4).cacheKey());
    expect(a.cacheKey()).not.toBe(roll(2, d6).plus(5).cacheKey());
    expect(d20.cacheKey()).not.toBe(d20.plus(1).cacheKey());
    expect(RollBuilder.fromConfig({ count: NaN }).cacheKey()).not.toBe(RollBuilder.fromConfig({ count: Infinity }).cacheKey());
  });
});
