//! Port of `src/turn/plan.ts` 815-1390: how a source becomes a PMF and slices, the declared
//! attacks of a spec, and the spec-level checks `Turn` runs without a plan.

use super::{ByKind, fail};
use crate::builder::attack::AttachedCondition;
use crate::builder::mixture::Mixture;
use crate::common::DiceMatchInfo;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::turn::context::{ContextualSource, RowContext, context_of, row_check_of};
use crate::turn::effects::{effect_spec, gate_fields};
use crate::turn::state::StepOutcome;
use crate::turn::types::{
    After, Attack, AttackTriggerOn, ConditionOn, ConditionSpec, DamageSource, GrantSaveSpec,
    GrantSaves, PerSource, Rider, RiderDamage, RiderLanding, RowKind, SaveLanding, Source, Trigger,
    TurnSpec, TurnSpecErrorCode,
};
use crate::{Damage, EPS, Pmf};
use indexmap::IndexMap;
use std::collections::HashMap;
use std::sync::Arc;

/// Outcome-labelled sub-mass PMFs for one source, masses summing to 1.
#[derive(Clone, Debug)]
pub struct SourceSlices {
    pub hit: Arc<Pmf>,
    pub crit: Arc<Pmf>,
    pub miss: Arc<Pmf>,
}

/// `Damage | readonly Damage[]`: what a step rolls. A rider's list payload is `Many` even with one
/// part (TS `Array.isArray`).
#[derive(Clone, Debug)]
pub enum PlanDamage {
    One(Source),
    Many(Vec<DamageSource>),
}

/// `EvaluatedRider`: a [`Rider`] whose damage is a plain [`RiderDamage`] (a `ContextualPayload` is
/// read per attack instead), as the plan placed it.
#[derive(Clone, Debug)]
pub struct EvaluatedRider {
    pub trigger: Trigger,
    pub id: Option<String>,
    pub damage: RiderDamage,
    pub crit_damage: Option<RiderDamage>,
    pub landing: Option<RiderLanding>,
    pub happens: Option<f64>,
    pub joins: Option<Vec<String>>,
    pub r#where: Option<IndexMap<String, Vec<String>>>,
    pub target_has: Option<Vec<String>>,
}

impl EvaluatedRider {
    /// `rider` with `damage` as its plain payload.
    pub fn from_rider(rider: &Rider, damage: RiderDamage) -> EvaluatedRider {
        EvaluatedRider {
            trigger: rider.trigger.clone(),
            id: rider.id.clone(),
            damage,
            crit_damage: rider.crit_damage.clone(),
            landing: rider.landing,
            happens: rider.happens,
            joins: rider.joins.clone(),
            r#where: rider.r#where.clone(),
            target_has: rider.target_has.clone(),
        }
    }

    /// The TS `on` string.
    pub fn on(&self) -> &'static str {
        self.trigger.on()
    }

    /// `rider.of` as a list: a `not-fired` rider's lone id is a list of one; `None` where omitted.
    pub fn of_list(&self) -> Option<Vec<String>> {
        match &self.trigger {
            Trigger::FirstHit { of, .. }
            | Trigger::AnyCrit { of, .. }
            | Trigger::AnyMiss { of }
            | Trigger::FirstMiss { of }
            | Trigger::EveryHit { of, .. } => of.clone(),
            Trigger::NotFired { of } => Some(vec![of.clone()]),
            Trigger::DiceMatch { of } => Some(of.clone()),
        }
    }

    /// `"max" in rider ? rider.max : undefined` (`every-hit` and `any-crit` carry one).
    pub fn max(&self) -> Option<f64> {
        match &self.trigger {
            Trigger::AnyCrit { max, .. } | Trigger::EveryHit { max, .. } => *max,
            _ => None,
        }
    }

    /// `perSourceOf(rider)`.
    pub fn per_source(&self) -> Option<&PerSource> {
        match &self.trigger {
            Trigger::FirstHit { per_source, .. } | Trigger::EveryHit { per_source, .. } => {
                per_source.as_ref()
            }
            _ => None,
        }
    }

    /// `isFirstHitFold(rider)`: a `first-hit` rider with a payload per source.
    pub fn is_first_hit_fold(&self) -> bool {
        matches!(self.trigger, Trigger::FirstHit { .. }) && self.per_source().is_some()
    }
}

/// One part of a damage list: a [`Source`] (a lone declared attack or rider) or a list entry.
#[derive(Clone, Copy)]
enum Part<'a> {
    Source(&'a Source),
    Damage(&'a DamageSource),
}

impl PlanDamage {
    fn parts(&self) -> Vec<Part<'_>> {
        match self {
            PlanDamage::One(source) => vec![Part::Source(source)],
            PlanDamage::Many(parts) => parts.iter().map(Part::Damage).collect(),
        }
    }

    fn is_list(&self) -> bool {
        matches!(self, PlanDamage::Many(_))
    }
}

/// The contextual view of a damage source: an attack or save builder.
fn damage_contextual(damage: &DamageSource) -> Option<&dyn ContextualSource> {
    match damage {
        DamageSource::Attack(a) => Some(&**a),
        DamageSource::Save(s) => Some(&**s),
        _ => None,
    }
}

/// `part.toPMF`'s unit-mass check of a bare PMF: a caller-supplied distribution's mass is not
/// guaranteed to be 1, and the walk stays in probability space.
fn bare_pmf(part: &Pmf) -> Pmf {
    let mass = part.mass();
    if (mass - 1.0).abs() <= EPS {
        part.clone()
    } else {
        part.normalize()
    }
}

/// One part of `toPMF`'s `parts.map`.
fn part_pmf(part: Part<'_>, eps: f64, _id: &str) -> Result<Pmf, DiceError> {
    let damage = match part {
        Part::Source(Source::Contextual(c)) => {
            return pmf_under_of(&*c.0, eps);
        }
        Part::Source(Source::Damage(d)) | Part::Damage(d) => d,
    };
    if let DamageSource::Pmf(p) = damage {
        return Ok(bare_pmf(p));
    }
    // A contextual source rolls its own row's context when nothing in the state changes it.
    if let Some(contextual) = damage_contextual(damage) {
        return pmf_under_of(contextual, eps);
    }
    damage.to_pmf(eps)
}

/// `pmfUnder(part, contextOf(rowCheckOf(part), 0), eps, id)`.
fn pmf_under_of(source: &dyn ContextualSource, eps: f64) -> Result<Pmf, DiceError> {
    let context = context_of(&source.row_check(), 0, &[]);
    source.under(&context, eps)
}

/// [`pmf_under_of`] as the source's shared PMF.
fn pmf_under_of_shared(source: &dyn ContextualSource, eps: f64) -> Result<Arc<Pmf>, DiceError> {
    let context = context_of(&source.row_check(), 0, &[]);
    source.under_shared(&context, eps)
}

/// [`part_pmf`] as a shared PMF: a contextual part is its source's cached `Arc`.
fn part_pmf_shared(part: Part<'_>, eps: f64, id: &str) -> Result<Arc<Pmf>, DiceError> {
    match part {
        Part::Source(Source::Contextual(c)) => pmf_under_of_shared(&*c.0, eps),
        Part::Source(Source::Damage(d)) | Part::Damage(d) => match d {
            // A unit-mass bare PMF and a roll's cached PMF are shared as they are.
            DamageSource::Pmf(p) if (p.mass() - 1.0).abs() <= EPS => Ok(Arc::clone(p)),
            DamageSource::Roll(r) => Ok(r.to_pmf_shared(eps)?),
            _ => match damage_contextual(d) {
                Some(contextual) if !matches!(d, DamageSource::Pmf(_)) => {
                    pmf_under_of_shared(contextual, eps)
                }
                _ => part_pmf(part, eps, id).map(Arc::new),
            },
        },
    }
}

/// `toPMF(damage, eps, id)` of a source or a list.
pub fn to_pmf(damage: &PlanDamage, eps: f64, id: &str) -> Result<Pmf, DiceError> {
    parts_pmf(&damage.parts(), eps, id)
}

fn parts_pmf(parts: &[Part<'_>], eps: f64, id: &str) -> Result<Pmf, DiceError> {
    if parts.is_empty() {
        return Pmf::delta(0.0, eps);
    }
    let pmfs = parts
        .iter()
        .map(|part| part_pmf(*part, eps, id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Pmf::convolve_many(&pmfs, eps))
}

/// `toPMF(source, eps, id)` of one source.
pub fn to_pmf_source(source: &Source, eps: f64, id: &str) -> Result<Pmf, DiceError> {
    to_pmf_source_shared(source, eps, id).map(|pmf| (*pmf).clone())
}

/// [`to_pmf_source`] as a shared PMF: a lone part is the cached `Arc` itself (`convolveMany` of
/// one element returns it).
pub fn to_pmf_source_shared(source: &Source, eps: f64, id: &str) -> Result<Arc<Pmf>, DiceError> {
    Ok(Pmf::convolve_many_shared(
        &[part_pmf_shared(Part::Source(source), eps, id)?],
        eps,
    ))
}

/// `toPMF(parts, eps, id)` of a list of damage parts.
pub fn to_pmf_parts(parts: &[DamageSource], eps: f64, id: &str) -> Result<Pmf, DiceError> {
    let parts: Vec<Part<'_>> = parts.iter().map(Part::Damage).collect();
    parts_pmf(&parts, eps, id)
}

/// `toPMF(rider.damage, eps, id)`.
pub fn rider_damage_pmf(damage: &RiderDamage, eps: f64, id: &str) -> Result<Pmf, DiceError> {
    to_pmf_parts(damage.parts(), eps, id)
}

/// `pmfUnder(source, context, eps, id)`: `source`'s PMF under `context`; `source` must be contextual.
pub fn pmf_under(
    source: &dyn ContextualSource,
    context: &RowContext,
    eps: f64,
    _id: &str,
) -> Result<Pmf, DiceError> {
    source.under(context, eps)
}

/// `rerolledPmfUnder(source, context, eps, id)`.
pub fn rerolled_pmf_under(
    source: &dyn ContextualSource,
    context: &RowContext,
    eps: f64,
    _id: &str,
) -> Result<Pmf, DiceError> {
    source.rerolled_under(context, eps)
}

/// `hasDoubleDice(part)`: a `RollBuilder`, or a parsed string that is a damage expression.
fn has_double_dice(part: &DamageSource) -> Result<bool, DiceError> {
    Ok(match part {
        DamageSource::Roll(r) if r.is_parsed() => r.can_double_dice()?,
        DamageSource::Roll(_) => true,
        _ => false,
    })
}

/// `part instanceof ParsedRollBuilder && part.canDoubleDice()`.
fn parsed_doubles(part: Part<'_>) -> Result<bool, DiceError> {
    let damage = match part {
        Part::Source(Source::Damage(d)) | Part::Damage(d) => d,
        Part::Source(Source::Contextual(_)) => return Ok(false),
    };
    match damage {
        DamageSource::Roll(r) if r.is_parsed() => Ok(r.can_double_dice()?),
        _ => Ok(false),
    }
}

/// `critPMF(rider, base, eps)`: an explicit `critDamage` wins; otherwise every part with dice
/// doubles them. A part with no dice to double is added as-is on a crit.
pub fn crit_pmf(
    damage: &RiderDamage,
    crit_damage: Option<&RiderDamage>,
    base: &Pmf,
    eps: f64,
) -> Result<Pmf, DiceError> {
    if let Some(crit) = crit_damage {
        return rider_damage_pmf(crit, eps, "");
    }
    let parts = damage.parts();
    let mut any = false;
    for part in parts {
        if has_double_dice(part)? {
            any = true;
            break;
        }
    }
    if !any {
        return Ok(base.clone());
    }
    let mut pmfs = Vec::with_capacity(parts.len());
    for part in parts {
        if has_double_dice(part)? {
            let DamageSource::Roll(roll) = part else {
                // INFALLIBLE: only a roll has double dice.
                return Err(DiceError::Error(
                    "doubleDice() on a non-roll part".to_string(),
                ));
            };
            let doubled = DamageSource::Roll(roll.double_dice()?);
            pmfs.push(part_pmf(Part::Damage(&doubled), eps, "")?);
        } else {
            pmfs.push(part_pmf(Part::Damage(part), eps, "")?);
        }
    }
    Ok(Pmf::convolve_many(&pmfs, eps))
}

/// `diceMatchInfoOf(source, eps)`: `(hit, crit)`; `(None, None)` for a source with no descriptor.
pub fn dice_match_info_of(
    source: &Source,
    eps: f64,
) -> Result<(Option<DiceMatchInfo>, Option<DiceMatchInfo>), DiceError> {
    match source {
        Source::Damage(DamageSource::Attack(a)) => Ok(a.dice_match_info(eps)?),
        // A hand-written source's own `diceMatchInfo(eps)`.
        Source::Contextual(c) => Ok(c.0.dice_match_info(eps)?),
        _ => Ok((None, None)),
    }
}

/// `diceMatchRefusalsOf(source, missing)`: one phrase per cause ("hit and crit: ..."); none for a
/// source that cannot say.
pub fn dice_match_refusals_of(source: &Source, missing: &[&str]) -> Result<Vec<String>, DiceError> {
    let (hit, crit) = match source {
        Source::Damage(DamageSource::Attack(a)) => a.dice_match_refusals()?,
        Source::Contextual(c) => c.0.dice_match_refusals()?,
        _ => return Ok(Vec::new()),
    };
    if missing.len() == 2
        && let (Some(h), Some(c)) = (&hit, &crit)
        && h == c
    {
        return Ok(vec![format!("hit and crit: {h}")]);
    }
    let mut out = Vec::new();
    for branch in missing {
        let reason = if *branch == "hit" { &hit } else { &crit };
        if let Some(reason) = reason {
            out.push(format!("{branch}: {reason}"));
        }
    }
    Ok(out)
}

/// `attackPartCount(damage, eps, id)`: how many parts of a list payload roll their own attack:
/// their PMF carries hit or crit outcomes. A parsed string whose dice can double is damage
/// despite its 'hit' label.
pub fn attack_part_count(parts: &[DamageSource], eps: f64, id: &str) -> Result<usize, DiceError> {
    let mut count = 0;
    for part in parts {
        if parsed_doubles(Part::Damage(part))? {
            continue;
        }
        let labels = part_pmf(Part::Damage(part), eps, id)?.outcomes();
        if labels.iter().any(|l| l == "hit" || l == "crit") {
            count += 1;
        }
    }
    Ok(count)
}

/// `sliceSource(pmf, damage?, eps)`: split a source into hit / crit / miss sub-mass PMFs, or
/// `None` when the source is not attack-shaped. A list holding more than one attack is not one
/// attack: it returns `None`.
pub fn slice_source(
    pmf: &Pmf,
    damage: Option<&PlanDamage>,
    eps: f64,
) -> Result<Option<SourceSlices>, DiceError> {
    let labels = pmf.outcomes();
    if let Some(damage) = damage {
        let parts = damage.parts();
        if let PlanDamage::Many(list) = damage
            && attack_part_count(list, eps, "")? > 1
        {
            return Ok(None);
        }
        debug_assert!(damage.is_list() || parts.len() == 1);
        let mut others = Vec::new();
        for part in &parts {
            if !parsed_doubles(*part)? {
                others.push(*part);
            }
        }
        if others.len() < parts.len() {
            let shape_labels = if others.is_empty() {
                Vec::new()
            } else {
                parts_pmf(&others, eps, "")?.outcomes()
            };
            return Ok(slice_pmf(pmf, &labels, &shape_labels));
        }
    }
    Ok(slice_pmf(pmf, &labels, &labels))
}

/// `pmf` by outcome, or `None` where its shape (`shape_labels`) has no hit or crit.
fn slice_pmf(pmf: &Pmf, labels: &[String], shape_labels: &[String]) -> Option<SourceSlices> {
    let has = |list: &[String], name: &str| list.iter().any(|l| l == name);
    if !has(shape_labels, "hit") && !has(shape_labels, "crit") {
        return None;
    }
    let miss_parts: Vec<Arc<Pmf>> = ["missNone", "missDamage"]
        .iter()
        .filter(|label| has(labels, label))
        .map(|label| slice_of(pmf, label))
        .collect();
    let hit = if has(labels, "hit") {
        slice_of(pmf, "hit")
    } else {
        Arc::new(Pmf::empty_mass())
    };
    let crit = if has(labels, "crit") {
        slice_of(pmf, "crit")
    } else {
        Arc::new(Pmf::empty_mass())
    };
    let miss = match miss_parts.as_slice() {
        [] => Arc::new(Pmf::empty_mass()),
        [only] => only.clone(),
        [first, rest @ ..] => Arc::new(
            rest.iter()
                .fold((**first).clone(), |all, part| all.add(part)),
        ),
    };
    Some(SourceSlices { hit, crit, miss })
}

/// One outcome slice of `pmf`, the memoized shared PMF (TS `filterOutcome`'s `_outcomeSlices`).
fn slice_of(pmf: &Pmf, label: &str) -> Arc<Pmf> {
    pmf.filter_outcome_shared(label)
}

/// `isSaveShaped(source, pmf, eps)`: whether a declared attack with no hit or crit outcome is a
/// save: it declares a save row, or its PMF carries a save's labels. (TS also asks a source with a
/// `resolve()` for `weights.fail`; every Rust source that resolves declares its row, so that
/// branch cannot differ.)
pub fn is_save_shaped(source: &Source, pmf: &Pmf, _eps: f64) -> bool {
    // A source that declares its row is what it declares, whatever its PMF in one context holds.
    if let Some(declared) = row_check_of(source) {
        return declared.kind == RowKind::Save;
    }
    let labels = pmf.outcomes();
    labels.iter().any(|l| l == "saveFail" || l == "saveHalf")
}

/// `SaveClasses`: a save row split into the four classes its landing kinds tell apart, by outcome
/// label and by whether damage was dealt: it failed and dealt damage; it failed and dealt none; it
/// passed and dealt damage (`saveHalf`); everything else. Their masses sum to the row's.
pub type SaveClasses = [Arc<Pmf>; 4];

/// `CLASS_LANDS[class][landing]`: whether each class lands under each kind. `fail` is decided by
/// the label alone. `damage` is "when you deal damage": a failure or a pass that dealt some.
pub fn class_lands(class: usize, landing: SaveLanding) -> bool {
    // [{fail, damage}]: [{true,true},{true,false},{false,true},{false,false}]
    matches!(
        (class, landing),
        (0, _) | (1, SaveLanding::Fail) | (2, SaveLanding::Damage)
    )
}

/// `CLASS_OUTCOMES[class]`.
pub fn class_outcomes(class: usize) -> ByKind {
    let of = |landing| {
        if class_lands(class, landing) {
            StepOutcome::Hit
        } else {
            StepOutcome::Miss
        }
    };
    ByKind {
        fail: of(SaveLanding::Fail),
        damage: of(SaveLanding::Damage),
    }
}

/// `saveClasses(pmf)`.
pub fn save_classes(pmf: &Pmf) -> SaveClasses {
    let labels = pmf.outcomes();
    let label = |name: &str| {
        if labels.iter().any(|l| l == name) {
            slice_of(pmf, name)
        } else {
            Arc::new(Pmf::empty_mass())
        }
    };
    let (failed, failed_for_nothing) = label("saveFail").split_by_dealt();
    let (passed, passed_for_nothing) = label("saveHalf").split_by_dealt();
    let rest = labels
        .iter()
        .filter(|name| *name != "saveFail" && *name != "saveHalf")
        .fold(passed_for_nothing, |all, name| {
            all.add(&slice_of(pmf, name))
        });
    [
        Arc::new(failed),
        Arc::new(failed_for_nothing),
        Arc::new(passed),
        Arc::new(rest),
    ]
}

/// `saveSlicesByLanding(classes, landing)`: the slices a rider reading a save row under a landing
/// kind sees.
pub fn save_slices_by_landing(classes: &SaveClasses, landing: SaveLanding) -> SourceSlices {
    let sum = |wanted: bool| {
        classes
            .iter()
            .enumerate()
            .fold(Pmf::empty_mass(), |all, (index, part)| {
                if class_lands(index, landing) == wanted {
                    all.add(part)
                } else {
                    all
                }
            })
    };
    SourceSlices {
        hit: Arc::new(sum(true)),
        crit: Arc::new(Pmf::empty_mass()),
        miss: Arc::new(sum(false)),
    }
}

/// A hit and a crit payload (unit mass).
#[derive(Clone, Debug)]
pub struct HitCrit {
    pub hit: Arc<Pmf>,
    pub crit: Arc<Pmf>,
}

/// `BasePayload`: a source's payload split at the base: what transforms and match odds may read,
/// and the `plusSeparateDamage` channels convolved in after them. `None` where the slices already
/// are the base / there are no channels.
#[derive(Clone, Debug)]
pub struct BasePayload {
    pub base: Option<HitCrit>,
    pub separate: Option<HitCrit>,
}

/// `basePayloadOf(source, eps)`: an `AttackBuilder` resolves to `hitBase`/`critBase`/
/// `hitSeparate`/`critSeparate`; anything else (a bare PMF, a list of payloads, a save) is all base.
/// (TS: `hitBase === hit` exactly when there are no channels; here the two PMFs are compared by value.)
pub fn base_payload_of(source: &PlanDamage, eps: f64) -> Result<BasePayload, DiceError> {
    let none = BasePayload {
        base: None,
        separate: None,
    };
    let PlanDamage::One(Source::Damage(DamageSource::Attack(attack))) = source else {
        return Ok(none);
    };
    let resolved = attack.resolve(eps)?;
    if resolved.hit_base == resolved.hit {
        return Ok(none);
    }
    Ok(BasePayload {
        base: Some(HitCrit {
            hit: Arc::new(resolved.hit_base),
            crit: Arc::new(resolved.crit_base),
        }),
        separate: Some(HitCrit {
            hit: Arc::new(resolved.hit_separate),
            crit: Arc::new(resolved.crit_separate),
        }),
    })
}

/// `keepBetterOfFresh(spend, base)`: the better of `x` and a fresh draw from `base`, for every `x`
/// in `spend` (P(v) = spend(v)·F(v) + spend(<v)·f(v)). Returned as its two terms `(kept, beaten)`:
/// `kept`, where the original roll stands (ties included), and `beaten`, where the fresh roll won.
pub fn keep_better_of_fresh(spend: &Pmf, base: &Pmf) -> (Pmf, Pmf) {
    let base_mass = base.mass();
    // `Map` keys are SameValueZero, as `Damage`'s equality is.
    let mut cdf: HashMap<Damage, f64> = HashMap::new();
    let mut spend_below: HashMap<Damage, f64> = HashMap::new();
    let mut running = 0.0;
    let mut spend_running = 0.0;
    for value in base.support() {
        spend_below.insert(value, spend_running);
        running += base.p_at(value.0) / base_mass;
        spend_running += spend.p_at(value.0);
        cdf.insert(value, running);
    }
    let (kept, _) = spend.split_by_factor(|value| cdf.get(&Damage(value)).copied().unwrap_or(0.0));
    let (beaten, _) = base.split_by_factor(|value| {
        spend_below.get(&Damage(value)).copied().unwrap_or(0.0) / base_mass
    });
    (kept, beaten)
}

/// `Mixture.mix([[label, pmf, 1]], eps)`.
pub fn mix_one(label: &str, pmf: &Pmf, eps: f64) -> Result<Pmf, DiceError> {
    let mut mixture = Mixture::new(eps);
    mixture.add(label, pmf, 1.0);
    mixture.build_pmf(eps)
}

/// `sourceTags(source, id)`: the tags a source carries itself (`AttackBuilder.tagged()`).
pub fn source_tags(source: &Source) -> Vec<String> {
    match source {
        Source::Damage(DamageSource::Attack(a)) => a.tags.clone(),
        _ => Vec::new(),
    }
}

/// `attachedConditionsOf(source)`: the attached conditions a source carries (only `AttackBuilder`s
/// do), or `None` when it has none.
pub fn attached_conditions_of(source: &Source) -> Option<&[AttachedCondition]> {
    match source {
        Source::Damage(DamageSource::Attack(a)) if !a.attached.is_empty() => Some(&a.attached),
        _ => None,
    }
}

/// `conditionFromAttached(slotId, index, attached, eps)`: the one condition an attached condition
/// becomes: `of` is the carrying attack's id and the gate's fields are read as `Turn`'s trigger
/// verbs read them.
pub fn condition_from_attached(
    slot_id: &str,
    index: usize,
    attached: &AttachedCondition,
    eps: f64,
) -> Result<ConditionSpec, DiceError> {
    use crate::builder::attack::AttachedOn;
    let gate = attached.gate.clone().unwrap_or_default();
    let fields = gate_fields(&gate, eps)?;
    let on = match attached.on {
        AttachedOn::EveryHit => ConditionOn::Attack(AttackTriggerOn::EveryHit),
        AttachedOn::AnyCrit => ConditionOn::Attack(AttackTriggerOn::AnyCrit),
        AttachedOn::FirstCrit => ConditionOn::FirstCrit,
    };
    Ok(ConditionSpec {
        id: Some(format!("{slot_id}:{index}")),
        on,
        of: Some(vec![slot_id.to_string()]),
        r#where: None,
        chance: fields.chance,
        target_has: fields.target_has,
        landing: fields.landing,
        dealing: fields.dealing,
        target: None,
        save: fields.save,
        grants: attached.grants.iter().map(effect_spec).collect(),
        on_save: fields.on_save,
        optional: fields.optional,
    })
}

/// `saveOptionsOf(condition)`: a condition's grant save as a list of the options the target picks
/// from; empty without a save.
pub fn save_options_of(condition: &ConditionSpec) -> Vec<GrantSaveSpec> {
    match &condition.save {
        None => Vec::new(),
        Some(GrantSaves::One(save)) => vec![save.clone()],
        Some(GrantSaves::Many(saves)) => saves.clone(),
    }
}

/// `checkedTargetHas(id, value)`: a `targetHas` is a non-empty list of non-empty condition names.
pub fn checked_target_has(id: &str, value: Option<&[String]>) -> Result<(), DiceError> {
    let Some(names) = value else {
        return Ok(());
    };
    if names.is_empty() || names.iter().any(std::string::String::is_empty) {
        return Err(fail(
            TurnSpecErrorCode::NonStringId,
            id,
            format!("\"{id}\" has a targetHas that is not a non-empty list of condition names."),
        ));
    }
    Ok(())
}

/// A declared attack, validated and resolved: what `buildPlan` and the stateless path both read.
#[derive(Clone, Debug)]
pub struct DeclaredAttack {
    pub id: String,
    pub tags: Vec<String>,
    pub source: Source,
    pub chance: f64,
    /// The source's PMF in its own context.
    pub pmf: Arc<Pmf>,
    /// Its hit / crit / miss slices, or `None` for a row with no hit or crit outcome (a save, a
    /// plain roll).
    pub slices: Option<SourceSlices>,
    pub target: String,
    pub after: Option<After>,
}

/// `checkStateLimit(stateLimit)`: refuses a `stateLimit` that is not a whole number of 1 or more.
pub fn check_state_limit(state_limit: Option<f64>) -> Result<(), DiceError> {
    if let Some(limit) = state_limit {
        // `Number.isInteger(x) && x >= 1`
        let whole = limit.is_finite() && limit.trunc() == limit;
        if !(whole && limit >= 1.0) {
            return Err(DiceError::Range(format!(
                "A turn's stateLimit must be a whole number of 1 or more, got {}.",
                num_to_string(limit)
            )));
        }
    }
    Ok(())
}

/// `declaredAttacks(spec, eps)`: the declared attacks of `spec`, in order, each validated (its
/// chance) and resolved to its PMF.
pub fn declared_attacks(spec: &TurnSpec, eps: f64) -> Result<Vec<DeclaredAttack>, DiceError> {
    let mut out = Vec::with_capacity(spec.attacks.len());
    for (index, entry) in spec.attacks.iter().enumerate() {
        let default_id = format!("attack {}", index + 1);
        let (id, tags, source, chance, target, after) = match entry {
            Attack::Bare(source) => (
                default_id,
                source_tags(source),
                source.clone(),
                1.0,
                None,
                None,
            ),
            Attack::Declared { options, source } => {
                let id = options.id.clone().unwrap_or(default_id);
                let own = source_tags(source);
                // `[...new Set(tag === undefined ? own : [tag, ...own])]`
                let mut tags: Vec<String> = Vec::new();
                for tag in options.tag.iter().chain(own.iter()) {
                    if !tags.contains(tag) {
                        tags.push(tag.clone());
                    }
                }
                (
                    id,
                    tags,
                    source.clone(),
                    options.chance.unwrap_or(1.0),
                    options.target.clone(),
                    options.after.clone(),
                )
            }
        };
        // `!(chance >= 0 && chance <= 1)`
        if !(0.0..=1.0).contains(&chance) {
            return Err(DiceError::Range(format!(
                "Attack \"{id}\" needs a chance in [0, 1], got {}.",
                num_to_string(chance)
            )));
        }
        let pmf = to_pmf_source_shared(&source, eps, &id)?;
        // A declared attack (or a row that lands without a roll) whose PMF holds no landing in this
        // context (every roll misses) still is one: it simply never lands. Validity is structural.
        let declared = row_check_of(&source);
        let slices = match slice_source(&pmf, None, EPS)? {
            Some(slices) => Some(slices),
            None => match &declared {
                Some(check) if check.kind != RowKind::Save => Some(SourceSlices {
                    hit: Arc::new(Pmf::empty_mass()),
                    crit: Arc::new(Pmf::empty_mass()),
                    miss: pmf.clone(),
                }),
                _ => None,
            },
        };
        out.push(DeclaredAttack {
            id,
            tags,
            source,
            chance,
            pmf,
            slices,
            target: target.unwrap_or_else(|| super::DEFAULT_CREATURE.to_string()),
            after,
        });
    }
    Ok(out)
}

/// `checkDuplicateIds(ids)`: `duplicate-id` over every id of a turn, in `buildPlan`'s order.
pub fn check_duplicate_ids(ids: &[String]) -> Result<(), DiceError> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            return Err(fail(
                TurnSpecErrorCode::DuplicateId,
                id,
                format!("Duplicate id \"{id}\"."),
            ));
        }
    }
    Ok(())
}

/// `isStateless(spec)`: whether `spec` carries nothing a walk state would hold: no rider,
/// substitute, condition (declared or attached to a source) or probe, and no attack gated on
/// another. Structural: read off the spec's shape, never its numbers.
pub fn is_stateless(spec: &TurnSpec) -> bool {
    if spec.riders.as_ref().is_some_and(|v| !v.is_empty())
        || spec.substitutes.as_ref().is_some_and(|v| !v.is_empty())
        || spec.conditions.as_ref().is_some_and(|v| !v.is_empty())
        || spec.observe.as_ref().is_some_and(|v| !v.is_empty())
    {
        return false;
    }
    spec.attacks.iter().all(|entry| match entry {
        Attack::Bare(source) => attached_conditions_of(source).is_none(),
        Attack::Declared { options, source } => {
            options.after.is_none() && attached_conditions_of(source).is_none()
        }
    })
}

/// `checkKnownAbility(owner, ability)`: `unknown-ability` for a save made with an ability no 5e
/// name matches.
pub fn check_known_ability(owner: &str, ability: &str) -> Result<(), DiceError> {
    if super::ability_full(ability).is_none() {
        return Err(fail(
            TurnSpecErrorCode::UnknownAbility,
            owner,
            format!(
                "\"{owner}\" saves with \"{ability}\", which is not a 5e ability (str, dex, con, int, wis, cha or the full name)."
            ),
        ));
    }
    Ok(())
}

/// `checkSaveRowAbility(row, eps)`: the check every declared save row passes whatever the turn
/// holds: its ability, if it names one, is a 5e ability.
pub fn check_save_row_ability(row: &DeclaredAttack, eps: f64) -> Result<(), DiceError> {
    if row.slices.is_some() || !is_save_shaped(&row.source, &row.pmf, eps) {
        return Ok(());
    }
    if let Some(ability) = row_check_of(&row.source).and_then(|check| check.ability) {
        check_known_ability(&row.id, &ability)?;
    }
    Ok(())
}
