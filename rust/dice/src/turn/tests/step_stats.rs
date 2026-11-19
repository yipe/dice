//! `src/turn/step-stats.test.ts`: 8 tests, 19 compat calls.
//!
//! Not translated: step-stats.test.ts:121: the `(first.live as ...).advantage = 0` half of "returns a
//! copy" (`LiveOdds` has no public setter; `StepStats` is an owned value, so the `hit` mutation is
//! the only one spelled and a later read is checked against the same table).

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{
    ConditionOptions, FirstHitOptions, TriggerSave, TriggerSaves, advantage,
};
use crate::turn::{StepStats, Turn, turn};

const FILE: &str = "src/turn/step-stats.test.ts";
const SUITE: &str = "Turn.stepStats";

// Every oracle below is +8 vs AC 16, crit on 20: shortsword 1d6+5, dagger 1d4+5,
// rapier 1d8+5, fist 1d6+4. Expected values are the §3 per-swing tables, pinned
// to 4 decimals.
fn ss() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d6+5")
}
fn dg() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d4+5")
}
fn rapier() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d8+5")
}
fn fist() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d6+4")
}

fn expect_stats(stats: &StepStats, hit: f64, crit: f64, advantage: f64) {
    close(stats.rolled, 1.0, 10);
    close(stats.hit, hit, 4);
    close(stats.crit, crit, 4);
    close(stats.live.advantage(), advantage, 4);
    close(stats.live.disadvantage(), 0.0, 10);
    close(stats.live.crit_on_hit(), 0.0, 10);
}

fn name(test: &str) -> String {
    format!("{SUITE} > {test}")
}

fn next_attack() -> crate::turn::effects::Grant {
    advantage().until_next_attack()
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn every_hit_grant(source: AttackBuilder) -> Result<AttackBuilder, DiceError> {
    source.on_every_hit_with(
        crate::builder::attack::Grants::One(next_attack().into()),
        None,
    )
}

#[test]
fn reports_f2s_per_swing_table() -> T {
    let mut want = expect(FILE, &name("reports F2's per-swing table"));
    let v = every_hit_grant(ss()?)?;
    let t = turn(
        vec![named("s1", v.clone()), named("s2", v), named("d", dg()?)],
        0.0,
    )?;
    expect_stats(&want.step_stats(&t, "s1"), 0.65, 0.05, 0.0);
    expect_stats(&want.step_stats(&t, "s2"), 0.7979, 0.0809, 0.65);
    expect_stats(&want.step_stats(&t, "d"), 0.8315, 0.0879, 0.7979);
    want.done();
    Ok(())
}

#[test]
fn reports_f3s_per_swing_table() -> T {
    let mut want = expect(FILE, &name("reports F3's per-swing table"));
    let v = every_hit_grant(ss()?)?;
    let t = turn(
        vec![
            named("s1", v.clone()),
            named("s2", v.clone()),
            named("s3", v.clone()),
            named("s4", v),
        ],
        0.0,
    )?;
    expect_stats(&want.step_stats(&t, "s1"), 0.65, 0.05, 0.0);
    expect_stats(&want.step_stats(&t, "s2"), 0.7979, 0.0809, 0.65);
    expect_stats(&want.step_stats(&t, "s3"), 0.8315, 0.0879, 0.7979);
    expect_stats(&want.step_stats(&t, "s4"), 0.8392, 0.0895, 0.8315);
    want.done();
    Ok(())
}

#[test]
fn reports_f12s_advantage_column() -> T {
    let mut want = expect(FILE, &name("reports F12's advantage column"));
    let v = every_hit_grant(rapier()?)?;
    let t = turn(
        vec![
            named("r1", v.clone()),
            named("r2", v),
            named("f1", fist()?),
            named("f2", fist()?),
        ],
        0.0,
    )?
    .on_first_hit_with(d_expression("1d6")?, FirstHitOptions::default())?
    .on_first_hit_with(
        advantage().until_end_of_turn(),
        FirstHitOptions {
            condition: ConditionOptions {
                save: Some(TriggerSaves::One(TriggerSave::Dc(
                    d20().plus(2.0)?.dc(15.0)?,
                ))),
                on_save: Some(vec![next_attack().into()]),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;

    close(want.mean(&t), 30.8749, 4);
    close(want.step_stats(&t, "r1").live.advantage(), 0.0, 4);
    close(want.step_stats(&t, "r2").live.advantage(), 0.65, 4);
    // §3 lists f1 as 84.56%; the exact walk mass is 84.565% (0.84565), within 1e-4.
    close(want.step_stats(&t, "f1").live.advantage(), 0.8456, 3);
    close(want.step_stats(&t, "f2").live.advantage(), 0.6061, 4);
    want.done();
    Ok(())
}

#[test]
fn reports_source_probabilities_with_live_zero_on_a_turn_with_no_conditions() -> T {
    let mut want = expect(
        FILE,
        &name("reports source probabilities with live.* = 0 on a turn with no conditions"),
    );
    let t = turn(vec![named("a", ss()?), named("b", dg()?)], 0.0)?;
    expect_stats(&want.step_stats(&t, "a"), 0.65, 0.05, 0.0);
    expect_stats(&want.step_stats(&t, "b"), 0.65, 0.05, 0.0);
    want.done();
    Ok(())
}

#[test]
fn reports_an_attack_shaped_riders_fire_mass_as_rolled() -> T {
    let mut want = expect(
        FILE,
        &name("reports an attack-shaped rider's fire mass as rolled"),
    );
    // A reroll that rolls its own attack: on the first miss, reroll the same attack.
    let t = turn(vec![named("a", ss()?)], 0.0)?.on_first_miss_with(ss()?, rid("reroll"))?;
    let reroll = want.step_stats(&t, "reroll");
    // It fires iff the first attack missed (0.35), and lands at the source's own 0.65.
    close(reroll.rolled, 0.35, 4);
    close(reroll.hit, 0.35 * 0.65, 4);
    close(reroll.crit, 0.35 * 0.05, 4);
    want.done();
    Ok(())
}

#[test]
fn throws_unknown_id_for_a_damage_rider_condition_substitute_or_unknown_id() -> T {
    let t = turn(vec![named("a", ss()?)], 0.0)?
        .on_any_crit_with(d_expression("2d6")?, cond_id("smite"))?;
    for id in ["smite", "condition 1", "nope"] {
        let result: Result<StepStats, DiceError> = t.step_stats(id);
        assert_eq!(code_of(result), "unknown-id", "{id}");
    }
    Ok(())
}

#[test]
fn sums_a_first_miss_riders_several_steps_under_one_id() -> T {
    let mut want = expect(
        FILE,
        &name("sums a first-miss rider's several steps under one id"),
    );
    let t = turn(vec![named("a", ss()?), named("b", ss()?)], 0.0)?
        .on_first_miss_with(ss()?, rid("reroll"))?;
    let reroll = want.step_stats(&t, "reroll");
    // Fires iff a misses (0.35) or a hits and b misses (0.65 × 0.35).
    let fired = 0.35 + 0.65 * 0.35;
    close(reroll.rolled, fired, 4);
    close(reroll.hit, fired * 0.65, 4);
    close(reroll.crit, fired * 0.05, 4);
    want.done();
    Ok(())
}

#[test]
fn reports_unit_mass_stats_when_a_later_source_pmf_has_mass_other_than_1() -> T {
    let mut want = expect(
        FILE,
        &name("reports unit-mass stats when a later source PMF has mass other than 1"),
    );
    let doubled: Pmf = ss()?.to_pmf(0.0)?.scale_mass(2.0);
    let t = turn(
        vec![named("a", ss()?.to_pmf(0.0)?), named("b", doubled)],
        0.0,
    )?;
    let stats = want.step_stats(&t, "a");
    close(stats.rolled, 1.0, 10);
    close(stats.hit, 0.65, 4);
    close(stats.crit, 0.05, 4);
    close(stats.live.advantage(), 0.0, 10);
    want.done();
    Ok(())
}

#[test]
fn returns_a_copy_so_mutating_the_result_cannot_change_later_reads() -> T {
    let mut want = expect(
        FILE,
        &name("returns a copy, so mutating the result cannot change later reads"),
    );
    let v = every_hit_grant(ss()?)?;
    let t: Turn = turn(vec![named("s1", v.clone()), named("s2", v)], 0.0)?;
    let mut first = want.step_stats(&t, "s2");
    first.hit = 0.0;
    expect_stats(&want.step_stats(&t, "s2"), 0.7979, 0.0809, 0.65);
    want.done();
    Ok(())
}
