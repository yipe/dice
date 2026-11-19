//! `src/turn/dealing-riders.test.ts`: 5 tests (the two-case `it.each` is one Rust test), 0 compat calls (no fixture
//! entries; the oracle numbers are asserted).

use super::hand_source::*;
use super::helpers::*;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::common::RollType;
use crate::dnd5e::unconscious;
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::Turn;
use crate::turn::context::{Dealt, PenaltyDice, RowCheck, RowContext, RowKind, RowRange};
use crate::turn::readers::EffectName;
use crate::turn::types::{
    AttackTriggerOn, ConditionSpec, ContextualPayload, EffectSpec, LandingPayload, Rider,
    RiderDamageSpec, RiderLanding, SaveUntil, Trigger, TurnSpec, VulnerableLanding,
};
use std::sync::Arc;

// A `dealing` condition (Cold Caster's Frostbite: the first hit that deals cold gives the next save
// a 1d4 penalty) over an attack a rider lands on. The rider's dice are damage of the hit, so its
// cold makes the hit a cold hit. Every expected value is a mixture of the save's own PMFs with odds
// worked out by hand.

fn d20_under(context: &RowContext) -> Result<RollBuilder, DiceError> {
    match context.roll_type {
        RollType::Advantage => d20().with_advantage(),
        RollType::Disadvantage => d20().with_disadvantage(),
        _ => Ok(d20()),
    }
}

/// A DC 14 Dexterity save at +3, 3d6 and half on a pass; an automatic fail where the context says so.
fn save_under(context: &RowContext) -> Result<Pmf, DiceError> {
    let mut roll = d20_under(context)?.plus(3.0)?;
    for die in &context.penalty_dice {
        roll = roll.minus_dice(die.count, &d(die.sides)?)?;
    }
    roll.dc(if context.auto_fail { 1000.0 } else { 14.0 })?
        .on_save_failure_args(&[crate::builder::roll::Arg::Roll(d_expression("3d6")?)])?
        .save_half()?
        .to_pmf(0.0)
}

fn save() -> Hand {
    Hand::new(
        RowCheck {
            kind: RowKind::Save,
            ability: Some("dexterity".to_string()),
            ..attack_check()
        },
        save_under,
    )
}

fn penalty() -> RowContext {
    RowContext {
        penalty_dice: vec![PenaltyDice {
            count: 1.0,
            sides: 4.0,
        }],
        ..plain_context()
    }
}

fn auto_fail() -> RowContext {
    RowContext {
        auto_fail: true,
        ..plain_context()
    }
}

/// The save's PMF in each state, mixed by its odds.
fn mixture(states: &[(f64, RowContext)]) -> Result<Pmf, DiceError> {
    states
        .iter()
        .try_fold(Pmf::empty_mass(), |all, (p, context)| {
            Ok(all.add(&save_under(context)?.scale_mass(*p)))
        })
}

fn typed_as(type_: &'static str, odds: Dealt) -> impl Fn(&str) -> Dealt + Send + Sync + 'static {
    move |asked| {
        if asked == type_ {
            odds
        } else {
            Dealt {
                hit: 0.0,
                crit: 0.0,
            }
        }
    }
}

fn frostbite(of: &str) -> ConditionSpec {
    let mut condition = condition(
        "frostbite",
        AttackTriggerOn::FirstHit,
        &[of],
        vec![EffectSpec::SavePenalty {
            count: 1.0,
            sides: 4.0,
            until: SaveUntil::NextSave,
            to: None,
        }],
    );
    condition.dealing = Some("cold".to_string());
    condition
}

/// `{ at: () => ({ onHit, onCrit, vulnerable: doubled }), dealt: typedAs("cold", dealt) }`.
struct Cold {
    on_hit: Pmf,
    on_crit: Pmf,
    dealt: Dealt,
}

impl ContextualPayload for Cold {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        Ok(LandingPayload {
            on_hit: (self.on_hit.clone()).into(),
            on_crit: (self.on_crit.clone()).into(),
            vulnerable: VulnerableLanding {
                on_hit: (self.on_hit.map_damage(|value| 2.0 * value)).into(),
                on_crit: (self.on_crit.map_damage(|value| 2.0 * value)).into(),
            },
        })
    }

    fn has_dealt(&self) -> bool {
        true
    }

    fn dealt(&self, type_: &str, _attack_id: &str) -> Result<Dealt, DiceError> {
        Ok(typed_as("cold", self.dealt)(type_))
    }
}

fn polar(of: &str, landing: Option<RiderLanding>, payload: Cold) -> Rider {
    Rider {
        trigger: Trigger::FirstHit {
            of: Some(names(&[of])),
            per_source: None,
        },
        id: Some("polar".to_string()),
        damage: RiderDamageSpec::Contextual(Arc::new(payload)),
        crit_damage: None,
        landing,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn from(spec: TurnSpec) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(Turn::from_spec(spec, 0.0)?)
}

// ---- a rider that lands on any outcome deals the type on the hit it lands on ---------------------

/// +5 against AC 15, 1d8+3 slashing: a hit 0.5, a crit 0.05.
fn sword() -> Hand {
    Hand::new(
        RowCheck {
            range: Some(RowRange::Melee),
            ..attack_check()
        },
        |context| {
            d20_under(context)?
                .plus(5.0)?
                .ac(15.0)?
                .on_hit(d_expression("1d8+3")?)?
                .to_pmf(0.0)
        },
    )
    .dealt(typed_as(
        "slashing",
        Dealt {
            hit: 1.0,
            crit: 1.0,
        },
    ))
}

fn sword_spec(
    landing: Option<RiderLanding>,
    dealt: Dealt,
) -> Result<TurnSpec, Box<dyn std::error::Error>> {
    let payload = Cold {
        on_hit: d_expression("1d6")?.to_pmf(0.0)?,
        on_crit: d_expression("2d6")?.to_pmf(0.0)?,
        dealt,
    };
    Ok(spec_of(
        vec![
            declared("sword", sword().source()),
            declared("save", save().source()),
        ],
        vec![polar("sword", landing, payload)],
        vec![],
        vec![frostbite("sword")],
    ))
}

#[test]
fn landing_hit_or_any_the_penalty_is_on_the_save_with_the_odds_the_sword_lands() -> T {
    let landed = mixture(&[(0.55, penalty()), (0.45, plain_context())])?;
    for landing in [None, Some(RiderLanding::Any)] {
        let turn = from(sword_spec(
            landing,
            Dealt {
                hit: 1.0,
                crit: 1.0,
            },
        )?)?;
        close(
            turn.step_stats("save")?.live.odds(EffectName::SavePenalty),
            0.55,
            12,
        );
        assert!(
            pmf_max_diff(turn.marginal("save")?.pmf(), &landed) < 1e-12,
            "landing {landing:?}"
        );
    }
    Ok(())
}

#[test]
fn on_a_crit_it_deals_its_plain_payload_so_its_plain_hits_odds_say_whether_it_dealt_the_type() -> T
{
    // Cold on a plain hit only: the `any` rider's crit is its plain payload, a cold one.
    let landed = mixture(&[(0.55, penalty()), (0.45, plain_context())])?;
    let turn = from(sword_spec(
        Some(RiderLanding::Any),
        Dealt {
            hit: 1.0,
            crit: 0.0,
        },
    )?)?;
    close(
        turn.step_stats("save")?.live.odds(EffectName::SavePenalty),
        0.55,
        12,
    );
    assert!(pmf_max_diff(turn.marginal("save")?.pmf(), &landed) < 1e-12);
    Ok(())
}

// ---- a rider landing that wakes the creature and deals the type is one event ---------------------

// `club`: +5 against AC 15; its first hit knocks the target out until it takes damage (0.55).
// `bolt`: ranged, deals nothing itself; on a sleeping target its Advantage and Prone's Disadvantage
// cancel, so it hits 0.5 and crits 0.05 either way. Its rider deals cold: 1d2 halved on a hit
// (0 or 1) and 2d2 halved on a crit (1 or 2), the only damage the target takes there. The save
// after it fails automatically on a sleeping target.

fn attack_under(
    damage: fn() -> Result<RollBuilder, DiceError>,
) -> impl Fn(&RowContext) -> Result<Pmf, DiceError> + Send + Sync {
    move |context| {
        let roll = d20_under(context)?.plus(5.0)?.ac(15.0)?;
        let roll = if context.crit_on_hit {
            roll.always_crits()?
        } else {
            roll
        };
        roll.on_hit(damage()?)?.to_pmf(0.0)
    }
}

fn club() -> Hand {
    Hand::new(
        RowCheck {
            range: Some(RowRange::Melee),
            ..attack_check()
        },
        attack_under(|| d_expression("1d8+3")),
    )
    .dealt(typed_as(
        "bludgeoning",
        Dealt {
            hit: 1.0,
            crit: 1.0,
        },
    ))
}

fn bolt() -> Hand {
    Hand::new(
        RowCheck {
            range: Some(RowRange::Ranged),
            ..attack_check()
        },
        attack_under(|| flat(0.0)),
    )
    .dealt(|_| Dealt {
        hit: 0.0,
        crit: 0.0,
    })
}

fn on_hit() -> Pmf {
    labelled_plain(&[(0.0, 0.5), (1.0, 0.5)])
}

fn on_crit() -> Pmf {
    labelled_plain(&[(1.0, 0.75), (2.0, 0.25)])
}

/// `PMF.fromMap(new Map(entries))`.
fn labelled_plain(entries: &[(f64, f64)]) -> Pmf {
    let map = entries
        .iter()
        .map(|&(damage, p)| (crate::Damage(damage), p))
        .collect();
    // INFALLIBLE: the entries are a few positive probabilities.
    Pmf::from_map(map, crate::EPS, true).unwrap_or_else(|_| Pmf::zero(crate::EPS))
}

fn bolt_spec() -> Result<TurnSpec, Box<dyn std::error::Error>> {
    let payload = Cold {
        on_hit: on_hit(),
        on_crit: on_crit(),
        dealt: Dealt {
            hit: 0.5,
            crit: 1.0,
        },
    };
    let knock_out = condition(
        "knockOut",
        AttackTriggerOn::FirstHit,
        &["club"],
        vec![lasting(&unconscious().until_damaged())],
    );
    Ok(spec_of(
        vec![
            declared("club", club().source()),
            declared("bolt", bolt().source()),
            declared("save", save().source()),
        ],
        vec![polar("bolt", None, payload)],
        vec![],
        vec![knock_out, frostbite("bolt")],
    ))
}

#[test]
fn the_save_rolls_asleep_awake_with_the_penalty_or_awake_without_it() -> T {
    // The rider deals cold (0.5 x 1/2 + 0.05 = 0.3) exactly where it wakes the target: asleep
    // 0.55 x 0.7, awake with the penalty 0.3, awake without it the rest.
    let turn = from(bolt_spec()?)?;
    let live = turn.step_stats("save")?.live;
    close(live.odds(EffectName::AutoFail), 0.385, 12);
    close(live.odds(EffectName::SavePenalty), 0.3, 12);
    let want = mixture(&[
        (0.385, auto_fail()),
        (0.3, penalty()),
        (0.315, plain_context()),
    ])?;
    assert!(pmf_max_diff(turn.marginal("save")?.pmf(), &want) < 1e-12);
    Ok(())
}

#[test]
fn the_riders_own_marginal_is_its_payload_where_it_lands() -> T {
    // Asleep the bolt lands 0.55 (hit 0.5, crit 0.05), awake the same: flat either way.
    let want = on_hit()
        .scale_mass(0.5)
        .add(&on_crit().scale_mass(0.05))
        .add(&delta(0.0).scale_mass(0.45));
    let turn = from(bolt_spec()?)?;
    assert!(pmf_max_diff(turn.marginal("polar")?.pmf(), &want) < 1e-12);
    Ok(())
}
