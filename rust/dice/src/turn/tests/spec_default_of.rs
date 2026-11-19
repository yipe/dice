//! `tests/turn-spec-default-of.test.ts`: 2 tests, 594 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::{d6, d20};
use crate::error::DiceError;
use crate::turn::compat::Expected;
use crate::turn::effects::{ConditionOptions, FirstHitOptions, keep_best_damage};
use crate::turn::types::{
    Attack, DamageSource, Rider, RiderDamage, RiderDamageSpec, SubstituteKind, SubstituteOn,
    SubstituteSpec, Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/turn-spec-default-of.test.ts";
const SUITE: &str = "an omitted `of` in plain data";

/// d20+9 vs AC 18 for 1d12+18, plus a 1d4 channel.
fn kensei() -> Result<AttackBuilder, DiceError> {
    Ok(d20()
        .plus(9.0)?
        .ac(18.0)?
        .on_hit(rs(1.0, 12.0)?.plus(18.0)?)?
        .plus_separate_damage(rs(1.0, 4.0)?))
}

fn two_kensei() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![atk(kensei()?), atk(kensei()?)])
}

fn rider(id: &str, trigger: Trigger, damage: impl Into<RiderDamage>) -> Rider {
    Rider {
        trigger,
        id: Some(id.to_string()),
        damage: RiderDamageSpec::Plain(damage.into()),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn every_hit_trigger() -> Trigger {
    Trigger::EveryHit {
        of: None,
        max: None,
        per_source: None,
    }
}

/// `expectSamePMF`: every value of the union of both supports, each read through `.pmf`.
fn expect_same_pmf(want: &mut Expected, actual: &Turn, expected: &Turn) {
    let mut support = want.pmf(actual).support();
    support.extend(want.pmf(expected).support());
    let mut seen = Vec::new();
    for value in support {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    for value in seen {
        let a = want.pmf(actual).p_at(value.0);
        let b = want.pmf(expected).p_at(value.0);
        close(a, b, 14);
    }
}

#[test]
fn watches_the_attack_shaped_rerolls_too_like_the_chaining_spelling() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > watches the attack-shaped rerolls too, like the chaining spelling"),
    );
    let spec = Turn::from_spec(
        TurnSpec {
            attacks: two_kensei()?,
            riders: Some(vec![rider(
                "reroll",
                Trigger::AnyMiss { of: None },
                DamageSource::from(kensei()?),
            )]),
            substitutes: Some(vec![SubstituteSpec {
                id: Some("sub".to_string()),
                on: SubstituteOn::FirstHit,
                of: None,
                substitute: SubstituteKind::RerollKeepHigher,
                mode: None,
                policy: None,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let chain = turn(two_kensei()?, 0.0)?
        .on_any_miss_with(DamageSource::from(kensei()?), rid("reroll"))?
        .on_first_hit_transform(
            keep_best_damage(),
            FirstHitOptions {
                condition: ConditionOptions {
                    rider: rid("sub"),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
        )?;

    close(want.mean(&spec), 39638071.0 / 864000.0, 12);
    close(want.fire(&spec, "sub"), 117.0 / 125.0, 14);
    expect_same_pmf(&mut want, &spec, &chain);
    want.done();
    Ok(())
}

#[test]
fn gives_a_rider_the_rerolls_listed_before_it_as_the_chain_snapshots_them() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SUITE} > gives a rider the rerolls listed before it, as the chain snapshots them"
        ),
    );
    let after = Turn::from_spec(
        TurnSpec {
            attacks: two_kensei()?,
            riders: Some(vec![
                rider(
                    "reroll",
                    Trigger::FirstMiss { of: None },
                    DamageSource::from(kensei()?),
                ),
                rider("mark", every_hit_trigger(), DamageSource::from(d6())),
            ]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let chained = turn(two_kensei()?, 0.0)?
        .on_first_miss_with(DamageSource::from(kensei()?), rid("reroll"))?
        .on_every_hit_with(d6(), every_hit(Some("mark"), None))?;
    expect_same_pmf(&mut want, &after, &chained);

    let before = Turn::from_spec(
        TurnSpec {
            attacks: two_kensei()?,
            riders: Some(vec![
                rider("mark", every_hit_trigger(), DamageSource::from(d6())),
                rider(
                    "reroll",
                    Trigger::FirstMiss { of: None },
                    DamageSource::from(kensei()?),
                ),
            ]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let chained = turn(two_kensei()?, 0.0)?
        .on_every_hit_with(d6(), every_hit(Some("mark"), None))?
        .on_first_miss_with(DamageSource::from(kensei()?), rid("reroll"))?;
    expect_same_pmf(&mut want, &before, &chained);
    want.done();
    Ok(())
}
