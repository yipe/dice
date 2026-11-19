//! Port of `src/builder/prob.ts`.

use crate::error::DiceError;
use crate::{Damage, Pmf};
use indexmap::IndexMap;

/// `d20PmfFromCdf`: `Err` where `PMF.fromMap` throws.
pub fn d20_pmf_from_cdf(cdf_pow: impl Fn(usize) -> f64, eps: f64) -> Result<Pmf, DiceError> {
    let mut out: IndexMap<Damage, f64> = IndexMap::new();
    let mut prev = 0.0;
    for k in 1..=20usize {
        let cur = cdf_pow(k);
        let pk = cur - prev;
        if pk > 0.0 {
            out.insert(Damage(k as f64), pk);
        }
        prev = cur;
    }
    Pmf::from_map(out, eps, true)
}

/// `splitAtThreshold`'s result: `P(X >= t)` and `P(X < t)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Split {
    pub at_least: f64,
    pub below: f64,
}

/// `splitAtThreshold`: each side summed from its own bins, in map order.
pub fn split_at_threshold(pmf: &Pmf, t: f64) -> Split {
    let mut at_least = 0.0;
    let mut below = 0.0;
    for (x, bin) in &pmf.map {
        if x.0 >= t {
            at_least += bin.p;
        } else {
            below += bin.p;
        }
    }
    Split { at_least, below }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_each_side_from_its_own_bins() -> Result<(), DiceError> {
        let pmf = d20_pmf_from_cdf(|k| k as f64 / 20.0, 1e-12)?;
        let s = split_at_threshold(&pmf, 21.0);
        assert_eq!((s.at_least, s.below > 0.99), (0.0, true));
        let s = split_at_threshold(&pmf, 1.0);
        assert_eq!(s.below, 0.0);
        assert!((s.at_least - 1.0).abs() < 1e-9);
        Ok(())
    }
}
