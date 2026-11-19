//! `tests/crit-keep.test.ts`: 24 tests, 6 compat calls.
//!
//! The throw in the two "refuses to crit the keep" rider tests is read through `Turn::pmf()` (no
//! compat call is recorded for a read that throws).

use super::crit_doubling::*;
use super::helpers::*;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;

const FILE: &str = "tests/crit-keep.test.ts";

// Exact means (Python Fractions over the full enumeration).
const MAX_OF_TWO_2D6: f64 = 5425.0 / 648.0; // 8.3719
const MAX_OF_TWO_2D6_PLUS_3: f64 = 7369.0 / 648.0; // 11.3719
const MAX_OF_TWO_4D6_PLUS_3: f64 = 7950193.0 / 419904.0; // 18.9334
const MAX_OF_THREE_6D6: f64 = 2968620697.0 / 120932352.0; // 24.5478
const MAX_OF_TWO_2D12_PLUS_5: f64 = 107755.0 / 5184.0; // 20.7861
const MAX_OF_FOUR_2D6: f64 = 7972693.0 / 839808.0; // 9.4935
const FOUR_D6_DROP_LOWEST: f64 = 15869.0 / 1296.0; // 12.2446

fn keep_4_3() -> R<RollBuilder> {
    rs(4.0, 6.0)?.keep_highest(4.0, 3.0)
}

fn drop_lowest_attack() -> R<crate::builder::attack::AttackBuilder> {
    d20().plus(5.0)?.ac(12.0)?.on_hit(keep_4_3()?)
}

// ---- keep-highest-of-1 doubles inside each trial, unchanged ------------------------------

const KH1: &str = "keep-highest-of-1 doubles inside each trial, unchanged";

#[test]
fn roll_1_d6_keep_highest_2_1_doubles_to_2kh1_2d6() -> T {
    let doubled = rs(1.0, 6.0)?.keep_highest(2.0, 1.0)?.double_dice()?;
    assert_eq!(doubled.to_expression()?, "2kh1(2d6)");
    same_pmf(&doubled.to_pmf(0.0)?, &parse_str("2kh1(2d6)")?.to_pmf(0.0)?);
    close(doubled.to_pmf(0.0)?.mean(), MAX_OF_TWO_2D6, 12);
    Ok(())
}

#[test]
fn roll_2_d6_keep_highest_2_1_plus_3_doubles_to_o4_crit() -> T {
    let doubled = rs(2.0, 6.0)?
        .keep_highest(2.0, 1.0)?
        .plus(3.0)?
        .double_dice()?;
    assert_eq!(doubled.to_expression()?, "2kh1(4d6) + 3");
    same_pmf(
        &doubled.to_pmf(0.0)?,
        &rs(4.0, 6.0)?
            .plus(3.0)?
            .keep_highest_all(2.0, 1.0)?
            .to_pmf(0.0)?,
    );
    same_pmf(
        &doubled.to_pmf(0.0)?,
        &parse_str("2kh1(4d6) + 3")?.to_pmf(0.0)?,
    );
    close(doubled.to_pmf(0.0)?.mean(), MAX_OF_TWO_4D6_PLUS_3, 12);

    let res = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?.keep_highest(2.0, 1.0)?.plus(3.0)?)?
        .resolve(0.0)?;
    close(res.hit.mean(), MAX_OF_TWO_2D6_PLUS_3, 12);
    close(res.crit.mean(), MAX_OF_TWO_4D6_PLUS_3, 12);
    close(res.weights.crit, 0.05, 12);
    Ok(())
}

#[test]
fn a_die_count_equal_to_the_trial_count_stays_trials_of_sums() -> T {
    let doubled = rs(3.0, 6.0)?.keep_highest(3.0, 1.0)?.double_dice()?;
    assert_eq!(doubled.to_expression()?, "3kh1(6d6)");
    close(doubled.to_pmf(0.0)?.mean(), MAX_OF_THREE_6D6, 12);
    Ok(())
}

#[test]
fn an_attack_auto_crits_roll_1_d12_keep_highest_2_1_plus_5() -> T {
    let attack = d20()
        .plus(11.0)?
        .ac(15.0)?
        .on_hit(rs(1.0, 12.0)?.keep_highest(2.0, 1.0)?.plus(5.0)?)?;
    assert_eq!(
        attack.to_expression()?,
        "(d20 + 11 AC 15) * (2kh1(1d12) + 5) crit (2kh1(2d12) + 5)"
    );
    close(attack.resolve(0.0)?.crit.mean(), MAX_OF_TWO_2D12_PLUS_5, 12);
    Ok(())
}

#[test]
fn keep_highest_all_2_1_still_doubles_inside_then_pools() -> T {
    let doubled = rs(2.0, 6.0)?
        .plus(3.0)?
        .keep_highest_all(2.0, 1.0)?
        .double_dice()?;
    assert_eq!(doubled.to_expression()?, "2kh1(4d6 + 3)");
    close(doubled.to_pmf(0.0)?.mean(), MAX_OF_TWO_4D6_PLUS_3, 12);
    Ok(())
}

#[test]
fn parsed_nkhk_with_k_1_doubles_inside() -> T {
    let doubled = |expression: &str| parse_str(expression)?.double_dice();
    let expr = |expression: &str| -> R<String> { doubled(expression)?.to_expression() };
    let mean = |expression: &str| -> R<f64> { Ok(doubled(expression)?.to_pmf(0.0)?.mean()) };
    assert_eq!(expr("2kh1(1d6)")?, "2kh1(2d6)");
    close(mean("2kh1(1d6)")?, MAX_OF_TWO_2D6, 12);
    assert_eq!(expr("2kh1(2d6)+3")?, "2kh1(4d6)+3");
    close(mean("2kh1(2d6)+3")?, MAX_OF_TWO_4D6_PLUS_3, 12);
    assert_eq!(expr("4kh1d6")?, "4kh1(2d6)");
    close(mean("4kh1d6")?, MAX_OF_FOUR_2D6, 12);
    // A string max of two dice terms is the same keep-highest-of-1: each side doubles.
    assert_eq!(expr("d6 > d6")?, "2d6 > 2d6");
    close(mean("d6 > d6")?, MAX_OF_TWO_2D6, 12);
    Ok(())
}

#[test]
fn a_keep_highest_of_1_rider_crits_at_the_doubled_keep() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{KH1} > a keep-highest-of-1 rider crits at the doubled keep: any-crit adds P(any crit) × O4-crit"
        ),
    );
    let rider = two_daggers()?.rider(rider_of(
        trig("any-crit"),
        rs(2.0, 6.0)?.keep_highest(2.0, 1.0)?.plus(3.0)?,
    ))?;
    let a = want.mean(&rider);
    let b = want.mean(&two_daggers()?);
    close(a - b, P_ANY_CRIT * MAX_OF_TWO_4D6_PLUS_3, 10);
    want.done();
    Ok(())
}

#[test]
fn a_best_of_that_stays_a_plain_sum_after_doubling_doubles_as_plain_dice() -> T {
    // bestOf(2) on 1d6 is not below the count before or after (2d6), so it is plain dice both times.
    close(
        rs(1.0, 6.0)?
            .best_of(2.0)?
            .double_dice()?
            .to_pmf(0.0)?
            .mean(),
        7.0,
        12,
    );
    Ok(())
}

#[test]
fn an_advantage_attack_check_is_never_doubled() -> T {
    let res = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .resolve(0.0)?;
    close(res.weights.crit, 0.0975, 12);
    close(res.crit.mean(), 14.0, 12);
    Ok(())
}

// ---- an ambiguous per-die keep refuses to double: an explicit crit is required ----------

const AMBIGUOUS: &str = "an ambiguous per-die keep refuses to double: an explicit crit is required";

type Case = (&'static str, fn() -> R<RollBuilder>, &'static str);

fn cases() -> Vec<Case> {
    vec![
        (
            "roll(4,d6).keepHighest(4,3)",
            || rs(4.0, 6.0)?.keep_highest(4.0, 3.0),
            "4kh3(1d6)",
        ),
        (
            "roll(1,d6).keepHighest(4,3)",
            || rs(1.0, 6.0)?.keep_highest(4.0, 3.0),
            "4kh3(1d6)",
        ),
        (
            "roll(1,d6).keepLowest(2,1)",
            || rs(1.0, 6.0)?.keep_lowest(2.0, 1.0),
            "2kl1(1d6)",
        ),
        (
            "roll(4,d6).bestOf(3)",
            || rs(4.0, 6.0)?.best_of(3.0),
            "bestOf(3)",
        ),
        (
            "roll(2,d6).bestOf(1)",
            || rs(2.0, 6.0)?.best_of(1.0),
            "bestOf(1)",
        ),
        (
            "roll(2,d6).bestOf(3), plain until doubled",
            || rs(2.0, 6.0)?.best_of(3.0),
            "bestOf(3)",
        ),
        ("d6.withAdvantage()", || d6().with_advantage(), "advantage"),
        (
            "roll(2,d8).withDisadvantage()",
            || rs(2.0, 8.0)?.with_disadvantage(),
            "disadvantage",
        ),
        (
            "d6.withElvenAccuracy()",
            || d6().with_elven_accuracy(),
            "elven accuracy",
        ),
    ]
}

#[test]
fn double_dice_and_scale_dice_3_throw_naming_the_shape_and_suggesting_on_crit() -> T {
    for (_name, build, shape) in cases() {
        throws(build().and_then(|b| b.double_dice()), shape);
        throws(build().and_then(|b| b.double_dice()), "onCrit(");
        throws(build().and_then(|b| b.scale_dice(3.0)), shape);
    }
    Ok(())
}

#[test]
fn the_throw_reaches_through_a_flat_a_half_a_scale_a_sum_and_a_pool() -> T {
    let keep = keep_4_3;
    throws(keep()?.plus(3.0)?.double_dice(), "4kh3");
    throws(rs(1.0, 8.0)?.plus_roll(&keep()?)?.double_dice(), "4kh3");
    throws(keep()?.half()?.double_dice(), "4kh3");
    throws(
        keep()?
            .scale_result(2.0, 1.0, Rounding::Floor)?
            .double_dice(),
        "4kh3",
    );
    throws(keep()?.keep_highest_all(2.0, 1.0)?.double_dice(), "4kh3");
    Ok(())
}

#[test]
fn an_auto_critting_attack_throws_at_build_never_88_98() -> T {
    throws(drop_lowest_attack()?.resolve(0.0), "4kh3(1d6)");
    throws(drop_lowest_attack()?.to_expression(), "4kh3(1d6)");
    throws(
        d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit(d6().with_advantage()?)?
            .resolve(0.0),
        "advantage",
    );
    Ok(())
}

#[test]
fn an_explicit_on_crit_resolves_with_that_crit_no_crit_resolves_with_none() -> T {
    let explicit_crit = keep_4_3()?.plus_roll(&keep_4_3()?)?;
    let attack = drop_lowest_attack()?.on_crit(&[Arg::Roll(explicit_crit.clone())])?;
    let res = attack.resolve(0.0)?;
    same_pmf(&res.crit, &explicit_crit.to_pmf(0.0)?);
    close(res.crit.mean(), 2.0 * FOUR_D6_DROP_LOWEST, 12);
    close(res.hit.mean(), FOUR_D6_DROP_LOWEST, 12);
    assert!(attack.to_expression().is_ok());

    let none = drop_lowest_attack()?.no_crit()?.resolve(0.0)?;
    assert_eq!(none.weights.crit, 0.0);
    close(none.weights.hit, 0.7, 12);
    close(none.hit.mean(), FOUR_D6_DROP_LOWEST, 12);
    Ok(())
}

fn pe_message<X>(result: Result<X, DiceError>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => pe(e),
    }
}

#[test]
fn a_rider_refuses_to_crit_the_keep_but_takes_an_explicit_crit_damage() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{AMBIGUOUS} > a rider refuses to crit the keep, but takes an explicit critDamage"
        ),
    );
    let refused = two_daggers()?
        .rider(rider_of(trig("any-crit"), keep_4_3()?))
        .and_then(|t| t.pmf());
    assert!(pe_message(refused).contains("4kh3(1d6)"));
    let explicit = two_daggers()?.rider(with_crit(
        rs(8.0, 6.0)?,
        rider_of(trig("any-crit"), keep_4_3()?),
    ))?;
    let a = want.mean(&explicit);
    let b = want.mean(&two_daggers()?);
    close(a - b, P_ANY_CRIT * 28.0, 10);
    want.done();
    Ok(())
}

// ---- a parsed keep other than NkhK with K = 1 refuses to double -------------------------

const PARSED: &str = "a parsed keep other than NkhK with K = 1 refuses to double";

#[test]
fn parsed_double_dice_throws_naming_the_keep_and_suggesting_an_explicit_crit() -> T {
    for (expression, shape) in [
        ("4kh3(1d6)", "4kh3"),
        ("4kh3d6", "4kh3"),
        ("3kh2(2d6 + 1)", "3kh2"),
        ("kh2d6", "kh2"),
        ("3kl1(1d6)", "3kl1"),
        ("2kl1(1d6) + 3", "2kl1"),
        ("1d8 + 4kh3d6", "4kh3"),
        ("2kh1(4kh3(1d6))", "4kh3"),
        ("d6 < d6", "d6 < d6"),
    ] {
        throws(parse_str(expression).and_then(|b| b.double_dice()), shape);
        throws(
            parse_str(expression).and_then(|b| b.double_dice()),
            "onCrit(",
        );
    }
    Ok(())
}

#[test]
fn a_string_cap_or_floor_with_one_dice_side_still_doubles() -> T {
    assert_eq!(
        parse_str("2d6 < 9")?.double_dice()?.to_expression()?,
        "4d6 < 9"
    );
    assert_eq!(
        parse_str("3>d6")?.double_dice()?.to_expression()?,
        "2(3>d6)"
    );
    Ok(())
}

#[test]
fn on_hit_4kh3_throws_at_build_an_explicit_on_crit_resolves() -> T {
    let hit = || {
        d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit_args(&[Arg::Str("4kh3(1d6)".into())])
    };
    throws(hit().and_then(|a| a.resolve(0.0)), "4kh3");
    let res = hit()?
        .on_crit(&[Arg::Str("4kh3(1d6) + 4kh3(1d6)".into())])?
        .resolve(0.0)?;
    close(res.crit.mean(), 2.0 * FOUR_D6_DROP_LOWEST, 12);
    Ok(())
}

#[test]
fn an_attack_string_with_no_crit_clause_throws_a_crit_clause_resolves() -> T {
    throws(parse_str("(d20 + 5 AC 12) * (4kh3(1d6))"), "4kh3");
    let explicit =
        parse_str("(d20 + 5 AC 12) * (4kh3(1d6)) crit (4kh3(1d6) + 4kh3(1d6))")?.to_pmf(0.0)?;
    close(explicit.outcome_probability("crit"), 0.05, 12);
    same_pmf(
        &explicit.filter_outcome("crit"),
        &parse_str("4kh3(1d6) + 4kh3(1d6)")?
            .to_pmf(0.0)?
            .scale_mass(0.05),
    );
    Ok(())
}

#[test]
fn a_parsed_keep_rider_is_still_damage_but_takes_an_explicit_crit_damage() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{PARSED} > a parsed keep rider is still damage: it refuses to crit, but takes an explicit critDamage"
        ),
    );
    let refused = two_daggers()?
        .rider(rider_of(trig("any-crit"), parse_str("4kh3(1d6)")?))
        .and_then(|t| t.pmf());
    assert!(pe_message(refused).contains("4kh3"));
    let explicit = two_daggers()?.rider(with_crit(
        parse_str("8d6")?,
        rider_of(trig("any-crit"), parse_str("4kh3(1d6)")?),
    ))?;
    let a = want.mean(&explicit);
    let b = want.mean(&two_daggers()?);
    close(a - b, P_ANY_CRIT * 28.0, 10);
    want.done();
    Ok(())
}

// ---- noCrit() rescues an ambiguous keep in a plusSeparateDamage channel -----------------

#[test]
fn no_crit_with_an_ambiguous_plus_separate_damage_channel_resolves() -> T {
    let attack = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .no_crit()?
        .plus_separate_damage(keep_4_3()?);
    let res = attack.resolve(0.0)?;
    assert_eq!(res.weights.crit, 0.0);
    close(res.crit_separate.mass(), 1.0, 12);
    close(res.crit_separate.p_at(0.0), 1.0, 12);
    same_pmf(&res.crit, &res.crit_base);
    Ok(())
}

#[test]
fn a_crittable_attack_with_the_same_ambiguous_channel_still_throws() -> T {
    let attack = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .plus_separate_damage(keep_4_3()?);
    throws(attack.resolve(0.0), "4kh3");
    Ok(())
}

#[test]
fn an_attack_that_can_crit_stays_bin_for_bin_unchanged_with_a_plain_channel() -> T {
    let attack = d20()
        .plus(9.0)?
        .ac(16.0)?
        .on_hit(rs(2.0, 6.0)?.plus(5.0)?)?
        .plus_separate_damage(rs(2.0, 6.0)?);
    let res = attack.resolve(0.0)?;
    same_pmf(
        &res.hit,
        &res.hit_base.convolve(&res.hit_separate, None, false),
    );
    same_pmf(
        &res.crit,
        &res.crit_base.convolve(&res.crit_separate, None, false),
    );
    close(res.crit_separate.mean(), 14.0, 10);
    Ok(())
}

// ---- diceMatchInfo() on an auto-crit whose crit cannot double ---------------------------

#[test]
fn a_keep_pool_has_no_descriptor_on_either_branch_instead_of_throwing() -> T {
    let attack = d20()
        .plus(5.0)?
        .ac(17.0)?
        .on_hit(rs(4.0, 8.0)?.keep_highest(4.0, 3.0)?)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert!(hit.is_none() && crit.is_none());
    throws(attack.resolve(0.0), "4kh3");
    Ok(())
}

#[test]
fn a_pool_rolled_with_disadvantage_has_no_descriptor_on_either_branch() -> T {
    let attack = d20()
        .plus(5.0)?
        .ac(17.0)?
        .on_hit(rs(2.0, 8.0)?.with_disadvantage()?)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert!(hit.is_none() && crit.is_none());
    let (hit, _) = attack
        .on_crit(&[Arg::Roll(rs(4.0, 8.0)?)])?
        .dice_match_info(0.0)?;
    assert!(hit.is_none());
    Ok(())
}
