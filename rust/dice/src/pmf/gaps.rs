//! Port of pmf.ts `mapValues` (2164) and `firstSuccessWeights` (2116); `splitByFactor` is in
//! `reshape.rs`.
//! A TS throw is `Err(message)`.

use crate::error::DiceError;
use indexmap::IndexMap;

use super::reshape::merge_into;
use super::{Bin, LabelMap, Pmf};
use crate::builder::nodes::Rounding;
use crate::builder::num::{is_integer, js_round};
use crate::js::num_to_string;
use crate::{Damage, EPS};

/// `firstSuccessWeights` result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FirstSuccessWeights {
    /// P(the first success was of the "special" type).
    pub p_specific_success: f64,
    /// P(the first success was of the non-special type).
    pub p_general_success: f64,
    /// P(no successes).
    pub p_none: f64,
    /// P(at least one success).
    pub p_any: f64,
}

/// JS `Math.pow`: differs from `powf` where the exponent is NaN or the base is ±1 and the
/// exponent infinite (both NaN in JS, 1 in Rust).
fn js_pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (x.abs() == 1.0 && y.is_infinite()) {
        f64::NAN
    } else {
        x.powf(y)
    }
}

impl Pmf {
    /// `mapValues(f, eps, { rounding, preserveCounts })`: maps every damage value through `f`, then
    /// optionally rounds it (`rounding` `None` is `"none"`). Values that land on the same result
    /// merge their probability and, unless `preserve_counts` is false, their `count`. `attr` is
    /// dropped. `Err` when a mapped value is not a finite integer.
    pub fn map_values(
        &self,
        f: impl Fn(f64) -> f64,
        eps: f64,
        rounding: Option<Rounding>,
        preserve_counts: bool,
    ) -> Result<Pmf, DiceError> {
        let round = |x: f64| match rounding {
            Some(Rounding::Floor) => x.floor(),
            Some(Rounding::Ceil) => x.ceil(),
            Some(Rounding::Round) => js_round(x),
            None => x,
        };
        let mut merged: IndexMap<Damage, Bin> = IndexMap::new();
        for (v, bin) in &self.map {
            if bin.p == 0.0 {
                continue;
            }
            let u = round(f(v.0));
            if !is_integer(u) {
                return Err(DiceError::error(format!(
                    "mapValues: {} maps to {}, not a finite integer",
                    num_to_string(v.0),
                    num_to_string(u)
                )));
            }
            let add = Bin {
                p: bin.p,
                count: if preserve_counts {
                    bin.count.clone()
                } else {
                    LabelMap::new()
                },
                attr: None,
            };
            merge_into(&mut merged, Damage(u), &add);
        }
        let mut entries: Vec<(Damage, Bin)> = merged.into_iter().collect();
        entries.sort_by(|a, b| a.0.0.total_cmp(&b.0.0));
        Ok(Pmf::new(
            entries.into_iter().collect(),
            eps,
            self.normalized,
        ))
    }

    /// `mapValues` with the defaults (`eps = EPS`, no rounding, counts preserved).
    pub fn map_values_default(&self, f: impl Fn(f64) -> f64) -> Result<Pmf, DiceError> {
        self.map_values(f, EPS, None, true)
    }

    /// `PMF.firstSuccessWeights(pSuccess, pSpecial, n)`: probabilities for first-success outcomes
    /// across `n` independent attempts. `Err` unless `0 <= pSpecial <= pSuccess <= 1`.
    pub fn first_success_weights(
        p_success: f64,
        p_special: f64,
        n: f64,
    ) -> Result<FirstSuccessWeights, DiceError> {
        if !p_success.is_finite()
            || !p_special.is_finite()
            || p_success < 0.0
            || p_success > 1.0
            || p_special < 0.0
            || p_special - p_success > EPS
        {
            return Err(DiceError::error(format!(
                "firstSuccessWeights: require 0 <= pSpecial <= pSuccess <= 1 (got pSuccess={}, pSpecial={})",
                num_to_string(p_success),
                num_to_string(p_special)
            )));
        }
        let p_fail = 1.0 - p_success;
        let p_fail_all = js_pow(p_fail, n);
        let p_any = 1.0 - p_fail_all;
        let denom = if p_success == 0.0 { 1.0 } else { p_success };
        let p_specific_success = (p_special * p_any) / denom;
        let p_general_success = ((p_success - p_special) * p_any) / denom;
        let p_none = 1.0 - p_specific_success - p_general_success;
        Ok(FirstSuccessWeights {
            p_specific_success,
            p_general_success,
            p_none,
            p_any,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Entry<'a> = (f64, f64, &'a [(&'a str, f64)]);

    fn pmf_of(bins: &[Entry<'_>]) -> Pmf {
        let m: IndexMap<Damage, Bin> = bins
            .iter()
            .map(|(d, p, c)| {
                let count = c.iter().map(|(k, v)| (k.to_string(), *v)).collect();
                (
                    Damage(*d),
                    Bin {
                        p: *p,
                        count,
                        attr: None,
                    },
                )
            })
            .collect();
        Pmf::new(m, 0.0, false)
    }

    fn labelled() -> Pmf {
        pmf_of(&[
            (0.0, 0.5, &[("missNone", 0.5)]),
            (5.0, 0.25, &[("hit", 0.25)]),
            (8.0, 0.25, &[("crit", 0.25)]),
        ])
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-15, "{a} vs {b}");
    }

    // tests/pmf-map-values.test.ts
    #[test]
    fn carries_outcome_counts_to_the_mapped_values() {
        let out = labelled().map_values_default(|v| v + 1.0).unwrap();
        assert_eq!(out.support(), [Damage(1.0), Damage(6.0), Damage(9.0)]);
        close(out.outcome_probability("hit"), 0.25);
        close(out.outcome_probability("crit"), 0.25);
        close(out.outcome_at(1.0, "missNone"), 0.5);
        close(out.mean(), 17.0 / 4.0);
    }

    #[test]
    fn merges_counts_of_values_that_map_to_the_same_result() {
        let out = labelled()
            .map_values(|v| v / 2.0, EPS, Some(Rounding::Floor), true)
            .unwrap();
        close(out.outcome_at(2.0, "hit"), 0.25);
        let merged = labelled()
            .map_values_default(|v| if v > 0.0 { 1.0 } else { 0.0 })
            .unwrap();
        close(merged.p_at(1.0), 0.5);
        close(merged.outcome_at(1.0, "hit"), 0.25);
        close(merged.outcome_at(1.0, "crit"), 0.25);
    }

    #[test]
    fn drops_counts_when_preserve_counts_is_false() {
        let out = labelled()
            .map_values(|v| v + 1.0, EPS, None, false)
            .unwrap();
        assert!(out.outcomes().is_empty());
        close(out.p_at(6.0), 0.25);
    }

    #[test]
    fn keeps_tiny_bins_and_the_original_mass() {
        let x = pmf_of(&[(0.0, 1.0 - 1e-13, &[]), (1000.0, 1e-13, &[])]);
        assert!((x.map_values_default(|v| v).unwrap().mean() - 1e-10).abs() < 1e-20);
        let half = pmf_of(&[(2.0, 0.25, &[]), (4.0, 0.25, &[])]);
        close(half.map_values_default(|v| v * 3.0).unwrap().mass(), 0.5);
    }

    #[test]
    fn errs_on_a_non_finite_or_non_integer_mapped_value() {
        let e = labelled().map_values_default(|v| v / 0.0).unwrap_err();
        assert!(e.message().starts_with("mapValues"), "{e}");
        assert_eq!(
            labelled().map_values_default(|v| v / 3.0).unwrap_err(),
            "mapValues: 5 maps to 1.6666666666666667, not a finite integer"
        );
    }

    #[test]
    fn rounding_modes_and_sorted_output() {
        let p = pmf_of(&[(3.0, 0.5, &[]), (1.0, 0.5, &[])]);
        let out = p.map_values(|v| 10.0 - v, EPS, None, true).unwrap();
        let keys: Vec<f64> = out.map.keys().map(|d| d.0).collect();
        assert_eq!(keys, [7.0, 9.0]);
        let r = pmf_of(&[(5.0, 1.0, &[])])
            .map_values(|v| v / 2.0, EPS, Some(Rounding::Round), true)
            .unwrap();
        assert_eq!(r.support(), [Damage(3.0)]);
        let c = pmf_of(&[(5.0, 1.0, &[])])
            .map_values(|v| v / 2.0, EPS, Some(Rounding::Ceil), true)
            .unwrap();
        assert_eq!(c.support(), [Damage(3.0)]);
    }

    #[test]
    fn first_success_weights() {
        let w = Pmf::first_success_weights(0.5, 0.05, 3.0).unwrap();
        close(w.p_specific_success, 0.08750000000000001);
        close(w.p_general_success, 0.7875);
        close(w.p_none, 0.125);
        close(w.p_any, 0.875);
        let e = Pmf::first_success_weights(0.3, 0.5, 2.0).unwrap_err();
        assert_eq!(
            e,
            "firstSuccessWeights: require 0 <= pSpecial <= pSuccess <= 1 (got pSuccess=0.3, pSpecial=0.5)"
        );
        // pSuccess 0: no divide by zero.
        assert_eq!(
            Pmf::first_success_weights(0.0, 0.0, 4.0).unwrap().p_any,
            0.0
        );
        // JS Math.pow(1, NaN) is NaN.
        assert!(
            Pmf::first_success_weights(0.0, 0.0, f64::NAN)
                .unwrap()
                .p_any
                .is_nan()
        );
    }
}
