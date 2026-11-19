//! Port of `src/builder/sample.ts`: one random draw of a roll AST, the sampling twin of
//! [`super::ast::resolve`]. Also ports `scaleValue` and `samplePMF` from `src/pmf/sample.ts`
//! (not ported elsewhere), which `RollBuilder.sample` and the scale node need.
//!
//! Draw order (what a scripted or traced [`Rng`] sees) is deterministic: depth-first, children
//! left to right, in the AST's source order. A die's reroll and then its explosions follow that
//! die at once; a `sum` draws all `count` children, then any `explodePool` extras; `keep`,
//! `d20Roll`, `maxOf` and `max` draw their trials in order; `rerollUpTo` draws every trial's whole
//! pool, then the winning trial's rerolls in pool order.
//!
//! ADR-017: a count of dice or trials above 1e6 returns `Err` (TS allocates until it dies).

use super::ast::{
    ast_from_roll_configs, die_node_from_config, find_die, get_total_count, natural_die_config,
    rerollable_pool, resolve_single_die,
};
use super::nodes::{D20RollKind, DieNode, ExpressionNode, KeepChild, KeepNode, Rounding, Sign};
use super::num::{MAX_ENUMERATED, cmp_utf16, js_max, js_min, js_round, or_zero, stable_sort_by};
use super::roll::RollBuilder;
use super::types::{KeepMode, RollType};
use crate::common::Rng;
use crate::error::DiceError;
use crate::js::num_to_string;
pub use crate::pmf::sample::{PmfSample, sample_pmf, scale_value};
use std::cmp::Ordering;

/// One physical die of a sample. `kept` is false for a die the roll dropped (rerolled away, lost a
/// keep).
#[derive(Clone, Debug, PartialEq)]
pub struct SampledDie {
    pub sides: f64,
    pub face: f64,
    pub kept: bool,
    /// TS `reroll?: true`.
    pub reroll: bool,
    /// A d20 a miss reroll added after the natural roll (see `sampleMissReroll`): part of the
    /// natural block. TS `missReroll?: true`.
    pub miss_reroll: bool,
}

/// `RollSample`.
#[derive(Clone, Debug, PartialEq)]
pub struct RollSample {
    pub total: f64,
    pub dice: Vec<SampledDie>,
}

/// `CheckDice`: the dice of one check draw: the natural roll (dropped d20s `kept: false`), then
/// every bonus die.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckDice {
    pub check: Vec<SampledDie>,
    /// The natural roll's kept face; 0 for a check with no die.
    pub natural: f64,
    /// The bonus dice's sum, penalty dice subtracted.
    pub bonus: f64,
}

/// A count of draws as a loop bound, or `Err` above [`MAX_ENUMERATED`].
fn bounded(n: f64) -> Result<usize, DiceError> {
    if n.is_nan() || n > MAX_ENUMERATED {
        return Err(DiceError::error(format!(
            "sample: {} draws is too many to sample (at most 1000000).",
            num_to_string(n)
        )));
    }
    Ok(n.max(0.0) as usize)
}

/// `rollsPerDie`: the rolls of one die under its roll type.
fn rolls_per_die(roll_type: RollType) -> usize {
    match roll_type {
        RollType::ElvenAccuracy => 3,
        RollType::Flat => 1,
        _ => 2,
    }
}

fn d20_node(roll_type: RollType, die: DieNode) -> ExpressionNode {
    let kind = match roll_type {
        RollType::Disadvantage => D20RollKind::Disadvantage,
        RollType::ElvenAccuracy => D20RollKind::ElvenAccuracy,
        _ => D20RollKind::Advantage,
    };
    ExpressionNode::D20Roll(super::nodes::D20RollNode {
        roll_type: kind,
        child: Box::new(ExpressionNode::Die(die)),
    })
}

/// `sampleCheckDice`: the sampling twin of `resolveRootD20`: one draw of the natural die under its
/// roll type (the dice in roll order), then of each bonus die group in config order. The flat
/// modifier is not added.
pub fn sample_check_dice(check: &RollBuilder, rng: &mut dyn Rng) -> Result<CheckDice, DiceError> {
    let mut dice: Vec<SampledDie> = Vec::new();
    let mut natural = 0.0;
    if let Some(root) = natural_die_config(check)? {
        let die = die_node_from_config(&root)?;
        let roll_type = check.roll_type();
        let node = if roll_type == RollType::Flat {
            ExpressionNode::Die(die)
        } else {
            d20_node(roll_type, die)
        };
        let s = sample_node(&node, rng)?;
        natural = s.total;
        dice.extend(s.dice);
    }
    let mut bonus = 0.0;
    for config in check.get_bonus_dice_configs() {
        let node = ast_from_roll_configs(std::slice::from_ref(&config))?.ok_or_else(|| {
            DiceError::type_error("Cannot read properties of undefined (reading 'type')")
        })?;
        let s = sample_node(&node, rng)?;
        bonus += s.total;
        dice.extend(s.dice);
    }
    Ok(CheckDice {
        check: dice,
        natural,
        bonus,
    })
}

/// One natural d20 of [`ReadCheck`]: `index` into the dice list.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Natural {
    pub index: usize,
    pub face: f64,
}

/// What [`read_check_dice`] returns.
#[derive(Clone, Debug, PartialEq)]
pub struct ReadCheck {
    pub naturals: Vec<Natural>,
    pub bonus: f64,
    pub rolled: usize,
}

/// `readCheckDice`: what a sampled check drew, read back from its dice (see
/// [`sample_check_dice`]). Refuses bonus dice that explode or keep, whose dice cannot be told
/// apart from the list.
pub fn read_check_dice(check: &RollBuilder, dice: &[SampledDie]) -> Result<ReadCheck, DiceError> {
    // A die rolled again by its own `reroll` is listed twice, and the second one carries the flag.
    let is_final = |index: usize| !dice.get(index + 1).is_some_and(|d| d.reroll);
    let mut naturals: Vec<Natural> = Vec::new();
    let mut at = 0usize;
    // The natural roll lists exactly its own dice; a following d20 is a bonus die.
    let natural_rolls = if natural_die_config(check)?.is_some() {
        rolls_per_die(check.roll_type())
    } else {
        0
    };
    while at < dice.len() && naturals.len() < natural_rolls {
        if is_final(at) {
            naturals.push(Natural {
                index: at,
                face: dice[at].face,
            });
        }
        at += 1;
    }
    // Each earlier miss reroll inserted its d20 right after the natural dice.
    while at < dice.len() && dice[at].miss_reroll {
        if is_final(at) {
            naturals.push(Natural {
                index: at,
                face: dice[at].face,
            });
        }
        at += 1;
    }
    let rolled = at;
    let mut bonus = 0.0;
    for config in check.get_bonus_dice_configs() {
        if config.explode > 0.0
            || config.explode_pool_budget > 0.0
            || config.keep.is_some()
            || config.best_of > 1.0
        {
            return Err(DiceError::error(
                "A sampled check's bonus dice cannot be read back: one explodes or keeps.",
            ));
        }
        let sign = if config.is_subtraction == Some(true) || config.count < 0.0 {
            -1.0
        } else {
            1.0
        };
        let per_die = rolls_per_die(config.roll_type);
        let dice_count = config.count.abs().floor();
        let mut die = 0.0;
        while die < dice_count {
            let mut seen = 0;
            while seen < per_die {
                if at >= dice.len() {
                    return Err(DiceError::error(
                        "A sampled check has fewer bonus dice than its check rolls.",
                    ));
                }
                if !is_final(at) {
                    at += 1;
                    continue;
                }
                // Of the rolls of one die, only the selected one is `kept`.
                if dice[at].kept {
                    bonus += sign * dice[at].face;
                }
                seen += 1;
                at += 1;
            }
            die += 1.0;
        }
    }
    Ok(ReadCheck {
        naturals,
        bonus,
        rolled,
    })
}

/// Gains and scores compare on the same grid as `reroll-pool.ts`, so float noise never flips a
/// choice.
const GRID: f64 = 1e9;

fn dropped(dice: &[SampledDie]) -> Vec<SampledDie> {
    dice.iter()
        .map(|x| SampledDie {
            kept: false,
            ..x.clone()
        })
        .collect()
}

/// `sampleDie`: one die under its own reroll (once, keeping the new roll), minimum and per-die
/// explode: the sampling twin of `resolveSingleDie`. Returns the face (explosions included) and
/// the physical dice.
pub fn sample_die(die: &DieNode, rng: &mut dyn Rng) -> (f64, Vec<SampledDie>) {
    let sides = js_max(0.0, die.sides.floor());
    if sides <= 0.0 || sides.is_nan() {
        return (0.0, Vec::new());
    }
    let reroll_at_or_below = js_min(
        js_max(0.0, or_zero(die.reroll.unwrap_or(0.0)).floor()),
        sides,
    );
    let minimum = js_max(0.0, or_zero(die.minimum.unwrap_or(0.0)).floor());
    let times = or_zero(die.explode.unwrap_or(0.0)).floor();
    let mut dice: Vec<SampledDie> = Vec::new();
    let one = |dice: &mut Vec<SampledDie>, rng: &mut dyn Rng| -> f64 {
        let mut face = rng.die(sides);
        let mut reroll = false;
        if face <= reroll_at_or_below {
            dice.push(SampledDie {
                sides,
                face,
                kept: false,
                reroll: false,
                miss_reroll: false,
            });
            face = rng.die(sides);
            reroll = true;
        }
        face = js_max(face, minimum);
        dice.push(SampledDie {
            sides,
            face,
            kept: true,
            reroll,
            miss_reroll: false,
        });
        face
    };
    let mut total = one(&mut dice, rng);
    // Only the max face chains, at most `times` extra dice; a die that always shows its max
    // (one-sided, or `minimum` at `sides`) explodes exactly `times` times.
    let mut extra = 0.0;
    while extra < times && dice.last().is_some_and(|d| d.face == sides) {
        total += one(&mut dice, rng);
        extra += 1.0;
    }
    (total, dice)
}

/// The highest total wins; ties go to the earliest roll. `lowest` flips the comparison.
fn keep_best(rolls: Vec<RollSample>, lowest: bool) -> Result<RollSample, DiceError> {
    if rolls.is_empty() {
        return Err(DiceError::type_error(
            "Cannot read properties of undefined (reading 'total')",
        ));
    }
    let mut best = 0;
    for (i, s) in rolls.iter().enumerate() {
        let better = if lowest {
            s.total < rolls[best].total
        } else {
            s.total > rolls[best].total
        };
        if better {
            best = i;
        }
    }
    let total = rolls[best].total;
    let mut dice = Vec::new();
    for (i, s) in rolls.into_iter().enumerate() {
        if i == best {
            dice.extend(s.dice);
        } else {
            dice.extend(dropped(&s.dice));
        }
    }
    Ok(RollSample { total, dice })
}

/// `node.child.child` of a keep, sampled.
fn sample_grandchild(node: &KeepNode, rng: &mut dyn Rng) -> Result<RollSample, DiceError> {
    match &*node.child {
        KeepChild::Sum(s) => sample_node(&s.child, rng),
        KeepChild::Keep(inner) => match &*inner.child {
            KeepChild::Sum(s) => sample_node(&ExpressionNode::Sum(s.clone()), rng),
            KeepChild::Keep(k) => sample_node(&ExpressionNode::Keep(k.clone()), rng),
        },
    }
}

/// `sampleNode`: one draw of `node`.
pub fn sample_node(node: &ExpressionNode, rng: &mut dyn Rng) -> Result<RollSample, DiceError> {
    match node {
        ExpressionNode::Constant(c) => Ok(RollSample {
            total: c.value,
            dice: Vec::new(),
        }),

        ExpressionNode::Die(d) => {
            let (total, dice) = sample_die(d, rng);
            Ok(RollSample { total, dice })
        }

        ExpressionNode::Sum(s) => {
            let n = bounded(js_max(0.0, s.count.floor()))?;
            let mut dice: Vec<SampledDie> = Vec::new();
            let mut total = 0.0;
            for _ in 0..n {
                let drawn = sample_node(&s.child, rng)?;
                total += drawn.total;
                dice.extend(drawn.dice);
            }
            let budget = s.explode_pool_budget.map_or(0.0, f64::floor);
            if n > 0 && budget > 0.0 {
                let die = find_die(&s.child).ok_or_else(|| {
                    DiceError::error("explodePool() requires the pool's child to be a plain die.")
                })?;
                bounded(budget)?;
                // `resolveExplodingPool`: each max face showing spends one budget on one more die,
                // which may itself show max; stops when no max face is pending or the budget is
                // spent.
                let mut pending = dice
                    .iter()
                    .filter(|x| x.kept && x.face == die.sides)
                    .count() as f64;
                let mut left = budget;
                let plain = DieNode {
                    explode: Some(0.0),
                    ..die.clone()
                };
                while pending > 0.0 && left > 0.0 {
                    let (face, extra) = sample_die(&plain, rng);
                    total += face;
                    dice.extend(extra);
                    pending += if face == die.sides { 0.0 } else { -1.0 };
                    left -= 1.0;
                }
            }
            Ok(RollSample { total, dice })
        }

        ExpressionNode::Add(a) => {
            let mut dice: Vec<SampledDie> = Vec::new();
            let mut total = 0.0;
            for c in &a.children {
                let drawn = sample_node(&c.node, rng)?;
                total += c.sign.value() * drawn.total;
                dice.extend(drawn.dice);
            }
            Ok(RollSample { total, dice })
        }

        ExpressionNode::Keep(k) => sample_keep(k, rng),

        ExpressionNode::D20Roll(r) => {
            let n = if r.roll_type == D20RollKind::ElvenAccuracy {
                3
            } else {
                2
            };
            let mut rolls = Vec::with_capacity(n);
            for _ in 0..n {
                rolls.push(sample_node(&r.child, rng)?);
            }
            keep_best(rolls, r.roll_type == D20RollKind::Disadvantage)
        }

        ExpressionNode::Half(h) => {
            let s = sample_node(&h.child, rng)?;
            Ok(RollSample {
                total: scale_value(s.total, 0.5, Rounding::Floor, 1.0),
                dice: s.dice,
            })
        }

        ExpressionNode::Scale(sc) => {
            let s = sample_node(&sc.child, rng)?;
            let denominator = if sc.denominator == 0.0 {
                1.0
            } else {
                sc.denominator
            };
            Ok(RollSample {
                total: scale_value(s.total, sc.numerator, sc.rounding, denominator),
                dice: s.dice,
            })
        }

        ExpressionNode::MaxOf(m) => {
            let count = bounded(js_max(1.0, m.count.floor()))?;
            let mut rolls = Vec::with_capacity(count);
            for _ in 0..count {
                rolls.push(sample_node(&m.child, rng)?);
            }
            keep_best(rolls, false)
        }

        ExpressionNode::Max(m) => {
            let mut rolls = Vec::with_capacity(m.children.len());
            for c in &m.children {
                rolls.push(sample_node(c, rng)?);
            }
            keep_best(rolls, false)
        }

        ExpressionNode::RerollUpTo(r) => {
            sample_reroll_up_to(&r.child, r.budget, r.rolls, rng, r.rolled_once.as_deref())
        }
    }
}

fn sample_keep(node: &KeepNode, rng: &mut dyn Rng) -> Result<RollSample, DiceError> {
    let trials_f = get_total_count(node);
    let trials = bounded(trials_f)?;
    let k = js_max(0.0, js_min(node.count, trials_f));
    let mut samples: Vec<RollSample> = Vec::with_capacity(trials);
    for _ in 0..trials {
        samples.push(sample_grandchild(node, rng)?);
    }
    let mut order: Vec<usize> = (0..trials).collect();
    let highest = node.mode == KeepMode::Highest;
    stable_sort_by(&mut order, |a, b| {
        let diff = samples[*b].total - samples[*a].total;
        let signed = if highest { diff } else { -diff };
        if signed == 0.0 || signed.is_nan() {
            a.cmp(b)
        } else if signed < 0.0 {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    });
    let keep_n = if k.is_nan() { 0 } else { k as usize };
    let kept: Vec<usize> = order.into_iter().take(keep_n).collect();
    let mut total = 0.0;
    let mut dice: Vec<SampledDie> = Vec::new();
    for (i, s) in samples.into_iter().enumerate() {
        if kept.contains(&i) {
            total += s.total;
            dice.extend(s.dice);
        } else {
            dice.extend(dropped(&s.dice));
        }
    }
    Ok(RollSample { total, dice })
}

/// One die group of a `rerollUpTo` pool, in the order the child lists it.
struct PoolKind {
    die: DieNode,
    count: f64,
    sign: Sign,
    /// Mean of the signed faces: what a reroll of this kind is worth.
    mean: f64,
    /// Position in canonical order (higher mean first, then the faces key): breaks gain ties.
    rank: usize,
}

struct PoolDie {
    kind: usize,
    /// Signed face.
    value: f64,
    dice: Vec<SampledDie>,
}

struct PoolRoll {
    pool: Vec<PoolDie>,
    /// Indices into `pool` then the rolled-once dice to reroll: the up-to-`budget` dice with the
    /// largest positive gain.
    chosen: Vec<usize>,
    /// Kept faces plus the means of the rerolled dice: the roll's worth after its rerolls.
    score: f64,
}

/// A JS comparator chain `a || b || c`: the first term that is neither 0 nor NaN decides.
fn chain(terms: &[f64]) -> Ordering {
    for t in terms {
        if *t < 0.0 {
            return Ordering::Less;
        }
        if *t > 0.0 {
            return Ordering::Greater;
        }
    }
    Ordering::Equal
}

/// The `reroll-pool.ts` policy: reroll the up-to-`budget` dice with the largest positive expected
/// gain `mean - shown`, ties to the kind with the higher mean (then the lower faces key), then to
/// the lower face. With `rolls` above 1 the pool is rolled that many times and the roll scoring
/// highest is the one rerolled; a tie keeps the earlier roll. `rolled_once` dice are drawn once,
/// after every roll of the pool, and are scored and rerolled with each roll.
fn sample_reroll_up_to(
    child: &ExpressionNode,
    budget: f64,
    rolls: f64,
    rng: &mut dyn Rng,
    rolled_once: Option<&ExpressionNode>,
) -> Result<RollSample, DiceError> {
    struct Scored {
        die: DieNode,
        count: f64,
        sign: Sign,
        mean: f64,
        key: String,
    }

    let own = rerollable_pool(child)?;
    let once = match rolled_once {
        Some(o) => rerollable_pool(o)?,
        None => super::ast::RerollablePool {
            groups: Vec::new(),
            flat: 0.0,
        },
    };
    let own_groups = own.groups.len();
    let mut scored: Vec<Scored> = Vec::new();
    for group in own.groups.iter().chain(once.groups.iter()) {
        let single = resolve_single_die(&group.die, 0.0)?;
        let faces = single.support();
        let sign = group.sign.value();
        let mean = faces
            .iter()
            .fold(0.0, |m, f| m + sign * f.0 * single.p_at(f.0));
        let key = format!(
            "{}|{}",
            faces
                .iter()
                .map(|f| num_to_string(sign * f.0))
                .collect::<Vec<_>>()
                .join(","),
            faces
                .iter()
                .map(|f| num_to_string(single.p_at(f.0)))
                .collect::<Vec<_>>()
                .join(",")
        );
        scored.push(Scored {
            die: group.die.clone(),
            count: group.count,
            sign: group.sign,
            mean,
            key,
        });
    }
    let mut canonical: Vec<usize> = (0..scored.len()).collect();
    stable_sort_by(&mut canonical, |a, b| {
        let by_mean = js_round((scored[*b].mean - scored[*a].mean) * GRID);
        if by_mean != 0.0 && !by_mean.is_nan() {
            return chain(&[by_mean]);
        }
        cmp_utf16(&scored[*a].key, &scored[*b].key)
    });
    let kinds: Vec<PoolKind> = scored
        .iter()
        .enumerate()
        .map(|(i, s)| PoolKind {
            die: s.die.clone(),
            count: s.count,
            sign: s.sign,
            mean: s.mean,
            rank: canonical.iter().position(|c| *c == i).unwrap_or(0),
        })
        .collect();
    let capacity = js_max(0.0, budget.floor());
    let capacity_n = if capacity.is_nan() {
        0
    } else {
        capacity.min(MAX_ENUMERATED * 10.0) as usize
    };
    let trials = bounded(js_max(1.0, rolls.floor()))?;

    let draw = |from: usize, to: usize, rng: &mut dyn Rng| -> Result<Vec<PoolDie>, DiceError> {
        let mut out = Vec::new();
        for (offset, kind) in kinds[from..to].iter().enumerate() {
            for _ in 0..bounded(kind.count)? {
                let (face, dice) = sample_die(&kind.die, rng);
                out.push(PoolDie {
                    kind: from + offset,
                    value: kind.sign.value() * face,
                    dice,
                });
            }
        }
        Ok(out)
    };
    let mut pools: Vec<Vec<PoolDie>> = Vec::with_capacity(trials);
    for _ in 0..trials {
        pools.push(draw(0, own_groups, rng)?);
    }
    let once_pool = draw(own_groups, kinds.len(), rng)?;

    let mut attempts: Vec<PoolRoll> = Vec::with_capacity(pools.len());
    for pool in pools {
        let seen: Vec<&PoolDie> = pool.iter().chain(once_pool.iter()).collect();
        let gain = |i: usize| js_round((kinds[seen[i].kind].mean - seen[i].value) * GRID);
        let mut candidates: Vec<usize> = (0..seen.len()).filter(|i| gain(*i) > 0.0).collect();
        stable_sort_by(&mut candidates, |a, b| {
            chain(&[
                gain(*b) - gain(*a),
                kinds[seen[*a].kind].rank as f64 - kinds[seen[*b].kind].rank as f64,
                seen[*a].value - seen[*b].value,
            ])
        });
        let chosen: Vec<usize> = candidates.into_iter().take(capacity_n).collect();
        let score = seen.iter().enumerate().fold(0.0, |s, (i, d)| {
            s + if chosen.contains(&i) {
                kinds[d.kind].mean
            } else {
                d.value
            }
        });
        drop(seen);
        attempts.push(PoolRoll {
            pool,
            chosen,
            score,
        });
    }
    // Scores compare on the grid exactly as `rerollUpToPMF` keys them; the first highest wins.
    let mut best = 0;
    for (i, a) in attempts.iter().enumerate() {
        if js_round(a.score * GRID) > js_round(attempts[best].score * GRID) {
            best = i;
        }
    }

    let mut total = own.flat + once.flat;
    let mut dice: Vec<SampledDie> = Vec::new();
    // `j` indexes the kept roll then the rolled-once dice, as `chosen` does.
    let play = |d: &PoolDie,
                j: usize,
                chosen: &[usize],
                total: &mut f64,
                dice: &mut Vec<SampledDie>,
                rng: &mut dyn Rng| {
        if !chosen.contains(&j) {
            *total += d.value;
            dice.extend(d.dice.iter().cloned());
            return;
        }
        dice.extend(dropped(&d.dice));
        let kind = &kinds[d.kind];
        let (face, rerolled) = sample_die(&kind.die, rng);
        *total += kind.sign.value() * face;
        dice.extend(
            rerolled
                .into_iter()
                .map(|x| SampledDie { reroll: true, ..x }),
        );
    };
    let kept_len = attempts.get(best).map_or(0, |a| a.pool.len());
    let chosen_best: Vec<usize> = attempts
        .get(best)
        .map(|a| a.chosen.clone())
        .unwrap_or_default();
    for (i, attempt) in attempts.iter().enumerate() {
        if i == best {
            for (j, d) in attempt.pool.iter().enumerate() {
                play(d, j, &chosen_best, &mut total, &mut dice, rng);
            }
        } else {
            for d in &attempt.pool {
                dice.extend(dropped(&d.dice));
            }
        }
    }
    for (j, d) in once_pool.iter().enumerate() {
        play(d, kept_len + j, &chosen_best, &mut total, &mut dice, rng);
    }
    Ok(RollSample { total, dice })
}
