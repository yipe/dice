//! `src/turn/substitute.test.ts`: 52 tests, 136 compat calls.
//!
//! Not translated: src/turn/substitute.test.ts:644: "a transform on any verb but onFirstHit is
//! unsupported-trigger" — a `Transform` is not an `Effect`/`RiderDamage` in Rust, so every other verb
//! (and a rider's `damage` in a `TurnSpec`) refuses it at compile time; there is nothing to call.
//! The `ifBelow(1 …)` row is a retired compat entry: its assertions run, no compat call is checked.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::error::DiceError;
use crate::pmf::mixture::Mixture;
use crate::turn::effects::{ConditionOptions, FirstHitOptions, Transform, keep_best_damage};
use crate::turn::types::AttacksOptions;
use crate::turn::types::{
    AttackOptions, DamageSource, Rider, RiderDamage, RiderDamageSpec, RiderOptions, SubstituteKind,
    SubstituteOn, SubstitutePolicy, SubstituteSpec, Trigger, TurnSpec, TurnSpecErrorCode,
};
use crate::turn::{Effect, Turn, bounce, turn};
use indexmap::IndexMap;
use std::collections::HashMap;

const FILE: &str = "src/turn/substitute.test.ts";
const EXACT: &str = "keepBestDamage() — exactness";
const O9: &str = "O9: split equivalence (R14) — onHit(2d6+5+2d6) vs onHit(2d6+5) + onEveryHit(2d6)";
const O20S: &str = "O20: optimal-vs-first-hit gain ratio at P(hit)=0.65 (R25, no-crit reading)";
const FIRING: &str = "keepBestDamage() — firing";
const BASE: &str = "keepBestDamage() — base payload only (R14, R26)";
const HOLD: &str = "keepBestDamage().ifBelow() — hold semantics (R25, O27)";
const OF: &str = "`of` snapshots and defaults (R15, R18)";
const VSAC: &str = "vsAC (R18)";
const STATE: &str = "state count (R31)";
const O17: &str = "O17: a substitution must see the reroll (R17)";

type R<X> = Result<X, Box<dyn std::error::Error>>;

fn want(suite: &str, test: &str) -> crate::turn::compat::Expected {
    expect(FILE, &format!("{suite} > {test}"))
}

// ---- helpers -------------------------------------------------------------------------------------

fn pmf_max_diff(actual: &Pmf, expected: &Pmf) -> f64 {
    let mut support = actual.support();
    support.extend(expected.support());
    support.iter().fold(0.0, |worst: f64, v| {
        worst.max((actual.p_at(v.0) - expected.p_at(v.0)).abs())
    })
}

#[track_caller]
fn expect_same_pmf(actual: &Pmf, expected: &Pmf) {
    let worst = pmf_max_diff(actual, expected);
    assert!(worst < 1e-12, "max pmf difference {worst}");
}

#[track_caller]
fn not_close(actual: f64, expected: f64, digits: i32) {
    assert!(
        (actual - expected).abs() >= 10f64.powi(-digits) / 2.0,
        "{actual} is close to {expected} at {digits} digits"
    );
}

/// Mean of `label`'s slice given that label.
fn conditional_mean(pmf: &Pmf, label: &str) -> f64 {
    let slice = pmf.filter_outcome(label);
    slice.mean() / slice.mass()
}

type Dist = IndexMap<i64, f64>;

/// Exact totals of `count` dice with `sides` faces, plus a flat `bonus`.
fn dice_totals(count: usize, sides: i64, bonus: i64) -> Dist {
    let mut dist: Dist = IndexMap::new();
    dist.insert(bonus, 1.0);
    for _ in 0..count {
        let mut next: Dist = IndexMap::new();
        for (total, p) in &dist {
            for face in 1..=sides {
                *next.entry(total + face).or_insert(0.0) += p / sides as f64;
            }
        }
        dist = next;
    }
    dist
}

/// E[max(x, X')] for a fresh X' from `dist`.
fn keep_better(x: i64, dist: &Dist) -> f64 {
    dist.iter()
        .fold(0.0, |m, (v, p)| m + p * (x.max(*v) as f64))
}

fn mean_of(dist: &Dist) -> f64 {
    dist.iter().fold(0.0, |m, (v, p)| m + p * (*v as f64))
}

// d20+5 vs AC 12: miss on 1-6, hit on 7-19, crit on 20. Modes: 0 miss, 1 hit, 2 crit.
const ODDS: [f64; 3] = [0.3, 0.65, 0.05];

struct Payloads {
    hit: Dist,
    crit: Dist,
}

/// `2d6+3`, auto-doubled on a crit to `4d6+3`.
fn o20_payloads() -> Payloads {
    Payloads {
        hit: dice_totals(2, 6, 3),
        crit: dice_totals(4, 6, 3),
    }
}

struct Landing {
    mode: usize,
    later_can_land: bool,
}

/// Exact E[damage] of one path's landings under the once-per-turn keep-the-better reroll.
fn path_mean(
    landings: &[Landing],
    thresholds: Option<(f64, f64)>,
    payloads: &Payloads,
    from: usize,
    unspent: bool,
) -> f64 {
    if from == landings.len() {
        return 0.0;
    }
    let Landing {
        mode,
        later_can_land,
    } = &landings[from];
    let dist = if *mode == 1 {
        &payloads.hit
    } else {
        &payloads.crit
    };
    if !unspent {
        return mean_of(dist) + path_mean(landings, thresholds, payloads, from + 1, false);
    }
    let mut mean = 0.0;
    for (x, p) in dist {
        let spends = match thresholds {
            None => true,
            Some((hit, crit)) => {
                !later_can_land || (*x as f64) < (if *mode == 1 { hit } else { crit })
            }
        };
        mean += if spends {
            p * (keep_better(*x, dist) + path_mean(landings, thresholds, payloads, from + 1, false))
        } else {
            p * (*x as f64 + path_mean(landings, thresholds, payloads, from + 1, true))
        };
    }
    mean
}

/// Two `d20+5` vs AC 12 attacks under a threshold policy; `strict_last` applies it on the last too.
fn exact_policy_mean(
    thresholds: Option<(f64, f64)>,
    strict_last: bool,
    payloads: &Payloads,
) -> f64 {
    let mut total = 0.0;
    for (one, p_one) in ODDS.iter().enumerate() {
        for (two, p_two) in ODDS.iter().enumerate() {
            let mut landings = Vec::new();
            if one != 0 {
                landings.push(Landing {
                    mode: one,
                    later_can_land: true,
                });
            }
            if two != 0 {
                landings.push(Landing {
                    mode: two,
                    later_can_land: strict_last,
                });
            }
            total += p_one * p_two * path_mean(&landings, thresholds, payloads, 0, true);
        }
    }
    total
}

fn o20_attack() -> R<AttackBuilder> {
    Ok(attack_roll(5.0, 12.0, rs(2.0, 6.0)?.plus(3.0)?)?)
}

fn o20_turn() -> R<Turn> {
    let attack = o20_attack()?;
    Ok(turn(vec![atk(attack.clone()), atk(attack)], 0.0)?)
}

fn turn_of(attacks: &[&AttackBuilder]) -> R<Turn> {
    Ok(turn(
        attacks.iter().map(|a| atk((*a).clone())).collect(),
        0.0,
    )?)
}

fn opts(id: Option<&str>, of: Option<&[&str]>) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                id: id.map(str::to_string),
                of: of.map(|of| of.iter().map(std::string::ToString::to_string).collect()),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

/// `.onFirstHit(keepBestDamage())`.
fn kbd(t: &Turn) -> Result<Turn, DiceError> {
    t.on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())
}

fn kbd_with(
    t: &Turn,
    transform: Transform,
    id: Option<&str>,
    of: Option<&[&str]>,
) -> Result<Turn, DiceError> {
    t.on_first_hit_transform(transform, opts(id, of))
}

fn rider(t: &Turn, damage: impl Into<Effect>) -> Result<Turn, DiceError> {
    t.on_first_hit_with(damage, FirstHitOptions::default())
}

fn rider_with(
    t: &Turn,
    damage: impl Into<Effect>,
    id: Option<&str>,
    of: Option<&[&str]>,
) -> Result<Turn, DiceError> {
    t.on_first_hit_with(damage, opts(id, of))
}

fn tagged(tag: &str) -> AttackOptions {
    AttackOptions {
        tag: Some(tag.to_string()),
        ..AttackOptions::default()
    }
}

fn fire_blade(ac: f64) -> R<AttackBuilder> {
    Ok(attack_roll(9.0, ac, rs(2.0, 6.0)?.plus(5.0)?)?.plus_separate_damage(rs(2.0, 6.0)?))
}

fn orb() -> R<AttackBuilder> {
    Ok(attack_roll(5.0, 17.0, rs(3.0, 8.0)?)?)
}

fn code_of_err<X>(r: Result<X, crate::turn::types::TurnSpecError>) -> TurnSpecErrorCode {
    spec_code(r.map_err(DiceError::from))
}

// ---- exactness ----------------------------------------------------------------------------------

#[test]
fn o7_two_d20_5_vs_ac_12_attacks_for_1d4_match_a_brute_force_enumeration_of_every_die() -> T {
    struct Outcome {
        p: f64,
        lands: bool,
        base: i64,
        better: i64,
    }

    let mut w = want(
        EXACT,
        "O7: two d20+5 vs AC 12 attacks for 1d4 match a brute-force enumeration of every die",
    );
    let mut outcomes: Vec<Outcome> = Vec::new();
    for r in 1..=20 {
        if r == 1 || (r != 20 && r + 5 < 12) {
            outcomes.push(Outcome {
                p: 1.0 / 20.0,
                lands: false,
                base: 0,
                better: 0,
            });
            continue;
        }
        let dice = if r == 20 { 2 } else { 1 }; // a crit doubles the dice
        let faces = 4i64.pow(dice);
        for first in 0..faces {
            for second in 0..faces {
                let sum = |code: i64| {
                    if dice == 1 {
                        code + 1
                    } else {
                        (code % 4) + 1 + code / 4 + 1
                    }
                };
                outcomes.push(Outcome {
                    p: 1.0 / 20.0 / (faces * faces) as f64,
                    lands: true,
                    base: sum(first),
                    better: sum(first).max(sum(second)),
                });
            }
        }
    }
    let mut expected: HashMap<i64, f64> = HashMap::new();
    for one in &outcomes {
        for two in &outcomes {
            // Spent on the first landing attack; the other deals its own roll.
            let total = if one.lands {
                one.better + two.base
            } else {
                two.better
            };
            *expected.entry(total).or_insert(0.0) += one.p * two.p;
        }
    }
    let attack = attack_roll(5.0, 12.0, rs(1.0, 4.0)?)?;
    let actual = w.pmf(&kbd(&turn_of(&[&attack, &attack])?)?);
    let mut worst: f64 = 0.0;
    let mut keys: Vec<i64> = expected.keys().copied().collect();
    keys.extend(actual.support().iter().map(|v| v.0 as i64));
    for k in keys {
        worst = worst.max((actual.p_at(k as f64) - expected.get(&k).copied().unwrap_or(0.0)).abs());
    }
    assert!(worst < 1e-12, "max pmf difference {worst}");
    close(actual.mass(), 1.0, 12);
    w.done();
    Ok(())
}

#[test]
fn a_single_attack_equals_the_attack_with_its_hit_and_crit_payloads_passed_through_max_of_two() -> T
{
    let mut w = want(
        EXACT,
        "a single attack equals the attack with its hit and crit payloads passed through maxOfTwo",
    );
    let attack = o20_attack()?;
    let resolution = attack.resolve(0.0)?;
    let zero = Pmf::delta(0.0, 0.0)?;
    let expected = Mixture::mix(
        &[
            (
                "hit",
                &resolution.hit_base.max_of_two(),
                resolution.weights.hit,
            ),
            (
                "crit",
                &resolution.crit_base.max_of_two(),
                resolution.weights.crit,
            ),
            ("missNone", &zero, resolution.weights.miss),
        ],
        0.0,
    )?;
    let actual = w.pmf(&kbd(&turn_of(&[&attack])?)?);
    expect_same_pmf(&actual, &expected);
    let mut outcomes = actual.outcomes();
    outcomes.sort();
    assert_eq!(outcomes, vec!["crit", "hit", "missNone"]);
    w.done();
    Ok(())
}

#[test]
fn a_crit_transforms_the_already_doubled_crit_payload_never_the_doubled_then_pooled_figure() -> T {
    let mut w = want(
        EXACT,
        "a crit transforms the already-doubled crit payload, never the doubled-then-pooled figure",
    );
    let pmf = w.pmf(&kbd(&turn_of(&[&o20_attack()?])?)?);
    close(conditional_mean(&pmf, "hit"), 11.3719, 4);
    close(conditional_mean(&pmf, "crit"), 18.9334, 4);
    not_close(conditional_mean(&pmf, "crit"), 22.7438, 1); // the whole pool rolled twice
    w.done();
    Ok(())
}

#[test]
fn leaves_the_miss_slice_untouched_and_total_mass_at_1() -> T {
    let mut w = want(EXACT, "leaves the miss slice untouched and total mass at 1");
    let single = turn_of(&[&o20_attack()?])?;
    let transformed = w.pmf(&kbd(&single)?).filter_outcome("missNone");
    let plain = w.pmf(&single).filter_outcome("missNone");
    expect_same_pmf(&transformed, &plain);
    let substituted = w.pmf(&kbd(&o20_turn()?)?);
    close(substituted.p_at(0.0), 0.09, 12);
    close(substituted.mass(), 1.0, 12);
    w.done();
    Ok(())
}

#[test]
fn o20_scores_15_9849_under_the_first_landing_policy_below_the_16_1889_optimum_it_does_not_reach()
-> T {
    let mut w = want(
        EXACT,
        "O20: scores 15.9849 under the first-landing policy — below the 16.1889 optimum it does not reach",
    );
    let t = o20_turn()?;
    close(w.mean(&t), 14.7, 4);
    let mean = w.mean(&kbd(&t)?);
    close(mean, 15.9849, 4);
    close(mean, exact_policy_mean(None, false, &o20_payloads()), 9);
    assert!(mean < 16.1889);
    w.done();
    Ok(())
}

#[test]
fn three_copies_of_one_attack_gain_strictly_less_than_3x_the_single_attack_gain() -> T {
    let mut w = want(
        EXACT,
        "three copies of one attack gain strictly less than 3x the single-attack gain",
    );
    let mut gain = |count: f64| -> R<f64> {
        let plain = turn(vec![], 0.0)?.attacks(count, o20_attack()?)?;
        let spent = w.mean(&kbd(&plain)?);
        Ok(spent - w.mean(&plain))
    };
    assert!(gain(3.0)? > gain(1.0)?);
    assert!(gain(3.0)? < 3.0 * gain(1.0)?);
    w.done();
    Ok(())
}

// ---- O9 -----------------------------------------------------------------------------------------

#[test]
fn full_turn_pmf_matches_bin_for_bin_over_the_same_two_attacks_both_mean_28() -> T {
    let mut w = want(
        O9,
        "full turn PMF matches bin for bin over the same two attacks, both mean 28.0000",
    );
    let folded = attack_roll(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?.plus_dice(2.0, &d6())?)?;
    let split = attack_roll(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    let folded_turn = turn_of(&[&folded, &folded])?;
    let split_turn =
        turn_of(&[&split, &split])?.on_every_hit_with(rs(2.0, 6.0)?, every_hit(None, None))?;
    let folded_pmf = w.pmf(&folded_turn);
    let split_pmf = w.pmf(&split_turn);
    expect_same_pmf(&folded_pmf, &split_pmf);
    close(w.mean(&folded_turn), 28.0, 10);
    close(w.mean(&split_turn), 28.0, 10);
    w.done();
    Ok(())
}

// ---- O20 ratio ----------------------------------------------------------------------------------

fn no_crit_attack() -> R<AttackBuilder> {
    Ok(attack_roll(0.0, 8.0, rs(2.0, 6.0)?)?.no_crit()?)
}

#[test]
fn crit_weight_is_exactly_0_and_hit_is_exactly_0_65() -> T {
    let weights = no_crit_attack()?.resolve(0.0)?.weights;
    assert_eq!(weights.crit, 0.0);
    close(weights.hit, 0.65, 12);
    close(weights.miss, 0.35, 12);
    Ok(())
}

/// Expected value the unspent reroll still adds with `k` future landing opportunities left.
fn optimal_value_add(k: usize, payload: &Dist, p: f64) -> f64 {
    if k == 0 {
        return 0.0;
    }
    let remaining = optimal_value_add(k - 1, payload, p);
    let mut landing = 0.0;
    for (x, prob) in payload {
        landing += prob * (keep_better(*x, payload) - *x as f64).max(remaining);
    }
    p * landing + (1.0 - p) * remaining
}

fn ratio_row(n: usize, expected_ratio: f64, test: &str) -> T {
    let mut w = want(O20S, test);
    let payload = dice_totals(2, 6, 0);
    let payload_mean = mean_of(&payload);
    let p = 0.65;
    let attack = no_crit_attack()?;
    let attacks = vec![&attack; n];
    let no_feature = w.mean(&turn_of(&attacks)?);
    let first_hit = w.mean(&kbd(&turn_of(&attacks)?)?);
    let optimal = n as f64 * p * payload_mean + optimal_value_add(n, &payload, p);
    let ratio = (optimal - no_feature) / (first_hit - no_feature);
    close(ratio, expected_ratio, 3);
    w.done();
    Ok(())
}

#[test]
fn n_2_optimal_recovers_1_136x_first_hits_gain() -> T {
    ratio_row(2, 1.136, "n=2: optimal recovers 1.136x first-hit's gain")
}

#[test]
fn n_3_optimal_recovers_1_3x_first_hits_gain() -> T {
    ratio_row(3, 1.3, "n=3: optimal recovers 1.3x first-hit's gain")
}

#[test]
fn n_4_optimal_recovers_1_456x_first_hits_gain() -> T {
    ratio_row(4, 1.456, "n=4: optimal recovers 1.456x first-hit's gain")
}

// ---- firing -------------------------------------------------------------------------------------

#[test]
fn fire_probability_is_p_spent_at_least_one_watched_attack_lands_under_the_default_policy() -> T {
    let mut w = want(
        FIRING,
        "fireProbability is P(spent): P(at least one watched attack lands) under the default policy",
    );
    let t = kbd_with(&o20_turn()?, keep_best_damage(), Some("reroll"), None)?;
    close(w.fire(&t, "reroll"), 0.91, 12);
    assert_eq!(t.substitute_ids()?, vec!["reroll"]);
    w.done();
    Ok(())
}

#[test]
fn fires_with_a_first_hit_rider_over_the_same_of() -> T {
    let mut w = want(FIRING, "fires with a first-hit rider over the same `of`");
    let weaker = attack_roll(2.0, 12.0, rs(2.0, 6.0)?.plus(3.0)?)?;
    let t = turn_of(&[&o20_attack()?, &weaker])?;
    let t = rider_with(&t, rs(3.0, 6.0)?, Some("rider"), None)?;
    let t = kbd_with(&t, keep_best_damage(), Some("reroll"), None)?;
    close(w.fire(&t, "reroll"), w.fire(&t, "rider"), 12);
    w.done();
    Ok(())
}

#[test]
fn the_rider_and_the_substitution_fire_on_the_same_attack_not_merely_with_equal_probability() -> T {
    let mut w = want(
        FIRING,
        "the rider and the substitution fire on the SAME attack, not merely with equal probability",
    );
    let guaranteed = d20()
        .plus(9.0)?
        .ac(10.0)?
        .always_hits()?
        .on_hit(rs(1.0, 4.0)?.plus(2.0)?)?;
    let other = attack_roll(5.0, 12.0, rs(4.0, 8.0)?.plus(1.0)?)?;
    let both = |attack: &AttackBuilder| -> R<Turn> {
        let t = rider_with(&turn_of(&[attack])?, rs(1.0, 4.0)?, Some("rider"), None)?;
        Ok(kbd_with(&t, keep_best_damage(), Some("reroll"), None)?)
    };
    let t = {
        let t = rider_with(
            &turn_of(&[&guaranteed, &other])?,
            rs(1.0, 4.0)?,
            Some("rider"),
            None,
        )?;
        kbd_with(&t, keep_best_damage(), Some("reroll"), None)?
    };
    // Correct: both effects land on `guaranteed` every time; `other` deals its own damage.
    let expected = w.mean(&both(&guaranteed)?) + w.mean(&turn_of(&[&other])?);
    assert!((w.mean(&t) - expected).abs() < 1e-9);
    // Wrong: both mistakenly target `other`.
    let wrong = w.mean(&turn_of(&[&guaranteed])?) + w.mean(&both(&other)?);
    assert!((w.mean(&t) - wrong).abs() > 0.1);
    w.done();
    Ok(())
}

#[test]
fn otherwise_after_a_transform_fires_exactly_when_nothing_watched_landed_r23_r29() -> T {
    let mut w = want(
        FIRING,
        "otherwise() after a transform fires exactly when nothing watched landed (R23, R29)",
    );
    let t = kbd_with(&o20_turn()?, keep_best_damage(), Some("reroll"), None)?
        .otherwise_with(rs(1.0, 6.0)?, rid("fallback"))?;
    close(w.fire(&t, "fallback"), 0.09, 12);
    close(w.fire(&t, "fallback"), 1.0 - w.fire(&t, "reroll"), 12);
    w.done();
    Ok(())
}

#[test]
fn allocates_no_trigger_group() -> T {
    let mut w = want(FIRING, "allocates no trigger group");
    let plain = o20_turn()?;
    w.mean(&plain);
    assert_eq!(plain.inspect_turn()?.0, 0);
    let spent = kbd(&plain)?;
    w.mean(&spent);
    assert_eq!(spent.inspect_turn()?.0, 0);
    let with_rider = rider(&plain, rs(3.0, 6.0)?)?;
    w.mean(&with_rider);
    assert_eq!(with_rider.inspect_turn()?.0, 1);
    let both = kbd(&with_rider)?;
    w.mean(&both);
    assert_eq!(both.inspect_turn()?.0, 1);
    w.done();
    Ok(())
}

#[test]
fn disjoint_of_sets_are_legal_each_substitute_fires_once_on_its_own_attack() -> T {
    let mut w = want(
        FIRING,
        "disjoint `of` sets are legal: each substitute fires once, on its own attack",
    );
    let t = kbd_with(
        &o20_turn()?,
        keep_best_damage(),
        Some("first"),
        Some(&["attack 1"]),
    )?;
    let t = kbd_with(&t, keep_best_damage(), Some("second"), Some(&["attack 2"]))?;
    close(w.fire(&t, "first"), 0.7, 12);
    close(w.fire(&t, "second"), 0.7, 12);
    w.done();
    Ok(())
}

#[test]
fn half_on_misss_miss_damage_is_not_a_landing_riders_fire_as_often_and_the_substitution_never_touches_it()
-> T {
    let mut w = want(
        FIRING,
        "halfOnMiss's missDamage is not a landing: riders fire as often, and the substitution never touches it",
    );
    let weapon = attack_roll(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    let halved = weapon.half_on_miss()?;
    let plain = turn_of(&[&weapon, &weapon])?;
    let half = turn_of(&[&halved, &halved])?;
    let build = |t: &Turn| -> R<Turn> {
        let t = rider_with(t, rs(3.0, 6.0)?, Some("first"), None)?;
        Ok(t.on_every_hit_with(d6(), every_hit(Some("every"), None))?)
    };
    let a = build(&plain)?;
    let b = build(&half)?;
    close(w.fire(&b, "first"), w.fire(&a, "first"), 12);
    close(w.fire(&b, "every"), w.fire(&a, "every"), 12);
    let half_r = kbd_with(&half, keep_best_damage(), Some("r"), None)?;
    let plain_r = kbd_with(&plain, keep_best_damage(), Some("r"), None)?;
    close(w.fire(&half_r, "r"), w.fire(&plain_r, "r"), 12);
    let single = turn_of(&[&halved])?;
    let transformed = w.pmf(&kbd(&single)?).filter_outcome("missDamage");
    let untouched = w.pmf(&single).filter_outcome("missDamage");
    expect_same_pmf(&transformed, &untouched);
    w.done();
    Ok(())
}

// ---- base payload only --------------------------------------------------------------------------

#[test]
fn o10_rerolls_the_weapon_dice_and_never_the_separate_channel() -> T {
    let mut w = want(
        BASE,
        "O10: rerolls the weapon dice and never the separate channel",
    );
    let pmf = w.pmf(&kbd(&turn_of(&[&fire_blade(16.0)?])?)?);
    close(
        conditional_mean(&w.pmf(&turn_of(&[&fire_blade(16.0)?])?), "hit"),
        19.0,
        4,
    );
    close(conditional_mean(&pmf, "hit"), 20.3719, 4);
    not_close(conditional_mean(&pmf, "hit"), 20.9334, 2); // channel rerolled too
    close(conditional_mean(&pmf, "crit"), 34.9334, 4);
    not_close(conditional_mean(&pmf, "crit"), 35.7296, 2);
    w.done();
    Ok(())
}

#[test]
fn o11_the_end_to_end_fire_blade_turn_scores_31_0604_and_never_moves_miss_mass() -> T {
    let mut w = want(
        BASE,
        "O11: the end-to-end fire-blade turn scores 31.0604, and never moves miss mass",
    );
    let weapon = fire_blade(16.0)?.reroll_damage(2.0)?;
    close(w.mean(&turn_of(&[&weapon])?), 15.0, 4);
    close(w.mean(&turn_of(&[&weapon, &weapon])?), 30.0, 4);
    let t = kbd(&turn_of(&[&weapon, &weapon])?)?;
    close(w.mean(&t), 31.0604, 4);
    close(w.pmf(&t).p_at(0.0), 0.09, 12);

    // Wrong spelling 1: the fire folded into the base payload, so it is rerolled too.
    let folded = attack_roll(
        9.0,
        16.0,
        rs(2.0, 6.0)?
            .reroll(2.0)?
            .plus(5.0)?
            .plus_dice(2.0, &d6())?,
    )?;
    let wrong_fire = kbd(&turn_of(&[&folded, &folded])?)?;
    close(w.mean(&wrong_fire), 31.665, 4);
    not_close(w.mean(&t), w.mean(&wrong_fire), 2);
    close(w.pmf(&wrong_fire).p_at(0.0), 0.09, 12);

    // Wrong spelling 2: applied per attack instead of once per turn.
    let per_attack = 2.0 * w.mean(&kbd(&turn_of(&[&weapon])?)?);
    close(per_attack, 31.6314, 4);
    not_close(w.mean(&t), per_attack, 2);
    w.done();
    Ok(())
}

#[test]
fn o12_reroll_damage_and_the_substitution_compose_sublinearly_the_transform_sees_modified_dice() -> T
{
    let mut w = want(
        BASE,
        "O12: rerollDamage and the substitution compose sublinearly — the transform sees modified dice",
    );
    let weapon = attack_roll(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    let mut hit_mean = |t: &Turn| conditional_mean(&w.pmf(t), "hit");
    close(hit_mean(&turn_of(&[&weapon])?), 12.0, 4);
    close(
        hit_mean(&turn_of(&[&weapon.reroll_damage(2.0)?])?),
        13.3333,
        4,
    );
    close(hit_mean(&kbd(&turn_of(&[&weapon])?)?), 13.3719, 4);
    let both = hit_mean(&kbd(&turn_of(&[&weapon.reroll_damage(2.0)?])?)?);
    close(both, 14.4649, 4);
    not_close(both, 14.7052, 2); // additive: the transform ran on unmodified dice

    let fire = fire_blade(16.0)?;
    close(w.mean(&turn_of(&[&fire, &fire])?), 28.0, 4);
    let rerolled = fire.reroll_damage(2.0)?;
    close(w.mean(&turn_of(&[&rerolled, &rerolled])?), 30.0, 4);
    close(w.mean(&kbd(&turn_of(&[&fire, &fire])?)?), 29.2849, 4);
    close(
        w.mean(&kbd(&turn_of(&[&rerolled, &rerolled])?)?),
        31.0604,
        4,
    );
    w.done();
    Ok(())
}

#[test]
fn o21_the_transform_runs_before_the_every_hit_fold_so_the_folds_dice_are_never_rerolled() -> T {
    let mut w = want(
        BASE,
        "O21: the transform runs before the every-hit fold, so the fold's dice are never rerolled",
    );
    let weapon = attack_roll(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    let t = turn_of(&[&weapon])?.on_every_hit_with(rs(1.0, 6.0)?, every_hit(None, None))?;
    let pmf = w.pmf(&kbd(&t)?);
    close(conditional_mean(&pmf, "hit"), 16.8719, 4);
    close(conditional_mean(&pmf, "crit"), 27.9334, 4);
    not_close(conditional_mean(&pmf, "hit"), 17.1763, 2);
    not_close(conditional_mean(&pmf, "crit"), 28.3652, 2);
    w.done();
    Ok(())
}

#[test]
fn a_dice_match_trigger_reads_the_base_pool_only_the_separate_channel_never_counts_toward_a_match()
-> T {
    let mut w = want(
        BASE,
        "a dice-match trigger reads the base pool only: the separate channel never counts toward a match",
    );
    let orb = orb()?;
    let with_fire = orb.plus_separate_damage(rs(2.0, 8.0)?);
    let plain_turn = bounce(DamageSource::Attack(Box::new(orb.clone())), 1.0)?;
    let plain = w.fire(&plain_turn, "bounce 1");
    let fired = turn_of(&[&with_fire])?.on_dice_match_with(&["attack 1"], orb, rid("bounce 1"))?;
    // P(bounce) = P(orb lands) x P(its 3d8 — never the 2d8 channel — matched).
    close(w.fire(&fired, "bounce 1"), plain, 12);
    close(plain, 0.4 * 0.34375 + 0.05 * 0.923096, 5);
    w.done();
    Ok(())
}

// ---- ifBelow hold semantics ---------------------------------------------------------------------

fn hold_row(
    name: &str,
    thresholds: (f64, f64),
    transform: Transform,
    expected: f64,
    strict_wrong: Option<f64>,
) -> T {
    let mut w = want(HOLD, &format!("ifBelow({name})"));
    let mean = w.mean(&kbd_with(&o20_turn()?, transform, None, None)?);
    close(mean, expected, 6);
    assert!((mean - exact_policy_mean(Some(thresholds), false, &o20_payloads())).abs() < 1e-9);
    if let Some(strict) = strict_wrong {
        // The wrong number a threshold applied on the last attack too would give.
        close(
            exact_policy_mean(Some(thresholds), true, &o20_payloads()),
            strict,
            6,
        );
        not_close(mean, strict, 4);
    }
    w.done();
    Ok(())
}

#[test]
fn if_below_hit_10_crit_18_the_optimum() -> T {
    hold_row(
        "{hit: 10, crit: 18} (the optimum)",
        (10.0, 18.0),
        keep_best_damage().if_below_split(10.0, 18.0)?,
        16.188901,
        Some(16.053727),
    )
}

#[test]
fn if_below_hit_11_crit_18() -> T {
    hold_row(
        "{hit: 11, crit: 18}",
        (11.0, 18.0),
        keep_best_damage().if_below_split(11.0, 18.0)?,
        16.187147,
        None,
    )
}

#[test]
fn if_below_10_one_number_a_crits_4d6_3_almost_always_holds() -> T {
    hold_row(
        "10 (one number: a crit's 4d6+3 almost always holds)",
        (10.0, 10.0),
        keep_best_damage().if_below(10.0)?,
        16.13419,
        Some(15.93429),
    )
}

#[test]
fn if_below_hit_16_crit_28_always_spends() -> T {
    hold_row(
        "{hit: 16, crit: 28} (always spends)",
        (16.0, 28.0),
        keep_best_damage().if_below_split(16.0, 28.0)?,
        15.984935,
        None,
    )
}

#[test]
fn if_below_1_only_attack_2_the_last_opportunity_spends() -> T {
    hold_row(
        "1 (only attack 2, the last opportunity, spends)",
        (1.0, 1.0),
        keep_best_damage().if_below(1.0)?,
        15.688412,
        Some(14.7),
    )
}

#[test]
fn always_spend_thresholds_equal_keep_best_damage_exactly() -> T {
    let mut w = want(
        HOLD,
        "always-spend thresholds equal keepBestDamage() exactly",
    );
    let a = w.pmf(&kbd_with(
        &o20_turn()?,
        keep_best_damage().if_below_split(16.0, 28.0)?,
        None,
        None,
    )?);
    let b = w.pmf(&kbd(&o20_turn()?)?);
    expect_same_pmf(&a, &b);
    w.done();
    Ok(())
}

#[test]
fn fire_probability_is_p_spent_0_70_under_if_below_1_0_91_under_the_default() -> T {
    let mut w = want(
        HOLD,
        "fireProbability is P(spent): 0.70 under ifBelow(1), 0.91 under the default",
    );
    let low = kbd_with(
        &o20_turn()?,
        keep_best_damage().if_below(1.0)?,
        Some("r"),
        None,
    )?;
    close(w.fire(&low, "r"), 0.7, 12);
    let default = kbd_with(&o20_turn()?, keep_best_damage(), Some("r"), None)?;
    close(w.fire(&default, "r"), 0.91, 12);
    w.done();
    Ok(())
}

fn policy() -> R<Transform> {
    Ok(keep_best_damage().if_below_split(12.0, 20.0)?)
}

#[test]
fn needs_no_dice_descriptor_a_parsed_string_or_bare_pmf_payload_splits_exactly_like_the_builder()
-> T {
    let mut w = want(
        HOLD,
        "needs no dice descriptor: a parsed-string or bare-PMF payload splits exactly like the builder",
    );
    let built = attack_roll(5.0, 12.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    // An explicit crit on the parsed payload, spelled out to equal the built one's auto-doubled crit.
    let parsed = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit_args(&[Arg::Str("2d6+5".into())])?
        .on_crit(&[Arg::Str("4d6+5".into())])?;
    let expected = w.pmf(&kbd_with(
        &turn_of(&[&built, &built])?,
        policy()?,
        None,
        None,
    )?);
    let parsed_pmf = w.pmf(&kbd_with(
        &turn_of(&[&parsed, &parsed])?,
        policy()?,
        None,
        None,
    )?);
    expect_same_pmf(&parsed_pmf, &expected);
    let bare = built.pmf()?;
    let bare_turn = turn(vec![atk(bare.clone()), atk(bare)], 0.0)?;
    let bare_pmf = w.pmf(&kbd_with(&bare_turn, policy()?, None, None)?);
    expect_same_pmf(&bare_pmf, &expected);
    // And the threshold does split: it is neither always-spend nor plain.
    not_close(
        expected.mean(),
        w.pmf(&kbd(&turn_of(&[&built, &built])?)?).mean(),
        3,
    );
    w.done();
    Ok(())
}

#[test]
fn a_parsed_payload_with_no_on_crit_auto_doubles_its_crit_like_the_builder_r33_and_if_below_still_works()
-> T {
    let mut w = want(
        HOLD,
        "a parsed payload with NO onCrit auto-doubles its crit like the builder (R33), and .ifBelow() still works",
    );
    let parsed = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit_args(&[Arg::Str("2d6+5".into())])?;
    let weights = parsed.resolve(0.0)?.weights;
    close(weights.crit, 0.05, 12);
    close(weights.hit, 0.65, 12);
    let threshold = 12.0;
    let payloads = Payloads {
        hit: dice_totals(2, 6, 5),
        crit: dice_totals(4, 6, 5),
    };
    let exact = exact_policy_mean(Some((threshold, threshold)), false, &payloads);
    let mean = w.mean(&kbd_with(
        &turn_of(&[&parsed, &parsed])?,
        keep_best_damage().if_below(threshold)?,
        None,
        None,
    )?);
    assert!((mean - exact).abs() < 1e-9);
    let built = attack_roll(5.0, 12.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    // The parsed payload's crit is its dice doubled (4d6+5), exactly the plain builder attack's.
    expect_same_pmf(&parsed.pmf()?, &built.pmf()?);
    let a = w.pmf(&kbd_with(
        &turn_of(&[&parsed, &parsed])?,
        keep_best_damage().if_below(threshold)?,
        None,
        None,
    )?);
    let b = w.pmf(&kbd_with(
        &turn_of(&[&built, &built])?,
        keep_best_damage().if_below(threshold)?,
        None,
        None,
    )?);
    expect_same_pmf(&a, &b);
    w.done();
    Ok(())
}

#[test]
fn an_explicit_on_crit_with_its_own_flat_bonus_the_crit_threshold_splits_the_crit_payloads_own_totals()
-> T {
    let mut w = want(
        HOLD,
        "an explicit onCrit with its own flat bonus: the crit threshold splits the crit payload's own totals",
    );
    let attack = attack_roll(5.0, 12.0, rs(2.0, 6.0)?.plus(5.0)?)?
        .on_crit(&[Arg::Roll(rs(4.0, 6.0)?.plus(10.0)?)])?;
    let payloads = Payloads {
        hit: dice_totals(2, 6, 5),
        crit: dice_totals(4, 6, 10),
    };
    let thresholds = (12.0, 24.0);
    let mean = w.mean(&kbd_with(
        &turn_of(&[&attack, &attack])?,
        keep_best_damage().if_below_split(thresholds.0, thresholds.1)?,
        None,
        None,
    )?);
    let expected = exact_policy_mean(Some(thresholds), false, &payloads);
    assert!((mean - expected).abs() < 1e-9);
    let shifted = exact_policy_mean(Some((12.0, 29.0)), false, &payloads);
    assert!((mean - shifted).abs() > 1e-4);
    w.done();
    Ok(())
}

#[test]
fn optimally_is_unsupported_policy_in_this_release_from_the_factory_and_from_plain_data() -> T {
    assert_eq!(
        code_of_err(keep_best_damage().optimally()),
        TurnSpecErrorCode::UnsupportedPolicy
    );
    let from_data = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(o20_attack()?)],
            substitutes: Some(vec![SubstituteSpec {
                id: None,
                on: SubstituteOn::FirstHit,
                of: None,
                substitute: SubstituteKind::RerollKeepHigher,
                mode: None,
                policy: Some(SubstitutePolicy::Optimal),
            }]),
            ..TurnSpec::default()
        },
        0.0,
    );
    assert_eq!(spec_code(from_data), TurnSpecErrorCode::UnsupportedPolicy);
    Ok(())
}

#[test]
fn the_default_of_does_not_sweep_in_dice_match_beams_r22_name_them_to_let_the_transform_hold_for_one()
-> T {
    let mut w = want(
        HOLD,
        "the default `of` does not sweep in dice-match beams (R22): name them to let the transform hold for one",
    );
    let orb = orb()?;
    let chain = bounce(DamageSource::Attack(Box::new(orb.clone())), 2.0)?;
    // Default `of` is just the orb, so it is the last opportunity and ifBelow(1) spends there anyway.
    let a = w.pmf(&kbd_with(
        &chain,
        keep_best_damage().if_below(1.0)?,
        None,
        None,
    )?);
    let b = w.pmf(&kbd(&chain)?);
    expect_same_pmf(&a, &b);
    let named = kbd_with(
        &chain,
        keep_best_damage().if_below(1.0)?,
        Some("r"),
        Some(&["attack 1", "bounce 1", "bounce 2"]),
    )?;
    let resolution = orb.resolve(0.0)?;
    let lands = resolution.weights.hit + resolution.weights.crit;
    let matched = w.fire(&chain, "bounce 1"); // P(a landing's dice matched)
    let unmatched = lands - matched;
    let spent = unmatched + matched * (unmatched + matched * lands);
    close(w.fire(&named, "r"), spent, 12);
    // A static "last watched step" would hold on the orb and bounce 1 whatever they rolled.
    not_close(w.fire(&named, "r"), matched * matched * lands, 3);
    w.done();
    Ok(())
}

/// Two identical attacks, a `first-miss` reroll of the same attack, and the transform watching all
/// three, by exact enumeration of the rules. `static_last` lets attack 2 hold whenever the trailing
/// reroll's step follows it in the walk, even in states where that step cannot fire.
fn first_miss_policy_mean(thresholds: (f64, f64), static_last: bool) -> f64 {
    let payloads = o20_payloads();
    let mut total = 0.0;
    for (one, p_one) in ODDS.iter().enumerate() {
        for (reroll, p_roll) in ODDS.iter().enumerate() {
            for (two, p_two) in ODDS.iter().enumerate() {
                let rerolls = one == 0 || two == 0;
                // The reroll's own outcome only exists when an attack missed.
                let p_reroll = if rerolls {
                    *p_roll
                } else if reroll == 0 {
                    1.0
                } else {
                    0.0
                };
                let p = p_one * p_two * p_reroll;
                if p == 0.0 {
                    continue;
                }
                let order: Vec<(usize, bool)> = if one == 0 {
                    vec![(reroll, true), (two, static_last)]
                } else {
                    let mut order = vec![(one, true), (two, static_last)];
                    if rerolls {
                        order.push((reroll, false));
                    }
                    order
                };
                let landings: Vec<Landing> = order
                    .into_iter()
                    .filter(|(mode, _)| *mode != 0)
                    .map(|(mode, later_can_land)| Landing {
                        mode,
                        later_can_land,
                    })
                    .collect();
                total += p * path_mean(&landings, Some(thresholds), &payloads, 0, true);
            }
        }
    }
    total
}

#[test]
fn the_last_opportunity_reads_the_walk_state_with_a_first_miss_reroll_watched_attack_2_never_holds()
-> T {
    let mut w = want(
        HOLD,
        "the last opportunity reads the walk state: with a first-miss reroll watched, attack 2 never holds",
    );
    for (thresholds, transform) in [
        ((10.0, 18.0), keep_best_damage().if_below_split(10.0, 18.0)?),
        ((1.0, 1.0), keep_best_damage().if_below(1.0)?),
    ] {
        let t = o20_turn()?.on_first_miss_with(o20_attack()?, rid("reroll"))?;
        let t = kbd_with(
            &t,
            transform,
            Some("r"),
            Some(&["attack 1", "attack 2", "reroll"]),
        )?;
        let mean = w.mean(&t);
        assert!((mean - first_miss_policy_mean(thresholds, false)).abs() < 1e-9);
        assert!((mean - first_miss_policy_mean(thresholds, true)).abs() > 1e-3);
    }
    w.done();
    Ok(())
}

// ---- errors -------------------------------------------------------------------------------------

#[test]
fn two_substitutes_over_overlapping_of_are_duplicate_substitute_the_guard_prevents_max_of_four() -> T
{
    let spent = kbd(&o20_turn()?)?;
    assert_eq!(
        spec_code(kbd(&spent)),
        TurnSpecErrorCode::DuplicateSubstitute
    );
    let narrow = kbd_with(&o20_turn()?, keep_best_damage(), None, Some(&["attack 1"]))?;
    assert_eq!(
        spec_code(kbd(&narrow)),
        TurnSpecErrorCode::DuplicateSubstitute
    );
    let payload = rs(2.0, 6.0)?.plus(5.0)?.pmf()?;
    close(payload.max_of_two().mean(), 13.3719, 4);
    close(payload.max_of_two().max_of_two().mean(), 14.4935, 4);
    Ok(())
}

#[test]
fn a_transform_takes_no_rider_only_option_where_and_joins_are_refused_like_happens() -> T {
    let base = o20_turn()?;
    let mut where_map = IndexMap::new();
    where_map.insert("attack 1".to_string(), Vec::<String>::new());
    let mut with_where = FirstHitOptions::default();
    with_where.condition.rider.r#where = Some(where_map);
    let mut with_joins = FirstHitOptions::default();
    with_joins.condition.rider.joins = Some(vec!["attack 1".to_string()]);
    let mut with_happens = FirstHitOptions::default();
    with_happens.condition.happens = Some(0.5);
    for options in [with_where, with_joins, with_happens] {
        assert_eq!(
            spec_code(base.on_first_hit_transform(keep_best_damage(), options)),
            TurnSpecErrorCode::UnsupportedTrigger
        );
    }
    Ok(())
}

#[test]
fn an_of_naming_nothing_in_the_turn_is_unknown_id_naming_a_save_is_not_an_attack() -> T {
    let base = o20_turn()?;
    assert_eq!(
        spec_code(kbd_with(&base, keep_best_damage(), None, Some(&["nope"]))),
        TurnSpecErrorCode::UnknownId
    );
    let save = d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(rs(3.0, 6.0)?)])?
        .save_half()?;
    // A save-shaped rider named in `of` is `not-an-attack` (it has no hit/crit outcomes).
    let with_save = rider_with(&base, save, Some("poison"), None)?;
    assert_eq!(
        spec_code(kbd_with(
            &with_save,
            keep_best_damage(),
            None,
            Some(&["poison"])
        )),
        TurnSpecErrorCode::NotAnAttack
    );
    Ok(())
}

#[test]
fn attack_attacks_after_a_rider_or_substitute_whose_of_defaulted_is_attack_after_rider() -> T {
    let one = || turn_of(&[&o20_attack()?]);
    let with_d6 = rider(&one()?, d6())?;
    assert_eq!(
        spec_code(with_d6.attack(o20_attack()?)),
        TurnSpecErrorCode::AttackAfterRider
    );
    assert_eq!(
        spec_code(with_d6.attacks(2.0, o20_attack()?)),
        TurnSpecErrorCode::AttackAfterRider
    );
    let spent = kbd(&one()?)?;
    assert_eq!(
        spec_code(spent.attack(o20_attack()?)),
        TurnSpecErrorCode::AttackAfterRider
    );
    // An explicit `of` opts out.
    let explicit = rider_with(&one()?, d6(), None, Some(&["attack 1"]))?.attack(o20_attack()?)?;
    assert_eq!(explicit.attack_ids()?, vec!["attack 1", "attack 2"]);
    Ok(())
}

#[test]
fn a_rider_added_before_any_attack_fails_unknown_id_at_that_call() -> T {
    assert_eq!(
        spec_code(rider(&turn(vec![], 0.0)?, d6())),
        TurnSpecErrorCode::UnknownId
    );
    Ok(())
}

#[test]
fn vs_ac_on_a_turn_with_no_ac_bearing_source_is_no_rebindable_source() -> T {
    let bare = o20_attack()?.pmf()?;
    let t = turn(vec![atk(bare.clone()), atk(bare)], 0.0)?;
    assert_eq!(
        spec_code(t.vs_ac(15.0)),
        TurnSpecErrorCode::NoRebindableSource
    );
    Ok(())
}

// ---- `of` snapshots and defaults ----------------------------------------------------------------

fn sword() -> R<AttackBuilder> {
    Ok(attack_roll(9.0, 16.0, rs(1.0, 8.0)?.plus(5.0)?)?)
}

fn axe() -> R<AttackBuilder> {
    Ok(attack_roll(7.0, 16.0, rs(1.0, 12.0)?.plus(4.0)?)?)
}

#[test]
fn a_rider_pinned_to_the_attacks_it_saw_ignores_a_later_attack_the_attacks_first_turn_agrees() -> T
{
    let mut w = want(
        OF,
        "a rider pinned to the attacks it saw ignores a later attack; the attacks-first turn agrees",
    );
    let (sword, axe) = (sword()?, axe()?);
    let rider_first = rider_with(
        &turn_of(&[&sword])?,
        rs(3.0, 6.0)?,
        None,
        Some(&["attack 1"]),
    )?
    .attack(axe.clone())?;
    let attacks_first = rider_with(
        &turn_of(&[&sword, &axe])?,
        rs(3.0, 6.0)?,
        None,
        Some(&["attack 1"]),
    )?;
    let defaulted = rider(&turn_of(&[&sword, &axe])?, rs(3.0, 6.0)?)?;
    let rider_first_pmf = w.pmf(&rider_first);
    expect_same_pmf(&rider_first_pmf, &w.pmf(&attacks_first));
    // Pin exactly what "defaulted" means (both attacks), then prove riderFirst genuinely diverges.
    let explicit_both = rider_with(
        &turn_of(&[&sword, &axe])?,
        rs(3.0, 6.0)?,
        None,
        Some(&["attack 1", "attack 2"]),
    )?;
    let defaulted_pmf = w.pmf(&defaulted);
    expect_same_pmf(&defaulted_pmf, &w.pmf(&explicit_both));
    assert!(pmf_max_diff(&w.pmf(&rider_first), &w.pmf(&defaulted)) > 0.01);
    w.done();
    Ok(())
}

#[test]
fn an_attack_shaped_any_miss_rider_joins_later_defaulted_of_sets_declared_before_included_after_not()
-> T {
    let mut w = want(
        OF,
        "an attack-shaped any-miss rider joins later defaulted `of` sets — declared before, included; after, not",
    );
    let sword = sword()?;
    let pair = || turn_of(&[&sword, &sword]);
    let before = rider(
        &pair()?.on_any_miss_with(sword.clone(), rid("reroll"))?,
        rs(1.0, 10.0)?,
    )?;
    let explicit = rider_with(
        &pair()?.on_any_miss_with(sword.clone(), rid("reroll"))?,
        rs(1.0, 10.0)?,
        None,
        Some(&["attack 1", "attack 2", "reroll"]),
    )?;
    let after = rider(&pair()?, rs(1.0, 10.0)?)?.on_any_miss_with(sword.clone(), rid("reroll"))?;
    let excluded = rider_with(
        &pair()?.on_any_miss_with(sword.clone(), rid("reroll"))?,
        rs(1.0, 10.0)?,
        None,
        Some(&["attack 1", "attack 2"]),
    )?;
    expect_same_pmf(&w.pmf(&before), &w.pmf(&explicit));
    expect_same_pmf(&w.pmf(&after), &w.pmf(&excluded));
    assert!(w.mean(&before) > w.mean(&after));
    w.done();
    Ok(())
}

#[test]
fn a_damage_shaped_any_miss_rider_never_joins() -> T {
    let mut w = want(OF, "a damage-shaped any-miss rider never joins");
    let sword = sword()?;
    let base = || -> R<Turn> {
        Ok(turn_of(&[&sword, &sword])?.on_any_miss_with(rs(1.0, 6.0)?, rid("consolation"))?)
    };
    let t = rider_with(&base()?, rs(1.0, 10.0)?, Some("r"), None)?;
    let plain = rider_with(
        &base()?,
        rs(1.0, 10.0)?,
        Some("r"),
        Some(&["attack 1", "attack 2"]),
    )?;
    expect_same_pmf(&w.pmf(&t), &w.pmf(&plain));
    w.done();
    Ok(())
}

#[test]
fn turn_from_keeps_the_plan_time_default_every_declared_attack() -> T {
    let mut w = want(
        OF,
        "Turn.from keeps the plan-time default: every declared attack",
    );
    let (sword, axe) = (sword()?, axe()?);
    let from_spec = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword.clone()), atk(axe.clone())],
            riders: Some(vec![Rider {
                trigger: Trigger::FirstHit {
                    of: None,
                    per_source: None,
                },
                id: None,
                damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Roll(rs(3.0, 6.0)?))),
                crit_damage: None,
                landing: None,
                happens: None,
                joins: None,
                r#where: None,
                target_has: None,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let chained = rider(&turn_of(&[&sword, &axe])?, rs(3.0, 6.0)?)?;
    expect_same_pmf(&w.pmf(&from_spec), &w.pmf(&chained));
    w.done();
    Ok(())
}

#[test]
fn a_tag_expands_to_every_attack_carrying_it_an_unknown_tag_is_unknown_id() -> T {
    let mut w = want(
        OF,
        "a tag expands to every attack carrying it; an unknown tag is unknown-id",
    );
    let (sword, axe) = (sword()?, axe()?);
    let tagged_turn = turn(vec![], 0.0)?
        .attack_with(sword.clone(), tagged("blade"))?
        .attack(axe.clone())?
        .attacks_with(
            2.0,
            sword.clone(),
            AttacksOptions {
                tag: Some("blade".to_string()),
                chance: None,
            },
        )?;
    let tagged_turn = rider_with(&tagged_turn, rs(3.0, 6.0)?, None, Some(&["blade"]))?;
    let explicit = rider_with(
        &turn_of(&[&sword, &axe, &sword, &sword])?,
        rs(3.0, 6.0)?,
        None,
        Some(&["attack 1", "attack 3", "attack 4"]),
    )?;
    expect_same_pmf(&w.pmf(&tagged_turn), &w.pmf(&explicit));
    let one = turn(vec![], 0.0)?.attack_with(sword, tagged("blade"))?;
    assert_eq!(
        spec_code(rider_with(&one, d6(), None, Some(&["hammer"]))),
        TurnSpecErrorCode::UnknownId
    );
    w.done();
    Ok(())
}

// ---- vsAC, state count, O17 ---------------------------------------------------------------------

fn vs_ac_build(ac: f64) -> R<Turn> {
    let musket = attack_roll(9.0, ac, rs(1.0, 12.0)?.plus(18.0)?)?;
    let poison = d20()
        .dc(14.0)?
        .on_save_failure_args(&[Arg::Roll(rs(2.0, 6.0)?)])?
        .save_half()?;
    let t = turn_of(&[&musket, &musket])?.on_any_miss_with(musket, rid("reroll"))?;
    let t = rider(&t, rs(1.0, 10.0)?)?.on_every_hit_with(poison, every_hit(None, None))?;
    Ok(kbd(&t)?)
}

#[test]
fn rebinds_declared_attacks_and_rider_carried_attacks_a_save_passes_through_unchanged() -> T {
    let mut w = want(
        VSAC,
        "rebinds declared attacks and rider-carried attacks; a save passes through unchanged",
    );
    for ac in [12.0, 18.0, 21.0] {
        let rebound = w.pmf(&vs_ac_build(15.0)?.vs_ac(ac)?);
        let direct = w.pmf(&vs_ac_build(ac)?);
        expect_same_pmf(&rebound, &direct);
    }
    let rebound = w.mean(&vs_ac_build(15.0)?.vs_ac(18.0)?);
    not_close(rebound, w.mean(&vs_ac_build(15.0)?), 2);
    w.done();
    Ok(())
}

#[test]
fn a_turn_with_no_state_dependent_step_keeps_0_11_0s_merge_key_count_at_every_step_o13_turn() -> T {
    let mut w = want(
        STATE,
        "a turn with no state-dependent step keeps 0.11.0's merge-key count at every step (O13 turn)",
    );
    let musket = attack_roll(9.0, 15.0, rs(1.0, 12.0)?.plus_dice(1.0, &d4())?.plus(18.0)?)?;
    let t = turn_of(&[&musket, &musket])?.on_any_miss_with(musket, rid("reroll"))?;
    let t = rider_with(
        &t,
        rs(1.0, 10.0)?,
        None,
        Some(&["attack 1", "attack 2", "reroll"]),
    )?;
    // 8997/160 exactly; the mean sits exactly 5e-5 from 56.23125. Pin the exact figure.
    close(w.mean(&t), 56.23125, 10);
    w.mean(&t); // `inspectTurn` reads the mean
    assert_eq!(t.inspect_turn()?.1, vec![3, 6, 7, 3]);
    w.done();
    Ok(())
}

fn o17_row(ac: f64, baseline: f64, with_reroll: f64, without: f64) -> T {
    let mut w = want(O17, &format!("AC {ac}"));
    let musket =
        attack_roll(9.0, ac, rs(1.0, 12.0)?.plus(18.0)?)?.plus_separate_damage(rs(1.0, 4.0)?);
    let base = turn_of(&[&musket, &musket])?.on_any_miss_with(musket, rid("reroll"))?;
    let base = rider_with(
        &base,
        rs(1.0, 10.0)?,
        None,
        Some(&["attack 1", "attack 2", "reroll"]),
    )?;
    // Exact rational baseline: assert precisely.
    close(w.mean(&base), baseline, 10);
    // The default `of` sees the reroll, so the short spelling is the right one.
    close(w.mean(&kbd(&base)?), with_reroll, 4);
    let without_reroll = w.mean(&kbd_with(
        &base,
        keep_best_damage(),
        None,
        Some(&["attack 1", "attack 2"]),
    )?);
    close(without_reroll, without, 4);
    not_close(without_reroll, with_reroll, 2);
    w.done();
    Ok(())
}

#[test]
fn ac_15() -> T {
    o17_row(15.0, 56.23125, 58.2388, 58.1432)
}

#[test]
fn ac_18() -> T {
    o17_row(18.0, 49.533, 51.4544, 51.2573)
}

#[test]
fn ac_21() -> T {
    o17_row(21.0, 40.342875, 42.0726, 41.7902)
}
