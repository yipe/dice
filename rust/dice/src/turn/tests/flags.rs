//! `tests/turn-flags.test.ts`: 14 tests, 0 compat calls (the fixture has no entries for this file).
//! The nine oracle-backed cases run against the oracle recordings of `oracle.rs`.

use super::cond_helpers::*;
use super::helpers::*;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{Lasting, advantage, effect_spec};
use crate::turn::types::{
    Attack, AttackTriggerOn, ConditionOn, ConditionSpec, EffectSpec, GrantSpec, GrantUntil,
    Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};

fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    sword_5_12()
}

fn two_swords() -> Result<Turn, DiceError> {
    turn(vec![atk(sword()?), atk(sword()?)], 0.0)
}

fn adv_next() -> Lasting {
    advantage().until_next_attack().into()
}

fn adv_turn() -> Lasting {
    advantage().until_end_of_turn().into()
}

// ---- flags: limits -------------------------------------------------------------------------------

#[test]
fn nine_live_flags_walk_thirty_one_live_at_once_is_too_many_states() -> T {
    let once = two_swords()?.on_every_hit_with(adv_next(), every(of(&["attack 1"])))?;
    let mut t = two_swords()?;
    for _ in 0..9 {
        t = t.on_every_hit_with(adv_next(), every(of(&["attack 1"])))?;
    }
    close(t.mean()?, once.mean()?, 12);
    let mut wide = two_swords()?;
    for _ in 0..30 {
        wide = wide.on_every_hit_with(adv_next(), every(of(&["attack 1"])))?;
    }
    close(wide.mean()?, once.mean()?, 12);
    assert_eq!(
        code_of(wide.on_every_hit_with(adv_next(), every(of(&["attack 1"])))),
        "too-many-states"
    );
    Ok(())
}

#[test]
fn forty_chained_next_attack_grants_reuse_two_bits() -> T {
    let attacks: Vec<Attack> = (0..41)
        .map(|i| Ok(named(&format!("a{i}"), sword()?)))
        .collect::<Result<_, String>>()?;
    let conditions: Vec<ConditionSpec> = (0..40)
        .map(|i| ConditionSpec {
            of: Some(strings(&[&format!("a{i}")])),
            ..cspec(
                ConditionOn::Attack(AttackTriggerOn::EveryHit),
                vec![EffectSpec::Grant(GrantSpec {
                    advantage: true,
                    disadvantage: false,
                    crit_on_hit: false,
                    until: GrantUntil::NextAttack,
                    to: Some(strings(&[&format!("a{}", i + 1)])),
                })],
            )
        })
        .collect();
    // A Markov chain on "the previous attack landed": attack i+1 has advantage with probability q_i, where
    // q_0 = 0 and q_{i+1} = q_i * L_adv + (1 - q_i) * L_flat (d20 + 5 vs AC 12 lands on 7..20).
    let land_flat = 0.7;
    let land_adv = 1.0 - 0.3f64.powi(2);
    let flat_mean = sword()?.mean()?;
    let adv_mean = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?
        .mean()?;
    let mut q = 0.0;
    let mut expected = 0.0;
    for _ in 0..41 {
        expected += q * adv_mean + (1.0 - q) * flat_mean;
        q = q * land_adv + (1.0 - q) * land_flat;
    }
    let spec = TurnSpec {
        attacks,
        conditions: Some(conditions),
        ..TurnSpec::default()
    };
    close(Turn::from_spec(spec, 0.0)?.mean()?, expected, 10);
    Ok(())
}

#[test]
fn a_walk_past_the_turns_state_limit_is_too_many_states() -> T {
    let spec = TurnSpec {
        attacks: vec![atk(sword()?), atk(sword()?), atk(sword()?)],
        conditions: Some(vec![ConditionSpec {
            of: Some(strings(&["attack 1"])),
            ..cspec(
                ConditionOn::Attack(AttackTriggerOn::EveryHit),
                vec![effect_spec(&adv_turn())],
            )
        }]),
        riders: Some(vec![rider_of(
            Trigger::FirstHit {
                of: None,
                per_source: None,
            },
            None,
            rs(1.0, 4.0)?,
        )]),
        ..TurnSpec::default()
    };
    // Attack 1 lands (0.7) and gives attacks 2 and 3 advantage; the d4 (doubled on a crit) rides the first landing,
    // which is attack 1, 2 or 3 after 0, 1 or 2 flat misses (no advantage without a landing).
    let adv_mean = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?
        .mean()?;
    let attacks_mean = sword()?.mean()? + 0.7 * 2.0 * adv_mean + 0.3 * 2.0 * sword()?.mean()?;
    let rider_mean = (0.05 * 5.0 + 0.65 * 2.5) * (1.0 + 0.3 + 0.3f64.powi(2));
    close(
        Turn::from_spec(spec.clone(), 0.0)?.mean()?,
        attacks_mean + rider_mean,
        12,
    );
    let limited = TurnSpec {
        state_limit: Some(1.0),
        ..spec.clone()
    };
    assert_eq!(
        code_of(Turn::from_spec(limited, 0.0).and_then(|t| t.mean())),
        "too-many-states"
    );
    let zero = TurnSpec {
        state_limit: Some(0.0),
        ..spec
    };
    assert!(matches!(
        Turn::from_spec(zero, 0.0),
        Err(DiceError::Range(_))
    ));
    Ok(())
}

// ---- flags: references that read nothing ---------------------------------------------------------

#[test]
fn a_to_with_no_attack_roll_after_the_conditions_sources_is_a_no_op_a_missing_id_is_unknown_id() -> T
{
    let unreachable = two_swords()?.on_every_hit_with(
        advantage().until_next_attack().to(&["attack 1"]),
        every(of(&["attack 2"])),
    )?;
    assert_eq!(
        pmf_max_diff(&unreachable.pmf()?, &two_swords()?.pmf()?),
        0.0
    );
    assert_eq!(
        code_of(two_swords()?.on_every_hit_with(
            advantage().until_next_attack().to(&["nowhere"]),
            Default::default()
        )),
        "unknown-id"
    );
    Ok(())
}

#[test]
fn an_explicit_of_never_lands_an_omitted_of_keeps_its_default_a_missing_id_still_fails() -> T {
    let first_hit = || Trigger::FirstHit {
        of: Some(Vec::new()),
        per_source: None,
    };
    let t = Turn::from_spec(
        TurnSpec {
            attacks: vec![named("a", sword()?)],
            riders: Some(vec![rider_of(first_hit(), Some("never"), rs(2.0, 8.0)?)]),
            conditions: Some(vec![ConditionSpec {
                id: Some("c".to_string()),
                of: Some(Vec::new()),
                ..cspec(
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    vec![effect_spec(&adv_turn())],
                )
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    assert_eq!(t.fire_probability("never")?, 0.0);
    assert_eq!(t.fire_probability("c")?, 0.0);
    assert_eq!(t.marginal("never")?.pmf().mean(), 0.0);
    close(t.mean()?, sword()?.mean()?, 12);
    let defaulted = Turn::from_spec(
        TurnSpec {
            attacks: vec![named("a", sword()?)],
            riders: Some(vec![rider_of(
                Trigger::FirstHit {
                    of: None,
                    per_source: None,
                },
                Some("r"),
                rs(2.0, 8.0)?,
            )]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    close(defaulted.fire_probability("r")?, 0.7, 12);
    let missing = Turn::from_spec(
        TurnSpec {
            attacks: vec![named("a", sword()?)],
            riders: Some(vec![rider_of(
                Trigger::FirstHit {
                    of: Some(strings(&["missing"])),
                    per_source: None,
                },
                None,
                rs(2.0, 8.0)?,
            )]),
            ..TurnSpec::default()
        },
        0.0,
    );
    assert_eq!(code_of(missing), "unknown-id");
    assert_eq!(
        code_of(turn(vec![], 0.0)?.on_first_hit_with(rs(2.0, 8.0)?, Default::default())),
        "unknown-id"
    );
    Ok(())
}

// ---- flags: flags and lifetimes against the oracle -----------------------------------------------

mod against_the_oracle {
    use super::super::oracle::*;
    use super::T;

    const FILE: &str = "tests/turn-flags.test.ts";
    const SUITE: &str = "flags: flags and lifetimes against the oracle";

    #[allow(
        clippy::needless_pass_by_value,
        reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
    )]
    fn expect(name: &str, synthetic: SyntheticTurn) -> T {
        expect_oracle(FILE, &format!("{SUITE} > {name}"), &synthetic, false)?;
        Ok(())
    }

    /// A hit that deals 0 half the time: 1d4 - 2, floored at 0.
    fn weak() -> AttackSpec {
        attack().damage(dice(1.0, 4.0, Some(-2.0), true))
    }

    /// `crit(extra)`: a crit grant.
    fn crit() -> GrantDef {
        grant().trigger("crit")
    }

    fn attacks(n: usize) -> Vec<AttackSpec> {
        (0..n).map(|_| attack()).collect()
    }

    #[test]
    fn first_crit_the_first_crit_grants_the_next_attack_advantage() -> T {
        expect(
            "first-crit: the first crit grants the next attack advantage",
            SyntheticTurn {
                attacks: attacks(3),
                grants: Some(vec![crit().of(&[0, 1]).once()]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn any_crit_every_crit_does() -> T {
        expect(
            "any-crit: every crit does",
            SyntheticTurn {
                attacks: attacks(3),
                grants: Some(vec![crit().of(&[0, 1])]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn landing_damage_a_hit_that_deals_0_lands_nothing() -> T {
        expect(
            "landing damage: a hit that deals 0 lands nothing",
            SyntheticTurn {
                attacks: vec![weak(), attack(), attack()],
                grants: Some(vec![grant().trigger("damage").of(&[0, 1])]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn landing_damage_once() -> T {
        expect(
            "landing damage, once",
            SyntheticTurn {
                attacks: vec![weak(), weak(), attack()],
                grants: Some(vec![grant().trigger("damage").of(&[0, 1]).once()]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn vulnerability_the_next_hit_doubles_a_miss_leaves_it() -> T {
        expect(
            "vulnerability: the next hit doubles, a miss leaves it",
            SyntheticTurn {
                attacks: attacks(4),
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .effects(vec![effect("vulnerability", Some("next-hit"))]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn a_crit_grant_feeds_crit_on_hit_which_feeds_a_crit_grant() -> T {
        expect(
            "a crit grant feeds crit-on-hit, which feeds a crit grant",
            SyntheticTurn {
                attacks: attacks(3),
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .effects(vec![effect("critOnHit", Some("turn"))]),
                    crit()
                        .of(&[1])
                        .effects(vec![effect("advantage", Some("turn"))]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn elven_accuracy_own_advantage_stays_two_dice_until_the_state_grants_one() -> T {
        expect(
            "Elven Accuracy: own advantage stays two dice until the state grants one",
            SyntheticTurn {
                attacks: vec![attack(), attack().advantage("advantage").elven_accuracy()],
                grants: Some(vec![
                    grant()
                        .of(&[0])
                        .effects(vec![effect("advantage", Some("turn"))]),
                ]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn a_pinned_roll_ignores_granted_advantage_but_still_uses_it_up() -> T {
        expect(
            "a pinned roll ignores granted advantage but still uses it up",
            SyntheticTurn {
                attacks: vec![attack(), attack().roll_override("disadvantage"), attack()],
                grants: Some(vec![grant().of(&[0]).effects(vec![next_advantage()])]),
                ..SyntheticTurn::default()
            },
        )
    }

    #[test]
    fn next_attack_flags_with_disjoint_lives_share_a_bit() -> T {
        expect(
            "next-attack flags with disjoint lives share a bit",
            SyntheticTurn {
                attacks: attacks(6),
                grants: Some(
                    (0..5)
                        .map(|i| {
                            grant().of(&[i]).effects(vec![
                                effect("advantage", Some("next-attack")).to(&[i + 1]),
                            ])
                        })
                        .collect(),
                ),
                ..SyntheticTurn::default()
            },
        )
    }
}
