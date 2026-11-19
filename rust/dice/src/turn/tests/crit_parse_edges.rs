//! `tests/crit-parse-edges.test.ts`: 26 tests, 5 compat calls.
//!
//! Edge shapes of `parse()`: the builder is the oracle, bin for bin (<= 1e-12) and label by label.

use super::crit_doubling::*;
use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;
use crate::parser::parse;
use crate::turn::turn;

const FILE: &str = "tests/crit-parse-edges.test.ts";
const LABELS: [&str; 4] = ["hit", "crit", "missNone", "missDamage"];

fn p(expression: &str) -> R<Pmf> {
    parse(expression)
}

/// Same bins, same hit/crit/miss weights, and the same damage under each label.
fn same_attack(expression: &str, built: &AttackBuilder) -> Result<(), DiceError> {
    let parsed = p(expression)?;
    let reference = built.to_pmf(0.0)?;
    same_pmf(&parsed, &reference);
    for label in LABELS {
        close(
            parsed.outcome_probability(label),
            reference.outcome_probability(label),
            12,
        );
        same_pmf(
            &parsed.filter_outcome(label),
            &reference.filter_outcome(label),
        );
    }
    Ok(())
}

/// Two strings that parse to the same bins and the same damage under each hit/crit/miss label.
fn same_parse(a: &str, b: &str) -> Result<(), DiceError> {
    let left = p(a)?;
    let right = p(b)?;
    same_pmf(&left, &right);
    for label in LABELS {
        same_pmf(&left.filter_outcome(label), &right.filter_outcome(label));
    }
    Ok(())
}

fn atk_parsed(expression: &str) -> R<AttackBuilder> {
    atk_parsed_at(15.0, expression)
}

fn atk_parsed_at(ac: f64, expression: &str) -> R<AttackBuilder> {
    d20()
        .plus(5.0)?
        .ac(ac)?
        .on_hit_args(&[Arg::Str(expression.into())])
}

fn on_hit(bonus: f64, ac: f64, damage: RollBuilder) -> R<AttackBuilder> {
    d20().plus(bonus)?.ac(ac)?.on_hit(damage)
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn roll_plus_roll(a: RollBuilder, b: RollBuilder) -> R<RollBuilder> {
    a.plus_roll(&b)
}

const KEPT_D20: &[(&str, f64, f64)] = &[
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
];

const BESIDE_LARGER: &[(&str, f64, f64)] = &[
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
    // `+` in a check total always adds: a natural 20 less a d100 of 20 is 0, then 100, and hits.
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
];

const MIXES: &[(&str, f64, f64, f64)] = &[
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
    // An AC gate on either side of `&` makes the mix an attack check, so it crits in either order.
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
    // A max, advantage, keep or reroll over a mix: exact figures.
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
];

const SAME_PARSES: &[(&str, &str)] = &[
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
];

const DIELESS: &[(&str, f64, f64)] = &[
    ("(15 AC 12) * (1d6)", 7.0 / 2.0, 1.0),
    ("15 AC 12 * 1d6 + 3", 13.0 / 2.0, 1.0),
    ("((15) AC 12) * (1d6) miss (1)", 7.0 / 2.0, 1.0),
    ("(15 AC 20) * (1d6)", 0.0, 0.0),
    ("(2(5) + 5 AC 12) * (1d6)", 7.0 / 2.0, 1.0),
    ("(3 ** 5 AC 16) * (1d6 + 2)", 0.0, 0.0),
    ("(25 AC d20) * (1d6)", 7.0 / 2.0, 1.0),
    // A crit clause on it can never fire: the clause is inert and the hit payload applies as written.
    ("(15 AC 12) * (1d6) crit (2d6)", 7.0 / 2.0, 1.0),
    ("(15 AC 12) * (1d6) xcrit2 (2d6)", 7.0 / 2.0, 1.0),
    ("(15 AC 20) * (1d6) crit (2d6)", 0.0, 0.0),
    ("(25 AC d20) * (1d6) crit (2d6)", 7.0 / 2.0, 1.0),
];

// ---- a trailing hit-only term is part of the hit payload ---------------------------------

const TRAILING: &str = "a trailing hit-only term is part of the hit payload: its dice double on a crit, its flats do not";

#[test]
fn plus_after_the_payload_adds_to_every_landed_hit_and_never_to_a_miss() -> T {
    let trailing = p("(d20 + 5 AC 15) * (1d8) + 1d6")?;
    same_pmf(&trailing, &p("(d20 + 5 AC 15) * ((1d8) + 1d6)")?);
    close(trailing.outcome_probability("missNone"), 9.0 / 20.0, 12);
    Ok(())
}

#[test]
fn trailing_1d6_crits_as_2d8_plus_2d6() -> T {
    let built = on_hit(5.0, 15.0, roll_plus_roll(rs(1.0, 8.0)?, rs(1.0, 6.0)?)?)?;
    same_attack("(d20 + 5 AC 15) * (1d8) + 1d6", &built)?;
    same_attack("d20 + 5 AC 15 * 1d8 + 1d6", &built)?;
    close(p("(d20 + 5 AC 15) * (1d8) + 1d6")?.mean(), 24.0 / 5.0, 12); // was 4.625
    same_pmf(
        &p("(d20 + 5 AC 15) * (1d8) + 1d6")?.filter_outcome("crit"),
        &roll_plus_roll(rs(2.0, 8.0)?, rs(2.0, 6.0)?)?
            .to_pmf(0.0)?
            .scale_mass(0.05),
    );
    Ok(())
}

#[test]
fn a_trailing_flat_keeps_every_label_and_is_added_once_on_a_crit() -> T {
    same_attack(
        "(d20+5 AC 12) * (2d6) + 3",
        &on_hit(5.0, 12.0, rs(2.0, 6.0)?.plus(3.0)?)?,
    )?;
    same_attack(
        "d20 + 5 AC 15 * 1d8 + 3",
        &on_hit(5.0, 15.0, rs(1.0, 8.0)?.plus(3.0)?)?,
    )?;
    let parsed = p("(d20+5 AC 12) * (2d6) + 3")?;
    close(parsed.outcome_probability("crit"), 0.05, 12); // was 0
    close(parsed.mean(), 147.0 / 20.0, 12);
    Ok(())
}

#[test]
fn exact_figures_on_every_path_that_reads_crit_status() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{TRAILING} > (d20+5 AC 12) * (2d6) + 3 gives the exact figures on every path that reads crit status"
        ),
    );
    let attack =
        || -> Result<_, Box<dyn std::error::Error>> { Ok(atk(p("(d20+5 AC 12) * (2d6) + 3")?)) };
    let base = turn(vec![attack()?], 0.0)?;
    let any_crit = turn(vec![attack()?], 0.0)?
        .rider(with_id("smite", rider_of(trig("any-crit"), rs(1.0, 4.0)?)))?;
    let a = want.mean(&any_crit);
    let b = want.mean(&base);
    close(a - b, 0.25, 10); // was 0
    close(want.fire(&any_crit, "smite"), 0.05, 12); // was 0
    let first_hit =
        turn(vec![attack()?], 0.0)?.rider(rider_of(trig("first-hit"), rs(1.0, 4.0)?))?;
    let a = want.mean(&first_hit);
    let b = want.mean(&base);
    close(a - b, 15.0 / 8.0, 10); // was 1.75
    want.done();
    Ok(())
}

#[test]
fn every_hit_only_operator_doubles_through_the_whole_payload() -> T {
    for tail in ["* (1d4)", "** 2", "/ 2", "// 2", "+ 1d4 + 2"] {
        same_attack(
            &format!("(d20 + 5 AC 12) * (2d6) {tail}"),
            &atk_parsed_at(12.0, &format!("(2d6) {tail}"))?,
        )?;
    }
    Ok(())
}

#[test]
fn a_crit_clause_still_wins_a_trailing_term_is_added_as_written() -> T {
    let built = on_hit(5.0, 15.0, roll_plus_roll(rs(1.0, 8.0)?, rs(1.0, 6.0)?)?)?
        .on_crit(&[Arg::Roll(roll_plus_roll(rs(2.0, 8.0)?, rs(1.0, 6.0)?)?)])?;
    same_attack("(d20 + 5 AC 15) * (1d8) crit (2d8) + 1d6", &built)?;
    Ok(())
}

#[test]
fn a_miss_clause_keeps_its_label_and_a_trailing_plus_adds_to_its_damage_too() -> T {
    let built = on_hit(5.0, 15.0, rs(2.0, 6.0)?.plus(3.0)?)?
        .on_miss(&[Arg::Roll(rs(1.0, 6.0)?.plus(3.0)?)])?;
    same_attack("(d20 + 5 AC 15) * (2d6) miss (1d6) + 3", &built)?;
    close(
        p("(d20 + 5 AC 15) * (2d6) miss (1d6) + 3")?.mean(),
        351.0 / 40.0,
        12,
    );
    Ok(())
}

// ---- advantage, disadvantage and halfling luck track the natural d20 ---------------------

#[test]
fn advantage_with_a_bonus_die_crit_39_400_mean_5537_800() -> T {
    same_attack(
        "(d20 > d20 + 5 + 1d4 AC 15) * (2d6)",
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(rs(2.0, 6.0)?)?,
    )?;
    let parsed = p("(d20 > d20 + 5 + 1d4 AC 15) * (2d6)")?;
    close(parsed.outcome_probability("crit"), 39.0 / 400.0, 12); // was 0.024375
    close(parsed.mean(), 5537.0 / 800.0, 12); // was 6.409375
    Ok(())
}

#[test]
fn halfling_with_a_bonus_die_crit_21_400_mean_4263_800() -> T {
    same_attack(
        "(hd20 + 5 + 1d4 AC 15) * (2d6)",
        &d20()
            .reroll(1.0)?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(rs(2.0, 6.0)?)?,
    )?;
    let parsed = p("(hd20 + 5 + 1d4 AC 15) * (2d6)")?;
    close(parsed.outcome_probability("crit"), 21.0 / 400.0, 12); // was 0.013125
    close(parsed.mean(), 4263.0 / 800.0, 12); // was 5.053125
    Ok(())
}

#[test]
fn disadvantage_elven_accuracy_bang_reroll_parentheses_and_1d20_spell_the_same_checks() -> T {
    let with_d4 = |roll: RollBuilder| -> R<AttackBuilder> {
        roll.plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(rs(2.0, 6.0)?)
    };
    let adv = with_d4(d20().with_advantage()?)?;
    same_attack(
        "(d20 < d20 + 5 + 1d4 AC 15) * (2d6)",
        &with_d4(d20().with_disadvantage()?)?,
    )?;
    same_attack(
        "(d20 > d20 > d20 + 5 + 1d4 AC 15) * (2d6)",
        &with_d4(d20().with_elven_accuracy()?)?,
    )?;
    same_attack("(d20! + 5 + 1d4 AC 15) * (2d6)", &adv)?;
    same_attack("((d20 > d20) + 5 + 1d4 AC 15) * (2d6)", &adv)?;
    same_attack(
        "(d20 reroll 1 + 5 + 1d4 AC 15) * (2d6)",
        &with_d4(d20().reroll(1.0)?)?,
    )?;
    same_attack("(1d20 + 5 + 1d4 AC 15) * (2d6)", &with_d4(d20())?)?;
    close(
        p("(d20 > d20 > d20 + 5 + 1d4 AC 15) * (2d6)")?.mean(),
        30947.0 / 4000.0,
        12,
    );
    Ok(())
}

#[test]
fn a_crit_clause_reads_the_same_tracked_slice() -> T {
    same_attack(
        "(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) crit (2d8 + 3)",
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?
            .on_crit(&[Arg::Roll(rs(2.0, 8.0)?.plus(3.0)?)])?,
    )?;
    Ok(())
}

#[test]
fn xcrit_with_a_bonus_die_crits_on_every_natural_face_in_range() -> T {
    let expression = "(d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)";
    same_attack(
        expression,
        &d20()
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?
            .on_crit(&[Arg::Roll(rs(2.0, 8.0)?.plus(3.0)?)])?,
    )?;
    close(p(expression)?.outcome_probability("crit"), 1.0 / 10.0, 12); // was 0.0375
    close(p(expression)?.mean(), 441.0 / 80.0, 12); // was 5.23125
    same_attack(
        "(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)",
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?
            .on_crit(&[Arg::Roll(rs(2.0, 8.0)?.plus(3.0)?)])?,
    )?;
    close(
        p("(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)")?.mean(),
        12063.0 / 1600.0,
        12,
    );
    Ok(())
}

#[test]
fn the_natural_roll_is_the_checks_d20_wherever_it_sits_in_the_sum() -> T {
    // `d20.plus(5).plus(d4)` and `d20.plus(d4).plus(5)` build the same attack (tests/check-order.test.ts).
    let reference = d20()
        .plus(5.0)?
        .plus_roll(&d4())?
        .ac(15.0)?
        .on_hit(rs(2.0, 6.0)?)?;
    for expression in [
        "(1d4 + d20 + 5 AC 15) * (2d6)",
        "(1d4 + 1d20 + 5 AC 15) * (2d6)",
        "(5 + 1d4 + d20 AC 15) * (2d6)",
        "(d4 + 5 + d20 AC 15) * (2d6)",
        "(1d4 + d20 + 5 AC 15) * (2d6) crit (4d6)",
    ] {
        same_attack(expression, &reference)?;
        close(p(expression)?.outcome_probability("crit"), 1.0 / 20.0, 12); // was 0.1875
        close(p(expression)?.mean(), 203.0 / 40.0, 12); // was 6.0375
    }
    // A bonus pool before the d20 is still a bonus: crit 1/20, mean 119/20 (was a throw).
    same_attack(
        "(2d4 + d20 + 5 AC 15) * (2d6)",
        &d20()
            .plus(5.0)?
            .plus_roll(&rs(2.0, 4.0)?)?
            .ac(15.0)?
            .on_hit(rs(2.0, 6.0)?)?,
    )?;
    close(p("(2d4 + d20 + 5 AC 15) * (2d6)")?.mean(), 119.0 / 20.0, 12);
    // With no d20, the largest die is the natural roll whichever side it is on: crit 1/12, mean 91/48.
    for expression in [
        "(d12 + 1d4 AC 10) * (1d6) crit (2d6)",
        "(1d4 + d12 AC 10) * (1d6) crit (2d6)",
    ] {
        close(p(expression)?.outcome_probability("crit"), 1.0 / 12.0, 12);
        close(p(expression)?.mean(), 91.0 / 48.0, 12);
    }
    Ok(())
}

#[test]
fn keep_spelled_advantage_disadvantage_and_elven_accuracy_keep_one_natural_d20() -> T {
    // With a clause, these are the engine's exact figures.
    for (expression, crit, mean) in KEPT_D20 {
        close(p(expression)?.outcome_probability("crit"), *crit, 12);
        close(p(expression)?.mean(), *mean, 12);
    }
    // With no clause they crit like the builder's advantage, disadvantage and elven accuracy.
    let damage = || rs(2.0, 6.0);
    same_attack(
        "(2kh1(1d20) + 5 AC 15) * (2d6)",
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(damage()?)?,
    )?;
    same_attack(
        "(2kh1d20 + 5 AC 15) * (2d6)",
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(damage()?)?,
    )?;
    same_attack(
        "(2kl1(1d20) + 5 AC 15) * (2d6)",
        &d20()
            .with_disadvantage()?
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(damage()?)?,
    )?;
    same_attack(
        "(3kh1(1d20) + 5 AC 15) * (2d6)",
        &d20()
            .with_elven_accuracy()?
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(damage()?)?,
    )?;
    same_attack(
        "(2kh1(1d20) + 1d4 + 5 AC 15) * (2d6)",
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(damage()?)?,
    )?;
    Ok(())
}

#[test]
fn d20_greater_than_d4_crits_when_the_d20s_natural_20_is_the_value_kept() -> T {
    for expression in [
        "(d20 > d4 + 5 AC 10) * (1d6) crit (2d6)",
        "(d20 > d4 + 5 AC 10) * (1d6)",
    ] {
        close(p(expression)?.outcome_probability("crit"), 1.0 / 20.0, 12);
        close(p(expression)?.outcome_probability("hit"), 3.0 / 4.0, 12);
        close(p(expression)?.mean(), 119.0 / 40.0, 12);
    }
    // A cap the natural 20 never survives never crits, with or without a clause: hit 4/5, mean 14/5.
    // Main read its crit from the highest totals: 3.85 with `crit`, 4.025 with `xcrit2`.
    for expression in [
        "(d20 < 15 + 5 AC 10) * (1d6)",
        "(d20 < 15 + 5 AC 10) * (1d6) crit (2d6)",
        "(d20 < 15 + 5 AC 10) * (1d6) xcrit2 (2d6)",
    ] {
        let capped = p(expression)?;
        assert_eq!(capped.outcome_probability("crit"), 0.0, "{expression}");
        close(capped.outcome_probability("hit"), 4.0 / 5.0, 12);
        close(capped.mean(), 14.0 / 5.0, 12);
    }
    Ok(())
}

#[test]
fn the_natural_roll_is_the_checks_one_d20_even_beside_a_larger_die() -> T {
    // Main's exact means, with a clause.
    for (expression, crit, mean) in BESIDE_LARGER {
        close(p(expression)?.outcome_probability("crit"), *crit, 12);
        close(p(expression)?.mean(), *mean, 12);
    }
    // More than one d20 and no single kept roll: a larger die does not stand in for the natural roll.
    for expression in [
        "(d20 + d20 + d100 AC 60) * (1d6)",
        "(d100 + 2d20 AC 60) * (1d6) crit (2d6)",
    ] {
        throws(p(expression), "crit rate cannot be computed exactly");
    }
    Ok(())
}

#[test]
fn amp_mixes_checks_by_count() -> T {
    // Exact figures for the bare forms, which need a crit clause.
    for (expression, hit, crit, mean) in MIXES {
        let parsed = p(expression)?;
        close(parsed.outcome_probability("hit"), *hit, 12);
        close(parsed.outcome_probability("crit"), *crit, 12);
        close(parsed.mean(), *mean, 12);
    }
    // Operand order never matters: bin for bin and label by label, with and without a clause.
    for (left, right) in SAME_PARSES {
        same_parse(left, right)?;
    }
    Ok(())
}

#[test]
fn amp_with_a_branch_whose_d20_is_not_one_natural_roll_throws() -> T {
    for expression in [
        "((d20 + d20) & d20 AC 15) * (1d6) crit (2d6)",
        "(d20 & (d20 + d20) AC 15) * (1d6)",
        "(2d20 & d20 AC 15) * (1d6)",
        // A reroll draws again from the whole mix, not per branch.
        "((d20 & d4) reroll 1 AC 15) * (1d6) crit (2d6)",
        // A repeat, keep or advantage of a mix with a smaller die in it has no one natural roll to
        // replay per branch, so it is refused rather than approximated.
        "(1(d20 & d4) AC 5) * (1d6) crit (2d6)",
        "(2kh1(d20 & d4) AC 15) * (1d6) crit (2d6)",
        "((d20 & d4)!! AC 15) * (1d6)",
    ] {
        throws(p(expression), "crit rate cannot be computed exactly");
    }
    for expression in ["(10 & 5 AC 8) * (1d6) crit (2d6)", "(10 & 5 AC 8) * (1d6)"] {
        let parsed = p(expression)?;
        assert_eq!(parsed.outcome_probability("crit"), 0.0, "{expression}");
        close(parsed.mean(), 7.0 / 4.0, 12);
    }
    Ok(())
}

#[test]
fn amp_with_an_attack_split_into_outcomes_a_save_beside_a_non_save_or_a_clause_after_it_throws() -> T
{
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
        throws(p(expression), "an `&` mix");
    }
    // A check with no crit to split off, and two saves, still mix.
    same_pmf(&p("((15 AC 12) * (1d6)) & 1")?, &p("1d6 & 1")?);
    same_parse(
        "((d20 DC 12) & (d20 DC 15)) * (8d6)",
        "((d20 DC 15) & (d20 DC 12)) * (8d6)",
    )?;
    Ok(())
}

fn throws_no_single_meaning(result: R<Pmf>) {
    match result {
        Ok(_) => panic!("expected a throw"),
        Err(e) => assert!(
            e.message().contains("the mix `")
                && e.message().contains("` has no single doubled meaning"),
            "{e}"
        ),
    }
}

fn assert_ambiguous<X>(result: R<X>) {
    match result {
        Ok(_) => panic!("expected an AmbiguousCritDoublingError"),
        Err(e) => assert!(
            matches!(e, crate::error::DiceError::AmbiguousCritDoubling(_)),
            "{e}"
        ),
    }
}

#[test]
fn amp_in_a_hit_payload_that_doubles_has_no_single_doubled_meaning() -> T {
    for expression in [
        "(d20 + 5 AC 15) * (1d6 & 3)",
        "(d20 + 5 AC 15) * (1d4 & 1d6)",
        "(d20 + 5 AC 15) * (d6 & d6 & 3)",
        "(d20 + 5 AC 15) * (3 & 1d6) miss (1)",
        "(d20 + 5 AC 15) * (1d6) + (1d4 & 2)",
    ] {
        throws_no_single_meaning(p(expression));
    }
    for payload in [
        "1d6 & 3",
        "3 & 1d6",
        "2(1d6 & 3)",
        "2kh1(1d6 & 3)",
        "1d8 + (1d4 & 2)",
    ] {
        assert_ambiguous(parse_str(payload).and_then(|b| b.double_dice()));
    }
    assert_ambiguous(atk_parsed("1d6 & 3").and_then(|a| a.resolve(0.0)));
    // A mix of flats has no dice to double; a crit clause gives the crit as written (2133/1036).
    close(
        parse_str("(3 & 4) + 1d6")?
            .double_dice()?
            .to_pmf(0.0)?
            .mean(),
        21.0 / 2.0,
        12,
    );
    let explicit = p("(d20 + 5 AC 15) * (1d6 & 3) crit (2d6 & 3)")?;
    close(explicit.outcome_probability("crit"), 1.0 / 20.0, 12);
    close(explicit.mean(), 2133.0 / 1036.0, 12);
    Ok(())
}

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
        throws(p(expression), "crit rate cannot be computed exactly");
    }
    // Without a crit there is nothing to compute: the same checks still parse.
    close(p("2d20 + 5 AC 30")?.mass(), 1.0, 12);
    Ok(())
}

#[test]
fn a_check_with_no_die_has_no_natural_roll_crit_mass_exactly_0() -> T {
    // The builder's dieless check agrees: `roll.flat(15).ac(12)` hits for certain and never crits.
    same_attack(
        "(15 AC 12) * (1d6)",
        &flat(15.0)?
            .always_hits()?
            .on_hit(rs(1.0, 6.0)?)?
            .no_crit()?,
    )?;
    same_attack(
        "(15 AC 12) * (1d6)",
        &flat(15.0)?.ac(12.0)?.on_hit(rs(1.0, 6.0)?)?,
    )?;
    same_attack(
        "(10 + 5 AC 12) * (2d6) + 3",
        &flat(15.0)?
            .always_hits()?
            .on_hit(rs(2.0, 6.0)?.plus(3.0)?)?
            .no_crit()?,
    )?;
    // A die on the AC side is the target's roll, never the attack's natural roll.
    same_attack(
        "(25 AC d20) * (1d6)",
        &flat(25.0)?
            .always_hits()?
            .on_hit(rs(1.0, 6.0)?)?
            .no_crit()?,
    )?;
    for (expression, mean, hit) in DIELESS {
        let parsed = p(expression)?;
        assert_eq!(parsed.outcome_probability("crit"), 0.0, "{expression}");
        close(parsed.outcome_probability("hit"), *hit, 12);
        close(parsed.mean(), *mean, 12);
    }
    close(
        p("(15 AC 20) * (1d6) crit (2d6)")?.outcome_probability("missNone"),
        1.0,
        12,
    );
    // The builder's flat check round-trips through its own string to the same mean.
    let flat_attack = flat(15.0)?.ac(12.0)?.on_hit(d6())?;
    assert_eq!(
        flat_attack.to_expression()?,
        "(15 AC 12) * (1d6) crit (2d6)"
    );
    close(
        p(&flat_attack.to_expression()?)?.mean(),
        flat_attack.to_pmf(0.0)?.mean(),
        12,
    );
    Ok(())
}

// ---- xcrit: the hit/crit split and mean, exact ------------------------------------------

fn xcrit_hit() -> R<RollBuilder> {
    rs(2.0, 6.0)?.plus(3.0)
}
fn xcrit_crit() -> R<RollBuilder> {
    rs(4.0, 6.0)?.plus(3.0)
}

#[test]
fn flat_xcrit2_hit_9_20_crit_1_10_mean_31_5() -> T {
    let expression = "(d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)";
    same_attack(
        expression,
        &d20()
            .plus(5.0)?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(xcrit_hit()?)?
            .on_crit(&[Arg::Roll(xcrit_crit()?)])?,
    )?;
    let parsed = p(expression)?;
    close(parsed.outcome_probability("hit"), 9.0 / 20.0, 12);
    close(parsed.outcome_probability("crit"), 1.0 / 10.0, 12);
    close(parsed.mean(), 31.0 / 5.0, 12);
    Ok(())
}

#[test]
fn advantage_xcrit2_hit_243_400_crit_19_100_mean_1861_200() -> T {
    let expression = "(d20 > d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)";
    same_attack(
        expression,
        &d20()
            .with_advantage()?
            .plus(5.0)?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(xcrit_hit()?)?
            .on_crit(&[Arg::Roll(xcrit_crit()?)])?,
    )?;
    let parsed = p(expression)?;
    close(parsed.outcome_probability("hit"), 243.0 / 400.0, 12);
    close(parsed.outcome_probability("crit"), 19.0 / 100.0, 12);
    close(parsed.mean(), 1861.0 / 200.0, 12);
    Ok(())
}

#[test]
fn disadvantage_xcrit3_hit_7_25_crit_9_400_mean_1273_400() -> T {
    let expression = "(d20 < d20 + 5 AC 15) * (2d6 + 3) xcrit3 (4d6 + 3)";
    same_attack(
        expression,
        &d20()
            .with_disadvantage()?
            .plus(5.0)?
            .ac(15.0)?
            .crit_on(18.0)?
            .on_hit(xcrit_hit()?)?
            .on_crit(&[Arg::Roll(xcrit_crit()?)])?,
    )?;
    let parsed = p(expression)?;
    close(parsed.outcome_probability("hit"), 7.0 / 25.0, 12);
    close(parsed.outcome_probability("crit"), 9.0 / 400.0, 12);
    close(parsed.mean(), 1273.0 / 400.0, 12);
    Ok(())
}

#[test]
fn a_crit_range_reaching_a_face_that_misses_the_natural_19_stays_a_miss() -> T {
    let expression = "(d20 + 1 AC 21) * (1d6) xcrit2 (2d6)";
    same_attack(
        expression,
        &d20()
            .plus(1.0)?
            .ac(21.0)?
            .crit_on(19.0)?
            .on_hit(rs(1.0, 6.0)?)?
            .on_crit(&[Arg::Roll(rs(2.0, 6.0)?)])?,
    )?;
    let parsed = p(expression)?;
    close(parsed.outcome_probability("hit"), 0.0, 12);
    close(parsed.outcome_probability("crit"), 1.0 / 20.0, 12);
    close(parsed.mean(), 7.0 / 20.0, 12);
    Ok(())
}
