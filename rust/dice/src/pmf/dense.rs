//! Port of src/pmf/dense.ts (`denseConvolution`, `denseMap`) and `PMF.binTable`: integer-valued
//! operands accumulate in flat arrays indexed by `damage - lo` and label slot, every float sum
//! added in the order the sparse walk adds it.

use indexmap::{IndexMap, IndexSet};

use super::{Bin, LabelMap, Pmf};
use crate::Damage;

/// Widest integer support accumulated in flat arrays, and the most cells (one per damage per
/// label, `p` included); past either the sparse walk runs.
pub(crate) const MAX_DENSE_WIDTH: f64 = (1u32 << 20) as f64;
pub(crate) const MAX_DENSE_CELLS: usize = 1 << 22;

/// JS `x || 0`: 0 for 0, -0 and NaN.
pub(crate) fn or_zero(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 0.0 } else { x }
}

/// `BinTable` in src/pmf/dense.ts: a PMF's bins as flat arrays, bins in `support()` order. Bin
/// `i`'s labels are entries `count_start[i]..count_start[i + 1]` of `count_label`/`count_value`
/// (indexes into `count_labels`, the distinct labels in order of first appearance), in the bin's
/// own key order; likewise `attr`.
#[derive(Clone, Debug)]
pub(crate) struct BinTable {
    pub p: Vec<f64>,
    pub has_attr: Vec<bool>,
    pub count_start: Vec<usize>,
    pub count_label: Vec<usize>,
    pub count_value: Vec<f64>,
    pub attr_start: Vec<usize>,
    pub attr_label: Vec<usize>,
    pub attr_value: Vec<f64>,
    pub count_labels: IndexSet<String>,
    pub attr_labels: IndexSet<String>,
}

impl Pmf {
    /// `PMF.binTable()` (no memo).
    pub(crate) fn bin_table(&self) -> BinTable {
        let damages = self.support();
        let n = damages.len();
        let mut t = BinTable {
            p: Vec::with_capacity(n),
            has_attr: Vec::with_capacity(n),
            count_start: Vec::with_capacity(n + 1),
            count_label: vec![],
            count_value: vec![],
            attr_start: Vec::with_capacity(n + 1),
            attr_label: vec![],
            attr_value: vec![],
            count_labels: IndexSet::new(),
            attr_labels: IndexSet::new(),
        };
        for d in &damages {
            let Some(bin) = self.map.get(d) else { continue };
            t.p.push(bin.p);
            t.count_start.push(t.count_label.len());
            t.attr_start.push(t.attr_label.len());
            for (k, v) in &bin.count {
                t.count_label.push(t.count_labels.insert_full(k.clone()).0);
                t.count_value.push(*v);
            }
            t.has_attr.push(bin.attr.is_some());
            if let Some(attr) = &bin.attr {
                for (k, v) in attr {
                    t.attr_label.push(t.attr_labels.insert_full(k.clone()).0);
                    t.attr_value.push(*v);
                }
            }
        }
        t.count_start.push(t.count_label.len());
        t.attr_start.push(t.attr_label.len());
        t
    }
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// One label family's accumulators: values label-major per slot (`slot * n + label`), whether each
/// cell was carried, and each slot's labels in first-carried order.
#[derive(Clone, Debug)]
pub(crate) struct Cells {
    pub n: usize,
    pub value: Vec<f64>,
    pub touched: Vec<bool>,
    pub order: Vec<usize>,
    pub at: Vec<usize>,
}

impl Cells {
    pub fn new(width: usize, n: usize) -> Self {
        Cells {
            n,
            value: vec![0.0; width * n],
            touched: vec![false; width * n],
            order: vec![0; width * n],
            at: vec![0; width],
        }
    }

    /// `x[at] = (x[at] || 0) + term` for `label` of `slot`, recording first carry.
    #[inline]
    pub fn add(&mut self, slot: usize, label: usize, term: f64) {
        let base = slot * self.n;
        let cell = base + label;
        if !self.touched[cell] {
            self.touched[cell] = true;
            self.order[base + self.at[slot]] = label;
            self.at[slot] += 1;
        }
        self.value[cell] = or_zero(self.value[cell]) + term;
    }

    /// The slot's labels in carried order, each with its value.
    pub fn labels_of(&self, slot: usize) -> impl Iterator<Item = (usize, f64)> + '_ {
        let base = slot * self.n;
        self.order[base..base + self.at[slot]]
            .iter()
            .map(move |&label| (label, self.value[base + label]))
    }

    fn labels(&self, slot: usize, names: &IndexSet<String>) -> LabelMap {
        let mut m = LabelMap::with_capacity(self.at[slot]);
        for (label, v) in self.labels_of(slot) {
            if let Some(name) = names.get_index(label) {
                m.insert(name.clone(), v);
            }
        }
        m
    }
}

/// `DenseBins` in src/pmf/dense.ts: a convolution's bins as flat arrays, before (or instead of)
/// becoming a map. Per damage slot (`damage - lo`) its probability and its `count`/`attr` cells;
/// `order` lists the slots in the order the walk first reached them (the map's order), and each
/// slot's labels in the order a pair first carried each.
#[derive(Clone, Debug)]
pub(crate) struct DenseBins {
    pub lo: f64,
    pub width: usize,
    pub p: Vec<f64>,
    pub order: Vec<usize>,
    pub count_labels: IndexSet<String>,
    pub count: Cells,
    pub attr_labels: IndexSet<String>,
    pub attr: Cells,
    pub attr_seen: Vec<bool>,
}

/// `denseRange`: the slot range of `A ⊛ B`, or None where flat arrays do not pay.
fn dense_range(a_damages: &[Damage], b_damages: &[Damage]) -> Option<(f64, usize)> {
    let (a_first, a_last) = (a_damages.first()?.0, a_damages.last()?.0);
    let (b_first, b_last) = (b_damages.first()?.0, b_damages.last()?.0);
    let lo = a_first + b_first;
    let width_f = a_last + b_last - lo + 1.0;
    let dense = is_integer(width_f)
        && width_f <= MAX_DENSE_WIDTH
        && width_f <= 4.0 * a_damages.len() as f64 * b_damages.len() as f64
        && a_damages.iter().all(|d| is_integer(d.0))
        && b_damages.iter().all(|d| is_integer(d.0));
    // A negative width (impossible for sorted input) falls back.
    (dense && width_f >= 1.0).then_some((lo, width_f as usize))
}

/// Each of `own`'s labels as an index into `labels`, appended where new.
pub(crate) fn slot_of(labels: &mut IndexSet<String>, own: &IndexSet<String>) -> Vec<usize> {
    own.iter()
        .map(|l| labels.insert_full(l.clone()).0)
        .collect()
}

/// `denseConvolution`: the bins of `A ⊛ B` over flat arrays, or None where the operands are not
/// dense or hold more label cells than `MAX_DENSE_CELLS` (the sparse walk's case).
pub(crate) fn dense_convolution(
    a_damages: &[Damage],
    a: &BinTable,
    b_damages: &[Damage],
    b: &BinTable,
) -> Option<DenseBins> {
    let (lo, width) = dense_range(a_damages, b_damages)?;
    let mut count_labels = IndexSet::new();
    let mut attr_labels = IndexSet::new();
    let a_count_slot = slot_of(&mut count_labels, &a.count_labels);
    let b_count_slot = slot_of(&mut count_labels, &b.count_labels);
    let a_attr_slot = slot_of(&mut attr_labels, &a.attr_labels);
    let b_attr_slot = slot_of(&mut attr_labels, &b.attr_labels);
    let (l, m) = (count_labels.len(), attr_labels.len());
    if width.saturating_mul(l + m + 1) > MAX_DENSE_CELLS {
        return None;
    }
    let width_f = width as f64;

    let mut p = vec![0.0; width];
    let mut seen = vec![false; width];
    let mut order: Vec<usize> = Vec::new();
    let mut attr_seen = vec![false; width];
    let mut count = Cells::new(width, l);
    let mut attr = Cells::new(width, m);

    for (i, a_val) in a_damages.iter().enumerate() {
        let ap = a.p[i];
        let (ac_from, ac_to) = (a.count_start[i], a.count_start[i + 1]);
        let (aa_from, aa_to) = (a.attr_start[i], a.attr_start[i + 1]);
        for (j, b_val) in b_damages.iter().enumerate() {
            let bp = b.p[j];
            // An out-of-range slot (float rounding on huge integers) takes the sparse walk.
            let s = a_val.0 + b_val.0 - lo;
            if !(s >= 0.0 && s < width_f) {
                return None;
            }
            let slot = s as usize;
            if !seen[slot] {
                seen[slot] = true;
                order.push(slot);
            }
            p[slot] += ap * bp;

            for k in ac_from..ac_to {
                count.add(slot, a_count_slot[a.count_label[k]], a.count_value[k] * bp);
            }
            for k in b.count_start[j]..b.count_start[j + 1] {
                count.add(slot, b_count_slot[b.count_label[k]], b.count_value[k] * ap);
            }

            if a.has_attr[i] || b.has_attr[j] {
                attr_seen[slot] = true;
                for k in aa_from..aa_to {
                    attr.add(slot, a_attr_slot[a.attr_label[k]], a.attr_value[k] * bp);
                }
                for k in b.attr_start[j]..b.attr_start[j + 1] {
                    attr.add(slot, b_attr_slot[b.attr_label[k]], b.attr_value[k] * ap);
                }
            }
        }
    }

    Some(DenseBins {
        lo,
        width,
        p,
        order,
        count_labels,
        count,
        attr_labels,
        attr,
        attr_seen,
    })
}

/// `denseMap`: `dense` as a map of bins, in its order, each bin's labels in its order.
pub(crate) fn dense_map(dense: &DenseBins) -> IndexMap<Damage, Bin> {
    let mut map = IndexMap::with_capacity(dense.order.len());
    for &slot in &dense.order {
        let bin = Bin {
            p: dense.p[slot],
            count: dense.count.labels(slot, &dense.count_labels),
            attr: dense.attr_seen[slot].then(|| dense.attr.labels(slot, &dense.attr_labels)),
        };
        map.insert(Damage(dense.lo + slot as f64), bin);
    }
    map
}

/// `denseConvolution` + `denseMap` over two PMFs' tables: the bins of `A ⊛ B`, or None where the
/// sparse walk runs.
pub(super) fn dense_convolve(
    a: &Pmf,
    a_damages: &[Damage],
    b: &Pmf,
    b_damages: &[Damage],
) -> Option<IndexMap<Damage, Bin>> {
    let bins = dense_convolution(a_damages, &a.bin_table(), b_damages, &b.bin_table())?;
    Some(dense_map(&bins))
}
