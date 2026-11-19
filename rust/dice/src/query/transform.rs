//! Port of query.ts: normalize (1153), compact (1164), addScaled (1181), scaleMass (1198),
//! convolve (1265). Each returns a new `DiceQuery` built as the TS `new DiceQuery([...])` builds it
//! (`DiceQuery::of(vec![...])`).

use super::DiceQuery;

impl DiceQuery {
    /// `new DiceQuery([this.combined.normalize()])` (query.ts:1153).
    pub fn normalize(&self) -> DiceQuery {
        DiceQuery::of(vec![self.combined().normalize()])
    }

    /// `new DiceQuery([this.combined.compact(eps, keepFinalBin)])` (query.ts:1164).
    /// `None` eps = PMF default; absent keepFinalBin = false.
    pub fn compact(&self, eps: Option<f64>, keep_final_bin: bool) -> DiceQuery {
        DiceQuery::of(vec![self.combined().compact(eps, keep_final_bin)])
    }

    /// `new DiceQuery([this.combined.addScaled(branch.combined, probability)])` (query.ts:1181).
    pub fn add_scaled(&self, branch: &DiceQuery, probability: f64) -> DiceQuery {
        DiceQuery::of(vec![
            self.combined().add_scaled(branch.combined(), probability),
        ])
    }

    /// `new DiceQuery([this.combined.scaleMass(factor)])` (query.ts:1198).
    pub fn scale_mass(&self, factor: f64) -> DiceQuery {
        DiceQuery::of(vec![self.combined().scale_mass(factor)])
    }

    /// `new DiceQuery([...this.singles, ...other.singles])` (query.ts:1265): a new query
    /// whose singles are the concatenated lists.
    pub fn convolve(&self, other: &DiceQuery) -> DiceQuery {
        let mut singles = self.singles.clone();
        singles.extend(other.singles.iter().cloned());
        DiceQuery::of(singles)
    }
}
