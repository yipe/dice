//! `buildPlan` 2492-3182 (src/turn/plan.ts): groups, fire slots, the step sequence, flags and their
//! bits, group slots, and the grant applications. Output: [`Layout`].
//!
//! Flags are shared mutable objects in the TS (`conditionFlags`, `allFlags`, `liveFlags`, ...): here
//! they live in one arena, [`Layout::flags`], and every list holds indexes into it. The arena is in
//! creation order: each condition's flags creature by creature (main, then onSave, per creature),
//! then the coin flags, then the tried flags; the per-condition lists give the TS order.

use super::resolve::Resolved;
use super::source::save_options_of;
use super::{
    ChanceFn, DEFAULT_CREATURE, FireMode, GrantApplication, MAX_FLAG_BITS, Tried, ability_full,
    fail,
};
use crate::builder::dc::RolledIn;
use crate::builder::factory::d20;
use crate::common::RollType;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::turn::context::{
    MOD_ADVANTAGE, MOD_AUTO_FAIL, MOD_CRIT_ON_HIT, MOD_DISADVANTAGE, MOD_SAVE_DISADVANTAGE,
    MOD_VULNERABLE, PenaltyDice, RowCheck, RowContext, RowKind, RowRange, by_die,
    combine_roll_type, context_key, row_check_of,
};
use crate::turn::types::{
    AfterLanding, AttackRuleModifier, AttackTriggerOn, ConditionOn, ConditionRule, ConditionUntil,
    EffectSpec, GrantSaveSpec, GrantUntil, MAX_TRIGGER_GROUPS, RiderLanding, SaveLanding,
    SaveRuleModifier, SaveUntil, TurnSpecErrorCode,
};
use indexmap::{IndexMap, IndexSet};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::source::PlanDamage;

/// What a flag's grant save reads of it: `Flag.saveRead(ability)`.
#[derive(Clone, Debug)]
pub enum SaveRead {
    /// A condition's rule: `saveModifiersOf(rule, ability)` (0 for an unnamed ability).
    Rule(ConditionRule),
    /// A fixed `MOD_*` mask whatever the ability.
    Mask(u32),
    /// `() => 0`.
    Zero,
}

impl SaveRead {
    /// `flag.saveRead(ability)`.
    pub fn call(&self, ability: Option<&str>) -> u32 {
        match self {
            SaveRead::Rule(rule) => ability.map_or(0, |a| save_modifiers_of(rule, a)),
            SaveRead::Mask(mask) => *mask,
            SaveRead::Zero => 0,
        }
    }
}

/// `maskOf(modifiers, ATTACK_MODIFIERS)`.
fn attack_mask_of(modifiers: &[AttackRuleModifier]) -> u32 {
    modifiers.iter().fold(0, |mask, m| {
        mask | match m {
            AttackRuleModifier::Advantage => MOD_ADVANTAGE,
            AttackRuleModifier::Disadvantage => MOD_DISADVANTAGE,
            AttackRuleModifier::CritOnHit => MOD_CRIT_ON_HIT,
            AttackRuleModifier::Vulnerable => MOD_VULNERABLE,
        }
    })
}

/// `maskOf(modifiers, SAVE_MODIFIERS)`.
fn save_mask_of(modifiers: &[SaveRuleModifier]) -> u32 {
    modifiers.iter().fold(0, |mask, m| {
        mask | match m {
            SaveRuleModifier::AutoFail => MOD_AUTO_FAIL,
            SaveRuleModifier::SaveDisadvantage | SaveRuleModifier::Disadvantage => {
                MOD_SAVE_DISADVANTAGE
            }
        }
    })
}

/// `saveModifiersOf(rule, ability)`: what `rule` does to a save made with `ability`, either spelled
/// by its full or its three-letter name.
fn save_modifiers_of(rule: &ConditionRule, ability: &str) -> u32 {
    let full = ability_full(ability);
    rule.save
        .iter()
        .flatten()
        .fold(0, |mask, (key, modifiers)| {
            if ability_full(key) == full {
                mask | save_mask_of(modifiers)
            } else {
                mask
            }
        })
}

/// `Flag.side`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagSide {
    Attack,
    Save,
    Both,
}

/// `Flag.until` (`WalkEffect["until"]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagUntil {
    NextAttack,
    EndOfTurn,
    UntilDamaged,
    NextHit,
    NextSave,
}

/// `Flag`: one effect of one condition, as the plan tracks it.
#[derive(Clone, Debug)]
pub struct Flag {
    pub name: String,
    pub condition: String,
    pub creature: String,
    pub named: Option<String>,
    pub modifiers: u32,
    pub penalty: Option<PenaltyDice>,
    pub side: FlagSide,
    /// Per reading step (sequence position), what it puts in force there; ascending positions.
    pub reads: BTreeMap<usize, u32>,
    pub grant_save_reads: bool,
    pub save_read: SaveRead,
    pub until: FlagUntil,
    /// Steps whose variant it selects.
    pub readers: Vec<usize>,
    /// The first step that can set it (-1 for a `start` condition or a bit set before the walk).
    pub first: isize,
    /// The last step that reads it; -1 if none.
    pub last_read: isize,
    /// Its bit in the walk's flag word, or -1 when nothing reads it.
    pub bit: i32,
}

impl Flag {
    /// `1 << flag.bit` (0 for bit -1: only call it where `bit !== -1`).
    pub fn mask(&self) -> u32 {
        if self.bit < 0 { 0 } else { 1u32 << self.bit }
    }

    /// `liveAfter(flag, step)`: set by `step`, and read later.
    fn live_after(&self, step: usize) -> bool {
        let step = step as isize;
        self.first <= step && step < self.last_read
    }
}

/// An element of `sequence`: `{ id, attack, rider }` (`None` for TS -1).
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub attack: Option<usize>,
    pub rider: Option<usize>,
}

/// One condition's flags, as `conditionFlags[index]` holds them (indexes into [`Layout::flags`]).
#[derive(Clone, Debug)]
pub struct CondFlags {
    pub main: Vec<usize>,
    pub on_save: Vec<usize>,
    pub lasting_only: bool,
    /// Sequence positions of the condition's source steps.
    pub apply_at: Vec<usize>,
    /// creature -> (main, onSave) flags on it, in creature insertion order.
    pub by_creature: IndexMap<String, (Vec<usize>, Vec<usize>)>,
    pub start: bool,
}

/// Where everything `buildPlan` laid out lives. Immutable.
pub struct Layout {
    // --- groups ---
    /// `groupSources`.
    pub group_sources: Vec<Vec<String>>,
    /// `groupKeys`.
    pub group_keys: Vec<String>,
    /// `groupLandings`.
    pub group_landings: Vec<Option<SaveLanding>>,
    /// `readsByRider`: rider index -> group.
    pub reads_by_rider: BTreeMap<usize, usize>,
    /// `everyHitGroups`: rider id -> group, in insertion order.
    pub every_hit_groups: IndexMap<String, usize>,
    /// `gateRiders`: per declared attack, the rider index it is gated on.
    pub gate_riders: Vec<Option<usize>>,
    /// `gateGroups`: per declared attack, the group its gate reads (`None` = -1).
    pub gate_groups: Vec<Option<usize>>,
    /// `conditionGroups`: per condition.
    pub condition_groups: Vec<Option<usize>>,
    /// `probeGroups`: per probe.
    pub probe_groups: Vec<Option<usize>>,

    // --- fire slots and sequence ---
    /// `fireSlots`: rider / substitute id -> slot, in insertion order.
    pub fire_slots: IndexMap<String, usize>,
    /// `sequence`.
    pub sequence: Vec<Entry>,
    /// `rowFacts`: per sequence position.
    pub row_facts: Vec<Option<RowCheck>>,
    /// `rollsAttack`.
    pub rolls_attack: Vec<bool>,
    /// `savesAt`.
    pub saves_at: Vec<bool>,
    /// `creatureAt`.
    pub creature_at: Vec<String>,

    // --- flags ---
    /// The arena: every condition flag (creature by creature, main then onSave), then the coin
    /// flags, then the tried flags. Lists below index into it.
    pub flags: Vec<Flag>,
    /// `conditionFlags`: per condition.
    pub condition_flags: Vec<CondFlags>,
    /// `allFlags`: every condition flag (indexes), `main` then `onSave` per condition.
    pub all_flags: Vec<usize>,
    /// `happensOf`: per rider.
    pub happens_of: Vec<f64>,
    /// `coinFlags`: per rider.
    pub coin_flags: Vec<Option<usize>>,
    /// `triedFlags`: per condition.
    pub tried_flags: Vec<Option<usize>>,
    /// `liveFlags`.
    pub live_flags: Vec<usize>,
    /// `flagLiveAfter`: per step.
    pub flag_live_after: Vec<u32>,
    /// `readsAt`: per step, (flag index, modifiers) in declaration order.
    pub reads_at: Vec<Vec<(usize, u32)>>,
    /// `readMaskAt`.
    pub read_mask_at: Vec<u32>,
    /// `consumesAt`.
    pub consumes_at: Vec<u32>,
    /// `hitConsumesAt`.
    pub hit_consumes_at: Vec<u32>,
    /// `woundsAt`.
    pub wounds_at: Vec<u32>,

    // --- group slots ---
    /// `groupFirstStep` (-1: none).
    pub group_first_step: Vec<isize>,
    /// `groupLastStep` (-1: nothing reads the group; `sequence.len()` for the final collapse).
    pub group_last_step: Vec<isize>,
    /// `slotOfGroup`: `None` for -1.
    pub slot_of_group: Vec<Option<usize>>,
    /// `slotLastStep`: per slot.
    pub slot_last_step: Vec<isize>,
    /// `slotGroups`: per slot.
    pub slot_groups: Vec<Vec<usize>>,
    /// `releasesAt`: per step, the slots released after it.
    pub releases_at: Vec<Vec<usize>>,

    // --- grant applications ---
    /// `grantsAt`: per step.
    pub grants_at: Vec<Vec<GrantApplication>>,
}

impl Layout {
    /// `slotOf(group)`: the slot of a group; `None` for -1.
    pub fn slot_of(&self, group: Option<usize>) -> Option<usize> {
        group.and_then(|g| self.slot_of_group.get(g).copied().flatten())
    }

    /// `gatedFlagsAt(names, position)`: flags (indexes) of the conditions `names` names, on the
    /// creature of `position`, set before it.
    pub fn gated_flags_at(&self, names: &[String], position: usize) -> Vec<usize> {
        gated_flags(
            &self.flags,
            &self.all_flags,
            &self.creature_at,
            names,
            position,
        )
    }

    /// `gateMaskAt(names, position)`: the flag bits that open a `targetHas` gate on `names` at
    /// step `position`.
    pub fn gate_mask_at(&self, names: &[String], position: usize) -> u32 {
        gate_mask(
            &self.flags,
            &self.all_flags,
            &self.creature_at,
            names,
            position,
        )
    }

    /// `liveBitsOf(flags, step)`: the bits of `flags` (indexes) still needed once `step` is done.
    pub fn live_bits_of(&self, flags: &[usize], step: usize) -> u32 {
        live_bits(&self.flags, flags, step)
    }
}

fn gated_flags(
    arena: &[Flag],
    all_flags: &[usize],
    creature_at: &[String],
    names: &[String],
    position: usize,
) -> Vec<usize> {
    let Some(creature) = creature_at.get(position) else {
        return Vec::new();
    };
    all_flags
        .iter()
        .copied()
        .filter(|&i| {
            arena.get(i).is_some_and(|flag| {
                flag.named.as_ref().is_some_and(|n| names.contains(n))
                    && &flag.creature == creature
                    && flag.first < position as isize
            })
        })
        .collect()
}

fn gate_mask(
    arena: &[Flag],
    all_flags: &[usize],
    creature_at: &[String],
    names: &[String],
    position: usize,
) -> u32 {
    gated_flags(arena, all_flags, creature_at, names, position)
        .into_iter()
        .filter_map(|i| arena.get(i))
        .fold(0, |mask, flag| {
            if flag.bit == -1 {
                mask
            } else {
                mask | flag.mask()
            }
        })
}

fn live_bits(arena: &[Flag], flags: &[usize], step: usize) -> u32 {
    flags
        .iter()
        .filter_map(|&i| arena.get(i))
        .fold(0, |mask, flag| {
            if flag.bit != -1 && flag.live_after(step) {
                mask | flag.mask()
            } else {
                mask
            }
        })
}

/// The distinct source sets (and the landing kinds that split them) of the groups.
#[derive(Default)]
struct Groups {
    index_by_key: HashMap<String, usize>,
    sources: Vec<Vec<String>>,
    keys: Vec<String>,
    landings: Vec<Option<SaveLanding>>,
}

impl Groups {
    /// `groupOf(sourceIds, landing)`. A landing kind splits a group only through the save rows
    /// among its sources, or the attack rows a `damage` condition splits by damage dealt.
    fn group_of(
        &mut self,
        res: &Resolved,
        source_ids: &[String],
        landing: Option<SaveLanding>,
    ) -> usize {
        let kind = landing.filter(|&l| {
            source_ids.iter().any(|id| {
                res.is_save_row(id) || (l == SaveLanding::Damage && res.dealt_sources.contains(id))
            })
        });
        // JSON, not a delimiter join: an id is consumer-supplied. JS default sort: UTF-16 order.
        let mut sorted: Vec<&String> = source_ids.iter().collect();
        sorted.sort_by_key(|s| s.encode_utf16().collect::<Vec<u16>>());
        let key = serde_json::to_string(&(sorted, kind.map(SaveLanding::as_str)))
            // INFALLIBLE: strings and None always serialize; the fallback only keeps this total.
            .unwrap_or_default();
        if let Some(&existing) = self.index_by_key.get(&key) {
            return existing;
        }
        let index = self.sources.len();
        self.index_by_key.insert(key.clone(), index);
        self.sources.push(source_ids.to_vec());
        self.keys.push(key);
        self.landings.push(kind);
        index
    }
}

/// `rider.landing === "any" ? "fail" : rider.landing`.
fn rider_group_landing(landing: Option<RiderLanding>) -> Option<SaveLanding> {
    match landing {
        Some(RiderLanding::Any) => Some(SaveLanding::Fail),
        Some(RiderLanding::Save(l)) => Some(l),
        None => None,
    }
}

/// `creatureOf(sourceId)`: the creature a step is aimed at: a declared attack's `target`; a
/// rider's, its first source's. Depth capped (ADR-016).
fn creature_of(res: &Resolved, source_id: &str, depth: usize) -> Result<String, DiceError> {
    if depth > crate::builder::num::MAX_DEPTH {
        return Err(DiceError::Range("Maximum call stack size exceeded".into()));
    }
    if let Some(&attack) = res.attack_index_by_id.get(source_id) {
        return Ok(res
            .attack_targets
            .get(attack)
            .cloned()
            .unwrap_or_else(|| DEFAULT_CREATURE.into()));
    }
    let rider = res.rider_index_by_id.get(source_id).copied();
    let watched = rider.and_then(|r| res.source_ids_by_node.get(r));
    if let (Some(watched), Some(rider)) = (watched, rider)
        && let Some(first) = watched.first()
        && res.riders.get(rider).is_some_and(|r| r.on() != "not-fired")
    {
        return creature_of(res, first, depth + 1);
    }
    Ok(DEFAULT_CREATURE.into())
}

/// `checkAbility(owner, ability)`: a known ability, present where a rule reads saves by ability.
fn check_ability(
    ruled: &IndexSet<&'static str>,
    owner: &str,
    ability: Option<&str>,
) -> Result<(), DiceError> {
    match ability {
        None => {
            if !ruled.is_empty() {
                let list = ruled.iter().copied().collect::<Vec<_>>().join(", ");
                return Err(fail(
                    TurnSpecErrorCode::SaveWithoutAbility,
                    owner,
                    format!(
                        "\"{owner}\" is a save with no ability, but a condition in this turn changes saves by ability ({list})."
                    ),
                ));
            }
            Ok(())
        }
        Some(a) => super::source::check_known_ability(owner, a),
    }
}

/// The save option's ability.
fn option_ability(option: &GrantSaveSpec) -> Option<&str> {
    match option {
        GrantSaveSpec::Dc { ability, .. } | GrantSaveSpec::FailChance { ability, .. } => {
            ability.as_deref()
        }
    }
}

/// `rules`' of one condition's effects: each rule and the rule it leaves behind.
fn rules_of(effects: &[EffectSpec]) -> Vec<&ConditionRule> {
    let mut rules = Vec::new();
    for effect in effects {
        if let EffectSpec::Condition { rule, .. } = effect {
            rules.push(rule);
            if let Some(on_end) = &rule.on_end {
                rules.push(&on_end.rule);
            }
        }
    }
    rules
}

/// What the flag builders read of everything laid out before the flags.
struct FlagCtx<'a> {
    res: &'a Resolved,
    sequence: &'a [Entry],
    creature_at: &'a [String],
    row_facts: &'a [Option<RowCheck>],
    rolls_attack: &'a [bool],
    saves_at: &'a [bool],
}

impl FlagCtx<'_> {
    /// What a condition's rule puts in force on the row at `position` (`MOD_*` bits).
    fn rule_read(
        &self,
        name: &str,
        rule: &ConditionRule,
        position: usize,
    ) -> Result<u32, DiceError> {
        let facts = self.row_facts.get(position).and_then(|f| f.as_ref());
        if self.saves_at.get(position).copied().unwrap_or(false) {
            return Ok(match facts.and_then(|f| f.ability.as_deref()) {
                None => 0,
                Some(ability) => save_modifiers_of(rule, ability),
            });
        }
        let Some(attack) = &rule.attack else {
            return Ok(0);
        };
        if !self.rolls_attack.get(position).copied().unwrap_or(false) {
            return Ok(0);
        }
        let empty = Vec::new();
        let range = facts.and_then(|f| f.range);
        match range {
            Some(RowRange::Melee) => {
                return Ok(attack_mask_of(attack.melee.as_ref().unwrap_or(&empty)));
            }
            Some(RowRange::Ranged) => {
                return Ok(attack_mask_of(attack.ranged.as_ref().unwrap_or(&empty)));
            }
            None => {}
        }
        let melee = attack_mask_of(attack.melee.as_ref().unwrap_or(&empty));
        if melee == attack_mask_of(attack.ranged.as_ref().unwrap_or(&empty)) {
            return Ok(melee);
        }
        let id = self.sequence.get(position).map_or("", |e| e.id.as_str());
        Err(fail(
            TurnSpecErrorCode::UnknownRange,
            id,
            format!(
                "\"{id}\" is read by the condition \"{name}\", whose rule differs by range, but its row declares no range. Use \"melee\" or \"ranged\"."
            ),
        ))
    }

    /// `flagOf(effect, label, creature, first)`: one effect's flag, pushed onto the arena.
    #[allow(clippy::too_many_arguments)]
    fn flag_of(
        &self,
        arena: &mut Vec<Flag>,
        id: &str,
        effect: &EffectSpec,
        label: &str,
        creature: &str,
        first: isize,
        multi: bool,
    ) -> Result<usize, DiceError> {
        let to: Option<&Vec<String>> = match effect {
            EffectSpec::Grant(g) => g.to.as_ref(),
            EffectSpec::SaveDisadvantage { to, .. } | EffectSpec::SavePenalty { to, .. } => {
                to.as_ref()
            }
            EffectSpec::Condition { .. } | EffectSpec::Vulnerability => None,
        };
        // A `to` id must exist, but one with no row after the condition's first source that reads
        // the effect is simply never read: a no-op there.
        let targets: Option<HashSet<String>> = match to {
            None => None,
            Some(to) => {
                let mut set = HashSet::new();
                for entry in to {
                    if self.res.attack_index_by_id.contains_key(entry)
                        || self.res.rider_index_by_id.contains_key(entry)
                    {
                        set.insert(entry.clone());
                    } else if let Some(tagged) = self.res.ids_by_tag.get(entry) {
                        set.extend(tagged.iter().cloned());
                    } else {
                        set.extend(self.res.resolve_sources(
                            id,
                            std::slice::from_ref(entry),
                            false,
                            None,
                            false,
                        )?);
                    }
                }
                Some(set)
            }
        };
        let side = match effect {
            EffectSpec::Condition { .. } => FlagSide::Both,
            EffectSpec::SaveDisadvantage { .. } | EffectSpec::SavePenalty { .. } => FlagSide::Save,
            _ => FlagSide::Attack,
        };
        let modifiers = match effect {
            EffectSpec::Vulnerability => MOD_VULNERABLE,
            EffectSpec::SaveDisadvantage { .. } => MOD_SAVE_DISADVANTAGE,
            EffectSpec::SavePenalty { .. } | EffectSpec::Condition { .. } => 0,
            EffectSpec::Grant(g) => {
                (if g.advantage { MOD_ADVANTAGE } else { 0 })
                    | (if g.disadvantage { MOD_DISADVANTAGE } else { 0 })
                    | (if g.crit_on_hit { MOD_CRIT_ON_HIT } else { 0 })
            }
        };
        // A 2024 Exhaustion's `d20Penalty` takes that many off every D20 Test: dice of one side.
        let penalty = match effect {
            EffectSpec::SavePenalty { count, sides, .. } => Some(PenaltyDice {
                count: *count,
                sides: *sides,
            }),
            EffectSpec::Condition { rule, .. } => match rule.d20_penalty {
                Some(p) if p > 0.0 => Some(PenaltyDice {
                    count: p,
                    sides: 1.0,
                }),
                _ => None,
            },
            _ => None,
        };
        let until = match effect {
            EffectSpec::Grant(g) => match g.until {
                GrantUntil::NextAttack => FlagUntil::NextAttack,
                GrantUntil::EndOfTurn => FlagUntil::EndOfTurn,
            },
            EffectSpec::Condition { until, .. } => match until {
                ConditionUntil::EndOfTurn => FlagUntil::EndOfTurn,
                ConditionUntil::UntilDamaged => FlagUntil::UntilDamaged,
            },
            EffectSpec::Vulnerability => FlagUntil::NextHit,
            EffectSpec::SaveDisadvantage { until, .. } | EffectSpec::SavePenalty { until, .. } => {
                match until {
                    SaveUntil::EndOfTurn => FlagUntil::EndOfTurn,
                    SaveUntil::NextSave => FlagUntil::NextSave,
                }
            }
        };
        // Every attack roll on the creature after the condition's first source there, attack-shaped
        // riders included; for a save effect, every save row; for a condition, every row its rule changes.
        let mut reads = BTreeMap::new();
        for (position, entry) in self.sequence.iter().enumerate() {
            if !(position as isize > first)
                || self.creature_at.get(position).map(String::as_str) != Some(creature)
            {
                continue;
            }
            if targets.as_ref().is_some_and(|t| !t.contains(&entry.id)) {
                continue;
            }
            if let EffectSpec::Condition {
                condition, rule, ..
            } = effect
            {
                let read = self.rule_read(condition, rule, position)?;
                // A `d20Penalty` is penalty dice on the creature's saves, read even where the rule has no save modifier.
                if read != 0
                    || (penalty.is_some() && self.saves_at.get(position).copied().unwrap_or(false))
                {
                    reads.insert(position, read);
                }
            } else {
                let hit = if side == FlagSide::Attack {
                    self.rolls_attack.get(position).copied().unwrap_or(false)
                } else {
                    self.saves_at.get(position).copied().unwrap_or(false)
                };
                if hit {
                    reads.insert(position, modifiers);
                }
            }
        }
        let readers: Vec<usize> = reads.keys().copied().collect();
        let (named, save_read) = match effect {
            EffectSpec::Condition {
                condition, rule, ..
            } => (Some(condition.clone()), SaveRead::Rule(rule.clone())),
            _ => (None, SaveRead::Mask(modifiers)),
        };
        arena.push(Flag {
            name: format!(
                "\"{id}\" {label}{}",
                if multi {
                    format!(" on \"{creature}\"")
                } else {
                    String::new()
                }
            ),
            condition: id.to_string(),
            creature: creature.to_string(),
            named,
            modifiers,
            penalty,
            side,
            reads,
            // A grant's own save is no row: it reads what lasts (not a `next-save` effect) and is not scoped with `to`.
            grant_save_reads: side != FlagSide::Attack
                && to.is_none()
                && until != FlagUntil::NextSave,
            save_read,
            until,
            last_read: readers.last().map_or(-1, |&r| r as isize),
            readers,
            first,
            bit: -1,
        });
        Ok(arena.len() - 1)
    }

    /// `flagsOf(effect, ...)`: an effect's flags; a condition that damage ends brings the one it
    /// leaves behind (`onEnd`), lasting the turn.
    #[allow(clippy::too_many_arguments)]
    fn flags_of(
        &self,
        arena: &mut Vec<Flag>,
        id: &str,
        effect: &EffectSpec,
        label: &str,
        creature: &str,
        first: isize,
        multi: bool,
    ) -> Result<Vec<usize>, DiceError> {
        let mut out = vec![self.flag_of(arena, id, effect, label, creature, first, multi)?];
        if let EffectSpec::Condition {
            rule,
            until: ConditionUntil::UntilDamaged,
            ..
        } = effect
            && let Some(on_end) = &rule.on_end
        {
            {
                let left = EffectSpec::Condition {
                    condition: on_end.condition.clone(),
                    rule: on_end.rule.clone(),
                    until: ConditionUntil::EndOfTurn,
                };
                out.push(self.flag_of(
                    arena,
                    id,
                    &left,
                    &format!("{label} onEnd"),
                    creature,
                    first,
                    multi,
                )?);
            }
        }
        Ok(out)
    }
}

/// `[...a].sort(byDie)`: stable, never panics on a NaN comparator.
fn sort_by_die(dice: &mut [PenaltyDice]) {
    for i in 1..dice.len() {
        let mut j = i;
        while j > 0 {
            let out_of_order = match (dice.get(j - 1), dice.get(j)) {
                (Some(a), Some(b)) => by_die(a, b) > 0.0,
                _ => false,
            };
            if !out_of_order {
                break;
            }
            dice.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// What a grant save reads of one flag, snapshotted for the closure.
struct SaveFlag {
    mask: u32,
    penalty: Option<PenaltyDice>,
    read: SaveRead,
}

/// `plainSaveOdds`: a plain save's fail odds per `dc|bonus|context`.
type PlainOdds = Arc<Mutex<HashMap<String, f64>>>;

/// `grantSaveChance(id, options, position)`: the chance a condition's grant save fails at step
/// `position`, as a function of the state's flags; `None` without a save. The save reads what
/// lasts the turn on its target and was set before this row (not a `next-save` effect, which
/// belongs to the save rows, nor one scoped with `to`); the target saves with the option it fails
/// least.
#[allow(clippy::too_many_arguments)]
fn grant_save_chance(
    res: &Resolved,
    arena: &[Flag],
    all_flags: &[usize],
    creature_at: &[String],
    plain_odds: &PlainOdds,
    id: &str,
    options: Vec<GrantSaveSpec>,
    position: usize,
) -> Option<ChanceFn> {
    if options.is_empty() {
        return None;
    }
    let creature = creature_at.get(position);
    let reads: Vec<SaveFlag> = all_flags
        .iter()
        .filter_map(|&i| arena.get(i))
        .filter(|flag| {
            flag.grant_save_reads
                && flag.bit != -1
                && Some(&flag.creature) == creature
                && flag.first < position as isize
                && position as isize <= flag.last_read
        })
        .map(|flag| SaveFlag {
            mask: flag.mask(),
            penalty: flag.penalty,
            read: flag.save_read.clone(),
        })
        .collect();
    let known: Mutex<HashMap<u32, f64>> = Mutex::new(HashMap::new());
    let plain_odds = Arc::clone(plain_odds);
    let id = id.to_string();
    let eps = res.eps;
    Some(Arc::new(move |flags: u32| -> Result<f64, DiceError> {
        let key = reads.iter().fold(0, |key, flag| key | (flags & flag.mask));
        if let Some(&cached) = known
            .lock()
            .ok()
            .and_then(|k| k.get(&key).copied())
            .as_ref()
        {
            return Ok(cached);
        }
        let read: Vec<&SaveFlag> = reads.iter().filter(|f| flags & f.mask != 0).collect();
        let mut penalty_dice: Vec<PenaltyDice> = read.iter().filter_map(|f| f.penalty).collect();
        sort_by_die(&mut penalty_dice);
        let mut fail_odds = 1.0f64;
        for option in &options {
            // The option's ability decides what the target's conditions do to this save.
            let ability = option_ability(option);
            let modifiers = read.iter().fold(0, |mask, f| mask | f.read.call(ability));
            let own = match option {
                GrantSaveSpec::Dc { roll_type, .. } => roll_type.unwrap_or(RollType::Flat),
                GrantSaveSpec::FailChance { .. } => RollType::Flat,
            };
            let context = RowContext {
                roll_type: combine_roll_type(
                    own,
                    false,
                    modifiers & MOD_SAVE_DISADVANTAGE != 0,
                    false,
                ),
                auto_hit: false,
                crit_on_hit: false,
                auto_fail: modifiers & MOD_AUTO_FAIL != 0,
                vulnerable: false,
                penalty_dice: penalty_dice.clone(),
                joined: Vec::new(),
            };
            // An automatic failure never reaches a `failChance`. A plain save rolls the DC check a
            // fluent caller would have written, so its odds are the check's own PMF.
            let chance = if context.auto_fail {
                1.0
            } else {
                match option {
                    GrantSaveSpec::FailChance { fail_chance, .. } => fail_chance.call(&context)?,
                    GrantSaveSpec::Dc { dc, bonus, .. } => {
                        let odds_key = format!(
                            "{}|{}|{}",
                            num_to_string(*dc),
                            num_to_string(*bonus),
                            context_key(&context)
                        );
                        let cached = plain_odds
                            .lock()
                            .ok()
                            .and_then(|m| m.get(&odds_key).copied());
                        if let Some(odds) = cached {
                            odds
                        } else {
                            let odds = d20()
                                .plus(*bonus)?
                                .dc(*dc)?
                                .rolled_in(&RolledIn {
                                    roll_type: context.roll_type,
                                    auto_fail: context.auto_fail,
                                    penalty_dice: &context.penalty_dice,
                                })?
                                .to_pmf(eps)?
                                .p_at(1.0);
                            if let Ok(mut m) = plain_odds.lock() {
                                m.insert(odds_key, odds);
                            }
                            odds
                        }
                    }
                }
            };
            #[allow(clippy::neg_cmp_op_on_partial_ord, clippy::manual_range_contains)]
            // NaN guard: `!(x >= 0 && x <= 1)` is true for NaN.
            let bad = !(chance >= 0.0 && chance <= 1.0);
            if bad {
                return Err(DiceError::Range(format!(
                    "Condition \"{id}\" has a save whose fail chance is {}, not a probability.",
                    num_to_string(chance)
                )));
            }
            fail_odds = fail_odds.min(chance);
        }
        if let Ok(mut k) = known.lock() {
            k.insert(key, fail_odds);
        }
        Ok(fail_odds)
    }))
}

/// Unused import guard for types the contract names.
#[allow(dead_code)]
fn _types(_: Option<FireMode>) {}

/// `buildPlan`'s second stretch (plan.ts 2492-3182).
pub(super) fn layout(res: &Resolved) -> Result<Layout, DiceError> {
    let rider_count = res.rider_count;

    // --- groups ---
    let mut groups = Groups::default();
    let mut reads_by_rider: BTreeMap<usize, usize> = BTreeMap::new();
    let mut every_hit_groups: IndexMap<String, usize> = IndexMap::new();
    for &node in &res.order {
        if node >= rider_count {
            continue;
        }
        let Some(rider) = res.riders.get(node) else {
            continue;
        };
        // A folded first-hit rider needs no group: it is applied inside its sources' draws.
        // A gated rider (`targetHas`) neither: it fires where its gate opened (a fire slot).
        if rider.on() == "not-fired" || rider.is_first_hit_fold() || rider.target_has.is_some() {
            continue;
        }
        let sources = res
            .source_ids_by_node
            .get(node)
            .map_or(&[][..], |v| v.as_slice());
        // A rider that lands on anything reads a save's every class.
        let group = groups.group_of(res, sources, rider_group_landing(rider.landing));
        reads_by_rider.insert(node, group);
        if rider.on() == "every-hit"
            && let Some(id) = res.rider_ids.get(node)
        {
            every_hit_groups.insert(id.clone(), group);
        }
    }
    // A gated attack reads its parent's group (see the TS comment); a rider folded into its
    // sources' draws has no group, and the gate reads its fire slot.
    let gate_riders: Vec<Option<usize>> = res
        .attack_afters
        .iter()
        .map(|after| match after {
            Some(a) if !res.attack_index_by_id.contains_key(&a.of) => {
                res.rider_index_by_id.get(&a.of).copied()
            }
            _ => None,
        })
        .collect();
    let mut gate_groups: Vec<Option<usize>> = Vec::with_capacity(res.attack_afters.len());
    for (index, after) in res.attack_afters.iter().enumerate() {
        let group = match after {
            None => None,
            Some(a) => {
                if let Some(rider) = gate_riders.get(index).copied().flatten() {
                    reads_by_rider.get(&rider).copied()
                } else {
                    let landing = match a.landing {
                        AfterLanding::Hit => None,
                        AfterLanding::Any => Some(SaveLanding::Fail),
                        AfterLanding::Damage => Some(SaveLanding::Damage),
                    };
                    Some(groups.group_of(res, std::slice::from_ref(&a.of), landing))
                }
            }
        };
        gate_groups.push(group);
    }
    // A condition reuses the group its `of` already has. Only first-hit / first-miss / first-crit read it.
    let mut condition_groups: Vec<Option<usize>> = Vec::with_capacity(res.conditions.len());
    for (index, condition) in res.conditions.iter().enumerate() {
        let reads_group = matches!(
            condition.on,
            ConditionOn::Attack(AttackTriggerOn::FirstHit | AttackTriggerOn::FirstMiss)
                | ConditionOn::FirstCrit
        );
        condition_groups.push(if reads_group {
            let sources = res
                .condition_sources
                .get(index)
                .map_or(&[][..], |v| v.as_slice());
            Some(groups.group_of(res, sources, condition.landing))
        } else {
            None
        });
    }
    // A probe reads the crit bit of its sources' group at the final collapse.
    let mut probe_groups: Vec<Option<usize>> = Vec::with_capacity(res.probes.len());
    for index in 0..res.probes.len() {
        let sources = res
            .probe_sources
            .get(index)
            .map_or(&[][..], |v| v.as_slice());
        probe_groups.push(if sources.is_empty() {
            None
        } else {
            Some(groups.group_of(res, sources, None))
        });
    }
    let Groups {
        sources: group_sources,
        keys: group_keys,
        landings: group_landings,
        ..
    } = groups;

    // --- fire slots ---
    let mut fire_slots: IndexMap<String, usize> = IndexMap::new();
    for (index, rider) in res.riders.iter().enumerate() {
        if (rider.on() != "every-hit" || rider.target_has.is_some())
            && let Some(id) = res.rider_ids.get(index)
        {
            let slot = fire_slots.len();
            fire_slots.insert(id.clone(), slot);
        }
    }
    for id in &res.substitute_ids {
        let slot = fire_slots.len();
        fire_slots.insert(id.clone(), slot);
    }

    // --- sequence ---
    // Declared attacks in order, then riders in dependency order, except that a `first-miss`
    // rider gets one slot directly after each step of every source it watches.
    let mut sequence: Vec<Entry> = res
        .attack_ids
        .iter()
        .enumerate()
        .map(|(index, id)| Entry {
            id: id.clone(),
            attack: Some(index),
            rider: None,
        })
        .collect();
    for &node in &res.order {
        if node >= rider_count {
            continue;
        }
        let Some(rider) = res.riders.get(node) else {
            continue;
        };
        if matches!(rider.on(), "every-hit" | "first-miss") || rider.is_first_hit_fold() {
            continue;
        }
        let Some(id) = res.rider_ids.get(node) else {
            continue;
        };
        sequence.push(Entry {
            id: id.clone(),
            attack: None,
            rider: Some(node),
        });
    }
    for &node in &res.order {
        if node >= rider_count || res.riders.get(node).is_none_or(|r| r.on() != "first-miss") {
            continue;
        }
        let watched: HashSet<&str> = res
            .source_ids_by_node
            .get(node)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let Some(id) = res.rider_ids.get(node) else {
            continue;
        };
        let slot = Entry {
            id: id.clone(),
            attack: None,
            rider: Some(node),
        };
        let mut position = sequence.len();
        while position > 0 {
            position -= 1;
            if !sequence
                .get(position)
                .is_some_and(|e| watched.contains(e.id.as_str()))
            {
                continue;
            }
            // After the source, and after any first-miss slots already placed behind it.
            let mut after = position + 1;
            while sequence
                .get(after)
                .and_then(|e| e.rider)
                .and_then(|r| res.riders.get(r))
                .is_some_and(|r| r.on() == "first-miss")
            {
                after += 1;
            }
            sequence.insert(after, slot.clone());
        }
    }

    // --- flags ---
    // What each row declares about itself: its range or the ability it saves with.
    let row_facts: Vec<Option<RowCheck>> = sequence
        .iter()
        .map(|entry| match res.damage_of(&entry.id) {
            PlanDamage::One(source) => row_check_of(&source),
            PlanDamage::Many(_) => None,
        })
        .collect();
    // A row that lands without a roll (`kind: "auto"`) rolls no d20: no effect reads it.
    let mut rolls_attack: Vec<bool> = Vec::with_capacity(sequence.len());
    for (position, entry) in sequence.iter().enumerate() {
        let auto = row_facts
            .get(position)
            .and_then(|f| f.as_ref())
            .is_some_and(|f| f.kind == RowKind::Auto);
        rolls_attack.push(if auto {
            false
        } else if let Some(attack) = entry.attack {
            res.attack_slices
                .get(attack)
                .is_some_and(std::option::Option::is_some)
        } else {
            res.slices_of(&entry.id)?.is_some()
                || entry
                    .rider
                    .is_some_and(|r| res.attack_lists.get(r).copied().unwrap_or(false))
        });
    }
    let saves_at: Vec<bool> = sequence
        .iter()
        .map(|entry| entry.attack.is_some() && res.is_save_row(&entry.id))
        .collect();

    for (index, condition) in res.conditions.iter().enumerate() {
        let id = res.condition_ids.get(index).map_or("", String::as_str);
        let effects = condition
            .grants
            .iter()
            .chain(condition.on_save.iter().flatten());
        for effect in effects {
            let EffectSpec::Condition {
                condition: name,
                rule,
                ..
            } = effect
            else {
                continue;
            };
            let mut check = vec![rule];
            if let Some(on_end) = &rule.on_end {
                check.push(&on_end.rule);
            }
            for rule in check {
                let unknown = rule
                    .save
                    .iter()
                    .flatten()
                    .map(|(k, _)| k)
                    .find(|k| ability_full(k).is_none());
                if let Some(unknown) = unknown {
                    return Err(fail(
                        TurnSpecErrorCode::UnknownAbility,
                        id,
                        format!(
                            "The rule of \"{name}\" changes saves made with \"{unknown}\", which is not a 5e ability (str, dex, con, int, wis, cha or the full name)."
                        ),
                    ));
                }
            }
        }
    }
    let mut ruled: IndexSet<&'static str> = IndexSet::new();
    for condition in &res.conditions {
        let grants = rules_of(&condition.grants);
        let on_save = rules_of(condition.on_save.as_deref().unwrap_or(&[]));
        for rule in grants.into_iter().chain(on_save) {
            for key in rule.save.iter().flatten().map(|(k, _)| k) {
                if let Some(full) = ability_full(key) {
                    ruled.insert(full);
                }
            }
        }
    }
    for (position, entry) in sequence.iter().enumerate() {
        if saves_at.get(position).copied().unwrap_or(false)
            && let Some(facts) = row_facts.get(position).and_then(|f| f.as_ref())
        {
            check_ability(&ruled, &entry.id, facts.ability.as_deref())?;
        }
    }
    for (index, condition) in res.conditions.iter().enumerate() {
        let id = res.condition_ids.get(index).map_or("", String::as_str);
        for option in save_options_of(condition) {
            check_ability(&ruled, id, option_ability(&option))?;
            if let GrantSaveSpec::Dc {
                roll_type: Some(RollType::ElvenAccuracy),
                ..
            } = option
            {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    id,
                    format!(
                        "Condition \"{id}\" has a save rolled with Elven Accuracy, which only an attack roll can use."
                    ),
                ));
            }
        }
    }

    // The creature each step is aimed at.
    let mut creature_at: Vec<String> = Vec::with_capacity(sequence.len());
    for entry in &sequence {
        creature_at.push(creature_of(res, &entry.id, 0)?);
    }

    let ctx = FlagCtx {
        res,
        sequence: &sequence,
        creature_at: &creature_at,
        row_facts: &row_facts,
        rolls_attack: &rolls_attack,
        saves_at: &saves_at,
    };
    let mut flags: Vec<Flag> = Vec::new();
    let mut condition_flags: Vec<CondFlags> = Vec::with_capacity(res.conditions.len());
    for (index, condition) in res.conditions.iter().enumerate() {
        let id = res.condition_ids.get(index).map_or("", String::as_str);
        let sources: HashSet<&str> = res
            .condition_sources
            .get(index)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let start = condition.on == ConditionOn::Start;
        let apply_at: Vec<usize> = if start {
            Vec::new()
        } else {
            sequence
                .iter()
                .enumerate()
                .filter(|(_, e)| sources.contains(e.id.as_str()))
                .map(|(p, _)| p)
                .collect()
        };
        // Its effects are per creature: each source puts them on the creature it is aimed at; a
        // `start` condition has them on its `target` from before the first row.
        let creatures: Vec<String> = if start {
            vec![
                condition
                    .target
                    .clone()
                    .unwrap_or_else(|| DEFAULT_CREATURE.to_string()),
            ]
        } else {
            let mut set: IndexSet<String> = IndexSet::new();
            for &p in &apply_at {
                if let Some(c) = creature_at.get(p) {
                    set.insert(c.clone());
                }
            }
            set.into_iter().collect()
        };
        let multi = creatures.len() > 1;
        let mut by_creature: IndexMap<String, (Vec<usize>, Vec<usize>)> = IndexMap::new();
        for creature in &creatures {
            let at: Vec<usize> = apply_at
                .iter()
                .copied()
                .filter(|&p| creature_at.get(p) == Some(creature))
                .collect();
            let first = if start {
                -1
            } else {
                at.first().map_or(-1, |&p| p as isize)
            };
            let mut main: Vec<usize> = Vec::new();
            for (grant_index, grant) in condition.grants.iter().enumerate() {
                let label = format!("grant {}", grant_index + 1);
                main.extend(ctx.flags_of(&mut flags, id, grant, &label, creature, first, multi)?);
            }
            let mut on_save: Vec<usize> = Vec::new();
            for (grant_index, grant) in condition.on_save.iter().flatten().enumerate() {
                let label = format!("onSave grant {}", grant_index + 1);
                on_save
                    .extend(ctx.flags_of(&mut flags, id, grant, &label, creature, first, multi)?);
            }
            // An application whose grants are all end-of-turn and all in force is skipped, onSave
            // with it. With an onSave to skip, that check reads the grants at every source.
            if !main.is_empty()
                && !on_save.is_empty()
                && main.iter().all(|&i| {
                    flags
                        .get(i)
                        .is_some_and(|f| f.until == FlagUntil::EndOfTurn)
                })
                && let Some(&last) = at.last()
            {
                for &i in &main {
                    if let Some(flag) = flags.get_mut(i) {
                        flag.last_read = flag.last_read.max(last as isize);
                    }
                }
            }
            by_creature.insert(creature.clone(), (main, on_save));
        }
        let main: Vec<usize> = by_creature
            .values()
            .flat_map(|(m, _)| m.iter().copied())
            .collect();
        let on_save: Vec<usize> = by_creature
            .values()
            .flat_map(|(_, s)| s.iter().copied())
            .collect();
        let lasting_only = !main.is_empty()
            && main.iter().all(|&i| {
                flags
                    .get(i)
                    .is_some_and(|f| f.until == FlagUntil::EndOfTurn)
            });
        condition_flags.push(CondFlags {
            main,
            on_save,
            lasting_only,
            apply_at,
            by_creature,
            start,
        });
    }

    // A grant's own save reads the effects that last on its target and were set before the row
    // that tries it, so those stay live through every row that can try it.
    let all_flags: Vec<usize> = condition_flags
        .iter()
        .flat_map(|c| c.main.iter().chain(c.on_save.iter()).copied())
        .collect();
    for (index, condition) in res.conditions.iter().enumerate() {
        let options = save_options_of(condition);
        if options.is_empty() {
            continue;
        }
        let Some(cond) = condition_flags.get(index) else {
            continue;
        };
        for &position in &cond.apply_at {
            for &i in &all_flags {
                let Some(flag) = flags.get(i) else { continue };
                if flag.grant_save_reads
                    && creature_at.get(position) == Some(&flag.creature)
                    && flag.first < position as isize
                    && (flag.penalty.is_some()
                        || options
                            .iter()
                            .any(|o| flag.save_read.call(option_ability(o)) != 0))
                    && let Some(flag) = flags.get_mut(i)
                {
                    flag.last_read = flag.last_read.max(position as isize);
                }
            }
        }
    }

    // A `targetHas` gate reads, at each row it gates, the conditions on that row's creature in the
    // state the row rolled in: every flag of a condition it names, set before the row, stays live
    // through it. A rider is gated at the rows it watches, a condition where it applies.
    let mut gates: Vec<(&[String], Vec<usize>)> = Vec::new();
    for (index, rider) in res.riders.iter().enumerate() {
        let Some(names) = &rider.target_has else {
            continue;
        };
        let watched: HashSet<&str> = res
            .source_ids_by_node
            .get(index)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let positions = sequence
            .iter()
            .enumerate()
            .filter(|(_, e)| watched.contains(e.id.as_str()))
            .map(|(p, _)| p)
            .collect();
        gates.push((names.as_slice(), positions));
    }
    for (index, condition) in res.conditions.iter().enumerate() {
        if let (Some(names), Some(cond)) = (&condition.target_has, condition_flags.get(index)) {
            gates.push((names.as_slice(), cond.apply_at.clone()));
        }
    }
    for (names, positions) in &gates {
        for &position in positions {
            for i in gated_flags(&flags, &all_flags, &creature_at, names, position) {
                if let Some(flag) = flags.get_mut(i) {
                    flag.last_read = flag.last_read.max(position as isize);
                    if !flag.readers.contains(&position) {
                        flag.readers.push(position);
                    }
                }
            }
        }
    }
    for &i in &all_flags {
        if let Some(flag) = flags.get_mut(i) {
            flag.readers.sort_unstable();
        }
    }

    // A rider that may not happen (`happens`): one coin for the turn. One that can land several
    // times keeps the coin as a bit from before the first row to its last landing.
    let mut happens_of: Vec<f64> = Vec::with_capacity(res.riders.len());
    for (index, rider) in res.riders.iter().enumerate() {
        let happens = rider.happens.unwrap_or(1.0);
        // NaN guard: `!(x >= 0 && x <= 1)` is true for NaN.
        #[allow(clippy::manual_range_contains)]
        let bad = !(happens >= 0.0 && happens <= 1.0);
        if bad {
            let id = res.rider_ids.get(index).map_or("", String::as_str);
            return Err(DiceError::Range(format!(
                "Rider \"{id}\" needs happens in [0, 1], got {}.",
                num_to_string(happens)
            )));
        }
        happens_of.push(happens);
    }
    let mut coin_flags: Vec<Option<usize>> = Vec::with_capacity(res.riders.len());
    for (index, rider) in res.riders.iter().enumerate() {
        if happens_of.get(index) == Some(&1.0) || rider.on() != "every-hit" {
            coin_flags.push(None);
            continue;
        }
        let id = res.rider_ids.get(index).map_or("", String::as_str);
        let watched: HashSet<&str> = res
            .source_ids_by_node
            .get(index)
            .map(|v| v.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let last = sequence
            .iter()
            .rposition(|e| watched.contains(e.id.as_str()));
        flags.push(Flag {
            name: format!("\"{id}\" happens"),
            condition: id.to_string(),
            creature: DEFAULT_CREATURE.to_string(),
            named: None,
            modifiers: 0,
            penalty: None,
            side: FlagSide::Attack,
            reads: BTreeMap::new(),
            grant_save_reads: false,
            save_read: SaveRead::Zero,
            until: FlagUntil::EndOfTurn,
            readers: Vec::new(),
            first: -1,
            last_read: last.map_or(-1, |p| p as isize),
            bit: -1,
        });
        coin_flags.push(Some(flags.len() - 1));
    }

    // A once-per-turn condition (`first-*`) is tried only on a landing where a later row on that
    // landing's creature reads one of its effects; with one creature the condition's group says it,
    // otherwise a bit of its own says it was tried.
    let mut tried_flags: Vec<Option<usize>> = Vec::with_capacity(res.conditions.len());
    for (index, condition) in res.conditions.iter().enumerate() {
        if !matches!(
            condition.on,
            ConditionOn::Attack(AttackTriggerOn::FirstHit | AttackTriggerOn::FirstMiss)
                | ConditionOn::FirstCrit
        ) {
            tried_flags.push(None);
            continue;
        }
        let Some(cond) = condition_flags.get(index) else {
            tried_flags.push(None);
            continue;
        };
        let follows: Vec<bool> = cond
            .apply_at
            .iter()
            .map(|&position| {
                let held = creature_at
                    .get(position)
                    .and_then(|c| cond.by_creature.get(c));
                held.is_some_and(|(main, on_save)| {
                    main.iter().chain(on_save.iter()).any(|&i| {
                        flags
                            .get(i)
                            .is_some_and(|f| f.readers.iter().any(|&r| r > position))
                    })
                })
            })
            .collect();
        // A condition on a rider's landing has no group of the rider's landings to read: it always
        // keeps a bit. Nor does one that needs a damage type dealt.
        let rider = res.condition_riders.get(index).and_then(|r| r.as_ref());
        if rider.is_none()
            && condition.dealing.is_none()
            && follows.iter().enumerate().all(|(k, &follow)| {
                k == 0
                    || follows
                        .get(k - 1)
                        .is_none_or(|&previous| follow <= previous)
            })
        {
            tried_flags.push(None);
            continue;
        }
        let tries: Vec<usize> = cond
            .apply_at
            .iter()
            .zip(&follows)
            .filter(|(_, f)| **f)
            .map(|(&p, _)| p)
            .collect();
        let id = res.condition_ids.get(index).map_or("", String::as_str);
        // No try at all (TS: `undefined`): nothing is live (`last_read > first` fails).
        flags.push(Flag {
            name: format!("\"{id}\" tried"),
            condition: id.to_string(),
            creature: DEFAULT_CREATURE.to_string(),
            named: None,
            modifiers: 0,
            penalty: None,
            side: FlagSide::Attack,
            reads: BTreeMap::new(),
            grant_save_reads: false,
            save_read: SaveRead::Zero,
            until: FlagUntil::EndOfTurn,
            readers: Vec::new(),
            first: tries.first().map_or(-1, |&p| p as isize),
            last_read: tries.last().map_or(-1, |&p| p as isize),
            bit: -1,
        });
        tried_flags.push(Some(flags.len() - 1));
    }

    // A flag lives from its first setter to its last reader. Flags whose lives do not overlap share
    // a bit (the engine's `placeBits`). A flag nothing reads gets no bit at all.
    let mut live_flags: Vec<usize> = Vec::new();
    for cond in &condition_flags {
        for &i in cond.main.iter().chain(cond.on_save.iter()) {
            if flags.get(i).is_some_and(|f| f.last_read != -1) {
                live_flags.push(i);
            }
        }
    }
    for &i in tried_flags.iter().chain(coin_flags.iter()).flatten() {
        if flags.get(i).is_some_and(|f| f.last_read > f.first) {
            live_flags.push(i);
        }
    }
    let mut busy_until: Vec<isize> = Vec::new();
    let mut by_first = live_flags.clone();
    by_first.sort_by_key(|&i| flags.get(i).map_or(0, |f| f.first));
    for &i in &by_first {
        let Some(flag) = flags.get_mut(i) else {
            continue;
        };
        let bit = busy_until
            .iter()
            .position(|&last| last < flag.first)
            .unwrap_or(busy_until.len());
        if bit < busy_until.len() {
            if let Some(slot) = busy_until.get_mut(bit) {
                *slot = flag.last_read;
            }
        } else {
            busy_until.push(flag.last_read);
        }
        flag.bit = bit as i32;
    }
    if busy_until.len() > MAX_FLAG_BITS {
        let first = live_flags.first().and_then(|&i| flags.get(i));
        let names: Vec<&str> = live_flags
            .iter()
            .filter_map(|&i| flags.get(i))
            .map(|f| f.name.as_str())
            .collect();
        return Err(fail(
            TurnSpecErrorCode::TooManyStates,
            first.map_or("", |f| f.condition.as_str()),
            format!(
                "A turn may carry at most {MAX_FLAG_BITS} effects live at once; this one needs {}: {}.",
                busy_until.len(),
                names.join(", ")
            ),
        ));
    }
    let steps = sequence.len();
    let flag_live_after: Vec<u32> = (0..steps)
        .map(|step| live_bits(&flags, &live_flags, step))
        .collect();
    // Per step, the flags it reads with what each puts in force there, in declaration order.
    let mut reads_at: Vec<Vec<(usize, u32)>> = vec![Vec::new(); steps];
    let mut read_mask_at = vec![0u32; steps];
    let mut consumes_at = vec![0u32; steps];
    let mut hit_consumes_at = vec![0u32; steps];
    for &i in &live_flags {
        let Some(flag) = flags.get(i) else { continue };
        for (&reader, &modifiers) in &flag.reads {
            if let (Some(r), Some(rm), Some(c), Some(h)) = (
                reads_at.get_mut(reader),
                read_mask_at.get_mut(reader),
                consumes_at.get_mut(reader),
                hit_consumes_at.get_mut(reader),
            ) {
                r.push((i, modifiers));
                *rm |= flag.mask();
                if matches!(flag.until, FlagUntil::NextAttack | FlagUntil::NextSave) {
                    *c |= flag.mask();
                }
                if flag.until == FlagUntil::NextHit {
                    *h |= flag.mask();
                }
            }
        }
    }
    // Per step, the bits of the conditions that damage ends and that the step finds set.
    let wounds_at: Vec<u32> = (0..steps)
        .map(|step| {
            live_flags
                .iter()
                .filter_map(|&i| flags.get(i))
                .fold(0, |mask, flag| {
                    if flag.until == FlagUntil::UntilDamaged
                        && creature_at.get(step) == Some(&flag.creature)
                        && flag.first < step as isize
                        && step as isize <= flag.last_read
                    {
                        mask | flag.mask()
                    } else {
                        mask
                    }
                })
        })
        .collect();

    // --- group slots ---
    // A group is live from the first step that can advance it to the last step that reads it.
    let group_count = group_sources.len();
    let group_first_step: Vec<isize> = group_sources
        .iter()
        .map(|source_ids| {
            let watched: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
            sequence
                .iter()
                .position(|e| watched.contains(e.id.as_str()))
                .map_or(-1, |p| p as isize)
        })
        .collect();
    let mut group_last_step = vec![-1isize; group_count];
    let read_at = |last: &mut Vec<isize>, group: Option<usize>, position: usize| {
        if let Some(slot) = group.and_then(|g| last.get_mut(g)) {
            *slot = (*slot).max(position as isize);
        }
    };
    for (position, entry) in sequence.iter().enumerate() {
        if let Some(rider) = entry.rider {
            read_at(
                &mut group_last_step,
                reads_by_rider.get(&rider).copied(),
                position,
            );
        }
        if let Some(attack) = entry.attack {
            read_at(
                &mut group_last_step,
                gate_groups.get(attack).copied().flatten(),
                position,
            );
        }
    }
    for (index, cond) in condition_flags.iter().enumerate() {
        let any_bit = cond
            .main
            .iter()
            .chain(cond.on_save.iter())
            .any(|&i| flags.get(i).is_some_and(|f| f.bit != -1));
        if !any_bit {
            continue;
        }
        // A first-* grant reads its group's pre-draw code at each source step.
        let group = condition_groups.get(index).copied().flatten();
        for &position in &cond.apply_at {
            read_at(&mut group_last_step, group, position);
        }
    }
    for group in every_hit_groups
        .values()
        .copied()
        .map(Some)
        .chain(probe_groups.iter().copied())
    {
        read_at(&mut group_last_step, group, steps);
    }

    let mut slot_of_group: Vec<Option<usize>> = vec![None; group_count];
    let mut slot_last_step: Vec<isize> = Vec::new();
    let mut slot_groups: Vec<Vec<usize>> = Vec::new();
    let first_step_of = |group: usize| -> isize {
        let first = group_first_step.get(group).copied().unwrap_or(-1);
        let last = group_last_step.get(group).copied().unwrap_or(-1);
        first.min(last)
    };
    let mut ordered: Vec<usize> = (0..group_count)
        .filter(|&g| group_last_step.get(g).is_some_and(|&l| l != -1))
        .collect();
    ordered.sort_by_key(|&g| (first_step_of(g), g));
    for group in ordered {
        // The lowest slot whose group is dead by the time this one first advances. Strictly
        // dead: a step reads its group before it advances another, but the release comes after.
        let first = first_step_of(group);
        let mut slot = slot_last_step.iter().position(|&last| last < first);
        if slot.is_none() {
            if slot_last_step.len() >= MAX_TRIGGER_GROUPS {
                let key = group_keys.get(group).map_or("", String::as_str);
                return Err(fail(
                    TurnSpecErrorCode::TooManyGroups,
                    key,
                    format!(
                        "A turn may keep at most {MAX_TRIGGER_GROUPS} trigger source sets live at once; {key} would be the {}th.",
                        MAX_TRIGGER_GROUPS + 1
                    ),
                ));
            }
            slot = Some(slot_last_step.len());
            slot_last_step.push(-1);
            slot_groups.push(Vec::new());
        }
        let Some(slot) = slot else { continue };
        if let Some(last) = slot_last_step.get_mut(slot) {
            *last = group_last_step.get(group).copied().unwrap_or(-1);
        }
        if let Some(groups) = slot_groups.get_mut(slot) {
            groups.push(group);
        }
        if let Some(of) = slot_of_group.get_mut(group) {
            *of = Some(slot);
        }
    }
    let slot_of =
        |group: Option<usize>| group.and_then(|g| slot_of_group.get(g).copied().flatten());
    let mut releases_at: Vec<Vec<usize>> = vec![Vec::new(); steps];
    for (slot, groups) in slot_groups.iter().enumerate() {
        for &group in groups.iter().take(groups.len().saturating_sub(1)) {
            let last = group_last_step.get(group).copied().unwrap_or(-1);
            if let Some(list) = usize::try_from(last)
                .ok()
                .and_then(|l| releases_at.get_mut(l))
            {
                list.push(slot);
            }
        }
    }

    // --- grant applications ---
    let plain_odds: PlainOdds = Arc::new(Mutex::new(HashMap::new()));
    let mut grants_at: Vec<Vec<GrantApplication>> = vec![Vec::new(); steps];
    for (index, condition) in res.conditions.iter().enumerate() {
        let Some(cond) = condition_flags.get(index) else {
            continue;
        };
        if cond.start {
            continue;
        }
        let id = res.condition_ids.get(index).map_or("", String::as_str);
        let once = matches!(
            condition.on,
            ConditionOn::Attack(AttackTriggerOn::FirstHit | AttackTriggerOn::FirstMiss)
                | ConditionOn::FirstCrit
        );
        let counted_in_force = condition
            .on_save
            .as_ref()
            .is_none_or(std::vec::Vec::is_empty);
        let rider = res.condition_riders.get(index).cloned().flatten();
        let gate = |position: usize| {
            condition
                .target_has
                .as_ref()
                .map(|names| gate_mask(&flags, &all_flags, &creature_at, names, position))
        };
        let any_bit = cond
            .main
            .iter()
            .chain(cond.on_save.iter())
            .any(|&i| flags.get(i).is_some_and(|f| f.bit != -1));
        if !any_bit {
            // Nothing reads it: it changes nothing, but a condition that may land again and again
            // is still tried on every landing. A once-per-turn one is never tried.
            if once {
                continue;
            }
            for &position in &cond.apply_at {
                let chance_of = grant_save_chance(
                    res,
                    &flags,
                    &all_flags,
                    &creature_at,
                    &plain_odds,
                    id,
                    save_options_of(condition),
                    position,
                );
                if let Some(list) = grants_at.get_mut(position) {
                    list.push(GrantApplication {
                        condition: index,
                        on: condition.on,
                        reads: None,
                        landing: condition.landing,
                        chance: condition.chance.unwrap_or(1.0),
                        chance_of,
                        grants: 0,
                        on_save: 0,
                        in_force: 0,
                        effective: false,
                        tried: Tried::Group,
                        rider: rider.clone(),
                        dealing: condition.dealing.is_some(),
                        counted: true,
                        counted_in_force,
                        count_only: true,
                        gate_mask: gate(position),
                    });
                }
            }
            continue;
        }
        let tried = tried_flags
            .get(index)
            .copied()
            .flatten()
            .and_then(|i| flags.get(i));
        // A condition tried at one row only needs no bit that lives: one above the flag word.
        let tried_bit = match tried {
            None => 0,
            Some(t) if t.bit != -1 => t.mask(),
            Some(_) => 1u32 << MAX_FLAG_BITS,
        };
        for &position in &cond.apply_at {
            // The flags on the creature this source is aimed at.
            let Some((main, on_save)) = creature_at
                .get(position)
                .and_then(|c| cond.by_creature.get(c))
            else {
                // INFALLIBLE: every apply_at creature is a by_creature key.
                continue;
            };
            let held: Vec<&Flag> = main
                .iter()
                .filter_map(|&i| flags.get(i))
                .filter(|f| f.bit != -1)
                .collect();
            let lasting_only = !main.is_empty()
                && main.iter().all(|&i| {
                    flags
                        .get(i)
                        .is_some_and(|f| f.until == FlagUntil::EndOfTurn)
                });
            // Only bits still needed after this step are set: a dead flag's bit may be another's by then.
            let grants = live_bits(&flags, main, position);
            // In force: every held grant was set before this step and is still read.
            let in_force = if lasting_only
                && !held.is_empty()
                && held
                    .iter()
                    .all(|f| f.first < position as isize && position as isize <= f.last_read)
            {
                held.iter().fold(0, |mask, f| mask | f.mask())
            } else {
                0
            };
            let reader_follows = |list: &Vec<usize>| {
                list.iter().any(|&i| {
                    flags
                        .get(i)
                        .is_some_and(|f| f.readers.iter().any(|&r| r > position))
                })
            };
            let follows = reader_follows(main) || reader_follows(on_save);
            // A once-per-turn condition puts nothing in force where no later row reads it.
            let puts = !once || follows;
            let chance_of = grant_save_chance(
                res,
                &flags,
                &all_flags,
                &creature_at,
                &plain_odds,
                id,
                save_options_of(condition),
                position,
            );
            if let Some(list) = grants_at.get_mut(position) {
                list.push(GrantApplication {
                    condition: index,
                    on: condition.on,
                    reads: slot_of(condition_groups.get(index).copied().flatten()),
                    landing: condition.landing,
                    chance: condition.chance.unwrap_or(1.0),
                    chance_of,
                    grants: if puts { grants } else { 0 },
                    on_save: if puts {
                        live_bits(&flags, on_save, position)
                    } else {
                        0
                    },
                    in_force,
                    effective: reader_follows(main),
                    tried: if tried.is_none() {
                        Tried::Group
                    } else if follows {
                        Tried::Bit(tried_bit)
                    } else {
                        Tried::Never
                    },
                    rider: rider.clone(),
                    dealing: condition.dealing.is_some(),
                    counted: !once || follows,
                    counted_in_force,
                    count_only: false,
                    gate_mask: gate(position),
                });
            }
        }
    }

    Ok(Layout {
        group_sources,
        group_keys,
        group_landings,
        reads_by_rider,
        every_hit_groups,
        gate_riders,
        gate_groups,
        condition_groups,
        probe_groups,
        fire_slots,
        sequence,
        row_facts,
        rolls_attack,
        saves_at,
        creature_at,
        flags,
        condition_flags,
        all_flags,
        happens_of,
        coin_flags,
        tried_flags,
        live_flags,
        flag_live_after,
        reads_at,
        read_mask_at,
        consumes_at,
        hit_consumes_at,
        wounds_at,
        group_first_step,
        group_last_step,
        slot_of_group,
        slot_last_step,
        slot_groups,
        releases_at,
        grants_at,
    })
}
