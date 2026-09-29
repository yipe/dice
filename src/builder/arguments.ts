/**
 * Throws for a non-finite builder argument, naming it. NaN reads "got NaN" unless the call site has
 * its own, earlier NaN message. Internal: not re-exported from the package.
 */
export function requireFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new Error(`${what} must be finite, got ${value}`);
}

/**
 * The reroll budget and roll count of a `rerollUpTo()` / `rerollDamageUpTo()` call, validated: the
 * budget is a non-negative integer, the number of rolls a positive one (default 1). Internal.
 */
export function rerollUpToArguments(
  budget: number,
  options: { readonly rolls?: number } | undefined,
  verb: string
): { budget: number; rolls: number } {
  const rolls = options?.rolls ?? 1;
  if (isNaN(budget)) throw new Error(`Invalid NaN value for ${verb} budget`);
  if (isNaN(rolls)) throw new Error(`Invalid NaN value for ${verb} rolls`);
  requireFinite(budget, `${verb} budget`);
  requireFinite(rolls, `${verb} rolls`);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`${verb} budget must be a non-negative integer, got ${budget}`);
  }
  if (!Number.isInteger(rolls) || rolls < 1) {
    throw new Error(`${verb} rolls must be a positive integer, got ${rolls}`);
  }
  return { budget, rolls };
}
