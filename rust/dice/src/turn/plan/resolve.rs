//! `buildPlan` 1399-2490 (src/turn/plan.ts): the spec's riders lowered and placed, its attacks,
//! ids, validation, `of` resolution, dependency order and substitutes. Output: [`Resolved`].
//!
//! Every local of that stretch of `buildPlan` that a later stretch reads is a field of
//! [`Resolved`]; every inner closure a later stretch (or a block built during the walk) calls is a
//! method. TS `-1` / `Map` / `Set` map as documented per field.

use super::source::{
    EvaluatedRider, SaveClasses, SourceSlices, attached_conditions_of, attack_part_count,
    check_duplicate_ids, check_state_limit, checked_target_has, condition_from_attached,
    declared_attacks, dice_match_info_of, dice_match_refusals_of, is_save_shaped, rider_damage_pmf,
    save_classes, save_options_of, save_slices_by_landing, slice_source, source_tags,
};
use super::{DEFAULT_CREATURE, EffectSource, FoldMode, PlanDamage, fail};
use crate::Pmf;
use crate::builder::num::MAX_DEPTH;
use crate::common::DiceMatchInfo;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::turn::context::{has_rerolled_under, ignores_joined, is_contextual};
use crate::turn::types::{
    After, AfterLanding, AttackTriggerOn, ConditionOn, ConditionSpec, ConditionUntil,
    ContextualPayload, DamageSource, EffectSpec, GrantSaveSpec, PerSource, ProbeSpec, Rider,
    RiderDamage, RiderDamageSpec, RiderLanding, SaveLanding, Source, SubstituteKind, SubstituteOn,
    SubstitutePolicy, SubstituteSpec, Trigger, TurnSpec, TurnSpecErrorCode,
};
use indexmap::{IndexMap, IndexSet};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Everything `buildPlan` resolves and validates before it lays groups, flags and steps out.
/// Immutable once built, except the lazy caches (`Mutex`), which only memoise.
pub struct Resolved {
    pub eps: f64,
    /// `folds`.
    pub folds: FoldMode,
    /// `spec.stateLimit` (checked by `check_state_limit` already).
    pub state_limit: Option<f64>,

    // --- riders: `riders` of buildPlan, i.e. after lowering, placing and folding partners ---
    pub riders: Vec<EvaluatedRider>,
    /// `riderIds`.
    pub rider_ids: Vec<String>,
    /// `contextualPayloads`: by rider index.
    pub contextual_payloads: BTreeMap<usize, Arc<dyn ContextualPayload>>,
    /// `critOnly`: rider indexes, ascending (TS Set insertion order is ascending here).
    pub crit_only: BTreeSet<usize>,

    // --- substitutes, probes, conditions (conditions = declared, then attached) ---
    pub substitutes: Vec<SubstituteSpec>,
    pub substitute_ids: Vec<String>,
    pub probes: Vec<ProbeSpec>,
    pub probe_ids: Vec<String>,
    pub conditions: Vec<ConditionSpec>,
    pub condition_ids: Vec<String>,
    /// `effectSources`.
    pub effect_sources: Vec<EffectSource>,
    /// `startingIndex`: `None` for TS -1.
    pub starting_index: Option<usize>,

    // --- declared attacks, per index ---
    pub attack_ids: Vec<String>,
    pub attack_sources: Vec<Source>,
    pub attack_pmfs: Vec<Arc<Pmf>>,
    /// `attackSingles`.
    pub attack_singles: Vec<Arc<Pmf>>,
    pub attack_slices: Vec<Option<SourceSlices>>,
    pub attack_chances: Vec<f64>,
    /// `idsByTag`: tag -> ids (declared attacks, then the rerolls tagged in `isReroll`), in insertion order.
    pub ids_by_tag: IndexMap<String, Vec<String>>,
    pub attack_targets: Vec<String>,
    pub attack_afters: Vec<Option<After>>,

    // --- id indexes ---
    pub attack_index_by_id: HashMap<String, usize>,
    pub rider_index_by_id: HashMap<String, usize>,
    pub substitute_index_by_id: HashMap<String, usize>,
    pub condition_id_set: HashSet<String>,
    pub probe_id_set: HashSet<String>,

    // --- derived per rider / node ---
    /// `attackLists`: per rider.
    pub attack_lists: Vec<bool>,
    /// `isReroll`: per rider.
    pub is_reroll: Vec<bool>,
    /// `rerollIds`.
    pub reroll_ids: Vec<String>,
    /// `riderCount` (= `riders.len()`).
    pub rider_count: usize,
    /// `nodeIds`: rider ids then substitute ids.
    pub node_ids: Vec<String>,
    pub node_index_by_id: HashMap<String, usize>,
    /// `partnersOf`: per rider.
    pub partners_of: Vec<Vec<String>>,
    /// `openedBy`: per rider, row id -> the partners that open it, in insertion order.
    pub opened_by: Vec<IndexMap<String, Vec<String>>>,
    /// `sourceIdsByNode`: per node (riders, then substitutes) the source ids it watches; for a
    /// `not-fired` rider the one negated node id.
    pub source_ids_by_node: Vec<Vec<String>>,
    /// `conditionRiders`: per condition, the folded rider whose landing fires it.
    pub condition_riders: Vec<Option<String>>,
    /// `conditionSources`: per condition.
    pub condition_sources: Vec<Vec<String>>,
    /// `dealtSources`.
    pub dealt_sources: HashSet<String>,
    /// `dealingType`.
    pub dealing_type: Option<String>,
    /// `dealingSources`.
    pub dealing_sources: HashSet<String>,
    /// `probeSources`: per probe.
    pub probe_sources: Vec<Vec<String>>,
    /// `order`: node indexes in dependency order.
    pub order: Vec<usize>,
    /// `substituteBySource`: source id -> substitute index.
    pub substitute_by_source: HashMap<String, usize>,
    /// `missRerollsBySource`: source id -> substitute indexes, in declaration order.
    pub miss_rerolls_by_source: HashMap<String, Vec<usize>>,

    // --- lazy caches behind the methods ---
    /// `riderPMFs`.
    pub rider_pmfs: Mutex<Vec<Option<Arc<Pmf>>>>,
    /// `riderSlices`: outer `None` = not computed yet.
    pub rider_slices: Mutex<Vec<Option<Option<SourceSlices>>>>,
    /// `saveRows`.
    pub save_rows: Mutex<HashMap<String, bool>>,
    /// `landingKinds`: source id -> the kinds riders declare for that save row, insertion order.
    pub landing_kinds: Mutex<IndexMap<String, Vec<SaveLanding>>>,
    /// `classesById`: `saveClasses` of each save row's PMF, built on first use.
    pub classes_by_id: Mutex<HashMap<String, SaveClasses>>,
}

/// Locks `m`; a poisoned cache is still a valid cache (it only memoises).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A rider payload as the damage a step rolls (`Damage | readonly Damage[]`).
fn plan_damage_of(damage: &RiderDamage) -> PlanDamage {
    match damage {
        RiderDamage::One(d) => PlanDamage::One(Source::Damage(d.clone())),
        RiderDamage::Many(v) => PlanDamage::Many(v.clone()),
    }
}

/// `typeof rider.of === "string" ? [rider.of] : rider.of` of a raw [`Rider`].
fn trigger_of(trigger: &Trigger) -> Option<Vec<String>> {
    match trigger {
        Trigger::FirstHit { of, .. }
        | Trigger::AnyCrit { of, .. }
        | Trigger::AnyMiss { of }
        | Trigger::FirstMiss { of }
        | Trigger::EveryHit { of, .. } => of.clone(),
        Trigger::NotFired { of } => Some(vec![of.clone()]),
        Trigger::DiceMatch { of } => Some(of.clone()),
    }
}

/// `Number.isInteger`.
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.floor() == x
}

fn evaluated(rider: &Rider, damage: RiderDamage, trigger: Trigger) -> EvaluatedRider {
    EvaluatedRider {
        trigger,
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

fn rider_label(id: &Option<String>, index: usize) -> String {
    id.clone().unwrap_or_else(|| format!("rider {}", index + 1))
}

/// Riders `every-hit` capped at 1 are `first-hit`; a rider gated on a condition of its target is
/// an `every-hit` one (plan.ts 1410-1428).
fn lower(declared: &[Rider]) -> Result<Vec<Rider>, DiceError> {
    let mut lowered = Vec::with_capacity(declared.len());
    for (index, rider) in declared.iter().enumerate() {
        if let Some(target_has) = &rider.target_has {
            let id = rider_label(&rider.id, index);
            checked_target_has(&id, Some(target_has))?;
            lowered.push(match &rider.trigger {
                Trigger::EveryHit { .. } => rider.clone(),
                Trigger::FirstHit { of, per_source } => Rider {
                    trigger: Trigger::EveryHit {
                        of: of.clone(),
                        max: Some(1.0),
                        per_source: per_source.clone(),
                    },
                    ..rider.clone()
                },
                other => {
                    return Err(fail(
                        TurnSpecErrorCode::UnsupportedTrigger,
                        &id,
                        format!(
                            "Rider \"{id}\" has a targetHas on \"{}\". Only every-hit and first-hit riders are gated on a condition of the target.",
                            other.on()
                        ),
                    ));
                }
            });
            continue;
        }
        lowered.push(match &rider.trigger {
            Trigger::EveryHit {
                of,
                max: Some(max),
                per_source,
            } if *max == 1.0 => Rider {
                trigger: Trigger::FirstHit {
                    of: of.clone(),
                    per_source: per_source.clone(),
                },
                ..rider.clone()
            },
            _ => rider.clone(),
        });
    }
    Ok(lowered)
}

/// What `placed` yields: the riders with a `ContextualPayload` replaced by nothing, the payloads
/// by rider index, and the riders folded to land on crits only.
type Placed = (
    Vec<EvaluatedRider>,
    BTreeMap<usize, Arc<dyn ContextualPayload>>,
    BTreeSet<usize>,
);

/// plan.ts 1438-1469.
fn place(lowered: &[Rider], eps: f64) -> Result<Placed, DiceError> {
    let mut contextual_payloads = BTreeMap::new();
    let mut crit_only = BTreeSet::new();
    let mut placed = Vec::with_capacity(lowered.len());
    for (index, rider) in lowered.iter().enumerate() {
        let contextual = match &rider.damage {
            RiderDamageSpec::Contextual(c) => Some(c.clone()),
            RiderDamageSpec::Plain(_) => None,
        };
        let declared_max = match &rider.trigger {
            Trigger::AnyCrit { max, .. } => *max,
            _ => None,
        };
        // `Infinity` lands on every crit: uncapped.
        let every_crit = declared_max == Some(f64::INFINITY);
        let max = if every_crit { None } else { declared_max };
        let damage = match &rider.damage {
            RiderDamageSpec::Contextual(c) => {
                contextual_payloads.insert(index, c.clone());
                RiderDamage::One(DamageSource::Pmf(Arc::new(Pmf::delta(0.0, eps)?)))
            }
            RiderDamageSpec::Plain(d) => d.clone(),
        };
        if let Trigger::AnyCrit { of, .. } = &rider.trigger
            && (contextual.is_some() || declared_max.is_some())
        {
            crit_only.insert(index);
            let trigger = if every_crit {
                Trigger::EveryHit {
                    of: of.clone(),
                    max: None,
                    per_source: None,
                }
            } else if max.is_none() || max == Some(1.0) {
                Trigger::FirstHit {
                    of: of.clone(),
                    per_source: Some(PerSource::new()),
                }
            } else {
                Trigger::EveryHit {
                    of: of.clone(),
                    max,
                    per_source: None,
                }
            };
            placed.push(evaluated(rider, damage, trigger));
            continue;
        }
        if contextual.is_none() {
            placed.push(evaluated(rider, damage, rider.trigger.clone()));
            continue;
        }
        let trigger = match &rider.trigger {
            Trigger::FirstHit { of, per_source } => Trigger::FirstHit {
                of: of.clone(),
                per_source: Some(per_source.clone().unwrap_or_default()),
            },
            Trigger::EveryHit { .. } => rider.trigger.clone(),
            other => {
                let id = rider_label(&rider.id, index);
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    &id,
                    format!(
                        "Rider \"{id}\" has a payload per attack on \"{}\". Only first-hit, every-hit and any-crit riders take one.",
                        other.on()
                    ),
                ));
            }
        };
        placed.push(evaluated(rider, damage, trigger));
    }
    Ok((placed, contextual_payloads, crit_only))
}

/// `sliceSource(toPMF(damage, eps), damage, eps)` of a rider's lone payload; `None` for a list.
fn lone_slices(damage: &RiderDamage, eps: f64) -> Result<Option<Option<SourceSlices>>, DiceError> {
    if matches!(damage, RiderDamage::Many(_)) {
        return Ok(None);
    }
    let pmf = rider_damage_pmf(damage, eps, "")?;
    Ok(Some(slice_source(
        &pmf,
        Some(&plan_damage_of(damage)),
        eps,
    )?))
}

/// Sets `perSource: {}` on a `first-hit` rider (it is then a fold).
fn set_empty_per_source(rider: &mut EvaluatedRider) {
    if let Trigger::FirstHit { per_source, .. } = &mut rider.trigger {
        *per_source = Some(PerSource::new());
    }
}

/// `refusePayload(id, on, damage)`: refuses a payload no rider can carry. A `DamageSource` is
/// never a transform or a grant, so only the source's attached condition remains.
fn refuse_payload(id: &str, parts: &[DamageSource]) -> Result<(), DiceError> {
    if parts
        .iter()
        .any(|part| attached_conditions_of(&Source::Damage(part.clone())).is_some())
    {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Rider \"{id}\" carries a condition attached to its source (AttackBuilder.onEveryHit / onAnyCrit). Attachment is only read from declared attacks; spell this condition with the turn's verbs instead."
            ),
        ));
    }
    Ok(())
}

/// The checks of one rider (plan.ts 1634-1694).
fn check_rider(rider: &EvaluatedRider, declared: &Rider, id: &str) -> Result<(), DiceError> {
    if rider.landing.is_some() && matches!(rider.trigger, Trigger::NotFired { .. }) {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Rider \"{id}\" declares a landing on \"not-fired\", which watches a rider, not attacks. A landing says how to read a save among attack sources."
            ),
        ));
    }
    refuse_payload(id, rider.damage.parts())?;
    // `max` is spelled on the rider: refuse what is not a positive integer rather than ignore it.
    let max = match &declared.trigger {
        Trigger::EveryHit { max, .. } => *max,
        Trigger::AnyCrit { max, .. } => *max,
        _ => None,
    };
    if let Some(max) = max {
        let any_crit = matches!(declared.trigger, Trigger::AnyCrit { .. });
        if !(is_integer(max) || (any_crit && max == f64::INFINITY)) || max < 1.0 {
            return Err(DiceError::Range(format!(
                "Rider \"{id}\" needs a positive integer max, got {}.",
                num_to_string(max)
            )));
        }
    }
    if let Some(per_source) = rider.per_source() {
        for payload in per_source.values() {
            refuse_payload(id, payload.damage.parts())?;
        }
    }
    Ok(())
}

fn check_condition(
    condition: &ConditionSpec,
    id: &str,
    attack_targets: &[String],
) -> Result<(), DiceError> {
    let chance = condition.chance;
    if let Some(chance) = chance
        && !(0.0..=1.0).contains(&chance)
    {
        return Err(DiceError::Range(format!(
            "Condition \"{id}\" needs a chance in [0, 1], got {}.",
            num_to_string(chance)
        )));
    }
    let options = save_options_of(condition);
    if !options.is_empty() && chance.is_some() {
        return Err(DiceError::Error(format!(
            "Condition \"{id}\" has both a save and a chance; the save is the chance its grants take."
        )));
    }
    for option in &options {
        let valid = match option {
            GrantSaveSpec::Dc { dc, bonus, .. } => dc.is_finite() && bonus.is_finite(),
            GrantSaveSpec::FailChance { .. } => true,
        };
        if !valid {
            return Err(DiceError::Error(format!(
                "Condition \"{id}\" has a save that is neither {{ dc, bonus }} nor {{ failChance }}."
            )));
        }
    }
    if condition.on == ConditionOn::Start {
        let tried = [
            ("save", condition.save.is_some()),
            ("chance", condition.chance.is_some()),
            ("onSave", condition.on_save.is_some()),
            ("landing", condition.landing.is_some()),
            ("dealing", condition.dealing.is_some()),
        ]
        .into_iter()
        .find(|(_, set)| *set);
        if let Some((tried, _)) = tried {
            return Err(DiceError::Error(format!(
                "Condition \"{id}\" is in force from the start, so nothing tries it: it takes no \"{tried}\"."
            )));
        }
        if let Some(target) = &condition.target
            && target != DEFAULT_CREATURE
            && !attack_targets.contains(target)
        {
            return Err(fail(
                TurnSpecErrorCode::UnknownId,
                id,
                format!(
                    "Condition \"{id}\" starts on \"{target}\", which no attack is aimed at. Name \"{DEFAULT_CREATURE}\" or an attack's target."
                ),
            ));
        }
    } else if condition.target.is_some() {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Condition \"{id}\" names a target, which only a \"start\" condition takes: the others are on the creature of the row that lands them."
            ),
        ));
    }
    if condition.on_save.is_some() && chance.is_none() && options.is_empty() {
        return Err(DiceError::Error(format!(
            "Condition \"{id}\" has onSave grants but no save or chance: there is no other branch to apply them on."
        )));
    }
    checked_target_has(id, condition.target_has.as_deref())?;
    if condition.target_has.is_some()
        && !matches!(
            condition.on,
            ConditionOn::Attack(
                AttackTriggerOn::EveryHit | AttackTriggerOn::AnyCrit | AttackTriggerOn::AnyMiss
            )
        )
    {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Condition \"{id}\" has a targetHas on \"{}\". Only every-hit, any-crit and any-miss conditions are gated on a condition of the target: a once-per-turn gate would need a first that counts only open ones.",
                condition.on.as_str()
            ),
        ));
    }
    for grant in condition
        .grants
        .iter()
        .chain(condition.on_save.iter().flatten())
    {
        match grant {
            EffectSpec::Vulnerability | EffectSpec::SaveDisadvantage { .. } => {}
            EffectSpec::SavePenalty { count, sides, .. } => {
                if !(is_integer(*count) && *count >= 1.0 && is_integer(*sides) && *sides >= 1.0) {
                    return Err(DiceError::Range(format!(
                        "Condition \"{id}\" has a save penalty of {}d{}; use whole dice of 1 or more.",
                        num_to_string(*count),
                        num_to_string(*sides)
                    )));
                }
            }
            EffectSpec::Condition { rule, .. } => {
                for rule in [Some(rule), rule.on_end.as_ref().map(|end| &end.rule)]
                    .into_iter()
                    .flatten()
                {
                    let Some(penalty) = rule.d20_penalty else {
                        continue;
                    };
                    if !is_integer(penalty) || penalty < 0.0 {
                        return Err(DiceError::Range(format!(
                            "Condition \"{id}\" has a d20Penalty of {}; use a whole number of 0 or more.",
                            num_to_string(penalty)
                        )));
                    }
                    let attack_keys = rule
                        .attack
                        .as_ref()
                        .is_some_and(|a| a.melee.is_some() || a.ranged.is_some());
                    let save_keys = rule.save.as_ref().is_some_and(|s| !s.is_empty());
                    if penalty > 0.0 && (attack_keys || save_keys) {
                        return Err(fail(
                            TurnSpecErrorCode::UnsupportedTrigger,
                            id,
                            format!(
                                "Condition \"{id}\" has a rule with a d20Penalty and attack or save modifiers. A turn reads a d20Penalty as penalty dice on the saves, so give the modifiers to another rule."
                            ),
                        ));
                    }
                }
            }
            EffectSpec::Grant(g) => {
                if !g.advantage && !g.disadvantage && !g.crit_on_hit {
                    return Err(DiceError::Error(format!(
                        "Condition \"{id}\" has a grant that sets no modifier."
                    )));
                }
            }
        }
    }
    Ok(())
}

fn check_substitute(substitute: &SubstituteSpec, id: &str) -> Result<(), DiceError> {
    let reroll = substitute.on == SubstituteOn::FirstHit
        && substitute.substitute == SubstituteKind::RerollKeepHigher;
    let convert =
        substitute.on == SubstituteOn::FirstMiss && substitute.substitute == SubstituteKind::Hit;
    let miss_reroll =
        substitute.on == SubstituteOn::FirstMiss && substitute.substitute == SubstituteKind::Reroll;
    if !reroll && !convert && !miss_reroll {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Substitute \"{id}\" must be {{ on: \"first-hit\", substitute: \"reroll-keep-higher\" }}, {{ on: \"first-miss\", substitute: \"hit\" }} or {{ on: \"first-miss\", substitute: \"reroll\" }}."
            ),
        ));
    }
    if let Some(mode) = substitute.mode
        && !miss_reroll
    {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Substitute \"{id}\" has mode \"{}\": only a first-miss reroll takes a mode, \"reroll\" or \"add-d20\".",
                mode.as_str()
            ),
        ));
    }
    if (convert || miss_reroll) && substitute.policy.is_some() {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedPolicy,
            id,
            format!(
                "Substitute \"{id}\" {} the first miss, which takes no policy.",
                if convert { "converts" } else { "rerolls" }
            ),
        ));
    }
    if substitute.policy == Some(SubstitutePolicy::Optimal) {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedPolicy,
            id,
            format!(
                "Substitute \"{id}\" asks for the optimal policy, which this release does not support."
            ),
        ));
    }
    Ok(())
}

/// One step of the depth-first `visit` of the dependency order (plan.ts 2361-2375).
struct Visit<'a> {
    node_ids: &'a [String],
    source_ids_by_node: &'a [Vec<String>],
    node_index_by_id: &'a HashMap<String, usize>,
    visiting: HashSet<usize>,
    done: HashSet<usize>,
    order: Vec<usize>,
}

impl Visit<'_> {
    fn visit(&mut self, node: usize, depth: usize) -> Result<(), DiceError> {
        if self.done.contains(&node) {
            return Ok(());
        }
        if depth > MAX_DEPTH {
            return Err(DiceError::Range("Maximum call stack size exceeded".into()));
        }
        let id = self.node_ids.get(node).map(String::as_str).unwrap_or("");
        if self.visiting.contains(&node) {
            return Err(fail(
                TurnSpecErrorCode::Cycle,
                id,
                format!("\"{id}\" is part of a dependency cycle."),
            ));
        }
        self.visiting.insert(node);
        let sources = self.source_ids_by_node;
        for source_id in sources.get(node).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some(&dependency) = self.node_index_by_id.get(source_id) {
                self.visit(dependency, depth + 1)?;
            }
        }
        self.visiting.remove(&node);
        self.done.insert(node);
        self.order.push(node);
        Ok(())
    }
}

impl Resolved {
    /// `damageOf(sourceId)`: the damage a source id rolls: a declared attack's source or a rider's payload.
    pub fn damage_of(&self, source_id: &str) -> PlanDamage {
        if let Some(source) = self
            .attack_index_by_id
            .get(source_id)
            .and_then(|&i| self.attack_sources.get(i))
        {
            return PlanDamage::One(source.clone());
        }
        // INFALLIBLE: every source id is an attack or a rider; an unknown id reads as no damage.
        match self
            .rider_index_by_id
            .get(source_id)
            .and_then(|&i| self.riders.get(i))
        {
            Some(rider) => plan_damage_of(&rider.damage),
            None => PlanDamage::Many(Vec::new()),
        }
    }

    /// `matchInfoOf(sourceId)`.
    pub fn match_info_of(
        &self,
        source_id: &str,
    ) -> Result<(Option<DiceMatchInfo>, Option<DiceMatchInfo>), DiceError> {
        match self.damage_of(source_id) {
            PlanDamage::Many(_) => Ok((None, None)),
            PlanDamage::One(source) => dice_match_info_of(&source, self.eps),
        }
    }

    /// `slicesOf(sourceId)`: attack slices, or a rider's (computed on first use).
    pub fn slices_of(&self, source_id: &str) -> Result<Option<SourceSlices>, DiceError> {
        if let Some(&attack_index) = self.attack_index_by_id.get(source_id) {
            return Ok(self.attack_slices.get(attack_index).cloned().flatten());
        }
        // INFALLIBLE: every source id is an attack or a rider; an unknown id has no slices.
        let Some(&rider_index) = self.rider_index_by_id.get(source_id) else {
            return Ok(None);
        };
        if let Some(Some(known)) = lock(&self.rider_slices).get(rider_index) {
            return Ok(known.clone());
        }
        let Some(rider) = self.riders.get(rider_index) else {
            return Ok(None);
        };
        let pmf = self.rider_pmf(rider_index)?;
        let slices = slice_source(&pmf, Some(&plan_damage_of(&rider.damage)), self.eps)?;
        if let Some(slot) = lock(&self.rider_slices).get_mut(rider_index) {
            *slot = Some(slices.clone());
        }
        Ok(slices)
    }

    /// `riderPMF(index)` (computed on first use).
    pub fn rider_pmf(&self, index: usize) -> Result<Arc<Pmf>, DiceError> {
        if let Some(Some(known)) = lock(&self.rider_pmfs).get(index) {
            return Ok(known.clone());
        }
        let (Some(rider), Some(id)) = (self.riders.get(index), self.rider_ids.get(index)) else {
            return Err(DiceError::Error(format!("No rider at index {index}.")));
        };
        let pmf = Arc::new(rider_damage_pmf(&rider.damage, self.eps, id)?);
        if let Some(slot) = lock(&self.rider_pmfs).get_mut(index) {
            *slot = Some(pmf.clone());
        }
        Ok(pmf)
    }

    /// `isSaveRow(sourceId)`.
    pub fn is_save_row(&self, source_id: &str) -> bool {
        if let Some(&known) = lock(&self.save_rows).get(source_id) {
            return known;
        }
        let known = self
            .attack_index_by_id
            .get(source_id)
            .is_some_and(|&index| {
                matches!(self.attack_slices.get(index), Some(None))
                    && match (self.attack_sources.get(index), self.attack_pmfs.get(index)) {
                        (Some(source), Some(pmf)) => is_save_shaped(source, pmf, self.eps),
                        _ => false,
                    }
            });
        lock(&self.save_rows).insert(source_id.to_string(), known);
        known
    }

    /// `classesOf(sourceId)`: `saveClasses` of the declared attack's PMF.
    pub fn classes_of(&self, source_id: &str) -> SaveClasses {
        if let Some(known) = lock(&self.classes_by_id).get(source_id) {
            return known.clone();
        }
        // INFALLIBLE: only asked of a save row, which is a declared attack; else the empty PMF.
        let classes = match self
            .attack_index_by_id
            .get(source_id)
            .and_then(|&i| self.attack_pmfs.get(i))
        {
            Some(pmf) => save_classes(pmf),
            None => save_classes(&Pmf::empty(self.eps)),
        };
        lock(&self.classes_by_id).insert(source_id.to_string(), classes.clone());
        classes
    }

    /// `landingKinds.get(sourceId)`: the landing kinds declared for a watched save row, in the
    /// order they were declared; `None` where no rider declared one.
    pub fn landing_kinds_of(&self, source_id: &str) -> Option<Vec<SaveLanding>> {
        lock(&self.landing_kinds).get(source_id).cloned()
    }

    /// `saveSlices(sourceId, landing)`: `sourceId`'s slices as a rider reading it under `landing`
    /// sees them, or `None` when it is no save row or no kind is declared. Records the kind.
    fn save_slices(&self, source_id: &str, landing: Option<SaveLanding>) -> Option<SourceSlices> {
        let landing = landing?;
        if !self.is_save_row(source_id) {
            return None;
        }
        let mut kinds = lock(&self.landing_kinds);
        let declared = kinds.entry(source_id.to_string()).or_default();
        if !declared.contains(&landing) {
            declared.push(landing);
        }
        drop(kinds);
        Some(save_slices_by_landing(&self.classes_of(source_id), landing))
    }

    /// `resolveSources(ownerId, of, watchesDice, landing, skipUncrittable)`.
    pub fn resolve_sources(
        &self,
        owner_id: &str,
        of: &[String],
        watches_dice: bool,
        landing: Option<SaveLanding>,
        skip_uncrittable: bool,
    ) -> Result<Vec<String>, DiceError> {
        let mut source_ids: Vec<String> = Vec::new();
        for entry in of {
            if self.attack_index_by_id.contains_key(entry)
                || self.rider_index_by_id.contains_key(entry)
            {
                source_ids.push(entry.clone());
            } else if self.substitute_index_by_id.contains_key(entry)
                || self.condition_id_set.contains(entry)
                || self.probe_id_set.contains(entry)
            {
                let (kind, effect) = if self.substitute_index_by_id.contains_key(entry) {
                    ("substitute", "changes damage")
                } else if self.condition_id_set.contains(entry) {
                    ("condition", "changes later attack rolls")
                } else {
                    ("probe", "only reports a probability")
                };
                return Err(fail(
                    TurnSpecErrorCode::NotAnAttack,
                    entry,
                    format!(
                        "\"{owner_id}\" watches \"{entry}\", a {kind}. A {kind} {effect}; it rolls no attack to watch."
                    ),
                ));
            } else if let Some(tagged) = self.ids_by_tag.get(entry) {
                // For a rider, a tag reaches the rerolls declared before it, as an omitted `of`
                // does: never itself, and never a later reroll that could watch it back (a cycle).
                let owner_index = self.rider_index_by_id.get(owner_id);
                source_ids.extend(
                    tagged
                        .iter()
                        .filter(|id| {
                            let index = self.rider_index_by_id.get(*id);
                            match (owner_index, index) {
                                (Some(owner), Some(index)) => index < owner,
                                _ => true,
                            }
                        })
                        .cloned(),
                );
            } else {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    entry,
                    format!("\"{owner_id}\" depends on \"{entry}\", which is not in this turn."),
                ));
            }
        }
        // Deduplicated, so `of: ["a", "a"]` shares a trigger group with `of: ["a"]`.
        let unique: Vec<String> = source_ids
            .into_iter()
            .collect::<IndexSet<String>>()
            .into_iter()
            .collect();
        if unique.is_empty() {
            return Err(fail(
                TurnSpecErrorCode::UnknownId,
                owner_id,
                format!("\"{owner_id}\" has no sources."),
            ));
        }
        let mut skipped: HashSet<String> = HashSet::new();
        for source_id in &unique {
            if source_id == owner_id {
                return Err(fail(
                    TurnSpecErrorCode::SelfReference,
                    owner_id,
                    format!("\"{owner_id}\" cannot depend on itself."),
                ));
            }
            if let Some(&rider_index) = self.rider_index_by_id.get(source_id)
                && let Some(rider) = self.riders.get(rider_index)
            {
                if matches!(rider.trigger, Trigger::EveryHit { .. }) {
                    return Err(fail(
                        TurnSpecErrorCode::NotAnAttack,
                        source_id,
                        format!(
                            "\"{owner_id}\" triggers on \"{source_id}\", an every-hit rider. Those are folded into their own sources rather than resolved separately, so they cannot be triggered on — point at the attacks instead."
                        ),
                    ));
                }
                if rider.is_first_hit_fold() {
                    return Err(fail(
                        TurnSpecErrorCode::NotAnAttack,
                        source_id,
                        format!(
                            "\"{owner_id}\" triggers on \"{source_id}\", a first-hit rider with a payload per source. Those are folded into their own sources rather than resolved separately, so they cannot be triggered on — point at the attacks instead."
                        ),
                    ));
                }
                if self.attack_lists.get(rider_index).copied().unwrap_or(false) {
                    return Err(fail(
                        TurnSpecErrorCode::NotAnAttack,
                        source_id,
                        format!(
                            "\"{owner_id}\" watches \"{source_id}\", a list of several attacks. A list rider resolves as one payload, not as attacks that each land, so it cannot be watched. Declare each attack as its own rider with its own id, and name those."
                        ),
                    ));
                }
            }
            let slices = match self.slices_of(source_id)? {
                Some(slices) => Some(slices),
                None => self.save_slices(source_id, landing),
            };
            let Some(slices) = slices else {
                // A probe over `crit` skips the rows that cannot crit: a save or a flat payload.
                if skip_uncrittable && self.attack_index_by_id.contains_key(source_id) {
                    skipped.insert(source_id.clone());
                    continue;
                }
                let save_hint = if landing.is_none() && self.is_save_row(source_id) {
                    " It is a save: a rider can watch a save row by declaring `landing` (\"fail\" or \"damage\")."
                } else {
                    ""
                };
                return Err(fail(
                    TurnSpecErrorCode::NotAnAttack,
                    source_id,
                    format!(
                        "\"{owner_id}\" triggers on \"{source_id}\", which has no hit/crit outcomes.{save_hint}"
                    ),
                ));
            };
            if watches_dice {
                let (hit, crit) = self.match_info_of(source_id)?;
                let missing_hit = slices.hit.mass() > 0.0 && hit.is_none();
                let missing_crit = slices.crit.mass() > 0.0 && crit.is_none();
                if missing_hit || missing_crit {
                    let mut missing: Vec<&str> = Vec::new();
                    if missing_hit {
                        missing.push("hit");
                    }
                    if missing_crit {
                        missing.push("crit");
                    }
                    // A list payload has no `diceMatchRefusals`: no reasons.
                    let reasons = match self.damage_of(source_id) {
                        PlanDamage::One(source) => dice_match_refusals_of(&source, &missing)?,
                        PlanDamage::Many(_) => Vec::new(),
                    };
                    return Err(fail(
                        TurnSpecErrorCode::NoDiceDescriptor,
                        source_id,
                        if reasons.is_empty() {
                            format!(
                                "Rider \"{owner_id}\" reads \"{source_id}\" for \"dice-match\", but \"{source_id}\" has no dice descriptor to match against — a bare PMF, a string-parsed expression, or a keep()/bestOf() pool (ambiguous \"the dice\" under crit doubling) cannot be matched."
                            )
                        } else {
                            format!(
                                "Rider \"{owner_id}\" reads \"{source_id}\" for \"dice-match\", but \"{source_id}\" has no dice descriptor to match against ({}).",
                                reasons.join("; ")
                            )
                        },
                    ));
                }
            }
        }
        Ok(if skipped.is_empty() {
            unique
        } else {
            unique
                .into_iter()
                .filter(|source_id| !skipped.contains(source_id))
                .collect()
        })
    }

    /// `defaultOf(before)`: an omitted `of`: every declared attack, plus the rerolls among the
    /// first `before` riders.
    pub fn default_of(&self, before: usize) -> Vec<String> {
        let mut of = self.attack_ids.clone();
        of.extend(
            self.rider_ids
                .iter()
                .enumerate()
                .filter(|(index, _)| {
                    *index < before && self.is_reroll.get(*index).copied().unwrap_or(false)
                })
                .map(|(_, id)| id.clone()),
        );
        of
    }

    /// `effectSourceOf(id)`: the index into `effect_sources` of the effects condition `id` puts in force.
    pub fn effect_source_of(&self, id: &str) -> Option<usize> {
        let index = self.condition_ids.iter().position(|c| c == id);
        // TS compares the two `-1` sentinels too: an unknown id with no starting condition is 0.
        if index == self.starting_index {
            return Some(0);
        }
        self.effect_sources
            .iter()
            .position(|source| matches!(source, EffectSource::Grant(grant) if grant == id))
    }

    /// `ownSourcesOf(rider, index)`: the rows a rider watches itself (partners left out).
    fn own_sources_of(&self, index: usize) -> Result<Vec<String>, DiceError> {
        let Some(rider) = self.riders.get(index) else {
            return Ok(Vec::new());
        };
        let id = self.rider_ids.get(index).map(String::as_str).unwrap_or("");
        let of = rider.of_list();
        // An explicit `of: []` watches nothing, so the rider never lands; an omitted `of` defaults.
        if matches!(&of, Some(list) if list.is_empty()) {
            return Ok(Vec::new());
        }
        let declared = of.unwrap_or_else(|| self.default_of(index));
        let partners = self
            .partners_of
            .get(index)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let of: Vec<String> = declared
            .into_iter()
            .filter(|entry| !partners.contains(entry))
            .collect();
        // Only partners: the rider lands on no row of its own.
        if of.is_empty() && !partners.is_empty() {
            return Ok(Vec::new());
        }
        let landing = match rider.landing {
            Some(RiderLanding::Any) => Some(SaveLanding::Fail),
            Some(RiderLanding::Save(landing)) => Some(landing),
            None => None,
        };
        self.resolve_sources(
            id,
            &of,
            matches!(rider.trigger, Trigger::DiceMatch { .. }),
            landing,
            false,
        )
    }

    /// `foldedRider(index)`: whether rider `index` is folded into its sources' draws.
    fn folded_rider(&self, index: usize) -> bool {
        self.riders.get(index).is_some_and(|rider| {
            matches!(rider.trigger, Trigger::EveryHit { .. }) || rider.is_first_hit_fold()
        })
    }

    /// `checkRiderGate(id, index, riderId, node)`: refuses a gate on rider `node` that could not be
    /// read: what it watches must all resolve before the attack.
    fn check_rider_gate(
        &self,
        id: &str,
        index: usize,
        rider_id: &str,
        node: usize,
    ) -> Result<(), DiceError> {
        let Some(rider) = self.riders.get(node) else {
            return Ok(());
        };
        if matches!(rider.trigger, Trigger::NotFired { .. }) {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Attack \"{id}\" happens after \"{rider_id}\", a not-fired rider. Only a rider that reads attacks can gate an attack."
                ),
            ));
        }
        if self.attack_lists.get(node).copied().unwrap_or(false)
            || self.slices_of(rider_id)?.is_some()
        {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Attack \"{id}\" happens after \"{rider_id}\", a rider that rolls its own attack. Only a rider that deals damage can gate an attack."
                ),
            ));
        }
        if let Some(happens) = rider.happens
            && happens != 1.0
        {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Attack \"{id}\" happens after \"{rider_id}\", a rider that may not happen (happens {}). Its coin would have to be shared by the rider's damage and the gated attack, which a gate cannot do.",
                    num_to_string(happens)
                ),
            ));
        }
        for source in self
            .source_ids_by_node
            .get(node)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let Some(&watched) = self.attack_index_by_id.get(source) else {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    rider_id,
                    format!(
                        "Attack \"{id}\" happens after rider \"{rider_id}\", which watches \"{source}\", a rider that resolves after every declared attack."
                    ),
                ));
            };
            if watched >= index {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    rider_id,
                    format!(
                        "Attack \"{id}\" happens after rider \"{rider_id}\", which watches \"{source}\", an attack that does not come before it."
                    ),
                ));
            }
        }
        Ok(())
    }

    /// `watchesMiss(sourceId, index)`.
    fn watches_miss(&self, source_id: &str, index: usize) -> bool {
        self.substitute_by_source.get(source_id) == Some(&index)
            || self
                .miss_rerolls_by_source
                .get(source_id)
                .is_some_and(|list| list.contains(&index))
    }
}

/// `buildPlan`'s first stretch: validates `spec` and resolves it (plan.ts 1399-2490), in TS order,
/// so the same spec fails with the same error.
pub(super) fn resolve(
    spec: &TurnSpec,
    eps: f64,
    declined: &HashSet<String>,
    folds: FoldMode,
) -> Result<Resolved, DiceError> {
    let declared_conditions: &[ConditionSpec] = spec.conditions.as_deref().unwrap_or(&[]);
    check_state_limit(spec.state_limit)?;

    let declared_riders: &[Rider] = spec.riders.as_deref().unwrap_or(&[]);
    let lowered = lower(declared_riders)?;
    let substitutes: Vec<SubstituteSpec> = spec.substitutes.clone().unwrap_or_default();
    let probes: Vec<ProbeSpec> = spec.observe.clone().unwrap_or_default();
    let (placed, contextual_payloads, crit_only) = place(&lowered, eps)?;
    let wakes = declared_conditions.iter().any(|condition| {
        condition
            .grants
            .iter()
            .chain(condition.on_save.iter().flatten())
            .any(|effect| {
                matches!(
                    effect,
                    EffectSpec::Condition {
                        until: ConditionUntil::UntilDamaged,
                        ..
                    }
                )
            })
    });
    // A rider that another rider or a substitute watches stays a step; one a condition watches
    // is folded, so the condition can fire on the row it lands on.
    let named: HashSet<String> = lowered
        .iter()
        .flat_map(|rider| trigger_of(&rider.trigger).unwrap_or_default())
        .chain(
            substitutes
                .iter()
                .flat_map(|s| s.of.clone().unwrap_or_default()),
        )
        .collect();
    let watched_by_conditions: HashSet<&String> = declared_conditions
        .iter()
        .flat_map(|condition| condition.of.iter().flatten())
        .collect();
    let mut riders: Vec<EvaluatedRider> = Vec::with_capacity(placed.len());
    for rider in placed {
        let candidate = matches!(rider.trigger, Trigger::FirstHit { .. })
            && rider.per_source().is_none()
            && (wakes
                || rider.landing == Some(RiderLanding::Any)
                || rider.joins.is_some()
                || rider
                    .id
                    .as_ref()
                    .is_some_and(|id| watched_by_conditions.contains(id)))
            && rider.id.as_ref().is_none_or(|id| !named.contains(id));
        let fold = candidate && matches!(lone_slices(&rider.damage, eps)?, Some(None));
        let mut rider = rider;
        if fold {
            set_empty_per_source(&mut rider);
        }
        riders.push(rider);
    }
    // A first-hit rider whose `of` names a folded first-hit rider lands alongside it (a partner):
    // folded too; one whose damage rolls an attack is refused. Iterated: a rider folded here can
    // be the partner of a later one.
    let id_of = |rider: &EvaluatedRider, index: usize| rider_label(&rider.id, index);
    let mut changed = true;
    while changed {
        changed = false;
        let folded: HashSet<String> = riders
            .iter()
            .enumerate()
            .filter(|(_, rider)| rider.is_first_hit_fold())
            .map(|(index, rider)| id_of(rider, index))
            .collect();
        for index in 0..riders.len() {
            let Some(rider) = riders.get(index) else {
                continue;
            };
            if !matches!(rider.trigger, Trigger::FirstHit { .. }) || rider.per_source().is_some() {
                continue;
            }
            let Trigger::FirstHit { of: Some(of), .. } = &rider.trigger else {
                continue;
            };
            let id = id_of(rider, index);
            let Some(partner) = of
                .iter()
                .find(|entry| **entry != id && folded.contains(*entry))
            else {
                continue;
            };
            let rolls_attack = match lone_slices(&rider.damage, eps)? {
                None => true,
                Some(slices) => slices.is_some(),
            };
            if rolls_attack {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    &id,
                    format!(
                        "Rider \"{id}\" lands alongside \"{partner}\", so it is dealt with that rider's landing and cannot roll an attack of its own. Give it damage, or watch the attacks directly."
                    ),
                ));
            }
            if let Some(rider) = riders.get_mut(index) {
                set_empty_per_source(rider);
            }
            changed = true;
        }
    }

    // --- attacks ---
    let mut attack_ids = Vec::new();
    let mut attack_sources = Vec::new();
    let mut attack_pmfs = Vec::new();
    let mut attack_singles = Vec::new();
    let mut attack_slices = Vec::new();
    let mut attack_chances = Vec::new();
    let mut ids_by_tag: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut attack_targets = Vec::new();
    let mut attack_afters = Vec::new();
    for attack in declared_attacks(spec, eps)? {
        attack_ids.push(attack.id.clone());
        attack_sources.push(attack.source);
        // The toQuery() single is the attack's marginal: gated by its occurrence probability.
        attack_singles.push(if attack.chance == 1.0 {
            attack.pmf.clone()
        } else {
            Arc::new(attack.pmf.apply_hit_frequency(attack.chance))
        });
        attack_pmfs.push(attack.pmf);
        attack_slices.push(attack.slices);
        attack_chances.push(attack.chance);
        attack_targets.push(attack.target);
        attack_afters.push(attack.after);
        for tag in attack.tags {
            ids_by_tag.entry(tag).or_default().push(attack.id.clone());
        }
    }

    // --- attached conditions: declared ones first, so their default ids never collide ---
    let mut conditions: Vec<ConditionSpec> = declared_conditions.to_vec();
    for (index, slot_id) in attack_ids.iter().enumerate() {
        let Some(source) = attack_sources.get(index) else {
            continue;
        };
        let Some(attached) = attached_conditions_of(source) else {
            continue;
        };
        for (entry_index, entry) in attached.iter().enumerate() {
            conditions.push(condition_from_attached(slot_id, entry_index, entry, eps)?);
        }
    }

    // --- ids ---
    let rider_ids: Vec<String> = riders
        .iter()
        .enumerate()
        .map(|(index, rider)| rider_label(&rider.id, index))
        .collect();
    let substitute_ids: Vec<String> = substitutes
        .iter()
        .enumerate()
        .map(|(index, s)| {
            s.id.clone()
                .unwrap_or_else(|| format!("substitute {}", index + 1))
        })
        .collect();
    let condition_ids: Vec<String> = conditions
        .iter()
        .enumerate()
        .map(|(index, c)| {
            c.id.clone()
                .unwrap_or_else(|| format!("condition {}", index + 1))
        })
        .collect();
    let probe_ids: Vec<String> = probes
        .iter()
        .enumerate()
        .map(|(index, p)| {
            p.id.clone()
                .unwrap_or_else(|| format!("probe {}", index + 1))
        })
        .collect();
    // Where an effect comes from: the starting condition, then each other condition in order.
    let starting_index = conditions.iter().position(|condition| {
        condition.on == ConditionOn::Start
            && condition.id.is_none()
            && condition.target.as_deref().unwrap_or(DEFAULT_CREATURE) == DEFAULT_CREATURE
            && matches!(
                condition.grants.as_slice(),
                [EffectSpec::Condition {
                    until: ConditionUntil::EndOfTurn,
                    ..
                }]
            )
    });
    let mut effect_sources: Vec<EffectSource> = Vec::new();
    if starting_index.is_some() {
        effect_sources.push(EffectSource::Starting);
    }
    for (index, id) in condition_ids.iter().enumerate() {
        if Some(index) != starting_index {
            effect_sources.push(EffectSource::Grant(id.clone()));
        }
    }
    let all_ids: Vec<String> = attack_ids
        .iter()
        .chain(&rider_ids)
        .chain(&substitute_ids)
        .chain(&condition_ids)
        .chain(&probe_ids)
        .cloned()
        .collect();
    check_duplicate_ids(&all_ids)?;

    for (index, rider) in riders.iter().enumerate() {
        let (Some(id), Some(declared)) = (rider_ids.get(index), declared_riders.get(index)) else {
            continue;
        };
        check_rider(rider, declared, id)?;
    }
    for (index, condition) in conditions.iter().enumerate() {
        if let Some(id) = condition_ids.get(index) {
            check_condition(condition, id, &attack_targets)?;
        }
    }
    for (index, substitute) in substitutes.iter().enumerate() {
        if let Some(id) = substitute_ids.get(index) {
            check_substitute(substitute, id)?;
        }
    }

    let index_map = |ids: &[String]| -> HashMap<String, usize> {
        ids.iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i))
            .collect()
    };
    let attack_index_by_id = index_map(&attack_ids);
    let rider_index_by_id = index_map(&rider_ids);
    let substitute_index_by_id = index_map(&substitute_ids);
    let condition_id_set: HashSet<String> = condition_ids.iter().cloned().collect();
    let probe_id_set: HashSet<String> = probe_ids.iter().cloned().collect();
    let rider_count = riders.len();
    let node_ids: Vec<String> = rider_ids.iter().chain(&substitute_ids).cloned().collect();
    let node_index_by_id = index_map(&node_ids);

    let mut res = Resolved {
        eps,
        folds,
        state_limit: spec.state_limit,
        riders,
        rider_ids,
        contextual_payloads,
        crit_only,
        substitutes,
        substitute_ids,
        probes,
        probe_ids,
        conditions,
        condition_ids,
        effect_sources,
        starting_index,
        attack_ids,
        attack_sources,
        attack_pmfs,
        attack_singles,
        attack_slices,
        attack_chances,
        ids_by_tag,
        attack_targets,
        attack_afters,
        attack_index_by_id,
        rider_index_by_id,
        substitute_index_by_id,
        condition_id_set,
        probe_id_set,
        attack_lists: Vec::new(),
        is_reroll: Vec::new(),
        reroll_ids: Vec::new(),
        rider_count,
        node_ids,
        node_index_by_id,
        partners_of: Vec::new(),
        opened_by: Vec::new(),
        source_ids_by_node: Vec::new(),
        condition_riders: Vec::new(),
        condition_sources: Vec::new(),
        dealt_sources: HashSet::new(),
        dealing_type: None,
        dealing_sources: HashSet::new(),
        probe_sources: Vec::new(),
        order: Vec::new(),
        substitute_by_source: HashMap::new(),
        miss_rerolls_by_source: HashMap::new(),
        rider_pmfs: Mutex::new(vec![None; rider_count]),
        rider_slices: Mutex::new(vec![None; rider_count]),
        save_rows: Mutex::new(HashMap::new()),
        landing_kinds: Mutex::new(IndexMap::new()),
        classes_by_id: Mutex::new(HashMap::new()),
    };

    // Per rider: whether its payload is a list of more than one attack (a flurry's two strikes).
    let mut attack_lists = Vec::with_capacity(rider_count);
    for (index, rider) in res.riders.iter().enumerate() {
        attack_lists.push(match (&rider.damage, res.rider_ids.get(index)) {
            (RiderDamage::Many(parts), Some(id)) => attack_part_count(parts, eps, id)? > 1,
            _ => false,
        });
    }
    res.attack_lists = attack_lists;

    // Attack-shaped `any-miss` / `first-miss` riders: a reroll continues the attacks it watches.
    let mut is_reroll = Vec::with_capacity(rider_count);
    for (index, rider) in res.riders.iter().enumerate() {
        let watches_misses = matches!(
            rider.trigger,
            Trigger::AnyMiss { .. } | Trigger::FirstMiss { .. }
        );
        is_reroll.push(
            watches_misses
                && match res.rider_ids.get(index) {
                    Some(id) => res.slices_of(id)?.is_some(),
                    None => false,
                },
        );
    }
    res.is_reroll = is_reroll;
    res.reroll_ids = res
        .rider_ids
        .iter()
        .enumerate()
        .filter(|(index, _)| res.is_reroll[*index])
        .map(|(_, id)| id.clone())
        .collect();
    // A reroll's own tags name it, as a declared attack's do. A reroll given as a list holds one
    // attack, beside damage that carries no tags.
    let mut reroll_tags: Vec<(String, String)> = Vec::new();
    for (index, rider) in res.riders.iter().enumerate() {
        if !res.is_reroll[index] {
            continue;
        }
        let Some(id) = res.rider_ids.get(index) else {
            continue;
        };
        let tags: IndexSet<String> = rider
            .damage
            .parts()
            .iter()
            .flat_map(|part| source_tags(&Source::Damage(part.clone())))
            .collect();
        reroll_tags.extend(tags.into_iter().map(|tag| (tag, id.clone())));
    }
    for (tag, id) in reroll_tags {
        res.ids_by_tag.entry(tag).or_default().push(id);
    }

    // A folded rider named in another rider's `of` is a partner.
    res.partners_of = res
        .riders
        .iter()
        .enumerate()
        .map(|(own, rider)| match (&rider.trigger, rider.of_list()) {
            (Trigger::NotFired { .. }, _) | (_, None) => Vec::new(),
            (_, Some(of)) => of
                .into_iter()
                .filter(|entry| {
                    res.rider_index_by_id.get(entry).is_some_and(|&index| {
                        index != own
                            && res
                                .riders
                                .get(index)
                                .is_some_and(super::source::EvaluatedRider::is_first_hit_fold)
                    })
                })
                .collect(),
        })
        .collect();
    // Per rider, the rows a partner opens to it, with the partners that open each.
    let mut opened_by = Vec::with_capacity(rider_count);
    for (index, rider) in res.riders.iter().enumerate() {
        let mut opened: IndexMap<String, Vec<String>> = IndexMap::new();
        for partner in res.partners_of.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let rows = match rider.r#where.as_ref().and_then(|w| w.get(partner)) {
                Some(rows) => rows.clone(),
                None => match res.rider_index_by_id.get(partner) {
                    Some(&partner_index) => res.own_sources_of(partner_index)?,
                    None => Vec::new(),
                },
            };
            for row in rows {
                opened.entry(row).or_default().push(partner.clone());
            }
        }
        opened_by.push(opened);
    }
    res.opened_by = opened_by;

    // Every id a rider, a substitute or a condition names in its `of`.
    let named_by_others: HashSet<String> = res
        .riders
        .iter()
        .flat_map(|rider| rider.of_list().unwrap_or_default())
        .chain(
            res.substitutes
                .iter()
                .flat_map(|s| s.of.clone().unwrap_or_default()),
        )
        .chain(
            res.conditions
                .iter()
                .flat_map(|c| c.of.clone().unwrap_or_default()),
        )
        .collect();
    for (index, rider) in res.riders.iter().enumerate() {
        let id = res.rider_ids.get(index).map(String::as_str).unwrap_or("");
        let partners = res.partners_of.get(index).map(Vec::as_slice).unwrap_or(&[]);
        if rider.target_has.is_some() {
            let names = rider.of_list().unwrap_or_default();
            if let Some(partner) = names
                .iter()
                .find(|entry| res.rider_index_by_id.contains_key(*entry))
            {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    id,
                    format!(
                        "Rider \"{id}\" has a targetHas and watches the rider \"{partner}\". A gated rider is folded into attack draws: watch the attacks directly."
                    ),
                ));
            }
            if named_by_others.contains(id) || rider.joins.is_some() {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    id,
                    format!(
                        "Rider \"{id}\" has a targetHas and {}. A gated rider is folded into its attacks' draws and can be neither.",
                        if rider.joins.is_some() {
                            "joins a row's damage roll"
                        } else {
                            "is named by another entry"
                        }
                    ),
                ));
            }
        }
        for key in rider.r#where.iter().flat_map(|w| w.keys()) {
            if !partners.contains(key) {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    key,
                    format!(
                        "Rider \"{id}\" has \"where\" for \"{key}\", which is not a partner in its \"of\"."
                    ),
                ));
            }
        }
        if !partners.is_empty() && !matches!(rider.trigger, Trigger::FirstHit { .. }) {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Rider \"{id}\" lands alongside a partner, so it lands once: use first-hit."
                ),
            ));
        }
        // A fold gates a payload on a partner that lands on its own: a chain of partners is refused.
        let gated = partners.iter().find(|partner| {
            res.rider_index_by_id
                .get(*partner)
                .and_then(|&i| res.partners_of.get(i))
                .is_some_and(|p| !p.is_empty())
        });
        if let Some(gated) = gated {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Rider \"{id}\" lands alongside \"{gated}\", which itself lands alongside a partner; name a rider that lands on its own."
                ),
            ));
        }
    }

    let mut source_ids_by_node: Vec<Vec<String>> = Vec::new();
    for (index, rider) in res.riders.iter().enumerate() {
        let id = res.rider_ids.get(index).map(String::as_str).unwrap_or("");
        let Trigger::NotFired { of: target } = &rider.trigger else {
            let own = res.own_sources_of(index)?;
            let extra: Vec<String> = res
                .opened_by
                .get(index)
                .map(|opened| {
                    opened
                        .keys()
                        .filter(|row| !own.contains(*row))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let mut sources = own;
            sources.extend(extra);
            source_ids_by_node.push(sources);
            continue;
        };
        if target == id {
            return Err(fail(
                TurnSpecErrorCode::SelfReference,
                id,
                format!("Rider \"{id}\" cannot depend on itself."),
            ));
        }
        let Some(&target_index) = res.node_index_by_id.get(target) else {
            return Err(fail(
                TurnSpecErrorCode::UnknownId,
                target,
                format!(
                    "Rider \"{id}\" negates \"{target}\", which is not a rider or substitute in this turn."
                ),
            ));
        };
        if target_index < rider_count
            && res
                .riders
                .get(target_index)
                .is_some_and(|r| matches!(r.trigger, Trigger::EveryHit { .. }))
        {
            return Err(fail(
                TurnSpecErrorCode::NotAnAttack,
                target,
                format!(
                    "Rider \"{id}\" negates \"{target}\", an every-hit rider, which can fire more than once and so has no single \"did not fire\" branch."
                ),
            ));
        }
        source_ids_by_node.push(vec![target.clone()]);
    }
    for (index, substitute) in res.substitutes.iter().enumerate() {
        let id = res
            .substitute_ids
            .get(index)
            .map(String::as_str)
            .unwrap_or("");
        let of = substitute
            .of
            .clone()
            .unwrap_or_else(|| res.default_of(rider_count));
        source_ids_by_node.push(res.resolve_sources(id, &of, false, None, false)?);
    }
    res.source_ids_by_node = source_ids_by_node;

    // Per condition: the folded rider whose landing fires it (`of: [rider id]`, the attacks in `where`), if any.
    let mut condition_riders: Vec<Option<String>> = Vec::with_capacity(res.conditions.len());
    for (index, condition) in res.conditions.iter().enumerate() {
        let of: &[String] = condition.of.as_deref().unwrap_or(&[]);
        let named: Vec<&String> = of
            .iter()
            .filter(|entry| {
                res.rider_index_by_id
                    .get(*entry)
                    .is_some_and(|&i| res.folded_rider(i))
            })
            .collect();
        let Some(first) = named.first() else {
            condition_riders.push(None);
            continue;
        };
        if named.len() != of.len() || named.len() > 1 {
            let id = res
                .condition_ids
                .get(index)
                .map(String::as_str)
                .unwrap_or("");
            return Err(fail(
                TurnSpecErrorCode::NotAnAttack,
                id,
                format!(
                    "Condition \"{id}\" names a rider beside other entries in \"of\"; a condition fires where one rider landed, or on its rows."
                ),
            ));
        }
        condition_riders.push(Some((*first).clone()));
    }
    res.condition_riders = condition_riders;
    for (index, condition) in res.conditions.iter().enumerate() {
        let rider = res.condition_riders.get(index).and_then(|r| r.as_ref());
        for key in condition.r#where.iter().flat_map(|w| w.keys()) {
            if Some(key) != rider {
                let id = res
                    .condition_ids
                    .get(index)
                    .map(String::as_str)
                    .unwrap_or("");
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    key,
                    format!(
                        "Condition \"{id}\" has \"where\" for \"{key}\", which is not the rider in its \"of\"."
                    ),
                ));
            }
        }
    }
    let mut condition_sources: Vec<Vec<String>> = Vec::with_capacity(res.conditions.len());
    for (index, condition) in res.conditions.iter().enumerate() {
        let id = res
            .condition_ids
            .get(index)
            .map(String::as_str)
            .unwrap_or("");
        if condition.on == ConditionOn::Start
            || matches!(&condition.of, Some(of) if of.is_empty())
            || declined.contains(id)
        {
            condition_sources.push(Vec::new());
            continue;
        }
        let Some(Some(rider)) = res.condition_riders.get(index) else {
            let of = condition
                .of
                .clone()
                .unwrap_or_else(|| res.default_of(rider_count));
            condition_sources.push(res.resolve_sources(
                id,
                &of,
                false,
                condition.landing,
                false,
            )?);
            continue;
        };
        // The rows the rider can land on, in `where` when the condition lists them.
        let sources: Vec<String> = res
            .rider_index_by_id
            .get(rider)
            .and_then(|&i| res.source_ids_by_node.get(i))
            .cloned()
            .unwrap_or_default();
        let Some(wanted) = condition.r#where.as_ref().and_then(|w| w.get(rider)) else {
            condition_sources.push(sources);
            continue;
        };
        // An id must exist; one the rider does not watch is never a landing of it, so it counts nothing.
        for entry in wanted {
            if !res.attack_index_by_id.contains_key(entry)
                && !res.rider_index_by_id.contains_key(entry)
            {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    entry,
                    format!(
                        "Condition \"{id}\" counts \"{rider}\" landing on \"{entry}\", which is not in this turn."
                    ),
                ));
            }
        }
        condition_sources.push(sources.into_iter().filter(|s| wanted.contains(s)).collect());
    }
    res.condition_sources = condition_sources;

    // Riders that join rows.
    for (index, rider) in res.riders.iter().enumerate() {
        let Some(joins) = &rider.joins else {
            continue;
        };
        let id = res.rider_ids.get(index).map(String::as_str).unwrap_or("");
        if rider.landing == Some(RiderLanding::Any) {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Rider \"{id}\" joins rows but lands on anything: a miss has no roll to join."
                ),
            ));
        }
        if matches!(rider.trigger, Trigger::NotFired { .. }) {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Rider \"{id}\" joins rows but watches a rider, not attacks: it has no row to roll in."
                ),
            ));
        }
        for joined in joins {
            let Some(&attack_index) = res.attack_index_by_id.get(joined) else {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    joined,
                    format!(
                        "Rider \"{id}\" joins \"{joined}\", which is not an attack in this turn."
                    ),
                ));
            };
            if !res
                .source_ids_by_node
                .get(index)
                .is_some_and(|sources| sources.contains(joined))
            {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    joined,
                    format!(
                        "Rider \"{id}\" joins \"{joined}\", which it does not watch: a rider's dice join a row only where it can land."
                    ),
                ));
            }
            let rebindable = res
                .attack_sources
                .get(attack_index)
                .is_some_and(|source| is_contextual(source) && !ignores_joined(source));
            if !rebindable {
                return Err(fail(
                    TurnSpecErrorCode::NoRebindableSource,
                    joined,
                    format!(
                        "Rider \"{id}\" joins \"{joined}\", but joins needs a source that pools the rider's dice via under(context).joined; this row's source does not."
                    ),
                ));
            }
        }
    }

    // An attack gated on an earlier row: the row is an attack, or a rider that must have fired.
    for (index, after) in res.attack_afters.iter().enumerate() {
        let Some(after) = after else {
            continue;
        };
        let id = res.attack_ids.get(index).map(String::as_str).unwrap_or("");
        let parent = res.attack_index_by_id.get(&after.of);
        let rider_node = res.rider_index_by_id.get(&after.of);
        if parent.is_none() && rider_node.is_none() {
            return Err(fail(
                TurnSpecErrorCode::UnknownId,
                &after.of,
                format!(
                    "Attack \"{id}\" happens after \"{}\", which is not an attack or a rider in this turn.",
                    after.of
                ),
            ));
        }
        if let Some(&parent) = parent {
            if parent >= index {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    &after.of,
                    format!(
                        "Attack \"{id}\" happens after \"{}\", which does not come before it.",
                        after.of
                    ),
                ));
            }
        } else if let Some(&node) = rider_node {
            res.check_rider_gate(id, index, &after.of, node)?;
        }
    }
    let mut dealt_sources: HashSet<String> = HashSet::new();
    for after in res.attack_afters.iter().flatten() {
        if after.landing == AfterLanding::Damage && !res.is_save_row(&after.of) {
            dealt_sources.insert(after.of.clone());
        }
    }
    for (index, condition) in res.conditions.iter().enumerate() {
        if condition.landing == Some(SaveLanding::Damage) {
            for id in res.condition_sources.get(index).into_iter().flatten() {
                if !res.is_save_row(id) {
                    dealt_sources.insert(id.clone());
                }
            }
        }
    }
    for (index, rider) in res.riders.iter().enumerate() {
        if !matches!(rider.trigger, Trigger::NotFired { .. })
            && rider.landing == Some(RiderLanding::Save(SaveLanding::Damage))
        {
            for id in res.source_ids_by_node.get(index).into_iter().flatten() {
                if !res.is_save_row(id) {
                    dealt_sources.insert(id.clone());
                }
            }
        }
    }
    res.dealt_sources = dealt_sources;
    // Attack rows a condition reads under `dealing`: a turn names one type, as the engine's does.
    let dealing_types: Vec<String> = res
        .conditions
        .iter()
        .filter_map(|c| c.dealing.clone())
        .collect::<IndexSet<String>>()
        .into_iter()
        .collect();
    if dealing_types.len() > 1 {
        let first = res.condition_ids.first().map(String::as_str).unwrap_or("");
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            first,
            format!(
                "A turn may name one damage type a landing must deal; this one names {}.",
                dealing_types.join(", ")
            ),
        ));
    }
    res.dealing_type = dealing_types.first().cloned();
    for (index, condition) in res.conditions.iter().enumerate() {
        let Some(dealing) = &condition.dealing else {
            continue;
        };
        let reads_row = matches!(
            condition.on,
            ConditionOn::Attack(
                AttackTriggerOn::EveryHit | AttackTriggerOn::FirstHit | AttackTriggerOn::AnyCrit
            ) | ConditionOn::FirstCrit
        );
        let has_rider = matches!(res.condition_riders.get(index), Some(Some(_)));
        if !reads_row || has_rider {
            let id = res
                .condition_ids
                .get(index)
                .map(String::as_str)
                .unwrap_or("");
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Condition \"{id}\" needs {dealing} damage dealt, which only a hit or crit of an attack row can say."
                ),
            ));
        }
    }
    let mut dealing_sources: HashSet<String> = HashSet::new();
    for (index, condition) in res.conditions.iter().enumerate() {
        if condition.dealing.is_none() {
            continue;
        }
        for id in res.condition_sources.get(index).into_iter().flatten() {
            if !res.is_save_row(id) {
                dealing_sources.insert(id.clone());
            }
        }
    }
    res.dealing_sources = dealing_sources;
    // Per probe: the source ids whose crits it reports.
    let mut probe_sources = Vec::with_capacity(res.probes.len());
    for (index, probe) in res.probes.iter().enumerate() {
        let id = res.probe_ids.get(index).map(String::as_str).unwrap_or("");
        let of = probe
            .of
            .clone()
            .unwrap_or_else(|| res.default_of(rider_count));
        probe_sources.push(res.resolve_sources(id, &of, false, None, true)?);
    }
    res.probe_sources = probe_sources;

    // --- ordering: a node may only reference nodes that resolve before it ---
    let mut walk = Visit {
        node_ids: &res.node_ids,
        source_ids_by_node: &res.source_ids_by_node,
        node_index_by_id: &res.node_index_by_id,
        visiting: HashSet::new(),
        done: HashSet::new(),
        order: Vec::new(),
    };
    for node in 0..res.node_ids.len() {
        walk.visit(node, 0)?;
    }
    let order = walk.order;
    res.order = order;

    // --- substitutes: one transform per source ---
    let mut substitute_by_source: HashMap<String, usize> = HashMap::new();
    let mut miss_rerolls_by_source: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, substitute) in res.substitutes.iter().enumerate() {
        let rerolls = substitute.on == SubstituteOn::FirstMiss
            && substitute.substitute == SubstituteKind::Reroll;
        let own_id = res
            .substitute_ids
            .get(index)
            .map(String::as_str)
            .unwrap_or("");
        for source_id in res
            .source_ids_by_node
            .get(rider_count + index)
            .into_iter()
            .flatten()
        {
            if rerolls {
                miss_rerolls_by_source
                    .entry(source_id.clone())
                    .or_default()
                    .push(index);
            }
            let other = substitute_by_source.get(source_id).copied();
            let other_id = |other: usize| {
                res.substitute_ids
                    .get(other)
                    .map(String::as_str)
                    .unwrap_or("")
            };
            if rerolls {
                // Beside a reroll a source may hold one first-hit transform, never a hit conversion.
                if let Some(other) = other
                    && res
                        .substitutes
                        .get(other)
                        .is_some_and(|s| s.substitute == SubstituteKind::Hit)
                {
                    return Err(fail(
                        TurnSpecErrorCode::DuplicateSubstitute,
                        own_id,
                        format!(
                            "Substitutes \"{}\" and \"{own_id}\" both watch \"{source_id}\". A hit conversion and a reroll would both rewrite the same miss.",
                            other_id(other)
                        ),
                    ));
                }
                continue;
            }
            if let Some(other) = other {
                return Err(fail(
                    TurnSpecErrorCode::DuplicateSubstitute,
                    own_id,
                    format!(
                        "Substitutes \"{}\" and \"{own_id}\" both watch \"{source_id}\". One transform per source: two would apply to the same payload.",
                        other_id(other)
                    ),
                ));
            }
            if substitute.substitute == SubstituteKind::Hit
                && let Some(&reroll_index) = miss_rerolls_by_source
                    .get(source_id)
                    .and_then(|list| list.first())
            {
                return Err(fail(
                    TurnSpecErrorCode::DuplicateSubstitute,
                    own_id,
                    format!(
                        "Substitutes \"{}\" and \"{own_id}\" both watch \"{source_id}\". A hit conversion and a reroll would both rewrite the same miss.",
                        other_id(reroll_index)
                    ),
                ));
            }
            substitute_by_source.insert(source_id.clone(), index);
        }
    }
    res.substitute_by_source = substitute_by_source;
    res.miss_rerolls_by_source = miss_rerolls_by_source;

    // A source that says what its own reroll rolls (`rerolledUnder`) spends on every landing.
    for (index, substitute) in res.substitutes.iter().enumerate() {
        if substitute.on != SubstituteOn::FirstHit {
            continue;
        }
        let id = res
            .substitute_ids
            .get(index)
            .map(String::as_str)
            .unwrap_or("");
        for source_id in res
            .source_ids_by_node
            .get(rider_count + index)
            .into_iter()
            .flatten()
        {
            let rerolled_under = match res.damage_of(source_id) {
                PlanDamage::One(source) => has_rerolled_under(&source),
                PlanDamage::Many(_) => false,
            };
            if !rerolled_under {
                continue;
            }
            if matches!(substitute.policy, Some(SubstitutePolicy::Below { .. })) {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedPolicy,
                    id,
                    format!(
                        "Substitute \"{id}\" spends below a threshold, but \"{source_id}\" supplies its own reroll (rerolledUnder), which has no base payload to compare. Drop the policy."
                    ),
                ));
            }
            let read_by_dice_match = res.riders.iter().enumerate().any(|(rider_index, rider)| {
                matches!(rider.trigger, Trigger::DiceMatch { .. })
                    && res
                        .source_ids_by_node
                        .get(rider_index)
                        .is_some_and(|sources| sources.contains(source_id))
            });
            if read_by_dice_match {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    id,
                    format!(
                        "Substitute \"{id}\" rerolls \"{source_id}\", which supplies its own reroll (rerolledUnder) and a dice-match rider reads: the rerolled dice have no match odds."
                    ),
                ));
            }
        }
    }
    // A converted or rerolled miss becomes a roll of the row's own d20, so the row must roll to hit;
    // and a reroll of the row's miss by a rider resolves before any conversion.
    for (index, substitute) in res.substitutes.iter().enumerate() {
        if substitute.on != SubstituteOn::FirstMiss {
            continue;
        }
        let id = res
            .substitute_ids
            .get(index)
            .map(String::as_str)
            .unwrap_or("");
        let verb = if substitute.substitute == SubstituteKind::Reroll {
            "rerolls"
        } else {
            "converts"
        };
        for source_id in res
            .source_ids_by_node
            .get(rider_count + index)
            .into_iter()
            .flatten()
        {
            if res.slices_of(source_id)?.is_none() {
                return Err(fail(
                    TurnSpecErrorCode::NotAnAttack,
                    id,
                    format!(
                        "Substitute \"{id}\" {verb} a miss of \"{source_id}\", which rolls no attack."
                    ),
                ));
            }
        }
        for (rider_index, rider) in res.riders.iter().enumerate() {
            if !res.is_reroll.get(rider_index).copied().unwrap_or(false) {
                continue;
            }
            let rider_id = res
                .rider_ids
                .get(rider_index)
                .map(String::as_str)
                .unwrap_or("");
            // An any-miss reroll's step runs after every declared attack, not right after the miss.
            if matches!(rider.trigger, Trigger::AnyMiss { .. }) && res.watches_miss(rider_id, index)
            {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    id,
                    format!(
                        "Substitute \"{id}\" {verb} a miss of \"{rider_id}\", an any-miss reroll that resolves after every declared attack. Use onFirstMiss, which resolves right after the miss."
                    ),
                ));
            }
            let rerolled = res
                .source_ids_by_node
                .get(rider_index)
                .and_then(|sources| sources.iter().find(|s| res.watches_miss(s, index)));
            let Some(rerolled) = rerolled else {
                continue;
            };
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Substitute \"{id}\" {verb} a miss of \"{rerolled}\", which rider \"{rider_id}\" rerolls first. {} the rider's reroll instead: leave \"{rerolled}\" out of `of`.",
                    if substitute.substitute == SubstituteKind::Reroll {
                        "Reroll"
                    } else {
                        "Convert"
                    }
                ),
            ));
        }
    }
    // A `below` threshold looks ahead through the walk's plain draws for a later landing, which a
    // reroll turns a miss into: the two cannot share a turn.
    if !res.miss_rerolls_by_source.is_empty() {
        for (index, substitute) in res.substitutes.iter().enumerate() {
            if !matches!(substitute.policy, Some(SubstitutePolicy::Below { .. })) {
                continue;
            }
            let id = res
                .substitute_ids
                .get(index)
                .map(String::as_str)
                .unwrap_or("");
            return Err(fail(
                TurnSpecErrorCode::UnsupportedPolicy,
                id,
                format!(
                    "Substitute \"{id}\" spends below a threshold, which cannot be priced beside a first-miss reroll: a reroll turns a miss into a landing the look-ahead does not see. Use the \"always\" policy."
                ),
            ));
        }
    }
    Ok(res)
}
