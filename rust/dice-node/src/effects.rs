//! Turn effects (`src/turn/effects.ts`): `Transform`, `Modifiers`, `Lasting`/`Grant`, conditions,
//! save modifiers, `SaveGated`, and the gate a builder attaches to its grants.
//!
//! # Wire formats
//! - An `EffectSpec` (`Lasting.spec`) crosses as a JSON string. `count`, `sides` and `d20Penalty`
//!   (the only numbers in a spec) are strings when not finite, or `-0`: `"NaN"`, `"Infinity"`,
//!   `"-Infinity"`, `"-0"`. The facade decodes them by key. A `ConditionRule` crosses in as the same JSON.
//!   Unknown keys and unknown modifiers of a rule are dropped (the facade keeps the caller's rule for `spec`).
//! - A trigger save is a `NativeRoll` (a DC check) or a [`JsSaveSpec`] (`GrantSaveSpec` as plain
//!   data). A JS `failChance` function cannot run inside Rust: the facade keeps it in a table and
//!   sends its index as `failChanceKey`. Rust holds a `FailChance` that returns `Err` carrying the
//!   key ([`FAIL_CHANCE_TAG`]) so the key can be recovered from the error; evaluating one natively fails.
//!
//! No JS closure is called from this module. A DC check's `failChance` is evaluated by
//! [`grant_save_fail_chance`], in Rust, on the check handle.

use napi::bindgen_prelude::{ClassInstance, Either, Either3};
use napi_derive::napi;
use serde_json::{Map, Number, Value};
use yipe_dice::builder::attack::{ConditionGate, Grants};
use yipe_dice::turn::context::{PenaltyDice, RowContext};
use yipe_dice::turn::effects::{
    ConditionEffect, Grant, Lasting, Modifiers, SaveGated, SaveModifier, Transform, TriggerSave,
    TriggerSaves, condition, grant_save_spec, keep_best_damage, save, save_disadvantage,
    save_penalty, substitute_fields, vulnerability,
};
use yipe_dice::turn::types::{
    AttackRule, AttackRuleModifier, ConditionRule, ConditionUntil, EffectSpec, FailChance,
    GrantSaveSpec, OnEnd, OwnModifier, OwnRule, SaveLanding, SaveRuleModifier, SaveUntil,
    SubstitutePolicy,
};

use crate::conv::{self, JsPenaltyDice};
use crate::roll::NativeRoll;
use crate::{DiceError, err, thrown};

/// Prefix of the `Err` a JS-function `FailChance` returns; the rest is the table index.
const FAIL_CHANCE_TAG: &str = "dice-node: js failChance #";

// ---- JSON of EffectSpec ---------------------------------------------------------------------------

fn num(x: f64) -> Value {
    match Number::from_f64(x) {
        Some(n) if !(x == 0.0 && x.is_sign_negative()) => Value::Number(n),
        _ if x.is_nan() => Value::String("NaN".into()),
        _ if x == f64::INFINITY => Value::String("Infinity".into()),
        _ if x == f64::NEG_INFINITY => Value::String("-Infinity".into()),
        _ => Value::String("-0".into()),
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => match s.as_str() {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            _ => None,
        },
        _ => None,
    }
}

fn strings(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::String).collect())
}

fn modifiers<T: Copy>(list: &[T], name: fn(T) -> &'static str) -> Value {
    Value::Array(
        list.iter()
            .map(|m| Value::String(name(*m).to_string()))
            .collect(),
    )
}

fn own_name(m: OwnModifier) -> &'static str {
    match m {
        OwnModifier::Advantage => "advantage",
        OwnModifier::Disadvantage => "disadvantage",
    }
}

fn rule_json(rule: &ConditionRule) -> Value {
    let mut out = Map::new();
    if let Some(attack) = &rule.attack {
        let mut a = Map::new();
        if let Some(m) = &attack.melee {
            a.insert("melee".into(), modifiers(m, AttackRuleModifier::as_str));
        }
        if let Some(m) = &attack.ranged {
            a.insert("ranged".into(), modifiers(m, AttackRuleModifier::as_str));
        }
        out.insert("attack".into(), Value::Object(a));
    }
    if let Some(save) = &rule.save {
        let mut s = Map::new();
        for (ability, mods) in save {
            s.insert(ability.clone(), modifiers(mods, SaveRuleModifier::as_str));
        }
        out.insert("save".into(), Value::Object(s));
    }
    if let Some(own) = &rule.own {
        let mut o = Map::new();
        if let Some(m) = &own.attack {
            o.insert("attack".into(), modifiers(m, own_name));
        }
        if let Some(m) = &own.check {
            o.insert("check".into(), modifiers(m, own_name));
        }
        out.insert("own".into(), Value::Object(o));
    }
    if let Some(p) = rule.d20_penalty {
        out.insert("d20Penalty".into(), num(p));
    }
    if let Some(end) = &rule.on_end {
        let mut e = Map::new();
        e.insert("condition".into(), Value::String(end.condition.clone()));
        e.insert("rule".into(), rule_json(&end.rule));
        out.insert("onEnd".into(), Value::Object(e));
    }
    Value::Object(out)
}

fn until_str(spec: &EffectSpec) -> &'static str {
    match spec {
        EffectSpec::Grant(g) => g.until.as_str(),
        EffectSpec::Condition { until, .. } => match until {
            ConditionUntil::EndOfTurn => "end-of-turn",
            ConditionUntil::UntilDamaged => "until-damaged",
        },
        EffectSpec::Vulnerability => "next-hit",
        EffectSpec::SaveDisadvantage { until, .. } | EffectSpec::SavePenalty { until, .. } => {
            match until {
                SaveUntil::EndOfTurn => "end-of-turn",
                SaveUntil::NextSave => "next-save",
            }
        }
    }
}

/// The TS `EffectSpec` of an effect, as JSON (key order as the TS builds it).
pub(crate) fn effect_json(spec: &EffectSpec) -> Value {
    let mut out = Map::new();
    let until = Value::String(until_str(spec).to_string());
    let to_of = |to: &Option<Vec<String>>, out: &mut Map<String, Value>| {
        if let Some(list) = to {
            out.insert("to".into(), strings(list));
        }
    };
    match spec {
        EffectSpec::Grant(g) => {
            for (key, on) in [
                ("advantage", g.advantage),
                ("disadvantage", g.disadvantage),
                ("critOnHit", g.crit_on_hit),
            ] {
                if on {
                    out.insert(key.into(), Value::Bool(true));
                }
            }
            out.insert("until".into(), until);
            to_of(&g.to, &mut out);
        }
        EffectSpec::Condition {
            condition, rule, ..
        } => {
            out.insert("condition".into(), Value::String(condition.clone()));
            out.insert("rule".into(), rule_json(rule));
            out.insert("until".into(), until);
        }
        EffectSpec::Vulnerability => {
            out.insert("vulnerability".into(), Value::Bool(true));
            out.insert("until".into(), until);
        }
        EffectSpec::SaveDisadvantage { to, .. } => {
            out.insert("saveDisadvantage".into(), Value::Bool(true));
            out.insert("until".into(), until);
            to_of(to, &mut out);
        }
        EffectSpec::SavePenalty {
            count, sides, to, ..
        } => {
            let mut die = Map::new();
            die.insert("count".into(), num(*count));
            die.insert("sides".into(), num(*sides));
            out.insert("savePenalty".into(), Value::Object(die));
            out.insert("until".into(), until);
            to_of(to, &mut out);
        }
    }
    Value::Object(out)
}

fn bad_rule(what: &str) -> DiceError {
    DiceError::error(format!("dice-node: invalid condition rule: {what}"))
}

/// Unknown modifiers are skipped: the TS accepts them at runtime (its types only keep each modifier on
/// its side), and the facade keeps the caller's own rule for `spec`.
fn modifier_list<T>(
    v: &Value,
    parse: fn(&str) -> Option<T>,
    what: &str,
) -> Result<Vec<T>, DiceError> {
    let Value::Array(items) = v else {
        return Err(bad_rule(what));
    };
    Ok(items
        .iter()
        .filter_map(|item| item.as_str().and_then(parse))
        .collect())
}

fn attack_modifier(s: &str) -> Option<AttackRuleModifier> {
    Some(match s {
        "advantage" => AttackRuleModifier::Advantage,
        "disadvantage" => AttackRuleModifier::Disadvantage,
        "critOnHit" => AttackRuleModifier::CritOnHit,
        "vulnerable" => AttackRuleModifier::Vulnerable,
        _ => return None,
    })
}

fn save_modifier_of(s: &str) -> Option<SaveRuleModifier> {
    Some(match s {
        "autoFail" => SaveRuleModifier::AutoFail,
        "saveDisadvantage" => SaveRuleModifier::SaveDisadvantage,
        "disadvantage" => SaveRuleModifier::Disadvantage,
        _ => return None,
    })
}

fn own_modifier(s: &str) -> Option<OwnModifier> {
    match s {
        "advantage" => Some(OwnModifier::Advantage),
        "disadvantage" => Some(OwnModifier::Disadvantage),
        _ => None,
    }
}

fn object_of<'v>(v: &'v Value, what: &str) -> Result<&'v Map<String, Value>, DiceError> {
    v.as_object().ok_or_else(|| bad_rule(what))
}

fn rule_of(v: &Value) -> Result<ConditionRule, DiceError> {
    let obj = object_of(v, "rule")?;
    let mut rule = ConditionRule::default();
    if let Some(a) = obj.get("attack") {
        let a = object_of(a, "attack")?;
        let mut attack = AttackRule::default();
        if let Some(m) = a.get("melee") {
            attack.melee = Some(modifier_list(m, attack_modifier, "attack modifier")?);
        }
        if let Some(m) = a.get("ranged") {
            attack.ranged = Some(modifier_list(m, attack_modifier, "attack modifier")?);
        }
        rule.attack = Some(attack);
    }
    if let Some(s) = obj.get("save") {
        let mut save = indexmap::IndexMap::new();
        for (ability, mods) in object_of(s, "save")? {
            save.insert(
                ability.clone(),
                modifier_list(mods, save_modifier_of, "save modifier")?,
            );
        }
        rule.save = Some(save);
    }
    if let Some(o) = obj.get("own") {
        let o = object_of(o, "own")?;
        let mut own = OwnRule::default();
        if let Some(m) = o.get("attack") {
            own.attack = Some(modifier_list(m, own_modifier, "own modifier")?);
        }
        if let Some(m) = o.get("check") {
            own.check = Some(modifier_list(m, own_modifier, "own modifier")?);
        }
        rule.own = Some(own);
    }
    if let Some(p) = obj.get("d20Penalty") {
        rule.d20_penalty = Some(num_of(p).ok_or_else(|| bad_rule("d20Penalty"))?);
    }
    if let Some(e) = obj.get("onEnd") {
        let e = object_of(e, "onEnd")?;
        let name = e
            .get("condition")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_rule("onEnd condition"))?;
        let inner = e.get("rule").ok_or_else(|| bad_rule("onEnd rule"))?;
        rule.on_end = Some(Box::new(OnEnd {
            condition: name.to_string(),
            rule: rule_of(inner)?,
        }));
    }
    Ok(rule)
}

// ---- Lasting / Grant ----------------------------------------------------------------------------------

/// A [`Lasting`] effect (TS `Lasting`, and `Grant`).
#[napi]
pub struct NativeLasting {
    pub(crate) inner: Lasting,
}

impl NativeLasting {
    pub(crate) fn wrap(inner: Lasting) -> Self {
        Self { inner }
    }
}

#[napi]
impl NativeLasting {
    /// `vulnerability().untilNextHit()`.
    #[napi(factory)]
    pub fn vulnerability() -> NativeLasting {
        NativeLasting::wrap(vulnerability().until_next_hit())
    }

    /// The `EffectSpec` as JSON (see the module comment).
    #[napi]
    pub fn spec(&self) -> String {
        effect_json(&self.inner.spec).to_string()
    }

    /// Whether the TS builds this effect as a `Grant` (it has `to`): a grant or a save modifier.
    #[napi]
    pub fn is_grant(&self) -> bool {
        !matches!(
            self.inner.spec,
            EffectSpec::Condition { .. } | EffectSpec::Vulnerability
        )
    }

    /// `Grant.to(...targets)`.
    #[napi]
    pub fn to(&self, targets: Vec<String>) -> NativeLasting {
        let refs: Vec<&str> = targets.iter().map(String::as_str).collect();
        NativeLasting::wrap(Grant(self.inner.clone()).to(&refs).0)
    }
}

/// `Modifiers`: `advantage()`, `disadvantage()`, `critOnHit()` before a lifetime.
#[napi]
pub struct NativeModifiers {
    inner: Modifiers,
}

#[napi]
impl NativeModifiers {
    #[napi(factory)]
    pub fn empty() -> NativeModifiers {
        NativeModifiers {
            inner: Modifiers::default(),
        }
    }

    #[napi]
    pub fn advantage(&self) -> NativeModifiers {
        NativeModifiers {
            inner: self.inner.advantage(),
        }
    }

    #[napi]
    pub fn disadvantage(&self) -> NativeModifiers {
        NativeModifiers {
            inner: self.inner.disadvantage(),
        }
    }

    #[napi]
    pub fn crit_on_hit(&self) -> NativeModifiers {
        NativeModifiers {
            inner: self.inner.crit_on_hit(),
        }
    }

    #[napi]
    pub fn until_next_attack(&self) -> NativeLasting {
        NativeLasting::wrap(self.inner.until_next_attack().into())
    }

    #[napi]
    pub fn until_end_of_turn(&self) -> NativeLasting {
        NativeLasting::wrap(self.inner.until_end_of_turn().into())
    }
}

/// `ConditionEffect`: `condition(name, rule)` before a lifetime.
#[napi]
pub struct NativeCondition {
    inner: ConditionEffect,
}

/// `condition(name, rule)` from the rule as JSON.
pub(crate) fn condition_of(name: &str, rule_json: &str) -> Result<NativeCondition, DiceError> {
    let value: Value = serde_json::from_str(rule_json).map_err(|e| bad_rule(&e.to_string()))?;
    Ok(NativeCondition {
        inner: condition(name, rule_of(&value)?),
    })
}

#[napi]
impl NativeCondition {
    /// `condition(name, rule)`; `rule_json` is the rule as JSON.
    #[napi(factory)]
    pub fn create(name: String, rule_json: String) -> napi::Result<NativeCondition> {
        condition_of(&name, &rule_json).map_err(thrown)
    }

    #[napi]
    pub fn until_end_of_turn(&self) -> NativeLasting {
        NativeLasting::wrap(self.inner.until_end_of_turn())
    }

    #[napi]
    pub fn until_damaged(&self) -> NativeLasting {
        NativeLasting::wrap(self.inner.until_damaged())
    }
}

/// `SaveModifier`: `saveDisadvantage()` / `savePenalty(die)` before a lifetime.
#[napi]
pub struct NativeSaveModifier {
    inner: SaveModifier,
}

#[napi]
impl NativeSaveModifier {
    #[napi(factory)]
    pub fn disadvantage() -> NativeSaveModifier {
        NativeSaveModifier {
            inner: save_disadvantage(),
        }
    }

    /// `savePenalty(die)`: `Err` unless `die` is one plain die group.
    #[napi(factory)]
    pub fn penalty(die: &NativeRoll) -> napi::Result<NativeSaveModifier> {
        Ok(NativeSaveModifier {
            inner: save_penalty(&die.inner).map_err(thrown)?,
        })
    }

    #[napi]
    pub fn until_next_save(&self) -> NativeLasting {
        NativeLasting::wrap(self.inner.until_next_save().into())
    }

    #[napi]
    pub fn until_end_of_turn(&self) -> NativeLasting {
        NativeLasting::wrap(self.inner.until_end_of_turn().into())
    }
}

fn lastings_in(list: &[ClassInstance<'_, NativeLasting>]) -> Vec<Lasting> {
    list.iter().map(|l| l.inner.clone()).collect()
}

// ---- Transform ------------------------------------------------------------------------------------------

/// `substituteFields`: `{ substitute }`, or `{ substitute, policy }` when the policy is not `always`.
#[napi(object)]
pub struct JsSubstituteFields {
    pub substitute: String,
    pub policy: Option<JsSubstitutePolicy>,
}

#[napi(object)]
pub struct JsSubstitutePolicy {
    pub kind: String,
    pub hit: Option<f64>,
    pub crit: Option<f64>,
}

/// `Transform`, built by `keepBestDamage()`.
#[napi]
pub struct NativeTransform {
    inner: Transform,
}

#[napi]
impl NativeTransform {
    #[napi(factory)]
    pub fn keep_best_damage() -> NativeTransform {
        NativeTransform {
            inner: keep_best_damage(),
        }
    }

    /// `ifBelow({ hit, crit })` (a plain number is `hit = crit`); a NaN threshold is a `RangeError`.
    #[napi]
    pub fn if_below(&self, hit: f64, crit: f64) -> napi::Result<NativeTransform> {
        self.inner
            .if_below_split(hit, crit)
            .map(|inner| NativeTransform { inner })
            .map_err(thrown)
    }

    /// `optimally()`: always a `TurnSpecError` (`unsupported-policy`).
    #[napi]
    pub fn optimally(&self) -> napi::Result<NativeTransform> {
        self.inner
            .optimally()
            .map(|inner| NativeTransform { inner })
            .map_err(|e| thrown(DiceError::from(e)))
    }

    /// `substituteFields(transform)`; the policy is always given, `always` included.
    #[napi]
    pub fn fields(&self) -> JsSubstituteFields {
        let (kind, policy) = substitute_fields(&self.inner);
        JsSubstituteFields {
            substitute: kind.as_str().to_string(),
            policy: policy.map(policy_out),
        }
    }

    /// The TS `policy`, `always` included.
    #[napi]
    pub fn policy(&self) -> JsSubstitutePolicy {
        policy_out(self.inner.policy)
    }
}

fn policy_out(p: SubstitutePolicy) -> JsSubstitutePolicy {
    match p {
        SubstitutePolicy::Always => JsSubstitutePolicy {
            kind: "always".into(),
            hit: None,
            crit: None,
        },
        SubstitutePolicy::Below { hit, crit } => JsSubstitutePolicy {
            kind: "below".into(),
            hit: Some(hit),
            crit: Some(crit),
        },
        SubstitutePolicy::Optimal => JsSubstitutePolicy {
            kind: "optimal".into(),
            hit: None,
            crit: None,
        },
    }
}

// ---- Trigger saves ---------------------------------------------------------------------------------------

/// `GrantSaveSpec` as plain data: `{ ability?, dc, bonus, rollType? }`, or `{ ability?, failChanceKey }`
/// (a JS function in the facade's table). [`grant_save_spec_of`] answers `{ ability? }` alone for a DC
/// check that is not a plain d20 + flat bonus: the facade then builds a `failChance` over
/// [`grant_save_fail_chance`].
#[napi(object)]
pub struct JsSaveSpec {
    pub ability: Option<String>,
    pub dc: Option<f64>,
    pub bonus: Option<f64>,
    pub roll_type: Option<String>,
    pub fail_chance_key: Option<f64>,
}

/// One `TriggerSave`: a DC check handle or a plain spec.
pub type JsTriggerSave<'a> = Either<ClassInstance<'a, NativeRoll>, JsSaveSpec>;
/// `TriggerSave | readonly TriggerSave[]`. Flat on purpose: a nested `Either` would take an array
/// for the plain-object arm, which accepts any object.
pub type JsTriggerSaves<'a> =
    Either3<ClassInstance<'a, NativeRoll>, Vec<JsTriggerSave<'a>>, JsSaveSpec>;

fn js_fail_chance(key: f64) -> FailChance {
    FailChance::new(move |_| Err(DiceError::error(format!("{FAIL_CHANCE_TAG}{key}"))))
}

/// The table index inside a [`js_fail_chance`], or `None` for any other `FailChance`.
fn js_fail_chance_key(f: &FailChance) -> Option<f64> {
    let probe = RowContext {
        roll_type: yipe_dice::common::RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: Vec::new(),
        joined: Vec::new(),
    };
    f.call(&probe)
        .err()?
        .message()
        .strip_prefix(FAIL_CHANCE_TAG)?
        .parse()
        .ok()
}

fn spec_in(s: JsSaveSpec) -> napi::Result<GrantSaveSpec> {
    if let Some(key) = s.fail_chance_key {
        return Ok(GrantSaveSpec::FailChance {
            ability: s.ability,
            fail_chance: js_fail_chance(key),
        });
    }
    let (Some(dc), Some(bonus)) = (s.dc, s.bonus) else {
        return Err(err(
            "save must be a DC check such as d20.plus(2).dc(15), or a GrantSaveSpec.".to_string(),
        ));
    };
    let roll_type = match &s.roll_type {
        Some(name) => Some(conv::roll_type(name).map_err(thrown)?),
        None => None,
    };
    Ok(GrantSaveSpec::Dc {
        ability: s.ability,
        dc,
        bonus,
        roll_type,
    })
}

fn spec_out(spec: &GrantSaveSpec) -> JsSaveSpec {
    match spec {
        GrantSaveSpec::Dc {
            ability,
            dc,
            bonus,
            roll_type,
        } => JsSaveSpec {
            ability: ability.clone(),
            dc: Some(*dc),
            bonus: Some(*bonus),
            roll_type: roll_type.map(|t| t.as_str().to_string()),
            fail_chance_key: None,
        },
        GrantSaveSpec::FailChance {
            ability,
            fail_chance,
        } => JsSaveSpec {
            ability: ability.clone(),
            dc: None,
            bonus: None,
            roll_type: None,
            fail_chance_key: js_fail_chance_key(fail_chance),
        },
    }
}

fn trigger_save_in(s: JsTriggerSave<'_>) -> napi::Result<TriggerSave> {
    match s {
        Either::A(check) => Ok(TriggerSave::Dc(check.inner.clone())),
        Either::B(spec) => Ok(TriggerSave::Spec(spec_in(spec)?)),
    }
}

fn trigger_saves_in(s: JsTriggerSaves<'_>) -> napi::Result<TriggerSaves> {
    match s {
        Either3::A(check) => Ok(TriggerSaves::One(TriggerSave::Dc(check.inner.clone()))),
        Either3::B(many) => Ok(TriggerSaves::Many(
            many.into_iter()
                .map(trigger_save_in)
                .collect::<napi::Result<_>>()?,
        )),
        Either3::C(spec) => Ok(TriggerSaves::One(TriggerSave::Spec(spec_in(spec)?))),
    }
}

/// `grantSaveSpec(check, eps)` for a DC check: `{ ability?, dc, bonus, rollType? }` for a plain d20 plus
/// flat bonus, `{ ability? }` alone for any other (the facade supplies `failChance`).
#[napi(js_name = "grantSaveSpec")]
pub fn grant_save_spec_of(check: &NativeRoll, eps: f64) -> napi::Result<JsSaveSpec> {
    let spec = grant_save_spec(&TriggerSave::Dc(check.inner.clone()), eps).map_err(thrown)?;
    Ok(spec_out(&spec))
}

/// The `failChance` of a non-plain DC check in the context `{ rollType, autoFail, penaltyDice }`
/// (the three fields it reads), recomputed from the check each call as the TS does.
#[napi(object)]
pub struct JsFailContext {
    pub roll_type: String,
    pub auto_fail: bool,
    pub penalty_dice: Vec<JsPenaltyDice>,
}

#[napi]
pub fn grant_save_fail_chance(
    check: &NativeRoll,
    eps: f64,
    context: JsFailContext,
) -> napi::Result<f64> {
    let spec = grant_save_spec(&TriggerSave::Dc(check.inner.clone()), eps).map_err(thrown)?;
    let GrantSaveSpec::FailChance { fail_chance, .. } = spec else {
        return Err(err(
            "dice-node: grantSaveFailChance needs a DC check that is not a plain save".to_string(),
        ));
    };
    let ctx = RowContext {
        roll_type: conv::roll_type(&context.roll_type).map_err(thrown)?,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: context.auto_fail,
        vulnerable: false,
        penalty_dice: context
            .penalty_dice
            .iter()
            .map(|p| PenaltyDice {
                count: p.count,
                sides: p.sides,
            })
            .collect(),
        joined: Vec::new(),
    };
    fail_chance.call(&ctx).map_err(thrown)
}

// ---- SaveGated --------------------------------------------------------------------------------------------

/// `SaveGated`, built by `save(check, { fail, pass })`.
#[napi]
pub struct NativeSaveGated {
    pub(crate) inner: SaveGated,
}

#[napi]
impl NativeSaveGated {
    /// `save(check, { fail, pass })`; `Err` on no check or no `fail` effect (the facade checks first).
    #[napi(factory)]
    pub fn create(
        check: JsTriggerSaves<'_>,
        fail: Vec<ClassInstance<'_, NativeLasting>>,
        pass: Vec<ClassInstance<'_, NativeLasting>>,
    ) -> napi::Result<NativeSaveGated> {
        let gated = save(
            trigger_saves_in(check)?,
            lastings_in(&fail),
            Some(lastings_in(&pass)),
        )
        .map_err(thrown)?;
        Ok(NativeSaveGated { inner: gated })
    }
}

/// What `onEveryHit` / `onAnyCrit` / `onFirstCrit` take: one effect, several, or a `save()` value.
pub type JsGrants<'a> = Either3<
    ClassInstance<'a, NativeLasting>,
    Vec<ClassInstance<'a, NativeLasting>>,
    ClassInstance<'a, NativeSaveGated>,
>;

pub fn grants_in(g: JsGrants<'_>) -> Grants {
    match g {
        Either3::A(one) => Grants::One(one.inner.clone()),
        Either3::B(many) => Grants::Many(lastings_in(&many)),
        Either3::C(gated) => Grants::Gated(gated.inner.clone()),
    }
}

// ---- ConditionGate ----------------------------------------------------------------------------------------

/// A builder's attached gate, as the facade sends it (`gateToNative`): TS `ConditionGate`, with each
/// DC check as its handle and each `Lasting` as its handle (`targetHas` is a list).
#[napi(object, object_to_js = false)]
pub struct JsConditionGate<'a> {
    pub save: Option<JsTriggerSaves<'a>>,
    pub chance: Option<f64>,
    pub on_save: Option<Vec<ClassInstance<'a, NativeLasting>>>,
    pub landing: Option<String>,
    pub dealing: Option<String>,
    pub optional: Option<bool>,
    pub target_has: Option<Vec<String>>,
}

fn landing_in(s: &str) -> napi::Result<SaveLanding> {
    match s {
        "fail" => Ok(SaveLanding::Fail),
        "damage" => Ok(SaveLanding::Damage),
        _ => Err(err(format!("dice-node: unknown save landing {s:?}"))),
    }
}

pub fn gate_in(g: Option<JsConditionGate<'_>>) -> napi::Result<Option<ConditionGate>> {
    let Some(g) = g else {
        return Ok(None);
    };
    Ok(Some(ConditionGate {
        save: g.save.map(trigger_saves_in).transpose()?,
        chance: g.chance,
        on_save: g.on_save.map(|list| lastings_in(&list)),
        landing: g.landing.as_deref().map(landing_in).transpose()?,
        dealing: g.dealing,
        optional: g.optional == Some(true),
        target_has: g.target_has,
    }))
}
