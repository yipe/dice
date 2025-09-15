import { PMF } from "./pmf";
import type { Bin } from "./types";
import { EPS } from "./types";

type BinEntries = Iterable<[number, Bin]>;

/** A labeled mixture builder that preserves provenance in Bin.count. */
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
   * Weight can be any positive finite number. Very small contributions are pruned by eps.
   */
  add(label: L, pmf: PMF, weight = 1): this {
    if (!Number.isFinite(weight) || weight <= 0) return this;

    // Stream probabilities. Works whether PMF iterates as [v, p] or [v, Bin].
    for (const [v, binOrNumber] of pmf as any as BinEntries) {
      const isNumber = typeof binOrNumber === "number";
      const p = isNumber ? binOrNumber : binOrNumber?.p ?? 0;
      if (p <= 0) continue;

      const add = weight * p;
      if (!Number.isFinite(add) || Math.abs(add) < this.eps) continue;

      this.totals.set(v, (this.totals.get(v) ?? 0) + add);
      const bag = this.labelMass.get(v) ?? ({} as Record<L, number>);
      bag[label] = (bag[label] ?? 0) + add;
      this.labelMass.set(v, bag);
    }

    return this;
  }

  buildPMF(eps: number = EPS): PMF {
    // Kahan sum for robustness.
    let grand = 0;
    let c = 0;
    for (const m of this.totals.values()) {
      const y = m - c;
      const t = grand + y;
      c = t - grand - y;
      grand = t;
    }
    if (!(grand > 0)) throw new Error("LabeledMixture: zero total mass");

    const internal = new Map<number, Bin>();
    for (const [v, m] of this.totals) {
      if (m <= 0 || Math.abs(m) < this.eps) continue;
      const count = this.labelMass.get(v) ?? {};
      internal.set(v, { p: m / grand, count });
    }
    return new PMF(internal, eps);
  }

  /**
   * Produce normalized *per-label* PMFs (labels independent).
   * These are unlabeled PMFs built from the raw mass of that label alone.
   */
  byOutcome(): Record<L, PMF> {
    // Collect the set of labels present.
    const labels = new Set<L>();
    for (const bag of this.labelMass.values()) {
      for (const k of Object.keys(bag) as L[]) labels.add(k);
    }

    const out = {} as Record<L, PMF>;
    for (const label of labels) {
      const m = new Map<number, number>();
      for (const [v, bag] of this.labelMass) {
        const w = bag[label];
        if (w && Math.abs(w) >= this.eps) m.set(v, w);
      }
      if (m.size > 0) out[label] = PMF.fromMap(m, this.eps);
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
    // Normalize
    let total = 0;
    let c = 0;
    for (const v of Object.values(res)) {
      const y = (v as number) - c;
      const t = total + y;
      c = t - total - y;
      total = t;
    }
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
    return mix.buildPMF();
  }
}
