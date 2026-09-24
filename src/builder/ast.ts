import { LRUCache, PMF } from "../";
import { d20RollPMF } from "./d20";
import { builderPMFCache } from "./factory";
import type {
  AddNode,
  ConstantNode,
  D20RollNode,
  DieNode,
  ExpressionNode,
  KeepNode,
  MaxOfNode,
  SumNode,
} from "./nodes";
import { naturalRollIndex, type RollBuilder } from "./roll";
import type { RollConfig, RollType } from "./types";

// Default epsilon 0: single-die PMFs resolve without pruning.
const defaultEps = 0;

const singleDiePMFCache = new LRUCache<string, PMF>(1000);

export function dieNodeFromConfig(cfg: RollConfig): DieNode {
  return {
    type: "die",
    sides: cfg.sides,
    reroll: cfg.reroll > 0 ? cfg.reroll : undefined,
    minimum: cfg.minimum > 0 ? cfg.minimum : undefined,
    explode:
      cfg.explode && Number.isFinite(cfg.explode) && cfg.explode > 0
        ? cfg.explode
        : undefined,
  };
}

export function astFromRollConfigs(
  configs: readonly RollConfig[]
): ExpressionNode | undefined {
  if (!configs || configs.length === 0) return undefined;

  const children: { node: ExpressionNode; sign: 1 | -1 }[] = [];
  let constantSum = 0;

  for (const cfg of configs) {
    const sign: 1 | -1 = cfg.isSubtraction || cfg.count < 0 ? -1 : 1;
    const count = Math.abs(cfg.count || 0);

    constantSum += cfg.modifier || 0;

    if ((cfg.sides || 0) <= 0) continue;

    // `bestOf(k)` ("roll N, keep the highest k") is exactly `keep = {total: N, count: k, mode:
    // "highest"}` over the same die -- fold it into an equivalent synthetic `keep` up front so it
    // reuses the keep-DP branch below instead of being silently ignored (the die count alone,
    // with no keep applied, previously determined the PMF -- e.g. `5d10.bestOf(3)` resolved as
    // plain 5d10 despite `toExpression()` correctly rendering "5d10kh3").
    const isSynthesizedBestOf =
      !cfg.keep && cfg.bestOf > 0 && cfg.bestOf < count;
    const effectiveKeep = isSynthesizedBestOf
      ? { total: count, count: Math.floor(cfg.bestOf), mode: "highest" as const }
      : cfg.keep;

    const die: DieNode = dieNodeFromConfig(cfg);

    let node: ExpressionNode = die;

    let appliedRollType = false;
    if (cfg.rollType && cfg.rollType !== "flat") {
      if (cfg.sides === 20) {
        node = {
          type: "d20Roll",
          rollType: cfg.rollType,
          child: node,
        } as D20RollNode;
      } else {
        const n = cfg.rollType === "elven accuracy" ? 3 : 2;
        const mode = cfg.rollType === "disadvantage" ? "lowest" : "highest";
        const base: SumNode = { type: "sum", count: n, child: node };
        node = { type: "keep", mode, count: 1, child: base } as KeepNode;
      }
      appliedRollType = true;
    }

    if (cfg.rollType === "flat" && effectiveKeep && effectiveKeep.total > 0) {
      if (cfg.explodePoolBudget > 0) {
        throw new Error(
          "explodePool() cannot be combined with keep()/bestOf() on the same config — the match/keep pool is ambiguous once dice can be added mid-resolution. Use explodePool() on a plain (non-keep) pool."
        );
      }
      const baseCount = Math.max(1, Math.floor(Math.abs(count || 1)));
      const trials = Math.max(1, Math.floor(effectiveKeep.total));
      const k = Math.max(0, Math.floor(effectiveKeep.count));

      // For keep-highest of 1, always treat as trials-of-sums: max over trial sums
      // A synthesized `bestOf` trial is a SINGLE die, never `baseCount` dice, so it must not
      // take the maxOf-of-sums shape.
      if (k === 1 && effectiveKeep.mode === "highest" && !isSynthesizedBestOf) {
        const perTrial: SumNode = {
          type: "sum",
          count: baseCount,
          child: node,
        };
        if (trials === 1) {
          node = perTrial;
        } else {
          node = {
            type: "maxOf",
            count: trials,
            child: perTrial,
          } as MaxOfNode;
        }
      } else if (trials === baseCount) {
        // Classic pool: keep K of N faces from N iid dice
        const base: SumNode = { type: "sum", count: trials, child: node };
        node = {
          type: "keep",
          mode: effectiveKeep.mode,
          count: k,
          child: base,
        } as KeepNode;
      } else {
        // General trials-of-sums: trials of (baseCount dice sum), keep K trial sums
        const perTrial: SumNode = {
          type: "sum",
          count: baseCount,
          child: node,
        };
        if (trials === 1) {
          node = perTrial;
        } else {
          const trialPool: SumNode = {
            type: "sum",
            count: trials,
            child: perTrial,
          };
          node = {
            type: "keep",
            mode: effectiveKeep.mode,
            count: k,
            child: trialPool,
          } as KeepNode;
        }
      }
    } else {
      const c = appliedRollType ? 1 : Math.max(1, count || 1);
      if (cfg.explodePoolBudget > 0 && appliedRollType) {
        throw new Error(
          "explodePool() cannot be combined with advantage/disadvantage/elven-accuracy on the same config — pool-wide explosion is for damage dice pools, not d20 rolls."
        );
      }
      node = {
        type: "sum",
        count: c,
        child: node,
        explodePoolBudget: cfg.explodePoolBudget > 0 ? cfg.explodePoolBudget : undefined,
      } as SumNode;
    }

    children.push({ node, sign });
  }

  if (children.length === 0) {
    return { type: "constant", value: constantSum } as ConstantNode;
  }

  const add: AddNode = { type: "add", children };
  if (constantSum !== 0)
    add.children.push({
      node: { type: "constant", value: constantSum },
      sign: 1,
    });
  return add;
}

export function resolve(node: ExpressionNode, eps: number = defaultEps): PMF {
  const signature = getASTSignature(node);
  const cacheKey = `${signature}_${eps}`;

  const cached = builderPMFCache.get(cacheKey);
  if (cached) return cached;

  const result = ((): PMF => {
    switch (node.type) {
      case "constant":
        return PMF.delta(node.value, eps);

      case "die": {
        return resolveSingleDie(node, eps);
      }

      case "sum": {
        const base = resolve(node.child, eps);
        const n = Math.max(0, Math.floor(node.count));
        if (n === 0) return PMF.delta(0, eps);
        if (node.explodePoolBudget && Number.isFinite(node.explodePoolBudget) && node.explodePoolBudget > 0) {
          const die = findDie(node.child);
          if (!die) {
            throw new Error("explodePool() requires the pool's child to be a plain die.");
          }
          return resolveExplodingPool(base, die.sides, n, Math.floor(node.explodePoolBudget), eps);
        }
        if (n === 1) return base;
        return base.power(n, eps);
      }

      case "add": {
        let shift = 0;
        const parts: PMF[] = [];
        for (const c of node.children) {
          if (c.node.type === "constant") {
            shift += c.sign * c.node.value;
          } else {
            const p = resolve(c.node, eps);
            parts.push(c.sign === 1 ? p : p.mapDamage((v) => -v));
          }
        }
        if (parts.length === 0) return PMF.delta(shift, eps);
        let res = parts.length === 1 ? parts[0] : PMF.convolveMany(parts, eps);
        if (shift !== 0) res = res.mapDamage((v) => v + shift);
        return res;
      }

      case "keep": {
        const totalTrials = getTotalCount(node);
        const keepCount = Math.max(0, Math.min(node.count, totalTrials));
        if (keepCount === 0 || totalTrials === 0) return PMF.delta(0, eps);

        // Resolve the per-trial PMF (the child of the Sum inside Keep)
        const perTrialNode = node.child.child; // Sum(child: perTrial)
        const perTrialPMF = resolve(perTrialNode, eps);

        return keepSumPMF(
          perTrialPMF,
          totalTrials,
          keepCount,
          node.mode === "highest",
          eps
        );
      }

      case "d20Roll": {
        const childDie = findDie(node.child);
        if (!childDie) return d20RollPMF(node.rollType, false);
        return resolveD20Roll(childDie, node.rollType);
      }

      case "half": {
        const childPMF = resolve(node.child, eps);
        return childPMF.scaleDamage(0.5, "floor");
      }

      case "maxOf": {
        const childPMF = resolve(node.child, eps);
        const count = Math.max(1, Math.floor(node.count));
        if (count === 1) return childPMF;

        // Compute the maximum of count independent rolls of childPMF
        return computeMaxOfPMF(childPMF, count, eps);
      }

      case "scale": {
        const childPMF = resolve(node.child, eps);
        const denom = node.denominator === 0 ? 1 : node.denominator;
        return childPMF.scaleDamage(node.numerator / denom, node.rounding);
      }
    }
  })();

  builderPMFCache.set(cacheKey, result);
  return result;
}

export function pmfFromRollBuilder(
  rb: RollBuilder,
  eps: number = defaultEps
): PMF {
  const ast = rb.toAST();
  return resolve(ast, eps);
}

const d20RollLiftCache = new LRUCache<string, PMF>(500);

/**
 * Resolve a d20-shaped die (honoring reroll/minimum/explode via {@link resolveSingleDie}) then
 * lift it into advantage/disadvantage/elven accuracy. Each of the 2 or 3 rolls compared is an
 * independent draw from that SAME resolved marginal — so a Halfling Lucky reroll or a
 * Trance-of-Order floor applies per-die, matching RAW (you reroll/floor each d20 you roll, not
 * just a single "representative" one). This generalizes {@link d20RollPMF}, which only ever
 * modeled the plain-uniform-plus-reroll-1 case; callers that resolve a die with no minimum/
 * explode/deeper reroll get bit-identical results to `d20RollPMF` (verified: the reroll-only
 * formula below reduces to the same closed form).
 *
 * Deliberately ignores any caller-facing output-precision `eps` (matching `d20RollPMF`'s own
 * contract): this builds the FOUNDATIONAL check-die distribution, where every face carries real
 * probability mass (e.g. 1/20 per face on a flat d20) — pruning it against an output-rounding
 * epsilon (some callers request eps as coarse as 0.1 purely to round the FINAL hit/miss/crit
 * mixture) would silently delete real faces instead of real noise. Always resolves at the
 * library's near-zero {@link defaultEps} internally; only the mixture built on top of this
 * result should be pruned against the caller's requested eps.
 */
export function resolveD20Roll(die: DieNode, rollType: RollType | undefined): PMF {
  const base = resolveSingleDie(die, defaultEps);
  const type = rollType || "flat";
  if (type === "flat") return base;

  const cacheKey = `${getASTSignature(die)}|${type}`;
  const cached = d20RollLiftCache.get(cacheKey);
  if (cached) return cached;

  const support = [...base.support()].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let cum = 0;
  let prevLifted = 0;
  for (const k of support) {
    cum += base.pAt(k);
    // advantage: best of 2 (F^2); elven accuracy: best of 3 (F^3); disadvantage: worst of 2
    // (1-(1-F)^2). `type` can't be "flat" here — that returns above before the cache lookup.
    const curLifted =
      type === "advantage"
        ? cum * cum
        : type === "elven accuracy"
          ? cum * cum * cum
          : 1 - (1 - cum) * (1 - cum);
    const pk = curLifted - prevLifted;
    if (pk > 0) out.set(k, pk);
    prevLifted = curLifted;
  }
  const result = PMF.fromMap(out, defaultEps);
  d20RollLiftCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve a check builder's natural roll (its d20, or with no d20 its largest die: see
 * {@link naturalRollIndex}), honoring that die's reroll/minimum/explode, then lift by its
 * `rollType`. The single entry point every attack/save check builder ({@link ACBuilder},
 * {@link AttackBuilder}, {@link AlwaysHitBuilder}, {@link AlwaysCritBuilder}, `DCBuilder`, save
 * `resolveProbabilities`) uses for the natural roll; the other dice are bonus dice.
 *
 * A check with no die has no natural roll: this returns a certain 0, so its total is its flat
 * modifier plus any bonus dice and no natural-1/natural-20 rule can apply. A natural roll of more
 * than one die (`roll(2, d20)`, or two equal top dice like `d20.plus(d20)`) has no single natural
 * 1 or 20 and throws.
 */
export function resolveRootD20(check: RollBuilder): PMF {
  const configs = check.getSubRollConfigs();
  const rootIdx = naturalRollIndex(configs);
  if (rootIdx === -1) return PMF.delta(0);
  const rootConfig = check.getRootDieConfig() ?? configs[rootIdx];
  const sides = configs[rootIdx].sides;
  const tied = configs.some(
    (c, i) => i !== rootIdx && c.sides === sides && c.count > 0 && !c.isSubtraction
  );
  if (rootConfig.count !== 1 || tied) {
    throw new Error(
      `This check's natural roll is not one die: a check needs exactly one d${sides} for its natural 1 and 20. ` +
        "Roll it once and add any other dice as bonus dice."
    );
  }
  return resolveD20Roll(dieNodeFromConfig(rootConfig), check.rollType);
}

export function resolveSingleDie(die: DieNode, eps: number = defaultEps): PMF {
  const signature = getASTSignature(die);
  const cacheKey = `${signature}_${eps}`;

  const cached = singleDiePMFCache.get(cacheKey);
  if (cached) return cached;

  const s = Math.max(0, Math.floor(die.sides));
  if (s <= 0) return PMF.delta(0, eps);

  let probs = new Map<number, number>();
  for (let v = 1; v <= s; v++) probs.set(v, 1 / s);

  // One-pass reroll: faces 1..k reroll once, and the reroll is kept (see `RollConfig.reroll`).
  const r = Math.max(0, Math.floor(die.reroll || 0));
  if (r > 0) {
    const k = Math.min(r, s);
    const rerollMass = k / s; // total probability rerolled once
    const uniformReroll = rerollMass / s; // mass added to each face from reroll
    const next = new Map<number, number>();
    for (let v = 1; v <= s; v++) {
      const keep = v <= k ? 0 : 1 / s;
      next.set(v, keep + uniformReroll);
    }
    probs = next;
  }

  let pmf = PMF.fromMap(new Map(probs), eps);

  // Minimum per die
  const minV = Math.max(0, Math.floor(die.minimum || 0));
  if (minV > 0) pmf = pmf.mapDamage((v) => Math.max(v, minV));

  // Exploding dice (finite, capped at `times` additional dice) on max face only.
  const explode = die.explode;
  if (explode && Number.isFinite(explode) && explode > 0) {
    const times = Math.floor(explode);
    const maxFace = s;

    // Split pmf into a max-face slice and a non-max slice. `PMF.fromMap` always normalizes to
    // mass 1 (divides by its own sum), so `nonMaxPMF` is already the correct conditional "given
    // the roll wasn't max, what was it" distribution — exactly the shape `PMF.branch` requires
    // for its failure argument. It must NOT be rescaled again afterward: `PMF.branch` weights
    // each branch's bins by (p, 1-p) directly, so a `nonMaxPMF` still holding raw mass (1-pMax)
    // would contribute (1-pMax)^2 instead of (1-pMax) to the result — `d6.explode(1)` would total
    // 0.861 mass instead of 1.
    const nonMax = new Map<number, number>();
    const pMax = pmf.pAt(maxFace);
    for (const v of pmf.support()) {
      if (v !== maxFace) nonMax.set(v, pmf.pAt(v));
    }
    const nonMaxPMF = PMF.fromMap(nonMax, eps);

    // Capped geometric chain, built bottom-up. `chain` holds the distribution of "one more die
    // roll, with `remaining` further explosions still allowed if THAT roll is also max" for
    // `remaining` running from 0 (a final roll that can't chain further, however it lands) up to
    // `times - 1`. Each step wraps the previous chain in one more branch: on a max roll (prob
    // pMax) add another maxFace and recurse into the shorter chain; otherwise stop at a non-max
    // value. This reduces to exactly `explode(1)`'s "maxFace + one more untouched die" for
    // `times === 1`, and never lets more than `times` extra dice enter the total.
    let chain = pmf; // remaining = 0: an unconstrained extra die, chains no further either way
    for (let remaining = 1; remaining <= times - 1; remaining++) {
      chain = PMF.branch(chain.mapDamage((v) => v + maxFace), nonMaxPMF, pMax);
    }
    const exploded = PMF.branch(chain.mapDamage((v) => v + maxFace), nonMaxPMF, pMax);
    pmf = exploded;
  }

  singleDiePMFCache.set(cacheKey, pmf);
  return pmf;
}

/**
 * Resolve a pool of `count` i.i.d. dice sharing ONE pool-wide exploding-dice budget: at most
 * `budget` extra dice may be added in total across the whole pool, as opposed to per-die
 * `explode()` (each of the `count` dice individually allowed its own extra dice). `diePMF` is
 * the already-resolved single-die marginal (post reroll/minimum, no per-die explode — the two
 * mechanisms are mutually exclusive by construction).
 *
 * DP over `(pending dice, budget remaining)`, resolving one arbitrary pending die per step:
 *   f(p, b) = (non-max faces) ⊗ f(p-1, b)                      -- this die didn't explode
 *           + (max face)      ⊗ (b > 0 ? f(p, b-1) : f(p-1, b)) -- did explode; spends 1 budget,
 *                                                                   pending count stays p because
 *                                                                   the extra die takes its place
 *   f(0, b) = δ₀ ;  f(p, 0) = diePMF.power(p)
 * Acyclic: every recursive call strictly decreases `p + b`, so memoizing on that pair terminates.
 */
function resolveExplodingPool(
  diePMF: PMF,
  maxFace: number,
  count: number,
  budget: number,
  eps: number
): PMF {
  const pMax = diePMF.pAt(maxFace);
  const nonMax = new Map<number, number>();
  for (const v of diePMF.support()) {
    if (v !== maxFace) nonMax.set(v, diePMF.pAt(v));
  }
  // Every face is the max face (a 1-sided die, or `minimum` at/above `sides`): no roll can be
  // non-max, so every one of the `count` dice AND every one of the `budget` explosions it
  // triggers shows max — the pool is deterministically `count + budget` max faces. Must be
  // checked before `PMF.fromMap(nonMax, ...)`, which throws on an empty map.
  if (nonMax.size === 0) {
    return PMF.delta((count + budget) * maxFace, eps);
  }
  const nonMaxPMF = PMF.fromMap(nonMax, eps);

  const memo = new Map<string, PMF>();
  const f = (p: number, b: number): PMF => {
    if (p === 0) return PMF.delta(0, eps);
    if (b === 0) return diePMF.power(p, eps);

    const key = `${p},${b}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const maxBranch = f(p, b - 1).mapDamage((v) => v + maxFace);
    const nonMaxBranch = nonMaxPMF.convolve(f(p - 1, b), eps);
    const result = PMF.branch(maxBranch, nonMaxBranch, pMax);

    memo.set(key, result);
    return result;
  };

  return f(count, budget);
}

// Getters

function findDie(node: ExpressionNode): DieNode | undefined {
  switch (node.type) {
    case "die":
      return node;
    case "constant":
      return undefined;
    case "sum":
    case "d20Roll":
    case "half":
    case "maxOf":
    case "scale":
      return findDie(node.child);
    case "keep":
      return findDie(node.child.child);
    case "add":
      for (const c of node.children) {
        const d = findDie(c.node);
        if (d) return d;
      }
      return undefined;
  }
}

function getTotalCount(node: KeepNode): number {
  // The total dice count is encoded in the nearest SumNode under child
  let cur = node.child;
  while (cur.type === "keep") cur = cur.child;
  return cur.type === "sum" ? Math.max(0, Math.floor(cur.count)) : 0;
}

function computeMaxOfPMF(
  pmf: PMF,
  count: number,
  eps: number = defaultEps
): PMF {
  // Compute the maximum of 'count' independent rolls of the given PMF
  if (count <= 1) return pmf;

  const support = pmf.support();
  const out = new Map<number, number>();

  // For small counts, enumerate all outcomes exactly.
  if (count <= 6 && support.length <= 20) {
    function dfs(
      rollsLeft: number,
      currentMax: number,
      probability: number
    ): void {
      if (rollsLeft === 0) {
        out.set(currentMax, (out.get(currentMax) || 0) + probability);
        return;
      }

      for (const value of support) {
        const p = pmf.pAt(value);
        if (p > 0) {
          const newMax = Math.max(currentMax, value);
          dfs(rollsLeft - 1, newMax, probability * p);
        }
      }
    }

    dfs(count, -Infinity, 1);
  } else {
    // For larger cases, use the CDF method. Walk the sorted support once while
    // accumulating a running CDF, so each P(max = v) costs O(1) instead of a
    // full-map cdfAt() scan (previously O(N) per value → O(N²) overall).
    // Between two consecutive support points there is no probability mass, so
    // the running CDF up to (but not including) v equals cdfAt(v - 1).
    const sortedSupport = [...support].sort((a, b) => a - b);
    let runningCdf = 0;
    for (const value of sortedSupport) {
      const prevCdf = runningCdf;
      runningCdf += pmf.pAt(value);

      // P(max = value) = P(all rolls <= value) - P(all rolls <= value-1)
      const probMax = Math.pow(runningCdf, count) - Math.pow(prevCdf, count);
      if (probMax > eps) {
        out.set(value, probMax);
      }
    }
  }

  return PMF.fromMap(out, eps);
}

function keepSumPMF(
  single: PMF,
  total: number,
  keep: number,
  highest: boolean,
  eps: number = defaultEps
): PMF {
  // Trivial/fast paths
  if (keep >= total) return single.power(total, eps);
  if (keep <= 0) return PMF.delta(0, eps);

  const sortedSupport = [...single.support()].sort((a, b) => a - b);
  const pmfSig = sortedSupport
    .map((val) => `${val}:${single.pAt(val).toPrecision(6)}`)
    .join(",");
  const cacheKey = `keep|${pmfSig}|t:${total}|k:${keep}|h:${
    highest ? 1 : 0
  }|e:${eps}`;

  const cached = builderPMFCache.get(cacheKey);
  if (cached) return cached;

  // kh1/kl1 fast paths using max-of machinery
  if (keep === 1) {
    if (highest) {
      return computeMaxOfPMF(single, total, eps);
    } else {
      // min of n i.i.d. == -max of n of negated variable
      const neg = single.mapDamage((v) => -v);
      const minPMF = computeMaxOfPMF(neg, total, eps).mapDamage((v) => -v);
      builderPMFCache.set(cacheKey, minPMF);
      return minPMF;
    }
  }

  // DP over descending values; state = (used, remainingTrials) → map(sum -> prob)
  // Transition by drawing X occurrences at current value v from remainingTrials r: X ~ Binom(r, p)
  // Select t = min(X, keep - used) into the sum (highest picks first), then continue with r - X.

  type SumMap = Map<number, number>;
  let state: Map<number, SumMap> = new Map();
  // Pack the (used, remainingTrials) state into a single integer key instead of
  // a "used|r" string. r ∈ [0, total], so a stride of (total + 1) is collision
  // free, and decoding is plain integer math — no split()/parseInt() per
  // transition in the hot loop. Behavior is identical (same states, same order).
  const stride = total + 1;
  const keyOf = (used: number, r: number) => used * stride + r;

  state.set(keyOf(0, total), new Map([[0, 1]]));

  const valuesDesc = highest
    ? [...sortedSupport].sort((a, b) => b - a)
    : [...sortedSupport].sort((a, b) => a - b);

  const binomPMF = (r: number, p: number): number[] => {
    if (r <= 0) return [1];
    if (p <= eps) {
      const arr = new Array(r + 1).fill(0);
      arr[0] = 1;
      return arr;
    }
    if (1 - p <= eps) {
      const arr = new Array(r + 1).fill(0);
      arr[r] = 1;
      return arr;
    }
    const q = 1 - p;
    const arr = new Array(r + 1).fill(0);

    // stable recurrence from k=0
    arr[0] = Math.pow(q, r);
    const ratio = p / q;
    for (let x = 1; x <= r; x++)
      arr[x] = ((arr[x - 1] * (r - x + 1)) / x) * ratio;

    // Normalize minor drift
    let s = 0;
    for (let x = 0; x <= r; x++) s += arr[x];
    if (Math.abs(1 - s) > 1e-12) for (let x = 0; x <= r; x++) arr[x] /= s;

    return arr;
  };

  const pruneMap = (m: SumMap, threshold: number): SumMap => {
    if (threshold <= 0) return m;
    const out = new Map<number, number>();
    for (const [sum, pr] of m) if (pr >= threshold) out.set(sum, pr);
    return out.size === m.size ? m : out;
  };

  const pruneState = (st: Map<number, SumMap>, threshold: number) => {
    if (threshold <= 0) return st;
    const out = new Map<number, SumMap>();
    for (const [k, m] of st) {
      const mm = pruneMap(m, threshold);
      if (mm.size > 0) out.set(k, mm);
    }
    return out;
  };

  let processedMass = 0;
  for (const v of valuesDesc) {
    const p = single.pAt(v);
    if (p <= 0) continue;
    const q = Math.max(eps, 1 - processedMass);
    const pCond = Math.min(1, p / q);
    const next: Map<number, SumMap> = new Map();

    for (const [k, m] of state) {
      const used = Math.floor(k / stride);
      const r = k - used * stride;
      if (r === 0) {
        // No trials left; carry state forward unchanged
        const destKey = keyOf(used, 0);
        const dest = next.get(destKey) ?? new Map<number, number>();
        for (const [sum, pr] of m) dest.set(sum, (dest.get(sum) || 0) + pr);
        next.set(destKey, dest);
        continue;
      }

      const bin = binomPMF(r, pCond);
      const remainingCapacity = keep - used;

      for (let x = 0; x <= r; x++) {
        const px = bin[x];
        if (px <= eps) continue;
        const t = Math.min(x, remainingCapacity);
        const used2 = used + t;
        const r2 = r - x;
        const add = t * v;

        const destKey = keyOf(used2, r2);
        const dest = next.get(destKey) ?? new Map<number, number>();
        for (const [sum, pr] of m) {
          const s2 = sum + add;
          const prob = pr * px;
          const cur = dest.get(s2) || 0;
          const nv = cur + prob;
          if (nv >= eps) dest.set(s2, nv);
        }
        if (dest.size > 0) next.set(destKey, dest);
      }
    }

    // Light pruning proportional to eps
    state = pruneState(next, eps * 1e-6);
    processedMass += p;
  }

  // Collect results where all trials assigned and exactly keep were used
  const finalKey = keyOf(keep, 0);
  const dist = state.get(finalKey) ?? new Map<number, number>();

  if (dist.size === 0) {
    // Fallback safety: return empty mass (should not happen)
    return PMF.emptyMass();
  }

  const result = PMF.fromMap(dist, eps);
  builderPMFCache.set(cacheKey, result);
  return result;
}

export function getASTSignature(node: ExpressionNode): string {
  switch (node.type) {
    case "constant":
      return `c:${node.value}`;
    case "die": {
      // Use a fixed order for properties to ensure a stable signature.
      const parts: string[] = [];
      parts.push(`s:${node.sides}`);
      if (node.reroll) parts.push(`r:${node.reroll}`);
      if (node.minimum) parts.push(`m:${node.minimum}`);
      if (node.explode) parts.push(`e:${node.explode}`);
      return `d{${parts.join(",")}}`;
    }
    case "sum":
      return `sum{c:${node.count},b:${node.explodePoolBudget || 0},ch:${getASTSignature(node.child)}}`;
    case "d20Roll":
      return `d20{t:${node.rollType},ch:${getASTSignature(node.child)}}`;
    case "keep":
      return `keep{c:${node.count},m:${node.mode},ch:${getASTSignature(
        node.child
      )}}`;
    case "half":
      return `half{ch:${getASTSignature(node.child)}}`;
    case "maxOf":
      return `maxOf{c:${node.count},ch:${getASTSignature(node.child)}}`;
    case "scale":
      return `scale{n:${node.numerator},d:${node.denominator},r:${
        node.rounding
      },ch:${getASTSignature(node.child)}}`;
    case "add": {
      let constantValue = 0;
      const otherChildrenSigs: string[] = [];
      for (const c of node.children) {
        if (c.node.type === "constant") {
          constantValue += c.sign * c.node.value;
        } else {
          otherChildrenSigs.push(
            `${c.sign === -1 ? "-" : "+"}${getASTSignature(c.node)}`
          );
        }
      }

      if (constantValue !== 0) {
        otherChildrenSigs.push(
          constantValue > 0 ? `+c:${constantValue}` : `-c:${-constantValue}`
        );
      }

      // Sort to handle commutative nature of addition.
      otherChildrenSigs.sort();

      return `add[${otherChildrenSigs.join("")}]`;
    }
  }
}
