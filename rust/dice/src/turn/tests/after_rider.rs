//! `src/turn/after-rider.test.ts`: 40 tests (the per-kind loop is expanded into one Rust module
//! per kind), 0 compat calls (no compat entries; asserts the numbers of the test).
//!
//! Not translated: after-rider.test.ts:314: `landing: "never" as "hit"` (a landing outside
//! `AfterLanding` cannot be written in Rust: the type-level half of "still refuses a bad
//! landing"; the Rust test asserts the valid-landing control over the same rows builds).

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::common::Rng;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, FirstHitOptions};
use crate::turn::trace::OutcomeResult;
use crate::turn::types::{
    After, AfterLanding, Attack, AttackOptions, DamageSource, PerSource, Rider, RiderDamage,
    RiderDamageSpec, RiderLanding, RiderOptions, RiderPayload, SaveLanding, Source, SubstituteKind,
    SubstituteOn, SubstitutePolicy, SubstituteSpec, Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use std::collections::{BTreeMap, HashSet};

// `d20+5` against AC 14 lands on a roll of 9 or more: 0.6 (a natural 20 is the 0.05 of it that
// crits). Flat damage, so a crit adds nothing and every landing deals 2.
const P: f64 = 0.6;

fn swing() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(14.0)?.on_hit(flat(2.0)?)
}

/// The same landing odds with dice a `dice-match` rider can read.
fn diced() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(14.0)?.on_hit(rs(2.0, 6.0)?)
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn row(id: &str, source: impl Into<Source>) -> Attack {
    named(id, source)
}

fn declared(
    id: &str,
    source: impl Into<Source>,
    chance: Option<f64>,
    after: Option<(&str, AfterLanding)>,
) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            chance,
            after: after.map(|(of, landing)| After {
                of: of.to_string(),
                landing,
            }),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

/// Wails from the Grave: an auto-hit 1d6 straight after the rider's damage, never without it.
fn wails_after(of: &str, landing: AfterLanding) -> Result<Attack, DiceError> {
    Ok(declared(
        "wails",
        damage(rs(1.0, 6.0)?),
        None,
        Some((of, landing)),
    ))
}

fn wails() -> Result<Attack, DiceError> {
    wails_after("sneak", AfterLanding::Damage)
}

fn rider_with(id: &str, trigger: Trigger, damage: DamageSource) -> Rider {
    Rider {
        trigger,
        id: Some(id.to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage)),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn first_hit(of: Option<&[&str]>) -> Trigger {
    Trigger::FirstHit {
        of: of.map(strings),
        per_source: None,
    }
}

fn sneak_of(of: &[&str]) -> Result<Rider, DiceError> {
    Ok(rider_with(
        "sneak",
        first_hit(Some(of)),
        DamageSource::Roll(flat(10.0)?),
    ))
}

fn sneak() -> Result<Rider, DiceError> {
    sneak_of(&["a", "b"])
}

fn from(attacks: Vec<Attack>, riders: Vec<Rider>) -> Result<Turn, DiceError> {
    Turn::from_spec(
        TurnSpec {
            attacks,
            riders: Some(riders),
            ..TurnSpec::default()
        },
        0.0,
    )
}

fn spec() -> Result<Turn, DiceError> {
    from(
        vec![row("a", swing()?), row("b", swing()?), wails()?],
        vec![sneak()?],
    )
}

/// P(the row happens): `chance`, its gate and its parent's landing.
fn occurs(t: &Turn, id: &str) -> Result<f64, DiceError> {
    let marginal = t.marginal(id)?;
    marginal
        .as_attack()
        .map(|m| m.occurs)
        .ok_or_else(|| DiceError::Error(format!("{id} is not an attack marginal")))
}

fn marginal_mean(t: &Turn, id: &str) -> Result<f64, DiceError> {
    Ok(t.marginal(id)?.pmf().mean())
}

fn max_diff(a: &Pmf, b: &Pmf) -> f64 {
    let values: HashSet<u64> = a
        .support()
        .iter()
        .chain(b.support().iter())
        .map(|d| d.0.to_bits())
        .collect();
    values
        .into_iter()
        .map(|bits| {
            let v = f64::from_bits(bits);
            (a.p_at(v) - b.p_at(v)).abs()
        })
        .fold(0.0, f64::max)
}

/// `{ code, message }` of the `TurnSpecError` a build threw; `None` when it built.
fn refused<X>(result: Result<X, DiceError>) -> Result<Option<(String, String)>, DiceError> {
    match result {
        Ok(_) => Ok(None),
        Err(DiceError::TurnSpec(e)) => Ok(Some((e.code.as_str().to_string(), e.message))),
        Err(other) => Err(DiceError::error(format!("not a TurnSpecError: {other}"))),
    }
}

fn open() -> f64 {
    1.0 - (1.0 - P) * (1.0 - P)
}

#[test]
fn opens_where_any_of_the_riders_attacks_landed_not_where_the_first_one_did() -> T {
    let t = spec()?;
    close(t.fire_probability("sneak")?, open(), 12);
    close(occurs(&t, "wails")?, open(), 12);
    // E = P(Sneak Attack fired) * 3.5 = (1 - 0.4 * 0.4) * 3.5 = 2.94.
    close(marginal_mean(&t, "wails")?, 2.94, 9);
    close(t.mean()?, 2.0 * 2.0 * P + open() * 10.0 + 2.94, 9);
    Ok(())
}

#[test]
fn is_the_exact_joint_of_the_attacks_the_rider_and_the_gated_row() -> T {
    let mut reference: BTreeMap<i64, f64> = BTreeMap::new();
    for a in [0.0, 1.0] {
        for b in [0.0, 1.0] {
            let p = (if a == 1.0 { P } else { 1.0 - P }) * (if b == 1.0 { P } else { 1.0 - P });
            let base = (2.0 * (a + b)) as i64;
            if a + b == 0.0 {
                *reference.entry(base).or_insert(0.0) += p;
            } else {
                for face in 1..=6 {
                    *reference.entry(base + 10 + face).or_insert(0.0) += p / 6.0;
                }
            }
        }
    }
    let pmf = spec()?.pmf()?;
    let mut values: HashSet<i64> = reference.keys().copied().collect();
    values.extend(pmf.support().iter().map(|d| d.0 as i64));
    for value in values {
        close(
            pmf.p_at(value as f64),
            reference.get(&value).copied().unwrap_or(0.0),
            12,
        );
    }
    Ok(())
}

#[test]
fn reads_hit_damage_and_any_alike_the_rider_fired() -> T {
    let mut pmfs = Vec::new();
    for landing in [AfterLanding::Hit, AfterLanding::Damage, AfterLanding::Any] {
        pmfs.push(
            from(
                vec![
                    row("a", swing()?),
                    row("b", swing()?),
                    wails_after("sneak", landing)?,
                ],
                vec![sneak()?],
            )?
            .pmf()?,
        );
    }
    assert_eq!(max_diff(&pmfs[0], &pmfs[1]), 0.0);
    assert_eq!(max_diff(&pmfs[0], &pmfs[2]), 0.0);
    Ok(())
}

#[test]
fn lands_0_when_the_rider_cannot_fire() -> T {
    let never = from(
        vec![
            declared("a", swing()?, Some(0.0), None),
            declared("b", swing()?, Some(0.0), None),
            wails()?,
        ],
        vec![sneak()?],
    )?;
    assert_eq!(never.fire_probability("sneak")?, 0.0);
    assert_eq!(occurs(&never, "wails")?, 0.0);
    assert_eq!(marginal_mean(&never, "wails")?, 0.0);
    close(never.pmf()?.p_at(0.0), 1.0, 12);
    // Two attacks that land on a natural 20 only: 1 - 0.95 * 0.95.
    let rare = d20().plus(5.0)?.ac(30.0)?.on_hit(flat(2.0)?)?;
    let t = from(
        vec![row("a", rare.clone()), row("b", rare), wails()?],
        vec![sneak()?],
    )?;
    close(marginal_mean(&t, "wails")?, (1.0 - 0.95 * 0.95) * 3.5, 9);
    Ok(())
}

fn abc() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![
        row("a", swing()?),
        row("b", swing()?),
        row("c", swing()?),
        wails()?,
    ])
}

fn sneak_every_hit(max: Option<f64>) -> Result<Rider, DiceError> {
    Ok(rider_with(
        "sneak",
        Trigger::EveryHit {
            of: Some(strings(&["a", "b", "c"])),
            max,
            per_source: None,
        },
        DamageSource::Roll(flat(10.0)?),
    ))
}

#[test]
fn is_an_event_not_a_count_a_rider_capped_at_one_landing_never_opens_the_row_more_than_once() -> T {
    let capped = from(abc()?, vec![sneak_every_hit(Some(1.0))?])?;
    let closed = 1.0 - (1.0 - P).powi(3);
    assert!(occurs(&capped, "wails")? <= 1.0);
    close(occurs(&capped, "wails")?, closed, 12);
    close(marginal_mean(&capped, "wails")?, closed * 3.5, 9);
    // `max: 1` IS first-hit, and so is its gate.
    let first = from(
        abc()?,
        vec![rider_with(
            "sneak",
            first_hit(Some(&["a", "b", "c"])),
            DamageSource::Roll(flat(10.0)?),
        )],
    )?;
    assert!(max_diff(&capped.pmf()?, &first.pmf()?) < 1e-15);
    // Capped at two of three, or uncapped: the rider still fires once or more, and the row opens once.
    for max in [Some(2.0), None] {
        let t = from(abc()?, vec![sneak_every_hit(max)?])?;
        close(occurs(&t, "wails")?, closed, 12);
        close(marginal_mean(&t, "wails")?, closed * 3.5, 9);
    }
    Ok(())
}

#[test]
fn several_rows_gated_on_one_rider_all_open_together() -> T {
    let t = from(
        vec![
            row("a", swing()?),
            row("b", swing()?),
            wails()?,
            declared(
                "echo",
                damage(rs(1.0, 6.0)?),
                Some(0.5),
                Some(("sneak", AfterLanding::Hit)),
            ),
        ],
        vec![sneak()?],
    )?;
    close(occurs(&t, "wails")?, open(), 12);
    close(occurs(&t, "echo")?, open() * 0.5, 12);
    close(
        t.mean()?,
        2.0 * 2.0 * P + open() * 10.0 + open() * 3.5 + open() * 0.5 * 3.5,
        9,
    );
    Ok(())
}

#[test]
fn works_through_the_fluent_calls_as_a_rider_with_an_explicit_of_allows_more_attacks_after_it() -> T
{
    let fluent = turn(vec![], 0.0)?
        .attack_as(swing()?, "a")?
        .attack_as(swing()?, "b")?
        .on_first_hit_with(
            flat(10.0)?,
            FirstHitOptions {
                condition: ConditionOptions {
                    rider: RiderOptions {
                        id: Some("sneak".to_string()),
                        of: Some(strings(&["a", "b"])),
                        ..RiderOptions::default()
                    },
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
        )?
        .attack_with(
            damage(rs(1.0, 6.0)?),
            AttackOptions {
                id: Some("wails".to_string()),
                after: Some(After {
                    of: "sneak".to_string(),
                    landing: AfterLanding::Damage,
                }),
                ..AttackOptions::default()
            },
        )?;
    assert_eq!(max_diff(&fluent.pmf()?, &spec()?.pmf()?), 0.0);
    Ok(())
}

#[test]
fn follows_the_riders_own_landing_a_damage_rider_over_a_save_row_opens_where_the_save_was_failed()
-> T {
    let breath = d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(rs(4.0, 6.0)?)])?;
    let mut r = rider_with(
        "r",
        first_hit(Some(&["s"])),
        DamageSource::Roll(flat(10.0)?),
    );
    r.landing = Some(RiderLanding::Save(SaveLanding::Fail));
    let t = from(
        vec![row("s", breath), wails_after("r", AfterLanding::Hit)?],
        vec![r],
    )?;
    // d20 against DC 13 fails on a roll under 13: 0.6.
    close(occurs(&t, "wails")?, 0.6, 12);
    close(t.fire_probability("r")?, 0.6, 12);
    Ok(())
}

fn below_substitute(of: &[&str], hit: f64, crit: f64) -> SubstituteSpec {
    SubstituteSpec {
        id: Some("s".to_string()),
        on: SubstituteOn::FirstHit,
        of: Some(strings(of)),
        substitute: SubstituteKind::RerollKeepHigher,
        mode: None,
        policy: Some(SubstitutePolicy::Below { hit, crit }),
    }
}

#[test]
fn keeps_a_substitutes_look_ahead_exact_beside_a_gated_row() -> T {
    let t = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                row("a", diced()?),
                row("b", diced()?),
                row("c", diced()?),
                wails_after("r", AfterLanding::Damage)?,
            ],
            riders: Some(vec![rider_with(
                "r",
                first_hit(Some(&["a", "b", "c"])),
                DamageSource::Roll(rs(3.0, 6.0)?),
            )]),
            substitutes: Some(vec![below_substitute(&["a", "b", "c"], 12.0, 20.0)]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let mut marginals = 0.0;
    for id in t.attack_ids()?.iter().chain(t.rider_ids()?.iter()) {
        marginals += marginal_mean(&t, id)?;
    }
    close(t.pmf()?.mean(), marginals, 9);
    close(occurs(&t, "wails")?, 1.0 - (1.0 - P).powi(3), 12);
    Ok(())
}

#[test]
fn a_substitute_does_not_hold_a_landing_for_a_gated_row_that_is_closed() -> T {
    // `g2` can never happen (what gates it never fires, or never happened), so `g1` is the only row
    // the substitute can still wait for: the turn is the one that never had `g2`.
    let six = d20().plus(5.0)?.ac(14.0)?.on_hit(rs(1.0, 6.0)?)?;
    let base = || -> Vec<Attack> {
        vec![
            declared("x", six.clone(), None, None),
            declared("y", six.clone(), Some(0.0), None),
            declared("g1", six.clone(), None, Some(("r1", AfterLanding::Hit))),
        ]
    };
    let r1 = || -> Result<Rider, DiceError> {
        Ok(rider_with(
            "r1",
            first_hit(Some(&["x"])),
            DamageSource::Roll(flat(1.0)?),
        ))
    };
    let r2 = || -> Result<Rider, DiceError> {
        Ok(rider_with(
            "r2",
            first_hit(Some(&["y"])),
            DamageSource::Roll(flat(1.0)?),
        ))
    };
    let build = |attacks: Vec<Attack>, riders: Vec<Rider>, of: &[&str]| {
        Turn::from_spec(
            TurnSpec {
                attacks,
                riders: Some(riders),
                substitutes: Some(vec![below_substitute(of, 4.0, 8.0)]),
                ..TurnSpec::default()
            },
            0.0,
        )
    };
    let without = build(base(), vec![r1()?], &["g1"])?;
    for (kind, after, riders) in [
        ("rider", ("r2", AfterLanding::Hit), vec![r1()?, r2()?]),
        ("attack", ("y", AfterLanding::Hit), vec![r1()?]),
    ] {
        let mut attacks = base();
        attacks.push(declared("g2", six.clone(), None, Some(after)));
        let t = build(attacks, riders, &["g1", "g2"])?;
        let a = marginal_mean(&t, "g1")?;
        let b = marginal_mean(&without, "g1")?;
        assert!((a - b).abs() < 5e-13, "{kind}: {a} vs {b}");
        assert!(max_diff(&t.pmf()?, &without.pmf()?) < 1e-12, "{kind}");
    }
    Ok(())
}

// Every rider kind a gate can read: the gated row happens exactly where `fireProbability` says the
// rider fired.
fn kind_rider(name: &str) -> Result<Rider, DiceError> {
    let of = || Some(strings(&["a", "b", "c"]));
    let payload = || -> Result<DamageSource, DiceError> { Ok(DamageSource::Roll(flat(100.0)?)) };
    let r =
        |trigger: Trigger| -> Result<Rider, DiceError> { Ok(rider_with("r", trigger, payload()?)) };
    let landing = |l| -> Result<Rider, DiceError> {
        Ok(Rider {
            landing: Some(l),
            ..r(first_hit(Some(&["a", "b", "c"])))?
        })
    };
    match name {
        "first-hit" => r(first_hit(Some(&["a", "b", "c"]))),
        "first-hit over a damage landing" => landing(RiderLanding::Save(SaveLanding::Damage)),
        "first-hit that lands on anything (folded)" => landing(RiderLanding::Any),
        "first-hit with a payload per attack (folded)" => {
            let mut per_source: PerSource = PerSource::new();
            for id in ["a", "b", "c"] {
                per_source.insert(
                    id.to_string(),
                    RiderPayload {
                        damage: RiderDamage::One(payload()?),
                        crit_damage: None,
                    },
                );
            }
            r(Trigger::FirstHit {
                of: of(),
                per_source: Some(per_source),
            })
        }
        "any-crit" => r(Trigger::AnyCrit {
            of: of(),
            max: None,
        }),
        "any-crit capped (folded)" => r(Trigger::AnyCrit {
            of: of(),
            max: Some(2.0),
        }),
        "any-miss" => r(Trigger::AnyMiss { of: of() }),
        "first-miss" => r(Trigger::FirstMiss { of: of() }),
        "dice-match" => r(Trigger::DiceMatch {
            of: strings(&["a", "b", "c"]),
        }),
        "every-hit" => r(Trigger::EveryHit {
            of: of(),
            max: None,
            per_source: None,
        }),
        "every-hit capped" => r(Trigger::EveryHit {
            of: of(),
            max: Some(2.0),
            per_source: None,
        }),
        other => Err(DiceError::error(format!("unknown kind {other}"))),
    }
}

fn kind_turn(rider: Rider) -> Result<Turn, DiceError> {
    from(
        vec![
            row("a", diced()?),
            row("b", diced()?),
            row("c", diced()?),
            declared(
                "w",
                damage(flat(1000.0)?),
                None,
                Some(("r", AfterLanding::Damage)),
            ),
        ],
        vec![rider],
    )
}

fn row_opens_where_the_rider_fired(name: &str) -> T {
    let t = kind_turn(kind_rider(name)?)?;
    let fired = t.fire_probability("r")?;
    assert!(fired > 0.0);
    assert!(fired <= 1.0);
    close(occurs(&t, "w")?, fired, 12);
    // The joint: the total carries the row's 1000 exactly where it carries the rider's 100 (the
    // attacks deal under 100).
    let pmf = t.pmf()?;
    let mut opened = 0.0;
    for total in pmf.support() {
        let total = total.0;
        let p = pmf.p_at(total);
        if p <= 0.0 {
            continue;
        }
        let gated = total >= 1000.0;
        assert_eq!(
            gated,
            ((total % 1000.0) / 100.0).floor() >= 1.0,
            "total {total}"
        );
        if gated {
            opened += p;
        }
    }
    close(opened, fired, 12);
    // The reader walk (marginals) and the joint walk (the PMF) agree.
    let mut marginals = 0.0;
    for id in t.attack_ids()?.iter().chain(t.rider_ids()?.iter()) {
        marginals += marginal_mean(&t, id)?;
    }
    close(pmf.mean(), marginals, 9);
    Ok(())
}

/// tests/helpers/lcg.ts `lcgRng` (mulberry32).
struct Lcg {
    s: u32,
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
        let sides = sides as u64;
        let limit = 4_294_967_296 - (4_294_967_296 % sides);
        let mut x = u64::from(self.next());
        while x >= limit {
            x = u64::from(self.next());
        }
        (x % sides) as f64 + 1.0
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

fn sampled_row_opens_where_the_rider_fired(name: &str) -> T {
    let t = kind_turn(kind_rider(name)?)?;
    let mut rng = Lcg {
        s: 0x5eed + name.len() as u32,
    };
    let samples = 20_000;
    let mut opened = 0.0;
    for _ in 0..samples {
        let trace = t.sample(&mut rng)?;
        let outcomes: Vec<_> = trace.waves.iter().flat_map(|w| w.outcomes.iter()).collect();
        let gated = outcomes
            .iter()
            .any(|o| o.source == "w" && o.result != OutcomeResult::Skipped);
        let fired = outcomes
            .iter()
            .any(|o| o.source == "r" && o.result == OutcomeResult::Fired);
        assert_eq!(gated, fired);
        if gated {
            opened += 1.0;
        }
    }
    let n = f64::from(samples);
    let p = occurs(&t, "w")?;
    assert!((opened / n - p).abs() < 5.0 * (p * (1.0 - p) / n).sqrt() + 1e-12);
    Ok(())
}

macro_rules! kind_tests {
    ($($id:ident: $name:literal),* $(,)?) => {
        mod kinds {
            use super::*;
            $(
                mod $id {
                    use super::*;

                    #[test]
                    fn the_row_opens_exactly_where_the_rider_fired() -> T {
                        row_opens_where_the_rider_fired($name)
                    }

                    #[test]
                    fn a_sampled_turn_opens_the_row_exactly_where_the_rider_fired() -> T {
                        sampled_row_opens_where_the_rider_fired($name)
                    }
                }
            )*
        }
    };
}

kind_tests! {
    first_hit: "first-hit",
    first_hit_over_a_damage_landing: "first-hit over a damage landing",
    first_hit_that_lands_on_anything: "first-hit that lands on anything (folded)",
    first_hit_with_a_payload_per_attack: "first-hit with a payload per attack (folded)",
    any_crit: "any-crit",
    any_crit_capped: "any-crit capped (folded)",
    any_miss: "any-miss",
    first_miss: "first-miss",
    dice_match: "dice-match",
    every_hit: "every-hit",
    every_hit_capped: "every-hit capped",
}

#[test]
fn refuses_a_rider_that_watches_a_row_not_before_the_gated_attack() -> T {
    let (code, message) = refused(from(
        vec![row("a", swing()?), wails()?, row("b", swing()?)],
        vec![sneak()?],
    ))?
    .ok_or("built")?;
    assert_eq!(code, "unknown-id");
    assert!(message.contains("\"sneak\""));
    assert!(message.contains("\"b\""));
    assert!(message.contains("does not come before"));
    // Its own `of` left out is every attack, the gated one included.
    let (code, message) = refused(from(
        vec![
            row("a", swing()?),
            declared("w", swing()?, None, Some(("sneak", AfterLanding::Hit))),
        ],
        vec![rider_with(
            "sneak",
            first_hit(None),
            DamageSource::Roll(flat(10.0)?),
        )],
    ))?
    .ok_or("built")?;
    assert_eq!(code, "unknown-id");
    assert!(message.contains("\"w\""));
    Ok(())
}

#[test]
fn refuses_a_rider_that_watches_a_rider_it_resolves_after_every_declared_attack() -> T {
    let (code, message) = refused(from(
        vec![
            row("a", swing()?),
            declared(
                "w",
                damage(flat(1000.0)?),
                None,
                Some(("r2", AfterLanding::Hit)),
            ),
        ],
        vec![
            rider_with(
                "r1",
                Trigger::AnyMiss {
                    of: Some(strings(&["a"])),
                },
                DamageSource::Attack(Box::new(swing()?)),
            ),
            rider_with(
                "r2",
                first_hit(Some(&["r1"])),
                DamageSource::Roll(flat(100.0)?),
            ),
        ],
    ))?
    .ok_or("built")?;
    assert_eq!(code, "unknown-id");
    assert!(message.contains("\"r2\""));
    assert!(message.contains("\"r1\""));
    Ok(())
}

#[test]
fn names_a_missing_id_as_neither_an_attack_nor_a_rider() -> T {
    let (code, message) = refused(Turn::from_spec(
        TurnSpec {
            attacks: vec![
                row("a", swing()?),
                wails_after("nowhere", AfterLanding::Hit)?,
            ],
            ..TurnSpec::default()
        },
        0.0,
    ))?
    .ok_or("built")?;
    assert_eq!(code, "unknown-id");
    assert!(message.contains("\"nowhere\""));
    Ok(())
}

#[test]
fn refuses_a_rider_whose_firing_is_not_one_event_over_attacks() -> T {
    let not_fired = refused(from(
        vec![row("a", swing()?), wails_after("else", AfterLanding::Hit)?],
        vec![
            sneak_of(&["a"])?,
            rider_with(
                "else",
                Trigger::NotFired {
                    of: "sneak".to_string(),
                },
                DamageSource::Roll(flat(5.0)?),
            ),
        ],
    ))?
    .ok_or("built")?;
    assert_eq!(not_fired.0, "unsupported-trigger");
    let rolls_attack = refused(from(
        vec![row("a", swing()?), wails()?],
        vec![rider_with(
            "sneak",
            first_hit(Some(&["a"])),
            DamageSource::Attack(Box::new(swing()?)),
        )],
    ))?
    .ok_or("built")?;
    assert_eq!(rolls_attack.0, "unsupported-trigger");
    assert!(rolls_attack.1.contains("rolls its own attack"));
    let may_not_happen = refused(from(
        vec![row("a", swing()?), wails()?],
        vec![Rider {
            happens: Some(0.5),
            ..sneak_of(&["a"])?
        }],
    ))?
    .ok_or("built")?;
    assert_eq!(may_not_happen.0, "unsupported-trigger");
    assert!(may_not_happen.1.contains("happens"));
    Ok(())
}

#[test]
fn still_refuses_a_bad_landing() -> T {
    // `landing: "never"` is not an `AfterLanding` in Rust (module doc): the control asserts that a
    // valid landing over the same rows builds.
    let built = from(
        vec![row("a", swing()?), wails_after("sneak", AfterLanding::Hit)?],
        vec![sneak_of(&["a"])?],
    );
    assert_eq!(code_of(built), "none");
    Ok(())
}

fn gated(landing: AfterLanding) -> Result<Turn, DiceError> {
    Turn::from_spec(
        TurnSpec {
            attacks: vec![
                row("a", swing()?),
                declared("b", swing()?, None, Some(("a", landing))),
            ],
            ..TurnSpec::default()
        },
        0.0,
    )
}

#[test]
fn opens_where_the_parent_landed_for_the_landing_asked() -> T {
    // a deals 2 on 0.6; b deals 2 on its own 0.6, but only where a landed (any: where a happened).
    close(gated(AfterLanding::Hit)?.mean()?, 2.0 * P + 2.0 * P * P, 12);
    close(
        gated(AfterLanding::Damage)?.mean()?,
        2.0 * P + 2.0 * P * P,
        12,
    );
    close(gated(AfterLanding::Any)?.mean()?, 2.0 * P + 2.0 * P, 12);
    close(occurs(&gated(AfterLanding::Hit)?, "b")?, P, 12);
    Ok(())
}

#[test]
fn is_the_same_turn_as_a_first_hit_rider_over_that_one_attack() -> T {
    let via_attack = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                row("a", swing()?),
                row("w", diced()?),
                declared("g", swing()?, None, Some(("a", AfterLanding::Hit))),
            ],
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let via_rider = from(
        vec![
            row("a", swing()?),
            row("w", diced()?),
            declared("g", swing()?, None, Some(("sneak", AfterLanding::Hit))),
        ],
        vec![rider_with(
            "sneak",
            first_hit(Some(&["a"])),
            DamageSource::Roll(flat(0.0)?),
        )],
    )?;
    assert!(max_diff(&via_attack.pmf()?, &via_rider.pmf()?) < 1e-12);
    Ok(())
}

#[test]
fn is_still_unknown_id_for_a_parent_that_does_not_come_before_it() -> T {
    let (code, message) = refused(Turn::from_spec(
        TurnSpec {
            attacks: vec![
                declared("a", swing()?, None, Some(("b", AfterLanding::Hit))),
                row("b", swing()?),
            ],
            ..TurnSpec::default()
        },
        0.0,
    ))?
    .ok_or("built")?;
    assert_eq!(code, "unknown-id");
    assert!(message.contains("does not come before it"));
    Ok(())
}
