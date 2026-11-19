//! `tests/turn-large-walk.test.ts`: 2 tests, 9 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::EveryHitOptions;
use crate::turn::turn;

const FILE: &str = "tests/turn-large-walk.test.ts";
const SUITE: &str = "a turn of 34 attacks with riders";

// +9 against AC 16: 6/20 miss, 13/20 hit, 1/20 crit. A hit deals d6+5 (8.5), a crit 2d6+5 (12).
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(9.0, 16.0, d6().plus(5.0)?)
}
const P_MISS: f64 = 6.0 / 20.0;
const P_CRIT: f64 = 1.0 / 20.0;
const P_LAND: f64 = 14.0 / 20.0;
const ROWS: f64 = 34.0;

fn mean_per_attack() -> f64 {
    (13.0 / 20.0) * 8.5 + P_CRIT * 12.0
}

#[test]
fn walks_to_the_exact_mean_of_every_rider() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > walks to the exact mean of every rider"),
    );
    let t = turn(vec![], 0.0)?
        .attacks(ROWS, sword()?)?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?
        .on_every_hit_with(d6(), every_hit(Some("mark"), None))?
        .on_any_miss_with(d10(), rid("reroll"))?;

    let any_landed = 1.0 - P_MISS.powf(ROWS);
    let any_crit = 1.0 - (1.0 - P_CRIT).powf(ROWS);
    let any_miss = 1.0 - P_LAND.powf(ROWS);
    // The first landing is a crit with probability P_CRIT / P_LAND; Sneak's 3d6 doubles then.
    let sneak = any_landed * (10.5 * (1.0 - P_CRIT / P_LAND) + 21.0 * (P_CRIT / P_LAND));
    let smite = any_crit * 18.0; // 2d8 doubled, always in crit mode
    let mark = ROWS * ((13.0 / 20.0) * 3.5 + P_CRIT * 7.0);
    let reroll = any_miss * 5.5;
    let expected = ROWS * mean_per_attack() + sneak + smite + mark + reroll;

    close(want.mean(&t), expected, 8);
    close(want.pmf(&t).mean(), expected, 8);
    close(want.pmf(&t).mass(), 1.0, 12);
    close(want.fire(&t, "sneak"), any_landed, 12);
    close(want.fire(&t, "smite"), any_crit, 12);
    close(want.fire(&t, "reroll"), any_miss, 12);
    want.done();
    Ok(())
}

#[test]
fn keeps_the_whole_distribution_not_just_its_mean() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > keeps the whole distribution, not just its mean"),
    );
    let t = turn(vec![], 0.0)?
        .attacks(ROWS, sword()?)?
        .on_every_hit_with(d6(), EveryHitOptions::default())?;
    // Every attack lands with probability P_LAND, so P(deal nothing) is P_MISS ** rows.
    close(want.pmf(&t).p_at(0.0), P_MISS.powf(ROWS), 12);
    close(want.pmf(&t).mass(), 1.0, 12);
    close(
        want.mean(&t),
        ROWS * (mean_per_attack() + (13.0 / 20.0) * 3.5 + P_CRIT * 7.0),
        8,
    );
    want.done();
    Ok(())
}
