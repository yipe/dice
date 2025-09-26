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
  SumNode,
} from "./nodes";
import type { RollBuilder } from "./roll";
import type { RollConfig } from "./types";

// For now, default to 0 epsilon. Later we can tighten to EPS.
const defaultEps = 0;

const singleDiePMFCache = new LRUCache<string, PMF>(1000);

export function astFromRollConfigs(
  configs: readonly RollConfig[]
): ExpressionNode | undefined {
  // TODO add cache for this
  if (!configs || configs.length === 0) return undefined;

  const children: { node: ExpressionNode; sign: 1 | -1 }[] = [];
  let constantSum = 0;

  for (const cfg of configs) {
    const sign: 1 | -1 = cfg.isSubtraction || cfg.count < 0 ? -1 : 1;
    const count = Math.abs(cfg.count || 0);

    constantSum += cfg.modifier || 0;

    if ((cfg.sides || 0) <= 0) continue;

    const die: DieNode = {
      type: "die",
      sides: cfg.sides,
      reroll: cfg.reroll > 0 ? cfg.reroll : undefined,
      minimum: cfg.minimum > 0 ? cfg.minimum : undefined,
      explode:
        cfg.explode && Number.isFinite(cfg.explode) && cfg.explode > 0
          ? cfg.explode
          : undefined,
    };

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

    if (cfg.rollType === "flat" && cfg.keep && cfg.keep.total > 0) {
      const baseCount = Math.max(1, Math.floor(Math.abs(count || 1)));
      const trials = Math.max(1, Math.floor(cfg.keep.total));
      const k = Math.max(0, Math.floor(cfg.keep.count));

      if (trials === baseCount) {
        // Classic pool: keep K of N faces from N iid dice
        const base: SumNode = { type: "sum", count: trials, child: node };
        node = {
          type: "keep",
          mode: cfg.keep.mode,
          count: k,
          child: base,
        } as KeepNode;
      } else {
        // Trials-of-sums: trials of (baseCount dice sum), keep K trial sums
        const perTrial: SumNode = {
          type: "sum",
          count: baseCount,
          child: node,
        };
        if (trials === 1) {
          node = perTrial;
        } else if (k === 1 && cfg.keep.mode === "highest") {
          node = { type: "maxOf", count: trials, child: perTrial } as any;
        } else {
          const trialPool: SumNode = {
            type: "sum",
            count: trials,
            child: perTrial,
          };
          node = {
            type: "keep",
            mode: cfg.keep.mode,
            count: k,
            child: trialPool,
          } as KeepNode;
        }
      }
    } else {
      const c = appliedRollType ? 1 : Math.max(1, count || 1);
      node = { type: "sum", count: c, child: node } as SumNode;
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
        const rerollOne = !!childDie && (childDie.reroll || 0) >= 1;
        return d20RollPMF(node.rollType, rerollOne);
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

function resolveSingleDie(die: DieNode, eps: number = defaultEps): PMF {
  const signature = getASTSignature(die);
  const cacheKey = `${signature}_${eps}`;

  const cached = singleDiePMFCache.get(cacheKey);
  if (cached) return cached;

  const s = Math.max(0, Math.floor(die.sides));
  if (s <= 0) return PMF.delta(0, eps);

  let probs = new Map<number, number>();
  for (let v = 1; v <= s; v++) probs.set(v, 1 / s);

  // TODO - check if this is correct. Sequential reroll passes? Or at once?
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

  // Exploding dice (finite) on max face only
  const explode = die.explode;
  if (explode && Number.isFinite(explode) && explode > 0) {
    const times = Math.floor(explode);
    const maxFace = s;

    // Split pmf into non-max and max
    const nonMax = new Map<number, number>();
    const pMax = pmf.pAt(maxFace);
    for (const v of pmf.support()) {
      if (v !== maxFace) nonMax.set(v, pmf.pAt(v));
    }
    let nonMaxPMF = PMF.fromMap(nonMax, eps);
    if (Math.abs(nonMaxPMF.mass() - (1 - pMax)) > eps) {
      // keep raw mass composition
      nonMaxPMF = nonMaxPMF.scaleMass(1 - pMax);
    }

    // TODO - explosions
    // Additional roll distribution equals original pmf without explosions applied again.
    // For simplicity we treat cascaded explosions as adding uniform max-only triggers.
    // Compute sum of up to `times` additional rolls conditioned on each explosion hit.
    let tail = PMF.delta(0, eps);
    const addOnce = pmf;
    for (let t = 1; t <= times; t++) {
      tail = tail.convolve(addOnce, eps);
    }
    // Mix: with prob (1 - pMax) take nonMax, with prob pMax take maxFace + tail
    const exploded = PMF.branch(
      tail.mapDamage((v) => v + maxFace),
      nonMaxPMF,
      pMax
    );
    pmf = exploded;
  }

  singleDiePMFCache.set(cacheKey, pmf);
  return pmf;
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

  // For small counts, we can enumerate all outcomes
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
    // For larger cases, use the CDF method
    const sortedSupport = [...support].sort((a, b) => a - b);
    for (const value of sortedSupport) {
      // P(max = value) = P(all rolls <= value) - P(all rolls <= value-1)
      const cdfAtValue = pmf.cdfAt(value);
      const cdfAtValueMinus1 =
        value > sortedSupport[0] ? pmf.cdfAt(value - 1) : 0;

      const probMax =
        Math.pow(cdfAtValue, count) - Math.pow(cdfAtValueMinus1, count);
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
  let state: Map<string, SumMap> = new Map();
  const keyOf = (used: number, r: number) => `${used}|${r}`;

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

  const pruneState = (st: Map<string, SumMap>, threshold: number) => {
    if (threshold <= 0) return st;
    const out = new Map<string, SumMap>();
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
    const next: Map<string, SumMap> = new Map();

    for (const [k, m] of state) {
      const [usedStr, rStr] = k.split("|");
      const used = parseInt(usedStr, 10);
      const r = parseInt(rStr, 10);
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
      return `sum{c:${node.count},ch:${getASTSignature(node.child)}}`;
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
