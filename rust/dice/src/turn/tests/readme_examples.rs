//! `tests/turn-readme-examples.test.ts`: 17 tests, 41 compat calls.

use super::helpers::*;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::query::Labels;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, TriggerSave, TriggerSaves, advantage,
};
use crate::turn::types::{
    DamageSource, Rider, RiderDamageSpec, RiderOptions, RiderPayload, Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use crate::{DiceQuery, Pmf};
use indexmap::IndexMap;

const FILE: &str = "tests/turn-readme-examples.test.ts";

fn dagger() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(4.0)?)
}
fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(9.0, 16.0, d6().plus(5.0)?)
}
fn greatsword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)
}
fn unarmed() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(4.0)?)
}
fn poison() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[crate::builder::roll::Arg::Roll(rs(3.0, 6.0)?)])?
        .save_half()
}

fn rogue() -> Result<Turn, DiceError> {
    turn(vec![atk(dagger()?), atk(dagger()?)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())
}

#[test]
fn rogue_quotes_the_right_mean_and_whiff_chance() -> T {
    let mut want = expect(
        FILE,
        "README: the rogue > quotes the right mean and whiff chance",
    );
    let rogue = rogue()?;
    close(want.mean(&rogue), 18.6225, 4);
    close(want.pmf(&rogue).p_at(0.0), 0.1225, 4);
    want.done();
    Ok(())
}

#[test]
fn rogue_quotes_the_right_wrong_answer_for_the_naive_construction() -> T {
    // No turn reader: the compat fixture has no entry for it.
    let dagger_pmf = dagger()?.pmf()?;
    let attacks = DiceQuery::of(vec![dagger_pmf.clone(), dagger_pmf.clone()]);
    let [p_hit, p_crit, _, _] =
        attacks.first_success_split(&any_hit(), &crit_only(), crate::EPS)?;
    let naive = DiceQuery::of(vec![
        dagger_pmf.clone(),
        dagger_pmf,
        Pmf::exclusive(
            &[
                (rs(3.0, 6.0)?.pmf()?, p_hit),
                (rs(3.0, 6.0)?.double_dice()?.pmf()?, p_crit),
            ],
            crate::EPS,
        )?,
    ]);
    close(naive.combined().p_at(0.0), 0.015, 3);
    Ok(())
}

#[test]
fn rogue_quotes_the_right_statistics() -> T {
    let mut want = expect(FILE, "README: the rogue > quotes the right statistics");
    let rogue = rogue()?;
    close(want.pmf(&rogue).stdev(), 8.886, 3);
    let mut query = rogue.to_query()?;
    want.query(&rogue);
    close(query.prob_total_at_least(20.0), 0.5062, 4);
    query = rogue.to_query()?;
    want.query(&rogue);
    assert_eq!(
        query.percentiles(&[0.25, 0.5, 0.75]),
        vec![15.0, 20.0, 24.0]
    );
    want.done();
    Ok(())
}

fn any_hit() -> Labels {
    Labels::Many(vec!["hit".to_string(), "crit".to_string()])
}

fn crit_only() -> Labels {
    Labels::One("crit".to_string())
}

#[test]
fn extra_attack_quotes_the_right_means_for_4_and_8_attacks() -> T {
    let mut want = expect(
        FILE,
        "README: extra attack > quotes the right means for 4 and 8 attacks",
    );
    let t4 = turn(vec![], 0.0)?
        .attacks(4.0, sword()?)?
        .on_every_hit_with(d6(), EveryHitOptions::default())?;
    close(want.mean(&t4), 35.0, 6);
    let t8 = turn(vec![], 0.0)?
        .attacks(8.0, sword()?)?
        .on_every_hit_with(d6(), EveryHitOptions::default())?;
    close(want.mean(&t8), 70.0, 6);
    want.done();
    Ok(())
}

#[test]
fn extra_attack_matches_spelling_the_attacks_out_by_hand() -> T {
    let mut want = expect(
        FILE,
        "README: extra attack > matches spelling the attacks out by hand",
    );
    let counted = want.mean(&turn(vec![], 0.0)?.attacks(2.0, sword()?)?);
    let by_hand = want.mean(&turn(vec![atk(sword()?), atk(sword()?)], 0.0)?);
    close(counted, by_hand, 12);
    want.done();
    Ok(())
}

#[test]
fn extra_attack_rejects_a_count_that_is_not_a_positive_integer() -> T {
    for count in [0.0, -1.0, 2.5] {
        let result = turn(vec![], 0.0)?.attacks(count, sword()?);
        assert!(matches!(result, Err(DiceError::Range(_))), "count {count}");
    }
    Ok(())
}

fn maneuvers() -> Result<Turn, DiceError> {
    turn(vec![], 0.0)?
        .attacks(4.0, sword()?)?
        .on_every_hit_with(d8(), every_hit(Some("maneuvers"), Some(2.0)))
}

#[test]
fn at_most_n_quotes_the_right_mean_fire_probability_and_expected_applications() -> T {
    let mut want = expect(
        FILE,
        "README: at most N times > quotes the right mean, fire probability and expected applications",
    );
    let t = maneuvers()?;
    close(want.mean(&t), 33.7003, 4);
    close(want.fire(&t, "maneuvers"), 0.9919, 4);
    close(want.applications(&t, "maneuvers"), 1.9082, 4);
    want.done();
    Ok(())
}

#[test]
fn at_most_n_quotes_the_rider_free_and_every_hit_bounds() -> T {
    let mut want = expect(
        FILE,
        "README: at most N times > quotes the rider-free and every-hit bounds",
    );
    close(
        want.mean(&turn(vec![], 0.0)?.attacks(4.0, sword()?)?),
        24.5,
        6,
    );
    let every = turn(vec![], 0.0)?
        .attacks(4.0, sword()?)?
        .on_every_hit_with(d8(), every_hit(Some("all"), None))?;
    close(want.mean(&every), 38.0, 6);
    close(want.applications(&every, "all"), 2.8, 6);
    want.done();
    Ok(())
}

#[test]
fn at_most_n_quotes_the_right_mean_for_a_payload_per_landing_source() -> T {
    let mut want = expect(
        FILE,
        "README: at most N times > quotes the right mean for a payload per landing source",
    );
    let mut per_source: IndexMap<String, RiderPayload> = IndexMap::new();
    per_source.insert(
        "attack 2".to_string(),
        RiderPayload {
            damage: d10().into(),
            crit_damage: None,
        },
    );
    let t = turn(vec![atk(sword()?), atk(dagger()?)], 0.0)?.on_first_hit_with(
        d6(),
        FirstHitOptions {
            per_source: Some(per_source),
            ..FirstHitOptions::default()
        },
    )?;
    close(want.mean(&t), 14.255, 4);
    want.done();
    Ok(())
}

#[test]
fn a_rider_can_be_anything_that_makes_damage() -> T {
    let mut want = expect(
        FILE,
        "README: a rider can be anything that makes damage > accepts a whole attack, a saving throw, a flat bonus and a list",
    );
    let two_gs =
        || -> Result<Turn, DiceError> { turn(vec![atk(greatsword()?), atk(greatsword()?)], 0.0) };
    let with_crit = two_gs()?.on_any_crit_with(greatsword()?, ConditionOptions::default())?;
    let a = want.mean(&with_crit);
    let b = want.mean(&two_gs()?);
    assert!(a > b);
    let poisoned = turn(vec![atk(dagger()?)], 0.0)?
        .on_first_hit_with(poison()?, FirstHitOptions::default())?;
    let c = want.mean(&poisoned);
    let d = want.mean(&turn(vec![atk(dagger()?)], 0.0)?);
    assert!(c > d);
    // Rage adds its 2 on every landing attack, crit or not, so the gain is exactly 2 x P(one
    // attack lands) x 2 attacks.
    let p_lands = DiceQuery::of(vec![sword()?.pmf()?]).prob_at_least_one(any_hit());
    let raging = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
        .on_every_hit_with(flat(2.0)?, EveryHitOptions::default())?;
    let plain = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?;
    let raging_mean = want.mean(&raging);
    let plain_mean = want.mean(&plain);
    close(raging_mean, plain_mean + 2.0 * 2.0 * p_lands, 6);
    let flurry = turn(vec![atk(dagger()?), atk(dagger()?)], 0.0)?
        .on_any_crit_with(rs(4.0, 8.0)?, ConditionOptions::default())?
        .otherwise_with(
            vec![
                DamageSource::Attack(Box::new(unarmed()?)),
                DamageSource::Attack(Box::new(unarmed()?)),
            ],
            RiderOptions::default(),
        )?;
    assert!(want.mean(&flurry) > 0.0);
    want.done();
    Ok(())
}

#[test]
fn the_goliath_quotes_the_right_mean() -> T {
    let mut want = expect(
        FILE,
        "README: the goliath and the single-attack turn > quotes the right mean",
    );
    let goliath = turn(vec![atk(dagger()?), atk(dagger()?)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?
        .on_first_hit_with(d10(), FirstHitOptions::default())?
        .on_any_crit_with(rs(2.0, 8.0)?, ConditionOptions::default())?
        .otherwise_with(
            vec![
                DamageSource::Attack(Box::new(unarmed()?)),
                DamageSource::Attack(Box::new(unarmed()?)),
            ],
            RiderOptions::default(),
        )?
        .on_every_hit_with(d6(), EveryHitOptions::default())?;
    // Exactly 39.59025 (8.7 dagger + 9.9225 sneak + 5.1975 burn + 1.755 smite + 9.11525 flurry
    // + 4.9 mark), which the README rounds to 39.5903.
    close(want.mean(&goliath), 39.59025, 10);
    want.done();
    Ok(())
}

#[test]
fn a_bare_source_as_well_as_a_list() -> T {
    let mut want = expect(
        FILE,
        "README: the goliath and the single-attack turn > accepts a bare source as well as a list",
    );
    let a = want.mean(&turn(vec![atk(greatsword()?)], 0.0)?);
    let b = want.mean(&turn(vec![atk(greatsword()?)], 0.0)?);
    close(a, b, 12);
    want.done();
    Ok(())
}

fn paladin() -> Result<Turn, DiceError> {
    turn(vec![atk(dagger()?), atk(dagger()?)], 0.0)?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))
}

#[test]
fn ids_quotes_the_right_ids_and_fire_probability() -> T {
    let mut want = expect(
        FILE,
        "README: ids and plain data > quotes the right ids and fire probability",
    );
    let p = paladin()?;
    close(want.fire(&p, "smite"), 0.0975, 4);
    assert_eq!(p.attack_ids()?, vec!["attack 1", "attack 2"]);
    assert_eq!(p.rider_ids()?, vec!["smite"]);
    want.done();
    Ok(())
}

#[test]
fn ids_builds_the_same_turn_from_plain_data() -> T {
    let mut want = expect(
        FILE,
        "README: ids and plain data > builds the same turn from plain data",
    );
    let spec = TurnSpec {
        attacks: vec![named("dagger 1", dagger()?), named("dagger 2", dagger()?)],
        riders: Some(vec![Rider {
            trigger: Trigger::FirstHit {
                of: None,
                per_source: None,
            },
            id: Some("sneak".to_string()),
            damage: RiderDamageSpec::Plain(rs(3.0, 6.0)?.into()),
            crit_damage: None,
            landing: None,
            happens: None,
            joins: None,
            r#where: None,
            target_has: None,
        }]),
        ..TurnSpec::default()
    };
    let from_ui = Turn::from_spec(spec, 0.0)?;
    close(want.mean(&from_ui), 18.6225, 4);
    want.done();
    Ok(())
}

#[test]
fn smite_or_flurry() -> T {
    let mut want = expect(
        FILE,
        "README: smite or flurry > quotes the right mean and smite chance",
    );
    let paladin = paladin()?.otherwise_with(
        vec![
            DamageSource::Attack(Box::new(unarmed()?)),
            DamageSource::Attack(Box::new(unarmed()?)),
        ],
        RiderOptions::default(),
    )?;
    close(want.mean(&paladin), 19.57025, 10);
    close(want.fire(&paladin, "smite"), 0.0975, 12);
    want.done();
    Ok(())
}

fn shortsword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(5.0)?)
}

#[test]
fn the_figures_four_plain_shortswords_and_three_plain_fists() -> T {
    let mut want = expect(
        FILE,
        "README: the figures beside the grants > quotes four plain shortswords and three plain fists",
    );
    close(
        want.mean(&turn(vec![], 0.0)?.attacks(4.0, shortsword()?)?),
        22.8,
        10,
    );
    let three = turn(
        vec![atk(shortsword()?), atk(shortsword()?), atk(shortsword()?)],
        0.0,
    )?;
    close(want.mean(&three), 17.1, 10);
    want.done();
    Ok(())
}

#[test]
fn the_figures_stunning_strike_shape() -> T {
    let mut want = expect(
        FILE,
        "README: the figures beside the grants > quotes the Stunning Strike shape",
    );
    let stunning = turn(
        vec![atk(shortsword()?), atk(shortsword()?), atk(shortsword()?)],
        0.0,
    )?
    .on_first_hit_with(
        advantage().until_end_of_turn(),
        FirstHitOptions {
            condition: ConditionOptions {
                save: Some(TriggerSaves::One(TriggerSave::Dc(
                    d20().plus(2.0)?.dc(15.0)?,
                ))),
                on_save: Some(vec![advantage().until_next_attack().into()]),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;
    close(want.mean(&stunning), 19.76175, 10);
    want.done();
    Ok(())
}

#[test]
fn sweeping_ac() -> T {
    let mut want = expect(
        FILE,
        "README: sweeping AC > quotes the right mean at each AC",
    );
    let base = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?;
    let means: Vec<f64> = [12.0, 14.0, 16.0, 18.0, 20.0]
        .iter()
        .map(|&ac| Ok(want.mean(&base.vs_ac(ac)?)))
        .collect::<Result<_, DiceError>>()?;
    for (index, expected) in [26.6225, 24.66, 22.4875, 20.105, 17.5125]
        .iter()
        .enumerate()
    {
        close(means[index], *expected, 10);
    }
    want.done();
    Ok(())
}

#[test]
fn guide_riders_over_saving_throws() -> T {
    let mut want = expect(
        FILE,
        "guide: riders over saving throws > quotes the right fire probability and means for a fail-landing rider",
    );
    let fireball = d20()
        .dc(15.0)?
        .on_save_failure_args(&[crate::builder::roll::Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()?;
    let t = turn(vec![atk(dagger()?), atk(fireball.clone())], 0.0)?.on_first_hit_with(
        rs(2.0, 6.0)?,
        FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    landing: Some(crate::turn::types::SaveLanding::Fail),
                    id: Some("rider".to_string()),
                    ..RiderOptions::default()
                },
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;
    // 1 - P(dagger misses) * P(target passes) = 1 - 0.35 * 0.30
    close(want.fire(&t, "rider"), 0.895, 12);
    close(want.mean(&t), 34.69, 10);
    close(
        want.mean(&turn(vec![atk(dagger()?), atk(fireball)], 0.0)?),
        28.075,
        10,
    );
    want.done();
    Ok(())
}
