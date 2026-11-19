//! `tests/turn-exactness.test.ts`: 12 tests, 20 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::error::DiceError;
use crate::query::Labels;
use crate::turn::turn;
use crate::turn::types::{Rider, RiderDamage, RiderDamageSpec, Trigger};
use crate::{DiceQuery, EPS, Pmf};

const FILE: &str = "tests/turn-exactness.test.ts";

fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(4.0)?)
}

fn rider(trigger: Trigger, id: Option<&str>, damage: impl Into<RiderDamage>) -> Rider {
    Rider {
        trigger,
        id: id.map(str::to_string),
        damage: RiderDamageSpec::Plain(damage.into()),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn first_hit() -> Trigger {
    Trigger::FirstHit {
        of: None,
        per_source: None,
    }
}
fn every_hit_on() -> Trigger {
    Trigger::EveryHit {
        of: None,
        max: None,
        per_source: None,
    }
}
fn any_hit() -> Labels {
    Labels::Many(vec!["hit".to_string(), "crit".to_string()])
}
fn crit_only() -> Labels {
    Labels::One("crit".to_string())
}

#[derive(Clone, Copy, PartialEq)]
enum Outcome {
    Hit,
    Crit,
    Miss,
}

const OUTCOMES: [Outcome; 3] = [Outcome::Hit, Outcome::Crit, Outcome::Miss];

struct Slices {
    hit: Pmf,
    crit: Pmf,
    miss: Pmf,
}

impl Slices {
    fn new() -> Result<Slices, DiceError> {
        let pmf = dagger()?.pmf()?;
        Ok(Slices {
            hit: pmf.filter_outcome("hit"),
            crit: pmf.filter_outcome("crit"),
            miss: pmf.filter_outcome("missNone"),
        })
    }

    fn of(&self, outcome: Outcome) -> &Pmf {
        match outcome {
            Outcome::Hit => &self.hit,
            Outcome::Crit => &self.crit,
            Outcome::Miss => &self.miss,
        }
    }
}

type RiderFor<'a> = dyn Fn(&[Outcome]) -> Result<Vec<Pmf>, DiceError> + 'a;

/// Independent oracle: enumerate every outcome sequence for `n` identical attacks and let the
/// caller add rider damage for that sequence.
fn brute_force(
    n: usize,
    rider_for: impl Fn(&[Outcome]) -> Result<Vec<Pmf>, DiceError>,
) -> Result<Pmf, DiceError> {
    fn walk(
        n: usize,
        sequence: &mut Vec<Outcome>,
        slices: &Slices,
        rider_for: &RiderFor<'_>,
        branches: &mut Vec<(Pmf, f64)>,
    ) -> Result<(), DiceError> {
        if sequence.len() == n {
            let mut parts = sequence.iter().map(|o| slices.of(*o).clone());
            let first = parts.next().ok_or("empty sequence")?;
            let mut branch = parts.fold(first, |all, part| all.convolve(&part, None, true));
            for r in rider_for(sequence)? {
                branch = branch.convolve(&r, None, true);
            }
            branches.push((branch.normalize(), branch.mass()));
            return Ok(());
        }
        for outcome in OUTCOMES {
            sequence.push(outcome);
            walk(n, sequence, slices, rider_for, branches)?;
            sequence.pop();
        }
        Ok(())
    }

    let slices = Slices::new()?;
    let mut branches: Vec<(Pmf, f64)> = Vec::new();
    let mut sequence: Vec<Outcome> = Vec::new();
    walk(n, &mut sequence, &slices, &rider_for, &mut branches)?;
    Pmf::exclusive(&branches, EPS)
}

fn expect_same_pmf(actual: &Pmf, expected: &Pmf) {
    let mut support: Vec<f64> = actual
        .support()
        .iter()
        .chain(expected.support().iter())
        .map(|d| d.0)
        .collect();
    support.sort_by(f64::total_cmp);
    support.dedup();
    for value in support {
        close(actual.p_at(value), expected.p_at(value), 10);
    }
    close(actual.mass(), 1.0, 10);
}

fn first_landing(sequence: &[Outcome]) -> Option<Outcome> {
    sequence.iter().copied().find(|o| *o != Outcome::Miss)
}

fn sneak() -> Result<RollBuilder, DiceError> {
    rs(3.0, 6.0)
}

const SUITE: &str = "Turn exactness vs brute force";

#[test]
fn matches_a_hand_enumerated_first_hit_rider_over_two_attacks() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > matches a hand-enumerated first-hit rider over two attacks"),
    );
    let d = dagger()?;
    let t = turn(vec![atk(d.clone()), atk(d)], 0.0)?.rider(rider(first_hit(), None, sneak()?))?;
    let actual = want.pmf(&t);
    let expected = brute_force(2, |sequence| {
        Ok(match first_landing(sequence) {
            None => vec![],
            Some(Outcome::Crit) => vec![sneak()?.double_dice()?.pmf()?],
            Some(_) => vec![sneak()?.pmf()?],
        })
    })?;
    expect_same_pmf(&actual, &expected);
    want.done();
    Ok(())
}

#[test]
fn matches_over_three_attacks_with_two_riders_sharing_one_trigger() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > matches over three attacks with two riders sharing one trigger"),
    );
    let d = dagger()?;
    let t = turn(vec![atk(d.clone()), atk(d.clone()), atk(d)], 0.0)?
        .rider(rider(first_hit(), None, sneak()?))?
        .rider(rider(first_hit(), None, d10()))?;
    let actual = want.pmf(&t);
    let expected = brute_force(3, |sequence| {
        Ok(match first_landing(sequence) {
            None => vec![],
            Some(first) => {
                let crit = first == Outcome::Crit;
                vec![
                    if crit {
                        sneak()?.double_dice()?.pmf()?
                    } else {
                        sneak()?.pmf()?
                    },
                    if crit {
                        d10().double_dice()?.pmf()?
                    } else {
                        d10().pmf()?
                    },
                ]
            }
        })
    })?;
    expect_same_pmf(&actual, &expected);
    want.done();
    Ok(())
}

#[test]
fn matches_any_crit_plus_its_not_fired_complement() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > matches any-crit plus its not-fired complement"),
    );
    let smite = rs(2.0, 8.0)?;
    let unarmed = attack_roll(8.0, 16.0, d6().plus(4.0)?)?;
    let d = dagger()?;
    let both = vec![
        crate::turn::types::DamageSource::Attack(Box::new(unarmed.clone())),
        crate::turn::types::DamageSource::Attack(Box::new(unarmed.clone())),
    ];
    let t = turn(vec![atk(d.clone()), atk(d)], 0.0)?
        .rider(rider(
            Trigger::AnyCrit {
                of: None,
                max: None,
            },
            Some("smite"),
            smite.clone(),
        ))?
        .rider(rider(
            Trigger::NotFired {
                of: "smite".to_string(),
            },
            None,
            both,
        ))?;
    let actual = want.pmf(&t);
    let up = unarmed.pmf()?;
    let flurry = up.convolve(&up, None, false);
    let expected = brute_force(2, |sequence| {
        Ok(if sequence.contains(&Outcome::Crit) {
            vec![smite.double_dice()?.pmf()?]
        } else {
            vec![flurry.clone()]
        })
    })?;
    expect_same_pmf(&actual, &expected);
    want.done();
    Ok(())
}

#[test]
fn matches_any_miss_the_reroll_gate() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > matches any-miss (the reroll gate)"),
    );
    let d = dagger()?;
    let t = turn(vec![atk(d.clone()), atk(d.clone())], 0.0)?.rider(rider(
        Trigger::AnyMiss { of: None },
        None,
        d.clone(),
    ))?;
    let actual = want.pmf(&t);
    let dagger_pmf = d.pmf()?;
    let expected = brute_force(2, |sequence| {
        Ok(if sequence.contains(&Outcome::Miss) {
            vec![dagger_pmf.clone()]
        } else {
            vec![]
        })
    })?;
    expect_same_pmf(&actual, &expected);
    want.done();
    Ok(())
}

#[test]
fn matches_every_hit_once_per_landing_attack() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > matches every-hit (once per landing attack)"),
    );
    let mark = d6();
    let d = dagger()?;
    let t = turn(vec![atk(d.clone()), atk(d)], 0.0)?.rider(rider(
        every_hit_on(),
        None,
        mark.clone(),
    ))?;
    let actual = want.pmf(&t);
    let expected = brute_force(2, |sequence| {
        sequence
            .iter()
            .filter(|o| **o != Outcome::Miss)
            .map(|o| {
                if *o == Outcome::Crit {
                    mark.double_dice()?.pmf()
                } else {
                    mark.pmf()
                }
            })
            .collect()
    })?;
    expect_same_pmf(&actual, &expected);
    want.done();
    Ok(())
}

#[test]
fn keeps_the_mean_but_fixes_the_distribution() -> T {
    let mut want = expect(
        FILE,
        "Turn vs the independent-convolution pattern > keeps the mean but fixes the distribution",
    );
    let d = dagger()?;
    let dagger_pmf = d.pmf()?;
    let exact =
        turn(vec![atk(d.clone()), atk(d)], 0.0)?.rider(rider(first_hit(), None, sneak()?))?;

    let attacks = DiceQuery::of(vec![dagger_pmf.clone(), dagger_pmf.clone()]);
    let [p_hit, p_crit, _, _] = attacks.first_success_split(&any_hit(), &crit_only(), EPS)?;
    let independent = DiceQuery::of(vec![
        dagger_pmf.clone(),
        dagger_pmf,
        Pmf::exclusive(
            &[
                (sneak()?.pmf()?, p_hit),
                (sneak()?.double_dice()?.pmf()?, p_crit),
            ],
            EPS,
        )?,
    ]);

    close(want.mean(&exact), independent.mean(), 10);
    close(want.mean(&exact), 18.6225, 4);

    // The old pattern under-reports whiff turns by 8x and the spread by 19%.
    close(want.pmf(&exact).p_at(0.0), 0.1225, 10);
    close(independent.combined().p_at(0.0), 0.01500625, 10);
    close(want.pmf(&exact).stdev(), 8.886, 3);
    close(independent.stddev(), 7.1825, 3);
    want.done();
    Ok(())
}

#[test]
fn fires_any_crit_on_p_at_least_one_crit_not_p_first_success_was_a_crit() -> T {
    let mut want = expect(
        FILE,
        "Turn probabilities > fires any-crit on P(>=1 crit), not P(first success was a crit)",
    );
    let smite = rs(2.0, 8.0)?;
    let d = dagger()?;
    let built = turn(vec![atk(d.clone()), atk(d.clone())], 0.0)?.rider(rider(
        Trigger::AnyCrit {
            of: None,
            max: None,
        },
        Some("smite"),
        smite.clone(),
    ))?;

    let dp = d.pmf()?;
    let attacks = DiceQuery::of(vec![dp.clone(), dp]);
    let p_any_crit = attacks.prob_at_least_one(crit_only());
    let [_, p_first_crit, _, _] = attacks.first_success_split(&any_hit(), &crit_only(), EPS)?;

    close(want.fire(&built, "smite"), p_any_crit, 10);
    close(p_any_crit, 0.0975, 6);
    close(p_first_crit, 0.0675, 6);

    let rider_mean = want.mean(&built) - attacks.mean();
    close(
        rider_mean,
        p_any_crit * smite.double_dice()?.pmf()?.mean(),
        8,
    );
    want.done();
    Ok(())
}

#[test]
fn makes_smite_and_its_not_fired_complement_mutually_exclusive() -> T {
    let mut want = expect(
        FILE,
        "Turn probabilities > makes smite and its not-fired complement mutually exclusive",
    );
    let d = dagger()?;
    let built = turn(vec![atk(d.clone()), atk(d)], 0.0)?
        .rider(rider(
            Trigger::AnyCrit {
                of: None,
                max: None,
            },
            Some("smite"),
            rs(2.0, 8.0)?,
        ))?
        .rider(rider(
            Trigger::NotFired {
                of: "smite".to_string(),
            },
            Some("flurry"),
            d6(),
        ))?;
    let p_smite = want.fire(&built, "smite");
    let p_flurry = want.fire(&built, "flurry");
    close(p_smite + p_flurry, 1.0, 10);
    want.done();
    Ok(())
}

#[test]
fn reports_p_at_least_one_hit_for_an_every_hit_rider() -> T {
    let mut want = expect(
        FILE,
        "Turn probabilities > reports P(at least one hit) for an every-hit rider",
    );
    let d = dagger()?;
    let built = turn(vec![atk(d.clone()), atk(d.clone())], 0.0)?.rider(rider(
        every_hit_on(),
        Some("mark"),
        d6(),
    ))?;
    let dp = d.pmf()?;
    let p_any_hit = DiceQuery::of(vec![dp.clone(), dp]).prob_at_least_one(any_hit());
    close(want.fire(&built, "mark"), p_any_hit, 10);
    want.done();
    Ok(())
}

#[test]
fn applies_an_every_hit_rider_once_per_landing_attack_not_once_per_turn() -> T {
    let mut want = expect(
        FILE,
        "Turn probabilities > applies an every-hit rider once per landing attack, not once per turn",
    );
    let d = dagger()?;
    let dp = d.pmf()?;
    let attacks = DiceQuery::of(vec![dp.clone(), dp]);
    let two = || turn(vec![atk(d.clone()), atk(d.clone())], 0.0);
    let per_hit = two()?.rider(rider(every_hit_on(), None, d6()))?;
    let once = two()?.rider(rider(first_hit(), None, d6()))?;

    // Per attack: P(hit) * E[d6] + P(crit) * E[2d6] = 0.6*3.5 + 0.05*7 = 2.45.
    close(want.mean(&per_hit) - attacks.mean(), 2.0 * 2.45, 8);

    // Once per turn: P(first is a plain hit) * E[d6] + P(first is a crit) * E[2d6].
    let [p_hit, p_crit, _, _] = attacks.first_success_split(&any_hit(), &crit_only(), EPS)?;
    close(
        want.mean(&once) - attacks.mean(),
        p_hit * 3.5 + p_crit * 7.0,
        8,
    );

    // Two attacks land often enough that "every hit" is only ~1.5x "once", not 2x.
    let ratio = (want.mean(&per_hit) - attacks.mean()) / (want.mean(&once) - attacks.mean());
    close(ratio, 1.4815, 3);
    want.done();
    Ok(())
}

#[test]
fn equals_a_plain_convolution_of_the_attacks() -> T {
    let mut want = expect(
        FILE,
        "Turn with no riders > equals a plain convolution of the attacks",
    );
    let d = dagger()?;
    let t = turn(vec![atk(d.clone()), atk(d.clone()), atk(d.clone())], 0.0)?;
    let actual = want.pmf(&t);
    let dp = d.pmf()?;
    let expected = Pmf::convolve_many(&[dp.clone(), dp.clone(), dp], EPS);
    expect_same_pmf(&actual, &expected.normalize());
    want.done();
    Ok(())
}

#[test]
fn exposes_the_declared_attacks_as_query_singles() -> T {
    let mut want = expect(
        FILE,
        "Turn with no riders > exposes the declared attacks as query singles",
    );
    let d = dagger()?;
    let t = turn(vec![atk(d.clone()), atk(d.clone())], 0.0)?;
    want.query(&t);
    let query = t.to_query()?;
    assert_eq!(query.singles.len(), 2);
    let dp = d.pmf()?;
    close(query.mean(), DiceQuery::of(vec![dp.clone(), dp]).mean(), 10);
    want.done();
    Ok(())
}
