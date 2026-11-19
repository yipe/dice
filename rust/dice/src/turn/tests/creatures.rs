//! `tests/turn-creatures.test.ts`: 7 tests, 0 compat calls (the fixture has no entries for this
//! file). The six oracle-backed cases run against the oracle recordings of `oracle.rs`.

use super::helpers::{T, close};
use super::oracle::*;
use crate::turn::Turn;

const FILE: &str = "tests/turn-creatures.test.ts";
const SUITE: &str = "creatures: creatures, reader-wait and start against the oracle";

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn expect(name: &str, synthetic: SyntheticTurn) -> T {
    expect_oracle(FILE, &format!("{SUITE} > {name}"), &synthetic, false)?;
    Ok(())
}

fn ogre() -> AttackSpec {
    attack().target(1)
}

#[test]
fn a_grant_on_one_creature_is_not_read_by_attacks_on_another() -> T {
    expect(
        "a grant on one creature is not read by attacks on another",
        SyntheticTurn {
            attacks: vec![attack(), ogre(), attack()],
            grants: Some(vec![grant().of(&[0]).effects(vec![next_advantage()])]),
            ..SyntheticTurn::default()
        },
    )
}

#[test]
fn once_a_turn_a_landing_with_no_reader_after_it_on_its_creature_keeps_the_try() -> T {
    expect(
        "once a turn: a landing with no reader after it on its creature keeps the try",
        SyntheticTurn {
            attacks: vec![ogre(), attack(), attack()],
            grants: Some(vec![
                grant()
                    .of(&[0, 1])
                    .once()
                    .effects(vec![effect("advantage", Some("turn"))]),
            ]),
            ..SyntheticTurn::default()
        },
    )
}

#[test]
fn once_a_turn_over_two_creatures_readers_on_both() -> T {
    expect(
        "once a turn over two creatures, readers on both",
        SyntheticTurn {
            attacks: vec![attack(), ogre(), attack(), ogre()],
            grants: Some(vec![
                grant()
                    .of(&[0, 1, 2])
                    .once()
                    .effects(vec![condition("prone")]),
            ]),
            ..SyntheticTurn::default()
        },
    )
}

#[test]
fn a_start_condition_on_the_second_creature() -> T {
    expect(
        "a start condition on the second creature",
        SyntheticTurn {
            attacks: vec![attack(), ogre(), ogre().ranged()],
            grants: Some(vec![
                grant()
                    .of(&[1])
                    .trigger("start")
                    .once()
                    .effects(vec![condition("prone")]),
            ]),
            ..SyntheticTurn::default()
        },
    )
}

#[test]
fn path_to_the_grave_vulnerability_from_the_start_used_up_by_the_first_hit() -> T {
    expect(
        "Path to the Grave: vulnerability from the start, used up by the first hit",
        SyntheticTurn {
            attacks: vec![attack(), attack(), attack()],
            grants: Some(vec![
                grant()
                    .of(&[0])
                    .trigger("start")
                    .once()
                    .effects(vec![effect("vulnerability", Some("next-hit"))]),
            ]),
            ..SyntheticTurn::default()
        },
    )
}

#[test]
fn a_starting_condition() -> T {
    expect(
        "a starting condition",
        SyntheticTurn {
            attacks: vec![attack(), attack().ranged()],
            starting_condition: Some("prone"),
            ..SyntheticTurn::default()
        },
    )
}

#[test]
fn a_start_condition_is_applied_for_certain() -> T {
    let synthetic = SyntheticTurn {
        attacks: vec![attack(), attack()],
        starting_condition: Some("restrained"),
        ..SyntheticTurn::default()
    };
    let t = Turn::from_spec(turn_to_spec(&synthetic, None)?, 0.0)?;
    close(t.fire_probability("start")?, 1.0, 12);
    Ok(())
}
