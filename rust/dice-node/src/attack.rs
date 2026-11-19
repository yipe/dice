//! `NativeAttack`: a Rust `AttackBuilder` handle (TS `AttackBuilder`), one native call per facade
//! method.
//!
//! Closures from JS: `sample*` take the `(die, chance)` pair of `rng.rs`. `withCheck(fn)` takes `fn`
//! as a `Function` called once, synchronously, inside the Rust `with_check`, with the attack's
//! `Check` (the roll as a `NativeRoll`) and returning the next one; a throw in `fn` is held and
//! rethrown, unchanged, after the Rust call returns.
//!
//! `attached` is not read back: the facade keeps the list it built (a single `Lasting` stays single,
//! as in the TS) and sends each `onEveryHit`/`onAnyCrit`/`onFirstCrit` here only to keep the handle in step.

use napi::Env;
use napi::bindgen_prelude::{ClassInstance, Function, JavaScriptClassExt};
use napi_derive::napi;
use yipe_dice::builder::attack::{
    AttackBuilder, AttackOutcome, AttackPayloadSample, AttackSample, CritEffect, RerollPoolSpec,
};
use yipe_dice::builder::sample::SampledDie;
use yipe_dice::builder::types::{AdvantageDice, AttackResolution, Check, MissRerollMode};
use yipe_dice::turn::context::{ContextualSource, RowContext};

use crate::conv::{self, JsArg, JsRollSample, JsRowCheck, JsRowContext, JsSampledDie};
use crate::effects::{JsConditionGate, JsGrants, gate_in, grants_in};
use crate::pmf::NativePmf;
use crate::rng::JsRng;
use crate::roll::NativeRoll;
use crate::{DiceError, err, thrown};

#[napi]
pub struct NativeAttack {
    pub(crate) inner: AttackBuilder,
}

impl NativeAttack {
    pub(crate) fn wrap(inner: AttackBuilder) -> Self {
        Self { inner }
    }
}

fn a(x: Result<AttackBuilder, DiceError>) -> napi::Result<NativeAttack> {
    x.map(NativeAttack::wrap).map_err(thrown)
}

fn context_in(context: Option<JsRowContext>) -> napi::Result<Option<RowContext>> {
    context.map(|c| c.to_rust()).transpose()
}

fn outcome_in(s: &str) -> napi::Result<AttackOutcome> {
    match s {
        "hit" => Ok(AttackOutcome::Hit),
        "crit" => Ok(AttackOutcome::Crit),
        "miss" => Ok(AttackOutcome::Miss),
        _ => Err(err(format!("dice-node: unknown attack outcome {s:?}"))),
    }
}

fn die_in(d: &JsSampledDie) -> SampledDie {
    SampledDie {
        sides: d.sides,
        face: d.face,
        kept: d.kept,
        reroll: d.reroll == Some(true),
        miss_reroll: d.miss_reroll == Some(true),
    }
}

/// `AttackSample`; `payload` is absent on a miss.
#[napi(object)]
pub struct JsAttackSample {
    pub outcome: String,
    pub check: Vec<JsSampledDie>,
    pub damage: Vec<JsSampledDie>,
    pub total: f64,
    pub payload: Option<JsAttackPayload>,
}

/// `AttackPayloadSample`.
#[napi(object)]
pub struct JsAttackPayload {
    pub base: JsRollSample,
    pub separate: Vec<JsRollSample>,
    pub scale: f64,
}

impl From<&AttackPayloadSample> for JsAttackPayload {
    fn from(p: &AttackPayloadSample) -> Self {
        JsAttackPayload {
            base: (&p.base).into(),
            separate: p.separate.iter().map(JsRollSample::from).collect(),
            scale: f64::from(p.scale),
        }
    }
}

impl From<&AttackSample> for JsAttackSample {
    fn from(s: &AttackSample) -> Self {
        JsAttackSample {
            outcome: s.outcome.as_str().to_string(),
            check: conv::dice_out(&s.check),
            damage: conv::dice_out(&s.damage),
            total: s.total,
            payload: s.payload.as_ref().map(JsAttackPayload::from),
        }
    }
}

impl JsAttackSample {
    /// `first` of `sampleMissReroll`: only the outcome, check dice, damage and total are read.
    fn to_rust(&self) -> napi::Result<AttackSample> {
        Ok(AttackSample {
            outcome: outcome_in(&self.outcome)?,
            check: self.check.iter().map(die_in).collect(),
            damage: self.damage.iter().map(die_in).collect(),
            total: self.total,
            payload: None,
        })
    }
}

/// `Check`, with the roll as a native handle; the facade wraps it as a `RollBuilder`.
#[napi(object)]
pub struct JsCheck<'a> {
    pub roll: ClassInstance<'a, NativeRoll>,
    pub ac: f64,
    pub crit_threshold: f64,
    pub roll_type: String,
    pub advantage_dice: f64,
    pub crit_on_hit: bool,
    pub miss_reroll: Option<String>,
}

fn check_out<'a>(env: &'a Env, c: &Check) -> napi::Result<JsCheck<'a>> {
    Ok(JsCheck {
        roll: NativeRoll::wrap(c.roll.clone()).into_instance(env)?,
        ac: c.ac,
        crit_threshold: c.crit_threshold,
        roll_type: c.roll_type.as_str().to_string(),
        advantage_dice: conv::advantage_dice(c.advantage_dice),
        crit_on_hit: c.crit_on_hit,
        miss_reroll: c.miss_reroll.map(|m| m.as_str().to_string()),
    })
}

fn check_in(c: &JsCheck<'_>) -> napi::Result<Check> {
    Ok(Check {
        roll: c.roll.inner.clone(),
        ac: c.ac,
        crit_threshold: c.crit_threshold,
        roll_type: conv::roll_type(&c.roll_type).map_err(thrown)?,
        advantage_dice: if c.advantage_dice == 3.0 {
            AdvantageDice::Three
        } else {
            AdvantageDice::Two
        },
        crit_on_hit: c.crit_on_hit,
        miss_reroll: c
            .miss_reroll
            .as_deref()
            .map(conv::miss_reroll_mode)
            .transpose()
            .map_err(thrown)?,
    })
}

#[napi(object)]
pub struct JsRerollPool {
    pub budget: f64,
    pub rolls: f64,
}

impl From<RerollPoolSpec> for JsRerollPool {
    fn from(s: RerollPoolSpec) -> Self {
        JsRerollPool {
            budget: s.budget,
            rolls: s.rolls,
        }
    }
}

#[napi(object)]
pub struct JsAttackWeights {
    pub hit: f64,
    pub crit: f64,
    pub miss: f64,
}

/// `AttackResolution`: every PMF a native handle.
#[napi(object, object_from_js = false)]
pub struct JsAttackResolution {
    pub pmf: NativePmf,
    pub check: NativePmf,
    pub hit: NativePmf,
    pub crit: NativePmf,
    pub miss: NativePmf,
    pub hit_base: NativePmf,
    pub crit_base: NativePmf,
    pub hit_separate: NativePmf,
    pub crit_separate: NativePmf,
    pub weights: JsAttackWeights,
    /// No separate or natural-20 channel: `hit` is `hitBase`, and `crit` is `critBase` (the same PMF in the TS).
    pub no_channels: bool,
}

impl JsAttackResolution {
    fn new(attack: &AttackBuilder, r: AttackResolution) -> Self {
        let no_channels =
            attack.separate_damage().is_empty() && attack.natural20_damage().is_empty();
        JsAttackResolution {
            no_channels,
            ..JsAttackResolution::from(r)
        }
    }
}

impl From<AttackResolution> for JsAttackResolution {
    fn from(r: AttackResolution) -> Self {
        JsAttackResolution {
            pmf: NativePmf::wrap(r.pmf),
            check: NativePmf::wrap(r.check),
            hit: NativePmf::wrap(r.hit),
            crit: NativePmf::wrap(r.crit),
            miss: NativePmf::wrap(r.miss),
            hit_base: NativePmf::wrap(r.hit_base),
            crit_base: NativePmf::wrap(r.crit_base),
            hit_separate: NativePmf::wrap(r.hit_separate),
            crit_separate: NativePmf::wrap(r.crit_separate),
            weights: JsAttackWeights {
                hit: r.weights.hit,
                crit: r.weights.crit,
                miss: r.weights.miss,
            },
            no_channels: false,
        }
    }
}

#[napi(object)]
pub struct JsAttackProbabilities {
    pub p_success: f64,
    pub p_hit: f64,
    pub p_crit: f64,
    pub p_miss: f64,
}

/// `DiceMatchInfo.matchProbabilityByDamage` as parallel arrays, in map order.
#[napi(object)]
pub struct JsMatchInfo {
    pub damages: Vec<f64>,
    pub probabilities: Vec<f64>,
}

#[napi(object)]
pub struct JsDiceMatchInfo {
    pub hit: Option<JsMatchInfo>,
    pub crit: Option<JsMatchInfo>,
}

#[napi(object)]
pub struct JsDiceMatchRefusals {
    pub hit: Option<String>,
    pub crit: Option<String>,
}

#[napi(object)]
pub struct JsDealt {
    pub hit: f64,
    pub crit: f64,
}

fn match_info_out(i: yipe_dice::common::DiceMatchInfo) -> JsMatchInfo {
    let mut damages = Vec::new();
    let mut probabilities = Vec::new();
    for (d, p) in &i.match_probability_by_damage {
        damages.push(d.0);
        probabilities.push(*p);
    }
    JsMatchInfo {
        damages,
        probabilities,
    }
}

#[napi]
impl NativeAttack {
    /// `new AttackBuilder(check, hitEffect)`.
    #[napi(factory)]
    pub fn create(check: &NativeRoll, damage: &NativeRoll) -> NativeAttack {
        NativeAttack::wrap(AttackBuilder::new(
            check.inner.clone(),
            damage.inner.clone(),
        ))
    }

    /// `new AttackBuilder(check)`: no payloads at all.
    #[napi(factory)]
    pub fn create_without_damage(check: &NativeRoll) -> NativeAttack {
        NativeAttack::wrap(AttackBuilder::without_damage(check.inner.clone()))
    }

    // ---- fields ----
    #[napi]
    pub fn check(&self) -> NativeRoll {
        NativeRoll::wrap(self.inner.check.clone())
    }
    #[napi]
    pub fn hit_effect(&self) -> Option<NativeRoll> {
        self.inner.hit_effect().map(|r| NativeRoll::wrap(r.clone()))
    }
    /// `"auto"` (`critEffect` undefined), `"none"` (`noCrit()`, null) or `"roll"` (`critEffectRoll()`).
    #[napi]
    pub fn crit_effect_kind(&self) -> String {
        match self.inner.crit_effect() {
            CritEffect::Auto => "auto",
            CritEffect::None => "none",
            CritEffect::Roll(_) => "roll",
        }
        .to_string()
    }
    #[napi]
    pub fn crit_effect_roll(&self) -> Option<NativeRoll> {
        match self.inner.crit_effect() {
            CritEffect::Roll(r) => Some(NativeRoll::wrap(r.clone())),
            _ => None,
        }
    }
    #[napi]
    pub fn miss_effect(&self) -> Option<NativeRoll> {
        self.inner
            .miss_effect()
            .map(|r| NativeRoll::wrap(r.clone()))
    }
    #[napi]
    pub fn separate_damage(&self) -> Vec<NativeRoll> {
        self.inner
            .separate_damage()
            .iter()
            .map(|r| NativeRoll::wrap(r.clone()))
            .collect()
    }
    #[napi]
    pub fn natural20_damage(&self) -> Vec<NativeRoll> {
        self.inner
            .natural20_damage()
            .iter()
            .map(|r| NativeRoll::wrap(r.clone()))
            .collect()
    }
    #[napi]
    pub fn half_on_miss_flag(&self) -> bool {
        self.inner.half_on_miss_flag()
    }
    #[napi]
    pub fn reroll_pool(&self) -> Option<JsRerollPool> {
        self.inner.reroll_pool().map(JsRerollPool::from)
    }
    #[napi]
    pub fn landing_scale(&self) -> f64 {
        f64::from(self.inner.landing_scale())
    }
    #[napi]
    pub fn damage_type(&self) -> Option<String> {
        self.inner.damage_type.clone()
    }
    #[napi]
    pub fn tags(&self) -> Vec<String> {
        self.inner.tags.clone()
    }
    #[napi]
    pub fn crit_threshold(&self) -> napi::Result<f64> {
        self.inner.crit_threshold().map_err(thrown)
    }

    // ---- derived attacks ----
    #[napi]
    pub fn typed(&self, damage_type: String) -> napi::Result<NativeAttack> {
        a(self.inner.typed(&damage_type))
    }
    #[napi]
    pub fn tagged(&self, tags: Vec<String>) -> napi::Result<NativeAttack> {
        let refs: Vec<&str> = tags.iter().map(String::as_str).collect();
        a(self.inner.tagged(&refs))
    }
    #[napi]
    pub fn on_crit(&self, args: Vec<JsArg<'_>>) -> napi::Result<NativeAttack> {
        a(self.inner.on_crit(&conv::args(args)))
    }
    #[napi]
    pub fn on_miss(&self, args: Vec<JsArg<'_>>) -> napi::Result<NativeAttack> {
        a(self.inner.on_miss(&conv::args(args)))
    }
    #[napi]
    pub fn no_crit(&self) -> napi::Result<NativeAttack> {
        a(self.inner.no_crit())
    }
    #[napi]
    pub fn plus_separate_damage(&self, damage: &NativeRoll) -> NativeAttack {
        NativeAttack::wrap(self.inner.plus_separate_damage(damage.inner.clone()))
    }
    #[napi]
    pub fn plus_natural20_damage(&self, damage: &NativeRoll) -> napi::Result<NativeAttack> {
        a(self.inner.plus_natural20_damage(damage.inner.clone()))
    }
    #[napi]
    pub fn reroll_damage(&self, threshold: f64) -> napi::Result<NativeAttack> {
        a(self.inner.reroll_damage(threshold))
    }
    #[napi]
    pub fn minimum_damage_die(&self, minimum: f64) -> napi::Result<NativeAttack> {
        a(self.inner.minimum_damage_die(minimum))
    }
    #[napi]
    pub fn reroll_damage_up_to(
        &self,
        budget: f64,
        rolls: Option<f64>,
    ) -> napi::Result<NativeAttack> {
        a(self.inner.reroll_damage_up_to(budget, rolls))
    }
    /// `undefined` when the attack already has `halfOnMiss()` (the TS returns `this`).
    #[napi]
    pub fn half_on_miss(&self) -> napi::Result<Option<NativeAttack>> {
        let next = self.inner.half_on_miss().map_err(thrown)?;
        Ok((!self.inner.half_on_miss_flag()).then(|| NativeAttack::wrap(next)))
    }
    /// `undefined` for a check that always hits (it has no miss: the TS returns `this`).
    #[napi]
    pub fn reroll_misses(&self, mode: String) -> napi::Result<Option<NativeAttack>> {
        let mode = conv::miss_reroll_mode(&mode).map_err(thrown)?;
        let check = &self.inner.check;
        if check.is_always_hit() || check.from_always_hit() == Some(true) {
            return Ok(None);
        }
        self.inner
            .reroll_misses(mode)
            .map(|x| Some(NativeAttack::wrap(x)))
            .map_err(thrown)
    }
    /// `withCheck(fn)`: see the module comment.
    #[napi]
    pub fn with_check(
        &self,
        env: &Env,
        f: Function<'_, JsCheck<'_>, JsCheck<'_>>,
    ) -> napi::Result<NativeAttack> {
        let mut failure: Option<napi::Error> = None;
        let result = self.inner.with_check(|check| {
            let next = check_out(env, &check)
                .and_then(|c| f.call(c))
                .and_then(|n| check_in(&n));
            match next {
                Ok(next) => next,
                Err(e) => {
                    failure = Some(e);
                    check
                }
            }
        });
        match failure {
            Some(e) => Err(e),
            None => a(result),
        }
    }
    #[napi]
    pub fn ranged(&self) -> napi::Result<NativeAttack> {
        a(self.inner.ranged())
    }
    #[napi]
    pub fn melee(&self) -> napi::Result<NativeAttack> {
        a(self.inner.melee())
    }
    #[napi]
    pub fn pinned(&self) -> napi::Result<NativeAttack> {
        a(self.inner.pinned())
    }

    // ---- attached conditions ----
    #[napi]
    pub fn on_every_hit(
        &self,
        grants: JsGrants<'_>,
        gate: Option<JsConditionGate<'_>>,
    ) -> napi::Result<NativeAttack> {
        a(self
            .inner
            .on_every_hit_with(grants_in(grants), gate_in(gate)?))
    }
    #[napi]
    pub fn on_any_crit(
        &self,
        grants: JsGrants<'_>,
        gate: Option<JsConditionGate<'_>>,
    ) -> napi::Result<NativeAttack> {
        a(self
            .inner
            .on_any_crit_with(grants_in(grants), gate_in(gate)?))
    }
    #[napi]
    pub fn on_first_crit(
        &self,
        grants: JsGrants<'_>,
        gate: Option<JsConditionGate<'_>>,
    ) -> napi::Result<NativeAttack> {
        a(self
            .inner
            .on_first_crit_with(grants_in(grants), gate_in(gate)?))
    }

    // ---- row facts and contexts ----
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
    /// `undefined` when `context` changes nothing: the TS returns `this`.
    #[napi]
    pub fn roll_under(&self, context: JsRowContext) -> napi::Result<Option<NativeAttack>> {
        let context = context.to_rust()?;
        let own = self.inner.row_check();
        let unchanged = (if own.pinned {
            own.roll_type
        } else {
            context.roll_type
        }) == own.roll_type
            && (own.auto_hit || context.auto_hit) == own.auto_hit
            && (own.auto_crit || context.crit_on_hit) == own.auto_crit
            && (!context.vulnerable || self.inner.landing_scale() == 2);
        if unchanged {
            return Ok(None);
        }
        self.inner
            .roll_under(&context)
            .map(|x| Some(NativeAttack::wrap(x)))
            .map_err(thrown)
    }
    /// `dealt(type, context)`: only meaningful on a typed attack (`damageType()` is set).
    #[napi]
    pub fn dealt(&self, type_: String, context: JsRowContext) -> napi::Result<JsDealt> {
        let d =
            ContextualSource::dealt(&self.inner, &type_, &context.to_rust()?).map_err(thrown)?;
        Ok(JsDealt {
            hit: d.hit,
            crit: d.crit,
        })
    }
    #[napi]
    pub fn miss_rerolled(
        &self,
        mode: String,
        context: Option<JsRowContext>,
        eps: f64,
    ) -> napi::Result<NativePmf> {
        let mode: MissRerollMode = conv::miss_reroll_mode(&mode).map_err(thrown)?;
        let context = context_in(context)?;
        self.inner
            .miss_rerolled_shared(mode, context.as_ref(), eps)
            .map(NativePmf::wrap_shared)
            .map_err(thrown)
    }

    // ---- sampling ----
    #[napi]
    pub fn sample(
        &self,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
        context: Option<JsRowContext>,
    ) -> napi::Result<JsAttackSample> {
        let context = context_in(context)?;
        let mut rng = JsRng::new(die, chance);
        let out = self.inner.sample(&mut rng, context.as_ref());
        rng.finish(out).map(|s| (&s).into())
    }
    #[napi]
    pub fn sample_miss_reroll(
        &self,
        first: JsAttackSample,
        mode: String,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
        context: Option<JsRowContext>,
    ) -> napi::Result<JsAttackSample> {
        let first = first.to_rust()?;
        let mode = conv::miss_reroll_mode(&mode).map_err(thrown)?;
        let context = context_in(context)?;
        let mut rng = JsRng::new(die, chance);
        let out = self
            .inner
            .sample_miss_reroll(first, mode, &mut rng, context.as_ref());
        rng.finish(out).map(|s| (&s).into())
    }
    #[napi]
    pub fn sample_payload(
        &self,
        outcome: String,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
        context: Option<JsRowContext>,
        natural20: bool,
    ) -> napi::Result<JsAttackPayload> {
        let outcome = if outcome == "crit" {
            AttackOutcome::Crit
        } else {
            AttackOutcome::Hit
        };
        let context = context_in(context)?;
        let mut rng = JsRng::new(die, chance);
        let out = self
            .inner
            .sample_payload(outcome, &mut rng, context.as_ref(), natural20);
        rng.finish(out).map(|p| (&p).into())
    }

    // ---- resolution ----
    #[napi]
    pub fn to_expression(&self) -> napi::Result<String> {
        self.inner.to_expression().map_err(thrown)
    }
    #[napi]
    pub fn resolve(&self, eps: f64) -> napi::Result<JsAttackResolution> {
        self.inner
            .resolve(eps)
            .map(|r| JsAttackResolution::new(&self.inner, r))
            .map_err(thrown)
    }
    /// `resolveProbabilities(check, eps)`: reads only `check`.
    #[napi]
    pub fn resolve_probabilities(
        check: &NativeRoll,
        eps: f64,
    ) -> napi::Result<JsAttackProbabilities> {
        let p = AttackBuilder::resolve_probabilities(&check.inner, eps).map_err(thrown)?;
        Ok(JsAttackProbabilities {
            p_success: p.p_success,
            p_hit: p.p_hit,
            p_crit: p.p_crit,
            p_miss: p.p_miss,
        })
    }
    #[napi]
    pub fn dice_match_info(&self, eps: f64) -> napi::Result<JsDiceMatchInfo> {
        let (hit, crit) = self.inner.dice_match_info(eps).map_err(thrown)?;
        Ok(JsDiceMatchInfo {
            hit: hit.map(match_info_out),
            crit: crit.map(match_info_out),
        })
    }
    #[napi]
    pub fn dice_match_refusals(&self) -> napi::Result<JsDiceMatchRefusals> {
        let (hit, crit) = self.inner.dice_match_refusals().map_err(thrown)?;
        Ok(JsDiceMatchRefusals { hit, crit })
    }
    #[napi]
    pub fn to_pmf(&self, eps: f64) -> napi::Result<NativePmf> {
        self.inner
            .to_pmf_shared(eps)
            .map(NativePmf::wrap_shared)
            .map_err(thrown)
    }
    #[napi]
    pub fn mean(&self) -> napi::Result<f64> {
        self.inner.mean().map_err(thrown)
    }
}
