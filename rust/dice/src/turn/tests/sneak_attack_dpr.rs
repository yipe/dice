//! `tests/turn-sneak-attack-dpr.test.ts`: 5 tests, 6 compat calls.

use super::helpers::*;
use crate::builder::factory::*;
use crate::parser::parse_with;
use crate::turn::effects::FirstHitOptions;
use crate::turn::turn;
use crate::turn::types::Attack;
use crate::{DiceQuery, Pmf};

const FILE: &str = "tests/turn-sneak-attack-dpr.test.ts";

// Pinned DPRs for the canonical two-dagger rogue with once-per-turn Sneak Attack, through the
// string parser and the fluent builder.
fn parsed_case(name: &str, check: &str, dpr: f64) -> T {
    let mut want = expect(
        FILE,
        &format!("Sneak Attack DPR > matches the pinned {name} DPR from a parsed expression"),
    );
    let attack: Pmf = parse_with(
        &format!("({check} + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"),
        1.0,
    )?;
    let rogue = turn(
        vec![
            Attack::Bare(attack.clone().into()),
            Attack::Bare(attack.into()),
        ],
        0.0,
    )?
    .on_first_hit_with(
        rs(3.0, 6.0)?,
        FirstHitOptions {
            condition: crate::turn::effects::ConditionOptions {
                rider: crate::turn::types::RiderOptions {
                    crit_damage: Some(rs(6.0, 6.0)?.into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )?;
    close(want.mean(&rogue), dpr, 8);
    want.done();
    Ok(())
}

#[test]
fn matches_the_pinned_normal_dpr_from_a_parsed_expression() -> T {
    parsed_case("normal", "d20", 18.6225)
}

#[test]
fn matches_the_pinned_advantage_dpr_from_a_parsed_expression() -> T {
    parsed_case("advantage", "d20 > d20", 23.38659375)
}

#[test]
fn matches_the_pinned_disadvantage_dpr_from_a_parsed_expression() -> T {
    parsed_case("disadvantage", "d20 < d20", 12.54459375)
}

#[test]
fn matches_the_pinned_normal_dpr_from_the_fluent_builder() -> T {
    let mut want = expect(
        FILE,
        "Sneak Attack DPR > matches the pinned normal DPR from the fluent builder",
    );
    let dagger = attack_roll(8.0, 16.0, d4().plus(4.0)?)?;
    let rogue = turn(vec![atk(dagger.clone()), atk(dagger)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?;
    close(want.mean(&rogue), 18.6225, 4);
    want.done();
    Ok(())
}

#[test]
fn adds_exactly_the_riders_conditional_expectation_to_the_attacks() -> T {
    let mut want = expect(
        FILE,
        "Sneak Attack DPR > adds exactly the rider's conditional expectation to the attacks",
    );
    let dagger = attack_roll(8.0, 16.0, d4().plus(4.0)?)?;
    let dp = dagger.pmf()?;
    let attacks = DiceQuery::of(vec![dp.clone(), dp]);
    let rogue = turn(vec![atk(dagger.clone()), atk(dagger)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, cond_to_first("sneak"))?;

    // P(fires) = P(at least one attack lands); the damage itself is 3d6 or 6d6
    // depending on whether the FIRST landing attack crit.
    close(want.fire(&rogue, "sneak"), 0.8775, 10);
    close(want.mean(&rogue) - attacks.mean(), 18.6225 - 8.7, 8);
    want.done();
    Ok(())
}

fn cond_to_first(id: &str) -> FirstHitOptions {
    first_hit_id(id)
}
