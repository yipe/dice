//! Port of `src/builder/save.ts`: `SaveBuilder`, a save check with its payloads
//! (`d20.plus(5).dc(15).onSaveFailure(roll(8, d6)).saveHalf()`).
//!
//! # Shape
//! - `saveOutcome: "normal" | "half" | RollBuilder` is [`SaveOutcome`].
//! - `failScale: 1 | 2` is a `u8` (2 only for the save [`SaveBuilder::roll_under`] returns in a
//!   vulnerable context; every other derived builder is built with 1, as in TS).
//! - Implements [`ContextualSource`] (`IGNORES_JOINED` true) and [`CheckBuilder`]. The inherent
//!   `under`/`roll_under`/`resolve` take precedence over the trait methods of the same name; the
//!   trait impls delegate to them.
//! - `onSaveSuccess(...args)` is [`SaveBuilder::on_save_success`] over an [`Arg`] slice.
//!
//! # Skipped
//! `savePMFCache` and `clearSaveCache`; `cacheKey`.

use super::ast::pmf_from_roll_builder;
use super::attack::AttachedCondition;
use super::mixture::Mixture;
use super::nodes::Rounding;
use super::roll::{Arg, RollBuilder};
use super::sample::{SampledDie, scale_value};
use super::types::{CheckBuilder, Resolution, SaveResolution, SaveWeights};
use crate::common::Rng;
use crate::error::DiceError;
use crate::js::num_to_string;
use crate::pmf::cache::SAVE_CACHE;
use crate::turn::context::{ContextualSource, RollUnder, RowCheck, RowContext, RowKind};
use crate::{DiceQuery, EPS, Pmf};
use indexmap::IndexMap;
use std::sync::Arc;

/// `SaveOutcome | RollBuilder`: what a success deals: nothing (`Normal`), the failure payload
/// halved and floored (`Half`), or a payload of its own (`Payload`, see `onSaveSuccess`).
#[derive(Clone, Debug, PartialEq)]
pub enum SaveOutcome {
    Normal,
    Half,
    Payload(RollBuilder),
}

/// `SaveSample.outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveSampleOutcome {
    Fail,
    Pass,
}

impl SaveSampleOutcome {
    /// The TS string: `"save-fail"` or `"save-pass"`.
    pub fn as_str(self) -> &'static str {
        match self {
            SaveSampleOutcome::Fail => "save-fail",
            SaveSampleOutcome::Pass => "save-pass",
        }
    }
}

/// `SaveSample`: one roll of a save: the enemy's check dice, the payload dice and what landed.
#[derive(Clone, Debug, PartialEq)]
pub struct SaveSample {
    pub outcome: SaveSampleOutcome,
    pub check: Vec<SampledDie>,
    pub damage: Vec<SampledDie>,
    pub total: f64,
}

/// What a save's payload deals: a builder reads through `pmfFromRollBuilder` (at the library's
/// default epsilon, not `eps`), a parsed string through its own PMF.
fn payload_pmf(effect: &RollBuilder, eps: f64) -> Result<Pmf, DiceError> {
    if effect.is_parsed() {
        effect.to_pmf(eps)
    } else {
        pmf_from_roll_builder(effect, 0.0)
    }
}

/// `SaveBuilder`.
#[derive(Clone, Debug)]
pub struct SaveBuilder(Arc<SaveBuilderData>);

/// The data behind a [`SaveBuilder`]; shared by `Arc`, copied on write (ADR-019).
#[derive(Clone, Debug)]
pub struct SaveBuilderData {
    /// The DC check (a [`RollBuilder`] of kind DC).
    pub check: RollBuilder,
    /// What a failed save deals; none means a failure deals 0.
    failure_effect: Option<RollBuilder>,
    save_outcome: SaveOutcome,
    /// Conditions a failed save applies in a turn (see `DCBuilder.onSaveFailure`).
    pub attached: Vec<AttachedCondition>,
    fail_scale: u8,
}

impl SaveBuilder {
    /// `new SaveBuilder(check, failureEffect?, saveOutcome, attached)`.
    pub fn new(
        check: RollBuilder,
        failure_effect: Option<RollBuilder>,
        save_outcome: SaveOutcome,
        attached: Vec<AttachedCondition>,
    ) -> SaveBuilder {
        SaveBuilder::from(SaveBuilderData {
            check,
            failure_effect,
            save_outcome,
            attached,
            fail_scale: 1,
        })
    }

    /// A builder of the same parts with a new check (every derived builder is built unscaled).
    fn with_check(&self, check: RollBuilder) -> SaveBuilder {
        SaveBuilder::new(
            check,
            self.failure_effect.clone(),
            self.save_outcome.clone(),
            self.attached.clone(),
        )
    }

    /// The failure payload, if any.
    pub fn failure_effect(&self) -> Option<&RollBuilder> {
        self.failure_effect.as_ref()
    }

    /// The success outcome.
    pub fn save_outcome(&self) -> &SaveOutcome {
        &self.save_outcome
    }

    /// `saveHalf()`: a success deals the failure payload halved, rounded down. `Err` after
    /// `onSaveSuccess()`.
    pub fn save_half(&self) -> Result<SaveBuilder, DiceError> {
        if matches!(self.save_outcome, SaveOutcome::Payload(_)) {
            return Err(DiceError::error(
                "saveHalf() cannot be combined with onSaveSuccess(): the success branch can only be one or the other.",
            ));
        }
        Ok(SaveBuilder::new(
            self.check.clone(),
            self.failure_effect.clone(),
            SaveOutcome::Half,
            self.attached.clone(),
        ))
    }

    /// `onSaveSuccess(...args)`: a success deals a payload of its own, read as `fromArgs` reads it.
    /// A second call replaces the first; `Err` after `saveHalf()`.
    pub fn on_save_success(&self, arg: impl Into<Arg>) -> Result<SaveBuilder, DiceError> {
        self.on_save_success_args(&[arg.into()])
    }

    /// [`Self::on_save_success`] with several arguments (`RollBuilder.fromArgs(...args)`).
    pub fn on_save_success_args(&self, args: &[Arg]) -> Result<SaveBuilder, DiceError> {
        if self.save_outcome == SaveOutcome::Half {
            return Err(DiceError::error(
                "onSaveSuccess() cannot be combined with saveHalf(): the success branch can only be one or the other.",
            ));
        }
        Ok(SaveBuilder::new(
            self.check.clone(),
            self.failure_effect.clone(),
            SaveOutcome::Payload(RollBuilder::from_args(args)?),
            self.attached.clone(),
        ))
    }

    /// `ability(name)`: the save's ability (`"con"` or `"constitution"`).
    pub fn ability(&self, name: &str) -> Result<SaveBuilder, DiceError> {
        Ok(self.with_check(self.check.ability(name)?))
    }

    /// `alwaysFails()`: the save fails without rolling.
    pub fn always_fails(&self) -> Result<SaveBuilder, DiceError> {
        Ok(self.with_check(self.check.always_fails()?))
    }

    /// `pinned()`: no grant or condition in a turn changes this save's roll type.
    pub fn pinned(&self) -> Result<SaveBuilder, DiceError> {
        Ok(self.with_check(self.check.pinned()?))
    }

    /// `rowCheck`: what this save declares to a turn: its ability (when `ability()` set one), its
    /// own roll type, `pinned` and `alwaysFails()`.
    pub fn row_check(&self) -> RowCheck {
        let roll_type = self.check.roll_type();
        RowCheck {
            kind: RowKind::Save,
            range: None,
            ability: self.check.save_ability().map(|a| a.as_str().to_string()),
            roll_type,
            advantage_dice: if roll_type == crate::common::RollType::ElvenAccuracy {
                3
            } else {
                2
            },
            pinned: self.check.get_root_die_config().is_some_and(|c| c.pinned),
            auto_hit: false,
            auto_crit: false,
            auto_fail: self.check.auto_fail(),
        }
    }

    /// `under(context, eps)`: this save's outcome-labelled PMF re-derived in a turn's `context`.
    /// `context.roll_type` is the target's roll, taken literally unless pinned; `auto_fail` makes it
    /// fail without rolling; each penalty die is subtracted from the roll; `vulnerable` doubles the
    /// failure damage as a whole roll, the success unchanged; `joined` is ignored.
    pub fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.roll_under(context)?.to_pmf(eps)
    }

    /// [`SaveBuilder::under`] as the cached `Arc`: a context that changes nothing is this save's
    /// own cached PMF (TS: `rollUnder` returns `this`, whose `toPMF` is one object per key).
    pub fn under_shared(&self, context: &RowContext, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        self.roll_under(context)?.to_pmf_shared(eps)
    }

    /// `rollUnder(context)`: this save with its check rolled in `context`, with a vulnerable
    /// context's doubling baked in, so its PMF is exactly `under(context)`.
    pub fn roll_under(&self, context: &RowContext) -> Result<SaveBuilder, DiceError> {
        let mut save = self.in_context(context)?;
        if !context.vulnerable || save.fail_scale == 2 {
            return Ok(save);
        }
        save.fail_scale = 2;
        Ok(save)
    }

    /// `this` when `context` changes nothing, else this save with its check rolled in it.
    fn in_context(&self, context: &RowContext) -> Result<SaveBuilder, DiceError> {
        Ok(match self.check.in_context(context)? {
            None => self.clone(),
            Some(check) => self.with_check(check),
        })
    }

    /// `sample(rng, context?)`: one roll of this save as `under` weighs it: the enemy's check, then
    /// the failure payload's dice, then an `onSaveSuccess` payload on a pass. A pass still draws
    /// the failure dice. `context.vulnerable` doubles a failure's total and never redraws.
    pub fn sample(
        &self,
        rng: &mut dyn Rng,
        context: Option<&RowContext>,
    ) -> Result<SaveSample, DiceError> {
        let moved;
        let save = match context {
            Some(c) => {
                moved = self.in_context(c)?;
                &moved
            }
            None => self,
        };
        let drawn = save.check.sample_dc_check(rng, None)?;
        let mut damage: Vec<SampledDie> = Vec::new();
        let mut total = 0.0;
        if let Some(effect) = &save.failure_effect {
            let s = effect.sample(rng)?;
            total = s.total;
            damage.extend(s.dice);
        }
        if drawn.failed {
            if context.is_some_and(|c| c.vulnerable) || save.fail_scale == 2 {
                total = scale_value(total, 2.0, Rounding::Floor, 1.0);
            }
            return Ok(SaveSample {
                outcome: SaveSampleOutcome::Fail,
                check: drawn.check,
                damage,
                total,
            });
        }
        match &save.save_outcome {
            SaveOutcome::Half => Ok(SaveSample {
                outcome: SaveSampleOutcome::Pass,
                check: drawn.check,
                damage,
                total: scale_value(total, 0.5, Rounding::Floor, 1.0),
            }),
            SaveOutcome::Payload(effect) => {
                let s = effect.sample(rng)?;
                let mut all: Vec<SampledDie> = damage
                    .into_iter()
                    .map(|die| SampledDie { kept: false, ..die })
                    .collect();
                all.extend(s.dice);
                Ok(SaveSample {
                    outcome: SaveSampleOutcome::Pass,
                    check: drawn.check,
                    damage: all,
                    total: s.total,
                })
            }
            SaveOutcome::Normal => Ok(SaveSample {
                outcome: SaveSampleOutcome::Pass,
                check: drawn.check,
                damage,
                total: 0.0,
            }),
        }
    }

    /// `toExpression()`: the check, the failure payload, then `save half` or `save (payload)` for
    /// a success that deals damage. A save with no failure effect prints as its bare check, unless
    /// it has an `onSaveSuccess` payload (that prints `* (0)` for the failure).
    pub fn to_expression(&self) -> Result<String, DiceError> {
        let check_part = self.check.to_expression()?;
        let has_payload = matches!(self.save_outcome, SaveOutcome::Payload(_));
        if self.failure_effect.is_none() && !has_payload {
            return Ok(check_part);
        }
        let failure_part = match &self.failure_effect {
            Some(e) => e.to_expression()?,
            None => "0".to_string(),
        };
        let result = format!("{check_part} * ({failure_part})");
        Ok(match &self.save_outcome {
            SaveOutcome::Payload(success) => {
                format!("{result} save ({})", success.to_expression()?)
            }
            SaveOutcome::Half => format!("{result} save half"),
            SaveOutcome::Normal => result,
        })
    }

    /// `resolve(eps = EPS)`: the save's outcome: `check` is the DC check's own PMF, `weights` its
    /// success/failure chances, `save_fail` the failure payload and `save_success` what a success
    /// deals.
    pub fn resolve(&self, eps: f64) -> Result<SaveResolution, DiceError> {
        self.resolve_scaled(eps, self.fail_scale)
    }

    fn resolve_scaled(&self, eps: f64, fail_scale: u8) -> Result<SaveResolution, DiceError> {
        let probs = self.check.save_probabilities()?;
        // Library epsilon, not `eps`: with `eps` 0 the halved payload normalizes on an ulp of drift.
        let fail_pmf = match &self.failure_effect {
            Some(e) => payload_pmf(e, eps)?,
            None => Pmf::delta(0.0, EPS)?,
        };
        let mut success_pmf = Pmf::delta(0.0, eps)?;
        match &self.save_outcome {
            SaveOutcome::Half => success_pmf = fail_pmf.scale_damage(0.5, "floor", 1.0)?,
            SaveOutcome::Payload(effect) => success_pmf = payload_pmf(effect, eps)?,
            SaveOutcome::Normal => {}
        }
        let success_label = if self.save_outcome == SaveOutcome::Normal {
            "missNone"
        } else {
            "saveHalf"
        };
        let mut mixture = Mixture::new(eps);
        mixture.add(success_label, &success_pmf, probs.p_success);
        let scaled_fail = if fail_scale == 1 {
            fail_pmf.clone()
        } else {
            fail_pmf.scale_damage(f64::from(fail_scale), "floor", 1.0)?
        };
        mixture.add("saveFail", &scaled_fail, probs.p_fail);
        Ok(SaveResolution {
            pmf: mixture.build_pmf(eps)?,
            check: self.check.to_pmf(eps)?,
            save_fail: fail_pmf,
            save_success: success_pmf,
            weights: SaveWeights {
                success: probs.p_success,
                fail: probs.p_fail,
            },
        })
    }

    /// `toPMF(eps = 0)`.
    pub fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        self.to_pmf_shared(eps).map(|p| (*p).clone())
    }

    /// [`SaveBuilder::to_pmf`] through `savePMFCache` (keyed by [`SaveBuilder::cache_key`]),
    /// returning the cached `Arc`.
    pub fn to_pmf_shared(&self, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        let key = self.cache_key(eps);
        SAVE_CACHE.get_or_compute(key.as_deref(), || Ok(self.resolve(eps)?.pmf))
    }

    /// `cacheKey(eps)`: the DC check, the failure effect, the save outcome and the failure scale
    /// pin the resolved PMF; `None` when any roll in them has no key (a parsed effect).
    pub fn cache_key(&self, eps: f64) -> Option<String> {
        let check_key = self.check.cache_key()?;
        let fail_key = match &self.failure_effect {
            Some(e) => e.cache_key()?,
            None => String::new(),
        };
        let outcome_key = match &self.save_outcome {
            SaveOutcome::Payload(e) => format!("S{}", e.cache_key()?),
            SaveOutcome::Half => "half".to_string(),
            SaveOutcome::Normal => "normal".to_string(),
        };
        Some(format!(
            "{check_key}*F{fail_key}*O{outcome_key}*V{}*e{}",
            self.fail_scale,
            num_to_string(eps)
        ))
    }

    /// `pmf`: `toPMF()` with eps 0.
    pub fn pmf(&self) -> Result<Pmf, DiceError> {
        self.to_pmf(0.0)
    }

    /// `mean()`: expected damage of the save effect, from the exact PMF.
    pub fn mean(&self) -> Result<f64, DiceError> {
        Ok(self.pmf()?.mean())
    }

    /// `toQuery(eps = 0)`.
    pub fn to_query(&self) -> Result<DiceQuery, DiceError> {
        self.to_query_with(EPS)
    }

    /// [`Self::to_query`] pruning probabilities below `eps`.
    pub fn to_query_with(&self, eps: f64) -> Result<DiceQuery, DiceError> {
        Ok(DiceQuery::of(vec![self.to_pmf(eps)?]))
    }
}

impl CheckBuilder for SaveBuilder {
    fn resolve(&self, eps: Option<f64>) -> Result<Resolution, DiceError> {
        let r = SaveBuilder::resolve(self, eps.unwrap_or(EPS))?;
        Ok(Resolution {
            pmf: r.pmf,
            check: r.check,
            weights: IndexMap::from([
                ("success".to_string(), r.weights.success),
                ("fail".to_string(), r.weights.fail),
            ]),
        })
    }
    fn to_expression(&self) -> Result<String, DiceError> {
        SaveBuilder::to_expression(self)
    }
    fn pmf(&self) -> Result<Pmf, DiceError> {
        SaveBuilder::pmf(self)
    }
    fn mean(&self) -> Result<f64, DiceError> {
        SaveBuilder::mean(self)
    }
}

impl ContextualSource for SaveBuilder {
    fn row_check(&self) -> RowCheck {
        SaveBuilder::row_check(self)
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        SaveBuilder::under(self, context, eps)
    }
    fn under_shared(&self, context: &RowContext, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        SaveBuilder::under_shared(self, context, eps)
    }
    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        Ok(Some(RollUnder::Save(Box::new(SaveBuilder::roll_under(
            self, context,
        )?))))
    }
    fn ignores_joined(&self) -> bool {
        true
    }
}

impl From<SaveBuilderData> for SaveBuilder {
    fn from(data: SaveBuilderData) -> Self {
        SaveBuilder(Arc::new(data))
    }
}

impl std::ops::Deref for SaveBuilder {
    type Target = SaveBuilderData;
    fn deref(&self) -> &SaveBuilderData {
        &self.0
    }
}

/// Copy-on-write: mutation clones the data only while it is shared.
impl std::ops::DerefMut for SaveBuilder {
    fn deref_mut(&mut self) -> &mut SaveBuilderData {
        Arc::make_mut(&mut self.0)
    }
}
