import { EPS, PMF, pmfCache } from "../";
import { d20PmfFromCdf } from "./prob";
import type { RollType } from "./types";

const cacheKeyMap: Record<string, string> = {
  "flat-flat": "d20",
  "flat-reroll": "hd20",
  "advantage-flat": "d20 > d20",
  "advantage-reroll": "hd20 > hd20",
  "disadvantage-flat": "d20 < d20",
  "disadvantage-reroll": "hd20 < hd20",
  "elven accuracy-flat": "d20 > d20 > d20",
  "elven accuracy-reroll": "hd20 > hd20 > hd20",
};

/** Lift a single d20 PMF into advantage, disadvantage, or elven (triple-advantage). */
export function d20RollPMF(
  rollType: RollType | undefined,
  rerollOne: boolean = false
): PMF {
  rollType = rollType || "flat";
  const cacheKeyLookup = `${rollType}-${rerollOne ? "reroll" : "flat"}`;
  const cacheKey = cacheKeyMap[cacheKeyLookup];
  if (!cacheKey) {
    throw new Error(`Invalid roll type: ${rollType}`);
  }

  const cached = pmfCache.get(cacheKey);
  if (cached) return cached;

  const base = d20PMF(rerollOne);
  if (!rollType || rollType === "flat") {
    pmfCache.set(cacheKey, base);
    return base;
  }

  const p: number[] = new Array(21).fill(0); // indices 1..20
  for (const [r, rec] of base) {
    const pr = typeof rec === "number" ? rec : rec.p;
    if (r >= 1 && r <= 20) p[r] = pr;
  }
  const F: number[] = new Array(21).fill(0);
  for (let k = 1; k <= 20; k++) F[k] = F[k - 1] + p[k];

  const eps = 0;
  let result = base;
  if (rollType === "advantage") {
    result = d20PmfFromCdf((k) => Math.pow(F[k], 2), eps);
  } else if (rollType === "elven accuracy") {
    result = d20PmfFromCdf((k) => Math.pow(F[k], 3), eps);
  } else if (rollType === "disadvantage") {
    result = d20PmfFromCdf((k) => 1 - Math.pow(1 - F[k], 2), eps);
  }

  pmfCache.set(cacheKey, result);
  return result;
}

export function d20PMF(rerollOne: boolean): PMF {
  const cacheKey = `flat-${rerollOne ? "reroll" : "flat"}`;
  const cached = pmfCache.get(cacheKey);
  if (cached) return cached;

  const m = new Map<number, number>();
  const base = 1 / 20;
  const rerollShare = base * base;
  if (!rerollOne) {
    for (let r = 1; r <= 20; r++) {
      m.set(r, base);
    }
  } else {
    for (let r = 1; r <= 20; r++) {
      m.set(r, (r === 1 ? 0 : base) + rerollShare);
    }
  }
  const result = PMF.fromMap(m, EPS);
  pmfCache.set(cacheKey, result);
  return result;
}
