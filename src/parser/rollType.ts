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
  try {
    return parse(expression);
  } catch {
    // Decimal only. `Number()` would also take "0x10" as 16, "0b11" as 3 and
    // "1e3" as 1000, none of which anyone typing into a damage field means.
    // Safe integers only too: past 2^53 the conversion loses precision, so
    // "-9007199254740993" would silently become …992. (`parse` itself accepts
    // unsigned integers and does lose precision there; that is its own
    // long-standing behaviour, not something this wrapper can fix.)
    if (DECIMAL_INTEGER.test(expression)) {
      const value = Number(expression);
      if (Number.isSafeInteger(value)) return PMF.delta(value);
    }
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
 * Whether the d20 run at `at` is an attack roll, by walking outwards to the
 * nearest scope that names a check: `AC` means yes, `DC` means it is the
 * target's saving throw, and naming neither means there is no check to convert.
 *
 * Walking outwards is what makes nesting work — in `((d20 + 8) AC 16)` the run's
 * own group says nothing and the one outside it says `AC`.
 */
function isAttackRoll(
  expression: string,
  scopes: readonly { start: number; end: number }[],
  at: number
): boolean {
  for (const scope of scopes) {
    if (at < scope.start || at >= scope.end) continue;
    const body = expression.slice(scope.start, scope.end);
    if (/\bAC\b/i.test(body)) return true;
    if (/\bDC\b/i.test(body)) return false;
  }
  if (/\bAC\b/i.test(expression)) return true;
  return false;
}
