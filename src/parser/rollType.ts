import type { RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import { parse } from "./parser";

/** A bare decimal integer, optionally signed, with surrounding whitespace. */
const DECIMAL_INTEGER = /^\s*[+-]?\d+\s*$/;

/**
 * Parse without throwing — for UI code that reparses on every keystroke, where
 * a transiently invalid expression is normal rather than exceptional.
 *
 * Also accepts a *signed* integer, which the grammar rejects: `"-3"` becomes a
 * delta at -3, `"+7"` one at 7. Unsigned integers need no help — `parse("7")`
 * already returns a delta at 7 — but a half-typed damage field is a bare signed
 * number often enough to be worth covering.
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
 * A halfling-luck `h` prefix is preserved on the first die of each run, since it
 * describes the same roll.
 */
export function withRollType(expression: string, rollType: RollType): string {
  const scopes = enclosingScopes(expression);
  let rewritten = "";
  let copiedUpTo = 0;

  for (const run of expression.matchAll(new RegExp(D20_RUN, "gi"))) {
    const at = run.index as number;
    if (!isAttackRoll(expression, scopes, at, run[0].length)) continue;

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
 * Whether the d20 run at `at` is an attack roll.
 *
 * A parenthesised run is classified by walking outwards to the nearest scope
 * that names a check, which is what makes nesting work: in
 * `((d20 + 8) AC 16)` the run's own group says nothing and the one outside it
 * says `AC`. A run whose scopes name no check is *not* an attack roll — in
 * `(d20 + 8 AC 16) * (d20)` the second run is damage.
 *
 * An unparenthesised run is classified by the first check token that follows
 * it, which is the one the left-associated parse applies to it. Testing the
 * whole expression instead would rewrite the save in
 * `d20 + 5 DC 16 + d20 + 8 AC 16`, and the trailing damage die in
 * `d20 AC 16 + d20`.
 */
function isAttackRoll(
  expression: string,
  scopes: readonly { start: number; end: number }[],
  at: number,
  length: number
): boolean {
  let scoped = false;
  for (const scope of scopes) {
    if (at < scope.start || at >= scope.end) continue;
    scoped = true;
    const body = expression.slice(scope.start, scope.end);
    if (/\bAC\b/i.test(body)) return true;
    if (/\bDC\b/i.test(body)) return false;
  }
  if (scoped) return false;

  const following = expression.slice(at + length);
  const check = /\b(AC|DC)\b/i.exec(following);
  return check !== null && check[1].toUpperCase() === "AC";
}
