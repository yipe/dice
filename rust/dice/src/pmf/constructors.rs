//! Port of pmf.ts constructors: empty (192), zero (197), delta (203) with fromMap (2198),
//! missNone (216), emptyMass (223). Identifiers are not compared by the fixtures: leave them None.

use crate::error::DiceError;
use indexmap::IndexMap;

use super::{Bin, LabelMap, Pmf};
use crate::Damage;
use crate::js::num_to_string;

impl Pmf {
    /// `PMF.fromMap(m, eps, { requireIntegerValues })` (pmf.ts:2198): `Err` where TS throws.
    #[allow(
        clippy::needless_pass_by_value,
        reason = "public API called by value from rust/dice-node"
    )]
    pub fn from_map(
        m: IndexMap<Damage, f64>,
        eps: f64,
        require_integer_values: bool,
    ) -> Result<Pmf, DiceError> {
        let mut filtered: Vec<(Damage, f64)> = Vec::new();
        for (v, p) in &m {
            if !v.0.is_finite() || !p.is_finite() {
                continue;
            }
            if *p <= 0.0 || p.abs() < eps {
                continue;
            }
            if require_integer_values && v.0.fract() != 0.0 {
                return Err(DiceError::error(format!(
                    "fromMap: non-integer outcome {}",
                    num_to_string(v.0)
                )));
            }
            filtered.push((*v, *p));
        }

        if filtered.is_empty() {
            return Err(DiceError::error("fromMap: empty or invalid input map"));
        }

        // Kahan sum for stability.
        let mut sum = 0.0;
        let mut c = 0.0;
        for (_, p) in &filtered {
            let y = *p - c;
            let t = sum + y;
            c = t - sum - y;
            sum = t;
        }
        if sum <= 0.0 {
            return Err(DiceError::error("pmfFromMap: probabilities sum to 0"));
        }

        filtered.sort_unstable_by_key(|(v, _)| *v);

        let mut internal = IndexMap::new();
        for (v, p) in filtered {
            internal.insert(
                v,
                Bin {
                    p: p / sum,
                    count: LabelMap::new(),
                    attr: None,
                },
            );
        }
        Ok(Pmf::new(internal, eps, false))
    }

    /// `PMF.empty(epsilon)`: identifier `"empty"`.
    pub fn empty(epsilon: f64) -> Pmf {
        Pmf::new(IndexMap::new(), epsilon, false).with_identifier("empty")
    }

    pub fn zero(epsilon: f64) -> Pmf {
        let mut map = IndexMap::new();
        map.insert(
            Damage(0.0),
            Bin {
                p: 1.0,
                count: LabelMap::from_iter([("miss".to_string(), 1.0)]),
                attr: Some(LabelMap::new()),
            },
        );
        Pmf::new(map, epsilon, false).with_identifier("zero")
    }

    /// `delta(value)`: `Err` where `PMF.fromMap` throws (a non-integer or non-finite value).
    pub fn delta(value: f64, epsilon: f64) -> Result<Pmf, DiceError> {
        let mut m = IndexMap::new();
        m.insert(Damage::from(value), 1.0);
        Pmf::from_map(m, epsilon, true)
    }

    pub fn miss_none(epsilon: f64) -> Pmf {
        let mut map = IndexMap::new();
        map.insert(
            Damage(0.0),
            Bin {
                p: 1.0,
                count: LabelMap::from_iter([("missNone".to_string(), 1.0)]),
                attr: Some(LabelMap::new()),
            },
        );
        Pmf::new(map, epsilon, false).with_identifier("missNone")
    }

    pub fn empty_mass() -> Pmf {
        Pmf::zero(crate::EPS).scale_mass(0.0)
    }
}
