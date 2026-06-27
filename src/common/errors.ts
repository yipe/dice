/**
 * Error thrown when a dice expression cannot be parsed.
 *
 * Extends the built-in {@link Error}, so existing `catch (e)` / message checks
 * continue to work, while callers can now narrow with `instanceof DiceParseError`.
 *
 * @example
 * try {
 *   parse("d6@3");
 * } catch (e) {
 *   if (e instanceof DiceParseError) {
 *     // e.expression === "d6@3"
 *   }
 * }
 */
export class DiceParseError extends Error {
  /** The original expression that failed to parse, when available. */
  readonly expression?: string;

  /** The underlying error that triggered this one, when available. */
  readonly cause?: unknown;

  constructor(
    message: string,
    options?: { expression?: string; cause?: unknown }
  ) {
    super(message);
    this.name = "DiceParseError";
    this.expression = options?.expression;
    this.cause = options?.cause;
    // Restore the prototype chain for reliable `instanceof` across targets.
    Object.setPrototypeOf(this, DiceParseError.prototype);
  }
}
