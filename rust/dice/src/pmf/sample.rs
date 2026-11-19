//! Port of `src/pmf/sample.ts`: `scaleValue` (the per-value arithmetic of `PMF.scaleDamage`, so a
//! sampler rounds the same way) and `samplePMF` (one draw from an outcome-labelled PMF).
//! `builder::sample` re-exports both.

use crate::Pmf;
use crate::builder::nodes::Rounding;
use crate::builder::num::{cmp_utf16, is_integer, js_round};
use crate::common::{MISS_NONE_OUTCOME, Rng};

/// `scaleValue` (`src/pmf/sample.ts`): the per-value arithmetic of `PMF.scaleDamage`, so a sampler
/// rounds the same way.
pub fn scale_value(value: f64, factor: f64, rounding: Rounding, denominator: f64) -> f64 {
    let exact = is_integer(value) && is_integer(factor) && is_integer(denominator);
    if exact {
        let numerator = value * factor;
        if rounding == Rounding::Round {
            return ((2.0 * numerator + denominator) / (2.0 * denominator)).floor();
        }
        let quotient = numerator / denominator;
        return if rounding == Rounding::Ceil {
            quotient.ceil()
        } else {
            quotient.floor()
        };
    }
    let scaled = (value * factor) / denominator;
    match rounding {
        Rounding::Round => js_round(scaled),
        Rounding::Ceil => scaled.ceil(),
        Rounding::Floor => scaled.floor(),
    }
}

/// `PMFSample`.
#[derive(Clone, Debug, PartialEq)]
pub struct PmfSample {
    pub total: f64,
    pub outcome: String,
}

/// `samplePMF` (`src/pmf/sample.ts`): one draw from an outcome-labelled PMF by inverse CDF, using
/// only `chance`: bins ascending by value, each taken with its conditional probability given the
/// earlier ones were not; then one outcome label inside the bin the same way.
pub fn sample_pmf(pmf: &Pmf, rng: &mut dyn Rng) -> PmfSample {
    let values: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    let Some(&last) = values.last() else {
        return PmfSample {
            total: 0.0,
            outcome: MISS_NONE_OUTCOME.to_string(),
        };
    };
    let mut remaining = pmf.mass();
    let mut chosen = last;
    for value in &values[..values.len() - 1] {
        let p = pmf.map.get(&crate::Damage(*value)).map_or(0.0, |b| b.p);
        if remaining <= 0.0 {
            break;
        }
        if rng.chance(p / remaining) {
            chosen = *value;
            break;
        }
        remaining -= p;
    }
    let Some(bin) = pmf.map.get(&crate::Damage(chosen)) else {
        return PmfSample {
            total: chosen,
            outcome: "hit".to_string(),
        };
    };
    let mut labels: Vec<&String> = bin.count.keys().collect();
    labels.sort_by(|a, b| cmp_utf16(a, b));
    let mut left = labels.iter().fold(0.0, |sum, label| {
        sum + bin.count.get(*label).copied().unwrap_or(0.0)
    });
    // A bin with no label (`PMF.fromMap`, a plain roll) is a landed payload: it draws as a "hit".
    let mut outcome = labels
        .last()
        .map_or_else(|| "hit".to_string(), |l| (*l).clone());
    for label in labels.iter().take(labels.len().saturating_sub(1)) {
        let mass = bin.count.get(*label).copied().unwrap_or(0.0);
        if left <= 0.0 {
            break;
        }
        if rng.chance(mass / left) {
            outcome.clone_from(label);
            break;
        }
        left -= mass;
    }
    PmfSample {
        total: chosen,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Bin, Damage, EPS, LabelMap};
    use indexmap::IndexMap;

    /// A scripted rng: `chance` answers from a queue; `die` is never called.
    struct Scripted(Vec<bool>);

    impl Rng for Scripted {
        fn die(&mut self, _: f64) -> f64 {
            panic!("die not expected")
        }
        fn chance(&mut self, _: f64) -> bool {
            assert!(!self.0.is_empty(), "ran out");
            self.0.remove(0)
        }
    }

    fn scripted(answers: &[bool]) -> Scripted {
        Scripted(answers.to_vec())
    }

    fn from_map(entries: &[(f64, f64)]) -> Pmf {
        let m: IndexMap<Damage, f64> = entries.iter().map(|(v, p)| (Damage(*v), *p)).collect();
        Pmf::from_map(m, EPS, false).unwrap()
    }

    type Entry<'a> = (f64, f64, &'a [(&'a str, f64)]);

    fn labeled(entries: &[Entry<'_>]) -> Pmf {
        let m: IndexMap<Damage, Bin> = entries
            .iter()
            .map(|(v, p, c)| {
                let count: LabelMap = c.iter().map(|(k, x)| (k.to_string(), *x)).collect();
                (
                    Damage(*v),
                    Bin {
                        p: *p,
                        count,
                        attr: None,
                    },
                )
            })
            .collect();
        Pmf::new(m, EPS, false)
    }

    // tests/sample-pmf.test.ts
    #[test]
    fn walks_bins_ascending_with_conditional_coins() {
        let pmf = from_map(&[(0.0, 0.25), (5.0, 0.5), (9.0, 0.25)]);
        // First coin: P(0) = 0.25 -> false; second coin: P(5 | not 0) = 0.5/0.75 -> true.
        assert_eq!(sample_pmf(&pmf, &mut scripted(&[false, true])).total, 5.0);
        assert_eq!(sample_pmf(&pmf, &mut scripted(&[true])).total, 0.0);
        // The last bin needs no coin.
        assert_eq!(sample_pmf(&pmf, &mut scripted(&[false, false])).total, 9.0);
    }

    #[test]
    fn picks_an_outcome_label_inside_the_bin() {
        let mixed = labeled(&[(6.0, 1.0, &[("hit", 0.75), ("crit", 0.25)])]);
        // Labels sorted: crit, hit; P(crit) = 0.25.
        assert_eq!(sample_pmf(&mixed, &mut scripted(&[true])).outcome, "crit");
        assert_eq!(sample_pmf(&mixed, &mut scripted(&[false])).outcome, "hit");
    }

    #[test]
    fn unlabeled_bin_is_a_hit_and_empty_pmf_is_miss_none() {
        let plain = labeled(&[(4.0, 1.0, &[])]);
        assert_eq!(sample_pmf(&plain, &mut scripted(&[])).outcome, "hit");
        let empty = Pmf::new(IndexMap::new(), EPS, false);
        assert_eq!(
            sample_pmf(&empty, &mut scripted(&[])),
            PmfSample {
                total: 0.0,
                outcome: "missNone".to_string()
            }
        );
    }

    #[test]
    fn is_unbiased_over_many_draws() {
        struct Lcg(u32);
        impl Rng for Lcg {
            fn die(&mut self, _: f64) -> f64 {
                1.0
            }
            fn chance(&mut self, p: f64) -> bool {
                self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
                f64::from(self.0) / 4294967296.0 < p
            }
        }
        let pmf = from_map(&[(0.0, 0.25), (5.0, 0.5), (9.0, 0.25)]);
        let mut lcg = Lcg(12345);
        let fives = (0..20000)
            .filter(|_| sample_pmf(&pmf, &mut lcg).total == 5.0)
            .count();
        assert!((fives as f64 / 20000.0 - 0.5).abs() < 0.05);
    }

    #[test]
    fn scale_value_matches_scale_damage_per_value() {
        let pmf = from_map(&[(7.0, 1.0)]);
        let scaled = pmf.scale_damage(1.0, "floor", 2.0).unwrap();
        assert_eq!(
            scaled.support(),
            [Damage(scale_value(7.0, 1.0, Rounding::Floor, 2.0))]
        );
        assert_eq!(scale_value(7.0, 1.0, Rounding::Floor, 2.0), 3.0);
        assert_eq!(scale_value(21.0, 9.0, Rounding::Ceil, 7.0), 27.0);
        assert_eq!(scale_value(7.0, 0.5, Rounding::Floor, 1.0), 3.0);
    }
}
