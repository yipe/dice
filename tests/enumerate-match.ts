/**
 * Brute force for the match odds of a pool of identical dice that may reroll up to k of them,
 * keeping the new rolls, alone or as the best of several rolls of the pool. Exact: every mass is a
 * BigInt over one denominator. Shares no code with the library.
 *
 * Every ordered roll of the pool is listed. The dice to reroll are found by trying EVERY subset of
 * at most `budget` dice and keeping the one with the most expected damage, ties going to fewer dice
 * (a die on its own mean gains nothing and stays), not by ranking the dice's gains. With several
 * rolls, every ordered choice of rolls is listed and the roll with the higher expected damage after
 * its own rerolls is used (the first of equals). Every fresh die is listed too. The dice that land
 * are the dice kept and the fresh ones; a match is two of them showing one face.
 */

export interface MatchOracle {
  /** P(total = s), the total being the sum of the dice that land. */
  total: Map<number, number>;
  /** P(total = s and two or more of the dice that land show one face). */
  match: Map<number, number>;
}

export interface PoolSpec {
  sides: number;
  count: number;
  minimum?: number;
  reroll?: number;
  /** Most dice that may be rerolled. */
  budget: number;
  /** Rolls of the pool to choose from (1 for none). */
  rolls?: number;
}

/** A die's faces from the rules, as integer weights over `sides ** 2`: reroll, then minimum. */
function faceWeights(sides: number, minimum: number, reroll: number): { faces: number[]; weights: bigint[]; denominator: bigint } {
  const weights = new Array<bigint>(sides + 1).fill(0n);
  const rerolled = Math.min(reroll, sides);
  for (let raw = 1; raw <= sides; raw++) {
    const value = Math.max(raw, minimum);
    if (raw > rerolled) weights[value] += BigInt(sides);
    if (raw <= rerolled) for (let fresh = 1; fresh <= sides; fresh++) weights[Math.max(fresh, minimum)] += 1n;
  }
  const faces: number[] = [];
  for (let value = 1; value <= sides; value++) if (weights[value] > 0n) faces.push(value);
  return { faces, weights, denominator: BigInt(sides) ** 2n };
}

function subsetsUpTo(count: number, budget: number): number[][] {
  const out: number[][] = [];
  const visit = (start: number, chosen: number[]): void => {
    out.push([...chosen]);
    if (chosen.length === budget) return;
    for (let i = start; i < count; i++) visit(i + 1, [...chosen, i]);
  };
  visit(0, []);
  return out;
}

export function poolMatchOracle(spec: PoolSpec): MatchOracle {
  const { sides, count, budget } = spec;
  const rolls = spec.rolls ?? 1;
  const { faces, weights, denominator } = faceWeights(sides, spec.minimum ?? 0, spec.reroll ?? 0);
  // Expected value of one die, times the denominator.
  let meanNumerator = 0n;
  for (const face of faces) meanNumerator += BigInt(face) * weights[face];

  const subsets = subsetsUpTo(count, Math.min(budget, count));
  const maxRerolled = Math.min(budget, count);

  interface Roll {
    dice: number[];
    weight: bigint;
    kept: number[];
    rerolled: number;
    score: bigint;
  }
  const listed: Roll[] = [];
  const visit = (dice: number[], weight: bigint): void => {
    if (dice.length < count) {
      for (const face of faces) visit([...dice, face], weight * weights[face]);
      return;
    }
    let best: number[] | undefined;
    let bestScore = 0n;
    for (const subset of subsets) {
      const chosen = new Set(subset);
      let kept = 0n;
      dice.forEach((face, i) => {
        if (!chosen.has(i)) kept += BigInt(face);
      });
      const score = kept * denominator + BigInt(subset.length) * meanNumerator;
      if (best === undefined || score > bestScore || (score === bestScore && subset.length < best.length)) {
        best = subset;
        bestScore = score;
      }
    }
    const chosen = new Set(best);
    listed.push({
      dice,
      weight,
      kept: dice.filter((_, i) => !chosen.has(i)),
      rerolled: (best as number[]).length,
      score: bestScore,
    });
  };
  visit([], 1n);

  const total = new Map<number, bigint>();
  const match = new Map<number, bigint>();
  // Each ordered set of fresh dice has weight prod(weights); the ones for j dice are scaled to the
  // denominator of the most dice that can be rerolled, so every mass shares one denominator.
  const land = (roll: Roll, weight: bigint): void => {
    const fresh: number[] = [];
    const place = (w: bigint): void => {
      if (fresh.length < roll.rerolled) {
        for (const face of faces) {
          fresh.push(face);
          place(w * weights[face]);
          fresh.pop();
        }
        return;
      }
      const landed = [...roll.kept, ...fresh];
      const sum = landed.reduce((a, b) => a + b, 0);
      const scaled = w * denominator ** BigInt(maxRerolled - roll.rerolled);
      total.set(sum, (total.get(sum) ?? 0n) + scaled);
      if (new Set(landed).size < landed.length) match.set(sum, (match.get(sum) ?? 0n) + scaled);
    };
    place(weight);
  };

  if (rolls === 1) {
    for (const roll of listed) land(roll, roll.weight);
  } else {
    // Ordered choices of rolls: the best score is kept, the earliest of equals.
    const choose = (chosen: Roll[], weight: bigint): void => {
      if (chosen.length < rolls) {
        for (const roll of listed) choose([...chosen, roll], weight * roll.weight);
        return;
      }
      let best = chosen[0];
      for (const roll of chosen) if (roll.score > best.score) best = roll;
      land(best, weight);
    };
    choose([], 1n);
  }

  const grand = [...total.values()].reduce((a, b) => a + b, 0n);
  const ratio = (mass: bigint): number => Number(mass) / Number(grand);
  const out: MatchOracle = { total: new Map(), match: new Map() };
  for (const [sum, mass] of total) out.total.set(sum, ratio(mass));
  for (const [sum, mass] of match) out.match.set(sum, ratio(mass));
  return out;
}
