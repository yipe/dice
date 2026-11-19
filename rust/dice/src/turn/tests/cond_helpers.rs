//! Shared by the condition-family tests (`conditions`, `flags`, `turn_conditions`, `creatures`,
//! `optional`, `saves`): option constructors, a PMF distance and the TS `not.toBeCloseTo`.

use super::helpers::attack_roll;
use super::helpers::rs;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions};
use crate::turn::types::{ConditionOn, ConditionSpec, EffectSpec, RiderOptions};
use std::collections::BTreeMap;

/// `{ id, of, chance }` of a condition verb's options (each optional).
pub fn opts(id: Option<&str>, of: Option<&[&str]>, chance: Option<f64>) -> ConditionOptions {
    ConditionOptions {
        rider: RiderOptions {
            id: id.map(str::to_string),
            of: of.map(|list| list.iter().map(|s| (*s).to_string()).collect()),
            ..RiderOptions::default()
        },
        chance,
        ..ConditionOptions::default()
    }
}

/// `{ of }`.
pub fn of(list: &[&str]) -> ConditionOptions {
    opts(None, Some(list), None)
}

/// `{ chance }`.
pub fn chance(p: f64) -> ConditionOptions {
    opts(None, None, Some(p))
}

/// Condition options as an `onFirstHit` options value.
pub fn first(condition: ConditionOptions) -> FirstHitOptions {
    FirstHitOptions {
        condition,
        per_source: None,
    }
}

/// Condition options as an `onEveryHit` options value.
pub fn every(condition: ConditionOptions) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: first(condition),
        max: None,
    }
}

/// A `ConditionSpec` with the given trigger and grants and nothing else.
pub fn cspec(on: ConditionOn, grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: None,
        on,
        of: None,
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants,
        on_save: None,
        optional: false,
    }
}

/// `list.map(String)`.
pub fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

/// `d20.plus(5).ac(12).onHit(roll(1, d8).plus(3))`: the oracle sword of most condition tests.
pub fn sword_5_12() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?)
}

/// The largest per-value difference of two PMFs (`pmfMaxDiff`).
pub fn pmf_max_diff(actual: &Pmf, expected: &Pmf) -> f64 {
    let mut support: BTreeMap<u64, f64> = BTreeMap::new();
    for value in actual.support().into_iter().chain(expected.support()) {
        support.insert(value.0.to_bits(), value.0);
    }
    support.values().fold(0.0, |worst, &value| {
        f64::max(worst, (actual.p_at(value) - expected.p_at(value)).abs())
    })
}

/// `expect(actual).not.toBeCloseTo(expected, digits)`.
#[track_caller]
pub fn far(actual: f64, expected: f64, digits: i32) {
    let tolerance = 10f64.powi(-digits) / 2.0;
    assert!(
        (actual - expected).abs() >= tolerance,
        "expected {actual} not to be close to {expected} ({digits} digits)"
    );
}

/// A rider of one plain roll: `{ id?, on, of?, damage }`.
pub fn rider_of(
    trigger: crate::turn::types::Trigger,
    id: Option<&str>,
    damage: crate::builder::roll::RollBuilder,
) -> crate::turn::types::Rider {
    use crate::turn::types::{DamageSource, Rider, RiderDamage, RiderDamageSpec};
    Rider {
        trigger,
        id: id.map(str::to_string),
        damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Roll(damage))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}
