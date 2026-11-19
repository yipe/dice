//! Port of `src/builder/ac.ts`: `ACBuilder`, the to-hit check `roll.ac(15)`.
//!
//! # Shape
//! `ACBuilder extends RollBuilder` is [`RollKind::Ac`]: the `AttackConfig` is an [`AttackConfig`]
//! (its `ac` always `Some`) plus `advantage_dice`. `RollBuilder.prototype.ac` and the `ACBuilder`
//! methods are `impl RollBuilder` blocks here; a method of `ACBuilder` called on another kind of
//! roll returns `Err`. The `onHit` overloads, `alwaysHits`, `alwaysCrits`, `critOn`, `ranged`,
//! `melee`, `pinned` and `copy` have their `Ac` arms in `roll.rs` beside the always-hit/always-crit
//! ones. `sampleCheck` is [`RollBuilder::sample_check`].
//!
//! # Skipped
//! The AC-check cache (`ACBuilder` has none; `cacheKey` is [`RollBuilder::cache_key`]).

use super::arguments::require_finite;
use super::ast::{natural_die_config, resolve_root_d20};
use super::expression::check_expression;
use super::miss_reroll::miss_reroll_check_expression;
use super::roll::{AttackConfig, RollBuilder, RollKind, ac_resolved_configs};
use super::types::{AdvantageDice, MissRerollMode, RollConfig, RollType};
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::{Damage, Pmf};
use indexmap::IndexMap;

/// `combine`'s result: the roll type a net advantage resolves to and how many d20s it rolls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Combined {
    pub roll_type: RollType,
    pub dice: u8,
}

/// `combine`: a source's own roll type with granted advantage/disadvantage flags by cancellation.
/// `advantage_dice` governs how many dice a NET advantage rolls, whether it came from `roll_type`
/// itself or from the flags; an own `elven accuracy` roll type always rolls three.
pub fn combine(
    roll_type: RollType,
    advantage_dice: AdvantageDice,
    advantage: bool,
    disadvantage: bool,
) -> Combined {
    let own_advantage = matches!(roll_type, RollType::Advantage | RollType::ElvenAccuracy);
    let own_disadvantage = roll_type == RollType::Disadvantage;
    let net_advantage = own_advantage || advantage;
    let net_disadvantage = own_disadvantage || disadvantage;
    if net_advantage && net_disadvantage {
        return Combined {
            roll_type: RollType::Flat,
            dice: 1,
        };
    }
    if net_advantage {
        return Combined {
            roll_type: RollType::Advantage,
            dice: if roll_type == RollType::ElvenAccuracy || advantage_dice == AdvantageDice::Three
            {
                3
            } else {
                2
            },
        };
    }
    if net_disadvantage {
        return Combined {
            roll_type: RollType::Disadvantage,
            dice: 2,
        };
    }
    Combined {
        roll_type: RollType::Flat,
        dice: 1,
    }
}

impl RollBuilder {
    /// `RollBuilder.prototype.ac(targetAC)`: this roll as the to-hit check against `target_ac`.
    /// `Err` for a parsed roll (`ParsedCheckError`), a NaN or infinite AC.
    pub fn ac(&self, target_ac: impl Into<f64>) -> Result<RollBuilder, DiceError> {
        let target_ac = target_ac.into();
        self.refuse_parsed_check("ac")?;
        if target_ac.is_nan() {
            return Err(DiceError::error("Invalid NaN value for targetAC"));
        }
        require_finite(target_ac, "ac()")?;
        Ok(Self::new_ac(self, target_ac, None))
    }

    /// `new ACBuilder(baseRoll, ac, attackConfig?)`.
    pub(crate) fn new_ac(
        base: &RollBuilder,
        ac: f64,
        config: Option<(AttackConfig, AdvantageDice)>,
    ) -> RollBuilder {
        let (attack, advantage_dice) = match config {
            Some((attack, dice)) => (
                AttackConfig {
                    ac: Some(ac),
                    ..attack
                },
                dice,
            ),
            None => (
                AttackConfig {
                    crit_threshold: 20.0,
                    ac: Some(ac),
                    range: None,
                    miss_reroll: None,
                },
                AdvantageDice::Two,
            ),
        };
        Self::from_parts(
            base.get_sub_roll_configs(),
            RollKind::Ac {
                attack,
                advantage_dice,
            },
            0,
        )
    }

    /// `new ACBuilder(this, this.ac, { ...attackConfig, ...changes })`.
    pub(crate) fn ac_rebuilt(
        &self,
        attack: AttackConfig,
        advantage_dice: AdvantageDice,
    ) -> RollBuilder {
        Self::new_ac(
            self,
            attack.ac.unwrap_or(f64::NAN),
            Some((attack, advantage_dice)),
        )
    }

    /// `AttackConfig.advantageDice` of an AC check.
    pub fn advantage_dice(&self) -> Option<AdvantageDice> {
        match self.kind() {
            RollKind::Ac { advantage_dice, .. } => Some(*advantage_dice),
            _ => None,
        }
    }

    /// `ACBuilder.resolvedConfigs`; any other roll's own configs.
    pub(crate) fn get_resolved_configs(&self) -> Vec<RollConfig> {
        match self.kind() {
            RollKind::Ac { advantage_dice, .. } => {
                ac_resolved_configs(&self.get_sub_roll_configs(), *advantage_dice)
            }
            _ => self.get_sub_roll_configs(),
        }
    }

    /// `threeDiceAdvantage()`: three-dice advantage is an attacker property, not a roll type.
    /// Setting it applies whenever the NET result later resolves to advantage.
    pub fn three_dice_advantage(&self) -> Result<RollBuilder, DiceError> {
        match self.kind() {
            RollKind::Ac {
                attack,
                advantage_dice,
            } => {
                if *advantage_dice == AdvantageDice::Three {
                    return Ok(self.clone());
                }
                Ok(self.ac_rebuilt(*attack, AdvantageDice::Three))
            }
            _ => Err(DiceError::error(
                "threeDiceAdvantage() is only available on an AC check",
            )),
        }
    }

    /// `rerollMisses(mode)` (TS default `"add-d20"`): a missed attack roll is rolled again, once.
    /// `Err` if the natural roll is not a d20, or this is not an AC check.
    pub fn reroll_misses(&self, mode: MissRerollMode) -> Result<RollBuilder, DiceError> {
        let RollKind::Ac {
            attack,
            advantage_dice,
        } = self.kind()
        else {
            return Err(DiceError::error(
                "rerollMisses() is only available on an AC check",
            ));
        };
        match natural_die_config(self)? {
            Some(root) if root.sides == 20.0 => {}
            _ => {
                return Err(DiceError::error(
                    "rerollMisses() needs a check with a d20 natural roll: only a d20 is rolled again.",
                ));
            }
        }
        Ok(self.ac_rebuilt(
            AttackConfig {
                miss_reroll: Some(mode),
                ..*attack
            },
            *advantage_dice,
        ))
    }

    /// `copy(ac)` of an AC check: the same check, with a replacement AC when given (`vsAC` rebinds
    /// the check without rebuilding the roll).
    pub fn copy_with_ac(&self, ac: Option<f64>) -> Result<RollBuilder, DiceError> {
        let RollKind::Ac {
            attack,
            advantage_dice,
        } = self.kind()
        else {
            return Err(DiceError::error(
                "copy(ac) is only available on an AC check",
            ));
        };
        let ac = ac.or(attack.ac).unwrap_or(f64::NAN);
        Ok(Self::new_ac(
            &Self::with_configs(&self.get_sub_roll_configs()),
            ac,
            Some((*attack, *advantage_dice)),
        ))
    }

    /// `ACBuilder.toExpression`: `(<to-hit total> AC <ac>)`.
    pub(crate) fn ac_expression(&self) -> Result<String, DiceError> {
        let RollKind::Ac { attack, .. } = self.kind() else {
            return Err(DiceError::error("toExpression: not an AC check"));
        };
        let check = if attack.miss_reroll.is_none() {
            check_expression(self)?
        } else {
            miss_reroll_check_expression(self)?
        };
        Ok(format!(
            "({check} AC {})",
            attack.ac.map_or(String::new(), num_to_string)
        ))
    }

    /// `ACBuilder.toPMF(eps)`: the raw to-hit PMF: the check's total where it reaches the AC and 0
    /// where it does not, with no natural-1 miss or natural-20 hit.
    pub(crate) fn ac_to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        let RollKind::Ac { attack, .. } = self.kind() else {
            return Err(DiceError::error("toPMF: not an AC check"));
        };
        let ac = attack.ac.unwrap_or(f64::NAN);
        let d20 = resolve_root_d20(self)?;
        let static_mod = self.modifier();
        let bonus = self.get_bonus_dice_pmfs(self, eps)?;

        // attackRollPMF = d20 ⊕ bonusDice, then shifted by staticMod.
        let mut roll = if bonus.is_empty() {
            d20
        } else {
            let mut parts = vec![d20];
            parts.extend(bonus);
            Pmf::convolve_many(&parts, eps)
        };
        if static_mod != 0.0 {
            roll = roll.map_damage(|v| v + static_mod);
        }

        let mut out: IndexMap<Damage, f64> = IndexMap::new();
        for value in roll.support() {
            let p = roll.p_at(value.0);
            let key = if value.0 >= ac { value } else { Damage(0.0) };
            *out.entry(key).or_insert(0.0) += p;
        }
        Pmf::from_map(out, eps, false)
    }
}
