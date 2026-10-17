import type { Rng } from "../../src/common/rng";

/**
 * Deterministic test rng (the name is the plan's; the generator is mulberry32, since a plain LCG's
 * low bits bias two-die keeps). `die()` rejection-samples a full uint32, `chance()` uses 53 bits.
 */
export function lcgRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    die(sides) {
      const limit = 4294967296 - (4294967296 % sides);
      let x = next();
      while (x >= limit) x = next();
      return (x % sides) + 1;
    },
    chance(p) {
      if (p <= 0) return false;
      if (p >= 1) return true;
      const a = next(),
        b = next();
      return ((a >>> 5) * 67108864 + (b >>> 6)) / 9007199254740992 < p;
    },
  };
}
