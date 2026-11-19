//! `tests/turn-riders.test.ts`: 2 of 3 tests, 0 compat calls (the fixture records none).
//!
//! Not translated: tests/turn-riders.test.ts:67: "every case that needs a damage type dealt reads
//! its mean exactly and refuses its joint" drives the oracle suite (`FAMILIES` of
//! tests/oracle/v2/cases and `enumerateSyntheticTurn` of tests/oracle/bruteForce); neither is
//! ported to Rust.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::common::RollType;
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::context::{ContextualSource, RowCheck, RowContext, RowKind};
use crate::turn::types::{
    ArcContextual, DamageSource, Rider, RiderDamageSpec, Source, Trigger, TurnSpec,
};
use std::sync::{Arc, Mutex};

fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?)
}
fn with_d6() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?.add(&d6())?)
}

fn check() -> RowCheck {
    RowCheck {
        kind: RowKind::Attack,
        range: None,
        ability: None,
        roll_type: RollType::Flat,
        advantage_dice: 2,
        pinned: false,
        auto_hit: false,
        auto_crit: false,
        auto_fail: false,
    }
}

/// The row rolls the rider's d6 in its own damage when the rider joins it.
struct Row {
    seen: Mutex<Vec<Vec<String>>>,
}

impl ContextualSource for Row {
    fn row_check(&self) -> RowCheck {
        check()
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        if let Ok(mut seen) = self.seen.lock() {
            seen.push(context.joined.clone());
        }
        let source = if context.joined.iter().any(|j| j == "r") {
            with_d6()?
        } else {
            sword()?
        };
        source.to_pmf(eps)
    }
}

fn rider(damage: impl Into<crate::turn::types::RiderDamage>) -> Rider {
    Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: Some("r".to_string()),
        damage: RiderDamageSpec::Plain(damage.into()),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: Some(vec!["a".to_string()]),
        r#where: None,
        target_has: None,
    }
}

fn max_diff(a: &Pmf, b: &Pmf) -> f64 {
    let mut diff: f64 = 0.0;
    for d in a.support().iter().chain(b.support().iter()) {
        diff = diff.max((a.p_at(d.0) - b.p_at(d.0)).abs());
    }
    diff
}

#[test]
fn a_joining_rider_deals_nothing_beside_the_row_it_joins_whatever_its_damage_says_its_landing_still_counts()
-> T {
    let row = Arc::new(Row {
        seen: Mutex::new(Vec::new()),
    });
    // A plain PMF payload that is not zero: the library, not the payload, must keep it off the joined row.
    let payload = rs(1.0, 6.0)?.to_pmf(crate::EPS)?;
    let t = Turn::from_spec(
        TurnSpec {
            attacks: vec![named("a", Source::Contextual(ArcContextual(row.clone())))],
            riders: Some(vec![rider(DamageSource::Pmf(std::sync::Arc::new(payload)))]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    assert!(max_diff(&t.pmf()?, &with_d6()?.pmf()?) < 1e-12);
    assert_eq!(t.marginal("r")?.pmf().mean(), 0.0);
    close(t.fire_probability("r")?, 0.7, 12);
    let seen = row.seen.lock().map_err(err)?;
    assert!(seen.iter().any(|joined| joined.iter().any(|j| j == "r")));
    Ok(())
}

#[test]
fn on_a_row_it_does_not_join_it_deals_its_payload_as_ever() -> T {
    let row = Arc::new(Row {
        seen: Mutex::new(Vec::new()),
    });
    let t = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                named("a", Source::Contextual(ArcContextual(row))),
                named("b", sword()?),
            ],
            riders: Some(vec![rider(rs(1.0, 6.0)?)]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    // Attack a lands (0.7): the d6 is in a's roll. Otherwise b's hit lands the rider with its own
    // d6, doubled on b's crit.
    let expected = with_d6()?.mean()? + sword()?.mean()? + 0.3 * (0.65 * 3.5 + 0.05 * 7.0);
    assert!((t.mean()? - expected).abs() < 1e-12);
    Ok(())
}
