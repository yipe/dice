//! Port of pmf.ts lookups: hasAttribution (465), outcomeMass (635), faceTotal (644),
//! denseSupport (1609), outcomeAt (1687), outcomeAttributionAt (1717), binAt (1722),
//! hasOutcome (1738), tailProbGT (2042).

use super::{Bin, Pmf};
use crate::Damage;

impl Pmf {
    /// `hasAttribution()`: true if the first non-zero bin carries a non-empty `attr`.
    /// Only the first positive-damage bin is inspected (parser-generated PMFs populate
    /// `attr` uniformly), so this is O(1) in practice.
    pub fn has_attribution(&self) -> bool {
        for (damage, bin) in &self.map {
            if damage.0 != 0.0 {
                if let Some(attr) = &bin.attr
                    && !attr.is_empty()
                {
                    return true;
                }
                if damage.0 > 0.0 {
                    break;
                }
            }
        }
        false
    }

    /// `outcomeMass(outcome)`: total probability mass attributable to an outcome,
    /// summed in map order as Σ p * (count[outcome] ?? 0).
    pub fn outcome_mass(&self, outcome: &str) -> f64 {
        let mut total = 0.0;
        for (_v, bin) in &self.map {
            total += bin.p * bin.count.get(outcome).copied().unwrap_or(0.0);
        }
        total
    }

    /// `faceTotal()`: sum of damage keys in map order, starting from 0.
    pub fn face_total(&self) -> f64 {
        let mut sum = 0.0;
        for (v, _bin) in &self.map {
            sum += v.0;
        }
        sum
    }

    /// `denseSupport()`: dense integer range min..max (inclusive).
    pub fn dense_support(&self) -> Vec<f64> {
        if self.map.is_empty() {
            return Vec::new();
        }
        let lo = self.min();
        let hi = self.max();
        let n = (hi - lo + 1.0) as usize;
        (0..n).map(|i| lo + i as f64).collect()
    }

    /// `outcomeAt(damage, outcome)`: count of `outcome` at `damage`, or 0 when absent.
    pub fn outcome_at(&self, damage: f64, outcome: &str) -> f64 {
        self.map
            .get(&Damage(damage))
            .map(|b| b.count.get(outcome).copied().unwrap_or(0.0))
            .unwrap_or(0.0)
    }

    /// `outcomeAttributionAt(damage, outcome)`: attr of `outcome` at `damage`, or 0 when absent.
    pub fn outcome_attribution_at(&self, damage: f64, outcome: &str) -> f64 {
        self.map
            .get(&Damage(damage))
            .and_then(|b| b.attr.as_ref())
            .map(|a| a.get(outcome).copied().unwrap_or(0.0))
            .unwrap_or(0.0)
    }

    /// `binAt(damage)`: None where the TS returns null. The copy's `attr` is None when
    /// the bin has none; count and attr are deep-copied, keys in the source's order.
    pub fn bin_at(&self, damage: f64) -> Option<Bin> {
        let bin = self.map.get(&Damage(damage))?;
        Some(Bin {
            p: bin.p,
            count: bin.count.clone(),
            attr: bin.attr.clone(),
        })
    }

    /// `hasOutcome(outcome)`: true if any bin carries a count of `outcome` > 0.
    pub fn has_outcome(&self, outcome: &str) -> bool {
        for (_v, bin) in &self.map {
            if bin.count.get(outcome).copied().unwrap_or(0.0) > 0.0 {
                return true;
            }
        }
        false
    }

    /// `tailProbGT(t)`: Σ p over bins whose damage > t, in insertion order.
    pub fn tail_prob_gt(&self, t: f64) -> f64 {
        let mut s = 0.0;
        for (v, bin) in &self.map {
            if v.0 > t {
                s += bin.p;
            }
        }
        s
    }
}
