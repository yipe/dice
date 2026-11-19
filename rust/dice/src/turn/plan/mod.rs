//! Port of `src/turn/plan.ts`: the resolved, validated plan of a turn (`buildPlan`) and the pure
//! helpers the walk reads it with.
//!
//! # Layout
//! - `mod.rs` (here): the public plan types ([`TurnPlan`], [`Step`], [`Draw`], ...) and the pure
//!   functions on them ([`released`], [`grant_applies`], [`fire_mode`], [`gate_open`], ...).
//! - `source.rs`: plan.ts 815-1390, how a source becomes a PMF and slices ([`declared_attacks`],
//!   [`slice_source`], ...).
//! - `resolve.rs`: `buildPlan` 1399-2490: riders lowered and placed, attacks, ids, validation, `of`
//!   resolution, dependency order, substitutes. Output [`resolve::Resolved`].
//! - `layout.rs`: `buildPlan` 2492-3182: groups, fire slots, the step sequence, flags, group slots,
//!   grant applications. Output [`layout::Layout`].
//! - `fold.rs`: `buildPlan` 3184-3955 (+ `saveRowDraws`, `withFolded`): the per-hit fold and every
//!   draw a step can make. Output [`fold::Folds`].
//! - `steps.rs`: `buildPlan` 3957-4700: the steps and the [`TurnPlan`].
//!
//! # Shape (see also ADR-017)
//! - TS `-1` sentinels are `Option` where the value is a fire slot, group slot or step index in the
//!   public plan; internal bookkeeping keeps `isize` where TS does arithmetic on the sentinel.
//! - A PMF held by a plan is an `Arc<Pmf>`: TS shares PMF objects by reference and compares draws'
//!   riders by identity (`mergeDraws`), which `Arc::ptr_eq` reproduces.
//! - Lazy tables of the TS (`Step.variants` blocks, `Step.contextPmfs`, built when a walk first
//!   reaches them) are [`Lazy`] cells shared by the step and the closures that fill them. A build
//!   that fails in a block built during the walk is the `Err` of [`Step::select`] (TS: it throws
//!   inside the walk).
//! - `ParsedRollBuilder`, `withCheck`-only sources and the TS runtime shape checks a typed spec
//!   cannot violate (a non-string id, an unknown `on`, ...) have no Rust counterpart; the checks
//!   that a value is in range (chance, happens, max, d20Penalty, ...) are kept.
//! - A lone-string `of` is a list of one (`types.rs`): the TS paths that test `Array.isArray(of)`
//!   (partners, an empty `of: []`) see a list here for it too.

pub mod fold;
#[cfg(test)]
mod golden;
pub mod layout;
pub mod resolve;
pub mod source;
pub mod steps;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_conditions;
#[cfg(test)]
mod tests_riders;
#[cfg(test)]
mod tests_validation;

use super::context::RowContext;
use super::state::{
    CRIT_BIT, CRIT_MATCH_BIT, FIRST_CRIT, FIRST_NONE, MATCH_BIT, MISS_BIT, START_CODE, StepOutcome,
};
use super::types::ContextualPayload;
use super::types::{
    ConditionOn, SaveLanding, SubstitutePolicy, Trigger, TurnSpecError, TurnSpecErrorCode,
};
use crate::Pmf;
use crate::builder::types::MissRerollMode;
use crate::common::RollType;
use crate::error::DiceError;
use indexmap::{IndexMap, IndexSet};
use std::sync::{Arc, Mutex};

pub use self::source::{
    DeclaredAttack, EvaluatedRider, PlanDamage, SourceSlices, check_duplicate_ids,
    check_save_row_ability, check_state_limit, declared_attacks, is_stateless,
};
pub use self::steps::build_plan;

/// How many flag bits a walk state may carry: JS bit operations are 32-bit signed and the sign bit
/// stays clear. Flags whose lives do not overlap share a bit, so this bounds the flags live at
/// once; past it the turn is `too-many-states`.
pub const MAX_FLAG_BITS: usize = 30;

/// The creature an attack, or a `start` condition, is on when it names none.
pub const DEFAULT_CREATURE: &str = "target";

/// The most bits of one attack's variant mask (capped counters, coins, distinct `targetHas` sets).
pub const MAX_VARIANT_BITS: usize = 30;

/// The default `TurnSpec.stateLimit`: the engine's `MAX_CONDITION_STATES`.
pub const MAX_TURN_STATES: f64 = 16_384.0;

/// `new TurnSpecError(code, id, message)` as a [`DiceError`] (the TS `fail`).
pub fn fail(code: TurnSpecErrorCode, id: &str, message: impl AsRef<str>) -> DiceError {
    DiceError::from(TurnSpecError::new(code, id, message.as_ref()))
}

/// Which payload a rider used when it fired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fire {
    Hit,
    Crit,
}

/// `FireMode`: which payload a rider used when it fired, or `None` while it has not fired.
pub type FireMode = Option<Fire>;

/// Where an effect in force comes from: the starting condition, or a condition by its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectSource {
    Starting,
    Grant(String),
}

/// A sparse table filled in while a walk runs: `variants` and `contextPmfs` of a [`Step`]. A slot
/// not built yet is a hole (`get` is `None`); clones share the table.
pub struct Lazy<T>(Arc<Mutex<Vec<Option<Arc<T>>>>>);

impl<T> Clone for Lazy<T> {
    fn clone(&self) -> Self {
        Lazy(Arc::clone(&self.0))
    }
}

impl<T> Default for Lazy<T> {
    fn default() -> Self {
        Lazy(Arc::new(Mutex::new(Vec::new())))
    }
}

impl<T> Lazy<T> {
    pub fn new() -> Self {
        Self::default()
    }

    fn table(&self) -> std::sync::MutexGuard<'_, Vec<Option<Arc<T>>>> {
        // A poisoned lock still holds a consistent table: every write is one push or one store.
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `array.length`: holes count.
    pub fn len(&self) -> usize {
        self.table().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `array[index]`; `None` for a hole or past the end.
    pub fn get(&self, index: usize) -> Option<Arc<T>> {
        self.table().get(index).cloned().flatten()
    }

    /// `array[index] = value`, growing the table with holes.
    pub fn set(&self, index: usize, value: T) {
        let mut table = self.table();
        if table.len() <= index {
            table.resize_with(index + 1, || None);
        }
        table[index] = Some(Arc::new(value));
    }

    /// `array[index] = value` for a value already shared.
    pub fn set_arc(&self, index: usize, value: Arc<T>) {
        let mut table = self.table();
        if table.len() <= index {
            table.resize_with(index + 1, || None);
        }
        table[index] = Some(value);
    }

    /// `array.length = len` (growing with holes, or truncating).
    pub fn set_len(&self, len: usize) {
        self.table().resize_with(len, || None);
    }

    /// `array.push(value)`; the index it landed at.
    pub fn push(&self, value: T) -> usize {
        let mut table = self.table();
        table.push(Some(Arc::new(value)));
        table.len() - 1
    }

    /// Every built entry in order, with its index.
    pub fn built(&self) -> Vec<(usize, Arc<T>)> {
        self.table()
            .iter()
            .enumerate()
            .filter_map(|(i, v)| v.clone().map(|v| (i, v)))
            .collect()
    }
}

/// What a save row's draw is to a rider reading the row under each landing kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByKind {
    pub fail: StepOutcome,
    pub damage: StepOutcome,
}

impl ByKind {
    /// `byKind[kind]`.
    pub fn of(&self, kind: SaveLanding) -> StepOutcome {
        match kind {
            SaveLanding::Fail => self.fail,
            SaveLanding::Damage => self.damage,
        }
    }
}

/// What an attack row's hit is under each landing kind once split by its own damage (`DEALT.hit`).
pub const DEALT_HIT: ByKind = ByKind {
    fail: StepOutcome::Hit,
    damage: StepOutcome::Hit,
};
/// `DEALT.crit`.
pub const DEALT_CRIT: ByKind = ByKind {
    fail: StepOutcome::Crit,
    damage: StepOutcome::Crit,
};
/// `NOT_DEALT.hit`: dealt 0 lands for `fail` and is no landing, and no miss, for `damage`.
pub const NOT_DEALT_HIT: ByKind = ByKind {
    fail: StepOutcome::Hit,
    damage: StepOutcome::None,
};
/// `NOT_DEALT.crit`.
pub const NOT_DEALT_CRIT: ByKind = ByKind {
    fail: StepOutcome::Crit,
    damage: StepOutcome::None,
};

/// `DEALT[outcome]` for `outcome` hit or crit (anything else reads as hit: never asked).
pub fn dealt_by_kind(crit: bool) -> ByKind {
    if crit { DEALT_CRIT } else { DEALT_HIT }
}

/// `NOT_DEALT[outcome]`.
pub fn not_dealt_by_kind(crit: bool) -> ByKind {
    if crit { NOT_DEALT_CRIT } else { NOT_DEALT_HIT }
}

/// The riders a draw folded in: each id with the (mass 1) payload it adds. Shared by identity
/// between draws split from one another, as the TS array is.
pub type Riders = Arc<Vec<(String, Arc<Pmf>)>>;

/// One outcome a step's walk convolves in (see the TS doc of `Draw`).
#[derive(Clone, Debug)]
pub struct Draw {
    pub outcome: StepOutcome,
    pub matched: bool,
    pub spends: bool,
    /// Set on the draws a first-miss reroll's roll lands as: the fire slot of the reroll spent.
    pub reroll_slot: Option<usize>,
    /// Indices into [`TurnPlan::every_hit_ids`].
    pub applies: Vec<usize>,
    /// Indices into [`TurnPlan::counter_max`].
    pub bumps: Vec<usize>,
    /// Fire slots a first-hit rider with a payload per source marks when this draw applies it.
    pub fires: Vec<usize>,
    pub slice: Arc<Pmf>,
    pub by_kind: Option<ByKind>,
    /// Set where riders are folded into `slice`: the row's own part before the fold.
    pub own: Option<Arc<Pmf>>,
    pub riders: Option<Riders>,
    pub wounded: Option<bool>,
    pub typed: Option<bool>,
}

impl Draw {
    /// A draw with nothing folded or marked: `{ outcome, matched, spends, applies: [], bumps: [],
    /// fires: [], slice }`.
    pub fn plain(outcome: StepOutcome, matched: bool, spends: bool, slice: Arc<Pmf>) -> Draw {
        Draw {
            outcome,
            matched,
            spends,
            reroll_slot: None,
            applies: Vec::new(),
            bumps: Vec::new(),
            fires: Vec::new(),
            slice,
            by_kind: None,
            own: None,
            riders: None,
            wounded: None,
            typed: None,
        }
    }
}

/// `StepVariant`: the draws of one attack step under one state-dependent context. Masses sum to 1.
pub type StepVariant = Vec<Draw>;

/// `draw` with its mass scaled by `factor`, its own part with it.
pub fn scale_draw(draw: &Draw, factor: f64) -> Draw {
    let mut scaled = draw.clone();
    scaled.slice = scale_shared(&draw.slice, factor);
    if let Some(own) = &draw.own {
        scaled.own = Some(scale_shared(own, factor));
    }
    scaled
}

/// `pmf.scaleMass(factor)` on a shared PMF: TS returns the same instance for a factor of 1, and
/// the readers key per-PMF tallies by identity, so the same `Arc` is handed back.
pub fn scale_shared(pmf: &Arc<Pmf>, factor: f64) -> Arc<Pmf> {
    if factor == 1.0 {
        pmf.clone()
    } else {
        Arc::new(pmf.scale_mass(factor))
    }
}

/// `draw` split by whether it dealt more than 0: the row's own damage, or a folded rider's. A draw
/// with folded riders splits its own part first; where that dealt nothing the riders decide, and
/// each rider's payload is then conditioned on what the split says.
pub fn split_wounded(draw: &Draw) -> Result<Vec<Draw>, DiceError> {
    let wounded = |d: &Draw, w: bool| {
        let mut d = d.clone();
        d.wounded = Some(w);
        d
    };
    if draw.outcome == StepOutcome::None {
        return Ok(vec![wounded(draw, false)]);
    }
    let mut pieces: Vec<Draw> = Vec::new();
    let (Some(own), Some(riders)) = (&draw.own, &draw.riders) else {
        let (dealt, none) = draw.slice.split_by_dealt();
        if dealt.mass() > 0.0 {
            let mut d = wounded(draw, true);
            d.slice = Arc::new(dealt);
            pieces.push(d);
        }
        if none.mass() > 0.0 {
            let mut d = wounded(draw, false);
            d.slice = Arc::new(none);
            pieces.push(d);
        }
        return Ok(pieces);
    };
    let fold = |part: &Pmf| -> Pmf {
        let mut all = part.clone();
        for (_, payload) in riders.iter() {
            all = all.convolve(payload, Some(0.0), true);
        }
        all
    };
    // Wounded where the row's own roll dealt more than 0, or else where a rider's payload did.
    let (own_dealt, own_none) = own.split_by_dealt();
    if own_dealt.mass() > 0.0 {
        let mut d = wounded(draw, true);
        d.slice = Arc::new(fold(&own_dealt));
        d.own = Some(Arc::new(own_dealt));
        pieces.push(d);
    }
    let none_mass = own_none.mass();
    if none_mass <= 0.0 {
        return Ok(pieces);
    }
    // The own roll dealt nothing: the turn is wounded where some rider dealt more than 0.
    let zero: Vec<f64> = riders
        .iter()
        .map(|(_, payload)| payload.p_at(0.0))
        .collect();
    let all_zero = zero.iter().fold(1.0, |product, p| product * p);
    let quiet: Vec<(String, Arc<Pmf>)> = riders
        .iter()
        .map(|(id, _)| Ok((id.clone(), Arc::new(Pmf::delta(0.0, 0.0)?))))
        .collect::<Result<_, DiceError>>()?;
    if 1.0 - all_zero > 0.0 {
        let loud: Vec<(String, Arc<Pmf>)> =
            riders
                .iter()
                .enumerate()
                .map(|(k, (id, payload))| {
                    // P(this payload, and the riders together dealt more than 0) / P(the riders dealt more than 0).
                    let others_zero = zero.iter().enumerate().fold(1.0, |product, (j, p)| {
                        if j == k { product } else { product * p }
                    });
                    let (kept, _) = payload
                        .split_by_factor(|value| if value > 0.0 { 1.0 } else { 1.0 - others_zero });
                    (
                        id.clone(),
                        Arc::new(kept.scale_mass(1.0 / (1.0 - all_zero))),
                    )
                })
                .collect();
        // What the riders dealt together, where that was more than 0, beside the own roll's.
        let mut together = Pmf::delta(0.0, 0.0)?;
        for (_, payload) in riders.iter() {
            together = together.convolve(payload, Some(0.0), true);
        }
        let dealt = together.split_by_dealt().0;
        let mut d = wounded(draw, true);
        d.own = Some(Arc::new(own_none.scale_mass(1.0 - all_zero)));
        d.riders = Some(Arc::new(loud));
        d.slice = Arc::new(own_none.convolve(&dealt, Some(0.0), true));
        pieces.push(d);
    }
    if all_zero > 0.0 {
        let mut d = wounded(draw, false);
        d.own = Some(Arc::new(own_none.scale_mass(all_zero)));
        d.riders = Some(Arc::new(quiet));
        d.slice = Arc::new(own_none.scale_mass(all_zero));
        pieces.push(d);
    }
    Ok(pieces)
}

/// Whether two draws fold in the same riders with the same payloads (by identity).
fn same_riders(a: &Option<Riders>, b: &Option<Riders>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            Arc::ptr_eq(a, b)
                || (a.len() == b.len()
                    && a.iter()
                        .zip(b.iter())
                        .all(|((ia, pa), (ib, pb))| ia == ib && Arc::ptr_eq(pa, pb)))
        }
        _ => false,
    }
}

/// `draws` with every pair that advances the walk identically summed into one draw.
pub fn merge_draws(draws: Vec<Draw>) -> Vec<Draw> {
    let mut merged: Vec<Draw> = Vec::new();
    for draw in draws {
        let index = merged.iter().position(|other| {
            other.outcome == draw.outcome
                && other.matched == draw.matched
                && other.spends == draw.spends
                && other.reroll_slot == draw.reroll_slot
                && other.by_kind == draw.by_kind
                && other.wounded == draw.wounded
                && other.typed == draw.typed
                // A wound split conditions the riders' payloads; parts with different conditions stay apart.
                && (draw.wounded.is_none() || riders_identical(&other.riders, &draw.riders))
                // So does a type split (see `typedSplit`), into payloads of its own.
                && (draw.typed.is_none() || same_riders(&other.riders, &draw.riders))
        });
        match index {
            None => merged.push(draw),
            Some(index) => {
                let other = &merged[index];
                let mut sum = other.clone();
                sum.slice = Arc::new(other.slice.add(&draw.slice));
                if other.own.is_some() || draw.own.is_some() {
                    let a = other.own.as_ref().unwrap_or(&other.slice);
                    let b = draw.own.as_ref().unwrap_or(&draw.slice);
                    sum.own = Some(Arc::new(a.add(b)));
                }
                merged[index] = sum;
            }
        }
    }
    merged
}

/// `a === b` on two optional riders arrays: the very same array (or both absent).
fn riders_identical(a: &Option<Riders>, b: &Option<Riders>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        _ => false,
    }
}

/// `codes` with `outcome` folded into each group in `updates`; a group with a landing kind (in
/// `kinds`, aligned with `updates`) folds in the draw's `byKind` entry for it instead.
pub fn advanced(
    codes: &[u32],
    updates: &[usize],
    kinds: &[Option<SaveLanding>],
    outcome: StepOutcome,
    matched: bool,
    by_kind: Option<ByKind>,
) -> Vec<u32> {
    let mut next = codes.to_vec();
    for (index, &group) in updates.iter().enumerate() {
        let kind = kinds.get(index).copied().flatten();
        let used = match (kind, by_kind) {
            (Some(kind), Some(by_kind)) => by_kind.of(kind),
            _ => outcome,
        };
        // INFALLIBLE: a group slot is always below the walk's slot count.
        if let Some(code) = next.get_mut(group) {
            *code = super::state::advance(*code, used, matched);
        }
    }
    next
}

/// `codes` with every slot in `releases` reset to the code of a group that has seen nothing;
/// `None` when none of them needs it (TS: `codes` itself).
pub fn released_opt(codes: &[u32], releases: &[usize]) -> Option<Vec<u32>> {
    let mut next: Option<Vec<u32>> = None;
    for &slot in releases {
        if codes.get(slot).copied() == Some(START_CODE) || codes.get(slot).is_none() {
            continue;
        }
        let n = next.get_or_insert_with(|| codes.to_vec());
        n[slot] = START_CODE;
    }
    next
}

/// `released(codes, releases)`: `codes` with every slot in `releases` reset to the code of a group
/// that has seen nothing.
pub fn released(codes: &[u32], releases: &[usize]) -> Vec<u32> {
    released_opt(codes, releases).unwrap_or_else(|| codes.to_vec())
}

/// `GrantApplication`: one condition, applied at one of its source steps. When the drawn outcome
/// qualifies, the draw splits by `chance`: `grants` are set on one part, `onSave` on the other.
#[derive(Clone)]
pub struct GrantApplication {
    /// Index into [`TurnPlan::condition_ids`].
    pub condition: usize,
    pub on: ConditionOn,
    /// Group slot whose pre-draw code `first-hit` / `first-crit` / `first-miss` reads, else `None`.
    pub reads: Option<usize>,
    /// How a save row, or an attack row whose draws are split by damage dealt, lands the condition.
    pub landing: Option<SaveLanding>,
    pub chance: f64,
    /// With a grant save: its fail chance in the state's flags, replacing `chance`.
    pub chance_of: Option<ChanceFn>,
    /// Flag bits set on the `chance` branch.
    pub grants: u32,
    /// Flag bits set on the other branch.
    pub on_save: u32,
    /// Non-zero when the application is skipped once all of these bits are set.
    pub in_force: u32,
    /// Whether a later step reads one of `grants`.
    pub effective: bool,
    /// For a once-per-turn condition that waits for a reader: the bit that says it was tried
    /// (`first-*` then reads it instead of its group), `Tried::Never` where no later row reads it,
    /// `Tried::Group` (TS 0): the group decides, as ever.
    pub tried: Tried,
    /// For a condition that fires where a folded rider landed: that rider's id.
    pub rider: Option<String>,
    /// For a condition that needs a damage type dealt (`dealing`): only a `typed` draw lands it.
    pub dealing: bool,
    pub counted: bool,
    pub counted_in_force: bool,
    pub count_only: bool,
    /// For a gated condition (`targetHas`): the flag bits that open the gate at this step.
    pub gate_mask: Option<u32>,
}

/// `GrantApplication.tried`: TS `0` (the group decides), `-1` (never tried here), or a flag bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tried {
    Group,
    Never,
    Bit(u32),
}

/// `GrantApplication.chanceOf`: the fail chance in a state's flags. `Err` is a `RangeError` the
/// TS throws from inside the walk.
pub type ChanceFn = Arc<dyn Fn(u32) -> Result<f64, DiceError> + Send + Sync>;

/// `grantApplies(app, drawn, codes, byKind, flags, riders, typed)`: whether `drawn` (with the
/// draw's `byKind`), drawn in a state whose pre-draw group codes are `codes`, applies `app`.
pub fn grant_applies(
    app: &GrantApplication,
    drawn: StepOutcome,
    codes: &[u32],
    by_kind: Option<ByKind>,
    flags: u32,
    riders: Option<&Riders>,
    typed: Option<bool>,
) -> bool {
    use super::types::AttackTriggerOn as On;
    if app.dealing && typed != Some(true) {
        return false;
    }
    if let Some(mask) = app.gate_mask
        && flags & mask == 0
    {
        return false;
    }
    if let Some(rider) = &app.rider {
        // It fires where its rider landed, once where it is once per turn.
        if !riders.is_some_and(|r| r.iter().any(|(id, _)| id == rider)) {
            return false;
        }
        return match app.tried {
            Tried::Group => true,
            Tried::Never => false,
            Tried::Bit(bit) => flags & bit == 0,
        };
    }
    let outcome = match (app.landing, by_kind) {
        (Some(landing), Some(by_kind)) => by_kind.of(landing),
        _ => drawn,
    };
    // A "none" outcome (an attack that did not happen) is no landing and no miss, so it applies no
    // condition's grants.
    if outcome == StepOutcome::None {
        return false;
    }
    let on = app.on;
    if app.tried != Tried::Group {
        // Tried at most once, and only where a later row reads it.
        match app.tried {
            Tried::Never => return false,
            Tried::Bit(bit) if flags & bit != 0 => return false,
            _ => {}
        }
        if on == ConditionOn::FirstCrit {
            return outcome == StepOutcome::Crit;
        }
        return if on == ConditionOn::Attack(super::types::AttackTriggerOn::FirstMiss) {
            outcome == StepOutcome::Miss
        } else {
            outcome != StepOutcome::Miss
        };
    }
    // `codes[app.reads]`: a missing slot reads as `undefined`, whose bit operations are 0.
    let code = app
        .reads
        .and_then(|slot| codes.get(slot).copied())
        .unwrap_or(0);
    match on {
        ConditionOn::Attack(On::EveryHit) => outcome != StepOutcome::Miss,
        ConditionOn::Attack(On::FirstHit) => {
            outcome != StepOutcome::Miss && ((code >> 2) & 0b11) == FIRST_NONE
        }
        ConditionOn::Attack(On::AnyCrit) => outcome == StepOutcome::Crit,
        ConditionOn::FirstCrit => outcome == StepOutcome::Crit && (code & CRIT_BIT) == 0,
        ConditionOn::Attack(On::AnyMiss) => outcome == StepOutcome::Miss,
        ConditionOn::Attack(On::FirstMiss) => {
            outcome == StepOutcome::Miss && (code & MISS_BIT) == 0
        }
        // A `start` condition has no application.
        ConditionOn::Start => false,
    }
}

/// What a gate reads of a group's code: a landing, any outcome, or what a rider's trigger reads of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateReads {
    First,
    Any,
    Crit,
    Miss,
    Match,
}

/// What decides whether a gated attack happens (`AttackOptions.after`): the code of a group slot,
/// read as `reads` says, or the fire slot of a rider folded into its sources' draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Group { slot: usize, reads: GateReads },
    Fired { slot: usize },
}

/// `Step.select`'s signature: group codes, fire slots with this step's own firing already recorded,
/// flag bits before this step consumes any, and counters of capped `every-hit` landings so far.
pub type SelectFn =
    Arc<dyn Fn(&[u32], &[FireMode], u32, &[u32]) -> Result<usize, DiceError> + Send + Sync>;

/// `Step.contextIndexOf`: which of [`Step::context_pmfs`] a state rolls in.
pub type ContextIndexFn = SelectFn;

/// One effect of one step's flag reads: `Step.flagReads`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlagRead {
    pub bit: i32,
    pub modifiers: u32,
    pub penalty: bool,
    /// An index into [`TurnPlan::effect_sources`].
    pub source: Option<usize>,
}

/// The first-miss rerolls watching a row: `Step.rerolls`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepReroll {
    pub slot: usize,
    pub mode: MissRerollMode,
}

/// One step of the turn (see the TS doc of `Step` for each field).
#[derive(Clone)]
pub struct Step {
    pub id: String,
    /// Declared attacks always fire (`None`); riders consult their trigger.
    pub trigger: Option<EvaluatedRider>,
    /// Every precomputed draw set; index 0 is the plain one. Blocks past the first are built the
    /// first time a walk selects them (see [`Lazy`]); a pure-damage step has none.
    pub variants: Lazy<StepVariant>,
    /// Picks the variant to draw from (an index into `variants`).
    pub select: SelectFn,
    /// Pure-damage payloads, mass 1 each.
    pub damage: Option<StepDamage>,
    /// Group slots this step's outcome advances.
    pub updates: Vec<usize>,
    /// Per entry of `updates`, the landing kind of the group's rider when this step is a save row.
    pub update_kinds: Vec<Option<SaveLanding>>,
    /// Per counter, the count at or below which it is equivalent to 0 once this step has run.
    pub settled: Vec<f64>,
    /// Slots whose group is last read at this step and which a later group reuses.
    pub releases: Vec<usize>,
    /// Group slot this step's trigger reads, or `None` for `not-fired` / always-fires.
    pub reads: Option<usize>,
    /// Fire slot this step writes when it fires, or `None` for a declared attack.
    pub slot: Option<usize>,
    /// For `not-fired`: the fire slot of the rider or substitute being negated.
    pub negates: Option<usize>,
    /// Fire slot a `spends` draw sets, or `None`.
    pub spend_slot: Option<usize>,
    /// `next-attack` flag bits this step reads, and so clears when it rolls.
    pub consumes: u32,
    /// `next-hit` flag bits this step reads, and so clears when it hits or crits.
    pub hit_consumes: u32,
    /// Bits of the conditions damage ends that this step finds set.
    pub wounds: u32,
    /// For an attack gated on an earlier row (`AttackOptions.after`).
    pub gate: Option<Gate>,
    /// Conditions this step's outcome may apply, in declaration order.
    pub grants: Vec<GrantApplication>,
    pub read_advantage: u32,
    pub read_disadvantage: u32,
    pub read_crit_on_hit: u32,
    pub flag_reads: Vec<FlagRead>,
    /// The row's own PMF in each context it can roll in; a context past the first is a hole until
    /// a state first rolls in it.
    pub context_pmfs: Lazy<Pmf>,
    pub context_roll_types: Vec<RollType>,
    pub context_vulnerable: Vec<bool>,
    pub context_row_contexts: Vec<Option<RowContext>>,
    /// Which of `context_pmfs` a state rolls in.
    pub context_index_of: ContextIndexFn,
    /// Whether a substitute rewrites the row's own damage.
    pub transformed: bool,
    /// Whether the watching substitute converts the row's first miss into a hit.
    pub converts: bool,
    pub rerolls: Vec<StepReroll>,
    /// That substitute's policy; `None` where none watches the row, or it converts.
    pub policy: Option<SubstitutePolicy>,
    /// The probability the row happens at all (`AttackOptions.chance`); 1 for a rider.
    pub chance: f64,
}

/// `Step.damage`.
#[derive(Clone, Debug)]
pub struct StepDamage {
    pub hit: Arc<Pmf>,
    pub crit: Arc<Pmf>,
}

/// `TurnPlan.coins` entry.
#[derive(Clone, Debug, PartialEq)]
pub struct Coin {
    pub id: String,
    pub bit: u32,
    pub happens: f64,
}

/// A resolved, validated turn: the ordered steps to walk, plus the trigger groups it tracks.
/// Building this is where every `TurnSpecError` is raised.
#[derive(Clone)]
pub struct TurnPlan {
    pub effect_sources: Vec<EffectSource>,
    pub optional_ids: Vec<String>,
    pub steps: Vec<Step>,
    pub group_count: usize,
    pub attack_pmfs: Vec<Arc<Pmf>>,
    pub attack_singles: Vec<Arc<Pmf>>,
    pub attack_ids: Vec<String>,
    pub rider_ids: Vec<String>,
    pub substitute_ids: Vec<String>,
    pub probe_ids: Vec<String>,
    pub reroll_ids: Vec<String>,
    pub fire_slots: IndexMap<String, usize>,
    pub slot_count: usize,
    pub per_hit_groups: IndexMap<String, usize>,
    pub per_hit_crit_only: IndexSet<String>,
    pub per_hit_any: IndexSet<String>,
    pub rider_rows: IndexMap<String, Vec<String>>,
    /// Probe id -> the group slot whose "something crit" bit answers its probability.
    pub probes: IndexMap<String, Option<usize>>,
    pub every_hit_ids: Vec<String>,
    pub counter_max: Vec<f64>,
    /// The LAST step index that reads each group slot (`steps.len()` for a slot read at the final collapse).
    pub group_last_read_step: Vec<isize>,
    pub condition_ids: Vec<String>,
    pub flag_live_after: Vec<u32>,
    pub coins: Vec<Coin>,
    pub start_flags: u32,
    pub start_conditions: Vec<usize>,
    pub state_limit: f64,
    pub dealing: bool,
    pub melee_leaning: Vec<bool>,
    pub source_of: IndexMap<String, PlanDamage>,
    pub rider_of: IndexMap<String, EvaluatedRider>,
    pub payload_at: IndexMap<String, Arc<dyn ContextualPayload>>,
}

/// `fireMode(step, codes, fired)`: decide whether `step` fires in state `codes`, and in which mode.
///
/// Every group a trigger reads is fully determined before its own step runs (sources always
/// precede dependents), so a trigger can be evaluated once, at its step, and again at the end for
/// `Turn.fireProbability`; both give the same answer.
pub fn fire_mode(step: &Step, codes: &[u32], fired: &[FireMode]) -> FireMode {
    let Some(trigger) = &step.trigger else {
        return Some(Fire::Hit);
    };
    let fired_at = |slot: Option<usize>| slot.and_then(|s| fired.get(s).copied()).flatten();
    if let Trigger::NotFired { .. } = trigger.trigger {
        // `fired[step.negates] === null`
        return if fired_at(step.negates).is_none() {
            Some(Fire::Hit)
        } else {
            None
        };
    }
    // `codes[step.reads]`: a missing slot reads as `undefined`, whose bit operations are 0.
    let code = step
        .reads
        .and_then(|slot| codes.get(slot).copied())
        .unwrap_or(0);
    let first = (code >> 2) & 0b11;
    match trigger.trigger {
        Trigger::FirstHit { .. } => {
            if first == FIRST_NONE {
                None
            } else if first == FIRST_CRIT {
                Some(Fire::Crit)
            } else {
                Some(Fire::Hit)
            }
        }
        Trigger::AnyCrit { .. } => {
            if code & CRIT_BIT != 0 {
                Some(Fire::Crit)
            } else {
                None
            }
        }
        Trigger::AnyMiss { .. } => {
            if code & MISS_BIT != 0 {
                Some(Fire::Hit)
            } else {
                None
            }
        }
        // One step per watched source, each right after it, sharing one fire slot: the first one
        // to see a miss fires, and the rest see the slot taken.
        Trigger::FirstMiss { .. } => {
            if code & MISS_BIT != 0 && fired_at(step.slot).is_none() {
                Some(Fire::Hit)
            } else {
                None
            }
        }
        // Crit mode when a crit's dice matched, so damage-shaped rider dice double like every
        // other rider's on a crit.
        Trigger::DiceMatch { .. } => {
            if code & MATCH_BIT == 0 {
                None
            } else if code & CRIT_MATCH_BIT != 0 {
                Some(Fire::Crit)
            } else {
                Some(Fire::Hit)
            }
        }
        // `every-hit` never becomes a step: it is folded into its sources' slices.
        Trigger::EveryHit { .. } | Trigger::NotFired { .. } => None,
    }
}

/// `gateOpen(gate, codes, fired)`: whether a gated attack happens in state (`codes`, `fired`): the
/// earlier attack landed, or the rider it follows fired.
pub fn gate_open(gate: &Gate, codes: &[u32], fired: &[FireMode]) -> bool {
    match *gate {
        Gate::Fired { slot } => fired.get(slot).copied().flatten().is_some(),
        Gate::Group { slot, reads } => {
            let code = codes.get(slot).copied().unwrap_or(0);
            match reads {
                GateReads::First => ((code >> 2) & 0b11) != FIRST_NONE,
                GateReads::Any => code != START_CODE,
                GateReads::Crit => code & CRIT_BIT != 0,
                GateReads::Miss => code & MISS_BIT != 0,
                GateReads::Match => code & MATCH_BIT != 0,
            }
        }
    }
}

/// The 5e abilities by every name a turn accepts (the full name or its three-letter form), to the
/// full name (`ABILITIES[ability]`).
pub fn ability_full(ability: &str) -> Option<&'static str> {
    Some(match ability {
        "str" | "strength" => "strength",
        "dex" | "dexterity" => "dexterity",
        "con" | "constitution" => "constitution",
        "int" | "intelligence" => "intelligence",
        "wis" | "wisdom" => "wisdom",
        "cha" | "charisma" => "charisma",
        _ => return None,
    })
}

/// `buildPlan`'s `folds`: `Joint`: each draw's slice has its riders' payloads convolved in, as the
/// joint `pmf` walk needs. `Masses`: the slice is the row's own part at the folded mass, for the
/// walks that carry only mass: the same plan, none of the fold convolutions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldMode {
    Joint,
    Masses,
}
