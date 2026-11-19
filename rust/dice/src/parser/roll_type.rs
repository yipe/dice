//! Port of `src/parser/rollType.ts`.

use crate::error::DiceError;
use std::sync::LazyLock;

use regex::Regex;

use crate::Pmf;
use crate::js::is_space;

/// JS `\s` as a character class body (see `js::is_space`).
const WS: &str =
    r"\t-\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

static CHECK_TOKEN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)(AC|DC)(?-u:\b)").ok());

static D20_RUN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)(?-u:\b)h?d20(?:[{WS}]*[><][{WS}]*h?d20)*")).ok());

/// `tryParse(expression)` (rollType.ts:31): any failure is an empty (mass 0) PMF.
pub fn try_parse(expression: &str) -> Result<Pmf, DiceError> {
    let trimmed: &str = expression.trim_matches(is_space);
    let digits = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        // A decimal integer literal: Rust's f64 parse rounds correctly like JS `Number`.
        let value = trimmed
            .strip_prefix('+')
            .unwrap_or(trimmed)
            .parse::<f64>()
            .unwrap_or(f64::NAN);
        let safe = value.is_finite() && value.fract() == 0.0 && value.abs() <= 9007199254740991.0;
        return Ok(if safe {
            Pmf::delta(value, crate::EPS).unwrap_or_else(|_| Pmf::empty(crate::EPS))
        } else {
            Pmf::empty(crate::EPS)
        });
    }
    Ok(super::grammar::parse(expression).unwrap_or_else(|_| Pmf::empty(crate::EPS)))
}

fn run_for_roll_type(roll_type: &str) -> Option<&'static str> {
    match roll_type {
        "flat" => Some("d20"),
        "advantage" => Some("d20 > d20"),
        "disadvantage" => Some("d20 < d20"),
        "elven accuracy" => Some("d20 > d20 > d20"),
        _ => None,
    }
}

/// `withRollType(expression, rollType)` (rollType.ts:90); `roll_type` is a TS `RollType` string.
pub fn with_roll_type(expression: &str, roll_type: &str) -> Result<String, DiceError> {
    let Some(d20_run) = D20_RUN.as_ref() else {
        return Ok(expression.to_string());
    };
    // An unknown roll type is `undefined` in TS, which interpolates as "undefined".
    let run_text = run_for_roll_type(roll_type).unwrap_or("undefined");
    let scopes = enclosing_scopes(expression);
    let mut rewritten = String::new();
    let mut copied_up_to = 0;

    for run in d20_run.find_iter(expression) {
        let at = run.start();
        if !is_attack_roll(expression, &scopes, at) {
            continue;
        }
        if run.as_str().starts_with(['h', 'H']) {
            rewritten.push_str(&expression[copied_up_to..at]);
            rewritten.push('h');
            rewritten.push_str(run_text);
        } else {
            rewritten.push_str(&expression[copied_up_to..at]);
            rewritten.push_str(run_text);
        }
        copied_up_to = run.end();
    }
    rewritten.push_str(&expression[copied_up_to..]);
    Ok(rewritten)
}

/// Balanced parenthesised byte ranges, innermost first.
fn enclosing_scopes(expression: &str) -> Vec<(usize, usize)> {
    let mut open: Vec<usize> = Vec::new();
    let mut scopes: Vec<(usize, usize)> = Vec::new();
    for (i, c) in expression.char_indices() {
        if c == '(' {
            open.push(i);
        } else if c == ')'
            && let Some(start) = open.pop()
        {
            scopes.push((start, i + 1));
        }
    }
    // Width is in UTF-16 code units, as in TS; the sort is stable.
    scopes.sort_by_key(|&(s, e)| expression[s..e].encode_utf16().count());
    scopes
}

fn is_ac(text: &str) -> Option<bool> {
    let m = CHECK_TOKEN.as_ref()?.captures(text)?;
    Some(m[1].eq_ignore_ascii_case("AC"))
}

fn is_attack_roll(expression: &str, scopes: &[(usize, usize)], at: usize) -> bool {
    let mut scoped = false;
    for &(start, end) in scopes {
        if at < start || at >= end {
            continue;
        }
        scoped = true;
        if let Some(ac) = is_ac(&expression[start..end]) {
            return ac;
        }
    }
    if scoped {
        return false;
    }
    is_ac(expression).unwrap_or(false)
}
