//! Port of query.ts: toLabeledTable (774), toStackedChartData (807), outcomeTotals (931),
//! outcomeDamageRanges (946), outcomeStats (1011), mapDamage (1218) and scaleDamage (1240).
//! `outcomes: None` is the TS default parameter (named per method).

use crate::error::DiceError;
use indexmap::IndexMap;

use super::{DiceQuery, Labels, OutcomeSnapshot};
use crate::common::types::default_outcome_order;
use crate::pmf::dense::or_zero;
use crate::{EPS, LabelMap};

/// `toStackedChartData` dataset: `{ label, data }`.
#[derive(Clone, Debug, PartialEq)]
pub struct StackedDataset {
    pub label: String,
    pub data: Vec<f64>,
}

/// `toStackedChartData` result.
#[derive(Clone, Debug, PartialEq)]
pub struct StackedChartData {
    pub labels: Vec<f64>,
    pub datasets: Vec<StackedDataset>,
}

/// `outcomeDamageRanges` value: min/avg/max of X given the outcome.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DamageRange {
    pub min: f64,
    pub avg: f64,
    pub max: f64,
}

impl DiceQuery {
    /// `toLabeledTable(labels)`: one row per damage value: `damage`, `total`, then each label's mass
    /// (`count[label] || 0`). A row is a JS object, so a label named `damage` or `total` overwrites
    /// that column in place, as `LabelMap` insertion does.
    pub fn to_labeled_table(&self, labels: &[String]) -> Vec<LabelMap> {
        let combined = self.combined();
        combined
            .support()
            .iter()
            .filter_map(|d| {
                let bin = combined.map.get(d)?;
                let mut row = LabelMap::new();
                row.insert("damage".to_string(), d.0);
                row.insert("total".to_string(), bin.p);
                for label in labels {
                    row.insert(
                        label.clone(),
                        bin.count.get(label).copied().map_or(0.0, or_zero),
                    );
                }
                Some(row)
            })
            .collect()
    }

    /// `toStackedChartData(labels, epsilon)`: unconditional per-label probability mass per damage
    /// (`bin.count[label]`, 0 at or below `epsilon`).
    pub fn to_stacked_chart_data(&self, labels: &[String], epsilon: f64) -> StackedChartData {
        let combined = self.combined();
        let damages = combined.support();
        let datasets = labels
            .iter()
            .map(|label| StackedDataset {
                label: label.clone(),
                data: damages
                    .iter()
                    .map(|d| {
                        let v = combined
                            .map
                            .get(d)
                            .map_or(0.0, |b| b.count.get(label).copied().map_or(0.0, or_zero));
                        if v <= epsilon { 0.0 } else { v }
                    })
                    .collect(),
            })
            .collect();
        StackedChartData {
            labels: damages.iter().map(|d| d.0).collect(),
            datasets,
        }
    }

    /// `toStackedChartData` with the default `epsilon` ([`EPS`]).
    pub fn to_stacked_chart_data_default(&self, labels: &[String]) -> StackedChartData {
        self.to_stacked_chart_data(labels, EPS)
    }

    /// `outcomeTotals(outcomes = this.outcomeKeys())`: total probability per outcome across the PMF.
    pub fn outcome_totals(&self, outcomes: Option<&[String]>) -> IndexMap<String, f64> {
        let outcomes = outcomes.map_or_else(|| self.outcome_keys(None), <[String]>::to_vec);
        let mut totals: IndexMap<String, f64> = IndexMap::new();
        for o in &outcomes {
            totals.insert(o.clone(), 0.0);
        }
        for row in self.combined().map.values() {
            for o in &outcomes {
                let p = row.count.get(o).copied().map_or(0.0, or_zero);
                let prev = totals.get(o).copied().map_or(0.0, or_zero);
                totals.insert(o.clone(), prev + p);
            }
        }
        totals
    }

    /// `outcomeDamageRanges(outcomes = this.outcomeKeys())`: conditional damage range per outcome
    /// (min/avg/max of X | outcome), read off [`DiceQuery::to_labeled_table`].
    pub fn outcome_damage_ranges(
        &self,
        outcomes: Option<&[String]>,
    ) -> IndexMap<String, DamageRange> {
        let outcomes = outcomes.map_or_else(|| self.outcome_keys(None), <[String]>::to_vec);
        let table = self.to_labeled_table(&outcomes);
        // (sum, mass, min, max)
        let mut ranges: IndexMap<String, (f64, f64, Option<f64>, Option<f64>)> = IndexMap::new();
        for o in &outcomes {
            ranges.insert(o.clone(), (0.0, 0.0, None, None));
        }
        for row in &table {
            let dmg = row.get("damage").copied().unwrap_or(f64::NAN);
            for o in &outcomes {
                let p = row.get(o).copied().map_or(0.0, or_zero);
                if p > 0.0
                    && let Some(r) = ranges.get_mut(o)
                {
                    r.0 += dmg * p;
                    r.1 += p;
                    if r.2.is_none_or(|m| dmg < m) {
                        r.2 = Some(dmg);
                    }
                    if r.3.is_none_or(|m| dmg > m) {
                        r.3 = Some(dmg);
                    }
                }
            }
        }
        let mut out = IndexMap::new();
        for o in &outcomes {
            if let Some((sum, mass, min, max)) = ranges.get(o) {
                let avg = if *mass > 0.0 { sum / mass } else { 0.0 };
                out.insert(
                    o.clone(),
                    DamageRange {
                        min: min.unwrap_or(0.0),
                        avg,
                        max: max.unwrap_or(0.0),
                    },
                );
            }
        }
        out
    }

    /// `outcomeStats(outcomes = ALL_OUTCOME_TYPES)`: per-outcome probabilities and damage ranges,
    /// aggregated over the individual singles. Only outcomes that occur appear. `Err` where
    /// `probExactlyK` throws.
    pub fn outcome_stats(
        &self,
        outcomes: Option<&[String]>,
    ) -> Result<IndexMap<String, OutcomeSnapshot>, DiceError> {
        let outcomes = outcomes.map_or_else(
            || {
                default_outcome_order()
                    .into_iter()
                    .map(String::from)
                    .collect()
            },
            <[String]>::to_vec,
        );
        let per_single: Vec<DiceQuery> = self
            .singles
            .iter()
            .map(|pmf| DiceQuery::new(vec![pmf.clone()], None, self.eps))
            .collect();
        let mut stats = IndexMap::new();
        for outcome in &outcomes {
            let label = Labels::One(outcome.clone());
            let at_least_one = self.prob_at_least_one(&label);
            if at_least_one <= 0.0 {
                continue;
            }
            let (mut min, mut avg, mut max) = (0.0, 0.0, 0.0);
            let mut contributors = 0.0;
            for single in &per_single {
                if single.prob_at_least_one(&label) <= 0.0 {
                    continue;
                }
                contributors += 1.0;
                let stat = single.damage_stats_from(&label);
                min += stat.min;
                avg += stat.avg;
                max += stat.max;
            }
            let all_probability = if contributors > 0.0 {
                self.prob_exactly_k(&label, contributors)?
            } else {
                0.0
            };
            stats.insert(
                outcome.clone(),
                OutcomeSnapshot {
                    at_least_one_probability: at_least_one,
                    all_probability,
                    damage_min: min,
                    damage_avg: avg,
                    damage_max: max,
                },
            );
        }
        Ok(stats)
    }

    /// `mapDamage(f)`: a new query over the combined distribution with damage values mapped.
    pub fn map_damage(&self, f: impl Fn(f64) -> f64) -> DiceQuery {
        DiceQuery::of(vec![self.combined().map_damage(f)])
    }

    /// `scaleDamage(factor, rounding, denominator)`: damage scaled by `factor / denominator`
    /// (`rounding` is `"floor"`, `"round"` or `"ceil"`). `Err` as `PMF.scaleDamage`.
    pub fn scale_damage(
        &self,
        factor: f64,
        rounding: &str,
        denominator: f64,
    ) -> Result<DiceQuery, DiceError> {
        Ok(DiceQuery::of(vec![self.combined().scale_damage(
            factor,
            rounding,
            denominator,
        )?]))
    }
}
