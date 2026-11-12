import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "../src/builder/ast";
import type { ExpressionNode } from "../src/builder/nodes";
import { builderPMFCache } from "../src/builder/factory";
import { setCachingEnabled } from "../src/common/lru-cache";
import { PMF } from "../src/index";

/** Empties every cache a resolve can hit, so the next resolve computes. */
const clearCaches = (): void => {
  PMF.clearCache();
  builderPMFCache.clear();
};

afterEach(() => setCachingEnabled(true));

/**
 * The builder cache key of a `rerollUpTo` pool (`getASTSignature`) sorts the terms of its dice, as it does a sum's. A pool rolled
 * twice beside dice rolled once (Savage Attacker with Piercer) walked each side's dice in the order they were written, and its float
 * sums do not associate bit for bit, so two pools with one key computed different last bits and the first one resolved decided what
 * the other got back. A pool must resolve to the same bits in every term order, cold, after another order is cached, and uncached.
 */

const dice = (count: number, sides: number, reroll?: number): ExpressionNode =>
  ({ type: "sum", count, child: { type: "die", sides, ...(reroll ? { reroll } : {}) } }) as ExpressionNode;

/** The dice rolled once beside a rapier's 3d8 in a scored turn: Divine Favor, a d6 rider, and two Divine Smite pools. */
const ONCE: ExpressionNode[] = [dice(2, 4), dice(2, 6), dice(2, 8), dice(8, 8)];
const TWICE: ExpressionNode[] = [dice(3, 8), dice(1, 6, 1)];

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

const sumOf = (nodes: readonly ExpressionNode[]): ExpressionNode =>
  ({ type: "add", children: nodes.map((node) => ({ node, sign: 1 })) }) as ExpressionNode;

const poolOf = (twice: readonly ExpressionNode[], once: readonly ExpressionNode[]): ExpressionNode =>
  ({ type: "rerollUpTo", budget: 1, rolls: 2, child: sumOf(twice), rolledOnce: sumOf(once) }) as ExpressionNode;

/** Every (twice order, once order) pair, the first twice order with every once order and every twice order with the first once order. */
const ORDERS: [ExpressionNode[], ExpressionNode[]][] = [
  ...permutations(ONCE).map((once): [ExpressionNode[], ExpressionNode[]] => [TWICE, once]),
  ...permutations(TWICE).map((twice): [ExpressionNode[], ExpressionNode[]] => [twice, ONCE]),
];

describe("a rerollUpTo pool with dice rolled once is the same bits in every term order", () => {
  it("cold: each order alone, caches cleared before each", () => {
    clearCaches();
    const reference = resolve(poolOf(...ORDERS[0]!), 0).fingerprint();
    for (const order of ORDERS) {
      clearCaches();
      expect(resolve(poolOf(...order), 0).fingerprint()).toBe(reference);
    }
  });

  it("warm: an order resolved after another is cached returns the bits it would have computed cold", () => {
    const cold = new Map<[ExpressionNode[], ExpressionNode[]], string>();
    for (const order of ORDERS.filter((_, i) => i % 5 === 0)) {
      clearCaches();
      cold.set(order, resolve(poolOf(...order), 0).fingerprint());
    }
    for (const first of cold.keys()) {
      clearCaches();
      void resolve(poolOf(...first), 0);
      for (const [second, bits] of cold) expect(resolve(poolOf(...second), 0).fingerprint()).toBe(bits);
    }
  });

  it("uncached: with caching off every order computes the same bits", () => {
    setCachingEnabled(false);
    const reference = resolve(poolOf(...ORDERS[0]!), 0).fingerprint();
    for (const order of ORDERS) expect(resolve(poolOf(...order), 0).fingerprint()).toBe(reference);
  });
});
