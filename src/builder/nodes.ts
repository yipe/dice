export type ExpressionNode =
  | DieNode
  | ConstantNode
  | SumNode
  | AddNode
  | KeepNode
  | D20RollNode
  | HalfNode
  | MaxOfNode
  | ScaleNode;

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

export type MaxOfNode = {
  type: "maxOf";
  count: number;
  child: ExpressionNode;
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
