//! Convolution. Port of pmf.ts: convolve (1159), convolveOrdered (1208),
//! massOf (1228), scaleInPlace (1235) and convolveBins (1255)/convolveBinsSparse (1356).
//! `convolve_bins` dispatches as TS does: shifted kernel for a one-bin operand, else the dense
//! kernel (dense.rs), else the sparse walk. All add the same sums in the same order.

use crate::Damage;
use std::cmp::Ordering;

use indexmap::IndexMap;

use std::sync::Arc;

use super::cache::PMF_CACHE;
use super::{Bin, LabelMap, Pmf};
use crate::js::num_to_string;

use super::dense;

impl Pmf {
    /// `convolve(other, eps, raw)`; `eps` None means `self.epsilon`. Goes through the shared cache
    /// (see [`Pmf::convolve_shared`]); a hit is cloned out of it.
    pub fn convolve(&self, other: &Pmf, eps: Option<f64>, raw: bool) -> Pmf {
        (*self.convolve_shared(other, eps, raw)).clone()
    }

    /// [`Pmf::convolve`] through `pmfCache`, keyed `v5:RAW|N@eps|fingerprintA|fingerprintB` on the
    /// operands in content order, returning the cached `Arc`.
    pub fn convolve_shared(&self, other: &Pmf, eps: Option<f64>, raw: bool) -> Arc<Pmf> {
        let epsilon = eps.unwrap_or(self.epsilon);

        // Normalize-by-value on non-raw path: bind the normalized copy (if needed) to a
        // local so the borrow of it outlives the call into the closure.
        let a_self = self;
        let a_norm = if raw
            || a_self.normalized
            || (a_self.mass() - 1.0).abs() <= epsilon
            || a_self.mass() == 0.0
        {
            None
        } else {
            Some(a_self.normalize_shared())
        };
        let b_self = other;
        let b_norm = if raw
            || b_self.normalized
            || (b_self.mass() - 1.0).abs() <= epsilon
            || b_self.mass() == 0.0
        {
            None
        } else {
            Some(b_self.normalize_shared())
        };
        let a0: &Pmf = a_norm.as_deref().unwrap_or(a_self);
        let b0: &Pmf = b_norm.as_deref().unwrap_or(b_self);
        let a_fp = a0.fingerprint_ref();
        let b_fp = b0.fingerprint_ref();
        let (a, b, a_fp, b_fp) =
            if a_fp.encode_utf16().cmp(b_fp.encode_utf16()) != Ordering::Greater {
                (a0, b0, a_fp, b_fp)
            } else {
                (b0, a0, b_fp, a_fp)
            };
        let key = format!(
            "v5:{}@{}|{}|{}",
            if raw { "RAW" } else { "N" },
            num_to_string(epsilon),
            a_fp,
            b_fp
        );
        if let Some(hit) = PMF_CACHE.get(&key) {
            return hit;
        }
        let result = Arc::new(convolve_ordered(a, b, epsilon, raw));
        PMF_CACHE.set(&key, Arc::clone(&result));
        result
    }
}

/// `PMF.convolveOrdered`: `a ⊛ b` for operands already in content order, with the mass invariant enforced.
fn convolve_ordered(a: &Pmf, b: &Pmf, epsilon: f64, raw: bool) -> Pmf {
    let mut map = convolve_bins(a, b);
    // Enforce mass invariant: mass(out) = (raw? a.mass():1) * (raw? b.mass():1). The map is this
    // call's own, so it is rescaled in place: each value times the factor, as `scaleMass` would,
    // and like `scaleMass`'s result the rescaled PMF is not `normalized` (so the non-raw path
    // then divides it through, as it always has).
    let m_exp = (if raw { a.mass() } else { 1.0 }) * (if raw { b.mass() } else { 1.0 });
    let m_got = mass_of(&map);
    // Guard mGot != 0: a zero-mass operand convolves to the zero measure
    // (mass 0). Without this guard the non-raw path would scaleMass(mExp/0) =
    // scaleMass(Infinity), poisoning every bin to 0*Infinity = NaN.
    let rescaled = m_exp != 0.0 && m_got != 0.0 && (m_got - m_exp).abs() > epsilon;
    if rescaled {
        scale_in_place(&mut map, m_exp / m_got);
    }
    let mut result = Pmf::new(map, epsilon, !raw && !rescaled);
    if !raw && m_got != 0.0 && (result.mass() - 1.0).abs() > epsilon {
        result = result.normalize();
    }
    result
}

/// `PMF.massOf`: the mass of `map`: its bins' `p` summed in map order.
fn mass_of(map: &IndexMap<Damage, Bin>) -> f64 {
    let mut total = 0.0;
    for b in map.values() {
        total += b.p;
    }
    total
}

/// `PMF.scaleInPlace`: every value of every bin of `map` times `factor`, in place:
/// `scaleBin` without the copy.
fn scale_in_place(map: &mut IndexMap<Damage, Bin>, factor: f64) {
    for bin in map.values_mut() {
        bin.p *= factor;
        for v in bin.count.values_mut() {
            *v *= factor;
        }
        if let Some(attr) = bin.attr.as_mut() {
            for v in attr.values_mut() {
                *v *= factor;
            }
        }
    }
}

/// `PMF.convolveBins`: the bins of `a ⊛ b`. Both operands are walked in ascending damage order
/// (`support()`); within a pair, A's labels then B's. The result map lists damage values in the
/// order the walk first reaches them.
fn convolve_bins(a: &Pmf, b: &Pmf) -> IndexMap<Damage, Bin> {
    let a_damages = a.support();
    let b_damages = b.support();
    if a_damages.is_empty() || b_damages.is_empty() {
        return IndexMap::new();
    }
    if a_damages.len() == 1 || b_damages.len() == 1 {
        return convolve_bins_shifted(a, b, &a_damages, &b_damages);
    }
    dense::dense_convolve(a, &a_damages, b, &b_damages)
        .unwrap_or_else(|| convolve_bins_sparse(a, b))
}

/// `PMF.convolveBinsShifted`: one operand has a single bin, so every pair reaches its own damage
/// and each result bin is one pair's terms added to 0 (`0 + x`, which keeps a `-0` out), A's
/// labels then B's. Two pairs that round to one damage take the sparse walk.
fn convolve_bins_shifted(
    a: &Pmf,
    b: &Pmf,
    a_damages: &[Damage],
    b_damages: &[Damage],
) -> IndexMap<Damage, Bin> {
    let mut combined: IndexMap<Damage, Bin> =
        IndexMap::with_capacity(a_damages.len() * b_damages.len());
    for a_val in a_damages {
        let a_bin = &a.map[a_val];
        let ap = a_bin.p;
        for b_val in b_damages {
            let b_bin = &b.map[b_val];
            let bp = b_bin.p;
            let dmg = *a_val + *b_val;
            if combined.contains_key(&dmg) {
                return convolve_bins_sparse(a, b);
            }
            let merge = |own: &LabelMap, other: &LabelMap| -> LabelMap {
                let mut m = LabelMap::with_capacity(own.len() + other.len());
                for (k, v) in own {
                    m.insert(k.clone(), 0.0 + v * bp);
                }
                for (k, v) in other {
                    let prev = m.get(k).copied().map_or(0.0, dense::or_zero);
                    m.insert(k.clone(), prev + v * ap);
                }
                m
            };
            let count = merge(&a_bin.count, &b_bin.count);
            let attr = if a_bin.attr.is_some() || b_bin.attr.is_some() {
                let empty = LabelMap::new();
                Some(merge(
                    a_bin.attr.as_ref().unwrap_or(&empty),
                    b_bin.attr.as_ref().unwrap_or(&empty),
                ))
            } else {
                None
            };
            combined.insert(
                dmg,
                Bin {
                    p: 0.0 + ap * bp,
                    count,
                    attr,
                },
            );
        }
    }
    combined
}

/// `PMF.convolveBinsSparse`: the same walk over a map and label objects, for a non-integer or
/// very wide support.
fn convolve_bins_sparse(a: &Pmf, b: &Pmf) -> IndexMap<Damage, Bin> {
    let b_damages = b.support();
    // The same walk over a map and label objects (convolveBinsSparse).
    let mut map = IndexMap::new();
    for a_val in a.support() {
        let a_bin = &a.map[&a_val];
        let ap = a_bin.p;
        let a_count_keys: Vec<&str> = a_bin.count.keys().map(String::as_str).collect();
        let a_count_values: Vec<f64> = a_bin.count.values().copied().collect();
        let a_attr_keys: Option<Vec<&str>> = a_bin
            .attr
            .as_ref()
            .map(|m| m.keys().map(String::as_str).collect());
        let a_attr_values: Option<Vec<f64>> =
            a_bin.attr.as_ref().map(|m| m.values().copied().collect());
        // Ported from the sparse walk, which indexes the precomputed B arrays by `j`.
        for b_val in &b_damages {
            let b_val = *b_val;
            let b_bin = &b.map[&b_val];
            let bp = b_bin.p;
            let b_count_keys: Vec<&str> = b_bin.count.keys().map(String::as_str).collect();
            let b_count_values: Vec<f64> = b_bin.count.values().copied().collect();
            let b_attr_keys: Option<Vec<&str>> = b_bin
                .attr
                .as_ref()
                .map(|m| m.keys().map(String::as_str).collect());
            let b_attr_values: Option<Vec<f64>> =
                b_bin.attr.as_ref().map(|m| m.values().copied().collect());
            let dmg = a_val + b_val;

            let dest = map.entry(dmg).or_insert_with(|| Bin {
                p: 0.0,
                count: IndexMap::new(),
                attr: None,
            });
            dest.p += ap * bp;

            {
                let dc = &mut dest.count;
                for (i, k) in a_count_keys.iter().enumerate() {
                    let v = dc.get(*k).copied().unwrap_or(0.0) + a_count_values[i] * bp;
                    dc.insert((*k).to_string(), v);
                }
                for (i, k) in b_count_keys.iter().enumerate() {
                    let v = dc.get(*k).copied().unwrap_or(0.0) + b_count_values[i] * ap;
                    dc.insert((*k).to_string(), v);
                }
            }

            if a_attr_keys.is_some() || b_attr_keys.is_some() {
                let da = dest.attr.get_or_insert_with(IndexMap::new);
                if let (Some(ka), Some(va)) = (&a_attr_keys, &a_attr_values) {
                    for (i, k) in ka.iter().enumerate() {
                        let v = da.get(*k).copied().unwrap_or(0.0) + va[i] * bp;
                        da.insert((*k).to_string(), v);
                    }
                }
                if let (Some(ka), Some(va)) = (b_attr_keys.as_ref(), b_attr_values.as_ref()) {
                    for (i, k) in ka.iter().enumerate() {
                        let v = da.get(*k).copied().unwrap_or(0.0) + va[i] * ap;
                        da.insert((*k).to_string(), v);
                    }
                }
            }
        }
    }
    map
}

impl Pmf {
    /// `convolveRaw(other, eps)` (1201). Operand order: `PMF.contentAtOrBefore(a, b)` (1130) is
    /// documented to equal `a.fingerprint() <= b.fingerprint()`; use that comparison.
    pub fn convolve_raw(&self, other: &Pmf, eps: Option<f64>) -> Pmf {
        let epsilon = eps.unwrap_or(self.epsilon);
        // Operand order, as `convolve` orders them: `a.fingerprint() <= b.fingerprint()` (1196).
        let (a, b) = if self
            .fingerprint_ref()
            .encode_utf16()
            .cmp(other.fingerprint_ref().encode_utf16())
            != Ordering::Greater
        {
            (self, other)
        } else {
            (other, self)
        };
        convolve_ordered(a, b, epsilon, true)
    }

    /// `combineRaw(other, eps)` (1437).
    pub fn combine_raw(&self, other: &Pmf, eps: Option<f64>) -> Pmf {
        self.convolve(other, eps, true)
    }

    /// `PMF.convolveMany(list, eps)` (1445).
    pub fn convolve_many(list: &[Pmf], eps: f64) -> Pmf {
        if list.is_empty() {
            // `PMF.empty(eps)`: an empty map, not normalized.
            return Pmf::new(IndexMap::new(), eps, false);
        }
        // Left fold, each step a non-raw convolve with the explicit epsilon.
        let mut result = list[0].clone();
        for item in list.iter().skip(1) {
            result = result.convolve(item, Some(eps), false);
        }
        result
    }

    /// [`Pmf::convolve_many`] over shared PMFs: a one-element list is that same `Arc`
    /// (TS returns `pmfList[0]` itself), so its memos stay warm.
    pub fn convolve_many_shared(list: &[Arc<Pmf>], eps: f64) -> Arc<Pmf> {
        match list {
            [only] => only.clone(),
            [] => Arc::new(Pmf::new(IndexMap::new(), eps, false)),
            [first, rest @ ..] => {
                let mut result = first.convolve(&rest[0], Some(eps), false);
                for item in &rest[1..] {
                    result = result.convolve(item, Some(eps), false);
                }
                Arc::new(result)
            }
        }
    }
}
