import type { RollType } from "../../../../src/common/types";
import { PMF } from "../pmf/pmf";
import { native } from "../native";
import { parse } from "./parser";

/** A bare decimal integer, optionally signed, with surrounding whitespace. */
const DECIMAL_INTEGER = /^\s*[+-]?\d+\s*$/;

/**
 * Parse without throwing: an empty (mass 0) PMF for input that is neither a valid expression nor
 * an integer. See `src/parser/rollType.ts`.
 */
export function tryParse(expression: string): PMF {
  // The TS logic over the facade `parse`, so a parsed result is the cached, shared PMF.
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

/** Rewrites every attack roll's d20 run in `expression` for `rollType`; see `src/parser/rollType.ts`. */
export function withRollType(expression: string, rollType: RollType): string {
  return native.withRollType(expression, rollType);
}
