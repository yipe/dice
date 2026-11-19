//! Builder-only cases from the miss-reroll / example / explodePool / save-label / attack-channels TS tests.

use super::support::*;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::error::DiceError;
use crate::parser::parse_with;

fn pool(count: f64) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(d8())), None)
}

fn support_of(r: &RollBuilder) -> Result<Vec<f64>, DiceError> {
    Ok(r.to_pmf(0.0)?.support().iter().map(|d| d.0).collect())
}

/// src/builder/example.test.ts:196
#[test]
fn should_handle_a_roll_with_best_of() -> T {
    let r = roll_with(4.0, None, None)?.d(6.0)?.best_of(3.0)?;
    assert_eq!(r.to_expression()?, "4kh3(1d6)");
    Ok(())
}

/// src/builder/example.test.ts:200
#[test]
fn should_ignore_best_of_if_it_is_not_less_than_count() -> T {
    let r = roll_with(3.0, None, None)?.d(6.0)?;
    assert_eq!(r.best_of(3.0)?.to_expression()?, "3d6");
    assert_eq!(r.best_of(4.0)?.to_expression()?, "3d6");
    Ok(())
}

/// src/builder/example.test.ts:205
#[test]
fn should_handle_a_complex_expression_with_parts() -> T {
    let base = roll_with(2.0, None, None)?.d(6.0)?;
    assert_eq!(base.plus(3.0)?.to_expression()?, "2d6 + 3");
    assert_eq!(base.minus(2.0)?.to_expression()?, "2d6 - 2");
    Ok(())
}

/// src/builder/explodePool.test.ts:17 (one row per oracle).
#[test]
fn pool_explode_pool_has_pool_wide_mean() -> T {
    let oracles = [
        (1.0, 1.0, 5.0625),
        (1.0, 3.0, 5.1416015625),
        (2.0, 1.0, 10.0546875),
        (3.0, 2.0, 15.3402099609),
        (4.0, 3.0, 20.5365715027),
        (4.0, 5.0, 20.5701819956),
    ];
    for (count, budget, mean) in oracles {
        let pmf = pool(count)?.explode_pool(budget)?.to_pmf(0.0)?;
        assert_close(pmf.mean(), mean, 10);
        assert_close(pmf.mass(), 1.0, 12);
    }
    Ok(())
}

/// src/builder/explodePool.test.ts:26
#[test]
fn explode_pool_2d8_budget_1_is_pool_wide_not_per_die() -> T {
    let pmf = pool(2.0)?.explode_pool(1.0)?.to_pmf(0.0)?;
    assert_close(pmf.mean(), 10.0546875, 10);
    assert!(!close(pmf.mean(), 10.125, 4));
    Ok(())
}

/// src/builder/explodePool.test.ts:33 (the count == 1 oracles).
#[test]
fn single_die_explode_pool_matches_explode_exactly() -> T {
    for (budget, per_die) in [(1.0, 5.0625), (3.0, 5.1416015625)] {
        let pool_wide = pool(1.0)?.explode_pool(budget)?.to_pmf(0.0)?;
        let explode = pool(1.0)?.explode(budget)?.to_pmf(0.0)?;
        assert_close(pool_wide.mean(), per_die, 10);
        assert_close(pool_wide.mean(), explode.mean(), 10);
        assert_close(pool_wide.mass(), 1.0, 12);
    }
    Ok(())
}

/// src/builder/explodePool.test.ts:42
#[test]
fn explode_and_explode_pool_are_mutually_exclusive_on_one_config() -> T {
    assert!(pool(2.0)?.explode(1.0)?.explode_pool(1.0).is_err());
    assert!(pool(2.0)?.explode_pool(1.0)?.explode(1.0).is_err());
    Ok(())
}

/// src/builder/explodePool.test.ts:47
#[test]
fn explode_pool_throws_on_a_pooled_roll_mirroring_explode_s_guard() -> T {
    let pooled = pool(4.0)?.keep_highest_all(4.0, 3.0)?;
    assert_throws(pooled.explode_pool(1.0), "pooled roll");
    Ok(())
}

/// src/builder/explodePool.test.ts:52
#[test]
fn to_expression_throws_for_a_pool_wide_explosion_budget() -> T {
    assert_throws(
        pool(2.0)?.explode_pool(1.0)?.to_expression(),
        "explode syntax",
    );
    Ok(())
}

/// src/builder/explodePool.test.ts:56
#[test]
fn explode_semantics_are_unaffected_by_the_new_pool_wide_budget_regression() -> T {
    let pmf = pool(1.0)?.explode(3.0)?.to_pmf(0.0)?;
    assert_close(pmf.mean(), 5.1416015625, 10);
    assert_close(pmf.mass(), 1.0, 10);
    Ok(())
}

/// src/builder/explodePool.test.ts:66
#[test]
fn a_degenerate_one_sided_die_pool_does_not_throw_and_is_deterministic() -> T {
    let r = roll_with(2.0, Some(SidesOrDie::Sides(1.0)), None)?.explode_pool(1.0)?;
    let pmf = r.to_pmf(0.0)?;
    assert_close(pmf.mean(), 3.0, 10);
    assert_close(pmf.mass(), 1.0, 12);
    assert_eq!(support_of(&r)?, vec![3.0]);
    Ok(())
}

/// src/builder/explodePool.test.ts:73
#[test]
fn minimum_collapsing_every_face_onto_the_max_does_not_throw() -> T {
    let r = pool(2.0)?.minimum(8.0)?.explode_pool(1.0)?;
    let pmf = r.to_pmf(0.0)?;
    assert_close(pmf.mean(), 24.0, 10);
    assert_close(pmf.mass(), 1.0, 12);
    assert_eq!(support_of(&r)?, vec![24.0]);
    Ok(())
}

/// tests/attack-channels.test.ts:184
#[test]
fn r23_conflicting_reroll_damage_numbers_on_the_roll_builder_chain() -> T {
    let two_d6 = || roll_with(2.0, Some(SidesOrDie::Die(d6())), None);
    assert_close(
        two_d6()?.reroll(1.0)?.reroll(3.0)?.to_pmf(0.0)?.mean(),
        8.5,
        4,
    );
    assert_close(
        two_d6()?.reroll(3.0)?.reroll(1.0)?.to_pmf(0.0)?.mean(),
        7.8333,
        4,
    );
    Ok(())
}

/// tests/save-string-labels.test.ts:25 (parse-only part: the builder label comparison is deferred).
#[test]
fn parsed_save_3d6_labels_fail_as_save_fail() -> T {
    let pmf = parse_with("(d20 + 5 DC 15) * (3d6)", 0.0)?;
    assert_close(pmf.outcome_probability("saveFail"), 9.0 / 20.0, 12);
    assert_close(pmf.outcome_probability("missNone"), 11.0 / 20.0, 12);
    assert_eq!(pmf.outcome_probability("hit"), 0.0);
    Ok(())
}

/// tests/save-string-labels.test.ts:33 (parse-only part: the builder label comparison is deferred).
#[test]
fn a_failed_save_whose_payload_rolls_0_is_still_save_fail() -> T {
    let pmf = parse_with("(d20 DC 15) * (1d6 - 1)", 0.0)?;
    let zero = pmf.bin_at(0.0).ok_or("no 0 bin")?;
    let get = |l: &str| zero.count.get(l).copied().unwrap_or(0.0);
    assert_close(get("saveFail"), (14.0 / 20.0) * (1.0 / 6.0), 12);
    assert_close(get("missNone"), 6.0 / 20.0, 12);
    Ok(())
}

/// tests/save-string-labels.test.ts:41
#[test]
fn with_save_half_the_0_bin_carries_its_save_fail_share() -> T {
    let pmf = parse_with("(d20 - 1 DC 9) * (3d12 - 4) save half", 0.0)?;
    let zero = pmf.bin_at(0.0).ok_or("no 0 bin")?;
    assert_close(
        zero.count.get("saveFail").copied().unwrap_or(0.0),
        1.0 / 1280.0,
        15,
    );
    let labelled: f64 = zero.count.values().sum();
    assert_close(labelled, zero.p, 15);
    Ok(())
}

/// tests/save-string-labels.test.ts:56
#[test]
fn a_trailing_term_keeps_the_save_s_labels() -> T {
    let pmf = parse_with("(d20 + 5 DC 15) * (3d6) + 2", 0.0)?;
    assert_close(pmf.outcome_probability("saveFail"), 9.0 / 20.0, 12);
    assert_eq!(pmf.filter_outcome("saveFail").min(), 5.0);
    Ok(())
}
