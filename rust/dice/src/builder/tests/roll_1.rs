use super::support::*;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::builder::types::{KeepMode, KeepSpec, RollConfigPatch, RollType};
use crate::error::DiceError;
use crate::parser::parse_with;

fn r(count: f64) -> Result<RollBuilder, DiceError> {
    roll_with(count, None, None)
}

fn expr(b: &RollBuilder) -> Result<String, DiceError> {
    b.to_expression()
}

/// `copy()` keeps expression and mean.
fn copy_matches(original: &RollBuilder) -> T {
    let copy = original.copy()?;
    assert_eq!(expr(&copy)?, expr(original)?);
    assert_close(pmf_of(&copy).mean(), pmf_of(original).mean(), 5);
    Ok(())
}

/// min/max/mean triple.
fn check_stats(b: &RollBuilder, mean: f64, digits: i32, min: f64, max: f64) {
    let p = pmf_of(b);
    assert_close(p.mean(), mean, digits);
    assert_eq!(p.min(), min);
    assert_eq!(p.max(), max);
}

/// Table `testCases` in roll.test.ts.
/// roll.test.ts:12
#[test]
fn should_correctly_format_single_config() -> T {
    let kh = |total, count, mode| KeepSpec { total, count, mode };
    let cases: Vec<(&str, RollConfigPatch, &str)> = vec![
        (
            "Normal roll with modifier",
            RollConfigPatch {
                count: Some(3.0),
                sides: Some(6.0),
                modifier: Some(3.0),
                ..Default::default()
            },
            "3d6 + 3",
        ),
        (
            "Simple d20",
            RollConfigPatch {
                sides: Some(20.0),
                ..Default::default()
            },
            "d20",
        ),
        (
            "Minimum die roll",
            RollConfigPatch {
                sides: Some(6.0),
                minimum: Some(2.0),
                ..Default::default()
            },
            "2>d6",
        ),
        (
            "Reroll with multiple dice",
            RollConfigPatch {
                count: Some(2.0),
                sides: Some(6.0),
                reroll: Some(2.0),
                ..Default::default()
            },
            "2(d6 reroll d2)",
        ),
        (
            "Reroll with minimum",
            RollConfigPatch {
                sides: Some(4.0),
                reroll: Some(2.0),
                minimum: Some(2.0),
                ..Default::default()
            },
            "2>(d4 reroll d2)",
        ),
        (
            "Reroll with minimum and multiple dice",
            RollConfigPatch {
                count: Some(2.0),
                sides: Some(4.0),
                reroll: Some(2.0),
                minimum: Some(2.0),
                ..Default::default()
            },
            "2(2>(d4 reroll d2))",
        ),
        (
            "Advantage",
            RollConfigPatch {
                sides: Some(20.0),
                roll_type: Some(RollType::Advantage),
                ..Default::default()
            },
            "d20 > d20",
        ),
        (
            "Disadvantage",
            RollConfigPatch {
                sides: Some(20.0),
                roll_type: Some(RollType::Disadvantage),
                ..Default::default()
            },
            "d20 < d20",
        ),
        (
            "Elven Accuracy",
            RollConfigPatch {
                sides: Some(20.0),
                roll_type: Some(RollType::ElvenAccuracy),
                ..Default::default()
            },
            "d20 > d20 > d20",
        ),
        (
            "Keep Highest",
            RollConfigPatch {
                keep: Some(kh(4.0, 3.0, KeepMode::Highest)),
                sides: Some(6.0),
                ..Default::default()
            },
            "4kh3(1d6)",
        ),
        (
            "Keep Lowest",
            RollConfigPatch {
                keep: Some(kh(5.0, 2.0, KeepMode::Lowest)),
                sides: Some(10.0),
                ..Default::default()
            },
            "5kl2(1d10)",
        ),
        (
            "Halfling Dice (shorthand)",
            RollConfigPatch {
                sides: Some(20.0),
                reroll: Some(1.0),
                ..Default::default()
            },
            "hd20",
        ),
        (
            "Advantage with Halfling Dice",
            RollConfigPatch {
                sides: Some(20.0),
                reroll: Some(1.0),
                roll_type: Some(RollType::Advantage),
                ..Default::default()
            },
            "hd20 > hd20",
        ),
        (
            "Negative modifier",
            RollConfigPatch {
                sides: Some(12.0),
                modifier: Some(-4.0),
                ..Default::default()
            },
            "1d12 - 4",
        ),
    ];
    for (label, cfg, expected) in cases {
        assert_eq!(expr(&RollBuilder::from_config(&cfg))?, expected, "{label}");
    }
    Ok(())
}

/// roll.test.ts:88
#[test]
fn should_create_basic_dice() -> T {
    assert_eq!(expr(&r(2.0)?.d(6.0)?.plus(5.0)?)?, "2d6 + 5");
    Ok(())
}

/// roll.test.ts:109
#[test]
fn should_create_basic_dice_with_config() -> T {
    assert_eq!(
        expr(&r(2.0)?.d(6.0)?.plus(5.0)?.reroll(2.0)?)?,
        "2(d6 reroll d2) + 5"
    );
    Ok(())
}

/// roll.test.ts:115
#[test]
fn should_handle_simple_reroll() -> T {
    let a = d4().reroll(1.0)?;
    assert_eq!(expr(&a)?, "d4 reroll 1");
    assert_close(pmf_of(&a).mean(), 2.875, 1);
    Ok(())
}

/// roll.test.ts:123
#[test]
fn should_handle_harder_reroll() -> T {
    let a = d4().reroll(2.0)?;
    assert_eq!(expr(&a)?, "d4 reroll d2");
    let p = pmf_of(&a);
    assert_close(p.mean(), 3.0, 5);
    assert_close(p.min(), 1.0, 5);
    assert_close(p.max(), 4.0, 5);
    Ok(())
}

/// roll.test.ts:133 (the `toString()` equality is not asserted; no Rust `toString`)
#[test]
fn should_work_with_crazy_chain() -> T {
    let greatsword = r(2.0)?.d(6.0)?.plus(5.0)?.reroll(2.0)?;
    let smite = r(3.0)?.d(8.0)?;
    let paladin = greatsword.add(&smite)?;
    let crazy = r(2.0)?
        .d(6.0)?
        .plus(5.0)?
        .reroll(2.0)?
        .add_roll(3.0)?
        .d8()?;
    assert_eq!(expr(&crazy)?, expr(&paladin)?);
    let (a, b) = (pmf_of(&crazy), pmf_of(&paladin));
    assert_eq!(a.support(), b.support());
    for x in a.support() {
        assert_close(a.p_at(x.0), b.p_at(x.0), 12);
    }
    assert_eq!(a.mean(), b.mean());
    assert_eq!(expr(&crazy)?, "2(d6 reroll d2) + 3d8 + 5");
    Ok(())
}

/// roll.test.ts:156
#[test]
fn can_create_with_shorthand_roll() -> T {
    assert_eq!(expr(&roll_dice(3.0, 6.0, Some(2.0))?)?, "3d6 + 2");
    Ok(())
}

/// roll.test.ts:161
#[test]
fn should_throw_error_if_adding_a_die_after_adding_a_die() {
    assert_throws(d8().d(8.0), "Cannot add a die after adding a die");
}

/// roll.test.ts:168
#[test]
fn should_handle_negative_bonus_dice() -> T {
    assert_eq!(expr(&d8().add_roll(-1.0)?.d(6.0)?)?, "1d8 - 1d6");
    Ok(())
}

/// roll.test.ts:173
#[test]
fn should_handle_negative_base_dice() -> T {
    assert_eq!(expr(&r(-1.0)?.d(8.0)?)?, "0 - 1d8");
    Ok(())
}

/// roll.test.ts:186
#[test]
fn should_handle_joining_rolls_with_negative_modifiers() -> T {
    let other = RollBuilder::from_config(&RollConfigPatch {
        count: Some(2.0),
        sides: Some(6.0),
        modifier: Some(-3.0),
        ..Default::default()
    });
    let b = RollBuilder::new(3.0)?.d10()?.plus(10.0)?.add(&other)?;
    assert_eq!(expr(&b)?, "3d10 + 2d6 + 7");
    Ok(())
}

/// roll.test.ts:195
#[test]
fn should_handle_d6_and_flat_modifiers_as_a_roll_part() -> T {
    assert_eq!(expr(&d6().plus(5.0)?)?, "1d6 + 5");
    Ok(())
}

/// roll.test.ts:201
#[test]
fn should_handle_two_basic_rolls_joined_together() -> T {
    assert_eq!(expr(&d6().add_roll(1.0)?.plus(5.0)?)?, "1d6 + 5");
    Ok(())
}

/// roll.test.ts:207
#[test]
fn should_handle_flat_modifiers_as_a_roll_part() -> T {
    assert_eq!(expr(&flat(5.0)?)?, "5");
    Ok(())
}

/// roll.test.ts:212
#[test]
fn should_handle_flat_modifiers_correctly() -> T {
    let p = pmf_of(&r(0.0)?.plus(5.0)?);
    assert_eq!(p.mean(), 5.0);
    assert_eq!(p.min(), 5.0);
    assert_eq!(p.max(), 5.0);
    Ok(())
}

/// roll.test.ts:221
#[test]
fn should_handle_multiple_rolls_joined_together() -> T {
    let b = RollBuilder::new(2.0)?
        .d6()?
        .add_roll(1.0)?
        .d8()?
        .plus(5.0)?
        .add_roll(4.0)?
        .d4()?
        .reroll(1.0)?;
    assert_eq!(expr(&b)?, "4(d4 reroll 1) + 1d8 + 2d6 + 5");
    Ok(())
}

/// roll.test.ts:233
#[test]
fn should_handle_flat_modifiers_as_a_roll_part_when_adding() -> T {
    let b = RollBuilder::new(1.0)?.d6()?.add_roll(0.0)?.plus(5.0)?;
    assert_eq!(expr(&b)?, "1d6 + 5");
    Ok(())
}

/// roll.test.ts:239
#[test]
fn should_handle_multiple_rolls_with_plus() -> T {
    let b = r(2.0)?
        .d6()?
        .plus_roll(&r(1.0)?.d8()?)?
        .plus(5.0)?
        .plus_roll(&r(4.0)?.d4()?.reroll(1.0)?)?;
    assert_eq!(expr(&b)?, "4(d4 reroll 1) + 1d8 + 2d6 + 5");
    Ok(())
}

/// roll.test.ts:251
#[test]
fn should_handle_multiple_rolls_with_plus_but_tighter() -> T {
    let b = r(2.0)?
        .d6()?
        .plus_roll(&d8())?
        .plus(5.0)?
        .plus_roll(&r(4.0)?.d4()?.reroll(1.0)?)?;
    assert_eq!(expr(&b)?, "4(d4 reroll 1) + 1d8 + 2d6 + 5");
    Ok(())
}

/// roll.test.ts:264
#[test]
fn should_handle_multiple_rolls_with_plus_but_even_tighter() -> T {
    let b = r(2.0)?
        .d6()?
        .plus_roll(&d8())?
        .plus_roll(&roll_dice(4.0, 4.0, None)?.reroll(1.0)?)?
        .plus(5.0)?;
    assert_eq!(expr(&b)?, "4(d4 reroll 1) + 1d8 + 2d6 + 5");
    Ok(())
}

/// roll.test.ts:274
#[test]
fn should_handle_multiple_rolls_with_plus_but_tightest() -> T {
    let b = roll_dice(2.0, 6.0, None)?
        .plus_roll(&d8())?
        .plus_roll(&roll_dice(4.0, 4.0, None)?.reroll(1.0)?)?
        .plus(5.0)?;
    assert_eq!(expr(&b)?, "4(d4 reroll 1) + 1d8 + 2d6 + 5");
    Ok(())
}

/// roll.test.ts:299
#[test]
fn should_handle_best_of_method() -> T {
    let b = r(4.0)?.d6()?.best_of(2.0)?;
    assert_eq!(expr(&b)?, "4kh2(1d6)");
    let m = pmf_of(&b).mean();
    assert_close(m, 9.344135802469136, 5);
    assert_close(parse_with(&expr(&b)?, 0.0)?.mean(), m, 5);
    Ok(())
}

/// roll.test.ts:312
#[test]
fn should_handle_best_of_1_as_max_of_individual_dice_not_max_of_pool_sums() -> T {
    let b = r(4.0)?.d6()?.best_of(1.0)?;
    assert_eq!(expr(&b)?, "4kh1(1d6)");
    assert_close(pmf_of(&b).mean(), 5.244598765432099, 10);
    assert_close(parse_with(&expr(&b)?, 0.0)?.mean(), 5.244598765432099, 10);
    Ok(())
}

/// roll.test.ts:328
#[test]
fn should_handle_keep_highest_method() -> T {
    let b = r(5.0)?.d6()?.keep_highest(5.0, 3.0)?;
    assert_eq!(expr(&b)?, "5kh3(1d6)");
    assert_close(pmf_of(&b).mean(), 13.43017, 5);
    Ok(())
}

/// roll.test.ts:335
#[test]
fn should_handle_keep_lowest_method() -> T {
    let b = r(4.0)?.d8()?.keep_lowest(4.0, 2.0)?;
    assert_eq!(expr(&b)?, "4kl2(1d8)");
    assert_close(pmf_of(&b).mean(), 5.841796875, 5);
    Ok(())
}

/// roll.test.ts:342
#[test]
fn should_handle_copy_method() -> T {
    let original = r(3.0)?.d6()?.plus(4.0)?.reroll(1.0)?;
    copy_matches(&original)?;
    let modified = original.copy()?.plus(2.0)?;
    assert_eq!(expr(&modified)?, "3(d6 reroll 1) + 6");
    assert_eq!(expr(&original)?, "3(d6 reroll 1) + 4");
    Ok(())
}

/// roll.test.ts:359
#[test]
fn should_handle_complex_keep_highest_scenario() -> T {
    let b = r(6.0)?.d8()?.plus(2.0)?.keep_highest(6.0, 4.0)?;
    assert_eq!(expr(&b)?, "6kh4(1d8) + 2");
    assert_close(pmf_of(&b).mean(), 24.5086, 1);
    Ok(())
}

/// roll.test.ts:366
#[test]
fn should_refuse_a_per_die_keep_lowest_4_2_on_8d10_which_has_more_than_one_reading() -> T {
    let e = error_of(r(8.0)?.d10()?.plus(3.0)?.keep_lowest(4.0, 2.0));
    assert!(
        matches!(e, crate::error::DiceError::AmbiguousKeep(_)),
        "{e}"
    );
    Ok(())
}

/// roll.test.ts:370
#[test]
fn should_handle_copy_with_multiple_dice_configurations() -> T {
    copy_matches(
        &r(2.0)?
            .d6()?
            .add_roll(3.0)?
            .d8()?
            .plus(5.0)?
            .add_roll(1.0)?
            .d4()?,
    )
}

/// roll.test.ts:382
#[test]
fn should_handle_copy_with_advantage() -> T {
    copy_matches(&d20().with_advantage()?.plus(5.0)?)
}

/// roll.test.ts:394
#[test]
fn should_handle_copy_with_elven_accuracy() -> T {
    copy_matches(&d20().with_elven_accuracy()?.plus(3.0)?)
}

/// roll.test.ts:406
#[test]
fn should_handle_copy_with_minimum_values() -> T {
    copy_matches(&r(3.0)?.d6()?.minimum(2.0)?.plus(4.0)?)
}

/// roll.test.ts:418
#[test]
fn should_handle_copy_with_rerolls() -> T {
    copy_matches(&r(4.0)?.d8()?.reroll(2.0)?.plus(3.0)?)
}

/// roll.test.ts:430
#[test]
fn should_handle_best_of_with_modifiers() -> T {
    let b = r(5.0)?.d10()?.best_of(3.0)?.plus(4.0)?;
    assert_eq!(expr(&b)?, "5kh3(1d10) + 4");
    assert_close(pmf_of(&b).mean(), 25.45825, 5);
    assert_close(parse_with(&expr(&b)?, 0.0)?.mean(), 25.45825, 5);
    Ok(())
}

/// roll.test.ts:440
#[test]
fn should_handle_keep_highest_with_advantage() -> T {
    let b = d20().with_advantage()?.keep_highest(2.0, 1.0)?;
    assert_eq!(expr(&b)?, "d20 > d20");
    assert_close(pmf_of(&b).mean(), 13.8, 1);
    Ok(())
}

/// roll.test.ts:448
#[test]
fn should_handle_keep_lowest_with_disadvantage() -> T {
    let b = d20().with_disadvantage()?.keep_lowest(2.0, 1.0)?;
    assert_eq!(expr(&b)?, "d20 < d20");
    assert_close(pmf_of(&b).mean(), 7.2, 1);
    Ok(())
}

/// roll.test.ts:456
#[test]
fn should_refuse_a_per_die_keep_highest_4_3_on_3d8_which_has_more_than_one_reading() -> T {
    let e = error_of(
        r(3.0)?
            .d8()?
            .keep_highest(4.0, 3.0)
            .and_then(|b| b.plus(3.0)),
    );
    assert!(
        matches!(e, crate::error::DiceError::AmbiguousKeep(_)),
        "{e}"
    );
    Ok(())
}

/// roll.test.ts:463
#[test]
fn should_handle_invalid_dice_sides() {
    assert!(d(0.0).is_ok());
    assert_throws(d(-1.0), "sides must not be negative, got -1");
}

/// roll.test.ts:473
#[test]
fn should_handle_invalid_dice_count() -> T {
    r(-1.0)?.d6()?;
    r(0.0)?.d6()?;
    Ok(())
}

/// roll.test.ts:483
#[test]
fn should_handle_invalid_reroll_values() -> T {
    let b = d6();
    b.reroll(-1.0)?;
    b.reroll(7.0)?;
    Ok(())
}

/// roll.test.ts:494
#[test]
fn should_handle_invalid_minimum_values() -> T {
    let b = d6();
    b.minimum(0.0)?;
    b.minimum(7.0)?;
    Ok(())
}

/// roll.test.ts:505
#[test]
fn should_handle_invalid_explode_values() -> T {
    let b = d6();
    err_of(b.explode(-1.0));
    b.explode(0.0)?;
    Ok(())
}

/// roll.test.ts:516
#[test]
fn should_handle_invalid_keep_dice_values() -> T {
    let b = r(3.0)?.d6()?;
    let e = error_of(b.keep_highest(2.0, 5.0));
    assert!(
        matches!(e, crate::error::DiceError::AmbiguousKeep(_)),
        "{e}"
    );
    b.keep_highest(3.0, 0.0)?;
    b.keep_highest(3.0, -1.0)?;
    Ok(())
}

/// roll.test.ts:531
#[test]
fn should_handle_invalid_best_of_values() -> T {
    let b = r(3.0)?.d6()?;
    err_of(b.best_of(0.0));
    b.best_of(5.0)?;
    err_of(b.best_of(-1.0));
    Ok(())
}

/// roll.test.ts:550, 558, 566, 574, 582
#[test]
fn should_have_correct_mean_for_basic_dice() -> T {
    let one = RollBuilder::new(1.0)?;
    check_stats(&one.d6()?, 3.5, 5, 1.0, 6.0);
    check_stats(&RollBuilder::new(2.0)?.d6()?, 7.0, 5, 2.0, 12.0);
    check_stats(&RollBuilder::new(3.0)?.d6()?, 10.5, 5, 3.0, 18.0);
    check_stats(&one.d20()?, 10.5, 5, 1.0, 20.0);
    check_stats(&one.d100()?, 50.5, 5, 1.0, 100.0);
    Ok(())
}

/// roll.test.ts:591
#[test]
fn rolls_zero_dice_for_a_count_of_0_matching_the_parser() -> T {
    let z = roll_dice(0.0, 6.0, None)?;
    assert_eq!(expr(&z)?, "0");
    assert_eq!(faces(&pmf_of(&z)), vec![(0.0, 1.0)]);
    assert_eq!(faces(&pmf_of(&z)), faces(&pmf_of(&d_expression("0d6")?)));
    let z3 = roll_dice(0.0, 6.0, Some(3.0))?;
    assert_eq!(faces(&pmf_of(&z3)), vec![(3.0, 1.0)]);
    assert_eq!(
        faces(&pmf_of(&z3)),
        faces(&pmf_of(&d_expression("0d6 ~+ 3")?))
    );
    let zd = roll_with(0.0, Some(SidesOrDie::Die(d6())), None)?;
    assert_eq!(faces(&pmf_of(&zd)), vec![(0.0, 1.0)]);
    Ok(())
}

/// roll.test.ts:605, 613, 621
#[test]
fn should_have_correct_mean_for_modifier_rolls() -> T {
    check_stats(&RollBuilder::new(1.0)?.d6()?.plus(3.0)?, 6.5, 5, 4.0, 9.0);
    check_stats(&RollBuilder::new(2.0)?.d6()?.plus(-2.0)?, 5.0, 5, 0.0, 10.0);
    check_stats(
        &RollBuilder::new(3.0)?.d6()?.plus(10.0)?,
        20.5,
        5,
        13.0,
        28.0,
    );
    Ok(())
}

/// roll.test.ts:631
#[test]
fn should_have_correct_mean_for_d20_with_advantage() -> T {
    check_stats(
        &RollBuilder::new(1.0)?.d20()?.with_advantage()?,
        13.825,
        2,
        1.0,
        20.0,
    );
    Ok(())
}

/// roll.test.ts:640
#[test]
fn should_have_correct_mean_for_d20_with_disadvantage() -> T {
    check_stats(
        &RollBuilder::new(1.0)?.d20()?.with_disadvantage()?,
        7.175,
        2,
        1.0,
        20.0,
    );
    Ok(())
}
