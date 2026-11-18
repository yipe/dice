/**
 * `rerollMisses`: a missed attack roll is rolled again. The odds are exact: every bonus total `b` is
 * paired with the faces of the natural d20 it turns into a miss, a hit or a crit, and the new d20 is
 * weighed against those faces (see {@link missRerollOdds}).
 */
import { PMF } from "../pmf/pmf";
import type { ACBuilder } from "./ac";
import { dieNodeFromConfig, naturalDieConfig, resolveD20Roll } from "./ast";
import type { AlwaysCritBuilder } from "./roll";
import type { MissRerollMode, MissRerollSpec, RollConfig } from "./types";

export interface MissRerollOdds {
  /** P(the attack misses as rolled AND misses after the reroll). */
  miss: number;
  /** P(misses as rolled AND the reroll lands as a plain hit). */
  hit: number;
  /** P(misses as rolled AND the reroll crits). */
  crit: number;
  /** P(misses as rolled AND the reroll's kept natural roll is a 20): part of `crit`. */
  natural20: number;
  /**
   * P(misses as rolled AND the reroll is never spent): an `add-dN` die is spent only on a miss it can cover, so the
   * rest stays a miss and keeps the die. Part of `miss`; 0 for every other mode.
   */
  unspent: number;
}

type RerollCheck = ACBuilder | AlwaysCritBuilder;

/** The check's `rerollMisses` mode or modes, if it has any (an always-hit check never has). */
export function missRerollOf(check: { attackConfig: object }): MissRerollSpec | undefined {
  const { attackConfig } = check;
  return "missReroll" in attackConfig ? (attackConfig.missReroll as MissRerollSpec | undefined) : undefined;
}

/** The modes of a spec, in the order they are rolled. */
export function modesOf(spec: MissRerollSpec): readonly MissRerollMode[] {
  return typeof spec === "string" ? [spec] : spec;
}

/** The sides of an `add-dN` die, or undefined for any other mode. */
export function addDieSides(mode: MissRerollMode): number | undefined {
  const match = /^add-d(4|6|8|10|12)$/.exec(mode);
  return match === null ? undefined : Number(match[1]);
}

/** Whether `spec` is a single `add-dN` die (a rescue that may leave a miss unspent). */
export function isAddDie(spec: MissRerollSpec): boolean {
  const modes = modesOf(spec);
  return modes.length === 1 && addDieSides(modes[0]) !== undefined;
}

const KNOWN_MODES: readonly string[] = ["reroll", "add-d20", "advantage", "add-d4", "add-d6", "add-d8", "add-d10", "add-d12"];

/** @throws for an unknown or empty spec, or an `add-dN` die composed with another mode. */
export function assertMissRerollSpec(spec: MissRerollSpec): void {
  const modes = modesOf(spec);
  if (modes.length === 0) throw new Error("rerollMisses: a mode list must name at least one mode.");
  for (const mode of modes) {
    if (!KNOWN_MODES.includes(mode as string)) {
      throw new Error(`rerollMisses: unknown mode "${String(mode)}"; use ${KNOWN_MODES.map((m) => `"${m}"`).join(", ")}.`);
    }
  }
  if (modes.length > 1 && modes.some((mode) => addDieSides(mode) !== undefined)) {
    throw new Error("rerollMisses: an add-dN die cannot be composed with another mode.");
  }
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
  if (root.explode > 0 || root.explodePoolBudget > 0) {
    throw new Error("rerollMisses(): the d20 explodes, so its natural roll can exceed 20.");
  }
  if (root.minimum > 20 || root.minimum < 0) {
    throw new Error(`rerollMisses(): the d20 minimum ${root.minimum} is outside the faces 1..20.`);
  }
  const mass = dieCdf(root)[20];
  if (Math.abs(mass - 1) > 1e-9) {
    throw new Error(`rerollMisses(): the d20 puts ${1 - mass} of its probability outside the faces 1..20.`);
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
export function missRerollOdds(check: RerollCheck, spec: MissRerollSpec, eps: number = 0): MissRerollOdds {
  assertMissRerollSpec(spec);
  const modes = modesOf(spec);
  const sides = addDieSides(modes[0]);
  if (sides !== undefined) return rescueOdds(check, sides, eps);
  const legacy = modes.length === 1 && (modes[0] === "reroll" || modes[0] === "add-d20");
  const mode = modes[0];
  if (!legacy && check.rollType === "disadvantage" && modes.length > 1 && mode !== "advantage") {
    throw new Error("rerollMisses: a disadvantage roll composes modes only after an advantage reroll, which cancels it.");
  }
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
    if (!legacy) {
      // Each mode rolls `dice` new d20s, and the others (all misses) cannot land: only the new dice count.
      const diceOf = (each: MissRerollMode, first: boolean): number =>
        each === "advantage" ? (disadvantage && first ? 1 : rollType === "elven accuracy" ? 3 : 2) : 1;
      let reach = disadvantage ? 1 - S(h) ** 2 : F(h - 1) ** n;
      const steps = modes.map((each, index) => {
        const dice = diceOf(each, index === 0);
        const step = { reach, dice };
        reach *= F(h - 1) ** dice;
        return step;
      });
      const landed = (x: number): number =>
        x > 20 ? 0 : steps.reduce((sum, { reach: at, dice }) => sum + at * (1 - F(x - 1) ** dice), 0);
      out.hit += weight * (landed(h) - landed(c));
      out.crit += weight * landed(c);
      out.natural20 += weight * (c <= 20 ? landed(20) : 0);
      out.miss += weight * reach;
      continue;
    }
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
  return { miss: Math.max(0, out.miss), hit: out.hit, crit: out.crit, natural20: out.natural20, unspent: 0 };
}

/**
 * The odds of a miss rolled again by a die of `sides` added to its total (`add-dN`). Over the natural roll `k` the check
 * keeps and each bonus total `b`: a natural 1 is never covered; a total short of the AC by `s` is covered where `1 <= s <= sides`,
 * with probability `(sides - s + 1) / sides`, and spends the die either way; a larger shortfall leaves the miss and the die.
 * The covered roll lands as a crit where the natural roll crits (or the check always crits), else as a hit.
 */
function rescueOdds(check: RerollCheck, sides: number, eps: number): MissRerollOdds {
  const cdf = dieCdf(rerollDie(check));
  const F = (x: number): number => cdf[Math.min(20, Math.max(0, x))];
  const rollType = check.rollType;
  const dice = rollType === "elven accuracy" ? 3 : rollType === "advantage" ? 2 : rollType === "disadvantage" ? 2 : 1;
  /** P(the kept natural roll is `k`). */
  const kept = (k: number): number => {
    if (rollType === "disadvantage") return (1 - F(k - 1)) ** dice - (1 - F(k)) ** dice;
    return F(k) ** dice - F(k - 1) ** dice;
  };
  const ac = check.attackConfig.ac ?? 0;
  const critOnHit = "fromAlwaysHit" in check;
  const bonusPMFs = check.getBonusDicePMFs(check, eps);
  const bonus = bonusPMFs.length ? PMF.convolveMany(bonusPMFs, eps) : PMF.delta(0, eps);
  const out = { miss: 0, hit: 0, crit: 0, natural20: 0, unspent: 0 };
  for (const [total, bin] of bonus) {
    const weight = bin.p;
    if (!(weight > 0)) continue;
    for (let k = 1; k < 20; k++) {
      const p = weight * kept(k);
      if (!(p > 0)) continue;
      const short = ac - (k + total + check.modifier);
      if (k !== 1 && short <= 0) continue; // not a miss
      if (k === 1 || short > sides) {
        out.miss += p;
        out.unspent += p;
        continue;
      }
      // A fractional AC leaves a fractional shortfall: the die must reach the next whole number.
      const covered = (sides - Math.ceil(short) + 1) / sides;
      if (critOnHit || k >= check.critThreshold) out.crit += p * covered;
      else out.hit += p * covered;
      out.miss += p * (1 - covered);
    }
  }
  return { miss: Math.max(0, out.miss), hit: out.hit, crit: out.crit, natural20: 0, unspent: Math.max(0, out.unspent) };
}

/** A bonus die the expression grammar spells as the plain faces `1..sides`, one signed die per count. */
function plainBonusFaces(config: RollConfig): { sides: number; dice: number; sign: 1 | -1 } {
  const plain =
    config.rollType === "flat" &&
    config.reroll === 0 &&
    !(config.explode > 0) &&
    !(config.explodePoolBudget > 0) &&
    config.minimum <= 1 &&
    !(config.bestOf > 0 && config.bestOf < config.count) &&
    config.keep === undefined;
  if (!plain) {
    throw new Error("toExpression: rerollMisses has no expression spelling: a bonus die rerolls, explodes, keeps or has a minimum.");
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
  const spec = missRerollOf(check);
  if (spec !== undefined && !(typeof spec === "string" && (spec === "reroll" || spec === "add-d20"))) {
    fail(`the mode ${JSON.stringify(spec)} is not a single reroll or add-d20`);
  }
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
