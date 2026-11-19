//! Attack-bearing cases (`.ac`, `.dc`, `onHit`, `save`) of the crit / reroll-up-to / math / misc TS
//! test files. Cases that need the turn engine are deferred (see the task report).

use super::support::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;

fn rd(count: f64, die: &RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die.clone())), None)
}

/// `d("...")`.
fn dd(e: &str) -> Result<RollBuilder, DiceError> {
    d_expression(e)
}

/// Every bin of `a` and `b` agrees within 1e-12.
#[track_caller]
fn same_pmf(a: &Pmf, b: &Pmf) {
    let mut support: Vec<f64> = a.support().iter().map(|d| d.0).collect();
    support.extend(b.support().iter().map(|d| d.0));
    for v in support {
        assert!((a.p_at(v) - b.p_at(v)).abs() <= 1e-12, "bin {v}");
    }
}

mod crit_keep {
    use super::*;

    const MAX_OF_TWO_2D6_PLUS_3: f64 = 7369.0 / 648.0;
    const MAX_OF_TWO_4D6_PLUS_3: f64 = 7950193.0 / 419904.0;
    const MAX_OF_TWO_2D12_PLUS_5: f64 = 107755.0 / 5184.0;
    const FOUR_D6_DROP_LOWEST: f64 = 15869.0 / 1296.0;

    fn drop_lowest() -> Result<RollBuilder, DiceError> {
        rd(4.0, &d6())?.keep_highest(4.0, 3.0)
    }

    /// tests/crit-keep.test.ts:43 (the `.ac(12).onHit(..).resolve()` tail; the builder part is in `pooled_crit.rs`)
    #[test]
    fn roll_2_d6_keep_highest_2_1_plus_3_attack_resolves_to_the_o4_crit() -> T {
        let res = d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit(rd(2.0, &d6())?.keep_highest(2.0, 1.0)?.plus(3.0)?)?
            .resolve(0.0)?;
        assert_close(res.hit.mean(), MAX_OF_TWO_2D6_PLUS_3, 12);
        assert_close(res.crit.mean(), MAX_OF_TWO_4D6_PLUS_3, 12);
        assert_close(res.weights.crit, 0.05, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:62
    #[test]
    fn an_attack_auto_crits_roll_1_d12_keep_highest_2_1_plus_5_as_2kh1_2d12_plus_5() -> T {
        let damage = roll_with(1.0, Some(SidesOrDie::Sides(12.0)), None)?
            .keep_highest(2.0, 1.0)?
            .plus(5.0)?;
        let attack = d20().plus(11.0)?.ac(15.0)?.on_hit(damage)?;
        assert_eq!(
            attack.to_expression()?,
            "(d20 + 11 AC 15) * (2kh1(1d12) + 5) crit (2kh1(2d12) + 5)"
        );
        assert_close(attack.resolve(0.0)?.crit.mean(), MAX_OF_TWO_2D12_PLUS_5, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:96
    #[test]
    fn an_advantage_attack_check_is_never_doubled_its_crit_rate_and_doubled_payload_are_unchanged()
    -> T {
        let res = d20()
            .with_advantage()?
            .plus(5.0)?
            .ac(12.0)?
            .on_hit(rd(2.0, &d6())?)?
            .resolve(0.0)?;
        assert_close(res.weights.crit, 0.0975, 12);
        assert_close(res.crit.mean(), 14.0, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:133
    #[test]
    fn an_auto_critting_attack_throws_at_build_resolve_and_to_expression_never_88_98() -> T {
        let attack = || d20().plus(5.0)?.ac(12.0)?.on_hit(drop_lowest()?);
        assert_throws(attack()?.resolve(0.0), "4kh3(1d6)");
        assert_throws(attack()?.to_expression(), "4kh3(1d6)");
        assert_throws(
            d20()
                .plus(5.0)?
                .ac(12.0)?
                .on_hit(d6().with_advantage()?)?
                .resolve(0.0),
            "advantage",
        );
        Ok(())
    }

    /// tests/crit-keep.test.ts:140
    #[test]
    fn an_explicit_on_crit_resolves_with_that_crit_no_crit_resolves_with_none() -> T {
        let explicit_crit = drop_lowest()?.plus_roll(&drop_lowest()?)?;
        let base = || d20().plus(5.0)?.ac(12.0)?.on_hit(drop_lowest()?);
        let res = base()?
            .on_crit(&[Arg::Roll(explicit_crit.clone())])?
            .resolve(0.0)?;
        same_pmf(&res.crit, &pmf_of(&explicit_crit));
        assert_close(res.crit.mean(), 2.0 * FOUR_D6_DROP_LOWEST, 12);
        assert_close(res.hit.mean(), FOUR_D6_DROP_LOWEST, 12);
        base()?
            .on_crit(&[Arg::Roll(explicit_crit)])?
            .to_expression()?;

        let none = base()?.no_crit()?.resolve(0.0)?;
        assert_eq!(none.weights.crit, 0.0);
        assert_close(none.weights.hit, 0.7, 12);
        assert_close(none.hit.mean(), FOUR_D6_DROP_LOWEST, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:194
    #[test]
    fn on_hit_4kh3_1d6_throws_at_build_instead_of_critting_at_23_49_an_explicit_on_crit_resolves()
    -> T {
        let base = || {
            d20()
                .plus(5.0)?
                .ac(12.0)?
                .on_hit_args(&[Arg::Str("4kh3(1d6)".to_string())])
        };
        assert_throws(base()?.resolve(0.0), "4kh3");
        let res = base()?
            .on_crit(&[Arg::Str("4kh3(1d6) + 4kh3(1d6)".to_string())])?
            .resolve(0.0)?;
        assert_close(res.crit.mean(), 2.0 * FOUR_D6_DROP_LOWEST, 12);
        Ok(())
    }

    /// tests/crit-keep.test.ts:215
    #[test]
    fn no_crit_with_an_ambiguous_plus_separate_damage_channel_resolves_instead_of_throwing() -> T {
        let attack = d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit(rd(2.0, &d6())?)?
            .no_crit()?
            .plus_separate_damage(drop_lowest()?);
        let res = attack.resolve(0.0)?;
        assert_eq!(res.weights.crit, 0.0);
        assert_close(res.crit_separate.mass(), 1.0, 12);
        assert_close(res.crit_separate.p_at(0.0), 1.0, 12);
        same_pmf(&res.crit, &res.crit_base);
        Ok(())
    }

    /// tests/crit-keep.test.ts:229
    #[test]
    fn a_crittable_attack_with_the_same_ambiguous_channel_still_throws() -> T {
        let attack = d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit(rd(2.0, &d6())?)?
            .plus_separate_damage(drop_lowest()?);
        assert_throws(attack.resolve(0.0), "4kh3");
        Ok(())
    }

    /// tests/crit-keep.test.ts:238
    #[test]
    fn an_attack_that_can_crit_stays_bin_for_bin_unchanged_with_a_plain_plus_separate_damage_channel()
    -> T {
        let attack = d20()
            .plus(9.0)?
            .ac(16.0)?
            .on_hit(rd(2.0, &d6())?.plus(5.0)?)?
            .plus_separate_damage(rd(2.0, &d6())?);
        let res = attack.resolve(0.0)?;
        same_pmf(
            &res.hit,
            &res.hit_base.convolve(&res.hit_separate, None, false),
        );
        same_pmf(
            &res.crit,
            &res.crit_base.convolve(&res.crit_separate, None, false),
        );
        assert_close(res.crit_separate.mean(), 14.0, 10);
        Ok(())
    }

    /// tests/crit-keep.test.ts:248
    #[test]
    fn a_keep_pool_has_no_descriptor_on_either_branch_as_on_main_instead_of_throwing() -> T {
        let attack = d20()
            .plus(5.0)?
            .ac(17.0)?
            .on_hit(rd(4.0, &d8())?.keep_highest(4.0, 3.0)?)?;
        let (hit, crit) = attack.dice_match_info(0.0)?;
        assert!(hit.is_none() && crit.is_none());
        assert_throws(attack.resolve(0.0), "4kh3");
        Ok(())
    }

    /// tests/crit-keep.test.ts:254
    #[test]
    fn a_pool_rolled_with_disadvantage_has_no_descriptor_on_either_branch_instead_of_throwing() -> T
    {
        let attack = d20()
            .plus(5.0)?
            .ac(17.0)?
            .on_hit(rd(2.0, &d8())?.with_disadvantage()?)?;
        let (hit, crit) = attack.dice_match_info(0.0)?;
        assert!(hit.is_none() && crit.is_none());
        let with_crit = attack.on_crit(&[Arg::Roll(rd(4.0, &d8())?)])?;
        assert!(with_crit.dice_match_info(0.0)?.0.is_none());
        Ok(())
    }
}

mod crit_doubling {
    use super::*;

    const DEFECT_B: f64 = 22.7438;

    /// `2d6+3`, roll it all twice and keep the better.
    fn pool() -> Result<RollBuilder, DiceError> {
        rd(2.0, &d6())?.plus(3.0)?.keep_highest_all(2.0, 1.0)
    }

    /// The dice double inside the pool, then it pools.
    fn pool_crit() -> Result<RollBuilder, DiceError> {
        rd(4.0, &d6())?.plus(3.0)?.keep_highest_all(2.0, 1.0)
    }

    fn hit(
        damage: RollBuilder,
        ac: f64,
        bonus: f64,
    ) -> Result<crate::builder::attack::AttackBuilder, DiceError> {
        d20().plus(bonus)?.ac(ac)?.on_hit(damage)
    }

    /// tests/crit-doubling.test.ts:32
    #[test]
    fn on_hit_pool_crits_bin_for_bin_as_the_rebuilt_pool_o4_crit_never_defect_b() -> T {
        let res = hit(pool()?, 12.0, 5.0)?.resolve(0.0)?;
        same_pmf(&res.crit, &pmf_of(&pool_crit()?));
        assert_close(res.hit.mean(), 11.3719, 4); // best of two 2d6 + 3
        assert_close(res.crit.mean(), 18.9334, 4); // best of two 4d6 + 3
        assert!(!close(res.crit.mean(), DEFECT_B, 4));
        Ok(())
    }

    /// tests/crit-doubling.test.ts:63
    #[test]
    fn a_pooled_plus_separate_damage_channel_doubles_inside_the_pool_on_a_crit() -> T {
        let res = hit(rd(1.0, &d4())?, 12.0, 5.0)?
            .plus_separate_damage(pool()?)
            .resolve(0.0)?;
        same_pmf(&res.crit_separate, &pmf_of(&pool_crit()?));
        Ok(())
    }

    /// tests/crit-doubling.test.ts:77
    #[test]
    fn reroll_damage_minimum_damage_die_still_refuse_a_pooled_payload_it_has_no_dice_descriptor()
    -> T {
        let attack = hit(pool()?, 12.0, 5.0)?;
        assert_throws(attack.reroll_damage(2.0), "requires a dice descriptor");
        assert_throws(attack.minimum_damage_die(2.0), "requires a dice descriptor");
        Ok(())
    }

    /// tests/crit-doubling.test.ts:84
    #[test]
    fn on_hit_2d6_5_crits_exactly_like_on_hit_roll_2_d6_plus_5_weights_hit_and_crit() -> T {
        let parsed = d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit_args(&[Arg::Str("2d6+5".to_string())])?
            .resolve(0.0)?;
        let built = hit(rd(2.0, &d6())?.plus(5.0)?, 12.0, 5.0)?.resolve(0.0)?;
        assert_close(parsed.weights.hit, 0.65, 12);
        assert_close(parsed.weights.crit, 0.05, 12);
        assert_close(parsed.weights.miss, 0.3, 12);
        assert_close(parsed.weights.crit, built.weights.crit, 12);
        same_pmf(&parsed.hit, &built.hit);
        same_pmf(&parsed.crit, &built.crit);
        same_pmf(&parsed.pmf, &built.pmf);
        assert_close(parsed.crit.mean(), 19.0, 10);
        Ok(())
    }

    /// tests/crit-doubling.test.ts:138
    #[test]
    fn an_attack_s_expression_now_carries_the_parsed_payload_s_doubled_crit() -> T {
        let attack = d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit_args(&[Arg::Str("2d6 + 5".to_string())])?;
        assert_eq!(
            attack.to_expression()?,
            "(d20 + 5 AC 12) * (2d6 + 5) crit (4d6 + 5)"
        );
        Ok(())
    }

    /// tests/crit-doubling.test.ts:142 (the `.ac/.onHit` resolve lines; the parsed `doubleDice()` throw is in `pooled_crit.rs`)
    #[test]
    fn an_attack_check_inside_on_hit_does_not_double_the_d20_resolve_lines() -> T {
        let payload = || {
            d20()
                .plus(5.0)?
                .ac(12.0)?
                .on_hit_args(&[Arg::Str("(d20 + 5 AC 12) * (2d6)".to_string())])
        };
        assert_throws(payload()?.resolve(0.0), "attack check");
        // An explicit crit or noCrit() never doubles, so the same payload still resolves.
        payload()?.no_crit()?.resolve(0.0)?;
        Ok(())
    }

    /// The attack strings with no crit clause of crit-doubling.test.ts:324 and the builder each spells.
    fn pairs() -> Result<Vec<(&'static str, crate::builder::attack::AttackBuilder)>, DiceError> {
        Ok(vec![
            ("(d20 + 8 AC 16) * (2d6)", hit(rd(2.0, &d6())?, 16.0, 8.0)?),
            (
                "(d20+5 AC 15) * (1d8+3)",
                hit(rd(1.0, &d8())?.plus(3.0)?, 15.0, 5.0)?,
            ),
            (
                "(d20 + 5 AC 12) * (d6 reroll 1 + 3)",
                hit(rd(1.0, &d6())?.reroll(1.0)?.plus(3.0)?, 12.0, 5.0)?,
            ),
            // Bonus to-hit dice: the tracked natural-20 slice.
            (
                "(d20 + 5 + d4 AC 12) * (2d6)",
                d20()
                    .plus(5.0)?
                    .plus_roll(&d4())?
                    .ac(12.0)?
                    .on_hit(rd(2.0, &d6())?)?,
            ),
            // Advantage and halfling luck: the kept natural roll, tracked the same way.
            (
                "(d20 > d20 + 5 AC 12) * (2d6)",
                d20()
                    .with_advantage()?
                    .plus(5.0)?
                    .ac(12.0)?
                    .on_hit(rd(2.0, &d6())?)?,
            ),
            (
                "(hd20 + 5 AC 12) * (2d6)",
                d20()
                    .reroll(1.0)?
                    .plus(5.0)?
                    .ac(12.0)?
                    .on_hit(rd(2.0, &d6())?)?,
            ),
        ])
    }

    /// tests/crit-doubling.test.ts:341 (the builder-vs-parsed loop; the parsed-only tail is in `pooled_crit.rs`)
    #[test]
    fn labels_its_crit_mass_crit_and_matches_the_builder_bin_for_bin_label_by_label_loop() -> T {
        for (expression, built) in pairs()? {
            let parsed = pmf_of(&dd(expression)?);
            let reference = built.to_pmf(0.0)?;
            for label in ["hit", "crit", "missNone"] {
                assert_close(
                    parsed.outcome_probability(label),
                    reference.outcome_probability(label),
                    12,
                );
                same_pmf(
                    &parsed.filter_outcome(label),
                    &reference.filter_outcome(label),
                );
            }
        }
        Ok(())
    }

    /// tests/crit-doubling.test.ts:401 (the `built` `AttackBuilder` comparison; the rest is in `pooled_crit.rs`)
    #[test]
    fn a_miss_clause_matches_the_built_attack_branch_by_branch() -> T {
        let miss = pmf_of(&dd("(d20+5 AC 15) * (2d6) miss (1d6)")?);
        let built = hit(rd(2.0, &d6())?, 15.0, 5.0)?
            .on_miss(&[Arg::Roll(rd(1.0, &d6())?)])?
            .to_pmf(0.0)?;
        for label in ["hit", "crit", "missDamage"] {
            same_pmf(&miss.filter_outcome(label), &built.filter_outcome(label));
        }
        Ok(())
    }
}

mod crit_parse_edges {
    use super::*;
    use crate::builder::attack::AttackBuilder;
    use crate::parser::parse;

    const LABELS: [&str; 4] = ["hit", "crit", "missNone", "missDamage"];

    fn p(e: &str) -> Result<Pmf, DiceError> {
        parse(e)
    }

    /// Same bins, same hit/crit/miss weights, and the same damage under each label.
    #[track_caller]
    fn same_attack(expression: &str, built: &AttackBuilder) -> T {
        let parsed = p(expression)?;
        let reference = built.to_pmf(0.0)?;
        same_pmf(&parsed, &reference);
        for label in LABELS {
            assert_close(
                parsed.outcome_probability(label),
                reference.outcome_probability(label),
                12,
            );
            same_pmf(
                &parsed.filter_outcome(label),
                &reference.filter_outcome(label),
            );
        }
        Ok(())
    }

    fn atk(
        check: Result<RollBuilder, DiceError>,
        damage: RollBuilder,
    ) -> Result<AttackBuilder, DiceError> {
        check?.on_hit(damage)
    }

    fn s(text: &str) -> Arg {
        Arg::Str(text.to_string())
    }

    /// `d20.plus(5).plus(d4)`.
    fn d20_5_d4() -> Result<RollBuilder, DiceError> {
        d20().plus(5.0)?.plus_roll(&d4())
    }

    /// tests/crit-parse-edges.test.ts:51 (the `expectSameAttack` builder comparisons)
    #[test]
    fn d20_5_ac_15_1d8_plus_1d6_matches_on_hit_roll_1_d8_plus_roll_1_d6() -> T {
        let built = atk(
            d20().plus(5.0)?.ac(15.0),
            rd(1.0, &d8())?.plus_roll(&rd(1.0, &d6())?)?,
        )?;
        same_attack("(d20 + 5 AC 15) * (1d8) + 1d6", &built)?;
        same_attack("d20 + 5 AC 15 * 1d8 + 1d6", &built)?;
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:59 (the builder comparisons)
    #[test]
    fn a_trailing_flat_keeps_every_label_and_is_added_once_on_a_crit_builder() -> T {
        same_attack(
            "(d20+5 AC 12) * (2d6) + 3",
            &atk(d20().plus(5.0)?.ac(12.0), rd(2.0, &d6())?.plus(3.0)?)?,
        )?;
        same_attack(
            "d20 + 5 AC 15 * 1d8 + 3",
            &atk(d20().plus(5.0)?.ac(15.0), rd(1.0, &d8())?.plus(3.0)?)?,
        )
    }

    /// tests/crit-parse-edges.test.ts:77
    #[test]
    fn every_hit_only_operator_doubles_through_the_whole_payload_like_a_parsed_on_hit_string() -> T
    {
        for tail in ["* (1d4)", "** 2", "/ 2", "// 2", "+ 1d4 + 2"] {
            let built = d20()
                .plus(5.0)?
                .ac(12.0)?
                .on_hit_args(&[s(&format!("(2d6) {tail}"))])?;
            same_attack(&format!("(d20 + 5 AC 12) * (2d6) {tail}"), &built)?;
        }
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:83
    #[test]
    fn a_crit_clause_still_wins_a_trailing_term_is_added_to_its_payload_as_written() -> T {
        let built = d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(rd(1.0, &d8())?.plus_roll(&rd(1.0, &d6())?)?)?
            .on_crit(&[Arg::Roll(rd(2.0, &d8())?.plus_roll(&rd(1.0, &d6())?)?)])?;
        same_attack("(d20 + 5 AC 15) * (1d8) crit (2d8) + 1d6", &built)
    }

    /// tests/crit-parse-edges.test.ts:88 (the builder comparison)
    #[test]
    fn a_miss_clause_keeps_its_label_and_a_trailing_plus_adds_to_its_damage_too_builder() -> T {
        let built = d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(rd(2.0, &d6())?.plus(3.0)?)?
            .on_miss(&[Arg::Roll(rd(1.0, &d6())?.plus(3.0)?)])?;
        same_attack("(d20 + 5 AC 15) * (2d6) miss (1d6) + 3", &built)
    }

    /// tests/crit-parse-edges.test.ts:96 (the builder comparison)
    #[test]
    fn advantage_crit_39_400_mean_5537_800_builder() -> T {
        same_attack(
            "(d20 > d20 + 5 + 1d4 AC 15) * (2d6)",
            &atk(
                d20()
                    .with_advantage()?
                    .plus(5.0)?
                    .plus_roll(&d4())?
                    .ac(15.0),
                rd(2.0, &d6())?,
            )?,
        )
    }

    /// tests/crit-parse-edges.test.ts:103 (the builder comparison)
    #[test]
    fn halfling_luck_crit_21_400_mean_4263_800_builder() -> T {
        same_attack(
            "(hd20 + 5 + 1d4 AC 15) * (2d6)",
            &atk(
                d20().reroll(1.0)?.plus(5.0)?.plus_roll(&d4())?.ac(15.0),
                rd(2.0, &d6())?,
            )?,
        )
    }

    /// tests/crit-parse-edges.test.ts:110 (the builder comparisons)
    #[test]
    fn disadvantage_elven_accuracy_bang_reroll_parentheses_and_1d20_spell_the_same_checks_builder()
    -> T {
        let damage = rd(2.0, &d6())?;
        let adv = atk(
            d20()
                .with_advantage()?
                .plus(5.0)?
                .plus_roll(&d4())?
                .ac(15.0),
            damage.clone(),
        )?;
        same_attack(
            "(d20 < d20 + 5 + 1d4 AC 15) * (2d6)",
            &atk(
                d20()
                    .with_disadvantage()?
                    .plus(5.0)?
                    .plus_roll(&d4())?
                    .ac(15.0),
                damage.clone(),
            )?,
        )?;
        same_attack(
            "(d20 > d20 > d20 + 5 + 1d4 AC 15) * (2d6)",
            &atk(
                d20()
                    .with_elven_accuracy()?
                    .plus(5.0)?
                    .plus_roll(&d4())?
                    .ac(15.0),
                damage.clone(),
            )?,
        )?;
        same_attack("(d20! + 5 + 1d4 AC 15) * (2d6)", &adv)?;
        same_attack("((d20 > d20) + 5 + 1d4 AC 15) * (2d6)", &adv)?;
        same_attack(
            "(d20 reroll 1 + 5 + 1d4 AC 15) * (2d6)",
            &atk(
                d20().reroll(1.0)?.plus(5.0)?.plus_roll(&d4())?.ac(15.0),
                damage.clone(),
            )?,
        )?;
        same_attack(
            "(1d20 + 5 + 1d4 AC 15) * (2d6)",
            &atk(d20_5_d4()?.ac(15.0), damage)?,
        )
    }

    /// tests/crit-parse-edges.test.ts:122
    #[test]
    fn a_crit_clause_reads_the_same_tracked_slice() -> T {
        let built = d20()
            .with_advantage()?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(rd(1.0, &d8())?.plus(3.0)?)?
            .on_crit(&[Arg::Roll(rd(2.0, &d8())?.plus(3.0)?)])?;
        same_attack(
            "(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) crit (2d8 + 3)",
            &built,
        )
    }

    /// tests/crit-parse-edges.test.ts:129 (the builder comparisons)
    #[test]
    fn xcrit_with_a_bonus_die_crits_on_every_natural_face_in_range_builder() -> T {
        let hit = || rd(1.0, &d8())?.plus(3.0);
        let crit = || rd(2.0, &d8())?.plus(3.0);
        let flat = d20_5_d4()?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(hit()?)?
            .on_crit(&[Arg::Roll(crit()?)])?;
        same_attack("(d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)", &flat)?;
        let adv = d20()
            .with_advantage()?
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .crit_on(19.0)?
            .on_hit(hit()?)?
            .on_crit(&[Arg::Roll(crit()?)])?;
        same_attack(
            "(d20 > d20 + 5 + 1d4 AC 15) * (1d8 + 3) xcrit2 (2d8 + 3)",
            &adv,
        )
    }

    /// tests/crit-parse-edges.test.ts:141 (the builder comparisons)
    #[test]
    fn the_natural_roll_is_the_checks_d20_wherever_it_sits_in_the_sum_builder() -> T {
        let damage = rd(2.0, &d6())?;
        let reference = atk(d20_5_d4()?.ac(15.0), damage.clone())?;
        for expression in [
            "(1d4 + d20 + 5 AC 15) * (2d6)",
            "(1d4 + 1d20 + 5 AC 15) * (2d6)",
            "(5 + 1d4 + d20 AC 15) * (2d6)",
            "(d4 + 5 + d20 AC 15) * (2d6)",
            "(1d4 + d20 + 5 AC 15) * (2d6) crit (4d6)",
        ] {
            same_attack(expression, &reference)?;
        }
        same_attack(
            "(2d4 + d20 + 5 AC 15) * (2d6)",
            &atk(
                d20().plus(5.0)?.plus_roll(&rd(2.0, &d4())?)?.ac(15.0),
                damage,
            )?,
        )
    }

    /// tests/crit-parse-edges.test.ts:166 (the builder comparisons)
    #[test]
    fn keep_spelled_advantage_disadvantage_and_elven_accuracy_keep_one_natural_d20_builder() -> T {
        let damage = rd(2.0, &d6())?;
        same_attack(
            "(2kh1(1d20) + 5 AC 15) * (2d6)",
            &atk(d20().with_advantage()?.plus(5.0)?.ac(15.0), damage.clone())?,
        )?;
        same_attack(
            "(2kh1d20 + 5 AC 15) * (2d6)",
            &atk(d20().with_advantage()?.plus(5.0)?.ac(15.0), damage.clone())?,
        )?;
        same_attack(
            "(2kl1(1d20) + 5 AC 15) * (2d6)",
            &atk(
                d20().with_disadvantage()?.plus(5.0)?.ac(15.0),
                damage.clone(),
            )?,
        )?;
        same_attack(
            "(3kh1(1d20) + 5 AC 15) * (2d6)",
            &atk(
                d20().with_elven_accuracy()?.plus(5.0)?.ac(15.0),
                damage.clone(),
            )?,
        )?;
        same_attack(
            "(2kh1(1d20) + 1d4 + 5 AC 15) * (2d6)",
            &atk(
                d20()
                    .with_advantage()?
                    .plus(5.0)?
                    .plus_roll(&d4())?
                    .ac(15.0),
                damage,
            )?,
        )
    }

    /// tests/crit-parse-edges.test.ts:343 (the `.ac(15).onHit("1d6 & 3").resolve()` line; the rest is in `pooled_crit.rs`)
    #[test]
    fn and_in_a_hit_payload_that_doubles_resolve_throws_ambiguous_crit_doubling() -> T {
        let attack = d20().plus(5.0)?.ac(15.0)?.on_hit_args(&[s("1d6 & 3")])?;
        let e = error_of(attack.resolve(0.0));
        assert!(
            matches!(e, crate::error::DiceError::AmbiguousCritDoubling(_)),
            "{e}"
        );
        Ok(())
    }

    /// tests/crit-parse-edges.test.ts:383 (the builder comparisons and the round trip; the parse-only table is in `pooled_crit.rs`)
    #[test]
    fn a_check_with_no_die_in_it_agrees_with_the_builders_dieless_check() -> T {
        let flat15 = || flat(15.0);
        same_attack(
            "(15 AC 12) * (1d6)",
            &flat15()?
                .always_hits()?
                .on_hit(rd(1.0, &d6())?)?
                .no_crit()?,
        )?;
        same_attack(
            "(15 AC 12) * (1d6)",
            &flat15()?.ac(12.0)?.on_hit(rd(1.0, &d6())?)?,
        )?;
        same_attack(
            "(10 + 5 AC 12) * (2d6) + 3",
            &flat15()?
                .always_hits()?
                .on_hit(rd(2.0, &d6())?.plus(3.0)?)?
                .no_crit()?,
        )?;
        // A die on the AC side is the target's roll, never the attack's natural roll.
        same_attack(
            "(25 AC d20) * (1d6)",
            &flat(25.0)?
                .always_hits()?
                .on_hit(rd(1.0, &d6())?)?
                .no_crit()?,
        )?;
        // The builder's flat check round-trips through its own string to the same mean.
        let flat_attack = flat15()?.ac(12.0)?.on_hit(d6())?;
        let expression = flat_attack.to_expression()?;
        assert_eq!(expression, "(15 AC 12) * (1d6) crit (2d6)");
        assert_close(p(&expression)?.mean(), flat_attack.to_pmf(0.0)?.mean(), 12);
        Ok(())
    }
}

/// Port of `tests/enumerate-reroll.ts` (brute force for "reroll up to k dice, keep the new rolls") and
/// the `expectDist` / `mean` helpers of `tests/enumerate-dice.ts`. Sums here are of whole-number
/// faces, so a `Dist` is keyed by `i64`.
mod oracle {
    use crate::Pmf;
    use crate::js::num_to_string;
    use std::cmp::Ordering;
    use std::collections::BTreeMap;

    /// Value -> probability.
    pub type Dist = BTreeMap<i64, f64>;

    const TOLERANCE: f64 = 1e-9;

    /// A die's faces read from the rules: a raw face 1..`reroll` is rerolled once and the new roll is
    /// kept, then `minimum` floors each shown face; `negate` makes it a subtracted die.
    pub fn rule_die(sides: i64, minimum: i64, reroll: i64, negate: bool) -> Dist {
        let mut faces = Dist::new();
        let mut put = |raw: i64, p: f64| {
            let value = (if negate { -1 } else { 1 }) * raw.max(minimum);
            *faces.entry(value).or_insert(0.0) += p;
        };
        let rerolled = reroll.min(sides);
        let s = sides as f64;
        for raw in 1..=sides {
            if raw > rerolled {
                put(raw, 1.0 / s);
            } else {
                for fresh in 1..=sides {
                    put(fresh, 1.0 / (s * s));
                }
            }
        }
        faces
    }

    /// `ruleDie(sides)` `count` times.
    pub fn dice(sides: i64, count: usize) -> Vec<Dist> {
        (0..count).map(|_| rule_die(sides, 0, 0, false)).collect()
    }

    pub fn mean_of(faces: &Dist) -> f64 {
        faces.iter().map(|(v, p)| *v as f64 * p).sum()
    }

    pub fn shifted(dist: &Dist, by: i64) -> Dist {
        dist.iter().map(|(v, p)| (v + by, *p)).collect()
    }

    pub fn dist_of(pmf: &Pmf) -> Dist {
        pmf.support()
            .iter()
            .map(|d| (d.0 as i64, pmf.p_at(d.0)))
            .collect()
    }

    /// Every bin of `actual` equals `expected` to 1e-12, with no extra or missing support.
    #[track_caller]
    pub fn expect_dist(actual: &Pmf, expected: &Dist) {
        let mut support: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
        support.extend(expected.keys().copied());
        for v in support {
            let want = expected.get(&v).copied().unwrap_or(0.0);
            assert!((actual.p_at(v as f64) - want).abs() <= 1e-12, "bin {v}");
        }
        assert!((actual.mass() - 1.0).abs() <= 1e-12, "mass");
    }

    /// Dice with the same faces are one kind. Kinds are ranked by the rule that settles equal gains:
    /// higher mean first, then the faces read as text.
    fn kind_ids(dice: &[Dist]) -> Vec<i64> {
        let keys: Vec<String> = dice
            .iter()
            .map(|die| {
                let faces: Vec<String> = die
                    .iter()
                    .map(|(v, p)| format!("[{v},{}]", num_to_string(*p)))
                    .collect();
                format!("[{}]", faces.join(","))
            })
            .collect();
        let mut ranked: Vec<(String, f64)> = Vec::new();
        for (key, die) in keys.iter().zip(dice) {
            match ranked.iter_mut().find(|(k, _)| k == key) {
                Some(entry) => entry.1 = mean_of(die),
                None => ranked.push((key.clone(), mean_of(die))),
            }
        }
        ranked.sort_by(|a, b| {
            let diff = b.1 - a.1;
            if diff != 0.0 {
                diff.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
            } else {
                a.0.cmp(&b.0)
            }
        });
        keys.iter()
            .map(|key| ranked.iter().position(|(k, _)| k == key).unwrap_or(0) as i64)
            .collect()
    }

    fn tie_key(set: &[usize], kinds: &[i64]) -> Vec<i64> {
        let mut rest: Vec<i64> = set.iter().map(|&i| kinds[i] * 1000 + i as i64).collect();
        rest.sort_unstable();
        let mut key = vec![set.len() as i64];
        key.extend(rest);
        key
    }

    fn earlier(a: &[i64], b: &[i64]) -> bool {
        for i in 0..a.len().min(b.len()) {
            if a[i] != b[i] {
                return a[i] < b[i];
            }
        }
        a.len() < b.len()
    }

    /// Everything the brute force needs of a pool: its dice, their means and kinds, the budget.
    struct Pool<'a> {
        dice: &'a [Dist],
        means: Vec<f64>,
        kinds: Vec<i64>,
        budget: usize,
    }

    impl<'a> Pool<'a> {
        fn new(dice: &'a [Dist], budget: usize) -> Self {
            Pool {
                dice,
                means: dice.iter().map(mean_of).collect(),
                kinds: kind_ids(dice),
                budget,
            }
        }

        /// The best subset of at most `budget` dice to reroll, by trying every one: highest expected
        /// total; ties to fewer dice, then to the earlier kinds' dice.
        fn best_set(&self, values: &[i64]) -> (Vec<usize>, f64) {
            let n = self.dice.len();
            let mut best: Option<(Vec<usize>, f64)> = None;
            for mask in 0u32..(1 << n) {
                let set: Vec<usize> = (0..n).filter(|i| mask & (1 << i) != 0).collect();
                if set.len() > self.budget {
                    continue;
                }
                let expected = values.iter().enumerate().fold(0.0, |total, (i, &v)| {
                    total
                        + if set.contains(&i) {
                            self.means[i]
                        } else {
                            v as f64
                        }
                });
                let better = match &best {
                    None => true,
                    Some((best_set, best_expected)) => {
                        expected > best_expected + TOLERANCE
                            || ((expected - best_expected).abs() <= TOLERANCE
                                && earlier(
                                    &tie_key(&set, &self.kinds),
                                    &tie_key(best_set, &self.kinds),
                                ))
                    }
                };
                if better {
                    best = Some((set, expected));
                }
            }
            best.unwrap_or((Vec::new(), 0.0))
        }

        /// The total of `values` with the dice of `set` rerolled once, as a distribution.
        fn after(&self, values: &[i64], set: &[usize]) -> Dist {
            let kept: i64 = values
                .iter()
                .enumerate()
                .map(|(i, v)| if set.contains(&i) { 0 } else { *v })
                .sum();
            let mut after = Dist::from([(kept, 1.0)]);
            for &i in set {
                let mut next = Dist::new();
                for (total, pt) in &after {
                    for (value, pv) in &self.dice[i] {
                        *next.entry(total + value).or_insert(0.0) += pt * pv;
                    }
                }
                after = next;
            }
            after
        }
    }

    /// Every joint roll of `pool`: the faces in order and their probability.
    fn rolls_of(pool: &[Dist]) -> Vec<(Vec<i64>, f64)> {
        let mut out = vec![(Vec::new(), 1.0)];
        for die in pool {
            let mut next = Vec::new();
            for (values, p) in &out {
                for (value, pv) in die {
                    let mut v = values.clone();
                    v.push(*value);
                    next.push((v, p * pv));
                }
            }
            out = next;
        }
        out
    }

    struct Outcome {
        p: f64,
        score: f64,
        after: Dist,
    }

    fn list(
        trial: usize,
        rolls: usize,
        leader: Option<usize>,
        p: f64,
        outcomes: &[Outcome],
        mass: &mut [f64],
    ) {
        if trial == rolls {
            if let Some(l) = leader {
                mass[l] += p;
            }
            return;
        }
        for (i, outcome) in outcomes.iter().enumerate() {
            let next = match leader {
                Some(l) if outcome.score <= outcomes[l].score + TOLERANCE => l,
                _ => i,
            };
            list(trial + 1, rolls, Some(next), p * outcome.p, outcomes, mass);
        }
    }

    /// Distribution of the pool's total when up to `budget` dice are rerolled for the best expected
    /// total and the new rolls are kept. With `rolls` above 1 the pool is rolled that many times, the
    /// roll with the highest such expected total is used (the first on a tie), and only it is rerolled.
    pub fn brute_force_reroll_up_to(dice: &[Dist], budget: usize, rolls: usize) -> Dist {
        let pool = Pool::new(dice, budget);
        let outcomes: Vec<Outcome> = rolls_of(dice)
            .into_iter()
            .map(|(values, p)| {
                let (set, score) = pool.best_set(&values);
                Outcome {
                    p,
                    score,
                    after: pool.after(&values, &set),
                }
            })
            .collect();
        let mut mass = vec![0.0; outcomes.len()];
        list(0, rolls, None, 1.0, &outcomes, &mut mass);
        let mut out = Dist::new();
        for (outcome, chosen) in outcomes.iter().zip(&mass) {
            for (total, p) in &outcome.after {
                *out.entry(*total).or_insert(0.0) += chosen * p;
            }
        }
        out
    }

    struct Leader {
        values: Vec<i64>,
        set: Vec<usize>,
        expected: f64,
    }

    struct Partial<'a> {
        pool: Pool<'a>,
        repeated_rolls: Vec<(Vec<i64>, f64)>,
        rolls: usize,
        out: Dist,
    }

    impl Partial<'_> {
        fn play(&mut self, trial: usize, leader: Option<&Leader>, once_values: &[i64], p: f64) {
            if trial == self.rolls {
                if let Some(l) = leader {
                    for (total, pt) in self.pool.after(&l.values, &l.set) {
                        *self.out.entry(total).or_insert(0.0) += p * pt;
                    }
                }
                return;
            }
            for k in 0..self.repeated_rolls.len() {
                let (values, pv) = (self.repeated_rolls[k].0.clone(), self.repeated_rolls[k].1);
                let mut all = values;
                all.extend_from_slice(once_values);
                let (set, expected) = self.pool.best_set(&all);
                let candidate = Leader {
                    values: all,
                    set,
                    expected,
                };
                let next = match leader {
                    Some(l) if candidate.expected <= l.expected + TOLERANCE => None,
                    _ => Some(candidate),
                };
                match (&next, leader) {
                    (Some(n), _) => self.play(trial + 1, Some(n), once_values, p * pv),
                    (None, l) => self.play(trial + 1, l, once_values, p * pv),
                }
            }
        }
    }

    /// Distribution of a pool whose `repeated` dice are rolled `rolls` times and whose `once` dice are
    /// rolled once, then up to `budget` dice of the kept roll and the once-rolled dice are rerolled,
    /// the new rolls kept (Savage Attacker with a Piercer reroll).
    pub fn brute_force_partial_reroll_up_to(
        repeated: &[Dist],
        once: &[Dist],
        budget: usize,
        rolls: usize,
    ) -> Dist {
        let all: Vec<Dist> = repeated.iter().chain(once).cloned().collect();
        let mut state = Partial {
            pool: Pool::new(&all, budget),
            repeated_rolls: rolls_of(repeated),
            rolls,
            out: Dist::new(),
        };
        for (once_values, p) in rolls_of(once) {
            state.play(0, None, &once_values, p);
        }
        state.out
    }
}

mod reroll_up_to {
    use super::oracle::*;
    use super::*;
    use crate::builder::attack::AttackBuilder;
    use crate::builder::roll::RollRerollUpToOptions;

    fn attack() -> Result<RollBuilder, DiceError> {
        d20().plus(5.0)?.ac(15.0)
    }

    fn opts(rolls: f64) -> RollRerollUpToOptions {
        RollRerollUpToOptions {
            rolls: Some(rolls),
            rolled_once: None,
        }
    }

    fn s(text: &str) -> Arg {
        Arg::Str(text.to_string())
    }

    /// `onHit(count, die)`.
    fn hit_of(
        check: &RollBuilder,
        count: f64,
        die: RollBuilder,
    ) -> Result<AttackBuilder, DiceError> {
        check.on_hit_args(&[Arg::Num(count), Arg::Roll(die)])
    }

    /// tests/reroll-up-to.test.ts:360
    #[test]
    fn rerolls_the_hit_s_dice_and_a_crit_s_doubled_dice_with_the_same_budget() -> T {
        let resolved = attack()?
            .on_hit(rd(2.0, &d6())?.plus(3.0)?)?
            .reroll_damage_up_to(1.0, None)?
            .resolve(0.0)?;
        expect_dist(
            &resolved.hit_base,
            &shifted(&brute_force_reroll_up_to(&dice(6, 2), 1, 1), 3),
        );
        expect_dist(
            &resolved.crit_base,
            &shifted(&brute_force_reroll_up_to(&dice(6, 4), 1, 1), 3),
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:366
    #[test]
    fn with_rolls_2_it_is_savage_attacker_s_best_of_two_with_a_reroll_budget_on_the_hit_and_the_crit()
    -> T {
        let resolved = attack()?
            .on_hit(rd(2.0, &d6())?.plus(3.0)?)?
            .reroll_damage_up_to(1.0, Some(2.0))?
            .resolve(0.0)?;
        expect_dist(
            &resolved.hit_base,
            &shifted(&brute_force_reroll_up_to(&dice(6, 2), 1, 2), 3),
        );
        expect_dist(
            &resolved.crit_base,
            &shifted(&brute_force_reroll_up_to(&dice(6, 4), 1, 2), 3),
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:372
    #[test]
    fn a_pool_given_as_the_payload_doubles_its_dice_on_a_crit_like_the_attack_verb() -> T {
        let via_payload = attack()?
            .on_hit(
                rd(2.0, &d6())?
                    .plus(3.0)?
                    .reroll_up_to(1.0, Some(&opts(2.0)))?,
            )?
            .resolve(0.0)?;
        let via_verb = attack()?
            .on_hit(rd(2.0, &d6())?.plus(3.0)?)?
            .reroll_damage_up_to(1.0, Some(2.0))?
            .resolve(0.0)?;
        expect_dist(&via_payload.hit_base, &dist_of(&via_verb.hit_base));
        expect_dist(&via_payload.crit_base, &dist_of(&via_verb.crit_base));
        assert_throws(
            attack()?
                .on_hit(rd(2.0, &d6())?.reroll_up_to(1.0, None)?)?
                .reroll_damage_up_to(1.0, None),
            "requires a dice descriptor",
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:380
    #[test]
    fn does_not_depend_on_whether_on_crit_no_crit_plus_separate_damage_reroll_damage_or_minimum_damage_die_comes_first()
    -> T {
        let check = attack()?;
        let first = hit_of(&check, 3.0, d6())?
            .reroll_damage_up_to(1.0, None)?
            .on_crit(&[Arg::Num(3.0), Arg::Roll(d8())])?
            .minimum_damage_die(2.0)?
            .reroll_damage(1.0)?;
        let last = hit_of(&check, 3.0, d6())?
            .minimum_damage_die(2.0)?
            .reroll_damage(1.0)?
            .on_crit(&[Arg::Num(3.0), Arg::Roll(d8())])?
            .reroll_damage_up_to(1.0, None)?;
        let a = first.resolve(0.0)?;
        let b = last.resolve(0.0)?;
        expect_dist(&a.hit_base, &dist_of(&b.hit_base));
        expect_dist(&a.crit_base, &dist_of(&b.crit_base));
        // The explicit crit rerolls too, the floor and the low-face reroll included.
        expect_dist(
            &a.crit_base,
            &brute_force_reroll_up_to(
                &[
                    rule_die(8, 2, 1, false),
                    rule_die(8, 2, 1, false),
                    rule_die(8, 2, 1, false),
                ],
                1,
                1,
            ),
        );
        expect_dist(
            &a.hit_base,
            &brute_force_reroll_up_to(
                &[
                    rule_die(6, 2, 1, false),
                    rule_die(6, 2, 1, false),
                    rule_die(6, 2, 1, false),
                ],
                1,
                1,
            ),
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:392
    #[test]
    fn leaves_separate_damage_channels_alone() -> T {
        let resolved = hit_of(&attack()?, 2.0, d6())?
            .plus_separate_damage(rd(2.0, &d4())?)
            .reroll_damage_up_to(1.0, None)?
            .resolve(0.0)?;
        expect_dist(
            &resolved.hit_base,
            &brute_force_reroll_up_to(&dice(6, 2), 1, 1),
        );
        expect_dist(
            &resolved.hit_separate,
            &brute_force_reroll_up_to(&dice(4, 2), 0, 1),
        );
        expect_dist(
            &resolved.crit_separate,
            &brute_force_reroll_up_to(&dice(4, 4), 0, 1),
        );
        let together = brute_force_reroll_up_to(&dice(6, 2), 1, 1);
        assert_close(resolved.hit.mean(), mean_of(&together) + 5.0, 12);
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:401
    #[test]
    fn no_crit_keeps_its_hit_reroll_and_a_repeat_is_a_no_op_while_a_different_budget_throws() -> T {
        let no_crit = hit_of(&attack()?, 2.0, d6())?
            .no_crit()?
            .reroll_damage_up_to(1.0, None)?;
        expect_dist(
            &no_crit.resolve(0.0)?.hit_base,
            &brute_force_reroll_up_to(&dice(6, 2), 1, 1),
        );
        let once = hit_of(&attack()?, 2.0, d6())?.reroll_damage_up_to(1.0, None)?;
        // `toBe(once)`: the repeat is the same attack.
        let again = once.reroll_damage_up_to(1.0, None)?;
        assert_eq!(again.reroll_pool(), once.reroll_pool());
        same_pmf(&again.to_pmf(0.0)?, &once.to_pmf(0.0)?);
        assert_throws(
            once.reroll_damage_up_to(2.0, None),
            "Conflicting rerollDamageUpTo",
        );
        assert_throws(
            once.reroll_damage_up_to(1.0, Some(2.0)),
            "Conflicting rerollDamageUpTo",
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:410
    #[test]
    fn changes_the_attack_s_pmf_and_two_budgets_do_not_share_a_cached_attack() -> T {
        let plain = hit_of(&attack()?, 2.0, d6())?;
        let one = plain.reroll_damage_up_to(1.0, None)?;
        let two = plain.reroll_damage_up_to(2.0, None)?;
        assert!(one.to_pmf(0.0)?.mean() > plain.to_pmf(0.0)?.mean());
        assert!(two.to_pmf(0.0)?.mean() > one.to_pmf(0.0)?.mean());
        assert_close(
            plain.to_pmf(0.0)?.mean(),
            hit_of(&attack()?, 2.0, d6())?.to_pmf(0.0)?.mean(),
            15,
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:419
    #[test]
    fn refuses_a_payload_with_no_plain_dice_at_the_call_and_a_crit_payload_set_later() -> T {
        assert_throws(
            attack()?
                .on_hit_args(&[s("2d6+3")])?
                .reroll_damage_up_to(1.0, None),
            "requires a dice descriptor",
        );
        assert_throws(
            attack()?
                .on_hit(rd(2.0, &d6())?.half()?)?
                .reroll_damage_up_to(1.0, None),
            "requires a dice descriptor",
        );
        assert_throws(
            hit_of(&attack()?, 2.0, d6())?
                .reroll_damage_up_to(1.0, None)?
                .on_crit(&[s("4d6")]),
            "requires a dice descriptor",
        );
        let e = err_of(
            attack()?
                .on_hit(rd(4.0, &d6())?.keep_highest(4.0, 3.0)?)?
                .reroll_damage_up_to(1.0, None),
        );
        let head = "rerollDamageUpTo() rerolls plain dice";
        // `/rerollDamageUpTo\(\) rerolls plain dice.*keep/`
        let at = e
            .find(head)
            .ok_or_else(|| DiceError::error(format!("{e:?} lacks {head:?}")))?;
        assert!(e[at + head.len()..].contains("keep"), "{e}");
        assert_throws(
            hit_of(&attack()?, 2.0, d6())?
                .no_crit()?
                .reroll_damage_up_to(1.0, None)?
                .on_crit(&[Arg::Roll(rd(2.0, &d6())?.explode(1.0)?)]),
            "exploding",
        );
        assert_throws(
            hit_of(&attack()?, 2.0, d6())?.reroll_damage_up_to(-1.0, None),
            "non-negative integer",
        );
        Ok(())
    }

    /// tests/reroll-up-to.test.ts:428
    #[test]
    fn rerolled_attack_has_no_string_spelling() -> T {
        let rerolled = hit_of(&attack()?, 3.0, d6())?.reroll_damage_up_to(1.0, None)?;
        assert_throws(rerolled.to_expression(), "rerollDamageUpTo");
        Ok(())
    }

    /// tests/reroll-up-to-partial.test.ts:105
    #[test]
    fn as_an_attack_s_payload_the_crit_doubles_both_sides() -> T {
        let payload = rd(1.0, &d8())?.plus(3.0)?.reroll_up_to(
            1.0,
            Some(&RollRerollUpToOptions {
                rolls: Some(2.0),
                rolled_once: Some(rd(1.0, &d10())?),
            }),
        )?;
        let resolved = d20().plus(5.0)?.ac(10.0)?.on_hit(payload)?.resolve(0.0)?;
        expect_dist(
            &resolved.crit_base,
            &shifted(
                &brute_force_partial_reroll_up_to(&dice(8, 2), &dice(10, 2), 1, 2),
                3,
            ),
        );
        Ok(())
    }

    /// tests/reroll-up-to-partial.test.ts:130
    #[test]
    fn a_dice_match_trigger_refuses_it_rather_than_guessing() -> T {
        let payload = rd(2.0, &d8())?.reroll_up_to(
            1.0,
            Some(&RollRerollUpToOptions {
                rolls: Some(2.0),
                rolled_once: Some(rd(1.0, &d8())?),
            }),
        )?;
        let attack = d20().plus(5.0)?.ac(10.0)?.on_hit(payload)?;
        let (hit, _) = attack.dice_match_refusals()?;
        let hit = hit.ok_or("no hit refusal")?;
        assert!(hit.contains("rolled once"), "{hit}");
        Ok(())
    }
}

mod math_correctness {
    use super::*;

    /// tests/math-correctness.test.ts:395
    #[test]
    fn builder_computes_crit_0_05_with_a_plus_1d4_bless_to_hit() -> T {
        let b = d20()
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(roll_with(1.0, Some(SidesOrDie::Sides(8.0)), None)?.plus(3.0)?)?
            .on_crit(&[Arg::Roll(
                roll_with(2.0, Some(SidesOrDie::Sides(8.0)), None)?.plus(3.0)?,
            )])?;
        assert_close(b.resolve(0.0)?.weights.crit, 0.05, 9);
        Ok(())
    }
}

mod parsed_check_refusal {
    use super::*;

    /// tests/parsed-check-refusal.test.ts:7 (the `.ac()` / `.dc()` calls themselves; the guard is in `pooled_crit.rs`)
    #[test]
    fn a_parsed_string_ac_dc_throws_instead_of_dropping_the_strings_flats_and_dice() -> T {
        let from_args = |text: &str| RollBuilder::from_args(&[Arg::Str(text.to_string())]);
        let cases = [
            ("d('d20+5').ac(15)", dd("d20+5")?.ac(15.0)),
            (
                "RollBuilder.fromArgs('d20+5').ac(15)",
                from_args("d20+5")?.ac(15.0),
            ),
            ("d('d20+5').dc(15)", dd("d20+5")?.dc(15.0)),
            (
                "RollBuilder.fromArgs('d20 + 3 + 1d4').dc(12)",
                from_args("d20 + 3 + 1d4")?.dc(12.0),
            ),
        ];
        for (name, built) in cases {
            let e = err_of(built);
            assert!(e.starts_with("Cannot use the parsed string"), "{name}: {e}");
            assert!(e.contains("d20.plus") || e.contains("AC"), "{name}: {e}");
        }
        Ok(())
    }
}

mod query_edges {
    use super::*;
    use crate::DiceQuery;
    use crate::EPS;
    use crate::parser::parse_with;
    use crate::query::Labels;

    fn labels(names: &[&str]) -> Labels {
        Labels::Many(names.iter().map(std::string::ToString::to_string).collect())
    }

    /// tests/query.test.ts:508
    #[test]
    fn first_success_split_edge_cases_no_hits_no_crits_all_hits() -> T {
        let hit_crit = labels(&["hit", "crit"]);
        let crit = labels(&["crit"]);

        // Likely-miss case (very low hit chance): two swings in the split.
        let missy = parse_with("(d20 + 0 AC 25) * (1d8 + 4) crit (2d8 + 4)", 0.0)?;
        let dq_miss1 = DiceQuery::of(vec![missy.clone()]);
        let dq_miss2 = DiceQuery::of(vec![missy.clone(), missy]);
        let p_hm = dq_miss1.prob_at_least_one(&hit_crit);
        let [p_miss_success, p_miss_subset, p_miss_any, p_miss_none] =
            dq_miss2.first_success_split(&hit_crit, &crit, EPS)?;
        assert_close(p_miss_any, 1.0 - (1.0 - p_hm).powi(2), 12);
        assert_close(p_miss_subset + p_miss_success, p_miss_any, 12);
        assert_close(p_miss_any + p_miss_none, 1.0, 12);

        // No crits scenario: noCrit() on the builder (a parsed attack string crits on a natural 20).
        let no_crit = d20()
            .plus(8.0)?
            .ac(16.0)?
            .on_hit(roll_with(1.0, Some(SidesOrDie::Sides(8.0)), None)?.plus(4.0)?)?
            .no_crit()?
            .to_pmf(0.0)?;
        let dq_no_crit1 = DiceQuery::of(vec![no_crit.clone()]);
        let dq_no_crit2 = DiceQuery::of(vec![no_crit.clone(), no_crit]);
        let p_hn = dq_no_crit1.prob_at_least_one(&hit_crit);
        let p_cn = dq_no_crit1.prob_at_least_one(&crit);
        let [p_success_no_crit, p_subset_no_crit, _p_any_no_crit, _] =
            dq_no_crit2.first_success_split(&hit_crit, &crit, EPS)?;
        assert_close(p_cn, 0.0, 6);
        assert_close(p_subset_no_crit, 0.0, 6); // no crits -> subset ~ 0
        assert_close(p_success_no_crit, 1.0 - (1.0 - p_hn).powi(2), 12); // two-swing any

        // Very-high-hit case (pTotal ~ 1 per swing): again two swings for the split.
        let always = parse_with("(d20 + 20 AC 5) * (1d8 + 4) crit (2d8 + 4)", 0.0)?;
        let dq_always1 = DiceQuery::of(vec![always.clone()]);
        let dq_always2 = DiceQuery::of(vec![always.clone(), always]);
        let p_ha = dq_always1.prob_at_least_one(&hit_crit);
        let [_, _, p_always_any, p_always_none] =
            dq_always2.first_success_split(&hit_crit, &crit, EPS)?;
        assert!(p_ha > 0.99); // near-certain per swing
        assert!(p_always_any > 0.9999); // near-certain across two
        assert!(p_always_none < 1e-6);
        Ok(())
    }
}

mod roll_test {
    use super::*;
    use crate::parser::parse;

    /// src/builder/roll.test.ts:93
    #[test]
    fn should_handle_bless() -> T {
        let bless = d20()
            .plus(12.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .on_hit(d10().plus(6.0)?)?;
        assert_eq!(
            bless.to_expression()?,
            "(d20 + 12 + 1d4 AC 15) * (1d10 + 6) crit (2d10 + 6)"
        );
        assert_close(bless.to_pmf(0.0)?.mean(), 11.2, 1);

        let bless25 = d20()
            .plus(12.0)?
            .plus_roll(&d4())?
            .ac(25.0)?
            .on_hit(d10().plus(6.0)?)?;
        assert_eq!(
            bless25.to_expression()?,
            "(d20 + 12 + 1d4 AC 25) * (1d10 + 6) crit (2d10 + 6)"
        );
        assert_close(bless25.to_pmf(0.0)?.mean(), 6.3125, 1);
        Ok(())
    }

    /// src/builder/roll.test.ts:1039
    #[test]
    fn should_throw_for_nan_in_ac() -> T {
        assert_throws(
            roll_with(1.0, None, None)?.d(20.0)?.ac(f64::NAN),
            "Invalid NaN value for targetAC",
        );
        Ok(())
    }

    /// src/builder/roll.test.ts:1045
    #[test]
    fn should_throw_for_nan_in_dc() -> T {
        assert_throws(
            roll_with(1.0, None, None)?.d(20.0)?.dc(f64::NAN),
            "Invalid NaN value for saveDC",
        );
        Ok(())
    }

    /// src/builder/roll.test.ts:1148
    #[test]
    fn should_match_for_d20_11_ac_15_2kh1_1d12_plus_5_crit_2kh1_2d12_plus_5() -> T {
        let expr = "(d20 + 11 AC 15) * (2kh1(1d12) + 5) crit (2kh1(2d12) + 5)";
        let parsed = parse(expr)?;
        let hit = roll_with(1.0, Some(SidesOrDie::Sides(12.0)), None)?
            .keep_highest(2.0, 1.0)?
            .plus(5.0)?;
        let crit = roll_with(2.0, Some(SidesOrDie::Sides(12.0)), None)?
            .keep_highest(2.0, 1.0)?
            .plus(5.0)?;
        let check = d20().plus(11.0)?.ac(15.0)?;
        let built = check
            .on_hit(hit.clone())?
            .on_crit(&[Arg::Roll(crit)])?
            .to_pmf(0.0)?;
        let auto_crit_built = check.on_hit(hit)?.to_pmf(0.0)?;

        // Sanity: auto-crit default equals explicit crit.
        assert_close(auto_crit_built.mean(), built.mean(), 9);
        // Parser and builder should agree closely.
        assert_close(built.mean(), parsed.mean(), 4);
        // Compare full distributions (support + probabilities).
        let mut support: Vec<f64> = built.support().iter().map(|d| d.0).collect();
        support.extend(parsed.support().iter().map(|d| d.0));
        for v in support {
            assert_close(built.p_at(v), parsed.p_at(v), 12);
        }
        Ok(())
    }
}

mod scale_test {
    use super::*;
    use crate::builder::nodes::Rounding;
    use crate::builder::roll::sum_rolls;

    /// src/builder/scale.test.ts:118
    #[test]
    fn carries_resistance_through_a_full_attack_s_hit_and_crit_payloads_keeps_attribution() -> T {
        let zero = RollBuilder::zero;
        let hit = sum_rolls(&[
            zero().plus(3.0)?.plus_dice(1.0, &d(8.0)?)?,
            d6().scale_result(1.0, 2.0, Rounding::Floor)?,
        ])?;
        let crit = sum_rolls(&[
            zero().plus(3.0)?.plus_dice(2.0, &d(8.0)?)?,
            zero()
                .plus_dice(2.0, &d(6.0)?)?
                .scale_result(1.0, 2.0, Rounding::Floor)?,
        ])?;
        let attack = d20().ac(15.0)?.on_hit(hit)?.on_crit(&[Arg::Roll(crit)])?;
        assert_eq!(
            attack.to_expression()?,
            "(d20 AC 15) * (1d8 + 3 + ((1d6) // 2)) crit (2d8 + 3 + ((2d6) // 2))"
        );
        let pmf = attack.pmf()?;
        let total = |label: &str| -> f64 {
            pmf.map
                .values()
                .map(|b| b.count.get(label).copied().unwrap_or(0.0))
                .sum()
        };
        // 0.7 miss / 0.25 hit / 0.05 crit at AC 15 with a flat d20.
        assert_close(total("missNone"), 0.7, 6);
        assert_close(total("hit"), 0.25, 6);
        assert_close(total("crit"), 0.05, 6);
        Ok(())
    }
}

mod pooled_roll_attack {
    use super::*;

    /// tests/pooled-roll.test.ts:202
    #[test]
    fn should_work_in_an_attack_roll() -> T {
        let pool = d6().plus_roll(&d8())?.keep_highest_all(4.0, 3.0)?;
        let attack = d20().plus(5.0)?.ac(15.0)?.on_hit(pool)?;
        // The auto-crit doubles the dice inside the pool, then pools.
        assert_eq!(
            attack.to_expression()?,
            "(d20 + 5 AC 15) * (4kh3(1d8 + 1d6)) crit (4kh3(2d8 + 2d6))"
        );
        assert!(attack.to_pmf(0.0)?.mean() > 0.0);
        Ok(())
    }
}

mod subtracted_groups {
    use super::*;

    /// tests/subtracted-groups.test.ts:34 (the `.ac(15).onHit(d6).resolve().weights` part; `check.modifier` is in `small_tests.rs`)
    #[test]
    fn a_check_that_subtracts_a_die_with_its_own_flat_lands_at_the_exact_rate() -> T {
        let check = d20().plus(5.0)?.minus_roll(&rd(1.0, &d4())?.plus(1.0)?)?;
        // d20 + 5 - (d4 + 1) >= 15, natural 20 always hits (as a crit), natural 1 always misses.
        let weights = check.ac(15.0)?.on_hit(d6())?.resolve(0.0)?.weights;
        assert_close(weights.hit, 13.0 / 40.0, 12);
        assert_close(weights.crit, 1.0 / 20.0, 12);
        Ok(())
    }
}

mod builder_cache_keys {
    use super::*;

    /// tests/builder-cache-keys.test.ts:9 (the `d20.plus(value).dc(15)` line; the rest is in `small_tests.rs`)
    #[test]
    fn refuses_infinity_in_a_dc_check_bonus() -> T {
        for value in [f64::INFINITY, f64::NEG_INFINITY] {
            assert_throws(d20().plus(value).and_then(|r| r.dc(15.0)), "finite");
        }
        Ok(())
    }
}

mod d20_hit {
    use super::*;

    /// src/builder/d20.test.ts:105
    #[test]
    fn should_handle_d20_hit() -> T {
        let pmf = d20()
            .always_hits()?
            .on_hit_args(&[Arg::Num(1.0)])?
            .on_crit(&[Arg::Num(1.0)])?
            .on_miss(&[Arg::Num(1.0)])?
            .pmf()?;
        let crit_chance = 1.0 / 20.0;
        let hit_chance = 1.0 - crit_chance;
        assert_close(pmf.mean(), hit_chance * 1.0 + crit_chance * 1.0, 2);
        Ok(())
    }

    /// src/builder/d20.test.ts:114
    #[test]
    fn should_handle_autohit_with_complex_damage_2kh1_1d8_plus_1d8_plus_1d4_plus_5() -> T {
        let damage = d8()
            .keep_highest(2.0, 1.0)?
            .plus_roll(&d8())?
            .plus_roll(&d4())?
            .plus(5.0)?;
        let pmf = d20().always_hits()?.crit_on(20.0)?.on_hit(damage)?.pmf()?;
        assert_eq!(pmf.min(), 8.0);
        assert_eq!(pmf.max(), 45.0);
        assert_close(pmf.mean(), 18.41, 1);
        Ok(())
    }
}

mod prob_save {
    use super::*;

    fn d20_dc(modifier: f64, dc: f64) -> Result<RollBuilder, DiceError> {
        d20().plus(modifier)?.dc(dc)
    }

    fn six_d6_plus_3() -> Result<RollBuilder, DiceError> {
        roll_with(6.0, None, None)?.d6()?.plus(3.0)
    }

    fn fail(
        check: &RollBuilder,
        damage: RollBuilder,
    ) -> Result<crate::builder::save::SaveBuilder, DiceError> {
        check.on_save_failure_args(&[Arg::Roll(damage)])
    }

    /// src/builder/prob.test.ts:5
    #[test]
    fn should_compute_pmf_for_save_half_scenario() -> T {
        let builder = fail(&d20_dc(5.0, 15.0)?, six_d6_plus_3()?)?.save_half()?;
        let pmf = builder.resolve(0.0)?.pmf;
        let parsed = builder.to_pmf(0.0)?;
        assert_close(parsed.mean(), pmf.mean(), 5);
        assert!(pmf.mean() > 0.0);
        assert!(pmf.min() >= 0.0); // Can be 0 or half damage
        Ok(())
    }

    /// src/builder/prob.test.ts:20
    #[test]
    fn should_compute_pmf_for_no_save_half_scenario() -> T {
        let builder = fail(&d20_dc(5.0, 15.0)?, six_d6_plus_3()?)?;
        let pmf = builder.resolve(0.0)?.pmf;
        let parsed = builder.to_pmf(0.0)?;
        assert_close(parsed.mean(), pmf.mean(), 5);
        assert!(pmf.mean() > 0.0);
        assert!(pmf.min() >= 0.0);
        Ok(())
    }

    /// src/builder/prob.test.ts:35
    #[test]
    fn should_compute_pmf_for_normal_save_scenario() -> T {
        let damage = roll_with(4.0, None, None)?.d8()?.plus(2.0)?;
        let builder = fail(&d20_dc(3.0, 12.0)?, damage)?;
        let pmf = builder.resolve(0.0)?.pmf;
        assert!(pmf.mean() > 0.0);
        assert_close(builder.to_pmf(0.0)?.mean(), pmf.mean(), 5);
        Ok(())
    }

    /// src/builder/prob.test.ts:48
    #[test]
    fn should_handle_save_with_no_failure_effect() -> T {
        let builder = fail(&d20_dc(4.0, 10.0)?, flat(0.0)?)?;
        let pmf = builder.resolve(0.0)?.pmf;
        assert_eq!(pmf.mean(), 0.0); // No damage on success, no effect on failure
        assert_close(builder.to_pmf(0.0)?.mean(), pmf.mean(), 5);
        Ok(())
    }

    /// src/builder/prob.test.ts:60
    #[test]
    fn should_handle_save_half_with_zero_damage() -> T {
        let builder = fail(&d20_dc(2.0, 8.0)?, flat(0.0)?)?.save_half()?;
        let pmf = builder.resolve(0.0)?.pmf;
        assert_eq!(pmf.mean(), 0.0);
        assert_close(builder.to_pmf(0.0)?.mean(), pmf.mean(), 5);
        Ok(())
    }

    /// src/builder/prob.test.ts:77
    #[test]
    fn should_handle_different_save_outcomes_correctly() -> T {
        let damage = roll_with(2.0, None, None)?.d6()?;
        let check = d20_dc(3.0, 11.0)?;
        let normal_save = fail(&check, damage.clone())?;
        let half_save = fail(&check, damage)?.save_half()?;
        let normal_pmf = normal_save.resolve(0.0)?.pmf;
        let half_pmf = half_save.resolve(0.0)?.pmf;
        assert_ne!(half_pmf.mean(), normal_pmf.mean());
        assert_close(
            normal_save.to_pmf(0.0)?.mean(),
            normal_save.to_pmf(0.0)?.mean(),
            5,
        );
        assert_close(
            half_save.to_pmf(0.0)?.mean(),
            half_save.to_pmf(0.0)?.mean(),
            5,
        );
        assert_close(normal_save.to_pmf(0.0)?.mean(), 2.45, 5);
        assert_close(half_save.to_pmf(0.0)?.mean(), 4.5625, 5);
        Ok(())
    }
}
