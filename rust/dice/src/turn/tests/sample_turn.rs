//! `tests/sample-turn.test.ts`: 18 tests (6 `Turn.sample`, 2 `Turn.sample law`, 10 path details; the
//! law's `it.each` of 40 cases is one loop in `the_sample_mean_is_the_turn_s_mean_with_no_fallback`),
//! 0 compat calls (the TS file has no recorded fixture entries).
//!
//! `N = 20_000` plays per law case, as in the TS; the bound is the TS's 4.5 standard errors, the
//! distribution drift bound is the TS's 0.08. Seeds are deterministic.
//!
//! Not translated: tests/sample-turn.test.ts:5 `sampleFallbacks` is the process-wide atomic
//! `SAMPLE_FALLBACKS`; it is read before/after (delta), never reset, as other tests share the process.

use super::helpers::*;
use super::sample_support::*;
use crate::builder::attack::{ConditionGate, Grants};
use crate::builder::factory::{d_expression, d4, d6, d20, roll_dice};
use crate::builder::nodes::Rounding;
use crate::common::Rng;
use crate::error::DiceError;
use crate::turn::effects::{
    EveryHitOptions, advantage, crit_on_hit, keep_best_damage, save_penalty, vulnerability,
};
use crate::turn::sample::SAMPLE_FALLBACKS;
use crate::turn::trace::{DieBy, DieRole, Outcome, OutcomeResult, Trace};
use crate::turn::types::{
    AfterLanding, ContextualPayload, ContextualSource, LandingPayload, LandingRoll,
    RiderDamageSpec, RiderLanding, RiderOptions, RollUnder, RowCheck, RowContext, SaveLanding,
    Trigger, VulnerableLanding, VulnerableRoll,
};
use crate::turn::{Turn, turn};
use crate::{Pmf, builder::attack::AttackBuilder};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::Ordering;

/// `script(faces, coins)`: the next die is the next face, the next chance the next coin.
struct Script {
    faces: VecDeque<f64>,
    coins: VecDeque<bool>,
}

fn script(faces: &[f64], coins: &[bool]) -> Script {
    Script {
        faces: faces.iter().copied().collect(),
        coins: coins.iter().copied().collect(),
    }
}

impl Rng for Script {
    fn die(&mut self, _sides: f64) -> f64 {
        self.faces
            .pop_front()
            .unwrap_or_else(|| panic!("out of dice"))
    }
    fn chance(&mut self, _p: f64) -> bool {
        self.coins
            .pop_front()
            .unwrap_or_else(|| panic!("out of coins"))
    }
}

/// A seeded rng whose consecutive draws are independent enough for a two-die keep.
struct Mulberry32(u32);

impl Mulberry32 {
    fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

impl Rng for Mulberry32 {
    fn die(&mut self, n: f64) -> f64 {
        (self.unit() * n).floor() + 1.0
    }
    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

fn oc(source: &str, result: OutcomeResult, damage: f64) -> Outcome {
    Outcome {
        source: source.to_string(),
        result,
        damage,
    }
}

fn results(trace: &Trace) -> Vec<Vec<OutcomeResult>> {
    trace
        .waves
        .iter()
        .map(|w| w.outcomes.iter().map(|o| o.result).collect())
        .collect()
}

fn last_outcome(trace: &Trace) -> Result<&Outcome, &'static str> {
    trace
        .waves
        .last()
        .and_then(|w| w.outcomes.first())
        .ok_or("no outcome")
}

fn faces_kept(trace: &Trace, wave: usize, sides: Option<f64>) -> Vec<(f64, bool)> {
    trace.waves[wave]
        .dice
        .iter()
        .filter(|d| sides.is_none_or(|s| d.sides == s))
        .map(|d| (d.face, d.kept))
        .collect()
}

fn axe() -> Res<AttackBuilder> {
    Ok(d20()
        .plus(6.0)?
        .ac(16.0)?
        .on_hit(roll_dice(2.0, 6.0, Some(4.0))?)?)
}

fn grant(g: crate::turn::effects::Grant) -> Grants {
    Grants::One(g.into())
}

fn vulnerable_sword() -> Res<AttackBuilder> {
    Ok(sword()?.on_every_hit_with(Grants::One(vulnerability().until_next_hit()), None)?)
}

// ---- describe("Turn.sample") ---------------------------------------------------------------------

#[test]
fn one_attack_a_hit_wave_with_its_dice_and_outcome() -> T {
    let t = turn(vec![decl("sword", sword()?)], 0.0)?;
    let trace = t.sample(&mut script(&[12.0, 6.0], &[]))?;
    assert_eq!(trace.total, 9.0);
    assert_eq!(trace.waves.len(), 1);
    assert_eq!(
        trace.waves[0].outcomes,
        vec![oc("sword", OutcomeResult::Hit, 9.0)]
    );
    let dice: Vec<(f64, f64, DieRole)> = trace.waves[0]
        .dice
        .iter()
        .map(|x| (x.sides, x.face, x.role))
        .collect();
    assert_eq!(
        dice,
        vec![(20.0, 12.0, DieRole::Attack), (8.0, 6.0, DieRole::Damage)]
    );
    Ok(())
}

#[test]
fn first_hit_rider_fires_once_on_the_first_landing_doubled_on_a_crit() -> T {
    use OutcomeResult::*;
    let t = turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?
        .on_first_hit_with(rs(2.0, 6.0)?, sub_id("sneak"))?;
    // a: d20=3 misses (no damage). b: d20=20 crits -> 1d8 doubled = 2 dice (4,4). sneak 2d6 doubled on the crit = 4 dice (1,2,3,4).
    let trace = t.sample(&mut script(&[3.0, 20.0, 4.0, 4.0, 1.0, 2.0, 3.0, 4.0], &[]))?;
    assert_eq!(results(&trace), vec![vec![Miss], vec![Crit], vec![Fired]]);
    Ok(())
}

#[test]
fn any_miss_reroll_fires_only_after_a_miss_and_reads_the_miss_bit() -> T {
    let t = turn(vec![decl("a", sword()?)], 0.0)?.on_any_miss_with(sword()?, rid("reroll"))?;
    let hit = t.sample(&mut script(&[15.0, 2.0], &[]))?;
    let o = last_outcome(&hit)?;
    assert_eq!(
        (o.source.as_str(), o.result),
        ("reroll", OutcomeResult::Skipped)
    );
    let miss = t.sample(&mut script(&[2.0, 16.0, 5.0], &[]))?;
    let o = last_outcome(&miss)?;
    assert_eq!(
        (o.source.as_str(), o.result, o.damage),
        ("reroll", OutcomeResult::Hit, 8.0)
    );
    Ok(())
}

#[test]
fn a_chance_attack_that_does_not_happen_is_skipped_and_spends_nothing() -> T {
    let t = turn(vec![chance_attack(sword()?, 0.5)], 0.0)?;
    let trace = t.sample(&mut script(&[], &[false]))?;
    let o = &trace.waves[0].outcomes[0];
    assert_eq!((o.result, o.damage), (OutcomeResult::Skipped, 0.0));
    assert_eq!(trace.total, 0.0);
    Ok(())
}

/// A source with no id and a `chance`.
fn chance_attack(source: AttackBuilder, chance: f64) -> crate::turn::types::Attack {
    crate::turn::types::Attack::Declared {
        options: crate::turn::types::AttackOptions {
            chance: Some(chance),
            ..Default::default()
        },
        source: source.into(),
    }
}

/// An rng that has no dice and always flips tails: "the inverse CDF picks the last bin".
struct AlwaysLast;

impl Rng for AlwaysLast {
    fn die(&mut self, _sides: f64) -> f64 {
        panic!("no dice expected")
    }
    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

#[test]
fn a_parsed_string_source_is_a_chip_no_dice() -> T {
    // `d("…")` with an attack clause is a ParsedRollBuilder: its sample() is samplePMF over the labelled PMF, no dice.
    let t = turn(
        vec![decl(
            "parsed",
            dmg(d_expression("(d20 + 5 AC 15) * (2d6)")?),
        )],
        0.0,
    )?;
    let trace = t.sample(&mut AlwaysLast)?;
    assert!(trace.waves[0].dice.is_empty());
    assert_eq!(trace.waves[0].outcomes[0].source, "parsed");
    Ok(())
}

#[test]
fn returns_the_sampler_version() -> T {
    let t = turn(vec![atk_of(sword()?)], 0.0)?;
    assert_eq!(t.sample(&mut script(&[1.0], &[]))?.sampler_version, 1.0);
    Ok(())
}

// ---- describe("Turn.sample law") -----------------------------------------------------------------

/// The sample mean of `n` plays; every outcome's damage sums to the trace's total.
fn sample_mean(t: &Turn, n: u32, seed: u32) -> Res<f64> {
    let mut rng = Mulberry32(seed);
    let mut sum = 0.0;
    for _ in 0..n {
        let trace = t.sample(&mut rng)?;
        let outcomes: f64 = trace
            .waves
            .iter()
            .map(|w| w.outcomes.iter().map(|o| o.damage).sum::<f64>())
            .sum();
        assert_eq!(
            outcomes, trace.total,
            "total is not the sum of its outcomes"
        );
        sum += trace.total;
    }
    Ok(sum / f64::from(n))
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn scale2(
    r: crate::builder::roll::RollBuilder,
) -> Result<crate::builder::roll::RollBuilder, DiceError> {
    r.scale_result(2.0, 1.0, Rounding::Floor)
}

/// A rider payload read per attack (`perAttack`, no rolls: a chip) or with its rolls behind it
/// (`perAttackRolled`: `rollAt` with its vulnerable pair given).
struct PerAttack {
    rolled: bool,
}

impl ContextualPayload for PerAttack {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        let on_hit = rs(2.0, 6.0)?.to_pmf(0.0)?;
        let on_crit = rs(4.0, 6.0)?.to_pmf(0.0)?;
        let vulnerable = VulnerableLanding {
            on_hit: (on_hit.map_damage(|x| 2.0 * x)).into(),
            on_crit: (on_crit.map_damage(|x| 2.0 * x)).into(),
        };
        Ok(LandingPayload {
            on_hit: on_hit.into(),
            on_crit: on_crit.into(),
            vulnerable,
        })
    }
    fn roll_at(&self, _attack_id: &str) -> Result<Option<LandingRoll>, DiceError> {
        if !self.rolled {
            return Ok(None);
        }
        Ok(Some(LandingRoll {
            on_hit: rs(2.0, 6.0)?,
            on_crit: rs(4.0, 6.0)?,
            vulnerable: Some(VulnerableRoll {
                on_hit: scale2(rs(2.0, 6.0)?)?,
                on_crit: scale2(rs(4.0, 6.0)?)?,
            }),
        }))
    }
}

/// A resisted payload (halved) that a vulnerability lands with the scales off and doubled:
/// `at().vulnerable` is 4x the plain roll's law, not 2x. `rolled_vulnerable`: `rollAt` gives the
/// vulnerable pair (dice on both branches); else plain rolls only (a vulnerable landing is a chip).
struct Resisted {
    rolled_vulnerable: bool,
}

impl ContextualPayload for Resisted {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        Ok(LandingPayload {
            on_hit: (rs(2.0, 6.0)?.half()?.to_pmf(0.0)?).into(),
            on_crit: (rs(4.0, 6.0)?.half()?.to_pmf(0.0)?).into(),
            vulnerable: VulnerableLanding {
                on_hit: (scale2(rs(2.0, 6.0)?)?.to_pmf(0.0)?).into(),
                on_crit: (scale2(rs(4.0, 6.0)?)?.to_pmf(0.0)?).into(),
            },
        })
    }
    fn roll_at(&self, _attack_id: &str) -> Result<Option<LandingRoll>, DiceError> {
        let vulnerable = if self.rolled_vulnerable {
            Some(VulnerableRoll {
                on_hit: scale2(rs(2.0, 6.0)?)?,
                on_crit: scale2(rs(4.0, 6.0)?)?,
            })
        } else {
            None
        };
        Ok(Some(LandingRoll {
            on_hit: rs(2.0, 6.0)?.half()?,
            on_crit: rs(4.0, 6.0)?.half()?,
            vulnerable,
        }))
    }
}

/// A row resisted (halved) that a vulnerability lands with the scales off and doubled; `rollUnder`
/// is exact for both.
struct ScaledRow {
    resisted: AttackBuilder,
    exposed: AttackBuilder,
}

fn scaled_row() -> Res<ScaledRow> {
    let base = d20().plus(6.0)?.ac(16.0)?;
    Ok(ScaledRow {
        resisted: base.on_hit(rs(2.0, 8.0)?.half()?)?,
        exposed: base.on_hit(scale2(rs(2.0, 8.0)?)?)?,
    })
}

impl ScaledRow {
    fn pick(&self, context: &RowContext) -> (&AttackBuilder, RowContext) {
        let b = if context.vulnerable {
            &self.exposed
        } else {
            &self.resisted
        };
        (
            b,
            RowContext {
                vulnerable: false,
                ..context.clone()
            },
        )
    }
}

impl ContextualSource for ScaledRow {
    fn row_check(&self) -> RowCheck {
        self.resisted.row_check()
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        let (b, c) = self.pick(context);
        b.under(&c, eps)
    }
    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        let (b, c) = self.pick(context);
        Ok(Some(RollUnder::Attack(Box::new(b.roll_under(&c)?))))
    }
}

fn contextual_payload(p: impl ContextualPayload + 'static) -> RiderDamageSpec {
    RiderDamageSpec::Contextual(Arc::new(p))
}

fn coin_rider(
    trigger: Trigger,
    damage: RiderDamageSpec,
    happens: Option<f64>,
    landing: Option<RiderLanding>,
) -> crate::turn::types::Rider {
    rider_of(trigger, None, damage, happens, landing, None)
}

fn law_cases() -> Res<Vec<(&'static str, Turn)>> {
    let (sw, ax) = (sword()?, axe()?);
    let swords =
        |n: usize| -> Res<Turn> { Ok(turn((0..n).map(|_| atk_of(sw.clone())).collect(), 0.0)?) };
    let axes = |first: AttackBuilder, n: usize| -> Res<Turn> {
        let mut attacks = vec![atk_of(first)];
        attacks.extend((1..n).map(|_| atk_of(ax.clone())));
        Ok(turn(attacks, 0.0)?)
    };
    let vs = vulnerable_sword()?;
    let ray = || -> Source { contextual(scaled_row().unwrap_or_else(|e| panic!("{e}"))) };
    let breath = d20()
        .plus(5.0)?
        .dc(15.0)?
        .ability("dex")?
        .on_save_failure_args(&[crate::builder::roll::Arg::Roll(roll_of(4.0, d6())?)])?
        .save_half()?;
    let mut damage_landing = first_hit_opts();
    damage_landing.condition.rider.landing = Some(SaveLanding::Damage);
    let advantage_first_hit = |chance: f64| hit_opts(None, None, Some(chance));
    let landing_any = Some(RiderLanding::Any);
    let hit = || every_hit_trigger(None);
    let keep = keep_best_damage;
    let cap2 = || every_hit_trigger(Some(2.0));
    Ok(vec![
        (
            "first-hit rider step",
            swords(2)?.on_first_hit_with(rs(3.0, 6.0)?, first_hit_opts())?,
        ),
        (
            "every-hit rider folded",
            turn(vec![decl("a", sw.clone()), decl("b", sw.clone())], 0.0)?
                .on_every_hit_with(rs(1.0, 6.0)?, EveryHitOptions::default())?,
        ),
        (
            "every-hit rider with a coin",
            swords(2)?.rider(coin_rider(hit(), plain(rs(1.0, 6.0)?), Some(0.5), None))?,
        ),
        (
            "first-hit rider that may not happen",
            swords(2)?.rider(coin_rider(
                first_hit(),
                plain(rs(2.0, 6.0)?),
                Some(0.3),
                None,
            ))?,
        ),
        (
            "capped every-hit rider",
            swords(3)?.rider(coin_rider(cap2(), plain(d6()), None, None))?,
        ),
        (
            "any-miss reroll",
            swords(2)?.on_any_miss_with(sw.clone(), RiderOptions::default())?,
        ),
        (
            "first-miss reroll then first-hit",
            swords(2)?
                .on_first_miss_with(sw.clone(), RiderOptions::default())?
                .on_first_hit_with(rs(2.0, 6.0)?, first_hit_opts())?,
        ),
        (
            "chance attacks",
            turn(
                vec![
                    chance_attack(sw.clone(), 0.5),
                    chance_attack(ax.clone(), 0.25),
                ],
                0.0,
            )?,
        ),
        (
            "advantage granted until next attack",
            turn(
                vec![
                    atk_of(sw.on_every_hit_with(grant(advantage().until_next_attack()), None)?),
                    atk_of(sw.clone()),
                    atk_of(sw.clone()),
                ],
                0.0,
            )?,
        ),
        (
            "crit-on-hit granted for the turn",
            turn(
                vec![
                    atk_of(sw.on_every_hit_with(grant(crit_on_hit().until_end_of_turn()), None)?),
                    atk_of(ax.clone()),
                ],
                0.0,
            )?,
        ),
        (
            "a grant gated by a chance",
            swords(2)?
                .on_first_hit_with(advantage().until_next_attack(), advantage_first_hit(0.4))?,
        ),
        (
            "vulnerability until next hit",
            turn(
                vec![atk_of(vs.clone()), atk_of(ax.clone()), atk_of(ax.clone())],
                0.0,
            )?,
        ),
        (
            "substitute: keep best damage",
            axes(ax.clone(), 2)?.on_first_hit_transform(keep(), first_hit_opts())?,
        ),
        (
            "substitute: keep best below a threshold",
            axes(ax.clone(), 3)?
                .on_first_hit_transform(keep().if_below_split(10.0, 16.0)?, first_hit_opts())?,
        ),
        (
            "substitute with separate channels",
            axes(ax.plus_separate_damage(rs(1.0, 8.0)?), 2)?
                .on_first_hit_transform(keep(), first_hit_opts())?,
        ),
        (
            "dice-match rider",
            turn(vec![decl("orb", ax.clone())], 0.0)?.on_dice_match_with(
                &["orb"],
                rs(3.0, 8.0)?,
                RiderOptions::default(),
            )?,
        ),
        (
            "dice-match attack-shaped rider",
            turn(vec![decl("orb", ax.clone())], 0.0)?.on_dice_match_with(
                &["orb"],
                ax.clone(),
                RiderOptions::default(),
            )?,
        ),
        (
            "save row with a rider",
            turn(vec![decl("breath", breath), atk_of(sw.clone())], 0.0)?
                .on_first_hit_with(rs(2.0, 6.0)?, damage_landing)?,
        ),
        (
            "gated attack",
            turn(
                vec![
                    decl("a", sw.clone()),
                    chance_gated(ax.clone(), after("a", AfterLanding::Hit)),
                ],
                0.0,
            )?,
        ),
        (
            "parsed string rows",
            turn(
                vec![
                    atk_of(DamageSourceOf::parsed("(d20 + 5 AC 15) * (2d6)")?),
                    atk_of(DamageSourceOf::parsed("(d20 + 5 AC 15) * (1d8 + 3)")?),
                ],
                0.0,
            )?
            .on_first_hit_with(rs(2.0, 6.0)?, first_hit_opts())?,
        ),
        (
            "reroll budget on the base pool",
            axes(ax.reroll_damage_up_to(1.0, None)?, 2)?
                .on_first_hit_transform(keep(), first_hit_opts())?,
        ),
        (
            "advantage of its own under a granted advantage",
            turn(
                vec![
                    atk_of(
                        d20()
                            .plus(6.0)?
                            .with_advantage()?
                            .ac(16.0)?
                            .on_hit(roll_dice(2.0, 6.0, Some(4.0))?)?
                            .on_every_hit_with(grant(advantage().until_next_attack()), None)?,
                    ),
                    atk_of(ax.clone()),
                ],
                0.0,
            )?,
        ),
        (
            "chip riders: a PMF payload, folded and as a step that may not happen",
            swords(2)?
                .on_every_hit_with(rs(1.0, 6.0)?.to_pmf(0.0)?, EveryHitOptions::default())?
                .rider(coin_rider(
                    first_hit(),
                    plain(rs(2.0, 6.0)?.to_pmf(0.0)?),
                    Some(0.3),
                    None,
                ))?,
        ),
        (
            "substitute under a capped rider's variant blocks",
            swords(3)?
                .rider(coin_rider(cap2(), plain(d6()), None, None))?
                .on_first_hit_transform(keep(), first_hit_opts())?,
        ),
        (
            "substitute under a rider coin's variant blocks",
            swords(2)?
                .rider(coin_rider(hit(), plain(d6()), Some(0.5), None))?
                .on_first_hit_transform(keep(), first_hit_opts())?,
        ),
        (
            "substitute under a granted context",
            axes(
                sw.on_every_hit_with(grant(advantage().until_next_attack()), None)?,
                1,
            )?
            .attack(ax.clone())?
            .attack(ax.clone())?
            .on_first_hit_transform(keep(), first_hit_opts())?,
        ),
        (
            "folded first-hit rider that may not happen (lands on anything)",
            swords(2)?.rider(coin_rider(
                first_hit(),
                plain(rs(2.0, 6.0)?),
                Some(0.3),
                landing_any,
            ))?,
        ),
        (
            "folded chip rider (bare PMF) that may not happen",
            swords(2)?.rider(coin_rider(
                first_hit(),
                plain(rs(2.0, 6.0)?.to_pmf(0.0)?),
                Some(0.75),
                landing_any,
            ))?,
        ),
        (
            "folded chip rider (payload per attack) that may not happen",
            swords(2)?.rider(coin_rider(
                first_hit(),
                contextual_payload(PerAttack { rolled: false }),
                Some(0.75),
                None,
            ))?,
        ),
        (
            "save penalty die on a contextual save row (rollUnder already in context)",
            turn(
                vec![
                    decl("a", sw.clone()),
                    decl("breath", contextual(PenalisedSave)),
                ],
                0.0,
            )?
            .on_first_hit_with(save_penalty(&d4())?.until_next_save(), opts_of(&["a"]))?,
        ),
        (
            "rider payload per attack with rollAt: dice, not a chip",
            swords(2)?.rider(coin_rider(
                first_hit(),
                contextual_payload(PerAttack { rolled: true }),
                None,
                None,
            ))?,
        ),
        (
            "rider payload per attack with rollAt, happens 0.75",
            swords(2)?.rider(coin_rider(
                first_hit(),
                contextual_payload(PerAttack { rolled: true }),
                Some(0.75),
                None,
            ))?,
        ),
        (
            "rider payload per attack with rollAt, every hit under a vulnerability",
            turn(
                vec![atk_of(vs.clone()), atk_of(ax.clone()), atk_of(ax.clone())],
                0.0,
            )?
            .rider(coin_rider(
                hit(),
                contextual_payload(PerAttack { rolled: true }),
                None,
                None,
            ))?,
        ),
        (
            "rollUnder is exact under a vulnerability: a resisted row lands with the scales off (4x, not 2x)",
            turn(
                vec![atk_of(vs.clone()), decl("ray", ray()), decl("ray2", ray())],
                0.0,
            )?,
        ),
        (
            "rollAt with its vulnerable pair: a resisted rider lands doubled with the scales off",
            turn(
                vec![atk_of(vs.clone()), atk_of(ax.clone()), atk_of(ax.clone())],
                0.0,
            )?
            .rider(coin_rider(
                hit(),
                contextual_payload(Resisted {
                    rolled_vulnerable: true,
                }),
                None,
                None,
            ))?,
        ),
        (
            "rollAt without a vulnerable pair: the vulnerable landing is a chip, exact",
            turn(
                vec![atk_of(vs.clone()), atk_of(ax.clone()), atk_of(ax.clone())],
                0.0,
            )?
            .rider(coin_rider(
                hit(),
                contextual_payload(Resisted {
                    rolled_vulnerable: false,
                }),
                None,
                None,
            ))?,
        ),
        (
            "folded any-crit rider that lands on anything (crit-only fold)",
            turn(vec![decl("a", sw.clone()), decl("b", sw.clone())], 0.0)?.rider(coin_rider(
                Trigger::AnyCrit {
                    of: None,
                    max: Some(1.0),
                },
                plain(rs(2.0, 6.0)?),
                None,
                landing_any,
            ))?,
        ),
        (
            "folded any-crit rider under a vulnerability",
            turn(
                vec![atk_of(vs.clone()), atk_of(ax.clone()), atk_of(ax.clone())],
                0.0,
            )?
            .rider(coin_rider(
                Trigger::AnyCrit {
                    of: None,
                    max: Some(2.0),
                },
                plain(rs(2.0, 6.0)?),
                None,
                None,
            ))?,
        ),
        (
            "substitute spent on a rollUnder row under a vulnerability (scaled once)",
            turn(
                vec![atk_of(vs.clone()), decl("ray", ray()), decl("ray2", ray())],
                0.0,
            )?
            .on_first_hit_transform(keep(), opts_of(&["ray", "ray2"]))?,
        ),
        (
            "substitute spent on a bare attack under a vulnerability (scaled once)",
            turn(
                vec![atk_of(vs), atk_of(ax.clone()), atk_of(ax.clone())],
                0.0,
            )?
            .on_first_hit_transform(keep(), opts_of(&["attack 2", "attack 3"]))?,
        ),
    ])
}

fn first_hit_opts() -> crate::turn::effects::FirstHitOptions {
    crate::turn::effects::FirstHitOptions::default()
}

/// `{ source, after }` with no id.
fn chance_gated(
    source: AttackBuilder,
    after: Option<crate::turn::types::After>,
) -> crate::turn::types::Attack {
    crate::turn::types::Attack::Declared {
        options: crate::turn::types::AttackOptions {
            after,
            ..Default::default()
        },
        source: source.into(),
    }
}

/// `d("…")` of an attack expression, as a source.
struct DamageSourceOf;

impl DamageSourceOf {
    fn parsed(expression: &str) -> Res<crate::turn::types::Source> {
        Ok(dmg(d_expression(expression)?))
    }
}

use crate::turn::types::Source;

#[test]
fn the_sample_mean_is_the_turn_s_mean_with_no_fallback() -> T {
    const N: u32 = 20_000;
    let cases = law_cases()?;
    assert_eq!(cases.len(), 40);
    for (name, t) in &cases {
        let before = SAMPLE_FALLBACKS.load(Ordering::SeqCst);
        let mean = t.mean()?;
        let sampled = sample_mean(t, N, 7)?;
        // Within 4.5 standard errors of the exact mean.
        let z = (sampled - mean) / (t.pmf()?.variance() / f64::from(N)).sqrt();
        assert!(
            z.abs() < 4.5,
            "{name}: sampled {sampled} vs mean {mean} (z = {z})"
        );
        assert_eq!(
            SAMPLE_FALLBACKS.load(Ordering::SeqCst) - before,
            0,
            "{name}: fallback"
        );
    }
    Ok(())
}

#[test]
fn tracks_the_whole_distribution_of_a_turn_with_riders_and_grants() -> T {
    const N: u32 = 20_000;
    let t = turn(
        vec![
            atk_of(sword()?.on_every_hit_with(grant(advantage().until_next_attack()), None)?),
            atk_of(sword()?),
            atk_of(sword()?),
        ],
        0.0,
    )?
    .on_first_hit_with(rs(2.0, 6.0)?, first_hit_opts())?
    .on_first_miss_with(sword()?, RiderOptions::default())?;
    let mut rng = Mulberry32(11);
    let mut counts: BTreeMap<i64, u32> = BTreeMap::new();
    for _ in 0..N {
        *counts.entry(t.sample(&mut rng)?.total as i64).or_insert(0) += 1;
    }
    let pmf = t.pmf()?;
    let mut drift = 0.0;
    for value in pmf.support() {
        let seen = f64::from(counts.get(&(value.0 as i64)).copied().unwrap_or(0)) / f64::from(N);
        drift += (seen - pmf.p_at(value.0)).abs();
    }
    assert!(drift < 0.08, "drift {drift}");
    Ok(())
}

// ---- describe("Turn.sample path details") --------------------------------------------------------

#[test]
fn a_folded_every_hit_rider_rolls_beside_each_landing_in_the_rows_wave() -> T {
    use OutcomeResult::*;
    let t = turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?
        .on_every_hit_with(rs(1.0, 6.0)?, every_hit(Some("flame"), None))?;
    // a: 15 hits, d8=2, flame d6=4. b: 20 crits: 2d8 (1,1), flame doubled 2d6 (6,6).
    let trace = t.sample(&mut script(
        &[15.0, 2.0, 4.0, 20.0, 1.0, 1.0, 6.0, 6.0],
        &[],
    ))?;
    assert_eq!(
        trace.waves[0].outcomes,
        vec![oc("a", Hit, 5.0), oc("flame", Fired, 4.0)]
    );
    assert_eq!(
        trace.waves[1].outcomes,
        vec![oc("b", Crit, 5.0), oc("flame", Fired, 12.0)]
    );
    let roles: Vec<DieRole> = trace.waves[1].dice.iter().map(|x| x.role).collect();
    assert_eq!(
        roles,
        vec![
            DieRole::Attack,
            DieRole::Damage,
            DieRole::Damage,
            DieRole::Rider,
            DieRole::Rider
        ]
    );
    assert_eq!(trace.total, 26.0);
    Ok(())
}

#[test]
fn a_grant_save_is_a_chip_outcome_in_the_rows_wave_and_sets_the_flag_the_next_row_reads() -> T {
    let gate = ConditionGate {
        chance: Some(0.5),
        ..ConditionGate::default()
    };
    let first = sword()?.on_every_hit_with(grant(advantage().until_next_attack()), Some(gate))?;
    let t = turn(vec![atk_of(first), decl("next", sword()?)], 0.0)?;
    // Hit, the chance coin comes up: the next row rolls two d20s and keeps the higher.
    let taken = t.sample(&mut script(&[15.0, 2.0, 3.0, 18.0, 4.0], &[true]))?;
    let o = &taken.waves[0].outcomes[1];
    assert_eq!((o.result, o.damage), (OutcomeResult::SaveFail, 0.0));
    assert_eq!(
        faces_kept(&taken, 1, Some(20.0)),
        vec![(3.0, false), (18.0, true)]
    );
    let o = &taken.waves[1].outcomes[0];
    assert_eq!(
        (o.source.as_str(), o.result, o.damage),
        ("next", OutcomeResult::Hit, 7.0)
    );
    // The coin fails: one d20.
    let saved = t.sample(&mut script(&[15.0, 2.0, 18.0, 4.0], &[false]))?;
    assert_eq!(saved.waves[0].outcomes[1].result, OutcomeResult::SavePass);
    assert_eq!(faces_kept(&saved, 1, Some(20.0)).len(), 1);
    Ok(())
}

#[test]
fn keep_best_damage_re_rolls_the_base_payload_once_and_keeps_the_better_rolls_dice() -> T {
    let t = turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?
        .on_first_hit_transform(keep_best_damage(), first_hit_opts())?;
    // a hits with a 2, re-rolls a 7: the 2 is dropped. b hits with a 3 and is not re-rolled: the substitute is spent.
    let trace = t.sample(&mut script(&[15.0, 2.0, 7.0, 15.0, 3.0], &[]))?;
    assert_eq!(
        trace.waves[0].outcomes[0],
        oc("a", OutcomeResult::Hit, 10.0)
    );
    assert_eq!(
        faces_kept(&trace, 0, None),
        vec![(15.0, true), (2.0, false), (7.0, true)]
    );
    assert_eq!(trace.waves[1].outcomes[0], oc("b", OutcomeResult::Hit, 6.0));
    assert_eq!(trace.waves[1].dice.len(), 2);
    // A tie keeps the original roll; the fresh dice are shown dropped.
    let tie = t.sample(&mut script(&[15.0, 5.0, 5.0, 15.0, 3.0], &[]))?;
    assert_eq!(
        faces_kept(&tie, 0, None),
        vec![(15.0, true), (5.0, true), (5.0, false)]
    );
    Ok(())
}

#[test]
fn if_below_holds_a_roll_at_or_above_the_threshold_while_a_later_watched_attack_can_still_land() -> T
{
    let t = turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?
        .on_first_hit_transform(keep_best_damage().if_below(8.0)?, first_hit_opts())?;
    // a hits for 8 (5 + 3): held. b hits for 4 (1 + 3), the last watched attack: spent regardless, re-rolled 6.
    let trace = t.sample(&mut script(&[15.0, 5.0, 15.0, 1.0, 6.0], &[]))?;
    assert_eq!(trace.waves[0].outcomes[0].damage, 8.0);
    assert_eq!(trace.waves[1].outcomes[0].damage, 9.0);
    assert_eq!(
        faces_kept(&trace, 1, None),
        vec![(15.0, true), (1.0, false), (6.0, true)]
    );
    Ok(())
}

#[test]
fn a_dice_match_rider_fires_when_the_base_dice_show_a_pair_doubled_when_the_pair_was_a_crits() -> T
{
    use OutcomeResult::*;
    let orb = d20().plus(6.0)?.ac(16.0)?.on_hit(rs(2.0, 8.0)?)?;
    let t = turn(vec![decl("orb", orb)], 0.0)?.on_dice_match_with(
        &["orb"],
        rs(2.0, 6.0)?,
        rid("bounce"),
    )?;
    let second = |trace: &Trace| -> Vec<OutcomeResult> {
        trace.waves.iter().map(|w| w.outcomes[0].result).collect()
    };
    assert_eq!(
        second(&t.sample(&mut script(&[15.0, 4.0, 4.0, 2.0, 3.0], &[]))?),
        vec![Hit, Fired]
    );
    assert_eq!(
        second(&t.sample(&mut script(&[15.0, 4.0, 5.0], &[]))?),
        vec![Hit, Skipped]
    );
    // A crit rolls 4d8: a pair among them matches, and the rider's 2d6 double.
    let crit = t.sample(&mut script(
        &[20.0, 1.0, 2.0, 3.0, 3.0, 1.0, 1.0, 1.0, 1.0],
        &[],
    ))?;
    assert_eq!(crit.waves[1].outcomes[0], oc("bounce", Fired, 4.0));
    assert_eq!(crit.waves[1].dice.len(), 4);
    Ok(())
}

#[test]
fn a_save_row_reports_the_saves_own_outcome_the_enemys_d20_and_the_riders_landing_kind() -> T {
    use OutcomeResult::*;
    let breath = d20()
        .plus(5.0)?
        .dc(15.0)?
        .ability("dex")?
        .on_save_failure_args(&[crate::builder::roll::Arg::Roll(roll_of(2.0, d6())?)])?
        .save_half()?;
    let mut landing = first_hit_opts();
    landing.condition.rider.landing = Some(SaveLanding::Damage);
    let t = turn(vec![decl("breath", breath)], 0.0)?.on_first_hit_with(rs(1.0, 6.0)?, landing)?;
    // The target rolls a 3 (+5 = 8 < 15): failed. 2d6 = 2 + 3. The rider lands (damage dealt): d6 = 4.
    let failed = t.sample(&mut script(&[3.0, 2.0, 3.0, 4.0], &[]))?;
    assert_eq!(failed.waves[0].outcomes[0], oc("breath", SaveFail, 5.0));
    let d = &failed.waves[0].dice[0];
    assert_eq!(
        (d.sides, d.face, d.role, d.by),
        (20.0, 3.0, DieRole::Save, DieBy::Enemy)
    );
    let o = &failed.waves[1].outcomes[0];
    assert_eq!((o.result, o.damage), (Fired, 4.0));
    // A pass halves 2 + 3 to 2: still damage dealt, so the rider lands.
    let passed = t.sample(&mut script(&[18.0, 2.0, 3.0, 4.0], &[]))?;
    assert_eq!(passed.waves[0].outcomes[0], oc("breath", SavePass, 2.0));
    assert_eq!(passed.waves[1].outcomes[0].result, Fired);
    Ok(())
}

#[test]
fn a_rider_that_may_not_happen_takes_its_coin_and_is_skipped_when_it_fails() -> T {
    let maybe = rider_of(
        first_hit(),
        Some("maybe"),
        plain(rs(2.0, 6.0)?),
        Some(0.5),
        None,
        None,
    );
    let t = turn(vec![atk_of(sword()?)], 0.0)?.rider(maybe)?;
    let skipped = t.sample(&mut script(&[15.0, 2.0], &[false]))?;
    let o = &skipped.waves[1].outcomes[0];
    assert_eq!(
        (o.source.as_str(), o.result),
        ("maybe", OutcomeResult::Skipped)
    );
    let fired = t.sample(&mut script(&[15.0, 2.0, 1.0, 1.0], &[true]))?;
    let o = &fired.waves[1].outcomes[0];
    assert_eq!(
        (o.source.as_str(), o.result, o.damage),
        ("maybe", OutcomeResult::Fired, 2.0)
    );
    Ok(())
}

#[test]
fn a_folded_rider_whose_per_landing_coin_fails_is_skipped_in_the_rows_wave_its_dice_undrawn() -> T {
    use OutcomeResult::*;
    // A first-hit rider on any landing is folded into the row and takes its coin as the row lands.
    let coin = rider_of(
        first_hit(),
        Some("coin"),
        plain(rs(2.0, 6.0)?),
        Some(0.5),
        Some(RiderLanding::Any),
        None,
    );
    let t = turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?.rider(coin)?;
    // Row a hits (15, d8 = 2); the coin fails: no 2d6 drawn. Row b hits (16, d8 = 3).
    let failed = t.sample(&mut script(&[15.0, 2.0, 16.0, 3.0], &[false]))?;
    assert_eq!(
        failed.waves[0].outcomes,
        vec![oc("a", Hit, 5.0), oc("coin", Skipped, 0.0)]
    );
    assert_eq!(failed.waves[1].outcomes, vec![oc("b", Hit, 6.0)]);
    assert_eq!(failed.total, 11.0);
    let fired = t.sample(&mut script(&[15.0, 2.0, 1.0, 4.0, 16.0, 3.0], &[true]))?;
    assert_eq!(fired.waves[0].outcomes[1], oc("coin", Fired, 5.0));
    assert_eq!(fired.total, 16.0);
    Ok(())
}

/// `sneak` of the TS: `at` gives the chips, `rollAt` the plain 2d6 / 4d6 (no vulnerable pair).
struct Sneak;

impl ContextualPayload for Sneak {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        let on_hit = rs(2.0, 6.0)?.to_pmf(0.0)?;
        let on_crit = rs(4.0, 6.0)?.to_pmf(0.0)?;
        Ok(LandingPayload {
            vulnerable: VulnerableLanding {
                on_hit: (on_hit.map_damage(|x| 2.0 * x)).into(),
                on_crit: (on_crit.map_damage(|x| 2.0 * x)).into(),
            },
            on_hit: on_hit.into(),
            on_crit: on_crit.into(),
        })
    }
    fn roll_at(&self, _attack_id: &str) -> Result<Option<LandingRoll>, DiceError> {
        Ok(Some(LandingRoll {
            on_hit: rs(2.0, 6.0)?,
            on_crit: rs(4.0, 6.0)?,
            vulnerable: None,
        }))
    }
}

#[test]
fn a_payload_per_attack_with_roll_at_rolls_its_dice_as_rider_dice_the_crit_roll_as_given_its_coin_first()
-> T {
    use OutcomeResult::*;
    let sneak = rider_of(
        first_hit(),
        Some("sneak"),
        contextual_payload(Sneak),
        Some(0.75),
        None,
        None,
    );
    let t = turn(vec![decl("a", sword()?), decl("b", sword()?)], 0.0)?.rider(sneak)?;
    // a crits: 2d8 (4, 4); the coin comes up; the crit roll is 4d6 (1, 2, 3, 4), not 2d6 doubled again. b hits: sneak spent.
    let crit = t.sample(&mut script(
        &[20.0, 4.0, 4.0, 1.0, 2.0, 3.0, 4.0, 15.0, 6.0],
        &[true],
    ))?;
    assert_eq!(
        crit.waves[0].outcomes,
        vec![oc("a", Crit, 11.0), oc("sneak", Fired, 10.0)]
    );
    let rider_dice: Vec<(f64, f64, &str)> = crit.waves[0]
        .dice
        .iter()
        .filter(|x| x.role == DieRole::Rider)
        .map(|x| (x.sides, x.face, x.source.as_str()))
        .collect();
    assert_eq!(
        rider_dice,
        vec![
            (6.0, 1.0, "sneak"),
            (6.0, 2.0, "sneak"),
            (6.0, 3.0, "sneak"),
            (6.0, 4.0, "sneak")
        ]
    );
    assert_eq!(crit.waves[1].outcomes, vec![oc("b", Hit, 9.0)]);
    // The coin fails: no dice, skipped, and the landing still counts (b lands nothing).
    let skipped = t.sample(&mut script(&[15.0, 2.0, 15.0, 6.0], &[false]))?;
    assert_eq!(skipped.waves[0].outcomes[1], oc("sneak", Skipped, 0.0));
    assert!(
        skipped.waves[0]
            .dice
            .iter()
            .all(|x| x.role != DieRole::Rider)
    );
    assert_eq!(skipped.waves[1].outcomes, vec![oc("b", Hit, 9.0)]);
    Ok(())
}

#[test]
fn refuses_a_turn_with_a_dealing_condition_as_the_joint_pmf_does() -> T {
    let ray = d20()
        .plus(7.0)?
        .ac(16.0)?
        .on_hit(roll_of(2.0, crate::builder::factory::d8())?)?
        .typed("cold")?;
    let gate = ConditionGate {
        dealing: Some("cold".to_string()),
        ..ConditionGate::default()
    };
    let first = ray.on_every_hit_with(grant(advantage().until_next_attack()), Some(gate))?;
    let t = turn(vec![atk_of(first), atk_of(ray)], 0.0)?;
    let refused = t
        .sample(&mut script(&[], &[]))
        .err()
        .ok_or("sample must refuse")?;
    assert!(
        refused.message().contains("dealing"),
        "{}",
        refused.message()
    );
    Ok(())
}
