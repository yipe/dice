//! `tests/reroll-up-to.test.ts`: 2 compat tests with 3 compat calls, plus every roll-level (builder-only) test.
//! The `rerollDamageUpTo: attack base payload` cases other than `runs through a Turn` (TS lines 360-428) are
//! already in `builder/tests/t_crit_misc.rs` (`mod reroll_up_to`) and are not repeated.
//! Not translated: tests/reroll-up-to.test.ts:5-6: `RerollUpToRollBuilder` is asserted through `RollKind::RerollUpTo`.

use super::helpers::*;
use super::reroll_oracle::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder, RollRerollUpToOptions};
use crate::builder::types::RollConfigPatch;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::turn::effects::{FirstHitOptions, keep_best_damage};
use crate::turn::turn;

const FILE: &str = "tests/reroll-up-to.test.ts";

#[derive(Clone, Copy, Default)]
struct Group {
    count: usize,
    sides: i64,
    minimum: i64,
    reroll: i64,
    minus: bool,
}

fn g(count: usize, sides: i64) -> Group {
    Group {
        count,
        sides,
        ..Group::default()
    }
}

fn pool(groups: &[Group], flat: f64) -> Result<RollBuilder, DiceError> {
    let configs: Vec<RollConfigPatch> = groups
        .iter()
        .map(|g| RollConfigPatch {
            count: Some(g.count as f64),
            sides: Some(g.sides as f64),
            minimum: Some(g.minimum as f64),
            reroll: Some(g.reroll as f64),
            is_subtraction: Some(g.minus),
            ..RollConfigPatch::default()
        })
        .collect();
    let built = RollBuilder::from_configs(&configs);
    if flat == 0.0 {
        Ok(built)
    } else {
        built.plus(flat)
    }
}

fn oracle_dice(groups: &[Group]) -> Vec<Dist> {
    groups
        .iter()
        .flat_map(|g| (0..g.count).map(move |_| rule_die(g.sides, g.minimum, g.reroll, g.minus)))
        .collect()
}

fn single_die(sides: i64, minimum: i64, reroll: i64) -> Dist {
    rule_die(sides, minimum, reroll, false)
}

fn rd(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn opts(rolls: f64) -> RollRerollUpToOptions {
    RollRerollUpToOptions {
        rolls: Some(rolls),
        rolled_once: None,
    }
}

/// `expect(() => ...).toThrow(/pattern/)`.
#[track_caller]
fn throws<X>(result: Result<X, DiceError>, pattern: &str) {
    let message = match result {
        Ok(_) => panic!("expected an error matching /{pattern}/"),
        Err(e) => e.to_string(),
    };
    let re = regex::Regex::new(pattern).expect("pattern");
    assert!(
        re.is_match(&message),
        "error {message:?} does not match /{pattern}/"
    );
}

fn reroll_pmf(groups: &[Group], budget: f64) -> Result<Pmf, DiceError> {
    pool(groups, 0.0)?.reroll_up_to(budget, None)?.pmf()
}

#[test]
fn two_d6_with_one_reroll_has_mean_8_2361_above_the_best_of_two_on_the_first_die() -> T {
    let reroll = rd(2.0, d6())?.reroll_up_to(1.0, None)?.pmf()?;
    close(reroll.mean(), (161.0 + 135.5) / 36.0, 12);
    close(reroll.mean(), 8.2361, 4);
    expect_dist(
        &reroll,
        &brute_force_reroll_up_to(&oracle_dice(&[g(2, 6)]), 1, 1),
    );
    close(
        rd(1.0, d6())?.max_of(2.0)?.plus_roll(&d6())?.pmf()?.mean(),
        7.9722,
        4,
    );
    Ok(())
}

#[test]
fn single_group_pools_with_budgets() -> T {
    let with = |count, sides, minimum, reroll| Group {
        count,
        sides,
        minimum,
        reroll,
        minus: false,
    };
    let groups = [
        vec![g(3, 6)],
        vec![g(4, 4)],
        vec![g(3, 8)],
        vec![with(3, 6, 3, 0)],
        vec![with(3, 6, 0, 2)],
        vec![with(3, 8, 3, 1)],
        // A d5 face of 3 sits exactly on the mean: rerolling it gains nothing, so it stays.
        vec![g(3, 5)],
    ];
    for groups in &groups {
        for budget in [0usize, 1, 2, 3, 5] {
            expect_dist(
                &reroll_pmf(groups, budget as f64)?,
                &brute_force_reroll_up_to(&oracle_dice(groups), budget, 1),
            );
        }
    }
    Ok(())
}

#[test]
fn mixed_dice_with_budgets() -> T {
    let sub = |count, sides| Group {
        count,
        sides,
        minus: true,
        ..Group::default()
    };
    let groups = [
        vec![g(2, 6), g(1, 8)],
        vec![g(1, 8), g(2, 6)],
        vec![g(1, 6), g(1, 8)],
        vec![g(2, 4), g(1, 6), g(1, 10)],
        vec![
            Group {
                minimum: 2,
                ..g(2, 6)
            },
            Group {
                reroll: 1,
                ..g(2, 8)
            },
        ],
        vec![g(1, 6), g(1, 8), g(1, 6)],
        vec![g(3, 6), sub(1, 8)],
        vec![sub(2, 6), sub(2, 4), g(1, 8)],
    ];
    for groups in &groups {
        for budget in [1usize, 2, 3] {
            expect_dist(
                &reroll_pmf(groups, budget as f64)?,
                &brute_force_reroll_up_to(&oracle_dice(groups), budget, 1),
            );
        }
    }
    Ok(())
}

#[test]
fn does_not_depend_on_the_order_the_dice_were_added_in_even_where_gains_tie_across_kinds() -> T {
    // A d6 showing 1 and a d8 showing 2 both gain 2.5 from a reroll: one budget, two choices.
    let die_then_d8 = rd(1.0, d6())?
        .plus_roll(&rd(1.0, d8())?)?
        .reroll_up_to(1.0, None)?
        .pmf()?;
    let d8_then_die = rd(1.0, d8())?
        .plus_roll(&rd(1.0, d6())?)?
        .reroll_up_to(1.0, None)?
        .pmf()?;
    expect_dist(&die_then_d8, &dist_of(&d8_then_die));
    expect_dist(
        &die_then_d8,
        &brute_force_reroll_up_to(&oracle_dice(&[g(1, 6), g(1, 8)]), 1, 1),
    );
    Ok(())
}

#[test]
fn keeps_a_flat_outside_the_pool() -> T {
    let groups = [g(2, 6)];
    expect_dist(
        &pool(&groups, 5.0)?.reroll_up_to(1.0, None)?.pmf()?,
        &shifted(&brute_force_reroll_up_to(&oracle_dice(&groups), 1, 1), 5),
    );
    Ok(())
}

#[test]
fn a_subtracted_die_is_rerolled_when_it_shows_high() -> T {
    let groups = [
        g(1, 6),
        Group {
            minus: true,
            ..g(1, 6)
        },
    ];
    let reroll = reroll_pmf(&groups, 1.0)?;
    expect_dist(
        &reroll,
        &brute_force_reroll_up_to(&oracle_dice(&groups), 1, 1),
    );
    assert!(reroll.mean() > 0.0);
    Ok(())
}

/// Each die shows X; when X is below its mean it is replaced by a fresh roll, otherwise it stays.
fn per_die(faces: &Dist) -> Dist {
    let die_mean = mean_of(faces);
    let below: f64 = faces
        .iter()
        .filter(|(v, _)| (**v as f64) < die_mean)
        .map(|(_, p)| *p)
        .sum();
    faces
        .iter()
        .map(|(v, p)| {
            (
                *v,
                (if (*v as f64) < die_mean { 0.0 } else { *p }) + below * p,
            )
        })
        .collect()
}

fn total(faces: &Dist, dice: usize) -> Dist {
    let mut dist = Dist::from([(0, 1.0)]);
    for _ in 0..dice {
        let mut next = Dist::new();
        for (a, pa) in &dist {
            for (b, pb) in faces {
                *next.entry(a + b).or_insert(0.0) += pa * pb;
            }
        }
        dist = next;
    }
    dist
}

#[test]
fn a_budget_covering_every_die_is_the_per_die_must_use_reroll() -> T {
    // (sides, minimum, reroll, dice)
    for (sides, minimum, reroll, dice) in [
        (6, 0, 0, 4),
        (8, 0, 0, 3),
        (20, 0, 0, 3),
        (6, 3, 0, 4),
        (6, 0, 1, 4),
        (8, 3, 2, 3),
    ] {
        let groups = [Group {
            count: dice,
            sides,
            minimum,
            reroll,
            minus: false,
        }];
        let want = total(&per_die(&single_die(sides, minimum, reroll)), dice);
        expect_dist(&reroll_pmf(&groups, dice as f64)?, &want);
        expect_dist(&reroll_pmf(&groups, dice as f64 + 4.0)?, &want);
    }
    Ok(())
}

#[test]
fn is_reroll_f_on_each_die_f_the_faces_below_its_mean() -> T {
    expect_dist(
        &rd(4.0, d6())?.reroll_up_to(4.0, None)?.pmf()?,
        &dist_of(&rd(4.0, d6())?.reroll(3.0)?.pmf()?),
    );
    expect_dist(
        &rd(3.0, d8())?.reroll_up_to(3.0, None)?.pmf()?,
        &dist_of(&rd(3.0, d8())?.reroll(4.0)?.pmf()?),
    );
    expect_dist(
        &rd(3.0, d6())?
            .minimum(3.0)?
            .reroll_up_to(3.0, None)?
            .pmf()?,
        &dist_of(&rd(3.0, d6())?.minimum(3.0)?.reroll(3.0)?.pmf()?),
    );
    Ok(())
}

#[test]
fn a_budget_of_0_is_the_plain_roll() -> T {
    expect_dist(
        &rd(3.0, d6())?.plus(2.0)?.reroll_up_to(0.0, None)?.pmf()?,
        &dist_of(&rd(3.0, d6())?.plus(2.0)?.pmf()?),
    );
    Ok(())
}

#[test]
fn best_of_several_rolls_then_rerolled() -> T {
    let cases: Vec<(Vec<Group>, usize, usize)> = vec![
        (vec![g(2, 6)], 1, 2),
        (vec![g(3, 4)], 1, 2),
        (vec![g(3, 4)], 2, 2),
        (vec![g(2, 6)], 1, 3),
        (vec![g(1, 6), g(1, 8)], 1, 2),
        (vec![g(2, 4), g(1, 6)], 2, 2),
        (
            vec![
                Group {
                    minimum: 2,
                    ..g(2, 4)
                },
                Group {
                    minus: true,
                    ..g(1, 6)
                },
            ],
            1,
            2,
        ),
        (vec![g(3, 6)], 0, 2),
        // Three d6 with two rerolls: (4, 4, 4) and (1, 1, 5) are both worth 12 after their rerolls.
        (vec![g(3, 6)], 2, 2),
    ];
    for (groups, budget, rolls) in &cases {
        expect_dist(
            &pool(groups, 0.0)?
                .reroll_up_to(*budget as f64, Some(&opts(*rolls as f64)))?
                .pmf()?,
            &brute_force_reroll_up_to(&oracle_dice(groups), *budget, *rolls),
        );
    }
    Ok(())
}

#[test]
fn with_no_reroll_budget_it_is_the_best_of_the_rolls_by_total() -> T {
    expect_dist(
        &rd(3.0, d6())?.reroll_up_to(0.0, Some(&opts(2.0)))?.pmf()?,
        &dist_of(&rd(3.0, d6())?.max_of(2.0)?.pmf()?),
    );
    Ok(())
}

#[test]
fn one_roll_is_the_plain_reroll_pool() -> T {
    expect_dist(
        &rd(2.0, d6())?.reroll_up_to(1.0, Some(&opts(1.0)))?.pmf()?,
        &dist_of(&rd(2.0, d6())?.reroll_up_to(1.0, None)?.pmf()?),
    );
    Ok(())
}

#[test]
fn is_worth_more_than_one_roll_and_no_more_than_rerolling_every_roll_then_keeping_the_best() -> T {
    let base = || rd(2.0, d6())?.plus(3.0);
    let one = base()?.reroll_up_to(1.0, None)?.pmf()?.mean();
    let composed = base()?.reroll_up_to(1.0, Some(&opts(2.0)))?.pmf()?.mean();
    let reroll_both = base()?.reroll_up_to(1.0, None)?.max_of(2.0)?.pmf()?.mean();
    assert!(composed > one + 0.1);
    assert!(reroll_both > composed + 0.01);
    Ok(())
}

#[test]
fn the_roll_is_chosen_before_the_reroll_by_its_expected_total_after_the_reroll() -> T {
    // 1d8: a roll of 3 is worth 4.5 after its reroll and so is a 4; a 5 beats both.
    let reroll = rd(1.0, d8())?.reroll_up_to(1.0, Some(&opts(2.0)))?.pmf()?;
    expect_dist(
        &reroll,
        &brute_force_reroll_up_to(&oracle_dice(&[g(1, 8)]), 1, 2),
    );
    Ok(())
}

#[test]
fn builder_doubles_the_dice_on_a_crit_and_keeps_the_budget() -> T {
    let doubled = rd(2.0, d6())?
        .plus(3.0)?
        .reroll_up_to(1.0, None)?
        .double_dice()?;
    assert!(doubled.is_reroll_up_to());
    expect_dist(
        &doubled.pmf()?,
        &shifted(&brute_force_reroll_up_to(&oracle_dice(&[g(4, 6)]), 1, 1), 3),
    );
    expect_dist(
        &rd(1.0, d6())?
            .reroll_up_to(1.0, Some(&opts(2.0)))?
            .scale_dice(2.0)?
            .pmf()?,
        &brute_force_reroll_up_to(&oracle_dice(&[g(2, 6)]), 1, 2),
    );
    Ok(())
}

#[test]
fn builder_adds_a_roll_outside_the_pool() -> T {
    let together = rd(2.0, d6())?
        .reroll_up_to(1.0, None)?
        .plus_roll(&rd(1.0, d8())?)?
        .pmf()?;
    let apart = rd(2.0, d6())?.reroll_up_to(1.0, None)?.pmf()?.convolve(
        &rd(1.0, d8())?.pmf()?,
        None,
        false,
    );
    expect_dist(&together, &dist_of(&apart));
    close(
        together.mean(),
        rd(2.0, d6())?.reroll_up_to(1.0, None)?.pmf()?.mean() + 4.5,
        12,
    );
    Ok(())
}

#[test]
fn copies_of_a_pool_are_independent_pools() -> T {
    let twice = rd(2.0, d4().reroll_up_to(1.0, None)?)?.pmf()?;
    let once = d4().reroll_up_to(1.0, None)?.pmf()?;
    expect_dist(&twice, &dist_of(&once.convolve(&once, None, false)));
    Ok(())
}

#[test]
fn copy_keeps_the_pool() -> T {
    let pooled = rd(2.0, d6())?.reroll_up_to(1.0, Some(&opts(2.0)))?;
    expect_dist(&pooled.copy()?.pmf()?, &dist_of(&pooled.pmf()?));
    Ok(())
}

#[test]
fn refuses_a_budget_or_roll_count_that_is_not_a_whole_number() -> T {
    let two = || rd(2.0, d6());
    throws(two()?.reroll_up_to(-1.0, None), "non-negative integer");
    throws(two()?.reroll_up_to(1.5, None), "non-negative integer");
    throws(two()?.reroll_up_to(f64::NAN, None), "NaN");
    throws(two()?.reroll_up_to(f64::INFINITY, None), "finite");
    throws(
        two()?.reroll_up_to(1.0, Some(&opts(0.0))),
        "positive integer",
    );
    throws(
        two()?.reroll_up_to(1.0, Some(&opts(1.5))),
        "positive integer",
    );
    Ok(())
}

#[test]
fn refuses_dice_a_reroll_has_no_single_meaning_for() -> T {
    let two = || rd(2.0, d6());
    throws(two()?.explode(1.0)?.reroll_up_to(1.0, None), "exploding");
    throws(
        two()?.explode_pool(1.0)?.reroll_up_to(1.0, None),
        "exploding",
    );
    throws(
        rd(4.0, d6())?
            .keep_highest(4.0, 3.0)?
            .reroll_up_to(1.0, None),
        "keep",
    );
    throws(rd(4.0, d6())?.best_of(3.0)?.reroll_up_to(1.0, None), "keep");
    throws(
        two()?.with_advantage()?.reroll_up_to(1.0, None),
        "advantage",
    );
    throws(
        two()?.keep_highest(2.0, 1.0)?.reroll_up_to(1.0, None),
        "keep",
    );
    Ok(())
}

#[test]
fn refuses_a_roll_that_is_already_transformed_pooled_or_parsed() -> T {
    let two = || rd(2.0, d6());
    throws(two()?.half()?.reroll_up_to(1.0, None), "Cannot rerollUpTo");
    throws(
        two()?.max_of(2.0)?.reroll_up_to(1.0, None),
        "Cannot rerollUpTo",
    );
    throws(
        two()?.keep_highest_all(2.0, 1.0)?.reroll_up_to(1.0, None),
        "Cannot rerollUpTo",
    );
    throws(
        RollBuilder::from_args(&[Arg::Str("2d6+3".to_string())])?.reroll_up_to(1.0, None),
        "Cannot rerollUpTo",
    );
    throws(
        two()?.reroll_up_to(1.0, None)?.reroll_up_to(1.0, None),
        "already has a rerollUpTo\\(\\) pool",
    );
    throws(
        two()?.reroll_up_to(1.0, None)?.reroll(1.0),
        "Cannot change the dice",
    );
    Ok(())
}

#[test]
fn roll_has_no_string_spelling() -> T {
    throws(
        rd(2.0, d6())?.reroll_up_to(1.0, None)?.to_expression(),
        "rerollUpTo",
    );
    Ok(())
}

fn attack() -> Result<crate::builder::roll::RollBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)
}

#[test]
fn attack_runs_through_a_turn() -> T {
    let mut want = expect(
        FILE,
        "rerollDamageUpTo: attack base payload > runs through a Turn",
    );
    let rerolled = attack()?
        .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?
        .reroll_damage_up_to(1.0, None)?;
    close(
        want.mean(&turn(vec![atk(rerolled.clone())], 0.0)?),
        rerolled.pmf()?.mean(),
        12,
    );
    let saved = want.mean(
        &turn(vec![atk(rerolled.clone())], 0.0)?
            .on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())?,
    );
    assert!(saved > rerolled.pmf()?.mean());
    want.done();
    Ok(())
}

// ---- existing behaviour is unchanged ----

/// FIPS 180-4 SHA-1 (the TS test digests with `node:crypto`).
fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6u32),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (slot, v) in h.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(v);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// `JSON.stringify(pmfs.map(pmf => support sorted.map(v => [v, pAt, outcomeAt hit, outcomeAt crit])))`.
fn digest(pmfs: &[Pmf]) -> String {
    let body: Vec<String> = pmfs
        .iter()
        .map(|pmf| {
            let mut support: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
            support.sort_by(f64::total_cmp);
            let rows: Vec<String> = support
                .iter()
                .map(|v| {
                    format!(
                        "[{},{},{},{}]",
                        num_to_string(*v),
                        num_to_string(pmf.p_at(*v)),
                        num_to_string(pmf.outcome_at(*v, "hit")),
                        num_to_string(pmf.outcome_at(*v, "crit"))
                    )
                })
                .collect();
            format!("[{}]", rows.join(","))
        })
        .collect();
    sha1_hex(format!("[{}]", body.join(",")).as_bytes())
}

#[test]
fn resolves_the_same_bits_for_attacks_pools_keeps_and_rerolls_without_a_reroll_budget() -> T {
    let mut want = expect(
        FILE,
        "existing behaviour is unchanged > resolves the same bits for attacks, pools, keeps and rerolls without a reroll budget",
    );
    let check = || d20().plus(7.0)?.ac(14.0);
    let on_hit =
        |count: f64, die: RollBuilder| check()?.on_hit_args(&[Arg::Num(count), Arg::Roll(die)]);
    let hit_roll = |r: RollBuilder| check()?.on_hit(r);
    let last = turn(vec![atk(on_hit(2.0, d6())?), atk(on_hit(1.0, d8())?)], 0.0)?
        .on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())?;
    let pmfs = [
        hit_roll(rd(2.0, d6())?.plus(3.0)?)?.pmf()?,
        hit_roll(rd(3.0, d8())?.plus(2.0)?)?.no_crit()?.pmf()?,
        hit_roll(rd(2.0, d6())?.plus(3.0)?.keep_highest_all(2.0, 1.0)?)?.pmf()?,
        hit_roll(rd(2.0, d10())?.plus(4.0)?)?
            .on_crit(&[Arg::Num(3.0), Arg::Roll(d10())])?
            .on_miss(&[Arg::Num(1.0), Arg::Roll(d4())])?
            .pmf()?,
        on_hit(2.0, d6())?
            .reroll_damage(2.0)?
            .minimum_damage_die(2.0)?
            .plus_separate_damage(rd(1.0, d4())?)
            .half_on_miss()?
            .pmf()?,
        d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(12.0)?
            .on_hit(rd(1.0, d8())?.max_of(2.0)?.plus(3.0)?)?
            .pmf()?,
        rd(4.0, d6())?.keep_highest(4.0, 3.0)?.plus(1.0)?.pmf()?,
        rd(3.0, d6())?.reroll(2.0)?.minimum(2.0)?.pmf()?,
        want.pmf(&last),
    ];
    assert_eq!(digest(&pmfs), "0baa42379c5f4006b5a439d9a582e1d4e21d8d92");
    want.done();
    Ok(())
}
