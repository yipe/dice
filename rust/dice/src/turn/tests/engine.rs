//! Unit tests of `turn.rs` itself: the errors its verbs and readers raise (exact messages), the
//! ADR-017 deviations, the walk's state limit and the stateless path. The behaviour tests are the
//! translated TS suites beside this file.

use super::helpers::*;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, EveryHitOptions, FirstHitOptions};
use crate::turn::types::{DamageSource, RiderOptions};
use crate::turn::{MAX_ATTACK_COUNT, MAX_BOUNCE, Turn, bounce, turn};

fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(9.0, 16.0, d6().plus(5.0)?)
}

fn two_swords_with_sneak() -> Result<Turn, DiceError> {
    turn(vec![atk(sword()?), atk(sword()?)], 0.0)?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))
}

fn message<X>(result: Result<X, DiceError>) -> String {
    match result {
        Ok(_) => "ok".to_string(),
        Err(e) => format!("{}: {}", e.name(), e.message()),
    }
}

#[test]
fn attacks_count_must_be_a_positive_integer() -> T {
    let t = turn(vec![], 0.0)?;
    for (count, shown) in [
        (0.0, "0"),
        (-1.0, "-1"),
        (2.5, "2.5"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
    ] {
        assert_eq!(
            message(t.attacks(count, sword()?)),
            format!("RangeError: attacks(count) needs a positive integer, got {shown}.")
        );
    }
    Ok(())
}

/// ADR-017: TS allocates `count` attacks; Rust refuses past `MAX_ATTACK_COUNT`.
#[test]
fn deviation_attacks_count_cap() -> T {
    let t = turn(vec![], 0.0)?;
    let got = message(t.attacks(MAX_ATTACK_COUNT + 1.0, sword()?));
    assert_eq!(
        got,
        "RangeError: attacks(count) adds at most 1000000 attacks, got 1000001."
    );
    assert_eq!(
        message(t.attacks(1e9, sword()?)),
        "RangeError: attacks(count) adds at most 1000000 attacks, got 1000000000."
    );
    Ok(())
}

#[test]
fn bounce_max_must_be_a_non_negative_integer() -> T {
    let source = DamageSource::Attack(Box::new(sword()?));
    for (max, shown) in [(-1.0, "-1"), (1.5, "1.5"), (f64::NAN, "NaN")] {
        assert_eq!(
            message(bounce(source.clone(), max)),
            format!("RangeError: bounce({{ max }}) needs a non-negative integer, got {shown}.")
        );
    }
    // Beam 1 alone is one attack with no rider.
    let none = bounce(source.clone(), 0.0)?;
    assert_eq!(none.attack_ids()?, vec!["attack 1"]);
    assert!(none.rider_ids()?.is_empty());
    let two = bounce(source, 2.0)?;
    assert_eq!(two.rider_ids()?, vec!["bounce 1", "bounce 2"]);
    Ok(())
}

/// ADR-017: TS rebuilds the plan once per beam; Rust refuses past `MAX_BOUNCE`.
#[test]
fn deviation_bounce_cap() -> T {
    let source = DamageSource::Attack(Box::new(sword()?));
    assert_eq!(
        message(bounce(source, MAX_BOUNCE + 1.0)),
        "RangeError: bounce({ max }) is at most 10000, got 10001."
    );
    Ok(())
}

#[test]
fn vs_ac_needs_a_finite_number_and_something_to_rebind() -> T {
    let t = two_swords_with_sneak()?;
    assert_eq!(
        message(t.vs_ac(f64::INFINITY)),
        "RangeError: vsAC(ac) needs a finite number, got Infinity."
    );
    assert_eq!(
        message(t.vs_ac(f64::NAN)),
        "RangeError: vsAC(ac) needs a finite number, got NaN."
    );
    let flat = turn(vec![atk(rs(1.0, 6.0)?.pmf()?)], 0.0)?;
    let refused = flat.vs_ac(10.0);
    assert_eq!(code_of(refused), "no-rebindable-source");
    let rebound = t.vs_ac(30.0)?;
    assert!(rebound.mean()? < t.mean()?);
    Ok(())
}

#[test]
fn reader_errors_name_the_ids_the_reader_accepts() -> T {
    let t = two_swords_with_sneak()?;
    let unknown = |e: DiceError| match e {
        DiceError::TurnSpec(e) => (e.code.as_str().to_string(), e.id, e.message),
        other => panic!("expected a TurnSpecError, got {other:?}"),
    };
    let (code, id, text) = unknown(t.marginal("zzz").unwrap_err());
    assert_eq!((code.as_str(), id.as_str()), ("unknown-id", "zzz"));
    assert_eq!(
        text,
        "\"zzz\" is not an attack or rider in this turn. Attacks and riders: \"attack 1\", \"attack 2\", \"sneak\"."
    );
    assert_eq!(
        unknown(t.fire_probability("attack 1").unwrap_err()).2,
        "\"attack 1\" is not a rider, substitute, condition or probe in this turn. Riders: \"sneak\"."
    );
    assert_eq!(
        unknown(t.expected_applications("attack 1").unwrap_err()).2,
        "\"attack 1\" is not a rider in this turn. Riders: \"sneak\"."
    );
    assert_eq!(
        unknown(t.step_stats("sneak").unwrap_err()).2,
        "\"sneak\" is not an attack or attack-shaped rider in this turn. Attacks: \"attack 1\", \"attack 2\"."
    );
    assert_eq!(
        unknown(t.attempt_probability("c").unwrap_err()).2,
        "\"c\" is not a condition in this turn. Conditions: ."
    );
    assert_eq!(
        unknown(t.landings("sneak").unwrap_err()).2,
        "\"sneak\" is not an attack in this turn. Attacks: \"attack 1\", \"attack 2\"."
    );
    Ok(())
}

#[test]
fn a_stateless_turn_has_closed_form_readers() -> T {
    let t = turn(vec![atk(sword()?), named("b", sword()?)], 0.0)?;
    assert_eq!(t.attack_ids()?, vec!["attack 1", "b"]);
    assert!(t.rider_ids()?.is_empty() && t.substitute_ids()?.is_empty());
    assert!(t.condition_ids()?.is_empty() && t.probe_ids()?.is_empty());
    assert_eq!(t.peak_states()?, 1);
    let stats = t.step_stats("b")?;
    assert_eq!(stats.rolled, 1.0);
    assert!(stats.hit > 0.0 && stats.crit > 0.0 && stats.hit > stats.crit);
    assert!(stats.conditions.is_empty());
    let marginal = t.marginal("b")?;
    let attack = marginal.as_attack().expect("an attack marginal");
    assert_eq!(attack.occurs, 1.0);
    assert_eq!(attack.roll_type(crate::common::RollType::Flat), 1.0);
    close(attack.pmf.mean() * 2.0, t.mean()?, 12);
    assert!(t.fire_probability("b").is_err());
    // A walked turn agrees with the closed forms.
    let walked = Turn::from_spec_walked(t.inspect_spec(), 0.0)?;
    close(walked.mean()?, t.mean()?, 12);
    let walked_stats = walked.step_stats("b")?;
    close(walked_stats.hit, stats.hit, 12);
    close(walked_stats.crit, stats.crit, 12);
    Ok(())
}

#[test]
fn state_limit_is_checked_after_every_step() -> T {
    let t = turn(vec![atk(sword()?), atk(sword()?), atk(sword()?)], 0.0)?
        .on_every_hit_with(d6(), every_hit(Some("mark"), Some(1.0)))?
        .state_limit(1.0)?;
    let refused = t.mean();
    match refused {
        Err(DiceError::TurnSpec(e)) => {
            assert_eq!(e.code.as_str(), "too-many-states");
            assert!(e.message.starts_with("The walk holds "), "{}", e.message);
            assert!(
                e.message.ends_with("more than the turn's stateLimit of 1."),
                "{}",
                e.message
            );
        }
        other => panic!("expected too-many-states, got {:?}", other.map(|_| ())),
    }
    Ok(())
}

#[test]
fn chaining_errors() -> T {
    // An attack after a rider whose `of` defaulted.
    let t = two_swords_with_sneak()?;
    assert_eq!(code_of(t.attack(sword()?)), "attack-after-rider");
    assert_eq!(code_of(t.attacks(2.0, sword()?)), "attack-after-rider");
    // `otherwise` needs something to negate.
    let bare_turn = turn(vec![atk(sword()?)], 0.0)?;
    assert_eq!(
        message(bare_turn.otherwise_with(d6(), RiderOptions::default())),
        "TurnSpecError: otherwise() needs a preceding rider to negate."
    );
    // `otherwise` cannot negate an uncapped every-hit rider.
    let every = bare_turn.on_every_hit_with(d6(), EveryHitOptions::default())?;
    assert_eq!(
        code_of(every.otherwise_with(d6(), RiderOptions::default())),
        "not-an-attack"
    );
    // ... but a max-1 one can.
    let capped = bare_turn.on_every_hit_with(d6(), every_hit(None, Some(1.0)))?;
    capped.otherwise_with(d6(), RiderOptions::default())?;
    // Damage-shaped options on a call with no grants.
    let gated = bare_turn.on_first_hit_with(
        d6(),
        FirstHitOptions {
            condition: ConditionOptions {
                chance: Some(0.5),
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    );
    assert!(
        message(gated)
            .starts_with("Error: save, chance, onSave, dealing and optional shape effects only")
    );
    Ok(())
}

#[test]
fn marginals_add_up_to_the_mean() -> T {
    let t = two_swords_with_sneak()?;
    let mut sum = 0.0;
    for id in t.attack_ids()?.into_iter().chain(t.rider_ids()?) {
        sum += t.marginal(&id)?.pmf().mean();
    }
    close(sum, t.mean()?, 9);
    // The rider's landings are booked per watched attack.
    let sneak = t.marginal("sneak")?;
    let rider = sneak.as_rider().expect("a rider marginal");
    assert_eq!(
        rider.landings.keys().collect::<Vec<_>>(),
        vec!["attack 1", "attack 2"]
    );
    close(rider.any_landing, t.fire_probability("sneak")?, 12);
    // The marginal is cached.
    assert!(std::sync::Arc::ptr_eq(&t.marginal("sneak")?, &sneak));
    Ok(())
}

#[test]
fn chaining_does_not_change_the_receiver() -> T {
    let base = turn(vec![atk(sword()?)], 0.0)?;
    let before = base.mean()?;
    let with_rider = base.on_first_hit_with(d6(), FirstHitOptions::default())?;
    assert!(with_rider.mean()? > before);
    assert_eq!(base.mean()?, before);
    assert!(base.rider_ids()?.is_empty());
    Ok(())
}

#[test]
fn turn_is_send_and_sync() {
    fn assert_send_sync<X: Send + Sync>() {}
    assert_send_sync::<Turn>();
}

/// A contextual payload handing the same PMFs for every attack it lands on.
struct SharedPayload {
    on_hit: std::sync::Arc<crate::Pmf>,
    on_crit: std::sync::Arc<crate::Pmf>,
}

impl crate::turn::types::ContextualPayload for SharedPayload {
    fn at(&self, _attack_id: &str) -> Result<crate::turn::types::LandingPayload, DiceError> {
        Ok(crate::turn::types::LandingPayload {
            on_hit: self.on_hit.clone(),
            on_crit: self.on_crit.clone(),
            vulnerable: crate::turn::types::VulnerableLanding {
                on_hit: self.on_hit.clone(),
                on_crit: self.on_crit.clone(),
            },
        })
    }
}

/// The same PMF object for two rows is one payload to the reader walk: its masses merge and it is
/// mixed once (TS keys `onceWeights` by the PMF object). Expected bits from the TS engine.
#[test]
fn a_payload_shared_by_two_rows_is_mixed_once() -> T {
    use crate::turn::types::{Rider, RiderDamageSpec, Trigger};
    let a = attack_roll(5.0, 15.0, d8().plus(3.0)?)?;
    let b = attack_roll(7.0, 15.0, d6().plus(1.0)?)?;
    let payload = SharedPayload {
        on_hit: std::sync::Arc::new(rs(2.0, 6.0)?.pmf()?),
        on_crit: std::sync::Arc::new(rs(4.0, 6.0)?.pmf()?),
    };
    let rider = Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: Some("r".to_string()),
        damage: RiderDamageSpec::Contextual(std::sync::Arc::new(payload)),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    };
    let t = turn(vec![named("a", a), named("b", b)], 0.0)?.rider(rider)?;
    let pmf = t.marginal("r")?.pmf().clone();
    let want: [(f64, u64); 5] = [
        (0.0, 0x3fc428f5c28f5c28),
        (2.0, 0x3f95e6f8091a2b3b),
        (7.0, 0x3fc091e36ddbd80d),
        (14.0, 0x3f80ba1702262dc5),
        (24.0, 0x3f0d54526cf94cbc),
    ];
    for (damage, bits) in want {
        let got = pmf.p_at(damage);
        assert_eq!(got.to_bits(), bits, "p({damage}) = {got:?}");
    }
    Ok(())
}
