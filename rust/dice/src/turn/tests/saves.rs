//! `tests/turn-saves.test.ts`: 9 tests, 0 compat calls (the fixture has no entries for this file).
//! The seven oracle-backed cases run against the oracle recordings of `oracle.rs`.
//!
//! Not translated:
//! - turn-saves.test.ts:88-91 (second half of "refuses ... a save that is neither shape"): the TS passes
//!   `{ dc: 10 }` without `bonus` through a cast; `GrantSaveSpec::Dc` has a required `bonus` and
//!   the other variant a required `fail_chance`, so a save of neither shape does not compile.

use super::cond_helpers::*;
use super::helpers::atk;
use super::helpers::{T, close};
use super::oracle::*;
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::effects::effect_spec;
use crate::turn::effects::{Lasting, advantage};
use crate::turn::types::{
    AttackTriggerOn, ConditionOn, EffectSpec, FailChance, GrantSaveSpec, GrantSaves, TurnSpec,
};
use std::sync::{Arc, Mutex};

const FILE: &str = "tests/turn-saves.test.ts";
const SUITE: &str = "saves: save-side effects and grant saves against the oracle";

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn expect(name: &str, synthetic: SyntheticTurn) -> T {
    expect_oracle(FILE, &format!("{SUITE} > {name}"), &synthetic, false)?;
    Ok(())
}

fn rows(grants: Vec<GrantDef>) -> SyntheticTurn {
    SyntheticTurn {
        attacks: vec![attack(), attack()],
        saves: Some(vec![save("dexterity"), save("wisdom")]),
        grants: Some(grants),
        ..SyntheticTurn::default()
    }
}

/// `onHit(extra)`: `grant({ of: [0, 1], ...extra })`.
fn on_hit() -> GrantDef {
    grant().of(&[0, 1])
}

#[test]
fn save_disadvantage_for_the_turn() -> T {
    expect(
        "save disadvantage for the turn",
        rows(vec![
            on_hit().effects(vec![effect("saveDisadvantage", None)]),
        ]),
    )
}

#[test]
fn save_disadvantage_until_the_next_save() -> T {
    expect(
        "save disadvantage until the next save",
        rows(vec![on_hit().effects(vec![effect(
            "saveDisadvantage",
            Some("next-save"),
        )])]),
    )
}

#[test]
fn frostbite_1d4_off_the_next_save_once_a_turn() -> T {
    expect(
        "Frostbite: 1d4 off the next save, once a turn",
        rows(vec![on_hit().once().effects(vec![save_penalty(
            1.0,
            4.0,
            Some("next-save"),
        )])]),
    )
}

#[test]
fn bane_like_penalty_for_the_turn_two_sources_stack() -> T {
    expect(
        "Bane-like penalty for the turn, two sources stack",
        rows(vec![
            on_hit()
                .of(&[0])
                .effects(vec![save_penalty(1.0, 4.0, None)]),
            on_hit()
                .of(&[1])
                .effects(vec![save_penalty(1.0, 6.0, None)]),
        ]),
    )
}

#[test]
fn save_effect_scoped_to_one_save_row() -> T {
    expect(
        "save effect scoped to one save row",
        rows(vec![
            on_hit().effects(vec![effect("saveDisadvantage", None).to(&[3])]),
        ]),
    )
}

#[test]
fn a_grant_save_with_dc_and_bonus_on_save_branch() -> T {
    expect(
        "a grant save with dc and bonus, onSave branch",
        rows(vec![
            on_hit()
                .save(constitution())
                .effects(vec![effect("advantage", Some("turn"))])
                .on_pass(vec![effect("advantage", Some("next-attack"))]),
        ]),
    )
}

#[test]
fn a_grant_save_reads_earlier_save_effects_and_the_target_picks_its_best_ability() -> T {
    expect(
        "a grant save reads earlier save effects, and the target picks its best ability",
        rows(vec![
            on_hit().of(&[0]).effects(vec![
                effect("saveDisadvantage", None),
                save_penalty(1.0, 4.0, None),
            ]),
            on_hit()
                .of(&[1])
                .save(dexterity().alternatives(vec![Alternative {
                    ability: "strength",
                    save_bonus: 1.0,
                }]))
                .effects(vec![effect("saveDisadvantage", None)]),
        ]),
    )
}

// ---- saves: grant saves as plain data ------------------------------------------------------------

fn grants() -> Vec<EffectSpec> {
    vec![effect_spec(&Lasting::from(advantage().until_end_of_turn()))]
}

#[test]
fn a_fail_chance_save_gets_the_targets_context_and_a_constant_one_equals_a_chance() -> T {
    let sword = || sword_5_12().map(atk);
    let with_chance = Turn::from_spec(
        TurnSpec {
            attacks: vec![sword()?, sword()?],
            conditions: Some(vec![crate::turn::types::ConditionSpec {
                of: Some(strings(&["attack 1"])),
                chance: Some(0.35),
                ..cspec(ConditionOn::Attack(AttackTriggerOn::FirstHit), grants())
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);
    let with_save = Turn::from_spec(
        TurnSpec {
            attacks: vec![sword()?, sword()?],
            conditions: Some(vec![crate::turn::types::ConditionSpec {
                of: Some(strings(&["attack 1"])),
                save: Some(GrantSaves::One(GrantSaveSpec::FailChance {
                    ability: None,
                    fail_chance: FailChance::new(move |context| {
                        recorder
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(context.roll_type.as_str().to_string());
                        Ok(0.35)
                    }),
                })),
                ..cspec(ConditionOn::Attack(AttackTriggerOn::FirstHit), grants())
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    close(with_save.mean()?, with_chance.mean()?, 12);
    assert!(
        seen.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&"flat".to_string())
    );
    Ok(())
}

#[test]
fn refuses_a_save_beside_a_chance_and_a_save_that_is_neither_shape() -> T {
    let refused = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword_5_12()?)],
            conditions: Some(vec![crate::turn::types::ConditionSpec {
                chance: Some(0.5),
                save: Some(GrantSaves::One(GrantSaveSpec::Dc {
                    ability: None,
                    dc: 10.0,
                    bonus: 0.0,
                    roll_type: None,
                })),
                ..cspec(ConditionOn::Attack(AttackTriggerOn::EveryHit), grants())
            }]),
            ..TurnSpec::default()
        },
        0.0,
    );
    match refused {
        Err(DiceError::Error(message)) => {
            assert!(message.contains("both a save and a chance"), "{message}");
        }
        Err(other) => panic!(
            "expected an Error, got {}: {}",
            other.name(),
            other.message()
        ),
        Ok(_) => panic!("expected the spec to be refused"),
    }
    Ok(())
}
