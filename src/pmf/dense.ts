/**
 * The dense convolution kernel: integer-valued operands accumulate in flat typed arrays indexed by
 * `damage - lo` and by label slot, with every float sum added in the same order as the map walk
 * (`PMF.convolve`'s specification): for each A bin in ascending damage order, each B bin; within a
 * pair, A's labels then B's; every cell from 0. The arrays are what a walk's {@link DenseTotal}
 * carries between steps; `denseMap` turns them into a PMF's bins. Not part of the package's API.
 */
import type { Bin, OutcomeLabelMap } from "../common/types";

/**
 * Widest integer support a convolution accumulates in flat arrays, and the most cells (one per
 * damage value per label, `p` included) those arrays may hold; past either, it takes the map
 * walk. 2^22 cells is 32 MB of floats plus the order and touched arrays beside them.
 */
export const MAX_DENSE_WIDTH = 1 << 20;
export const MAX_DENSE_CELLS = 1 << 22;

/** A PMF's bins as flat arrays, for {@link PMF.convolve}; see `PMF.binTable`. */
export interface BinTable {
  /** Per bin, in `support()` order. */
  p: Float64Array;
  hasAttr: Uint8Array;
  /** Bin `i`'s labels are entries `countStart[i]` up to `countStart[i + 1]` of `countLabel`/`countValue`. */
  countStart: Int32Array;
  /** Indexes into `countLabels`. */
  countLabel: Int32Array;
  countValue: Float64Array;
  attrStart: Int32Array;
  attrLabel: Int32Array;
  attrValue: Float64Array;
  /** The distinct labels, in order of first appearance. */
  countLabels: readonly string[];
  attrLabels: readonly string[];
}

const quotedLabels = new Map<string, string>();

/**
 * A bin's label map as fingerprint text: `"label":value` per label, sorted by label, comma
 * separated; `""` for an absent map.
 */
export function labelText(m: OutcomeLabelMap | undefined): string {
  if (m === undefined) return "";
  const keys = Object.keys(m);
  if (keys.length > 1) keys.sort();
  let text = "";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let quoted = quotedLabels.get(key);
    if (quoted === undefined) {
      quoted = JSON.stringify(key);
      if (quotedLabels.size < 1024) quotedLabels.set(key, quoted);
    }
    text += `${i === 0 ? "" : ","}${quoted}:${m[key]}`;
  }
  return text;
}

/**
 * A convolution's bins as flat arrays, before (or instead of) becoming a map: per damage slot
 * (`damage - lo`) its probability and, label-major within the slot (`slot * L + label`), its
 * `count` and `attr` values; `order` lists the slots in the order the walk first reached them
 * (the map's order), and each slot's labels in the order a pair first carried each (the key
 * order of the bin's objects). What {@link DenseTotal} carries between the steps of a walk.
 */
export interface DenseBins {
  lo: number;
  width: number;
  p: Float64Array;
  order: number[];
  countLabels: string[];
  count: Float64Array;
  countOrder: Int32Array;
  countLabelsAt: Int32Array;
  attrLabels: string[];
  attr: Float64Array;
  attrSeen: Uint8Array;
  attrOrder: Int32Array;
  attrLabelsAt: Int32Array;
}

/**
 * The slot range of `A ⊛ B`, or null where flat arrays do not pay: a non-integer support, or
 * one so wide and sparse (`{0, 1000000}`) that the map walk is cheaper.
 */
export function denseRange(aDamages: readonly number[], bDamages: readonly number[]): { lo: number; width: number } | null {
  const lo = aDamages[0] + bDamages[0];
  const width = aDamages[aDamages.length - 1] + bDamages[bDamages.length - 1] - lo + 1;
  const dense =
    Number.isInteger(width) &&
    width <= MAX_DENSE_WIDTH &&
    width <= 4 * aDamages.length * bDamages.length &&
    aDamages.every(Number.isInteger) &&
    bDamages.every(Number.isInteger);
  return dense ? { lo, width } : null;
}

/**
 * The bins of `A ⊛ B` over flat arrays, from the operands' tables (bins in ascending damage
 * order): for each A bin, each B bin; within a pair, A's labels then B's, every cell summed from
 * 0. Null where the operands are not dense (see {@link denseRange}), or hold more label cells
 * than `MAX_DENSE_CELLS`: the map walk's case, with the same sums in the same order.
 */
export function denseConvolution(aDamages: readonly number[], a: BinTable, bDamages: readonly number[], b: BinTable): DenseBins | null {
  const range = denseRange(aDamages, bDamages);
  if (range === null) return null;
  const { lo, width } = range;
  // Label slots: `count` labels then `attr` labels, each in order of first appearance (A's
  // then B's); each table's local label index maps to a slot.
  const countLabels: string[] = [];
  const attrLabels: string[] = [];
  const slotOf = (labels: string[], own: readonly string[]): Int32Array =>
    Int32Array.from(own, (label) => {
      const known = labels.indexOf(label);
      return known === -1 ? labels.push(label) - 1 : known;
    });
  const aCountSlot = slotOf(countLabels, a.countLabels);
  const bCountSlot = slotOf(countLabels, b.countLabels);
  const aAttrSlot = slotOf(attrLabels, a.attrLabels);
  const bAttrSlot = slotOf(attrLabels, b.attrLabels);
  const L = countLabels.length;
  const M = attrLabels.length;
  // The flat arrays hold `width` cells per label (plus `p`): a wide support with many labels
  // is the map walk's too.
  if (width * (L + M + 1) > MAX_DENSE_CELLS) return null;

    const p = new Float64Array(width);
  const count = new Float64Array(width * L);
  const attr = new Float64Array(width * M);
  // Per damage: whether reached, in which order (the map's), whether `attr` was touched, and
  // its count/attr labels in the order a pair first carried each (a label is set, at 0 too,
  // once a pair carries it): the key order of the bin's objects, which readers walk.
  const seen = new Uint8Array(width);
  const order: number[] = [];
  const attrSeen = new Uint8Array(width);
  const countOrder = new Int32Array(width * L);
  const countLabelsAt = new Int32Array(width);
  const attrOrder = new Int32Array(width * M);
  const attrLabelsAt = new Int32Array(width);
  const countTouched = new Uint8Array(width * L);
  const attrTouched = new Uint8Array(width * M);

  for (let i = 0; i < aDamages.length; i++) {
    const aVal = aDamages[i];
    const ap = a.p[i];
    const aCountFrom = a.countStart[i];
    const aCountTo = a.countStart[i + 1];
    const aHasAttr = a.hasAttr[i] === 1;
    const aAttrFrom = a.attrStart[i];
    const aAttrTo = a.attrStart[i + 1];
    for (let j = 0; j < bDamages.length; j++) {
      const bp = b.p[j];
      const slot = aVal + bDamages[j] - lo;
      if (seen[slot] === 0) {
        seen[slot] = 1;
        order.push(slot);
      }
      p[slot] += ap * bp;

      const base = slot * L;
      for (let k = aCountFrom; k < aCountTo; k++) {
        const label = aCountSlot[a.countLabel[k]];
        const at = base + label;
        if (countTouched[at] === 0) {
          countTouched[at] = 1;
          countOrder[base + countLabelsAt[slot]++] = label;
        }
        count[at] = (count[at] || 0) + a.countValue[k] * bp;
      }
      for (let k = b.countStart[j], to = b.countStart[j + 1]; k < to; k++) {
        const label = bCountSlot[b.countLabel[k]];
        const at = base + label;
        if (countTouched[at] === 0) {
          countTouched[at] = 1;
          countOrder[base + countLabelsAt[slot]++] = label;
        }
        count[at] = (count[at] || 0) + b.countValue[k] * ap;
      }

      if (aHasAttr || b.hasAttr[j] === 1) {
        attrSeen[slot] = 1;
        const attrBase = slot * M;
        for (let k = aAttrFrom; k < aAttrTo; k++) {
          const label = aAttrSlot[a.attrLabel[k]];
          const at = attrBase + label;
          if (attrTouched[at] === 0) {
            attrTouched[at] = 1;
            attrOrder[attrBase + attrLabelsAt[slot]++] = label;
          }
          attr[at] = (attr[at] || 0) + a.attrValue[k] * bp;
        }
        for (let k = b.attrStart[j], to = b.attrStart[j + 1]; k < to; k++) {
          const label = bAttrSlot[b.attrLabel[k]];
          const at = attrBase + label;
          if (attrTouched[at] === 0) {
            attrTouched[at] = 1;
            attrOrder[attrBase + attrLabelsAt[slot]++] = label;
          }
          attr[at] = (attr[at] || 0) + b.attrValue[k] * ap;
        }
      }
    }
  }

  return { lo, width, p, order, countLabels, count, countOrder, countLabelsAt, attrLabels, attr, attrSeen, attrOrder, attrLabelsAt };
}

/** `dense` as a map of bins, in its order, each bin's labels in its order. */
export function denseMap(dense: DenseBins): Map<number, Bin> {
  const { lo, p, order, countLabels, count, countOrder, countLabelsAt, attrLabels, attr, attrSeen, attrOrder, attrLabelsAt } = dense;
  const L = countLabels.length;
  const M = attrLabels.length;
  const combinedMap = new Map<number, Bin>();
  for (const slot of order) {
    const bin: Bin = { p: p[slot], count: {} };
    const base = slot * L;
    for (let k = 0; k < countLabelsAt[slot]; k++) {
      const label = countOrder[base + k];
      bin.count[countLabels[label]] = count[base + label];
    }
    if (attrSeen[slot]) {
      const labels: OutcomeLabelMap = {};
      const attrBase = slot * M;
      for (let k = 0; k < attrLabelsAt[slot]; k++) {
        const label = attrOrder[attrBase + k];
        labels[attrLabels[label]] = attr[attrBase + label];
      }
      bin.attr = labels;
    }
    combinedMap.set(lo + slot, bin);
  }
  return combinedMap;
}
