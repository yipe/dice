//! Port of `src/builder/miss-reroll.ts`: `rerollMisses`, a missed attack roll rolled again. The odds
//! are exact: every bonus total `b` is paired with the faces of the natural d20 it turns into a
//! miss, a hit or a crit, and the new d20 is weighed against those faces (see
//! [`miss_reroll_odds`]).
//!
//! TS takes `ACBuilder | AlwaysCritBuilder`; here a check is a [`RollBuilder`] and its AC, crit
//! threshold and `"fromAlwaysHit" in check` come from [`RollBuilder::crit_check_parts`] (an
//! always-crit check today; `ac.rs` adds the AC check there). A roll with no such parts returns
//! `Err`.

use super::ast::{die_node_from_config, natural_die_config, resolve_d20_roll};
use super::num::not_positive;
use super::roll::{CritCheckParts, RollBuilder};
use super::types::{MissRerollMode, RollConfig, RollType};
use crate::Pmf;
use crate::error::DiceError;
use crate::js::num_to_string;

/// `MissRerollOdds`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MissRerollOdds {
    /// P(the attack misses as rolled AND misses after the reroll).
    pub miss: f64,
    /// P(misses as rolled AND the reroll lands as a plain hit).
    pub hit: f64,
    /// P(misses as rolled AND the reroll crits).
    pub crit: f64,
    /// P(misses as rolled AND the reroll's kept natural roll is a 20): part of `crit`.
    pub natural20: f64,
}

/// `missRerollOf`: the check's `rerollMisses` mode, if it has one (an always-hit check never has).
pub fn miss_reroll_of(check: &RollBuilder) -> Option<MissRerollMode> {
    check.attack_config().and_then(|a| a.miss_reroll)
}

/// The most bonus outcomes [`miss_reroll_check_expression`] will spell out.
const MAX_EXPRESSION_OUTCOMES: f64 = 400.0;

fn parts_of(check: &RollBuilder) -> Result<CritCheckParts, DiceError> {
    check
        .crit_check_parts()
        .ok_or_else(|| DiceError::error("rerollMisses needs an AC check or an alwaysCrits() check"))
}

/// The outcome of natural `face`, as `AttackBuilder.resolveProbabilities` reads it: 0 miss, 1 hit,
/// 2 crit.
fn rank_of(face: f64, total: f64, ac: f64, crit_threshold: f64, crit_on_hit: bool) -> u8 {
    if face == 1.0 {
        return 0;
    }
    if face == 20.0 {
        return 2;
    }
    if total < ac {
        return 0;
    }
    if crit_on_hit || face >= crit_threshold {
        2
    } else {
        1
    }
}

/// `h`, the first natural face that is not a miss, and `c`, the first that crits (21: none), for a
/// total bonus `bonus` (flat plus bonus dice). Misses are a prefix of the faces and crits a suffix.
fn face_bounds(parts: &CritCheckParts, bonus: f64) -> Result<(f64, f64), DiceError> {
    let ac = parts.ac.unwrap_or(0.0);
    let ranks: Vec<u8> = (0..20)
        .map(|i| {
            let face = f64::from(i + 1);
            rank_of(
                face,
                face + bonus,
                ac,
                parts.crit_threshold,
                parts.crit_on_hit,
            )
        })
        .collect();
    if ranks.windows(2).any(|w| w[1] < w[0]) {
        return Err(DiceError::error(format!(
            "rerollMisses: the miss faces are not a prefix and the crit faces a suffix (bonus {}).",
            num_to_string(bonus)
        )));
    }
    let first = |rank: u8| -> f64 {
        match ranks.iter().position(|r| *r >= rank) {
            Some(i) => (i + 1) as f64,
            None => 21.0,
        }
    };
    Ok((first(1), first(2)))
}

fn reroll_die(check: &RollBuilder) -> Result<RollConfig, DiceError> {
    let root = natural_die_config(check)?;
    let root = match root {
        Some(r) if r.sides == 20.0 => r,
        _ => {
            return Err(DiceError::error(
                "rerollMisses() needs a check with a d20 natural roll: only a d20 is rolled again.",
            ));
        }
    };
    if root.explode > 0.0 || root.explode_pool_budget > 0.0 {
        return Err(DiceError::error(
            "rerollMisses(): the d20 explodes, so its natural roll can exceed 20.",
        ));
    }
    if root.minimum > 20.0 || root.minimum < 0.0 {
        return Err(DiceError::error(format!(
            "rerollMisses(): the d20 minimum {} is outside the faces 1..20.",
            num_to_string(root.minimum)
        )));
    }
    let mass = die_cdf(&root)?[20];
    if (mass - 1.0).abs() > 1e-9 {
        return Err(DiceError::error(format!(
            "rerollMisses(): the d20 puts {} of its probability outside the faces 1..20.",
            num_to_string(1.0 - mass)
        )));
    }
    Ok(root)
}

/// The check's single d20 rolled flat, as the reroll rolls it: P(die <= x) for x in 0..=20.
fn die_cdf(root: &RollConfig) -> Result<Vec<f64>, DiceError> {
    let die = resolve_d20_roll(&die_node_from_config(root)?, Some(RollType::Flat))?;
    let mut cdf = vec![0.0];
    for x in 1..=20usize {
        let prev = cdf[x - 1];
        cdf.push(prev + die.p_at(x as f64));
    }
    Ok(cdf)
}

/// `missRerollOdds`: the odds of a miss, and of what its reroll lands as. `check` is the check as
/// rolled (its roll type decides how many d20s it rolled); `mode` is how the miss is rolled again.
///
/// With `F(x)` = P(the row's single d20 <= x), `S(x) = 1 - F(x-1)`, `h` the first non-miss face and
/// `c` the first crit face for the bonus `b`, and `n` the d20s rolled, `g(x)` = P(miss as rolled AND
/// the new kept roll >= x) is `F(h-1)^n S(x)` (flat, advantage, elven accuracy; either mode),
/// `2 F(h-1) S(x)^2` (disadvantage, `reroll`) or
/// `1 - F(x-1)^3 - S(h)^2 + (F(x-1) - F(h-1))^2 F(x-1)` (disadvantage, `add-d20`). Then
/// `hit = g(h) - g(c)`, `crit = g(c)`, `natural20 = g(20)` and `miss = P(miss) - g(h)`, each
/// summed over `b`.
pub fn miss_reroll_odds(
    check: &RollBuilder,
    mode: MissRerollMode,
    eps: f64,
) -> Result<MissRerollOdds, DiceError> {
    miss_reroll_odds_with(check, &parts_of(check)?, mode, eps)
}

/// [`miss_reroll_odds`] for a check whose AC, crit threshold and crit-on-hit rule are given
/// explicitly (`check` supplies the dice): the form an AC check calls until `ac.rs` makes it a
/// [`RollBuilder`] kind.
pub fn miss_reroll_odds_with(
    check: &RollBuilder,
    parts: &CritCheckParts,
    mode: MissRerollMode,
    eps: f64,
) -> Result<MissRerollOdds, DiceError> {
    let cdf = die_cdf(&reroll_die(check)?)?;
    let f = |x: f64| -> f64 { cdf[x.clamp(0.0, 20.0) as usize] };
    let s = |x: f64| -> f64 { 1.0 - f(x - 1.0) };
    let roll_type = check.roll_type();
    let disadvantage = roll_type == RollType::Disadvantage;
    let n = match roll_type {
        RollType::ElvenAccuracy => 3.0,
        RollType::Advantage => 2.0,
        _ => 1.0,
    };

    let bonus_pmfs = check.get_bonus_dice_pmfs(check, eps)?;
    let bonus: Pmf = if bonus_pmfs.is_empty() {
        Pmf::delta(0.0, eps)?
    } else {
        Pmf::convolve_many(&bonus_pmfs, eps)
    };
    let modifier = check.modifier();

    let mut out = MissRerollOdds {
        miss: 0.0,
        hit: 0.0,
        crit: 0.0,
        natural20: 0.0,
    };
    for (dice, bin) in &bonus.map {
        let weight = bin.p;
        if not_positive(weight) {
            continue;
        }
        let (h, c) = face_bounds(parts, dice.0 + modifier)?;
        let g = |x: f64| -> f64 {
            if x > 20.0 {
                return 0.0;
            }
            if !disadvantage {
                return f(h - 1.0).powf(n) * s(x);
            }
            if mode == MissRerollMode::Reroll {
                return 2.0 * f(h - 1.0) * s(x).powf(2.0);
            }
            1.0 - f(x - 1.0).powf(3.0) - s(h).powf(2.0)
                + (f(x - 1.0) - f(h - 1.0)).powf(2.0) * f(x - 1.0)
        };
        let as_rolled = if disadvantage {
            1.0 - s(h).powf(2.0)
        } else {
            f(h - 1.0).powf(n)
        };
        out.hit += weight * (g(h) - g(c));
        out.crit += weight * g(c);
        out.natural20 += weight * if c <= 20.0 { g(20.0) } else { 0.0 };
        out.miss += weight * (as_rolled - g(h));
    }
    // A miss that cannot be rerolled into a landing leaves float dust below zero.
    Ok(MissRerollOdds {
        miss: if out.miss.is_nan() {
            f64::NAN
        } else {
            out.miss.max(0.0)
        },
        hit: out.hit,
        crit: out.crit,
        natural20: out.natural20,
    })
}

/// A bonus die the expression grammar spells as the plain faces `1..sides`, one signed die per
/// count.
struct PlainBonus {
    sides: f64,
    dice: f64,
    sign: f64,
}

fn plain_bonus_faces(config: &RollConfig) -> Result<PlainBonus, DiceError> {
    let plain = config.roll_type == RollType::Flat
        && config.reroll == 0.0
        && not_positive(config.explode)
        && not_positive(config.explode_pool_budget)
        && config.minimum <= 1.0
        && !(config.best_of > 0.0 && config.best_of < config.count)
        && config.keep.is_none();
    if !plain {
        return Err(DiceError::error(
            "toExpression: rerollMisses has no expression spelling: a bonus die rerolls, explodes, keeps or has a minimum.",
        ));
    }
    let negative = config.is_subtraction == Some(true) || config.count < 0.0;
    Ok(PlainBonus {
        sides: config.sides,
        dice: config.count.abs().floor(),
        sign: if negative { -1.0 } else { 1.0 },
    })
}

fn no_spelling<T>(why: &str) -> Result<T, DiceError> {
    Err(DiceError::error(format!(
        "rerollMisses has no expression spelling: {why}."
    )))
}

/// `missRerollCheckExpression`: the check inside `( … AC n)` for a check with `missReroll` set:
/// one `(d20 reroll dK) + b` term per bonus outcome, `K` the last miss face for that bonus, joined
/// with `&` (each outcome equally likely). `Err` where the grammar has no exact spelling: an
/// advantage or disadvantage roll, a d20 `minimum`, a bonus die that is not plain, or more than 400
/// bonus outcomes.
pub fn miss_reroll_check_expression(check: &RollBuilder) -> Result<String, DiceError> {
    miss_reroll_check_expression_with(check, &parts_of(check)?)
}

/// [`miss_reroll_check_expression`] with the check's parts given explicitly (see
/// [`miss_reroll_odds_with`]).
pub fn miss_reroll_check_expression_with(
    check: &RollBuilder,
    parts: &CritCheckParts,
) -> Result<String, DiceError> {
    let root = reroll_die(check)?;
    if check.roll_type() != RollType::Flat {
        return no_spelling(&format!(
            "the check rolls with {}",
            check.roll_type().as_str()
        ));
    }
    if root.minimum > 1.0 {
        return no_spelling("the d20 has a minimum");
    }
    if root.reroll > 1.0 {
        return no_spelling("the d20 rerolls more than 1s");
    }
    if root.explode > 0.0 || root.explode_pool_budget > 0.0 {
        return no_spelling("the d20 explodes");
    }
    let die = if root.reroll == 1.0 { "hd20" } else { "d20" };

    let mut groups: Vec<PlainBonus> = Vec::new();
    for config in check.get_bonus_dice_configs() {
        groups.push(plain_bonus_faces(&config)?);
    }
    let outcomes = groups
        .iter()
        .fold(1.0, |total, g| total * g.sides.powf(g.dice));
    if outcomes > MAX_EXPRESSION_OUTCOMES {
        return no_spelling(&format!(
            "{} bonus outcomes is over {}",
            num_to_string(outcomes),
            num_to_string(MAX_EXPRESSION_OUTCOMES)
        ));
    }

    let modifier = check.modifier();
    let mut totals: Vec<f64> = vec![modifier];
    for g in &groups {
        let faces = if g.sides.is_nan() {
            0
        } else {
            g.sides.max(0.0).floor() as usize
        };
        let mut i = 0.0;
        while i < g.dice {
            totals = totals
                .iter()
                .flat_map(|total| (0..faces).map(move |face| total + g.sign * (face as f64 + 1.0)))
                .collect();
            i += 1.0;
        }
    }
    totals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let signed = |total: f64| -> String {
        if total == 0.0 {
            String::new()
        } else if total < 0.0 {
            format!(" - {}", num_to_string(-total))
        } else {
            format!(" + {}", num_to_string(total))
        }
    };
    let reroll = |total: f64| -> Result<String, DiceError> {
        Ok(format!(
            "{die} reroll d{}",
            num_to_string(face_bounds(parts, total)?.0 - 1.0)
        ))
    };
    if groups.iter().all(|g| g.dice == 0.0) {
        return Ok(format!("{}{}", reroll(modifier)?, signed(modifier)));
    }
    let mut terms: Vec<String> = Vec::with_capacity(totals.len());
    for total in totals {
        terms.push(if total == 0.0 {
            format!("({})", reroll(total)?)
        } else {
            format!("(({}){})", reroll(total)?, signed(total))
        });
    }
    Ok(terms.join(" & "))
}
