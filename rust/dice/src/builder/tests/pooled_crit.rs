//! Translated TS tests (see tests/mod.rs).

use crate::Pmf;
use crate::builder::factory::{SidesOrDie, roll_with};
use crate::builder::roll::RollBuilder;
use crate::error::DiceError;

/// `roll(count, die)`.
fn rd(count: f64, die: &RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die.clone())), None)
}

/// Every bin of `a` and `b` agrees within 1e-12.
#[track_caller]
fn same_pmf(a: &Pmf, b: &Pmf) {
    let mut support: Vec<f64> = a.support().iter().map(|d| d.0).collect();
    support.extend(b.support().iter().map(|d| d.0));
    for v in support {
        assert!((a.p_at(v) - b.p_at(v)).abs() <= 1e-12, "bin {v}");
    }
}

mod pooled_roll {
    use crate::builder::factory::*;
    use crate::builder::tests::support::*;
    use crate::error::DiceError;

    fn s(r: &crate::builder::roll::RollBuilder) -> Result<String, DiceError> {
        r.to_expression()
    }

    /// tests/pooled-roll.test.ts:7
    #[test]
    fn should_create_a_pooled_roll_builder() -> T {
        let pool = d6().plus_roll(&d8())?.keep_highest_all(4.0, 3.0)?;
        assert!(pool.is_pooled());
        Ok(())
    }

    /// tests/pooled-roll.test.ts:12
    #[test]
    fn should_produce_correct_expression_string_and_pmf() -> T {
        let pool = d6().plus_roll(&d8())?.keep_highest_all(4.0, 3.0)?;
        assert_eq!(s(&pool)?, "4kh3(1d8 + 1d6)");
        let pmf = pmf_of(&pool);
        assert_close(pmf.mean(), 26.96, 2);
        assert_eq!(pmf.min(), 6.0);
        assert_eq!(pmf.max(), 42.0);
        Ok(())
    }

    /// tests/pooled-roll.test.ts:23
    #[test]
    fn should_not_equal_the_same_as_individual_keep_highest_rolls() -> T {
        let pool = d6().plus_roll(&d8())?.keep_highest_all(4.0, 3.0)?;
        assert_eq!(s(&pool)?, "4kh3(1d8 + 1d6)");
        let combined = d8()
            .keep_highest(4.0, 3.0)?
            .plus_roll(&d6().keep_highest(4.0, 3.0)?)?;
        let pool_pmf = pmf_of(&pool);
        let combined_pmf = pmf_of(&combined);
        assert_close(pool_pmf.mean(), 26.96, 2);
        assert_close(combined_pmf.mean(), 28.103, 2);
        assert_eq!(combined_pmf.min(), pool_pmf.min());
        assert_eq!(combined_pmf.max(), pool_pmf.max());
        Ok(())
    }

    /// tests/pooled-roll.test.ts:43
    #[test]
    fn should_handle_arithmetic_modifiers_on_the_pool() -> T {
        let pool = d6()
            .plus_roll(&d8())?
            .keep_highest_all(4.0, 3.0)?
            .plus(5.0)?;
        assert_eq!(s(&pool)?, "4kh3(1d8 + 1d6) + 5");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:48
    #[test]
    fn should_handle_arithmetic_modifiers_before_and_after() -> T {
        let pool = d6().plus(2.0)?.keep_highest_all(3.0, 2.0)?.plus(5.0)?;
        assert_eq!(s(&pool)?, "3kh2(1d6 + 2) + 5");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:53
    #[test]
    fn should_compute_correct_pmf_statistics_for_simple_case() -> T {
        let pmf = pmf_of(&d6().keep_highest_all(2.0, 1.0)?);
        assert_eq!(pmf.min(), 1.0);
        assert_eq!(pmf.max(), 6.0);
        assert_close(pmf.mean(), 4.47, 2);
        Ok(())
    }

    /// tests/pooled-roll.test.ts:64
    #[test]
    fn should_compute_correct_pmf_for_pooled_complex_expression() -> T {
        let pool = d6().plus_roll(&d8())?.keep_highest_all(2.0, 1.0)?;
        let pmf = pmf_of(&pool);
        let expected_mean = pmf_of(&d6().plus_roll(&d8())?).mean();
        assert!(pmf.mean() > expected_mean);
        assert_eq!(pmf.min(), 2.0);
        assert_eq!(pmf.max(), 14.0);
        Ok(())
    }

    /// tests/pooled-roll.test.ts:78
    #[test]
    fn should_correctly_handle_keep_count_equals_total_count() -> T {
        let pool = pmf_of(&d6().keep_highest_all(3.0, 3.0)?);
        let expected = pmf_of(&roll_with(3.0, None, None)?.d6()?);
        assert_close(pool.mean(), expected.mean(), 2);
        assert_eq!(pool.min(), expected.min());
        assert_eq!(pool.max(), expected.max());
        Ok(())
    }

    /// tests/pooled-roll.test.ts:89
    #[test]
    fn should_create_a_pooled_roll_builder_with_correct_expression() -> T {
        let pool = d6().plus_roll(&d8())?.keep_lowest_all(4.0, 3.0)?;
        assert_eq!(s(&pool)?, "4kl3(1d8 + 1d6)");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:94
    #[test]
    fn should_compute_correct_pmf_statistics() -> T {
        let pmf = pmf_of(&d6().keep_lowest_all(2.0, 1.0)?);
        assert_eq!(pmf.min(), 1.0);
        assert_eq!(pmf.max(), 6.0);
        assert_close(pmf.mean(), 2.53, 2);
        Ok(())
    }

    /// tests/pooled-roll.test.ts:107
    #[test]
    fn should_multiply_the_pool_by_an_integer_count() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?.times(3.0)?;
        assert_eq!(s(&pool)?, "3(2kh1(1d6))");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:112
    #[test]
    fn should_affect_the_pmf_correctly() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?.times(3.0)?;
        let single = pmf_of(&d6().keep_highest_all(2.0, 1.0)?);
        let pmf = pmf_of(&pool);
        assert_close(pmf.mean(), single.mean() * 3.0, 2);
        assert_eq!(pmf.min(), single.min() * 3.0);
        assert_eq!(pmf.max(), single.max() * 3.0);
        Ok(())
    }

    /// tests/pooled-roll.test.ts:123
    #[test]
    fn should_throw_for_non_integers_or_negative_numbers() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(pool.times(1.5), "times() requires an integer");
        assert_throws(pool.times(-1.0), "times() requires a non-negative integer");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:133
    #[test]
    fn should_throw_when_adding_dice_to_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(pool.d(6.0), "Cannot add dice to a pooled roll");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:138
    #[test]
    fn should_throw_when_setting_reroll_on_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(pool.reroll(1.0), "Cannot set reroll on a pooled roll");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:145
    #[test]
    fn should_throw_when_setting_explode_on_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(pool.explode(1.0), "Cannot set explode on a pooled roll");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:152
    #[test]
    fn should_throw_when_setting_minimum_on_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(pool.minimum(1.0), "Cannot set minimum on a pooled roll");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:159
    #[test]
    fn should_throw_when_setting_best_of_on_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(pool.best_of(1.0), "Cannot set bestOf on a pooled roll");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:166
    #[test]
    fn should_throw_when_setting_advantage_disadvantage_on_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(
            pool.with_advantage(),
            "Cannot set advantage on a pooled roll",
        );
        assert_throws(
            pool.with_disadvantage(),
            "Cannot set disadvantage on a pooled roll",
        );
        assert_throws(
            pool.with_elven_accuracy(),
            "Cannot set elven accuracy on a pooled roll",
        );
        Ok(())
    }

    /// tests/pooled-roll.test.ts:179
    #[test]
    fn should_throw_when_using_regular_keep_highest_lowest_on_a_pool() -> T {
        let pool = d6().keep_highest_all(2.0, 1.0)?;
        assert_throws(
            pool.keep_highest(2.0, 1.0),
            "Cannot use keepHighest on a pooled roll",
        );
        assert_throws(
            pool.keep_lowest(2.0, 1.0),
            "Cannot use keepLowest on a pooled roll",
        );
        Ok(())
    }

    /// tests/pooled-roll.test.ts:191
    #[test]
    fn should_allow_nested_pooling_via_keep_highest_all() -> T {
        let outer = d6()
            .keep_highest_all(4.0, 3.0)?
            .keep_highest_all(3.0, 2.0)?;
        assert!(outer.is_pooled());
        assert_eq!(s(&outer)?, "3kh2(4kh3(1d6))");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:218
    #[test]
    fn compares_2kh1_d6_d8_vs_2kh1_d6_plus_2kh1_d8() -> T {
        let pooled_mean = pmf_of(&d6().plus_roll(&d8())?.keep_highest_all(2.0, 1.0)?).mean();
        let separate = d6()
            .keep_highest(2.0, 1.0)?
            .plus_roll(&d8().keep_highest(2.0, 1.0)?)?;
        assert!(pooled_mean < pmf_of(&separate).mean());
        Ok(())
    }

    /// tests/pooled-roll.test.ts:244
    #[test]
    fn should_handle_pool_plus_roll_correctly() -> T {
        let pool = d6().plus_roll(&d8())?.keep_highest_all(4.0, 3.0)?;
        let combined = pool.plus_roll(&d6())?;
        assert!(combined.is_pooled());
        assert_eq!(s(&combined)?, "4kh3(1d8 + 1d6) + 1d6");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:253
    #[test]
    fn should_throw_an_error_for_d6_plus_pool_limitation() -> T {
        let pool = d6().keep_highest_all(4.0, 3.0)?;
        assert_throws(
            d6().plus_roll(&pool),
            "Cannot add a roll with hidden state (like a pooled roll) to a standard roll",
        );
        Ok(())
    }

    /// tests/pooled-roll.test.ts:260
    #[test]
    fn should_throw_when_using_roll_count_pool() -> T {
        let pool = d6().keep_highest_all(4.0, 3.0)?;
        assert_throws(
            roll_with(2.0, Some(SidesOrDie::Die(pool)), None),
            "Cannot use a roll with hidden state (like a pooled roll) as a die type.",
        );
        Ok(())
    }

    /// tests/pooled-roll.test.ts:273
    #[test]
    fn should_handle_double_dice_on_a_pool_the_dice_double_inside_then_pool_r33() -> T {
        let pool = d6().keep_highest_all(4.0, 3.0)?;
        let doubled = pool.double_dice()?;
        assert!(doubled.is_pooled());
        assert_eq!(s(&doubled)?, "4kh3(2d6)");
        let dm = pmf_of(&doubled).mean();
        let expected =
            pmf_of(&roll_with(2.0, Some(SidesOrDie::Die(d6())), None)?.keep_highest_all(4.0, 3.0)?)
                .mean();
        assert_close(dm, expected, 12);
        assert!(!close(dm, pmf_of(&pool).mean() * 2.0, 2));
        Ok(())
    }

    /// tests/pooled-roll.test.ts:284
    #[test]
    fn should_handle_subtraction() -> T {
        let pool = d6().keep_highest_all(4.0, 3.0)?;
        assert_eq!(s(&pool.minus(2.0)?)?, "4kh3(1d6) - 2");
        assert_eq!(s(&pool.minus_roll(&d4())?)?, "4kh3(1d6) - 1d4");
        Ok(())
    }

    /// tests/pooled-roll.test.ts:293
    #[test]
    fn should_handle_keep_count_greater_than_total_count() -> T {
        let pool = d6().keep_highest_all(3.0, 5.0)?;
        let expected = pmf_of(&roll_with(3.0, None, None)?.d6()?);
        assert_close(pmf_of(&pool).mean(), expected.mean(), 2);
        Ok(())
    }

    /// tests/pooled-roll.test.ts:301
    #[test]
    fn should_handle_keep_count_0() -> T {
        let pmf = pmf_of(&d6().keep_highest_all(3.0, 0.0)?);
        assert_eq!(pmf.mean(), 0.0);
        assert_eq!(pmf.max(), 0.0);
        Ok(())
    }
}

mod crit_keep {
    use super::{rd, same_pmf};
    use crate::builder::factory::*;
    use crate::builder::roll::RollBuilder;
    use crate::builder::tests::support::*;
    use crate::error::DiceError;

    const MAX_OF_TWO_2D6: f64 = 5425.0 / 648.0;
    const MAX_OF_TWO_4D6_PLUS_3: f64 = 7950193.0 / 419904.0;
    const MAX_OF_THREE_6D6: f64 = 2968620697.0 / 120932352.0;
    const MAX_OF_FOUR_2D6: f64 = 7972693.0 / 839808.0;

    fn dd(e: &str) -> Result<RollBuilder, DiceError> {
        d_expression(e)
    }

    /// tests/crit-keep.test.ts:36
    #[test]
    fn roll_1_d6_keep_highest_2_1_doubles_to_2kh1_2d6_the_parsed_strings_own_reading() -> T {
        let doubled = rd(1.0, &d6())?.keep_highest(2.0, 1.0)?.double_dice()?;
        assert_eq!(doubled.to_expression()?, "2kh1(2d6)");
        same_pmf(&pmf_of(&doubled), &pmf_of(&dd("2kh1(2d6)")?));
        assert_close(pmf_of(&doubled).mean(), MAX_OF_TWO_2D6, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:43 (translated: the builder-only part; the `.ac(12).onHit(..).resolve()` tail is deferred)
    #[test]
    fn roll_2_d6_keep_highest_2_1_plus_3_doubles_to_o4_crit_bin_for_bin_with_the_pooled_crit() -> T
    {
        let doubled = rd(2.0, &d6())?
            .keep_highest(2.0, 1.0)?
            .plus(3.0)?
            .double_dice()?;
        assert_eq!(doubled.to_expression()?, "2kh1(4d6) + 3");
        let pooled = rd(4.0, &d6())?.plus(3.0)?.keep_highest_all(2.0, 1.0)?;
        same_pmf(&pmf_of(&doubled), &pmf_of(&pooled));
        same_pmf(&pmf_of(&doubled), &pmf_of(&dd("2kh1(4d6) + 3")?));
        assert_close(pmf_of(&doubled).mean(), MAX_OF_TWO_4D6_PLUS_3, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:56
    #[test]
    fn a_die_count_equal_to_the_trial_count_stays_trials_of_sums_roll_3_d6_keep_highest_3_1() -> T {
        let doubled = rd(3.0, &d6())?.keep_highest(3.0, 1.0)?.double_dice()?;
        assert_eq!(doubled.to_expression()?, "3kh1(6d6)");
        assert_close(pmf_of(&doubled).mean(), MAX_OF_THREE_6D6, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:68
    #[test]
    fn keep_highest_all_2_1_still_doubles_inside_then_pools_o4_crit() -> T {
        let doubled = rd(2.0, &d6())?
            .plus(3.0)?
            .keep_highest_all(2.0, 1.0)?
            .double_dice()?;
        assert_eq!(doubled.to_expression()?, "2kh1(4d6 + 3)");
        assert_close(pmf_of(&doubled).mean(), MAX_OF_TWO_4D6_PLUS_3, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:74
    #[test]
    fn parsed_nkhk_with_k_1_doubles_inside() -> T {
        let cases = [
            ("2kh1(1d6)", "2kh1(2d6)", MAX_OF_TWO_2D6),
            ("2kh1(2d6)+3", "2kh1(4d6)+3", MAX_OF_TWO_4D6_PLUS_3),
            ("4kh1d6", "4kh1(2d6)", MAX_OF_FOUR_2D6),
            ("d6 > d6", "2d6 > 2d6", MAX_OF_TWO_2D6),
        ];
        for (src, expr, mean) in cases {
            let doubled = dd(src)?.double_dice()?;
            assert_eq!(doubled.to_expression()?, expr);
            assert_close(pmf_of(&doubled).mean(), mean, 12);
        }
        Ok(())
    }

    /// tests/crit-keep.test.ts:91
    #[test]
    fn a_best_of_that_stays_a_plain_sum_after_doubling_doubles_as_plain_dice() -> T {
        let r = rd(1.0, &d6())?.best_of(2.0)?.double_dice()?;
        assert_close(pmf_of(&r).mean(), 7.0, 12);
        Ok(())
    }

    fn ambiguous_rolls() -> Result<Vec<(&'static str, RollBuilder, &'static str)>, DiceError> {
        Ok(vec![
            (
                "roll(4,d6).keepHighest(4,3)",
                rd(4.0, &d6())?.keep_highest(4.0, 3.0)?,
                "4kh3(1d6)",
            ),
            (
                "roll(1,d6).keepHighest(4,3)",
                rd(1.0, &d6())?.keep_highest(4.0, 3.0)?,
                "4kh3(1d6)",
            ),
            (
                "roll(1,d6).keepLowest(2,1)",
                rd(1.0, &d6())?.keep_lowest(2.0, 1.0)?,
                "2kl1(1d6)",
            ),
            (
                "roll(4,d6).bestOf(3)",
                rd(4.0, &d6())?.best_of(3.0)?,
                "bestOf(3)",
            ),
            (
                "roll(2,d6).bestOf(1)",
                rd(2.0, &d6())?.best_of(1.0)?,
                "bestOf(1)",
            ),
            (
                "roll(2,d6).bestOf(3), plain until doubled",
                rd(2.0, &d6())?.best_of(3.0)?,
                "bestOf(3)",
            ),
            ("d6.withAdvantage()", d6().with_advantage()?, "advantage"),
            (
                "roll(2,d8).withDisadvantage()",
                rd(2.0, &d8())?.with_disadvantage()?,
                "disadvantage",
            ),
            (
                "d6.withElvenAccuracy()",
                d6().with_elven_accuracy()?,
                "elven accuracy",
            ),
        ])
    }

    /// tests/crit-keep.test.ts:116
    #[test]
    fn double_dice_and_scale_dice_3_throw_naming_the_shape_and_suggesting_on_crit() -> T {
        for (name, r, shape) in ambiguous_rolls()? {
            let e = err_of(r.double_dice());
            assert!(e.contains(shape), "{name}: {e}");
            assert!(e.contains("onCrit("), "{name}: {e}");
            let e = err_of(r.scale_dice(3.0));
            assert!(e.contains(shape), "{name}: {e}");
        }
        Ok(())
    }

    /// tests/crit-keep.test.ts:124
    #[test]
    fn the_throw_reaches_through_a_flat_a_half_a_scale_a_sum_and_a_pool_built_on_the_keep() -> T {
        let keep = || rd(4.0, &d6())?.keep_highest(4.0, 3.0);
        assert_throws(keep()?.plus(3.0)?.double_dice(), "4kh3");
        assert_throws(rd(1.0, &d8())?.plus_roll(&keep()?)?.double_dice(), "4kh3");
        assert_throws(keep()?.half()?.double_dice(), "4kh3");
        assert_throws(
            keep()?
                .scale_result(2.0, 1.0, crate::builder::nodes::Rounding::Floor)?
                .double_dice(),
            "4kh3",
        );
        assert_throws(keep()?.keep_highest_all(2.0, 1.0)?.double_dice(), "4kh3");
        Ok(())
    }

    /// tests/crit-keep.test.ts:182
    #[test]
    fn parsed_double_dice_throws_naming_the_keep_and_suggesting_an_explicit_crit() -> T {
        let ambiguous = [
            ("4kh3(1d6)", "4kh3"),
            ("4kh3d6", "4kh3"),
            ("3kh2(2d6 + 1)", "3kh2"),
            ("kh2d6", "kh2"),
            ("3kl1(1d6)", "3kl1"),
            ("2kl1(1d6) + 3", "2kl1"),
            ("1d8 + 4kh3d6", "4kh3"),
            ("2kh1(4kh3(1d6))", "4kh3"),
            ("d6 < d6", "d6 < d6"),
        ];
        for (expression, shape) in ambiguous {
            let e = err_of(dd(expression)?.double_dice());
            assert!(e.contains(shape), "{expression}: {e}");
            assert!(e.contains("onCrit("), "{expression}: {e}");
        }
        Ok(())
    }

    /// tests/crit-keep.test.ts:189
    #[test]
    fn a_string_cap_or_floor_with_one_dice_side_still_doubles() -> T {
        assert_eq!(dd("2d6 < 9")?.double_dice()?.to_expression()?, "4d6 < 9");
        assert_eq!(dd("3>d6")?.double_dice()?.to_expression()?, "2(3>d6)");
        Ok(())
    }

    /// tests/crit-keep.test.ts:200 (translated: the parsed-string part; no `.ac`/`.onHit` involved)
    #[test]
    fn an_attack_string_with_no_crit_clause_throws_a_crit_clause_resolves() -> T {
        assert_throws(dd("(d20 + 5 AC 12) * (4kh3(1d6))"), "4kh3");
        let explicit = pmf_of(&dd(
            "(d20 + 5 AC 12) * (4kh3(1d6)) crit (4kh3(1d6) + 4kh3(1d6))",
        )?);
        assert_close(explicit.outcome_probability("crit"), 0.05, 12);
        let expected = pmf_of(&dd("4kh3(1d6) + 4kh3(1d6)")?).scale_mass(0.05);
        same_pmf(&explicit.filter_outcome("crit"), &expected);
        Ok(())
    }
}

mod crit_doubling {
    use super::{rd, same_pmf};
    use crate::builder::factory::*;
    use crate::builder::nodes::Rounding;
    use crate::builder::roll::RollBuilder;
    use crate::builder::tests::support::*;
    use crate::error::DiceError;

    const DEFECT_B: f64 = 22.7438;

    fn dd(e: &str) -> Result<RollBuilder, DiceError> {
        d_expression(e)
    }

    /// `2d6+3`, roll it all twice and keep the better.
    fn pool() -> Result<RollBuilder, DiceError> {
        rd(2.0, &d6())?.plus(3.0)?.keep_highest_all(2.0, 1.0)
    }

    /// The dice double inside the pool, then it pools.
    fn pool_crit() -> Result<RollBuilder, DiceError> {
        rd(4.0, &d6())?.plus(3.0)?.keep_highest_all(2.0, 1.0)
    }

    /// tests/crit-doubling.test.ts:40
    #[test]
    fn double_dice_on_the_pool_itself_is_the_same_rebuilt_pool() -> T {
        same_pmf(&pmf_of(&pool()?.double_dice()?), &pmf_of(&pool_crit()?));
        assert_eq!(
            pool()?.double_dice()?.to_expression()?,
            pool_crit()?.to_expression()?
        );
        Ok(())
    }

    /// tests/crit-doubling.test.ts:45
    #[test]
    fn dice_added_after_pooling_double_too_the_pools_flats_do_not() -> T {
        let added = pool()?.plus_roll(&rd(1.0, &d4())?)?.plus(2.0)?;
        let expected = pool_crit()?.plus_roll(&rd(2.0, &d4())?)?.plus(2.0)?;
        same_pmf(&pmf_of(&added.double_dice()?), &pmf_of(&expected));
        Ok(())
    }

    /// tests/crit-doubling.test.ts:51
    #[test]
    fn keep_lowest_all_nested_pools_and_times_rebuild_from_their_own_doubled_rolls() -> T {
        same_pmf(
            &pmf_of(
                &rd(1.0, &d8())?
                    .plus(1.0)?
                    .keep_lowest_all(3.0, 2.0)?
                    .double_dice()?,
            ),
            &pmf_of(&rd(2.0, &d8())?.plus(1.0)?.keep_lowest_all(3.0, 2.0)?),
        );
        same_pmf(
            &pmf_of(
                &d6()
                    .keep_highest_all(4.0, 3.0)?
                    .keep_highest_all(3.0, 2.0)?
                    .double_dice()?,
            ),
            &pmf_of(
                &rd(2.0, &d6())?
                    .keep_highest_all(4.0, 3.0)?
                    .keep_highest_all(3.0, 2.0)?,
            ),
        );
        same_pmf(
            &pmf_of(&pool()?.times(3.0)?.double_dice()?),
            &pmf_of(&pool_crit()?.times(3.0)?),
        );
        Ok(())
    }

    /// tests/crit-doubling.test.ts:97
    #[test]
    fn d_2d6_div_2_doubled_is_d_4d6_div_2_not_two_halved_2d6() -> T {
        let doubled = dd("2d6 // 2")?.double_dice()?;
        same_pmf(&pmf_of(&doubled), &pmf_of(&dd("4d6 // 2")?));
        assert_close(pmf_of(&doubled).mean(), 6.75, 10);
        assert_eq!(doubled.to_expression()?, "4d6 // 2");
        Ok(())
    }

    /// tests/crit-doubling.test.ts:104
    #[test]
    fn a_pooled_string_doubles_inside_then_pools_2kh1_2d6_3_crits_at_o4_crit() -> T {
        let doubled = dd("2kh1(2d6+3)")?.double_dice()?;
        assert_eq!(doubled.to_expression()?, "2kh1(4d6+3)");
        same_pmf(&pmf_of(&doubled), &pmf_of(&pool_crit()?));
        assert!(!close(pmf_of(&doubled).mean(), DEFECT_B, 4));
        Ok(())
    }

    /// tests/crit-doubling.test.ts:111
    #[test]
    fn every_builder_rendered_shape_doubles_like_the_builder_itself() -> T {
        let shapes = vec![
            rd(2.0, &d6())?.plus(5.0)?,
            rd(1.0, &d6())?.reroll(1.0)?,
            rd(1.0, &d6())?.reroll(1.0)?.plus(3.0)?,
            rd(2.0, &d6())?.reroll(2.0)?,
            rd(1.0, &d6())?.minimum(3.0)?,
            rd(2.0, &d6())?.minimum(3.0)?.reroll(1.0)?,
            rd(1.0, &d8())?.plus(3.0)?.half()?,
            rd(1.0, &d6())?.scale_result(2.0, 1.0, Rounding::Floor)?,
            rd(1.0, &d6())?.keep_highest(2.0, 1.0)?,
            rd(1.0, &d8())?.plus_roll(&rd(2.0, &d6())?)?.plus(4.0)?,
            pool()?,
            pool()?.times(3.0)?,
        ];
        for shape in shapes {
            let expression = shape.to_expression()?;
            same_pmf(
                &pmf_of(&dd(&expression)?.double_dice()?),
                &pmf_of(&shape.double_dice()?),
            );
        }
        Ok(())
    }

    /// tests/crit-doubling.test.ts:132
    #[test]
    fn scale_dice_n_multiplies_the_dice_n_times_and_keeps_the_flats() -> T {
        same_pmf(
            &pmf_of(&dd("2d6+5")?.scale_dice(3.0)?),
            &pmf_of(&rd(6.0, &d6())?.plus(5.0)?),
        );
        same_pmf(
            &pmf_of(&dd("4kh1d6")?.scale_dice(3.0)?),
            &pmf_of(&dd("4kh1(3d6)")?),
        );
        Ok(())
    }

    /// tests/crit-doubling.test.ts:142 (translated: the parsed `doubleDice()` throw only; the `.ac/.onHit` resolve lines are deferred)
    #[test]
    fn an_expression_containing_an_attack_check_is_not_damage_doubling_throws() -> T {
        assert_throws(dd("(d20 + 5 AC 12) * (2d6)")?.double_dice(), "attack check");
        Ok(())
    }

    /// tests/crit-doubling.test.ts:235
    #[test]
    fn can_double_dice_is_true_exactly_when_double_dice_can_rewrite_the_string() -> T {
        let expressions = [
            ("3d6", true),
            ("2d6 // 2", true),
            ("2kh1(2d6+3)", true),
            ("(d20 + 8 AC 16) * (2d6)", false),
            ("d20+5 DC 15 * (8d6) save half", false),
            ("(d20+5 AC 15) * 0", false),
            ("d4d6", false),
        ];
        for (expression, doubles) in expressions {
            let parsed = dd(expression)?;
            assert!(
                parsed.is_parsed(),
                "expected a parsed string for {expression}"
            );
            assert_eq!(parsed.can_double_dice()?, doubles, "{expression}");
            if doubles {
                parsed.double_dice()?;
            } else {
                assert_throws(parsed.double_dice(), "Cannot double the dice");
            }
        }
        Ok(())
    }

    /// tests/crit-doubling.test.ts:341 (translated: the parsed-only tail; the builder-vs-parsed loop is deferred)
    #[test]
    fn labels_its_crit_mass_crit_and_matches_the_builder_bin_for_bin_label_by_label() -> T {
        let a = pmf_of(&dd("(d20 + 8 AC 16) * (2d6)")?);
        assert_close(a.outcome_probability("crit"), 0.05, 12);
        same_pmf(
            &a.filter_outcome("crit"),
            &pmf_of(&rd(4.0, &d6())?).scale_mass(0.05),
        );
        let b = pmf_of(&dd("(d20+5 AC 15) * (1d8+3)")?);
        same_pmf(
            &b.filter_outcome("crit"),
            &pmf_of(&rd(2.0, &d8())?.plus(3.0)?).scale_mass(0.05),
        );
        Ok(())
    }

    /// tests/crit-doubling.test.ts:384 (translated: the parsed-only checks; the `watch(...)` turn lines are deferred)
    #[test]
    fn a_crit_clause_still_wins_over_doubling_crit_2d6_crits_undoubled() -> T {
        let parsed = pmf_of(&dd("(d20 + 8 AC 16) * (2d6) crit (2d6)")?);
        assert_close(parsed.outcome_probability("crit"), 0.05, 12);
        same_pmf(
            &parsed.filter_outcome("crit"),
            &pmf_of(&rd(2.0, &d6())?).scale_mass(0.05),
        );
        Ok(())
    }

    /// tests/crit-doubling.test.ts:393
    #[test]
    fn an_always_hit_string_crits_on_a_natural_20_too() -> T {
        let parsed = pmf_of(&dd("(d20+30 AC 5) * (1d8)")?);
        assert_close(parsed.outcome_probability("hit"), 0.95, 12);
        assert_close(parsed.outcome_probability("crit"), 0.05, 12);
        same_pmf(
            &parsed.filter_outcome("crit"),
            &pmf_of(&rd(2.0, &d8())?).scale_mass(0.05),
        );
        assert_close(parsed.mean(), 4.725, 10);
        Ok(())
    }

    /// tests/crit-doubling.test.ts:401 (translated: all but the `built` `AttackBuilder` comparison)
    #[test]
    fn a_miss_or_pc_clause_keeps_its_branch_and_gains_the_crit_a_save_string_is_unchanged() -> T {
        let miss = pmf_of(&dd("(d20+5 AC 15) * (2d6) miss (1d6)")?);
        let spelled = pmf_of(&dd("(d20+5 AC 15) * (2d6) crit (4d6) miss (1d6)")?);
        for label in ["hit", "crit", "missDamage"] {
            same_pmf(&miss.filter_outcome(label), &spelled.filter_outcome(label));
        }
        assert_close(spelled.outcome_probability("crit"), 0.05, 12);
        assert_close(miss.outcome_probability("hit"), 0.5, 12);
        assert_close(miss.outcome_probability("missDamage"), 0.45, 12);

        let pc = pmf_of(&dd("(d20 + 4 AC 13) * (1d6) pc (1d6)")?);
        same_pmf(
            &pc.filter_outcome("crit"),
            &pmf_of(&rd(2.0, &d6())?).scale_mass(0.05),
        );
        same_pmf(
            &pc,
            &pmf_of(&dd("(d20 + 4 AC 13) * (1d6) crit (2d6) pc (1d6)")?),
        );

        let save = pmf_of(&dd("d20+5 DC 15 * (8d6) save half")?);
        let mut outcomes = save.outcomes();
        outcomes.sort();
        assert_eq!(
            outcomes,
            vec!["saveFail".to_string(), "saveHalf".to_string()]
        );
        assert_close(save.outcome_probability("saveFail"), 0.45, 12);
        assert_close(save.mean(), 20.1625, 10);
        Ok(())
    }

    /// tests/crit-doubling.test.ts:424
    #[test]
    fn a_hit_payload_double_dice_cannot_rewrite_d4d6_is_added_as_is_on_a_crit() -> T {
        let parsed = pmf_of(&dd("(d20+5 AC 15) * (d4d6)")?);
        assert_close(parsed.outcome_probability("crit"), 0.05, 12);
        same_pmf(
            &parsed.filter_outcome("crit"),
            &pmf_of(&dd("d4d6")?).scale_mass(0.05),
        );
        Ok(())
    }
}

mod crit_parse_edges {
    use super::{rd, same_pmf};
    use crate::Pmf;
    use crate::builder::factory::*;
    use crate::builder::tests::support::*;
    use crate::error::DiceError;
    use crate::parser::parse;

    const LABELS: [&str; 4] = ["hit", "crit", "missNone", "missDamage"];

    fn p(e: &str) -> Result<Pmf, DiceError> {
        parse(e)
    }

    /// Two strings that parse to the same bins and the same damage under each hit/crit/miss label.
    #[track_caller]
    fn same_parse(a: &str, b: &str) -> T {
        let (left, right) = (p(a)?, p(b)?);
        same_pmf(&left, &right);
        for label in LABELS {
            same_pmf(&left.filter_outcome(label), &right.filter_outcome(label));
        }
        Ok(())
    }

    /// `parse(expression)` has `outcomeProbability("crit")` and mean as given.
    #[track_caller]
    fn crit_mean(expression: &str, crit: f64, mean: f64) -> T {
        let parsed = p(expression)?;
        assert_close(parsed.outcome_probability("crit"), crit, 12);
        assert_close(parsed.mean(), mean, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:44
    #[test]
    fn plus_after_the_payload_adds_to_every_landed_hit_and_never_to_a_miss() -> T {
        let trailing = p("(d20 + 5 AC 15) * (1d8) + 1d6")?;
        same_pmf(&trailing, &p("(d20 + 5 AC 15) * ((1d8) + 1d6)")?);
        assert_close(trailing.outcome_probability("missNone"), 9.0 / 20.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:51 (translated: parse-only checks; the `expectSameAttack` builder comparison is deferred)
    #[test]
    fn d20_5_ac_15_1d8_plus_1d6_crits_as_2d8_plus_2d6_mean_24_5() -> T {
        let parsed = p("(d20 + 5 AC 15) * (1d8) + 1d6")?;
        assert_close(parsed.mean(), 24.0 / 5.0, 12);
        let expected = pmf_of(&rd(2.0, &d8())?.plus_roll(&rd(2.0, &d6())?)?).scale_mass(0.05);
        same_pmf(&parsed.filter_outcome("crit"), &expected);
        same_parse("(d20 + 5 AC 15) * (1d8) + 1d6", "d20 + 5 AC 15 * 1d8 + 1d6")?;
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:59 (translated: parse-only checks; the builder comparison is deferred)
    #[test]
    fn a_trailing_flat_keeps_every_label_and_is_added_once_on_a_crit() -> T {
        crit_mean("(d20+5 AC 12) * (2d6) + 3", 0.05, 147.0 / 20.0)
    }

    /// tests/crit-parse-edges.test.ts:88 (translated: the mean; the builder comparison is deferred)
    #[test]
    fn a_miss_clause_keeps_its_label_and_a_trailing_plus_adds_to_its_damage_too() -> T {
        let parsed = p("(d20 + 5 AC 15) * (2d6) miss (1d6) + 3")?;
        assert_close(parsed.mean(), 351.0 / 40.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:96 (translated: parse-only checks)
    #[test]
    fn advantage_crit_39_400_mean_5537_800() -> T {
        crit_mean(
            "(d20 > d20 + 5 + 1d4 AC 15) * (2d6)",
            39.0 / 400.0,
            5537.0 / 800.0,
        )
    }

    /// tests/crit-parse-edges.test.ts:103 (translated: parse-only checks)
    #[test]
    fn halfling_luck_crit_21_400_mean_4263_800() -> T {
        crit_mean(
            "(hd20 + 5 + 1d4 AC 15) * (2d6)",
            21.0 / 400.0,
            4263.0 / 800.0,
        )
    }

    /// tests/crit-parse-edges.test.ts:110 (translated: the parsed-only mean and spelling equalities; builder comparisons are deferred)
    #[test]
    fn disadvantage_elven_accuracy_bang_reroll_parentheses_and_1d20_spell_the_same_checks() -> T {
        let adv = "(d20 > d20 + 5 + 1d4 AC 15) * (2d6)";
        same_parse("(d20! + 5 + 1d4 AC 15) * (2d6)", adv)?;
        same_parse("((d20 > d20) + 5 + 1d4 AC 15) * (2d6)", adv)?;
        same_parse(
            "(1d20 + 5 + 1d4 AC 15) * (2d6)",
            "(d20 + 5 + 1d4 AC 15) * (2d6)",
        )?;
        assert_close(
            p("(d20 > d20 > d20 + 5 + 1d4 AC 15) * (2d6)")?.mean(),
            30947.0 / 4000.0,
            12,
        );
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:129 (translated: parse-only checks; builder comparisons are deferred)
    #[test]
    fn xcrit_with_a_bonus_die_crits_on_every_natural_face_in_range() -> T {
        crit_mean(
            "(d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)",
            1.0 / 10.0,
            441.0 / 80.0,
        )?;
        assert_close(
            p("(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)")?.mean(),
            12063.0 / 1600.0,
            12,
        );
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:141 (translated: parse-only checks; builder comparisons are deferred)
    #[test]
    fn the_natural_roll_is_the_checks_d20_wherever_it_sits_in_the_sum() -> T {
        for expression in [
            "(1d4 + d20 + 5 AC 15) * (2d6)",
            "(1d4 + 1d20 + 5 AC 15) * (2d6)",
            "(5 + 1d4 + d20 AC 15) * (2d6)",
            "(d4 + 5 + d20 AC 15) * (2d6)",
            "(1d4 + d20 + 5 AC 15) * (2d6) crit (4d6)",
        ] {
            crit_mean(expression, 1.0 / 20.0, 203.0 / 40.0)?;
        }
        assert_close(p("(2d4 + d20 + 5 AC 15) * (2d6)")?.mean(), 119.0 / 20.0, 12);
        for expression in [
            "(d12 + 1d4 AC 10) * (1d6) crit (2d6)",
            "(1d4 + d12 AC 10) * (1d6) crit (2d6)",
        ] {
            crit_mean(expression, 1.0 / 12.0, 91.0 / 48.0)?;
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:166 (translated: parse-only checks; builder comparisons are deferred)
    #[test]
    fn keep_spelled_advantage_disadvantage_and_elven_accuracy_keep_one_natural_d20() -> T {
        for (expression, crit, mean) in [
            (
                "(2kh1(1d20) + 5 AC 15) * (2d6) crit (4d6)",
                39.0 / 400.0,
                1253.0 / 200.0,
            ),
            (
                "(2kh1d20 + 5 AC 15) * (2d6) crit (4d6)",
                39.0 / 400.0,
                1253.0 / 200.0,
            ),
            (
                "(2kl1(1d20) + 5 AC 15) * (2d6) crit (4d6)",
                1.0 / 400.0,
                427.0 / 200.0,
            ),
            (
                "(3kh1(1d20) + 5 AC 15) * (2d6) crit (4d6)",
                1141.0 / 8000.0,
                14721.0 / 2000.0,
            ),
            (
                "(2kh1(1d20) + 5 AC 15) * (2d6) xcrit2 (4d6)",
                19.0 / 100.0,
                553.0 / 80.0,
            ),
            (
                "(2kh1(1d20) + 5 AC 15) * (1d6)",
                39.0 / 400.0,
                1253.0 / 400.0,
            ),
        ] {
            crit_mean(expression, crit, mean)?;
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:188
    #[test]
    fn d20_gt_d4_crits_when_the_d20s_natural_20_is_the_value_kept() -> T {
        for expression in [
            "(d20 > d4 + 5 AC 10) * (1d6) crit (2d6)",
            "(d20 > d4 + 5 AC 10) * (1d6)",
        ] {
            let parsed = p(expression)?;
            assert_close(parsed.outcome_probability("crit"), 1.0 / 20.0, 12);
            assert_close(parsed.outcome_probability("hit"), 3.0 / 4.0, 12);
            assert_close(parsed.mean(), 119.0 / 40.0, 12);
        }
        for expression in [
            "(d20 < 15 + 5 AC 10) * (1d6)",
            "(d20 < 15 + 5 AC 10) * (1d6) crit (2d6)",
            "(d20 < 15 + 5 AC 10) * (1d6) xcrit2 (2d6)",
        ] {
            let capped = p(expression)?;
            assert_eq!(capped.outcome_probability("crit"), 0.0, "{expression}");
            assert_close(capped.outcome_probability("hit"), 4.0 / 5.0, 12);
            assert_close(capped.mean(), 14.0 / 5.0, 12);
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:208
    #[test]
    fn the_natural_roll_is_the_checks_one_d20_even_beside_a_larger_die() -> T {
        for (expression, crit, mean) in [
            (
                "(d20 + d100 AC 60) * (1d6) crit (2d6)",
                61.0 / 2000.0,
                7637.0 / 4000.0,
            ),
            ("(d20 + d100 AC 60) * (1d6)", 61.0 / 2000.0, 7637.0 / 4000.0),
            (
                "(d100 + d20 AC 60) * (1d6) crit (2d6)",
                61.0 / 2000.0,
                7637.0 / 4000.0,
            ),
            (
                "(d20 + 100 - d100 AC 60) * (1d6) crit (2d6)",
                3.0 / 100.0,
                749.0 / 400.0,
            ),
            (
                "(d20 + 100 - d100 AC 60) * (1d6)",
                3.0 / 100.0,
                749.0 / 400.0,
            ),
            (
                "(d20 - d100 + 100 AC 60) * (1d6) crit (2d6)",
                3.0 / 100.0,
                749.0 / 400.0,
            ),
            (
                "(d20 - d100 + 100 AC 60) * (1d6)",
                3.0 / 100.0,
                749.0 / 400.0,
            ),
            ("(d20 + d30 + 5 AC 25) * (1d6)", 1.0 / 20.0, 1071.0 / 400.0),
            (
                "(d20 + d30 + 5 AC 25) * (1d6) crit (2d6)",
                1.0 / 20.0,
                1071.0 / 400.0,
            ),
            (
                "(d20 + 1d30 AC 25) * (1d6) crit (2d6)",
                13.0 / 300.0,
                623.0 / 300.0,
            ),
            (
                "(d20 > d30 AC 10) * (1d6) crit (2d6)",
                1.0 / 30.0,
                3773.0 / 1200.0,
            ),
            (
                "(2kh1d20 + d100 AC 60) * (1d6) crit (2d6)",
                2379.0 / 40000.0,
                170163.0 / 80000.0,
            ),
            (
                "(d100 & d20 AC 10) * (1d6) crit (2d6)",
                1.0 / 120.0,
                721.0 / 240.0,
            ),
        ] {
            crit_mean(expression, crit, mean)?;
        }
        for expression in [
            "(d20 + d20 + d100 AC 60) * (1d6)",
            "(d100 + 2d20 AC 60) * (1d6) crit (2d6)",
        ] {
            assert_throws(p(expression), "crit rate cannot be computed exactly");
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:235
    #[test]
    fn and_mixes_checks_by_count_a_crit_is_a_d20_branchs_natural_20() -> T {
        for (expression, hit, crit, mean) in [
            (
                "(d20 & d20 AC 10) * (1d6) crit (2d6)",
                1.0 / 2.0,
                1.0 / 20.0,
                21.0 / 10.0,
            ),
            (
                "(d20 & d20 AC 10) * (1d6)",
                1.0 / 2.0,
                1.0 / 20.0,
                21.0 / 10.0,
            ),
            (
                "(d20 & d20 AC 10) * (1d6) xcrit2 (2d6)",
                9.0 / 20.0,
                1.0 / 10.0,
                91.0 / 40.0,
            ),
            (
                "(d4 & d20 AC 5) * (1d6) crit (2d6)",
                5.0 / 8.0,
                1.0 / 24.0,
                119.0 / 48.0,
            ),
            (
                "(d20 & d4 AC 5) * (1d6) crit (2d6)",
                5.0 / 8.0,
                1.0 / 24.0,
                119.0 / 48.0,
            ),
            (
                "(d4 & d20 AC 5) * (1d6)",
                5.0 / 8.0,
                1.0 / 24.0,
                119.0 / 48.0,
            ),
            (
                "(d20 & d4 AC 5) * (1d6)",
                5.0 / 8.0,
                1.0 / 24.0,
                119.0 / 48.0,
            ),
            (
                "(10 & d20 AC 10) * (1d6) crit (2d6)",
                11.0 / 21.0,
                1.0 / 21.0,
                13.0 / 6.0,
            ),
            (
                "(d20 & 10 AC 10) * (1d6) crit (2d6)",
                11.0 / 21.0,
                1.0 / 21.0,
                13.0 / 6.0,
            ),
            (
                "(10 & d20 AC 10) * (1d6)",
                11.0 / 21.0,
                1.0 / 21.0,
                13.0 / 6.0,
            ),
            (
                "(d20 & 10 AC 10) * (1d6)",
                11.0 / 21.0,
                1.0 / 21.0,
                13.0 / 6.0,
            ),
            (
                "(d20 & d20 + 5 AC 15) * (1d6)",
                1.0 / 2.0,
                1.0 / 20.0,
                21.0 / 10.0,
            ),
            (
                "((d20 + 5) & (d20 + 3) AC 15) * (1d6) crit (2d6)",
                9.0 / 20.0,
                1.0 / 20.0,
                77.0 / 40.0,
            ),
            (
                "((d20 + d4) & d20 AC 15) * (1d6) crit (2d6)",
                7.0 / 20.0,
                1.0 / 20.0,
                63.0 / 40.0,
            ),
            (
                "(d20 & (d20 + d4) AC 15) * (1d6)",
                7.0 / 20.0,
                1.0 / 20.0,
                63.0 / 40.0,
            ),
            (
                "(d4 & (d20 AC 5)) * (1d6)",
                19.0 / 24.0,
                1.0 / 24.0,
                49.0 / 16.0,
            ),
            (
                "((d20 AC 5) & d4) * (1d6)",
                19.0 / 24.0,
                1.0 / 24.0,
                49.0 / 16.0,
            ),
            (
                "(d4 & (d20 AC 5)) * (1d6) crit (2d6)",
                19.0 / 24.0,
                1.0 / 24.0,
                49.0 / 16.0,
            ),
            (
                "(4 & (d20 AC 15)) * (1d6)",
                2.0 / 7.0,
                1.0 / 21.0,
                4.0 / 3.0,
            ),
            (
                "((d20 AC 15) & 4) * (1d6)",
                2.0 / 7.0,
                1.0 / 21.0,
                4.0 / 3.0,
            ),
            (
                "((d20 & d4) > d20 AC 15) * (1d6) crit (2d6)",
                37.0 / 96.0,
                43.0 / 480.0,
                1897.0 / 960.0,
            ),
            (
                "((d20 & d4) > d20 AC 15) * (1d6)",
                37.0 / 96.0,
                43.0 / 480.0,
                1897.0 / 960.0,
            ),
            (
                "(d20 > (d20 & d4) AC 15) * (1d6)",
                37.0 / 96.0,
                43.0 / 480.0,
                1897.0 / 960.0,
            ),
            (
                "((d20 & 10) > d20 AC 15) * (1d6) crit (2d6)",
                17.0 / 42.0,
                2.0 / 21.0,
                25.0 / 12.0,
            ),
            (
                "((d20 & d4)! AC 15) * (1d6)",
                205.0 / 576.0,
                47.0 / 576.0,
                2093.0 / 1152.0,
            ),
            (
                "(2kh1(d20 & d20) AC 15) * (1d6) crit (2d6)",
                33.0 / 80.0,
                39.0 / 400.0,
                1701.0 / 800.0,
            ),
            (
                "((d20 & d20) reroll 1 AC 15) * (1d6) crit (2d6)",
                21.0 / 80.0,
                21.0 / 400.0,
                1029.0 / 800.0,
            ),
        ] {
            let parsed = p(expression)?;
            assert_close(parsed.outcome_probability("hit"), hit, 12);
            assert_close(parsed.outcome_probability("crit"), crit, 12);
            assert_close(parsed.mean(), mean, 12);
        }
        for (left, right) in [
            ("(10 & d20 AC 10) * (1d6)", "(d20 & 10 AC 10) * (1d6)"),
            (
                "(10 & d20 AC 10) * (1d6) crit (2d6)",
                "(d20 & 10 AC 10) * (1d6) crit (2d6)",
            ),
            ("(d4 & d20 AC 5) * (1d6)", "(d20 & d4 AC 5) * (1d6)"),
            (
                "(d4 & d20 AC 5) * (1d6) crit (2d6)",
                "(d20 & d4 AC 5) * (1d6) crit (2d6)",
            ),
            (
                "((d20 + d4) & d20 AC 15) * (1d6) crit (2d6)",
                "(d20 & (d20 + d4) AC 15) * (1d6) crit (2d6)",
            ),
            (
                "((d20 & d4) > d20 AC 15) * (1d6)",
                "(d20 > (d20 & d4) AC 15) * (1d6)",
            ),
            (
                "((d20 & d4) > d20 AC 15) * (1d6) crit (2d6)",
                "(d20 > (d20 & d4) AC 15) * (1d6) crit (2d6)",
            ),
            ("(d4 & (d20 AC 5)) * (1d6)", "((d20 AC 5) & d4) * (1d6)"),
            (
                "(d4 & (d20 AC 5)) * (1d6) crit (2d6)",
                "((d20 AC 5) & d4) * (1d6) crit (2d6)",
            ),
            ("(4 & (d20 AC 15)) * (1d6)", "((d20 AC 15) & 4) * (1d6)"),
        ] {
            same_parse(left, right)?;
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:291
    #[test]
    fn and_with_a_branch_whose_d20_is_not_one_natural_roll_throws_a_mix_of_numbers_never_crits() -> T
    {
        for expression in [
            "((d20 + d20) & d20 AC 15) * (1d6) crit (2d6)",
            "(d20 & (d20 + d20) AC 15) * (1d6)",
            "(2d20 & d20 AC 15) * (1d6)",
            "((d20 & d4) reroll 1 AC 15) * (1d6) crit (2d6)",
            "(1(d20 & d4) AC 5) * (1d6) crit (2d6)",
            "(2kh1(d20 & d4) AC 15) * (1d6) crit (2d6)",
            "((d20 & d4)!! AC 15) * (1d6)",
        ] {
            assert_throws(p(expression), "crit rate cannot be computed exactly");
        }
        for expression in ["(10 & 5 AC 8) * (1d6) crit (2d6)", "(10 & 5 AC 8) * (1d6)"] {
            let parsed = p(expression)?;
            assert_eq!(parsed.outcome_probability("crit"), 0.0, "{expression}");
            assert_close(parsed.mean(), 7.0 / 4.0, 12);
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:315
    #[test]
    fn and_with_an_attack_split_into_outcomes_a_save_beside_a_non_save_or_a_clause_after_it_throws()
    -> T {
        for expression in [
            "((d20 AC 5) * (1d6)) & d4",
            "d4 & ((d20 AC 5) * (1d6))",
            "(d4 & ((d20 AC 5) * (1d6))) * (1d6)",
            "(d20 + 5 AC 15) * (1d6) & 3",
            "((d20 AC 10) * (1d6) crit (2d6)) & ((d20 AC 15) * (1d6) crit (2d6))",
            "((d20 DC 12) * (8d6) save half) & 3",
            "d4 & (d20 DC 12)",
            "(d20 DC 12) & d4",
            "(d20 AC 10) & (d20 DC 12)",
            "(d20 + 5 AC 15) & (1d6) crit (2d6)",
            "d4 & (d20 AC 5) crit (d6)",
            "(d20 + 5 AC 15) & (1d6) miss (1)",
            "(d20 + 5 DC 15) & (d20 DC 12) save half",
        ] {
            assert_throws(p(expression), "an `&` mix");
        }
        same_pmf(&p("((15 AC 12) * (1d6)) & 1")?, &p("1d6 & 1")?);
        same_parse(
            "((d20 DC 12) & (d20 DC 15)) * (8d6)",
            "((d20 DC 15) & (d20 DC 12)) * (8d6)",
        )
    }

    /// tests/crit-parse-edges.test.ts:343 (translated: all but the `.ac(15).onHit("1d6 & 3").resolve()` line)
    #[test]
    fn and_in_a_hit_payload_that_doubles_has_no_single_doubled_meaning_it_throws() -> T {
        for expression in [
            "(d20 + 5 AC 15) * (1d6 & 3)",
            "(d20 + 5 AC 15) * (1d4 & 1d6)",
            "(d20 + 5 AC 15) * (d6 & d6 & 3)",
            "(d20 + 5 AC 15) * (3 & 1d6) miss (1)",
            "(d20 + 5 AC 15) * (1d6) + (1d4 & 2)",
        ] {
            let e = err_of(p(expression));
            assert!(
                e.contains("the mix `") && e.contains("has no single doubled meaning"),
                "{expression}: {e}"
            );
        }
        for payload in [
            "1d6 & 3",
            "3 & 1d6",
            "2(1d6 & 3)",
            "2kh1(1d6 & 3)",
            "1d8 + (1d4 & 2)",
        ] {
            let e = error_of(d_expression(payload)?.double_dice());
            assert!(
                matches!(e, crate::error::DiceError::AmbiguousCritDoubling(_)),
                "{payload}: {e}"
            );
        }
        let mean = pmf_of(&d_expression("(3 & 4) + 1d6")?.double_dice()?).mean();
        assert_close(mean, 21.0 / 2.0, 12);
        let explicit = p("(d20 + 5 AC 15) * (1d6 & 3) crit (2d6 & 3)")?;
        assert_close(explicit.outcome_probability("crit"), 1.0 / 20.0, 12);
        assert_close(explicit.mean(), 2133.0 / 1036.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:366
    #[test]
    fn a_check_with_no_single_natural_die_to_crit_on_throws_instead_of_guessing() -> T {
        for expression in [
            "(2d20 + 5 AC 30) * (1d6)",
            "(2d20 + 5 AC 30) * (1d6) crit (2d6)",
            "(d20 + d20 + 5 AC 30) * (1d6)",
            "(d20 + d20 + 5 AC 30) * (1d6) crit (2d6)",
            "(1d4 + 2d20 AC 30) * (1d6)",
            "(2kh2(1d20) + 5 AC 30) * (1d6)",
            "((d20 + 1d4)! AC 15) * (1d6)",
            "(d20 + 5 > d20 AC 15) * (1d6)",
        ] {
            assert_throws(p(expression), "crit rate cannot be computed exactly");
        }
        assert_close(p("2d20 + 5 AC 30")?.mass(), 1.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:383 (translated: the parse-only table; the builder `roll.flat(..).ac/alwaysHits` comparisons are deferred)
    #[test]
    fn a_check_with_no_die_in_it_has_no_natural_roll_crit_mass_exactly_0() -> T {
        for (expression, mean, hit) in [
            ("(15 AC 12) * (1d6)", 7.0 / 2.0, 1.0),
            ("15 AC 12 * 1d6 + 3", 13.0 / 2.0, 1.0),
            ("((15) AC 12) * (1d6) miss (1)", 7.0 / 2.0, 1.0),
            ("(15 AC 20) * (1d6)", 0.0, 0.0),
            ("(2(5) + 5 AC 12) * (1d6)", 7.0 / 2.0, 1.0),
            ("(3 ** 5 AC 16) * (1d6 + 2)", 0.0, 0.0),
            ("(25 AC d20) * (1d6)", 7.0 / 2.0, 1.0),
            ("(15 AC 12) * (1d6) crit (2d6)", 7.0 / 2.0, 1.0),
            ("(15 AC 12) * (1d6) xcrit2 (2d6)", 7.0 / 2.0, 1.0),
            ("(15 AC 20) * (1d6) crit (2d6)", 0.0, 0.0),
            ("(25 AC d20) * (1d6) crit (2d6)", 7.0 / 2.0, 1.0),
        ] {
            let parsed = p(expression)?;
            assert_eq!(parsed.outcome_probability("crit"), 0.0, "{expression}");
            assert_close(parsed.outcome_probability("hit"), hit, 12);
            assert_close(parsed.mean(), mean, 12);
        }
        assert_close(
            p("(15 AC 20) * (1d6) crit (2d6)")?.outcome_probability("missNone"),
            1.0,
            12,
        );
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:421 (translated: parse-only checks)
    #[test]
    fn flat_xcrit2_hit_9_20_crit_1_10_mean_31_5() -> T {
        let parsed = p("(d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)")?;
        assert_close(parsed.outcome_probability("hit"), 9.0 / 20.0, 12);
        assert_close(parsed.outcome_probability("crit"), 1.0 / 10.0, 12);
        assert_close(parsed.mean(), 31.0 / 5.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:430 (translated: parse-only checks)
    #[test]
    fn advantage_xcrit2_hit_243_400_crit_19_100_mean_1861_200() -> T {
        let parsed = p("(d20 > d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)")?;
        assert_close(parsed.outcome_probability("hit"), 243.0 / 400.0, 12);
        assert_close(parsed.outcome_probability("crit"), 19.0 / 100.0, 12);
        assert_close(parsed.mean(), 1861.0 / 200.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:439 (translated: parse-only checks)
    #[test]
    fn disadvantage_xcrit3_hit_7_25_crit_9_400_mean_1273_400() -> T {
        let parsed = p("(d20 < d20 + 5 AC 15) * (2d6 + 3) xcrit3 (4d6 + 3)")?;
        assert_close(parsed.outcome_probability("hit"), 7.0 / 25.0, 12);
        assert_close(parsed.outcome_probability("crit"), 9.0 / 400.0, 12);
        assert_close(parsed.mean(), 1273.0 / 400.0, 12);
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:448 (translated: parse-only checks)
    #[test]
    fn a_crit_range_reaching_a_face_that_misses_the_natural_19_stays_a_miss() -> T {
        let parsed = p("(d20 + 1 AC 21) * (1d6) xcrit2 (2d6)")?;
        assert_close(parsed.outcome_probability("hit"), 0.0, 12);
        assert_close(parsed.outcome_probability("crit"), 1.0 / 20.0, 12);
        assert_close(parsed.mean(), 7.0 / 20.0, 12);
        Ok(())
    }
}

mod parsed_check_refusal {
    use crate::builder::factory::*;
    use crate::builder::roll::{Arg, RollBuilder};
    use crate::builder::tests::support::*;

    /// tests/parsed-check-refusal.test.ts:7 (translated through `refuse_parsed_check`, the guard `.ac()`/`.dc()` call first; `.ac`/`.dc` themselves are deferred)
    #[test]
    fn a_parsed_string_throws_instead_of_dropping_the_strings_flats_and_dice() -> T {
        let cases = [
            (d_expression("d20+5")?, "ac"),
            (
                RollBuilder::from_args(&[Arg::Str("d20+5".to_string())])?,
                "ac",
            ),
            (d_expression("d20+5")?, "dc"),
            (
                RollBuilder::from_args(&[Arg::Str("d20 + 3 + 1d4".to_string())])?,
                "dc",
            ),
        ];
        for (parsed, verb) in cases {
            let e = err_of(parsed.refuse_parsed_check(verb));
            assert!(e.starts_with("Cannot use the parsed string"), "{e}");
            assert!(e.contains("d20.plus") || e.contains("AC"), "{e}");
        }
        Ok(())
    }

    /// tests/parsed-check-refusal.test.ts:18
    #[test]
    fn stays_usable_as_a_damage_payload() -> T {
        assert_close(pmf_of(&d_expression("2d6+3")?).mean(), 10.0, 12);
        Ok(())
    }
}

mod roll_save_cache {
    use super::rd;
    use crate::builder::factory::*;
    use crate::builder::tests::support::*;

    /// tests/RollSaveCache.test.ts:23
    #[test]
    fn is_byte_identical_mean_to_an_uncached_resolution() -> T {
        let a = pmf_of(&rd(2.0, &d6())?.plus(3.0)?).mean();
        let b = pmf_of(&rd(2.0, &d6())?.plus(3.0)?).mean();
        assert_close(a, b, 12);
        Ok(())
    }

    /// tests/RollSaveCache.test.ts:30 (no instance cache in Rust: asserts the PMFs differ by value)
    #[test]
    fn forks_the_key_on_dice_count_sides_modifier_reroll_and_minimum() -> T {
        let base = pmf_of(&rd(2.0, &d6())?.plus(3.0)?).mean();
        let variants = [
            rd(3.0, &d6())?.plus(3.0)?,
            rd(2.0, &d8())?.plus(3.0)?,
            rd(2.0, &d6())?.plus(4.0)?,
            rd(2.0, &d6())?.plus(3.0)?.reroll(1.0)?,
            rd(2.0, &d6())?.plus(3.0)?.minimum(2.0)?,
        ];
        for v in variants {
            assert!(
                (pmf_of(&v).mean() - base).abs() > 1e-9,
                "{}",
                v.to_expression()?
            );
        }
        Ok(())
    }

    /// tests/RollSaveCache.test.ts:43
    #[test]
    fn keeps_distinct_rolls_numerically_distinct_no_cross_contamination() -> T {
        let small = pmf_of(&rd(1.0, &d4())?).mean();
        let big = pmf_of(&rd(10.0, &d10())?).mean();
        assert!(small < big);
        assert_close(pmf_of(&rd(1.0, &d4())?).mean(), small, 12);
        Ok(())
    }

    /// tests/RollSaveCache.test.ts:50
    #[test]
    fn never_serves_a_wrong_pmf_for_a_builder_that_opts_out_of_caching_null_cache_key() -> T {
        assert_eq!(rd(2.0, &d8())?.half()?.cache_key(), None);
        assert_close(pmf_of(&rd(2.0, &d8())?.half()?).mean(), 4.25, 6);
        assert_close(pmf_of(&rd(3.0, &d8())?.half()?).mean(), 6.5, 6);
        assert_close(pmf_of(&rd(2.0, &d8())?).mean(), 9.0, 6);
        Ok(())
    }
}
