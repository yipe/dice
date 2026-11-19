//! Shared helpers of the translated turn tests.

use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;
use crate::turn::compat;
use crate::turn::types::{Attack, AttackOptions, DamageSource, Source, TurnSpecErrorCode};
use crate::turn::{StepStats, Turn};
use serde_json::{Value, json};

pub type T = Result<(), Box<dyn std::error::Error>>;

/// `expect(actual).toBeCloseTo(expected, digits)`.
#[track_caller]
pub fn close(actual: f64, expected: f64, digits: i32) {
    let tolerance = 10f64.powi(-digits) / 2.0;
    assert!(
        (actual - expected).abs() < tolerance,
        "expected {actual} to be close to {expected} ({digits} digits)"
    );
}

/// `d20.plus(bonus).ac(ac).onHit("expr")`.
pub fn attack_expr(bonus: f64, ac: f64, expr: &str) -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(bonus)?
        .ac(ac)?
        .on_hit_args(&[Arg::Str(expr.to_string())])
}

/// `d20.plus(bonus).ac(ac).onHit(damage)`.
pub fn attack_roll(bonus: f64, ac: f64, damage: RollBuilder) -> Result<AttackBuilder, DiceError> {
    d20().plus(bonus)?.ac(ac)?.on_hit(damage)
}

/// `roll(count, sides)`.
pub fn rs(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

/// A bare attack.
pub fn atk(source: impl Into<Source>) -> Attack {
    Attack::Bare(source.into())
}

/// `{ id, source }`.
pub fn named(id: &str, source: impl Into<Source>) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

pub fn damage(roll: RollBuilder) -> DamageSource {
    DamageSource::Roll(roll)
}

pub fn pmf_damage(pmf: Pmf) -> DamageSource {
    DamageSource::Pmf(std::sync::Arc::new(pmf))
}

/// The `code` of a refused call (`TurnSpecError.code`); `String(error)` for another kind.
pub fn code_of<X>(result: Result<X, DiceError>) -> String {
    match result {
        Ok(_) => "none".to_string(),
        Err(DiceError::TurnSpec(e)) => e.code.as_str().to_string(),
        Err(other) => format!("{}: {}", other.name(), other.message()),
    }
}

/// The `TurnSpecErrorCode` of a refused call.
#[track_caller]
pub fn spec_code<X>(result: Result<X, DiceError>) -> TurnSpecErrorCode {
    match result {
        Err(DiceError::TurnSpec(e)) => e.code,
        Err(other) => panic!("expected a TurnSpecError, got {other:?}"),
        Ok(_) => panic!("expected a TurnSpecError, the call succeeded"),
    }
}

/// A `Value` list of arguments for `Expected::check`.
pub fn args(ids: &[&str]) -> Vec<Value> {
    ids.iter().map(|id| json!(id)).collect()
}

/// `compat::expect(file, "{suite} > {test}")` (the vitest full name below the file).
pub fn expect(file: &str, test: &str) -> compat::Expected {
    compat::expect(file, test)
}

/// The turn readers the compat recorder wraps, called and checked in one step against the next
/// recorded call of the test. Each returns what the reader returned.
pub trait Reads {
    fn pmf(&mut self, turn: &Turn) -> Pmf;
    fn mean(&mut self, turn: &Turn) -> f64;
    fn fire(&mut self, turn: &Turn, id: &str) -> f64;
    fn applications(&mut self, turn: &Turn, id: &str) -> f64;
    fn query(&mut self, turn: &Turn);
    fn step_stats(&mut self, turn: &Turn, id: &str) -> StepStats;
}

impl Reads for compat::Expected {
    #[track_caller]
    fn pmf(&mut self, turn: &Turn) -> Pmf {
        let pmf = turn.pmf().expect("pmf");
        self.check("pmf", &[], compat::pmf(&pmf));
        pmf
    }

    #[track_caller]
    fn mean(&mut self, turn: &Turn) -> f64 {
        let mean = turn.mean().expect("mean");
        self.check("mean", &[], compat::number(mean));
        mean
    }

    #[track_caller]
    fn fire(&mut self, turn: &Turn, id: &str) -> f64 {
        let p = turn.fire_probability(id).expect("fireProbability");
        self.check("fireProbability", &args(&[id]), compat::number(p));
        p
    }

    #[track_caller]
    fn applications(&mut self, turn: &Turn, id: &str) -> f64 {
        let p = turn
            .expected_applications(id)
            .expect("expectedApplications");
        self.check("expectedApplications", &args(&[id]), compat::number(p));
        p
    }

    #[track_caller]
    fn query(&mut self, turn: &Turn) {
        let query = turn.to_query().expect("toQuery");
        let singles: Vec<Value> = query.singles.iter().map(compat::pmf).collect();
        self.check("toQuery", &[], Value::Array(singles));
    }

    #[track_caller]
    fn step_stats(&mut self, turn: &Turn, id: &str) -> StepStats {
        let stats = turn.step_stats(id).expect("stepStats");
        let value = json!({
            "rolled": compat::hex(stats.rolled),
            "hit": compat::hex(stats.hit),
            "crit": compat::hex(stats.crit),
            "live": {
                "advantage": compat::hex(stats.live.advantage()),
                "disadvantage": compat::hex(stats.live.disadvantage()),
                "critOnHit": compat::hex(stats.live.crit_on_hit()),
            },
        });
        self.check("stepStats", &args(&[id]), value);
        stats
    }
}

pub fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
pub fn pe(e: DiceError) -> String {
    format!("{}: {}", e.name(), e.message())
}

// ---- option constructors (the TS object literals) ------------------------------------------------

use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions};
use crate::turn::types::RiderOptions;

/// `{ id }` for `onAnyMiss` / `onFirstMiss` / `otherwise` / `onDiceMatch`.
pub fn rid(id: &str) -> RiderOptions {
    RiderOptions {
        id: Some(id.to_string()),
        ..RiderOptions::default()
    }
}

/// `{ id }` for `onAnyCrit` / `onFirstCrit`.
pub fn cond_id(id: &str) -> ConditionOptions {
    ConditionOptions {
        rider: rid(id),
        ..ConditionOptions::default()
    }
}

/// `{ id }` for `onFirstHit`.
pub fn first_hit_id(id: &str) -> FirstHitOptions {
    FirstHitOptions {
        condition: cond_id(id),
        ..FirstHitOptions::default()
    }
}

/// `{ id, max }` for `onEveryHit` (either optional).
pub fn every_hit(id: Option<&str>, max: Option<f64>) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    id: id.map(str::to_string),
                    ..RiderOptions::default()
                },
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
        max,
    }
}
