//! `src/turn/first-miss-reroll.test.ts`: 38 tests (the two `it.each` loops are one Rust test each: 29 `#[test]`s), 0 compat calls (no recorded entry).
//!
//! The TS pins each mean against the number worked out by exact enumeration and against the
//! brute-force oracle (`tests/oracle/bruteForce.ts`). The pins are asserted here as in the TS, and
//! the oracle's own numbers (mean, rerolls spent, every PMF bin, each source's marginal) are the
//! data of `oracle.rs`, produced by running that oracle on the same `SyntheticTurn` literals.
//!
//! Not translated:
//! - `first-miss-reroll.test.ts:401`: `mode: "double"` (an unknown mode string): `MissRerollMode` has
//!   only `Reroll` and `AddD20`, so the value cannot be written in Rust.
//! - `first-miss-reroll.test.ts:301`: the JSON round trip of `spec.substitutes` (`JSON.parse(JSON.stringify(..))`):
//!   `TurnSpec` has no JSON form in Rust; the test keeps the cloned spec, the spelling `Turn::from`
//!   takes either way.

mod oracle;

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::{AttackBuilder, Grants};
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::types::MissRerollMode;
use crate::common::Rng;
use crate::dnd5e::vex;
use crate::error::DiceError;
use crate::turn::context::{ContextualSource, RollUnder, RowCheck, RowContext};
use crate::turn::effects::{FirstHitOptions, keep_best_damage};
use crate::turn::types::{
    ArcContextual, Attack, AttackOptions, AttackTriggerOn, ConditionOn, ConditionSpec, EffectSpec,
    GrantSpec, GrantUntil, Rider, RiderDamage, RiderDamageSpec, Source, SubstituteKind,
    SubstituteOn, SubstitutePolicy, SubstituteSpec, Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use std::collections::BTreeSet;
use std::sync::Arc;

const TOLERANCE: f64 = 1e-12;

fn r7() -> Result<AttackBuilder, DiceError> {
    attack_roll(7.0, 16.0, rs(1.0, 8.0)?.plus(4.0)?)
}
fn r6() -> Result<AttackBuilder, DiceError> {
    attack_roll(6.0, 16.0, rs(1.0, 10.0)?.plus(3.0)?)
}
fn r5() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 15.0, rs(1.0, 8.0)?.plus(4.0)?)
}

fn atks(attacks: &[&AttackBuilder]) -> Vec<Attack> {
    attacks
        .iter()
        .map(|attack| atk((*attack).clone()))
        .collect()
}

/// `turn.rerollFirstMiss({ id })`.
fn reroll(t: &Turn, id: &str) -> Result<Turn, DiceError> {
    t.reroll_first_miss(Some(id), None, None)
}

/// `turn.rerollFirstMiss({ id, mode: "add-d20" })`.
fn add_d20(t: &Turn, id: &str) -> Result<Turn, DiceError> {
    t.reroll_first_miss(Some(id), None, Some(MissRerollMode::AddD20))
}

/// The library's mean and fire probabilities against the pin and the oracle's, all at 1e-12.
#[track_caller]
fn expect_pinned(t: &Turn, key: &str, mean: f64, fires: &[f64], ids: &[&str]) -> T {
    let oracle = oracle::get(key);
    let got = t.mean()?;
    close(got, mean, 11);
    assert!(
        (got - mean).abs() <= TOLERANCE,
        "{key}: mean {got} vs pin {mean}"
    );
    assert!(
        (oracle.mean - mean).abs() <= TOLERANCE,
        "{key}: oracle mean {} vs pin {mean}",
        oracle.mean
    );
    for (i, fire) in fires.iter().enumerate() {
        let fired = t.fire_probability(ids[i])?;
        assert!(
            (fired - fire).abs() <= TOLERANCE,
            "{key}: fire {} {fired} vs {fire}",
            ids[i]
        );
        assert!(
            (oracle.fires[i] - fire).abs() <= TOLERANCE,
            "{key}: oracle fire {i}"
        );
    }
    let pmf = t.pmf()?;
    expect_pmf_agrees(&pmf, oracle.pmf, key);
    Ok(())
}

#[track_caller]
fn expect_pmf_agrees(pmf: &Pmf, expected: &[(i64, f64)], what: &str) {
    let mut support: BTreeSet<i64> = pmf.support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.iter().map(|(value, _)| *value));
    for value in support {
        let want = expected
            .iter()
            .find(|(v, _)| *v == value)
            .map_or(0.0, |(_, p)| *p);
        let got = pmf.p_at(value as f64);
        assert!(
            (got - want).abs() <= TOLERANCE,
            "{what}: pmf at {value}: {got} vs {want}"
        );
    }
}

// ---- rerollFirstMiss: pinned means, each against the oracle ---------------------------------------

#[test]
fn t1_two_7_swings_sneak_attack_on_the_first_landing_one_reroll_over_both() -> T {
    let base = turn(atks(&[&r7()?, &r7()?]), 0.0)?
        .on_first_hit_with(rs(2.0, 6.0)?, FirstHitOptions::default())?;
    expect_pinned(&base, "T1 base", 17.02, &[], &[])?;
    expect_pinned(
        &reroll(&base, "luck")?,
        "T1 reroll",
        21.156,
        &[0.64],
        &["luck"],
    )
}

#[test]
fn t2_add_d20_over_an_advantage_swing_and_a_flat_one_both_with_a_1d4_to_hit() -> T {
    let damage = rs(1.0, 8.0)?.plus(4.0)?;
    let adv = d20()
        .plus(5.0)?
        .plus_dice(1.0, &d4())?
        .with_advantage()?
        .ac(17.0)?
        .on_hit(damage.clone())?;
    let flat = d20()
        .plus(5.0)?
        .plus_dice(1.0, &d4())?
        .ac(17.0)?
        .on_hit(damage)?;
    expect_pinned(
        &add_d20(&turn(atks(&[&adv, &flat]), 0.0)?, "lucky")?,
        "T2",
        15.1580953125,
        &[0.53065625],
        &["lucky"],
    )
}

#[test]
fn t3_three_swings_heroic_inspiration_then_2014_lucky_each_takes_a_different_miss() -> T {
    let r6 = r6()?;
    let t = turn(atks(&[&r6, &r6, &r6]), 0.0)?;
    expect_pinned(
        &add_d20(&reroll(&t, "hi")?, "lucky")?,
        "T3 both",
        21.08143125,
        &[0.833625, 0.42525],
        &["hi", "lucky"],
    )?;
    expect_pinned(
        &reroll(&t, "hi")?,
        "T3 hi",
        18.97644375,
        &[0.833625],
        &["hi"],
    )
}

#[test]
fn t4_a_disadvantage_swing_reroll_keeps_the_higher_die_in_play_add_d20_keeps_the_best_of_all_three()
-> T {
    let dis = d20()
        .plus(6.0)?
        .with_disadvantage()?
        .ac(14.0)?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)?;
    let t = turn(atks(&[&dis]), 0.0)?;
    expect_pinned(&reroll(&t, "hi")?, "T4 reroll", 6.12425, &[0.5775], &["hi"])?;
    expect_pinned(
        &add_d20(&t, "lucky")?,
        "T4 add-d20",
        8.426375,
        &[0.5775],
        &["lucky"],
    )
}

#[test]
fn t5_a_rerolled_hit_lands_vex_like_any_hit() -> T {
    let vexed = r5()?.on_every_hit_with(Grants::One(vex().into()), None)?;
    expect_pinned(
        &reroll(&turn(atks(&[&vexed, &r5()?]), 0.0)?, "hi")?,
        "T5",
        14.39894375,
        &[0.561375],
        &["hi"],
    )
}

#[test]
fn t6_a_reroll_that_watches_only_attack_2_never_spends_on_attack_1() -> T {
    let t = turn(atks(&[&r7()?, &r7()?]), 0.0)?.reroll_first_miss(
        Some("hi"),
        Some(&["attack 2"]),
        None,
    )?;
    expect_pinned(&t, "T6", 12.78, &[0.4], &["hi"])
}

#[test]
fn t7_a_rerolled_landing_spends_an_unspent_savage_attacker_like_any_landing() -> T {
    let savage = turn(atks(&[&r7()?, &r7()?]), 0.0)?
        .on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())?;
    expect_pinned(&savage, "T7 base", 11.78982421875, &[], &[])?;
    expect_pinned(
        &reroll(&savage, "hi")?,
        "T7 reroll",
        15.32808984375,
        &[0.64],
        &["hi"],
    )
}

// ---- rerollFirstMiss: the mixture shapes dpr reuses ------------------------------------------------

#[test]
fn the_mixture_shapes_dpr_reuses() -> T {
    let row = d20()
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(rs(1.0, 4.0)?.plus(7.0)?)?;
    let vex_row = row.on_every_hit_with(Grants::One(vex().into()), None)?;
    // (n, vexed, mean, none, fire)
    let cases = [
        (1usize, false, 7.7575, 5.35, 0.45),
        (2, false, 14.431625, 10.7, 0.6975),
        (2, true, 15.67318125, 12.0585, 0.561375),
        (3, false, 20.50989375, 16.05, 0.833625),
        (3, true, 23.495711234375, 19.10322875, 0.6501965625),
    ];
    for (n, vexed, mean, none, fire) in cases {
        let rows: Vec<Attack> = (0..n)
            .map(|_| atk(if vexed { vex_row.clone() } else { row.clone() }))
            .collect();
        let key = |what: &str| format!("mixture {n} {vexed} {what}");
        expect_pinned(&turn(rows.clone(), 0.0)?, &key("none"), none, &[], &[])?;
        expect_pinned(
            &reroll(&turn(rows, 0.0)?, "hi")?,
            &key("reroll"),
            mean,
            &[fire],
            &["hi"],
        )?;
    }
    Ok(())
}

// ---- rerollFirstMiss: cross-checks -----------------------------------------------------------------

#[derive(Clone, Copy)]
enum Adv {
    Flat,
    Advantage,
    Disadvantage,
}

fn sword(kind: Adv) -> Result<AttackBuilder, DiceError> {
    let base = d20().plus(7.0)?;
    let rolled = match kind {
        Adv::Advantage => base.with_advantage()?,
        Adv::Disadvantage => base.with_disadvantage()?,
        Adv::Flat => base,
    };
    rolled.ac(16.0)?.on_hit(rs(1.0, 8.0)?.plus(4.0)?)
}

#[test]
fn two_rows_7_vs_16_1d8_plus_4() -> T {
    // (key, type, modes, mean)
    let cases = [
        (
            "cross flat reroll",
            Adv::Flat,
            vec![MissRerollMode::Reroll],
            14.058,
        ),
        (
            "cross advantage reroll",
            Adv::Advantage,
            vec![MissRerollMode::Reroll],
            16.72518,
        ),
        // advantage, add-d20 (the kept die already missed, so the new one decides alone)
        (
            "cross advantage add-d20",
            Adv::Advantage,
            vec![MissRerollMode::AddD20],
            16.72518,
        ),
        (
            "cross disadvantage reroll",
            Adv::Disadvantage,
            vec![MissRerollMode::Reroll],
            9.48402,
        ),
        (
            "cross disadvantage add-d20",
            Adv::Disadvantage,
            vec![MissRerollMode::AddD20],
            13.22946,
        ),
        (
            "cross flat reroll+add-d20",
            Adv::Flat,
            vec![MissRerollMode::Reroll, MissRerollMode::AddD20],
            14.91,
        ),
    ];
    for (key, kind, modes, mean) in cases {
        let mut t = turn(atks(&[&sword(kind)?, &sword(kind)?]), 0.0)?;
        for (i, mode) in modes.into_iter().enumerate() {
            t = t.reroll_first_miss(Some(&format!("r{i}")), None, Some(mode))?;
        }
        expect_pinned(&t, key, mean, &[], &[])?;
    }
    Ok(())
}

#[test]
fn disadvantage_without_a_reroll_is_6_1425() -> T {
    close(
        turn(
            atks(&[&sword(Adv::Disadvantage)?, &sword(Adv::Disadvantage)?]),
            0.0,
        )?
        .mean()?,
        6.1425,
        12,
    );
    Ok(())
}

/// `{ id, source, ...}` with the options of `AttackOptions`.
fn declared(id: &str, chance: Option<f64>, source: impl Into<Source>) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            chance,
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

fn sub(id: &str, on: SubstituteOn, substitute: SubstituteKind) -> SubstituteSpec {
    SubstituteSpec {
        id: Some(id.to_string()),
        on,
        of: None,
        substitute,
        mode: None,
        policy: None,
    }
}

fn first_miss_reroll_spec(id: &str, of: Option<&[&str]>) -> SubstituteSpec {
    SubstituteSpec {
        of: of.map(|names| names.iter().map(|name| (*name).to_string()).collect()),
        ..sub(id, SubstituteOn::FirstMiss, SubstituteKind::Reroll)
    }
}

#[test]
fn a_rerolled_miss_keeps_the_miss_payload_graze_and_a_row_that_may_not_happen_is_not_a_miss() -> T {
    let graze = d20()
        .plus(7.0)?
        .ac(16.0)?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)?
        .on_miss(&[Arg::Roll(rs(1.0, 4.0)?)])?;
    let graze_turn = || reroll(&turn(atks(&[&graze, &graze]), 0.0)?, "hi");
    expect_pinned(
        &graze_turn()?,
        "graze",
        graze_turn()?.mean()?,
        &[graze_turn()?.fire_probability("hi")?],
        &["hi"],
    )?;

    let sometimes = reroll(&turn(atks(&[&r7()?, &r7()?]), 0.0)?, "hi")?;
    let chancy = Turn::from_spec(
        TurnSpec {
            attacks: vec![declared("a", Some(0.5), r7()?), declared("b", None, r7()?)],
            substitutes: Some(vec![first_miss_reroll_spec("hi", None)]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let oracle = oracle::get("chancy");
    assert!((chancy.mean()? - oracle.mean).abs() <= TOLERANCE);
    assert!((chancy.fire_probability("hi")? - oracle.fires[0]).abs() <= TOLERANCE);
    assert!(sometimes.mean()? > chancy.mean()?);
    Ok(())
}

#[test]
fn a_vulnerable_rows_rerolled_hit_doubles() -> T {
    let sword2 = r7()?;
    let curse = ConditionSpec {
        id: Some("curse".to_string()),
        on: ConditionOn::Attack(AttackTriggerOn::FirstHit),
        of: Some(vec!["a".to_string()]),
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants: vec![EffectSpec::Grant(GrantSpec {
            advantage: true,
            disadvantage: false,
            crit_on_hit: false,
            until: GrantUntil::NextAttack,
            to: None,
        })],
        on_save: None,
        optional: false,
    };
    let t = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                declared("a", None, sword2.clone()),
                declared("b", None, sword2),
            ],
            conditions: Some(vec![curse]),
            substitutes: Some(vec![first_miss_reroll_spec("hi", Some(&["a", "b"]))]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    assert!((t.mean()? - oracle::get("vulnerable").mean).abs() <= TOLERANCE);
    Ok(())
}

#[test]
fn a_reroll_whose_of_is_empty_is_refused_like_any_substitute_with_no_sources() -> T {
    let t = turn(atks(&[&r7()?, &r7()?]), 0.0)?;
    assert_eq!(
        code_of(t.reroll_first_miss(Some("hi"), Some(&[]), None)),
        "unknown-id"
    );
    Ok(())
}

#[test]
fn reports_a_rerolled_rows_marginal_as_what_it_dealt() -> T {
    let t = reroll(&turn(atks(&[&r7()?, &r7()?]), 0.0)?, "hi")?;
    let oracle = oracle::get("marginal");
    for (k, expected) in oracle.sources.iter().enumerate() {
        let marginal = t.marginal(&format!("attack {}", k + 1))?;
        expect_pmf_agrees(marginal.pmf(), expected, &format!("attack {}", k + 1));
    }
    assert_eq!(oracle.sources.len(), 2);
    Ok(())
}

// ---- rerollFirstMiss: serialization and sources ----------------------------------------------------

fn serialization_spec() -> Result<TurnSpec, DiceError> {
    let sneak = Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: Some("sa".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage(rs(2.0, 6.0)?))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    };
    Ok(TurnSpec {
        attacks: vec![declared("a", None, r7()?), declared("b", None, r7()?)],
        riders: Some(vec![sneak]),
        substitutes: Some(vec![SubstituteSpec {
            mode: Some(MissRerollMode::Reroll),
            ..first_miss_reroll_spec("luck", Some(&["a", "b"]))
        }]),
        ..TurnSpec::default()
    })
}

#[test]
fn round_trips_through_json_bit_for_bit_and_equals_the_fluent_spelling() -> T {
    let spec = serialization_spec()?;
    // The spec has no JSON form in Rust: `via_json` is the cloned spec.
    let via_json = Turn::from_spec(spec.clone(), 0.0)?;
    let fluent = reroll(
        &turn(atks(&[&r7()?, &r7()?]), 0.0)?
            .on_first_hit_with(rs(2.0, 6.0)?, FirstHitOptions::default())?,
        "luck",
    )?;
    assert_eq!(via_json.mean()?, Turn::from_spec(spec, 0.0)?.mean()?);
    close(via_json.mean()?, 21.156, 12);
    assert_eq!(fluent.mean()?, via_json.mean()?);
    Ok(())
}

#[test]
fn mode_defaults_to_reroll() -> T {
    let spec = serialization_spec()?;
    let with_mode = Turn::from_spec(spec.clone(), 0.0)?;
    let without = Turn::from_spec(
        TurnSpec {
            substitutes: Some(vec![first_miss_reroll_spec("luck", Some(&["a", "b"]))]),
            ..spec
        },
        0.0,
    )?;
    assert_eq!(without.mean()?, with_mode.mean()?);
    Ok(())
}

/// A `ContextualSource` of `r7`'s row that says only what the flags let it say.
struct Wrapped {
    attack: AttackBuilder,
    /// `rollUnder` is present.
    roll_under: bool,
    /// `missRerolledUnder` is present.
    miss_rerolled_under: bool,
}

impl ContextualSource for Wrapped {
    fn row_check(&self) -> RowCheck {
        self.attack.row_check()
    }

    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.attack.under(context, eps)
    }

    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        if !self.roll_under {
            return Ok(None);
        }
        Ok(Some(RollUnder::Attack(Box::new(
            self.attack.roll_under(context)?,
        ))))
    }

    fn has_miss_rerolled_under(&self) -> bool {
        self.miss_rerolled_under
    }

    fn miss_rerolled_under(
        &self,
        context: &RowContext,
        mode: MissRerollMode,
        eps: f64,
    ) -> Result<Pmf, DiceError> {
        self.attack.miss_rerolled(mode, Some(context), eps)
    }
}

fn wrapped(roll_under: bool, miss_rerolled_under: bool) -> Result<Source, DiceError> {
    Ok(Source::Contextual(ArcContextual(Arc::new(Wrapped {
        attack: r7()?,
        roll_under,
        miss_rerolled_under,
    }))))
}

fn sneak_turn(source: Source) -> Result<TurnSpec, DiceError> {
    let sneak = Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: Some("sa".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage(rs(2.0, 6.0)?))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    };
    Ok(TurnSpec {
        attacks: vec![
            declared("a", None, source.clone()),
            declared("b", None, source),
        ],
        riders: Some(vec![sneak]),
        substitutes: Some(vec![sub(
            "luck",
            SubstituteOn::FirstMiss,
            SubstituteKind::Reroll,
        )]),
        ..TurnSpec::default()
    })
}

#[test]
fn a_contextual_source_with_only_under_row_check_roll_under_rerolls_through_its_roll_under_builder()
-> T {
    let t = Turn::from_spec(sneak_turn(wrapped(true, false)?)?, 0.0)?;
    assert!((t.mean()? - 21.156).abs() <= TOLERANCE);
    Ok(())
}

#[test]
fn missrerolledunder_supplies_the_rerolled_pmf_where_the_source_has_no_builder() -> T {
    let t = Turn::from_spec(sneak_turn(wrapped(false, true)?)?, 0.0)?;
    assert!((t.mean()? - 21.156).abs() <= TOLERANCE);
    Ok(())
}

#[test]
fn a_source_with_neither_roll_under_nor_missrerolledunder_is_refused() -> T {
    let spec = TurnSpec {
        attacks: vec![declared("a", None, wrapped(false, false)?)],
        substitutes: Some(vec![sub(
            "luck",
            SubstituteOn::FirstMiss,
            SubstituteKind::Reroll,
        )]),
        ..TurnSpec::default()
    };
    assert_eq!(
        code_of(Turn::from_spec(spec, 0.0).and_then(|t| t.mean())),
        "no-rebindable-source"
    );
    Ok(())
}

// ---- rerollFirstMiss: refusals -----------------------------------------------------------------

/// `Turn.from({ attacks: [a, b], substitutes, ...extra }).mean()`'s code.
fn code(substitutes: Vec<SubstituteSpec>) -> Result<String, DiceError> {
    let spec = TurnSpec {
        attacks: vec![declared("a", None, r7()?), declared("b", None, r7()?)],
        substitutes: Some(substitutes),
        ..TurnSpec::default()
    };
    Ok(code_of(Turn::from_spec(spec, 0.0).and_then(|t| t.mean())))
}

fn keep_higher(id: &str, policy: Option<SubstitutePolicy>) -> SubstituteSpec {
    SubstituteSpec {
        policy,
        ..sub(id, SubstituteOn::FirstHit, SubstituteKind::RerollKeepHigher)
    }
}

#[test]
fn a_hit_conversion_beside_a_reroll_and_two_first_hit_transforms_share_a_source_duplicate_substitute()
-> T {
    let convert = |id| sub(id, SubstituteOn::FirstMiss, SubstituteKind::Hit);
    let reroll_of = |id| sub(id, SubstituteOn::FirstMiss, SubstituteKind::Reroll);
    assert_eq!(
        code(vec![convert("c"), reroll_of("r")])?,
        "duplicate-substitute"
    );
    assert_eq!(
        code(vec![reroll_of("r"), convert("c")])?,
        "duplicate-substitute"
    );
    assert_eq!(
        code(vec![keep_higher("k1", None), keep_higher("k2", None)])?,
        "duplicate-substitute"
    );
    assert_eq!(
        code(vec![convert("c1"), convert("c2")])?,
        "duplicate-substitute"
    );
    Ok(())
}

#[test]
fn allows_several_rerolls_and_one_always_keep_higher_on_one_source() -> T {
    let add = SubstituteSpec {
        mode: Some(MissRerollMode::AddD20),
        ..sub("r2", SubstituteOn::FirstMiss, SubstituteKind::Reroll)
    };
    assert_eq!(
        code(vec![
            sub("r1", SubstituteOn::FirstMiss, SubstituteKind::Reroll),
            add,
            keep_higher("k", Some(SubstitutePolicy::Always)),
        ])?,
        "none"
    );
    Ok(())
}

#[test]
fn a_below_policy_beside_a_reroll_is_unsupported_policy() -> T {
    assert_eq!(
        code(vec![
            sub("r", SubstituteOn::FirstMiss, SubstituteKind::Reroll),
            keep_higher(
                "k",
                Some(SubstitutePolicy::Below {
                    hit: 8.0,
                    crit: 16.0
                })
            ),
        ])?,
        "unsupported-policy"
    );
    Ok(())
}

#[test]
fn a_policy_on_a_reroll_is_unsupported_policy() -> T {
    let r = SubstituteSpec {
        policy: Some(SubstitutePolicy::Always),
        ..sub("r", SubstituteOn::FirstMiss, SubstituteKind::Reroll)
    };
    assert_eq!(code(vec![r])?, "unsupported-policy");
    Ok(())
}

#[test]
fn a_mode_on_another_substitute_or_an_unknown_mode_is_unsupported_trigger() -> T {
    let with_mode = |s: SubstituteSpec| SubstituteSpec {
        mode: Some(MissRerollMode::Reroll),
        ..s
    };
    assert_eq!(
        code(vec![with_mode(keep_higher("k", None))])?,
        "unsupported-trigger"
    );
    assert_eq!(
        code(vec![with_mode(sub(
            "c",
            SubstituteOn::FirstMiss,
            SubstituteKind::Hit
        ))])?,
        "unsupported-trigger"
    );
    // `mode: "double"` has no Rust spelling (see the module doc).
    assert_eq!(
        code(vec![sub(
            "r",
            SubstituteOn::FirstHit,
            SubstituteKind::Reroll
        )])?,
        "unsupported-trigger"
    );
    Ok(())
}

#[test]
fn a_reroll_watching_a_row_that_rolls_no_attack_is_not_an_attack() -> T {
    let fireball = d20()
        .plus(3.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()?;
    assert_eq!(
        code_of(
            turn(vec![atk(fireball)], 0.0)?
                .reroll_first_miss(None, None, None)
                .and_then(|t| t.mean())
        ),
        "not-an-attack"
    );
    Ok(())
}

#[test]
fn a_reroll_watching_a_row_an_attack_shaped_first_miss_rider_rerolls_is_refused() -> T {
    let result = turn(atks(&[&r7()?]), 0.0)?
        .on_first_miss_with(r7()?, rid("again"))
        .and_then(|t| t.reroll_first_miss(None, Some(&["attack 1"]), None))
        .and_then(|t| t.mean());
    assert_eq!(code_of(result), "unsupported-trigger");
    Ok(())
}

#[test]
fn a_row_whose_check_already_rerolls_its_misses_is_unsupported_trigger() -> T {
    let lucky = d20()
        .plus(7.0)?
        .ac(16.0)?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)?
        .reroll_misses(MissRerollMode::AddD20)?;
    let result = turn(atks(&[&lucky, &r7()?]), 0.0)?
        .reroll_first_miss(None, None, None)
        .and_then(|t| t.mean());
    assert_eq!(code_of(result), "unsupported-trigger");
    Ok(())
}

// ---- rerollFirstMiss: Turn.sample --------------------------------------------------------------

/// `lcgRng(seed)` of `tests/helpers/lcg.ts`: mulberry32 behind `die()` (rejection-sampled uint32)
/// and `chance()` (53 bits).
struct LcgRng(u32);

impl LcgRng {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
}

impl Rng for LcgRng {
    fn die(&mut self, sides: f64) -> f64 {
        let limit = 4294967296.0 - (4294967296.0 % sides);
        let mut x = f64::from(self.next());
        while x >= limit {
            x = f64::from(self.next());
        }
        (x % sides) + 1.0
    }

    fn chance(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        let a = f64::from(self.next());
        let b = f64::from(self.next());
        (((a / 32.0).floor()) * 67108864.0 + (b / 64.0).floor()) / 9007199254740992.0 < p
    }
}

fn sampled_mean(t: &Turn, seed: u32) -> Result<f64, DiceError> {
    let mut rng = LcgRng(seed);
    let n = 20_000;
    let mut sum = 0.0;
    for _ in 0..n {
        sum += t.sample(&mut rng)?.total;
    }
    Ok(sum / f64::from(n))
}

#[test]
fn twenty_thousand_seeded_samples_of_t1_average_within_0_15_of_21_156() -> T {
    let t = reroll(
        &turn(atks(&[&r7()?, &r7()?]), 0.0)?
            .on_first_hit_with(rs(2.0, 6.0)?, FirstHitOptions::default())?,
        "luck",
    )?;
    assert!((sampled_mean(&t, 0xd2d2)? - 21.156).abs() < 0.15);
    Ok(())
}

#[test]
fn samples_a_stack_with_savage_attacker_near_its_exact_mean() -> T {
    let t = add_d20(
        &reroll(
            &turn(atks(&[&r7()?, &r7()?]), 0.0)?
                .on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())?,
            "hi",
        )?,
        "lucky",
    )?;
    assert!((sampled_mean(&t, 0xbeef)? - t.mean()?).abs() < 0.2);
    Ok(())
}
