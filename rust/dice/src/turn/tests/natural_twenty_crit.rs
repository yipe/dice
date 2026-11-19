//! `tests/natural-twenty-crit.test.ts`: 6 tests (one loops over 5 roll types), 1 compat call.
//!
//! A natural 20 always hits and, unless the attack has `noCrit()`, always crits, whatever the AC,
//! the crit threshold, or `alwaysCrits()` / the turn-level `critOnHit()` grant.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::builder::types::Check;
use crate::error::DiceError;
use crate::turn::effects::{FirstHitOptions, crit_on_hit};
use crate::turn::turn;

const FILE: &str = "tests/natural-twenty-crit.test.ts";

fn damage() -> Result<RollBuilder, DiceError> {
    rs(1.0, 8.0)?.plus(3.0)
}
// E[2d8 + 3] on the crit.
const CRIT_MEAN: f64 = 12.0;

fn roll_types() -> Result<Vec<(&'static str, RollBuilder, f64)>, DiceError> {
    Ok(vec![
        ("flat", d20(), 1.0 / 20.0),
        ("advantage", d20().with_advantage()?, 39.0 / 400.0),
        ("disadvantage", d20().with_disadvantage()?, 1.0 / 400.0),
        (
            "elven accuracy",
            d20().with_elven_accuracy()?,
            1141.0 / 8000.0,
        ),
        ("halfling", hd20(), 21.0 / 400.0),
    ])
}

fn at_ac_26(die: &RollBuilder) -> Result<AttackBuilder, DiceError> {
    die.plus(5.0)?.ac(26.0)?.always_crits()?.on_hit(damage()?)
}

#[test]
fn always_crits_at_an_ac_only_a_natural_20_reaches() -> T {
    for (name, die, p_nat20) in roll_types()? {
        let res = at_ac_26(&die)?.resolve(0.0)?;
        close(res.weights.crit, p_nat20, 15);
        assert_eq!(res.weights.hit, 0.0, "{name}");
        close(res.weights.miss, 1.0 - p_nat20, 15);
        close(res.pmf.mean(), p_nat20 * CRIT_MEAN, 14);
    }
    Ok(())
}

#[test]
fn the_whole_pmf_is_the_crit_payload_at_1_20_and_nothing_otherwise() -> T {
    let pmf = at_ac_26(&d20())?.to_pmf(0.0)?;
    close(pmf.mean(), 3.0 / 5.0, 15);
    close(pmf.p_at(0.0), 19.0 / 20.0, 15);
    for a in 1..=8 {
        for b in 1..=8 {
            assert!(pmf.p_at(f64::from(a + b + 3)) > 0.0);
        }
    }
    // 2d8 + 3 = 19 on (8,8) only.
    close(pmf.p_at(19.0), 1.0 / 20.0 / 64.0, 15);
    Ok(())
}

#[test]
fn a_crit_on_hit_check_rebound_through_with_check_still_lands_on_a_natural_20() -> T {
    let res = d20()
        .plus(5.0)?
        .ac(26.0)?
        .on_hit(damage()?)?
        .with_check(|check| Check {
            crit_on_hit: true,
            ..check
        })?
        .resolve(0.0)?;
    close(res.weights.crit, 1.0 / 20.0, 15);
    close(res.pmf.mean(), 3.0 / 5.0, 15);
    Ok(())
}

#[test]
fn a_turn_level_crit_on_hit_grant_never_lowers_the_landing_chance() -> T {
    let mut want = expect(
        FILE,
        "a natural 20 lands when every hit is a crit > a turn-level critOnHit() grant never lowers the landing chance",
    );
    // Attack 2 lands on a natural 20 (a crit) with or without the grant: 3/5 + 3/5.
    let attack = d20().plus(5.0)?.ac(26.0)?.on_hit(damage()?)?;
    let granted = turn(vec![atk(attack.clone()), atk(attack)], 0.0)?.on_first_hit_with(
        crit_on_hit().until_end_of_turn(),
        FirstHitOptions::default(),
    )?;
    close(want.mean(&granted), 6.0 / 5.0, 12);
    want.done();
    Ok(())
}

#[test]
fn a_natural_20_crits_an_always_hitting_attack_whatever_its_crit_threshold() -> T {
    let res = d20()
        .plus(9.0)?
        .always_hits()?
        .crit_on(21.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .resolve(0.0)?;
    close(res.weights.crit, 1.0 / 20.0, 15);
    close(res.weights.hit, 19.0 / 20.0, 15);
    close(
        res.pmf.mean(),
        (19.0 / 20.0) * 7.0 + (1.0 / 20.0) * 14.0,
        14,
    );
    Ok(())
}

#[test]
fn a_natural_20_does_not_crit_an_always_hitting_attack_with_no_crit() -> T {
    let res = d20()
        .plus(9.0)?
        .always_hits()?
        .on_hit(rs(2.0, 6.0)?)?
        .no_crit()?
        .resolve(0.0)?;
    assert_eq!(res.weights.crit, 0.0);
    close(res.pmf.mean(), 7.0, 14);
    Ok(())
}
