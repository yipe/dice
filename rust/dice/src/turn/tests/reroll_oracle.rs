//! Port of `tests/enumerate-reroll.ts` (brute force for "reroll up to k dice, keep the new rolls") and the
//! `expectDist` / `mean` helpers of `tests/enumerate-dice.ts`, shared by `reroll_up_to` and `reroll_up_to_partial`.
//! Sums here are of whole-number faces, so a `Dist` is keyed by `i64`.

use crate::Pmf;
use crate::js::num_to_string;
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// Value -> probability.
pub type Dist = BTreeMap<i64, f64>;

const TOLERANCE: f64 = 1e-9;

/// A die's faces read from the rules: a raw face 1..`reroll` is rerolled once and the new roll is
/// kept, then `minimum` floors each shown face; `negate` makes it a subtracted die.
pub fn rule_die(sides: i64, minimum: i64, reroll: i64, negate: bool) -> Dist {
    let mut faces = Dist::new();
    let mut put = |raw: i64, p: f64| {
        let value = (if negate { -1 } else { 1 }) * raw.max(minimum);
        *faces.entry(value).or_insert(0.0) += p;
    };
    let rerolled = reroll.min(sides);
    let s = sides as f64;
    for raw in 1..=sides {
        if raw > rerolled {
            put(raw, 1.0 / s);
        } else {
            for fresh in 1..=sides {
                put(fresh, 1.0 / (s * s));
            }
        }
    }
    faces
}

pub fn mean_of(faces: &Dist) -> f64 {
    faces.iter().map(|(v, p)| *v as f64 * p).sum()
}

pub fn shifted(dist: &Dist, by: i64) -> Dist {
    dist.iter().map(|(v, p)| (v + by, *p)).collect()
}

pub fn dist_of(pmf: &Pmf) -> Dist {
    pmf.support()
        .iter()
        .map(|d| (d.0 as i64, pmf.p_at(d.0)))
        .collect()
}

/// Every bin of `actual` equals `expected` to 1e-12, with no extra or missing support.
#[track_caller]
pub fn expect_dist(actual: &Pmf, expected: &Dist) {
    let mut support: Vec<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.keys().copied());
    for v in support {
        let want = expected.get(&v).copied().unwrap_or(0.0);
        assert!((actual.p_at(v as f64) - want).abs() <= 1e-12, "bin {v}");
    }
    assert!((actual.mass() - 1.0).abs() <= 1e-12, "mass");
}

/// Dice with the same faces are one kind. Kinds are ranked by the rule that settles equal gains:
/// higher mean first, then the faces read as text.
fn kind_ids(dice: &[Dist]) -> Vec<i64> {
    let keys: Vec<String> = dice
        .iter()
        .map(|die| {
            let faces: Vec<String> = die
                .iter()
                .map(|(v, p)| format!("[{v},{}]", num_to_string(*p)))
                .collect();
            format!("[{}]", faces.join(","))
        })
        .collect();
    let mut ranked: Vec<(String, f64)> = Vec::new();
    for (key, die) in keys.iter().zip(dice) {
        match ranked.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = mean_of(die),
            None => ranked.push((key.clone(), mean_of(die))),
        }
    }
    ranked.sort_by(|a, b| {
        let diff = b.1 - a.1;
        if diff != 0.0 {
            diff.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
        } else {
            a.0.cmp(&b.0)
        }
    });
    keys.iter()
        .map(|key| ranked.iter().position(|(k, _)| k == key).unwrap_or(0) as i64)
        .collect()
}

fn tie_key(set: &[usize], kinds: &[i64]) -> Vec<i64> {
    let mut rest: Vec<i64> = set.iter().map(|&i| kinds[i] * 1000 + i as i64).collect();
    rest.sort_unstable();
    let mut key = vec![set.len() as i64];
    key.extend(rest);
    key
}

fn earlier(a: &[i64], b: &[i64]) -> bool {
    for i in 0..a.len().min(b.len()) {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    a.len() < b.len()
}

/// Everything the brute force needs of a pool: its dice, their means and kinds, the budget.
struct Pool<'a> {
    dice: &'a [Dist],
    means: Vec<f64>,
    kinds: Vec<i64>,
    budget: usize,
}

impl<'a> Pool<'a> {
    fn new(dice: &'a [Dist], budget: usize) -> Self {
        Pool {
            dice,
            means: dice.iter().map(mean_of).collect(),
            kinds: kind_ids(dice),
            budget,
        }
    }

    /// The best subset of at most `budget` dice to reroll, by trying every one: highest expected
    /// total; ties to fewer dice, then to the earlier kinds' dice.
    fn best_set(&self, values: &[i64]) -> (Vec<usize>, f64) {
        let n = self.dice.len();
        let mut best: Option<(Vec<usize>, f64)> = None;
        for mask in 0u32..(1 << n) {
            let set: Vec<usize> = (0..n).filter(|i| mask & (1 << i) != 0).collect();
            if set.len() > self.budget {
                continue;
            }
            let expected = values.iter().enumerate().fold(0.0, |total, (i, &v)| {
                total
                    + if set.contains(&i) {
                        self.means[i]
                    } else {
                        v as f64
                    }
            });
            let better = match &best {
                None => true,
                Some((best_set, best_expected)) => {
                    expected > best_expected + TOLERANCE
                        || ((expected - best_expected).abs() <= TOLERANCE
                            && earlier(
                                &tie_key(&set, &self.kinds),
                                &tie_key(best_set, &self.kinds),
                            ))
                }
            };
            if better {
                best = Some((set, expected));
            }
        }
        best.unwrap_or((Vec::new(), 0.0))
    }

    /// The total of `values` with the dice of `set` rerolled once, as a distribution.
    fn after(&self, values: &[i64], set: &[usize]) -> Dist {
        let kept: i64 = values
            .iter()
            .enumerate()
            .map(|(i, v)| if set.contains(&i) { 0 } else { *v })
            .sum();
        let mut after = Dist::from([(kept, 1.0)]);
        for &i in set {
            let mut next = Dist::new();
            for (total, pt) in &after {
                for (value, pv) in &self.dice[i] {
                    *next.entry(total + value).or_insert(0.0) += pt * pv;
                }
            }
            after = next;
        }
        after
    }
}

/// Every joint roll of `pool`: the faces in order and their probability.
fn rolls_of(pool: &[Dist]) -> Vec<(Vec<i64>, f64)> {
    let mut out = vec![(Vec::new(), 1.0)];
    for die in pool {
        let mut next = Vec::new();
        for (values, p) in &out {
            for (value, pv) in die {
                let mut v = values.clone();
                v.push(*value);
                next.push((v, p * pv));
            }
        }
        out = next;
    }
    out
}

struct Outcome {
    p: f64,
    score: f64,
    after: Dist,
}

fn list(
    trial: usize,
    rolls: usize,
    leader: Option<usize>,
    p: f64,
    outcomes: &[Outcome],
    mass: &mut [f64],
) {
    if trial == rolls {
        if let Some(l) = leader {
            mass[l] += p;
        }
        return;
    }
    for (i, outcome) in outcomes.iter().enumerate() {
        let next = match leader {
            Some(l) if outcome.score <= outcomes[l].score + TOLERANCE => l,
            _ => i,
        };
        list(trial + 1, rolls, Some(next), p * outcome.p, outcomes, mass);
    }
}

/// Distribution of the pool's total when up to `budget` dice are rerolled for the best expected
/// total and the new rolls are kept. With `rolls` above 1 the pool is rolled that many times, the
/// roll with the highest such expected total is used (the first on a tie), and only it is rerolled.
pub fn brute_force_reroll_up_to(dice: &[Dist], budget: usize, rolls: usize) -> Dist {
    let pool = Pool::new(dice, budget);
    let outcomes: Vec<Outcome> = rolls_of(dice)
        .into_iter()
        .map(|(values, p)| {
            let (set, score) = pool.best_set(&values);
            Outcome {
                p,
                score,
                after: pool.after(&values, &set),
            }
        })
        .collect();
    let mut mass = vec![0.0; outcomes.len()];
    list(0, rolls, None, 1.0, &outcomes, &mut mass);
    let mut out = Dist::new();
    for (outcome, chosen) in outcomes.iter().zip(&mass) {
        for (total, p) in &outcome.after {
            *out.entry(*total).or_insert(0.0) += chosen * p;
        }
    }
    out
}

struct Leader {
    values: Vec<i64>,
    set: Vec<usize>,
    expected: f64,
}

struct Partial<'a> {
    pool: Pool<'a>,
    repeated_rolls: Vec<(Vec<i64>, f64)>,
    rolls: usize,
    out: Dist,
}

impl Partial<'_> {
    fn play(&mut self, trial: usize, leader: Option<&Leader>, once_values: &[i64], p: f64) {
        if trial == self.rolls {
            if let Some(l) = leader {
                for (total, pt) in self.pool.after(&l.values, &l.set) {
                    *self.out.entry(total).or_insert(0.0) += p * pt;
                }
            }
            return;
        }
        for k in 0..self.repeated_rolls.len() {
            let (values, pv) = (self.repeated_rolls[k].0.clone(), self.repeated_rolls[k].1);
            let mut all = values;
            all.extend_from_slice(once_values);
            let (set, expected) = self.pool.best_set(&all);
            let candidate = Leader {
                values: all,
                set,
                expected,
            };
            let next = match leader {
                Some(l) if candidate.expected <= l.expected + TOLERANCE => None,
                _ => Some(candidate),
            };
            match (&next, leader) {
                (Some(n), _) => self.play(trial + 1, Some(n), once_values, p * pv),
                (None, l) => self.play(trial + 1, l, once_values, p * pv),
            }
        }
    }
}

/// Distribution of a pool whose `repeated` dice are rolled `rolls` times and whose `once` dice are
/// rolled once, then up to `budget` dice of the kept roll and the once-rolled dice are rerolled,
/// the new rolls kept (Savage Attacker with a Piercer reroll).
pub fn brute_force_partial_reroll_up_to(
    repeated: &[Dist],
    once: &[Dist],
    budget: usize,
    rolls: usize,
) -> Dist {
    let all: Vec<Dist> = repeated.iter().chain(once).cloned().collect();
    let mut state = Partial {
        pool: Pool::new(&all, budget),
        repeated_rolls: rolls_of(repeated),
        rolls,
        out: Dist::new(),
    };
    for (once_values, p) in rolls_of(once) {
        state.play(0, None, &once_values, p);
    }
    state.out
}
