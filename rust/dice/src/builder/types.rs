//! Port of `src/builder/types.ts`.
//!
//! `RollFactory` (a TS call-signature type) is the free functions of [`super::factory`].
//! `RollConfig`, `KeepSpec` and `KeepMode` live here; `nodes.rs` and `roll_cache_key.rs` re-export
//! them.

use super::roll::RollBuilder;
use crate::Pmf;
use crate::error::DiceError;
use indexmap::IndexMap;

pub use crate::common::RollType;

/// `KeepMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeepMode {
    Highest,
    Lowest,
}

impl KeepMode {
    /// The TS string, `"highest"` or `"lowest"`.
    pub fn as_str(self) -> &'static str {
        match self {
            KeepMode::Highest => "highest",
            KeepMode::Lowest => "lowest",
        }
    }
}

/// `RollConfig.keep`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeepSpec {
    pub total: f64,
    pub count: f64,
    pub mode: KeepMode,
}

/// `RollConfig`: the intermediate representation that is converted into an AST as needed.
#[derive(Clone, Debug, PartialEq)]
pub struct RollConfig {
    pub count: f64,
    pub sides: f64,
    pub modifier: f64,
    /// Reroll threshold k (k >= 0): one-pass, reroll-once, must-keep on faces {1..k}.
    pub reroll: f64,
    pub explode: f64,
    /// Pool-wide exploding-dice budget; mutually exclusive with `explode`.
    pub explode_pool_budget: f64,
    pub minimum: f64,
    pub best_of: f64,
    pub keep: Option<KeepSpec>,
    pub roll_type: RollType,
    /// `true` if this negative count should be treated as subtraction.
    pub is_subtraction: Option<bool>,
    /// Set only on a check's natural roll by `pinned()`; absent (never `false`) otherwise.
    pub pinned: bool,
}

/// `Partial<RollConfig>`: the fields `RollBuilder.fromConfig` lays over `defaultConfig`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RollConfigPatch {
    pub count: Option<f64>,
    pub sides: Option<f64>,
    pub modifier: Option<f64>,
    pub reroll: Option<f64>,
    pub explode: Option<f64>,
    pub explode_pool_budget: Option<f64>,
    pub minimum: Option<f64>,
    pub best_of: Option<f64>,
    pub keep: Option<KeepSpec>,
    pub roll_type: Option<RollType>,
    pub is_subtraction: Option<bool>,
    pub pinned: bool,
}

/// `Resolution`. `weights` is `{ [key: string]: number }`, in insertion order.
#[derive(Clone, Debug)]
pub struct Resolution {
    pub pmf: Pmf,
    pub check: Pmf,
    pub weights: IndexMap<String, f64>,
}

/// `AttackResolution.weights`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AttackWeights {
    pub hit: f64,
    pub crit: f64,
    pub miss: f64,
}

/// `AttackResolution` (`Resolution & { ... }`, with the narrower `weights`).
#[derive(Clone, Debug)]
pub struct AttackResolution {
    pub pmf: Pmf,
    pub check: Pmf,
    pub hit: Pmf,
    pub crit: Pmf,
    pub miss: Pmf,
    /// Base payload only, before `plusSeparateDamage` channels are convolved in.
    pub hit_base: Pmf,
    pub crit_base: Pmf,
    /// The convolved `plusSeparateDamage` channels only: `Pmf::delta(0)` when there are none.
    pub hit_separate: Pmf,
    pub crit_separate: Pmf,
    pub weights: AttackWeights,
}

/// `AttackRange`: melee or ranged, for a turn's condition rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackRange {
    Melee,
    Ranged,
}

impl AttackRange {
    /// The TS string, `"melee"` or `"ranged"`.
    pub fn as_str(self) -> &'static str {
        match self {
            AttackRange::Melee => "melee",
            AttackRange::Ranged => "ranged",
        }
    }
}

/// `Ability`: a save's ability, always the full name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ability {
    Strength,
    Dexterity,
    Constitution,
    Intelligence,
    Wisdom,
    Charisma,
}

impl Ability {
    /// The full name, as `ability()` stores it.
    pub fn as_str(self) -> &'static str {
        match self {
            Ability::Strength => "strength",
            Ability::Dexterity => "dexterity",
            Ability::Constitution => "constitution",
            Ability::Intelligence => "intelligence",
            Ability::Wisdom => "wisdom",
            Ability::Charisma => "charisma",
        }
    }

    /// `AbilityName` (a full name or its three-letter form) to the full ability.
    pub fn parse(name: &str) -> Option<Ability> {
        match name {
            "strength" | "str" => Some(Ability::Strength),
            "dexterity" | "dex" => Some(Ability::Dexterity),
            "constitution" | "con" => Some(Ability::Constitution),
            "intelligence" | "int" => Some(Ability::Intelligence),
            "wisdom" | "wis" => Some(Ability::Wisdom),
            "charisma" | "cha" => Some(Ability::Charisma),
            _ => None,
        }
    }
}

/// `MissRerollMode`: how a missed attack roll is rolled again. `Reroll`: the kept d20 is replaced
/// by one new d20 (Heroic Inspiration). `AddD20`: one more d20 is rolled and the best of every d20
/// rolled is kept (2014 Lucky).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissRerollMode {
    Reroll,
    AddD20,
}

impl MissRerollMode {
    /// The TS string, `"reroll"` or `"add-d20"`.
    pub fn as_str(self) -> &'static str {
        match self {
            MissRerollMode::Reroll => "reroll",
            MissRerollMode::AddD20 => "add-d20",
        }
    }
}

/// `Check.advantageDice`: `2 | 3`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvantageDice {
    Two,
    Three,
}

/// `Check`.
#[derive(Clone, Debug)]
pub struct Check {
    pub roll: RollBuilder,
    pub ac: f64,
    pub crit_threshold: f64,
    pub roll_type: RollType,
    pub advantage_dice: AdvantageDice,
    pub crit_on_hit: bool,
    pub miss_reroll: Option<MissRerollMode>,
}

/// `SaveResolution.weights`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SaveWeights {
    pub success: f64,
    pub fail: f64,
}

/// `SaveResolution` (`Resolution & { ... }`, with the narrower `weights`).
#[derive(Clone, Debug)]
pub struct SaveResolution {
    pub pmf: Pmf,
    pub check: Pmf,
    pub save_fail: Pmf,
    pub save_success: Pmf,
    pub weights: SaveWeights,
}

/// `CheckBuilder`. `eps` is `resolve(eps?)`'s optional argument.
pub trait CheckBuilder {
    fn resolve(&self, eps: Option<f64>) -> Result<Resolution, DiceError>;
    fn to_expression(&self) -> Result<String, DiceError>;
    fn pmf(&self) -> Result<Pmf, DiceError>;
    fn mean(&self) -> Result<f64, DiceError>;
}
