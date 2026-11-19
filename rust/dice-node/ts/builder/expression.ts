import { native } from "../native";
import type { ExpressionNode } from "../../../../src/builder/nodes";
import type { RollConfig } from "../../../../src/builder/types";
import { nodeToJson } from "./node-json";

/**
 * Facade over `rust/dice-node/src/ast.rs` (`expr*`): printing builders as strings the parser reads
 * back to the same distribution. Terms and configs cross as plain objects, nodes as JSON text.
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

/** The minimal shape of a check the printer reads. */
type CheckDice = {
  getRootDieConfig(): RollConfig | undefined;
  getBonusDiceConfigs(): RollConfig[];
  readonly modifier: number;
};

interface NativeTerm {
  text: string;
  sign: 1 | -1;
  range?: [number, number] | null;
}

const configIn = (config: RollConfig): Record<string, unknown> => ({ ...config });

function termIn(term: ExpressionTerm): NativeTerm {
  return { text: term.text, sign: term.sign, range: term.range ? [term.range[0], term.range[1]] : undefined };
}

function termOut(term: NativeTerm): ExpressionTerm {
  return term.range ? { text: term.text, sign: term.sign, range: [term.range[0], term.range[1]] } : { text: term.text, sign: term.sign };
}

/** `text` as one argument: parenthesised unless it already is one. */
export function atom(text: string): string {
  return native.exprAtom(text) as string;
}

/** A number as one argument; the grammar has no negative literal, so `-3` is `(0 - 3)`. */
export function numberAtom(value: number): string {
  return native.exprNumberAtom(value) as string;
}

/**
 * Joins signed terms into one sum. Zero terms are dropped; a positive term leads when there is
 * one. A term after the first is parenthesised unless it is atomic, and a positive term joins
 * with ` + ` only when the running total before it can never be 0 (its range excludes 0).
 */
export function joinTerms(terms: readonly ExpressionTerm[]): string {
  return native.exprJoinTerms(terms.map(termIn)) as string;
}

/**
 * The text of a scaled result `round(value * numerator / denominator)`: `N ** (inner)`,
 * `(inner) // D`, `(inner) / D` or `(inner) ** N // D`.
 */
export function printScale(
  inner: string,
  numerator: number,
  denominator: number,
  rounding: "floor" | "round" | "ceil"
): string {
  return native.exprPrintScale(inner, numerator, denominator, rounding) as string;
}

/** The text of an AST node, read by the parser as the same distribution the resolver gives it. */
export function printNode(node: ExpressionNode, options: PrintOptions = {}): string {
  return native.exprPrintNode(nodeToJson(node), options.d20Shorthand === true, options.rollTypeChain === true) as string;
}

/** The least and greatest value `node` can resolve to. */
export function nodeRange(node: ExpressionNode): [number, number] {
  return native.exprNodeRange(nodeToJson(node)) as [number, number];
}

/**
 * The terms of a plain roll's configs: every die group, then the total of their flats. `root` is
 * the natural-roll config (a d20 root prints first, as `d20`).
 */
export function configTerms(configs: readonly RollConfig[], root: RollConfig | undefined): ExpressionTerm[] {
  const rootIndex = root === undefined ? -1 : configs.indexOf(root);
  const terms = native.exprConfigTerms(configs.map(configIn), rootIndex < 0 ? undefined : rootIndex) as NativeTerm[];
  return terms.map(termOut);
}

/**
 * A check's natural roll as the check resolvers read it: ONE root die with its reroll/minimum,
 * rolled with its roll type. `undefined` for a check with no die.
 */
export function rootDieExpression(check: CheckDice): string | undefined {
  const root = check.getRootDieConfig();
  const text = native.exprRootDieExpression(root && configIn(root)) as string | null | undefined;
  return text ?? undefined;
}

/**
 * The to-hit/save total of a check as its resolvers read it: the root die ({@link
 * rootDieExpression}), its flat total, and every bonus die group (Bless, Bane, Guidance).
 */
export function checkExpression(check: CheckDice): string {
  const root = check.getRootDieConfig();
  return native.exprCheckExpression(root && configIn(root), check.getBonusDiceConfigs().map(configIn), check.modifier) as string;
}
