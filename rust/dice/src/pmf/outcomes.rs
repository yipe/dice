//! Outcome-label queries. Port of pmf.ts: outcomes (1692), outcomeProbability (1708),
//! filterOutcome (2060) with sliceEveryOutcome (2067).

use crate::Damage;
use indexmap::{IndexMap, IndexSet};
use std::sync::Arc;

use super::{Bin, LabelMap, Pmf};

impl Pmf {
    /// `outcomes()`: labels with count > 0, in first-insertion order, sorted by UTF-16.
    pub fn outcomes(&self) -> Vec<String> {
        self.fp
            .outcomes
            .get_or_init(|| self.compute_outcomes())
            .clone()
    }

    fn compute_outcomes(&self) -> Vec<String> {
        let mut set: IndexSet<String> = IndexSet::new();
        for (_v, bin) in &self.map {
            for (outcome, c) in &bin.count {
                if *c > 0.0 {
                    set.insert(outcome.clone());
                }
            }
        }
        let mut v: Vec<String> = set.into_iter().collect();
        v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        v
    }

    /// `outcomeProbability(outcome)`: total probability of an outcome across all bins.
    pub fn outcome_probability(&self, outcome: &str) -> f64 {
        let mut total = 0.0;
        for (_v, bin) in &self.map {
            total += bin.count.get(outcome).copied().unwrap_or(0.0);
        }
        total
    }

    /// `filterOutcome(outcome)`: marginal distribution for one outcome (memoized slices).
    pub fn filter_outcome(&self, outcome: &str) -> Pmf {
        (*self.filter_outcome_shared(outcome)).clone()
    }

    /// `filterOutcome(outcome)` as the shared memoized PMF, so its own memos stay warm.
    pub fn filter_outcome_shared(&self, outcome: &str) -> Arc<Pmf> {
        let slices = self.fp.slices.get_or_init(|| self.slice_every_outcome());
        match slices.get(outcome) {
            Some(pmf) => Arc::clone(pmf),
            None => Arc::new(Pmf::new(IndexMap::new(), self.epsilon, false)),
        }
    }

    /// `sliceEveryOutcome()`: one sliced PMF per outcome label carried by any bin, in
    /// first-seen order. A bin whose count sum is not > 0 is skipped; labels with a
    /// non-positive count are skipped within a bin.
    fn slice_every_outcome(&self) -> IndexMap<String, Arc<Pmf>> {
        let mut maps: IndexMap<String, IndexMap<Damage, Bin>> = IndexMap::new();
        for (damage_value, bin) in &self.map {
            let count = &bin.count;
            // total paths that reached this bin (sum across labels, in count order)
            // TS `if (!(totalCount > 0))` must keep the negated form: it also skips NaN.
            let mut total_count = 0.0;
            for c in count.values() {
                total_count += *c;
            }
            #[allow(clippy::neg_cmp_op_on_partial_ord)]
            if !(total_count > 0.0) {
                continue;
            }
            for (outcome, outcome_count) in count {
                let outcome_count = *outcome_count;
                #[allow(clippy::neg_cmp_op_on_partial_ord)]
                if !(outcome_count > 0.0) {
                    continue;
                }

                // proportion of this bin's mass attributable to the outcome
                let proportion = outcome_count / total_count;

                // downweight p to the unconditional mass from the outcome only
                let new_p = bin.p * proportion;

                let mut new_count: LabelMap = IndexMap::new();
                new_count.insert(outcome.clone(), outcome_count);

                let new_attr = match bin.attr.as_ref() {
                    Some(attr) if attr.contains_key(outcome) => {
                        let mut m: LabelMap = IndexMap::new();
                        m.insert(outcome.clone(), attr[outcome] * proportion);
                        Some(m)
                    }
                    _ => None,
                };

                // A bin can only re-enter an outcome's map after inserting a fresh one,
                // so `or_default` (unlike `or_insert_with`) never pays for a default.
                let entry = maps.entry(outcome.clone()).or_default();
                entry.insert(
                    *damage_value,
                    Bin {
                        p: new_p,
                        count: new_count,
                        attr: new_attr,
                    },
                );
            }
        }
        maps.into_iter()
            .map(|(outcome, filtered_map)| {
                (
                    outcome,
                    Arc::new(Pmf::new(filtered_map, self.epsilon, false)),
                )
            })
            .collect()
    }
}
