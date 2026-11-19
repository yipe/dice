//! `tests/resolve-full-support.test.ts`: 4 tests, 2 compat calls (`resolve()` vs the exact distribution and vs `toPMF()`
//! are builder-only, translated here too). The TS `bigint` tables are `u128` here (the largest integer is
//! 20 * 6^40 ~ 2.6e32 < 2^128), and the exact probability is `weight / denominator` in f64.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::error::DiceError;
use crate::turn::turn;
use std::collections::BTreeMap;

const FILE: &str = "tests/resolve-full-support.test.ts";
const SUITE: &str = "attack resolution keeps every reachable damage value";

/// Exact face-count table of `NdS`: `counts[i]` ways to roll a total of `n + i`.
fn dice_counts(n: usize, sides: usize) -> Vec<u128> {
    let mut counts: Vec<u128> = vec![1];
    for _ in 0..n {
        let mut next = vec![0u128; counts.len() + sides - 1];
        for (i, ways) in counts.iter().enumerate() {
            for face in 0..sides {
                next[i + face] += ways;
            }
        }
        counts = next;
    }
    counts
}

/// d20+10 vs AC 12 for 20d6: nat 1 misses (1/20), nat 20 crits for 40d6 (1/20), everything else hits for 20d6 (18/20).
/// Integer weights over the denominator 20 * 6^40.
fn exact_attack() -> (BTreeMap<usize, u128>, u128) {
    let six20 = 6u128.pow(20);
    let mut weights = BTreeMap::from([(0usize, six20 * six20)]);
    for (i, ways) in dice_counts(20, 6).into_iter().enumerate() {
        *weights.entry(20 + i).or_insert(0) += 18 * ways * six20;
    }
    for (i, ways) in dice_counts(40, 6).into_iter().enumerate() {
        *weights.entry(40 + i).or_insert(0) += ways;
    }
    (weights, 20 * six20 * six20)
}

fn attack() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(10.0)?
        .ac(12.0)?
        .on_hit_args(&[Arg::Roll(roll_with(
            20.0,
            Some(SidesOrDie::Die(d(6.0)?)),
            None,
        )?)])
}

#[test]
fn resolve_matches_the_exact_single_attack_distribution_bin_for_bin_0_to_240() -> T {
    let (weights, denominator) = exact_attack();
    let pmf = attack()?.resolve(0.0)?.pmf;
    let support: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    assert_eq!(
        support,
        weights.keys().map(|k| *k as f64).collect::<Vec<_>>()
    );
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 240.0);
    for (value, w) in &weights {
        let exact = *w as f64 / denominator as f64;
        assert!(
            (pmf.p_at(*value as f64) - exact).abs() <= exact * 1e-9 + 1e-300,
            "bin {value}"
        );
    }
    assert!(pmf.p_at(240.0) > 0.0);
    close(pmf.mean(), 70.0, 10);
    Ok(())
}

#[test]
fn resolve_and_to_pmf_agree_bin_for_bin() -> T {
    let resolved = attack()?.resolve(0.0)?.pmf;
    let built = attack()?.to_pmf(0.0)?;
    assert_eq!(resolved.support(), built.support());
    for value in built.support() {
        assert_eq!(
            resolved.p_at(value.0).to_bits(),
            built.p_at(value.0).to_bits()
        );
    }
    Ok(())
}

#[test]
fn a_one_attack_turn_keeps_the_crit_tail_up_to_240() -> T {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > a one-attack turn keeps the crit tail up to 240"),
    );
    let pmf = want.pmf(&turn(vec![atk(attack()?)], 0.0)?);
    assert_eq!(pmf.max(), 240.0);
    assert_eq!(pmf.support().len(), 222);
    want.done();
    Ok(())
}

#[test]
fn a_ten_attack_turn_reaches_the_exact_maximum_2400_with_every_value_20_to_2400_present() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SUITE} > a ten-attack turn reaches the exact maximum 2400 with every value 20..2400 present"
        ),
    );
    let attacks = (0..10)
        .map(|_| Ok(atk(attack()?)))
        .collect::<Result<Vec<_>, String>>()?;
    let pmf = want.pmf(&turn(attacks, 0.0)?);
    assert_eq!(pmf.min(), 0.0);
    assert_eq!(pmf.max(), 2400.0);
    // {0} U [20, 2400]: one attack reaches {0} U [20, 240], and the ranges overlap from two on.
    assert_eq!(pmf.support().len(), 2382);
    close(pmf.mean(), 700.0, 8);
    want.done();
    Ok(())
}
