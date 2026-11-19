//! Port of query.ts: toChartSeries (759), toCDFSeries (836), toCCDFSeries (875), outcomeKeys (914)
//! with `DEFAULT_OUTCOMES` (58), snapshot (1059).

use indexmap::IndexMap;

use super::{DiceQuery, OutcomeSnapshot, Series, Snapshot};
use crate::Damage;

/// `DiceQuery.DEFAULT_OUTCOMES` (query.ts:58).
const DEFAULT_OUTCOMES: [&str; 3] = ["hit", "crit", "missNone"];

/// Private port of `toLabeledTable` (query.ts:771): `bin.count[label] || 0` per damage value.
fn labeled_rows(query: &DiceQuery, outcomes: &[String]) -> Vec<(f64, IndexMap<String, f64>)> {
    let combined = query.combined();
    combined
        .support()
        .iter()
        .map(|d| {
            let bin = &combined.map[&Damage(d.0)];
            let mut row: IndexMap<String, f64> = IndexMap::new();
            for o in outcomes {
                // JS `count[outcomeLabel] || 0`: every falsy value (0, NaN, undefined) is 0.
                row.insert(
                    o.clone(),
                    bin.count
                        .get(o)
                        .copied()
                        .map_or(0.0, crate::pmf::dense::or_zero),
                );
            }
            (d.0, row)
        })
        .collect()
}

impl DiceQuery {
    /// `[{x, y}]` as `(x, y)` pairs.
    pub fn to_chart_series(&self) -> Vec<(f64, f64)> {
        let combined = self.combined();
        combined
            .support()
            .into_iter()
            .map(|d| (d.0, combined.p_at(d.0)))
            .collect()
    }

    /// `toCDFSeries(asPercentages = true)`.
    pub fn to_cdf_series(&self, as_percentages: bool) -> Series {
        let combined = self.combined();
        let support = combined.dense_support();
        let mut data = Vec::with_capacity(support.len());
        if !support.is_empty() {
            let mut cumulative = 0.0;
            for &damage in &support {
                let bin = combined.bin_at(damage);
                if let Some(b) = bin {
                    cumulative += b.p;
                }
                data.push(if as_percentages {
                    cumulative * 100.0
                } else {
                    cumulative
                });
            }
        }
        Series { support, data }
    }

    /// `toCCDFSeries(asPercentages = true)`.
    pub fn to_ccdf_series(&self, as_percentages: bool) -> Series {
        let combined = self.combined();
        let support = combined.dense_support();
        let mut data = Vec::with_capacity(support.len());
        if !support.is_empty() {
            let mut cumulative = 0.0;
            for &damage in &support {
                // P(X ≥ x) is the total mass minus the cumulative up to (not including) x.
                let ccdf = 1.0 - cumulative;
                data.push(if as_percentages { ccdf * 100.0 } else { ccdf });

                // Now add current probability for next iteration.
                let bin = combined.bin_at(damage);
                if let Some(b) = bin {
                    cumulative += b.p;
                }
            }
        }
        Series { support, data }
    }

    /// `outcomeKeys(order?)`; None is the TS `undefined`.
    pub fn outcome_keys(&self, order: Option<&[String]>) -> Vec<String> {
        // `for (const k in bin.count)` is Object.keys order = insertion order; an IndexMap
        // `keys` walk matches it. `k in obj` is also true for inherited prototype properties,
        // but a bin's `count` is a plain object, so the keys are exactly its own entries.
        let mut found: Vec<String> = Vec::new();
        for bin in self.combined().map.values() {
            for (k, v) in &bin.count {
                // JS: `bin.count[k] && bin.count[k] > 0` — NaN is falsy, 0 fails `> 0`.
                if *v != 0.0 && *v > 0.0 && !found.iter().any(|x| x == k) {
                    found.push(k.clone());
                }
            }
        }
        if found.is_empty() {
            for k in DEFAULT_OUTCOMES {
                if !found.iter().any(|x| x == k) {
                    found.push(k.to_string());
                }
            }
        }
        // `order?.includes(k) ?? true`: no filter for an absent or empty order.
        // `order.indexOf(a) - order.indexOf(b)`; JS Array.prototype.sort is stable,
        // so `sort_by_key` reproduces it. Keys not in `order` rank -1, mirroring indexOf.
        match order {
            Some(order) if !order.is_empty() => {
                // Filter first: `order?.includes(k) ?? true` then a stable sort by
                // `indexOf`, mirroring `Array.prototype.sort`.
                let mut keys: Vec<String> = found
                    .iter()
                    .filter(|k| order.iter().any(|o| o == *k))
                    .cloned()
                    .collect();
                keys.sort_by_key(|k| {
                    order
                        .iter()
                        .position(|o| o == k)
                        .map(|p| p as i64)
                        .unwrap_or(-1)
                });
                keys
            }
            _ => found,
        }
    }

    /// `snapshot(order?)`; None is the TS `undefined`.
    pub fn snapshot(&self, order: Option<&[String]>) -> Snapshot {
        // 1) Discover which outcomes actually appear in this PMF (insertion order per bin,
        //    first-seen order overall).
        let mut discovered: Vec<String> = Vec::new();
        for bin in self.combined().map.values() {
            for (k, v) in &bin.count {
                // JS: `bin.count[k] && bin.count[k] > 0` — NaN is falsy, 0 fails `> 0`.
                if *v != 0.0 && *v > 0.0 && !discovered.iter().any(|x| x == k) {
                    discovered.push(k.clone());
                }
            }
        }
        if discovered.is_empty() {
            for k in DEFAULT_OUTCOMES {
                if !discovered.iter().any(|x| x == k) {
                    discovered.push(k.to_string());
                }
            }
        }

        // Optional filtering + ordering if a preferred order was provided.
        let mut outcomes = discovered;
        if let Some(order) = order
            && !order.is_empty()
        {
            outcomes.retain(|k| order.iter().any(|o| o == k));
            outcomes.sort_by_key(|k| {
                // `(rank.get(k) ?? 999)`; stable sort matches JS Array.prototype.sort.
                order.iter().position(|o| o == k).unwrap_or(999)
            });
        }

        // 2) Aggregate per-outcome mass and conditional damage ranges via labeled table.
        let mut range_acc: IndexMap<String, (f64, f64, Option<f64>, Option<f64>)> = IndexMap::new();
        for ot in &outcomes {
            range_acc.insert(ot.clone(), (0.0, 0.0, None, None));
        }
        for (damage, row) in labeled_rows(self, &outcomes) {
            for ot in &outcomes {
                let p = row.get(ot).copied().unwrap_or(0.0);
                if p <= 0.0 {
                    continue;
                }
                // Every outcome was inserted above.
                let Some(r) = range_acc.get_mut(ot) else {
                    continue;
                };
                r.0 += damage * p;
                r.1 += p;
                if r.2.unwrap_or(f64::INFINITY) > damage {
                    r.2 = Some(damage);
                }
                if r.3.unwrap_or(f64::NEG_INFINITY) < damage {
                    r.3 = Some(damage);
                }
            }
        }

        let n = self.singles.len() as f64;
        let mut outcome_map = IndexMap::new();
        for ot in &outcomes {
            let Some((sum, mass, min, max)) = range_acc.get(ot) else {
                continue;
            };
            let avg = if *mass > 0.0 { sum / mass } else { 0.0 };
            let label = super::Labels::One(ot.clone());
            outcome_map.insert(
                ot.clone(),
                OutcomeSnapshot {
                    at_least_one_probability: self.prob_at_least_one(&label),
                    all_probability: self.prob_at_least_k(&label, n),
                    damage_min: min.unwrap_or(0.0),
                    damage_avg: avg,
                    damage_max: max.unwrap_or(0.0),
                },
            );
        }

        // 3) Scalars: mean, damageChance, and percentiles.
        let average_dpr = self.mean();
        let mut damage_chance = 0.0;
        for (d, bin) in &self.combined().map {
            if d.0 > 0.0 {
                damage_chance += bin.p;
            }
        }

        Snapshot {
            average_dpr,
            damage_chance,
            p25: self.combined().quantile(0.25),
            p50: self.combined().quantile(0.5),
            p75: self.combined().quantile(0.75),
            outcomes: outcome_map,
        }
    }
}
