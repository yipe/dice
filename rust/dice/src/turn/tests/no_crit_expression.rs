//! `tests/no-crit-expression.test.ts`: 8 tests (7 `it` + one `it.each` over 6 shapes, looped in
//! one test), 2 compat calls.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::error::DiceError;
use crate::parser::{parse, parse_with};
use crate::turn::effects::ConditionOptions;
use crate::turn::turn;
use std::collections::BTreeMap;

const FILE: &str = "tests/no-crit-expression.test.ts";
const SUITE: &str = "noCrit() prints a clause that parses with no crit";

type R<X> = Result<X, DiceError>;

/// Outcome label -> total probability, over every bin.
fn label_mass(pmf: &Pmf) -> BTreeMap<String, f64> {
    let mut mass = BTreeMap::new();
    for bin in pmf.map.values() {
        for (label, p) in &bin.count {
            *mass.entry(label.clone()).or_insert(0.0) += p;
        }
    }
    mass
}

fn mass_of(mass: &BTreeMap<String, f64>, label: &str) -> f64 {
    mass.get(label).copied().unwrap_or(0.0)
}

/// Same bins and the same labels in every bin, to 1e-12.
fn same_labelled_pmf(actual: &Pmf, expected: &Pmf, context: &str) {
    let mut values: Vec<f64> = actual.support().iter().map(|d| d.0).collect();
    values.extend(expected.support().iter().map(|d| d.0));
    let find = |pmf: &Pmf, value: f64| {
        pmf.map
            .iter()
            .find(|(k, _)| k.0 == value)
            .map(|(_, b)| b.clone())
    };
    for value in values {
        let a = find(actual, value);
        let e = find(expected, value);
        let ap = a.as_ref().map_or(0.0, |b| b.p);
        let ep = e.as_ref().map_or(0.0, |b| b.p);
        assert!((ap - ep).abs() <= 1e-12, "{context}: bin {value}");
        let mut labels: Vec<&String> = Vec::new();
        for bin in [&a, &e].into_iter().flatten() {
            labels.extend(bin.count.keys());
        }
        for label in labels {
            let got = a
                .as_ref()
                .and_then(|b| b.count.get(label))
                .copied()
                .unwrap_or(0.0);
            let want = e
                .as_ref()
                .and_then(|b| b.count.get(label))
                .copied()
                .unwrap_or(0.0);
            assert!(
                (got - want).abs() <= 1e-12,
                "{context}: bin {value} label {label}"
            );
        }
    }
}

fn base() -> R<AttackBuilder> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(rs(1.0, 8.0)?)
}

#[test]
fn prints_xcrit0_with_the_hit_payload() -> T {
    let attack = base()?.no_crit()?;
    assert_eq!(
        attack.to_expression()?,
        "(d20 + 5 AC 15) * (1d8) xcrit0 (1d8)"
    );
    Ok(())
}

#[test]
fn the_parsed_string_labels_the_natural_20_a_hit_like_the_builder() -> T {
    let attack = base()?.no_crit()?;
    let parsed = parse_with(&attack.to_expression()?, 0.0)?;
    let labels = label_mass(&parsed);
    close(mass_of(&labels, "hit"), 11.0 / 20.0, 12);
    close(mass_of(&labels, "missNone"), 9.0 / 20.0, 12);
    assert_eq!(mass_of(&labels, "crit"), 0.0);
    same_labelled_pmf(&parsed, &attack.to_pmf(0.0)?, &attack.to_expression()?);
    Ok(())
}

#[test]
fn a_crit_rider_never_fires_on_the_parsed_string() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > a crit rider never fires on the parsed string"),
    );
    let attack = base()?.no_crit()?;
    let from_string = turn(vec![atk(parse_with(&attack.to_expression()?, 0.0)?)], 0.0)?
        .on_any_crit_with(
            rs(1.0, 8.0)?,
            ConditionOptions {
                rider: rid("rider"),
                ..ConditionOptions::default()
            },
        )?;
    assert_eq!(want.fire(&from_string, "rider"), 0.0);
    close(want.pmf(&from_string).mean(), (11.0 / 20.0) * 4.5, 12);
    want.done();
    Ok(())
}

#[test]
fn each_shape_re_parses_with_the_builders_bins_and_labels() -> T {
    let shapes: Vec<(&str, R<AttackBuilder>)> = vec![
        (
            "an expanded crit range",
            (|| {
                d20()
                    .plus(5.0)?
                    .ac(15.0)?
                    .crit_on(19.0)?
                    .on_hit(rs(2.0, 8.0)?)?
                    .no_crit()
            })(),
        ),
        (
            "every hit crits",
            (|| {
                d20()
                    .plus(5.0)?
                    .ac(15.0)?
                    .always_crits()?
                    .on_hit(rs(2.0, 8.0)?)?
                    .no_crit()
            })(),
        ),
        (
            "an always-hitting check",
            (|| {
                d20()
                    .plus(5.0)?
                    .always_hits()?
                    .on_hit(rs(2.0, 8.0)?)?
                    .no_crit()
            })(),
        ),
        (
            "an always-hitting check where every hit crits",
            (|| {
                d20()
                    .plus(5.0)?
                    .always_hits()?
                    .always_crits()?
                    .on_hit(rs(2.0, 8.0)?)?
                    .no_crit()
            })(),
        ),
        (
            "a miss payload",
            (|| {
                d20()
                    .plus(5.0)?
                    .ac(15.0)?
                    .on_hit(rs(2.0, 8.0)?)?
                    .on_miss(&[Arg::Roll(rs(1.0, 8.0)?)])?
                    .no_crit()
            })(),
        ),
        (
            "a check with no die",
            (|| flat(15.0)?.ac(12.0)?.on_hit(rs(2.0, 8.0)?)?.no_crit())(),
        ),
    ];
    for (name, attack) in shapes {
        let attack = attack?;
        let expression = attack.to_expression()?;
        assert!(expression.contains(" xcrit0 ("), "{name}: {expression}");
        same_labelled_pmf(&parse(&expression)?, &attack.to_pmf(0.0)?, &expression);
    }
    Ok(())
}

#[test]
fn an_attack_that_can_crit_still_prints_its_crit_clause() -> T {
    assert_eq!(
        base()?.to_expression()?,
        "(d20 + 5 AC 15) * (1d8) crit (2d8)"
    );
    assert_eq!(
        d20()
            .plus(5.0)?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(rs(1.0, 8.0)?)?
            .to_expression()?,
        "(d20 + 5 AC 15) * (1d8) xcrit2 (2d8)"
    );
    Ok(())
}

#[test]
fn the_xcrit0_clause_never_crits_whatever_its_payload() -> T {
    let parsed = parse_with("(d20 + 5 AC 15) * (1d8) xcrit0 (10d8)", 0.0)?;
    close(parsed.mean(), (11.0 / 20.0) * 4.5, 12);
    assert_eq!(mass_of(&label_mass(&parsed), "crit"), 0.0);
    Ok(())
}

#[test]
fn the_xcrit0_clause_needs_no_single_natural_roll_since_nothing_crits() -> T {
    let parsed = parse_with("(d20 + 1d20 AC 25) * (1d8) xcrit0 (1d8)", 0.0)?;
    // d20 + d20 reaches 25 on 136 of its 400 rolls.
    close(parsed.mean(), (136.0 / 400.0) * 4.5, 12);
    let labels = label_mass(&parsed);
    close(mass_of(&labels, "hit"), 136.0 / 400.0, 12);
    assert_eq!(mass_of(&labels, "crit"), 0.0);
    Ok(())
}

#[test]
fn a_string_with_no_clause_still_crits_with_its_hit_dice_doubled() -> T {
    let parsed = parse_with("(d20 + 5 AC 15) * (1d8)", 0.0)?;
    close(mass_of(&label_mass(&parsed), "crit"), 1.0 / 20.0, 12);
    close(parsed.mean(), (10.0 / 20.0) * 4.5 + (1.0 / 20.0) * 9.0, 12);
    Ok(())
}
