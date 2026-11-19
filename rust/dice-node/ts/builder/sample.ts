import type { Rng } from "../../../../src/common/rng";
import { native } from "../native";
import type { DieNode, ExpressionNode } from "../../../../src/builder/nodes";
import { nodeToJson } from "./node-json";
import type { RollBuilder } from "./roll";

/**
 * Facade over `rust/dice-node/src/ast.rs` (`sample*`): one random draw of a roll AST. The `Rng` is
 * called back synchronously, one native call per sample; an error it throws is rethrown after the
 * Rust sampler finishes (see `src/rng.rs`).
 */

/** One physical die of a sample. `kept` is false for a die the roll dropped (rerolled away, lost a keep). */
export interface SampledDie {
  sides: number;
  face: number;
  kept: boolean;
  reroll?: true;
  /** A d20 a miss reroll added after the natural roll (see `sampleMissReroll`): part of the natural block. */
  missReroll?: true;
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

/** The `(die, chance)` callbacks of a native sampler; the arrows keep the user's `this`. */
function draws(rng: Rng): [(sides: number) => number, (p: number) => boolean] {
  return [(sides) => rng.die(sides), (p) => rng.chance(p)];
}

/**
 * The sampling twin of `resolveRootD20`: one draw of the natural die under its roll type (the
 * dice in roll order), then of each bonus die group in config order. The flat modifier is not
 * added; the caller reads `check.modifier`.
 */
export function sampleCheckDice(check: RollBuilder, rng: Rng): CheckDice {
  return native.sampleCheckDiceOf(check._handle, ...draws(rng)) as CheckDice;
}

/**
 * What a sampled check drew, read back from its dice (see {@link sampleCheckDice}): the final face of
 * each d20 rolled (`index` into `dice`; a die its own `reroll` rolled again counts once, as its new
 * face), the bonus total, penalty dice subtracted, and `rolled`, the number of listed dice the
 * natural roll took, with the d20s earlier miss rerolls added. Refuses bonus dice that explode or
 * keep, whose dice cannot be told apart from the list.
 */
export function readCheckDice(
  check: RollBuilder,
  dice: readonly SampledDie[]
): { naturals: { index: number; face: number }[]; bonus: number; rolled: number } {
  return native.sampleReadCheckDice(check._handle, dice.map((d) => ({ ...d }))) as {
    naturals: { index: number; face: number }[];
    bonus: number;
    rolled: number;
  };
}

/**
 * One die under its own reroll (once, keeping the new roll), minimum and per-die explode: the
 * sampling twin of `resolveSingleDie`.
 */
export function sampleDie(die: DieNode, rng: Rng): { face: number; dice: SampledDie[] } {
  return native.sampleDieJson(nodeToJson(die), ...draws(rng)) as { face: number; dice: SampledDie[] };
}

export function sampleNode(node: ExpressionNode, rng: Rng): RollSample {
  return native.sampleNodeJson(nodeToJson(node), ...draws(rng)) as RollSample;
}
