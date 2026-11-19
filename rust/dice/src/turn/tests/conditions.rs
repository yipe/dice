//! `src/turn/conditions.test.ts`: 42 tests, 110 compat calls (all checked); 40 translated, 2 not.
//! (`retired.json` retires "more than 8 live flags is too-many-flags"; that test no longer exists in
//! the TS file, so there is nothing to keep.)
//!
//! Not translated:
//! - conditions.test.ts:122-126 (O22 "a Modifiers value is not a Grant"): `advantage()` is a
//!   `Modifiers`, which has no `Into<Effect>`; forgetting the lifetime is a compile error in Rust,
//!   so there is no runtime check to translate.
//! - conditions.test.ts:480-486 (guards "a grant on a verb that does not take one"): the TS casts a
//!   `Grant` to `RiderDamage`; `on_dice_match` / `on_any_miss` take `impl Into<RiderDamage>` and a
//!   `Grant` has no such conversion, so the call does not compile.

use super::cond_helpers::*;
use super::helpers::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::types::RollType;
use crate::error::DiceError;
use crate::turn::effects::{
    Lasting, TriggerSave, TriggerSaves, advantage, crit_on_hit, disadvantage, effect_spec,
    keep_best_damage,
};
use crate::turn::types::{
    Attack, AttackOptions, AttackTriggerOn, ConditionOn, DamageSource, MAX_TRIGGER_GROUPS, TurnSpec,
};
use crate::turn::{EffectPart, Turn, turn};
use std::collections::BTreeMap;

const FILE: &str = "src/turn/conditions.test.ts";

// Every oracle below: `d20+5` vs AC 12 (flat miss 0.30 / hit 0.65 / crit 0.05; advantage
// 0.09 / 0.8125 / 0.0975), `1d8+3` on a hit, `2d8+3` on a crit. Expected values are exact
// fractions from an independent state DP, pinned to 1e-9.
const FLAT: f64 = 5.475;
const ADVANTAGE: f64 = 7.26375;
const DISADVANTAGE: f64 = 0.4875 * 7.5 + 0.0025 * 12.0;

fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    sword_5_12()
}

fn swords(n: usize) -> Result<Vec<Attack>, DiceError> {
    (0..n).map(|_| Ok(atk(sword()?))).collect()
}

fn turn_of(n: usize) -> Result<Turn, DiceError> {
    turn(swords(n)?, 0.0)
}

fn adv_next() -> Lasting {
    advantage().until_next_attack().into()
}

fn adv_turn() -> Lasting {
    advantage().until_end_of_turn().into()
}

fn grant_part(lasting: Lasting) -> EffectPart {
    EffectPart::Grant(lasting)
}

fn damage_part(roll: crate::builder::roll::RollBuilder) -> EffectPart {
    EffectPart::Damage(DamageSource::Roll(roll))
}

fn d8_roll() -> crate::builder::roll::RollBuilder {
    d8()
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn spec_condition(on: AttackTriggerOn, grant: Lasting) -> crate::turn::types::ConditionSpec {
    cspec(ConditionOn::Attack(on), vec![effect_spec(&grant)])
}

// ---- O25 -----------------------------------------------------------------------------------------

const O25: &str = "O25: advantage on the next attack, two attacks — the smallest case";

fn o25() -> Result<Turn, DiceError> {
    turn_of(2)?.on_every_hit_with(adv_next(), every(opts(Some("next"), None, None)))
}

#[test]
fn o25_mean_is_12_202125_attack_2_has_advantage_exactly_when_attack_1_landed() -> T {
    let mut want = expect(
        FILE,
        &format!("{O25} > mean is 12.202125: attack 2 has advantage exactly when attack 1 landed"),
    );
    let t = o25()?;
    close(want.mean(&t), 12.202125, 9);
    close(want.mean(&t), FLAT + 0.3 * FLAT + 0.7 * ADVANTAGE, 9);
    close(want.pmf(&t).p_at(0.0), 0.09, 12);
    close(want.pmf(&t).mass(), 1.0, 12);
    want.done();
    Ok(())
}

#[test]
fn o25_fire_probability_of_the_condition_is_p_attack_1_landed_not_p_any_landing() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{O25} > fireProbability of the condition is P(attack 1 landed) = 0.70, not P(any landing)"
        ),
    );
    let t = o25()?;
    close(want.fire(&t, "next"), 0.7, 12);
    far(want.fire(&t, "next"), 0.91, 2);
    want.done();
    Ok(())
}

#[test]
fn o25_matches_a_brute_force_over_the_d20s_per_bin_within_1e_12() -> T {
    let mut want = expect(
        FILE,
        &format!("{O25} > matches a brute force over the d20s, per bin within 1e-12"),
    );
    let t = o25()?;
    let hit = rs(1.0, 8.0)?.plus(3.0)?.pmf()?;
    let crit = rs(2.0, 8.0)?.plus(3.0)?.pmf()?;
    let payload = |face: f64| -> Option<&Pmf> {
        if face == 20.0 {
            Some(&crit)
        } else if face + 5.0 >= 12.0 {
            Some(&hit)
        } else {
            None
        }
    };
    let zero = Pmf::delta(0.0, 0.0)?;
    // value (as float64 bits) -> mass
    let mut expected: BTreeMap<u64, f64> = BTreeMap::new();
    let mut add_pair = |first: Option<&Pmf>, second: Option<&Pmf>, weight: f64| {
        let a = first.unwrap_or(&zero);
        let b = second.unwrap_or(&zero);
        for x in a.support() {
            for y in b.support() {
                let value = x.0 + y.0;
                *expected.entry(value.to_bits()).or_insert(0.0) +=
                    weight * a.p_at(x.0) * b.p_at(y.0);
            }
        }
    };
    for first in 1..=20 {
        let one = payload(f64::from(first));
        if one.is_none() {
            for second in 1..=20 {
                add_pair(one, payload(f64::from(second)), 1.0 / 400.0);
            }
            continue;
        }
        for a in 1..=20 {
            for b in 1..=20 {
                add_pair(one, payload(f64::from(a.max(b))), 1.0 / 8000.0);
            }
        }
    }
    let mut worst = 0.0f64;
    let mut support: BTreeMap<u64, f64> = expected
        .keys()
        .map(|&bits| (bits, f64::from_bits(bits)))
        .collect();
    for value in want.pmf(&t).support() {
        support.insert(value.0.to_bits(), value.0);
    }
    for (bits, value) in support {
        let mass = expected.get(&bits).copied().unwrap_or(0.0);
        worst = worst.max((want.pmf(&t).p_at(value) - mass).abs());
    }
    assert!(worst < 1e-12, "worst {worst}");
    want.done();
    Ok(())
}

#[test]
fn o25_the_json_spec_is_the_same_turn() -> T {
    let mut want = expect(FILE, &format!("{O25} > the JSON spec is the same turn"));
    let t = o25()?;
    let from_spec = Turn::from_spec(
        TurnSpec {
            attacks: swords(2)?,
            conditions: Some(vec![spec_condition(AttackTriggerOn::EveryHit, adv_next())]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let from_pmf = want.pmf(&from_spec);
    let t_pmf = want.pmf(&t);
    assert!(pmf_max_diff(&from_pmf, &t_pmf) < 1e-15);
    assert_eq!(from_spec.condition_ids()?, vec!["condition 1".to_string()]);
    want.done();
    Ok(())
}

// ---- O22 -----------------------------------------------------------------------------------------

const O22: &str = "O22: advantage on the next attack, three attacks";

fn o22() -> Result<Turn, DiceError> {
    turn_of(3)?.on_every_hit_with(adv_next(), Default::default())
}

#[test]
fn o22_mean_is_19_19219625_and_p0_is_0_027() -> T {
    let mut want = expect(
        FILE,
        &format!("{O22} > mean is 19.19219625 and P(0) is 0.027"),
    );
    let t = o22()?;
    close(want.mean(&t), 19.19219625, 9);
    close(want.pmf(&t).p_at(0.0), 0.027, 12);
    want.done();
    Ok(())
}

#[test]
fn o22_the_reading_attack_consumes_the_flag_even_on_a_miss() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{O22} > the reading attack consumes the flag even on a miss: not the no-grant, sticky or all-advantage figure"
        ),
    );
    let t = o22()?;
    far(want.mean(&t), 3.0 * FLAT, 4); // 16.425: the grant never applied
    far(want.mean(&t), 19.3048875, 4); // the flag was never cleared by a miss
    far(want.mean(&t), 3.0 * ADVANTAGE, 4); // 21.79125: every attack had advantage
    want.done();
    Ok(())
}

// ---- O23 -----------------------------------------------------------------------------------------

const O23: &str = "O23: advantage for the turn on a 0.5 chance, retried on every landing";

fn o23() -> Result<Turn, DiceError> {
    turn_of(3)?.on_every_hit_with(adv_turn(), every(chance(0.5)))
}

#[test]
fn o23_mean_is_18_084065625() -> T {
    let mut want = expect(FILE, &format!("{O23} > mean is 18.084065625"));
    let t = o23()?;
    close(want.mean(&t), 18.084065625, 9);
    want.done();
    Ok(())
}

#[test]
fn o23_an_every_hit_grant_retries_not_the_one_attempt_figure() -> T {
    let mut want = expect(
        FILE,
        &format!("{O23} > an every-hit grant retries: not the one-attempt figure"),
    );
    let t = o23()?;
    far(want.mean(&t), 17.86494375, 4);
    want.done();
    Ok(())
}

#[test]
fn o23_a_save_contributes_its_p_fail_same_as_chance_0_6() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{O23} > a save contributes its P(fail): d20+2 vs DC 15 fails 0.6 of the time, same as chance 0.6"
        ),
    );
    let by_save = turn_of(3)?.on_every_hit_with(
        adv_turn(),
        every(crate::turn::effects::ConditionOptions {
            save: Some(TriggerSaves::One(TriggerSave::Dc(
                d20().plus(2.0)?.dc(15.0)?,
            ))),
            ..Default::default()
        }),
    )?;
    let by_chance = turn_of(3)?.on_every_hit_with(adv_turn(), every(chance(0.6)))?;
    let a = want.pmf(&by_save);
    let b = want.pmf(&by_chance);
    assert!(pmf_max_diff(&a, &b) < 1e-12);
    want.done();
    Ok(())
}

#[test]
fn o23_vs_ac_rebinds_the_attacks_and_leaves_the_saves_chance_alone() -> T {
    let mut want = expect(
        FILE,
        &format!("{O23} > vsAC rebinds the attacks and leaves the save's chance alone"),
    );
    let save = || -> Result<TriggerSaves, DiceError> {
        Ok(TriggerSaves::One(TriggerSave::Dc(
            d20().plus(2.0)?.dc(15.0)?,
        )))
    };
    let at12 = turn(
        vec![
            atk(attack_roll(5.0, 16.0, rs(1.0, 8.0)?.plus(3.0)?)?),
            atk(sword()?),
        ],
        0.0,
    )?
    .on_every_hit_with(
        adv_turn(),
        every(crate::turn::effects::ConditionOptions {
            save: Some(save()?),
            ..Default::default()
        }),
    )?
    .vs_ac(12.0)?;
    let direct = turn_of(2)?.on_every_hit_with(adv_turn(), every(chance(0.6)))?;
    let a = want.pmf(&at12);
    let b = want.pmf(&direct);
    assert!(pmf_max_diff(&a, &b) < 1e-12);
    want.done();
    Ok(())
}

// ---- O24 -----------------------------------------------------------------------------------------

const O24: &str = "O24: first-hit grant of advantage and crit-on-hit for the turn, chance 0.4";

fn o24() -> Result<Turn, DiceError> {
    turn_of(4)?.on_first_hit_with(
        advantage().crit_on_hit().until_end_of_turn(),
        first(chance(0.4)),
    )
}

#[test]
fn o24_mean_is_27_525774() -> T {
    let mut want = expect(FILE, &format!("{O24} > mean is 27.525774"));
    let t = o24()?;
    close(want.mean(&t), 27.525774, 9);
    want.done();
    Ok(())
}

#[test]
fn o24_not_the_base_turn_not_an_uncollapsed_crit_chance_not_a_retried_save() -> T {
    let mut want = expect(
        FILE,
        &format!("{O24} > not the base turn, not an uncollapsed crit chance, not a retried save"),
    );
    let t = o24()?;
    far(want.mean(&t), 4.0 * FLAT, 4); // 21.9: the grant never applied
    far(want.mean(&t), 23.7481365, 4); // P(crit) 0.0975: critOnHit did not collapse
    far(want.mean(&t), 29.45957664, 4); // every landing retried the save
    want.done();
    Ok(())
}

#[test]
fn o24_crit_on_hit_composes_with_advantage_p_crit_equals_p_land() -> T {
    let mut want = expect(
        FILE,
        &format!("{O24} > critOnHit composes with advantage: P(crit) = P(land) = 0.91"),
    );
    let certain = turn_of(2)?.on_first_hit_with(
        advantage().crit_on_hit().until_end_of_turn(),
        Default::default(),
    )?;
    // attack 2 crits on every landing (0.91) when attack 1 landed (0.70), else flat.
    close(
        want.mean(&certain),
        FLAT + 0.7 * 0.91 * 12.0 + 0.3 * FLAT,
        9,
    );
    want.done();
    Ok(())
}

#[test]
fn o24_the_groups_first_code_is_the_tried_state_a_passed_save_is_final() -> T {
    let mut want = expect(
        FILE,
        &format!("{O24} > the group's first code is the tried state: a passed save is final"),
    );
    let t = o24()?;
    want.mean(&t); // `inspectTurn` resolves the turn through its mean reader
    assert_eq!(t.inspect_turn()?.0, 1);
    want.done();
    Ok(())
}

// ---- O26 -----------------------------------------------------------------------------------------

const O26: &str = "O26: two conditions, two lifetimes, one walk";

fn o26() -> Result<Turn, DiceError> {
    turn_of(3)?
        .on_every_hit_with(adv_next(), Default::default())?
        .on_every_hit_with(adv_turn(), every(chance(0.5)))
}

#[test]
fn o26_mean_is_19_248541875_above_both_single_conditions_and_below_the_all_advantage_bound() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{O26} > mean is 19.248541875, above both single conditions and below the all-advantage bound"
        ),
    );
    let t = o26()?;
    close(want.mean(&t), 19.248541875, 9);
    assert!(want.mean(&t) > 19.19219625);
    assert!(want.mean(&t) > 18.084065625);
    assert!(want.mean(&t) < 3.0 * ADVANTAGE);
    close(want.pmf(&t).p_at(0.0), 0.027, 12);
    want.done();
    Ok(())
}

#[test]
fn o26_the_state_count_is_the_four_flag_combinations_at_most_then_collapses() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{O26} > the state count is the four flag combinations at most, then collapses once nothing reads them"
        ),
    );
    let t = o26()?;
    want.mean(&t);
    let (group_count, state_counts) = t.inspect_turn()?;
    assert_eq!(group_count, 0);
    assert_eq!(state_counts, vec![3, 4, 1]);
    want.done();
    Ok(())
}

// ---- O28 -----------------------------------------------------------------------------------------

const O28: &str = "O28: both save branches";

fn with_save() -> Result<Turn, DiceError> {
    turn_of(4)?.on_first_hit_with(
        advantage().until_end_of_turn(),
        first(crate::turn::effects::ConditionOptions {
            on_save: Some(vec![adv_next()]),
            ..chance(0.4)
        }),
    )
}

#[test]
fn o28_mean_is_24_79240875() -> T {
    let mut want = expect(FILE, &format!("{O28} > mean is 24.79240875"));
    let t = with_save()?;
    close(want.mean(&t), 24.79240875, 9);
    want.done();
    Ok(())
}

#[test]
fn o28_dropping_the_success_branch_is_the_fail_only_turn_23_7481365() -> T {
    let mut want = expect(
        FILE,
        &format!("{O28} > dropping the success branch is the fail-only turn, 23.7481365"),
    );
    let with_save = with_save()?;
    let fail_only =
        turn_of(4)?.on_first_hit_with(advantage().until_end_of_turn(), first(chance(0.4)))?;
    close(want.mean(&fail_only), 23.7481365, 9);
    far(want.mean(&with_save), 23.7481365, 4);
    want.done();
    Ok(())
}

#[test]
fn o28_once_an_end_of_turn_grant_is_in_force_later_landings_roll_no_save() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{O28} > once an end-of-turn grant is in force, later landings roll no save and apply no onSave grant"
        ),
    );
    let t = turn_of(3)?.on_every_hit_with(
        adv_turn(),
        every(crate::turn::effects::ConditionOptions {
            on_save: Some(vec![disadvantage().until_next_attack().into()]),
            ..chance(0.5)
        }),
    )?;
    close(want.mean(&t), 17.0510625, 9);
    // Re-rolling the save while advantage is in force would cancel it half the time.
    far(want.mean(&t), 16.7662040625, 4);
    want.done();
    Ok(())
}

// ---- a chance gates grants only, never damage ----------------------------------------------------

const GATES: &str = "a chance gates grants only, never damage";

#[test]
fn a_damage_rider_in_the_same_call_fires_on_every_first_landing_the_split_call_is_the_same_turn()
-> T {
    let mut want = expect(
        FILE,
        &format!(
            "{GATES} > a damage rider in the same call fires on every first landing; the split call is the same turn"
        ),
    );
    let together = turn_of(2)?.on_first_hit_with(
        vec![damage_part(d8_roll()), grant_part(adv_turn())],
        first(opts(Some("extra"), None, Some(0.5))),
    )?;
    let apart = turn_of(2)?
        .on_first_hit_with(d8_roll(), Default::default())?
        .on_first_hit_with(adv_turn(), first(chance(0.5)))?;
    close(want.fire(&together, "extra"), 0.91, 12);
    let condition_id = together.condition_ids()?[0].clone();
    close(want.fire(&together, &condition_id), 0.35, 12);
    let a = want.pmf(&together);
    let b = want.pmf(&apart);
    assert!(pmf_max_diff(&a, &b) < 1e-12);
    want.done();
    Ok(())
}

#[test]
fn o29_the_rider_doubles_on_a_crit_like_any_attack_damage_mean_is_15_9635625() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{GATES} > O29: the rider doubles on a crit like any attack damage; mean is 15.9635625"
        ),
    );
    let t = turn_of(2)?.on_first_hit_with(
        vec![damage_part(d8_roll()), grant_part(adv_turn())],
        first(chance(0.5)),
    )?;
    close(want.mean(&t), 15.9635625, 9);
    // A result here means the d8 rider was gated by the save, like the grant is.
    far(want.mean(&t), 13.7698125, 4);
    // A result here means the rider did not double its dice on a crit.
    far(want.mean(&t), 15.6710625, 4);
    want.done();
    Ok(())
}

// ---- O30 -----------------------------------------------------------------------------------------

#[test]
fn o30_mean_is_12_67501875_attack_2_lands_0_973_of_the_time_in_the_granted_state_not_0_91() -> T {
    let mut want = expect(
        FILE,
        "O30: a granted advantage rolls three dice when the attacker says so > mean is 12.67501875: attack 2 lands 0.973 of the time in the granted state, not 0.91",
    );
    let three = d20()
        .plus(5.0)?
        .ac(12.0)?
        .three_dice_advantage()?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?;
    let t = turn(vec![atk(three.clone()), atk(three)], 0.0)?
        .on_every_hit_with(adv_next(), Default::default())?;
    close(want.mean(&t), 12.67501875, 9);
    far(want.mean(&t), 12.202125, 4);
    want.done();
    Ok(())
}

// ---- semantics (§7.2) ----------------------------------------------------------------------------

const SEMANTICS: &str = "semantics (§7.2)";

#[test]
fn any_crit_attack_2_has_advantage_only_after_a_crit() -> T {
    let mut want = expect(
        FILE,
        &format!("{SEMANTICS} > any-crit: attack 2 has advantage only after a crit"),
    );
    let t = turn_of(2)?.on_any_crit_with(adv_turn(), Default::default())?;
    close(want.mean(&t), FLAT + 0.05 * ADVANTAGE + 0.95 * FLAT, 9);
    want.done();
    Ok(())
}

#[test]
fn first_miss_json_a_miss_gives_the_next_attack_disadvantage() -> T {
    let mut want = expect(
        FILE,
        &format!("{SEMANTICS} > first-miss (JSON): a miss gives the next attack disadvantage"),
    );
    let t = Turn::from_spec(
        TurnSpec {
            attacks: swords(2)?,
            conditions: Some(vec![spec_condition(
                AttackTriggerOn::FirstMiss,
                disadvantage().until_next_attack().into(),
            )]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    close(want.mean(&t), FLAT + 0.3 * DISADVANTAGE + 0.7 * FLAT, 9);
    want.done();
    Ok(())
}

#[test]
fn advantage_and_disadvantage_in_the_same_state_cancel_to_a_flat_roll() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SEMANTICS} > advantage and disadvantage in the same state cancel to a flat roll"
        ),
    );
    let t = turn_of(2)?.on_every_hit_with(
        vec![
            grant_part(adv_next()),
            grant_part(disadvantage().until_next_attack().into()),
        ],
        Default::default(),
    )?;
    close(want.mean(&t), 2.0 * FLAT, 9);
    want.done();
    Ok(())
}

#[test]
fn a_next_attack_flag_scoped_with_to_is_consumed_only_by_the_attack_it_names() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SEMANTICS} > a next-attack flag scoped with `to` is consumed only by the attack it names"
        ),
    );
    let t = turn_of(3)?.on_every_hit_with(
        advantage().until_next_attack().to(&["attack 3"]),
        every(of(&["attack 1"])),
    )?;
    close(want.mean(&t), 2.0 * FLAT + 0.7 * ADVANTAGE + 0.3 * FLAT, 9);
    want.done();
    Ok(())
}

#[test]
fn miss_damage_is_not_a_landing_a_half_on_miss_attack_sets_no_flag_when_it_misses() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SEMANTICS} > miss damage is not a landing: a half-on-miss attack sets no flag when it misses"
        ),
    );
    let halves = sword()?.half_on_miss()?;
    let t = turn(vec![atk(halves.clone()), atk(halves)], 0.0)?
        .on_every_hit_with(adv_next(), every(opts(Some("next"), None, None)))?;
    close(want.fire(&t, "next"), 0.7, 12);
    want.done();
    Ok(())
}

#[test]
fn miss_damage_is_not_a_landing_an_on_miss_attack_sets_no_flag_when_it_misses() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SEMANTICS} > miss damage is not a landing: an onMiss attack sets no flag when it misses"
        ),
    );
    let based = sword()?;
    let misses = based.on_miss(&[Arg::Roll(d4())])?;
    let t = turn(vec![atk(misses.clone()), atk(misses.clone())], 0.0)?
        .on_every_hit_with(adv_next(), every(opts(Some("next"), None, None)))?;
    close(want.fire(&t, "next"), 0.7, 12);

    // PMF level, one attack: the grant only reads a hit/crit, so its "hit" slice matches
    // the same attack without onMiss damage, and the grant leaves missDamage untouched.
    let single =
        turn(vec![atk(misses.clone())], 0.0)?.on_every_hit_with(adv_next(), Default::default())?;
    let plain_single =
        turn(vec![atk(based)], 0.0)?.on_every_hit_with(adv_next(), Default::default())?;
    let a = want.pmf(&single);
    let b = want.pmf(&plain_single);
    assert!(pmf_max_diff(&a.filter_outcome("hit"), &b.filter_outcome("hit")) < 1e-12);
    let a = want.pmf(&single);
    let b = want.pmf(&turn(vec![atk(misses)], 0.0)?);
    assert!(
        pmf_max_diff(
            &a.filter_outcome("missDamage"),
            &b.filter_outcome("missDamage")
        ) < 1e-12
    );
    want.done();
    Ok(())
}

#[test]
fn an_end_of_turn_grant_for_one_set_of_attacks_and_its_opposite_for_another_come_from_the_same_save()
-> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SEMANTICS} > an end-of-turn grant for one set of attacks and its opposite for another come from the same save"
        ),
    );
    let heavy = sword()?;
    let shot = attack_roll(5.0, 12.0, rs(1.0, 6.0)?.plus(3.0)?)?;
    let tagged = |tag: &str| AttackOptions {
        tag: Some(tag.to_string()),
        ..AttackOptions::default()
    };
    let t = turn(vec![], 0.0)?
        .attack_with(heavy.clone(), tagged("melee"))?
        .attack_with(shot.clone(), tagged("ranged"))?
        .attack_with(heavy.clone(), tagged("melee"))?
        .on_every_hit_with(
            vec![
                grant_part(advantage().until_end_of_turn().to(&["melee"]).into()),
                grant_part(disadvantage().until_end_of_turn().to(&["ranged"]).into()),
            ],
            every(opts(None, Some(&["attack 1"]), Some(0.5))),
        )?;

    let first = heavy.pmf()?;
    let landed = first
        .filter_outcome("hit")
        .add(&first.filter_outcome("crit"));
    let applied = landed.scale_mass(0.5);
    let not_applied = first
        .filter_outcome("missNone")
        .add(&landed.scale_mass(0.5));
    let variant = |source: &crate::builder::attack::AttackBuilder,
                   roll_type: RollType|
     -> Result<Pmf, DiceError> {
        source
            .with_check(|mut check| {
                check.roll_type = roll_type;
                check
            })?
            .pmf()
    };
    // Raw convolution: the branches are sub-mass and must stay that way.
    let expected = applied
        .convolve(&variant(&shot, RollType::Disadvantage)?, None, true)
        .convolve(&variant(&heavy, RollType::Advantage)?, None, true)
        .add(
            &not_applied
                .convolve(&shot.pmf()?, None, true)
                .convolve(&heavy.pmf()?, None, true),
        );
    let actual = want.pmf(&t);
    assert!(pmf_max_diff(&actual, &expected) < 1e-12);
    want.done();
    Ok(())
}

#[test]
fn a_to_naming_an_id_the_turn_lacks_is_unknown_id_one_with_nothing_after_the_sources_is_a_no_op()
-> T {
    assert_eq!(
        code_of(turn_of(2)?.on_every_hit_with(
            advantage().until_next_attack().to(&["nowhere"]),
            Default::default()
        )),
        "unknown-id"
    );
    // Its number is pinned in tests/turn-flags.test.ts: the turn equals the one without the effect.
    assert_eq!(
        code_of(turn_of(2)?.on_every_hit_with(
            advantage().until_next_attack().to(&["attack 1"]),
            every(of(&["attack 2"]))
        )),
        "none"
    );
    Ok(())
}

#[test]
fn a_flag_no_step_reads_leaves_the_state_count_unchanged() -> T {
    let mut want = expect(
        FILE,
        &format!("{SEMANTICS} > a flag no step reads leaves the state count unchanged"),
    );
    // The last attack's grant has no later attack roll to read it. (A grant from an
    // any-miss reroll is refused instead: in play the reroll lands mid-turn.)
    let musket = attack_roll(9.0, 15.0, rs(1.0, 12.0)?.plus_dice(1.0, &d4())?.plus(18.0)?)?;
    let base = turn(vec![atk(musket.clone()), atk(musket)], 0.0)?
        .on_first_hit_with(rs(1.0, 10.0)?, Default::default())?;
    let unread = base.on_every_hit_with(adv_next(), every(of(&["attack 2"])))?;
    want.mean(&unread);
    let unread_counts = unread.inspect_turn()?.1;
    want.mean(&base);
    let base_counts = base.inspect_turn()?.1;
    assert_eq!(unread_counts, base_counts);
    close(want.mean(&unread), want.mean(&base), 12);
    want.done();
    Ok(())
}

// ---- composition with riders, rerolls and substitutes --------------------------------------------

const COMPOSITION: &str = "composition with riders, rerolls and substitutes";

#[test]
fn a_first_hit_damage_rider_and_a_first_hit_grant_over_the_same_attacks_share_one_group() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{COMPOSITION} > a first-hit damage rider and a first-hit grant over the same attacks share one group"
        ),
    );
    let t = turn_of(2)?
        .on_first_hit_with(rs(3.0, 6.0)?, Default::default())?
        .on_first_hit_with(adv_turn(), first(chance(0.5)))?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    want.done();
    Ok(())
}

#[test]
fn an_every_hit_grant_allocates_no_group_of_its_own() -> T {
    let mut want = expect(
        FILE,
        &format!("{COMPOSITION} > an every-hit grant allocates no group of its own"),
    );
    let t = turn_of(2)?
        .on_first_hit_with(rs(3.0, 6.0)?, Default::default())?
        .on_every_hit_with(adv_next(), Default::default())?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    want.done();
    Ok(())
}

#[test]
fn all_max_trigger_groups_groups_plus_condition_flags_still_build_and_resolve() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{COMPOSITION} > all MAX_TRIGGER_GROUPS groups plus condition flags still build and resolve: flags are not counted against the group limit"
        ),
    );
    // 4 attacks, 9 distinct non-empty subsets of their ids as `of` — enough distinct
    // trigger source sets to fill the group budget without the state blow-up of 9
    // independently-drawn attacks (each first-hit group roughly doubles the walk).
    let attack_ids = ["attack 1", "attack 2", "attack 3", "attack 4"];
    let mut subsets: Vec<Vec<&str>> = Vec::new();
    for mask in 1..(1u32 << attack_ids.len()) {
        subsets.push(
            attack_ids
                .iter()
                .enumerate()
                .filter(|(bit, _)| mask & (1 << bit) != 0)
                .map(|(_, id)| *id)
                .collect(),
        );
    }
    let group_sets = &subsets[..MAX_TRIGGER_GROUPS];
    let flag_set_a = &subsets[MAX_TRIGGER_GROUPS];
    let flag_set_b = &subsets[MAX_TRIGGER_GROUPS + 1];

    let mut t = turn_of(4)?;
    for (i, of_set) in group_sets.iter().enumerate() {
        t = t.on_first_hit_with(
            rs(1.0, 4.0)?,
            first(opts(Some(&format!("group {}", i + 1)), Some(of_set), None)),
        )?;
    }
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, MAX_TRIGGER_GROUPS);

    // every-hit grants never call groupOf (GRANT_TRIGGERS['every-hit'].readsGroup is
    // false), so two more, each over a source set none of the groups above used, must
    // not grow the group count or throw.
    let with_flags = t
        .on_every_hit_with(adv_next(), every(of(flag_set_a)))?
        .on_every_hit_with(disadvantage().until_end_of_turn(), every(of(flag_set_b)))?;
    want.mean(&with_flags);
    want.mean(&with_flags);
    assert_eq!(with_flags.inspect_turn()?.0, MAX_TRIGGER_GROUPS);

    // Proof this would fail if flags were counted: a first-hit RIDER (which does read
    // a group) over that same untried source set, once the budget is already full,
    // throws too-many-groups — the error a counted flag would trigger instead.
    let tenth = t
        .on_first_hit_with(
            rs(1.0, 4.0)?,
            first(opts(Some("tenth"), Some(flag_set_a), None)),
        )
        .and_then(|t| t.mean());
    assert_eq!(code_of(tenth), "too-many-groups");
    want.done();
    Ok(())
}

#[test]
fn a_first_miss_reroll_reads_a_turn_flag_set_by_an_earlier_attack() -> T {
    let mut want = expect(
        FILE,
        &format!("{COMPOSITION} > a first-miss reroll reads a turn flag set by an earlier attack"),
    );
    let t = turn_of(2)?
        .on_every_hit_with(adv_turn(), every(of(&["attack 1"])))?
        .on_first_miss_with(
            sword()?,
            crate::turn::types::RiderOptions {
                of: Some(strings(&["attack 2"])),
                ..Default::default()
            },
        )?;
    // attack 1 lands (0.7): attack 2 and its reroll both roll with advantage.
    let expected = FLAT + 0.7 * (ADVANTAGE + 0.09 * ADVANTAGE) + 0.3 * (FLAT + 0.3 * FLAT);
    close(want.mean(&t), expected, 9);
    want.done();
    Ok(())
}

#[test]
fn a_substitute_runs_on_whichever_variant_the_flags_selected() -> T {
    let mut want = expect(
        FILE,
        &format!("{COMPOSITION} > a substitute runs on whichever variant the flags selected"),
    );
    let three = turn_of(3)?;
    let granted = three.on_every_hit_with(adv_next(), Default::default())?;
    let all_advantage = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?;
    let bound = turn(
        vec![
            atk(all_advantage.clone()),
            atk(all_advantage.clone()),
            atk(all_advantage),
        ],
        0.0,
    )?;
    let granted_best = granted.on_first_hit_transform(keep_best_damage(), Default::default())?;
    let gain = want.mean(&granted_best) - want.mean(&granted);
    let bound_best = bound.on_first_hit_transform(keep_best_damage(), Default::default())?;
    let bound_gain = want.mean(&bound_best) - want.mean(&bound);
    assert!(gain > 0.0);
    assert!(gain < bound_gain);
    want.done();
    Ok(())
}

// ---- guards --------------------------------------------------------------------------------------

const GUARDS: &str = "guards";

#[test]
fn a_grant_read_by_an_attack_with_no_check_to_re_derive_is_no_rebindable_source_to_scopes_it_away()
-> T {
    let mut want = expect(
        FILE,
        &format!(
            "{GUARDS} > a grant read by an attack with no check to re-derive is no-rebindable-source; `to` scopes it away"
        ),
    );
    let bare = sword()?.pmf()?;
    let refused = turn(vec![atk(sword()?), atk(bare.clone())], 0.0)?
        .on_every_hit_with(adv_next(), Default::default());
    assert_eq!(code_of(refused), "no-rebindable-source");
    let scoped = turn(vec![atk(sword()?), atk(bare), atk(sword()?)], 0.0)?.on_every_hit_with(
        advantage().until_end_of_turn().to(&["attack 3"]),
        Default::default(),
    )?;
    close(
        want.mean(&scoped),
        2.0 * FLAT + (1.0 - 0.3 * 0.3) * ADVANTAGE + 0.09 * FLAT,
        9,
    );
    want.done();
    Ok(())
}

#[test]
fn a_chance_outside_0_1_is_a_range_error() -> T {
    let refused = turn_of(2)?.on_every_hit_with(adv_turn(), every(chance(1.5)));
    assert!(matches!(refused, Err(DiceError::Range(_))));
    let mut condition = spec_condition(AttackTriggerOn::EveryHit, adv_turn());
    condition.chance = Some(-0.1);
    let refused = Turn::from_spec(
        TurnSpec {
            attacks: swords(2)?,
            conditions: Some(vec![condition]),
            ..TurnSpec::default()
        },
        0.0,
    );
    assert!(matches!(refused, Err(DiceError::Range(_))));
    Ok(())
}

#[test]
fn chance_with_save_or_on_save_with_neither_is_a_plain_error() -> T {
    let both = turn_of(2)?.on_every_hit_with(
        adv_turn(),
        every(crate::turn::effects::ConditionOptions {
            save: Some(TriggerSaves::One(TriggerSave::Dc(
                d20().plus(2.0)?.dc(15.0)?,
            ))),
            ..chance(0.5)
        }),
    );
    assert!(code_of(both).starts_with("Error"));
    let neither = turn_of(2)?.on_every_hit_with(
        adv_turn(),
        every(crate::turn::effects::ConditionOptions {
            on_save: Some(vec![adv_next()]),
            ..Default::default()
        }),
    );
    assert!(code_of(neither).starts_with("Error"));
    Ok(())
}

#[test]
fn crit_on_hit_also_starts_a_grant() -> T {
    let mut want = expect(FILE, &format!("{GUARDS} > critOnHit() also starts a grant"));
    let t = turn_of(2)?.on_first_hit_with(crit_on_hit().until_end_of_turn(), Default::default())?;
    // attack 2 crits on every landing (0.70) when attack 1 landed (0.70).
    close(want.mean(&t), FLAT + 0.7 * 0.7 * 12.0 + 0.3 * FLAT, 9);
    want.done();
    Ok(())
}
