//! Translated TS tests: `src/builder/attack.test.ts`, `tests/attack-channels.test.ts` (all but
//! r23, which lives in `checks_deferred.rs`), `tests/natural-20-damage.test.ts`,
//! `tests/natural-twenty-crit.test.ts`, `tests/no-crit-expression.test.ts`,
//! `tests/damage-reroll-floor.test.ts`, `src/builder/typed.test.ts` (lines 26, 40, 44, 54, 60) and
//! `tests/attack-expression-round-trip.test.ts`.
//!
//! Deferred (turn engine): natural-20-damage.test.ts:139 and :148, natural-twenty-crit.test.ts:60,
//! no-crit-expression.test.ts:48.
//!
//! `expect(a).not.toBe(b)` on object identity (attack.test.ts:38, natural-20-damage.test.ts:127) has
//! no Rust counterpart: values are never shared, so those assertions are dropped.

use super::support::*;
use crate::Damage;
use crate::Pmf;
use crate::builder::ac::{Combined, combine};
use crate::builder::attack::{AttackBuilder, AttackOutcome};
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::types::{AdvantageDice, Check};
use crate::common::{Rng, RollType};
use crate::error::DiceError;
use crate::parser::{parse, parse_with};
use crate::turn::context::{ContextualSource, Dealt, RowContext};
use std::collections::{BTreeMap, VecDeque};

// ---- shorthands ----------------------------------------------------------------------------

fn n(v: f64) -> Arg {
    Arg::Num(v)
}

fn r(b: RollBuilder) -> Arg {
    Arg::Roll(b)
}

/// `roll(count, die)`.
fn rl(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

/// `roll(count, sides)`.
fn rs(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

/// `d20.plus(bonus).ac(ac)`.
fn check_of(bonus: f64, ac: f64) -> Result<RollBuilder, DiceError> {
    d20().plus(bonus)?.ac(ac)
}

/// `d20.plus(bonus).ac(ac).onHit(damage)`.
fn atk(bonus: f64, ac: f64, damage: RollBuilder) -> Result<AttackBuilder, DiceError> {
    check_of(bonus, ac)?.on_hit(damage)
}

/// `attack.resolve()` (default eps 0).
fn res_of(a: &AttackBuilder) -> Result<crate::builder::types::AttackResolution, DiceError> {
    a.resolve(0.0)
}

/// `expectSamePMF`: every bin within `toBeCloseTo(_, 10)`.
#[track_caller]
fn expect_same_pmf(actual: &Pmf, expected: &Pmf) {
    let mut support: Vec<f64> = actual.support().iter().map(|d| d.0).collect();
    support.extend(expected.support().iter().map(|d| d.0));
    for v in support {
        assert_close(actual.p_at(v), expected.p_at(v), 10);
    }
}

/// A `RowContext` of the plain flat roll (`tests/natural-20-damage.test.ts:17`).
fn plain() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: vec![],
        joined: vec![],
    }
}

/// A scripted `Rng`: `die` pops the next face whatever the sides, `chance` is never expected.
struct Script {
    faces: VecDeque<f64>,
    bad: Option<String>,
}

fn scripted(faces: &[f64]) -> Script {
    Script {
        faces: faces.iter().copied().collect(),
        bad: None,
    }
}

impl Rng for Script {
    fn die(&mut self, _sides: f64) -> f64 {
        if let Some(f) = self.faces.pop_front() {
            f
        } else {
            self.bad = Some("no faces left".to_string());
            1.0
        }
    }

    fn chance(&mut self, _p: f64) -> bool {
        self.bad = Some("no coins".to_string());
        false
    }
}

/// `attack.sample(scripted(faces))`, failing if the script ran dry or a coin was flipped.
fn sample_with(
    a: &AttackBuilder,
    faces: &[f64],
) -> Result<crate::builder::attack::AttackSample, DiceError> {
    let mut rng = scripted(faces);
    let s = a.sample(&mut rng, None)?;
    match rng.bad {
        Some(m) => Err(m.into()),
        None => Ok(s),
    }
}

// ---- enumerated distributions (tests/enumerate-dice.ts, integer values) -----------------------

type Dist = BTreeMap<i64, f64>;

fn point(v: i64) -> Dist {
    Dist::from([(v, 1.0)])
}

fn uniform(sides: i64) -> Dist {
    (1..=sides).map(|f| (f, 1.0 / sides as f64)).collect()
}

fn combine_dist(x: &Dist, y: &Dist, f: impl Fn(i64, i64) -> i64) -> Dist {
    let mut out = Dist::new();
    for (&a, &pa) in x {
        for (&b, &pb) in y {
            *out.entry(f(a, b)).or_insert(0.0) += pa * pb;
        }
    }
    out
}

fn add(parts: &[&Dist]) -> Dist {
    parts
        .iter()
        .fold(point(0), |acc, p| combine_dist(&acc, p, |a, b| a + b))
}

fn shift(x: &Dist, by: i64) -> Dist {
    let mut out = Dist::new();
    for (&v, &p) in x {
        *out.entry(v + by).or_insert(0.0) += p;
    }
    out
}

fn best(a: &Dist, b: &Dist) -> Dist {
    combine_dist(a, b, i64::max)
}

type Lab = BTreeMap<i64, BTreeMap<String, f64>>;

fn labelled(label: &str, dist: &Dist) -> Lab {
    dist.iter()
        .map(|(&v, &p)| (v, BTreeMap::from([(label.to_string(), p)])))
        .collect()
}

fn mix_labelled(parts: &[(Lab, f64)]) -> Lab {
    let mut out = Lab::new();
    for (part, weight) in parts {
        for (&value, labels) in part {
            let bin = out.entry(value).or_default();
            for (label, p) in labels {
                *bin.entry(label.clone()).or_insert(0.0) += weight * p;
            }
        }
    }
    out
}

fn labels_of(pmf: &Pmf, v: i64) -> BTreeMap<String, f64> {
    pmf.map
        .get(&Damage(v as f64))
        .map(|b| b.count.iter().map(|(k, p)| (k.clone(), *p)).collect())
        .unwrap_or_default()
}

/// `expectLabelled`: every bin and every label within 1e-12, no extra or missing support.
#[track_caller]
fn expect_labelled(actual: &Pmf, expected: &Lab) {
    let mut support: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.keys());
    support.sort_unstable();
    support.dedup();
    for v in support {
        let want = expected.get(&v).cloned().unwrap_or_default();
        let total: f64 = want.values().sum();
        let got_p = actual.p_at(v as f64);
        assert!(
            (got_p - total).abs() <= 1e-12,
            "bin {v}: {got_p} vs {total}"
        );
        let got = labels_of(actual, v);
        let mut names: Vec<&String> = got.keys().chain(want.keys()).collect();
        names.sort();
        names.dedup();
        for label in names {
            let g = got.get(label).copied().unwrap_or(0.0);
            let w = want.get(label).copied().unwrap_or(0.0);
            assert!((g - w).abs() <= 1e-12, "bin {v} {label}: {g} vs {w}");
        }
    }
    assert!((actual.mass() - 1.0).abs() <= 1e-12);
}

/// `expectSameLabelledPMF` (no-crit-expression.test.ts:17): same bins and labels, to 1e-12.
#[track_caller]
fn expect_same_labelled(actual: &Pmf, expected: &Pmf, context: &str) {
    let mut support: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.support().iter().map(|d| d.0 as i64));
    support.sort_unstable();
    support.dedup();
    for v in support {
        let (a, e) = (actual.p_at(v as f64), expected.p_at(v as f64));
        assert!((a - e).abs() <= 1e-12, "{context}: bin {v}: {a} vs {e}");
        let (ga, ge) = (labels_of(actual, v), labels_of(expected, v));
        let mut names: Vec<&String> = ga.keys().chain(ge.keys()).collect();
        names.sort();
        names.dedup();
        for label in names {
            let g = ga.get(label).copied().unwrap_or(0.0);
            let w = ge.get(label).copied().unwrap_or(0.0);
            assert!(
                (g - w).abs() <= 1e-12,
                "{context}: bin {v} label {label}: {g} vs {w}"
            );
        }
    }
}

/// `labelMass`: outcome label to its total probability over every bin.
fn label_mass(pmf: &Pmf) -> BTreeMap<String, f64> {
    let mut mass = BTreeMap::new();
    for bin in pmf.map.values() {
        for (label, p) in &bin.count {
            *mass.entry(label.clone()).or_insert(0.0) += p;
        }
    }
    mass
}

fn mass_of(m: &BTreeMap<String, f64>, label: &str) -> f64 {
    m.get(label).copied().unwrap_or(0.0)
}

// =============================================================================================
// src/builder/attack.test.ts
// =============================================================================================

/// src/builder/attack.test.ts:6
#[test]
fn should_build_an_attack_roll() -> T {
    let attack_roll = d20().plus(5.0)?.ac(15.0)?.on_hit(d8())?;
    assert_eq!(
        attack_roll.to_expression()?,
        "(d20 + 5 AC 15) * (1d8) crit (2d8)"
    );
    Ok(())
}

/// src/builder/attack.test.ts:27
#[test]
fn should_be_immutable() -> T {
    let check = check_of(5.0, 15.0)?;
    let hit_effect = rs(2.0, 6.0)?;
    let crit_effect = rs(4.0, 6.0)?;
    let attack_builder = check.on_hit(hit_effect)?.on_crit(&[r(crit_effect)])?;
    let original_expression = attack_builder.to_expression()?;

    // "Mutate" by creating a new builder
    let new_check = check.ac(20.0)?;
    assert_eq!(new_check.attack_config().and_then(|c| c.ac), Some(20.0));

    assert_eq!(attack_builder.to_expression()?, original_expression);
    assert_eq!(
        attack_builder.check.attack_config().and_then(|c| c.ac),
        Some(15.0)
    );
    Ok(())
}

/// src/builder/attack.test.ts:47
#[test]
fn should_calculate_correct_probabilities_for_a_simple_attack() -> T {
    let attack = check_of(5.0, 15.0)?.on_hit_args(&[n(1.0), n(8.0), n(3.0)])?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.45, 2);
    assert_close(resolution.weights.hit, 0.5, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    let expected_mean = 0.5 * 7.5 + 0.05 * 12.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:59
#[test]
fn should_calculate_correct_probabilities_with_advantage() -> T {
    let attack =
        d20()
            .with_advantage()?
            .plus(5.0)?
            .ac(15.0)?
            .on_hit_args(&[n(1.0), n(8.0), n(3.0)])?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.2025, 2);
    assert_close(resolution.weights.hit, 0.7, 2);
    assert_close(resolution.weights.crit, 0.0975, 2);
    let expected_mean = 0.7 * 7.5 + 0.0975 * 12.0 + 0.2025 * 0.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:71
#[test]
fn should_calculate_correct_probabilities_with_disadvantage() -> T {
    let attack = d20()
        .with_disadvantage()?
        .plus(5.0)?
        .ac(15.0)?
        .on_hit_args(&[n(1.0), n(8.0), n(3.0)])?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.6975, 2);
    assert_close(resolution.weights.hit, 0.3, 2);
    assert_close(resolution.weights.crit, 0.0025, 2);
    let expected_mean = 0.3 * 7.5 + 0.0025 * 12.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:83
#[test]
fn should_handle_on_miss_effects() -> T {
    let attack = check_of(5.0, 15.0)?
        .on_hit_args(&[n(1.0), n(8.0), n(3.0)])?
        .on_miss(&[r(d4())])?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.45, 2);
    assert_close(resolution.weights.hit, 0.5, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    let expected_mean = 0.5 * 7.5 + 0.05 * 12.0 + 0.45 * 2.5;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:96
#[test]
fn should_handle_on_crit_effects() -> T {
    let attack = check_of(5.0, 15.0)?
        .on_hit_args(&[n(1.0), n(8.0), n(3.0)])?
        .on_crit(&[n(3.0), n(8.0), n(3.0)])?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.45, 2);
    assert_close(resolution.weights.hit, 0.5, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    let expected_mean = 0.5 * 7.5 + 0.05 * 16.5;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:109
#[test]
fn should_handle_no_crit() -> T {
    let attack = check_of(5.0, 15.0)?
        .on_hit_args(&[n(1.0), n(8.0), n(3.0)])?
        .no_crit()?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.45, 2);
    assert_close(resolution.weights.hit, 0.55, 2);
    assert_close(resolution.weights.crit, 0.0, 2);
    let expected_mean = 0.55 * 7.5;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:122
#[test]
fn should_handle_bonus_dice() -> T {
    let bless = d4();
    let attack = d20()
        .plus(5.0)?
        .with_bonus(&bless)?
        .ac(15.0)?
        .on_hit_args(&[n(1.0), n(8.0), n(3.0)])?;
    let resolution = res_of(&attack)?;
    let psuccess = 0.675;
    let pcrit = 0.05;
    let phit = psuccess - pcrit;
    let pmiss = 1.0 - psuccess;
    assert_close(resolution.weights.miss, pmiss, 2);
    assert_close(resolution.weights.hit, phit, 2);
    assert_close(resolution.weights.crit, pcrit, 2);
    let expected_mean = phit * 7.5 + pcrit * 12.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:140
#[test]
fn should_preserve_advantage_crit_odds_with_always_hits() -> T {
    let attack = d20().with_advantage()?.always_hits()?.on_hit(d8())?;
    let res = res_of(&attack)?;
    assert_close(res.weights.crit, 0.0975, 5);
    assert_close(res.weights.hit, 1.0 - 0.0975, 5);
    assert_close(res.weights.miss, 0.0, 10);
    Ok(())
}

/// src/builder/attack.test.ts:149
#[test]
fn should_convert_all_hits_to_crits_with_always_crits_on_ac_builder_but_nat_1s_still_miss() -> T {
    let attack = check_of(5.0, 10.0)?.always_crits()?.on_hit(d8())?;
    let res = res_of(&attack)?;
    assert_close(res.weights.miss, 0.2, 5);
    assert_close(res.weights.crit, 0.8, 5);
    assert_close(res.weights.hit, 0.0, 5);
    Ok(())
}

/// src/builder/attack.test.ts:159
#[test]
fn should_make_everything_a_crit_with_always_hits_always_crits() -> T {
    let attack = d20().always_hits()?.always_crits()?.on_hit(d8())?;
    let res = res_of(&attack)?;
    assert_close(res.weights.miss, 0.0, 10);
    assert_close(res.weights.crit, 1.0, 10);
    assert_close(res.weights.hit, 0.0, 10);
    Ok(())
}

/// src/builder/attack.test.ts:168
#[test]
fn should_preserve_advantage_with_always_crits_on_ac_builder() -> T {
    let attack = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(10.0)?
        .always_crits()?
        .on_hit(d8())?;
    let res = res_of(&attack)?;
    assert_close(res.weights.miss, 0.04, 4);
    assert_close(res.weights.crit, 0.96, 4);
    assert_close(res.weights.hit, 0.0, 10);
    Ok(())
}

/// src/builder/attack.test.ts:178
#[test]
fn should_work_with_always_hits_always_crits_and_advantage() -> T {
    let attack = d20()
        .with_advantage()?
        .always_hits()?
        .always_crits()?
        .on_hit(d8())?;
    let res = res_of(&attack)?;
    assert_close(res.weights.miss, 0.0, 10);
    assert_close(res.weights.crit, 1.0, 10);
    assert_close(res.weights.hit, 0.0, 10);
    Ok(())
}

/// src/builder/attack.test.ts:187
#[test]
fn should_show_damage_decreases_as_ac_increases_with_always_crits() -> T {
    let damage = rl(1.0, d8())?.plus(3.0)?;
    let build = |ac: f64| -> Result<AttackBuilder, DiceError> {
        d20()
            .plus(7.0)?
            .ac(ac)?
            .always_crits()?
            .on_hit(damage.clone())
    };
    let dpr_ac10 = build(10.0)?.to_pmf(0.0)?.mean();
    let dpr_ac20 = build(20.0)?.to_pmf(0.0)?.mean();
    let dpr_ac25 = build(25.0)?.to_pmf(0.0)?.mean();

    assert!(dpr_ac10 > dpr_ac20);
    assert!(dpr_ac20 > dpr_ac25);

    assert_close(dpr_ac10, 10.8, 1);
    assert_close(dpr_ac20, 4.8, 1);
    assert_close(dpr_ac25, 1.8, 1);
    Ok(())
}

/// src/builder/attack.test.ts:217
#[test]
fn should_handle_an_attack_with_no_on_hit_effect() -> T {
    let check = check_of(5.0, 15.0)?;
    let pmf = check.to_pmf(0.0)?;
    assert_close(pmf.mean(), 11.0, 2);
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 25.0);
    Ok(())
}

/// src/builder/attack.test.ts:226
#[test]
fn should_handle_a_guaranteed_hit_scenario_but_still_miss_on_a_1() -> T {
    let attack = atk(20.0, 5.0, d6())?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.05, 2);
    assert_close(resolution.weights.hit, 0.9, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    let expected_mean = 0.9 * 3.5 + 0.05 * 7.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:237
#[test]
fn should_handle_an_impossible_hit_scenario_but_still_crit_on_a_20() -> T {
    let attack = atk(0.0, 30.0, d6())?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.95, 2);
    assert_close(resolution.weights.hit, 0.0, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    let expected_mean = 0.05 * 7.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:248
#[test]
fn should_still_miss_on_a_natural_1_even_with_high_bonuses() -> T {
    let attack = atk(20.0, 10.0, d6())?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.05, 2);
    assert_close(resolution.weights.hit, 0.9, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    let expected_mean = 0.9 * 3.5 + 0.05 * 7.0;
    assert_close(resolution.pmf.mean(), expected_mean, 2);
    Ok(())
}

/// src/builder/attack.test.ts:259
#[test]
fn should_still_miss_on_a_natural_1_with_advantage() -> T {
    let attack = d20().with_advantage()?.plus(20.0)?.ac(10.0)?.on_hit(d6())?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 1.0 / 400.0, 2);
    assert_close(resolution.weights.crit, 39.0 / 400.0, 2);
    assert_close(resolution.weights.hit, 1.0 - 40.0 / 400.0, 2);
    Ok(())
}

/// src/builder/attack.test.ts:268
#[test]
fn should_still_miss_on_a_natural_1_with_disadvantage() -> T {
    let attack = d20()
        .with_disadvantage()?
        .plus(20.0)?
        .ac(10.0)?
        .on_hit(d6())?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 39.0 / 400.0, 2);
    assert_close(resolution.weights.crit, 1.0 / 400.0, 2);
    assert_close(resolution.weights.hit, 1.0 - 40.0 / 400.0, 2);
    Ok(())
}

/// src/builder/attack.test.ts:279
#[test]
fn should_double_crit_dice_for_keep_highest() -> T {
    let attack = atk(
        13.0,
        20.0,
        rl(1.0, d4())?.keep_highest(2.0, 1.0)?.plus(2.0)?,
    )?;
    assert_eq!(
        attack.to_expression()?,
        "(d20 + 13 AC 20) * (2kh1(1d4) + 2) crit (2kh1(2d4) + 2)"
    );
    Ok(())
}

/// src/builder/attack.test.ts:289
#[test]
fn should_refuse_to_auto_double_a_keep_lowest_crit_and_render_an_explicit_one() -> T {
    let attack = atk(10.0, 18.0, rl(1.0, d6())?.keep_lowest(3.0, 2.0)?.plus(3.0)?)?;
    assert_throws(attack.to_expression(), "3kl2");
    assert_eq!(
        attack
            .on_crit(&[Arg::Str("3kl2(2d6) + 3".to_string())])?
            .to_expression()?,
        "(d20 + 10 AC 18) * (3kl2(1d6) + 3) crit (3kl2(2d6) + 3)"
    );
    Ok(())
}

/// src/builder/attack.test.ts:300
#[test]
fn should_handle_2kh1_1d12_with_correct_expected_value() -> T {
    let attack = atk(
        11.0,
        15.0,
        rl(1.0, d12())?.keep_highest(2.0, 1.0)?.plus(5.0)?,
    )?;
    assert_eq!(
        attack.to_expression()?,
        "(d20 + 11 AC 15) * (2kh1(1d12) + 5) crit (2kh1(2d12) + 5)"
    );

    let keep_highest_component = rl(1.0, d12())?.keep_highest(2.0, 1.0)?;
    let pmf = keep_highest_component.to_pmf(0.0)?;
    assert_close(pmf.mean(), 8.4861, 3);

    let damage_roll = rl(1.0, d12())?.keep_highest(2.0, 1.0)?.plus(5.0)?;
    assert_close(damage_roll.to_pmf(0.0)?.mean(), 13.4861, 3);

    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.hit, 0.8, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    assert_close(resolution.weights.miss, 0.15, 2);

    let expected_dpr = 11.828192515432098;
    assert_close(resolution.pmf.mean(), expected_dpr, 2);
    Ok(())
}

/// src/builder/attack.test.ts:333
#[test]
fn odie_for_an_attack_like_this_even_though_its_a_plus_0_you_should_expect_it_to_still_do_the_crit_damage_that_being_point_9_damage()
-> T {
    let attack = d20().ac(21.0)?.on_hit_args(&[n(2.0), r(d6()), n(4.0)])?;
    let resolution = res_of(&attack)?;
    assert_close(resolution.weights.miss, 0.95, 2);
    assert_close(resolution.weights.hit, 0.0, 2);
    assert_close(resolution.weights.crit, 0.05, 2);
    assert_close(resolution.pmf.mean(), 0.9, 2);
    Ok(())
}

// =============================================================================================
// tests/attack-channels.test.ts
// =============================================================================================

/// tests/attack-channels.test.ts:16
#[test]
fn equals_the_folded_expression_bin_for_bin_hit_and_crit_before_any_substitution_reads_the_channel()
-> T {
    let split = atk(9.0, 16.0, rs(2.0, 6.0)?.plus(5.0)?)?;
    let split = split.plus_separate_damage(rl(2.0, d6())?);
    let folded = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?.plus_dice(2.0, &d6())?)?;

    let split_res = res_of(&split)?;
    let folded_res = res_of(&folded)?;
    expect_same_pmf(&split_res.hit, &folded_res.hit);
    expect_same_pmf(&split_res.crit, &folded_res.crit);
    assert_close(split_res.hit.mean(), 19.0, 10);
    assert_close(split_res.crit.mean(), 33.0, 10);
    Ok(())
}

/// tests/attack-channels.test.ts:28
#[test]
fn accumulates_across_several_calls_convolving_every_channel_in() -> T {
    let two_channels = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?
        .plus_separate_damage(rl(1.0, d6())?)
        .plus_separate_damage(rl(1.0, d6())?);
    let one_channel =
        atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?.plus_separate_damage(rl(2.0, d6())?);
    expect_same_pmf(&res_of(&two_channels)?.hit, &res_of(&one_channel)?.hit);
    Ok(())
}

/// tests/attack-channels.test.ts:39
#[test]
fn doubles_under_an_explicit_on_crit_too_the_override_describes_only_the_base_payload() -> T {
    let attack = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?
        .on_crit(&[r(rl(1.0, d6())?)])?
        .plus_separate_damage(rl(2.0, d6())?);
    let res = res_of(&attack)?;
    assert_close(res.crit_base.mean(), 3.5, 10);
    assert_close(res.crit.mean(), 17.5, 10);
    Ok(())
}

/// tests/attack-channels.test.ts:51
#[test]
fn is_excluded_from_the_dice_match_descriptor_only_the_base_pool_counts_toward_a_match() -> T {
    let with_channel =
        atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?.plus_separate_damage(rl(2.0, d6())?);
    let base_only = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?;
    let (with_hit, _) = with_channel.dice_match_info(0.0)?;
    let (base_hit, _) = base_only.dice_match_info(0.0)?;
    let with_hit = with_hit.ok_or("withInfo.hit is null")?;
    let base_hit = base_hit.ok_or("baseInfo.hit is null")?;
    for (damage, p) in &base_hit.match_probability_by_damage {
        let got = with_hit
            .match_probability_by_damage
            .get(damage)
            .ok_or_else(|| DiceError::error(format!("no match probability at {}", damage.0)))?;
        assert_close(*got, *p, 12);
    }
    Ok(())
}

/// tests/attack-channels.test.ts:62
#[test]
fn hit_base_crit_base_equal_hit_crit_exactly_when_there_are_no_channels() -> T {
    let attack = check_of(9.0, 16.0)?.on_hit_args(&[n(2.0), r(d6()), n(5.0)])?;
    let res = res_of(&attack)?;
    expect_same_pmf(&res.hit, &res.hit_base);
    expect_same_pmf(&res.crit, &res.crit_base);
    Ok(())
}

fn channel_sets() -> Result<Vec<Vec<RollBuilder>>, DiceError> {
    Ok(vec![
        vec![rl(2.0, d6())?],
        vec![rl(1.0, d6())?, rl(1.0, d6())?],
    ])
}

/// tests/attack-channels.test.ts:71
#[test]
fn hit_crit_equal_hit_base_crit_base_convolved_with_hit_separate_crit_separate_auto_double_crit_one_and_two_channels()
-> T {
    for channels in channel_sets()? {
        let mut attack = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?;
        for ch in channels {
            attack = attack.plus_separate_damage(ch);
        }
        let res = res_of(&attack)?;
        expect_same_pmf(
            &res.hit,
            &res.hit_base.convolve(&res.hit_separate, None, false),
        );
        expect_same_pmf(
            &res.crit,
            &res.crit_base.convolve(&res.crit_separate, None, false),
        );
    }
    Ok(())
}

/// tests/attack-channels.test.ts:81
#[test]
fn hit_crit_equal_hit_base_crit_base_convolved_with_hit_separate_crit_separate_explicit_on_crit_path()
-> T {
    for channels in channel_sets()? {
        let mut attack =
            atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?.on_crit(&[r(rl(1.0, d6())?)])?;
        for ch in channels {
            attack = attack.plus_separate_damage(ch);
        }
        let res = res_of(&attack)?;
        expect_same_pmf(
            &res.hit,
            &res.hit_base.convolve(&res.hit_separate, None, false),
        );
        expect_same_pmf(
            &res.crit,
            &res.crit_base.convolve(&res.crit_separate, None, false),
        );
    }
    Ok(())
}

/// tests/attack-channels.test.ts:91
#[test]
fn hit_separate_crit_separate_are_delta_0_mass_1_with_no_channels_hit_crit_unchanged() -> T {
    let attack = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?;
    let res = res_of(&attack)?;
    assert_close(res.hit_separate.mass(), 1.0, 12);
    assert_close(res.hit_separate.p_at(0.0), 1.0, 12);
    assert_close(res.crit_separate.mass(), 1.0, 12);
    assert_close(res.crit_separate.p_at(0.0), 1.0, 12);
    expect_same_pmf(&res.hit, &res.hit_base);
    expect_same_pmf(&res.crit, &res.crit_base);
    Ok(())
}

/// tests/attack-channels.test.ts:102
#[test]
fn o10_payload_level_hit_base_max_of_two_convolved_with_hit_separate_is_20_3719_34_9334_not_hit_max_of_twos_20_9334_35_7296()
-> T {
    let attack = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?.plus_separate_damage(rl(2.0, d6())?);
    let res = res_of(&attack)?;
    let correct_hit = res
        .hit_base
        .max_of_two()
        .convolve(&res.hit_separate, None, false);
    let correct_crit = res
        .crit_base
        .max_of_two()
        .convolve(&res.crit_separate, None, false);
    let wrong_hit = res.hit.max_of_two();
    let wrong_crit = res.crit.max_of_two();
    assert_close(correct_hit.mean(), 20.3719, 4);
    assert_close(correct_crit.mean(), 34.9334, 4);
    assert_close(wrong_hit.mean(), 20.9334, 4);
    assert_close(wrong_crit.mean(), 35.7296, 4);
    assert!(!close(correct_hit.mean(), wrong_hit.mean(), 4));
    assert!(!close(correct_crit.mean(), wrong_crit.mean(), 4));
    Ok(())
}

/// tests/attack-channels.test.ts:119
#[test]
fn o1_covers_every_base_die_group_not_just_the_last_one_chained() -> T {
    let attack = atk(5.0, 15.0, rl(1.0, d8())?.plus_dice(2.0, &d6())?)?.reroll_damage(1.0)?;
    assert_close(res_of(&attack)?.hit_base.mean(), 12.7708, 4);
    assert!(!close(res_of(&attack)?.hit_base.mean(), 12.3333, 4));
    Ok(())
}

type DieFn = fn() -> RollBuilder;

/// tests/attack-channels.test.ts:126
#[test]
fn is_a_permission_cap_r24_monotone_non_decreasing_in_k_peaking_at_floor_sides_over_2() -> T {
    let cases: [(DieFn, usize, usize); 5] = [
        (d4, 4, 2),
        (d6, 6, 3),
        (d8, 8, 4),
        (d10, 10, 5),
        (d12, 12, 6),
    ];
    for (die, sides, peak) in cases {
        let mut means: Vec<f64> = Vec::new();
        for k in 1..=sides {
            let attack = atk(5.0, 15.0, rl(2.0, die())?)?.reroll_damage(k as f64)?;
            means.push(res_of(&attack)?.hit_base.mean());
        }
        for k in 1..means.len() {
            assert!(
                means[k] >= means[k - 1] - 1e-9,
                "sides {sides} k={} vs k={k}",
                k + 1
            );
        }
        assert_close(means[peak - 1], means[sides - 1], 6);
    }
    Ok(())
}

/// tests/attack-channels.test.ts:149
#[test]
fn reroll_damage_2_on_a_d6_still_equals_reroll_2_a_threshold_of_2_is_unchanged_by_the_cap() -> T {
    let via_attack = atk(5.0, 15.0, rl(2.0, d6())?)?.reroll_damage(2.0)?;
    let direct = atk(5.0, 15.0, rl(2.0, d6())?.reroll(2.0)?)?;
    expect_same_pmf(&res_of(&via_attack)?.hit_base, &res_of(&direct)?.hit_base);
    Ok(())
}

/// tests/attack-channels.test.ts:155
#[test]
fn reroll_damage_5_on_a_d6_clamps_to_reroll_3_8_5000_for_2d6_not_7_8333_bin_for_bin_hit_and_crit()
-> T {
    let attack = atk(5.0, 15.0, rl(2.0, d6())?)?.reroll_damage(5.0)?;
    let direct = atk(5.0, 15.0, rl(2.0, d6())?.reroll(3.0)?)?;
    let resolved = res_of(&attack)?;
    let direct_resolved = res_of(&direct)?;
    expect_same_pmf(&resolved.hit_base, &direct_resolved.hit_base);
    expect_same_pmf(&resolved.crit_base, &direct_resolved.crit_base);
    assert_close(resolved.hit_base.mean(), 8.5, 4);
    assert!(!close(resolved.hit_base.mean(), 7.8333, 4));
    Ok(())
}

/// tests/attack-channels.test.ts:166
#[test]
fn roll_builder_reroll_5_stays_an_uncapped_obligation_7_8333_for_2d6() -> T {
    let attack = atk(5.0, 15.0, rl(2.0, d6())?.reroll(5.0)?)?;
    assert_close(res_of(&attack)?.hit_base.mean(), 7.8333, 4);
    Ok(())
}

/// tests/attack-channels.test.ts:171
#[test]
fn conflicting_reroll_damage_thresholds_throw_a_plain_error_the_same_value_twice_is_a_no_op() -> T {
    let base = atk(5.0, 15.0, rl(2.0, d6())?)?;
    assert_throws(
        base.reroll_damage(1.0)?.reroll_damage(3.0),
        "Conflicting rerollDamage",
    );
    let noop = base.reroll_damage(2.0)?.reroll_damage(2.0)?;
    assert_close(res_of(&noop)?.hit_base.mean(), 8.3333, 4);
    Ok(())
}

/// tests/attack-channels.test.ts:189
#[test]
fn conflicting_minimum_damage_die_values_throw_a_plain_error_the_same_value_twice_is_a_no_op() -> T
{
    let base = atk(5.0, 15.0, rl(2.0, d6())?)?;
    assert_throws(
        base.minimum_damage_die(3.0)?.minimum_damage_die(4.0),
        "Conflicting minimumDamageDie",
    );
    let noop = base.minimum_damage_die(3.0)?.minimum_damage_die(3.0)?;
    assert_close(res_of(&noop)?.hit_base.mean(), 8.0, 10);
    Ok(())
}

/// tests/attack-channels.test.ts:202
#[test]
fn order_independence_dice_then_fighting_style_equals_fighting_style_then_dice() -> T {
    let a = atk(9.0, 16.0, rl(2.0, d6())?.reroll(2.0)?.plus(5.0)?)?
        .plus_separate_damage(rl(2.0, d6())?);
    let b = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?
        .plus_separate_damage(rl(2.0, d6())?)
        .reroll_damage(2.0)?;
    expect_same_pmf(&res_of(&a)?.hit, &res_of(&b)?.hit);
    expect_same_pmf(&res_of(&a)?.crit, &res_of(&b)?.crit);
    Ok(())
}

/// tests/attack-channels.test.ts:219
#[test]
fn refuses_rather_than_silently_no_oping_a_payload_with_no_dice_descriptor() -> T {
    let parsed = check_of(9.0, 16.0)?.on_hit_args(&[Arg::Str("2d6+5".to_string())])?;
    assert_throws(parsed.reroll_damage(2.0), "dice descriptor");
    assert_throws(parsed.minimum_damage_die(3.0), "dice descriptor");
    Ok(())
}

/// tests/attack-channels.test.ts:225
#[test]
fn an_explicit_on_crit_gets_the_same_transforms_whether_it_is_set_before_or_after_them() -> T {
    let crit_before = atk(5.0, 15.0, rl(2.0, d6())?)?
        .on_crit(&[r(rl(4.0, d6())?)])?
        .reroll_damage(2.0)?
        .minimum_damage_die(2.0)?;
    let crit_after = atk(5.0, 15.0, rl(2.0, d6())?)?
        .reroll_damage(2.0)?
        .minimum_damage_die(2.0)?
        .on_crit(&[r(rl(4.0, d6())?)])?;
    expect_same_pmf(
        &res_of(&crit_after)?.crit_base,
        &res_of(&crit_before)?.crit_base,
    );
    assert!(res_of(&crit_after)?.crit_base.mean() > 14.5);
    Ok(())
}

/// tests/attack-channels.test.ts:245
#[test]
fn an_explicit_on_crit_with_no_dice_descriptor_is_refused_once_a_transform_is_set() -> T {
    let attack = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?.reroll_damage(2.0)?;
    assert_throws(
        attack.on_crit(&[Arg::Str("4d6+5".to_string())]),
        "dice descriptor",
    );
    Ok(())
}

/// tests/attack-channels.test.ts:252
#[test]
fn miss_payload_is_floor_resolved_hit_payload_over_2_base_plus_every_separate_channel_never_crit()
-> T {
    let attack = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?
        .plus_separate_damage(rl(2.0, d6())?)
        .half_on_miss()?;
    let res = res_of(&attack)?;
    let direct_floor = res_of(&atk(9.0, 16.0, rl(4.0, d6())?.plus(5.0)?)?)?
        .hit
        .scale_damage(0.5, "floor", 1.0)?;
    expect_same_pmf(&res.miss, &direct_floor);
    assert!(!close(res.miss.mean(), res.crit.mean() / 2.0, 2));
    Ok(())
}

/// tests/attack-channels.test.ts:265
#[test]
fn labels_the_miss_branch_miss_damage_and_leaves_hit_crit_weights_untouched() -> T {
    let plain = check_of(9.0, 16.0)?.on_hit_args(&[n(2.0), r(d6()), n(5.0)])?;
    let half = plain.half_on_miss()?;
    assert_eq!(res_of(&plain)?.weights, res_of(&half)?.weights);
    assert_close(
        res_of(&half)?.pmf.filter_outcome("missDamage").mass(),
        0.3,
        10,
    );
    assert_eq!(res_of(&half)?.pmf.filter_outcome("missNone").mass(), 0.0);
    Ok(())
}

/// tests/attack-channels.test.ts:273
#[test]
fn half_on_miss_and_on_miss_refuse_to_combine_in_either_order_throwing_a_plain_error() -> T {
    let base = check_of(5.0, 15.0)?.on_hit_args(&[n(2.0), r(d6()), n(5.0)])?;
    err_of(base.half_on_miss()?.on_miss(&[n(3.0)]));
    err_of(base.on_miss(&[n(3.0)])?.half_on_miss());
    Ok(())
}

/// tests/attack-channels.test.ts:292
#[test]
fn throws_for_a_plus_separate_damage_channel_or_half_on_miss_instead_of_dropping_it() -> T {
    let plain = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?;
    assert_eq!(
        plain.to_expression()?,
        "(d20 + 9 AC 16) * (2d6 + 5) crit (4d6 + 5)"
    );
    assert_throws(
        plain.plus_separate_damage(rl(2.0, d6())?).to_expression(),
        "plusSeparateDamage",
    );
    assert_throws(plain.half_on_miss()?.to_expression(), "halfOnMiss");
    Ok(())
}

/// tests/attack-channels.test.ts:301
#[test]
fn re_deriving_advantage_equals_building_the_same_attack_with_with_advantage_before_ac_bin_for_bin()
-> T {
    let via_with_check = check_of(5.0, 15.0)?
        .on_hit_args(&[n(1.0), r(d8()), n(3.0)])?
        .with_check(|mut c: Check| {
            c.roll_type = RollType::Advantage;
            c
        })?;
    let direct =
        d20()
            .with_advantage()?
            .plus(5.0)?
            .ac(15.0)?
            .on_hit_args(&[n(1.0), r(d8()), n(3.0)])?;

    expect_same_pmf(&res_of(&via_with_check)?.hit, &res_of(&direct)?.hit);
    expect_same_pmf(&res_of(&via_with_check)?.crit, &res_of(&direct)?.crit);
    assert_eq!(res_of(&via_with_check)?.weights, res_of(&direct)?.weights);
    Ok(())
}

/// tests/attack-channels.test.ts:314
#[test]
fn crit_on_hit_delegates_to_the_always_crits_path_and_round_trips_back_to_the_original() -> T {
    let attack = check_of(9.0, 16.0)?.on_hit_args(&[n(2.0), r(d6()), n(5.0)])?;
    let via_crit_on_hit = attack.with_check(|mut c: Check| {
        c.crit_on_hit = true;
        c
    })?;
    let via_always_crits =
        check_of(9.0, 16.0)?
            .always_crits()?
            .on_hit_args(&[n(2.0), r(d6()), n(5.0)])?;
    assert_eq!(
        res_of(&via_crit_on_hit)?.weights,
        res_of(&via_always_crits)?.weights
    );

    let round_trip = via_crit_on_hit.with_check(|mut c: Check| {
        c.crit_on_hit = false;
        c
    })?;
    assert_eq!(res_of(&round_trip)?.weights, res_of(&attack)?.weights);
    Ok(())
}

/// tests/attack-channels.test.ts:324
#[test]
fn throws_when_the_check_has_no_ac_to_rebind_an_always_hit_source() -> T {
    let always_hit = d6().always_hits()?.on_hit_args(&[n(1.0), r(d4())])?;
    assert_throws(
        always_hit.with_check(|mut c: Check| {
            c.roll_type = RollType::Advantage;
            c
        }),
        "AC",
    );
    Ok(())
}

/// tests/attack-channels.test.ts:331
#[test]
fn is_numerically_unchanged_from_the_legacy_with_elven_accuracy_path_bin_for_bin() -> T {
    for ac in [12.0, 15.0] {
        let legacy = d20()
            .with_elven_accuracy()?
            .plus(5.0)?
            .ac(ac)?
            .on_hit_args(&[n(1.0), r(d8()), n(3.0)])?;
        let via_three_dice = check_of(5.0, ac)?
            .three_dice_advantage()?
            .on_hit_args(&[n(1.0), r(d8()), n(3.0)])?
            .with_check(|mut c: Check| {
                c.roll_type = RollType::Advantage;
                c
            })?;
        assert_eq!(res_of(&via_three_dice)?.weights, res_of(&legacy)?.weights);
        expect_same_pmf(&res_of(&via_three_dice)?.hit, &res_of(&legacy)?.hit);
        expect_same_pmf(&res_of(&via_three_dice)?.crit, &res_of(&legacy)?.crit);
    }
    Ok(())
}

/// tests/attack-channels.test.ts:347
#[test]
fn ac_builder_copy_ac_rebinds_the_ac_copy_with_no_argument_reuses_the_current_one() -> T {
    let base = check_of(9.0, 16.0)?.three_dice_advantage()?;
    let rebound = base.copy_with_ac(Some(20.0))?;
    assert_eq!(rebound.attack_config().and_then(|c| c.ac), Some(20.0));
    assert_eq!(rebound.advantage_dice(), Some(AdvantageDice::Three));
    let same = base.copy_with_ac(None)?;
    assert_eq!(same.attack_config().and_then(|c| c.ac), Some(16.0));
    Ok(())
}

/// tests/attack-channels.test.ts:356
#[test]
fn o30_payload_level_a_granted_advantage_rolls_3_dice_when_advantage_dice_is_3_2_otherwise() -> T {
    let advantage = |mut c: Check| {
        c.roll_type = RollType::Advantage;
        c
    };
    let granted_three = check_of(5.0, 12.0)?
        .three_dice_advantage()?
        .on_hit_args(&[n(1.0)])?
        .with_check(advantage)?;
    let granted_two = check_of(5.0, 12.0)?
        .on_hit_args(&[n(1.0)])?
        .with_check(advantage)?;
    let land_three = res_of(&granted_three)?.weights;
    let land_two = res_of(&granted_two)?.weights;
    assert_close(land_three.hit + land_three.crit, 0.973, 6);
    assert_close(land_two.hit + land_two.crit, 0.91, 6);
    Ok(())
}

/// tests/attack-channels.test.ts:374
#[test]
fn combine_the_full_r30_cancellation_table_across_roll_type_x_advantage_dice_x_grant_flags() -> T {
    // (advantage, disadvantage) grant flags: none, adv, dis, both.
    let flags = [(false, false), (true, false), (false, true), (true, true)];
    let flat = Combined {
        roll_type: RollType::Flat,
        dice: 1,
    };
    let dis = Combined {
        roll_type: RollType::Disadvantage,
        dice: 2,
    };
    for (advantage_dice, dice) in [(AdvantageDice::Two, 2u8), (AdvantageDice::Three, 3u8)] {
        let adv = Combined {
            roll_type: RollType::Advantage,
            dice,
        };
        let table: [(RollType, [Combined; 4]); 3] = [
            (RollType::Flat, [flat, adv, dis, flat]),
            (RollType::Advantage, [adv, adv, flat, flat]),
            (RollType::Disadvantage, [dis, flat, dis, flat]),
        ];
        for (roll_type, wants) in table {
            for ((a, d), want) in flags.iter().zip(wants) {
                assert_eq!(
                    combine(roll_type, advantage_dice, *a, *d),
                    want,
                    "{roll_type:?} {advantage_dice:?} adv={a} dis={d}"
                );
            }
        }
    }
    Ok(())
}

/// tests/attack-channels.test.ts:412
#[test]
fn does_not_collide_two_attacks_differing_only_by_a_plus_separate_damage_channel() -> T {
    let base = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?;
    let with_extra = base.plus_separate_damage(rl(2.0, d6())?);
    assert_close(base.to_pmf(0.0)?.mean(), 8.75, 10);
    assert_close(with_extra.to_pmf(0.0)?.mean(), 14.0, 10);
    assert_close(base.to_pmf(0.0)?.mean(), 8.75, 10);
    assert_close(with_extra.to_pmf(0.0)?.mean(), 14.0, 10);
    Ok(())
}

/// tests/attack-channels.test.ts:422
#[test]
fn does_not_collide_two_attacks_differing_only_by_half_on_miss() -> T {
    let plain = atk(9.0, 16.0, rl(2.0, d6())?.plus(5.0)?)?;
    let with_half = plain.half_on_miss()?;
    assert_close(plain.to_pmf(0.0)?.mean(), 8.75, 10);
    assert_close(with_half.to_pmf(0.0)?.mean(), 10.475, 10);
    Ok(())
}

// =============================================================================================
// tests/natural-20-damage.test.ts
// =============================================================================================

/// An extra too large for any other part of the payload to reach.
const EXTRA: f64 = 100.0;

fn boon_check() -> Result<RollBuilder, DiceError> {
    check_of(5.0, 10.0)
}

/// tests/natural-20-damage.test.ts:45
#[test]
fn crit_range_18_20_flat_p_natural_20_1_20_against_p_crit_3_20() -> T {
    let pmf = boon_check()?
        .crit_on(18.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_close(pmf.outcome_probability("crit"), 3.0 / 20.0, 15);
    assert_close(pmf.tail_prob_ge(EXTRA), 1.0 / 20.0, 15);
    Ok(())
}

/// tests/natural-20-damage.test.ts:51
#[test]
fn advantage_p_natural_20_1_19_20_2_p_crit_18_20_1_17_20_2() -> T {
    let pmf = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(10.0)?
        .crit_on(18.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_close(pmf.tail_prob_ge(EXTRA), 1.0 - (19.0f64 / 20.0).powi(2), 15);
    assert_close(
        pmf.outcome_probability("crit"),
        1.0 - (17.0f64 / 20.0).powi(2),
        15,
    );
    Ok(())
}

/// tests/natural-20-damage.test.ts:57
#[test]
fn disadvantage_p_natural_20_1_20_2() -> T {
    let pmf = d20()
        .with_disadvantage()?
        .plus(5.0)?
        .ac(10.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_close(pmf.tail_prob_ge(EXTRA), 1.0 / 400.0, 15);
    Ok(())
}

/// tests/natural-20-damage.test.ts:62
#[test]
fn elven_accuracy_three_dice_p_natural_20_1_19_20_3() -> T {
    let pmf = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(10.0)?
        .three_dice_advantage()?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_close(pmf.tail_prob_ge(EXTRA), 1.0 - (19.0f64 / 20.0).powi(3), 15);
    Ok(())
}

/// tests/natural-20-damage.test.ts:67
#[test]
fn a_forced_crit_on_a_non_20_does_not_deal_it_crit_on_hit_and_always_hit_always_crit() -> T {
    let crit_on_hit = boon_check()?
        .always_crits()?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_close(crit_on_hit.outcome_probability("crit"), 16.0 / 20.0, 15);
    assert_close(crit_on_hit.tail_prob_ge(EXTRA), 1.0 / 20.0, 15);

    let always = d20()
        .always_hits()?
        .always_crits()?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_close(always.outcome_probability("crit"), 1.0, 15);
    assert_close(always.tail_prob_ge(EXTRA), 1.0 / 20.0, 15);
    Ok(())
}

/// tests/natural-20-damage.test.ts:77
#[test]
fn a_turn_context_re_derives_it_granted_advantage_granted_crit_on_hit() -> T {
    let attack = boon_check()?
        .crit_on(18.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?;
    let advantaged = attack.under(
        &RowContext {
            roll_type: RollType::Advantage,
            ..plain()
        },
        0.0,
    )?;
    assert_close(
        advantaged.tail_prob_ge(EXTRA),
        1.0 - (19.0f64 / 20.0).powi(2),
        15,
    );
    let paralyzed = attack.under(
        &RowContext {
            crit_on_hit: true,
            ..plain()
        },
        0.0,
    )?;
    assert_close(paralyzed.outcome_probability("crit"), 16.0 / 20.0, 15);
    assert_close(paralyzed.tail_prob_ge(EXTRA), 1.0 / 20.0, 15);
    Ok(())
}

/// tests/natural-20-damage.test.ts:85
#[test]
fn a_check_with_no_d20_never_rolls_a_natural_20() -> T {
    let pmf = flat(5.0)?
        .ac(3.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(EXTRA)?)?
        .pmf()?;
    assert_eq!(pmf.tail_prob_ge(EXTRA), 0.0);
    Ok(())
}

/// tests/natural-20-damage.test.ts:91
#[test]
fn is_added_verbatim_never_doubled_on_the_natural_20_share_of_the_crit_branch() -> T {
    let extra = rs(2.0, 6.0)?.plus(3.0)?;
    let pmf = boon_check()?
        .crit_on(18.0)?
        .on_hit(d8())?
        .plus_natural20_damage(extra)?
        .pmf()?;
    let two_d8 = add(&[&uniform(8), &uniform(8)]);
    let expected = mix_labelled(&[
        (labelled("missNone", &point(0)), 4.0 / 20.0),
        (labelled("hit", &uniform(8)), 13.0 / 20.0),
        (labelled("crit", &two_d8), 2.0 / 20.0),
        (
            labelled(
                "crit",
                &shift(&add(&[&two_d8, &uniform(6), &uniform(6)]), 3),
            ),
            1.0 / 20.0,
        ),
    ]);
    expect_labelled(&pmf, &expected);
    assert_close(pmf.mean(), (13.0 * 4.5 + 3.0 * 9.0 + 10.0) / 20.0, 12);
    Ok(())
}

/// tests/natural-20-damage.test.ts:109
#[test]
fn calls_accumulate_and_stack_with_plus_separate_damage_doubled_on_every_crit() -> T {
    let pmf = boon_check()?
        .on_hit(d8())?
        .plus_separate_damage(rs(1.0, 4.0)?)
        .plus_natural20_damage(flat(7.0)?)?
        .plus_natural20_damage(flat(3.0)?)?
        .pmf()?;
    assert_close(
        pmf.mean(),
        (15.0 * (4.5 + 2.5) + (9.0 + 5.0 + 10.0)) / 20.0,
        12,
    );
    Ok(())
}

/// tests/natural-20-damage.test.ts:121
#[test]
fn the_crit_slice_is_the_crit_base_payload_with_the_natural_20_share_in_the_separate_channel() -> T
{
    let resolved = res_of(
        &boon_check()?
            .crit_on(18.0)?
            .on_hit(d8())?
            .plus_natural20_damage(flat(EXTRA)?)?,
    )?;
    assert_close(resolved.crit_separate.p_at(EXTRA), 1.0 / 3.0, 15);
    assert_close(resolved.crit_separate.p_at(0.0), 2.0 / 3.0, 15);
    assert_eq!(resolved.hit_separate.p_at(0.0), 1.0);
    assert_close(resolved.crit.mean(), 9.0 + EXTRA / 3.0, 12);
    Ok(())
}

/// tests/natural-20-damage.test.ts:131
#[test]
fn vulnerability_doubles_it_with_the_rest_of_the_landing() -> T {
    let attack = boon_check()?
        .on_hit(flat(4.0)?)?
        .plus_natural20_damage(flat(10.0)?)?;
    let pmf = attack.under(
        &RowContext {
            vulnerable: true,
            ..plain()
        },
        0.0,
    )?;
    assert_close(pmf.mean(), (15.0 * 8.0 + 28.0) / 20.0, 12);
    Ok(())
}

fn boon_sample_attack() -> Result<AttackBuilder, DiceError> {
    boon_check()?
        .crit_on(18.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(10.0)?)
}

/// tests/natural-20-damage.test.ts:157
#[test]
fn a_natural_20_deals_it() -> T {
    let sample = sample_with(&boon_sample_attack()?, &[20.0, 3.0, 4.0])?;
    assert_eq!(sample.outcome, AttackOutcome::Crit);
    assert_eq!(sample.total, 3.0 + 4.0 + 10.0);
    Ok(())
}

/// tests/natural-20-damage.test.ts:163
#[test]
fn a_natural_18_crits_without_it() -> T {
    let sample = sample_with(&boon_sample_attack()?, &[18.0, 3.0, 4.0])?;
    assert_eq!(sample.outcome, AttackOutcome::Crit);
    assert_eq!(sample.total, 3.0 + 4.0);
    Ok(())
}

/// tests/natural-20-damage.test.ts:169
#[test]
fn with_advantage_the_kept_die_decides() -> T {
    let advantaged = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(10.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(10.0)?)?;
    assert_eq!(
        sample_with(&advantaged, &[2.0, 20.0, 3.0, 4.0])?.total,
        3.0 + 4.0 + 10.0
    );
    Ok(())
}

/// tests/natural-20-damage.test.ts:174
#[test]
fn always_hit_always_crit_rolls_its_d20_to_see_a_natural_20() -> T {
    let always = d20()
        .always_hits()?
        .always_crits()?
        .on_hit(d8())?
        .plus_natural20_damage(flat(10.0)?)?;
    assert_eq!(
        sample_with(&always, &[20.0, 3.0, 4.0])?.total,
        3.0 + 4.0 + 10.0
    );
    assert_eq!(sample_with(&always, &[19.0, 3.0, 4.0])?.total, 3.0 + 4.0);
    Ok(())
}

/// tests/natural-20-damage.test.ts:182
#[test]
fn refuses_no_crit_in_either_order_a_natural_20_that_is_no_crit_has_no_branch_to_ride() -> T {
    let attack = check_of(5.0, 10.0)?.on_hit(d8())?;
    assert_throws(
        attack.no_crit()?.plus_natural20_damage(flat(10.0)?),
        "noCrit",
    );
    assert_throws(
        attack.plus_natural20_damage(flat(10.0)?)?.no_crit(),
        "noCrit",
    );
    Ok(())
}

/// tests/natural-20-damage.test.ts:188
#[test]
fn to_expression_has_no_spelling_for_it() -> T {
    let attack = check_of(5.0, 10.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(10.0)?)?;
    assert_throws(attack.to_expression(), "plusNatural20Damage");
    Ok(())
}

/// tests/natural-20-damage.test.ts:192
#[test]
fn is_part_of_the_cache_key() -> T {
    let a = check_of(5.0, 10.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(10.0)?)?;
    let b = check_of(5.0, 10.0)?
        .on_hit(d8())?
        .plus_natural20_damage(flat(11.0)?)?;
    assert!(!close(a.mean()?, b.mean()?, 6));
    Ok(())
}

// =============================================================================================
// tests/natural-twenty-crit.test.ts
// =============================================================================================

/// `roll(1, d8).plus(3)`.
fn nat20_damage() -> Result<RollBuilder, DiceError> {
    rl(1.0, d8())?.plus(3.0)
}

/// E[2d8 + 3] on the crit.
const CRIT_MEAN: f64 = 12.0;

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn always_crits_at_nat20_only(die: RollBuilder, p_nat20: f64) -> T {
    let res = die
        .plus(5.0)?
        .ac(26.0)?
        .always_crits()?
        .on_hit(nat20_damage()?)?
        .resolve(0.0)?;
    assert_close(res.weights.crit, p_nat20, 15);
    assert_eq!(res.weights.hit, 0.0);
    assert_close(res.weights.miss, 1.0 - p_nat20, 15);
    assert_close(res.pmf.mean(), p_nat20 * CRIT_MEAN, 14);
    Ok(())
}

/// tests/natural-twenty-crit.test.ts:29 (flat)
#[test]
fn always_crits_at_an_ac_only_a_natural_20_reaches_flat() -> T {
    always_crits_at_nat20_only(d20(), 1.0 / 20.0)
}

/// tests/natural-twenty-crit.test.ts:29 (advantage)
#[test]
fn always_crits_at_an_ac_only_a_natural_20_reaches_advantage() -> T {
    always_crits_at_nat20_only(d20().with_advantage()?, 39.0 / 400.0)
}

/// tests/natural-twenty-crit.test.ts:29 (disadvantage)
#[test]
fn always_crits_at_an_ac_only_a_natural_20_reaches_disadvantage() -> T {
    always_crits_at_nat20_only(d20().with_disadvantage()?, 1.0 / 400.0)
}

/// tests/natural-twenty-crit.test.ts:29 (elven accuracy)
#[test]
fn always_crits_at_an_ac_only_a_natural_20_reaches_elven_accuracy() -> T {
    always_crits_at_nat20_only(d20().with_elven_accuracy()?, 1141.0 / 8000.0)
}

/// tests/natural-twenty-crit.test.ts:29 (halfling)
#[test]
fn always_crits_at_an_ac_only_a_natural_20_reaches_halfling() -> T {
    always_crits_at_nat20_only(hd20(), 21.0 / 400.0)
}

/// tests/natural-twenty-crit.test.ts:38
#[test]
fn the_whole_pmf_is_the_crit_payload_at_1_20_and_nothing_otherwise() -> T {
    let pmf = check_of(5.0, 26.0)?
        .always_crits()?
        .on_hit(nat20_damage()?)?
        .to_pmf(0.0)?;
    assert_close(pmf.mean(), 3.0 / 5.0, 15);
    assert_close(pmf.p_at(0.0), 19.0 / 20.0, 15);
    for a in 1..=8 {
        for b in 1..=8 {
            assert!(pmf.p_at(f64::from(a + b + 3)) > 0.0);
        }
    }
    assert_close(pmf.p_at(19.0), 1.0 / 20.0 / 64.0, 15);
    Ok(())
}

/// tests/natural-twenty-crit.test.ts:49
#[test]
fn a_crit_on_hit_check_rebound_through_with_check_still_lands_on_a_natural_20() -> T {
    let res = check_of(5.0, 26.0)?
        .on_hit(nat20_damage()?)?
        .with_check(|mut c: Check| {
            c.crit_on_hit = true;
            c
        })?
        .resolve(0.0)?;
    assert_close(res.weights.crit, 1.0 / 20.0, 15);
    assert_close(res.pmf.mean(), 3.0 / 5.0, 15);
    Ok(())
}

/// tests/natural-twenty-crit.test.ts:69
#[test]
fn whatever_its_crit_threshold() -> T {
    let res = d20()
        .plus(9.0)?
        .always_hits()?
        .crit_on(21.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .resolve(0.0)?;
    assert_close(res.weights.crit, 1.0 / 20.0, 15);
    assert_close(res.weights.hit, 19.0 / 20.0, 15);
    assert_close(
        res.pmf.mean(),
        (19.0 / 20.0) * 7.0 + (1.0 / 20.0) * 14.0,
        14,
    );
    Ok(())
}

/// tests/natural-twenty-crit.test.ts:76
#[test]
fn but_not_with_no_crit() -> T {
    let res = d20()
        .plus(9.0)?
        .always_hits()?
        .on_hit(rs(2.0, 6.0)?)?
        .no_crit()?
        .resolve(0.0)?;
    assert_eq!(res.weights.crit, 0.0);
    assert_close(res.pmf.mean(), 7.0, 14);
    Ok(())
}

// =============================================================================================
// tests/no-crit-expression.test.ts
// =============================================================================================

/// tests/no-crit-expression.test.ts:33
#[test]
fn prints_xcrit0_with_the_hit_payload() -> T {
    let attack = check_of(5.0, 15.0)?.on_hit(rl(1.0, d8())?)?.no_crit()?;
    assert_eq!(
        attack.to_expression()?,
        "(d20 + 5 AC 15) * (1d8) xcrit0 (1d8)"
    );
    Ok(())
}

/// tests/no-crit-expression.test.ts:38
#[test]
fn the_parsed_string_labels_the_natural_20_a_hit_like_the_builder() -> T {
    let attack = check_of(5.0, 15.0)?.on_hit(rl(1.0, d8())?)?.no_crit()?;
    let expression = attack.to_expression()?;
    let parsed = parse(&expression)?;
    let labels = label_mass(&parsed);
    assert_close(mass_of(&labels, "hit"), 11.0 / 20.0, 12);
    assert_close(mass_of(&labels, "missNone"), 9.0 / 20.0, 12);
    assert_eq!(mass_of(&labels, "crit"), 0.0);
    expect_same_labelled(&parsed, &attack.to_pmf(0.0)?, &expression);
    Ok(())
}

/// tests/no-crit-expression.test.ts:63 (`it.each(shapes)`)
#[test]
fn no_crit_shapes_re_parse_with_the_builders_bins_and_labels() -> T {
    let shapes: Vec<(&str, AttackBuilder)> = vec![
        (
            "an expanded crit range",
            check_of(5.0, 15.0)?
                .crit_on(19.0)?
                .on_hit(rs(2.0, 8.0)?)?
                .no_crit()?,
        ),
        (
            "every hit crits",
            check_of(5.0, 15.0)?
                .always_crits()?
                .on_hit(rs(2.0, 8.0)?)?
                .no_crit()?,
        ),
        (
            "an always-hitting check",
            d20()
                .plus(5.0)?
                .always_hits()?
                .on_hit(rs(2.0, 8.0)?)?
                .no_crit()?,
        ),
        (
            "an always-hitting check where every hit crits",
            d20()
                .plus(5.0)?
                .always_hits()?
                .always_crits()?
                .on_hit(rs(2.0, 8.0)?)?
                .no_crit()?,
        ),
        (
            "a miss payload",
            check_of(5.0, 15.0)?
                .on_hit(rs(2.0, 8.0)?)?
                .on_miss(&[r(rl(1.0, d8())?)])?
                .no_crit()?,
        ),
        (
            "a check with no die",
            flat(15.0)?.ac(12.0)?.on_hit(rs(2.0, 8.0)?)?.no_crit()?,
        ),
    ];
    for (name, attack) in shapes {
        let expression = attack.to_expression()?;
        assert!(
            expression.contains(" xcrit0 ("),
            "{name}: {expression} has no xcrit0 clause"
        );
        expect_same_labelled(&parse(&expression)?, &attack.to_pmf(0.0)?, &expression);
    }
    Ok(())
}

/// tests/no-crit-expression.test.ts:70
#[test]
fn an_attack_that_can_crit_still_prints_its_crit_clause() -> T {
    assert_eq!(
        check_of(5.0, 15.0)?
            .on_hit(rl(1.0, d8())?)?
            .to_expression()?,
        "(d20 + 5 AC 15) * (1d8) crit (2d8)"
    );
    assert_eq!(
        check_of(5.0, 15.0)?
            .crit_on(19.0)?
            .on_hit(rl(1.0, d8())?)?
            .to_expression()?,
        "(d20 + 5 AC 15) * (1d8) xcrit2 (2d8)"
    );
    Ok(())
}

/// tests/no-crit-expression.test.ts:79
#[test]
fn never_crits_whatever_its_payload() -> T {
    let parsed = parse_with("(d20 + 5 AC 15) * (1d8) xcrit0 (10d8)", 0.0)?;
    assert_close(parsed.mean(), (11.0 / 20.0) * 4.5, 12);
    assert_eq!(mass_of(&label_mass(&parsed), "crit"), 0.0);
    Ok(())
}

/// tests/no-crit-expression.test.ts:85
#[test]
fn needs_no_single_natural_roll_since_nothing_crits() -> T {
    let parsed = parse_with("(d20 + 1d20 AC 25) * (1d8) xcrit0 (1d8)", 0.0)?;
    assert_close(parsed.mean(), (136.0 / 400.0) * 4.5, 12);
    let labels = label_mass(&parsed);
    assert_close(mass_of(&labels, "hit"), 136.0 / 400.0, 12);
    assert_eq!(mass_of(&labels, "crit"), 0.0);
    Ok(())
}

/// tests/no-crit-expression.test.ts:93
#[test]
fn a_string_with_no_clause_still_crits_with_its_hit_dice_doubled() -> T {
    let parsed = parse_with("(d20 + 5 AC 15) * (1d8)", 0.0)?;
    assert_close(mass_of(&label_mass(&parsed), "crit"), 1.0 / 20.0, 12);
    assert_close(parsed.mean(), (10.0 / 20.0) * 4.5 + (1.0 / 20.0) * 9.0, 12);
    Ok(())
}

// =============================================================================================
// tests/damage-reroll-floor.test.ts
// =============================================================================================

/// One die: faces `1..=reroll_up_to` reroll once (the reroll is kept), then every value is raised
/// to at least `minimum`.
fn one_die(sides: i64, reroll_up_to: i64, minimum: i64) -> Dist {
    let mut out = Dist::new();
    let mut put = |v: i64, p: f64| {
        *out.entry(v.max(minimum)).or_insert(0.0) += p;
    };
    let s = sides as f64;
    for f in 1..=sides {
        if f <= reroll_up_to {
            for g in 1..=sides {
                put(g, 1.0 / s / s);
            }
        } else {
            put(f, 1.0 / s);
        }
    }
    out
}

fn dice_dist(count: usize, sides: i64, reroll_up_to: i64, minimum: i64) -> Dist {
    let die = one_die(sides, reroll_up_to, minimum);
    let mut dist = point(0);
    for _ in 0..count {
        dist = combine_dist(&dist, &die, |a, b| a + b);
    }
    dist
}

#[track_caller]
fn expect_bins14(actual: &Pmf, expected: &Dist) {
    let mut keys: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    keys.extend(expected.keys());
    for k in keys {
        assert_close(
            actual.p_at(k as f64),
            expected.get(&k).copied().unwrap_or(0.0),
            14,
        );
    }
}

fn hit_of(attack: &AttackBuilder) -> Result<Pmf, DiceError> {
    Ok(attack.resolve(0.0)?.hit)
}

fn weapon(payload: RollBuilder) -> Result<AttackBuilder, DiceError> {
    atk(5.0, 10.0, payload)
}

fn weapon2d6() -> Result<AttackBuilder, DiceError> {
    weapon(rl(2.0, d6())?)
}

/// tests/damage-reroll-floor.test.ts:52
#[test]
fn reroll_damage_0_keeps_the_payloads_reroll_of_1s() -> T {
    let hit = hit_of(&weapon(rl(2.0, d6())?.reroll(1.0)?)?.reroll_damage(0.0)?)?;
    assert_close(hit.mean(), 47.0 / 6.0, 14);
    expect_bins14(&hit, &dice_dist(2, 6, 1, 0));
    Ok(())
}

/// tests/damage-reroll-floor.test.ts:58
#[test]
fn a_lower_reroll_damage_never_downgrades_the_payloads_reroll() -> T {
    let hit = hit_of(&weapon(rl(2.0, d6())?.reroll(2.0)?)?.reroll_damage(1.0)?)?;
    assert_close(hit.mean(), 25.0 / 3.0, 14);
    expect_bins14(&hit, &dice_dist(2, 6, 2, 0));
    Ok(())
}

/// tests/damage-reroll-floor.test.ts:64
#[test]
fn a_lower_minimum_damage_die_never_lowers_the_payloads_floor() -> T {
    let hit = hit_of(&weapon(rl(2.0, d6())?.minimum(3.0)?)?.minimum_damage_die(2.0)?)?;
    assert_close(hit.mean(), 8.0, 14);
    expect_bins14(&hit, &dice_dist(2, 6, 0, 3));
    Ok(())
}

/// tests/damage-reroll-floor.test.ts:72
#[test]
fn with_a_floor_of_4_rerolling_a_raw_4_is_worth_it_in_either_call_order() -> T {
    let expected = dice_dist(2, 6, 4, 4);
    let attacks = [
        weapon2d6()?.minimum_damage_die(4.0)?.reroll_damage(6.0)?,
        weapon2d6()?.reroll_damage(6.0)?.minimum_damage_die(4.0)?,
        weapon2d6()?.minimum_damage_die(4.0)?.reroll_damage(4.0)?,
        weapon2d6()?.reroll_damage(4.0)?.minimum_damage_die(4.0)?,
    ];
    for attack in attacks {
        let hit = hit_of(&attack)?;
        assert_close(hit.mean(), 29.0 / 3.0, 14);
        expect_bins14(&hit, &expected);
    }
    Ok(())
}

/// tests/damage-reroll-floor.test.ts:87
#[test]
fn a_cap_below_the_optimum_is_a_permission_cap_not_raised() -> T {
    let hit = hit_of(&weapon2d6()?.minimum_damage_die(4.0)?.reroll_damage(2.0)?)?;
    expect_bins14(&hit, &dice_dist(2, 6, 2, 4));
    Ok(())
}

/// tests/damage-reroll-floor.test.ts:92
#[test]
fn without_a_floor_the_cap_is_half_the_die() -> T {
    assert_close(
        hit_of(&weapon2d6()?.reroll_damage(5.0)?)?.mean(),
        17.0 / 2.0,
        14,
    );
    expect_bins14(
        &hit_of(&weapon2d6()?.reroll_damage(5.0)?)?,
        &dice_dist(2, 6, 3, 0),
    );
    Ok(())
}

// =============================================================================================
// src/builder/typed.test.ts
// =============================================================================================

/// P(sum of `count` d`sides` + `modifier` > 0), by enumerating every face.
fn brute_dealt(count: usize, sides: usize, modifier: f64) -> f64 {
    let mut totals = vec![0.0];
    for _ in 0..count {
        totals = totals
            .iter()
            .flat_map(|t| (0..sides).map(move |face| t + face as f64 + 1.0))
            .collect();
    }
    totals.iter().filter(|t| **t + modifier > 0.0).count() as f64 / totals.len() as f64
}

/// src/builder/typed.test.ts:26 (`it.each`, three rows)
#[test]
fn typed_dealt_odds_are_the_brute_forces_in_every_context() -> T {
    let rows: Vec<(&str, AttackBuilder, (usize, usize, f64))> = vec![
        ("2d8, never 0", atk(7.0, 16.0, rs(2.0, 8.0)?)?, (2, 8, 0.0)),
        (
            "d4 - 1: a hit on a 1 deals 0",
            atk(5.0, 15.0, d4().minus(1.0)?)?,
            (1, 4, -1.0),
        ),
        (
            "d6 - 3: half the hits deal nothing",
            atk(5.0, 15.0, d6().minus(3.0)?)?,
            (1, 6, -3.0),
        ),
    ];
    for (name, attack, (count, sides, modifier)) in rows {
        let cold = attack.typed("cold")?;
        let want_hit = brute_dealt(count, sides, modifier);
        let want_crit = brute_dealt(2 * count, sides, modifier);
        let contexts = [
            plain(),
            RowContext {
                roll_type: RollType::Advantage,
                ..plain()
            },
            RowContext {
                vulnerable: true,
                ..plain()
            },
        ];
        for context in &contexts {
            assert!(cold.has_dealt(), "{name}: no dealt");
            let odds = cold.dealt("cold", context)?;
            assert_close(odds.hit, want_hit, 12);
            assert_close(odds.crit, want_crit, 12);
        }
    }
    Ok(())
}

/// src/builder/typed.test.ts:40
#[test]
fn another_type_deals_nothing() -> T {
    let cold = atk(5.0, 15.0, d8())?.typed("cold")?;
    assert_eq!(
        cold.dealt("fire", &plain())?,
        Dealt {
            hit: 0.0,
            crit: 0.0
        }
    );
    Ok(())
}

/// src/builder/typed.test.ts:44
#[test]
fn an_untyped_attack_has_no_dealt_and_typed_leaves_the_receiver_and_every_number_alone() -> T {
    let sword = atk(5.0, 15.0, d8().plus(3.0)?)?;
    let cold = sword.typed("cold")?;
    assert!(!sword.has_dealt());
    assert_eq!(sword.damage_type, None);
    assert_eq!(cold.damage_type.as_deref(), Some("cold"));
    assert_eq!(cold.to_pmf(0.0)?.mean(), sword.to_pmf(0.0)?.mean());
    assert_eq!(cold.to_expression()?, sword.to_expression()?);
    Ok(())
}

/// src/builder/typed.test.ts:54
#[test]
fn the_type_survives_later_builder_verbs() -> T {
    let cold = atk(5.0, 15.0, d8())?
        .typed("cold")?
        .on_crit(&[r(rs(3.0, 8.0)?)])?
        .ranged()?;
    assert_eq!(cold.damage_type.as_deref(), Some("cold"));
    assert_eq!(
        cold.dealt("cold", &plain())?,
        Dealt {
            hit: 1.0,
            crit: 1.0
        }
    );
    Ok(())
}

/// src/builder/typed.test.ts:60
#[test]
fn refuses_an_empty_type() -> T {
    assert_throws(atk(5.0, 15.0, d8())?.typed(""), "damage type");
    Ok(())
}

// =============================================================================================
// tests/attack-expression-round-trip.test.ts
// =============================================================================================

fn sum_of(count: usize, sides: i64, flat_part: i64) -> Dist {
    let die = uniform(sides);
    let mut d = point(flat_part);
    for _ in 0..count {
        d = combine_dist(&d, &die, |a, b| a + b);
    }
    d
}

struct Spec {
    natural: Dist,
    bonus: Dist,
    ac: i64,
    crit_from: i64,
    hit: Dist,
    crit: Dist,
    always_crits: bool,
    always_hits: bool,
}

/// Damage outcome by outcome: a hit at or above AC, a crit on a hit whose natural roll is in range.
fn attack_dist(s: &Spec) -> Dist {
    let mut out = Dist::new();
    for (&nat, &pn) in &s.natural {
        for (&b, &pb) in &s.bonus {
            let lands = s.always_hits || nat + b >= s.ac;
            let crits = lands && (s.always_crits || nat >= s.crit_from);
            let zero = point(0);
            let payload = if crits {
                &s.crit
            } else if lands {
                &s.hit
            } else {
                &zero
            };
            for (&v, &p) in payload {
                *out.entry(v).or_insert(0.0) += pn * pb * p;
            }
        }
    }
    out
}

#[track_caller]
fn expect_bins(actual: &Pmf, expected: &Dist, context: &str) {
    let mut keys: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    keys.extend(expected.keys());
    for v in keys {
        let (a, e) = (
            actual.p_at(v as f64),
            expected.get(&v).copied().unwrap_or(0.0),
        );
        assert!((a - e).abs() <= 1e-12, "{context}: bin {v}: {a} vs {e}");
    }
}

fn expect_round_trip(built: &AttackBuilder, expected: &Dist, exact_mean: f64) -> T {
    let expression = built.to_expression()?;
    expect_bins(
        &built.to_pmf(0.0)?,
        expected,
        &format!("builder {expression}"),
    );
    expect_bins(&parse(&expression)?, expected, &expression);
    assert_close(parse(&expression)?.mean(), exact_mean, 12);
    Ok(())
}

/// A spec with the common defaults (`bonus` the flat part, hit 1d8, crit 2d8).
fn spec(bonus: Dist, ac: i64, crit_from: i64) -> Spec {
    Spec {
        natural: uniform(20),
        bonus,
        ac,
        crit_from,
        hit: sum_of(1, 8, 0),
        crit: sum_of(2, 8, 0),
        always_crits: false,
        always_hits: false,
    }
}

/// tests/attack-expression-round-trip.test.ts:76
#[test]
fn no_crit_re_parses_without_a_doubled_crit() -> T {
    let payload = sum_of(2, 6, 3);
    expect_round_trip(
        &atk(5.0, 15.0, rs(2.0, 6.0)?.plus(3.0)?)?.no_crit()?,
        &attack_dist(&Spec {
            hit: payload.clone(),
            crit: payload,
            ..spec(point(5), 15, 21)
        }),
        11.0 / 2.0,
    )
}

/// tests/attack-expression-round-trip.test.ts:85
#[test]
fn no_crit_on_a_keep_payload_re_parses_the_keep_has_no_doubled_reading() -> T {
    let expression = atk(5.0, 15.0, rs(4.0, 6.0)?.keep_highest(4.0, 3.0)?)?
        .no_crit()?
        .to_expression()?;
    assert_close(
        parse(&expression)?.mean(),
        11.0 / 20.0 * (15869.0 / 1296.0),
        12,
    );
    Ok(())
}

/// tests/attack-expression-round-trip.test.ts:90
#[test]
fn a_crit_that_deals_nothing_stays_nothing_at_the_attacks_crit_range() -> T {
    let zero = point(0);
    let mk = |crit_from: i64| Spec {
        hit: sum_of(2, 6, 0),
        crit: zero.clone(),
        ..spec(point(5), 15, crit_from)
    };
    expect_round_trip(
        &atk(5.0, 15.0, rs(2.0, 6.0)?)?.on_crit(&[r(flat(0.0)?)])?,
        &attack_dist(&mk(20)),
        7.0 / 2.0,
    )?;
    expect_round_trip(
        &check_of(5.0, 15.0)?
            .crit_on(18.0)?
            .on_hit(rs(2.0, 6.0)?)?
            .on_crit(&[r(flat(0.0)?)])?,
        &attack_dist(&mk(18)),
        14.0 / 5.0,
    )
}

/// tests/attack-expression-round-trip.test.ts:103
#[test]
fn a_negative_modifier_before_a_bonus_die() -> T {
    expect_round_trip(
        &d20()
            .minus(5.0)?
            .plus_roll(&rs(1.0, 8.0)?)?
            .ac(6.0)?
            .on_hit(d8())?,
        &attack_dist(&spec(sum_of(1, 8, -5), 6, 20)),
        279.0 / 80.0,
    )
}

/// tests/attack-expression-round-trip.test.ts:111
#[test]
fn a_bonus_die_rolled_with_advantage() -> T {
    expect_round_trip(
        &d20()
            .plus(5.0)?
            .plus_roll(&d4().with_advantage()?)?
            .ac(15.0)?
            .on_hit(d8())?,
        &attack_dist(&spec(
            add(&[&point(5), &best(&uniform(4), &uniform(4))]),
            15,
            20,
        )),
        1089.0 / 320.0,
    )
}

/// tests/attack-expression-round-trip.test.ts:126
#[test]
fn three_dice_advantage_rolls_three_d20s() -> T {
    let three_dice = best(&best(&uniform(20), &uniform(20)), &uniform(20));
    let built = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(15.0)?
        .three_dice_advantage()?
        .on_hit(d8())?;
    let expected = attack_dist(&Spec {
        natural: three_dice,
        ..spec(point(5), 15, 20)
    });
    expect_round_trip(&built, &expected, 18927.0 / 4000.0)
}

/// tests/attack-expression-round-trip.test.ts:133
#[test]
fn always_crits_keeps_the_ac_and_crits_on_every_hit() -> T {
    expect_round_trip(
        &check_of(5.0, 10.0)?.always_crits()?.on_hit(d8())?,
        &attack_dist(&Spec {
            always_crits: true,
            ..spec(point(5), 10, 21)
        }),
        36.0 / 5.0,
    )
}

/// tests/attack-expression-round-trip.test.ts:141
#[test]
fn always_hits_hits_even_where_its_total_is_0() -> T {
    let mk = |crit_from: i64, always_crits: bool| Spec {
        always_hits: true,
        always_crits,
        ..spec(point(0), 0, crit_from)
    };
    expect_round_trip(
        &d20().minus(5.0)?.always_hits()?.on_hit(d8())?,
        &attack_dist(&mk(20, false)),
        189.0 / 40.0,
    )?;
    expect_round_trip(
        &d20()
            .minus(5.0)?
            .always_hits()?
            .crit_on(18.0)?
            .on_hit(d8())?,
        &attack_dist(&mk(18, false)),
        207.0 / 40.0,
    )?;
    expect_round_trip(
        &d20()
            .minus(5.0)?
            .always_hits()?
            .always_crits()?
            .on_hit(d8())?,
        &attack_dist(&mk(1, true)),
        9.0,
    )
}
