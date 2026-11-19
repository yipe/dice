//! `tests/turn-validation.test.ts`: 19 tests here, 38 compat calls. The cases that only assert a
//! `TurnSpecError` code (lines 21-113, 205-232, 322-345, 347-356, 371-381) are translated in
//! `plan/tests_validation.rs`; the ones that need `Turn` readers are here.
//!
//! Not translated: tests/turn-validation.test.ts:394-414: a `"1d6"` source and a `toPMF` returning a
//! non-PMF are untyped-caller cases with no Rust counterpart.
//! Not translated: tests/turn-validation.test.ts:417-425, 432-453: unknown keys and non-string ids
//! cannot be written in a typed `TurnSpec`.
//! Not translated: tests/turn-validation.test.ts:456: `{ id: 5 }` is a type error in Rust (the
//! `chance` half of that test is translated).
//! Mutation of a caller-owned array (311-319) cannot alias in Rust: the vector is cloned into the turn
//! and the original is pushed to afterwards.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::{d4, d6};
use crate::error::DiceError;
use crate::pmf::ChartModelOptions;
use crate::turn::effects::{ConditionOptions, FirstHitOptions};
use crate::turn::types::{
    Attack, AttackOptions, DamageSource, Rider, RiderDamage, RiderDamageSpec, RiderOptions,
    Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/turn-validation.test.ts";

fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(4.0)?)
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(std::string::ToString::to_string).collect()
}

/// `{ id?, damage, on, of? }` with one plain payload.
fn rider(id: Option<&str>, trigger: Trigger, damage: impl Into<RiderDamage>) -> Rider {
    Rider {
        trigger,
        id: id.map(str::to_string),
        damage: RiderDamageSpec::Plain(damage.into()),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn first_hit(of: Option<&[&str]>) -> Trigger {
    Trigger::FirstHit {
        of: of.map(names),
        per_source: None,
    }
}

fn any_crit() -> Trigger {
    Trigger::AnyCrit {
        of: None,
        max: None,
    }
}

fn not_fired(of: &str) -> Trigger {
    Trigger::NotFired { of: of.to_string() }
}

/// `{ of }` for `onFirstHit`.
fn first_hit_of(of: &[&str]) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                of: Some(names(of)),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn two_daggers() -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![atk(dagger()?), atk(dagger()?)], 0.0)?)
}

fn sneak(on: Trigger) -> Rider {
    rider(Some("sneak"), on, DamageSource::from(d6()))
}

#[test]
fn fire_probability_throws_unknown_id_for_a_non_rider() -> T {
    let mut want = expect(
        FILE,
        "TurnSpecError codes > fireProbability throws unknown-id for a non-rider",
    );
    let built = turn(vec![atk(dagger()?)], 0.0)?.rider(sneak(first_hit(None)))?;
    assert!(want.fire(&built, "sneak") > 0.0);
    assert_eq!(code_of(built.fire_probability("attack 1")), "unknown-id");
    want.done();
    Ok(())
}

// ---- Turn ids and defaults --------------------------------------------------------------------

#[test]
fn names_bare_attacks_in_declaration_order() -> T {
    let mut want = expect(
        FILE,
        "Turn ids and defaults > names bare attacks in declaration order",
    );
    let built = two_daggers()?.rider(sneak(first_hit(Some(&["attack 2"]))))?;
    // Only the second dagger can trigger it, so it fires on that attack alone.
    close(want.fire(&built, "sneak"), 0.65, 10);
    want.done();
    Ok(())
}

#[test]
fn defaults_of_to_every_declared_attack() -> T {
    let mut want = expect(
        FILE,
        "Turn ids and defaults > defaults `of` to every declared attack",
    );
    let explicit = two_daggers()?.rider(sneak(first_hit(Some(&["attack 1", "attack 2"]))))?;
    let defaulted = two_daggers()?.rider(sneak(first_hit(None)))?;
    let defaulted_mean = want.mean(&defaulted);
    let explicit_mean = want.mean(&explicit);
    close(defaulted_mean, explicit_mean, 12);
    want.done();
    Ok(())
}

#[test]
fn shares_one_group_between_riders_with_the_same_sources() -> T {
    let mut want = expect(
        FILE,
        "Turn ids and defaults > shares one group between riders with the same sources",
    );
    // Two riders on the same trigger keep the mean of the independent build but not its spread:
    // they fire together or not at all.
    let shared = two_daggers()?
        .rider(rider(
            None,
            first_hit(None),
            DamageSource::from(rs(3.0, 6.0)?),
        ))?
        .rider(rider(None, first_hit(None), DamageSource::from(d6())))?;
    let split = two_daggers()?.rider(rider(
        None,
        first_hit(None),
        RiderDamage::Many(vec![
            DamageSource::from(rs(3.0, 6.0)?),
            DamageSource::from(d6()),
        ]),
    ))?;
    let shared_mean = want.mean(&shared);
    let split_mean = want.mean(&split);
    close(shared_mean, split_mean, 10);
    let shared_sd = want.pmf(&shared).stdev();
    let split_sd = want.pmf(&split).stdev();
    close(shared_sd, split_sd, 10);
    want.done();
    Ok(())
}

#[test]
fn reuses_an_explicit_crit_damage_instead_of_doubling() -> T {
    let mut want = expect(
        FILE,
        "Turn ids and defaults > reuses an explicit critDamage instead of doubling",
    );
    let mut r = rider(None, any_crit(), DamageSource::from(d6()));
    r.crit_damage = Some(RiderDamage::One(DamageSource::from(rs(10.0, 6.0)?)));
    let built = two_daggers()?.rider(r)?;
    let attacks = two_daggers()?;
    let diff = want.mean(&built) - want.mean(&attacks);
    close(diff, 0.0975 * 35.0, 8);
    want.done();
    Ok(())
}

#[test]
fn falls_back_to_single_dice_on_a_crit_when_damage_cannot_be_doubled() -> T {
    let mut want = expect(
        FILE,
        "Turn ids and defaults > falls back to single dice on a crit when damage cannot be doubled",
    );
    let flat = two_daggers()?.rider(rider(
        None,
        any_crit(),
        DamageSource::Pmf(std::sync::Arc::new(d6().pmf()?)),
    ))?;
    let attacks = two_daggers()?;
    let diff = want.mean(&flat) - want.mean(&attacks);
    close(diff, 0.0975 * 3.5, 8);
    want.done();
    Ok(())
}

// ---- Turn attribution -------------------------------------------------------------------------

#[test]
fn keeps_outcome_labels_on_the_exact_turn_pmf() -> T {
    let mut want = expect(
        FILE,
        "Turn attribution > keeps outcome labels on the exact turn PMF",
    );
    let built = two_daggers()?.rider(rider(
        None,
        first_hit(None),
        DamageSource::from(rs(3.0, 6.0)?),
    ))?;
    let mut outcomes = want.pmf(&built).outcomes();
    outcomes.sort();
    assert_eq!(outcomes, vec!["crit", "hit", "missNone"]);
    want.done();
    Ok(())
}

#[test]
fn produces_a_usable_attribution_chart_model() -> T {
    let mut want = expect(
        FILE,
        "Turn attribution > produces a usable attribution chart model",
    );
    let built = two_daggers()?.rider(rider(
        None,
        first_hit(None),
        DamageSource::from(rs(3.0, 6.0)?),
    ))?;
    want.query(&built);
    let model = built
        .to_query()?
        .damage_attribution_chart_model(&ChartModelOptions::default())?;
    assert!(!model.outcomes.is_empty());
    close(built.to_query()?.mean(), 18.6225, 4);
    want.done();
    Ok(())
}

// ---- every-hit riders -------------------------------------------------------------------------

#[test]
fn still_allows_referencing_a_non_every_hit_rider() -> T {
    let mut want = expect(
        FILE,
        "every-hit riders cannot be referenced > still allows referencing a non-every-hit rider",
    );
    let built = Turn::from_spec(
        TurnSpec {
            attacks: vec![named("d1", dagger()?)],
            riders: Some(vec![
                rider(Some("smite"), any_crit(), DamageSource::from(d6())),
                rider(
                    Some("fallback"),
                    not_fired("smite"),
                    DamageSource::from(d6()),
                ),
            ]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let smite = want.fire(&built, "smite");
    let fallback = want.fire(&built, "fallback");
    close(smite + fallback, 1.0, 10);
    want.done();
    Ok(())
}

// ---- mass not 1 -------------------------------------------------------------------------------

#[test]
fn normalizes_fire_probabilities_along_with_the_distribution() -> T {
    let mut want = expect(
        FILE,
        "Turn with source PMFs whose mass is not 1 > normalizes fire probabilities along with the distribution",
    );
    let lopsided = dagger()?.pmf()?.scale_mass(0.5);
    let built = turn(vec![atk(lopsided)], 0.0)?.rider(sneak(first_hit(None)))?;
    let reference = turn(vec![atk(dagger()?)], 0.0)?.rider(sneak(first_hit(None)))?;

    close(want.pmf(&built).mass(), 1.0, 10);
    // Scaling every source's mass cannot change a conditional probability.
    let built_fire = want.fire(&built, "sneak");
    let reference_fire = want.fire(&reference, "sneak");
    close(built_fire, reference_fire, 10);
    assert!(want.fire(&built, "sneak") <= 1.0);
    want.done();
    Ok(())
}

// ---- trigger source sets ----------------------------------------------------------------------

fn ab() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![named("a", dagger()?), named("b", dagger()?)])
}

#[test]
fn treats_a_repeated_source_id_as_one_source() -> T {
    let mut want = expect(
        FILE,
        "trigger source sets > treats a repeated source id as one source",
    );
    let plain = turn(ab()?, 0.0)?.on_first_hit_with(d6(), first_hit_of(&["a", "b"]))?;
    let repeated =
        turn(ab()?, 0.0)?.on_first_hit_with(d6(), first_hit_of(&["a", "b", "b", "a"]))?;

    let repeated_mean = want.mean(&repeated);
    let plain_mean = want.mean(&plain);
    close(repeated_mean, plain_mean, 12);
    let repeated_sd = want.pmf(&repeated).stdev();
    let plain_sd = want.pmf(&plain).stdev();
    close(repeated_sd, plain_sd, 12);
    want.done();
    Ok(())
}

#[test]
fn does_not_spend_a_trigger_group_on_a_duplicate_only_difference() -> T {
    let mut want = expect(
        FILE,
        "trigger source sets > does not spend a trigger group on a duplicate-only difference",
    );
    // ["a"] and ["a","a"] name the same set, so these are 3 groups, not 5.
    let mut built = turn(ab()?, 0.0)?;
    for of in [&["a"][..], &["a", "a"], &["b"], &["b", "b"], &["a", "b"]] {
        built = built.on_first_hit_with(d6(), first_hit_of(of))?;
    }
    assert!(want.mean(&built) > 0.0);
    want.done();
    Ok(())
}

#[test]
fn keeps_distinct_source_sets_apart_when_an_id_contains_the_delimiter() -> T {
    let mut want = expect(
        FILE,
        "trigger source sets > keeps distinct source sets apart when an id contains the delimiter",
    );
    let attacks = || -> Result<Vec<Attack>, DiceError> {
        Ok(vec![
            named("a\u{0}b", dagger()?),
            named("a", dagger()?),
            named("b", dagger()?),
        ])
    };
    let joined = turn(attacks()?, 0.0)?.on_first_hit_with(d6(), first_hit_of(&["a\u{0}b"]))?;
    let pair = turn(attacks()?, 0.0)?.on_first_hit_with(d6(), first_hit_of(&["a", "b"]))?;

    // One source vs two: the second fires more often, so they must not share.
    let pair_mean = want.mean(&pair);
    let joined_mean = want.mean(&joined);
    assert!(pair_mean > joined_mean);
    want.done();
    Ok(())
}

#[test]
fn ignores_later_mutation_of_a_caller_owned_attacks_array() -> T {
    let mut want = expect(
        FILE,
        "trigger source sets > ignores later mutation of a caller-owned attacks array",
    );
    let mut attacks = vec![named("a", dagger()?)];
    let built = turn(attacks.clone(), 0.0)?.on_first_hit_with(d6(), first_hit_of(&["a"]))?;
    let before = want.mean(&built);

    attacks.push(named("b", dagger()?));
    close(want.mean(&built), before, 12);
    want.query(&built);
    assert_eq!(built.to_query()?.singles.len(), 1);
    want.done();
    Ok(())
}

// ---- id accessors -----------------------------------------------------------------------------

#[test]
fn accepts_every_listed_rider_id_in_fire_probability() -> T {
    let mut want = expect(
        FILE,
        "id accessors > accepts every listed rider id in fireProbability",
    );
    let built = two_daggers()?
        .on_first_hit_with(d6(), FirstHitOptions::default())?
        .on_every_hit_with(d6(), every_hit(None, None))?;
    for id in built.rider_ids()? {
        assert!(want.fire(&built, &id) > 0.0);
    }
    want.done();
    Ok(())
}

#[test]
fn names_the_available_riders_when_given_an_attack_id() -> T {
    let built = turn(vec![atk(dagger()?)], 0.0)?.on_any_crit_with(d6(), cond_id("smite"))?;
    let message = built
        .fire_probability("attack 1")
        .err()
        .map(|e| e.message().to_string())
        .ok_or("fireProbability accepted an attack id")?;
    assert!(message.contains("Riders: \"smite\""), "{message}");
    Ok(())
}

// ---- critDamage -------------------------------------------------------------------------------

#[test]
fn crit_damage_is_still_honoured_for_plain_damage_dice() -> T {
    let mut want = expect(
        FILE,
        "critDamage on an attack-shaped rider > is still honoured for plain damage dice",
    );
    let options = ConditionOptions {
        rider: RiderOptions {
            crit_damage: Some(RiderDamage::One(DamageSource::from(rs(10.0, 6.0)?))),
            ..RiderOptions::default()
        },
        ..ConditionOptions::default()
    };
    let built = two_daggers()?.on_any_crit_with(d6(), options)?;
    let diff = want.mean(&built) - want.mean(&two_daggers()?);
    close(diff, 0.0975 * 35.0, 8);
    want.done();
    Ok(())
}

// ---- strict spec validation -------------------------------------------------------------------

fn chance_attack(chance: f64) -> Result<Attack, DiceError> {
    Ok(Attack::Declared {
        options: AttackOptions {
            chance: Some(chance),
            ..AttackOptions::default()
        },
        source: dagger()?.into(),
    })
}

#[test]
fn accepts_the_chance_key_it_previously_ignored() -> T {
    let mut want = expect(
        FILE,
        "strict spec validation > accepts the chance key it previously ignored",
    );
    let built = Turn::from_spec(
        TurnSpec {
            attacks: vec![chance_attack(0.5)?],
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let built_mean = want.mean(&built);
    close(
        built_mean,
        0.5 * want.mean(&turn(vec![atk(dagger()?)], 0.0)?),
        12,
    );
    want.done();
    Ok(())
}

#[test]
fn validates_through_the_chaining_builders_too() -> T {
    let mut want = expect(
        FILE,
        "strict spec validation > validates through the chaining builders too",
    );
    let built = turn(vec![], 0.0)?.attack_with(
        dagger()?,
        AttackOptions {
            chance: Some(0.5),
            ..AttackOptions::default()
        },
    )?;
    let built_mean = want.mean(&built);
    close(
        built_mean,
        0.5 * want.mean(&turn(vec![atk(dagger()?)], 0.0)?),
        12,
    );
    want.done();
    Ok(())
}
