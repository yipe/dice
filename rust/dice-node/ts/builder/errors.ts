import { registerErrorClass } from "../native";
// Registers the crit-doubling classes (`AmbiguousCritDoublingError`), which the builders also throw.
import "../parser/scaleDice";

/**
 * Thrown when a parsed string (`d("d20+5")`, `RollBuilder.fromArgs("d20+5")`) is used as an attack
 * or save check. A parsed builder carries only its PMF, not the dice and flats a check reads, so
 * the check would silently lose them.
 */
export class ParsedCheckError extends Error {
  constructor(
    readonly expression: string,
    verb: "ac" | "dc",
    message?: string
  ) {
    const example = verb === "ac" ? "d20.plus(5).ac(15)" : "d20.plus(5).dc(15)";
    const full = verb === "ac" ? "(d20 + 5 AC 15) * (1d8)" : "(d20 + 5 DC 15) * (8d6) save half";
    super(
      message ??
        `Cannot use the parsed string "${expression}" as a check with .${verb}(): a parsed roll carries no ` +
          `dice or flats for the check to read. Build the check with the builder API (${example}) or ` +
          `parse a full attack or save string ("${full}").`
    );
    this.name = "ParsedCheckError";
    Object.setPrototypeOf(this, ParsedCheckError.prototype);
  }
}

/**
 * Thrown for a per-die `keepHighest(T, K)`/`keepLowest(T, K)` on a group of N > 1 dice whose
 * reading is not unique (see `src/builder/ast.ts`).
 */
export class AmbiguousKeepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousKeepError";
    Object.setPrototypeOf(this, AmbiguousKeepError.prototype);
  }
}

registerErrorClass("ParsedCheckError", (tag) => new ParsedCheckError(tag.expression ?? "", tag.verb === "ac" ? "ac" : "dc", tag.message));
registerErrorClass("AmbiguousKeepError", (tag) => new AmbiguousKeepError(tag.message));
