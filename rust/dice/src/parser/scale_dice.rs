//! Port of `src/parser/scaleDice.ts`.
//!
//! Indexes are UTF-16 code units, as in the TS: `cleaned` and the edit offsets are `Vec<u16>`.

use crate::error::DiceError;
use crate::js::num_to_string;

enum Atom {
    Number {
        start: usize,
        end: usize,
        value: f64,
    },
    Die {
        start: usize,
        end: usize,
    },
    /// `has_dice` / `single` cache `atom_has_dice` / `is_single_die_atom`: both are pure, and
    /// recomputing them at every nesting level is cubic in the depth.
    Group {
        start: usize,
        end: usize,
        expr: Box<Expr>,
        has_dice: bool,
        single: bool,
    },
    Keep {
        start: usize,
        inner: Box<Atom>,
        mode: u16,
        kept: f64,
    },
}

impl Atom {
    fn start(&self) -> usize {
        match self {
            Atom::Number { start, .. }
            | Atom::Die { start, .. }
            | Atom::Group { start, .. }
            | Atom::Keep { start, .. } => *start,
        }
    }

    fn end(&self) -> usize {
        match self {
            Atom::Number { end, .. } | Atom::Die { end, .. } | Atom::Group { end, .. } => *end,
            Atom::Keep { inner, .. } => inner.end(),
        }
    }
}

struct Chain {
    start: usize,
    atoms: Vec<Atom>,
}

struct Op {
    op: &'static str,
    arg: Option<Chain>,
    end: usize,
}

struct Expr {
    first: Chain,
    rest: Vec<Op>,
}

fn is_digit_or_n(c: Option<u16>) -> bool {
    matches!(c, Some(c) if (u16::from(b'0')..=u16::from(b'9')).contains(&c) || c == u16::from(b'n'))
}

fn refused_op(op: &str) -> Option<&'static str> {
    match op {
        "ac" => Some(
            "it contains an attack check (a d20 roll against an AC), so it is not a damage expression",
        ),
        "dc" => Some(
            "it contains a saving throw check (a d20 roll against a DC), so it is not a damage expression",
        ),
        _ => None,
    }
}

fn is_per_die_op(op: &str) -> bool {
    matches!(op, "reroll" | ">" | "<" | "!")
}

const OPS: [&str; 15] = [
    "reroll", "**", "//", "~+", "ac", "dc", "!", ">", "<", "+", "-", "&", "*", "/", "=",
];

/// ADR-016: nesting past this fails as TS does when its stack runs out.
const MAX_DEPTH: usize = 500;

struct Reader<'a> {
    s: &'a [u16],
    pos: usize,
    depth: usize,
    expression: &'a str,
}

impl Reader<'_> {
    fn at(&self, i: usize) -> Option<u16> {
        self.s.get(i).copied()
    }

    /// JS `${this.s[i]}`.
    fn show(&self, i: usize) -> String {
        match self.at(i) {
            Some(c) => String::from_utf16_lossy(&[c]),
            None => "undefined".to_string(),
        }
    }

    fn fail<T>(&self, reason: &str) -> Result<T, DiceError> {
        Err(self.undoubleable(reason))
    }

    #[inline(never)]
    fn undoubleable(&self, reason: &str) -> DiceError {
        DiceError::UndoubleableExpression(format!(
            "Cannot double the dice of \"{}\": {}.",
            self.expression, reason
        ))
    }

    fn read(&mut self) -> Result<Expr, DiceError> {
        let expr = self.expr()?;
        if self.pos != self.s.len() {
            return self.fail(&format!("unexpected '{}'", self.show(self.pos)));
        }
        Ok(expr)
    }

    fn expr(&mut self) -> Result<Expr, DiceError> {
        let first = self.chain()?;
        let mut rest = Vec::new();
        while let Some(op) = self.operation() {
            if let Some(reason) = refused_op(op) {
                return self.fail(reason);
            }
            let arg = if op == "!" { None } else { Some(self.chain()?) };
            if self.at_clause() {
                return self.fail(
                    "it contains a check-outcome clause (crit/save/pc/miss), so it is not a damage expression",
                );
            }
            rest.push(Op {
                op,
                arg,
                end: self.pos,
            });
        }
        Ok(Expr { first, rest })
    }

    #[inline(never)]
    fn at_clause(&self) -> bool {
        let c = self.at(self.pos);
        matches!(c, Some(c) if b"xcsm".iter().any(|b| u16::from(*b) == c))
            || (c == Some(u16::from(b'p')) && self.at(self.pos + 1) == Some(u16::from(b'c')))
    }

    fn chain(&mut self) -> Result<Chain, DiceError> {
        let start = self.pos;
        let mut atoms = Vec::new();
        while let Some(atom) = self.atom()? {
            atoms.push(atom);
        }
        Ok(Chain { start, atoms })
    }

    /// Every recursive step (group and keep nesting) goes through here.
    fn atom(&mut self) -> Result<Option<Atom>, DiceError> {
        if self.depth > MAX_DEPTH {
            return Err(DiceError::range("Maximum call stack size exceeded"));
        }
        self.depth += 1;
        let result = if self.at(self.pos) == Some(u16::from(b'(')) {
            self.group()
        } else {
            self.leaf()
        };
        self.depth -= 1;
        result
    }

    fn group(&mut self) -> Result<Option<Atom>, DiceError> {
        let start = self.pos;
        self.pos += 1;
        let expr = self.expr()?;
        if self.at(self.pos) != Some(u16::from(b')')) {
            return self.fail("unbalanced parentheses");
        }
        self.pos += 1;
        let has_dice = expr_has_dice(&expr);
        let single = is_single_die_expr(&expr, expr.rest.len());
        Ok(Some(Atom::Group {
            start,
            end: self.pos,
            expr: Box::new(expr),
            has_dice,
            single,
        }))
    }

    #[inline(never)]
    fn leaf(&mut self) -> Result<Option<Atom>, DiceError> {
        let start = self.pos;
        let c = self.at(start);
        let ch = |b: u8| Some(u16::from(b));
        if c == ch(b'h') && self.at(start + 1) == ch(b'd') && is_digit_or_n(self.at(start + 2)) {
            self.pos += 2;
            self.number()?;
            return Ok(Some(Atom::Die {
                start,
                end: self.pos,
            }));
        }
        if c == ch(b'd') && is_digit_or_n(self.at(start + 1)) {
            self.pos += 1;
            self.number()?;
            return Ok(Some(Atom::Die {
                start,
                end: self.pos,
            }));
        }
        if c == ch(b'k') {
            let mode = self.at(start + 1);
            let mode = match mode {
                Some(m) if Some(m) == ch(b'h') || Some(m) == ch(b'l') => m,
                _ => return self.fail("'k' must be followed by 'h' or 'l'"),
            };
            self.pos += 2;
            let kept = self.number()?;
            let Some(inner) = self.atom()? else {
                return self.fail("a keep needs dice after it");
            };
            return Ok(Some(Atom::Keep {
                start,
                inner: Box::new(inner),
                mode,
                kept,
            }));
        }
        if is_digit_or_n(c) {
            let value = self.number()?;
            return Ok(Some(Atom::Number {
                start,
                end: self.pos,
                value,
            }));
        }
        Ok(None)
    }

    fn number(&mut self) -> Result<f64, DiceError> {
        let mut digits = String::new();
        while is_digit_or_n(self.at(self.pos)) {
            let ch = self.at(self.pos).unwrap_or(0);
            self.pos += 1;
            // ParsedRollBuilder always parses with n = 0
            digits.push(if ch == u16::from(b'n') {
                '0'
            } else {
                char::from(ch as u8)
            });
        }
        if digits.is_empty() {
            return self.fail(&format!("expected a number at '{}'", self.show(self.pos)));
        }
        // INFALLIBLE: digits are ASCII 0-9 only; overflow parses to inf like JS parseInt.
        Ok(digits.parse::<f64>().unwrap_or(f64::NAN))
    }

    fn operation(&mut self) -> Option<&'static str> {
        let rest = self.s.get(self.pos..).unwrap_or(&[]);
        let op = OPS.iter().copied().find(|t| {
            let t = t.as_bytes();
            rest.len() >= t.len() && rest.iter().zip(t).all(|(a, b)| *a == u16::from(*b))
        });
        if let Some(op) = op {
            self.pos += op.len();
        }
        op
    }
}

fn atom_has_dice(atom: &Atom) -> bool {
    match atom {
        Atom::Die { .. } => true,
        Atom::Number { .. } => false,
        Atom::Keep { inner, .. } => atom_has_dice(inner),
        Atom::Group { has_dice, .. } => *has_dice,
    }
}

/// A `reroll`'s argument is a face set, never damage dice.
fn expr_has_dice(expr: &Expr) -> bool {
    chain_has_dice(&expr.first)
        || expr
            .rest
            .iter()
            .any(|o| o.op != "reroll" && o.arg.as_ref().is_some_and(chain_has_dice))
}

fn chain_has_dice(chain: &Chain) -> bool {
    chain.atoms.iter().any(atom_has_dice)
}

fn is_single_die_atom(atom: &Atom) -> bool {
    match atom {
        Atom::Die { .. } => true,
        Atom::Group { single, .. } => *single,
        _ => false,
    }
}

fn is_single_die_expr(expr: &Expr, op_count: usize) -> bool {
    let mut operands = vec![&expr.first];
    for o in expr.rest.iter().take(op_count) {
        if !is_per_die_op(o.op) {
            return false;
        }
        if let (true, Some(arg)) = (o.op != "reroll", &o.arg) {
            operands.push(arg);
        }
    }
    let mut dice = 0;
    for chain in operands {
        if chain.atoms.len() == 1 && is_single_die_atom(&chain.atoms[0]) {
            dice += 1;
        } else if chain_has_dice(chain) {
            return false;
        }
    }
    dice == 1
}

const KEEP_READING: &str = "has no single doubled meaning (only keep-highest-of-1, \"roll it N times, keep the best\", doubles its dice inside each trial)";

struct Scaler<'a> {
    expression: &'a str,
    expr16: Vec<u16>,
    original: Vec<usize>,
    scale: f64,
    edits: Vec<(usize, usize, String)>,
    ambiguous: Vec<String>,
}

impl Scaler<'_> {
    fn orig(&self, i: usize) -> usize {
        self.original.get(i).copied().unwrap_or(0)
    }

    fn span(&self, start: usize, end: usize) -> (usize, usize) {
        (self.orig(start), self.orig(end.saturating_sub(1)) + 1)
    }

    fn wrap(&mut self, start: usize, end: usize, open: String) {
        let (from, to) = self.span(start, end);
        self.edits.push((from, from, open));
        self.edits.push((to, to, ")".to_string()));
    }

    fn source(&self, start: usize, end: usize) -> String {
        let (from, to) = self.span(start, end);
        let to = to.min(self.expr16.len());
        let from = from.min(to);
        String::from_utf16_lossy(&self.expr16[from..to])
    }

    fn note_keep(&mut self, keep: &Atom, trials: Option<&Atom>) {
        let Atom::Keep {
            start,
            inner,
            mode,
            kept,
        } = keep
        else {
            return;
        };
        if (*mode == u16::from(b'h') && *kept == 1.0) || !atom_has_dice(inner) {
            return;
        }
        let from = match trials {
            Some(Atom::Number { start, .. }) => *start,
            _ => *start,
        };
        let src = self.source(from, inner.start());
        self.ambiguous
            .push(format!("the keep `{src}` {KEEP_READING}"));
    }

    fn scale_kept(&mut self, inner: &Atom) -> Result<(), DiceError> {
        if is_single_die_atom(inner) {
            let open = format!("({}", num_to_string(self.scale));
            self.wrap(inner.start(), inner.end(), open);
        } else if let Atom::Group { expr, .. } = inner {
            self.scale_expr(expr)?;
        } else if let Atom::Keep { inner: deeper, .. } = inner {
            self.note_keep(inner, None);
            self.scale_kept(deeper)?;
        }
        Ok(())
    }

    fn scale_chain(&mut self, chain: &Chain) -> Result<(), DiceError> {
        let Some((last, counts)) = chain.atoms.split_last() else {
            return Ok(());
        };
        if counts.iter().any(atom_has_dice) {
            return Err(DiceError::UndoubleableExpression(format!(
                "Cannot double the dice of \"{}\": a dice-valued repeat count (like d4d6) has no single dice term to double.",
                self.expression
            )));
        }
        if let Atom::Keep { inner, .. } = last {
            self.note_keep(last, counts.last());
            self.scale_kept(inner)?;
        } else if is_single_die_atom(last) {
            if let Some(Atom::Number { start, end, value }) = counts.last() {
                let (from, to) = self.span(*start, *end);
                self.edits
                    .push((from, to, num_to_string(value * self.scale)));
            } else {
                let at = self.orig(last.start());
                self.edits.push((at, at, num_to_string(self.scale)));
            }
        } else if let Atom::Group { expr, .. } = last {
            self.scale_expr(expr)?;
        }
        Ok(())
    }

    fn scale_expr(&mut self, expr: &Expr) -> Result<(), DiceError> {
        let mut unit_ops = 0;
        let mut i = 1;
        while i <= expr.rest.len() && is_per_die_op(expr.rest[i - 1].op) {
            if is_single_die_expr(expr, i) {
                unit_ops = i;
            }
            i += 1;
        }
        if unit_ops > 0 {
            let open = format!("{}(", num_to_string(self.scale));
            self.wrap(expr.first.start, expr.rest[unit_ops - 1].end, open);
        } else {
            self.scale_chain(&expr.first)?;
        }
        let mut left_has_dice = unit_ops > 0 || chain_has_dice(&expr.first);
        for o in expr.rest.iter().skip(unit_ops) {
            let Some(arg) = &o.arg else { continue };
            if o.op == "reroll" {
                continue;
            }
            let arg_has_dice = chain_has_dice(arg);
            if o.op == "<" && left_has_dice && arg_has_dice {
                let src = self.source(expr.first.start, o.end);
                self.ambiguous.push(format!(
                    "the lower of two dice terms `{src}` {KEEP_READING}"
                ));
            }
            if o.op == "&" && (left_has_dice || arg_has_dice) {
                let src = self.source(expr.first.start, o.end);
                self.ambiguous.push(format!(
                    "the mix `{src}` has no single doubled meaning (an `&` weights each side by its count of outcomes, so doubling a side's dice also changes its share of the mix)"
                ));
            }
            left_has_dice = left_has_dice || arg_has_dice;
            self.scale_chain(arg)?;
        }
        Ok(())
    }
}

/// `scaleParsedDice(expression, scale)` (scaleDice.ts:188). Throws (`UndoubleableExpressionError`,
/// `AmbiguousCritDoublingError`, ...) become the matching [`DiceError`] variants.
pub fn scale_parsed_dice(expression: &str, scale: f64) -> Result<String, DiceError> {
    // ADR-016: the grammar recurses once per nesting level, capped at MAX_DEPTH (past which the
    // Err mimics V8's RangeError). TS itself does not finish scaleParsedDice at depth 5000
    // (measured > 2 min); the cap makes Rust fail fast instead of crashing or hanging.
    scale_impl(expression, scale)
}

fn scale_impl(expression: &str, scale: f64) -> Result<String, DiceError> {
    // JS lowercases each UTF-16 unit separately (a surrogate half is unchanged) and `original`
    // gets one entry per source unit, even when a lowercase expands.
    let expr16: Vec<u16> = expression.encode_utf16().collect();
    let mut cleaned: Vec<u16> = Vec::new();
    let mut original: Vec<usize> = Vec::new();
    for (i, &u) in expr16.iter().enumerate() {
        if u == u16::from(b' ') {
            continue;
        }
        match char::from_u32(u32::from(u)) {
            Some(c) => {
                let lower: String = c.to_lowercase().collect();
                cleaned.extend(lower.encode_utf16());
            }
            None => cleaned.push(u),
        }
        original.push(i);
    }
    let root = Reader {
        s: &cleaned,
        pos: 0,
        depth: 0,
        expression,
    }
    .read()?;

    let mut sc = Scaler {
        expression,
        expr16,
        original,
        scale,
        edits: Vec::new(),
        ambiguous: Vec::new(),
    };
    sc.scale_expr(&root)?;
    if let Some(first) = sc.ambiguous.first() {
        return Err(DiceError::AmbiguousCritDoubling(format!(
            "Cannot double the dice of \"{expression}\" on a crit: {first}. Give the crit explicitly: onCrit(...) on an attack, critDamage on a rider, or a crit (...) clause."
        )));
    }

    let mut edits = std::mem::take(&mut sc.edits);
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut result = sc.expr16.clone();
    for (from, to, text) in edits {
        let to = to.min(result.len());
        let from = from.min(to);
        result.splice(from..to, text.encode_utf16());
    }
    Ok(String::from_utf16_lossy(&result))
}

#[cfg(test)]
mod tests {
    use super::{MAX_DEPTH, scale_parsed_dice};

    fn nested(n: usize) -> String {
        format!("{}1d6{}", "(".repeat(n), ")".repeat(n))
    }

    #[test]
    fn max_depth_scales() {
        assert!(scale_parsed_dice(&nested(MAX_DEPTH), 2.0).is_ok());
    }

    #[test]
    fn deeper_than_max_is_range_error() {
        for n in [MAX_DEPTH + 1, 10_000] {
            let err = scale_parsed_dice(&nested(n), 2.0)
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default();
            assert!(
                err.contains("Maximum call stack size exceeded"),
                "{n}: {err}"
            );
        }
    }
}
