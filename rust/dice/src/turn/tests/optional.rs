//! `tests/turn-optional.test.ts`: 15 tests (the 13 per-condition-rule ones are one loop), 3 Rust
//! tests, 0 compat calls (the fixture has no entries for this file).

use super::cond_helpers::*;
use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::{AttackBuilder, ConditionGate, Grants};
use crate::builder::factory::*;
use crate::builder::types::RollType as CheckRollType;
use crate::dnd5e::{prone, rules};
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::context::{ContextualSource, RollType, RowCheck, RowContext, RowKind, RowRange};
use crate::turn::effects::{TriggerSave, TriggerSaves};
use crate::turn::types::{
    ArcContextual, Attack, AttackOptions, AttackTriggerOn, ConditionOn, ConditionRule,
    ConditionSpec, ConditionUntil, EffectSpec, Source, TurnSpec,
};
use std::sync::Arc;

fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 14.0, rs(1.0, 8.0)?.plus(3.0)?)
}

/// `{ rowCheck: check(range), under: (context) => sword at the context's roll type }`.
struct Row(RowRange);

impl ContextualSource for Row {
    fn row_check(&self) -> RowCheck {
        RowCheck {
            kind: RowKind::Attack,
            range: Some(self.0),
            ability: None,
            roll_type: RollType::Flat,
            advantage_dice: 2,
            pinned: false,
            auto_hit: false,
            auto_crit: false,
            auto_fail: false,
        }
    }

    fn under(&self, context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        let at = |roll_type: CheckRollType| -> Result<Pmf, DiceError> {
            sword()?
                .with_check(|mut base| {
                    base.roll_type = roll_type;
                    base
                })?
                .pmf()
        };
        match context.roll_type {
            RollType::Advantage => at(CheckRollType::Advantage),
            RollType::Disadvantage => at(CheckRollType::Disadvantage),
            _ => sword()?.pmf(),
        }
    }
}

fn row(range: RowRange) -> Source {
    Source::Contextual(ArcContextual(Arc::new(Row(range))))
}

fn named_row(id: &str, range: RowRange) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            ..AttackOptions::default()
        },
        source: row(range),
    }
}

fn condition_effect(name: &str, rule: &ConditionRule) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.to_string(),
        rule: rule.clone(),
        until: ConditionUntil::EndOfTurn,
    }
}

fn optional_condition(id: &str, of: &str, grant: EffectSpec) -> ConditionSpec {
    ConditionSpec {
        id: Some(id.to_string()),
        of: Some(vec![of.to_string()]),
        optional: true,
        ..cspec(ConditionOn::Attack(AttackTriggerOn::EveryHit), vec![grant])
    }
}

/// The engine's fallback, restated: melee readers after the first source at least match ranged ones.
fn engine_leans(ranges: &[RowRange], first: usize) -> bool {
    let later = &ranges[first + 1..];
    later.iter().filter(|&&r| r == RowRange::Melee).count()
        >= later.iter().filter(|&&r| r == RowRange::Ranged).count()
}

#[test]
fn past_the_search_each_of_four_optional_conditions_is_attempted_exactly_where_the_engine_attempts_it()
-> T {
    use RowRange::{Melee as M, Ranged as R};
    let layouts: [[RowRange; 6]; 3] = [[M, M, R, M, R, R], [R, M, R, R, R, M], [M, R, M, M, M, R]];
    for (name, rule) in rules() {
        for ranges in &layouts {
            let spec = TurnSpec {
                attacks: ranges
                    .iter()
                    .enumerate()
                    .map(|(i, &range)| named_row(&format!("a{i}"), range))
                    .collect(),
                conditions: Some(
                    (0..4)
                        .map(|first| {
                            optional_condition(
                                &format!("c{first}"),
                                &format!("a{first}"),
                                condition_effect(name, &rule),
                            )
                        })
                        .collect(),
                ),
                ..TurnSpec::default()
            };
            let t = Turn::from_spec(spec, 0.0)?;
            for first in 0..4 {
                let attempted = t.attempt_probability(&format!("c{first}"))? > 0.0;
                assert_eq!(
                    attempted,
                    engine_leans(ranges, first),
                    "{name} {ranges:?} c{first}"
                );
            }
        }
    }
    Ok(())
}

#[test]
fn within_the_search_a_prone_that_only_ranged_attacks_follow_is_declined_one_melee_attacks_follow_is_taken()
-> T {
    let prone_rule = crate::dnd5e::rule(crate::dnd5e::ConditionName::Prone).unwrap_or_default();
    let prone_effect = || condition_effect("prone", &prone_rule);
    let ranged = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                named_row("a", RowRange::Melee),
                named_row("b", RowRange::Ranged),
            ],
            conditions: Some(vec![optional_condition("c", "a", prone_effect())]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    assert_eq!(ranged.fire_probability("c")?, 0.0);
    let melee = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                named_row("a", RowRange::Melee),
                named_row("b", RowRange::Melee),
            ],
            conditions: Some(vec![optional_condition("c", "a", prone_effect())]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    close(melee.fire_probability("c")?, 0.6, 12); // d20 + 5 vs AC 14 lands on 9..20
    Ok(())
}

#[test]
fn optional_conditions_attached_to_a_source_are_searched_like_the_turns_own() -> T {
    let sword = d20()
        .plus(8.0)?
        .ac(16.0)?
        .melee()?
        .on_hit(d8().plus(4.0)?)?;
    let bow = d20()
        .plus(8.0)?
        .ac(16.0)?
        .ranged()?
        .on_hit(d8().plus(4.0)?)?;
    let save = d20().plus(2.0)?.dc(15.0)?;
    let prone_rule = crate::dnd5e::rule(crate::dnd5e::ConditionName::Prone).unwrap_or_default();
    let attached = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                atk(sword.on_every_hit_with(
                    Grants::One(prone().until_end_of_turn()),
                    Some(ConditionGate {
                        save: Some(TriggerSaves::One(TriggerSave::Dc(save.clone()))),
                        optional: true,
                        ..ConditionGate::default()
                    }),
                )?),
                atk(bow.clone()),
                atk(bow.clone()),
            ],
            ..TurnSpec::default()
        },
        0.0,
    )?;
    // A DC check's PMF puts a failed save at 1: d20 + 2 vs DC 15 fails on 1..12.
    let fail = save.pmf()?.p_at(1.0);
    close(fail, 0.6, 12);
    let gate = |optional: bool| -> Result<Turn, DiceError> {
        Turn::from_spec(
            TurnSpec {
                attacks: vec![atk(sword.clone()), atk(bow.clone()), atk(bow.clone())],
                conditions: Some(vec![ConditionSpec {
                    of: Some(strings(&["attack 1"])),
                    chance: Some(fail),
                    optional,
                    ..cspec(
                        ConditionOn::Attack(AttackTriggerOn::EveryHit),
                        vec![condition_effect("prone", &prone_rule)],
                    )
                }]),
                ..TurnSpec::default()
            },
            0.0,
        )
    };
    let plain = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword.clone()), atk(bow.clone()), atk(bow.clone())],
            ..TurnSpec::default()
        },
        0.0,
    )?;
    close(attached.mean()?, plain.mean()?, 12);
    close(gate(true)?.mean()?, plain.mean()?, 12);
    // Forced on, the Prone costs the bows: the search above declined something that mattered.
    assert!(gate(false)?.mean()? < plain.mean()? - 0.1);
    Ok(())
}
