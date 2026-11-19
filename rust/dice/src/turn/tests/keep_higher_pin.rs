//! `src/turn/keep-higher-pin.test.ts`: 5 tests, 0 compat calls (the TS test records none).

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::turn::context::{ContextualSource, RowCheck, RowContext};
use crate::turn::effects::{FirstHitOptions, keep_best_damage};
use crate::turn::types::{
    ArcContextual, AttackOptions, AttackTriggerOn, ConditionOn, ConditionSpec, DamageSource,
    EffectSpec, GrantSpec, GrantUntil, Rider, RiderDamage, RiderDamageSpec, Source, SubstituteKind,
    SubstituteOn, SubstituteSpec, Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use std::sync::Arc;

// Every first-hit substitute path a source without `rerolledUnder` takes, pinned bit for bit to the
// values 0.23.0 gives (captured on 0.23.0 itself). A change here means an existing caller moved.

/// A 53-bit hash (cyrb53) of `text`, with JS's int32 arithmetic.
fn hash(text: &str) -> String {
    let mut h1: i32 = 0xdead_beef_u32 as i32;
    let mut h2: i32 = 0x41c6_ce57_u32 as i32;
    for unit in text.encode_utf16() {
        let ch = i32::from(unit);
        h1 = (h1 ^ ch).wrapping_mul(2_654_435_761_u32 as i32);
        h2 = (h2 ^ ch).wrapping_mul(1_597_334_677_u32 as i32);
    }
    let shr = |x: i32, n: u32| ((x as u32) >> n) as i32;
    h1 = (h1 ^ shr(h1, 16)).wrapping_mul(2_246_822_507_u32 as i32)
        ^ (h2 ^ shr(h2, 13)).wrapping_mul(3_266_489_909_u32 as i32);
    h2 = (h2 ^ shr(h2, 16)).wrapping_mul(2_246_822_507_u32 as i32)
        ^ (h1 ^ shr(h1, 13)).wrapping_mul(3_266_489_909_u32 as i32);
    format!("{:08x}{:08x}", h2 as u32, h1 as u32)
}

/// Every value's exact probability and the hit and crit masses, as one hash.
fn fingerprint(pmf: &Pmf) -> String {
    let mut support: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    support.sort_by(f64::total_cmp);
    let bins: Vec<String> = support
        .iter()
        .map(|value| {
            format!(
                "[{},{}]",
                num_to_string(*value),
                num_to_string(pmf.p_at(*value))
            )
        })
        .collect();
    let text = format!(
        "[[{}],{},{}]",
        bins.join(","),
        num_to_string(pmf.filter_outcome("hit").mass()),
        num_to_string(pmf.filter_outcome("crit").mass())
    );
    hash(&text)
}

type R<X> = Result<X, Box<dyn std::error::Error>>;

fn sword() -> R<AttackBuilder> {
    Ok(attack_roll(5.0, 15.0, rs(1.0, 8.0)?.plus(3.0)?)?)
}

fn channelled() -> R<AttackBuilder> {
    Ok(sword()?.plus_separate_damage(rs(1.0, 6.0)?))
}

fn pooled() -> R<AttackBuilder> {
    Ok(attack_roll(
        5.0,
        15.0,
        rs(1.0, 8.0)?.plus(3.0)?.plus_dice(3.0, &d6())?,
    )?)
}

/// A row rider "sa"'s dice join, with no `rerolledUnder`: keep-higher of its whole payload.
struct PoolingRow {
    sword: AttackBuilder,
    pooled: AttackBuilder,
}

impl ContextualSource for PoolingRow {
    fn row_check(&self) -> RowCheck {
        self.sword.row_check()
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        if context.joined.iter().any(|id| id == "sa") {
            self.pooled.under(context, eps)
        } else {
            self.sword.under(context, eps)
        }
    }
}

fn declared(id: &str, source: Source) -> crate::turn::types::Attack {
    crate::turn::types::Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            ..AttackOptions::default()
        },
        source,
    }
}

fn contextual_row() -> R<Turn> {
    let row = Source::Contextual(ArcContextual(Arc::new(PoolingRow {
        sword: sword()?,
        pooled: pooled()?,
    })));
    let names = |ids: &[&str]| {
        Some(
            ids.iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>(),
        )
    };
    Ok(Turn::from_spec(
        TurnSpec {
            attacks: vec![declared("a", row.clone()), declared("b", row)],
            riders: Some(vec![Rider {
                trigger: Trigger::FirstHit {
                    of: None,
                    per_source: None,
                },
                id: Some("sa".to_string()),
                damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Roll(rs(3.0, 6.0)?))),
                crit_damage: None,
                landing: None,
                happens: None,
                joins: names(&["a", "b"]),
                r#where: None,
                target_has: None,
            }]),
            conditions: Some(vec![ConditionSpec {
                id: Some("vex".to_string()),
                on: ConditionOn::Attack(AttackTriggerOn::FirstMiss),
                of: names(&["a"]),
                r#where: None,
                chance: None,
                target_has: None,
                landing: None,
                dealing: None,
                target: None,
                save: None,
                grants: vec![EffectSpec::Grant(GrantSpec {
                    advantage: true,
                    disadvantage: false,
                    crit_on_hit: false,
                    until: GrantUntil::NextAttack,
                    to: None,
                })],
                on_save: None,
                optional: false,
            }]),
            substitutes: Some(vec![SubstituteSpec {
                id: Some("savage".to_string()),
                on: SubstituteOn::FirstHit,
                of: None,
                substitute: SubstituteKind::RerollKeepHigher,
                mode: None,
                policy: None,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?)
}

fn scenario(name: &str) -> R<Turn> {
    let attacks = |list: Vec<AttackBuilder>| list.into_iter().map(atk).collect::<Vec<_>>();
    Ok(match name {
        "keep-higher over two swords" => turn(attacks(vec![sword()?, sword()?]), 0.0)?
            .on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())?,
        "keep-higher below a threshold" => turn(attacks(vec![sword()?, sword()?, sword()?]), 0.0)?
            .on_first_hit_transform(
                keep_best_damage().if_below_split(10.0, 18.0)?,
                FirstHitOptions::default(),
            )?,
        "keep-higher with a separate channel and an every-hit rider" => {
            turn(attacks(vec![channelled()?, channelled()?]), 0.0)?
                .on_every_hit_with(rs(1.0, 6.0)?, Default::default())?
                .on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())?
        }
        "keep-higher over a contextual row a rider joins, with a granted advantage" => {
            contextual_row()?
        }
        "convert the first miss" => turn(attacks(vec![sword()?, sword()?]), 0.0)?
            .convert_first_miss(None, None)?
            .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?,
        other => return Err(format!("no scenario {other}").into()),
    })
}

/// The turn's PMF, then each attack's marginal, as `fingerprint`s from 0.23.0 (`bcc1eeb`).
const PINNED: [(&str, &str); 5] = [
    (
        "keep-higher over two swords",
        "cab874ee9180c83e 8d5b9a3888633267 28f2bce6b863db25",
    ),
    (
        "keep-higher below a threshold",
        "3741ed34700d1897 6dfaf4d8e205ba27 63adea5bf8d2e984 8dc69efd3dcd0125",
    ),
    (
        "keep-higher with a separate channel and an every-hit rider",
        "6592eaea2faaead8 b34917d61fbab1af 45b5f6658bb46e53",
    ),
    (
        "keep-higher over a contextual row a rider joins, with a granted advantage",
        "a401b3e1bf95b398 290e4376fe42455e ad5e0babba2201d8",
    ),
    (
        "convert the first miss",
        "db477a986adb4987 30d5aeb3d087d2db 66f7a0827cce9b38",
    ),
];

fn pinned_fingerprints(name: &str) -> R<()> {
    let t = scenario(name)?;
    let mut parts = vec![fingerprint(&t.pmf()?)];
    for id in t.attack_ids()? {
        parts.push(fingerprint(t.marginal(&id)?.pmf()));
    }
    let want = PINNED.iter().find(|(n, _)| *n == name).map(|(_, v)| *v);
    assert_eq!(Some(parts.join(" ").as_str()), want, "{name}");
    Ok(())
}

#[test]
fn keep_higher_over_two_swords() -> T {
    pinned_fingerprints("keep-higher over two swords")
}

#[test]
fn keep_higher_below_a_threshold() -> T {
    pinned_fingerprints("keep-higher below a threshold")
}

#[test]
fn keep_higher_with_a_separate_channel_and_an_every_hit_rider() -> T {
    pinned_fingerprints("keep-higher with a separate channel and an every-hit rider")
}

#[test]
fn keep_higher_over_a_contextual_row_a_rider_joins_with_a_granted_advantage() -> T {
    pinned_fingerprints("keep-higher over a contextual row a rider joins, with a granted advantage")
}

#[test]
fn convert_the_first_miss() -> T {
    pinned_fingerprints("convert the first miss")
}
