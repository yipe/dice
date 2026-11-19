//! `tests/condition-trigger-options.test.ts`: 7 tests translated here (no compat calls: the file is
//! not in the fixture). The `TurnSpecError` message cases (`joins` naming a row the rider does not
//! watch, a not-fired rider's `joins`, `save-without-ability`, Elven Accuracy) are translated in
//! `plan/tests_validation.rs`; here are the mean / fire-probability / refusal facts, and the pooling
//! source is evaluated (not only validated).

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::{d4, d6, d8, d20};
use crate::dnd5e::{ConditionName, prone, rule};
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::context::{ContextualSource, RowCheck, RowContext};
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, StartEffect, TriggerSave, TriggerSaves,
    advantage, save_disadvantage,
};
use crate::turn::types::{
    ArcContextual, Attack, AttackTriggerOn, ConditionOn, ConditionSpec, ConditionUntil,
    DamageSource, EffectSpec, GrantSaveSpec, Rider, RiderDamage, RiderDamageSpec, RiderOptions,
    Source, Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use indexmap::IndexMap;
use std::sync::Arc;

fn melee_sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(std::string::ToString::to_string).collect()
}

fn three_swords() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![
        atk(melee_sword()?),
        atk(melee_sword()?),
        atk(melee_sword()?),
    ])
}

fn sneak_rider() -> Result<Rider, DiceError> {
    Ok(Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: Some("sneak".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::from(rs(2.0, 6.0)?))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    })
}

fn base() -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(three_swords()?, 0.0)?.on_first_hit_with(rs(2.0, 6.0)?, first_hit_id("sneak"))?)
}

fn every_hit_rider(rider: RiderOptions) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                rider,
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
        max: None,
    }
}

fn prone_grant() -> EffectSpec {
    EffectSpec::Condition {
        condition: "prone".to_string(),
        rule: rule(ConditionName::Prone).unwrap_or_default(),
        until: ConditionUntil::EndOfTurn,
    }
}

#[test]
fn where_limits_the_rows_a_riders_landing_fires_the_condition_on() -> T {
    let mut scope = IndexMap::new();
    scope.insert("sneak".to_string(), names(&["attack 3"]));
    let fluent = base()?.on_every_hit_with(
        prone().until_end_of_turn(),
        every_hit_rider(RiderOptions {
            of: Some(names(&["sneak"])),
            r#where: Some(scope.clone()),
            ..RiderOptions::default()
        }),
    )?;
    let plain = Turn::from_spec(
        TurnSpec {
            attacks: three_swords()?,
            riders: Some(vec![sneak_rider()?]),
            conditions: Some(vec![ConditionSpec {
                id: None,
                on: ConditionOn::Attack(AttackTriggerOn::EveryHit),
                of: Some(names(&["sneak"])),
                r#where: Some(scope),
                chance: None,
                target_has: None,
                landing: None,
                dealing: None,
                target: None,
                save: None,
                grants: vec![prone_grant()],
                on_save: None,
                optional: false,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    // Prone can only land on the third attack, after which nothing reads it: three swords
    // (3 x 5.75) plus Sneak Attack on the first hit (7 x (1 - 0.35^3) x 14/13).
    close(fluent.mean()?, 24.46525, 10);
    assert_eq!(fluent.mean()?, plain.mean()?);
    let unscoped = base()?.on_every_hit_with(
        prone().until_end_of_turn(),
        every_hit_rider(RiderOptions {
            of: Some(names(&["sneak"])),
            ..RiderOptions::default()
        }),
    )?;
    assert!(unscoped.mean()? > fluent.mean()? + 1.0);
    Ok(())
}

#[test]
fn joins_is_refused_a_grant_rolls_no_dice_into_a_row() -> T {
    let result = base()?.on_every_hit_with(
        prone().until_end_of_turn(),
        every_hit_rider(RiderOptions {
            of: Some(names(&["sneak"])),
            joins: Some(names(&["attack 2"])),
            ..RiderOptions::default()
        }),
    );
    let error = result.err().ok_or("joins on a grant was accepted")?;
    assert!(error.message().contains("joins"), "{}", error.message());
    Ok(())
}

// ---- joins names rows the rider can land on ---------------------------------------------------

/// A source that pools joined riders' dice: one d6 per rider in `context.joined`.
struct Pooling;

impl ContextualSource for Pooling {
    fn row_check(&self) -> RowCheck {
        melee_sword()
            .map(|s| s.row_check())
            .unwrap_or_else(|e| panic!("{e}"))
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        if context.joined.is_empty() {
            return melee_sword()?.under(context, eps);
        }
        let dice = rs(context.joined.len() as f64, 6.0)?;
        d20()
            .plus(8.0)?
            .ac(16.0)?
            .melee()?
            .on_hit(d8().plus(4.0)?.add(&dice)?)?
            .under(context, eps)
    }
}

fn pooling() -> Attack {
    atk(Source::Contextual(ArcContextual(Arc::new(Pooling))))
}

fn joining(joined: &str) -> Rider {
    Rider {
        trigger: Trigger::FirstHit {
            of: Some(names(&["attack 1"])),
            per_source: None,
        },
        id: Some("a".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::from(d6()))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: Some(names(&[joined])),
        r#where: None,
        target_has: None,
    }
}

#[test]
fn a_row_the_rider_does_not_watch_is_unknown_id_when_read() -> T {
    let build = |joined: &str| {
        Turn::from_spec(
            TurnSpec {
                attacks: vec![pooling(), pooling()],
                riders: Some(vec![joining(joined)]),
                ..TurnSpec::default()
            },
            0.0,
        )
        .and_then(|t| t.mean())
    };
    assert!(build("attack 1").is_ok());
    assert_eq!(code_of(build("attack 2")), "unknown-id");
    Ok(())
}

// ---- a DC check used as a trigger's save is rolled in the target's state ----------------------

fn gated(save: TriggerSave) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![atk(melee_sword()?), atk(melee_sword()?)], 0.0)?
        .at_start(vec![StartEffect::SaveModifier(save_disadvantage())], None)?
        .on_first_hit_with(
            advantage().until_end_of_turn(),
            FirstHitOptions {
                condition: ConditionOptions {
                    rider: rid("c"),
                    save: Some(TriggerSaves::One(save)),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
        )?)
}

#[test]
fn save_disadvantage_in_force_applies_to_a_check_that_names_no_ability() -> T {
    // Attack 1 lands with 0.65; P(d20 + 2 < 15 at disadvantage) = 1 - 0.4^2 = 0.84.
    close(
        gated(TriggerSave::Dc(d20().plus(2.0)?.dc(15.0)?))?.fire_probability("c")?,
        0.65 * 0.84,
        12,
    );
    close(
        gated(TriggerSave::Spec(GrantSaveSpec::Dc {
            ability: None,
            dc: 15.0,
            bonus: 2.0,
            roll_type: None,
        }))?
        .fire_probability("c")?,
        0.65 * 0.84,
        12,
    );
    // Bless: P(d20 + d4 + 2 < 15 at disadvantage) = sum_k P(d4 = k) (1 - ((20 - (12 - k)) / 20)^2).
    let bless: f64 = (1..=4)
        .map(|k| (1.0 - ((8.0 + f64::from(k)) / 20.0).powi(2)) / 4.0)
        .sum();
    close(
        gated(TriggerSave::Dc(
            d20().plus(2.0)?.plus_roll(&d4())?.dc(15.0)?,
        ))?
        .fire_probability("c")?,
        0.65 * bless,
        12,
    );
    Ok(())
}

#[test]
fn with_nothing_in_force_it_is_the_0_16_fixed_chance_bit_for_bit() -> T {
    let two = || -> Result<Turn, Box<dyn std::error::Error>> {
        Ok(turn(vec![atk(melee_sword()?), atk(melee_sword()?)], 0.0)?)
    };
    let with = |save: Option<TriggerSave>, chance: Option<f64>, id: Option<&str>| {
        let options = FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    id: id.map(str::to_string),
                    ..RiderOptions::default()
                },
                save: save.map(TriggerSaves::One),
                chance,
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        };
        two().and_then(|t| Ok(t.on_first_hit_with(advantage().until_end_of_turn(), options)?))
    };
    let check = d20().plus(2.0)?.dc(15.0)?;
    let as_save = with(Some(TriggerSave::Dc(check.clone())), None, Some("c"))?;
    let as_chance = with(None, Some(check.to_pmf(0.0)?.p_at(1.0)), Some("c"))?;
    assert_eq!(as_save.pmf()?.mean(), as_chance.pmf()?.mean());
    let entries = |t: &Turn| -> Result<Vec<_>, Box<dyn std::error::Error>> {
        Ok(t.pmf()?.map.iter().map(|(k, v)| (*k, v.clone())).collect())
    };
    assert_eq!(entries(&as_save)?, entries(&as_chance)?);
    close(
        as_save.fire_probability("c")?,
        as_chance.fire_probability("c")?,
        12,
    );
    let blessed = d20().plus(2.0)?.plus_roll(&d4())?.dc(15.0)?;
    let bless_save = with(Some(TriggerSave::Dc(blessed.clone())), None, None)?;
    let bless_chance = with(None, Some(blessed.to_pmf(0.0)?.p_at(1.0)), None)?;
    assert_eq!(bless_save.pmf()?.mean(), bless_chance.pmf()?.mean());
    Ok(())
}
