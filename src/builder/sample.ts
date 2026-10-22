/**
 * One random draw of a roll AST, the sampling twin of `resolve` in `./ast`: every node kind here
 * mirrors its PMF branch, so a sample's law is the PMF.
 *
 * Draw order (what a scripted or traced `Rng` sees) is deterministic: depth-first, children left to
 * right, in the AST's source order. A die's reroll and then its explosions follow that die at once;
 * a `sum` draws all `count` children, then any `explodePool` extras; `keep`, `d20Roll`, `maxOf` and
 * `max` draw their trials in order; `rerollUpTo` draws every trial's whole pool, then the winning
 * trial's rerolls in pool order. `dice` lists the physical dice in that same order.
 */
import type { Rng } from "../common/rng";
import { scaleValue } from "../pmf/sample";
import {
  astFromRollConfigs,
  dieNodeFromConfig,
  findDie,
  getTotalCount,
  naturalDieConfig,
  rerollablePool,
  resolveSingleDie,
} from "./ast";
import type { DieNode, ExpressionNode } from "./nodes";
import type { RollBuilder } from "./roll";

/** One physical die of a sample. `kept` is false for a die the roll dropped (rerolled away, lost a keep). */
export interface SampledDie {
  sides: number;
  face: number;
  kept: boolean;
  reroll?: true;
}

export interface RollSample {
  total: number;
  dice: SampledDie[];
}

/** The dice of one check draw: the natural roll (dropped d20s `kept: false`), then every bonus die. */
export interface CheckDice {
  check: SampledDie[];
  /** The natural roll's kept face; 0 for a check with no die. */
  natural: number;
  /** The bonus dice's sum, penalty dice subtracted. */
  bonus: number;
}

/**
 * The sampling twin of `resolveRootD20`: one draw of the natural die under its roll type (the
 * dice in roll order), then of each bonus die group in config order. The flat modifier is not
 * added; the caller reads `check.modifier`.
 */
export function sampleCheckDice(check: RollBuilder, rng: Rng): CheckDice {
  const dice: SampledDie[] = [];
  let natural = 0;
  const root = naturalDieConfig(check);
  if (root) {
    const die = dieNodeFromConfig(root);
    const rollType = check.rollType;
    const s = sampleNode(rollType === "flat" ? die : { type: "d20Roll", rollType, child: die }, rng);
    natural = s.total;
    dice.push(...s.dice);
  }
  let bonus = 0;
  for (const config of check.getBonusDiceConfigs()) {
    const s = sampleNode(astFromRollConfigs([config])!, rng);
    bonus += s.total;
    dice.push(...s.dice);
  }
  return { check: dice, natural, bonus };
}

/** Gains and scores compare on the same grid as `reroll-pool.ts`, so float noise never flips a choice. */
const GRID = 1e9;

const dropped = (dice: readonly SampledDie[]): SampledDie[] => dice.map((x) => ({ ...x, kept: false }));

/**
 * One die under its own reroll (once, keeping the new roll), minimum and per-die explode: the
 * sampling twin of `resolveSingleDie`.
 */
export function sampleDie(die: DieNode, rng: Rng): { face: number; dice: SampledDie[] } {
  const sides = Math.max(0, Math.floor(die.sides));
  if (sides <= 0) return { face: 0, dice: [] };
  const rerollAtOrBelow = Math.min(Math.max(0, Math.floor(die.reroll ?? 0)), sides);
  const minimum = Math.max(0, Math.floor(die.minimum ?? 0));
  const times = Math.floor(die.explode ?? 0);
  const dice: SampledDie[] = [];
  const one = (): number => {
    let face = rng.die(sides);
    let reroll: { reroll: true } | undefined;
    if (face <= rerollAtOrBelow) {
      dice.push({ sides, face, kept: false });
      face = rng.die(sides);
      reroll = { reroll: true };
    }
    face = Math.max(face, minimum);
    dice.push({ sides, face, kept: true, ...reroll });
    return face;
  };
  let total = one();
  // Only the max face chains, at most `times` extra dice; a die that always shows its max
  // (one-sided, or `minimum` at `sides`) explodes exactly `times` times.
  for (let extra = 0; extra < times && dice[dice.length - 1].face === sides; extra++) total += one();
  return { face: total, dice };
}

/** The highest total wins; ties go to the earliest roll. `lowest` flips the comparison. */
function keepBest(rolls: readonly RollSample[], lowest = false): RollSample {
  let best = 0;
  rolls.forEach((s, i) => {
    if (lowest ? s.total < rolls[best].total : s.total > rolls[best].total) best = i;
  });
  return {
    total: rolls[best].total,
    dice: rolls.flatMap((s, i) => (i === best ? s.dice : dropped(s.dice))),
  };
}

export function sampleNode(node: ExpressionNode, rng: Rng): RollSample {
  switch (node.type) {
    case "constant":
      return { total: node.value, dice: [] };

    case "die": {
      const s = sampleDie(node, rng);
      return { total: s.face, dice: s.dice };
    }

    case "sum": {
      const n = Math.max(0, Math.floor(node.count));
      const dice: SampledDie[] = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const s = sampleNode(node.child, rng);
        total += s.total;
        dice.push(...s.dice);
      }
      const budget = Math.floor(node.explodePoolBudget ?? 0);
      if (n > 0 && budget > 0) {
        const die = findDie(node.child);
        if (!die) throw new Error("explodePool() requires the pool's child to be a plain die.");
        // `resolveExplodingPool`: each max face showing spends one budget on one more die, which
        // may itself show max; stops when no max face is pending or the budget is spent.
        let pending = dice.filter((x) => x.kept && x.face === die.sides).length;
        for (let left = budget; pending > 0 && left > 0; left--) {
          const s = sampleDie({ ...die, explode: 0 }, rng);
          total += s.face;
          dice.push(...s.dice);
          pending += s.face === die.sides ? 0 : -1;
        }
      }
      return { total, dice };
    }

    case "add": {
      const dice: SampledDie[] = [];
      let total = 0;
      for (const c of node.children) {
        const s = sampleNode(c.node, rng);
        total += c.sign * s.total;
        dice.push(...s.dice);
      }
      return { total, dice };
    }

    case "keep": {
      const trials = getTotalCount(node);
      const k = Math.max(0, Math.min(node.count, trials));
      const samples = Array.from({ length: trials }, () => sampleNode(node.child.child, rng));
      const order = samples
        .map((_, i) => i)
        .sort((a, b) => {
          const diff = samples[b].total - samples[a].total;
          return (node.mode === "highest" ? diff : -diff) || a - b;
        });
      const kept = new Set(order.slice(0, k));
      let total = 0;
      const dice: SampledDie[] = [];
      samples.forEach((s, i) => {
        if (kept.has(i)) {
          total += s.total;
          dice.push(...s.dice);
        } else {
          dice.push(...dropped(s.dice));
        }
      });
      return { total, dice };
    }

    case "d20Roll": {
      const n = node.rollType === "elven accuracy" ? 3 : 2;
      const rolls = Array.from({ length: n }, () => sampleNode(node.child, rng));
      return keepBest(rolls, node.rollType === "disadvantage");
    }

    case "half": {
      const s = sampleNode(node.child, rng);
      return { total: scaleValue(s.total, 0.5, "floor"), dice: s.dice };
    }

    case "scale": {
      const s = sampleNode(node.child, rng);
      const denominator = node.denominator === 0 ? 1 : node.denominator;
      return { total: scaleValue(s.total, node.numerator, node.rounding, denominator), dice: s.dice };
    }

    case "maxOf": {
      const count = Math.max(1, Math.floor(node.count));
      return keepBest(Array.from({ length: count }, () => sampleNode(node.child, rng)));
    }

    case "max":
      return keepBest(node.children.map((c) => sampleNode(c, rng)));

    case "rerollUpTo":
      return sampleRerollUpTo(node.child, node.budget, node.rolls, rng, node.rolledOnce);
  }
}

/** One die group of a `rerollUpTo` pool, in the order the child lists it. */
interface PoolKind {
  die: DieNode;
  count: number;
  sign: 1 | -1;
  /** Mean of the signed faces: what a reroll of this kind is worth. */
  mean: number;
  /** Position in `mergeKinds` order (higher mean first, then the faces key): breaks gain ties. */
  rank: number;
}

interface PoolDie {
  kind: number;
  /** Signed face. */
  value: number;
  dice: SampledDie[];
}

interface PoolRoll {
  pool: PoolDie[];
  /** Indices into `pool` then the rolled-once dice to reroll, the up-to-`budget` dice with the largest positive gain. */
  chosen: Set<number>;
  /** Kept faces plus the means of the rerolled dice: the roll's worth after its rerolls. */
  score: number;
}

/**
 * The `reroll-pool.ts` policy: reroll the up-to-`budget` dice with the largest positive expected
 * gain `mean - shown`, ties to the kind with the higher mean (then the lower faces key), then to
 * the lower face. With `rolls` above 1 the pool is rolled that many times and the roll scoring
 * highest is the one rerolled; a tie keeps the earlier roll. `rolledOnce` dice are drawn once,
 * after every roll of the pool, and are scored and rerolled with each roll.
 *
 * The dice are drawn and emitted in the child's source order (`roll(2, 6).plus(d8)` draws d6, d6,
 * d8), the rolled-once dice after; the canonical mean order only settles which dice take the budget.
 */
function sampleRerollUpTo(
  child: ExpressionNode,
  budget: number,
  rolls: number,
  rng: Rng,
  rolledOnce?: ExpressionNode
): RollSample {
  const own = rerollablePool(child);
  const once = rolledOnce ? rerollablePool(rolledOnce) : { groups: [], flat: 0 };
  const ownGroups = own.groups.length;
  const scored = [...own.groups, ...once.groups].map(({ die, count, sign }) => {
    const single = resolveSingleDie(die);
    const faces = single.support();
    const mean = faces.reduce((m, f) => m + sign * f * single.pAt(f), 0);
    const key = `${faces.map((f) => sign * f).join(",")}|${faces.map((f) => single.pAt(f)).join(",")}`;
    return { die, count, sign, mean, key };
  });
  const canonical = scored
    .map((_, i) => i)
    .sort((a, b) => {
      const byMean = Math.round((scored[b].mean - scored[a].mean) * GRID);
      return byMean || (scored[a].key < scored[b].key ? -1 : scored[a].key > scored[b].key ? 1 : 0);
    });
  const kinds: PoolKind[] = scored.map(({ die, count, sign, mean }, i) => ({ die, count, sign, mean, rank: canonical.indexOf(i) }));
  const capacity = Math.max(0, Math.floor(budget));
  const trials = Math.max(1, Math.floor(rolls));

  const draw = (from: number, to: number): PoolDie[] =>
    kinds.slice(from, to).flatMap((kind, offset) =>
      Array.from({ length: kind.count }, () => {
        const s = sampleDie(kind.die, rng);
        return { kind: from + offset, value: kind.sign * s.face, dice: s.dice };
      })
    );
  const pools = Array.from({ length: trials }, () => draw(0, ownGroups));
  const oncePool = draw(ownGroups, kinds.length);

  const attempts = pools.map((pool): PoolRoll => {
    const seen = [...pool, ...oncePool];
    const gain = (i: number) => Math.round((kinds[seen[i].kind].mean - seen[i].value) * GRID);
    const chosen = new Set(
      seen
        .map((_, i) => i)
        .filter((i) => gain(i) > 0)
        .sort((a, b) => gain(b) - gain(a) || kinds[seen[a].kind].rank - kinds[seen[b].kind].rank || seen[a].value - seen[b].value)
        .slice(0, capacity)
    );
    const score = seen.reduce((s, d, i) => s + (chosen.has(i) ? kinds[d.kind].mean : d.value), 0);
    return { pool, chosen, score };
  });
  // Scores compare on the grid exactly as `rerollUpToPMF` keys them; the first highest wins.
  let best = 0;
  attempts.forEach((a, i) => {
    if (Math.round(a.score * GRID) > Math.round(attempts[best].score * GRID)) best = i;
  });

  let total = own.flat + once.flat;
  const dice: SampledDie[] = [];
  const { pool: kept, chosen } = attempts[best];
  // `j` indexes the kept roll then the rolled-once dice, as `chosen` does.
  const play = (d: PoolDie, j: number): void => {
    if (!chosen.has(j)) {
      total += d.value;
      dice.push(...d.dice);
      return;
    }
    dice.push(...dropped(d.dice));
    const kind = kinds[d.kind];
    const s = sampleDie(kind.die, rng);
    total += kind.sign * s.face;
    dice.push(...s.dice.map((x) => ({ ...x, reroll: true as const })));
  };
  attempts.forEach((attempt, i) => {
    if (i === best) kept.forEach(play);
    else dice.push(...attempt.pool.flatMap((d) => dropped(d.dice)));
  });
  oncePool.forEach((d, j) => play(d, kept.length + j));
  return { total, dice };
}
