//! Port of query.ts: combinedWithAttribution (83), attributionByValue (128), countSinglesWith (151),
//! mean (165), variance (195), stddev (239), stdev (244), cdf (251), probTotalAtMost (261), ccdf (274),
//! probTotalAtLeast (284), percentiles (301), min (311), max (321), missChance (748),
//! probDamageGreaterThan (907), totalMass (1202).

use crate::error::DiceError;
use indexmap::IndexMap;

use super::{DiceQuery, Labels};
use crate::{Damage, Pmf};

impl DiceQuery {
    /// `combinedWithAttribution()` (query.ts:83). The TS caches the result in
    /// `_combinedWithAttr`; here it is computed on each call, from identical inputs.
    pub fn combined_with_attribution(&self) -> Pmf {
        // An explicitly provided `combined` is NOT the convolution of `singles` —
        // a Turn's exact joint distribution, for instance, is narrower than the
        // independent product because riders correlate with their sources.
        // Re-convolving would silently discard it (and drop the riders' damage
        // entirely), so attribute the provided distribution itself.
        if self.combined_provided().is_some() {
            return self.combined().with_attribution();
        }

        // Fast path: if every single already carries attribution (as parser-
        // generated PMFs do), the attributed convolution is bit-for-bit identical
        // to `combined` — reuse it instead of convolving a second time.
        if self
            .singles
            .iter()
            .all(super::super::pmf::Pmf::has_attribution)
        {
            return self.combined().clone();
        }

        // Otherwise (e.g. builder-generated PMFs that only carry `count`), add
        // attribution to each single PMF, then convolve.
        let singles_with_attr: Vec<Pmf> = self
            .singles
            .iter()
            .map(super::super::pmf::Pmf::with_attribution)
            .collect();
        let combined = Pmf::convolve_many(&singles_with_attr, self.combined().epsilon);

        // Normalize if needed
        if (combined.mass() - 1.0).abs() <= self.combined().epsilon {
            combined
        } else {
            combined.normalize()
        }
    }

    /// `attributionByValue()` (query.ts:128): convenience for
    /// `combinedWithAttribution().attributionByValue()`. The split is
    /// [`Pmf::attribution_by_value`]. A JS `Map<string, Map<number, number>>`, insertion order
    /// kept: labels in first-seen order, damage keys in the source map's order.
    pub fn attribution_by_value(&self) -> IndexMap<String, IndexMap<Damage, f64>> {
        self.combined_with_attribution().attribution_by_value()
    }

    /// `damageAttributionChartModel(options)` (query.ts:137): `combinedWithAttribution()`'s
    /// [`Pmf::damage_attribution_chart_model`].
    pub fn damage_attribution_chart_model(
        &self,
        options: &crate::pmf::ChartModelOptions,
    ) -> Result<crate::pmf::DamageAttributionChartModel, DiceError> {
        self.combined_with_attribution()
            .damage_attribution_chart_model(options)
    }

    /// `countSinglesWith(label)` (query.ts:151).
    pub fn count_singles_with(&self, label: &str) -> f64 {
        let mut count = 0.0;
        for single in &self.singles {
            if single.has_outcome(label) {
                count += 1.0;
            }
        }
        count
    }

    /// `mean()` (query.ts:165).
    pub fn mean(&self) -> f64 {
        // If the caller supplied a combined distribution that may diverge from
        // convolve(singles), report its mean so mean() stays consistent with
        // cdf/percentiles/min/max (which all read `combined`).
        if let Some(combined) = self.combined_provided() {
            return combined.map.iter().fold(0.0, |m, (d, bin)| m + d.0 * bin.p);
        }
        // Expectation is additive over independent attacks: E[Σ Xᵢ] = Σ E[Xᵢ].
        // Computing it directly from the singles avoids building `combined`.
        let mut total_mean = 0.0;
        for single in &self.singles {
            let mass = single.mass();
            if mass <= 0.0 {
                continue;
            }
            // Match `combined`'s semantics: only divide by mass when it is not
            // already 1 (within eps), so an already-normalized single is bit-exact.
            total_mean += if (mass - 1.0).abs() <= self.eps {
                single.mean()
            } else {
                single.mean() / mass
            };
        }
        total_mean
    }

    /// `variance()` (query.ts:195).
    pub fn variance(&self) -> f64 {
        // Consistent with mean(): if a (possibly divergent) combined was provided,
        // compute the variance of that distribution directly.
        if let Some(combined) = self.combined_provided() {
            let mu = self.mean();
            let mut v = 0.0;
            for (d, bin) in &combined.map {
                let dev = d.0 - mu;
                v += dev * dev * bin.p;
            }
            return v;
        }
        // Variance is additive over independent attacks: Var[Σ Xᵢ] = Σ Var[Xᵢ].
        // Use the centered form per single (E[(X−μ)²]) rather than E[X²]−μ², which
        // suffers catastrophic cancellation when damage has a large constant offset.
        let mut total_variance = 0.0;
        for single in &self.singles {
            let mass = single.mass();
            if mass <= 0.0 {
                continue;
            }
            if (mass - 1.0).abs() <= self.eps {
                // Pmf::variance() is the centered, mass-1 variance.
                total_variance += single.variance();
            } else {
                // Normalized centered variance of a non-unit-mass single.
                let mut mu = 0.0;
                for (d, b) in &single.map {
                    mu += d.0 * (b.p / mass);
                }
                let mut v = 0.0;
                for (d, b) in &single.map {
                    let dev = d.0 - mu;
                    v += dev * dev * (b.p / mass);
                }
                total_variance += v;
            }
        }
        total_variance
    }

    /// `stddev()` (query.ts:239). `Math.sqrt` on a negative value is NaN.
    pub fn stddev(&self) -> f64 {
        let v = self.variance();
        if v < 0.0 { f64::NAN } else { v.sqrt() }
    }

    /// Alias of `stddev`, matching `Pmf.stdev`.
    pub fn stdev(&self) -> f64 {
        self.stddev()
    }

    /// `cdf(x)` (query.ts:251).
    pub fn cdf(&self, x: f64) -> f64 {
        self.prob_total_at_most(x)
    }

    /// `probTotalAtMost(x)` (query.ts:261).
    pub fn prob_total_at_most(&self, x: impl Into<f64>) -> f64 {
        let x = x.into();
        let mut cumulative_probability = 0.0;
        for (d, bin) in &self.combined().map {
            if d.0 <= x {
                cumulative_probability += bin.p;
            }
        }
        cumulative_probability
    }

    /// `ccdf(x)` (query.ts:274).
    pub fn ccdf(&self, x: impl Into<f64>) -> f64 {
        let x = x.into();
        self.prob_total_at_least(x)
    }

    /// `probTotalAtLeast(threshold)` (query.ts:284).
    pub fn prob_total_at_least(&self, threshold: impl Into<f64>) -> f64 {
        let threshold = threshold.into();
        let mut probability_sum = 0.0;
        for (d, bin) in &self.combined().map {
            if d.0 >= threshold {
                probability_sum += bin.p;
            }
        }
        probability_sum
    }

    /// `percentiles(percentileValues)` (query.ts:301).
    pub fn percentiles(&self, percentile_values: &[f64]) -> Vec<f64> {
        percentile_values
            .iter()
            .map(|p| self.combined().quantile(*p))
            .collect()
    }

    /// `min()` (query.ts:311).
    pub fn min(&self) -> f64 {
        self.combined().min()
    }

    /// `max()` (query.ts:321).
    pub fn max(&self) -> f64 {
        self.combined().max()
    }

    /// `missChance()` (query.ts:748): the probability that at least one attack
    /// misses (either kind of miss: `missNone` or `missDamage`). The TS
    /// `probabilityOf(labels)` is `probAtLeastOne(labels)` with de-duplicated
    /// labels; ported here as a private helper since `missChance` is a stats op.
    /// `missChance()` (query.ts:748): `probabilityOf(["missDamage", "missNone"])`.
    pub fn miss_chance(&self) -> f64 {
        self.probability_of(Labels::Many(vec![
            "missDamage".to_string(),
            "missNone".to_string(),
        ]))
    }

    /// `probDamageGreaterThan(threshold = 0)` (query.ts:907).
    pub fn prob_damage_greater_than(&self, threshold: impl Into<f64>) -> f64 {
        let threshold = threshold.into();
        let mut acc = 0.0;
        for (d, bin) in &self.combined().map {
            if d.0 > threshold {
                acc += bin.p;
            }
        }
        acc
    }

    /// `totalMass()` (query.ts:1202).
    pub fn total_mass(&self) -> f64 {
        self.combined().mass()
    }
}
