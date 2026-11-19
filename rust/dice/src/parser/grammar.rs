//! Port of `src/parser/parser.ts`: the recursive-descent parser over `Dice`.
//!
//! A TS throw is `Err(DiceError)`; `parse` wraps it in a `DiceParseError`. Dice values are cloned where
//! TS shares a reference (nothing is mutated after being shared, so the two are equivalent).

use crate::error::DiceError;
use std::rc::Rc;
use std::sync::Arc;

use indexmap::IndexMap;

use super::dice::{CritTrack, Dice, Dist, Keep, Other, R, js_max, js_min, truthy};
use super::scale_dice::scale_parsed_dice;
use crate::Pmf;
use crate::js::{is_space, num_to_string};
use crate::pmf::cache::PARSE_CACHE;

const MAX_DIE_SIDES: f64 = 1_000_000.0;
const MAX_DICE_COUNT: f64 = 10_000.0;
const MAX_KEEP_WORK: f64 = 100_000_000.0;
const MAX_EXACT_COUNT: f64 = 9_007_199_254_740_991.0;
/// ADR-016: nesting past this is TS's `RangeError: Maximum call stack size exceeded`.
const MAX_DEPTH: usize = 500;

/// The token array (`string[]`) with `shift`.
struct Toks {
    v: Vec<char>,
    pos: usize,
    depth: usize,
}

impl Toks {
    fn new(text: &str) -> Toks {
        Toks {
            v: text.chars().collect(),
            pos: 0,
            depth: 0,
        }
    }

    fn len(&self) -> usize {
        self.v.len() - self.pos
    }

    fn get(&self, i: usize) -> Option<char> {
        self.v.get(self.pos + i).copied()
    }

    fn shift(&mut self) -> Option<char> {
        let c = self.get(0);
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn join(&self) -> String {
        self.v[self.pos..].iter().collect()
    }
}

/// `String(s[i])` for a possibly missing token.
fn show(c: Option<char>) -> String {
    c.map_or_else(|| "undefined".to_string(), |c| c.to_string())
}

/// `text.slice(0, text.length - tokens)`: UTF-16 length minus a code-point count.
fn slice_before(text: &str, tokens: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = units.len() as i64 - tokens as i64;
    let end = if end < 0 {
        (units.len() as i64 + end).max(0)
    } else {
        end.min(units.len() as i64)
    } as usize;
    String::from_utf16_lossy(&units[..end])
}

/// A `Dice | number` value.
enum Val {
    Num(f64),
    Dice(Dice),
}

impl Val {
    fn other(&self) -> Other<'_> {
        match self {
            Val::Num(x) => Other::Num(*x),
            Val::Dice(d) => Other::Dice(d),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Ac,
    Dc,
    Advantage,
    Max,
    Min,
    AddNonZero,
    Add,
    Subtract,
    Combine,
    Reroll,
    ConditionalApply,
    Multiply,
    DivideRoundUp,
    DivideRoundDown,
    Eq,
}

impl Op {
    fn unary(self) -> bool {
        self == Op::Advantage
    }

    fn call(self, d: &Dice, arg: Other) -> R<Dice> {
        match self {
            Op::Ac => d.ac(arg),
            Op::Dc => d.dc(arg),
            Op::Advantage => d.advantage(),
            Op::Max => d.max(arg),
            Op::Min => d.min(arg),
            Op::AddNonZero => d.add_non_zero(arg),
            Op::Add => d.add(arg),
            Op::Subtract => d.subtract(arg),
            Op::Combine => Ok(d.combine(arg)),
            Op::Reroll => Ok(d.reroll(arg)),
            Op::ConditionalApply => d.conditional_apply(arg),
            Op::Multiply => d.multiply(arg),
            Op::DivideRoundUp => d.divide_round_up(arg),
            Op::DivideRoundDown => d.divide_round_down(arg),
            Op::Eq => d.eq(arg),
        }
    }

    fn hit_only(self) -> bool {
        matches!(
            self,
            Op::AddNonZero
                | Op::ConditionalApply
                | Op::Multiply
                | Op::DivideRoundUp
                | Op::DivideRoundDown
        )
    }

    fn is_gate(self) -> bool {
        matches!(self, Op::Ac | Op::Dc)
    }
}

/// `parse(expression)`: [`parse_with`] and `n = 0`.
pub fn parse(expression: &str) -> Result<Pmf, DiceError> {
    parse_with(expression, 0.0)
}

/// `parse(expression, n)` (parser.ts:43). No cache.
pub fn parse_with(expression: &str, n: impl Into<f64>) -> Result<Pmf, DiceError> {
    parse_shared(expression, n.into()).map(|p| (*p).clone())
}

/// [`parse`] through `parseCache` (1000), keyed `{cleaned expression}:{n}`, returning the cached `Arc`.
pub fn parse_shared(expression: &str, n: f64) -> Result<Arc<Pmf>, DiceError> {
    let cleaned: String = expression
        .chars()
        .filter(|c| !is_space(*c))
        .collect::<String>()
        .to_lowercase();
    let key = format!("{cleaned}:{}", num_to_string(n));
    PARSE_CACHE.get_or_compute(Some(&key), || parse_inner(expression, n))
}

fn parse_inner(expression: &str, n: f64) -> Result<Pmf, DiceError> {
    let cleaned: String = expression
        .chars()
        .filter(|c| !is_space(*c))
        .collect::<String>()
        .to_lowercase();
    let mut chars = Toks::new(&cleaned);

    let mut result = match parse_expression_body(&mut chars, n, false) {
        Ok(d) => d,
        Err(error) => {
            return Err(DiceError::dice_parse_of(
                format!(
                    "Cannot parse dice expression [{expression}]: {}",
                    error.js_string()
                ),
                expression,
                Some(error),
            ));
        }
    };
    result.identifier = Some(cleaned);

    if chars.len() > 0 {
        return Err(DiceError::dice_parse_of(
            format!(
                "Unexpected token: '{}' from expression: '{expression}'",
                show(chars.get(0))
            ),
            expression,
            None,
        ));
    }

    let total = result.total();
    if total == 0.0 {
        return Err(DiceError::dice_parse_of(
            format!(
                "Cannot parse dice expression [{expression}]: it has no outcomes (a d0 has no faces; it is only a reroll set, as in `reroll d0`)"
            ),
            expression,
            None,
        ));
    }
    if !total.is_finite() {
        return Err(DiceError::dice_parse_of(
            format!(
                "Cannot parse dice expression [{expression}]: its outcome counts overflow (too many dice combined to count exactly)"
            ),
            expression,
            None,
        ));
    }

    Ok(result.build_pmf(-1.0))
}

fn combine_dice_with_normalization(
    dice: &Dice,
    norm_value: f64,
    outcome_type: &str,
    current_norm: f64,
    final_result: &Dice,
) -> (f64, Dice) {
    let dice = dice.normalize(current_norm);
    let mut result = final_result.normalize(norm_value);
    result.set_outcome_distribution(outcome_type, dice.get_face_map());
    let result = result.combine(Other::Dice(&dice));
    (current_norm * norm_value, result)
}

/// Face-wise histogram difference (counts, not values).
fn subtract_counts(a: &Dice, b: &Dice) -> Dice {
    let mut result = Dice::default();
    for (key, value) in a.get_face_entries() {
        result.increment(key, value);
    }
    for (key, value) in b.get_face_entries() {
        result.increment(key, -value);
    }
    result
}

/// The count of tokens left in `arr` where the last `AC`/`DC` gate at this nesting level starts.
fn last_gate_at(arr: &Toks) -> Option<usize> {
    let mut depth = 0usize;
    let mut at = None;
    for i in 0..arr.len().saturating_sub(1) {
        let c = arr.get(i);
        if c == Some('(') {
            depth += 1;
        } else if c == Some(')') {
            if depth == 0 {
                break;
            }
            depth -= 1;
        } else if depth == 0 && (c == Some('a') || c == Some('d')) && arr.get(i + 1) == Some('c') {
            at = Some(arr.len() - i);
        }
    }
    at
}

fn builds_check(arr: &Toks, in_check: bool, gate: Option<usize>) -> bool {
    in_check || gate.is_some_and(|g| arr.len() > g)
}

/// `+` adds only to a non-zero total, except in a check total, where it always adds.
fn read_operation(arr: &mut Toks, in_check: bool, gate: Option<usize>) -> R<Option<Op>> {
    let check_term = builds_check(arr, in_check, gate);
    let parsed = parse_operation(arr)?;
    Ok(if parsed == Some(Op::AddNonZero) && check_term {
        Some(Op::Add)
    } else {
        parsed
    })
}

// Kept small: every nesting level of a group recurses through this frame, so (in a debug build,
// with no frame slot sharing) every local here costs stack once per level. The per-operator work
// lives in `run_op` and `apply_op`.
fn parse_expression_body(arr: &mut Toks, n: f64, in_check: bool) -> R<Dice> {
    let gate = last_gate_at(arr);
    let bc = builds_check(arr, in_check, gate);
    let first = parse_argument(arr, n, bc)?;
    let mut final_result = start_value(first);
    let mut op_text = implicit_text(&final_result, arr);
    let mut op = read_operation(arr, in_check, gate)?;
    while let Some(cur) = op {
        op = run_op(arr, n, in_check, gate, cur, &mut final_result, &mut op_text)?;
    }
    Ok(final_result)
}

#[inline(never)]
fn start_value(first: Val) -> Dice {
    match first {
        Val::Num(x) => {
            let mut d = Dice::scalar(x);
            d.private_data.no_die = true;
            d
        }
        Val::Dice(d) => d,
    }
}

/// While `final_result` crits with its doubled hit payload, the text of the remaining tokens.
fn implicit_text(final_result: &Dice, arr: &Toks) -> Option<String> {
    final_result
        .private_data
        .implicit_crit
        .as_ref()
        .map(|_| arr.join())
}

/// One loop iteration: parse the operator's argument, apply it, read the next operator.
fn run_op(
    arr: &mut Toks,
    n: f64,
    in_check: bool,
    gate: Option<usize>,
    cur: Op,
    final_result: &mut Dice,
    op_text: &mut Option<String>,
) -> R<Option<Op>> {
    let pending = pending_text(cur, final_result, arr);
    let arg = if !cur.unary() {
        let bc = builds_check(arr, in_check, gate);
        parse_argument(arr, n, bc)
    } else {
        Ok(Val::Dice(final_result.clone()))
    };
    finish_op(
        arr,
        n,
        in_check,
        gate,
        cur,
        final_result,
        op_text,
        arg,
        pending,
    )
}

#[inline(never)]
fn pending_text(cur: Op, final_result: &Dice, arr: &Toks) -> Option<String> {
    if cur == Op::ConditionalApply && final_result.private_data.is_ac_check {
        Some(arr.join())
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn finish_op(
    arr: &mut Toks,
    n: f64,
    in_check: bool,
    gate: Option<usize>,
    cur: Op,
    final_result: &mut Dice,
    op_text: &mut Option<String>,
    arg: R<Val>,
    pending: Option<String>,
) -> R<Option<Op>> {
    apply_op(
        arr,
        n,
        cur,
        final_result,
        &arg?,
        pending,
        op_text.as_deref(),
    )?;
    *op_text = implicit_text(final_result, arr);
    read_operation(arr, in_check, gate)
}

/// One operator's work, after its argument is parsed. Kept out of `parse_operations` so the
/// recursion (which only goes through argument parsing there) stays in small frames.
#[inline(never)]
fn apply_op(
    arr: &mut Toks,
    n: f64,
    cur: Op,
    final_slot: &mut Dice,
    arg: &Val,
    pending: Option<String>,
    op_text: Option<&str>,
) -> R<()> {
    let mut final_result = std::mem::take(final_slot);
    let hit_text = pending.map(|p| slice_before(&p, arr.len()));
    let term_text = op_text.map(|t| slice_before(t, arr.len()));
    let before = final_result.clone();
    let attack = is_attack(&final_result);
    let ac_check = final_result.private_data.is_ac_check;
    if cur == Op::Combine {
        assert_mixable(&before, arg.other(), arr)?;
    }

    // crit
    let mut crit: Option<Dice> = None;
    let mut crit_norm = 1.0;
    let crit_clause = arr.get(0) == Some('x') || arr.get(0) == Some('c');
    let implicit_crit = !crit_clause && hit_text.is_some() && !final_result.private_data.no_die;
    if crit_clause || implicit_crit {
        let mut count = 1.0;
        if crit_clause {
            let is_xcrit = arr.get(0) == Some('x');
            if is_xcrit {
                assert_token(arr, "x")?;
            }
            assert_token(arr, "c")?;
            assert_token(arr, "r")?;
            assert_token(arr, "i")?;
            assert_token(arr, "t")?;
            if is_xcrit {
                count = parse_number(arr, n)?;
            }
        }

        if final_result.private_data.no_die {
            parse_binary_argument(arg.other(), arr, n)?;
        } else {
            let (c, rest) = split_crit(&final_result, count)?;
            final_result = rest;
            crit_norm = c.total();
            let crit_arg = if crit_clause {
                parse_binary_argument(arg.other(), arr, n)?
            } else {
                crit_payload(hit_text.as_deref().unwrap_or_default(), n)?
            };
            let applied = if cur.hit_only() {
                apply_to_landed(&c, cur, Other::Dice(&crit_arg), c.get(0.0), ac_check)?
            } else {
                cur.call(&c, Other::Dice(&crit_arg))?
            };
            crit_norm = if truthy(crit_norm) {
                applied.total() / crit_norm
            } else {
                1.0
            };
            crit = Some(applied);
        }
    }

    // save
    let mut save: Option<Dice> = None;
    let mut save_norm = 1.0;
    if arr.get(0) == Some('s') {
        assert_token(arr, "s")?;
        assert_token(arr, "a")?;
        assert_token(arr, "v")?;
        assert_token(arr, "e")?;
        let (missed, rest) = split_miss(&final_result, attack)?;
        final_result = rest;
        save_norm = missed.total();
        let barg = parse_binary_argument(arg.other(), arr, n)?;
        let s = cur.call(&missed, Other::Dice(&barg))?;
        save_norm = if truthy(save_norm) {
            s.total() / save_norm
        } else {
            1.0
        };
        save = Some(s);
    }

    // potent cantrip
    let mut pc: Option<Dice> = None;
    let mut pc_norm = 1.0;
    if arr.len() >= 2 && arr.get(0) == Some('p') && arr.get(1) == Some('c') {
        assert_token(arr, "p")?;
        assert_token(arr, "c")?;
        let (missed, rest) = split_miss(&final_result, attack)?;
        final_result = rest;
        let miss_before = missed.total();
        let barg = parse_binary_argument(arg.other(), arr, n)?;
        let p = cur
            .call(&missed, Other::Dice(&barg))?
            .divide_round_down(Other::Num(2.0))?;
        let miss_after = p.total();
        pc_norm = if truthy(miss_before) {
            miss_after / miss_before
        } else {
            1.0
        };
        pc = Some(p);
    }

    // miss
    let mut miss: Option<Dice> = None;
    let mut miss_norm = 1.0;
    if arr.get(0) == Some('m') {
        assert_token(arr, "m")?;
        assert_token(arr, "i")?;
        assert_token(arr, "s")?;
        assert_token(arr, "s")?;
        let (missed, rest) = split_miss(&final_result, attack)?;
        final_result = rest;
        miss_norm = missed.total();
        let barg = parse_binary_argument(arg.other(), arr, n)?;
        let m = cur.call(&missed, Other::Dice(&barg))?;
        miss_norm = if truthy(miss_norm) {
            m.total() / miss_norm
        } else {
            1.0
        };
        miss = Some(m);
    }

    let mut norm = final_result.total();

    let clause = crit.is_some() || save.is_some() || pc.is_some() || miss.is_some();
    let labelled = has_outcome_labels(Other::Dice(&final_result));
    let operand = std::mem::take(&mut final_result);
    final_result = if !clause && labelled && cur.hit_only() {
        apply_by_outcome(&operand, cur, arg.other(), term_text.as_deref(), n)?
    } else if cur.hit_only() {
        apply_to_landed(
            &operand,
            cur,
            arg.other(),
            landed_at_zero(Other::Dice(&operand)),
            ac_check,
        )?
    } else {
        cur.call(&operand, arg.other())?
    };
    if operand.private_data.is_dc_check && cur.hit_only() {
        let faces = cur
            .call(&operand.delete_face(0.0), arg.other())?
            .get_face_map();
        final_result.set_outcome_distribution("saveFail", faces);
    }
    if attack && cur.hit_only() {
        final_result.private_data.attack_payload = true;
        let landed = landed_hits_at_zero(&operand, cur, arg.other(), ac_check)?;
        if landed > 0.0 {
            final_result.set_outcome_distribution("hit", Dist::single(0.0, landed));
        }
    } else if let (Op::Combine, Val::Dice(a)) = (cur, &arg) {
        if a.private_data.attack_payload {
            final_result.private_data.attack_payload = true;
        }
        let landed = landed_at_zero(Other::Dice(&operand)) + landed_at_zero(Other::Dice(a));
        if landed > 0.0 {
            final_result.set_outcome_distribution("hit", Dist::single(0.0, landed));
        }
    }
    let gated = matches!((cur, &arg), (Op::Combine, Val::Dice(a)) if a.private_data.is_ac_check);
    if cur == Op::Ac || gated {
        final_result.private_data.is_ac_check = true;
    }
    follow_natural_roll(&before, cur, arg.other(), &mut final_result, clause)?;
    norm = if truthy(norm) {
        final_result.total() / norm
    } else {
        1.0
    };

    for (part, part_norm, label) in [
        (&crit, crit_norm, "crit"),
        (&save, save_norm, "saveHalf"),
        (&miss, miss_norm, "missDamage"),
        (&pc, pc_norm, "pc"),
    ] {
        if let Some(d) = part {
            let (new_norm, updated) =
                combine_dice_with_normalization(d, part_norm, label, norm, &final_result);
            norm = new_norm;
            final_result = updated;
        }
    }

    if implicit_crit {
        final_result
            .private_data
            .implicit_crit
            .clone_from(&hit_text);
    }
    *final_slot = final_result;
    Ok(())
}

/// The size of `value`'s natural die; 0 with no die.
fn natural_sides(value: Other) -> f64 {
    match value {
        Other::Num(_) => 0.0,
        Other::Dice(d) => match &d.private_data.crit_track {
            Some(t) => t.sides,
            None => d.private_data.untracked_sides.unwrap_or(0.0),
        },
    }
}

fn outranks(sides: f64, other: f64) -> bool {
    if sides == other {
        return false;
    }
    if sides == 20.0 || other == 20.0 {
        return sides == 20.0;
    }
    sides > other
}

/// A check that is its natural roll itself: face f's share is its own count at f.
fn bare_track(die: &Dice) -> R<CritTrack> {
    let sides = die.max_face()?;
    let faces = die.get_face_map();
    Ok(CritTrack {
        sides,
        bare: true,
        slice: Rc::new(move |face| {
            let mut slice = Dice::default();
            let weight = faces.get(face).unwrap_or(0.0);
            if truthy(weight) {
                slice.set_face(face, weight);
            }
            Ok(slice)
        }),
    })
}

/// A number operand as a value: a die-less branch of an `&` mix.
fn as_value(value: Other) -> Dice {
    match value {
        Other::Dice(d) => d.clone(),
        Other::Num(x) => {
            let mut scalar = Dice::scalar(x);
            scalar.private_data.no_die = true;
            scalar
        }
    }
}

fn branches_of(value: Other) -> Vec<Dice> {
    match value {
        Other::Num(_) => vec![as_value(value)],
        Other::Dice(d) => match &d.private_data.branches {
            Some(b) => (**b).clone(),
            None => vec![d.clone()],
        },
    }
}

fn has_outcome_labels(value: Other) -> bool {
    match value {
        Other::Num(_) => false,
        Other::Dice(d) => d.outcomes().keys().any(|label| label != "hit"),
    }
}

fn is_save(value: Other) -> bool {
    matches!(value, Other::Dice(d) if d.private_data.is_dc_check)
}

fn is_attack(value: &Dice) -> bool {
    !value.private_data.is_dc_check
        && (value.private_data.is_ac_check || value.private_data.attack_payload)
}

fn landed_at_zero(value: Other) -> f64 {
    match value {
        Other::Num(_) => 0.0,
        Other::Dice(d) => d.get_outcome_count("hit", 0.0),
    }
}

fn apply_to_landed(value: &Dice, op: Op, arg: Other, landed: f64, gate: bool) -> R<Dice> {
    let lands = op == Op::AddNonZero || (gate && op == Op::ConditionalApply);
    if landed.is_nan() || landed <= 0.0 || !lands {
        return op.call(value, arg);
    }
    let mut misses = value.delete_face(0.0);
    let missed = value.get(0.0) - landed;
    if missed > 0.0 {
        misses.set_face(0.0, missed);
    }
    let mut result = op.call(&misses, arg)?;
    result.combine_in_place(&as_value(arg).normalize(landed));
    Ok(result)
}

fn apply_to_attack(value: &Dice, op: Op, arg: Other, gate: bool) -> R<Dice> {
    let mut result = apply_to_landed(value, op, arg, landed_at_zero(Other::Dice(value)), gate)?;
    result.private_data.attack_payload = true;
    let landed = landed_hits_at_zero(value, op, arg, gate)?;
    if landed > 0.0 {
        result.set_outcome_distribution("hit", Dist::single(0.0, landed));
    }
    Ok(result)
}

fn split_miss(check: &Dice, attack: bool) -> R<(Dice, Dice)> {
    let face = if attack { 0.0 } else { check.min_face()? };
    let landed = if face == 0.0 {
        landed_at_zero(Other::Dice(check))
    } else {
        0.0
    };
    let mut miss = Dice::default();
    miss.increment(
        if face > 0.0 { face } else { 1.0 },
        check.get(face) - landed,
    );
    let mut rest = check.delete_face(face);
    if landed > 0.0 {
        rest.set_face(0.0, landed);
    }
    Ok((miss, rest))
}

fn assert_mixable(left: &Dice, right: Other, rest: &Toks) -> R<()> {
    if has_outcome_labels(Other::Dice(left)) || has_outcome_labels(right) {
        return Err(DiceError::error(
            "an `&` mix of an attack already split into crit, miss or save outcomes has no single reading: mix the checks before the payload, like `((d20 AC 10) & (d20 AC 15)) * (1d6)`",
        ));
    }
    if is_save(Other::Dice(left)) != is_save(right) {
        return Err(DiceError::error(
            "an `&` mix of a saving throw (DC) with anything but another saving throw has no single set of outcomes",
        ));
    }
    let next = rest.get(0);
    let after = rest.get(1);
    if matches!(next, Some('x' | 'c' | 's' | 'm')) || (next == Some('p') && after == Some('c')) {
        return Err(DiceError::error(
            "a crit, save, pc or miss clause on an `&` mix has no single reading: put it after the payload's `*`",
        ));
    }
    Ok(())
}

/// Record on `after = op(before, arg)` the natural roll a crit is read from (parser.ts:521).
fn follow_natural_roll(before: &Dice, op: Op, arg: Other, after: &mut Dice, clause: bool) -> R<()> {
    {
        let data = &mut after.private_data;
        data.crit_track = None;
        data.untracked_sides = None;
        data.no_die = false;
        data.branches = None;
    }
    let gate = op.is_gate();
    let arg_no_die = match arg {
        Other::Num(_) => true,
        Other::Dice(d) => d.private_data.no_die,
    };
    if !clause && before.private_data.no_die && (gate || arg_no_die) {
        after.private_data.no_die = true;
    }

    let arg_branches = matches!(arg, Other::Dice(d) if d.private_data.branches.is_some());
    let mixed = before.private_data.branches.is_some() || (!gate && arg_branches);
    if !clause && op == Op::Combine {
        let mut all = branches_of(Other::Dice(before));
        all.extend(branches_of(arg));
        after.private_data.branches = Some(Rc::new(all));
    } else if !clause && mixed && op != Op::Reroll {
        let advantage = op == Op::Advantage;
        let pair_op = if advantage { Op::Max } else { op };
        let lefts = branches_of(Other::Dice(before));
        let rights = if advantage {
            lefts.clone()
        } else if gate {
            vec![as_value(arg)]
        } else {
            branches_of(arg)
        };
        let mut out = Vec::new();
        for left in &lefts {
            for right in &rights {
                let mut part = if pair_op.hit_only() && is_attack(left) {
                    apply_to_attack(
                        left,
                        pair_op,
                        Other::Dice(right),
                        left.private_data.is_ac_check,
                    )?
                } else {
                    pair_op.call(left, Other::Dice(right))?
                };
                follow_natural_roll(left, pair_op, Other::Dice(right), &mut part, false)?;
                out.push(part);
            }
        }
        after.private_data.branches = Some(Rc::new(out));
    }
    if let Some(branches) = after.private_data.branches.clone() {
        mix_natural_rolls(after, &branches);
        return Ok(());
    }

    let track = before.private_data.crit_track.clone();
    let arg_track = match arg {
        Other::Dice(d) if !gate => d.private_data.crit_track.clone(),
        _ => None,
    };
    let sides = natural_sides(Other::Dice(before));
    let arg_sides = if gate { 0.0 } else { natural_sides(arg) };
    let extremum = op == Op::Max || op == Op::Min;
    let own = track.is_some() && outranks(sides, arg_sides);
    let followed = if own {
        track.clone()
    } else if arg_track.is_some() && outranks(arg_sides, sides) {
        arg_track.clone()
    } else {
        None
    };
    let track_bare = track.as_ref().is_some_and(|t| t.bare);
    let arg_bare = arg_track.as_ref().is_some_and(|t| t.bare);

    if clause {
        // A clause leaves no natural roll: untracked below.
    } else if op == Op::Advantage || op == Op::Reroll {
        if track_bare {
            after.private_data.crit_track = Some(Rc::new(bare_track(after)?));
        }
    } else if extremum && track_bare && arg_bare && sides == arg_sides {
        after.private_data.crit_track = Some(Rc::new(bare_track(after)?));
    } else if let Some(followed) = followed {
        let attack = op.hit_only() && is_attack(before);
        let gated = before.private_data.is_ac_check;
        let before_c = before.clone();
        let arg_c: Val = match arg {
            Other::Num(x) => Val::Num(x),
            Other::Dice(d) => Val::Dice(d.clone()),
        };
        let slice_sides = followed.sides;
        let call = move |value: &Dice, other: Other| -> R<Dice> {
            if attack {
                apply_to_attack(value, op, other, gated)
            } else {
                op.call(value, other)
            }
        };
        let apply = move |value: &Dice| -> R<Dice> {
            if own {
                call(value, arg_c.other())
            } else {
                call(&before_c, Other::Dice(value))
            }
        };
        after.private_data.crit_track = Some(Rc::new(CritTrack {
            sides: slice_sides,
            bare: false,
            slice: Rc::new(move |face| {
                let slice = (followed.slice)(face)?;
                if extremum {
                    kept_part(&slice, &apply)
                } else {
                    apply(&slice)
                }
            }),
        }));
    }
    if after.private_data.crit_track.is_none() {
        let top = if outranks(arg_sides, sides) {
            arg_sides
        } else {
            sides
        };
        if top > 0.0 {
            after.private_data.untracked_sides = Some(top);
        }
    }
    Ok(())
}

/// The natural roll of an `&` mix `after` of `branches`.
fn mix_natural_rolls(after: &mut Dice, branches: &[Dice]) {
    let sides = branches.iter().fold(0.0, |top, branch| {
        let s = natural_sides(Other::Dice(branch));
        if outranks(s, top) { s } else { top }
    });
    if sides == 0.0 {
        return;
    }
    let mut tracks: Vec<Rc<CritTrack>> = Vec::new();
    for branch in branches {
        if natural_sides(Other::Dice(branch)) != sides {
            continue;
        }
        match &branch.private_data.crit_track {
            None => {
                after.private_data.untracked_sides = Some(sides);
                return;
            }
            Some(t) => tracks.push(t.clone()),
        }
    }
    let bare = tracks.len() == branches.len() && tracks.iter().all(|t| t.bare);
    after.private_data.crit_track = Some(Rc::new(CritTrack {
        sides,
        bare,
        slice: Rc::new(move |face| {
            let mut slice = Dice::default();
            let mut landed = 0.0;
            for track in &tracks {
                let part = (track.slice)(face)?;
                slice.combine_in_place(&part);
                landed += landed_at_zero(Other::Dice(&part));
            }
            if landed > 0.0 {
                slice.set_outcome_distribution("hit", Dist::single(0.0, landed));
            }
            Ok(slice)
        }),
    }));
}

fn kept_part(slice: &Dice, apply: &dyn Fn(&Dice) -> R<Dice>) -> R<Dice> {
    let mut result = Dice::default();
    for (value, count) in slice.get_face_entries() {
        let mut face = Dice::default();
        face.set_face(value, count);
        let kept = apply(&face)?.get(value);
        if truthy(kept) {
            result.increment(value, kept);
        }
    }
    Ok(result)
}

/// Split an attack check's crit mass off `check` (parser.ts:650).
fn split_crit(check: &Dice, count: f64) -> R<(Dice, Dice)> {
    if count == 0.0 {
        let none = Dice::default();
        let mut rest = subtract_counts(check, &none);
        let landed = landed_at_zero(Other::Dice(check));
        if landed > 0.0 {
            rest.set_outcome_distribution("hit", Dist::single(0.0, landed));
        }
        return Ok((none, rest));
    }
    let Some(track) = check.private_data.crit_track.clone() else {
        return Err(DiceError::error(
            "crit rate cannot be computed exactly for this attack check: its natural roll is not one die (a dice-valued check like 2d20 or 2kh2d20, two d20s like d20 + d20, or advantage over a total). Build the attack with the builder API instead.",
        ));
    };
    let sides = track.sides;
    if count > sides {
        return Err(DiceError::error(format!(
            "xcrit{} is wider than the d{} it reads its natural roll from",
            num_to_string(count),
            num_to_string(sides)
        )));
    }
    let mut crit = Dice::default();
    let mut landed = 0.0;
    let mut face = sides;
    while face > sides - count {
        let slice = (track.slice)(face)?;
        crit.combine_in_place(&slice);
        landed += landed_at_zero(Other::Dice(&slice));
        face -= 1.0;
    }
    let mut rest = subtract_counts(check, &crit);
    let missed = crit.get(0.0) - landed;
    if truthy(missed) {
        crit = crit.delete_face(0.0);
        if landed > 0.0 {
            crit.set_face(0.0, landed);
        }
        rest.increment(0.0, missed);
    }
    let rest_landed = landed_at_zero(Other::Dice(check)) - landed;
    if rest_landed > 0.0 {
        rest.set_outcome_distribution("hit", Dist::single(0.0, rest_landed));
    }
    Ok((crit, rest))
}

fn crit_payload(text: &str, n: f64) -> R<Dice> {
    let replaced = text.replace('n', &num_to_string(n));
    let doubled = match scale_parsed_dice(&replaced, 2.0) {
        Ok(s) => s,
        // UndoubleableExpressionError is swallowed; AmbiguousCritDoublingError (and anything
        // else) is rethrown.
        Err(DiceError::UndoubleableExpression(_)) => text.to_string(),
        Err(error) => return Err(error),
    };
    let mut chars = Toks::new(&doubled);
    let payload = parse_expression_body(&mut chars, n, false)?;
    if chars.len() > 0 {
        return Err(DiceError::error(format!(
            "Unexpected token '{}' in the crit payload '{doubled}'",
            show(chars.get(0))
        )));
    }
    Ok(payload)
}

fn is_payload_outcome(label: &str) -> bool {
    matches!(
        label,
        "crit" | "missDamage" | "pc" | "saveFail" | "saveHalf"
    )
}

fn apply_by_outcome(
    labelled: &Dice,
    op: Op,
    arg: Other,
    term_text: Option<&str>,
    n: f64,
) -> R<Dice> {
    let implicit = labelled.private_data.implicit_crit.clone();
    let arg_total = match arg {
        Other::Num(_) => 1.0,
        Other::Dice(d) => d.total(),
    };
    let mut result = Dice::default();
    let mut rest = labelled.clone();
    let mut payload: Option<String> = None;
    let entries: Vec<(String, Dist)> = labelled
        .outcomes()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (label, distribution) in &entries {
        if label == "hit" {
            continue;
        }
        let mut part = Dice::default();
        for (face, count) in distribution.entries() {
            part.increment(face, count);
        }
        rest = subtract_counts(&rest, &part);
        let applied = if let (true, Some(imp), Some(term)) =
            (label == "crit", implicit.as_ref(), term_text)
        {
            let p = format!("{imp}{}{term}", if op == Op::AddNonZero { "~" } else { "" });
            let doubled = crit_payload(&p, n)?;
            payload = Some(p);
            doubled.normalize((part.total() * arg_total) / doubled.total())
        } else if is_payload_outcome(label) {
            apply_to_landed(&part, op, arg, part.get(0.0), false)?
        } else {
            op.call(&part, arg)?
        };
        result.combine_in_place(&applied);
        result.set_outcome_distribution(label, applied.get_face_map());
    }
    result.combine_in_place(&apply_to_landed(
        &rest,
        op,
        arg,
        landed_at_zero(Other::Dice(labelled)),
        false,
    )?);
    if labelled.private_data.is_dc_check {
        result.private_data.is_dc_check = true;
    }
    if payload.is_some() {
        result.private_data.implicit_crit = payload;
    }
    Ok(result)
}

fn landed_hits_at_zero(operand: &Dice, op: Op, arg: Other, gate: bool) -> R<f64> {
    let mut landed = 0.0;
    for (face, count) in operand.calculate_hit_distribution().entries() {
        if count.is_nan() || count <= 0.0 {
            continue;
        }
        let mut hit = Dice::default();
        hit.set_face(face, count);
        let l = if face == 0.0 { count } else { 0.0 };
        landed += apply_to_landed(&hit, op, arg, l, gate)?.get(0.0);
    }
    Ok(landed)
}

fn parse_argument(s: &mut Toks, n: f64, in_check: bool) -> R<Val> {
    if s.get(0) == Some('-') {
        return parse_negated(s, n, in_check);
    }
    let Some(result) = parse_argument_internal(s, n, in_check)? else {
        return Err(expected_argument(s));
    };
    parse_repeat_chain(s, n, in_check, result)
}

#[inline(never)]
fn expected_argument(s: &Toks) -> DiceError {
    let at = if s.len() == 0 {
        "the end of the expression".to_string()
    } else {
        let head: String = s.v[s.pos..].iter().take(20).collect();
        format!("'{head}'")
    };
    DiceError::error(format!("Expected a number, a die, a keep or '(' at {at}"))
}

fn parse_repeat_chain(s: &mut Toks, n: f64, in_check: bool, result: Val) -> R<Val> {
    let mut result = result;
    loop {
        let next = parse_argument_internal(s, n, in_check);
        let (merged, more) = repeat_step(result, next)?;
        result = merged;
        if !more {
            return Ok(result);
        }
    }
}

/// Folds one more repeat factor in; `false` when there was none.
#[inline(never)]
fn repeat_step(result: Val, next: R<Option<Val>>) -> R<(Val, bool)> {
    match next? {
        Some(next) => Ok((Val::Dice(multiply_dice_by_dice(result, next)?), true)),
        None => Ok((result, false)),
    }
}

fn parse_negated(s: &mut Toks, n: f64, in_check: bool) -> R<Val> {
    s.shift();
    let operand = parse_argument(s, n, in_check);
    finish_negated(operand)
}

#[inline(never)]
fn finish_negated(operand: R<Val>) -> R<Val> {
    let operand = match operand? {
        Val::Num(x) => return Ok(Val::Num(0.0 - x)),
        Val::Dice(d) => d,
    };
    let zero = as_value(Other::Num(0.0));
    let mut negated = zero.subtract(Other::Dice(&operand))?;
    follow_natural_roll(
        &zero,
        Op::Subtract,
        Other::Dice(&operand),
        &mut negated,
        false,
    )?;
    Ok(Val::Dice(negated))
}

fn multiply_dice_by_dice(d1: Val, d2: Val) -> R<Dice> {
    let no_die_of = |v: &Val| match v {
        Val::Num(_) => true,
        Val::Dice(d) => d.private_data.no_die,
    };
    let no_die = no_die_of(&d1) && no_die_of(&d2);
    let d1 = match d1 {
        Val::Num(x) => Dice::scalar(x),
        Val::Dice(d) => d,
    };
    let d2 = match d2 {
        Val::Num(x) => Dice::scalar(x),
        Val::Dice(d) => d,
    };

    let mut result = Dice::default();
    let mut faces: Vec<(f64, Dice)> = Vec::new();
    let mut common = 1.0;

    let keep = d2.private_data.keep;
    for key in d1.keys() {
        let face = match keep {
            Some(k) => keep_dice(&d2, key, k)?,
            None => multiply_dice(key, &d2)?,
        };
        common *= face.total();
        faces.push((key, face));
    }

    let exact = common <= MAX_EXACT_COUNT;
    for (k, face) in &faces {
        let count = d1.get(*k);
        result.combine_in_place(
            &face.normalize(((if exact { common } else { 1.0 }) * count) / face.total()),
        );
    }

    let keys = d1.keys();
    let only = keys.first().copied();
    let more = keys.len().saturating_sub(1);
    let rolls = match keep {
        None => only,
        Some(k) => only.map(|o| js_min(o, k.kept)),
    };
    let s2 = natural_sides(Other::Dice(&d2));
    let s1 = natural_sides(Other::Dice(&d1));
    let sides = if outranks(s2, s1) { s2 } else { s1 };
    let crit_bare = d2.private_data.crit_track.as_ref().is_some_and(|t| t.bare);
    if rolls == Some(1.0) && more == 0 && crit_bare {
        result.private_data.crit_track = Some(Rc::new(bare_track(&result)?));
    } else if sides > 0.0 {
        result.private_data.untracked_sides = Some(sides);
    }
    if no_die {
        result.private_data.no_die = true;
    }
    Ok(result)
}

fn assert_repeat_count(n: f64) -> R<()> {
    if !(n.is_finite() && n.fract() == 0.0) || n < 0.0 {
        return Err(DiceError::dice_parse(format!(
            "A repeat count must be a whole number of 0 or more; this one is {}",
            num_to_string(n)
        )));
    }
    if n > MAX_DICE_COUNT {
        return Err(DiceError::dice_parse(format!(
            "Dice count {} exceeds the maximum of {}",
            num_to_string(n),
            num_to_string(MAX_DICE_COUNT)
        )));
    }
    Ok(())
}

fn multiply_dice(n: f64, d: &Dice) -> R<Dice> {
    assert_repeat_count(n)?;
    if n == 0.0 {
        return Ok(Dice::scalar(0.0));
    }
    if n == 1.0 {
        return Ok(d.clone());
    }
    let half = (n / 2.0).floor();
    let mut result = multiply_dice(half, d)?;
    result = result.add(Other::Dice(&result))?;
    if n % 2.0 == 1.0 {
        result = result.add(Other::Dice(d))?;
    }
    let total = result.total();
    Ok(if total > MAX_EXACT_COUNT {
        result.normalize(1.0 / total)
    } else {
        result
    })
}

type Sums = IndexMap<crate::Damage, f64>;

fn add_to(map: &mut Sums, key: f64, p: f64) {
    *map.entry(crate::Damage(key)).or_insert(0.0) += p;
}

/// The sum of the `kept` highest (or lowest) of `count` independent copies of `die`.
fn keep_dice(die: &Dice, count: f64, keep: Keep) -> R<Dice> {
    let Keep { kept, lowest } = keep;
    assert_repeat_count(count)?;
    if kept >= count {
        return multiply_dice(count, die);
    }
    if kept <= 0.0 {
        return Ok(Dice::scalar(0.0));
    }

    let mut faces: Vec<(f64, f64)> = die
        .get_face_entries()
        .into_iter()
        .filter(|(_, w)| *w > 0.0)
        .collect();
    faces.sort_by(|(a, _), (b, _)| {
        let d = if lowest { a - b } else { b - a };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    if faces.is_empty() {
        return Ok(Dice::default());
    }
    let span = (faces[faces.len() - 1].0 - faces[0].0).abs();
    let kf = kept;
    let work = faces.len() as f64 * kf * kf * (kf * span + 1.0);
    if work > MAX_KEEP_WORK {
        return Err(DiceError::dice_parse(format!(
            "Keep of {} of {} copies of a {}-face roll exceeds the maximum work of {}",
            num_to_string(kept),
            num_to_string(count),
            faces.len(),
            num_to_string(MAX_KEEP_WORK)
        )));
    }
    if kept.is_nan() || kept.fract() != 0.0 {
        return Err(DiceError::type_error(
            "Cannot read properties of undefined (reading 'set')",
        ));
    }
    let kept_n = kept as usize;

    let mut tails = vec![0.0; faces.len()];
    let mut tail = 0.0;
    for i in (0..faces.len()).rev() {
        tail += faces[i].1;
        tails[i] = tail;
    }

    let mut states: Vec<Sums> = (0..kept_n).map(|_| Sums::new()).collect();
    states[0].insert(crate::Damage(0.0), 1.0);
    let mut done = Sums::new();

    for (i, (value, weight)) in faces.iter().enumerate() {
        let q = weight / tails[i];
        let mut next: Vec<Sums> = (0..kept_n).map(|_| Sums::new()).collect();
        for (placed, sums) in states.iter().enumerate() {
            if sums.is_empty() {
                continue;
            }
            let left = count - placed as f64;
            let need = kept_n - placed;
            let mut few: Vec<f64> = Vec::new();
            let mut log_choose = 0.0f64;
            for c in 0..need {
                let cf = c as f64;
                if c > 0 {
                    log_choose += ((left - cf + 1.0) / cf).ln();
                }
                few.push(if q >= 1.0 {
                    0.0
                } else {
                    (log_choose + cf * q.ln() + (left - cf) * (-q).ln_1p()).exp()
                });
            }
            let enough = js_max(0.0, 1.0 - few.iter().fold(0.0, |t, p| t + p));
            for (sum, p) in sums {
                for (c, pc) in few.iter().enumerate() {
                    if *pc > 0.0 {
                        add_to(&mut next[placed + c], sum.0 + c as f64 * value, p * pc);
                    }
                }
                if enough > 0.0 {
                    add_to(&mut done, sum.0 + need as f64 * value, p * enough);
                }
            }
        }
        states = next;
    }

    let mut result = Dice::default();
    for (sum, p) in &done {
        result.increment(sum.0, *p);
    }
    Ok(result)
}

fn parse_argument_internal(s: &mut Toks, n: f64, in_check: bool) -> R<Option<Val>> {
    let Some(c) = s.get(0) else {
        return Ok(None);
    };
    match c {
        '(' => parse_group(s, n, in_check),
        'h' | 'd' => parse_die_arg(s, n),
        'k' => parse_keep_arg(s, n, in_check),
        'n' => parse_number_arg(s, n),
        c if is_digit(c) => parse_number_arg(s, n),
        _ => Ok(None),
    }
}

fn parse_group(s: &mut Toks, n: f64, in_check: bool) -> R<Option<Val>> {
    s.shift();
    s.depth += 1;
    let inner = if s.depth > MAX_DEPTH {
        Err(depth_error())
    } else {
        parse_expression_body(s, n, in_check)
    };
    s.depth -= 1;
    finish_group(s, inner)
}

#[inline(never)]
fn depth_error() -> DiceError {
    DiceError::stack_overflow()
}

#[inline(never)]
fn finish_group(s: &mut Toks, inner: R<Dice>) -> R<Option<Val>> {
    let inner = inner?;
    assert_token(s, ")")?;
    Ok(Some(Val::Dice(inner)))
}

#[inline(never)]
fn parse_die_arg(s: &mut Toks, n: f64) -> R<Option<Val>> {
    Ok(parse_dice(s, n)?.map(Val::Dice))
}

fn parse_keep_arg(s: &mut Toks, n: f64, in_check: bool) -> R<Option<Val>> {
    let keep = match read_keep(s, n) {
        Ok(Some(keep)) => keep,
        Ok(None) => return Ok(None),
        Err(e) => return Err(e),
    };
    let inner = parse_argument_internal(s, n, in_check);
    finish_keep(inner, keep)
}

/// `k` then `l`/`h` and the kept count; `None` when neither letter follows.
#[inline(never)]
fn read_keep(s: &mut Toks, n: f64) -> R<Option<Keep>> {
    assert_token(s, "k")?;
    let lowest = if peek(s, "l") {
        assert_token(s, "l")?;
        true
    } else if peek(s, "h") {
        assert_token(s, "h")?;
        false
    } else {
        return Ok(None);
    };
    Ok(Some(Keep {
        kept: parse_number(s, n)?,
        lowest,
    }))
}

#[inline(never)]
fn finish_keep(inner: R<Option<Val>>, keep: Keep) -> R<Option<Val>> {
    match inner? {
        Some(Val::Dice(mut result)) => {
            result.private_data.keep = Some(keep);
            Ok(Some(Val::Dice(result)))
        }
        _ => Err(DiceError::error("Expected Dice after keep modifier")),
    }
}

#[inline(never)]
fn parse_number_arg(s: &mut Toks, n: f64) -> R<Option<Val>> {
    Ok(Some(Val::Num(parse_number(s, n)?)))
}

fn parse_binary_argument(arg: Other, arr: &mut Toks, n: f64) -> R<Dice> {
    if arr.len() >= 4 && arr.get(0) == Some('h') && peek(arr, "half") {
        assert_token(arr, "half")?;
        let dice_arg = match arg {
            Other::Num(x) => Dice::scalar(x),
            Other::Dice(d) => d.clone(),
        };
        return dice_arg.divide_round_down(Other::Num(2.0));
    }
    Ok(match parse_argument(arr, n, false)? {
        Val::Num(x) => Dice::scalar(x),
        Val::Dice(d) => d,
    })
}

fn assert_token(s: &mut Toks, expected: &str) -> R<()> {
    for ch in expected.chars() {
        let found = s.shift();
        if found != Some(ch) {
            return Err(DiceError::error(format!(
                "Expected character '{ch}', found '{}'",
                show(found)
            )));
        }
    }
    Ok(())
}

fn parse_dice(s: &mut Toks, n: f64) -> R<Option<Dice>> {
    let mut reroll_one = false;
    if peek(s, "hd") && peek_is_number(s, 2) {
        assert_token(s, "h")?;
        assert_token(s, "d")?;
        reroll_one = true;
    } else if peek(s, "d") && peek_is_number(s, 1) {
        assert_token(s, "d")?;
    } else {
        return Ok(None);
    }

    let sides = parse_number(s, n)?;
    if sides > MAX_DIE_SIDES {
        return Err(DiceError::dice_parse(format!(
            "Die size {} exceeds the maximum of {}",
            num_to_string(sides),
            num_to_string(MAX_DIE_SIDES)
        )));
    }
    let mut result = Dice::new(sides);
    if sides == 0.0 {
        return Ok(Some(result));
    }
    if reroll_one {
        result = result.reroll(Other::Num(1.0));
    }
    result.private_data.crit_track = Some(Rc::new(bare_track(&result)?));
    Ok(Some(result))
}

fn peek(arr: &Toks, expected: &str) -> bool {
    let want: Vec<char> = expected.chars().collect();
    if want.len() > arr.len() {
        return false;
    }
    want.iter().enumerate().all(|(i, c)| arr.get(i) == Some(*c))
}

fn peek_is_number(arr: &Toks, index: usize) -> bool {
    if index >= arr.len() {
        return false;
    }
    arr.get(index).is_some_and(|c| is_digit(c) || c == 'n')
}

/// `parseInt(text, 10)`.
fn parse_int(text: &str) -> f64 {
    let (neg, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: String = body.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let value = digits.parse::<f64>().unwrap_or(f64::NAN);
    if neg { -value } else { value }
}

fn parse_number(s: &mut Toks, n: f64) -> R<f64> {
    let mut ret = String::new();
    while let Some(c) = s.get(0) {
        if !(is_digit(c) || c == 'n') {
            break;
        }
        s.shift();
        if c == 'n' {
            ret.push_str(&num_to_string(n));
        } else {
            ret.push(c);
        }
    }
    if ret.is_empty() {
        return Err(DiceError::error(format!(
            "Expected number, found: '{}'",
            show(s.get(0))
        )));
    }
    Ok(parse_int(&ret))
}

fn is_digit(c: char) -> bool {
    c.is_ascii_digit()
}

fn parse_operation(s: &mut Toks) -> R<Option<Op>> {
    Ok(match s.get(0) {
        Some('a') => {
            assert_token(s, "ac")?;
            Some(Op::Ac)
        }
        Some('d') => {
            assert_token(s, "dc")?;
            Some(Op::Dc)
        }
        Some('!') => {
            assert_token(s, "!")?;
            Some(Op::Advantage)
        }
        Some('>') => {
            assert_token(s, ">")?;
            Some(Op::Max)
        }
        Some('<') => {
            assert_token(s, "<")?;
            Some(Op::Min)
        }
        Some('+') => {
            assert_token(s, "+")?;
            Some(Op::AddNonZero)
        }
        Some('~') => {
            assert_token(s, "~")?;
            assert_token(s, "+")?;
            Some(Op::Add)
        }
        Some('-') => {
            assert_token(s, "-")?;
            Some(Op::Subtract)
        }
        Some('&') => {
            assert_token(s, "&")?;
            Some(Op::Combine)
        }
        Some('r') => {
            assert_token(s, "reroll")?;
            Some(Op::Reroll)
        }
        Some('*') => {
            assert_token(s, "*")?;
            if peek(s, "*") {
                assert_token(s, "*")?;
                Some(Op::Multiply)
            } else {
                Some(Op::ConditionalApply)
            }
        }
        Some('/') => {
            assert_token(s, "/")?;
            if s.get(0) == Some('/') {
                assert_token(s, "/")?;
                Some(Op::DivideRoundDown)
            } else {
                Some(Op::DivideRoundUp)
            }
        }
        Some('=') => {
            assert_token(s, "=")?;
            Some(Op::Eq)
        }
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::{MAX_DEPTH, parse};
    use crate::error::DiceError;

    const SHAPES: [&str; 5] = ["(", "1+(", "2kh1(", "1*(", "-("];

    fn nested(open: &str, depth: usize) -> String {
        format!("{}1d6{}", open.repeat(depth), ")".repeat(depth))
    }

    /// Runs `parse` on a 2 MB stack, the default test thread's.
    fn parse_small_stack(expr: String) -> Result<(), DiceError> {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(move || parse(&expr).map(|_| ()))
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "panicked".to_string())?
    }

    #[test]
    fn max_depth_parses_for_every_shape() {
        for open in SHAPES {
            assert_eq!(
                parse_small_stack(nested(open, MAX_DEPTH)),
                Ok(()),
                "shape {open}"
            );
        }
    }

    #[test]
    fn deeper_than_max_depth_is_a_range_error() {
        for open in SHAPES {
            for depth in [MAX_DEPTH + 1, 10_000] {
                let expr = nested(open, depth);
                let error = parse_small_stack(expr.clone()).unwrap_err();
                assert_eq!(
                    error,
                    format!(
                        "Cannot parse dice expression [{expr}]: RangeError: Maximum call stack size exceeded"
                    ),
                    "shape {open} depth {depth}"
                );
                let DiceError::DiceParse(parse) = error else {
                    panic!("shape {open} depth {depth}: not a DiceParseError");
                };
                assert_eq!(parse.cause, Some(DiceError::stack_overflow()));
            }
        }
    }
}
