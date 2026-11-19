//! `src/turn/target-has-scale.test.ts`: 2 tests, 0 compat calls (no compat entries).
//!
//! Not translated: target-has-scale.test.ts:2,40-45: `enumerateSyntheticTurn` (the brute-force
//! oracle in tests/oracle/bruteForce.ts has no Rust port); the first test asserts the value the
//! oracle returns for `oracle(31)`, 99.93 (run once in TS), at the test's own 1e-12.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::save::SaveBuilder;
use crate::dnd5e::frightened;
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::effects::effect_spec;
use crate::turn::types::{
    AttackTriggerOn, ConditionOn, ConditionSpec, DamageSource, Rider, RiderDamage, RiderDamageSpec,
    SaveLanding, Trigger, TurnSpec, TurnSpecErrorCode,
};

fn sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(7.0)?
        .ac(16.0)?
        .melee()?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)
}

fn fear() -> Result<SaveBuilder, DiceError> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("wis")?
        .on_save_failure_args(&[Arg::Num(0.0)])
}

fn strings(of: &[&str]) -> Vec<String> {
    of.iter().map(|s| (*s).to_string()).collect()
}

/// C1's turn with one flat 4 rider per name in `names`, each gated on its own condition.
fn spec(names: &[String]) -> Result<TurnSpec, DiceError> {
    let riders = names
        .iter()
        .enumerate()
        .map(|(index, name)| -> Result<Rider, DiceError> {
            Ok(Rider {
                trigger: Trigger::EveryHit {
                    of: Some(strings(&["a", "b"])),
                    max: None,
                    per_source: None,
                },
                id: Some(format!("rider {index}")),
                damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Roll(flat(4.0)?))),
                crit_damage: None,
                landing: None,
                happens: None,
                joins: None,
                r#where: None,
                target_has: Some(vec![name.clone()]),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TurnSpec {
        attacks: vec![
            named("fear", fear()?),
            named("a", sword()?),
            named("b", sword()?),
        ],
        riders: Some(riders),
        conditions: Some(vec![ConditionSpec {
            id: None,
            on: ConditionOn::Attack(AttackTriggerOn::EveryHit),
            of: Some(strings(&["fear"])),
            r#where: None,
            chance: None,
            target_has: None,
            landing: Some(SaveLanding::Fail),
            dealing: None,
            target: None,
            save: None,
            grants: vec![effect_spec(&frightened().until_end_of_turn())],
            on_save: None,
            optional: false,
        }]),
        ..TurnSpec::default()
    })
}

#[test]
fn thirty_one_riders_gated_on_frightened_build_and_evaluate() -> T {
    let names = vec!["frightened".to_string(); 31];
    let mean = Turn::from_spec(spec(&names)?, 0.0)?.mean()?;
    assert!((mean - 99.93).abs() <= 1e-12);
    Ok(())
}

#[test]
fn thirty_one_riders_on_31_distinct_conditions_are_refused_as_too_many_states() -> T {
    let names: Vec<String> = (0..31).map(|index| format!("invented {index}")).collect();
    let result = Turn::from_spec(spec(&names)?, 0.0).and_then(|t| t.mean());
    let Err(DiceError::TurnSpec(error)) = result else {
        return Err(
            DiceError::error("expected a TurnSpecError, not a RangeError or success").into(),
        );
    };
    assert_eq!(error.code, TurnSpecErrorCode::TooManyStates);
    Ok(())
}
