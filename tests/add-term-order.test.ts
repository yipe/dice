import { describe, expect, it } from "vitest";
import { resolve } from "../src/builder/ast";
import type { ExpressionNode } from "../src/builder/nodes";
import { builderPMFCache } from "../src/builder/factory";
import { PMF } from "../src/index";

/** Empties every cache a resolve can hit, so the next resolve computes. */
const clearCaches = (): void => {
  PMF.clearCache();
  builderPMFCache.clear();
};

/**
 * The builder cache key for a sum (`getASTSignature`) sorts the sum's terms, because addition commutes.
 * A float convolution does not associate bit for bit, so folding the terms in the order they were written
 * lets two sums with one key compute different last bits: whichever was resolved first decides what the
 * other gets back. A sum must resolve to the same bits in every term order, cold or after another order is cached.
 */

const pool = (count: number, sides: number, reroll?: number): ExpressionNode => ({
  type: "sum",
  count,
  child: { type: "die", sides, ...(reroll ? { reroll } : {}) },
} as ExpressionNode);

/** Terms taken from a sum the optimizer scores: 2d6 (reroll 1-2), 2d8, 1d8, 5. */
const TERMS: ExpressionNode[] = [pool(2, 6, 2), pool(2, 8), pool(1, 8), pool(3, 10, 1), pool(4, 12)];

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

const sumOf = (nodes: readonly ExpressionNode[]): ExpressionNode =>
  ({ type: "add", children: [...nodes.map((node) => ({ node, sign: 1 })), { node: { type: "constant", value: 5 }, sign: 1 }] }) as ExpressionNode;

describe("a sum is the same bits in every term order", () => {
  const orders = permutations(TERMS);

  it("cold: each order alone, caches cleared before each", () => {
    clearCaches();
    const reference = resolve(sumOf(orders[0]!), 0).fingerprint();
    for (const order of orders) {
      clearCaches();
      expect(resolve(sumOf(order), 0).fingerprint()).toBe(reference);
    }
  });

  it("warm: an order resolved after another is cached returns the bits it would have computed cold", () => {
    const cold = new Map<ExpressionNode[], string>();
    for (const order of orders.filter((_, i) => i % 11 === 0)) {
      clearCaches();
      cold.set(order, resolve(sumOf(order), 0).fingerprint());
    }
    for (const first of cold.keys()) {
      clearCaches();
      void resolve(sumOf(first), 0);
      for (const [second, bits] of cold) expect(resolve(sumOf(second), 0).fingerprint()).toBe(bits);
    }
  });
});
