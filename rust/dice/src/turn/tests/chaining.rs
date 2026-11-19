//! `tests/turn-chaining.test.ts`: 8 tests, 30 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{EveryHitOptions, FirstHitOptions};
use crate::turn::types::{
    DamageSource, Rider, RiderDamage, RiderDamageSpec, RiderOptions, Trigger,
};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/turn-chaining.test.ts";

fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(4.0)?)
}
fn unarmed() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(4.0)?)
}

fn two() -> Result<Turn, DiceError> {
    let d = dagger()?;
    turn(vec![atk(d.clone()), atk(d)], 0.0)
}

fn unarmed_pair() -> Result<RiderDamage, DiceError> {
    let u = unarmed()?;
    Ok(RiderDamage::Many(vec![
        DamageSource::Attack(Box::new(u.clone())),
        DamageSource::Attack(Box::new(u)),
    ]))
}

fn rider(trigger: Trigger, id: Option<&str>, damage: impl Into<RiderDamage>) -> Rider {
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

fn first_hit() -> Trigger {
    Trigger::FirstHit {
        of: None,
        per_source: None,
    }
}
fn any_crit() -> Trigger {
    Trigger::AnyCrit {
        of: None,
        max: None,
    }
}
fn any_miss() -> Trigger {
    Trigger::AnyMiss { of: None }
}
fn every_hit() -> Trigger {
    Trigger::EveryHit {
        of: None,
        max: None,
        per_source: None,
    }
}

#[test]
fn each_on_x_method_matches_the_equivalent_rider_object() -> T {
    let mut want = expect(
        FILE,
        "chained trigger methods > each onX method matches the equivalent rider object",
    );
    let pairs = vec![
        (
            two()?.on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?,
            first_hit(),
        ),
        (
            two()?.on_any_crit_with(rs(3.0, 6.0)?, cond_default())?,
            any_crit(),
        ),
        (
            two()?.on_any_miss_with(rs(3.0, 6.0)?, RiderOptions::default())?,
            any_miss(),
        ),
        (
            two()?.on_every_hit_with(rs(3.0, 6.0)?, EveryHitOptions::default())?,
            every_hit(),
        ),
    ];
    for (chained, trigger) in pairs {
        let spelled = two()?.rider(rider(trigger, None, rs(3.0, 6.0)?))?;
        close(want.mean(&chained), want.mean(&spelled), 12);
        close(want.pmf(&chained).stdev(), want.pmf(&spelled).stdev(), 12);
    }
    want.done();
    Ok(())
}

fn cond_default() -> crate::turn::effects::ConditionOptions {
    crate::turn::effects::ConditionOptions::default()
}

#[test]
fn passes_options_through() -> T {
    let mut want = expect(FILE, "chained trigger methods > passes options through");
    let options = crate::turn::effects::ConditionOptions {
        rider: RiderOptions {
            id: Some("smite".to_string()),
            crit_damage: Some(rs(10.0, 6.0)?.into()),
            of: Some(vec!["attack 1".to_string()]),
            ..RiderOptions::default()
        },
        ..cond_default()
    };
    let chained = two()?.on_any_crit_with(d6(), options)?;
    let mut spelled_rider = rider(
        Trigger::AnyCrit {
            of: Some(vec!["attack 1".to_string()]),
            max: None,
        },
        Some("smite"),
        d6(),
    );
    spelled_rider.crit_damage = Some(rs(10.0, 6.0)?.into());
    let spelled = two()?.rider(spelled_rider)?;

    close(want.mean(&chained), want.mean(&spelled), 12);
    close(want.fire(&chained, "smite"), 0.05, 10);
    want.done();
    Ok(())
}

#[test]
fn builds_the_goliath_turn_identically_to_the_rider_form() -> T {
    let mut want = expect(
        FILE,
        "chained trigger methods > builds the goliath turn identically to the rider form",
    );
    let chained = two()?
        .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?
        .on_first_hit_with(d10(), FirstHitOptions::default())?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?
        .otherwise_with(unarmed_pair()?, RiderOptions::default())?
        .on_every_hit_with(d6(), EveryHitOptions::default())?;

    let spelled = two()?
        .rider(rider(first_hit(), None, rs(3.0, 6.0)?))?
        .rider(rider(first_hit(), None, d10()))?
        .rider(rider(any_crit(), Some("smite"), rs(2.0, 8.0)?))?
        .rider(rider(
            Trigger::NotFired {
                of: "smite".to_string(),
            },
            None,
            unarmed_pair()?,
        ))?
        .rider(rider(every_hit(), None, d6()))?;

    close(want.mean(&chained), want.mean(&spelled), 10);
    close(want.pmf(&chained).stdev(), want.pmf(&spelled).stdev(), 10);
    close(want.fire(&chained, "smite"), 0.0975, 10);
    want.done();
    Ok(())
}

#[test]
fn negates_the_preceding_rider_even_when_it_has_no_id() -> T {
    let mut want = expect(
        FILE,
        "otherwise() > negates the preceding rider even when it has no id",
    );
    let built = two()?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_default())?
        .otherwise_with(d6(), RiderOptions::default())?;
    let base = want.mean(&two()?);
    let p_crit = 0.0975;
    // 4d8 on a crit (the dice double), 1d6 the rest of the time.
    close(
        want.mean(&built) - base,
        p_crit * 18.0 + (1.0 - p_crit) * 3.5,
        8,
    );
    want.done();
    Ok(())
}

#[test]
fn makes_the_pair_mutually_exclusive() -> T {
    let mut want = expect(FILE, "otherwise() > makes the pair mutually exclusive");
    let built = two()?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?
        .otherwise_with(d6(), rid("flurry"))?;
    let sum = want.fire(&built, "smite") + want.fire(&built, "flurry");
    close(sum, 1.0, 10);
    want.done();
    Ok(())
}

#[test]
fn alternates_rather_than_ladders_when_chained() -> T {
    let mut want = expect(
        FILE,
        "otherwise() > alternates rather than ladders when chained",
    );
    // `c` fires whenever `b` did not, which is exactly when `a` did.
    let built = two()?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_default())?
        .otherwise_with(d6(), RiderOptions::default())?
        .otherwise_with(d4(), RiderOptions::default())?;
    let base = want.mean(&two()?);
    let p_crit = 0.0975;
    close(
        want.mean(&built) - base,
        p_crit * (18.0 + 2.5) + (1.0 - p_crit) * 3.5,
        8,
    );
    want.done();
    Ok(())
}

#[test]
fn rejects_a_missing_predecessor() -> T {
    let d = dagger()?;
    let result = turn(vec![atk(d)], 0.0)?.otherwise_with(d6(), RiderOptions::default());
    assert!(matches!(result, Err(DiceError::TurnSpec(_))));
    Ok(())
}

#[test]
fn rejects_negating_an_every_hit_rider() -> T {
    let d = dagger()?;
    let result = turn(vec![atk(d)], 0.0)?
        .on_every_hit_with(d6(), EveryHitOptions::default())?
        .otherwise_with(d6(), RiderOptions::default());
    match result {
        Err(e) => assert!(e.message().contains("more than once"), "{}", e.message()),
        Ok(_) => panic!("expected an error"),
    }
    Ok(())
}
