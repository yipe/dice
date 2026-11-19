//! `tests/reroll-up-to-partial.test.ts`: 0 compat calls (no Turn readers); 17 of 19 cases (the 6 `cases` rows are one test), except the two
//! already in `builder/tests/t_crit_misc.rs` (`mod reroll_up_to`): the TS `as an attack's payload, the crit doubles both
//! sides` (line 105) and `a dice-match trigger refuses it rather than guessing` (line 130).
//! Not translated: tests/reroll-up-to-partial.test.ts:5: `RerollUpToRollBuilder` instance check is `is_reroll_up_to()`.

use super::helpers::T;
use super::reroll_oracle::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::roll::{RollBuilder, RollRerollUpToOptions};
use crate::builder::sample::SampledDie;
use crate::common::Rng;
use crate::error::DiceError;
use std::collections::VecDeque;

fn dice(sides: i64, count: usize) -> Vec<Dist> {
    (0..count).map(|_| rule_die(sides, 0, 0, false)).collect()
}

fn rd(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn partial(rolls: f64, once: RollBuilder) -> RollRerollUpToOptions {
    RollRerollUpToOptions {
        rolls: Some(rolls),
        rolled_once: Some(once),
    }
}

/// (name, repeated oracle dice, once oracle dice, repeated roll, once roll, budget, rolls)
struct Case(
    &'static str,
    Vec<Dist>,
    Vec<Dist>,
    RollBuilder,
    RollBuilder,
    usize,
    usize,
);

fn pooled() -> Result<RollBuilder, DiceError> {
    rd(1.0, d8())?.reroll_up_to(1.0, Some(&partial(2.0, rd(1.0, d10())?)))
}

#[track_caller]
fn throws<X>(result: Result<X, DiceError>, pattern: &str) {
    let message = match result {
        Ok(_) => panic!("expected an error matching /{pattern}/"),
        Err(e) => e.to_string(),
    };
    assert!(
        regex::Regex::new(pattern)
            .expect("pattern")
            .is_match(&message),
        "error {message:?} does not match /{pattern}/"
    );
}

fn pmf_of(r: Result<RollBuilder, DiceError>) -> Result<Pmf, DiceError> {
    r?.pmf()
}

#[test]
fn rapier_twice_fire_once_one_piercer_reroll_mean_is_exactly_3_plus_8170_over_640() -> T {
    // 8 x 8 x 10 = 640 equally likely rolls; the d8 kept is the one worth more after the reroll.
    let pmf = pmf_of(
        rd(1.0, d8())?
            .plus(3.0)?
            .reroll_up_to(1.0, Some(&partial(2.0, rd(1.0, d10())?))),
    )?;
    close_to(pmf.mean(), 3.0 + 8170.0 / 640.0);
    expect_dist(
        &pmf,
        &shifted(
            &brute_force_partial_reroll_up_to(&dice(8, 1), &dice(10, 1), 1, 2),
            3,
        ),
    );
    let mut sum = 0.0;
    for a in 1..=8 {
        for b in 1..=8 {
            for r in 1..=10 {
                let score = |w: f64| w + f64::from(r) + 0f64.max(4.5 - w).max(5.5 - f64::from(r));
                let (a, b) = (f64::from(a), f64::from(b));
                let w = if score(a) >= score(b) { a } else { b };
                sum += score(w);
            }
        }
    }
    assert_eq!(sum, 8170.0);
    Ok(())
}

fn close_to(actual: f64, expected: f64) {
    super::helpers::close(actual, expected, 12);
}

#[test]
fn partial_cases_against_the_brute_force() -> T {
    let cases: Vec<Case> = vec![
        Case(
            "2d6 twice, 1d6 once (one kind across both), budget 1",
            dice(6, 2),
            dice(6, 1),
            rd(2.0, d6())?,
            rd(1.0, d6())?,
            1,
            2,
        ),
        Case(
            "1d12 twice, 2d4 + 1d6 once, budget 2",
            dice(12, 1),
            [dice(4, 2), dice(6, 1)].concat(),
            rd(1.0, d12())?,
            rd(2.0, d4())?.plus_roll(&d6())?,
            2,
            2,
        ),
        Case(
            "1d8 three times, 1d10 once, budget 1",
            dice(8, 1),
            dice(10, 1),
            rd(1.0, d8())?,
            rd(1.0, d10())?,
            1,
            3,
        ),
        Case(
            "2d8 twice, 2d10 once (a crit's dice), budget 1",
            dice(8, 2),
            dice(10, 2),
            rd(2.0, d8())?,
            rd(2.0, d10())?,
            1,
            2,
        ),
        Case(
            "1d8 twice, 1d10 once, no budget: the better d8 plus the d10",
            dice(8, 1),
            dice(10, 1),
            rd(1.0, d8())?,
            rd(1.0, d10())?,
            0,
            2,
        ),
        Case(
            "1d6 twice, 1d4 subtracted once, budget 1",
            dice(6, 1),
            vec![rule_die(4, 0, 0, true)],
            rd(1.0, d6())?,
            RollBuilder::new(0.0)?.minus_roll(&d4())?,
            1,
            2,
        ),
    ];
    for Case(_name, repeated, once, repeated_roll, once_roll, budget, rolls) in &cases {
        let got = pmf_of(repeated_roll.reroll_up_to(
            *budget as f64,
            Some(&partial(*rolls as f64, once_roll.clone())),
        ))?;
        expect_dist(
            &got,
            &brute_force_partial_reroll_up_to(repeated, once, *budget, *rolls),
        );
    }
    Ok(())
}

#[test]
fn with_one_roll_it_is_the_plain_pool_of_both() -> T {
    let options = RollRerollUpToOptions {
        rolls: None,
        rolled_once: Some(rd(1.0, d10())?),
    };
    expect_dist(
        &pmf_of(rd(1.0, d8())?.reroll_up_to(1.0, Some(&options)))?,
        &dist_of(&pmf_of(
            rd(1.0, d8())?.plus_roll(&d10())?.reroll_up_to(1.0, None),
        )?),
    );
    Ok(())
}

#[test]
fn with_no_reroll_budget_it_is_the_best_of_the_rolled_twice_dice_plus_the_rest() -> T {
    let got = pmf_of(rd(2.0, d6())?.reroll_up_to(0.0, Some(&partial(2.0, rd(1.0, d10())?))))?;
    let want = rd(2.0, d6())?
        .max_of(2.0)?
        .pmf()?
        .convolve(&rd(1.0, d10())?.pmf()?, None, false);
    expect_dist(&got, &dist_of(&want));
    Ok(())
}

#[test]
fn lies_between_rolling_the_whole_pool_twice_and_the_weapons_best_of_two_with_no_reroll() -> T {
    let partial_mean = pooled()?.pmf()?.mean();
    let whole_twice = RollRerollUpToOptions {
        rolls: Some(2.0),
        rolled_once: None,
    };
    let whole = pmf_of(
        rd(1.0, d8())?
            .plus_roll(&d10())?
            .reroll_up_to(1.0, Some(&whole_twice)),
    )?
    .mean();
    assert!(whole > partial_mean);
    assert!(rd(1.0, d8())?.max_of(2.0)?.plus_roll(&d10())?.pmf()?.mean() < partial_mean);
    Ok(())
}

#[test]
fn flats_on_either_side_never_reroll() -> T {
    let options = partial(2.0, rd(1.0, d10())?.plus(2.0)?);
    expect_dist(
        &pmf_of(rd(1.0, d8())?.plus(3.0)?.reroll_up_to(1.0, Some(&options)))?,
        &shifted(
            &brute_force_partial_reroll_up_to(&dice(8, 1), &dice(10, 1), 1, 2),
            5,
        ),
    );
    Ok(())
}

#[test]
fn doubles_both_sides_dice_on_a_crit_and_keeps_the_budget_and_rolls() -> T {
    let doubled = pooled()?.double_dice()?;
    assert!(doubled.is_reroll_up_to());
    expect_dist(
        &doubled.pmf()?,
        &brute_force_partial_reroll_up_to(&dice(8, 2), &dice(10, 2), 1, 2),
    );
    Ok(())
}

#[test]
fn copy_keeps_the_rolled_once_dice() -> T {
    let pooled = pooled()?;
    expect_dist(&pooled.copy()?.pmf()?, &dist_of(&pooled.pmf()?));
    Ok(())
}

#[test]
fn lists_every_die_of_both_sides_in_its_configs() -> T {
    let sides: Vec<f64> = pooled()?
        .get_sub_roll_configs()
        .iter()
        .map(|c| c.sides)
        .collect();
    assert_eq!(sides, vec![8.0, 10.0]);
    Ok(())
}

#[test]
fn refuses_rolled_once_dice_that_are_not_plain_dice() -> T {
    throws(
        rd(1.0, d8())?.reroll_up_to(1.0, Some(&partial(2.0, d20().with_advantage()?))),
        "plain dice",
    );
    throws(
        rd(1.0, d8())?.reroll_up_to(
            1.0,
            Some(&partial(2.0, rd(1.0, d10())?.reroll_up_to(1.0, None)?)),
        ),
        "rolledOnce",
    );
    Ok(())
}

#[test]
fn to_expression_has_no_spelling() -> T {
    throws(pooled()?.to_expression(), "rerollUpTo");
    Ok(())
}

/// A scripted `Rng`: `die()` pops the next face; running out or asking for a coin is recorded and reported by `done`.
struct Scripted {
    faces: VecDeque<f64>,
    bad: Option<&'static str>,
}

impl Scripted {
    fn done(&self) -> T {
        match self.bad {
            Some(m) => Err(m.into()),
            None => Ok(()),
        }
    }
}

impl Rng for Scripted {
    fn die(&mut self, _sides: f64) -> f64 {
        self.faces.pop_front().unwrap_or_else(|| {
            self.bad = Some("no faces left");
            1.0
        })
    }
    fn chance(&mut self, _p: f64) -> bool {
        self.bad = Some("no coins");
        false
    }
}

#[test]
fn sample_keeps_the_better_d8_roll_then_rerolls_the_die_worth_the_most() -> T {
    // d8 rolls 2 and 6, d10 shows 1. Keep 6 (score 6 + 1 + 4.5 against 2 + 1 + 4.5), reroll the d10: 7.
    let mut rng = Scripted {
        faces: VecDeque::from([2.0, 6.0, 1.0, 7.0]),
        bad: None,
    };
    let sample = pooled()?.sample(&mut rng)?;
    rng.done()?;
    assert_eq!(sample.total, 6.0 + 7.0);
    let die = |sides, face, kept, reroll| SampledDie {
        sides,
        face,
        kept,
        reroll,
        miss_reroll: false,
    };
    assert_eq!(
        sample.dice,
        vec![
            die(8.0, 2.0, false, false),
            die(8.0, 6.0, true, false),
            die(10.0, 1.0, false, false),
            die(10.0, 7.0, true, true)
        ]
    );
    Ok(())
}

/// `seed = (seed * 1103515245 + 12345) % 2147483648` in JS doubles (the product exceeds 2^53 and rounds).
struct JsLcg(f64);

impl Rng for JsLcg {
    fn die(&mut self, n: f64) -> f64 {
        self.0 = (self.0 * 1103515245.0 + 12345.0) % 2147483648.0;
        (self.0 / 2147483648.0 * n).floor() + 1.0
    }
    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

#[test]
fn sample_matches_the_pmfs_mean() -> T {
    let mut rng = JsLcg(7.0);
    let pool = rd(1.0, d8())?
        .plus(3.0)?
        .reroll_up_to(1.0, Some(&partial(2.0, rd(1.0, d10())?)))?;
    let n = 20000;
    let mut sum = 0.0;
    for _ in 0..n {
        sum += pool.sample(&mut rng)?.total;
    }
    assert!((sum / f64::from(n) - (3.0 + 8170.0 / 640.0)).abs() < 0.1);
    Ok(())
}
