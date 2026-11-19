//! Conversions shared by the builder bindings: enums as their TS strings, `RollConfig` as a plain
//! object, and the `...args` of `RollBuilder.fromArgs` / `onHit`.

use napi::bindgen_prelude::{ClassInstance, Either4};
use napi_derive::napi;
use yipe_dice::builder::roll::Arg;
use yipe_dice::builder::types::{
    Ability, AdvantageDice, AttackRange, KeepMode, KeepSpec, MissRerollMode, RollConfig,
    RollConfigPatch,
};
use yipe_dice::common::RollType;

use crate::roll::NativeRoll;
use crate::{DiceError, thrown};

fn bad(what: &str, got: &str) -> DiceError {
    DiceError::error(format!("dice-node: unknown {what} {got:?}"))
}

pub fn roll_type(s: &str) -> Result<RollType, DiceError> {
    RollType::parse(s).ok_or_else(|| bad("roll type", s))
}

pub fn keep_mode(s: &str) -> Result<KeepMode, DiceError> {
    match s {
        "highest" => Ok(KeepMode::Highest),
        "lowest" => Ok(KeepMode::Lowest),
        _ => Err(bad("keep mode", s)),
    }
}

pub fn miss_reroll_mode(s: &str) -> Result<MissRerollMode, DiceError> {
    match s {
        "reroll" => Ok(MissRerollMode::Reroll),
        "add-d20" => Ok(MissRerollMode::AddD20),
        _ => Err(bad("miss reroll mode", s)),
    }
}

pub fn attack_range(s: &str) -> Result<AttackRange, DiceError> {
    match s {
        "melee" => Ok(AttackRange::Melee),
        "ranged" => Ok(AttackRange::Ranged),
        _ => Err(bad("attack range", s)),
    }
}

pub fn ability_str(a: Ability) -> &'static str {
    a.as_str()
}

pub fn advantage_dice(a: AdvantageDice) -> f64 {
    match a {
        AdvantageDice::Two => 2.0,
        AdvantageDice::Three => 3.0,
    }
}

#[napi(object)]
pub struct JsKeep {
    pub total: f64,
    pub count: f64,
    pub mode: String,
}

/// `RollConfig` as the TS object (`Partial` on input: absent fields fall to `defaultConfig`).
#[napi(object)]
pub struct JsRollConfig {
    pub count: Option<f64>,
    pub sides: Option<f64>,
    pub modifier: Option<f64>,
    pub reroll: Option<f64>,
    pub explode: Option<f64>,
    pub explode_pool_budget: Option<f64>,
    pub minimum: Option<f64>,
    pub best_of: Option<f64>,
    pub keep: Option<JsKeep>,
    pub roll_type: Option<String>,
    pub is_subtraction: Option<bool>,
    pub pinned: Option<bool>,
}

impl From<&RollConfig> for JsRollConfig {
    fn from(c: &RollConfig) -> Self {
        JsRollConfig {
            count: Some(c.count),
            sides: Some(c.sides),
            modifier: Some(c.modifier),
            reroll: Some(c.reroll),
            explode: Some(c.explode),
            explode_pool_budget: Some(c.explode_pool_budget),
            minimum: Some(c.minimum),
            best_of: Some(c.best_of),
            keep: c.keep.map(|k| JsKeep {
                total: k.total,
                count: k.count,
                mode: k.mode.as_str().to_string(),
            }),
            roll_type: Some(c.roll_type.as_str().to_string()),
            is_subtraction: c.is_subtraction,
            pinned: if c.pinned { Some(true) } else { None },
        }
    }
}

pub fn configs_out(list: &[RollConfig]) -> Vec<JsRollConfig> {
    list.iter().map(JsRollConfig::from).collect()
}

impl JsRollConfig {
    pub fn to_patch(&self) -> napi::Result<RollConfigPatch> {
        let keep = match &self.keep {
            Some(k) => Some(KeepSpec {
                total: k.total,
                count: k.count,
                mode: keep_mode(&k.mode).map_err(thrown)?,
            }),
            None => None,
        };
        let roll_type = match &self.roll_type {
            Some(s) => Some(roll_type(s).map_err(thrown)?),
            None => None,
        };
        Ok(RollConfigPatch {
            count: self.count,
            sides: self.sides,
            modifier: self.modifier,
            reroll: self.reroll,
            explode: self.explode,
            explode_pool_budget: self.explode_pool_budget,
            minimum: self.minimum,
            best_of: self.best_of,
            keep,
            roll_type,
            is_subtraction: self.is_subtraction,
            pinned: self.pinned == Some(true),
        })
    }
}

/// One `...args` element: `undefined`, a number, a string (a parsed expression) or a roll.
pub type JsArg<'a> = Either4<(), f64, String, ClassInstance<'a, NativeRoll>>;

pub fn args(list: Vec<JsArg<'_>>) -> Vec<Arg> {
    list.into_iter()
        .map(|a| match a {
            Either4::A(()) => Arg::Undefined,
            Either4::B(n) => Arg::Num(n),
            Either4::C(s) => Arg::Str(s),
            Either4::D(r) => Arg::Roll(r.inner.clone()),
        })
        .collect()
}

// ---- samples ------------------------------------------------------------------------------------

use yipe_dice::builder::sample::{CheckDice, RollSample, SampledDie};

/// `SampledDie`; `reroll` and `missReroll` are present (as `true`) only when set.
#[napi(object)]
pub struct JsSampledDie {
    pub sides: f64,
    pub face: f64,
    pub kept: bool,
    pub reroll: Option<bool>,
    pub miss_reroll: Option<bool>,
}

impl From<&SampledDie> for JsSampledDie {
    fn from(d: &SampledDie) -> Self {
        JsSampledDie {
            sides: d.sides,
            face: d.face,
            kept: d.kept,
            reroll: d.reroll.then_some(true),
            miss_reroll: d.miss_reroll.then_some(true),
        }
    }
}

pub fn dice_out(list: &[SampledDie]) -> Vec<JsSampledDie> {
    list.iter().map(JsSampledDie::from).collect()
}

#[napi(object)]
pub struct JsRollSample {
    pub total: f64,
    pub dice: Vec<JsSampledDie>,
}

impl From<&RollSample> for JsRollSample {
    fn from(s: &RollSample) -> Self {
        JsRollSample {
            total: s.total,
            dice: dice_out(&s.dice),
        }
    }
}

#[napi(object)]
pub struct JsCheckDice {
    pub check: Vec<JsSampledDie>,
    pub natural: f64,
    pub bonus: f64,
}

impl From<&CheckDice> for JsCheckDice {
    fn from(c: &CheckDice) -> Self {
        JsCheckDice {
            check: dice_out(&c.check),
            natural: c.natural,
            bonus: c.bonus,
        }
    }
}

// ---- turn row context ---------------------------------------------------------------------------

use yipe_dice::turn::context::{PenaltyDice, RowCheck, RowContext, RowKind, RowRange};

#[napi(object)]
pub struct JsPenaltyDice {
    pub count: f64,
    pub sides: f64,
}

#[napi(object)]
pub struct JsRowContext {
    pub roll_type: String,
    pub auto_hit: bool,
    pub crit_on_hit: bool,
    pub auto_fail: bool,
    pub vulnerable: bool,
    pub penalty_dice: Vec<JsPenaltyDice>,
    pub joined: Vec<String>,
}

impl JsRowContext {
    pub fn to_rust(&self) -> napi::Result<RowContext> {
        Ok(RowContext {
            roll_type: roll_type(&self.roll_type).map_err(thrown)?,
            auto_hit: self.auto_hit,
            crit_on_hit: self.crit_on_hit,
            auto_fail: self.auto_fail,
            vulnerable: self.vulnerable,
            penalty_dice: self
                .penalty_dice
                .iter()
                .map(|p| PenaltyDice {
                    count: p.count,
                    sides: p.sides,
                })
                .collect(),
            joined: self.joined.clone(),
        })
    }
}

#[napi(object)]
pub struct JsRowCheck {
    pub kind: String,
    pub range: Option<String>,
    pub ability: Option<String>,
    pub roll_type: String,
    pub advantage_dice: f64,
    pub pinned: bool,
    pub auto_hit: bool,
    pub auto_crit: bool,
    pub auto_fail: bool,
}

impl From<&RowCheck> for JsRowCheck {
    fn from(c: &RowCheck) -> Self {
        JsRowCheck {
            kind: match c.kind {
                RowKind::Attack => "attack",
                RowKind::Save => "save",
                RowKind::Auto => "auto",
            }
            .to_string(),
            range: c.range.map(|r| match r {
                RowRange::Melee => "melee".to_string(),
                RowRange::Ranged => "ranged".to_string(),
            }),
            ability: c.ability.clone(),
            roll_type: c.roll_type.as_str().to_string(),
            advantage_dice: f64::from(c.advantage_dice),
            pinned: c.pinned,
            auto_hit: c.auto_hit,
            auto_crit: c.auto_crit,
            auto_fail: c.auto_fail,
        }
    }
}
