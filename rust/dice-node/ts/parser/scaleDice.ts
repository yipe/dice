import { fromNative, native, registerErrorClass } from "../native";

/** Why a parsed string's dice cannot double: it is not a damage expression `scaleParsedDice` can rewrite. */
export class UndoubleableExpressionError extends Error {}

/**
 * Why a damage payload's dice cannot double on a crit: it is damage, but "double the dice"
 * has more than one reading for it. Never caught as {@link UndoubleableExpressionError}.
 */
export class AmbiguousCritDoublingError extends Error {}

registerErrorClass("UndoubleableExpressionError", (tag) => new UndoubleableExpressionError(tag.message));
registerErrorClass("AmbiguousCritDoublingError", (tag) => new AmbiguousCritDoublingError(tag.message));

/** Rewrites every dice term's count in a parsed damage expression by `scale`. */
export function scaleParsedDice(expression: string, scale: number): string {
  return fromNative(() => native.scaleParsedDice(expression, scale));
}
