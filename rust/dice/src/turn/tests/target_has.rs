//! `src/turn/target-has.test.ts`: 21 of 22 tests, 0 compat calls (no compat entries; asserts the
//! oracle numbers of the test).
//!
//! Not translated:
//! - target-has.test.ts:75-79: "gives C1 = 13.53, C2 = ..." runs only the oracle (no Rust port);
//!   the three numbers are asserted against the library in the C1, C2 and C6 tests.
//! - target-has.test.ts:2-7,32-72,129,138,226,237: `enumerateSyntheticTurn` (the brute-force
//!   oracle in tests/oracle/bruteForce.ts has no Rust port): where the TS also names the number
//!   (C1 13.53, C2 12.47655, C6 18.3886695) that is what is asserted; the capped test (:204-227)
//!   has no number in the TS, so it asserts the oracle's value, 16.983 (run once in TS).
//! - target-has.test.ts:312-321,323-343: the JSON round trip of conditions/riders (`JSON.parse(
//!   JSON.stringify(..))`): specs have no JSON form in Rust; the test runs against a clone.
//! - target-has.test.ts:350: `targetHas: [7]` (a non-string name): type-level in Rust.

use super::helpers::*;
use crate::builder::attack::{AttackBuilder, ConditionGate, Grants};
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::save::SaveBuilder;
use crate::common::Rng;
use crate::dnd5e::{Edition, exhaustion, frightened, prone, save_dc};
use crate::error::DiceError;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, StartEffect, crit_on_hit, effect_spec,
};
use crate::turn::types::{
    Attack, AttackRule, AttackRuleModifier, AttackTriggerOn, ConditionOn, ConditionRule,
    ConditionSpec, ConditionUntil, DamageSource, EffectSpec, GrantSaveSpec, GrantSaves, GrantSpec,
    GrantUntil, Rider, RiderDamage, RiderDamageSpec, RiderOptions, SaveLanding, SaveRuleModifier,
    Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use indexmap::IndexMap;

fn tol(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-12,
        "{actual} differs from {expected}"
    );
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(7.0)?
        .ac(16.0)?
        .melee()?
        .on_hit(rs(1.0, 8.0)?.plus(4.0)?)
}

fn fear() -> Result<SaveBuilder, DiceError> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("wis")?
        .on_save_failure_args(&[Arg::Num(0.0)])
}

fn topple() -> Result<AttackBuilder, Box<dyn std::error::Error>> {
    Ok(sword()?.on_every_hit_with(
        Grants::One(prone().until_end_of_turn()),
        Some(ConditionGate {
            save: Some(save_dc(15.0, &[("con", 3.0)])?.into()),
            ..ConditionGate::default()
        }),
    )?)
}

/// The condition options `{ of, targetHas, .. }`.
fn gate(of: &[&str], target_has: &[&str]) -> ConditionOptions {
    ConditionOptions {
        rider: RiderOptions {
            of: if of.is_empty() {
                None
            } else {
                Some(strings(of))
            },
            target_has: Some(strings(target_has)),
            ..RiderOptions::default()
        },
        ..ConditionOptions::default()
    }
}

fn every(c: ConditionOptions) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: c,
            per_source: None,
        },
        max: None,
    }
}

fn first(c: ConditionOptions) -> FirstHitOptions {
    FirstHitOptions {
        condition: c,
        per_source: None,
    }
}

fn with_id(mut c: ConditionOptions, id: &str) -> ConditionOptions {
    c.rider.id = Some(id.to_string());
    c
}

fn flat_rider(on: Trigger, damage: DamageSource, target_has: Vec<String>) -> Rider {
    Rider {
        trigger: on,
        id: Some("rider".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage)),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: Some(target_has),
    }
}

fn every_hit_of(of: &[&str]) -> Trigger {
    Trigger::EveryHit {
        of: Some(strings(of)),
        max: None,
        per_source: None,
    }
}

fn first_hit_of(of: &[&str]) -> Trigger {
    Trigger::FirstHit {
        of: Some(strings(of)),
        per_source: None,
    }
}

fn condition_spec(of: &[&str], grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: None,
        on: ConditionOn::Attack(AttackTriggerOn::EveryHit),
        of: Some(strings(of)),
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants,
        on_save: None,
        optional: false,
    }
}

fn start_condition(grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        on: ConditionOn::Start,
        of: None,
        ..condition_spec(&[], grants)
    }
}

fn frightened_effect() -> EffectSpec {
    effect_spec(&frightened().until_end_of_turn())
}

fn prone_effect() -> EffectSpec {
    effect_spec(&prone().until_end_of_turn())
}

fn crit_effect() -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: false,
        disadvantage: false,
        crit_on_hit: true,
        until: GrantUntil::EndOfTurn,
        to: None,
    })
}

fn con_save() -> GrantSaves {
    GrantSaves::One(GrantSaveSpec::Dc {
        ability: Some("constitution".to_string()),
        dc: 15.0,
        bonus: 3.0,
        roll_type: None,
    })
}

/// C1: Frightened by a failed save, then two swords, a rider on each hit of a frightened target.
fn fear_spec(tweak: impl FnOnce(&mut Rider)) -> Result<TurnSpec, DiceError> {
    let mut rider = flat_rider(
        every_hit_of(&["a", "b"]),
        DamageSource::Roll(flat(4.0)?),
        strings(&["frightened"]),
    );
    tweak(&mut rider);
    Ok(TurnSpec {
        attacks: vec![
            named("fear", fear()?),
            named("a", sword()?),
            named("b", sword()?),
        ],
        riders: Some(vec![rider]),
        conditions: Some(vec![ConditionSpec {
            landing: Some(SaveLanding::Fail),
            ..condition_spec(&["fear"], vec![frightened_effect()])
        }]),
        ..TurnSpec::default()
    })
}

fn fear_fluent(target_has: &[&str]) -> Result<Turn, DiceError> {
    turn(
        vec![
            named("fear", fear()?),
            named("a", sword()?),
            named("b", sword()?),
        ],
        0.0,
    )?
    .on_every_hit_with(
        frightened().until_end_of_turn(),
        every(ConditionOptions {
            rider: RiderOptions {
                of: Some(strings(&["fear"])),
                landing: Some(SaveLanding::Fail),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        }),
    )?
    .on_every_hit_with(
        flat(4.0)?,
        every(with_id(gate(&["a", "b"], target_has), "rider")),
    )
}

/// C2: Topple (attack 1) may knock the target Prone, then a sword whose rider reads it.
fn topple_spec(of: &[&str], target_has: &[&str]) -> Result<TurnSpec, DiceError> {
    Ok(TurnSpec {
        attacks: vec![named("attack 1", sword()?), named("attack 2", sword()?)],
        riders: Some(vec![flat_rider(
            every_hit_of(of),
            DamageSource::Roll(rs(1.0, 6.0)?),
            strings(target_has),
        )]),
        conditions: Some(vec![ConditionSpec {
            save: Some(con_save()),
            ..condition_spec(&["attack 1"], vec![prone_effect()])
        }]),
        ..TurnSpec::default()
    })
}

fn topple_fluent(of: &[&str], target_has: &[&str]) -> Result<Turn, DiceError> {
    turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
        .on_every_hit_with(
            prone().until_end_of_turn(),
            every(ConditionOptions {
                rider: RiderOptions {
                    of: Some(strings(&["attack 1"])),
                    ..RiderOptions::default()
                },
                save: Some(
                    save_dc(15.0, &[("con", 3.0)])
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                ..ConditionOptions::default()
            }),
        )?
        .on_every_hit_with(rs(1.0, 6.0)?, every(with_id(gate(of, target_has), "rider")))
}

fn from(spec: Result<TurnSpec, DiceError>) -> Result<Turn, DiceError> {
    Turn::from_spec(spec?, 0.0)
}

#[test]
fn c1_a_rider_reads_a_condition_a_failed_save_left_on_the_target() -> T {
    let spec = from(fear_spec(|_| {}))?;
    tol(spec.mean()?, 13.53);
    tol(spec.fire_probability("rider")?, 0.504);
    assert_eq!(fear_fluent(&["frightened"])?.mean()?, spec.mean()?);
    assert_eq!(
        fear_fluent(&["frightened"])?.fire_probability("rider")?,
        spec.fire_probability("rider")?
    );
    Ok(())
}

#[test]
fn c2_prone_on_attack_1_gates_the_rider_on_attack_2() -> T {
    let spec = from(topple_spec(&["attack 2"], &["prone"]))?;
    tol(spec.mean()?, 12.47655);
    tol(spec.fire_probability("rider")?, 0.2772);
    assert_eq!(
        topple_fluent(&["attack 2"], &["prone"])?.mean()?,
        spec.mean()?
    );
    Ok(())
}

#[test]
fn c2b_a_hits_own_prone_does_not_gate_that_hits_rider() -> T {
    let both = from(topple_spec(&["attack 1", "attack 2"], &["prone"]))?;
    tol(both.mean()?, 12.47655);
    assert_eq!(
        both.mean()?,
        from(topple_spec(&["attack 2"], &["prone"]))?.mean()?
    );
    assert_eq!(
        topple_fluent(&["attack 1", "attack 2"], &["prone"])?.mean()?,
        both.mean()?
    );
    Ok(())
}

#[test]
fn c3_target_has_is_any_of() -> T {
    let any_of = from(topple_spec(&["attack 2"], &["frightened", "prone"]))?;
    tol(any_of.mean()?, 12.47655);
    assert_eq!(
        topple_fluent(&["attack 2"], &["frightened", "prone"])?.mean()?,
        any_of.mean()?
    );
    Ok(())
}

#[test]
fn c4_a_condition_the_target_starts_with_leaves_the_gate_always_open() -> T {
    let start = Turn::from_spec(
        TurnSpec {
            attacks: vec![named("a", sword()?), named("b", sword()?)],
            riders: Some(vec![flat_rider(
                every_hit_of(&["a", "b"]),
                DamageSource::Roll(flat(4.0)?),
                strings(&["frightened"]),
            )]),
            conditions: Some(vec![start_condition(vec![frightened_effect()])]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    tol(start.mean()?, 15.45);
    tol(
        start.mean()?,
        turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
            .on_every_hit_with(flat(4.0)?, EveryHitOptions::default())?
            .mean()?,
    );
    let fluent = turn(vec![named("a", sword()?), named("b", sword()?)], 0.0)?
        .at_start(vec![StartEffect::Condition(frightened())], None)?
        .on_every_hit_with(flat(4.0)?, every(gate(&["a", "b"], &["frightened"])))?;
    assert_eq!(fluent.mean()?, start.mean()?);
    Ok(())
}

#[test]
fn c5_a_name_nothing_in_the_turn_applies_never_opens_the_gate() -> T {
    let never = from(fear_spec(|r| r.target_has = Some(strings(&["charmed"]))))?;
    tol(never.mean()?, 10.65);
    tol(never.fire_probability("rider")?, 0.0);
    Ok(())
}

#[test]
fn a_first_hit_rider_lands_on_the_first_landing_the_gate_opens() -> T {
    // Prone from attack 1 on: attack 2 is the first row the gate can open on, and only it can land.
    let mut spec = topple_spec(&["attack 2"], &["prone"])?;
    spec.riders = Some(vec![flat_rider(
        first_hit_of(&["attack 2"]),
        DamageSource::Roll(rs(1.0, 6.0)?),
        strings(&["prone"]),
    )]);
    let first_only = Turn::from_spec(spec, 0.0)?;
    tol(first_only.mean()?, 12.47655);
    // Over both attacks the closed gate on attack 1 spends nothing, so it is the same turn.
    let mut spec = topple_spec(&["attack 1", "attack 2"], &["prone"])?;
    spec.riders = Some(vec![flat_rider(
        first_hit_of(&["attack 1", "attack 2"]),
        DamageSource::Roll(rs(1.0, 6.0)?),
        strings(&["prone"]),
    )]);
    let both = Turn::from_spec(spec, 0.0)?;
    tol(both.mean()?, 12.47655);
    let fluent = turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
        .on_every_hit_with(
            prone().until_end_of_turn(),
            every(ConditionOptions {
                rider: RiderOptions {
                    of: Some(strings(&["attack 1"])),
                    ..RiderOptions::default()
                },
                save: Some(save_dc(15.0, &[("con", 3.0)])?.into()),
                ..ConditionOptions::default()
            }),
        )?
        .on_first_hit_with(
            rs(1.0, 6.0)?,
            first(gate(&["attack 1", "attack 2"], &["prone"])),
        )?;
    assert_eq!(fluent.mean()?, both.mean()?);
    Ok(())
}

#[test]
fn a_gated_rider_with_max_1_counts_only_the_landings_its_gate_opened() -> T {
    let capped = Turn::from_spec(
        TurnSpec {
            attacks: vec![
                named("a", sword()?),
                named("b", sword()?),
                named("c", sword()?),
            ],
            riders: Some(vec![flat_rider(
                Trigger::EveryHit {
                    of: Some(strings(&["a", "b", "c"])),
                    max: Some(1.0),
                    per_source: None,
                },
                DamageSource::Roll(flat(4.0)?),
                strings(&["frightened"]),
            )]),
            conditions: Some(vec![ConditionSpec {
                chance: Some(0.5),
                ..condition_spec(&["a"], vec![frightened_effect()])
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    // enumerateSyntheticTurn of the same turn (run once in TS): 16.983.
    tol(capped.mean()?, 16.983);
    Ok(())
}

#[test]
fn c6_a_grant_applies_only_where_the_target_has_the_condition() -> T {
    let fluent = turn(vec![atk(topple()?), atk(sword()?), atk(sword()?)], 0.0)?.on_every_hit_with(
        crit_on_hit().until_end_of_turn(),
        every(gate(&["attack 2"], &["prone"])),
    )?;
    tol(fluent.mean()?, 18.3886695);
    let spec = TurnSpec {
        attacks: vec![
            named("attack 1", sword()?),
            named("attack 2", sword()?),
            named("attack 3", sword()?),
        ],
        conditions: Some(vec![
            ConditionSpec {
                save: Some(con_save()),
                ..condition_spec(&["attack 1"], vec![prone_effect()])
            },
            ConditionSpec {
                target_has: Some(strings(&["prone"])),
                ..condition_spec(&["attack 2"], vec![crit_effect()])
            },
        ]),
        ..TurnSpec::default()
    };
    assert_eq!(Turn::from_spec(spec, 0.0)?.mean()?, fluent.mean()?);
    Ok(())
}

/// tests/helpers/lcg.ts `lcgRng` (mulberry32).
struct Lcg {
    s: u32,
}

impl Lcg {
    fn next(&mut self) -> u32 {
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
}

impl Rng for Lcg {
    fn die(&mut self, sides: f64) -> f64 {
        let sides = sides as u64;
        let limit = 4_294_967_296 - (4_294_967_296 % sides);
        let mut x = u64::from(self.next());
        while x >= limit {
            x = u64::from(self.next());
        }
        (x % sides) as f64 + 1.0
    }

    fn chance(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        let a = self.next();
        let b = self.next();
        (f64::from(a >> 5) * 67_108_864.0 + f64::from(b >> 6)) / 9_007_199_254_740_992.0 < p
    }
}

fn sample_mean(t: &Turn, seed: u32) -> Result<f64, DiceError> {
    let samples = 20_000;
    let mut rng = Lcg { s: seed };
    let mut sum = 0.0;
    for _ in 0..samples {
        sum += t.sample(&mut rng)?.total;
    }
    Ok(sum / f64::from(samples))
}

#[test]
fn turn_sample_agrees_with_the_walk_on_c1_and_c6_within_0_2() -> T {
    assert!((sample_mean(&fear_fluent(&["frightened"])?, 0x5eed)? - 13.53).abs() < 0.2);
    let c6 = turn(vec![atk(topple()?), atk(sword()?), atk(sword()?)], 0.0)?.on_every_hit_with(
        crit_on_hit().until_end_of_turn(),
        every(gate(&["attack 2"], &["prone"])),
    )?;
    assert!((sample_mean(&c6, 0xc6)? - 18.3886695).abs() < 0.3);
    Ok(())
}

fn con_save_roll() -> Result<SaveBuilder, DiceError> {
    d20()
        .plus(3.0)?
        .dc(15.0)?
        .ability("con")?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()
}

#[test]
fn c0_no_start_effect() -> T {
    tol(turn(vec![atk(con_save_roll()?)], 0.0)?.mean()?, 21.5875);
    Ok(())
}

#[test]
fn c7_level_2_takes_4_off_the_save() -> T {
    let exhausted = turn(vec![atk(con_save_roll()?)], 0.0)?.at_start(
        vec![StartEffect::Condition(exhaustion(2.0, Edition::Y2024)?)],
        None,
    )?;
    tol(exhausted.mean()?, 24.4375);
    Ok(())
}

#[test]
fn c8_2014_level_3_is_disadvantage_on_the_save() -> T {
    let exhausted = turn(vec![atk(con_save_roll()?)], 0.0)?.at_start(
        vec![StartEffect::Condition(exhaustion(3.0, Edition::Y2014)?)],
        None,
    )?;
    tol(exhausted.mean()?, 25.114375);
    Ok(())
}

fn start_rule(source: Attack, rule: ConditionRule, name: &str) -> TurnSpec {
    TurnSpec {
        attacks: vec![source],
        conditions: Some(vec![start_condition(vec![EffectSpec::Condition {
            condition: name.to_string(),
            rule,
            until: ConditionUntil::EndOfTurn,
        }])]),
        ..TurnSpec::default()
    }
}

#[test]
fn refuses_a_d20_penalty_beside_attack_or_save_modifiers() -> T {
    let attack_rule = ConditionRule {
        attack: Some(AttackRule {
            melee: Some(vec![AttackRuleModifier::Advantage]),
            ranged: None,
        }),
        d20_penalty: Some(2.0),
        ..ConditionRule::default()
    };
    let mut save = IndexMap::new();
    save.insert("dexterity".to_string(), vec![SaveRuleModifier::AutoFail]);
    let save_rule = ConditionRule {
        save: Some(save),
        d20_penalty: Some(2.0),
        ..ConditionRule::default()
    };
    for rule in [attack_rule, save_rule] {
        let spec = start_rule(atk(sword()?), rule, "x");
        assert_eq!(code_of(Turn::from_spec(spec, 0.0)), "unsupported-trigger");
    }
    Ok(())
}

#[test]
fn refuses_a_negative_or_fractional_penalty() -> T {
    for penalty in [-1.0, 1.5] {
        let rule = ConditionRule {
            d20_penalty: Some(penalty),
            ..ConditionRule::default()
        };
        let spec = start_rule(atk(con_save_roll()?), rule, "exhaustion");
        assert!(matches!(
            Turn::from_spec(spec, 0.0),
            Err(DiceError::Range(_))
        ));
    }
    Ok(())
}

#[test]
fn the_same_mean_bit_for_bit_after_the_conditions_and_the_gate_went_through_json() -> T {
    // JSON round trip: no Rust counterpart; a clone of the spec stands in (see the module doc).
    let spec = fear_spec(|_| {})?;
    let round_tripped = TurnSpec {
        conditions: spec.conditions.clone(),
        riders: spec.riders.clone(),
        ..spec.clone()
    };
    assert_eq!(
        Turn::from_spec(round_tripped, 0.0)?.mean()?,
        Turn::from_spec(spec, 0.0)?.mean()?
    );
    Ok(())
}

#[test]
fn a_gated_grant_is_plain_data() -> T {
    let spec = TurnSpec {
        attacks: vec![
            named("attack 1", sword()?),
            named("attack 2", sword()?),
            named("attack 3", sword()?),
        ],
        conditions: Some(vec![
            ConditionSpec {
                save: Some(con_save()),
                ..condition_spec(&["attack 1"], vec![prone_effect()])
            },
            ConditionSpec {
                target_has: Some(strings(&["prone"])),
                ..condition_spec(&["attack 2"], vec![crit_effect()])
            },
        ]),
        ..TurnSpec::default()
    };
    let via_clone = TurnSpec {
        conditions: spec.conditions.clone(),
        ..spec.clone()
    };
    assert_eq!(
        Turn::from_spec(via_clone, 0.0)?.mean()?,
        Turn::from_spec(spec.clone(), 0.0)?.mean()?
    );
    tol(Turn::from_spec(spec, 0.0)?.mean()?, 18.3886695);
    Ok(())
}

#[test]
fn an_empty_target_has_is_non_string_id() -> T {
    assert_eq!(
        code_of(from(fear_spec(|r| r.target_has = Some(vec![])))),
        "non-string-id"
    );
    assert_eq!(code_of(fear_fluent(&[])), "non-string-id");
    Ok(())
}

#[test]
fn target_has_on_an_any_crit_rider_is_unsupported_trigger() -> T {
    let spec = fear_spec(|r| {
        r.trigger = Trigger::AnyCrit {
            of: Some(strings(&["a", "b"])),
            max: None,
        };
    });
    assert_eq!(code_of(from(spec)), "unsupported-trigger");
    Ok(())
}

#[test]
fn target_has_on_a_rider_whose_damage_rolls_an_attack_is_unsupported_trigger() -> T {
    let rolls = d20().plus(5.0)?.ac(15.0)?.on_hit(d6())?;
    let spec = fear_spec(|r| {
        r.damage = RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Attack(Box::new(rolls))));
    });
    assert_eq!(code_of(from(spec)), "unsupported-trigger");
    Ok(())
}

#[test]
fn target_has_on_a_first_hit_grant_is_unsupported_trigger() -> T {
    let spec = TurnSpec {
        attacks: vec![named("a", sword()?), named("b", sword()?)],
        conditions: Some(vec![ConditionSpec {
            on: ConditionOn::Attack(AttackTriggerOn::FirstHit),
            target_has: Some(strings(&["prone"])),
            ..condition_spec(&["a"], vec![crit_effect()])
        }]),
        ..TurnSpec::default()
    };
    assert_eq!(code_of(Turn::from_spec(spec, 0.0)), "unsupported-trigger");
    Ok(())
}
