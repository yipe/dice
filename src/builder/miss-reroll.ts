/**
 * `rerollMisses`: a missed attack roll is rolled again. The odds are exact: every bonus total `b` is
 * paired with the faces of the natural d20 it turns into a miss, a hit or a crit, and the new d20 is
 * weighed against those faces (see {@link missRerollOdds}).
 */
import { PMF } from "../pmf/pmf";
import type { ACBuilder } from "./ac";
import { dieNodeFromConfig, naturalDieConfig, resolveD20Roll } from "./ast";
import type { AlwaysCritBuilder } from "./roll";
import type { MissRerollMode, RollConfig } from "./types";

export interface MissRerollOdds {
  /** P(the attack misses as rolled AND misses after the reroll). */
  miss: number;
  /** P(misses as rolled AND the reroll lands as a plain hit). */
  hit: number;
  /** P(misses as rolled AND the reroll crits). */
  crit: number;
  /** P(misses as rolled AND the reroll's kept natural roll is a 20): part of `crit`. */
  natural20: number;
}

type RerollCheck = ACBuilder | AlwaysCritBuilder;

/** The check's `rerollMisses` mode, if it has one (an always-hit check never has). */
export function missRerollOf(check: { attackConfig: object }): MissRerollMode | undefined {
  const { attackConfig } = check;
  return "missReroll" in attackConfig ? (attackConfig.missReroll as MissRerollMode | undefined) : undefined;
}

/** The most bonus outcomes {@link missRerollCheckExpression} will spell out. */
const MAX_EXPRESSION_OUTCOMES = 400;

/** The outcome of natural `face`, as `AttackBuilder.resolveProbabilities` reads it: 0 miss, 1 hit, 2 crit. */
function rankOf(face: number, total: number, ac: number, critThreshold: number, critOnHit: boolean): 0 | 1 | 2 {
  if (face === 1) return 0;
  if (face === 20) return 2;
  if (total < ac) return 0;
  return critOnHit || face >= critThreshold ? 2 : 1;
}

/**
 * `h`, the first natural face that is not a miss, and `c`, the first that crits (21: none), for a total
 * bonus `bonus` (flat plus bonus dice). Misses are a prefix of the faces and crits a suffix.
 */
function faceBounds(check: RerollCheck, bonus: number): { h: number; c: number } {
  const ac = check.attackConfig.ac ?? 0;
  const critOnHit = "fromAlwaysHit" in check;
  const ranks = Array.from({ length: 20 }, (_, i) => rankOf(i + 1, i + 1 + bonus, ac, check.critThreshold, critOnHit));
  if (ranks.some((rank, i) => i > 0 && rank < ranks[i - 1])) {
    throw new Error(`rerollMisses: the miss faces are not a prefix and the crit faces a suffix (bonus ${bonus}).`);
  }
  const first = (rank: number): number => ranks.findIndex((r) => r >= rank) + 1 || 21;
  return { h: first(1), c: first(2) };
}

function rerollDie(check: RerollCheck): RollConfig {
  const root = naturalDieConfig(check);
  if (root === undefined || root.sides !== 20) {
    throw new Error("rerollMisses() needs a check with a d20 natural roll: only a d20 is rolled again.");
  }
  return root;
}

/** The check's single d20 rolled flat, as the reroll rolls it: P(die <= x) for x in 0..20. */
function dieCdf(root: RollConfig): number[] {
  const die = resolveD20Roll(dieNodeFromConfig(root), "flat");
  const cdf = [0];
  for (let x = 1; x <= 20; x++) cdf.push(cdf[x - 1] + die.pAt(x));
  return cdf;
}

/**
 * The odds of a miss, and of what its reroll lands as. `check` is the check as rolled (its roll type
 * decides how many d20s it rolled); `mode` is how the miss is rolled again.
 *
 * With `F(x)` = P(the row's single d20 <= x), `S(x) = 1 - F(x-1)`, `h` the first non-miss face and `c`
 * the first crit face for the bonus `b`, and `n` the d20s rolled, `g(x)` = P(miss as rolled AND the new
 * kept roll >= x) is `F(h-1)^n S(x)` (flat, advantage, elven accuracy; either mode),
 * `2 F(h-1) S(x)^2` (disadvantage, `reroll`) or `1 - F(x-1)^3 - S(h)^2 + (F(x-1) - F(h-1))^2 F(x-1)`
 * (disadvantage, `add-d20`). Then `hit = g(h) - g(c)`, `crit = g(c)`, `natural20 = g(20)` and
 * `miss = P(miss) - g(h)`, each summed over `b`.
 */
export function missRerollOdds(check: RerollCheck, mode: MissRerollMode, eps: number = 0): MissRerollOdds {
  const cdf = dieCdf(rerollDie(check));
  const F = (x: number): number => cdf[Math.min(20, Math.max(0, x))];
  const S = (x: number): number => 1 - F(x - 1);
  const rollType = check.rollType;
  const disadvantage = rollType === "disadvantage";
  const n = rollType === "elven accuracy" ? 3 : rollType === "advantage" ? 2 : 1;

  const bonusPMFs = check.getBonusDicePMFs(check, eps);
  const bonus = bonusPMFs.length ? PMF.convolveMany(bonusPMFs, eps) : PMF.delta(0, eps);
  const modifier = check.modifier;

  const out = { miss: 0, hit: 0, crit: 0, natural20: 0 };
  for (const [dice, bin] of bonus) {
    const weight = bin.p;
    if (!(weight > 0)) continue;
    const { h, c } = faceBounds(check, dice + modifier);
    const g = (x: number): number => {
      if (x > 20) return 0;
      if (!disadvantage) return F(h - 1) ** n * S(x);
      if (mode === "reroll") return 2 * F(h - 1) * S(x) ** 2;
      return 1 - F(x - 1) ** 3 - S(h) ** 2 + (F(x - 1) - F(h - 1)) ** 2 * F(x - 1);
    };
    const asRolled = disadvantage ? 1 - S(h) ** 2 : F(h - 1) ** n;
    out.hit += weight * (g(h) - g(c));
    out.crit += weight * g(c);
    out.natural20 += weight * (c <= 20 ? g(20) : 0);
    out.miss += weight * (asRolled - g(h));
  }
  // A miss that cannot be rerolled into a landing leaves float dust below zero.
  return { miss: Math.max(0, out.miss), hit: out.hit, crit: out.crit, natural20: out.natural20 };
}

/** A bonus die the expression grammar spells as the plain faces `1..sides`, one signed die per count. */
function plainBonusFaces(config: RollConfig): { sides: number; dice: number; sign: 1 | -1 } {
  const plain =
    config.rollType === "flat" &&
    config.reroll === 0 &&
    !(config.explode > 0) &&
    !(config.explodePoolBudget > 0) &&
    config.minimum <= 1 &&
    config.bestOf <= 1 &&
    config.keep === undefined;
  if (!plain) {
    throw new Error("rerollMisses has no expression spelling: a bonus die rerolls, explodes, keeps or has a minimum.");
  }
  const negative = config.isSubtraction === true || config.count < 0;
  return { sides: config.sides, dice: Math.floor(Math.abs(config.count)), sign: negative ? -1 : 1 };
}

/**
 * The check inside `( … AC n)` for a check with `missReroll` set: one `(d20 reroll dK) + b` term per bonus
 * outcome, `K` the last miss face for that bonus, joined with `&` (each outcome equally likely).
 *
 * @throws where the grammar has no exact spelling: an advantage or disadvantage roll, a d20 `minimum`, a
 * bonus die that is not plain, or more than 400 bonus outcomes.
 */
export function missRerollCheckExpression(check: RerollCheck): string {
  const root = rerollDie(check);
  const fail = (why: string): never => {
    throw new Error(`rerollMisses has no expression spelling: ${why}.`);
  };
  if (check.rollType !== "flat") fail(`the check rolls with ${check.rollType}`);
  if (root.minimum > 1) fail("the d20 has a minimum");
  if (root.reroll > 1) fail("the d20 rerolls more than 1s");
  if (root.explode > 0 || root.explodePoolBudget > 0) fail("the d20 explodes");
  const die = root.reroll === 1 ? "hd20" : "d20";

  const groups = check.getBonusDiceConfigs().map(plainBonusFaces);
  const outcomes = groups.reduce((total, g) => total * g.sides ** g.dice, 1);
  if (outcomes > MAX_EXPRESSION_OUTCOMES) fail(`${outcomes} bonus outcomes is over ${MAX_EXPRESSION_OUTCOMES}`);

  let totals: number[] = [check.modifier];
  for (const { sides, dice, sign } of groups) {
    for (let i = 0; i < dice; i++) {
      totals = totals.flatMap((total) => Array.from({ length: sides }, (_, face) => total + sign * (face + 1)));
    }
  }
  totals.sort((a, b) => a - b);

  const signed = (total: number): string => (total === 0 ? "" : total < 0 ? ` - ${-total}` : ` + ${total}`);
  const reroll = (total: number): string => `${die} reroll d${faceBounds(check, total).h - 1}`;
  if (groups.every((g) => g.dice === 0)) return `${reroll(check.modifier)}${signed(check.modifier)}`;
  return totals.map((total) => (total === 0 ? `(${reroll(total)})` : `((${reroll(total)})${signed(total)})`)).join(" & ");
}
