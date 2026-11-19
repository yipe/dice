//! `src/turn/contractV2.test.ts`: 4 tests translated here (no compat calls: the file is not in the
//! fixture). The validation cases (lines 63-77) are translated in `plan/tests_validation.rs`; here
//! are the cases that read a mean (79-94, 101-110) and the revision (115).
//!
//! Not translated: src/turn/contractV2.test.ts:96-99: an unknown attack key (`{ source, aim }`): a
//! typed `AttackOptions` cannot carry one.
//! Not translated: src/turn/contractV2.test.ts:118-141: `expectTypeOf` checks of the exported types.
//! Not translated: src/turn/contractV2.test.ts:143-150: `@ts-expect-error` checks that an effect
//! needs `until` (a Rust `EffectSpec` variant cannot omit it).

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::{d8, d20};
use crate::common::RollType;
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::context::{ContextualSource, RowCheck, RowContext, RowKind, RowRange};
use crate::turn::types::{
    ArcContextual, AttackTriggerOn, CONTRACT_REVISION, ConditionOn, ConditionSpec,
    ContextualPayload, DamageSource, EffectSpec, GrantSpec, GrantUntil, LandingPayload, Rider,
    RiderDamage, RiderDamageSpec, Source, Trigger, TurnSpec, VulnerableLanding,
};
use crate::turn::{Turn, turn};
use std::sync::Arc;

fn sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(12.0)?.on_hit(d8().plus(3.0)?)
}

fn smite() -> Result<DamageSource, DiceError> {
    Ok(DamageSource::from(rs(2.0, 8.0)?))
}

fn grant_advantage() -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: true,
        disadvantage: false,
        crit_on_hit: false,
        until: GrantUntil::NextAttack,
        to: None,
    })
}

fn rider(damage: RiderDamageSpec) -> Rider {
    Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: None,
        damage,
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn every_hit_grant() -> ConditionSpec {
    ConditionSpec {
        id: None,
        on: ConditionOn::Attack(AttackTriggerOn::EveryHit),
        of: None,
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants: vec![grant_advantage()],
        on_save: None,
        optional: false,
    }
}

fn smite_rider() -> Result<Rider, DiceError> {
    Ok(rider(RiderDamageSpec::Plain(RiderDamage::One(smite()?))))
}

#[test]
fn leaves_a_spec_that_sets_no_new_field_unchanged_unset_optional_keys_included() -> T {
    let from = |riders: Vec<Rider>, conditions: Option<Vec<ConditionSpec>>| {
        Turn::from_spec(
            TurnSpec {
                attacks: vec![atk(sword()?), atk(sword()?)],
                riders: Some(riders),
                conditions,
                ..TurnSpec::default()
            },
            0.0,
        )
    };
    let plain = from(vec![smite_rider()?], None)?;
    // The TS `undefined` keys (`target`, `happens`, `joins`, `landing`, `save`, `stateLimit`) are the
    // `None` fields of the typed structs: this is the same spec as `with_condition`.
    let with_undefined = from(vec![smite_rider()?], Some(vec![every_hit_grant()]))?;
    let with_condition = from(vec![smite_rider()?], Some(vec![every_hit_grant()]))?;
    assert_eq!(with_undefined.mean()?, with_condition.mean()?);
    assert!(with_condition.mean()? > plain.mean()?);
    Ok(())
}

/// `payload`: the same 2d8 on every landing, doubled on a crit and under vulnerability.
struct SmitePayload(Pmf);

impl ContextualPayload for SmitePayload {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        Ok(LandingPayload {
            on_hit: (self.0.clone()).into(),
            on_crit: (self.0.clone()).into(),
            vulnerable: VulnerableLanding {
                on_hit: (self.0.clone()).into(),
                on_crit: (self.0.clone()).into(),
            },
        })
    }
}

#[test]
fn accepts_a_rider_payload_per_attack_contextual_payload() -> T {
    let payload = Arc::new(SmitePayload(rs(2.0, 8.0)?.to_pmf(0.0)?));
    let with = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword()?)],
            riders: Some(vec![rider(RiderDamageSpec::Contextual(payload))]),
            ..TurnSpec::default()
        },
        0.0,
    )?
    .mean()?;
    let without = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword()?)],
            ..TurnSpec::default()
        },
        0.0,
    )?
    .mean()?;
    assert!(with >= without);
    Ok(())
}

/// `contextual`: `{ rowCheck: check, under: () => sword.toPMF() }`.
struct Contextual(Pmf);

impl ContextualSource for Contextual {
    fn row_check(&self) -> RowCheck {
        RowCheck {
            kind: RowKind::Attack,
            range: Some(RowRange::Melee),
            ability: None,
            roll_type: RollType::Flat,
            advantage_dice: 2,
            pinned: false,
            auto_hit: false,
            auto_crit: false,
            auto_fail: false,
        }
    }
    fn under(&self, _context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        Ok(self.0.clone())
    }
}

fn contextual() -> Result<Source, DiceError> {
    Ok(Source::Contextual(ArcContextual(Arc::new(Contextual(
        sword()?.to_pmf(0.0)?,
    )))))
}

#[test]
fn accepts_a_contextual_source_a_contextual_source_rolls_its_own_context() -> T {
    let mean = sword()?.mean()?;
    let limited = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(contextual()?)],
            state_limit: Some(64.0),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    close(limited.mean()?, mean, 12);
    let two = turn(vec![atk(sword()?)], 0.0)?.attack(contextual()?)?;
    close(two.mean()?, 2.0 * mean, 12);
    Ok(())
}

#[test]
fn exports_the_revision() {
    assert_eq!(CONTRACT_REVISION, 6);
}
