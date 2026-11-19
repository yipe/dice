//! `src/turn/rerolled-under.test.ts`: 11 of 11 tests, 0 compat calls (no fixture entries; the oracle numbers are asserted).
//!
//! Not translated: src/turn/rerolled-under.test.ts:184: the `rerolledUnder: () => 3 as unknown as PMF`
//! half of "returns no PMF" (the Rust signature returns a `Pmf`); the `hits(delta(1), 0)` half is kept.

use super::hand_source::*;
use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::common::{Rng, RollType};
use crate::error::DiceError;
use crate::pmf::Pmf;
use crate::turn::context::{RollUnder, RowCheck, RowContext};
use crate::turn::effects::{FirstHitOptions, keep_best_damage};
use crate::turn::trace::{DieRole, OutcomeResult};
use crate::turn::types::{
    AttackTriggerOn, GrantUntil, SubstituteKind, SubstituteOn, SubstitutePolicy, SubstituteSpec,
    Trigger, TurnSpec, TurnSpecErrorCode,
};
use crate::turn::{Turn, turn};
use std::sync::{Arc, Mutex};

// `ContextualSource.rerolledUnder`: what a row rolls once the first-hit reroll is spent on it, in
// place of keep-higher of its whole payload. Every expected value is worked out from the parts.

/// `payload` on a hit with odds `p`, else nothing.
fn hits(payload: &Pmf, p: f64) -> Result<Pmf, DiceError> {
    mix(&[("hit", payload, p), ("missNone", &delta(0.0), 1.0 - p)])
}

fn die(expression: &str) -> Result<Pmf, DiceError> {
    d_expression(expression)?.to_pmf(0.0)
}

const P: f64 = 0.55;
/// E[max of two 1d8] = (2·204 − 36) / 64 and E[1d6]: the rerolled payload's mean.
const REROLLED: f64 = 372.0 / 64.0 + 3.5;
const PLAIN: f64 = 4.5 + 3.5;

/// A row whose reroll keeps the better weapon die only: `maxOf2(a) ⊕ b`. Its own d20 odds are a decoy.
fn pool() -> Result<Hand, DiceError> {
    let a = die("1d8")?;
    let b = die("1d6")?;
    let plain = a.convolve(&b, None, false);
    let better = a.max_of_two().convolve(&b, None, false);
    Ok(Hand::new(attack_check(), move |_| hits(&plain, P)).rerolled(move |_| hits(&better, 0.3)))
}

fn keep_best_below() -> Result<crate::turn::effects::Transform, DiceError> {
    keep_best_damage().if_below_split(8.0, 16.0)
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn with_keep_best(t: Turn) -> Result<Turn, DiceError> {
    t.on_first_hit_transform(keep_best_damage(), FirstHitOptions::default())
}

fn rows(sources: &[&Hand]) -> Result<Turn, DiceError> {
    turn(sources.iter().map(|hand| atk(hand.source())).collect(), 0.0)
}

fn from(spec: TurnSpec) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(Turn::from_spec(spec, 0.0)?)
}

fn reroll_keep_higher(of: Option<&[&str]>, policy: Option<SubstitutePolicy>) -> SubstituteSpec {
    SubstituteSpec {
        id: Some("savage".to_string()),
        on: SubstituteOn::FirstHit,
        of: of.map(names),
        substitute: SubstituteKind::RerollKeepHigher,
        mode: None,
        policy,
    }
}

// ---- rerolledUnder: the row's own reroll ---------------------------------------------------------

#[test]
fn a_reroll_of_max_of_2_a_with_b_deals_p_times_the_rerolled_mean_at_the_rows_own_hit_odds() -> T {
    let pool = pool()?;
    let t = with_keep_best(rows(&[&pool])?)?;
    close(t.mean()?, P * REROLLED, 12);
    let a = die("1d8")?;
    let b = die("1d6")?;
    let want = hits(&a.max_of_two().convolve(&b, None, false), P)?;
    assert!(pmf_max_diff(&t.pmf()?, &want) < 1e-12);
    // Without a substitute over it the row rolls its plain payload.
    close(rows(&[&pool])?.mean()?, P * PLAIN, 12);
    Ok(())
}

#[test]
fn is_spent_once_a_later_row_rolls_plain_unless_every_earlier_row_missed() -> T {
    let pool = pool()?;
    let t = with_keep_best(rows(&[&pool, &pool])?)?;
    close(
        t.mean()?,
        P * REROLLED + P * (P * PLAIN + (1.0 - P) * REROLLED),
        12,
    );
    close(
        t.fire_probability("substitute 1")?,
        1.0 - (1.0 - P).powi(2),
        12,
    );
    Ok(())
}

#[test]
fn reads_hit_and_crit_apart_each_normalised_to_the_rows_own_odds() -> T {
    let h = die("1d6")?;
    let c = die("2d6")?;
    let rerolled_hit = die("1d6+10")?;
    let rerolled_crit = die("2d6+20")?;
    let none = delta(0.0);
    let crits = Hand::new(attack_check(), move |_| {
        mix(&[
            ("hit", &h, 0.5),
            ("crit", &c, 0.05),
            ("missNone", &none, 0.45),
        ])
    })
    .rerolled(move |_| {
        mix(&[
            ("hit", &rerolled_hit, 0.2),
            ("crit", &rerolled_crit, 0.6),
            ("missNone", &delta(0.0), 0.2),
        ])
    });
    let t = with_keep_best(rows(&[&crits])?)?;
    close(t.mean()?, 0.5 * 13.5 + 0.05 * 27.0, 12);
    close(
        t.marginal("attack 1")?.pmf().filter_outcome("crit").mass(),
        0.05,
        12,
    );
    Ok(())
}

#[test]
fn is_asked_in_the_rows_context_as_under_is() -> T {
    // Attack 1 lands 0.4 and gives attack 2 advantage: 0.75 to land there, else 0.5.
    let opener = Hand::new(
        RowCheck {
            pinned: true,
            ..attack_check()
        },
        |_| hits(&delta(5.0), 0.4),
    );
    let asked: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let log = asked.clone();
    let follow = Hand::new(attack_check(), |context| {
        hits(
            &delta(1.0),
            if context.roll_type == RollType::Advantage {
                0.75
            } else {
                0.5
            },
        )
    })
    .rerolled(move |context: &RowContext| {
        if let Ok(mut seen) = log.lock() {
            seen.push(context.roll_type.as_str());
        }
        hits(
            &delta(if context.roll_type == RollType::Advantage {
                100.0
            } else {
                10.0
            }),
            0.5,
        )
    });
    let spec = spec_of(
        vec![
            declared("opener", opener.source()),
            declared("follow", follow.source()),
        ],
        vec![],
        vec![SubstituteSpec {
            id: Some("reroll".to_string()),
            on: SubstituteOn::FirstHit,
            of: Some(names(&["follow"])),
            substitute: SubstituteKind::RerollKeepHigher,
            mode: None,
            policy: None,
        }],
        vec![condition(
            "vex",
            AttackTriggerOn::FirstHit,
            &["opener"],
            vec![grant_advantage(GrantUntil::NextAttack)],
        )],
    );
    let t = from(spec)?;
    close(
        t.mean()?,
        0.4 * 5.0 + 0.4 * 0.75 * 100.0 + 0.6 * 0.5 * 10.0,
        12,
    );
    let mut seen: Vec<&str> = asked.lock().map_err(|e| e.to_string())?.clone();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen, vec!["advantage", "flat"]);
    Ok(())
}

#[test]
fn keeps_the_dice_a_rider_joins_in_its_row_savage_attacker_over_a_sneak_attack_pool() -> T {
    let sword = attack_roll(5.0, 15.0, rs(1.0, 8.0)?.plus(3.0)?)?;
    let pooled = attack_roll(5.0, 15.0, rs(1.0, 8.0)?.plus(3.0)?.plus_dice(3.0, &d6())?)?;
    let savaged = attack_roll(
        5.0,
        15.0,
        rs(1.0, 8.0)?
            .max_of(2.0)?
            .plus(3.0)?
            .plus_dice(3.0, &d6())?,
    )?;
    let savaged_sword = attack_roll(5.0, 15.0, rs(1.0, 8.0)?.max_of(2.0)?.plus(3.0)?)?;
    let joined = |context: &RowContext| context.joined.iter().any(|id| id == "sa");
    let (under_sword, under_pooled) = (sword.clone(), pooled);
    let (reroll_sword, reroll_pooled) = (savaged_sword, savaged.clone());
    let row = Hand::new(attack_check(), move |context| {
        if joined(context) {
            under_pooled.under(context, 0.0)
        } else {
            under_sword.under(context, 0.0)
        }
    })
    .rerolled(move |context| {
        if joined(context) {
            reroll_pooled.under(context, 0.0)
        } else {
            reroll_sword.under(context, 0.0)
        }
    });
    let mut sneak = rider(
        "sa",
        Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        None,
        rs(3.0, 6.0)?,
    );
    sneak.joins = Some(names(&["a", "b"]));
    let spec = spec_of(
        vec![declared("a", row.source()), declared("b", row.source())],
        vec![sneak],
        vec![SubstituteSpec {
            id: Some("savage".to_string()),
            on: SubstituteOn::FirstHit,
            of: None,
            substitute: SubstituteKind::RerollKeepHigher,
            mode: None,
            policy: None,
        }],
        vec![],
    );
    let t = from(spec)?;
    // The first landing rolls the pool and the reroll together; a landing after it rolls the plain sword.
    let plain = sword.to_pmf(0.0)?;
    let lands = plain.filter_outcome("hit").mass() + plain.filter_outcome("crit").mass();
    let first = savaged.to_pmf(0.0)?.mean();
    close(
        t.mean()?,
        first + (1.0 - lands) * first + lands * plain.mean(),
        10,
    );
    Ok(())
}

// ---- rerolledUnder: refusals ---------------------------------------------------------------------

fn refusal_spec(pool: &Hand, policy: Option<SubstitutePolicy>) -> TurnSpec {
    spec_of(
        vec![declared("a", pool.source())],
        vec![],
        vec![reroll_keep_higher(None, policy)],
        vec![],
    )
}

#[test]
fn a_below_policy_over_a_source_with_rerolled_under_is_unsupported_policy() -> T {
    let pool = pool()?;
    let below = refusal_spec(
        &pool,
        Some(SubstitutePolicy::Below {
            hit: 8.0,
            crit: 16.0,
        }),
    );
    assert_eq!(
        spec_code(Turn::from_spec(below, 0.0)),
        TurnSpecErrorCode::UnsupportedPolicy
    );
    let chained =
        rows(&[&pool])?.on_first_hit_transform(keep_best_below()?, FirstHitOptions::default());
    assert_eq!(spec_code(chained), TurnSpecErrorCode::UnsupportedPolicy);
    // The same policy over a source that does not say stays as it was.
    let a = die("1d8")?;
    let b = die("1d6")?;
    let plain_pmf = a.convolve(&b, None, false);
    let plain = Hand::new(attack_check(), move |_| hits(&plain_pmf, P));
    let accepted =
        rows(&[&plain])?.on_first_hit_transform(keep_best_below()?, FirstHitOptions::default());
    assert!(accepted.is_ok(), "{:?}", accepted.err());
    Ok(())
}

#[test]
fn a_rerolled_under_with_no_pmf_for_a_landing_the_row_makes_is_not_an_attack() -> T {
    let a = die("1d8")?;
    let b = die("1d6")?;
    let plain = a.convolve(&b, None, false);
    let never_hits =
        Hand::new(attack_check(), move |_| hits(&plain, P)).rerolled(|_| hits(&delta(1.0), 0.0));
    let result = with_keep_best(rows(&[&never_hits])?);
    assert_eq!(code_of(result), "not-an-attack");
    Ok(())
}

#[test]
fn is_never_asked_without_a_substitute_over_the_row() -> T {
    let a = die("1d8")?;
    let b = die("1d6")?;
    let plain = a.convolve(&b, None, false);
    let loud = Hand::new(attack_check(), move |_| hits(&plain, P))
        .rerolled(|_| Err(DiceError::error("asked")));
    close(rows(&[&loud])?.mean()?, P * PLAIN, 12);
    Ok(())
}

// ---- rerolledUnder: Turn.sample ------------------------------------------------------------------

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

#[test]
fn draws_a_spent_rows_damage_from_the_reroll_the_first_rolls_damage_dice_not_kept() -> T {
    let sword = attack_roll(5.0, 15.0, rs(1.0, 8.0)?.plus(3.0)?)?;
    let boosted = attack_roll(5.0, 15.0, rs(1.0, 8.0)?.plus(103.0)?)?;
    let (under, rolled, rerolled) = (sword.clone(), sword.clone(), boosted);
    let row = Hand::new(sword.row_check(), move |context| under.under(context, 0.0))
        .roll_under(move |context| {
            Ok(Some(RollUnder::Attack(Box::new(
                rolled.roll_under(context)?,
            ))))
        })
        .rerolled(move |context| rerolled.under(context, 0.0));
    let t = with_keep_best(rows(&[&row, &row])?)?;
    let mut rng = Lcg { s: 7 };
    let mut spent_rows = 0;
    for _ in 0..2000 {
        let trace = t.sample(&mut rng)?;
        let wave = trace.waves.first().ok_or("a wave")?;
        let landed: Vec<_> = wave
            .outcomes
            .iter()
            .filter(|each| matches!(each.result, OutcomeResult::Hit | OutcomeResult::Crit))
            .collect();
        let Some((first, later)) = landed.split_first() else {
            continue;
        };
        spent_rows += 1;
        // The first landing is the rerolled one: its damage is the boosted payload's.
        assert!(first.damage >= 104.0, "{}", first.damage);
        for each in later {
            assert!(each.damage < 104.0, "{}", each.damage);
        }
        assert!(
            wave.dice
                .iter()
                .filter(|die| die.source == first.source && die.role != DieRole::Attack)
                .all(|die| !die.kept)
        );
    }
    assert!(spent_rows > 0);
    Ok(())
}

// ---- docs/guide.md: a row that says what its reroll rolls ----------------------------------------

#[test]
fn guide_quotes_the_right_means() -> T {
    let sword = |keep_higher: bool| -> Result<AttackBuilder, DiceError> {
        let weapon = if keep_higher {
            rs(1.0, 8.0)?.max_of(2.0)?
        } else {
            rs(1.0, 8.0)?
        };
        attack_roll(5.0, 15.0, weapon.plus(3.0)?.plus_dice(2.0, &d6())?)
    };
    let plain = sword(false)?;
    let savaged = sword(true)?;
    let (under, rerolled) = (plain.clone(), savaged);
    let row = Hand::new(plain.row_check(), move |context| under.under(context, 0.0))
        .rerolled(move |context| rerolled.under(context, 0.0));
    let two = with_keep_best(turn(vec![atk(plain.clone()), atk(plain)], 0.0)?)?;
    close(two.mean()?, 18.6634, 4);
    close(with_keep_best(rows(&[&row, &row])?)?.mean()?, 18.1854, 4);
    Ok(())
}

#[test]
fn a_dice_match_rider_over_it_is_unsupported_trigger() -> T {
    let orb = attack_roll(7.0, 15.0, rs(3.0, 8.0)?)?;
    let under = orb.clone();
    let rerolled = orb.clone();
    let info = orb.clone();
    let matchable = Hand::new(orb.row_check(), move |context| under.under(context, 0.0))
        .rerolled(move |context| rerolled.under(context, 0.0))
        .dice_match(move |eps| info.dice_match_info(eps));
    let spec = spec_of(
        vec![named("a", matchable.source())],
        vec![crate::turn::types::Rider {
            trigger: Trigger::DiceMatch {
                of: vec!["a".to_string()],
            },
            id: Some("bounce".to_string()),
            damage: crate::turn::types::RiderDamageSpec::Plain(rs(1.0, 6.0)?.into()),
            crit_damage: None,
            landing: None,
            happens: None,
            joins: None,
            r#where: None,
            target_has: None,
        }],
        vec![SubstituteSpec {
            id: Some("savage".to_string()),
            on: SubstituteOn::FirstHit,
            of: None,
            substitute: SubstituteKind::RerollKeepHigher,
            mode: None,
            policy: None,
        }],
        vec![],
    );
    assert_eq!(code_of(Turn::from_spec(spec, 0.0)), "unsupported-trigger");
    Ok(())
}
