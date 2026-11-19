//! Port of query.ts: singleProb (325), countDistribution (349), probAtLeastK (353),
//! probAtLeastOne (389), computeBinomialProbabilities (420), probExactlyK (448), probAtMostK (480),
//! expectedDamageFrom (522), damageStatsFrom (590), combinedDamageStats (682), probabilityOf (733),
//! firstSuccessSplit (1279). A TS throw is `Err(exact message)`.

use super::{DamageStats, DiceQuery, Labels};
use crate::error::DiceError;
use crate::js::num_to_string;

/// `[...new Set(labels)]`: first occurrences, in order.
fn distinct(labels: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in labels {
        if !out.contains(l) {
            out.push(l.clone());
        }
    }
    out
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// `dist[i]` for a JS number index: out of range or non-integer reads `undefined` (NaN here).
fn at(dist: &[f64], i: f64) -> f64 {
    if i >= 0.0 && i.fract() == 0.0 && i < dist.len() as f64 {
        dist[i as usize]
    } else {
        f64::NAN
    }
}

/// `poissonBinomial(probabilities, maxK)` (query.ts:1346). `new Array(maxK + 1)` throws
/// "Invalid array length" unless `maxK + 1` is an integer in 0..2^32; `maxK` = -1 gives `[1]`
/// (the empty array, then `dist[0] = 1`).
fn poisson_binomial(probabilities: &[f64], max_k: f64) -> Result<Vec<f64>, DiceError> {
    let len = max_k + 1.0;
    if !(len >= 0.0 && len.fract() == 0.0 && len < 4_294_967_296.0) {
        return Err(DiceError::invalid_array_length());
    }
    let len = (len as usize).max(1);
    let top = len - 1;
    let mut dist = vec![0.0; len];
    dist[0] = 1.0;
    for &p in probabilities {
        for count in (1..=top).rev() {
            dist[count] = dist[count] * (1.0 - p) + dist[count - 1] * p;
        }
        dist[0] *= 1.0 - p;
    }
    Ok(dist)
}

impl DiceQuery {
    fn single_prob(&self, dice_index: usize, label: &str) -> f64 {
        let Some(single) = self.singles.get(dice_index) else {
            return 0.0;
        };
        let mut probability_sum = 0.0;
        for bin in single.map.values() {
            let c = bin.count.get(label).copied().unwrap_or(0.0);
            probability_sum += if c.is_nan() { 0.0 } else { c };
        }
        let mass = single.mass();
        if mass > 0.0 {
            probability_sum / mass
        } else {
            0.0
        }
    }

    fn count_distribution(&self, labels: &Labels) -> Vec<f64> {
        let probs: Vec<f64> = self
            .singles
            .iter()
            .map(|s| DiceQuery::of(vec![s.clone()]).probability_of(labels))
            .collect();
        // INFALLIBLE: maxK = probs.len() is a non-negative integer, always a valid array length.
        poisson_binomial(&probs, probs.len() as f64).unwrap_or_default()
    }

    fn compute_binomial_probabilities(
        &self,
        label: &str,
        max_k: f64,
    ) -> Result<Vec<f64>, DiceError> {
        let probs: Vec<f64> = (0..self.singles.len())
            .map(|i| self.single_prob(i, label))
            .collect();
        poisson_binomial(&probs, max_k)
    }

    pub fn prob_at_least_k(&self, labels: impl Into<Labels>, k: impl Into<f64>) -> f64 {
        let labels = &labels.into();
        let k = k.into();
        let l = Labels::Many(distinct(&labels.to_vec()));
        let n = self.singles.len() as f64;

        if k <= 0.0 {
            return 1.0;
        }
        if k > n {
            return 0.0;
        }

        let dist = self.count_distribution(&l);
        let mut tail = 0.0;
        let mut i = k;
        while i <= n {
            tail += at(&dist, i);
            i += 1.0;
        }

        if tail < 0.0 {
            return 0.0;
        }
        if tail > 1.0 {
            return 1.0;
        }
        tail
    }

    pub fn prob_at_least_one(&self, labels: impl Into<Labels>) -> f64 {
        let labels = &labels.into();
        let distinct_labels = distinct(&labels.to_vec());

        let mut product_of_non_occurrence = 1.0;
        for dice_index in 0..self.singles.len() {
            let mut combined_probability = 0.0;
            for label in &distinct_labels {
                combined_probability += self.single_prob(dice_index, label);
            }
            combined_probability = combined_probability.clamp(0.0, 1.0);
            product_of_non_occurrence *= 1.0 - combined_probability;
        }
        let result = 1.0 - product_of_non_occurrence;
        result.clamp(0.0, 1.0)
    }

    /// `Err("Invalid array length")` where TS throws: a single label with a non-integer `k`.
    pub fn prob_exactly_k(
        &self,
        labels: impl Into<Labels>,
        k: impl Into<f64>,
    ) -> Result<f64, DiceError> {
        let labels = &labels.into();
        let k = k.into();
        if k < 0.0 {
            return Ok(0.0);
        }
        Ok(match labels {
            Labels::One(label) => at(&self.compute_binomial_probabilities(label, k)?, k),
            Labels::Many(_) => {
                let dist = self.count_distribution(labels);
                if k >= 0.0 && k < dist.len() as f64 {
                    at(&dist, k)
                } else {
                    0.0
                }
            }
        })
    }

    /// `Err("Invalid array length")` where TS throws: a single label with a non-integer `k` or `k < -1`.
    pub fn prob_at_most_k(
        &self,
        labels: impl Into<Labels>,
        k: impl Into<f64>,
    ) -> Result<f64, DiceError> {
        let labels = &labels.into();
        let k = k.into();
        Ok(match labels {
            Labels::One(label) => {
                let probability_array = self.compute_binomial_probabilities(label, k)?;
                let mut cumulative_sum = 0.0;
                let mut outcome_count = 0.0;
                while outcome_count <= k {
                    cumulative_sum += at(&probability_array, outcome_count);
                    outcome_count += 1.0;
                }
                cumulative_sum
            }
            Labels::Many(_) => {
                let dist = self.count_distribution(labels);
                let upper = js_min(k, dist.len() as f64 - 1.0);
                let mut cumulative_sum = 0.0;
                let mut outcome_count = 0.0;
                while outcome_count <= upper {
                    cumulative_sum += at(&dist, outcome_count);
                    outcome_count += 1.0;
                }
                cumulative_sum
            }
        })
    }

    pub fn expected_damage_from(&self, labels: impl Into<Labels>) -> f64 {
        let labels = &labels.into();
        let wanted = distinct(&labels.to_vec());

        let mut total = 0.0;
        for single in &self.singles {
            let mass = single.mass();
            if mass <= 0.0 {
                continue;
            }
            let mut contribution = 0.0;
            for (dmg, bin) in &single.map {
                let mut p = 0.0;
                for label in &wanted {
                    p += bin.count.get(label).copied().unwrap_or(0.0);
                }
                contribution += dmg.0 * p;
            }
            total += if (mass - 1.0).abs() <= self.eps {
                contribution
            } else {
                contribution / mass
            };
        }
        total
    }

    pub fn damage_stats_from(&self, labels: impl Into<Labels>) -> DamageStats {
        let labels = &labels.into();
        let label_array = labels.to_vec();

        let mut min_damage = f64::INFINITY;
        let mut max_damage = f64::NEG_INFINITY;
        let mut total_damage = 0.0;
        let mut total_count = 0.0;

        for (damage, bin) in &self.combined().map {
            let damage = damage.0;
            let mut bin_has_any_label = false;
            let mut bin_contribution = 0.0;

            for label in &label_array {
                let count = bin.count.get(label).copied().unwrap_or(0.0);
                if count != 0.0 && count > 0.0 {
                    bin_has_any_label = true;
                    bin_contribution += count;
                }
            }

            if damage > 0.0 && bin_has_any_label {
                min_damage = js_min(min_damage, damage);
                max_damage = js_max(max_damage, damage);

                let weight = if label_array.len() == 1 {
                    bin_contribution
                } else {
                    bin.p
                };
                total_damage += damage * weight;
                total_count += weight;
            }
        }

        DamageStats {
            min: if min_damage == f64::INFINITY {
                0.0
            } else {
                min_damage
            },
            max: if max_damage == f64::NEG_INFINITY {
                0.0
            } else {
                max_damage
            },
            avg: if total_count > 0.0 {
                total_damage / total_count
            } else {
                0.0
            },
            count: total_count,
        }
    }

    pub fn combined_damage_stats(&self, target_label: &str) -> DamageStats {
        let label = Labels::One(target_label.to_string());
        let single_stats: Vec<DamageStats> = self
            .singles
            .iter()
            .map(|s| DiceQuery::of(vec![s.clone()]).damage_stats_from(&label))
            .collect();

        if single_stats.iter().any(|s| s.count == 0.0) {
            return DamageStats {
                min: 0.0,
                max: 0.0,
                avg: 0.0,
                count: 0.0,
            };
        }

        DamageStats {
            min: single_stats.iter().fold(0.0, |sum, s| sum + s.min),
            max: single_stats.iter().fold(0.0, |sum, s| sum + s.max),
            avg: single_stats.iter().fold(0.0, |sum, s| sum + s.avg),
            count: single_stats.iter().fold(1.0, |prod, s| prod * s.count),
        }
    }

    pub fn probability_of(&self, labels: impl Into<Labels>) -> f64 {
        let labels = &labels.into();
        self.prob_at_least_one(labels)
    }

    /// `[pSuccess, pSubset, pAny, pNone]`; `eps` defaults to `EPS` in TS.
    pub fn first_success_split(
        &self,
        success: &Labels,
        subset: &Labels,
        eps: f64,
    ) -> Result<[f64; 4], DiceError> {
        if self.singles.is_empty() {
            return Err(DiceError::error(
                "firstSuccessSplitFromPMFs: pmfs must be non-empty",
            ));
        }

        let clamp01 = |x: f64| js_max(0.0, js_min(1.0, x));
        let tol = js_max(eps, 8.0 * f64::EPSILON);

        let mut per: Vec<(f64, f64)> = Vec::new();
        for pmf in &self.singles {
            let dq = DiceQuery::of(vec![pmf.clone()]);
            let p_s = dq.prob_at_least_one(success);
            let p_b = dq.prob_at_least_one(subset);
            if p_b - p_s > eps {
                return Err(DiceError::error(
                    "firstSuccessSplitFromPMFs: P(subset) > P(success) for an event. Ensure subset ⊆ success.",
                ));
            }
            per.push((p_s, p_b));
        }

        let mut miss_so_far = 1.0;
        let mut p_first_subset = 0.0;
        let mut p_first_non_subset = 0.0;
        let mut p_none = 1.0;

        for (p_s, p_b) in per {
            p_first_subset += miss_so_far * p_b;
            p_first_non_subset += miss_so_far * (p_s - p_b);
            let miss = 1.0 - p_s;
            miss_so_far *= miss;
            p_none *= miss;
        }

        let p_any = 1.0 - p_none;

        let a = clamp01(p_first_non_subset);
        let b = clamp01(p_first_subset);
        let any = clamp01(p_any);
        let none = clamp01(p_none);

        if (a + b - any).abs() > tol * js_max(1.0, any) {
            return Err(DiceError::error(format!(
                "firstSuccessSplitFromPMFs: parts do not sum to pAny. got a+b={}, pAny={}",
                num_to_string(a + b),
                num_to_string(any)
            )));
        }

        Ok([a, b, any, none])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Pmf;
    use indexmap::IndexMap;

    /// Two singles, each hitting with probability 0.5.
    fn query() -> DiceQuery {
        let mut map = IndexMap::new();
        map.insert(
            crate::Damage(0.0),
            crate::Bin {
                p: 0.5,
                count: [("missNone".to_string(), 0.5)].into_iter().collect(),
                attr: None,
            },
        );
        map.insert(
            crate::Damage(5.0),
            crate::Bin {
                p: 0.5,
                count: [("hit".to_string(), 0.5)].into_iter().collect(),
                attr: None,
            },
        );
        let single = Pmf::new(map, crate::EPS, true);
        DiceQuery::of(vec![single.clone(), single])
    }

    /// Observed in TS (2026-11-17): a non-integer k throws in both; k < -1 throws only in probAtMostK.
    #[test]
    fn odd_k_matches_ts() {
        let q = query();
        let one = Labels::One("hit".to_string());
        let invalid = Err(DiceError::invalid_array_length());
        assert_eq!(q.prob_exactly_k(&one, 2.5), invalid);
        assert_eq!(q.prob_at_most_k(&one, 2.5), invalid);
        assert_eq!(q.prob_exactly_k(&one, 0.5), invalid);
        assert_eq!(q.prob_exactly_k(&one, -3.0), Ok(0.0));
        assert_eq!(q.prob_at_most_k(&one, -3.0), invalid);
        assert_eq!(q.prob_at_most_k(&one, -1.0), Ok(0.0));
        assert_eq!(q.prob_exactly_k(&one, 1.0), Ok(0.5));
    }
}
