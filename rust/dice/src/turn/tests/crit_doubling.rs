//! `tests/crit-doubling.test.ts`: 35 tests (34 translated), 198 compat calls. Its small helpers
//! are shared with the other `crit_*` modules.
//!
//! Not translated: crit-doubling.test.ts:432: "an unknown `on` is unsupported-trigger at build":
//! `Trigger` is a closed enum, so an unknown `on` string cannot be written.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;
use crate::turn::types::{
    Attack, DamageSource, Rider, RiderDamage, RiderDamageSpec, Trigger, TurnSpecErrorCode,
};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/crit-doubling.test.ts";

pub(super) type R<X> = Result<X, DiceError>;

pub(super) fn same_pmf(actual: &Pmf, expected: &Pmf) {
    let mut support: Vec<f64> = actual.support().iter().map(|d| d.0).collect();
    support.extend(expected.support().iter().map(|d| d.0));
    for v in support {
        assert!(
            (actual.p_at(v) - expected.p_at(v)).abs() <= 1e-12,
            "bin {v}"
        );
    }
}

pub(super) fn throws<X>(result: R<X>, pattern: &str) {
    match result {
        Ok(_) => panic!("expected an error matching {pattern:?}"),
        Err(e) => assert!(
            e.message().contains(pattern),
            "error {e:?} does not contain {pattern:?}"
        ),
    }
}

pub(super) fn parse_str(expression: &str) -> R<RollBuilder> {
    d_expression(expression)
}

/// `2d6+3`, roll it all twice and keep the better.
fn pool() -> R<RollBuilder> {
    rs(2.0, 6.0)?.plus(3.0)?.keep_highest_all(2.0, 1.0)
}
/// The dice double inside the pool, then it pools.
fn pool_crit() -> R<RollBuilder> {
    rs(4.0, 6.0)?.plus(3.0)?.keep_highest_all(2.0, 1.0)
}
/// The wrong reading: the whole pool rolled twice.
const DEFECT_B: f64 = 22.7438;

/// Two attacks, `d20+8` vs AC 16: P(at least one crit) = 1 - 0.95².
pub(super) fn dagger() -> R<AttackBuilder> {
    d20().plus(8.0)?.ac(16.0)?.on_hit(d4().plus(4.0)?)
}
pub(super) const P_ANY_CRIT: f64 = 0.0975;

pub(super) fn two_daggers() -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(turn(vec![atk(dagger()?), atk(dagger()?)], 0.0)?)
}

pub(super) fn trig(on: &str) -> Trigger {
    match on {
        "any-crit" => Trigger::AnyCrit {
            of: None,
            max: None,
        },
        "first-hit" => Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        "every-hit" => Trigger::EveryHit {
            of: None,
            max: None,
            per_source: None,
        },
        "first-miss" => Trigger::FirstMiss { of: None },
        other => panic!("unknown trigger {other}"),
    }
}

pub(super) fn rider_of(on: Trigger, damage: impl Into<RiderDamage>) -> Rider {
    Rider {
        trigger: on,
        id: None,
        damage: RiderDamageSpec::Plain(damage.into()),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

pub(super) fn with_id(id: &str, mut rider: Rider) -> Rider {
    rider.id = Some(id.to_string());
    rider
}

pub(super) fn with_crit(crit: impl Into<RiderDamage>, mut rider: Rider) -> Rider {
    rider.crit_damage = Some(crit.into());
    rider
}

fn rider_turn(
    on: &str,
    damage: impl Into<RiderDamage>,
) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(two_daggers()?.rider(rider_of(trig(on), damage))?)
}

/// `turn([dagger]).rider({ id: "r", damage, on: "first-miss" }).rider({ id: "watcher", ... of: ["r"] })`.
fn watch(damage: impl Into<RiderDamage>) -> Result<Turn, DiceError> {
    let dagger = dagger()?;
    let watched = rs(1.0, 4.0)?;
    let source =
        turn(vec![atk(dagger)], 0.0)?.rider(with_id("r", rider_of(trig("first-miss"), damage)))?;
    let watcher = Rider {
        trigger: Trigger::FirstHit {
            of: Some(vec!["r".to_string()]),
            per_source: None,
        },
        ..with_id("watcher", rider_of(trig("first-hit"), watched))
    };
    source.rider(watcher)
}

fn attack_of(expression: &str) -> Result<Attack, Box<dyn std::error::Error>> {
    Ok(atk(damage(parse_str(expression)?)))
}

fn parts(values: Vec<RollBuilder>) -> RiderDamage {
    RiderDamage::Many(values.into_iter().map(DamageSource::from).collect())
}

pub(super) fn close_to(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

// ---- R33 pooled payloads ----------------------------------------------------------------

const POOLED: &str = "R33 pooled payloads: a crit doubles the dice inside the pool, then pools";

#[test]
fn on_hit_pool_crits_bin_for_bin_as_the_rebuilt_pool() -> T {
    let res = d20().plus(5.0)?.ac(12.0)?.on_hit(pool()?)?.resolve(0.0)?;
    same_pmf(&res.crit, &pool_crit()?.to_pmf(0.0)?);
    close(res.hit.mean(), 11.3719, 4); // best of two 2d6 + 3
    close(res.crit.mean(), 18.9334, 4); // best of two 4d6 + 3
    assert!(!close_to(res.crit.mean(), DEFECT_B, 4));
    Ok(())
}

#[test]
fn double_dice_on_the_pool_itself_is_the_same_rebuilt_pool() -> T {
    same_pmf(
        &pool()?.double_dice()?.to_pmf(0.0)?,
        &pool_crit()?.to_pmf(0.0)?,
    );
    assert_eq!(
        pool()?.double_dice()?.to_expression()?,
        pool_crit()?.to_expression()?
    );
    Ok(())
}

#[test]
fn dice_added_after_pooling_double_too_the_pools_flats_do_not() -> T {
    let added = pool()?.plus_roll(&rs(1.0, 4.0)?)?.plus(2.0)?;
    let expected = pool_crit()?.plus_roll(&rs(2.0, 4.0)?)?.plus(2.0)?;
    same_pmf(&added.double_dice()?.to_pmf(0.0)?, &expected.to_pmf(0.0)?);
    Ok(())
}

#[test]
fn keep_lowest_all_nested_pools_and_times_rebuild_from_their_own_doubled_rolls() -> T {
    same_pmf(
        &rs(1.0, 8.0)?
            .plus(1.0)?
            .keep_lowest_all(3.0, 2.0)?
            .double_dice()?
            .to_pmf(0.0)?,
        &rs(2.0, 8.0)?
            .plus(1.0)?
            .keep_lowest_all(3.0, 2.0)?
            .to_pmf(0.0)?,
    );
    same_pmf(
        &d6()
            .keep_highest_all(4.0, 3.0)?
            .keep_highest_all(3.0, 2.0)?
            .double_dice()?
            .to_pmf(0.0)?,
        &rs(2.0, 6.0)?
            .keep_highest_all(4.0, 3.0)?
            .keep_highest_all(3.0, 2.0)?
            .to_pmf(0.0)?,
    );
    same_pmf(
        &pool()?.times(3.0)?.double_dice()?.to_pmf(0.0)?,
        &pool_crit()?.times(3.0)?.to_pmf(0.0)?,
    );
    Ok(())
}

#[test]
fn a_pooled_plus_separate_damage_channel_doubles_inside_the_pool_on_a_crit() -> T {
    let res = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 4.0)?)?
        .plus_separate_damage(pool()?)
        .resolve(0.0)?;
    same_pmf(&res.crit_separate, &pool_crit()?.to_pmf(0.0)?);
    Ok(())
}

#[test]
fn a_pooled_rider_crits_as_the_rebuilt_pool() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{POOLED} > a pooled rider crits as the rebuilt pool: any-crit adds P(any crit) × 18.9334"
        ),
    );
    let attacks = two_daggers()?;
    let auto = two_daggers()?.rider(rider_of(trig("any-crit"), pool()?))?;
    let explicit =
        two_daggers()?.rider(with_crit(pool_crit()?, rider_of(trig("any-crit"), pool()?)))?;
    let auto_pmf = want.pmf(&auto);
    let explicit_pmf = want.pmf(&explicit);
    same_pmf(&auto_pmf, &explicit_pmf);
    let auto_mean = want.mean(&auto);
    let attacks_mean = want.mean(&attacks);
    close(auto_mean - attacks_mean, P_ANY_CRIT * 18.933358577198593, 8);
    let auto_mean = want.mean(&auto);
    let attacks_mean = want.mean(&attacks);
    assert!(!close_to(
        auto_mean - attacks_mean,
        P_ANY_CRIT * DEFECT_B,
        3
    ));
    want.done();
    Ok(())
}

#[test]
fn reroll_damage_minimum_damage_die_still_refuse_a_pooled_payload() -> T {
    let attack = || d20().plus(5.0)?.ac(12.0)?.on_hit(pool()?);
    throws(
        attack().and_then(|a| a.reroll_damage(2.0)),
        "requires a dice descriptor",
    );
    throws(
        attack().and_then(|a| a.minimum_damage_die(2.0)),
        "requires a dice descriptor",
    );
    Ok(())
}

// ---- R33 parsed strings -----------------------------------------------------------------

#[test]
fn on_hit_2d6_plus_5_crits_exactly_like_the_builder() -> T {
    let parsed = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit_args(&[Arg::Str("2d6+5".into())])?
        .resolve(0.0)?;
    let built = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?.plus(5.0)?)?
        .resolve(0.0)?;
    close(parsed.weights.hit, 0.65, 12);
    close(parsed.weights.crit, 0.05, 12);
    close(parsed.weights.miss, 0.3, 12);
    close(parsed.weights.crit, built.weights.crit, 12);
    same_pmf(&parsed.hit, &built.hit);
    same_pmf(&parsed.crit, &built.crit);
    same_pmf(&parsed.pmf, &built.pmf);
    close(parsed.crit.mean(), 19.0, 10);
    Ok(())
}

#[test]
fn doubled_2d6_floor_div_2_is_4d6_floor_div_2() -> T {
    let doubled = parse_str("2d6 // 2")?.double_dice()?;
    same_pmf(&doubled.to_pmf(0.0)?, &parse_str("4d6 // 2")?.to_pmf(0.0)?);
    close(doubled.to_pmf(0.0)?.mean(), 6.75, 10);
    assert_eq!(doubled.to_expression()?, "4d6 // 2");
    Ok(())
}

#[test]
fn a_pooled_string_doubles_inside_then_pools() -> T {
    let doubled = parse_str("2kh1(2d6+3)")?.double_dice()?;
    assert_eq!(doubled.to_expression()?, "2kh1(4d6+3)");
    same_pmf(&doubled.to_pmf(0.0)?, &pool_crit()?.to_pmf(0.0)?);
    assert!(!close_to(doubled.to_pmf(0.0)?.mean(), DEFECT_B, 4));
    Ok(())
}

#[test]
fn every_builder_rendered_shape_doubles_like_the_builder_itself() -> T {
    let shapes = vec![
        rs(2.0, 6.0)?.plus(5.0)?,
        rs(1.0, 6.0)?.reroll(1.0)?, // "d6 reroll 1"
        rs(1.0, 6.0)?.reroll(1.0)?.plus(3.0)?,
        rs(2.0, 6.0)?.reroll(2.0)?,               // "2(d6 reroll d2)"
        rs(1.0, 6.0)?.minimum(3.0)?,              // "3>d6"
        rs(2.0, 6.0)?.minimum(3.0)?.reroll(1.0)?, // "2(3>(d6 reroll 1))"
        rs(1.0, 8.0)?.plus(3.0)?.half()?,         // "(1d8 + 3) // 2"
        rs(1.0, 6.0)?.scale_result(2.0, 1.0, Rounding::Floor)?, // "2 ** (1d6)"
        rs(1.0, 6.0)?.keep_highest(2.0, 1.0)?,    // "2kh1(1d6)"
        rs(1.0, 8.0)?.plus_roll(&rs(2.0, 6.0)?)?.plus(4.0)?,
        pool()?,
        pool()?.times(3.0)?,
    ];
    for shape in shapes {
        let expression = shape.to_expression()?;
        same_pmf(
            &parse_str(&expression)?.double_dice()?.to_pmf(0.0)?,
            &shape.double_dice()?.to_pmf(0.0)?,
        );
    }
    Ok(())
}

#[test]
fn scale_dice_n_multiplies_the_dice_n_times_and_keeps_the_flats() -> T {
    same_pmf(
        &parse_str("2d6+5")?.scale_dice(3.0)?.to_pmf(0.0)?,
        &rs(6.0, 6.0)?.plus(5.0)?.to_pmf(0.0)?,
    );
    // Keep-highest-of-1 multiplies inside each trial; any other keep refuses (tests/crit-keep.test.ts).
    same_pmf(
        &parse_str("4kh1d6")?.scale_dice(3.0)?.to_pmf(0.0)?,
        &parse_str("4kh1(3d6)")?.to_pmf(0.0)?,
    );
    Ok(())
}

#[test]
fn an_attacks_expression_now_carries_the_parsed_payloads_doubled_crit() -> T {
    let attack = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit_args(&[Arg::Str("2d6 + 5".into())])?;
    assert_eq!(
        attack.to_expression()?,
        "(d20 + 5 AC 12) * (2d6 + 5) crit (4d6 + 5)"
    );
    Ok(())
}

#[test]
fn an_expression_containing_an_attack_check_is_not_damage() -> T {
    let check = "(d20 + 5 AC 12) * (2d6)";
    throws(parse_str(check)?.double_dice(), "attack check");
    throws(
        d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit_args(&[Arg::Str(check.into())])
            .and_then(|a| a.resolve(0.0)),
        "attack check",
    );
    // An explicit crit or noCrit() never doubles, so the same payload still resolves.
    assert!(
        d20()
            .plus(5.0)?
            .ac(12.0)?
            .on_hit_args(&[Arg::Str(check.into())])?
            .no_crit()?
            .resolve(0.0)
            .is_ok()
    );
    Ok(())
}

// ---- R33 bare PMFs ----------------------------------------------------------------------

const BARE: &str =
    "R33 bare PMFs: a fixed distribution has no dice, so it is added as-is on a crit";

#[test]
fn a_pmf_rider_adds_its_own_distribution_on_a_crit() -> T {
    let mut want = expect(
        FILE,
        &format!("{BARE} > a PMF rider adds its own distribution on a crit"),
    );
    let attacks = two_daggers()?;
    let flat = two_daggers()?.rider(rider_of(trig("any-crit"), d6().pmf()?))?;
    let a = want.mean(&flat);
    let b = want.mean(&attacks);
    close(a - b, P_ANY_CRIT * 3.5, 8);
    want.done();
    Ok(())
}

#[test]
fn in_a_mixed_rider_the_builder_parts_double_and_the_pmf_parts_stay() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{BARE} > in a mixed rider, the builder parts double and the PMF parts stay as they are"
        ),
    );
    let attacks = two_daggers()?;
    let mixed = two_daggers()?.rider(rider_of(
        trig("any-crit"),
        RiderDamage::Many(vec![rs(1.0, 6.0)?.into(), d4().pmf()?.into()]),
    ))?;
    let a = want.mean(&mixed);
    let b = want.mean(&attacks);
    close(a - b, P_ANY_CRIT * (7.0 + 2.5), 8);
    want.done();
    Ok(())
}

// ---- R33 parsed riders ------------------------------------------------------------------

const RIDERS: &str =
    "R33 parsed riders: a parsed damage string is damage, whatever its PMF's default 'hit' label";
const TRIGGERS3: [&str; 3] = ["any-crit", "first-hit", "every-hit"];

#[test]
fn d_3d6_rides_exactly_like_roll_3_d6() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{RIDERS} > d(\"3d6\") rides exactly like roll(3,d6) on any-crit, first-hit and every-hit"
        ),
    );
    for on in TRIGGERS3 {
        let a = want.pmf(&rider_turn(on, parse_str("3d6")?)?);
        let b = want.pmf(&rider_turn(on, rs(3.0, 6.0)?)?);
        same_pmf(&a, &b);
    }
    // 8.7 for the daggers + P(any crit) × 6d6's 21.
    let t = rider_turn("any-crit", parse_str("3d6")?)?;
    close(want.mean(&t), 10.7475, 10);
    want.done();
    Ok(())
}

#[test]
fn a_parsed_riders_crit_damage_is_used_like_a_builder_riders() -> T {
    let mut want = expect(
        FILE,
        &format!("{RIDERS} > a parsed rider's critDamage is used, like a builder rider's"),
    );
    let parsed = two_daggers()?.rider(with_crit(
        parse_str("10d6")?,
        rider_of(trig("any-crit"), parse_str("3d6")?),
    ))?;
    let built = two_daggers()?.rider(with_crit(
        rs(10.0, 6.0)?,
        rider_of(trig("any-crit"), rs(3.0, 6.0)?),
    ))?;
    let a = want.pmf(&parsed);
    let b = want.pmf(&built);
    same_pmf(&a, &b);
    want.done();
    Ok(())
}

#[test]
fn a_list_of_parsed_parts_rides_like_the_same_list_of_builders() -> T {
    let mut want = expect(
        FILE,
        &format!("{RIDERS} > a list of parsed parts rides like the same list of builders"),
    );
    for on in TRIGGERS3 {
        let parsed = rider_turn(
            on,
            parts(vec![parse_str("2d6")?, parse_str("1d6+2")?, rs(1.0, 4.0)?]),
        )?;
        let built = rider_turn(
            on,
            parts(vec![rs(2.0, 6.0)?, rs(1.0, 6.0)?.plus(2.0)?, rs(1.0, 4.0)?]),
        )?;
        let a = want.pmf(&parsed);
        let b = want.pmf(&built);
        same_pmf(&a, &b);
    }
    want.done();
    Ok(())
}

fn of_r(id: &str, mut rider: Rider) -> Rider {
    rider.trigger = Trigger::FirstHit {
        of: Some(vec![id.to_string()]),
        per_source: None,
    };
    rider
}

#[test]
fn a_parsed_damage_rider_is_not_an_attack() -> T {
    for damage in [parse_str("3d6")?, rs(3.0, 6.0)?] {
        let result = turn(vec![atk(dagger()?)], 0.0)?
            .rider(with_id("r", rider_of(trig("first-hit"), damage)))?
            .rider(of_r("r", rider_of(trig("first-hit"), rs(1.0, 4.0)?)));
        assert_eq!(spec_code(result), TurnSpecErrorCode::NotAnAttack);
    }
    Ok(())
}

#[test]
fn a_parsed_string_with_an_ac_check_stays_attack_shaped() -> T {
    // With or without a crit clause, and always hitting: each carries hit and crit labels.
    for attack in [
        "(d20 + 8 AC 16) * (2d6)",
        "(d20+5 AC 12) * (1d8+3) crit (2d8+3)",
        "(d20+30 AC 5) * (1d8)",
    ] {
        let source = turn(vec![atk(dagger()?)], 0.0)?.rider(with_id(
            "ua",
            rider_of(trig("first-miss"), parse_str(attack)?),
        ))?;
        assert!(
            source
                .rider(of_r("ua", rider_of(trig("first-hit"), rs(1.0, 4.0)?)))
                .is_ok()
        );
        let result = turn(vec![atk(dagger()?)], 0.0)?.rider(with_crit(
            rs(2.0, 6.0)?,
            rider_of(trig("first-miss"), parse_str(attack)?),
        ));
        assert_eq!(spec_code(result), TurnSpecErrorCode::UnusedCritDamage);
    }
    Ok(())
}

#[test]
fn a_bare_pmf_keeps_its_label_based_shape() -> T {
    let result = two_daggers()?.rider(with_crit(
        rs(6.0, 6.0)?,
        rider_of(trig("any-crit"), parse_str("3d6")?.to_pmf(0.0)?),
    ));
    assert_eq!(spec_code(result), TurnSpecErrorCode::UnusedCritDamage);
    let result = two_daggers()?.rider(with_crit(
        rs(6.0, 6.0)?,
        rider_of(trig("any-crit"), rs(3.0, 6.0)?.to_pmf(0.0)?),
    ));
    assert!(result.is_ok());
    Ok(())
}

// ---- R33 parsed save and attack riders --------------------------------------------------

const SAVE_ATTACK: &str =
    "R33 parsed save and attack riders: each rides like its builder and never throws at plan build";
const TRIGGERS4: [&str; 4] = ["first-hit", "every-hit", "any-crit", "first-miss"];

#[test]
fn can_double_dice_is_true_exactly_when_double_dice_can_rewrite_the_string() -> T {
    let expressions = [
        ("3d6", true),
        ("2d6 // 2", true),
        ("2kh1(2d6+3)", true),
        ("(d20 + 8 AC 16) * (2d6)", false),
        ("d20+5 DC 15 * (8d6) save half", false),
        ("(d20+5 AC 15) * 0", false),
        ("d4d6", false),
    ];
    for (expression, doubles) in expressions {
        let parsed = parse_str(expression)?;
        assert!(
            parsed.is_parsed(),
            "expected a parsed string for {expression}"
        );
        assert_eq!(parsed.can_double_dice()?, doubles, "{expression}");
        if doubles {
            assert!(parsed.double_dice().is_ok(), "{expression}");
        } else {
            throws(parsed.double_dice(), "Cannot double the dice");
        }
    }
    Ok(())
}

fn built_save() -> R<crate::builder::save::SaveBuilder> {
    d20()
        .plus(5.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()
}

#[test]
fn parsed_save_string_rides_bin_for_bin_like_the_save_builder() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SAVE_ATTACK} > d(\"d20+5 DC 15 * (8d6) save half\") rides bin for bin like the SaveBuilder: added undoubled on a crit"
        ),
    );
    let parsed = || parse_str("d20+5 DC 15 * (8d6) save half");
    for on in TRIGGERS4 {
        let a = want.pmf(&rider_turn(on, parsed()?)?);
        let b = want.pmf(&rider_turn(on, built_save()?)?);
        same_pmf(&a, &b);
    }
    let any_crit = want.mean(&rider_turn("any-crit", parsed()?)?);
    let base = want.mean(&two_daggers()?);
    close(any_crit - base, P_ANY_CRIT * 20.1625, 10);
    // Like the builder, it is damage: it takes critDamage and no hit trigger can watch it.
    let a = want.pmf(&two_daggers()?.rider(with_crit(
        rs(10.0, 6.0)?,
        rider_of(trig("any-crit"), parsed()?),
    ))?);
    let b = want.pmf(&two_daggers()?.rider(with_crit(
        rs(10.0, 6.0)?,
        rider_of(trig("any-crit"), built_save()?),
    ))?);
    same_pmf(&a, &b);
    assert_eq!(spec_code(watch(parsed()?)), TurnSpecErrorCode::NotAnAttack);
    assert_eq!(
        spec_code(watch(built_save()?)),
        TurnSpecErrorCode::NotAnAttack
    );
    want.done();
    Ok(())
}

type Pair = (&'static str, fn() -> R<AttackBuilder>);

fn builder_clause() -> R<AttackBuilder> {
    d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?
        .on_crit(&[Arg::Roll(rs(2.0, 8.0)?.plus(3.0)?)])
}
fn builder_2d6_16() -> R<AttackBuilder> {
    d20().plus(8.0)?.ac(16.0)?.on_hit(rs(2.0, 6.0)?)
}

#[test]
fn a_parsed_attack_string_rides_bin_for_bin_like_its_attack_builder() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SAVE_ATTACK} > a parsed attack string rides bin for bin like its AttackBuilder on every trigger, every-hit included"
        ),
    );
    // With no crit clause the string crits its hit dice doubled, so it pairs with the
    // plain auto-doubling builder; a crit clause pairs with the builder's explicit onCrit.
    let pairs: [Pair; 2] = [
        ("(d20+5 AC 12) * (1d8+3) crit (2d8+3)", builder_clause),
        ("(d20 + 8 AC 16) * (2d6)", builder_2d6_16),
    ];
    for (expression, built) in pairs {
        for on in TRIGGERS4 {
            let a = want.pmf(&rider_turn(on, parse_str(expression)?)?);
            let b = want.pmf(&rider_turn(on, built()?)?);
            same_pmf(&a, &b);
        }
        let watched_parsed = watch(parse_str(expression)?)?;
        let watched_built = watch(built()?)?;
        // The watcher must actually fire on both sides.
        assert!(want.fire(&watched_parsed, "watcher") > 0.0);
        assert!(want.fire(&watched_built, "watcher") > 0.0);
        // Watched, the watcher doubles when the source crits, so this also compares the
        // hit/crit split, which a value-only comparison of the rider PMFs cannot see.
        let a = want.pmf(&watched_parsed);
        let b = want.pmf(&watched_built);
        same_pmf(&a, &b);
    }
    // Exact enumeration: 2671/400. (6.51125 is the result when the natural 20 folds into 'hit'.)
    close(want.mean(&watch(parse_str(pairs[1].0)?)?), 6.6775, 10);
    want.done();
    Ok(())
}

#[test]
fn zero_hit_attack_string_adds_nothing_on_any_trigger() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SAVE_ATTACK} > (d20+5 AC 15) * 0 adds nothing on any trigger, like an attack whose hit deals 0"
        ),
    );
    for on in TRIGGERS4 {
        let a = want.pmf(&rider_turn(on, parse_str("(d20+5 AC 15) * 0")?)?);
        let zero = d20().plus(5.0)?.ac(15.0)?.on_hit_args(&[Arg::Num(0.0)])?;
        let b = want.pmf(&rider_turn(on, zero)?);
        same_pmf(&a, &b);
    }
    want.done();
    Ok(())
}

#[test]
fn an_undoubleable_string_d4d6_is_added_as_is_like_its_own_pmf() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SAVE_ATTACK} > a string doubleDice() cannot rewrite, d4d6, is added as-is on a crit, like its own PMF"
        ),
    );
    for on in TRIGGERS4 {
        let a = want.pmf(&rider_turn(on, parse_str("d4d6")?)?);
        let b = want.pmf(&rider_turn(on, parse_str("d4d6")?.to_pmf(0.0)?)?);
        same_pmf(&a, &b);
    }
    want.done();
    Ok(())
}

// ---- R33 parsed attack strings ----------------------------------------------------------

const STRINGS: &str = "R33 parsed attack strings: no crit clause crits at the check's crit rate, its hit dice doubled";

fn pair_1d8_15() -> R<AttackBuilder> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(rs(1.0, 8.0)?.plus(3.0)?)
}
fn pair_reroll() -> R<AttackBuilder> {
    d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 6.0)?.reroll(1.0)?.plus(3.0)?)
}
fn pair_bonus_die() -> R<AttackBuilder> {
    d20()
        .plus(5.0)?
        .plus_roll(&d4())?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?)
}
fn pair_advantage() -> R<AttackBuilder> {
    d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?)
}
fn pair_halfling() -> R<AttackBuilder> {
    d20()
        .reroll(1.0)?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(2.0, 6.0)?)
}

/// Attack strings with no crit clause, each with the auto-doubling builder it spells.
fn string_pairs() -> [Pair; 6] {
    [
        ("(d20 + 8 AC 16) * (2d6)", builder_2d6_16),
        ("(d20+5 AC 15) * (1d8+3)", pair_1d8_15),
        ("(d20 + 5 AC 12) * (d6 reroll 1 + 3)", pair_reroll),
        // Bonus to-hit dice: the tracked natural-20 slice.
        ("(d20 + 5 + d4 AC 12) * (2d6)", pair_bonus_die),
        // Advantage and halfling luck: the kept natural roll, tracked the same way.
        ("(d20 > d20 + 5 AC 12) * (2d6)", pair_advantage),
        ("(hd20 + 5 AC 12) * (2d6)", pair_halfling),
    ]
}

#[test]
fn labels_its_crit_mass_crit_and_matches_the_builder_label_by_label() -> T {
    let pairs = string_pairs();
    for (expression, built) in &pairs {
        let parsed = parse_str(expression)?.to_pmf(0.0)?;
        let reference = built()?.to_pmf(0.0)?;
        for label in ["hit", "crit", "missNone"] {
            close(
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
    let first = parse_str(pairs[0].0)?.to_pmf(0.0)?;
    close(first.outcome_probability("crit"), 0.05, 12);
    same_pmf(
        &first.filter_outcome("crit"),
        &rs(4.0, 6.0)?.to_pmf(0.0)?.scale_mass(0.05), // not 2d6
    );
    same_pmf(
        &parse_str(pairs[1].0)?.to_pmf(0.0)?.filter_outcome("crit"),
        &rs(2.0, 8.0)?.plus(3.0)?.to_pmf(0.0)?.scale_mass(0.05), // +3 once
    );
    Ok(())
}

#[test]
fn the_audits_exact_figures_on_every_path_that_reads_crit_status() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{STRINGS} > d(\"(d20 + 8 AC 16) * (2d6)\") gives the audit's exact figures on every path that reads crit status"
        ),
    );
    let expression = "(d20 + 8 AC 16) * (2d6)";
    let attack = || attack_of(expression);
    let base = turn(vec![attack()?], 0.0)?;
    close(want.mean(&base), 4.9, 10); // was 4.55
    let first_hit =
        turn(vec![attack()?], 0.0)?.rider(rider_of(trig("first-hit"), rs(1.0, 4.0)?))?;
    let a = want.mean(&first_hit);
    let b = want.mean(&base);
    close(a - b, 1.75, 10); // was 1.625
    let two = turn(vec![attack()?, attack()?], 0.0)?;
    let every =
        turn(vec![attack()?, attack()?], 0.0)?.rider(rider_of(trig("every-hit"), rs(1.0, 4.0)?))?;
    let a = want.mean(&every);
    let b = want.mean(&two);
    close(a - b, 3.5, 10); // was 3.25
    let any_crit = turn(vec![attack()?], 0.0)?
        .rider(with_id("smite", rider_of(trig("any-crit"), rs(1.0, 4.0)?)))?;
    let a = want.mean(&any_crit);
    let b = want.mean(&base);
    close(a - b, 0.25, 10); // was 0
    close(want.fire(&any_crit, "smite"), 0.05, 12); // was 0
    close(want.mean(&watch(parse_str(expression)?)?), 6.6775, 10); // was 6.51125
    want.done();
    Ok(())
}

#[test]
fn rides_like_the_builder_as_an_attack_a_rider_and_a_watched_source() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{STRINGS} > rides like the builder as an attack, as a rider on every trigger, and as a watched source"
        ),
    );
    for (expression, built) in string_pairs() {
        for on in TRIGGERS4 {
            let parsed = turn(vec![attack_of(expression)?, attack_of(expression)?], 0.0)?
                .rider(rider_of(trig(on), rs(1.0, 4.0)?))?;
            let reference = turn(vec![atk(built()?), atk(built()?)], 0.0)?
                .rider(rider_of(trig(on), rs(1.0, 4.0)?))?;
            let a = want.pmf(&parsed);
            let b = want.pmf(&reference);
            same_pmf(&a, &b);
            let a = want.pmf(&rider_turn(on, parse_str(expression)?)?);
            let b = want.pmf(&rider_turn(on, built()?)?);
            same_pmf(&a, &b);
        }
        let a = want.pmf(&watch(parse_str(expression)?)?);
        let b = want.pmf(&watch(built()?)?);
        same_pmf(&a, &b);
    }
    want.done();
    Ok(())
}

#[test]
fn a_crit_clause_still_wins_over_doubling() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{STRINGS} > a crit clause still wins over doubling: `crit (2d6)` crits undoubled, like onCrit(roll(2, d6))"
        ),
    );
    let parsed = parse_str("(d20 + 8 AC 16) * (2d6) crit (2d6)")?;
    let built = d20()
        .plus(8.0)?
        .ac(16.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .on_crit(&[Arg::Roll(rs(2.0, 6.0)?)])?;
    let pmf = parsed.to_pmf(0.0)?;
    close(pmf.outcome_probability("crit"), 0.05, 12);
    same_pmf(
        &pmf.filter_outcome("crit"),
        &rs(2.0, 6.0)?.to_pmf(0.0)?.scale_mass(0.05),
    );
    let a = want.pmf(&watch(parsed.clone())?);
    let b = want.pmf(&watch(built)?);
    same_pmf(&a, &b);
    close(want.mean(&watch(parsed)?), 6.555, 10); // 1311/200
    want.done();
    Ok(())
}

#[test]
fn an_always_hit_string_crits_on_a_natural_20_too() -> T {
    let parsed = parse_str("(d20+30 AC 5) * (1d8)")?.to_pmf(0.0)?;
    close(parsed.outcome_probability("hit"), 0.95, 12);
    close(parsed.outcome_probability("crit"), 0.05, 12);
    same_pmf(
        &parsed.filter_outcome("crit"),
        &rs(2.0, 8.0)?.to_pmf(0.0)?.scale_mass(0.05),
    );
    close(parsed.mean(), 4.725, 10);
    Ok(())
}

#[test]
fn a_miss_or_pc_clause_keeps_its_branch_and_gains_the_crit() -> T {
    let miss = parse_str("(d20+5 AC 15) * (2d6) miss (1d6)")?.to_pmf(0.0)?;
    let spelled = parse_str("(d20+5 AC 15) * (2d6) crit (4d6) miss (1d6)")?.to_pmf(0.0)?;
    let built = d20()
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(rs(2.0, 6.0)?)?
        .on_miss(&[Arg::Roll(rs(1.0, 6.0)?)])?
        .to_pmf(0.0)?;
    for label in ["hit", "crit", "missDamage"] {
        same_pmf(&miss.filter_outcome(label), &spelled.filter_outcome(label));
        same_pmf(&miss.filter_outcome(label), &built.filter_outcome(label));
    }
    // A clause after the crit used to rescale the faces but not the crit's counts: 0.05 / 6.
    close(spelled.outcome_probability("crit"), 0.05, 12);
    close(miss.outcome_probability("hit"), 0.5, 12);
    close(miss.outcome_probability("missDamage"), 0.45, 12);

    let pc = parse_str("(d20 + 4 AC 13) * (1d6) pc (1d6)")?.to_pmf(0.0)?;
    same_pmf(
        &pc.filter_outcome("crit"),
        &rs(2.0, 6.0)?.to_pmf(0.0)?.scale_mass(0.05),
    );
    same_pmf(
        &pc,
        &parse_str("(d20 + 4 AC 13) * (1d6) crit (2d6) pc (1d6)")?.to_pmf(0.0)?,
    );

    let save = parse_str("d20+5 DC 15 * (8d6) save half")?.to_pmf(0.0)?;
    let mut outcomes = save.outcomes();
    outcomes.sort();
    assert_eq!(
        outcomes,
        vec!["saveFail".to_string(), "saveHalf".to_string()]
    );
    close(save.outcome_probability("saveFail"), 0.45, 12);
    close(save.mean(), 20.1625, 10);
    Ok(())
}

#[test]
fn a_hit_payload_double_dice_cannot_rewrite_d4d6_is_added_as_is_on_a_crit() -> T {
    let parsed = parse_str("(d20+5 AC 15) * (d4d6)")?.to_pmf(0.0)?;
    close(parsed.outcome_probability("crit"), 0.05, 12);
    same_pmf(
        &parsed.filter_outcome("crit"),
        &parse_str("d4d6")?.to_pmf(0.0)?.scale_mass(0.05),
    );
    Ok(())
}
