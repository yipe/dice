//! Port of `src/builder/ast.ts`: roll configs to an expression tree, and the tree to a [`Pmf`].
//!
//! Skipped: `builderPMFCache`, `singleDiePMFCache`, `d20RollLiftCache` and `clearDieCaches`.
//! Throws are `Err(`[`DiceError`]`)`; `AmbiguousKeepError` is its `AmbiguousKeep` variant.
//!
//! ADR-016: every recursion here follows the AST, whose depth is bounded by the builder nesting
//! cap (`roll::MAX_BUILDER_DEPTH`), so no function carries a counter.
//!
//! ADR-017 deviations (TS allocates until it dies or computes nonsense):
//! - a die with more than 1e6 sides, an exploding die with a cap above 10,000 extra dice, and an
//!   exploding pool whose `count * budget` exceeds 1e6 return `Err`;
//! - a keep of a non-integer or NaN count, or of more than 1e6 trials, returns `Err` (TS indexes
//!   its DP state with the fractional count and returns an empty mass).
//! - `resolveExplodingPool` is an iterative DP over the same `(pending, budget)` grid the TS
//!   memoises recursively (same values, no recursion).

use super::d20::d20_roll_pmf;
use super::nodes::{
    AddChild, AddNode, ConstantNode, D20RollKind, D20RollNode, DieNode, ExpressionNode, KeepChild,
    KeepNode, MaxOfNode, Rounding, Sign, SumNode,
};
use super::num::{MAX_ENUMERATED, cmp_utf16, is_integer, js_max, js_min, or_zero, stable_sort_by};
use super::reroll_pool::{PoolDieKind, reroll_up_to_partial_pmf, reroll_up_to_pmf};
use super::roll::{RollBuilder, natural_roll_index};
use super::types::{KeepMode, KeepSpec, RollConfig, RollType};
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::{Damage, EPS, Pmf};
use indexmap::IndexMap;
use std::borrow::Cow;
use std::sync::Arc;

use crate::pmf::cache::{BUILDER_CACHE, D20_LIFT_CACHE, SINGLE_DIE_CACHE};

/// Default epsilon 0: single-die PMFs resolve without pruning.
const DEFAULT_EPS: f64 = 0.0;

/// Most extra dice a per-die `explode` chain builds before this port refuses (ADR-017).
const MAX_EXPLODE: f64 = 10_000.0;

/// Most `(pending dice, budget)` states an exploding pool computes (ADR-017).
const MAX_POOL_STATES: f64 = 1e6;

/// `x > 0` for an optional number (`part.explode! > 0`).
fn opt_pos(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v > 0.0)
}

/// JS truthiness of an optional number.
fn opt_truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

/// `dieNodeFromConfig`.
pub fn die_node_from_config(cfg: &RollConfig) -> Result<DieNode, DiceError> {
    if !cfg.explode.is_finite() {
        return Err(DiceError::error(format!(
            "An exploding d{} needs a finite cap, got explode({}): explode(k) allows at most k extra dice per die.",
            num_to_string(cfg.sides),
            num_to_string(cfg.explode)
        )));
    }
    Ok(DieNode {
        sides: cfg.sides,
        reroll: (cfg.reroll > 0.0).then_some(cfg.reroll),
        minimum: (cfg.minimum > 0.0).then_some(cfg.minimum),
        explode: (cfg.explode > 0.0).then_some(cfg.explode),
    })
}

/// How a per-die keep on a group reads: `"dice"` (keep K of T single dice) or `"trials"` (roll the
/// whole group T times and keep K of those sums).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeepReading {
    Dice,
    Trials,
}

/// `perDieKeepReading`: `Err` is an `AmbiguousKeepError`.
pub fn per_die_keep_reading(
    count: f64,
    sides: f64,
    keep: &KeepSpec,
    synthesized_best_of: bool,
) -> Result<KeepReading, DiceError> {
    let n = count.abs().floor();
    if n <= 1.0 || synthesized_best_of {
        return Ok(KeepReading::Dice);
    }
    let trials = js_max(1.0, keep.total.floor());
    let k = js_max(0.0, keep.count.floor());
    if k == 0.0 {
        return Ok(KeepReading::Dice);
    }
    if k == 1.0 && (keep.mode == KeepMode::Highest || trials != n) {
        return Ok(KeepReading::Trials);
    }
    if k >= 2.0 && trials == n {
        return Ok(KeepReading::Dice);
    }
    let verb = if keep.mode == KeepMode::Highest {
        "keepHighest"
    } else {
        "keepLowest"
    };
    let which = keep.mode.as_str();
    let (n, sides) = (num_to_string(n), num_to_string(sides));
    let (trials, k) = (num_to_string(trials), num_to_string(k));
    Err(DiceError::AmbiguousKeep(format!(
        "{verb}({}, {}) on {n}d{sides} has more than one reading. For the {which} \
         {k} of {trials} rolls of the whole {n}d{sides}, use roll({n}, d{sides}).{verb}All({trials}, {k}); \
         for the {which} {k} of {trials} single d{sides}, use roll(1, d{sides}).{verb}({trials}, {k}), \
         adding one such group for each set of dice you mean.",
        num_to_string(keep.total),
        num_to_string(keep.count),
    )))
}

fn sum_node(count: f64, child: ExpressionNode) -> SumNode {
    SumNode {
        count,
        child: Box::new(child),
        explode_pool_budget: None,
    }
}

/// `astFromRollConfigs`: `None` for no configs.
pub fn ast_from_roll_configs(configs: &[RollConfig]) -> Result<Option<ExpressionNode>, DiceError> {
    if configs.is_empty() {
        return Ok(None);
    }

    let mut children: Vec<AddChild> = Vec::new();
    let mut constant_sum = 0.0;

    for cfg in configs {
        let sign = if cfg.is_subtraction == Some(true) || cfg.count < 0.0 {
            Sign::Minus
        } else {
            Sign::Plus
        };
        let count = or_zero(cfg.count).abs().floor();

        constant_sum += or_zero(cfg.modifier);

        // A group of zero dice rolls nothing; only its flat modifier (added above) remains.
        if or_zero(cfg.sides) <= 0.0 || count == 0.0 {
            continue;
        }

        // `bestOf(k)` ("roll N, keep the highest k") is `keep = {total: N, count: k, mode: "highest"}`
        // over the same die.
        let is_synthesized_best_of = cfg.keep.is_none() && cfg.best_of > 0.0 && cfg.best_of < count;
        let effective_keep = if is_synthesized_best_of {
            Some(KeepSpec {
                total: count,
                count: cfg.best_of.floor(),
                mode: KeepMode::Highest,
            })
        } else {
            cfg.keep
        };

        let die = die_node_from_config(cfg)?;

        let node: ExpressionNode = if cfg.roll_type != RollType::Flat {
            if cfg.explode_pool_budget > 0.0 {
                return Err(DiceError::error(
                    "explodePool() cannot be combined with advantage/disadvantage/elven-accuracy on the same config — pool-wide explosion is for damage dice pools, not d20 rolls.",
                ));
            }
            // Each die of the group is rolled with the roll type on its own: `roll(2, d6).withAdvantage()`
            // is two advantaged d6, the same as `roll(2, d6.withAdvantage())`.
            let rolled = if cfg.sides == 20.0 {
                let kind = match cfg.roll_type {
                    RollType::Advantage => D20RollKind::Advantage,
                    RollType::Disadvantage => D20RollKind::Disadvantage,
                    _ => D20RollKind::ElvenAccuracy,
                };
                ExpressionNode::D20Roll(D20RollNode {
                    roll_type: kind,
                    child: Box::new(ExpressionNode::Die(die)),
                })
            } else {
                let n = if cfg.roll_type == RollType::ElvenAccuracy {
                    3.0
                } else {
                    2.0
                };
                let mode = if cfg.roll_type == RollType::Disadvantage {
                    KeepMode::Lowest
                } else {
                    KeepMode::Highest
                };
                let base = sum_node(n, ExpressionNode::Die(die));
                ExpressionNode::Keep(KeepNode {
                    mode,
                    count: 1.0,
                    child: Box::new(KeepChild::Sum(base)),
                })
            };
            ExpressionNode::Sum(sum_node(count, rolled))
        } else if let Some(keep) = effective_keep.filter(|k| k.total > 0.0) {
            if cfg.explode_pool_budget > 0.0 {
                return Err(DiceError::error(
                    "explodePool() cannot be combined with keep()/bestOf() on the same config — the match/keep pool is ambiguous once dice can be added mid-resolution. Use explodePool() on a plain (non-keep) pool.",
                ));
            }
            let reading = per_die_keep_reading(count, cfg.sides, &keep, is_synthesized_best_of)?;
            let trials = js_max(1.0, keep.total.floor());
            let k = js_max(0.0, keep.count.floor());
            let per_trial = if reading == KeepReading::Dice {
                ExpressionNode::Die(die)
            } else {
                ExpressionNode::Sum(sum_node(count, ExpressionNode::Die(die)))
            };
            if trials == 1.0 && k >= 1.0 {
                per_trial
            } else if k == 1.0 && keep.mode == KeepMode::Highest {
                ExpressionNode::MaxOf(MaxOfNode {
                    count: trials,
                    child: Box::new(per_trial),
                })
            } else {
                let trial_pool = sum_node(trials, per_trial);
                ExpressionNode::Keep(KeepNode {
                    mode: keep.mode,
                    count: k,
                    child: Box::new(KeepChild::Sum(trial_pool)),
                })
            }
        } else {
            ExpressionNode::Sum(SumNode {
                count,
                child: Box::new(ExpressionNode::Die(die)),
                explode_pool_budget: (cfg.explode_pool_budget > 0.0)
                    .then_some(cfg.explode_pool_budget),
            })
        };

        children.push(AddChild { node, sign });
    }

    if children.is_empty() {
        return Ok(Some(ExpressionNode::Constant(ConstantNode {
            value: constant_sum,
        })));
    }

    let mut add = AddNode { children };
    if constant_sum != 0.0 {
        add.children.push(AddChild {
            node: ExpressionNode::Constant(ConstantNode {
                value: constant_sum,
            }),
            sign: Sign::Plus,
        });
    }
    Ok(Some(ExpressionNode::Add(add)))
}

/// `node.child.child` of a keep: the per-trial node under its trial pool.
fn keep_grandchild(node: &KeepNode) -> Cow<'_, ExpressionNode> {
    match &*node.child {
        KeepChild::Sum(s) => Cow::Borrowed(&*s.child),
        KeepChild::Keep(k) => Cow::Owned(keep_child_node(&k.child)),
    }
}

/// A `SumNode | KeepNode` as the `ExpressionNode` it is.
fn keep_child_node(kc: &KeepChild) -> ExpressionNode {
    match kc {
        KeepChild::Sum(s) => ExpressionNode::Sum(s.clone()),
        KeepChild::Keep(k) => ExpressionNode::Keep(k.clone()),
    }
}

/// The name of a node's `type` field.
pub fn node_type_name(node: &ExpressionNode) -> &'static str {
    match node {
        ExpressionNode::Die(_) => "die",
        ExpressionNode::Constant(_) => "constant",
        ExpressionNode::Sum(_) => "sum",
        ExpressionNode::Add(_) => "add",
        ExpressionNode::Keep(_) => "keep",
        ExpressionNode::D20Roll(_) => "d20Roll",
        ExpressionNode::Half(_) => "half",
        ExpressionNode::MaxOf(_) => "maxOf",
        ExpressionNode::Max(_) => "max",
        ExpressionNode::Scale(_) => "scale",
        ExpressionNode::RerollUpTo(_) => "rerollUpTo",
    }
}

fn rounding_str(r: Rounding) -> &'static str {
    match r {
        Rounding::Floor => "floor",
        Rounding::Round => "round",
        Rounding::Ceil => "ceil",
    }
}

fn roll_type_of(kind: D20RollKind) -> RollType {
    match kind {
        D20RollKind::Advantage => RollType::Advantage,
        D20RollKind::Disadvantage => RollType::Disadvantage,
        D20RollKind::ElvenAccuracy => RollType::ElvenAccuracy,
    }
}

/// `resolve`: the node's distribution. `eps` defaults to 0 in TS.
pub fn resolve(node: &ExpressionNode, eps: f64) -> Result<Pmf, DiceError> {
    resolve_shared(node, eps).map(|p| (*p).clone())
}

/// [`resolve`] through `builderPMFCache` (key `{signature}_{eps}`), returning the cached `Arc`.
pub fn resolve_shared(node: &ExpressionNode, eps: f64) -> Result<Arc<Pmf>, DiceError> {
    let key = format!("{}_{}", get_ast_signature(node), num_to_string(eps));
    BUILDER_CACHE.get_or_compute(Some(&key), || resolve_uncached(node, eps))
}

fn resolve_uncached(node: &ExpressionNode, eps: f64) -> Result<Pmf, DiceError> {
    match node {
        ExpressionNode::Constant(c) => Pmf::delta(c.value, eps),
        ExpressionNode::Die(d) => resolve_single_die(d, eps),
        ExpressionNode::Sum(s) => resolve_sum(s, eps),
        ExpressionNode::Add(a) => resolve_add(a, eps),
        ExpressionNode::Keep(k) => resolve_keep(k, eps),
        ExpressionNode::D20Roll(r) => match find_die(&r.child) {
            None => d20_roll_pmf(Some(roll_type_of(r.roll_type)), false),
            Some(die) => resolve_d20_roll(die, Some(roll_type_of(r.roll_type))),
        },
        ExpressionNode::Half(h) => {
            let child = resolve(&h.child, eps)?;
            child.scale_damage(0.5, "floor", 1.0)
        }
        ExpressionNode::MaxOf(m) => {
            let child = resolve(&m.child, eps)?;
            let count = js_max(1.0, m.count.floor());
            if count == 1.0 {
                return Ok(child);
            }
            compute_max_of_pmf(&child, count, eps)
        }
        ExpressionNode::Max(m) => {
            let mut parts = Vec::with_capacity(m.children.len());
            for child in &m.children {
                parts.push(resolve(child, eps)?);
            }
            max_of_independent(&parts, eps)
        }
        ExpressionNode::Scale(s) => {
            let child = resolve(&s.child, eps)?;
            let denom = if s.denominator == 0.0 {
                1.0
            } else {
                s.denominator
            };
            child.scale_damage(s.numerator, rounding_str(s.rounding), denom)
        }
        ExpressionNode::RerollUpTo(r) => resolve_reroll_up_to(r, eps),
    }
}

fn resolve_sum(node: &SumNode, eps: f64) -> Result<Pmf, DiceError> {
    let base = resolve(&node.child, eps)?;
    let n = js_max(0.0, node.count.floor());
    if n == 0.0 {
        return Pmf::delta(0.0, eps);
    }
    if let Some(budget) = node.explode_pool_budget
        && budget.is_finite()
        && budget > 0.0
    {
        let die = find_die(&node.child).ok_or_else(|| {
            DiceError::error("explodePool() requires the pool's child to be a plain die.")
        })?;
        return resolve_exploding_pool(&base, die.sides, n, budget.floor(), eps);
    }
    if n == 1.0 {
        return Ok(base);
    }
    base.power(n, Some(eps))
}

fn resolve_add(node: &AddNode, eps: f64) -> Result<Pmf, DiceError> {
    let mut shift = 0.0;
    let mut terms: Vec<(String, Pmf)> = Vec::new();
    for c in &node.children {
        if let ExpressionNode::Constant(k) = &c.node {
            shift += c.sign.value() * k.value;
        } else {
            let p = resolve(&c.node, eps)?;
            let sig = format!(
                "{}{}",
                if c.sign == Sign::Minus { "-" } else { "+" },
                get_ast_signature(&c.node)
            );
            let pmf = if c.sign == Sign::Plus {
                p
            } else {
                p.map_damage(|v| -v)
            };
            terms.push((sig, pmf));
        }
    }
    // The cache key (`getASTSignature`) sorts an add's terms because addition commutes, but a float
    // convolution does not associate bit for bit: fold in the key's own order, so every node that
    // shares a key computes the same bits.
    stable_sort_by(&mut terms, |a, b| cmp_utf16(&a.0, &b.0));
    let parts: Vec<Pmf> = terms.into_iter().map(|t| t.1).collect();
    if parts.is_empty() {
        return Pmf::delta(shift, eps);
    }
    let mut res = if parts.len() == 1 {
        parts.into_iter().next().unwrap_or_else(|| Pmf::empty(eps))
    } else {
        Pmf::convolve_many(&parts, eps)
    };
    if shift != 0.0 {
        res = res.map_damage(|v| v + shift);
    }
    Ok(res)
}

fn resolve_keep(node: &KeepNode, eps: f64) -> Result<Pmf, DiceError> {
    let total_trials = get_total_count(node);
    let keep_count = js_max(0.0, js_min(node.count, total_trials));
    if keep_count == 0.0 || total_trials == 0.0 {
        return Pmf::delta(0.0, eps);
    }
    // Resolve the per-trial PMF (the child of the Sum inside Keep).
    let per_trial_node = keep_grandchild(node);
    let per_trial = resolve(&per_trial_node, eps)?;
    keep_sum_pmf(
        &per_trial,
        total_trials,
        keep_count,
        node.mode == KeepMode::Highest,
        eps,
    )
}

/// The dice of one `rerollUpTo` side, in the cache key's term order: `rerollUpToPartialPMF` walks
/// them in the order given and its float sums do not associate bit for bit (#54).
fn reroll_kinds_of(pool: &ExpressionNode, eps: f64) -> Result<(Vec<PoolDieKind>, f64), DiceError> {
    let RerollablePool { groups, flat } = rerollable_pool(pool)?;
    let mut keyed: Vec<(String, PoolGroup)> = groups
        .into_iter()
        .map(|group| {
            let term = ExpressionNode::Sum(sum_node(
                group.count,
                ExpressionNode::Die(group.die.clone()),
            ));
            let key = format!(
                "{}{}",
                if group.sign == Sign::Minus { "-" } else { "+" },
                get_ast_signature(&term)
            );
            (key, group)
        })
        .collect();
    stable_sort_by(&mut keyed, |a, b| cmp_utf16(&a.0, &b.0));
    let mut kinds = Vec::with_capacity(keyed.len());
    for (_, group) in keyed {
        let single = resolve_single_die(&group.die, eps)?;
        let faces = single.support();
        kinds.push(PoolDieKind {
            values: faces.iter().map(|f| group.sign.value() * f.0).collect(),
            probs: faces.iter().map(|f| single.p_at(f.0)).collect(),
            count: group.count,
        });
    }
    Ok((kinds, flat))
}

fn resolve_reroll_up_to(node: &super::nodes::RerollUpToNode, eps: f64) -> Result<Pmf, DiceError> {
    let (repeated_kinds, repeated_flat) = reroll_kinds_of(&node.child, eps)?;
    let once = match &node.rolled_once {
        Some(o) => Some(reroll_kinds_of(o, eps)?),
        None => None,
    };
    let rerolled = match &once {
        Some((once_kinds, _)) => {
            reroll_up_to_partial_pmf(&repeated_kinds, once_kinds, node.budget, node.rolls, eps)?
        }
        None => reroll_up_to_pmf(&repeated_kinds, node.budget, node.rolls, eps)?,
    };
    let flat = repeated_flat + once.as_ref().map_or(0.0, |o| o.1);
    Ok(if flat == 0.0 {
        rerolled
    } else {
        rerolled.map_damage(|v| v + flat)
    })
}

/// `pmfFromRollBuilder`.
pub fn pmf_from_roll_builder(rb: &RollBuilder, eps: f64) -> Result<Pmf, DiceError> {
    pmf_from_roll_builder_shared(rb, eps).map(|p| (*p).clone())
}

/// [`pmf_from_roll_builder`], returning the `builderPMFCache` entry itself.
pub fn pmf_from_roll_builder_shared(rb: &RollBuilder, eps: f64) -> Result<Arc<Pmf>, DiceError> {
    let ast = rb.to_ast()?;
    resolve_shared(&ast, eps)
}

/// Resolve a d20-shaped die (honoring reroll/minimum/explode via [`resolve_single_die`]) then
/// lift it into advantage/disadvantage/elven accuracy. Each of the 2 or 3 rolls compared is an
/// independent draw from that same resolved marginal. Always resolves at the library's near-zero
/// default epsilon internally.
pub fn resolve_d20_roll(die: &DieNode, roll_type: Option<RollType>) -> Result<Pmf, DiceError> {
    resolve_d20_roll_shared(die, roll_type).map(|p| (*p).clone())
}

/// [`resolve_d20_roll`]; a lifted roll comes from `d20RollLiftCache` (key `{signature}|{type}`).
pub fn resolve_d20_roll_shared(
    die: &DieNode,
    roll_type: Option<RollType>,
) -> Result<Arc<Pmf>, DiceError> {
    let base = resolve_single_die_shared(die, DEFAULT_EPS)?;
    let ty = roll_type.unwrap_or(RollType::Flat);
    if ty == RollType::Flat {
        return Ok(base);
    }
    let key = format!(
        "{}|{}",
        get_ast_signature(&ExpressionNode::Die(die.clone())),
        ty.as_str()
    );
    D20_LIFT_CACHE.get_or_compute(Some(&key), || lift_d20(&base, ty))
}

fn lift_d20(base: &Pmf, ty: RollType) -> Result<Pmf, DiceError> {
    let mut support: Vec<f64> = base.support().iter().map(|d| d.0).collect();
    support.sort_by(f64::total_cmp);
    let mut out: IndexMap<Damage, f64> = IndexMap::new();
    let mut cum = 0.0;
    let mut prev_lifted = 0.0;
    for k in support {
        cum += base.p_at(k);
        // advantage: best of 2 (F^2); elven accuracy: best of 3 (F^3); disadvantage: worst of 2.
        let cur_lifted = match ty {
            RollType::Advantage => cum * cum,
            RollType::ElvenAccuracy => cum * cum * cum,
            _ => 1.0 - (1.0 - cum) * (1.0 - cum),
        };
        let pk = cur_lifted - prev_lifted;
        if pk > 0.0 {
            out.insert(Damage(k), pk);
        }
        prev_lifted = cur_lifted;
    }
    Pmf::from_map(out, DEFAULT_EPS, true)
}

/// `resolveRootD20`: a check's natural roll, lifted by its roll type. A check with no die has no
/// natural roll: a certain 0.
pub fn resolve_root_d20(check: &RollBuilder) -> Result<Pmf, DiceError> {
    match natural_die_config(check)? {
        None => Pmf::delta(0.0, EPS),
        Some(root) => resolve_d20_roll(&die_node_from_config(&root)?, Some(check.roll_type())),
    }
}

/// `naturalDieConfig`: the config of `check`'s natural die as [`resolve_root_d20`] reads it, or
/// `None` for a check with no die. `Err` when the natural roll is not one die.
pub fn natural_die_config(check: &RollBuilder) -> Result<Option<RollConfig>, DiceError> {
    let configs = check.get_sub_roll_configs();
    let Some(root_idx) = natural_roll_index(&configs) else {
        return Ok(None);
    };
    let root_config = check
        .get_root_die_config()
        .unwrap_or_else(|| configs[root_idx].clone());
    let sides = configs[root_idx].sides;
    let tied = configs.iter().enumerate().any(|(i, c)| {
        i != root_idx && c.sides == sides && c.count > 0.0 && c.is_subtraction != Some(true)
    });
    if root_config.count != 1.0 || tied {
        return Err(DiceError::error(format!(
            "This check's natural roll is not one die: a check needs exactly one d{} for its natural 1 and 20. Roll it once and add any other dice as bonus dice.",
            num_to_string(sides)
        )));
    }
    Ok(Some(root_config))
}

/// `resolveSingleDie`: one die under its reroll, minimum and per-die explode.
pub fn resolve_single_die(die: &DieNode, eps: f64) -> Result<Pmf, DiceError> {
    resolve_single_die_shared(die, eps).map(|p| (*p).clone())
}

/// [`resolve_single_die`] through `singleDiePMFCache` (key `{signature}_{eps}`).
pub fn resolve_single_die_shared(die: &DieNode, eps: f64) -> Result<Arc<Pmf>, DiceError> {
    let key = format!(
        "{}_{}",
        get_ast_signature(&ExpressionNode::Die(die.clone())),
        num_to_string(eps)
    );
    SINGLE_DIE_CACHE.get_or_compute(Some(&key), || resolve_single_die_uncached(die, eps))
}

fn resolve_single_die_uncached(die: &DieNode, eps: f64) -> Result<Pmf, DiceError> {
    let s = js_max(0.0, die.sides.floor());
    if s <= 0.0 {
        return Pmf::delta(0.0, eps);
    }
    if s.is_nan() {
        // TS loops zero times and `fromMap` rejects the empty map.
        return Pmf::from_map(IndexMap::new(), eps, true);
    }
    if s > MAX_ENUMERATED {
        return Err(DiceError::error(format!(
            "A die of {} sides is too large to resolve (at most 1000000).",
            num_to_string(die.sides)
        )));
    }

    let mut probs: IndexMap<Damage, f64> = IndexMap::new();
    for v in 1..=(s as u64) {
        probs.insert(Damage(v as f64), 1.0 / s);
    }

    // One-pass reroll: faces 1..k reroll once, and the reroll is kept (see `RollConfig.reroll`).
    let r = js_max(0.0, or_zero(die.reroll.unwrap_or(0.0)).floor());
    if r > 0.0 {
        let k = js_min(r, s);
        let reroll_mass = k / s; // total probability rerolled once
        let uniform_reroll = reroll_mass / s; // mass added to each face from reroll
        let mut next: IndexMap<Damage, f64> = IndexMap::new();
        for v in 1..=(s as u64) {
            let vf = v as f64;
            let keep = if vf <= k { 0.0 } else { 1.0 / s };
            next.insert(Damage(vf), keep + uniform_reroll);
        }
        probs = next;
    }

    let mut pmf = Pmf::from_map(probs, eps, true)?;

    // Minimum per die
    let min_v = js_max(0.0, or_zero(die.minimum.unwrap_or(0.0)).floor());
    if min_v > 0.0 {
        pmf = pmf.map_damage(|v| js_max(v, min_v));
    }

    // Exploding dice (finite, capped at `times` additional dice) on max face only.
    let times = or_zero(die.explode.unwrap_or(0.0)).floor();
    if times > 0.0 {
        if times > MAX_EXPLODE || times.is_nan() {
            return Err(DiceError::error(format!(
                "explode({}) is too large to resolve (at most {}).",
                num_to_string(times),
                MAX_EXPLODE
            )));
        }
        let max_face = s;

        // Split pmf into a max-face slice and a non-max slice. `Pmf::from_map` normalizes to mass
        // 1, so `non_max_pmf` is already the conditional "given the roll wasn't max" distribution
        // `Pmf::branch` requires for its failure argument; it must not be rescaled again.
        let mut non_max: IndexMap<Damage, f64> = IndexMap::new();
        let p_max = pmf.p_at(max_face);
        for v in pmf.support() {
            if v.0 != max_face {
                non_max.insert(v, pmf.p_at(v.0));
            }
        }

        if non_max.is_empty() {
            // Every face is the max face (a one-sided die, or `minimum` at `sides`): the die and
            // each of its `times` extra dice all show the max face.
            pmf = Pmf::delta((times + 1.0) * max_face, eps)?;
        } else {
            let non_max_pmf = Pmf::from_map(non_max, eps, true)?;
            // Capped geometric chain, built bottom-up (see the TS for the derivation).
            let mut chain = pmf.clone(); // remaining = 0: an unconstrained extra die
            let mut remaining = 1.0;
            while remaining <= times - 1.0 {
                chain = Pmf::branch(&chain.map_damage(|v| v + max_face), &non_max_pmf, p_max);
                remaining += 1.0;
            }
            pmf = Pmf::branch(&chain.map_damage(|v| v + max_face), &non_max_pmf, p_max);
        }
    }

    Ok(pmf)
}

/// `resolveExplodingPool`: a pool of `count` i.i.d. dice sharing ONE pool-wide exploding-dice
/// budget. `die_pmf` is the resolved single-die marginal (post reroll/minimum, no per-die
/// explode).
///
/// DP over `(pending dice, budget remaining)`, resolving one arbitrary pending die per step:
/// `f(p, b) = nonMax ⊗ f(p-1, b)` (this die didn't explode) `+ max ⊗ (b > 0 ? f(p, b-1) : f(p-1, b))`
/// (it did: spends 1 budget, the extra die takes its place), `f(0, b) = δ₀`, `f(p, 0) = die^p`.
fn resolve_exploding_pool(
    die_pmf: &Pmf,
    max_face: f64,
    count: f64,
    budget: f64,
    eps: f64,
) -> Result<Pmf, DiceError> {
    let p_max = die_pmf.p_at(max_face);
    let mut non_max: IndexMap<Damage, f64> = IndexMap::new();
    for v in die_pmf.support() {
        if v.0 != max_face {
            non_max.insert(v, die_pmf.p_at(v.0));
        }
    }
    // Every face is the max face: the pool is deterministically `count + budget` max faces. Must
    // be checked before `from_map`, which throws on an empty map.
    if non_max.is_empty() {
        return Pmf::delta((count + budget) * max_face, eps);
    }
    let non_max_pmf = Pmf::from_map(non_max, eps, true)?;

    if count * budget > MAX_POOL_STATES || count.is_nan() || budget.is_nan() {
        return Err(DiceError::error(format!(
            "explodePool({}) on a pool of {} dice is too large to resolve.",
            num_to_string(budget),
            num_to_string(count)
        )));
    }
    let (count, budget) = (count as usize, budget as usize);

    // `row[p]` holds f(p, b) for the current b; f(p, 0) = die^p, f(0, b) = δ₀.
    let mut row: Vec<Pmf> = Vec::with_capacity(count + 1);
    for p in 0..=count {
        row.push(if p == 0 {
            Pmf::delta(0.0, eps)?
        } else {
            die_pmf.power(p as f64, Some(eps))?
        });
    }
    for _ in 1..=budget {
        let mut next: Vec<Pmf> = Vec::with_capacity(count + 1);
        next.push(Pmf::delta(0.0, eps)?);
        for p in 1..=count {
            let max_branch = row[p].map_damage(|v| v + max_face);
            let non_max_branch = non_max_pmf.convolve(&next[p - 1], Some(eps), false);
            next.push(Pmf::branch(&max_branch, &non_max_branch, p_max));
        }
        row = next;
    }
    row.pop()
        .ok_or_else(|| DiceError::error("explodePool(): empty pool"))
}

/// One die group of a `rerollUpTo` pool.
#[derive(Clone, Debug, PartialEq)]
pub struct PoolGroup {
    pub die: DieNode,
    pub count: f64,
    pub sign: Sign,
}

/// What [`rerollable_pool`] reads off a pool.
#[derive(Clone, Debug, PartialEq)]
pub struct RerollablePool {
    pub groups: Vec<PoolGroup>,
    pub flat: f64,
}

fn refuse<T>(what: &str) -> Result<T, DiceError> {
    Err(DiceError::error(format!(
        "rerollUpTo() rerolls plain dice, and this roll has {what}. Set reroll and minimum on the dice, and pool them last."
    )))
}

fn pool_walk(
    part: &ExpressionNode,
    sign: Sign,
    pool: &mut RerollablePool,
) -> Result<(), DiceError> {
    match part {
        ExpressionNode::Constant(c) => {
            pool.flat += sign.value() * c.value;
            Ok(())
        }
        ExpressionNode::Die(d) => {
            if opt_pos(d.explode) {
                return refuse(&format!(
                    "an exploding d{} (explode({}))",
                    num_to_string(d.sides),
                    num_to_string(d.explode.unwrap_or(0.0))
                ));
            }
            pool.groups.push(PoolGroup {
                die: d.clone(),
                count: 1.0,
                sign,
            });
            Ok(())
        }
        ExpressionNode::Sum(s) => {
            if opt_pos(s.explode_pool_budget) {
                return refuse(&format!(
                    "a pool-wide exploding-dice budget (explodePool({}))",
                    num_to_string(s.explode_pool_budget.unwrap_or(0.0))
                ));
            }
            if let ExpressionNode::Keep(_) = &*s.child {
                return refuse("a keep, or a die rolled with advantage or disadvantage");
            }
            let ExpressionNode::Die(die) = &*s.child else {
                return refuse(&format!(
                    "a {} inside a pool of dice",
                    node_type_name(&s.child)
                ));
            };
            let count = js_max(0.0, s.count.floor());
            if opt_pos(die.explode) {
                return refuse(&format!(
                    "an exploding d{} (explode({}))",
                    num_to_string(die.sides),
                    num_to_string(die.explode.unwrap_or(0.0))
                ));
            }
            if count > 0.0 {
                pool.groups.push(PoolGroup {
                    die: die.clone(),
                    count,
                    sign,
                });
            }
            Ok(())
        }
        ExpressionNode::Add(a) => {
            for child in &a.children {
                let combined = if sign == child.sign {
                    Sign::Plus
                } else {
                    Sign::Minus
                };
                pool_walk(&child.node, combined, pool)?;
            }
            Ok(())
        }
        ExpressionNode::Keep(_) => refuse("a keep (keepHighest, keepLowest or bestOf)"),
        ExpressionNode::MaxOf(_) => {
            refuse("a best of several rolls of a group (keepHighest(N, 1) or maxOf)")
        }
        ExpressionNode::D20Roll(_) => {
            refuse("a d20 rolled with advantage, disadvantage or elven accuracy")
        }
        ExpressionNode::RerollUpTo(_) => refuse("a rerollUpTo() pool already"),
        other => refuse(&format!("a {} transform", node_type_name(other))),
    }
}

/// `rerollablePool`: the dice a `rerollUpTo` pool rerolls, read off its child: every die group
/// with its die, count and sign, and the flat total, which rerolls never touch. A child holding
/// anything but plain dice and flats throws.
pub fn rerollable_pool(node: &ExpressionNode) -> Result<RerollablePool, DiceError> {
    let mut pool = RerollablePool {
        groups: Vec::new(),
        flat: 0.0,
    };
    pool_walk(node, Sign::Plus, &mut pool)?;
    Ok(pool)
}

/// `findDie`: the first die under `node`.
pub fn find_die(node: &ExpressionNode) -> Option<&DieNode> {
    match node {
        ExpressionNode::Die(d) => Some(d),
        ExpressionNode::Constant(_) => None,
        ExpressionNode::Sum(s) => find_die(&s.child),
        ExpressionNode::D20Roll(r) => find_die(&r.child),
        ExpressionNode::Half(h) => find_die(&h.child),
        ExpressionNode::MaxOf(m) => find_die(&m.child),
        ExpressionNode::Scale(s) => find_die(&s.child),
        ExpressionNode::RerollUpTo(r) => find_die(&r.child),
        ExpressionNode::Keep(k) => find_die_of_keep(k),
        ExpressionNode::Add(a) => a.children.iter().find_map(|c| find_die(&c.node)),
        ExpressionNode::Max(m) => m.children.iter().find_map(find_die),
    }
}

/// `findDie(node.child.child)` of a keep.
fn find_die_of_keep(k: &KeepNode) -> Option<&DieNode> {
    match &*k.child {
        KeepChild::Sum(s) => find_die(&s.child),
        KeepChild::Keep(inner) => match &*inner.child {
            KeepChild::Sum(s) => find_die(&s.child),
            KeepChild::Keep(k2) => find_die_of_keep(k2),
        },
    }
}

/// `maxOfIndependent`: the highest of independent rolls: P(max <= v) is the product of each
/// part's P(<= v).
fn max_of_independent(parts: &[Pmf], eps: f64) -> Result<Pmf, DiceError> {
    let mut support: Vec<Damage> = Vec::new();
    for part in parts {
        for v in part.support() {
            if !support.contains(&v) {
                support.push(v);
            }
        }
    }
    support.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut cumulative = vec![0.0; parts.len()];
    let mut out: IndexMap<Damage, f64> = IndexMap::new();
    let mut previous = 0.0;
    for value in support {
        let mut all = 1.0;
        for (i, part) in parts.iter().enumerate() {
            cumulative[i] += part.p_at(value.0);
            all *= cumulative[i];
        }
        if all > previous {
            out.insert(value, all - previous);
        }
        previous = all;
    }
    Pmf::from_map(out, eps, true)
}

/// `getTotalCount`: the dice count of the nearest `SumNode` under a keep.
pub fn get_total_count(node: &KeepNode) -> f64 {
    let mut cur = &*node.child;
    loop {
        match cur {
            KeepChild::Keep(k) => cur = &k.child,
            KeepChild::Sum(s) => return js_max(0.0, s.count.floor()),
        }
    }
}

/// `computeMaxOfPMF`: the maximum of `count` independent rolls of `pmf`.
fn compute_max_of_pmf(pmf: &Pmf, count: f64, eps: f64) -> Result<Pmf, DiceError> {
    if count <= 1.0 {
        return Ok(pmf.clone());
    }

    let support: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    let mut out: IndexMap<Damage, f64> = IndexMap::new();

    // For small counts, enumerate all outcomes exactly.
    if count <= 6.0 && support.len() <= 20 {
        fn dfs(
            rolls_left: u32,
            current_max: f64,
            probability: f64,
            support: &[f64],
            probs: &[f64],
            out: &mut IndexMap<Damage, f64>,
        ) {
            if rolls_left == 0 {
                let slot = out.entry(Damage(current_max)).or_insert(0.0);
                *slot += probability;
                return;
            }
            for (value, p) in support.iter().zip(probs) {
                if *p > 0.0 {
                    let new_max = js_max(current_max, *value);
                    dfs(
                        rolls_left - 1,
                        new_max,
                        probability * p,
                        support,
                        probs,
                        out,
                    );
                }
            }
        }

        let probs: Vec<f64> = support.iter().map(|v| pmf.p_at(*v)).collect();
        dfs(
            count as u32,
            f64::NEG_INFINITY,
            1.0,
            &support,
            &probs,
            &mut out,
        );
    } else {
        // For larger cases, use the CDF method: walk the sorted support once while accumulating a
        // running CDF, so each P(max = v) costs O(1).
        let mut sorted = support;
        sorted.sort_by(f64::total_cmp);
        let mut running_cdf = 0.0;
        for value in sorted {
            let prev_cdf = running_cdf;
            running_cdf += pmf.p_at(value);

            // P(max = value) = P(all rolls <= value) - P(all rolls <= value-1)
            let prob_max = running_cdf.powf(count) - prev_cdf.powf(count);
            if prob_max > eps {
                out.insert(Damage(value), prob_max);
            }
        }
    }

    Pmf::from_map(out, eps, true)
}

type SumMap = IndexMap<Damage, f64>;

/// `binomPMF`: P(X = x) for x in 0..=r, X ~ Binomial(r, p).
fn binom_pmf(r: usize, p: f64, eps: f64) -> Vec<f64> {
    if r == 0 {
        return vec![1.0];
    }
    let mut arr = vec![0.0; r + 1];
    if p <= eps {
        arr[0] = 1.0;
        return arr;
    }
    if 1.0 - p <= eps {
        arr[r] = 1.0;
        return arr;
    }
    let q = 1.0 - p;
    let rf = r as f64;

    // stable recurrence from k=0
    arr[0] = q.powf(rf);
    let ratio = p / q;
    for x in 1..=r {
        let xf = x as f64;
        arr[x] = ((arr[x - 1] * (rf - xf + 1.0)) / xf) * ratio;
    }

    // Normalize minor drift
    let mut s = 0.0;
    for v in &arr {
        s += v;
    }
    if (1.0 - s).abs() > 1e-12 {
        for v in &mut arr {
            *v /= s;
        }
    }
    arr
}

/// Adds `m` shifted by `add` and weighted by `px` into `dest`, dropping sums below `eps`.
fn accumulate(dest: &mut SumMap, m: &SumMap, add: f64, px: f64, eps: f64) {
    for (sum, pr) in m {
        let s2 = Damage(sum.0 + add);
        let prob = pr * px;
        let cur = dest.get(&s2).copied().unwrap_or(0.0);
        let nv = cur + prob;
        if nv >= eps {
            dest.insert(s2, nv);
        }
    }
}

/// `pruneState`.
fn prune_state(st: IndexMap<u64, SumMap>, threshold: f64) -> IndexMap<u64, SumMap> {
    if threshold <= 0.0 {
        return st;
    }
    let mut out: IndexMap<u64, SumMap> = IndexMap::new();
    for (k, m) in st {
        let kept: SumMap = m.into_iter().filter(|(_, pr)| *pr >= threshold).collect();
        if !kept.is_empty() {
            out.insert(k, kept);
        }
    }
    out
}

/// `keepSumPMF`: the sum of the best `keep` of `total` i.i.d. draws of `single`.
fn keep_sum_pmf(
    single: &Pmf,
    total: f64,
    keep: f64,
    highest: bool,
    eps: f64,
) -> Result<Pmf, DiceError> {
    // Trivial/fast paths
    if keep >= total {
        return single.power(total, Some(eps));
    }
    if keep <= 0.0 {
        return Pmf::delta(0.0, eps);
    }
    if !is_integer(keep) || total > MAX_ENUMERATED {
        return Err(DiceError::error(format!(
            "keep: cannot keep {} of {} rolls (the count must be an integer, and at most 1000000 rolls)",
            num_to_string(keep),
            num_to_string(total)
        )));
    }

    // kh1/kl1 fast paths using max-of machinery
    if keep == 1.0 {
        return if highest {
            compute_max_of_pmf(single, total, eps)
        } else {
            // min of n i.i.d. == -max of n of negated variable
            let neg = single.map_damage(|v| -v);
            Ok(compute_max_of_pmf(&neg, total, eps)?.map_damage(|v| -v))
        };
    }

    // DP over descending values; state = (used, remainingTrials) -> map(sum -> prob).
    // Transition by drawing X occurrences at current value v from remainingTrials r:
    // X ~ Binom(r, p); select t = min(X, keep - used) into the sum (highest picks first), then
    // continue with r - X. The `(used, r)` pair is packed as `used * stride + r`.
    let total_n = total as u64;
    let keep_n = keep as u64;
    let stride = total_n + 1;
    let key_of = |used: u64, r: u64| used * stride + r;

    let mut state: IndexMap<u64, SumMap> = IndexMap::new();
    let mut start: SumMap = IndexMap::new();
    start.insert(Damage(0.0), 1.0);
    state.insert(key_of(0, total_n), start);

    let mut sorted_support: Vec<f64> = single.support().iter().map(|d| d.0).collect();
    sorted_support.sort_by(f64::total_cmp);
    let mut values_desc = sorted_support.clone();
    if highest {
        values_desc.sort_by(|a, b| b.total_cmp(a));
    }

    let mut processed_mass = 0.0;
    for v in values_desc {
        let p = single.p_at(v);
        if p <= 0.0 {
            continue;
        }
        let q = js_max(eps, 1.0 - processed_mass);
        let p_cond = js_min(1.0, p / q);
        let mut next: IndexMap<u64, SumMap> = IndexMap::new();

        for (k, m) in &state {
            let used = k / stride;
            let r = k - used * stride;
            if r == 0 {
                // No trials left; carry state forward unchanged
                let dest = next.entry(key_of(used, 0)).or_default();
                for (sum, pr) in m {
                    let slot = dest.entry(*sum).or_insert(0.0);
                    *slot += pr;
                }
                continue;
            }

            let bin = binom_pmf(r as usize, p_cond, eps);
            let remaining_capacity = keep_n - used;

            for x in 0..=r {
                let px = bin[x as usize];
                if px <= eps {
                    continue;
                }
                let t = x.min(remaining_capacity);
                let used2 = used + t;
                let r2 = r - x;
                let add = t as f64 * v;

                let dest_key = key_of(used2, r2);
                // `next.get(destKey) ?? new Map()`, stored only when it ends non-empty.
                if let Some(dest) = next.get_mut(&dest_key) {
                    accumulate(dest, m, add, px, eps);
                } else {
                    let mut dest = SumMap::new();
                    accumulate(&mut dest, m, add, px, eps);
                    if !dest.is_empty() {
                        next.insert(dest_key, dest);
                    }
                }
            }
        }

        // Light pruning proportional to eps
        state = prune_state(next, eps * 1e-6);
        processed_mass += p;
    }

    // Collect results where all trials assigned and exactly keep were used
    let dist = state.get(&key_of(keep_n, 0)).cloned().unwrap_or_default();
    if dist.is_empty() {
        // Fallback safety: return empty mass (should not happen)
        return Ok(Pmf::empty_mass());
    }
    Pmf::from_map(dist, eps, true)
}

/// `getASTSignature`: a stable string identifying a node (also the sort key of an add's terms).
pub fn get_ast_signature(node: &ExpressionNode) -> String {
    match node {
        ExpressionNode::Constant(c) => format!("c:{}", num_to_string(c.value)),
        ExpressionNode::Die(d) => {
            // Use a fixed order for properties to ensure a stable signature.
            let mut parts: Vec<String> = vec![format!("s:{}", num_to_string(d.sides))];
            if opt_truthy(d.reroll) {
                parts.push(format!("r:{}", num_to_string(d.reroll.unwrap_or(0.0))));
            }
            if opt_truthy(d.minimum) {
                parts.push(format!("m:{}", num_to_string(d.minimum.unwrap_or(0.0))));
            }
            if opt_truthy(d.explode) {
                parts.push(format!("e:{}", num_to_string(d.explode.unwrap_or(0.0))));
            }
            format!("d{{{}}}", parts.join(","))
        }
        ExpressionNode::Sum(s) => sum_signature(s),
        ExpressionNode::D20Roll(r) => format!(
            "d20{{t:{},ch:{}}}",
            roll_type_of(r.roll_type).as_str(),
            get_ast_signature(&r.child)
        ),
        ExpressionNode::Keep(k) => keep_signature(k),
        ExpressionNode::Half(h) => format!("half{{ch:{}}}", get_ast_signature(&h.child)),
        ExpressionNode::MaxOf(m) => format!(
            "maxOf{{c:{},ch:{}}}",
            num_to_string(m.count),
            get_ast_signature(&m.child)
        ),
        ExpressionNode::Scale(s) => format!(
            "scale{{n:{},d:{},r:{},ch:{}}}",
            num_to_string(s.numerator),
            num_to_string(s.denominator),
            rounding_str(s.rounding),
            get_ast_signature(&s.child)
        ),
        ExpressionNode::RerollUpTo(r) => format!(
            "rerollUpTo{{b:{},r:{},ch:{}{}}}",
            num_to_string(r.budget),
            num_to_string(r.rolls),
            get_ast_signature(&r.child),
            match &r.rolled_once {
                Some(o) => format!(",once:{}", get_ast_signature(o)),
                None => String::new(),
            }
        ),
        ExpressionNode::Max(m) => format!(
            "max[{}]",
            m.children
                .iter()
                .map(get_ast_signature)
                .collect::<Vec<_>>()
                .join(",")
        ),
        ExpressionNode::Add(a) => {
            let mut constant_value = 0.0;
            let mut sigs: Vec<String> = Vec::new();
            for c in &a.children {
                if let ExpressionNode::Constant(k) = &c.node {
                    constant_value += c.sign.value() * k.value;
                } else {
                    sigs.push(format!(
                        "{}{}",
                        if c.sign == Sign::Minus { "-" } else { "+" },
                        get_ast_signature(&c.node)
                    ));
                }
            }
            if constant_value != 0.0 {
                sigs.push(if constant_value > 0.0 {
                    format!("+c:{}", num_to_string(constant_value))
                } else {
                    format!("-c:{}", num_to_string(-constant_value))
                });
            }
            // Sort to handle commutative nature of addition.
            stable_sort_by(&mut sigs, |a, b| cmp_utf16(a, b));
            format!("add[{}]", sigs.concat())
        }
    }
}

fn sum_signature(s: &SumNode) -> String {
    let budget = if opt_truthy(s.explode_pool_budget) {
        s.explode_pool_budget.unwrap_or(0.0)
    } else {
        0.0
    };
    format!(
        "sum{{c:{},b:{},ch:{}}}",
        num_to_string(s.count),
        num_to_string(budget),
        get_ast_signature(&s.child)
    )
}

fn keep_signature(k: &KeepNode) -> String {
    let child = match &*k.child {
        KeepChild::Sum(s) => sum_signature(s),
        KeepChild::Keep(inner) => keep_signature(inner),
    };
    format!(
        "keep{{c:{},m:{},ch:{}}}",
        num_to_string(k.count),
        k.mode.as_str(),
        child
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn die(sides: f64) -> DieNode {
        DieNode {
            sides,
            reroll: None,
            minimum: None,
            explode: None,
        }
    }

    #[test]
    fn two_d6_mean() -> Result<(), DiceError> {
        let node = ExpressionNode::Sum(sum_node(2.0, ExpressionNode::Die(die(6.0))));
        assert!((resolve(&node, 0.0)?.mean() - 7.0).abs() < 1e-12);
        Ok(())
    }
}
