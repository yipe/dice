//! `tests/turn-port-readers.test.ts`: 17 of 37 tests (the other 20 are the two 10-family `FAMILIES` loops;
//! the three zeroed shapes are one Rust test), 0 compat calls (no fixture entries; the oracle numbers are asserted).
//!
//! Not translated: tests/turn-port-readers.test.ts:47-58 and 118-136: both loop over `FAMILIES`, the oracle
//! v2 case corpus (tests/oracle/v2/cases, spec builders in TS) which has no Rust port. The same two
//! properties (`mean()` is the sum of the marginal means; step flags fit the 30-bit key, never alias and
//! stay live until read) are checked here over the turn shapes this file builds
//! (`mean_is_the_sum_of_the_marginal_means_over_this_files_shapes`, `bit_placement_over_this_files_shapes`).
//! Not translated: tests/turn-port-readers.test.ts:244-281, 283-310: `vi.spyOn` on `PMF.prototype.convolve`,
//! `convolveRaw`, `add` and `DenseTotal.prototype.convolve` (a JS-only call spy; Rust has no counter on
//! the convolutions). The readers those two tests call are still called, without the spy assertions.

use super::hand_source::*;
use super::helpers::*;
use crate::builder::attack::{AttackBuilder, Grants};
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::common::RollType;
use crate::dnd5e::stunned;
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, TriggerSave, TriggerSaves, advantage,
    crit_on_hit,
};
use crate::turn::readers::EffectName;
use crate::turn::types::{
    Attack, AttackOptions, AttackTriggerOn, GrantUntil, Rider, RiderLanding, RiderOptions, Source,
    Trigger, TurnSpec,
};
use crate::turn::{SourceOdds, Turn, turn};

const TOLERANCE: f64 = 1e-12;

type R<X> = Result<X, Box<dyn std::error::Error>>;

fn ids_of(t: &Turn) -> Result<Vec<String>, DiceError> {
    let mut ids = t.attack_ids()?;
    ids.extend(t.rider_ids()?);
    Ok(ids)
}

fn marginal_mean(t: &Turn) -> Result<f64, DiceError> {
    let mut sum = 0.0;
    for id in ids_of(t)? {
        sum += t.marginal(&id)?.pmf().mean();
    }
    Ok(sum)
}

#[track_caller]
fn expect_same_pmf(actual: &Pmf, expected: &Pmf, label: &str) {
    let worst = pmf_max_diff(actual, expected);
    assert!(worst <= TOLERANCE, "{label}: {worst}");
}

/// `with` × p + `without` × (1 − p), value by value.
#[track_caller]
fn expect_mixture(actual: &Pmf, with_it: &Pmf, without: &Pmf, p: f64, label: &str) {
    let mut values: Vec<f64> = [actual, with_it, without]
        .iter()
        .flat_map(|pmf| pmf.support().into_iter().map(|d| d.0))
        .collect();
    values.sort_by(f64::total_cmp);
    values.dedup();
    for value in values {
        let want = p * with_it.p_at(value) + (1.0 - p) * without.p_at(value);
        let diff = (actual.p_at(value) - want).abs();
        assert!(diff <= TOLERANCE, "{label} at {value}: {diff}");
    }
}

fn sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

fn bow() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.ranged()?.on_hit(d8().plus(4.0)?)
}

fn fist() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(4.0)?)
}

fn swords(count: usize) -> Result<Vec<Attack>, DiceError> {
    (0..count).map(|_| Ok(atk(sword()?))).collect()
}

fn fists() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![atk(fist()?), atk(fist()?), atk(fist()?)])
}

fn next_attack() -> Grants {
    Grants::One(advantage().until_next_attack().into())
}

/// `{ id, save: d20.plus(bonus).dc(dc).ability("con") }` for a first-hit condition.
fn save_options(id: &str, bonus: f64, dc: f64) -> Result<FirstHitOptions, DiceError> {
    Ok(FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                id: Some(id.to_string()),
                ..RiderOptions::default()
            },
            save: Some(TriggerSaves::One(TriggerSave::Dc(
                d20().plus(bonus)?.dc(dc)?.ability("con")?,
            ))),
            ..ConditionOptions::default()
        },
        per_source: None,
    })
}

/// `turn([sword, other, sword]).onFirstHit(prone().untilEndOfTurn(), { id: "topple", save })`.
fn topple(other: &AttackBuilder) -> R<Turn> {
    let attacks = vec![atk(sword()?), atk(other.clone()), atk(sword()?)];
    Ok(turn(attacks, 0.0)?.on_first_hit_with(
        crate::dnd5e::prone().until_end_of_turn(),
        save_options("topple", 3.0, 15.0)?,
    )?)
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn sneak_and_capped(t: Turn) -> Result<Turn, DiceError> {
    t.on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_every_hit_with(d6(), every_hit(Some("capped"), Some(2.0)))
}

fn sneak(other: &AttackBuilder) -> R<Turn> {
    let attacks = vec![atk(sword()?), atk(other.clone()), atk(sword()?)];
    Ok(sneak_and_capped(turn(attacks, 0.0)?)?)
}

fn vex(other: &AttackBuilder) -> R<Turn> {
    let first = sword()?.on_every_hit_with(next_attack(), None)?;
    Ok(turn(
        vec![atk(first), atk(other.clone()), atk(sword()?)],
        0.0,
    )?)
}

fn stunning() -> R<Turn> {
    Ok(turn(fists()?, 0.0)?.on_first_hit_with(
        stunned().until_end_of_turn(),
        save_options("stun", 2.0, 15.0)?,
    )?)
}

// ---- mean() is the sum of the marginal means (L2) ------------------------------------------------

/// Every turn shape this file builds, by name.
fn shapes() -> R<Vec<(&'static str, Turn)>> {
    let zeroed = d20()
        .plus(8.0)?
        .ac(16.0)?
        .melee()?
        .on_hit_args(&[Arg::Num(0.0)])?;
    let capped = sneak_and_capped(turn(
        swords(2)?.into_iter().chain([atk(bow()?)]).collect(),
        0.0,
    )?)?;
    Ok(vec![
        ("vex", vex(&sword()?)?),
        ("vex zeroed", vex(&zeroed)?),
        ("topple", topple(&sword()?)?),
        ("sneak", sneak(&sword()?)?),
        ("stunning", stunning()?),
        ("capped", capped),
        ("happens", from_spec(happens_spec(Some(0.3), true)?)?),
        ("chance", from_spec(chance_spec(Some(0.3))?)?),
    ])
}

#[test]
fn mean_is_the_sum_of_the_marginal_means_over_this_files_shapes() -> T {
    for (name, t) in shapes()? {
        if t.inspect_plan()?.dealing {
            continue; // its mean is that sum by definition
        }
        let mean = t.mean()?;
        let diff = (mean - marginal_mean(&t)?).abs();
        assert!(diff <= TOLERANCE * mean.max(1.0), "{name}: {diff}");
    }
    Ok(())
}

// ---- a marginal does not change when other rows' damage is zeroed (L2) ---------------------------

#[test]
fn a_marginal_does_not_change_when_other_rows_damage_is_zeroed() -> T {
    type Build = fn(&AttackBuilder) -> R<Turn>;
    let zeroed = d20()
        .plus(8.0)?
        .ac(16.0)?
        .melee()?
        .on_hit_args(&[Arg::Num(0.0)])?;
    let shapes: [(&str, Build); 3] = [("vex", vex), ("topple", topple), ("sneak", sneak)];
    for (name, build) in shapes {
        let whole = build(&sword()?)?;
        let zero = build(&zeroed)?;
        for id in ids_of(&whole)? {
            if id == "attack 2" {
                continue;
            }
            expect_same_pmf(
                zero.marginal(&id)?.pmf(),
                whole.marginal(&id)?.pmf(),
                &format!("{name} {id}"),
            );
        }
    }
    Ok(())
}

// ---- happens and chance are mixtures (L2) ---------------------------------------------------------

const P: f64 = 0.3;

fn from_spec(spec: TurnSpec) -> Result<Turn, DiceError> {
    Turn::from_spec(spec, 0.0)
}

fn vex_condition() -> crate::turn::types::ConditionSpec {
    condition(
        "vex",
        AttackTriggerOn::EveryHit,
        &["a"],
        vec![grant_advantage(GrantUntil::NextAttack)],
    )
}

fn happens_spec(happens: Option<f64>, riders: bool) -> R<TurnSpec> {
    let mut each = rider(
        "r",
        Trigger::EveryHit {
            of: None,
            max: None,
            per_source: None,
        },
        None,
        d6(),
    );
    each.happens = happens;
    Ok(spec_of(
        vec![declared("a", sword()?), declared("b", sword()?)],
        if riders { vec![each] } else { vec![] },
        vec![],
        vec![vex_condition()],
    ))
}

fn chance_spec(chance: Option<f64>) -> R<TurnSpec> {
    let a = Attack::Declared {
        options: AttackOptions {
            id: Some("a".to_string()),
            chance,
            ..AttackOptions::default()
        },
        source: Source::from(sword()?),
    };
    Ok(spec_of(
        vec![a, declared("b", sword()?)],
        vec![],
        vec![],
        vec![vex_condition()],
    ))
}

#[test]
fn a_riders_happens_p_mixes_the_turn_with_and_without_it() -> T {
    let some = from_spec(happens_spec(Some(P), true)?)?;
    let always = from_spec(happens_spec(None, true)?)?;
    let never = from_spec(happens_spec(None, false)?)?;
    expect_mixture(&some.pmf()?, &always.pmf()?, &never.pmf()?, P, "joint");
    for id in ["a", "b"] {
        expect_same_pmf(some.marginal(id)?.pmf(), always.marginal(id)?.pmf(), id);
    }
    expect_mixture(
        some.marginal("r")?.pmf(),
        always.marginal("r")?.pmf(),
        &delta(0.0),
        P,
        "r",
    );
    close(
        some.mean()?,
        P * always.mean()? + (1.0 - P) * never.mean()?,
        12,
    );
    Ok(())
}

#[test]
fn an_attacks_chance_p_mixes_the_turn_with_and_without_it() -> T {
    let some = from_spec(chance_spec(Some(P))?)?;
    let present = from_spec(chance_spec(None)?)?;
    let absent = from_spec(chance_spec(Some(0.0))?)?;
    expect_mixture(&some.pmf()?, &present.pmf()?, &absent.pmf()?, P, "joint");
    expect_mixture(
        some.marginal("b")?.pmf(),
        present.marginal("b")?.pmf(),
        absent.marginal("b")?.pmf(),
        P,
        "b",
    );
    let a = some.marginal("a")?;
    let a = a.as_attack().ok_or("a is an attack")?;
    close(a.occurs, P, 15);
    let present_a = present.marginal("a")?;
    expect_same_pmf(
        &a.when_happens,
        &present_a.as_attack().ok_or("a is an attack")?.when_happens,
        "a when it happens",
    );
    Ok(())
}

// ---- bit placement (L2) ----------------------------------------------------------------------------

#[test]
fn bit_placement_over_this_files_shapes() -> T {
    for (name, t) in shapes()? {
        let plan = t.inspect_plan()?;
        for (s, step) in plan.steps.iter().enumerate() {
            let bits: Vec<i32> = step.flag_reads.iter().map(|read| read.bit).collect();
            let label = format!("{name} {}", step.id);
            // The state key holds 30 flag bits.
            for bit in &bits {
                assert!(*bit < 30, "{label}");
            }
            // Two flags a row reads never share a bit.
            let mut unique = bits.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(unique.len(), bits.len(), "{label}");
            // A flag read here was kept live by the step before (or is in force from the start).
            let live: i64 = if s == 0 {
                -1
            } else {
                i64::from(plan.flag_live_after[s - 1])
            };
            for bit in bits {
                assert!(live & (1 << bit) != 0, "{label} bit {bit}");
            }
        }
    }
    Ok(())
}

// ---- the readers agree with each other -------------------------------------------------------------

const HIT: f64 = 0.65;
const FAIL: f64 = 0.6;

#[test]
fn attempt_probability_a_first_hit_condition_is_tried_on_the_first_landing_a_later_attack_can_use()
-> T {
    // As the engine counts it: attack 3 has no later attack to stun for, so it is not tried there.
    close(
        stunning()?.attempt_probability("stun")?,
        1.0 - (1.0 - HIT).powi(2),
        12,
    );
    Ok(())
}

#[test]
fn step_stats_conditions_attempted_on_a_rows_landing_taken_on_a_failed_save() -> T {
    let stats = stunning()?.step_stats("attack 2")?;
    let stun = stats.conditions.first().ok_or("a condition at attack 2")?;
    assert_eq!(stun.id, "stun");
    close(stun.attempted, (1.0 - HIT) * HIT, 12);
    close(stun.taken, (1.0 - HIT) * HIT * FAIL, 12);
    Ok(())
}

#[test]
fn step_stats_live_the_advantage_a_stun_puts_in_force_with_its_source() -> T {
    let live = stunning()?.step_stats("attack 2")?.live;
    close(live.advantage(), HIT * FAIL, 12);
    let sources = live.sources(EffectName::Advantage);
    assert_eq!(sources.len(), 1);
    assert_eq!(
        sources,
        &[SourceOdds {
            source: crate::turn::plan::EffectSource::Grant("stun".to_string()),
            odds: sources[0].odds,
        }]
    );
    close(sources[0].odds, HIT * FAIL, 12);
    Ok(())
}

#[test]
fn a_riders_landings_add_up_to_its_any_landing_which_is_fire_probability_patterns_too() -> T {
    let t = turn(vec![atk(sword()?), atk(sword()?), atk(bow()?)], 0.0)?;
    let without = t.on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?;
    let t = without.on_every_hit_with(d6(), every_hit(Some("capped"), Some(2.0)))?;
    let sneak = t.marginal("sneak")?;
    let sneak = sneak.as_rider().ok_or("sneak is a rider")?;
    close(sneak.any_landing, t.fire_probability("sneak")?, 12);
    let landed: f64 = sneak
        .landings
        .values()
        .map(|each| each.hit + each.crit)
        .sum();
    close(landed, sneak.any_landing, 12);
    let mut patterns = 0.0;
    for id in t.attack_ids()? {
        patterns += t
            .landings(&id)?
            .iter()
            .filter(|pattern| pattern.riders.iter().any(|rider| rider == "sneak"))
            .map(|pattern| pattern.mass)
            .sum::<f64>();
    }
    close(patterns, sneak.any_landing, 12);
    let capped = t.marginal("capped")?;
    let capped = capped.as_rider().ok_or("capped is a rider")?;
    close(capped.any_landing, t.fire_probability("capped")?, 12);
    // Its marginal mean is what it adds to the turn's.
    close(capped.pmf.mean(), t.mean()? - without.mean()?, 12);
    Ok(())
}

#[test]
fn an_attacks_marginal_is_when_happens_thinned_by_occurs_with_its_d20s_odds() -> T {
    let b = Attack::Declared {
        options: AttackOptions {
            id: Some("b".to_string()),
            chance: Some(0.4),
            ..AttackOptions::default()
        },
        source: Source::from(sword()?),
    };
    let spec = spec_of(
        vec![declared("a", sword()?), b],
        vec![],
        vec![],
        vec![vex_condition()],
    );
    let t = from_spec(spec)?;
    let b = t.marginal("b")?;
    let b = b.as_attack().ok_or("b is an attack")?;
    close(b.occurs, 0.4, 15);
    expect_same_pmf(&b.pmf, &b.when_happens.apply_hit_frequency(0.4), "b");
    close(b.roll_type(RollType::Advantage), HIT, 12);
    close(b.roll_type(RollType::Flat), 1.0 - HIT, 12);
    assert!(t.peak_states()? > 0);
    Ok(())
}

// ---- landing patterns name a row's branches as the engine does ----------------------------------

fn any_rider() -> Rider {
    let mut r = rider(
        "r",
        Trigger::EveryHit {
            of: Some(names(&["row"])),
            max: None,
            per_source: None,
        },
        Some(RiderLanding::Any),
        d6(),
    );
    r.id = Some("r".to_string());
    r
}

fn patterns_of(
    source: impl Into<Source>,
    rider: Rider,
) -> R<Vec<crate::turn::readers::LandingPattern>> {
    let spec = spec_of(vec![declared("row", source)], vec![rider], vec![], vec![]);
    Ok(from_spec(spec)?.landings("row")?)
}

#[track_caller]
fn expect_patterns(
    actual: &[crate::turn::readers::LandingPattern],
    expected: &[(&str, bool, f64)],
) {
    let got: Vec<(&str, bool, Vec<&str>)> = actual
        .iter()
        .map(|p| {
            (
                p.label.as_str(),
                p.dealt,
                p.riders.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    let want: Vec<(&str, bool, Vec<&str>)> = expected
        .iter()
        .map(|(label, dealt, _)| (*label, *dealt, vec!["r"]))
        .collect();
    assert_eq!(got, want);
    for (pattern, (_, _, mass)) in actual.iter().zip(expected) {
        close(pattern.mass, *mass, 12);
    }
}

fn save_against_15(
    failure: crate::builder::roll::RollBuilder,
) -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(failure)])
}

// d20 + 2 against DC 15 fails on 1-12: 0.6.
#[test]
fn a_half_damage_save_that_can_halve_to_0_save_half_dealt_and_save_half_not_dealt() -> T {
    // d4 halved rounds 1 down to 0.
    let patterns = patterns_of(save_against_15(d4())?.save_half()?, any_rider())?;
    expect_patterns(
        &patterns,
        &[
            ("saveFail", true, 0.6),
            ("saveHalf", true, 0.4 * 0.75),
            ("saveHalf", false, 0.4 * 0.25),
        ],
    );
    Ok(())
}

#[test]
fn a_failure_that_can_deal_0_save_fail_not_dealt() -> T {
    // d4 − 1 is 0 on a 1; halved, 0 on a 1 or 2.
    let patterns = patterns_of(save_against_15(d4().plus(-1.0)?)?.save_half()?, any_rider())?;
    expect_patterns(
        &patterns,
        &[
            ("saveFail", true, 0.6 * 0.75),
            ("saveFail", false, 0.6 * 0.25),
            ("saveHalf", true, 0.4 * 0.5),
            ("saveHalf", false, 0.4 * 0.5),
        ],
    );
    Ok(())
}

#[test]
fn a_save_without_half_damage_its_pass_is_save_pass_never_dealt() -> T {
    let patterns = patterns_of(save_against_15(d4())?, any_rider())?;
    expect_patterns(
        &patterns,
        &[("saveFail", true, 0.6), ("savePass", false, 0.4)],
    );
    Ok(())
}

#[test]
fn an_attack_hit_and_crit_by_damage_dealt_its_miss_is_miss_never_dealt() -> T {
    // d20 + 8 against AC 16: hits on 8-19 (0.6), crits on 20 (0.05), misses 0.35.
    let attack = d20()
        .plus(8.0)?
        .ac(16.0)?
        .on_hit(d8().plus(4.0)?)?
        .on_miss(&[Arg::Roll(d4())])?;
    let patterns = patterns_of(attack, any_rider())?;
    expect_patterns(
        &patterns,
        &[
            ("hit", true, 0.6),
            ("crit", true, 0.05),
            ("miss", false, 0.35),
        ],
    );
    Ok(())
}

#[test]
fn a_riders_happens_does_not_hide_where_it_lands() -> T {
    let mut each = rider(
        "r",
        Trigger::EveryHit {
            of: Some(names(&["row"])),
            max: None,
            per_source: None,
        },
        None,
        d6(),
    );
    each.happens = Some(0.5);
    let attack = d20().plus(8.0)?.ac(16.0)?.on_hit(d8().plus(4.0)?)?;
    let patterns = patterns_of(attack, each)?;
    expect_patterns(&patterns, &[("hit", true, 0.6), ("crit", true, 0.05)]);
    Ok(())
}

// ---- probability readers (the convolution spies are not translated) ---------------------------------

#[test]
fn probability_readers_run_without_the_convolution_spy() -> T {
    let t = turn(fists()?, 0.0)?
        .on_every_hit_with(
            advantage().until_next_attack(),
            every_hit(Some("vex"), None),
        )?
        .on_first_hit_with(
            stunned().until_end_of_turn(),
            save_options("stun", 2.0, 15.0)?,
        )?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_every_hit_with(d6(), every_hit(Some("capped"), Some(2.0)))?;
    for id in t.attack_ids()? {
        t.step_stats(&id)?;
        t.landings(&id)?;
    }
    for id in ids_of(&t)? {
        t.marginal(&id)?;
    }
    for id in t.rider_ids()? {
        t.fire_probability(&id)?;
        t.expected_applications(&id)?;
    }
    for id in t.condition_ids()? {
        t.attempt_probability(&id)?;
        t.fire_probability(&id)?;
    }
    assert!(t.peak_states()? > 0);
    t.mean()?;
    Ok(())
}

/// `{ chance }` of `onEveryHit`.
fn every_hit_chance(chance: f64) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                chance: Some(chance),
                ..ConditionOptions::default()
            },
            per_source: None,
        },
        max: None,
    }
}

#[test]
fn probe_and_rider_readers_run_without_the_convolution_spy() -> T {
    let t = turn(fists()?, 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_every_hit_with(crit_on_hit().until_next_attack(), every_hit_chance(0.5))?
        .observe_any_crit("crit", None)?;
    let crit = t.fire_probability("crit")?;
    assert_eq!(t.fire_probability("crit")?, crit);
    t.fire_probability("sneak")?;
    t.mean()?;
    Ok(())
}
