import { DiceParseError } from "../../../../src/common/errors";
import { PMF } from "../pmf/pmf";
import { errorOfTag, native, registerErrorClass } from "../native";

registerErrorClass(
  "DiceParseError",
  (tag) =>
    new DiceParseError(tag.message, {
      expression: tag.expression ?? undefined,
      cause: tag.cause ? errorOfTag(tag.cause) : undefined,
    })
);

/** Clears the Rust parse cache (keyed by cleaned expression and `n`; see `pmf/cache.rs`). */
export function clearParserCache(): void {
  native.clearCache("parse");
}

/**
 * Parse a dice expression into a PMF (Rust `yipe_dice::parser::parse`).
 *
 * - Expression is case-insensitive and ignores whitespace.
 */
export function parse(expression: string, n: number = 0): PMF {
  // `native.parse` throws the `DiceParseError` itself (see the registration above).
  return PMF._wrapShared(native.parse(expression, n));
}
