//! Translated TS tests (validation): the `buildPlan` cases that assert a `TurnSpecError` code,
//! message, `RangeError` or `Error` on `Turn.from(spec)`, plus the structural ones (ids, groups).
//!
//! Sources: tests/turn-validation.test.ts, src/turn/contractV2.test.ts (lines 59-78),
//! tests/turn-spec-default-of.test.ts, tests/turn-chance.test.ts,
//! tests/condition-review-regressions.test.ts, tests/condition-trigger-options.test.ts,
//! src/turn/target-has.test.ts, src/turn/target-has-scale.test.ts, src/turn/after-rider.test.ts.
//!
//! Deferred, needs `Turn` (mean / pmf / fireProbability / sample / marginal):
//! - tests/turn-validation.test.ts:36-43 (fireProbability unknown-id), 80-257 (ids and defaults:
//!   means, pmf outcomes, attribution chart, mass-1 normalisation, repeated source ids),
//!   311-319 (also type-level), 358-368 (fireProbability), 383-391 (mean), 427-430 and 455-461
//!   (chance mean; the chance-accepted spec itself is built below).
//! - tests/turn-spec-default-of.test.ts:15-45 (mean, fireProbability, pmf).
//! - tests/turn-chance.test.ts:46-94, 100-214 (means, oracles, marginals, charts).
//! - tests/condition-review-regressions.test.ts:11-69, 91-123, 145-158, 174-182, 186-191, 199-203
//!   (means, fireProbability, builder-only facts).
//! - tests/condition-trigger-options.test.ts:30-52, 71-90 (means, fireProbability) and 95-107
//!   `joins` of a pooling source reading `context.joined` (mean).
//! - src/turn/target-has.test.ts:74-310 (oracle means), 312-345 (JSON means).
//! - src/turn/after-rider.test.ts:44-258, 319-338 (means, samples, marginals, pmf diffs).
//!
//! Deferred, type-level (no Rust counterpart):
//! - tests/turn-validation.test.ts:394-414 (a `"1d6"` source, `toPMF` returning a non-PMF),
//!   417-425 (unknown key), 432-453 (non-string ids), 456 (`id: 5`).
//! - src/turn/contractV2.test.ts:96-98 (unknown attack key).
//! - tests/condition-review-regressions.test.ts:160-163 (`sanity` ability key: a typed rule),
//!   193-197 (`keepBestDamage()` transform as a trigger-verb payload: a `DamageSource` cannot be
//!   one), 133 (trigger verb with a `target` option).
//! - tests/condition-trigger-options.test.ts:30-33 (a grant rider's `joins`: no such option).
//! - src/turn/target-has.test.ts:350 (`7` as a targetHas name), 349 (fluent).
//! - src/turn/after-rider.test.ts:313-317 (`landing: "never"`: `AfterLanding` is an enum).

use super::test_support::*;
use super::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::common::RollType;
use crate::dnd5e::{ConditionName, rule};
use crate::turn::context::{ContextualSource, RowCheck, RowContext};
use crate::turn::types::{
    After, AfterLanding, ArcContextual, Attack, AttackOptions, AttackRule, AttackRuleModifier,
    AttackTriggerOn, ConditionOn, ConditionRule, ConditionSpec, ConditionUntil, DamageSource,
    EffectSpec, GrantSaveSpec, GrantSaves, GrantSpec, GrantUntil, Rider, RiderDamage,
    RiderDamageSpec, RiderLanding, SaveLanding, SaveRuleModifier, Source, TurnSpec,
    TurnSpecErrorCode,
};
use indexmap::IndexMap;
use std::sync::Arc;

fn src(builder: crate::builder::roll::RollBuilder) -> Source {
    Source::from(DamageSource::from(builder))
}

/// `{ on, grants }`.
fn condition(on: ConditionOn, grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: None,
        on,
        of: None,
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

/// `{ advantage: true, until }`.
fn advantage(until: GrantUntil) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: true,
        disadvantage: false,
        crit_on_hit: false,
        until,
        to: None,
    })
}

/// `{ condition: name, rule: RULES[name], until: "end-of-turn" }`.
fn condition_effect(name: ConditionName) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.as_str().to_string(),
        rule: rule(name).unwrap_or_default(),
        until: ConditionUntil::EndOfTurn,
    }
}

fn with_conditions(
    attacks: Vec<Attack>,
    riders: Vec<Rider>,
    conditions: Vec<ConditionSpec>,
) -> TurnSpec {
    TurnSpec {
        conditions: Some(conditions),
        ..spec(attacks, riders)
    }
}

/// `{ id, source, after }`.
fn gated(id: &str, source: Source, of: &str, landing: AfterLanding) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            after: Some(After {
                of: of.to_string(),
                landing,
            }),
            ..AttackOptions::default()
        },
        source,
    }
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(std::string::ToString::to_string).collect()
}

fn d6s() -> RollBuilder {
    d6()
}

// --- tests/turn-validation.test.ts -------------------------------------------------------------

#[test]
fn unknown_id_a_trigger_names_something_that_is_not_in_the_turn() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![rider_id("sneak", first_hit(Some(&["gone"])), d6s())],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::UnknownId);
    assert_eq!(e.id, "gone");
    assert_eq!(
        e.message,
        "\"sneak\" depends on \"gone\", which is not in this turn."
    );
    Ok(())
}

#[test]
fn unknown_id_not_fired_names_something_that_is_not_a_rider() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![rider(not_fired("d1"), d6s())],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::UnknownId);
    assert_eq!(e.id, "d1");
    assert_eq!(
        e.message,
        "Rider \"rider 1\" negates \"d1\", which is not a rider or substitute in this turn."
    );
    Ok(())
}

#[test]
fn duplicate_id() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?), attack_id("d1", dagger()?)],
        vec![],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::DuplicateId);
    Ok(())
}

#[test]
fn self_reference() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![rider_id("sneak", not_fired("sneak"), d6s())],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::SelfReference);
    assert_eq!(e.id, "sneak");
    assert_eq!(e.message, "Rider \"sneak\" cannot depend on itself.");
    Ok(())
}

#[test]
fn cycle() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![
            rider_id("a", not_fired("b"), d6s()),
            rider_id("b", not_fired("a"), d6s()),
        ],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::Cycle);
    assert_eq!(e.id, "a");
    assert_eq!(e.message, "\"a\" is part of a dependency cycle.");
    Ok(())
}

#[test]
fn not_an_attack_a_hit_trigger_names_a_pure_damage_rider() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![
            rider_id("sneak", first_hit(None), rs(3.0, 6.0)?),
            rider_id("extra", first_hit(Some(&["sneak"])), d6s()),
        ],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::NotAnAttack);
    assert_eq!(e.id, "sneak");
    assert_eq!(
        e.message,
        "\"extra\" triggers on \"sneak\", which has no hit/crit outcomes."
    );
    Ok(())
}

#[test]
fn too_many_groups() -> T {
    let mut attacks = Vec::new();
    let mut riders = Vec::new();
    for i in 0..(crate::turn::types::MAX_TRIGGER_GROUPS + 1) {
        let id = format!("a{i}");
        attacks.push(attack_id(&id, dagger()?));
        riders.push(rider_id(
            &format!("r{i}"),
            first_hit(Some(&[id.as_str()])),
            d6s(),
        ));
    }
    assert_eq!(
        code_of(plan_of(&spec(attacks, riders))),
        TurnSpecErrorCode::TooManyGroups
    );
    Ok(())
}

#[test]
fn names_bare_attacks_in_declaration_order() -> T {
    let s = spec(
        vec![bare(dagger()?), bare(dagger()?)],
        vec![rider_id("sneak", first_hit(Some(&["attack 2"])), d6s())],
    );
    let plan = plan_of(&s).map_err(|e| e.to_string())?;
    assert_eq!(plan.attack_ids, names(&["attack 1", "attack 2"]));
    assert_eq!(plan.rider_ids, names(&["sneak"]));
    Ok(())
}

#[test]
fn shares_one_group_between_riders_with_the_same_sources() -> T {
    let s = spec(
        vec![bare(dagger()?), bare(dagger()?)],
        vec![
            rider(first_hit(None), rs(3.0, 6.0)?),
            rider(first_hit(None), d6s()),
        ],
    );
    let plan = plan_of(&s).map_err(|e| e.to_string())?;
    assert_eq!(plan.group_count, 1);
    Ok(())
}

#[test]
fn rejects_not_fired_against_an_every_hit_rider() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![
            rider_id("mark", every_hit(None), d6s()),
            rider(not_fired("mark"), d6s()),
        ],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::NotAnAttack);
    assert_eq!(e.id, "mark");
    assert_eq!(
        e.message,
        "Rider \"rider 2\" negates \"mark\", an every-hit rider, which can fire more than once and so has no single \"did not fire\" branch."
    );
    Ok(())
}

#[test]
fn rejects_a_hit_trigger_against_an_every_hit_rider_even_an_attack_shaped_one() -> T {
    let bonus = attack_of(8.0, 16.0, d6s().plus(4.0)?)?;
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![
            rider_id("bonus", every_hit(None), bonus),
            rider(first_hit(Some(&["bonus"])), d6s()),
        ],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::NotAnAttack);
    assert_eq!(e.id, "bonus");
    Ok(())
}

#[test]
fn still_allows_referencing_a_non_every_hit_rider() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![
            rider_id("smite", any_crit(None), d6s()),
            rider_id("fallback", not_fired("smite"), d6s()),
        ],
    );
    let plan = plan_of(&s).map_err(|e| e.to_string())?;
    assert_eq!(plan.rider_ids, names(&["smite", "fallback"]));
    assert!(plan.fire_slots.contains_key("smite"));
    assert!(plan.fire_slots.contains_key("fallback"));
    Ok(())
}

#[test]
fn does_not_spend_a_trigger_group_on_a_duplicate_only_difference() -> T {
    let attacks = vec![attack_id("a", dagger()?), attack_id("b", dagger()?)];
    // ["a"] and ["a","a"] name the same set, so these are 3 groups, not 5.
    let sets: [&[&str]; 5] = [&["a"], &["a", "a"], &["b"], &["b", "b"], &["a", "b"]];
    let riders = sets
        .iter()
        .map(|of| rider(first_hit(Some(of)), d6s()))
        .collect();
    let plan = plan_of(&spec(attacks, riders)).map_err(|e| e.to_string())?;
    assert_eq!(plan.group_count, 3);
    Ok(())
}

#[test]
fn treats_a_repeated_source_id_as_one_source() -> T {
    let attacks = vec![attack_id("a", dagger()?), attack_id("b", dagger()?)];
    let plain = plan_of(&spec(
        attacks.clone(),
        vec![rider(first_hit(Some(&["a", "b"])), d6s())],
    ))
    .map_err(|e| e.to_string())?;
    let repeated = plan_of(&spec(
        attacks,
        vec![rider(first_hit(Some(&["a", "b", "b", "a"])), d6s())],
    ))
    .map_err(|e| e.to_string())?;
    assert_eq!(plain.group_count, repeated.group_count);
    assert_eq!(plain.steps.len(), repeated.steps.len());
    Ok(())
}

#[test]
fn validates_every_construction_path_the_same_way() -> T {
    let s = spec(
        vec![attack_id("d1", dagger()?)],
        vec![rider(first_hit(Some(&["x"])), d6s())],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::UnknownId);
    let s = spec(
        vec![bare(dagger()?)],
        vec![rider(first_hit(Some(&["x"])), d6s())],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::UnknownId);
    Ok(())
}

#[test]
fn names_bare_attacks_and_anonymous_riders_in_declaration_order() -> T {
    let s = spec(
        vec![bare(dagger()?), bare(dagger()?)],
        vec![
            rider(first_hit(None), d6s()),
            rider_id("smite", any_crit(None), d6s()),
            rider(every_hit(None), d6s()),
        ],
    );
    let plan = plan_of(&s).map_err(|e| e.to_string())?;
    assert_eq!(plan.attack_ids, names(&["attack 1", "attack 2"]));
    assert_eq!(plan.rider_ids, names(&["rider 1", "smite", "rider 3"]));
    Ok(())
}

#[test]
fn is_rejected_rather_than_silently_dropped() -> T {
    let greatsword = attack_of(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    let mut r = rider(any_crit(None), greatsword.clone());
    r.crit_damage = Some(RiderDamage::One(DamageSource::from(rs(20.0, 6.0)?)));
    let s = spec(vec![bare(greatsword.clone()), bare(greatsword)], vec![r]);
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::UnusedCritDamage);
    Ok(())
}

#[test]
fn accepts_the_chance_key_it_previously_ignored() -> T {
    let s = spec(
        vec![Attack::Declared {
            options: AttackOptions {
                chance: Some(0.5),
                ..AttackOptions::default()
            },
            source: Source::from(dagger()?),
        }],
        vec![],
    );
    assert!(plan_of(&s).is_ok());
    Ok(())
}

// --- src/turn/contractV2.test.ts ---------------------------------------------------------------

fn sword5() -> Result<AttackBuilder, DiceError> {
    attack_of(5.0, 12.0, d8().plus(3.0)?)
}

#[test]
fn a_riders_where_must_name_a_partner_in_its_of() -> T {
    let mut r = rider_id("smite", first_hit(None), rs(2.0, 8.0)?);
    r.r#where = Some(IndexMap::from([("attack 1".to_string(), Vec::new())]));
    let e = refusal(plan_of(&spec(vec![bare(sword5()?)], vec![r])));
    assert_eq!(e.id, "attack 1");
    assert_eq!(e.code, TurnSpecErrorCode::UnknownId);
    assert_eq!(
        e.message,
        "Rider \"smite\" has \"where\" for \"attack 1\", which is not a partner in its \"of\"."
    );
    Ok(())
}

#[test]
fn a_conditions_where_must_name_the_rider_in_its_of() -> T {
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::EveryHit),
        vec![advantage(GrantUntil::NextAttack)],
    );
    c.r#where = Some(IndexMap::from([("attack 1".to_string(), Vec::new())]));
    let s = with_conditions(vec![bare(sword5()?)], vec![], vec![c]);
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::UnknownId);
    assert_eq!(
        e.message,
        "Condition \"condition 1\" has \"where\" for \"attack 1\", which is not the rider in its \"of\"."
    );
    Ok(())
}

#[test]
fn dealing_needs_a_source_that_can_say_the_odds_it_deals_the_type() -> T {
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::EveryHit),
        vec![advantage(GrantUntil::NextAttack)],
    );
    c.dealing = Some("fire".to_string());
    let s = with_conditions(vec![bare(sword5()?)], vec![], vec![c]);
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::NotAnAttack);
    assert_eq!(e.id, "attack 1");
    Ok(())
}

// --- tests/turn-chance.test.ts -----------------------------------------------------------------

#[test]
fn rejects_a_chance_outside_0_1() -> T {
    for chance in [1.5, -0.1] {
        let s = spec(
            vec![Attack::Declared {
                options: AttackOptions {
                    chance: Some(chance),
                    ..AttackOptions::default()
                },
                source: Source::from(attack_of(8.0, 16.0, flat(5.0)?)?),
            }],
            vec![],
        );
        assert!(matches!(other_error(plan_of(&s)), DiceError::Range(_)));
    }
    Ok(())
}

// --- tests/condition-review-regressions.test.ts ------------------------------------------------

fn melee_sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

#[test]
fn a_trigger_condition_naming_a_target_is_a_turn_spec_error() -> T {
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::FirstHit),
        vec![advantage(GrantUntil::EndOfTurn)],
    );
    c.target = Some("target".to_string());
    let s = with_conditions(vec![bare(melee_sword()?)], vec![], vec![c]);
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert_eq!(
        e.message,
        "Condition \"condition 1\" names a target, which only a \"start\" condition takes: the others are on the creature of the row that lands them."
    );
    Ok(())
}

#[test]
fn at_starts_target_must_be_a_creature_some_row_is_aimed_at() -> T {
    let start = |target: &str| {
        let mut c = condition(
            ConditionOn::Start,
            vec![condition_effect(ConditionName::Prone)],
        );
        c.target = Some(target.to_string());
        c
    };
    let one = vec![bare(melee_sword()?)];
    let e = refusal(plan_of(&with_conditions(
        one.clone(),
        vec![],
        vec![start("secnod")],
    )));
    assert_eq!(e.code, TurnSpecErrorCode::UnknownId);
    assert_eq!(
        e.message,
        "Condition \"condition 1\" starts on \"secnod\", which no attack is aimed at. Name \"target\" or an attack's target."
    );
    assert!(plan_of(&with_conditions(one, vec![], vec![start("target")])).is_ok());
    let aimed = Attack::Declared {
        options: AttackOptions {
            target: Some("second".to_string()),
            ..AttackOptions::default()
        },
        source: Source::from(melee_sword()?),
    };
    let two = vec![bare(melee_sword()?), aimed];
    assert!(plan_of(&with_conditions(two, vec![], vec![start("second")])).is_ok());
    Ok(())
}

fn joins_rider(joined: &str) -> Rider {
    let mut r = rider_id(
        "sa",
        first_hit(Some(&["attack 1", "attack 2"])),
        rs(2.0, 6.0).unwrap_or_else(|_| d6()),
    );
    r.joins = Some(vec![joined.to_string()]);
    r
}

#[test]
fn joins_on_a_row_whose_source_cannot_pool_the_riders_dice_is_a_turn_spec_error() -> T {
    let m = d20()
        .plus(5.0)?
        .ac(15.0)?
        .melee()?
        .on_hit(d8().plus(3.0)?)?;
    let s = spec(
        vec![bare(m.clone()), bare(m)],
        vec![joins_rider("attack 1")],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::NoRebindableSource);

    let save = d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("con")?
        .on_save_failure_args(&[Arg::Roll(rs(2.0, 6.0)?)])?;
    let mut r = rider_id("r", first_hit(None), d6s());
    r.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    r.joins = Some(names(&["attack 1"]));
    let e = refusal(plan_of(&spec(vec![bare(save)], vec![r])));
    assert_eq!(e.code, TurnSpecErrorCode::NoRebindableSource);
    assert_eq!(e.id, "attack 1");
    Ok(())
}

// --- tests/condition-trigger-options.test.ts ---------------------------------------------------

/// A source that pools joined riders' dice into its row (`under` ignores them here: only the
/// validation reads it).
struct Pooling(AttackBuilder);

impl ContextualSource for Pooling {
    fn row_check(&self) -> RowCheck {
        self.0.row_check()
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.0.under(context, eps)
    }
}

fn pooling() -> Result<Source, DiceError> {
    Ok(Source::Contextual(ArcContextual(Arc::new(Pooling(
        melee_sword()?,
    )))))
}

#[test]
fn a_row_the_rider_does_not_watch_is_unknown_id() -> T {
    let mut r = rider_id("a", first_hit(Some(&["attack 1"])), d6s());
    r.joins = Some(names(&["attack 1"]));
    let ok = spec(vec![bare(pooling()?), bare(pooling()?)], vec![r.clone()]);
    assert!(plan_of(&ok).is_ok());
    r.joins = Some(names(&["attack 2"]));
    let bad = spec(vec![bare(pooling()?), bare(pooling()?)], vec![r]);
    let e = refusal(plan_of(&bad));
    assert_eq!(e.code, TurnSpecErrorCode::UnknownId);
    assert_eq!(e.id, "attack 2");
    assert_eq!(
        e.message,
        "Rider \"a\" joins \"attack 2\", which it does not watch: a rider's dice join a row only where it can land."
    );
    Ok(())
}

#[test]
fn a_not_fired_rider_has_no_row_to_join() -> T {
    let first = rider_id("a", first_hit(Some(&["attack 1"])), d6s());
    let mut second = rider_id("b", not_fired("a"), d6s());
    second.joins = Some(names(&["attack 2"]));
    let s = spec(
        vec![bare(pooling()?), bare(pooling()?)],
        vec![first, second],
    );
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert_eq!(
        e.message,
        "Rider \"b\" joins rows but watches a rider, not attacks: it has no row to roll in."
    );
    Ok(())
}

fn trigger_save(roll_type: Option<RollType>) -> GrantSaves {
    GrantSaves::One(GrantSaveSpec::Dc {
        ability: None,
        dc: 15.0,
        bonus: 1.0,
        roll_type,
    })
}

#[test]
fn a_check_that_names_no_ability_where_a_rule_reads_saves_by_ability_is_save_without_ability() -> T
{
    let start = condition(
        ConditionOn::Start,
        vec![condition_effect(ConditionName::Restrained)],
    );
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::FirstHit),
        vec![EffectSpec::Vulnerability],
    );
    c.id = Some("c".to_string());
    c.save = Some(trigger_save(None));
    let s = with_conditions(
        vec![bare(melee_sword()?), bare(melee_sword()?)],
        vec![],
        vec![start, c],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::SaveWithoutAbility);
    Ok(())
}

#[test]
fn a_save_with_elven_accuracy_is_refused_at_build_time() -> T {
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::FirstHit),
        vec![advantage(GrantUntil::EndOfTurn)],
    );
    c.save = Some(GrantSaves::One(GrantSaveSpec::Dc {
        ability: None,
        dc: 15.0,
        bonus: 2.0,
        roll_type: Some(RollType::ElvenAccuracy),
    }));
    let s = with_conditions(
        vec![bare(melee_sword()?), bare(melee_sword()?)],
        vec![],
        vec![c],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::UnsupportedTrigger);
    Ok(())
}

// --- src/turn/target-has.test.ts, target-has-scale.test.ts -------------------------------------

fn fear_save() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("wis")?
        .on_save_failure_args(&[Arg::Num(0.0)])
}

fn target_sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(7.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

/// C1: Frightened by a failed save, then two swords, a rider on each hit of a frightened target.
fn fear_spec(rider_edit: impl FnOnce(&mut Rider)) -> Result<TurnSpec, DiceError> {
    let mut r = rider_id("rider", every_hit(Some(&["a", "b"])), flat(4.0)?);
    r.target_has = Some(names(&["frightened"]));
    rider_edit(&mut r);
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::EveryHit),
        vec![condition_effect(ConditionName::Frightened)],
    );
    c.of = Some(names(&["fear"]));
    c.landing = Some(SaveLanding::Fail);
    Ok(with_conditions(
        vec![
            attack_id("fear", fear_save()?),
            attack_id("a", target_sword()?),
            attack_id("b", target_sword()?),
        ],
        vec![r],
        vec![c],
    ))
}

#[test]
fn an_empty_target_has_is_non_string_id() -> T {
    let s = fear_spec(|r| r.target_has = Some(Vec::new()))?;
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::NonStringId);
    Ok(())
}

#[test]
fn target_has_on_an_any_crit_rider_is_unsupported_trigger() -> T {
    let s = fear_spec(|r| {
        r.trigger = any_crit(Some(&["a", "b"]));
    })?;
    let e = refusal(plan_of(&s));
    assert_eq!(e.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert_eq!(
        e.message,
        "Rider \"rider\" has a targetHas on \"any-crit\". Only every-hit and first-hit riders are gated on a condition of the target."
    );
    Ok(())
}

#[test]
fn target_has_on_a_rider_whose_damage_rolls_an_attack_is_unsupported_trigger() -> T {
    let rolls = attack_of(5.0, 15.0, d6s())?;
    let s = fear_spec(|r| r.damage = RiderDamageSpec::Plain(RiderDamage::One(rolls.into())))?;
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::UnsupportedTrigger);
    Ok(())
}

#[test]
fn target_has_on_a_first_hit_grant_is_unsupported_trigger() -> T {
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::FirstHit),
        vec![EffectSpec::Grant(GrantSpec {
            advantage: false,
            disadvantage: false,
            crit_on_hit: true,
            until: GrantUntil::EndOfTurn,
            to: None,
        })],
    );
    c.of = Some(names(&["a"]));
    c.target_has = Some(names(&["prone"]));
    let s = with_conditions(
        vec![
            attack_id("a", target_sword()?),
            attack_id("b", target_sword()?),
        ],
        vec![],
        vec![c],
    );
    assert_eq!(code_of(plan_of(&s)), TurnSpecErrorCode::UnsupportedTrigger);
    Ok(())
}

fn start_rule(rule: ConditionRule) -> ConditionSpec {
    condition(
        ConditionOn::Start,
        vec![EffectSpec::Condition {
            condition: "x".to_string(),
            rule,
            until: ConditionUntil::EndOfTurn,
        }],
    )
}

#[test]
fn refuses_a_d20_penalty_beside_attack_or_save_modifiers() -> T {
    let with_attack = ConditionRule {
        attack: Some(AttackRule {
            melee: Some(vec![AttackRuleModifier::Advantage]),
            ranged: None,
        }),
        d20_penalty: Some(2.0),
        ..ConditionRule::default()
    };
    let with_save = ConditionRule {
        save: Some(IndexMap::from([(
            "dexterity".to_string(),
            vec![SaveRuleModifier::AutoFail],
        )])),
        d20_penalty: Some(2.0),
        ..ConditionRule::default()
    };
    for r in [with_attack, with_save] {
        let s = with_conditions(vec![bare(target_sword()?)], vec![], vec![start_rule(r)]);
        let e = refusal(plan_of(&s));
        assert_eq!(e.code, TurnSpecErrorCode::UnsupportedTrigger);
        assert_eq!(
            e.message,
            "Condition \"condition 1\" has a rule with a d20Penalty and attack or save modifiers. A turn reads a d20Penalty as penalty dice on the saves, so give the modifiers to another rule."
        );
    }
    Ok(())
}

#[test]
fn refuses_a_negative_or_fractional_penalty() -> T {
    for (penalty, shown) in [(-1.0, "-1"), (1.5, "1.5")] {
        let r = ConditionRule {
            d20_penalty: Some(penalty),
            ..ConditionRule::default()
        };
        let con_save = d20()
            .plus(3.0)?
            .dc(15.0)?
            .ability("con")?
            .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?;
        let s = with_conditions(vec![bare(con_save)], vec![], vec![start_rule(r)]);
        match other_error(plan_of(&s)) {
            DiceError::Range(m) => assert_eq!(
                m,
                format!(
                    "Condition \"condition 1\" has a d20Penalty of {shown}; use a whole number of 0 or more."
                )
            ),
            other => panic!("expected a RangeError, got {other:?}"),
        }
    }
    Ok(())
}

/// `spec(names)` of target-has-scale: 31 riders, each gated on its own name.
fn scale_spec(names_of: &[String]) -> Result<TurnSpec, DiceError> {
    let riders = names_of
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let mut r = rider_id(
                &format!("rider {index}"),
                every_hit(Some(&["a", "b"])),
                flat(4.0)?,
            );
            r.target_has = Some(vec![name.clone()]);
            Ok(r)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut c = condition(
        ConditionOn::Attack(AttackTriggerOn::EveryHit),
        vec![condition_effect(ConditionName::Frightened)],
    );
    c.of = Some(names(&["fear"]));
    c.landing = Some(SaveLanding::Fail);
    let save = d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("wis")?
        .on_save_failure_args(&[Arg::Num(0.0)])?;
    let sword = d20()
        .plus(7.0)?
        .ac(16.0)?
        .melee()?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)?;
    Ok(with_conditions(
        vec![
            attack_id("fear", save),
            attack_id("a", sword.clone()),
            attack_id("b", sword),
        ],
        riders,
        vec![c],
    ))
}

#[test]
fn thirty_one_riders_gated_on_frightened_build() -> T {
    let all: Vec<String> = (0..31).map(|_| "frightened".to_string()).collect();
    assert!(plan_of(&scale_spec(&all)?).is_ok());
    Ok(())
}

#[test]
fn thirty_one_riders_on_31_distinct_conditions_are_refused_as_too_many_states() -> T {
    let all: Vec<String> = (0..31).map(|i| format!("invented {i}")).collect();
    assert_eq!(
        code_of(plan_of(&scale_spec(&all)?)),
        TurnSpecErrorCode::TooManyStates
    );
    Ok(())
}

// --- src/turn/after-rider.test.ts --------------------------------------------------------------

fn swing() -> Result<AttackBuilder, DiceError> {
    attack_of(5.0, 14.0, flat(2.0)?)
}

fn row(id: &str) -> Result<Attack, DiceError> {
    Ok(attack_id(id, swing()?))
}

/// Wails from the Grave: an auto-hit 1d6 straight after the rider's damage.
fn wails(of: &str, landing: AfterLanding) -> Result<Attack, DiceError> {
    Ok(gated("wails", src(rs(1.0, 6.0)?), of, landing))
}

fn sneak(of: &[&str]) -> Result<Rider, DiceError> {
    Ok(rider_id("sneak", first_hit(Some(of)), flat(10.0)?))
}

#[test]
fn refuses_a_rider_that_watches_a_row_not_before_the_gated_attack() -> T {
    let before = refusal(plan_of(&spec(
        vec![row("a")?, wails("sneak", AfterLanding::Damage)?, row("b")?],
        vec![sneak(&["a", "b"])?],
    )));
    assert_eq!(before.code, TurnSpecErrorCode::UnknownId);
    assert!(before.message.contains("\"sneak\""));
    assert!(before.message.contains("\"b\""));
    assert!(before.message.contains("does not come before"));
    // Its own `of` left out is every attack, the gated one included.
    let defaulted = refusal(plan_of(&spec(
        vec![
            row("a")?,
            gated("w", Source::from(swing()?), "sneak", AfterLanding::Hit),
        ],
        vec![rider_id("sneak", first_hit(None), flat(10.0)?)],
    )));
    assert_eq!(defaulted.code, TurnSpecErrorCode::UnknownId);
    assert!(defaulted.message.contains("\"w\""));
    Ok(())
}

#[test]
fn refuses_a_rider_that_watches_a_rider_it_resolves_after_every_declared_attack() -> T {
    let s = spec(
        vec![
            row("a")?,
            gated("w", src(flat(1000.0)?), "r2", AfterLanding::Hit),
        ],
        vec![
            rider_id("r1", any_miss(Some(&["a"])), swing()?),
            rider_id("r2", first_hit(Some(&["r1"])), flat(100.0)?),
        ],
    );
    let refused = refusal(plan_of(&s));
    assert_eq!(refused.code, TurnSpecErrorCode::UnknownId);
    assert!(refused.message.contains("\"r2\""));
    assert!(refused.message.contains("\"r1\""));
    Ok(())
}

#[test]
fn names_a_missing_id_as_neither_an_attack_nor_a_rider() -> T {
    let refused = refusal(plan_of(&spec(
        vec![row("a")?, wails("nowhere", AfterLanding::Hit)?],
        vec![],
    )));
    assert_eq!(refused.code, TurnSpecErrorCode::UnknownId);
    assert!(refused.message.contains("\"nowhere\""));
    Ok(())
}

#[test]
fn refuses_a_rider_whose_firing_is_not_one_event_over_attacks() -> T {
    let not_fired_gate = refusal(plan_of(&spec(
        vec![row("a")?, wails("else", AfterLanding::Hit)?],
        vec![
            sneak(&["a"])?,
            rider_id("else", not_fired("sneak"), flat(5.0)?),
        ],
    )));
    assert_eq!(not_fired_gate.code, TurnSpecErrorCode::UnsupportedTrigger);

    let rolls_attack = refusal(plan_of(&spec(
        vec![row("a")?, wails("sneak", AfterLanding::Damage)?],
        vec![rider_id("sneak", first_hit(Some(&["a"])), swing()?)],
    )));
    assert_eq!(rolls_attack.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert!(rolls_attack.message.contains("rolls its own attack"));

    let mut may_not = sneak(&["a"])?;
    may_not.happens = Some(0.5);
    let may_not_happen = refusal(plan_of(&spec(
        vec![row("a")?, wails("sneak", AfterLanding::Damage)?],
        vec![may_not],
    )));
    assert_eq!(may_not_happen.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert!(may_not_happen.message.contains("happens"));
    Ok(())
}

#[test]
fn is_still_unknown_id_for_a_parent_that_does_not_come_before_it() -> T {
    let refused = refusal(plan_of(&spec(
        vec![
            gated("a", Source::from(swing()?), "b", AfterLanding::Hit),
            row("b")?,
        ],
        vec![],
    )));
    assert_eq!(refused.code, TurnSpecErrorCode::UnknownId);
    assert!(refused.message.contains("does not come before it"));
    Ok(())
}
