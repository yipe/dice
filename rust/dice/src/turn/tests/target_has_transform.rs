//! `src/turn/target-has-transform.test.ts`: 2 tests, 0 compat calls (asserts the oracle number).
//!
//! Not translated: target-has-transform.test.ts:11,20: the `@ts-expect-error` (type-level) half of
//! "refuses a transform", and the untyped `as any` call with a list (`Vec<String>` covers both).

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::dnd5e::{prone, save_dc};
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions, keep_best_damage};
use crate::turn::turn;
use crate::turn::types::{RiderOptions, TurnSpecErrorCode};

fn sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(7.0)?
        .ac(16.0)?
        .melee()?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)
}

fn first_hit_has(of: Option<Vec<String>>, target_has: &str) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                of,
                target_has: Some(vec![target_has.to_string()]),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

#[test]
fn refuses_a_transform_at_runtime() -> T {
    let base = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?;
    let refused = base.on_first_hit_transform(keep_best_damage(), first_hit_has(None, "prone"));
    let Err(DiceError::TurnSpec(error)) = refused else {
        return Err(DiceError::error(
            "onFirstHit(transform, { targetHas }) must throw a TurnSpecError",
        )
        .into());
    };
    assert_eq!(error.code, TurnSpecErrorCode::UnsupportedTrigger);
    assert!(error.message.contains("targetHas"));
    Ok(())
}

#[test]
fn still_gates_a_first_hit_grant_free_rider_by_target_has() -> T {
    let mean = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
        .on_every_hit_with(
            prone().until_end_of_turn(),
            EveryHitOptions {
                first_hit: FirstHitOptions {
                    condition: ConditionOptions {
                        rider: RiderOptions {
                            of: Some(vec!["attack 1".to_string()]),
                            ..RiderOptions::default()
                        },
                        save: Some(save_dc(15.0, &[("con", 3.0)])?.into()),
                        ..ConditionOptions::default()
                    },
                    ..FirstHitOptions::default()
                },
                ..EveryHitOptions::default()
            },
        )?
        .on_first_hit_with(
            rs(1.0, 6.0)?,
            first_hit_has(
                Some(vec!["attack 1".to_string(), "attack 2".to_string()]),
                "prone",
            ),
        )?
        .mean()?;
    assert!((mean - 12.47655).abs() <= 1e-12);
    Ok(())
}
