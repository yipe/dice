//! Shared helpers for the translated `buildPlan` tests: spec constructors and error readers.
//! (`Turn.from(spec)` in the TS tests is [`plan_of`] here: it validates the spec through
//! `buildPlan`, which is where every `TurnSpecError` is raised.)

use super::{FoldMode, TurnPlan, build_plan};
use crate::EPS;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::error::DiceError;
use crate::turn::types::{
    Attack, AttackOptions, DamageSource, Rider, RiderDamage, RiderDamageSpec, Source, Trigger,
    TurnSpec, TurnSpecErrorCode,
};
use std::collections::HashSet;

pub type T = Result<(), DiceError>;

/// `roll(count, sides)`.
pub fn rs(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

/// `d20.plus(bonus).ac(ac).onHit(damage)`.
pub fn attack_of(bonus: f64, ac: f64, damage: RollBuilder) -> Result<AttackBuilder, DiceError> {
    d20().plus(bonus)?.ac(ac)?.on_hit(damage)
}

/// `const dagger = d20.plus(8).ac(16).onHit(d4.plus(4))` (tests/turn-validation.test.ts).
pub fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_of(8.0, 16.0, d4().plus(4.0)?)
}

/// `{ id, source }`.
pub fn attack_id(id: &str, source: impl Into<Source>) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

/// A bare attack (`attack N`).
pub fn bare(source: impl Into<Source>) -> Attack {
    Attack::Bare(source.into())
}

/// A rider with `trigger` and one plain payload.
pub fn rider(trigger: Trigger, damage: impl Into<DamageSource>) -> Rider {
    Rider {
        trigger,
        id: None,
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage.into())),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

/// [`rider`] with an id.
pub fn rider_id(id: &str, trigger: Trigger, damage: impl Into<DamageSource>) -> Rider {
    Rider {
        id: Some(id.to_string()),
        ..rider(trigger, damage)
    }
}

/// `on: "first-hit"` with an optional `of`.
pub fn first_hit(of: Option<&[&str]>) -> Trigger {
    Trigger::FirstHit {
        of: names(of),
        per_source: None,
    }
}

/// `on: "every-hit"` with an optional `of`.
pub fn every_hit(of: Option<&[&str]>) -> Trigger {
    Trigger::EveryHit {
        of: names(of),
        max: None,
        per_source: None,
    }
}

/// `on: "any-crit"` with an optional `of`.
pub fn any_crit(of: Option<&[&str]>) -> Trigger {
    Trigger::AnyCrit {
        of: names(of),
        max: None,
    }
}

/// `on: "any-miss"` with an optional `of`.
pub fn any_miss(of: Option<&[&str]>) -> Trigger {
    Trigger::AnyMiss { of: names(of) }
}

/// `on: "first-miss"` with an optional `of`.
pub fn first_miss(of: Option<&[&str]>) -> Trigger {
    Trigger::FirstMiss { of: names(of) }
}

/// `on: "not-fired", of`.
pub fn not_fired(of: &str) -> Trigger {
    Trigger::NotFired { of: of.to_string() }
}

/// `on: "dice-match", of`.
pub fn dice_match(of: &[&str]) -> Trigger {
    Trigger::DiceMatch {
        of: of.iter().map(std::string::ToString::to_string).collect(),
    }
}

fn names(of: Option<&[&str]>) -> Option<Vec<String>> {
    of.map(|list| list.iter().map(std::string::ToString::to_string).collect())
}

/// A spec of attacks and riders.
pub fn spec(attacks: Vec<Attack>, riders: Vec<Rider>) -> TurnSpec {
    TurnSpec {
        attacks,
        riders: if riders.is_empty() {
            None
        } else {
            Some(riders)
        },
        ..TurnSpec::default()
    }
}

/// `Turn.from(spec)` as far as validation goes: `buildPlan` at `EPS` with the masses folds (what
/// `Turn` builds its first plan with) and nothing declined.
pub fn plan_of(spec: &TurnSpec) -> Result<TurnPlan, DiceError> {
    build_plan(spec, EPS, &HashSet::new(), FoldMode::Masses)
}

/// `buildPlan(spec, eps, new Set(declined), folds)`.
pub fn plan_with(
    spec: &TurnSpec,
    eps: f64,
    declined: &[&str],
    folds: FoldMode,
) -> Result<TurnPlan, DiceError> {
    let declined: HashSet<String> = declined
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    build_plan(spec, eps, &declined, folds)
}

/// The `TurnSpecErrorCode` of a refusal (`codeOf` in the TS tests): fails the test where the build
/// was accepted or raised another kind of error.
#[track_caller]
pub fn code_of(result: Result<TurnPlan, DiceError>) -> TurnSpecErrorCode {
    match result {
        Err(DiceError::TurnSpec(e)) => e.code,
        Err(other) => panic!("expected a TurnSpecError, got {other:?}"),
        Ok(_) => panic!("expected a TurnSpecError, the plan was built"),
    }
}

/// The whole `TurnSpecError` of a refusal.
#[track_caller]
pub fn refusal(result: Result<TurnPlan, DiceError>) -> crate::turn::types::TurnSpecError {
    match result {
        Err(DiceError::TurnSpec(e)) => *e,
        Err(other) => panic!("expected a TurnSpecError, got {other:?}"),
        Ok(_) => panic!("expected a TurnSpecError, the plan was built"),
    }
}

/// The error of a build that is not a `TurnSpecError` (a `RangeError` or `Error`).
#[track_caller]
pub fn other_error(result: Result<TurnPlan, DiceError>) -> DiceError {
    match result {
        Err(DiceError::TurnSpec(e)) => panic!("expected a plain error, got TurnSpecError {e:?}"),
        Err(e) => e,
        Ok(_) => panic!("expected an error, the plan was built"),
    }
}
