//! `tests/convolve-determinism.test.ts`: 9 tests, 3 compat calls.
//! The tests clear the global PMF cache, so they take `CACHE` to run one at a time against each other.
//! Not translated: tests/convolve-determinism.test.ts:126,131: `pmfCache.size` read before and compared after `convolveRaw`: other test modules fill the shared cache concurrently, so an unchanged size is not observable; the bit-for-bit and map-order checks of `convolveRaw` are kept.

use super::helpers::*;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::pmf::cache::PMF_CACHE;
use crate::turn::turn;
use crate::{Bin, Damage, EPS, LabelMap, Pmf};
use indexmap::IndexMap;
use std::sync::{Arc, Mutex, MutexGuard};

const FILE: &str = "tests/convolve-determinism.test.ts";

static CACHE: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn next_state(state: u32) -> u32 {
    state.wrapping_mul(1664525).wrapping_add(1013904223)
}

/// Weights that are not round in binary, so a reordered sum can differ.
fn weights_for(seed: u32, size: usize) -> Vec<f64> {
    let mut state = seed;
    (0..size)
        .map(|_| {
            state = next_state(state);
            1.0 + f64::from(state % 9973) / 9973.0
        })
        .collect()
}

#[derive(Clone, Copy)]
enum Order {
    Ascending,
    Descending,
    Interleaved,
}

fn labels(pairs: &[(&str, f64)]) -> LabelMap {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

/// A labelled, attributed PMF over damage 1..size. `order` is the order its bins go into the map.
fn build(seed: u32, size: usize, order: Order) -> Pmf {
    let weights = weights_for(seed, size);
    let total = weights.iter().fold(0.0, |sum, w| sum + w);
    let bins: Vec<(Damage, Bin)> = weights
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            let p = weight / total;
            let damage = (index + 1) as f64;
            (
                Damage(damage),
                Bin {
                    p,
                    count: labels(&[("hit", p * 0.7), ("crit", p * 0.2), ("miss", p * 0.1)]),
                    attr: Some(labels(&[
                        ("hit", damage * p * 0.7),
                        ("crit", damage * p * 0.2),
                    ])),
                },
            )
        })
        .collect();
    let ordered: Vec<(Damage, Bin)> = match order {
        Order::Ascending => bins,
        Order::Descending => bins.into_iter().rev().collect(),
        Order::Interleaved => {
            let odd = bins
                .iter()
                .enumerate()
                .filter(|(i, _)| i % 2 == 1)
                .map(|(_, b)| b.clone());
            let even = bins
                .iter()
                .enumerate()
                .filter(|(i, _)| i % 2 == 0)
                .map(|(_, b)| b.clone());
            odd.chain(even).collect()
        }
    };
    Pmf::new(ordered.into_iter().collect::<IndexMap<_, _>>(), EPS, true)
}

/// Every number of the PMF, at full precision, in damage order.
fn bits(pmf: &Pmf) -> String {
    pmf.fingerprint()
}

fn clear() {
    PMF_CACHE.clear();
}

#[test]
fn does_not_depend_on_which_equal_pmf_was_created_first() {
    let _guard = serial();
    for raw in [false, true] {
        clear();
        let x1 = build(1, 12, Order::Ascending);
        let y1 = build(2, 12, Order::Ascending);
        let first = x1.convolve(&y1, None, raw);

        clear();
        // Same content, created in the other order.
        let y2 = build(2, 12, Order::Ascending);
        let x2 = build(1, 12, Order::Ascending);
        let second = x2.convolve(&y2, None, raw);

        assert_eq!(bits(&second), bits(&first));
        assert_eq!(second.identifier(), first.identifier());
    }
}

#[test]
fn gives_a_convolve_b_and_b_convolve_a_the_same_bits_cold() {
    let _guard = serial();
    for raw in [false, true] {
        let a = build(3, 15, Order::Ascending);
        let b = build(4, 15, Order::Ascending);
        clear();
        let ab = a.convolve(&b, None, raw);
        clear();
        let ba = b.convolve(&a, None, raw);
        assert_eq!(bits(&ba), bits(&ab));
    }
}

#[test]
fn does_not_depend_on_the_order_the_operands_maps_were_built_in() {
    let _guard = serial();
    clear();
    let reference =
        build(5, 14, Order::Ascending).convolve(&build(6, 14, Order::Ascending), None, true);
    for (name_a, order_a) in [
        ("ascending", Order::Ascending),
        ("descending", Order::Descending),
        ("interleaved", Order::Interleaved),
    ] {
        for (name_b, order_b) in [
            ("ascending", Order::Ascending),
            ("descending", Order::Descending),
            ("interleaved", Order::Interleaved),
        ] {
            clear();
            let result = build(5, 14, order_a).convolve(&build(6, 14, order_b), None, true);
            assert_eq!(bits(&result), bits(&reference), "{name_a} x {name_b}");
        }
    }
}

#[test]
fn does_not_depend_on_what_the_cache_holds() {
    let _guard = serial();
    let a = build(7, 13, Order::Ascending);
    let b = build(8, 13, Order::Ascending);
    clear();
    let cold = a.convolve_shared(&b, None, true);

    // Push the entry out of the cache (capacity 1000), then compute it again.
    for i in 0..1100u32 {
        let filler = build(100 + i, 3, Order::Ascending).convolve(
            &build(2000 + i, 3, Order::Ascending),
            None,
            true,
        );
        close(filler.mass(), 1.0, 12);
    }
    assert_eq!(PMF_CACHE.len(), 1000);
    let recomputed = a.convolve_shared(&b, None, true);
    assert!(!Arc::ptr_eq(&recomputed, &cold));
    assert_eq!(bits(&recomputed), bits(&cold));
}

#[test]
fn gives_power_the_same_bits_from_equal_pmfs_built_apart() -> T {
    let _guard = serial();
    clear();
    let first = build(9, 6, Order::Ascending).power(5.0, None)?;
    clear();
    let second = build(9, 6, Order::Descending).power(5.0, None)?;
    assert_eq!(bits(&second), bits(&first));
    Ok(())
}

#[test]
fn convolve_raw_uncached_matches_the_cached_raw_convolve_bit_for_bit_whichever_operand_is_this() {
    let _guard = serial();
    let a = build(11, 14, Order::Interleaved);
    let b = build(12, 9, Order::Descending);
    clear();
    let cached = a.convolve(&b, None, true);
    assert_eq!(bits(&a.convolve_raw(&b, None)), bits(&cached));
    assert_eq!(bits(&b.convolve_raw(&a, None)), bits(&cached));
    // Map order too: `mass()` adds in it.
    let keys = |p: &Pmf| p.map.keys().copied().collect::<Vec<_>>();
    assert_eq!(keys(&a.convolve_raw(&b, None)), keys(&cached));
    assert_eq!(keys(&b.convolve_raw(&a, None)), keys(&cached));
    // Equal content in both: the tie orders by `this`, as `<=` on equal fingerprints does.
    assert_eq!(
        bits(&a.convolve_raw(&build(11, 14, Order::Ascending), None)),
        bits(&a.convolve(&a, None, true))
    );
}

#[test]
fn a_non_integer_support_takes_the_sparse_walk_and_sums_in_the_same_order() {
    let _guard = serial();
    let a = build(13, 10, Order::Ascending);
    let b = build(14, 10, Order::Ascending);
    let integer = a.convolve(&b, None, true);
    // Shifting every value by a half keeps the pairs, their order and every product.
    let shifted = a
        .map_damage(|d| d + 0.5)
        .convolve(&b.map_damage(|d| d + 0.5), None, true);
    let shifted_keys: Vec<f64> = shifted.map.keys().map(|d| d.0 - 1.0).collect();
    let integer_keys: Vec<f64> = integer.map.keys().map(|d| d.0).collect();
    assert_eq!(shifted_keys, integer_keys);
    assert_eq!(bits(&shifted.map_damage(|d| d - 1.0)), bits(&integer));
}

/// Equal content, opposite map order: `mass()` sums in map order, so the two masses differ in the last bit.
fn unnormalized(descending: bool) -> Pmf {
    let mut state = 7u32;
    let mut entries: Vec<(Damage, Bin)> = (0..8)
        .map(|index| {
            state = next_state(state);
            let p = 0.01 + f64::from(state % 9973) / 40000.0;
            (
                Damage(f64::from(index + 1)),
                Bin {
                    p,
                    count: labels(&[("hit", p)]),
                    attr: None,
                },
            )
        })
        .collect();
    if descending {
        entries.reverse();
    }
    Pmf::new(entries.into_iter().collect::<IndexMap<_, _>>(), EPS, false)
}

#[test]
fn power_of_an_unnormalized_pmf_does_not_depend_on_whether_an_equal_pmf_was_raised_first() -> T {
    let _guard = serial();
    let a = unnormalized(false);
    let b = unnormalized(true);
    assert_eq!(a.fingerprint(), b.fingerprint());
    assert_ne!(a.mass(), b.mass()); // the premise: normalizing them differs in the last bit

    clear();
    let cold = bits(&b.power(3.0, None)?);
    clear();
    let raised_first = a.power(3.0, None)?;
    close(raised_first.mass(), 1.0, 12);
    let warm = bits(&b.power(3.0, None)?);
    assert_eq!(warm, cold);
    Ok(())
}

#[test]
fn a_turn_walks_to_the_same_bits_whatever_was_built_or_cached_before() -> T {
    let _guard = serial();
    let mut want = expect(
        FILE,
        "a Turn is a function of its spec > walks to the same bits whatever was built or cached before",
    );
    let sword = || attack_roll(9.0, 16.0, d6().plus(5.0)?);
    let spec = || -> Result<crate::turn::Turn, Box<dyn std::error::Error>> {
        let sneak = RollBuilder::from_args(&[
            crate::builder::roll::Arg::Num(3.0),
            crate::builder::roll::Arg::Roll(d6()),
        ])?;
        Ok(turn(vec![], 0.0)?
            .attacks(9.0, sword()?)?
            .on_first_hit_with(sneak, first_hit_id("sneak"))?
            .on_any_crit_with(rs(2.0, 8.0)?, cond_id("smite"))?
            .on_every_hit_with(d6(), every_hit(None, None))?)
    };
    clear();
    let first = want.pmf(&spec()?);

    // Other work first: PMFs are created and the cache fills with unrelated entries.
    clear();
    let unrelated: Vec<Pmf> = (0..25u32)
        .map(|i| build(300 + i, 7, Order::Ascending))
        .collect();
    for i in 1..unrelated.len() {
        close(
            unrelated[i - 1].convolve(&unrelated[i], None, true).mass(),
            1.0,
            12,
        );
    }
    let three = turn(vec![], 0.0)?
        .attacks(3.0, sword()?)?
        .on_every_hit_with(d8(), every_hit(None, None))?;
    assert!(want.mean(&three) > 0.0);
    let second = want.pmf(&spec()?);

    assert_eq!(bits(&second), bits(&first));
    want.done();
    Ok(())
}
