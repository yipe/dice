//! Port of `src/builder/d20.ts`. The PMF caches (`pmfCache`) are skipped.

use super::prob::d20_pmf_from_cdf;
use crate::error::DiceError;
use crate::{Damage, EPS, Pmf};
use indexmap::IndexMap;
use std::sync::Arc;

use crate::pmf::cache::PMF_CACHE;

pub use crate::common::RollType;

/// `d20RollPMF`: lift a single d20 PMF into advantage, disadvantage, or elven (triple-advantage).
/// `None` reads as `"flat"`. `Err` where `PMF.fromMap` throws (never for a valid d20).
pub fn d20_roll_pmf(roll_type: Option<RollType>, reroll_one: bool) -> Result<Pmf, DiceError> {
    d20_roll_pmf_shared(roll_type, reroll_one).map(|p| (*p).clone())
}

/// [`d20_roll_pmf`] through `pmfCache`, keyed `d20`, `hd20`, `d20 > d20`, ... as `cacheKeyMap` spells them.
pub fn d20_roll_pmf_shared(
    roll_type: Option<RollType>,
    reroll_one: bool,
) -> Result<Arc<Pmf>, DiceError> {
    let roll_type = roll_type.unwrap_or(RollType::Flat);
    let d = if reroll_one { "hd20" } else { "d20" };
    let key = match roll_type {
        RollType::Flat => d.to_string(),
        RollType::Advantage => format!("{d} > {d}"),
        RollType::Disadvantage => format!("{d} < {d}"),
        RollType::ElvenAccuracy => format!("{d} > {d} > {d}"),
    };
    PMF_CACHE.get_or_compute_arc(Some(&key), || {
        let base = d20_pmf_shared(reroll_one)?;
        if roll_type == RollType::Flat {
            return Ok(base);
        }
        lift_roll_type(&base, roll_type).map(Arc::new)
    })
}

fn lift_roll_type(base: &Pmf, roll_type: RollType) -> Result<Pmf, DiceError> {
    let mut p = [0.0f64; 21]; // indices 1..20
    for (r, rec) in &base.map {
        if r.0 >= 1.0 && r.0 <= 20.0 && r.0.fract() == 0.0 {
            p[r.0 as usize] = rec.p;
        }
    }
    let mut f = [0.0f64; 21];
    for k in 1..=20 {
        f[k] = f[k - 1] + p[k];
    }

    let eps = 0.0;
    match roll_type {
        RollType::Advantage => d20_pmf_from_cdf(|k| f[k].powf(2.0), eps),
        RollType::ElvenAccuracy => d20_pmf_from_cdf(|k| f[k].powf(3.0), eps),
        RollType::Disadvantage => d20_pmf_from_cdf(|k| 1.0 - (1.0 - f[k]).powf(2.0), eps),
        RollType::Flat => Ok(base.clone()),
    }
}

/// `d20PMF`: one d20, or a halfling's (reroll a 1 once).
pub fn d20_pmf(reroll_one: bool) -> Result<Pmf, DiceError> {
    d20_pmf_shared(reroll_one).map(|p| (*p).clone())
}

/// [`d20_pmf`] through `pmfCache` (key `flat-flat` / `flat-reroll`).
pub fn d20_pmf_shared(reroll_one: bool) -> Result<Arc<Pmf>, DiceError> {
    let key = format!("flat-{}", if reroll_one { "reroll" } else { "flat" });
    PMF_CACHE.get_or_compute(Some(&key), || build_d20_pmf(reroll_one))
}

fn build_d20_pmf(reroll_one: bool) -> Result<Pmf, DiceError> {
    let mut m: IndexMap<Damage, f64> = IndexMap::new();
    let base = 1.0 / 20.0;
    let reroll_share = base * base;
    for r in 1..=20 {
        if !reroll_one {
            m.insert(Damage(f64::from(r)), base);
        } else {
            m.insert(
                Damage(f64::from(r)),
                (if r == 1 { 0.0 } else { base }) + reroll_share,
            );
        }
    }
    Pmf::from_map(m, EPS, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    fn pmf(rt: Option<RollType>, halfling: bool) -> Result<Pmf, DiceError> {
        d20_roll_pmf(rt, halfling)
    }

    #[test]
    fn d20_single_normal() -> Result<(), DiceError> {
        let p = d20_pmf(false)?;
        assert_eq!(p.support().len(), 20);
        for i in 1..=20 {
            assert!(close(p.p_at(f64::from(i)), 0.05, 2));
        }
        assert!(close(p.mean(), 10.5, 2));
        Ok(())
    }

    #[test]
    fn d20_single_halfling() -> Result<(), DiceError> {
        let p = d20_pmf(true)?;
        assert_eq!(p.support().len(), 20);
        assert!(close(p.p_at(1.0), 1.0 / 400.0, 2));
        for i in 2..=20 {
            assert!(close(p.p_at(f64::from(i)), 21.0 / 400.0, 2));
        }
        assert!(close(p.mean(), 10.975, 2));
        Ok(())
    }

    #[test]
    fn flat_and_undefined() -> Result<(), DiceError> {
        let single = d20_pmf(false)?;
        assert_eq!(pmf(Some(RollType::Flat), false)?.map, single.map);
        assert_eq!(pmf(None, false)?.map, single.map);
        Ok(())
    }

    #[test]
    fn advantage() -> Result<(), DiceError> {
        let p = pmf(Some(RollType::Advantage), false)?;
        assert!(close(p.p_at(1.0), 0.0025, 2));
        assert!(close(p.p_at(20.0), 0.0975, 2));
        assert!(close(p.mean(), 13.825, 2));
        Ok(())
    }

    #[test]
    fn disadvantage() -> Result<(), DiceError> {
        let p = pmf(Some(RollType::Disadvantage), false)?;
        assert!(close(p.p_at(1.0), 0.0975, 2));
        assert!(close(p.p_at(20.0), 0.0025, 2));
        assert!(close(p.mean(), 7.175, 2));
        Ok(())
    }

    #[test]
    fn elven_accuracy() -> Result<(), DiceError> {
        let p = pmf(Some(RollType::ElvenAccuracy), false)?;
        assert!(close(p.p_at(1.0), 1.0 / 8000.0, 2));
        assert!(close(p.p_at(20.0), 1.0 - (19.0f64 / 20.0).powi(3), 2));
        assert!(close(p.mean(), 15.4875, 2));
        Ok(())
    }

    #[test]
    fn same_pmf_twice_and_differs_by_reroll() -> Result<(), DiceError> {
        let a = pmf(Some(RollType::Advantage), false)?;
        let b = d20_roll_pmf(Some(RollType::Advantage), false)?;
        let other = d20_roll_pmf(Some(RollType::Advantage), true)?;
        assert_eq!(a.map, b.map);
        assert_ne!(a.map, other.map);
        Ok(())
    }

    #[test]
    fn halfling_flat_advantage_disadvantage() -> Result<(), DiceError> {
        let single = d20_pmf(true)?;
        assert_eq!(pmf(Some(RollType::Flat), true)?.map, single.map);
        let normal = pmf(Some(RollType::Flat), true)?.mean();
        let adv = pmf(Some(RollType::Advantage), true)?.mean();
        assert!(adv > normal);
        assert!(close(adv, 14.1420625, 5));
        let dis = pmf(Some(RollType::Disadvantage), true)?.mean();
        assert!(dis < normal);
        assert!(close(dis, 7.8079375, 2));
        Ok(())
    }

    #[test]
    fn halfling_elven_accuracy() -> Result<(), DiceError> {
        let p = pmf(Some(RollType::ElvenAccuracy), true)?;
        let parsed =
            crate::parser::parse_with("(d20 reroll 1) > (d20 reroll 1) > (d20 reroll 1)", 0.0)?;
        let normal = pmf(Some(RollType::Flat), true)?.mean();
        assert!(p.mean() > normal);
        assert!(close(p.mean(), 15.72497, 2));
        assert!(close(p.mean(), parsed.mean(), 5));
        Ok(())
    }

    #[test]
    fn roll_type_strings_round_trip() {
        for rt in [
            RollType::Flat,
            RollType::Advantage,
            RollType::Disadvantage,
            RollType::ElvenAccuracy,
        ] {
            assert_eq!(RollType::parse(rt.as_str()), Some(rt));
        }
        assert_eq!(RollType::parse("normal"), None);
    }
}
