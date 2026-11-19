//! Translated TS tests: explode-cap, add-term-order, builder-cache-keys, zero-count-dice,
//! transform-arithmetic, repeated-roll-groups, subtracted-groups, per-die-roll-type,
//! per-die-keep-shapes.

use super::support::*;
use crate::Pmf;
use crate::builder::ast::resolve;
use crate::builder::factory::*;
use crate::builder::nodes::{
    AddChild, AddNode, ConstantNode, DieNode, ExpressionNode, Rounding, Sign, SumNode,
};
use crate::builder::roll::{RollBuilder, sum_rolls};
use crate::builder::types::{KeepMode, KeepSpec, RollConfigPatch};
use crate::error::DiceError;

// ---- tests/enumerate-dice.ts helpers -------------------------------------------------------

type Dist = Vec<(f64, f64)>;

fn add_to(out: &mut Dist, v: f64, p: f64) {
    match out.iter_mut().find(|(k, _)| *k == v) {
        Some(e) => e.1 += p,
        None => out.push((v, p)),
    }
}

fn point(v: f64) -> Dist {
    vec![(v, 1.0)]
}

fn uniform(sides: u32) -> Dist {
    (1..=sides)
        .map(|f| (f64::from(f), 1.0 / f64::from(sides)))
        .collect()
}

fn combine(x: &Dist, y: &Dist, f: impl Fn(f64, f64) -> f64) -> Dist {
    let mut out = Dist::new();
    for &(a, pa) in x {
        for &(b, pb) in y {
            add_to(&mut out, f(a, b), pa * pb);
        }
    }
    out
}

fn add(parts: &[&Dist]) -> Dist {
    parts
        .iter()
        .fold(point(0.0), |acc, part| combine(&acc, part, |a, b| a + b))
}

fn repeat(x: &Dist, times: usize) -> Dist {
    let mut acc = point(0.0);
    for _ in 0..times {
        acc = combine(&acc, x, |a, b| a + b);
    }
    acc
}

fn map(x: &Dist, f: impl Fn(f64) -> f64) -> Dist {
    let mut out = Dist::new();
    for &(v, p) in x {
        add_to(&mut out, f(v), p);
    }
    out
}

fn negate(x: &Dist) -> Dist {
    map(x, |v| -v)
}

fn shift(x: &Dist, by: f64) -> Dist {
    map(x, |v| v + by)
}

fn max(parts: &[&Dist]) -> Dist {
    let mut acc = parts[0].clone();
    for part in &parts[1..] {
        acc = combine(&acc, part, f64::max);
    }
    acc
}

fn min(parts: &[&Dist]) -> Dist {
    let mut acc = parts[0].clone();
    for part in &parts[1..] {
        acc = combine(&acc, part, f64::min);
    }
    acc
}

fn keep(x: &Dist, total: usize, keep_count: usize, highest: bool) -> Dist {
    let mut tuples: Vec<(Vec<f64>, f64)> = vec![(vec![], 1.0)];
    for _ in 0..total {
        let mut next = Vec::new();
        for (values, p) in &tuples {
            for &(v, pv) in x {
                let mut vs = values.clone();
                vs.push(v);
                next.push((vs, p * pv));
            }
        }
        tuples = next;
    }
    let mut out = Dist::new();
    for (mut values, p) in tuples {
        values.sort_by(|a, b| {
            let o = a.total_cmp(b);
            if highest { o.reverse() } else { o }
        });
        let sum: f64 = values.iter().take(keep_count).sum();
        add_to(&mut out, sum, p);
    }
    out
}

#[track_caller]
fn expect_dist(actual: &Pmf, expected: &Dist) {
    let mut support: Vec<f64> = actual.support().iter().map(|d| d.0).collect();
    for &(v, _) in expected {
        if !support.contains(&v) {
            support.push(v);
        }
    }
    for v in support {
        let e = expected.iter().find(|(k, _)| *k == v).map_or(0.0, |x| x.1);
        let a = actual.p_at(v);
        assert!((a - e).abs() <= 1e-12, "bin {v}: {a} vs {e}");
    }
    assert!(
        (actual.mass() - 1.0).abs() <= 1e-12,
        "mass {}",
        actual.mass()
    );
}

// ---- shorthands -----------------------------------------------------------------------------

fn rd(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn rs(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Sides(sides)), None)
}

fn pmf(r: &RollBuilder) -> Result<Pmf, DiceError> {
    r.to_pmf(0.0)
}

// ---- explode-cap.test.ts (4 translated; 1 untranslatable) ------------------------------------
// explode-cap.test.ts:7 "refuses a call with no cap": the cap is a required Rust argument; cannot be omitted.

/// tests/explode-cap.test.ts:12
#[test]
fn refuses_explode_infinity() -> T {
    for cap in [f64::INFINITY, f64::NEG_INFINITY] {
        assert_throws(d8().explode(cap), "finite");
    }
    Ok(())
}

/// tests/explode-cap.test.ts:16
#[test]
fn refuses_a_hand_built_config_carrying_a_non_finite_explode() -> T {
    let r = RollBuilder::from_config(&RollConfigPatch {
        sides: Some(6.0),
        explode: Some(f64::INFINITY),
        ..Default::default()
    });
    assert_throws(r.to_pmf(0.0), "finite");
    Ok(())
}

/// tests/explode-cap.test.ts:22
#[test]
fn d6_minimum_6_explode_k_always_explodes_k_times() -> T {
    expect_dist(&pmf(&d6().minimum(6.0)?.explode(1.0)?)?, &point(12.0));
    expect_dist(&pmf(&d6().minimum(6.0)?.explode(2.0)?)?, &point(18.0));
    expect_dist(
        &pmf(&rd(2.0, d6())?.minimum(6.0)?.explode(3.0)?)?,
        &point(48.0),
    );
    Ok(())
}

/// tests/explode-cap.test.ts:28
#[test]
fn a_one_sided_die_explodes_every_time() -> T {
    expect_dist(&pmf(&rs(1.0, 1.0)?.explode(3.0)?)?, &point(4.0));
    Ok(())
}

/// tests/explode-cap.test.ts:32
#[test]
fn a_floor_above_the_highest_face_never_explodes() -> T {
    expect_dist(&pmf(&d6().minimum(7.0)?.explode(2.0)?)?, &point(7.0));
    Ok(())
}

// ---- add-term-order.test.ts (2 translated) ---------------------------------------------------
// The Rust port has no PMF/builder caches, so there is nothing to clear: each resolve is cold.

fn pool(count: f64, sides: f64, reroll: Option<f64>) -> ExpressionNode {
    ExpressionNode::Sum(SumNode {
        count,
        child: Box::new(ExpressionNode::Die(DieNode {
            sides,
            reroll: reroll.filter(|r| *r != 0.0),
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
    for i in 0..items.len() {
        let mut rest = items.to_vec();
        let item = rest.remove(i);
        for mut p in permutations(&rest) {
            p.insert(0, item.clone());
            out.push(p);
        }
    }
    out
}

fn sum_of(nodes: &[ExpressionNode]) -> ExpressionNode {
    let mut children: Vec<AddChild> = nodes
        .iter()
        .map(|n| AddChild {
            node: n.clone(),
            sign: Sign::Plus,
        })
        .collect();
    children.push(AddChild {
        node: ExpressionNode::Constant(ConstantNode { value: 5.0 }),
        sign: Sign::Plus,
    });
    ExpressionNode::Add(AddNode { children })
}

fn terms() -> Vec<ExpressionNode> {
    vec![
        pool(2.0, 6.0, Some(2.0)),
        pool(2.0, 8.0, None),
        pool(1.0, 8.0, None),
        pool(3.0, 10.0, Some(1.0)),
        pool(4.0, 12.0, None),
    ]
}

/// tests/add-term-order.test.ts:40
#[test]
fn cold_each_order_alone_caches_cleared_before_each() -> T {
    let orders = permutations(&terms());
    let reference = resolve(&sum_of(&orders[0]), 0.0)?.fingerprint();
    for order in &orders {
        assert_eq!(resolve(&sum_of(order), 0.0)?.fingerprint(), reference);
    }
    Ok(())
}

/// tests/add-term-order.test.ts:49
#[test]
fn warm_an_order_resolved_after_another_is_cached_returns_the_bits_it_would_have_computed_cold() -> T
{
    let orders = permutations(&terms());
    let mut cold = Vec::new();
    for (i, order) in orders.iter().enumerate() {
        if i % 11 == 0 {
            cold.push((order, resolve(&sum_of(order), 0.0)?.fingerprint()));
        }
    }
    for (first, _) in &cold {
        resolve(&sum_of(first), 0.0)?;
        for (second, bits) in &cold {
            assert_eq!(&resolve(&sum_of(second), 0.0)?.fingerprint(), bits);
        }
    }
    Ok(())
}

// ---- builder-cache-keys.test.ts (3 translated; `.dc(15)` line dropped) -----------------------

/// tests/builder-cache-keys.test.ts:9 (the `d20.plus(value).dc(15)` line is deferred: needs `.dc`)
#[test]
fn refuses_infinity_wherever_a_number_is_taken() -> T {
    for value in [f64::INFINITY, f64::NEG_INFINITY] {
        assert_throws(rd(1.0, d6())?.plus(value), "finite");
        assert_throws(rd(1.0, d6())?.minus(value), "finite");
        assert_throws(rd(2.0, d6())?.keep_highest(2.0, value), "finite");
        assert_throws(rd(2.0, d6())?.keep_highest(value, 1.0), "finite");
        assert_throws(rd(2.0, d6())?.keep_lowest(2.0, value), "finite");
        assert_throws(rd(2.0, d6())?.minimum(value), "finite");
        assert_throws(rd(2.0, d6())?.reroll(value), "finite");
        assert_throws(RollBuilder::new(value), "finite");
        assert_throws(roll_with(1.0, None, None)?.d(value), "finite");
    }
    Ok(())
}

/// tests/builder-cache-keys.test.ts:22
#[test]
fn gives_configs_differing_only_in_the_sign_of_an_infinite_field_different_cache_keys() -> T {
    let keep_with = |count: f64| {
        RollBuilder::from_config(&RollConfigPatch {
            count: Some(2.0),
            sides: Some(6.0),
            keep: Some(KeepSpec {
                total: 2.0,
                count,
                mode: KeepMode::Highest,
            }),
            ..Default::default()
        })
    };
    let keep_all = || keep_with(f64::INFINITY);
    let keep_none = || keep_with(f64::NEG_INFINITY);
    assert_ne!(keep_all().cache_key(), keep_none().cache_key());

    let u6 = uniform(6);
    expect_dist(&pmf(&keep_all())?, &repeat(&u6, 2));
    expect_dist(&pmf(&keep_none())?, &point(0.0));
    expect_dist(&pmf(&keep_all())?, &repeat(&u6, 2));

    let minimum_key = |m: f64| {
        RollBuilder::from_config(&RollConfigPatch {
            sides: Some(6.0),
            minimum: Some(m),
            ..Default::default()
        })
        .cache_key()
    };
    let nan_key = minimum_key(f64::NAN);
    assert_ne!(nan_key, minimum_key(f64::INFINITY));
    assert_ne!(nan_key, minimum_key(f64::NEG_INFINITY));
    Ok(())
}

fn x1() -> Result<RollBuilder, DiceError> {
    rd(1.0, d(200.0)?)?
        .plus_roll(&rd(2.0, d(199.0)?)?)?
        .scale_result(1.0, 323.0, Rounding::Floor)
}

fn x2() -> Result<RollBuilder, DiceError> {
    rd(2.0, d(200.0)?)?
        .plus_roll(&rd(1.0, d(198.0)?)?)?
        .scale_result(1.0, 323.0, Rounding::Floor)
}

fn trial(p: f64) -> Dist {
    vec![(0.0, 1.0 - p), (1.0, p)]
}

/// tests/builder-cache-keys.test.ts:51
#[test]
fn keeps_the_two_per_trial_distributions_apart_for_a_keep_2_of_3_pool() -> T {
    let p1 = 1654021.0 / 3960100.0;
    let p2 = 75181.0 / 180000.0;
    expect_dist(
        &pmf(&x1()?.keep_highest_all(3.0, 2.0)?)?,
        &keep(&trial(p1), 3, 2, true),
    );
    expect_dist(
        &pmf(&x2()?.keep_highest_all(3.0, 2.0)?)?,
        &keep(&trial(p2), 3, 2, true),
    );
    assert_close(
        pmf(&x2()?.keep_highest_all(3.0, 2.0)?)?.mean(),
        6882656447845259.0 / 5832000000000000.0,
        14,
    );
    Ok(())
}

/// tests/builder-cache-keys.test.ts:57
#[test]
fn keeps_the_two_per_trial_distributions_apart_for_a_keep_lowest_1_of_3_pool() -> T {
    let p1 = 1654021.0 / 3960100.0;
    expect_dist(
        &pmf(&x1()?.keep_lowest_all(3.0, 1.0)?)?,
        &keep(&trial(p1), 3, 1, false),
    );
    assert_close(
        pmf(&x2()?.keep_lowest_all(3.0, 1.0)?)?.p_at(1.0),
        424936752154741.0 / 5832000000000000.0,
        14,
    );
    Ok(())
}

// ---- zero-count-dice.test.ts (4 translated) --------------------------------------------------

/// tests/zero-count-dice.test.ts:8 (each row is always 0)
#[test]
fn zero_count_dice_groups_are_always_0() -> T {
    let rows: Vec<(&str, RollBuilder)> = vec![
        ("roll(0, d6)", rd(0.0, d6())?),
        ("roll(0, 6)", rs(0.0, 6.0)?),
        ("new RollBuilder(0).d6()", RollBuilder::new(0.0)?.d6()?),
        ("roll(0, d20)", rd(0.0, d20())?),
        ("roll(0, d6.plus(2))", rd(0.0, d6().plus(2.0)?)?),
        ("roll(0, d6).reroll(1)", rd(0.0, d6())?.reroll(1.0)?),
        ("roll(0, d6).minimum(3)", rd(0.0, d6())?.minimum(3.0)?),
        (
            "roll(0, d6).keepHighest(2, 1)",
            rd(0.0, d6())?.keep_highest(2.0, 1.0)?,
        ),
        (
            "roll(0, d6).keepHighest(3, 2)",
            rd(0.0, d6())?.keep_highest(3.0, 2.0)?,
        ),
        ("roll(0, d6).bestOf(1)", rd(0.0, d6())?.best_of(1.0)?),
        ("roll(0, d6).explode(1)", rd(0.0, d6())?.explode(1.0)?),
        (
            "roll(0, d8).explodePool(2)",
            rd(0.0, d8())?.explode_pool(2.0)?,
        ),
        (
            "roll(0, d6).withAdvantage()",
            rd(0.0, d6())?.with_advantage()?,
        ),
    ];
    for (name, build) in rows {
        let p = pmf(&build).map_err(|e| format!("{name}: {e}"))?;
        expect_dist(&p, &point(0.0));
    }
    Ok(())
}

/// tests/zero-count-dice.test.ts:26
#[test]
fn keeps_the_flat_modifier_of_a_zero_dice_group() -> T {
    expect_dist(&pmf(&rd(0.0, d6())?.plus(3.0)?)?, &point(3.0));
    expect_dist(
        &pmf(&roll_with(0.0, Some(SidesOrDie::Sides(6.0)), Some(3.0))?)?,
        &point(3.0),
    );
    Ok(())
}

/// tests/zero-count-dice.test.ts:31
#[test]
fn adds_nothing_when_a_zero_dice_group_joins_a_roll() -> T {
    expect_dist(&pmf(&d8().plus_roll(&rd(0.0, d6())?)?)?, &uniform(8));
    let r = rd(2.0, d8())?.plus_dice(0.0, &d6())?;
    expect_dist(&pmf(&r)?, &repeat(&uniform(8), 2));
    assert_close(pmf(&r)?.mean(), 9.0, 12);
    Ok(())
}

/// tests/zero-count-dice.test.ts:37
#[test]
fn leaves_the_flat_only_rolls_unchanged() -> T {
    expect_dist(&pmf(&roll_with(0.0, None, None)?)?, &point(0.0));
    expect_dist(&pmf(&flat(4.0)?)?, &point(4.0));
    expect_dist(&pmf(&flat(-2.0)?)?, &point(-2.0));
    Ok(())
}

// ---- transform-arithmetic.test.ts (9 translated) ---------------------------------------------

fn two_d6() -> Dist {
    repeat(&uniform(6), 2)
}

fn half_of_2d6() -> Dist {
    map(&two_d6(), |v| (v / 2.0).floor())
}

fn d6_reroll2() -> Dist {
    (1..=6)
        .map(|v| {
            let v = f64::from(v);
            (v, (if v <= 2.0 { 0.0 } else { 1.0 / 6.0 }) + 1.0 / 18.0)
        })
        .collect()
}

/// tests/transform-arithmetic.test.ts:15
#[test]
fn roll_2_d6_half_plus_1_is_floor_2d6_over_2_plus_1() -> T {
    let p = pmf(&rd(2.0, d6())?.half()?.plus(1.0)?)?;
    expect_dist(&p, &shift(&half_of_2d6(), 1.0));
    assert_close(p.mean(), 17.0 / 4.0, 12);
    Ok(())
}

/// tests/transform-arithmetic.test.ts:21
#[test]
fn roll_2_d6_scale_result_2_plus_1_is_2_times_2d6_plus_1() -> T {
    let p = pmf(&rd(2.0, d6())?
        .scale_result(2.0, 1.0, Rounding::Floor)?
        .plus(1.0)?)?;
    expect_dist(&p, &shift(&map(&two_d6(), |v| 2.0 * v), 1.0));
    assert_close(p.mean(), 15.0, 12);
    Ok(())
}

/// tests/transform-arithmetic.test.ts:27
#[test]
fn minus_dice_and_chained_arithmetic_compose_too() -> T {
    let h = half_of_2d6();
    let u4 = uniform(4);
    let half = || rd(2.0, d6())?.half();
    expect_dist(&pmf(&half()?.minus(1.0)?)?, &shift(&h, -1.0));
    expect_dist(
        &pmf(&half()?.plus_roll(&d4())?.plus(2.0)?)?,
        &shift(&add(&[&h, &u4]), 2.0),
    );
    expect_dist(
        &pmf(&half()?.minus_dice(2.0, &d4())?)?,
        &add(&[&h, &negate(&repeat(&u4, 2))]),
    );
    let scaled = rd(1.0, d8())?.scale_result(2.0, 1.0, Rounding::Floor)?;
    expect_dist(
        &pmf(&half()?.plus_roll(&scaled)?)?,
        &add(&[&h, &map(&uniform(8), |v| 2.0 * v)]),
    );
    Ok(())
}

/// tests/transform-arithmetic.test.ts:34
#[test]
fn a_transformed_roll_added_to_a_plain_roll_keeps_its_transform() -> T {
    let (u6, u8) = (uniform(6), uniform(8));
    let h = half_of_2d6();
    let half = rd(2.0, d6())?.half()?;
    expect_dist(&pmf(&d6().plus_roll(&half)?)?, &add(&[&u6, &h]));
    expect_dist(&pmf(&d6().minus_roll(&half)?)?, &add(&[&u6, &negate(&h)]));
    let half8 = map(&u8, |v| (v / 2.0).floor());
    expect_dist(&pmf(&rd(2.0, d8().half()?)?)?, &repeat(&half8, 2));
    expect_dist(&pmf(&rd(-1.0, d8().half()?)?)?, &negate(&half8));
    let half6 = map(&u6, |v| (v / 2.0).floor());
    expect_dist(
        &pmf(&sum_rolls(&[d6().half()?, d8()])?.plus(1.0)?)?,
        &shift(&add(&[&half6, &u8]), 1.0),
    );
    Ok(())
}

/// tests/transform-arithmetic.test.ts:42
#[test]
fn refuses_die_verbs_that_would_silently_drop_the_transform() -> T {
    assert_throws(rd(2.0, d6())?.half()?.reroll(1.0), "half()");
    assert_throws(
        rd(2.0, d6())?
            .scale_result(2.0, 1.0, Rounding::Floor)?
            .minimum(2.0),
        "scaleResult()",
    );
    assert_throws(
        rd(2.0, d6())?.max_of(2.0)?.keep_highest(2.0, 1.0),
        "maxOf()",
    );
    Ok(())
}

/// tests/transform-arithmetic.test.ts:50
#[test]
fn keeps_the_inner_rolls_flat_roll_2_d6_plus_3_max_of_2() -> T {
    let p = pmf(&rd(2.0, d6())?.plus(3.0)?.max_of(2.0)?)?;
    let t = two_d6();
    expect_dist(&p, &shift(&max(&[&t, &t]), 3.0));
    assert_close(p.mean(), 7369.0 / 648.0, 12);
    Ok(())
}

/// tests/transform-arithmetic.test.ts:56
#[test]
fn keeps_the_inner_rolls_reroll_roll_2_d6_reroll_2_max_of_2() -> T {
    let p = pmf(&rd(2.0, d6())?.reroll(2.0)?.max_of(2.0)?)?;
    let inner = repeat(&d6_reroll2(), 2);
    expect_dist(&p, &max(&[&inner, &inner]));
    assert_close(p.mean(), 496795.0 / 52488.0, 12);
    Ok(())
}

/// tests/transform-arithmetic.test.ts:63
#[test]
fn takes_several_dice_groups_as_one_roll_roll_1_d8_plus_roll_1_d6_max_of_2() -> T {
    let p = pmf(&rd(1.0, d8())?.plus_roll(&rd(1.0, d6())?)?.max_of(2.0)?)?;
    let inner = add(&[&uniform(8), &uniform(6)]);
    expect_dist(&p, &max(&[&inner, &inner]));
    assert_close(p.mean(), 2773.0 / 288.0, 12);
    Ok(())
}

/// tests/transform-arithmetic.test.ts:70
#[test]
fn takes_the_highest_of_this_roll_and_another_roll() -> T {
    let three_d8 = repeat(&uniform(8), 3);
    expect_dist(
        &pmf(&rd(3.0, d8())?.max_of_roll(&rd(3.0, d8())?)?)?,
        &max(&[&three_d8, &three_d8]),
    );
    expect_dist(
        &pmf(&rd(2.0, d6())?.max_of_roll(&d8().plus(2.0)?)?)?,
        &max(&[&two_d6(), &shift(&uniform(8), 2.0)]),
    );
    Ok(())
}

/// tests/transform-arithmetic.test.ts:76
#[test]
fn composes_with_arithmetic_after_it() -> T {
    let t = two_d6();
    expect_dist(
        &pmf(&rd(2.0, d6())?.max_of(2.0)?.plus(3.0)?)?,
        &shift(&max(&[&t, &t]), 3.0),
    );
    Ok(())
}

// ---- repeated-roll-groups.test.ts (6 + 1 translated) -----------------------------------------

fn best_of_two_d6() -> Dist {
    let u6 = uniform(6);
    max(&[&u6, &u6])
}

fn d6_explode_once() -> Dist {
    let mut out: Dist = (1..=5).map(|v| (f64::from(v), 1.0 / 6.0)).collect();
    for v in 1..=6 {
        out.push((6.0 + f64::from(v), 1.0 / 36.0));
    }
    out
}

fn best6() -> Result<RollBuilder, DiceError> {
    d6().keep_highest(2.0, 1.0)
}

/// tests/repeated-roll-groups.test.ts:14
#[test]
fn copies_a_best_of_two_die() -> T {
    let b = best_of_two_d6();
    let two = pmf(&rd(2.0, best6()?)?)?;
    expect_dist(&two, &repeat(&b, 2));
    assert_close(two.mean(), 161.0 / 18.0, 12);
    let three = pmf(&rd(3.0, best6()?)?)?;
    expect_dist(&three, &repeat(&b, 3));
    assert_close(three.mean(), 161.0 / 12.0, 12);
    Ok(())
}

/// tests/repeated-roll-groups.test.ts:23
#[test]
fn copies_keep_2_of_3_and_worst_of_two_dice() -> T {
    let u6 = uniform(6);
    expect_dist(
        &pmf(&rd(2.0, d6().keep_highest(3.0, 2.0)?)?)?,
        &repeat(&keep(&u6, 3, 2, true), 2),
    );
    let worst = pmf(&rd(2.0, d8().keep_lowest(2.0, 1.0)?)?)?;
    expect_dist(&worst, &repeat(&min(&[&uniform(8), &uniform(8)]), 2));
    assert_close(worst.mean(), 51.0 / 8.0, 12);
    Ok(())
}

/// tests/repeated-roll-groups.test.ts:30
#[test]
fn copies_best_of_1_of_one_die_which_is_just_that_die() -> T {
    expect_dist(
        &pmf(&rd(3.0, d6().best_of(1.0)?)?)?,
        &repeat(&uniform(6), 3),
    );
    Ok(())
}

/// tests/repeated-roll-groups.test.ts:34
#[test]
fn gives_each_copy_its_own_pool_wide_explosion_budget() -> T {
    let p = pmf(&rd(2.0, d6().explode_pool(1.0)?)?)?;
    expect_dist(&p, &repeat(&d6_explode_once(), 2));
    assert_close(p.mean(), 49.0 / 6.0, 12);
    Ok(())
}

/// tests/repeated-roll-groups.test.ts:40
#[test]
fn copies_the_flat_modifier_of_each_copy() -> T {
    expect_dist(
        &pmf(&rd(2.0, best6()?.plus(1.0)?)?)?,
        &shift(&repeat(&best_of_two_d6(), 2), 2.0),
    );
    Ok(())
}

/// tests/repeated-roll-groups.test.ts:44
#[test]
fn adds_and_subtracts_copies_with_plus_n_x_and_minus_n_x() -> T {
    let r = repeat(&best_of_two_d6(), 2);
    let u8 = uniform(8);
    expect_dist(&pmf(&d8().plus_dice(2.0, &best6()?)?)?, &add(&[&u8, &r]));
    expect_dist(
        &pmf(&d8().minus_dice(2.0, &best6()?)?)?,
        &add(&[&u8, &negate(&r)]),
    );
    expect_dist(&pmf(&rd(-2.0, best6()?)?)?, &negate(&r));
    Ok(())
}

/// tests/repeated-roll-groups.test.ts:52
#[test]
fn rolls_its_whole_copies_like_a_fractional_die_count_rolls_its_whole_dice() -> T {
    expect_dist(&pmf(&rd(2.5, best6()?)?)?, &repeat(&best_of_two_d6(), 2));
    expect_dist(&pmf(&rd(2.5, d6())?)?, &repeat(&uniform(6), 2));
    Ok(())
}

// ---- subtracted-groups.test.ts (7 translated; 1 deferred: :34) -------------------------------
// DEFERRED: tests/subtracted-groups.test.ts:34 (needs .ac/.onHit/.resolve; the `check.modifier == 4` part is
// separable and translated below as `a_check_that_subtracts_a_die_with_its_own_flat_modifier`).

/// tests/subtracted-groups.test.ts:11
#[test]
fn roll_2_d6_minus_roll_1_d4_plus_2_is_2d6_minus_d4_plus_2() -> T {
    let p = pmf(&rd(2.0, d6())?.minus_roll(&rd(1.0, d4())?.plus(2.0)?)?)?;
    expect_dist(&p, &shift(&add(&[&two_d6(), &negate(&uniform(4))]), -2.0));
    assert_close(p.mean(), 5.0 / 2.0, 12);
    Ok(())
}

/// tests/subtracted-groups.test.ts:17
#[test]
fn subtracting_several_copies_subtracts_each_copys_flat() -> T {
    let expected = shift(&add(&[&two_d6(), &negate(&repeat(&uniform(4), 2))]), -2.0);
    let d4p1 = d4().plus(1.0)?;
    expect_dist(&pmf(&rd(2.0, d6())?.minus_dice(2.0, &d4p1)?)?, &expected);
    expect_dist(&pmf(&rd(2.0, d6())?.plus_dice(-2.0, &d4p1)?)?, &expected);
    Ok(())
}

/// tests/subtracted-groups.test.ts:23
#[test]
fn a_negative_repeat_count_negates_the_flat_roll_minus_1_d6_plus_2_is_minus_d6_plus_2() -> T {
    let p = pmf(&rd(-1.0, d6().plus(2.0)?)?)?;
    expect_dist(&p, &shift(&negate(&uniform(6)), -2.0));
    assert_close(p.mean(), -11.0 / 2.0, 12);
    Ok(())
}

/// tests/subtracted-groups.test.ts:29
#[test]
fn a_flat_added_after_the_subtraction_is_still_added() -> T {
    let p = pmf(&rd(2.0, d6())?
        .minus_roll(&rd(1.0, d4())?.plus(1.0)?)?
        .plus(3.0)?)?;
    assert_close(p.mean(), 13.0 / 2.0, 12);
    Ok(())
}

/// tests/subtracted-groups.test.ts:34 (builder-only part: `check.modifier`)
#[test]
fn a_check_that_subtracts_a_die_with_its_own_flat_modifier() -> T {
    let check = d20().plus(5.0)?.minus_roll(&rd(1.0, d4())?.plus(1.0)?)?;
    assert_eq!(check.modifier(), 4.0);
    Ok(())
}

/// tests/subtracted-groups.test.ts:46
#[test]
fn roll_2_d6_minus_roll_minus_1_4_is_2d6_plus_d4() -> T {
    let p = pmf(&rd(2.0, d6())?.minus_roll(&rs(-1.0, 4.0)?)?)?;
    expect_dist(&p, &add(&[&two_d6(), &uniform(4)]));
    assert_close(p.mean(), 19.0 / 2.0, 12);
    Ok(())
}

/// tests/subtracted-groups.test.ts:51
#[test]
fn roll_2_d6_minus_roll_minus_1_d4_is_2d6_plus_d4() -> T {
    expect_dist(
        &pmf(&rd(2.0, d6())?.minus_roll(&rd(-1.0, d4())?)?)?,
        &add(&[&two_d6(), &uniform(4)]),
    );
    Ok(())
}

/// tests/subtracted-groups.test.ts:55
#[test]
fn roll_minus_2_roll_minus_1_4_is_2d4() -> T {
    expect_dist(&pmf(&rd(-2.0, rs(-1.0, 4.0)?)?)?, &repeat(&uniform(4), 2));
    Ok(())
}

// ---- per-die-roll-type.test.ts (5 translated) ------------------------------------------------

/// tests/per-die-roll-type.test.ts:9
#[test]
fn roll_2_d6_with_advantage_is_two_d6_each_rolled_with_advantage() -> T {
    let p = pmf(&rd(2.0, d6())?.with_advantage()?)?;
    expect_dist(&p, &repeat(&best_of_two_d6(), 2));
    assert_close(p.mean(), 161.0 / 18.0, 12);
    Ok(())
}

/// tests/per-die-roll-type.test.ts:15
#[test]
fn matches_repeating_a_single_advantaged_die() -> T {
    let a = best_of_two_d6();
    expect_dist(&pmf(&rd(2.0, d6().with_advantage()?)?)?, &repeat(&a, 2));
    expect_dist(
        &pmf(&rd(3.0, d6())?.with_advantage()?.plus(2.0)?)?,
        &shift(&repeat(&a, 3), 2.0),
    );
    Ok(())
}

/// tests/per-die-roll-type.test.ts:20
#[test]
fn applies_disadvantage_and_elven_accuracy_per_die_too() -> T {
    expect_dist(
        &pmf(&rd(2.0, d8())?.with_disadvantage()?)?,
        &repeat(&min(&[&uniform(8), &uniform(8)]), 2),
    );
    let u6 = uniform(6);
    expect_dist(
        &pmf(&rd(2.0, d6())?.with_elven_accuracy()?)?,
        &repeat(&max(&[&u6, &u6, &u6]), 2),
    );
    Ok(())
}

/// tests/per-die-roll-type.test.ts:25
#[test]
fn rolls_each_d20_of_a_group_with_advantage() -> T {
    let u20 = uniform(20);
    expect_dist(
        &pmf(&rd(2.0, d20())?.with_advantage()?)?,
        &repeat(&max(&[&u20, &u20]), 2),
    );
    Ok(())
}

/// tests/per-die-roll-type.test.ts:30
#[test]
fn leaves_a_single_die_unchanged() -> T {
    expect_dist(&pmf(&d6().with_advantage()?)?, &best_of_two_d6());
    expect_dist(
        &pmf(&d20().with_advantage()?)?,
        &max(&[&uniform(20), &uniform(20)]),
    );
    Ok(())
}

// ---- per-die-keep-shapes.test.ts (8 translated) ----------------------------------------------

/// tests/per-die-keep-shapes.test.ts:9
#[test]
fn one_die_keep_k_of_t_dice() -> T {
    let u6 = uniform(6);
    expect_dist(
        &pmf(&rd(1.0, d6())?.keep_highest(3.0, 2.0)?)?,
        &keep(&u6, 3, 2, true),
    );
    expect_dist(
        &pmf(&rd(1.0, d6())?.keep_lowest(3.0, 2.0)?)?,
        &keep(&u6, 3, 2, false),
    );
    expect_dist(
        &pmf(&rd(1.0, d6())?.keep_lowest(2.0, 1.0)?)?,
        &min(&[&u6, &u6]),
    );
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:15
#[test]
fn n_dice_keep_k_ge_2_of_those_n_dice() -> T {
    expect_dist(
        &pmf(&rd(3.0, d6())?.keep_highest(3.0, 2.0)?)?,
        &keep(&uniform(6), 3, 2, true),
    );
    expect_dist(
        &pmf(&rd(4.0, d8())?.keep_lowest(4.0, 2.0)?)?,
        &keep(&uniform(8), 4, 2, false),
    );
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:20
#[test]
fn n_dice_keep_the_best_of_t_rolls_of_the_whole_n_dice_sum() -> T {
    let u6 = uniform(6);
    let three = repeat(&u6, 3);
    let p = pmf(&rd(3.0, d6())?.keep_highest(3.0, 1.0)?)?;
    expect_dist(&p, &max(&[&three, &three, &three]));
    assert_close(p.mean(), 22489.0 / 1728.0, 12);
    let two = repeat(&u6, 2);
    expect_dist(
        &pmf(&rd(2.0, d6())?.keep_highest(2.0, 1.0)?)?,
        &max(&[&two, &two]),
    );
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:28
#[test]
fn n_dice_keep_the_worst_of_t_ne_n_rolls_of_the_whole_n_dice_sum() -> T {
    let two = repeat(&uniform(6), 2);
    expect_dist(
        &pmf(&rd(2.0, d6())?.keep_lowest(3.0, 1.0)?)?,
        &min(&[&two, &two, &two]),
    );
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:33
#[test]
fn keeping_none_of_the_dice_is_0() -> T {
    expect_dist(&pmf(&rd(2.0, d6())?.keep_highest(3.0, 0.0)?)?, &point(0.0));
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:37
#[test]
fn best_of_k_keeps_the_k_highest_of_the_individual_dice() -> T {
    let u6 = uniform(6);
    expect_dist(&pmf(&rd(3.0, d6())?.best_of(1.0)?)?, &max(&[&u6, &u6, &u6]));
    expect_dist(&pmf(&rd(4.0, d6())?.best_of(3.0)?)?, &keep(&u6, 4, 3, true));
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:44 (each row throws `AmbiguousKeepError` naming keepHighestAll/keepLowestAll)
#[test]
fn per_die_keep_shapes_with_more_than_one_reading_throw() -> T {
    let rows: Vec<(&str, Result<RollBuilder, DiceError>)> = vec![
        (
            "roll(3,d6).keepHighest(4,2)",
            rd(3.0, d6())?.keep_highest(4.0, 2.0),
        ),
        (
            "roll(2,d6).keepHighest(4,3)",
            rd(2.0, d6())?.keep_highest(4.0, 3.0),
        ),
        (
            "roll(3,d8).keepHighest(4,3)",
            rd(3.0, d8())?.keep_highest(4.0, 3.0),
        ),
        (
            "roll(8,d10).keepLowest(4,2)",
            rs(8.0, 10.0)?.keep_lowest(4.0, 2.0),
        ),
        (
            "roll(2,d6).keepLowest(4,3)",
            rd(2.0, d6())?.keep_lowest(4.0, 3.0),
        ),
        (
            "roll(3,d6).keepLowest(3,1)",
            rd(3.0, d6())?.keep_lowest(3.0, 1.0),
        ),
        (
            "roll(2,d6).keepLowest(2,1)",
            rd(2.0, d6())?.keep_lowest(2.0, 1.0),
        ),
    ];
    for (name, built) in rows {
        let e = error_of(built);
        assert!(
            matches!(e, crate::error::DiceError::AmbiguousKeep(_)),
            "{name}: {e}"
        );
        assert!(
            e.message().contains("keepHighestAll") || e.message().contains("keepLowestAll"),
            "{name}: {e}"
        );
    }
    Ok(())
}

/// tests/per-die-keep-shapes.test.ts:57
#[test]
fn also_throws_when_the_shape_reaches_the_resolver_from_a_hand_built_config() -> T {
    let r = RollBuilder::from_config(&RollConfigPatch {
        count: Some(3.0),
        sides: Some(6.0),
        keep: Some(KeepSpec {
            total: 4.0,
            count: 2.0,
            mode: KeepMode::Highest,
        }),
        ..Default::default()
    });
    let e = error_of(r.to_pmf(0.0));
    assert!(
        matches!(e, crate::error::DiceError::AmbiguousKeep(_)),
        "{e}"
    );
    Ok(())
}
