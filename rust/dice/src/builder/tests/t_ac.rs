//! Translated TS tests: `src/builder/ac.test.ts`, `tests/check-natural-roll.test.ts`,
//! `tests/builder-argument-domain.test.ts` (ac / dc / onHit / attack parts),
//! `tests/AttackCache.test.ts` (value assertions) and `tests/attack-branch-consistency.test.ts`.

use super::support::*;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;

type Rb = RollBuilder;

/// `roll(count, sides)`.
fn rs(count: f64, sides: f64) -> Result<Rb, DiceError> {
    roll_with(count, Some(SidesOrDie::Sides(sides)), None)
}

/// `roll(count, die)`.
fn rdie(count: f64, die: Rb) -> Result<Rb, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

/// `roll(count)`.
fn rc(count: f64) -> Result<Rb, DiceError> {
    roll_with(count, None, None)
}

/// `toExpression()`.
fn ex(r: &Rb) -> Result<String, DiceError> {
    r.to_expression()
}

/// `expect(x.toPMF()).toBeDefined()`.
fn defined(r: &Rb) -> T {
    r.to_pmf(0.0).map(|_| ())
}

/// `onHit(roll)`.
fn hit(check: &Rb, damage: Rb) -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    check.on_hit_args(&[Arg::Roll(damage)])
}

mod attack_roll_builder {
    use super::*;

    /// src/builder/ac.test.ts:5
    #[test]
    fn should_handle_attack_roll_builder() -> T {
        let b = d20().plus(5.0)?.ac(10.0)?;
        assert_eq!(ex(&b)?, "(d20 + 5 AC 10)");
        defined(&b)?;
        assert_eq!(b.to_pmf(0.0)?.mean(), 14.0);
        Ok(())
    }

    /// src/builder/ac.test.ts:12
    #[test]
    fn should_handle_elven_accuracy_with_ac_check() -> T {
        let b = d20().plus(5.0)?.with_elven_accuracy()?.ac(15.0)?;
        assert_eq!(ex(&b)?, "(d20 > d20 > d20 + 5 AC 15)");
        defined(&b)
    }

    mod plus_dice_functionality {
        use super::*;

        /// src/builder/ac.test.ts:19
        #[test]
        fn should_add_single_dice_bonus_to_hit_bless_spell() -> T {
            let a = d20().plus_roll(&d4())?.plus(5.0)?.ac(15.0)?;
            assert_eq!(ex(&a)?, "(d20 + 5 + 1d4 AC 15)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:25
        #[test]
        fn should_add_multiple_dice_bonuses_to_hit() -> T {
            let a = d20()
                .plus_roll(&d4())?
                .plus_roll(&d6())?
                .plus(8.0)?
                .ac(18.0)?;
            assert_eq!(ex(&a)?, "(d20 + 8 + 1d6 + 1d4 AC 18)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:39
        #[test]
        fn should_add_constant_bonus_to_hit_and_consolidate() -> T {
            let a = d20().plus_roll(&flat(3.0)?)?.plus(4.0)?.ac(12.0)?;
            assert_eq!(ex(&a)?, "(d20 + 7 AC 12)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:45
        #[test]
        fn should_handle_complex_dice_expressions_as_bonus() -> T {
            let a = d20()
                .plus_dice(2.0, &d4())?
                .plus(1.0)?
                .plus(6.0)?
                .ac(16.0)?;
            assert_eq!(ex(&a)?, "(d20 + 7 + 2d4 AC 16)");
            assert_close(a.to_pmf(0.0)?.mean(), 1637.0 / 80.0, 12);
            Ok(())
        }

        /// src/builder/ac.test.ts:54
        #[test]
        fn should_work_with_advantage_and_bonus_dice() -> T {
            let a = d20()
                .with_advantage()?
                .plus(7.0)?
                .plus_roll(&d4())?
                .ac(14.0)?;
            assert_eq!(ex(&a)?, "(d20 > d20 + 7 + 1d4 AC 14)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:63
        #[test]
        fn should_work_with_elven_accuracy_and_bonus_dice() -> T {
            let a = d20()
                .with_elven_accuracy()?
                .plus_roll(&d4())?
                .plus(9.0)?
                .ac(17.0)?;
            assert_eq!(ex(&a)?, "(d20 > d20 > d20 + 9 + 1d4 AC 17)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:76
        #[test]
        fn should_work_with_disadvantage_and_bonus_dice() -> T {
            let a = d20()
                .with_disadvantage()?
                .plus_roll(&d4())?
                .plus(6.0)?
                .ac(13.0)?;
            assert_eq!(ex(&a)?, "(d20 < d20 + 6 + 1d4 AC 13)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:85
        #[test]
        fn should_handle_negative_bonus_dice() -> T {
            let a = d20().minus(2.0)?.plus(8.0)?.ac(15.0)?;
            assert_eq!(ex(&a)?, "(d20 + 6 AC 15)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:92
        #[test]
        fn should_work_with_crit_threshold_modifications() -> T {
            let a = d20().plus_roll(&d4())?.plus(7.0)?.ac(16.0)?.crit_on(19.0)?;
            assert_eq!(ex(&a)?, "(d20 + 7 + 1d4 AC 16)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:99
        #[test]
        fn should_maintain_bonus_dice_when_copying() -> T {
            let original = d20().plus_roll(&d4())?.plus(5.0)?.ac(15.0)?;
            let copy = original.copy()?;
            assert_eq!(ex(&copy)?, ex(&original)?);
            // The JSON minus its `identifier`.
            assert_eq!(copy.to_pmf(0.0)?.bins(), original.to_pmf(0.0)?.bins());
            Ok(())
        }

        /// src/builder/ac.test.ts:111
        #[test]
        fn should_allow_chaining_multiple_plus_calls() -> T {
            let a = d20()
                .plus_roll(&d4())?
                .plus_roll(&d6())?
                .plus(2.0)?
                .plus(6.0)?
                .ac(14.0)?;
            assert_eq!(ex(&a)?, "(d20 + 8 + 1d6 + 1d4 AC 14)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:118
        #[test]
        fn should_work_with_zero_bonus_dice() -> T {
            let a = d20().plus(0.0)?.plus(4.0)?.ac(12.0)?;
            assert_eq!(ex(&a)?, "(d20 + 4 AC 12)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:124
        #[test]
        fn should_handle_mixed_positive_and_negative_bonuses() -> T {
            let a = d20().plus_roll(&d4())?.minus(1.0)?.plus(7.0)?.ac(15.0)?;
            assert_eq!(ex(&a)?, "(d20 + 6 + 1d4 AC 15)");
            defined(&a)
        }
    }

    mod plus_dice_specific_functionality {
        use super::*;

        /// src/builder/ac.test.ts:132
        #[test]
        fn should_add_single_d4_bonus_bless_spell() -> T {
            let a = d20().plus_roll(&d4())?.plus(5.0)?.ac(15.0)?;
            assert_eq!(ex(&a)?, "(d20 + 5 + 1d4 AC 15)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:140
        #[test]
        fn should_add_single_d6_bonus_bardic_inspiration() -> T {
            let a = d20().plus_roll(&d6())?.plus(6.0)?.ac(16.0)?;
            assert_eq!(ex(&a)?, "(d20 + 6 + 1d6 AC 16)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:148
        #[test]
        fn should_chain_multiple_different_dice_bonuses() -> T {
            let a = d20()
                .plus_roll(&d4())?
                .plus_roll(&d6())?
                .plus_roll(&d8())?
                .plus(5.0)?
                .ac(15.0)?;
            assert_eq!(ex(&a)?, "(d20 + 5 + 1d8 + 1d6 + 1d4 AC 15)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:157
        #[test]
        fn should_chain_multiple_identical_dice_bonuses() -> T {
            let a = d20()
                .plus_roll(&d4())?
                .plus_roll(&d4())?
                .plus(6.0)?
                .ac(16.0)?;
            assert_eq!(ex(&a)?, "(d20 + 6 + 2d4 AC 16)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:163
        #[test]
        fn should_handle_dice_bonuses_with_modifiers() -> T {
            let a = d20()
                .plus_dice(2.0, &d4())?
                .plus(2.0)?
                .plus(7.0)?
                .ac(17.0)?;
            assert_eq!(ex(&a)?, "(d20 + 9 + 2d4 AC 17)");
            defined(&a)
        }

        /// src/builder/ac.test.ts:170
        #[test]
        fn should_handle_dice_bonuses_with_reroll() -> T {
            let a = d20()
                .plus_dice(1.0, &d6())?
                .reroll(1.0)?
                .plus(5.0)?
                .ac(14.0)?;
            assert_eq!(ex(&a)?, "(d20 + 5 + (d6 reroll 1) AC 14)");
            defined(&a)
        }
    }

    mod error_handling {
        use super::*;

        /// src/builder/ac.test.ts:180
        #[test]
        fn should_handle_invalid_ac_values() -> T {
            // Negative AC is accepted, not validated.
            d20().ac(-1.0)?;
            d20().ac(0.0)?;
            Ok(())
        }

        /// src/builder/ac.test.ts:191
        #[test]
        fn should_handle_invalid_crit_thresholds() -> T {
            let attack = d20().ac(15.0)?;
            assert_throws(
                attack
                    .crit_on(0.0)
                    .and_then(|c| hit(&c, d6()))
                    .and_then(|a| a.to_expression()),
                "Invalid crit threshold: 0. Must be between 1 and 20.",
            );
            let r = attack
                .crit_on(21.0)
                .and_then(|c| hit(&c, d6()))
                .and_then(|a| a.to_expression());
            err_of(r);
            Ok(())
        }

        /// src/builder/ac.test.ts:202
        #[test]
        fn should_handle_invalid_plus_values() -> T {
            let attack = d20().ac(15.0)?;
            err_of(flat(f64::NAN).and_then(|f| attack.plus_roll(&f)));
            Ok(())
        }
    }

    mod mathematical_correctness {
        use super::*;

        /// src/builder/ac.test.ts:211
        #[test]
        fn should_have_correct_hit_probability_for_plus_5_vs_ac_15() -> T {
            let pmf = d20().plus(5.0)?.ac(15.0)?.to_pmf(0.0)?;
            assert_eq!(pmf.min(), 0.0);
            assert_eq!(pmf.max(), 25.0);
            assert_eq!(pmf.mean(), 11.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:221
        #[test]
        fn should_have_correct_hit_probability_for_plus_3_vs_ac_18() -> T {
            let pmf = d20().plus(3.0)?.ac(18.0)?.to_pmf(0.0)?;
            assert_eq!(pmf.mean(), 6.15);
            assert_eq!(pmf.min(), 0.0);
            assert_eq!(pmf.max(), 23.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:231
        #[test]
        fn should_have_correct_hit_probability_for_plus_8_vs_ac_20_with_advantage() -> T {
            let pmf = d20().plus(8.0)?.with_advantage()?.ac(20.0)?.to_pmf(0.0)?;
            assert_close(pmf.mean(), 17.04, 1);
            assert_eq!(pmf.min(), 0.0);
            assert_eq!(pmf.max(), 28.0);
            Ok(())
        }
    }
}

mod attack_builder_methods {
    use super::*;

    fn two_d6() -> [Arg; 2] {
        [Arg::Num(2.0), Arg::Roll(d6())]
    }

    mod get_crit_threshold_method {
        use super::*;

        /// src/builder/ac.test.ts:244
        #[test]
        fn should_return_default_crit_threshold_of_20() -> T {
            let attack = d20().plus(5.0)?.ac(15.0)?.on_hit_args(&two_d6())?;
            assert_eq!(attack.check.crit_threshold(), Some(20.0));
            Ok(())
        }

        /// src/builder/ac.test.ts:250
        #[test]
        fn should_return_custom_crit_threshold_when_set() -> T {
            let attack = d20()
                .plus(5.0)?
                .ac(15.0)?
                .crit_on(18.0)?
                .on_hit_args(&two_d6())?;
            assert_eq!(attack.check.crit_threshold(), Some(18.0));
            Ok(())
        }

        /// src/builder/ac.test.ts:256
        #[test]
        fn should_return_crit_threshold_for_different_values() -> T {
            let attack = d20().plus(5.0)?.ac(15.0)?;
            for t in [15.0, 17.0, 19.0, 20.0] {
                let a = attack.crit_on(t)?.on_hit_args(&two_d6())?;
                assert_eq!(a.check.crit_threshold(), Some(t));
            }
            Ok(())
        }

        /// src/builder/ac.test.ts:269
        #[test]
        fn should_handle_edge_case_crit_thresholds() -> T {
            let attack = d20().plus(5.0)?.ac(15.0)?;
            let a = attack.crit_on(16.0)?.on_hit_args(&two_d6())?;
            assert_eq!(a.check.crit_threshold(), Some(16.0));
            Ok(())
        }

        /// src/builder/ac.test.ts:275
        #[test]
        fn should_return_20_for_non_ac_builder_check() -> T {
            let attack = d20().plus(5.0)?.ac(15.0)?.on_hit_args(&two_d6())?;
            assert_eq!(attack.check.crit_threshold(), Some(20.0));
            Ok(())
        }
    }

    mod check_get_modifier_bonus {
        use super::*;

        /// src/builder/ac.test.ts:284
        #[test]
        fn should_return_correct_to_hit_bonus_for_simple_attack() -> T {
            let a = d20().plus(5.0)?.ac(15.0)?.on_hit_args(&two_d6())?;
            assert_eq!(a.check.modifier(), 5.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:291
        #[test]
        fn should_return_correct_to_hit_bonus_for_complex_attack() -> T {
            let attack = d20().plus(3.0)?.plus_roll(&d6())?.plus(2.0)?.ac(18.0)?;
            let a = attack.on_hit_args(&[Arg::Num(3.0), Arg::Roll(d8())])?;
            assert_eq!(a.check.modifier(), 5.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:298
        #[test]
        fn should_return_correct_to_hit_bonus_with_multiple_modifiers() -> T {
            let attack = d20()
                .plus(4.0)?
                .plus_dice(2.0, &d4())?
                .plus(1.0)?
                .plus_roll(&d6())?
                .plus(3.0)?
                .ac(16.0)?;
            let a = hit(&attack, rc(2.0)?.d10()?)?;
            assert_eq!(a.check.modifier(), 8.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:305
        #[test]
        fn should_handle_plus_with_a_roll_builder() -> T {
            let attack = d20()
                .plus(4.0)?
                .add_roll(2.0)?
                .d4()?
                .plus(1.0)?
                .add_roll(1.0)?
                .d6()?
                .plus(3.0)?
                .ac(16.0)?;
            let a = hit(&attack, rc(2.0)?.d10()?)?;
            assert_eq!(a.check.modifier(), 8.0); // 4 + 1 + 3
            Ok(())
        }

        /// src/builder/ac.test.ts:320
        #[test]
        fn should_return_zero_to_hit_bonus_for_attack_with_no_modifiers_with_a_roll_builder() -> T {
            let a = d20().ac(15.0)?.on_hit_args(&two_d6())?;
            assert_eq!(a.check.modifier(), 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:326
        #[test]
        fn should_return_negative_to_hit_bonus() -> T {
            let attack = d20().plus(-2.0)?.ac(15.0)?;
            assert_eq!(attack.modifier(), -2.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:331
        #[test]
        fn should_handle_mixed_positive_and_negative_modifiers() -> T {
            let attack = d20().plus(5.0)?.plus_roll(&d4())?.minus(1.0)?.ac(15.0)?;
            assert_eq!(attack.modifier(), 4.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:336
        #[test]
        fn should_work_with_advantage_and_to_hit_bonus() -> T {
            let attack = d20().plus(6.0)?.with_advantage()?.ac(17.0)?;
            let a = hit(&attack, rc(2.0)?.d8()?)?;
            assert_eq!(a.check.modifier(), 6.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:343
        #[test]
        fn should_work_with_elven_accuracy_and_to_hit_bonus() -> T {
            let attack = d20().plus(7.0)?.with_elven_accuracy()?.ac(19.0)?;
            let a = attack.on_hit_args(&[Arg::Num(3.0), Arg::Roll(d6())])?;
            assert_eq!(a.check.modifier(), 7.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:350
        #[test]
        fn should_work_with_disadvantage_and_to_hit_bonus() -> T {
            let attack = d20().plus(4.0)?.with_disadvantage()?.ac(14.0)?;
            let a = attack.on_hit_args(&[Arg::Num(1.0), Arg::Roll(d12())])?;
            assert_eq!(a.check.modifier(), 4.0);
            Ok(())
        }
    }

    mod to_pmf_method {
        use super::*;

        /// src/builder/ac.test.ts:359
        #[test]
        fn should_generate_valid_pmf_for_basic_attack() -> T {
            let attack = hit(&d20().plus(5.0)?.ac(15.0)?, rdie(2.0, d6())?.plus(3.0)?)?;
            let pmf = attack.to_pmf(0.0)?;
            assert!(pmf.min() >= 0.0);
            assert!(pmf.mean() > 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:368
        #[test]
        fn should_generate_pmf_for_attack_with_crit() -> T {
            let dmg = roll_with(3.0, Some(SidesOrDie::Die(d8())), Some(4.0))?;
            let attack = hit(&d20().plus(6.0)?.ac(16.0)?, dmg)?;
            let pmf = attack.to_pmf(0.0)?;
            assert!(pmf.min() >= 0.0);
            assert!(pmf.mean() > 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:377
        #[test]
        fn should_generate_pmf_for_attack_with_custom_crit_threshold() -> T {
            let attack = hit(
                &d20().plus(7.0)?.ac(17.0)?.crit_on(18.0)?,
                rdie(2.0, d10())?.plus(5.0)?,
            )?;
            let pmf = attack.to_pmf(0.0)?;
            assert!(pmf.min() >= 0.0);
            assert!(pmf.mean() > 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:390
        #[test]
        fn should_generate_pmf_for_attack_with_miss_effect() -> T {
            let dmg = roll_with(1.0, Some(SidesOrDie::Die(d8())), Some(2.0))?;
            let attack = hit(&d20().plus(4.0)?.ac(18.0)?, dmg)?.on_miss(&[Arg::Num(1.0)])?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 + 4 AC 18) * (1d8 + 2) crit (2d8 + 2) miss (1)"
            );
            assert!(pmf.min() >= 0.0);
            assert_close(pmf.mean(), 3.15, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:402
        #[test]
        fn should_generate_pmf_for_attack_with_no_crit() -> T {
            let attack =
                hit(&d20().plus(5.0)?.ac(15.0)?, rdie(2.0, d6())?.plus(3.0)?)?.no_crit()?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 + 5 AC 15) * (2d6 + 3) xcrit0 (2d6 + 3)"
            );
            assert!(pmf.min() >= 0.0);
            assert!(pmf.mean() > 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:412
        #[test]
        fn should_generate_pmf_for_complex_attack_with_all_effects() -> T {
            let attack = hit(
                &d20().plus(8.0)?.ac(20.0)?.crit_on(19.0)?,
                rc(4.0)?.d6()?.plus(6.0)?,
            )?
            .on_crit(&[Arg::Roll(rc(8.0)?.d6()?.plus(7.0)?)])?
            .on_miss(&[Arg::Roll(flat(2.0)?)])?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 + 8 AC 20) * (4d6 + 6) xcrit2 (8d6 + 7) miss (2)"
            );
            assert!(pmf.min() >= 0.0);
            assert!(pmf.mean() > 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:430
        #[test]
        fn should_handle_attack_with_advantage_in_pmf() -> T {
            let attack = hit(
                &d20().plus(6.0)?.with_advantage()?.ac(16.0)?,
                rdie(2.0, d8())?.plus(4.0)?,
            )?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 > d20 + 6 AC 16) * (2d8 + 4) crit (4d8 + 4)"
            );
            assert_eq!(pmf.min(), 0.0);
            assert_close(pmf.mean(), 11.25, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:446
        #[test]
        fn should_handle_attack_with_disadvantage_in_pmf() -> T {
            let attack = hit(
                &d20().plus(3.0)?.with_disadvantage()?.ac(18.0)?,
                rdie(1.0, d12())?.plus(2.0)?,
            )?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 < d20 + 3 AC 18) * (1d12 + 2) crit (2d12 + 2)"
            );
            assert_eq!(pmf.min(), 0.0);
            assert_close(pmf.mean(), 0.78, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:462
        #[test]
        fn should_handle_attack_with_elven_accuracy_in_pmf() -> T {
            let attack = hit(
                &d20().plus(7.0)?.with_elven_accuracy()?.ac(19.0)?,
                rdie(3.0, d6())?.plus(5.0)?,
            )?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 > d20 > d20 + 7 AC 19) * (3d6 + 5) crit (6d6 + 5)"
            );
            assert_eq!(pmf.min(), 0.0);
            assert_close(pmf.mean(), 14.4185, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:478
        #[test]
        fn should_return_pmf_for_attack_without_hit_effect() -> T {
            let pmf = d20().plus(5.0)?.ac(15.0)?.to_pmf(0.0)?;
            assert_eq!(pmf.min(), 0.0);
            assert_eq!(pmf.max(), 25.0);
            assert_close(pmf.mean(), 11.0, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:489
        #[test]
        fn should_handle_attack_with_complex_damage_dice() -> T {
            let dmg = rdie(2.0, d6())?
                .plus(3.0)?
                .plus_dice(1.0, &d8())?
                .plus(2.0)?;
            let attack = hit(&d20().plus(5.0)?.ac(15.0)?, dmg)?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(
                attack.to_expression()?,
                "(d20 + 5 AC 15) * (1d8 + 2d6 + 5) crit (2d8 + 4d6 + 5)"
            );
            assert_eq!(pmf.min(), 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:503
        #[test]
        fn should_handle_attack_with_minimum_dice_in_damage() -> T {
            let dmg = rdie(3.0, d6())?.minimum(2.0)?.plus(4.0)?;
            let pmf = hit(&d20().plus(4.0)?.ac(14.0)?, dmg)?.to_pmf(0.0)?;
            assert_eq!(pmf.min(), 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:511
        #[test]
        fn should_handle_attack_with_reroll_dice_in_damage() -> T {
            let dmg = rdie(2.0, d8())?.reroll(1.0)?.plus(3.0)?;
            let pmf = hit(&d20().plus(6.0)?.ac(16.0)?, dmg)?.to_pmf(0.0)?;
            assert!(pmf.min() >= 0.0);
            assert!(pmf.mean() > 0.0);
            Ok(())
        }

        /// src/builder/ac.test.ts:520
        #[test]
        fn should_handle_attack_with_keep_dice_in_damage_given_an_explicit_crit() -> T {
            let keep = || -> Result<Rb, DiceError> { rdie(4.0, d6())?.keep_highest(4.0, 3.0) };
            let attack = hit(&d20().plus(5.0)?.ac(15.0)?, keep()?.plus(2.0)?)?
                .on_crit(&[Arg::Roll(keep()?.plus_roll(&keep()?)?.plus(2.0)?)])?;
            let pmf = attack.to_pmf(0.0)?;
            assert_eq!(pmf.min(), 0.0);
            // 0.5 x (15869/1296 + 2) + 0.05 x (2 x 15869/1296 + 2)
            assert_close(pmf.mean(), 8.446_759_259_259_26, 10);
            Ok(())
        }
    }
}

mod action_builder_with_ac {
    use super::*;

    fn atk() -> Result<Rb, DiceError> {
        d20().plus(5.0)?.ac(15.0)
    }

    fn dmg_2d6_3() -> Result<Rb, DiceError> {
        rc(2.0)?.d6()?.plus(3.0)
    }

    /// src/builder/ac.test.ts:538
    #[test]
    fn should_handle_action_builder_with_check() -> T {
        let attack_roll = atk()?;
        let damage = dmg_2d6_3()?;
        let miss_damage = flat(1.0)?;
        let crit_damage = rc(5.0)?.d6()?.plus(3.0)?;

        let action1 =
            hit(&attack_roll, damage.clone())?.on_miss(&[Arg::Roll(miss_damage.clone())])?;
        assert_eq!(
            action1.to_expression()?,
            "(d20 + 5 AC 15) * (2d6 + 3) crit (4d6 + 3) miss (1)"
        );
        assert_eq!(ex(&attack_roll)?, "(d20 + 5 AC 15)");
        assert_eq!(ex(&damage)?, "2d6 + 3");
        let action4 = hit(&attack_roll, damage.clone())?
            .on_miss(&[Arg::Roll(miss_damage)])?
            .on_crit(&[Arg::Roll(crit_damage.clone())])?;
        assert_eq!(
            action4.to_expression()?,
            "(d20 + 5 AC 15) * (2d6 + 3) crit (5d6 + 3) miss (1)"
        );
        let action5 = hit(&attack_roll, damage)?.on_crit(&[Arg::Roll(crit_damage)])?;
        assert_eq!(
            action5.to_expression()?,
            "(d20 + 5 AC 15) * (2d6 + 3) crit (5d6 + 3)"
        );
        Ok(())
    }

    /// src/builder/ac.test.ts:570
    #[test]
    fn can_chain() -> T {
        let action = hit(&atk()?, dmg_2d6_3()?)?.on_miss(&[Arg::Roll(flat(1.0)?)])?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 5 AC 15) * (2d6 + 3) crit (4d6 + 3) miss (1)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 6.3, 5);
        Ok(())
    }

    /// src/builder/ac.test.ts:583
    #[test]
    fn can_override_crit_threshold() -> T {
        let action = hit(&atk()?.crit_on(17.0)?, dmg_2d6_3()?)?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 5 AC 15) * (2d6 + 3) xcrit4 (4d6 + 3)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 6.9, 1);
        Ok(())
    }

    /// src/builder/ac.test.ts:592
    #[test]
    fn can_prevent_auto_crit() -> T {
        let action = hit(&atk()?, dmg_2d6_3()?)?.no_crit()?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 5 AC 15) * (2d6 + 3) xcrit0 (2d6 + 3)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 5.5, 2);
        Ok(())
    }

    /// src/builder/ac.test.ts:599
    #[test]
    fn handles_different_crit_thresholds_correctly() -> T {
        let attack = atk()?;
        for (t, want) in [
            (20.0, "(d20 + 5 AC 15) * (2d6 + 3) crit (4d6 + 3)"),
            (19.0, "(d20 + 5 AC 15) * (2d6 + 3) xcrit2 (4d6 + 3)"),
            (18.0, "(d20 + 5 AC 15) * (2d6 + 3) xcrit3 (4d6 + 3)"),
            (16.0, "(d20 + 5 AC 15) * (2d6 + 3) xcrit5 (4d6 + 3)"),
            (15.0, "(d20 + 5 AC 15) * (2d6 + 3) xcrit6 (4d6 + 3)"),
        ] {
            let action = hit(&attack.crit_on(t)?, dmg_2d6_3()?)?;
            assert_eq!(action.to_expression()?, want);
        }
        Ok(())
    }

    /// src/builder/ac.test.ts:627
    #[test]
    fn throws_error_for_invalid_crit_thresholds() -> T {
        let attack = atk()?;
        for (t, msg) in [
            (0.0, "Invalid crit threshold: 0. Must be between 1 and 20."),
            (
                21.0,
                "Invalid crit threshold: 21. Must be between 1 and 20.",
            ),
        ] {
            let r = attack
                .crit_on(t)
                .and_then(|c| hit(&c, dmg_2d6_3()?))
                .and_then(|a| a.to_expression());
            assert_throws(r, msg);
        }
        Ok(())
    }

    /// src/builder/ac.test.ts:640
    #[test]
    fn can_add_plus_repeatedly() -> T {
        let check = d20().plus(5.0)?.plus(1.0)?.plus(3.0)?.ac(15.0)?;
        let action = hit(&check, dmg_2d6_3()?)?.on_miss(&[Arg::Num(1.0)])?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 9 AC 15) * (2d6 + 3) crit (4d6 + 3) miss (1)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 8.1, 5);
        Ok(())
    }

    /// src/builder/ac.test.ts:655
    #[test]
    fn auto_doubles_crit_dice_if_not_specified() -> T {
        let dmg = rc(2.0)?
            .d6()?
            .plus(3.0)?
            .plus_roll(&d8())?
            .plus(5.0)?
            .plus_dice(4.0, &d4())?;
        let action = hit(&d20().plus(2.0)?.ac(12.0)?, dmg)?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 2 AC 12) * (1d8 + 2d6 + 4d4 + 8) crit (2d8 + 4d6 + 8d4 + 8)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 17.3, 5);
        Ok(())
    }

    /// src/builder/ac.test.ts:667
    #[test]
    fn can_chain_more_dice() -> T {
        let dmg = rc(2.0)?
            .d6()?
            .plus(3.0)?
            .add_roll(1.0)?
            .d8()?
            .plus(5.0)?
            .add_roll(4.0)?
            .d4()?;
        let action = hit(&atk()?, dmg)?.on_miss(&[Arg::Roll(flat(1.0)?)])?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 5 AC 15) * (1d8 + 2d6 + 4d4 + 8) crit (2d8 + 4d6 + 8d4 + 8) miss (1)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 17.75, 5);
        Ok(())
    }

    /// src/builder/ac.test.ts:680
    #[test]
    fn handles_minimum_dice() -> T {
        let dmg = rc(2.0)?.d6()?.plus(3.0)?.minimum(2.0)?;
        let action = hit(&d20().plus(2.0)?.ac(10.0)?, dmg)?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 2 AC 10) * (2(2>d6) + 3) crit (4(2>d6) + 3)"
        );
        action.to_pmf(0.0)?;
        Ok(())
    }

    /// src/builder/ac.test.ts:689
    #[test]
    fn handles_minimum_dice_with_rerolls() -> T {
        let dmg = rc(2.0)?.d6()?.plus(3.0)?.minimum(2.0)?.reroll(3.0)?;
        let action = hit(&d20().plus(2.0)?.ac(10.0)?, dmg)?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 2 AC 10) * (2(2>(d6 reroll d3)) + 3) crit (4(2>(d6 reroll d3)) + 3)"
        );
        action.to_pmf(0.0)?;
        Ok(())
    }

    /// src/builder/ac.test.ts:701
    #[test]
    fn can_handle_stupid_complex_stuff_and_doubling_dice_with_that() -> T {
        let dmg = rc(2.0)?
            .d6()?
            .plus(3.0)?
            .add_roll(1.0)?
            .d8()?
            .plus(5.0)?
            .minimum(2.0)?
            .add_roll(4.0)?
            .d4()?
            .reroll(2.0)?;
        let action = hit(&d20().plus(5.0)?.ac(15.0)?.crit_on(17.0)?, dmg)?
            .on_miss(&[Arg::Roll(flat(1.0)?)])?;
        assert_eq!(
            action.to_expression()?,
            "(d20 + 5 AC 15) * (2>d8 + 4(d4 reroll d2) + 2d6 + 8) xcrit4 (2(2>d8) + 8(d4 reroll d2) + 4d6 + 8) miss (1)"
        );
        assert_close(action.to_pmf(0.0)?.mean(), 22.56875, 5);
        Ok(())
    }

    mod error_handling {
        use super::*;

        /// src/builder/ac.test.ts:728
        #[test]
        fn should_handle_invalid_hit_effects() -> T {
            let attack = d20().ac(15.0)?;
            err_of(flat(f64::NAN).and_then(|f| attack.on_hit(f)));
            Ok(())
        }

        /// src/builder/ac.test.ts:735
        #[test]
        fn should_handle_invalid_crit_effects() -> T {
            let attack = d20().ac(15.0)?.on_hit(d6())?;
            err_of(flat(f64::NAN).and_then(|f| attack.on_crit(&[Arg::Roll(f)])));
            Ok(())
        }

        /// src/builder/ac.test.ts:742
        #[test]
        fn should_handle_invalid_miss_effects() -> T {
            let attack = d20().ac(15.0)?.on_hit(d6())?;
            err_of(flat(f64::NAN).and_then(|f| attack.on_miss(&[Arg::Roll(f)])));
            Ok(())
        }
    }

    mod mathematical_correctness {
        use super::*;

        /// src/builder/ac.test.ts:751
        #[test]
        fn should_have_correct_expected_damage_for_2d6_plus_3_vs_ac_15_with_plus_5_to_hit() -> T {
            let action = hit(&atk()?, rc(2.0)?.d6()?.plus(3.0)?)?;
            assert_close(action.to_pmf(0.0)?.mean(), 5.85, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:760
        #[test]
        fn should_have_correct_expected_damage_for_1d8_plus_2_vs_ac_12_with_plus_3_to_hit() -> T {
            let action = hit(&d20().plus(3.0)?.ac(12.0)?, rc(1.0)?.d8()?.plus(2.0)?)?;
            assert_close(action.to_pmf(0.0)?.mean(), 4.125, 2);
            Ok(())
        }

        /// src/builder/ac.test.ts:769
        #[test]
        fn should_have_correct_expected_damage_for_3d6_plus_4_vs_ac_18_with_plus_7_to_hit_and_advantage()
        -> T {
            let action = hit(
                &d20().plus(7.0)?.with_advantage()?.ac(18.0)?,
                rc(3.0)?.d6()?.plus(4.0)?,
            )?;
            assert_close(action.to_pmf(0.0)?.mean(), 11.9, 2);
            Ok(())
        }
    }
}

mod to_pmf {
    use super::*;

    /// src/builder/ac.test.ts:785
    #[test]
    fn should_handle_eps_end_to_end() -> T {
        let b = d20().plus(5.0)?.ac(10.0)?;
        assert_eq!(ex(&b)?, "(d20 + 5 AC 10)");
        let eps = 0.1;
        let pmf = b.to_pmf(eps)?;
        assert_eq!(pmf.epsilon, eps);
        Ok(())
    }
}

mod immutability {
    use super::*;

    /// src/builder/ac.test.ts:796 (the TS object literal mutated afterwards cannot alias the
    /// builder in Rust: only the values read back are asserted).
    #[test]
    fn should_not_be_mutable_via_constructor_attack_config_object() -> T {
        let builder = d20().plus(5.0)?.plus_roll(&d4())?;
        let ac_builder = builder.ac(15.0)?;
        assert_eq!(ac_builder.attack_config().and_then(|c| c.ac), Some(15.0));
        assert_eq!(ac_builder.get_bonus_dice_configs().len(), 1);
        Ok(())
    }
}

mod combined_dice_expression_generation {
    use super::*;

    /// src/builder/ac.test.ts:817
    #[test]
    fn should_merge_identical_dice_and_sort_by_sides() -> T {
        let a = d20()
            .plus_dice(2.0, &d6())?
            .plus_dice(2.0, &d8())?
            .plus_dice(2.0, &d6())?
            .plus(5.0)?
            .ac(15.0)?;
        assert_eq!(ex(&a)?, "(d20 + 5 + 2d8 + 4d6 AC 15)");
        Ok(())
    }

    /// src/builder/ac.test.ts:827
    #[test]
    fn should_not_merge_dice_with_different_reroll_configs() -> T {
        let a = d20()
            .plus_dice(2.0, &d6())?
            .plus_dice(2.0, &d6().reroll(1.0)?)?
            .plus(5.0)?
            .ac(15.0)?;
        assert_eq!(ex(&a)?, "(d20 + 5 + 2(d6 reroll 1) + 2d6 AC 15)");
        Ok(())
    }

    /// src/builder/ac.test.ts:834
    #[test]
    fn should_not_merge_dice_with_different_minimum_configs() -> T {
        let a = d20()
            .plus_dice(2.0, &d6())?
            .plus_dice(2.0, &d6().minimum(2.0)?)?
            .plus(5.0)?
            .ac(15.0)?;
        assert_eq!(ex(&a)?, "(d20 + 5 + 2(2>d6) + 2d6 AC 15)");
        Ok(())
    }

    /// src/builder/ac.test.ts:839
    #[test]
    fn should_handle_subtraction_correctly() -> T {
        let a = d20()
            .plus_dice(2.0, &d8())?
            .minus_dice(1.0, &d6())?
            .plus(5.0)?
            .ac(15.0)?;
        assert_eq!(ex(&a)?, "(d20 + 5 + 2d8 - 1d6 AC 15)");
        Ok(())
    }

    /// src/builder/ac.test.ts:844
    #[test]
    fn should_sort_dice_of_different_types() -> T {
        let a = d20()
            .plus_dice(1.0, &d6())?
            .plus_dice(1.0, &d4())?
            .plus_dice(1.0, &d8())?
            .plus(5.0)?
            .ac(15.0)?;
        assert_eq!(ex(&a)?, "(d20 + 5 + 1d8 + 1d6 + 1d4 AC 15)");
        Ok(())
    }

    /// src/builder/ac.test.ts:849
    #[test]
    fn should_merge_multiple_sets_of_the_same_dice() -> T {
        let a = d20()
            .plus_dice(1.0, &d8())?
            .plus_dice(1.0, &d6())?
            .plus_dice(1.0, &d8())?
            .plus_dice(1.0, &d6())?
            .plus(5.0)?
            .ac(15.0)?;
        assert_eq!(ex(&a)?, "(d20 + 5 + 2d8 + 2d6 AC 15)");
        Ok(())
    }
}

mod percentile_values_for_attack_rolls {
    use super::*;

    /// src/builder/ac.test.ts:862
    #[test]
    fn should_correctly_calculate_percentiles_for_d20_ac_18_1d8_6_crit_2d8_6() -> T {
        let dmg = || rs(1.0, 8.0)?.plus(6.0);
        let normal = hit(&d20().ac(18.0)?, dmg()?)?;
        assert_eq!(
            normal.to_expression()?,
            "(d20 AC 18) * (1d8 + 6) crit (2d8 + 6)"
        );
        let p = normal
            .to_query_with(0.0)?
            .percentiles(&[0.25, 0.5, 0.75, 0.9]);
        assert_eq!(p[0], 0.0);
        assert_eq!(p[1], 0.0);
        assert_eq!(p[2], 0.0);
        assert!(p[3] > 0.0);

        let adv = hit(&d20().with_advantage()?.ac(18.0)?, dmg()?)?;
        assert_eq!(
            adv.to_expression()?,
            "(d20 > d20 AC 18) * (1d8 + 6) crit (2d8 + 6)"
        );
        let p = adv.to_query_with(0.0)?.percentiles(&[0.25, 0.5, 0.75]);
        assert_eq!(p[0], 0.0);
        assert_eq!(p[1], 0.0);
        assert_eq!(p[2], 8.0);

        let dis = hit(&d20().with_disadvantage()?.ac(18.0)?, dmg()?)?;
        assert_eq!(
            dis.to_expression()?,
            "(d20 < d20 AC 18) * (1d8 + 6) crit (2d8 + 6)"
        );
        let p = dis.to_query_with(0.0)?.percentiles(&[0.25, 0.5, 0.75, 0.9]);
        for v in p {
            assert_eq!(v, 0.0);
        }
        Ok(())
    }
}

mod minimum_d20_roll_survives_ac {
    use super::*;
    use crate::query::Labels;

    fn label(s: &str) -> Labels {
        Labels::One(s.to_string())
    }

    /// src/builder/ac.test.ts:914
    #[test]
    fn floors_every_attack_roll_before_the_ac_check_not_just_the_display_expression() -> T {
        let attack = hit(
            &d20().plus(9.0)?.minimum(10.0)?.ac(18.0)?,
            rdie(2.0, d6())?.plus(5.0)?,
        )?
        .on_crit(&[Arg::Roll(rdie(4.0, d6())?.plus(5.0)?)])?;
        let query = attack.to_query_with(0.0)?;
        assert_close(query.probability_of(label("crit")), 0.05, 6);
        assert_close(query.probability_of(label("hit")), 0.95, 6);
        assert_close(
            query.probability_of(label("hit")) + query.probability_of(label("crit")),
            1.0,
            6,
        );
        assert_close(attack.to_pmf(0.0)?.mean(), 12.35, 4);
        Ok(())
    }
}

mod expanded_crit_range_still_requires_beating_ac {
    use super::*;
    use crate::query::Labels;

    /// src/builder/ac.test.ts:934
    #[test]
    fn a_natural_roll_in_the_crit_range_that_doesnt_beat_ac_is_a_miss_not_a_crit() -> T {
        let attack19 = hit(&d20().plus(5.0)?.ac(25.0)?.crit_on(19.0)?, flat(10.0)?)?;
        assert_close(attack19.to_pmf(0.0)?.mean(), 0.5, 4);
        let attack17 = hit(&d20().plus(5.0)?.ac(25.0)?.crit_on(17.0)?, flat(10.0)?)?;
        assert_close(attack17.to_pmf(0.0)?.mean(), 0.5, 4);
        Ok(())
    }

    /// src/builder/ac.test.ts:944
    #[test]
    fn a_natural_20_still_always_hits_and_crits_regardless_of_ac() -> T {
        let attack = hit(&d20().plus(0.0)?.ac(100.0)?, flat(1.0)?)?;
        let query = attack.to_query_with(0.0)?;
        assert_close(
            query.probability_of(Labels::One("crit".to_string())),
            0.05,
            6,
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// tests/check-natural-roll.test.ts
// ---------------------------------------------------------------------------------------------

mod check_natural_roll {
    use super::*;
    use crate::Pmf;
    use crate::parser::parse_with;
    use std::collections::BTreeMap;

    #[derive(Clone, Copy)]
    enum Kind {
        Flat,
        Advantage,
        Disadvantage,
    }

    type Dist = BTreeMap<i64, f64>;

    fn natural_d20(kind: Kind) -> Dist {
        let lifted = |c: f64| match kind {
            Kind::Advantage => c.powi(2),
            Kind::Disadvantage => 1.0 - (1.0 - c).powi(2),
            Kind::Flat => c,
        };
        let mut out = Dist::new();
        for r in 1..=20i64 {
            out.insert(r, lifted(r as f64 / 20.0) - lifted((r - 1) as f64 / 20.0));
        }
        out
    }

    fn dice_sum(count: i64, sides: i64) -> Dist {
        let mut dist: Dist = Dist::from([(0, 1.0)]);
        for _ in 0..count {
            let mut next = Dist::new();
            for (v, p) in &dist {
                for f in 1..=sides {
                    *next.entry(v + f).or_insert(0.0) += p / sides as f64;
                }
            }
            dist = next;
        }
        dist
    }

    fn add_into(out: &mut Dist, dist: &Dist, weight: f64) {
        for (v, p) in dist {
            *out.entry(*v).or_insert(0.0) += p * weight;
        }
    }

    /// d20 (+ bonus dice) + flat vs AC; `hit` on a hit and `crit` on a crit (natural 20 only).
    fn enumerate_attack(
        kind: Kind,
        bonus: &Dist,
        modifier: i64,
        ac: i64,
        hit: &Dist,
        crit: &Dist,
    ) -> Dist {
        let mut p_hit = 0.0;
        let mut p_crit = 0.0;
        for (r, pr) in natural_d20(kind) {
            if r == 1 {
                continue;
            }
            if r == 20 {
                p_crit += pr;
                continue;
            }
            for (b, pb) in bonus {
                if r + b + modifier >= ac {
                    p_hit += pr * pb;
                }
            }
        }
        let mut pmf = Dist::new();
        add_into(&mut pmf, hit, p_hit);
        add_into(&mut pmf, crit, p_crit);
        *pmf.entry(0).or_insert(0.0) += 1.0 - p_hit - p_crit;
        pmf
    }

    fn pmf_dist(p: &Pmf) -> Dist {
        p.support()
            .iter()
            .map(|d| (d.0 as i64, p.p_at(d.0)))
            .collect()
    }

    #[track_caller]
    fn expect_bins(actual: &Pmf, reference: &Dist) {
        let mut keys: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
        keys.extend(reference.keys());
        for k in keys {
            let want = reference.get(&k).copied().unwrap_or(0.0);
            let got = actual.p_at(k as f64);
            assert!(close(got, want, 12), "bin {k}: {got} vs {want}");
        }
    }

    mod a_check_with_no_die_compares_its_flat_total_against_the_target {
        use super::*;

        /// tests/check-natural-roll.test.ts:72
        #[test]
        fn hits_for_certain_when_the_flat_total_reaches_the_ac_with_no_crit_and_no_natural_1_miss()
        -> T {
            let res = hit(&flat(15.0)?.ac(12.0)?, rdie(1.0, d6())?)?.resolve(0.0)?;
            assert_eq!(res.weights.hit, 1.0);
            assert_eq!(res.weights.crit, 0.0);
            assert_eq!(res.weights.miss, 0.0);
            expect_bins(&res.pmf, &dice_sum(1, 6));
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:80
        #[test]
        fn misses_for_certain_when_the_flat_total_falls_short_matching_the_string_grammar() -> T {
            let attack = hit(&flat(10.0)?.ac(12.0)?, rdie(1.0, d6())?)?;
            assert_eq!(attack.to_pmf(0.0)?.p_at(0.0), 1.0);
            assert_eq!(
                attack.to_pmf(0.0)?.mean(),
                parse_with("(10 AC 12) * (1d6)", 0.0)?.mean()
            );
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:86
        #[test]
        fn adds_bonus_dice_to_the_flat_total_with_no_natural_roll_among_them() -> T {
            // 10 + d4 >= 12 on a 2, 3 or 4.
            let res =
                hit(&flat(10.0)?.plus_roll(&d4())?.ac(12.0)?, rdie(1.0, d6())?)?.resolve(0.0)?;
            assert_close(res.weights.hit, 3.0 / 4.0, 15);
            assert_eq!(res.weights.crit, 0.0);
            assert_close(res.pmf.mean(), (3.0 / 4.0) * (7.0 / 2.0), 14);
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:94
        #[test]
        fn resolves_the_raw_check_pmf_as_the_flat_total_when_it_reaches_the_ac() -> T {
            expect_bins(
                &flat(15.0)?.ac(12.0)?.to_pmf(0.0)?,
                &Dist::from([(15, 1.0)]),
            );
            expect_bins(&flat(10.0)?.ac(12.0)?.to_pmf(0.0)?, &Dist::from([(0, 1.0)]));
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:99
        #[test]
        fn succeeds_or_fails_a_save_for_certain_on_the_flat_total_alone() -> T {
            let fails = flat(10.0)?
                .dc(12.0)?
                .on_save_failure_args(&[Arg::Roll(rdie(2.0, d6())?)])?
                .resolve(0.0)?;
            assert_eq!(fails.weights.fail, 1.0);
            assert_close(fails.pmf.mean(), 7.0, 14);
            assert_eq!(flat(15.0)?.dc(12.0)?.to_pmf(0.0)?.p_at(1.0), 0.0);
            let same = flat(12.0)?
                .dc(12.0)?
                .on_save_failure_args(&[Arg::Roll(rdie(2.0, d6())?)])?
                .to_pmf(0.0)?;
            assert_eq!(same.p_at(0.0), 1.0);
            Ok(())
        }
    }

    mod the_d20_is_the_natural_roll_wherever_it_appears_in_the_check {
        use super::*;

        /// tests/check-natural-roll.test.ts:112
        #[test]
        fn treats_a_leading_bonus_die_as_a_bonus_die() -> T {
            let damage = dice_sum(2, 6);
            let crit_damage = dice_sum(4, 6);
            let expected =
                enumerate_attack(Kind::Flat, &dice_sum(1, 4), 5, 15, &damage, &crit_damage);
            let res = hit(
                &d4().plus_roll(&d20())?.plus(5.0)?.ac(15.0)?,
                rdie(2.0, d6())?,
            )?
            .resolve(0.0)?;
            assert_close(res.weights.crit, 1.0 / 20.0, 15);
            assert_close(res.weights.hit, 5.0 / 8.0, 15);
            assert_close(res.pmf.mean(), 203.0 / 40.0, 13);
            expect_bins(&res.pmf, &expected);
            let other = hit(
                &d20().plus_roll(&d4())?.plus(5.0)?.ac(15.0)?,
                rdie(2.0, d6())?,
            )?
            .resolve(0.0)?;
            expect_bins(&res.pmf, &pmf_dist(&other.pmf));
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:122
        #[test]
        fn prefers_the_d20_over_a_larger_bonus_die() -> T {
            let check = rs(1.0, 100.0)?.plus_roll(&d20())?.ac(200.0)?;
            let res = hit(&check, rdie(2.0, d6())?)?.resolve(0.0)?;
            // Only a natural 20 reaches AC 200.
            assert_close(res.weights.crit, 1.0 / 20.0, 15);
            assert_eq!(res.weights.hit, 0.0);
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:129
        #[test]
        fn uses_the_largest_die_as_the_natural_roll_when_there_is_no_d20() -> T {
            // d8 natural: its 1 misses; the d4 is a bonus die.
            let check = d4().plus_roll(&rs(1.0, 8.0)?)?.ac(2.0)?;
            let res = hit(&check, rdie(1.0, d6())?)?.resolve(0.0)?;
            assert_close(res.weights.miss, 1.0 / 8.0, 15);
            assert_eq!(res.weights.crit, 0.0);
            Ok(())
        }
    }

    mod advantage_and_disadvantage_apply_to_the_natural_d20_whatever_the_call_order {
        use super::*;

        /// tests/check-natural-roll.test.ts:138
        #[test]
        fn advantage_after_a_bonus_die_advantages_the_d20() -> T {
            let check = d20().plus_roll(&d4())?.with_advantage()?.plus(5.0)?;
            assert_eq!(check.roll_type().as_str(), "advantage");
            let expected = enumerate_attack(
                Kind::Advantage,
                &dice_sum(1, 4),
                5,
                15,
                &dice_sum(2, 6),
                &dice_sum(4, 6),
            );
            let res = hit(&check.ac(15.0)?, rdie(2.0, d6())?)?.resolve(0.0)?;
            assert_close(res.weights.hit, 127.0 / 160.0, 15);
            assert_close(res.weights.crit, 39.0 / 400.0, 15);
            assert_close(res.pmf.mean(), 5537.0 / 800.0, 13);
            expect_bins(&res.pmf, &expected);
            let other = hit(
                &d20()
                    .with_advantage()?
                    .plus_roll(&d4())?
                    .plus(5.0)?
                    .ac(15.0)?,
                rdie(2.0, d6())?,
            )?
            .resolve(0.0)?;
            expect_bins(&res.pmf, &pmf_dist(&other.pmf));
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:150
        #[test]
        fn disadvantage_after_a_bonus_die_disadvantages_a_saves_d20() -> T {
            // P(d20 low of two + d4 + 3 >= 15), enumerated.
            let mut p_success = 0.0;
            for (r, pr) in natural_d20(Kind::Disadvantage) {
                for b in 1..=4 {
                    if r + b + 3 >= 15 {
                        p_success += pr / 4.0;
                    }
                }
            }
            assert_close(p_success, 267.0 / 800.0, 15);
            let save = d20()
                .plus_roll(&d4())?
                .with_disadvantage()?
                .plus(3.0)?
                .dc(15.0)?;
            assert_close(save.to_pmf(0.0)?.p_at(0.0), 267.0 / 800.0, 15);
            let res = save
                .on_save_failure_args(&[Arg::Roll(rdie(2.0, d6())?)])?
                .resolve(0.0)?;
            assert_close(res.weights.success, 267.0 / 800.0, 15);
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:162
        #[test]
        fn elven_accuracy_after_a_bonus_die_applies_to_the_d20() -> T {
            let check = d20()
                .plus_roll(&d4())?
                .with_elven_accuracy()?
                .plus(5.0)?
                .ac(30.0)?;
            let res = hit(&check, rdie(1.0, d6())?)?.resolve(0.0)?;
            // Only a natural 20 reaches AC 30: best of three d20s shows a 20 with probability 1141/8000.
            assert_close(res.weights.crit, 1141.0 / 8000.0, 15);
            Ok(())
        }
    }

    mod a_check_whose_natural_roll_is_not_one_die_is_refused {
        use super::*;

        fn refused(build: impl Fn() -> Result<Rb, DiceError>) -> T {
            let want = "natural roll is not one die";
            assert_throws(
                build()
                    .and_then(|b| b.ac(15.0))
                    .and_then(|b| hit(&b, rdie(1.0, d6())?))
                    .and_then(|a| a.resolve(0.0)),
                want,
            );
            assert_throws(
                build().and_then(|b| b.ac(15.0)).and_then(|b| b.to_pmf(0.0)),
                want,
            );
            assert_throws(
                build().and_then(|b| b.dc(15.0)).and_then(|b| b.to_pmf(0.0)),
                want,
            );
            assert_throws(
                build()
                    .and_then(|b| b.dc(15.0))
                    .and_then(|b| b.on_save_failure_args(&[Arg::Roll(rdie(1.0, d6())?)]))
                    .and_then(|s| s.resolve(0.0)),
                want,
            );
            Ok(())
        }

        /// tests/check-natural-roll.test.ts:176 (`roll(2, d20)`)
        #[test]
        fn roll_2_d20_as_an_attack_or_a_save_throws() -> T {
            refused(|| rdie(2.0, d20())?.plus(5.0))
        }

        /// tests/check-natural-roll.test.ts:176 (`d20 + d20`)
        #[test]
        fn d20_plus_d20_as_an_attack_or_a_save_throws() -> T {
            refused(|| d20().plus_roll(&d20())?.plus(5.0))
        }

        /// tests/check-natural-roll.test.ts:176 (`hd20 + d20`)
        #[test]
        fn hd20_plus_d20_as_an_attack_or_a_save_throws() -> T {
            refused(|| hd20().plus_roll(&d20()))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// tests/builder-argument-domain.test.ts
// ---------------------------------------------------------------------------------------------

mod builder_argument_domain {
    use super::*;
    use crate::builder::attack::AttackBuilder;
    use crate::builder::nodes::Rounding;

    const NON_FINITE: [f64; 3] = [f64::INFINITY, f64::NEG_INFINITY, f64::NAN];
    const INFINITE: [f64; 2] = [f64::INFINITY, f64::NEG_INFINITY];

    fn attack() -> Result<AttackBuilder, DiceError> {
        hit(&d20().plus(5.0)?.ac(15.0)?, rdie(2.0, d6())?)
    }

    fn scale(r: &Rb, n: f64, d: f64) -> Result<Rb, DiceError> {
        r.scale_result(n, d, Rounding::Floor)
    }

    /// tests/builder-argument-domain.test.ts:8
    #[test]
    fn scale_result_numerator_non_finite() -> T {
        for v in NON_FINITE {
            assert_throws(scale(&rdie(2.0, d6())?, v, 2.0), "scaleResult() numerator");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:12
    #[test]
    fn scale_result_denominator_non_finite() -> T {
        for v in NON_FINITE {
            assert_throws(
                scale(&rdie(2.0, d6())?, 1.0, v),
                "scaleResult() denominator",
            );
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:16
    #[test]
    fn scale_result_a_zero_denominator() -> T {
        assert_throws(
            scale(&rdie(2.0, d6())?, 1.0, 0.0),
            "scaleResult() denominator must not be 0",
        );
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:20
    #[test]
    fn scale_result_still_scales_by_finite_fractions_negative_numerators_included() -> T {
        // floor(3x / 2) over 2d6 sums to 369 across its 36 rolls.
        assert_close(
            scale(&rdie(2.0, d6())?, 3.0, 2.0)?.to_pmf(0.0)?.mean(),
            369.0 / 36.0,
            12,
        );
        assert_close(
            scale(&rdie(1.0, d6())?, -1.0, 1.0)?.to_pmf(0.0)?.mean(),
            -7.0 / 2.0,
            12,
        );
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:28
    #[test]
    fn attack_payload_transforms_refuse_infinite_minimum_damage_die() -> T {
        for v in INFINITE {
            assert_throws(
                attack()?.minimum_damage_die(v),
                "minimumDamageDie() must be finite",
            );
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:32
    #[test]
    fn attack_payload_transforms_refuse_infinite_reroll_damage() -> T {
        for v in INFINITE {
            assert_throws(
                attack()?.reroll_damage(v),
                "rerollDamage() threshold must be finite",
            );
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:38
    #[test]
    fn checks_refuse_an_infinite_ac() -> T {
        for v in INFINITE {
            assert_throws(d20().plus(5.0)?.ac(v), "ac() must be finite");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:42
    #[test]
    fn checks_refuse_an_infinite_dc() -> T {
        for v in INFINITE {
            assert_throws(d20().plus(5.0)?.dc(v), "dc() must be finite");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:46
    #[test]
    fn crit_on_non_finite_on_an_ac_check() -> T {
        for v in NON_FINITE {
            assert_throws(d20().plus(5.0)?.ac(15.0)?.crit_on(v), "critOn()");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:50
    #[test]
    fn crit_on_non_finite_on_an_always_hitting_check() -> T {
        for v in NON_FINITE {
            assert_throws(d20().plus(5.0)?.always_hits()?.crit_on(v), "critOn()");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:54
    #[test]
    fn crit_on_non_finite_on_an_always_critting_check() -> T {
        for v in NON_FINITE {
            assert_throws(
                d20().plus(5.0)?.ac(15.0)?.always_crits()?.crit_on(v),
                "critOn()",
            );
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:58
    #[test]
    fn with_check_returning_ac_infinite() -> T {
        for v in INFINITE {
            assert_throws(
                attack()?.with_check(|c| crate::builder::types::Check { ac: v, ..c }),
                "AC in withCheck() must be finite",
            );
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:62
    #[test]
    fn with_check_returning_crit_threshold_non_finite() -> T {
        for v in NON_FINITE {
            assert_throws(
                attack()?.with_check(|c| crate::builder::types::Check {
                    crit_threshold: v,
                    ..c
                }),
                "crit threshold in withCheck()",
            );
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:68
    #[test]
    fn a_finite_rebind_still_resolves_exactly() -> T {
        let rebound = attack()?.with_check(|c| crate::builder::types::Check {
            ac: 16.0,
            crit_threshold: 19.0,
            ..c
        })?;
        // Hits on 11..18 (8/20) for 2d6, crits on 19..20 (2/20) for 4d6.
        assert_close(
            rebound.to_pmf(0.0)?.mean(),
            (8.0 / 20.0) * 7.0 + (2.0 / 20.0) * 14.0,
            12,
        );
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:76
    #[test]
    fn roll_2_sides_negative() -> T {
        for sides in [f64::NEG_INFINITY, -6.0, -1.0] {
            assert_throws(rs(2.0, sides), "sides");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:80
    #[test]
    fn d_sides_negative() -> T {
        for sides in [f64::NEG_INFINITY, -6.0] {
            assert_throws(d(sides), "sides");
        }
        Ok(())
    }

    /// tests/builder-argument-domain.test.ts:84
    #[test]
    fn zero_sides_keeps_its_meaning_no_die_a_sum_of_0() -> T {
        assert_eq!(rs(2.0, 0.0)?.to_pmf(0.0)?.mean(), 0.0);
        assert_eq!(rs(2.0, 0.0)?.plus(3.0)?.to_pmf(0.0)?.mean(), 3.0);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// tests/AttackCache.test.ts: the TS caches are skipped by the port, so the value assertions only.
// Deferred (TS cache identity, `toBe` / `not.toBe` between PMF instances): :16 (SAME cached
// instance), and the instance-identity part of :28, :37, :47, :56, :62.
// ---------------------------------------------------------------------------------------------

mod attack_cache {
    use super::*;
    use crate::builder::attack::AttackBuilder;

    fn attack() -> Result<AttackBuilder, DiceError> {
        hit(&d20().plus(8.0)?.ac(16.0)?, rs(1.0, 8.0)?.plus(4.0)?)
    }

    /// tests/AttackCache.test.ts:16 (equal values only; identity is TS cache)
    #[test]
    fn returns_the_same_cached_pmf_for_a_freshly_rebuilt_identical_attack() -> T {
        let a = attack()?.to_pmf(0.0)?;
        let b = attack()?.to_pmf(0.0)?;
        assert_eq!(a.bins(), b.bins());
        Ok(())
    }

    /// tests/AttackCache.test.ts:22
    #[test]
    fn is_byte_identical_mean_to_the_uncached_resolve() -> T {
        let cached = attack()?.to_pmf(0.0)?.mean();
        let uncached = attack()?.resolve(0.0)?.pmf.mean();
        assert_close(cached, uncached, 12);
        Ok(())
    }

    /// tests/AttackCache.test.ts:28 (different values; identity is TS cache)
    #[test]
    fn forks_the_key_on_ac_to_hit_crit_range_and_damage_differences() -> T {
        let base = attack()?.to_pmf(0.0)?;
        let others = [
            hit(&d20().plus(8.0)?.ac(20.0)?, rs(1.0, 8.0)?.plus(4.0)?)?, // AC
            hit(&d20().plus(9.0)?.ac(16.0)?, rs(1.0, 8.0)?.plus(4.0)?)?, // to-hit
            hit(
                &d20().plus(8.0)?.ac(16.0)?.crit_on(19.0)?,
                rs(1.0, 8.0)?.plus(4.0)?,
            )?, // crit range
            hit(&d20().plus(8.0)?.ac(16.0)?, rs(1.0, 8.0)?.plus(5.0)?)?, // damage mod
            hit(&d20().plus(8.0)?.ac(16.0)?, rs(2.0, 8.0)?.plus(4.0)?)?, // dice count
        ];
        for o in others {
            assert_ne!(o.to_pmf(0.0)?.bins(), base.bins());
        }
        Ok(())
    }

    /// tests/AttackCache.test.ts:37 (values; identity is TS cache)
    #[test]
    fn distinguishes_advantage_disadvantage_normal() -> T {
        let dmg = || rs(1.0, 8.0);
        let normal = hit(&d20().plus(8.0)?.ac(16.0)?, dmg()?)?.to_pmf(0.0)?;
        let adv = hit(&d20().with_advantage()?.plus(8.0)?.ac(16.0)?, dmg()?)?.to_pmf(0.0)?;
        let dis = hit(&d20().with_disadvantage()?.plus(8.0)?.ac(16.0)?, dmg()?)?.to_pmf(0.0)?;
        assert_ne!(adv.bins(), normal.bins());
        assert_ne!(dis.bins(), normal.bins());
        assert!(adv.mean() > normal.mean());
        assert!(dis.mean() < normal.mean());
        Ok(())
    }

    /// tests/AttackCache.test.ts:47 (values; identity is TS cache)
    #[test]
    fn distinguishes_no_crit_auto_double_crit_explicit_crit() -> T {
        let check = || d20().plus(8.0)?.ac(16.0);
        let dmg = || rs(1.0, 8.0)?.plus(4.0);
        let auto = hit(&check()?, dmg()?)?.to_pmf(0.0)?;
        let none = hit(&check()?, dmg()?)?.no_crit()?.to_pmf(0.0)?;
        let explicit = hit(&check()?, dmg()?)?
            .on_crit(&[Arg::Roll(rs(3.0, 8.0)?.plus(4.0)?)])?
            .to_pmf(0.0)?;
        assert_ne!(none.bins(), auto.bins());
        assert_ne!(explicit.bins(), auto.bins());
        assert!(auto.mean() > none.mean());
        Ok(())
    }

    /// tests/AttackCache.test.ts:56 (values; identity is TS cache)
    #[test]
    fn forks_the_key_on_the_miss_effect_and_on_eps() -> T {
        let base = attack()?.to_pmf(0.0)?;
        let missed = attack()?.on_miss(&[Arg::Num(2.0)])?.to_pmf(0.0)?;
        assert_ne!(missed.bins(), base.bins());
        let a = attack()?.to_pmf(0.01)?;
        let b = attack()?.to_pmf(0.01 * 2.0)?;
        assert_close(a.mean(), b.mean(), 2);
        Ok(())
    }

    /// tests/AttackCache.test.ts:62 (values; identity is TS cache)
    #[test]
    fn does_not_cache_when_an_effect_opts_out_null_cache_key_half_parsed_transforms() -> T {
        let check = || d20().plus(8.0)?.ac(16.0);
        let half_a = hit(&check()?, rs(2.0, 8.0)?.half()?)?.to_pmf(0.0)?;
        let half_b = hit(&check()?, rs(2.0, 8.0)?.half()?)?.to_pmf(0.0)?;
        assert_close(half_b.mean(), half_a.mean(), 12);

        let parsed = || check()?.on_hit_args(&[Arg::Str("1d8+4".to_string())]);
        let parsed_a = parsed()?.to_pmf(0.0)?;
        let parsed_b = parsed()?.to_pmf(0.0)?;
        assert_close(parsed_b.mean(), parsed_a.mean(), 12);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// tests/attack-branch-consistency.test.ts
// ---------------------------------------------------------------------------------------------

mod attack_branch_consistency {
    use super::*;
    use crate::builder::ac::Combined;
    use crate::builder::ac::combine;
    use crate::builder::types::AdvantageDice;
    use crate::common::RollType;

    /// tests/attack-branch-consistency.test.ts:5
    #[test]
    fn convolves_the_doubled_separate_channels_into_an_unreachable_crit_branch() -> T {
        // A dieless check cannot crit, yet `crit` still describes the crit payload:
        // 4d6 + 5 base with the 2d6 channel doubled to 4d6, mean 14 + 5 + 14 = 33.
        let res = hit(&flat(15.0)?.ac(12.0)?, rdie(2.0, d6())?.plus(5.0)?)?
            .plus_separate_damage(rdie(2.0, d6())?)
            .resolve(0.0)?;
        assert_eq!(res.weights.crit, 0.0);
        assert_close(res.crit_base.mean(), 19.0, 12);
        assert_close(res.crit_separate.mean(), 14.0, 12);
        assert_close(res.crit.mean(), 33.0, 12);
        assert_close(res.pmf.mean(), 19.0, 12);
        Ok(())
    }

    /// tests/attack-branch-consistency.test.ts:16
    #[test]
    fn is_the_same_when_a_die_natural_roll_never_reaches_the_crit_range() -> T {
        // A d4 natural roll never shows a 20.
        let res = hit(&d4().plus(20.0)?.ac(15.0)?, rdie(2.0, d6())?.plus(5.0)?)?
            .plus_separate_damage(rdie(2.0, d6())?)
            .resolve(0.0)?;
        assert_eq!(res.weights.crit, 0.0);
        assert_close(res.crit.mean(), 33.0, 12);
        Ok(())
    }

    /// tests/attack-branch-consistency.test.ts:25
    #[test]
    fn combine_elven_accuracy_roll_type_keeps_three_dice_on_its_own_or_with_a_granted_advantage()
    -> T {
        for dice in [AdvantageDice::Two, AdvantageDice::Three] {
            assert_eq!(
                combine(RollType::ElvenAccuracy, dice, false, false),
                Combined {
                    roll_type: RollType::Advantage,
                    dice: 3
                }
            );
            assert_eq!(
                combine(RollType::ElvenAccuracy, dice, true, false),
                Combined {
                    roll_type: RollType::Advantage,
                    dice: 3
                }
            );
            assert_eq!(
                combine(RollType::ElvenAccuracy, dice, false, true),
                Combined {
                    roll_type: RollType::Flat,
                    dice: 1
                }
            );
        }
        Ok(())
    }
}
