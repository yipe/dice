import { PMF } from "../pmf/pmf";

/**
 * Exact distribution of a dice pool that may reroll up to k of its dice once every die is seen,
 * keeping each new roll ("Empowered Spell", "Piercer"), optionally chosen from several rolls of the
 * pool ("Savage Attacker" plus a reroll budget).
 *
 * Policy. Total damage is linear in the dice, so the best reroll set is the up-to-k dice with the
 * largest POSITIVE expected gain `mean - shown` (a subtracted die is its negated faces, so it
 * gains when it shows high). A die on its own mean gains nothing and stays. Dice of one kind are
 * interchangeable, so only ties between different kinds need a rule: the kind with the higher
 * mean rerolls first (then the lower faces key), so the result never depends on the order the die
 * groups were added in. A rerolled die is a fresh roll of the same die under its own
 * reroll/minimum, so a die's faces are its resolved single-die PMF.
 *
 * With `rolls` above 1 the pool is rolled that many times; each roll is scored by its expected
 * total after its own optimal rerolls (`kept faces + means of the rerolled dice`), the highest
 * score is kept, and only that roll is rerolled. Rolls are exchangeable, so which of two equally
 * worth rolls is kept, the first or the second, gives the same distribution.
 */

/** One kind of die in the pool: `count` interchangeable dice showing `values` with `probs`. */
export interface PoolDieKind {
  /** Signed face values: a subtracted die carries the negatives of its faces. */
  readonly values: readonly number[];
  readonly probs: readonly number[];
  readonly count: number;
}

type Dist = Map<number, number>;

/**
 * Gains and scores are compared on this grid (1e-9), so equal true values that differ in the last
 * float bits tie, and a gain below half a grid step counts as none.
 */
const GRID = 1e9;

interface Kind {
  readonly key: string;
  readonly values: readonly number[];
  readonly probs: readonly number[];
  readonly count: number;
  readonly mean: number;
  readonly single: Dist;
}

interface Face {
  readonly kind: number;
  readonly value: number;
  readonly p: number;
  /** Gain of rerolling this face, in grid steps. */
  readonly gain: number;
  /** Probability this kind's die shows this face or one after it, and one after it. */
  readonly remaining: number;
  readonly after: number;
}

/**
 * Dice with the same faces are one kind. Kinds come out in a canonical order (higher mean first,
 * then by faces), which is the order that settles ties for the reroll budget.
 */
function mergeKinds(kinds: readonly PoolDieKind[]): Kind[] {
  const byKey = new Map<string, { kind: PoolDieKind; count: number }>();
  for (const kind of kinds) {
    if (!(kind.count > 0) || kind.values.length === 0) continue;
    const key = `${kind.values.join(",")}|${kind.probs.join(",")}`;
    const existing = byKey.get(key);
    if (existing) existing.count += kind.count;
    else byKey.set(key, { kind, count: kind.count });
  }
  const merged = [...byKey].map(([key, { kind, count }]) => {
    const single: Dist = new Map();
    let mean = 0;
    kind.values.forEach((value, i) => {
      single.set(value, (single.get(value) ?? 0) + kind.probs[i]);
      mean += value * kind.probs[i];
    });
    return { key, values: kind.values, probs: kind.probs, count, mean, single };
  });
  merged.sort((a, b) => Math.round((b.mean - a.mean) * GRID) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return merged;
}

function convolve(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [x, px] of a) {
    for (const [y, py] of b) out.set(x + y, (out.get(x + y) ?? 0) + px * py);
  }
  return out;
}

/** P(X = x) for x in 0..r, X ~ Binomial(r, p), with `q = 1 - p` passed in for accuracy near 1. */
function binomialWeights(r: number, p: number, q: number): number[] {
  const weights = new Array<number>(r + 1).fill(0);
  if (q <= 0) {
    weights[r] = 1;
    return weights;
  }
  if (p <= 0) {
    weights[0] = 1;
    return weights;
  }
  // Counting failures instead keeps the start term q^r away from underflow when p is large.
  if (p > q) return binomialWeights(r, q, p).reverse();
  weights[0] = Math.pow(q, r);
  const ratio = p / q;
  for (let x = 1; x <= r; x++) weights[x] = ((weights[x - 1] * (r - x + 1)) / x) * ratio;
  return weights;
}

/**
 * The faces of every kind in the order dice claim the reroll budget: largest gain first, ties to
 * the earlier kind. Each face carries the conditional probability a still-unplaced die of its kind
 * shows it, given it shows this face or a later one.
 */
function orderedFaces(kinds: readonly Kind[]): Face[] {
  const faces: Omit<Face, "remaining" | "after">[] = [];
  kinds.forEach((kind, index) => {
    kind.values.forEach((value, i) => {
      const p = kind.probs[i];
      if (p > 0) faces.push({ kind: index, value, p, gain: Math.round((kind.mean - value) * GRID) });
    });
  });
  faces.sort((a, b) => b.gain - a.gain || a.kind - b.kind || a.value - b.value);
  const later = kinds.map(() => 0);
  const withMass = new Array<Face>(faces.length);
  for (let j = faces.length - 1; j >= 0; j--) {
    const face = faces[j];
    withMass[j] = { ...face, after: later[face.kind], remaining: later[face.kind] + face.p };
    later[face.kind] += face.p;
  }
  return withMass;
}

/**
 * Distribution of the pool's total (flats excluded). `budget` is the most dice that may be
 * rerolled, `rolls` how many whole rolls the best is chosen from (1 for none).
 *
 * DP over the faces, highest gain first, after keepSumPMF: the state is which dice of each kind
 * are still unplaced and how many of each kind were rerolled, holding the distribution of the
 * kept faces' sum. Placing the dice that show one face is a binomial draw among the unplaced dice
 * of its kind; the first `budget - rerolled` of those with positive gain are rerolled, the rest
 * kept. A rerolled die's new roll is independent of everything else, so it is added at the end
 * from the per-kind count rerolled.
 */
export function rerollUpToPMF(
  poolKinds: readonly PoolDieKind[],
  budget: number,
  rolls: number,
  eps: number
): PMF {
  const kinds = mergeKinds(poolKinds);
  if (kinds.length === 0) return PMF.delta(0, eps);

  const dice = kinds.reduce((total, kind) => total + kind.count, 0);
  const capacity = Math.min(Math.max(0, Math.floor(budget)), dice);
  const trials = Math.max(1, Math.floor(rolls));

  // State key = rerolledIndex * R + unplacedIndex, each a mixed-radix number over the kinds.
  const unplacedDigits = kinds.map((kind) => kind.count + 1);
  const rerolledDigits = kinds.map((kind) => Math.min(kind.count, capacity) + 1);
  const unplacedStride: number[] = [];
  const rerolledStride: number[] = [];
  let R = 1;
  let U = 1;
  kinds.forEach((_, t) => {
    unplacedStride.push(R);
    R *= unplacedDigits[t];
    rerolledStride.push(U);
    U *= rerolledDigits[t];
  });
  if (!Number.isSafeInteger(R * U)) {
    throw new Error("rerollUpTo(): the pool has too many dice of too many kinds to enumerate.");
  }
  const rerolledOf = (rerolledIndex: number, t: number) =>
    Math.floor(rerolledIndex / rerolledStride[t]) % rerolledDigits[t];

  const usedMemo: (number | undefined)[] = [];
  let start = 0;
  kinds.forEach((kind, t) => (start += kind.count * unplacedStride[t]));
  let state = new Map<number, Dist>([[start, new Map([[0, 1]])]]);

  for (const face of orderedFaces(kinds)) {
    const t = face.kind;
    const canReroll = face.gain > 0;
    const pCond = Math.min(1, face.p / face.remaining);
    const qCond = face.after / face.remaining;
    const next = new Map<number, Dist>();
    const shownBy: (number[] | undefined)[] = [];

    for (const [key, sums] of state) {
      const unplaced = Math.floor((key % R) / unplacedStride[t]) % unplacedDigits[t];
      if (unplaced === 0) {
        const kept = next.get(key) ?? new Map<number, number>();
        for (const [sum, pr] of sums) kept.set(sum, (kept.get(sum) ?? 0) + pr);
        next.set(key, kept);
        continue;
      }

      const rerolledIndex = Math.floor(key / R);
      let used = usedMemo[rerolledIndex];
      if (used === undefined) {
        used = 0;
        for (let kind = 0; kind < kinds.length; kind++) used += rerolledOf(rerolledIndex, kind);
        usedMemo[rerolledIndex] = used;
      }
      const shown = (shownBy[unplaced] ??= binomialWeights(unplaced, pCond, qCond));

      for (let x = 0; x <= unplaced; x++) {
        const px = shown[x];
        if (px <= eps) continue;
        const rerolled = canReroll ? Math.min(x, capacity - used) : 0;
        const destKey = key - x * unplacedStride[t] + rerolled * rerolledStride[t] * R;
        const add = (x - rerolled) * face.value;
        const dest = next.get(destKey) ?? new Map<number, number>();
        for (const [sum, pr] of sums) {
          const total = sum + add;
          const mass = (dest.get(total) ?? 0) + pr * px;
          if (mass >= eps) dest.set(total, mass);
        }
        if (dest.size > 0) next.set(destKey, dest);
      }
    }
    state = next;
  }

  // Every die is placed: the states with no unplaced dice, one per rerolled-count vector.
  const finals = new Map<number, Dist>();
  for (const [key, sums] of state) {
    if (key % R === 0) finals.set(key / R, sums);
  }

  const fresh = kinds.map((kind, t) => {
    const powers: Dist[] = [new Map([[0, 1]])];
    for (let j = 1; j < rerolledDigits[t]; j++) powers.push(convolve(powers[j - 1], kind.single));
    return powers;
  });
  const freshMemo = new Map<number, Dist>();
  const freshOf = (rerolledIndex: number): Dist => {
    const cached = freshMemo.get(rerolledIndex);
    if (cached) return cached;
    let dist: Dist = new Map([[0, 1]]);
    kinds.forEach((_, t) => (dist = convolve(dist, fresh[t][rerolledOf(rerolledIndex, t)])));
    freshMemo.set(rerolledIndex, dist);
    return dist;
  };
  const meanOfRerolled = (rerolledIndex: number): number =>
    kinds.reduce((total, kind, t) => total + kind.mean * rerolledOf(rerolledIndex, t), 0);

  // Which roll is kept: each roll's score is its kept sum plus the means of the dice it rerolls.
  // Roll i of `trials` is kept when every earlier roll scores strictly less and every later one at
  // most as much, so a score s carries weight sum_i below^(i-1) * atOrBelow^(trials-i).
  let weightOf: ((score: number) => number) | undefined;
  if (trials > 1) {
    const scoreMass = new Map<number, number>();
    for (const [rerolledIndex, sums] of finals) {
      const offset = meanOfRerolled(rerolledIndex);
      for (const [sum, pr] of sums) {
        const grid = Math.round((sum + offset) * GRID);
        scoreMass.set(grid, (scoreMass.get(grid) ?? 0) + pr);
      }
    }
    const weights = new Map<number, number>();
    let below = 0;
    for (const grid of [...scoreMass.keys()].sort((a, b) => a - b)) {
      const atOrBelow = below + (scoreMass.get(grid) as number);
      let weight = 0;
      for (let i = 0; i < trials; i++) weight += Math.pow(below, i) * Math.pow(atOrBelow, trials - 1 - i);
      weights.set(grid, weight);
      below = atOrBelow;
    }
    weightOf = (score) => weights.get(Math.round(score * GRID)) as number;
  }

  const out: Dist = new Map();
  for (const [rerolledIndex, sums] of finals) {
    const newRolls = freshOf(rerolledIndex);
    const offset = weightOf ? meanOfRerolled(rerolledIndex) : 0;
    for (const [sum, pr] of sums) {
      const kept = weightOf ? pr * weightOf(sum + offset) : pr;
      for (const [roll, pf] of newRolls) out.set(sum + roll, (out.get(sum + roll) ?? 0) + kept * pf);
    }
  }
  return PMF.fromMap(out, eps);
}
