//! Port of `src/builder/dc.ts`: `DCBuilder`, the save check `roll.dc(15)`.
//!
//! # Shape
//! `DCBuilder extends RollBuilder` is [`RollKind::Dc`] with a [`SaveConfig`]. `RollBuilder.prototype.dc`
//! and the `DCBuilder` methods are `impl RollBuilder` blocks here; a `DCBuilder` method called on
//! another kind of roll returns `Err` (or `None`/`false` for the getters). The `onSaveFailure`
//! overloads are [`RollBuilder::on_save_failure`] (damage arguments) and
//! [`RollBuilder::on_save_failure_effects`] (a list of effects and at most one damage roll).
//! `DCBuilder.add`/`addRoll`/`pinned`/`copy`/`withElvenAccuracy`/`toPMF`/`toExpression`/`cacheKey`
//! have their `Dc` arms in `roll.rs`.
//!
//! # Skipped
//! `dcPMFCache` and `clearDCCache` (the cache; the key is [`RollBuilder::cache_key`]).

use super::arguments::require_finite;
use super::ast::resolve_root_d20;
use super::attack::{AttachedCondition, AttachedOn, ConditionGate};
use super::prob::split_at_threshold;
use super::roll::{Arg, RollBuilder, RollKind, natural_roll_index};
use super::sample::{SampledDie, sample_check_dice};
use super::save::{SaveBuilder, SaveOutcome};
use super::types::{Ability, RollConfig, RollType};
use crate::common::Rng;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::turn::context::{PenaltyDice, RowContext};
use crate::turn::effects::Lasting;
use crate::{Damage, Pmf};
use indexmap::IndexMap;

/// `SaveConfig`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SaveConfig {
    pub dc: f64,
    /// `ability()`: the save's ability, by its full name. A row fact; the PMF does not read it.
    pub ability: Option<Ability>,
    /// `alwaysFails()`: the save fails without rolling.
    pub auto_fail: bool,
}

/// `abilityOf`: the full ability for `name`; `Err` (a `TypeError`) naming the value for anything else.
fn ability_of(name: &str) -> Result<Ability, DiceError> {
    Ability::parse(name).ok_or_else(|| DiceError::type_error(format!(
            "ability({}): expected str, dex, con, int, wis or cha, or a full name (strength, dexterity, constitution, intelligence, wisdom, charisma).",
            serde_json::to_string(name).unwrap_or_default()
        )))
}

/// `CheckSample`: one draw of a save check: the dice, their total with the modifier, and whether it
/// fell short of the DC.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckSample {
    pub check: Vec<SampledDie>,
    pub total: f64,
    pub failed: bool,
}

/// `saveProbabilities()`'s result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SaveProbabilities {
    pub p_success: f64,
    pub p_fail: f64,
}

/// `Pick<RowContext, "rollType" | "autoFail" | "penaltyDice">`: what [`RollBuilder::rolled_in`] reads.
#[derive(Clone, Copy, Debug)]
pub struct RolledIn<'a> {
    pub roll_type: RollType,
    pub auto_fail: bool,
    pub penalty_dice: &'a [PenaltyDice],
}

/// JS truthiness of a number.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// One part of `onSaveFailure([...])`: an effect with a lifetime, or a damage roll.
#[derive(Clone, Debug)]
pub enum FailurePart {
    Effect(Lasting),
    Damage(Arg),
}

impl RollBuilder {
    /// `RollBuilder.prototype.dc(saveDC)` / `DCBuilder.dc`: this roll as the save check against
    /// `save_dc`. On a DC check it keeps the ability and `alwaysFails`. `Err` for a parsed roll
    /// (`ParsedCheckError`), a NaN or infinite DC, or an Elven Accuracy roll.
    pub fn dc(&self, save_dc: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let save_dc = save_dc.into();
        self.refuse_parsed_check("dc")?;
        let config = match self.kind() {
            RollKind::Dc { save } => *save,
            _ => SaveConfig {
                dc: 10.0,
                ability: None,
                auto_fail: false,
            },
        };
        if save_dc.is_nan() {
            return Err(DiceError::error("Invalid NaN value for saveDC"));
        }
        require_finite(save_dc, "dc()")?;
        let configs = self.get_sub_roll_configs();
        let this = Self::from_parts(configs.clone(), RollKind::Dc { save: config }, 0);
        if this.roll_type() == RollType::ElvenAccuracy {
            return Err(DiceError::error(
                "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead.",
            ));
        }
        Ok(Self::from_parts(
            configs,
            RollKind::Dc {
                save: SaveConfig {
                    dc: save_dc,
                    ..config
                },
            },
            0,
        ))
    }

    /// `new DCBuilder(baseRoll, saveConfig)`.
    pub(crate) fn dc_over(base: &RollBuilder, save: SaveConfig) -> RollBuilder {
        Self::from_parts(base.get_sub_roll_configs(), RollKind::Dc { save }, 0)
    }

    /// The [`SaveConfig`] of a DC check.
    pub fn save_config(&self) -> Option<&SaveConfig> {
        match self.kind() {
            RollKind::Dc { save } => Some(save),
            _ => None,
        }
    }

    /// `saveDC`.
    pub fn save_dc(&self) -> Option<f64> {
        self.save_config().map(|c| c.dc)
    }

    /// `saveAbility`: the save's ability, or `None` when `ability()` was never called.
    pub fn save_ability(&self) -> Option<Ability> {
        self.save_config().and_then(|c| c.ability)
    }

    /// `autoFail`: whether `alwaysFails()` was called (false for any other roll).
    pub fn auto_fail(&self) -> bool {
        self.save_config().is_some_and(|c| c.auto_fail)
    }

    fn require_dc(&self, what: &str) -> Result<SaveConfig, DiceError> {
        self.save_config()
            .copied()
            .ok_or_else(|| DiceError::error(format!("{what} is only available on a DC check")))
    }

    /// `ability(name)`: the save's ability, for a turn's condition rules keyed by ability:
    /// `"con"` or `"constitution"`, stored as the full name. A row fact. `Err` (a `TypeError`) on
    /// anything else.
    pub fn ability(&self, name: &str) -> Result<RollBuilder, DiceError> {
        let config = self.require_dc("ability()")?;
        Ok(Self::dc_over(
            self,
            SaveConfig {
                ability: Some(ability_of(name)?),
                ..config
            },
        ))
    }

    /// `alwaysFails()`: the save fails without rolling.
    pub fn always_fails(&self) -> Result<RollBuilder, DiceError> {
        let config = self.require_dc("alwaysFails()")?;
        if config.auto_fail {
            return Ok(self.clone());
        }
        Ok(Self::dc_over(
            self,
            SaveConfig {
                auto_fail: true,
                ..config
            },
        ))
    }

    /// `isPlainSave`: whether this check is a lone d20 plus a flat bonus and nothing else: no bonus
    /// or penalty dice, no reroll or other die option, not pinned and not `alwaysFails()`.
    pub fn is_plain_save(&self) -> bool {
        let Some(config) = self.save_config() else {
            return false;
        };
        if config.auto_fail {
            return false;
        }
        let configs = self.get_sub_roll_configs();
        let Some(root) = natural_roll_index(&configs) else {
            return false;
        };
        let c = &configs[root];
        if c.sides != 20.0
            || c.count != 1.0
            || truthy(c.reroll)
            || truthy(c.explode)
            || truthy(c.explode_pool_budget)
            || truthy(c.minimum)
            || truthy(c.best_of)
            || c.keep.is_some()
            || c.pinned
        {
            return false;
        }
        configs
            .iter()
            .enumerate()
            .all(|(i, c)| i == root || c.sides == 0.0 || c.count == 0.0)
    }

    /// `rolledIn(context)`: this check rolled in a turn's row context, as a save row rolls it: the
    /// natural roll takes `roll_type` literally, each of `penalty_dice` comes off the roll
    /// (`d20.plus(5).minus(1, d4)`), and `auto_fail` makes it fail without rolling (on top of its own
    /// `alwaysFails()`). The DC and ability are kept. `Err` (a `RangeError`) for Elven Accuracy.
    pub fn rolled_in(&self, context: &RolledIn<'_>) -> Result<RollBuilder, DiceError> {
        let config = self.require_dc("rolledIn()")?;
        if context.roll_type == RollType::ElvenAccuracy {
            return Err(DiceError::range(
                "A save cannot roll with Elven Accuracy: it is only valid for attack rolls.",
            ));
        }
        let mut configs: Vec<RollConfig> = self.get_sub_roll_configs();
        if let Some(root) = natural_roll_index(&configs) {
            configs[root].roll_type = context.roll_type;
        }
        let mut roll = Self::with_configs(&configs);
        for die in context.penalty_dice {
            roll = roll.minus_dice(die.count, &RollBuilder::new(1.0)?.d(die.sides)?)?;
        }
        let auto_fail = config.auto_fail || context.auto_fail;
        Ok(Self::dc_over(
            &roll,
            SaveConfig {
                auto_fail: if auto_fail { true } else { config.auto_fail },
                ..config
            },
        ))
    }

    /// `inContext(context)`: this check as a save row rolls it in a turn's `context`
    /// ([`RollBuilder::rolled_in`]), keeping its own roll type when pinned; `None` ("`this`") when
    /// the context changes nothing.
    pub fn in_context(&self, context: &RowContext) -> Result<Option<RollBuilder>, DiceError> {
        let own = self.roll_type();
        let pinned = self.get_root_die_config().is_some_and(|c| c.pinned);
        let roll_type = if pinned { own } else { context.roll_type };
        let auto_fail = self.auto_fail() || context.auto_fail;
        if roll_type == own && auto_fail == self.auto_fail() && context.penalty_dice.is_empty() {
            return Ok(None);
        }
        self.rolled_in(&RolledIn {
            roll_type,
            auto_fail,
            penalty_dice: &context.penalty_dice,
        })
        .map(Some)
    }

    /// `onSaveFailure(...args)`: a save dealing `RollBuilder.fromArgs(...args)` on a failure.
    pub fn on_save_failure(&self, arg: impl Into<Arg>) -> Result<SaveBuilder, DiceError> {
        self.on_save_failure_args(&[arg.into()])
    }

    /// [`Self::on_save_failure`] with several arguments (`RollBuilder.fromArgs(...args)`).
    pub fn on_save_failure_args(&self, args: &[Arg]) -> Result<SaveBuilder, DiceError> {
        self.require_dc("onSaveFailure()")?;
        let damage = Self::from_args(args)?;
        Ok(SaveBuilder::new(
            self.clone(),
            Some(damage),
            SaveOutcome::Normal,
            Vec::new(),
        ))
    }

    /// `onSaveFailure(effects)`: effects with a lifetime beside at most one damage roll apply in a
    /// turn on a failed save: `onSaveFailure([roll(8, d6), prone().untilEndOfTurn()])` is the
    /// condition `{ on: "every-hit", of: [this save], landing: "fail" }`. `Err` for more than one
    /// damage roll.
    pub fn on_save_failure_effects(&self, parts: &[FailurePart]) -> Result<SaveBuilder, DiceError> {
        self.require_dc("onSaveFailure()")?;
        let mut grants: Vec<Lasting> = Vec::new();
        let mut damage: Vec<&Arg> = Vec::new();
        for part in parts {
            match part {
                FailurePart::Effect(l) => grants.push(l.clone()),
                FailurePart::Damage(a) => damage.push(a),
            }
        }
        if damage.len() > 1 {
            return Err(DiceError::error(
                "onSaveFailure takes at most one damage roll beside its effects; add the rolls together.",
            ));
        }
        let attached = if grants.is_empty() {
            Vec::new()
        } else {
            vec![AttachedCondition {
                on: AttachedOn::EveryHit,
                grants,
                gate: Some(ConditionGate {
                    landing: Some(crate::turn::types::SaveLanding::Fail),
                    ..ConditionGate::default()
                }),
            }]
        };
        let roll = match damage.first() {
            Some(arg) => Some(Self::from_args(std::slice::from_ref(*arg))?),
            None => None,
        };
        Ok(SaveBuilder::new(
            self.clone(),
            roll,
            SaveOutcome::Normal,
            attached,
        ))
    }

    /// `DCBuilder.toExpression`: `(<roll> DC <dc>)`. `Err` under `alwaysFails()`: the grammar has no
    /// always-fail clause.
    pub(crate) fn dc_expression(&self) -> Result<String, DiceError> {
        let config = self.require_dc("toExpression()")?;
        if config.auto_fail {
            return Err(DiceError::error(
                "toExpression() cannot represent alwaysFails(): the expression grammar has no always-fail clause. Use toPMF() instead.",
            ));
        }
        let expression = Self::with_configs(&self.get_sub_roll_configs()).to_expression()?;
        Ok(format!("({expression} DC {})", num_to_string(config.dc)))
    }

    /// `saveProbabilities()`: P(success) and P(failure) of this save: success iff natural roll +
    /// bonus dice + modifier >= DC, with no natural-1/natural-20 rule (a check with no die compares
    /// its flat total alone). Each side is summed from its own outcomes, so a certain success has a
    /// failure chance of exactly 0. Under `alwaysFails()` the failure chance is 1.
    pub fn save_probabilities(&self) -> Result<SaveProbabilities, DiceError> {
        let config = self.require_dc("saveProbabilities()")?;
        if config.auto_fail {
            return Ok(SaveProbabilities {
                p_success: 0.0,
                p_fail: 1.0,
            });
        }
        let natural = resolve_root_d20(self)?;
        let bonus_pmfs = self.get_bonus_dice_pmfs(self, 0.0)?;
        let bonus = if bonus_pmfs.is_empty() {
            Pmf::delta(0.0, 0.0)?
        } else {
            Pmf::convolve_many(&bonus_pmfs, 0.0)
        };
        let mut p_success = 0.0;
        let mut p_fail = 0.0;
        for (r, bin) in &natural.map {
            let split = split_at_threshold(&bonus, config.dc - self.modifier() - r.0);
            p_success += bin.p * split.at_least;
            p_fail += bin.p * split.below;
        }
        Ok(SaveProbabilities { p_success, p_fail })
    }

    /// `sampleCheck(rng, context?)`: one draw of this check as [`RollBuilder::save_probabilities`]
    /// weighs it: the d20 under the roll type (dropped dice `kept: false`), then each bonus and
    /// penalty die (penalties subtracted), plus the modifier; `failed` when the total is below the
    /// DC, with no natural-1/natural-20 rule. In a `context` the check is first rolled
    /// [`RollBuilder::in_context`]. `alwaysFails()` or `context.auto_fail` fails with no draw.
    pub fn sample_dc_check(
        &self,
        rng: &mut dyn Rng,
        context: Option<&RowContext>,
    ) -> Result<CheckSample, DiceError> {
        let config = self.require_dc("sampleCheck()")?;
        let moved = match context {
            Some(c) => self.in_context(c)?,
            None => None,
        };
        let check = moved.as_ref().unwrap_or(self);
        let config = check.save_config().copied().unwrap_or(config);
        if config.auto_fail {
            return Ok(CheckSample {
                check: Vec::new(),
                total: 0.0,
                failed: true,
            });
        }
        let drawn = sample_check_dice(check, rng)?;
        let total = drawn.natural + drawn.bonus + check.modifier();
        Ok(CheckSample {
            check: drawn.check,
            total,
            failed: total < config.dc,
        })
    }

    /// `DCBuilder.toPMF(eps)`: the check outcome as a PMF: a success at 0, a failure at 1 (so
    /// `hitProbability()` is the chance the save fails).
    pub(crate) fn dc_to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        let SaveProbabilities { p_success, p_fail } = self.save_probabilities()?;
        let mut m: IndexMap<Damage, f64> = IndexMap::new();
        if p_success > 0.0 {
            m.insert(Damage(0.0), p_success);
        }
        if p_fail > 0.0 {
            m.insert(Damage(1.0), p_fail);
        }
        Pmf::from_map(m, eps, false)
    }
}
