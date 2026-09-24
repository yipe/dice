import type { RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import { parse } from "./parser";

/** A bare decimal integer, optionally signed, with surrounding whitespace. */
const DECIMAL_INTEGER = /^\s*[+-]?\d+\s*$/;

/**
 * Parse without throwing — for UI code that reparses on every keystroke, where
 * a transiently invalid expression is normal rather than exceptional.
 *
 * Also accepts `+` before an integer, which the grammar has no use for: `"+7"`
 * becomes a delta at 7. Integers are read here rather than by the grammar
 * (which reads `"-3"` as a unary minus) so a huge one is refused instead of
 * rounded; a half-typed damage field is a bare signed number often enough.
 *
 * The failure value is {@link PMF.empty}, which has **mass 0**, not a
 * distribution. Convolving it collapses the whole result to mass 0, so a caller
 * combining several expressions should check `mass()` (or skip empties) rather
 * than assume a usable PMF. Anywhere a bad expression should be surfaced instead
 * of absorbed, call {@link parse} and handle `DiceParseError`.
 *
 * Takes no second argument on purpose. {@link parse}'s is `n`, the substitution
 * value for an `n`-dice expression — not an epsilon — so forwarding one here
 * would silently reinterpret it: `tryParse("nd6", 1e-9)` rolled `1d6` and
 * reported 3.5 where the default `n` of 0 means no dice at all.
 *
 * @returns the parsed PMF, or an empty (mass 0) PMF for input that is neither a
 * valid expression nor an integer.
 */
export function tryParse(expression: string): PMF {
  // Checked before `parse`, not only in the fallback: `parse` accepts unsigned
  // integers itself and converts them with the same precision loss, so
  // `parse("9007199254740993")` would hand back a delta at …992.
  if (DECIMAL_INTEGER.test(expression)) {
    const value = Number(expression);
    return Number.isSafeInteger(value) ? PMF.delta(value) : PMF.empty();
  }

  try {
    return parse(expression);
  } catch {
    return PMF.empty();
  }
}

/** The token naming a check: `AC` for an attack roll, `DC` for a saving throw. */
const CHECK_TOKEN = /\b(AC|DC)\b/i;

/** The d20 run at the head of a check: `d20`, `hd20 > d20`, `d20 < d20`, … */
const D20_RUN = /\bh?d20(?:\s*[><]\s*h?d20)*/i;

const RUN_FOR_ROLL_TYPE: Record<RollType, string> = {
  flat: "d20",
  advantage: "d20 > d20",
  disadvantage: "d20 < d20",
  "elven accuracy": "d20 > d20 > d20",
};

/**
 * Rewrite an expression's attack roll to a different d20 {@link RollType},
 * leaving everything else — damage, crit clause, miss clause, bonuses —
 * untouched.
 *
 * ```ts
 * withRollType("(d20 + 8 AC 16) * (1d4 + 4)", "advantage");
 * // "(d20 > d20 + 8 AC 16) * (1d4 + 4)"
 * ```
 *
 * **Every** `AC` group is rewritten, because one expression can hold several
 * attacks (`(d20 + 8 AC 16) * (1d8) + (d20 + 5 AC 16) * (1d6)`) and leaving the
 * later ones flat would quietly chart the wrong curve.
 *
 * A `DC` group is the *target's* saving throw, which the attacker's advantage
 * does not touch, so save expressions come back unchanged — as does anything
 * with no attack roll at all. This makes the function safe to map over a mixed
 * list of expressions.
 *
 * Assumes **one check per group**, which is what every well-formed attack or
 * save expression looks like and what `modelToExpression` emits. The grammar
 * will swallow a group naming two — `(d20 + 5 DC 16 + d20 + 8 AC 16)` parses,
 * as a single `AC` check whose roll happens to contain the save's 0/1 result —
 * but that is not an expression anyone means, and the roll type it should get is
 * undefined. Such input is rewritten on a best-effort basis rather than
 * diagnosed.
 *
 * A halfling-luck `h` prefix is preserved on the first die of each run, since it
 * describes the same roll.
 */
export function withRollType(expression: string, rollType: RollType): string {
  const scopes = enclosingScopes(expression);
  let rewritten = "";
  let copiedUpTo = 0;

  for (const run of expression.matchAll(new RegExp(D20_RUN, "gi"))) {
    const at = run.index as number;
    if (!isAttackRoll(expression, scopes, at)) continue;

    const replacement = run[0].toLowerCase().startsWith("h")
      ? `h${RUN_FOR_ROLL_TYPE[rollType]}`
      : RUN_FOR_ROLL_TYPE[rollType];

    rewritten += expression.slice(copiedUpTo, at) + replacement;
    copiedUpTo = at + run[0].length;
  }

  return rewritten + expression.slice(copiedUpTo);
}

/**
 * Balanced parenthesised ranges, innermost first, so a run's enclosing scopes
 * can be walked outwards. Unbalanced input simply yields fewer scopes; the
 * parser is what rejects it.
 */
function enclosingScopes(
  expression: string
): readonly { start: number; end: number }[] {
  const open: number[] = [];
  const scopes: { start: number; end: number }[] = [];

  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === "(") open.push(i);
    else if (expression[i] === ")") {
      const start = open.pop();
      if (start !== undefined) scopes.push({ start, end: i + 1 });
    }
  }

  // Closing order is innermost-first already; sorting by width keeps that true
  // for sibling groups too.
  return scopes.sort((a, b) => a.end - a.start - (b.end - b.start));
}

/**
 * Whether the d20 run at `at` is the attack roll of a check.
 *
 * Classified by the nearest enclosing group that names a check, widening
 * outwards, which is what makes nesting work: in `((d20 + 8) AC 16)` the run's
 * own group names nothing and the group outside it says `AC`.
 *
 * A run whose groups name no check is not an attack roll — the second run in
 * `(d20 + 8 AC 16) * (d20)` is damage — and an unparenthesised run is judged by
 * the whole expression, since there is nothing narrower to go on.
 */
function isAttackRoll(
  expression: string,
  scopes: readonly { start: number; end: number }[],
  at: number
): boolean {
  let scoped = false;

  for (const scope of scopes) {
    if (at < scope.start || at >= scope.end) continue;
    scoped = true;
    const check = CHECK_TOKEN.exec(expression.slice(scope.start, scope.end));
    if (check) return check[1].toUpperCase() === "AC";
  }

  if (scoped) return false;

  const check = CHECK_TOKEN.exec(expression);
  return check !== null && check[1].toUpperCase() === "AC";
}
