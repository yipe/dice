/**
 * Crit doubling for parsed damage strings: scale every dice term's count, keep every
 * operator and flat. A dice term is a die together with its per-die modifiers, so the rewrite
 * reads the string with the same grammar `parse()` uses:
 *
 * - `2d6 + 5` → `4d6 + 5`; `2d6 // 2` → `4d6 // 2` (the division applies to the doubled total).
 * - `d6 reroll 1 + 3` → `2(d6 reroll 1) + 3` and `3>d6` → `2(3>d6)`: a lone die with `reroll`,
 *   `>`, `<` or `!` applied to it is one die term; a `reroll`'s argument is a face set, never dice.
 * - `2(d6 reroll 1)` → `4(d6 reroll 1)`; `3(1d6 + 2)` → `3(2d6 + 2)` (copies of a group whose
 *   flats must not double are doubled inside).
 * - `2kh1(2d6 + 3)` → `2kh1(4d6 + 3)`: a pool doubles inside, then pools; its trial count stays.
 *   Only keep-highest-of-1 ("roll it N times, keep the best") does: any other keep (`4kh3d6`,
 *   `3kl1(1d6)`), a min of two dice terms (`d6 < d6`) and an `&` mix with dice on either side
 *   (`1d6 & 3`: doubling its dice also changes each side's share of the mix) have no single doubled
 *   meaning, so they throw {@link AmbiguousCritDoublingError} and the caller must give the crit
 *   explicitly.
 *
 * An attack or save check (`AC`/`DC`, or a crit/save/pc/miss clause) is not a damage expression —
 * doubling it would double the d20 — so it throws, as does a dice-valued repeat count (`d4d6`).
 */
type DiceAtom =
  | { kind: "number"; start: number; end: number; value: number }
  | { kind: "die"; start: number; end: number }
  | { kind: "group"; start: number; end: number; expr: DiceExpr }
  | { kind: "keep"; start: number; end: number; inner: DiceAtom; mode: "h" | "l"; kept: number };
type DiceChain = { start: number; atoms: DiceAtom[] };
type DiceOp = { op: string; arg: DiceChain | undefined; end: number };
type DiceExpr = { first: DiceChain; rest: DiceOp[] };

const isDigitOrN = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "0" && c <= "9") || c === "n");

/** Operators that, applied to a lone die, modify that die rather than a total. */
const isPerDieOp = (op: string): boolean =>
  op === "reroll" || op === ">" || op === "<" || op === "!";

/** Why a parsed string's dice cannot double: it is not a damage expression `scaleParsedDice` can rewrite. */
export class UndoubleableExpressionError extends Error {}

/**
 * Why a damage payload's dice cannot double on a crit: it is damage, but "double the dice"
 * has more than one reading for it (a keep other than keep-highest-of-1, a `bestOf()`, a die rolled
 * with advantage, an `&` mix with dice). Never caught as {@link UndoubleableExpressionError}: no
 * crit is approximated.
 */
export class AmbiguousCritDoublingError extends Error {}

/** A recursive-descent reader over `parse()`'s cleaned grammar (see `parser.ts`). */
class DiceTermReader {
  private pos = 0;

  constructor(
    private readonly s: string,
    private readonly expression: string
  ) {}

  read(): DiceExpr {
    const expr = this.expr();
    if (this.pos !== this.s.length) this.fail(`unexpected '${this.s[this.pos]}'`);
    return expr;
  }

  private fail(reason: string): never {
    throw new UndoubleableExpressionError(`Cannot double the dice of "${this.expression}": ${reason}.`);
  }

  private expr(): DiceExpr {
    const first = this.chain();
    const rest: DiceOp[] = [];
    for (let op = this.operation(); op !== undefined; op = this.operation()) {
      if (op === "ac") {
        this.fail("it contains an attack check (a d20 roll against an AC), so it is not a damage expression");
      }
      if (op === "dc") {
        this.fail("it contains a saving throw check (a d20 roll against a DC), so it is not a damage expression");
      }
      const arg = op === "!" ? undefined : this.chain();
      const c = this.s[this.pos];
      if (c === "x" || c === "c" || c === "s" || c === "m" || this.s.startsWith("pc", this.pos)) {
        this.fail("it contains a check-outcome clause (crit/save/pc/miss), so it is not a damage expression");
      }
      rest.push({ op, arg, end: this.pos });
    }
    return { first, rest };
  }

  private chain(): DiceChain {
    const start = this.pos;
    const atoms: DiceAtom[] = [];
    for (let atom = this.atom(); atom !== undefined; atom = this.atom()) atoms.push(atom);
    return { start, atoms };
  }

  private atom(): DiceAtom | undefined {
    const start = this.pos;
    const c = this.s[start];
    if (c === "(") {
      this.pos++;
      const expr = this.expr();
      if (this.s[this.pos] !== ")") this.fail("unbalanced parentheses");
      this.pos++;
      return { kind: "group", start, end: this.pos, expr };
    }
    if (c === "h" && this.s[start + 1] === "d" && isDigitOrN(this.s[start + 2])) {
      this.pos += 2;
      this.number();
      return { kind: "die", start, end: this.pos };
    }
    if (c === "d" && isDigitOrN(this.s[start + 1])) {
      this.pos += 1;
      this.number();
      return { kind: "die", start, end: this.pos };
    }
    if (c === "k") {
      const mode = this.s[start + 1];
      if (mode !== "h" && mode !== "l") this.fail("'k' must be followed by 'h' or 'l'");
      this.pos += 2;
      const kept = this.number();
      const inner = this.atom();
      if (inner === undefined) this.fail("a keep needs dice after it");
      return { kind: "keep", start, end: this.pos, inner, mode, kept };
    }
    if (isDigitOrN(c)) {
      const value = this.number();
      return { kind: "number", start, end: this.pos, value };
    }
    return undefined;
  }

  private number(): number {
    let digits = "";
    while (isDigitOrN(this.s[this.pos])) {
      const ch = this.s[this.pos++];
      digits += ch === "n" ? "0" : ch; // ParsedRollBuilder always parses with n = 0
    }
    if (digits.length === 0) this.fail(`expected a number at '${this.s[this.pos]}'`);
    return parseInt(digits, 10);
  }

  private operation(): string | undefined {
    const rest = this.s.slice(this.pos);
    const op = ["reroll", "**", "//", "~+", "ac", "dc", "!", ">", "<", "+", "-", "&", "*", "/", "="].find(
      (token) => rest.startsWith(token)
    );
    if (op !== undefined) this.pos += op.length;
    return op;
  }
}

function atomHasDice(atom: DiceAtom): boolean {
  switch (atom.kind) {
    case "die":
      return true;
    case "number":
      return false;
    case "keep":
      return atomHasDice(atom.inner);
    case "group":
      // A `reroll`'s argument is a face set (`reroll d2` = faces 1–2), never damage dice.
      return (
        chainHasDice(atom.expr.first) ||
        atom.expr.rest.some(({ op, arg }) => op !== "reroll" && arg !== undefined && chainHasDice(arg))
      );
  }
}

const chainHasDice = (chain: DiceChain): boolean => chain.atoms.some(atomHasDice);

const isSingleDieAtom = (atom: DiceAtom): boolean =>
  atom.kind === "die" || (atom.kind === "group" && isSingleDieExpr(atom.expr, atom.expr.rest.length));

/** Is `expr`'s first `opCount` operations one die term: one lone die, per-die operators, and flats? */
function isSingleDieExpr(expr: DiceExpr, opCount: number): boolean {
  const operands = [expr.first];
  for (const { op, arg } of expr.rest.slice(0, opCount)) {
    if (!isPerDieOp(op)) return false;
    if (op !== "reroll" && arg !== undefined) operands.push(arg);
  }
  let dice = 0;
  for (const chain of operands) {
    if (chain.atoms.length === 1 && isSingleDieAtom(chain.atoms[0])) dice++;
    else if (chainHasDice(chain)) return false;
  }
  return dice === 1;
}

/** Rewrites every dice term's count in a parsed damage expression by `scale`. */
export function scaleParsedDice(expression: string, scale: number): string {
  // `parse()` drops every space and lowercases; keep a map back to the original characters so
  // the rewrite leaves the caller's spacing and casing alone.
  let cleaned = "";
  const original: number[] = [];
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === " ") continue;
    cleaned += expression[i].toLowerCase();
    original.push(i);
  }
  const root = new DiceTermReader(cleaned, expression).read();

  const edits: { from: number; to: number; text: string }[] = [];
  /** The original characters behind cleaned `[start, end)`, spaces inside included. */
  const span = (start: number, end: number) => ({ from: original[start], to: original[end - 1] + 1 });
  const wrap = (start: number, end: number, open: string) => {
    const { from, to } = span(start, end);
    edits.push({ from, to: from, text: open }, { from: to, to, text: ")" });
  };
  const source = (start: number, end: number) => {
    const { from, to } = span(start, end);
    return expression.slice(from, to);
  };

  // Shapes whose doubling has no single meaning, each with why. They are refused after the whole
  // walk, so a string that is not damage at all still reports that (UndoubleableExpressionError).
  const ambiguous: string[] = [];
  const keepReading =
    'has no single doubled meaning (only keep-highest-of-1, "roll it N times, keep the best", doubles its dice inside each trial)';
  const noteKeep = (keep: Extract<DiceAtom, { kind: "keep" }>, trials?: DiceAtom): void => {
    // A keep of numbers alone is a constant: it has no dice to double, so one meaning.
    if ((keep.mode === "h" && keep.kept === 1) || !atomHasDice(keep.inner)) return;
    ambiguous.push(`the keep \`${source(trials?.kind === "number" ? trials.start : keep.start, keep.inner.start)}\` ${keepReading}`);
  };

  // After a keep's count a bare prefix would merge into that number (`4kh3d6` → `4kh32d6`), so a
  // kept lone die takes its count inside new parentheses: `4kh3(2d6)`.
  const scaleKept = (inner: DiceAtom): void => {
    if (isSingleDieAtom(inner)) wrap(inner.start, inner.end, `(${scale}`);
    else if (inner.kind === "group") scaleExpr(inner.expr);
    else if (inner.kind === "keep") {
      noteKeep(inner);
      scaleKept(inner.inner);
    }
  };

  const scaleChain = (chain: DiceChain): void => {
    const { atoms } = chain;
    if (atoms.length === 0) return;
    const last = atoms[atoms.length - 1];
    const counts = atoms.slice(0, -1);
    if (counts.some(atomHasDice)) {
      throw new UndoubleableExpressionError(
        `Cannot double the dice of "${expression}": a dice-valued repeat count (like d4d6) has no single dice term to double.`
      );
    }
    if (last.kind === "keep") {
      noteKeep(last, counts[counts.length - 1]);
      scaleKept(last.inner); // the pool's trial count stays; its dice double inside
    } else if (isSingleDieAtom(last)) {
      const count = counts[counts.length - 1];
      if (count?.kind === "number") {
        edits.push({ ...span(count.start, count.end), text: String(count.value * scale) });
      } else {
        const at = original[last.start];
        edits.push({ from: at, to: at, text: String(scale) });
      }
    } else if (last.kind === "group") {
      scaleExpr(last.expr); // copies of a group: double inside so its flats stay single
    }
  };

  function scaleExpr(expr: DiceExpr): void {
    // Operators bind left to right, so a leading lone die with per-die operators is one term.
    let unitOps = 0;
    for (let i = 1; i <= expr.rest.length && isPerDieOp(expr.rest[i - 1].op); i++) {
      if (isSingleDieExpr(expr, i)) unitOps = i;
    }
    if (unitOps > 0) wrap(expr.first.start, expr.rest[unitOps - 1].end, `${scale}(`);
    else scaleChain(expr.first);
    let leftHasDice = unitOps > 0 || chainHasDice(expr.first);
    for (const { op, arg, end } of expr.rest.slice(unitOps)) {
      if (op === "reroll" || arg === undefined) continue;
      const argHasDice = chainHasDice(arg);
      // `a < b` is min(a, b): with dice on both sides it keeps the lower of two dice terms.
      if (op === "<" && leftHasDice && argHasDice) {
        ambiguous.push(`the lower of two dice terms \`${source(expr.first.start, end)}\` ${keepReading}`);
      }
      // `a & b` mixes by count: doubling a side's dice multiplies its count, so its share moves.
      if (op === "&" && (leftHasDice || argHasDice)) {
        ambiguous.push(
          `the mix \`${source(expr.first.start, end)}\` has no single doubled meaning (an \`&\` weights each side ` +
            `by its count of outcomes, so doubling a side's dice also changes its share of the mix)`
        );
      }
      leftHasDice ||= argHasDice;
      scaleChain(arg);
    }
  }

  scaleExpr(root);
  if (ambiguous.length > 0) {
    throw new AmbiguousCritDoublingError(
      `Cannot double the dice of "${expression}" on a crit: ${ambiguous[0]}. ` +
        `Give the crit explicitly: onCrit(...) on an attack, critDamage on a rider, or a crit (...) clause.`
    );
  }

  let result = expression;
  for (const { from, to, text } of edits.sort((a, b) => b.from - a.from)) {
    result = result.slice(0, from) + text + result.slice(to);
  }
  return result;
}
