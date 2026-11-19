//! `tests/save-success-payload.test.ts`: 2 tests, 5 compat calls (the Turn-reading ones; the other 38 builder-only cases are in `builder/tests/t_dc_save.rs`, lines 30-322 of the TS, and `halved before its scale` > `deals the hand-computed mixture` / `means 0.45` are there too).

use super::helpers::*;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::Arg;
use crate::builder::save::SaveBuilder;
use crate::error::DiceError;
use crate::turn::turn;

const FILE: &str = "tests/save-success-payload.test.ts";
const SUITE: &str = "a success halved BEFORE its scale (what dpr's saveHalfBeforeScale builds)";

const P_SUCCESS: f64 = 9.0 / 20.0;
const P_FAIL: f64 = 11.0 / 20.0;

/// Whole-roll vulnerability on 2d4: a failure deals 2 x s; a success 2 x floor(s / 2). d20 vs DC 12.
fn save() -> Result<SaveBuilder, DiceError> {
    let base = roll_with(2.0, Some(SidesOrDie::Die(d4())), None)?;
    let failure_scaled = base.scale_result(2.0, 1.0, Rounding::Floor)?;
    let success_scaled = base.half()?.scale_result(2.0, 1.0, Rounding::Floor)?;
    d20()
        .dc(12.0)?
        .on_save_failure_args(&[Arg::Roll(failure_scaled)])?
        .on_save_success_args(&[Arg::Roll(success_scaled)])
}

#[test]
fn reaches_a_turn_as_a_source_the_turn_mean_and_the_labelled_outcomes() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > reaches a Turn as a source: the turn mean and the labelled outcomes"),
    );
    let t = turn(vec![atk(save()?)], 0.0)?;
    close(want.mean(&t), 7.525, 12);
    close(want.pmf(&t).outcome_probability("saveHalf"), P_SUCCESS, 12);
    close(want.pmf(&t).outcome_probability("saveFail"), P_FAIL, 12);
    want.done();
    Ok(())
}

#[test]
fn is_a_rider_payload_an_attack_gates_poisoner_the_attack_plus_0_6_x_the_save() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SUITE} > is a rider payload an attack gates (Poisoner): the attack plus 0.6 x the save"
        ),
    );
    let save = save()?;
    // d20 + 5 vs AC 14 hits on 9+: 11/20 hit, 1/20 crit; a save payload does not double on the crit.
    let attack = d20()
        .plus(5.0)?
        .ac(14.0)?
        .on_hit_args(&[Arg::Roll(roll_with(
            1.0,
            Some(SidesOrDie::Die(d(8.0)?)),
            None,
        )?)])?;
    let t = turn(vec![named("atk", attack)], 0.0)?.on_first_hit_with(
        save.clone(),
        crate::turn::effects::FirstHitOptions {
            condition: crate::turn::effects::ConditionOptions {
                rider: crate::turn::types::RiderOptions {
                    id: Some("poison".to_string()),
                    of: Some(vec!["atk".to_string()]),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )?;
    let attack_mean = (11.0 / 20.0) * 4.5 + (1.0 / 20.0) * 9.0;
    close(want.mean(&t), attack_mean + 0.6 * save.pmf()?.mean(), 12);
    close(want.fire(&t, "poison"), 0.6, 12);
    want.done();
    Ok(())
}
