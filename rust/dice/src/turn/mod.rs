//! Port of `src/turn/`.

pub mod batch;

#[cfg(test)]
pub mod compat;
pub mod context;
pub mod effects;
#[path = "turn.rs"]
pub mod engine;
pub mod plan;
pub mod readers;
pub mod sample;
pub mod state;
pub mod trace;
pub mod types;

#[cfg(test)]
mod tests;

pub use engine::{
    AttackMarginal, ConditionAttempt, Effect, EffectPart, LiveOdds, MAX_ATTACK_COUNT, MAX_BOUNCE,
    Marginal, RiderMarginal, SourceOdds, StepStats, Turn, bounce, turn,
};
