//! `tests/condition-review-regressions.test.ts`: 16 tests (the `it.each` cases are loops), no compat
//! calls (the file is not in the fixture). The `TurnSpecError` cases (126-134, 136, 205-217) are
//! translated in `plan/tests_validation.rs`; here are the mean / fire-probability / builder facts.
//!
//! Not translated: tests/condition-review-regressions.test.ts:165-171: `@ts-expect-error` type checks
//! of `condition(...)` rules (a save modifier on an attack side): `AttackRuleModifier` and
//! `SaveRuleModifier` are separate enums, so the mix cannot be written.
//! Not translated: tests/condition-review-regressions.test.ts:133: a trigger verb with a `target`
//! option (`ConditionOptions` has none).

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::dc::FailurePart;
use crate::builder::factory::{d4, d8, d20};
use crate::builder::roll::{Arg, RollBuilder};
use crate::dnd5e::{ConditionName, paralyzed, prone, restrained, rule};
use crate::error::DiceError;
use crate::turn::context::RowRange;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, StartEffect, TriggerSave, TriggerSaves,
    condition, grant_save_spec, keep_best_damage, vulnerability,
};
use crate::turn::types::{
    After, AfterLanding, Attack, AttackOptions, ConditionOn, ConditionRule, ConditionSpec,
    ConditionUntil, EffectSpec, GrantSaveSpec, Rider, RiderDamage, RiderDamageSpec,
    SaveRuleModifier, Trigger, TurnSpec, TurnSpecErrorCode,
};
use crate::turn::{Turn, turn};
use indexmap::IndexMap;

fn melee_sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

fn bow() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.ranged()?.on_hit(d8().plus(4.0)?)
}

fn two_swords() -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![atk(melee_sword()?), atk(melee_sword()?)], 0.0)?)
}

fn gate_save(save: TriggerSave) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            save: Some(TriggerSaves::One(save)),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn start(effect: impl Into<StartEffect>) -> Vec<StartEffect> {
    vec![effect.into()]
}

// ---- SaveBuilder verbs keep attached conditions -----------------------------------------------

#[test]
fn save_builder_verbs_keep_attached_conditions() -> T {
    let base = d20().plus(2.0)?.dc(15.0)?.on_save_failure_effects(&[
        FailurePart::Damage(Arg::Roll(rs(8.0, 6.0)?)),
        FailurePart::Effect(prone().until_end_of_turn()),
    ])?;
    let attached = |s: &crate::builder::save::SaveBuilder| format!("{:?}", s.attached);
    let verbs = [
        ("ability", base.ability("dex")?),
        ("alwaysFails", base.always_fails()?),
        ("pinned", base.pinned()?),
        ("saveHalf", base.save_half()?),
        (
            "onSaveSuccess",
            base.on_save_success_args(&[Arg::Num(3.0)])?,
        ),
    ];
    for (name, verb) in verbs {
        assert_eq!(attached(&verb), attached(&base), "{name}");
    }
    assert_eq!(base.attached.len(), 1);
    Ok(())
}

// ---- a DC check's ability gates a condition by the target's state -----------------------------

fn restrained_gated(gate: FirstHitOptions) -> Result<f64, Box<dyn std::error::Error>> {
    Ok(two_swords()?
        .at_start(start(StartEffect::Condition(restrained())), None)?
        .on_first_hit_with(vulnerability().until_next_hit(), gate)?
        .mean()?)
}

#[test]
fn matches_the_plain_data_spelling_and_differs_from_the_fixed_chance_gate() -> T {
    let fluent = restrained_gated(gate_save(TriggerSave::Dc(
        d20().plus(1.0)?.dc(15.0)?.ability("dex")?,
    )))?;
    let plain = restrained_gated(gate_save(TriggerSave::Spec(GrantSaveSpec::Dc {
        ability: Some("dexterity".to_string()),
        dc: 15.0,
        bonus: 1.0,
        roll_type: None,
    })))?;
    let chance = d20().plus(1.0)?.dc(15.0)?.to_pmf(0.0)?.p_at(1.0);
    let fixed = restrained_gated(FirstHitOptions {
        condition: ConditionOptions {
            chance: Some(chance),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    })?;
    assert_eq!(fluent, plain);
    assert!((fluent - fixed).abs() >= 0.5e-6, "{fluent} vs {fixed}");
    Ok(())
}

// ---- Turn.attack passes every AttackOptions field ---------------------------------------------

fn prone_start_condition() -> ConditionSpec {
    ConditionSpec {
        id: None,
        on: ConditionOn::Start,
        of: None,
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants: vec![EffectSpec::Condition {
            condition: "prone".to_string(),
            rule: rule(ConditionName::Prone).unwrap_or_default(),
            until: ConditionUntil::EndOfTurn,
        }],
        on_save: None,
        optional: false,
    }
}

fn second_options(after: bool, target: bool, chance: Option<f64>) -> AttackOptions {
    AttackOptions {
        id: Some("second".to_string()),
        after: after.then(|| After {
            of: "first".to_string(),
            landing: AfterLanding::Hit,
        }),
        target: target.then(|| "other".to_string()),
        chance,
        ..AttackOptions::default()
    }
}

fn chained(options: AttackOptions) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![], 0.0)?
        .attack_as(melee_sword()?, "first")?
        .attack_with(melee_sword()?, options)?
        .at_start(start(StartEffect::Condition(prone())), None)?)
}

#[test]
fn after_target_and_chance_match_turn_from() -> T {
    // Prone is on the default target only, so `target: "other"` changes the second attack's roll.
    let fluent = chained(second_options(true, true, Some(0.5)))?;
    let plain = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                named("first", melee_sword()?),
                Attack::Declared {
                    options: second_options(true, true, Some(0.5)),
                    source: melee_sword()?.into(),
                },
            ],
            conditions: Some(vec![prone_start_condition()]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let mean = fluent.pmf()?.mean();
    assert_eq!(mean, plain.pmf()?.mean());
    for (label, other) in [
        ("ungated", second_options(false, true, Some(0.5))),
        ("untargeted", second_options(true, false, Some(0.5))),
        ("uncoined", second_options(true, true, None)),
    ] {
        let other_mean = chained(other)?.pmf()?.mean();
        assert!(
            (mean - other_mean).abs() >= 0.5e-6,
            "{label}: {mean} vs {other_mean}"
        );
    }
    Ok(())
}

// ---- ranged() ---------------------------------------------------------------------------------

#[test]
fn a_ranged_attack_against_a_prone_target_has_disadvantage() -> T {
    let expected = d20()
        .plus(8.0)?
        .with_disadvantage()?
        .ac(16.0)?
        .ranged()?
        .on_hit(d8().plus(4.0)?)?
        .mean()?;
    let got = turn(vec![atk(bow()?)], 0.0)?
        .at_start(start(StartEffect::Condition(prone())), None)?
        .mean()?;
    close(got, expected, 12);
    Ok(())
}

#[test]
fn a_ranged_attack_against_a_paralyzed_target_has_advantage_but_no_automatic_crit() -> T {
    let expected = d20()
        .plus(8.0)?
        .with_advantage()?
        .ac(16.0)?
        .ranged()?
        .on_hit(d8().plus(4.0)?)?
        .mean()?;
    let got = turn(vec![atk(bow()?)], 0.0)?
        .at_start(start(StartEffect::Condition(paralyzed())), None)?
        .mean()?;
    close(got, expected, 12);
    Ok(())
}

// ---- a DC check used as a trigger's save keeps its own fail odds ------------------------------

fn gated_mean(save: TriggerSaves) -> Result<f64, Box<dyn std::error::Error>> {
    let options = FirstHitOptions {
        condition: ConditionOptions {
            save: Some(save),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    };
    Ok(two_swords()?
        .on_first_hit_with(
            crate::turn::effects::advantage().until_end_of_turn(),
            options,
        )?
        .mean()?)
}

#[test]
fn ability_and_the_list_form_match_the_bare_check() -> T {
    let check = |name: &str| -> Result<RollBuilder, DiceError> {
        match name {
            "bless" => d20().plus(2.0)?.plus_roll(&d4())?.dc(15.0),
            "bane" => d20().plus(2.0)?.minus_roll(&d4())?.dc(15.0),
            "halfling" => d20().reroll(1.0)?.plus(2.0)?.dc(15.0),
            "alwaysFails" => d20().plus(2.0)?.dc(15.0)?.always_fails(),
            _ => d20().plus(2.0)?.with_advantage()?.pinned()?.dc(15.0),
        }
    };
    for name in [
        "bless",
        "bane",
        "halfling",
        "alwaysFails",
        "pinnedAdvantage",
    ] {
        let one = |c: RollBuilder| TriggerSaves::One(TriggerSave::Dc(c));
        let many = |c: RollBuilder| TriggerSaves::Many(vec![TriggerSave::Dc(c)]);
        let bare = gated_mean(one(check(name)?))?;
        close(gated_mean(one(check(name)?.ability("con")?))?, bare, 12);
        close(gated_mean(many(check(name)?))?, bare, 12);
        close(gated_mean(many(check(name)?.ability("con")?))?, bare, 12);
    }
    Ok(())
}

#[test]
fn the_plain_check_keeps_its_plain_data_form() -> T {
    let spec = grant_save_spec(
        &TriggerSave::Dc(d20().plus(2.0)?.dc(15.0)?.ability("con")?),
        0.0,
    )?;
    match spec {
        GrantSaveSpec::Dc {
            ability,
            dc,
            bonus,
            roll_type,
        } => {
            assert_eq!(ability.as_deref(), Some("constitution"));
            assert_eq!((dc, bonus), (15.0, 2.0));
            assert!(roll_type.is_none());
        }
        GrantSaveSpec::FailChance { .. } => {
            return Err(DiceError::error("expected a plain Dc spec").into());
        }
    }
    Ok(())
}

#[test]
fn is_rolled_in_the_targets_state_restrained_gives_a_bless_boosted_dex_save_disadvantage() -> T {
    let restrained_turn = |save: RollBuilder| restrained_gated(gate_save(TriggerSave::Dc(save)));
    // Restrained leaves a CON save alone, so a CON check with its own roll is the comparator.
    let state_aware = restrained_turn(
        d20()
            .plus(1.0)?
            .plus_roll(&d4())?
            .dc(15.0)?
            .ability("dex")?,
    )?;
    let fixed_disadvantage = restrained_turn(
        d20()
            .plus(1.0)?
            .plus_roll(&d4())?
            .with_disadvantage()?
            .dc(15.0)?
            .ability("con")?,
    )?;
    close(state_aware, fixed_disadvantage, 12);
    // A pinned save keeps its own (flat) roll.
    let pinned = restrained_turn(
        d20()
            .plus(1.0)?
            .plus_roll(&d4())?
            .pinned()?
            .dc(15.0)?
            .ability("dex")?,
    )?;
    let con = restrained_turn(
        d20()
            .plus(1.0)?
            .plus_roll(&d4())?
            .dc(15.0)?
            .ability("con")?,
    )?;
    close(pinned, con, 12);
    Ok(())
}

// ---- target is taken by atStart and attacks only ----------------------------------------------

#[test]
fn at_starts_target_must_be_a_creature_some_row_is_aimed_at() -> T {
    let aimed =
        |t: Turn, target: &str| t.at_start(start(StartEffect::Condition(prone())), Some(target));
    assert_eq!(
        code_of(aimed(turn(vec![atk(melee_sword()?)], 0.0)?, "secnod").and_then(|t| t.mean())),
        "unknown-id"
    );
    assert!(
        aimed(turn(vec![atk(melee_sword()?)], 0.0)?, "target")?
            .mean()
            .is_ok()
    );
    let second = turn(vec![], 0.0)?.attack(melee_sword()?)?.attack_with(
        melee_sword()?,
        AttackOptions {
            target: Some("second".to_string()),
            ..AttackOptions::default()
        },
    )?;
    assert!(aimed(second, "second")?.mean().is_ok());
    Ok(())
}

// ---- ability names are normalised -------------------------------------------------------------

fn str_save() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("str")?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])
}

fn held(key: &str) -> ConditionRule {
    let mut save = IndexMap::new();
    save.insert(key.to_string(), vec![SaveRuleModifier::AutoFail]);
    ConditionRule {
        save: Some(save),
        ..ConditionRule::default()
    }
}

#[test]
fn a_rule_keyed_by_a_short_name_applies_to_a_save_made_with_the_full_name() -> T {
    let mean = |key: &str| -> Result<f64, Box<dyn std::error::Error>> {
        Ok(turn(vec![atk(str_save()?)], 0.0)?
            .at_start(
                start(StartEffect::Condition(condition("held", held(key)))),
                None,
            )?
            .mean()?)
    };
    let short = mean("str")?;
    let full = mean("strength")?;
    close(full, 28.0, 12);
    close(short, full, 12);
    Ok(())
}

#[test]
fn a_grant_save_spec_with_a_short_ability_reads_the_targets_state_as_the_full_name_does() -> T {
    let gated = |ability: &str| {
        restrained_gated(gate_save(TriggerSave::Spec(GrantSaveSpec::Dc {
            ability: Some(ability.to_string()),
            dc: 15.0,
            bonus: 1.0,
            roll_type: None,
        })))
    };
    close(gated("dex")?, gated("dexterity")?, 12);
    Ok(())
}

#[test]
fn a_rule_keyed_by_no_known_ability_is_unknown_ability() -> T {
    let result = turn(vec![atk(str_save()?)], 0.0)?
        .at_start(
            start(StartEffect::Condition(condition("mad", held("sanity")))),
            None,
        )
        .and_then(|t| t.mean());
    assert_eq!(spec_code(result), TurnSpecErrorCode::UnknownAbility);
    Ok(())
}

// ---- ACBuilder.alwaysHits() keeps the row's facts ---------------------------------------------

#[test]
fn keeps_the_range_and_the_crit_threshold() -> T {
    let always = d20()
        .plus(8.0)?
        .ac(16.0)?
        .melee()?
        .always_hits()?
        .on_hit(d8())?;
    assert_eq!(always.row_check().range, Some(RowRange::Melee));
    let a = d20()
        .plus(8.0)?
        .ac(16.0)?
        .crit_on(19.0)?
        .always_hits()?
        .on_hit(d8())?
        .mean()?;
    let b = d20()
        .plus(8.0)?
        .always_hits()?
        .crit_on(19.0)?
        .on_hit(d8())?
        .mean()?;
    close(a, b, 12);
    Ok(())
}

// ---- rider and transform options --------------------------------------------------------------

fn a() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(d8().plus(3.0)?)
}

fn melee_a() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.melee()?.on_hit(d8().plus(3.0)?)
}

fn happens_every_hit(happens: f64, max: Option<f64>) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                happens: Some(happens),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
        max,
    }
}

#[test]
fn every_hit_max_1_keeps_happens() -> T {
    let lowered = turn(vec![atk(a()?), atk(a()?)], 0.0)?
        .on_every_hit_with(rs(2.0, 6.0)?, happens_every_hit(0.5, Some(1.0)))?
        .mean()?;
    let first_hit = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(a()?), atk(a()?)],
            riders: Some(vec![Rider {
                trigger: Trigger::FirstHit {
                    of: None,
                    per_source: None,
                },
                id: None,
                damage: RiderDamageSpec::Plain(RiderDamage::One(rs(2.0, 6.0)?.into())),
                crit_damage: None,
                landing: None,
                happens: Some(0.5),
                joins: None,
                r#where: None,
                target_has: None,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?
    .mean()?;
    close(first_hit, 11.745, 3);
    close(lowered, first_hit, 12);
    Ok(())
}

#[test]
fn on_first_hit_transform_refuses_happens_dealing_and_optional() -> T {
    let refused = |condition: ConditionOptions| -> Result<String, Box<dyn std::error::Error>> {
        let result = turn(vec![atk(a()?), atk(a()?)], 0.0)?.on_first_hit_transform(
            keep_best_damage(),
            FirstHitOptions {
                condition,
                ..FirstHitOptions::default()
            },
        );
        Ok(code_of(result))
    };
    let happens = ConditionOptions {
        happens: Some(0.1),
        ..ConditionOptions::default()
    };
    let dealing = ConditionOptions {
        dealing: Some("fire".to_string()),
        ..ConditionOptions::default()
    };
    let optional = ConditionOptions {
        optional: true,
        ..ConditionOptions::default()
    };
    assert_eq!(refused(happens)?, "unsupported-trigger");
    assert_eq!(refused(dealing)?, "unsupported-trigger");
    assert_eq!(refused(optional)?, "unsupported-trigger");
    Ok(())
}

#[test]
fn a_start_condition_is_applied_once_when_a_coin_splits_the_start_state() -> T {
    let t = turn(vec![atk(melee_a()?), atk(melee_a()?)], 0.0)?
        .at_start(start(StartEffect::Condition(restrained())), None)?
        .on_every_hit_with(rs(2.0, 6.0)?, happens_every_hit(0.5, None))?;
    close(t.fire_probability("condition 1")?, 1.0, 12);
    Ok(())
}
