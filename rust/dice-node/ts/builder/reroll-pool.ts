import { LRUCache } from "../../../../src/common/lru-cache";
import { native, type NativePmfHandle } from "../native";
import { PMF } from "../pmf/pmf";

/**
 * Facade over `rust/dice-node/src/ast.rs` (`pool*`): the exact distribution of a dice pool that
 * may reroll up to k of its dice once every die is seen. `rerollUpToMatch` keeps its LRU here (it
 * hands out one result object per pool, and a pool too big to walk costs its whole work limit to
 * refuse); the PMFs are not cached.
 */

/** One kind of die in the pool: `count` interchangeable dice showing `values` with `probs`. */
export interface PoolDieKind {
  /** Signed face values: a subtracted die carries the negatives of its faces. */
  readonly values: readonly number[];
  readonly probs: readonly number[];
  readonly count: number;
}

const kindIn = (kind: PoolDieKind): { values: number[]; probs: number[]; count: number } => ({
  values: [...kind.values],
  probs: [...kind.probs],
  count: kind.count,
});

/**
 * Distribution of the pool's total (flats excluded). `budget` is the most dice that may be
 * rerolled, `rolls` how many whole rolls the best is chosen from (1 for none).
 */
export function rerollUpToPMF(poolKinds: readonly PoolDieKind[], budget: number, rolls: number, eps: number): PMF {
  return PMF._wrap(native.poolRerollUpToPmf(poolKinds.map(kindIn), budget, rolls, eps) as NativePmfHandle);
}

/**
 * Distribution of a pool's total (flats excluded) whose `repeatedKinds` dice are rolled `rolls`
 * times and whose `onceKinds` dice are rolled once: the roll of the repeated dice worth the most
 * once its rerolls are spent is kept, then up to `budget` dice of that roll and the once-rolled
 * dice are rerolled, keeping the new rolls.
 */
export function rerollUpToPartialPMF(
  repeatedKinds: readonly PoolDieKind[],
  onceKinds: readonly PoolDieKind[],
  budget: number,
  rolls: number,
  eps: number
): PMF {
  return PMF._wrap(
    native.poolRerollUpToPartialPmf(repeatedKinds.map(kindIn), onceKinds.map(kindIn), budget, rolls, eps) as NativePmfHandle
  );
}

/** The joint law of a single-kind pool's total and of whether the dice that land match. */
export interface PoolMatch {
  /** P(total = s), flats excluded. */
  readonly total: ReadonlyMap<number, number>;
  /** P(total = s and two or more of the dice that land show the same face). */
  readonly match: ReadonlyMap<number, number>;
}

/** Pools already walked: a pure function of the pool, so it never goes stale. Follows `setCachingEnabled`. */
const matchCache = new LRUCache<string, PoolMatch | null>(64, { followsCachingToggle: true });

/** Clears the reroll-pool match cache (reached through `clearAttackCache`). */
export function clearMatchCache(): void {
  matchCache.clear();
}

function pairs(flat: readonly number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i], flat[i + 1]);
  return map;
}

/**
 * The exact joint law of the total and of a match for a pool of `pool.count` identical dice that
 * may reroll up to `budget` of them, keeping the new rolls, and is rolled `rolls` times with the
 * best roll kept. `pool.values` are positive integers. Returns `null` when the pool is too large
 * to enumerate.
 */
export function rerollUpToMatch(pool: PoolDieKind, budget: number, rolls: number): PoolMatch | null {
  const key = `${pool.values.join(",")}|${pool.probs.join(",")}|${pool.count}|${Math.max(0, Math.floor(budget))}|${Math.max(1, Math.floor(rolls))}`;
  const cached = matchCache.get(key);
  if (cached !== undefined) return cached;
  const found = native.poolRerollUpToMatch(kindIn(pool), budget, rolls) as { total: number[]; match: number[] } | null | undefined;
  const result = found == null ? null : { total: pairs(found.total), match: pairs(found.match) };
  matchCache.set(key, result);
  return result;
}
