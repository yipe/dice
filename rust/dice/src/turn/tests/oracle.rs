//! Support for the oracle-backed condition tests (`flags`, `turn_conditions`, `creatures`,
//! `saves`): the brute-force oracle's synthetic turns (`tests/oracle/bruteForce.ts`) as data, their
//! conversion to a `TurnSpec` (the subset of `tests/oracle/v2/toSpec.ts` those tests reach) and
//! the oracle's answers.
//!
//! The oracle itself is TS-only; its answers were recorded by running the TS tests
//! (`fixtures/record-oracle.ts`, `fixtures/oracle-conditions.json`). Each recording carries the
//! synthetic turn the TS test passed, and [`check_oracle`] refuses a Rust synthetic turn that is
//! not the same JSON, so a mistranslated input cannot pass quietly.
//!
//! Not ported from `shapes.ts` / `toSpec.ts` / `builders.ts`: what none of these tests use (miss
//! payloads, `rerollOnes`, `autoHit`, typed damage parts, reroll pools, `gatedOn`, `chance`,
//! `riders` other than a first-hit one, `joined` dice, `convertFirstMiss`, contests).

use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::{d, d20, flat, roll_dice};
use crate::builder::nodes::Rounding;
use crate::builder::roll::{Arg, RollBuilder, sum_rolls};
use crate::builder::save::SaveBuilder;
use crate::dnd5e::{ConditionName, rule};
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::context::{
    ContextualSource, Dealt, RollType, RowCheck, RowContext, RowKind, RowRange,
};
use crate::turn::types::{
    ArcContextual, Attack, AttackOptions, AttackTriggerOn, ConditionOn, ConditionSpec,
    ConditionUntil, ContextualPayload, EffectSpec, GrantSaveSpec, GrantSaves, GrantSpec,
    GrantUntil, LandingPayload, Rider, RiderDamageSpec, SaveLanding, SaveUntil, Source, Trigger,
    TurnSpec, VulnerableLanding,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock};

// ---- the synthetic turn (`bruteForce.ts`), as data --------------------------------------------

/// `DiceSpec` without parts or rules: `count`d`sides` + `flat`, optionally floored at 0.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dice {
    pub count: f64,
    pub sides: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor_at_zero: Option<bool>,
}

/// `{ count, sides, flat?, floorAtZero? }`.
pub fn dice(count: f64, sides: f64, flat: Option<f64>, floor_at_zero: bool) -> Dice {
    Dice {
        count,
        sides,
        flat,
        floor_at_zero: floor_at_zero.then_some(true),
    }
}

/// `AttackSpec`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttackSpec {
    pub to_hit: f64,
    pub ac: f64,
    pub crit_range: f64,
    pub advantage: &'static str,
    pub damage: Dice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roll_override: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elven_accuracy: Option<bool>,
}

/// `attack(extra)` of `shapes.ts`: a melee attack, +6 vs AC 15, 1d8+3.
pub fn attack() -> AttackSpec {
    AttackSpec {
        to_hit: 6.0,
        ac: 15.0,
        crit_range: 20.0,
        advantage: "flat",
        damage: dice(1.0, 8.0, Some(3.0), false),
        range: None,
        target: None,
        roll_override: None,
        elven_accuracy: None,
    }
}

impl AttackSpec {
    pub fn ranged(self) -> Self {
        Self {
            range: Some("ranged"),
            ..self
        }
    }

    pub fn target(self, creature: usize) -> Self {
        Self {
            target: Some(creature),
            ..self
        }
    }

    pub fn damage(self, damage: Dice) -> Self {
        Self { damage, ..self }
    }

    pub fn advantage(self, kind: &'static str) -> Self {
        Self {
            advantage: kind,
            ..self
        }
    }

    pub fn elven_accuracy(self) -> Self {
        Self {
            elven_accuracy: Some(true),
            ..self
        }
    }

    pub fn roll_override(self, kind: &'static str) -> Self {
        Self {
            roll_override: Some(kind),
            ..self
        }
    }
}

/// `SaveSpec`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSpec {
    pub dc: f64,
    pub save_bonus: f64,
    pub on_success: &'static str,
    pub damage: Dice,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ability: Option<&'static str>,
}

/// `save({ ability })` of `shapes.ts`: DC 14, +3, half on success, 3d6.
pub fn save(ability: &'static str) -> SaveSpec {
    SaveSpec {
        dc: 14.0,
        save_bonus: 3.0,
        on_success: "half",
        damage: dice(3.0, 6.0, None, false),
        ability: Some(ability),
    }
}

/// `RiderSpec`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiderSpec {
    pub of: Vec<usize>,
    pub trigger: &'static str,
    pub damage: Dice,
}

/// `sneak({ of })` of `shapes.ts`: a first-landing rider of 2d6.
pub fn sneak(of: &[usize]) -> RiderSpec {
    RiderSpec {
        of: of.to_vec(),
        trigger: "hit",
        damage: dice(2.0, 6.0, None, false),
    }
}

/// `EffectSpec` (`kind` and what that kind carries).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sides: Option<f64>,
}

/// `{ kind, lifetime }`: `advantage`, `disadvantage`, `critOnHit`, `saveDisadvantage`, `vulnerability`.
pub fn effect(kind: &'static str, lifetime: Option<&'static str>) -> Effect {
    Effect {
        kind,
        lifetime,
        ..Effect::default()
    }
}

/// `NEXT_ADVANTAGE`.
pub fn next_advantage() -> Effect {
    effect("advantage", Some("next-attack"))
}

/// `condition(name)`.
pub fn condition(name: &'static str) -> Effect {
    Effect {
        kind: "condition",
        condition: Some(name),
        ..Effect::default()
    }
}

/// `{ kind: "condition", condition, lifetime: "until-damaged" }`.
pub fn until_damaged(name: &'static str) -> Effect {
    Effect {
        lifetime: Some("until-damaged"),
        ..condition(name)
    }
}

impl Effect {
    pub fn to(self, rows: &[usize]) -> Self {
        Self {
            to: Some(rows.to_vec()),
            ..self
        }
    }
}

/// `{ kind: "savePenalty", count, sides, lifetime? }`.
pub fn save_penalty(count: f64, sides: f64, lifetime: Option<&'static str>) -> Effect {
    Effect {
        kind: "savePenalty",
        lifetime,
        count: Some(count),
        sides: Some(sides),
        ..Effect::default()
    }
}

/// `GrantSaveSpec.alternatives` entry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alternative {
    pub ability: &'static str,
    pub save_bonus: f64,
}

/// `GrantSaveSpec`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantSave {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ability: Option<&'static str>,
    pub dc: f64,
    pub save_bonus: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<Alternative>>,
}

/// `CONSTITUTION`.
pub fn constitution() -> GrantSave {
    GrantSave {
        ability: Some("constitution"),
        dc: 13.0,
        save_bonus: 3.0,
        alternatives: None,
    }
}

/// `STRENGTH`.
pub fn strength() -> GrantSave {
    GrantSave {
        ability: Some("strength"),
        dc: 13.0,
        save_bonus: 2.0,
        alternatives: None,
    }
}

/// `DEXTERITY`.
pub fn dexterity() -> GrantSave {
    GrantSave {
        ability: Some("dexterity"),
        dc: 15.0,
        save_bonus: 4.0,
        alternatives: None,
    }
}

impl GrantSave {
    /// `{ ...save, alternatives }`.
    pub fn alternatives(self, alternatives: Vec<Alternative>) -> Self {
        Self {
            alternatives: Some(alternatives),
            ..self
        }
    }
}

/// `GrantSpec`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantDef {
    pub of: Vec<usize>,
    pub trigger: &'static str,
    pub cap: &'static str,
    pub effects: Vec<Effect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save: Option<GrantSave>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_pass: Option<Vec<Effect>>,
}

/// `grant(extra)` of `shapes.ts`: row 0's every landing, next-attack advantage.
pub fn grant() -> GrantDef {
    GrantDef {
        of: vec![0],
        trigger: "hit",
        cap: "unlimited",
        effects: vec![next_advantage()],
        save: None,
        optional: None,
        on_pass: None,
    }
}

impl GrantDef {
    pub fn of(self, of: &[usize]) -> Self {
        Self {
            of: of.to_vec(),
            ..self
        }
    }

    pub fn trigger(self, trigger: &'static str) -> Self {
        Self { trigger, ..self }
    }

    pub fn once(self) -> Self {
        Self {
            cap: "once",
            ..self
        }
    }

    pub fn effects(self, effects: Vec<Effect>) -> Self {
        Self { effects, ..self }
    }

    pub fn save(self, save: GrantSave) -> Self {
        Self {
            save: Some(save),
            ..self
        }
    }

    pub fn optional(self) -> Self {
        Self {
            optional: Some(true),
            ..self
        }
    }

    pub fn on_pass(self, effects: Vec<Effect>) -> Self {
        Self {
            on_pass: Some(effects),
            ..self
        }
    }
}

/// `SyntheticTurn`.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticTurn {
    pub attacks: Vec<AttackSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saves: Option<Vec<SaveSpec>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub riders: Option<Vec<RiderSpec>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grants: Option<Vec<GrantDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starting_condition: Option<&'static str>,
}

// ---- builders (`builders.ts`, the unparted subset) ---------------------------------------------

/// `diceRoll(d)`: `count`d`sides` + `flat`.
fn dice_roll(spec: &Dice) -> Result<RollBuilder, DiceError> {
    if spec.count <= 0.0 || spec.sides <= 0.0 {
        return flat(spec.flat.unwrap_or(0.0));
    }
    match spec.flat {
        Some(bonus) if bonus != 0.0 => roll_dice(spec.count, spec.sides, Some(bonus)),
        _ => roll_dice(spec.count, spec.sides, None),
    }
}

/// `hasTypedParts(d)`: a payload `payloadBuilder` has to compile (here: one that floors at 0).
fn needs_payload_builder(spec: &Dice) -> bool {
    spec.floor_at_zero == Some(true)
}

/// `payloadBuilder(d, crit)` of a payload with no parts and no reroll budget.
fn payload_builder(spec: &Dice, crit: bool) -> Result<RollBuilder, DiceError> {
    let untyped = dice_roll(&Dice {
        count: if crit { spec.count * 2.0 } else { spec.count },
        ..spec.clone()
    })?;
    let total = sum_rolls(&[untyped])?;
    if spec.floor_at_zero == Some(true) {
        total.max_of_roll(&flat(0.0)?)
    } else {
        Ok(total)
    }
}

fn doubled(roll: RollBuilder, vulnerable: bool) -> Result<RollBuilder, DiceError> {
    if vulnerable {
        roll.scale_result(2.0, 1.0, Rounding::Floor)
    } else {
        Ok(roll)
    }
}

fn roll_type_of(kind: &str) -> RollType {
    match kind {
        "advantage" => RollType::Advantage,
        "disadvantage" => RollType::Disadvantage,
        "elven" => RollType::ElvenAccuracy,
        _ => RollType::Flat,
    }
}

fn with_roll_type(base: RollBuilder, roll_type: RollType) -> Result<RollBuilder, DiceError> {
    match roll_type {
        RollType::Advantage => base.with_advantage(),
        RollType::Disadvantage => base.with_disadvantage(),
        RollType::ElvenAccuracy => base.with_elven_accuracy(),
        RollType::Flat => Ok(base),
    }
}

/// The harness's `attackPmf` for an attack with no miss payload, `rerollOnes` or parts.
fn attack_pmf(a: &AttackSpec, context: &RowContext) -> Result<Pmf, DiceError> {
    if !context.joined.is_empty() {
        return Err(DiceError::error(
            "oracle rows: joined riders are not ported",
        ));
    }
    let base = with_roll_type(d20(), context.roll_type)?;
    let typed = needs_payload_builder(&a.damage);
    let hit = doubled(
        if typed {
            payload_builder(&a.damage, false)?
        } else {
            dice_roll(&a.damage)?
        },
        context.vulnerable,
    )?;
    let crit = if typed {
        Some(doubled(
            payload_builder(&a.damage, true)?,
            context.vulnerable,
        )?)
    } else if context.vulnerable {
        Some(doubled(
            dice_roll(&Dice {
                count: a.damage.count * 2.0,
                ..a.damage.clone()
            })?,
            true,
        )?)
    } else {
        None
    };
    let mut check = base.plus(a.to_hit)?.ac(a.ac)?;
    if context.crit_on_hit {
        check = check.always_crits()?;
    } else if a.crit_range < 20.0 {
        check = check.crit_on(a.crit_range)?;
    }
    let mut attack: AttackBuilder = check.on_hit(hit)?;
    if let Some(crit) = crit {
        attack = attack.on_crit(&[Arg::Roll(crit)])?;
    }
    attack.pmf()
}

/// The harness's `savePmf`.
fn save_pmf(s: &SaveSpec, context: &RowContext) -> Result<Pmf, DiceError> {
    let hit = dice_roll(&s.damage)?;
    let mut roll = with_roll_type(d20().plus(s.save_bonus)?, context.roll_type)?;
    for die in &context.penalty_dice {
        roll = roll.minus_dice(die.count, &d(die.sides)?)?;
    }
    let failure: SaveBuilder = roll
        .dc(if context.auto_fail { 1000.0 } else { s.dc })?
        .on_save_failure_args(&[Arg::Roll(hit)])?;
    if s.on_success == "half" {
        failure.save_half()?.pmf()
    } else {
        failure.pmf()
    }
}

// ---- rows ----------------------------------------------------------------------------------------

struct AttackRow(AttackSpec);

impl ContextualSource for AttackRow {
    fn row_check(&self) -> RowCheck {
        let a = &self.0;
        RowCheck {
            kind: RowKind::Attack,
            range: Some(if a.range == Some("ranged") {
                RowRange::Ranged
            } else {
                RowRange::Melee
            }),
            ability: None,
            roll_type: roll_type_of(a.roll_override.unwrap_or(a.advantage)),
            advantage_dice: if a.elven_accuracy == Some(true) { 3 } else { 2 },
            pinned: a.roll_override.is_some(),
            auto_hit: false,
            auto_crit: false,
            auto_fail: false,
        }
    }

    fn under(&self, context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        attack_pmf(&self.0, context)
    }

    fn has_dealt(&self) -> bool {
        true
    }

    /// No typed parts: nothing of any type is dealt.
    fn dealt(&self, _type: &str, _context: &RowContext) -> Result<Dealt, DiceError> {
        Ok(Dealt {
            hit: 0.0,
            crit: 0.0,
        })
    }
}

struct SaveRow(SaveSpec);

impl ContextualSource for SaveRow {
    fn row_check(&self) -> RowCheck {
        RowCheck {
            kind: RowKind::Save,
            range: None,
            ability: self.0.ability.map(str::to_string),
            roll_type: RollType::Flat,
            advantage_dice: 2,
            pinned: false,
            auto_hit: false,
            auto_crit: false,
            auto_fail: false,
        }
    }

    fn under(&self, context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        save_pmf(&self.0, context)
    }
}

/// The harness's rider `payload(row)`: the same dice on every row.
struct RiderPayload(Dice);

impl RiderPayload {
    fn modes(&self, scaled: bool) -> Result<(Pmf, Pmf), DiceError> {
        let finish = |roll: RollBuilder| -> Result<Pmf, DiceError> { doubled(roll, scaled)?.pmf() };
        Ok((
            finish(dice_roll(&self.0)?)?,
            finish(dice_roll(&Dice {
                count: self.0.count * 2.0,
                ..self.0.clone()
            })?)?,
        ))
    }
}

impl ContextualPayload for RiderPayload {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        let (on_hit, on_crit) = self.modes(false)?;
        let (vulnerable_hit, vulnerable_crit) = self.modes(true)?;
        Ok(LandingPayload {
            on_hit: on_hit.into(),
            on_crit: on_crit.into(),
            vulnerable: VulnerableLanding {
                on_hit: (vulnerable_hit).into(),
                on_crit: (vulnerable_crit).into(),
            },
        })
    }

    fn has_dealt(&self) -> bool {
        true
    }

    fn dealt(&self, _type: &str, _attack_id: &str) -> Result<Dealt, DiceError> {
        Ok(Dealt {
            hit: 0.0,
            crit: 0.0,
        })
    }
}

// ---- `oracleTurnToSpec` --------------------------------------------------------------------------

pub fn row_id(source: usize) -> String {
    format!("row:{source}")
}

pub fn rider_id(index: usize) -> String {
    format!("rider:{index}")
}

fn grant_id(index: usize) -> String {
    format!("grant:{index}")
}

fn creature(target: Option<usize>) -> Option<String> {
    target.filter(|&t| t != 0).map(|t| format!("creature:{t}"))
}

fn rows(of: &[usize]) -> Vec<String> {
    of.iter().map(|&k| row_id(k)).collect()
}

fn condition_name(name: &str) -> ConditionName {
    match name {
        "blinded" => ConditionName::Blinded,
        "frightened" => ConditionName::Frightened,
        "invisible" => ConditionName::Invisible,
        "paralyzed" => ConditionName::Paralyzed,
        "petrified" => ConditionName::Petrified,
        "prone" => ConditionName::Prone,
        "restrained" => ConditionName::Restrained,
        "stunned" => ConditionName::Stunned,
        "unconscious" => ConditionName::Unconscious,
        other => panic!("oracle: unknown condition {other}"),
    }
}

fn effect_of(effect: &Effect) -> EffectSpec {
    let to = effect.to.as_deref().map(rows);
    let save_until = if effect.lifetime == Some("next-save") {
        SaveUntil::NextSave
    } else {
        SaveUntil::EndOfTurn
    };
    match effect.kind {
        "condition" => {
            let name = condition_name(effect.condition.unwrap_or_default());
            EffectSpec::Condition {
                condition: name.as_str().to_string(),
                rule: rule(name).unwrap_or_default(),
                until: if effect.lifetime == Some("until-damaged") {
                    ConditionUntil::UntilDamaged
                } else {
                    ConditionUntil::EndOfTurn
                },
            }
        }
        kind @ ("advantage" | "disadvantage" | "critOnHit") => EffectSpec::Grant(GrantSpec {
            advantage: kind == "advantage",
            disadvantage: kind == "disadvantage",
            crit_on_hit: kind == "critOnHit",
            until: if effect.lifetime == Some("next-attack") {
                GrantUntil::NextAttack
            } else {
                GrantUntil::EndOfTurn
            },
            to,
        }),
        "vulnerability" => EffectSpec::Vulnerability,
        "saveDisadvantage" => EffectSpec::SaveDisadvantage {
            until: save_until,
            to,
        },
        "savePenalty" => EffectSpec::SavePenalty {
            count: effect.count.unwrap_or_default(),
            sides: effect.sides.unwrap_or_default(),
            until: save_until,
            to,
        },
        other => panic!("oracle: unknown effect {other}"),
    }
}

fn save_of(save: &GrantSave) -> GrantSaves {
    let option = |ability: Option<&str>, bonus: f64| GrantSaveSpec::Dc {
        ability: ability.map(str::to_string),
        dc: save.dc,
        bonus,
        roll_type: None,
    };
    let mut options = vec![option(save.ability, save.save_bonus)];
    for alternative in save.alternatives.iter().flatten() {
        options.push(option(Some(alternative.ability), alternative.save_bonus));
    }
    if options.len() == 1 {
        GrantSaves::One(options.remove(0))
    } else {
        GrantSaves::Many(options)
    }
}

fn is_save(turn: &SyntheticTurn, source: usize) -> bool {
    source >= turn.attacks.len()
}

fn start_target(turn: &SyntheticTurn, source: usize) -> Option<String> {
    creature(if source < turn.attacks.len() {
        turn.attacks[source].target
    } else {
        None // an oracle save row has no creature in these tests
    })
}

fn condition_of(turn: &SyntheticTurn, grant: &GrantDef, index: usize) -> Option<ConditionSpec> {
    let once = grant.cap == "once";
    let attacks_only = |of: &[usize]| -> Vec<usize> {
        of.iter().copied().filter(|&k| !is_save(turn, k)).collect()
    };
    let on_attack = |first: AttackTriggerOn, every: AttackTriggerOn| {
        ConditionOn::Attack(if once { first } else { every })
    };
    let (on, of, landing) = match grant.trigger {
        "start" => {
            return Some(ConditionSpec {
                id: Some(grant_id(index)),
                target: start_target(turn, grant.of[0]),
                ..blank(ConditionOn::Start, grant)
            });
        }
        "hit" => (
            on_attack(AttackTriggerOn::FirstHit, AttackTriggerOn::EveryHit),
            attacks_only(&grant.of),
            None,
        ),
        "damage" => (
            on_attack(AttackTriggerOn::FirstHit, AttackTriggerOn::EveryHit),
            grant.of.clone(),
            Some(SaveLanding::Damage),
        ),
        "crit" => (
            if once {
                ConditionOn::FirstCrit
            } else {
                ConditionOn::Attack(AttackTriggerOn::AnyCrit)
            },
            attacks_only(&grant.of),
            None,
        ),
        "miss" => (
            on_attack(AttackTriggerOn::FirstMiss, AttackTriggerOn::AnyMiss),
            attacks_only(&grant.of),
            None,
        ),
        "failedSave" => (
            on_attack(AttackTriggerOn::FirstHit, AttackTriggerOn::EveryHit),
            grant
                .of
                .iter()
                .copied()
                .filter(|&k| is_save(turn, k))
                .collect(),
            Some(SaveLanding::Fail),
        ),
        other => panic!("oracle: grant trigger {other} is not ported"),
    };
    if of.is_empty() {
        return None;
    }
    Some(ConditionSpec {
        id: Some(grant_id(index)),
        of: Some(rows(&of)),
        landing,
        save: grant.save.as_ref().map(save_of),
        on_save: grant
            .on_pass
            .as_ref()
            .map(|e| e.iter().map(effect_of).collect()),
        optional: grant.optional == Some(true),
        ..blank(on, grant)
    })
}

fn blank(on: ConditionOn, grant: &GrantDef) -> ConditionSpec {
    ConditionSpec {
        id: None,
        on,
        of: None,
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants: grant.effects.iter().map(effect_of).collect(),
        on_save: None,
        optional: false,
    }
}

fn rider_of(
    turn: &SyntheticTurn,
    rider: &RiderSpec,
    index: usize,
    payload: Option<crate::builder::roll::RollBuilder>,
) -> Result<Rider, DiceError> {
    if rider.trigger != "hit" {
        panic!("oracle: rider trigger {} is not ported", rider.trigger);
    }
    let of: Vec<usize> = rider
        .of
        .iter()
        .copied()
        .filter(|&k| !is_save(turn, k))
        .collect();
    let damage = match payload {
        Some(roll) => RiderDamageSpec::Plain(crate::turn::types::RiderDamage::One(
            crate::turn::types::DamageSource::Roll(roll),
        )),
        None => RiderDamageSpec::Contextual(Arc::new(RiderPayload(rider.damage.clone()))),
    };
    Ok(Rider {
        trigger: Trigger::FirstHit {
            of: Some(rows(&of)),
            per_source: None,
        },
        id: Some(rider_id(index)),
        damage,
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    })
}

/// `oracleTurnToSpec(turn)`. `plain_riders` gives each rider a plain roll in place of its
/// contextual payload (`conditions.test.ts` does, for one case).
#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
pub fn turn_to_spec(
    turn: &SyntheticTurn,
    plain_riders: Option<RollBuilder>,
) -> Result<TurnSpec, DiceError> {
    let saves: &[SaveSpec] = turn.saves.as_deref().unwrap_or(&[]);
    let riders: &[RiderSpec] = turn.riders.as_deref().unwrap_or(&[]);
    let mut attacks = Vec::new();
    for k in 0..turn.attacks.len() + saves.len() {
        let (source, target): (Arc<dyn ContextualSource>, Option<usize>) = if k < turn.attacks.len()
        {
            (
                Arc::new(AttackRow(turn.attacks[k].clone())),
                turn.attacks[k].target,
            )
        } else {
            (
                Arc::new(SaveRow(saves[k - turn.attacks.len()].clone())),
                None,
            )
        };
        attacks.push(Attack::Declared {
            options: AttackOptions {
                id: Some(row_id(k)),
                target: creature(target),
                ..AttackOptions::default()
            },
            source: Source::Contextual(ArcContextual(source)),
        });
    }
    let mut conditions = Vec::new();
    if let Some(name) = turn.starting_condition {
        let condition = condition_name(name);
        conditions.push(ConditionSpec {
            id: Some("start".to_string()),
            on: ConditionOn::Start,
            of: None,
            r#where: None,
            chance: None,
            target_has: None,
            landing: None,
            dealing: None,
            target: None,
            save: None,
            grants: vec![EffectSpec::Condition {
                condition: condition.as_str().to_string(),
                rule: rule(condition).unwrap_or_default(),
                until: ConditionUntil::EndOfTurn,
            }],
            on_save: None,
            optional: false,
        });
    }
    for (i, grant) in turn.grants.iter().flatten().enumerate() {
        if let Some(condition) = condition_of(turn, grant, i) {
            conditions.push(condition);
        }
    }
    let rider_specs = riders
        .iter()
        .enumerate()
        .map(|(i, rider)| rider_of(turn, rider, i, plain_riders.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TurnSpec {
        attacks,
        riders: (!rider_specs.is_empty()).then_some(rider_specs),
        conditions: (!conditions.is_empty()).then_some(conditions),
        ..TurnSpec::default()
    })
}

// ---- the oracle's answers ------------------------------------------------------------------------

const RECORDED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/fixtures/oracle-conditions.json"
);

/// One recorded `enumerateSyntheticTurn` result: value -> mass maps.
pub struct Oracle {
    pub pmf: BTreeMap<u64, f64>,
    pub sources: Vec<BTreeMap<u64, f64>>,
    pub riders: Vec<BTreeMap<u64, f64>>,
}

fn unhex(text: &str) -> f64 {
    f64::from_bits(
        u64::from_str_radix(text, 16).unwrap_or_else(|e| panic!("oracle: bad bits {text}: {e}")),
    )
}

fn masses(value: &Value) -> BTreeMap<u64, f64> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("oracle: pmf is not a list"))
        .iter()
        .map(|pair| {
            let value = pair[0].as_f64().unwrap_or_default();
            (value.to_bits(), unhex(pair[1].as_str().unwrap_or_default()))
        })
        .collect()
}

/// Integral floats as integers, so a Rust `13.0` equals the recorded JSON `13`.
fn canonical(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 => Value::from(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, canonical(v))).collect())
        }
        other => other,
    }
}

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let text = std::fs::read_to_string(RECORDED).unwrap_or_else(|e| panic!("{RECORDED}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{RECORDED}: {e}"))
});

/// The oracle's answer for the synthetic turn `synthetic`, recorded while `file > test` ran in TS.
/// Panics unless the recording was made for exactly this synthetic turn.
pub fn check_oracle(file: &str, test: &str, synthetic: &SyntheticTurn) -> Oracle {
    let key = format!("{file} > {test}");
    let recorded = FIXTURE
        .get(&key)
        .and_then(|runs| runs.get(0))
        .unwrap_or_else(|| panic!("oracle: no recording for {key:?}"));
    let ours = canonical(serde_json::to_value(synthetic).unwrap_or(Value::Null));
    assert_eq!(
        ours,
        canonical(recorded["synthetic"].clone()),
        "{key}: the synthetic turn is not the one the TS test passed to the oracle"
    );
    Oracle {
        pmf: masses(&recorded["pmf"]),
        sources: recorded["sources"]
            .as_array()
            .map(|l| l.iter().map(masses).collect())
            .unwrap_or_default(),
        riders: recorded
            .get("riders")
            .and_then(Value::as_array)
            .map(|l| l.iter().map(masses).collect())
            .unwrap_or_default(),
    }
}

/// `worst(actual, expected)`: the largest per-value difference, over both supports.
pub fn worst(actual: &Pmf, expected: &BTreeMap<u64, f64>) -> f64 {
    let mut values: BTreeMap<u64, f64> = expected
        .keys()
        .map(|&bits| (bits, f64::from_bits(bits)))
        .collect();
    for value in actual.support() {
        values.insert(value.0.to_bits(), value.0);
    }
    values.iter().fold(0.0, |worst, (bits, &value)| {
        worst.max((actual.p_at(value) - expected.get(bits).copied().unwrap_or(0.0)).abs())
    })
}

pub const TOLERANCE: f64 = 1e-12;

/// `expectOracle(synthetic)`: the turn's joint PMF and every row's marginal agree with the oracle at
/// 1e-12; with `riders`, so does every rider's.
pub fn expect_oracle(
    file: &str,
    test: &str,
    synthetic: &SyntheticTurn,
    riders: bool,
) -> Result<(), DiceError> {
    let oracle = check_oracle(file, test, synthetic);
    let t = Turn::from_spec(turn_to_spec(synthetic, None)?, 0.0)?;
    assert_eq_oracle(&t, synthetic, &oracle, riders, file, test)
}

/// The comparisons of `expectOracle` against a built turn.
pub fn assert_eq_oracle(
    t: &Turn,
    _synthetic: &SyntheticTurn,
    oracle: &Oracle,
    riders: bool,
    file: &str,
    test: &str,
) -> Result<(), DiceError> {
    let label = format!("{file} > {test}");
    assert!(
        !oracle.pmf.is_empty() && !oracle.sources.is_empty(),
        "{label}: empty recording"
    );
    let diff = worst(&t.pmf()?, &oracle.pmf);
    assert!(diff <= TOLERANCE, "{label}: joint pmf differs by {diff}");
    for (k, expected) in oracle.sources.iter().enumerate() {
        let marginal = t.marginal(&row_id(k))?;
        let diff = worst(marginal.pmf(), expected);
        assert!(diff <= TOLERANCE, "{label}: row {k} differs by {diff}");
    }
    if riders {
        for (k, expected) in oracle.riders.iter().enumerate() {
            let marginal = t.marginal(&rider_id(k))?;
            let diff = worst(marginal.pmf(), expected);
            assert!(diff <= TOLERANCE, "{label}: rider {k} differs by {diff}");
        }
    }
    Ok(())
}
