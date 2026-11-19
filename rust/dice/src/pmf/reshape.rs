//! Port of pmf.ts reshaping: withAttribution (476), compact (686), applyHitFrequency (937),
//! splitByDealt (988), mapDamage (1052), scaleDamage (1076) with scaleValue (src/pmf/sample.ts),
//! prune (1497), rebin (1596). A TS throw is `Err(message)`.

use super::sample::scale_value;
use super::transform::scale_bin;
use super::{Bin, LabelMap, Pmf};
use crate::Damage;
use crate::builder::nodes::Rounding;
use crate::error::DiceError;
use crate::js::num_to_string;
use indexmap::IndexMap;

/// `MISS_NONE_OUTCOME` in src/common/types.ts.
const MISS_NONE_OUTCOME: &str = "missNone";

/// `PMF.cloneBin`: deep-copies a bin, cloning its count and (optional) attr maps.
fn clone_bin(bin: &Bin) -> Bin {
    Bin {
        p: bin.p,
        count: bin.count.clone(),
        attr: bin.attr.clone(),
    }
}

/// `PMF.mergeInto`: merges `bin_to_add` into `destination_map` at `damage_value`.
pub(super) fn merge_into(
    destination_map: &mut IndexMap<Damage, Bin>,
    damage_value: Damage,
    bin_to_add: &Bin,
) {
    let key = Damage(damage_value.0);
    match destination_map.get_mut(&key) {
        None => {
            destination_map.insert(key, clone_bin(bin_to_add));
        }
        Some(existing) => {
            existing.p += bin_to_add.p;
            for (label, v) in &bin_to_add.count {
                let entry = existing.count.entry(label.clone()).or_insert(0.0);
                *entry += v;
            }
            if let Some(attr) = &bin_to_add.attr {
                let slot = existing.attr.get_or_insert_with(IndexMap::new);
                for (label, v) in attr {
                    let entry = slot.entry(label.clone()).or_insert(0.0);
                    *entry += v;
                }
            }
        }
    }
}

/// `hasAttribution` (pmf.ts:465): true if the first positive-damage bin has non-empty attr.
fn has_attribution_check(pmf: &Pmf) -> bool {
    for (damage, bin) in &pmf.map {
        if damage.0 != 0.0 && bin.attr.as_ref().is_some_and(|a| !a.is_empty()) {
            return true;
        }
        if damage.0 > 0.0 {
            break;
        }
    }
    false
}

/// JS `Math.max(0, x)`: NaN propagates.
fn js_max_0(x: f64) -> f64 {
    if x.is_nan() { f64::NAN } else { x.max(0.0) }
}

impl Pmf {
    /// `withAttribution` (pmf.ts:476).
    pub fn with_attribution(&self) -> Pmf {
        if has_attribution_check(self) {
            return self.clone();
        }
        let mut new_map = IndexMap::new();
        for (damage, bin) in &self.map {
            let mut attr: LabelMap = IndexMap::new();
            for (outcome, probability) in &bin.count {
                if outcome == MISS_NONE_OUTCOME {
                    continue;
                }
                if *probability > 0.0 {
                    let _ = outcome;
                    attr.insert(outcome.clone(), damage.0 * probability);
                }
            }
            let attr = if attr.is_empty() { None } else { Some(attr) };
            new_map.insert(
                *damage,
                Bin {
                    p: bin.p,
                    count: bin.count.clone(),
                    attr,
                },
            );
        }
        Pmf {
            fp: Default::default(),
            map: new_map,
            epsilon: self.epsilon,
            normalized: self.normalized,
            identifier: None,
        }
    }

    /// `compact(eps, keepFinalBin)` (pmf.ts:686).
    pub fn compact(&self, eps: Option<f64>, keep_final_bin: bool) -> Pmf {
        let eps = eps.unwrap_or(self.epsilon);
        let mut max_key = f64::NEG_INFINITY;
        if keep_final_bin {
            for key in self.map.keys() {
                if key.0 > max_key {
                    max_key = key.0;
                }
            }
        }
        let mut compacted = IndexMap::new();
        for (damage_value, probability_bin) in &self.map {
            let should_keep =
                probability_bin.p >= eps || (keep_final_bin && damage_value.0 == max_key);
            if !should_keep {
                continue;
            }
            let mut cleaned = clone_bin(probability_bin);
            let mut count: LabelMap = IndexMap::new();
            for (k, v) in &cleaned.count {
                let vv = if v.is_nan() || *v == 0.0 { 0.0 } else { *v };
                if vv.abs() < eps {
                    continue;
                }
                count.insert(k.clone(), *v);
            }
            cleaned.count = count;
            if let Some(attr) = &mut cleaned.attr {
                let mut new_attr: LabelMap = IndexMap::new();
                for (k, v) in attr.iter() {
                    let vv = if v.is_nan() || *v == 0.0 { 0.0 } else { *v };
                    if vv.abs() < eps {
                        continue;
                    }
                    new_attr.insert(k.clone(), *v);
                }
                if new_attr.is_empty() {
                    cleaned.attr = None;
                } else {
                    *attr = new_attr;
                }
            }
            compacted.insert(*damage_value, cleaned);
        }
        Pmf {
            fp: Default::default(),
            map: compacted,
            epsilon: eps,
            normalized: self.normalized,
            identifier: self.identifier.clone(),
        }
    }

    /// `applyHitFrequency` (pmf.ts:937).
    pub fn apply_hit_frequency(&self, frequency: f64) -> Pmf {
        if frequency.is_nan() || frequency.is_infinite() || frequency >= 1.0 {
            return self.clone();
        }
        let freq = js_max_0(frequency);
        let freed_mass = (1.0 - freq) * self.mass();
        let mut new_map = IndexMap::new();
        if freq > 0.0 {
            for (damage, bin) in &self.map {
                new_map.insert(*damage, scale_bin(bin, freq));
            }
        }
        if freed_mass > 0.0 {
            let miss_bin = Bin {
                p: freed_mass,
                count: LabelMap::from_iter([(MISS_NONE_OUTCOME.to_string(), freed_mass)]),
                attr: Some(LabelMap::new()),
            };
            merge_into(&mut new_map, Damage(0.0), &miss_bin);
        }
        Pmf {
            fp: Default::default(),
            map: new_map,
            epsilon: self.epsilon,
            normalized: false,
            identifier: None,
        }
    }

    /// `splitByFactor` (pmf.ts:970): bin `d` splits `factor(d)` / `1 - factor(d)` between the two
    /// halves (`factor` clamped to `[0, 1]` as `Math.min(1, Math.max(0, f))`, NaN propagating to
    /// neither half, as in JS where both comparisons are false).
    pub fn split_by_factor(&self, factor: impl Fn(f64) -> f64) -> (Pmf, Pmf) {
        let mut a = IndexMap::new();
        let mut b = IndexMap::new();
        for (damage, bin) in &self.map {
            let raw = factor(damage.0);
            // Math.min(1, Math.max(0, raw)): NaN stays NaN.
            let f = if raw.is_nan() {
                raw
            } else {
                raw.clamp(0.0, 1.0)
            };
            if f > 0.0 {
                a.insert(*damage, scale_bin(bin, f));
            }
            if f < 1.0 {
                b.insert(*damage, scale_bin(bin, 1.0 - f));
            }
        }
        (
            Pmf {
                fp: Default::default(),
                map: a,
                epsilon: self.epsilon,
                normalized: false,
                identifier: None,
            },
            Pmf {
                fp: Default::default(),
                map: b,
                epsilon: self.epsilon,
                normalized: false,
                identifier: None,
            },
        )
    }

    /// `splitByDealt` (pmf.ts:988): `[above 0, at or below 0]`, each bin whole in one half.
    pub fn split_by_dealt(&self) -> (Pmf, Pmf) {
        let mut a = IndexMap::new();
        let mut b = IndexMap::new();
        for (damage, bin) in &self.map {
            let f = if damage.0 > 0.0 { 1.0 } else { 0.0 };
            if f > 0.0 {
                a.insert(*damage, scale_bin(bin, f));
            }
            if f < 1.0 {
                b.insert(*damage, scale_bin(bin, 1.0 - f));
            }
        }
        (
            Pmf {
                fp: Default::default(),
                map: a,
                epsilon: self.epsilon,
                normalized: false,
                identifier: None,
            },
            Pmf {
                fp: Default::default(),
                map: b,
                epsilon: self.epsilon,
                normalized: false,
                identifier: None,
            },
        )
    }

    /// `mapDamage` (pmf.ts:1052).
    pub fn map_damage(&self, f: impl Fn(f64) -> f64) -> Pmf {
        let mut transformed_map = IndexMap::new();
        for (original_damage, probability_bin) in &self.map {
            let transformed_damage = f(original_damage.0);
            merge_into(
                &mut transformed_map,
                Damage(transformed_damage),
                probability_bin,
            );
        }
        Pmf {
            fp: Default::default(),
            map: transformed_map,
            epsilon: self.epsilon,
            normalized: self.normalized,
            identifier: None,
        }
    }

    /// `scaleDamage` (pmf.ts:1076). `rounding` is "floor", "round" or "ceil".
    pub fn scale_damage(
        &self,
        factor: f64,
        rounding: &str,
        denominator: f64,
    ) -> Result<Pmf, DiceError> {
        if factor.is_nan() || factor.is_infinite() {
            return Err(DiceError::range(format!(
                "scaleDamage() factor must be finite, got {}",
                num_to_string(factor)
            )));
        }
        if denominator.is_nan() || denominator.is_infinite() || denominator == 0.0 {
            return Err(DiceError::range(format!(
                "scaleDamage() denominator must be finite and non-zero, got {}",
                num_to_string(denominator)
            )));
        }
        let rounding = match rounding {
            "round" => Rounding::Round,
            "ceil" => Rounding::Ceil,
            _ => Rounding::Floor,
        };
        Ok(self.map_damage(|v| scale_value(v, factor, rounding, denominator)))
    }

    /// `prune` (pmf.ts:1497): relative pruning with optional top-K floor.
    pub fn prune(&self, eps_rel: f64, min_bins: f64) -> Pmf {
        let size = self.map.len();
        if size == 0 {
            return self.clone();
        }
        let mut peak = 0.0;
        let mut min_damage = f64::INFINITY;
        let mut max_damage = f64::NEG_INFINITY;
        for (dmg, bin) in &self.map {
            if bin.p > peak {
                peak = bin.p;
            }
            if dmg.0 < min_damage {
                min_damage = dmg.0;
            }
            if dmg.0 > max_damage {
                max_damage = dmg.0;
            }
        }
        if peak == 0.0 {
            Pmf {
                fp: Default::default(),
                map: self.map.clone(),
                epsilon: eps_rel,
                normalized: false,
                identifier: self.identifier.clone(),
            }
        } else {
            let thresh = eps_rel * peak;
            let entries: Vec<(Damage, &Bin)> = self.map.iter().map(|(d, b)| (*d, b)).collect();
            // Protect min and max endpoints; a NaN endpoint misses the map lookup and is
            // skipped, exactly like the TS `if (b)` guard.
            let endpoints = [
                min_damage,
                if max_damage != min_damage {
                    max_damage
                } else {
                    f64::NAN
                },
            ];
            let mut survivors: IndexMap<Damage, &Bin> = IndexMap::new();
            for d in endpoints {
                if d.is_nan() {
                    continue;
                }
                if let Some(b) = self.map.get(&Damage(d)) {
                    survivors.insert(Damage(d), b);
                }
            }
            for (dmg, bin) in &entries {
                if bin.p >= thresh {
                    survivors.insert(*dmg, bin);
                }
            }
            if min_bins > 0.0 && survivors.len() < min_bins as usize {
                let mut by_p: Vec<(Damage, &Bin)> = entries.clone();
                by_p.sort_by(|a, b| {
                    b.1.p
                        .partial_cmp(&a.1.p)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                for (dmg, bin) in &by_p {
                    if !survivors.contains_key(dmg) {
                        survivors.insert(*dmg, bin);
                        if (survivors.len() as f64) >= min_bins {
                            break;
                        }
                    }
                }
            }
            let mut pruned_map = IndexMap::new();
            for (dmg, bin) in &survivors {
                let mut new_count: LabelMap = IndexMap::new();
                for (k, v) in &bin.count {
                    if v.abs() >= thresh {
                        new_count.insert(k.clone(), *v);
                    }
                }
                let mut new_attr: Option<LabelMap> = None;
                if let Some(attr) = &bin.attr {
                    for (k, v) in attr {
                        if v.abs() >= thresh {
                            let slot = new_attr.get_or_insert_with(IndexMap::new);
                            slot.insert(k.clone(), *v);
                        }
                    }
                }
                pruned_map.insert(
                    *dmg,
                    Bin {
                        p: bin.p,
                        count: new_count,
                        attr: new_attr,
                    },
                );
            }
            Pmf {
                fp: Default::default(),
                map: pruned_map,
                epsilon: eps_rel,
                normalized: false,
                identifier: None,
            }
        }
    }

    /// `rebin` (pmf.ts:1596).
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    pub fn rebin(&self, max_buckets: f64) -> Pmf {
        // Copied from TS `if (!(maxBuckets > 0)) return this;` — NaN must return this.
        if !(max_buckets > 0.0) {
            return self.clone();
        }
        let support = self.support();
        if support.is_empty() {
            return self.clone();
        }
        let min = support[0].0;
        let max = support[support.len() - 1].0;
        let range = max - min;
        if range + 1.0 <= max_buckets {
            return self.clone();
        }
        let bin_size = ((range + 1.0) / max_buckets).ceil();
        self.map_damage(move |d| min + ((d - min) / bin_size).floor() * bin_size)
    }
}
