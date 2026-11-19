//! `src/turn/attached.test.ts`: 7 tests, 14 compat calls.

use super::helpers::*;
use crate::builder::attack::{AttackBuilder, ConditionGate, Grants};
use crate::builder::factory::d20;
use crate::error::DiceError;
use crate::turn::effects::{TriggerSave, TriggerSaves, advantage};
use crate::turn::types::{DamageSource, RiderDamage, RiderOptions, TurnSpec, TurnSpecErrorCode};
use crate::turn::{Turn, turn};

const FILE: &str = "src/turn/attached.test.ts";
const SUITE: &str = "AttackBuilder.onEveryHit / onAnyCrit";

// Every oracle below is +8 vs AC 16, crit on 20: shortsword 1d6+5, dagger 1d4+5, staff 1d8+5.
fn ss() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d6+5")
}
fn dg() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d4+5")
}
fn staff() -> Result<AttackBuilder, DiceError> {
    attack_expr(8.0, 16.0, "1d8+5")
}

fn next_attack() -> Grants {
    Grants::One(advantage().until_next_attack().into())
}

fn name(test: &str) -> String {
    format!("{SUITE} > {test}")
}

#[test]
fn returns_a_new_builder_carrying_the_condition_and_leaves_the_receiver_unchanged() -> T {
    let mut want = expect(
        FILE,
        &name("returns a new builder carrying the condition and leaves the receiver unchanged"),
    );
    let plain = ss()?;
    let granting = plain.on_every_hit_with(next_attack(), None)?;
    assert_ne!(format!("{granting:?}"), format!("{plain:?}"));
    // Attaching to a copy must not change the bare weapon: bare x3 stays 17.1000.
    let t = turn(
        vec![atk(plain.clone()), atk(plain.clone()), atk(plain)],
        0.0,
    )?;
    close(want.mean(&t), 17.1, 4);
    // The attached copy: three shortswords each granting the next advantage = 20.1405.
    let t = turn(
        vec![atk(granting.clone()), atk(granting.clone()), atk(granting)],
        0.0,
    )?;
    close(want.mean(&t), 20.1405, 4);
    want.done();
    Ok(())
}

#[test]
fn turn_v_v_d_equals_f1() -> T {
    let mut want = expect(FILE, &name("turn([v, v, d]) equals F1 (19.2211)"));
    let v = ss()?.on_every_hit_with(next_attack(), None)?;
    let t = turn(vec![atk(v.clone()), atk(v), atk(dg()?)], 0.0)?;
    close(want.mean(&t), 19.2211, 4);
    want.done();
    Ok(())
}

#[test]
fn turn_v_v_v_v_equals_f3() -> T {
    let mut want = expect(FILE, &name("turn([v, v, v, v]) equals F3 (27.5867)"));
    let v = ss()?.on_every_hit_with(next_attack(), None)?;
    let t = turn(
        vec![atk(v.clone()), atk(v.clone()), atk(v.clone()), atk(v)],
        0.0,
    )?;
    close(want.mean(&t), 27.5867, 4);
    want.done();
    Ok(())
}

#[test]
fn agrees_across_turn_turn_from_and_the_chained_attack_spelling() -> T {
    let mut want = expect(
        FILE,
        &name("agrees across turn(), Turn.from() and the chained attack() spelling"),
    );
    let v = ss()?.on_every_hit_with(next_attack(), None)?;
    let via_turn = want.mean(&turn(
        vec![atk(v.clone()), atk(v.clone()), atk(dg()?)],
        0.0,
    )?);
    let spec = TurnSpec {
        attacks: vec![atk(v.clone()), atk(v.clone()), atk(dg()?)],
        ..TurnSpec::default()
    };
    let via_from = want.mean(&Turn::from_spec(spec, 0.0)?);
    let chained = turn(vec![], 0.0)?
        .attack(v.clone())?
        .attack(v)?
        .attack(dg()?)?;
    let via_chained = want.mean(&chained);
    close(via_turn, 19.2211, 4);
    close(via_from, via_turn, 10);
    close(via_chained, via_turn, 10);
    want.done();
    Ok(())
}

#[test]
fn a_save_gate_equals_f6() -> T {
    let mut want = expect(FILE, &name("a save gate equals F6 (19.7207)"));
    let save_gated = staff()?.on_every_hit_with(
        Grants::One(advantage().until_end_of_turn().into()),
        Some(ConditionGate {
            save: Some(TriggerSaves::One(TriggerSave::Dc(
                d20().plus(3.0)?.dc(15.0)?,
            ))),
            ..ConditionGate::default()
        }),
    )?;
    let t = turn(
        vec![atk(save_gated.clone()), atk(save_gated), atk(dg()?)],
        0.0,
    )?;
    close(want.mean(&t), 19.7207, 4);
    want.done();
    Ok(())
}

#[test]
fn on_any_crit_carries_a_crit_gated_condition() -> T {
    let mut want = expect(FILE, &name("onAnyCrit carries a crit-gated condition"));
    let plain = ss()?;
    let on_crit = plain.on_any_crit_with(next_attack(), None)?;
    assert_ne!(format!("{on_crit:?}"), format!("{plain:?}"));
    // A single shortsword has no later attack to read its crit advantage, so the mean is
    // unchanged; two shortswords gain a little from the first critting.
    let one = want.mean(&turn(vec![atk(on_crit.clone())], 0.0)?);
    let base = want.mean(&turn(vec![atk(plain.clone())], 0.0)?);
    close(one, base, 10);
    let two = want.mean(&turn(vec![atk(on_crit.clone()), atk(on_crit)], 0.0)?);
    let two_base = want.mean(&turn(vec![atk(plain.clone()), atk(plain)], 0.0)?);
    assert!(two > two_base);
    want.done();
    Ok(())
}

#[test]
fn snapshots_the_grants_array_and_the_gate_so_later_caller_mutation_is_inert() -> T {
    let mut want = expect(
        FILE,
        &name("snapshots the grants array and the gate, so later caller mutation is inert"),
    );
    // Rust owns what it is given: the caller cannot mutate the arrays after attaching, so both
    // builds are the same value.
    let mut build = |_mutate: bool| -> Result<f64, Box<dyn std::error::Error>> {
        let grants = vec![advantage().until_next_attack().into()];
        let on_save = vec![advantage().until_next_attack().into()];
        let v = ss()?.on_every_hit_with(
            Grants::Many(grants),
            Some(ConditionGate {
                chance: Some(0.5),
                on_save: Some(on_save),
                ..ConditionGate::default()
            }),
        )?;
        let t = turn(vec![atk(v.clone()), atk(v), atk(dg()?)], 0.0)?;
        Ok(want.mean(&t))
    };
    let mutated = build(true)?;
    let untouched = build(false)?;
    close(mutated, untouched, 10);
    want.done();
    Ok(())
}

#[test]
fn rejects_an_attached_condition_on_a_rider_source() -> T {
    let carrying = ss()?.on_every_hit_with(next_attack(), None)?;
    let t = turn(vec![named("a", ss()?)], 0.0)?;
    let result = t.on_first_miss_with(
        RiderDamage::One(DamageSource::Attack(Box::new(carrying))),
        RiderOptions {
            id: Some("reroll".to_string()),
            ..RiderOptions::default()
        },
    );
    assert_eq!(code_of(result), "unsupported-trigger");
    let _ = TurnSpecErrorCode::UnsupportedTrigger;
    Ok(())
}
