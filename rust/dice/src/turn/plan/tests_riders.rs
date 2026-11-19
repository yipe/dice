//! Translated TS tests (riders, substitutes, folds and draws of `buildPlan`).
//!
//! Sources: src/turn/every-hit-max.test.ts, tests/turn-riders.test.ts, src/turn/dice-match.test.ts,
//! tests/dice-match-descriptor.test.ts, tests/dice-match-pools.test.ts, src/turn/first-miss.test.ts,
//! src/turn/first-miss-reroll.test.ts, tests/turn-convert-first-miss.test.ts,
//! src/turn/substitute.test.ts, src/turn/dealing-riders.test.ts, src/turn/rerolled-under.test.ts.
//!
//! A fluent chain (`turn([a, b]).onEveryHit(d6, { max: 2 })`) is the spec it writes: the rider's
//! `of` defaulted to the attacks so far (`attack 1`, ...) and its id to `rider N`. Where the TS
//! asserts an error on a chain that fails in a `Turn` verb before any plan is built (the verb's
//! own `Error`, `attack-after-rider`, `otherwise`, `vsAC`), the case is deferred below.
//!
//! Deferred (`file:line: reason`), all of them read a `Turn` value (mean, pmf, marginal,
//! fireProbability, expectedApplications, stepStats, sample) or a builder, not the plan:
//! - every-hit-max.test.ts:210-236, 247-388, 394-445, 498-510, 517-632, 634-657, 697-744,
//!   806-809, 814-831, 946-1137, 1223-1234: Turn pmf / mean / fireProbability / inspectTurn state counts.
//! - every-hit-max.test.ts:1147-1151: the `max` `RangeError` is raised by the plan: translated (see
//!   `needs_a_positive_integer_max`); 1153-1161, 1194-1202: `max` on first-hit and a payload per source
//!   on any-crit: type-level (the Rust `Trigger` has no such field).
//! - every-hit-max.test.ts:1163-1179: the `Error`s of the `Turn` verbs beside a grant or a transform:
//!   turn.ts, not the plan.
//! - every-hit-max.test.ts:1204-1206: `otherwise()` on a capped rider: turn.ts verb.
//! - every-hit-max.test.ts:1139-1143 and 957-1066 (counters by landing kind) are translated as
//!   structure only (`a_save_row_with_a_landing_kind_...`, `damage_and_fail_over_one_row_...`).
//! - turn-riders.test.ts:28-84: Turn pmf / marginal / the oracle families.
//! - dice-match.test.ts:9-75, 103-176, 204-232: diceMatchInfo (builder), Turn mean / pmf / latency.
//! - dice-match.test.ts:191-194: `bounce()` `RangeError`: turn.ts verb, no plan.
//! - rerolled-under.test.ts:168-181: a dice-match rider over a hand-written `rerolledUnder` source:
//!   type-level (a Rust `ContextualSource` has no `diceMatchInfo`).
//! - first-miss-reroll.test.ts:314-340: Turn mean through `rollUnder` / `missRerolledUnder`.
//! - dice-match-descriptor.test.ts:34-36, 39-41 and dice-match-pools.test.ts (all but 131, 338-348):
//!   `diceMatchInfo()` / `diceMatchRefusals()` of the builder, and Turn means.
//! - first-miss.test.ts:93-165: Turn mean / pmf / fireProbability (the plan builds: see `first_miss_*`).
//! - first-miss-reroll.test.ts:61-230, 278-312, 328-340, 420-438: Turn mean / pmf / sample against the oracle.
//! - first-miss-reroll.test.ts:274-276: `rerollFirstMiss({ of: [] })` is a turn.ts verb.
//! - substitute.test.ts:147-299, 301-351, 360-538, 552-627, 695-807: Turn mean / pmf / fireProbability.
//! - substitute.test.ts:644-693: transforms on other verbs, `attack-after-rider`, `vsAC`, a rider
//!   before any attack: turn.ts verbs.
//! - substitute.test.ts:540-541: `keepBestDamage().optimally()` is the factory (effects.rs).
//! - turn-convert-first-miss.test.ts:22-89: Turn pmf / mean against the oracle.
//! - dealing-riders.test.ts:58-177: Turn stepStats / marginal.
//! - rerolled-under.test.ts:61-148, 190-241: Turn mean / pmf / sample.
//! - rerolled-under.test.ts:183-188: a `rerolledUnder()` that returns no PMF: type-level; the
//!   no-outcome case needs the walk (the rerolled PMF is read in a block built then).

use super::test_support::*;
use super::{FoldMode, TurnPlan};
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::types::{
    Attack, AttackOptions, DamageSource, MAX_CAPPED_COUNTERS, PerSource, Rider, RiderDamage,
    RiderPayload, Source, SubstituteKind, SubstituteOn, SubstitutePolicy, SubstituteSpec, Trigger,
    TurnSpec, TurnSpecErrorCode as Code,
};
use std::sync::Arc;

// --- the sources and spec pieces ------------------------------------------------------------

/// `d20.plus(7).ac(15).onHit(d8.plus(4))`: hit 0.6, crit 0.05.
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_of(7.0, 15.0, d8().plus(4.0)?)
}

/// `d20.plus(5).ac(14).onHit(d6.plus(3))`: hit 0.55, crit 0.05.
fn knife() -> Result<AttackBuilder, DiceError> {
    attack_of(5.0, 14.0, d6().plus(3.0)?)
}

/// `d20.plus(5).ac(17).onHit(roll(3, d8))`.
fn orb() -> Result<AttackBuilder, DiceError> {
    attack_of(5.0, 17.0, rs(3.0, 8.0)?)
}

fn attacks_of(sources: Vec<AttackBuilder>) -> Vec<Attack> {
    sources.into_iter().map(bare).collect()
}

/// `turn().attacks(n, source)`.
fn copies(n: usize, source: &AttackBuilder) -> Vec<Attack> {
    (0..n).map(|_| bare(source.clone())).collect()
}

/// `attack 1` .. `attack n`.
fn ids(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("attack {i}")).collect()
}

fn refs(list: &[String]) -> Vec<&str> {
    list.iter().map(String::as_str).collect()
}

/// A payload of one damage.
fn pl(damage: impl Into<DamageSource>) -> RiderPayload {
    RiderPayload {
        damage: RiderDamage::One(damage.into()),
        crit_damage: None,
    }
}

fn per(entries: Vec<(&str, RiderPayload)>) -> PerSource {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

/// `onEveryHit(damage, { of, max, perSource })`.
fn every(
    of: &[&str],
    max: Option<f64>,
    per_source: Option<PerSource>,
    damage: impl Into<DamageSource>,
) -> Rider {
    rider(
        Trigger::EveryHit {
            of: Some(of.iter().map(std::string::ToString::to_string).collect()),
            max,
            per_source,
        },
        damage,
    )
}

/// `onFirstHit(damage, { of, perSource })`.
fn first(of: &[&str], per_source: Option<PerSource>, damage: impl Into<DamageSource>) -> Rider {
    rider(
        Trigger::FirstHit {
            of: Some(of.iter().map(std::string::ToString::to_string).collect()),
            per_source,
        },
        damage,
    )
}

fn with_id(id: &str, r: Rider) -> Rider {
    Rider {
        id: Some(id.to_string()),
        ..r
    }
}

fn with_crit(damage: impl Into<DamageSource>, r: Rider) -> Rider {
    Rider {
        crit_damage: Some(RiderDamage::One(damage.into())),
        ..r
    }
}

fn flat1(n: f64) -> Result<RollBuilder, DiceError> {
    flat(n)
}

use crate::builder::roll::RollBuilder;

fn assert_spec_error(
    result: Result<TurnPlan, DiceError>,
    code: Code,
    id: Option<&str>,
    fragment: Option<&str>,
) {
    let error = refusal(result);
    assert_eq!(error.code, code, "{}", error.message);
    if let Some(id) = id {
        assert_eq!(error.id, id);
    }
    if let Some(fragment) = fragment {
        assert!(
            error.message.contains(fragment),
            "message {:?} lacks {fragment:?}",
            error.message
        );
    }
}

/// A build that must succeed, as a test error.
fn built(result: Result<TurnPlan, DiceError>) -> Result<TurnPlan, DiceError> {
    result.map_err(|e| DiceError::error(format!("{}: {e}", e.name())))
}

fn build(attacks: Vec<Attack>, riders: Vec<Rider>) -> Result<TurnPlan, DiceError> {
    plan_of(&spec(attacks, riders))
}

// --- onEveryHit max: an exact cap on applications --------------------------------------------

/// A first-hit payload per source beside an any-miss reroll an ordered rider cannot watch:
/// `onFirstMiss` is the advice.
#[test]
fn refuses_a_first_hit_payload_per_source() -> T {
    let reroll_of = ["attack 1", "attack 2", "reroll"];
    let mk = |capped: bool| -> Result<Result<TurnPlan, DiceError>, DiceError> {
        let miss = with_id(
            "reroll",
            rider(any_miss(Some(&["attack 1", "attack 2"])), sword()?),
        );
        let per_source = Some(per(vec![("attack 2", pl(flat1(100.0)?))]));
        let watcher = if capped {
            every(&reroll_of, Some(1.0), per_source, flat1(1.0)?)
        } else {
            first(&reroll_of, per_source, flat1(1.0)?)
        };
        Ok(build(
            attacks_of(vec![sword()?, knife()?]),
            vec![miss, watcher],
        ))
    };
    let capped = mk(true)?;
    assert_spec_error(
        capped,
        Code::UnsupportedTrigger,
        Some("rider 2"),
        Some("onFirstMiss"),
    );
    assert_spec_error(mk(false)?, Code::UnsupportedTrigger, Some("rider 2"), None);
    Ok(())
}

#[test]
fn refuses_a_cap_that_can_bind() -> T {
    for max in [2.0, 3.0] {
        let miss = with_id(
            "reroll",
            rider(
                any_miss(Some(&["attack 1", "attack 2", "attack 3"])),
                sword()?,
            ),
        );
        let capped = every(
            &["attack 1", "attack 2", "reroll", "attack 3"],
            Some(max),
            None,
            d6(),
        );
        let result = build(
            attacks_of(vec![sword()?, sword()?, knife()?]),
            vec![miss, capped],
        );
        assert_spec_error(
            result,
            Code::UnsupportedTrigger,
            Some("rider 2"),
            Some("is capped"),
        );
    }
    Ok(())
}

#[test]
fn allows_what_does_not_read_the_order_no_cap_a_cap_that_cannot_bind_a_plain_first_hit() -> T {
    let of = ["attack 1", "attack 2", "reroll"];
    let base = |watcher: Rider| -> Result<Result<TurnPlan, DiceError>, DiceError> {
        let miss = with_id(
            "reroll",
            rider(any_miss(Some(&["attack 1", "attack 2"])), sword()?),
        );
        Ok(build(
            attacks_of(vec![sword()?, knife()?]),
            vec![miss, watcher],
        ))
    };
    assert!(base(every(&of, None, None, d6()))?.is_ok());
    assert!(base(every(&of, Some(3.0), None, d6()))?.is_ok());
    assert!(
        base(every(
            &of,
            None,
            Some(per(vec![("attack 2", pl(d8()))])),
            d6()
        ))?
        .is_ok()
    );
    assert!(base(every(&of, Some(1.0), None, d6()))?.is_ok());
    assert!(base(first(&of, None, d6()))?.is_ok());
    Ok(())
}

#[test]
fn is_refused_in_the_riders_own_damage_and_in_a_payload_and_in_a_list() -> T {
    let two = || copies(2, &sword().expect("builder"));
    let at = &["attack 1", "attack 2"];
    let own = build(
        two(),
        vec![first(at, Some(per(vec![("attack 2", pl(d6()))])), knife()?)],
    );
    let payload = build(
        two(),
        vec![first(at, Some(per(vec![("attack 2", pl(knife()?))])), d6())],
    );
    let list = build(
        two(),
        vec![first(
            at,
            Some(per(vec![(
                "attack 2",
                RiderPayload {
                    damage: RiderDamage::Many(vec![knife()?.into(), knife()?.into()]),
                    crit_damage: None,
                },
            )])),
            d6(),
        )],
    );
    for result in [own, payload, list] {
        assert_spec_error(
            result,
            Code::UnsupportedTrigger,
            Some("rider 1"),
            Some("plain onFirstHit"),
        );
    }
    Ok(())
}

#[test]
fn is_refused_for_a_capped_or_per_source_every_hit_rider_too_but_not_for_a_plain_one() -> T {
    let three = || copies(3, &sword().expect("builder"));
    let two = || copies(2, &sword().expect("builder"));
    let all3 = &["attack 1", "attack 2", "attack 3"];
    let all2 = &["attack 1", "attack 2"];
    let capped = build(three(), vec![every(all3, Some(2.0), None, knife()?)]);
    let capped_payload = build(
        three(),
        vec![every(
            all3,
            Some(2.0),
            Some(per(vec![("attack 2", pl(knife()?))])),
            d6(),
        )],
    );
    let per_source = build(
        two(),
        vec![every(
            all2,
            None,
            Some(per(vec![(
                "attack 2",
                RiderPayload {
                    damage: RiderDamage::Many(vec![knife()?.into(), d6().into()]),
                    crit_damage: None,
                },
            )])),
            d6(),
        )],
    );
    let cannot_bind = build(two(), vec![every(all2, Some(2.0), None, knife()?)]);
    for result in [capped, capped_payload, per_source, cannot_bind] {
        assert_spec_error(
            result,
            Code::UnsupportedTrigger,
            Some("rider 1"),
            Some("plain onFirstHit"),
        );
    }
    assert!(build(two(), vec![every(all2, None, None, knife()?)]).is_ok());
    assert!(build(two(), vec![every(all2, Some(1.0), None, knife()?)]).is_ok());
    Ok(())
}

#[test]
fn is_refused_when_only_the_crit_damage_rolls_an_attack_rider_level_or_per_source() -> T {
    let knife_at =
        |ac: f64| -> Result<AttackBuilder, DiceError> { attack_of(5.0, ac, d6().plus(3.0)?) };
    let three = || copies(3, &sword().expect("builder"));
    let two = || copies(2, &sword().expect("builder"));
    let all3 = &["attack 1", "attack 2", "attack 3"];
    let all2 = &["attack 1", "attack 2"];
    let per_crit = |at: f64| -> Result<PerSource, DiceError> {
        Ok(per(vec![(
            "attack 2",
            RiderPayload {
                damage: RiderDamage::One(d6().into()),
                crit_damage: Some(RiderDamage::One(knife_at(at)?.into())),
            },
        )]))
    };
    let builds = vec![
        build(
            three(),
            vec![with_crit(
                knife_at(14.0)?,
                every(all3, Some(2.0), None, d6()),
            )],
        ),
        build(
            three(),
            vec![{
                let r = every(all3, Some(2.0), None, d6());
                Rider {
                    crit_damage: Some(RiderDamage::Many(vec![d6().into(), knife_at(14.0)?.into()])),
                    ..r
                }
            }],
        ),
        build(two(), vec![every(all2, None, Some(per_crit(14.0)?), d6())]),
        build(two(), vec![first(all2, Some(per_crit(14.0)?), d6())]),
        build(
            two(),
            vec![with_crit(
                knife_at(14.0)?,
                first(all2, Some(per(vec![("attack 2", pl(d8()))])), d6()),
            )],
        ),
    ];
    for result in builds {
        assert_spec_error(
            result,
            Code::UnsupportedTrigger,
            Some("rider 1"),
            Some("critDamage"),
        );
    }
    // What is not folded still takes an attack as its crit damage.
    for t in [first(all2, None, d6()), every(all2, None, None, d6())] {
        assert!(build(two(), vec![with_crit(knife_at(14.0)?, t)]).is_ok());
    }
    assert!(
        build(
            two(),
            vec![with_crit(
                knife_at(14.0)?,
                every(all2, Some(1.0), None, d6())
            )]
        )
        .is_ok()
    );
    Ok(())
}

#[test]
fn needs_a_positive_integer_max() -> T {
    for max in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
        let result = build(
            attacks_of(vec![sword()?]),
            vec![every(&["attack 1"], Some(max), None, d6())],
        );
        let shown = crate::js::num_to_string(max);
        match other_error(result) {
            DiceError::Range(message) => assert_eq!(
                message,
                format!("Rider \"rider 1\" needs a positive integer max, got {shown}.")
            ),
            other => panic!("expected a RangeError, got {other:?}"),
        }
    }
    Ok(())
}

#[test]
fn refuses_a_payload_for_a_source_the_rider_does_not_watch() -> T {
    let two = || copies(2, &sword().expect("builder"));
    for capped in [true, false] {
        let mk = |of: &[&str], key: &str| -> Result<Rider, DiceError> {
            let p = Some(per(vec![(key, pl(d4()))]));
            Ok(if capped {
                every(of, None, p, d6())
            } else {
                first(of, p, d6())
            })
        };
        assert_spec_error(
            build(two(), vec![mk(&["attack 1"], "attack 2")?]),
            Code::UnknownId,
            Some("attack 2"),
            Some("which it does not watch"),
        );
        assert_spec_error(
            build(two(), vec![mk(&["attack 1", "attack 2"], "nowhere")?]),
            Code::UnknownId,
            Some("nowhere"),
            Some("Watched: \"attack 1\", \"attack 2\"."),
        );
    }
    Ok(())
}

#[test]
fn cannot_watch_a_rider_that_can_apply_more_than_once_or_one_folded_per_source() -> T {
    let three = attacks_of(vec![sword()?, sword()?, sword()?]);
    let capped = with_id(
        "capped",
        every(&["attack 1", "attack 2", "attack 3"], Some(2.0), None, d6()),
    );
    let watcher = first(&["capped"], None, d4());
    assert_spec_error(
        build(three, vec![capped, watcher]),
        Code::NotAnAttack,
        None,
        None,
    );
    // A first-hit rider folded per source lands once: naming it makes it a partner, so the d4
    // lands alongside it.
    let folded = with_id(
        "folded",
        first(
            &["attack 1", "attack 2"],
            Some(per(vec![("attack 2", pl(d8()))])),
            d6(),
        ),
    );
    let partner = first(&["folded"], None, d4());
    assert!(build(attacks_of(vec![sword()?, sword()?]), vec![folded, partner]).is_ok());
    Ok(())
}

#[test]
fn bounds_the_capped_riders_that_watch_one_attack() -> T {
    // Caps of 1 are first hits and take no counter, so the counters start at 2.
    let all = ids(9);
    let all = refs(&all);
    let mut riders: Vec<Rider> = Vec::new();
    for cap in 2..(2 + MAX_CAPPED_COUNTERS) {
        riders.push(every(&all, Some(cap as f64), None, d4()));
    }
    let plan = built(build(copies(9, &sword()?), riders.clone()))?;
    assert_eq!(plan.counter_max.len(), MAX_CAPPED_COUNTERS);
    riders.push(every(
        &all,
        Some((2 + MAX_CAPPED_COUNTERS) as f64),
        None,
        d4(),
    ));
    assert_spec_error(
        build(copies(9, &sword()?), riders),
        Code::TooManyCounters,
        Some("attack 1"),
        Some("is watched by 7 capped every-hit riders"),
    );
    Ok(())
}

// --- structural facts of the plan: counters, slots, steps ------------------------------------

/// `inspectTurn`-style view of the draws every step has built: the whole observable shape of a plan
/// (`bins(pmf)` of the TS "bit for bit" tests, at the draw level).
fn shape(plan: &TurnPlan) -> Vec<String> {
    let mut out = Vec::new();
    for step in &plan.steps {
        out.push(format!(
            "{} slot={:?} reads={:?} negates={:?} chance={} policy={:?} converts={} damage={:?}",
            step.id,
            step.slot,
            step.reads,
            step.negates,
            step.chance,
            step.policy,
            step.converts,
            step.damage
        ));
        for (index, variant) in step.variants.built() {
            out.push(format!("  variant {index}: {variant:?}"));
        }
    }
    out.push(format!(
        "counter_max={:?} every_hit_ids={:?} fire_slots={:?} groups={}",
        plan.counter_max, plan.every_hit_ids, plan.fire_slots, plan.group_count
    ));
    out
}

fn step_ids(plan: &TurnPlan) -> Vec<&str> {
    plan.steps.iter().map(|s| s.id.as_str()).collect()
}

#[test]
fn shares_one_counter_between_riders_with_the_same_sources_and_cap() -> T {
    let all = ids(3);
    let plan = built(build(
        copies(3, &sword()?),
        vec![
            every(&refs(&all), Some(2.0), None, d10()),
            every(&refs(&all), Some(2.0), None, rs(2.0, 4.0)?),
        ],
    ))?;
    assert_eq!(plan.counter_max, vec![2.0]);
    assert_eq!(plan.every_hit_ids, vec!["rider 1", "rider 2"]);
    Ok(())
}

#[test]
fn keeps_riders_with_different_caps_and_one_uncapped_apart() -> T {
    let all = ids(4);
    let plan = built(build(
        copies(4, &sword()?),
        vec![
            with_id("one", every(&refs(&all), Some(1.0), None, d10())),
            with_id("three", every(&refs(&all), Some(3.0), None, rs(2.0, 4.0)?)),
            with_id("all", every(&refs(&all), None, None, d6())),
        ],
    ))?;
    // A cap of 1 is a first hit (lowered to one: a step with a fire slot, no counter).
    assert_eq!(plan.counter_max, vec![3.0]);
    assert_eq!(plan.every_hit_ids, vec!["three", "all"]);
    assert!(plan.fire_slots.contains_key("one"));
    assert!(step_ids(&plan).contains(&"one"));
    Ok(())
}

#[test]
fn gives_riders_over_different_sources_different_counters() -> T {
    let plan = built(build(
        copies(4, &sword()?),
        vec![
            with_id(
                "early",
                every(&["attack 1", "attack 2"], Some(1.0), None, d10()),
            ),
            with_id(
                "late",
                every(&["attack 2", "attack 3", "attack 4"], Some(2.0), None, d6()),
            ),
        ],
    ))?;
    // `early` (cap 1) is a first hit: only `late` keeps a counter.
    assert_eq!(plan.counter_max, vec![2.0]);
    // Same cap over different sources: two counters.
    let two = built(build(
        copies(4, &sword()?),
        vec![
            with_id(
                "early",
                every(
                    &["attack 1", "attack 2", "attack 3"],
                    Some(2.0),
                    None,
                    d10(),
                ),
            ),
            with_id(
                "late",
                every(&["attack 2", "attack 3", "attack 4"], Some(2.0), None, d6()),
            ),
        ],
    ))?;
    assert_eq!(two.counter_max, vec![2.0, 2.0]);
    Ok(())
}

#[test]
fn an_omitted_of_watches_every_declared_attack() -> T {
    let spec_rider = rider(
        Trigger::EveryHit {
            of: None,
            max: Some(2.0),
            per_source: None,
        },
        d6(),
    );
    let omitted = built(build(copies(3, &sword()?), vec![spec_rider]))?;
    let all = ids(3);
    let named = built(build(
        copies(3, &sword()?),
        vec![every(&refs(&all), Some(2.0), None, d6())],
    ))?;
    assert_eq!(omitted.counter_max, vec![2.0]);
    assert_eq!(shape(&omitted), shape(&named));
    Ok(())
}

/// A cap at or above the number of watched steps never binds: no counter, and the plan is the
/// uncapped rider's, bit for bit.
#[test]
fn caps_that_cannot_bind_are_the_uncapped_rider() -> T {
    for attacks in 1..=4usize {
        for max in [attacks, attacks + 1, 50]
            .into_iter()
            .filter(|cap| *cap > 1)
        {
            let all = ids(attacks);
            let uncapped = built(build(
                copies(attacks, &sword()?),
                vec![with_id("r", every(&refs(&all), None, None, rs(3.0, 6.0)?))],
            ))?;
            let capped = built(build(
                copies(attacks, &sword()?),
                vec![with_id(
                    "r",
                    every(&refs(&all), Some(max as f64), None, rs(3.0, 6.0)?),
                )],
            ))?;
            assert!(
                capped.counter_max.is_empty(),
                "{attacks} attacks, max {max}"
            );
            assert_eq!(
                shape(&capped),
                shape(&uncapped),
                "{attacks} attacks, max {max}"
            );
        }
    }
    Ok(())
}

#[test]
fn a_cap_below_the_watched_steps_binds() -> T {
    for attacks in 3..=4usize {
        let all = ids(attacks);
        let plan = built(build(
            copies(attacks, &sword()?),
            vec![every(&refs(&all), Some((attacks - 1) as f64), None, d6())],
        ))?;
        assert_eq!(plan.counter_max, vec![(attacks - 1) as f64]);
    }
    Ok(())
}

#[test]
fn max_1_is_the_same_rider_in_a_spec() -> T {
    let all = ids(2);
    let first_rider = built(build(
        copies(2, &sword()?),
        vec![first(&refs(&all), None, d10())],
    ))?;
    let capped = built(build(
        copies(2, &sword()?),
        vec![every(&refs(&all), Some(1.0), None, d10())],
    ))?;
    // A first hit is a step with a fire slot; the capped rider folds into its sources' draws.
    // Their observable difference is only the representation: both give one rider that applies
    // at most once, and the same two attack rows.
    assert_eq!(first_rider.attack_ids, capped.attack_ids);
    assert_eq!(first_rider.rider_ids, capped.rider_ids);
    Ok(())
}

#[test]
fn is_a_first_hit_payload_per_source_with_max_1() -> T {
    let spec_rider = with_id(
        "folded",
        first(
            &["attack 1", "attack 2", "attack 3"],
            Some(per(vec![("attack 2", pl(d10()))])),
            d6(),
        ),
    );
    let plan = built(build(
        attacks_of(vec![sword()?, knife()?, sword()?]),
        vec![spec_rider],
    ))?;
    // Folded into its sources' draws: no step of its own, a fire slot, one counter of cap 1.
    assert_eq!(step_ids(&plan), vec!["attack 1", "attack 2", "attack 3"]);
    assert_eq!(plan.fire_slots.get("folded"), Some(&0));
    assert_eq!(plan.counter_max, vec![1.0]);
    assert!(plan.every_hit_ids.is_empty());
    Ok(())
}

#[test]
fn a_payload_per_source_without_a_cap_works_for_every_hit() -> T {
    let spec_rider = with_id(
        "mark",
        every(
            &["attack 1", "attack 2"],
            None,
            Some(per(vec![("attack 2", pl(d10()))])),
            d6(),
        ),
    );
    let plan = built(build(
        attacks_of(vec![sword()?, knife()?]),
        vec![spec_rider],
    ))?;
    assert!(plan.counter_max.is_empty());
    assert_eq!(plan.every_hit_ids, vec!["mark"]);
    Ok(())
}

/// A ten-link bounce chain beside a capped rider and a per-source first hit: more source sets
/// than `MAX_TRIGGER_GROUPS`, so the plan shares slots between groups whose lives do not overlap.
#[test]
fn really_shares_slots() -> T {
    use crate::turn::types::MAX_TRIGGER_GROUPS;
    let links = 10;
    let cap_beams = [0usize, 2, 3, 5, 6, 8, 10];
    let cap_ids: Vec<String> = cap_beams
        .iter()
        .map(|beam| {
            if *beam == 0 {
                "attack 1".to_string()
            } else {
                format!("bounce {beam}")
            }
        })
        .collect();
    let first_ids = ["bounce 3", "bounce 4", "bounce 9"];
    let mut s = bounce_spec(orb()?, links);
    let mut riders = s.riders.take().unwrap_or_default();
    riders.push(with_id(
        "dice",
        every(&refs(&cap_ids), Some(2.0), None, d6()),
    ));
    riders.push(with_id(
        "first",
        first(
            &first_ids,
            Some(per(vec![
                ("bounce 4", pl(d10())),
                (
                    "bounce 9",
                    RiderPayload {
                        damage: RiderDamage::One(flat1(7.0)?.into()),
                        crit_damage: Some(RiderDamage::One(flat1(20.0)?.into())),
                    },
                ),
            ])),
            d4(),
        ),
    ));
    s.riders = Some(riders);
    let plan = built(plan_of(&s))?;
    let source_sets = plan
        .rider_ids
        .iter()
        .filter(|id| id.starts_with("bounce"))
        .count()
        + 1;
    assert!(source_sets > MAX_TRIGGER_GROUPS);
    assert!(plan.group_count <= MAX_TRIGGER_GROUPS);
    // The cap of 2 and the per-source first hit (cap 1) are each one counter.
    assert_eq!(plan.counter_max, vec![2.0, 1.0]);
    Ok(())
}

// --- dice-match and bounce -------------------------------------------------------------------

/// `bounce({ source, max })`: one attack and `max` dice-match riders, each reading the one before.
fn bounce_spec(source: AttackBuilder, max: usize) -> TurnSpec {
    let mut previous = "attack 1".to_string();
    let mut riders = Vec::new();
    for i in 0..max {
        let id = format!("bounce {}", i + 1);
        riders.push(rider_id(
            &id,
            dice_match(&[previous.as_str()]),
            source.clone(),
        ));
        previous = id;
    }
    spec(vec![bare(source)], riders)
}

#[test]
fn expands_to_a_first_attack_plus_max_attack_shaped_dice_match_riders() -> T {
    let plan = built(plan_of(&bounce_spec(orb()?, 2)))?;
    assert_eq!(plan.attack_ids, vec!["attack 1"]);
    assert_eq!(plan.rider_ids, vec!["bounce 1", "bounce 2"]);
    Ok(())
}

#[test]
fn max_0_is_just_the_first_beam_no_riders() -> T {
    let plan = built(plan_of(&bounce_spec(orb()?, 0)))?;
    assert!(plan.rider_ids.is_empty());
    Ok(())
}

#[test]
fn a_chain_longer_than_the_trigger_group_budget_resolves_a_beams_group_dies_after_its_one_reader()
-> T {
    use crate::turn::types::MAX_TRIGGER_GROUPS;
    let plan = built(plan_of(&bounce_spec(orb()?, MAX_TRIGGER_GROUPS + 1)))?;
    assert_eq!(plan.rider_ids.len(), MAX_TRIGGER_GROUPS + 1);
    assert_eq!(plan.group_count, 2);
    let at_budget = built(plan_of(&bounce_spec(orb()?, MAX_TRIGGER_GROUPS)))?;
    assert_eq!(at_budget.rider_ids.len(), MAX_TRIGGER_GROUPS);
    Ok(())
}

#[test]
fn naming_a_bare_pmf_source_is_a_no_dice_descriptor_turn_spec_error() -> T {
    let bare_pmf = orb()?.to_pmf(crate::EPS)?;
    let result = build(
        vec![bare(Source::from(bare_pmf))],
        vec![rider(dice_match(&["attack 1"]), orb()?)],
    );
    assert_spec_error(
        result,
        Code::NoDiceDescriptor,
        Some("attack 1"),
        Some("a bare PMF, a string-parsed expression"),
    );
    Ok(())
}

#[test]
fn a_one_die_hit_pool_with_a_matchable_auto_doubled_crit_pool_does_not_throw() -> T {
    let one_die = attack_of(5.0, 17.0, rs(1.0, 8.0)?)?;
    let result = build(
        vec![bare(one_die)],
        vec![rider(dice_match(&["attack 1"]), orb()?)],
    );
    assert!(result.is_ok(), "{:?}", result.err());
    Ok(())
}

#[test]
fn a_turn_with_no_dice_match_trigger_never_computes_match_info() -> T {
    let plan = built(build(
        vec![bare(orb()?)],
        vec![first(&["attack 1"], None, rs(1.0, 8.0)?)],
    ))?;
    assert!(
        plan.steps
            .iter()
            .all(|s| s.id != "attack 1" || !s.variants.is_empty())
    );
    Ok(())
}

/// A pool that is not a plain sum of faces has no dice-match descriptor, so a rider on it is
/// refused instead of reading the wrong match odds.
#[test]
fn bounce_on_a_pool_that_is_not_a_plain_sum_of_faces_is_refused() -> T {
    let exploding = attack_of(5.0, 17.0, rs(3.0, 8.0)?.explode(1.0)?)?;
    let advantaged = attack_of(5.0, 17.0, rs(3.0, 8.0)?.with_advantage()?)?.no_crit()?;
    let subtracted = attack_of(5.0, 17.0, flat1(30.0)?.minus_roll(&rs(3.0, 8.0)?)?)?;
    for (name, attack) in [
        ("an exploding pool", exploding),
        ("an advantaged pool", advantaged),
        ("a subtracted pool", subtracted),
    ] {
        let result = plan_of(&bounce_spec(attack, 1));
        assert_eq!(code_of(result), Code::NoDiceDescriptor, "{name}");
    }
    // A plain pool still has one.
    assert!(plan_of(&bounce_spec(orb()?, 1)).is_ok());
    Ok(())
}

#[test]
fn a_bounce_chains_error_carries_the_reason_of_the_branch_it_needed() -> T {
    let exploding = attack_of(5.0, 15.0, rs(3.0, 8.0)?.explode(1.0)?)?;
    let error = refusal(plan_of(&bounce_spec(exploding, 1)));
    assert_eq!(error.code, Code::NoDiceDescriptor);
    assert!(
        error
            .message
            .contains("(hit and crit: the damage explodes, so extra dice"),
        "{}",
        error.message
    );
    Ok(())
}

#[test]
fn dice_of_different_kinds_are_not_a_pool_to_match_and_a_bounce_chain_says_why() -> T {
    let mixed = [
        (
            rs(2.0, 8.0)?.plus_roll(&rs(1.0, 6.0)?)?,
            "different kinds (d8 and d6)",
        ),
        (
            rs(2.0, 8.0)?.reroll(1.0)?.plus_roll(&rs(1.0, 8.0)?)?,
            "different kinds (d8 reroll 1 and d8)",
        ),
    ];
    for (payload, message) in mixed {
        let attack = attack_of(5.0, 15.0, payload)?;
        let error = refusal(plan_of(&bounce_spec(attack, 1)));
        assert_eq!(error.code, Code::NoDiceDescriptor);
        assert!(error.message.contains(message), "{}", error.message);
    }
    Ok(())
}

#[test]
fn a_source_that_cannot_say_why_keeps_the_generic_message() -> T {
    let bare_pmf = attack_of(5.0, 15.0, rs(3.0, 8.0)?)?.to_pmf(crate::EPS)?;
    let error = refusal(build(
        vec![bare(Source::from(bare_pmf))],
        vec![rider(dice_match(&["attack 1"]), d6())],
    ));
    assert_eq!(error.code, Code::NoDiceDescriptor);
    assert!(
        error
            .message
            .contains("a bare PMF, a string-parsed expression")
    );
    Ok(())
}

// --- save rows: a landing kind ---------------------------------------------------------------

/// `d20.dc(13).onSaveFailure(d4.plus(-1)).saveHalf()`.
fn half_save() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    use crate::builder::roll::Arg;
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(d4().plus(-1.0)?)])?
        .save_half()
}

/// `d20.plus(3).dc(15).onSaveFailure(roll(8, d6)).saveHalf()`.
fn fireball() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    use crate::builder::roll::Arg;
    d20()
        .plus(3.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()
}

#[test]
fn a_save_row_with_a_landing_kind_is_still_refused_without_one_capped_or_not() -> T {
    for max in [1.0, 2.0] {
        let result = build(
            vec![bare(sword()?), bare(half_save()?)],
            vec![every(&["attack 1", "attack 2"], Some(max), None, d6())],
        );
        assert_spec_error(
            result,
            Code::NotAnAttack,
            Some("attack 2"),
            Some("It is a save: a rider can watch a save row by declaring `landing`"),
        );
    }
    Ok(())
}

#[test]
fn damage_and_fail_over_one_row_are_different_counters() -> T {
    use crate::turn::types::{RiderLanding, SaveLanding};
    let rows = || -> Result<Vec<Attack>, DiceError> {
        Ok(vec![bare(sword()?), bare(half_save()?), bare(sword()?)])
    };
    let all = ["attack 1", "attack 2", "attack 3"];
    let landed = |landing: SaveLanding, id: &str| -> Result<Rider, DiceError> {
        Ok(Rider {
            landing: Some(RiderLanding::Save(landing)),
            ..with_id(id, every(&all, Some(2.0), None, d6()))
        })
    };
    let two = built(build(
        rows()?,
        vec![
            landed(SaveLanding::Damage, "dmg")?,
            landed(SaveLanding::Fail, "fail")?,
        ],
    ))?;
    assert_eq!(two.counter_max, vec![2.0, 2.0]);
    let one = built(build(
        rows()?,
        vec![
            landed(SaveLanding::Fail, "a")?,
            landed(SaveLanding::Fail, "b")?,
        ],
    ))?;
    assert_eq!(one.counter_max, vec![2.0]);
    Ok(())
}

// --- first-miss and any-miss rerolls: where the reroll sits in the turn ----------------------

fn tagged(tag: &str, source: impl Into<Source>) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            tag: Some(tag.to_string()),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

/// The O16 turn: two muskets, two unarmed strikes, a reroll of the first missed musket, and a
/// `1d10` first hit over the muskets and the reroll (and the unarmed strikes where asked).
fn o16(first_miss_reroll: bool, watches_unarmed: bool) -> Result<TurnPlan, DiceError> {
    let musket = attack_of(9.0, 15.0, d12().plus(18.0)?)?;
    let unarmed = attack_of(11.0, 15.0, d10().plus(5.0)?)?;
    let attacks = vec![
        tagged("musket", musket.clone()),
        tagged("musket", musket.clone()),
        tagged("unarmed", unarmed.clone()),
        tagged("unarmed", unarmed),
    ];
    let trigger = if first_miss_reroll {
        first_miss(Some(&["musket"]))
    } else {
        any_miss(Some(&["musket"]))
    };
    let reroll = rider_id("reroll", trigger, musket);
    let watched: &[&str] = if watches_unarmed {
        &["musket", "reroll", "unarmed"]
    } else {
        &["musket", "reroll"]
    };
    let watcher = first(watched, None, rs(1.0, 10.0)?);
    built(build(attacks, vec![reroll, watcher]))
}

#[test]
fn any_miss_resolves_after_every_declared_attack() -> T {
    let plan = o16(false, false)?;
    assert_eq!(
        step_ids(&plan),
        vec![
            "attack 1", "attack 2", "attack 3", "attack 4", "reroll", "rider 2"
        ]
    );
    Ok(())
}

#[test]
fn first_miss_resolves_directly_after_each_step_it_watches() -> T {
    let plan = o16(true, false)?;
    assert_eq!(
        step_ids(&plan),
        vec![
            "attack 1", "reroll", "attack 2", "reroll", "attack 3", "attack 4", "rider 2"
        ]
    );
    // One fire slot for the reroll, shared by its two steps.
    assert_eq!(plan.fire_slots.get("reroll"), Some(&0));
    assert_eq!(plan.fire_slots.get("rider 2"), Some(&1));
    Ok(())
}

#[test]
fn an_attack_shaped_reroll_joins_later_defaulted_of_sets() -> T {
    let two = || attacks_of(vec![sword().expect("builder"), sword().expect("builder")]);
    let reroll = |trigger: Trigger| -> Result<Rider, DiceError> {
        Ok(rider_id("reroll", trigger, sword()?))
    };
    let defaulted = |of: Option<Vec<String>>| Rider {
        trigger: Trigger::FirstHit {
            of,
            per_source: None,
        },
        ..rider(first_hit(None), rs(1.0, 10.0).expect("builder"))
    };
    // `rider_rows` lists declared attacks only: whether the reroll joined the default shows in the
    // group it advances (`Step::updates`).
    let reroll_updates = |plan: &TurnPlan| -> Vec<usize> {
        plan.steps
            .iter()
            .filter(|s| s.id == "reroll")
            .flat_map(|s| s.updates.clone())
            .collect()
    };
    for trigger in [first_miss(None), any_miss(None)] {
        let before = built(build(
            two(),
            vec![reroll(trigger.clone())?, defaulted(None)],
        ))?;
        assert!(!reroll_updates(&before).is_empty(), "{:?}", trigger.on());
        // Declared after the rider, it is not in its default.
        let after = built(build(
            two(),
            vec![defaulted(None), reroll(trigger.clone())?],
        ))?;
        assert!(reroll_updates(&after).is_empty(), "{:?}", trigger.on());
        // Pinned to the attacks it saw.
        let excluded = built(build(
            two(),
            vec![
                reroll(trigger)?,
                defaulted(Some(vec!["attack 1".to_string(), "attack 2".to_string()])),
            ],
        ))?;
        assert!(reroll_updates(&excluded).is_empty());
    }
    Ok(())
}

#[test]
fn a_damage_shaped_any_miss_rider_never_joins() -> T {
    let plan = built(build(
        attacks_of(vec![sword()?, sword()?]),
        vec![
            with_id("consolation", rider(any_miss(None), rs(1.0, 6.0)?)),
            with_id("r", rider(first_hit(None), rs(1.0, 10.0)?)),
        ],
    ))?;
    assert_eq!(
        plan.rider_rows.get("r"),
        Some(&vec!["attack 1".to_string(), "attack 2".to_string()])
    );
    Ok(())
}

#[test]
fn a_tag_expands_to_every_attack_carrying_it_an_unknown_tag_is_unknown_id() -> T {
    let plan = built(build(
        vec![
            tagged("blade", sword()?),
            bare(knife()?),
            tagged("blade", sword()?),
            tagged("blade", sword()?),
        ],
        vec![first(&["blade"], None, rs(3.0, 6.0)?)],
    ))?;
    assert_eq!(
        plan.rider_rows.get("rider 1"),
        Some(&vec![
            "attack 1".to_string(),
            "attack 3".to_string(),
            "attack 4".to_string()
        ])
    );
    let result = build(
        vec![tagged("blade", sword()?)],
        vec![first(&["hammer"], None, d6())],
    );
    assert_eq!(code_of(result), Code::UnknownId);
    Ok(())
}

#[test]
fn a_rider_pinned_to_the_attacks_it_saw_ignores_a_later_attack() -> T {
    let plan = built(build(
        attacks_of(vec![sword()?, knife()?]),
        vec![first(&["attack 1"], None, rs(3.0, 6.0)?)],
    ))?;
    assert_eq!(
        plan.rider_rows.get("rider 1"),
        Some(&vec!["attack 1".to_string()])
    );
    let defaulted = built(build(
        attacks_of(vec![sword()?, knife()?]),
        vec![rider(first_hit(None), rs(3.0, 6.0)?)],
    ))?;
    assert_eq!(
        defaulted.rider_rows.get("rider 1"),
        Some(&vec!["attack 1".to_string(), "attack 2".to_string()])
    );
    Ok(())
}

// --- substitutes -----------------------------------------------------------------------------

fn keep(id: Option<&str>, of: Option<&[&str]>, policy: Option<SubstitutePolicy>) -> SubstituteSpec {
    SubstituteSpec {
        id: id.map(str::to_string),
        on: SubstituteOn::FirstHit,
        of: of.map(|list| list.iter().map(std::string::ToString::to_string).collect()),
        substitute: SubstituteKind::RerollKeepHigher,
        mode: None,
        policy,
    }
}

fn missed(
    id: &str,
    substitute: SubstituteKind,
    mode: Option<crate::builder::types::MissRerollMode>,
    policy: Option<SubstitutePolicy>,
) -> SubstituteSpec {
    SubstituteSpec {
        id: Some(id.to_string()),
        on: SubstituteOn::FirstMiss,
        of: None,
        substitute,
        mode,
        policy,
    }
}

fn with_subs(
    attacks: Vec<Attack>,
    riders: Vec<Rider>,
    substitutes: Vec<SubstituteSpec>,
) -> TurnSpec {
    TurnSpec {
        attacks,
        riders: if riders.is_empty() {
            None
        } else {
            Some(riders)
        },
        substitutes: Some(substitutes),
        ..TurnSpec::default()
    }
}

/// `d20.plus(5).ac(12).onHit(roll(2, d6).plus(3))` twice.
fn o20() -> Result<Vec<Attack>, DiceError> {
    let attack = attack_of(5.0, 12.0, rs(2.0, 6.0)?.plus(3.0)?)?;
    Ok(vec![bare(attack.clone()), bare(attack)])
}

#[test]
fn a_substitute_is_a_fire_slot_with_an_id_of_its_own() -> T {
    let plan = built(plan_of(&with_subs(
        o20()?,
        vec![],
        vec![keep(Some("reroll"), Some(&["attack 1", "attack 2"]), None)],
    )))?;
    assert_eq!(plan.substitute_ids, vec!["reroll"]);
    assert_eq!(plan.fire_slots.get("reroll"), Some(&0));
    Ok(())
}

#[test]
fn allocates_no_trigger_group() -> T {
    let of = &["attack 1", "attack 2"];
    let group_count = |riders: Vec<Rider>, subs: Vec<SubstituteSpec>| -> Result<usize, DiceError> {
        Ok(built(plan_of(&with_subs(o20()?, riders, subs)))?.group_count)
    };
    assert_eq!(group_count(vec![], vec![])?, 0);
    assert_eq!(group_count(vec![], vec![keep(None, Some(of), None)])?, 0);
    let rider3 = || first(of, None, rs(3.0, 6.0).expect("builder"));
    assert_eq!(group_count(vec![rider3()], vec![])?, 1);
    assert_eq!(
        group_count(vec![rider3()], vec![keep(None, Some(of), None)])?,
        1
    );
    Ok(())
}

#[test]
fn disjoint_of_sets_are_legal_each_substitute_fires_once_on_its_own_attack() -> T {
    let plan = built(plan_of(&with_subs(
        o20()?,
        vec![],
        vec![
            keep(Some("first"), Some(&["attack 1"]), None),
            keep(Some("second"), Some(&["attack 2"]), None),
        ],
    )))?;
    assert_eq!(plan.substitute_ids, vec!["first", "second"]);
    Ok(())
}

#[test]
fn two_substitutes_over_overlapping_of_are_duplicate_substitute() -> T {
    let of = &["attack 1", "attack 2"];
    let both = plan_of(&with_subs(
        o20()?,
        vec![],
        vec![keep(None, Some(of), None), keep(None, Some(of), None)],
    ));
    assert_eq!(code_of(both), Code::DuplicateSubstitute);
    let overlapping = plan_of(&with_subs(
        o20()?,
        vec![],
        vec![
            keep(None, Some(&["attack 1"]), None),
            keep(None, Some(of), None),
        ],
    ));
    assert_eq!(code_of(overlapping), Code::DuplicateSubstitute);
    Ok(())
}

#[test]
fn optimally_is_unsupported_policy_from_plain_data() -> T {
    let result = plan_of(&with_subs(
        o20()?,
        vec![],
        vec![keep(None, None, Some(SubstitutePolicy::Optimal))],
    ));
    assert_eq!(code_of(result), Code::UnsupportedPolicy);
    Ok(())
}

#[test]
fn an_of_naming_nothing_in_the_turn_is_unknown_id_naming_a_save_is_not_an_attack() -> T {
    let nope = plan_of(&with_subs(
        o20()?,
        vec![],
        vec![keep(None, Some(&["nope"]), None)],
    ));
    assert_eq!(code_of(nope), Code::UnknownId);
    // A save-shaped rider named in `of` has no hit/crit outcomes: `not-an-attack`, not `unknown-id`.
    let poison = with_id(
        "poison",
        rider(first_hit(Some(&["attack 1", "attack 2"])), half_save()?),
    );
    let result = plan_of(&with_subs(
        o20()?,
        vec![poison],
        vec![keep(None, Some(&["poison"]), None)],
    ));
    assert_eq!(code_of(result), Code::NotAnAttack);
    Ok(())
}

#[test]
fn a_threshold_substitute_beside_a_first_miss_reroll_it_watches_builds() -> T {
    let attack = attack_of(5.0, 12.0, rs(2.0, 6.0)?.plus(3.0)?)?;
    for policy in [
        SubstitutePolicy::Below {
            hit: 10.0,
            crit: 18.0,
        },
        SubstitutePolicy::Below {
            hit: 1.0,
            crit: 1.0,
        },
    ] {
        let plan = built(plan_of(&with_subs(
            attacks_of(vec![attack.clone(), attack.clone()]),
            vec![
                with_id("reroll", rider(first_miss(None), attack.clone())),
                with_id(
                    "rider 2",
                    first(&["attack 1", "attack 2", "reroll"], None, d6()),
                ),
            ],
            vec![keep(
                Some("r"),
                Some(&["attack 1", "attack 2", "reroll"]),
                Some(policy),
            )],
        )))?;
        assert_eq!(plan.substitute_ids, vec!["r"]);
        // The policy reaches the watched rows' steps.
        let policies: Vec<_> = plan.steps.iter().filter_map(|s| s.policy).collect();
        assert!(policies.contains(&policy), "{policies:?}");
    }
    Ok(())
}

// --- first-miss rerolls and conversions: refusals --------------------------------------------

fn r7() -> Result<AttackBuilder, DiceError> {
    attack_of(7.0, 16.0, d8().plus(4.0)?)
}

fn rows_ab() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![attack_id("a", r7()?), attack_id("b", r7()?)])
}

fn code_of_subs(subs: Vec<SubstituteSpec>) -> Result<Option<Code>, DiceError> {
    Ok(match plan_of(&with_subs(rows_ab()?, vec![], subs)) {
        Ok(_) => None,
        Err(DiceError::TurnSpec(e)) => Some(e.code),
        Err(other) => return Err(DiceError::error(format!("{other:?}"))),
    })
}

#[test]
fn a_hit_conversion_beside_a_reroll_and_two_first_hit_transforms_share_a_source_duplicate_substitute()
-> T {
    use crate::builder::types::MissRerollMode;
    let hit = |id: &str| missed(id, SubstituteKind::Hit, None, None);
    let reroll = |id: &str| {
        missed(
            id,
            SubstituteKind::Reroll,
            Some(MissRerollMode::Reroll),
            None,
        )
    };
    let _ = reroll;
    let dup = Some(Code::DuplicateSubstitute);
    assert_eq!(
        code_of_subs(vec![
            hit("c"),
            missed("r", SubstituteKind::Reroll, None, None)
        ])?,
        dup
    );
    assert_eq!(
        code_of_subs(vec![
            missed("r", SubstituteKind::Reroll, None, None),
            hit("c")
        ])?,
        dup
    );
    assert_eq!(
        code_of_subs(vec![
            keep(Some("k1"), None, None),
            keep(Some("k2"), None, None)
        ])?,
        dup
    );
    assert_eq!(code_of_subs(vec![hit("c1"), hit("c2")])?, dup);
    Ok(())
}

#[test]
fn allows_several_rerolls_and_one_always_keep_higher_on_one_source() -> T {
    use crate::builder::types::MissRerollMode;
    assert_eq!(
        code_of_subs(vec![
            missed("r1", SubstituteKind::Reroll, None, None),
            missed(
                "r2",
                SubstituteKind::Reroll,
                Some(MissRerollMode::AddD20),
                None
            ),
            keep(Some("k"), None, Some(SubstitutePolicy::Always)),
        ])?,
        None
    );
    Ok(())
}

#[test]
fn a_below_policy_beside_a_reroll_is_unsupported_policy() -> T {
    let below = SubstitutePolicy::Below {
        hit: 8.0,
        crit: 16.0,
    };
    assert_eq!(
        code_of_subs(vec![
            missed("r", SubstituteKind::Reroll, None, None),
            keep(Some("k"), None, Some(below)),
        ])?,
        Some(Code::UnsupportedPolicy)
    );
    Ok(())
}

#[test]
fn a_policy_on_a_reroll_is_unsupported_policy() -> T {
    assert_eq!(
        code_of_subs(vec![missed(
            "r",
            SubstituteKind::Reroll,
            None,
            Some(SubstitutePolicy::Always)
        )])?,
        Some(Code::UnsupportedPolicy)
    );
    Ok(())
}

#[test]
fn a_mode_on_another_substitute_is_unsupported_trigger() -> T {
    use crate::builder::types::MissRerollMode;
    let mode = Some(MissRerollMode::Reroll);
    let on_keep = SubstituteSpec {
        mode,
        ..keep(Some("k"), None, None)
    };
    assert_eq!(code_of_subs(vec![on_keep])?, Some(Code::UnsupportedTrigger));
    assert_eq!(
        code_of_subs(vec![missed("c", SubstituteKind::Hit, mode, None)])?,
        Some(Code::UnsupportedTrigger)
    );
    // A reroll on first-hit.
    let wrong_on = SubstituteSpec {
        on: SubstituteOn::FirstHit,
        ..missed("r", SubstituteKind::Reroll, None, None)
    };
    assert_eq!(
        code_of_subs(vec![wrong_on])?,
        Some(Code::UnsupportedTrigger)
    );
    Ok(())
}

#[test]
fn a_reroll_watching_a_row_that_rolls_no_attack_is_not_an_attack() -> T {
    let result = plan_of(&with_subs(
        vec![bare(fireball()?)],
        vec![],
        vec![missed("r", SubstituteKind::Reroll, None, None)],
    ));
    assert_eq!(code_of(result), Code::NotAnAttack);
    Ok(())
}

#[test]
fn a_reroll_watching_a_row_an_attack_shaped_first_miss_rider_rerolls_is_refused() -> T {
    let result = plan_of(&with_subs(
        vec![bare(r7()?)],
        vec![with_id(
            "again",
            rider(first_miss(Some(&["attack 1"])), r7()?),
        )],
        vec![SubstituteSpec {
            of: Some(vec!["attack 1".to_string()]),
            ..missed("r", SubstituteKind::Reroll, None, None)
        }],
    ));
    assert_eq!(code_of(result), Code::UnsupportedTrigger);
    Ok(())
}

#[test]
fn a_row_whose_check_already_rerolls_its_misses_is_unsupported_trigger() -> T {
    use crate::builder::types::MissRerollMode;
    let lucky = r7()?.reroll_misses(MissRerollMode::Reroll)?;
    let result = plan_of(&with_subs(
        vec![bare(lucky), bare(r7()?)],
        vec![],
        vec![missed("r", SubstituteKind::Reroll, None, None)],
    ));
    assert_eq!(code_of(result), Code::UnsupportedTrigger);
    Ok(())
}

// --- convertFirstMiss ------------------------------------------------------------------------

#[test]
fn converting_a_save_row_is_not_an_attack() -> T {
    let result = plan_of(&with_subs(
        vec![bare(fireball()?)],
        vec![],
        vec![missed("c", SubstituteKind::Hit, None, None)],
    ));
    assert_eq!(code_of(result), Code::NotAnAttack);
    Ok(())
}

#[test]
fn a_conversion_over_a_row_a_first_miss_rider_rerolls_is_unsupported_trigger() -> T {
    let a = r7()?;
    let again = || {
        with_id(
            "reroll",
            rider(first_miss(Some(&["attack 1"])), r7().expect("builder")),
        )
    };
    let convert = |of: &[&str]| SubstituteSpec {
        of: Some(of.iter().map(std::string::ToString::to_string).collect()),
        ..missed("c", SubstituteKind::Hit, None, None)
    };
    let refused = plan_of(&with_subs(
        vec![bare(a.clone())],
        vec![again()],
        vec![convert(&["attack 1"])],
    ));
    assert_eq!(code_of(refused), Code::UnsupportedTrigger);
    // Over the first-miss reroll itself it is allowed.
    let allowed = plan_of(&with_subs(
        vec![bare(a.clone())],
        vec![again()],
        vec![convert(&["reroll"])],
    ));
    assert!(allowed.is_ok(), "{:?}", allowed.err());
    // An any-miss reroll resolves after every attack: it cannot be converted.
    let any = with_id(
        "reroll",
        rider(any_miss(Some(&["attack 1", "attack 2"])), r7()?),
    );
    let any_refused = plan_of(&with_subs(
        attacks_of(vec![a.clone(), r7()?]),
        vec![any],
        vec![convert(&["reroll"])],
    ));
    assert_eq!(code_of(any_refused), Code::UnsupportedTrigger);
    Ok(())
}

#[test]
fn a_hit_conversion_with_a_policy_is_unsupported_policy() -> T {
    let result = plan_of(&with_subs(
        vec![bare(r7()?)],
        vec![],
        vec![SubstituteSpec {
            id: None,
            ..missed(
                "c",
                SubstituteKind::Hit,
                None,
                Some(SubstitutePolicy::Always),
            )
        }],
    ));
    assert_eq!(code_of(result), Code::UnsupportedPolicy);
    Ok(())
}

#[test]
fn two_conversions_are_duplicate_substitute() -> T {
    let result = plan_of(&with_subs(
        vec![bare(r7()?)],
        vec![],
        vec![
            missed("c1", SubstituteKind::Hit, None, None),
            missed("c2", SubstituteKind::Hit, None, None),
        ],
    ));
    assert_eq!(code_of(result), Code::DuplicateSubstitute);
    Ok(())
}

#[test]
fn a_conversion_is_a_substitute_over_the_rows_it_names() -> T {
    let plan = built(plan_of(&with_subs(
        vec![attack_id("row:0", r7()?), attack_id("row:1", r7()?)],
        vec![],
        vec![SubstituteSpec {
            of: Some(vec!["row:0".to_string()]),
            ..missed("convert", SubstituteKind::Hit, None, None)
        }],
    )))?;
    assert_eq!(plan.substitute_ids, vec!["convert"]);
    let converting: Vec<&str> = plan
        .steps
        .iter()
        .filter(|s| s.converts)
        .map(|s| s.id.as_str())
        .collect();
    assert_eq!(converting, vec!["row:0"]);
    Ok(())
}

// --- rerolledUnder ---------------------------------------------------------------------------

use crate::builder::types::MissRerollMode;
use crate::turn::context::{ContextualSource, RowCheck, RowContext};
use crate::turn::types::ArcContextual;
use std::sync::atomic::{AtomicBool, Ordering};

/// A row that says what its reroll rolls (`rerolledUnder`): `under` is a sword's, the reroll the
/// same sword with the better of two damage dice. Records whether the reroll was ever asked.
struct Rerolling {
    inner: AttackBuilder,
    asked: Arc<AtomicBool>,
    says_reroll: bool,
}

impl ContextualSource for Rerolling {
    fn row_check(&self) -> RowCheck {
        ContextualSource::row_check(&self.inner)
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        ContextualSource::under(&self.inner, context, eps)
    }
    fn has_rerolled_under(&self) -> bool {
        self.says_reroll
    }
    fn rerolled_under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.asked.store(true, Ordering::SeqCst);
        ContextualSource::under(&self.inner, context, eps)
    }
}

fn rerolling(says_reroll: bool) -> Result<(Source, Arc<AtomicBool>), DiceError> {
    let asked = Arc::new(AtomicBool::new(false));
    let row = Rerolling {
        inner: r7()?,
        asked: asked.clone(),
        says_reroll,
    };
    Ok((Source::Contextual(ArcContextual(Arc::new(row))), asked))
}

#[test]
fn a_below_policy_over_a_source_with_rerolled_under_is_unsupported_policy() -> T {
    let below = SubstitutePolicy::Below {
        hit: 8.0,
        crit: 16.0,
    };
    let (pool, _) = rerolling(true)?;
    let refused = plan_of(&with_subs(
        vec![attack_id("a", pool)],
        vec![],
        vec![keep(Some("savage"), None, Some(below))],
    ));
    assert_eq!(code_of(refused), Code::UnsupportedPolicy);
    // The same policy over a source that does not say stays as it was.
    let (plain, _) = rerolling(false)?;
    let accepted = plan_of(&with_subs(
        vec![attack_id("a", plain)],
        vec![],
        vec![keep(Some("savage"), None, Some(below))],
    ));
    assert!(accepted.is_ok(), "{:?}", accepted.err());
    Ok(())
}

#[test]
fn rerolled_under_is_never_asked_without_a_substitute_over_the_row() -> T {
    let (loud, asked) = rerolling(true)?;
    let plan = built(plan_of(&spec(vec![attack_id("a", loud)], vec![])))?;
    assert_eq!(plan.attack_ids, vec!["a"]);
    assert!(!asked.load(Ordering::SeqCst));
    Ok(())
}

#[test]
fn a_source_with_neither_roll_under_nor_miss_rerolled_under_is_refused() -> T {
    let (row, _) = rerolling(false)?;
    let result = plan_of(&with_subs(
        vec![attack_id("a", row)],
        vec![],
        vec![missed("luck", SubstituteKind::Reroll, None, None)],
    ));
    // Raised where the rerolled miss is priced: at build, or in the first block a walk builds.
    match result {
        Err(DiceError::TurnSpec(e)) => assert_eq!(e.code, Code::NoRebindableSource),
        other => panic!("expected no-rebindable-source, got {:?}", other.map(|_| ())),
    }
    let _ = MissRerollMode::Reroll;
    Ok(())
}

// --- draws ------------------------------------------------------------------------------------

use crate::turn::state::StepOutcome;

/// `(outcome, spends, mass, applies, bumps, fires)` of a draw.
type Drawn = (StepOutcome, bool, f64, Vec<usize>, Vec<usize>, Vec<usize>);

/// That of every draw of variant `variant` of `step`.
fn draws_of(plan: &TurnPlan, step: usize, variant: usize) -> Vec<Drawn> {
    let Some(block) = plan.steps.get(step).and_then(|s| s.variants.get(variant)) else {
        panic!("step {step} has no variant {variant}");
    };
    block
        .iter()
        .map(|d| {
            (
                d.outcome,
                d.spends,
                d.slice.mass(),
                d.applies.clone(),
                d.bumps.clone(),
                d.fires.clone(),
            )
        })
        .collect()
}

#[track_caller]
fn assert_mass(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
}

fn pick(plan: &TurnPlan, step: usize, fired: &[super::FireMode], counters: &[u32]) -> usize {
    let codes = vec![crate::turn::state::START_CODE; plan.group_last_read_step.len()];
    (plan.steps[step].select)(&codes, fired, 0, counters).expect("select")
}

/// The variant a walk in the state of `fired` and `counters` selects, built on first use.
fn pick_with(plan: &TurnPlan, step: usize, fired: &[super::FireMode], counters: &[u32]) -> usize {
    pick(plan, step, fired, counters)
}

/// What a draw is expected to be: outcome, spends, mass, applies, bumps, fires.
type Want<'a> = (
    StepOutcome,
    bool,
    f64,
    &'a [usize],
    &'a [usize],
    &'a [usize],
);

#[track_caller]
fn assert_draws(actual: &[Drawn], expected: &[Want]) {
    assert_eq!(actual.len(), expected.len(), "{actual:?}");
    for (got, want) in actual.iter().zip(expected) {
        assert_eq!((got.0, got.1), (want.0, want.1), "{actual:?}");
        assert_mass(got.2, want.2);
        assert_eq!(got.3, want.3, "applies");
        assert_eq!(got.4, want.4, "bumps");
        assert_eq!(got.5, want.5, "fires");
    }
}

use StepOutcome::{Crit, Hit, Miss};

/// d20+7 vs AC 15 for `d8+4`: hit 0.6, crit 0.05, miss 0.35; an uncapped every-hit rider is
/// applied on every hit and crit draw and not on a miss.
#[test]
fn an_uncapped_every_hit_rider_is_applied_on_hit_and_crit_draws_and_not_on_a_miss() -> T {
    let plan = built(build(
        vec![bare(sword()?)],
        vec![with_id("mark", every(&["attack 1"], None, None, d10()))],
    ))?;
    assert_draws(
        &draws_of(&plan, 0, 0),
        &[
            (Hit, false, 0.6, &[0], &[], &[]),
            (Crit, false, 0.05, &[0], &[], &[]),
            (Miss, false, 0.35, &[], &[], &[]),
        ],
    );
    Ok(())
}

/// A capped rider is folded only into the with-rider variant, picked while its counter is below
/// the cap: its draws apply the rider and bump the counter; at the cap the plain variant draws.
#[test]
fn a_capped_rider_folds_into_the_variant_a_state_below_the_cap_selects() -> T {
    let all = ids(3);
    let plan = built(build(
        copies(3, &sword()?),
        vec![every(&refs(&all), Some(2.0), None, d10())],
    ))?;
    let none = vec![None; plan.slot_count];
    for count in [0u32, 1] {
        let v = pick_with(&plan, 0, &none, &[count]);
        assert_eq!(v, 1);
        assert_draws(
            &draws_of(&plan, 0, v),
            &[
                (Hit, false, 0.6, &[0], &[0], &[]),
                (Crit, false, 0.05, &[0], &[0], &[]),
                (Miss, false, 0.35, &[], &[], &[]),
            ],
        );
    }
    let v = pick_with(&plan, 0, &none, &[2]);
    assert_eq!(v, 0);
    assert_draws(
        &draws_of(&plan, 0, v),
        &[
            (Hit, false, 0.6, &[], &[], &[]),
            (Crit, false, 0.05, &[], &[], &[]),
            (Miss, false, 0.35, &[], &[], &[]),
        ],
    );
    Ok(())
}

/// A rider that lands on anything (`landing: "any"`) is applied on a miss too.
#[test]
fn a_rider_that_lands_on_any_outcome_is_applied_on_a_miss() -> T {
    use crate::turn::types::RiderLanding;
    let any = Rider {
        landing: Some(RiderLanding::Any),
        ..with_id("any", every(&["attack 1"], None, None, d10()))
    };
    let plan = built(build(vec![bare(sword()?)], vec![any]))?;
    assert_draws(
        &draws_of(&plan, 0, 0),
        &[
            (Hit, false, 0.6, &[0], &[], &[]),
            (Crit, false, 0.05, &[0], &[], &[]),
            (Miss, false, 0.35, &[0], &[], &[]),
        ],
    );
    Ok(())
}

/// Under the `joint` folds a draw's slice has its riders' payloads convolved in (d8+4 plus d10 is
/// at most 22); under the `masses` folds it is the row's own part. Both keep the own part and the
/// riders.
#[test]
fn the_joint_fold_convolves_the_payload_and_the_masses_fold_keeps_the_own_part() -> T {
    let s = spec(
        vec![bare(sword()?)],
        vec![every(&["attack 1"], None, None, d10())],
    );
    let top = |pmf: &Pmf| pmf.support().iter().map(|d| d.0).fold(f64::MIN, f64::max);
    for (mode, slice_top) in [(FoldMode::Joint, 22.0), (FoldMode::Masses, 12.0)] {
        let plan = built(plan_with(&s, crate::EPS, &[], mode))?;
        let block = plan.steps[0].variants.get(0).ok_or("no plain variant")?;
        let hit = &block[0];
        assert_eq!(top(&hit.slice), slice_top, "{mode:?}");
        assert_eq!(hit.own.as_ref().map(|o| top(o)), Some(12.0), "{mode:?}");
        assert_eq!(hit.riders.as_ref().map(|r| r.len()), Some(1), "{mode:?}");
        assert_eq!(
            hit.riders.as_ref().map(|r| r[0].0.as_str()),
            Some("rider 1")
        );
        assert_mass(hit.slice.mass(), 0.6);
    }
    Ok(())
}

/// A first-hit rider with a payload per source is folded into its sources' draws: they carry its
/// fire slot and its counter's bump, and the plan has no step of its own for it.
#[test]
fn a_per_source_first_hit_marks_its_fire_slot_on_the_draws_that_apply_it() -> T {
    let folded = with_id(
        "folded",
        first(
            &["attack 1", "attack 2"],
            Some(per(vec![("attack 2", pl(d10()))])),
            d6(),
        ),
    );
    let plan = built(build(attacks_of(vec![sword()?, knife()?]), vec![folded]))?;
    assert_eq!(step_ids(&plan), vec!["attack 1", "attack 2"]);
    let none = vec![None; plan.slot_count];
    for (step, hit) in [(0usize, 0.6), (1, 0.55)] {
        let v = pick_with(&plan, step, &none, &[0]);
        let draws = draws_of(&plan, step, v);
        assert_eq!(draws.len(), 3);
        assert_mass(draws[0].2, hit);
        for draw in &draws[..2] {
            assert_eq!(draw.4, vec![0], "bumps");
            assert_eq!(draw.5, vec![0], "fires");
        }
        assert!(draws[2].4.is_empty() && draws[2].5.is_empty());
        // Once its counter is spent, the plain variant draws nothing of it.
        let spent = pick_with(&plan, step, &none, &[1]);
        assert!(
            draws_of(&plan, step, spent)
                .iter()
                .all(|d| d.4.is_empty() && d.5.is_empty())
        );
    }
    Ok(())
}

/// An unspent `always` keep-higher substitute spends on a hit or crit draw (never on a miss);
/// once spent (its fire slot set) the plain variant draws.
#[test]
fn an_unspent_keep_higher_spends_on_a_landing_and_a_spent_one_draws_plain() -> T {
    let plan = built(plan_of(&with_subs(
        vec![bare(sword()?)],
        vec![],
        vec![keep(Some("k"), None, None)],
    )))?;
    let slot = *plan.fire_slots.get("k").ok_or("no slot")?;
    let mut fired = vec![None; plan.slot_count];
    let v = pick_with(&plan, 0, &fired, &[]);
    assert_draws(
        &draws_of(&plan, 0, v),
        &[
            (Hit, true, 0.6, &[], &[], &[]),
            (Crit, true, 0.05, &[], &[], &[]),
            (Miss, false, 0.35, &[], &[], &[]),
        ],
    );
    assert_eq!(plan.steps[0].spend_slot, Some(slot));
    fired[slot] = Some(super::Fire::Hit);
    let v = pick_with(&plan, 0, &fired, &[]);
    assert_eq!(v, 0);
    assert_draws(
        &draws_of(&plan, 0, v),
        &[
            (Hit, false, 0.6, &[], &[], &[]),
            (Crit, false, 0.05, &[], &[], &[]),
            (Miss, false, 0.35, &[], &[], &[]),
        ],
    );
    Ok(())
}

/// A hit conversion draws the first miss as the row's hit (mass 0.35, spending), a natural 20
/// still a crit; the converted row has no miss draw. Once spent, the plain variant draws.
#[test]
fn a_conversion_draws_the_miss_mass_as_a_spending_hit_and_no_miss() -> T {
    let convert = SubstituteSpec {
        of: None,
        ..missed("c", SubstituteKind::Hit, None, None)
    };
    let plan = built(plan_of(&with_subs(
        vec![bare(sword()?)],
        vec![],
        vec![convert],
    )))?;
    let slot = *plan.fire_slots.get("c").ok_or("no slot")?;
    assert!(plan.steps[0].converts);
    let mut fired = vec![None; plan.slot_count];
    let v = pick_with(&plan, 0, &fired, &[]);
    assert_draws(
        &draws_of(&plan, 0, v),
        &[
            (Hit, true, 0.35, &[], &[], &[]),
            (Hit, false, 0.6, &[], &[], &[]),
            (Crit, false, 0.05, &[], &[], &[]),
        ],
    );
    fired[slot] = Some(super::Fire::Hit);
    let v = pick_with(&plan, 0, &fired, &[]);
    assert_draws(
        &draws_of(&plan, 0, v),
        &[
            (Hit, false, 0.6, &[], &[], &[]),
            (Crit, false, 0.05, &[], &[], &[]),
            (Miss, false, 0.35, &[], &[], &[]),
        ],
    );
    Ok(())
}

/// The reroll a source says it rolls (`rerolledUnder`) is asked while the plan is built (the TS
/// `Turn` refuses a `rerolledUnder()` with no PMF at `onFirstHit`, before any walk): the spending
/// block of a substitute step is among the blocks built then.
#[test]
fn rerolled_under_is_asked_while_the_plan_with_a_substitute_is_built() -> T {
    let (row, asked) = rerolling(true)?;
    let plan = built(plan_of(&with_subs(
        vec![attack_id("a", row)],
        vec![],
        vec![keep(Some("savage"), None, None)],
    )))?;
    assert!(asked.load(Ordering::SeqCst));
    let fired = vec![None; plan.slot_count];
    let v = pick_with(&plan, 0, &fired, &[]);
    assert_eq!(v, 1);
    // d20+7 vs AC 16 for d8+4: hit 0.55, crit 0.05; the reroll is the row's own PMF here.
    let draws = draws_of(&plan, 0, v);
    assert_eq!(draws.len(), 3);
    assert!(draws[0].1 && draws[1].1 && !draws[2].1);
    assert_mass(draws[0].2, 0.55);
    assert_mass(draws[1].2, 0.05);
    assert_mass(draws[2].2, 0.4);
    Ok(())
}
