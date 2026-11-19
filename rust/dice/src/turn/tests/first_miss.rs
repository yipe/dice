//! `src/turn/first-miss.test.ts`: 6 tests, 45 compat calls.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::turn::effects::{ConditionOptions, FirstHitOptions};
use crate::turn::types::AttacksOptions;
use crate::turn::types::{
    AttackOptions, DamageSource, Rider, RiderDamage, RiderDamageSpec, RiderOptions, Trigger,
    TurnSpec,
};
use crate::turn::{Turn, turn};

const FILE: &str = "src/turn/first-miss.test.ts";
const SUITE: &str = "first-miss (R27)";

fn name(test: &str) -> String {
    format!("{SUITE} > {test}")
}

fn expect_same_pmf(actual: &Pmf, expected: &Pmf, tolerance: f64) {
    let mut support = actual.support();
    support.extend(expected.support());
    let mut worst: f64 = 0.0;
    for value in support {
        worst = worst.max((actual.p_at(value.0) - expected.p_at(value.0)).abs());
    }
    assert!(worst < tolerance, "max pmf difference {worst}");
}

fn not_close(actual: f64, expected: f64, digits: i32) {
    assert!(
        (actual - expected).abs() >= 10f64.powi(-digits) / 2.0,
        "{actual} is close to {expected} at {digits} digits"
    );
}

/// `[miss, hit, crit]` for `d20 + bonus` against `ac`, crit on a natural 20 only.
fn outcome_odds(bonus: f64, ac: f64) -> [f64; 3] {
    let mut odds = [0.0; 3];
    for r in 1..=20 {
        let r = f64::from(r);
        let mode = if r == 20.0 {
            2
        } else if r == 1.0 || r + bonus < ac {
            0
        } else {
            1
        };
        odds[mode] += 1.0 / 20.0;
    }
    odds
}

/// Enumerating the rules text: two muskets, then two unarmed strikes, one reroll of the first
/// missed musket, and a `1d10` rider on the first landing among the muskets and the reroll (plus
/// the unarmed strikes when `rider_watches_unarmed`), doubled on a crit.
fn o16_mean(ac: f64, first_miss: bool, rider_watches_unarmed: bool) -> f64 {
    let musket = outcome_odds(9.0, ac);
    let unarmed = outcome_odds(11.0, ac);
    let musket_damage = [0.0, 24.5, 31.0];
    let unarmed_damage = [0.0, 10.5, 16.0];
    let rider_damage = [0.0, 5.5, 11.0];

    let mut mean = 0.0;
    for one in 0..3 {
        for two in 0..3 {
            for three in 0..3 {
                for four in 0..3 {
                    for reroll in 0..3 {
                        let rerolls = one == 0 || two == 0;
                        // The reroll's own outcome only exists when a musket missed.
                        let p_reroll = if rerolls {
                            musket[reroll]
                        } else if reroll == 0 {
                            1.0
                        } else {
                            0.0
                        };
                        let p =
                            musket[one] * musket[two] * unarmed[three] * unarmed[four] * p_reroll;
                        if p == 0.0 {
                            continue;
                        }
                        let strikes: Vec<usize> = if rider_watches_unarmed {
                            vec![three, four]
                        } else {
                            vec![]
                        };
                        let reroll_slot: Vec<usize> = if rerolls { vec![reroll] } else { vec![] };
                        let sequence: Vec<usize> = if first_miss && one == 0 {
                            [reroll_slot, vec![two], strikes].concat()
                        } else if first_miss {
                            [vec![one, two], reroll_slot, strikes].concat()
                        } else {
                            [vec![one, two], strikes, reroll_slot].concat()
                        };
                        let first = sequence
                            .iter()
                            .copied()
                            .find(|mode| *mode != 0)
                            .unwrap_or(0);
                        let damage = musket_damage[one]
                            + musket_damage[two]
                            + unarmed_damage[three]
                            + unarmed_damage[four]
                            + (if rerolls { musket_damage[reroll] } else { 0.0 })
                            + rider_damage[first];
                        mean += p * damage;
                    }
                }
            }
        }
    }
    mean
}

fn tagged(tag: &str) -> AttackOptions {
    AttackOptions {
        tag: Some(tag.to_string()),
        ..AttackOptions::default()
    }
}

fn riding(id: Option<&str>, of: &[&str]) -> RiderOptions {
    RiderOptions {
        id: id.map(str::to_string),
        of: Some(of.iter().map(std::string::ToString::to_string).collect()),
        ..RiderOptions::default()
    }
}

fn first_hit_of(of: &[&str]) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: riding(None, of),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn o16_turn(
    ac: f64,
    first_miss: bool,
    rider_watches_unarmed: bool,
) -> Result<Turn, Box<dyn std::error::Error>> {
    let musket = attack_roll(9.0, ac, rs(1.0, 12.0)?.plus(18.0)?)?;
    let unarmed = attack_roll(11.0, ac, rs(1.0, 10.0)?.plus(5.0)?)?;
    let base = turn(vec![], 0.0)?
        .attack_with(musket.clone(), tagged("musket"))?
        .attack_with(musket.clone(), tagged("musket"))?
        .attacks_with(
            2.0,
            unarmed,
            AttacksOptions {
                tag: Some("unarmed".to_string()),
                chance: None,
            },
        )?;
    let reroll = riding(Some("reroll"), &["musket"]);
    let with_reroll = if first_miss {
        base.on_first_miss_with(musket, reroll)?
    } else {
        base.on_any_miss_with(musket, reroll)?
    };
    let watched: &[&str] = if rider_watches_unarmed {
        &["musket", "reroll", "unarmed"]
    } else {
        &["musket", "reroll"]
    };
    Ok(with_reroll.on_first_hit_with(rs(1.0, 10.0)?, first_hit_of(watched))?)
}

#[test]
fn o13_identical_to_any_miss_on_two_identical_muskets_the_symmetry_argument() -> T {
    let mut want = expect(
        FILE,
        &name("O13: identical to any-miss on two identical muskets — the symmetry argument"),
    );
    let rows = [
        (15.0, 46.9, 56.23125),
        (18.0, 38.305, 49.533),
        (21.0, 29.4625, 40.342875),
    ];
    for (ac, base, with_reroll) in rows {
        let musket = attack_roll(9.0, ac, rs(1.0, 12.0)?.plus_dice(1.0, &d4())?.plus(18.0)?)?;
        let pair = turn(vec![atk(musket.clone()), atk(musket.clone())], 0.0)?;
        let d10_rider = || rs(1.0, 10.0);
        close(
            want.mean(&pair.on_first_hit_with(d10_rider()?, FirstHitOptions::default())?),
            base,
            4,
        );
        let any_miss = pair
            .on_any_miss_with(musket.clone(), RiderOptions::default())?
            .on_first_hit_with(d10_rider()?, FirstHitOptions::default())?;
        let first_miss = pair
            .on_first_miss_with(musket, RiderOptions::default())?
            .on_first_hit_with(d10_rider()?, FirstHitOptions::default())?;
        // Exact rational value; assert precisely (a 4dp boundary at AC 15 passes or fails on float noise).
        close(want.mean(&any_miss), with_reroll, 10);
        close(want.mean(&first_miss), with_reroll, 10);
        let first_pmf = want.pmf(&first_miss);
        let any_pmf = want.pmf(&any_miss);
        expect_same_pmf(&first_pmf, &any_pmf, 1e-12);
    }
    want.done();
    Ok(())
}

#[test]
fn o16_identical_to_any_miss_too_the_only_order_reading_rider_watches_the_muskets_and_the_reroll()
-> T {
    let mut want = expect(
        FILE,
        &name(
            "O16: identical to any-miss too — the only order-reading rider watches the muskets and the reroll, which are i.i.d.",
        ),
    );
    for (ac, plan_any_miss) in [(15.0, 69.75625), (18.0, 60.493), (21.0, 48.946)] {
        let any_miss = o16_turn(ac, false, false)?;
        let first_miss = o16_turn(ac, true, false)?;
        // Exact rational value; AC 15 sits exactly on a 4dp boundary.
        close(want.mean(&any_miss), plan_any_miss, 10);
        assert!((want.mean(&any_miss) - o16_mean(ac, false, false)).abs() < 1e-9);
        assert!((want.mean(&first_miss) - o16_mean(ac, true, false)).abs() < 1e-9);
        let first_pmf = want.pmf(&first_miss);
        let any_pmf = want.pmf(&any_miss);
        expect_same_pmf(&first_pmf, &any_pmf, 1e-12);
    }
    want.done();
    Ok(())
}

#[test]
fn differs_from_any_miss_once_an_order_reading_rider_also_watches_attacks_the_reroll_is_not_iid_with()
-> T {
    let mut want = expect(
        FILE,
        &name(
            "differs from any-miss once an order-reading rider also watches attacks the reroll is not i.i.d. with",
        ),
    );
    for ac in [15.0, 18.0, 21.0] {
        let any_miss = want.mean(&o16_turn(ac, false, true)?);
        let first_miss = want.mean(&o16_turn(ac, true, true)?);
        assert!((any_miss - o16_mean(ac, false, true)).abs() < 1e-9);
        assert!((first_miss - o16_mean(ac, true, true)).abs() < 1e-9);
        not_close(first_miss, any_miss, 4);
    }
    want.done();
    Ok(())
}

#[test]
fn fires_once_on_the_first_miss_as_often_as_any_miss_and_never_twice() -> T {
    let mut want = expect(
        FILE,
        &name("fires once, on the first miss: as often as any-miss, and never twice"),
    );
    let sword: AttackBuilder = attack_roll(5.0, 15.0, rs(1.0, 6.0)?.plus(3.0)?)?;
    let three = turn(
        vec![atk(sword.clone()), atk(sword.clone()), atk(sword)],
        0.0,
    )?;
    let first = three.on_first_miss_with(rs(2.0, 6.0)?, rid("consolation"))?;
    let any = three.on_any_miss_with(rs(2.0, 6.0)?, rid("consolation"))?;
    close(want.fire(&first, "consolation"), 1.0 - 0.55f64.powi(3), 12);
    let first_fire = want.fire(&first, "consolation");
    close(first_fire, want.fire(&any, "consolation"), 12);
    let first_pmf = want.pmf(&first);
    let any_pmf = want.pmf(&any);
    expect_same_pmf(&first_pmf, &any_pmf, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn an_attack_shaped_first_miss_rider_joins_later_defaulted_of_sets_r18() -> T {
    let mut want = expect(
        FILE,
        &name("an attack-shaped first-miss rider joins later defaulted `of` sets (R18)"),
    );
    let sword = attack_roll(5.0, 15.0, rs(1.0, 6.0)?.plus(3.0)?)?;
    let joined = turn(vec![atk(sword.clone()), atk(sword.clone())], 0.0)?
        .on_first_miss_with(sword.clone(), rid("reroll"))?
        .on_first_hit_with(rs(1.0, 10.0)?, FirstHitOptions::default())?;
    let explicit = turn(vec![atk(sword.clone()), atk(sword.clone())], 0.0)?
        .on_first_miss_with(sword, rid("reroll"))?
        .on_first_hit_with(
            rs(1.0, 10.0)?,
            first_hit_of(&["attack 1", "attack 2", "reroll"]),
        )?;
    let joined_pmf = want.pmf(&joined);
    let explicit_pmf = want.pmf(&explicit);
    expect_same_pmf(&joined_pmf, &explicit_pmf, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn round_trips_through_turn_from_as_plain_data() -> T {
    let mut want = expect(FILE, &name("round-trips through Turn.from as plain data"));
    let sword = attack_roll(5.0, 15.0, rs(1.0, 6.0)?.plus(3.0)?)?;
    let from_spec = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword.clone()), atk(sword.clone())],
            riders: Some(vec![Rider {
                trigger: Trigger::FirstMiss { of: None },
                id: Some("reroll".to_string()),
                damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Attack(Box::new(
                    sword.clone(),
                )))),
                crit_damage: None,
                landing: None,
                happens: None,
                joins: None,
                r#where: None,
                target_has: None,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let chained = turn(vec![atk(sword.clone()), atk(sword.clone())], 0.0)?
        .on_first_miss_with(sword, rid("reroll"))?;
    let spec_pmf = want.pmf(&from_spec);
    let chained_pmf = want.pmf(&chained);
    expect_same_pmf(&spec_pmf, &chained_pmf, 1e-12);
    want.done();
    Ok(())
}
