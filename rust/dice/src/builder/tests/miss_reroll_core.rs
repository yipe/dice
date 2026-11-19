//! `src/builder/miss-reroll.test.ts` (pinned odds, expression round trip) and
//! `miss-reroll-guards.test.ts`: the cases that need only the check's dice and its AC, crit
//! threshold and crit-on-hit rule (the AC check itself is a later task, so the rule is given as
//! [`CritCheckParts`]). The attack-level assertions (`resolve`, `mean`, `sample`) are deferred.

use super::support::*;
use crate::builder::factory::*;
use crate::builder::miss_reroll::{
    MissRerollOdds, miss_reroll_check_expression_with, miss_reroll_odds_with,
};
use crate::builder::roll::{CritCheckParts, RollBuilder};
use crate::builder::types::MissRerollMode;
use crate::error::DiceError;
use crate::parser::parse;
use std::collections::BTreeMap;

const TOLERANCE: f64 = 1e-12;

fn ac_check(ac: f64, crit_threshold: f64) -> CritCheckParts {
    CritCheckParts {
        ac: Some(ac),
        crit_threshold,
        crit_on_hit: false,
    }
}

/// `tests/oracle/missReroll.ts`' `RowCase`.
#[derive(Clone)]
struct RowCase {
    to_hit: f64,
    dice: Vec<(u32, u32, f64)>,
    ac: f64,
    crit_range: f64,
    /// 1, 2 (advantage), 3 (elven) rolled; `disadvantage` takes the lowest.
    rolled: usize,
    disadvantage: bool,
    reroll_ones: bool,
    auto_crit: bool,
    mode: MissRerollMode,
}

fn die_faces(reroll_ones: bool) -> Vec<(f64, f64)> {
    let mut faces: BTreeMap<u32, f64> = BTreeMap::new();
    for first in 1..=20u32 {
        if first == 1 && reroll_ones {
            for again in 1..=20u32 {
                *faces.entry(again).or_insert(0.0) += 1.0 / 400.0;
            }
        } else {
            *faces.entry(first).or_insert(0.0) += 1.0 / 20.0;
        }
    }
    faces.into_iter().map(|(f, p)| (f64::from(f), p)).collect()
}

fn bonus_totals(c: &RowCase) -> Vec<(f64, f64)> {
    let mut totals: Vec<(f64, f64)> = vec![(c.to_hit, 1.0)];
    for (count, sides, sign) in &c.dice {
        for _ in 0..*count {
            let mut next: Vec<(f64, f64)> = Vec::new();
            for (total, p) in &totals {
                for face in 1..=*sides {
                    let value = total + sign * f64::from(face);
                    let share = p / f64::from(*sides);
                    match next.iter_mut().find(|(v, _)| *v == value) {
                        Some(e) => e.1 += share,
                        None => next.push((value, share)),
                    }
                }
            }
            totals = next;
        }
    }
    totals
}

#[derive(PartialEq)]
enum Out {
    Miss,
    Hit,
    Crit,
}

fn outcome(c: &RowCase, face: f64, bonus: f64) -> Out {
    if face == 20.0 {
        return Out::Crit;
    }
    if face == 1.0 || face + bonus < c.ac {
        return Out::Miss;
    }
    if c.auto_crit || face >= c.crit_range {
        Out::Crit
    } else {
        Out::Hit
    }
}

fn kept(c: &RowCase, dice: &[f64]) -> f64 {
    if c.disadvantage {
        dice.iter().copied().fold(f64::INFINITY, f64::min)
    } else {
        dice.iter().copied().fold(f64::NEG_INFINITY, f64::max)
    }
}

fn visit(
    c: &RowCase,
    dist: &[(f64, f64)],
    dice: &mut Vec<f64>,
    p: f64,
    bonus: f64,
    p_bonus: f64,
    out: &mut MissRerollOdds,
) {
    if dice.len() < c.rolled {
        for (face, p_face) in dist {
            dice.push(*face);
            visit(c, dist, dice, p * p_face, bonus, p_bonus, out);
            dice.pop();
        }
        return;
    }
    if outcome(c, kept(c, dice), bonus) != Out::Miss {
        return;
    }
    for (again, p_again) in dist {
        let next = if c.mode == MissRerollMode::AddD20 {
            dice.iter().copied().fold(*again, f64::max)
        } else {
            // The kept die is replaced: the others still count.
            let kept_face = kept(c, dice);
            let mut others = dice.clone();
            if let Some(at) = others.iter().position(|x| *x == kept_face) {
                others.remove(at);
            }
            others.push(*again);
            kept(c, &others)
        };
        let weight = p * p_again * p_bonus;
        match outcome(c, next, bonus) {
            Out::Miss => out.miss += weight,
            Out::Hit => out.hit += weight,
            Out::Crit => {
                out.crit += weight;
                if next == 20.0 {
                    out.natural20 += weight;
                }
            }
        }
    }
}

/// `rowOdds`: brute force over every die face.
fn row_odds(c: &RowCase) -> MissRerollOdds {
    let dist = die_faces(c.reroll_ones);
    let mut out = MissRerollOdds {
        miss: 0.0,
        hit: 0.0,
        crit: 0.0,
        natural20: 0.0,
    };
    for (bonus, p_bonus) in bonus_totals(c) {
        visit(c, &dist, &mut Vec::new(), 1.0, bonus, p_bonus, &mut out);
    }
    out
}

struct Pinned {
    name: &'static str,
    check: RollBuilder,
    parts: CritCheckParts,
    mode: MissRerollMode,
    row: RowCase,
    rerolled_hit: f64,
    rerolled_crit: f64,
}

fn row(to_hit: f64, dice: &[(u32, u32, f64)], ac: f64, crit_range: f64, rolled: usize) -> RowCase {
    RowCase {
        to_hit,
        dice: dice.to_vec(),
        ac,
        crit_range,
        rolled,
        disadvantage: false,
        reroll_ones: false,
        auto_crit: false,
        mode: MissRerollMode::AddD20,
    }
}

fn cases() -> Result<Vec<Pinned>, DiceError> {
    let b1d4 = [(1, 4, 1.0)];
    let with = |r: RowCase, f: &dyn Fn(&mut RowCase)| {
        let mut r = r;
        f(&mut r);
        r
    };
    Ok(vec![
        Pinned {
            name: "A flat +5 +1d4 vs 15, add-d20",
            check: d20().plus(5.0)?.plus_roll(&d4())?,
            parts: ac_check(15.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: row(5.0, &b1d4, 15.0, 20.0, 1),
            rerolled_hit: 0.2,
            rerolled_crit: 0.01625,
        },
        Pinned {
            name: "C flat +6 vs 15, add-d20",
            check: d20().plus(6.0)?,
            parts: ac_check(15.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: row(6.0, &[], 15.0, 20.0, 1),
            rerolled_hit: 0.22,
            rerolled_crit: 0.02,
        },
        Pinned {
            name: "D disadvantage +5 +1d4 vs 15, reroll",
            check: d20().plus(5.0)?.plus_roll(&d4())?.with_disadvantage()?,
            parts: ac_check(15.0, 20.0),
            mode: MissRerollMode::Reroll,
            row: with(row(5.0, &b1d4, 15.0, 20.0, 2), &|r| {
                r.disadvantage = true;
                r.mode = MissRerollMode::Reroll;
            }),
            rerolled_hit: 0.288125,
            rerolled_crit: 0.001625,
        },
        Pinned {
            name: "E disadvantage +5 +1d4 vs 15, add-d20",
            check: d20().plus(5.0)?.plus_roll(&d4())?.with_disadvantage()?,
            parts: ac_check(15.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: with(row(5.0, &b1d4, 15.0, 20.0, 2), &|r| r.disadvantage = true),
            rerolled_hit: 0.4459375,
            rerolled_crit: 0.0579375,
        },
        Pinned {
            name: "F advantage +7 +1d4 +1d12 vs 20, add-d20",
            check: d20()
                .plus(7.0)?
                .plus_roll(&d4())?
                .plus_roll(&d12())?
                .with_advantage()?,
            parts: ac_check(20.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: row(7.0, &[(1, 4, 1.0), (1, 12, 1.0)], 20.0, 20.0, 2),
            rerolled_hit: 0.032260416666667,
            rerolled_crit: 0.002677083333333,
        },
        Pinned {
            name: "G elven accuracy +5 vs 18, crit 19, reroll",
            check: d20().plus(5.0)?.with_elven_accuracy()?,
            parts: ac_check(18.0, 19.0),
            mode: MissRerollMode::Reroll,
            row: with(row(5.0, &[], 18.0, 19.0, 3), &|r| {
                r.mode = MissRerollMode::Reroll;
            }),
            rerolled_hit: 0.0648,
            rerolled_crit: 0.0216,
        },
        Pinned {
            name: "H halfling +4 -1d4 vs 14, add-d20",
            check: hd20().plus(4.0)?.minus_roll(&d4())?,
            parts: ac_check(14.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: with(row(4.0, &[(1, 4, -1.0)], 14.0, 20.0, 1), &|r| {
                r.reroll_ones = true;
            }),
            rerolled_hit: 0.21459375,
            rerolled_crit: 0.029071875,
        },
        Pinned {
            name: "I flat +6 +1d4 vs 26, crit 19, add-d20",
            check: d20().plus(6.0)?.plus_roll(&d4())?,
            parts: ac_check(26.0, 19.0),
            mode: MissRerollMode::AddD20,
            row: row(6.0, &b1d4, 26.0, 19.0, 1),
            rerolled_hit: 0.05875,
            rerolled_crit: 0.0825,
        },
        Pinned {
            name: "A-adv advantage +5 +1d4 vs 15, add-d20",
            check: d20().plus(5.0)?.plus_roll(&d4())?.with_advantage()?,
            parts: ac_check(15.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: row(5.0, &b1d4, 15.0, 20.0, 2),
            rerolled_hit: 0.0659375,
            rerolled_crit: 0.0054375,
        },
        Pinned {
            name: "A-elven elven accuracy +5 +1d4 vs 15, add-d20",
            check: d20().plus(5.0)?.plus_roll(&d4())?.with_elven_accuracy()?,
            parts: ac_check(15.0, 20.0),
            mode: MissRerollMode::AddD20,
            row: row(5.0, &b1d4, 15.0, 20.0, 3),
            rerolled_hit: 0.022353125,
            rerolled_crit: 0.00186875,
        },
    ])
}

/// miss-reroll.test.ts:171 ("rerollMisses: pinned odds, each checked against the oracle"): the
/// `missRerollOdds` half of every case (`odds.hit`/`odds.crit` pinned, every key within 1e-12 of
/// the oracle). The attack `resolve()`/`mean()` half is deferred.
#[test]
fn pinned_odds_match_the_oracle() -> T {
    for c in cases()? {
        let odds = miss_reroll_odds_with(&c.check, &c.parts, c.mode, 0.0)?;
        assert_close(odds.hit, c.rerolled_hit, 12);
        assert_close(odds.crit, c.rerolled_crit, 12);
        let oracle = row_odds(&c.row);
        for (key, got, want) in [
            ("hit", odds.hit, oracle.hit),
            ("crit", odds.crit, oracle.crit),
            ("miss", odds.miss, oracle.miss),
            ("natural20", odds.natural20, oracle.natural20),
        ] {
            assert!(
                (got - want).abs() < TOLERANCE,
                "{} {key}: {got} vs oracle {want}",
                c.name
            );
        }
    }
    Ok(())
}

/// miss-reroll.test.ts:196 ("J: crit on hit, reroll"): the odds half (`oracle.crit`, 0.21625).
#[test]
fn crit_on_hit_reroll_odds_match_the_oracle() -> T {
    let check = d20().plus(5.0)?.plus_roll(&d4())?;
    let parts = CritCheckParts {
        ac: Some(15.0),
        crit_threshold: 20.0,
        crit_on_hit: true,
    };
    let mut r = row(5.0, &[(1, 4, 1.0)], 15.0, 20.0, 1);
    r.auto_crit = true;
    r.mode = MissRerollMode::Reroll;
    let oracle = row_odds(&r);
    let odds = miss_reroll_odds_with(&check, &parts, MissRerollMode::Reroll, 0.0)?;
    assert!((odds.crit - oracle.crit).abs() < TOLERANCE);
    assert_close(oracle.crit, 0.21625, 12);
    Ok(())
}

/// miss-reroll.test.ts:226/289/295 (guards of `rerollMisses()`): a check with no d20 is refused.
#[test]
fn refuses_a_check_with_no_d20() -> T {
    let e = err_of(miss_reroll_odds_with(
        &flat(5.0)?,
        &ac_check(10.0, 20.0),
        MissRerollMode::AddD20,
        0.0,
    ));
    assert!(e.contains("d20"), "{e}");
    Ok(())
}

/// miss-reroll-guards.test.ts:6, :10.
#[test]
fn refuses_a_d20_minimum_above_20_and_an_exploding_d20() -> T {
    let parts = ac_check(50.0, 20.0);
    let e = err_of(miss_reroll_odds_with(
        &d20().minimum(21.0)?,
        &parts,
        MissRerollMode::AddD20,
        0.0,
    ));
    assert!(e.contains("rerollMisses") && e.contains("minimum"), "{e}");
    let e = err_of(miss_reroll_odds_with(
        &d20().explode(1.0)?,
        &ac_check(15.0, 20.0),
        MissRerollMode::AddD20,
        0.0,
    ));
    assert!(e.contains("rerollMisses") && e.contains("explodes"), "{e}");
    Ok(())
}

/// miss-reroll-guards.test.ts:14: a kept-one bonus pool has no spelling.
#[test]
fn refuses_to_render_a_kept_one_bonus_pool() -> T {
    let check = d20().plus_roll(&roll_with(2.0, None, None)?.d(4.0)?.best_of(1.0)?)?;
    let e = err_of(miss_reroll_check_expression_with(
        &check,
        &ac_check(15.0, 20.0),
    ));
    assert!(e.contains("toExpression"), "{e}");
    Ok(())
}

/// The full attack string TS prints for `check AC n` dealing `1d8`.
fn attack_string(inner: &str, ac: f64, crit: &str) -> String {
    format!("({inner} AC {ac}) * (1d8) {crit} (2d8)")
}

/// miss-reroll.test.ts:333/342 and guards :19 ("C prints one rerolled d20", "A prints one term per
/// bonus outcome", "I", "H", "parses back to the same mean (A, C, H, I)"): the check spelling is
/// exact, and the attack string parses back to the pinned mean.
#[test]
fn expression_round_trip() -> T {
    let tight = |c: &RollBuilder, ac: f64, crit: f64| {
        miss_reroll_check_expression_with(c, &ac_check(ac, crit))
    };
    let c = tight(&d20().plus(6.0)?, 15.0, 20.0)?;
    assert_eq!(
        attack_string(&c, 15.0, "crit"),
        "(d20 reroll d8 + 6 AC 15) * (1d8) crit (2d8)"
    );
    let a = tight(&d20().plus(5.0)?.plus_dice(1.0, &d4())?, 15.0, 20.0)?;
    assert_eq!(
        attack_string(&a, 15.0, "crit"),
        "(((d20 reroll d8) + 6) & ((d20 reroll d7) + 7) & ((d20 reroll d6) + 8) & ((d20 reroll d5) + 9) AC 15) * (1d8) crit (2d8)"
    );
    let i = tight(&d20().plus(6.0)?.plus_roll(&d4())?, 26.0, 19.0)?;
    assert_eq!(
        attack_string(&i, 26.0, "xcrit2"),
        "(((d20 reroll d18) + 7) & ((d20 reroll d17) + 8) & ((d20 reroll d16) + 9) & ((d20 reroll d15) + 10) AC 26) * (1d8) xcrit2 (2d8)"
    );
    let h = tight(&hd20().plus(4.0)?.minus_roll(&d4())?, 14.0, 20.0)?;
    assert_eq!(
        attack_string(&h, 14.0, "crit"),
        "((hd20 reroll d13) & ((hd20 reroll d12) + 1) & ((hd20 reroll d11) + 2) & ((hd20 reroll d10) + 3) AC 14) * (1d8) crit (2d8)"
    );
    for (text, mean) in [
        (attack_string(&a, 15.0, "crit"), 4.30875),
        (attack_string(&c, 15.0, "crit"), 4.095),
        (attack_string(&h, 14.0, "crit"), 3.47169375),
        (attack_string(&i, 26.0, "xcrit2"), 2.244375),
    ] {
        assert!((parse(&text)?.mean() - mean).abs() < TOLERANCE, "{text}");
    }
    Ok(())
}

/// miss-reroll.test.ts:350 ("refuses a spelling the grammar lacks") and :357 (a d20 minimum and a
/// bonus die over 400 outcomes).
#[test]
fn refuses_a_spelling_the_grammar_lacks() -> T {
    let rows: Vec<(RollBuilder, f64, f64)> = vec![
        (
            d20().plus(5.0)?.plus_roll(&d4())?.with_disadvantage()?,
            15.0,
            20.0,
        ),
        (
            d20()
                .plus(7.0)?
                .plus_roll(&d4())?
                .plus_roll(&d12())?
                .with_advantage()?,
            20.0,
            20.0,
        ),
        (d20().plus(5.0)?.with_elven_accuracy()?, 18.0, 19.0),
        (
            d20().plus(5.0)?.plus_roll(&d4())?.with_advantage()?,
            15.0,
            20.0,
        ),
        (d20().minimum(5.0)?.plus(5.0)?, 15.0, 20.0),
        (
            d20()
                .plus(5.0)?
                .plus_dice(2.0, &d12())?
                .plus_dice(1.0, &d4())?,
            15.0,
            20.0,
        ),
    ];
    for (check, ac, crit) in rows {
        let e = err_of(miss_reroll_check_expression_with(
            &check,
            &ac_check(ac, crit),
        ));
        assert!(e.contains("rerollMisses"), "{e}");
    }
    assert!(
        miss_reroll_check_expression_with(
            &d20()
                .plus(5.0)?
                .plus_dice(1.0, &d12())?
                .plus_dice(1.0, &d4())?,
            &ac_check(15.0, 20.0)
        )
        .is_ok()
    );
    Ok(())
}
