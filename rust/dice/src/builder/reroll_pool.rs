//! Port of `src/builder/reroll-pool.ts`: the exact distribution of a dice pool that may reroll up
//! to k of its dice once every die is seen, keeping each new roll ("Empowered Spell", "Piercer"),
//! optionally chosen from several rolls of the pool ("Savage Attacker" plus a reroll budget).
//!
//! Policy. Total damage is linear in the dice, so the best reroll set is the up-to-k dice with the
//! largest POSITIVE expected gain `mean - shown`. A die on its own mean gains nothing and stays.
//! Dice of one kind are interchangeable, so only ties between different kinds need a rule: the
//! kind with the higher mean rerolls first (then the lower faces key).
//!
//! Skipped: the `matchCache` LRU and `clearMatchCache`.
//!
//! Deviations (all on input the TS cannot produce a meaningful answer for): a die count that is
//! not a positive integer up to 1e6, a NaN budget and an infinite number of rolls return `Err`
//! (TS yields garbage, or never returns).

use crate::error::DiceError;
use crate::{Damage, Pmf};
use indexmap::IndexMap;
use std::cmp::Ordering;
use std::collections::HashMap;

use crate::js::num_to_string;

/// One kind of die in the pool: `count` interchangeable dice showing `values` with `probs`.
#[derive(Clone, Debug, PartialEq)]
pub struct PoolDieKind {
    /// Signed face values: a subtracted die carries the negatives of its faces.
    pub values: Vec<f64>,
    pub probs: Vec<f64>,
    pub count: f64,
}

type Dist = IndexMap<Damage, f64>;

/// Gains and scores are compared on this grid (1e-9), so equal true values that differ in the
/// last float bits tie, and a gain below half a grid step counts as none.
const GRID: f64 = 1e9;

const TOO_MANY: &str = "rerollUpTo(): the pool has too many dice of too many kinds to enumerate.";

/// Largest die count of one kind this port enumerates.
const MAX_COUNT: f64 = 1e6;

#[derive(Clone, Debug)]
struct Kind {
    key: String,
    values: Vec<f64>,
    probs: Vec<f64>,
    count: f64,
    mean: f64,
    single: Dist,
}

#[derive(Clone, Copy, Debug)]
struct Face {
    kind: usize,
    value: f64,
    p: f64,
    /// Gain of rerolling this face, in grid steps.
    gain: f64,
    /// Probability this kind's die shows this face or one after it, and one after it.
    remaining: f64,
    after: f64,
}

/// JS `Math.round`: halves toward +Infinity.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0
}

/// A comparator result `d` (a JS number): `None` for 0 and NaN, which fall through an `||` chain.
fn sign_of(d: f64) -> Option<Ordering> {
    if d > 0.0 {
        Some(Ordering::Greater)
    } else if d < 0.0 {
        Some(Ordering::Less)
    } else {
        None
    }
}

/// A stable sort that tolerates comparators that are not a total order (JS `Array.prototype.sort`
/// never fails on them; `slice::sort_by` may panic).
fn stable_sort_by<T>(items: Vec<T>, mut cmp: impl FnMut(&T, &T) -> Ordering) -> Vec<T> {
    fn merge_sort(
        idx: &mut [usize],
        buf: &mut Vec<usize>,
        cmp: &mut dyn FnMut(usize, usize) -> Ordering,
    ) {
        let n = idx.len();
        if n < 2 {
            return;
        }
        let mid = n / 2;
        merge_sort(&mut idx[..mid], buf, cmp);
        merge_sort(&mut idx[mid..], buf, cmp);
        buf.clear();
        let (mut i, mut j) = (0, mid);
        while i < mid && j < n {
            if cmp(idx[j], idx[i]) == Ordering::Less {
                buf.push(idx[j]);
                j += 1;
            } else {
                buf.push(idx[i]);
                i += 1;
            }
        }
        buf.extend_from_slice(&idx[i..mid]);
        buf.extend_from_slice(&idx[j..n]);
        idx.copy_from_slice(buf);
    }
    let mut idx: Vec<usize> = (0..items.len()).collect();
    let mut buf = Vec::with_capacity(items.len());
    merge_sort(&mut idx, &mut buf, &mut |a, b| cmp(&items[a], &items[b]));
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    idx.into_iter().filter_map(|i| slots[i].take()).collect()
}

fn join_nums(xs: &[f64]) -> String {
    xs.iter()
        .map(|x| num_to_string(*x))
        .collect::<Vec<_>>()
        .join(",")
}

/// The identity of a kind of die: its signed faces and their probabilities.
fn kind_key(kind: &PoolDieKind) -> String {
    format!("{}|{}", join_nums(&kind.values), join_nums(&kind.probs))
}

/// Dice with the same faces are one kind. Kinds come out in a canonical order (higher mean first,
/// then by faces), which is the order that settles ties for the reroll budget.
fn merge_kinds(kinds: &[PoolDieKind]) -> Result<Vec<Kind>, DiceError> {
    let mut by_key: IndexMap<String, (&PoolDieKind, f64)> = IndexMap::new();
    for kind in kinds {
        if kind.count.is_nan() || kind.count <= 0.0 || kind.values.is_empty() {
            continue;
        }
        let key = kind_key(kind);
        match by_key.get_mut(&key) {
            Some(existing) => existing.1 += kind.count,
            None => {
                by_key.insert(key, (kind, kind.count));
            }
        }
    }
    let mut merged: Vec<Kind> = Vec::with_capacity(by_key.len());
    for (key, (kind, count)) in by_key {
        if !(count.is_finite() && count.fract() == 0.0 && count <= MAX_COUNT) {
            return Err(DiceError::error(TOO_MANY));
        }
        let mut single: Dist = IndexMap::new();
        let mut mean = 0.0;
        for (i, value) in kind.values.iter().enumerate() {
            let prob = kind.probs.get(i).copied().unwrap_or(f64::NAN);
            *single.entry(Damage(*value)).or_insert(0.0) += prob;
            mean += value * prob;
        }
        merged.push(Kind {
            key,
            values: kind.values.clone(),
            probs: kind.probs.clone(),
            count,
            mean,
            single,
        });
    }
    Ok(stable_sort_by(merged, |a, b| {
        sign_of(js_round((b.mean - a.mean) * GRID)).unwrap_or_else(|| a.key.cmp(&b.key))
    }))
}

fn convolve(a: &Dist, b: &Dist) -> Dist {
    let mut out: Dist = IndexMap::new();
    for (x, px) in a {
        for (y, py) in b {
            *out.entry(Damage(x.0 + y.0)).or_insert(0.0) += px * py;
        }
    }
    out
}

/// P(X = x) for x in 0..r, X ~ Binomial(r, p), with `q = 1 - p` passed in for accuracy near 1.
fn binomial_weights(r: usize, p: f64, q: f64) -> Vec<f64> {
    let mut weights = vec![0.0; r + 1];
    if q <= 0.0 {
        weights[r] = 1.0;
        return weights;
    }
    if p <= 0.0 {
        weights[0] = 1.0;
        return weights;
    }
    // Counting failures instead keeps the start term q^r away from underflow when p is large.
    if p > q {
        let mut w = binomial_weights(r, q, p);
        w.reverse();
        return w;
    }
    weights[0] = q.powf(r as f64);
    let ratio = p / q;
    for x in 1..=r {
        weights[x] = ((weights[x - 1] * (r - x + 1) as f64) / x as f64) * ratio;
    }
    weights
}

/// The faces of every kind in the order dice claim the reroll budget: largest gain first, ties to
/// the earlier kind. Each face carries the conditional probability a still-unplaced die of its
/// kind shows it, given it shows this face or a later one.
fn ordered_faces(kinds: &[Kind]) -> Vec<Face> {
    let mut faces: Vec<Face> = Vec::new();
    for (index, kind) in kinds.iter().enumerate() {
        for (i, value) in kind.values.iter().enumerate() {
            let p = kind.probs.get(i).copied().unwrap_or(f64::NAN);
            if p > 0.0 {
                faces.push(Face {
                    kind: index,
                    value: *value,
                    p,
                    gain: js_round((kind.mean - value) * GRID),
                    remaining: 0.0,
                    after: 0.0,
                });
            }
        }
    }
    let mut faces = stable_sort_by(faces, |a, b| {
        sign_of(b.gain - a.gain)
            .or_else(|| sign_of(a.kind as f64 - b.kind as f64))
            .or_else(|| sign_of(a.value - b.value))
            .unwrap_or(Ordering::Equal)
    });
    let mut later = vec![0.0; kinds.len()];
    for face in faces.iter_mut().rev() {
        face.after = later[face.kind];
        face.remaining = later[face.kind] + face.p;
        later[face.kind] += face.p;
    }
    faces
}

/// The weight of keeping a roll of score `s` when the best of `trials` rolls is kept, from the
/// mass each score (on the [`GRID`]) has in one roll. Roll i of `trials` is kept when every
/// earlier roll scores strictly less and every later one at most as much, so a score carries
/// weight `sum_i` below^(i-1) * atOrBelow^(trials-i).
struct BestOfRolls {
    weights: HashMap<Damage, f64>,
}

impl BestOfRolls {
    fn new(score_mass: &IndexMap<Damage, f64>, trials: f64) -> BestOfRolls {
        let keys = stable_sort_by(score_mass.keys().copied().collect::<Vec<_>>(), |a, b| {
            sign_of(a.0 - b.0).unwrap_or(Ordering::Equal)
        });
        let mut weights = HashMap::new();
        let mut below = 0.0;
        for grid in keys {
            let at_or_below = below + score_mass.get(&grid).copied().unwrap_or(f64::NAN);
            let mut weight = 0.0;
            let mut i = 0.0;
            while i < trials {
                weight += below.powf(i) * at_or_below.powf(trials - 1.0 - i);
                i += 1.0;
            }
            weights.insert(grid, weight);
            below = at_or_below;
        }
        BestOfRolls { weights }
    }

    /// `NaN` for a score that was never recorded (`undefined` in TS).
    fn weight(&self, score: f64) -> f64 {
        self.weights
            .get(&Damage(js_round(score * GRID)))
            .copied()
            .unwrap_or(f64::NAN)
    }
}

/// `Math.max(1, Math.floor(rolls))`, or `Err` where TS would loop forever.
fn trials_of(rolls: f64) -> Result<f64, DiceError> {
    let trials = js_max(1.0, rolls.floor());
    if trials.is_infinite() {
        return Err(DiceError::error("rerollUpTo(): rolls must be finite"));
    }
    Ok(trials)
}

/// Distribution of the pool's total (flats excluded). `budget` is the most dice that may be
/// rerolled, `rolls` how many whole rolls the best is chosen from (1 for none).
///
/// DP over the faces, highest gain first: the state is which dice of each kind are still unplaced
/// and how many of each kind were rerolled, holding the distribution of the kept faces' sum.
/// Placing the dice that show one face is a binomial draw among the unplaced dice of its kind; the
/// first `budget - rerolled` of those with positive gain are rerolled, the rest kept. A rerolled
/// die's new roll is independent of everything else, so it is added at the end.
pub fn reroll_up_to_pmf(
    pool_kinds: &[PoolDieKind],
    budget: f64,
    rolls: f64,
    eps: f64,
) -> Result<Pmf, DiceError> {
    let kinds = merge_kinds(pool_kinds)?;
    if kinds.is_empty() {
        return Pmf::delta(0.0, eps);
    }

    let dice = kinds.iter().fold(0.0, |total, kind| total + kind.count);
    let capacity_f = js_min(js_max(0.0, budget.floor()), dice);
    let trials = trials_of(rolls)?;

    // State key = rerolledIndex * R + unplacedIndex, each a mixed-radix number over the kinds.
    let unplaced_digits: Vec<f64> = kinds.iter().map(|kind| kind.count + 1.0).collect();
    let rerolled_digits: Vec<f64> = kinds
        .iter()
        .map(|kind| js_min(kind.count, capacity_f) + 1.0)
        .collect();
    let mut unplaced_stride_f: Vec<f64> = Vec::new();
    let mut rerolled_stride_f: Vec<f64> = Vec::new();
    let mut r_total = 1.0;
    let mut u_total = 1.0;
    for t in 0..kinds.len() {
        unplaced_stride_f.push(r_total);
        r_total *= unplaced_digits[t];
        rerolled_stride_f.push(u_total);
        u_total *= rerolled_digits[t];
    }
    if !is_safe_integer(r_total * u_total) {
        return Err(DiceError::error(TOO_MANY));
    }
    let capacity = capacity_f as u64;
    let to_u64 = |xs: &[f64]| xs.iter().map(|x| *x as u64).collect::<Vec<u64>>();
    let (unplaced_digits, rerolled_digits) = (to_u64(&unplaced_digits), to_u64(&rerolled_digits));
    let (unplaced_stride, rerolled_stride) =
        (to_u64(&unplaced_stride_f), to_u64(&rerolled_stride_f));
    let r_mod = r_total as u64;
    let rerolled_of =
        |rerolled_index: u64, t: usize| (rerolled_index / rerolled_stride[t]) % rerolled_digits[t];

    let mut used_memo: HashMap<u64, u64> = HashMap::new();
    let mut start = 0u64;
    for (t, kind) in kinds.iter().enumerate() {
        start += kind.count as u64 * unplaced_stride[t];
    }
    let mut state: IndexMap<u64, Dist> = IndexMap::new();
    state.insert(start, IndexMap::from([(Damage(0.0), 1.0)]));

    for face in ordered_faces(&kinds) {
        let t = face.kind;
        let can_reroll = face.gain > 0.0;
        let p_cond = js_min(1.0, face.p / face.remaining);
        let q_cond = face.after / face.remaining;
        let mut next: IndexMap<u64, Dist> = IndexMap::new();
        let mut shown_by: HashMap<usize, Vec<f64>> = HashMap::new();

        for (key, sums) in &state {
            let key = *key;
            let unplaced = (key % r_mod / unplaced_stride[t]) % unplaced_digits[t];
            if unplaced == 0 {
                let kept = next.entry(key).or_default();
                for (sum, pr) in sums {
                    *kept.entry(*sum).or_insert(0.0) += pr;
                }
                continue;
            }

            let rerolled_index = key / r_mod;
            let used = *used_memo.entry(rerolled_index).or_insert_with(|| {
                (0..kinds.len())
                    .map(|kind| rerolled_of(rerolled_index, kind))
                    .sum()
            });
            let unplaced_n = unplaced as usize;
            let shown = shown_by
                .entry(unplaced_n)
                .or_insert_with(|| binomial_weights(unplaced_n, p_cond, q_cond));

            for (x, &px) in shown.iter().enumerate() {
                if px <= eps {
                    continue;
                }
                let x64 = x as u64;
                let rerolled = if can_reroll {
                    x64.min(capacity.saturating_sub(used))
                } else {
                    0
                };
                let dest_key =
                    key - x64 * unplaced_stride[t] + rerolled * rerolled_stride[t] * r_mod;
                let add = (x64 - rerolled) as f64 * face.value;
                let fill = |dest: &mut Dist| {
                    for (sum, pr) in sums {
                        let total = Damage(sum.0 + add);
                        let mass = dest.get(&total).copied().unwrap_or(0.0) + pr * px;
                        if mass >= eps {
                            dest.insert(total, mass);
                        }
                    }
                };
                if let Some(dest) = next.get_mut(&dest_key) {
                    fill(dest);
                } else {
                    let mut dest: Dist = IndexMap::new();
                    fill(&mut dest);
                    if !dest.is_empty() {
                        next.insert(dest_key, dest);
                    }
                }
            }
        }
        state = next;
    }

    // Every die is placed: the states with no unplaced dice, one per rerolled-count vector.
    let mut finals: IndexMap<u64, Dist> = IndexMap::new();
    for (key, sums) in state {
        if key % r_mod == 0 {
            finals.insert(key / r_mod, sums);
        }
    }

    let fresh: Vec<Vec<Dist>> = kinds
        .iter()
        .enumerate()
        .map(|(t, kind)| {
            let mut powers: Vec<Dist> = vec![IndexMap::from([(Damage(0.0), 1.0)])];
            for j in 1..rerolled_digits[t] as usize {
                let next = convolve(&powers[j - 1], &kind.single);
                powers.push(next);
            }
            powers
        })
        .collect();
    let fresh_of = |rerolled_index: u64| -> Dist {
        let mut dist: Dist = IndexMap::from([(Damage(0.0), 1.0)]);
        for (t, powers) in fresh.iter().enumerate() {
            dist = convolve(&dist, &powers[rerolled_of(rerolled_index, t) as usize]);
        }
        dist
    };
    let mean_of_rerolled = |rerolled_index: u64| -> f64 {
        kinds.iter().enumerate().fold(0.0, |total, (t, kind)| {
            total + kind.mean * rerolled_of(rerolled_index, t) as f64
        })
    };

    // Which roll is kept: each roll's score is its kept sum plus the means of the dice it rerolls.
    let mut best_of: Option<BestOfRolls> = None;
    if trials > 1.0 {
        let mut score_mass: IndexMap<Damage, f64> = IndexMap::new();
        for (rerolled_index, sums) in &finals {
            let offset = mean_of_rerolled(*rerolled_index);
            for (sum, pr) in sums {
                let grid = Damage(js_round((sum.0 + offset) * GRID));
                *score_mass.entry(grid).or_insert(0.0) += pr;
            }
        }
        best_of = Some(BestOfRolls::new(&score_mass, trials));
    }

    let mut out: Dist = IndexMap::new();
    for (rerolled_index, sums) in &finals {
        let new_rolls = fresh_of(*rerolled_index);
        let offset = if best_of.is_some() {
            mean_of_rerolled(*rerolled_index)
        } else {
            0.0
        };
        for (sum, pr) in sums {
            let kept = match &best_of {
                Some(b) => pr * b.weight(sum.0 + offset),
                None => *pr,
            };
            for (roll, pf) in &new_rolls {
                *out.entry(Damage(sum.0 + roll.0)).or_insert(0.0) += kept * pf;
            }
        }
    }
    Pmf::from_map(out, eps, true)
}

/// Most (repeated summary, once summary) pairs [`reroll_up_to_partial_pmf`] scores before it gives
/// up: about a second of work.
const PARTIAL_WORK_LIMIT: f64 = 2e7;

/// One side's roll, summarized by its sum and its top reroll candidates.
#[derive(Clone)]
struct Summary {
    sum: f64,
    /// The roll's up-to-`capacity` best reroll candidates, best first.
    top: Vec<usize>,
    p: f64,
}

/// Distribution of a pool's total (flats excluded) whose `repeated_kinds` dice are rolled `rolls`
/// times and whose `once_kinds` dice are rolled once (Savage Attacker rolls only the weapon's dice
/// again): the roll of the repeated dice worth the most once its rerolls are spent is kept, then
/// up to `budget` dice of that roll and the once-rolled dice are rerolled, keeping the new rolls
/// (Piercer). The policy is [`reroll_up_to_pmf`]'s, over the dice of both sides.
///
/// A side's roll is summarized by its sum and its top `budget` reroll candidates (faces in
/// `ordered_faces` order); a DP over each side's dice gives the summaries' masses. For every
/// once-rolled summary, each repeated summary is scored with the merged candidates, the best of
/// `rolls` is weighted by `BestOfRolls`, and the kept sum is tallied by the kinds rerolled, whose
/// fresh rolls are convolved in last.
pub fn reroll_up_to_partial_pmf(
    repeated_kinds: &[PoolDieKind],
    once_kinds: &[PoolDieKind],
    budget: f64,
    rolls: f64,
    eps: f64,
) -> Result<Pmf, DiceError> {
    let all: Vec<PoolDieKind> = repeated_kinds.iter().chain(once_kinds).cloned().collect();
    let kinds = merge_kinds(&all)?;
    let index_of: HashMap<&str, usize> = kinds
        .iter()
        .enumerate()
        .map(|(i, k)| (k.key.as_str(), i))
        .collect();
    let faces = ordered_faces(&kinds);
    // `Math.max(0, Math.floor(budget))`; a NaN slice length counts as 0.
    let capacity_f = js_max(0.0, budget.floor());
    let capacity: usize = if capacity_f.is_nan() {
        0
    } else if capacity_f >= usize::MAX as f64 {
        usize::MAX
    } else {
        capacity_f as usize
    };
    let trials = trials_of(rolls)?;
    // A reroll candidate is a positive-gain face's index in `faces`: a lower index rerolls first.
    let mut candidate_of: Vec<IndexMap<Damage, usize>> =
        kinds.iter().map(|_| IndexMap::new()).collect();
    for (index, face) in faces.iter().enumerate() {
        if face.gain > 0.0 {
            candidate_of[face.kind].insert(Damage(face.value), index);
        }
    }

    let summaries = |side: &[PoolDieKind]| -> Vec<Summary> {
        let mut states: IndexMap<(Damage, Vec<usize>), Summary> = IndexMap::new();
        states.insert(
            (Damage(0.0), Vec::new()),
            Summary {
                sum: 0.0,
                top: Vec::new(),
                p: 1.0,
            },
        );
        for side_kind in side {
            if side_kind.count.is_nan() || side_kind.count <= 0.0 || side_kind.values.is_empty() {
                continue;
            }
            let Some(&k) = index_of.get(kind_key(side_kind).as_str()) else {
                continue;
            };
            for _die in 0..side_kind.count as usize {
                let mut next: IndexMap<(Damage, Vec<usize>), Summary> = IndexMap::new();
                for state in states.values() {
                    for (value, pv) in &kinds[k].single {
                        let candidate = candidate_of[k].get(value).copied();
                        let top = match candidate {
                            Some(c) if capacity != 0 => {
                                let mut t = state.top.clone();
                                t.push(c);
                                t.sort_unstable();
                                t.truncate(capacity);
                                t
                            }
                            _ => state.top.clone(),
                        };
                        let sum = state.sum + value.0;
                        let p = state.p * pv;
                        match next.get_mut(&(Damage(sum), top.clone())) {
                            Some(existing) => existing.p += p,
                            None => {
                                next.insert((Damage(sum), top.clone()), Summary { sum, top, p });
                            }
                        }
                    }
                }
                states = next;
            }
        }
        states.into_values().collect()
    };
    let repeated = summaries(repeated_kinds);
    let once = summaries(once_kinds);
    if repeated.len() as f64 * once.len() as f64 > PARTIAL_WORK_LIMIT {
        return Err(DiceError::error(TOO_MANY));
    }

    // Kept sums by the kinds rerolled (a sorted list of kind indices).
    let mut kept_by_rerolled: IndexMap<Vec<usize>, Dist> = IndexMap::new();
    for rest in &once {
        struct Play<'a> {
            roll: &'a Summary,
            top: Vec<usize>,
            kept: f64,
            score: f64,
        }
        let plays: Vec<Play> = repeated
            .iter()
            .map(|roll| {
                let mut top: Vec<usize> = roll.top.iter().chain(&rest.top).copied().collect();
                top.sort_unstable();
                top.truncate(capacity);
                let mut kept = roll.sum + rest.sum;
                let mut score = kept;
                for index in &top {
                    kept -= faces[*index].value;
                    score += kinds[faces[*index].kind].mean - faces[*index].value;
                }
                Play {
                    roll,
                    top,
                    kept,
                    score,
                }
            })
            .collect();
        let mut best_of: Option<BestOfRolls> = None;
        if trials > 1.0 {
            let mut score_mass: IndexMap<Damage, f64> = IndexMap::new();
            for play in &plays {
                let grid = Damage(js_round(play.score * GRID));
                *score_mass.entry(grid).or_insert(0.0) += play.roll.p;
            }
            best_of = Some(BestOfRolls::new(&score_mass, trials));
        }
        for play in &plays {
            let weight = best_of.as_ref().map_or(1.0, |b| b.weight(play.score));
            let mass = rest.p * play.roll.p * weight;
            if mass.is_nan() || mass <= 0.0 {
                continue;
            }
            let mut rerolled: Vec<usize> =
                play.top.iter().map(|index| faces[*index].kind).collect();
            rerolled.sort_unstable();
            let dist = kept_by_rerolled.entry(rerolled).or_default();
            *dist.entry(Damage(play.kept)).or_insert(0.0) += mass;
        }
    }

    let mut out: Dist = IndexMap::new();
    for (rerolled, kept) in &kept_by_rerolled {
        let mut fresh: Dist = IndexMap::from([(Damage(0.0), 1.0)]);
        for kind in rerolled {
            fresh = convolve(&fresh, &kinds[*kind].single);
        }
        for (sum, p) in convolve(kept, &fresh) {
            *out.entry(sum).or_insert(0.0) += p;
        }
    }
    Pmf::from_map(out, eps, true)
}

/// `PoolMatch`: the joint law of a single-kind pool's total and of whether the dice that land
/// match.
#[derive(Clone, Debug, PartialEq)]
pub struct PoolMatch {
    /// P(total = s), flats excluded.
    pub total: IndexMap<Damage, f64>,
    /// P(total = s and two or more of the dice that land show the same face).
    pub match_: IndexMap<Damage, f64>,
}

/// Most map updates [`reroll_up_to_match`] makes before it gives up.
const MATCH_WORK_LIMIT: f64 = 1e7;

/// The exact joint law of the total and of a match for a pool of `pool.count` identical dice that
/// may reroll up to `budget` of them, keeping the new rolls, and is rolled `rolls` times with the
/// best roll kept: the pool of [`reroll_up_to_pmf`], on the same policy. The dice that land are
/// the dice kept plus the fresh rolls, and two or more of them showing one face is a match.
///
/// The policy is the pool's own (most damage), never one that rerolls to make dice match.
///
/// One DP over the faces, highest gain first. Its state is how many dice are still unplaced, how
/// many were rerolled, how many faces already hold a fresh die, and whether some face already
/// holds two dice. `pool.values` are positive integers. `Ok(None)` when the pool is too large to
/// enumerate.
pub fn reroll_up_to_match(
    pool: &PoolDieKind,
    budget: f64,
    rolls: f64,
) -> Result<Option<PoolMatch>, DiceError> {
    let kinds = merge_kinds(std::slice::from_ref(pool))?;
    if kinds.is_empty() {
        return Ok(Some(PoolMatch {
            total: IndexMap::from([(Damage(0.0), 1.0)]),
            match_: IndexMap::new(),
        }));
    }
    let capacity_f = js_min(js_max(0.0, budget.floor()), kinds[0].count);
    if capacity_f.is_nan() {
        return Err(DiceError::error("rerollUpTo(): budget must not be NaN"));
    }
    let trials = trials_of(rolls)?;
    Ok(walk_match(&kinds, capacity_f as usize, trials))
}

fn walk_match(kinds: &[Kind], capacity: usize, trials: f64) -> Option<PoolMatch> {
    struct Final {
        rerolled: usize,
        matched: bool,
        sums: Dist,
    }

    let kind = &kinds[0];
    let dice = kind.count as usize;
    let faces = ordered_faces(kinds);

    let digits = capacity + 1;
    let state_key = |unplaced: usize, rerolled: usize, fresh: usize, matched: usize| -> u64 {
        ((((unplaced * digits + rerolled) * digits + fresh) * 2) + matched) as u64
    };
    let unpack = |key: u64| -> (usize, usize, usize, usize) {
        let key = key as usize;
        let matched = key % 2;
        let rest = (key - matched) / 2;
        let fresh = rest % digits;
        let rest = (rest - fresh) / digits;
        let rerolled = rest % digits;
        let unplaced = (rest - rerolled) / digits;
        (unplaced, rerolled, fresh, matched)
    };
    // A fresh die's face is added after the kept dice's. Keeping the two apart (only for the best
    // of several rolls, which scores a roll by its kept dice alone) puts kept * span + fresh in
    // the key.
    let span = if trials > 1.0 {
        let max_value = kind
            .values
            .iter()
            .fold(f64::NEG_INFINITY, |m, v| js_max(m, *v));
        capacity as f64 * max_value + 1.0
    } else {
        1.0
    };

    let mut work = 0.0;
    let mut state: IndexMap<u64, Dist> = IndexMap::new();
    state.insert(
        state_key(dice, 0, 0, 0),
        IndexMap::from([(Damage(0.0), 1.0)]),
    );
    for index in 0..faces.len() {
        let face = faces[index];
        let can_reroll = face.gain > 0.0;
        // Once the faces that can reroll are placed, the number of rerolled dice is settled.
        let more_rerolls = index + 1 < faces.len() && faces[index + 1].gain > 0.0;
        let p_cond = js_min(1.0, face.p / face.remaining);
        let q_cond = face.after / face.remaining;
        let mut fresh_weight = vec![1.0];
        for count in 1..=capacity {
            let prev: f64 = fresh_weight[count - 1];
            fresh_weight.push((prev * face.p) / count as f64);
        }
        let mut shown_by: HashMap<usize, Vec<f64>> = HashMap::new();
        let mut next: IndexMap<u64, Dist> = IndexMap::new();

        for (key, sums) in &state {
            let (unplaced, rerolled, fresh, matched) = unpack(*key);
            let shown = shown_by
                .entry(unplaced)
                .or_insert_with(|| binomial_weights(unplaced, p_cond, q_cond));

            for (x, &px) in shown.iter().enumerate() {
                if px <= 0.0 {
                    continue;
                }
                let rerolled_here = if can_reroll {
                    x.min(capacity.saturating_sub(rerolled))
                } else {
                    0
                };
                let kept = x - rerolled_here;
                let settled = if more_rerolls {
                    capacity.min(rerolled + rerolled_here + unplaced - x)
                } else {
                    rerolled + rerolled_here
                };
                let mut placed = 0;
                while placed <= capacity.saturating_sub(fresh) && fresh + placed <= settled {
                    let weight = px * fresh_weight[placed];
                    let dest_key = state_key(
                        unplaced - x,
                        rerolled + rerolled_here,
                        fresh + placed,
                        usize::from(matched == 1 || kept + placed >= 2),
                    );
                    let shift = kept as f64 * face.value * span + placed as f64 * face.value;
                    let dest = next.entry(dest_key).or_default();
                    for (sum, pr) in sums {
                        *dest.entry(Damage(sum.0 + shift)).or_insert(0.0) += pr * weight;
                    }
                    work += sums.len() as f64;
                    placed += 1;
                }
            }
            if work > MATCH_WORK_LIMIT {
                return None;
            }
        }
        state = next;
    }

    // Every die is placed and every reroll has its fresh die: `j!` turns the fresh dice's masses
    // into probabilities. The others (a fresh die too many for the dice rerolled, or too few) are
    // not outcomes.
    let mut factorial = vec![1.0];
    for count in 1..=capacity {
        let prev: f64 = factorial[count - 1];
        factorial.push(prev * count as f64);
    }
    let mut finals: Vec<Final> = Vec::new();
    for (key, sums) in state {
        let (unplaced, rerolled, fresh, matched) = unpack(key);
        if unplaced == 0 && fresh == rerolled {
            finals.push(Final {
                rerolled,
                matched: matched == 1,
                sums,
            });
        }
    }
    let kept_of = |sum: f64| (sum - (sum % span)) / span;

    let mut best_of: Option<BestOfRolls> = None;
    if trials > 1.0 {
        let mut score_mass: IndexMap<Damage, f64> = IndexMap::new();
        for f in &finals {
            let offset = kind.mean * f.rerolled as f64;
            for (sum, pr) in &f.sums {
                let grid = Damage(js_round((kept_of(sum.0) + offset) * GRID));
                *score_mass.entry(grid).or_insert(0.0) += pr * factorial[f.rerolled];
            }
        }
        best_of = Some(BestOfRolls::new(&score_mass, trials));
    }

    let mut total: Dist = IndexMap::new();
    let mut matched_dist: Dist = IndexMap::new();
    for f in &finals {
        let offset = kind.mean * f.rerolled as f64;
        for (sum, pr) in &f.sums {
            let mut mass = pr * factorial[f.rerolled];
            if let Some(b) = &best_of {
                mass *= b.weight(kept_of(sum.0) + offset);
            }
            let damage = Damage(kept_of(sum.0) + (sum.0 % span));
            *total.entry(damage).or_insert(0.0) += mass;
            if f.matched {
                *matched_dist.entry(damage).or_insert(0.0) += mass;
            }
        }
    }
    Some(PoolMatch {
        total,
        match_: matched_dist,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-12;

    fn die(sides: usize, count: f64) -> PoolDieKind {
        PoolDieKind {
            values: (1..=sides).map(|v| v as f64).collect(),
            probs: vec![1.0 / sides as f64; sides],
            count,
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    /// Reference: enumerate every roll, reroll the (up to `budget`) dice with the largest positive
    /// gain `mean - shown`, then every fresh roll, and tally the total and the match.
    fn oracle(sides: usize, count: usize, budget: usize) -> (IndexMap<i64, f64>, f64) {
        let mean = (sides as f64 + 1.0) / 2.0;
        let mut total: IndexMap<i64, f64> = IndexMap::new();
        let mut p_match = 0.0;
        let rolls = sides.pow(count as u32);
        for code in 0..rolls {
            let mut dice: Vec<usize> = Vec::new();
            let mut c = code;
            for _ in 0..count {
                dice.push(c % sides + 1);
                c /= sides;
            }
            let mut order: Vec<usize> = (0..count).collect();
            order.sort_by(|a, b| dice[*a].cmp(&dice[*b]));
            let rerolled: Vec<usize> = order
                .into_iter()
                .filter(|i| mean - dice[*i] as f64 > 1e-9)
                .take(budget)
                .collect();
            let kept: Vec<usize> = (0..count)
                .filter(|i| !rerolled.contains(i))
                .map(|i| dice[i])
                .collect();
            let fresh_rolls = sides.pow(rerolled.len() as u32);
            for f in 0..fresh_rolls {
                let mut landed = kept.clone();
                let mut g = f;
                for _ in 0..rerolled.len() {
                    landed.push(g % sides + 1);
                    g /= sides;
                }
                let p = 1.0 / (rolls * fresh_rolls) as f64;
                let sum: usize = landed.iter().sum();
                *total.entry(sum as i64).or_insert(0.0) += p;
                let mut sorted = landed.clone();
                sorted.sort_unstable();
                if sorted.windows(2).any(|w| w[0] == w[1]) {
                    p_match += p;
                }
            }
        }
        (total, p_match)
    }

    #[test]
    fn reroll_pmf_matches_the_brute_force_oracle() -> Result<(), DiceError> {
        for (sides, count, budget) in [(8, 2, 1), (6, 3, 1), (6, 3, 2), (4, 3, 3), (4, 2, 1)] {
            let pmf = reroll_up_to_pmf(&[die(sides, count as f64)], budget as f64, 1.0, 0.0)?;
            let (total, _) = oracle(sides, count, budget);
            for (v, p) in &total {
                assert!(
                    close(pmf.p_at(*v as f64), *p),
                    "{sides}d{count} budget {budget} at {v}"
                );
            }
            assert_eq!(pmf.support().len(), total.len());
        }
        Ok(())
    }

    #[test]
    fn match_agrees_with_the_oracle_and_with_the_pmf() -> Result<(), DiceError> {
        for (sides, count, budget) in [(8, 2, 1), (6, 3, 1), (4, 2, 1), (4, 3, 2)] {
            let m = reroll_up_to_match(&die(sides, count as f64), budget as f64, 1.0)?
                .ok_or("refused")?;
            let (total, p_match) = oracle(sides, count, budget);
            for (v, p) in &total {
                assert!(close(
                    m.total.get(&Damage(*v as f64)).copied().unwrap_or(0.0),
                    *p
                ));
            }
            assert!(
                close(m.match_.values().sum::<f64>(), p_match),
                "{sides}d{count}/{budget}"
            );
            let pmf = reroll_up_to_pmf(&[die(sides, count as f64)], budget as f64, 1.0, 0.0)?;
            for (v, p) in &m.total {
                assert!(close(pmf.p_at(v.0), *p));
            }
        }
        Ok(())
    }

    /// tests/dice-match-pools.test.ts:229: 2d8 rerolling 1 matches 5/32 of the time.
    #[test]
    fn two_d8_rerolling_one_matches_five_thirty_seconds() -> Result<(), DiceError> {
        let m = reroll_up_to_match(&die(8, 2.0), 1.0, 1.0)?.ok_or("refused")?;
        assert!(close(m.match_.values().sum::<f64>(), 5.0 / 32.0));
        // The same pool with no reroll matches 1 time in 8 (test line 245).
        let m = reroll_up_to_match(&die(8, 2.0), 0.0, 1.0)?.ok_or("refused")?;
        assert!(close(m.match_.values().sum::<f64>(), 1.0 / 8.0));
        Ok(())
    }

    /// tests/dice-match-pools.test.ts:212 and 219: one die never matches; 2d4 rerolling 1.
    #[test]
    fn one_die_never_matches_and_two_d4_extremes() -> Result<(), DiceError> {
        let m = reroll_up_to_match(&die(8, 1.0), 1.0, 1.0)?.ok_or("refused")?;
        assert!(m.match_.is_empty());
        let m = reroll_up_to_match(&die(4, 2.0), 1.0, 1.0)?.ok_or("refused")?;
        let at = |v: f64| {
            let t = m.total.get(&Damage(v)).copied().unwrap_or(0.0);
            (m.match_.get(&Damage(v)).copied().unwrap_or(0.0), t)
        };
        let (m8, t8) = at(8.0);
        assert!(close(m8, t8));
        let (m2, t2) = at(2.0);
        assert!(close(m2, t2));
        assert!(close(at(3.0).0, 0.0));
        Ok(())
    }

    /// tests/dice-match-pools.test.ts:290: 6 dice of 1000 sides are refused (None), not an error;
    /// :296: 11d8 rerolling 5 (a 9th-level Chromatic Orb crit is 22d8) is not too big.
    #[test]
    fn too_big_pools_are_refused() -> Result<(), DiceError> {
        assert_eq!(reroll_up_to_match(&die(1000, 6.0), 2.0, 1.0)?, None);
        assert!(reroll_up_to_match(&die(8, 11.0), 5.0, 1.0)?.is_some());
        Ok(())
    }

    #[test]
    fn best_of_two_rolls_beats_one_roll() -> Result<(), DiceError> {
        let one = reroll_up_to_pmf(&[die(6, 2.0)], 1.0, 1.0, EPS)?;
        let two = reroll_up_to_pmf(&[die(6, 2.0)], 1.0, 2.0, EPS)?;
        assert!(close(two.mass(), 1.0));
        assert!(two.mean() > one.mean());
        let m = reroll_up_to_match(&die(6, 2.0), 1.0, 2.0)?.ok_or("refused")?;
        for (v, p) in &m.total {
            assert!(close(two.p_at(v.0), *p));
        }
        Ok(())
    }

    #[test]
    fn partial_with_nothing_rolled_once_is_the_plain_pool() -> Result<(), DiceError> {
        for rolls in [1.0, 2.0] {
            let whole = reroll_up_to_pmf(&[die(6, 3.0)], 1.0, rolls, EPS)?;
            let partial = reroll_up_to_partial_pmf(&[die(6, 3.0)], &[], 1.0, rolls, EPS)?;
            for v in whole.support() {
                assert!(
                    close(whole.p_at(v.0), partial.p_at(v.0)),
                    "rolls {rolls} at {v}"
                );
            }
        }
        // Everything rolled once is the same pool whatever `rolls` is.
        let once = reroll_up_to_partial_pmf(&[], &[die(6, 3.0)], 1.0, 2.0, EPS)?;
        let plain = reroll_up_to_pmf(&[die(6, 3.0)], 1.0, 1.0, EPS)?;
        for v in plain.support() {
            assert!(close(once.p_at(v.0), plain.p_at(v.0)));
        }
        Ok(())
    }

    #[test]
    fn kind_order_does_not_change_the_bits() -> Result<(), DiceError> {
        // The point of tests/reroll-pool-order.test.ts, at the pool level.
        let kinds = [die(8, 3.0), die(6, 1.0), die(4, 2.0)];
        let reversed = [kinds[2].clone(), kinds[1].clone(), kinds[0].clone()];
        let a = reroll_up_to_pmf(&kinds, 1.0, 2.0, EPS)?;
        let b = reroll_up_to_pmf(&reversed, 1.0, 2.0, EPS)?;
        assert_eq!(a.fingerprint(), b.fingerprint());
        let pa = reroll_up_to_partial_pmf(&kinds[..1], &kinds[1..], 1.0, 2.0, EPS)?;
        let pb = reroll_up_to_partial_pmf(&kinds[..1], &reversed[..2], 1.0, 2.0, EPS)?;
        assert!(close(pa.mean(), pb.mean()));
        Ok(())
    }

    #[test]
    fn degenerate_input_is_an_error_or_a_delta() -> Result<(), DiceError> {
        assert_eq!(
            reroll_up_to_pmf(&[], 1.0, 1.0, EPS)?.support(),
            vec![Damage(0.0)]
        );
        assert_eq!(
            reroll_up_to_pmf(&[die(6, 2.0)], f64::NAN, 1.0, EPS),
            Err(DiceError::error(TOO_MANY))
        );
        assert!(reroll_up_to_pmf(&[die(6, 2.5)], 1.0, 1.0, EPS).is_err());
        assert!(reroll_up_to_pmf(&[die(6, 2.0)], 1.0, f64::INFINITY, EPS).is_err());
        let m = reroll_up_to_match(&die(6, 0.0), 1.0, 1.0)?.ok_or("refused")?;
        assert_eq!(m.total.get(&Damage(0.0)), Some(&1.0));
        Ok(())
    }
}
