//! `tests/sample-conformance.test.ts`: 23 tests (22 fixtures + the rider fire frequency; plus a guard that all 22 fixtures have one), 0 compat calls.
//!
//! The G-test/LCG helpers are ported in `sample_support`. Lowered for the debug profile: N = `20_000`
//! samples per fixture (TS default `100_000`, `DICE_SAMPLES`); thresholds as in the TS (G-test
//! p > 1e-6, mean within 5 standard errors, no structural fallback). The seeds are deterministic, so
//! a pass is the same every run. The 22 fixtures are one test each (a macro-free loop over
//! `fixtures()` would hide which one failed).

use super::helpers::T;
use super::sample_support::*;
use crate::turn::sample::SAMPLE_FALLBACKS;
use crate::turn::trace::OutcomeResult;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

const N: u64 = 20_000;

fn agrees_with_pmf(name: &str) -> T {
    let (_, build) = fixtures()
        .into_iter()
        .find(|(n, _)| *n == name)
        .ok_or("no such fixture")?;
    let t = build()?;
    let exact = t.pmf()?;
    let mut rng = lcg_rng(0x5eed_0001 + name.chars().count() as u32);
    let before = SAMPLE_FALLBACKS.load(Ordering::SeqCst);
    let mut counts: BTreeMap<i64, u64> = BTreeMap::new();
    let mut sum = 0.0;
    for _ in 0..N {
        let total = t.sample(&mut rng)?.total;
        sum += total;
        *counts.entry(total as i64).or_insert(0) += 1;
    }
    let GTest { p, g, df } = g_test(&counts, &exact, N);
    // Deterministic seed: the threshold is a one-time calibration, not a flake budget. 22 fixtures:
    // Bonferroni on alpha 0.001 is 4.5e-5; 1e-6 leaves room for the mean check below.
    assert!(p > 1e-6, "{name}: p={p} G={g:.1} df={df}");
    let se = exact.stdev() / (N as f64).sqrt();
    assert!(
        (sum / N as f64 - exact.mean()).abs() < 5.0 * se,
        "{name}: mean"
    );
    assert_eq!(
        SAMPLE_FALLBACKS.load(Ordering::SeqCst),
        before,
        "{name}: structural fallback to chips must not fire on fixtures"
    );
    Ok(())
}

macro_rules! fixture_tests {
    ($($test:ident => $name:expr),* $(,)?) => {
        $(#[test]
        fn $test() -> T {
            agrees_with_pmf($name)
        })*
    };
}

fixture_tests! {
    two_attacks_sneak_attack => "two attacks + sneak attack",
    advantage_grant_until_next_attack => "advantage grant until next attack",
    any_miss_reroll_gwm_like => "any-miss reroll (GWM-like)",
    save_with_half_and_a_rider_on_fail => "save with half and a rider on fail",
    chance_and_after_gates => "chance and after gates",
    happens_coin_on_a_damage_rider => "happens coin on a damage rider",
    every_hit_capped => "every-hit capped",
    substitute_reroll_keep_higher => "substitute reroll-keep-higher",
    convert_first_miss_sneak_attack => "convert first miss + sneak attack",
    dice_match_bounce => "dice-match bounce",
    reroll_up_to_explode_pool_payload => "rerollUpTo + explode pool payload",
    vulnerability_until_next_hit => "vulnerability until next hit",
    paralyzed_condition => "paralyzed condition (auto-crit on later melee)",
    joins_sneak_dice_pooled_into_the_first_row => "joins: sneak dice pooled into the first row",
    joins_happens_coin => "joins + happens coin",
    joins_row_chance => "joins + row chance",
    folded_chip_rider_happens_coin => "folded chip rider + happens coin",
    save_penalty_die_on_a_contextual_save_row => "save penalty die on a contextual save row",
    rider_payload_per_attack_with_roll_at => "rider payload per attack with rollAt",
    attack_gated_on_a_first_hit_rider => "attack gated on a first-hit rider (Wails from the Grave)",
    attack_gated_on_a_rider_folded_into_its_rows => "attack gated on a rider folded into its rows (payload per attack)",
    rerolled_under_savage_attacker => "rerolledUnder: Savage Attacker over a row the sneak dice join",
}

#[test]
fn every_fixture_has_a_test() {
    assert_eq!(fixtures().len(), 22);
}

#[test]
fn rider_fire_frequency_matches_fire_probability() -> T {
    let (_, build) = fixtures()
        .into_iter()
        .find(|(n, _)| *n == "two attacks + sneak attack")
        .ok_or("no fixture")?;
    let t = build()?;
    let mut rng = lcg_rng(42);
    let mut fired = 0u64;
    for _ in 0..N {
        let trace = t.sample(&mut rng)?;
        if trace.waves.iter().any(|w| {
            w.outcomes
                .iter()
                .any(|o| o.source == "sneak" && o.result == OutcomeResult::Fired)
        }) {
            fired += 1;
        }
    }
    let p = t.fire_probability("sneak")?;
    assert!((fired as f64 / N as f64 - p).abs() < 5.0 * (p * (1.0 - p) / N as f64).sqrt());
    Ok(())
}
