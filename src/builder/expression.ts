import { astFromRollConfigs, dieNodeFromConfig } from "./ast";
import type { DieNode, ExpressionNode, KeepNode } from "./nodes";
import type { RollConfig } from "./types";

/**
 * Printing builders as strings the parser reads back to the same distribution.
 *
 * The grammar reads every binary operator left to right at one precedence, so a term that is
 * itself an expression (`d8 reroll 1`, `3>d6`, `d4 > d4`, `(1d6) // 2`) is parenthesised whenever
 * something precedes it, and every operand of a `>`/`<` chain is an atom. `+` adds only to a
 * non-zero running total, so a term joins with ` + ` only when everything before it can never
 * total 0, and with ` ~+ ` (always add) otherwise. The grammar has no unary minus: a sum whose
 * every term is subtracted starts from `0 - `.
 *
 * Each die group is printed from the AST node the resolver reads (`astFromRollConfigs`), so the
 * string follows the builder's own reading of counts, keeps, roll types and signs.
 */

/** One additive term of a printed sum: the text of its magnitude, its sign, and the range of that
 * magnitude when it is known. */
export type ExpressionTerm = {
  readonly text: string;
  readonly sign: 1 | -1;
  readonly range?: readonly [number, number];
};

type PrintOptions = {
  /** A lone plain d20 prints as `d20` rather than `1d20` (the check's natural roll). */
  readonly d20Shorthand?: boolean;
  /** A keep-1-of-2 or keep-1-of-3 prints as a `>` / `<` chain (a roll type on a non-d20 die). */
  readonly rollTypeChain?: boolean;
};

function isBareDie(node: ExpressionNode): node is DieNode {
  return node.type === "die" && !(node.reroll! > 0) && !(node.minimum! > 0) && !(node.explode! > 0);
}

/**
 * Whether `text` is read as one argument wherever it sits: a number, a dice term (`2d6`, `d20`,
 * `hd20`), or a group `(…)`, `N(…)` or `NkhK(…)` whose first parenthesis closes at the end.
 */
function isAtomicText(text: string): boolean {
  if (/^\d+(\.\d+)?$/.test(text) || /^(\d+(\.\d+)?)?h?d\d+$/.test(text)) return true;
  const open = text.indexOf("(");
  if (open < 0 || !text.endsWith(")")) return false;
  if (!/^(\d+(\.\d+)?(k[hl]\d+(\.\d+)?)?)?$/.test(text.slice(0, open))) return false;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i === text.length - 1;
  }
  return false;
}

/** `text` as one argument: parenthesised unless it already is one. */
export function atom(text: string): string {
  return isAtomicText(text) ? text : `(${text})`;
}

/** A number as one argument; the grammar has no negative literal, so `-3` is `(0 - 3)`. */
export function numberAtom(value: number): string {
  return value < 0 ? `(0 - ${-value})` : `${value}`;
}

/**
 * Joins signed terms into one sum. Zero terms are dropped; a positive term leads when there is
 * one. A term after the first is parenthesised unless it is atomic, and a positive term joins
 * with ` + ` only when the running total before it can never be 0 (its range excludes 0).
 */
export function joinTerms(terms: readonly ExpressionTerm[]): string {
  const live = terms.filter((term) => term.text !== "0");
  if (live.length === 0) return "0";
  const lead = live.findIndex((term) => term.sign > 0);
  if (lead > 0) live.unshift(...live.splice(lead, 1));

  let text = "";
  let known = true;
  let lo = 0;
  let hi = 0;
  live.forEach((term, i) => {
    if (i === 0) {
      text = term.sign > 0 ? term.text : `0 - ${atom(term.text)}`;
    } else if (term.sign < 0) {
      text += ` - ${atom(term.text)}`;
    } else {
      const neverZero = known && (lo > 0 || hi < 0);
      text += `${neverZero ? " + " : " ~+ "}${atom(term.text)}`;
    }
    if (known && term.range) {
      const [a, b] = term.range;
      if (term.sign > 0) {
        lo += a;
        hi += b;
      } else {
        lo -= b;
        hi -= a;
      }
    } else {
      known = false;
    }
  });
  return text;
}

/**
 * One die with its per-die rules: `d8 reroll 1` rerolls face 1 only, `d8 reroll d3` rerolls faces
 * 1–3 (the builder's reroll threshold), `3>d6` floors it at 3, `hd20` is a d20 rerolling a 1.
 */
function printDie(die: DieNode): string {
  if (die.explode! > 0) {
    throw new Error(
      `toExpression() cannot represent an exploding die (d${die.sides} explode(${die.explode})): the string grammar has no explode syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().`
    );
  }
  const reroll = die.reroll ?? 0;
  const minimum = die.minimum ?? 0;
  if (die.sides === 20 && reroll === 1 && minimum <= 1) return "hd20";
  let text = `d${die.sides}`;
  if (reroll > 0) text += reroll === 1 ? " reroll 1" : ` reroll d${reroll}`;
  if (minimum > 0) text = `${minimum}>${atom(text)}`;
  return text;
}

function printKeep(node: KeepNode, options: PrintOptions): string {
  const pool = node.child;
  if (pool.type !== "sum") throw new Error("toExpression(): a keep must hold a pool of trials");
  const trials = Math.max(0, Math.floor(pool.count));
  if (trials === 0 || Math.min(node.count, trials) <= 0) return "0";
  if (options.rollTypeChain && node.count === 1 && (trials === 2 || trials === 3)) {
    const operand = atom(printNode(pool.child));
    return Array(trials).fill(operand).join(node.mode === "highest" ? " > " : " < ");
  }
  const trial = isBareDie(pool.child) ? `1d${pool.child.sides}` : printNode(pool.child);
  return `${pool.count}k${node.mode === "highest" ? "h" : "l"}${node.count}(${trial})`;
}

/**
 * The text of a scaled result `round(value * numerator / denominator)`: `N ** (inner)`,
 * `(inner) // D`, `(inner) / D` or `(inner) ** N // D`. `**` is the product (`*` is the attack
 * gate); `//` rounds down and `/` rounds up. Round-half and fractional factors have no token.
 */
export function printScale(
  inner: string,
  numerator: number,
  denominator: number,
  rounding: "floor" | "round" | "ceil"
): string {
  const den = denominator === 0 ? 1 : denominator;
  if (!Number.isInteger(numerator) || !Number.isInteger(den)) {
    throw new Error(
      `toExpression() cannot represent scaleResult(${numerator}, ${denominator}): the string grammar has only whole numbers. Use the builder's own PMF (.toPMF()/.pmf) instead.`
    );
  }
  if (den === 1) return `${numberAtom(numerator)} ** (${inner})`;
  if (rounding === "round") {
    throw new Error(
      `toExpression() cannot represent scaleResult(${numerator}, ${denominator}, "round"): the string grammar has only floor (//) and ceil (/) division. Use the builder's own PMF (.toPMF()/.pmf) instead.`
    );
  }
  const div = rounding === "ceil" ? "/" : "//";
  if (numerator === 1) return `(${inner}) ${div} ${numberAtom(den)}`;
  return `(${inner}) ** ${numberAtom(numerator)} ${div} ${numberAtom(den)}`;
}

/** The text of an AST node, read by the parser as the same distribution the resolver gives it. */
export function printNode(node: ExpressionNode, options: PrintOptions = {}): string {
  switch (node.type) {
    case "constant":
      return node.value < 0 ? `0 - ${-node.value}` : `${node.value}`;
    case "die":
      return printDie(node);
    case "sum": {
      if (node.explodePoolBudget! > 0) {
        throw new Error(
          `toExpression() cannot represent a pool-wide exploding-dice budget (d${node.child.type === "die" ? node.child.sides : 0} explodePool(${node.explodePoolBudget})): the string grammar has no explode syntax. Use the builder's own PMF (.toPMF()/.pmf) instead of round-tripping through toExpression()/parse().`
        );
      }
      if (Math.floor(node.count) <= 0) return "0";
      const child = node.child;
      if (isBareDie(child)) {
        if (node.count !== 1) return `${node.count}d${child.sides}`;
        return options.d20Shorthand && child.sides === 20 ? "d20" : `1d${child.sides}`;
      }
      const inner = printNode(child, options);
      return node.count === 1 ? inner : `${node.count}(${inner})`;
    }
    case "keep":
      return printKeep(node, options);
    case "d20Roll": {
      const operand = atom(printNode(node.child));
      if (node.rollType === "advantage") return `${operand} > ${operand}`;
      if (node.rollType === "disadvantage") return `${operand} < ${operand}`;
      return `${operand} > ${operand} > ${operand}`;
    }
    case "maxOf": {
      const count = Math.max(1, Math.floor(node.count));
      if (count === 1) return printNode(node.child);
      return `${count}kh1(${isBareDie(node.child) ? `1d${node.child.sides}` : printNode(node.child)})`;
    }
    case "half":
      return `(${printNode(node.child)}) // 2`;
    case "scale":
      return printScale(printNode(node.child), node.numerator, node.denominator, node.rounding);
    case "add":
      return joinTerms(
        node.children.map(({ node: child, sign }) =>
          child.type === "constant"
            ? constantTerm(sign * child.value)
            : { text: printNode(child), sign, range: nodeRange(child) }
        )
      );
    default:
      throw new Error(`toExpression() has no spelling for a "${(node as { type: string }).type}" node`);
  }
}

/** The least and greatest value `node` can resolve to. */
export function nodeRange(node: ExpressionNode): [number, number] {
  switch (node.type) {
    case "constant":
      return [node.value, node.value];
    case "die": {
      const sides = Math.max(0, Math.floor(node.sides));
      if (sides === 0) return [0, 0];
      const minimum = Math.max(0, Math.floor(node.minimum ?? 0));
      const hi = node.explode! > 0 ? Infinity : Math.max(sides, minimum);
      return [Math.max(1, minimum), hi];
    }
    case "sum": {
      const count = Math.max(0, Math.floor(node.count));
      if (count === 0) return [0, 0];
      const [lo, hi] = nodeRange(node.child);
      return [count * lo, node.explodePoolBudget! > 0 ? Infinity : count * hi];
    }
    case "keep": {
      let pool: ExpressionNode = node.child;
      while (pool.type === "keep") pool = pool.child;
      const trials = pool.type === "sum" ? Math.max(0, Math.floor(pool.count)) : 0;
      const kept = Math.max(0, Math.min(node.count, trials));
      if (kept === 0 || pool.type !== "sum") return [0, 0];
      const [lo, hi] = nodeRange(pool.child);
      return [kept * lo, kept * hi];
    }
    case "d20Roll":
    case "maxOf":
      return nodeRange(node.child);
    case "half": {
      const [lo, hi] = nodeRange(node.child);
      return [Math.floor(lo / 2), Math.floor(hi / 2)];
    }
    case "scale": {
      const [lo, hi] = nodeRange(node.child);
      // Rounded either way, the scaled value lies within the rounded-out scaled bounds.
      const factor = node.numerator / (node.denominator === 0 ? 1 : node.denominator);
      const [a, b] = [lo * factor, hi * factor];
      return [Math.floor(Math.min(a, b)), Math.ceil(Math.max(a, b))];
    }
    case "add":
      return node.children.reduce<[number, number]>(
        ([lo, hi], { node: child, sign }) => {
          const [a, b] = nodeRange(child);
          return sign > 0 ? [lo + a, hi + b] : [lo - b, hi - a];
        },
        [0, 0]
      );
    default:
      throw new Error(`no value range for a "${(node as { type: string }).type}" node`);
  }
}

function constantTerm(value: number): ExpressionTerm {
  const magnitude = Math.abs(value);
  return { text: `${magnitude}`, sign: value < 0 ? -1 : 1, range: [magnitude, magnitude] };
}

const complexity = (config: RollConfig) =>
  (config.reroll > 0 ? 1 : 0) +
  (config.explode > 0 ? 1 : 0) +
  (config.explodePoolBudget > 0 ? 1 : 0) +
  (config.minimum > 0 ? 1 : 0) +
  (config.bestOf > 0 ? 1 : 0) +
  (config.keep !== undefined ? 1 : 0) +
  (config.rollType !== "flat" ? 1 : 0);

type DiceGroup = { config: RollConfig; count: number; negative: boolean; root: boolean };

/**
 * Two groups of the same plain die sum to one group of both counts. A keep, a `bestOf`, a roll
 * type, a pool-wide explode budget or a zero count makes a group's meaning depend on its own
 * count, so such a group is never merged.
 */
function mergeable(config: RollConfig): boolean {
  return (
    config.keep === undefined &&
    !(config.bestOf > 0) &&
    config.rollType === "flat" &&
    !(config.explodePoolBudget > 0) &&
    config.count !== 0
  );
}

function diceGroups(configs: readonly RollConfig[], root: RollConfig | undefined): DiceGroup[] {
  const groups: DiceGroup[] = [];
  const byKey = new Map<string, DiceGroup>();
  for (const config of configs) {
    if (!(config.sides > 0)) continue;
    const negative = Boolean(config.isSubtraction) || config.count < 0;
    const count = Math.abs(config.count);
    const isRoot = config === root;
    if (!mergeable(config)) {
      groups.push({ config, count, negative, root: isRoot });
      continue;
    }
    const key = JSON.stringify({ ...config, count: 0, modifier: 0, isSubtraction: negative });
    const existing = byKey.get(key);
    if (existing) {
      existing.count += count;
      existing.root ||= isRoot;
    } else {
      const group = { config, count, negative, root: isRoot };
      byKey.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

/** Reroll/minimum groups first, then larger dice, then more complex groups. */
function byPrintOrder(a: DiceGroup, b: DiceGroup): number {
  const aFirst = a.config.reroll > 0 || a.config.minimum > 0;
  const bFirst = b.config.reroll > 0 || b.config.minimum > 0;
  if (aFirst !== bFirst) return aFirst ? -1 : 1;
  if (b.config.sides !== a.config.sides) return b.config.sides - a.config.sides;
  return complexity(b.config) - complexity(a.config);
}

function groupTerms(group: DiceGroup): ExpressionTerm[] {
  const config: RollConfig = {
    ...group.config,
    count: group.count,
    modifier: 0,
    isSubtraction: group.negative,
  };
  const ast = astFromRollConfigs([config]);
  if (!ast || ast.type !== "add") return [];
  const options: PrintOptions = {
    d20Shorthand: group.root,
    rollTypeChain: config.rollType !== "flat",
  };
  return ast.children
    .filter(({ node }) => node.type !== "constant")
    .map(({ node, sign }) => ({ text: printNode(node, options), sign, range: nodeRange(node) }));
}

/**
 * The terms of a sum of die groups plus their flats, in print order: a leading d20 group (the
 * natural roll) first with the flat total right after it, otherwise the flat total last.
 */
function orderedTerms(groups: DiceGroup[], leading: DiceGroup | undefined, modifier: number): ExpressionTerm[] {
  const ordered = [...(leading ? [leading] : []), ...groups.filter((g) => g !== leading).sort(byPrintOrder)];
  const terms = ordered.map(groupTerms);
  const flat = modifier === 0 ? [] : [constantTerm(modifier)];
  if (ordered.length > 0 && ordered[0].config.sides === 20) {
    return [...terms[0], ...flat, ...terms.slice(1).flat()];
  }
  return [...terms.flat(), ...flat];
}

/**
 * The terms of a plain roll's configs: every die group, then the total of their flats. `root` is
 * the natural-roll config (a d20 root prints first, as `d20`).
 */
export function configTerms(configs: readonly RollConfig[], root: RollConfig | undefined): ExpressionTerm[] {
  const groups = diceGroups(configs, root);
  const rootGroup = groups.find((group) => group.root);
  const modifier = configs.reduce((sum, config) => sum + config.modifier, 0);
  return orderedTerms(groups, rootGroup && rootGroup.config.sides === 20 ? rootGroup : undefined, modifier);
}

/** The minimal shape of a check the printer reads. */
type CheckDice = {
  getRootDieConfig(): RollConfig | undefined;
  getBonusDiceConfigs(): RollConfig[];
  readonly modifier: number;
};

/**
 * A check's natural roll as the check resolvers read it: ONE root die with its reroll/minimum,
 * rolled with its roll type (`d20`, `hd20`, `d20 > d20`, `(d20 reroll d2) < (d20 reroll d2)`).
 * `undefined` for a check with no die.
 */
export function rootDieExpression(check: CheckDice): string | undefined {
  const root = check.getRootDieConfig();
  if (!root || !(root.sides > 0)) return undefined;
  const die = dieNodeFromConfig(root);
  const node: ExpressionNode = root.rollType === "flat" ? die : { type: "d20Roll", rollType: root.rollType, child: die };
  return printNode(node);
}

/**
 * The to-hit/save total of a check as its resolvers read it: the root die ({@link
 * rootDieExpression}), its flat total, and every bonus die group (Bless, Bane, Guidance).
 */
export function checkExpression(check: CheckDice): string {
  const rootText = rootDieExpression(check);
  const groups = diceGroups(check.getBonusDiceConfigs(), undefined);
  if (rootText === undefined) return joinTerms(orderedTerms(groups, undefined, check.modifier));
  const root = check.getRootDieConfig()!;
  const rootTerm: ExpressionTerm = {
    text: rootText,
    sign: 1,
    range: nodeRange(dieNodeFromConfig(root)),
  };
  const flat = check.modifier === 0 ? [] : [constantTerm(check.modifier)];
  const bonus = orderedTerms(groups, undefined, 0);
  return joinTerms(root.sides === 20 ? [rootTerm, ...flat, ...bonus] : [rootTerm, ...bonus, ...flat]);
}
