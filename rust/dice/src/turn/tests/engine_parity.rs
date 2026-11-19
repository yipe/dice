//! `tests/turn-engine-parity.test.ts`: 10 tests, 0 compat calls (no fixture entries; the oracle numbers are asserted).

use super::hand_source::*;
use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::common::RollType;
use crate::dnd5e::{prone as prone_effect, stunned as stunned_effect};
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::Turn;
use crate::turn::context::{RowCheck, RowKind, RowRange};
use crate::turn::effects::Lasting;
use crate::turn::readers::RowLanding;
use crate::turn::types::{
    AttackTriggerOn, ConditionSpec, EffectSpec, GrantUntil, RiderLanding, SaveLanding, SaveUntil,
    Source, Trigger, TurnSpec,
};

fn melee() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

fn ranged() -> Result<AttackBuilder, DiceError> {
    d20().plus(8.0)?.ac(16.0)?.ranged()?.on_hit(d8().plus(4.0)?)
}

/// d20 + 8 against AC 16 hits on 8-19 (0.6) and crits on 20 (0.05): it lands 0.65 and misses 0.35.
const LAND: f64 = 0.65;

fn check(kind: RowKind, range: Option<RowRange>, ability: Option<&str>) -> RowCheck {
    RowCheck {
        kind,
        range,
        ability: ability.map(str::to_string),
        ..attack_check()
    }
}

/// A payload that lands without a roll (Magic Missile's darts): d4 + 1, every outcome a hit.
fn auto() -> Source {
    let darts = labelled(&[(2.0, 0.25), (3.0, 0.25), (4.0, 0.25), (5.0, 0.25)], "hit");
    Hand::new(check(RowKind::Auto, None, None), move |_| Ok(darts.clone())).source()
}

fn prone() -> EffectSpec {
    lasting(&prone_effect().until_end_of_turn())
}

fn stunned() -> Lasting {
    stunned_effect().until_end_of_turn()
}

fn from(spec: TurnSpec) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(Turn::from_spec(spec, 0.0)?)
}

type Conditions = Vec<(String, f64, f64)>;

fn conditions_at(spec: TurnSpec, id: &str) -> Result<Conditions, Box<dyn std::error::Error>> {
    Ok(from(spec)?
        .step_stats(id)?
        .conditions
        .into_iter()
        .map(|c| (c.id, c.attempted, c.taken))
        .collect())
}

#[track_caller]
fn expect_conditions(actual: &Conditions, expected: &[(&str, f64, f64)]) {
    let ids: Vec<&str> = actual.iter().map(|(id, _, _)| id.as_str()).collect();
    let want: Vec<&str> = expected.iter().map(|(id, _, _)| *id).collect();
    assert_eq!(ids, want);
    for ((_, attempted, taken), (_, want_attempted, want_taken)) in actual.iter().zip(expected) {
        close(*attempted, *want_attempted, 12);
        close(*taken, *want_taken, 12);
    }
}

fn with_save(mut condition: ConditionSpec, ability: &str, dc: f64, bonus: f64) -> ConditionSpec {
    condition.save = Some(dc_save(ability, dc, bonus));
    condition
}

fn on_first_hit(id: &str, of: &str, landing: Option<RiderLanding>) -> crate::turn::types::Rider {
    rider(
        id,
        Trigger::FirstHit {
            of: Some(names(&[of])),
            per_source: None,
        },
        landing,
        d6(),
    )
}

// ---- A ---------------------------------------------------------------------------------------

#[test]
fn a_a_condition_that_may_land_again_and_again_is_tried_on_every_landing() -> T {
    // Wisdom save + 0 against DC 13 fails on 1-12: 0.6.
    let c = with_save(
        condition(
            "c",
            AttackTriggerOn::EveryHit,
            &["a"],
            vec![EffectSpec::SaveDisadvantage {
                until: SaveUntil::EndOfTurn,
                to: None,
            }],
        ),
        "wisdom",
        13.0,
        0.0,
    );
    let spec = spec_of(vec![declared("a", ranged()?)], vec![], vec![], vec![c]);
    expect_conditions(&conditions_at(spec, "a")?, &[("c", LAND, LAND * 0.6)]);
    Ok(())
}

#[test]
fn a_a_once_per_turn_condition_is_tried_only_where_a_later_row_would_get_something_from_it() -> T {
    let mut stun = with_save(
        condition(
            "stun",
            AttackTriggerOn::FirstHit,
            &["a"],
            vec![lasting(&stunned())],
        ),
        "constitution",
        13.0,
        3.0,
    );
    stun.on_save = Some(vec![grant_advantage(GrantUntil::NextAttack)]);
    let spec = spec_of(vec![declared("a", melee()?)], vec![], vec![], vec![stun]);
    expect_conditions(&conditions_at(spec.clone(), "a")?, &[]);
    assert_eq!(from(spec)?.attempt_probability("stun")?, 0.0);
    Ok(())
}

#[test]
fn a_a_later_conditions_save_alone_is_no_reader() -> T {
    // first-miss save disadvantage on a; b's every-hit condition saves with dexterity + 0 against
    // DC 13: 0.6, not 0.84.
    let shaken = condition(
        "shaken",
        AttackTriggerOn::FirstMiss,
        &["a"],
        vec![EffectSpec::SaveDisadvantage {
            until: SaveUntil::EndOfTurn,
            to: None,
        }],
    );
    let topple = with_save(
        condition("topple", AttackTriggerOn::EveryHit, &["b"], vec![prone()]),
        "dexterity",
        13.0,
        0.0,
    );
    let spec = spec_of(
        vec![declared("a", melee()?), declared("b", melee()?)],
        vec![],
        vec![],
        vec![shaken, topple],
    );
    expect_conditions(&conditions_at(spec, "b")?, &[("topple", LAND, LAND * 0.6)]);
    Ok(())
}

#[test]
fn a_in_the_order_the_rows_outcomes_are_walked_hit_crit_then_miss() -> T {
    // On the last row the every-hit condition is often in force already (from a's landing); it is
    // still tried first, on the hit.
    let miss = condition(
        "miss",
        AttackTriggerOn::AnyMiss,
        &["a", "b"],
        vec![grant_advantage(GrantUntil::NextAttack)],
    );
    let hit = with_save(
        condition("hit", AttackTriggerOn::EveryHit, &["a", "b"], vec![prone()]),
        "constitution",
        13.0,
        3.0,
    );
    let spec = spec_of(
        vec![declared("a", melee()?), declared("b", melee()?)],
        vec![],
        vec![],
        vec![miss, hit],
    );
    let at_b: Vec<String> = conditions_at(spec.clone(), "b")?
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    assert_eq!(at_b, vec!["hit", "miss"]);
    expect_conditions(
        &conditions_at(spec, "a")?,
        &[("hit", LAND, LAND * 0.45), ("miss", 0.35, 0.35)],
    );
    Ok(())
}

// ---- B and D ---------------------------------------------------------------------------------

#[test]
fn b_its_d20_is_its_own_flat_whatever_advantage_is_in_force() -> T {
    let spec = spec_of(
        vec![declared("a", melee()?), declared("z", auto())],
        vec![],
        vec![],
        vec![condition(
            "c",
            AttackTriggerOn::AnyMiss,
            &["a"],
            vec![grant_advantage(GrantUntil::NextAttack)],
        )],
    );
    let t = from(spec)?;
    let z = t.marginal("z")?;
    let z = z.as_attack().ok_or("z is an attack")?;
    close(z.roll_type(RollType::Flat), 1.0, 12);
    assert_eq!(t.step_stats("z")?.live.advantage(), 0.0);
    Ok(())
}

#[test]
fn d_a_rule_that_differs_by_range_does_not_ask_it_for_a_range() -> T {
    let spec = spec_of(
        vec![declared("a", melee()?), declared("z", auto())],
        vec![],
        vec![],
        vec![condition(
            "c",
            AttackTriggerOn::FirstHit,
            &["a"],
            vec![prone()],
        )],
    );
    let t = from(spec)?;
    let z = t.marginal("z")?;
    close(
        z.as_attack()
            .ok_or("z is an attack")?
            .roll_type(RollType::Flat),
        1.0,
        12,
    );
    close(z.pmf().mean(), 3.5, 12);
    Ok(())
}

// ---- C ---------------------------------------------------------------------------------------

#[test]
fn c_counts_each_landing_as_a_try_as_the_engine_does() -> T {
    // Dexterity save + 0 against DC 13 fails on 1-12: 0.6. Prone (melee: advantage) is on b after a
    // took it: 0.39.
    let topple = with_save(
        condition(
            "topple",
            AttackTriggerOn::EveryHit,
            &["a", "b"],
            vec![prone()],
        ),
        "dexterity",
        13.0,
        0.0,
    );
    let spec = spec_of(
        vec![
            declared("a", melee()?),
            declared("b", melee()?),
            declared("c", melee()?),
        ],
        vec![],
        vec![],
        vec![topple],
    );
    let taken = LAND * 0.6;
    let lands_b = taken * (1.0 - 0.35f64.powi(2)) + (1.0 - taken) * LAND;
    expect_conditions(
        &conditions_at(spec, "b")?,
        &[("topple", lands_b, lands_b * 0.6)],
    );
    Ok(())
}

// ---- E ---------------------------------------------------------------------------------------

fn never_lands(check: RowCheck) -> Source {
    Hand::new(check, |_| Ok(Pmf::miss_none(crate::EPS))).source()
}

#[test]
fn e_a_save_row_that_cannot_fail_at_this_dc_simply_never_lands() -> T {
    let never_fails = never_lands(check(RowKind::Save, None, Some("dexterity")));
    let spec = spec_of(
        vec![declared("s", never_fails)],
        vec![on_first_hit(
            "r",
            "s",
            Some(RiderLanding::Save(SaveLanding::Damage)),
        )],
        vec![],
        vec![],
    );
    let t = from(spec)?;
    let marginal = t.marginal("r")?;
    let rider = marginal.as_rider().ok_or("r is a rider")?;
    close(rider.pmf.p_at(0.0), 1.0, 12);
    assert_eq!(rider.any_landing, 0.0);
    assert_eq!(rider.landings.len(), 1);
    assert_eq!(rider.landings.get("s"), Some(&RowLanding::default()));
    Ok(())
}

#[test]
fn e_an_attack_row_that_cannot_land_in_this_context_simply_never_lands() -> T {
    let never_hits = never_lands(check(RowKind::Attack, Some(RowRange::Melee), None));
    let spec = spec_of(
        vec![declared("a", never_hits)],
        vec![on_first_hit("r", "a", None)],
        vec![],
        vec![],
    );
    assert_eq!(from(spec)?.fire_probability("r")?, 0.0);
    Ok(())
}

// ---- F ---------------------------------------------------------------------------------------

#[test]
fn f_a_rider_that_lands_on_anything_books_every_landing_as_a_hit_never_a_crit_never_doubled() -> T {
    let spec = spec_of(
        vec![declared("a", melee()?)],
        vec![rider(
            "r",
            Trigger::FirstHit {
                of: Some(names(&["a"])),
                per_source: None,
            },
            Some(RiderLanding::Any),
            d4(),
        )],
        vec![],
        vec![],
    );
    let t = from(spec)?;
    let marginal = t.marginal("r")?;
    let landing = marginal
        .as_rider()
        .and_then(|r| r.landings.get("a"))
        .ok_or("r landed on a")?;
    close(landing.hit, 1.0, 12);
    assert_eq!(landing.crit, 0.0);
    assert_eq!(landing.doubled, Default::default());
    Ok(())
}
