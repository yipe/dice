//! `tests/turn-accepted-shapes.test.ts`: 6 tests, 0 compat calls (no fixture entries; the oracle numbers are asserted).
//!
//! Not translated: tests/turn-accepted-shapes.test.ts:15: `onAnyCrit(d6, options as never)` smuggles
//! `max` past the verb's type; the Rust verb's `ConditionOptions` has no `max`, so the test adds the
//! same any-crit rider as data (`Turn::rider`, `Trigger::AnyCrit { max }`), which is what the verb builds.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::error::DiceError;
use crate::turn::effects::advantage;
use crate::turn::types::{
    DamageSource, Rider, RiderDamage, RiderDamageSpec, RiderOptions, RiderPayload, SaveLanding,
    Trigger,
};
use crate::turn::{Turn, turn};
use indexmap::IndexMap;

use crate::turn::effects::{ConditionOptions, FirstHitOptions};

/// hit 0.6, crit 0.05: lands 0.65.
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(7.0, 15.0, d8().plus(4.0)?)
}

fn two_swords() -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![atk(sword()?), atk(sword()?)], 0.0)?)
}

fn three_swords() -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(
        vec![atk(sword()?), atk(sword()?), atk(sword()?)],
        0.0,
    )?)
}

fn damage(roll: crate::builder::roll::RollBuilder) -> RiderPayload {
    RiderPayload {
        damage: RiderDamage::One(DamageSource::Roll(roll)),
        crit_damage: None,
    }
}

/// `{ "attack 2": { damage: d8 } }`.
fn attack_2_folds_d8() -> IndexMap<String, RiderPayload> {
    let mut per_source = IndexMap::new();
    per_source.insert("attack 2".to_string(), damage(d8()));
    per_source
}

fn options(
    id: &str,
    of: Option<&[&str]>,
    wherever: Option<(&str, &[&str])>,
    landing: Option<SaveLanding>,
) -> ConditionOptions {
    ConditionOptions {
        rider: RiderOptions {
            id: Some(id.to_string()),
            of: of.map(|list| list.iter().map(std::string::ToString::to_string).collect()),
            r#where: wherever.map(|(key, ids)| {
                let mut map = IndexMap::new();
                map.insert(
                    key.to_string(),
                    ids.iter().map(std::string::ToString::to_string).collect(),
                );
                map
            }),
            landing,
            ..RiderOptions::default()
        },
        ..ConditionOptions::default()
    }
}

/// `onFirstHit(d6, { id: "folded", perSource: { "attack 2": { damage: d8 } }, ... })`.
fn folded(t: &Turn, landing: Option<SaveLanding>) -> Result<Turn, DiceError> {
    t.on_first_hit_with(
        d6(),
        FirstHitOptions {
            condition: options("folded", None, None, landing),
            per_source: Some(attack_2_folds_d8()),
        },
    )
}

/// `onFirstHit(d4, { of: ["folded"], id: "partner", where? })`.
fn partner(t: &Turn, wherever: Option<(&str, &[&str])>) -> Result<Turn, DiceError> {
    t.on_first_hit_with(
        d4(),
        FirstHitOptions {
            condition: options("partner", Some(&["folded"]), wherever, None),
            per_source: None,
        },
    )
}

#[test]
fn an_any_crit_rider_with_a_max_applies_to_its_first_max_crits() -> T {
    // An any-crit rider applies once, so `max: 1` changes nothing and `max: 2` adds the second
    // crit's (doubled) d6.
    let any_crit = |max: Option<f64>| -> Result<f64, Box<dyn std::error::Error>> {
        let rider = Rider {
            trigger: Trigger::AnyCrit { of: None, max },
            id: None,
            damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Roll(d6()))),
            crit_damage: None,
            landing: None,
            happens: None,
            joins: None,
            r#where: None,
            target_has: None,
        };
        Ok(two_swords()?.rider(rider)?.mean()?)
    };
    let plain = two_swords()?.mean()?;
    close(any_crit(None)?, plain + (1.0 - 0.95f64.powi(2)) * 7.0, 12);
    close(any_crit(Some(1.0))?, any_crit(None)?, 12);
    close(any_crit(Some(2.0))?, plain + 2.0 * 0.05 * 7.0, 12);
    Ok(())
}

#[test]
fn a_first_hit_rider_naming_one_folded_per_source_is_its_partner() -> T {
    let t = partner(&folded(&two_swords()?, None)?, None)?;
    close(t.fire_probability("folded")?, 1.0 - 0.35f64.powi(2), 12);
    close(
        t.fire_probability("partner")?,
        t.fire_probability("folded")?,
        12,
    );
    Ok(())
}

#[test]
fn a_partner_lands_only_where_its_partner_lands() -> T {
    // The partner (a step rider before the fix) fired on every hit of attack 3; it lands there
    // only where "folded" lands, i.e. when attack 3 is the first hit.
    let subset = partner(
        &folded(&three_swords()?, None)?,
        Some(("folded", &["attack 3"])),
    )?;
    close(subset.fire_probability("partner")?, 0.35 * 0.35 * 0.65, 12);

    // On a save row the partner landed on every class, a passed save included.
    let breath = d20()
        .plus(5.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(d8())])?
        .save_half()?; // fails on d20 <= 9: 0.45
    let base = folded(
        &turn(vec![atk(breath.clone()), atk(sword()?)], 0.0)?,
        Some(SaveLanding::Fail),
    )?;
    let save = partner(&base, None)?;
    close(save.fire_probability("folded")?, 1.0 - 0.55 * 0.35, 12);
    close(
        save.fire_probability("partner")?,
        save.fire_probability("folded")?,
        12,
    );
    // d4 (2.5) where it lands, doubled (5) where the landing is attack 2's crit: 0.55 * 0.05.
    close(
        save.mean()? - base.mean()?,
        2.5 * (1.0 - 0.55 * 0.35) + 2.5 * 0.55 * 0.05,
        12,
    );
    Ok(())
}

#[test]
fn a_partner_of_a_partner_is_refused() -> T {
    let t = partner(&folded(&two_swords()?, None)?, None)?;
    let result = t.on_first_hit_with(
        d4(),
        FirstHitOptions {
            condition: options("chained", Some(&["partner"]), None, None),
            per_source: None,
        },
    );
    let message = result
        .err()
        .map(|e| e.message().to_string())
        .unwrap_or_default();
    assert!(message.contains("lands alongside \"partner\""), "{message}");
    Ok(())
}

#[test]
fn a_partner_that_rolls_an_attack_of_its_own_is_refused_a_fold_naming_itself_is_a_self_reference()
-> T {
    let base = folded(&two_swords()?, None)?;
    let result = base.on_first_hit_with(
        sword()?,
        FirstHitOptions {
            condition: options("partner", Some(&["folded"]), None, None),
            per_source: None,
        },
    );
    let message = result
        .err()
        .map(|e| e.message().to_string())
        .unwrap_or_default();
    assert!(
        message.contains("cannot roll an attack of its own"),
        "{message}"
    );

    let result = turn(vec![atk(sword()?)], 0.0)?.on_first_hit_with(
        d6(),
        FirstHitOptions {
            condition: options("x", Some(&["x"]), None, None),
            per_source: Some(IndexMap::new()),
        },
    );
    let message = result
        .err()
        .map(|e| e.message().to_string())
        .unwrap_or_default();
    assert!(message.contains("cannot depend on itself"), "{message}");
    Ok(())
}

#[test]
fn a_grant_with_landing_fail_over_attacks_alone_lands_on_a_hit_as_by_default() -> T {
    let grant = || advantage().until_end_of_turn();
    let failing = two_swords()?
        .on_first_hit_with(
            grant(),
            FirstHitOptions {
                condition: options_landing_only(SaveLanding::Fail),
                per_source: None,
            },
        )?
        .mean()?;
    close(
        failing,
        two_swords()?
            .on_first_hit_with(grant(), FirstHitOptions::default())?
            .mean()?,
        12,
    );
    assert!(failing > two_swords()?.mean()?);
    Ok(())
}

fn options_landing_only(landing: SaveLanding) -> ConditionOptions {
    ConditionOptions {
        rider: RiderOptions {
            landing: Some(landing),
            ..RiderOptions::default()
        },
        ..ConditionOptions::default()
    }
}
