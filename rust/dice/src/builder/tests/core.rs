//! Core checks that are not TS `it` cases: builder-vs-parser agreement on the chains
//! `roll.test.ts` asserts, and the ADR-016/ADR-017 guards of the builder modules.

use super::support::*;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{MAX_BUILDER_DEPTH, RollBuilder};
use crate::builder::sample::sample_pmf;
use crate::common::Rng;
use crate::parser::{parse, parse_with};

/// Every bin of `a` and `b` agrees within 1e-9, over the union of both supports.
fn assert_same_bins(a: &crate::Pmf, b: &crate::Pmf, what: &str) {
    let mut support: Vec<f64> = a.support().iter().map(|d| d.0).collect();
    support.extend(b.support().iter().map(|d| d.0));
    support.sort_by(f64::total_cmp);
    support.dedup();
    for v in support {
        assert!(
            (a.p_at(v) - b.p_at(v)).abs() < 1e-9,
            "{what}: P({v}) = {} vs {}",
            a.p_at(v),
            b.p_at(v)
        );
    }
}

/// The builder's `toPMF()` equals `parse()` of both its own `toExpression()` and the hand-written
/// equivalent string, for the chains `roll.test.ts` round-trips (reroll, minimum, keep, bestOf,
/// roll types, sums, `maxOf`, `half`).
#[test]
fn builder_matches_parser_on_roll_test_chains() -> T {
    let d6 = d6();
    let chains: Vec<(RollBuilder, &str, &str)> = vec![
        (
            roll_with(2.0, None, None)?.d(6.0)?.plus(3.0)?,
            "2d6 + 3",
            "2d6 + 3",
        ),
        (
            roll_with(4.0, Some(SidesOrDie::Die(d6.clone())), None)?.keep_highest(4.0, 3.0)?,
            "4kh3(1d6)",
            "4kh3(1d6)",
        ),
        (d8().reroll(1.0)?, "d8 reroll 1", "d8 reroll 1"),
        (d4().reroll(2.0)?, "d4 reroll d2", "d4 reroll d2"),
        (
            roll_with(2.0, Some(SidesOrDie::Die(d6.clone())), None)?.reroll(2.0)?,
            "2(d6 reroll d2)",
            "2(d6 reroll d2)",
        ),
        (
            roll_with(4.0, None, None)?.d(6.0)?.best_of(2.0)?,
            "4kh2(1d6)",
            "4kh2(1d6)",
        ),
        (
            roll_with(4.0, None, None)?.d(6.0)?.best_of(1.0)?,
            "4kh1(1d6)",
            "4kh1(1d6)",
        ),
        (
            roll_with(4.0, None, None)?.d(8.0)?.keep_lowest(4.0, 2.0)?,
            "4kl2(1d8)",
            "4kl2(1d8)",
        ),
        (
            roll_with(5.0, None, None)?
                .d(10.0)?
                .best_of(3.0)?
                .plus(4.0)?,
            "5kh3(1d10) + 4",
            "5kh3(1d10) + 4",
        ),
        (
            roll_with(3.0, None, None)?.d(6.0)?.minimum(2.0)?,
            "3(2>d6)",
            "3(2>d6)",
        ),
        (
            d20().with_advantage()?.plus(5.0)?,
            "d20 > d20 + 5",
            "d20 > d20 + 5",
        ),
        (d20().with_disadvantage()?, "d20 < d20", "d20 < d20"),
        (
            d20().with_elven_accuracy()?,
            "d20 > d20 > d20",
            "d20 > d20 > d20",
        ),
        (hd20(), "hd20", "d20 reroll 1"),
        (
            roll_with(2.0, Some(SidesOrDie::Die(d6.clone())), None)?
                .plus(3.0)?
                .max_of(2.0)?,
            "2kh1(2d6 + 3)",
            "2kh1(2d6 + 3)",
        ),
        (
            roll_with(2.0, Some(SidesOrDie::Die(d6.clone())), None)?.half()?,
            "(2d6) // 2",
            "(2d6) // 2",
        ),
        (
            roll_with(2.0, Some(SidesOrDie::Die(d6.clone())), None)?.scale_result(
                3.0,
                2.0,
                Rounding::Ceil,
            )?,
            "(2d6) ** 3 / 2",
            "(2d6) ** 3 / 2",
        ),
        (
            roll_with(2.0, None, None)?
                .d(6.0)?
                .add_roll(3.0)?
                .d(8.0)?
                .plus(5.0)?,
            "3d8 + 2d6 + 5",
            "3d8 + 2d6 + 5",
        ),
        (
            roll_with(3.0, Some(SidesOrDie::Die(d6.clone())), None)?.keep_highest(3.0, 1.0)?,
            "3kh1(3d6)",
            "3kh1(3d6)",
        ),
    ];
    for (built, expression, equivalent) in chains {
        assert_eq!(
            built.to_expression()?,
            expression,
            "expression of {expression}"
        );
        let pmf = built.to_pmf(0.0)?;
        assert_same_bins(&pmf, &parse_with(&built.to_expression()?, 0.0)?, expression);
        assert_same_bins(&pmf, &parse(equivalent)?, equivalent);
    }
    Ok(())
}

/// `roll(0, 6)` rolls zero dice like the parser's `0d6` (issue #12).
#[test]
fn zero_dice_match_the_parser() -> T {
    assert_eq!(
        faces(&roll_with(0.0, Some(SidesOrDie::Sides(6.0)), None)?.to_pmf(0.0)?),
        vec![(0.0, 1.0)]
    );
    assert_eq!(
        faces(&roll_with(0.0, Some(SidesOrDie::Sides(6.0)), Some(3.0))?.to_pmf(0.0)?),
        faces(&d_expression("0d6 ~+ 3")?.to_pmf(0.0)?)
    );
    Ok(())
}

/// ADR-016: wrapping calls past `MAX_BUILDER_DEPTH` fail with the stack-overflow error, and
/// builders at the cap resolve without overflowing the test thread's stack.
#[test]
fn builder_nesting_is_capped() -> T {
    let mut r = roll_with(2.0, Some(SidesOrDie::Sides(6.0)), None)?;
    for _ in 0..MAX_BUILDER_DEPTH {
        r = r.half()?;
    }
    // 100 nested halves: 100 AST levels, resolved and printed.
    assert!(r.to_pmf(0.0)?.mean() >= 0.0);
    assert!(r.to_expression()?.starts_with("(("));
    let err = err_of(r.half());
    assert_eq!(err, "Maximum call stack size exceeded");
    assert_throws(
        r.scale_result(2.0, 1.0, Rounding::Floor),
        "Maximum call stack size exceeded",
    );
    assert_throws(r.max_of(2.0), "Maximum call stack size exceeded");
    assert_throws(
        r.keep_highest_all(2.0, 1.0),
        "Maximum call stack size exceeded",
    );
    Ok(())
}

/// ADR-017: sizes where TS allocates until it dies return `Err`.
#[test]
fn absurd_sizes_are_errors() -> T {
    assert_throws(d(1e9)?.to_pmf(0.0), "too large to resolve");
    assert_throws(d(6.0)?.explode(1e6)?.to_pmf(0.0), "too large to resolve");
    assert_throws(
        roll_with(
            1e7,
            Some(SidesOrDie::Die(d(6.0)?.keep_highest(2.0, 1.0)?)),
            None,
        ),
        "too many times",
    );
    assert_throws(
        roll_with(10.0, Some(SidesOrDie::Sides(6.0)), None)?
            .explode_pool(1e6)?
            .to_pmf(0.0),
        "too large to resolve",
    );
    Ok(())
}

/// A keep of a fractional count (a hand-built tree TS answers with an empty mass) is an `Err`.
#[test]
fn fractional_keep_count_is_an_error() {
    use crate::builder::ast::resolve;
    use crate::builder::nodes::*;
    let die = ExpressionNode::Die(DieNode {
        sides: 6.0,
        reroll: None,
        minimum: None,
        explode: None,
    });
    let node = ExpressionNode::Keep(KeepNode {
        mode: KeepMode::Highest,
        count: 2.5,
        child: Box::new(KeepChild::Sum(SumNode {
            count: 5.0,
            child: Box::new(die),
            explode_pool_budget: None,
        })),
    });
    assert_throws(resolve(&node, 0.0), "must be an integer");
}

struct Fixed(Vec<f64>, usize);

impl Rng for Fixed {
    fn die(&mut self, _sides: f64) -> f64 {
        let v = self.0.get(self.1).copied().unwrap_or(1.0);
        self.1 += 1;
        v
    }
    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

/// A scripted `Rng` sees the AST's source order (`sample`).
#[test]
fn sample_draws_in_source_order() -> T {
    let r = roll_with(2.0, Some(SidesOrDie::Sides(6.0)), None)?
        .plus_roll(&d8())?
        .plus(1.0)?;
    let mut rng = Fixed(vec![3.0, 4.0, 5.0], 0);
    let s = r.sample(&mut rng)?;
    assert_eq!(s.total, 13.0);
    assert_eq!(
        s.dice.iter().map(|d| d.sides).collect::<Vec<_>>(),
        vec![6.0, 6.0, 8.0]
    );
    let parsed = d_expression("1d6")?;
    let mut rng = Fixed(vec![], 0);
    assert_eq!(parsed.sample(&mut rng)?.dice.len(), 0);
    assert_eq!(
        sample_pmf(&parsed.to_pmf(0.0)?, &mut Fixed(vec![], 0)).total,
        6.0
    );
    Ok(())
}

/// ADR-016: the deepest pooled nesting (two AST levels per `keepHighestAll`) resolves and prints on
/// a default test thread stack; one level more is refused.
#[test]
fn pooled_nesting_is_capped() -> T {
    let mut r = roll_with(1.0, Some(SidesOrDie::Sides(6.0)), None)?;
    for _ in 0..MAX_BUILDER_DEPTH {
        r = r.keep_highest_all(2.0, 1.0)?;
    }
    assert!(r.to_pmf(0.0)?.mean() > 3.5);
    assert!(r.to_expression()?.starts_with("2kh1(2kh1("));
    assert_throws(
        r.keep_highest_all(2.0, 1.0),
        "Maximum call stack size exceeded",
    );
    // Scaling the dice rebuilds every level of the pool without growing it.
    let scaled = r.scale_dice(2.0)?;
    assert!(scaled.to_pmf(0.0)?.mean() > r.to_pmf(0.0)?.mean());
    assert_throws(scaled.times(2.0), "Maximum call stack size exceeded");
    Ok(())
}

/// ADR-016: nested `maxOf(other)` and `sumRolls` stay under the cap too.
#[test]
fn composite_nesting_is_capped() -> T {
    let mut r = d6().half()?;
    for _ in 0..MAX_BUILDER_DEPTH - 1 {
        r = r.max_of_roll(&d8())?;
    }
    assert!(r.to_pmf(0.0)?.mean() > 0.0);
    assert_throws(r.max_of_roll(&d8()), "Maximum call stack size exceeded");
    Ok(())
}

/// A parsed roll has no configs: the TS `TypeError`s of `lastConfig`/`newConfigs[-1]` (messages
/// taken from running the TS), and the transformed-roll refusals.
#[test]
fn parsed_and_transformed_rolls_refuse_like_ts() -> T {
    let p = d_expression("2d6")?;
    let get = |prop: &str| format!("Cannot read properties of undefined (reading '{prop}')");
    let set = |prop: &str| format!("Cannot set properties of undefined (setting '{prop}')");
    assert_eq!(err_of(p.plus(1.0)), get("modifier"));
    assert_eq!(err_of(p.d(6.0)), get("sides"));
    assert_eq!(err_of(p.reroll(1.0)), get("reroll"));
    assert_eq!(err_of(p.explode(1.0)), get("explodePoolBudget"));
    assert_eq!(err_of(p.explode_pool(1.0)), get("explode"));
    assert_eq!(err_of(p.minimum(2.0)), set("minimum"));
    assert_eq!(err_of(p.best_of(2.0)), set("bestOf"));
    assert_eq!(err_of(p.keep_highest(2.0, 1.0)), get("sides"));
    assert_eq!(err_of(p.with_advantage()), set("rollType"));
    assert!(p.add_roll(1.0).is_ok());
    assert!(p.add(&d6()).is_ok());
    assert!(err_of(d6().add(&p)).starts_with("Cannot add a roll with hidden state"));
    assert_eq!(
        err_of(p.pinned()),
        "pinned() needs a die to pin: this roll has no natural roll (a rolled, added die)."
    );
    assert!(p.scale_dice(2.0).is_ok());
    let half = roll_with(2.0, Some(SidesOrDie::Sides(6.0)), None)?.half()?;
    assert_eq!(err_of(half.d(6.0)), "Cannot add a die after adding a die");
    assert!(half.reroll(0.0).is_ok());
    assert_eq!(
        err_of(half.reroll(1.0)),
        "Cannot change the dice of a half() roll: that would drop the half() transform. Set reroll/minimum/explode/keep/advantage on the roll before calling half()."
    );
    Ok(())
}
