export type ExpressionNode =
  | DieNode
  | ConstantNode
  | SumNode
  | AddNode
  | KeepNode
  | D20RollNode
  | HalfNode
  | MaxOfNode
  | MaxNode
  | ScaleNode
  | RerollUpToNode;

export type DieNode = {
  type: "die";
  sides: number;
  reroll?: number;
  minimum?: number;
  explode?: number;
};

export type ConstantNode = {
  type: "constant";
  value: number;
};

/// Repeat the same child node count times and sum the results (e.g., XdY).
export type SumNode = {
  type: "sum";
  count: number;
  child: ExpressionNode;
  // Pool-wide exploding-dice budget shared across the whole `count`-die pool (see
  // `RollConfig.explodePoolBudget`). Undefined/0 = no pool-wide explosion.
  explodePoolBudget?: number;
};

export type AddNode = {
  type: "add";
  children: { node: ExpressionNode; sign: 1 | -1 }[];
};

export type KeepNode = {
  type: "keep";
  mode: "highest" | "lowest";
  count: number;
  child: SumNode | KeepNode;
};

export type D20RollNode = {
  type: "d20Roll";
  rollType: "advantage" | "disadvantage" | "elven accuracy";
  child: ExpressionNode;
};

export type HalfNode = {
  type: "half";
  child: ExpressionNode;
};

/** The highest of `count` independent rolls of `child`. */
export type MaxOfNode = {
  type: "maxOf";
  count: number;
  child: ExpressionNode;
};

/** The highest of several independent, possibly different rolls (e.g. the better of 3d8 and 2d10). */
export type MaxNode = {
  type: "max";
  children: ExpressionNode[];
};

/**
 * Scale the child's result by `numerator / denominator`, then round.
 *
 * Unlike {@link HalfNode} (a fixed `// 2` with floor), this is a general, composable
 * multiplier/divider — the building block for damage-type resistance (`1/2`, floor),
 * vulnerability (`2/1`), and similar per-source transforms. It renders as
 * `N * (child)` when the denominator is 1, `(child) // D` when the numerator is 1,
 * and `(child) * N // D` otherwise.
 */
export type ScaleNode = {
  type: "scale";
  numerator: number;
  denominator: number;
  rounding: "floor" | "round" | "ceil";
  child: ExpressionNode;
};

/**
 * A pool that may reroll up to `budget` of its dice, keeping every new roll, once the whole pool is
 * seen. `child` holds the pool's plain dice and flats (`die`, `sum` of a die, `add`, `constant`);
 * the dice are what rerolls act on, the flats never change. With `rolls` above 1 the pool is
 * rolled that many times and the roll whose expected total after its own rerolls is highest is
 * kept (rolls worth the same are interchangeable, so a tie changes nothing), then rerolled: Savage
 * Attacker with a reroll budget.
 */
export type RerollUpToNode = {
  type: "rerollUpTo";
  budget: number;
  rolls: number;
  child: ExpressionNode;
};
