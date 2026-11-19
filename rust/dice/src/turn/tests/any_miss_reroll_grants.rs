//! `tests/turn-any-miss-reroll-grants.test.ts`: 4 tests, 4 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions, advantage};
use crate::turn::types::AttacksOptions;
use crate::turn::types::{RiderOptions, TurnSpecError, TurnSpecErrorCode};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/turn-any-miss-reroll-grants.test.ts";
const SUITE: &str = "an any-miss reroll and granted modifiers";

// d20+5 vs AC 12: miss 6/20, hit 13/20, crit 1/20; 1d8+3, 2d8+3 on a crit.
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?)
}

fn three() -> Result<Turn, DiceError> {
    let s = sword()?;
    turn(vec![atk(s.clone()), atk(s.clone()), atk(s)], 0.0)
}

fn eh_id(id: &str, chance: Option<f64>) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                rider: rid(id),
                chance,
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
        ..EveryHitOptions::default()
    }
}

fn error_of(
    build: impl FnOnce() -> Result<Turn, DiceError>,
) -> Result<Option<TurnSpecError>, DiceError> {
    match build().and_then(|t| t.mean()) {
        Ok(_) => Ok(None),
        Err(DiceError::TurnSpec(e)) => Ok(Some(*e)),
        Err(other) => Err(other),
    }
}

#[test]
fn refuses_a_reroll_that_would_read_a_grant_at_the_end_of_the_turn() -> T {
    let vex = error_of(|| {
        three()?
            .on_every_hit_with(advantage().until_next_attack(), eh_id("c", None))?
            .on_any_miss_with(sword()?, rid("rr"))
    })?
    .ok_or("no error")?;
    assert_eq!(vex.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert_eq!(vex.id, "rr");
    assert!(vex.message.contains("onFirstMiss"), "{}", vex.message);

    let topple = error_of(|| {
        three()?
            .on_every_hit_with(advantage().until_end_of_turn(), eh_id("c", Some(0.5)))?
            .on_any_miss_with(sword()?, rid("rr"))
    })?
    .ok_or("no error")?;
    assert_eq!(topple.code, TurnSpecErrorCode::UnsupportedTrigger);
    Ok(())
}

#[test]
fn refuses_a_reroll_whose_landing_would_apply_a_grant() -> T {
    let source = error_of(|| {
        three()?
            .on_any_miss_with(sword()?, rid("rr"))?
            .on_every_hit_with(
                advantage().until_next_attack().to(&["attack 3"]),
                EveryHitOptions::default(),
            )
    })?
    .ok_or("no error")?;
    assert_eq!(source.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert_eq!(source.id, "rr");
    Ok(())
}

#[test]
fn resolves_the_same_turns_exactly_as_first_miss_rerolls() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > resolves the same turns exactly as first-miss rerolls"),
    );
    let vex = three()?
        .on_every_hit_with(advantage().until_next_attack(), eh_id("c", None))?
        .on_first_miss_with(sword()?, rid("rr"))?;
    close(want.mean(&vex), 21493503.0 / 1000000.0, 12);
    let topple = three()?
        .on_every_hit_with(advantage().until_end_of_turn(), eh_id("c", Some(0.5)))?
        .on_first_miss_with(sword()?, rid("rr"))?;
    close(want.mean(&topple), 1681580259.0 / 80000000.0, 12);
    want.done();
    Ok(())
}

#[test]
fn accepts_an_any_miss_reroll_that_no_grant_reaches() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > accepts an any-miss reroll that no grant reaches"),
    );
    let scoped = turn(vec![], 0.0)?
        .attacks_with(
            3.0,
            sword()?,
            AttacksOptions {
                tag: Some("main".to_string()),
                chance: None,
            },
        )?
        .on_every_hit_with(
            advantage().until_next_attack().to(&["main"]),
            eh_id("c", None),
        )?
        .on_any_miss_with(
            sword()?,
            RiderOptions {
                id: Some("rr".to_string()),
                ..RiderOptions::default()
            },
        )?;
    close(want.mean(&scoped), 21493503.0 / 1000000.0, 12);
    close(want.fire(&scoped, "rr"), 42033.0 / 100000.0, 14);
    want.done();
    Ok(())
}
