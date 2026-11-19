//! Port of pmf.ts `attributionByValue` (1777), `attributionPercentiles` and
//! `damageAttributionChartModel` (1915): the provenance core of the stacked damage-attribution
//! chart.
//!
//! ADR-017: a chart model with more than [`MAX_CHART_BUCKETS`] buckets (an unbinned support wider
//! than that) returns `Err`; TS allocates the arrays until it dies. A non-integer bucket count
//! (a fractional support) is the `RangeError: Invalid array length` TS raises.

use crate::error::DiceError;
use indexmap::{IndexMap, IndexSet};

use super::dense::or_zero;
use super::{LabelMap, Pmf};
use crate::Damage;
use crate::common::MISS_NONE_OUTCOME;
use crate::common::types::{default_outcome_order, sort_outcomes};

/// The most buckets a chart model allocates.
pub const MAX_CHART_BUCKETS: f64 = 10_000_000.0;

/// `DamageAttributionChartModel.binRanges` entry: `[start, end]` inclusive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinRange {
    pub start: f64,
    pub end: f64,
}

/// `DamageAttributionChartModel.percentiles`: reversed-convention CCDF markers (damage at which
/// P(X >= x) crosses 80/50/20%).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AttributionPercentiles {
    pub p80: f64,
    pub p50: f64,
    pub p20: f64,
}

/// `DamageAttributionChartModel`: the full numeric model for the stacked damage-attribution chart.
#[derive(Clone, Debug, PartialEq)]
pub struct DamageAttributionChartModel {
    /// Bucket-start value for each column.
    pub labels: Vec<f64>,
    /// Present only when the distribution was coarsened.
    pub bin_ranges: Option<Vec<BinRange>>,
    /// Discovered outcome labels in stack order. Empty for pure (unattributed) distributions.
    pub outcomes: Vec<String>,
    /// outcome -> per-bucket probability mass (bar heights).
    pub series: IndexMap<String, Vec<f64>>,
    /// outcome -> per-bucket conditional share of that bucket's total (0 under `epsilon`).
    pub shares: IndexMap<String, Vec<f64>>,
    /// Per-bucket total probability mass.
    pub totals: Vec<f64>,
    pub percentiles: AttributionPercentiles,
    /// `this.mean()`.
    pub mean: f64,
}

/// The `options` of `damageAttributionChartModel`.
#[derive(Clone, Debug, Default)]
pub struct ChartModelOptions {
    /// Coarsen to at most this many equal-width buckets when the support is wider.
    pub max_buckets: Option<f64>,
    /// Preferred outcome order (default `ALL_OUTCOME_TYPES`).
    pub stack_order: Option<Vec<String>>,
    /// Bucket-total floor below which a `shares` entry is 0 (default 1e-9).
    pub epsilon: Option<f64>,
}

/// The `add` closure of `attributionByValue`: skip non-positive (or NaN) mass, otherwise
/// accumulate into the label's series at `damage`.
fn add_series(
    result: &mut IndexMap<String, IndexMap<Damage, f64>>,
    label: &str,
    damage: Damage,
    mass: f64,
) {
    if mass.is_nan() || mass <= 0.0 {
        return;
    }
    let series = result.entry(label.to_string()).or_default();
    *series.entry(damage).or_insert(0.0) += mass;
}

/// `(count[k] / total) * p` split of one bin over the labels `keep` accepts.
fn split_by(
    result: &mut IndexMap<String, IndexMap<Damage, f64>>,
    damage: Damage,
    p: f64,
    map: &LabelMap,
    total: f64,
    keep: impl Fn(&str) -> bool,
) {
    for (k, v) in map {
        if keep(k) {
            add_series(result, k, damage, (or_zero(*v) / total) * p);
        }
    }
}

impl Pmf {
    /// `attributionByValue()`: splits each damage bin's mass across outcome labels. The 0-damage bin
    /// splits by `count` across every label present (`missNone` keeps its share; so does a hit or
    /// crit landing at 0). A damage-bearing bin splits by `attr` share, `missNone` excluded from
    /// numerator and denominator, falling back to the `count` split (still excluding `missNone`)
    /// when `attr` is absent, all-zero, or has a negative contribution. Attribution is computed
    /// on demand via `with_attribution` when absent.
    ///
    /// A JS `Map<string, Map<number, number>>`, insertion order kept: labels in first-seen order,
    /// damage keys in the source map's order.
    pub fn attribution_by_value(&self) -> IndexMap<String, IndexMap<Damage, f64>> {
        let owned = if self.has_attribution() {
            None
        } else {
            Some(self.with_attribution())
        };
        let src = owned.as_ref().unwrap_or(self);
        let mut result: IndexMap<String, IndexMap<Damage, f64>> = IndexMap::new();

        for (damage, bin) in &src.map {
            let p = or_zero(bin.p);
            if p <= 0.0 {
                continue;
            }

            if damage.0 == 0.0 {
                let total_count = bin.count.values().fold(0.0, |t, v| t + or_zero(*v));
                if total_count > 0.0 {
                    split_by(&mut result, *damage, p, &bin.count, total_count, |_| true);
                }
                continue;
            }

            let mut total_attr = 0.0;
            let mut attr_usable = bin.attr.is_some();
            if let Some(attr) = &bin.attr {
                for (k, v) in attr {
                    if k == MISS_NONE_OUTCOME {
                        continue;
                    }
                    let v = or_zero(*v);
                    // A negative contribution (a source reduced below 0) makes the damage-share
                    // split an invalid distribution: fall back to the count split.
                    if v < 0.0 {
                        attr_usable = false;
                        break;
                    }
                    total_attr += v;
                }
            }
            if attr_usable && total_attr > 0.0 {
                if let Some(attr) = &bin.attr {
                    split_by(&mut result, *damage, p, attr, total_attr, |k| {
                        k != MISS_NONE_OUTCOME
                    });
                }
                continue;
            }

            let mut total_count = 0.0;
            for (k, v) in &bin.count {
                if k != MISS_NONE_OUTCOME {
                    total_count += or_zero(*v);
                }
            }
            if total_count > 0.0 {
                split_by(&mut result, *damage, p, &bin.count, total_count, |k| {
                    k != MISS_NONE_OUTCOME
                });
            }
        }
        result
    }

    /// `attributionPercentiles()`: for each target probability t, the largest damage x still reached
    /// with P(X >= x) > t%, falling back to the smallest/largest support value at the edges.
    /// `p80/p50/p20` keep their intentional reversed meaning (p80 is the low-damage end). Computed
    /// on the full, un-binned support; assumes a non-empty map.
    fn attribution_percentiles(&self) -> AttributionPercentiles {
        let keys = self.support();
        let mut ccdf: Vec<(f64, f64)> = Vec::with_capacity(keys.len());
        let mut cumulative = 0.0;
        for key in keys.iter().rev() {
            let Some(bin) = self.map.get(key) else {
                continue;
            };
            cumulative += bin.p;
            ccdf.push((key.0, cumulative * 100.0));
        }
        ccdf.reverse();
        let find = |target: f64| -> f64 {
            for (i, (x, y)) in ccdf.iter().enumerate() {
                if *y <= target {
                    return if i > 0 { ccdf[i - 1].0 } else { *x };
                }
            }
            ccdf.last().map_or(0.0, |c| c.0)
        };
        AttributionPercentiles {
            p80: find(80.0),
            p50: find(50.0),
            p20: find(20.0),
        }
    }

    /// `damageAttributionChartModel(options)`: bar-height masses, tooltip shares, bucket
    /// labels/ranges, percentile markers and the mean. Built split-first-then-bin: the attribution
    /// split runs on the un-binned distribution, then the series are coarsened (`rebin` is
    /// deliberately not used).
    pub fn damage_attribution_chart_model(
        &self,
        options: &ChartModelOptions,
    ) -> Result<DamageAttributionChartModel, DiceError> {
        let epsilon = options.epsilon.unwrap_or(1e-9);
        let empty = || DamageAttributionChartModel {
            labels: vec![],
            bin_ranges: None,
            outcomes: vec![],
            series: IndexMap::new(),
            shares: IndexMap::new(),
            totals: vec![],
            percentiles: AttributionPercentiles {
                p80: 0.0,
                p50: 0.0,
                p20: 0.0,
            },
            mean: 0.0,
        };
        if self.map.is_empty() {
            return Ok(empty());
        }

        let split = self.attribution_by_value();

        // Discover outcomes across BOTH count and attr keys so all-zero legend entries survive.
        let mut discovered: IndexSet<&str> = IndexSet::new();
        for bin in self.map.values() {
            for k in bin.count.keys() {
                discovered.insert(k);
            }
            if let Some(attr) = &bin.attr {
                for k in attr.keys() {
                    discovered.insert(k);
                }
            }
        }
        let discovered: Vec<&str> = discovered.into_iter().collect();
        let outcomes: Vec<String> = match &options.stack_order {
            Some(order) => {
                let order: Vec<&str> = order.iter().map(String::as_str).collect();
                sort_outcomes(&discovered, &order)
            }
            None => sort_outcomes(&discovered, &default_outcome_order()),
        }
        .into_iter()
        .map(String::from)
        .collect();
        let has_attribution = !outcomes.is_empty();

        // Support window over values carrying positive mass.
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        let mut widen = |d: f64| {
            if d < min {
                min = d;
            }
            if d > max {
                max = d;
            }
        };
        if has_attribution {
            for s in split.values() {
                for (d, m) in s {
                    if *m > 0.0 {
                        widen(d.0);
                    }
                }
            }
        } else {
            for (d, bin) in &self.map {
                if or_zero(bin.p) > 0.0 {
                    widen(d.0);
                }
            }
        }
        if max < min {
            return Ok(empty());
        }
        let range = max - min;

        let binned = options.max_buckets.is_some_and(|m| m > 0.0 && range > m);
        let bin_size = match options.max_buckets {
            Some(m) if binned => ((range + 1.0) / m).ceil(),
            _ => 1.0,
        };
        let num_bins_f = if binned {
            ((range + 1.0) / bin_size).ceil()
        } else {
            range + 1.0
        };
        if !(num_bins_f.is_finite()
            && num_bins_f.fract() == 0.0
            && (0.0..=4294967295.0).contains(&num_bins_f))
        {
            return Err(DiceError::invalid_array_length());
        }
        if num_bins_f > MAX_CHART_BUCKETS {
            return Err(DiceError::range(format!(
                "chart model needs {num_bins_f} buckets, more than {MAX_CHART_BUCKETS}"
            )));
        }
        let num_bins = num_bins_f as usize;
        let bucket_of = |d: f64| -> Option<usize> {
            let b = ((d - min) / bin_size).floor();
            (b >= 0.0 && b < num_bins_f).then_some(b as usize)
        };

        let mut labels = Vec::with_capacity(num_bins);
        let mut bin_ranges: Option<Vec<BinRange>> = binned.then(Vec::new);
        for i in 0..num_bins {
            let start = min + i as f64 * bin_size;
            labels.push(start);
            if let Some(r) = bin_ranges.as_mut() {
                r.push(BinRange {
                    start,
                    end: (start + bin_size - 1.0).min(max),
                });
            }
        }

        let mut series: IndexMap<String, Vec<f64>> = IndexMap::new();
        for outcome in &outcomes {
            let mut arr = vec![0.0; num_bins];
            if let Some(s) = split.get(outcome) {
                for (d, m) in s {
                    if let Some(b) = bucket_of(d.0) {
                        arr[b] += m;
                    }
                }
            }
            series.insert(outcome.clone(), arr);
        }

        let mut totals = vec![0.0; num_bins];
        if has_attribution {
            for arr in series.values() {
                for i in 0..num_bins {
                    totals[i] += arr[i];
                }
            }
        } else {
            for (d, bin) in &self.map {
                let p = or_zero(bin.p);
                if p <= 0.0 {
                    continue;
                }
                if let Some(b) = bucket_of(d.0) {
                    totals[b] += p;
                }
            }
        }

        let mut shares: IndexMap<String, Vec<f64>> = IndexMap::new();
        for outcome in &outcomes {
            let sh = series.get(outcome).map_or_else(
                || vec![0.0; num_bins],
                |arr| {
                    (0..num_bins)
                        .map(|i| {
                            if totals[i] > epsilon {
                                arr[i] / totals[i]
                            } else {
                                0.0
                            }
                        })
                        .collect()
                },
            );
            shares.insert(outcome.clone(), sh);
        }

        Ok(DamageAttributionChartModel {
            labels,
            bin_ranges,
            outcomes,
            series,
            shares,
            totals,
            percentiles: self.attribution_percentiles(),
            mean: self.mean(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::attack::AttackBuilder;
    use crate::builder::factory::SidesOrDie;
    use crate::builder::factory::{d20, flat, roll_with};
    use crate::builder::roll::Arg;
    use crate::query::DiceQuery;
    use crate::{Bin, EPS};

    type T = Result<(), DiceError>;

    fn close(a: f64, b: f64, digits: i32) {
        let tol = 0.5 * 10f64.powi(-digits);
        assert!((a - b).abs() < tol, "{a} vs {b}");
    }

    fn bin(p: f64, count: &[(&str, f64)]) -> Bin {
        Bin {
            p,
            count: count.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            attr: None,
        }
    }

    /// Attributed attack: clean miss at 0, plain hit at 5, hit+crit mix at 8.
    fn attributed_attack() -> Pmf {
        let m: IndexMap<Damage, Bin> = IndexMap::from([
            (Damage(0.0), bin(0.3, &[("missNone", 0.3)])),
            (Damage(5.0), bin(0.5, &[("hit", 0.5)])),
            (Damage(8.0), bin(0.2, &[("hit", 0.15), ("crit", 0.05)])),
        ]);
        Pmf::new(m, 1e-15, true).with_attribution()
    }

    fn model(pmf: &Pmf) -> DamageAttributionChartModel {
        pmf.damage_attribution_chart_model(&ChartModelOptions::default())
            .expect("model")
    }

    fn chart_mass(pmf: &Pmf) -> f64 {
        model(pmf).totals.iter().fold(0.0, |a, b| a + b)
    }

    fn sword() -> Result<AttackBuilder, DiceError> {
        d20()
            .plus(8.0)?
            .ac(16.0)?
            .on_hit(roll_with(1.0, Some(SidesOrDie::Sides(6.0)), None)?.plus(5.0)?)
    }

    // ---- tests/damage-attribution-chart-model.test.ts

    #[test]
    fn splits_an_attributed_distribution_into_dense_per_outcome_series() {
        let m = model(&attributed_attack());
        assert_eq!(m.labels, (0..=8).map(f64::from).collect::<Vec<_>>());
        assert_eq!(m.bin_ranges, None);
        assert_eq!(m.outcomes, ["missNone", "hit", "crit"]);
        close(m.series["missNone"][0], 0.3, 12);
        close(m.series["hit"][5], 0.5, 12);
        close(m.series["hit"][8], 0.15, 12);
        close(m.series["crit"][8], 0.05, 12);
        close(m.totals[0], 0.3, 12);
        close(m.totals[5], 0.5, 12);
        close(m.totals[8], 0.2, 12);
        close(m.shares["hit"][8], 0.75, 12);
        close(m.shares["crit"][8], 0.25, 12);
        close(m.shares["missNone"][0], 1.0, 12);
        close(m.mean, 4.1, 12);
        assert_eq!(
            m.percentiles,
            AttributionPercentiles {
                p80: 0.0,
                p50: 5.0,
                p20: 5.0
            }
        );
    }

    #[test]
    fn returns_totals_only_for_a_pure_distribution() {
        let m: IndexMap<Damage, Bin> = (1..=6)
            .map(|d| (Damage(f64::from(d)), bin(1.0 / 6.0, &[])))
            .collect();
        let m = model(&Pmf::new(m, 1e-15, true));
        assert!(m.outcomes.is_empty());
        assert!(m.series.is_empty());
        assert!(m.shares.is_empty());
        assert_eq!(m.labels, (1..=6).map(f64::from).collect::<Vec<_>>());
        for t in &m.totals {
            close(*t, 1.0 / 6.0, 12);
        }
        close(m.mean, 3.5, 12);
    }

    #[test]
    fn coarsens_a_wide_distribution_and_preserves_mass() {
        let mut m: IndexMap<Damage, Bin> =
            IndexMap::from([(Damage(0.0), bin(0.2, &[("missNone", 0.2)]))]);
        for d in 1..=1000 {
            m.insert(
                Damage(f64::from(d)),
                bin(0.8 / 1000.0, &[("hit", 0.8 / 1000.0)]),
            );
        }
        let wide = Pmf::new(m, 1e-15, true).with_attribution();
        let model = wide
            .damage_attribution_chart_model(&ChartModelOptions {
                max_buckets: Some(100.0),
                ..Default::default()
            })
            .unwrap();
        // range 1000 > 100: binned; binSize = ceil(1001 / 100) = 11.
        let ranges = model.bin_ranges.as_ref().expect("binned");
        assert_eq!(ranges.len(), model.labels.len());
        assert_eq!(
            ranges[0],
            BinRange {
                start: 0.0,
                end: 10.0
            }
        );
        assert_eq!(model.labels[1], 11.0);
        close(model.totals.iter().fold(0.0, |a, b| a + b), 1.0, 10);
        close(model.series["missNone"][0], 0.2, 12);
        assert!(model.series["hit"][0] > 0.0);
        close(model.series["hit"][0], (0.8 / 1000.0) * 10.0, 10);
        close(model.series["hit"].iter().fold(0.0, |a, b| a + b), 0.8, 10);
    }

    #[test]
    fn respects_a_custom_stack_order() {
        let m = attributed_attack()
            .damage_attribution_chart_model(&ChartModelOptions {
                stack_order: Some(vec!["crit".into(), "hit".into(), "missNone".into()]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(m.outcomes, ["crit", "hit", "missNone"]);
    }

    #[test]
    fn zeroes_shares_under_the_epsilon_floor_but_keeps_series() {
        let m = attributed_attack()
            .damage_attribution_chart_model(&ChartModelOptions {
                epsilon: Some(1.0),
                ..Default::default()
            })
            .unwrap();
        for arr in m.shares.values() {
            assert!(arr.iter().all(|s| *s == 0.0));
        }
        close(m.series["hit"][5], 0.5, 12);
    }

    #[test]
    fn returns_an_empty_model_for_an_empty_pmf() {
        let m = model(&Pmf::empty(EPS));
        assert!(m.labels.is_empty() && m.outcomes.is_empty() && m.totals.is_empty());
        assert!(m.series.is_empty() && m.shares.is_empty());
        assert_eq!(m.mean, 0.0);
        assert_eq!(
            m.percentiles,
            AttributionPercentiles {
                p80: 0.0,
                p50: 0.0,
                p20: 0.0
            }
        );
    }

    #[test]
    fn dice_query_delegates_to_the_combined_attributed_pmf() {
        let q = DiceQuery::of(vec![attributed_attack()]);
        let m = q
            .damage_attribution_chart_model(&ChartModelOptions::default())
            .unwrap();
        assert_eq!(m.outcomes, ["missNone", "hit", "crit"]);
        close(m.series["hit"][5], 0.5, 12);
    }

    #[test]
    fn size_guards() {
        let wide = Pmf::new(
            IndexMap::from([(Damage(0.0), bin(0.5, &[])), (Damage(1e9), bin(0.5, &[]))]),
            EPS,
            true,
        );
        assert!(
            wide.damage_attribution_chart_model(&ChartModelOptions::default())
                .unwrap_err()
                .message()
                .contains("more than")
        );
        let frac = Pmf::new(
            IndexMap::from([(Damage(0.0), bin(0.5, &[])), (Damage(0.5), bin(0.5, &[]))]),
            EPS,
            true,
        );
        assert_eq!(
            frac.damage_attribution_chart_model(&ChartModelOptions::default())
                .unwrap_err(),
            "Invalid array length"
        );
    }

    // ---- tests/attribution-conservation.test.ts (Turn.pmf at :24 is deferred: needs `Turn`)

    #[test]
    fn convolved_pmfs_conserve_mass() -> T {
        let pmf = sword()?.to_pmf(0.0)?;
        let conv = Pmf::convolve_many(&[pmf.clone(), pmf.clone()], EPS);
        close(conv.mass(), 1.0, 12);
        close(chart_mass(&conv), 1.0, 12);

        let singles = vec![pmf.clone(), pmf.clone()];
        let q = DiceQuery::new(
            singles.clone(),
            Some(Pmf::convolve_many(&singles, EPS)),
            EPS,
        );
        close(chart_mass(&q.combined_with_attribution()), 1.0, 12);

        let singles = vec![pmf.apply_hit_frequency(0.5), pmf];
        let q = DiceQuery::new(
            singles.clone(),
            Some(Pmf::convolve_many(&singles, EPS)),
            EPS,
        );
        close(chart_mass(&q.combined_with_attribution()), 1.0, 12);
        Ok(())
    }

    #[test]
    fn a_guaranteed_miss_with_an_always_10_hit_is_entirely_hit() -> T {
        let always10 = d20().always_hits()?.on_hit(flat(10.0)?)?.no_crit()?;
        let q = DiceQuery::of(vec![Pmf::miss_none(EPS), always10.to_pmf(0.0)?]);
        let m = q.damage_attribution_chart_model(&ChartModelOptions::default())?;
        let bin = m
            .labels
            .iter()
            .position(|l| *l == 10.0)
            .ok_or("no bin at 10")?;
        close(m.shares["hit"][bin], 1.0, 12);
        assert_eq!(m.shares["missNone"][bin], 0.0);
        Ok(())
    }

    #[test]
    fn a_crit_11_and_a_hit_6_split_11_17_and_6_17() -> T {
        let crit11 = d20().always_hits()?.always_crits()?.on_hit(flat(11.0)?)?;
        let hit6 = d20().always_hits()?.on_hit(flat(6.0)?)?.no_crit()?;
        let q = DiceQuery::of(vec![crit11.to_pmf(0.0)?, hit6.to_pmf(0.0)?]);
        let m = q.damage_attribution_chart_model(&ChartModelOptions::default())?;
        let bin = m
            .labels
            .iter()
            .position(|l| *l == 17.0)
            .ok_or("no bin at 17")?;
        close(m.shares["crit"][bin], 11.0 / 17.0, 12);
        close(m.shares["hit"][bin], 6.0 / 17.0, 12);
        Ok(())
    }

    #[test]
    fn non_convolved_pmfs_keep_their_per_value_splits() -> T {
        let m = model(&sword()?.to_pmf(0.0)?);
        assert_eq!(m.outcomes, ["missNone", "hit", "crit"]);
        close(m.series["missNone"][0], 0.35, 12);
        close(m.series["hit"][6], 0.1, 12);
        close(m.series["hit"][7], 0.1, 12);
        close(m.series["crit"][7], 0.0013888888888888885, 12);
        close(m.totals[7], 0.1 + 0.0013888888888888885, 12);

        let parsed = crate::parser::parse_with("d20+8 AC 16 * (1d6+5)", 0.0)?;
        let m = model(&parsed);
        close(m.series["hit"][6], 0.1, 12);
        close(m.series["missNone"][0], 0.35, 12);

        let q = DiceQuery::of(vec![sword()?.to_pmf(0.0)?]);
        let m = q.damage_attribution_chart_model(&ChartModelOptions::default())?;
        close(m.series["hit"][6], 0.1, 12);
        close(m.series["missNone"][0], 0.35, 12);
        Ok(())
    }

    #[test]
    fn zero_damage_hits_and_crits_are_credited_at_0() -> T {
        let zero_hit = d20().plus(5.0)?.ac(15.0)?.on_hit(flat(0.0)?)?;
        let pmf = zero_hit.to_pmf(0.0)?;
        let m = model(&pmf);
        close(chart_mass(&pmf), 1.0, 12);
        close(m.series["missNone"][0], 0.45, 12);
        close(m.series["hit"][0], 0.5, 12);
        close(m.series["crit"][0], 0.05, 12);

        let conv = Pmf::convolve_many(&[pmf, sword()?.to_pmf(0.0)?], EPS);
        close(conv.mass(), 1.0, 12);
        close(chart_mass(&conv), 1.0, 12);

        let m = model(&sword()?.to_pmf(0.0)?);
        close(m.shares["missNone"][0], 1.0, 12);
        assert_eq!(m.series["hit"][0], 0.0);
        assert_eq!(m.series["crit"][0], 0.0);
        Ok(())
    }

    #[test]
    fn a_negative_damage_hit_with_a_positive_save_falls_back_to_count() -> T {
        let neg_hit = d20().always_hits()?.on_hit(flat(-1.0)?)?.no_crit()?;
        let pos_save = flat(10.0)?
            .dc(12.0)?
            .on_save_failure_args(&[Arg::Roll(flat(3.0)?)])?;
        let q = DiceQuery::of(vec![neg_hit.to_pmf(0.0)?, pos_save.to_pmf(0.0)?]);
        let pmf = q.combined_with_attribution();
        close(chart_mass(&pmf), 1.0, 12);
        let m = model(&pmf);
        let bin = m
            .labels
            .iter()
            .position(|l| *l == 2.0)
            .ok_or("no bin at 2")?;
        assert_eq!(bin, 0);
        close(m.series["hit"][bin], 0.5, 12);
        close(m.series["saveFail"][bin], 0.5, 12);
        Ok(())
    }
}
