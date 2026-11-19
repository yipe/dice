//! Port of `src/pmf/query.ts` (class `DiceQuery`): statistics over a list of single PMFs and
//! their combined (convolved) distribution.

use std::cell::OnceCell;

use indexmap::IndexMap;

use crate::{EPS, Pmf};

mod labels;
mod series;
mod stats;
mod tables;
mod transform;

pub use tables::{DamageRange, StackedChartData, StackedDataset};

/// A TS `OutcomeType | OutcomeType[]` argument, kept as given: some TS code branches on
/// `typeof labels === "string"`.
#[derive(Clone, Debug, PartialEq)]
pub enum Labels {
    One(String),
    Many(Vec<String>),
}

impl From<&Labels> for Labels {
    fn from(labels: &Labels) -> Self {
        labels.clone()
    }
}

impl From<&str> for Labels {
    fn from(label: &str) -> Self {
        Labels::One(label.to_string())
    }
}

impl From<String> for Labels {
    fn from(label: String) -> Self {
        Labels::One(label)
    }
}

impl<const N: usize> From<[&str; N]> for Labels {
    fn from(labels: [&str; N]) -> Self {
        Labels::Many(labels.iter().map(|l| (*l).to_string()).collect())
    }
}

impl From<Vec<String>> for Labels {
    fn from(labels: Vec<String>) -> Self {
        Labels::Many(labels)
    }
}

impl From<Vec<&str>> for Labels {
    fn from(labels: Vec<&str>) -> Self {
        Labels::Many(labels.into_iter().map(str::to_string).collect())
    }
}

impl Labels {
    /// `typeof labels === "string" ? [labels] : labels`.
    pub fn to_vec(&self) -> Vec<String> {
        match self {
            Labels::One(s) => vec![s.clone()],
            Labels::Many(v) => v.clone(),
        }
    }
}

/// `damageStatsFrom` / `combinedDamageStats` result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DamageStats {
    pub min: f64,
    pub max: f64,
    pub avg: f64,
    pub count: f64,
}

/// `OutcomeSnapshot` (query.ts:1358).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OutcomeSnapshot {
    pub at_least_one_probability: f64,
    pub all_probability: f64,
    /// `damageRange: { min, avg, max }`.
    pub damage_min: f64,
    pub damage_avg: f64,
    pub damage_max: f64,
}

/// `Snapshot` (query.ts:1364).
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub average_dpr: f64,
    pub damage_chance: f64,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    /// A JS `Map<OutcomeType, OutcomeSnapshot>`, in insertion order.
    pub outcomes: IndexMap<String, OutcomeSnapshot>,
}

/// `toCDFSeries` / `toCCDFSeries` result.
#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub support: Vec<f64>,
    pub data: Vec<f64>,
}

/// `DiceQuery`. `combined` is computed once on first use, like the TS getter.
#[derive(Clone, Debug)]
pub struct DiceQuery {
    pub singles: Vec<Pmf>,
    pub eps: f64,
    /// The `combined` argument the constructor was given (normalized as it does), if any.
    provided: Option<Pmf>,
    cache: OnceCell<Pmf>,
}

impl DiceQuery {
    /// `new DiceQuery(singles, combined, eps)` (query.ts:24).
    pub fn new(singles: Vec<Pmf>, combined: Option<Pmf>, eps: f64) -> Self {
        let provided = combined.map(|c| {
            if (c.mass() - 1.0).abs() <= eps {
                c
            } else {
                c.normalize()
            }
        });
        Self {
            singles,
            eps,
            provided,
            cache: OnceCell::new(),
        }
    }

    /// `new DiceQuery(singles)` with the default epsilon.
    pub fn of(singles: Vec<Pmf>) -> Self {
        Self::new(singles, None, EPS)
    }

    /// Whether the constructor was given `combined` (TS `_combinedProvided`).
    pub fn combined_provided(&self) -> Option<&Pmf> {
        self.provided.as_ref()
    }

    /// The `combined` getter (query.ts:49): the provided PMF, or `PMF.convolveMany(singles)`
    /// normalized unless within `eps` of mass 1.
    pub fn combined(&self) -> &Pmf {
        if let Some(p) = &self.provided {
            return p;
        }
        self.cache.get_or_init(|| {
            let c = Pmf::convolve_many(&self.singles, EPS);
            if (c.mass() - 1.0).abs() <= self.eps {
                c
            } else {
                c.normalize()
            }
        })
    }
}
