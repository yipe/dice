//! The decoders: `(json, refs)` to the engine's spec types, and a verb's positional arguments to the
//! calls on `Turn`. The JSON mirrors `src/turn/types.ts` field for field; `{"$": i}` stands for
//! `refs[i]` (a native handle, a JS function, or a hand-written object). Numbers JSON cannot carry
//! are the strings `"NaN"`, `"Infinity"`, `"-Infinity"`, `"-0"`. `null` is as good as absent.
//!
//! Decoding is generous where the TS is: `of`, `targetHas` and `until`-less lists take a string or a
//! list, a `Damage | Damage[]` takes either. Runtime shape checks the TS makes while building the plan
//! (`unknown-key`, `non-string-id`, `not-an-attack` for a source with no PMF) are made here, with the
//! TS ids and messages, because a typed spec cannot express them.

use std::sync::Arc;
use yipe_dice::error::DiceError;

use indexmap::IndexMap;
use serde_json::{Map, Value};
use yipe_dice::builder::types::MissRerollMode;
use yipe_dice::common::RollType;
use yipe_dice::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, Lasting, StartEffect, Transform,
    TriggerSave, TriggerSaves, grant_save_spec,
};
use yipe_dice::turn::plan::fail;
use yipe_dice::turn::types::{
    After, AfterLanding, Attack, AttackOptions, AttacksOptions, ConditionOn, ConditionSpec,
    DamageSource, EffectSpec, GrantSaveSpec, GrantSaves, GrantSpec, GrantUntil, PerSource, ProbeOn,
    ProbeSpec, Rider, RiderDamage, RiderDamageSpec, RiderLanding, RiderOptions, RiderPayload,
    SaveLanding, SaveUntil, Source, SubstituteKind, SubstituteOn, SubstitutePolicy, SubstituteSpec,
    Trigger, TurnSpec, TurnSpecErrorCode,
};
use yipe_dice::turn::{Effect, EffectPart};

use super::js::{
    Handle, Js, JsContextual, JsPayload, JsRef, JsToPmf, Kind, Val, fail_chance, row_check_from_js,
};
use crate::effects::{
    NativeCondition, NativeLasting, NativeModifiers, NativeSaveGated, NativeSaveModifier,
    NativeTransform, condition_of,
};

pub type Res<T> = Result<T, DiceError>;

/// What a decode reads: the current env and the `refs` array.
pub struct Cx {
    pub js: Js,
    pub refs: Val,
    pub eps: f64,
}

fn bad<T>(message: impl Into<String>) -> Res<T> {
    Err(DiceError::Error(message.into()))
}

fn not_an_attack<T>(id: &str) -> Res<T> {
    Err(fail(
        TurnSpecErrorCode::NotAnAttack,
        id,
        format!("\"{id}\" is neither a PMF nor a builder with toPMF()."),
    ))
}

// ---- JSON helpers ----------------------------------------------------------------------------------

static NULL: Value = Value::Null;

/// `refs` index of a `{"$": i}` value.
fn ref_index(v: &Value) -> Option<usize> {
    let map = v.as_object()?;
    if map.len() != 1 {
        return None;
    }
    map.get("$")?.as_u64().map(|i| i as usize)
}

/// A number, or one of the strings JSON cannot carry.
pub fn number(v: &Value) -> Option<f64> {
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

fn need_number(v: &Value, what: &str) -> Res<f64> {
    number(v).map_or_else(|| bad(format!("{what} must be a number.")), Ok)
}

fn present<'v>(map: &'v Map<String, Value>, key: &str) -> Option<&'v Value> {
    map.get(key).filter(|v| !v.is_null())
}

fn opt_number(map: &Map<String, Value>, key: &str) -> Res<Option<f64>> {
    present(map, key).map(|v| need_number(v, key)).transpose()
}

fn opt_string(map: &Map<String, Value>, key: &str) -> Res<Option<String>> {
    match present(map, key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => bad(format!("{key} must be a string.")),
    }
}

fn need_string(map: &Map<String, Value>, key: &str) -> Res<String> {
    opt_string(map, key)?.map_or_else(|| bad(format!("{key} is required.")), Ok)
}

/// JS `typeof` of a JSON value (as far as a spec can carry one).
fn js_typeof(v: &Value) -> &'static str {
    match v {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        _ => "object",
    }
}

/// JS `String(value)` of a JSON value.
fn js_string_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => yipe_dice::js::num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(_) => String::new(),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// An `id`: absent, or a string. Any other is `non-string-id`, as `stringId` in `buildPlan`.
fn opt_id(map: &Map<String, Value>, key: &str) -> Res<Option<String>> {
    match present(map, key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(fail(
            TurnSpecErrorCode::NonStringId,
            &js_string_of(other),
            format!("An id must be a string, got {}.", js_typeof(other)),
        )),
    }
}

/// `checkedTargetHas`: a non-empty list of non-empty condition names (`list_ok`: a lone name is a
/// list of one, as a verb's options say it).
fn target_has(map: &Map<String, Value>, id: &str, list_ok: bool) -> Res<Option<Vec<String>>> {
    let Some(v) = present(map, "targetHas") else {
        return Ok(None);
    };
    let wrong = || {
        fail(
            TurnSpecErrorCode::NonStringId,
            id,
            format!("\"{id}\" has a targetHas that is not a non-empty list of condition names."),
        )
    };
    let list: Vec<&Value> = match v {
        Value::String(_) if list_ok => vec![v],
        Value::Array(items) => items.iter().collect(),
        _ => return Err(wrong()),
    };
    if list.is_empty() {
        return Err(wrong());
    }
    list.into_iter()
        .map(|name| match name {
            Value::String(s) if !s.is_empty() => Ok(s.clone()),
            _ => Err(wrong()),
        })
        .collect::<Res<Vec<_>>>()
        .map(Some)
}

fn flag(map: &Map<String, Value>, key: &str) -> bool {
    matches!(map.get(key), Some(Value::Bool(true)))
}

/// A string or a list of strings.
fn names_of(v: &Value, what: &str) -> Res<Vec<String>> {
    match v {
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => Ok(s.clone()),
                _ => bad(format!("{what} must hold only strings.")),
            })
            .collect(),
        _ => bad(format!("{what} must be a string or a list of strings.")),
    }
}

fn opt_names(map: &Map<String, Value>, key: &str) -> Res<Option<Vec<String>>> {
    present(map, key).map(|v| names_of(v, key)).transpose()
}

fn where_map(v: &Value) -> Res<IndexMap<String, Vec<String>>> {
    let Value::Object(map) = v else {
        return bad("where must be an object of attack id to a list of attack ids.");
    };
    map.iter()
        .map(|(k, v)| Ok((k.clone(), names_of(v, "where")?)))
        .collect()
}

fn object<'v>(v: &'v Value, what: &str) -> Res<&'v Map<String, Value>> {
    v.as_object()
        .map_or_else(|| bad(format!("{what} must be an object.")), Ok)
}

/// An options bag: absent or `null` is empty.
fn options_of<'v>(v: &'v Value, what: &str) -> Res<std::borrow::Cow<'v, Map<String, Value>>> {
    match v {
        Value::Null => Ok(std::borrow::Cow::Owned(Map::new())),
        Value::Object(map) if ref_index(v).is_none() => Ok(std::borrow::Cow::Borrowed(map)),
        _ => bad(format!("{what} must be an object.")),
    }
}

fn items<'v>(v: &'v Value, what: &str) -> Res<&'v [Value]> {
    v.as_array()
        .map(Vec::as_slice)
        .map_or_else(|| bad(format!("{what} must be a list.")), Ok)
}

fn save_landing(s: &str) -> Res<SaveLanding> {
    match s {
        "fail" => Ok(SaveLanding::Fail),
        "damage" => Ok(SaveLanding::Damage),
        _ => bad(format!("unknown landing {s:?}")),
    }
}

// ---- refs ----------------------------------------------------------------------------------------------

impl Cx {
    fn val(&self, i: usize) -> Res<Val> {
        self.js.get_index(self.refs, i)
    }

    /// `refs[i]` for a `{"$": i}` value.
    fn ref_val(&self, v: &Value) -> Res<Option<Val>> {
        ref_index(v).map(|i| self.val(i)).transpose()
    }

    fn keep(&self, v: Val) -> Res<JsRef> {
        JsRef::new(&self.js, v)
    }

    fn kind(&self, v: Val) -> Res<Kind> {
        self.js.kind(v)
    }
}

// ---- damage and sources ----------------------------------------------------------------------------------

fn damage_of_handle(h: Handle) -> DamageSource {
    match h {
        Handle::Pmf(p) => DamageSource::Pmf(p),
        Handle::Roll(r) => DamageSource::Roll(*r),
        Handle::Attack(a) => DamageSource::Attack(a),
        Handle::Save(s) => DamageSource::Save(s),
    }
}

/// A builder, a PMF or a hand-written `{ toPMF }`; `id` is what a `not-an-attack` error names.
fn damage_val(cx: &Cx, val: Val, id: &str) -> Res<DamageSource> {
    if let Some(h) = cx.js.handle(val)? {
        return Ok(damage_of_handle(h));
    }
    if cx.kind(val)? == Kind::Object && cx.js.has_function(val, "toPMF")? {
        return Ok(DamageSource::Other(Arc::new(JsToPmf {
            object: cx.keep(val)?,
            id: id.to_string(),
        })));
    }
    not_an_attack(id)
}

pub fn damage(cx: &Cx, v: &Value, id: &str) -> Res<DamageSource> {
    match cx.ref_val(v)? {
        Some(val) => damage_val(cx, val, id),
        None => not_an_attack(id),
    }
}

/// `Damage | readonly Damage[]`.
fn rider_damage(cx: &Cx, v: &Value, id: &str) -> Res<RiderDamage> {
    match v {
        Value::Array(parts) => Ok(RiderDamage::Many(
            parts
                .iter()
                .map(|p| damage(cx, p, id))
                .collect::<Res<Vec<_>>>()?,
        )),
        _ => Ok(RiderDamage::One(damage(cx, v, id)?)),
    }
}

fn contextual(cx: &Cx, val: Val, id: &str) -> Res<Option<JsContextual>> {
    let js = &cx.js;
    if cx.kind(val)? != Kind::Object || !js.has_function(val, "under")? {
        return Ok(None);
    }
    let mut check = js.get(val, "rowCheck")?;
    if cx.kind(check)? == Kind::Function {
        check = js.call(val, check, &[])?;
    }
    if cx.kind(check)? != Kind::Object {
        return Ok(None);
    }
    let has = |name: &str| js.has_function(val, name);
    let ignores_joined = {
        let by_name = js.get(val, "IGNORES_JOINED")?;
        let named = cx.kind(by_name)? == Kind::Bool && js.to_bool(by_name)?;
        named || js.has_true_symbol(val, "ignoresJoined")?
    };
    Ok(Some(JsContextual {
        object: cx.keep(val)?,
        id: id.to_string(),
        check: row_check_from_js(js, check)?,
        has_rerolled_under: has("rerolledUnder")?,
        has_dealt: has("dealt")?,
        has_miss_rerolled_under: has("missRerolledUnder")?,
        ignores_joined,
    }))
}

/// `sourceTags`: a source that carries tags (`AttackBuilder.tagged()`) carries only strings.
fn check_tags(cx: &Cx, val: Val, id: &str) -> Res<()> {
    let js = &cx.js;
    if cx.kind(val)? != Kind::Object {
        return Ok(());
    }
    let tags = js.get(val, "tags")?;
    if cx.kind(tags)? != Kind::Object || !js.is_array(tags)? {
        return Ok(());
    }
    for i in 0..js.len(tags)? {
        let tag = js.get_index(tags, i)?;
        if cx.kind(tag)? != Kind::Str {
            return Err(fail(
                TurnSpecErrorCode::NonStringId,
                id,
                format!("\"{id}\" carries a non-string tag."),
            ));
        }
    }
    Ok(())
}

fn source(cx: &Cx, v: &Value, id: &str) -> Res<Source> {
    let Some(val) = cx.ref_val(v)? else {
        return not_an_attack(id);
    };
    check_tags(cx, val, id)?;
    if let Some(h) = cx.js.handle(val)? {
        return Ok(Source::Damage(damage_of_handle(h)));
    }
    if let Some(c) = contextual(cx, val, id)? {
        return Ok(Source::Contextual(yipe_dice::turn::types::ArcContextual(
            Arc::new(c),
        )));
    }
    Ok(Source::Damage(damage_val(cx, val, id)?))
}

/// `RiderDamage | ContextualPayload`.
fn rider_damage_spec(cx: &Cx, v: &Value, id: &str) -> Res<RiderDamageSpec> {
    if let Some(val) = cx.ref_val(v)? {
        let js = &cx.js;
        let is_payload = cx.kind(val)? == Kind::Object
            && cx.js.handle(val)?.is_none()
            && !js.has_function(val, "toPMF")?
            && js.has_function(val, "at")?;
        if is_payload {
            return Ok(RiderDamageSpec::Contextual(Arc::new(JsPayload {
                has_dealt: js.has_function(val, "dealt")?,
                has_roll_at: js.has_function(val, "rollAt")?,
                object: cx.keep(val)?,
            })));
        }
    }
    Ok(RiderDamageSpec::Plain(rider_damage(cx, v, id)?))
}

// ---- attacks -------------------------------------------------------------------------------------------------

const ATTACK_KEYS: [&str; 6] = ["source", "id", "tag", "chance", "target", "after"];

fn after_of(v: &Value, id: &str) -> Res<After> {
    let map = object(v, "after")?;
    let landing = match need_string(map, "landing")?.as_str() {
        "hit" => AfterLanding::Hit,
        "damage" => AfterLanding::Damage,
        "any" => AfterLanding::Any,
        other => {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Attack \"{id}\" happens after a landing of \"{other}\". Use \"hit\", \"damage\" or \"any\"."
                ),
            ));
        }
    };
    Ok(After {
        of: need_string(map, "of")?,
        landing,
    })
}

/// An attack's options from a wrapper or an options bag (`source` aside), checked like
/// `attackEntry`: unknown keys and non-string ids are `TurnSpecError`s naming `default_id`.
fn attack_options(map: &Map<String, Value>, default_id: &str) -> Res<AttackOptions> {
    let named = match map.get("id") {
        Some(Value::String(s)) => s.as_str(),
        _ => default_id,
    };
    for key in map.keys() {
        if !ATTACK_KEYS.contains(&key.as_str()) {
            return Err(fail(
                TurnSpecErrorCode::UnknownKey,
                named,
                format!(
                    "Attack \"{named}\" carries an unknown key \"{key}\". Valid keys are {}.",
                    ATTACK_KEYS.join(", ")
                ),
            ));
        }
    }
    let string_of = |key: &str| -> Res<Option<String>> {
        match present(map, key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(fail(
                TurnSpecErrorCode::NonStringId,
                default_id,
                format!("Attack \"{default_id}\" has a non-string {key}."),
            )),
        }
    };
    let chance = match present(map, "chance") {
        None => None,
        Some(v) => Some(number(v).ok_or_else(|| {
            DiceError::Range(format!(
                "Attack \"{named}\" needs a chance in [0, 1], got {v}."
            ))
        })?),
    };
    Ok(AttackOptions {
        id: string_of("id")?,
        tag: string_of("tag")?,
        chance,
        target: string_of("target")?,
        after: present(map, "after")
            .map(|a| after_of(a, named))
            .transpose()?,
    })
}

/// A declared attack: a bare source, or `{ id?, tag?, chance?, target?, after?, source }`.
pub fn attack(cx: &Cx, v: &Value, index: usize) -> Res<Attack> {
    let default_id = format!("attack {}", index + 1);
    if ref_index(v).is_some() {
        return Ok(Attack::Bare(source(cx, v, &default_id)?));
    }
    let Some(map) = v.as_object().filter(|m| present(m, "source").is_some()) else {
        return not_an_attack(&default_id);
    };
    let options = attack_options(map, &default_id)?;
    let id = options.id.clone().unwrap_or(default_id);
    let src = source(cx, &map["source"], &id)?;
    Ok(Attack::Declared {
        options,
        source: src,
    })
}

fn attacks(cx: &Cx, v: &Value, first_index: usize) -> Res<Vec<Attack>> {
    items(v, "attacks")?
        .iter()
        .enumerate()
        .map(|(i, a)| attack(cx, a, first_index + i))
        .collect()
}

// ---- riders ----------------------------------------------------------------------------------------------------

fn per_source(cx: &Cx, v: &Value, id: &str, on: &str) -> Res<PerSource> {
    let map = object(v, "perSource")?;
    let mut out = PerSource::new();
    for (key, payload) in map {
        let Some(payload) = payload
            .as_object()
            .filter(|p| present(p, "damage").is_some())
        else {
            return Err(fail(
                TurnSpecErrorCode::NotAnAttack,
                key,
                format!("Rider \"{id}\" has no damage in its payload for \"{key}\"."),
            ));
        };
        let damage_value = present(payload, "damage").unwrap_or(&NULL);
        refuse_payload(cx, damage_value, id, on)?;
        out.insert(
            key.clone(),
            RiderPayload {
                damage: rider_damage(cx, damage_value, id)?,
                crit_damage: present(payload, "critDamage")
                    .map(|d| rider_damage(cx, d, id))
                    .transpose()?,
            },
        );
    }
    Ok(out)
}

fn rider_hint(map: &Map<String, Value>, count: usize) -> String {
    match map.get("id") {
        Some(Value::String(s)) => s.clone(),
        _ => format!("rider {}", count + 1),
    }
}

const TRIGGERS: &str =
    "first-hit, any-crit, any-miss, first-miss, every-hit, dice-match or not-fired";

/// A landing kind a rider may carry: `fail`, `damage` or (riders only) `any`.
fn rider_landing(
    map: &Map<String, Value>,
    id: &str,
    as_condition: bool,
) -> Res<Option<RiderLanding>> {
    let Some(v) = present(map, "landing") else {
        return Ok(None);
    };
    match v.as_str() {
        Some("any") => Ok(Some(RiderLanding::Any)),
        Some("fail") => Ok(Some(RiderLanding::Save(SaveLanding::Fail))),
        Some("damage") => Ok(Some(RiderLanding::Save(SaveLanding::Damage))),
        _ => Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "{} \"{id}\" declares landing \"{}\". Use \"fail\" or \"damage\".",
                if as_condition { "Condition" } else { "Rider" },
                js_string_of(v)
            ),
        )),
    }
}

/// `refusePayload`: a transform or a grant where damage goes is `unsupported-trigger`.
fn refuse_payload(cx: &Cx, v: &Value, id: &str, on: &str) -> Res<()> {
    let parts: Vec<&Value> = match v {
        Value::Array(list) => list.iter().collect(),
        one => vec![one],
    };
    for part in parts {
        let Some(val) = cx.ref_val(part)? else {
            continue;
        };
        if cx.js.instance::<NativeTransform>(val).is_some() {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Rider \"{id}\" carries a transform on \"{on}\". A transform is only accepted by onFirstHit."
                ),
            ));
        }
        if lasting_val(cx, val).is_some() {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Rider \"{id}\" carries a grant on \"{on}\". A grant is only accepted by onEveryHit, onFirstHit and onAnyCrit."
                ),
            ));
        }
    }
    Ok(())
}

/// A rider (`Turn.rider`, or an entry of `spec.riders`), validated as `buildPlan` does what a typed
/// `Rider` cannot say: the trigger is one of the seven, `max` and `perSource` sit on a trigger that
/// takes them, damage is not a transform or a grant, ids and `targetHas` are well formed.
pub fn rider(cx: &Cx, v: &Value, index: usize) -> Res<Rider> {
    let map = object(v, "a rider")?;
    let own_id = opt_id(map, "id")?;
    let hint = own_id
        .clone()
        .unwrap_or_else(|| format!("rider {}", index + 1));
    let on = match map.get("on") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => js_string_of(other),
        None => "undefined".to_string(),
    };
    if ![
        "first-hit",
        "any-crit",
        "any-miss",
        "first-miss",
        "every-hit",
        "dice-match",
        "not-fired",
    ]
    .contains(&on.as_str())
    {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            &hint,
            format!(
                "Rider \"{hint}\" triggers on \"{on}\", which is not a trigger. Use {TRIGGERS}."
            ),
        ));
    }
    let landing = rider_landing(map, &hint, false)?;
    if let Some(damage) = present(map, "damage") {
        refuse_payload(cx, damage, &hint, &on)?;
    }
    let of = opt_names(map, "of")?;
    let max = match present(map, "max") {
        None => None,
        Some(m) => {
            if on != "every-hit" && on != "any-crit" {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    &hint,
                    format!(
                        "Rider \"{hint}\" has a max on \"{on}\". Only every-hit riders are capped; first-hit already applies once."
                    ),
                ));
            }
            Some(max_number(m, &hint)?)
        }
    };
    let per = match present(map, "perSource") {
        None => None,
        Some(p) => {
            if on != "every-hit" && on != "first-hit" {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    &hint,
                    format!(
                        "Rider \"{hint}\" has a payload per source on \"{on}\". Only first-hit and every-hit riders take one."
                    ),
                ));
            }
            Some(per_source(cx, p, &hint, &on)?)
        }
    };
    let trigger = match on.as_str() {
        "first-hit" => Trigger::FirstHit {
            of,
            per_source: per,
        },
        "any-crit" => Trigger::AnyCrit { of, max },
        "any-miss" => Trigger::AnyMiss { of },
        "first-miss" => Trigger::FirstMiss { of },
        "every-hit" => Trigger::EveryHit {
            of,
            max,
            per_source: per,
        },
        "not-fired" => match map.get("of") {
            Some(Value::String(s)) => Trigger::NotFired { of: s.clone() },
            _ => return bad("a not-fired rider needs the id of the rider it negates in `of`."),
        },
        _ => match of {
            Some(of) => Trigger::DiceMatch { of },
            None => return bad("a dice-match rider needs `of`."),
        },
    };
    Ok(Rider {
        trigger,
        id: own_id,
        damage: rider_damage_spec(cx, present(map, "damage").unwrap_or(&NULL), &hint)?,
        crit_damage: present(map, "critDamage")
            .map(|d| rider_damage(cx, d, &hint))
            .transpose()?,
        landing,
        happens: opt_number(map, "happens")?,
        joins: opt_names(map, "joins")?,
        r#where: present(map, "where").map(where_map).transpose()?,
        target_has: target_has(map, &hint, false)?,
    })
}

/// `RiderOptions`.
fn rider_options(
    cx: &Cx,
    map: &Map<String, Value>,
    count: usize,
    as_condition: bool,
) -> Res<RiderOptions> {
    let id = opt_id(map, "id")?;
    let hint = id.clone().unwrap_or_else(|| format!("rider {}", count + 1));
    let landing = match rider_landing(map, &hint, as_condition)? {
        None => None,
        Some(RiderLanding::Save(l)) => Some(l),
        Some(RiderLanding::Any) => {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                &hint,
                format!("Rider \"{hint}\" declares landing \"any\". Use \"fail\" or \"damage\"."),
            ));
        }
    };
    Ok(RiderOptions {
        id,
        of: opt_names(map, "of")?,
        crit_damage: present(map, "critDamage")
            .map(|d| rider_damage(cx, d, &hint))
            .transpose()?,
        landing,
        r#where: present(map, "where").map(where_map).transpose()?,
        joins: opt_names(map, "joins")?,
        target_has: target_has(map, &hint, true)?,
    })
}

// ---- effects -----------------------------------------------------------------------------------------------------

fn lasting_val(cx: &Cx, val: Val) -> Option<Lasting> {
    cx.js
        .instance::<NativeLasting>(val)
        .map(|l| l.inner.clone())
}

/// One effect with a lifetime from a ref.
fn lasting(cx: &Cx, v: &Value) -> Res<Lasting> {
    cx.ref_val(v)?
        .and_then(|val| lasting_val(cx, val))
        .map_or_else(
            || bad("expected an effect with a lifetime, such as advantage().untilNextAttack()."),
            Ok,
        )
}

/// `Lasting | readonly Lasting[]`.
fn lastings(cx: &Cx, v: &Value) -> Res<Vec<Lasting>> {
    match v {
        Value::Array(list) => list.iter().map(|l| lasting(cx, l)).collect(),
        _ => Ok(vec![lasting(cx, v)?]),
    }
}

/// What `atStart` takes: an effect with a lifetime, or one without (which lasts the turn).
fn start_effect(cx: &Cx, v: &Value) -> Res<StartEffect> {
    let Some(val) = cx.ref_val(v)? else {
        return bad("atStart takes effects.");
    };
    if let Some(l) = lasting_val(cx, val) {
        return Ok(StartEffect::Lasting(l));
    }
    let turn_long = if let Some(m) = cx.js.instance::<NativeModifiers>(val) {
        m.until_end_of_turn()
    } else if let Some(c) = cx.js.instance::<NativeCondition>(val) {
        c.until_end_of_turn()
    } else if let Some(s) = cx.js.instance::<NativeSaveModifier>(val) {
        s.until_end_of_turn()
    } else {
        return bad("atStart takes effects, such as restrained() or advantage().");
    };
    Ok(StartEffect::Lasting(turn_long.inner.clone()))
}

/// `Transform` from its handle: its fields are the substitute and policy.
fn transform_val(cx: &Cx, val: Val) -> Res<Option<Transform>> {
    let Some(t) = cx.js.instance::<NativeTransform>(val) else {
        return Ok(None);
    };
    let fields = t.fields();
    let substitute = substitute_kind(&fields.substitute)?;
    let policy = match &fields.policy {
        None => SubstitutePolicy::Always,
        Some(p) => match p.kind.as_str() {
            "below" => SubstitutePolicy::Below {
                hit: p.hit.unwrap_or(f64::NAN),
                crit: p.crit.unwrap_or(f64::NAN),
            },
            "optimal" => SubstitutePolicy::Optimal,
            _ => SubstitutePolicy::Always,
        },
    };
    Ok(Some(Transform { substitute, policy }))
}

/// What a trigger verb takes beside its options: an effect, or (`onFirstHit`) a transform.
pub enum EffectArg {
    Effect(Box<Effect>),
    Transform(Transform),
}

fn effect_part(cx: &Cx, v: &Value, id: &str) -> Res<EffectPart> {
    if let Some(l) = cx.ref_val(v)?.and_then(|val| lasting_val(cx, val)) {
        return Ok(EffectPart::Grant(l));
    }
    Ok(EffectPart::Damage(damage(cx, v, id)?))
}

fn effect_arg(cx: &Cx, v: &Value, id: &str) -> Res<EffectArg> {
    if let Value::Array(list) = v {
        let parts = list
            .iter()
            .map(|p| effect_part(cx, p, id))
            .collect::<Res<Vec<_>>>()?;
        if parts.iter().all(|p| matches!(p, EffectPart::Damage(_))) {
            let damages = parts
                .into_iter()
                .filter_map(|p| match p {
                    EffectPart::Damage(d) => Some(d),
                    EffectPart::Grant(_) => None,
                })
                .collect();
            return Ok(EffectArg::Effect(Box::new(Effect::Damage(
                RiderDamage::Many(damages),
            ))));
        }
        return Ok(EffectArg::Effect(Box::new(Effect::List(parts))));
    }
    if let Some(val) = cx.ref_val(v)? {
        if let Some(gated) = cx.js.instance::<NativeSaveGated>(val) {
            return Ok(EffectArg::Effect(Box::new(Effect::Saved(
                gated.inner.clone(),
            ))));
        }
        if let Some(l) = lasting_val(cx, val) {
            return Ok(EffectArg::Effect(Box::new(Effect::Lasting(l))));
        }
        if let Some(t) = transform_val(cx, val)? {
            return Ok(EffectArg::Transform(t));
        }
        let js = &cx.js;
        if js.instance::<NativeModifiers>(val).is_some()
            || js.instance::<NativeCondition>(val).is_some()
            || js.instance::<NativeSaveModifier>(val).is_some()
        {
            return bad("an effect needs a lifetime: add untilNextAttack(), untilEndOfTurn(), ...");
        }
    }
    Ok(EffectArg::Effect(Box::new(Effect::Damage(
        RiderDamage::One(damage(cx, v, id)?),
    ))))
}

fn substitute_kind(s: &str) -> Res<SubstituteKind> {
    match s {
        "reroll-keep-higher" => Ok(SubstituteKind::RerollKeepHigher),
        "hit" => Ok(SubstituteKind::Hit),
        "reroll" => Ok(SubstituteKind::Reroll),
        _ => bad(format!("unknown substitute {s:?}")),
    }
}

fn miss_reroll_mode(s: &str) -> Res<MissRerollMode> {
    crate::conv::miss_reroll_mode(s)
}

fn roll_type(s: &str) -> Res<RollType> {
    crate::conv::roll_type(s)
}

/// An `EffectSpec` as data.
fn effect_spec(cx: &Cx, v: &Value) -> Res<EffectSpec> {
    if let Some(l) = cx.ref_val(v)?.and_then(|val| lasting_val(cx, val)) {
        return Ok(l.spec);
    }
    let map = object(v, "an effect")?;
    let to = opt_names(map, "to")?;
    let until = need_string(map, "until")?;
    if let Some(name) = opt_string(map, "condition")? {
        let rule = present(map, "rule")
            .map(Value::to_string)
            .unwrap_or_else(|| "{}".to_string());
        let effect = condition_of(&name, &rule)?;
        let lasting = match until.as_str() {
            "end-of-turn" => effect.until_end_of_turn(),
            "until-damaged" => effect.until_damaged(),
            other => return bad(format!("unknown condition lifetime {other:?}")),
        };
        return Ok(lasting.inner.spec);
    }
    let save_until = |s: &str| -> Res<SaveUntil> {
        match s {
            "end-of-turn" => Ok(SaveUntil::EndOfTurn),
            "next-save" => Ok(SaveUntil::NextSave),
            _ => bad(format!("unknown save-effect lifetime {s:?}")),
        }
    };
    if flag(map, "vulnerability") {
        return Ok(EffectSpec::Vulnerability);
    }
    if flag(map, "saveDisadvantage") {
        return Ok(EffectSpec::SaveDisadvantage {
            until: save_until(&until)?,
            to,
        });
    }
    if let Some(penalty) = present(map, "savePenalty") {
        let die = object(penalty, "savePenalty")?;
        return Ok(EffectSpec::SavePenalty {
            count: need_number(die.get("count").unwrap_or(&NULL), "savePenalty.count")?,
            sides: need_number(die.get("sides").unwrap_or(&NULL), "savePenalty.sides")?,
            until: save_until(&until)?,
            to,
        });
    }
    let until = match until.as_str() {
        "next-attack" => GrantUntil::NextAttack,
        "end-of-turn" => GrantUntil::EndOfTurn,
        other => return bad(format!("unknown grant lifetime {other:?}")),
    };
    Ok(EffectSpec::Grant(GrantSpec {
        advantage: flag(map, "advantage"),
        disadvantage: flag(map, "disadvantage"),
        crit_on_hit: flag(map, "critOnHit"),
        until,
        to,
    }))
}

fn effect_specs(cx: &Cx, v: &Value) -> Res<Vec<EffectSpec>> {
    match v {
        Value::Array(list) => list.iter().map(|e| effect_spec(cx, e)).collect(),
        _ => Ok(vec![effect_spec(cx, v)?]),
    }
}

// ---- saves ---------------------------------------------------------------------------------------------------------

fn grant_save(cx: &Cx, v: &Value, cond: &str) -> Res<GrantSaveSpec> {
    let neither = || {
        DiceError::Error(format!(
            "Condition \"{cond}\" has a save that is neither {{ dc, bonus }} nor {{ failChance }}."
        ))
    };
    if let Some(val) = cx.ref_val(v)? {
        return match cx.js.handle(val)? {
            Some(Handle::Roll(r)) => grant_save_spec(&TriggerSave::Dc(*r), cx.eps),
            _ => bad("save must be a DC check such as d20.plus(2).dc(15), or a GrantSaveSpec."),
        };
    }
    let Value::Object(map) = v else {
        return bad("save must be a DC check such as d20.plus(2).dc(15), or a GrantSaveSpec.");
    };
    let ability = opt_string(map, "ability")?;
    if map.contains_key("failChance") {
        let function = match present(map, "failChance") {
            Some(f) => cx
                .ref_val(f)?
                .filter(|val| cx.kind(*val).is_ok_and(|k| k == Kind::Function)),
            None => None,
        };
        let Some(val) = function else {
            return Err(neither());
        };
        return Ok(GrantSaveSpec::FailChance {
            ability,
            fail_chance: fail_chance(cx.keep(val)?),
        });
    }
    let finite = |key: &str| present(map, key).and_then(number).filter(|x| x.is_finite());
    let (Some(dc), Some(bonus)) = (finite("dc"), finite("bonus")) else {
        return Err(neither());
    };
    let roll_type = opt_string(map, "rollType")?
        .as_deref()
        .map(roll_type)
        .transpose()?;
    Ok(GrantSaveSpec::Dc {
        ability,
        dc,
        bonus,
        roll_type,
    })
}

fn grant_saves(cx: &Cx, v: &Value, cond: &str) -> Res<GrantSaves> {
    match v {
        Value::Array(list) => Ok(GrantSaves::Many(
            list.iter()
                .map(|s| grant_save(cx, s, cond))
                .collect::<Res<_>>()?,
        )),
        _ => Ok(GrantSaves::One(grant_save(cx, v, cond)?)),
    }
}

fn trigger_saves(cx: &Cx, v: &Value, cond: &str) -> Res<TriggerSaves> {
    let one = |v: &Value| -> Res<TriggerSave> {
        if let Some(val) = cx.ref_val(v)?
            && let Some(Handle::Roll(r)) = cx.js.handle(val)?
        {
            return Ok(TriggerSave::Dc(*r));
        }
        Ok(TriggerSave::Spec(grant_save(cx, v, cond)?))
    };
    match v {
        Value::Array(list) => Ok(TriggerSaves::Many(
            list.iter().map(one).collect::<Res<_>>()?,
        )),
        _ => Ok(TriggerSaves::One(one(v)?)),
    }
}

// ---- conditions, substitutes, probes ---------------------------------------------------------------------------

fn condition_on(s: &str, id: &str) -> Res<ConditionOn> {
    use yipe_dice::turn::types::AttackTriggerOn as On;
    Ok(match s {
        "first-hit" => ConditionOn::Attack(On::FirstHit),
        "any-crit" => ConditionOn::Attack(On::AnyCrit),
        "any-miss" => ConditionOn::Attack(On::AnyMiss),
        "first-miss" => ConditionOn::Attack(On::FirstMiss),
        "every-hit" => ConditionOn::Attack(On::EveryHit),
        "first-crit" => ConditionOn::FirstCrit,
        "start" => ConditionOn::Start,
        other => {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                id,
                format!(
                    "Condition \"{id}\" triggers on \"{other}\"; a condition reads every-hit, first-hit, any-crit, first-crit, first-miss or any-miss."
                ),
            ));
        }
    })
}

fn condition(cx: &Cx, v: &Value, index: usize) -> Res<ConditionSpec> {
    let map = object(v, "a condition")?;
    let id = opt_id(map, "id")?;
    let hint = id
        .clone()
        .unwrap_or_else(|| format!("condition {}", index + 1));
    let on = match map.get("on") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => js_string_of(other),
        None => "undefined".to_string(),
    };
    let landing = match present(map, "landing") {
        None => None,
        Some(v) => Some(v.as_str().and_then(|s| save_landing(s).ok()).ok_or_else(|| {
            fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                &hint,
                format!("Condition \"{hint}\" declares landing \"{}\". Use \"fail\" or \"damage\".", js_string_of(v)),
            )
        })?),
    };
    Ok(ConditionSpec {
        id,
        on: condition_on(&on, &hint)?,
        of: opt_names(map, "of")?,
        r#where: present(map, "where").map(where_map).transpose()?,
        chance: opt_number(map, "chance")?,
        target_has: target_has(map, &hint, false)?,
        landing,
        dealing: opt_string(map, "dealing")?,
        target: opt_string(map, "target")?,
        save: present(map, "save")
            .map(|s| grant_saves(cx, s, &hint))
            .transpose()?,
        grants: effect_specs(cx, present(map, "grants").unwrap_or(&NULL))?,
        on_save: present(map, "onSave")
            .map(|e| effect_specs(cx, e))
            .transpose()?,
        optional: flag(map, "optional"),
    })
}

fn policy_of(v: &Value) -> Res<SubstitutePolicy> {
    let map = object(v, "policy")?;
    Ok(match need_string(map, "kind")?.as_str() {
        "always" => SubstitutePolicy::Always,
        "optimal" => SubstitutePolicy::Optimal,
        "below" => SubstitutePolicy::Below {
            hit: need_number(map.get("hit").unwrap_or(&NULL), "policy.hit")?,
            crit: need_number(map.get("crit").unwrap_or(&NULL), "policy.crit")?,
        },
        other => return bad(format!("unknown substitute policy {other:?}")),
    })
}

fn substitute(v: &Value, index: usize) -> Res<SubstituteSpec> {
    let map = object(v, "a substitute")?;
    let id = opt_id(map, "id")?;
    let hint = id
        .clone()
        .unwrap_or_else(|| format!("substitute {}", index + 1));
    let name = |key: &str| match map.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => js_string_of(other),
        None => "undefined".to_string(),
    };
    let (on, kind) = (name("on"), name("substitute"));
    let spec_kind = match (on.as_str(), kind.as_str()) {
        ("first-hit", "reroll-keep-higher") => {
            (SubstituteOn::FirstHit, SubstituteKind::RerollKeepHigher)
        }
        ("first-miss", "hit") => (SubstituteOn::FirstMiss, SubstituteKind::Hit),
        ("first-miss", "reroll") => (SubstituteOn::FirstMiss, SubstituteKind::Reroll),
        _ => {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                &hint,
                format!(
                    "Substitute \"{hint}\" must be {{ on: \"first-hit\", substitute: \"reroll-keep-higher\" }}, {{ on: \"first-miss\", substitute: \"hit\" }} or {{ on: \"first-miss\", substitute: \"reroll\" }}."
                ),
            ));
        }
    };
    let mode = match present(map, "mode") {
        None => None,
        Some(m) => Some(miss_mode(m, spec_kind.1 == SubstituteKind::Reroll, &hint)?),
    };
    Ok(SubstituteSpec {
        id,
        on: spec_kind.0,
        of: opt_names(map, "of")?,
        substitute: spec_kind.1,
        mode,
        policy: present(map, "policy").map(policy_of).transpose()?,
    })
}

/// A substitute's `mode`: only a first-miss reroll takes one, `reroll` or `add-d20`.
fn miss_mode(v: &Value, is_reroll: bool, id: &str) -> Res<MissRerollMode> {
    let mode = v
        .as_str()
        .and_then(|m| miss_reroll_mode(m).ok())
        .filter(|_| is_reroll);
    mode.ok_or_else(|| {
        fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            id,
            format!(
                "Substitute \"{id}\" has mode \"{}\": only a first-miss reroll takes a mode, \"reroll\" or \"add-d20\".",
                js_string_of(v)
            ),
        )
    })
}

fn probe(v: &Value, index: usize) -> Res<ProbeSpec> {
    let map = object(v, "a probe")?;
    let id = opt_id(map, "id")?;
    let hint = id.clone().unwrap_or_else(|| format!("probe {}", index + 1));
    let on = match map.get("on") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => js_string_of(other),
        None => "undefined".to_string(),
    };
    if on != "any-crit" {
        return Err(fail(
            TurnSpecErrorCode::UnsupportedTrigger,
            &hint,
            format!("Probe \"{hint}\" observes \"{on}\", which is not a probe. Use any-crit."),
        ));
    }
    Ok(ProbeSpec {
        id,
        on: ProbeOn::AnyCrit,
        of: opt_names(map, "of")?,
    })
}

// ---- the spec ------------------------------------------------------------------------------------------------------

fn each<T>(
    v: Option<&Value>,
    what: &str,
    f: impl Fn(usize, &Value) -> Res<T>,
) -> Res<Option<Vec<T>>> {
    v.map(|list| {
        items(list, what)?
            .iter()
            .enumerate()
            .map(|(i, x)| f(i, x))
            .collect()
    })
    .transpose()
}

/// A `TurnSpec`.
pub fn turn_spec(cx: &Cx, v: &Value) -> Res<TurnSpec> {
    let map = object(v, "a turn spec")?;
    Ok(TurnSpec {
        attacks: attacks(cx, present(map, "attacks").unwrap_or(&NULL), 0)?,
        riders: each(present(map, "riders"), "riders", |i, r| rider(cx, r, i))?,
        substitutes: each(present(map, "substitutes"), "substitutes", |i, s| {
            substitute(s, i)
        })?,
        conditions: each(present(map, "conditions"), "conditions", |i, c| {
            condition(cx, c, i)
        })?,
        observe: each(present(map, "observe"), "observe", |i, p| probe(p, i))?,
        state_limit: opt_number(map, "stateLimit")?,
    })
}

/// `turn(attacks)`.
pub fn turn_attacks(cx: &Cx, v: &Value) -> Res<Vec<Attack>> {
    attacks(cx, v, 0)
}

// ---- verbs ----------------------------------------------------------------------------------------------------------

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&NULL)
}

const GRANTS_TAKE_NO_MAX: &str = "max and perSource shape a damage rider, and this call has grants: a grant is never capped and has no payload. Add the damage in its own call.";

/// `Rider "id" needs a positive integer max`: a `max` that is not a number at all.
fn max_number(v: &Value, id: &str) -> Res<f64> {
    number(v).ok_or_else(|| {
        DiceError::Range(format!(
            "Rider \"{id}\" needs a positive integer max, got {}.",
            js_string_of(v)
        ))
    })
}

fn has_grants(e: &Effect) -> bool {
    match e {
        Effect::Damage(_) => false,
        Effect::Lasting(_) | Effect::Saved(_) => true,
        Effect::List(parts) => parts.iter().any(|p| matches!(p, EffectPart::Grant(_))),
    }
}

fn has_damage(e: &Effect) -> bool {
    match e {
        Effect::Damage(_) => true,
        Effect::Lasting(_) | Effect::Saved(_) => false,
        Effect::List(parts) => parts.iter().any(|p| matches!(p, EffectPart::Damage(_))),
    }
}

/// What owns an effect verb's options: the call's condition (grants only) or its rider.
struct Owner<'a> {
    /// The condition id a gate error names.
    condition: &'a str,
    /// Grants and no damage: the options belong to the condition.
    is_condition: bool,
}

fn condition_options(
    cx: &Cx,
    map: &Map<String, Value>,
    count: usize,
    owner: &Owner<'_>,
) -> Res<ConditionOptions> {
    Ok(ConditionOptions {
        rider: rider_options(cx, map, count, owner.is_condition)?,
        save: present(map, "save")
            .map(|s| trigger_saves(cx, s, owner.condition))
            .transpose()?,
        chance: opt_number(map, "chance")?,
        on_save: present(map, "onSave")
            .map(|e| lastings(cx, e))
            .transpose()?,
        dealing: opt_string(map, "dealing")?,
        optional: flag(map, "optional"),
        happens: opt_number(map, "happens")?,
    })
}

fn first_hit_options(
    cx: &Cx,
    map: &Map<String, Value>,
    count: usize,
    owner: &Owner<'_>,
    on: &str,
) -> Res<FirstHitOptions> {
    let hint = rider_hint(map, count);
    Ok(FirstHitOptions {
        condition: condition_options(cx, map, count, owner)?,
        per_source: present(map, "perSource")
            .map(|p| per_source(cx, p, &hint, on))
            .transpose()?,
    })
}

fn strs(list: &Option<Vec<String>>) -> Option<Vec<&str>> {
    list.as_ref()
        .map(|l| l.iter().map(String::as_str).collect())
}

/// The engine call a verb spells, on `turn`.
pub fn apply(
    cx: &Cx,
    turn: &yipe_dice::turn::Turn,
    name: &str,
    args: &[Value],
) -> Res<yipe_dice::turn::Turn> {
    let spec = turn.inspect_spec();
    let attack_count = spec.attacks.len();
    let rider_count = spec.riders.as_ref().map_or(0, Vec::len);
    let condition_count = spec.conditions.as_ref().map_or(0, Vec::len);
    let substitute_count = spec.substitutes.as_ref().map_or(0, Vec::len);
    let probe_count = spec.observe.as_ref().map_or(0, Vec::len);
    let hint = format!("rider {}", rider_count + 1);
    match name {
        "attack" => {
            let default_id = format!("attack {}", attack_count + 1);
            let options = match arg(args, 1) {
                Value::String(id) => AttackOptions {
                    id: Some(id.clone()),
                    ..AttackOptions::default()
                },
                other => {
                    let bag = options_of(other, "attack options")?;
                    attack_options(&bag, &default_id)?
                }
            };
            let id = options
                .id
                .clone()
                .unwrap_or_else(|| format!("attack {}", attack_count + 1));
            turn.attack_with(source(cx, arg(args, 0), &id)?, options)
        }
        "attacks" => {
            let count = need_number(arg(args, 0), "attacks(count)")?;
            let options = options_of(arg(args, 2), "attacks options")?;
            let id = format!("attack {}", attack_count + 1);
            turn.attacks_with(
                count,
                source(cx, arg(args, 1), &id)?,
                AttacksOptions {
                    tag: opt_string(&options, "tag")?,
                    chance: opt_number(&options, "chance")?,
                },
            )
        }
        "rider" => turn.rider(rider(cx, arg(args, 0), rider_count)?),
        "onFirstCrit" | "onFirstHit" | "onAnyCrit" | "onEveryHit" => {
            let on = match name {
                "onFirstCrit" => "first-crit",
                "onFirstHit" => "first-hit",
                "onAnyCrit" => "any-crit",
                _ => "every-hit",
            };
            let options = options_of(arg(args, 1), "options")?;
            let id = opt_id(&options, "id")?;
            let rider_id = id.clone().unwrap_or_else(|| hint.clone());
            let condition_default = format!("condition {}", condition_count + 1);
            let effect = match effect_arg(cx, arg(args, 0), &rider_id)? {
                EffectArg::Transform(t) if name == "onFirstHit" => {
                    let owner = Owner {
                        condition: &condition_default,
                        is_condition: false,
                    };
                    return turn.on_first_hit_transform(
                        t,
                        first_hit_options(cx, &options, rider_count, &owner, on)?,
                    );
                }
                EffectArg::Transform(_) => {
                    return Err(fail(
                        TurnSpecErrorCode::UnsupportedTrigger,
                        &rider_id,
                        format!(
                            "Rider \"{rider_id}\" carries a transform on \"{on}\". A transform is only accepted by onFirstHit."
                        ),
                    ));
                }
                EffectArg::Effect(e) => *e,
            };
            let grants = has_grants(&effect);
            let is_condition = grants && !has_damage(&effect);
            let condition = if is_condition {
                id.clone().unwrap_or(condition_default)
            } else {
                condition_default
            };
            let owner = Owner {
                condition: &condition,
                is_condition,
            };
            let (max, per) = (present(&options, "max"), present(&options, "perSource"));
            if grants && present(&options, "target").is_some() {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    "",
                    "A trigger takes no target: its effects go on the creature of the row that lands them. Use atStart(effect, { target }) for a creature's starting state.",
                ));
            }
            match name {
                "onFirstHit" if max.is_some() => {
                    return Err(if grants {
                        DiceError::Error(GRANTS_TAKE_NO_MAX.to_string())
                    } else {
                        fail(
                            TurnSpecErrorCode::UnsupportedTrigger,
                            &rider_id,
                            format!(
                                "Rider \"{rider_id}\" has a max on \"first-hit\". Only every-hit riders are capped; first-hit already applies once."
                            ),
                        )
                    });
                }
                "onFirstCrit" if grants && (max.is_some() || per.is_some()) => {
                    return bad(GRANTS_TAKE_NO_MAX);
                }
                "onAnyCrit" if max.is_some() || per.is_some() => {
                    if grants {
                        return bad(GRANTS_TAKE_NO_MAX);
                    }
                    if per.is_some() {
                        return Err(fail(
                            TurnSpecErrorCode::UnsupportedTrigger,
                            &rider_id,
                            format!(
                                "Rider \"{rider_id}\" has a payload per source on \"any-crit\". Only first-hit and every-hit riders take one."
                            ),
                        ));
                    }
                    // An any-crit rider carries its `max`, which `on_any_crit`'s options cannot.
                    if ["save", "chance", "onSave", "dealing", "optional"]
                        .iter()
                        .any(|k| present(&options, k).is_some())
                    {
                        return bad(
                            "save, chance, onSave, dealing and optional shape effects only, and this call has none: damage is never gated by them. Pass a SaveBuilder as the damage for damage that depends on a save.",
                        );
                    }
                    let Effect::Damage(damage) = effect else {
                        return bad("onAnyCrit with a max takes damage.");
                    };
                    let r = rider_options(cx, &options, rider_count, false)?;
                    return turn.rider(Rider {
                        trigger: Trigger::AnyCrit {
                            of: r.of,
                            max: max.map(|m| max_number(m, &rider_id)).transpose()?,
                        },
                        id: r.id,
                        damage: RiderDamageSpec::Plain(damage),
                        crit_damage: r.crit_damage,
                        landing: r.landing.map(RiderLanding::Save),
                        happens: opt_number(&options, "happens")?,
                        joins: r.joins,
                        r#where: r.r#where,
                        target_has: r.target_has,
                    });
                }
                _ => {}
            }
            match name {
                "onFirstCrit" => turn.on_first_crit_with(
                    effect,
                    condition_options(cx, &options, rider_count, &owner)?,
                ),
                "onFirstHit" => turn.on_first_hit_with(
                    effect,
                    first_hit_options(cx, &options, rider_count, &owner, on)?,
                ),
                "onAnyCrit" => turn.on_any_crit_with(
                    effect,
                    condition_options(cx, &options, rider_count, &owner)?,
                ),
                _ => {
                    let max = max.map(|m| max_number(m, &rider_id)).transpose()?;
                    turn.on_every_hit_with(
                        effect,
                        EveryHitOptions {
                            first_hit: first_hit_options(cx, &options, rider_count, &owner, on)?,
                            max,
                        },
                    )
                }
            }
        }
        "atStart" => {
            let options = options_of(arg(args, 1), "atStart options")?;
            let effects = match arg(args, 0) {
                Value::Array(list) => list
                    .iter()
                    .map(|e| start_effect(cx, e))
                    .collect::<Res<Vec<_>>>()?,
                one => vec![start_effect(cx, one)?],
            };
            turn.at_start(effects, opt_string(&options, "target")?.as_deref())
        }
        "stateLimit" => turn.state_limit(need_number(arg(args, 0), "stateLimit")?),
        "convertFirstMiss" => {
            let options = options_of(arg(args, 0), "options")?;
            let of = opt_names(&options, "of")?;
            turn.convert_first_miss(opt_id(&options, "id")?.as_deref(), strs(&of).as_deref())
        }
        "rerollFirstMiss" => {
            let options = options_of(arg(args, 0), "options")?;
            let of = opt_names(&options, "of")?;
            let id = opt_id(&options, "id")?;
            let substitute_id = id
                .clone()
                .unwrap_or_else(|| format!("substitute {}", substitute_count + 1));
            let mode = present(&options, "mode")
                .map(|m| miss_mode(m, true, &substitute_id))
                .transpose()?;
            turn.reroll_first_miss(id.as_deref(), strs(&of).as_deref(), mode)
        }
        "onAnyMiss" | "onFirstMiss" | "otherwise" | "onDiceMatch" => {
            let (value_at, options_at, on) = match name {
                "onAnyMiss" => (0, 1, "any-miss"),
                "onFirstMiss" => (0, 1, "first-miss"),
                "otherwise" => (0, 1, "not-fired"),
                _ => (1, 2, "dice-match"),
            };
            let options = options_of(arg(args, options_at), "options")?;
            let rider_opts = rider_options(cx, &options, rider_count, false)?;
            let id = rider_opts.id.clone().unwrap_or(hint);
            refuse_payload(cx, arg(args, value_at), &id, on)?;
            let damage = rider_damage(cx, arg(args, value_at), &id)?;
            match name {
                "onAnyMiss" => turn.on_any_miss_with(damage, rider_opts),
                "onFirstMiss" => turn.on_first_miss_with(damage, rider_opts),
                "otherwise" => turn.otherwise_with(damage, rider_opts),
                _ => {
                    let of = names_of(arg(args, 0), "of")?;
                    let of: Vec<&str> = of.iter().map(String::as_str).collect();
                    turn.on_dice_match_with(&of, damage, rider_opts)
                }
            }
        }
        "observe" => turn.observe(probe(arg(args, 0), probe_count)?),
        "observeAnyCrit" => {
            let options = options_of(arg(args, 1), "options")?;
            let of = opt_names(&options, "of")?;
            let id = match arg(args, 0) {
                Value::String(id) => id.clone(),
                other => {
                    return Err(fail(
                        TurnSpecErrorCode::NonStringId,
                        &js_string_of(other),
                        format!("An id must be a string, got {}.", js_typeof(other)),
                    ));
                }
            };
            turn.observe_any_crit(&id, strs(&of).as_deref())
        }
        "vsAC" => turn.vs_ac(need_number(arg(args, 0), "vsAC(ac)")?),
        other => bad(format!("dice-node: unknown Turn verb {other:?}")),
    }
}

/// `bounce({ source })`'s source.
pub fn bounce_source(cx: &Cx, v: &Value) -> Res<DamageSource> {
    damage(cx, v, "attack 1")
}
