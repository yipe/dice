//! `src/turn/dice-match.test.ts`: 20 tests (the `it` loops over the Chromatic Orb rows and over 2..5 dice are one Rust test each: 15 `#[test]`s), 9 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::common::DiceMatchInfo;
use crate::common::bounce::calculate_bounce_odds;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, FirstHitOptions};
use crate::turn::types::{MAX_TRIGGER_GROUPS, RiderOptions, TurnSpecErrorCode};
use crate::turn::{Turn, bounce, turn};
use crate::{Damage, Pmf};
use std::collections::{BTreeMap, BTreeSet};

const FILE: &str = "src/turn/dice-match.test.ts";

/// `expect(a).toBeCloseTo(b, digits)` as a boolean.
fn is_close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

/// `roll(count, d8)`.
fn pool(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

/// Mass-weighted average of `info`'s per-damage match probability over `pmf`'s own bins.
fn aggregate_match_probability(hit_or_crit: &Pmf, info: &DiceMatchInfo) -> f64 {
    let mass = hit_or_crit.mass();
    if mass <= 0.0 {
        return 0.0;
    }
    let mut weighted = 0.0;
    for d in hit_or_crit.support() {
        weighted += hit_or_crit.p_at(d.0)
            * info
                .match_probability_by_damage
                .get(&d)
                .copied()
                .unwrap_or(0.0);
    }
    weighted / mass
}

fn chromatic_orb(base_dice: f64) -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(17.0)?.on_hit(pool(base_dice, d8())?)
}

fn calculate(count: f64, faces: f64) -> Result<f64, DiceError> {
    calculate_bounce_odds(count, faces, None)
}

/// `roll(1, sides)`.
fn one_die(sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(1.0, sides, None)
}

// ---- AttackBuilder.diceMatchInfo() — per-level Chromatic Orb match odds ---------------------------

#[test]
fn per_level_chromatic_orb_match_odds() -> T {
    // Oracle rule: baseDice(level) = level + 2, crit dice = 2 * baseDice.
    let rows = [
        (3.0, 0.343750, 0.923096),
        (4.0, calculate(4.0, 8.0)?, 0.997597),
        (5.0, calculate(5.0, 8.0)?, 1.0),
    ];
    for (base_dice, hit_p, crit_p) in rows {
        let attack = chromatic_orb(base_dice)?;
        let resolved = attack.resolve(0.0)?;
        let (hit, crit) = attack.dice_match_info(0.0)?;
        let hit = hit.ok_or("level: hit info is null")?;
        let crit = crit.ok_or("level: crit info is null")?;
        let on_hit = aggregate_match_probability(&resolved.hit, &hit);
        let on_crit = aggregate_match_probability(&resolved.crit, &crit);
        close(on_hit, hit_p, 5);
        close(on_crit, crit_p, 5);
        // Cross-check against the independent calculateBounceOdds implementation directly.
        close(on_hit, calculate(base_dice, 8.0)?, 10);
        close(on_crit, calculate(base_dice * 2.0, 8.0)?, 10);
    }
    Ok(())
}

#[test]
fn no_crit_has_no_crit_branch_and_no_crit_match_info() -> T {
    let attack = chromatic_orb(3.0)?.no_crit()?;
    assert!(attack.dice_match_info(0.0)?.1.is_none());
    Ok(())
}

#[test]
fn a_keep_best_of_pool_has_no_match_info() -> T {
    // Its crit cannot auto-double (an ambiguous keep), so it states one explicitly.
    let attack = d20()
        .plus(5.0)?
        .ac(17.0)?
        .on_hit(pool(4.0, d8())?.keep_highest(4.0, 3.0)?)?
        .on_crit(&[Arg::Roll(pool(8.0, d8())?.keep_highest(8.0, 6.0)?)])?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert!(hit.is_none());
    assert!(crit.is_none());
    Ok(())
}

#[test]
fn a_single_die_is_a_supported_source_with_zero_match_probability_not_a_missing_descriptor() -> T {
    let attack = d20().plus(5.0)?.ac(17.0)?.on_hit(pool(1.0, d8())?)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    // Hit pool is 1 die: supported, but can never match: non-null, empty map.
    let hit = hit.ok_or("the hit descriptor is null")?;
    assert_eq!(hit.match_probability_by_damage.len(), 0);
    // Crit pool auto-doubles to 2 dice: can match.
    let crit = crit.ok_or("the crit descriptor is null")?;
    assert!(!crit.match_probability_by_damage.is_empty());
    Ok(())
}

// ---- dice-match trigger — validation -------------------------------------------------------------

const VALIDATION: &str = "dice-match trigger — validation";

#[test]
fn naming_a_bare_pmf_source_is_a_no_dice_descriptor_turn_spec_error() -> T {
    // An outcome-labelled PMF, but a bare PMF has no diceMatchInfo() capability at all: distinct
    // from a supported source that simply can't match (a single die), which must NOT throw.
    let bare_pmf = chromatic_orb(3.0)?.to_pmf(0.0)?;
    let result = turn(vec![atk(bare_pmf)], 0.0)?.on_dice_match_with(
        &["attack 1"],
        chromatic_orb(3.0)?,
        RiderOptions::default(),
    );
    assert_eq!(spec_code(result), TurnSpecErrorCode::NoDiceDescriptor);
    Ok(())
}

#[test]
fn a_one_die_hit_pool_with_a_matchable_auto_doubled_crit_pool_does_not_throw() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{VALIDATION} > a one-die hit pool with a matchable auto-doubled crit pool does NOT throw (regression: null used to mean both 'unsupported' and 'can't match')"
        ),
    );
    let attack = d20().plus(5.0)?.ac(17.0)?.on_hit(pool(1.0, d8())?)?;
    let t = turn(vec![atk(attack)], 0.0)?.on_dice_match_with(
        &["attack 1"],
        chromatic_orb(3.0)?,
        RiderOptions::default(),
    )?;
    want.mean(&t);
    want.done();
    Ok(())
}

#[test]
fn a_turn_with_no_dice_match_trigger_never_computes_match_info() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{VALIDATION} > a turn with no dice-match trigger never computes match info (no thrown error, no slicing)"
        ),
    );
    let t = turn(vec![atk(chromatic_orb(3.0)?)], 0.0)?
        .on_first_hit_with(one_die(8.0)?, FirstHitOptions::default())?;
    want.mean(&t);
    want.done();
    Ok(())
}

// ---- dice-match trigger — MATCH_BIT sharing a group with a first-hit trigger ----------------------

#[test]
fn a_first_hit_rider_still_fires_in_crit_mode_when_its_group_also_matched() -> T {
    let mut want = expect(
        FILE,
        "dice-match trigger — MATCH_BIT sharing a group with a first-hit trigger (regression) > a first-hit rider still fires in crit mode when its group also matched",
    );
    // Deterministic: every landed attack crits, so `first` is ALWAYS FIRST_CRIT once the attack
    // lands, whether or not the dice also matched. Sharing the group with a `dice-match` rider sets
    // MATCH_BIT (bit 4) on the SAME code whenever a match also occurs; it must not corrupt the
    // `first` field's `code >> 2` decode.
    let attack = d20()
        .always_hits()?
        .always_crits()?
        .on_hit(pool(3.0, d8())?)?;
    let p_match = calculate(6.0, 8.0)?; // crit doubles 3d8 -> 6d8

    let first_hit = FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                of: Some(vec!["attack 1".to_string()]),
                ..RiderOptions::default()
            },
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    };
    let t = turn(vec![atk(attack)], 0.0)?
        .on_first_hit_with(one_die(4.0)?, first_hit)? // crit-doubles to 2d4 (mean 5) on a crit
        .on_dice_match_with(&["attack 1"], one_die(1.0)?, rid("match-marker"))?; // +2 when matched

    // attack mean(6d8)=27 + firstHit ALWAYS crit-mode mean(2d4)=5 + match-marker fires w.p. pMatch
    let expected_mean = 27.0 + 5.0 + p_match * 2.0;
    close(want.mean(&t), expected_mean, 9);

    // The buggy decode instead read a matched crit as non-crit, undercounting.
    let buggy_mean = 27.0 + (p_match * 2.5 + (1.0 - p_match) * 5.0) + p_match * 2.0;
    assert!(!is_close(want.mean(&t), buggy_mean, 2));
    want.done();
    Ok(())
}

// ---- dice-match trigger — brute-force enumeration agreement, pools <= 5d8 -------------------------

/// P(sum) of the rolls of `dice` d`faces` that show a repeated face, by listing every roll.
fn brute_force_match_distribution(dice: usize, faces: usize) -> BTreeMap<i64, f64> {
    let total = faces.pow(dice as u32);
    let mut dist: BTreeMap<i64, f64> = BTreeMap::new();
    let mut rolls = vec![1usize; dice];
    for _ in 0..total {
        let sum: usize = rolls.iter().sum();
        let seen: BTreeSet<usize> = rolls.iter().copied().collect();
        if seen.len() < dice {
            *dist.entry(sum as i64).or_insert(0.0) += 1.0 / total as f64;
        }
        // odometer increment
        let mut i = 0;
        while i < dice {
            rolls[i] += 1;
            if rolls[i] <= faces {
                break;
            }
            rolls[i] = 1;
            i += 1;
        }
    }
    dist
}

#[test]
fn exact_per_sum_match_distribution_matches_brute_force_enumeration() -> T {
    for dice in [2usize, 3, 4, 5] {
        let attack = d20().always_hits()?.on_hit(pool(dice as f64, d8())?)?;
        let hit = attack.dice_match_info(0.0)?.0.ok_or("hit info is null")?;
        let hit_pmf = attack.resolve(0.0)?.hit;
        let brute = brute_force_match_distribution(dice, 8);

        let mut all_sums: BTreeSet<i64> = hit_pmf.support().iter().map(|d| d.0 as i64).collect();
        all_sums.extend(brute.keys().copied());
        for sum in all_sums {
            let by_damage = hit
                .match_probability_by_damage
                .get(&Damage(sum as f64))
                .copied()
                .unwrap_or(0.0);
            let exact_match_mass = hit_pmf.p_at(sum as f64) * by_damage;
            let brute_mass = brute.get(&sum).copied().unwrap_or(0.0);
            close(exact_match_mass, brute_mass, 9);
        }
    }
    Ok(())
}

// ---- bounce() sugar and two-beam correlation -----------------------------------------------------

const BOUNCE: &str = "bounce() sugar and two-beam correlation";

#[test]
fn bounce_expands_to_a_first_attack_plus_max_attack_shaped_dice_match_riders() -> T {
    let t = bounce(chromatic_orb(3.0)?.into(), 2.0)?;
    assert_eq!(t.attack_ids()?, vec!["attack 1".to_string()]);
    assert_eq!(
        t.rider_ids()?,
        vec!["bounce 1".to_string(), "bounce 2".to_string()]
    );
    Ok(())
}

#[test]
fn bounce_max_0_is_just_the_first_beam_no_riders() -> T {
    let t = bounce(chromatic_orb(3.0)?.into(), 0.0)?;
    assert_eq!(t.rider_ids()?, Vec::<String>::new());
    Ok(())
}

#[test]
fn bounce_rejects_a_negative_or_non_integer_max() -> T {
    assert!(matches!(
        bounce(chromatic_orb(3.0)?.into(), -1.0),
        Err(DiceError::Range(_))
    ));
    assert!(matches!(
        bounce(chromatic_orb(3.0)?.into(), 1.5),
        Err(DiceError::Range(_))
    ));
    Ok(())
}

#[test]
fn a_chain_longer_than_the_trigger_group_budget_resolves() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{BOUNCE} > a chain longer than the trigger-group budget resolves: a beam's group dies after its one reader"
        ),
    );
    let groups = MAX_TRIGGER_GROUPS as f64;
    let past = bounce(chromatic_orb(3.0)?.into(), groups + 1.0)?;
    assert_eq!(past.rider_ids()?.len(), MAX_TRIGGER_GROUPS + 1);
    // Each extra beam can only add: the chain of 10 follow-on beams out-deals the chain of 9.
    let past_mean = want.mean(&past);
    let at_budget = want.mean(&bounce(chromatic_orb(3.0)?.into(), groups)?);
    assert!(past_mean > at_budget);
    // `inspectTurn` resolves the turn again (the third recorded `mean`).
    want.mean(&past);
    assert_eq!(past.inspect_turn()?.0, 2);
    want.done();
    Ok(())
}

#[test]
fn two_beam_chain_at_p_hit_0_6_3d8_mean_9_770625_variance_92_944() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{BOUNCE} > two-beam chain at pHit=0.6, 3d8: mean 9.770625, variance 92.944 (not the scalar-gate 74.902)"
        ),
    );
    // The oracle is the simple two-outcome model: X = 1{hit}·(plain 3d8 sum), no crit-doubling.
    // noCrit() folds crit mass into hit at the same 3d8 dice. An AC where exactly 12 of 20 face
    // values (9-20) succeed gives pHit = 0.6 precisely.
    let attack = d20()
        .plus(0.0)?
        .ac(9.0)?
        .on_hit(pool(3.0, d8())?)?
        .no_crit()?;
    let resolution = attack.resolve(0.0)?;
    close(resolution.weights.hit, 0.6, 10);
    assert_eq!(resolution.weights.crit, 0.0);

    let t = bounce(attack.into(), 1.0)?;
    let pmf = want.pmf(&t);

    close(pmf.mean(), 9.770625, 3);
    close(pmf.variance(), 92.944, 1);
    assert!(!is_close(pmf.variance(), 74.902, 0));
    want.done();
    Ok(())
}

// ---- dice-match walk latency at MAX_TRIGGER_GROUPS depth -----------------------------------------

#[test]
fn reports_latency_for_a_9_deep_bounce_chain() -> T {
    let mut want = expect(
        FILE,
        "dice-match walk latency at MAX_TRIGGER_GROUPS depth (measurement only, never fails the build) > reports latency for a 9-deep bounce chain",
    );
    let source = chromatic_orb(3.0)?;
    let start = std::time::Instant::now();
    let t: Turn = bounce(source.into(), MAX_TRIGGER_GROUPS as f64)?;
    want.mean(&t);
    println!(
        "bounce({{max: {MAX_TRIGGER_GROUPS}}}) resolve latency: {:.2}ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(t.rider_ids()?.len(), MAX_TRIGGER_GROUPS);
    want.done();
    Ok(())
}
