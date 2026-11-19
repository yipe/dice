//! `NativeRoll`: a Rust `RollBuilder` handle (every TS subclass is one `RollKind`; `kind()` names it).
//! Generated from a method table, then edited by hand: keep the shape when adding methods.

use napi::bindgen_prelude::ClassInstance;
use napi_derive::napi;
use yipe_dice::builder::nodes::Rounding;
use yipe_dice::builder::roll::{RollBuilder, RollKind, RollRerollUpToOptions};
use yipe_dice::builder::types::RollConfig;

use crate::conv::{self, JsArg, JsRollConfig};
use crate::pmf::{NativePmf, NativeQuery};
use crate::{DiceError, err, thrown};

#[napi(object)]
pub struct JsAttackConfig {
    pub crit_threshold: f64,
    pub ac: Option<f64>,
    pub range: Option<String>,
    pub miss_reroll: Option<String>,
}

#[napi(object)]
pub struct JsCritCheckParts {
    pub ac: Option<f64>,
    pub crit_threshold: f64,
    pub crit_on_hit: bool,
}

#[napi]
pub struct NativeRoll {
    pub(crate) inner: RollBuilder,
}

impl NativeRoll {
    pub(crate) fn wrap(inner: RollBuilder) -> Self {
        Self { inner }
    }
}

pub(crate) fn r(x: Result<RollBuilder, DiceError>) -> napi::Result<NativeRoll> {
    x.map(NativeRoll::wrap).map_err(thrown)
}

pub(crate) fn rounding(s: &str) -> napi::Result<Rounding> {
    match s {
        "floor" => Ok(Rounding::Floor),
        "round" => Ok(Rounding::Round),
        "ceil" => Ok(Rounding::Ceil),
        _ => Err(err(format!("dice-node: unknown rounding {s:?}"))),
    }
}

pub(crate) fn kind_name(k: &RollKind) -> &'static str {
    match k {
        RollKind::Plain => "plain",
        RollKind::Half { .. } => "half",
        RollKind::Scale { .. } => "scale",
        RollKind::MaxOf { .. } => "maxOf",
        RollKind::RerollUpTo { .. } => "rerollUpTo",
        RollKind::AlwaysHit { .. } => "alwaysHit",
        RollKind::AlwaysCrit { .. } => "alwaysCrit",
        RollKind::Parsed { .. } => "parsed",
        RollKind::Pooled { .. } => "pooled",
        RollKind::CompositeSum { .. } => "compositeSum",
        RollKind::MaxOfRolls { .. } => "maxOfRolls",
        RollKind::Ac { .. } => "ac",
        RollKind::Dc { .. } => "dc",
    }
}

#[napi]
impl NativeRoll {
    // ---- construction ----
    #[napi(factory)]
    pub fn zero() -> NativeRoll {
        Self::wrap(RollBuilder::zero())
    }
    /// `new RollBuilder(count)`.
    #[napi(factory)]
    pub fn from_count(count: f64) -> napi::Result<NativeRoll> {
        r(RollBuilder::new(count))
    }
    /// `new RollBuilder(configs)`.
    #[napi(factory)]
    pub fn from_full_configs(configs: Vec<JsRollConfig>) -> napi::Result<NativeRoll> {
        let patches = configs
            .iter()
            .map(|c| c.to_patch())
            .collect::<napi::Result<Vec<_>>>()?;
        let full: Vec<RollConfig> = patches
            .iter()
            .map(|p| RollBuilder::from_config(p).raw_configs()[0].clone())
            .collect();
        Ok(Self::wrap(RollBuilder::with_configs(&full)))
    }
    #[napi(factory)]
    pub fn from_config(config: JsRollConfig) -> napi::Result<NativeRoll> {
        Ok(Self::wrap(RollBuilder::from_config(&config.to_patch()?)))
    }
    #[napi(factory)]
    pub fn from_configs(configs: Vec<JsRollConfig>) -> napi::Result<NativeRoll> {
        let patches = configs
            .iter()
            .map(|c| c.to_patch())
            .collect::<napi::Result<Vec<_>>>()?;
        Ok(Self::wrap(RollBuilder::from_configs(&patches)))
    }
    #[napi(factory)]
    pub fn parsed(expression: String) -> napi::Result<NativeRoll> {
        r(RollBuilder::parsed(&expression))
    }
    #[napi(factory)]
    pub fn from_args(args: Vec<JsArg<'_>>) -> napi::Result<NativeRoll> {
        r(RollBuilder::from_args(&conv::args(args)))
    }
    #[napi(factory)]
    pub fn repeated(die: &NativeRoll, count: f64) -> napi::Result<NativeRoll> {
        r(RollBuilder::repeated(&die.inner, count))
    }
    #[napi(factory)]
    pub fn sum_rolls(parts: Vec<ClassInstance<NativeRoll>>) -> napi::Result<NativeRoll> {
        let list: Vec<RollBuilder> = parts.iter().map(|p| p.inner.clone()).collect();
        r(yipe_dice::builder::roll::sum_rolls(&list))
    }

    // ---- shape ----
    /// The TS subclass: plain, half, scale, maxOf, rerollUpTo, alwaysHit, alwaysCrit, parsed,
    /// pooled, compositeSum, maxOfRolls, ac, dc.
    #[napi]
    pub fn kind(&self) -> &'static str {
        kind_name(self.inner.kind())
    }
    #[napi]
    pub fn is_transformed(&self) -> bool {
        self.inner.is_transformed()
    }
    // Exported to JS as `fromAlwaysHit()`, which the TS facade calls; the name is the engine's.
    #[allow(clippy::wrong_self_convention)]
    #[napi]
    pub fn from_always_hit(&self) -> Option<bool> {
        self.inner.from_always_hit()
    }
    #[napi]
    pub fn attack_config(&self) -> Option<JsAttackConfig> {
        self.inner.attack_config().map(|a| JsAttackConfig {
            crit_threshold: a.crit_threshold,
            ac: a.ac,
            range: a.range.map(|x| x.as_str().to_string()),
            miss_reroll: a.miss_reroll.map(|x| x.as_str().to_string()),
        })
    }
    #[napi]
    pub fn crit_threshold(&self) -> Option<f64> {
        self.inner.crit_threshold()
    }
    #[napi]
    pub fn crit_check_parts(&self) -> Option<JsCritCheckParts> {
        self.inner.crit_check_parts().map(|c| JsCritCheckParts {
            ac: c.ac,
            crit_threshold: c.crit_threshold,
            crit_on_hit: c.crit_on_hit,
        })
    }
    #[napi]
    pub fn refuse_parsed_check(&self, verb: String) -> napi::Result<()> {
        self.inner.refuse_parsed_check(&verb).map_err(thrown)
    }
    #[napi]
    pub fn has_hidden_state(&self) -> bool {
        self.inner.has_hidden_state()
    }
    #[napi]
    pub fn get_sub_roll_configs(&self) -> Vec<JsRollConfig> {
        conv::configs_out(&self.inner.get_sub_roll_configs())
    }
    #[napi]
    pub fn get_all_die_configs(&self) -> Vec<JsRollConfig> {
        conv::configs_out(&self.inner.get_all_die_configs())
    }
    #[napi]
    pub fn get_root_die_config(&self) -> Option<JsRollConfig> {
        self.inner
            .get_root_die_config()
            .as_ref()
            .map(JsRollConfig::from)
    }
    #[napi]
    pub fn get_bonus_dice_configs(&self) -> Vec<JsRollConfig> {
        conv::configs_out(&self.inner.get_bonus_dice_configs())
    }
    #[napi]
    pub fn get_bonus_dice_pmfs(
        &self,
        check: &NativeRoll,
        eps: f64,
    ) -> napi::Result<Vec<NativePmf>> {
        self.inner
            .get_bonus_dice_pmfs(&check.inner, eps)
            .map(|v| v.into_iter().map(NativePmf::wrap).collect())
            .map_err(thrown)
    }
    #[napi]
    pub fn modifier(&self) -> f64 {
        self.inner.modifier()
    }
    #[napi]
    pub fn roll_type(&self) -> &'static str {
        self.inner.roll_type().as_str()
    }
    #[napi]
    pub fn base_reroll(&self) -> f64 {
        self.inner.base_reroll()
    }
    #[napi]
    pub fn cache_key(&self) -> Option<String> {
        self.inner.cache_key()
    }
    #[napi]
    pub fn pinned_configs(&self) -> napi::Result<Vec<JsRollConfig>> {
        self.inner
            .pinned_configs()
            .map(|v| conv::configs_out(&v))
            .map_err(thrown)
    }
    #[napi]
    pub fn can_double_dice(&self) -> napi::Result<bool> {
        self.inner.can_double_dice().map_err(thrown)
    }
    #[napi]
    pub fn to_expression(&self) -> napi::Result<String> {
        self.inner.to_expression().map_err(thrown)
    }
    #[napi]
    pub fn to_pmf(&self, eps: f64) -> napi::Result<NativePmf> {
        self.inner
            .to_pmf_shared(eps)
            .map(NativePmf::wrap_shared)
            .map_err(thrown)
    }
    #[napi]
    pub fn pmf(&self) -> napi::Result<NativePmf> {
        self.inner
            .to_pmf_shared(0.0)
            .map(NativePmf::wrap_shared)
            .map_err(thrown)
    }
    #[napi]
    pub fn to_query(&self, eps: f64) -> napi::Result<NativeQuery> {
        self.inner
            .to_query_with(eps)
            .map(NativeQuery::wrap)
            .map_err(thrown)
    }

    // ---- chaining ----
    #[napi]
    pub fn d(&self, sides: Option<f64>) -> napi::Result<NativeRoll> {
        r(self.inner.d_opt(sides))
    }
    #[napi]
    pub fn plus_dice(&self, count: f64, die: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.plus_dice(count, &die.inner))
    }
    #[napi]
    pub fn minus_dice(&self, count: f64, die: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.minus_dice(count, &die.inner))
    }
    #[napi]
    pub fn scale_result(
        &self,
        numerator: f64,
        denominator: f64,
        rounding_name: String,
    ) -> napi::Result<NativeRoll> {
        r(self
            .inner
            .scale_result(numerator, denominator, rounding(&rounding_name)?))
    }
    /// `rerollUpTo(budget, { rolls, rolledOnce })`.
    #[napi]
    pub fn reroll_up_to(
        &self,
        budget: f64,
        rolls: Option<f64>,
        rolled_once: Option<&NativeRoll>,
    ) -> napi::Result<NativeRoll> {
        let options = RollRerollUpToOptions {
            rolls,
            rolled_once: rolled_once.map(|x| x.inner.clone()),
        };
        r(self.inner.reroll_up_to(budget, Some(&options)))
    }

    #[napi]
    pub fn d4(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d4())
    }

    #[napi]
    pub fn d6(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d6())
    }

    #[napi]
    pub fn d8(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d8())
    }

    #[napi]
    pub fn d10(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d10())
    }

    #[napi]
    pub fn d12(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d12())
    }

    #[napi]
    pub fn d20(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d20())
    }

    #[napi]
    pub fn d100(&self) -> napi::Result<NativeRoll> {
        r(self.inner.d100())
    }

    #[napi]
    pub fn with_advantage(&self) -> napi::Result<NativeRoll> {
        r(self.inner.with_advantage())
    }

    #[napi]
    pub fn with_disadvantage(&self) -> napi::Result<NativeRoll> {
        r(self.inner.with_disadvantage())
    }

    #[napi]
    pub fn with_elven_accuracy(&self) -> napi::Result<NativeRoll> {
        r(self.inner.with_elven_accuracy())
    }

    #[napi]
    pub fn double_dice(&self) -> napi::Result<NativeRoll> {
        r(self.inner.double_dice())
    }

    #[napi]
    pub fn always_hits(&self) -> napi::Result<NativeRoll> {
        r(self.inner.always_hits())
    }

    #[napi]
    pub fn always_crits(&self) -> napi::Result<NativeRoll> {
        r(self.inner.always_crits())
    }

    #[napi]
    pub fn ranged(&self) -> napi::Result<NativeRoll> {
        r(self.inner.ranged())
    }

    #[napi]
    pub fn melee(&self) -> napi::Result<NativeRoll> {
        r(self.inner.melee())
    }

    #[napi]
    pub fn pinned(&self) -> napi::Result<NativeRoll> {
        r(self.inner.pinned())
    }

    #[napi]
    pub fn copy(&self) -> napi::Result<NativeRoll> {
        r(self.inner.copy())
    }

    #[napi]
    pub fn half(&self) -> napi::Result<NativeRoll> {
        r(self.inner.half())
    }

    #[napi]
    pub fn plus(&self, modifier: f64) -> napi::Result<NativeRoll> {
        r(self.inner.plus(modifier))
    }

    #[napi]
    pub fn minus(&self, modifier: f64) -> napi::Result<NativeRoll> {
        r(self.inner.minus(modifier))
    }

    #[napi]
    pub fn reroll(&self, value: f64) -> napi::Result<NativeRoll> {
        r(self.inner.reroll(value))
    }

    #[napi]
    pub fn explode(&self, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.explode(count))
    }

    #[napi]
    pub fn explode_pool(&self, budget: f64) -> napi::Result<NativeRoll> {
        r(self.inner.explode_pool(budget))
    }

    #[napi]
    pub fn minimum(&self, val: f64) -> napi::Result<NativeRoll> {
        r(self.inner.minimum(val))
    }

    #[napi]
    pub fn best_of(&self, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.best_of(count))
    }

    #[napi]
    pub fn add_roll(&self, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.add_roll(count))
    }

    #[napi]
    pub fn scale_dice(&self, scale: f64) -> napi::Result<NativeRoll> {
        r(self.inner.scale_dice(scale))
    }

    #[napi]
    pub fn crit_on(&self, crit_threshold: f64) -> napi::Result<NativeRoll> {
        r(self.inner.crit_on(crit_threshold))
    }

    #[napi]
    pub fn times(&self, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.times(count))
    }

    #[napi]
    pub fn max_of(&self, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.max_of(count))
    }

    #[napi]
    pub fn keep_highest(&self, total: f64, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.keep_highest(total, count))
    }

    #[napi]
    pub fn keep_lowest(&self, total: f64, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.keep_lowest(total, count))
    }

    #[napi]
    pub fn keep_highest_all(&self, total: f64, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.keep_highest_all(total, count))
    }

    #[napi]
    pub fn keep_lowest_all(&self, total: f64, count: f64) -> napi::Result<NativeRoll> {
        r(self.inner.keep_lowest_all(total, count))
    }

    #[napi]
    pub fn plus_roll(&self, other: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.plus_roll(&other.inner))
    }

    #[napi]
    pub fn minus_roll(&self, other: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.minus_roll(&other.inner))
    }

    #[napi]
    pub fn add(&self, other: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.add(&other.inner))
    }

    #[napi]
    pub fn with_bonus(&self, other: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.with_bonus(&other.inner))
    }

    #[napi]
    pub fn max_of_roll(&self, other: &NativeRoll) -> napi::Result<NativeRoll> {
        r(self.inner.max_of_roll(&other.inner))
    }
}
