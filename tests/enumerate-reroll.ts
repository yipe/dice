import type { Dist } from "./enumerate-dice";

/**
 * Brute force for "reroll up to k dice, keep the new rolls": every roll of the pool is listed, the
 * best reroll set of each is found by trying EVERY subset of at most k dice (not by ranking gains),
 * and each rerolled die's new roll is listed too. Shares no code with the library.
 */

/** One die of the pool: its signed face values and their probabilities. */
export interface OracleDie {
  faces: Dist;
}

const TOLERANCE = 1e-9;

/**
 * A die's faces read from the rules: a raw face 1..`reroll` is rerolled once and the new roll is
 * kept, then `minimum` floors each shown face; `negate` makes it a subtracted die.
 */
export function ruleDie(
  sides: number,
  { minimum = 0, reroll = 0, negate = false }: { minimum?: number; reroll?: number; negate?: boolean } = {}
): OracleDie {
  const faces: Dist = new Map();
  const put = (raw: number, p: number): void => {
    const value = (negate ? -1 : 1) * Math.max(raw, minimum);
    faces.set(value, (faces.get(value) ?? 0) + p);
  };
  const rerolled = Math.min(reroll, sides);
  for (let raw = 1; raw <= sides; raw++) {
    if (raw > rerolled) put(raw, 1 / sides);
    for (let fresh = 1; fresh <= sides && raw <= rerolled; fresh++) put(fresh, 1 / (sides * sides));
  }
  return { faces };
}

function meanOf(faces: Dist): number {
  let mean = 0;
  for (const [value, p] of faces) mean += value * p;
  return mean;
}

/**
 * Dice with the same faces are one kind. Kinds are ranked by the rule that settles equal gains:
 * higher mean first, then the faces read as text.
 */
function kindIds(dice: readonly OracleDie[]): number[] {
  const keys = dice.map((die) => JSON.stringify([...die.faces].sort((a, b) => a[0] - b[0])));
  const meanByKey = new Map(dice.map((die, i) => [keys[i], meanOf(die.faces)]));
  const ranked = [...meanByKey.keys()].sort(
    (a, b) => (meanByKey.get(b) as number) - (meanByKey.get(a) as number) || (a < b ? -1 : a > b ? 1 : 0)
  );
  return keys.map((key) => ranked.indexOf(key));
}

interface RollOutcome {
  p: number;
  /** Expected total once the best reroll set is used. */
  score: number;
  /** Distribution of the total after the reroll. */
  after: Dist;
}

/** Every roll of `dice` with its best reroll set, found by trying every subset of at most `budget` dice. */
function enumerateRolls(dice: readonly OracleDie[], budget: number): RollOutcome[] {
  const n = dice.length;
  const means = dice.map((die) => meanOf(die.faces));
  const kinds = kindIds(dice);
  const outcomes: RollOutcome[] = [];

  const visit = (index: number, values: number[], p: number): void => {
    if (index < n) {
      for (const [value, pv] of dice[index].faces) visit(index + 1, [...values, value], p * pv);
      return;
    }

    // Best subset: highest expected total; ties to fewer dice, then to the earlier kinds' dice.
    let best: { set: number[]; expected: number } | undefined;
    const tieKey = (set: number[]): number[] => [set.length, ...set.map((i) => kinds[i] * 1000 + i).sort((a, b) => a - b)];
    const earlier = (a: number[], b: number[]): boolean => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i];
      return a.length < b.length;
    };
    for (let mask = 0; mask < 1 << n; mask++) {
      const set = [...Array(n).keys()].filter((i) => mask & (1 << i));
      if (set.length > budget) continue;
      const expected = values.reduce((total, v, i) => total + (set.includes(i) ? means[i] : v), 0);
      if (
        !best ||
        expected > best.expected + TOLERANCE ||
        (Math.abs(expected - best.expected) <= TOLERANCE && earlier(tieKey(set), tieKey(best.set)))
      ) {
        best = { set, expected };
      }
    }

    let after: Dist = new Map([[values.reduce((total, v, i) => total + (best!.set.includes(i) ? 0 : v), 0), 1]]);
    for (const i of best!.set) {
      const next: Dist = new Map();
      for (const [total, pt] of after) {
        for (const [value, pv] of dice[i].faces) next.set(total + value, (next.get(total + value) ?? 0) + pt * pv);
      }
      after = next;
    }
    outcomes.push({ p, score: best!.expected, after });
  };
  visit(0, [], 1);
  return outcomes;
}

/**
 * Distribution of the pool's total when up to `budget` dice are rerolled for the best expected
 * total and the new rolls are kept. With `rolls` above 1 the pool is rolled that many times,
 * the roll with the highest such expected total is used (the first on a tie: which of equal rolls
 * is kept does not change the distribution), and only it is
 * rerolled.
 */
export function bruteForceRerollUpTo(dice: readonly OracleDie[], budget: number, rolls = 1): Dist {
  const outcomes = enumerateRolls(dice, budget);
  const chosenMass = new Array<number>(outcomes.length).fill(0);

  // List every sequence of `rolls` rolls; the leader changes only for a strictly better score, so
  // the first of equal scores stays.
  const list = (trial: number, leader: number, p: number): void => {
    if (trial === rolls) {
      chosenMass[leader] += p;
      return;
    }
    outcomes.forEach((outcome, i) => {
      const next = leader < 0 || outcome.score > outcomes[leader].score + TOLERANCE ? i : leader;
      list(trial + 1, next, p * outcome.p);
    });
  };
  list(0, -1, 1);

  const out: Dist = new Map();
  outcomes.forEach((outcome, i) => {
    for (const [total, p] of outcome.after) out.set(total, (out.get(total) ?? 0) + chosenMass[i] * p);
  });
  return out;
}

/**
 * Distribution of a pool whose `repeated` dice are rolled `rolls` times and whose `once` dice are
 * rolled once (Savage Attacker on the weapon dice beside a rider's dice), then up to `budget` dice
 * of the kept roll and the once-rolled dice are rerolled, the new rolls kept (Piercer). Every roll
 * of every die is listed; for each, every repeated roll is tried with every subset of at most
 * `budget` of its dice and the once dice, and the roll and subset with the highest expected total
 * are played (the first roll on a tie, which does not change the distribution; ties between
 * subsets as {@link bruteForceRerollUpTo} settles them).
 */
export function bruteForcePartialRerollUpTo(
  repeated: readonly OracleDie[],
  once: readonly OracleDie[],
  budget: number,
  rolls: number
): Dist {
  const dice = [...repeated, ...once];
  const means = dice.map((die) => meanOf(die.faces));
  const kinds = kindIds(dice);
  const tieKey = (set: number[]): number[] => [set.length, ...set.map((i) => kinds[i] * 1000 + i).sort((a, b) => a - b)];
  const earlier = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i];
    return a.length < b.length;
  };

  /** Every joint roll of `pool`: the faces in order and their probability. */
  const rollsOf = (pool: readonly OracleDie[]): [number[], number][] => {
    let out: [number[], number][] = [[[], 1]];
    for (const die of pool) {
      const next: [number[], number][] = [];
      for (const [values, p] of out) for (const [value, pv] of die.faces) next.push([[...values, value], p * pv]);
      out = next;
    }
    return out;
  };
  const repeatedRolls = rollsOf(repeated);
  const onceRolls = rollsOf(once);

  /** The best subset of `values` (repeated then once) to reroll, by trying every one. */
  const bestSet = (values: number[]): { set: number[]; expected: number } => {
    let best: { set: number[]; expected: number } | undefined;
    for (let mask = 0; mask < 1 << dice.length; mask++) {
      const set = [...Array(dice.length).keys()].filter((i) => mask & (1 << i));
      if (set.length > budget) continue;
      const expected = values.reduce((total, v, i) => total + (set.includes(i) ? means[i] : v), 0);
      if (
        !best ||
        expected > best.expected + TOLERANCE ||
        (Math.abs(expected - best.expected) <= TOLERANCE && earlier(tieKey(set), tieKey(best.set)))
      ) {
        best = { set, expected };
      }
    }
    return best!;
  };

  const out: Dist = new Map();
  const play = (trial: number, leader: { values: number[]; set: number[]; expected: number } | undefined, onceValues: number[], p: number): void => {
    if (trial === rolls) {
      let after: Dist = new Map([[leader!.values.reduce((total, v, i) => total + (leader!.set.includes(i) ? 0 : v), 0), 1]]);
      for (const i of leader!.set) {
        const next: Dist = new Map();
        for (const [total, pt] of after) {
          for (const [value, pv] of dice[i].faces) next.set(total + value, (next.get(total + value) ?? 0) + pt * pv);
        }
        after = next;
      }
      for (const [total, pt] of after) out.set(total, (out.get(total) ?? 0) + p * pt);
      return;
    }
    for (const [values, pv] of repeatedRolls) {
      const all = [...values, ...onceValues];
      const candidate = { values: all, ...bestSet(all) };
      const next = !leader || candidate.expected > leader.expected + TOLERANCE ? candidate : leader;
      play(trial + 1, next, onceValues, p * pv);
    }
  };
  for (const [onceValues, p] of onceRolls) play(0, undefined, onceValues, p);
  return out;
}
