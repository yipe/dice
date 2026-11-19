//! `tests/turn-conditions.test.ts`: 8 tests, 0 compat calls (the fixture has no entries for this
//! file). The six oracle-backed cases (five tables entries and the Sneak Attack one) run against
//! the oracle recordings of `oracle.rs`.

use super::cond_helpers::*;
use super::helpers::*;
use super::oracle::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::dnd5e::{ConditionName, rule};
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::context::{ContextualSource, RollType, RowCheck, RowContext, RowKind, RowRange};
use crate::turn::types::{
    ArcContextual, Attack, AttackTriggerOn, ConditionOn, ConditionSpec, ConditionUntil, EffectSpec,
    GrantSaveSpec, GrantSaves, Source, TurnSpec,
};
use std::sync::Arc;

const FILE: &str = "tests/turn-conditions.test.ts";

fn knock_out() -> Effect {
    until_damaged("unconscious")
}

mod against_the_oracle {
    use super::*;

    const SUITE: &str = "conditions: conditions against the oracle";

    #[allow(
        clippy::needless_pass_by_value,
        reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
    )]
    fn expect(name: &str, synthetic: SyntheticTurn) -> T {
        expect_oracle(FILE, &format!("{SUITE} > {name}"), &synthetic, true)?;
        Ok(())
    }

    #[test]
    fn prone_on_a_failed_strength_save_melee_advantage_ranged_disadvantage() -> T {
        expect(
            "Prone on a failed Strength save: melee advantage, ranged disadvantage",
            SyntheticTurn {
                attacks: vec![attack(), attack(), attack().ranged(), attack()],
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .save(strength())
                        .effects(vec![condition("prone")]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn stunned_fails_a_dexterity_save_restrained_gives_it_disadvantage() -> T {
        expect(
            "Stunned fails a Dexterity save, Restrained gives it disadvantage",
            SyntheticTurn {
                attacks: vec![attack(), attack()],
                saves: Some(vec![save("dexterity"), save("constitution")]),
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .save(constitution())
                        .effects(vec![condition("stunned")]),
                    grant().of(&[1]).effects(vec![condition("restrained")]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn the_grants_own_save_picks_the_ability_its_conditions_spare() -> T {
        expect(
            "the grant's own save picks the ability its conditions spare",
            SyntheticTurn {
                attacks: vec![attack(), attack(), attack()],
                grants: Some(vec![
                    grant().of(&[0]).effects(vec![condition("restrained")]),
                    grant()
                        .of(&[1])
                        .save(dexterity().alternatives(vec![Alternative {
                            ability: "strength",
                            save_bonus: 0.0,
                        }]))
                        .effects(vec![condition("prone")]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn knock_out_unconscious_until_damaged_then_prone_for_the_turn() -> T {
        expect(
            "Knock Out: Unconscious until damaged, then Prone for the turn",
            SyntheticTurn {
                attacks: vec![attack(), attack(), attack().ranged(), attack()],
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .once()
                        .save(constitution())
                        .effects(vec![knock_out()]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn optional_topple_taken_only_where_it_raises_the_mean() -> T {
        expect(
            "optional Topple: taken only where it raises the mean",
            SyntheticTurn {
                attacks: vec![attack(), attack().ranged(), attack().ranged()],
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .optional()
                        .save(strength())
                        .effects(vec![condition("prone")]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }
}

#[test]
fn a_sneak_attack_landing_on_a_hit_that_deals_nothing_ends_unconscious_there() -> T {
    let test = "conditions: a rider wakes the creature on the row it lands on > a Sneak Attack landing on a hit that deals nothing ends Unconscious there";
    let synthetic = SyntheticTurn {
        attacks: vec![
            attack(),
            attack().damage(dice(1.0, 4.0, Some(-4.0), true)),
            attack(),
        ],
        grants: Some(vec![grant().of(&[0]).effects(vec![knock_out()])]),
        riders: Some(vec![sneak(&[1, 2])]),
        ..SyntheticTurn::default()
    };
    let oracle = check_oracle(FILE, test, &synthetic);
    // The rider's payload as a plain builder (the oracle's 2d6, doubled on a crit).
    let spec = turn_to_spec(&synthetic, Some(rs(2.0, 6.0)?))?;
    let t = Turn::from_spec(spec, 0.0)?;
    assert!(worst(&t.pmf()?, &oracle.pmf) <= TOLERANCE);
    for (k, expected) in oracle.sources.iter().enumerate() {
        assert!(
            worst(t.marginal(&row_id(k))?.pmf(), expected) <= TOLERANCE,
            "row {k}"
        );
    }
    assert!(worst(t.marginal(&rider_id(0))?.pmf(), &oracle.riders[0]) <= TOLERANCE);
    Ok(())
}

// ---- conditions: the rule error codes ------------------------------------------------------------

fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    sword_5_12()
}

fn fireball() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])
}

/// `{ rowCheck: rowCheck(extra), under: () => ... }`: a row that declares its facts and rolls a
/// fixed PMF.
struct Row {
    check: RowCheck,
    pmf: Pmf,
}

impl ContextualSource for Row {
    fn row_check(&self) -> RowCheck {
        self.check.clone()
    }

    fn under(&self, _context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        Ok(self.pmf.clone())
    }
}

fn row_check(edit: impl FnOnce(&mut RowCheck)) -> RowCheck {
    let mut check = RowCheck {
        kind: RowKind::Attack,
        range: None,
        ability: None,
        roll_type: RollType::Flat,
        advantage_dice: 2,
        pinned: false,
        auto_hit: false,
        auto_crit: false,
        auto_fail: false,
    };
    edit(&mut check);
    check
}

fn row(edit: impl FnOnce(&mut RowCheck)) -> Result<Attack, DiceError> {
    let check = row_check(edit);
    let pmf = if check.kind == RowKind::Save {
        fireball()?.pmf()?
    } else {
        sword()?.pmf()?
    };
    Ok(Attack::Bare(Source::Contextual(ArcContextual(Arc::new(
        Row { check, pmf },
    )))))
}

fn effect_condition(name: ConditionName) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.as_str().to_string(),
        rule: rule(name).unwrap_or_default(),
        until: ConditionUntil::EndOfTurn,
    }
}

fn every_hit_on_attack_1(grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        of: Some(strings(&["attack 1"])),
        ..cspec(ConditionOn::Attack(AttackTriggerOn::EveryHit), grants)
    }
}

/// `codeOf(spec)`: `Turn.from(spec).mean()`'s error code (or `String(error)`), "none" for none.
fn code_of_spec(spec: TurnSpec) -> String {
    code_of(Turn::from_spec(spec, 0.0).and_then(|t| t.mean()))
}

#[test]
fn unknown_range_a_rule_that_differs_by_range_needs_the_rows_range() -> T {
    let spec = |range: Option<RowRange>| -> Result<TurnSpec, DiceError> {
        Ok(TurnSpec {
            attacks: vec![atk(sword()?), row(|check| check.range = range)?],
            conditions: Some(vec![every_hit_on_attack_1(vec![effect_condition(
                ConditionName::Prone,
            )])]),
            ..TurnSpec::default()
        })
    };
    assert_eq!(code_of_spec(spec(None)?), "unknown-range");
    assert_eq!(code_of_spec(spec(Some(RowRange::Ranged))?), "none");
    // A rule the same at every range needs none.
    let blinded = TurnSpec {
        conditions: Some(vec![every_hit_on_attack_1(vec![effect_condition(
            ConditionName::Blinded,
        )])]),
        ..spec(None)?
    };
    assert_eq!(code_of_spec(blinded), "none");
    Ok(())
}

#[test]
fn save_without_ability_and_unknown_ability_saves_where_a_rule_reads_saves_by_ability() -> T {
    let stunned = || effect_condition(ConditionName::Stunned);
    let spec = |save: Attack| -> Result<TurnSpec, DiceError> {
        Ok(TurnSpec {
            attacks: vec![atk(sword()?), save],
            conditions: Some(vec![every_hit_on_attack_1(vec![stunned()])]),
            ..TurnSpec::default()
        })
    };
    assert_eq!(
        code_of_spec(spec(atk(fireball()?))?),
        "save-without-ability"
    );
    assert_eq!(
        code_of_spec(spec(atk(fireball()?.ability("dex")?))?),
        "none"
    );
    assert_eq!(
        code_of_spec(spec(row(|check| {
            check.kind = RowKind::Save;
            check.ability = Some("luck".to_string());
        })?)?),
        "unknown-ability"
    );
    assert_eq!(
        code_of_spec(TurnSpec {
            attacks: vec![atk(sword()?)],
            conditions: Some(vec![ConditionSpec {
                save: Some(GrantSaves::One(GrantSaveSpec::Dc {
                    ability: None,
                    dc: 12.0,
                    bonus: 1.0,
                    roll_type: None,
                })),
                ..cspec(
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    vec![stunned()]
                )
            }]),
            ..TurnSpec::default()
        }),
        "save-without-ability"
    );
    Ok(())
}
