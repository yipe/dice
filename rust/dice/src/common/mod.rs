//! Port of `src/common/`: the types shared across modules (`types.ts`, here), `rng.ts` ([`Rng`]),
//! and the modules [`bounce`], [`lru_cache`] and [`types`] (its constants and helpers).

use crate::error::DiceError;

pub mod bounce;
pub mod lru_cache;
pub mod types;

pub use lru_cache::{get_caching_enabled, set_caching_enabled};
pub use types::{OutcomeType, crit_probability, sort_outcomes};

/// `RollType` in `src/common/types.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollType {
    Flat,
    Advantage,
    Disadvantage,
    ElvenAccuracy,
}

impl RollType {
    /// The TS string: `"flat"`, `"advantage"`, `"disadvantage"`, `"elven accuracy"`.
    pub fn as_str(self) -> &'static str {
        match self {
            RollType::Flat => "flat",
            RollType::Advantage => "advantage",
            RollType::Disadvantage => "disadvantage",
            RollType::ElvenAccuracy => "elven accuracy",
        }
    }

    /// Inverse of [`RollType::as_str`].
    pub fn parse(s: &str) -> Option<RollType> {
        match s {
            "flat" => Some(RollType::Flat),
            "advantage" => Some(RollType::Advantage),
            "disadvantage" => Some(RollType::Disadvantage),
            "elven accuracy" => Some(RollType::ElvenAccuracy),
            _ => None,
        }
    }
}

/// `CritConfig` in `src/common/types.ts`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CritConfig {
    pub crit_threshold: f64,
}

/// `Rng` in `src/common/rng.ts`: the randomness a sampler draws from.
pub trait Rng {
    /// Uniform on `1..=sides`.
    fn die(&mut self, sides: f64) -> f64;
    /// True with probability `p`.
    fn chance(&mut self, p: f64) -> bool;
}

/// `MISS_NONE_OUTCOME` in `src/common/types.ts`.
pub const MISS_NONE_OUTCOME: &str = "missNone";

/// `DiceMatchInfo` in `src/common/types.ts`: exact P(match | this branch's own final damage value =
/// d) for a resolved hit/crit branch, keyed by the damage values the branch's PMF uses.
#[derive(Clone, Debug, PartialEq)]
pub struct DiceMatchInfo {
    pub match_probability_by_damage: indexmap::IndexMap<crate::Damage, f64>,
}

/// `HasDiceMatchInfo` in `src/common/types.ts`: a `dice-match`-eligible damage source (an
/// `AttackBuilder`) exposes the per-branch match-probability breakdown. A `None` branch means no
/// descriptor is available.
pub trait HasDiceMatchInfo {
    /// `diceMatchInfo(eps?)`: `(hit, crit)`.
    fn dice_match_info(
        &self,
        eps: f64,
    ) -> Result<(Option<DiceMatchInfo>, Option<DiceMatchInfo>), DiceError>;
    /// `diceMatchRefusals()`: why a branch has no descriptor; `None` for a branch that has one.
    fn dice_match_refusals(&self) -> Result<(Option<String>, Option<String>), DiceError>;
}
