/**
 * Bounce odds — the "birthday problem" for bouncing damage dice (e.g. Chromatic
 * Orb): the probability that at least two of K dice with S faces show the same
 * value, which is what lets the spell jump to another target.
 *
 * Accounts for two modifiers:
 * - **Elemental Adept** (`minimumDieRoll >= 2`): rolls below the minimum are
 *   bumped up to it, collapsing the low faces onto a single heavier value.
 * - **Empowered Spell** (`rerollDamageDice > 0`): a number of dice may be
 *   rerolled once, giving a second chance at a match.
 *
 * The base and Elemental-Adept cases are computed exactly (see
 * {@link pAllDistinct}); the Empowered-Spell reroll is an explicit model layered
 * on the exact base match probability.
 */

/** Options that modify bounce odds via metamagic / feats. */
export interface BounceOddsOptions {
  /** Minimum die roll — e.g. 2 for Elemental Adept, 3 for Great Weapon Fighting 2024. */
  minimumDieRoll?: number;
  /** Number of dice that may be rerolled once — e.g. CHA modifier for Empowered Spell. */
  rerollDamageDice?: number;
}

/**
 * Exact per-face probability marginal for a single die, honoring threshold `reroll(k)` and
 * `minimum(v)` — the SAME two transforms `resolveSingleDie` (`builder/ast.ts`) applies, in the
 * same order (reroll, then minimum-floor), so a caller building `weights` for
 * `jointSumAndMatch`/`explodingPoolMatchProbability` gets face weights consistent with the pool's
 * actual resolved PMF. Returns a 1-indexed array (`weights[v - 1] = P(shows v)`, `1 <= v <= faces`);
 * a face collapsed onto by `minimum` carries its collapsed neighbors' mass, and a face below
 * `minimum` carries zero.
 */
export function faceWeights(faces: number, minimum = 0, reroll = 0): number[] {
  const f = Math.max(0, Math.floor(faces));
  if (f <= 0) return [];

  let weights = new Array<number>(f).fill(1 / f);

  const r = Math.max(0, Math.min(Math.floor(reroll), f));
  if (r > 0) {
    const rerollMass = r / f;
    const uniformReroll = rerollMass / f;
    weights = weights.map((_, i) => (i < r ? 0 : 1 / f) + uniformReroll);
  }

  const minV = Math.max(0, Math.floor(minimum));
  if (minV > 1) {
    const collapsed = new Array<number>(f).fill(0);
    for (let v = 1; v <= f; v++) {
      const target = Math.min(f, Math.max(v, minV));
      collapsed[target - 1] += weights[v - 1];
    }
    weights = collapsed;
  }

  return weights;
}

/** Binomial coefficient C(n, k), 0 for out-of-range k. */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

/**
 * Exact P(all K dice show distinct values) for a die with `uniformCount`
 * ordinary faces (each probability `1/faces`) plus one optional heavy face whose
 * probability is `heavyWeight` (used for the Elemental-Adept collapse; pass 0
 * for a plain die). Uses the elementary symmetric polynomial e_K over the face
 * probabilities: P(all distinct) = K! · e_K.
 */
function pAllDistinct(
  dice: number,
  faces: number,
  uniformCount: number,
  heavyWeight: number
): number {
  const light = 1 / faces;
  // e_K = (choose K distinct light faces) + (heavy face + K-1 light faces).
  const eK =
    binom(uniformCount, dice) * Math.pow(light, dice) +
    heavyWeight * binom(uniformCount, dice - 1) * Math.pow(light, dice - 1);
  let kFactorial = 1;
  for (let i = 2; i <= dice; i++) kFactorial *= i;
  return kFactorial * eK;
}

/** Exact P(at least one duplicate) among `dice` dice, honoring Elemental Adept. */
function pMatch(dice: number, faces: number, minimumDieRoll: number): number {
  if (dice <= 1) return 0;
  if (dice > faces) return 1;

  if (minimumDieRoll >= 2) {
    // Rolls 1..minimumDieRoll collapse onto the value `minimumDieRoll`, giving it
    // weight minimumDieRoll/faces; the faces above it stay uniform at 1/faces.
    const uniformCount = faces - minimumDieRoll; // values minimumDieRoll+1 .. faces
    const effectiveValues = uniformCount + 1; // + the collapsed value
    if (dice > effectiveValues) return 1;
    const heavyWeight = minimumDieRoll / faces;
    const distinct = pAllDistinct(dice, faces, uniformCount, heavyWeight);
    return Math.min(1, Math.max(0, 1 - distinct));
  }

  // Plain die: P(all distinct) = falling_factorial(faces, dice) / faces^dice.
  let pDistinct = 1;
  for (let i = 0; i < dice; i++) pDistinct *= (faces - i) / faces;
  return 1 - pDistinct;
}

/**
 * P(at least two of `diceCount` dice with `dieFaces` faces match), honoring
 * Elemental Adept and Empowered Spell. Returns a probability in [0, 1].
 *
 * @param diceCount Number of dice rolled.
 * @param dieFaces Faces per die (e.g. 8 for d8).
 * @param options Optional metamagic / feat modifiers.
 */
export function calculateBounceOdds(
  diceCount: number,
  dieFaces: number,
  options?: BounceOddsOptions
): number {
  if (diceCount <= 1) return 0;
  if (diceCount > dieFaces) return 1; // pigeonhole

  const minimumDieRoll = options?.minimumDieRoll ?? 0;
  const rerollDamageDice = options?.rerollDamageDice ?? 0;

  const pMatchFirst = pMatch(diceCount, dieFaces, minimumDieRoll);

  // Without Empowered Spell we're done.
  const rerollCount = Math.min(rerollDamageDice, diceCount);
  if (rerollCount <= 0) return pMatchFirst;

  // Empowered Spell: reroll `rerollCount` non-matching dice once. Model the
  // second chance as (a rerolled die matching one of the kept dice) OR (the
  // rerolled dice matching among themselves).
  const pNoMatchFirst = 1 - pMatchFirst;
  const keptDice = diceCount - rerollCount;
  const effectiveFaces = minimumDieRoll >= 2 ? dieFaces - (minimumDieRoll - 1) : dieFaces;

  // With no kept dice, a rerolled die vacuously "misses" all of them (prob 1), so
  // the only way to match is among the rerolled dice themselves (pRerolledMatch below).
  const pRerollDieMissesAll =
    keptDice > 0 ? Math.pow((effectiveFaces - keptDice) / effectiveFaces, rerollCount) : 1;
  const pAtLeastOneRerollMatches = 1 - pRerollDieMissesAll;
  const pRerolledMatch = rerollCount >= 2 ? pMatch(rerollCount, dieFaces, minimumDieRoll) : 0;
  const pMatchAfterReroll = Math.min(
    1,
    pAtLeastOneRerollMatches + pRerolledMatch * (1 - pAtLeastOneRerollMatches)
  );

  return Math.min(1, pMatchFirst + pNoMatchFirst * pMatchAfterReroll);
}

/**
 * Exact joint P(sum ∧ match), K = 2 hardcoded (per design: every shipped 5e bounce mechanic is
 * "two or more" — see `CHROMATIC_ORB.md`). `K > 2` (a face with multiplicity ≥ K) is a harder
 * combinatorial problem with no consumer; a `match` parameter whose only legal value is 2 would
 * advertise a generality this DP does not have, so it is not offered.
 *
 * `weights` is the resolved single-die marginal's per-face probabilities, 1-indexed
 * (`weights[v - 1] = P(one die shows v)`) — NOT assumed uniform, so `minimum`/threshold `reroll`
 * (which collapse or reweight faces) compose correctly. Dice are i.i.d. and homogeneous (same
 * `weights` for all of them): a mixed-face-size pool (e.g. 2d6 + 1d4) is a genuinely different,
 * harder problem (dice are no longer exchangeable) with no consumer here.
 */

/** Exact P(sum = s) for `dice` i.i.d. dice sharing `weights`, as a sum -> mass map. */
export function diceSumDistribution(dice: number, weights: readonly number[]): Map<number, number> {
  let dist = new Map<number, number>([[0, 1]]);
  for (let die = 0; die < dice; die++) {
    const next = new Map<number, number>();
    for (const [sum, mass] of dist) {
      for (let face = 1; face <= weights.length; face++) {
        const w = weights[face - 1] ?? 0;
        if (w <= 0) continue;
        const s = sum + face;
        next.set(s, (next.get(s) ?? 0) + mass * w);
      }
    }
    dist = next;
  }
  return dist;
}

/**
 * Exact P(sum = s ∧ all `dice` values distinct), via the elementary-symmetric DP over faces:
 * `dp[c+1][s+f] += dp[c][s] · w_f`, each face used at most once (0/1 knapsack over faces, tracking
 * both count and sum). `P(sum = s ∧ all distinct) = dice! · dp[dice][s]` — `dp[dice][s]` sums over
 * unordered subsets of `dice` distinct faces; multiplying by `dice!` accounts for every way to
 * assign that subset to the `dice` labeled dice.
 */
function sumAllDistinctDistribution(dice: number, weights: readonly number[]): Map<number, number> {
  const faceCount = weights.length;
  let dp = new Map<number, Map<number, number>>([[0, new Map([[0, 1]])]]);

  for (let face = 1; face <= faceCount; face++) {
    const w = weights[face - 1] ?? 0;
    const next = new Map<number, Map<number, number>>();
    for (const [count, sumMap] of dp) next.set(count, new Map(sumMap));

    if (w > 0) {
      for (const [count, sumMap] of dp) {
        const nextCount = count + 1;
        if (nextCount > dice) continue;
        const target = next.get(nextCount) ?? new Map<number, number>();
        for (const [sum, mass] of sumMap) {
          const s = sum + face;
          target.set(s, (target.get(s) ?? 0) + mass * w);
        }
        next.set(nextCount, target);
      }
    }
    dp = next;
  }

  let factorial = 1;
  for (let i = 2; i <= dice; i++) factorial *= i;

  const chosen = dp.get(dice) ?? new Map<number, number>();
  const result = new Map<number, number>();
  for (const [sum, mass] of chosen) result.set(sum, mass * factorial);
  return result;
}

/**
 * Exact joint P(sum = s ∧ match) for `dice` i.i.d. dice sharing `weights`
 * (`P(sum ∧ match) = P(sum) − P(sum ∧ all distinct)`). Returns a sum -> mass map; sums with zero
 * match mass are omitted. `dice <= 1` returns an empty map (no match possible).
 */
export function jointSumAndMatch(dice: number, weights: readonly number[]): Map<number, number> {
  if (dice <= 1) return new Map();

  const total = diceSumDistribution(dice, weights);
  const distinct = sumAllDistinctDistribution(dice, weights);

  const result = new Map<number, number>();
  for (const [sum, mass] of total) {
    const matchMass = Math.max(0, mass - (distinct.get(sum) ?? 0));
    if (matchMass > 0) result.set(sum, matchMass);
  }
  return result;
}

/**
 * The joint distribution over `(m, k)` — `m` dice landing on the pool's max face, `k` on anything
 * else — realized by the SAME `(pending, budget)` walk as the pool-wide exploding-dice DP
 * (`resolveExplodingPool` in `builder/ast.ts`): one traversal serves both the sum (there) and this
 * match composition (here), rather than each needing its own. `pMax` is the max face's probability
 * under the single die's resolved marginal.
 */
function explodingPoolMkDistribution(
  pMax: number,
  count: number,
  budget: number
): Map<string, number> {
  const binomial = (n: number, p: number): number[] => {
    const result = new Array<number>(n + 1).fill(0);
    result[0] = 1;
    for (let trial = 0; trial < n; trial++) {
      const next = new Array<number>(n + 1).fill(0);
      for (let successes = 0; successes <= trial; successes++) {
        const mass = result[successes];
        if (mass <= 0) continue;
        next[successes] += mass * (1 - p);
        next[successes + 1] += mass * p;
      }
      for (let i = 0; i <= n; i++) result[i] = next[i];
    }
    return result;
  };

  const memo = new Map<string, Map<string, number>>();
  const f = (pending: number, remainingBudget: number): Map<string, number> => {
    if (pending === 0) return new Map([["0,0", 1]]);
    if (remainingBudget === 0) {
      const binom = binomial(pending, pMax);
      const result = new Map<string, number>();
      for (let m = 0; m <= pending; m++) {
        const mass = binom[m];
        if (mass > 0) result.set(`${m},${pending - m}`, mass);
      }
      return result;
    }

    const key = `${pending},${remainingBudget}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const result = new Map<string, number>();
    const accumulate = (mk: string, mass: number): void => {
      result.set(mk, (result.get(mk) ?? 0) + mass);
    };

    for (const [mk, mass] of f(pending, remainingBudget - 1)) {
      const [m, k] = mk.split(",").map(Number);
      accumulate(`${m + 1},${k}`, mass * pMax);
    }
    for (const [mk, mass] of f(pending - 1, remainingBudget)) {
      const [m, k] = mk.split(",").map(Number);
      accumulate(`${m},${k + 1}`, mass * (1 - pMax));
    }

    memo.set(key, result);
    return result;
  };

  return f(count, budget);
}

/**
 * P(match) for a pool sharing ONE pool-wide exploding-dice budget (see
 * `RollBuilder.explodePool()`). The plain `jointSumAndMatch`/`calculateBounceOdds` formulas assume
 * `dice` i.i.d. dice — false for an exploded pool, since conditioning on a realized size already
 * reveals some die rolled max. Exploiting that max is the only exploding face: condition on `m`
 * (dice showing max) and `k` (dice showing anything else) —
 *
 * `m ≥ 2` → match is certain (two dice already share the max face).
 * `m ≤ 1` → match iff the `k` non-max dice collide among themselves, uniform over `faces - 1`
 *           non-max faces (they cannot collide with the max face, so the two parts separate).
 *
 * `pMax` and `faces` describe the single (non-exploding-budget) die's resolved marginal —
 * `pMax = weights[faces - 1]`.
 */
export function explodingPoolMatchProbability(
  pMax: number,
  faces: number,
  count: number,
  budget: number
): number {
  if (count <= 1) return 0;

  const mkDistribution = explodingPoolMkDistribution(pMax, count, budget);
  const nonMaxFaces = Math.max(1, faces - 1);

  let pMatchTotal = 0;
  for (const [mk, weight] of mkDistribution) {
    const [m, k] = mk.split(",").map(Number);
    if (m >= 2) {
      pMatchTotal += weight;
      continue;
    }
    let pAllDistinctAmongNonMax = 1;
    for (let i = 0; i < k; i++) {
      pAllDistinctAmongNonMax *= (nonMaxFaces - i) / nonMaxFaces;
    }
    pMatchTotal += weight * (1 - Math.max(0, pAllDistinctAmongNonMax));
  }
  return Math.min(1, Math.max(0, pMatchTotal));
}
