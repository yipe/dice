/**
 * A walk's running damage total kept as flat arrays between steps, so a state's damage is
 * convolved, merged and scaled without materializing a bin object per damage value until the
 * walk ends. Every operation is the PMF one it stands for, to the bit: the same products and
 * sums in the same order, the same operand order, the same map and label-key orders (which
 * `mass()` and the fingerprint read). A total whose operands flat arrays cannot hold (a
 * non-integer support, a very wide one) is carried as the PMF itself and takes the PMF's own
 * path, so nothing is lost: only the representation changes. Not part of the package's API.
 */
import type { Bin, OutcomeLabelMap } from "../common/types";
import { denseConvolution, denseMap, type BinTable, type DenseBins } from "./dense";
import { PMF } from "./pmf";

/** A dense total's bins as a convolution operand: its damages in ascending order and its table. */
interface Operand {
  damages: number[];
  table: BinTable;
}

export class DenseTotal {
  private _mass?: number;
  private _operand?: Operand;
  /** Bin segments of {@link atOrBefore}, by ascending-damage index: a total meets several slices. */
  private _segments: string[] = [];

  private constructor(
    /** The flat arrays, or null where the total is carried as a PMF. */
    private readonly bins: DenseBins | null,
    /** The PMF, where the total is carried as one. */
    private readonly pmf: PMF | null,
    /** The `normalized` flag the PMF this stands for would carry: what orders a convolve's operands first. */
    private readonly normalized: boolean,
    private readonly eps: number
  ) {}

  /** `pmf` as a total: carried as it is until a convolution lays it out as arrays. */
  static of(pmf: PMF, eps: number): DenseTotal {
    return new DenseTotal(null, pmf, pmf.normalized, eps);
  }

  /** The PMF this total stands for. */
  toPMF(): PMF {
    return this.pmf ?? new PMF(denseMap(this.bins as DenseBins), this.eps, this.normalized);
  }

  /** `PMF.mass()`: the probabilities summed in map order. */
  mass(): number {
    if (this.pmf !== null) return this.pmf.mass();
    if (this._mass === undefined) {
      const { p, order } = this.bins as DenseBins;
      let total = 0;
      for (const slot of order) total += p[slot];
      this._mass = total;
    }
    return this._mass;
  }

  /** `PMF.scaleMass(factor)`: every value times `factor`; the same total for a factor of 1. */
  scale(factor: number): DenseTotal {
    if (factor === 1) return this;
    if (this.pmf !== null) return DenseTotal.of(this.pmf.scaleMass(factor), this.eps);
    const bins = this.bins as DenseBins;
    const times = (values: Float64Array): Float64Array => {
      const scaled = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) scaled[i] = values[i] * factor;
      return scaled;
    };
    return new DenseTotal({ ...bins, p: times(bins.p), count: times(bins.count), attr: times(bins.attr) }, null, false, this.eps);
  }

  /** `PMF.convolveRaw(slice, eps)`: the operands in content order, the mass invariant enforced. */
  convolve(slice: PMF): DenseTotal {
    const first = this.atOrBefore(slice);
    const own = this.operand();
    const sliceDamages = slice.support();
    if (own.damages.length === 0 || sliceDamages.length === 0) return this.convolveAsPmf(slice);
    const [aDamages, a, bDamages, b] = first
      ? [own.damages, own.table, sliceDamages, slice.binTable()]
      : [sliceDamages, slice.binTable(), own.damages, own.table];
    const bins = denseConvolution(aDamages, a, bDamages, b);
    if (bins === null) return this.convolveAsPmf(slice);
    // Enforce mass invariant: mass(out) = mass(A) · mass(B), the fresh arrays rescaled in place
    // (each value times the factor, as `scaleMass` would), when the masses do not multiply out.
    const mExp = this.mass() * slice.mass();
    let mGot = 0;
    for (const slot of bins.order) mGot += bins.p[slot];
    if (mExp !== 0 && mGot !== 0 && Math.abs(mGot - mExp) > this.eps) {
      const factor = mExp / mGot;
      const { p, count, attr } = bins;
      for (let i = 0; i < p.length; i++) p[i] = p[i] * factor;
      for (let i = 0; i < count.length; i++) count[i] = count[i] * factor;
      for (let i = 0; i < attr.length; i++) attr[i] = attr[i] * factor;
    }
    return new DenseTotal(bins, null, false, this.eps);
  }

  /** The convolution over the PMF's own path (a one-bin or non-integer operand): the same bits, as a PMF. */
  private convolveAsPmf(slice: PMF): DenseTotal {
    return DenseTotal.of(this.toPMF().convolveRaw(slice, this.eps), this.eps);
  }

  /** `PMF.contentAtOrBefore(this, slice)`: whether this total is the convolution's first operand. */
  private atOrBefore(slice: PMF): boolean {
    if (this.pmf !== null) return PMF.contentAtOrBefore(this.pmf, slice);
    if (this.normalized !== slice.normalized) return !this.normalized;
    const a = this.operand().damages;
    const b = slice.support();
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = (this._segments[i] ??= PMF.binSegment(a[i], this.binAt(i)));
      const y = PMF.binSegment(b[i], slice.map.get(b[i]) as Bin);
      if (x === y) continue;
      return x + (i + 1 < a.length ? ";" : "") <= y + (i + 1 < b.length ? ";" : "");
    }
    return a.length <= b.length;
  }

  /** Bin `i` (in ascending damage order) of a dense total, as the map would hold it. */
  private binAt(i: number): Bin {
    const bins = this.bins as DenseBins;
    const { table } = this.operand();
    const count: OutcomeLabelMap = {};
    for (let k = table.countStart[i]; k < table.countStart[i + 1]; k++) count[bins.countLabels[table.countLabel[k]]] = table.countValue[k];
    const bin: Bin = { p: table.p[i], count };
    if (table.hasAttr[i] === 1) {
      const attr: OutcomeLabelMap = {};
      for (let k = table.attrStart[i]; k < table.attrStart[i + 1]; k++) attr[bins.attrLabels[table.attrLabel[k]]] = table.attrValue[k];
      bin.attr = attr;
    }
    return bin;
  }

  /** The total's bins as a convolution operand (what `PMF.binTable()` gives for a PMF), memoized. */
  private operand(): Operand {
    if (this._operand !== undefined) return this._operand;
    if (this.pmf !== null) return (this._operand = { damages: this.pmf.support(), table: this.pmf.binTable() });
    const { lo, p, order, countLabels, count, countOrder, countLabelsAt, attrLabels, attr, attrSeen, attrOrder, attrLabelsAt } = this.bins as DenseBins;
    const L = countLabels.length;
    const M = attrLabels.length;
    const slots = [...order].sort((x, y) => x - y);
    const n = slots.length;
    const damages = new Array<number>(n);
    const tp = new Float64Array(n);
    const hasAttr = new Uint8Array(n);
    const countStart = new Int32Array(n + 1);
    const attrStart = new Int32Array(n + 1);
    let countCells = 0;
    let attrCells = 0;
    for (let i = 0; i < n; i++) {
      countCells += countLabelsAt[slots[i]];
      if (attrSeen[slots[i]]) attrCells += attrLabelsAt[slots[i]];
    }
    const countLabel = new Int32Array(countCells);
    const countValue = new Float64Array(countCells);
    const attrLabel = new Int32Array(attrCells);
    const attrValue = new Float64Array(attrCells);
    let c = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      damages[i] = lo + slot;
      tp[i] = p[slot];
      countStart[i] = c;
      attrStart[i] = m;
      const base = slot * L;
      for (let k = 0; k < countLabelsAt[slot]; k++) {
        const label = countOrder[base + k];
        countLabel[c] = label;
        countValue[c++] = count[base + label];
      }
      if (attrSeen[slot]) {
        hasAttr[i] = 1;
        const attrBase = slot * M;
        for (let k = 0; k < attrLabelsAt[slot]; k++) {
          const label = attrOrder[attrBase + k];
          attrLabel[m] = label;
          attrValue[m++] = attr[attrBase + label];
        }
      }
    }
    countStart[n] = c;
    attrStart[n] = m;
    this._operand = {
      damages,
      table: { p: tp, hasAttr, countStart, countLabel, countValue, attrStart, attrLabel, attrValue, countLabels, attrLabels },
    };
    return this._operand;
  }

  /**
   * `PMF.add(other)`: this total's bins in its order, each with `other`'s bin at the same damage
   * added into it (`other`'s labels after this bin's, in `other`'s order), then `other`'s remaining
   * bins in its order.
   */
  add(other: DenseTotal): DenseTotal {
    if (this.pmf !== null || other.pmf !== null) return DenseTotal.of(this.toPMF().add(other.toPMF()), this.eps);
    const x = this.bins as DenseBins;
    const y = other.bins as DenseBins;
    const lo = Math.min(x.lo, y.lo);
    const width = Math.max(x.lo + x.width, y.lo + y.width) - lo;
    // Labels: this total's, then `other`'s new ones; `other`'s indexes mapped onto them.
    const countLabels = [...x.countLabels];
    const attrLabels = [...x.attrLabels];
    const mapped = (labels: string[], own: readonly string[]): Int32Array =>
      Int32Array.from(own, (label) => {
        const known = labels.indexOf(label);
        return known === -1 ? labels.push(label) - 1 : known;
      });
    const yCount = mapped(countLabels, y.countLabels);
    const yAttr = mapped(attrLabels, y.attrLabels);
    const L = countLabels.length;
    const M = attrLabels.length;
    const XL = x.countLabels.length;
    const XM = x.attrLabels.length;
    const YL = y.countLabels.length;
    const YM = y.attrLabels.length;

    const p = new Float64Array(width);
    const count = new Float64Array(width * L);
    const attr = new Float64Array(width * M);
    const order: number[] = [];
    const attrSeen = new Uint8Array(width);
    const countOrder = new Int32Array(width * L);
    const countLabelsAt = new Int32Array(width);
    const attrOrder = new Int32Array(width * M);
    const attrLabelsAt = new Int32Array(width);
    const carried = new Uint8Array(width * L);
    const attrCarried = new Uint8Array(width * M);
    const ySeen = new Uint8Array(y.width);
    for (const slot of y.order) ySeen[slot] = 1;
    const xSeen = new Uint8Array(x.width);
    for (const slot of x.order) xSeen[slot] = 1;

    /** Copies `other`'s bin at its `slot` to the result's `at`: a damage this total does not reach. */
    const copyY = (slot: number, at: number): void => {
      const base = at * L;
      const yBase = slot * YL;
      for (let k = 0; k < y.countLabelsAt[slot]; k++) {
        const label = yCount[y.countOrder[yBase + k]];
        countOrder[base + k] = label;
        count[base + label] = y.count[yBase + y.countOrder[yBase + k]];
      }
      countLabelsAt[at] = y.countLabelsAt[slot];
      if (y.attrSeen[slot]) {
        attrSeen[at] = 1;
        const attrBase = at * M;
        const yAttrBase = slot * YM;
        for (let k = 0; k < y.attrLabelsAt[slot]; k++) {
          const label = yAttr[y.attrOrder[yAttrBase + k]];
          attrOrder[attrBase + k] = label;
          attr[attrBase + label] = y.attr[yAttrBase + y.attrOrder[yAttrBase + k]];
        }
        attrLabelsAt[at] = y.attrLabelsAt[slot];
      }
    };
    /** Adds `other`'s bin at its `slot` into the result's `at`, labels appended as first carried. */
    const addY = (slot: number, at: number): void => {
      const base = at * L;
      const yBase = slot * YL;
      for (let k = 0; k < y.countLabelsAt[slot]; k++) {
        const yLabel = y.countOrder[yBase + k];
        const label = yCount[yLabel];
        const cell = base + label;
        if (carried[cell] === 0) {
          carried[cell] = 1;
          countOrder[base + countLabelsAt[at]++] = label;
        }
        count[cell] = (count[cell] || 0) + y.count[yBase + yLabel];
      }
      if (y.attrSeen[slot]) {
        attrSeen[at] = 1;
        const attrBase = at * M;
        const yAttrBase = slot * YM;
        for (let k = 0; k < y.attrLabelsAt[slot]; k++) {
          const yLabel = y.attrOrder[yAttrBase + k];
          const label = yAttr[yLabel];
          const cell = attrBase + label;
          if (attrCarried[cell] === 0) {
            attrCarried[cell] = 1;
            attrOrder[attrBase + attrLabelsAt[at]++] = label;
          }
          attr[cell] = (attr[cell] || 0) + y.attr[yAttrBase + yLabel];
        }
      }
    };

    for (const slot of x.order) {
      const damage = x.lo + slot;
      const at = damage - lo;
      order.push(at);
      // This total's bin, copied: its labels in its order (the same label indexes).
      const base = at * L;
      const xBase = slot * XL;
      for (let k = 0; k < x.countLabelsAt[slot]; k++) {
        const label = x.countOrder[xBase + k];
        carried[base + label] = 1;
        countOrder[base + k] = label;
        count[base + label] = x.count[xBase + label];
      }
      countLabelsAt[at] = x.countLabelsAt[slot];
      if (x.attrSeen[slot]) {
        attrSeen[at] = 1;
        const attrBase = at * M;
        const xAttrBase = slot * XM;
        for (let k = 0; k < x.attrLabelsAt[slot]; k++) {
          const label = x.attrOrder[xAttrBase + k];
          attrCarried[attrBase + label] = 1;
          attrOrder[attrBase + k] = label;
          attr[attrBase + label] = x.attr[xAttrBase + label];
        }
        attrLabelsAt[at] = x.attrLabelsAt[slot];
      }
      const ySlot = damage - y.lo;
      if (ySlot >= 0 && ySlot < y.width && ySeen[ySlot] === 1) {
        p[at] = x.p[slot] + y.p[ySlot];
        addY(ySlot, at);
      } else {
        p[at] = x.p[slot];
      }
    }
    for (const slot of y.order) {
      const damage = y.lo + slot;
      const xSlot = damage - x.lo;
      if (xSlot >= 0 && xSlot < x.width && xSeen[xSlot] === 1) continue;
      const at = damage - lo;
      order.push(at);
      p[at] = y.p[slot];
      copyY(slot, at);
    }
    return new DenseTotal(
      { lo, width, p, order, countLabels, count, countOrder, countLabelsAt, attrLabels, attr, attrSeen, attrOrder, attrLabelsAt },
      null,
      false,
      this.eps
    );
  }
}
