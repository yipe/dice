//! Port of `src/builder/attack.ts`: `AttackBuilder`, an attack roll with its hit, crit and miss
//! payloads (`d20.plus(5).ac(15).onHit(roll(2, d6)).critOn(19)`).
//!
//! # Shape
//! - `check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder` is a [`RollBuilder`] of kind
//!   `Ac`/`AlwaysHit`/`AlwaysCrit`; any other kind makes the methods that read the check return `Err`.
//! - `critEffect: ActionEffect | null | undefined` is [`CritEffect`]: `Auto` (undefined: the hit dice
//!   doubled), `None` (null: `noCrit()`), `Roll`.
//! - `landingScale: 1 | 2` is a `u8`. Every derived builder is built with 1, as in TS; only
//!   [`AttackBuilder::roll_under`] sets 2.
//! - Overloads: `onCrit`/`onMiss(...args)` take an [`Arg`] slice. `onEveryHit(grants | save(...), gate)`
//!   is [`AttackBuilder::on_every_hit`] over [`Grants`]. `rerollMisses(mode = "add-d20")` takes the
//!   mode. `missRerolled(mode, context?, eps)` takes `Option<&RowContext>`. `withCheck(fn)` takes an
//!   `FnOnce(Check) -> Check`.
//! - Implements [`ContextualSource`] (`IGNORES_JOINED` true, `dealt` present only on a [`typed`]
//!   attack), [`CheckBuilder`] and [`HasDiceMatchInfo`]. Inherent `under`/`roll_under`/`resolve`
//!   take precedence over the trait methods of the same name; the trait impls delegate to them.
//! - `AttachedCondition.grants` is always a list (`Lasting | readonly Lasting[]` in TS).
//! - `resolveProbabilities(check, eps)` is the associated function [`AttackBuilder::resolve_probabilities`].
//!
//! # Skipped
//! `attackPMFCache`, `missRerolledCache` and their seams (`clearAttackCache`,
//! `setMissRerolledCacheEnabled`), the memoised `cacheKey`; the TS `pooled`/`mapEveryDieGroup`
//! helpers keep their `cacheKey() === null` checks through [`RollBuilder::cache_key`].
//!
//! # ADR-017
//! - `rerollDamage` / `minimumDamageDie` on a die of more than 1e6 sides return `Err` (TS loops
//!   once per face).
//! - `diceMatchInfo` refuses (a refusal string, as for "too many to enumerate") a pool where
//!   `dice · faces` is over [`MAX_DICE_FACES`], or a die over 1e6 faces.

use super::arguments::{require_finite, reroll_up_to_arguments};
use super::ast::{
    die_node_from_config, natural_die_config, pmf_from_roll_builder, rerollable_pool,
    resolve_root_d20,
};
use super::bounce::{
    MAX_DICE_FACES, dice_sum_distribution, face_weights, joint_sum_and_match, too_big,
};
use super::expression::{check_expression, root_die_expression};
use super::miss_reroll::{miss_reroll_check_expression, miss_reroll_odds, miss_reroll_of};
use super::mixture::Mixture;
use super::nodes::{ExpressionNode, Rounding};
use super::num::{MAX_ENUMERATED, js_max, js_min};
use super::prob::split_at_threshold;
use super::reroll_pool::{PoolDieKind, reroll_up_to_match};
use super::roll::{
    Arg, AttackConfig, RollBuilder, RollKind, RollRerollUpToOptions, natural_roll_index,
};
use super::roll_cache_key::Memo;
use super::sample::{
    RollSample, SampledDie, read_check_dice, sample_check_dice, sample_die, scale_value,
};
use super::types::{
    AdvantageDice, AttackRange, AttackResolution, AttackWeights, Check, CheckBuilder,
    MissRerollMode, Resolution, RollConfig, RollType,
};
use crate::EPS;
use crate::common::{DiceMatchInfo, HasDiceMatchInfo, Rng};
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::pmf::cache::{ATTACK_CACHE, MISS_REROLLED_CACHE, miss_rerolled_cache_enabled};
use crate::turn::context::{
    ContextualSource, Dealt, RollUnder, RowCheck, RowContext, RowKind, RowRange,
};
use crate::turn::effects::{Lasting, SaveGated, TriggerSaves, unpack_save};
use crate::turn::types::SaveLanding;
use crate::{Damage, DiceQuery, Pmf};
use indexmap::IndexMap;
use std::sync::Arc;
// Writes to a `String` via `fmt::Write` are infallible, so `let _ =` discards no error.
use std::fmt::Write;

/// `ActionEffect`: a damage payload.
type ActionEffect = RollBuilder;

/// A `rerollDamageUpTo()` budget and the number of whole rolls it chooses from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RerollPoolSpec {
    pub budget: f64,
    pub rolls: f64,
}

/// `AttachedCondition.on`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachedOn {
    EveryHit,
    AnyCrit,
    FirstCrit,
}

impl AttachedOn {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            AttachedOn::EveryHit => "every-hit",
            AttachedOn::AnyCrit => "any-crit",
            AttachedOn::FirstCrit => "first-crit",
        }
    }
}

/// `ConditionGate`: what gates an attached condition's grants: the same fields `Turn`'s trigger
/// verbs accept (`save`, `chance`, `onSave`, `landing`, `dealing`, `optional`, `targetHas`).
#[derive(Clone, Debug, Default)]
pub struct ConditionGate {
    pub save: Option<TriggerSaves>,
    pub chance: Option<f64>,
    pub on_save: Option<Vec<Lasting>>,
    pub landing: Option<SaveLanding>,
    pub dealing: Option<String>,
    pub optional: bool,
    pub target_has: Option<Vec<String>>,
}

/// `AttachedCondition`: a condition a builder carries into a turn: when this attack's outcome
/// fires, the grants apply to later attack rolls. `Turn` reads each entry into one `ConditionSpec`
/// with `of` = this attack's id.
#[derive(Clone, Debug)]
pub struct AttachedCondition {
    pub on: AttachedOn,
    pub grants: Vec<Lasting>,
    pub gate: Option<ConditionGate>,
}

/// What `onEveryHit` / `onAnyCrit` / `onFirstCrit` take: one effect, several, or a `save()` value.
#[derive(Clone, Debug)]
pub enum Grants {
    One(Lasting),
    Many(Vec<Lasting>),
    Gated(SaveGated),
}

impl From<crate::turn::effects::Grant> for Grants {
    fn from(grant: crate::turn::effects::Grant) -> Self {
        Grants::One(grant.into())
    }
}

impl From<Lasting> for Grants {
    fn from(lasting: Lasting) -> Self {
        Grants::One(lasting)
    }
}

impl From<Vec<Lasting>> for Grants {
    fn from(list: Vec<Lasting>) -> Self {
        Grants::Many(list)
    }
}

impl From<SaveGated> for Grants {
    fn from(gated: SaveGated) -> Self {
        Grants::Gated(gated)
    }
}

/// `critEffect`: `undefined` (the hit dice doubled), `null` (`noCrit()`) or an explicit roll.
#[derive(Clone, Debug, PartialEq)]
pub enum CritEffect {
    Auto,
    None,
    Roll(ActionEffect),
}

/// `AttackSample.outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackOutcome {
    Hit,
    Crit,
    Miss,
}

impl AttackOutcome {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            AttackOutcome::Hit => "hit",
            AttackOutcome::Crit => "crit",
            AttackOutcome::Miss => "miss",
        }
    }
}

/// `AttackPayloadSample`: one landing's payload dice, split at the base, and the whole-roll scale
/// its total takes.
#[derive(Clone, Debug, PartialEq)]
pub struct AttackPayloadSample {
    pub base: RollSample,
    pub separate: Vec<RollSample>,
    pub scale: u8,
}

/// `AttackSample`: one roll of an attack: the check dice, the payload dice and what landed.
#[derive(Clone, Debug, PartialEq)]
pub struct AttackSample {
    pub outcome: AttackOutcome,
    /// The d20s (dropped ones `kept: false`), then the bonus dice.
    pub check: Vec<SampledDie>,
    pub damage: Vec<SampledDie>,
    pub total: f64,
    /// On a landing, the payload split at the base; absent on a miss.
    pub payload: Option<AttackPayloadSample>,
}

/// What `resolveProbabilities` returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AttackProbabilities {
    pub p_success: f64,
    pub p_hit: f64,
    pub p_crit: f64,
    pub p_miss: f64,
}

/// The weights `resolveWeighted` mixes: `natural20_share` of the crit branch deals
/// `plusNatural20Damage`.
#[derive(Clone, Copy, Debug)]
struct SliceWeights {
    p_hit: f64,
    p_crit: f64,
    p_miss: f64,
    natural20_share: f64,
}

/// `AttackBuilder.diceMatchInfo`'s branch: a descriptor, or why there is none.
#[derive(Clone, Debug, PartialEq)]
enum Descriptor {
    Info(DiceMatchInfo),
    Refusal(String),
}

/// A bad-crit-threshold style `Err` for a check that is not an attack check.
fn not_an_attack_check() -> DiceError {
    DiceError::error("AttackBuilder needs an ac(), alwaysHits() or alwaysCrits() check")
}

/// `check instanceof AlwaysHitBuilder || (check instanceof AlwaysCritBuilder && check.fromAlwaysHit)`.
fn is_auto_hit_check(check: &RollBuilder) -> bool {
    check.is_always_hit() || check.from_always_hit() == Some(true)
}

/// `check.critThreshold`.
fn crit_threshold_of(check: &RollBuilder) -> Result<f64, DiceError> {
    check.crit_threshold().ok_or_else(not_an_attack_check)
}

/// `check` declared `range` again: a rebuilt check (`withCheck`, `under`) keeps the attack's range.
fn with_range(check: RollBuilder, range: Option<AttackRange>) -> Result<RollBuilder, DiceError> {
    match range {
        None => Ok(check),
        Some(AttackRange::Ranged) => check.ranged(),
        Some(AttackRange::Melee) => check.melee(),
    }
}

/// `AttackBuilder`.
#[derive(Clone, Debug)]
pub struct AttackBuilder(Arc<AttackBuilderData>);

/// The data behind an [`AttackBuilder`]; shared by `Arc`, copied on write (ADR-019).
#[derive(Clone, Debug)]
pub struct AttackBuilderData {
    /// The check: an `ac()`, `alwaysHits()` or `alwaysCrits()` roll.
    pub check: RollBuilder,
    hit_effect: Option<ActionEffect>,
    crit_effect: CritEffect,
    miss_effect: Option<ActionEffect>,
    /// Extra damage channels convolved into hit AND crit (their dice double on a crit), but
    /// excluded from base-payload transforms.
    separate_damage: Vec<ActionEffect>,
    /// The raw argument `rerollDamage()` was last called with.
    reroll_threshold: Option<f64>,
    minimum_die_value: Option<f64>,
    half_on_miss: bool,
    /// Conditions carried into a turn, read by `Turn` into one `ConditionSpec` each.
    pub attached: Vec<AttachedCondition>,
    reroll_pool: Option<RerollPoolSpec>,
    /// The one damage type of the whole row, set by [`AttackBuilder::typed`].
    pub damage_type: Option<String>,
    /// Names a turn's `of` and `to` can watch this attack by, set by [`AttackBuilder::tagged`].
    pub tags: Vec<String>,
    /// Damage dealt only when the kept d20 shows a natural 20, verbatim.
    natural20_damage: Vec<ActionEffect>,
    /// 2 for the attack [`AttackBuilder::roll_under`] returns in a vulnerable context.
    landing_scale: u8,
    /// [`AttackBuilder::cache_key`] for the eps (bits) it was first asked at, reset on every
    /// copy-on-write mutation.
    key: Memo<(u64, Option<String>)>,
}

impl AttackBuilder {
    /// `new AttackBuilder(check, hitEffect)`: an attack with only a hit payload.
    pub fn new(check: RollBuilder, damage: RollBuilder) -> AttackBuilder {
        AttackBuilder::from(AttackBuilderData {
            check,
            hit_effect: Some(damage),
            crit_effect: CritEffect::Auto,
            miss_effect: None,
            separate_damage: Vec::new(),
            reroll_threshold: None,
            minimum_die_value: None,
            half_on_miss: false,
            attached: Vec::new(),
            reroll_pool: None,
            damage_type: None,
            tags: Vec::new(),
            natural20_damage: Vec::new(),
            landing_scale: 1,
            key: Memo::default(),
        })
    }

    /// `new AttackBuilder(check)`: no payloads at all.
    pub fn without_damage(check: RollBuilder) -> AttackBuilder {
        AttackBuilder::from(AttackBuilderData {
            hit_effect: None,
            ..(*AttackBuilder::new(check, RollBuilder::zero()).0).clone()
        })
    }

    /// The same attack, unscaled: the base of every derived builder.
    fn derived(&self) -> AttackBuilderData {
        AttackBuilderData {
            landing_scale: 1,
            ..(*self.0).clone()
        }
    }

    /// The hit payload, if any.
    pub fn hit_effect(&self) -> Option<&RollBuilder> {
        self.hit_effect.as_ref()
    }

    /// The crit payload state.
    pub fn crit_effect(&self) -> &CritEffect {
        &self.crit_effect
    }

    /// The miss payload, if any.
    pub fn miss_effect(&self) -> Option<&RollBuilder> {
        self.miss_effect.as_ref()
    }

    /// The `plusSeparateDamage` channels.
    pub fn separate_damage(&self) -> &[RollBuilder] {
        &self.separate_damage
    }

    /// The `plusNatural20Damage` payloads.
    pub fn natural20_damage(&self) -> &[RollBuilder] {
        &self.natural20_damage
    }

    /// Whether `halfOnMiss()` was called.
    pub fn half_on_miss_flag(&self) -> bool {
        self.half_on_miss
    }

    /// The `rerollDamageUpTo()` budget, if set.
    pub fn reroll_pool(&self) -> Option<RerollPoolSpec> {
        self.reroll_pool
    }

    /// `landingScale`.
    pub fn landing_scale(&self) -> u8 {
        self.landing_scale
    }

    /// `check.attackConfig`.
    fn config(&self) -> Result<&AttackConfig, DiceError> {
        self.check.attack_config().ok_or_else(not_an_attack_check)
    }

    /// `check.critThreshold`.
    pub fn crit_threshold(&self) -> Result<f64, DiceError> {
        crit_threshold_of(&self.check)
    }

    /// `typed(damageType)`: declares the row's whole damage as one `damageType`, so a turn
    /// condition with `dealing` can read it. Changes no number the attack resolves. `Err` (a
    /// `TypeError`) on an empty name.
    pub fn typed(&self, damage_type: &str) -> Result<AttackBuilder, DiceError> {
        if damage_type.is_empty() {
            return Err(DiceError::type_error(
                "typed() takes a damage type name, such as \"cold\".",
            ));
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            damage_type: Some(damage_type.to_string()),
            ..self.derived()
        }))
    }

    /// `tagged(...tags)`: names this attack for a turn's `of` and `to`. Repeated calls add to the
    /// tags. `Err` (a `TypeError`) on no tag, or an empty one.
    pub fn tagged(&self, tags: &[&str]) -> Result<AttackBuilder, DiceError> {
        if tags.is_empty() {
            return Err(DiceError::type_error(
                "tagged() takes at least one tag, such as \"finesse\".",
            ));
        }
        if tags.iter().any(|t| t.is_empty()) {
            return Err(DiceError::type_error(
                "tagged() takes non-empty strings, got \"\".",
            ));
        }
        let mut all = self.tags.clone();
        for tag in tags {
            if !all.iter().any(|t| t == tag) {
                all.push((*tag).to_string());
            }
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            tags: all,
            ..self.derived()
        }))
    }

    /// `dealtOdds(type, context)`: P(damage > 0) given a hit and given a crit.
    fn dealt_odds(&self, type_: &str, context: &RowContext) -> Result<Dealt, DiceError> {
        if self.damage_type.as_deref() != Some(type_) {
            return Ok(Dealt {
                hit: 0.0,
                crit: 0.0,
            });
        }
        let pmf = self.under(context, 0.0)?;
        // A modifier can take a roll to 0 or below: none of that deals damage.
        let nothing: Vec<Damage> = pmf.support().into_iter().filter(|v| v.0 <= 0.0).collect();
        let odds = |outcome: &str| -> f64 {
            let landed = pmf.outcome_probability(outcome);
            let none = nothing
                .iter()
                .fold(0.0, |sum, v| sum + pmf.outcome_at(v.0, outcome));
            if landed > 0.0 {
                (landed - none) / landed
            } else {
                0.0
            }
        };
        Ok(Dealt {
            hit: odds("hit"),
            crit: odds("crit"),
        })
    }

    /// `onCrit(...args)`: an explicit crit payload. It is base payload: carries any `rerollDamage` /
    /// `minimumDamageDie` already set.
    pub fn on_crit(&self, args: &[Arg]) -> Result<AttackBuilder, DiceError> {
        let damage = self.with_stored_base_transforms(RollBuilder::from_args(args)?)?;
        if self.reroll_pool.is_some() {
            Self::require_plain_dice(&damage, "rerollDamageUpTo")?;
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            crit_effect: CritEffect::Roll(damage),
            ..self.derived()
        }))
    }

    /// `onMiss(...args)`: a payload for the miss branch. `Err` after `halfOnMiss()`.
    pub fn on_miss(&self, args: &[Arg]) -> Result<AttackBuilder, DiceError> {
        if self.half_on_miss {
            return Err(DiceError::error(
                "onMiss() cannot be combined with halfOnMiss(): the miss branch can only be one or the other.",
            ));
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            miss_effect: Some(RollBuilder::from_args(args)?),
            ..self.derived()
        }))
    }

    /// `noCrit()`: the attack cannot crit (a crit lands as a hit). `Err` after
    /// `plusNatural20Damage()`.
    pub fn no_crit(&self) -> Result<AttackBuilder, DiceError> {
        if !self.natural20_damage.is_empty() {
            return Err(Self::natural20_no_crit_error());
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            crit_effect: CritEffect::None,
            ..self.derived()
        }))
    }

    /// `plusSeparateDamage(damage)`: a second damage channel, convolved into the hit AND crit
    /// payloads but excluded from base-payload transforms. Several calls accumulate.
    pub fn plus_separate_damage(&self, damage: RollBuilder) -> AttackBuilder {
        let mut separate = self.separate_damage.clone();
        separate.push(damage);
        AttackBuilder::from(AttackBuilderData {
            separate_damage: separate,
            ..self.derived()
        })
    }

    /// `plusNatural20Damage(damage)`: damage dealt only when the attack's d20 shows a natural 20, on
    /// top of the crit payload, verbatim (never doubled). Several calls accumulate. `Err` after
    /// `noCrit()`.
    pub fn plus_natural20_damage(&self, damage: RollBuilder) -> Result<AttackBuilder, DiceError> {
        if self.crit_effect == CritEffect::None {
            return Err(Self::natural20_no_crit_error());
        }
        let mut extra = self.natural20_damage.clone();
        extra.push(damage);
        Ok(AttackBuilder::from(AttackBuilderData {
            natural20_damage: extra,
            ..self.derived()
        }))
    }

    fn natural20_no_crit_error() -> DiceError {
        DiceError::error(
            "plusNatural20Damage() cannot be combined with noCrit(): a natural 20 always crits, and its damage rides the crit branch noCrit() removes.",
        )
    }

    /// `rerollDamage(threshold)`: every die group of the BASE payload (hit, and the crit branch
    /// when it is explicit) rerolls low faces once, leaving `plusSeparateDamage` channels untouched.
    /// The threshold is a permission cap (see [`Self::base_transform`]). Repeating the same value is
    /// a no-op; a different one is `Err`.
    pub fn reroll_damage(&self, threshold: impl Into<f64>) -> Result<AttackBuilder, DiceError> {
        let threshold = threshold.into();
        if threshold.is_nan() {
            return Err(DiceError::error(
                "Invalid NaN value for rerollDamage threshold",
            ));
        }
        require_finite(threshold, "rerollDamage() threshold")?;
        if let Some(existing) = self.reroll_threshold {
            if threshold == existing {
                return Ok(self.clone());
            }
            return Err(DiceError::error(format!(
                "Conflicting rerollDamage() threshold: already set to {}, cannot change to {}. Repeating the same value is a no-op.",
                num_to_string(existing),
                num_to_string(threshold)
            )));
        }
        let transform =
            |c: &RollConfig| Self::base_transform(c, Some(threshold), self.minimum_die_value);
        let hit = match &self.hit_effect {
            Some(h) => Some(Self::map_every_die_group(h, "rerollDamage", &transform)?),
            None => None,
        };
        let crit = match &self.crit_effect {
            CritEffect::Roll(c) => {
                CritEffect::Roll(Self::map_every_die_group(c, "rerollDamage", &transform)?)
            }
            other => other.clone(),
        };
        Ok(AttackBuilder::from(AttackBuilderData {
            hit_effect: hit,
            crit_effect: crit,
            reroll_threshold: Some(threshold),
            ..self.derived()
        }))
    }

    /// `minimumDamageDie(minimum)`: raises every die of the BASE payload to at least `minimum`,
    /// leaving `plusSeparateDamage` channels untouched. Repeating the same value is a no-op; a
    /// different one is `Err`.
    pub fn minimum_damage_die(&self, minimum: impl Into<f64>) -> Result<AttackBuilder, DiceError> {
        let minimum = minimum.into();
        if minimum.is_nan() {
            return Err(DiceError::error("Invalid NaN value for minimumDamageDie"));
        }
        require_finite(minimum, "minimumDamageDie()")?;
        if let Some(existing) = self.minimum_die_value {
            if minimum == existing {
                return Ok(self.clone());
            }
            return Err(DiceError::error(format!(
                "Conflicting minimumDamageDie() value: already set to {}, cannot change to {}. Repeating the same value is a no-op.",
                num_to_string(existing),
                num_to_string(minimum)
            )));
        }
        let transform =
            |c: &RollConfig| Self::base_transform(c, self.reroll_threshold, Some(minimum));
        let hit = match &self.hit_effect {
            Some(h) => Some(Self::map_every_die_group(
                h,
                "minimumDamageDie",
                &transform,
            )?),
            None => None,
        };
        let crit = match &self.crit_effect {
            CritEffect::Roll(c) => CritEffect::Roll(Self::map_every_die_group(
                c,
                "minimumDamageDie",
                &transform,
            )?),
            other => other.clone(),
        };
        Ok(AttackBuilder::from(AttackBuilderData {
            hit_effect: hit,
            crit_effect: crit,
            minimum_die_value: Some(minimum),
            ..self.derived()
        }))
    }

    /// `rerollDamageUpTo(budget, options)`: the BASE payload rerolls up to `budget` of its dice once
    /// all are seen, keeping each new roll; with `rolls` the payload is rolled that many times first
    /// and the better roll is used. Applied after `rerollDamage`, `minimumDamageDie` and `onCrit`,
    /// whatever the call order. `Err` on a payload that is not plain dice, or a conflicting repeat.
    pub fn reroll_damage_up_to(
        &self,
        budget: f64,
        rolls: Option<f64>,
    ) -> Result<AttackBuilder, DiceError> {
        let spec = reroll_up_to_arguments(budget, rolls, "rerollDamageUpTo()")?;
        let spec = RerollPoolSpec {
            budget: spec.budget,
            rolls: spec.rolls,
        };
        if let Some(existing) = self.reroll_pool {
            if spec.budget == existing.budget && spec.rolls == existing.rolls {
                return Ok(self.clone());
            }
            return Err(DiceError::error(format!(
                "Conflicting rerollDamageUpTo(): already set to {} ({} roll(s)), cannot change to {} ({} roll(s)). Repeating the same call is a no-op.",
                num_to_string(existing.budget),
                num_to_string(existing.rolls),
                num_to_string(spec.budget),
                num_to_string(spec.rolls)
            )));
        }
        // Refuse at the call, not at the first resolve.
        if let Some(h) = &self.hit_effect {
            Self::require_plain_dice(h, "rerollDamageUpTo")?;
        }
        if let CritEffect::Roll(c) = &self.crit_effect {
            Self::require_plain_dice(c, "rerollDamageUpTo")?;
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            reroll_pool: Some(spec),
            ..self.derived()
        }))
    }

    /// `halfOnMiss()`: the miss payload becomes `floor(resolved hit payload / 2)`. `Err` after
    /// `onMiss()`.
    pub fn half_on_miss(&self) -> Result<AttackBuilder, DiceError> {
        if self.miss_effect.is_some() {
            return Err(DiceError::error(
                "halfOnMiss() cannot be combined with onMiss(): the miss branch can only be one or the other.",
            ));
        }
        if self.half_on_miss {
            return Ok(self.clone());
        }
        Ok(AttackBuilder::from(AttackBuilderData {
            half_on_miss: true,
            ..self.derived()
        }))
    }

    /// `rerollMisses(mode)` (TS default `"add-d20"`): a missed attack roll is rolled again, once.
    /// An attack that always hits has no miss: a clone. `Err` for a check with no d20 natural roll.
    pub fn reroll_misses(&self, mode: MissRerollMode) -> Result<AttackBuilder, DiceError> {
        if is_auto_hit_check(&self.check) {
            return Ok(self.clone());
        }
        self.with_check(|c| Check {
            miss_reroll: Some(mode),
            ..c
        })
    }

    /// `missRerolled(mode, context?, eps)`: the outcome-labelled PMF over this attack's MISS branch
    /// once that miss's d20 is rolled again by `mode`: total mass P(miss) in `context`; the hit and
    /// crit parts carry the row's own payloads. Empty for an always-hit check. `Err` if the check
    /// already rerolls its misses.
    pub fn miss_rerolled(
        &self,
        mode: MissRerollMode,
        context: Option<&RowContext>,
        eps: f64,
    ) -> Result<Pmf, DiceError> {
        self.miss_rerolled_shared(mode, context, eps)
            .map(|p| (*p).clone())
    }

    /// [`AttackBuilder::miss_rerolled`] through `missRerolledCache` (key `{mode}*{cacheKey}`; off
    /// while [`set_miss_rerolled_cache_enabled`] is false), returning the cached `Arc`.
    pub fn miss_rerolled_shared(
        &self,
        mode: MissRerollMode,
        context: Option<&RowContext>,
        eps: f64,
    ) -> Result<Arc<Pmf>, DiceError> {
        let attack = match context {
            Some(c) => self.roll_under(c)?,
            None => self.clone(),
        };
        let check = &attack.check;
        if miss_reroll_of(check).is_some() {
            return Err(DiceError::error(
                "missRerolled() needs a check that does not already rerollMisses().",
            ));
        }
        if is_auto_hit_check(check) {
            return Ok(Arc::new(Pmf::empty(eps)));
        }
        let key = attack
            .cache_key(eps)
            .filter(|_| miss_rerolled_cache_enabled())
            .map(|k| format!("{}*{k}", mode.as_str()));
        if let Some(hit) = key.as_deref().and_then(|k| MISS_REROLLED_CACHE.get(k)) {
            return Ok(hit);
        }
        let odds = miss_reroll_odds(check, mode, eps)?;
        let rerolled = odds.hit + odds.crit + odds.miss;
        // TS `!(rerolled > 0)`: a NaN reroll mass is empty too.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(rerolled > 0.0) {
            return Ok(Arc::new(Pmf::empty(eps)));
        }
        let slices = attack.resolve_weighted(
            eps,
            attack.landing_scale,
            SliceWeights {
                p_hit: odds.hit,
                p_crit: odds.crit,
                p_miss: odds.miss,
                natural20_share: if odds.crit > 0.0 {
                    js_min(1.0, odds.natural20 / odds.crit)
                } else {
                    0.0
                },
            },
        )?;
        let pmf = Arc::new(slices.pmf.scale_mass(rerolled));
        if let Some(k) = key.as_deref() {
            MISS_REROLLED_CACHE.set(k, Arc::clone(&pmf));
        }
        Ok(pmf)
    }

    /// `withCheck(fn)`: the one way to re-derive hit/crit/miss probabilities for an existing
    /// attack. `Err` if the check has no AC (an always-hit check, or a crit-on-hit override).
    pub fn with_check(&self, f: impl FnOnce(Check) -> Check) -> Result<AttackBuilder, DiceError> {
        let next = f(self.to_check()?);
        let range = self.config()?.range;
        Ok(self.rebuilt(with_range(Self::build_check(&next)?, range)?))
    }

    /// This attack with another check and every other part unchanged.
    fn rebuilt(&self, check: RollBuilder) -> AttackBuilder {
        AttackBuilder::from(AttackBuilderData {
            check,
            ..self.derived()
        })
    }

    /// `ranged()`: an attack from farther than 5 feet, for a turn's condition rules. A row fact.
    pub fn ranged(&self) -> Result<AttackBuilder, DiceError> {
        Ok(self.rebuilt(self.check.ranged()?))
    }

    /// `melee()`: an attack from within 5 feet. A row fact.
    pub fn melee(&self) -> Result<AttackBuilder, DiceError> {
        Ok(self.rebuilt(self.check.melee()?))
    }

    /// `pinned()`: no grant or condition in a turn changes this attack's roll type.
    pub fn pinned(&self) -> Result<AttackBuilder, DiceError> {
        Ok(self.rebuilt(self.check.pinned()?))
    }

    /// `rowCheck`: what this attack declares to a turn. `advantage_dice` is 3 under
    /// `threeDiceAdvantage()` or an own Elven Accuracy roll. `autoHit` is `alwaysHits()`, `autoCrit`
    /// is `alwaysCrits()` (both, for `alwaysHits().alwaysCrits()`). Builders never declare
    /// `kind: "auto"`.
    pub fn row_check(&self) -> RowCheck {
        let check = &self.check;
        let range = check
            .attack_config()
            .and_then(|c| c.range)
            .map(|r| match r {
                AttackRange::Melee => RowRange::Melee,
                AttackRange::Ranged => RowRange::Ranged,
            });
        let roll_type = check.roll_type();
        let auto_crit = check.is_always_crit();
        RowCheck {
            kind: RowKind::Attack,
            range,
            ability: None,
            roll_type,
            advantage_dice: if roll_type == RollType::ElvenAccuracy
                || check.advantage_dice() == Some(AdvantageDice::Three)
            {
                3
            } else {
                2
            },
            pinned: check.get_root_die_config().is_some_and(|c| c.pinned),
            auto_hit: is_auto_hit_check(check),
            auto_crit,
            auto_fail: false,
        }
    }

    /// `under(context, eps)`: this attack's outcome-labelled PMF re-derived in a turn's `context`.
    /// `context.roll_type` is taken literally unless the attack is pinned; `auto_hit` makes it
    /// `alwaysHits()`, `crit_on_hit` makes every hit a crit, each on top of the attack's own;
    /// `vulnerable` doubles the hit and crit damage as a whole roll; a miss is unchanged.
    /// `auto_fail`, `penalty_dice` and `joined` are ignored. No `chance` is applied.
    pub fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.roll_under(context)?.to_pmf(eps)
    }

    /// [`Self::under`] as the cached `Arc`: when `context` changes nothing this is the attack's own
    /// cached PMF object (no builder clone), as in TS.
    pub fn under_shared(&self, context: &RowContext, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        if self.context_changes_nothing(context) && (!context.vulnerable || self.landing_scale == 2)
        {
            return self.to_pmf_shared(eps);
        }
        self.roll_under(context)?.to_pmf_shared(eps)
    }

    /// Whether `context` leaves the attack's check as it is ([`Self::in_context`]'s early return).
    fn context_changes_nothing(&self, context: &RowContext) -> bool {
        let own = self.row_check();
        let roll_type = if own.pinned {
            own.roll_type
        } else {
            context.roll_type
        };
        roll_type == own.roll_type
            && (own.auto_hit || context.auto_hit) == own.auto_hit
            && (own.auto_crit || context.crit_on_hit) == own.auto_crit
    }

    /// `rollUnder(context)`: this attack re-derived in `context` ([`Self::under`]'s rebuild), with a
    /// vulnerable context's doubling baked in, so its PMF is exactly `under(context)`.
    pub fn roll_under(&self, context: &RowContext) -> Result<AttackBuilder, DiceError> {
        let mut attack = self.in_context(context)?;
        if !context.vulnerable || attack.landing_scale == 2 {
            return Ok(attack);
        }
        attack.landing_scale = 2;
        Ok(attack)
    }

    /// `this` when `context` changes nothing, else this attack with its check re-derived in it.
    fn in_context(&self, context: &RowContext) -> Result<AttackBuilder, DiceError> {
        if self.context_changes_nothing(context) {
            return Ok(self.clone());
        }
        let own = self.row_check();
        let roll_type = if own.pinned {
            own.roll_type
        } else {
            context.roll_type
        };
        let auto_hit = own.auto_hit || context.auto_hit;
        let crit_on_hit = own.auto_crit || context.crit_on_hit;
        let range = self.config()?.range;
        if auto_hit {
            let mut configs = self.check.get_sub_roll_configs();
            if let Some(root) = natural_roll_index(&configs) {
                configs[root].roll_type = roll_type;
            }
            let always = RollBuilder::always_hit_with(
                &RollBuilder::with_configs(&configs),
                AttackConfig {
                    crit_threshold: self.crit_threshold()?,
                    ac: None,
                    range,
                    miss_reroll: None,
                },
            )?;
            return Ok(self.rebuilt(if crit_on_hit {
                always.always_crits()?
            } else {
                always
            }));
        }
        // The same re-derivation as `withCheck`, so a granted modifier matches 0.16 bit for bit.
        let base = self.to_check()?;
        let (literal_roll_type, literal_dice) = match roll_type {
            RollType::ElvenAccuracy => (RollType::Advantage, AdvantageDice::Three),
            RollType::Advantage => (RollType::Advantage, AdvantageDice::Two),
            other => (other, base.advantage_dice),
        };
        let next = Check {
            roll_type: literal_roll_type,
            advantage_dice: literal_dice,
            crit_on_hit,
            ..base
        };
        Ok(self.rebuilt(with_range(Self::build_check(&next)?, range)?))
    }

    /// `sample(rng, context?)`: one roll of this attack as [`Self::under`] weighs it: the check
    /// (the d20s, then the bonus dice), then the landing payload (the base pool, doubled on a
    /// crit, then each separate channel in order), or on a miss the miss payload (`onMiss`), or the
    /// whole hit payload halved and floored (`halfOnMiss`). `alwaysHits().alwaysCrits()` draws no
    /// check, unless the attack has `plusNatural20Damage`. `context.vulnerable` doubles a landing's
    /// total as a whole roll and never redraws.
    pub fn sample(
        &self,
        rng: &mut dyn Rng,
        context: Option<&RowContext>,
    ) -> Result<AttackSample, DiceError> {
        let moved;
        let attack = match context {
            Some(c) => {
                moved = self.in_context(c)?;
                &moved
            }
            None => self,
        };
        let check = &attack.check;
        let mut check_dice: Vec<SampledDie> = Vec::new();
        let mut natural = 0.0;
        let outcome;
        if check.from_always_hit() == Some(true) {
            outcome = AttackOutcome::Crit;
            if !attack.natural20_damage.is_empty() {
                let drawn = sample_check_dice(check, rng)?;
                check_dice = drawn.check;
                natural = drawn.natural;
            }
        } else {
            // `resolveProbabilities`: a natural 1 misses, a natural 20 crits, any other roll has
            // to reach the AC, inside or outside the crit range.
            let drawn = sample_check_dice(check, rng)?;
            check_dice = drawn.check;
            let r = drawn.natural;
            natural = r;
            let threshold = crit_threshold_of(check)?;
            let in_crit_range = r == 20.0 || (r >= 1.0 && r >= threshold);
            let ac = check.attack_config().and_then(|c| c.ac).unwrap_or(0.0);
            outcome = if check.is_always_hit() {
                if in_crit_range {
                    AttackOutcome::Crit
                } else {
                    AttackOutcome::Hit
                }
            } else if r == 1.0 {
                AttackOutcome::Miss
            } else if r == 20.0 {
                AttackOutcome::Crit
            } else if r + check.modifier() + drawn.bonus < ac {
                AttackOutcome::Miss
            } else if check.is_always_crit() || in_crit_range {
                AttackOutcome::Crit
            } else {
                AttackOutcome::Hit
            };
        }
        if outcome == AttackOutcome::Miss
            && let Some(mode) = miss_reroll_of(check)
        {
            return attack.sample_miss_reroll(
                AttackSample {
                    outcome,
                    check: check_dice,
                    damage: Vec::new(),
                    total: 0.0,
                    payload: None,
                },
                mode,
                rng,
                context,
            );
        }
        attack.finish_sample(outcome, natural, check_dice, rng, context)
    }

    /// The payload of a sampled roll: what `outcome` deals (see [`Self::sample`]), the check's
    /// `check_dice` carried along.
    fn finish_sample(
        &self,
        rolled: AttackOutcome,
        natural: f64,
        check_dice: Vec<SampledDie>,
        rng: &mut dyn Rng,
        context: Option<&RowContext>,
    ) -> Result<AttackSample, DiceError> {
        let mut outcome = rolled;
        // `noCrit()`: the crit's weight lands as a hit (`resolveScaled`).
        if outcome == AttackOutcome::Crit && self.crit_effect == CritEffect::None {
            outcome = AttackOutcome::Hit;
        }

        if outcome == AttackOutcome::Miss {
            let mut damage: Vec<SampledDie> = Vec::new();
            let mut total = 0.0;
            let mut draw = |effect: Option<&ActionEffect>| -> Result<(), DiceError> {
                if let Some(effect) = effect {
                    let s = effect.sample(rng)?;
                    total += s.total;
                    damage.extend(s.dice);
                }
                Ok(())
            };
            if self.half_on_miss {
                if let Some(hit) = &self.hit_effect {
                    draw(Some(&self.pooled(hit)?))?;
                }
                for channel in &self.separate_damage {
                    draw(Some(channel))?;
                }
                total = scale_value(total, 0.5, Rounding::Floor, 1.0);
            } else {
                draw(self.miss_effect.as_ref())?;
            }
            return Ok(AttackSample {
                outcome,
                check: check_dice,
                damage,
                total,
                payload: None,
            });
        }
        let landing = if outcome == AttackOutcome::Crit {
            AttackOutcome::Crit
        } else {
            AttackOutcome::Hit
        };
        let payload = self.sample_payload(
            landing,
            rng,
            context,
            outcome == AttackOutcome::Crit && natural == 20.0,
        )?;
        let separate_total = payload.separate.iter().fold(0.0, |sum, s| sum + s.total);
        let total = scale_value(
            payload.base.total + separate_total,
            f64::from(payload.scale),
            Rounding::Floor,
            1.0,
        );
        let mut damage = payload.base.dice.clone();
        for s in &payload.separate {
            damage.extend(s.dice.iter().cloned());
        }
        Ok(AttackSample {
            outcome,
            check: check_dice,
            damage,
            total,
            payload: Some(payload),
        })
    }

    /// `sampleMissReroll(first, mode, rng, context?)`: `first`, a sampled miss, with its d20 rolled
    /// again by `mode` (the bonus dice keep their faces): the new outcome, natural roll and payload.
    /// `first`'s damage is dropped: a rerolled miss deals what the reroll lands as. The d20s it
    /// listed stay in `check`, dropped, and the new one follows them.
    #[allow(
        clippy::needless_pass_by_value,
        reason = "public API called by value from rust/dice-node"
    )]
    pub fn sample_miss_reroll(
        &self,
        first: AttackSample,
        mode: MissRerollMode,
        rng: &mut dyn Rng,
        context: Option<&RowContext>,
    ) -> Result<AttackSample, DiceError> {
        if first.outcome != AttackOutcome::Miss {
            return Err(DiceError::error(
                "sampleMissReroll() rerolls a sampled miss.",
            ));
        }
        let moved;
        let attack = match context {
            Some(c) => {
                moved = self.in_context(c)?;
                &moved
            }
            None => self,
        };
        let check = &attack.check;
        let root = natural_die_config(check)?;
        let root = match root {
            Some(r) if !is_auto_hit_check(check) && r.sides == 20.0 => r,
            _ => {
                return Err(DiceError::error(
                    "sampleMissReroll() needs an attack check with a d20 natural roll.",
                ));
            }
        };
        let read = read_check_dice(check, &first.check)?;
        let (face, new_dice) = sample_die(&die_node_from_config(&root)?, rng);
        // A flat check has one d20 in play: an earlier reroll's new die, not the one it dropped.
        let flat = check.roll_type() == RollType::Flat;
        let current: Vec<_> = read
            .naturals
            .iter()
            .filter(|n| first.check.get(n.index).is_some_and(|d| d.kept))
            .collect();
        let faces: Vec<f64> = if flat && current.len() == 1 {
            current.iter().map(|n| n.face).collect()
        } else {
            read.naturals.iter().map(|n| n.face).collect()
        };
        let max_faces = faces.iter().fold(f64::NEG_INFINITY, |m, f| js_max(m, *f));
        // The others of an advantage roll all missed: only the new die can land, so the best face
        // is the result. A flat check's reroll replaces its d20: only the new die counts.
        let natural = if mode == MissRerollMode::Reroll && flat {
            face
        } else if check.roll_type() == RollType::Disadvantage && mode == MissRerollMode::Reroll {
            js_min(max_faces, face)
        } else {
            js_max(max_faces, face)
        };

        let ac = check.attack_config().and_then(|c| c.ac).unwrap_or(0.0);
        let threshold = crit_threshold_of(check)?;
        let outcome = if natural == 1.0 {
            AttackOutcome::Miss
        } else if natural == 20.0 {
            AttackOutcome::Crit
        } else if natural + check.modifier() + read.bonus < ac {
            AttackOutcome::Miss
        } else if check.is_always_crit() || natural >= threshold {
            AttackOutcome::Crit
        } else {
            AttackOutcome::Hit
        };

        // The d20s as rolled, dropped, then the new one, then the bonus dice; the kept d20 is the
        // first final showing `natural`.
        let rolled = read.rolled.min(first.check.len());
        let mut dice: Vec<SampledDie> = first.check[..rolled]
            .iter()
            .map(|die| SampledDie {
                kept: false,
                ..die.clone()
            })
            .collect();
        dice.extend(new_dice.iter().map(|die| SampledDie {
            kept: false,
            miss_reroll: true,
            ..die.clone()
        }));
        dice.extend(first.check[rolled..].iter().cloned());
        let new_index = (read.rolled + new_dice.len()).checked_sub(1);
        let mut finals: Vec<Option<usize>> = if mode == MissRerollMode::Reroll && flat {
            vec![new_index]
        } else {
            let mut v: Vec<Option<usize>> = read.naturals.iter().map(|n| Some(n.index)).collect();
            v.push(new_index);
            v
        };
        let mut kept = None;
        for index in finals.drain(..) {
            let Some(index) = index else {
                return Err(DiceError::type_error(
                    "Cannot read properties of undefined (reading 'face')",
                ));
            };
            let Some(die) = dice.get(index) else {
                return Err(DiceError::type_error(
                    "Cannot read properties of undefined (reading 'face')",
                ));
            };
            if die.face == natural {
                kept = Some(index);
                break;
            }
        }
        if let Some(k) = kept {
            dice[k].kept = true;
        }
        attack.finish_sample(outcome, natural, dice, rng, context)
    }

    /// `samplePayload(outcome, rng, context?, natural20)`: the dice of one landing's payload as
    /// [`Self::sample`] draws them, split at the base: the base payload (the doubled pool on a crit
    /// unless `onCrit` names one, the `rerollDamageUpTo` budget applied), then each separate
    /// channel, unscaled, then, on a crit with `natural20`, each `plusNatural20Damage` payload;
    /// `scale` is what the landing's total is then multiplied by as a whole roll (2 for a
    /// vulnerable `context`, or an attack [`Self::roll_under`] built for one; else 1).
    pub fn sample_payload(
        &self,
        outcome: AttackOutcome,
        rng: &mut dyn Rng,
        context: Option<&RowContext>,
        natural20: bool,
    ) -> Result<AttackPayloadSample, DiceError> {
        let moved;
        let attack = match context {
            Some(c) => {
                moved = self.in_context(c)?;
                &moved
            }
            None => self,
        };
        let crit = outcome == AttackOutcome::Crit;
        let effect: Option<ActionEffect> = if crit {
            match &attack.crit_effect {
                CritEffect::Roll(c) => Some(c.clone()),
                // `critEffect ?? hitEffect?.copy().doubleDice()`: null and undefined both fall through.
                _ => match &attack.hit_effect {
                    Some(h) => Some(h.copy()?.double_dice()?),
                    None => None,
                },
            }
        } else {
            attack.hit_effect.clone()
        };
        let base = match &effect {
            Some(e) => attack.pooled(e)?.sample(rng)?,
            None => RollSample {
                total: 0.0,
                dice: Vec::new(),
            },
        };
        let mut separate: Vec<RollSample> = Vec::new();
        for channel in &attack.separate_damage {
            separate.push(if crit {
                channel.copy()?.double_dice()?.sample(rng)?
            } else {
                channel.sample(rng)?
            });
        }
        if crit && natural20 {
            for extra in &attack.natural20_damage {
                separate.push(extra.sample(rng)?);
            }
        }
        Ok(AttackPayloadSample {
            base,
            separate,
            scale: if context.is_some_and(|c| c.vulnerable) || attack.landing_scale == 2 {
                2
            } else {
                1
            },
        })
    }

    /// `onEveryHit(grants, gate?)`: carries a condition into a turn: every time this attack lands,
    /// the grants apply to later attack rolls (optionally gated by a save or a chance, or given as
    /// one `save()` value). The receiver is unchanged.
    pub fn on_every_hit(&self, grants: impl Into<Grants>) -> Result<AttackBuilder, DiceError> {
        self.on_every_hit_with(grants, None)
    }

    /// [`AttackBuilder::on_every_hit`] with a save or chance gate.
    pub fn on_every_hit_with(
        &self,
        grants: impl Into<Grants>,
        gate: Option<ConditionGate>,
    ) -> Result<AttackBuilder, DiceError> {
        self.attach(AttachedOn::EveryHit, grants.into(), gate)
    }

    /// `onAnyCrit(grants, gate?)`: every time this attack crits, the grants apply to later attack
    /// rolls.
    pub fn on_any_crit(&self, grants: impl Into<Grants>) -> Result<AttackBuilder, DiceError> {
        self.on_any_crit_with(grants, None)
    }

    /// [`AttackBuilder::on_any_crit`] with a save or chance gate.
    pub fn on_any_crit_with(
        &self,
        grants: impl Into<Grants>,
        gate: Option<ConditionGate>,
    ) -> Result<AttackBuilder, DiceError> {
        self.attach(AttachedOn::AnyCrit, grants.into(), gate)
    }

    /// `onFirstCrit(grants, gate?)`: the first time this attack crits, the effects apply.
    pub fn on_first_crit(&self, grants: impl Into<Grants>) -> Result<AttackBuilder, DiceError> {
        self.on_first_crit_with(grants, None)
    }

    /// [`AttackBuilder::on_first_crit`] with a save or chance gate.
    pub fn on_first_crit_with(
        &self,
        grants: impl Into<Grants>,
        gate: Option<ConditionGate>,
    ) -> Result<AttackBuilder, DiceError> {
        self.attach(AttachedOn::FirstCrit, grants.into(), gate)
    }

    /// The shared implementation of the attachment verbs. A `save()` value is unpacked into grants
    /// and gate.
    fn attach(
        &self,
        on: AttachedOn,
        grants: Grants,
        gate: Option<ConditionGate>,
    ) -> Result<AttackBuilder, DiceError> {
        let list = match grants {
            Grants::Gated(gated) => {
                let (effects, options) = unpack_save(&gated, gate.unwrap_or_default())?;
                return self.attach(on, Grants::Many(effects), Some(options));
            }
            Grants::One(l) => vec![l],
            Grants::Many(v) => v,
        };
        let mut attached = self.attached.clone();
        attached.push(AttachedCondition {
            on,
            grants: list,
            gate,
        });
        Ok(AttackBuilder::from(AttackBuilderData {
            attached,
            ..self.derived()
        }))
    }

    /// `toCheck()`: this attack's check as the plain-data [`Check`] `withCheck` rewrites.
    fn to_check(&self) -> Result<Check, DiceError> {
        let check = &self.check;
        if check.is_always_hit() {
            return Err(DiceError::error(
                "withCheck() requires an AC-bearing check; this attack always hits with no AC to rebind.",
            ));
        }
        let config = self.config()?;
        let Some(ac) = config.ac else {
            return Err(DiceError::error(
                "withCheck() requires an AC-bearing check; this attack's crit-on-hit override carries no AC.",
            ));
        };
        let raw_roll_type = check
            .get_root_die_config()
            .map_or(RollType::Flat, |c| c.roll_type);
        let from_elven = raw_roll_type == RollType::ElvenAccuracy;
        Ok(Check {
            roll: RollBuilder::with_configs(&check.get_sub_roll_configs()),
            ac,
            crit_threshold: config.crit_threshold,
            roll_type: if from_elven {
                RollType::Advantage
            } else {
                raw_roll_type
            },
            advantage_dice: if from_elven {
                AdvantageDice::Three
            } else {
                check.advantage_dice().unwrap_or(AdvantageDice::Two)
            },
            crit_on_hit: check.is_always_crit(),
            miss_reroll: miss_reroll_of(check),
        })
    }

    /// `buildCheck(next)`: the `ac()` (or `alwaysCrits()`) check a [`Check`] describes.
    fn build_check(next: &Check) -> Result<RollBuilder, DiceError> {
        if next.ac.is_nan() {
            return Err(DiceError::error("Invalid NaN value for AC in withCheck()"));
        }
        require_finite(next.ac, "AC in withCheck()")?;
        require_finite(next.crit_threshold, "crit threshold in withCheck()")?;
        let mut configs = next.roll.get_sub_roll_configs();
        if !configs.is_empty() {
            let idx = natural_roll_index(&configs).unwrap_or(0);
            configs[idx].roll_type = next.roll_type;
        }
        let mut ac = RollBuilder::with_configs(&configs)
            .ac(next.ac)?
            .crit_on(next.crit_threshold)?;
        if next.advantage_dice == AdvantageDice::Three {
            ac = ac.three_dice_advantage()?;
        }
        if let Some(mode) = next.miss_reroll {
            ac = ac.reroll_misses(mode)?;
        }
        if next.crit_on_hit {
            ac.always_crits()
        } else {
            Ok(ac)
        }
    }

    /// `baseTransform`: `config` under a `rerollDamage` threshold and a `minimumDamageDie` floor
    /// (either may be unset). Each only ever raises a group's own `minimum`/`reroll`, and the reroll
    /// cap reads the final floor, so applying it again after the other call lands on the same
    /// config whichever order the two calls came in. `Err` (ADR-017) on a die of over 1e6 sides.
    fn base_transform(
        config: &RollConfig,
        threshold: Option<f64>,
        minimum: Option<f64>,
    ) -> Result<RollConfig, DiceError> {
        let floor = match minimum {
            None => config.minimum,
            Some(m) => js_max(config.minimum, m),
        };
        let Some(threshold) = threshold else {
            return Ok(RollConfig {
                minimum: floor,
                ..config.clone()
            });
        };
        if config.sides > MAX_ENUMERATED {
            return Err(DiceError::error(format!(
                "rerollDamage(): a die of {} sides is too large to enumerate (at most 1000000).",
                num_to_string(config.sides)
            )));
        }
        // Face f is worth rerolling iff max(f, floor) < E[max(X, floor)] = total / sides; the kept
        // value never falls as f rises, so the worthwhile faces are exactly 1..cap.
        let mut total = 0.0;
        let mut f = 1.0;
        while f <= config.sides {
            total += js_max(f, floor);
            f += 1.0;
        }
        let mut cap = 0.0;
        let mut f = 1.0;
        while f <= config.sides {
            if js_max(f, floor) * config.sides < total {
                cap = f;
            }
            f += 1.0;
        }
        Ok(RollConfig {
            minimum: floor,
            reroll: js_max(config.reroll, js_min(threshold, cap)),
            ..config.clone()
        })
    }

    /// Applies the `rerollDamage`/`minimumDamageDie` values already set on this builder to `effect`.
    fn with_stored_base_transforms(&self, effect: ActionEffect) -> Result<ActionEffect, DiceError> {
        if self.reroll_threshold.is_none() && self.minimum_die_value.is_none() {
            return Ok(effect);
        }
        let name = if self.reroll_threshold.is_some() {
            "rerollDamage"
        } else {
            "minimumDamageDie"
        };
        Self::map_every_die_group(&effect, name, &|c: &RollConfig| {
            Self::base_transform(c, self.reroll_threshold, self.minimum_die_value)
        })
    }

    /// Refuses a payload with no dice descriptor: a parsed string or a
    /// half/scale/maxOf/pooled/composite roll.
    fn require_dice_descriptor(effect: &ActionEffect, method_name: &str) -> Result<(), DiceError> {
        if effect.cache_key().is_none() {
            return Err(DiceError::error(format!(
                "{method_name}() requires a dice descriptor: a parsed string or a half/scale/maxOf/pooled/composite payload has none."
            )));
        }
        Ok(())
    }

    /// Refuses a payload `rerollUpTo` cannot pool: no dice descriptor, or dice that are not plain
    /// (a keep, a roll type, explode).
    fn require_plain_dice(effect: &ActionEffect, method_name: &str) -> Result<(), DiceError> {
        Self::require_dice_descriptor(effect, method_name)?;
        effect
            .to_ast()
            .and_then(|node| rerollable_pool(&node))
            .map(|_| ())
            .map_err(|error| {
                // The TS rethrows every class as a plain `Error` with `rerollUpTo()` renamed.
                let message = error.message();
                DiceError::error(match message.strip_prefix("rerollUpTo()") {
                    Some(rest) => format!("{method_name}(){rest}"),
                    None => message.to_string(),
                })
            })
    }

    /// `effect`, a plain roll of the base payload's dice, with the stored `rerollDamageUpTo` budget
    /// applied.
    fn pooled(&self, effect: &ActionEffect) -> Result<ActionEffect, DiceError> {
        match self.reroll_pool {
            Some(pool) => effect.reroll_up_to(
                pool.budget,
                Some(&RollRerollUpToOptions {
                    rolls: Some(pool.rolls),
                    rolled_once: None,
                }),
            ),
            None => Ok(effect.clone()),
        }
    }

    /// Shared by `rerollDamage`/`minimumDamageDie`: rewrite every die-bearing `RollConfig` of a
    /// base-payload effect. Refuses an effect with no real dice descriptor.
    fn map_every_die_group(
        effect: &ActionEffect,
        method_name: &str,
        map_config: &dyn Fn(&RollConfig) -> Result<RollConfig, DiceError>,
    ) -> Result<ActionEffect, DiceError> {
        Self::require_dice_descriptor(effect, method_name)?;
        let mut configs = Vec::new();
        for c in effect.get_sub_roll_configs() {
            configs.push(if c.sides > 0.0 { map_config(&c)? } else { c });
        }
        Ok(RollBuilder::with_configs(&configs))
    }

    /// `toExpression()`: the attack as a string `parse()` reads back to the same outcomes, up to
    /// the natural-1 miss and natural-20 hit, which the grammar does not model. The crit clause is
    /// always printed. `Err` for `plusSeparateDamage`, `halfOnMiss`, `plusNatural20Damage` and
    /// `rerollDamageUpTo`, which the grammar cannot spell.
    pub fn to_expression(&self) -> Result<String, DiceError> {
        if !self.separate_damage.is_empty() || self.half_on_miss {
            return Err(DiceError::error(
                "toExpression() cannot represent plusSeparateDamage() or halfOnMiss(): the expression grammar has no separate damage channel or half-on-miss clause. Use toPMF() instead.",
            ));
        }
        if !self.natural20_damage.is_empty() {
            return Err(DiceError::error(
                "toExpression() cannot represent plusNatural20Damage(): the expression grammar has no natural-20 clause. Use toPMF() instead.",
            ));
        }
        if self.reroll_pool.is_some() {
            return Err(DiceError::error(
                "toExpression() cannot represent rerollDamageUpTo(): the expression grammar has no reroll-up-to-k syntax. Use toPMF() instead.",
            ));
        }
        let check = &self.check;
        let natural_roll = root_die_expression(check)?;
        let config = self.config()?;
        let check_part = if check.is_always_crit() && check.from_always_hit() == Some(false) {
            let total = if miss_reroll_of(check).is_none() {
                check_expression(check)?
            } else {
                miss_reroll_check_expression(check)?
            };
            format!("({total} AC {})", num_to_string(config.ac.unwrap_or(0.0)))
        } else if check.is_always_hit() || check.is_always_crit() {
            match &natural_roll {
                Some(n) => n.clone(),
                None => check.to_expression()?,
            }
        } else {
            check.to_expression()?
        };

        let mut effect_part = String::new();
        if let Some(hit) = &self.hit_effect {
            let hit_expression = hit.to_expression()?;
            effect_part = format!("({hit_expression})");
            if self.crit_effect == CritEffect::None {
                let _ = write!(effect_part, " xcrit0 ({hit_expression})");
            } else {
                // A crit doubles the hit payload's dice: parsed and pooled payloads included.
                let crit_expression = match &self.crit_effect {
                    CritEffect::Roll(c) => c.to_expression()?,
                    _ => hit.copy()?.double_dice()?.to_expression()?,
                };
                let crit_threshold = config.crit_threshold;
                if crit_threshold < 1.0 || crit_threshold > 20.0 {
                    return Err(DiceError::error(format!(
                        "Invalid crit threshold: {}. Must be between 1 and 20.",
                        num_to_string(crit_threshold)
                    )));
                }
                if check.is_always_crit() && natural_roll.is_some() {
                    let root = check.get_root_die_config().ok_or_else(|| {
                        DiceError::type_error(
                            "Cannot read properties of undefined (reading 'sides')",
                        )
                    })?;
                    let _ = write!(
                        effect_part,
                        " xcrit{} ({crit_expression})",
                        num_to_string(root.sides)
                    );
                } else if crit_threshold == 20.0 {
                    let _ = write!(effect_part, " crit ({crit_expression})");
                } else {
                    let _ = write!(
                        effect_part,
                        " xcrit{} ({crit_expression})",
                        num_to_string(21.0 - crit_threshold)
                    );
                }
            }
            if let Some(miss) = &self.miss_effect {
                let _ = write!(effect_part, " miss ({})", miss.to_expression()?);
            }
        }
        Ok(format!("{check_part} * {effect_part}"))
    }

    /// `resolveProbabilities(check, eps)`: hit, crit and miss weights of `check`. A natural 1
    /// misses; a natural 20 hits and crits whatever the AC, the crit threshold, or crit-on-hit; any
    /// other natural roll hits when the total reaches the AC, and crits when it is in the crit range
    /// (or every hit crits: `alwaysCrits()`). An always-hitting check crits on a natural 20 or in
    /// its crit range. A check with no die has no natural roll: it hits exactly when its flat total
    /// and bonus dice reach the AC and never crits unless every hit does.
    pub fn resolve_probabilities(
        check: &RollBuilder,
        eps: f64,
    ) -> Result<AttackProbabilities, DiceError> {
        let crit_threshold = crit_threshold_of(check)?;
        let natural = resolve_root_d20(check)?;
        // A dieless check's natural roll is a certain 0: never a natural 1 or 20, never in crit range.
        let in_crit_range = |r: f64| r == 20.0 || (r >= 1.0 && r >= crit_threshold);

        if check.from_always_hit() == Some(true) {
            return Ok(AttackProbabilities {
                p_success: 1.0,
                p_hit: 0.0,
                p_crit: 1.0,
                p_miss: 0.0,
            });
        }

        if check.is_always_hit() {
            let mut p_crit = 0.0;
            let mut p_hit = 0.0;
            for (r, bin) in &natural.map {
                if in_crit_range(r.0) {
                    p_crit += bin.p;
                } else {
                    p_hit += bin.p;
                }
            }
            return Ok(AttackProbabilities {
                p_success: 1.0,
                p_hit,
                p_crit,
                p_miss: 0.0,
            });
        }

        // An AC check, or one where every hit crits (`alwaysCrits()` / a crit-on-hit grant).
        let crit_on_hit = check.is_always_crit();
        let ac = check.attack_config().and_then(|c| c.ac).unwrap_or(0.0);
        let static_mod = check.modifier();
        let bonus_pmfs = check.get_bonus_dice_pmfs(check, eps)?;
        let bonus = if bonus_pmfs.is_empty() {
            Pmf::delta(0.0, eps)?
        } else {
            Pmf::convolve_many(&bonus_pmfs, eps)
        };

        let mut pcrit = 0.0;
        let mut phit = 0.0;
        let mut pmiss = 0.0;

        for (r, bin) in &natural.map {
            let r = r.0;
            let pr = bin.p;
            if pr <= 0.0 {
                continue;
            }
            if r == 1.0 {
                pmiss += pr;
                continue;
            }
            if r == 20.0 {
                pcrit += pr;
                continue;
            }
            // Any other roll has to reach the AC to hit at all, even inside an expanded crit range.
            let split = split_at_threshold(&bonus, ac - static_mod - r);
            if crit_on_hit || in_crit_range(r) {
                pcrit += pr * split.at_least;
            } else {
                phit += pr * split.at_least;
            }
            pmiss += pr * split.below;
        }

        // `rerollMisses`: a miss is rolled again, and the reroll lands as a hit or a crit, or
        // misses for good.
        if let Some(mode) = miss_reroll_of(check) {
            let rerolled = miss_reroll_odds(check, mode, eps)?;
            phit += rerolled.hit;
            pcrit += rerolled.crit;
            pmiss = rerolled.miss;
        }

        Ok(AttackProbabilities {
            p_success: phit + pcrit,
            p_hit: phit,
            p_crit: pcrit,
            p_miss: pmiss,
        })
    }

    /// `resolve(eps = 0)`: the attack's weighted slices. No reachable damage value is pruned at 0.
    pub fn resolve(&self, eps: f64) -> Result<AttackResolution, DiceError> {
        self.resolve_scaled(eps, self.landing_scale)
    }

    /// `resolveScaled`: [`Self::resolve`], with the hit and crit damage of `pmf` multiplied by
    /// `landing_scale` as a whole roll (2: a vulnerable target). The miss and every other field are
    /// unscaled.
    fn resolve_scaled(&self, eps: f64, landing_scale: u8) -> Result<AttackResolution, DiceError> {
        let weights = Self::resolve_probabilities(&self.check, eps)?;
        // The kept d20 shows a natural 20 on the as-rolled share of the crits, and on the reroll's
        // own share.
        let check = &self.check;
        let rerolled = match miss_reroll_of(check) {
            Some(mode) if !check.is_always_hit() => miss_reroll_odds(check, mode, eps)?.natural20,
            _ => 0.0,
        };
        let natural20 = resolve_root_d20(check)?.p_at(20.0) + rerolled;
        self.resolve_weighted(
            eps,
            landing_scale,
            SliceWeights {
                p_hit: weights.p_hit,
                p_crit: weights.p_crit,
                p_miss: weights.p_miss,
                natural20_share: if weights.p_crit > 0.0 {
                    js_min(1.0, natural20 / weights.p_crit)
                } else {
                    0.0
                },
            },
        )
    }

    /// `toEffectPMF(effect)`: a parsed string through its own PMF, a builder through the AST.
    fn effect_pmf(effect: &ActionEffect, eps: f64) -> Result<Pmf, DiceError> {
        if effect.is_parsed() {
            effect.to_pmf(eps)
        } else {
            pmf_from_roll_builder(effect, eps)
        }
    }

    /// `resolveWeighted`: the attack's slices at the given weights: `natural20_share` of the crit
    /// branch deals `plusNatural20Damage`. [`Self::resolve_scaled`] gives the weights of a roll;
    /// [`Self::miss_rerolled`] those of a rerolled miss.
    fn resolve_weighted(
        &self,
        eps: f64,
        landing_scale: u8,
        weights: SliceWeights,
    ) -> Result<AttackResolution, DiceError> {
        let SliceWeights {
            p_hit,
            p_crit,
            p_miss: pmiss,
            natural20_share,
        } = weights;

        let hit_base_pmf = match &self.hit_effect {
            Some(h) => Self::effect_pmf(&self.pooled(h)?, eps)?,
            None => Pmf::delta(0.0, eps)?,
        };

        let mut crit_base_pmf: Option<Pmf> = None;
        let mut phit = p_hit;
        let mut pcrit = p_crit;

        if self.crit_effect == CritEffect::None {
            phit += pcrit;
            pcrit = 0.0;
        } else {
            // Every damage payload with dice doubles them on a crit. `Err` for a parsed payload
            // that contains an attack check, which is not damage.
            let crit_builder: Option<ActionEffect> = match &self.crit_effect {
                CritEffect::Roll(c) => Some(c.clone()),
                _ => match &self.hit_effect {
                    Some(h) => Some(h.copy()?.double_dice()?),
                    None => None,
                },
            };
            if let Some(cb) = crit_builder {
                crit_base_pmf = Some(Self::effect_pmf(&self.pooled(&cb)?, eps)?);
            }
        }

        // `plusSeparateDamage` channels convolve into hit AND crit: their dice double on a crit
        // like any attack damage (including under an explicit `onCrit`), but never feed the
        // base-payload transforms above. `plusNatural20Damage` joins the crit channels on the
        // natural-20 share of the crit branch; with it and no channel the channels are `delta(0)`.
        let has_channels = !self.separate_damage.is_empty() || !self.natural20_damage.is_empty();
        let convolve_channels = |channels: &[RollBuilder]| -> Result<Pmf, DiceError> {
            if channels.is_empty() {
                return Pmf::delta(0.0, eps);
            }
            let mut list = Vec::with_capacity(channels.len());
            for r in channels {
                list.push(Self::effect_pmf(r, eps)?);
            }
            Ok(Pmf::convolve_many(&list, eps))
        };
        let hit_channels_pmf = if has_channels {
            Some(convolve_channels(&self.separate_damage)?)
        } else {
            None
        };
        // A natural 20 always crits, so the crits that deal `plusNatural20Damage` are the share
        // P(natural 20) / P(crit) of the crit branch.
        let with_natural20 = |channels: Pmf| -> Result<Pmf, DiceError> {
            if self.natural20_damage.is_empty()
                || pcrit.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
            {
                return Ok(channels);
            }
            let share = natural20_share;
            if share <= 0.0 {
                return Ok(channels);
            }
            let dealt = Pmf::convolve_many(
                &[channels.clone(), convolve_channels(&self.natural20_damage)?],
                eps,
            );
            Ok(if share >= 1.0 {
                dealt
            } else {
                channels
                    .scale_mass(1.0 - share)
                    .add(&dealt.scale_mass(share))
            })
        };
        let mut crit_channels_pmf: Option<Pmf> = None;
        let mut crit_pmf: Option<Pmf> = crit_base_pmf.clone();
        if let (Some(crit_base), true) = (&crit_base_pmf, has_channels) {
            let attempt = || -> Result<(Pmf, Pmf), DiceError> {
                let mut doubled = Vec::with_capacity(self.separate_damage.len());
                for r in &self.separate_damage {
                    doubled.push(r.copy()?.double_dice()?);
                }
                let channels = with_natural20(convolve_channels(&doubled)?)?;
                let combined = Pmf::convolve_many(&[crit_base.clone(), channels.clone()], eps);
                Ok((channels, combined))
            };
            match attempt() {
                Ok((channels, combined)) => {
                    crit_channels_pmf = Some(channels);
                    crit_pmf = Some(combined);
                }
                Err(error) => {
                    if pcrit > 0.0 || !matches!(error, DiceError::AmbiguousCritDoubling(_)) {
                        return Err(error);
                    }
                    crit_pmf = None;
                }
            }
        }

        let hit_pmf = match &hit_channels_pmf {
            Some(channels) => Pmf::convolve_many(&[hit_base_pmf.clone(), channels.clone()], eps),
            None => hit_base_pmf.clone(),
        };

        let (miss_pmf, miss_is_damage) = if self.half_on_miss {
            // Half of the RESOLVED hit payload (base + every separate channel), never the crit payload.
            (hit_pmf.scale_damage(0.5, "floor", 1.0)?, true)
        } else if let Some(miss) = &self.miss_effect {
            (Self::effect_pmf(miss, eps)?, true)
        } else {
            (Pmf::delta(0.0, eps)?, false)
        };

        // Weight the hit/crit/miss PMFs into the final mixture.
        let mut mix = Mixture::new(eps);
        let scaled = |pmf: &Pmf| -> Result<Pmf, DiceError> {
            if landing_scale == 1 {
                Ok(pmf.clone())
            } else {
                pmf.scale_damage(f64::from(landing_scale), "floor", 1.0)
            }
        };
        if phit > 0.0 {
            mix.add("hit", &scaled(&hit_pmf)?, phit);
        }
        if let Some(crit) = &crit_pmf
            && pcrit > 0.0
        {
            mix.add("crit", &scaled(crit)?, pcrit);
        }
        if pmiss > 0.0 {
            mix.add(
                if miss_is_damage {
                    "missDamage"
                } else {
                    "missNone"
                },
                &miss_pmf,
                pmiss,
            );
        }

        let zero = || Pmf::delta(0.0, eps);
        Ok(AttackResolution {
            pmf: mix.build_pmf(eps)?,
            check: self.check.to_pmf(eps)?,
            hit: hit_pmf,
            crit: match &crit_pmf {
                Some(p) => p.clone(),
                None => zero()?,
            },
            miss: miss_pmf,
            hit_base: hit_base_pmf,
            crit_base: match &crit_base_pmf {
                Some(p) => p.clone(),
                None => zero()?,
            },
            hit_separate: match &hit_channels_pmf {
                Some(p) => p.clone(),
                None => zero()?,
            },
            crit_separate: match &crit_channels_pmf {
                Some(p) => p.clone(),
                None => zero()?,
            },
            weights: AttackWeights {
                hit: phit,
                crit: pcrit,
                miss: pmiss,
            },
        })
    }

    /// `diceMatchInfo(eps)`: for `dice-match` trigger slicing: the exact per-damage-value match
    /// probability for the hit and crit branches, or `None` per branch when no descriptor is
    /// available ([`Self::dice_match_refusals`] says why). "The dice" of a branch are the dice of its
    /// base payload that land: one plain pool of dice of one kind, a match being two or more
    /// showing the same face. A single die is a supported source that can never match (an empty
    /// map). Reads only the base pool: `plusSeparateDamage` channels never count toward a match.
    pub fn dice_match_info(
        &self,
        _eps: f64,
    ) -> Result<(Option<DiceMatchInfo>, Option<DiceMatchInfo>), DiceError> {
        let (hit, crit) = self.match_descriptors()?;
        let info = |d: Descriptor| match d {
            Descriptor::Info(i) => Some(i),
            Descriptor::Refusal(_) => None,
        };
        Ok((info(hit), info(crit)))
    }

    /// `diceMatchRefusals()`: why [`Self::dice_match_info`] has no descriptor for a branch, in
    /// words a `Turn` puts in its error: `None` for a branch that has one.
    pub fn dice_match_refusals(&self) -> Result<(Option<String>, Option<String>), DiceError> {
        let (hit, crit) = self.match_descriptors()?;
        let why = |d: Descriptor| match d {
            Descriptor::Refusal(s) => Some(s),
            Descriptor::Info(_) => None,
        };
        Ok((why(hit), why(crit)))
    }

    /// Each branch's descriptor, or the reason it has none.
    fn match_descriptors(&self) -> Result<(Descriptor, Descriptor), DiceError> {
        let hit = self.match_info_for_effect(self.hit_effect.as_ref(), self.reroll_pool)?;

        let crit = match &self.crit_effect {
            CritEffect::None => Descriptor::Refusal("it cannot crit (noCrit())".to_string()),
            CritEffect::Roll(c) => self.match_info_for_effect(Some(c), self.reroll_pool)?,
            CritEffect::Auto
                if self
                    .hit_effect
                    .as_ref()
                    .is_some_and(super::roll::RollBuilder::is_parsed) =>
            {
                self.match_info_for_effect(self.hit_effect.as_ref(), self.reroll_pool)?
            }
            CritEffect::Auto => {
                let doubled = match &self.hit_effect {
                    Some(h) => match h.copy()?.double_dice() {
                        Ok(d) => Ok(Some(d)),
                        // An ambiguous keep or advantage payload has no doubled crit, so no crit
                        // descriptor either.
                        Err(DiceError::AmbiguousCritDoubling(_)) => Err(()),
                        Err(e) => return Err(e),
                    },
                    None => Ok(None),
                };
                match doubled {
                    Err(()) => Descriptor::Refusal(
                        "the damage has no single doubled form (a keep, bestOf or advantage pool)"
                            .to_string(),
                    ),
                    Ok(d) => self.match_info_for_effect(d.as_ref(), self.reroll_pool)?,
                }
            }
        };
        Ok((hit, crit))
    }

    fn match_info_for_effect(
        &self,
        effect: Option<&RollBuilder>,
        attack_pool: Option<RerollPoolSpec>,
    ) -> Result<Descriptor, DiceError> {
        struct Kind {
            weights: Vec<f64>,
            label: String,
            count: f64,
            above_faces: Option<String>,
        }

        let refuse = |s: &str| Ok(Descriptor::Refusal(s.to_string()));
        let Some(effect) = effect else {
            return refuse("the damage rolls no dice");
        };
        if effect.is_parsed() {
            return refuse(
                "the damage is a string expression, which has no dice to read (build it with roll())",
            );
        }
        // A payload that is itself a `rerollUpTo` pool carries its budget; an attack's own budget
        // is applied to a plain payload (the two never meet: `rerollDamageUpTo` refuses a pooled
        // payload).
        let mut pool = attack_pool;
        if matches!(effect.kind(), RollKind::RerollUpTo { .. }) {
            if let ExpressionNode::RerollUpTo(node) = effect.to_ast()? {
                if node.rolled_once.is_some() {
                    return refuse(
                        "the damage is a rerollUpTo pool with dice rolled once beside dice rolled again, whose match odds are not modelled",
                    );
                }
                pool = Some(RerollPoolSpec {
                    budget: node.budget,
                    rolls: node.rolls,
                });
            }
        } else if effect.cache_key().is_none() {
            // `cacheKey() === null` is exactly the signal for "PMF not fully captured by
            // subRollConfigs" (half/scale/maxOf/pooled/composite).
            return refuse(
                "the damage is a half(), scaleResult(), maxOf(), pooled or summed roll, whose dice are not one plain pool",
            );
        }

        let configs = effect.get_sub_roll_configs();
        let dice_configs: Vec<&RollConfig> = configs.iter().filter(|c| c.sides > 0.0).collect();
        if dice_configs.is_empty() {
            return refuse("the damage rolls no dice");
        }
        for config in &dice_configs {
            if config.keep.is_some() || config.best_of > 0.0 {
                return refuse(
                    "the damage keeps some of its dice (keepHighest, keepLowest or bestOf), so which dice match is ambiguous",
                );
            }
            if config.explode > 0.0 || config.explode_pool_budget > 0.0 {
                return refuse(
                    "the damage explodes, so extra dice join its total and its pool has no fixed size",
                );
            }
            if config.roll_type != RollType::Flat {
                return refuse(
                    "the damage rolls a die with advantage or disadvantage: one kept die, not a pool",
                );
            }
            if config.is_subtraction == Some(true) || config.count < 0.0 {
                return refuse(
                    "the damage subtracts dice, whose faces lower it instead of adding to it",
                );
            }
        }

        // Groups whose dice show the same faces with the same odds are one pool; a group with no
        // dice rolls nothing. Two kinds left is a pool whose match is undefined.
        let mut kinds: IndexMap<String, Kind> = IndexMap::new();
        for config in &dice_configs {
            if config.count <= 0.0 {
                continue;
            }
            if config.sides > MAX_ENUMERATED {
                return refuse(
                    "the damage's die has too many faces to enumerate its match odds exactly",
                );
            }
            let weights = face_weights(config.sides, config.minimum, config.reroll);
            let key = weights
                .iter()
                .map(|w| num_to_string(*w))
                .collect::<Vec<_>>()
                .join(",");
            let kind = kinds.entry(key).or_insert_with(|| Kind {
                weights,
                label: format!(
                    "d{}{}{}",
                    num_to_string(config.sides),
                    if config.minimum > 1.0 {
                        format!(" minimum {}", num_to_string(config.minimum))
                    } else {
                        String::new()
                    },
                    if config.reroll > 0.0 {
                        format!(" reroll {}", num_to_string(config.reroll))
                    } else {
                        String::new()
                    }
                ),
                count: 0.0,
                above_faces: None,
            });
            kind.count += config.count;
            // `faceWeights` puts a minimum above the die's faces on its top face; the die really
            // shows the minimum.
            if config.minimum > config.sides {
                kind.above_faces = Some(format!(
                    "a minimum of {} on a d{}",
                    num_to_string(config.minimum),
                    num_to_string(config.sides)
                ));
            }
        }
        if kinds.len() > 1 {
            let labels = kinds
                .values()
                .map(|k| k.label.clone())
                .collect::<Vec<_>>()
                .join(" and ");
            return Ok(Descriptor::Refusal(format!(
                "the damage rolls dice of different kinds ({labels}), and which of them must match is not defined"
            )));
        }
        let kind = kinds.into_values().next();

        // A single die is a SUPPORTED source that can simply never match: `None` is reserved for
        // "no descriptor available at all". An empty map answers every lookup with the correct zero.
        let Some(kind) = kind.filter(|k| k.count > 1.0) else {
            return Ok(Descriptor::Info(DiceMatchInfo {
                match_probability_by_damage: IndexMap::new(),
            }));
        };
        if let Some(above) = &kind.above_faces {
            return Ok(Descriptor::Refusal(format!(
                "the damage has {above}, above the die's own faces"
            )));
        }
        if too_big(kind.count, kind.weights.len() as f64) {
            return Ok(Descriptor::Refusal(format!(
                "the damage is a pool of {} dice of {} faces, too many to enumerate its match odds exactly (at most {} dice times faces)",
                num_to_string(kind.count),
                kind.weights.len(),
                num_to_string(MAX_DICE_FACES)
            )));
        }

        let modifier = configs.iter().fold(0.0, |sum, c| sum + c.modifier);
        let mut by_damage: IndexMap<Damage, f64> = IndexMap::new();

        // A pool that rerolls no die lands the dice it rolled: with `{ rolls: n }` too, since the
        // roll kept is chosen by its total alone, which leaves the dice of a given total as they were.
        let rerolls_nothing = match pool {
            None => true,
            Some(p) => js_min(p.budget.floor(), kind.count) <= 0.0,
        };
        if rerolls_nothing {
            let total_dist = dice_sum_distribution(kind.count, &kind.weights);
            let joint = joint_sum_and_match(kind.count, &kind.weights);
            for (sum, total_mass) in &total_dist {
                if *total_mass <= 0.0 {
                    continue;
                }
                let match_mass = joint.get(sum).copied().unwrap_or(0.0);
                by_damage.insert(Damage(sum.0 + modifier), match_mass / total_mass);
            }
            return Ok(Descriptor::Info(DiceMatchInfo {
                match_probability_by_damage: by_damage,
            }));
        }

        let Some(pool) = pool else {
            return Ok(Descriptor::Info(DiceMatchInfo {
                match_probability_by_damage: by_damage,
            }));
        };
        let rerolled = reroll_up_to_match(
            &PoolDieKind {
                values: (0..kind.weights.len()).map(|i| (i + 1) as f64).collect(),
                probs: kind.weights.clone(),
                count: kind.count,
            },
            pool.budget,
            pool.rolls,
        )?;
        let Some(rerolled) = rerolled else {
            return Ok(Descriptor::Refusal(format!(
                "the damage is a rerollUpTo pool of {} dice, too many to enumerate its match odds exactly",
                num_to_string(kind.count)
            )));
        };
        for (sum, total_mass) in &rerolled.total {
            if *total_mass <= 0.0 {
                continue;
            }
            let match_mass = rerolled.match_.get(sum).copied().unwrap_or(0.0);
            by_damage.insert(
                Damage(sum.0 + modifier),
                js_min(1.0, match_mass / total_mass),
            );
        }
        Ok(Descriptor::Info(DiceMatchInfo {
            match_probability_by_damage: by_damage,
        }))
    }

    /// `toPMF(eps = 0)`.
    pub fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        self.to_pmf_shared(eps).map(|p| (*p).clone())
    }

    /// [`AttackBuilder::to_pmf`] through `attackPMFCache` (keyed by [`AttackBuilder::cache_key`]),
    /// returning the cached `Arc`.
    pub fn to_pmf_shared(&self, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        let key = self.cache_key(eps);
        ATTACK_CACHE.get_or_compute(key.as_deref(), || Ok(self.resolve(eps)?.pmf))
    }

    /// `cacheKey(eps)`: a cheap string that fully determines this attack's PMF (the check, every
    /// payload's roll key, the crit and miss reading, channels, half-on-miss, the reroll pool and
    /// the landing scale), or `None` when a payload opted out (parsed, pooled, half, scaled, ...).
    pub fn cache_key(&self, eps: f64) -> Option<String> {
        let (bits, key) = self
            .0
            .key
            .get_or_init(|| (eps.to_bits(), self.compute_cache_key(eps)));
        if *bits == eps.to_bits() {
            key.clone()
        } else {
            self.compute_cache_key(eps)
        }
    }

    fn compute_cache_key(&self, eps: f64) -> Option<String> {
        let check_key = self.check.cache_key()?;
        let hit_key = match &self.hit_effect {
            Some(e) => e.cache_key()?,
            None => String::new(),
        };
        let crit_key = match &self.crit_effect {
            CritEffect::None => "n".to_string(),
            CritEffect::Auto => "a".to_string(),
            CritEffect::Roll(e) => e.cache_key()?,
        };
        let miss_key = match &self.miss_effect {
            Some(e) => e.cache_key()?,
            None => String::new(),
        };
        let mut channels_key = String::new();
        for r in &self.separate_damage {
            channels_key.push('|');
            channels_key.push_str(&r.cache_key()?);
        }
        let mut natural20_key = String::new();
        for r in &self.natural20_damage {
            natural20_key.push('|');
            natural20_key.push_str(&r.cache_key()?);
        }
        let pool_key = match &self.reroll_pool {
            Some(p) => format!("{}x{}", num_to_string(p.budget), num_to_string(p.rolls)),
            None => String::new(),
        };
        Some(format!(
            "{check_key}*H{hit_key}*C{crit_key}*M{miss_key}*S{channels_key}*N{natural20_key}*half{}*U{pool_key}*V{}*e{}",
            u8::from(self.half_on_miss),
            self.landing_scale,
            num_to_string(eps)
        ))
    }

    /// `pmf`: `toPMF()` with eps 0.
    pub fn pmf(&self) -> Result<Pmf, DiceError> {
        self.to_pmf(0.0)
    }

    /// `mean()`: expected damage of the attack, from the exact PMF.
    pub fn mean(&self) -> Result<f64, DiceError> {
        Ok(self.pmf()?.mean())
    }

    /// `toQuery(eps = 0)`.
    pub fn to_query(&self) -> Result<DiceQuery, DiceError> {
        self.to_query_with(EPS)
    }

    /// [`Self::to_query`] pruning probabilities below `eps`.
    pub fn to_query_with(&self, eps: f64) -> Result<DiceQuery, DiceError> {
        Ok(DiceQuery::of(vec![self.to_pmf(eps)?]))
    }
}

impl CheckBuilder for AttackBuilder {
    fn resolve(&self, eps: Option<f64>) -> Result<Resolution, DiceError> {
        let r = AttackBuilder::resolve(self, eps.unwrap_or(0.0))?;
        Ok(Resolution {
            pmf: r.pmf,
            check: r.check,
            weights: IndexMap::from([
                ("hit".to_string(), r.weights.hit),
                ("crit".to_string(), r.weights.crit),
                ("miss".to_string(), r.weights.miss),
            ]),
        })
    }
    fn to_expression(&self) -> Result<String, DiceError> {
        AttackBuilder::to_expression(self)
    }
    fn pmf(&self) -> Result<Pmf, DiceError> {
        AttackBuilder::pmf(self)
    }
    fn mean(&self) -> Result<f64, DiceError> {
        AttackBuilder::mean(self)
    }
}

impl ContextualSource for AttackBuilder {
    fn row_check(&self) -> RowCheck {
        AttackBuilder::row_check(self)
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        AttackBuilder::under(self, context, eps)
    }
    fn under_shared(&self, context: &RowContext, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        AttackBuilder::under_shared(self, context, eps)
    }
    fn has_dealt(&self) -> bool {
        self.damage_type.is_some()
    }
    fn dealt(&self, type_: &str, context: &RowContext) -> Result<Dealt, DiceError> {
        self.dealt_odds(type_, context)
    }
    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        Ok(Some(RollUnder::Attack(Box::new(
            AttackBuilder::roll_under(self, context)?,
        ))))
    }
    fn ignores_joined(&self) -> bool {
        true
    }
}

impl HasDiceMatchInfo for AttackBuilder {
    fn dice_match_info(
        &self,
        eps: f64,
    ) -> Result<(Option<DiceMatchInfo>, Option<DiceMatchInfo>), DiceError> {
        AttackBuilder::dice_match_info(self, eps)
    }
    fn dice_match_refusals(&self) -> Result<(Option<String>, Option<String>), DiceError> {
        AttackBuilder::dice_match_refusals(self)
    }
}

impl From<AttackBuilderData> for AttackBuilder {
    fn from(data: AttackBuilderData) -> Self {
        AttackBuilder(Arc::new(data))
    }
}

impl std::ops::Deref for AttackBuilder {
    type Target = AttackBuilderData;
    fn deref(&self) -> &AttackBuilderData {
        &self.0
    }
}

/// Copy-on-write: mutation clones the data only while it is shared.
impl std::ops::DerefMut for AttackBuilder {
    fn deref_mut(&mut self) -> &mut AttackBuilderData {
        let data = Arc::make_mut(&mut self.0);
        data.key.reset();
        data
    }
}

#[cfg(test)]
mod key_memo_tests {
    use super::*;

    #[test]
    fn mutated_attack_never_keeps_a_stale_key() {
        let check = RollBuilder::new(1.0)
            .unwrap()
            .d20()
            .unwrap()
            .ac(15.0)
            .unwrap();
        let damage = RollBuilder::new(1.0).unwrap().d6().unwrap();
        let mut a = AttackBuilder::new(check, damage);
        let before = a.cache_key(0.0);
        assert_eq!(a.cache_key(0.0), before);
        assert_ne!(a.cache_key(1e-9), before);
        let shared = a.clone();
        a.landing_scale = 2;
        assert_ne!(a.cache_key(0.0), before);
        assert_eq!(shared.cache_key(0.0), before);
    }
}
