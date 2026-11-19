//! Mass transforms. Port of pmf.ts: normalize (648), add (869), addScaled (882), scaleMass (1042).

use super::{Bin, LabelMap, Pmf};
use crate::Damage;
use indexmap::IndexMap;

/// `PMF.cloneBin`: deep-copies a bin, cloning its count and (optional) attr maps.
fn clone_bin(bin: &Bin) -> Bin {
    Bin {
        p: bin.p,
        count: bin.count.clone(),
        attr: bin.attr.clone(),
    }
}

/// `PMF.scaleBin`: a new bin with p, count and attr all multiplied by `factor`.
pub(super) fn scale_bin(bin: &Bin, factor: f64) -> Bin {
    let count: LabelMap = bin
        .count
        .iter()
        .map(|(k, v)| (k.clone(), *v * factor))
        .collect();
    let attr = bin
        .attr
        .as_ref()
        .map(|a| a.iter().map(|(k, v)| (k.clone(), *v * factor)).collect());
    Bin {
        p: bin.p * factor,
        count,
        attr,
    }
}

impl Pmf {
    pub fn normalize(&self) -> Pmf {
        if self.normalized {
            return self.clone();
        }
        let factor = self.mass();
        if factor == 0.0 {
            return self.clone();
        }

        // Note: this divides by factor rather than multiplying by its reciprocal,
        // to keep results bit-identical to direct division.
        let mut map = IndexMap::new();
        for (damage, bin) in &self.map {
            let count: LabelMap = bin
                .count
                .iter()
                .map(|(k, v)| (k.clone(), *v / factor))
                .collect();
            let attr = bin
                .attr
                .as_ref()
                .map(|a| a.iter().map(|(k, v)| (k.clone(), *v / factor)).collect());
            map.insert(
                *damage,
                Bin {
                    p: bin.p / factor,
                    count,
                    attr,
                },
            );
        }
        Pmf {
            fp: Default::default(),
            map,
            epsilon: self.epsilon,
            normalized: true,
            identifier: self.identifier.clone(),
        }
    }

    pub fn scale_mass(&self, factor: f64) -> Pmf {
        if factor == 1.0 {
            return self.clone();
        }
        let map: IndexMap<Damage, Bin> = self
            .map
            .iter()
            .map(|(k, b)| (*k, scale_bin(b, factor)))
            .collect();
        Pmf {
            fp: Default::default(),
            map,
            epsilon: self.epsilon,
            normalized: false,
            identifier: None,
        }
    }

    // Convenience method: `add(other)` = `addScaled(other, 1)`.
    pub fn add(&self, other: &Pmf) -> Pmf {
        self.add_scaled(other, 1.0)
    }

    /// `branch` added, scaled by `probability` before merging. One pass: each of this PMF's
    /// bins is copied with the branch's bin at the same damage added into it (its labels after
    /// this bin's, in the branch's order), then the branch's other bins are copied after them.
    pub fn add_scaled(&self, branch: &Pmf, probability: f64) -> Pmf {
        if probability == 0.0 {
            return self.clone();
        }

        // `x * 1` is `x`: an unscaled branch merges its bins as they are. A scaled one has
        // each value multiplied as it is read — the same product `scaleBin` would store.
        let mut result = IndexMap::new();
        for (dmg, bin) in &self.map {
            let Some(added) = branch.map.get(dmg) else {
                result.insert(*dmg, clone_bin(bin));
                continue;
            };
            let mut count = bin.count.clone();
            for (label, v) in &added.count {
                let value = if probability == 1.0 {
                    *v
                } else {
                    *v * probability
                };
                let entry = count.entry(label.clone()).or_insert(0.0);
                *entry += value;
            }
            let mut attr = bin.attr.clone();
            if let Some(added_attr) = &added.attr {
                let slot = attr.get_or_insert_with(IndexMap::new);
                for (label, v) in added_attr {
                    let value = if probability == 1.0 {
                        *v
                    } else {
                        *v * probability
                    };
                    let entry = slot.entry(label.clone()).or_insert(0.0);
                    *entry += value;
                }
            }
            let p = bin.p
                + if probability == 1.0 {
                    added.p
                } else {
                    added.p * probability
                };
            result.insert(*dmg, Bin { p, count, attr });
        }
        for (dmg, bin) in &branch.map {
            if !self.map.contains_key(dmg) {
                let b = if probability == 1.0 {
                    clone_bin(bin)
                } else {
                    scale_bin(bin, probability)
                };
                result.insert(*dmg, b);
            }
        }
        Pmf {
            fp: Default::default(),
            map: result,
            epsilon: self.epsilon,
            normalized: false,
            identifier: None,
        }
    }
}
