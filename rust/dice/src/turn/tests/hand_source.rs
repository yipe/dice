//! A hand-written `ContextualSource` for the translated turn tests: the TS object literal
//! `{ rowCheck, under, rerolledUnder?, dealt?, rollUnder? }` as one value, plus the small PMF and
//! context constructors those literals lean on.

use crate::builder::types::RollType;
use crate::error::DiceError;
use crate::pmf::mixture::Mixture;
use crate::pmf::{Bin, LabelMap, Pmf};
use crate::turn::context::{ContextualSource, Dealt, RollUnder, RowCheck, RowContext, RowKind};
use crate::turn::types::{ArcContextual, Source};
use crate::{Damage, EPS};
use indexmap::IndexMap;
use std::sync::Arc;

pub type UnderFn = dyn Fn(&RowContext) -> Result<Pmf, DiceError> + Send + Sync;
pub type DealtFn = dyn Fn(&str) -> Dealt + Send + Sync;
pub type DiceMatchFn =
    dyn Fn(f64) -> Result<crate::turn::context::MatchPair, DiceError> + Send + Sync;
pub type RollUnderFn = dyn Fn(&RowContext) -> Result<Option<RollUnder>, DiceError> + Send + Sync;

/// `{ rowCheck, under, rerolledUnder?, dealt?, rollUnder? }`.
#[derive(Clone)]
pub struct Hand {
    pub check: RowCheck,
    pub under: Arc<UnderFn>,
    pub rerolled: Option<Arc<UnderFn>>,
    pub dealt: Option<Arc<DealtFn>>,
    pub roll_under: Option<Arc<RollUnderFn>>,
    pub dice_match: Option<Arc<DiceMatchFn>>,
}

impl Hand {
    pub fn new(
        check: RowCheck,
        under: impl Fn(&RowContext) -> Result<Pmf, DiceError> + Send + Sync + 'static,
    ) -> Hand {
        Hand {
            check,
            under: Arc::new(under),
            rerolled: None,
            dealt: None,
            roll_under: None,
            dice_match: None,
        }
    }

    /// `rerolledUnder`.
    pub fn rerolled(
        mut self,
        f: impl Fn(&RowContext) -> Result<Pmf, DiceError> + Send + Sync + 'static,
    ) -> Hand {
        self.rerolled = Some(Arc::new(f));
        self
    }

    /// `dealt`.
    pub fn dealt(mut self, f: impl Fn(&str) -> Dealt + Send + Sync + 'static) -> Hand {
        self.dealt = Some(Arc::new(f));
        self
    }

    /// `diceMatchInfo`.
    pub fn dice_match(
        mut self,
        f: impl Fn(f64) -> Result<crate::turn::context::MatchPair, DiceError> + Send + Sync + 'static,
    ) -> Hand {
        self.dice_match = Some(Arc::new(f));
        self
    }

    /// `rollUnder`.
    pub fn roll_under(
        mut self,
        f: impl Fn(&RowContext) -> Result<Option<RollUnder>, DiceError> + Send + Sync + 'static,
    ) -> Hand {
        self.roll_under = Some(Arc::new(f));
        self
    }

    /// The same hand as a turn source.
    pub fn source(&self) -> Source {
        Source::Contextual(ArcContextual(Arc::new(self.clone())))
    }
}

impl ContextualSource for Hand {
    fn row_check(&self) -> RowCheck {
        self.check.clone()
    }

    fn under(&self, context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        (self.under)(context)
    }

    fn has_rerolled_under(&self) -> bool {
        self.rerolled.is_some()
    }

    fn rerolled_under(&self, context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        match &self.rerolled {
            Some(f) => f(context),
            None => Err(DiceError::error("rerolledUnder is not provided")),
        }
    }

    fn has_dealt(&self) -> bool {
        self.dealt.is_some()
    }

    fn dealt(&self, type_: &str, _context: &RowContext) -> Result<Dealt, DiceError> {
        match &self.dealt {
            Some(f) => Ok(f(type_)),
            None => Err(DiceError::error("dealt is not provided")),
        }
    }

    fn dice_match_info(&self, eps: f64) -> Result<crate::turn::context::MatchPair, DiceError> {
        match &self.dice_match {
            Some(f) => f(eps),
            None => Ok((None, None)),
        }
    }

    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        match &self.roll_under {
            Some(f) => f(context),
            None => Ok(None),
        }
    }
}

/// An attack row's declared facts: flat, two advantage dice, nothing pinned or automatic.
pub fn attack_check() -> RowCheck {
    RowCheck {
        kind: RowKind::Attack,
        range: None,
        ability: None,
        roll_type: RollType::Flat,
        advantage_dice: 2,
        pinned: false,
        auto_hit: false,
        auto_crit: false,
        auto_fail: false,
    }
}

/// The context of a plain row: flat d20, nothing in force.
pub fn plain_context() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: Vec::new(),
        joined: Vec::new(),
    }
}

/// `PMF.delta(value)`.
pub fn delta(value: f64) -> Pmf {
    Pmf::from_map(IndexMap::from([(Damage(value), 1.0)]), EPS, true)
        .unwrap_or_else(|_| Pmf::zero(EPS))
}

/// `Mixture.mix(items)` at the default epsilon.
pub fn mix(items: &[(&str, &Pmf, f64)]) -> Result<Pmf, DiceError> {
    Mixture::mix(items, EPS)
}

/// `new PMF(new Map(entries.map(([damage, p]) => [damage, { p, count: { label: p } }])))`: each
/// damage lands as `label` with mass `p`.
pub fn labelled(entries: &[(f64, f64)], label: &str) -> Pmf {
    let map = entries
        .iter()
        .map(|&(damage, p)| {
            let mut count = LabelMap::new();
            count.insert(label.to_string(), p);
            (
                Damage(damage),
                Bin {
                    p,
                    count,
                    attr: None,
                },
            )
        })
        .collect();
    Pmf::new(map, EPS, false)
}

/// The largest `|actual.pAt(v) - expected.pAt(v)|` over both supports.
pub fn pmf_max_diff(actual: &Pmf, expected: &Pmf) -> f64 {
    let mut values: Vec<f64> = actual
        .support()
        .iter()
        .chain(expected.support().iter())
        .map(|d| d.0)
        .collect();
    values.sort_by(f64::total_cmp);
    values.dedup();
    values.into_iter().fold(0.0, |worst, value| {
        worst.max((actual.p_at(value) - expected.p_at(value)).abs())
    })
}

// ---- spec constructors (the TS object literals) -------------------------------------------------

use crate::turn::effects::effect_spec;
use crate::turn::types::{
    Attack, AttackOptions, AttackTriggerOn, ConditionOn, ConditionSpec, DamageSource, EffectSpec,
    GrantSaveSpec, GrantSaves, GrantSpec, GrantUntil, Rider, RiderDamage, RiderDamageSpec,
    RiderLanding, SubstituteSpec, Trigger, TurnSpec,
};

/// `["a", "b"]`.
pub fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(std::string::ToString::to_string).collect()
}

/// `{ id, source }`.
pub fn declared(id: &str, source: impl Into<Source>) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            id: Some(id.to_string()),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

/// `{ id?, on, of?, landing?, damage }` over one plain payload.
pub fn rider(
    id: &str,
    trigger: Trigger,
    landing: Option<RiderLanding>,
    damage: impl Into<DamageSource>,
) -> Rider {
    Rider {
        trigger,
        id: Some(id.to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage.into())),
        crit_damage: None,
        landing,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

/// `{ id, on, of, grants }`.
pub fn condition(
    id: &str,
    on: AttackTriggerOn,
    of: &[&str],
    grants: Vec<EffectSpec>,
) -> ConditionSpec {
    ConditionSpec {
        id: Some(id.to_string()),
        on: ConditionOn::Attack(on),
        of: Some(names(of)),
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants,
        on_save: None,
        optional: false,
    }
}

/// `{ advantage: true, until }`.
pub fn grant_advantage(until: GrantUntil) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: true,
        disadvantage: false,
        crit_on_hit: false,
        until,
        to: None,
    })
}

/// `{ ability, dc, bonus }`.
pub fn dc_save(ability: &str, dc: f64, bonus: f64) -> GrantSaves {
    GrantSaves::One(GrantSaveSpec::Dc {
        ability: Some(ability.to_string()),
        dc,
        bonus,
        roll_type: None,
    })
}

/// `{ condition: name, rule: RULES[name], until: "end-of-turn" }` of `prone` / `stunned`.
pub fn lasting(effect: &crate::turn::effects::Lasting) -> EffectSpec {
    effect_spec(effect)
}

/// A spec of attacks, riders, substitutes and conditions (an empty list is absent).
pub fn spec_of(
    attacks: Vec<Attack>,
    riders: Vec<Rider>,
    substitutes: Vec<SubstituteSpec>,
    conditions: Vec<ConditionSpec>,
) -> TurnSpec {
    TurnSpec {
        attacks,
        riders: (!riders.is_empty()).then_some(riders),
        substitutes: (!substitutes.is_empty()).then_some(substitutes),
        conditions: (!conditions.is_empty()).then_some(conditions),
        ..TurnSpec::default()
    }
}
