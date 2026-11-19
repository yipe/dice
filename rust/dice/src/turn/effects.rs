//! Port of `src/turn/effects.ts`: the values a trigger verb takes besides damage: reroll
//! [`Transform`]s, [`Modifiers`] and [`Grant`]s with a lifetime, conditions, save-gated effects and
//! the gate a trigger puts on its grants.
//!
//! # Shape
//! - TS classes with `instanceof` checks (`isGrant`, `isTransform`, `isSaveGated`) are plain
//!   structs; the check is the type. `Lasting` and `Grant` are two types ([`Grant`] only adds
//!   [`Grant::to`]); a `Grant` converts into a `Lasting` with `Into`.
//! - `ifBelow(number | { hit, crit })` is [`Transform::if_below`] and [`Transform::if_below_split`].
//! - `unpackSave<O>` is generic over the options type in TS; here it is [`unpack_save`] (for a
//!   [`ConditionGate`]) and [`unpack_save_options`] (for [`ConditionOptions`]).
//! - `gateFields` does not refuse a `target` key (TS: for plain-JS callers; the type has none).
//! - `save()` and `asList` do not check that a list entry is an object or a `Lasting` (the types
//!   say so). Empty lists and the `TypeError`s on them are kept.

use super::context::combine_roll_type;
use super::types::{
    ConditionRule, ConditionUntil, EffectSpec, GrantSaveSpec, GrantSaves, GrantSpec, GrantUntil,
    RiderOptions, SaveLanding, SaveUntil, SubstituteKind, SubstitutePolicy, TurnSpecError,
    TurnSpecErrorCode,
};
use super::types::{FailChance, PerSource};
use crate::builder::attack::ConditionGate;
use crate::builder::dc::RolledIn;
use crate::builder::roll::RollBuilder;
use crate::builder::types::RollType;
use crate::error::DiceError;

/// `Transform`: a payload transform a trigger verb accepts, as opposed to damage (a rider).
/// Built only by [`keep_best_damage`]. Immutable: every method returns a new value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub substitute: SubstituteKind,
    pub policy: SubstitutePolicy,
}

impl Transform {
    /// `ifBelow(threshold)` with one number for both modes.
    pub fn if_below(&self, threshold: f64) -> Result<Transform, DiceError> {
        self.if_below_split(threshold, threshold)
    }

    /// `ifBelow({ hit, crit })`: spend only when the base payload total is below the threshold of
    /// the mode that landed. `Err` (a `RangeError`) on a NaN threshold.
    pub fn if_below_split(&self, hit: f64, crit: f64) -> Result<Transform, DiceError> {
        if hit.is_nan() || crit.is_nan() {
            return Err(DiceError::range(
                "ifBelow() needs numeric thresholds, got NaN.",
            ));
        }
        Ok(Transform {
            substitute: self.substitute,
            policy: SubstitutePolicy::Below { hit, crit },
        })
    }

    /// `optimally()`: not supported in this release.
    pub fn optimally(&self) -> Result<Transform, TurnSpecError> {
        Err(TurnSpecError::new(
            TurnSpecErrorCode::UnsupportedPolicy,
            "",
            "optimally() is not supported in this release; use ifBelow({ hit, crit }) with the thresholds you want.",
        ))
    }
}

/// `keepBestDamage()`: roll the watched attack's whole base payload again and keep the better
/// total, once per turn.
pub fn keep_best_damage() -> Transform {
    Transform {
        substitute: SubstituteKind::RerollKeepHigher,
        policy: SubstitutePolicy::Always,
    }
}

/// `substituteFields`: the fields a [`Transform`] contributes to a `SubstituteSpec`; the policy only
/// when it is not `always`.
pub fn substitute_fields(transform: &Transform) -> (SubstituteKind, Option<SubstitutePolicy>) {
    if transform.policy == SubstitutePolicy::Always {
        (transform.substitute, None)
    } else {
        (transform.substitute, Some(transform.policy))
    }
}

/// `Lasting`: any effect with a lifetime. Immutable.
#[derive(Clone, Debug, PartialEq)]
pub struct Lasting {
    pub spec: EffectSpec,
}

/// `Grant`: a [`Lasting`] effect that can be scoped to the rows that read it.
#[derive(Clone, Debug, PartialEq)]
pub struct Grant(pub Lasting);

impl From<Grant> for Lasting {
    fn from(g: Grant) -> Lasting {
        g.0
    }
}

impl Grant {
    /// `to(...targets)`: the attack ids, attack-shaped rider ids or tags that read it.
    pub fn to(&self, targets: &[&str]) -> Grant {
        let list: Vec<String> = targets.iter().map(|t| (*t).to_string()).collect();
        let spec = match &self.0.spec {
            EffectSpec::Grant(g) => EffectSpec::Grant(GrantSpec {
                to: Some(list),
                ..g.clone()
            }),
            EffectSpec::SaveDisadvantage { until, .. } => EffectSpec::SaveDisadvantage {
                until: *until,
                to: Some(list),
            },
            EffectSpec::SavePenalty {
                count,
                sides,
                until,
                ..
            } => EffectSpec::SavePenalty {
                count: *count,
                sides: *sides,
                until: *until,
                to: Some(list),
            },
            other => other.clone(),
        };
        Grant(Lasting { spec })
    }
}

/// `Modifiers`: what a grant does to the attack rolls that read it, before it has a lifetime.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    advantage: bool,
    disadvantage: bool,
    crit_on_hit: bool,
}

impl Modifiers {
    /// Adds advantage; repeating a modifier is a no-op.
    pub fn advantage(&self) -> Modifiers {
        Modifiers {
            advantage: true,
            ..*self
        }
    }

    pub fn disadvantage(&self) -> Modifiers {
        Modifiers {
            disadvantage: true,
            ..*self
        }
    }

    /// Every landing attack is a crit; a natural 1 still misses.
    pub fn crit_on_hit(&self) -> Modifiers {
        Modifiers {
            crit_on_hit: true,
            ..*self
        }
    }

    fn grant(&self, until: GrantUntil) -> Grant {
        Grant(Lasting {
            spec: EffectSpec::Grant(GrantSpec {
                advantage: self.advantage,
                disadvantage: self.disadvantage,
                crit_on_hit: self.crit_on_hit,
                until,
                to: None,
            }),
        })
    }

    /// Consumed by the next attack roll that reads it, hit or miss.
    pub fn until_next_attack(&self) -> Grant {
        self.grant(GrantUntil::NextAttack)
    }

    /// Lasts for the rest of the turn.
    pub fn until_end_of_turn(&self) -> Grant {
        self.grant(GrantUntil::EndOfTurn)
    }
}

/// `advantage()`: advantage on the attack rolls that read the grant.
pub fn advantage() -> Modifiers {
    Modifiers::default().advantage()
}

/// `disadvantage()`: disadvantage on the attack rolls that read the grant; cancels an advantage.
pub fn disadvantage() -> Modifiers {
    Modifiers::default().disadvantage()
}

/// `critOnHit()`: every landing attack that reads the grant is a crit.
pub fn crit_on_hit() -> Modifiers {
    Modifiers::default().crit_on_hit()
}

/// `grantSpec(grant)`: the [`GrantSpec`] of a grant built by `advantage()`, `disadvantage()` or
/// `critOnHit()`; `None` for a save-modifier grant (TS casts blindly and returns its other spec).
pub fn grant_spec(grant: &Grant) -> Option<GrantSpec> {
    match &grant.0.spec {
        EffectSpec::Grant(g) => Some(g.clone()),
        _ => None,
    }
}

/// `effectSpec(effect)`: the JSON-safe form of any [`Lasting`] effect.
pub fn effect_spec(effect: &Lasting) -> EffectSpec {
    effect.spec.clone()
}

/// `ConditionEffect`: a condition before it has a lifetime. Immutable.
#[derive(Clone, Debug, PartialEq)]
pub struct ConditionEffect {
    name: String,
    rule: ConditionRule,
}

impl ConditionEffect {
    fn lasting(&self, until: ConditionUntil) -> Lasting {
        Lasting {
            spec: EffectSpec::Condition {
                condition: self.name.clone(),
                rule: self.rule.clone(),
                until,
            },
        }
    }

    /// Lasts for the rest of the turn.
    pub fn until_end_of_turn(&self) -> Lasting {
        self.lasting(ConditionUntil::EndOfTurn)
    }

    /// Ends when the creature takes damage; the rule's `onEnd` condition is left for the turn.
    pub fn until_damaged(&self) -> Lasting {
        self.lasting(ConditionUntil::UntilDamaged)
    }
}

/// `condition(name, rule)`: a condition the creature has, by name and rule.
pub fn condition(name: &str, rule: ConditionRule) -> ConditionEffect {
    ConditionEffect {
        name: name.to_string(),
        rule,
    }
}

/// `VulnerabilityEffect`: vulnerability before it has a lifetime; its only lifetime is the next hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VulnerabilityEffect;

impl VulnerabilityEffect {
    /// The next hit against the creature deals double damage, then it ends.
    pub fn until_next_hit(&self) -> Lasting {
        Lasting {
            spec: EffectSpec::Vulnerability,
        }
    }
}

/// `vulnerability()`.
pub fn vulnerability() -> VulnerabilityEffect {
    VulnerabilityEffect
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SaveFields {
    Disadvantage,
    Penalty { count: f64, sides: f64 },
}

/// `SaveModifier`: a modifier on the creature's saves before it has a lifetime. Immutable.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SaveModifier {
    fields: SaveFields,
}

impl SaveModifier {
    fn grant(&self, until: SaveUntil) -> Grant {
        Grant(Lasting {
            spec: match self.fields {
                SaveFields::Disadvantage => EffectSpec::SaveDisadvantage { until, to: None },
                SaveFields::Penalty { count, sides } => EffectSpec::SavePenalty {
                    count,
                    sides,
                    until,
                    to: None,
                },
            },
        })
    }

    /// Consumed by the creature's next save.
    pub fn until_next_save(&self) -> Grant {
        self.grant(SaveUntil::NextSave)
    }

    /// Lasts for the rest of the turn.
    pub fn until_end_of_turn(&self) -> Grant {
        self.grant(SaveUntil::EndOfTurn)
    }
}

/// `saveDisadvantage()`: disadvantage on the creature's saves.
pub fn save_disadvantage() -> SaveModifier {
    SaveModifier {
        fields: SaveFields::Disadvantage,
    }
}

/// `savePenalty(die)`: a die subtracted from the creature's saves. Takes one plain die group, `d4`
/// or `roll(2, d4)`.
pub fn save_penalty(die: &RollBuilder) -> Result<SaveModifier, DiceError> {
    let configs = die.get_sub_roll_configs();
    match configs.as_slice() {
        [config]
            if config.modifier == 0.0
                && config.count.partial_cmp(&1.0) != Some(std::cmp::Ordering::Less) =>
        {
            Ok(SaveModifier {
                fields: SaveFields::Penalty {
                    count: config.count,
                    sides: config.sides,
                },
            })
        }
        _ => Err(DiceError::error(
            "savePenalty takes one plain die group, such as d4 or roll(1, d4).",
        )),
    }
}

/// `StartEffect`: what `Turn.atStart` accepts: an effect with a lifetime, or one without (meaning
/// the turn).
#[derive(Clone, Debug)]
pub enum StartEffect {
    Lasting(Lasting),
    Modifiers(Modifiers),
    Condition(ConditionEffect),
    SaveModifier(SaveModifier),
}

/// `lastingForTurn`: a [`StartEffect`] as a lasting effect; one without a lifetime lasts the turn.
pub fn lasting_for_turn(effect: &StartEffect) -> Lasting {
    match effect {
        StartEffect::Lasting(l) => l.clone(),
        StartEffect::Modifiers(m) => m.until_end_of_turn().into(),
        StartEffect::Condition(c) => c.until_end_of_turn(),
        StartEffect::SaveModifier(s) => s.until_end_of_turn().into(),
    }
}

/// `TriggerSave`: a trigger's save: a DC check (a [`RollBuilder`] of kind DC; rolled in the
/// target's state) or a [`GrantSaveSpec`] itself.
#[derive(Clone, Debug)]
pub enum TriggerSave {
    Dc(RollBuilder),
    Spec(GrantSaveSpec),
}

/// `TriggerSave | readonly TriggerSave[]`.
#[derive(Clone, Debug)]
pub enum TriggerSaves {
    One(TriggerSave),
    Many(Vec<TriggerSave>),
}

impl TriggerSaves {
    fn list(&self) -> Vec<TriggerSave> {
        match self {
            TriggerSaves::One(s) => vec![s.clone()],
            TriggerSaves::Many(v) => v.clone(),
        }
    }
}

/// `isDCCheck`: true for a DC check, as opposed to a plain [`GrantSaveSpec`].
pub fn is_dc_check(save: &TriggerSave) -> bool {
    matches!(save, TriggerSave::Dc(_))
}

/// `grantSaveSpec(save, eps)`: the [`GrantSaveSpec`] of a [`TriggerSave`]. A plain DC check (a d20
/// plus a flat bonus) is `{ ability, dc, bonus, rollType }`; any other (bonus dice, a reroll,
/// `pinned()`, `alwaysFails()`) is a `failChance` that rolls the check itself in the target's
/// state. Either way its odds are read off the check's own PMF at `eps`.
pub fn grant_save_spec(save: &TriggerSave, eps: f64) -> Result<GrantSaveSpec, DiceError> {
    let check = match save {
        TriggerSave::Spec(spec) => return Ok(spec.clone()),
        TriggerSave::Dc(check) => check,
    };
    let Some(config) = check.save_config() else {
        return Err(DiceError::error(
            "save must be a DC check such as d20.plus(2).dc(15), or a GrantSaveSpec.",
        ));
    };
    let ability = check.save_ability().map(|a| a.as_str().to_string());
    let roll_type = check.roll_type();
    if check.is_plain_save() {
        return Ok(GrantSaveSpec::Dc {
            ability,
            dc: config.dc,
            bonus: check.modifier(),
            roll_type: if roll_type == RollType::Flat {
                None
            } else {
                Some(roll_type)
            },
        });
    }
    let pinned = check.get_root_die_config().is_some_and(|c| c.pinned);
    let check = check.clone();
    Ok(GrantSaveSpec::FailChance {
        ability,
        // The walk's context carries the target's state over a flat roll: the check's own roll type joins it here.
        fail_chance: FailChance::new(move |context| {
            let rolled = check.rolled_in(&RolledIn {
                roll_type: if pinned {
                    roll_type
                } else {
                    combine_roll_type(
                        roll_type,
                        false,
                        context.roll_type == RollType::Disadvantage,
                        false,
                    )
                },
                auto_fail: context.auto_fail,
                penalty_dice: &context.penalty_dice,
            })?;
            Ok(rolled.to_pmf(eps)?.p_at(1.0))
        }),
    })
}

/// `SaveGated`: effects that hang on the target's save: `fail` on a failed save, `pass` on a passed
/// one. Built only by [`save`].
#[derive(Clone, Debug)]
pub struct SaveGated {
    pub check: TriggerSaves,
    pub fail: Vec<Lasting>,
    pub pass: Vec<Lasting>,
}

/// `save(check, { fail, pass })`: the target saves against `check`; `fail` applies on a failure,
/// `pass` (if given) on a success.
///
/// `Err` (a `TypeError`) on no check (an empty list), or a `fail` with no effect.
pub fn save(
    check: TriggerSaves,
    fail: Vec<Lasting>,
    pass: Option<Vec<Lasting>>,
) -> Result<SaveGated, DiceError> {
    if check.list().is_empty() {
        return Err(DiceError::type_error(
            "save() needs a DC check such as d20.plus(2).dc(15), a GrantSaveSpec, or a non-empty list of them.",
        ));
    }
    if fail.is_empty() {
        return Err(DiceError::type_error(
            "save() needs at least one effect on a failed save.",
        ));
    }
    Ok(SaveGated {
        check,
        fail,
        pass: pass.unwrap_or_default(),
    })
}

fn refuse_gated(save: bool, chance: bool, on_save: bool) -> Result<(), DiceError> {
    if save || chance || on_save {
        return Err(DiceError::error(
            "A save() value carries its own save and pass effects: drop save, chance and onSave from the options.",
        ));
    }
    Ok(())
}

/// `unpackSave` for a builder's attached [`ConditionGate`]: the gate with `gated`'s check as `save`
/// and its `pass` as `onSave`, and the effects its `fail` stands for.
///
/// `Err` where `gate` already gates the call (`save`, `chance` or `onSave`).
pub fn unpack_save(
    gated: &SaveGated,
    gate: ConditionGate,
) -> Result<(Vec<Lasting>, ConditionGate), DiceError> {
    refuse_gated(
        gate.save.is_some(),
        gate.chance.is_some(),
        gate.on_save.is_some(),
    )?;
    Ok((
        gated.fail.clone(),
        ConditionGate {
            save: Some(gated.check.clone()),
            on_save: if gated.pass.is_empty() {
                gate.on_save
            } else {
                Some(gated.pass.clone())
            },
            ..gate
        },
    ))
}

/// `unpackSave` for a trigger verb's [`ConditionOptions`].
pub fn unpack_save_options(
    gated: &SaveGated,
    options: ConditionOptions,
) -> Result<(Vec<Lasting>, ConditionOptions), DiceError> {
    refuse_gated(
        options.save.is_some(),
        options.chance.is_some(),
        options.on_save.is_some(),
    )?;
    Ok((
        gated.fail.clone(),
        ConditionOptions {
            save: Some(gated.check.clone()),
            on_save: if gated.pass.is_empty() {
                options.on_save
            } else {
                Some(gated.pass.clone())
            },
            ..options
        },
    ))
}

/// What [`gate_fields`] returns: the fields of a `ConditionSpec` a trigger verb's options (or a
/// builder's attached gate) set, beside `on`, `of` and `grants`.
#[derive(Clone, Debug, Default)]
pub struct GateFields {
    pub chance: Option<f64>,
    pub landing: Option<SaveLanding>,
    pub dealing: Option<String>,
    pub save: Option<GrantSaves>,
    pub on_save: Option<Vec<super::types::EffectSpec>>,
    pub optional: bool,
    pub target_has: Option<Vec<String>>,
}

/// `gateFields(options, eps)`: every save, a DC check included, is rolled by the walk in the
/// target's state; `chance` is the only fixed gate.
pub fn gate_fields(options: &ConditionGate, eps: f64) -> Result<GateFields, DiceError> {
    if options.save.is_some() && options.chance.is_some() {
        return Err(DiceError::error(
            "Pass either save or chance, not both: each is the chance the grants take.",
        ));
    }
    if options.on_save.is_some() && options.save.is_none() && options.chance.is_none() {
        return Err(DiceError::error(
            "onSave needs a save or a chance: without one there is no other branch to apply it on.",
        ));
    }
    let saves = options
        .save
        .as_ref()
        .map_or_else(Vec::new, TriggerSaves::list);
    let mut grant_saves = Vec::with_capacity(saves.len());
    for entry in &saves {
        grant_saves.push(grant_save_spec(entry, eps)?);
    }
    let saved = options.on_save.clone().unwrap_or_default();
    let save = if grant_saves.is_empty() {
        None
    } else if matches!(options.save, Some(TriggerSaves::Many(_))) {
        Some(GrantSaves::Many(grant_saves))
    } else {
        grant_saves.into_iter().next().map(GrantSaves::One)
    };
    Ok(GateFields {
        chance: options.chance,
        landing: options.landing,
        dealing: options.dealing.clone(),
        save,
        on_save: if saved.is_empty() {
            None
        } else {
            Some(saved.iter().map(effect_spec).collect())
        },
        optional: options.optional,
        target_has: options.target_has.clone(),
    })
}

/// `ConditionOptions`: rider options plus what gates a call's grants. The gate applies to grants
/// only: damage passed in the same call lands whatever the save does.
#[derive(Clone, Debug, Default)]
pub struct ConditionOptions {
    pub rider: RiderOptions,
    /// The target's save, rolled in its state; a list is "the target picks the one it passes most".
    pub save: Option<TriggerSaves>,
    /// In `[0, 1]`; mutually exclusive with `save`.
    pub chance: Option<f64>,
    /// Effects applied on the other branch: the save succeeded (or `1 - chance`).
    pub on_save: Option<Vec<Lasting>>,
    /// The landing must deal damage of this type.
    pub dealing: Option<String>,
    /// "You can": the turn takes the effects only where that raises the mean.
    pub optional: bool,
    /// The probability, in `[0, 1]`, that the call's damage happens at all this turn.
    pub happens: Option<f64>,
}

impl ConditionOptions {
    /// The gate fields of these options (`Pick<ConditionOptions, "save" | "chance" | "onSave" |
    /// "landing" | "dealing" | "optional" | "targetHas">`), as [`gate_fields`] reads them.
    pub fn gate(&self) -> ConditionGate {
        ConditionGate {
            save: self.save.clone(),
            chance: self.chance,
            on_save: self.on_save.clone(),
            landing: self.rider.landing,
            dealing: self.dealing.clone(),
            optional: self.optional,
            target_has: self.rider.target_has.clone(),
        }
    }
}

/// `FirstHitOptions`: a condition's options, plus a payload per landing source.
#[derive(Clone, Debug, Default)]
pub struct FirstHitOptions {
    pub condition: ConditionOptions,
    pub per_source: Option<PerSource>,
}

/// `EveryHitOptions`: the first-hit options, plus a cap (a positive integer; omit for no cap).
#[derive(Clone, Debug, Default)]
pub struct EveryHitOptions {
    pub first_hit: FirstHitOptions,
    pub max: Option<f64>,
}
