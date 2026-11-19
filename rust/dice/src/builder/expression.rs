//! Port of `src/builder/expression.ts`: printing builders as strings the parser reads back to the
//! same distribution.
//!
//! The grammar reads every binary operator left to right at one precedence, so a term that is
//! itself an expression is parenthesised whenever something precedes it. `+` adds only to a
//! non-zero running total, so a term joins with ` + ` only when everything before it can never
//! total 0, and with ` ~+ ` (always add) otherwise.
//!
//! Differences: TS `config === root` (object identity) is an index into the configs here; the
//! merge key of `diceGroups` (`JSON.stringify` of the config) is written in the canonical field
//! order, which differs from TS only for a config whose `isSubtraction` key sits after `pinned`.

use super::ast::{ast_from_roll_configs, die_node_from_config};
use super::nodes::{
    D20RollKind, D20RollNode, DieNode, ExpressionNode, KeepChild, KeepNode, Sign, SumNode,
};
use super::num::{is_integer, js_max, js_min, not_positive, ordering_of, stable_sort_by};
use super::types::{RollConfig, RollType};
use crate::error::DiceError;
use crate::js::num_to_string;
use std::collections::HashMap;
// Writes to a `String` via `fmt::Write` are infallible, so `let _ =` discards no error.
use std::fmt::Write;

/// One additive term of a printed sum: the text of its magnitude, its sign, and the range of that
/// magnitude when it is known.
#[derive(Clone, Debug, PartialEq)]
pub struct ExpressionTerm {
    pub text: String,
    pub sign: Sign,
    pub range: Option<(f64, f64)>,
}

/// `PrintOptions`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PrintOptions {
    /// A lone plain d20 prints as `d20` rather than `1d20` (the check's natural roll).
    pub d20_shorthand: bool,
    /// A keep-1-of-2 or keep-1-of-3 prints as a `>` / `<` chain (a roll type on a non-d20 die).
    pub roll_type_chain: bool,
}

fn opt_pos(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v > 0.0)
}

fn is_bare_die(node: &ExpressionNode) -> Option<&DieNode> {
    match node {
        ExpressionNode::Die(d)
            if !opt_pos(d.reroll) && !opt_pos(d.minimum) && !opt_pos(d.explode) =>
        {
            Some(d)
        }
        _ => None,
    }
}

/// Consumes `\d+(\.\d+)?` (ASCII digits, as JS `\d`) from `c[*i..]`.
fn take_number(c: &[char], i: &mut usize) -> bool {
    fn digits(c: &[char], i: &mut usize) -> bool {
        let start = *i;
        while *i < c.len() && c[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    }
    if !digits(c, i) {
        return false;
    }
    if *i < c.len() && c[*i] == '.' {
        let mut j = *i + 1;
        if digits(c, &mut j) {
            *i = j;
        }
    }
    true
}

/// `/^\d+(\.\d+)?$/`.
fn is_number_text(c: &[char]) -> bool {
    let mut i = 0;
    take_number(c, &mut i) && i == c.len()
}

/// `/^(\d+(\.\d+)?)?h?d\d+$/`.
fn is_dice_text(c: &[char]) -> bool {
    let mut i = 0;
    take_number(c, &mut i);
    if i < c.len() && c[i] == 'h' {
        i += 1;
    }
    if i >= c.len() || c[i] != 'd' {
        return false;
    }
    i += 1;
    let start = i;
    while i < c.len() && c[i].is_ascii_digit() {
        i += 1;
    }
    i > start && i == c.len()
}

/// `/^(\d+(\.\d+)?(k[hl]\d+(\.\d+)?)?)?$/`.
fn is_group_prefix(c: &[char]) -> bool {
    if c.is_empty() {
        return true;
    }
    let mut i = 0;
    if !take_number(c, &mut i) {
        return false;
    }
    if i == c.len() {
        return true;
    }
    if c[i] != 'k' || i + 1 >= c.len() || !matches!(c[i + 1], 'h' | 'l') {
        return false;
    }
    i += 2;
    take_number(c, &mut i) && i == c.len()
}

/// Whether `text` is read as one argument wherever it sits: a number, a dice term (`2d6`, `d20`,
/// `hd20`), or a group `(…)`, `N(…)` or `NkhK(…)` whose first parenthesis closes at the end.
fn is_atomic_text(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if is_number_text(&chars) || is_dice_text(&chars) {
        return true;
    }
    let Some(open) = chars.iter().position(|c| *c == '(') else {
        return false;
    };
    if chars.last() != Some(&')') {
        return false;
    }
    if !is_group_prefix(&chars[..open]) {
        return false;
    }
    let mut depth = 0i64;
    for (i, c) in chars.iter().enumerate().skip(open) {
        if *c == '(' {
            depth += 1;
        } else if *c == ')' {
            depth -= 1;
            if depth == 0 {
                return i == chars.len() - 1;
            }
        }
    }
    false
}

/// `atom`: `text` as one argument: parenthesised unless it already is one.
pub fn atom(text: &str) -> String {
    if is_atomic_text(text) {
        text.to_string()
    } else {
        format!("({text})")
    }
}

/// `numberAtom`: a number as one argument; the grammar has no negative literal, so `-3` is
/// `(0 - 3)`.
pub fn number_atom(value: f64) -> String {
    if value < 0.0 {
        format!("(0 - {})", num_to_string(-value))
    } else {
        num_to_string(value)
    }
}

/// `joinTerms`: joins signed terms into one sum. Zero terms are dropped; a positive term leads
/// when there is one. A term after the first is parenthesised unless it is atomic, and a positive
/// term joins with ` + ` only when the running total before it can never be 0.
pub fn join_terms(terms: &[ExpressionTerm]) -> String {
    let mut live: Vec<&ExpressionTerm> = terms.iter().filter(|t| t.text != "0").collect();
    if live.is_empty() {
        return "0".to_string();
    }
    if let Some(lead) = live.iter().position(|t| t.sign == Sign::Plus)
        && lead > 0
    {
        let term = live.remove(lead);
        live.insert(0, term);
    }

    let mut text = String::new();
    let mut known = true;
    let (mut lo, mut hi) = (0.0f64, 0.0f64);
    for (i, term) in live.iter().enumerate() {
        if i == 0 {
            text = if term.sign == Sign::Plus {
                term.text.clone()
            } else {
                format!("0 - {}", atom(&term.text))
            };
        } else if term.sign == Sign::Minus {
            let _ = write!(text, " - {}", atom(&term.text));
        } else {
            let never_zero = known && (lo > 0.0 || hi < 0.0);
            let _ = write!(
                text,
                "{}{}",
                if never_zero { " + " } else { " ~+ " },
                atom(&term.text)
            );
        }
        match (known, term.range) {
            (true, Some((a, b))) => {
                if term.sign == Sign::Plus {
                    lo += a;
                    hi += b;
                } else {
                    lo -= b;
                    hi -= a;
                }
            }
            _ => known = false,
        }
    }
    text
}

/// `printDie`: one die with its per-die rules.
fn print_die(die: &DieNode) -> Result<String, DiceError> {
    if opt_pos(die.explode) {
        return Err(DiceError::error(format!(
            "toExpression() cannot represent an exploding die (d{} explode({})): the string grammar has no explode syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().",
            num_to_string(die.sides),
            num_to_string(die.explode.unwrap_or(0.0))
        )));
    }
    let reroll = die.reroll.unwrap_or(0.0);
    let minimum = die.minimum.unwrap_or(0.0);
    if die.sides == 20.0 && reroll == 1.0 && minimum <= 1.0 {
        return Ok("hd20".to_string());
    }
    let mut text = format!("d{}", num_to_string(die.sides));
    if reroll > 0.0 {
        if reroll == 1.0 {
            text.push_str(" reroll 1");
        } else {
            let _ = write!(text, " reroll d{}", num_to_string(reroll));
        }
    }
    if minimum > 0.0 {
        text = format!("{}>{}", num_to_string(minimum), atom(&text));
    }
    Ok(text)
}

fn print_keep(node: &KeepNode, options: PrintOptions) -> Result<String, DiceError> {
    let KeepChild::Sum(pool) = &*node.child else {
        return Err(DiceError::error(
            "toExpression(): a keep must hold a pool of trials",
        ));
    };
    let trials = js_max(0.0, pool.count.floor());
    if trials == 0.0 || js_min(node.count, trials) <= 0.0 {
        return Ok("0".to_string());
    }
    let highest = node.mode == super::types::KeepMode::Highest;
    if options.roll_type_chain && node.count == 1.0 && (trials == 2.0 || trials == 3.0) {
        let operand = atom(&print_node(&pool.child, PrintOptions::default())?);
        let sep = if highest { " > " } else { " < " };
        return Ok(vec![operand; trials as usize].join(sep));
    }
    let trial = match is_bare_die(&pool.child) {
        Some(d) => format!("1d{}", num_to_string(d.sides)),
        None => print_node(&pool.child, PrintOptions::default())?,
    };
    Ok(format!(
        "{}k{}{}({})",
        num_to_string(pool.count),
        if highest { "h" } else { "l" },
        num_to_string(node.count),
        trial
    ))
}

/// `printScale`: the text of a scaled result `round(value * numerator / denominator)`:
/// `N ** (inner)`, `(inner) // D`, `(inner) / D` or `(inner) ** N // D`.
pub fn print_scale(
    inner: &str,
    numerator: f64,
    denominator: f64,
    rounding: super::nodes::Rounding,
) -> Result<String, DiceError> {
    use super::nodes::Rounding;
    let den = if denominator == 0.0 { 1.0 } else { denominator };
    if !is_integer(numerator) || !is_integer(den) {
        return Err(DiceError::error(format!(
            "toExpression() cannot represent scaleResult({}, {}): the string grammar has only whole numbers. Use the builder's own PMF (.toPMF()/.pmf) instead.",
            num_to_string(numerator),
            num_to_string(denominator)
        )));
    }
    if den == 1.0 {
        return Ok(format!("{} ** ({inner})", number_atom(numerator)));
    }
    if rounding == Rounding::Round {
        return Err(DiceError::error(format!(
            "toExpression() cannot represent scaleResult({}, {}, \"round\"): the string grammar has only floor (//) and ceil (/) division. Use the builder's own PMF (.toPMF()/.pmf) instead.",
            num_to_string(numerator),
            num_to_string(denominator)
        )));
    }
    let div = if rounding == Rounding::Ceil {
        "/"
    } else {
        "//"
    };
    if numerator == 1.0 {
        return Ok(format!("({inner}) {div} {}", number_atom(den)));
    }
    Ok(format!(
        "({inner}) ** {} {div} {}",
        number_atom(numerator),
        number_atom(den)
    ))
}

fn print_sum(node: &SumNode, options: PrintOptions) -> Result<String, DiceError> {
    if opt_pos(node.explode_pool_budget) {
        let sides = match &*node.child {
            ExpressionNode::Die(d) => d.sides,
            _ => 0.0,
        };
        return Err(DiceError::error(format!(
            "toExpression() cannot represent a pool-wide exploding-dice budget (d{} explodePool({})): the string grammar has no explode syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().",
            num_to_string(sides),
            num_to_string(node.explode_pool_budget.unwrap_or(0.0))
        )));
    }
    if node.count.floor() <= 0.0 {
        return Ok("0".to_string());
    }
    if let Some(d) = is_bare_die(&node.child) {
        if node.count != 1.0 {
            return Ok(format!(
                "{}d{}",
                num_to_string(node.count),
                num_to_string(d.sides)
            ));
        }
        return Ok(if options.d20_shorthand && d.sides == 20.0 {
            "d20".to_string()
        } else {
            format!("1d{}", num_to_string(d.sides))
        });
    }
    let inner = print_node(&node.child, options)?;
    Ok(if node.count == 1.0 {
        inner
    } else {
        format!("{}({inner})", num_to_string(node.count))
    })
}

/// `printNode`: the text of an AST node, read by the parser as the same distribution the resolver
/// gives it.
pub fn print_node(node: &ExpressionNode, options: PrintOptions) -> Result<String, DiceError> {
    match node {
        ExpressionNode::Constant(c) => Ok(if c.value < 0.0 {
            format!("0 - {}", num_to_string(-c.value))
        } else {
            num_to_string(c.value)
        }),
        ExpressionNode::Die(d) => print_die(d),
        ExpressionNode::Sum(s) => print_sum(s, options),
        ExpressionNode::Keep(k) => print_keep(k, options),
        ExpressionNode::D20Roll(r) => {
            let operand = atom(&print_node(&r.child, PrintOptions::default())?);
            Ok(match r.roll_type {
                D20RollKind::Advantage => format!("{operand} > {operand}"),
                D20RollKind::Disadvantage => format!("{operand} < {operand}"),
                D20RollKind::ElvenAccuracy => format!("{operand} > {operand} > {operand}"),
            })
        }
        ExpressionNode::MaxOf(m) => {
            let count = js_max(1.0, m.count.floor());
            if count == 1.0 {
                return print_node(&m.child, PrintOptions::default());
            }
            let inner = match is_bare_die(&m.child) {
                Some(d) => format!("1d{}", num_to_string(d.sides)),
                None => print_node(&m.child, PrintOptions::default())?,
            };
            Ok(format!("{}kh1({inner})", num_to_string(count)))
        }
        ExpressionNode::Half(h) => Ok(format!(
            "({}) // 2",
            print_node(&h.child, PrintOptions::default())?
        )),
        ExpressionNode::Scale(s) => {
            let inner = print_node(&s.child, PrintOptions::default())?;
            print_scale(&inner, s.numerator, s.denominator, s.rounding)
        }
        ExpressionNode::RerollUpTo(r) => Err(DiceError::error(format!(
            "toExpression() cannot represent rerollUpTo({}): the string grammar has no reroll-up-to-k syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().",
            num_to_string(r.budget)
        ))),
        ExpressionNode::Add(a) => {
            let mut terms = Vec::with_capacity(a.children.len());
            for c in &a.children {
                terms.push(if let ExpressionNode::Constant(k) = &c.node {
                    constant_term(c.sign.value() * k.value)
                } else {
                    ExpressionTerm {
                        text: print_node(&c.node, PrintOptions::default())?,
                        sign: c.sign,
                        range: Some(node_range(&c.node)?),
                    }
                });
            }
            Ok(join_terms(&terms))
        }
        ExpressionNode::Max(_) => Err(DiceError::error(
            "toExpression() has no spelling for a \"max\" node",
        )),
    }
}

/// `nodeRange`: the least and greatest value `node` can resolve to.
pub fn node_range(node: &ExpressionNode) -> Result<(f64, f64), DiceError> {
    match node {
        ExpressionNode::Constant(c) => Ok((c.value, c.value)),
        ExpressionNode::Die(d) => {
            let sides = js_max(0.0, d.sides.floor());
            if sides == 0.0 {
                return Ok((0.0, 0.0));
            }
            let minimum = js_max(0.0, d.minimum.unwrap_or(0.0).floor());
            let hi = if opt_pos(d.explode) {
                f64::INFINITY
            } else {
                js_max(sides, minimum)
            };
            Ok((js_max(1.0, minimum), hi))
        }
        ExpressionNode::Sum(s) => {
            let count = js_max(0.0, s.count.floor());
            if count == 0.0 {
                return Ok((0.0, 0.0));
            }
            let (lo, hi) = node_range(&s.child)?;
            Ok((
                count * lo,
                if opt_pos(s.explode_pool_budget) {
                    f64::INFINITY
                } else {
                    count * hi
                },
            ))
        }
        ExpressionNode::Keep(k) => {
            let mut pool = &*k.child;
            while let KeepChild::Keep(inner) = pool {
                pool = &inner.child;
            }
            let KeepChild::Sum(sum) = pool else {
                return Ok((0.0, 0.0));
            };
            let trials = js_max(0.0, sum.count.floor());
            let kept = js_max(0.0, js_min(k.count, trials));
            if kept == 0.0 {
                return Ok((0.0, 0.0));
            }
            let (lo, hi) = node_range(&sum.child)?;
            Ok((kept * lo, kept * hi))
        }
        ExpressionNode::D20Roll(r) => node_range(&r.child),
        ExpressionNode::MaxOf(m) => node_range(&m.child),
        ExpressionNode::RerollUpTo(r) => {
            let (lo, hi) = node_range(&r.child)?;
            match &r.rolled_once {
                None => Ok((lo, hi)),
                Some(once) => {
                    let (once_lo, once_hi) = node_range(once)?;
                    Ok((lo + once_lo, hi + once_hi))
                }
            }
        }
        ExpressionNode::Half(h) => {
            let (lo, hi) = node_range(&h.child)?;
            Ok(((lo / 2.0).floor(), (hi / 2.0).floor()))
        }
        ExpressionNode::Scale(s) => {
            let (lo, hi) = node_range(&s.child)?;
            // Rounded either way, the scaled value lies within the rounded-out scaled bounds.
            let factor = s.numerator
                / if s.denominator == 0.0 {
                    1.0
                } else {
                    s.denominator
                };
            let (a, b) = (lo * factor, hi * factor);
            Ok((js_min(a, b).floor(), js_max(a, b).ceil()))
        }
        ExpressionNode::Add(a) => {
            let (mut lo, mut hi) = (0.0, 0.0);
            for c in &a.children {
                let (x, y) = node_range(&c.node)?;
                if c.sign == Sign::Plus {
                    lo += x;
                    hi += y;
                } else {
                    lo -= y;
                    hi -= x;
                }
            }
            Ok((lo, hi))
        }
        ExpressionNode::Max(_) => Err(DiceError::error("no value range for a \"max\" node")),
    }
}

fn constant_term(value: f64) -> ExpressionTerm {
    let magnitude = value.abs();
    ExpressionTerm {
        text: num_to_string(magnitude),
        sign: if value < 0.0 { Sign::Minus } else { Sign::Plus },
        range: Some((magnitude, magnitude)),
    }
}

fn complexity(config: &RollConfig) -> f64 {
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    b(config.reroll > 0.0)
        + b(config.explode > 0.0)
        + b(config.explode_pool_budget > 0.0)
        + b(config.minimum > 0.0)
        + b(config.best_of > 0.0)
        + b(config.keep.is_some())
        + b(config.roll_type != RollType::Flat)
}

#[derive(Clone, Debug)]
struct DiceGroup {
    config: RollConfig,
    count: f64,
    negative: bool,
    root: bool,
}

/// Two groups of the same plain die sum to one group of both counts. A keep, a `bestOf`, a roll
/// type, a pool-wide explode budget or a zero count makes a group's meaning depend on its own
/// count, so such a group is never merged.
fn mergeable(config: &RollConfig) -> bool {
    config.keep.is_none()
        && not_positive(config.best_of)
        && config.roll_type == RollType::Flat
        && not_positive(config.explode_pool_budget)
        && config.count != 0.0
}

/// `JSON.stringify(n)`: a non-finite number is `null`.
fn json_num(n: f64) -> String {
    if n.is_finite() {
        num_to_string(n)
    } else {
        "null".to_string()
    }
}

/// `JSON.stringify({ ...config, count: 0, modifier: 0, isSubtraction: negative })`.
fn merge_key(config: &RollConfig, negative: bool) -> String {
    let mut key = format!(
        "{{\"count\":0,\"sides\":{},\"modifier\":0,\"reroll\":{},\"explode\":{},\"explodePoolBudget\":{},\"minimum\":{},\"bestOf\":{}",
        json_num(config.sides),
        json_num(config.reroll),
        json_num(config.explode),
        json_num(config.explode_pool_budget),
        json_num(config.minimum),
        json_num(config.best_of),
    );
    if let Some(k) = config.keep {
        let _ = write!(
            key,
            ",\"keep\":{{\"total\":{},\"count\":{},\"mode\":\"{}\"}}",
            json_num(k.total),
            json_num(k.count),
            k.mode.as_str()
        );
    }
    let _ = write!(
        key,
        ",\"rollType\":\"{}\",\"isSubtraction\":{}",
        config.roll_type.as_str(),
        negative
    );
    if config.pinned {
        key.push_str(",\"pinned\":true");
    }
    key.push('}');
    key
}

/// `diceGroups`. `root` is the index of the natural-roll config in `configs`.
fn dice_groups(configs: &[RollConfig], root: Option<usize>) -> Vec<DiceGroup> {
    let mut groups: Vec<DiceGroup> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (i, config) in configs.iter().enumerate() {
        if not_positive(config.sides) {
            continue;
        }
        let negative = config.is_subtraction == Some(true) || config.count < 0.0;
        let count = config.count.abs();
        let is_root = root == Some(i);
        if !mergeable(config) {
            groups.push(DiceGroup {
                config: config.clone(),
                count,
                negative,
                root: is_root,
            });
            continue;
        }
        let key = merge_key(config, negative);
        if let Some(&at) = by_key.get(&key) {
            groups[at].count += count;
            groups[at].root = groups[at].root || is_root;
        } else {
            by_key.insert(key, groups.len());
            groups.push(DiceGroup {
                config: config.clone(),
                count,
                negative,
                root: is_root,
            });
        }
    }
    groups
}

/// Reroll/minimum groups first, then larger dice, then more complex groups.
fn by_print_order(a: &DiceGroup, b: &DiceGroup) -> std::cmp::Ordering {
    let a_first = a.config.reroll > 0.0 || a.config.minimum > 0.0;
    let b_first = b.config.reroll > 0.0 || b.config.minimum > 0.0;
    if a_first != b_first {
        return if a_first {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    if b.config.sides != a.config.sides {
        return ordering_of(b.config.sides - a.config.sides);
    }
    ordering_of(complexity(&b.config) - complexity(&a.config))
}

fn group_terms(group: &DiceGroup) -> Result<Vec<ExpressionTerm>, DiceError> {
    let mut config = group.config.clone();
    config.count = group.count;
    config.modifier = 0.0;
    config.is_subtraction = Some(group.negative);
    let Some(ExpressionNode::Add(add)) = ast_from_roll_configs(std::slice::from_ref(&config))?
    else {
        return Ok(Vec::new());
    };
    let options = PrintOptions {
        d20_shorthand: group.root,
        roll_type_chain: config.roll_type != RollType::Flat,
    };
    let mut terms = Vec::new();
    for child in &add.children {
        if matches!(child.node, ExpressionNode::Constant(_)) {
            continue;
        }
        terms.push(ExpressionTerm {
            text: print_node(&child.node, options)?,
            sign: child.sign,
            range: Some(node_range(&child.node)?),
        });
    }
    Ok(terms)
}

/// The terms of a sum of die groups plus their flats, in print order: a leading d20 group (the
/// natural roll) first with the flat total right after it, otherwise the flat total last.
fn ordered_terms(
    groups: &[DiceGroup],
    leading: Option<usize>,
    modifier: f64,
) -> Result<Vec<ExpressionTerm>, DiceError> {
    let mut rest: Vec<usize> = (0..groups.len()).filter(|i| Some(*i) != leading).collect();
    stable_sort_by(&mut rest, |a, b| by_print_order(&groups[*a], &groups[*b]));
    let ordered: Vec<usize> = leading.into_iter().chain(rest).collect();
    let mut terms: Vec<Vec<ExpressionTerm>> = Vec::with_capacity(ordered.len());
    for i in &ordered {
        terms.push(group_terms(&groups[*i])?);
    }
    let flat = if modifier == 0.0 {
        Vec::new()
    } else {
        vec![constant_term(modifier)]
    };
    let first_is_d20 = ordered
        .first()
        .is_some_and(|i| groups[*i].config.sides == 20.0);
    let mut it = terms.into_iter();
    if first_is_d20 {
        let mut out: Vec<ExpressionTerm> = it.next().unwrap_or_default();
        out.extend(flat);
        for t in it {
            out.extend(t);
        }
        Ok(out)
    } else {
        let mut out: Vec<ExpressionTerm> = it.flatten().collect();
        out.extend(flat);
        Ok(out)
    }
}

/// `configTerms`: the terms of a plain roll's configs: every die group, then the total of their
/// flats. `root` is the index of the natural-roll config (a d20 root prints first, as `d20`).
pub fn config_terms(
    configs: &[RollConfig],
    root: Option<usize>,
) -> Result<Vec<ExpressionTerm>, DiceError> {
    let groups = dice_groups(configs, root);
    let root_group = groups.iter().position(|g| g.root);
    let modifier = configs.iter().fold(0.0, |sum, c| sum + c.modifier);
    ordered_terms(
        &groups,
        root_group.filter(|i| groups[*i].config.sides == 20.0),
        modifier,
    )
}

/// `CheckDice` (a structural type in TS): the minimal shape of a check the printer reads.
pub trait CheckDiceSource {
    fn get_root_die_config(&self) -> Option<RollConfig>;
    fn get_bonus_dice_configs(&self) -> Vec<RollConfig>;
    fn modifier(&self) -> f64;
}

/// `rootDieExpression`: a check's natural roll as the check resolvers read it: ONE root die with
/// its reroll/minimum, rolled with its roll type. `None` for a check with no die.
pub fn root_die_expression(check: &dyn CheckDiceSource) -> Result<Option<String>, DiceError> {
    let Some(root) = check.get_root_die_config() else {
        return Ok(None);
    };
    if not_positive(root.sides) {
        return Ok(None);
    }
    let die = die_node_from_config(&root)?;
    let node = match root.roll_type {
        RollType::Flat => ExpressionNode::Die(die),
        RollType::Advantage => d20_roll(D20RollKind::Advantage, die),
        RollType::Disadvantage => d20_roll(D20RollKind::Disadvantage, die),
        RollType::ElvenAccuracy => d20_roll(D20RollKind::ElvenAccuracy, die),
    };
    print_node(&node, PrintOptions::default()).map(Some)
}

fn d20_roll(kind: D20RollKind, die: DieNode) -> ExpressionNode {
    ExpressionNode::D20Roll(D20RollNode {
        roll_type: kind,
        child: Box::new(ExpressionNode::Die(die)),
    })
}

/// `checkExpression`: the to-hit/save total of a check as its resolvers read it: the root die,
/// its flat total, and every bonus die group (Bless, Bane, Guidance).
pub fn check_expression(check: &dyn CheckDiceSource) -> Result<String, DiceError> {
    let root_text = root_die_expression(check)?;
    let bonus_configs = check.get_bonus_dice_configs();
    let groups = dice_groups(&bonus_configs, None);
    let modifier = check.modifier();
    let Some(root_text) = root_text else {
        return Ok(join_terms(&ordered_terms(&groups, None, modifier)?));
    };
    let Some(root) = check.get_root_die_config() else {
        return Err(DiceError::error(
            "checkExpression(): a check with a root expression has a root config",
        ));
    };
    let root_term = ExpressionTerm {
        text: root_text,
        sign: Sign::Plus,
        range: Some(node_range(&ExpressionNode::Die(die_node_from_config(
            &root,
        )?))?),
    };
    let flat = if modifier == 0.0 {
        Vec::new()
    } else {
        vec![constant_term(modifier)]
    };
    let bonus = ordered_terms(&groups, None, 0.0)?;
    let mut terms = vec![root_term];
    if root.sides == 20.0 {
        terms.extend(flat);
        terms.extend(bonus);
    } else {
        terms.extend(bonus);
        terms.extend(flat);
    }
    Ok(join_terms(&terms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atoms() {
        for t in [
            "2",
            "1.5",
            "2d6",
            "d20",
            "hd20",
            "(1d6 + 2)",
            "3(d6 reroll 1)",
            "4kh3(1d6)",
        ] {
            assert_eq!(atom(t), t, "{t}");
        }
        assert_eq!(atom("d8 reroll 1"), "(d8 reroll 1)");
        assert_eq!(atom("(d4) + (d6)"), "((d4) + (d6))");
        assert_eq!(number_atom(-3.0), "(0 - 3)");
    }

    #[test]
    fn joins() {
        let t = |text: &str, sign: Sign, range: Option<(f64, f64)>| ExpressionTerm {
            text: text.to_string(),
            sign,
            range,
        };
        assert_eq!(
            join_terms(&[
                t("1d4", Sign::Minus, Some((1.0, 4.0))),
                t("2d6", Sign::Plus, Some((2.0, 12.0)))
            ]),
            "2d6 - 1d4"
        );
        assert_eq!(join_terms(&[t("0", Sign::Plus, None)]), "0");
        assert_eq!(
            join_terms(&[t("1d4", Sign::Minus, Some((1.0, 4.0)))]),
            "0 - 1d4"
        );
    }
}
