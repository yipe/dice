import type { RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import { parse } from "./parser";

/** A bare decimal integer, optionally signed, with surrounding whitespace. */
const DECIMAL_INTEGER = /^\s*[+-]?\d+\s*$/;

/**
 * Parse without throwing — for UI code that reparses on every keystroke, where
 * a transiently invalid expression is normal rather than exceptional.
 *
 * Also accepts a bare integer, which the grammar rejects: `"7"` becomes a delta
 * at 7, `"-3"` a delta at -3. Consumers hit that case constantly, because a
 * half-typed damage field is a bare number for a keystroke or two.
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
    if (DECIMAL_INTEGER.test(expression)) {
      return PMF.delta(Number(expression));
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
  let rewritten = "";
  let copiedUpTo = 0;

  for (const group of expression.matchAll(/\(([^()]*)\)/g)) {
    const body = group[1];
    if (!/\bAC\b/i.test(body)) continue;

    const run = D20_RUN.exec(body);
    if (!run) continue;

    const replacement = run[0].toLowerCase().startsWith("h")
      ? `h${RUN_FOR_ROLL_TYPE[rollType]}`
      : RUN_FOR_ROLL_TYPE[rollType];

    const start = group.index as number;
    rewritten +=
      expression.slice(copiedUpTo, start) +
      "(" +
      body.slice(0, run.index) +
      replacement +
      body.slice(run.index + run[0].length) +
      ")";
    copiedUpTo = start + group[0].length;
  }

  return rewritten + expression.slice(copiedUpTo);
}
