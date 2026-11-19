//! `src/builder/attached-target-has.test.ts`: 1 test, 0 compat calls (no compat entries; asserts
//! the oracle number in the test).

use super::helpers::*;
use crate::builder::attack::{AttackBuilder, ConditionGate, Grants};
use crate::builder::factory::*;
use crate::dnd5e::{prone, save_dc};
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions, crit_on_hit};
use crate::turn::turn;
use crate::turn::types::RiderOptions;

fn sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(7.0)?
        .ac(16.0)?
        .melee()?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)
}

#[test]
fn c6_is_18_3886695_bit_for_bit_equal_to_the_turn_level_form() -> T {
    let topple = sword()?.on_every_hit_with(
        Grants::One(prone().until_end_of_turn()),
        Some(ConditionGate {
            save: Some(save_dc(15.0, &[("con", 3.0)])?.into()),
            ..ConditionGate::default()
        }),
    )?;
    let gated_crit = sword()?.on_every_hit_with(
        Grants::One(crit_on_hit().until_end_of_turn().into()),
        Some(ConditionGate {
            target_has: Some(vec!["prone".to_string()]),
            ..ConditionGate::default()
        }),
    )?;
    let attached = turn(
        vec![atk(topple.clone()), atk(gated_crit), atk(sword()?)],
        0.0,
    )?;
    let turn_level = turn(vec![atk(topple), atk(sword()?), atk(sword()?)], 0.0)?
        .on_every_hit_with(
            crit_on_hit().until_end_of_turn(),
            EveryHitOptions {
                first_hit: FirstHitOptions {
                    condition: ConditionOptions {
                        rider: RiderOptions {
                            of: Some(vec!["attack 2".to_string()]),
                            target_has: Some(vec!["prone".to_string()]),
                            ..RiderOptions::default()
                        },
                        ..ConditionOptions::default()
                    },
                    ..FirstHitOptions::default()
                },
                ..EveryHitOptions::default()
            },
        )?;
    let mean = attached.mean()?;
    assert!((mean - 18.3886695).abs() <= 1e-12);
    assert_eq!(mean.to_bits(), turn_level.mean()?.to_bits());
    Ok(())
}
