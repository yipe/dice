//! `tests/turn-convert-first-miss.test.ts`: 10 tests, 0 compat calls (the TS test records none).
//!
//! The brute-force oracle (`tests/oracle/bruteForce.ts`, `oracleTurnToSpec`) has no Rust port. The
//! three tests that compare against it use a small local enumerator of the same rules over
//! `THREE_ROWS` (`Enumerated` below) and build the turn through the chaining verbs the oracle's spec
//! spells (rows are `row:k`, the substitute is `convert`).
//! Not translated: tests/turn-convert-first-miss.test.ts:92: `oracleTurnToSpec` itself; the test
//! pins the same `{ id: "convert", on: "first-miss", substitute: "hit", of: ["row:0"] }` through
//! `Turn::inspect_spec()` of the chained spelling instead.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions, advantage};
use crate::turn::types::{
    RiderOptions, SubstituteKind, SubstituteOn, SubstitutePolicy, SubstituteSpec, TurnSpec,
    TurnSpecErrorCode,
};
use crate::turn::{Turn, turn};

type R<X> = Result<X, Box<dyn std::error::Error>>;

const CONVERT_ID: &str = "convert";

fn a() -> R<AttackBuilder> {
    Ok(attack_roll(6.0, 15.0, rs(2.0, 6.0)?.plus(5.0)?)?)
}
fn b() -> R<AttackBuilder> {
    a()
}
fn c() -> R<AttackBuilder> {
    Ok(attack_roll(4.0, 15.0, rs(2.0, 10.0)?.plus(9.0)?)?)
}

fn miss_of(attack: &AttackBuilder) -> R<f64> {
    Ok(attack.resolve(0.0)?.weights.miss)
}

fn abc() -> R<Turn> {
    Ok(turn(vec![atk(a()?), atk(b()?), atk(c()?)], 0.0)?)
}

// ---- the oracle's rows -----------------------------------------------------------------------------

/// `attack({ toHit, damage: { count, sides, flat } })`: a melee attack against AC 15.
#[derive(Clone, Copy)]
struct Row {
    to_hit: f64,
    count: usize,
    sides: usize,
    flat: usize,
}

/// 60% / 60% / 50% to land against AC 15, distinct damage.
const THREE_ROWS: [Row; 3] = [
    Row {
        to_hit: 6.0,
        count: 2,
        sides: 6,
        flat: 5,
    },
    Row {
        to_hit: 6.0,
        count: 1,
        sides: 10,
        flat: 4,
    },
    Row {
        to_hit: 4.0,
        count: 2,
        sides: 10,
        flat: 9,
    },
];

const SIZE: usize = 256;

fn dice_total(count: usize, sides: usize, flat: usize) -> Vec<f64> {
    let mut dist = vec![0.0; SIZE];
    dist[flat] = 1.0;
    for _ in 0..count {
        let mut next = vec![0.0; SIZE];
        for (total, p) in dist.iter().enumerate() {
            if *p == 0.0 {
                continue;
            }
            for face in 1..=sides {
                next[total + face] += p / sides as f64;
            }
        }
        dist = next;
    }
    dist
}

fn convolve(x: &[f64], y: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; SIZE];
    for (i, p) in x.iter().enumerate() {
        if *p == 0.0 {
            continue;
        }
        for (j, q) in y.iter().enumerate() {
            if *q != 0.0 && i + j < SIZE {
                out[i + j] += p * q;
            }
        }
    }
    out
}

/// `[miss, hit, crit]` of one d20 (natural 1 always misses, natural 20 always crits), or of the
/// better of two when `with_advantage`.
fn odds(row: Row, with_advantage: bool) -> [f64; 3] {
    let mut single = [0.0; 3];
    for r in 1..=20 {
        let r = f64::from(r);
        let mode = if r == 20.0 {
            2
        } else if r == 1.0 || r + row.to_hit < 15.0 {
            0
        } else {
            1
        };
        single[mode] += 1.0 / 20.0;
    }
    if !with_advantage {
        return single;
    }
    let miss = single[0] * single[0];
    let crit = 1.0 - (1.0 - single[2]) * (1.0 - single[2]);
    [miss, 1.0 - miss - crit, crit]
}

/// What the local enumerator is asked to apply over the three rows.
#[derive(Default)]
struct Enumerated {
    /// Rows whose first miss converts to a plain hit.
    convert_of: Vec<usize>,
    /// A first-hit `3d6` rider over every row (doubled on a crit).
    sneak: bool,
    /// Advantage on the next attack after a landing on row 0 or 1.
    vex: bool,
}

impl Enumerated {
    /// The joint damage distribution, by exact enumeration of every row's outcome.
    fn pmf(&self) -> Vec<f64> {
        // State: (conversion spent, sneak spent, advantage pending) -> damage distribution (unnormalised).
        type State = (bool, bool, bool);
        let mut start = vec![0.0; SIZE];
        start[0] = 1.0;
        let mut states: Vec<(State, Vec<f64>)> = vec![((false, false, false), start)];
        for (k, row) in THREE_ROWS.iter().enumerate() {
            let hit = dice_total(row.count, row.sides, row.flat);
            let crit = dice_total(row.count * 2, row.sides, row.flat);
            let sneak_hit = dice_total(3, 6, 0);
            let sneak_crit = dice_total(6, 6, 0);
            let mut next: Vec<(State, Vec<f64>)> = Vec::new();
            let mut add = |state: State, dist: Vec<f64>| {
                if let Some((_, existing)) = next.iter_mut().find(|(s, _)| *s == state) {
                    for (e, d) in existing.iter_mut().zip(dist) {
                        *e += d;
                    }
                } else {
                    next.push((state, dist));
                }
            };
            for ((converted, sneaked, advantaged), dist) in &states {
                let o = odds(*row, *advantaged);
                for (mode, p) in o.iter().enumerate() {
                    if *p == 0.0 {
                        continue;
                    }
                    let (mut mode, mut converted_now) = (mode, *converted);
                    if mode == 0 && !*converted && self.convert_of.contains(&k) {
                        mode = 1;
                        converted_now = true;
                    }
                    let landed = mode != 0;
                    let mut payload = match mode {
                        1 => hit.clone(),
                        2 => crit.clone(),
                        _ => {
                            let mut zero = vec![0.0; SIZE];
                            zero[0] = 1.0;
                            zero
                        }
                    };
                    let mut sneaked_now = *sneaked;
                    if self.sneak && landed && !*sneaked {
                        payload =
                            convolve(&payload, if mode == 2 { &sneak_crit } else { &sneak_hit });
                        sneaked_now = true;
                    }
                    let advantage_next = self.vex && landed && k < 2;
                    let scaled: Vec<f64> = convolve(dist, &payload).iter().map(|x| x * p).collect();
                    add((converted_now, sneaked_now, advantage_next), scaled);
                }
            }
            states = next;
        }
        let mut total = vec![0.0; SIZE];
        for (_, dist) in states {
            for (t, d) in total.iter_mut().zip(dist) {
                *t += d;
            }
        }
        total
    }
}

fn expect_pmf(actual: &Pmf, expected: &[f64]) {
    for (value, p) in expected.iter().enumerate() {
        let diff = (actual.p_at(value as f64) - p).abs();
        assert!(diff <= 1e-12, "at {value}: {diff}");
    }
    for value in actual.support() {
        let expected_p = expected.get(value.0 as usize).copied().unwrap_or(0.0);
        assert!(
            (actual.p_at(value.0) - expected_p).abs() <= 1e-12,
            "at {}",
            value.0
        );
    }
}

fn row_source(row: Row) -> R<AttackBuilder> {
    Ok(attack_roll(
        row.to_hit,
        15.0,
        rs(row.count as f64, row.sides as f64)?.plus(row.flat as f64)?,
    )?)
}

/// The rows as the oracle's spec declares them: `row:0`, `row:1`, `row:2`.
fn three_rows() -> R<Turn> {
    let attacks = THREE_ROWS
        .iter()
        .enumerate()
        .map(|(k, row)| Ok(named(&format!("row:{k}"), row_source(*row)?)))
        .collect::<R<Vec<_>>>()?;
    Ok(turn(attacks, 0.0)?)
}

fn row_ids(of: &[usize]) -> Vec<String> {
    of.iter().map(|k| format!("row:{k}")).collect()
}

fn convert(turn: &Turn, of: &[usize]) -> Result<Turn, DiceError> {
    let ids = row_ids(of);
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    turn.convert_first_miss(Some(CONVERT_ID), Some(&refs))
}

fn of_rows(of: &[usize]) -> RiderOptions {
    RiderOptions {
        of: Some(row_ids(of)),
        ..RiderOptions::default()
    }
}

#[test]
fn matches_the_enumerators_joint_pmf_on_three_rows_with_distinct_odds_and_damage() -> T {
    for of in [vec![0, 1, 2], vec![1, 2], vec![0]] {
        let converted = convert(&three_rows()?, &of)?;
        let oracle = Enumerated {
            convert_of: of.clone(),
            ..Enumerated::default()
        };
        expect_pmf(&converted.pmf()?, &oracle.pmf());
    }
    Ok(())
}

#[test]
fn adds_the_first_misss_hit_once_the_specs_11_28_example() -> T {
    let plain = abc()?;
    let converted = plain.convert_first_miss(Some("boon"), None)?;
    close(
        converted.mean()? - plain.mean()?,
        0.4 * 12.0 + 0.6 * 0.4 * 12.0 + 0.6 * 0.6 * 0.5 * 20.0,
        12,
    );
    // Spent exactly when some row missed.
    close(
        converted.fire_probability("boon")?,
        1.0 - 0.6 * 0.6 * 0.5,
        12,
    );
    Ok(())
}

#[test]
fn converts_a_natural_1_even_where_only_a_natural_20_hits() -> T {
    let hopeless = attack_roll(0.0, 30.0, rs(1.0, 8.0)?.plus(3.0)?)?;
    close(
        turn(vec![atk(hopeless)], 0.0)?
            .convert_first_miss(None, None)?
            .mean()?,
        0.05 * 12.0 + 0.95 * 7.5,
        12,
    );
    let sure = attack_roll(20.0, 15.0, rs(1.0, 8.0)?.plus(3.0)?)?;
    close(
        turn(vec![atk(sure)], 0.0)?
            .convert_first_miss(None, None)?
            .mean()?,
        0.05 * 12.0 + 0.95 * 7.5,
        12,
    );
    Ok(())
}

#[test]
fn converts_to_a_plain_hit_where_every_hit_crits() -> T {
    let paralyzed = d20()
        .plus(5.0)?
        .ac(15.0)?
        .always_crits()?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?;
    close(
        turn(vec![atk(paralyzed)], 0.0)?
            .convert_first_miss(None, None)?
            .mean()?,
        0.55 * 12.0 + 0.45 * 7.5,
        12,
    );
    Ok(())
}

#[test]
fn is_never_a_crit_the_crit_odds_and_a_crit_only_rider_are_unchanged() -> T {
    let plain = abc()?.on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?;
    let converted = abc()?
        .convert_first_miss(None, None)?
        .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?;
    close(
        converted.fire_probability("smite")?,
        plain.fire_probability("smite")?,
        12,
    );
    close(
        converted.marginal("smite")?.pmf().mean(),
        plain.marginal("smite")?.pmf().mean(),
        12,
    );
    Ok(())
}

#[test]
fn converts_only_the_miss_left_after_advantage_or_a_reroll() -> T {
    let advantaged = d20()
        .with_advantage()?
        .plus(6.0)?
        .ac(15.0)?
        .on_hit(rs(2.0, 6.0)?.plus(5.0)?)?;
    close(miss_of(&advantaged)?, 0.16, 12);
    close(
        turn(vec![atk(advantaged.clone())], 0.0)?
            .convert_first_miss(None, None)?
            .mean()?
            - advantaged.mean()?,
        0.16 * 12.0,
        12,
    );
    Ok(())
}

#[test]
fn lands_sneak_attack_on_the_converted_row_when_it_is_the_first_landing_and_not_again() -> T {
    let sneak = rs(3.0, 6.0)?;
    let rows = [0, 1, 2];
    let chained = three_rows()?.on_first_hit_with(
        sneak.clone(),
        FirstHitOptions {
            condition: ConditionOptions {
                rider: of_rows(&rows),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;
    let converted = convert(&chained, &rows)?;
    let oracle = Enumerated {
        convert_of: rows.to_vec(),
        sneak: true,
        ..Enumerated::default()
    };
    expect_pmf(&converted.pmf()?, &oracle.pmf());
    // With a conversion over every row, something always lands: Sneak Attack always fires.
    close(
        abc()?
            .convert_first_miss(None, None)?
            .on_first_hit_with(sneak, first_hit_id("sa"))?
            .fire_probability("sa")?,
        1.0,
        12,
    );
    Ok(())
}

#[test]
fn feeds_grants_later_rows_read_the_state_with_or_without_the_conversion() -> T {
    let chained = three_rows()?.on_every_hit_with(
        advantage().until_next_attack(),
        EveryHitOptions {
            first_hit: FirstHitOptions {
                condition: ConditionOptions {
                    rider: of_rows(&[0, 1]),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
            max: None,
        },
    )?;
    let converted = convert(&chained, &[0, 1, 2])?;
    let oracle = Enumerated {
        convert_of: vec![0, 1, 2],
        vex: true,
        ..Enumerated::default()
    };
    expect_pmf(&converted.pmf()?, &oracle.pmf());
    Ok(())
}

#[test]
fn starts_fresh_on_a_reaction_which_is_a_turn_of_its_own() -> T {
    let action = turn(vec![atk(a()?), atk(b()?)], 0.0)?.convert_first_miss(None, None)?;
    let reaction = turn(vec![atk(c()?)], 0.0)?.convert_first_miss(None, None)?;
    // The reaction converts its own miss whether or not the action spent the conversion.
    close(reaction.mean()? - c()?.mean()?, 0.5 * 20.0, 12);
    assert!(action.mean()? + reaction.mean()? > abc()?.convert_first_miss(None, None)?.mean()?);
    Ok(())
}

/// `refused(build)`: the code of the `TurnSpecError` raised by building and reading the turn.
fn refused(build: impl FnOnce() -> R<Turn>) -> TurnSpecErrorCode {
    let result = build()
        .map_err(|e| match e.downcast::<DiceError>() {
            Ok(plan) => *plan,
            Err(other) => DiceError::Error(other.to_string()),
        })
        .and_then(|t| t.mean().map(|_| t));
    spec_code(result)
}

fn chain(r: Result<Turn, DiceError>) -> R<Turn> {
    Ok(r?)
}

#[test]
fn is_a_substitute_in_the_spec_and_refuses_what_it_cannot_convert() -> T {
    let spec = convert(&three_rows()?, &[0])?.inspect_spec();
    assert_eq!(
        spec.substitutes,
        Some(vec![SubstituteSpec {
            id: Some(CONVERT_ID.to_string()),
            on: SubstituteOn::FirstMiss,
            of: Some(vec!["row:0".to_string()]),
            substitute: SubstituteKind::Hit,
            mode: None,
            policy: None,
        }])
    );

    let fireball = d20()
        .plus(3.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()?;
    assert_eq!(
        refused(|| chain(turn(vec![atk(fireball)], 0.0)?.convert_first_miss(None, None))),
        TurnSpecErrorCode::NotAnAttack
    );
    let reroll_first =
        || chain(turn(vec![atk(a()?)], 0.0)?.on_first_miss_with(a()?, rid("reroll")));
    assert_eq!(
        refused(|| chain(reroll_first()?.convert_first_miss(None, Some(&["attack 1"])))),
        TurnSpecErrorCode::UnsupportedTrigger
    );
    assert!(
        reroll_first()?
            .convert_first_miss(None, Some(&["reroll"]))?
            .mean()?
            > reroll_first()?.mean()?
    );
    assert_eq!(
        refused(|| chain(
            turn(vec![atk(a()?), atk(b()?)], 0.0)?
                .on_any_miss_with(a()?, rid("reroll"))?
                .convert_first_miss(None, Some(&["reroll"]))
        )),
        TurnSpecErrorCode::UnsupportedTrigger
    );
    assert_eq!(
        refused(|| chain(Turn::from_spec(
            TurnSpec {
                attacks: vec![atk(a()?)],
                substitutes: Some(vec![SubstituteSpec {
                    id: None,
                    on: SubstituteOn::FirstMiss,
                    of: None,
                    substitute: SubstituteKind::Hit,
                    mode: None,
                    policy: Some(SubstitutePolicy::Always),
                }]),
                ..TurnSpec::default()
            },
            0.0
        ))),
        TurnSpecErrorCode::UnsupportedPolicy
    );
    assert_eq!(
        refused(|| chain(
            turn(vec![atk(a()?)], 0.0)?
                .convert_first_miss(None, None)?
                .convert_first_miss(None, None)
        )),
        TurnSpecErrorCode::DuplicateSubstitute
    );
    Ok(())
}
