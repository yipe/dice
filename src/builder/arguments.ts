/**
 * Throws for a non-finite builder argument, naming it. NaN reads "got NaN" unless the call site has
 * its own, earlier NaN message. Internal: not re-exported from the package.
 */
export function requireFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new Error(`${what} must be finite, got ${value}`);
}
