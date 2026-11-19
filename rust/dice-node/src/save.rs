//! `NativeSave`: a Rust `SaveBuilder` handle (TS `SaveBuilder`, `ts/builder/save.ts`). One native
//! call per facade method; derived saves come back as new handles.
//!
//! `sample` calls back into JS synchronously through `JsRng` (see `rng.rs`): a throw in a callback
//! is held and rethrown after the Rust call finishes.

use napi::bindgen_prelude::{ClassInstance, Function};
use napi_derive::napi;
use yipe_dice::builder::dc::FailurePart;
use yipe_dice::builder::save::{SaveBuilder, SaveOutcome};

use crate::conv::{self, JsArg, JsRowCheck, JsRowContext, JsSampledDie};
use crate::effects::NativeLasting;
use crate::pmf::{NativePmf, NativeQuery};
use crate::rng::JsRng;
use crate::roll::NativeRoll;
use crate::{DiceError, thrown};

#[napi]
pub struct NativeSave {
    pub(crate) inner: SaveBuilder,
}

impl NativeSave {
    pub(crate) fn wrap(inner: SaveBuilder) -> Self {
        Self { inner }
    }
}

fn s(x: Result<SaveBuilder, DiceError>) -> napi::Result<NativeSave> {
    x.map(NativeSave::wrap).map_err(thrown)
}

/// `SaveSample`.
#[napi(object)]
pub struct JsSaveSample {
    pub outcome: String,
    pub check: Vec<JsSampledDie>,
    pub damage: Vec<JsSampledDie>,
    pub total: f64,
}

/// `SaveResolution` (output only: handles cannot be read back from JS objects).
#[napi(object, object_from_js = false)]
pub struct JsSaveResolution {
    pub pmf: NativePmf,
    pub check: NativePmf,
    pub save_fail: NativePmf,
    pub save_success: NativePmf,
    pub weights: JsSaveWeights,
}

#[napi(object)]
pub struct JsSaveWeights {
    pub success: f64,
    pub fail: f64,
}

#[napi]
impl NativeSave {
    /// `new SaveBuilder(check, failureEffect, saveOutcome)` with `saveOutcome` "normal" or "half".
    #[napi(factory)]
    pub fn from_parts(
        check: &NativeRoll,
        failure_effect: Option<&NativeRoll>,
        half: bool,
    ) -> NativeSave {
        let outcome = if half {
            SaveOutcome::Half
        } else {
            SaveOutcome::Normal
        };
        Self::wrap(SaveBuilder::new(
            check.inner.clone(),
            failure_effect.map(|f| f.inner.clone()),
            outcome,
            Vec::new(),
        ))
    }
    /// `new SaveBuilder(check, failureEffect, saveOutcome)` with an `onSaveSuccess` payload.
    #[napi(factory)]
    pub fn from_payload(
        check: &NativeRoll,
        failure_effect: Option<&NativeRoll>,
        success: &NativeRoll,
    ) -> NativeSave {
        let outcome = SaveOutcome::Payload(success.inner.clone());
        Self::wrap(SaveBuilder::new(
            check.inner.clone(),
            failure_effect.map(|f| f.inner.clone()),
            outcome,
            Vec::new(),
        ))
    }

    // ---- parts ----
    #[napi]
    pub fn check(&self) -> NativeRoll {
        NativeRoll::wrap(self.inner.check.clone())
    }
    #[napi]
    pub fn failure_effect(&self) -> Option<NativeRoll> {
        self.inner
            .failure_effect()
            .map(|r| NativeRoll::wrap(r.clone()))
    }
    /// "normal", "half" or "payload" (see `success_payload`).
    #[napi]
    pub fn save_outcome(&self) -> &'static str {
        match self.inner.save_outcome() {
            SaveOutcome::Normal => "normal",
            SaveOutcome::Half => "half",
            SaveOutcome::Payload(_) => "payload",
        }
    }
    #[napi]
    pub fn success_payload(&self) -> Option<NativeRoll> {
        match self.inner.save_outcome() {
            SaveOutcome::Payload(r) => Some(NativeRoll::wrap(r.clone())),
            _ => None,
        }
    }

    // ---- chaining ----
    #[napi]
    pub fn save_half(&self) -> napi::Result<NativeSave> {
        s(self.inner.save_half())
    }
    #[napi]
    pub fn on_save_success(&self, args: Vec<JsArg<'_>>) -> napi::Result<NativeSave> {
        s(self.inner.on_save_success_args(&conv::args(args)))
    }
    #[napi]
    pub fn ability(&self, name: String) -> napi::Result<NativeSave> {
        s(self.inner.ability(&name))
    }
    #[napi]
    pub fn always_fails(&self) -> napi::Result<NativeSave> {
        s(self.inner.always_fails())
    }
    #[napi]
    pub fn pinned(&self) -> napi::Result<NativeSave> {
        s(self.inner.pinned())
    }

    // ---- turn context ----
    #[napi]
    pub fn row_check(&self) -> JsRowCheck {
        (&self.inner.row_check()).into()
    }
    #[napi]
    pub fn under(&self, context: JsRowContext, eps: f64) -> napi::Result<NativePmf> {
        self.inner
            .under(&context.to_rust()?, eps)
            .map(NativePmf::wrap)
            .map_err(thrown)
    }
    /// `rollUnder(context)`; undefined when the facade's `this` already is that save (a context that
    /// changes nothing and no vulnerable doubling to bake in).
    #[napi]
    pub fn roll_under(&self, context: JsRowContext) -> napi::Result<Option<NativeSave>> {
        let context = context.to_rust()?;
        let unchanged = self
            .inner
            .check
            .in_context(&context)
            .map_err(thrown)?
            .is_none();
        if unchanged && !context.vulnerable {
            return Ok(None);
        }
        self.inner
            .roll_under(&context)
            .map(|x| Some(NativeSave::wrap(x)))
            .map_err(thrown)
    }

    // ---- sampling ----
    /// `sample(rng, context?)`.
    #[napi]
    pub fn sample(
        &self,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
        context: Option<JsRowContext>,
    ) -> napi::Result<JsSaveSample> {
        let context = match context {
            Some(c) => Some(c.to_rust()?),
            None => None,
        };
        let mut rng = JsRng::new(die, chance);
        let out = self.inner.sample(&mut rng, context.as_ref());
        let out = rng.finish(out)?;
        Ok(JsSaveSample {
            outcome: out.outcome.as_str().to_string(),
            check: conv::dice_out(&out.check),
            damage: conv::dice_out(&out.damage),
            total: out.total,
        })
    }

    // ---- evaluation ----
    #[napi]
    pub fn to_expression(&self) -> napi::Result<String> {
        self.inner.to_expression().map_err(thrown)
    }
    #[napi]
    pub fn resolve(&self, eps: f64) -> napi::Result<JsSaveResolution> {
        let r = self.inner.resolve(eps).map_err(thrown)?;
        Ok(JsSaveResolution {
            pmf: NativePmf::wrap(r.pmf),
            check: NativePmf::wrap(r.check),
            save_fail: NativePmf::wrap(r.save_fail),
            save_success: NativePmf::wrap(r.save_success),
            weights: JsSaveWeights {
                success: r.weights.success,
                fail: r.weights.fail,
            },
        })
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
    pub fn mean(&self) -> napi::Result<f64> {
        self.inner.mean().map_err(thrown)
    }
    #[napi]
    pub fn to_query(&self, eps: f64) -> napi::Result<NativeQuery> {
        self.inner
            .to_query_with(eps)
            .map(NativeQuery::wrap)
            .map_err(thrown)
    }
}

#[napi]
impl NativeRoll {
    /// `onSaveFailure(effects)`: effects with a lifetime beside at most one damage argument.
    /// `grants` are the `Lasting` parts, `damage` the others (each read as `onSaveFailure`'s roll).
    #[napi]
    pub fn on_save_failure_effects(
        &self,
        grants: Vec<ClassInstance<NativeLasting>>,
        damage: Vec<JsArg<'_>>,
    ) -> napi::Result<NativeSave> {
        let mut parts: Vec<FailurePart> = grants
            .iter()
            .map(|g| FailurePart::Effect(g.inner.clone()))
            .collect();
        parts.extend(conv::args(damage).into_iter().map(FailurePart::Damage));
        s(self.inner.on_save_failure_effects(&parts))
    }
}
