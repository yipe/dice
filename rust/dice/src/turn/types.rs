//! Port of `src/turn/types.ts`: the plain-data turn contract (`TurnSpec` and what it holds), the
//! sources a turn rolls ([`DamageSource`], [`Source`], [`ContextualSource`]) and [`TurnSpecError`].
//!
//! # Shape
//! - TS unions of string literals are enums with an `as_str` giving the TS string; optional fields
//!   (`x?:`) are `Option`s, and a `true`-only flag (`advantage?: true`) is a `bool` (false = absent).
//! - `Damage = PMF | ToPMF` is [`DamageSource`]: the four library types plus [`DamageSource::Other`]
//!   for any hand-written [`ToPmf`]. (Named apart from [`crate::Damage`], the PMF's damage key.)
//! - A [`Source`] is damage, or a hand-written [`ContextualSource`]. A `RowCheck`-bearing
//!   `AttackBuilder`/`SaveBuilder` is a [`Source::Damage`] whose [`DamageSource`] is contextual:
//!   [`Source::as_contextual`] is the one place that says so, and the four shape probes of
//!   `context.ts` (`rowCheckOf`, `isContextual`, `hasRerolledUnder`, `IGNORES_JOINED`) are written
//!   on it in `context.rs`.
//! - Functions as arguments (`GrantSaveSpec.failChance`, the methods of `ContextualSource` and
//!   `ContextualPayload`) are closures or trait objects, `Send + Sync`. A TS method that may be
//!   absent (`rerolledUnder?`) is a `has_*` method with a default of `false` beside the method.
//! - `string | readonly string[]` option fields (`of`, `targetHas`, ...) are always `Vec<String>`:
//!   a lone name is a list of one. `Trigger::AnyCrit` carries `max` (TS: only the `Rider` form of
//!   `any-crit` has it). `grants: Lasting | readonly Lasting[]` is always a list.
//! - Errors other than [`TurnSpecError`] (`RangeError`, `TypeError`, `Error`) are `Err(message)`.

pub use super::context::{
    ContextualSource, Dealt, PenaltyDice, RollUnder, RowCheck, RowContext, RowKind, RowRange,
};
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::roll::RollBuilder;
use crate::builder::save::SaveBuilder;
use crate::builder::types::MissRerollMode;
use crate::common::RollType;
use crate::error::DiceError;
use indexmap::IndexMap;
use std::fmt;
use std::sync::Arc;

/// `CONTRACT_REVISION`: the version of the plain-data `TurnSpec` v2 contract.
pub const CONTRACT_REVISION: u32 = 6;

/// `MAX_TRIGGER_GROUPS`: how many distinct `of` sets a single turn may keep live at once.
pub const MAX_TRIGGER_GROUPS: usize = 9;

/// `MAX_CAPPED_COUNTERS`: how many capped `every-hit` riders may watch one attack, counting riders
/// that share their sources and their `max` once.
pub const MAX_CAPPED_COUNTERS: usize = 6;

/// `AttackTriggerOn`: the triggers that read the outcomes of source attacks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackTriggerOn {
    FirstHit,
    AnyCrit,
    AnyMiss,
    FirstMiss,
    EveryHit,
}

impl AttackTriggerOn {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            AttackTriggerOn::FirstHit => "first-hit",
            AttackTriggerOn::AnyCrit => "any-crit",
            AttackTriggerOn::AnyMiss => "any-miss",
            AttackTriggerOn::FirstMiss => "first-miss",
            AttackTriggerOn::EveryHit => "every-hit",
        }
    }
}

/// `SaveLanding`: how a rider reads a save row among its sources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveLanding {
    /// A failed save lands, whatever damage it dealt.
    Fail,
    /// A failed save that dealt damage lands, and so does a success that dealt some.
    Damage,
}

impl SaveLanding {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            SaveLanding::Fail => "fail",
            SaveLanding::Damage => "damage",
        }
    }
}

/// `Rider.landing`: `SaveLanding | "any"` (lands whatever the source's outcome, a miss included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiderLanding {
    Save(SaveLanding),
    Any,
}

/// `PerSource`: source id -> the payload dealt when that source lands, in key order.
pub type PerSource = IndexMap<String, RiderPayload>;

/// `Trigger`: when a rider fires (see the TS doc for each).
#[derive(Clone, Debug)]
pub enum Trigger {
    FirstHit {
        of: Option<Vec<String>>,
        per_source: Option<PerSource>,
    },
    /// `max` is read only where this trigger is a [`Rider`]'s (TS: `{ on: "any-crit"; max? }`).
    AnyCrit {
        of: Option<Vec<String>>,
        max: Option<f64>,
    },
    AnyMiss {
        of: Option<Vec<String>>,
    },
    FirstMiss {
        of: Option<Vec<String>>,
    },
    EveryHit {
        of: Option<Vec<String>>,
        max: Option<f64>,
        per_source: Option<PerSource>,
    },
    /// `of` is the one rider (or substitute) id being negated.
    NotFired {
        of: String,
    },
    /// `of` is required.
    DiceMatch {
        of: Vec<String>,
    },
}

impl Trigger {
    /// The TS `on` string.
    pub fn on(&self) -> &'static str {
        match self {
            Trigger::FirstHit { .. } => "first-hit",
            Trigger::AnyCrit { .. } => "any-crit",
            Trigger::AnyMiss { .. } => "any-miss",
            Trigger::FirstMiss { .. } => "first-miss",
            Trigger::EveryHit { .. } => "every-hit",
            Trigger::NotFired { .. } => "not-fired",
            Trigger::DiceMatch { .. } => "dice-match",
        }
    }
}

/// `ToPMF`: anything that can produce a PMF at `eps`.
pub trait ToPmf: Send + Sync {
    fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError>;
}

impl ToPmf for Pmf {
    fn to_pmf(&self, _eps: f64) -> Result<Pmf, DiceError> {
        Ok(self.clone())
    }
}

impl ToPmf for RollBuilder {
    fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        RollBuilder::to_pmf(self, eps)
    }
}

impl ToPmf for AttackBuilder {
    fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        AttackBuilder::to_pmf(self, eps)
    }
}

impl ToPmf for SaveBuilder {
    fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        SaveBuilder::to_pmf(self, eps)
    }
}

/// `Damage`: rider or attack damage, `PMF | ToPMF`.
#[derive(Clone)]
pub enum DamageSource {
    Pmf(Arc<Pmf>),
    Roll(RollBuilder),
    Attack(Box<AttackBuilder>),
    Save(Box<SaveBuilder>),
    /// Any other `{ toPMF }`.
    Other(Arc<dyn ToPmf>),
}

impl fmt::Debug for DamageSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DamageSource::Pmf(p) => f.debug_tuple("Pmf").field(p).finish(),
            DamageSource::Roll(r) => f.debug_tuple("Roll").field(r).finish(),
            DamageSource::Attack(a) => f.debug_tuple("Attack").field(a).finish(),
            DamageSource::Save(s) => f.debug_tuple("Save").field(s).finish(),
            DamageSource::Other(_) => f.write_str("Other(..)"),
        }
    }
}

impl DamageSource {
    /// `source.toPMF(eps)`.
    pub fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        match self {
            DamageSource::Pmf(p) => Ok((**p).clone()),
            DamageSource::Roll(r) => r.to_pmf(eps),
            DamageSource::Attack(a) => a.to_pmf(eps),
            DamageSource::Save(s) => s.to_pmf(eps),
            DamageSource::Other(o) => o.to_pmf(eps),
        }
    }
}

impl From<Pmf> for DamageSource {
    fn from(p: Pmf) -> Self {
        DamageSource::Pmf(Arc::new(p))
    }
}

impl From<RollBuilder> for DamageSource {
    fn from(r: RollBuilder) -> Self {
        DamageSource::Roll(r)
    }
}

impl From<AttackBuilder> for DamageSource {
    fn from(a: AttackBuilder) -> Self {
        DamageSource::Attack(Box::new(a))
    }
}

impl From<SaveBuilder> for DamageSource {
    fn from(s: SaveBuilder) -> Self {
        DamageSource::Save(Box::new(s))
    }
}

/// `Source`: damage, or a [`ContextualSource`] whose PMF depends on the turn state.
#[derive(Clone, Debug)]
pub enum Source {
    Damage(DamageSource),
    Contextual(ArcContextual),
}

/// A shared hand-written [`ContextualSource`].
#[derive(Clone)]
pub struct ArcContextual(pub Arc<dyn ContextualSource>);

impl fmt::Debug for ArcContextual {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ContextualSource(..)")
    }
}

impl Source {
    /// This source as a [`ContextualSource`], when it declares a `rowCheck`: a hand-written one, or
    /// an `AttackBuilder`/`SaveBuilder`. A bare PMF, a roll or another `{ toPMF }` is not.
    pub fn as_contextual(&self) -> Option<&dyn ContextualSource> {
        match self {
            Source::Damage(DamageSource::Attack(a)) => Some(&**a),
            Source::Damage(DamageSource::Save(s)) => Some(&**s),
            Source::Damage(_) => None,
            Source::Contextual(c) => Some(&*c.0),
        }
    }

    /// `source.toPMF(eps)` of a damage source; a contextual one has no PMF of its own.
    pub fn damage(&self) -> Option<&DamageSource> {
        match self {
            Source::Damage(d) => Some(d),
            Source::Contextual(_) => None,
        }
    }
}

impl From<DamageSource> for Source {
    fn from(d: DamageSource) -> Self {
        Source::Damage(d)
    }
}

impl From<AttackBuilder> for Source {
    fn from(a: AttackBuilder) -> Self {
        Source::Damage(DamageSource::Attack(Box::new(a)))
    }
}

impl From<SaveBuilder> for Source {
    fn from(s: SaveBuilder) -> Self {
        Source::Damage(DamageSource::Save(Box::new(s)))
    }
}

impl From<Pmf> for Source {
    fn from(p: Pmf) -> Self {
        Source::Damage(DamageSource::Pmf(Arc::new(p)))
    }
}

/// `RiderDamage`: one payload, or several to convolve (Flurry of Blows is `[flurry, flurry]`).
#[derive(Clone, Debug)]
pub enum RiderDamage {
    One(DamageSource),
    Many(Vec<DamageSource>),
}

impl RiderDamage {
    /// The payloads as a slice (`[x]` for one).
    pub fn parts(&self) -> &[DamageSource] {
        match self {
            RiderDamage::One(d) => std::slice::from_ref(d),
            RiderDamage::Many(v) => v,
        }
    }
}

/// `RiderPayload`: the payload a rider deals when one particular source lands.
#[derive(Clone, Debug)]
pub struct RiderPayload {
    pub damage: RiderDamage,
    pub crit_damage: Option<RiderDamage>,
}

/// `RiderOptions`: everything about a rider except what it does and when.
#[derive(Clone, Debug, Default)]
pub struct RiderOptions {
    /// Required only if another rider names this one in `of`.
    pub id: Option<String>,
    /// Which attacks to watch: ids, attack-shaped rider ids or tags.
    pub of: Option<Vec<String>>,
    pub crit_damage: Option<RiderDamage>,
    pub landing: Option<SaveLanding>,
    pub r#where: Option<IndexMap<String, Vec<String>>>,
    pub joins: Option<Vec<String>>,
    /// One condition name or several (any-of).
    pub target_has: Option<Vec<String>>,
}

/// `LandingPayload.vulnerable`.
#[derive(Clone, Debug)]
pub struct VulnerableLanding {
    pub on_hit: Arc<Pmf>,
    pub on_crit: Arc<Pmf>,
}

/// `LandingPayload`: what a rider deals on one attack it lands on. The PMFs are shared: the plan
/// and the readers key per-PMF tallies by identity (as TS does by object), so a source that hands
/// the same `Arc` for two attacks has their weights merged.
#[derive(Clone, Debug)]
pub struct LandingPayload {
    pub on_hit: Arc<Pmf>,
    pub on_crit: Arc<Pmf>,
    pub vulnerable: VulnerableLanding,
}

/// `LandingRoll.vulnerable`.
#[derive(Clone, Debug)]
pub struct VulnerableRoll {
    pub on_hit: RollBuilder,
    pub on_crit: RollBuilder,
}

/// `LandingRoll`: the rolls behind a [`LandingPayload`].
#[derive(Clone, Debug)]
pub struct LandingRoll {
    pub on_hit: RollBuilder,
    pub on_crit: RollBuilder,
    pub vulnerable: Option<VulnerableRoll>,
}

/// `ContextualPayload`: rider damage that depends on the attack it lands on.
pub trait ContextualPayload: Send + Sync {
    /// The payload on `attack_id`.
    fn at(&self, attack_id: &str) -> Result<LandingPayload, DiceError>;

    /// Whether [`ContextualPayload::dealt`] is provided.
    fn has_dealt(&self) -> bool {
        false
    }

    /// P(the payload on `attack_id` deals more than 0 damage of `type_` after the target's scale).
    fn dealt(&self, _type_: &str, _attack_id: &str) -> Result<Dealt, DiceError> {
        Err(DiceError::error("dealt is not provided"))
    }

    /// The builders behind `at(attack_id)`; `None` means "draw the PMF and show a chip".
    fn roll_at(&self, _attack_id: &str) -> Result<Option<LandingRoll>, DiceError> {
        Ok(None)
    }
}

/// `Rider.damage`: `RiderDamage | ContextualPayload`.
#[derive(Clone)]
pub enum RiderDamageSpec {
    Plain(RiderDamage),
    Contextual(Arc<dyn ContextualPayload>),
}

impl fmt::Debug for RiderDamageSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RiderDamageSpec::Plain(d) => f.debug_tuple("Plain").field(d).finish(),
            RiderDamageSpec::Contextual(_) => f.write_str("Contextual(..)"),
        }
    }
}

/// `Rider`.
#[derive(Clone, Debug)]
pub struct Rider {
    pub trigger: Trigger,
    pub id: Option<String>,
    pub damage: RiderDamageSpec,
    pub crit_damage: Option<RiderDamage>,
    pub landing: Option<RiderLanding>,
    /// The probability, in `[0, 1]`, that the rider happens at all this turn.
    pub happens: Option<f64>,
    pub joins: Option<Vec<String>>,
    pub r#where: Option<IndexMap<String, Vec<String>>>,
    pub target_has: Option<Vec<String>>,
}

/// `AttackOptions.after.landing`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterLanding {
    Hit,
    Damage,
    Any,
}

/// `AttackOptions.after`.
#[derive(Clone, Debug, PartialEq)]
pub struct After {
    pub of: String,
    pub landing: AfterLanding,
}

/// `AttackOptions`: how an attack is declared.
#[derive(Clone, Debug, Default)]
pub struct AttackOptions {
    pub id: Option<String>,
    pub tag: Option<String>,
    pub chance: Option<f64>,
    pub target: Option<String>,
    pub after: Option<After>,
}

/// What [`Turn::attacks_with`](crate::turn::turn::Turn::attacks_with) adds to every copy.
#[derive(Clone, Debug, Default)]
pub struct AttacksOptions {
    pub tag: Option<String>,
    pub chance: Option<f64>,
}

/// `Attack`: a bare source (id `attack 1`, ...), or a source with its [`AttackOptions`].
#[derive(Clone, Debug)]
pub enum Attack {
    Bare(Source),
    Declared {
        options: AttackOptions,
        source: Source,
    },
}

/// `SubstitutePolicy`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SubstitutePolicy {
    Always,
    Below { hit: f64, crit: f64 },
    Optimal,
}

/// `SubstituteSpec.on`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubstituteOn {
    FirstHit,
    FirstMiss,
}

/// `SubstituteSpec.substitute`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubstituteKind {
    RerollKeepHigher,
    Hit,
    Reroll,
}

impl SubstituteKind {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            SubstituteKind::RerollKeepHigher => "reroll-keep-higher",
            SubstituteKind::Hit => "hit",
            SubstituteKind::Reroll => "reroll",
        }
    }
}

/// `SubstituteSpec`: a once-per-turn rewrite of a watched attack's outcome or payload.
#[derive(Clone, Debug, PartialEq)]
pub struct SubstituteSpec {
    pub id: Option<String>,
    pub on: SubstituteOn,
    pub of: Option<Vec<String>>,
    pub substitute: SubstituteKind,
    /// `reroll` only; default `reroll`.
    pub mode: Option<MissRerollMode>,
    /// Default `Always`. `first-hit` only.
    pub policy: Option<SubstitutePolicy>,
}

/// `GrantSpec.until`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantUntil {
    NextAttack,
    EndOfTurn,
}

impl GrantUntil {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            GrantUntil::NextAttack => "next-attack",
            GrantUntil::EndOfTurn => "end-of-turn",
        }
    }
}

/// `GrantSpec`: one granted modifier. A `true`-only flag is `false` when absent.
#[derive(Clone, Debug, PartialEq)]
pub struct GrantSpec {
    pub advantage: bool,
    pub disadvantage: bool,
    pub crit_on_hit: bool,
    pub until: GrantUntil,
    pub to: Option<Vec<String>>,
}

/// `AttackRuleModifier`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackRuleModifier {
    Advantage,
    Disadvantage,
    CritOnHit,
    Vulnerable,
}

impl AttackRuleModifier {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            AttackRuleModifier::Advantage => "advantage",
            AttackRuleModifier::Disadvantage => "disadvantage",
            AttackRuleModifier::CritOnHit => "critOnHit",
            AttackRuleModifier::Vulnerable => "vulnerable",
        }
    }
}

/// `SaveRuleModifier`; `Disadvantage` is `saveDisadvantage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveRuleModifier {
    AutoFail,
    SaveDisadvantage,
    Disadvantage,
}

impl SaveRuleModifier {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            SaveRuleModifier::AutoFail => "autoFail",
            SaveRuleModifier::SaveDisadvantage => "saveDisadvantage",
            SaveRuleModifier::Disadvantage => "disadvantage",
        }
    }
}

/// `Modifier`: what a condition does to a row it applies to (the union of the two rule enums).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modifier {
    Attack(AttackRuleModifier),
    Save(SaveRuleModifier),
}

impl Modifier {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            Modifier::Attack(m) => m.as_str(),
            Modifier::Save(m) => m.as_str(),
        }
    }
}

/// `ConditionRule.attack`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AttackRule {
    pub melee: Option<Vec<AttackRuleModifier>>,
    pub ranged: Option<Vec<AttackRuleModifier>>,
}

/// `ConditionRule.own` modifiers: `advantage | disadvantage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnModifier {
    Advantage,
    Disadvantage,
}

/// `ConditionRule.own`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OwnRule {
    pub attack: Option<Vec<OwnModifier>>,
    pub check: Option<Vec<OwnModifier>>,
}

/// `ConditionRule.onEnd`.
#[derive(Clone, Debug, PartialEq)]
pub struct OnEnd {
    pub condition: String,
    pub rule: ConditionRule,
}

/// `ConditionRule`: a condition's effect on rows, as data.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ConditionRule {
    pub attack: Option<AttackRule>,
    /// Keyed by ability name (its full name or three-letter form), in key order.
    pub save: Option<IndexMap<String, Vec<SaveRuleModifier>>>,
    pub own: Option<OwnRule>,
    /// A non-negative integer taken off every D20 Test the creature makes.
    pub d20_penalty: Option<f64>,
    pub on_end: Option<Box<OnEnd>>,
}

/// `until` of a condition effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConditionUntil {
    EndOfTurn,
    UntilDamaged,
}

/// `until` of a save modifier effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveUntil {
    EndOfTurn,
    NextSave,
}

/// `EffectSpec`: one effect a grant puts on a creature. Every effect states its lifetime.
#[derive(Clone, Debug, PartialEq)]
pub enum EffectSpec {
    Grant(GrantSpec),
    Condition {
        condition: String,
        rule: ConditionRule,
        until: ConditionUntil,
    },
    /// `{ vulnerability: true; until: "next-hit" }`.
    Vulnerability,
    SaveDisadvantage {
        until: SaveUntil,
        to: Option<Vec<String>>,
    },
    SavePenalty {
        count: f64,
        sides: f64,
        until: SaveUntil,
        to: Option<Vec<String>>,
    },
}

/// The function inside a [`FailChance`].
pub type FailChanceFn = dyn Fn(&RowContext) -> Result<f64, DiceError> + Send + Sync;

/// A `failChance` function of [`GrantSaveSpec`]: the chance, in `[0, 1]`, the save fails in a context.
#[derive(Clone)]
pub struct FailChance(pub Arc<FailChanceFn>);

impl FailChance {
    /// Wraps `f`.
    pub fn new(f: impl Fn(&RowContext) -> Result<f64, DiceError> + Send + Sync + 'static) -> Self {
        FailChance(Arc::new(f))
    }

    /// Calls it.
    pub fn call(&self, context: &RowContext) -> Result<f64, DiceError> {
        (self.0)(context)
    }
}

impl fmt::Debug for FailChance {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FailChance(..)")
    }
}

/// `GrantSaveSpec`: a grant's save, state-aware.
#[derive(Clone, Debug)]
pub enum GrantSaveSpec {
    /// A DC and bonus the library rolls in the target's current context.
    Dc {
        ability: Option<String>,
        dc: f64,
        bonus: f64,
        roll_type: Option<RollType>,
    },
    /// A fail chance computed from the context.
    FailChance {
        ability: Option<String>,
        fail_chance: FailChance,
    },
}

/// `ConditionSpec.save`: `GrantSaveSpec | readonly GrantSaveSpec[]` (the target picks the likeliest
/// pass of several).
#[derive(Clone, Debug)]
pub enum GrantSaves {
    One(GrantSaveSpec),
    Many(Vec<GrantSaveSpec>),
}

/// `ConditionSpec.on`: `AttackTriggerOn | "first-crit" | "start"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConditionOn {
    Attack(AttackTriggerOn),
    FirstCrit,
    Start,
}

impl ConditionOn {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            ConditionOn::Attack(a) => a.as_str(),
            ConditionOn::FirstCrit => "first-crit",
            ConditionOn::Start => "start",
        }
    }
}

/// `ConditionSpec`: grants applied by the outcomes of earlier attacks to later attack rolls.
#[derive(Clone, Debug)]
pub struct ConditionSpec {
    pub id: Option<String>,
    pub on: ConditionOn,
    pub of: Option<Vec<String>>,
    pub r#where: Option<IndexMap<String, Vec<String>>>,
    pub chance: Option<f64>,
    pub target_has: Option<Vec<String>>,
    pub landing: Option<SaveLanding>,
    pub dealing: Option<String>,
    pub target: Option<String>,
    pub save: Option<GrantSaves>,
    pub grants: Vec<EffectSpec>,
    pub on_save: Option<Vec<EffectSpec>>,
    /// "You can": the turn takes it only where that raises the mean.
    pub optional: bool,
}

/// `ProbeSpec.on`: only `any-crit` exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeOn {
    AnyCrit,
}

/// `ProbeSpec`: a probability the walk reports without adding any damage.
#[derive(Clone, Debug, PartialEq)]
pub struct ProbeSpec {
    pub id: Option<String>,
    pub on: ProbeOn,
    pub of: Option<Vec<String>>,
}

/// `TurnSpec`.
#[derive(Clone, Debug, Default)]
pub struct TurnSpec {
    pub attacks: Vec<Attack>,
    pub riders: Option<Vec<Rider>>,
    pub substitutes: Option<Vec<SubstituteSpec>>,
    pub conditions: Option<Vec<ConditionSpec>>,
    pub observe: Option<Vec<ProbeSpec>>,
    /// The most distinct turn states the walk may carry; more is `too-many-states`.
    pub state_limit: Option<f64>,
}

/// `TurnSpecErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnSpecErrorCode {
    UnknownId,
    DuplicateId,
    SelfReference,
    Cycle,
    NotAnAttack,
    UnusedCritDamage,
    TooManyGroups,
    TooManyCounters,
    NoDiceDescriptor,
    DuplicateSubstitute,
    AttackAfterRider,
    NoRebindableSource,
    UnsupportedTrigger,
    UnsupportedPolicy,
    /// Deprecated; never thrown since 0.17.
    TooManyFlags,
    UnknownKey,
    NonStringId,
    UnknownRange,
    UnknownAbility,
    TooManyStates,
    SaveWithoutAbility,
    DealingJointUnsupported,
}

impl TurnSpecErrorCode {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            TurnSpecErrorCode::UnknownId => "unknown-id",
            TurnSpecErrorCode::DuplicateId => "duplicate-id",
            TurnSpecErrorCode::SelfReference => "self-reference",
            TurnSpecErrorCode::Cycle => "cycle",
            TurnSpecErrorCode::NotAnAttack => "not-an-attack",
            TurnSpecErrorCode::UnusedCritDamage => "unused-crit-damage",
            TurnSpecErrorCode::TooManyGroups => "too-many-groups",
            TurnSpecErrorCode::TooManyCounters => "too-many-counters",
            TurnSpecErrorCode::NoDiceDescriptor => "no-dice-descriptor",
            TurnSpecErrorCode::DuplicateSubstitute => "duplicate-substitute",
            TurnSpecErrorCode::AttackAfterRider => "attack-after-rider",
            TurnSpecErrorCode::NoRebindableSource => "no-rebindable-source",
            TurnSpecErrorCode::UnsupportedTrigger => "unsupported-trigger",
            TurnSpecErrorCode::UnsupportedPolicy => "unsupported-policy",
            TurnSpecErrorCode::TooManyFlags => "too-many-flags",
            TurnSpecErrorCode::UnknownKey => "unknown-key",
            TurnSpecErrorCode::NonStringId => "non-string-id",
            TurnSpecErrorCode::UnknownRange => "unknown-range",
            TurnSpecErrorCode::UnknownAbility => "unknown-ability",
            TurnSpecErrorCode::TooManyStates => "too-many-states",
            TurnSpecErrorCode::SaveWithoutAbility => "save-without-ability",
            TurnSpecErrorCode::DealingJointUnsupported => "dealing-joint-unsupported",
        }
    }
}

/// `TurnSpecError`: a malformed turn. `code` is a stable contract; its `Display` is the message.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnSpecError {
    pub code: TurnSpecErrorCode,
    pub id: String,
    pub message: String,
}

impl TurnSpecError {
    /// `new TurnSpecError(code, id, message)`.
    pub fn new(code: TurnSpecErrorCode, id: &str, message: &str) -> Self {
        TurnSpecError {
            code,
            id: id.to_string(),
            message: message.to_string(),
        }
    }
}

impl fmt::Display for TurnSpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TurnSpecError {}
