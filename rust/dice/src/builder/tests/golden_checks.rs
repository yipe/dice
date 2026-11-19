//! Differential check of the attack / save / AC / DC builders against the TypeScript original:
//! `golden_checks.json` is the output of `golden_checks.gen.ts.txt` (run with `npx tsx`): for each
//! chain its `toExpression()` (or the error it throws), its `mean()` and the bins of
//! `toPMF().toJSON()` (damage, probability and per-outcome-label counts) at full precision. Each
//! chain is rebuilt here through the Rust builders and compared (bins within 1e-9, in TS map
//! order; errors exactly).

use super::support::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::dc::RolledIn;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::save::SaveBuilder;
use crate::builder::types::MissRerollMode;
use crate::common::RollType;
use crate::error::DiceError;
use crate::turn::context::{PenaltyDice, RowContext};
use serde_json::Value;

/// A built chain: its expression (none for a bare PMF), PMF and mean.
struct Out {
    expr: Option<Result<String, DiceError>>,
    pmf: Pmf,
    mean: Option<f64>,
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn fa(a: AttackBuilder) -> Result<Out, DiceError> {
    let pmf = a.to_pmf(0.0)?;
    Ok(Out {
        expr: Some(a.to_expression()),
        mean: Some(pmf.mean()),
        pmf,
    })
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn fs(s: SaveBuilder) -> Result<Out, DiceError> {
    let pmf = s.to_pmf(0.0)?;
    Ok(Out {
        expr: Some(s.to_expression()),
        mean: Some(pmf.mean()),
        pmf,
    })
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn fr(r: RollBuilder) -> Result<Out, DiceError> {
    let pmf = r.to_pmf(0.0)?;
    Ok(Out {
        expr: Some(r.to_expression()),
        mean: Some(pmf.mean()),
        pmf,
    })
}

fn fp(p: Pmf) -> Result<Out, DiceError> {
    Ok(Out {
        expr: None,
        pmf: p,
        mean: None,
    })
}

fn rl(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn ctx() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: Vec::new(),
        joined: Vec::new(),
    }
}

fn base() -> Result<RollBuilder, DiceError> {
    d20().plus(7.0)?.ac(16.0)
}

fn atk(check: &RollBuilder, damage: RollBuilder) -> Result<AttackBuilder, DiceError> {
    check.on_hit(damage)
}

fn dc_of(modifier: f64, dc: f64) -> Result<RollBuilder, DiceError> {
    d20().plus(modifier)?.dc(dc)
}

fn fail(check: &RollBuilder, damage: RollBuilder) -> Result<SaveBuilder, DiceError> {
    check.on_save_failure_args(&[Arg::Roll(damage)])
}

fn flat_n(n: f64) -> Result<RollBuilder, DiceError> {
    flat(n)
}

fn chain(name: &str) -> Result<Out, DiceError> {
    let two_d6 = || rl(2.0, d6());
    let g = |c: &mut RowContext, f: &dyn Fn(&mut RowContext)| f(c);
    let _ = g;
    match name {
        "ac_check" => fr(d20().plus(5.0)?.ac(15.0)?),
        "ac_check_adv" => fr(d20().plus(5.0)?.with_advantage()?.ac(15.0)?),
        "ac_check_bonus" => fr(d20().plus(5.0)?.plus_roll(&d4())?.ac(15.0)?),
        "a_basic" => fa(atk(&d20().plus(5.0)?.ac(15.0)?, d8())?),
        "a_2d6" => fa(atk(&base()?, two_d6()?.plus(4.0)?)?),
        "a_adv" => fa(atk(
            &d20().plus(7.0)?.with_advantage()?.ac(16.0)?,
            two_d6()?.plus(4.0)?,
        )?),
        "a_dis" => fa(atk(
            &d20().plus(7.0)?.with_disadvantage()?.ac(16.0)?,
            two_d6()?.plus(4.0)?,
        )?),
        "a_elven" => fa(atk(
            &d20().plus(7.0)?.with_elven_accuracy()?.ac(16.0)?,
            d8().plus(3.0)?,
        )?),
        "a_three_dice" => fa(atk(
            &d20()
                .plus(7.0)?
                .with_advantage()?
                .ac(16.0)?
                .three_dice_advantage()?,
            d8().plus(3.0)?,
        )?),
        "a_three_dice_flat" => fa(atk(
            &d20().plus(7.0)?.ac(16.0)?.three_dice_advantage()?,
            d8().plus(3.0)?,
        )?),
        "a_crit19" => fa(atk(&base()?.crit_on(19.0)?, two_d6()?)?),
        "a_crit17_adv" => fa(atk(
            &d20().plus(7.0)?.with_advantage()?.ac(16.0)?.crit_on(17.0)?,
            d10().plus(2.0)?,
        )?),
        "a_nocrit" => fa(atk(&base()?, two_d6()?)?.no_crit()?),
        "a_oncrit" => fa(atk(&base()?, two_d6()?)?.on_crit(&[Arg::Roll(rl(3.0, d8())?)])?),
        "a_onmiss" => fa(atk(&base()?, two_d6()?)?.on_miss(&[Arg::Roll(d4())])?),
        "a_halfmiss" => fa(atk(&base()?, two_d6()?.plus(3.0)?)?.half_on_miss()?),
        "a_sep" => fa(atk(&base()?, d8().plus(4.0)?)?.plus_separate_damage(two_d6()?)),
        "a_sep_oncrit" => fa(atk(&base()?, d8())?
            .on_crit(&[Arg::Roll(rl(3.0, d8())?)])?
            .plus_separate_damage(two_d6()?)),
        "a_nat20" => fa(
            atk(&d20().plus(9.0)?.ac(17.0)?.crit_on(18.0)?, d8().plus(5.0)?)?
                .plus_natural20_damage(flat_n(5.0)?)?,
        ),
        "a_nat20_adv_sep" => fa(atk(
            &d20().plus(9.0)?.with_advantage()?.ac(17.0)?,
            d8().plus(5.0)?,
        )?
        .plus_separate_damage(d4())
        .plus_natural20_damage(two_d6()?)?),
        "a_reroll_dmg" => fa(atk(&base()?, two_d6()?.plus(3.0)?)?.reroll_damage(2.0)?),
        "a_min_die" => fa(atk(&base()?, two_d6()?.plus(3.0)?)?.minimum_damage_die(2.0)?),
        "a_reroll_min" => fa(atk(&base()?, two_d6()?.plus(3.0)?)?
            .reroll_damage(2.0)?
            .minimum_damage_die(3.0)?),
        "a_reroll_oncrit" => fa(atk(&base()?, two_d6()?)?
            .reroll_damage(2.0)?
            .on_crit(&[Arg::Roll(rl(4.0, d6())?)])?),
        "a_up_to" => fa(atk(&base()?, two_d6()?.plus(3.0)?)?.reroll_damage_up_to(1.0, None)?),
        "a_up_to_rolls" => {
            fa(atk(&base()?, rl(3.0, d6())?.plus(3.0)?)?.reroll_damage_up_to(2.0, Some(2.0))?)
        }
        "a_bless" => fa(atk(&d20().plus(7.0)?.plus_roll(&d4())?.ac(16.0)?, d8())?),
        "a_bane" => fa(atk(&d20().plus(7.0)?.minus_roll(&d4())?.ac(16.0)?, d8())?),
        "a_always_hits" => fa(atk(&d20().plus(5.0)?.ac(15.0)?.always_hits()?, d8())?),
        "a_always_hits_crit19" => fa(atk(
            &d20().plus(5.0)?.ac(15.0)?.crit_on(19.0)?.always_hits()?,
            d8(),
        )?),
        "a_always_crits" => fa(atk(&d20().plus(5.0)?.ac(15.0)?.always_crits()?, d8())?),
        "a_always_both" => fa(atk(
            &d20().plus(5.0)?.ac(15.0)?.always_hits()?.always_crits()?,
            two_d6()?,
        )?),
        "a_reroll_miss" => fa(atk(
            &base()?.reroll_misses(MissRerollMode::AddD20)?,
            two_d6()?,
        )?),
        "a_reroll_miss_reroll" => fa(atk(
            &base()?.reroll_misses(MissRerollMode::Reroll)?,
            two_d6()?,
        )?),
        "a_reroll_miss_adv" => fa(atk(
            &d20()
                .plus(7.0)?
                .with_advantage()?
                .ac(16.0)?
                .reroll_misses(MissRerollMode::AddD20)?,
            d8(),
        )?),
        "a_reroll_miss_dis_reroll" => fa(atk(
            &d20()
                .plus(7.0)?
                .with_disadvantage()?
                .ac(16.0)?
                .reroll_misses(MissRerollMode::Reroll)?,
            d8(),
        )?),
        "a_attack_reroll_miss" => {
            fa(atk(&base()?, two_d6()?)?.reroll_misses(MissRerollMode::AddD20)?)
        }
        "a_withcheck_ac" => fa(atk(&base()?, two_d6()?)?
            .with_check(|c| crate::builder::types::Check { ac: 12.0, ..c })?),
        "a_withcheck_adv" => {
            fa(
                atk(&base()?, two_d6()?)?.with_check(|c| crate::builder::types::Check {
                    roll_type: RollType::Advantage,
                    ..c
                })?,
            )
        }
        "a_withcheck_crit" => {
            fa(
                atk(&base()?, two_d6()?)?.with_check(|c| crate::builder::types::Check {
                    crit_on_hit: true,
                    ..c
                })?,
            )
        }
        "a_ranged_pinned" => fa(atk(
            &d20()
                .plus(7.0)?
                .with_advantage()?
                .pinned()?
                .ac(16.0)?
                .ranged()?,
            d8(),
        )?),
        "a_str_damage" => fa(base()?.on_hit_args(&[Arg::Str("2d6+3".to_string())])?),
        "a_pooled_damage" => fa(atk(
            &base()?,
            two_d6()?.plus(2.0)?.keep_highest_all(2.0, 1.0)?,
        )?),
        "a_half_damage" => fa(atk(&base()?, two_d6()?.half()?)?),
        "a_hd20" => fa(atk(&hd20().plus(5.0)?.ac(15.0)?, d8())?),
        "a_typed_tagged" => fa(atk(&base()?, d8())?.typed("fire")?.tagged(&["spell"])?),
        "a_zero_ac" => fa(atk(&d20().plus(30.0)?.ac(10.0)?, d8())?),
        "a_impossible" => fa(atk(&d20().plus(-5.0)?.ac(40.0)?, d8())?),
        "a_under_adv" => fp(atk(&base()?, two_d6()?)?.under(
            &RowContext {
                roll_type: RollType::Advantage,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_dis" => fp(atk(&base()?, two_d6()?)?.under(
            &RowContext {
                roll_type: RollType::Disadvantage,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_elven" => fp(atk(&base()?, two_d6()?)?.under(
            &RowContext {
                roll_type: RollType::ElvenAccuracy,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_autohit" => fp(atk(&base()?, two_d6()?)?.under(
            &RowContext {
                auto_hit: true,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_crit" => fp(atk(&base()?, two_d6()?)?.under(
            &RowContext {
                crit_on_hit: true,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_autohit_crit" => fp(atk(&base()?, two_d6()?)?.under(
            &RowContext {
                auto_hit: true,
                crit_on_hit: true,
                roll_type: RollType::Advantage,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_vuln" => fp(atk(&base()?, two_d6()?.plus(3.0)?)?
            .on_miss(&[Arg::Roll(d4())])?
            .under(
                &RowContext {
                    vulnerable: true,
                    ..ctx()
                },
                0.0,
            )?),
        "a_under_vuln_adv_half" => fp(atk(&base()?, two_d6()?.plus(3.0)?)?.half_on_miss()?.under(
            &RowContext {
                vulnerable: true,
                roll_type: RollType::Advantage,
                ..ctx()
            },
            0.0,
        )?),
        "a_under_pinned" => fp(atk(
            &d20().plus(7.0)?.with_disadvantage()?.pinned()?.ac(16.0)?,
            d8(),
        )?
        .under(
            &RowContext {
                roll_type: RollType::Advantage,
                ..ctx()
            },
            0.0,
        )?),
        "a_miss_rerolled" => {
            fp(atk(&base()?, two_d6()?)?.miss_rerolled(MissRerollMode::Reroll, None, 0.0)?)
        }
        "a_miss_rerolled_add" => fp(
            atk(&d20().plus(7.0)?.with_advantage()?.ac(16.0)?, two_d6()?)?
                .plus_separate_damage(d4())
                .miss_rerolled(MissRerollMode::AddD20, None, 0.0)?,
        ),
        "a_miss_rerolled_ctx" => fp(atk(&base()?, two_d6()?)?.miss_rerolled(
            MissRerollMode::Reroll,
            Some(&RowContext {
                roll_type: RollType::Disadvantage,
                ..ctx()
            }),
            0.0,
        )?),
        "s_check" => fr(dc_of(5.0, 15.0)?),
        "s_check_dis" => fr(d20().plus(5.0)?.with_disadvantage()?.dc(15.0)?),
        "s_check_bonus" => fr(d20().plus(3.0)?.plus_roll(&d4())?.dc(14.0)?),
        "s_check_fails" => fr(dc_of(3.0, 14.0)?.always_fails()?),
        "s_basic" => fs(fail(&dc_of(5.0, 15.0)?, rl(8.0, d6())?)?),
        "s_half" => fs(fail(&dc_of(5.0, 15.0)?, rl(8.0, d6())?)?.save_half()?),
        "s_success" => fs(fail(&dc_of(5.0, 15.0)?, rl(8.0, d6())?)?
            .on_save_success_args(&[Arg::Roll(rl(1.0, d6())?)])?),
        "s_success_flat0" => {
            fs(fail(&dc_of(5.0, 15.0)?, rl(2.0, d8())?)?.on_save_success_args(&[Arg::Num(0.0)])?)
        }
        "s_dis" => fs(fail(
            &d20().plus(5.0)?.with_disadvantage()?.dc(15.0)?,
            rl(8.0, d6())?,
        )?
        .save_half()?),
        "s_adv_ability" => fs(fail(
            &d20()
                .plus(2.0)?
                .with_advantage()?
                .dc(13.0)?
                .ability("con")?,
            rl(4.0, d8())?,
        )?),
        "s_always_fails" => {
            fs(fail(&dc_of(5.0, 15.0)?.always_fails()?, rl(4.0, d8())?)?.save_half()?)
        }
        "s_no_fail_effect" => fs(dc_of(5.0, 15.0)?
            .on_save_failure_args(&[Arg::Num(0.0)])?
            .on_save_success_args(&[Arg::Roll(d4())])?),
        "s_parsed" => fs(dc_of(5.0, 15.0)?.on_save_failure_args(&[Arg::Str("3d6".to_string())])?),
        "s_parsed_half" => fs(dc_of(5.0, 15.0)?
            .on_save_failure_args(&[Arg::Str("3d6+1".to_string())])?
            .save_half()?),
        "s_pooled" => fs(fail(
            &dc_of(5.0, 15.0)?,
            rl(4.0, d6())?.keep_highest_all(4.0, 3.0)?,
        )?),
        "s_certain_pass" => fs(fail(&dc_of(30.0, 10.0)?, two_d6()?)?.save_half()?),
        "s_rolled_in" => fr(dc_of(5.0, 15.0)?.rolled_in(&RolledIn {
            roll_type: RollType::Disadvantage,
            auto_fail: false,
            penalty_dice: &[PenaltyDice {
                count: 1.0,
                sides: 4.0,
            }],
        })?),
        "s_under_pen" => fp(fail(&dc_of(5.0, 15.0)?, rl(4.0, d6())?)?
            .save_half()?
            .under(
                &RowContext {
                    penalty_dice: vec![
                        PenaltyDice {
                            count: 1.0,
                            sides: 4.0,
                        },
                        PenaltyDice {
                            count: 2.0,
                            sides: 6.0,
                        },
                    ],
                    ..ctx()
                },
                0.0,
            )?),
        "s_under_autofail" => fp(fail(&dc_of(5.0, 15.0)?, rl(4.0, d6())?)?
            .save_half()?
            .under(
                &RowContext {
                    auto_fail: true,
                    ..ctx()
                },
                0.0,
            )?),
        "s_under_vuln" => fp(fail(&dc_of(5.0, 15.0)?, rl(4.0, d6())?.plus(1.0)?)?
            .on_save_success_args(&[Arg::Roll(d4())])?
            .under(
                &RowContext {
                    vulnerable: true,
                    roll_type: RollType::Disadvantage,
                    ..ctx()
                },
                0.0,
            )?),
        "s_under_pinned" => fp(fail(
            &d20().plus(5.0)?.with_advantage()?.pinned()?.dc(15.0)?,
            rl(4.0, d6())?,
        )?
        .under(
            &RowContext {
                roll_type: RollType::Disadvantage,
                ..ctx()
            },
            0.0,
        )?),
        "s_effects" => fs(dc_of(5.0, 15.0)?.on_save_failure_effects(&[
            crate::builder::dc::FailurePart::Damage(Arg::Roll(rl(8.0, d6())?)),
        ])?),
        other => Err(DiceError::error(format!("no chain {other}"))),
    }
}

fn compare_pmf(name: &str, pmf: &Pmf, bins: &[Value], worst: &mut f64) -> T {
    let got = pmf.bins();
    assert_eq!(got.len(), bins.len(), "{name}: bin count");
    for ((value, bin), want) in got.iter().zip(bins) {
        let pair = want.as_array().ok_or("bin")?;
        let wv = pair[0].as_f64().ok_or("value")?;
        assert_eq!(value.0, wv, "{name}: bin order / value");
        let wp = pair[1]["p"].as_f64().ok_or("p")?;
        let diff = (bin.p - wp).abs();
        *worst = worst.max(diff);
        assert!(diff < 1e-9, "{name}: P({wv}) = {} vs {wp}", bin.p);
        let counts = pair[1]["count"].as_object().ok_or("count")?;
        for (label, c) in counts {
            let wc = c.as_f64().ok_or("count value")?;
            let gc = bin.count.get(label).copied().unwrap_or(0.0);
            assert!(
                (gc - wc).abs() < 1e-9,
                "{name}: count[{wv}][{label}] = {gc} vs {wc}"
            );
        }
        for (label, gc) in &bin.count {
            if !counts.contains_key(label) {
                assert!(gc.abs() < 1e-9, "{name}: extra label {label} at {wv}");
            }
        }
    }
    Ok(())
}

/// Every chain of the TS golden file agrees with the Rust builders: expression text (or error),
/// mean, and every bin of `toPMF()` with its outcome labels.
#[test]
fn check_chains_match_the_typescript_output() -> T {
    let golden: Value =
        serde_json::from_str(include_str!("golden_checks.json")).map_err(|e| e.to_string())?;
    let entries = golden.as_object().ok_or("golden is an object")?;
    assert!(entries.len() >= 40, "{} chains", entries.len());
    let mut worst = 0.0f64;
    for (name, want) in entries {
        let built = chain(name).map_err(|e| format!("{name}: {e}"))?;
        let Out { expr, pmf, mean } = built;
        match (expr, want.get("expr"), want.get("exprErr")) {
            (Some(got), Some(e), _) => {
                assert_eq!(got?, e.as_str().ok_or("expr")?, "{name}: expression");
            }
            (Some(got), _, Some(e)) => {
                assert_eq!(err_of(got), e.as_str().ok_or("exprErr")?, "{name}: error");
            }
            (None, None, None) => {}
            _ => {
                return Err(DiceError::error(format!(
                    "{name}: expression presence differs from TS"
                )));
            }
        }
        if let (Some(m), Some(w)) = (mean, want.get("mean").and_then(Value::as_f64)) {
            assert!((m - w).abs() < 1e-9, "{name}: mean {m} vs {w}");
        }
        let bins = want.get("bins").and_then(Value::as_array).ok_or("bins")?;
        compare_pmf(name, &pmf, bins, &mut worst)?;
    }
    assert!(worst < 1e-9);
    Ok(())
}
