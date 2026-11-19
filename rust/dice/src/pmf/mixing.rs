//! Port of pmf.ts mixing: branch (241), withProbability (297), gate (326), exclusive (346),
//! mix (402), mixN (521). `options` is the TS `options` list after its `[pmf, weight]` /
//! `{pmf, weight}` normalization: (pmf, weight) pairs in order. A TS throw is `Err(message)`.

use super::transform::scale_bin;
use super::{Bin, LabelMap, Pmf};
use crate::Damage;
use crate::error::DiceError;
use crate::js::num_to_string;
use indexmap::IndexMap;

/// `PMF.cloneBin`: a new bin with the same p and cloned count / attr maps.
fn clone_bin(bin: &Bin) -> Bin {
    Bin {
        p: bin.p,
        count: bin.count.clone(),
        attr: bin.attr.clone(),
    }
}

/// `PMF.mergeInto`: `bin_to_add` into `map` at `damage`; a clone when the damage is new,
/// otherwise the bin's p, count and (if present) attr are added value by value.
fn merge_into(map: &mut IndexMap<Damage, Bin>, damage: Damage, bin_to_add: &Bin) {
    let Some(existing) = map.get_mut(&damage) else {
        map.insert(damage, clone_bin(bin_to_add));
        return;
    };
    existing.p += bin_to_add.p;
    for (label, v) in &bin_to_add.count {
        let entry = existing.count.entry(label.clone()).or_insert(0.0);
        *entry += v;
    }
    if let Some(added_attr) = &bin_to_add.attr {
        let slot = existing.attr.get_or_insert_with(IndexMap::new);
        for (label, v) in added_attr {
            let entry = slot.entry(label.clone()).or_insert(0.0);
            *entry += v;
        }
    }
}

impl Pmf {
    pub fn branch(success: &Pmf, failure: &Pmf, success_probability: f64) -> Pmf {
        // Non-finite (NaN, ±Infinity) becomes 0; the rest is clamped to [0, 1], as in TS.
        let p = if success_probability.is_finite() {
            success_probability.clamp(0.0, 1.0)
        } else {
            0.0
        };

        let q = 1.0 - p;

        // Fast paths. scaleMass(1) returns the same instance, so these hand back the
        // branch PMF unchanged. That is safe because PMFs are treated as immutable
        // (compact() and the other transforms now clone bins rather than mutate).
        if p == 0.0 {
            return failure.scale_mass(1.0);
        }
        if p == 1.0 {
            return success.scale_mass(1.0);
        }

        // Choose epsilon. You can also pick Math.min for a tighter threshold.
        let eps = if success.epsilon.is_nan() {
            failure.epsilon
        } else {
            success.epsilon
        };

        // Proper Bernoulli mixture: q·failure ⊕ p·success, assembled in a single
        // pass. The previous `empty().addScaled(failure,q).addScaled(success,p)`
        // chain copied failurePMF's bins twice (into the intermediate, then again
        // when the intermediate was copied by the second addScaled). Merging both
        // scaled branches directly into one fresh map keeps the same accumulation
        // order — q·failure first, then p·success — so the result is bit-identical.
        let mut result_map = IndexMap::new();
        for (damage_value, bin) in &failure.map {
            merge_into(&mut result_map, *damage_value, &scale_bin(bin, q));
        }
        for (damage_value, bin) in &success.map {
            merge_into(&mut result_map, *damage_value, &scale_bin(bin, p));
        }

        Pmf::new(result_map, eps, false)
    }

    /// `withProbability(successPMF, probability)`: a convenience wrapper around `branch()`
    /// for the common case where the "failure" branch is always `zero()`.
    pub fn with_probability(success: &Pmf, probability: f64) -> Pmf {
        Pmf::branch(success, &Pmf::zero(crate::EPS), probability)
    }

    /// `gate(p, fallback)`: a conditional wrapper around `branch()` that applies this PMF
    /// with probability `p` and the fallback PMF otherwise.
    pub fn gate(&self, p: f64, fallback: &Pmf) -> Pmf {
        Pmf::branch(self, fallback, p)
    }

    /// `exclusive(options, eps)`: builds a single PMF from a set of mutually exclusive
    /// weighted outcomes. Exactly one of the provided options occurs.
    pub fn exclusive(options: &[(Pmf, f64)], eps: f64) -> Result<Pmf, DiceError> {
        // Validate weights
        for (_, weight) in options {
            if !weight.is_finite() || *weight < -eps {
                return Err(DiceError::error(format!(
                    "PMF.exclusive: invalid weight {}.",
                    num_to_string(*weight)
                )));
            }
        }

        // Sum and check
        let mut total_weight = options.iter().fold(0.0, |s, (_, weight)| s + weight);

        // Normalize tiny negatives to 0 and tiny overshoot to 1 when within eps
        if total_weight.abs() <= eps {
            total_weight = 0.0;
        }
        if (1.0 - total_weight).abs() <= eps {
            total_weight = 1.0;
        }

        if total_weight > 1.0 + crate::EPS {
            return Err(DiceError::error(format!(
                "PMF.exclusive: total weight {} exceeds 1. (epsilon: {})",
                num_to_string(total_weight),
                num_to_string(eps)
            )));
        }

        // Accumulate scaled components, skipping near-zero weights
        let mut out = Pmf::empty(eps);
        for (pmf, weight) in options {
            if *weight > eps {
                out = out.add_scaled(pmf, *weight);
            }
        }

        // Add leftover mass at zero outcome
        let leftover = if total_weight.is_nan() {
            f64::NAN
        } else {
            f64::MAX.min(1.0 - total_weight)
        };
        if leftover > eps {
            out = out.add_scaled(&Pmf::zero(crate::EPS), leftover);
        }

        Ok(out)
    }

    /// `mix(options, eps)`: builds a PMF as a linear combination of input PMFs with the
    /// given weights. Unlike `exclusive`, this does not enforce that weights sum to 1
    /// and does not add leftover probability to δ0 (`PMF.zero()`).
    pub fn mix(options: &[(Pmf, f64)], eps: f64) -> Result<Pmf, DiceError> {
        // Validate weights, but do not constrain their sum.
        for (_, weight) in options {
            if !weight.is_finite() {
                return Err(DiceError::error(format!(
                    "PMF.mix: invalid weight {}.",
                    num_to_string(*weight)
                )));
            }
        }

        // One pass, contribution by contribution in option order: the same arithmetic as
        // chaining `addScaled`, without copying the growing map at every step. Inputs
        // are never aliased or mutated.
        let mut map: IndexMap<Damage, Bin> = IndexMap::new();
        let mut used = false;
        for (pmf, weight) in options {
            if weight.abs() <= eps || *weight == 0.0 {
                continue; // ignore crumbs; addScaled(0) is a no-op
            }
            used = true;
            let unit = *weight == 1.0;
            for (dmg, added) in &pmf.map {
                if let Some(existing) = map.get_mut(dmg) {
                    existing.p += if unit { added.p } else { added.p * weight };
                    for (label_key, v) in &added.count {
                        let value = if unit { *v } else { *v * weight };
                        let entry = existing.count.entry(label_key.clone()).or_insert(0.0);
                        *entry += value;
                    }
                    if let Some(added_attr) = &added.attr {
                        let attr: &mut LabelMap = existing.attr.get_or_insert_with(IndexMap::new);
                        for (label_key, v) in added_attr {
                            let value = if unit { *v } else { *v * weight };
                            let entry = attr.entry(label_key.clone()).or_insert(0.0);
                            *entry += value;
                        }
                    }
                    continue;
                }
                map.insert(
                    *dmg,
                    if unit {
                        clone_bin(added)
                    } else {
                        scale_bin(added, *weight)
                    },
                );
            }
        }
        Ok(if used {
            Pmf::new(map, eps, false)
        } else {
            Pmf::empty(eps)
        })
    }

    /// `mixN(weights, eps)`: general-purpose N-way mixing over `(weight, pmf)` pairs.
    pub fn mix_n(weights: &[(f64, Pmf)], eps: f64) -> Result<Pmf, DiceError> {
        // Treat tiny/negative as zero; keep performance clean
        let filtered: Vec<(f64, &Pmf)> = weights
            .iter()
            .filter(|(w, _)| *w > eps)
            .map(|(w, pmf)| (*w, pmf))
            .collect();

        let Some((first_w, first_pmf)) = filtered.first().copied() else {
            return Ok(Pmf::empty_mass()); // not PMF.zero(): we want "no mass" mixture
        };

        // No need to normalize up front; accumulation blends by relative weight
        let mut acc = first_pmf.clone();
        let mut sum = first_w;

        for (w, pmf) in &filtered[1..] {
            let q = w / (sum + w); // relative weight of the new component
            acc = Pmf::branch(pmf, &acc, q); // success=new pmf, failure=acc
            sum += w;
        }

        Ok(acc)
    }
}
