//! `tests/turn-chance.test.ts`: 14 tests here (+1 in plan), 117 compat calls.
//!
//! The `chance` outside `[0, 1]` test (lines 95-98) is translated in `plan/tests_validation.rs`.

use super::helpers::*;
use crate::builder::attack::{AttackBuilder, Grants};
use crate::builder::factory::flat;
use crate::error::DiceError;
use crate::pmf::ChartModelOptions;
use crate::turn::Turn;
use crate::turn::effects::advantage;
use crate::turn::types::{
    Attack, AttackOptions, DamageSource, Rider, RiderDamage, RiderDamageSpec, Trigger, TurnSpec,
};

const FILE: &str = "tests/turn-chance.test.ts";

/// d20+8 vs AC 16, 5 flat damage on a landing: miss on 1-7 (0.35), hit on 8-19 (0.60), crit on 20
/// (0.05). Flat damage never doubles, so each d20 outcome maps to one damage value.
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, flat(5.0)?)
}

#[derive(Clone, Copy, PartialEq)]
enum Outcome {
    None,
    Miss,
    Hit,
    Crit,
}

fn resolve(r: u32) -> Outcome {
    if r == 20 {
        Outcome::Crit
    } else if r >= 8 {
        Outcome::Hit
    } else {
        Outcome::Miss
    }
}

fn damage_of(o: Outcome) -> f64 {
    if matches!(o, Outcome::Hit | Outcome::Crit) {
        5.0
    } else {
        0.0
    }
}

#[derive(Clone, Copy, Default)]
struct Riders {
    first_hit: f64,
    first_miss: f64,
}

/// Exact mean by enumerating every d20 pair and the occurrence branch.
fn oracle_mean(c: f64, riders: Riders) -> f64 {
    let rider_damage = |outcomes: [Outcome; 2]| -> f64 {
        let mut d = 0.0;
        if riders.first_hit != 0.0
            && outcomes
                .iter()
                .any(|o| matches!(o, Outcome::Hit | Outcome::Crit))
        {
            d += riders.first_hit;
        }
        if riders.first_miss != 0.0 && outcomes.contains(&Outcome::Miss) {
            d += riders.first_miss;
        }
        d
    };
    let mut total = 0.0;
    // Attack 1 does not happen: its outcome is "none" for every r2.
    for r2 in 1..=20 {
        let o2 = resolve(r2);
        total += ((1.0 - c) / 20.0) * (damage_of(o2) + rider_damage([Outcome::None, o2]));
    }
    // Attack 1 happens: enumerate r1 and r2.
    for r1 in 1..=20 {
        for r2 in 1..=20 {
            let o1 = resolve(r1);
            let o2 = resolve(r2);
            total += (c / 400.0) * (damage_of(o1) + damage_of(o2) + rider_damage([o1, o2]));
        }
    }
    total
}

fn chance_attack(source: AttackBuilder, id: Option<&str>, chance: f64) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: id.map(str::to_string),
            chance: Some(chance),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

fn rider(trigger: Trigger) -> Result<Rider, DiceError> {
    Ok(Rider {
        trigger,
        id: Some("rider".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::from(flat(10.0)?))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    })
}

fn gated_pair(c: f64) -> Result<Vec<Attack>, DiceError> {
    Ok(vec![chance_attack(sword()?, None, c), atk(sword()?)])
}

fn spec(attacks: Vec<Attack>, riders: Option<Vec<Rider>>) -> TurnSpec {
    TurnSpec {
        attacks,
        riders,
        ..TurnSpec::default()
    }
}

fn name(test: &str) -> String {
    format!("attack({{ source, chance }}) > {test}")
}

#[test]
fn mean_matches_the_brute_force_oracle_for_a_bare_gated_turn() -> T {
    let mut want = expect(
        FILE,
        &name("mean() matches the brute-force oracle for a bare gated turn"),
    );
    for c in [0.0, 0.25, 0.5, 0.75, 1.0] {
        let t = Turn::from_spec(spec(gated_pair(c)?, None), 0.0)?;
        close(want.mean(&t), oracle_mean(c, Riders::default()), 12);
    }
    want.done();
    Ok(())
}

#[test]
fn interacts_with_a_first_hit_rider_a_not_happened_attack_is_no_landing() -> T {
    let mut want = expect(
        FILE,
        &name("interacts with a first-hit rider: a not-happened attack is no landing"),
    );
    for c in [0.0, 0.3, 0.5, 0.8, 1.0] {
        let t = Turn::from_spec(
            spec(
                gated_pair(c)?,
                Some(vec![rider(Trigger::FirstHit {
                    of: None,
                    per_source: None,
                })?]),
            ),
            0.0,
        )?;
        let with = Riders {
            first_hit: 10.0,
            ..Riders::default()
        };
        close(want.mean(&t), oracle_mean(c, with), 12);
        // A 10-damage rider adds 10 exactly when it fires, so its fire probability is the mean's
        // rider share over 10.
        let fire = (oracle_mean(c, with) - oracle_mean(c, Riders::default())) / 10.0;
        close(want.fire(&t, "rider"), fire, 12);
    }
    want.done();
    Ok(())
}

#[test]
fn interacts_with_a_first_miss_rider_a_not_happened_attack_is_no_miss() -> T {
    let mut want = expect(
        FILE,
        &name("interacts with a first-miss rider: a not-happened attack is no miss"),
    );
    for c in [0.0, 0.3, 0.5, 0.8, 1.0] {
        let t = Turn::from_spec(
            spec(
                gated_pair(c)?,
                Some(vec![rider(Trigger::FirstMiss { of: None })?]),
            ),
            0.0,
        )?;
        let with = Riders {
            first_miss: 10.0,
            ..Riders::default()
        };
        close(want.mean(&t), oracle_mean(c, with), 12);
        let fire = (oracle_mean(c, with) - oracle_mean(c, Riders::default())) / 10.0;
        close(want.fire(&t, "rider"), fire, 12);
    }
    want.done();
    Ok(())
}

#[test]
fn chance_1_is_byte_identical_to_omitting_it() -> T {
    let mut want = expect(FILE, &name("chance 1 is byte-identical to omitting it"));
    let with_chance = Turn::from_spec(spec(gated_pair(1.0)?, None), 0.0)?;
    let without = Turn::from_spec(spec(vec![atk(sword()?), atk(sword()?)], None), 0.0)?;
    assert_eq!(
        want.pmf(&with_chance).fingerprint(),
        want.pmf(&without).fingerprint()
    );
    assert_eq!(want.mean(&with_chance), want.mean(&without));
    want.done();
    Ok(())
}

#[test]
fn chance_0_contributes_nothing_and_never_fires_a_miss_or_landing() -> T {
    let mut want = expect(
        FILE,
        &name("chance 0 contributes nothing and never fires a miss or landing"),
    );
    let t = Turn::from_spec(spec(gated_pair(0.0)?, None), 0.0)?;
    close(want.mean(&t), oracle_mean(0.0, Riders::default()), 12);
    close(want.pmf(&t).p_at(0.0), 0.35, 12); // only the second attack can whiff
    assert_eq!(want.step_stats(&t, "attack 1").hit, 0.0);
    assert_eq!(want.step_stats(&t, "attack 1").crit, 0.0);
    close(want.step_stats(&t, "attack 2").hit, 0.65, 12);
    want.done();
    Ok(())
}

#[test]
fn step_stats_and_to_query_agree_with_the_walk() -> T {
    let mut want = expect(FILE, &name("stepStats and toQuery agree with the walk"));
    let t = Turn::from_spec(spec(gated_pair(0.5)?, None), 0.0)?;
    close(want.step_stats(&t, "attack 1").rolled, 1.0, 12);
    close(want.step_stats(&t, "attack 1").hit, 0.5 * 0.65, 12);
    close(want.step_stats(&t, "attack 1").crit, 0.5 * 0.05, 12);
    want.query(&t);
    close(t.to_query()?.mean(), want.mean(&t), 12);
    want.done();
    Ok(())
}

#[test]
fn a_gated_turns_chart_conserves_mass() -> T {
    let mut want = expect(FILE, &name("a gated turn's chart conserves mass"));
    let t = Turn::from_spec(spec(gated_pair(0.5)?, None), 0.0)?;
    want.query(&t);
    let model = t
        .to_query()?
        .combined_with_attribution()
        .damage_attribution_chart_model(&ChartModelOptions::default())?;
    close(model.totals.iter().sum::<f64>(), 1.0, 12);
    want.done();
    Ok(())
}

// ---- a skipped attack and a next-attack grant -------------------------------------------------

const GRANT_SUITE: &str = "a skipped attack and a next-attack grant";

/// d20+5 vs AC 15 (a landing on 10-20) for 10 flat, and a landing grants advantage on the next
/// attack that happens.
fn granter() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 15.0, flat(10.0)?)?
        .on_every_hit_with(Grants::One(advantage().until_next_attack().into()), None)
}

fn plain() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 15.0, flat(10.0)?)
}

#[derive(Clone, Copy)]
struct Swing {
    grants: bool,
    chance: f64,
}

fn sw(grants: bool, chance: f64) -> Swing {
    Swing { grants, chance }
}

struct Walk<'a> {
    swings: &'a [Swing],
    live: Vec<f64>,
    mean: f64,
    straight: f64,
    advantaged: f64,
}

impl Walk<'_> {
    // `pending` is the mass in which a grant is waiting; the rest has none.
    fn walk(&mut self, index: usize, pending: f64, none: f64) {
        if index == self.swings.len() {
            return;
        }
        let Swing { grants, chance } = self.swings[index];
        self.live[index] += pending;
        let landed = chance * (pending * self.advantaged + none * self.straight);
        let missed = chance * (pending * (1.0 - self.advantaged) + none * (1.0 - self.straight));
        self.mean += 10.0 * landed;
        // A swing that happens uses up a waiting grant; one that is skipped leaves it alone.
        // A landing on a granter sets a new one.
        let skipped_pending = pending * (1.0 - chance);
        let skipped_none = none * (1.0 - chance);
        self.walk(
            index + 1,
            skipped_pending + if grants { landed } else { 0.0 },
            skipped_none + missed + if grants { 0.0 } else { landed },
        );
    }
}

/// A next-attack grant, by enumeration: `(mean, per-swing P(advantage live))`.
fn grant_oracle(swings: &[Swing]) -> (f64, Vec<f64>) {
    let lands = |roll: u32| roll >= 10;
    // P(landing) for a swing rolled straight and with advantage, by listing the rolls.
    let mut straight = 0.0;
    let mut advantaged = 0.0;
    for a in 1..=20u32 {
        if lands(a) {
            straight += 1.0 / 20.0;
        }
        for b in 1..=20u32 {
            if lands(a.max(b)) {
                advantaged += 1.0 / 400.0;
            }
        }
    }
    let mut w = Walk {
        swings,
        live: vec![0.0; swings.len()],
        mean: 0.0,
        straight,
        advantaged,
    };
    w.walk(0, 0.0, 1.0);
    (w.mean, w.live)
}

fn grant_name(test: &str) -> String {
    format!("{GRANT_SUITE} > {test}")
}

#[test]
fn chance_0_equals_the_turn_without_the_attack() -> T {
    let mut want = expect(
        FILE,
        &grant_name("chance 0 equals the turn without the attack (the case from issue 29)"),
    );
    let without = Turn::from_spec(
        spec(vec![atk(granter()?), named("last", plain()?)], None),
        0.0,
    )?;
    let skipped = Turn::from_spec(
        spec(
            vec![
                atk(granter()?),
                chance_attack(plain()?, Some("skippable"), 0.0),
                named("last", plain()?),
            ],
            None,
        ),
        0.0,
    )?;
    close(want.mean(&skipped), 12.36125, 6);
    close(want.mean(&without), want.mean(&skipped), 12);
    close(want.step_stats(&skipped, "last").live.advantage(), 0.55, 12);
    for damage in [0.0, 10.0, 20.0, 30.0] {
        let a = want.pmf(&skipped).p_at(damage);
        let b = want.pmf(&without).p_at(damage);
        close(a, b, 12);
    }
    want.done();
    Ok(())
}

#[test]
fn chance_0_5_keeps_the_grant_for_the_next_attack_half_the_time() -> T {
    let mut want = expect(
        FILE,
        &grant_name("chance 0.5 keeps the grant for the next attack half the time"),
    );
    let t = Turn::from_spec(
        spec(
            vec![
                atk(granter()?),
                chance_attack(plain()?, Some("skippable"), 0.5),
                named("last", plain()?),
            ],
            None,
        ),
        0.0,
    )?;
    close(want.mean(&t), 15.11125, 6);
    close(want.step_stats(&t, "last").live.advantage(), 0.275, 12);
    want.done();
    Ok(())
}

fn enumeration(label: &str, swings: &[Swing]) -> T {
    let mut want = expect(
        FILE,
        &grant_name(&format!("matches the enumeration: {label}")),
    );
    for scale in [0.0, 0.5, 1.0] {
        let shaped: Vec<Swing> = swings
            .iter()
            .map(|s| Swing {
                chance: if s.chance == 1.0 {
                    1.0
                } else {
                    s.chance * scale
                },
                ..*s
            })
            .collect();
        let mut attacks = Vec::new();
        for (index, swing) in shaped.iter().enumerate() {
            let source = if swing.grants { granter()? } else { plain()? };
            attacks.push(chance_attack(
                source,
                Some(&format!("swing {index}")),
                swing.chance,
            ));
        }
        let t = Turn::from_spec(spec(attacks, None), 0.0)?;
        let (mean, live) = grant_oracle(&shaped);
        close(want.mean(&t), mean, 10);
        for (index, expected) in live.iter().enumerate() {
            close(
                want.step_stats(&t, &format!("swing {index}"))
                    .live
                    .advantage(),
                *expected,
                10,
            );
        }
    }
    want.done();
    Ok(())
}

#[test]
fn matches_the_enumeration_granter_skippable_plain_plain() -> T {
    enumeration(
        "granter, skippable plain, plain",
        &[sw(true, 1.0), sw(false, 0.5), sw(false, 1.0)],
    )
}

#[test]
fn matches_the_enumeration_granter_two_skippable_plains_plain() -> T {
    enumeration(
        "granter, two skippable plains, plain",
        &[
            sw(true, 1.0),
            sw(false, 0.3),
            sw(false, 0.6),
            sw(false, 1.0),
        ],
    )
}

#[test]
fn matches_the_enumeration_skippable_granter_twice_plain() -> T {
    enumeration(
        "skippable granter twice, plain",
        &[sw(true, 0.4), sw(true, 0.7), sw(false, 1.0)],
    )
}

#[test]
fn matches_the_enumeration_granter_skippable_granter_plain() -> T {
    enumeration(
        "granter, skippable granter, plain",
        &[sw(true, 1.0), sw(true, 0.25), sw(false, 1.0)],
    )
}

#[test]
fn matches_the_enumeration_skippable_plain_first_granter_plain() -> T {
    enumeration(
        "skippable plain first, granter, plain",
        &[sw(false, 0.5), sw(true, 1.0), sw(false, 1.0)],
    )
}
