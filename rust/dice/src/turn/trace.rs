//! Port of `src/turn/trace.ts`.

/// Bumped whenever the sampler's draw order changes.
pub const SAMPLER_VERSION: f64 = 1.0;

/// TS `DieRole`. `Reroll`: the die that replaced a rerolled one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DieRole {
    Attack,
    Save,
    Damage,
    Rider,
    Reroll,
}

/// TS `DieRoll.by`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DieBy {
    You,
    Enemy,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DieRoll {
    pub sides: f64,
    pub face: f64,
    pub role: DieRole,
    pub by: DieBy,
    pub source: String,
    pub kept: bool,
}

/// TS `OutcomeResult` (`"save-fail"` = `SaveFail`, ...).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeResult {
    Hit,
    Crit,
    Miss,
    SaveFail,
    SavePass,
    Fired,
    Skipped,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub source: String,
    pub result: OutcomeResult,
    pub damage: f64,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Wave {
    pub dice: Vec<DieRoll>,
    pub outcomes: Vec<Outcome>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Trace {
    pub total: f64,
    pub sampler_version: f64,
    pub waves: Vec<Wave>,
}
