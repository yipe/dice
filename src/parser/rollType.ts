import type { RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import { parse } from "./parser";

/**
 * Parse without throwing.
 *
 * Also accepts a bare integer, which the grammar rejects: `"7"` becomes a delta
 * at 7, `"-3"` a delta at -3. Consumers hit that case constantly, because a
 * half-typed damage field is a bare number for a keystroke or two.
 *
 * @returns the parsed PMF, or an empty PMF for input that is neither a valid
 * expression nor an integer.
 */
export function tryParse(expression: string, eps?: number): PMF {
  try {
    return parse(expression, eps);
  } catch {
    const numeric = Number(expression);
    if (expression.trim() !== "" && Number.isInteger(numeric)) {
      return PMF.delta(numeric, eps);
    }
    return PMF.empty(eps);
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
 * Only an `AC` group is rewritten. A `DC` group is the *target's* saving throw,
 * which the attacker's advantage does not touch, so save expressions come back
 * unchanged — as does anything with no attack roll at all. This makes the
 * function safe to map over a mixed list of expressions.
 *
 * A halfling-luck `h` prefix is preserved on the first die of the run, since it
 * describes the same roll.
 */
export function withRollType(expression: string, rollType: RollType): string {
  const groups = expression.matchAll(/\(([^()]*)\)/g);

  for (const group of groups) {
    const body = group[1];
    if (!/\bAC\b/i.test(body)) continue;

    const run = D20_RUN.exec(body);
    if (!run) continue;

    const halfling = run[0].toLowerCase().startsWith("h");
    const replacement = halfling
      ? `h${RUN_FOR_ROLL_TYPE[rollType]}`
      : RUN_FOR_ROLL_TYPE[rollType];

    const rewrittenBody =
      body.slice(0, run.index) +
      replacement +
      body.slice(run.index + run[0].length);

    const start = group.index as number;
    return (
      expression.slice(0, start) +
      `(${rewrittenBody})` +
      expression.slice(start + group[0].length)
    );
  }

  return expression;
}
