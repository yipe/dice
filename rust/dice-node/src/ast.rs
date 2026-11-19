//! Expression AST, printing, sampling, miss-reroll, reroll-pool, d20 and cache-key bindings.
//!
//! `ExpressionNode` crosses as JSON text in the TS node shape of `src/builder/nodes.ts` (the
//! facade's `ts/builder/node-json.ts` is the other half). Numbers that JSON cannot carry travel as
//! the strings `"NaN"`, `"Infinity"`, `"-Infinity"` and `"-0"`. An absent optional field is
//! omitted, never `null`. The text nests deeper than serde_json's default limit (128), so it is
//! parsed without that limit after a bracket-depth pre-scan, and the converters carry a depth
//! counter (ADR-016: past 500 nodes, the JS stack-overflow error).
//!
//! Free functions are named `<module>` + verb: `ast*`, `expr*`, `sample*`, `missReroll*`,
//! `pool*`, `d20*`, `prob*`, `key*`. `arguments.ts` is pure TS: the facade uses `src/` as is.
//! Callbacks (`rng`, `cdfPow`) are called back synchronously; an error thrown inside one is held,
//! the Rust call finishes on dummy values, and the error is rethrown in place of the result (see
//! `rng.rs`).

use std::cell::RefCell;

use napi::bindgen_prelude::Function;
use napi_derive::napi;
use serde_json::{Map, Value};
use yipe_dice::builder::ast::{
    KeepReading, ast_from_roll_configs, die_node_from_config, find_die, get_ast_signature,
    get_total_count, natural_die_config, per_die_keep_reading, rerollable_pool, resolve,
    resolve_d20_roll, resolve_root_d20, resolve_single_die,
};
use yipe_dice::builder::d20::{d20_pmf, d20_roll_pmf};
use yipe_dice::builder::expression::{
    CheckDiceSource, ExpressionTerm, PrintOptions, atom, check_expression, config_terms,
    join_terms, node_range, number_atom, print_node, print_scale, root_die_expression,
};
use yipe_dice::builder::miss_reroll::{miss_reroll_check_expression, miss_reroll_odds};
use yipe_dice::builder::nodes::{
    AddChild, AddNode, ConstantNode, D20RollKind, D20RollNode, DieNode, ExpressionNode, HalfNode,
    KeepChild, KeepNode, MaxNode, MaxOfNode, RerollUpToNode, Rounding, ScaleNode, Sign, SumNode,
};
use yipe_dice::builder::prob::{d20_pmf_from_cdf, split_at_threshold};
use yipe_dice::builder::reroll_pool::{
    PoolDieKind, reroll_up_to_match, reroll_up_to_partial_pmf, reroll_up_to_pmf,
};
use yipe_dice::builder::roll::default_config;
use yipe_dice::builder::roll_cache_key::{Value as KeyValue, json_roll_key, roll_configs_key};
use yipe_dice::builder::sample::{
    SampledDie, read_check_dice, sample_check_dice, sample_die, sample_node,
};
use yipe_dice::builder::types::{KeepMode, KeepSpec, RollConfig};
use yipe_dice::common::RollType;

use crate::conv::{self, JsCheckDice, JsRollConfig, JsRollSample, JsSampledDie};
use crate::pmf::NativePmf;
use crate::rng::JsRng;
use crate::roll::{NativeRoll, rounding};
use crate::{DiceError, err, thrown};

// ---- JSON numbers -------------------------------------------------------------------------------

/// Deepest node nesting accepted (ADR-016: 500); past it, the JS stack-overflow error.
const MAX_DEPTH: usize = 500;

/// Deepest JSON bracket nesting accepted: a node costs up to three brackets (`add` > `children` >
/// entry).
const MAX_BRACKETS: usize = 3 * MAX_DEPTH + 16;

fn push_num(out: &mut String, x: f64) {
    if x.is_nan() {
        out.push_str("\"NaN\"");
    } else if x == f64::INFINITY {
        out.push_str("\"Infinity\"");
    } else if x == f64::NEG_INFINITY {
        out.push_str("\"-Infinity\"");
    } else if x == 0.0 && x.is_sign_negative() {
        out.push_str("\"-0\"");
    } else {
        out.push_str(&format!("{x:?}"));
    }
}

fn num_of(v: &Value) -> Result<f64, DiceError> {
    match v {
        Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| DiceError::error("dice-node: number out of range")),
        Value::String(s) => match s.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            "-0" => Ok(-0.0),
            other => Err(DiceError::error(format!(
                "dice-node: not a number: {other:?}"
            ))),
        },
        other => Err(DiceError::error(format!(
            "dice-node: not a number: {other}"
        ))),
    }
}

/// Parses `json` after checking its bracket depth, with serde_json's own limit off.
fn parse_json(json: &str) -> Result<Value, DiceError> {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for b in json.bytes() {
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > MAX_BRACKETS {
                        return Err(DiceError::stack_overflow());
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    let mut de = serde_json::Deserializer::from_str(json);
    de.disable_recursion_limit();
    match de.into_iter::<Value>().next() {
        Some(Ok(v)) => Ok(v),
        Some(Err(e)) => Err(DiceError::error(format!("dice-node: invalid JSON: {e}"))),
        None => Err(DiceError::error("dice-node: empty JSON")),
    }
}

// ---- node -> JSON -------------------------------------------------------------------------------

fn push_opt(out: &mut String, key: &str, x: Option<f64>) {
    if let Some(x) = x {
        out.push_str(",\"");
        out.push_str(key);
        out.push_str("\":");
        push_num(out, x);
    }
}

fn push_field(out: &mut String, key: &str, x: f64) {
    out.push_str(",\"");
    out.push_str(key);
    out.push_str("\":");
    push_num(out, x);
}

fn rounding_name(r: Rounding) -> &'static str {
    match r {
        Rounding::Floor => "floor",
        Rounding::Round => "round",
        Rounding::Ceil => "ceil",
    }
}

fn d20_kind_name(k: D20RollKind) -> &'static str {
    roll_type_of(k).as_str()
}

fn roll_type_of(k: D20RollKind) -> RollType {
    match k {
        D20RollKind::Advantage => RollType::Advantage,
        D20RollKind::Disadvantage => RollType::Disadvantage,
        D20RollKind::ElvenAccuracy => RollType::ElvenAccuracy,
    }
}

fn write_die(out: &mut String, d: &DieNode) {
    out.push_str("{\"type\":\"die\"");
    push_field(out, "sides", d.sides);
    push_opt(out, "reroll", d.reroll);
    push_opt(out, "minimum", d.minimum);
    push_opt(out, "explode", d.explode);
    out.push('}');
}

fn write_sum(out: &mut String, s: &SumNode) {
    out.push_str("{\"type\":\"sum\"");
    push_field(out, "count", s.count);
    out.push_str(",\"child\":");
    write_node(out, &s.child);
    push_opt(out, "explodePoolBudget", s.explode_pool_budget);
    out.push('}');
}

fn write_keep(out: &mut String, k: &KeepNode) {
    out.push_str("{\"type\":\"keep\",\"mode\":\"");
    out.push_str(k.mode.as_str());
    out.push('"');
    push_field(out, "count", k.count);
    out.push_str(",\"child\":");
    match &*k.child {
        KeepChild::Sum(s) => write_sum(out, s),
        KeepChild::Keep(inner) => write_keep(out, inner),
    }
    out.push('}');
}

fn write_child(out: &mut String, key: &str, child: &ExpressionNode) {
    out.push_str(",\"");
    out.push_str(key);
    out.push_str("\":");
    write_node(out, child);
}

fn write_node(out: &mut String, node: &ExpressionNode) {
    match node {
        ExpressionNode::Die(d) => write_die(out, d),
        ExpressionNode::Constant(c) => {
            out.push_str("{\"type\":\"constant\"");
            push_field(out, "value", c.value);
            out.push('}');
        }
        ExpressionNode::Sum(s) => write_sum(out, s),
        ExpressionNode::Add(a) => {
            out.push_str("{\"type\":\"add\",\"children\":[");
            for (i, c) in a.children.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str("{\"node\":");
                write_node(out, &c.node);
                push_field(out, "sign", c.sign.value());
                out.push('}');
            }
            out.push_str("]}");
        }
        ExpressionNode::Keep(k) => write_keep(out, k),
        ExpressionNode::D20Roll(r) => {
            out.push_str("{\"type\":\"d20Roll\",\"rollType\":\"");
            out.push_str(d20_kind_name(r.roll_type));
            out.push('"');
            write_child(out, "child", &r.child);
            out.push('}');
        }
        ExpressionNode::Half(h) => {
            out.push_str("{\"type\":\"half\"");
            write_child(out, "child", &h.child);
            out.push('}');
        }
        ExpressionNode::MaxOf(m) => {
            out.push_str("{\"type\":\"maxOf\"");
            push_field(out, "count", m.count);
            write_child(out, "child", &m.child);
            out.push('}');
        }
        ExpressionNode::Max(m) => {
            out.push_str("{\"type\":\"max\",\"children\":[");
            for (i, c) in m.children.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_node(out, c);
            }
            out.push_str("]}");
        }
        ExpressionNode::Scale(s) => {
            out.push_str("{\"type\":\"scale\"");
            push_field(out, "numerator", s.numerator);
            push_field(out, "denominator", s.denominator);
            out.push_str(",\"rounding\":\"");
            out.push_str(rounding_name(s.rounding));
            out.push('"');
            write_child(out, "child", &s.child);
            out.push('}');
        }
        ExpressionNode::RerollUpTo(r) => {
            out.push_str("{\"type\":\"rerollUpTo\"");
            push_field(out, "budget", r.budget);
            push_field(out, "rolls", r.rolls);
            write_child(out, "child", &r.child);
            if let Some(once) = &r.rolled_once {
                write_child(out, "rolledOnce", once);
            }
            out.push('}');
        }
    }
}

fn node_json(node: &ExpressionNode) -> String {
    let mut out = String::new();
    write_node(&mut out, node);
    out
}

// ---- JSON -> node -------------------------------------------------------------------------------

fn bad(what: &str) -> DiceError {
    DiceError::error(format!("dice-node: invalid expression node: {what}"))
}

fn obj(v: &Value) -> Result<&Map<String, Value>, DiceError> {
    v.as_object().ok_or_else(|| bad("not an object"))
}

fn req(o: &Map<String, Value>, key: &str) -> Result<f64, DiceError> {
    num_of(o.get(key).ok_or_else(|| bad(&format!("missing {key}")))?)
}

fn opt(o: &Map<String, Value>, key: &str) -> Result<Option<f64>, DiceError> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => num_of(v).map(Some),
    }
}

fn child_of(
    o: &Map<String, Value>,
    key: &str,
    depth: usize,
) -> Result<Box<ExpressionNode>, DiceError> {
    let v = o.get(key).ok_or_else(|| bad(&format!("missing {key}")))?;
    node_of(v, depth + 1).map(Box::new)
}

fn sum_of(o: &Map<String, Value>, depth: usize) -> Result<SumNode, DiceError> {
    Ok(SumNode {
        count: req(o, "count")?,
        child: child_of(o, "child", depth)?,
        explode_pool_budget: opt(o, "explodePoolBudget")?,
    })
}

fn keep_of(o: &Map<String, Value>, depth: usize) -> Result<KeepNode, DiceError> {
    let mode = match o.get("mode").and_then(Value::as_str) {
        Some("highest") => KeepMode::Highest,
        Some("lowest") => KeepMode::Lowest,
        _ => return Err(bad("keep mode")),
    };
    let child = o.get("child").ok_or_else(|| bad("missing child"))?;
    if depth >= MAX_DEPTH {
        return Err(DiceError::stack_overflow());
    }
    let co = obj(child)?;
    let child = match co.get("type").and_then(Value::as_str) {
        Some("sum") => KeepChild::Sum(sum_of(co, depth + 1)?),
        Some("keep") => KeepChild::Keep(keep_of(co, depth + 1)?),
        _ => return Err(bad("a keep's child is a sum or a keep")),
    };
    Ok(KeepNode {
        mode,
        count: req(o, "count")?,
        child: Box::new(child),
    })
}

fn node_of(v: &Value, depth: usize) -> Result<ExpressionNode, DiceError> {
    if depth > MAX_DEPTH {
        return Err(DiceError::stack_overflow());
    }
    let o = obj(v)?;
    let ty = o
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("missing type"))?;
    Ok(match ty {
        "die" => ExpressionNode::Die(die_of(o)?),
        "constant" => ExpressionNode::Constant(ConstantNode {
            value: req(o, "value")?,
        }),
        "sum" => ExpressionNode::Sum(sum_of(o, depth)?),
        "add" => {
            let list = o
                .get("children")
                .and_then(Value::as_array)
                .ok_or_else(|| bad("add children"))?;
            let mut children = Vec::with_capacity(list.len());
            for c in list {
                let co = obj(c)?;
                let sign = match req(co, "sign")? {
                    1.0 => Sign::Plus,
                    -1.0 => Sign::Minus,
                    _ => return Err(bad("sign is 1 or -1")),
                };
                children.push(AddChild {
                    node: *child_of(co, "node", depth)?,
                    sign,
                });
            }
            ExpressionNode::Add(AddNode { children })
        }
        "keep" => ExpressionNode::Keep(keep_of(o, depth)?),
        "d20Roll" => {
            let roll_type = match o.get("rollType").and_then(Value::as_str) {
                Some("advantage") => D20RollKind::Advantage,
                Some("disadvantage") => D20RollKind::Disadvantage,
                Some("elven accuracy") => D20RollKind::ElvenAccuracy,
                _ => return Err(bad("d20Roll rollType")),
            };
            ExpressionNode::D20Roll(D20RollNode {
                roll_type,
                child: child_of(o, "child", depth)?,
            })
        }
        "half" => ExpressionNode::Half(HalfNode {
            child: child_of(o, "child", depth)?,
        }),
        "maxOf" => ExpressionNode::MaxOf(MaxOfNode {
            count: req(o, "count")?,
            child: child_of(o, "child", depth)?,
        }),
        "max" => {
            let list = o
                .get("children")
                .and_then(Value::as_array)
                .ok_or_else(|| bad("max children"))?;
            let children = list
                .iter()
                .map(|c| node_of(c, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            ExpressionNode::Max(MaxNode { children })
        }
        "scale" => {
            let rounding = match o.get("rounding").and_then(Value::as_str) {
                Some("floor") => Rounding::Floor,
                Some("round") => Rounding::Round,
                Some("ceil") => Rounding::Ceil,
                _ => return Err(bad("scale rounding")),
            };
            ExpressionNode::Scale(ScaleNode {
                numerator: req(o, "numerator")?,
                denominator: req(o, "denominator")?,
                rounding,
                child: child_of(o, "child", depth)?,
            })
        }
        "rerollUpTo" => {
            let rolled_once = match o.get("rolledOnce") {
                None | Some(Value::Null) => None,
                Some(v) => Some(Box::new(node_of(v, depth + 1)?)),
            };
            ExpressionNode::RerollUpTo(RerollUpToNode {
                budget: req(o, "budget")?,
                rolls: req(o, "rolls")?,
                child: child_of(o, "child", depth)?,
                rolled_once,
            })
        }
        other => return Err(bad(&format!("unknown type {other:?}"))),
    })
}

fn die_of(o: &Map<String, Value>) -> Result<DieNode, DiceError> {
    Ok(DieNode {
        sides: req(o, "sides")?,
        reroll: opt(o, "reroll")?,
        minimum: opt(o, "minimum")?,
        explode: opt(o, "explode")?,
    })
}

fn node_in(json: &str) -> napi::Result<ExpressionNode> {
    parse_json(json)
        .and_then(|v| node_of(&v, 0))
        .map_err(thrown)
}

fn die_in(json: &str) -> napi::Result<DieNode> {
    match node_in(json)? {
        ExpressionNode::Die(d) => Ok(d),
        _ => Err(thrown(bad("not a die"))),
    }
}

fn keep_in(json: &str) -> napi::Result<KeepNode> {
    match node_in(json)? {
        ExpressionNode::Keep(k) => Ok(k),
        _ => Err(thrown(bad("not a keep"))),
    }
}

// ---- configs ------------------------------------------------------------------------------------

/// `{ ...defaultConfig, ...config }`.
fn full_config(c: &JsRollConfig) -> napi::Result<RollConfig> {
    let p = c.to_patch()?;
    let d = default_config();
    Ok(RollConfig {
        count: p.count.unwrap_or(d.count),
        sides: p.sides.unwrap_or(d.sides),
        modifier: p.modifier.unwrap_or(d.modifier),
        reroll: p.reroll.unwrap_or(d.reroll),
        explode: p.explode.unwrap_or(d.explode),
        explode_pool_budget: p.explode_pool_budget.unwrap_or(d.explode_pool_budget),
        minimum: p.minimum.unwrap_or(d.minimum),
        best_of: p.best_of.unwrap_or(d.best_of),
        keep: p.keep,
        roll_type: p.roll_type.unwrap_or(d.roll_type),
        is_subtraction: p.is_subtraction,
        pinned: p.pinned,
    })
}

fn full_configs(list: &[JsRollConfig]) -> napi::Result<Vec<RollConfig>> {
    list.iter().map(full_config).collect()
}

// ---- NativeRoll.toAstJson -----------------------------------------------------------------------

#[napi]
impl NativeRoll {
    /// `toAST()` as JSON text.
    #[napi]
    pub fn to_ast_json(&self) -> napi::Result<String> {
        self.inner.to_ast().map(|n| node_json(&n)).map_err(thrown)
    }
}

// ---- ast.ts -------------------------------------------------------------------------------------

/// `astFromRollConfigs`: node JSON, or undefined for no configs.
#[napi]
pub fn ast_from_roll_configs_json(configs: Vec<JsRollConfig>) -> napi::Result<Option<String>> {
    let node = ast_from_roll_configs(&full_configs(&configs)?).map_err(thrown)?;
    Ok(node.map(|n| node_json(&n)))
}

/// `dieNodeFromConfig`: node JSON.
#[napi]
pub fn ast_die_node_from_config(config: JsRollConfig) -> napi::Result<String> {
    let die = die_node_from_config(&full_config(&config)?).map_err(thrown)?;
    Ok(node_json(&ExpressionNode::Die(die)))
}

/// `perDieKeepReading`: `"dice"` or `"trials"`; an ambiguous keep is the `AmbiguousKeepError` text.
#[napi]
pub fn ast_per_die_keep_reading(
    count: f64,
    sides: f64,
    keep: conv::JsKeep,
    synthesized_best_of: bool,
) -> napi::Result<String> {
    let keep = KeepSpec {
        total: keep.total,
        count: keep.count,
        mode: conv::keep_mode(&keep.mode).map_err(thrown)?,
    };
    let reading = per_die_keep_reading(count, sides, &keep, synthesized_best_of).map_err(thrown)?;
    Ok(match reading {
        KeepReading::Dice => "dice",
        KeepReading::Trials => "trials",
    }
    .to_string())
}

/// `resolve(node, eps)`.
#[napi]
pub fn ast_resolve(node: String, eps: f64) -> napi::Result<NativePmf> {
    resolve(&node_in(&node)?, eps)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `pmfFromRollBuilder(rb, eps)`.
#[napi]
pub fn ast_pmf_from_roll_builder(rb: &NativeRoll, eps: f64) -> napi::Result<NativePmf> {
    yipe_dice::builder::ast::pmf_from_roll_builder_shared(&rb.inner, eps)
        .map(NativePmf::wrap_shared)
        .map_err(thrown)
}

/// `resolveD20Roll(die, rollType)`.
#[napi]
pub fn ast_resolve_d20_roll(die: String, roll_type: Option<String>) -> napi::Result<NativePmf> {
    let roll_type = match roll_type {
        Some(s) => Some(conv::roll_type(&s).map_err(thrown)?),
        None => None,
    };
    resolve_d20_roll(&die_in(&die)?, roll_type)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `resolveRootD20(check)`.
#[napi]
pub fn ast_resolve_root_d20(check: &NativeRoll) -> napi::Result<NativePmf> {
    resolve_root_d20(&check.inner)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `naturalDieConfig(check)`.
#[napi]
pub fn ast_natural_die_config(check: &NativeRoll) -> napi::Result<Option<JsRollConfig>> {
    Ok(natural_die_config(&check.inner)
        .map_err(thrown)?
        .as_ref()
        .map(JsRollConfig::from))
}

/// `resolveSingleDie(die, eps)`.
#[napi]
pub fn ast_resolve_single_die(die: String, eps: f64) -> napi::Result<NativePmf> {
    resolve_single_die(&die_in(&die)?, eps)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `rerollablePool(node)` as JSON: `{ groups: [{ die, count, sign }], flat }`.
#[napi]
pub fn ast_rerollable_pool(node: String) -> napi::Result<String> {
    let pool = rerollable_pool(&node_in(&node)?).map_err(thrown)?;
    let mut out = String::from("{\"groups\":[");
    for (i, g) in pool.groups.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"die\":");
        write_die(&mut out, &g.die);
        push_field(&mut out, "count", g.count);
        push_field(&mut out, "sign", g.sign.value());
        out.push('}');
    }
    out.push_str("],\"flat\":");
    push_num(&mut out, pool.flat);
    out.push('}');
    Ok(out)
}

/// `findDie(node)`: the die's node JSON, or undefined.
#[napi]
pub fn ast_find_die(node: String) -> napi::Result<Option<String>> {
    let node = node_in(&node)?;
    Ok(find_die(&node).map(|d| node_json(&ExpressionNode::Die(d.clone()))))
}

/// `getTotalCount(keepNode)`.
#[napi]
pub fn ast_total_count(node: String) -> napi::Result<f64> {
    Ok(get_total_count(&keep_in(&node)?))
}

/// `getASTSignature(node)`.
#[napi]
pub fn ast_signature(node: String) -> napi::Result<String> {
    Ok(get_ast_signature(&node_in(&node)?))
}

// ---- expression.ts ------------------------------------------------------------------------------

#[napi(object)]
pub struct JsTerm {
    pub text: String,
    /// 1 or -1.
    pub sign: f64,
    pub range: Option<Vec<f64>>,
}

impl From<&ExpressionTerm> for JsTerm {
    fn from(t: &ExpressionTerm) -> Self {
        JsTerm {
            text: t.text.clone(),
            sign: t.sign.value(),
            range: t.range.map(|(lo, hi)| vec![lo, hi]),
        }
    }
}

impl JsTerm {
    fn to_rust(&self) -> napi::Result<ExpressionTerm> {
        let sign = match self.sign {
            1.0 => Sign::Plus,
            -1.0 => Sign::Minus,
            _ => return Err(thrown(bad("term sign is 1 or -1"))),
        };
        let range = match self.range.as_deref() {
            Some([lo, hi]) => Some((*lo, *hi)),
            _ => None,
        };
        Ok(ExpressionTerm {
            text: self.text.clone(),
            sign,
            range,
        })
    }
}

/// `atom(text)`.
#[napi]
pub fn expr_atom(text: String) -> String {
    atom(&text)
}

/// `numberAtom(value)`.
#[napi]
pub fn expr_number_atom(value: f64) -> String {
    number_atom(value)
}

/// `joinTerms(terms)`.
#[napi]
pub fn expr_join_terms(terms: Vec<JsTerm>) -> napi::Result<String> {
    let terms = terms
        .iter()
        .map(JsTerm::to_rust)
        .collect::<napi::Result<Vec<_>>>()?;
    Ok(join_terms(&terms))
}

/// `printScale(inner, numerator, denominator, rounding)`.
#[napi]
pub fn expr_print_scale(
    inner: String,
    numerator: f64,
    denominator: f64,
    mode: String,
) -> napi::Result<String> {
    print_scale(&inner, numerator, denominator, rounding(&mode)?).map_err(thrown)
}

/// `printNode(node, { d20Shorthand, rollTypeChain })`.
#[napi]
pub fn expr_print_node(
    node: String,
    d20_shorthand: bool,
    roll_type_chain: bool,
) -> napi::Result<String> {
    print_node(
        &node_in(&node)?,
        PrintOptions {
            d20_shorthand,
            roll_type_chain,
        },
    )
    .map_err(thrown)
}

/// `nodeRange(node)`: `[least, greatest]`.
#[napi]
pub fn expr_node_range(node: String) -> napi::Result<Vec<f64>> {
    let (lo, hi) = node_range(&node_in(&node)?).map_err(thrown)?;
    Ok(vec![lo, hi])
}

/// `configTerms(configs, root)`: `root` is the index of the natural-roll config, if any.
#[napi]
pub fn expr_config_terms(
    configs: Vec<JsRollConfig>,
    root: Option<u32>,
) -> napi::Result<Vec<JsTerm>> {
    let terms = config_terms(&full_configs(&configs)?, root.map(|i| i as usize)).map_err(thrown)?;
    Ok(terms.iter().map(JsTerm::from).collect())
}

/// A check's three printed inputs, read once by the facade (`getRootDieConfig()`,
/// `getBonusDiceConfigs()`, `modifier`).
struct CheckParts {
    root: Option<RollConfig>,
    bonus: Vec<RollConfig>,
    modifier: f64,
}

impl CheckDiceSource for CheckParts {
    fn get_root_die_config(&self) -> Option<RollConfig> {
        self.root.clone()
    }
    fn get_bonus_dice_configs(&self) -> Vec<RollConfig> {
        self.bonus.clone()
    }
    fn modifier(&self) -> f64 {
        self.modifier
    }
}

fn check_parts(
    root: Option<JsRollConfig>,
    bonus: &[JsRollConfig],
    modifier: f64,
) -> napi::Result<CheckParts> {
    let root = match root {
        Some(c) => Some(full_config(&c)?),
        None => None,
    };
    Ok(CheckParts {
        root,
        bonus: full_configs(bonus)?,
        modifier,
    })
}

/// `rootDieExpression(check)`.
#[napi]
pub fn expr_root_die_expression(root: Option<JsRollConfig>) -> napi::Result<Option<String>> {
    root_die_expression(&check_parts(root, &[], 0.0)?).map_err(thrown)
}

/// `checkExpression(check)`.
#[napi]
pub fn expr_check_expression(
    root: Option<JsRollConfig>,
    bonus: Vec<JsRollConfig>,
    modifier: f64,
) -> napi::Result<String> {
    check_expression(&check_parts(root, &bonus, modifier)?).map_err(thrown)
}

// ---- sample.ts ----------------------------------------------------------------------------------

type Draw<'a> = Function<'a, f64, f64>;
type Chance<'a> = Function<'a, f64, bool>;

/// `sampleNode(node, rng)`.
#[napi]
pub fn sample_node_json(
    node: String,
    die: Draw<'_>,
    chance: Chance<'_>,
) -> napi::Result<JsRollSample> {
    let node = node_in(&node)?;
    let mut rng = JsRng::new(die, chance);
    let out = sample_node(&node, &mut rng);
    rng.finish(out).map(|s| (&s).into())
}

#[napi(object)]
pub struct JsDieSample {
    pub face: f64,
    pub dice: Vec<JsSampledDie>,
}

/// `sampleDie(die, rng)`.
#[napi]
pub fn sample_die_json(
    die: String,
    draw: Draw<'_>,
    chance: Chance<'_>,
) -> napi::Result<JsDieSample> {
    let die = die_in(&die)?;
    let mut rng = JsRng::new(draw, chance);
    let (face, dice) = sample_die(&die, &mut rng);
    rng.finish(Ok(())).map(|()| JsDieSample {
        face,
        dice: conv::dice_out(&dice),
    })
}

/// `sampleCheckDice(check, rng)`.
#[napi]
pub fn sample_check_dice_of(
    check: &NativeRoll,
    die: Draw<'_>,
    chance: Chance<'_>,
) -> napi::Result<JsCheckDice> {
    let mut rng = JsRng::new(die, chance);
    let out = sample_check_dice(&check.inner, &mut rng);
    rng.finish(out).map(|c| (&c).into())
}

#[napi(object)]
pub struct JsNatural {
    pub index: f64,
    pub face: f64,
}

#[napi(object)]
pub struct JsReadCheck {
    pub naturals: Vec<JsNatural>,
    pub bonus: f64,
    pub rolled: f64,
}

/// `readCheckDice(check, dice)`.
#[napi]
pub fn sample_read_check_dice(
    check: &NativeRoll,
    dice: Vec<JsSampledDie>,
) -> napi::Result<JsReadCheck> {
    let dice: Vec<SampledDie> = dice
        .iter()
        .map(|d| SampledDie {
            sides: d.sides,
            face: d.face,
            kept: d.kept,
            reroll: d.reroll == Some(true),
            miss_reroll: d.miss_reroll == Some(true),
        })
        .collect();
    let read = read_check_dice(&check.inner, &dice).map_err(thrown)?;
    Ok(JsReadCheck {
        naturals: read
            .naturals
            .iter()
            .map(|n| JsNatural {
                index: n.index as f64,
                face: n.face,
            })
            .collect(),
        bonus: read.bonus,
        rolled: read.rolled as f64,
    })
}

// ---- miss-reroll.ts -----------------------------------------------------------------------------

#[napi(object)]
pub struct JsMissRerollOdds {
    pub miss: f64,
    pub hit: f64,
    pub crit: f64,
    pub natural20: f64,
}

/// `missRerollOdds(check, mode, eps)`.
#[napi]
pub fn miss_reroll_odds_of(
    check: &NativeRoll,
    mode: String,
    eps: f64,
) -> napi::Result<JsMissRerollOdds> {
    let odds = miss_reroll_odds(
        &check.inner,
        conv::miss_reroll_mode(&mode).map_err(thrown)?,
        eps,
    )
    .map_err(thrown)?;
    Ok(JsMissRerollOdds {
        miss: odds.miss,
        hit: odds.hit,
        crit: odds.crit,
        natural20: odds.natural20,
    })
}

/// `missRerollCheckExpression(check)`.
#[napi]
pub fn miss_reroll_expression_of(check: &NativeRoll) -> napi::Result<String> {
    miss_reroll_check_expression(&check.inner).map_err(thrown)
}

// ---- reroll-pool.ts -----------------------------------------------------------------------------

#[napi(object)]
pub struct JsPoolDieKind {
    pub values: Vec<f64>,
    pub probs: Vec<f64>,
    pub count: f64,
}

fn kinds_in(list: &[JsPoolDieKind]) -> Vec<PoolDieKind> {
    list.iter()
        .map(|k| PoolDieKind {
            values: k.values.clone(),
            probs: k.probs.clone(),
            count: k.count,
        })
        .collect()
}

/// `rerollUpToPMF(kinds, budget, rolls, eps)`.
#[napi]
pub fn pool_reroll_up_to_pmf(
    kinds: Vec<JsPoolDieKind>,
    budget: f64,
    rolls: f64,
    eps: f64,
) -> napi::Result<NativePmf> {
    reroll_up_to_pmf(&kinds_in(&kinds), budget, rolls, eps)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `rerollUpToPartialPMF(repeated, once, budget, rolls, eps)`.
#[napi]
pub fn pool_reroll_up_to_partial_pmf(
    repeated: Vec<JsPoolDieKind>,
    once: Vec<JsPoolDieKind>,
    budget: f64,
    rolls: f64,
    eps: f64,
) -> napi::Result<NativePmf> {
    reroll_up_to_partial_pmf(&kinds_in(&repeated), &kinds_in(&once), budget, rolls, eps)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `PoolMatch`: each map as `[key, mass, key, mass, ...]` in insertion order.
#[napi(object)]
pub struct JsPoolMatch {
    pub total: Vec<f64>,
    #[napi(js_name = "match")]
    pub matched: Vec<f64>,
}

fn flat_pairs(m: &indexmap::IndexMap<yipe_dice::Damage, f64>) -> Vec<f64> {
    m.iter().flat_map(|(k, v)| [k.0, *v]).collect()
}

/// `rerollUpToMatch(pool, budget, rolls)`: undefined when the pool is too large to enumerate.
#[napi]
pub fn pool_reroll_up_to_match(
    pool: JsPoolDieKind,
    budget: f64,
    rolls: f64,
) -> napi::Result<Option<JsPoolMatch>> {
    let pool = PoolDieKind {
        values: pool.values,
        probs: pool.probs,
        count: pool.count,
    };
    let found = reroll_up_to_match(&pool, budget, rolls).map_err(thrown)?;
    Ok(found.map(|m| JsPoolMatch {
        total: flat_pairs(&m.total),
        matched: flat_pairs(&m.match_),
    }))
}

// ---- d20.ts, prob.ts, arguments.ts --------------------------------------------------------------

/// `d20RollPMF(rollType, rerollOne)`.
#[napi]
pub fn d20_roll_pmf_of(roll_type: Option<String>, reroll_one: bool) -> napi::Result<NativePmf> {
    let roll_type = match roll_type.as_deref() {
        None | Some("") => None,
        Some(s) => Some(RollType::parse(s).ok_or_else(|| err(format!("Invalid roll type: {s}")))?),
    };
    d20_roll_pmf(roll_type, reroll_one)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

/// `d20PMF(rerollOne)`.
#[napi]
pub fn d20_pmf_of(reroll_one: bool) -> napi::Result<NativePmf> {
    d20_pmf(reroll_one).map(NativePmf::wrap).map_err(thrown)
}

/// `d20PmfFromCdf(cdfPow, eps)`.
#[napi]
pub fn prob_d20_pmf_from_cdf(cdf_pow: Function<'_, f64, f64>, eps: f64) -> napi::Result<NativePmf> {
    let failure: RefCell<Option<napi::Error>> = RefCell::new(None);
    let out = d20_pmf_from_cdf(
        |k| {
            if failure.borrow().is_some() {
                return 0.0;
            }
            match cdf_pow.call(k as f64) {
                Ok(v) => v,
                Err(e) => {
                    *failure.borrow_mut() = Some(e);
                    0.0
                }
            }
        },
        eps,
    );
    if let Some(e) = failure.into_inner() {
        return Err(e);
    }
    out.map(NativePmf::wrap).map_err(thrown)
}

#[napi(object)]
pub struct JsSplit {
    pub at_least: f64,
    pub below: f64,
}

/// `splitAtThreshold(pmf, t)`.
#[napi]
pub fn prob_split_at_threshold(pmf: &NativePmf, t: f64) -> JsSplit {
    let s = split_at_threshold(&pmf.inner, t);
    JsSplit {
        at_least: s.at_least,
        below: s.below,
    }
}

// ---- roll-cache-key.ts --------------------------------------------------------------------------

/// A JS value as the facade tags it: `["u"]`, `["z"]`, `["b", bool]`, `["n", num]`, `["s", str]`,
/// `["a", [v...]]`, `["o", [[key, v]...]]`.
fn key_value(v: &Value) -> Result<KeyValue, DiceError> {
    let bad = || DiceError::error("dice-node: invalid tagged value");
    let items = v.as_array().ok_or_else(bad)?;
    let tag = items.first().and_then(Value::as_str).ok_or_else(bad)?;
    let arg = items.get(1);
    Ok(match (tag, arg) {
        ("u", _) => KeyValue::Undefined,
        ("z", _) => KeyValue::Null,
        ("b", Some(Value::Bool(b))) => KeyValue::Bool(*b),
        ("n", Some(n)) => KeyValue::Num(num_of(n)?),
        ("s", Some(Value::String(s))) => KeyValue::Str(s.clone()),
        ("a", Some(Value::Array(list))) => {
            KeyValue::Array(list.iter().map(key_value).collect::<Result<_, _>>()?)
        }
        ("o", Some(Value::Array(list))) => {
            let mut map = indexmap::IndexMap::new();
            for entry in list {
                let pair = entry.as_array().ok_or_else(bad)?;
                let key = pair.first().and_then(Value::as_str).ok_or_else(bad)?;
                map.insert(key.to_string(), key_value(pair.get(1).ok_or_else(bad)?)?);
            }
            KeyValue::Object(map)
        }
        _ => return Err(bad()),
    })
}

fn key_configs(json: &str) -> napi::Result<Vec<KeyValue>> {
    let doc = parse_json(json).map_err(thrown)?;
    match key_value(&doc).map_err(thrown)? {
        KeyValue::Array(list) => Ok(list),
        _ => Err(err("dice-node: configs must be an array".to_string())),
    }
}

/// `rollConfigsKey(configs)` over the tagged encoding of the configs array.
#[napi]
pub fn key_roll_configs(configs: String) -> napi::Result<String> {
    Ok(roll_configs_key(&key_configs(&configs)?))
}

/// `jsonRollKey(configs)` over the tagged encoding of the configs array.
#[napi]
pub fn key_json_roll(configs: String) -> napi::Result<String> {
    Ok(json_roll_key(&key_configs(&configs)?))
}
