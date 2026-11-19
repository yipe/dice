//! Translated from `src/builder/roll.test.ts` lines 641-1232.

use super::support::*;
use crate::builder::factory::*;
use crate::builder::nodes::{ExpressionNode, Rounding};
use crate::builder::roll::{Arg, RollBuilder, RollKind, sum_rolls};
use crate::builder::types::RollConfig;
use crate::common::RollType;
use crate::error::DiceError;
use crate::parser::parse_with;

/// `roll(1).d6()`.
fn r6() -> Result<RollBuilder, DiceError> {
    RollBuilder::new(1.0)?.d6()
}

/// `roll(2).d6()`.
fn r26() -> Result<RollBuilder, DiceError> {
    RollBuilder::new(2.0)?.d6()
}

/// Hand-enumerated (mean, mass) of a `sides`-sided die exploding at most `times` times.
fn brute_force_explode(sides: u32, times: u32) -> (f64, f64) {
    fn walk(sides: u32, times: u32, depth: u32, acc: f64, p: f64, out: &mut (f64, f64)) {
        for v in 1..=sides {
            let pv = p / f64::from(sides);
            if v == sides && depth < times {
                walk(sides, times, depth + 1, acc + f64::from(v), pv, out);
            } else {
                out.0 += (acc + f64::from(v)) * pv;
                out.1 += pv;
            }
        }
    }
    let mut out = (0.0, 0.0);
    walk(sides, times, 0, 0.0, 1.0, &mut out);
    out
}

/// roll.test.ts:649
#[test]
fn should_have_correct_mean_for_d20_with_elven_accuracy() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d20()?.with_elven_accuracy()?);
    assert_close(pmf.mean(), 15.4875, 2);
    assert_eq!(pmf.min(), 1.0);
    assert_eq!(pmf.max(), 20.0);
    Ok(())
}

/// roll.test.ts:660
#[test]
fn should_have_correct_mean_for_d6_reroll_1() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.reroll(1.0)?);
    assert!(pmf.mean() > 3.5, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 1.0);
    assert_eq!(pmf.max(), 6.0);
    Ok(())
}

/// roll.test.ts:669
#[test]
fn should_have_correct_mean_for_d6_reroll_1_and_2() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.reroll(2.0)?);
    assert!(pmf.mean() > 4.0, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 1.0);
    assert_eq!(pmf.max(), 6.0);
    Ok(())
}

/// roll.test.ts:678
#[test]
fn should_have_correct_mean_for_d20_reroll_1_halfling() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d20()?.reroll(1.0)?);
    assert!(pmf.mean() > 10.5, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 1.0);
    assert_eq!(pmf.max(), 20.0);
    Ok(())
}

/// roll.test.ts:689
#[test]
fn d6_reroll_1_exact_per_face_probabilities_and_mean() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.reroll(1.0)?);
    assert_close(pmf.p_at(1.0), 1.0 / 36.0, 10);
    for v in 2..=6 {
        assert_close(pmf.p_at(f64::from(v)), 7.0 / 36.0, 10);
    }
    assert_close(pmf.mean(), 47.0 / 12.0, 10);
    Ok(())
}

/// roll.test.ts:698
#[test]
fn d6_reroll_1_and_2_exact_per_face_probabilities_and_mean() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.reroll(2.0)?);
    assert_close(pmf.p_at(1.0), 2.0 / 36.0, 10);
    assert_close(pmf.p_at(2.0), 2.0 / 36.0, 10);
    for v in 3..=6 {
        assert_close(pmf.p_at(f64::from(v)), 8.0 / 36.0, 10);
    }
    assert_close(pmf.mean(), 25.0 / 6.0, 10);
    Ok(())
}

/// roll.test.ts:708
#[test]
fn two_d8_plus_1_with_reroll_1_2_on_each_die_mean_11_5() -> T {
    let pmf = pmf_of(&RollBuilder::new(2.0)?.d8()?.reroll(2.0)?.plus(1.0)?);
    assert_close(pmf.mean(), 11.5, 10);
    Ok(())
}

/// roll.test.ts:716
#[test]
fn should_have_correct_mean_for_d6_minimum_2() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.minimum(2.0)?);
    assert!(pmf.mean() > 3.5, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 2.0);
    assert_eq!(pmf.max(), 6.0);
    Ok(())
}

/// roll.test.ts:725
#[test]
fn should_have_correct_mean_for_d6_minimum_4() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.minimum(4.0)?);
    assert!(pmf.mean() > 4.0, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 4.0);
    assert_eq!(pmf.max(), 6.0);
    Ok(())
}

/// roll.test.ts:756
#[test]
fn d6_explode_1_has_total_mass_1_and_matches_the_hand_enumerated_mean_not_the_old_0_861_3_667_bug()
-> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.explode(1.0)?);
    let (mean, mass) = brute_force_explode(6, 1);
    assert_close(pmf.mass(), mass, 10);
    assert_close(pmf.mass(), 1.0, 10);
    assert_close(pmf.mean(), mean, 10);
    assert_close(pmf.mean(), 4.0833333333, 8);
    Ok(())
}

/// roll.test.ts:765
#[test]
fn d6_explode_2_caps_the_chain_at_2_extra_dice_not_exactly_2_extra_dice() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d6()?.explode(2.0)?);
    let (mean, mass) = brute_force_explode(6, 2);
    assert_close(pmf.mass(), mass, 10);
    assert_close(pmf.mass(), 1.0, 10);
    assert_close(pmf.mean(), mean, 10);
    assert_close(pmf.mean(), 4.1805555556, 8);
    Ok(())
}

/// roll.test.ts:773
#[test]
fn d8_explode_3_matches_the_hand_enumerated_mean() -> T {
    let pmf = pmf_of(&RollBuilder::new(1.0)?.d8()?.explode(3.0)?);
    let (mean, mass) = brute_force_explode(8, 3);
    assert_close(pmf.mass(), mass, 10);
    assert_close(pmf.mass(), 1.0, 10);
    assert_close(pmf.mean(), mean, 10);
    assert_close(pmf.mean(), 5.1416015625, 8);
    Ok(())
}

/// roll.test.ts:781
#[test]
fn to_expression_throws_on_an_exploding_die_instead_of_silently_dropping_the_explode_and_re_parsing_to_a_wrong_distribution_regression()
-> T {
    assert_throws(
        RollBuilder::new(1.0)?.d6()?.explode(1.0)?.to_expression(),
        "cannot represent an exploding die",
    );
    Ok(())
}

/// roll.test.ts:789
#[test]
fn should_have_correct_mean_for_4d6_keep_highest_3() -> T {
    let pmf = pmf_of(&RollBuilder::new(4.0)?.d6()?.keep_highest(4.0, 3.0)?);
    assert!(pmf.mean() > 10.5, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 3.0);
    assert_eq!(pmf.max(), 18.0);
    Ok(())
}

/// roll.test.ts:798
#[test]
fn should_have_correct_mean_for_4d6_keep_lowest_2() -> T {
    let pmf = pmf_of(&RollBuilder::new(4.0)?.d6()?.keep_lowest(4.0, 2.0)?);
    assert!(pmf.mean() < 7.0, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 2.0);
    assert_eq!(pmf.max(), 12.0);
    Ok(())
}

/// roll.test.ts:809
#[test]
fn should_roll_each_die_of_2d6_plus_3_with_advantage() -> T {
    let pmf = pmf_of(&RollBuilder::new(2.0)?.d6()?.with_advantage()?.plus(3.0)?);
    assert_close(pmf.mean(), 161.0 / 18.0 + 3.0, 12);
    assert_eq!(pmf.min(), 5.0);
    assert_eq!(pmf.max(), 15.0);
    Ok(())
}

/// roll.test.ts:818
#[test]
fn should_have_correct_mean_for_3d6_reroll_1_minimum_2_plus_5() -> T {
    let pmf = pmf_of(
        &RollBuilder::new(3.0)?
            .d6()?
            .reroll(1.0)?
            .minimum(2.0)?
            .plus(5.0)?,
    );
    assert!(pmf.mean() > 15.5, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 11.0);
    assert_eq!(pmf.max(), 23.0);
    Ok(())
}

/// roll.test.ts:831
#[test]
fn should_have_correct_mean_for_6d8_keep_highest_4_plus_2() -> T {
    let pmf = pmf_of(
        &RollBuilder::new(6.0)?
            .d8()?
            .keep_highest(6.0, 4.0)?
            .plus(2.0)?,
    );
    assert!(pmf.mean() > 20.0, "mean {}", pmf.mean());
    assert_eq!(pmf.min(), 6.0);
    assert_eq!(pmf.max(), 34.0);
    Ok(())
}

/// roll.test.ts:843
#[test]
fn should_subtract_a_number_from_the_roll_modifier() -> T {
    let b = roll_dice(2.0, 6.0, Some(5.0))?.minus(3.0)?;
    assert_eq!(b.to_expression()?, "2d6 + 2");
    assert_close(pmf_of(&b).mean(), 9.0, 2);
    Ok(())
}

/// roll.test.ts:849
#[test]
fn should_subtract_a_rollbuilder_from_the_current_roll() -> T {
    let b = roll_dice(2.0, 6.0, None)?.minus_roll(&d4())?;
    assert_eq!(b.to_expression()?, "2d6 - 1d4");
    assert_close(pmf_of(&b).mean(), 7.0 - 2.5, 2);
    Ok(())
}

/// roll.test.ts:855
#[test]
fn should_subtract_a_number_of_rollbuilders_from_the_current_roll() -> T {
    let b = roll_dice(3.0, 8.0, None)?.minus_dice(2.0, &d6())?;
    assert_eq!(b.to_expression()?, "3d8 - 2d6");
    assert_close(pmf_of(&b).mean(), 3.0 * 4.5 - 2.0 * 3.5, 2);
    Ok(())
}

/// roll.test.ts:861
#[test]
fn should_handle_chained_minus_operations_correctly() -> T {
    let b = roll_with(0.0, None, None)?
        .plus(10.0)?
        .minus(2.0)?
        .minus(3.0)?;
    assert_eq!(b.to_expression()?, "5");
    assert_eq!(pmf_of(&b).mean(), 5.0);
    Ok(())
}

/// roll.test.ts:867
#[test]
fn should_correctly_subtract_a_roll_that_includes_a_subtraction() -> T {
    let subtracted = roll_dice(1.0, 8.0, None)?.minus_roll(&d4())?;
    let b = roll_dice(1.0, 20.0, None)?.minus_roll(&subtracted)?;
    assert_eq!(b.to_expression()?, "d20 - 1d8 ~+ 1d4");
    assert_close(pmf_of(&b).mean(), 10.5 - 4.5 + 2.5, 2);
    Ok(())
}

/// roll.test.ts:876
#[test]
fn should_double_normal_dice() -> T {
    let b = roll_dice(2.0, 6.0, Some(5.0))?.double_dice()?;
    assert_eq!(b.to_expression()?, "4d6 + 5");
    Ok(())
}

/// roll.test.ts:881
#[test]
fn should_double_keep_highest_of_1_dice_inside_each_trial() -> T {
    let b = roll_with(1.0, None, None)?
        .d(6.0)?
        .keep_highest(4.0, 1.0)?
        .double_dice()?;
    assert_eq!(b.to_expression()?, "4kh1(2d6)");
    Ok(())
}

/// roll.test.ts:886
#[test]
fn should_refuse_to_double_a_keephighest_of_more_than_one_die_no_single_doubled_meaning() -> T {
    assert_throws(
        roll_with(1.0, None, None)?
            .d(6.0)?
            .keep_highest(4.0, 3.0)?
            .double_dice(),
        "4kh3",
    );
    Ok(())
}

/// roll.test.ts:890
#[test]
fn should_refuse_to_double_keeplowest_dice_no_single_doubled_meaning() -> T {
    assert_throws(
        roll_with(1.0, None, None)?
            .d(6.0)?
            .keep_lowest(4.0, 3.0)?
            .double_dice(),
        "4kl3",
    );
    Ok(())
}

/// roll.test.ts:894
#[test]
fn should_refuse_a_keeplowest_4_3_on_the_doubled_2d6_which_has_more_than_one_reading() -> T {
    let e = error_of(
        roll_with(1.0, None, None)?
            .d(6.0)?
            .double_dice()?
            .keep_lowest(4.0, 3.0),
    );
    assert!(
        matches!(e, crate::error::DiceError::AmbiguousKeep(_)),
        "{e}"
    );
    Ok(())
}

/// roll.test.ts:898
#[test]
fn should_not_affect_modifiers() -> T {
    let b = roll_with(0.0, None, None)?.plus(5.0)?.double_dice()?;
    assert_eq!(b.to_expression()?, "5");
    Ok(())
}

/// roll.test.ts:903
#[test]
fn should_handle_rolls_with_no_dice() -> T {
    let b = RollBuilder::zero().double_dice()?;
    assert_eq!(b.to_expression()?, "0");
    Ok(())
}

/// roll.test.ts:908
#[test]
fn should_double_multiple_dice_configs() -> T {
    let b = roll_dice(2.0, 6.0, None)?
        .plus_roll(&roll_dice(3.0, 8.0, None)?)?
        .double_dice()?;
    let e = b.to_expression()?;
    assert!(e.contains("6d8"), "{e}");
    assert!(e.contains("4d6"), "{e}");
    Ok(())
}

/// roll.test.ts:915
#[test]
fn preserves_a_half_wrapper_instead_of_silently_collapsing_to_plain_doubled_dice_regression() -> T {
    let halved = roll_dice(1.0, 8.0, None)?.plus(3.0)?.half()?;
    let doubled = halved.copy()?.double_dice()?;
    assert_close(doubled.pmf()?.mean(), 368.0 / 64.0, 8);
    Ok(())
}

/// roll.test.ts:923
#[test]
fn preserves_a_scale_wrapper_instead_of_silently_collapsing_to_plain_doubled_dice_regression() -> T
{
    let vuln = roll_with(1.0, Some(SidesOrDie::Die(d6())), None)?.scale_result(
        2.0,
        1.0,
        Rounding::Floor,
    )?;
    let doubled = vuln.copy()?.double_dice()?;
    assert_close(doubled.pmf()?.mean(), 14.0, 8);
    Ok(())
}

/// roll.test.ts:931
#[test]
fn preserves_a_compositesumrollbuilders_per_part_wrappers_instead_of_collapsing_to_mean_0_regression()
-> T {
    let base = roll_with(1.0, Some(SidesOrDie::Die(d6())), None)?;
    let resisted = roll_dice(1.0, 8.0, None)?.half()?;
    let composite = sum_rolls(&[base, resisted])?;
    let doubled = composite.copy()?.double_dice()?;
    assert_close(doubled.pmf()?.mean(), 11.25, 8);
    Ok(())
}

/// roll.test.ts:943
#[test]
fn should_not_be_mutable_via_constructor_config_array() -> T {
    let mut configs = vec![RollConfig {
        count: 1.0,
        sides: 6.0,
        modifier: 0.0,
        reroll: 0.0,
        explode: 0.0,
        explode_pool_budget: 0.0,
        minimum: 0.0,
        best_of: 0.0,
        keep: None,
        roll_type: RollType::Flat,
        is_subtraction: None,
        pinned: false,
    }];
    let b = RollBuilder::with_configs(&configs);
    assert_eq!(b.to_expression()?, "1d6");
    configs[0].sides = 20.0;
    assert_eq!(b.to_expression()?, "1d6");
    Ok(())
}

/// roll.test.ts:971
#[test]
fn should_throw_for_nan_in_constructor() -> T {
    assert_throws(RollBuilder::new(f64::NAN), "Invalid NaN value for count");
    Ok(())
}

/// roll.test.ts:975
#[test]
fn should_throw_for_nan_in_d() -> T {
    assert_throws(
        roll_with(1.0, None, None)?.d(f64::NAN),
        "Invalid NaN value for sides",
    );
    Ok(())
}

/// roll.test.ts:979
#[test]
fn should_throw_for_nan_in_plus() -> T {
    assert_throws(r6()?.plus(f64::NAN), "Invalid NaN value for modOrRoll");
    assert_throws(
        r6()?.plus_dice(f64::NAN, &d6()),
        "Invalid NaN value for modOrRoll",
    );
    Ok(())
}

/// roll.test.ts:988
#[test]
fn should_throw_for_nan_in_minus() -> T {
    assert_throws(r6()?.minus(f64::NAN), "Invalid NaN value for modOrRoll");
    assert_throws(
        r6()?.minus_dice(f64::NAN, &d6()),
        "Invalid NaN value for modOrRoll",
    );
    Ok(())
}

/// roll.test.ts:997
#[test]
fn should_throw_for_nan_in_reroll() -> T {
    assert_throws(r6()?.reroll(f64::NAN), "Invalid NaN value for reroll");
    Ok(())
}

/// roll.test.ts:1003
#[test]
fn should_throw_for_nan_in_explode() -> T {
    assert_throws(
        r6()?.explode(f64::NAN),
        "Invalid NaN value for explode count",
    );
    Ok(())
}

/// roll.test.ts:1009
#[test]
fn should_throw_for_nan_in_minimum() -> T {
    assert_throws(r6()?.minimum(f64::NAN), "Invalid NaN value for minimum");
    Ok(())
}

/// roll.test.ts:1015
#[test]
fn should_throw_for_nan_in_bestof() -> T {
    assert_throws(
        r6()?.best_of(f64::NAN),
        "Invalid NaN value for bestOf count",
    );
    Ok(())
}

/// roll.test.ts:1021
#[test]
fn should_throw_for_nan_in_keephighest() -> T {
    assert_throws(
        r26()?.keep_highest(f64::NAN, 1.0),
        "Invalid NaN value for keepHighest",
    );
    assert_throws(
        r26()?.keep_highest(2.0, f64::NAN),
        "Invalid NaN value for keepHighest",
    );
    Ok(())
}

/// roll.test.ts:1030
#[test]
fn should_throw_for_nan_in_keeplowest() -> T {
    assert_throws(
        r26()?.keep_lowest(f64::NAN, 1.0),
        "Invalid NaN value for keepLowest",
    );
    assert_throws(
        r26()?.keep_lowest(2.0, f64::NAN),
        "Invalid NaN value for keepLowest",
    );
    Ok(())
}

/// roll.test.ts:1051
#[test]
fn should_throw_for_nan_in_addroll() -> T {
    assert_throws(r6()?.add_roll(f64::NAN), "Invalid NaN value for count");
    Ok(())
}

/// roll.test.ts:1057
#[test]
fn should_throw_for_nan_in_fromargs() -> T {
    assert_throws(
        RollBuilder::from_args(&[Arg::Num(f64::NAN)]),
        "Invalid NaN value for argument",
    );
    assert_throws(
        RollBuilder::from_args(&[Arg::Num(f64::NAN), Arg::Num(6.0)]),
        "Invalid NaN value for count argument",
    );
    assert_throws(
        RollBuilder::from_args(&[Arg::Num(1.0), Arg::Num(f64::NAN)]),
        "Invalid NaN value for sides argument",
    );
    assert_throws(
        RollBuilder::from_args(&[Arg::Num(1.0), Arg::Num(6.0), Arg::Num(f64::NAN)]),
        "Invalid NaN value for modOrRoll",
    );
    Ok(())
}

/// roll.test.ts:1074
#[test]
fn should_create_a_half_roll_builder() -> T {
    let halved = roll_dice(2.0, 6.0, None)?.plus(3.0)?.half()?;
    assert!(matches!(halved.kind(), RollKind::Half { .. }));
    Ok(())
}

/// roll.test.ts:1081
#[test]
fn should_format_expression_with_parentheses_and_2() -> T {
    let halved = roll_dice(2.0, 6.0, None)?.plus(3.0)?.half()?;
    assert_eq!(halved.to_expression()?, "(2d6 + 3) // 2");
    Ok(())
}

/// roll.test.ts:1088
#[test]
fn should_work_with_simple_dice_rolls() -> T {
    let halved = roll_dice(1.0, 8.0, None)?.half()?;
    assert_eq!(halved.to_expression()?, "(1d8) // 2");
    Ok(())
}

/// roll.test.ts:1095
#[test]
fn should_work_with_complex_expressions() -> T {
    let damage = roll_dice(3.0, 6.0, None)?
        .plus_roll(&roll_dice(2.0, 4.0, None)?)?
        .plus(5.0)?;
    assert_eq!(damage.half()?.to_expression()?, "(3d6 + 2d4 + 5) // 2");
    Ok(())
}

/// roll.test.ts:1102
#[test]
fn should_work_with_advantage_rolls() -> T {
    let halved = roll_dice(2.0, 6.0, None)?.with_advantage()?.half()?;
    assert_eq!(halved.to_expression()?, "(2(d6 > d6)) // 2");
    Ok(())
}

/// roll.test.ts:1109
#[test]
fn should_produce_correct_ast() -> T {
    let halved = roll_dice(1.0, 6.0, None)?.plus(3.0)?.half()?;
    match halved.to_ast()? {
        ExpressionNode::Half(h) => assert!(matches!(*h.child, ExpressionNode::Add(_))),
        other => {
            return Err(DiceError::error(format!(
                "expected a half node, got {other:?}"
            )));
        }
    }
    Ok(())
}

/// roll.test.ts:1118
#[test]
fn should_calculate_pmf_correctly() -> T {
    let pmf = pmf_of(&roll_dice(1.0, 4.0, None)?.half()?);
    assert_close(pmf.p_at(0.0), 0.25, 2);
    assert_close(pmf.p_at(1.0), 0.5, 2);
    assert_close(pmf.p_at(2.0), 0.25, 2);
    Ok(())
}

/// roll.test.ts:1129
#[test]
fn should_handle_chaining_methods_after_half() -> T {
    let copied = roll_dice(2.0, 6.0, None)?.half()?.copy()?;
    assert_eq!(copied.to_expression()?, "(2d6) // 2");
    assert!(matches!(copied.kind(), RollKind::Half { .. }));
    Ok(())
}

/// roll.test.ts:1138
#[test]
fn should_work_with_constants_only() -> T {
    let halved = roll_with(0.0, None, None)?.plus(8.0)?.half()?;
    assert_eq!(halved.to_expression()?, "(8) // 2");
    assert_close(pmf_of(&halved).p_at(4.0), 1.0, 2);
    Ok(())
}

/// roll.test.ts:1176
#[test]
fn keep_highest_semantics_crit_pool_should_exceed_hit_pool_mean() -> T {
    let hit_only = roll_dice(1.0, 12.0, None)?.keep_highest(2.0, 1.0)?;
    let crit_only = roll_dice(2.0, 12.0, None)?.keep_highest(2.0, 1.0)?;
    assert!(pmf_of(&crit_only).mean() > pmf_of(&hit_only).mean());
    Ok(())
}

/// roll.test.ts:1189
#[test]
fn reroll_k_for_every_k_re_parses_to_the_same_mean_as_the_builder_s_own_pmf() -> T {
    for (sides, k) in [(6, 1), (6, 2), (6, 3), (4, 3), (8, 4)] {
        let base = RollBuilder::new(1.0)?;
        let die = match sides {
            4 => base.d4()?,
            6 => base.d6()?,
            _ => base.d8()?,
        };
        let builder = die.reroll(f64::from(k))?;
        let parsed = parse_with(&builder.to_expression()?, 0.0)?;
        assert_close(parsed.mean(), pmf_of(&builder).mean(), 10);
    }
    Ok(())
}

/// roll.test.ts:1203
#[test]
fn gwf_shaped_2d6_reroll_2_round_trips_to_the_exact_25_3_mean_not_the_old_chained_reroll_8_6() -> T
{
    let builder = roll_with(2.0, Some(SidesOrDie::Die(d6())), None)?.reroll(2.0)?;
    let parsed = parse_with(&builder.to_expression()?, 0.0)?;
    assert_close(pmf_of(&builder).mean(), 25.0 / 3.0, 10);
    assert_close(parsed.mean(), 25.0 / 3.0, 10);
    Ok(())
}

/// roll.test.ts:1210
#[test]
fn keephighest_n_n_k_pool_of_n_individual_dice_re_parses_to_the_correct_per_die_pool_mean_not_the_old_4x_inflated_4d6_per_trial_reading()
-> T {
    let builder = roll_with(4.0, Some(SidesOrDie::Die(d6())), None)?.keep_highest(4.0, 3.0)?;
    let parsed = parse_with(&builder.to_expression()?, 0.0)?;
    assert_close(pmf_of(&builder).mean(), 12.2446, 3);
    assert_close(parsed.mean(), pmf_of(&builder).mean(), 10);
    Ok(())
}

/// roll.test.ts:1217
#[test]
fn keeplowest_n_n_k_pool_of_n_individual_dice_re_parses_correctly() -> T {
    let builder = roll_with(4.0, Some(SidesOrDie::Die(d8())), None)?.keep_lowest(4.0, 2.0)?;
    let parsed = parse_with(&builder.to_expression()?, 0.0)?;
    assert_close(parsed.mean(), pmf_of(&builder).mean(), 10);
    Ok(())
}

/// roll.test.ts:1223
#[test]
fn keephighest_1_n_where_the_trial_count_coincidentally_equals_the_die_count_still_re_parses_as_a_sum_of_trials_pool_not_a_per_die_pool()
-> T {
    let builder = roll_with(3.0, Some(SidesOrDie::Die(d6())), None)?.keep_highest(3.0, 1.0)?;
    let parsed = parse_with(&builder.to_expression()?, 0.0)?;
    assert_close(parsed.mean(), pmf_of(&builder).mean(), 10);
    Ok(())
}
