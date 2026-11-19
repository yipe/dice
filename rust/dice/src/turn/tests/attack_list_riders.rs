//! `tests/turn-attack-list-riders.test.ts`: 4 tests, 61 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, advantage, keep_best_damage,
};
use crate::turn::types::{DamageSource, RiderDamage, RiderOptions};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/turn-attack-list-riders.test.ts";
const SUITE: &str = "a rider whose damage is a list of several attacks";

// Dagger and unarmed strike: miss 7/20, hit 12/20, crit 1/20 each.
fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(4.0)?)
}
fn unarmed() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(4.0)?)
}

fn unarmed_pair() -> Result<RiderDamage, DiceError> {
    let u = unarmed()?;
    Ok(RiderDamage::Many(vec![
        DamageSource::Attack(Box::new(u.clone())),
        DamageSource::Attack(Box::new(u)),
    ]))
}

fn ro() -> RiderOptions {
    RiderOptions::default()
}
fn of(ids: &[&str]) -> RiderOptions {
    RiderOptions {
        of: Some(ids.iter().map(std::string::ToString::to_string).collect()),
        ..RiderOptions::default()
    }
}
fn fh_of(ids: &[&str]) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: of(ids),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}
fn eh_of(ids: &[&str]) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: fh_of(ids),
        ..EveryHitOptions::default()
    }
}

/// `codeOf(build)`: the code of the `TurnSpecError` `build().mean()` throws, or "none".
fn code_of_build(build: impl FnOnce() -> Result<Turn, DiceError>) -> String {
    code_of(build().and_then(|t| t.mean()))
}

struct Slices {
    hit: Pmf,
    crit: Pmf,
    miss: Pmf,
}

fn slices() -> Result<Slices, DiceError> {
    let pmf = dagger()?.pmf()?;
    Ok(Slices {
        hit: pmf.filter_outcome("hit"),
        crit: pmf.filter_outcome("crit"),
        miss: pmf.filter_outcome("missNone"),
    })
}

fn flurry() -> Result<Turn, DiceError> {
    turn(vec![atk(dagger()?)], 0.0)?.on_any_miss_with(unarmed_pair()?, rid("flurry"))
}

#[test]
fn cannot_be_watched_naming_it_in_of_is_not_an_attack() -> T {
    assert_eq!(
        code_of_build(|| flurry()?.on_first_hit_with(d10(), fh_of(&["flurry"]))),
        "not-an-attack"
    );
    assert_eq!(
        code_of_build(|| flurry()?.on_every_hit_with(d10(), eh_of(&["flurry"]))),
        "not-an-attack"
    );
    assert_eq!(
        code_of_build(|| flurry()?.on_any_crit_with(
            d10(),
            ConditionOptions {
                rider: of(&["flurry"]),
                ..ConditionOptions::default()
            }
        )),
        "not-an-attack"
    );
    assert_eq!(
        code_of_build(|| flurry()?.on_first_hit_transform(keep_best_damage(), fh_of(&["flurry"]))),
        "not-an-attack"
    );
    let refused = flurry()?
        .on_first_hit_with(d10(), fh_of(&["flurry"]))
        .and_then(|t| t.mean());
    match refused {
        Err(e) => assert!(e.message().contains("its own rider"), "{}", e.message()),
        Ok(_) => panic!("expected an error"),
    }
    Ok(())
}

#[test]
fn never_joins_a_later_riders_default_of() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > never joins a later rider's default `of`"),
    );
    // Hunter's mark watches the dagger only: miss -> the flurry's damage; hit/crit -> the mark.
    let t = turn(vec![atk(dagger()?)], 0.0)?
        .on_any_miss_with(unarmed_pair()?, ro())?
        .on_every_hit_with(d6(), EveryHitOptions::default())?;
    let up = unarmed()?.pmf()?;
    let pair = up.convolve(&up, None, false);
    let s = slices()?;
    let expected = s
        .miss
        .convolve(&pair, None, true)
        .add(&s.hit.convolve(&d6().pmf()?, None, true))
        .add(&s.crit.convolve(&rs(2.0, 6.0)?.pmf()?, None, true));
    let mut support: Vec<f64> = want
        .pmf(&t)
        .support()
        .iter()
        .chain(expected.support().iter())
        .map(|d| d.0)
        .collect();
    support.sort_by(f64::total_cmp);
    support.dedup();
    for value in support {
        close(want.pmf(&t).p_at(value), expected.p_at(value), 12);
    }
    close(want.mean(&t), 2067.0 / 200.0, 12);
    want.done();
    Ok(())
}

#[test]
fn still_deals_the_exact_sum_of_its_attacks() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > still deals the exact sum of its attacks"),
    );
    let t = flurry()?;
    let up = unarmed()?.pmf()?;
    let s = slices()?;
    let expected = s
        .miss
        .convolve(&up.convolve(&up, None, false), None, true)
        .add(&s.hit)
        .add(&s.crit);
    for d in expected.support() {
        close(want.pmf(&t).p_at(d.0), expected.p_at(d.0), 12);
    }
    close(want.fire(&t, "flurry"), 7.0 / 20.0, 14);
    want.done();
    Ok(())
}

#[test]
fn refuses_a_granted_modifier_it_would_read_rather_than_ignoring_it() -> T {
    let d = dagger()?;
    let code = code_of_build(|| {
        turn(vec![atk(d.clone()), atk(d.clone())], 0.0)?
            .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?
            .otherwise_with(unarmed_pair()?, ro())?
            .on_every_hit_with(
                advantage().until_next_attack(),
                eh_of(&["attack 1", "attack 2"]),
            )
    });
    assert_eq!(code, "no-rebindable-source");
    Ok(())
}
