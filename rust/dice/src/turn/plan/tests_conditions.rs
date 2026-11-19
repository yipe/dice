//! Translated TS tests (conditions): what `buildPlan`'s layout (groups, slots, flags, grants,
//! probes, gates) accepts and refuses.
//!
//! Sources: tests/turn-flags.test.ts, tests/turn-conditions.test.ts, tests/turn-creatures.test.ts,
//! tests/turn-optional.test.ts, tests/turn-saves.test.ts, src/turn/conditions.test.ts,
//! src/turn/save-landing.test.ts, src/turn/probes.test.ts, src/turn/step-stats.test.ts,
//! src/turn/attached.test.ts.
//!
//! Deferred (need `Turn`: mean / pmf / marginal / fireProbability / stepStats / the fluent chain):
//! - tests/turn-flags.test.ts:22-95 (flags against the oracle, `it.each`), :99 (limits: mean,
//!   forty chained grants' mean, stateLimit walk: `too-many-states` of the walk, :135-160),
//!   :160-172 (the no-op `to`: pmf equality; the `unknown-id` and the build are tested here).
//! - tests/turn-conditions.test.ts:22-130 (oracle `it.each`), :133-148 `codeOf` cases of rule
//!   errors are tested here; the `Turn.from(...).mean()` parts are deferred (needs `mean`).
//! - tests/turn-creatures.test.ts:25-61 (oracle `it.each`, fireProbability("start")): needs pmf.
//! - tests/turn-optional.test.ts:42-110 (optional conditions searched by the engine): needs mean.
//! - tests/turn-saves.test.ts:33-60 (oracle), :66 (`failChance` mean equals `chance`): needs mean.
//! - tests/turn-saves.test.ts:89: `{ dc: 10 }` without `bonus`: type-level.
//! - src/turn/conditions.test.ts:49-340 (means), :361 (stateCounts: `inspectTurn`), :420, :430
//!   (means), :449 (scoped mean), :488 (critOnHit mean), :480-486 (a grant given to a verb that
//!   takes none: type-level), :124 (a Modifiers value is not a Grant: type-level).
//! - src/turn/save-landing.test.ts:34-166 (pmf / fireProbability), :185-188 (`landing: "nope"`:
//!   type-level), :197 (`landing` on a transform: `SubstituteSpec` has no `landing`: type-level),
//!   :210-300 (fireProbability / pmf).
//! - src/turn/probes.test.ts:47-170 (fireProbability), :172-212 (fireProbability, chain snapshot:
//!   `attack-after-rider` is a fluent-chain check), :217 (`observe: any-miss`: type-level),
//!   :225 (non-string id: type-level), :239-243 (fireProbability's own errors), :249-274 (`bounce`
//!   chains), :289-334 (fireProbability).
//! - src/turn/step-stats.test.ts:28-134 (all `Turn.stepStats`, including :99 unknown-id).
//! - src/turn/attached.test.ts:12-74 (means), :76 (attached condition on a rider source: see the
//!   test below, kept if the builder API allows it).

use super::test_support::*;
use crate::EPS;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::dnd5e::{ConditionName, rule};
use crate::error::DiceError;
use crate::turn::effects::{
    Lasting, advantage, condition, disadvantage, effect_spec, vulnerability,
};
use crate::turn::types::{
    Attack, AttackTriggerOn, ConditionOn, ConditionRule, ConditionSpec, EffectSpec, GrantSaveSpec,
    GrantSaves, ProbeOn, ProbeSpec, RiderLanding, SaveLanding, SaveRuleModifier, Source,
    SubstituteKind, SubstituteOn, SubstituteSpec, TurnSpec, TurnSpecErrorCode as C,
};
use indexmap::IndexMap;

fn sword() -> Result<AttackBuilder, DiceError> {
    attack_of(5.0, 12.0, d8().plus(3.0)?)
}

fn swords(n: usize) -> Result<Vec<Attack>, DiceError> {
    (0..n).map(|_| Ok(bare(sword()?))).collect()
}

fn adv_next() -> EffectSpec {
    effect_spec(&Lasting::from(advantage().until_next_attack()))
}

fn adv_next_to(ids: &[&str]) -> EffectSpec {
    effect_spec(&Lasting::from(advantage().until_next_attack().to(ids)))
}

fn adv_turn() -> EffectSpec {
    effect_spec(&Lasting::from(advantage().until_end_of_turn()))
}

fn dis_turn() -> EffectSpec {
    effect_spec(&Lasting::from(disadvantage().until_end_of_turn()))
}

fn of_list(of: Option<&[&str]>) -> Option<Vec<String>> {
    of.map(|l| l.iter().map(std::string::ToString::to_string).collect())
}

fn cond(on: ConditionOn, of: Option<&[&str]>, grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: None,
        on,
        of: of_list(of),
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

fn every(of: Option<&[&str]>, grants: Vec<EffectSpec>) -> ConditionSpec {
    cond(ConditionOn::Attack(AttackTriggerOn::EveryHit), of, grants)
}

fn with_conditions(attacks: Vec<Attack>, conditions: Vec<ConditionSpec>) -> TurnSpec {
    TurnSpec {
        attacks,
        conditions: Some(conditions),
        ..TurnSpec::default()
    }
}

fn with_probes(
    attacks: Vec<Attack>,
    riders: Vec<crate::turn::types::Rider>,
    observe: Vec<ProbeSpec>,
) -> TurnSpec {
    TurnSpec {
        observe: Some(observe),
        ..spec(attacks, riders)
    }
}

fn probe(id: Option<&str>, of: Option<&[&str]>) -> ProbeSpec {
    ProbeSpec {
        id: id.map(str::to_string),
        on: ProbeOn::AnyCrit,
        of: of_list(of),
    }
}

fn normal_save() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])
}

fn rule_of(name: ConditionName) -> Result<ConditionRule, DiceError> {
    rule(name).ok_or_else(|| DiceError::error("no rule"))
}

fn condition_effect(name: ConditionName, r: ConditionRule) -> EffectSpec {
    effect_spec(&condition(name.as_str(), r).until_end_of_turn())
}

/// The ten-odd non-empty subsets of four attack ids, in the TS mask order.
fn subsets() -> Vec<Vec<&'static str>> {
    let ids = ["attack 1", "attack 2", "attack 3", "attack 4"];
    (1..16usize)
        .map(|mask| {
            ids.iter()
                .enumerate()
                .filter(|(bit, _)| mask & (1 << bit) != 0)
                .map(|(_, id)| *id)
                .collect()
        })
        .collect()
}

// ---- tests/turn-flags.test.ts ---------------------------------------------------------------

#[test]
fn nine_flags_walk_thirty_one_live_at_once_is_too_many_states() -> T {
    let build = |count: usize| -> Result<_, DiceError> {
        let conditions = (0..count)
            .map(|_| every(Some(&["attack 1"]), vec![adv_next()]))
            .collect();
        Ok(plan_of(&with_conditions(swords(2)?, conditions)))
    };
    assert!(build(9)?.is_ok());
    assert!(build(30)?.is_ok());
    let error = refusal(build(31)?);
    assert_eq!(error.code, C::TooManyStates);
    assert!(
        error
            .message
            .contains("at most 30 effects live at once; this one needs 31")
    );
    Ok(())
}

#[test]
fn forty_chained_next_attack_grants_reuse_two_bits() -> T {
    let ids: Vec<String> = (0..41).map(|i| format!("a{i}")).collect();
    let attacks: Vec<Attack> = ids
        .iter()
        .map(|id| Ok(attack_id(id, sword()?)))
        .collect::<Result<_, String>>()?;
    let conditions = (0..40)
        .map(|i| {
            every(
                Some(&[ids[i].as_str()]),
                vec![adv_next_to(&[ids[i + 1].as_str()])],
            )
        })
        .collect();
    let plan = plan_of(&with_conditions(attacks, conditions)).map_err(|e| e.to_string())?;
    let bits = plan.flag_live_after.iter().fold(0u32, |a, b| a | b);
    assert!(bits.count_ones() <= 2, "bits in use: {bits:b}");
    Ok(())
}

#[test]
fn a_to_with_no_attack_roll_after_the_condition_s_sources_is_a_no_op() -> T {
    let ok = with_conditions(
        swords(2)?,
        vec![every(Some(&["attack 1"]), vec![adv_next_to(&["attack 1"])])],
    );
    assert!(plan_of(&ok).is_ok());
    let missing = with_conditions(
        swords(2)?,
        vec![every(None, vec![adv_next_to(&["nowhere"])])],
    );
    assert_eq!(code_of(plan_of(&missing)), C::UnknownId);
    Ok(())
}

#[test]
fn an_explicit_of_empty_never_lands_an_omitted_of_keeps_its_default_a_missing_id_still_fails() -> T
{
    let attacks = vec![attack_id("a", sword()?)];
    let never = rider_id("never", first_hit(Some(&[])), rs(2.0, 8.0)?);
    let c = ConditionSpec {
        id: Some("c".into()),
        ..every(Some(&[]), vec![adv_turn()])
    };
    let t = TurnSpec {
        conditions: Some(vec![c]),
        ..spec(attacks.clone(), vec![never])
    };
    let plan = plan_of(&t).map_err(|e| e.to_string())?;
    assert_eq!(plan.rider_ids, vec!["never".to_string()]);
    assert_eq!(plan.condition_ids, vec!["c".to_string()]);
    let defaulted = spec(
        attacks.clone(),
        vec![rider_id("r", first_hit(None), rs(2.0, 8.0)?)],
    );
    assert!(plan_of(&defaulted).is_ok());
    let missing = spec(
        attacks,
        vec![rider_id("r", first_hit(Some(&["missing"])), rs(2.0, 8.0)?)],
    );
    assert_eq!(code_of(plan_of(&missing)), C::UnknownId);
    Ok(())
}

// ---- tests/turn-conditions.test.ts: the rule error codes -------------------------------------

#[test]
fn unknown_range_a_rule_that_differs_by_range_needs_the_row_s_range() -> T {
    let build = |row: AttackBuilder| -> Result<_, DiceError> {
        let prone = condition_effect(ConditionName::Prone, rule_of(ConditionName::Prone)?);
        Ok(plan_of(&with_conditions(
            vec![bare(sword()?), bare(row)],
            vec![every(Some(&["attack 1"]), vec![prone])],
        )))
    };
    let error = refusal(build(sword()?)?);
    assert_eq!(error.code, C::UnknownRange);
    assert_eq!(error.id, "attack 2");
    assert!(
        error
            .message
            .contains("whose rule differs by range, but its row declares no range")
    );
    assert!(build(sword()?.ranged()?)?.is_ok());
    // A rule the same at every range needs none.
    let blinded = condition_effect(ConditionName::Blinded, rule_of(ConditionName::Blinded)?);
    let t = with_conditions(swords(2)?, vec![every(Some(&["attack 1"]), vec![blinded])]);
    assert!(plan_of(&t).is_ok());
    Ok(())
}

#[test]
fn save_without_ability_a_rule_that_reads_saves_by_ability() -> T {
    let stunned = || -> Result<EffectSpec, DiceError> {
        Ok(condition_effect(
            ConditionName::Stunned,
            rule_of(ConditionName::Stunned)?,
        ))
    };
    let fireball = d20()
        .plus(2.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?;
    let build = |save: crate::builder::save::SaveBuilder| -> Result<_, DiceError> {
        Ok(plan_of(&with_conditions(
            vec![bare(sword()?), bare(save)],
            vec![every(Some(&["attack 1"]), vec![stunned()?])],
        )))
    };
    assert_eq!(code_of(build(fireball.clone())?), C::SaveWithoutAbility);
    assert!(build(fireball.ability("dex")?)?.is_ok());
    let c = ConditionSpec {
        save: Some(GrantSaves::One(GrantSaveSpec::Dc {
            ability: None,
            dc: 12.0,
            bonus: 1.0,
            roll_type: None,
        })),
        ..every(Some(&["attack 1"]), vec![stunned()?])
    };
    assert_eq!(
        code_of(plan_of(&with_conditions(swords(2)?, vec![c]))),
        C::SaveWithoutAbility
    );
    Ok(())
}

#[test]
fn unknown_ability_a_rule_names_a_key_that_is_no_5e_ability() -> T {
    let mut save = IndexMap::new();
    save.insert("luck".to_string(), vec![SaveRuleModifier::AutoFail]);
    let r = ConditionRule {
        save: Some(save),
        ..ConditionRule::default()
    };
    let c = ConditionSpec {
        id: Some("c".into()),
        ..every(
            Some(&["attack 1"]),
            vec![condition_effect(ConditionName::Stunned, r)],
        )
    };
    let error = refusal(plan_of(&with_conditions(swords(2)?, vec![c])));
    assert_eq!(error.code, C::UnknownAbility);
    assert_eq!(error.id, "c");
    assert!(error.message.contains("changes saves made with \"luck\""));
    Ok(())
}

#[test]
fn a_grant_save_rolled_with_elven_accuracy_is_unsupported_trigger() -> T {
    use crate::common::RollType;
    let c = ConditionSpec {
        id: Some("c".into()),
        save: Some(GrantSaves::One(GrantSaveSpec::Dc {
            ability: None,
            dc: 12.0,
            bonus: 1.0,
            roll_type: Some(RollType::ElvenAccuracy),
        })),
        ..every(Some(&["attack 1"]), vec![adv_turn()])
    };
    let error = refusal(plan_of(&with_conditions(swords(2)?, vec![c])));
    assert_eq!(error.code, C::UnsupportedTrigger);
    assert!(error.message.contains("Elven Accuracy"));
    Ok(())
}

// ---- tests/turn-creatures.test.ts / turn-optional: structure ------------------------------------

#[test]
fn a_start_condition_is_in_force_from_the_start() -> T {
    let restrained = condition_effect(
        ConditionName::Restrained,
        rule_of(ConditionName::Restrained)?,
    );
    let start = cond(ConditionOn::Start, None, vec![restrained]);
    let plan = plan_of(&with_conditions(swords(2)?, vec![start])).map_err(|e| e.to_string())?;
    assert_eq!(plan.start_conditions, vec![0]);
    Ok(())
}

#[test]
fn path_to_the_grave_vulnerability_from_the_start_used_up_by_the_first_hit() -> T {
    let v = effect_spec(&vulnerability().until_next_hit());
    let start = cond(ConditionOn::Start, None, vec![v]);
    let plan = plan_of(&with_conditions(swords(3)?, vec![start])).map_err(|e| e.to_string())?;
    assert_ne!(plan.start_flags, 0);
    assert_eq!(plan.start_conditions, vec![0]);
    Ok(())
}

// ---- tests/turn-saves.test.ts ----------------------------------------------------------------

#[test]
fn refuses_a_save_beside_a_chance() -> T {
    let c = ConditionSpec {
        chance: Some(0.5),
        save: Some(GrantSaves::One(GrantSaveSpec::Dc {
            ability: None,
            dc: 10.0,
            bonus: 0.0,
            roll_type: None,
        })),
        ..every(None, vec![adv_turn()])
    };
    let error = other_error(plan_of(&with_conditions(vec![bare(sword()?)], vec![c])));
    assert!(
        error.message().contains("both a save and a chance"),
        "{error}"
    );
    Ok(())
}

// ---- src/turn/conditions.test.ts ---------------------------------------------------------------

#[test]
fn a_first_hit_damage_rider_and_a_first_hit_grant_over_the_same_attacks_share_one_group() -> T {
    let t = TurnSpec {
        conditions: Some(vec![ConditionSpec {
            chance: Some(0.5),
            ..cond(
                ConditionOn::Attack(AttackTriggerOn::FirstHit),
                None,
                vec![adv_turn()],
            )
        }]),
        ..spec(swords(2)?, vec![rider(first_hit(None), rs(3.0, 6.0)?)])
    };
    assert_eq!(plan_of(&t).map_err(|e| e.to_string())?.group_count, 1);
    Ok(())
}

#[test]
fn an_every_hit_grant_allocates_no_group_of_its_own() -> T {
    let t = TurnSpec {
        conditions: Some(vec![every(None, vec![adv_next()])]),
        ..spec(swords(2)?, vec![rider(first_hit(None), rs(3.0, 6.0)?)])
    };
    assert_eq!(plan_of(&t).map_err(|e| e.to_string())?.group_count, 1);
    Ok(())
}

fn nine_groups() -> Result<TurnSpec, DiceError> {
    let sets = subsets();
    let riders = sets
        .iter()
        .take(9)
        .enumerate()
        .map(|(i, of)| {
            Ok(rider_id(
                &format!("group {}", i + 1),
                first_hit(Some(of)),
                d4(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(spec(swords(4)?, riders))
}

#[test]
fn all_max_trigger_groups_groups_plus_condition_flags_still_build_and_resolve() -> T {
    let sets = subsets();
    let base = nine_groups()?;
    assert_eq!(plan_of(&base).map_err(|e| e.to_string())?.group_count, 9);
    // every-hit grants never allocate a group: flags are not counted against the group limit.
    let with_flags = TurnSpec {
        conditions: Some(vec![
            every(Some(&sets[9]), vec![adv_next()]),
            every(Some(&sets[10]), vec![dis_turn()]),
        ]),
        ..base.clone()
    };
    assert_eq!(
        plan_of(&with_flags).map_err(|e| e.to_string())?.group_count,
        9
    );
    // A first-hit RIDER over that same untried source set, once the budget is full, throws.
    let mut tenth = base;
    if let Some(riders) = tenth.riders.as_mut() {
        riders.push(rider_id("tenth", first_hit(Some(&sets[9])), d4()));
    }
    let error = refusal(plan_of(&tenth));
    assert_eq!(error.code, C::TooManyGroups);
    assert!(
        error
            .message
            .contains("at most 9 trigger source sets live at once")
    );
    assert!(error.message.contains("would be the 10th"));
    Ok(())
}

#[test]
fn a_grant_read_by_an_attack_with_no_check_to_re_derive_is_no_rebindable_source() -> T {
    let bare_pmf = Source::from(sword()?.to_pmf(EPS)?);
    let t = with_conditions(
        vec![bare(sword()?), Attack::Bare(bare_pmf.clone())],
        vec![every(None, vec![adv_next()])],
    );
    assert_eq!(code_of(plan_of(&t)), C::NoRebindableSource);
    // `to` scopes it away.
    let scoped = with_conditions(
        vec![bare(sword()?), Attack::Bare(bare_pmf), bare(sword()?)],
        vec![every(
            None,
            vec![effect_spec(&Lasting::from(
                advantage().until_end_of_turn().to(&["attack 3"]),
            ))],
        )],
    );
    assert!(plan_of(&scoped).is_ok());
    Ok(())
}

#[test]
fn a_chance_outside_0_1_is_a_range_error() -> T {
    for chance in [1.5, -0.1] {
        let c = ConditionSpec {
            chance: Some(chance),
            ..every(None, vec![adv_turn()])
        };
        let error = other_error(plan_of(&with_conditions(swords(2)?, vec![c])));
        assert_eq!(error.name(), "RangeError", "{error}");
    }
    Ok(())
}

#[test]
fn chance_with_save_or_on_save_with_neither_is_a_plain_error() -> T {
    let both = ConditionSpec {
        chance: Some(0.5),
        save: Some(GrantSaves::One(GrantSaveSpec::Dc {
            ability: None,
            dc: 15.0,
            bonus: 2.0,
            roll_type: None,
        })),
        ..every(None, vec![adv_turn()])
    };
    assert_eq!(
        other_error(plan_of(&with_conditions(swords(2)?, vec![both]))).name(),
        "Error"
    );
    let neither = ConditionSpec {
        on_save: Some(vec![adv_next()]),
        ..every(None, vec![adv_turn()])
    };
    assert_eq!(
        other_error(plan_of(&with_conditions(swords(2)?, vec![neither]))).name(),
        "Error"
    );
    Ok(())
}

// ---- src/turn/save-landing.test.ts -------------------------------------------------------------

#[test]
fn without_a_landing_kind_a_save_row_is_not_an_attack_and_the_error_says_how_to_watch_it() -> T {
    let rows =
        || -> Result<Vec<Attack>, DiceError> { Ok(vec![bare(sword()?), bare(normal_save()?)]) };
    let plain = spec(rows()?, vec![rider(first_hit(None), d6())]);
    let error = refusal(plan_of(&plain));
    assert_eq!(error.code, C::NotAnAttack);
    assert!(error.message.contains("landing"), "{}", error.message);
    // A reader of another kind cannot borrow the landing another rider declared.
    let mut landed = rider(first_hit(Some(&["attack 2"])), d6());
    landed.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    let borrowed = TurnSpec {
        conditions: Some(vec![every(Some(&["attack 2"]), vec![adv_next()])]),
        ..spec(rows()?, vec![landed])
    };
    assert_eq!(code_of(plan_of(&borrowed)), C::NotAnAttack);
    let substitute = TurnSpec {
        substitutes: Some(vec![SubstituteSpec {
            id: None,
            on: SubstituteOn::FirstHit,
            of: Some(vec!["attack 2".to_string()]),
            substitute: SubstituteKind::RerollKeepHigher,
            mode: None,
            policy: None,
        }]),
        ..spec(rows()?, vec![])
    };
    assert_eq!(code_of(plan_of(&substitute)), C::NotAnAttack);
    Ok(())
}

#[test]
fn refuses_a_landing_kind_that_means_nothing() -> T {
    let rows = vec![bare(sword()?), bare(normal_save()?)];
    let mut x = rider_id("x", not_fired("y"), d6());
    x.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    assert_eq!(
        code_of(plan_of(&spec(rows.clone(), vec![x]))),
        C::UnsupportedTrigger
    );
    // `otherwise` writes a not-fired rider over the first.
    let mut first = rider_id("rider 1", first_hit(None), d6());
    first.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    let mut other = rider_id("rider 2", not_fired("rider 1"), d6());
    other.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    assert_eq!(
        code_of(plan_of(&spec(rows, vec![first, other]))),
        C::UnsupportedTrigger
    );
    Ok(())
}

#[test]
fn a_landing_kind_on_a_grant_is_a_condition_field() -> T {
    let c = ConditionSpec {
        landing: Some(SaveLanding::Fail),
        ..cond(
            ConditionOn::Attack(AttackTriggerOn::FirstHit),
            None,
            vec![adv_turn()],
        )
    };
    assert!(plan_of(&with_conditions(swords(2)?, vec![c])).is_ok());
    Ok(())
}

#[test]
fn dice_match_still_needs_dice_a_save_has_no_descriptor() -> T {
    let mut r = rider(dice_match(&["attack 2"]), d6());
    r.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    let t = spec(vec![bare(sword()?), bare(normal_save()?)], vec![r]);
    assert_eq!(code_of(plan_of(&t)), C::NoDiceDescriptor);
    Ok(())
}

#[test]
fn a_watched_save_row_takes_no_group_of_its_own_beyond_the_rider_s_source_set() -> T {
    let mut r = rider(first_hit(None), d6());
    r.landing = Some(RiderLanding::Save(SaveLanding::Damage));
    let t = spec(vec![bare(sword()?), bare(normal_save()?)], vec![r]);
    assert_eq!(plan_of(&t).map_err(|e| e.to_string())?.group_count, 1);
    Ok(())
}

#[test]
fn two_riders_read_one_save_row_under_different_landing_kinds_in_two_groups() -> T {
    let mut fail_rider = rider_id(
        "failure",
        first_hit(None),
        crate::builder::factory::flat(10.0)?,
    );
    fail_rider.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    let mut damage_rider = rider_id(
        "damage",
        first_hit(None),
        crate::builder::factory::flat(20.0)?,
    );
    damage_rider.landing = Some(RiderLanding::Save(SaveLanding::Damage));
    let save = normal_save()?.save_half()?;
    let t = spec(vec![bare(save)], vec![fail_rider, damage_rider]);
    // One source set, two landing kinds: the kinds split the group.
    assert_eq!(plan_of(&t).map_err(|e| e.to_string())?.group_count, 2);
    Ok(())
}

// ---- src/turn/probes.test.ts -------------------------------------------------------------------

#[test]
fn turn_from_takes_observe_and_reads_the_same_as_the_fluent_spelling() -> T {
    let attacks = vec![attack_id("a", sword()?), attack_id("b", sword()?)];
    let t = with_probes(
        attacks,
        vec![],
        vec![
            probe(Some("crit"), Some(&["a", "b"])),
            probe(None, Some(&["a"])),
        ],
    );
    let plan = plan_of(&t).map_err(|e| e.to_string())?;
    assert_eq!(
        plan.probe_ids,
        vec!["crit".to_string(), "probe 2".to_string()]
    );
    assert_eq!(plan.probes.len(), 2);
    Ok(())
}

#[test]
fn an_omitted_of_watches_every_attack_plus_every_attack_shaped_reroll() -> T {
    let t = with_probes(
        swords(2)?,
        vec![rider_id("reroll", first_miss(None), sword()?)],
        vec![probe(Some("crit"), None)],
    );
    let plan = plan_of(&t).map_err(|e| e.to_string())?;
    assert_eq!(plan.probe_ids, vec!["crit".to_string()]);
    assert!(
        plan.probes
            .get("crit")
            .is_some_and(std::option::Option::is_some)
    );
    Ok(())
}

#[test]
fn a_probe_shares_one_id_space_with_attacks_riders_substitutes_and_conditions() -> T {
    let one = || -> Result<Vec<Attack>, DiceError> { Ok(vec![bare(sword()?)]) };
    let t = with_probes(
        one()?,
        vec![rider_id("x", first_hit(None), d6())],
        vec![probe(Some("x"), None)],
    );
    assert_eq!(code_of(plan_of(&t)), C::DuplicateId);
    let t = with_probes(one()?, vec![], vec![probe(Some("attack 1"), None)]);
    assert_eq!(code_of(plan_of(&t)), C::DuplicateId);
    let t = with_probes(
        one()?,
        vec![],
        vec![probe(Some("x"), None), probe(Some("x"), None)],
    );
    assert_eq!(code_of(plan_of(&t)), C::DuplicateId);
    Ok(())
}

#[test]
fn a_probe_cannot_be_watched_and_its_of_follows_a_rider_s_rules() -> T {
    let one = || -> Result<Vec<Attack>, DiceError> { Ok(vec![bare(sword()?)]) };
    let watched = with_probes(
        one()?,
        vec![rider(first_hit(Some(&["p"])), d6())],
        vec![probe(Some("p"), None)],
    );
    assert_eq!(code_of(plan_of(&watched)), C::NotAnAttack);
    let nowhere = with_probes(one()?, vec![], vec![probe(Some("p"), Some(&["nowhere"]))]);
    assert_eq!(code_of(plan_of(&nowhere)), C::UnknownId);
    let empty = with_probes(one()?, vec![], vec![probe(Some("p"), Some(&[]))]);
    assert_eq!(code_of(plan_of(&empty)), C::UnknownId);
    let over_damage = with_probes(
        one()?,
        vec![rider_id("dmg", first_hit(None), d6())],
        vec![probe(Some("p"), Some(&["dmg"]))],
    );
    assert_eq!(code_of(plan_of(&over_damage)), C::NotAnAttack);
    Ok(())
}

#[test]
fn a_probe_shares_the_group_a_rider_over_the_same_sources_already_has() -> T {
    let t = with_probes(
        swords(2)?,
        vec![rider(first_hit(None), d6())],
        vec![probe(Some("crit"), None)],
    );
    assert_eq!(plan_of(&t).map_err(|e| e.to_string())?.group_count, 1);
    Ok(())
}

#[test]
fn a_tenth_source_set_live_at_once_throws() -> T {
    let sets = subsets();
    let base = nine_groups()?;
    let tenth = TurnSpec {
        observe: Some(vec![probe(Some("tenth"), Some(&sets[9]))]),
        ..base.clone()
    };
    assert_eq!(code_of(plan_of(&tenth)), C::TooManyGroups);
    let shared = TurnSpec {
        observe: Some(vec![probe(Some("shared"), Some(&sets[0]))]),
        ..base
    };
    assert_eq!(plan_of(&shared).map_err(|e| e.to_string())?.group_count, 9);
    Ok(())
}

// ---- src/turn/attached.test.ts -----------------------------------------------------------------

#[test]
fn rejects_an_attached_condition_on_a_rider_source() -> T {
    use crate::builder::attack::Grants;
    let carrying = sword()?.on_every_hit_with(
        Grants::One(Lasting::from(advantage().until_next_attack())),
        None,
    )?;
    let t = spec(
        vec![attack_id("a", sword()?)],
        vec![rider_id("reroll", first_miss(None), carrying)],
    );
    assert_eq!(code_of(plan_of(&t)), C::UnsupportedTrigger);
    Ok(())
}
