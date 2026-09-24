import type { Bin } from "../common/types";
import { EPS } from "../common/types";
import { PMF } from "./pmf";

/**
 * A labeled mixture builder that preserves provenance in Bin.count.
 *
 * `eps` prunes relative to the normalized mass: an outcome whose share of the total is below
 * `eps` is dropped when the PMF is built, and the survivors are renormalized. `eps = 0` keeps
 * every outcome with positive mass.
 */
export class Mixture<L extends string = string> {
  private readonly totals = new Map<number, number>(); // raw mass per outcome (pre-normalization)
  private readonly labelMass = new Map<number, Record<L, number>>(); // raw mass per outcome per label
  private readonly eps: number;

  constructor(eps: number = EPS) {
    this.eps = Number.isFinite(eps) ? eps : EPS;
  }

  /** Remove all accumulated state. */
  clear(): this {
    this.totals.clear();
    this.labelMass.clear();
    return this;
  }

  /** Number of distinct outcome values currently accumulated. */
  size(): number {
    return this.totals.size;
  }

  /** Whether a label was ever added. */
  hasLabel(label: L): boolean {
    for (const bag of this.labelMass.values()) if (bag[label]) return true;
    return false;
  }

  /**
   * Add a labeled component with a mixture weight.
   * Weight can be any positive finite number; only the ratios between weights matter.
   */
  add(label: L, pmf: PMF, weight = 1): this {
    if (!Number.isFinite(weight) || weight <= 0) return this;

    // Stream probabilities from each [value, Bin] pair.
    for (const [v, bin] of pmf) {
      const p = bin.p;
      if (p <= 0) continue;

      const add = weight * p;
      if (!Number.isFinite(add) || add <= 0) continue;

      this.totals.set(v, (this.totals.get(v) ?? 0) + add);
      const bag = this.labelMass.get(v) ?? ({} as Record<L, number>);
      bag[label] = (bag[label] ?? 0) + add;
      this.labelMass.set(v, bag);
    }

    return this;
  }

  /**
   * The normalized mixture. Each bin's `p` and per-label `count` are its raw mass divided by
   * the grand total, so labels sum to `p` whatever the weights summed to. Outcomes below
   * `eps` of the total (the pruning `eps` given to the constructor) are dropped first.
   *
   * @param eps Epsilon carried by the built PMF.
   */
  buildPMF(eps: number = EPS): PMF {
    const grand = kahanSum(this.totals.values());
    if (!(grand > 0)) throw new Error("Mixture: zero total mass");

    const threshold = this.eps * grand;
    const kept = [...this.totals].filter(([, m]) => m > 0 && m >= threshold);
    if (kept.length === 0) {
      throw new Error(`Mixture: pruning at eps ${this.eps} removed every outcome`);
    }
    const keptTotal =
      kept.length === this.totals.size ? grand : kahanSum(kept.map(([, m]) => m));

    const internal = new Map<number, Bin>();
    for (const [v, m] of kept) {
      const count: Record<string, number> = {};
      const bag = this.labelMass.get(v) ?? ({} as Record<L, number>);
      for (const label in bag) count[label] = bag[label] / keptTotal;
      internal.set(v, { p: m / keptTotal, count });
    }
    return new PMF(internal, eps);
  }

  /**
   * Produce normalized *per-label* PMFs (labels independent).
   * These are unlabeled PMFs built from the raw mass of that label alone; values below `eps`
   * of the label's own mass are pruned.
   */
  byOutcome(): Record<L, PMF> {
    // Collect the set of labels present.
    const labels = new Set<L>();
    for (const bag of this.labelMass.values()) {
      for (const k of Object.keys(bag) as L[]) labels.add(k);
    }

    const out = {} as Record<L, PMF>;
    for (const label of labels) {
      const labelTotal = kahanSum(
        [...this.labelMass.values()].map((bag) => bag[label] ?? 0)
      );
      if (!(labelTotal > 0)) continue;
      const m = new Map<number, number>();
      for (const [v, bag] of this.labelMass) {
        const w = bag[label];
        if (w) m.set(v, w / labelTotal);
      }
      out[label] = PMF.fromMap(m, this.eps);
    }
    return out;
  }

  /**
   * Mixture weights per label, normalized to sum to 1 over labels that appeared.
   * Uses raw mass before per-outcome normalization.
   */
  weights(): Record<L, number> {
    const res = {} as Record<L, number>;
    for (const [, bag] of this.labelMass) {
      for (const [lab, w] of Object.entries(bag) as [L, number][]) {
        if (!Number.isFinite(w) || w <= 0) continue;
        res[lab] = (res[lab] ?? 0) + w;
      }
    }
    const total = kahanSum(Object.values(res) as number[]);
    if (total > 0) {
      for (const k in res) res[k as L] = res[k as L] / total;
    }
    return res;
  }

  toJSON(): {
    totals: Array<[number, number]>;
    labels: Array<[number, Record<L, number>]>;
    eps: number;
  } {
    return {
      totals: Array.from(this.totals.entries()).sort((a, b) => a[0] - b[0]),
      labels: Array.from(this.labelMass.entries()).sort((a, b) => a[0] - b[0]),
      eps: this.eps,
    };
  }

  static mix<L extends string = string>(
    items: Array<[label: L, pmf: PMF, weight: number]>,
    eps: number = EPS
  ): PMF {
    const mix = new Mixture<L>(eps);
    for (const [lab, pmf, w] of items) mix.add(lab, pmf, w);
    return mix.buildPMF(eps);
  }
}

/** Compensated (Kahan) sum. */
function kahanSum(values: Iterable<number>): number {
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const y = v - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}
