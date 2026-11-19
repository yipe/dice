//! Rust translations of the TS `it(...)` cases of `src/builder/dc.test.ts`, `src/builder/save.test.ts`
//! and `tests/{save-check-outcome, save-string-labels, RollSaveCache, save-success-payload,
//! sample-save, tags-and-save}.test.ts` (the non-turn parts).
//!
//! Cases that only assert PMF *instance identity* (`toBe` / `not.toBe` of two cached `PMF`s) have no
//! Rust counterpart (`Pmf` values have no cache identity): they are deferred; the value assertions
//! beside them are translated.

use super::support::*;
use crate::builder::attack::Grants;
use crate::builder::dc::{CheckSample, SaveConfig};
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::sample::SampledDie;
use crate::builder::save::{SaveBuilder, SaveOutcome, SaveSampleOutcome};
use crate::common::{Rng, RollType};
use crate::error::DiceError;
use crate::parser::parse_with;
use crate::turn::context::{PenaltyDice, RowContext};
use crate::turn::effects::{TriggerSave, TriggerSaves, advantage, save as save_gated};
use crate::{EPS, Pmf};
use std::collections::{BTreeSet, VecDeque};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// `roll(count)`: `new RollBuilder(count)`.
fn rn(count: f64) -> Result<RollBuilder, DiceError> {
    RollBuilder::new(count)
}

/// `roll(count, sides)`.
fn nd(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

/// `roll(count, die)`.
fn nd_die(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

/// `check.onSaveFailure(damage)`.
fn fail(check: &RollBuilder, damage: RollBuilder) -> Result<SaveBuilder, DiceError> {
    check.on_save_failure_args(&[Arg::Roll(damage)])
}

/// `save.resolve()` with the default epsilon.
fn res(save: &SaveBuilder) -> Result<crate::builder::types::SaveResolution, DiceError> {
    save.resolve(EPS)
}

/// `roll.toPMF().mean()`.
fn mean_of(r: &RollBuilder) -> Result<f64, DiceError> {
    Ok(r.to_pmf(0.0)?.mean())
}

/// `new DCBuilder(base)`: the default save config (DC 10).
fn new_dc(base: &RollBuilder) -> RollBuilder {
    RollBuilder::dc_over(
        base,
        SaveConfig {
            dc: 10.0,
            ability: None,
            auto_fail: false,
        },
    )
}

/// The support values of a PMF.
fn values(pmf: &Pmf) -> Vec<f64> {
    pmf.support().iter().map(|d| d.0).collect()
}

type Bins = Vec<(f64, f64, Vec<(String, f64)>)>;

/// A PMF's bins as plain data in support order, so `==` sees every mass and label.
fn bins(pmf: &Pmf) -> Bins {
    let mut v: Bins = pmf
        .map
        .iter()
        .map(|(k, b)| {
            let mut counts: Vec<(String, f64)> =
                b.count.iter().map(|(l, x)| (l.clone(), *x)).collect();
            counts.sort_by(|a, b| a.0.cmp(&b.0));
            (k.0, b.p, counts)
        })
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v
}

/// `{ sides, face, kept }`.
fn sd(sides: f64, face: f64, kept: bool) -> SampledDie {
    SampledDie {
        sides,
        face,
        kept,
        reroll: false,
        miss_reroll: false,
    }
}

/// The `RowContext` `flat` of `tests/sample-save.test.ts`.
fn flat_ctx() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: Vec::new(),
        joined: Vec::new(),
    }
}

/// A scripted `Rng`: `die()` pops the next face, `chance()` is never expected. A misuse is
/// recorded (Rust cannot throw from `die`) and reported by [`Dice::done`].
struct Dice {
    faces: VecDeque<f64>,
    bad: Option<String>,
}

fn dice(faces: &[f64]) -> Dice {
    Dice {
        faces: faces.iter().copied().collect(),
        bad: None,
    }
}

impl Dice {
    fn done(&self) -> T {
        match &self.bad {
            Some(m) => Err(m.clone().into()),
            None => Ok(()),
        }
    }
}

impl Rng for Dice {
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

/// `mulberry32(seed)` of `tests/sample-save.test.ts` (u32 arithmetic = `Math.imul` / `>>> 0`).
struct Mulberry32 {
    a: u32,
}

impl Rng for Mulberry32 {
    fn die(&mut self, n: f64) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((f64::from(t ^ (t >> 14)) / 4_294_967_296.0) * n).floor() + 1.0
    }
    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

/// The seeded LCG of "tracks the PMF mean"; `chance()` is false.
struct Lcg {
    st: u32,
}

impl Rng for Lcg {
    fn die(&mut self, n: f64) -> f64 {
        self.st = self.st.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.st % n as u32) + 1.0
    }
    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------------------------
// src/builder/dc.test.ts
// ---------------------------------------------------------------------------------------------

const ELVEN_ON_DC: &str = "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks).";

/// src/builder/dc.test.ts:7
#[test]
fn should_handle_fireball_save_for_half_damage() -> T {
    let fireball_damage = nd(8.0, 6.0)?;
    let save1 = fail(
        &d20().plus(7.0)?.with_advantage()?.dc(15.0)?,
        fireball_damage.clone(),
    )?
    .save_half()?;
    assert_eq!(
        save1.to_expression()?,
        "(d20 > d20 + 7 DC 15) * (8d6) save half"
    );
    assert_close(save1.pmf()?.mean(), 15.495625, 5);

    let save3 = fail(&roll_dice(1.0, 20.0, Some(7.0))?.dc(15.0)?, fireball_damage)?;
    assert_eq!(save3.to_expression()?, "(d20 + 7 DC 15) * (8d6)");
    Ok(())
}

/// src/builder/dc.test.ts:28
#[test]
fn should_handle_chaining_dc_calls() -> T {
    let builder = d20().plus(5.0)?.dc(10.0)?.dc(15.0)?;
    assert_eq!(builder.to_expression()?, "(d20 + 5 DC 15)");
    assert_close(builder.to_pmf(0.0)?.mean(), 0.45, 5);
    Ok(())
}

/// src/builder/dc.test.ts:38 (`toBeInstanceOf(RollBuilder)` is the type itself in Rust).
#[test]
fn should_inherit_from_roll_builder_correctly() -> T {
    let base_roll = d20().plus(3.0)?.with_advantage()?;
    let dc_builder = new_dc(&base_roll);
    assert!(dc_builder.is_dc());
    Ok(())
}

/// src/builder/dc.test.ts:46
#[test]
fn should_copy_sub_roll_configs_from_base_roll_builder() -> T {
    let base_roll = d20().plus(4.0)?.add_roll(2.0)?.d6()?.plus(1.0)?;
    let dc_builder = new_dc(&base_roll);
    let configs = dc_builder.get_sub_roll_configs();
    assert_eq!(configs.len(), 2);
    assert_eq!(configs[0].sides, 20.0);
    assert_eq!(configs[0].modifier, 4.0);
    assert_eq!(configs[1].sides, 6.0);
    assert_eq!(configs[1].count, 2.0);
    assert_eq!(configs[1].modifier, 1.0);
    Ok(())
}

/// src/builder/dc.test.ts:59
#[test]
fn should_initialize_with_default_save_config() -> T {
    let dc_builder = new_dc(&d20().plus(2.0)?);
    assert_eq!(dc_builder.save_dc(), Some(10.0));
    Ok(())
}

/// src/builder/dc.test.ts:68
#[test]
fn should_set_save_dc_correctly() -> T {
    let builder = d20().plus(5.0)?.dc(15.0)?;
    assert_eq!(builder.save_dc(), Some(15.0));
    Ok(())
}

/// src/builder/dc.test.ts:74
#[test]
fn should_allow_chaining_dc_calls() -> T {
    let builder = d20().plus(3.0)?.dc(10.0)?.dc(20.0)?;
    assert_eq!(builder.save_dc(), Some(20.0));
    Ok(())
}

/// src/builder/dc.test.ts:80
#[test]
fn should_handle_different_dc_values() -> T {
    let low = d20().plus(2.0)?.dc(5.0)?;
    let high = d20().plus(2.0)?.dc(25.0)?;
    assert_eq!(low.save_dc(), Some(5.0));
    assert_eq!(high.save_dc(), Some(25.0));
    Ok(())
}

/// src/builder/dc.test.ts:88
#[test]
fn should_handle_zero_and_negative_dc_values() -> T {
    let zero = d20().plus(1.0)?.dc(0.0)?;
    let negative = d20().plus(1.0)?.dc(-5.0)?;
    assert_eq!(zero.save_dc(), Some(0.0));
    assert_eq!(negative.save_dc(), Some(-5.0));
    Ok(())
}

/// src/builder/dc.test.ts:98
#[test]
fn should_throw_error_when_using_with_elven_accuracy() -> T {
    let builder = d20().plus(4.0)?.dc(12.0)?;
    assert_throws(builder.with_elven_accuracy(), ELVEN_ON_DC);
    Ok(())
}

/// src/builder/dc.test.ts:108
#[test]
fn should_throw_error_even_after_chaining_other_methods() -> T {
    let builder = d20().plus(6.0)?.with_advantage()?.dc(16.0)?;
    assert_throws(builder.with_elven_accuracy(), ELVEN_ON_DC);
    Ok(())
}

/// src/builder/dc.test.ts:120
#[test]
fn should_create_save_builder_with_correct_check() -> T {
    let damage = nd(4.0, 6.0)?;
    let dc_builder = d20().plus(5.0)?.dc(15.0)?;
    let save_builder = fail(&dc_builder, damage)?;
    assert_eq!(save_builder.to_expression()?, "(d20 + 5 DC 15) * (4d6)");
    Ok(())
}

/// src/builder/dc.test.ts:129
#[test]
fn should_pass_dc_configuration_to_save_builder() -> T {
    let damage = rn(2.0)?.d8()?.plus(3.0)?;
    let dc_builder = d20().plus(7.0)?.dc(18.0)?;
    let save_builder = fail(&dc_builder, damage)?;
    assert_eq!(save_builder.check.modifier(), 7.0);
    assert_eq!(
        save_builder.check.get_root_die_config().map(|c| c.sides),
        Some(20.0)
    );
    Ok(())
}

/// src/builder/dc.test.ts:138
#[test]
fn should_handle_complex_dice_expressions_in_failure_effect() -> T {
    let complex_damage = rn(3.0)?.d6()?.plus(2.0)?.add_roll(1.0)?.d4()?;
    let dc_builder = d20().plus(4.0)?.with_disadvantage()?.dc(12.0)?;
    let save_builder = fail(&dc_builder, complex_damage)?;
    let expression = save_builder.to_expression()?;
    assert!(expression.contains("(d20 < d20 + 4 DC 12)"), "{expression}");
    assert!(expression.contains("(3d6 + 1d4 + 2)"), "{expression}");
    Ok(())
}

/// src/builder/dc.test.ts:150
#[test]
fn should_generate_correct_expression_with_dc() -> T {
    let builder = d20().plus(6.0)?.dc(14.0)?;
    assert_eq!(builder.to_expression()?, "(d20 + 6 DC 14)");
    Ok(())
}

/// src/builder/dc.test.ts:156
#[test]
fn should_generate_correct_expression_without_dc() -> T {
    let dc_builder = new_dc(&d20().plus(3.0)?);
    assert_eq!(dc_builder.to_expression()?, "(d20 + 3 DC 10)");
    Ok(())
}

/// src/builder/dc.test.ts:163
#[test]
fn should_generate_correct_expression_with_complex_dice() -> T {
    let builder = d20().plus(2.0)?.add_roll(1.0)?.d6()?.plus(1.0)?.dc(16.0)?;
    assert_eq!(builder.to_expression()?, "(d20 + 3 + 1d6 DC 16)");
    Ok(())
}

/// src/builder/dc.test.ts:169
#[test]
fn should_generate_correct_expression_with_advantage() -> T {
    let builder = d20().plus(5.0)?.with_advantage()?.dc(13.0)?;
    assert_eq!(builder.to_expression()?, "(d20 > d20 + 5 DC 13)");
    Ok(())
}

/// src/builder/dc.test.ts:175
#[test]
fn should_generate_correct_expression_with_disadvantage() -> T {
    let builder = d20().plus(4.0)?.with_disadvantage()?.dc(11.0)?;
    assert_eq!(builder.to_expression()?, "(d20 < d20 + 4 DC 11)");
    Ok(())
}

/// src/builder/dc.test.ts:181
#[test]
fn should_generate_valid_pmf_from_expression() -> T {
    let pmf = d20().plus(3.0)?.dc(12.0)?.to_pmf(0.0)?;
    assert!(pmf.mean() >= 0.0);
    assert!(pmf.mean() <= 1.0);
    Ok(())
}

/// src/builder/dc.test.ts:190
#[test]
fn should_handle_different_dc_values_in_pmf_generation() -> T {
    let low_pmf = d20().plus(5.0)?.dc(5.0)?.to_pmf(0.0)?;
    let high_pmf = d20().plus(5.0)?.dc(20.0)?.to_pmf(0.0)?;
    assert!(low_pmf.mean() >= 0.0);
    assert!(high_pmf.mean() >= 0.0);
    Ok(())
}

/// src/builder/dc.test.ts:207
#[test]
fn should_handle_empty_base_roll() -> T {
    let empty_roll = rn(0.0)?;
    let dc_builder = new_dc(&empty_roll).dc(15.0)?;
    assert_eq!(dc_builder.to_expression()?, "(0 DC 15)");
    assert_eq!(dc_builder.save_dc(), Some(15.0));
    Ok(())
}

/// src/builder/dc.test.ts:215
#[test]
fn should_handle_very_large_dc_values() -> T {
    let builder = d20().plus(10.0)?.dc(100.0)?;
    assert_eq!(builder.save_dc(), Some(100.0));
    assert_eq!(builder.to_expression()?, "(d20 + 10 DC 100)");
    Ok(())
}

/// src/builder/dc.test.ts:222
#[test]
fn should_handle_bonus_to_save() -> T {
    let builder = d20().plus(3.0)?.add_roll(-1.0)?.d4()?.plus(2.0)?.dc(18.0)?;
    assert_eq!(builder.save_dc(), Some(18.0));
    assert_eq!(builder.to_expression()?, "(d20 + 5 - 1d4 DC 18)");
    Ok(())
}

/// src/builder/dc.test.ts:230 (the config is a `Copy` value: mutating the original after
/// construction cannot reach the builder).
#[test]
fn should_not_be_mutable_via_constructor_save_config_object() -> T {
    let mut save_config = SaveConfig {
        dc: 15.0,
        ability: None,
        auto_fail: false,
    };
    let builder = d20().plus(5.0)?;
    let dc_builder = RollBuilder::dc_over(&builder, save_config);
    assert_eq!(dc_builder.save_dc(), Some(15.0));
    save_config.dc = 25.0;
    assert_eq!(save_config.dc, 25.0);
    assert_eq!(dc_builder.save_dc(), Some(15.0));
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// src/builder/save.test.ts
// ---------------------------------------------------------------------------------------------

/// src/builder/save.test.ts:6
#[test]
fn should_accept_string_damage_for_on_save_failure() -> T {
    let save = d20()
        .plus(5.0)?
        .dc(16.0)?
        .on_save_failure_args(&[Arg::Str("8d6".to_string())])?
        .save_half()?;
    let r = res(&save)?;
    assert_close(r.weights.success, 0.5, 5);
    assert_close(r.weights.fail, 0.5, 5);
    assert_close(r.save_fail.mean(), 28.0, 0);
    assert_close(r.save_success.mean(), 14.0, 0);
    Ok(())
}

/// src/builder/save.test.ts:16
#[test]
fn should_match_builder_syntax_for_saving_throw_damage() -> T {
    let string_version = d20()
        .plus(3.0)?
        .dc(14.0)?
        .on_save_failure_args(&[Arg::Str("6d6".to_string())])?
        .save_half()?;
    let builder_version = fail(&d20().plus(3.0)?.dc(14.0)?, nd(6.0, 6.0)?)?.save_half()?;
    let string_res = res(&string_version)?;
    let builder_res = res(&builder_version)?;
    assert_close(string_res.pmf.mean(), builder_res.pmf.mean(), 10);
    assert_close(
        string_res.save_fail.mean(),
        builder_res.save_fail.mean(),
        10,
    );
    assert_close(
        string_res.save_success.mean(),
        builder_res.save_success.mean(),
        10,
    );
    Ok(())
}

/// src/builder/save.test.ts:37
#[test]
fn should_handle_a_basic_saving_throw() -> T {
    let save = d20().dc(10.0)?;
    assert_eq!(save.to_expression()?, "(d20 DC 10)");
    let pmf = save.to_pmf(0.0)?;
    assert_close(pmf.mean(), 0.45, 12);
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 1.0);
    Ok(())
}

/// src/builder/save.test.ts:46
#[test]
fn should_handle_save_roll_builder() -> T {
    let builder = d20().plus(5.0)?.dc(10.0)?;
    assert_eq!(builder.to_expression()?, "(d20 + 5 DC 10)");
    assert_close(mean_of(&builder)?, 0.2, 12);
    Ok(())
}

/// src/builder/save.test.ts:53
#[test]
fn should_handle_save_roll_builder_with_advantage() -> T {
    let builder = d20().plus(5.0)?.with_advantage()?.dc(10.0)?;
    assert_eq!(builder.to_expression()?, "(d20 > d20 + 5 DC 10)");
    assert_close(mean_of(&builder)?, 0.04, 12);
    Ok(())
}

/// src/builder/save.test.ts:60
#[test]
fn should_handle_save_roll_builder_with_advantage_different_order() -> T {
    let builder = d20().with_advantage()?.plus(5.0)?.dc(10.0)?;
    assert_eq!(builder.to_expression()?, "(d20 > d20 + 5 DC 10)");
    assert_close(mean_of(&builder)?, 0.04, 12);
    Ok(())
}

/// src/builder/save.test.ts:67
#[test]
fn should_handle_save_roll_builder_with_disadvantage() -> T {
    let builder = d20().plus(5.0)?.with_disadvantage()?.dc(10.0)?;
    assert_eq!(builder.to_expression()?, "(d20 < d20 + 5 DC 10)");
    assert_close(mean_of(&builder)?, 0.36, 12);
    Ok(())
}

/// src/builder/save.test.ts:74
#[test]
fn should_handle_save_half_method() -> T {
    let fireball_damage = rn(8.0)?.d6()?;
    let builder = fail(
        &d20().plus(7.0)?.with_advantage()?.dc(15.0)?,
        fireball_damage,
    )?
    .save_half()?;
    assert_eq!(
        builder.to_expression()?,
        "(d20 > d20 + 7 DC 15) * (8d6) save half"
    );
    builder.pmf()?;
    Ok(())
}

/// src/builder/save.test.ts:90
#[test]
fn should_handle_on_save_failure_method() -> T {
    let damage = rn(6.0)?.d6()?.plus(4.0)?;
    let builder = fail(&d20().plus(3.0)?.dc(12.0)?, damage)?;
    assert_eq!(builder.to_expression()?, "(d20 + 3 DC 12) * (6d6 + 4)");
    builder.pmf()?;
    Ok(())
}

/// src/builder/save.test.ts:98
#[test]
fn should_handle_complex_save_scenario_with_advantage() -> T {
    let lightning_bolt = rn(8.0)?.d6()?;
    let builder = fail(
        &d20().plus(6.0)?.with_advantage()?.dc(16.0)?,
        lightning_bolt,
    )?
    .save_half()?;
    assert_eq!(
        builder.to_expression()?,
        "(d20 > d20 + 6 DC 16) * (8d6) save half"
    );
    assert_close(builder.pmf()?.mean(), 16.635625, 5);
    Ok(())
}

/// src/builder/save.test.ts:115
#[test]
fn should_throw_error_when_using_elven_accuracy_with_dc_check() -> T {
    let r = d20()
        .plus(6.0)?
        .with_elven_accuracy()
        .and_then(|b| b.dc(16.0));
    assert_throws(
        r,
        "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead.",
    );
    Ok(())
}

/// src/builder/save.test.ts:123
#[test]
fn should_handle_save_without_any_effects_just_the_check() -> T {
    let builder = d20().plus(8.0)?.dc(20.0)?;
    assert_eq!(builder.to_expression()?, "(d20 + 8 DC 20)");
    assert_eq!(mean_of(&builder)?, 0.55);
    Ok(())
}

/// src/builder/save.test.ts:131
#[test]
fn should_handle_save_with_only_failure_effect_no_save_half() -> T {
    let poison_damage = rn(3.0)?.d6()?.plus(1.0)?;
    let builder = fail(&d20().plus(2.0)?.dc(11.0)?, poison_damage)?;
    assert_eq!(builder.to_expression()?, "(d20 + 2 DC 11) * (3d6 + 1)");
    assert_close(builder.pmf()?.mean(), 4.6, 5);
    Ok(())
}

/// src/builder/save.test.ts:140
#[test]
fn should_provide_access_to_root_die_configuration() -> T {
    let builder = fail(
        &d20().plus(7.0)?.with_advantage()?.dc(15.0)?,
        rn(8.0)?.d6()?,
    )?;
    let root = builder
        .check
        .get_root_die_config()
        .ok_or("no root config")?;
    assert_eq!(root.sides, 20.0);
    assert_eq!(root.count, 1.0);
    assert_eq!(root.roll_type, RollType::Advantage);
    assert_eq!(builder.check.modifier(), 7.0);
    let all = builder.check.get_all_die_configs();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].sides, 20.0);
    Ok(())
}

/// src/builder/save.test.ts:164
#[test]
fn should_handle_complex_dice_chains_with_multiple_configurations() -> T {
    let builder = fail(
        &d20()
            .plus(3.0)?
            .with_bonus(&rn(2.0)?.d6()?.plus(2.0)?)?
            .dc(12.0)?,
        rn(4.0)?.d8()?,
    )?;
    let root = builder
        .check
        .get_root_die_config()
        .ok_or("no root config")?;
    assert_eq!(root.sides, 20.0);
    assert_eq!(root.count, 1.0);
    assert_eq!(root.roll_type, RollType::Flat);
    assert_eq!(builder.check.modifier(), 5.0);
    let all = builder.check.get_all_die_configs();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].sides, 20.0);
    assert_eq!(all[0].modifier, 3.0);
    assert_eq!(all[1].sides, 6.0);
    assert_eq!(all[1].count, 2.0);
    assert_eq!(all[1].modifier, 2.0);
    Ok(())
}

/// src/builder/save.test.ts:192
#[test]
fn should_handle_invalid_dc_values() -> T {
    let d20roll = d20();
    d20roll.dc(-1.0)?;
    d20roll.dc(0.0)?;
    Ok(())
}

/// src/builder/save.test.ts:203
#[test]
fn should_prevent_elven_accuracy_usage_on_save_roll_builder() -> T {
    let d20roll = d20().dc(15.0)?;
    assert_throws(d20roll.with_elven_accuracy(), ELVEN_ON_DC);
    Ok(())
}

/// src/builder/save.test.ts:212 (`roll.flat(NaN)` already throws in `flat`; either way the chain throws).
#[test]
fn should_handle_invalid_save_effects() -> T {
    let d20roll = d20().dc(15.0)?;
    let r = flat(f64::NAN).and_then(|f| d20roll.on_save_failure_args(&[Arg::Roll(f)]));
    err_of(r);
    Ok(())
}

/// src/builder/save.test.ts:221
#[test]
fn should_have_correct_save_probability_for_plus_4_vs_dc_12() -> T {
    let save = d20().plus(4.0)?.dc(12.0)?;
    assert_eq!(save.to_expression()?, "(d20 + 4 DC 12)");
    let pmf = save.to_pmf(0.0)?;
    assert_eq!(pmf.mean(), 0.35);
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 1.0);
    Ok(())
}

/// src/builder/save.test.ts:231
#[test]
fn should_have_correct_save_probability_for_plus_2_vs_dc_16() -> T {
    let save = d20().plus(2.0)?.dc(16.0)?;
    assert_eq!(save.to_expression()?, "(d20 + 2 DC 16)");
    let pmf = save.to_pmf(0.0)?;
    assert_eq!(pmf.mean(), 0.65);
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 1.0);
    Ok(())
}

/// src/builder/save.test.ts:241
#[test]
fn should_have_correct_save_probability_for_plus_6_vs_dc_18_with_advantage() -> T {
    let save = d20().plus(6.0)?.with_advantage()?.dc(18.0)?;
    let pmf = save.to_pmf(0.0)?;
    assert_close(pmf.mean(), 0.3025, 1);
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 1.0);
    Ok(())
}

/// src/builder/save.test.ts:252
#[test]
fn should_provide_correct_root_die_configuration() -> T {
    let builder = fail(
        &d20().plus(6.0)?.with_disadvantage()?.dc(14.0)?,
        rn(3.0)?.d8()?,
    )?;
    let root = builder
        .check
        .get_root_die_config()
        .ok_or("no root config")?;
    assert_eq!(root.sides, 20.0);
    assert_eq!(root.count, 1.0);
    assert_eq!(root.roll_type, RollType::Disadvantage);
    Ok(())
}

/// src/builder/save.test.ts:267
#[test]
fn should_provide_all_die_configurations() -> T {
    let builder = fail(
        &d20().plus(4.0)?.add_roll(2.0)?.d6()?.plus(1.0)?.dc(13.0)?,
        rn(5.0)?.d4()?,
    )?;
    let all = builder.check.get_all_die_configs();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].sides, 20.0);
    assert_eq!(all[0].modifier, 4.0);
    assert_eq!(all[1].sides, 6.0);
    assert_eq!(all[1].count, 2.0);
    assert_eq!(all[1].modifier, 1.0);
    Ok(())
}

/// src/builder/save.test.ts:286
#[test]
fn should_calculate_save_bonus_correctly() -> T {
    let builder = fail(
        &d20().plus(7.0)?.plus_roll(&d4())?.plus(2.0)?.dc(16.0)?,
        rn(2.0)?.d10()?,
    )?;
    assert_eq!(builder.check.modifier(), 9.0);
    Ok(())
}

/// src/builder/save.test.ts:297
#[test]
fn should_handle_complex_dice_chains_in_configuration_methods() -> T {
    let builder = fail(
        &d20()
            .plus(3.0)?
            .add_roll(1.0)?
            .d6()?
            .plus(1.0)?
            .add_roll(2.0)?
            .d4()?
            .plus(2.0)?
            .dc(15.0)?,
        flat(10.0)?,
    )?;
    let root = builder
        .check
        .get_root_die_config()
        .ok_or("no root config")?;
    assert_eq!(root.sides, 20.0);
    assert_eq!(builder.check.get_all_die_configs().len(), 3);
    assert_eq!(builder.check.modifier(), 6.0);
    Ok(())
}

/// src/builder/save.test.ts:322
#[test]
fn should_calculate_correct_probabilities_for_different_dc_values() -> T {
    let at = |dc: f64| -> Result<f64, DiceError> {
        Ok(res(&fail(&d20().plus(5.0)?.dc(dc)?, flat(10.0)?)?)?
            .pmf
            .mean())
    };
    let (m10, m15, m20) = (at(10.0)?, at(15.0)?, at(20.0)?);
    assert!(m10 < m15, "{m10} !< {m15}");
    assert!(m15 < m20, "{m15} !< {m20}");
    Ok(())
}

/// src/builder/save.test.ts:337
#[test]
fn should_calculate_correct_probabilities_for_different_roll_types() -> T {
    let damage = flat(10.0)?;
    let mean_with = |check: RollBuilder| -> Result<f64, DiceError> {
        Ok(res(&fail(&check, damage.clone())?)?.pmf.mean())
    };
    let normal = mean_with(d20().plus(3.0)?.dc(12.0)?)?;
    let adv = mean_with(d20().plus(3.0)?.with_advantage()?.dc(12.0)?)?;
    let dis = mean_with(d20().plus(3.0)?.with_disadvantage()?.dc(12.0)?)?;
    assert!(adv < normal);
    assert!(normal < dis);
    Ok(())
}

/// src/builder/save.test.ts:361
#[test]
fn should_handle_edge_cases_in_probability_calculation() -> T {
    let impossible = fail(&d20().plus(0.0)?.dc(30.0)?, flat(10.0)?)?;
    assert_close(res(&impossible)?.pmf.mean(), 10.0, 1);
    let guaranteed = fail(&d20().plus(10.0)?.dc(1.0)?, flat(10.0)?)?;
    assert_close(res(&guaranteed)?.pmf.mean(), 0.0, 2);
    Ok(())
}

/// src/builder/save.test.ts:375
#[test]
fn should_handle_different_save_bonuses_correctly() -> T {
    let damage = flat(10.0)?;
    let low = fail(&d20().plus(1.0)?.dc(15.0)?, damage.clone())?;
    let high = fail(&d20().plus(10.0)?.dc(15.0)?, damage)?;
    assert!(res(&high)?.pmf.mean() < res(&low)?.pmf.mean());
    Ok(())
}

/// src/builder/save.test.ts:390
#[test]
fn should_handle_save_with_undefined_failure_effect() -> T {
    let builder = fail(&d20().plus(4.0)?.dc(10.0)?, flat(0.0)?)?;
    assert_eq!(res(&builder)?.pmf.mean(), 0.0);
    Ok(())
}

/// src/builder/save.test.ts:398
#[test]
fn should_handle_save_half_with_very_small_damage() -> T {
    let builder = fail(&d20().plus(3.0)?.dc(12.0)?, flat(1.0)?)?.save_half()?;
    assert!(res(&builder)?.pmf.mean() >= 0.0);
    Ok(())
}

/// src/builder/save.test.ts:412
#[test]
fn should_handle_save_with_complex_dice_expressions() -> T {
    let complex_damage = rn(3.0)?.d6()?.plus(2.0)?.add_roll(1.0)?.d4()?;
    let builder = fail(
        &d20().plus(5.0)?.with_advantage()?.dc(16.0)?,
        complex_damage,
    )?
    .save_half()?;
    assert_eq!(
        builder.to_expression()?,
        "(d20 > d20 + 5 DC 16) * (3d6 + 1d4 + 2) save half"
    );
    assert!(res(&builder)?.pmf.mean() > 0.0);
    Ok(())
}

/// src/builder/save.test.ts:432
#[test]
fn should_handle_bonus_save_dice() -> T {
    let builder = fail(&d20().plus(5.0)?.dc(15.0)?, d6())?;
    assert_eq!(builder.to_expression()?, "(d20 + 5 DC 15) * (1d6)");
    assert!(res(&builder)?.pmf.mean() > 0.0);
    Ok(())
}

/// src/builder/save.test.ts:443
#[test]
fn should_handle_different_save_outcome_types() -> T {
    let damage = rn(2.0)?.d8()?;
    let normal_save = fail(&d20().plus(4.0)?.dc(13.0)?, damage.clone())?;
    let half_save = fail(&d20().plus(4.0)?.dc(13.0)?, damage)?.save_half()?;
    let normal = res(&normal_save)?.pmf.mean();
    let half = res(&half_save)?.pmf.mean();
    assert_ne!(half, normal);
    Ok(())
}

/// src/builder/save.test.ts:464
#[test]
fn should_handle_save_with_bonus_dice() -> T {
    let damage = rn(2.0)?.d8()?;
    let builder = fail(&d20().plus(5.0)?.plus_roll(&d4())?.dc(15.0)?, damage)?;
    assert_eq!(builder.to_expression()?, "(d20 + 5 + 1d4 DC 15) * (2d8)");
    let faux_pmf = parse_with("(d20 + 5 DC (15-1d4)) * (2d8)", 0.0)?;
    let pmf = res(&builder)?.pmf;
    assert_close(pmf.mean(), 2.925, 5);
    assert_close(pmf.mean(), faux_pmf.mean(), 5);
    assert_close(pmf.min(), faux_pmf.min(), 5);
    assert_close(pmf.max(), faux_pmf.max(), 5);
    Ok(())
}

/// src/builder/save.test.ts:486
#[test]
fn should_handle_bonus_dice_with_save_half() -> T {
    let damage = nd_die(2.0, d8())?;
    let builder = fail(&d20().plus(5.0)?.plus_roll(&d4())?.dc(15.0)?, damage)?.save_half()?;
    assert_eq!(
        builder.to_expression()?,
        "(d20 + 5 + 1d4 DC 15) * (2d8) save half"
    );
    assert_close(res(&builder)?.pmf.mean(), 5.79375, 5);
    Ok(())
}

/// src/builder/save.test.ts:504
#[test]
fn should_handle_save_with_negative_bonus_dice_bane() -> T {
    let damage = nd_die(2.0, d8())?;
    let builder = fail(&d20().plus(5.0)?.minus_roll(&d4())?.dc(15.0)?, damage)?;
    assert_eq!(builder.to_expression()?, "(d20 + 5 - 1d4 DC 15) * (2d8)");
    let faux_pmf = parse_with("(d20 + 5 DC (15+1d4)) * (2d8)", 0.0)?;
    assert_close(faux_pmf.mean(), 5.175, 5);
    let pmf = res(&builder)?.pmf;
    assert_close(pmf.mean(), 5.175, 5);
    assert_close(pmf.mean(), faux_pmf.mean(), 5);
    assert_close(pmf.min(), faux_pmf.min(), 5);
    assert_close(pmf.max(), faux_pmf.max(), 5);
    Ok(())
}

/// src/builder/save.test.ts:523
#[test]
fn should_handle_bonus_dice_with_save_half_with_more_complex_damage() -> T {
    let damage = roll_with(2.0, Some(SidesOrDie::Die(d8())), Some(1.0))?.reroll(2.0)?;
    let builder = fail(&d20().plus(5.0)?.plus_roll(&d4())?.dc(15.0)?, damage)?.save_half()?;
    assert_eq!(
        builder.to_expression()?,
        "(d20 + 5 + 1d4 DC 15) * (2(d8 reroll d2) + 1) save half"
    );
    assert_close(res(&builder)?.pmf.mean(), 7.45, 5);
    Ok(())
}

/// src/builder/save.test.ts:541
#[test]
fn should_handle_lots_of_bonus_dice() -> T {
    let damage = rn(8.0)?.d6()?;
    let builder = fail(
        &d(20.0)?
            .plus(1.0)?
            .add_roll(2.0)?
            .d4()?
            .add_roll(3.0)?
            .d8()?
            .dc(30.0)?,
        damage,
    )?
    .save_half()?;
    let bonus = builder.check.get_bonus_dice_configs();
    assert_eq!(bonus.len(), 2);
    assert_eq!(bonus[0].count, 2.0);
    assert_eq!(bonus[0].sides, 4.0);
    assert_eq!(bonus[1].count, 3.0);
    assert_eq!(bonus[1].sides, 8.0);
    assert_eq!(
        builder.to_expression()?,
        "(d20 + 1 + 3d8 + 2d4 DC 30) * (8d6) save half"
    );
    let result = res(&builder)?;
    assert_close(result.weights.success, 1.0 - 0.47534, 5);
    assert_close(result.pmf.mean(), 20.52362061, 5);
    Ok(())
}

/// src/builder/save.test.ts:574
#[test]
fn should_handle_lots_of_bonus_dice_plsu_negative_dice() -> T {
    let damage = nd_die(8.0, d6())?;
    let builder = fail(
        &d20()
            .plus(1.0)?
            .plus_dice(3.0, &d4())?
            .plus_dice(2.0, &d8())?
            .minus_roll(&d4())?
            .minus_dice(2.0, &d8())?
            .dc(30.0)?,
        damage,
    )?
    .save_half()?;
    let bonus = builder.check.get_bonus_dice_configs();
    assert_eq!(bonus.len(), 4);
    assert_eq!(bonus[0].count, 3.0);
    assert_eq!(bonus[0].sides, 4.0);
    assert_eq!(bonus[1].count, 2.0);
    assert_eq!(bonus[1].sides, 8.0);
    assert_eq!(bonus[2].count, 1.0);
    assert_eq!(bonus[2].is_subtraction, Some(true));
    assert_eq!(bonus[2].sides, 4.0);
    assert_eq!(bonus[3].count, 2.0);
    assert_eq!(bonus[3].is_subtraction, Some(true));
    assert_eq!(bonus[3].sides, 8.0);
    assert_eq!(
        builder.to_expression()?,
        "(d20 + 1 + 2d8 - 2d8 ~+ 3d4 - 1d4 DC 30) * (8d6) save half"
    );
    let result = res(&builder)?;
    assert_close(result.weights.success, 1.0 - 0.9559193611, 5);
    assert_close(result.pmf.mean(), 27.3718509, 5);
    Ok(())
}

/// src/builder/save.test.ts:612
#[test]
fn should_handle_lots_of_bonus_dice_and_the_helper() -> T {
    let damage = rn(8.0)?.d6()?;
    let builder = fail(
        &d(20.0)?
            .plus(1.0)?
            .with_bonus(&rn(3.0)?.d4()?)?
            .with_bonus(&rn(2.0)?.d8()?)?
            .with_bonus(&rn(-1.0)?.d4()?)?
            .with_bonus(&rn(-2.0)?.d8()?)?
            .dc(30.0)?,
        damage,
    )?
    .save_half()?;
    let bonus = builder.check.get_bonus_dice_configs();
    assert_eq!(bonus.len(), 4);
    assert_eq!(bonus[0].count, 3.0);
    assert_eq!(bonus[0].sides, 4.0);
    assert_eq!(bonus[1].count, 2.0);
    assert_eq!(bonus[1].sides, 8.0);
    assert_eq!(bonus[2].count, -1.0);
    assert_eq!(bonus[2].sides, 4.0);
    assert_eq!(bonus[3].count, -2.0);
    assert_eq!(bonus[3].sides, 8.0);
    assert_eq!(
        builder.to_expression()?,
        "(d20 + 1 + 2d8 - 2d8 ~+ 3d4 - 1d4 DC 30) * (8d6) save half"
    );
    let result = res(&builder)?;
    assert_close(result.weights.success, 1.0 - 0.9559193611, 5);
    assert_close(result.pmf.mean(), 27.3718509, 5);
    Ok(())
}

/// src/builder/save.test.ts:651
#[test]
fn should_handle_eps_end_to_end() -> T {
    let builder = d20().plus(5.0)?.dc(10.0)?;
    assert_eq!(builder.to_expression()?, "(d20 + 5 DC 10)");
    let eps = 0.1;
    let pmf = builder.to_pmf(eps)?;
    assert_eq!(pmf.epsilon, eps);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/save-check-outcome.test.ts
// ---------------------------------------------------------------------------------------------

/// tests/save-check-outcome.test.ts:10
#[test]
fn resolve_check_matches_the_dc_check_s_own_pmf() -> T {
    let check = d20().plus(3.0)?.dc(15.0)?;
    let r = fail(&check, nd_die(2.0, d6())?)?
        .save_half()?
        .resolve(0.0)?;
    assert_close(r.check.p_at(0.0), 9.0 / 20.0, 15);
    assert_close(r.check.p_at(1.0), 11.0 / 20.0, 15);
    let own = check.to_pmf(0.0)?;
    assert_close(own.p_at(0.0), 9.0 / 20.0, 15);
    assert_close(own.p_at(1.0), 11.0 / 20.0, 15);
    assert_close(r.check.hit_probability(), own.hit_probability(), 15);
    Ok(())
}

fn certain_success() -> Result<Vec<RollBuilder>, DiceError> {
    Ok(vec![
        d20().plus(15.0)?.dc(10.0)?,
        hd20().plus(20.0)?.dc(12.0)?,
        d20()
            .with_advantage()?
            .plus_roll(&d4())?
            .plus(9.0)?
            .dc(10.0)?,
        d20().with_disadvantage()?.plus(12.0)?.dc(13.0)?,
    ])
}

fn certain_failure() -> Result<Vec<RollBuilder>, DiceError> {
    Ok(vec![
        d20().minus(5.0)?.dc(16.0)?,
        hd20()
            .with_advantage()?
            .plus_roll(&d4())?
            .minus(10.0)?
            .dc(15.0)?,
    ])
}

/// tests/save-check-outcome.test.ts:32
#[test]
fn a_certain_success_has_exactly_one_bin() -> T {
    for check in certain_success()? {
        assert_eq!(values(&check.to_pmf(0.0)?), vec![0.0]);
        let r = fail(&check, nd_die(2.0, d6())?)?
            .save_half()?
            .resolve(0.0)?;
        assert_eq!(r.weights.fail, 0.0);
        assert_eq!(r.pmf.outcome_probability("saveFail"), 0.0);
        assert_eq!(values(&r.check), vec![0.0]);
    }
    Ok(())
}

/// tests/save-check-outcome.test.ts:42
#[test]
fn a_certain_failure_has_exactly_one_bin() -> T {
    for check in certain_failure()? {
        assert_eq!(values(&check.to_pmf(0.0)?), vec![1.0]);
        let r = fail(&check, nd_die(2.0, d6())?)?
            .save_half()?
            .resolve(0.0)?;
        assert_eq!(r.weights.success, 0.0);
        assert_eq!(r.pmf.outcome_probability("saveHalf"), 0.0);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/save-string-labels.test.ts (builder-vs-parse comparisons)
// ---------------------------------------------------------------------------------------------

/// `expectSameLabels(parsed, built)`.
fn expect_same_labels(parsed: &Pmf, built: &Pmf) {
    for label in ["saveFail", "saveHalf", "missNone", "hit"] {
        assert_close(
            parsed.outcome_probability(label),
            built.outcome_probability(label),
            12,
        );
        let a = parsed.filter_outcome(label);
        let b = built.filter_outcome(label);
        let all: BTreeSet<i64> = values(&a)
            .into_iter()
            .chain(values(&b))
            .map(|v| v as i64)
            .collect();
        for value in all {
            let v = value as f64;
            assert!(
                (a.p_at(v) - b.p_at(v)).abs() <= 1e-12,
                "{label} bin {value}: {} vs {}",
                a.p_at(v),
                b.p_at(v)
            );
        }
    }
}

/// tests/save-string-labels.test.ts:25
#[test]
fn parsed_save_3d6_labels_fail_as_save_fail_and_matches_the_builder() -> T {
    let pmf = parse_with("(d20 + 5 DC 15) * (3d6)", 0.0)?;
    assert_close(pmf.outcome_probability("saveFail"), 9.0 / 20.0, 12);
    assert_close(pmf.outcome_probability("missNone"), 11.0 / 20.0, 12);
    assert_eq!(pmf.outcome_probability("hit"), 0.0);
    let built = fail(&d20().plus(5.0)?.dc(15.0)?, nd_die(3.0, d6())?)?.to_pmf(0.0)?;
    expect_same_labels(&pmf, &built);
    Ok(())
}

/// tests/save-string-labels.test.ts:33
#[test]
fn a_failed_save_whose_payload_rolls_0_is_still_save_fail_and_matches_the_builder() -> T {
    let pmf = parse_with("(d20 DC 15) * (1d6 - 1)", 0.0)?;
    let zero = pmf.bin_at(0.0).ok_or("no 0 bin")?;
    let get = |l: &str| zero.count.get(l).copied().unwrap_or(0.0);
    assert_close(get("saveFail"), (14.0 / 20.0) * (1.0 / 6.0), 12);
    assert_close(get("missNone"), 6.0 / 20.0, 12);
    let built = fail(&d20().dc(15.0)?, nd_die(1.0, d6())?.minus(1.0)?)?.to_pmf(0.0)?;
    expect_same_labels(&pmf, &built);
    Ok(())
}

/// tests/save-string-labels.test.ts:49
#[test]
fn save_half_with_a_zero_able_payload_matches_the_builder_label_by_label() -> T {
    let parsed = parse_with("(d20 DC 15) * (1d6 - 1) save half", 0.0)?;
    let built = fail(&d20().dc(15.0)?, nd_die(1.0, d6())?.minus(1.0)?)?
        .save_half()?
        .to_pmf(0.0)?;
    expect_same_labels(&parsed, &built);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/RollSaveCache.test.ts (value assertions; cache identity is deferred)
// ---------------------------------------------------------------------------------------------

/// tests/RollSaveCache.test.ts:23
#[test]
fn roll_is_byte_identical_mean_to_an_uncached_resolution() -> T {
    let cached = mean_of(&nd(2.0, 6.0)?.plus(3.0)?)?;
    let fresh = mean_of(&nd(2.0, 6.0)?.plus(3.0)?)?;
    assert_close(cached, fresh, 12);
    Ok(())
}

/// tests/RollSaveCache.test.ts:43 (value part; the `toBe(small)` identity re-read is deferred).
#[test]
fn keeps_distinct_rolls_numerically_distinct_no_cross_contamination() -> T {
    let small = nd(1.0, 4.0)?.to_pmf(0.0)?;
    let big = nd(10.0, 10.0)?.to_pmf(0.0)?;
    assert!(small.mean() < big.mean());
    assert_eq!(nd(1.0, 4.0)?.to_pmf(0.0)?.mean(), small.mean());
    Ok(())
}

/// tests/RollSaveCache.test.ts:50
#[test]
fn never_serves_a_wrong_pmf_for_a_builder_that_opts_out_of_caching() -> T {
    assert_eq!(nd(2.0, 8.0)?.half()?.cache_key(), None);
    assert_close(mean_of(&nd(2.0, 8.0)?.half()?)?, 4.25, 6);
    assert_close(mean_of(&nd(3.0, 8.0)?.half()?)?, 6.5, 6);
    assert_close(mean_of(&nd(2.0, 8.0)?)?, 9.0, 6);
    Ok(())
}

/// tests/RollSaveCache.test.ts:72
#[test]
fn dc_is_byte_identical_to_an_uncached_resolution() -> T {
    let check = || d20().plus(5.0)?.dc(15.0);
    let cached = mean_of(&check()?)?;
    assert_close(mean_of(&check()?)?, cached, 12);
    Ok(())
}

/// tests/RollSaveCache.test.ts:84
#[test]
fn moves_failure_probability_the_right_way_when_the_dc_changes() -> T {
    let high = mean_of(&d20().plus(5.0)?.dc(20.0)?)?;
    let low = mean_of(&d20().plus(5.0)?.dc(10.0)?)?;
    assert!(high > low);
    Ok(())
}

/// tests/RollSaveCache.test.ts:90 (value part; `adv not.toBe(normal)` identity is deferred).
#[test]
fn distinguishes_advantage_and_disadvantage_on_the_save() -> T {
    let normal = mean_of(&d20().plus(5.0)?.dc(15.0)?)?;
    let adv = mean_of(&d20().with_advantage()?.plus(5.0)?.dc(15.0)?)?;
    assert!(adv < normal);
    Ok(())
}

fn cache_save() -> Result<SaveBuilder, DiceError> {
    fail(&d20().plus(5.0)?.dc(15.0)?, nd(8.0, 6.0)?)
}

/// tests/RollSaveCache.test.ts:112
#[test]
fn save_is_byte_identical_to_the_uncached_resolve() -> T {
    let cached = cache_save()?.pmf()?.mean();
    assert_close(res(&cache_save()?)?.pmf.mean(), cached, 12);
    Ok(())
}

/// tests/RollSaveCache.test.ts:124
#[test]
fn save_for_half_scores_strictly_higher_than_an_all_or_nothing_save() -> T {
    let all_or_nothing = cache_save()?.pmf()?.mean();
    let half = cache_save()?.save_half()?.pmf()?.mean();
    assert!(half > all_or_nothing);
    Ok(())
}

/// tests/RollSaveCache.test.ts:135 (the `not.toBe` identity assertions are deferred; the value ones stay).
#[test]
fn does_not_cache_when_the_failure_effect_opts_out_parsed_half_values() -> T {
    let parsed = || {
        d20()
            .plus(5.0)?
            .dc(15.0)?
            .on_save_failure_args(&[Arg::Str("8d6".to_string())])
    };
    assert_close(parsed()?.pmf()?.mean(), parsed()?.pmf()?.mean(), 12);
    let half = || fail(&d20().plus(5.0)?.dc(15.0)?, nd(8.0, 6.0)?.half()?);
    assert_close(half()?.pmf()?.mean(), half()?.pmf()?.mean(), 12);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/save-success-payload.test.ts
// ---------------------------------------------------------------------------------------------

const P_SUCCESS: f64 = 11.0 / 20.0;
const P_FAIL: f64 = 9.0 / 20.0;
const WAYS_2D6: [f64; 13] = [
    0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0,
];

fn check() -> Result<RollBuilder, DiceError> {
    d20().plus(5.0)?.dc(15.0)
}

fn failure() -> Result<RollBuilder, DiceError> {
    nd_die(2.0, d6())
}

/// `check().onSaveFailure(failure())`.
fn base_save() -> Result<SaveBuilder, DiceError> {
    fail(&check()?, failure()?)
}

/// `base_save().onSaveSuccess(payload)`.
fn with_success(payload: RollBuilder) -> Result<SaveBuilder, DiceError> {
    base_save()?.on_save_success_args(&[Arg::Roll(payload)])
}

/// `base_save().onSaveSuccess(n)`.
fn with_success_n(n: f64) -> Result<SaveBuilder, DiceError> {
    base_save()?.on_save_success_args(&[Arg::Num(n)])
}

const ONE_OR_THE_OTHER: &str = "the success branch can only be one or the other";

/// tests/save-success-payload.test.ts:30
#[test]
fn mixes_the_payload_at_p_success_and_the_failure_at_p_fail_bin_by_bin() -> T {
    let save = with_success(d4())?;
    let pmf = res(&save)?.pmf;
    for (value, ways) in WAYS_2D6.iter().enumerate() {
        let half = if (1..=4).contains(&value) {
            P_SUCCESS / 4.0
        } else {
            0.0
        };
        let fail_p = (P_FAIL * ways) / 36.0;
        let bin = pmf.bin_at(value as f64);
        let label = |l: &str| {
            bin.as_ref()
                .and_then(|b| b.count.get(l).copied())
                .unwrap_or(0.0)
        };
        assert_close(bin.as_ref().map_or(0.0, |b| b.p), half + fail_p, 12);
        assert_close(label("saveHalf"), half, 12);
        assert_close(label("saveFail"), fail_p, 12);
        assert_eq!(label("missNone"), 0.0, "missNone@{value}");
    }
    assert_close(pmf.mean(), P_SUCCESS * 2.5 + P_FAIL * 7.0, 12);
    Ok(())
}

/// tests/save-success-payload.test.ts:44
#[test]
fn reports_the_resolution_the_way_a_save_half_save_does() -> T {
    let r = res(&with_success(d4())?)?;
    assert_close(r.weights.success, P_SUCCESS, 12);
    assert_close(r.weights.fail, P_FAIL, 12);
    assert_close(r.save_fail.mean(), 7.0, 12);
    assert_close(r.save_success.mean(), 2.5, 12);
    assert_eq!(bins(&r.save_success), bins(&d4().to_pmf(0.0)?));
    let control = res(&base_save()?.save_half()?)?;
    assert_eq!(bins(&r.check), bins(&control.check));
    assert_eq!(bins(&r.save_fail), bins(&control.save_fail));
    assert_eq!(r.pmf.outcomes(), vec!["saveFail", "saveHalf"]);
    Ok(())
}

/// tests/save-success-payload.test.ts:57
#[test]
fn labels_the_success_save_half_whatever_it_deals_a_flat_0_included() -> T {
    let zero = res(&with_success_n(0.0)?)?.pmf;
    assert_close(zero.outcome_probability("saveHalf"), P_SUCCESS, 12);
    assert_eq!(zero.outcome_probability("missNone"), 0.0);
    let at_zero = zero.bin_at(0.0).ok_or("no 0 bin")?;
    assert_close(
        at_zero.count.get("saveHalf").copied().unwrap_or(f64::NAN),
        P_SUCCESS,
        12,
    );
    let plain = res(&base_save()?)?.pmf;
    assert_close(plain.outcome_probability("missNone"), P_SUCCESS, 12);
    assert_eq!(plain.outcome_probability("saveHalf"), 0.0);
    assert_close(zero.mean(), plain.mean(), 12);
    Ok(())
}

/// tests/save-success-payload.test.ts:69
#[test]
fn takes_a_number_as_a_flat_payload_negative_included() -> T {
    let three = res(&with_success_n(3.0)?)?;
    assert_eq!(three.save_success.p_at(3.0), 1.0);
    assert_close(
        three.pmf.p_at(3.0),
        P_SUCCESS + (P_FAIL * WAYS_2D6[3]) / 36.0,
        12,
    );
    let negative = res(&with_success_n(-2.0)?)?;
    assert_eq!(negative.save_success.p_at(-2.0), 1.0);
    assert_close(negative.pmf.p_at(-2.0), P_SUCCESS, 12);
    Ok(())
}

/// tests/save-success-payload.test.ts:78
#[test]
fn reads_a_parsed_string_payload_the_way_on_save_failure_reads_one() -> T {
    let parsed = res(&with_success(d_expression("1d4")?)?)?;
    assert_eq!(bins(&parsed.pmf), bins(&res(&with_success(d4())?)?.pmf));
    let pairs = |p: &Pmf| -> Vec<(f64, f64)> { p.map.iter().map(|(k, b)| (k.0, b.p)).collect() };
    assert_eq!(pairs(&parsed.save_success), pairs(&d4().to_pmf(0.0)?));
    Ok(())
}

/// tests/save-success-payload.test.ts:89
#[test]
fn a_certain_success_is_the_payload_alone_and_a_certain_failure_the_failure_payload_alone() -> T {
    let success = res(&fail(&d20().plus(30.0)?.dc(10.0)?, failure()?)?
        .on_save_success_args(&[Arg::Roll(d4())])?)?;
    assert_eq!(success.pmf.outcome_probability("saveFail"), 0.0);
    let vp = |p: &Pmf| -> Vec<(f64, f64)> { bins(p).into_iter().map(|(v, p, _)| (v, p)).collect() };
    assert_eq!(vp(&success.pmf), vp(&d4().to_pmf(0.0)?));
    let failed =
        res(&fail(&d20().dc(30.0)?, failure()?)?.on_save_success_args(&[Arg::Roll(d4())])?)?;
    assert_eq!(failed.pmf.outcome_probability("saveHalf"), 0.0);
    assert_close(failed.pmf.mean(), 7.0, 12);
    Ok(())
}

/// tests/save-success-payload.test.ts:100
#[test]
fn deals_nothing_on_a_failure_and_the_payload_on_a_success() -> T {
    let r = res(
        &SaveBuilder::new(check()?, None, SaveOutcome::Normal, Vec::new())
            .on_save_success_args(&[Arg::Num(3.0)])?,
    )?;
    assert_close(r.pmf.p_at(3.0), P_SUCCESS, 12);
    assert_close(r.pmf.p_at(0.0), P_FAIL, 12);
    assert_close(r.pmf.outcome_probability("saveFail"), P_FAIL, 12);
    assert_close(r.pmf.outcome_probability("saveHalf"), P_SUCCESS, 12);
    Ok(())
}

/// tests/save-success-payload.test.ts:110 (`withSuccess not.toBe(plain)` is TS identity: immutable by value here).
#[test]
fn leaves_the_save_it_was_called_on_unchanged() -> T {
    let plain = base_save()?;
    let before = bins(&plain.pmf()?);
    let _with_success = plain.on_save_success_args(&[Arg::Roll(d4())])?;
    assert_eq!(bins(&plain.pmf()?), before);
    assert_eq!(plain.pmf()?.outcome_probability("saveHalf"), 0.0);
    Ok(())
}

/// tests/save-success-payload.test.ts:119
#[test]
fn save_half_after_on_save_success_throws_and_so_does_the_reverse() -> T {
    let half = base_save()?.save_half()?;
    let payload = with_success(d4())?;
    assert_throws(
        payload.save_half(),
        "saveHalf() cannot be combined with onSaveSuccess(): the success branch can only be one or the other.",
    );
    assert_throws(
        half.on_save_success_args(&[Arg::Roll(d4())]),
        "onSaveSuccess() cannot be combined with saveHalf(): the success branch can only be one or the other.",
    );
    assert_throws(
        half.on_save_success_args(&[Arg::Num(3.0)]),
        ONE_OR_THE_OTHER,
    );
    assert_throws(
        half.on_save_success_args(&[Arg::Str("1d4".to_string())]),
        ONE_OR_THE_OTHER,
    );
    assert_eq!(bins(&half.pmf()?), bins(&base_save()?.save_half()?.pmf()?));
    Ok(())
}

/// tests/save-success-payload.test.ts:134
#[test]
fn repeats_are_fine_save_half_twice_is_one_half_a_second_on_save_success_replaces_the_first() -> T {
    let half = base_save()?.save_half()?;
    assert_eq!(bins(&half.save_half()?.pmf()?), bins(&half.pmf()?));
    let payload = with_success(d4())?;
    assert_eq!(
        bins(&payload.on_save_success_args(&[Arg::Roll(d6())])?.pmf()?),
        bins(&with_success(d6())?.pmf()?)
    );
    Ok(())
}

/// tests/save-success-payload.test.ts:147
#[test]
fn on_save_success_takes_the_same_arguments_as_on_save_failure() -> T {
    let ok = |args: &[Arg]| -> Result<SaveBuilder, DiceError> {
        base_save()?.on_save_success_args(args)
    };
    let plus1 = nd_die(2.0, d6())?.plus(1.0)?;
    let cases: Vec<(&str, SaveBuilder, SaveBuilder)> = vec![
        (
            "number",
            ok(&[Arg::Num(3.0)])?,
            ok(&[Arg::Roll(flat(3.0)?)])?,
        ),
        (
            "string",
            ok(&[Arg::Str("1d4".to_string())])?,
            ok(&[Arg::Roll(d_expression("1d4")?)])?,
        ),
        (
            "RollBuilder",
            ok(&[Arg::Roll(d4())])?,
            ok(&[Arg::Roll(nd_die(1.0, d4())?)])?,
        ),
        (
            "(count, die)",
            ok(&[Arg::Num(2.0), Arg::Roll(d6())])?,
            ok(&[Arg::Roll(nd_die(2.0, d6())?)])?,
        ),
        (
            "(count, sides)",
            ok(&[Arg::Num(2.0), Arg::Num(6.0)])?,
            ok(&[Arg::Roll(nd_die(2.0, d6())?)])?,
        ),
        (
            "(count, die, modifier)",
            ok(&[Arg::Num(2.0), Arg::Roll(d6()), Arg::Num(1.0)])?,
            ok(&[Arg::Roll(plus1.clone())])?,
        ),
        (
            "(count, sides, modifier)",
            ok(&[Arg::Num(2.0), Arg::Num(6.0), Arg::Num(1.0)])?,
            ok(&[Arg::Roll(plus1.clone())])?,
        ),
    ];
    for (name, actual, expected) in &cases {
        assert_eq!(bins(&actual.pmf()?), bins(&expected.pmf()?), "{name}");
    }
    let eight = res(&ok(&[Arg::Num(2.0), Arg::Num(6.0), Arg::Num(1.0)])?)?;
    assert_close(eight.save_success.mean(), 8.0, 12);
    let a = check()?
        .on_save_failure_args(&[Arg::Num(2.0), Arg::Num(6.0), Arg::Num(1.0)])?
        .pmf()?;
    let b = fail(&check()?, plus1)?.pmf()?;
    assert_eq!(bins(&a), bins(&b));
    Ok(())
}

/// tests/save-success-payload.test.ts:165
#[test]
fn refuses_the_arguments_on_save_failure_refuses() -> T {
    let base = base_save()?;
    err_of(base.on_save_success_args(&[Arg::Num(f64::NAN)]));
    err_of(base.on_save_success_args(&[Arg::Num(f64::INFINITY)]));
    err_of(base.on_save_success_args(&[Arg::Str("x".to_string()), Arg::Num(6.0)]));
    err_of(base.on_save_success_args(&[
        Arg::Num(1.0),
        Arg::Num(2.0),
        Arg::Num(3.0),
        Arg::Num(4.0),
    ]));
    Ok(())
}

/// tests/save-success-payload.test.ts:176
#[test]
fn the_plain_half_is_save_half_bit_for_bit_at_every_eps() -> T {
    let payloads = vec![
        failure()?,
        nd_die(3.0, d6())?.plus(2.0)?,
        nd_die(8.0, d6())?,
        nd_die(1.0, d6())?.minus(1.0)?,
    ];
    for payload in payloads {
        let half = fail(&check()?, payload.clone())?.save_half()?;
        let explicit = fail(&check()?, payload.clone())?
            .on_save_success_args(&[Arg::Roll(payload.half()?)])?;
        for eps in [EPS, 0.0, 1e-12, 1e-6] {
            let a = half.resolve(eps)?;
            let b = explicit.resolve(eps)?;
            assert_eq!(bins(&b.pmf), bins(&a.pmf), "pmf eps {eps}");
            assert_eq!(bins(&b.save_success), bins(&a.save_success));
            assert_eq!(bins(&b.save_fail), bins(&a.save_fail));
            assert_eq!(b.weights, a.weights);
        }
    }
    Ok(())
}

fn halved_before_scale_save() -> Result<SaveBuilder, DiceError> {
    let base = nd_die(2.0, d4())?;
    let failure_scaled = base.scale_result(2.0, 1.0, Rounding::Floor)?;
    let success_scaled = base.half()?.scale_result(2.0, 1.0, Rounding::Floor)?;
    d20()
        .dc(12.0)?
        .on_save_failure_args(&[Arg::Roll(failure_scaled)])?
        .on_save_success_args(&[Arg::Roll(success_scaled)])
}

/// tests/save-success-payload.test.ts:204
#[test]
fn deals_the_hand_computed_mixture_each_bin_and_each_label() -> T {
    let save = halved_before_scale_save()?;
    let f: [(f64, f64); 7] = [
        (4.0, 1.0),
        (6.0, 2.0),
        (8.0, 3.0),
        (10.0, 4.0),
        (12.0, 3.0),
        (14.0, 2.0),
        (16.0, 1.0),
    ];
    let s: [(f64, f64); 4] = [(2.0, 3.0), (4.0, 7.0), (6.0, 5.0), (8.0, 1.0)];
    let p_success = 9.0 / 20.0;
    let p_fail = 11.0 / 20.0;
    let lookup =
        |t: &[(f64, f64)], v: f64| t.iter().find(|(k, _)| *k == v).map_or(0.0, |(_, w)| *w);
    let pmf = res(&save)?.pmf;
    let expected: BTreeSet<i64> = f.iter().chain(s.iter()).map(|(k, _)| *k as i64).collect();
    let got: BTreeSet<i64> = values(&pmf).into_iter().map(|v| v as i64).collect();
    assert_eq!(got, expected);
    for value in expected {
        let v = value as f64;
        let half = (p_success * lookup(&s, v)) / 16.0;
        let fail_p = (p_fail * lookup(&f, v)) / 16.0;
        let bin = pmf.bin_at(v);
        let label = |l: &str| {
            bin.as_ref()
                .and_then(|b| b.count.get(l).copied())
                .unwrap_or(0.0)
        };
        assert_close(pmf.p_at(v), half + fail_p, 12);
        assert_close(label("saveHalf"), half, 12);
        assert_close(label("saveFail"), fail_p, 12);
    }
    Ok(())
}

/// tests/save-success-payload.test.ts:217 (the `d20.dc(12).onSaveFailure(failureScaled).saveHalf()` control).
#[test]
fn means_0_45_x_4_5_plus_0_55_x_10_below_the_7_75_of_halving_after_the_doubling() -> T {
    let save = halved_before_scale_save()?;
    assert_close(res(&save)?.pmf.mean(), 0.45 * 4.5 + 0.55 * 10.0, 12);
    let failure_scaled = nd_die(2.0, d4())?.scale_result(2.0, 1.0, Rounding::Floor)?;
    let after = fail(&d20().dc(12.0)?, failure_scaled)?
        .save_half()?
        .pmf()?
        .mean();
    assert_close(after, 0.45 * 5.0 + 0.55 * 10.0, 12);
    assert!(save.pmf()?.mean() < after);
    Ok(())
}

/// tests/save-success-payload.test.ts:259 (value part; the `not.toBe` identities are deferred).
#[test]
fn cache_forks_the_key_on_the_success_payload_value_part() -> T {
    let d4_mean = with_success(d4())?.pmf()?.mean();
    let d6_mean = with_success(d6())?.pmf()?.mean();
    assert_close(d4_mean, P_SUCCESS * 2.5 + P_FAIL * 7.0, 12);
    assert_close(d6_mean, P_SUCCESS * 3.5 + P_FAIL * 7.0, 12);
    assert_close(
        with_success_n(3.0)?.pmf()?.mean(),
        P_SUCCESS * 3.0 + P_FAIL * 7.0,
        12,
    );
    assert_close(
        with_success_n(4.0)?.pmf()?.mean(),
        P_SUCCESS * 4.0 + P_FAIL * 7.0,
        12,
    );
    assert_eq!(with_success(d4())?.pmf()?.mean(), d4_mean);
    Ok(())
}

/// tests/save-success-payload.test.ts:271 (value part; the `not.toBe` identities are deferred).
#[test]
fn cache_forks_the_key_against_the_plain_save_and_save_half_value_part() -> T {
    let plain = base_save()?.pmf()?;
    let half = base_save()?.save_half()?.pmf()?;
    let payload = with_success(failure()?.half()?)?.pmf()?;
    assert_eq!(bins(&payload), bins(&half));
    assert_close(
        with_success_n(0.0)?.pmf()?.outcome_probability("saveHalf"),
        P_SUCCESS,
        12,
    );
    assert_eq!(plain.outcome_probability("saveHalf"), 0.0);
    Ok(())
}

/// tests/save-success-payload.test.ts:283 (the `not.toBe` identity is deferred).
#[test]
fn does_not_cache_when_the_success_payload_opts_out_and_still_resolves_it_right() -> T {
    for payload in [d_expression("1d4")?, d4().half()?] {
        assert_eq!(payload.cache_key(), None);
        let a = with_success(payload.clone())?.pmf()?;
        let b = with_success(payload)?.pmf()?;
        assert_eq!(bins(&b), bins(&a));
    }
    assert_close(
        with_success(d_expression("1d4")?)?.pmf()?.mean(),
        P_SUCCESS * 2.5 + P_FAIL * 7.0,
        12,
    );
    assert_close(
        with_success(d4().half()?)?.pmf()?.mean(),
        P_SUCCESS * 1.0 + P_FAIL * 7.0,
        12,
    );
    Ok(())
}

fn expression_cases() -> Result<Vec<(&'static str, SaveBuilder, &'static str)>, DiceError> {
    let no_failure = SaveBuilder::new(check()?, None, SaveOutcome::Normal, Vec::new());
    Ok(vec![
        (
            "a builder payload",
            with_success(d4())?,
            "(d20 + 5 DC 15) * (2d6) save (1d4)",
        ),
        (
            "a flat payload",
            with_success_n(3.0)?,
            "(d20 + 5 DC 15) * (2d6) save (3)",
        ),
        (
            "a flat 0",
            with_success_n(0.0)?,
            "(d20 + 5 DC 15) * (2d6) save (0)",
        ),
        (
            "a negative flat",
            with_success_n(-2.0)?,
            "(d20 + 5 DC 15) * (2d6) save (0 - 2)",
        ),
        (
            "a parsed payload",
            with_success(d_expression("3d6")?)?,
            "(d20 + 5 DC 15) * (2d6) save (3d6)",
        ),
        (
            "a half payload",
            with_success(failure()?.half()?)?,
            "(d20 + 5 DC 15) * (2d6) save ((2d6) // 2)",
        ),
        (
            "halved before doubled",
            fail(
                &check()?,
                nd_die(2.0, d4())?.scale_result(2.0, 1.0, Rounding::Floor)?,
            )?
            .on_save_success_args(&[Arg::Roll(
                nd_die(2.0, d4())?
                    .half()?
                    .scale_result(2.0, 1.0, Rounding::Floor)?,
            )])?,
            "(d20 + 5 DC 15) * (2 ** (2d4)) save (2 ** ((2d4) // 2))",
        ),
        (
            "no failure effect",
            no_failure.on_save_success_args(&[Arg::Num(3.0)])?,
            "(d20 + 5 DC 15) * (0) save (3)",
        ),
    ])
}

/// tests/save-success-payload.test.ts:318 (`it.each(cases)`: one loop).
#[test]
fn expression_prints_each_case() -> T {
    for (name, save, expected) in expression_cases()? {
        assert_eq!(save.to_expression()?, expected, "{name}");
    }
    Ok(())
}

/// tests/save-success-payload.test.ts:322 (`it.each(cases)`: one loop).
#[test]
fn expression_reads_back_to_the_save_s_own_distribution_bin_by_bin_and_label_by_label() -> T {
    for (name, save, _) in expression_cases()? {
        let parsed = parse_with(&save.to_expression()?, 0.0)?;
        let built = save.pmf()?;
        assert_eq!(values(&parsed), values(&built), "{name}");
        for v in values(&built) {
            assert!(
                (parsed.p_at(v) - built.p_at(v)).abs() <= 1e-12,
                "{name} p@{v}"
            );
            for label in ["saveHalf", "saveFail", "missNone"] {
                let get = |p: &Pmf| {
                    p.bin_at(v)
                        .and_then(|b| b.count.get(label).copied())
                        .unwrap_or(0.0)
                };
                assert!(
                    (get(&parsed) - get(&built)).abs() <= 1e-12,
                    "{name} {label}@{v}"
                );
            }
        }
    }
    Ok(())
}

/// tests/save-success-payload.test.ts:336
#[test]
fn keeps_the_strings_of_a_plain_save_a_save_half_save_and_a_save_with_no_failure_effect() -> T {
    assert_eq!(base_save()?.to_expression()?, "(d20 + 5 DC 15) * (2d6)");
    assert_eq!(
        base_save()?.save_half()?.to_expression()?,
        "(d20 + 5 DC 15) * (2d6) save half"
    );
    let none = SaveBuilder::new(check()?, None, SaveOutcome::Normal, Vec::new());
    assert_eq!(none.to_expression()?, "(d20 + 5 DC 15)");
    assert_eq!(none.save_half()?.to_expression()?, "(d20 + 5 DC 15)");
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/sample-save.test.ts
// ---------------------------------------------------------------------------------------------

fn sample_check() -> Result<RollBuilder, DiceError> {
    d20().plus(3.0)?.dc(15.0)
}

/// tests/sample-save.test.ts:46
#[test]
fn check_fails_below_the_dc_and_passes_at_it() -> T {
    let check = sample_check()?;
    let mut rng = dice(&[11.0]);
    assert_eq!(
        check.sample_dc_check(&mut rng, None)?,
        CheckSample {
            check: vec![sd(20.0, 11.0, true)],
            total: 14.0,
            failed: true
        }
    );
    let mut rng = dice(&[12.0]);
    let s = check.sample_dc_check(&mut rng, None)?;
    assert_eq!(s.total, 15.0);
    assert!(!s.failed);
    rng.done()
}

/// tests/sample-save.test.ts:51
#[test]
fn check_subtracts_penalty_dice_from_the_context_and_auto_fails_without_a_draw() -> T {
    let check = sample_check()?;
    let ctx = RowContext {
        penalty_dice: vec![PenaltyDice {
            count: 1.0,
            sides: 4.0,
        }],
        ..flat_ctx()
    };
    let mut rng = dice(&[13.0, 2.0]);
    let s = check.sample_dc_check(&mut rng, Some(&ctx))?;
    assert_eq!(s.total, 14.0);
    assert!(s.failed);
    assert_eq!(
        s.check.iter().map(|x| x.sides).collect::<Vec<_>>(),
        vec![20.0, 4.0]
    );
    rng.done()?;
    let none = CheckSample {
        check: Vec::new(),
        total: 0.0,
        failed: true,
    };
    let mut rng = dice(&[]);
    let auto = RowContext {
        auto_fail: true,
        ..flat_ctx()
    };
    assert_eq!(check.sample_dc_check(&mut rng, Some(&auto))?, none);
    assert_eq!(check.always_fails()?.sample_dc_check(&mut rng, None)?, none);
    rng.done()
}

/// tests/sample-save.test.ts:59
#[test]
fn check_rolls_the_context_s_roll_type_unless_pinned() -> T {
    let check = sample_check()?;
    let ctx = RowContext {
        roll_type: RollType::Advantage,
        ..flat_ctx()
    };
    let mut rng = dice(&[4.0, 12.0]);
    let s = check.sample_dc_check(&mut rng, Some(&ctx))?;
    assert_eq!(s.total, 15.0);
    assert!(!s.failed);
    assert_eq!(
        s.check.iter().map(|x| x.kept).collect::<Vec<_>>(),
        vec![false, true]
    );
    rng.done()?;
    let mut rng = dice(&[4.0]);
    let pinned = d20().plus(3.0)?.pinned()?.dc(15.0)?;
    assert!(pinned.sample_dc_check(&mut rng, Some(&ctx))?.failed);
    rng.done()
}

fn fireball() -> Result<SaveBuilder, DiceError> {
    fail(&sample_check()?, nd(8.0, 6.0)?)?.save_half()
}

/// tests/sample-save.test.ts:70
#[test]
fn fails_below_the_dc_and_rolls_full_damage_by_the_enemy() -> T {
    let mut rng = dice(&[11.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    let s = fireball()?.sample(&mut rng, None)?;
    assert_eq!(s.outcome, SaveSampleOutcome::Fail);
    assert_eq!(s.total, 8.0);
    assert_eq!(s.check, vec![sd(20.0, 11.0, true)]);
    assert_eq!(s.damage.len(), 8);
    rng.done()
}

/// tests/sample-save.test.ts:77
#[test]
fn passes_at_the_dc_and_floors_half() -> T {
    let mut rng = dice(&[12.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0]);
    let s = fireball()?.sample(&mut rng, None)?;
    assert_eq!(s.outcome, SaveSampleOutcome::Pass);
    assert_eq!(s.total, 4.0);
    assert_eq!(s.damage.len(), 8);
    rng.done()
}

/// tests/sample-save.test.ts:83
#[test]
fn sample_subtracts_penalty_dice_and_auto_fails_from_the_context() -> T {
    let ctx = RowContext {
        penalty_dice: vec![PenaltyDice {
            count: 1.0,
            sides: 4.0,
        }],
        ..flat_ctx()
    };
    let mut rng = dice(&[13.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    assert_eq!(
        fireball()?.sample(&mut rng, Some(&ctx))?.outcome,
        SaveSampleOutcome::Fail
    );
    rng.done()?;
    let auto = RowContext {
        auto_fail: true,
        ..flat_ctx()
    };
    let mut rng = dice(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    assert_eq!(
        fireball()?.sample(&mut rng, Some(&auto))?.outcome,
        SaveSampleOutcome::Fail
    );
    rng.done()
}

/// tests/sample-save.test.ts:89
#[test]
fn has_no_natural_20_rule() -> T {
    let save = fail(&d20().plus(0.0)?.dc(25.0)?, nd(1.0, 4.0)?)?;
    let mut rng = dice(&[20.0, 1.0]);
    assert_eq!(
        save.sample(&mut rng, None)?.outcome,
        SaveSampleOutcome::Fail
    );
    rng.done()
}

/// tests/sample-save.test.ts:93
#[test]
fn doubles_a_vulnerable_failure_and_leaves_a_pass_alone() -> T {
    let ctx = RowContext {
        vulnerable: true,
        ..flat_ctx()
    };
    let mut rng = dice(&[11.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    assert_eq!(fireball()?.sample(&mut rng, Some(&ctx))?.total, 16.0);
    rng.done()?;
    let mut rng = dice(&[12.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    assert_eq!(fireball()?.sample(&mut rng, Some(&ctx))?.total, 4.0);
    rng.done()
}

/// tests/sample-save.test.ts:99
#[test]
fn a_plain_pass_still_draws_the_failure_dice_and_deals_0() -> T {
    let save = fail(&sample_check()?, nd(2.0, 6.0)?)?;
    let mut rng = dice(&[12.0, 4.0, 5.0]);
    let s = save.sample(&mut rng, None)?;
    assert_eq!(s.outcome, SaveSampleOutcome::Pass);
    assert_eq!(s.total, 0.0);
    assert_eq!(
        s.damage.iter().map(|x| x.face).collect::<Vec<_>>(),
        vec![4.0, 5.0]
    );
    rng.done()
}

/// tests/sample-save.test.ts:105
#[test]
fn on_save_success_draws_its_own_payload_after_the_failure_dice_which_stay_in_the_trace_dropped()
-> T {
    let save =
        fail(&sample_check()?, nd(2.0, 6.0)?)?.on_save_success_args(&[Arg::Roll(d(4.0)?)])?;
    let mut rng = dice(&[12.0, 4.0, 5.0, 3.0]);
    let s = save.sample(&mut rng, None)?;
    assert_eq!(s.outcome, SaveSampleOutcome::Pass);
    assert_eq!(s.total, 3.0);
    assert_eq!(
        s.damage,
        vec![sd(6.0, 4.0, false), sd(6.0, 5.0, false), sd(4.0, 3.0, true)]
    );
    rng.done()
}

/// tests/sample-save.test.ts:115 (`rollUnder(flat)` `toBe(fireball)` is TS identity: asserted as an equal expression).
#[test]
fn roll_under_returns_the_save_re_derived_in_the_context() -> T {
    let auto = RowContext {
        auto_fail: true,
        ..flat_ctx()
    };
    assert!(fireball()?.roll_under(&auto)?.check.auto_fail());
    let same = fireball()?.roll_under(&flat_ctx())?;
    assert_eq!(same.to_expression()?, fireball()?.to_expression()?);
    assert_eq!(bins(&same.pmf()?), bins(&fireball()?.pmf()?));
    Ok(())
}

/// tests/sample-save.test.ts:120
#[test]
fn tracks_the_pmf_mean() -> T {
    let mut rng = Lcg { st: 7 };
    let save = fail(
        &d20().plus(4.0)?.with_disadvantage()?.dc(16.0)?,
        roll_dice(3.0, 8.0, Some(2.0))?,
    )?
    .save_half()?;
    let n = 40000;
    let mut sum = 0.0;
    for _ in 0..n {
        sum += save.sample(&mut rng, None)?.total;
    }
    assert_close(sum / f64::from(n), save.pmf()?.mean(), 0);
    Ok(())
}

/// tests/sample-save.test.ts:136
#[test]
fn tracks_under_context_for_every_context_flag() -> T {
    let mut rng = Mulberry32 { a: 11 };
    let save = fail(
        &d20().plus_roll(&d(4.0)?)?.plus(2.0)?.dc(14.0)?,
        nd(4.0, 6.0)?,
    )?
    .save_half()?;
    let contexts = vec![
        RowContext {
            roll_type: RollType::Advantage,
            vulnerable: true,
            ..flat_ctx()
        },
        RowContext {
            roll_type: RollType::Disadvantage,
            penalty_dice: vec![PenaltyDice {
                count: 1.0,
                sides: 4.0,
            }],
            ..flat_ctx()
        },
        RowContext {
            auto_fail: true,
            vulnerable: true,
            ..flat_ctx()
        },
    ];
    let n = 20000;
    for ctx in &contexts {
        let mut sum = 0.0;
        for _ in 0..n {
            sum += save.sample(&mut rng, Some(ctx))?.total;
        }
        assert_close(sum / f64::from(n), save.under(ctx, 0.0)?.mean(), 0);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/tags-and-save.test.ts (non-turn parts)
// ---------------------------------------------------------------------------------------------

fn tag_sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    d20().plus(7.0)?.ac(15.0)?.on_hit(d8().plus(4.0)?)
}

fn tag_blade() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    tag_sword()?.tagged(&["blade"])
}

/// tests/tags-and-save.test.ts:41 (the `tags` assertions; the `turn(...)` comparison is deferred).
#[test]
fn adds_to_the_tags_on_a_second_call_whatever_the_order_around_on_every_hit() -> T {
    let vex = advantage().until_next_attack();
    let before = tag_blade()?
        .on_every_hit_with(Grants::One(vex.clone().into()), None)?
        .tagged(&["finesse"])?;
    let after = tag_sword()?
        .on_every_hit_with(Grants::One(vex.into()), None)?
        .tagged(&["finesse", "blade"])?;
    assert_eq!(before.tags, vec!["blade", "finesse"]);
    assert_eq!(after.tags, vec!["finesse", "blade"]);
    Ok(())
}

/// tests/tags-and-save.test.ts:50 (the `tags` assertion; the `turn(...)` comparison is deferred).
#[test]
fn tags_survive_every_rebuilding_method() -> T {
    let tagged = tag_blade()?.melee()?.reroll_damage(1.0)?.half_on_miss()?;
    assert_eq!(tagged.tags, vec!["blade"]);
    Ok(())
}

/// tests/tags-and-save.test.ts:90 (`tagged()` refusals; `tagged("blade", undefined)` cannot be
/// expressed with `&[&str]`; the forged non-string tag and the `unknown-id` check need `turn(...)`).
#[test]
fn tagged_refuses_no_tag_and_an_empty_one() -> T {
    let sword = tag_sword()?;
    assert_throws(sword.tagged(&[]), "tagged() takes at least one tag");
    assert_throws(sword.tagged(&[""]), "tagged() takes non-empty strings");
    Ok(())
}

/// tests/tags-and-save.test.ts:141 (the refusals of `save(...)` itself; the `turn(...)`/`onEveryHit`
/// refusals need `stunned()` from dnd5e. `save([], { fail: stun })` uses `advantage().untilNextAttack()`
/// as the effect: the empty check is refused before the effect is read).
#[test]
fn save_refuses_no_fail_effect_or_no_check() -> T {
    let check = d20().plus(3.0)?.dc(14.0)?.ability("con")?;
    let one = || TriggerSaves::One(TriggerSave::Dc(check.clone()));
    assert_throws(
        save_gated(one(), Vec::new(), None),
        "save() needs at least one effect on a failed save.",
    );
    let next = advantage().until_next_attack();
    assert_throws(
        save_gated(TriggerSaves::Many(Vec::new()), vec![next.into()], None),
        "save() needs a DC check",
    );
    Ok(())
}
