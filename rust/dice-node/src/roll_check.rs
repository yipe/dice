//! `NativeRoll` methods of attack and save checks (`ac.rs`, `dc.rs` and the always-hit/always-crit
//! kinds of `roll.rs`).

use napi::bindgen_prelude::Function;
use napi_derive::napi;
use yipe_dice::builder::roll::{AttackConfig, RollBuilder};
use yipe_dice::turn::context::PenaltyDice;

use crate::attack::NativeAttack;
use crate::conv::{self, JsArg, JsPenaltyDice, JsRowContext, JsSampledDie};
use crate::rng::JsRng;
use crate::roll::{JsAttackConfig, NativeRoll, r};
use crate::save::NativeSave;
use crate::thrown;

fn attack_config_in(c: &JsAttackConfig) -> napi::Result<AttackConfig> {
    Ok(AttackConfig {
        crit_threshold: c.crit_threshold,
        ac: c.ac,
        range: match &c.range {
            Some(s) => Some(conv::attack_range(s).map_err(thrown)?),
            None => None,
        },
        miss_reroll: match &c.miss_reroll {
            Some(s) => Some(conv::miss_reroll_mode(s).map_err(thrown)?),
            None => None,
        },
    })
}

#[napi(object)]
pub struct JsSaveConfig {
    pub dc: f64,
    pub ability: Option<String>,
    pub auto_fail: bool,
}

#[napi(object)]
pub struct JsSaveProbabilities {
    pub p_success: f64,
    pub p_fail: f64,
}

#[napi(object)]
pub struct JsCheckSample {
    pub check: Vec<JsSampledDie>,
    pub total: f64,
    pub failed: bool,
}

#[napi]
impl NativeRoll {
    /// `new AlwaysHitBuilder(base, attackConfig)`.
    #[napi(factory)]
    pub fn always_hit_with(base: &NativeRoll, attack: JsAttackConfig) -> napi::Result<NativeRoll> {
        r(RollBuilder::always_hit_with(
            &base.inner,
            attack_config_in(&attack)?,
        ))
    }
    /// `new AlwaysCritBuilder(base, attackConfig, fromAlwaysHit)`.
    #[napi(factory)]
    pub fn always_crit_with(
        base: &NativeRoll,
        attack: JsAttackConfig,
        from_always_hit: bool,
    ) -> napi::Result<NativeRoll> {
        r(RollBuilder::always_crit_with(
            &base.inner,
            attack_config_in(&attack)?,
            from_always_hit,
        ))
    }

    /// `onHit(...args)` of an always-hit, always-crit or AC check.
    #[napi]
    pub fn on_hit(&self, args: Vec<JsArg<'_>>) -> napi::Result<NativeAttack> {
        self.inner
            .on_hit_args(&conv::args(args))
            .map(NativeAttack::wrap)
            .map_err(thrown)
    }

    // ---- AC ----
    #[napi]
    pub fn ac(&self, target_ac: f64) -> napi::Result<NativeRoll> {
        r(self.inner.ac(target_ac))
    }
    /// 2 or 3 on an AC check, else undefined.
    #[napi]
    pub fn advantage_dice(&self) -> Option<f64> {
        self.inner.advantage_dice().map(conv::advantage_dice)
    }
    #[napi]
    pub fn three_dice_advantage(&self) -> napi::Result<NativeRoll> {
        r(self.inner.three_dice_advantage())
    }
    #[napi]
    pub fn reroll_misses(&self, mode: String) -> napi::Result<NativeRoll> {
        r(self
            .inner
            .reroll_misses(conv::miss_reroll_mode(&mode).map_err(thrown)?))
    }
    #[napi]
    pub fn copy_with_ac(&self, ac: Option<f64>) -> napi::Result<NativeRoll> {
        r(self.inner.copy_with_ac(ac))
    }

    // ---- DC ----
    #[napi]
    pub fn dc(&self, save_dc: f64) -> napi::Result<NativeRoll> {
        r(self.inner.dc(save_dc))
    }
    #[napi]
    pub fn save_config(&self) -> Option<JsSaveConfig> {
        self.inner.save_config().map(|c| JsSaveConfig {
            dc: c.dc,
            ability: c.ability.map(|a| conv::ability_str(a).to_string()),
            auto_fail: c.auto_fail,
        })
    }
    #[napi]
    pub fn save_dc(&self) -> Option<f64> {
        self.inner.save_dc()
    }
    #[napi]
    pub fn save_ability(&self) -> Option<String> {
        self.inner
            .save_ability()
            .map(|a| conv::ability_str(a).to_string())
    }
    #[napi]
    pub fn auto_fail(&self) -> bool {
        self.inner.auto_fail()
    }
    #[napi]
    pub fn ability(&self, name: String) -> napi::Result<NativeRoll> {
        r(self.inner.ability(&name))
    }
    #[napi]
    pub fn always_fails(&self) -> napi::Result<NativeRoll> {
        r(self.inner.always_fails())
    }
    #[napi]
    pub fn is_plain_save(&self) -> bool {
        self.inner.is_plain_save()
    }
    /// `DCBuilder.rolledIn({ rollType, autoFail, penaltyDice })`.
    #[napi]
    pub fn rolled_in(
        &self,
        roll_type: String,
        auto_fail: bool,
        penalty_dice: Vec<JsPenaltyDice>,
    ) -> napi::Result<NativeRoll> {
        let dice: Vec<PenaltyDice> = penalty_dice
            .iter()
            .map(|p| PenaltyDice {
                count: p.count,
                sides: p.sides,
            })
            .collect();
        let context = yipe_dice::builder::dc::RolledIn {
            roll_type: conv::roll_type(&roll_type).map_err(thrown)?,
            auto_fail,
            penalty_dice: &dice,
        };
        r(self.inner.rolled_in(&context))
    }
    /// `DCBuilder.inContext(context)`: undefined when the context changes nothing.
    #[napi]
    pub fn in_context(&self, context: JsRowContext) -> napi::Result<Option<NativeRoll>> {
        self.inner
            .in_context(&context.to_rust()?)
            .map(|o| o.map(NativeRoll::wrap))
            .map_err(thrown)
    }
    /// `onSaveFailure(...args)` with a damage roll.
    #[napi]
    pub fn on_save_failure(&self, args: Vec<JsArg<'_>>) -> napi::Result<NativeSave> {
        self.inner
            .on_save_failure_args(&conv::args(args))
            .map(NativeSave::wrap)
            .map_err(thrown)
    }
    #[napi]
    pub fn save_probabilities(&self) -> napi::Result<JsSaveProbabilities> {
        let p = self.inner.save_probabilities().map_err(thrown)?;
        Ok(JsSaveProbabilities {
            p_success: p.p_success,
            p_fail: p.p_fail,
        })
    }

    // ---- sampling ----
    /// `sample(rng)`.
    #[napi]
    pub fn sample(
        &self,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
    ) -> napi::Result<conv::JsRollSample> {
        let mut rng = JsRng::new(die, chance);
        let out = self.inner.sample(&mut rng);
        rng.finish(out).map(|s| (&s).into())
    }
    /// `sampleCheck(rng)` of an always-hit / always-crit check.
    #[napi]
    pub fn sample_check(
        &self,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
    ) -> napi::Result<conv::JsCheckDice> {
        let mut rng = JsRng::new(die, chance);
        let out = self.inner.sample_check(&mut rng);
        rng.finish(out).map(|s| (&s).into())
    }
    /// `DCBuilder.sampleCheck(rng, context?)`.
    #[napi]
    pub fn sample_dc_check(
        &self,
        die: Function<f64, f64>,
        chance: Function<f64, bool>,
        context: Option<JsRowContext>,
    ) -> napi::Result<JsCheckSample> {
        let context = match context {
            Some(c) => Some(c.to_rust()?),
            None => None,
        };
        let mut rng = JsRng::new(die, chance);
        let out = self.inner.sample_dc_check(&mut rng, context.as_ref());
        rng.finish(out).map(|s| JsCheckSample {
            check: conv::dice_out(&s.check),
            total: s.total,
            failed: s.failed,
        })
    }
}
