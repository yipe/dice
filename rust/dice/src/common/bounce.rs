//! Port of `src/common/bounce.ts`: bounce odds (the "birthday problem" for bouncing damage dice),
//! `faceWeights`, `diceSumDistribution`, `jointSumAndMatch` and `explodingPoolMatchProbability`.
//! The single implementation: `builder::bounce` re-exports it. Float code mirrors the TS operation
//! by operation (JS `Math.min`/`Math.max` propagate NaN; `Map` insertion order is `IndexMap`
//! order and decides float summation order); 1,272 recorded cases replay bit-identically
//! (`fixtures/bounce.jsonl`, see the test at the bottom).
//!
//! # Size guards
//! ADR-007: the original allocates or loops without bound on absurd sizes. `calculate_bounce_odds`,
//! `exploding_pool_match_probability` and the `*_checked` functions reject a size argument above
//! [`SIZE_LIMIT`] (and `faceWeights` a `faces` above [`FACE_WEIGHTS_LIMIT`]) with
//! `RangeError: size exceeds limit`, as the recording harness does. ADR-017: the builder's
//! infallible `face_weights`, `dice_sum_distribution` and `joint_sum_and_match` skip those guards;
//! the builder refuses a pool that is [`too_big`] before calling them.
//!
//! JS errors the original raises on odd sizes come back as `Err(DiceError::Range(..))`: a
//! non-integer or NaN `count`, or a budget that is not a non-negative integer, in
//! `exploding_pool_match_probability`.
//!
//! `explodingPoolMkDistribution` is computed bottom-up over `(pending, budget)`: every state's
//! value and insertion order equal the original's memoized recursion, without its stack depth.

use crate::error::DiceError;
use std::collections::HashSet;

use indexmap::IndexMap;

use crate::Damage;
use crate::builder::num::{MAX_ENUMERATED, js_max, js_min};

/// Largest accepted size argument of the checked functions.
pub const SIZE_LIMIT: f64 = 10_000.0;

/// Largest `faces` of [`face_weights_checked`].
pub const FACE_WEIGHTS_LIMIT: f64 = 10_000_000.0;

/// The largest `dice · faces` of a pool whose match odds are enumerated.
pub const MAX_DICE_FACES: f64 = 20_000.0;

/// Whether a pool of `dice` dice of `faces` faces is too big to enumerate (or not a number).
pub fn too_big(dice: f64, faces: f64) -> bool {
    dice.is_nan() || faces.is_nan() || faces > MAX_ENUMERATED || dice * faces > MAX_DICE_FACES
}

fn too_large(args: &[f64]) -> Result<(), DiceError> {
    if args.iter().any(|v| v.abs() > SIZE_LIMIT) {
        return Err(DiceError::range("size exceeds limit"));
    }
    Ok(())
}

/// `BounceOddsOptions`: metamagic / feat modifiers.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BounceOddsOptions {
    /// Minimum die roll: 2 for Elemental Adept, 3 for Great Weapon Fighting 2024.
    pub minimum_die_roll: Option<f64>,
    /// How many dice may be rerolled once (Empowered Spell). "Up to".
    pub reroll_damage_dice: Option<f64>,
}

/// `faceWeights` with its size guard: `Err` where the original throws or the harness rejects.
fn face_weights_impl(faces: f64, minimum: f64, reroll: f64) -> Result<Vec<f64>, DiceError> {
    if faces.abs() > FACE_WEIGHTS_LIMIT {
        return Err(DiceError::range("size exceeds limit"));
    }
    let f = js_max(0.0, faces.floor());
    if f <= 0.0 {
        return Ok(Vec::new());
    }
    if f.is_nan() {
        return Err(DiceError::invalid_array_length());
    }
    let n = f as usize;

    let mut weights = vec![1.0 / f; n];

    let r = js_max(0.0, js_min(reroll.floor(), f));
    if r > 0.0 {
        let reroll_mass = r / f;
        let uniform_reroll = reroll_mass / f;
        for (i, w) in weights.iter_mut().enumerate() {
            *w = (if (i as f64) < r { 0.0 } else { 1.0 / f }) + uniform_reroll;
        }
    }

    let min_v = js_max(0.0, minimum.floor());
    if min_v > 1.0 {
        let mut collapsed = vec![0.0; n];
        for v in 1..=n {
            let target = js_min(f, js_max(v as f64, min_v)) as usize;
            collapsed[target - 1] += weights[v - 1];
        }
        weights = collapsed;
    }
    Ok(weights)
}

/// `faceWeights(faces, minimum, reroll)`: the exact per-face probability marginal of one die,
/// honoring threshold `reroll(k)` and `minimum(v)` in the order `resolveSingleDie` applies them.
/// 1-indexed (`weights[v - 1]`); a face collapsed onto by `minimum` carries its collapsed
/// neighbors' mass, a face below `minimum` zero. ADR-017: empty for a NaN `faces` or one above
/// [`MAX_ENUMERATED`] (see [`too_big`]).
pub fn face_weights(faces: f64, minimum: f64, reroll: f64) -> Vec<f64> {
    if faces.is_nan() || faces > MAX_ENUMERATED {
        return Vec::new();
    }
    face_weights_impl(faces, minimum, reroll).unwrap_or_default()
}

/// [`face_weights`] with the ADR-007 guards and the original's errors (`minimum`/`reroll` default
/// to 0).
pub fn face_weights_checked(
    faces: f64,
    minimum: Option<f64>,
    reroll: Option<f64>,
) -> Result<Vec<f64>, DiceError> {
    face_weights_impl(faces, minimum.unwrap_or(0.0), reroll.unwrap_or(0.0))
}

/// Binomial coefficient C(n, k), 0 for out-of-range k.
fn binom(n: f64, k: f64) -> f64 {
    if k < 0.0 || k > n {
        return 0.0;
    }
    let mut result = 1.0;
    let mut i = 0.0;
    while i < k {
        result = (result * (n - i)) / (i + 1.0);
        i += 1.0;
    }
    result
}

fn p_all_distinct(dice: f64, faces: f64, uniform_count: f64, heavy_weight: f64) -> f64 {
    let light = 1.0 / faces;
    let e_k = binom(uniform_count, dice) * light.powf(dice)
        + heavy_weight * binom(uniform_count, dice - 1.0) * light.powf(dice - 1.0);
    let mut k_factorial = 1.0;
    let mut i = 2.0;
    while i <= dice {
        k_factorial *= i;
        i += 1.0;
    }
    k_factorial * e_k
}

fn p_match(dice: f64, faces: f64, minimum_die_roll: f64) -> f64 {
    if dice <= 1.0 {
        return 0.0;
    }
    if dice > faces {
        return 1.0;
    }
    if minimum_die_roll >= 2.0 {
        let uniform_count = faces - minimum_die_roll;
        let effective_values = uniform_count + 1.0;
        if dice > effective_values {
            return 1.0;
        }
        let heavy_weight = minimum_die_roll / faces;
        let distinct = p_all_distinct(dice, faces, uniform_count, heavy_weight);
        return js_min(1.0, js_max(0.0, 1.0 - distinct));
    }
    let mut p_distinct = 1.0;
    let mut i = 0.0;
    while i < dice {
        p_distinct *= (faces - i) / faces;
        i += 1.0;
    }
    1.0 - p_distinct
}

/// `calculateBounceOdds(diceCount, dieFaces, options)`: P(at least two of `dice_count` dice with
/// `die_faces` faces match), honoring Elemental Adept and Empowered Spell. Exact; in [0, 1].
pub fn calculate_bounce_odds(
    dice_count: f64,
    die_faces: f64,
    options: Option<BounceOddsOptions>,
) -> Result<f64, DiceError> {
    too_large(&[dice_count, die_faces])?;
    if dice_count <= 1.0 {
        return Ok(0.0);
    }
    if dice_count > die_faces {
        return Ok(1.0);
    }

    let options = options.unwrap_or_default();
    let minimum_die_roll = options.minimum_die_roll.unwrap_or(0.0);
    let reroll_damage_dice = options.reroll_damage_dice.unwrap_or(0.0);

    let p_match_first = p_match(dice_count, die_faces, minimum_die_roll);

    let reroll_limit = js_min(reroll_damage_dice.floor(), dice_count);
    if reroll_limit <= 0.0 || p_match_first >= 1.0 {
        return Ok(p_match_first);
    }

    let collapsed = minimum_die_roll >= 2.0;
    let light_count = if collapsed {
        die_faces - minimum_die_roll
    } else {
        die_faces
    };
    let heavy_weight = if collapsed {
        minimum_die_roll / die_faces
    } else {
        0.0
    };
    let p_miss_after = |rerolled: f64, kept_light: f64, heavy_kept: bool| {
        p_all_distinct(
            rerolled,
            die_faces,
            light_count - kept_light,
            if heavy_kept { 0.0 } else { heavy_weight },
        )
    };

    let mut miss_light_only = 1.0;
    let mut miss_with_heavy = 1.0;
    let mut rerolled = 1.0;
    while rerolled <= reroll_limit {
        let all_light_kept = p_miss_after(rerolled, dice_count - rerolled, false);
        miss_light_only = js_min(miss_light_only, all_light_kept);
        miss_with_heavy = js_min(miss_with_heavy, all_light_kept);
        if rerolled < dice_count {
            miss_with_heavy = js_min(
                miss_with_heavy,
                p_miss_after(rerolled, dice_count - 1.0 - rerolled, true),
            );
        }
        rerolled += 1.0;
    }

    let p_light_only = p_all_distinct(dice_count, die_faces, light_count, 0.0);
    let p_with_heavy =
        dice_count * heavy_weight * p_all_distinct(dice_count - 1.0, die_faces, light_count, 0.0);

    Ok(js_min(
        1.0,
        p_match_first
            + p_light_only * (1.0 - miss_light_only)
            + p_with_heavy * (1.0 - miss_with_heavy),
    ))
}

/// `diceSumDistribution(dice, weights)`: exact P(sum = s) for `dice` i.i.d. dice sharing `weights`.
pub fn dice_sum_distribution(dice: f64, weights: &[f64]) -> IndexMap<Damage, f64> {
    let mut dist: IndexMap<Damage, f64> = IndexMap::from([(Damage(0.0), 1.0)]);
    let mut die = 0.0;
    while die < dice {
        let mut next: IndexMap<Damage, f64> = IndexMap::new();
        for (sum, mass) in &dist {
            for (i, w) in weights.iter().enumerate() {
                if *w <= 0.0 {
                    continue;
                }
                let s = Damage(sum.0 + (i + 1) as f64);
                *next.entry(s).or_insert(0.0) += mass * w;
            }
        }
        dist = next;
        die += 1.0;
    }
    dist
}

/// `sumAllDistinctDistribution`: P(sum = s and all `dice` values distinct), by the
/// elementary-symmetric DP over faces.
fn sum_all_distinct_distribution(dice: f64, weights: &[f64]) -> IndexMap<Damage, f64> {
    let mut dp: IndexMap<usize, IndexMap<Damage, f64>> =
        IndexMap::from([(0, IndexMap::from([(Damage(0.0), 1.0)]))]);
    for (index, w) in weights.iter().enumerate() {
        let face = (index + 1) as f64;
        let mut next = dp.clone();
        if *w > 0.0 {
            for (count, sum_map) in &dp {
                let next_count = count + 1;
                if next_count as f64 > dice {
                    continue;
                }
                let target = next.entry(next_count).or_default();
                for (sum, mass) in sum_map {
                    let s = Damage(sum.0 + face);
                    *target.entry(s).or_insert(0.0) += mass * w;
                }
            }
        }
        dp = next;
    }
    let mut factorial = 1.0;
    let mut i = 2.0;
    while i <= dice {
        factorial *= i;
        i += 1.0;
    }
    let chosen = if dice.fract() == 0.0 && dice >= 0.0 {
        dp.get(&(dice as usize)).cloned().unwrap_or_default()
    } else {
        IndexMap::new()
    };
    chosen
        .into_iter()
        .map(|(sum, mass)| (sum, mass * factorial))
        .collect()
}

/// `jointSumAndMatch(dice, weights)`: exact joint P(sum = s and match) for `dice` i.i.d. dice
/// sharing `weights`; sums with no match mass are omitted. `dice <= 1` is empty.
pub fn joint_sum_and_match(dice: f64, weights: &[f64]) -> IndexMap<Damage, f64> {
    if dice <= 1.0 {
        return IndexMap::new();
    }
    let total = dice_sum_distribution(dice, weights);
    let distinct = sum_all_distinct_distribution(dice, weights);

    // A sum carries match mass only if a roll with a repeated face reaches it: twice one face plus
    // any `dice - 2` faces.
    let rest = dice_sum_distribution(dice - 2.0, weights);
    let mut matchable: HashSet<Damage> = HashSet::new();
    for (index, weight) in weights.iter().enumerate() {
        if *weight <= 0.0 {
            continue;
        }
        for sum in rest.keys() {
            matchable.insert(Damage(2.0 * (index + 1) as f64 + sum.0));
        }
    }

    let mut result = IndexMap::new();
    for (sum, mass) in &total {
        if !matchable.contains(sum) {
            continue;
        }
        let match_mass = js_max(0.0, mass - distinct.get(sum).copied().unwrap_or(0.0));
        if match_mass > 0.0 {
            result.insert(*sum, match_mass);
        }
    }
    result
}

/// [`dice_sum_distribution`] with the ADR-007 size guard on `dice`.
pub fn dice_sum_distribution_checked(
    dice: f64,
    weights: &[f64],
) -> Result<IndexMap<Damage, f64>, DiceError> {
    too_large(&[dice])?;
    Ok(dice_sum_distribution(dice, weights))
}

/// [`joint_sum_and_match`] with the ADR-007 size guard on `dice`.
pub fn joint_sum_and_match_checked(
    dice: f64,
    weights: &[f64],
) -> Result<IndexMap<Damage, f64>, DiceError> {
    too_large(&[dice])?;
    Ok(joint_sum_and_match(dice, weights))
}

/// `explodingPoolMkDistribution(pMax, count, budget)`: the joint distribution over `(m, k)` (`m`
/// dice landing on the pool's max face, `k` on anything else) realized by the same `(pending,
/// budget)` walk as the pool-wide exploding-dice DP, in the original's insertion order.
fn exploding_pool_mk(p_max: f64, count: usize, budget: usize) -> Vec<((usize, usize), f64)> {
    type State = Vec<((usize, usize), f64)>;
    let binomial = |n: usize| -> Vec<f64> {
        let mut result = vec![0.0; n + 1];
        result[0] = 1.0;
        for trial in 0..n {
            let mut next = vec![0.0; n + 1];
            for successes in 0..=trial {
                let mass = result[successes];
                if mass <= 0.0 {
                    continue;
                }
                next[successes] += mass * (1.0 - p_max);
                next[successes + 1] += mass * p_max;
            }
            result[..=n].copy_from_slice(&next[..=n]);
        }
        result
    };

    let base = |pending: usize| -> State {
        if pending == 0 {
            return vec![((0, 0), 1.0)];
        }
        let mut out = Vec::new();
        for (m, &mass) in binomial(pending).iter().enumerate() {
            if mass > 0.0 {
                out.push(((m, pending - m), mass));
            }
        }
        out
    };

    let mut prev: Vec<State> = (0..=count).map(base).collect();
    for _ in 1..=budget {
        let mut cur: Vec<State> = Vec::with_capacity(count + 1);
        cur.push(vec![((0, 0), 1.0)]);
        for pending in 1..=count {
            let mut acc: IndexMap<(usize, usize), f64> = IndexMap::new();
            for &((m, k), mass) in &prev[pending] {
                *acc.entry((m + 1, k)).or_insert(0.0) += mass * p_max;
            }
            for &((m, k), mass) in &cur[pending - 1] {
                *acc.entry((m, k + 1)).or_insert(0.0) += mass * (1.0 - p_max);
            }
            cur.push(acc.into_iter().collect());
        }
        prev = cur;
    }
    prev.swap_remove(count)
}

/// Exact P(`count` i.i.d. dice with face probabilities `weights` all differ): `count! · e_count(weights)`.
fn all_distinct_probability(count: usize, weights: &[f64]) -> f64 {
    let mut symmetric = vec![0.0; count + 1];
    symmetric[0] = 1.0;
    for &weight in weights {
        if weight <= 0.0 {
            continue;
        }
        for chosen in (1..=count).rev() {
            symmetric[chosen] += symmetric[chosen - 1] * weight;
        }
    }
    let mut factorial = 1.0;
    for i in 2..=count {
        factorial *= i as f64;
    }
    factorial * symmetric[count]
}

/// `explodingPoolMatchProbability(weights, count, budget)`: P(match) for a pool sharing ONE
/// pool-wide exploding-dice budget. Conditioned on `m` (dice showing max) and `k` (anything else):
/// `m >= 2` is a certain match; `m <= 1` matches iff the `k` non-max dice collide among
/// themselves. `weights` is the single die's resolved marginal, 1-indexed, max face last (as
/// [`face_weights`] returns it).
pub fn exploding_pool_match_probability(
    weights: &[f64],
    count: f64,
    budget: f64,
) -> Result<f64, DiceError> {
    too_large(&[count, budget])?;
    if count <= 0.0 || weights.is_empty() {
        return Ok(0.0);
    }

    let p_max = weights[weights.len() - 1];
    let non_max: Vec<f64> = if p_max < 1.0 {
        weights[..weights.len() - 1]
            .iter()
            .map(|w| w / (1.0 - p_max))
            .collect()
    } else {
        Vec::new()
    };

    // The original recurses on (count, budget) down to budget 0 and count 0. A budget that is
    // not a non-negative integer never reaches 0: stack overflow. A count that is not an integer
    // reaches budget 0 with a bad `new Array(count + 1)`.
    if !(budget >= 0.0 && budget.fract() == 0.0) {
        return Err(DiceError::stack_overflow());
    }
    // A count below 2^-53 makes `count + 1` exactly 1, a valid array length: with budget 0 the
    // binomial has no positive mass (result 0); with budget > 0 the pending count walks down
    // forever (stack overflow).
    if count > 0.0 && count + 1.0 == 1.0 {
        return if budget == 0.0 {
            Ok(0.0)
        } else {
            Err(DiceError::stack_overflow())
        };
    }
    if count.is_nan() || count.fract() != 0.0 {
        return Err(DiceError::invalid_array_length());
    }

    let mut p_match_total = 0.0;
    for ((m, k), weight) in exploding_pool_mk(p_max, count as usize, budget as usize) {
        if m >= 2 {
            p_match_total += weight;
        } else if k >= 2 {
            p_match_total += weight * (1.0 - all_distinct_probability(k, &non_max));
        }
    }
    Ok(js_min(1.0, js_max(0.0, p_match_total)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::{RollType, crit_probability};

    #[test]
    fn two_d6_match_odds() {
        let w = face_weights(6.0, 0.0, 0.0);
        let joint = joint_sum_and_match(2.0, &w);
        // Doubles: 2,4,6,8,10,12 each 1/36.
        assert_eq!(joint.len(), 6);
        assert!((joint[&Damage(2.0)] - 1.0 / 36.0).abs() < 1e-15);
        assert!(!joint.contains_key(&Damage(3.0)));
        let total = dice_sum_distribution(2.0, &w);
        assert!((total[&Damage(7.0)] - 6.0 / 36.0).abs() < 1e-15);
    }

    #[test]
    fn minimum_collapses_low_faces() {
        let w = face_weights(4.0, 3.0, 0.0);
        assert_eq!(w.len(), 4);
        assert_eq!(w[0], 0.0);
        assert_eq!(w[1], 0.0);
        assert!((w[2] - 0.75).abs() < 1e-15);
    }

    #[test]
    fn guards() {
        assert!(too_big(1000.0, 100.0));
        assert!(!too_big(20.0, 20.0));
    }

    // ---- Replay of the 1,272 recorded TS cases in fixtures/bounce.jsonl ({fn, args, ok|error}).

    use serde_json::Value;

    /// A JS number of the wire form: a JSON number or `{"$num": "NaN" | "Infinity" | ...}`.
    fn as_number(v: &Value) -> Option<f64> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::Object(o) if o.len() == 1 => match o.get("$num")?.as_str()? {
                "NaN" => Some(f64::NAN),
                "Infinity" => Some(f64::INFINITY),
                "-Infinity" => Some(f64::NEG_INFINITY),
                "-0" => Some(-0.0),
                _ => None,
            },
            _ => None,
        }
    }

    fn arg(args: &[Value], i: usize) -> f64 {
        args.get(i).and_then(as_number).unwrap_or(f64::NAN)
    }

    /// `undefined` (an explicit marker or a missing argument) reads as `None`.
    fn opt_arg(args: &[Value], i: usize) -> Option<f64> {
        args.get(i).and_then(as_number)
    }

    fn list(v: Option<&Value>) -> Vec<f64> {
        v.and_then(Value::as_array)
            .map(|a| a.iter().map(|x| as_number(x).unwrap_or(f64::NAN)).collect())
            .unwrap_or_default()
    }

    fn same(a: f64, b: f64) -> bool {
        (a.is_nan() && b.is_nan()) || (a == b && a.is_sign_negative() == b.is_sign_negative())
    }

    fn options_of(v: Option<&Value>) -> Option<BounceOddsOptions> {
        let o = v?.as_object()?;
        let field = |k: &str| o.get(k).and_then(as_number);
        Some(BounceOddsOptions {
            minimum_die_roll: field("minimumDieRoll"),
            reroll_damage_dice: field("rerollDamageDice"),
        })
    }

    fn map_pairs(m: &IndexMap<Damage, f64>) -> Vec<(f64, f64)> {
        m.iter().map(|(k, v)| (k.0, *v)).collect()
    }

    fn check_map(
        got: Result<IndexMap<Damage, f64>, DiceError>,
        case: &Value,
    ) -> Result<(), DiceError> {
        let want = case
            .get("ok")
            .and_then(|o| o.get("$map"))
            .and_then(Value::as_array);
        match (got, want) {
            (Ok(m), Some(want)) => {
                let got = map_pairs(&m);
                if got.len() != want.len() {
                    return Err(DiceError::error(format!(
                        "map length {} vs {}",
                        got.len(),
                        want.len()
                    )));
                }
                for ((gk, gv), w) in got.iter().zip(want) {
                    let (wk, wv) = (
                        arg(w.as_array().map_or(&[], |a| a), 0),
                        arg(w.as_array().map_or(&[], |a| a), 1),
                    );
                    if !same(*gk, wk) || !same(*gv, wv) {
                        return Err(DiceError::error(format!(
                            "entry ({gk}, {gv}) vs ({wk}, {wv})"
                        )));
                    }
                }
                Ok(())
            }
            (Err(e), None) => check_error(e.message(), case),
            (got, want) => Err(DiceError::error(format!("{got:?} vs {want:?}"))),
        }
    }

    fn check_error(e: &str, case: &Value) -> Result<(), DiceError> {
        let want = case
            .get("error")
            .and_then(Value::as_str)
            .ok_or(DiceError::error(format!("unexpected error {e}")))?;
        if e == want {
            Ok(())
        } else {
            Err(DiceError::error(format!("error {e} vs {want}")))
        }
    }

    fn check_number(got: Result<f64, DiceError>, case: &Value) -> Result<(), DiceError> {
        match (got, case.get("ok").and_then(as_number)) {
            (Ok(g), Some(w)) if same(g, w) => Ok(()),
            (Ok(g), Some(w)) => Err(DiceError::error(format!("{g:?} vs {w:?}"))),
            (Err(e), None) => check_error(e.message(), case),
            (g, w) => Err(DiceError::error(format!("{g:?} vs {w:?}"))),
        }
    }

    fn replay(case: &Value) -> Result<(), DiceError> {
        let name = case["fn"].as_str().ok_or("no fn")?;
        let args: &[Value] = case["args"].as_array().map_or(&[], |a| a);
        match name {
            "faceWeights" => {
                let got = face_weights_checked(arg(args, 0), opt_arg(args, 1), opt_arg(args, 2));
                match (got, case.get("ok").and_then(Value::as_array)) {
                    (Ok(g), Some(w)) => {
                        let w: Vec<f64> =
                            w.iter().map(|x| as_number(x).unwrap_or(f64::NAN)).collect();
                        if g.len() == w.len() && g.iter().zip(&w).all(|(a, b)| same(*a, *b)) {
                            Ok(())
                        } else {
                            Err(DiceError::error(format!(
                                "{} vs {} weights",
                                g.len(),
                                w.len()
                            )))
                        }
                    }
                    (Err(e), None) => check_error(e.message(), case),
                    (g, w) => Err(DiceError::error(format!("{g:?} vs {w:?}"))),
                }
            }
            "calculateBounceOdds" => check_number(
                calculate_bounce_odds(arg(args, 0), arg(args, 1), options_of(args.get(2))),
                case,
            ),
            "diceSumDistribution" => check_map(
                dice_sum_distribution_checked(arg(args, 0), &list(args.get(1))),
                case,
            ),
            "jointSumAndMatch" => check_map(
                joint_sum_and_match_checked(arg(args, 0), &list(args.get(1))),
                case,
            ),
            "explodingPoolMatchProbability" => check_number(
                exploding_pool_match_probability(&list(args.first()), arg(args, 1), arg(args, 2)),
                case,
            ),
            "critProbability" => {
                let roll_type = args
                    .get(1)
                    .and_then(Value::as_str)
                    .and_then(RollType::parse);
                check_number(
                    Ok(crit_probability(
                        arg(args, 0),
                        roll_type.unwrap_or(RollType::Flat),
                    )),
                    case,
                )
            }
            other => Err(DiceError::error(format!("unknown fn {other}"))),
        }
    }

    #[test]
    fn replays_recorded_cases() {
        let text = include_str!("../../fixtures/bounce.jsonl");
        let mut n = 0;
        let mut failures = Vec::new();
        for (i, line) in text.lines().enumerate() {
            let case: Value = serde_json::from_str(line).expect("fixture line is JSON");
            n += 1;
            if let Err(e) = replay(&case) {
                failures.push(format!(
                    "line {}: {}: {e}",
                    i + 1,
                    line.chars().take(120).collect::<String>()
                ));
            }
        }
        assert_eq!(n, 1272);
        assert!(
            failures.is_empty(),
            "{} failures:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn checked_guards() {
        assert_eq!(
            calculate_bounce_odds(10_001.0, 8.0, None).unwrap_err(),
            "size exceeds limit"
        );
        assert!(face_weights_checked(10_000_001.0, None, None).is_err());
        assert_eq!(
            face_weights_checked(20_000.0, None, None).unwrap().len(),
            20_000
        );
        assert!(face_weights_checked(f64::NAN, None, None).is_err());
        assert!(exploding_pool_match_probability(&[1.0], 1.0, -1.0).is_err());
        let w = face_weights(8.0, 0.0, 0.0);
        let p = exploding_pool_match_probability(&w, 1.0, 1.0).unwrap();
        assert!((p - 1.0 / 64.0).abs() < 1e-12);
    }
}
