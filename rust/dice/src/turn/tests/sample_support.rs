//! Shared by `sample_conformance` and `sample_draw_order`: the ports of `tests/helpers/lcg.ts`,
//! `tests/helpers/gtest.ts` and `tests/helpers/fixtures.ts` (the 22 fixture turns and the 5
//! builder fixtures).

use super::helpers::{close, rs};
use crate::Pmf;
use crate::builder::attack::{AttackBuilder, AttackSample};
use crate::builder::factory::{SidesOrDie, d4, d6, d8, d20, roll_dice, roll_with};
use crate::builder::roll::{Arg, RollBuilder, RollRerollUpToOptions};
use crate::builder::sample::{RollSample, SampledDie};
use crate::common::Rng;
use crate::damage::Damage;
use crate::dnd5e::paralyzed;
use crate::error::DiceError;
use crate::turn::context::{RowCheck, RowContext, RowKind};
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, advantage, keep_best_damage, save_penalty,
    vulnerability,
};
use crate::turn::types::{
    After, AfterLanding, ArcContextual, Attack, AttackOptions, ContextualPayload, ContextualSource,
    DamageSource, LandingPayload, LandingRoll, Rider, RiderDamage, RiderDamageSpec, RiderLanding,
    RiderOptions, RollUnder, Source, SubstituteKind, SubstituteOn, SubstituteSpec, Trigger,
    TurnSpec, VulnerableLanding,
};
use crate::turn::{Turn, turn};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

pub type Res<X> = Result<X, Box<dyn std::error::Error>>;

// ---- lcg.ts --------------------------------------------------------------------------------------

/// `lcgRng(seed)`: mulberry32; `die()` rejection-samples a full uint32, `chance()` uses 53 bits.
pub struct Lcg {
    s: u32,
}

pub fn lcg_rng(seed: u32) -> Lcg {
    Lcg { s: seed }
}

impl Lcg {
    fn next(&mut self) -> u32 {
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
}

impl Rng for Lcg {
    fn die(&mut self, sides: f64) -> f64 {
        let modulus = 4_294_967_296.0_f64;
        let limit = modulus - (modulus % sides);
        let mut x = self.next();
        while f64::from(x) >= limit {
            x = self.next();
        }
        (f64::from(x) % sides) + 1.0
    }
    fn chance(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        let a = self.next();
        let b = self.next();
        (f64::from(a >> 5) * 67_108_864.0 + f64::from(b >> 6)) / 9_007_199_254_740_992.0 < p
    }
}

// ---- gtest.ts ------------------------------------------------------------------------------------

fn lgamma(z: f64) -> f64 {
    let c = [
        76.180_091_729_471_46,
        -86.505_320_329_416_77,
        24.014_098_240_830_91,
        -1.231_739_572_450_155,
        0.001_208_650_973_866_179,
        -0.000_005_395_239_384_953,
    ];
    let mut y = z;
    let mut t = z + 5.5;
    t -= (z + 0.5) * t.ln();
    let mut s = 1.000_000_000_190_015;
    for k in c {
        y += 1.0;
        s += k / y;
    }
    -t + (2.506_628_274_631_000_5 * s / z).ln()
}

/// Regularized upper incomplete gamma Q(a, x) (series/continued fraction, Numerical Recipes).
pub fn gamma_q(a: f64, x: f64) -> f64 {
    if x < a + 1.0 {
        let mut sum = 1.0 / a;
        let mut del = sum;
        let mut ap = a;
        for _ in 0..500 {
            ap += 1.0;
            del *= x / ap;
            sum += del;
            if del.abs() < sum.abs() * 1e-14 {
                break;
            }
        }
        return 1.0 - sum * (-x + a * x.ln() - lgamma(a)).exp();
    }
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / 1e-300;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..500 {
        let i = f64::from(i);
        let an = -i * (i - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < 1e-300 {
            d = 1e-300;
        }
        c = b + an / c;
        if c.abs() < 1e-300 {
            c = 1e-300;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-14 {
            break;
        }
    }
    (-x + a * x.ln() - lgamma(a)).exp() * h
}

pub struct GTest {
    pub g: f64,
    pub df: usize,
    pub p: f64,
}

/// G-test of `observed` counts (value -> count, `n` in all) against `expected`, pooling expected
/// counts under 5 into the next bin. An observed value the PMF gives no mass is impossible under
/// it, so p is 0 at once.
pub fn g_test(observed: &BTreeMap<i64, u64>, expected: &Pmf, n: u64) -> GTest {
    let total: u64 = observed.values().sum();
    assert_eq!(total, n, "gTest: n must equal the observed total");
    let nf = n as f64;
    let mut values: Vec<i64> = expected
        .support()
        .iter()
        .map(|d: &Damage| d.0 as i64)
        .collect();
    values.extend(observed.keys().copied());
    values.sort_unstable();
    values.dedup();
    let (mut bins, mut acc): (Vec<(f64, f64)>, (f64, f64)) = (Vec::new(), (0.0, 0.0));
    for v in &values {
        let o = observed.get(v).copied().unwrap_or(0) as f64;
        let p = expected.p_at(*v as f64);
        if o > 0.0 && p == 0.0 {
            return GTest {
                g: f64::INFINITY,
                df: values.len().saturating_sub(1).max(1),
                p: 0.0,
            };
        }
        acc.0 += o;
        acc.1 += p * nf;
        if acc.1 >= 5.0 {
            bins.push(acc);
            acc = (0.0, 0.0);
        }
    }
    if acc.1 > 0.0 || acc.0 > 0.0 {
        match bins.last_mut() {
            Some(last) => {
                last.0 += acc.0;
                last.1 += acc.1;
            }
            None => bins.push(acc),
        }
    }
    let g: f64 = bins
        .iter()
        .filter(|(o, _)| *o > 0.0)
        .map(|(o, e)| 2.0 * o * (o / e).ln())
        .sum();
    let df = bins.len().saturating_sub(1).max(1);
    GTest {
        g,
        df,
        p: gamma_q(df as f64 / 2.0, g / 2.0),
    }
}

#[test]
fn gamma_q_known_values() {
    // Q(1, x) = e^-x; Q(0.5, x) = erfc(sqrt(x)).
    close(gamma_q(1.0, 2.0), (-2.0_f64).exp(), 10);
    close(gamma_q(0.5, 1.0), 0.157_299_207_050_285_1, 8);
    close(gamma_q(10.0, 30.0), 0.000_1, 3);
}

// ---- fixtures.ts ---------------------------------------------------------------------------------

pub fn sword() -> Res<AttackBuilder> {
    Ok(d20()
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(roll_dice(1.0, 8.0, Some(3.0))?)?)
}

pub fn dagger() -> Res<AttackBuilder> {
    Ok(d20()
        .plus(5.0)?
        .ac(15.0)?
        .crit_on(19.0)?
        .on_hit(roll_dice(1.0, 4.0, Some(3.0))?)?)
}

/// `roll(count, die)`.
pub fn roll_of(count: f64, die: RollBuilder) -> Res<RollBuilder> {
    Ok(roll_with(count, Some(SidesOrDie::Die(die)), None)?)
}

pub fn atk_of(source: impl Into<Source>) -> Attack {
    Attack::Bare(source.into())
}

pub fn decl(id: &str, source: impl Into<Source>) -> Attack {
    decl_with(id, None, None, None, source)
}

pub fn decl_with(
    id: &str,
    chance: Option<f64>,
    after: Option<After>,
    target: Option<&str>,
    source: impl Into<Source>,
) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            tag: None,
            chance,
            target: target.map(str::to_string),
            after,
        },
        source: source.into(),
    }
}

pub fn after(of: &str, landing: AfterLanding) -> Option<After> {
    Some(After {
        of: of.to_string(),
        landing,
    })
}

pub fn contextual(source: impl ContextualSource + 'static) -> Source {
    Source::Contextual(ArcContextual(Arc::new(source)))
}

pub fn dmg(roll: RollBuilder) -> Source {
    Source::Damage(DamageSource::Roll(roll))
}

/// A `Rider` literal: `{ on, id, damage, happens, landing, joins }`.
pub fn rider_of(
    trigger: Trigger,
    id: Option<&str>,
    damage: RiderDamageSpec,
    happens: Option<f64>,
    landing: Option<RiderLanding>,
    joins: Option<&[&str]>,
) -> Rider {
    Rider {
        trigger,
        id: id.map(str::to_string),
        damage,
        crit_damage: None,
        landing,
        happens,
        joins: joins.map(|j| j.iter().map(|s| (*s).to_string()).collect()),
        r#where: None,
        target_has: None,
    }
}

pub fn plain(roll: impl Into<RiderDamage>) -> RiderDamageSpec {
    RiderDamageSpec::Plain(roll.into())
}

pub fn first_hit() -> Trigger {
    Trigger::FirstHit {
        of: None,
        per_source: None,
    }
}

pub fn first_hit_of(of: &[&str]) -> Trigger {
    Trigger::FirstHit {
        of: Some(of.iter().map(|s| (*s).to_string()).collect()),
        per_source: None,
    }
}

pub fn every_hit_trigger(max: Option<f64>) -> Trigger {
    Trigger::EveryHit {
        of: None,
        max,
        per_source: None,
    }
}

pub fn sub_id(id: &str) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                id: Some(id.to_string()),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

pub fn opts_of(of: &[&str]) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                of: Some(of.iter().map(|s| (*s).to_string()).collect()),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

pub fn hit_opts(id: Option<&str>, happens: Option<f64>, chance: Option<f64>) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                id: id.map(str::to_string),
                ..RiderOptions::default()
            },
            happens,
            chance,
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

pub fn every_hit_opts(id: Option<&str>, max: Option<f64>) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: hit_opts(id, None, None),
        max,
    }
}

fn pooling_check() -> RowCheck {
    RowCheck {
        kind: RowKind::Attack,
        range: None,
        ability: None,
        roll_type: crate::common::RollType::Flat,
        advantage_dice: 2,
        pinned: false,
        auto_hit: false,
        auto_crit: false,
        auto_fail: false,
    }
}

/// The sword with rider "sa"'s 3d6 in its own roll.
fn pooled() -> Res<AttackBuilder> {
    let damage = roll_of(1.0, d8())?.plus(3.0)?.plus_dice(3.0, &d6())?;
    Ok(d20().plus(5.0)?.ac(15.0)?.on_hit(damage)?)
}

/// A row that rolls rider "sa"'s dice in its own damage when the rider joins it (`Rider.joins`),
/// with the reroll it takes (`rerolledUnder`) when `savage`: Savage Attacker rolls the weapon's d8
/// twice, the pool's 3d6 once.
pub struct PoolingRow {
    pub savage: bool,
}

impl PoolingRow {
    fn pick(&self, context: &RowContext) -> Result<AttackBuilder, DiceError> {
        let b = if context.joined.iter().any(|j| j == "sa") {
            pooled()
        } else {
            sword()
        };
        b.map_err(|e| DiceError::error(e.to_string()))
    }
}

impl ContextualSource for PoolingRow {
    fn row_check(&self) -> RowCheck {
        pooling_check()
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.pick(context)?.under(context, eps)
    }
    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        Ok(Some(RollUnder::Attack(Box::new(
            self.pick(context)?.roll_under(context)?,
        ))))
    }
    fn has_rerolled_under(&self) -> bool {
        self.savage
    }
    fn rerolled_under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        let weapon = roll_of(1.0, d8())
            .and_then(|r| Ok(r.max_of(2.0)?.plus(3.0)?))
            .map_err(|e| e.to_string())?;
        let damage = if context.joined.iter().any(|j| j == "sa") {
            weapon.plus_dice(3.0, &d6())?
        } else {
            weapon
        };
        d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(damage)?
            .under(context, eps)
    }
}

fn breath_check() -> Result<RollBuilder, DiceError> {
    d20().plus(3.0)?.dc(15.0)?.ability("wis")
}

/// A save row that builds its own check per context (`DCBuilder.rolledIn`).
pub struct PenalisedSave;

impl PenalisedSave {
    fn built(context: &RowContext) -> Result<crate::builder::save::SaveBuilder, DiceError> {
        let rolled = breath_check()?.rolled_in(&crate::builder::dc::RolledIn {
            roll_type: context.roll_type,
            auto_fail: context.auto_fail,
            penalty_dice: &context.penalty_dice,
        })?;
        rolled.on_save_failure_args(&[Arg::Roll(roll_dice(3.0, 6.0, None)?)])
    }
}

impl ContextualSource for PenalisedSave {
    fn row_check(&self) -> RowCheck {
        let save = breath_check()
            .and_then(|b| b.on_save_failure_args(&[Arg::Roll(roll_dice(3.0, 6.0, None)?)]));
        match save {
            Ok(s) => s.row_check(),
            Err(e) => panic!("{e}"),
        }
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        Self::built(context)?.to_pmf(eps)
    }
    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        Ok(Some(RollUnder::Save(Box::new(Self::built(context)?))))
    }
}

fn double(pmf: &Pmf) -> Pmf {
    pmf.map_damage(|x| 2.0 * x)
}

/// A rider payload read per attack with the rolls behind it (`ContextualPayload.rollAt`): rider
/// dice, not a chip. `hit`/`crit` are the rolls; `rolled_vulnerable` also gives the vulnerable pair.
pub struct SneakPerAttack {
    pub hit: RollBuilder,
    pub crit: RollBuilder,
}

impl ContextualPayload for SneakPerAttack {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        let on_hit = self.hit.to_pmf(0.0)?;
        let on_crit = self.crit.to_pmf(0.0)?;
        Ok(LandingPayload {
            vulnerable: VulnerableLanding {
                on_hit: (double(&on_hit)).into(),
                on_crit: (double(&on_crit)).into(),
            },
            on_hit: on_hit.into(),
            on_crit: on_crit.into(),
        })
    }
    fn roll_at(&self, _attack_id: &str) -> Result<Option<LandingRoll>, DiceError> {
        Ok(Some(LandingRoll {
            on_hit: self.hit.clone(),
            on_crit: self.crit.clone(),
            vulnerable: None,
        }))
    }
}

pub fn sneak_per_attack() -> Res<RiderDamageSpec> {
    Ok(RiderDamageSpec::Contextual(Arc::new(SneakPerAttack {
        hit: rs(3.0, 6.0)?,
        crit: rs(6.0, 6.0)?,
    })))
}

pub type Build = fn() -> Res<Turn>;

/// The fixture turns every sampler conformance test runs: one per semantic trap the audit names.
pub fn fixtures() -> Vec<(&'static str, Build)> {
    vec![
        ("two attacks + sneak attack", || {
            Ok(turn(vec![decl("a", sword()?), decl("b", dagger()?)], 0.0)?
                .on_first_hit_with(rs(3.0, 6.0)?, sub_id("sneak"))?)
        }),
        ("advantage grant until next attack", || {
            let a = sword()?.on_every_hit_with(
                crate::builder::attack::Grants::One(advantage().until_next_attack().into()),
                None,
            )?;
            Ok(turn(vec![decl("a", a), decl("b", sword()?)], 0.0)?)
        }),
        ("any-miss reroll (GWM-like)", || {
            Ok(
                turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?.on_any_miss_with(
                    sword()?,
                    RiderOptions {
                        id: Some("reroll".into()),
                        ..RiderOptions::default()
                    },
                )?,
            )
        }),
        ("save with half and a rider on fail", || {
            let fb = d20()
                .plus(3.0)?
                .dc(15.0)?
                .on_save_failure_args(&[Arg::Roll(roll_dice(8.0, 6.0, None)?)])?
                .save_half()?;
            let mut o = sub_id("rider");
            o.condition.rider.landing = Some(crate::turn::types::SaveLanding::Fail);
            Ok(turn(vec![decl("fb", fb)], 0.0)?.on_first_hit_with(rs(2.0, 6.0)?, o)?)
        }),
        ("chance and after gates", || {
            Ok(turn(
                vec![
                    decl_with("a", Some(0.6), None, None, sword()?),
                    decl_with("b", None, after("a", AfterLanding::Hit), None, sword()?),
                ],
                0.0,
            )?)
        }),
        ("happens coin on a damage rider", || {
            Ok(turn(vec![decl("a", sword()?)], 0.0)?
                .on_first_hit_with(rs(1.0, 6.0)?, hit_opts(Some("hex"), Some(0.7), None))?)
        }),
        ("every-hit capped", || {
            Ok(turn(
                vec![
                    decl("a", sword()?),
                    decl("b", sword()?),
                    decl("c", sword()?),
                ],
                0.0,
            )?
            .on_every_hit_with(rs(1.0, 6.0)?, every_hit_opts(Some("hunter"), Some(2.0)))?)
        }),
        ("substitute reroll-keep-higher", || {
            Ok(turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?
                .on_first_hit_transform(keep_best_damage(), sub_id("sub"))?)
        }),
        ("convert first miss + sneak attack", || {
            Ok(turn(vec![decl("a", sword()?), decl("b", dagger()?)], 0.0)?
                .convert_first_miss(Some("boon"), None)?
                .on_first_hit_with(rs(3.0, 6.0)?, sub_id("sneak"))?)
        }),
        ("dice-match bounce", || {
            let orb = d20().plus(7.0)?.ac(15.0)?.on_hit(rs(3.0, 8.0)?)?;
            let leap = d20().plus(7.0)?.ac(15.0)?.on_hit(rs(3.0, 8.0)?)?;
            Ok(turn(vec![decl("orb", orb)], 0.0)?.on_dice_match_with(
                &["orb"],
                leap,
                RiderOptions {
                    id: Some("leap".into()),
                    ..RiderOptions::default()
                },
            )?)
        }),
        ("rerollUpTo + explode pool payload", || {
            let a = d20()
                .plus(6.0)?
                .ac(14.0)?
                .on_hit(rs(3.0, 6.0)?.reroll_up_to(2.0, None)?)?
                .plus_separate_damage(rs(2.0, 6.0)?.explode_pool(2.0)?);
            Ok(turn(vec![decl("a", a)], 0.0)?)
        }),
        ("vulnerability until next hit", || {
            let a = sword()?.on_every_hit_with(
                crate::builder::attack::Grants::One(vulnerability().until_next_hit()),
                None,
            )?;
            Ok(turn(vec![decl("a", a), decl("b", sword()?)], 0.0)?)
        }),
        ("paralyzed condition (auto-crit on later melee)", || {
            let a = sword()?.on_every_hit_with(
                crate::builder::attack::Grants::One(paralyzed().until_end_of_turn()),
                None,
            )?;
            Ok(turn(vec![decl("a", a), decl("b", sword()?.melee()?)], 0.0)?)
        }),
        ("joins: sneak dice pooled into the first row", || {
            joins_turn(None, None)
        }),
        ("joins + happens coin", || joins_turn(Some(0.7), None)),
        ("joins + row chance", || joins_turn(None, Some(0.6))),
        ("folded chip rider + happens coin", || {
            let hex = rider_of(
                first_hit(),
                Some("hex"),
                plain(roll_of(2.0, d6())?.to_pmf(0.0)?),
                Some(0.75),
                Some(RiderLanding::Any),
                None,
            );
            Ok(turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?.rider(hex)?)
        }),
        ("save penalty die on a contextual save row", || {
            let pen = save_penalty(&d4())?.until_next_save();
            Ok(turn(
                vec![
                    decl("a", sword()?),
                    decl("breath", contextual(PenalisedSave)),
                ],
                0.0,
            )?
            .on_first_hit_with(pen, opts_of(&["a"]))?)
        }),
        ("rider payload per attack with rollAt", || {
            let sneak = rider_of(
                first_hit(),
                Some("sneak"),
                sneak_per_attack()?,
                None,
                None,
                None,
            );
            Ok(turn(vec![decl("a", sword()?), decl("b", dagger()?)], 0.0)?.rider(sneak)?)
        }),
        (
            "attack gated on a first-hit rider (Wails from the Grave)",
            || {
                let spec = TurnSpec {
                    attacks: vec![
                        decl("a", sword()?),
                        decl("b", dagger()?),
                        decl_with(
                            "wails",
                            None,
                            after("sneak", AfterLanding::Damage),
                            Some("second"),
                            dmg(rs(1.0, 6.0)?),
                        ),
                    ],
                    riders: Some(vec![rider_of(
                        first_hit_of(&["a", "b"]),
                        Some("sneak"),
                        plain(rs(3.0, 6.0)?),
                        None,
                        None,
                        None,
                    )]),
                    ..TurnSpec::default()
                };
                Ok(Turn::from_spec(spec, 0.0)?)
            },
        ),
        (
            "attack gated on a rider folded into its rows (payload per attack)",
            || {
                let spec = TurnSpec {
                    attacks: vec![
                        decl("a", sword()?),
                        decl("b", dagger()?),
                        decl_with(
                            "wails",
                            None,
                            after("sneak", AfterLanding::Hit),
                            None,
                            dmg(rs(1.0, 6.0)?),
                        ),
                    ],
                    riders: Some(vec![rider_of(
                        first_hit_of(&["a", "b"]),
                        Some("sneak"),
                        sneak_per_attack()?,
                        None,
                        None,
                        None,
                    )]),
                    ..TurnSpec::default()
                };
                Ok(Turn::from_spec(spec, 0.0)?)
            },
        ),
        (
            "rerolledUnder: Savage Attacker over a row the sneak dice join",
            || {
                let spec = TurnSpec {
                    attacks: vec![
                        decl("a", contextual(PoolingRow { savage: true })),
                        decl("b", contextual(PoolingRow { savage: true })),
                    ],
                    riders: Some(vec![rider_of(
                        first_hit(),
                        Some("sa"),
                        plain(roll_of(3.0, d6())?),
                        None,
                        None,
                        Some(&["a", "b"]),
                    )]),
                    substitutes: Some(vec![SubstituteSpec {
                        id: Some("savage".into()),
                        on: SubstituteOn::FirstHit,
                        of: None,
                        substitute: SubstituteKind::RerollKeepHigher,
                        mode: None,
                        policy: None,
                    }]),
                    ..TurnSpec::default()
                };
                Ok(Turn::from_spec(spec, 0.0)?)
            },
        ),
    ]
}

fn joins_turn(happens: Option<f64>, chance: Option<f64>) -> Res<Turn> {
    let spec = TurnSpec {
        attacks: vec![
            decl_with(
                "a",
                chance,
                None,
                None,
                contextual(PoolingRow { savage: false }),
            ),
            decl("b", sword()?),
        ],
        riders: Some(vec![rider_of(
            first_hit(),
            Some("sa"),
            plain(roll_of(3.0, d6())?),
            happens,
            None,
            Some(&["a"]),
        )]),
        ..TurnSpec::default()
    };
    Ok(Turn::from_spec(spec, 0.0)?)
}

// ---- trace dumps (the JSON the TS snapshot holds) ------------------------------------------------

pub fn die_json(d: &SampledDie) -> Value {
    let mut v = json!({ "face": d.face, "kept": d.kept, "sides": d.sides });
    if d.reroll {
        v["reroll"] = json!(true);
    }
    if d.miss_reroll {
        v["missReroll"] = json!(true);
    }
    v
}

pub fn dice_json(dice: &[SampledDie]) -> Value {
    Value::Array(dice.iter().map(die_json).collect())
}

pub fn roll_sample_json(s: &RollSample) -> Value {
    json!({ "dice": dice_json(&s.dice), "total": s.total })
}

pub fn attack_sample_json(s: &AttackSample) -> Value {
    let mut v = json!({
        "check": dice_json(&s.check),
        "damage": dice_json(&s.damage),
        "outcome": s.outcome.as_str(),
        "total": s.total,
    });
    if let Some(p) = &s.payload {
        v["payload"] = json!({
            "base": roll_sample_json(&p.base),
            "scale": f64::from(p.scale),
            "separate": p.separate.iter().map(roll_sample_json).collect::<Vec<_>>(),
        });
    }
    v
}

fn result_str(r: crate::turn::trace::OutcomeResult) -> &'static str {
    use crate::turn::trace::OutcomeResult::*;
    match r {
        Hit => "hit",
        Crit => "crit",
        Miss => "miss",
        SaveFail => "save-fail",
        SavePass => "save-pass",
        Fired => "fired",
        Skipped => "skipped",
    }
}

pub fn trace_json(t: &crate::turn::trace::Trace) -> Value {
    use crate::turn::trace::{DieBy, DieRole};
    let waves: Vec<Value> = t
        .waves
        .iter()
        .map(|w| {
            let dice: Vec<Value> = w
                .dice
                .iter()
                .map(|d| {
                    json!({
                        "by": match d.by { DieBy::You => "you", DieBy::Enemy => "enemy" },
                        "face": d.face,
                        "kept": d.kept,
                        "role": match d.role {
                            DieRole::Attack => "attack",
                            DieRole::Save => "save",
                            DieRole::Damage => "damage",
                            DieRole::Rider => "rider",
                            DieRole::Reroll => "reroll",
                        },
                        "sides": d.sides,
                        "source": d.source,
                    })
                })
                .collect();
            let outcomes: Vec<Value> = w
                .outcomes
                .iter()
                .map(|o| json!({ "damage": o.damage, "result": result_str(o.result), "source": o.source }))
                .collect();
            json!({ "dice": dice, "outcomes": outcomes })
        })
        .collect();
    json!({ "samplerVersion": t.sampler_version, "total": t.total, "waves": waves })
}

/// The five builder fixtures: name, then a sampler producing the snapshot JSON for one rng.
pub type BuilderSample = Box<dyn Fn(&mut dyn Rng) -> Res<Value>>;

pub fn builder_fixtures() -> Res<Vec<(&'static str, BuilderSample)>> {
    let roll_fix = rs(3.0, 8.0)?.reroll(1.0)?.minimum(2.0)?.plus(2.0)?;
    let savage = rs(2.0, 6.0)?.reroll_up_to(
        1.0,
        Some(&RollRerollUpToOptions {
            rolls: Some(2.0),
            rolled_once: None,
        }),
    )?;
    let attack = d20()
        .plus(5.0)?
        .with_advantage()?
        .ac(15.0)?
        .crit_on(19.0)?
        .on_hit(roll_dice(1.0, 8.0, Some(3.0))?)?
        .plus_separate_damage(rs(1.0, 6.0)?);
    let save = d20()
        .plus(3.0)?
        .dc(15.0)?
        .ability("dex")?
        .on_save_failure_args(&[Arg::Roll(rs(3.0, 6.0)?)])?
        .save_half()?;
    let check = d20().plus(3.0)?.dc(15.0)?.ability("dex")?;
    Ok(vec![
        (
            "roll 3d8 reroll 1 minimum 2 plus 2",
            Box::new(move |rng| Ok(roll_sample_json(&roll_fix.sample(rng)?))),
        ),
        (
            "rerollUpTo savage",
            Box::new(move |rng| Ok(roll_sample_json(&savage.sample(rng)?))),
        ),
        (
            "attack with advantage, crit on 19, a separate channel",
            Box::new(move |rng| Ok(attack_sample_json(&attack.sample(rng, None)?))),
        ),
        (
            "save with half on success",
            Box::new(move |rng| {
                let s = save.sample(rng, None)?;
                Ok(json!({
                    "check": dice_json(&s.check),
                    "damage": dice_json(&s.damage),
                    "outcome": match s.outcome {
                        crate::builder::save::SaveSampleOutcome::Fail => "save-fail",
                        crate::builder::save::SaveSampleOutcome::Pass => "save-pass",
                    },
                    "total": s.total,
                }))
            }),
        ),
        (
            "dc check (sampleCheck)",
            Box::new(move |rng| {
                let s = check.sample_dc_check(rng, None)?;
                Ok(json!({ "check": dice_json(&s.check), "failed": s.failed, "total": s.total }))
            }),
        ),
    ])
}
