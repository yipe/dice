//! `src/turn/fluent-conditions.test.ts`: 19 of 20 tests, 0 compat calls (no compat entries).
//!
//! The TS mocks `buildPlan` to read the spec each verb wrote, building it without conditions; here
//! that is `Turn::inspect_spec()`, but every verb validates for real, so the sources are made
//! valid: `melee_sword` (prone reads a range), `typed_sword` (a source that can say `dealt`, for
//! `dealing`), an attack aimed at "ogre" (for `atStart(.., { target: "ogre" })`).
//!
//! Not translated:
//! - fluent-conditions.test.ts:154-173: "types: a lifetime is required, ..." is `@ts-expect-error`
//!   and `expectTypeOf` checks only (a condition without a lifetime, `untilDamaged` on a grant,
//!   `vulnerability().untilEndOfTurn()` ... have no Rust counterpart: each is a missing method or
//!   an unconvertible type); a runtime assertion on `untilDamaged` stands in.
//! - fluent-conditions.test.ts:244-248: "refuses a target on a trigger" passes `{ target: "ogre" }
//!   as never` (a JS-only extra key); `ConditionOptions` has no `target` field to pass.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::{AttachedCondition, AttachedOn, AttackBuilder, ConditionGate, Grants};
use crate::builder::dc::FailurePart;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::dnd5e::{
    ConditionName, blinded, paralyzed, prone, restrained, rule, stunned, unconscious,
};
use crate::error::DiceError;
use crate::turn::context::{ContextualSource, Dealt, RowCheck, RowContext};
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, Lasting, StartEffect, TriggerSave,
    TriggerSaves, advantage, condition, crit_on_hit, effect_spec, save_disadvantage, save_penalty,
    vulnerability,
};
use crate::turn::types::{
    ArcContextual, Attack, AttackOptions, AttackTriggerOn, ConditionOn, ConditionRule,
    ConditionSpec, ConditionUntil, DamageSource, EffectSpec, FailChance, GrantSaveSpec, GrantSaves,
    GrantSpec, GrantUntil, Rider, RiderDamage, RiderDamageSpec, RiderOptions, SaveLanding,
    SaveUntil, Source, Trigger, TurnSpec,
};
use crate::turn::{Effect, EffectPart, Turn, turn};
use std::sync::Arc;

fn sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(d8())
}

/// The sword with its range declared, so range-dependent conditions (prone) can read it.
fn melee_sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.melee()?.on_hit(d8())
}

/// A melee sword that also says the odds it deals a type (the TS evaluates nothing, so its plain
/// builder never meets `ContextualSource.dealt`; this stands in so the trigger options reach the
/// spec through a real build).
struct Typed(AttackBuilder);

impl ContextualSource for Typed {
    fn row_check(&self) -> RowCheck {
        ContextualSource::row_check(&self.0)
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        ContextualSource::under(&self.0, context, eps)
    }
    fn has_dealt(&self) -> bool {
        true
    }
    fn dealt(&self, _type: &str, _context: &RowContext) -> Result<Dealt, DiceError> {
        Ok(Dealt {
            hit: 1.0,
            crit: 1.0,
        })
    }
}

fn typed_sword() -> Result<Attack, DiceError> {
    Ok(Attack::Bare(Source::Contextual(ArcContextual(Arc::new(
        Typed(melee_sword()?),
    )))))
}

fn both() -> Option<Vec<String>> {
    strings(&["attack 1", "attack 2"])
}

fn strings(items: &[&str]) -> Option<Vec<String>> {
    Some(items.iter().map(|s| (*s).to_string()).collect())
}

fn frightened_rule() -> ConditionRule {
    use crate::turn::types::{AttackRule, AttackRuleModifier};
    ConditionRule {
        attack: Some(AttackRule {
            melee: Some(vec![AttackRuleModifier::Disadvantage]),
            ranged: None,
        }),
        ..ConditionRule::default()
    }
}

fn rule_of(name: ConditionName) -> Result<ConditionRule, DiceError> {
    rule(name).ok_or_else(|| DiceError::error(format!("{name:?} has no rule")))
}

fn prone_spec() -> Result<EffectSpec, DiceError> {
    Ok(EffectSpec::Condition {
        condition: "prone".to_string(),
        rule: rule_of(ConditionName::Prone)?,
        until: ConditionUntil::EndOfTurn,
    })
}

fn spec_of(l: impl Into<Lasting>) -> EffectSpec {
    effect_spec(&l.into())
}

/// A `ConditionSpec` with everything but `on`, `of` and `grants` unset.
fn cond(on: ConditionOn, of: Option<Vec<String>>, grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: None,
        on,
        of,
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

fn hit(on: AttackTriggerOn) -> ConditionOn {
    ConditionOn::Attack(on)
}

/// `Debug` of the conditions: `ConditionSpec` carries a `failChance` function, so no `PartialEq`.
#[track_caller]
fn assert_conditions(spec: &TurnSpec, expected: &[ConditionSpec]) {
    let actual = spec.conditions.clone().unwrap_or_default();
    assert_eq!(format!("{actual:#?}"), format!("{expected:#?}"));
}

fn conditions_of(t: &Turn) -> Vec<ConditionSpec> {
    t.inspect_spec().conditions.unwrap_or_default()
}

fn plain_rider(damage: RiderDamageSpec) -> Rider {
    Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: None,
        damage,
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

// ---- effects ----------------------------------------------------------------------------------

#[test]
fn each_factory_writes_its_effect_spec() -> T {
    assert_eq!(spec_of(prone().until_end_of_turn()), prone_spec()?);
    assert_eq!(
        spec_of(unconscious().until_damaged()),
        EffectSpec::Condition {
            condition: "unconscious".to_string(),
            rule: rule_of(ConditionName::Unconscious)?,
            until: ConditionUntil::UntilDamaged,
        }
    );
    assert_eq!(
        spec_of(condition("frightened", frightened_rule()).until_end_of_turn()),
        EffectSpec::Condition {
            condition: "frightened".to_string(),
            rule: frightened_rule(),
            until: ConditionUntil::EndOfTurn,
        }
    );
    assert_eq!(
        spec_of(vulnerability().until_next_hit()),
        EffectSpec::Vulnerability
    );
    assert_eq!(
        spec_of(save_disadvantage().until_next_save().to(&["spells"])),
        EffectSpec::SaveDisadvantage {
            until: SaveUntil::NextSave,
            to: strings(&["spells"]),
        }
    );
    assert_eq!(
        spec_of(save_disadvantage().until_end_of_turn()),
        EffectSpec::SaveDisadvantage {
            until: SaveUntil::EndOfTurn,
            to: None,
        }
    );
    assert_eq!(
        spec_of(save_penalty(&d4())?.until_next_save()),
        EffectSpec::SavePenalty {
            count: 1.0,
            sides: 4.0,
            until: SaveUntil::NextSave,
            to: None,
        }
    );
    assert_eq!(
        spec_of(
            save_penalty(&rs(2.0, 4.0)?)?
                .until_end_of_turn()
                .to(&["attack 2"])
        ),
        EffectSpec::SavePenalty {
            count: 2.0,
            sides: 4.0,
            until: SaveUntil::EndOfTurn,
            to: strings(&["attack 2"]),
        }
    );
    Ok(())
}

#[test]
fn the_dnd5e_factories_are_condition_name_rules_name() -> T {
    let factories = [
        ("blinded", blinded(), ConditionName::Blinded),
        ("paralyzed", paralyzed(), ConditionName::Paralyzed),
        ("prone", prone(), ConditionName::Prone),
        ("restrained", restrained(), ConditionName::Restrained),
        ("stunned", stunned(), ConditionName::Stunned),
        ("unconscious", unconscious(), ConditionName::Unconscious),
    ];
    for (name, factory, key) in factories {
        assert_eq!(
            spec_of(factory.until_end_of_turn()),
            spec_of(condition(name, rule_of(key)?).until_end_of_turn())
        );
    }
    Ok(())
}

#[test]
fn save_penalty_takes_one_plain_die_group() -> T {
    let plus = save_penalty(&d4().plus(1.0)?);
    assert!(
        plus.err()
            .is_some_and(|e| e.message().contains("one plain die group"))
    );
    let added = save_penalty(&d4().add(&d6())?);
    assert!(
        added
            .err()
            .is_some_and(|e| e.message().contains("one plain die group"))
    );
    Ok(())
}

#[test]
fn types_a_lifetime_is_required_until_damaged_is_a_conditions() -> T {
    // The `@ts-expect-error` checks have no Rust counterpart (module doc); the one runtime fact:
    assert_eq!(
        spec_of(prone().until_damaged()),
        EffectSpec::Condition {
            condition: "prone".to_string(),
            rule: rule_of(ConditionName::Prone)?,
            until: ConditionUntil::UntilDamaged,
        }
    );
    Ok(())
}

// ---- triggers on the turn -----------------------------------------------------------------------

#[test]
fn on_first_crit_writes_a_first_crit_condition() -> T {
    let t = turn(vec![atk(melee_sword()?), atk(melee_sword()?)], 0.0)?
        .on_first_crit_with(prone().until_end_of_turn(), cond_id("topple"))?;
    let spec = t.inspect_spec();
    assert_eq!(spec.attacks.len(), 2);
    assert!(spec.riders.clone().unwrap_or_default().is_empty());
    assert!(spec.substitutes.clone().unwrap_or_default().is_empty());
    assert!(spec.observe.clone().unwrap_or_default().is_empty());
    let expected = ConditionSpec {
        id: Some("topple".to_string()),
        ..cond(ConditionOn::FirstCrit, both(), vec![prone_spec()?])
    };
    assert_conditions(&spec, &[expected]);
    Ok(())
}

#[test]
fn on_first_crit_refuses_damage_damage_on_a_crit_is_on_any_crit() -> T {
    let result =
        turn(vec![atk(sword()?)], 0.0)?.on_first_crit_with(d6(), ConditionOptions::default());
    assert_eq!(code_of(result), "unsupported-trigger");
    Ok(())
}

#[test]
fn passes_landing_dealing_optional_chance_and_on_save_through() -> T {
    let landing = ConditionOptions {
        rider: RiderOptions {
            landing: Some(SaveLanding::Damage),
            ..RiderOptions::default()
        },
        optional: true,
        ..ConditionOptions::default()
    };
    let cold = EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    of: strings(&["attack 1"]),
                    ..RiderOptions::default()
                },
                dealing: Some("cold".to_string()),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
        ..EveryHitOptions::default()
    };
    let crit = ConditionOptions {
        chance: Some(0.4),
        on_save: Some(vec![vulnerability().until_next_hit()]),
        ..ConditionOptions::default()
    };
    let t = turn(vec![typed_sword()?, typed_sword()?], 0.0)?
        .on_first_hit_with(
            prone().until_end_of_turn(),
            FirstHitOptions {
                condition: landing,
                ..FirstHitOptions::default()
            },
        )?
        .on_every_hit_with(save_penalty(&d4())?.until_next_save(), cold)?
        .on_any_crit_with(stunned().until_end_of_turn(), crit)?;
    let expected = vec![
        ConditionSpec {
            landing: Some(SaveLanding::Damage),
            optional: true,
            ..cond(hit(AttackTriggerOn::FirstHit), both(), vec![prone_spec()?])
        },
        ConditionSpec {
            dealing: Some("cold".to_string()),
            ..cond(
                hit(AttackTriggerOn::EveryHit),
                strings(&["attack 1"]),
                vec![EffectSpec::SavePenalty {
                    count: 1.0,
                    sides: 4.0,
                    until: SaveUntil::NextSave,
                    to: None,
                }],
            )
        },
        ConditionSpec {
            chance: Some(0.4),
            on_save: Some(vec![EffectSpec::Vulnerability]),
            ..cond(
                hit(AttackTriggerOn::AnyCrit),
                both(),
                vec![EffectSpec::Condition {
                    condition: "stunned".to_string(),
                    rule: rule_of(ConditionName::Stunned)?,
                    until: ConditionUntil::EndOfTurn,
                }],
            )
        },
    ];
    assert_conditions(&t.inspect_spec(), &expected);
    Ok(())
}

#[test]
fn damage_and_effects_in_one_call_happens_goes_on_the_rider_the_rest_on_the_condition() -> T {
    let sneak = rs(3.0, 6.0)?;
    let t = turn(vec![typed_sword()?, typed_sword()?], 0.0)?.on_first_hit_with(
        Effect::List(vec![
            EffectPart::Damage(DamageSource::Roll(sneak.clone())),
            EffectPart::Grant(prone().until_end_of_turn()),
        ]),
        FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    id: Some("sneak".to_string()),
                    ..RiderOptions::default()
                },
                dealing: Some("piercing".to_string()),
                happens: Some(0.5),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;
    let spec = t.inspect_spec();
    let riders = spec.riders.clone().unwrap_or_default();
    let expected = Rider {
        trigger: Trigger::FirstHit {
            of: both(),
            per_source: None,
        },
        id: Some("sneak".to_string()),
        happens: Some(0.5),
        ..plain_rider(RiderDamageSpec::Plain(RiderDamage::Many(vec![
            DamageSource::Roll(sneak),
        ])))
    };
    assert_eq!(format!("{riders:#?}"), format!("{:#?}", vec![expected]));
    let expected = ConditionSpec {
        dealing: Some("piercing".to_string()),
        ..cond(hit(AttackTriggerOn::FirstHit), both(), vec![prone_spec()?])
    };
    assert_conditions(&spec, &[expected]);
    Ok(())
}

#[test]
fn happens_on_a_damage_only_call() -> T {
    let sneak = rs(3.0, 6.0)?;
    let t = turn(vec![atk(sword()?)], 0.0)?.on_first_hit_with(
        sneak.clone(),
        FirstHitOptions {
            condition: ConditionOptions {
                happens: Some(0.5),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;
    let riders = t.inspect_spec().riders.unwrap_or_default();
    let expected = Rider {
        trigger: Trigger::FirstHit {
            of: strings(&["attack 1"]),
            per_source: None,
        },
        happens: Some(0.5),
        ..plain_rider(RiderDamageSpec::Plain(RiderDamage::One(
            DamageSource::Roll(sneak),
        )))
    };
    assert_eq!(format!("{riders:#?}"), format!("{:#?}", vec![expected]));
    Ok(())
}

#[test]
fn a_condition_may_watch_where_a_rider_landed() -> T {
    let save = GrantSaveSpec::Dc {
        ability: Some("con".to_string()),
        dc: 15.0,
        bonus: 2.0,
        roll_type: None,
    };
    let t = turn(vec![atk(melee_sword()?), atk(melee_sword()?)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_first_hit_with(
            prone().until_end_of_turn(),
            FirstHitOptions {
                condition: ConditionOptions {
                    rider: RiderOptions {
                        of: strings(&["sneak"]),
                        ..RiderOptions::default()
                    },
                    save: Some(TriggerSaves::One(TriggerSave::Spec(save.clone()))),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
        )?;
    let expected = ConditionSpec {
        save: Some(GrantSaves::One(save)),
        ..cond(
            hit(AttackTriggerOn::FirstHit),
            strings(&["sneak"]),
            vec![prone_spec()?],
        )
    };
    assert_conditions(&t.inspect_spec(), &[expected]);
    Ok(())
}

#[test]
fn at_start_an_effect_without_a_lifetime_lasts_the_turn() -> T {
    let aimed = Attack::Declared {
        options: AttackOptions {
            target: Some("ogre".to_string()),
            ..AttackOptions::default()
        },
        source: Source::from(sword()?),
    };
    let t = turn(vec![atk(sword()?), aimed], 0.0)?
        .at_start(vec![StartEffect::Condition(restrained())], None)?
        .at_start(
            vec![StartEffect::Lasting(vulnerability().until_next_hit())],
            Some("ogre"),
        )?
        .at_start(
            vec![
                StartEffect::Modifiers(advantage().crit_on_hit()),
                StartEffect::SaveModifier(save_disadvantage()),
            ],
            None,
        )?;
    let expected = vec![
        cond(
            ConditionOn::Start,
            None,
            vec![EffectSpec::Condition {
                condition: "restrained".to_string(),
                rule: rule_of(ConditionName::Restrained)?,
                until: ConditionUntil::EndOfTurn,
            }],
        ),
        ConditionSpec {
            target: Some("ogre".to_string()),
            ..cond(ConditionOn::Start, None, vec![EffectSpec::Vulnerability])
        },
        cond(
            ConditionOn::Start,
            None,
            vec![
                EffectSpec::Grant(GrantSpec {
                    advantage: true,
                    disadvantage: false,
                    crit_on_hit: true,
                    until: GrantUntil::EndOfTurn,
                    to: None,
                }),
                EffectSpec::SaveDisadvantage {
                    until: SaveUntil::EndOfTurn,
                    to: None,
                },
            ],
        ),
    ];
    assert_conditions(&t.inspect_spec(), &expected);
    Ok(())
}

#[test]
fn state_limit_sets_the_turns() -> T {
    let t = turn(vec![atk(sword()?)], 0.0)?.state_limit(4096.0)?;
    assert_eq!(t.inspect_spec().state_limit, Some(4096.0));
    Ok(())
}

#[test]
fn evaluates_every_new_field_and_names_what_a_source_cannot_say() -> T {
    let base =
        || -> Result<Turn, Box<dyn std::error::Error>> { Ok(turn(vec![atk(sword()?)], 0.0)?) };
    assert_eq!(code_of(base()?.state_limit(4096.0)), "none");
    // Prone differs by range, and this sword declares none.
    assert_eq!(
        code_of(base()?.at_start(vec![StartEffect::Condition(prone())], None)),
        "unknown-range"
    );
    // A builder cannot say the odds it deals cold (ContextualSource.dealt).
    assert_eq!(
        code_of(base()?.on_first_hit_with(
            crit_on_hit().until_end_of_turn(),
            FirstHitOptions {
                condition: ConditionOptions {
                    dealing: Some("cold".to_string()),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
        )),
        "not-an-attack"
    );
    assert_eq!(
        code_of(base()?.on_first_hit_with(
            d6(),
            FirstHitOptions {
                condition: ConditionOptions {
                    happens: Some(0.5),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
        )),
        "none"
    );
    Ok(())
}

// ---- saves on a trigger -------------------------------------------------------------------------

fn grant_of_turn() -> Lasting {
    advantage().until_end_of_turn().into()
}

fn grants_expected() -> Vec<EffectSpec> {
    vec![EffectSpec::Grant(GrantSpec {
        advantage: true,
        disadvantage: false,
        crit_on_hit: false,
        until: GrantUntil::EndOfTurn,
        to: None,
    })]
}

fn with_save(save: TriggerSaves) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![atk(sword()?)], 0.0)?.on_first_hit_with(
        grant_of_turn(),
        FirstHitOptions {
            condition: ConditionOptions {
                save: Some(save),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?)
}

#[test]
fn a_dc_check_without_an_ability_is_a_plain_save_rolled_in_the_targets_state() -> T {
    let t = with_save(TriggerSaves::One(TriggerSave::Dc(
        d20().plus(2.0)?.dc(15.0)?,
    )))?;
    let expected = ConditionSpec {
        save: Some(GrantSaves::One(GrantSaveSpec::Dc {
            ability: None,
            dc: 15.0,
            bonus: 2.0,
            roll_type: None,
        })),
        ..cond(
            hit(AttackTriggerOn::FirstHit),
            strings(&["attack 1"]),
            grants_expected(),
        )
    };
    assert_conditions(&t.inspect_spec(), &[expected]);
    Ok(())
}

#[test]
fn a_dc_check_that_names_an_ability_is_a_state_aware_grant_save_spec() -> T {
    let con = d20().plus(2.0)?.dc(15.0)?.ability("con")?;
    let dex = d20()
        .plus(1.0)?
        .with_advantage()?
        .dc(14.0)?
        .ability("dex")?;
    let t = with_save(TriggerSaves::One(TriggerSave::Dc(con.clone())))?;
    let expected = ConditionSpec {
        save: Some(GrantSaves::One(GrantSaveSpec::Dc {
            ability: Some("constitution".to_string()),
            dc: 15.0,
            bonus: 2.0,
            roll_type: None,
        })),
        ..cond(
            hit(AttackTriggerOn::FirstHit),
            strings(&["attack 1"]),
            grants_expected(),
        )
    };
    assert_conditions(&t.inspect_spec(), &[expected]);
    let t = with_save(TriggerSaves::Many(vec![
        TriggerSave::Dc(con),
        TriggerSave::Dc(dex),
    ]))?;
    let expected = ConditionSpec {
        save: Some(GrantSaves::Many(vec![
            GrantSaveSpec::Dc {
                ability: Some("constitution".to_string()),
                dc: 15.0,
                bonus: 2.0,
                roll_type: None,
            },
            GrantSaveSpec::Dc {
                ability: Some("dexterity".to_string()),
                dc: 14.0,
                bonus: 1.0,
                roll_type: Some(crate::common::RollType::Advantage),
            },
        ])),
        ..cond(
            hit(AttackTriggerOn::FirstHit),
            strings(&["attack 1"]),
            grants_expected(),
        )
    };
    assert_conditions(&t.inspect_spec(), &[expected]);
    Ok(())
}

#[test]
fn a_plain_grant_save_spec_or_a_list_mixing_one_with_a_dc_check_passes_through() -> T {
    let fail_chance = FailChance::new(|_| Ok(0.3));
    let t = with_save(TriggerSaves::Many(vec![
        TriggerSave::Spec(GrantSaveSpec::FailChance {
            ability: Some("str".to_string()),
            fail_chance: fail_chance.clone(),
        }),
        TriggerSave::Dc(d20().plus(3.0)?.dc(12.0)?),
    ]))?;
    let conditions = conditions_of(&t);
    assert_eq!(conditions.len(), 1);
    let c = &conditions[0];
    assert_eq!(c.grants, grants_expected());
    assert_eq!(c.of, strings(&["attack 1"]));
    let Some(GrantSaves::Many(saves)) = &c.save else {
        return Err(DiceError::error("save is a list").into());
    };
    assert_eq!(saves.len(), 2);
    let GrantSaveSpec::FailChance {
        ability,
        fail_chance: passed,
    } = &saves[0]
    else {
        return Err(DiceError::error("the first save keeps its failChance").into());
    };
    assert_eq!(ability.as_deref(), Some("str"));
    // The same function, not a copy.
    assert!(Arc::ptr_eq(&passed.0, &fail_chance.0));
    let GrantSaveSpec::Dc {
        ability: None,
        dc,
        bonus,
        roll_type: None,
    } = &saves[1]
    else {
        return Err(DiceError::error("the second save is a plain DC").into());
    };
    assert_eq!((*dc, *bonus), (12.0, 3.0));
    Ok(())
}

// ---- triggers attached to builders -----------------------------------------------------------

#[test]
fn an_attack_carries_on_first_crit_with_its_options() -> T {
    let shove = sword()?.on_first_crit_with(
        Grants::One(prone().until_end_of_turn()),
        Some(ConditionGate {
            dealing: Some("bludgeoning".to_string()),
            ..ConditionGate::default()
        }),
    )?;
    assert_eq!(shove.attached.len(), 1);
    let AttachedCondition { on, grants, gate } = &shove.attached[0];
    assert_eq!(*on, AttachedOn::FirstCrit);
    assert_eq!(grants, &vec![prone().until_end_of_turn()]);
    let Some(gate) = gate else {
        return Err(DiceError::error("the attachment has a gate").into());
    };
    assert_eq!(gate.dealing.as_deref(), Some("bludgeoning"));
    assert!(gate.save.is_none() && gate.chance.is_none() && gate.on_save.is_none());
    assert!(gate.landing.is_none() && !gate.optional && gate.target_has.is_none());
    assert_eq!(code_of(turn(vec![atk(shove)], 0.0)), "not-an-attack");
    Ok(())
}

#[test]
fn on_save_failure_takes_effects_beside_its_damage_every_hit_on_this_save_landing_fail() -> T {
    let check = d20().plus(2.0)?.dc(15.0)?;
    let fireball = check.on_save_failure_effects(&[
        FailurePart::Damage(Arg::Roll(rs(8.0, 6.0)?)),
        FailurePart::Effect(prone().until_end_of_turn()),
    ])?;
    assert_eq!(
        fireball.to_expression()?,
        check
            .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
            .to_expression()?
    );
    let check_attached = |attached: &[AttachedCondition]| -> T {
        assert_eq!(attached.len(), 1);
        assert_eq!(attached[0].on, AttachedOn::EveryHit);
        assert_eq!(attached[0].grants, vec![prone().until_end_of_turn()]);
        let gate = attached[0]
            .gate
            .as_ref()
            .ok_or("the attachment has a gate")?;
        assert_eq!(gate.landing, Some(SaveLanding::Fail));
        assert!(gate.save.is_none() && gate.chance.is_none() && gate.dealing.is_none());
        Ok(())
    };
    check_attached(&fireball.attached)?;
    check_attached(&fireball.save_half()?.attached)?;
    assert_eq!(code_of(turn(vec![atk(fireball)], 0.0)), "none");
    Ok(())
}

#[test]
fn attachments_from_0_16_still_build() -> T {
    let chanced = sword()?.on_every_hit_with(
        Grants::One(advantage().until_next_attack().into()),
        Some(ConditionGate {
            chance: Some(0.5),
            ..ConditionGate::default()
        }),
    )?;
    assert_eq!(
        code_of(turn(vec![atk(chanced), atk(sword()?)], 0.0)),
        "none"
    );
    Ok(())
}
