//! Port of `src/turn/turn.ts`: `Turn` (a turn of attacks plus riders, substitutes, conditions and
//! probes, resolved to one exact joint distribution), its fluent chaining API, the walks that
//! evaluate a plan and every reader.
//!
//! # Shape
//! - `new Turn(...)` and every chaining call that builds a turn validate it (`buildPlan`), so each
//!   returns `Result<Turn, DiceError>`; the readers return `Result` where TS throws (`unknown-id`,
//!   `too-many-states`, `dealing-joint-unsupported`, a builder error inside the walk).
//! - The TS `WeakMap`/lazy caches (`built`, `resolved`, `readers`, ...) are [`Cache`] cells behind
//!   `&self`, so a `Turn` is `Send + Sync` and every reader takes `&self`.
//! - `Turn.from(spec)` is [`Turn::from_spec`]; `turn(attacks)` is [`turn`]; the `Effect` unions the
//!   trigger verbs accept (damage, effects with a lifetime, a list of both, a `save()` value) are
//!   [`Effect`]; the `onFirstHit(transform)` overload is [`Turn::on_first_hit_transform`]; the
//!   test seam `walkEverything.forced` is [`Turn::from_spec_walked`] (a flag the turn and the turns
//!   it chains into carry, so parallel tests cannot race on a global).
//! - JS numbers in states (`flags`, group codes) are `u32`; the walk key is the TS
//!   `String.fromCharCode` key as a `Vec<u32>` of its units (counts truncated to 16 bits, as
//!   `fromCharCode` does).
//!
//! # ADR-017 deviations
//! - `attacks(count)` with a count above [`MAX_ATTACK_COUNT`] and `bounce({ max })` above
//!   [`MAX_BOUNCE`] are `Err(RangeError)`: TS allocates `count` entries / rebuilds the plan `max`
//!   times (a hang or an out-of-memory abort). See `deviation_*` tests.
//! - A capped rider's payload read as a damage array is capped (see `readers`).

use super::context::{context_of, row_check_of};
use super::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, Grant, Lasting, SaveGated, StartEffect,
    Transform, effect_spec, gate_fields, lasting_for_turn, substitute_fields, unpack_save_options,
};
use super::plan::{
    Draw, EffectSource, Fire, FireMode, FoldMode, Step, Tried, TurnPlan, build_plan,
    check_duplicate_ids, check_save_row_ability, check_state_limit, declared_attacks, fire_mode,
    gate_open, grant_applies, is_stateless, released,
};
use super::readers::{
    Attempt, EFFECT_NAMES, EffectName, LandingPattern, ReaderDamage, ReaderLedger, ReaderTally,
    RowLanding, canonical_codes, capped_pmf, carries_of, code_needs, roll_type_index,
};
use super::state::{CRIT_BIT, FIRST_NONE, START_CODE, StepOutcome, advance};
use super::trace::Trace;
use super::types::{
    Attack, AttackOptions, AttackTriggerOn, AttacksOptions, ConditionOn, ConditionSpec,
    DamageSource, ProbeOn, ProbeSpec, Rider, RiderDamage, RiderDamageSpec, RiderLanding,
    RiderOptions, Source, SubstituteKind, SubstituteOn, SubstituteSpec, Trigger, TurnSpec,
    TurnSpecError, TurnSpecErrorCode,
};
use crate::EPS;
use crate::builder::num::{js_max, js_min};
use crate::builder::types::{Check, MissRerollMode};
use crate::common::{Rng, RollType};
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::pmf::DenseTotal;
use crate::{Bin, Damage, DiceQuery, LabelMap, Pmf};
use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// The most attacks one `attacks(count, ...)` call adds (ADR-017: TS allocates `count` entries).
pub const MAX_ATTACK_COUNT: f64 = 1_000_000.0;

/// The deepest `bounce({ max })` (ADR-017: TS rebuilds the plan once per beam).
pub const MAX_BOUNCE: f64 = 10_000.0;

/// How many optional conditions a turn searches over (the engine's `MAX_SEARCHED_OPTIONAL_GRANTS`).
const MAX_SEARCHED_OPTIONAL: usize = 3;

/// What the last chaining call added: the target of [`Turn::otherwise`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LastKind {
    Rider,
    Substitute,
}

/// Everything a `Turn` is built from, plus what its chaining methods remember.
#[derive(Clone)]
struct TurnState {
    attacks: Vec<Attack>,
    riders: Vec<Rider>,
    substitutes: Vec<SubstituteSpec>,
    conditions: Vec<ConditionSpec>,
    observe: Vec<ProbeSpec>,
    state_limit: Option<f64>,
    /// Set on the turns an optional search walks: their optional conditions are already decided.
    optional_decided: bool,
    /// The optional conditions such a turn does not attempt, by id.
    declined: Option<Vec<String>>,
    /// A chaining call defaulted some rider's, substitute's or condition's `of`. Appending an
    /// attack now would leave it out of that set silently, so it throws instead.
    defaulted: bool,
    last: Option<(LastKind, usize)>,
}

impl TurnState {
    /// The state as the spec `buildPlan` reads.
    fn spec(&self) -> TurnSpec {
        TurnSpec {
            attacks: self.attacks.clone(),
            riders: Some(self.riders.clone()),
            substitutes: Some(self.substitutes.clone()),
            conditions: Some(self.conditions.clone()),
            observe: Some(self.observe.clone()),
            state_limit: self.state_limit,
        }
    }

    fn declined_set(&self) -> HashSet<String> {
        self.declined
            .as_ref()
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn plan(&self, eps: f64, folds: FoldMode) -> Result<TurnPlan, DiceError> {
        build_plan(&self.spec(), eps, &self.declined_set(), folds)
    }
}

/// A cell filled on first use and shared after.
struct Cache<T>(Mutex<Option<Arc<T>>>);

impl<T> Cache<T> {
    fn new() -> Self {
        Cache(Mutex::new(None))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<T>>> {
        // A poisoned lock still holds a consistent value: it is written once, whole.
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn get(&self) -> Option<Arc<T>> {
        self.lock().clone()
    }

    fn set(&self, value: Arc<T>) {
        *self.lock() = Some(value);
    }

    /// The value, computed (outside the lock) by `make` on first use. A failure caches nothing.
    fn get_or_try<E>(&self, make: impl FnOnce() -> Result<T, E>) -> Result<Arc<T>, E> {
        if let Some(known) = self.get() {
            return Ok(known);
        }
        let made = Arc::new(make()?);
        let mut cell = self.lock();
        Ok(cell.get_or_insert(made).clone())
    }
}

/// Per-step statistics of a turn's walk, for one attack or attack-shaped rider. Every field is a
/// probability (mass): `rolled` is the mass in which the step drew at all, `hit`/`crit` the mass of
/// those draws that landed (crit included) / were crits, `live` the mass in which each effect was
/// in force when the step read its flags, with the part each source accounts for (sources
/// overlap, so they need not add up). `conditions` lists each condition the step tried.
#[derive(Clone, Debug, PartialEq)]
pub struct StepStats {
    pub rolled: f64,
    pub hit: f64,
    pub crit: f64,
    pub live: LiveOdds,
    pub conditions: Vec<ConditionAttempt>,
}

/// One source's part of an effect's odds.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceOdds {
    pub source: EffectSource,
    pub odds: f64,
}

/// The odds of each effect in force when a row rolls, and the part each source accounts for.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveOdds {
    odds: [f64; 7],
    sources: [Vec<SourceOdds>; 7],
}

impl LiveOdds {
    /// Nothing in force, from no source.
    fn none() -> LiveOdds {
        LiveOdds {
            odds: [0.0; 7],
            sources: Default::default(),
        }
    }

    /// The odds `name` is in force.
    pub fn odds(&self, name: EffectName) -> f64 {
        self.odds[name.index()]
    }

    /// The sources `name` comes from, by source, with the odds each accounts for.
    pub fn sources(&self, name: EffectName) -> &[SourceOdds] {
        &self.sources[name.index()]
    }

    pub fn advantage(&self) -> f64 {
        self.odds(EffectName::Advantage)
    }

    pub fn disadvantage(&self) -> f64 {
        self.odds(EffectName::Disadvantage)
    }

    pub fn crit_on_hit(&self) -> f64 {
        self.odds(EffectName::CritOnHit)
    }
}

/// A condition a row can try: the odds it is attempted there and the odds it takes.
#[derive(Clone, Debug, PartialEq)]
pub struct ConditionAttempt {
    pub id: String,
    pub attempted: f64,
    pub taken: f64,
}

/// An attack's (or attack-shaped rider's) marginal.
#[derive(Clone, Debug)]
pub struct AttackMarginal {
    /// Its damage: `when_happens` thinned by `occurs`.
    pub pmf: Arc<Pmf>,
    /// Its damage in the states where it happens. When `occurs >= 1` `pmf` is this same `Arc`.
    pub when_happens: Arc<Pmf>,
    /// The odds it happens: its `chance`, its gate, and for an attack-shaped rider the odds it
    /// fires.
    pub occurs: f64,
    /// The odds of the d20 it rolls, in every state (index by [`roll_type_index`]).
    pub roll_type: [f64; 4],
}

impl AttackMarginal {
    /// The odds of the d20 `roll_type`.
    pub fn roll_type(&self, roll_type: RollType) -> f64 {
        self.roll_type[roll_type_index(roll_type)]
    }
}

/// A damage rider's marginal; `landings` by attack id, before its `happens`.
#[derive(Clone, Debug)]
pub struct RiderMarginal {
    pub pmf: Pmf,
    pub landings: IndexMap<String, RowLanding>,
    /// P(it lands at least once), before its `happens`: [`Turn::fire_probability`].
    pub any_landing: f64,
}

/// What [`Turn::marginal`] returns.
#[derive(Clone, Debug)]
pub enum Marginal {
    Attack(AttackMarginal),
    Rider(Box<RiderMarginal>),
}

impl Marginal {
    /// The damage it deals on its own.
    pub fn pmf(&self) -> &Pmf {
        match self {
            Marginal::Attack(a) => &a.pmf,
            Marginal::Rider(r) => &r.pmf,
        }
    }

    pub fn as_attack(&self) -> Option<&AttackMarginal> {
        match self {
            Marginal::Attack(a) => Some(a),
            Marginal::Rider(_) => None,
        }
    }

    pub fn as_rider(&self) -> Option<&RiderMarginal> {
        match self {
            Marginal::Attack(_) => None,
            Marginal::Rider(r) => Some(r.as_ref()),
        }
    }
}

/// What a trigger verb accepts besides a payload's own type: a single part of an effect list.
#[derive(Clone, Debug)]
pub enum EffectPart {
    Damage(DamageSource),
    Grant(Lasting),
}

/// What a trigger verb accepts: damage, effects with a lifetime, or both in one list; or a
/// `save()` value.
#[derive(Clone, Debug)]
pub enum Effect {
    /// `RiderDamage`: one payload, or several to convolve.
    Damage(RiderDamage),
    /// One effect with a lifetime.
    Lasting(Lasting),
    /// `readonly (Damage | Lasting)[]`.
    List(Vec<EffectPart>),
    /// `save(check, { fail, pass })`.
    Saved(SaveGated),
}

impl From<RiderDamage> for Effect {
    fn from(d: RiderDamage) -> Self {
        Effect::Damage(d)
    }
}

impl From<DamageSource> for Effect {
    fn from(d: DamageSource) -> Self {
        Effect::Damage(RiderDamage::One(d))
    }
}

impl From<Pmf> for Effect {
    fn from(d: Pmf) -> Self {
        Effect::Damage(RiderDamage::One(DamageSource::Pmf(Arc::new(d))))
    }
}

impl From<crate::builder::roll::RollBuilder> for Effect {
    fn from(d: crate::builder::roll::RollBuilder) -> Self {
        Effect::Damage(RiderDamage::One(DamageSource::Roll(d)))
    }
}

impl From<Lasting> for Effect {
    fn from(l: Lasting) -> Self {
        Effect::Lasting(l)
    }
}

impl From<Grant> for Effect {
    fn from(g: Grant) -> Self {
        Effect::Lasting(g.into())
    }
}

impl From<SaveGated> for Effect {
    fn from(s: SaveGated) -> Self {
        Effect::Saved(s)
    }
}

impl From<Vec<EffectPart>> for Effect {
    fn from(l: Vec<EffectPart>) -> Self {
        Effect::List(l)
    }
}

impl From<DamageSource> for RiderDamage {
    fn from(d: DamageSource) -> Self {
        RiderDamage::One(d)
    }
}

impl From<Pmf> for RiderDamage {
    fn from(d: Pmf) -> Self {
        RiderDamage::One(DamageSource::Pmf(Arc::new(d)))
    }
}

impl From<crate::builder::roll::RollBuilder> for RiderDamage {
    fn from(d: crate::builder::roll::RollBuilder) -> Self {
        RiderDamage::One(DamageSource::Roll(d))
    }
}

impl From<crate::builder::attack::AttackBuilder> for RiderDamage {
    fn from(d: crate::builder::attack::AttackBuilder) -> Self {
        RiderDamage::One(DamageSource::Attack(Box::new(d)))
    }
}

impl From<crate::builder::save::SaveBuilder> for RiderDamage {
    fn from(d: crate::builder::save::SaveBuilder) -> Self {
        RiderDamage::One(DamageSource::Save(Box::new(d)))
    }
}

impl From<Vec<DamageSource>> for RiderDamage {
    fn from(d: Vec<DamageSource>) -> Self {
        RiderDamage::Many(d)
    }
}

impl From<crate::builder::attack::AttackBuilder> for Effect {
    fn from(d: crate::builder::attack::AttackBuilder) -> Self {
        Effect::Damage(d.into())
    }
}

impl From<crate::builder::save::SaveBuilder> for Effect {
    fn from(d: crate::builder::save::SaveBuilder) -> Self {
        Effect::Damage(d.into())
    }
}

/// What a trigger verb's options hold, whichever verb it is (`EveryHitOptions` is the widest).
#[derive(Clone, Debug, Default)]
struct EffectOptions {
    condition: ConditionOptions,
    per_source: Option<super::types::PerSource>,
    max: Option<f64>,
}

impl From<ConditionOptions> for EffectOptions {
    fn from(condition: ConditionOptions) -> Self {
        EffectOptions {
            condition,
            ..EffectOptions::default()
        }
    }
}

impl From<FirstHitOptions> for EffectOptions {
    fn from(o: FirstHitOptions) -> Self {
        EffectOptions {
            condition: o.condition,
            per_source: o.per_source,
            max: None,
        }
    }
}

impl From<EveryHitOptions> for EffectOptions {
    fn from(o: EveryHitOptions) -> Self {
        EffectOptions {
            condition: o.first_hit.condition,
            per_source: o.first_hit.per_source,
            max: o.max,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Stateless rows
// ---------------------------------------------------------------------------------------------

/// One declared attack of a stateless turn: what its readers are closed forms of. `hit` and `crit`
/// are the masses of its landings given it happens (`hit` crit included), as the walk draws them:
/// a row with no hit or crit outcome (a save, a plain roll) is one "hit" draw of its whole PMF.
#[derive(Clone, Debug)]
struct StatelessRow {
    pmf: Arc<Pmf>,
    chance: f64,
    roll_type: RollType,
    hit: f64,
    crit: f64,
}

struct Rows {
    ids: Vec<String>,
    by_id: IndexMap<String, StatelessRow>,
}

/// The rows of a stateless turn (`isStateless`), validated as `buildPlan` validates them and in
/// the same order: the state limit, each attack in turn, duplicate ids, then each save row's
/// ability. A row's d20 is its own (no effect is ever in force): what its source declares, or
/// `flat` for one that declares none.
fn stateless_rows(spec: &TurnSpec, eps: f64) -> Result<Rows, DiceError> {
    check_state_limit(spec.state_limit)?;
    let declared = declared_attacks(spec, eps)?;
    let ids: Vec<String> = declared.iter().map(|row| row.id.clone()).collect();
    check_duplicate_ids(&ids)?;
    for row in &declared {
        check_save_row_ability(row, eps)?;
    }
    let mut by_id = IndexMap::new();
    for row in declared {
        let roll_type = match row_check_of(&row.source) {
            None => RollType::Flat,
            Some(check) => context_of(&check, 0, &[]).roll_type,
        };
        let (hit, crit) = match &row.slices {
            None => (row.pmf.mass(), 0.0),
            Some(slices) => (slices.hit.mass() + slices.crit.mass(), slices.crit.mass()),
        };
        by_id.insert(
            row.id.clone(),
            StatelessRow {
                pmf: row.pmf.clone(),
                chance: row.chance,
                roll_type,
                hit,
                crit,
            },
        );
    }
    Ok(Rows { ids, by_id })
}

// ---------------------------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------------------------

/// What a walk state carries for the damage dealt so far. The full walk carries a `DenseTotal`; a
/// walk that reads probabilities alone carries only the mass of the paths a state stands for, so
/// no damage arithmetic runs at all.
trait Ledger {
    type D: Clone;
    fn start(&self) -> Result<Self::D, DiceError>;
    fn mass(&self, damage: &Self::D) -> f64;
    /// `a = add(a, b)`.
    fn add_to(&mut self, a: &mut Self::D, b: Self::D);
    fn scale(&mut self, damage: &mut Self::D, factor: f64) -> Self::D;
    /// `damage` with a draw's sub-mass `slice` (or a pure-damage payload) folded in. `step` and
    /// `draw` say where it came from, for a ledger that keeps one id's damage alone.
    fn convolve(
        &mut self,
        damage: &mut Self::D,
        slice: &Pmf,
        step: &Step,
        draw: Option<&Draw>,
    ) -> Self::D;
}

/// The joint walk's damage: a [`DenseTotal`], the running PMF as flat arrays. Every operation is
/// the PMF's, to the bit.
struct PmfLedger {
    eps: f64,
}

impl Ledger for PmfLedger {
    type D = DenseTotal;

    fn start(&self) -> Result<DenseTotal, DiceError> {
        Ok(DenseTotal::of(Pmf::delta(0.0, self.eps)?, self.eps))
    }

    fn mass(&self, damage: &DenseTotal) -> f64 {
        damage.mass()
    }

    fn add_to(&mut self, a: &mut DenseTotal, b: DenseTotal) {
        *a = a.add(&b);
    }

    fn scale(&mut self, damage: &mut DenseTotal, factor: f64) -> DenseTotal {
        damage.scale(factor)
    }

    fn convolve(
        &mut self,
        damage: &mut DenseTotal,
        slice: &Pmf,
        _step: &Step,
        _draw: Option<&Draw>,
    ) -> DenseTotal {
        damage.convolve(slice)
    }
}

struct MassLedger;

impl Ledger for MassLedger {
    type D = f64;

    fn start(&self) -> Result<f64, DiceError> {
        Ok(1.0)
    }

    fn mass(&self, damage: &f64) -> f64 {
        *damage
    }

    fn add_to(&mut self, a: &mut f64, b: f64) {
        *a += b;
    }

    fn scale(&mut self, damage: &mut f64, factor: f64) -> f64 {
        *damage * factor
    }

    fn convolve(
        &mut self,
        damage: &mut f64,
        slice: &Pmf,
        _step: &Step,
        _draw: Option<&Draw>,
    ) -> f64 {
        *damage * slice.mass()
    }
}

/// A ledger that keeps the damage of one id alone (a row's own roll, or a rider's payloads) and the
/// mass of every path: walked like the joint, its terminal states sum to that id's marginal.
struct MarginalLedger<'a> {
    id: &'a str,
    eps: f64,
}

impl Ledger for MarginalLedger<'_> {
    type D = Pmf;

    fn start(&self) -> Result<Pmf, DiceError> {
        Pmf::delta(0.0, self.eps)
    }

    fn mass(&self, damage: &Pmf) -> f64 {
        damage.mass()
    }

    fn add_to(&mut self, a: &mut Pmf, b: Pmf) {
        *a = a.add(&b);
    }

    fn scale(&mut self, damage: &mut Pmf, factor: f64) -> Pmf {
        damage.scale_mass(factor)
    }

    fn convolve(&mut self, damage: &mut Pmf, slice: &Pmf, step: &Step, draw: Option<&Draw>) -> Pmf {
        let eps = Some(self.eps);
        let Some(draw) = draw else {
            return if step.id == self.id {
                damage.convolve_raw(slice, eps)
            } else {
                damage.clone()
            };
        };
        if step.id == self.id {
            let own = draw.own.as_ref().map_or(slice, |own| &**own);
            return damage.convolve_raw(own, eps);
        }
        let payload = draw
            .riders
            .as_ref()
            .and_then(|riders| riders.iter().find(|(rider, _)| rider == self.id))
            .map(|(_, payload)| payload);
        let scaled = damage.scale_mass(slice.mass());
        match payload {
            None => scaled,
            Some(payload) => scaled.convolve_raw(payload, eps),
        }
    }
}

impl Ledger for ReaderLedger {
    type D = ReaderDamage;

    fn start(&self) -> Result<ReaderDamage, DiceError> {
        Ok(ReaderLedger::start(self))
    }

    fn mass(&self, damage: &ReaderDamage) -> f64 {
        damage.mass
    }

    fn add_to(&mut self, a: &mut ReaderDamage, b: ReaderDamage) {
        let held = std::mem::take(a);
        *a = ReaderLedger::add(self, held, b);
    }

    fn scale(&mut self, damage: &mut ReaderDamage, factor: f64) -> ReaderDamage {
        ReaderLedger::scale(self, damage, factor)
    }

    fn convolve(
        &mut self,
        damage: &mut ReaderDamage,
        slice: &Pmf,
        _step: &Step,
        draw: Option<&Draw>,
    ) -> ReaderDamage {
        ReaderLedger::convolve(self, damage, slice, draw)
    }
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

/// The walk's state: the group codes, the damage so far, which riders fired, the flag word and the
/// per-condition applied mass.
struct WalkState<D> {
    codes: Vec<u32>,
    damage: D,
    fired: Vec<FireMode>,
    flags: u32,
    /// Per condition, the part of `damage`'s mass in which it was applied at least once while a
    /// later step read it. Carried as mass rather than as a key bit: whether it was applied
    /// changes no later transition, so it must not split states.
    applied: Vec<f64>,
    /// Per counter, how many landings its capped riders have applied to so far. It is what selects
    /// a with-rider or a without-rider draw, so it splits states, but only while the cap can still
    /// bind (see `Step.settled`).
    counts: Vec<u32>,
}

type WalkStates<D> = IndexMap<Vec<u32>, WalkState<D>>;

/// What every walk counts as it goes, in its unnormalized mass units, per step (per every-hit
/// rider for applications).
struct WalkCounts<D> {
    states: WalkStates<D>,
    state_counts: Vec<usize>,
    /// The mass in which a step drew at all.
    rolled: Vec<f64>,
    /// The mass of its hit (crit included) / crit draws.
    hit_mass: Vec<f64>,
    crit_mass: Vec<f64>,
    /// The mass in which the matching modifier flag was set when the step read its flags.
    live_advantage: Vec<f64>,
    live_disadvantage: Vec<f64>,
    live_crit_on_hit: Vec<f64>,
    /// Per every-hit rider, the mass of the draws it applied to: its expected number of
    /// applications.
    application_mass: Vec<f64>,
}

/// What a walk counts per attack-shaped id: the 0.16 `stepStats` fields.
#[derive(Clone, Copy, Debug, Default)]
struct WalkStats {
    rolled: f64,
    hit: f64,
    crit: f64,
    advantage: f64,
    disadvantage: f64,
    crit_on_hit: f64,
}

/// `pmf` given that it happens: its `missNone` mass at 0 beyond `1 - occurs` kept, the rest scaled
/// up.
/// `pmf.applyHitFrequency(frequency)`, which is `pmf` itself (the same object) at a frequency of
/// 1 or more.
fn thinned(pmf: &Arc<Pmf>, frequency: f64) -> Arc<Pmf> {
    if frequency.is_nan() || frequency >= 1.0 {
        pmf.clone()
    } else {
        Arc::new(pmf.apply_hit_frequency(frequency))
    }
}

fn unthinned(pmf: &Pmf, occurs: f64) -> Pmf {
    let mut bins: IndexMap<Damage, Bin> = IndexMap::new();
    let freed = 1.0 - occurs;
    for (damage, bin) in &pmf.map {
        if damage.0 != 0.0 {
            bins.insert(
                *damage,
                Bin {
                    p: bin.p / occurs,
                    count: bin.count.clone(),
                    attr: bin.attr.clone(),
                },
            );
            continue;
        }
        let miss_none = js_max(
            0.0,
            bin.count.get("missNone").copied().unwrap_or(0.0) - freed,
        );
        let p = js_max(0.0, bin.p - freed) / occurs;
        if p > 0.0 {
            let mut count: LabelMap = bin.count.clone();
            count.insert("missNone".to_string(), miss_none / occurs);
            bins.insert(
                *damage,
                Bin {
                    p,
                    count,
                    attr: bin.attr.clone(),
                },
            );
        }
    }
    Pmf::new(bins, pmf.epsilon, false)
}

/// Per attack-shaped id (a declared attack, or a rider that rolls its own attack: anything with
/// variants), what a walk counted of its steps, divided by `total`. A rider that fires at several
/// positions in the rail (a `first-miss` reroll watching many attacks) has one step per position
/// under one id; those steps are mutually exclusive, so their masses sum.
fn step_stats_of<D>(
    plan: &TurnPlan,
    walked: &WalkCounts<D>,
    total: f64,
) -> IndexMap<String, WalkStats> {
    let mut stats: IndexMap<String, WalkStats> = IndexMap::new();
    for (s, step) in plan.steps.iter().enumerate() {
        if step.variants.is_empty() {
            continue;
        }
        let known = stats.get(&step.id).copied().unwrap_or_default();
        // `before + counted / total`
        let add = |counted: f64, before: f64| before + counted / total;
        stats.insert(
            step.id.clone(),
            WalkStats {
                rolled: add(walked.rolled[s], known.rolled),
                hit: add(walked.hit_mass[s], known.hit),
                crit: add(walked.crit_mass[s], known.crit),
                advantage: add(walked.live_advantage[s], known.advantage),
                disadvantage: add(walked.live_disadvantage[s], known.disadvantage),
                crit_on_hit: add(walked.live_crit_on_hit[s], known.crit_on_hit),
            },
        );
    }
    stats
}

/// `draws` with its "none" draw (the row did not happen), if any, first.
fn none_first(draws: &[Draw]) -> Vec<&Draw> {
    let mut ordered: Vec<&Draw> = draws
        .iter()
        .filter(|draw| draw.outcome == StepOutcome::None)
        .collect();
    ordered.extend(
        draws
            .iter()
            .filter(|draw| draw.outcome != StepOutcome::None),
    );
    ordered
}

/// Whether a walk's terminal masses (which are unconditional probabilities, summing to 1) drift
/// from 1 by more than `eps` and so need dividing through. With `eps` 0, any drift does.
fn needs_normalizing(total_mass: f64, eps: f64) -> bool {
    (total_mass - 1.0).abs() > eps && total_mass > 0.0
}

fn quoted(ids: impl IntoIterator<Item = impl AsRef<str>>) -> String {
    ids.into_iter()
        .map(|each| format!("\"{}\"", each.as_ref()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn unknown_id(id: &str, message: &str) -> DiceError {
    DiceError::from(TurnSpecError::new(
        TurnSpecErrorCode::UnknownId,
        id,
        message,
    ))
}

fn internal(message: &str) -> DiceError {
    DiceError::Error(format!("internal: {message}"))
}

/// The key of a walk state: the live group codes, `1`, `+`/`-` per fire slot, `2`, the flags (up to
/// 30 bits: two UTF-16 units, so the key stays injective), then `3` and the counts.
struct MergeCtx<'a> {
    step: &'a Step,
    needs: Option<&'a Vec<u32>>,
    live_groups: &'a [usize],
    live_flags: u32,
    counter_count: usize,
    condition_count: usize,
}

fn merge<L: Ledger>(
    ctx: &MergeCtx<'_>,
    ledger: &mut L,
    next: &mut WalkStates<L::D>,
    mut state: WalkState<L::D>,
) {
    // A slot whose group dies at this step is reset too, for the same reason, so the group that
    // reuses the slot starts from nothing.
    let freed = released(&state.codes, &ctx.step.releases);
    let codes = match ctx.needs {
        None => freed,
        Some(needs) => canonical_codes(freed, needs),
    };
    // Whether each rider fired (and each substitute was spent) is part of the state: two paths
    // that agree on group codes but disagree on a slot must not merge.
    let flags = state.flags & ctx.live_flags;
    // A count the cap can no longer reach is the same as none: both take every later with-rider
    // draw. Zeroing it lets those states merge.
    let counts: Vec<u32> = if ctx.counter_count != 0 {
        state
            .counts
            .iter()
            .enumerate()
            .map(|(counter, &count)| {
                if ctx
                    .step
                    .settled
                    .get(counter)
                    .is_some_and(|settled| f64::from(count) <= *settled)
                {
                    0
                } else {
                    count
                }
            })
            .collect()
    } else {
        state.counts.clone()
    };
    let mut key: Vec<u32> = Vec::with_capacity(ctx.live_groups.len() + state.fired.len() + 6);
    for &g in ctx.live_groups {
        key.push(codes.get(g).copied().unwrap_or(0));
    }
    key.push(1);
    for mode in &state.fired {
        key.push(if mode.is_none() { 45 } else { 43 });
    }
    key.push(2);
    key.push(flags & 0xffff);
    key.push(flags >> 16);
    if ctx.counter_count != 0 {
        key.push(3);
        key.extend(counts.iter().map(|count| count & 0xffff));
    }
    if let Some(existing) = next.get_mut(&key) {
        ledger.add_to(&mut existing.damage, state.damage);
        if ctx.condition_count != 0 {
            for (mass, add) in existing.applied.iter_mut().zip(&state.applied) {
                *mass += add;
            }
        }
    } else {
        // Every state merges once, so it can be the merged state itself.
        state.codes = codes;
        state.flags = flags;
        state.counts = counts;
        next.insert(key, state);
    }
}

/// A part of a draw a condition split off: its flags, share of the draw, and the conditions it
/// applied.
struct Part {
    flags: u32,
    share: f64,
    applied: Vec<usize>,
}

/// Walks the plan's steps, carrying `ledger`'s damage in each state, and returns the terminal
/// states with the per-step statistics, in the same unnormalized mass units as the states.
fn walk<L: Ledger>(
    ledger: &mut L,
    plan: &TurnPlan,
    eps: f64,
    mut tally: Option<&mut ReaderTally>,
) -> Result<WalkCounts<L::D>, DiceError> {
    let width = plan.group_count;
    let condition_count = plan.condition_ids.len();
    let counter_count = plan.counter_max.len();
    let step_total = plan.steps.len();

    let mut rolled = vec![0.0; step_total];
    let mut hit_mass = vec![0.0; step_total];
    let mut crit_mass = vec![0.0; step_total];
    let mut live_advantage = vec![0.0; step_total];
    let mut live_disadvantage = vec![0.0; step_total];
    let mut live_crit_on_hit = vec![0.0; step_total];
    let mut application_mass = vec![0.0; plan.every_hit_ids.len()];

    let start = WalkState {
        codes: vec![START_CODE; width],
        damage: ledger.start()?,
        fired: vec![None; plan.slot_count],
        flags: plan.start_flags,
        applied: (0..condition_count)
            .map(|c| {
                if plan.start_conditions.contains(&c) {
                    1.0
                } else {
                    0.0
                }
            })
            .collect(),
        counts: vec![0; counter_count],
    };
    let mut states: WalkStates<L::D> = IndexMap::new();
    states.insert(Vec::new(), start);
    // A rider that may not happen splits the turn before its first row: its coin came up, or not.
    for coin in &plan.coins {
        let (bit, happens) = (coin.bit, coin.happens);
        let mut split: WalkStates<L::D> = IndexMap::new();
        for (key, mut state) in std::mem::take(&mut states) {
            if happens > 0.0 {
                let mut up = key.clone();
                up.push(43);
                split.insert(
                    up,
                    WalkState {
                        codes: state.codes.clone(),
                        damage: ledger.scale(&mut state.damage, happens),
                        fired: state.fired.clone(),
                        flags: state.flags | bit,
                        applied: state.applied.iter().map(|mass| mass * happens).collect(),
                        counts: state.counts.clone(),
                    },
                );
            }
            if happens < 1.0 {
                let mut down = key;
                down.push(45);
                let damage = ledger.scale(&mut state.damage, 1.0 - happens);
                let applied = state
                    .applied
                    .iter()
                    .map(|mass| mass * (1.0 - happens))
                    .collect();
                split.insert(
                    down,
                    WalkState {
                        damage,
                        applied,
                        ..state
                    },
                );
            }
        }
        states = split;
    }
    let mut state_counts: Vec<usize> = Vec::with_capacity(step_total);
    // The reader walk keeps of each group code only what a later reader needs.
    let needs = if tally.is_some() {
        code_needs(plan)
    } else {
        None
    };

    for (step_index, step) in plan.steps.iter().enumerate() {
        let mut next: WalkStates<L::D> = IndexMap::new();

        // Groups with no reader at a LATER step are dead weight in the key: once the walk passes a
        // group's last reader, its specific code can no longer change any future decision, so two
        // states differing only in a dead group's code are behaviorally identical from here on.
        let live_groups: Vec<usize> = (0..plan.group_count)
            .filter(|&g| {
                plan.group_last_read_step
                    .get(g)
                    .is_some_and(|&last| last > step_index as isize)
            })
            .collect();
        // Flags get the same treatment, and a dead flag is cleared rather than merely left out of
        // the key, so a stale bit can never be read back.
        let live_flags = plan.flag_live_after.get(step_index).copied().unwrap_or(0);
        let ctx = MergeCtx {
            step,
            needs: needs.as_ref().and_then(|needs| needs.get(step_index)),
            live_groups: &live_groups,
            live_flags,
            counter_count,
            condition_count,
        };

        let declared_row = tally.is_some() && step.slot.is_none() && !step.variants.is_empty();
        let contexts = step.context_pmfs.len() > 1;
        for (_, mut state) in std::mem::take(&mut states) {
            // A row's d20 and effects count in every state, whether or not it happens. A declared
            // attack fires no slot, so the context it reads here is the one it rolls in.
            let mut context = 0;
            if declared_row {
                if contexts {
                    context = (step.context_index_of)(
                        &state.codes,
                        &state.fired,
                        state.flags,
                        &state.counts,
                    )?;
                }
                if let Some(tally) = tally.as_deref_mut() {
                    tally.reach(
                        step,
                        step_index,
                        context,
                        state.flags,
                        ledger.mass(&state.damage),
                    );
                }
            }
            // A gated attack whose parent did not land (or whose rider did not fire) does not
            // happen: it deals, lands and consumes nothing.
            if let Some(gate) = &step.gate
                && !gate_open(gate, &state.codes, &state.fired)
            {
                merge(&ctx, ledger, &mut next, state);
                continue;
            }
            let Some(mode) = fire_mode(step, &state.codes, &state.fired) else {
                merge(&ctx, ledger, &mut next, state);
                continue;
            };

            let state_mass = ledger.mass(&state.damage);
            rolled[step_index] += state_mass;
            if step.read_advantage != 0 && state.flags & step.read_advantage != 0 {
                live_advantage[step_index] += state_mass;
            }
            if step.read_disadvantage != 0 && state.flags & step.read_disadvantage != 0 {
                live_disadvantage[step_index] += state_mass;
            }
            if step.read_crit_on_hit != 0 && state.flags & step.read_crit_on_hit != 0 {
                live_crit_on_hit[step_index] += state_mass;
            }

            let mut fired = state.fired.clone();
            if let Some(slot) = step.slot
                && let Some(cell) = fired.get_mut(slot)
            {
                *cell = Some(mode);
            }

            if step.variants.is_empty() {
                let Some(payload) = &step.damage else {
                    return Err(internal("a pure-damage step with no payload"));
                };
                let chosen = if mode == Fire::Crit {
                    &payload.crit
                } else {
                    &payload.hit
                };
                if let Some(tally) = tally.as_deref_mut() {
                    tally.fire(step, chosen, state_mass);
                }
                let damage = ledger.convolve(&mut state.damage, chosen, step, None);
                state.damage = damage;
                state.fired = fired;
                merge(&ctx, ledger, &mut next, state);
                continue;
            }

            // Order at a step: read the flags to select the variant, clear the `next-attack` flags
            // this roll consumes (and the `next-hit` ones a hit or crit consumes), draw, advance
            // the groups, then apply this outcome's grants. An attack that did not happen ("none")
            // rolls nothing, so it consumes nothing.
            if let Some(tally) = tally.as_deref_mut() {
                if !declared_row {
                    if contexts {
                        context = (step.context_index_of)(
                            &state.codes,
                            &fired,
                            state.flags,
                            &state.counts,
                        )?;
                    }
                    tally.reach(step, step_index, context, state.flags, state_mass);
                }
                tally.roll(step_index, context, state_mass);
            }
            let chosen = (step.select)(&state.codes, &fired, state.flags, &state.counts)?;
            let variant = step
                .variants
                .get(chosen)
                .ok_or_else(|| internal("a selected variant that was not built"))?;
            // The reader walk puts "the row did not happen" first, as the engine does, so the
            // states it reaches (and the order conditions are first tried in) follow the engine's.
            let draws: Vec<&Draw> = if tally.is_none() {
                variant.iter().collect()
            } else {
                none_first(&variant)
            };
            let consumed = state.flags & !step.consumes;
            for draw in draws {
                let outcome = draw.outcome;
                let slice_mass = draw.slice.mass();
                if slice_mass <= eps {
                    continue;
                }
                let wounded = draw.wounded == Some(true);
                // A row that dealt damage ends the conditions damage ends, after it has read them.
                let flags = (match outcome {
                    StepOutcome::None => state.flags,
                    StepOutcome::Miss => consumed,
                    _ => consumed & !step.hit_consumes,
                }) & (if wounded { !step.wounds } else { !0 });

                let contribution = state_mass * slice_mass;
                if outcome == StepOutcome::Crit {
                    crit_mass[step_index] += contribution;
                    hit_mass[step_index] += contribution;
                } else if outcome == StepOutcome::Hit {
                    hit_mass[step_index] += contribution;
                }
                for &rider in &draw.applies {
                    if let Some(cell) = application_mass.get_mut(rider) {
                        *cell += contribution;
                    }
                }
                let mut counts = state.counts.clone();
                for &counter in &draw.bumps {
                    if let Some(cell) = counts.get_mut(counter) {
                        *cell += 1;
                    }
                }

                let mut codes = state.codes.clone();
                for (index, &group) in step.updates.iter().enumerate() {
                    let kind = step.update_kinds.get(index).copied().flatten();
                    let folded = match (kind, draw.by_kind) {
                        (Some(kind), Some(by_kind)) => by_kind.of(kind),
                        _ => outcome,
                    };
                    if let Some(code) = codes.get_mut(group) {
                        *code = advance(*code, folded, draw.matched);
                    }
                }
                if let Some(tally) = tally.as_deref_mut() {
                    tally.draw(
                        step,
                        step_index,
                        draw,
                        contribution,
                        context,
                        (&state.codes, &codes),
                    );
                }
                let landed = if outcome == StepOutcome::Crit {
                    Fire::Crit
                } else {
                    Fire::Hit
                };
                let mut draw_fired = fired.clone();
                if draw.spends
                    && let Some(cell) = step.spend_slot.and_then(|slot| draw_fired.get_mut(slot))
                {
                    *cell = Some(landed);
                }
                if let Some(slot) = draw.reroll_slot
                    && let Some(cell) = draw_fired.get_mut(slot)
                {
                    *cell = Some(landed);
                }
                for &slot in &draw.fires {
                    if let Some(cell) = draw_fired.get_mut(slot) {
                        *cell = Some(landed);
                    }
                }
                let damage = ledger.convolve(&mut state.damage, &draw.slice, step, Some(draw));
                // Each qualifying condition splits the draw by its chance: its grants on one part,
                // its onSave grants on the other. Splits compose, since each condition rolls its
                // own save. With none, the draw is one part.
                let mut parts: Option<Vec<Part>> = None;
                for app in &step.grants {
                    if !grant_applies(
                        app,
                        outcome,
                        &state.codes,
                        draw.by_kind,
                        state.flags,
                        draw.riders.as_ref(),
                        draw.typed,
                    ) {
                        continue;
                    }
                    // A grant save fails by the state the row started in; a fixed chance is the
                    // same everywhere. A save forced by a row that dealt damage is made once it is
                    // dealt: what that ended is gone.
                    let chance = match &app.chance_of {
                        None => app.chance,
                        Some(chance_of) => chance_of(if wounded {
                            state.flags & !step.wounds
                        } else {
                            state.flags
                        })?,
                    };
                    if app.count_only {
                        // Nothing reads it, so it splits nothing: only the try is counted.
                        if let Some(tally) = tally.as_deref_mut() {
                            match &parts {
                                None => tally.attempt(
                                    step_index,
                                    app.condition,
                                    contribution * 1.0,
                                    chance,
                                ),
                                Some(parts) => {
                                    for part in parts {
                                        tally.attempt(
                                            step_index,
                                            app.condition,
                                            contribution * part.share,
                                            chance,
                                        );
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    let current = parts.take().unwrap_or_else(|| {
                        vec![Part {
                            flags,
                            share: 1.0,
                            applied: Vec::new(),
                        }]
                    });
                    let mut split: Vec<Part> = Vec::with_capacity(current.len() * 2);
                    for part in current {
                        if app.in_force != 0 && part.flags & app.in_force == app.in_force {
                            if app.counted
                                && app.counted_in_force
                                && let Some(tally) = tally.as_deref_mut()
                            {
                                tally.attempt(
                                    step_index,
                                    app.condition,
                                    contribution * part.share,
                                    chance,
                                );
                            }
                            split.push(part);
                            continue;
                        }
                        if app.counted
                            && let Some(tally) = tally.as_deref_mut()
                        {
                            tally.attempt(
                                step_index,
                                app.condition,
                                contribution * part.share,
                                chance,
                            );
                        }
                        let applied = if app.effective {
                            let mut with = part.applied.clone();
                            with.push(app.condition);
                            with
                        } else {
                            part.applied.clone()
                        };
                        // A once-per-turn try is spent on both branches of its save.
                        let tried = match app.tried {
                            Tried::Bit(bit) => bit,
                            _ => 0,
                        };
                        let taken = part.share * chance;
                        let saved = part.share * (1.0 - chance);
                        if taken > 0.0 {
                            split.push(Part {
                                flags: part.flags | app.grants | tried,
                                share: taken,
                                applied,
                            });
                        }
                        if saved > 0.0 {
                            split.push(Part {
                                flags: part.flags | app.on_save | tried,
                                share: saved,
                                applied: part.applied,
                            });
                        }
                    }
                    parts = Some(split);
                }
                match parts {
                    None => {
                        let applied = if condition_count != 0 {
                            state.applied.iter().map(|mass| mass * slice_mass).collect()
                        } else {
                            state.applied.clone()
                        };
                        merge(
                            &ctx,
                            ledger,
                            &mut next,
                            WalkState {
                                codes,
                                damage,
                                fired: draw_fired,
                                flags,
                                applied,
                                counts,
                            },
                        );
                    }
                    Some(parts) => {
                        let last = parts.len().saturating_sub(1);
                        let mut held = Some(damage);
                        for (index, part) in parts.into_iter().enumerate() {
                            let scale = slice_mass * part.share;
                            // `part.share === 1 ? damage : ledger.scale(damage, part.share)`: the
                            // last part may take `damage` itself, the others share it.
                            let carried = if part.share == 1.0 && index == last {
                                held.take()
                            } else if part.share == 1.0 {
                                held.clone()
                            } else {
                                held.as_mut().map(|damage| ledger.scale(damage, part.share))
                            };
                            let Some(carried) = carried else { continue };
                            let applied = if condition_count != 0 {
                                state
                                    .applied
                                    .iter()
                                    .enumerate()
                                    .map(|(c, mass)| {
                                        if part.applied.contains(&c) {
                                            state_mass * scale
                                        } else {
                                            mass * scale
                                        }
                                    })
                                    .collect()
                            } else {
                                state.applied.clone()
                            };
                            merge(
                                &ctx,
                                ledger,
                                &mut next,
                                WalkState {
                                    codes: codes.clone(),
                                    damage: carried,
                                    fired: draw_fired.clone(),
                                    flags: part.flags,
                                    applied,
                                    counts: counts.clone(),
                                },
                            );
                        }
                    }
                }
            }
        }

        let size = next.len();
        states = next;
        state_counts.push(size);
        if size as f64 > plan.state_limit {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::TooManyStates,
                &step.id,
                &format!(
                    "The walk holds {} states after \"{}\", more than the turn's stateLimit of {}.",
                    size,
                    step.id,
                    num_to_string(plan.state_limit)
                ),
            )));
        }
    }

    Ok(WalkCounts {
        states,
        state_counts,
        rolled,
        hit_mass,
        crit_mass,
        live_advantage,
        live_disadvantage,
        live_crit_on_hit,
        application_mass,
    })
}

/// Every rider, substitute, condition and probe's unnormalized firing mass over the terminal
/// `states`.
fn tally_fire_mass<L: Ledger>(
    states: &WalkStates<L::D>,
    ledger: &L,
    plan: &TurnPlan,
) -> IndexMap<String, f64> {
    let mut fire_mass: IndexMap<String, f64> = IndexMap::new();
    for id in plan.fire_slots.keys() {
        fire_mass.insert(id.clone(), 0.0);
    }
    for id in plan.per_hit_groups.keys() {
        fire_mass.insert(id.clone(), 0.0);
    }
    for id in plan.probes.keys() {
        fire_mass.insert(id.clone(), 0.0);
    }
    for id in &plan.condition_ids {
        fire_mass.insert(id.clone(), 0.0);
    }
    let add = |fire_mass: &mut IndexMap<String, f64>, id: &str, mass: f64| {
        if let Some(cell) = fire_mass.get_mut(id) {
            *cell += mass;
        }
    };

    for state in states.values() {
        let mass = ledger.mass(&state.damage);
        for (id, &slot) in &plan.fire_slots {
            if state
                .fired
                .get(slot)
                .is_some_and(std::option::Option::is_some)
            {
                add(&mut fire_mass, id, mass);
            }
        }
        // `every-hit` riders have no step: they fired iff something landed.
        for (id, &group) in &plan.per_hit_groups {
            let code = state.codes.get(group).copied().unwrap_or(START_CODE);
            let landed = if plan.per_hit_crit_only.contains(id) {
                code & CRIT_BIT != 0
            } else if plan.per_hit_any.contains(id) {
                code != START_CODE
            } else {
                (code >> 2) & 0b11 != FIRST_NONE
            };
            if landed {
                add(&mut fire_mass, id, mass);
            }
        }
        // A probe's group is live to the end of the walk, so its code is still the group's own.
        for (id, group) in &plan.probes {
            // A probe over sources that cannot crit has no group and reports 0.
            if let Some(group) = group
                && state
                    .codes
                    .get(*group)
                    .is_some_and(|code| code & CRIT_BIT != 0)
            {
                add(&mut fire_mass, id, mass);
            }
        }
        // The reader walk carries no applied masses (it reads riders' alone).
        if !state.applied.is_empty() {
            for (c, id) in plan.condition_ids.iter().enumerate() {
                if let Some(applied) = state.applied.get(c) {
                    add(&mut fire_mass, id, *applied);
                }
            }
        }
    }
    fire_mass
}

/// The reader walk's tallies (see [`Turn::resolve_readers`]).
struct Readers {
    tally: ReaderTally,
    states: Vec<ReaderDamage>,
    /// The masses' divisor: the terminal mass where it drifts from 1, else 1.
    total: f64,
    /// Firing masses and expected applications, already divided by `total`.
    fire_mass: IndexMap<String, f64>,
    applications: IndexMap<String, f64>,
    /// Per attack-shaped id, what the walk counted of it, divided by `total`.
    step_stats: IndexMap<String, WalkStats>,
    unexact: IndexSet<String>,
    peak_states: usize,
}

type Patterns = IndexMap<String, IndexMap<String, LandingPattern>>;

// ---------------------------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------------------------

/// A turn of attacks plus conditional damage riders, resolved to one **exact** joint
/// distribution.
///
/// Riders are correlated with the attacks that trigger them, so a rider cannot be a separate
/// `DiceQuery` single convolved in afterwards: that preserves the mean but corrupts the
/// distribution (two daggers + Sneak Attack report P(0 damage) of 0.015 instead of the true
/// 0.1225). `Turn` owns the sources and enumerates the joint outcome space instead, carrying one
/// byte of state per trigger group.
pub struct Turn {
    eps: f64,
    state: TurnState,
    /// Whether every turn walks its plan, stateless or not (the TS `walkEverything.forced`).
    walk_everything: bool,
    /// The state the plan is built from: optional conditions decided (see `optional_choice`).
    planned: TurnState,
    /// The plan every walk reads; built on first use for a stateless turn.
    built: Cache<TurnPlan>,
    /// The rows of a turn that needs no walk state (`isStateless`): no rider, substitute,
    /// condition, probe or gate. Every reader of such a turn is a closed form of its rows, so no
    /// plan is built and nothing is walked unless a reader needs the plan (`pmf`, `toQuery`,
    /// `landings`). `None` for a turn that carries state, or when the walk is forced.
    rows: Option<Rows>,
    resolved: Cache<Pmf>,
    /// The per-step walk size of the joint walk (the TS `Inspection.stateCounts`).
    state_counts: Mutex<Option<Vec<usize>>>,
    /// Firing masses from a walk that carried no damage; see [`Turn::fire_probability`].
    massed: Cache<IndexMap<String, f64>>,
    /// Per-id marginals, read from the reader walk; see [`Turn::marginal`].
    marginals: Mutex<HashMap<String, Arc<Marginal>>>,
    readers: Cache<Readers>,
    patterns: Cache<Patterns>,
    /// The plan without probes, built on first use when there are probes.
    plain_plan: Cache<TurnPlan>,
    /// The plan `sample` walks: joint folds, no probes. Built on first use.
    sampled: Cache<TurnPlan>,
    /// Which landings of each row have a dice-match descriptor, for `sample` (see `sample.rs`).
    match_cache: super::sample::MatchCache,
}

/// A verb's options with `of` as the list a spec holds.
fn names(of: &[&str]) -> Vec<String> {
    of.iter().map(|s| (*s).to_string()).collect()
}

fn trigger_of(trigger: &Trigger) -> Option<&Option<Vec<String>>> {
    match trigger {
        Trigger::FirstHit { of, .. }
        | Trigger::AnyCrit { of, .. }
        | Trigger::AnyMiss { of }
        | Trigger::FirstMiss { of }
        | Trigger::EveryHit { of, .. } => Some(of),
        Trigger::NotFired { .. } | Trigger::DiceMatch { .. } => None,
    }
}

fn set_trigger_of(trigger: &mut Trigger, value: Option<Vec<String>>) {
    match trigger {
        Trigger::FirstHit { of, .. }
        | Trigger::AnyCrit { of, .. }
        | Trigger::AnyMiss { of }
        | Trigger::FirstMiss { of }
        | Trigger::EveryHit { of, .. } => *of = value,
        Trigger::NotFired { .. } | Trigger::DiceMatch { .. } => {}
    }
}

/// The trigger a verb's `on` and options spell.
fn trigger_for(
    on: AttackTriggerOn,
    of: Option<Vec<String>>,
    max: Option<f64>,
    per_source: Option<super::types::PerSource>,
) -> Trigger {
    match on {
        AttackTriggerOn::FirstHit => Trigger::FirstHit { of, per_source },
        AttackTriggerOn::AnyCrit => Trigger::AnyCrit { of, max },
        AttackTriggerOn::AnyMiss => Trigger::AnyMiss { of },
        AttackTriggerOn::FirstMiss => Trigger::FirstMiss { of },
        AttackTriggerOn::EveryHit => Trigger::EveryHit {
            of,
            max,
            per_source,
        },
    }
}

/// A rider with `trigger` and `damage` and the rider options as given.
fn rider_of_options(trigger: Trigger, damage: RiderDamage, options: RiderOptions) -> Rider {
    Rider {
        trigger,
        id: options.id,
        damage: RiderDamageSpec::Plain(damage),
        crit_damage: options.crit_damage,
        landing: options.landing.map(RiderLanding::Save),
        happens: None,
        joins: options.joins,
        r#where: options.r#where,
        target_has: options.target_has,
    }
}

impl Turn {
    fn build(state: TurnState, eps: f64, walk_everything: bool) -> Result<Turn, DiceError> {
        // Built here, not on first use, so every way of constructing a Turn validates at the same
        // moment: the call that introduced the mistake.
        let built = Cache::new();
        let (planned, rows) = if eps == 0.0 && !walk_everything && is_stateless(&state.spec()) {
            // A stateless turn has no optional condition to decide: its plan, if a reader ever
            // needs it, is its own state's.
            (state.clone(), Some(stateless_rows(&state.spec(), eps)?))
        } else {
            let (planned, plan) = Turn::optional_choice(&state, eps, walk_everything)?;
            built.set(plan);
            (planned, None)
        };
        Ok(Turn {
            eps,
            state,
            walk_everything,
            planned,
            built,
            rows,
            resolved: Cache::new(),
            state_counts: Mutex::new(None),
            massed: Cache::new(),
            marginals: Mutex::new(HashMap::new()),
            readers: Cache::new(),
            patterns: Cache::new(),
            plain_plan: Cache::new(),
            sampled: Cache::new(),
            match_cache: Default::default(),
        })
    }

    fn plan(&self) -> Result<Arc<TurnPlan>, DiceError> {
        self.built
            .get_or_try(|| self.planned.plan(self.eps, FoldMode::Masses))
    }

    fn sample_plan(&self) -> Result<Arc<TurnPlan>, DiceError> {
        self.sampled.get_or_try(|| {
            let mut state = self.planned.clone();
            state.observe = Vec::new();
            state.plan(self.eps, FoldMode::Joint)
        })
    }

    /// The plan the mass walks read: `plan` without the probes.
    fn walk_plan(&self) -> Result<Arc<TurnPlan>, DiceError> {
        if self.state.observe.is_empty() {
            return self.plan();
        }
        self.plain_plan.get_or_try(|| {
            let mut state = self.planned.clone();
            state.observe = Vec::new();
            state.plan(self.eps, FoldMode::Masses)
        })
    }

    /// `state` with its optional ("you can") conditions decided, as the engine decides them
    /// (`optionalGrants.ts`): with up to [`MAX_SEARCHED_OPTIONAL`] of them, each subset is
    /// attempted and the one with the highest mean is kept, the full set first so a tie (within
    /// 1e-12) keeps it; past that, with no search, each is attempted where the later attack rolls
    /// on its creature lean melee (`TurnPlan::melee_leaning`). A declined one stays in the turn
    /// with an explicit `of: []`, so it never lands and its id still reads.
    fn optional_choice(
        state: &TurnState,
        eps: f64,
        walk_everything: bool,
    ) -> Result<(TurnState, Arc<TurnPlan>), DiceError> {
        // The plan says which conditions are optional: declared ones and those attached to a
        // source.
        let full = Arc::new(state.plan(eps, FoldMode::Masses)?);
        let optional = &full.optional_ids;
        if state.optional_decided || optional.is_empty() {
            return Ok((state.clone(), full));
        }
        let variant = |attempted: &dyn Fn(&str) -> bool| -> TurnState {
            let mut next = state.clone();
            next.optional_decided = true;
            next.declined = Some(
                optional
                    .iter()
                    .filter(|id| !attempted(id))
                    .cloned()
                    .collect(),
            );
            next
        };
        if optional.len() > MAX_SEARCHED_OPTIONAL {
            let planned = variant(&|id| {
                full.condition_ids
                    .iter()
                    .position(|each| each == id)
                    .and_then(|index| full.melee_leaning.get(index))
                    .copied()
                    .unwrap_or(false)
            });
            let plan = Arc::new(planned.plan(eps, FoldMode::Masses)?);
            return Ok((planned, plan));
        }
        // Each subset is scored as the engine scores it: the sum of the marginal means.
        let mut best: Option<(Turn, f64)> = None;
        for mask in (0..(1u32 << optional.len())).rev() {
            let attempted = |id: &str| {
                optional
                    .iter()
                    .position(|each| each == id)
                    .is_some_and(|index| mask & (1 << index) != 0)
            };
            let turn = Turn::build(variant(&attempted), eps, walk_everything)?;
            let mean = turn.marginal_mean()?;
            if best.as_ref().is_none_or(|(_, kept)| mean > kept + 1e-12) {
                best = Some((turn, mean));
            }
        }
        // INFALLIBLE: the loop runs at least once (the mask range is never empty).
        let (turn, _) = best.ok_or_else(|| internal("no optional subset was scored"))?;
        let plan = turn.plan()?;
        Ok((turn.planned, plan))
    }

    /// An empty turn with the default `eps` ([`EPS`]); add attacks with [`Turn::attacks`].
    pub fn new() -> Result<Turn, DiceError> {
        Turn::with_eps(EPS)
    }

    /// An empty turn pruning probabilities below `eps`.
    pub fn with_eps(eps: f64) -> Result<Turn, DiceError> {
        turn(Vec::new(), eps)
    }

    /// Builds a turn from plain data, `Err(TurnSpecError)` if it is malformed. Use this from a UI,
    /// where `error.code` maps to the field state to show.
    ///
    /// A rider, substitute or condition with no `of` watches every declared attack plus the
    /// attack-shaped `any-miss` / `first-miss` rerolls — for a rider, those listed before it —
    /// the same sources the chaining spelling snapshots.
    pub fn from_spec(spec: TurnSpec, eps: f64) -> Result<Turn, DiceError> {
        Turn::from_spec_inner(spec, eps, false)
    }

    /// [`Turn::from_spec`] with every reader walking the plan, even for a stateless turn (the TS
    /// test seam `walkEverything.forced`).
    pub fn from_spec_walked(spec: TurnSpec, eps: f64) -> Result<Turn, DiceError> {
        Turn::from_spec_inner(spec, eps, true)
    }

    fn from_spec_inner(spec: TurnSpec, eps: f64, walk_everything: bool) -> Result<Turn, DiceError> {
        let riders = spec.riders.unwrap_or_default();
        let substitutes = spec.substitutes.unwrap_or_default();
        let last = if !riders.is_empty() {
            Some((LastKind::Rider, riders.len() - 1))
        } else if !substitutes.is_empty() {
            Some((LastKind::Substitute, substitutes.len() - 1))
        } else {
            None
        };
        Turn::build(
            TurnState {
                attacks: spec.attacks,
                riders,
                substitutes,
                conditions: spec.conditions.unwrap_or_default(),
                observe: spec.observe.unwrap_or_default(),
                state_limit: spec.state_limit,
                optional_decided: false,
                declined: None,
                defaulted: false,
                last,
            },
            eps,
            walk_everything,
        )
    }

    fn with(&self, change: impl FnOnce(&mut TurnState)) -> Result<Turn, DiceError> {
        let mut state = self.state.clone();
        change(&mut state);
        Turn::build(state, self.eps, self.walk_everything)
    }

    /// What a chaining call's omitted `of` means: the attacks so far, plus any reroll so far. With
    /// none yet it stays omitted, so the call fails as having no sources (an explicit `of: []` is
    /// a reader of nothing instead).
    fn default_of(&self) -> Result<Option<Vec<String>>, DiceError> {
        let of: Vec<String> = match &self.rows {
            None => {
                let plan = self.plan()?;
                plan.attack_ids
                    .iter()
                    .chain(plan.reroll_ids.iter())
                    .cloned()
                    .collect()
            }
            Some(rows) => rows.ids.clone(),
        };
        Ok(if of.is_empty() { None } else { Some(of) })
    }

    /// Appends an attack, `Err(TurnSpecError)` if that makes the turn invalid. Declare attacks
    /// before the riders that watch them. A rider added without an `of` watches the attacks
    /// declared *so far*, so appending one after it throws `attack-after-rider` rather than
    /// silently leaving the new attack out. Give that rider an explicit `of` to pin it to the
    /// attacks it already saw.
    pub fn attack(&self, source: impl Into<Source>) -> Result<Turn, DiceError> {
        self.attack_with(source, AttackOptions::default())
    }

    /// [`Turn::attack`] named `id` (`attack(source, "id")`).
    pub fn attack_as(&self, source: impl Into<Source>, id: &str) -> Result<Turn, DiceError> {
        self.attack_with(
            source,
            AttackOptions {
                id: Some(id.to_string()),
                ..AttackOptions::default()
            },
        )
    }

    /// [`Turn::attack`] with options (`id`, `tag`, `chance`, `target`, `after`).
    pub fn attack_with(
        &self,
        source: impl Into<Source>,
        options: AttackOptions,
    ) -> Result<Turn, DiceError> {
        self.refuse_attack_after_rider()?;
        let source = source.into();
        let bare = options.id.is_none()
            && options.tag.is_none()
            && options.chance.is_none()
            && options.target.is_none()
            && options.after.is_none();
        let entry = if bare {
            Attack::Bare(source)
        } else {
            Attack::Declared { options, source }
        };
        self.with(|state| state.attacks.push(entry))
    }

    /// Appends `count` copies of the same attack — the Extra Attack case, which is most of 5e.
    /// `tag` names every copy at once in a later `of`.
    ///
    /// `Err(RangeError)` if `count` is not a positive integer (or is past [`MAX_ATTACK_COUNT`]:
    /// ADR-017).
    pub fn attacks(
        &self,
        count: impl Into<f64>,
        source: impl Into<Source>,
    ) -> Result<Turn, DiceError> {
        self.attacks_with(count, source, AttacksOptions::default())
    }

    /// [`Turn::attacks`] with a `tag` and/or a `chance` on every copy.
    pub fn attacks_with(
        &self,
        count: impl Into<f64>,
        source: impl Into<Source>,
        options: AttacksOptions,
    ) -> Result<Turn, DiceError> {
        let count = count.into();
        let AttacksOptions { tag, chance } = options;
        if !(count.is_finite() && count.trunc() == count) || count < 1.0 {
            return Err(DiceError::Range(format!(
                "attacks(count) needs a positive integer, got {}.",
                num_to_string(count)
            )));
        }
        if count > MAX_ATTACK_COUNT {
            return Err(DiceError::Range(format!(
                "attacks(count) adds at most {} attacks, got {}.",
                num_to_string(MAX_ATTACK_COUNT),
                num_to_string(count)
            )));
        }
        self.refuse_attack_after_rider()?;
        let source = source.into();
        let entry = if tag.is_none() && chance.is_none() {
            Attack::Bare(source)
        } else {
            Attack::Declared {
                options: AttackOptions {
                    tag,
                    chance,
                    ..AttackOptions::default()
                },
                source,
            }
        };
        self.with(|state| {
            for _ in 0..count as usize {
                state.attacks.push(entry.clone());
            }
        })
    }

    fn refuse_attack_after_rider(&self) -> Result<(), DiceError> {
        if !self.state.defaulted {
            return Ok(());
        }
        Err(DiceError::from(TurnSpecError::new(
            TurnSpecErrorCode::AttackAfterRider,
            "",
            "An attack was added after a rider or substitute whose `of` defaulted to the attacks declared before it, so the new attack would be silently left out. Declare attacks first, or give that rider an explicit `of`.",
        )))
    }

    /// Appends a rider, `Err(TurnSpecError)` if that makes the turn invalid. The `on_*` methods
    /// are the readable way to call this.
    ///
    /// An omitted `of` is filled in here, not when the plan is built: the attacks declared so
    /// far, plus any attack-shaped `any-miss` / `first-miss` rider declared so far. Nothing else
    /// joins — not `every-hit` riders, not damage-shaped riders, not a list of several attacks,
    /// not `dice-match` beams (name those explicitly).
    pub fn rider(&self, rider: Rider) -> Result<Turn, DiceError> {
        let defaults = matches!(trigger_of(&rider.trigger), Some(None));
        let mut entry = rider;
        if defaults {
            set_trigger_of(&mut entry.trigger, self.default_of()?);
        }
        let index = self.state.riders.len();
        self.with(|state| {
            state.riders.push(entry);
            state.defaulted = state.defaulted || defaults;
            state.last = Some((LastKind::Rider, index));
        })
    }

    /// Adds what one trigger-verb call describes: its damage as a rider, its grants as a
    /// condition over the same `of`. The gate (`save` / `chance` / `onSave`) applies to the grants
    /// only; the damage lands whatever the save does. With both, `id` names the rider and the
    /// condition takes the default `condition N`.
    fn add_effect(
        &self,
        on: ConditionOn,
        effect: Effect,
        options: EffectOptions,
    ) -> Result<Turn, DiceError> {
        let (effect, options) = match effect {
            Effect::Saved(gated) => {
                let (effects, condition) = unpack_save_options(&gated, options.condition)?;
                (
                    Effect::List(effects.into_iter().map(EffectPart::Grant).collect()),
                    EffectOptions {
                        condition,
                        ..options
                    },
                )
            }
            other => (other, options),
        };
        let EffectOptions {
            condition: condition_options,
            per_source,
            max,
        } = options;
        let gate = condition_options.gate();
        let ConditionOptions {
            rider: rider_options,
            save,
            chance,
            on_save,
            dealing,
            optional,
            happens,
        } = condition_options;
        let (parts, as_list): (Vec<EffectPart>, bool) = match &effect {
            Effect::Damage(RiderDamage::One(d)) => (vec![EffectPart::Damage(d.clone())], false),
            Effect::Damage(RiderDamage::Many(ds)) => {
                (ds.iter().cloned().map(EffectPart::Damage).collect(), true)
            }
            Effect::Lasting(l) => (vec![EffectPart::Grant(l.clone())], false),
            Effect::List(list) => (list.clone(), true),
            // INFALLIBLE: a saved effect was unpacked into a list above.
            Effect::Saved(_) => return Err(internal("a save() value that was not unpacked")),
        };
        let grants: Vec<&Lasting> = parts
            .iter()
            .filter_map(|part| match part {
                EffectPart::Grant(l) => Some(l),
                EffectPart::Damage(_) => None,
            })
            .collect();
        let damage: Vec<DamageSource> = parts
            .iter()
            .filter_map(|part| match part {
                EffectPart::Damage(d) => Some(d.clone()),
                EffectPart::Grant(_) => None,
            })
            .collect();
        let rider_id = rider_options.id.clone().unwrap_or_default();
        if on == ConditionOn::FirstCrit && !damage.is_empty() {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnsupportedTrigger,
                &rider_id,
                "onFirstCrit applies effects; damage on a crit is onAnyCrit.",
            )));
        }
        if grants.is_empty() {
            if save.is_some()
                || chance.is_some()
                || on_save.is_some()
                || dealing.is_some()
                || optional
            {
                return Err(DiceError::Error(
                    "save, chance, onSave, dealing and optional shape effects only, and this call has none: damage is never gated by them. Pass a SaveBuilder as the damage for damage that depends on a save."
                        .to_string(),
                ));
            }
            let ConditionOn::Attack(attack_on) = on else {
                // INFALLIBLE: `first-crit` with damage was refused above, and a call with no
                // grants and no damage reaches here only as `on_first_crit(&[])`, which TS types
                // out; it adds a rider with an empty payload like any other.
                return Err(internal("first-crit with no grants"));
            };
            let trigger = trigger_for(attack_on, rider_options.of.clone(), max, per_source);
            let damage_spec = if as_list {
                RiderDamage::Many(damage)
            } else {
                match damage.into_iter().next() {
                    Some(one) => RiderDamage::One(one),
                    None => RiderDamage::Many(Vec::new()),
                }
            };
            let mut rider = rider_of_options(trigger, damage_spec, rider_options);
            rider.happens = happens;
            return self.rider(rider);
        }
        if max.is_some() || per_source.is_some() {
            return Err(DiceError::Error(
                "max and perSource shape a damage rider, and this call has grants: a grant is never capped and has no payload. Add the damage in its own call."
                    .to_string(),
            ));
        }
        if damage.is_empty() && rider_options.crit_damage.is_some() {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnusedCritDamage,
                &rider_id,
                "A grant deals no damage, so critDamage has nothing to apply to.",
            )));
        }
        if damage.is_empty() && happens.is_some() {
            return Err(DiceError::Error(
                "happens is a damage rider's coin, and this call has no damage; use chance for effects."
                    .to_string(),
            ));
        }
        if damage.is_empty() && rider_options.joins.is_some() {
            return Err(DiceError::Error(
                "joins pools a damage rider's dice into a row, and this call has no damage."
                    .to_string(),
            ));
        }

        let of = match &rider_options.of {
            Some(of) => Some(of.clone()),
            None => self.default_of()?,
        };
        let gated = gate_fields(&gate, self.eps)?;
        let condition = ConditionSpec {
            id: if damage.is_empty() {
                rider_options.id.clone()
            } else {
                None
            },
            on,
            of: of.clone(),
            r#where: rider_options.r#where.clone(),
            chance: gated.chance,
            target_has: gated.target_has,
            landing: gated.landing,
            dealing: gated.dealing,
            target: None,
            save: gated.save,
            grants: grants.iter().map(|grant| effect_spec(grant)).collect(),
            on_save: gated.on_save,
            optional: gated.optional,
        };
        let rider = if damage.is_empty() {
            None
        } else {
            let ConditionOn::Attack(attack_on) = on else {
                return Err(internal("first-crit with damage"));
            };
            let trigger = trigger_for(attack_on, of, None, None);
            let mut rider =
                rider_of_options(trigger, RiderDamage::Many(damage), rider_options.clone());
            rider.happens = happens;
            Some(rider)
        };
        let defaulted = rider_options.of.is_none();
        let index = self.state.riders.len();
        let has_rider = rider.is_some();
        self.with(|state| {
            if let Some(rider) = rider {
                state.riders.push(rider);
            }
            state.conditions.push(condition);
            state.defaulted = state.defaulted || defaulted;
            state.last = if has_rider {
                Some((LastKind::Rider, index))
            } else {
                None
            };
        })
    }

    /// Applies effects on the first crit among `of` only — beside [`Turn::on_any_crit`], which
    /// applies them on every crit. Damage on a crit is `on_any_crit`.
    pub fn on_first_crit(&self, effect: impl Into<Effect>) -> Result<Turn, DiceError> {
        self.on_first_crit_with(effect, ConditionOptions::default())
    }

    /// [`Turn::on_first_crit`] with options.
    pub fn on_first_crit_with(
        &self,
        effect: impl Into<Effect>,
        options: ConditionOptions,
    ) -> Result<Turn, DiceError> {
        self.add_effect(ConditionOn::FirstCrit, effect.into(), options.into())
    }

    /// What a creature already has when the turn starts: `atStart(restrained())`. An effect
    /// without a lifetime lasts the turn. `target` names the creature; omitted, the target.
    #[allow(
        clippy::needless_pass_by_value,
        reason = "public API called by value from rust/dice-node"
    )]
    pub fn at_start(
        &self,
        effects: Vec<StartEffect>,
        target: Option<&str>,
    ) -> Result<Turn, DiceError> {
        let condition = ConditionSpec {
            id: None,
            on: ConditionOn::Start,
            of: None,
            r#where: None,
            chance: None,
            target_has: None,
            landing: None,
            dealing: None,
            target: target.map(str::to_string),
            save: None,
            grants: effects
                .iter()
                .map(|entry| effect_spec(&lasting_for_turn(entry)))
                .collect(),
            on_save: None,
            optional: false,
        };
        self.with(|state| state.conditions.push(condition))
    }

    /// The most distinct turn states the walk may carry; more is `too-many-states`.
    pub fn state_limit(&self, limit: impl Into<f64>) -> Result<Turn, DiceError> {
        let limit = limit.into();
        self.with(|state| state.state_limit = Some(limit))
    }

    /// Fires once, on the first source that lands, in that source's mode — so a crit on the first
    /// landing attack doubles the rider's dice. Sneak Attack. Given a [`Grant`], the first landing
    /// applies it once — a passed save is final for the turn. `perSource` gives a payload that
    /// depends on which attack landed first. For a [`Transform`] see
    /// [`Turn::on_first_hit_transform`].
    pub fn on_first_hit(&self, effect: impl Into<Effect>) -> Result<Turn, DiceError> {
        self.on_first_hit_with(effect, FirstHitOptions::default())
    }

    /// [`Turn::on_first_hit`] with options.
    pub fn on_first_hit_with(
        &self,
        effect: impl Into<Effect>,
        options: FirstHitOptions,
    ) -> Result<Turn, DiceError> {
        self.add_effect(
            ConditionOn::Attack(AttackTriggerOn::FirstHit),
            effect.into(),
            options.into(),
        )
    }

    /// `onFirstHit(transform)`: a once-per-turn substitute: the first watched landing its policy
    /// accepts draws the transformed base payload instead. One call covers every watched attack;
    /// a second over any of the same attacks is `duplicate-substitute`. A substitute allocates no
    /// trigger group. `fireProbability(id)` is P(spent).
    #[allow(
        clippy::needless_pass_by_value,
        reason = "public API called by value from rust/dice-node"
    )]
    pub fn on_first_hit_transform(
        &self,
        effect: Transform,
        options: FirstHitOptions,
    ) -> Result<Turn, DiceError> {
        let rider_options = &options.condition.rider;
        let id = rider_options.id.clone().unwrap_or_default();
        if rider_options.target_has.is_some() {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnsupportedTrigger,
                &id,
                "A transform is a once-per-turn substitute for the attack's own payload, so it takes no \"targetHas\".",
            )));
        }
        let condition = &options.condition;
        if condition.save.is_some() || condition.chance.is_some() || condition.on_save.is_some() {
            return Err(DiceError::Error(
                "save, chance and onSave gate grants only; a transform is not gated by them."
                    .to_string(),
            ));
        }
        if options.per_source.is_some() {
            return Err(DiceError::Error(
                "A transform rewrites the attack's own payload, so it has no payload per source."
                    .to_string(),
            ));
        }
        let ignored = [
            ("happens", condition.happens.is_some()),
            ("dealing", condition.dealing.is_some()),
            ("optional", condition.optional),
            ("where", rider_options.r#where.is_some()),
            ("joins", rider_options.joins.is_some()),
        ]
        .into_iter()
        .find(|(_, set)| *set);
        if let Some((field, _)) = ignored {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnsupportedTrigger,
                &id,
                &format!(
                    "A transform is a once-per-turn substitute for the attack's own payload, so it takes no \"{field}\"."
                ),
            )));
        }
        if rider_options.crit_damage.is_some() {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnusedCritDamage,
                &id,
                "A transform rewrites the attack's own payload, so critDamage has nothing to apply to.",
            )));
        }
        if rider_options.landing.is_some() {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnsupportedTrigger,
                &id,
                "A transform rewrites the attack's own payload, so a landing kind (how a rider reads a save row) has nothing to apply to.",
            )));
        }
        let (kind, policy) = substitute_fields(&effect);
        let of = match &rider_options.of {
            Some(of) => Some(of.clone()),
            None => self.default_of()?,
        };
        let substitute = SubstituteSpec {
            id: rider_options.id.clone(),
            on: SubstituteOn::FirstHit,
            of,
            substitute: kind,
            mode: None,
            policy,
        };
        let defaulted = rider_options.of.is_none();
        let index = self.state.substitutes.len();
        self.with(|state| {
            state.substitutes.push(substitute);
            state.defaulted = state.defaulted || defaulted;
            state.last = Some((LastKind::Substitute, index));
        })
    }

    /// The first watched attack that misses hits instead, once per turn, in turn order: Boon of
    /// Combat Prowess. Any miss converts, a natural 1 included, after the roll's own advantage or
    /// reroll; the converted row is a plain hit (its hit damage, never a crit) and lands every
    /// rider and condition a hit lands. A conversion is a substitute: a second over any of the
    /// same attacks is `duplicate-substitute`, and `fireProbability(id)` is P(converted).
    pub fn convert_first_miss(
        &self,
        id: Option<&str>,
        of: Option<&[&str]>,
    ) -> Result<Turn, DiceError> {
        let of_list = match of {
            Some(of) => Some(names(of)),
            None => self.default_of()?,
        };
        let substitute = SubstituteSpec {
            id: id.map(str::to_string),
            on: SubstituteOn::FirstMiss,
            of: of_list,
            substitute: SubstituteKind::Hit,
            mode: None,
            policy: None,
        };
        let defaulted = of.is_none();
        let index = self.state.substitutes.len();
        self.with(|state| {
            state.substitutes.push(substitute);
            state.defaulted = state.defaulted || defaulted;
            state.last = Some((LastKind::Substitute, index));
        })
    }

    /// The first watched miss is rolled again, once per turn: Heroic Inspiration (`mode: reroll`,
    /// the default: the kept d20 is replaced and the new roll stands) or 2014 Lucky (`add-d20`:
    /// one more d20, the best kept). Call it again to stack: a miss goes to the first unspent
    /// reroll, in call order, and a reroll that still misses is final. A rerolled hit or crit is a
    /// landing for every rider and condition. `fireProbability(id)` is P(spent).
    pub fn reroll_first_miss(
        &self,
        id: Option<&str>,
        of: Option<&[&str]>,
        mode: Option<MissRerollMode>,
    ) -> Result<Turn, DiceError> {
        let of_list = match of {
            Some(of) => Some(names(of)),
            None => self.default_of()?,
        };
        let substitute = SubstituteSpec {
            id: id.map(str::to_string),
            on: SubstituteOn::FirstMiss,
            of: of_list,
            substitute: SubstituteKind::Reroll,
            mode: Some(mode.unwrap_or(MissRerollMode::Reroll)),
            policy: None,
        };
        let defaulted = of.is_none();
        let index = self.state.substitutes.len();
        self.with(|state| {
            state.substitutes.push(substitute);
            state.defaulted = state.defaulted || defaulted;
            state.last = Some((LastKind::Substitute, index));
        })
    }

    /// Fires once if any source crit, always in crit mode. Divine Smite: nothing is lost by
    /// holding it for a crit, so this is "any", not "first". Given a [`Grant`], every crit
    /// applies it.
    pub fn on_any_crit(&self, effect: impl Into<Effect>) -> Result<Turn, DiceError> {
        self.on_any_crit_with(effect, ConditionOptions::default())
    }

    /// [`Turn::on_any_crit`] with options.
    pub fn on_any_crit_with(
        &self,
        effect: impl Into<Effect>,
        options: ConditionOptions,
    ) -> Result<Turn, DiceError> {
        self.add_effect(
            ConditionOn::Attack(AttackTriggerOn::AnyCrit),
            effect.into(),
            options.into(),
        )
    }

    /// Fires once if any source missed. A reroll is a fresh attack, so pass one as the damage.
    ///
    /// Its step runs after every declared attack. That is exact when the reroll is identically
    /// distributed to the attacks after the one it replaces; when it is not, or a later rider
    /// reads the order things landed in, use [`Turn::on_first_miss`].
    pub fn on_any_miss(&self, damage: impl Into<RiderDamage>) -> Result<Turn, DiceError> {
        self.on_any_miss_with(damage, RiderOptions::default())
    }

    /// [`Turn::on_any_miss`] with options.
    pub fn on_any_miss_with(
        &self,
        damage: impl Into<RiderDamage>,
        options: RiderOptions,
    ) -> Result<Turn, DiceError> {
        let trigger = Trigger::AnyMiss {
            of: options.of.clone(),
        };
        self.rider(rider_of_options(trigger, damage.into(), options))
    }

    /// Fires once, on the first source that misses, and resolves directly after that attack — so
    /// a reroll lands in turn order, before the attacks that follow it, and reads the grants in
    /// force at that point. The exact model of "when you miss, you may reroll": Kensei's
    /// Unerring Accuracy, Lucky.
    pub fn on_first_miss(&self, damage: impl Into<RiderDamage>) -> Result<Turn, DiceError> {
        self.on_first_miss_with(damage, RiderOptions::default())
    }

    /// [`Turn::on_first_miss`] with options.
    pub fn on_first_miss_with(
        &self,
        damage: impl Into<RiderDamage>,
        options: RiderOptions,
    ) -> Result<Turn, DiceError> {
        let trigger = Trigger::FirstMiss {
            of: options.of.clone(),
        };
        self.rider(rider_of_options(trigger, damage.into(), options))
    }

    /// Fires once per source that lands, in that hit's mode — so it can fire several times in a
    /// turn. Hunter's Mark, Hex, Rage. `max` caps it: the damage applies to at most `max`
    /// landings among `of`, in turn order, each in its own hit's mode. Given a [`Grant`], every
    /// landing applies it, and a `save` or `chance` is rolled again on each landing until it
    /// takes; `max` and `perSource` are refused, since a grant is never capped.
    ///
    /// `Err(RangeError)` if `max` is not a positive integer.
    pub fn on_every_hit(&self, effect: impl Into<Effect>) -> Result<Turn, DiceError> {
        self.on_every_hit_with(effect, EveryHitOptions::default())
    }

    /// [`Turn::on_every_hit`] with options.
    pub fn on_every_hit_with(
        &self,
        effect: impl Into<Effect>,
        options: EveryHitOptions,
    ) -> Result<Turn, DiceError> {
        self.add_effect(
            ConditionOn::Attack(AttackTriggerOn::EveryHit),
            effect.into(),
            options.into(),
        )
    }

    /// Damage for the turns where the rider added just before this one did *not* fire: "flurry of
    /// blows if I didn't smite". After a transform, it fires when the transform was never spent —
    /// under the default policy, when no watched attack landed.
    ///
    /// Always binds to the *immediately* preceding rider, so the two are branches of one decision
    /// and can never both land. Chaining it therefore alternates rather than laddering.
    pub fn otherwise(&self, damage: impl Into<RiderDamage>) -> Result<Turn, DiceError> {
        self.otherwise_with(damage, RiderOptions::default())
    }

    /// [`Turn::otherwise`] with options.
    pub fn otherwise_with(
        &self,
        damage: impl Into<RiderDamage>,
        options: RiderOptions,
    ) -> Result<Turn, DiceError> {
        let Some((kind, index)) = self.state.last else {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::UnknownId,
                "",
                "otherwise() needs a preceding rider to negate.",
            )));
        };
        // `of` must name the negated node, so give it the id `buildPlan` would.
        let mut riders = self.state.riders.clone();
        let mut substitutes = self.state.substitutes.clone();
        let target = match kind {
            LastKind::Substitute => {
                let previous = substitutes
                    .get_mut(index)
                    .ok_or_else(|| internal("a last substitute that does not exist"))?;
                let target = previous
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("substitute {}", index + 1));
                previous.id = Some(target.clone());
                target
            }
            LastKind::Rider => {
                let previous = riders
                    .get_mut(index)
                    .ok_or_else(|| internal("a last rider that does not exist"))?;
                let target = previous
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("rider {}", index + 1));
                if let Trigger::EveryHit { max, .. } = &previous.trigger
                    && *max != Some(1.0)
                {
                    return Err(DiceError::from(TurnSpecError::new(
                        TurnSpecErrorCode::NotAnAttack,
                        &target,
                        "otherwise() cannot negate an every-hit rider: it can fire more than once. `max: 1` is a first hit and can be negated.",
                    )));
                }
                previous.id = Some(target.clone());
                target
            }
        };
        riders.push(rider_of_options(
            Trigger::NotFired { of: target },
            damage.into(),
            options,
        ));
        let last = riders.len() - 1;
        self.with(|state| {
            state.riders = riders;
            state.substitutes = substitutes;
            state.last = Some((LastKind::Rider, last));
        })
    }

    /// Fires once if any of `of`'s named sources' own damage dice matched (showed a duplicate
    /// value) on hit or crit — Chromatic Orb's bounce. Unlike the other `on_*` triggers, `of` is
    /// required. Each named source must expose a dice-match descriptor (an `AttackBuilder`-shaped
    /// source does); naming one that doesn't is a `TurnSpecError("no-dice-descriptor", ...)`.
    ///
    /// Most callers want [`bounce`] instead of calling this directly.
    pub fn on_dice_match(
        &self,
        of: &[&str],
        damage: impl Into<RiderDamage>,
    ) -> Result<Turn, DiceError> {
        self.on_dice_match_with(of, damage, RiderOptions::default())
    }

    /// [`Turn::on_dice_match`] with options.
    pub fn on_dice_match_with(
        &self,
        of: &[&str],
        damage: impl Into<RiderDamage>,
        options: RiderOptions,
    ) -> Result<Turn, DiceError> {
        let trigger = Trigger::DiceMatch { of: names(of) };
        self.rider(rider_of_options(trigger, damage.into(), options))
    }

    /// Adds a probe: a probability the walk reports without adding any damage, read with
    /// [`Turn::fire_probability`] under `probe.id`. An omitted `of` is filled in here like a
    /// rider's: the attacks declared so far, plus any attack-shaped `any-miss` / `first-miss`
    /// rider declared so far.
    ///
    /// A probe keeps its source set live to the end of the walk, so it counts against
    /// `MAX_TRIGGER_GROUPS` for the whole turn.
    pub fn observe(&self, probe: ProbeSpec) -> Result<Turn, DiceError> {
        let defaults = probe.of.is_none();
        let entry = if defaults {
            ProbeSpec {
                of: self.default_of()?,
                ..probe
            }
        } else {
            probe
        };
        self.with(|state| {
            state.observe.push(entry);
            state.defaulted = state.defaulted || defaults;
        })
    }

    /// P(at least one of `of` crit), reported as `fire_probability(id)`. It comes from the walk
    /// itself, so a `critOnHit` grant, a reroll, a substitute and an attack's `chance` are all
    /// accounted for, and it adds no damage.
    pub fn observe_any_crit(&self, id: &str, of: Option<&[&str]>) -> Result<Turn, DiceError> {
        self.observe(ProbeSpec {
            id: Some(id.to_string()),
            on: ProbeOn::AnyCrit,
            of: of.map(names),
        })
    }

    /// The same turn against a target with armor class `ac`: every attack with an AC — declared,
    /// or carried by a rider (a reroll, a bonus attack) — is rebuilt through `withCheck`. Saves,
    /// attacks with no AC to rebind, and bare PMFs pass through unchanged, so a mixed attack/save
    /// turn still sweeps.
    ///
    /// `Err(TurnSpecError)` `no-rebindable-source` if nothing in the turn has an AC.
    pub fn vs_ac(&self, ac: impl Into<f64>) -> Result<Turn, DiceError> {
        let ac = ac.into();
        if !ac.is_finite() {
            return Err(DiceError::Range(format!(
                "vsAC(ac) needs a finite number, got {}.",
                num_to_string(ac)
            )));
        }
        let mut rebound = 0usize;
        let mut rebind_damage = |damage: &DamageSource| -> Result<DamageSource, DiceError> {
            let DamageSource::Attack(attack) = damage else {
                return Ok(damage.clone());
            };
            if attack
                .check
                .attack_config()
                .and_then(|config| config.ac)
                .is_none()
            {
                return Ok(damage.clone());
            }
            rebound += 1;
            let rebuilt = attack.with_check(|check: Check| Check { ac, ..check })?;
            Ok(DamageSource::Attack(Box::new(rebuilt)))
        };
        let mut rebind = |source: &Source| -> Result<Source, DiceError> {
            match source {
                Source::Damage(damage) => Ok(Source::Damage(rebind_damage(damage)?)),
                Source::Contextual(_) => Ok(source.clone()),
            }
        };
        let mut attacks = Vec::with_capacity(self.state.attacks.len());
        for entry in &self.state.attacks {
            attacks.push(match entry {
                Attack::Bare(source) => Attack::Bare(rebind(source)?),
                Attack::Declared { options, source } => Attack::Declared {
                    options: options.clone(),
                    source: rebind(source)?,
                },
            });
        }
        let mut rebind_all = |damage: &RiderDamage| -> Result<RiderDamage, DiceError> {
            Ok(match damage {
                RiderDamage::One(d) => RiderDamage::One(rebind_damage(d)?),
                RiderDamage::Many(ds) => {
                    let mut out = Vec::with_capacity(ds.len());
                    for d in ds {
                        out.push(rebind_damage(d)?);
                    }
                    RiderDamage::Many(out)
                }
            })
        };
        let mut riders = Vec::with_capacity(self.state.riders.len());
        for rider in &self.state.riders {
            let damage = match &rider.damage {
                RiderDamageSpec::Plain(plain) => RiderDamageSpec::Plain(rebind_all(plain)?),
                // A contextual payload has no `withCheck`: it passes through.
                RiderDamageSpec::Contextual(c) => RiderDamageSpec::Contextual(c.clone()),
            };
            let crit_damage = match &rider.crit_damage {
                None => None,
                Some(crit) => Some(rebind_all(crit)?),
            };
            riders.push(Rider {
                damage,
                crit_damage,
                ..rider.clone()
            });
        }
        if rebound == 0 {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::NoRebindableSource,
                "",
                "vsAC() found nothing with an AC to rebind: every source is a save, an attack that always hits, or a bare PMF.",
            )));
        }
        self.with(|state| {
            state.attacks = attacks;
            state.riders = riders;
        })
    }

    /// The exact joint distribution: mass 1, outcome-labelled. Resolved once and cached.
    ///
    /// There is no `toPMF(eps)` to match the builders: a turn's epsilon is fixed when it is
    /// constructed, because the plan is validated and its sources are resolved at that point.
    pub fn pmf(&self) -> Result<Pmf, DiceError> {
        let plan = self.plan()?;
        if plan.dealing {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::DealingJointUnsupported,
                &plan.condition_ids.join(", "),
                "A condition in this turn needs a damage type dealt (`dealing`): the turn knows only the odds a landing dealt it, so it reads every attack's and rider's marginal and the mean, but not the joint distribution.",
            )));
        }
        Ok((*self.resolve()?).clone())
    }

    /// One play of the turn: the same path the PMF walk sums over, drawn once. Every die is rolled
    /// with `rng.die`; a coin (a chance, a grant save, a source with no dice to roll) with
    /// `rng.chance`. Optional conditions are attempted as the plan decided. See `sample_turn`.
    pub fn sample(&self, rng: &mut dyn Rng) -> Result<Trace, DiceError> {
        let plan = self.sample_plan()?;
        if plan.dealing {
            return Err(DiceError::from(TurnSpecError::new(
                TurnSpecErrorCode::DealingJointUnsupported,
                &plan.condition_ids.join(", "),
                "A condition in this turn needs a damage type dealt (`dealing`): the turn knows only the odds a landing dealt it, so it has no joint to sample.",
            )));
        }
        super::sample::sample_turn_cached(&plan, self.eps, rng, &self.match_cache)
    }

    /// Mean damage for the turn. With a `dealing` condition, the sum of every attack's and
    /// rider's marginal mean (the mean is linear, so it is exact where the joint is not
    /// available).
    pub fn mean(&self) -> Result<f64, DiceError> {
        if self.plan()?.dealing {
            self.marginal_mean()
        } else {
            Ok(self.resolve()?.mean())
        }
    }

    /// The sum of every attack's and rider's marginal mean: the mean, from the reader walk alone.
    fn marginal_mean(&self) -> Result<f64, DiceError> {
        let mut sum = 0.0;
        for id in self.attack_ids()?.into_iter().chain(self.rider_ids()?) {
            sum += self.marginal(&id)?.pmf().mean();
        }
        Ok(sum)
    }

    /// A query whose `singles` are the **declared attacks** and whose combined distribution is the
    /// exact turn PMF.
    ///
    /// Riders are inside the combined PMF, not in `singles`, so singles-based helpers describe the
    /// attacks only. Read rider-inclusive statistics off the combined PMF.
    pub fn to_query(&self) -> Result<DiceQuery, DiceError> {
        let singles: Vec<Pmf> = self
            .plan()?
            .attack_singles
            .iter()
            .map(|p| (**p).clone())
            .collect();
        Ok(DiceQuery::new(singles, Some(self.pmf()?), self.eps))
    }

    /// Attack ids in declaration order, including the `attack 1`, `attack 2`, … defaults given to
    /// bare sources. These are the names `of` accepts.
    pub fn attack_ids(&self) -> Result<Vec<String>, DiceError> {
        match &self.rows {
            None => Ok(self.plan()?.attack_ids.clone()),
            Some(rows) => Ok(rows.ids.clone()),
        }
    }

    /// Rider ids in declaration order, including the `rider 1`, `rider 2`, … defaults. These are
    /// the names [`Turn::fire_probability`] accepts.
    pub fn rider_ids(&self) -> Result<Vec<String>, DiceError> {
        match &self.rows {
            None => Ok(self.plan()?.rider_ids.clone()),
            Some(_) => Ok(Vec::new()),
        }
    }

    /// Substitute ids in declaration order, including the `substitute 1`, … defaults.
    pub fn substitute_ids(&self) -> Result<Vec<String>, DiceError> {
        match &self.rows {
            None => Ok(self.plan()?.substitute_ids.clone()),
            Some(_) => Ok(Vec::new()),
        }
    }

    /// Condition ids in declaration order, including the `condition 1`, … defaults.
    pub fn condition_ids(&self) -> Result<Vec<String>, DiceError> {
        match &self.rows {
            None => Ok(self.plan()?.condition_ids.clone()),
            Some(_) => Ok(Vec::new()),
        }
    }

    /// Probe ids in declaration order, including the `probe 1`, … defaults.
    pub fn probe_ids(&self) -> Result<Vec<String>, DiceError> {
        match &self.rows {
            None => Ok(self.plan()?.probe_ids.clone()),
            Some(_) => Ok(Vec::new()),
        }
    }

    /// The damage one attack, attack-shaped rider or rider deals this turn on its own: its
    /// marginal distribution (a row's own roll in the contexts the turn puts it in, with its
    /// `chance`; a rider's payloads wherever it lands), with the rest of the mass at 0. The means
    /// of every attack's and rider's marginal add up to [`Turn::mean`].
    ///
    /// `Err(TurnSpecError)` `unknown-id` if `id` is not an attack or a rider.
    pub fn marginal(&self, id: &str) -> Result<Arc<Marginal>, DiceError> {
        if let Some(known) = self
            .marginals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
        {
            return Ok(known.clone());
        }
        let row = self.rows.as_ref().and_then(|rows| rows.by_id.get(id));
        if row.is_none() {
            // The id lists are built for the error message only.
            let attack_ids = self.attack_ids()?;
            let rider_ids = self.rider_ids()?;
            if !attack_ids.iter().any(|each| each == id) && !rider_ids.iter().any(|each| each == id)
            {
                return Err(unknown_id(
                    id,
                    &format!(
                        "\"{id}\" is not an attack or rider in this turn. Attacks and riders: {}.",
                        quoted(attack_ids.iter().chain(rider_ids.iter()))
                    ),
                ));
            }
        }
        let result = if let Some(row) = row {
            // No state ever changes the row's context: it rolls its own PMF whenever it happens.
            let mut roll_type = [0.0; 4];
            roll_type[roll_type_index(row.roll_type)] = 1.0;
            Marginal::Attack(AttackMarginal {
                pmf: thinned(&row.pmf, row.chance),
                when_happens: row.pmf.clone(),
                occurs: row.chance,
                roll_type,
            })
        } else {
            let readers = self.resolve_readers()?;
            let plan = self.walk_plan()?;
            let rows: Vec<usize> = plan
                .steps
                .iter()
                .enumerate()
                .filter(|(_, step)| step.id == id && !step.context_pmfs.is_empty())
                .map(|(s, _)| s)
                .collect();
            if rows.is_empty() {
                Marginal::Rider(Box::new(self.rider_marginal(id, &readers)?))
            } else {
                Marginal::Attack(self.row_marginal(id, &rows, &readers)?)
            }
        };
        let result = Arc::new(result);
        self.marginals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id.to_string(), result.clone());
        Ok(result)
    }

    /// A row's marginal from the reader walk: the mass of each context it rolls in times that
    /// context's PMF. A row a substitute rewrites is not its contexts' PMFs, so its own damage is
    /// walked instead.
    fn row_marginal(
        &self,
        id: &str,
        rows: &[usize],
        readers: &Readers,
    ) -> Result<AttackMarginal, DiceError> {
        let tally = &readers.tally;
        let total = readers.total;
        let plan = self.walk_plan()?;
        let steps = &plan.steps;
        let mut rolled = 0.0;
        let mut happened = 0.0;
        let mut roll_type = [0.0; 4];
        let mut contexts: Vec<(Arc<Pmf>, f64)> = Vec::new();
        for &s in rows {
            happened += tally.happened[s];
            for (cell, counted) in roll_type.iter_mut().zip(&tally.roll_types[s]) {
                *cell += counted / total;
            }
            for (context, pmf) in steps[s].context_pmfs.built() {
                let mass = tally.context_mass[s].get(context).copied().unwrap_or(0.0);
                if mass <= 0.0 {
                    continue;
                }
                rolled += mass;
                contexts.push((pmf, mass));
            }
        }
        let occurs = js_min(1.0, happened / total);
        let eps = self.eps;
        if rows
            .iter()
            .any(|&s| steps[s].converts || !steps[s].rerolls.is_empty())
        {
            // A converted miss draws the row's hit: its marginal is what its draws dealt, read
            // off the reader walk.
            let mut parts: Vec<(Pmf, f64)> = Vec::new();
            for &s in rows {
                for (own, mass) in tally.own_draws[s].values() {
                    parts.push((own.scale_mass(1.0 / own.mass()), *mass));
                }
            }
            let drawn: f64 = parts.iter().fold(0.0, |sum, (_, mass)| sum + mass);
            if drawn <= 0.0 {
                return Ok(AttackMarginal {
                    pmf: Arc::new(Pmf::miss_none(eps)),
                    when_happens: Arc::new(Pmf::delta(0.0, eps)?),
                    occurs,
                    roll_type,
                });
            }
            let when_happens = Arc::new(if parts.len() == 1 {
                parts.swap_remove(0).0
            } else {
                let weighted: Vec<(Pmf, f64)> = parts
                    .into_iter()
                    .map(|(pmf, mass)| (pmf, mass / drawn))
                    .collect();
                Pmf::mix(&weighted, 0.0)?
            });
            return Ok(AttackMarginal {
                pmf: thinned(&when_happens, occurs),
                when_happens,
                occurs,
                roll_type,
            });
        }
        if rows.iter().any(|&s| steps[s].transformed) {
            let pmf = self.projected_marginal(id)?;
            let when_happens = if occurs > 0.0 {
                unthinned(&pmf, occurs)
            } else {
                Pmf::delta(0.0, eps)?
            };
            return Ok(AttackMarginal {
                pmf: Arc::new(pmf),
                when_happens: Arc::new(when_happens),
                occurs,
                roll_type,
            });
        }
        let when_happens = match contexts.len() {
            0 => Arc::new(Pmf::delta(0.0, eps)?),
            1 => contexts[0].0.clone(),
            _ => {
                let weighted: Vec<(Pmf, f64)> = contexts
                    .iter()
                    .map(|(pmf, mass)| ((**pmf).clone(), mass / rolled))
                    .collect();
                Arc::new(Pmf::mix(&weighted, 0.0)?)
            }
        };
        let pmf = if contexts.is_empty() {
            Arc::new(Pmf::miss_none(eps))
        } else {
            thinned(&when_happens, occurs)
        };
        Ok(AttackMarginal {
            pmf,
            when_happens,
            occurs,
            roll_type,
        })
    }

    /// A damage rider's marginal from the reader walk: a capped rider's carried damage, or the
    /// mass of each payload a rider that lands once lands with; the rest of the mass at 0.
    fn rider_marginal(&self, id: &str, readers: &Readers) -> Result<RiderMarginal, DiceError> {
        let tally = &readers.tally;
        let total = readers.total;
        let plan = self.walk_plan()?;
        let coin = plan.coins.iter().find(|each| each.id == id);
        // A rider whose coin did not come up lands but carries no payload: its landings are
        // counted on the coin's side alone, and the coin is independent of them.
        let per_landing = match coin {
            None => total,
            Some(coin) => total * coin.happens,
        };
        // Every attack the rider watches, in declaration order, as the engine books it: one it
        // never lands on has zeros.
        let booked = tally.landings.get(id);
        let mut landings: IndexMap<String, RowLanding> = IndexMap::new();
        if let Some(rows) = plan.rider_rows.get(id) {
            for row in rows {
                let landing = booked
                    .and_then(|booked| booked.get(row))
                    .copied()
                    .unwrap_or_default();
                landings.insert(
                    row.clone(),
                    RowLanding {
                        hit: landing.hit / per_landing,
                        crit: landing.crit / per_landing,
                        doubled: super::readers::DoubledLanding {
                            hit: landing.doubled.hit / per_landing,
                            crit: landing.doubled.crit / per_landing,
                        },
                    },
                );
            }
        }
        let any_landing = readers.fire_mass.get(id).copied().unwrap_or(0.0) / total;
        let capped = plan.every_hit_ids.iter().position(|each| each == id);
        let eps = self.eps;
        let pmf = match capped {
            Some(_) if readers.unexact.contains(id) => self.projected_marginal(id)?,
            Some(capped) => capped_pmf(&readers.states, capped, total),
            None => {
                let mut weights: Vec<(Pmf, f64)> = tally
                    .once_weights
                    .get(id)
                    .map(|weights| {
                        weights
                            .values()
                            .map(|(payload, mass)| ((**payload).clone(), mass / total))
                            .collect()
                    })
                    .unwrap_or_default();
                let landed = weights.iter().fold(0.0, |sum, (_, weight)| sum + weight);
                weights.push((Pmf::miss_none(eps), js_max(0.0, 1.0 - landed)));
                Pmf::mix(&weights, 0.0)?
            }
        };
        Ok(RiderMarginal {
            pmf,
            landings,
            any_landing,
        })
    }

    /// `id`'s marginal by a walk that carries its damage alone: for what the reader walk cannot
    /// read.
    fn projected_marginal(&self, id: &str) -> Result<Pmf, DiceError> {
        let plan = self.walk_plan()?;
        let mut ledger = MarginalLedger { id, eps: self.eps };
        let walked = walk(&mut ledger, &plan, self.eps, None)?;
        let mut total = Pmf::empty_mass();
        for state in walked.states.values() {
            total = total.add(&state.damage);
        }
        Ok(if needs_normalizing(total.mass(), self.eps) {
            total.normalize()
        } else {
            total
        })
    }

    /// The reader walk: one walk carrying mass (and each capped rider's damage as a plain array)
    /// that tallies every marginal reader. Cached, like the other walks.
    fn resolve_readers(&self) -> Result<Arc<Readers>, DiceError> {
        self.readers.get_or_try(|| {
            let plan = self.walk_plan()?;
            let mut ledger = ReaderLedger::new(&plan.every_hit_ids);
            let mut tally = ReaderTally::new(
                &plan.steps,
                plan.every_hit_ids.iter().cloned().collect(),
                plan.per_hit_any.clone(),
                None,
            );
            let walked = walk(&mut ledger, &plan, self.eps, Some(&mut tally))?;
            let mut mass = 0.0;
            for state in walked.states.values() {
                mass += state.damage.mass;
            }
            let total = if needs_normalizing(mass, self.eps) {
                mass
            } else {
                1.0
            };
            let mut fire_mass = tally_fire_mass(&walked.states, &ledger, &plan);
            let mut applications: IndexMap<String, f64> = IndexMap::new();
            for (rider, id) in plan.every_hit_ids.iter().enumerate() {
                applications.insert(
                    id.clone(),
                    walked.application_mass.get(rider).copied().unwrap_or(0.0),
                );
            }
            if total != 1.0 {
                for each in fire_mass.values_mut() {
                    *each /= total;
                }
                for each in applications.values_mut() {
                    *each /= total;
                }
            }
            let step_stats = step_stats_of(&plan, &walked, total);
            let peak_states = walked
                .state_counts
                .iter()
                .copied()
                .max()
                .unwrap_or(0)
                .max(1);
            let unexact = std::mem::take(&mut ledger.unexact);
            // Resolve every state's carries now (the TS does it on first read; the mix is the
            // same either way).
            let mut states: Vec<ReaderDamage> = Vec::with_capacity(walked.states.len());
            for (_, state) in walked.states {
                let mut damage = state.damage;
                carries_of(&mut damage);
                states.push(damage);
            }
            Ok(Readers {
                tally,
                states,
                total,
                fire_mass,
                applications,
                step_stats,
                unexact,
                peak_states,
            })
        })
    }

    /// P(this rider fired). For an `every-hit` rider, capped or not, it is P(at least one source
    /// hit): the first landing always applies it, since a cap is at least 1. It can fire more than
    /// once in a turn; [`Turn::expected_applications`] counts how often. For a substitute it is
    /// P(it was spent). For a condition it is P(its grants were applied at least once where a
    /// later attack roll reads them) — on the fail branch of its save, not the `onSave` one. For a
    /// probe it is the probability the probe reports: `any-crit` is P(at least one source crit).
    ///
    /// Read from a walk that carries no damage distribution, only masses; it agrees with the
    /// joint `pmf` walk to rounding (≤ 1e-12 relative). With a pruning `eps` above 0 the masses
    /// ignore the pruned damage bins.
    ///
    /// `Err(TurnSpecError)` `unknown-id` if `id` is not a rider, substitute, condition or probe
    /// (attack ids included, since attacks always happen and have no firing probability).
    pub fn fire_probability(&self, id: &str) -> Result<f64, DiceError> {
        // A stateless turn has nothing that fires.
        let mass = if self.rows.is_some() {
            None
        } else if self.plan()?.probes.contains_key(id) {
            self.resolve_masses()?.get(id).copied()
        } else {
            self.resolve_readers()?.fire_mass.get(id).copied()
        };
        mass.ok_or_else(|| {
            let ids: Vec<String> = [
                self.rider_ids(),
                self.substitute_ids(),
                self.condition_ids(),
                self.probe_ids(),
            ]
            .into_iter()
            .flat_map(std::result::Result::unwrap_or_default)
            .collect();
            unknown_id(
                id,
                &format!(
                    "\"{id}\" is not a rider, substitute, condition or probe in this turn. Riders: {}.",
                    quoted(ids)
                ),
            )
        })
    }

    /// The expected number of times a damage rider applies in a turn: for an uncapped `every-hit`
    /// rider, the expected number of landings among its sources; for `max: n`, the expected number
    /// of the first `n`. Every other rider applies at most once, so its answer is its
    /// `fire_probability`. Substitutes and conditions are not damage riders.
    ///
    /// `Err(TurnSpecError)` `unknown-id` if `id` is not a rider.
    pub fn expected_applications(&self, id: &str) -> Result<f64, DiceError> {
        let mass = if self.rows.is_some() {
            None
        } else {
            self.walked_applications(id)?
        };
        mass.ok_or_else(|| {
            unknown_id(
                id,
                &format!(
                    "\"{id}\" is not a rider in this turn. Riders: {}.",
                    quoted(self.rider_ids().unwrap_or_default())
                ),
            )
        })
    }

    /// The expected applications of `id` from the reader walk, or `None` for an id that is no
    /// rider.
    fn walked_applications(&self, id: &str) -> Result<Option<f64>, DiceError> {
        let readers = self.resolve_readers()?;
        if let Some(known) = readers.applications.get(id) {
            return Ok(Some(*known));
        }
        Ok(if self.plan()?.rider_ids.iter().any(|each| each == id) {
            readers.fire_mass.get(id).copied()
        } else {
            None
        })
    }

    /// Per-step statistics for one declared attack or attack-shaped rider: P(landed, crit
    /// included), P(crit), and the mass in which each granted modifier was in force when it read
    /// its flags. `rolled` is 1 for a declared attack and the rider's fire mass for an
    /// attack-shaped rider.
    ///
    /// `Err(TurnSpecError)` `unknown-id` if `id` is not a declared attack or an attack-shaped
    /// rider — a damage-shaped rider, substitute, condition or unknown id included, since only
    /// those roll their own attack and have hit/crit odds.
    pub fn step_stats(&self, id: &str) -> Result<StepStats, DiceError> {
        let unknown = |attacks: Vec<String>| {
            unknown_id(
                id,
                &format!(
                    "\"{id}\" is not an attack or attack-shaped rider in this turn. Attacks: {}.",
                    quoted(attacks)
                ),
            )
        };
        if let Some(rows) = &self.rows {
            let Some(row) = rows.by_id.get(id) else {
                return Err(unknown(rows.ids.clone()));
            };
            // Nothing is ever in force, nothing is tried; the row draws in every state (`rolled`
            // 1) and lands where it happens.
            return Ok(StepStats {
                rolled: 1.0,
                hit: row.chance * row.hit,
                crit: row.chance * row.crit,
                live: LiveOdds::none(),
                conditions: Vec::new(),
            });
        }
        let readers = self.resolve_readers()?;
        let Some(stats) = readers.step_stats.get(id) else {
            return Err(unknown(readers.step_stats.keys().cloned().collect()));
        };
        let tally = &readers.tally;
        let total = readers.total;
        // All of it from the reader walk: no damage arithmetic. The 0.16 fields agree with the
        // joint walk's to rounding.
        let plan = self.walk_plan()?;
        let rows: Vec<usize> = plan
            .steps
            .iter()
            .enumerate()
            .filter(|(_, step)| step.id == id && !step.variants.is_empty())
            .map(|(s, _)| s)
            .collect();
        let mut live = LiveOdds::none();
        for (e, _) in EFFECT_NAMES.iter().enumerate() {
            live.odds[e] = rows.iter().fold(0.0, |sum, &s| sum + tally.effects[s][e]) / total;
            let mut by_source: IndexMap<usize, f64> = IndexMap::new();
            for &s in &rows {
                for (source, masses) in &tally.effect_sources[s] {
                    if masses[e] > 0.0 {
                        *by_source.entry(*source).or_insert(0.0) += masses[e];
                    }
                }
            }
            let mut sorted: Vec<(usize, f64)> = by_source.into_iter().collect();
            sorted.sort_by_key(|(a, _)| *a);
            live.sources[e] = sorted
                .into_iter()
                .filter_map(|(source, mass)| {
                    plan.effect_sources.get(source).map(|source| SourceOdds {
                        source: source.clone(),
                        odds: mass / total,
                    })
                })
                .collect();
        }
        // `{ ...odds, ...stats.live, sources }`: the walk's own counts win for these three.
        live.odds[EffectName::Advantage.index()] = stats.advantage;
        live.odds[EffectName::Disadvantage.index()] = stats.disadvantage;
        live.odds[EffectName::CritOnHit.index()] = stats.crit_on_hit;
        let mut conditions: IndexMap<usize, Attempt> = IndexMap::new();
        for &s in &rows {
            for (c, attempt) in &tally.attempts[s] {
                let known = conditions.entry(*c).or_default();
                known.attempted += attempt.attempted;
                known.taken += attempt.taken;
            }
        }
        Ok(StepStats {
            rolled: stats.rolled,
            hit: stats.hit,
            crit: stats.crit,
            live,
            conditions: conditions
                .into_iter()
                .filter_map(|(c, Attempt { attempted, taken })| {
                    plan.condition_ids.get(c).map(|id| ConditionAttempt {
                        id: id.clone(),
                        attempted: attempted / total,
                        taken: taken / total,
                    })
                })
                .collect(),
        })
    }

    /// The expected number of times condition `id` is attempted this turn (for a `first-*`
    /// condition, the odds it is): each landing it watches that finds it not already spent or in
    /// force. 0 for a `start` condition, which is never tried.
    ///
    /// `Err(TurnSpecError)` `unknown-id` if `id` is not a condition.
    pub fn attempt_probability(&self, id: &str) -> Result<f64, DiceError> {
        let ids = self.condition_ids()?;
        let Some(c) = ids.iter().position(|each| each == id) else {
            return Err(unknown_id(
                id,
                &format!(
                    "\"{id}\" is not a condition in this turn. Conditions: {}.",
                    quoted(&ids)
                ),
            ));
        };
        let readers = self.resolve_readers()?;
        let sum = readers.tally.attempts.iter().fold(0.0, |sum, attempts| {
            sum + attempts.get(&c).map_or(0.0, |a| a.attempted)
        });
        Ok(sum / readers.total)
    }

    /// The ways riders land on attack `id`: per outcome label (`hit`, `crit`, `saveFail`, …),
    /// whether the attack's own roll dealt damage, and the riders that landed with it, with its
    /// odds.
    ///
    /// `Err(TurnSpecError)` `unknown-id` if `id` is not an attack.
    pub fn landings(&self, id: &str) -> Result<Vec<LandingPattern>, DiceError> {
        let attack_ids = self.attack_ids()?;
        if !attack_ids.iter().any(|each| each == id) {
            return Err(unknown_id(
                id,
                &format!(
                    "\"{id}\" is not an attack in this turn. Attacks: {}.",
                    quoted(&attack_ids)
                ),
            ));
        }
        let patterns = self
            .patterns
            .get_or_try(|| -> Result<Patterns, DiceError> {
                // Patterns cost a little on every landing, so only this reader tallies them, on a walk
                // of its own. A rider's landing does not depend on its `happens`, so the walk takes
                // every rider as happening: a coin that did not come up would hide where the rider
                // landed.
                let walk_plan = self.walk_plan()?;
                let plan: Arc<TurnPlan> = if walk_plan.coins.is_empty() {
                    walk_plan
                } else {
                    let mut state = self.planned.clone();
                    state.observe = Vec::new();
                    for rider in &mut state.riders {
                        rider.happens = None;
                    }
                    Arc::new(state.plan(self.eps, FoldMode::Masses)?)
                };
                let order: IndexMap<String, usize> = plan
                    .rider_ids
                    .iter()
                    .enumerate()
                    .map(|(index, id)| (id.clone(), index))
                    .collect();
                let mut tally = ReaderTally::new(
                    &plan.steps,
                    plan.every_hit_ids.iter().cloned().collect(),
                    plan.per_hit_any.clone(),
                    Some(order),
                );
                walk(&mut MassLedger, &plan, self.eps, Some(&mut tally))?;
                Ok(tally.patterns)
            })?;
        let total = self.resolve_readers()?.total;
        Ok(patterns
            .get(id)
            .map(|rows| {
                rows.values()
                    .map(|pattern| LandingPattern {
                        mass: pattern.mass / total,
                        ..pattern.clone()
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The most states the walk held after any step: 1 for a turn that needs no state.
    pub fn peak_states(&self) -> Result<usize, DiceError> {
        match &self.rows {
            None => Ok(self.resolve_readers()?.peak_states),
            Some(_) => Ok(1),
        }
    }

    /// The joint walk: the only one that carries a damage PMF in every state, read by `pmf` (and
    /// `mean`, `to_query`) alone. Every other reader comes from the mass walks.
    fn resolve(&self) -> Result<Arc<Pmf>, DiceError> {
        self.resolved.get_or_try(|| {
            // The damage walks a plan without the probes, so a probe's group never splits its
            // states: what `pmf` reports is what the turn without probes reports. Its draws carry
            // their riders' payloads convolved in; the plan the mass walks read does not, so it is
            // built here, once.
            let mut state = self.planned.clone();
            state.observe = Vec::new();
            let plan = state.plan(self.eps, FoldMode::Joint)?;
            let eps = self.eps;
            let walked = walk(&mut PmfLedger { eps }, &plan, eps, None)?;
            *self
                .state_counts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(walked.state_counts.clone());
            let mut total: Option<DenseTotal> = None;
            for (_, state) in walked.states {
                total = Some(match total {
                    Some(sum) => sum.add(&state.damage),
                    None => state.damage,
                });
            }
            let pmf = match total {
                None => Pmf::delta(0.0, eps)?,
                Some(total) => total.to_pmf(),
            };
            Ok(if needs_normalizing(pmf.mass(), eps) {
                pmf.normalize()
            } else {
                pmf
            })
        })
    }

    /// The firing masses, from a walk that carries only mass in place of a damage PMF: the same
    /// states and transitions as [`Turn::resolve`], none of its convolutions. What
    /// [`Turn::fire_probability`] reads for a probe.
    fn resolve_masses(&self) -> Result<Arc<IndexMap<String, f64>>, DiceError> {
        self.massed.get_or_try(|| {
            let plan = self.plan()?;
            let walked = walk(&mut MassLedger, &plan, self.eps, None)?;
            let mut fire_mass = tally_fire_mass(&walked.states, &MassLedger, &plan);
            let mut total_mass = 0.0;
            for state in walked.states.values() {
                total_mass += state.damage;
            }
            if needs_normalizing(total_mass, self.eps) {
                for mass in fire_mass.values_mut() {
                    *mass /= total_mass;
                }
            }
            Ok(fire_mass)
        })
    }

    /// Test seam: the spec this turn's chaining calls have written so far (what `buildPlan` is
    /// called with before optional conditions are decided). Not part of the package API.
    pub fn inspect_spec(&self) -> TurnSpec {
        self.state.spec()
    }

    /// Test seam: the spec the plan is built from (optional conditions decided; `declined` names
    /// the optional conditions the turn does not attempt).
    pub fn inspect_planned_spec(&self) -> (TurnSpec, Vec<String>) {
        (
            self.planned.spec(),
            self.planned.declined.clone().unwrap_or_default(),
        )
    }

    /// Test seam: the plan this turn walks (built on first use for a stateless turn). Not part of
    /// the package API.
    pub fn inspect_plan(&self) -> Result<Arc<TurnPlan>, DiceError> {
        self.plan()
    }

    /// Test seam: the plan `sample` walks, built if it has not been.
    pub fn inspect_sample_plan(&self) -> Result<Arc<TurnPlan>, DiceError> {
        self.sample_plan()
    }

    /// The number of trigger groups this turn tracks and, per step, the number of distinct walk
    /// states after it. Resolves the turn if it has not been resolved yet. A stateless turn has
    /// no walk: its counts are empty.
    pub fn inspect_turn(&self) -> Result<(usize, Vec<usize>), DiceError> {
        self.mean()?;
        let counts = self
            .state_counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or_default();
        Ok((self.plan()?.group_count, counts))
    }
}

/// Starts a [`Turn`] from a list of attacks and an `eps` ([`Turn::new`] starts an empty one):
///
/// ```ignore
/// turn(vec![dagger.clone().into(), dagger.into()], 0.0)?.on_first_hit(roll(3, d6())?)?;
/// ```
pub fn turn(attacks: Vec<Attack>, eps: f64) -> Result<Turn, DiceError> {
    Turn::from_spec(
        TurnSpec {
            attacks,
            ..TurnSpec::default()
        },
        eps,
    )
}

/// `bounce({ source, max })` — sugar for a depth-capped chain of attack-shaped `dice-match` riders,
/// so no caller hand-writes the chain by hand: beam 1 is `source` itself as the turn's only
/// declared attack; beam `i + 1` (for `i = 1..max`) is `source` again, as a rider fired only when
/// beam `i`'s own dice matched. Every beam shares `source`'s exact profile.
///
/// `max` is required and MUST be a non-negative integer (`Err(RangeError)` otherwise, and past
/// [`MAX_BOUNCE`]: ADR-017).
#[allow(
    clippy::needless_pass_by_value,
    reason = "public API called by value from rust/dice-node"
)]
pub fn bounce(source: DamageSource, max: impl Into<f64>) -> Result<Turn, DiceError> {
    let max = max.into();
    if !(max.is_finite() && max.trunc() == max) || max < 0.0 {
        return Err(DiceError::Range(format!(
            "bounce({{ max }}) needs a non-negative integer, got {}.",
            num_to_string(max)
        )));
    }
    if max > MAX_BOUNCE {
        return Err(DiceError::Range(format!(
            "bounce({{ max }}) is at most {}, got {}.",
            num_to_string(MAX_BOUNCE),
            num_to_string(max)
        )));
    }
    let mut result = turn(vec![Attack::Bare(Source::Damage(source.clone()))], 0.0)?;
    let mut previous_id = result
        .attack_ids()?
        .into_iter()
        .next()
        .ok_or_else(|| internal("a bounce with no first attack"))?;
    for i in 0..max as usize {
        let rider_id = format!("bounce {}", i + 1);
        result = result.on_dice_match_with(
            &[previous_id.as_str()],
            RiderDamage::One(source.clone()),
            RiderOptions {
                id: Some(rider_id.clone()),
                ..RiderOptions::default()
            },
        )?;
        previous_id = rider_id;
    }
    Ok(result)
}
