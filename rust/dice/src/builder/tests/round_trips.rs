//! `tests/{expression-round-trip,gtest,reroll-pool-order,sample-roll}.test.ts`.
//!
//! Not reproducible in Rust: `reroll-pool-order`'s `clearCaches()` / `setCachingEnabled()` (the port
//! has no PMF or builder cache), so its cold/warm/uncached cases all compare plain resolves.

use super::support::*;
use crate::Damage;
use crate::Pmf;
use crate::builder::ast::resolve;
use crate::builder::factory::*;
use crate::builder::nodes::{
    AddChild, AddNode, DieNode, ExpressionNode, RerollUpToNode, Rounding, Sign, SumNode,
};
use crate::builder::roll::{RollBuilder, RollRerollUpToOptions, sum_rolls};
use crate::common::Rng;
use crate::error::DiceError;
use crate::parser::{parse, parse_with};
use indexmap::IndexMap;
use std::collections::{BTreeMap, VecDeque};

// ---------------------------------------------------------------- expression-round-trip

/// `{ weights, total }`: an exact enumeration with integer weights.
struct Dist {
    weights: BTreeMap<i64, u128>,
    total: u128,
}

fn constant(value: i64) -> Dist {
    Dist {
        weights: BTreeMap::from([(value, 1)]),
        total: 1,
    }
}

/// One die: faces 1..=reroll are rerolled once (second roll kept), then floored at `minimum`.
fn die(sides: i64, reroll: i64, minimum: i64) -> Dist {
    let mut weights = BTreeMap::new();
    let mut bump = |value: i64, weight: u128| {
        *weights.entry(value.max(minimum)).or_insert(0) += weight;
    };
    for first in 1..=sides {
        if first <= reroll {
            for second in 1..=sides {
                bump(second, 1);
            }
        } else {
            bump(first, sides as u128);
        }
    }
    Dist {
        weights,
        total: (sides * sides) as u128,
    }
}

fn plain(sides: i64) -> Dist {
    die(sides, 0, 0)
}

fn combine(a: &Dist, b: &Dist, op: impl Fn(i64, i64) -> i64) -> Dist {
    let mut weights = BTreeMap::new();
    for (x, wx) in &a.weights {
        for (y, wy) in &b.weights {
            *weights.entry(op(*x, *y)).or_insert(0) += wx * wy;
        }
    }
    Dist {
        weights,
        total: a.total * b.total,
    }
}

fn add(parts: &[&Dist]) -> Dist {
    let mut sum = constant(0);
    for part in parts {
        sum = combine(&sum, part, |x, y| x + y);
    }
    sum
}

fn sub(a: &Dist, b: &Dist) -> Dist {
    combine(a, b, |x, y| x - y)
}

fn max(a: &Dist, b: &Dist) -> Dist {
    combine(a, b, i64::max)
}

fn min(a: &Dist, b: &Dist) -> Dist {
    combine(a, b, i64::min)
}

fn repeat(count: usize, a: &Dist) -> Dist {
    add(&vec![a; count])
}

fn map(a: &Dist, f: impl Fn(i64) -> i64) -> Dist {
    combine(a, &constant(0), |x, _| f(x))
}

fn mean(a: &Dist) -> f64 {
    let sum: i128 = a
        .weights
        .iter()
        .map(|(v, w)| i128::from(*v) * *w as i128)
        .sum();
    sum as f64 / a.total as f64
}

fn expect_bins(actual: &Pmf, expected: &Dist, context: &str) {
    let mut support: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.weights.keys());
    for value in support {
        let p = expected.weights.get(&value).copied().unwrap_or(0) as f64 / expected.total as f64;
        let got = actual.p_at(value as f64);
        assert!(
            (got - p).abs() <= 1e-12,
            "{context}: bin {value}: {got} vs {p}"
        );
    }
}

fn expect_round_trip(builder: &RollBuilder, expected: &Dist, exact_mean: f64) -> T {
    assert_close(mean(expected), exact_mean, 12);
    let expression = builder.to_expression()?;
    expect_bins(
        &builder.to_pmf(0.0)?,
        expected,
        &format!("builder {expression}"),
    );
    expect_bins(&parse(&expression)?, expected, &expression);
    Ok(())
}

fn roll_of(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

/// tests/expression-round-trip.test.ts:76
#[test]
fn a_reroll_or_a_minimum_after_a_sum() -> T {
    expect_round_trip(
        &roll_of(1.0, d20())?
            .plus(5.0)?
            .plus_roll(&d8().reroll(1.0)?)?,
        &add(&[&plain(20), &constant(5), &die(8, 1, 0)]),
        327.0 / 16.0,
    )?;
    expect_round_trip(
        &d8().reroll(1.0)?.plus_roll(&d6().minimum(3.0)?)?,
        &add(&[&die(8, 1, 0), &die(6, 0, 3)]),
        143.0 / 16.0,
    )?;
    expect_round_trip(
        &d8().reroll(1.0)?.plus_roll(&d6().reroll(2.0)?)?.plus(3.0)?,
        &add(&[&die(8, 1, 0), &die(6, 2, 0), &constant(3)]),
        581.0 / 48.0,
    )
}

/// tests/expression-round-trip.test.ts:86
#[test]
fn advantage_and_disadvantage_on_a_non_d20_die_alone_or_after_other_dice() -> T {
    expect_round_trip(
        &roll_of(1.0, d6())?.plus_roll(&d4().with_advantage()?)?,
        &add(&[&plain(6), &max(&plain(4), &plain(4))]),
        53.0 / 8.0,
    )?;
    let floored = die(6, 0, 3);
    expect_round_trip(
        &d6().minimum(3.0)?.with_disadvantage()?,
        &min(&floored, &floored),
        61.0 / 18.0,
    )?;
    let rerolled = die(6, 1, 0);
    expect_round_trip(
        &d6().reroll(1.0)?.with_advantage()?,
        &max(&rerolled, &rerolled),
        6161.0 / 1296.0,
    )
}

/// tests/expression-round-trip.test.ts:94
#[test]
fn a_subtracted_die_with_a_minimum_stays_one_die() -> T {
    expect_round_trip(
        &roll_of(1.0, d8())?
            .minimum(2.0)?
            .minus_roll(&d4().minimum(3.0)?)?,
        &sub(&die(8, 0, 2), &die(4, 0, 3)),
        11.0 / 8.0,
    )
}

/// tests/expression-round-trip.test.ts:104
#[test]
fn after_a_negative_flat_or_a_subtracted_die() -> T {
    expect_round_trip(
        &d20().minus(5.0)?.plus_roll(&d4())?,
        &add(&[&plain(20), &constant(-5), &plain(4)]),
        8.0,
    )?;
    expect_round_trip(
        &roll_of(1.0, d8())?.minus_roll(&d6())?.plus_roll(&d4())?,
        &add(&[&sub(&plain(8), &plain(6)), &plain(4)]),
        7.0 / 2.0,
    )
}

/// tests/expression-round-trip.test.ts:111
#[test]
fn after_a_pool_whose_lowest_trial_can_be_0() -> T {
    let trial = add(&[&plain(4), &constant(-1)]);
    expect_round_trip(
        &roll_dice(1.0, 4.0, None)?
            .minus(1.0)?
            .keep_lowest_all(2.0, 1.0)?
            .plus_roll(&d6())?,
        &add(&[&min(&trial, &trial), &plain(6)]),
        35.0 / 8.0,
    )
}

/// tests/expression-round-trip.test.ts:116
#[test]
fn two_keep_highest_groups_are_two_maxima_not_the_max_of_two_sums() -> T {
    let best = max(&plain(6), &plain(6));
    expect_round_trip(
        &d6()
            .keep_highest(2.0, 1.0)?
            .plus_roll(&d6().keep_highest(2.0, 1.0)?)?,
        &add(&[&best, &best]),
        161.0 / 18.0,
    )?;
    let best8 = max(&plain(8), &plain(8));
    expect_round_trip(
        &d8()
            .keep_highest(2.0, 1.0)?
            .plus_roll(&d8().keep_highest(2.0, 1.0)?)?
            .plus_roll(&d8().keep_highest(2.0, 1.0)?)?,
        &add(&[&best8, &best8, &best8]),
        279.0 / 16.0,
    )?;
    let worst = min(&plain(6), &plain(6));
    expect_round_trip(
        &d6()
            .keep_lowest(2.0, 1.0)?
            .plus_roll(&d6().keep_lowest(2.0, 1.0)?)?,
        &add(&[&worst, &worst]),
        91.0 / 18.0,
    )
}

/// tests/expression-round-trip.test.ts:131
#[test]
fn two_advantage_groups_are_two_advantage_rolls() -> T {
    let best = max(&plain(6), &plain(6));
    expect_round_trip(
        &d6().with_advantage()?.plus_roll(&d6().with_advantage()?)?,
        &add(&[&best, &best]),
        161.0 / 18.0,
    )
}

/// tests/expression-round-trip.test.ts:136
#[test]
fn a_halved_or_scaled_part_beside_plain_parts() -> T {
    let half = |v: i64| v.div_euclid(2);
    expect_round_trip(
        &sum_rolls(&[d8().plus(3.0)?, d6().half()?])?,
        &add(&[&plain(8), &constant(3), &map(&plain(6), half)]),
        9.0,
    )?;
    expect_round_trip(
        &sum_rolls(&[d6().half()?, d8()])?,
        &add(&[&map(&plain(6), half), &plain(8)]),
        6.0,
    )?;
    expect_round_trip(
        &sum_rolls(&[d8(), d6().scale_result(2.0, 1.0, Rounding::Floor)?])?,
        &add(&[&plain(8), &map(&plain(6), |v| 2 * v)]),
        23.0 / 2.0,
    )?;
    expect_round_trip(
        &sum_rolls(&[
            roll_of(2.0, d6())?.plus(3.0)?,
            roll_of(2.0, d8())?.scale_result(1.0, 2.0, Rounding::Floor)?,
        ])?,
        &add(&[
            &repeat(2, &plain(6)),
            &constant(3),
            &map(&repeat(2, &plain(8)), half),
        ]),
        57.0 / 4.0,
    )
}

/// tests/expression-round-trip.test.ts:153
#[test]
fn parses_the_grammar_has_no_unary_minus() -> T {
    expect_round_trip(
        &roll_of(1.0, d6())?.minus_roll(&d8())?,
        &sub(&plain(6), &plain(8)),
        -1.0,
    )?;
    expect_round_trip(&flat(-3.0)?, &constant(-3), -3.0)?;
    expect_round_trip(
        &flat(5.0)?.minus_roll(&d8())?,
        &sub(&constant(5), &plain(8)),
        0.5,
    )?;
    expect_round_trip(
        &flat(0.0)?.minus_roll(&d8())?.minus_roll(&d6())?,
        &sub(&sub(&constant(0), &plain(8)), &plain(6)),
        -8.0,
    )
}

/// tests/expression-round-trip.test.ts:162
#[test]
fn an_exploding_die_can_be_pooled_and_printing_it_throws_the_explode_refusal() -> T {
    let exploding = combine(&plain(8), &plain(8), |x, y| if x == 8 { 8 + y } else { x });
    let pool = roll_of(1.0, d8())?
        .explode(1.0)?
        .keep_highest_all(2.0, 1.0)?;
    expect_bins(&pool.to_pmf(0.0)?, &max(&exploding, &exploding), "pool");
    assert_throws(pool.to_expression(), "cannot represent an exploding die");
    let worst = roll_of(1.0, d8())?
        .explode(1.0)?
        .keep_lowest_all(2.0, 1.0)?
        .times(2.0)?;
    expect_bins(
        &worst.to_pmf(0.0)?,
        &repeat(2, &min(&exploding, &exploding)),
        "times",
    );
    assert_throws(worst.to_expression(), "cannot represent an exploding die");
    Ok(())
}

/// tests/expression-round-trip.test.ts:171
#[test]
fn doubling_an_exploding_die_with_no_single_doubled_meaning_still_names_the_ambiguity() -> T {
    let e = error_of(
        roll_of(1.0, d8())?
            .explode(1.0)?
            .with_advantage()?
            .double_dice(),
    );
    assert!(
        matches!(e, crate::error::DiceError::AmbiguousCritDoubling(_)),
        "{e}"
    );
    Ok(())
}

/// tests/expression-round-trip.test.ts:175
#[test]
fn a_pool_of_zero_trials_prints_0() -> T {
    expect_round_trip(
        &roll_of(2.0, d6())?.keep_highest_all(2.0, 1.0)?.times(0.0)?,
        &constant(0),
        0.0,
    )
}

/// tests/expression-round-trip.test.ts:182
#[test]
fn re_parses_to_the_max_of_independent_rolls() -> T {
    let sum2d6 = repeat(2, &plain(6));
    expect_round_trip(
        &roll_of(2.0, d6())?.max_of(2.0)?,
        &max(&sum2d6, &sum2d6),
        5425.0 / 648.0,
    )?;
    let with_flat = add(&[&sum2d6, &constant(3)]);
    expect_bins(
        &parse_with(
            &roll_of(2.0, d6())?
                .plus(3.0)?
                .max_of(3.0)?
                .to_expression()?,
            0.0,
        )?,
        &max(&max(&with_flat, &with_flat), &with_flat),
        "maxOf 3",
    );
    Ok(())
}

// ---------------------------------------------------------------- gtest

/// tests/helpers/lcg.ts `lcgRng` (mulberry32).
struct Lcg {
    s: u32,
}

impl Lcg {
    fn new(seed: u32) -> Self {
        Lcg { s: seed }
    }

    fn next(&mut self) -> u32 {
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
}

impl Rng for Lcg {
    fn die(&mut self, sides: f64) -> f64 {
        let sides = sides as u64;
        let limit = 4_294_967_296 - (4_294_967_296 % sides);
        let mut x = u64::from(self.next());
        while x >= limit {
            x = u64::from(self.next());
        }
        (x % sides) as f64 + 1.0
    }

    fn chance(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        let a = self.next();
        let b = self.next();
        (f64::from(a >> 5) * 67_108_864.0 + f64::from(b >> 6)) / 9_007_199_254_740_992.0 < p
    }
}

fn lgamma(z: f64) -> f64 {
    let c = [
        76.180_091_729_471_46,
        -86.505_320_329_416_77,
        24.014_098_240_830_91,
        -1.231_739_572_450_155,
        0.001_208_650_973_866_179,
        -0.000_005_395_239_384_953,
    ];
    let mut y = z;
    let mut t = z + 5.5;
    t -= (z + 0.5) * t.ln();
    let mut s = 1.000_000_000_190_015;
    for k in c {
        y += 1.0;
        s += k / y;
    }
    -t + (2.506_628_274_631_000_5 * s / z).ln()
}

/// tests/helpers/gtest.ts `gammaQ`.
fn gamma_q(a: f64, x: f64) -> f64 {
    if x < a + 1.0 {
        let mut sum = 1.0 / a;
        let mut del = sum;
        let mut ap = a;
        for _ in 0..500 {
            ap += 1.0;
            del *= x / ap;
            sum += del;
            if del.abs() < sum.abs() * 1e-14 {
                break;
            }
        }
        return 1.0 - sum * (-x + a * x.ln() - lgamma(a)).exp();
    }
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / 1e-300;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..500 {
        let i = f64::from(i);
        let an = -i * (i - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < 1e-300 {
            d = 1e-300;
        }
        c = b + an / c;
        if c.abs() < 1e-300 {
            c = 1e-300;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-14 {
            break;
        }
    }
    (-x + a * x.ln() - lgamma(a)).exp() * h
}

struct GTest {
    g: f64,
    df: f64,
    p: f64,
}

/// tests/helpers/gtest.ts `gTest`.
fn g_test(observed: &BTreeMap<i64, f64>, expected: &Pmf, n: f64) -> Result<GTest, DiceError> {
    let total: f64 = observed.values().sum();
    if total != n {
        return Err(DiceError::error(format!(
            "gTest: n ({n}) must equal the observed total ({total})"
        )));
    }
    let mut values: Vec<i64> = expected.support().iter().map(|d| d.0 as i64).collect();
    values.extend(observed.keys());
    values.sort_unstable();
    values.dedup();
    let mut bins: Vec<(f64, f64)> = Vec::new();
    let mut acc = (0.0, 0.0);
    for v in &values {
        let o = observed.get(v).copied().unwrap_or(0.0);
        let p = expected.p_at(*v as f64);
        if o > 0.0 && p == 0.0 {
            return Ok(GTest {
                g: f64::INFINITY,
                df: (values.len() as f64 - 1.0).max(1.0),
                p: 0.0,
            });
        }
        acc.0 += o;
        acc.1 += p * n;
        if acc.1 >= 5.0 {
            bins.push(acc);
            acc = (0.0, 0.0);
        }
    }
    if acc.1 > 0.0 || acc.0 > 0.0 {
        match bins.last_mut() {
            Some(last) => {
                last.0 += acc.0;
                last.1 += acc.1;
            }
            None => bins.push(acc),
        }
    }
    let mut g = 0.0;
    for (o, e) in &bins {
        if *o > 0.0 {
            g += 2.0 * o * (o / e).ln();
        }
    }
    let df = (bins.len() as f64 - 1.0).max(1.0);
    Ok(GTest {
        g,
        df,
        p: gamma_q(df / 2.0, g / 2.0),
    })
}

fn chi_sq_even(df: f64, x: f64) -> f64 {
    let mut term = 1.0;
    let mut sum = 1.0;
    let mut i = 1.0;
    while i < df / 2.0 {
        term *= x / 2.0 / i;
        sum += term;
        i += 1.0;
    }
    (-x / 2.0).exp() * sum
}

fn pmf_from(pairs: &[(f64, f64)]) -> Result<Pmf, DiceError> {
    let m: IndexMap<Damage, f64> = pairs.iter().map(|(v, p)| (Damage(*v), *p)).collect();
    Pmf::from_map(m, 0.0, false)
}

fn fair_die() -> Result<Pmf, DiceError> {
    pmf_from(
        &(1..=6)
            .map(|i| (f64::from(i), 1.0 / 6.0))
            .collect::<Vec<_>>(),
    )
}

fn counts(pairs: &[(i64, f64)]) -> BTreeMap<i64, f64> {
    pairs.iter().copied().collect()
}

fn bump(counts: &mut BTreeMap<i64, f64>, key: i64) {
    *counts.entry(key).or_insert(0.0) += 1.0;
}

/// tests/gtest.test.ts:18
#[test]
fn matches_the_closed_form_chi_square_survival_for_even_df() {
    for (df, x) in [
        (2.0, 2.0),
        (2.0, 5.991465),
        (4.0, 4.0),
        (4.0, 9.487729),
        (10.0, 18.307038),
        (30.0, 43.772972),
    ] {
        assert_close(gamma_q(df / 2.0, x / 2.0), chi_sq_even(df, x), 10);
    }
}

/// tests/gtest.test.ts:30
#[test]
fn matches_tabulated_chi_square_critical_values_for_odd_df() {
    assert_close(gamma_q(0.5, 3.841459 / 2.0), 0.05, 6);
    assert_close(gamma_q(0.5, 6.634897 / 2.0), 0.01, 6);
    assert_close(gamma_q(1.5, 7.814728 / 2.0), 0.05, 6);
    assert_close(gamma_q(2.5, 15.086272 / 2.0), 0.01, 6);
}

/// tests/gtest.test.ts:36
#[test]
fn covers_both_the_series_and_continued_fraction_branches_at_the_boundary() {
    assert_eq!(gamma_q(0.5, 0.0), 1.0);
    assert_close(gamma_q(3.0, 3.9), chi_sq_even(6.0, 7.8), 10);
    assert_close(gamma_q(3.0, 4.1), chi_sq_even(6.0, 8.2), 10);
}

/// tests/gtest.test.ts:45
#[test]
fn accepts_a_fair_die_sampled_fairly() -> T {
    let mut rng = Lcg::new(5);
    let mut c = BTreeMap::new();
    for _ in 0..60000 {
        bump(&mut c, rng.die(6.0) as i64);
    }
    assert!(g_test(&c, &fair_die()?, 60000.0)?.p > 1e-3);
    Ok(())
}

/// tests/gtest.test.ts:54
#[test]
fn rejects_a_loaded_die() -> T {
    let c = counts(&[
        (1, 5000.0),
        (2, 5000.0),
        (3, 5000.0),
        (4, 5000.0),
        (5, 5000.0),
        (6, 35000.0),
    ]);
    assert!(g_test(&c, &fair_die()?, 60000.0)?.p < 1e-12);
    Ok(())
}

/// tests/gtest.test.ts:70
#[test]
fn pools_bins_with_expected_count_under_5() -> T {
    let spiky = pmf_from(&[(0.0, 0.9999), (100.0, 0.0001)])?;
    assert_eq!(g_test(&counts(&[(0, 1000.0)]), &spiky, 1000.0)?.df, 1.0);
    Ok(())
}

/// tests/gtest.test.ts:74
#[test]
fn returns_p_0_for_an_observed_value_the_pmf_gives_no_mass_even_one_draw() -> T {
    let observed = counts(&[
        (1, 9999.0),
        (2, 9999.0),
        (3, 10000.0),
        (4, 10000.0),
        (5, 10000.0),
        (6, 10000.0),
        (7, 2.0),
    ]);
    let r = g_test(&observed, &fair_die()?, 60000.0)?;
    assert_eq!(r.p, 0.0);
    assert_eq!(r.g, f64::INFINITY);
    Ok(())
}

/// tests/gtest.test.ts:80
#[test]
fn throws_when_n_is_not_the_observed_total() -> T {
    assert_throws(
        g_test(&counts(&[(1, 10.0)]), &fair_die()?, 11.0),
        "observed total",
    );
    Ok(())
}

/// tests/gtest.test.ts:86
#[test]
fn two_d20_keep_highest_over_200k_draws_passes_the_g_test_against_the_exact_pmf() -> T {
    let mut rng = Lcg::new(11);
    let mut c = BTreeMap::new();
    let n = 200000;
    for _ in 0..n {
        let f = rng.die(20.0).max(rng.die(20.0));
        bump(&mut c, f as i64);
    }
    assert!(g_test(&c, &d20().with_advantage()?.pmf()?, f64::from(n))?.p > 1e-3);
    Ok(())
}

/// tests/gtest.test.ts:96
#[test]
fn chance_p_is_a_fair_coin_at_p_over_100k_draws() -> T {
    let mut rng = Lcg::new(3);
    let mut c = counts(&[(0, 0.0), (1, 0.0)]);
    let n = 100000;
    for _ in 0..n {
        bump(&mut c, i64::from(rng.chance(0.3)));
    }
    let expected = pmf_from(&[(0.0, 0.7), (1.0, 0.3)])?;
    assert!(g_test(&c, &expected, f64::from(n))?.p > 1e-3);
    Ok(())
}

// ---------------------------------------------------------------- reroll-pool-order

fn dice_node(count: f64, sides: f64, reroll: f64) -> ExpressionNode {
    ExpressionNode::Sum(SumNode {
        count,
        child: Box::new(ExpressionNode::Die(DieNode {
            sides,
            reroll: if reroll != 0.0 { Some(reroll) } else { None },
            minimum: None,
            explode: None,
        })),
        explode_pool_budget: None,
    })
}

fn permutations<X: Clone>(items: &[X]) -> Vec<Vec<X>> {
    if items.len() <= 1 {
        return vec![items.to_vec()];
    }
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let mut rest = items.to_vec();
        rest.remove(i);
        for mut perm in permutations(&rest) {
            perm.insert(0, item.clone());
            out.push(perm);
        }
    }
    out
}

fn sum_of(nodes: &[ExpressionNode]) -> ExpressionNode {
    ExpressionNode::Add(AddNode {
        children: nodes
            .iter()
            .map(|node| AddChild {
                node: node.clone(),
                sign: Sign::Plus,
            })
            .collect(),
    })
}

fn pool_of(twice: &[ExpressionNode], once: &[ExpressionNode]) -> ExpressionNode {
    ExpressionNode::RerollUpTo(RerollUpToNode {
        budget: 1.0,
        rolls: 2.0,
        child: Box::new(sum_of(twice)),
        rolled_once: Some(Box::new(sum_of(once))),
    })
}

type Order = (Vec<ExpressionNode>, Vec<ExpressionNode>);

fn orders() -> Vec<Order> {
    let once = vec![
        dice_node(2.0, 4.0, 0.0),
        dice_node(2.0, 6.0, 0.0),
        dice_node(2.0, 8.0, 0.0),
        dice_node(8.0, 8.0, 0.0),
    ];
    let twice = vec![dice_node(3.0, 8.0, 0.0), dice_node(1.0, 6.0, 1.0)];
    let mut out: Vec<Order> = permutations(&once)
        .into_iter()
        .map(|o| (twice.clone(), o))
        .collect();
    out.extend(permutations(&twice).into_iter().map(|t| (t, once.clone())));
    out
}

fn bits(order: &Order) -> Result<String, DiceError> {
    Ok(resolve(&pool_of(&order.0, &order.1), 0.0)?.fingerprint())
}

/// tests/reroll-pool-order.test.ts:50 (no caches to clear in the port)
#[test]
fn cold_each_order_alone_caches_cleared_before_each() -> T {
    let all = orders();
    let reference = bits(&all[0])?;
    for order in &all {
        assert_eq!(bits(order)?, reference);
    }
    Ok(())
}

/// tests/reroll-pool-order.test.ts:58 (no caches in the port: resolves each order alone, then again after another)
#[test]
fn warm_an_order_resolved_after_another_is_cached_returns_the_bits_it_would_have_computed_cold() -> T
{
    let all = orders();
    let mut cold = Vec::new();
    for (i, order) in all.iter().enumerate() {
        if i % 5 == 0 {
            cold.push((order, bits(order)?));
        }
    }
    for (first, _) in &cold {
        bits(first)?;
        for (second, expected) in &cold {
            assert_eq!(&bits(second)?, expected);
        }
    }
    Ok(())
}

/// tests/reroll-pool-order.test.ts:68 (the port has no cache to disable)
#[test]
fn uncached_with_caching_off_every_order_computes_the_same_bits() -> T {
    let all = orders();
    let reference = bits(&all[0])?;
    for order in &all {
        assert_eq!(bits(order)?, reference);
    }
    Ok(())
}

// ---------------------------------------------------------------- sample-roll

/// Rng whose `die()` answers come from a queue; a bad script entry is recorded and fails `done()`.
struct Script {
    faces: VecDeque<f64>,
    bad: Option<String>,
}

fn dice(faces: &[f64]) -> Script {
    Script {
        faces: faces.iter().copied().collect(),
        bad: None,
    }
}

impl Script {
    fn done(&self) -> T {
        match &self.bad {
            Some(m) => Err(m.clone().into()),
            None => Ok(()),
        }
    }
}

impl Rng for Script {
    fn die(&mut self, sides: f64) -> f64 {
        match self.faces.pop_front() {
            Some(f) if f <= sides => f,
            other => {
                self.bad = Some(format!("bad script {other:?} for d{sides}"));
                1.0
            }
        }
    }

    fn chance(&mut self, _p: f64) -> bool {
        self.bad = Some("chance() not expected".to_string());
        false
    }
}

fn sampled(
    r: &RollBuilder,
    faces: &[f64],
) -> Result<crate::builder::sample::RollSample, DiceError> {
    let mut rng = dice(faces);
    let s = r.sample(&mut rng)?;
    rng.done()?;
    Ok(s)
}

/// `{ sides, face, kept }` plus the optional `reroll` flag.
fn die_of(sides: f64, face: f64, kept: bool, reroll: bool) -> crate::builder::sample::SampledDie {
    crate::builder::sample::SampledDie {
        sides,
        face,
        kept,
        reroll,
        miss_reroll: false,
    }
}

fn kept_flags(s: &crate::builder::sample::RollSample) -> Vec<bool> {
    s.dice.iter().map(|x| x.kept).collect()
}

fn faces_of(s: &crate::builder::sample::RollSample) -> Vec<f64> {
    s.dice.iter().map(|x| x.face).collect()
}

/// tests/sample-roll.test.ts:19
#[test]
fn sums_dice_and_flats() -> T {
    let s = sampled(&roll_dice(2.0, 6.0, Some(3.0))?, &[4.0, 5.0])?;
    assert_eq!(s.total, 12.0);
    assert_eq!(
        s.dice,
        vec![die_of(6.0, 4.0, true, false), die_of(6.0, 5.0, true, false)]
    );
    Ok(())
}

/// tests/sample-roll.test.ts:27
#[test]
fn rerolls_faces_at_or_below_the_threshold_once_and_keeps_the_new_roll() -> T {
    let s = sampled(&d(6.0)?.reroll(2.0)?, &[1.0, 2.0])?;
    assert_eq!(s.total, 2.0);
    assert_eq!(
        s.dice,
        vec![die_of(6.0, 1.0, false, false), die_of(6.0, 2.0, true, true)]
    );
    Ok(())
}

/// tests/sample-roll.test.ts:35
#[test]
fn applies_minimum_after_the_reroll() -> T {
    assert_eq!(sampled(&d(6.0)?.minimum(3.0)?, &[1.0])?.total, 3.0);
    Ok(())
}

/// tests/sample-roll.test.ts:38
#[test]
fn explodes_on_the_max_face_up_to_the_cap() -> T {
    let s = sampled(&d(6.0)?.explode(2.0)?, &[6.0, 6.0, 6.0])?;
    assert_eq!(s.total, 18.0);
    assert_eq!(s.dice.len(), 3);
    Ok(())
}

/// tests/sample-roll.test.ts:43
#[test]
fn keeps_the_highest_of_advantage_d20s_and_marks_the_dropped_one() -> T {
    let s = sampled(&roll_dice(1.0, 20.0, None)?.with_advantage()?, &[7.0, 15.0])?;
    assert_eq!(s.total, 15.0);
    assert_eq!(kept_flags(&s), vec![false, true]);
    Ok(())
}

/// tests/sample-roll.test.ts:48
#[test]
fn keep_highest_keeps_k_of_n() -> T {
    let s = sampled(
        &roll_dice(4.0, 6.0, None)?.keep_highest(4.0, 3.0)?,
        &[1.0, 6.0, 3.0, 5.0],
    )?;
    assert_eq!(s.total, 14.0);
    assert_eq!(
        s.dice.iter().find(|x| x.face == 1.0).map(|x| x.kept),
        Some(false)
    );
    Ok(())
}

/// tests/sample-roll.test.ts:53
#[test]
fn reroll_up_to_rerolls_the_dice_with_the_largest_positive_expected_gain() -> T {
    let s = sampled(
        &roll_dice(2.0, 6.0, None)?.reroll_up_to(1.0, None)?,
        &[1.0, 4.0, 5.0],
    )?;
    assert_eq!(s.total, 9.0);
    assert_eq!(s.dice.iter().filter(|x| x.kept).count(), 2);
    Ok(())
}

/// tests/sample-roll.test.ts:59
#[test]
fn reroll_up_to_with_rolls_keeps_the_roll_worth_more_after_its_own_rerolls() -> T {
    let options = RollRerollUpToOptions {
        rolls: Some(2.0),
        ..Default::default()
    };
    let s = sampled(
        &roll_dice(2.0, 6.0, None)?.reroll_up_to(1.0, Some(&options))?,
        &[1.0, 4.0, 2.0, 2.0, 6.0],
    )?;
    assert_eq!(s.total, 10.0);
    Ok(())
}

/// tests/sample-roll.test.ts:64
#[test]
fn explode_pool_spends_one_budget_per_max_face_shown_chaining_new_max_faces() -> T {
    let s = sampled(
        &roll_dice(3.0, 6.0, None)?.explode_pool(2.0)?,
        &[6.0, 2.0, 6.0, 6.0, 3.0],
    )?;
    assert_eq!(s.total, 23.0);
    assert_eq!(faces_of(&s), vec![6.0, 2.0, 6.0, 6.0, 3.0]);
    Ok(())
}

/// tests/sample-roll.test.ts:70
#[test]
fn explode_pool_chains_one_max_face_its_extra_shows_max_again_the_next_spends_the_last_budget() -> T
{
    let s = sampled(
        &roll_dice(3.0, 6.0, None)?.explode_pool(2.0)?,
        &[6.0, 2.0, 2.0, 6.0, 4.0],
    )?;
    assert_eq!(s.total, 20.0);
    assert_eq!(faces_of(&s), vec![6.0, 2.0, 2.0, 6.0, 4.0]);
    Ok(())
}

/// tests/sample-roll.test.ts:76
#[test]
fn reroll_up_to_draws_and_lists_dice_in_source_order_not_mean_order() -> T {
    let r = roll_dice(2.0, 6.0, None)?
        .plus_dice(1.0, &d(8.0)?)?
        .reroll_up_to(1.0, None)?;
    let s = sampled(&r, &[1.0, 4.0, 2.0, 7.0])?;
    let sides: Vec<f64> = s.dice.iter().map(|x| x.sides).collect();
    assert_eq!(sides, vec![6.0, 6.0, 8.0, 8.0]);
    assert_eq!(kept_flags(&s), vec![true, true, false, true]);
    assert_eq!(s.total, 12.0);
    Ok(())
}

/// tests/sample-roll.test.ts:83
#[test]
fn half_floors_the_childs_total_and_keeps_its_dice() -> T {
    let s = sampled(&roll_dice(2.0, 8.0, None)?.half()?, &[3.0, 4.0])?;
    assert_eq!(s.total, 3.0);
    assert_eq!(s.dice.len(), 2);
    Ok(())
}

/// Rng that fails the test if `die()` is used; `chance()` is true.
struct NoDice {
    used: bool,
}

impl Rng for NoDice {
    fn die(&mut self, _sides: f64) -> f64 {
        self.used = true;
        1.0
    }

    fn chance(&mut self, _p: f64) -> bool {
        true
    }
}

/// tests/sample-roll.test.ts:88
#[test]
fn a_parsed_string_draws_from_its_pmf_with_no_dice() -> T {
    let mut rng = NoDice { used: false };
    let s = d_expression("2d6+1")?.sample(&mut rng)?;
    assert!(!rng.used, "die() not expected");
    assert_eq!(s.total, 3.0);
    assert!(s.dice.is_empty());
    Ok(())
}

/// Seeded LCG of the TS test: `st = imul(st, 1664525) + 1013904223 >>> 0`; `chance()` is false.
struct SeededLcg {
    st: u32,
}

impl Rng for SeededLcg {
    fn die(&mut self, n: f64) -> f64 {
        self.st = self.st.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.st % n as u32) + 1.0
    }

    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

/// tests/sample-roll.test.ts:94
#[test]
fn matches_the_pmf_mean_over_many_seeded_draws() -> T {
    let mut rng = SeededLcg { st: 7 };
    let b = roll_dice(3.0, 8.0, None)?
        .reroll(1.0)?
        .minimum(2.0)?
        .plus(2.0)?;
    let n = 40000;
    let mut sum = 0.0;
    for _ in 0..n {
        sum += b.sample(&mut rng)?.total;
    }
    assert_close(sum / f64::from(n), b.pmf()?.mean(), 0);
    Ok(())
}
