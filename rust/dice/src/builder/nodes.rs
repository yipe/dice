//! Port of `src/builder/nodes.ts`: the expression tree the builder resolves into a PMF.

pub use super::types::KeepMode;

/// `ExpressionNode`.
#[derive(Clone, Debug, PartialEq)]
pub enum ExpressionNode {
    Die(DieNode),
    Constant(ConstantNode),
    Sum(SumNode),
    Add(AddNode),
    Keep(KeepNode),
    D20Roll(D20RollNode),
    Half(HalfNode),
    MaxOf(MaxOfNode),
    Max(MaxNode),
    Scale(ScaleNode),
    RerollUpTo(RerollUpToNode),
}

#[derive(Clone, Debug, PartialEq)]
pub struct DieNode {
    pub sides: f64,
    pub reroll: Option<f64>,
    pub minimum: Option<f64>,
    pub explode: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConstantNode {
    pub value: f64,
}

/// Repeat the same child node `count` times and sum the results (e.g., `XdY`).
#[derive(Clone, Debug, PartialEq)]
pub struct SumNode {
    pub count: f64,
    pub child: Box<ExpressionNode>,
    /// Pool-wide exploding-dice budget shared across the whole `count`-die pool (see
    /// `RollConfig.explodePoolBudget`). `None`/0 = no pool-wide explosion.
    pub explode_pool_budget: Option<f64>,
}

/// `sign: 1 | -1` of an `AddNode` child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sign {
    Plus,
    Minus,
}

impl Sign {
    /// The JS number, 1 or -1.
    pub fn value(self) -> f64 {
        match self {
            Sign::Plus => 1.0,
            Sign::Minus => -1.0,
        }
    }
}

/// One `{ node, sign }` entry of `AddNode.children`.
#[derive(Clone, Debug, PartialEq)]
pub struct AddChild {
    pub node: ExpressionNode,
    pub sign: Sign,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AddNode {
    pub children: Vec<AddChild>,
}

/// `KeepNode.child`: `SumNode | KeepNode`.
#[derive(Clone, Debug, PartialEq)]
pub enum KeepChild {
    Sum(SumNode),
    Keep(KeepNode),
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeepNode {
    pub mode: KeepMode,
    pub count: f64,
    pub child: Box<KeepChild>,
}

/// `D20RollNode.rollType`: the three non-flat `RollType`s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum D20RollKind {
    Advantage,
    Disadvantage,
    ElvenAccuracy,
}

#[derive(Clone, Debug, PartialEq)]
pub struct D20RollNode {
    pub roll_type: D20RollKind,
    pub child: Box<ExpressionNode>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HalfNode {
    pub child: Box<ExpressionNode>,
}

/// The highest of `count` independent rolls of `child`.
#[derive(Clone, Debug, PartialEq)]
pub struct MaxOfNode {
    pub count: f64,
    pub child: Box<ExpressionNode>,
}

/// The highest of several independent, possibly different rolls (e.g. the better of 3d8 and 2d10).
#[derive(Clone, Debug, PartialEq)]
pub struct MaxNode {
    pub children: Vec<ExpressionNode>,
}

/// `ScaleNode.rounding`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rounding {
    Floor,
    Round,
    Ceil,
}

/// Scale the child's result by `numerator / denominator`, then round. It renders as `N * (child)`
/// when the denominator is 1, `(child) // D` when the numerator is 1, and `(child) * N // D`
/// otherwise.
#[derive(Clone, Debug, PartialEq)]
pub struct ScaleNode {
    pub numerator: f64,
    pub denominator: f64,
    pub rounding: Rounding,
    pub child: Box<ExpressionNode>,
}

/// A pool that may reroll up to `budget` of its dice, keeping every new roll, once the whole pool
/// is seen. `child` holds the pool's plain dice and flats; with `rolls` above 1 the pool is rolled
/// that many times and the roll with the highest expected total after its own rerolls is kept.
/// `rolled_once` holds plain dice and flats rolled once whatever `rolls` is (Savage Attacker).
/// `None` when every die is rolled `rolls` times.
#[derive(Clone, Debug, PartialEq)]
pub struct RerollUpToNode {
    pub budget: f64,
    pub rolls: f64,
    pub child: Box<ExpressionNode>,
    pub rolled_once: Option<Box<ExpressionNode>>,
}
