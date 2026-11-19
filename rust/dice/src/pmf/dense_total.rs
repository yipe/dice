//! Port of src/pmf/dense-total.ts (`DenseTotal`): a walk's running damage total kept as flat
//! arrays between steps, so a state's damage is convolved, merged and scaled without building a
//! bin object per damage value until the walk ends. Every operation is the PMF one it stands
//! for, to the bit: the same products and sums in the same order, the same operand order, the same
//! map and label-key orders. A total flat arrays cannot hold (a non-integer support, a very
//! wide one) is carried as the PMF itself and takes the PMF's own path.
//!
//! Deviations from the TS: `_segments` (the memo of bin segments `atOrBefore` reads) is not
//! kept; the `DenseTotal` is a cheap-to-clone handle (`Arc`), as the TS object is shared by
//! reference.

use std::sync::{Arc, OnceLock};

use indexmap::IndexSet;

use super::dense::{BinTable, Cells, DenseBins, dense_convolution, dense_map, slot_of};
use super::{Bin, LabelMap, Pmf, segments_at_or_before};
use crate::Damage;

/// A dense total's bins as a convolution operand: its damages in ascending order and its table.
struct Operand {
    damages: Vec<Damage>,
    table: BinTable,
}

enum Repr {
    /// The flat arrays.
    Bins(Box<DenseBins>),
    /// The PMF, where the total is carried as one.
    Pmf(Box<Pmf>),
}

struct Inner {
    repr: Repr,
    /// The `normalized` flag the PMF this stands for would carry: what orders a convolve's operands first.
    normalized: bool,
    eps: f64,
    mass: OnceLock<f64>,
    operand: OnceLock<Operand>,
}

/// `DenseTotal`.
#[derive(Clone)]
pub struct DenseTotal(Arc<Inner>);

impl DenseTotal {
    fn make(repr: Repr, normalized: bool, eps: f64) -> DenseTotal {
        DenseTotal(Arc::new(Inner {
            repr,
            normalized,
            eps,
            mass: OnceLock::new(),
            operand: OnceLock::new(),
        }))
    }

    /// `DenseTotal.of`: `pmf` as a total, carried as it is until a convolution lays it out as arrays.
    pub fn of(pmf: Pmf, eps: f64) -> DenseTotal {
        let normalized = pmf.normalized;
        DenseTotal::make(Repr::Pmf(Box::new(pmf)), normalized, eps)
    }

    /// `toPMF`: the PMF this total stands for.
    pub fn to_pmf(&self) -> Pmf {
        match &self.0.repr {
            Repr::Pmf(p) => (**p).clone(),
            Repr::Bins(b) => Pmf::new(dense_map(b), self.0.eps, self.0.normalized),
        }
    }

    /// `mass()`: the probabilities summed in map order.
    pub fn mass(&self) -> f64 {
        match &self.0.repr {
            Repr::Pmf(p) => p.mass(),
            Repr::Bins(b) => *self.0.mass.get_or_init(|| {
                let mut total = 0.0;
                for &slot in &b.order {
                    total += b.p[slot];
                }
                total
            }),
        }
    }

    /// `scale(factor)`: every value times `factor`; the same total for a factor of 1.
    pub fn scale(&self, factor: f64) -> DenseTotal {
        if factor == 1.0 {
            return self.clone();
        }
        match &self.0.repr {
            Repr::Pmf(p) => DenseTotal::of(p.scale_mass(factor), self.0.eps),
            Repr::Bins(b) => {
                let mut bins = (**b).clone();
                for v in &mut bins.p {
                    *v *= factor;
                }
                for v in &mut bins.count.value {
                    *v *= factor;
                }
                for v in &mut bins.attr.value {
                    *v *= factor;
                }
                DenseTotal::make(Repr::Bins(Box::new(bins)), false, self.0.eps)
            }
        }
    }

    /// `convolve(slice)` (`PMF.convolveRaw(slice, eps)`): the operands in content order, the mass
    /// invariant enforced.
    pub fn convolve(&self, slice: &Pmf) -> DenseTotal {
        let first = self.at_or_before(slice);
        let own = self.operand();
        let slice_damages = slice.support();
        if own.damages.is_empty() || slice_damages.is_empty() {
            return self.convolve_as_pmf(slice);
        }
        let slice_table = slice.bin_table();
        let bins = if first {
            dense_convolution(&own.damages, &own.table, &slice_damages, &slice_table)
        } else {
            dense_convolution(&slice_damages, &slice_table, &own.damages, &own.table)
        };
        let Some(mut bins) = bins else {
            return self.convolve_as_pmf(slice);
        };
        // Enforce mass invariant: mass(out) = mass(A) · mass(B), the fresh arrays rescaled in place
        // (each value times the factor, as `scaleMass` would), when the masses do not multiply out.
        let m_exp = self.mass() * slice.mass();
        let mut m_got = 0.0;
        for &slot in &bins.order {
            m_got += bins.p[slot];
        }
        if m_exp != 0.0 && m_got != 0.0 && (m_got - m_exp).abs() > self.0.eps {
            let factor = m_exp / m_got;
            for v in &mut bins.p {
                *v *= factor;
            }
            for v in &mut bins.count.value {
                *v *= factor;
            }
            for v in &mut bins.attr.value {
                *v *= factor;
            }
        }
        DenseTotal::make(Repr::Bins(Box::new(bins)), false, self.0.eps)
    }

    /// The convolution over the PMF's own path (an empty or unfit operand): the same bits, as a PMF.
    fn convolve_as_pmf(&self, slice: &Pmf) -> DenseTotal {
        DenseTotal::of(
            self.to_pmf().convolve_raw(slice, Some(self.0.eps)),
            self.0.eps,
        )
    }

    /// `PMF.contentAtOrBefore(this, slice)`: whether this total is the convolution's first operand.
    fn at_or_before(&self, slice: &Pmf) -> bool {
        if let Repr::Pmf(p) = &self.0.repr {
            return Pmf::content_at_or_before(p, slice);
        }
        if self.0.normalized != slice.normalized {
            return !self.0.normalized;
        }
        let own = self.operand();
        let a = &own.damages;
        let b = slice.support();
        for i in 0..a.len().min(b.len()) {
            let Some(ybin) = slice.map.get(&b[i]) else {
                continue;
            };
            let x = Pmf::bin_segment(a[i].0, &self.bin_at(i));
            let y = Pmf::bin_segment(b[i].0, ybin);
            if x == y {
                continue;
            }
            return segments_at_or_before(&x, i + 1 < a.len(), &y, i + 1 < b.len());
        }
        a.len() <= b.len()
    }

    /// Bin `i` (in ascending damage order) of a dense total, as the map would hold it.
    fn bin_at(&self, i: usize) -> Bin {
        let Repr::Bins(bins) = &self.0.repr else {
            return Bin {
                p: 0.0,
                count: LabelMap::new(),
                attr: None,
            };
        };
        let t = &self.operand().table;
        let mut count = LabelMap::new();
        for k in t.count_start[i]..t.count_start[i + 1] {
            if let Some(name) = bins.count_labels.get_index(t.count_label[k]) {
                count.insert(name.clone(), t.count_value[k]);
            }
        }
        let attr = t.has_attr[i].then(|| {
            let mut attr = LabelMap::new();
            for k in t.attr_start[i]..t.attr_start[i + 1] {
                if let Some(name) = bins.attr_labels.get_index(t.attr_label[k]) {
                    attr.insert(name.clone(), t.attr_value[k]);
                }
            }
            attr
        });
        Bin {
            p: t.p[i],
            count,
            attr,
        }
    }

    /// The total's bins as a convolution operand (what `PMF.binTable()` gives for a PMF), memoized.
    fn operand(&self) -> &Operand {
        self.0.operand.get_or_init(|| match &self.0.repr {
            Repr::Pmf(p) => Operand {
                damages: p.support(),
                table: p.bin_table(),
            },
            Repr::Bins(bins) => dense_operand(bins),
        })
    }

    /// `add(other)` (`PMF.add`): this total's bins in its order, each with `other`'s bin at the
    /// same damage added into it (`other`'s labels after this bin's, in `other`'s order), then
    /// `other`'s remaining bins in its order.
    pub fn add(&self, other: &DenseTotal) -> DenseTotal {
        let (Repr::Bins(x), Repr::Bins(y)) = (&self.0.repr, &other.0.repr) else {
            return DenseTotal::of(self.to_pmf().add(&other.to_pmf()), self.0.eps);
        };
        DenseTotal::make(Repr::Bins(Box::new(add_bins(x, y))), false, self.0.eps)
    }
}

/// `operand()` of a dense total: slots in ascending damage order laid out as a table.
fn dense_operand(bins: &DenseBins) -> Operand {
    let mut slots = bins.order.clone();
    slots.sort_unstable();
    let n = slots.len();
    let mut damages = Vec::with_capacity(n);
    let mut t = BinTable {
        p: Vec::with_capacity(n),
        has_attr: Vec::with_capacity(n),
        count_start: Vec::with_capacity(n + 1),
        count_label: vec![],
        count_value: vec![],
        attr_start: Vec::with_capacity(n + 1),
        attr_label: vec![],
        attr_value: vec![],
        count_labels: bins.count_labels.clone(),
        attr_labels: bins.attr_labels.clone(),
    };
    for &slot in &slots {
        damages.push(Damage(bins.lo + slot as f64));
        t.p.push(bins.p[slot]);
        t.count_start.push(t.count_label.len());
        t.attr_start.push(t.attr_label.len());
        for (label, v) in bins.count.labels_of(slot) {
            t.count_label.push(label);
            t.count_value.push(v);
        }
        t.has_attr.push(bins.attr_seen[slot]);
        if bins.attr_seen[slot] {
            for (label, v) in bins.attr.labels_of(slot) {
                t.attr_label.push(label);
                t.attr_value.push(v);
            }
        }
    }
    t.count_start.push(t.count_label.len());
    t.attr_start.push(t.attr_label.len());
    Operand { damages, table: t }
}

/// Copies one slot's labels of `src` (labels mapped through `map`) into `dst` at `at`, in order:
/// a damage the other side does not reach.
fn copy_labels(dst: &mut Cells, at: usize, src: &Cells, slot: usize, map: &[usize]) {
    for (label, v) in src.labels_of(slot) {
        let label = map[label];
        let cell = at * dst.n + label;
        let k = dst.at[at];
        dst.order[at * dst.n + k] = label;
        dst.at[at] += 1;
        dst.touched[cell] = true;
        dst.value[cell] = v;
    }
}

/// Adds one slot's labels of `src` into `dst` at `at`, labels appended as first carried.
fn add_labels(dst: &mut Cells, at: usize, src: &Cells, slot: usize, map: &[usize]) {
    for (label, v) in src.labels_of(slot) {
        dst.add(at, map[label], v);
    }
}

fn add_bins(x: &DenseBins, y: &DenseBins) -> DenseBins {
    let lo = x.lo.min(y.lo);
    let width_f = (x.lo + x.width as f64).max(y.lo + y.width as f64) - lo;
    let width = if width_f >= 0.0 { width_f as usize } else { 0 };
    // Labels: this total's, then `other`'s new ones; `other`'s indexes mapped onto them.
    let mut count_labels: IndexSet<String> = x.count_labels.clone();
    let mut attr_labels: IndexSet<String> = x.attr_labels.clone();
    let y_count = slot_of(&mut count_labels, &y.count_labels);
    let y_attr = slot_of(&mut attr_labels, &y.attr_labels);
    let identity = |n: usize| (0..n).collect::<Vec<usize>>();
    let x_count = identity(x.count_labels.len());
    let x_attr = identity(x.attr_labels.len());

    let mut p = vec![0.0; width];
    let mut count = Cells::new(width, count_labels.len());
    let mut attr = Cells::new(width, attr_labels.len());
    let mut order: Vec<usize> = Vec::new();
    let mut attr_seen = vec![false; width];
    let mut y_seen = vec![false; y.width];
    for &slot in &y.order {
        y_seen[slot] = true;
    }
    let mut x_seen = vec![false; x.width];
    for &slot in &x.order {
        x_seen[slot] = true;
    }

    for &slot in &x.order {
        let damage = x.lo + slot as f64;
        let at = (damage - lo) as usize;
        order.push(at);
        // This total's bin, copied: its labels in its order (the same label indexes).
        copy_labels(&mut count, at, &x.count, slot, &x_count);
        if x.attr_seen[slot] {
            attr_seen[at] = true;
            copy_labels(&mut attr, at, &x.attr, slot, &x_attr);
        }
        let y_slot = damage - y.lo;
        if y_slot >= 0.0 && y_slot < y.width as f64 && y_seen[y_slot as usize] {
            let y_slot = y_slot as usize;
            p[at] = x.p[slot] + y.p[y_slot];
            add_labels(&mut count, at, &y.count, y_slot, &y_count);
            if y.attr_seen[y_slot] {
                attr_seen[at] = true;
                add_labels(&mut attr, at, &y.attr, y_slot, &y_attr);
            }
        } else {
            p[at] = x.p[slot];
        }
    }
    for &slot in &y.order {
        let damage = y.lo + slot as f64;
        let x_slot = damage - x.lo;
        if x_slot >= 0.0 && x_slot < x.width as f64 && x_seen[x_slot as usize] {
            continue;
        }
        let at = (damage - lo) as usize;
        order.push(at);
        p[at] = y.p[slot];
        copy_labels(&mut count, at, &y.count, slot, &y_count);
        if y.attr_seen[slot] {
            attr_seen[at] = true;
            copy_labels(&mut attr, at, &y.attr, slot, &y_attr);
        }
    }
    DenseBins {
        lo,
        width,
        p,
        order,
        count_labels,
        count,
        attr_labels,
        attr,
        attr_seen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EPS;
    use indexmap::IndexMap;

    fn bin(p: f64, count: &[(&str, f64)], attr: Option<&[(&str, f64)]>) -> Bin {
        let m = |xs: &[(&str, f64)]| xs.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        Bin {
            p,
            count: m(count),
            attr: attr.map(m),
        }
    }

    fn pmf(bins: Vec<(f64, Bin)>) -> Pmf {
        Pmf::new(
            bins.into_iter().map(|(d, b)| (Damage(d), b)).collect(),
            EPS,
            false,
        )
    }

    /// Same bins, in the same map order, label order and float bits.
    fn same(a: &Pmf, b: &Pmf) {
        let (x, y) = (a.bins(), b.bins());
        assert_eq!(x.len(), y.len());
        for ((dx, bx), (dy, by)) in x.iter().zip(&y) {
            assert_eq!(dx.0.to_bits(), dy.0.to_bits());
            assert_eq!(bx.p.to_bits(), by.p.to_bits());
            let l = |m: &LabelMap| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.to_bits()))
                    .collect::<Vec<_>>()
            };
            assert_eq!(l(&bx.count), l(&by.count));
            assert_eq!(bx.attr.as_ref().map(l), by.attr.as_ref().map(l));
        }
        assert_eq!(a.normalized, b.normalized);
    }

    fn d6() -> Pmf {
        pmf((1..=6)
            .map(|v| {
                (
                    f64::from(v),
                    bin(1.0 / 6.0, &[("slash", f64::from(v) / 6.0)], None),
                )
            })
            .collect())
    }

    fn crit() -> Pmf {
        pmf(vec![
            (0.0, bin(0.55, &[], None)),
            (
                4.0,
                bin(0.3, &[("fire", 1.2), ("slash", 0.1)], Some(&[("hit", 0.3)])),
            ),
            (
                9.0,
                bin(
                    0.15,
                    &[("slash", 1.35)],
                    Some(&[("crit", 0.15), ("hit", 0.0)]),
                ),
            ),
        ])
    }

    fn walk(slices: &[Pmf]) {
        let mut total = DenseTotal::of(slices[0].clone(), EPS);
        let mut reference = slices[0].clone();
        for s in &slices[1..] {
            total = total.convolve(s);
            reference = reference.convolve_raw(s, Some(EPS));
            same(&total.to_pmf(), &reference);
            assert_eq!(total.mass().to_bits(), reference.mass().to_bits());
        }
    }

    #[test]
    fn convolve_walk_matches_convolve_raw() {
        walk(&[d6(), crit(), d6(), crit()]);
        walk(&[crit(), crit(), crit()]);
    }

    #[test]
    fn convolve_with_one_bin_and_masses_off_one() {
        let one = pmf(vec![(3.0, bin(0.5, &[("x", 1.5)], None))]);
        let off = pmf(vec![
            (0.0, bin(0.2, &[], None)),
            (1.0, bin(0.3, &[("y", 0.3)], None)),
        ]);
        walk(&[d6(), one.clone(), off.clone(), d6()]);
        walk(&[one, off, crit()]);
    }

    #[test]
    fn non_integer_support_takes_pmf_path() {
        let half = pmf(vec![
            (0.5, bin(0.4, &[], None)),
            (1.25, bin(0.6, &[("z", 0.6)], None)),
        ]);
        walk(&[d6(), half.clone(), crit(), half]);
    }

    #[test]
    fn scale_and_add_match_pmf() {
        let a = DenseTotal::of(d6(), EPS).convolve(&crit());
        let b = DenseTotal::of(crit(), EPS).convolve(&d6()).convolve(&d6());
        let (pa, pb) = (a.to_pmf(), b.to_pmf());
        same(&a.add(&b).to_pmf(), &pa.add(&pb));
        same(&b.add(&a).to_pmf(), &pb.add(&pa));
        same(&a.scale(0.3).to_pmf(), &pa.scale_mass(0.3));
        same(&a.scale(1.0).to_pmf(), &pa);
        same(
            &a.scale(0.25).add(&b.scale(0.75)).convolve(&d6()).to_pmf(),
            &pa.scale_mass(0.25)
                .add(&pb.scale_mass(0.75))
                .convolve_raw(&d6(), Some(EPS)),
        );
        // A pmf-carried operand falls back to the PMF's add.
        let half = DenseTotal::of(pmf(vec![(0.5, bin(1.0, &[], None))]), EPS);
        same(&a.add(&half).to_pmf(), &pa.add(&half.to_pmf()));
    }

    #[test]
    fn empty_operand_takes_pmf_path() {
        let empty = Pmf::new(IndexMap::new(), EPS, false);
        let t = DenseTotal::of(d6(), EPS).convolve(&crit());
        same(
            &t.convolve(&empty).to_pmf(),
            &t.to_pmf().convolve_raw(&empty, Some(EPS)),
        );
    }
}
