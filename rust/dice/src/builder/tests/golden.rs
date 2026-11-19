//! Differential check against the TypeScript original: `golden_chains.json` is the output of
//! `golden_chains.gen.ts.txt` (run with `npx tsx`), one record per builder chain with its
//! `toExpression()` (or the error it throws) and its `toPMF()` bins at full precision. Each chain
//! is rebuilt here through the Rust builder and compared (bins within 1e-9, errors exactly).

use super::support::*;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{RollBuilder, RollRerollUpToOptions, sum_rolls};
use crate::error::DiceError;
use serde_json::Value;

fn r(count: f64) -> Result<RollBuilder, DiceError> {
    roll_with(count, None, None)
}

fn of(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn chain(name: &str) -> Result<RollBuilder, DiceError> {
    match name {
        "explode_d6_3" => r(2.0)?.d(6.0)?.explode(3.0),
        "explode_d4_1_min2" => r(1.0)?.d(4.0)?.minimum(2.0)?.explode(1.0),
        "explode_reroll" => r(3.0)?.d(6.0)?.reroll(2.0)?.explode(2.0),
        "explodePool_3d6_2" => r(3.0)?.d(6.0)?.explode_pool(2.0),
        "explodePool_2d4_3_plus" => r(2.0)?.d(4.0)?.explode_pool(3.0)?.plus(2.0),
        "explodePool_d1" => r(2.0)?.d(1.0)?.explode_pool(2.0),
        "kh_4d6_3" => of(4.0, d6())?.keep_highest(4.0, 3.0),
        "kl_5d8_2" => of(5.0, d8())?.keep_lowest(5.0, 2.0),
        "kh_trials" => of(2.0, d6())?.keep_highest(3.0, 1.0),
        "kl_trials" => of(2.0, d6())?.keep_lowest(3.0, 1.0),
        "bestOf_5d10_3_plus" => r(5.0)?.d(10.0)?.best_of(3.0)?.plus(4.0),
        "bestOf_6d6_4" => r(6.0)?.d(6.0)?.best_of(4.0),
        "khAll_times" => of(2.0, d6())?
            .plus(1.0)?
            .keep_highest_all(3.0, 2.0)?
            .times(2.0),
        "klAll" => of(3.0, d8())?.keep_lowest_all(4.0, 2.0)?.plus_roll(&d4()),
        "adv_d6" => r(2.0)?.d(6.0)?.with_advantage(),
        "elven_d8_x2" => r(2.0)?.d(8.0)?.with_elven_accuracy()?.plus(1.0),
        "dis_d20_min" => r(1.0)?.d(20.0)?.minimum(5.0)?.with_disadvantage(),
        "adv_hd20_plus" => hd20().with_advantage()?.plus(5.0),
        "elven_hd20" => hd20().with_elven_accuracy(),
        "d20_expl" => d20().reroll(2.0)?.minimum(3.0)?.with_advantage(),
        "half_2d6" => of(2.0, d6())?.half()?.plus(1.0),
        "scale_floor" => of(3.0, d6())?.scale_result(1.0, 2.0, Rounding::Floor),
        "scale_ceil" => of(3.0, d4())?.scale_result(3.0, 2.0, Rounding::Ceil),
        "scale_round" => of(2.0, d8())?.scale_result(2.0, 3.0, Rounding::Round),
        "vuln" => of(2.0, d6())?
            .plus(3.0)?
            .scale_result(2.0, 1.0, Rounding::Floor),
        "maxOf_3" => of(2.0, d6())?.plus(3.0)?.max_of(3.0),
        "maxOf_other" => of(3.0, d8())?.max_of_roll(&of(2.0, d10())?),
        "sum_half_scale" => sum_rolls(&[
            of(2.0, d6())?.half()?,
            of(1.0, d8())?.scale_result(2.0, 1.0, Rounding::Floor)?,
            d4(),
        ]),
        "sub_groups" => of(2.0, d6())?
            .minus_roll(&d4())?
            .plus_roll(&of(1.0, d8())?)?
            .plus(-2.0),
        "rerollUpTo_2d6" => of(2.0, d6())?.reroll_up_to(1.0, None),
        "rerollUpTo_mixed" => of(2.0, d6())?
            .plus_roll(&of(1.0, d8())?)?
            .plus(3.0)?
            .reroll_up_to(2.0, None),
        "rerollUpTo_rolls" => of(2.0, d6())?.reroll_up_to(
            1.0,
            Some(&RollRerollUpToOptions {
                rolls: Some(2.0),
                ..Default::default()
            }),
        ),
        "rerollUpTo_once" => of(1.0, d8())?.plus(3.0)?.reroll_up_to(
            1.0,
            Some(&RollRerollUpToOptions {
                rolls: Some(2.0),
                rolled_once: Some(of(1.0, d10())?),
            }),
        ),
        "rerollUpTo_sub" => of(2.0, d6())?.minus_roll(&d4())?.reroll_up_to(1.0, None),
        "rerollUpTo_gwf" => of(3.0, d6())?
            .reroll(2.0)?
            .minimum(2.0)?
            .reroll_up_to(2.0, None),
        "gwf_reroll2_2d6" => of(2.0, d6())?.reroll(2.0),
        "pooled_scale" => of(2.0, d6())?
            .plus(3.0)?
            .keep_highest_all(2.0, 1.0)?
            .scale_dice(2.0),
        "doubled_kh" => of(1.0, d12())?.keep_highest(2.0, 1.0)?.double_dice(),
        "flat_only" => flat(5.0),
        "neg_flat" => r(0.0)?.plus(-3.0),
        "zero_dice" => roll_with(0.0, Some(SidesOrDie::Sides(6.0)), Some(3.0)),
        "repeated_kh" => of(2.0, d6().keep_highest(2.0, 1.0)?),
        "repeated_neg" => of(-2.0, d6().plus(1.0)?),
        "d_string" => d_expression("2d6+3")?.plus(0.0),
        other => Err(DiceError::error(format!("no chain {other}"))),
    }
}

/// Every chain of the TS golden file agrees with the Rust builder: expression text (or error), and
/// every bin of `toPMF()`.
#[test]
fn chains_match_the_typescript_output() -> T {
    let golden: Value =
        serde_json::from_str(include_str!("golden_chains.json")).map_err(|e| e.to_string())?;
    let entries = golden.as_object().ok_or("golden is an object")?;
    assert!(entries.len() >= 40);
    let mut worst = 0.0f64;
    for (name, want) in entries {
        let built = chain(name).map_err(|e| format!("{name}: {e}"))?;
        match (want.get("expr"), want.get("exprErr")) {
            (Some(e), _) => assert_eq!(built.to_expression()?, e.as_str().ok_or("expr")?, "{name}"),
            (_, Some(e)) => {
                assert_eq!(
                    err_of(built.to_expression()),
                    e.as_str().ok_or("exprErr")?,
                    "{name}"
                );
            }
            _ => return Err(DiceError::error(format!("{name}: no expression in golden"))),
        }
        let pmf = built.to_pmf(0.0)?;
        let bins = want.get("bins").and_then(Value::as_array).ok_or("bins")?;
        assert_eq!(pmf.support().len(), bins.len(), "{name}: support size");
        for (bin, got) in bins.iter().zip(pmf.support()) {
            let pair = bin.as_array().ok_or("bin")?;
            let value = pair[0].as_f64().ok_or("value")?;
            let p = pair[1].as_f64().ok_or("p")?;
            assert_eq!(got.0, value, "{name}: support value");
            let diff = (pmf.p_at(value) - p).abs();
            worst = worst.max(diff);
            assert!(
                diff < 1e-9,
                "{name}: P({value}) = {} vs {p}",
                pmf.p_at(value)
            );
        }
    }
    assert!(worst < 1e-9);
    Ok(())
}
