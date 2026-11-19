//! Port of `src/builder/roll.ts`: the fluent roll builder and its subclasses.
//!
//! # Shape
//! TS has a class family (`RollBuilder` and `HalfRollBuilder`, `ScaleRollBuilder`, `MaxOfRollBuilder`,
//! `RerollUpToRollBuilder`, `AlwaysHitBuilder`, `AlwaysCritBuilder`, `ParsedRollBuilder`,
//! `PooledRollBuilder`, `CompositeSumRollBuilder`, `MaxOfRollsBuilder`). They are one struct,
//! [`RollBuilder`], with a [`RollKind`] tag: every subclass is a `RollBuilder` in TS (it is passed to
//! `plus`, `maxOf`, `sumRolls`, `AttackBuilder`), and `instanceof` is a `match` on the kind. The
//! `ACBuilder`/`DCBuilder` subclasses (next task) are `RollKind` variants too: `ac.rs`/`dc.rs` add
//! the variants and their arms; every `match` on [`RollKind`] here is exhaustive on purpose.
//! The raw `subRollConfigs` field is [`RollBuilder::raw_configs`] (read by `lastConfig`, `modifier`,
//! `getRootDieConfig`, ...), distinct from the overridable [`RollBuilder::get_sub_roll_configs`].
//!
//! # Overloads
//! - `plus(mod)`, `plus(roll)`, `plus(count, die)` are [`RollBuilder::plus`], [`RollBuilder::plus_roll`] and
//!   [`RollBuilder::plus_dice`]; `minus` likewise. `d(undefined)` is [`RollBuilder::d_opt`]. `maxOf(count | roll)` is
//!   [`RollBuilder::max_of`] / [`RollBuilder::max_of_roll`]. `onHit(...args)` and `RollBuilder.fromArgs(...args)` take an
//!   [`Arg`] slice. `addRoll(count = 1)` takes the count; `scaleResult(n, d = 1, r = "floor")` takes
//!   all three.
//! - Methods that throw in TS return `Err(`[`DiceError`]`)`: the variant is the TS class
//!   (`AmbiguousCritDoublingError`, `AmbiguousKeepError`, `ParsedCheckError`, `RangeError`, ...)
//!   and its message the exact text.
//! - A TS `TypeError` from an empty config list (a parsed roll's `lastConfig`) is
//!   `Err(DiceError::Type("Cannot read properties of undefined (reading 'x')"))`.
//!
//! # Skipped
//! `rollPMFCache`, `clearRollCache`, the memoised `_cacheKey` (recomputed by [`RollBuilder::cache_key`]),
//! the dummy `d4 = () => this.d(4)` arrow properties (methods here).
//!
//! # ADR-016 / ADR-017
//! Builders nest one level per wrapping call (`half()`, `scaleResult()`, `maxOf()`, `rerollUpTo()`,
//! `keepHighestAll()`, `times()`, `sumRolls()`...). Past [`MAX_BUILDER_DEPTH`] the wrapping call
//! returns `Err("Maximum call stack size exceeded")` (AST depth is at most three
//! levels per builder level plus five, so every recursion stays under 500 frames). `roll(n, die)` of a
//! transformed or keep-carrying `die` with more than 1e6 copies returns `Err` (TS allocates the array).

use super::arguments::{require_finite, reroll_up_to_arguments};
use super::ast::{
    ast_from_roll_configs, per_die_keep_reading, pmf_from_roll_builder,
    pmf_from_roll_builder_shared, rerollable_pool, resolve_root_d20,
};
use super::attack::AttackBuilder;
use super::dc::SaveConfig;
use super::expression::{
    CheckDiceSource, ExpressionTerm, PrintOptions, config_terms, join_terms, node_range,
    print_node, print_scale, root_die_expression,
};
use super::nodes::{
    AddChild, AddNode, ConstantNode, ExpressionNode, HalfNode, KeepChild, KeepNode, MaxNode,
    MaxOfNode, RerollUpToNode, Rounding, ScaleNode, Sign, SumNode,
};
use super::num::{MAX_ENUMERATED, not_positive, or_zero};
use super::roll_cache_key::{Memo, roll_configs_key_typed};
use super::sample::{CheckDice, RollSample, sample_check_dice, sample_node, sample_pmf};
use super::types::{
    AdvantageDice, AttackRange, KeepMode, KeepSpec, MissRerollMode, RollConfig, RollConfigPatch,
    RollType,
};
use crate::common::Rng;
use crate::error::{DiceError, ParsedCheckError};
use crate::js::num_to_string;
use crate::parser::{parse, scale_parsed_dice};
use crate::pmf::cache::{DC_CACHE, ROLL_CACHE};
use crate::{DiceQuery, EPS, Pmf};
use std::sync::Arc;

/// Deepest builder nesting (ADR-016); see the module doc.
pub const MAX_BUILDER_DEPTH: usize = 100;

/// `defaultConfig`.
pub fn default_config() -> RollConfig {
    RollConfig {
        count: 1.0,
        sides: 0.0,
        modifier: 0.0,
        reroll: 0.0,
        explode: 0.0,
        explode_pool_budget: 0.0,
        minimum: 0.0,
        best_of: 0.0,
        keep: None,
        roll_type: RollType::Flat,
        is_subtraction: None,
        pinned: false,
    }
}

/// `{ ...defaultConfig, ...patch }`.
fn config_from_patch(p: &RollConfigPatch) -> RollConfig {
    let d = default_config();
    RollConfig {
        count: p.count.unwrap_or(d.count),
        sides: p.sides.unwrap_or(d.sides),
        modifier: p.modifier.unwrap_or(d.modifier),
        reroll: p.reroll.unwrap_or(d.reroll),
        explode: p.explode.unwrap_or(d.explode),
        explode_pool_budget: p.explode_pool_budget.unwrap_or(d.explode_pool_budget),
        minimum: p.minimum.unwrap_or(d.minimum),
        best_of: p.best_of.unwrap_or(d.best_of),
        keep: p.keep,
        roll_type: p.roll_type.unwrap_or(d.roll_type),
        is_subtraction: p.is_subtraction,
        pinned: p.pinned,
    }
}

/// `ACBuilder.resolvedConfigs`: `configs` with `advantageDice` folded in: an `advantage` natural roll
/// is `elven accuracy` when the check rolls three dice. An own `elven accuracy` stays as it is.
pub(crate) fn ac_resolved_configs(
    configs: &[RollConfig],
    advantage_dice: AdvantageDice,
) -> Vec<RollConfig> {
    let mut out = configs.to_vec();
    if let Some(idx) = natural_roll_index(configs)
        && configs[idx].roll_type == RollType::Advantage
        && advantage_dice == AdvantageDice::Three
    {
        out[idx].roll_type = RollType::ElvenAccuracy;
    }
    out
}

/// `naturalRollIndex`: index of the config holding a check's natural roll (the die whose 1 misses
/// and whose 20 hits and crits), or `None` when no config can be one. Only a rolled, added die can:
/// a subtracted or zero-count group never is. A d20 outranks every other die; with no d20 the
/// largest die does, and the first of equal dice wins.
pub fn natural_roll_index(configs: &[RollConfig]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, c) in configs.iter().enumerate() {
        if not_positive(c.sides) || not_positive(c.count) || c.is_subtraction == Some(true) {
            continue;
        }
        match best {
            None => best = Some(i),
            Some(b) => {
                let top = configs[b].sides;
                if top != 20.0 && (c.sides == 20.0 || c.sides > top) {
                    best = Some(i);
                }
            }
        }
    }
    best
}

/// `ParsedCheckError`: a parsed string used as an attack or save check.
fn parsed_check_error(expression: &str, verb: &str) -> DiceError {
    let (example, full) = if verb == "ac" {
        ("d20.plus(5).ac(15)", "(d20 + 5 AC 15) * (1d8)")
    } else {
        ("d20.plus(5).dc(15)", "(d20 + 5 DC 15) * (8d6) save half")
    };
    DiceError::ParsedCheck(Box::new(ParsedCheckError {
        expression: expression.to_string(),
        verb: verb.to_string(),
        message: format!(
            "Cannot use the parsed string \"{expression}\" as a check with .{verb}(): a parsed roll carries no dice or flats for the check to read. Build the check with the builder API ({example}) or parse a full attack or save string (\"{full}\")."
        ),
    }))
}

/// A group that `roll(N, X)` must copy N times rather than scale: its dice count is part of its
/// meaning.
fn repeats_by_copy(config: &RollConfig) -> bool {
    config.keep.is_some() || config.best_of > 0.0 || config.explode_pool_budget > 0.0
}

/// `validateScaleInt`: a `scaleDice`/`doubleDice` multiplier must be a positive integer.
fn validate_scale_int(scale: f64) -> Result<f64, DiceError> {
    let scale_int = scale.floor();
    if scale_int != scale {
        return Err(DiceError::error("Scale must be an integer"));
    }
    if scale_int <= 0.0 {
        return Err(DiceError::error("Scale must be > 0"));
    }
    Ok(scale_int)
}

/// `ambiguousScaling`: why scaling `config`'s dice by `scale` has no single meaning, if it has none.
fn ambiguous_scaling(config: &RollConfig, scale: f64) -> Option<String> {
    let die = format!("d{}", num_to_string(config.sides));
    if config.roll_type != RollType::Flat {
        let rt = config.roll_type.as_str();
        return Some(format!(
            "a {die} rolled with {rt} has no single doubled meaning (twice as many dice each rolled with {rt}, or {rt} over the doubled sum)"
        ));
    }
    if let Some(keep) = config.keep {
        if keep.count == 1.0 && keep.mode == KeepMode::Highest {
            return None;
        }
        return Some(format!(
            "the per-die keep `{}{}{}` of {die} has no single doubled meaning (only keep-highest-of-1, \"roll it N times, keep the best\", doubles its dice inside each trial)",
            num_to_string(keep.total),
            if keep.mode == KeepMode::Highest {
                "kh"
            } else {
                "kl"
            },
            num_to_string(keep.count)
        ));
    }
    let dice = config.count.abs();
    if config.best_of > 0.0 && config.best_of < dice * scale {
        return Some(format!(
            "bestOf({}) on {}{die} keeps individual dice from the scaled pool, which has no single doubled meaning",
            num_to_string(config.best_of),
            num_to_string(dice)
        ));
    }
    None
}

/// The `TypeError` for reading a property of an absent config.
fn type_error_get(prop: &str) -> DiceError {
    DiceError::type_error(format!(
        "Cannot read properties of undefined (reading '{prop}')"
    ))
}

/// The `TypeError` for assigning a property of an absent config.
fn type_error_set(prop: &str) -> DiceError {
    DiceError::type_error(format!(
        "Cannot set properties of undefined (setting '{prop}')"
    ))
}

/// The last of `configs` to assign to (`newConfigs[newConfigs.length - 1].x = ...`).
fn last_to_set<'a>(
    configs: &'a mut [RollConfig],
    prop: &str,
) -> Result<&'a mut RollConfig, DiceError> {
    configs.last_mut().ok_or_else(|| type_error_set(prop))
}

/// An argument of `RollBuilder.fromArgs(...args)` / `onHit(...args)`.
#[derive(Clone, Debug)]
pub enum Arg {
    Undefined,
    Num(f64),
    Str(String),
    Roll(RollBuilder),
}

impl From<RollBuilder> for Arg {
    fn from(roll: RollBuilder) -> Self {
        Arg::Roll(roll)
    }
}

impl From<&RollBuilder> for Arg {
    fn from(roll: &RollBuilder) -> Self {
        Arg::Roll(roll.clone())
    }
}

impl From<&str> for Arg {
    fn from(expression: &str) -> Self {
        Arg::Str(expression.to_string())
    }
}

impl From<String> for Arg {
    fn from(expression: String) -> Self {
        Arg::Str(expression)
    }
}

macro_rules! arg_from_number {
    ($($t:ty),*) => {$(
        impl From<$t> for Arg {
            fn from(n: $t) -> Self {
                Arg::Num(f64::from(n))
            }
        }
    )*};
}
arg_from_number!(f64, f32, i8, i16, i32, u8, u16, u32);

impl Arg {
    /// `String(arg)` as `args.join(", ")` writes it (`undefined` joins as the empty string).
    fn join_text(&self) -> String {
        match self {
            Arg::Undefined => String::new(),
            Arg::Num(n) => num_to_string(*n),
            Arg::Str(s) => s.clone(),
            Arg::Roll(_) => "[object Object]".to_string(),
        }
    }
}

/// `CritConfig & { ac?, range?, missReroll? }`: the attack config of an always-hit or always-crit
/// check (`ac` and `missReroll` are always `None` on an always-hit check).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AttackConfig {
    pub crit_threshold: f64,
    pub ac: Option<f64>,
    pub range: Option<AttackRange>,
    pub miss_reroll: Option<MissRerollMode>,
}

impl AttackConfig {
    fn default_check() -> AttackConfig {
        AttackConfig {
            crit_threshold: 20.0,
            ac: None,
            range: None,
            miss_reroll: None,
        }
    }
}

/// What `miss-reroll.ts` reads off an always-crit (or AC) check.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CritCheckParts {
    pub ac: Option<f64>,
    pub crit_threshold: f64,
    /// `"fromAlwaysHit" in check`: true for an always-crit check, false for an AC check.
    pub crit_on_hit: bool,
}

/// How a [`RollKind::Pooled`] roll prints itself and rebuilds when its dice scale: the TS closures
/// `baseExpression` and `repoolScaled`, as data.
#[derive(Clone, Debug, PartialEq)]
pub enum PoolSource {
    /// `keepHighestAll(total, count)` / `keepLowestAll` of `source`.
    KeepAll {
        source: Box<RollBuilder>,
        total: f64,
        count: f64,
        mode: KeepMode,
    },
    /// `times(count)` of the pooled roll `source`.
    Times {
        source: Box<RollBuilder>,
        count: f64,
    },
}

impl PoolSource {
    /// `baseExpression()`.
    fn expression(&self) -> Result<String, DiceError> {
        match self {
            PoolSource::KeepAll {
                source,
                total,
                count,
                mode,
            } => {
                if total.floor() <= 0.0 || *count <= 0.0 {
                    return Ok("0".to_string());
                }
                Ok(format!(
                    "{}k{}{}({})",
                    num_to_string(*total),
                    if *mode == KeepMode::Highest { "h" } else { "l" },
                    num_to_string(*count),
                    source.to_expression()?
                ))
            }
            PoolSource::Times { source, count } => {
                if *count == 0.0 {
                    Ok("0".to_string())
                } else if *count == 1.0 {
                    source.to_expression()
                } else {
                    Ok(format!(
                        "{}({})",
                        num_to_string(*count),
                        source.to_expression()?
                    ))
                }
            }
        }
    }

    /// `repoolScaled(scale)`: the pool rebuilt from its pre-pool roll with that roll's dice scaled.
    fn repool_scaled(&self, scale: f64) -> Result<RollBuilder, DiceError> {
        match self {
            PoolSource::KeepAll {
                source,
                total,
                count,
                mode,
            } => {
                let scaled = source.scale_dice(scale)?;
                match mode {
                    KeepMode::Highest => scaled.keep_highest_all(*total, *count),
                    KeepMode::Lowest => scaled.keep_lowest_all(*total, *count),
                }
            }
            PoolSource::Times { source, count } => source.scale_dice(scale)?.times(*count),
        }
    }
}

/// `RerollUpToOptions`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RerollUpToOptions {
    /// Roll the dice this many times and keep the roll that is worth most once its own rerolls are
    /// spent (Savage Attacker with a reroll budget). Default 1.
    pub rolls: Option<f64>,
}

/// `RollRerollUpToOptions`: [`RerollUpToOptions`] and the dice rolled once.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RollRerollUpToOptions {
    pub rolls: Option<f64>,
    /// Plain dice (and flats) in the same reroll pool that are rolled once whatever `rolls` is.
    pub rolled_once: Option<RollBuilder>,
}

/// The subclass of a [`RollBuilder`].
#[derive(Clone, Debug, PartialEq)]
pub enum RollKind {
    /// A plain `RollBuilder`.
    Plain,
    /// `HalfRollBuilder`.
    Half { inner: Box<RollBuilder> },
    /// `ScaleRollBuilder`.
    Scale {
        inner: Box<RollBuilder>,
        numerator: f64,
        denominator: f64,
        rounding: Rounding,
    },
    /// `MaxOfRollBuilder` (`dice_count`/`dice_sides` are carried as in TS and never read).
    MaxOf {
        inner: Box<RollBuilder>,
        count: f64,
        dice_count: Option<f64>,
        dice_sides: Option<f64>,
    },
    /// `RerollUpToRollBuilder`.
    RerollUpTo {
        inner: Box<RollBuilder>,
        budget: f64,
        rolls: f64,
        rolled_once: Option<Box<RollBuilder>>,
    },
    /// `AlwaysHitBuilder`.
    AlwaysHit { attack: AttackConfig },
    /// `AlwaysCritBuilder`.
    AlwaysCrit {
        attack: AttackConfig,
        from_always_hit: bool,
    },
    /// `ParsedRollBuilder`: the PMF is computed at construction with eps 0.
    Parsed { pmf: Arc<Pmf>, expression: String },
    /// `PooledRollBuilder`.
    Pooled {
        base_ast: ExpressionNode,
        source: PoolSource,
    },
    /// `CompositeSumRollBuilder`: built by [`sum_rolls`].
    CompositeSum { parts: Vec<RollBuilder> },
    /// `MaxOfRollsBuilder`: the higher of independent, possibly different rolls.
    MaxOfRolls { rolls: Vec<RollBuilder> },
    /// `ACBuilder` (see `ac.rs`): `attack.ac` is always `Some`.
    Ac {
        attack: AttackConfig,
        advantage_dice: AdvantageDice,
    },
    /// `DCBuilder` (see `dc.rs`).
    Dc { save: SaveConfig },
}

/// The fluent builder for dice, resolved to a PMF through an AST.
#[derive(Clone, Debug, PartialEq)]
pub struct RollBuilder(Arc<RollBuilderData>);

/// The data behind a [`RollBuilder`]; shared by `Arc`, copied on write (ADR-019).
#[derive(Clone, Debug, PartialEq)]
pub struct RollBuilderData {
    /// The `subRollConfigs` field.
    configs: Vec<RollConfig>,
    kind: RollKind,
    /// Builder nesting below this one (see the module doc).
    depth: usize,
    /// [`RollBuilder::cache_key`], reset on every copy-on-write mutation.
    key: Memo<Option<String>>,
}

fn nested_depth(inner: &[&RollBuilder]) -> Result<usize, DiceError> {
    let depth = 1 + inner.iter().map(|b| b.depth).max().unwrap_or(0);
    if depth > MAX_BUILDER_DEPTH {
        return Err(DiceError::stack_overflow());
    }
    Ok(depth)
}

impl RollBuilder {
    // ---- construction ----

    pub(crate) fn from_parts(
        configs: Vec<RollConfig>,
        kind: RollKind,
        depth: usize,
    ) -> RollBuilder {
        RollBuilder::from(RollBuilderData {
            configs,
            kind,
            depth,
            key: Memo::default(),
        })
    }

    /// `[{ ...defaultConfig, count, isSubtraction: count < 0 }]`.
    pub(crate) fn count_config(count: f64) -> RollConfig {
        RollConfig {
            count,
            is_subtraction: Some(count < 0.0),
            ..default_config()
        }
    }

    /// `new RollBuilder(0)`.
    pub fn zero() -> RollBuilder {
        Self::from_parts(vec![Self::count_config(0.0)], RollKind::Plain, 0)
    }

    /// `new RollBuilder(1).d(sides)` for a finite, positive `sides`.
    pub fn single_die(sides: f64) -> RollBuilder {
        Self::from_parts(
            vec![RollConfig {
                sides,
                ..Self::count_config(1.0)
            }],
            RollKind::Plain,
            0,
        )
    }

    /// `reroll(value)` on a plain roll with at least one group, without argument checks: the
    /// `hd20` constant of the factory.
    pub(crate) fn with_reroll_unchecked(mut self, value: f64) -> RollBuilder {
        if let Some(last) = self.configs.last_mut() {
            last.reroll = value;
        }
        self
    }

    /// `new RollBuilder(count)`.
    pub fn new(count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for count"));
        }
        require_finite(count, "count")?;
        Ok(Self::from_parts(
            vec![Self::count_config(count)],
            RollKind::Plain,
            0,
        ))
    }

    /// `new RollBuilder(configs)`.
    pub fn with_configs(configs: &[RollConfig]) -> RollBuilder {
        Self::from_parts(configs.to_vec(), RollKind::Plain, 0)
    }

    /// `RollBuilder.fromConfig(config)` (for testing).
    pub fn from_config(config: &RollConfigPatch) -> RollBuilder {
        Self::with_configs(&[config_from_patch(config)])
    }

    /// `RollBuilder.fromConfigs(configs)`.
    pub fn from_configs(configs: &[RollConfigPatch]) -> RollBuilder {
        let full: Vec<RollConfig> = configs.iter().map(config_from_patch).collect();
        Self::with_configs(&full)
    }

    /// `new ParsedRollBuilder(expression)`: parses with eps 0.
    pub fn parsed(expression: &str) -> Result<RollBuilder, DiceError> {
        let pmf = parse(expression)?;
        Ok(Self::from_parts(
            Vec::new(),
            RollKind::Parsed {
                pmf: Arc::new(pmf),
                expression: expression.to_string(),
            },
            0,
        ))
    }

    /// `RollBuilder.fromArgs(...args)`.
    pub fn from_args(args: &[Arg]) -> Result<RollBuilder, DiceError> {
        if args.len() == 1 {
            match &args[0] {
                Arg::Num(n) => {
                    if n.is_nan() {
                        return Err(DiceError::error("Invalid NaN value for argument"));
                    }
                    return Self::new(0.0)?.plus(*n);
                }
                Arg::Str(s) => return Self::parsed(s),
                Arg::Roll(r) => return Ok(r.clone()),
                Arg::Undefined => {}
            }
        }

        if args.len() == 2 || args.len() == 3 {
            let count = match &args[0] {
                Arg::Num(n) => *n,
                _ => {
                    return Err(DiceError::error(
                        "First argument must be a number for multi-arg call",
                    ));
                }
            };
            if count.is_nan() {
                return Err(DiceError::error("Invalid NaN value for count argument"));
            }
            let modifier = match args.get(2) {
                Some(Arg::Num(m)) => Some(*m),
                _ => None,
            };
            match &args[1] {
                Arg::Roll(die) => {
                    let repeated = Self::repeated(die, count)?;
                    return match modifier {
                        Some(m) => repeated.plus(m),
                        None => Ok(repeated),
                    };
                }
                Arg::Num(sides) => {
                    if sides.is_nan() {
                        return Err(DiceError::error("Invalid NaN value for sides argument"));
                    }
                    let builder = Self::new(count)?.d(*sides)?;
                    return match modifier {
                        Some(m) => builder.plus(m),
                        None => Ok(builder),
                    };
                }
                Arg::Undefined => {
                    let builder = Self::new(count)?;
                    return match modifier {
                        Some(m) => builder.plus(m),
                        None => Ok(builder),
                    };
                }
                Arg::Str(_) => {}
            }
        }

        Err(DiceError::error(format!(
            "Invalid arguments passed: {}",
            args.iter()
                .map(Arg::join_text)
                .collect::<Vec<_>>()
                .join(", ")
        )))
    }

    /// `RollBuilder.repeated(die, count)`: `count` independent copies of `die`, subtracted when
    /// `count` is negative. A plain group scales its dice count; a group whose count is part of its
    /// meaning (a keep, `bestOf()`, `explodePool()`) is copied. Each copy brings its own flat
    /// modifier, negated with the dice when subtracted.
    pub fn repeated(die: &RollBuilder, count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if die.is_transformed() {
            let copies = count.abs().floor();
            if copies == 0.0 {
                return Ok(Self::zero());
            }
            if copies.is_nan() {
                return Ok(Self::zero());
            }
            if copies > MAX_ENUMERATED {
                return Err(DiceError::error(format!(
                    "roll({}, ...) repeats a transformed roll too many times (at most 1000000).",
                    num_to_string(count)
                )));
            }
            let parts: Vec<RollBuilder> = (0..copies as usize).map(|_| die.clone()).collect();
            let total = sum_rolls(&parts)?;
            return if count < 0.0 {
                total.scale_result(-1.0, 1.0, Rounding::Floor)
            } else {
                Ok(total)
            };
        }
        if die.has_hidden_state() {
            return Err(DiceError::error(
                "Cannot use a roll with hidden state (like a pooled roll) as a die type.",
            ));
        }
        let configs = die.get_sub_roll_configs();
        if configs.is_empty() {
            return Ok(Self::zero());
        }

        // A fractional count rolls its whole copies, as a fractional die count rolls its whole dice.
        let copies = count.abs().floor();
        let negate = count < 0.0;
        let mut repeated_configs: Vec<RollConfig> = Vec::new();
        for config in &configs {
            let is_subtraction =
                (config.is_subtraction == Some(true) || config.count < 0.0) != negate;
            let dice = config.count.abs();
            let modifier = (if negate { -1.0 } else { 1.0 }) * config.modifier * copies;
            if copies > 1.0 && repeats_by_copy(config) {
                if copies > MAX_ENUMERATED {
                    return Err(DiceError::error(format!(
                        "roll({}, ...) repeats a group too many times (at most 1000000).",
                        num_to_string(count)
                    )));
                }
                for i in 0..copies as usize {
                    repeated_configs.push(RollConfig {
                        count: dice,
                        is_subtraction: Some(is_subtraction),
                        modifier: if i == 0 { modifier } else { 0.0 },
                        ..config.clone()
                    });
                }
            } else {
                repeated_configs.push(RollConfig {
                    count: dice * copies,
                    is_subtraction: Some(is_subtraction),
                    modifier,
                    ..config.clone()
                });
            }
        }
        Ok(Self::with_configs(&repeated_configs))
    }

    // ---- kind queries ----

    /// This roll's subclass.
    pub fn kind(&self) -> &RollKind {
        &self.kind
    }

    /// `instanceof TransformedRollBuilder`.
    pub fn is_transformed(&self) -> bool {
        self.transformed_verb().is_some()
    }

    /// `instanceof ParsedRollBuilder`.
    pub fn is_parsed(&self) -> bool {
        matches!(self.kind, RollKind::Parsed { .. })
    }

    /// `instanceof PooledRollBuilder`.
    pub fn is_pooled(&self) -> bool {
        matches!(self.kind, RollKind::Pooled { .. })
    }

    /// `instanceof RerollUpToRollBuilder`.
    pub fn is_reroll_up_to(&self) -> bool {
        matches!(self.kind, RollKind::RerollUpTo { .. })
    }

    /// `instanceof AlwaysHitBuilder`.
    pub fn is_always_hit(&self) -> bool {
        matches!(self.kind, RollKind::AlwaysHit { .. })
    }

    /// `instanceof AlwaysCritBuilder`.
    pub fn is_always_crit(&self) -> bool {
        matches!(self.kind, RollKind::AlwaysCrit { .. })
    }

    /// `instanceof ACBuilder`.
    pub fn is_ac(&self) -> bool {
        matches!(self.kind, RollKind::Ac { .. })
    }

    /// `instanceof DCBuilder`.
    pub fn is_dc(&self) -> bool {
        matches!(self.kind, RollKind::Dc { .. })
    }

    /// `fromAlwaysHit` of an always-crit check.
    pub fn from_always_hit(&self) -> Option<bool> {
        match &self.kind {
            RollKind::AlwaysCrit {
                from_always_hit, ..
            } => Some(*from_always_hit),
            _ => None,
        }
    }

    /// `attackConfig` of an always-hit or always-crit check.
    pub fn attack_config(&self) -> Option<&AttackConfig> {
        match &self.kind {
            RollKind::AlwaysHit { attack }
            | RollKind::AlwaysCrit { attack, .. }
            | RollKind::Ac { attack, .. } => Some(attack),
            _ => None,
        }
    }

    /// `critThreshold` of an always-hit or always-crit check.
    pub fn crit_threshold(&self) -> Option<f64> {
        self.attack_config().map(|a| a.crit_threshold)
    }

    /// The parts `miss-reroll.ts` reads off a check: an always-crit check, or an AC check
    /// (`crit_on_hit: false`).
    pub fn crit_check_parts(&self) -> Option<CritCheckParts> {
        match &self.kind {
            RollKind::Ac { attack, .. } => Some(CritCheckParts {
                ac: attack.ac,
                crit_threshold: attack.crit_threshold,
                crit_on_hit: false,
            }),
            RollKind::AlwaysCrit { attack, .. } => Some(CritCheckParts {
                ac: attack.ac,
                crit_threshold: attack.crit_threshold,
                crit_on_hit: true,
            }),
            _ => None,
        }
    }

    /// The `verb` of a `TransformedRollBuilder`, `None` for any other roll.
    fn transformed_verb(&self) -> Option<&'static str> {
        match &self.kind {
            RollKind::Half { .. } => Some("half()"),
            RollKind::Scale { .. } => Some("scaleResult()"),
            RollKind::MaxOf { .. } | RollKind::MaxOfRolls { .. } => Some("maxOf()"),
            RollKind::RerollUpTo { .. } => Some("rerollUpTo()"),
            RollKind::CompositeSum { .. } => Some("sumRolls()"),
            _ => None,
        }
    }

    /// `ParsedCheckError` for a parsed roll used as an `ac()`/`dc()` check (`verb` is `"ac"` or
    /// `"dc"`); `ac.rs`/`dc.rs` call this first.
    pub fn refuse_parsed_check(&self, verb: &str) -> Result<(), DiceError> {
        match &self.kind {
            RollKind::Parsed { expression, .. } => Err(parsed_check_error(expression, verb)),
            _ => Ok(()),
        }
    }

    /// `hasHiddenState()`.
    pub fn has_hidden_state(&self) -> bool {
        match &self.kind {
            RollKind::Half { inner }
            | RollKind::Scale { inner, .. }
            | RollKind::MaxOf { inner, .. } => inner.has_hidden_state(),
            RollKind::Plain
            | RollKind::AlwaysHit { .. }
            | RollKind::AlwaysCrit { .. }
            | RollKind::Ac { .. }
            | RollKind::Dc { .. } => false,
            RollKind::RerollUpTo { .. }
            | RollKind::Parsed { .. }
            | RollKind::Pooled { .. }
            | RollKind::CompositeSum { .. }
            | RollKind::MaxOfRolls { .. } => true,
        }
    }

    // ---- config access ----

    /// `create(configs)`: a roll of the same kind with new configs. A transformed roll refuses.
    fn create(&self, configs: Vec<RollConfig>) -> Result<RollBuilder, DiceError> {
        if let Some(verb) = self.transformed_verb() {
            return Err(DiceError::error(format!(
                "Cannot change the dice of a {verb} roll: that would drop the {verb} transform. Set reroll/minimum/explode/keep/advantage on the roll before calling {verb}."
            )));
        }
        Ok(match &self.kind {
            RollKind::Pooled { .. } => Self::from_parts(configs, self.kind.clone(), self.depth),
            _ => Self::from_parts(configs, RollKind::Plain, 0),
        })
    }

    /// `lastConfig`: the last config, read through a wrapped roll.
    fn last_config(&self) -> Option<&RollConfig> {
        match &self.kind {
            RollKind::Half { inner }
            | RollKind::Scale { inner, .. }
            | RollKind::MaxOf { inner, .. }
            | RollKind::RerollUpTo { inner, .. } => inner.last_config(),
            _ => self.configs.last(),
        }
    }

    fn last_config_get(&self, prop: &str) -> Result<&RollConfig, DiceError> {
        self.last_config().ok_or_else(|| type_error_get(prop))
    }

    /// `getSubRollConfigs()`: a copy of this roll's configs (a wrapped roll's, for a transform).
    pub fn get_sub_roll_configs(&self) -> Vec<RollConfig> {
        match &self.kind {
            RollKind::Half { inner }
            | RollKind::Scale { inner, .. }
            | RollKind::MaxOf { inner, .. } => inner.get_sub_roll_configs(),
            RollKind::RerollUpTo {
                inner, rolled_once, ..
            } => {
                let mut own = inner.get_sub_roll_configs();
                if let Some(once) = rolled_once {
                    own.extend(once.get_sub_roll_configs());
                }
                own
            }
            RollKind::CompositeSum { .. } | RollKind::MaxOfRolls { .. } => Vec::new(),
            _ => self.configs.clone(),
        }
    }

    /// The raw `subRollConfigs` field.
    pub fn raw_configs(&self) -> &[RollConfig] {
        &self.configs
    }

    /// `getAllDieConfigs()`.
    pub fn get_all_die_configs(&self) -> Vec<RollConfig> {
        self.get_sub_roll_configs()
    }

    /// Index into [`RollBuilder::raw_configs`] of the config [`RollBuilder::get_root_die_config`]
    /// returns: the natural roll's, or the first config when there is none.
    pub fn root_die_index(&self) -> Option<usize> {
        match natural_roll_index(&self.configs) {
            Some(i) => Some(i),
            None if self.configs.is_empty() => None,
            None => Some(0),
        }
    }

    /// `getRootDieConfig()`: the config carrying this roll's natural die, or with no such die the
    /// first config (so `rollType`/`baseReroll` still read a flat roll's own fields).
    pub fn get_root_die_config(&self) -> Option<RollConfig> {
        if let RollKind::Ac { advantage_dice, .. } = &self.kind {
            let configs = ac_resolved_configs(&self.configs, *advantage_dice);
            return match natural_roll_index(&configs) {
                Some(i) => configs.get(i).cloned(),
                None => configs.first().cloned(),
            };
        }
        self.root_die_index().map(|i| self.configs[i].clone())
    }

    /// `getBonusDiceConfigs()`: the check's dice other than its natural die, each WITHOUT its flat
    /// modifier.
    pub fn get_bonus_dice_configs(&self) -> Vec<RollConfig> {
        let root = natural_roll_index(&self.configs);
        self.configs
            .iter()
            .enumerate()
            .filter(|(i, c)| c.sides > 0.0 && Some(*i) != root)
            .map(|(_, c)| RollConfig {
                modifier: 0.0,
                ..c.clone()
            })
            .collect()
    }

    /// `getBonusDicePMFs(check, eps)`.
    pub fn get_bonus_dice_pmfs(
        &self,
        check: &RollBuilder,
        eps: f64,
    ) -> Result<Vec<Pmf>, DiceError> {
        check
            .get_bonus_dice_configs()
            .iter()
            .map(|config| {
                pmf_from_roll_builder(&Self::with_configs(std::slice::from_ref(config)), eps)
            })
            .collect()
    }

    /// `modifier`: the sum of the flat modifiers of the raw configs.
    pub fn modifier(&self) -> f64 {
        self.configs.iter().fold(0.0, |sum, c| sum + c.modifier)
    }

    /// `rollType`.
    pub fn roll_type(&self) -> RollType {
        self.get_root_die_config()
            .map_or(RollType::Flat, |c| c.roll_type)
    }

    /// `baseReroll`.
    pub fn base_reroll(&self) -> f64 {
        self.get_root_die_config()
            .map_or(0.0, |c| or_zero(c.reroll))
    }

    /// `cacheKey()`: a cheap, stable string that fully identifies this builder's PMF, or `None` for
    /// a roll whose PMF is not captured by its configs.
    pub fn cache_key(&self) -> Option<String> {
        self.0.key.get_or_init(|| self.compute_cache_key()).clone()
    }

    fn compute_cache_key(&self) -> Option<String> {
        let base = || roll_configs_key_typed(&self.configs);
        match &self.kind {
            RollKind::Plain => Some(base()),
            RollKind::AlwaysHit { attack } => Some(format!(
                "H|{}|{}",
                num_to_string(attack.crit_threshold),
                base()
            )),
            RollKind::AlwaysCrit {
                attack,
                from_always_hit,
            } => {
                let mode = match attack.miss_reroll {
                    None => String::new(),
                    Some(m) => format!("|m={}", m.as_str()),
                };
                Some(format!(
                    "C|{}|{}|{}|{}{}",
                    u8::from(*from_always_hit),
                    num_to_string(attack.crit_threshold),
                    attack.ac.map_or(String::new(), num_to_string),
                    base(),
                    mode
                ))
            }
            RollKind::Ac {
                attack,
                advantage_dice,
            } => Some(format!(
                "A|{}|{}|{}|{}{}",
                attack.ac.map_or(String::new(), num_to_string),
                num_to_string(attack.crit_threshold),
                match advantage_dice {
                    AdvantageDice::Two => 2,
                    AdvantageDice::Three => 3,
                },
                base(),
                match attack.miss_reroll {
                    None => String::new(),
                    Some(m) => format!("|m={}", m.as_str()),
                }
            )),
            RollKind::Dc { save } => Some(format!(
                "DC|{}|{}{}",
                num_to_string(save.dc),
                if save.auto_fail { "F|" } else { "" },
                base()
            )),
            _ => None,
        }
    }

    // ---- core dice methods ----

    /// `d(sides)`.
    pub fn d(&self, sides: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let sides = sides.into();
        self.d_opt(Some(sides))
    }

    /// `d(sides | undefined)`.
    pub fn d_opt(&self, sides: Option<f64>) -> Result<RollBuilder, DiceError> {
        if self.is_pooled() {
            return Err(DiceError::error(
                "Cannot add dice to a pooled roll. The pool is finalized.",
            ));
        }
        if sides.is_some_and(f64::is_nan) {
            return Err(DiceError::error("Invalid NaN value for sides"));
        }
        let Some(sides) = sides else {
            return Ok(self.clone());
        };
        require_finite(sides, "sides")?;
        if sides < 0.0 {
            return Err(DiceError::error(format!(
                "sides must not be negative, got {}",
                num_to_string(sides)
            )));
        }
        let last_sides = self.last_config_get("sides")?.sides;
        if last_sides != 0.0 && !last_sides.is_nan() && last_sides > 0.0 {
            return Err(DiceError::error("Cannot add a die after adding a die"));
        }
        if sides == 0.0 {
            return Ok(self.clone());
        }
        let mut new_configs = self.get_sub_roll_configs();
        last_to_set(&mut new_configs, "sides")?.sides = sides;
        self.create(new_configs)
    }

    /// `d4()`.
    pub fn d4(&self) -> Result<RollBuilder, DiceError> {
        self.d(4.0)
    }
    /// `d6()`.
    pub fn d6(&self) -> Result<RollBuilder, DiceError> {
        self.d(6.0)
    }
    /// `d8()`.
    pub fn d8(&self) -> Result<RollBuilder, DiceError> {
        self.d(8.0)
    }
    /// `d10()`.
    pub fn d10(&self) -> Result<RollBuilder, DiceError> {
        self.d(10.0)
    }
    /// `d12()`.
    pub fn d12(&self) -> Result<RollBuilder, DiceError> {
        self.d(12.0)
    }
    /// `d20()`.
    pub fn d20(&self) -> Result<RollBuilder, DiceError> {
        self.d(20.0)
    }
    /// `d100()`.
    pub fn d100(&self) -> Result<RollBuilder, DiceError> {
        self.d(100.0)
    }

    /// `plus(mod)`: adds a flat modifier to the last group.
    pub fn plus(&self, modifier: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let modifier = modifier.into();
        if modifier.is_nan() {
            return Err(DiceError::error("Invalid NaN value for modOrRoll"));
        }
        require_finite(modifier, "plus()/minus() argument")?;
        if self.is_transformed() {
            if modifier == 0.0 {
                return Ok(self.clone());
            }
            return sum_rolls(&[self.clone(), Self::zero().plus(modifier)?]);
        }
        if modifier == 0.0 {
            return Ok(self.clone());
        }
        let mut new_configs = self.get_sub_roll_configs();
        match new_configs.last_mut() {
            Some(last) => last.modifier += modifier,
            None => return Err(type_error_get("modifier")),
        }
        self.create(new_configs)
    }

    /// `plus(roll)`.
    pub fn plus_roll(&self, roll: &RollBuilder) -> Result<RollBuilder, DiceError> {
        self.add(roll)
    }

    /// `plus(count, die)`: `count` copies of `die` (see [`RollBuilder::repeated`]).
    pub fn plus_dice(
        &self,
        count: impl Into<f64>,
        die: &RollBuilder,
    ) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for modOrRoll"));
        }
        require_finite(count, "plus()/minus() argument")?;
        self.add(&Self::repeated(die, count)?)
    }

    /// `minus(mod)`.
    pub fn minus(&self, modifier: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let modifier = modifier.into();
        self.plus(-modifier)
    }

    /// `minus(roll)`.
    pub fn minus_roll(&self, roll: &RollBuilder) -> Result<RollBuilder, DiceError> {
        self.plus_dice(-1.0, roll)
    }

    /// `minus(count, die)`.
    pub fn minus_dice(
        &self,
        count: impl Into<f64>,
        die: &RollBuilder,
    ) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        self.plus_dice(-count, die)
    }

    /// Reroll faces 1..`value` once and keep the second roll (Great Weapon Fighting in the 2014
    /// rules). The reroll decides on the die's raw face; a `minimum` applies to the kept face.
    pub fn reroll(&self, value: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let value = value.into();
        if self.is_pooled() {
            return Err(DiceError::error("Cannot set reroll on a pooled roll."));
        }
        if value.is_nan() {
            return Err(DiceError::error("Invalid NaN value for reroll"));
        }
        require_finite(value, "reroll()")?;
        if value == self.last_config_get("reroll")?.reroll {
            return Ok(self.clone());
        }
        let mut new_configs = self.get_sub_roll_configs();
        last_to_set(&mut new_configs, "reroll")?.reroll = value;
        self.create(new_configs)
    }

    /// Let each die explode: a roll of its highest face adds another die, at most `count` extra
    /// dice per die. The cap must be finite; `explode(0)` is a no-op.
    pub fn explode(&self, count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if self.is_pooled() {
            return Err(DiceError::error("Cannot set explode on a pooled roll."));
        }
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for explode count"));
        }
        require_finite(count, "explode() cap")?;
        if count == 0.0 {
            return Ok(self.clone());
        }
        if count < 0.0 {
            return Err(DiceError::error("Explode count must be >= 0"));
        }
        if self
            .last_config_get("explodePoolBudget")?
            .explode_pool_budget
            > 0.0
        {
            return Err(DiceError::error(
                "Cannot set explode() on a config that already has a pool-wide explodePool() budget — the two exploding-dice semantics (per-die vs pool-wide) are mutually exclusive on one config.",
            ));
        }
        let mut new_configs = self.get_sub_roll_configs();
        last_to_set(&mut new_configs, "explode")?.explode = count;
        self.create(new_configs)
    }

    /// Set a pool-wide exploding-dice budget: at most `budget` extra dice may be added across the
    /// WHOLE pool, as opposed to [`RollBuilder::explode`]'s per-die cap.
    pub fn explode_pool(&self, budget: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let budget = budget.into();
        if self.is_pooled() {
            return Err(DiceError::error("Cannot set explodePool on a pooled roll."));
        }
        if budget.is_nan() {
            return Err(DiceError::error("Invalid NaN value for explodePool budget"));
        }
        if !budget.is_finite() {
            return Err(DiceError::error("explodePool budget must be finite"));
        }
        if budget < 0.0 {
            return Err(DiceError::error("explodePool budget must be >= 0"));
        }
        if budget == 0.0 {
            return Ok(self.clone());
        }
        if self.last_config_get("explode")?.explode > 0.0 {
            return Err(DiceError::error(
                "Cannot set explodePool() on a config that already has a per-die explode() cap — the two exploding-dice semantics (per-die vs pool-wide) are mutually exclusive on one config.",
            ));
        }
        let mut new_configs = self.get_sub_roll_configs();
        last_to_set(&mut new_configs, "explodePoolBudget")?.explode_pool_budget = budget.floor();
        self.create(new_configs)
    }

    /// Floor each die at `val`: `minimum(3)` treats a 1 or 2 as a 3 (the 2024 Great Weapon
    /// Fighting style).
    pub fn minimum(&self, val: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let val = val.into();
        if self.is_pooled() {
            return Err(DiceError::error("Cannot set minimum on a pooled roll."));
        }
        if val.is_nan() {
            return Err(DiceError::error("Invalid NaN value for minimum"));
        }
        require_finite(val, "minimum()")?;
        if val == 0.0 {
            return Ok(self.clone());
        }
        if val < 0.0 {
            return Err(DiceError::error("Minimum value must be >= 0"));
        }
        let mut new_configs = self.get_sub_roll_configs();
        last_to_set(&mut new_configs, "minimum")?.minimum = val;
        self.create(new_configs)
    }

    /// `bestOf(count)`.
    pub fn best_of(&self, count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if self.is_pooled() {
            return Err(DiceError::error("Cannot set bestOf on a pooled roll."));
        }
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for bestOf count"));
        }
        require_finite(count, "bestOf()")?;
        if count <= 0.0 {
            return Err(DiceError::error("Best of count must be > 0"));
        }
        let mut new_configs = self.get_sub_roll_configs();
        last_to_set(&mut new_configs, "bestOf")?.best_of = count;
        self.create(new_configs)
    }

    /// Keep the highest `count` of `total`. On one die, that is `count` of `total` rolls of the die;
    /// on N dice it is `count` of the N dice when `total` is N and `count` >= 2, or the best of
    /// `total` rolls of the whole N-dice group when `count` is 1. Any other shape on N > 1 dice has
    /// more than one reading and returns the `AmbiguousKeepError` message.
    pub fn keep_highest(
        &self,
        total: impl Into<f64>,
        count: impl Into<f64>,
    ) -> Result<RollBuilder, DiceError> {
        let total = total.into();
        let count = count.into();
        if self.is_pooled() {
            return Err(DiceError::error(
                "Cannot use keepHighest on a pooled roll. Use keepHighestAll again if you want nested pooling.",
            ));
        }
        if total.is_nan() || count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for keepHighest"));
        }
        self.with_keep(KeepSpec {
            total,
            count,
            mode: KeepMode::Highest,
        })
    }

    /// Keep the lowest `count` of `total`; the mirror of [`RollBuilder::keep_highest`].
    pub fn keep_lowest(
        &self,
        total: impl Into<f64>,
        count: impl Into<f64>,
    ) -> Result<RollBuilder, DiceError> {
        let total = total.into();
        let count = count.into();
        if self.is_pooled() {
            return Err(DiceError::error(
                "Cannot use keepLowest on a pooled roll. Use keepLowestAll again if you want nested pooling.",
            ));
        }
        if total.is_nan() || count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for keepLowest"));
        }
        self.with_keep(KeepSpec {
            total,
            count,
            mode: KeepMode::Lowest,
        })
    }

    fn with_keep(&self, keep: KeepSpec) -> Result<RollBuilder, DiceError> {
        require_finite(keep.total, "keep total")?;
        require_finite(keep.count, "keep count")?;
        let mut new_configs = self.get_sub_roll_configs();
        let last = new_configs
            .last_mut()
            .ok_or_else(|| type_error_get("sides"))?;
        if last.sides > 0.0 && last.roll_type == RollType::Flat {
            per_die_keep_reading(last.count, last.sides, &keep, false)?;
        }
        last.keep = Some(keep);
        self.create(new_configs)
    }

    fn keep_all(&self, total: f64, count: f64, mode: KeepMode) -> Result<RollBuilder, DiceError> {
        let name = if mode == KeepMode::Highest {
            "keepHighestAll"
        } else {
            "keepLowestAll"
        };
        if total.is_nan() || count.is_nan() {
            return Err(DiceError::error(format!("Invalid NaN value for {name}")));
        }
        require_finite(total, &format!("{name}() total"))?;
        require_finite(count, &format!("{name}() count"))?;
        let current_ast = self.to_ast()?;
        // Wrap in SumNode to represent trials, then KeepNode.
        let trial_pool = SumNode {
            count: total,
            child: Box::new(current_ast),
            explode_pool_budget: None,
        };
        let keep_node = KeepNode {
            mode,
            count,
            child: Box::new(KeepChild::Sum(trial_pool)),
        };
        let depth = nested_depth(&[self])?;
        Ok(Self::from_parts(
            vec![Self::count_config(0.0)],
            RollKind::Pooled {
                base_ast: ExpressionNode::Keep(keep_node),
                source: PoolSource::KeepAll {
                    source: Box::new(self.clone()),
                    total,
                    count,
                    mode,
                },
            },
            depth,
        ))
    }

    /// Keep the highest `count` of `total` rolls of this whole roll: a pooled roll.
    pub fn keep_highest_all(
        &self,
        total: impl Into<f64>,
        count: impl Into<f64>,
    ) -> Result<RollBuilder, DiceError> {
        let total = total.into();
        let count = count.into();
        self.keep_all(total, count, KeepMode::Highest)
    }

    /// Keep the lowest `count` of `total` rolls of this whole roll: a pooled roll.
    pub fn keep_lowest_all(
        &self,
        total: impl Into<f64>,
        count: impl Into<f64>,
    ) -> Result<RollBuilder, DiceError> {
        let total = total.into();
        let count = count.into();
        self.keep_all(total, count, KeepMode::Lowest)
    }

    /// `withAdvantage()`.
    pub fn with_advantage(&self) -> Result<RollBuilder, DiceError> {
        if self.is_pooled() {
            return Err(DiceError::error("Cannot set advantage on a pooled roll."));
        }
        self.with_roll_type(RollType::Advantage)
    }

    /// `withDisadvantage()`.
    pub fn with_disadvantage(&self) -> Result<RollBuilder, DiceError> {
        if self.is_pooled() {
            return Err(DiceError::error(
                "Cannot set disadvantage on a pooled roll.",
            ));
        }
        self.with_roll_type(RollType::Disadvantage)
    }

    /// `withElvenAccuracy()`.
    pub fn with_elven_accuracy(&self) -> Result<RollBuilder, DiceError> {
        if self.is_dc() {
            return Err(DiceError::error(
                "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks).",
            ));
        }
        if self.is_pooled() {
            return Err(DiceError::error(
                "Cannot set elven accuracy on a pooled roll.",
            ));
        }
        self.with_roll_type(RollType::ElvenAccuracy)
    }

    /// Sets a roll type. On a roll with a natural d20 it applies to that d20 whatever the call
    /// order; otherwise it applies to the last group.
    fn with_roll_type(&self, roll_type: RollType) -> Result<RollBuilder, DiceError> {
        let mut configs = self.get_sub_roll_configs();
        let root = natural_roll_index(&configs);
        let idx = match root {
            Some(i) if configs[i].sides == 20.0 => i,
            _ => configs
                .len()
                .checked_sub(1)
                .ok_or_else(|| type_error_set("rollType"))?,
        };
        configs[idx].roll_type = roll_type;
        self.create(configs)
    }

    /// `add(roll)`: another roll's dice after this one's.
    pub fn add(&self, another: &RollBuilder) -> Result<RollBuilder, DiceError> {
        let added = self.add_base(another)?;
        match &self.kind {
            // `DCBuilder.add`: the new roll's configs under this save.
            RollKind::Dc { save } => Ok(Self::dc_over(&added, *save)),
            _ => Ok(added),
        }
    }

    /// `RollBuilder.add`, the base class's.
    fn add_base(&self, another: &RollBuilder) -> Result<RollBuilder, DiceError> {
        if self.is_transformed() || another.is_transformed() {
            return sum_rolls(&[self.clone(), another.clone()]);
        }
        if another.has_hidden_state() {
            return Err(DiceError::error(
                "Cannot add a roll with hidden state (like a pooled roll) to a standard roll. Try adding the standard roll to the pooled roll instead: pool.plus(roll).",
            ));
        }
        let mut configs = self.configs.clone();
        configs.extend(another.configs.iter().cloned());
        self.create(configs)
    }

    /// `withBonus(roll)`.
    pub fn with_bonus(&self, another: &RollBuilder) -> Result<RollBuilder, DiceError> {
        let mut configs = self.configs.clone();
        configs.extend(another.configs.iter().cloned());
        self.create(configs)
    }

    /// `addRoll(count)` (TS default 1).
    pub fn add_roll(&self, count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        let added = self.add_roll_base(count)?;
        match &self.kind {
            // `DCBuilder.addRoll`.
            RollKind::Dc { save } => Ok(Self::dc_over(&added, *save)),
            _ => Ok(added),
        }
    }

    /// `RollBuilder.addRoll`, the base class's.
    fn add_roll_base(&self, count: f64) -> Result<RollBuilder, DiceError> {
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for count"));
        }
        let mut configs = self.configs.clone();
        configs.push(Self::count_config(count));
        self.create(configs)
    }

    /// Multiplies every die group's count by `scale` (crit doubling); flats stay. `Err` is an
    /// `AmbiguousCritDoublingError` message for a group whose scaled meaning is ambiguous.
    pub fn scale_dice(&self, scale: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let scale = scale.into();
        match &self.kind {
            RollKind::Half { inner } => {
                let depth = nested_depth(&[inner])?;
                // Scale the dice, keep the same // 2 (half) transform applied on top.
                Ok(Self::wrap(
                    RollKind::Half {
                        inner: Box::new(inner.scale_dice(scale)?),
                    },
                    depth,
                ))
            }
            RollKind::Scale {
                inner,
                numerator,
                denominator,
                rounding,
            } => Self::new_scale(
                inner.scale_dice(scale)?,
                *numerator,
                *denominator,
                *rounding,
            ),
            RollKind::MaxOf {
                inner,
                count,
                dice_count,
                dice_sides,
            } => {
                let scale_int = validate_scale_int(scale)?;
                let scaled = inner.scale_dice(scale_int)?;
                let depth = nested_depth(&[&scaled])?;
                Ok(Self::wrap(
                    RollKind::MaxOf {
                        inner: Box::new(scaled),
                        count: *count,
                        dice_count: dice_count
                            .filter(|c| *c != 0.0 && !c.is_nan())
                            .map(|c| c * scale_int),
                        dice_sides: *dice_sides,
                    },
                    depth,
                ))
            }
            RollKind::RerollUpTo {
                inner,
                budget,
                rolls,
                rolled_once,
            } => {
                let scaled = inner.scale_dice(scale)?;
                let once = match rolled_once {
                    Some(o) => Some(Box::new(o.scale_dice(scale)?)),
                    None => None,
                };
                let depth = nested_depth(&[&scaled])?;
                Ok(Self::wrap(
                    RollKind::RerollUpTo {
                        inner: Box::new(scaled),
                        budget: *budget,
                        rolls: *rolls,
                        rolled_once: once,
                    },
                    depth,
                ))
            }
            RollKind::CompositeSum { parts } => {
                validate_scale_int(scale)?;
                let scaled = parts
                    .iter()
                    .map(|p| p.scale_dice(scale))
                    .collect::<Result<Vec<_>, _>>()?;
                Self::composite(scaled)
            }
            RollKind::MaxOfRolls { rolls } => {
                validate_scale_int(scale)?;
                let scaled = rolls
                    .iter()
                    .map(|r| r.scale_dice(scale))
                    .collect::<Result<Vec<_>, _>>()?;
                Self::max_of_rolls(scaled)
            }
            RollKind::Parsed { expression, .. } => {
                Self::parsed(&scale_parsed_dice(expression, validate_scale_int(scale)?)?)
            }
            RollKind::Pooled { source, .. } => {
                let scale_int = validate_scale_int(scale)?;
                let repooled = source.repool_scaled(scale_int)?;
                let configs = self.scale_dice_configs(scale_int)?;
                let configs = if configs.is_empty() {
                    vec![Self::count_config(0.0)]
                } else {
                    configs
                };
                Ok(Self::from_parts(
                    configs,
                    repooled.kind.clone(),
                    repooled.depth,
                ))
            }
            RollKind::Plain
            | RollKind::AlwaysHit { .. }
            | RollKind::AlwaysCrit { .. }
            | RollKind::Ac { .. }
            | RollKind::Dc { .. } => {
                let scale_int = validate_scale_int(scale)?;
                let configs = self.scale_dice_configs(scale_int)?;
                self.create(configs)
            }
        }
    }

    /// The configs of `RollBuilder.scaleDice` (the base class's): every die group's count times
    /// `scale_int`.
    fn scale_dice_configs(&self, scale_int: f64) -> Result<Vec<RollConfig>, DiceError> {
        let mut out = Vec::new();
        for config in self.get_sub_roll_configs() {
            if not_positive(config.sides) {
                out.push(config);
                continue;
            }
            if let Some(ambiguity) = ambiguous_scaling(&config, scale_int) {
                // An exploding die has no string form; the ambiguity, not the missing spelling,
                // is the error.
                let shown = match self.to_expression() {
                    Ok(e) => format!("\"{e}\""),
                    Err(_) => "this roll".to_string(),
                };
                return Err(DiceError::AmbiguousCritDoubling(format!(
                    "Cannot double the dice of {shown} on a crit: {ambiguity}. Give the crit explicitly: onCrit(...) on an attack, critDamage on a rider, or noCrit()."
                )));
            }
            out.push(RollConfig {
                count: config.count * scale_int,
                ..config
            });
        }
        Ok(out)
    }

    /// `doubleDice()`.
    pub fn double_dice(&self) -> Result<RollBuilder, DiceError> {
        self.scale_dice(2.0)
    }

    /// `alwaysHits()`: an always-hit check on this roll's dice.
    pub fn always_hits(&self) -> Result<RollBuilder, DiceError> {
        if let RollKind::Ac { attack, .. } = &self.kind {
            // `ACBuilder.alwaysHits()`.
            return Self::always_hit_from(
                &Self::with_configs(&self.get_resolved_configs()),
                Some(AttackConfig {
                    crit_threshold: attack.crit_threshold,
                    ac: None,
                    range: attack.range,
                    miss_reroll: None,
                }),
            );
        }
        Self::always_hit_from(self, None)
    }

    /// `alwaysCrits()`: an always-crit check on this roll's dice.
    pub fn always_crits(&self) -> Result<RollBuilder, DiceError> {
        if let RollKind::Ac { attack, .. } = &self.kind {
            // `ACBuilder.alwaysCrits()`.
            return Self::always_crit_from(
                &Self::with_configs(&self.get_resolved_configs()),
                Some(*attack),
                false,
            );
        }
        if let RollKind::AlwaysHit { attack } = &self.kind {
            // `AlwaysHitBuilder.alwaysCrits()`.
            return Self::always_crit_from(
                self,
                Some(AttackConfig {
                    crit_threshold: 20.0,
                    ac: None,
                    range: attack.range,
                    miss_reroll: None,
                }),
                true,
            );
        }
        Self::always_crit_from(self, None, false)
    }

    /// `new AlwaysHitBuilder(baseRoll, attackConfig?)`.
    fn always_hit_from(
        base: &RollBuilder,
        attack: Option<AttackConfig>,
    ) -> Result<RollBuilder, DiceError> {
        if base.has_hidden_state() {
            return Err(DiceError::error(
                "Cannot create AlwaysHitBuilder from a roll with hidden state.",
            ));
        }
        Ok(Self::from_parts(
            base.get_sub_roll_configs(),
            RollKind::AlwaysHit {
                attack: attack.unwrap_or_else(AttackConfig::default_check),
            },
            0,
        ))
    }

    /// `new AlwaysCritBuilder(baseRoll, attackConfig?, fromAlwaysHit)`.
    fn always_crit_from(
        base: &RollBuilder,
        attack: Option<AttackConfig>,
        from_always_hit: bool,
    ) -> Result<RollBuilder, DiceError> {
        if base.has_hidden_state() {
            return Err(DiceError::error(
                "Cannot create AlwaysCritBuilder from a roll with hidden state.",
            ));
        }
        Ok(Self::from_parts(
            base.get_sub_roll_configs(),
            RollKind::AlwaysCrit {
                attack: attack.unwrap_or_else(AttackConfig::default_check),
                from_always_hit: from_always_hit || base.is_always_hit(),
            },
            0,
        ))
    }

    /// `new AlwaysHitBuilder(baseRoll, attackConfig)`, for `ac.rs`/`attack.rs`.
    pub fn always_hit_with(
        base: &RollBuilder,
        attack: AttackConfig,
    ) -> Result<RollBuilder, DiceError> {
        Self::always_hit_from(base, Some(attack))
    }

    /// `new AlwaysCritBuilder(baseRoll, attackConfig, fromAlwaysHit)`, for `ac.rs`/`attack.rs`.
    pub fn always_crit_with(
        base: &RollBuilder,
        attack: AttackConfig,
        from_always_hit: bool,
    ) -> Result<RollBuilder, DiceError> {
        Self::always_crit_from(base, Some(attack), from_always_hit)
    }

    /// `onHit(...args)` of an always-hit or always-crit check with several arguments: the attack
    /// dealing `RollBuilder.fromArgs(...args)`. One argument: [`RollBuilder::on_hit`].
    pub fn on_hit_args(&self, args: &[Arg]) -> Result<AttackBuilder, DiceError> {
        let damage = Self::from_args(args)?;
        self.attack_dealing(damage)
    }

    /// `onHit(arg)`: the attack dealing `arg` - a roll (`d8().plus(4)?`), a flat number or a
    /// parsed expression (`"2d6 + 3"`). Same as `RollBuilder.fromArgs(arg)`.
    pub fn on_hit(&self, arg: impl Into<Arg>) -> Result<AttackBuilder, DiceError> {
        match arg.into() {
            Arg::Roll(damage) => self.attack_dealing(damage),
            other => self.on_hit_args(&[other]),
        }
    }

    fn attack_dealing(&self, damage: RollBuilder) -> Result<AttackBuilder, DiceError> {
        if !(self.is_always_hit() || self.is_always_crit() || self.is_ac()) {
            return Err(DiceError::error(
                "onHit() is only available on a check built with ac(), alwaysHits() or alwaysCrits()",
            ));
        }
        Ok(AttackBuilder::new(self.clone(), damage))
    }

    /// `critOn(critThreshold)` of an always-hit or always-crit check.
    pub fn crit_on(&self, crit_threshold: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let crit_threshold = crit_threshold.into();
        require_finite(crit_threshold, "critOn() threshold")?;
        match &self.kind {
            RollKind::Ac {
                attack,
                advantage_dice,
            } => Ok(self.ac_rebuilt(
                AttackConfig {
                    crit_threshold,
                    ..*attack
                },
                *advantage_dice,
            )),
            RollKind::AlwaysHit { attack } => Self::always_hit_from(
                self,
                Some(AttackConfig {
                    crit_threshold,
                    ac: None,
                    range: attack.range,
                    miss_reroll: None,
                }),
            ),
            RollKind::AlwaysCrit {
                attack,
                from_always_hit,
            } => Self::always_crit_from(
                self,
                Some(AttackConfig {
                    crit_threshold,
                    ..*attack
                }),
                *from_always_hit,
            ),
            _ => Err(DiceError::error(
                "critOn() is only available on an always-hit or always-crit check",
            )),
        }
    }

    /// `ranged()` of an always-hit or always-crit check: an attack from farther than 5 feet, for a
    /// turn's condition rules. A row fact; the PMF does not change.
    pub fn ranged(&self) -> Result<RollBuilder, DiceError> {
        self.with_range(AttackRange::Ranged)
    }

    /// `melee()` of an always-hit or always-crit check.
    pub fn melee(&self) -> Result<RollBuilder, DiceError> {
        self.with_range(AttackRange::Melee)
    }

    fn with_range(&self, range: AttackRange) -> Result<RollBuilder, DiceError> {
        match &self.kind {
            RollKind::Ac {
                attack,
                advantage_dice,
            } => Ok(self.ac_rebuilt(
                AttackConfig {
                    range: Some(range),
                    ..*attack
                },
                *advantage_dice,
            )),
            RollKind::AlwaysHit { attack } => Self::always_hit_from(
                self,
                Some(AttackConfig {
                    range: Some(range),
                    ..*attack
                }),
            ),
            RollKind::AlwaysCrit {
                attack,
                from_always_hit,
            } => Self::always_crit_from(
                self,
                Some(AttackConfig {
                    range: Some(range),
                    ..*attack
                }),
                *from_always_hit,
            ),
            _ => Err(DiceError::error(
                "ranged()/melee() is only available on an always-hit or always-crit check",
            )),
        }
    }

    /// Fixes this roll's type for a turn: no grant or condition changes it
    /// (`d20.plus(8).withAdvantage().pinned().ac(16)`). A row fact on the natural roll. `Err` on a
    /// roll with no natural roll to pin.
    pub fn pinned(&self) -> Result<RollBuilder, DiceError> {
        let configs = self.pinned_configs()?;
        match &self.kind {
            RollKind::Ac {
                attack,
                advantage_dice,
            } => Ok(Self::from_parts(
                configs,
                RollKind::Ac {
                    attack: *attack,
                    advantage_dice: *advantage_dice,
                },
                0,
            )),
            RollKind::Dc { save } => Ok(Self::from_parts(configs, RollKind::Dc { save: *save }, 0)),
            RollKind::AlwaysHit { attack } => {
                Self::always_hit_from(&Self::with_configs(&configs), Some(*attack))
            }
            RollKind::AlwaysCrit {
                attack,
                from_always_hit,
            } => Self::always_crit_from(
                &Self::with_configs(&configs),
                Some(*attack),
                *from_always_hit,
            ),
            _ => self.create(configs),
        }
    }

    /// This roll's configs with the natural roll marked `pinned`: the base of [`RollBuilder::pinned`]
    /// for every check builder.
    pub fn pinned_configs(&self) -> Result<Vec<RollConfig>, DiceError> {
        let mut configs = self.get_sub_roll_configs();
        let Some(idx) = natural_roll_index(&configs) else {
            return Err(DiceError::error(
                "pinned() needs a die to pin: this roll has no natural roll (a rolled, added die).",
            ));
        };
        configs[idx].pinned = true;
        Ok(configs)
    }

    /// `copy()`.
    pub fn copy(&self) -> Result<RollBuilder, DiceError> {
        match &self.kind {
            RollKind::Half { inner } => {
                let depth = nested_depth(&[inner])?;
                Ok(Self::wrap(
                    RollKind::Half {
                        inner: Box::new(inner.copy()?),
                    },
                    depth,
                ))
            }
            RollKind::Scale {
                inner,
                numerator,
                denominator,
                rounding,
            } => Self::new_scale(inner.copy()?, *numerator, *denominator, *rounding),
            RollKind::MaxOf { inner, count, .. } => {
                let copied = inner.copy()?;
                let depth = nested_depth(&[&copied])?;
                Ok(Self::wrap(
                    RollKind::MaxOf {
                        inner: Box::new(copied),
                        count: *count,
                        dice_count: None,
                        dice_sides: None,
                    },
                    depth,
                ))
            }
            RollKind::RerollUpTo {
                inner,
                budget,
                rolls,
                rolled_once,
            } => {
                let copied = inner.copy()?;
                let once = match rolled_once {
                    Some(o) => Some(Box::new(o.copy()?)),
                    None => None,
                };
                let depth = nested_depth(&[&copied])?;
                Ok(Self::wrap(
                    RollKind::RerollUpTo {
                        inner: Box::new(copied),
                        budget: *budget,
                        rolls: *rolls,
                        rolled_once: once,
                    },
                    depth,
                ))
            }
            RollKind::CompositeSum { parts } => Self::composite(
                parts
                    .iter()
                    .map(RollBuilder::copy)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            RollKind::MaxOfRolls { rolls } => Self::max_of_rolls(
                rolls
                    .iter()
                    .map(RollBuilder::copy)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            RollKind::Parsed { expression, .. } => Self::parsed(expression),
            RollKind::AlwaysHit { attack } => Self::always_hit_from(
                &Self::with_configs(&self.get_sub_roll_configs()),
                Some(AttackConfig {
                    crit_threshold: attack.crit_threshold,
                    ac: None,
                    range: attack.range,
                    miss_reroll: None,
                }),
            ),
            RollKind::AlwaysCrit {
                attack,
                from_always_hit,
            } => Self::always_crit_from(
                &Self::with_configs(&self.get_sub_roll_configs()),
                Some(*attack),
                *from_always_hit,
            ),
            RollKind::Ac { .. } => self.copy_with_ac(None),
            RollKind::Plain | RollKind::Pooled { .. } | RollKind::Dc { .. } => {
                self.create(self.get_sub_roll_configs())
            }
        }
    }

    // ---- transforms ----

    fn wrap(kind: RollKind, depth: usize) -> RollBuilder {
        // `super(0)`: the transformed roll's own dummy config.
        Self::from_parts(vec![Self::count_config(0.0)], kind, depth)
    }

    fn new_scale(
        inner: RollBuilder,
        numerator: f64,
        denominator: f64,
        rounding: Rounding,
    ) -> Result<RollBuilder, DiceError> {
        require_finite(numerator, "scaleResult() numerator")?;
        require_finite(denominator, "scaleResult() denominator")?;
        if denominator == 0.0 {
            return Err(DiceError::error("scaleResult() denominator must not be 0"));
        }
        let depth = nested_depth(&[&inner])?;
        Ok(Self::wrap(
            RollKind::Scale {
                inner: Box::new(inner),
                numerator,
                denominator,
                rounding,
            },
            depth,
        ))
    }

    fn composite(parts: Vec<RollBuilder>) -> Result<RollBuilder, DiceError> {
        let refs: Vec<&RollBuilder> = parts.iter().collect();
        let depth = nested_depth(&refs)?;
        Ok(Self::wrap(RollKind::CompositeSum { parts }, depth))
    }

    fn max_of_rolls(rolls: Vec<RollBuilder>) -> Result<RollBuilder, DiceError> {
        let refs: Vec<&RollBuilder> = rolls.iter().collect();
        let depth = nested_depth(&refs)?;
        Ok(Self::wrap(RollKind::MaxOfRolls { rolls }, depth))
    }

    /// `half()`: floor of this roll halved.
    pub fn half(&self) -> Result<RollBuilder, DiceError> {
        let depth = nested_depth(&[self])?;
        Ok(Self::wrap(
            RollKind::Half {
                inner: Box::new(self.clone()),
            },
            depth,
        ))
    }

    /// `scaleResult(numerator, denominator = 1, rounding = "floor")`: scale this roll's result by
    /// `numerator / denominator`, rounding each outcome.
    pub fn scale_result(
        &self,
        numerator: f64,
        denominator: f64,
        rounding: Rounding,
    ) -> Result<RollBuilder, DiceError> {
        Self::new_scale(self.clone(), numerator, denominator, rounding)
    }

    /// `maxOf(count)`: the highest of `count` independent rolls of this whole roll.
    pub fn max_of(&self, count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for maxOf count"));
        }
        require_finite(count, "maxOf() count")?;
        let depth = nested_depth(&[self])?;
        Ok(Self::wrap(
            RollKind::MaxOf {
                inner: Box::new(self.clone()),
                count,
                dice_count: None,
                dice_sides: None,
            },
            depth,
        ))
    }

    /// `maxOf(other)`: the higher of this roll and `other`.
    pub fn max_of_roll(&self, other: &RollBuilder) -> Result<RollBuilder, DiceError> {
        Self::max_of_rolls(vec![self.clone(), other.clone()])
    }

    /// `rerollUpTo(budget, options)`: once every die is seen, reroll up to `budget` of them and keep
    /// each new roll (Empowered Spell, Piercer). See the TS docs for the policy.
    pub fn reroll_up_to(
        &self,
        budget: f64,
        options: Option<&RollRerollUpToOptions>,
    ) -> Result<RollBuilder, DiceError> {
        let args = reroll_up_to_arguments(budget, options.and_then(|o| o.rolls), "rerollUpTo()")?;
        if self.is_reroll_up_to() {
            return Err(DiceError::error(
                "Cannot rerollUpTo() a roll that already has a rerollUpTo() pool: one reroll budget per pool. Set the budget once, on the dice, or use { rolls } for a best of several rolls.",
            ));
        }
        if self.is_transformed() || self.has_hidden_state() {
            return Err(DiceError::error(
                "Cannot rerollUpTo() a half, scaled, max-of, pooled, parsed or summed roll: it has no plain dice to reroll. Call rerollUpTo() on the dice, before half(), scaleResult(), maxOf(), keepHighestAll() or sumRolls().",
            ));
        }
        let pool = Self::with_configs(&self.get_sub_roll_configs());
        rerollable_pool(&pool.to_ast()?)?;
        let make =
            |pool: RollBuilder, once: Option<RollBuilder>| -> Result<RollBuilder, DiceError> {
                let depth = nested_depth(&[&pool])?;
                Ok(Self::wrap(
                    RollKind::RerollUpTo {
                        inner: Box::new(pool),
                        budget: args.budget,
                        rolls: args.rolls,
                        rolled_once: once.map(Box::new),
                    },
                    depth,
                ))
            };
        let Some(once) = options.and_then(|o| o.rolled_once.as_ref()) else {
            return make(pool, None);
        };
        if once.is_transformed() || once.has_hidden_state() {
            return Err(DiceError::error(
                "rerollUpTo(): rolledOnce must be plain dice, not a half, scaled, max-of, pooled, parsed, summed or rerollUpTo() roll.",
            ));
        }
        let once_pool = Self::with_configs(&once.get_sub_roll_configs());
        rerollable_pool(&once_pool.to_ast()?)?;
        make(pool, Some(once_pool))
    }

    /// `PooledRollBuilder.times(count)`: this pooled roll repeated `count` times as a new pool.
    pub fn times(&self, count: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let count = count.into();
        if !self.is_pooled() {
            return Err(DiceError::error(
                "times() is only available on a pooled roll (keepHighestAll(), keepLowestAll() or times())",
            ));
        }
        if count.is_nan() {
            return Err(DiceError::error("Invalid NaN value for times"));
        }
        if count.floor() != count {
            return Err(DiceError::error("times() requires an integer"));
        }
        if count < 0.0 {
            return Err(DiceError::error("times() requires a non-negative integer"));
        }
        // Wraps the current state (base + modifiers) into a new pool repeated N times.
        let sum_node = SumNode {
            count,
            child: Box::new(self.to_ast()?),
            explode_pool_budget: None,
        };
        let depth = nested_depth(&[self])?;
        Ok(Self::from_parts(
            vec![Self::count_config(0.0)],
            RollKind::Pooled {
                base_ast: ExpressionNode::Sum(sum_node),
                source: PoolSource::Times {
                    source: Box::new(self.clone()),
                    count,
                },
            },
            depth,
        ))
    }

    /// `ParsedRollBuilder.canDoubleDice()`: whether this is a damage expression whose dice a crit
    /// doubles. `Err` for anything but a parsed roll.
    pub fn can_double_dice(&self) -> Result<bool, DiceError> {
        let RollKind::Parsed { expression, .. } = &self.kind else {
            return Err(DiceError::error(
                "canDoubleDice() is only available on a parsed roll",
            ));
        };
        match scale_parsed_dice(expression, 2.0) {
            Ok(_) => Ok(true),
            Err(DiceError::AmbiguousCritDoubling(_)) => Ok(true),
            Err(DiceError::UndoubleableExpression(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    // ---- output ----

    /// `toExpression()`.
    pub fn to_expression(&self) -> Result<String, DiceError> {
        match &self.kind {
            RollKind::Plain => self.plain_expression(),
            RollKind::AlwaysHit { .. } | RollKind::AlwaysCrit { .. } => {
                match root_die_expression(self)? {
                    Some(e) => Ok(e),
                    None => self.plain_expression(),
                }
            }
            RollKind::Ac { .. } => self.ac_expression(),
            RollKind::Dc { .. } => self.dc_expression(),
            RollKind::Parsed { expression, .. } => Ok(expression.clone()),
            RollKind::Half { inner } => Ok(format!("({}) // 2", inner.to_expression()?)),
            RollKind::Scale {
                inner,
                numerator,
                denominator,
                rounding,
            } => print_scale(&inner.to_expression()?, *numerator, *denominator, *rounding),
            RollKind::MaxOf { inner, count, .. } => {
                let count = super::num::js_max(1.0, count.floor());
                let inner = inner.to_expression()?;
                Ok(if count == 1.0 {
                    inner
                } else {
                    format!("{}kh1({inner})", num_to_string(count))
                })
            }
            RollKind::RerollUpTo { .. } => print_node(&self.to_ast()?, PrintOptions::default()),
            RollKind::Pooled { base_ast, source } => {
                let base = ExpressionTerm {
                    text: source.expression()?,
                    sign: Sign::Plus,
                    range: Some(node_range(base_ast)?),
                };
                let mut terms = vec![base];
                terms.extend(config_terms(&self.configs, self.root_die_index())?);
                Ok(join_terms(&terms))
            }
            RollKind::CompositeSum { parts } => {
                let mut terms = Vec::with_capacity(parts.len());
                for part in parts {
                    // A parsed part has no AST: its range is unknown, so the next part always
                    // adds (`~+`).
                    let range = part.to_ast().and_then(|a| node_range(&a)).ok();
                    terms.push(ExpressionTerm {
                        text: part.to_expression()?,
                        sign: Sign::Plus,
                        range,
                    });
                }
                Ok(join_terms(&terms))
            }
            RollKind::MaxOfRolls { rolls } => {
                let mut texts = Vec::with_capacity(rolls.len());
                for r in rolls {
                    texts.push(format!("({})", r.to_expression()?));
                }
                Ok(texts.join(" > "))
            }
        }
    }

    fn plain_expression(&self) -> Result<String, DiceError> {
        Ok(join_terms(&config_terms(
            &self.configs,
            self.root_die_index(),
        )?))
    }

    /// `toAST()`: the expression tree of this roll.
    pub fn to_ast(&self) -> Result<ExpressionNode, DiceError> {
        match &self.kind {
            RollKind::Parsed { .. } => Err(DiceError::error(
                "ParsedRollBuilder does not support AST conversion. Use the builder API instead.",
            )),
            RollKind::Half { inner } => Ok(ExpressionNode::Half(HalfNode {
                child: Box::new(inner.to_ast()?),
            })),
            RollKind::Scale {
                inner,
                numerator,
                denominator,
                rounding,
            } => Ok(ExpressionNode::Scale(ScaleNode {
                numerator: *numerator,
                denominator: *denominator,
                rounding: *rounding,
                child: Box::new(inner.to_ast()?),
            })),
            RollKind::MaxOf { inner, count, .. } => Ok(ExpressionNode::MaxOf(MaxOfNode {
                count: *count,
                child: Box::new(inner.to_ast()?),
            })),
            RollKind::RerollUpTo {
                inner,
                budget,
                rolls,
                rolled_once,
            } => Ok(ExpressionNode::RerollUpTo(RerollUpToNode {
                budget: *budget,
                rolls: *rolls,
                child: Box::new(inner.to_ast()?),
                rolled_once: match rolled_once {
                    Some(o) => Some(Box::new(o.to_ast()?)),
                    None => None,
                },
            })),
            RollKind::CompositeSum { parts } => {
                let mut children = Vec::with_capacity(parts.len());
                for p in parts {
                    children.push(AddChild {
                        node: p.to_ast()?,
                        sign: Sign::Plus,
                    });
                }
                Ok(ExpressionNode::Add(AddNode { children }))
            }
            RollKind::MaxOfRolls { rolls } => {
                let mut children = Vec::with_capacity(rolls.len());
                for r in rolls {
                    children.push(r.to_ast()?);
                }
                Ok(ExpressionNode::Max(MaxNode { children }))
            }
            RollKind::Pooled { base_ast, .. } => {
                let configs_ast = self.configs_ast()?;
                // Check if configsAST is effectively zero/empty.
                let is_zero = matches!(&configs_ast, ExpressionNode::Constant(c) if c.value == 0.0);
                if is_zero {
                    return Ok(base_ast.clone());
                }
                Ok(ExpressionNode::Add(AddNode {
                    children: vec![
                        AddChild {
                            node: base_ast.clone(),
                            sign: Sign::Plus,
                        },
                        AddChild {
                            node: configs_ast,
                            sign: Sign::Plus,
                        },
                    ],
                }))
            }
            RollKind::Plain
            | RollKind::AlwaysHit { .. }
            | RollKind::AlwaysCrit { .. }
            | RollKind::Ac { .. }
            | RollKind::Dc { .. } => self.configs_ast(),
        }
    }

    /// `RollBuilder.toAST()` (the base class's): the configs' tree, or the constant 0.
    fn configs_ast(&self) -> Result<ExpressionNode, DiceError> {
        let configs = self.get_sub_roll_configs();
        Ok(ast_from_roll_configs(&configs)?
            .unwrap_or(ExpressionNode::Constant(ConstantNode { value: 0.0 })))
    }

    /// `toPMF(eps = 0)`.
    pub fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        self.to_pmf_shared(eps).map(|p| (*p).clone())
    }

    /// [`RollBuilder::to_pmf`] through the caches TS has: `rollPMFCache` (plain rolls, key
    /// `{cacheKey}*e{eps}`), `dcPMFCache` (DC checks) and `builderPMFCache` (everything resolved
    /// from the AST). Returns the cached `Arc`.
    pub fn to_pmf_shared(&self, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        match &self.kind {
            RollKind::AlwaysHit { .. } | RollKind::AlwaysCrit { .. } => {
                resolve_root_d20(self).map(Arc::new)
            }
            RollKind::Ac { .. } => self.ac_to_pmf(eps).map(Arc::new),
            RollKind::Dc { .. } => {
                let key = self
                    .cache_key()
                    .map(|k| format!("{k}*e{}", num_to_string(eps)));
                DC_CACHE.get_or_compute(key.as_deref(), || self.dc_to_pmf(eps))
            }
            // The PMF is pre-computed at construction with eps=0; epsilon is not re-applied here.
            // `ParsedRollBuilder.cachedPMF` is `parse(expression)`: the shared parse-cache entry.
            RollKind::Parsed { pmf, expression } => Ok(crate::parser::parse_shared(
                expression, 0.0,
            )
            .unwrap_or_else(|_| Arc::clone(pmf))),
            RollKind::Plain => {
                let key = self
                    .cache_key()
                    .map(|k| format!("{k}*e{}", num_to_string(eps)));
                ROLL_CACHE
                    .get_or_compute_arc(key.as_deref(), || pmf_from_roll_builder_shared(self, eps))
            }
            _ => pmf_from_roll_builder_shared(self, eps),
        }
    }

    /// `pmf`: `toPMF()` with eps 0.
    pub fn pmf(&self) -> Result<Pmf, DiceError> {
        self.to_pmf(0.0)
    }

    /// `toQuery(eps = 0)`.
    pub fn to_query(&self) -> Result<DiceQuery, DiceError> {
        self.to_query_with(EPS)
    }

    /// [`Self::to_query`] pruning probabilities below `eps`.
    pub fn to_query_with(&self, eps: f64) -> Result<DiceQuery, DiceError> {
        Ok(DiceQuery::of(vec![self.to_pmf(eps)?]))
    }

    /// `sample(rng)`: one roll of this builder's AST: the total and every physical die.
    pub fn sample(&self, rng: &mut dyn Rng) -> Result<RollSample, DiceError> {
        if let RollKind::Parsed { pmf, .. } = &self.kind {
            // A parsed string has no AST, so its draw is a PMF draw with no dice structure.
            return Ok(RollSample {
                total: sample_pmf(pmf, rng).total,
                dice: Vec::new(),
            });
        }
        sample_node(&self.to_ast()?, rng)
    }

    /// `sampleCheck(rng)` of an always-hit or always-crit check: one draw of the natural roll and the
    /// bonus dice.
    pub fn sample_check(&self, rng: &mut dyn Rng) -> Result<CheckDice, DiceError> {
        sample_check_dice(self, rng)
    }
}

impl CheckDiceSource for RollBuilder {
    fn get_root_die_config(&self) -> Option<RollConfig> {
        RollBuilder::get_root_die_config(self)
    }
    fn get_bonus_dice_configs(&self) -> Vec<RollConfig> {
        RollBuilder::get_bonus_dice_configs(self)
    }
    fn modifier(&self) -> f64 {
        RollBuilder::modifier(self)
    }
}

/// `sumRolls`: combine several rolls into one additive payload whose PMF is their convolution and
/// whose expression is their sum. Unlike merging plain dice, this preserves parts that carry a
/// transform. Empty parts collapse to `0`; a single part is returned unwrapped; nested sums are
/// flattened.
pub fn sum_rolls(parts: &[RollBuilder]) -> Result<RollBuilder, DiceError> {
    let mut meaningful: Vec<RollBuilder> = Vec::new();
    for p in parts {
        match &p.kind {
            RollKind::CompositeSum { parts: inner } => meaningful.extend(inner.iter().cloned()),
            _ => meaningful.push(p.clone()),
        }
    }
    match meaningful.len() {
        0 => Ok(RollBuilder::zero()),
        1 => Ok(meaningful.remove(0)),
        _ => RollBuilder::composite(meaningful),
    }
}

impl From<RollBuilderData> for RollBuilder {
    fn from(data: RollBuilderData) -> Self {
        RollBuilder(Arc::new(data))
    }
}

impl std::ops::Deref for RollBuilder {
    type Target = RollBuilderData;
    fn deref(&self) -> &RollBuilderData {
        &self.0
    }
}

/// Copy-on-write: mutation clones the data only while it is shared.
impl std::ops::DerefMut for RollBuilder {
    fn deref_mut(&mut self) -> &mut RollBuilderData {
        let data = Arc::make_mut(&mut self.0);
        data.key.reset();
        data
    }
}

#[cfg(test)]
mod key_memo_tests {
    use super::*;

    #[test]
    fn mutated_builder_never_keeps_a_stale_key() {
        let mut b = RollBuilder::new(1.0).unwrap().d6().unwrap();
        let before = b.cache_key();
        assert_eq!(b.cache_key(), before);
        let shared = b.clone();
        b.configs[0].modifier = 3.0;
        assert_ne!(b.cache_key(), before);
        assert_eq!(shared.cache_key(), before);
        let again = b.cache_key();
        b.configs[0].modifier = 4.0;
        assert_ne!(b.cache_key(), again);
    }
}
