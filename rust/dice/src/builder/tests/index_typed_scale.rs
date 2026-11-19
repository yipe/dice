//! Translations of src/builder/{index,typed,scale}.test.ts.
//! index.test.ts: 44 translated, 0 deferred. typed.test.ts: 0 translated, 5 deferred.
//! scale.test.ts: 11 translated, 1 deferred.

use super::support::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{RollBuilder, RollKind, sum_rolls};
use crate::error::DiceError;
use crate::parser::parse_with;

fn r(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

fn rm(count: f64, sides: f64, m: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, Some(m))
}

fn die(count: f64, b: &RollBuilder, m: Option<f64>) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(b.clone())), m)
}

/// src/builder/index.test.ts:8
#[test]
fn should_create_roll_builder_with_count_only() -> T {
    let builder = roll_with(3.0, None, None)?;
    assert_eq!(builder.to_expression()?, "0");
    Ok(())
}

/// src/builder/index.test.ts:14
#[test]
fn should_create_roll_builder_with_count_and_sides() -> T {
    let builder = r(2.0, 6.0)?;
    assert_eq!(builder.to_expression()?, "2d6");
    Ok(())
}

/// src/builder/index.test.ts:20
#[test]
fn should_create_roll_builder_with_count_sides_and_modifier() -> T {
    let builder = rm(3.0, 8.0, 4.0)?;
    assert_eq!(builder.to_expression()?, "3d8 + 4");
    Ok(())
}

/// src/builder/index.test.ts:26
#[test]
fn should_handle_zero_count() -> T {
    let builder = roll_with(0.0, None, None)?;
    assert_eq!(builder.to_expression()?, "0");
    Ok(())
}

/// src/builder/index.test.ts:32
#[test]
fn should_handle_zero_sides_should_not_add_dice() -> T {
    let builder = r(2.0, 0.0)?;
    assert_eq!(builder.to_expression()?, "0");
    Ok(())
}

/// src/builder/index.test.ts:42
#[test]
fn should_handle_zero_modifier() -> T {
    let builder = rm(2.0, 6.0, 0.0)?;
    assert_eq!(builder.to_expression()?, "2d6");
    Ok(())
}

/// src/builder/index.test.ts:48
#[test]
fn should_handle_negative_modifier() -> T {
    let builder = rm(4.0, 6.0, -2.0)?;
    assert_eq!(builder.to_expression()?, "4d6 - 2");
    Ok(())
}

/// src/builder/index.test.ts:54
#[test]
fn should_handle_undefined_sides_parameter() -> T {
    let builder = roll_with(2.0, None, None)?;
    assert_eq!(builder.to_expression()?, "0");
    Ok(())
}

/// src/builder/index.test.ts:60
#[test]
fn should_handle_undefined_modifier_parameter() -> T {
    let builder = roll_dice(3.0, 8.0, None)?;
    assert_eq!(builder.to_expression()?, "3d8");
    Ok(())
}

/// src/builder/index.test.ts:66
#[test]
fn should_handle_all_undefined_parameters_except_count() -> T {
    let builder = roll_with(5.0, None, None)?;
    assert_eq!(builder.to_expression()?, "0");
    Ok(())
}

/// src/builder/index.test.ts:125
#[test]
fn should_create_single_die_with_specified_sides() -> T {
    let builder = d(6.0)?;
    assert_eq!(builder.to_expression()?, "1d6");
    Ok(())
}

/// src/builder/index.test.ts:137
#[test]
fn should_create_single_d4() -> T {
    let builder = d4();
    assert_eq!(builder.to_expression()?, "1d4");
    Ok(())
}

/// src/builder/index.test.ts:143
#[test]
fn should_create_single_d6() -> T {
    let builder = d6();
    assert_eq!(builder.to_expression()?, "1d6");
    Ok(())
}

/// src/builder/index.test.ts:149
#[test]
fn should_create_single_d8() -> T {
    let builder = d8();
    assert_eq!(builder.to_expression()?, "1d8");
    Ok(())
}

/// src/builder/index.test.ts:155
#[test]
fn should_create_single_d10() -> T {
    let builder = d10();
    assert_eq!(builder.to_expression()?, "1d10");
    Ok(())
}

/// src/builder/index.test.ts:161
#[test]
fn should_create_single_d12() -> T {
    let builder = d12();
    assert_eq!(builder.to_expression()?, "1d12");
    Ok(())
}

/// src/builder/index.test.ts:167
#[test]
fn should_create_single_d20() -> T {
    let builder = d20();
    assert_eq!(builder.to_expression()?, "d20");
    Ok(())
}

/// src/builder/index.test.ts:173
#[test]
fn should_create_single_d100() -> T {
    let builder = d100();
    assert_eq!(builder.to_expression()?, "1d100");
    Ok(())
}

/// src/builder/index.test.ts:179
#[test]
fn should_create_flat_amount_with_positive_number() -> T {
    let builder = flat(5.0)?;
    assert_eq!(builder.to_expression()?, "5");
    Ok(())
}

/// src/builder/index.test.ts:185
#[test]
fn should_create_flat_amount_with_zero() -> T {
    let builder = flat(0.0)?;
    assert_eq!(builder.to_expression()?, "0");
    Ok(())
}

/// src/builder/index.test.ts:191
#[test]
fn should_create_flat_amount_with_negative_number() -> T {
    let builder = flat(-3.0)?;
    assert_eq!(builder.to_expression()?, "0 - 3");
    Ok(())
}

/// src/builder/index.test.ts:197
#[test]
fn should_handle_decimal_numbers() -> T {
    let builder = flat(2.5)?;
    assert_eq!(builder.to_expression()?, "2.5");
    Ok(())
}

/// src/builder/index.test.ts:264
#[test]
fn should_handle_very_large_numbers() -> T {
    let builder = rm(1000.0, 6.0, 500.0)?;
    assert_eq!(builder.to_expression()?, "1000d6 + 500");
    Ok(())
}

/// src/builder/index.test.ts:269
#[test]
fn should_handle_very_small_numbers() -> T {
    let builder = rm(1.0, 1.0, 1.0)?;
    assert_eq!(builder.to_expression()?, "1d1 + 1");
    Ok(())
}

/// src/builder/index.test.ts:274
#[test]
fn should_handle_floating_point_numbers() -> T {
    let builder = rm(2.5, 6.0, 1.5)?;
    assert_eq!(builder.to_expression()?, "2d6 + 1.5");
    Ok(())
}

/// src/builder/index.test.ts:279
#[test]
fn should_handle_negative_count() -> T {
    let builder = rm(-2.0, 6.0, 3.0)?;
    assert_eq!(builder.to_expression()?, "3 - 2d6");
    Ok(())
}

/// src/builder/index.test.ts:284
#[test]
fn should_handle_negative_modifier_with_zero_sides() -> T {
    let builder = rm(3.0, 0.0, -5.0)?;
    assert_eq!(builder.to_expression()?, "0 - 5");
    Ok(())
}

/// src/builder/index.test.ts:296
#[test]
fn should_allow_chaining_with_other_roll_builder_methods() -> T {
    let builder = r(2.0, 6.0)?.plus(3.0)?.with_advantage()?;
    assert_eq!(builder.to_expression()?, "2(d6 > d6) + 3");
    Ok(())
}

/// src/builder/index.test.ts:302
#[test]
fn should_allow_chaining_flat_amounts_with_other_methods() -> T {
    let builder = flat(10.0)?.plus(5.0)?.with_disadvantage()?;
    assert_eq!(builder.to_expression()?, "15");
    Ok(())
}

/// src/builder/index.test.ts:308
#[test]
fn should_allow_chaining_single_dice_with_other_methods() -> T {
    let builder = d20().plus(4.0)?.with_advantage()?;
    assert_eq!(builder.to_expression()?, "d20 > d20 + 4");
    Ok(())
}

/// src/builder/index.test.ts:38
#[test]
fn should_refuse_negative_sides() -> T {
    assert_throws(r(3.0, -1.0), "sides must not be negative, got -1");
    Ok(())
}

/// src/builder/index.test.ts:73
#[test]
fn should_handle_a_complex_roll_builder_applying_count_to_all_parts() -> T {
    let complex = d6().plus_roll(&d4())?;
    let b = die(2.0, &complex, None)?;
    assert_eq!(b.to_expression()?, "2d6 + 2d4");
    let pmf = pmf_of(&b);
    assert_eq!(pmf.min(), 4.0);
    assert_eq!(pmf.max(), 20.0);
    assert_close(pmf.mean(), 12.0, 2);
    Ok(())
}

/// src/builder/index.test.ts:82
#[test]
fn should_scale_modifiers_on_all_parts_of_a_complex_roll() -> T {
    let complex = d(8.0)?.plus(2.0)?.add(&d(6.0)?.plus(1.0)?)?;
    let b = die(3.0, &complex, None)?;
    assert_eq!(b.to_expression()?, "3d8 + 3d6 + 9");
    let pmf = pmf_of(&b);
    assert_eq!(pmf.min(), 15.0);
    assert_eq!(pmf.max(), 51.0);
    assert_close(pmf.mean(), 33.0, 2);
    Ok(())
}

/// src/builder/index.test.ts:93
#[test]
fn should_handle_an_empty_roll_builder_ignoring_count_and_applying_modifier() -> T {
    let b = die(2.0, &RollBuilder::new(0.0)?, Some(5.0))?;
    assert_eq!(b.to_expression()?, "5");
    let pmf = pmf_of(&b);
    assert_eq!(pmf.min(), 5.0);
    assert_eq!(pmf.max(), 5.0);
    Ok(())
}

/// src/builder/index.test.ts:102
#[test]
fn should_handle_a_roll_builder_with_only_a_modifier() -> T {
    let b = die(3.0, &flat(5.0)?, Some(2.0))?;
    assert_eq!(b.to_expression()?, "17");
    let pmf = pmf_of(&b);
    assert_eq!(pmf.min(), 17.0);
    assert_eq!(pmf.max(), 17.0);
    Ok(())
}

/// src/builder/index.test.ts:111
#[test]
fn should_correctly_apply_modifier_to_the_whole_new_roll() -> T {
    let complex = d6().plus_roll(&d4())?;
    let b = die(2.0, &complex, Some(5.0))?;
    assert_eq!(b.to_expression()?, "2d6 + 2d4 + 5");
    let pmf = pmf_of(&b);
    assert_eq!(pmf.min(), 9.0);
    assert_eq!(pmf.max(), 25.0);
    assert_close(pmf.mean(), 17.0, 2);
    Ok(())
}

/// src/builder/index.test.ts:131
#[test]
fn should_handle_different_die_types() -> T {
    for (s, e) in [
        (4.0, "1d4"),
        (8.0, "1d8"),
        (10.0, "1d10"),
        (12.0, "1d12"),
        (20.0, "d20"),
        (100.0, "1d100"),
    ] {
        assert_eq!(d(s)?.to_expression()?, e);
    }
    Ok(())
}

/// src/builder/index.test.ts:141
#[test]
fn should_handle_zero_sides_and_refuse_negative_sides() -> T {
    assert_eq!(d(0.0)?.to_expression()?, "0");
    assert_throws(d(-1.0), "sides must not be negative, got -1");
    Ok(())
}

/// src/builder/index.test.ts:230
#[test]
fn should_have_correct_roll_factory_type() -> T {
    // Compile-time: every factory function exists with the expected shape.
    let _: fn() -> RollBuilder = d4;
    let _: fn() -> RollBuilder = d6;
    let _: fn() -> RollBuilder = d8;
    let _: fn() -> RollBuilder = d10;
    let _: fn() -> RollBuilder = d12;
    let _: fn() -> RollBuilder = d20;
    let _: fn() -> RollBuilder = d100;
    let _: fn(f64) -> Result<RollBuilder, DiceError> = d;
    let _: fn(f64) -> Result<RollBuilder, DiceError> = flat;
    Ok(())
}

/// src/builder/index.test.ts:244
#[test]
fn should_return_roll_builder_instances_from_all_methods() -> T {
    let builders = [
        rm(2.0, 6.0, 3.0)?,
        d(8.0)?,
        d4(),
        d6(),
        d8(),
        d10(),
        d12(),
        d20(),
        d100(),
        flat(7.0)?,
    ];
    for b in &builders {
        assert!(matches!(b.kind(), RollKind::Plain));
    }
    Ok(())
}

/// src/builder/index.test.ts:316
#[test]
fn should_produce_correct_pmf_for_basic_dice() -> T {
    let pmf = pmf_of(&r(2.0, 6.0)?);
    assert_eq!(pmf.min(), 2.0);
    assert_eq!(pmf.max(), 12.0);
    assert_close(pmf.mean(), 7.0, 5);
    Ok(())
}

/// src/builder/index.test.ts:326
#[test]
fn should_produce_correct_pmf_for_dice_with_modifier() -> T {
    let pmf = pmf_of(&rm(3.0, 6.0, 4.0)?);
    assert_eq!(pmf.min(), 7.0);
    assert_eq!(pmf.max(), 22.0);
    assert_close(pmf.mean(), 14.5, 12);
    Ok(())
}

/// src/builder/index.test.ts:336
#[test]
fn should_produce_correct_pmf_for_flat_amounts() -> T {
    let pmf = pmf_of(&flat(15.0)?);
    assert_eq!(pmf.min(), 15.0);
    assert_eq!(pmf.max(), 15.0);
    assert_near(pmf.mean(), 15.0);
    Ok(())
}

/// src/builder/index.test.ts:346
#[test]
fn should_produce_correct_pmf_for_single_dice() -> T {
    let pmf = pmf_of(&d20());
    assert_eq!(pmf.min(), 1.0);
    assert_eq!(pmf.max(), 20.0);
    assert_near(pmf.mean(), 10.5);
    Ok(())
}

// ---- scale.test.ts ----

fn mean(pmf: &Pmf) -> f64 {
    faces(pmf).iter().map(|(v, p)| v * p).sum()
}

fn sd6() -> Result<RollBuilder, DiceError> {
    RollBuilder::zero().plus_dice(1.0, &d(6.0)?)
}

fn scale(b: &RollBuilder, n: f64, den: f64, rd: Rounding) -> Result<RollBuilder, DiceError> {
    b.scale_result(n, den, rd)
}

fn assert_faces(pmf: &Pmf, expected: &[(f64, f64)]) {
    let got = faces(pmf);
    assert_eq!(got.len(), expected.len(), "{got:?}");
    for ((v, p), (ev, ep)) in got.iter().zip(expected) {
        assert_eq!(v, ev);
        assert_near(*p, *ep);
    }
}

/// src/builder/scale.test.ts:18
#[test]
fn halves_floor_a_single_die_expression_and_distribution() -> T {
    let half = scale(&sd6()?, 1.0, 2.0, Rounding::Floor)?;
    assert!(matches!(half.kind(), RollKind::Scale { .. }));
    assert_eq!(half.to_expression()?, "(1d6) // 2");
    let pmf = half.pmf()?;
    assert_faces(
        &pmf,
        &[
            (0.0, 1.0 / 6.0),
            (1.0, 2.0 / 6.0),
            (2.0, 2.0 / 6.0),
            (3.0, 1.0 / 6.0),
        ],
    );
    assert_close(mean(&pmf), 1.5, 10);
    Ok(())
}

/// src/builder/scale.test.ts:32
#[test]
fn matches_the_existing_half_node_for_the_2_case() -> T {
    let s = scale(&sd6()?, 1.0, 2.0, Rounding::Floor)?;
    let h = sd6()?.half()?;
    assert_eq!(s.to_expression()?, h.to_expression()?);
    assert_close(mean(&s.pmf()?), mean(&h.pmf()?), 10);
    Ok(())
}

/// src/builder/scale.test.ts:37
#[test]
fn doubles_the_total_for_vulnerability_2_expr() -> T {
    let vuln = scale(&sd6()?, 2.0, 1.0, Rounding::Floor)?;
    assert_eq!(vuln.to_expression()?, "2 ** (1d6)");
    let pmf = vuln.pmf()?;
    let sixth = 1.0 / 6.0;
    assert_faces(
        &pmf,
        &[
            (2.0, sixth),
            (4.0, sixth),
            (6.0, sixth),
            (8.0, sixth),
            (10.0, sixth),
            (12.0, sixth),
        ],
    );
    assert_close(mean(&pmf), 7.0, 10);
    Ok(())
}

/// src/builder/scale.test.ts:52
#[test]
fn renders_a_general_numerator_denominator_form() -> T {
    assert_eq!(
        scale(&sd6()?, 3.0, 4.0, Rounding::Floor)?.to_expression()?,
        "(1d6) ** 3 // 4"
    );
    Ok(())
}

/// src/builder/scale.test.ts:56
#[test]
fn regression_to_expression_round_trips_through_parse() -> T {
    let vuln = scale(&sd6()?, 2.0, 1.0, Rounding::Floor)?;
    assert_close(
        mean(&parse_with(&vuln.to_expression()?, 0.0)?),
        mean(&vuln.pmf()?),
        10,
    );
    let general = scale(&sd6()?, 3.0, 4.0, Rounding::Floor)?;
    assert_close(
        mean(&parse_with(&general.to_expression()?, 0.0)?),
        mean(&general.pmf()?),
        10,
    );
    Ok(())
}

/// src/builder/scale.test.ts:67
#[test]
fn supports_round_and_ceil_rounding_modes() -> T {
    assert_close(
        mean(&scale(&sd6()?, 1.0, 2.0, Rounding::Ceil)?.pmf()?),
        2.0,
        10,
    );
    Ok(())
}

/// src/builder/scale.test.ts:72
#[test]
fn regression_to_expression_preserves_the_ceil_rounding_mode_on_round_trip() -> T {
    let c = scale(&sd6()?, 1.0, 2.0, Rounding::Ceil)?;
    assert_eq!(c.to_expression()?, "(1d6) / 2");
    assert_close(
        mean(&parse_with(&c.to_expression()?, 0.0)?),
        mean(&c.pmf()?),
        10,
    );
    Ok(())
}

/// src/builder/scale.test.ts:81
#[test]
fn regression_to_expression_throws_for_round_rounding() -> T {
    let rs = scale(&sd6()?, 1.0, 2.0, Rounding::Round)?;
    assert_throws(rs.to_expression(), "round");
    Ok(())
}

/// src/builder/scale.test.ts:88
#[test]
fn returns_a_single_part_unwrapped_and_empty_as_0() -> T {
    let base = RollBuilder::zero().plus(3.0)?.plus_dice(1.0, &d(8.0)?)?;
    assert_eq!(sum_rolls(std::slice::from_ref(&base))?, base);
    assert_eq!(sum_rolls(&[])?.to_expression()?, "0");
    Ok(())
}

/// src/builder/scale.test.ts:94
#[test]
fn preserves_a_scaled_part_beside_a_plain_part_as_plus_does() -> T {
    let base = RollBuilder::zero().plus(3.0)?.plus_dice(1.0, &d(8.0)?)?;
    let resisted = scale(&sd6()?, 1.0, 2.0, Rounding::Floor)?;
    let payload = sum_rolls(&[base.clone(), resisted.clone()])?;
    assert_eq!(payload.to_expression()?, "1d8 + 3 + ((1d6) // 2)");
    assert_close(mean(&payload.pmf()?), 9.0, 10);
    let plus = base.plus_roll(&resisted)?;
    assert_eq!(plus.to_expression()?, "1d8 + 3 + ((1d6) // 2)");
    assert_close(mean(&plus.pmf()?), 9.0, 10);
    Ok(())
}

/// src/builder/scale.test.ts:106
#[test]
fn only_scales_the_resisted_damage_type_in_a_mixed_attack_floor_is_per_type() -> T {
    let slashing = RollBuilder::zero().plus_dice(1.0, &d(8.0)?)?;
    let fire = scale(&sd6()?, 1.0, 2.0, Rounding::Floor)?;
    let per_type = sum_rolls(&[slashing, fire])?;
    assert_close(mean(&per_type.pmf()?), 6.0, 10);
    let whole = scale(
        &RollBuilder::zero()
            .plus_dice(1.0, &d(8.0)?)?
            .plus_dice(1.0, &d(6.0)?)?,
        1.0,
        2.0,
        Rounding::Floor,
    )?;
    assert!(!close(mean(&whole.pmf()?), 6.0, 1));
    Ok(())
}

// Deferred (need .ac/.onHit/.typed/AttackBuilder):
//   scale.test.ts:118; typed.test.ts:26 (it.each, 3 rows), :40, :44, :54, :60.
