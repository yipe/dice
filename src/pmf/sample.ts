import type { Rng } from "../common/rng";
import type { PMF } from "./pmf";

export interface PMFSample {
  total: number;
  outcome: string;
}

/** The per-value arithmetic of `PMF.scaleDamage`, exported so a sampler rounds the same way. */
export function scaleValue(
  value: number,
  factor: number,
  rounding: "floor" | "round" | "ceil",
  denominator = 1
): number {
  const exact = Number.isInteger(value) && Number.isInteger(factor) && Number.isInteger(denominator);
  if (exact) {
    const numerator = value * factor;
    if (rounding === "round") return Math.floor((2 * numerator + denominator) / (2 * denominator));
    const quotient = numerator / denominator;
    return rounding === "ceil" ? Math.ceil(quotient) : Math.floor(quotient);
  }
  const scaled = (value * factor) / denominator;
  return rounding === "round" ? Math.round(scaled) : rounding === "ceil" ? Math.ceil(scaled) : Math.floor(scaled);
}

/**
 * One draw from an outcome-labelled PMF by inverse CDF, using only `chance`: bins ascending by
 * value, each taken with its conditional probability given the earlier ones were not; then one
 * outcome label inside the bin the same way (labels sorted, so the draw order is fixed).
 */
export function samplePMF(pmf: PMF, rng: Rng): PMFSample {
  const values = [...pmf.map.keys()].sort((a, b) => a - b);
  if (values.length === 0) return { total: 0, outcome: "missNone" };
  let remaining = pmf.mass();
  let chosen = values[values.length - 1];
  for (let i = 0; i < values.length - 1; i++) {
    const p = pmf.map.get(values[i])!.p;
    if (remaining <= 0) break;
    if (rng.chance(p / remaining)) {
      chosen = values[i];
      break;
    }
    remaining -= p;
  }
  const bin = pmf.map.get(chosen)!;
  const labels = Object.keys(bin.count).sort();
  let left = labels.reduce((sum, label) => sum + (bin.count[label] ?? 0), 0);
  let outcome = labels[labels.length - 1] ?? "hit";
  for (let i = 0; i < labels.length - 1; i++) {
    const mass = bin.count[labels[i]] ?? 0;
    if (left <= 0) break;
    if (rng.chance(mass / left)) {
      outcome = labels[i];
      break;
    }
    left -= mass;
  }
  return { total: chosen, outcome };
}
