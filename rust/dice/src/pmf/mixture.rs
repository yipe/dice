//! Port of `src/pmf/mixture.ts` (`Mixture`): a labeled mixture builder that preserves provenance in
//! `Bin.count`. `builder::mixture` re-exports it.
//!
//! JS quirk not modeled: a JS object lists integer-like keys first; labels here keep insertion
//! order (as `LabelMap` does everywhere in the crate).

use crate::error::DiceError;
use crate::js::num_to_string;
use crate::{Bin, Damage, EPS, LabelMap, Pmf};
use indexmap::{IndexMap, IndexSet};

/// Compensated (Kahan) sum.
pub fn kahan_sum(values: impl Iterator<Item = f64>) -> f64 {
    let mut sum = 0.0;
    let mut c = 0.0;
    for v in values {
        let y = v - c;
        let t = sum + y;
        c = t - sum - y;
        sum = t;
    }
    sum
}

/// `Mixture<L>`: `totals` and `labelMass` keep JS `Map` insertion order.
pub struct Mixture {
    totals: IndexMap<Damage, f64>,
    label_mass: IndexMap<Damage, LabelMap>,
    eps: f64,
}

impl Mixture {
    /// `new Mixture(eps)`: a non-finite `eps` reads as `EPS`.
    pub fn new(eps: f64) -> Mixture {
        Mixture {
            totals: IndexMap::new(),
            label_mass: IndexMap::new(),
            eps: if eps.is_finite() { eps } else { EPS },
        }
    }

    /// `add(label, pmf, weight)`: a component with a mixture weight; a weight that is not a positive
    /// finite number adds nothing.
    pub fn add(&mut self, label: &str, pmf: &Pmf, weight: f64) -> &mut Self {
        if !weight.is_finite() || weight <= 0.0 {
            return self;
        }
        for (v, bin) in &pmf.map {
            let p = bin.p;
            if p <= 0.0 {
                continue;
            }
            let add = weight * p;
            if !add.is_finite() || add <= 0.0 {
                continue;
            }
            *self.totals.entry(*v).or_insert(0.0) += add;
            *self
                .label_mass
                .entry(*v)
                .or_default()
                .entry(label.to_string())
                .or_insert(0.0) += add;
        }
        self
    }

    /// `buildPMF(eps)`: the normalized mixture. `Err` where TS throws.
    pub fn build_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        let grand = kahan_sum(self.totals.values().copied());
        // TS `!(grand > 0)`: a NaN total is zero mass.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(grand > 0.0) {
            return Err(DiceError::error("Mixture: zero total mass"));
        }
        let threshold = self.eps * grand;
        let kept: Vec<(Damage, f64)> = self
            .totals
            .iter()
            .filter(|(_, m)| **m > 0.0 && **m >= threshold)
            .map(|(v, m)| (*v, *m))
            .collect();
        if kept.is_empty() {
            return Err(DiceError::error(format!(
                "Mixture: pruning at eps {} removed every outcome",
                num_to_string(self.eps)
            )));
        }
        let kept_total = if kept.len() == self.totals.len() {
            grand
        } else {
            kahan_sum(kept.iter().map(|(_, m)| *m))
        };
        let mut internal: IndexMap<Damage, Bin> = IndexMap::new();
        for (v, m) in kept {
            let mut count = LabelMap::new();
            if let Some(bag) = self.label_mass.get(&v) {
                for (label, mass) in bag {
                    count.insert(label.clone(), mass / kept_total);
                }
            }
            internal.insert(
                v,
                Bin {
                    p: m / kept_total,
                    count,
                    attr: None,
                },
            );
        }
        Ok(Pmf::new(internal, eps, false))
    }
}

impl Mixture {
    /// `clear()`: remove all accumulated state.
    pub fn clear(&mut self) -> &mut Self {
        self.totals.clear();
        self.label_mass.clear();
        self
    }

    /// `size()`: number of distinct outcome values currently accumulated.
    pub fn size(&self) -> usize {
        self.totals.len()
    }

    /// `hasLabel(label)`: whether a label was ever added.
    pub fn has_label(&self, label: &str) -> bool {
        // TS `if (bag[label])`: a recorded mass of 0 or NaN is falsy.
        self.label_mass
            .values()
            .any(|bag| bag.get(label).is_some_and(|w| *w != 0.0 && !w.is_nan()))
    }

    /// `byOutcome()`: the normalized per-label PMFs (labels independent), built from the raw mass of
    /// that label alone; values below `eps` of the label's own mass are pruned. `Err` where
    /// `PMF.fromMap` throws.
    pub fn by_outcome(&self) -> Result<IndexMap<String, Pmf>, DiceError> {
        let mut labels: IndexSet<&str> = IndexSet::new();
        for bag in self.label_mass.values() {
            for k in bag.keys() {
                labels.insert(k);
            }
        }
        let mut out = IndexMap::new();
        for label in labels {
            let label_total = kahan_sum(
                self.label_mass
                    .values()
                    .map(|bag| bag.get(label).copied().unwrap_or(0.0)),
            );
            // TS `!(labelTotal > 0)`.
            if label_total.is_nan() || label_total <= 0.0 {
                continue;
            }
            let mut m: IndexMap<Damage, f64> = IndexMap::new();
            for (v, bag) in &self.label_mass {
                if let Some(w) = bag.get(label).copied()
                    && w != 0.0
                    && !w.is_nan()
                {
                    m.insert(*v, w / label_total);
                }
            }
            out.insert(label.to_string(), Pmf::from_map(m, self.eps, false)?);
        }
        Ok(out)
    }

    /// `weights()`: mixture weights per label, normalized to sum to 1 over labels that appeared.
    /// Uses raw mass before per-outcome normalization.
    pub fn weights(&self) -> IndexMap<String, f64> {
        let mut res: IndexMap<String, f64> = IndexMap::new();
        for bag in self.label_mass.values() {
            for (lab, w) in bag {
                if !w.is_finite() || *w <= 0.0 {
                    continue;
                }
                *res.entry(lab.clone()).or_insert(0.0) += w;
            }
        }
        let total = kahan_sum(res.values().copied());
        if total > 0.0 {
            for v in res.values_mut() {
                *v /= total;
            }
        }
        res
    }

    /// `toJSON()`: `totals` and `labels` sorted by outcome value, and `eps`.
    pub fn to_json(&self) -> MixtureJson {
        let mut totals: Vec<(f64, f64)> = self.totals.iter().map(|(k, v)| (k.0, *v)).collect();
        totals.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut labels: Vec<(f64, LabelMap)> = self
            .label_mass
            .iter()
            .map(|(k, v)| (k.0, v.clone()))
            .collect();
        labels.sort_by(|a, b| a.0.total_cmp(&b.0));
        MixtureJson {
            totals,
            labels,
            eps: self.eps,
        }
    }

    /// `Mixture.mix(items, eps)`: add every `(label, pmf, weight)`, then `buildPMF(eps)`.
    pub fn mix(items: &[(&str, &Pmf, f64)], eps: f64) -> Result<Pmf, DiceError> {
        let mut mix = Mixture::new(eps);
        for (label, pmf, w) in items {
            mix.add(label, pmf, *w);
        }
        mix.build_pmf(eps)
    }
}

/// `Mixture.toJSON()`.
#[derive(Clone, Debug, PartialEq)]
pub struct MixtureJson {
    pub totals: Vec<(f64, f64)>,
    pub labels: Vec<(f64, LabelMap)>,
    pub eps: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::factory::roll_dice;
    use crate::query::{DiceQuery, Labels};

    fn close(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} vs {b}");
    }

    fn die(sides: u32) -> Pmf {
        let m: IndexMap<Damage, f64> = (1..=sides).map(|i| (Damage(f64::from(i)), 1.0)).collect();
        Pmf::from_map(m, EPS, false).unwrap()
    }

    fn roll_pmf(count: f64, sides: f64) -> Pmf {
        roll_dice(count, sides, None).unwrap().to_pmf(0.0).unwrap()
    }

    // tests/mixture.test.ts
    #[test]
    fn initializes_empty() {
        let mix = Mixture::new(EPS);
        assert_eq!(mix.size(), 0);
        assert_eq!(mix.build_pmf(EPS).unwrap_err(), "Mixture: zero total mass");
    }

    #[test]
    fn adds_a_single_labeled_pmf() {
        let mut mix = Mixture::new(EPS);
        mix.add("a", &die(4), 1.0);
        assert_eq!(mix.size(), 4);
        assert!(mix.has_label("a"));
        let pmf = mix.build_pmf(EPS).unwrap();
        close(pmf.mass(), 1.0, 1e-12);
        for i in 1..=4 {
            close(pmf.p_at(f64::from(i)), 0.25, 1e-12);
            close(pmf.map[&Damage(f64::from(i))].count["a"], 0.25, 1e-12);
        }
    }

    #[test]
    fn adds_multiple_pmfs_with_different_labels_and_weights() {
        let mut mix = Mixture::new(EPS);
        mix.add("hit", &die(4), 0.7).add("crit", &die(6), 0.3);
        let pmf = mix.build_pmf(EPS).unwrap();
        let total = 0.7 + 0.3;
        for i in 1..=4 {
            let p = pmf.p_at(f64::from(i));
            let bin = &pmf.map[&Damage(f64::from(i))];
            let hit = 0.7 * (1.0 / 4.0);
            let crit = if i <= 6 { 0.3 * (1.0 / 6.0) } else { 0.0 };
            close(p, (hit + crit) / total, 1e-12);
            close(bin.count["hit"], hit, 1e-12);
            if crit > 0.0 {
                close(bin.count["crit"], crit, 1e-12);
            }
        }
        for i in 5..=6 {
            let bin = &pmf.map[&Damage(f64::from(i))];
            close(pmf.p_at(f64::from(i)), 0.3 * (1.0 / 6.0) / total, 1e-12);
            close(bin.count["crit"], 0.3 * (1.0 / 6.0), 1e-12);
            assert!(!bin.count.contains_key("hit"));
        }
    }

    #[test]
    fn overlapping_outcomes_sum_mass() {
        let mut mix = Mixture::new(EPS);
        mix.add("a", &die(4), 1.0).add("b", &die(4), 2.0);
        let pmf = mix.build_pmf(EPS).unwrap();
        for i in 1..=4 {
            let bin = &pmf.map[&Damage(f64::from(i))];
            close(
                pmf.p_at(f64::from(i)),
                (1.0 * 0.25 + 2.0 * 0.25) / 3.0,
                1e-12,
            );
            close(bin.count["a"], 0.25 / 3.0, 1e-12);
            close(bin.count["b"], 0.5 / 3.0, 1e-12);
        }
    }

    #[test]
    fn ignores_zero_negative_and_invalid_weights() {
        let mut mix = Mixture::new(EPS);
        mix.add("a", &die(4), 1.0);
        let before = mix.to_json();
        mix.add("b", &die(6), 0.0).add("c", &die(6), -10.0);
        assert_eq!(mix.to_json(), before);
        assert!(!mix.has_label("b"));
        mix.add("b", &die(6), f64::NAN)
            .add("c", &die(6), f64::INFINITY)
            .add("d", &die(6), f64::NEG_INFINITY);
        assert_eq!(mix.to_json(), before);
    }

    #[test]
    fn clear_resets_state() {
        let mut mix = Mixture::new(EPS);
        mix.add("a", &die(4), 1.0);
        mix.clear();
        assert_eq!(mix.size(), 0);
        assert!(!mix.has_label("a"));
        assert!(mix.build_pmf(EPS).is_err());
    }

    #[test]
    fn by_outcome_per_label_pmfs() {
        let mut mix = Mixture::new(EPS);
        mix.add("hit", &die(4), 1.0)
            .add("miss", &Pmf::delta(0.0, EPS).unwrap(), 1.0);
        let by = mix.by_outcome().unwrap();
        assert_eq!(by.keys().collect::<Vec<_>>(), ["hit", "miss"]);
        let hit = &by["hit"];
        close(hit.mass(), 1.0, 1e-12);
        assert_eq!(
            hit.support().iter().map(|d| d.0).collect::<Vec<_>>(),
            [1.0, 2.0, 3.0, 4.0]
        );
        close(hit.p_at(1.0), 0.25, 1e-12);
        let miss = &by["miss"];
        close(miss.mass(), 1.0, 1e-12);
        assert_eq!(miss.support(), [Damage(0.0)]);
        close(miss.p_at(0.0), 1.0, 1e-12);
    }

    #[test]
    fn weights_are_normalized_labels() {
        let mut mix = Mixture::new(EPS);
        mix.add("a", &die(4), 1.5)
            .add("b", &die(6), 3.5)
            .add("c", &die(4), 0.0);
        let w = mix.weights();
        let total = 1.5 + 3.5;
        close(w["a"], 1.5 / total, 1e-12);
        close(w["b"], 3.5 / total, 1e-12);
        assert!(!w.contains_key("c"));
        let mut zero = Mixture::new(EPS);
        zero.add("a", &die(4), 0.0);
        assert!(zero.weights().is_empty());
    }

    #[test]
    fn mix_labeled_matches_builder() {
        let mut mix = Mixture::new(EPS);
        mix.add("hit", &die(4), 0.7).add("crit", &die(6), 0.3);
        let a = mix.build_pmf(EPS).unwrap();
        let b = Mixture::mix(&[("hit", &die(4), 0.7), ("crit", &die(6), 0.3)], EPS).unwrap();
        close(a.mean(), b.mean(), 1e-12);
        close(a.variance(), b.variance(), 1e-12);
        assert_eq!(a.support(), b.support());
        assert_eq!(
            Mixture::mix(&[], EPS).unwrap_err(),
            "Mixture: zero total mass"
        );
    }

    #[test]
    fn custom_epsilon_prunes_relative_to_total() {
        let mut mix = Mixture::new(0.1);
        mix.add("a", &die(4), 1.0)
            .add("b", &Pmf::delta(10.0, EPS).unwrap(), 0.05);
        let pmf = mix.build_pmf(0.1).unwrap();
        assert_eq!(
            pmf.support().iter().map(|d| d.0).collect::<Vec<_>>(),
            [1.0, 2.0, 3.0, 4.0]
        );
        close(pmf.p_at(1.0), 0.25, 1e-12);
        close(pmf.outcome_probability("a"), 1.0, 1e-12);
        close(pmf.outcome_probability("b"), 0.0, 1e-12);
    }

    #[test]
    fn invalid_constructor_epsilon_defaults() {
        for e in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            assert_eq!(Mixture::new(e).to_json().eps, EPS);
        }
    }

    #[test]
    fn empty_pmf_adds_nothing_and_repeated_label_sums() {
        let mut mix = Mixture::new(EPS);
        mix.add("a", &die(4), 1.0);
        let before = mix.to_json();
        mix.add("b", &Pmf::new(IndexMap::new(), EPS, false), 1.0);
        assert_eq!(mix.to_json(), before);
        let mut m2 = Mixture::new(EPS);
        m2.add("a", &die(4), 1.0).add("a", &die(4), 2.0);
        let pmf = m2.build_pmf(EPS).unwrap();
        close(pmf.p_at(1.0), 0.25, 1e-12);
        close(pmf.map[&Damage(1.0)].count["a"], 0.25, 1e-12);
    }

    #[test]
    fn by_outcome_from_manual_state_and_invalid_maps() {
        let mut mix = Mixture::new(EPS);
        mix.label_mass
            .insert(Damage(10.0), LabelMap::from_iter([("a".to_string(), 1.0)]));
        mix.label_mass
            .insert(Damage(20.0), LabelMap::from_iter([("a".to_string(), 3.0)]));
        let pmfs = mix.by_outcome().unwrap();
        let pmf = &pmfs["a"];
        close(pmf.mass(), 1.0, 1e-12);
        close(pmf.p_at(10.0), 0.25, 1e-12);
        close(pmf.p_at(20.0), 0.75, 1e-12);
        assert_eq!(pmf.support(), [Damage(10.0), Damage(20.0)]);
        let mut empty = Mixture::new(EPS);
        empty.add(
            "a",
            &Pmf::from_map(IndexMap::from([(Damage(1.0), 1.0)]), EPS, false).unwrap(),
            0.0,
        );
        empty.add("b", &die(2), -10.0);
        assert!(empty.by_outcome().unwrap().is_empty());
    }

    #[test]
    fn add_reads_each_bin_probability() {
        let mut mix = Mixture::new(EPS);
        let p1 = Pmf::from_map(
            IndexMap::from([(Damage(1.0), 0.25), (Damage(2.0), 0.75)]),
            EPS,
            false,
        )
        .unwrap();
        mix.add("a", &p1, 1.0);
        let pmf1 = mix.build_pmf(EPS).unwrap();
        close(pmf1.p_at(1.0), 0.25, 1e-12);
        close(pmf1.p_at(2.0), 0.75, 1e-12);
        mix.clear();
        let p2 = Pmf::from_map(
            IndexMap::from([(Damage(5.0), 0.4), (Damage(6.0), 0.6)]),
            EPS,
            false,
        )
        .unwrap();
        mix.add("b", &p2, 1.0);
        let pmf2 = mix.build_pmf(EPS).unwrap();
        close(pmf2.p_at(5.0), 0.4, 1e-12);
        close(pmf2.p_at(6.0), 0.6, 1e-12);
    }

    // tests/mixture-label-normalization.test.ts
    #[test]
    fn normalizes_label_counts_by_grand_total() {
        let d8 = || roll_pmf(1.0, 8.0);
        let delta0 = Pmf::delta(0.0, EPS).unwrap();
        let pmf = Mixture::mix(&[("hit", &d8(), 2.0), ("missNone", &delta0, 2.0)], EPS).unwrap();
        close(pmf.outcome_probability("hit"), 0.5, 1e-15);
        close(pmf.outcome_probability("missNone"), 0.5, 1e-15);
        let q = DiceQuery::of(vec![pmf.clone()]);
        let hit = Labels::One("hit".to_string());
        close(q.prob_at_least_one(&hit), 0.5, 1e-15);
        close(q.expected_damage_from(&hit), 9.0 / 4.0, 1e-14);
        for bin in pmf.map.values() {
            close(bin.count.values().fold(0.0, |a, b| a + b), bin.p, 1e-15);
        }
    }

    #[test]
    fn weights_half_and_quarter() {
        let pmf = Mixture::mix(
            &[
                ("hit", &roll_pmf(1.0, 8.0), 0.5),
                ("crit", &roll_pmf(1.0, 6.0), 0.25),
            ],
            EPS,
        )
        .unwrap();
        close(pmf.outcome_probability("hit"), 2.0 / 3.0, 1e-15);
        close(pmf.outcome_probability("crit"), 1.0 / 3.0, 1e-15);
        close(
            pmf.p_at(3.0),
            (2.0 / 3.0) * (1.0 / 8.0) + (1.0 / 3.0) * (1.0 / 6.0),
            1e-15,
        );
    }

    #[test]
    fn tiny_equal_weights_are_fifty_fifty() {
        let delta0 = Pmf::delta(0.0, EPS).unwrap();
        let pmf = Mixture::mix(
            &[
                ("hit", &roll_pmf(1.0, 8.0), 1e-13),
                ("missNone", &delta0, 1e-13),
            ],
            EPS,
        )
        .unwrap();
        close(pmf.p_at(0.0), 0.5, 1e-15);
        close(pmf.p_at(8.0), 1.0 / 16.0, 1e-15);
        close(pmf.outcome_probability("hit"), 0.5, 1e-15);
    }

    #[test]
    fn built_pmf_is_unchanged_by_later_adds() {
        let delta0 = Pmf::delta(0.0, EPS).unwrap();
        let mut mix = Mixture::new(EPS);
        mix.add("hit", &roll_pmf(1.0, 8.0), 2.0)
            .add("crit", &roll_pmf(1.0, 6.0), 1.0)
            .add("missNone", &delta0, 1.0);
        let built = mix.build_pmf(EPS).unwrap();
        let before = built.outcome_at(3.0, "hit");
        close(before, (2.0 / 4.0) * (1.0 / 8.0), 1e-15);
        mix.add("hit", &roll_pmf(1.0, 8.0), 100.0);
        assert_eq!(built.outcome_at(3.0, "hit"), before);
        close(built.p_at(3.0), 5.0 / 48.0, 1e-15);
    }

    #[test]
    fn eps_zero_keeps_extreme_bins() {
        let pmf = Mixture::mix(&[("hit", &roll_pmf(20.0, 6.0), 1.0)], 0.0).unwrap();
        assert_eq!(pmf.min(), 20.0);
        assert_eq!(pmf.max(), 120.0);
        close(pmf.p_at(120.0), 6f64.powi(-20), 1e-30);
    }

    #[test]
    fn pruning_is_independent_of_weight_scale() {
        let small = Mixture::mix(&[("hit", &roll_pmf(20.0, 6.0), 1e-6)], EPS).unwrap();
        let unit = Mixture::mix(&[("hit", &roll_pmf(20.0, 6.0), 1.0)], EPS).unwrap();
        assert_eq!(small.support(), unit.support());
    }

    #[test]
    fn pruning_that_leaves_nothing_errs() {
        let mut m = Mixture::new(0.5);
        m.add("hit", &roll_pmf(1.0, 6.0), 1.0);
        assert!(
            m.build_pmf(EPS)
                .unwrap_err()
                .message()
                .contains("removed every outcome")
        );
    }
}
