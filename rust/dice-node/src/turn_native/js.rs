//! The raw N-API layer of the turn binding: the current `Env`, persistent references to JS values,
//! value conversion helpers, and the JS-backed Rust traits (`ToPmf`, `ContextualSource`,
//! `ContextualPayload`, `FailChance`, `Rng`).
//!
//! # Threading and the current `Env`
//! The engine stores the spec and may call a JS function lazily in a later reader call, so every
//! `#[napi]` method of `NativeTurn` enters through [`Entry::enter`], which sets the current `Env` in
//! a thread-local for the duration of the call (restored on drop, so nested native calls made from
//! inside a JS callback work). All calls happen on the JS thread.
//!
//! # A JS throw
//! A callback that throws is caught at the napi call: the exception value is held in a thread-local
//! ([`Js::check`]), the callback returns `Err(`[`DiceError::HostThrew`]`)` to the engine, and [`Entry::finish`]
//! rethrows the held value unchanged from the native call that triggered it (it wins over whatever
//! error the engine produced from the placeholder). A held value is a raw `napi_value`: it stays valid
//! because every callback runs inside the one native call that owns the handle scope.

use std::cell::Cell;
use std::ffi::CString;
use std::ptr;
use std::sync::Arc;

use napi::bindgen_prelude::{ClassInstance, FromNapiValue};
use napi::sys;
use yipe_dice::builder::attack::AttackBuilder;
use yipe_dice::builder::roll::RollBuilder;
use yipe_dice::builder::save::SaveBuilder;
use yipe_dice::builder::types::MissRerollMode;
use yipe_dice::common::DiceMatchInfo;
use yipe_dice::common::{Rng, RollType};
use yipe_dice::turn::context::{
    ContextualSource, Dealt, MatchPair, RollUnder, RowCheck, RowContext, RowKind, RowRange,
};
use yipe_dice::turn::types::{
    ContextualPayload, FailChance, LandingPayload, LandingRoll, ToPmf, TurnSpecError,
    TurnSpecErrorCode, VulnerableLanding, VulnerableRoll,
};
use yipe_dice::{Damage, DiceError, Pmf};

use crate::attack::NativeAttack;
use crate::pmf::NativePmf;
use crate::roll::NativeRoll;
use crate::save::NativeSave;

pub type Val = sys::napi_value;

thread_local! {
    static ENV: Cell<sys::napi_env> = const { Cell::new(ptr::null_mut()) };
    static HELD: Cell<Val> = const { Cell::new(ptr::null_mut()) };
    static KEPT: Cell<u64> = const { Cell::new(0) };
}

/// How many [`JsRef`]s this thread has made. A turn that holds a JS value is one whose decode raised
/// this count; such a turn may call back into JS whenever it is read, so it is read on the JS thread
/// only (see `batch.rs`).
pub fn kept() -> u64 {
    KEPT.get()
}

/// Whether a callback of the current native call threw (see [`Js::check`]).
pub fn throw_pending() -> bool {
    !HELD.get().is_null()
}

/// `new TurnSpecError("not-an-attack", id, message)`: a hand-written source that is no PMF.
fn not_an_attack(id: &str, message: &str) -> DiceError {
    DiceError::from(TurnSpecError::new(
        TurnSpecErrorCode::NotAnAttack,
        id,
        message,
    ))
}

/// The current native call: sets the `Env` and the held-exception slot, restores both on drop.
pub struct Entry {
    prev_env: sys::napi_env,
    prev_held: Val,
}

impl Entry {
    pub fn enter(env: sys::napi_env) -> Entry {
        Entry {
            prev_env: ENV.replace(env),
            prev_held: HELD.replace(ptr::null_mut()),
        }
    }

    /// The JS exception a callback threw during this call, if any.
    pub fn held(&self) -> Option<Val> {
        let held = HELD.get();
        if held.is_null() { None } else { Some(held) }
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        ENV.set(self.prev_env);
        HELD.set(self.prev_held);
    }
}

/// What kind of JS value a `napi_value` is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Undefined,
    Null,
    Bool,
    Number,
    Str,
    Symbol,
    Object,
    Function,
    Other,
}

/// The current `Env` and the calls on it. Every method that can run JS holds a JS throw (see the
/// module comment) and answers `Err(HostThrew)`.
#[derive(Clone, Copy)]
pub struct Js {
    pub env: sys::napi_env,
}

macro_rules! out {
    ($self:ident, $f:ident($($a:expr),*)) => {{
        let mut out = ptr::null_mut();
        // SAFETY: `env` is the live env of the native call that is running on this (the JS) thread;
        // every value passed is a handle of that call, and `out` is a valid out-pointer.
        $self.check(unsafe { sys::$f($self.env, $($a,)* &mut out) })?;
        out
    }};
}

impl Js {
    pub fn current() -> Result<Js, DiceError> {
        let env = ENV.get();
        if env.is_null() {
            return Err(DiceError::error(
                "dice-node: a JS callback ran outside a native call",
            ));
        }
        Ok(Js { env })
    }

    pub fn from_env(env: sys::napi_env) -> Js {
        Js { env }
    }

    /// `Ok` for a napi `ok`; for a pending JS exception holds it and answers [`DiceError::HostThrew`].
    fn check(&self, status: sys::napi_status) -> Result<(), DiceError> {
        if status == sys::Status::napi_ok {
            return Ok(());
        }
        let mut pending = false;
        // SAFETY: see `out!`.
        unsafe { sys::napi_is_exception_pending(self.env, &mut pending) };
        if pending {
            let mut exception = ptr::null_mut();
            // SAFETY: see `out!`.
            let taken = unsafe { sys::napi_get_and_clear_last_exception(self.env, &mut exception) };
            if taken == sys::Status::napi_ok && !exception.is_null() && HELD.get().is_null() {
                HELD.set(exception);
            }
            return Err(DiceError::HostThrew);
        }
        Err(DiceError::error(format!(
            "dice-node: napi call failed (status {status})"
        )))
    }

    pub fn kind(&self, v: Val) -> Result<Kind, DiceError> {
        let mut t = 0;
        // SAFETY: see `out!`.
        self.check(unsafe { sys::napi_typeof(self.env, v, &mut t) })?;
        Ok(match t {
            sys::ValueType::napi_undefined => Kind::Undefined,
            sys::ValueType::napi_null => Kind::Null,
            sys::ValueType::napi_boolean => Kind::Bool,
            sys::ValueType::napi_number => Kind::Number,
            sys::ValueType::napi_string => Kind::Str,
            sys::ValueType::napi_symbol => Kind::Symbol,
            sys::ValueType::napi_object => Kind::Object,
            sys::ValueType::napi_function => Kind::Function,
            _ => Kind::Other,
        })
    }

    pub fn undefined(&self) -> Result<Val, DiceError> {
        Ok(out!(self, napi_get_undefined()))
    }

    pub fn boolean(&self, b: bool) -> Result<Val, DiceError> {
        Ok(out!(self, napi_get_boolean(b)))
    }

    pub fn double(&self, x: f64) -> Result<Val, DiceError> {
        Ok(out!(self, napi_create_double(x)))
    }

    pub fn string(&self, s: &str) -> Result<Val, DiceError> {
        Ok(out!(
            self,
            napi_create_string_utf8(s.as_ptr().cast(), s.len() as isize)
        ))
    }

    pub fn object(&self) -> Result<Val, DiceError> {
        Ok(out!(self, napi_create_object()))
    }

    pub fn array(&self, len: usize) -> Result<Val, DiceError> {
        Ok(out!(self, napi_create_array_with_length(len)))
    }

    pub fn set(&self, object: Val, name: &str, value: Val) -> Result<(), DiceError> {
        with_c_name(name, |key| {
            // SAFETY: see `out!`; `key` outlives the call.
            self.check(unsafe { sys::napi_set_named_property(self.env, object, key, value) })
        })
    }

    pub fn set_index(&self, array: Val, index: usize, value: Val) -> Result<(), DiceError> {
        // SAFETY: see `out!`.
        self.check(unsafe { sys::napi_set_element(self.env, array, index as u32, value) })
    }

    pub fn get(&self, object: Val, name: &str) -> Result<Val, DiceError> {
        let key = c_name(name);
        Ok(out!(self, napi_get_named_property(object, key.as_ptr())))
    }

    pub fn get_index(&self, array: Val, index: usize) -> Result<Val, DiceError> {
        Ok(out!(self, napi_get_element(array, index as u32)))
    }

    pub fn len(&self, array: Val) -> Result<usize, DiceError> {
        let mut n = 0u32;
        // SAFETY: see `out!`.
        self.check(unsafe { sys::napi_get_array_length(self.env, array, &mut n) })?;
        Ok(n as usize)
    }

    pub fn to_f64(self, v: Val) -> Result<f64, DiceError> {
        let mut x = 0.0;
        // SAFETY: see `out!`.
        self.check(unsafe { sys::napi_get_value_double(self.env, v, &mut x) })
            .map_err(|e| {
                if matches!(e, DiceError::HostThrew) {
                    e
                } else {
                    DiceError::error("dice-node: expected a number")
                }
            })?;
        Ok(x)
    }

    pub fn to_bool(self, v: Val) -> Result<bool, DiceError> {
        let mut b = false;
        // SAFETY: see `out!`.
        self.check(unsafe { sys::napi_get_value_bool(self.env, v, &mut b) })
            .map_err(|e| {
                if matches!(e, DiceError::HostThrew) {
                    e
                } else {
                    DiceError::error("dice-node: expected a boolean")
                }
            })?;
        Ok(b)
    }

    pub fn to_string(self, v: Val) -> Result<String, DiceError> {
        let mut len = 0usize;
        // SAFETY: see `out!`; a null buffer asks for the length.
        self.check(unsafe {
            sys::napi_get_value_string_utf8(self.env, v, ptr::null_mut(), 0, &mut len)
        })
        .map_err(|e| {
            if matches!(e, DiceError::HostThrew) {
                e
            } else {
                DiceError::error("dice-node: expected a string")
            }
        })?;
        let mut buf = vec![0u8; len + 1];
        let mut written = 0usize;
        // SAFETY: `buf` has room for `len` bytes plus the terminator.
        self.check(unsafe {
            sys::napi_get_value_string_utf8(
                self.env,
                v,
                buf.as_mut_ptr().cast(),
                buf.len(),
                &mut written,
            )
        })?;
        buf.truncate(written);
        String::from_utf8(buf).map_err(|_| DiceError::error("dice-node: a string is not UTF-8"))
    }

    /// `function.call(this, ...args)`.
    pub fn call(&self, this: Val, function: Val, args: &[Val]) -> Result<Val, DiceError> {
        let mut result = ptr::null_mut();
        // SAFETY: see `out!`; `args` is a valid array of `args.len()` handles.
        self.check(unsafe {
            sys::napi_call_function(
                self.env,
                this,
                function,
                args.len(),
                args.as_ptr(),
                &mut result,
            )
        })?;
        Ok(result)
    }

    /// `object[name](...args)`.
    pub fn call_method(&self, object: Val, name: &str, args: &[Val]) -> Result<Val, DiceError> {
        let function = self.get(object, name)?;
        self.call(object, function, args)
    }

    /// Whether `object[name]` is a function.
    pub fn has_function(&self, object: Val, name: &str) -> Result<bool, DiceError> {
        Ok(self.kind(self.get(object, name)?)? == Kind::Function)
    }

    /// Whether `v` is `undefined` or `null`.
    pub fn is_nil(&self, v: Val) -> Result<bool, DiceError> {
        Ok(matches!(self.kind(v)?, Kind::Undefined | Kind::Null))
    }

    pub fn is_array(&self, v: Val) -> Result<bool, DiceError> {
        let mut b = false;
        // SAFETY: see `out!`.
        self.check(unsafe { sys::napi_is_array(self.env, v, &mut b) })?;
        Ok(b)
    }

    /// The own symbol-keyed property `description === description` of `object` that is `true`.
    pub fn has_true_symbol(&self, object: Val, description: &str) -> Result<bool, DiceError> {
        let keys = out!(
            self,
            napi_get_all_property_names(
                object,
                sys::KeyCollectionMode::own_only,
                sys::KeyFilter::skip_strings,
                sys::KeyConversion::keep_numbers
            )
        );
        for i in 0..self.len(keys)? {
            let key = self.get_index(keys, i)?;
            let described = self.get(key, "description")?;
            if self.kind(described)? == Kind::Str && self.to_string(described)? == description {
                let value = out!(self, napi_get_property(object, key));
                if self.kind(value)? == Kind::Bool && self.to_bool(value)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// A native class value (`NativePmf`, ...) as a JS value.
    pub fn class<T: napi::bindgen_prelude::ToNapiValue>(&self, value: T) -> Result<Val, DiceError> {
        // SAFETY: `env` is the live env of this call.
        unsafe { T::to_napi_value(self.env, value) }
            .map_err(|e| DiceError::error(e.reason.to_string()))
    }

    /// `v` as a native class instance of `T` (`None` for any other value).
    pub fn instance<T>(&self, v: Val) -> Option<ClassInstance<'static, T>>
    where
        T: 'static,
        ClassInstance<'static, T>: FromNapiValue,
    {
        // SAFETY: `env` and `v` belong to the running call; a value of another class is `Err`.
        unsafe { <ClassInstance<'static, T> as FromNapiValue>::from_napi_value(self.env, v) }.ok()
    }

    /// The native builder or PMF behind `v`: the value itself, or its own property `_handle` (a
    /// facade object carries its handle there).
    pub fn handle(&self, v: Val) -> Result<Option<Handle>, DiceError> {
        if self.kind(v)? != Kind::Object {
            return Ok(None);
        }
        if let Some(h) = self.handle_of(v) {
            return Ok(Some(h));
        }
        let inner = self.get(v, "_handle")?;
        if self.kind(inner)? != Kind::Object {
            return Ok(None);
        }
        Ok(self.handle_of(inner))
    }

    fn handle_of(&self, v: Val) -> Option<Handle> {
        if let Some(p) = self.instance::<NativePmf>(v) {
            return Some(Handle::Pmf(p.inner.clone()));
        }
        if let Some(r) = self.instance::<NativeRoll>(v) {
            return Some(Handle::Roll(Box::new(r.inner.clone())));
        }
        if let Some(a) = self.instance::<NativeAttack>(v) {
            return Some(Handle::Attack(Box::new(a.inner.clone())));
        }
        if let Some(s) = self.instance::<NativeSave>(v) {
            return Some(Handle::Save(Box::new(s.inner.clone())));
        }
        None
    }

    /// The PMF behind `v` (a native PMF or a facade PMF), if it is one.
    pub fn pmf(&self, v: Val) -> Result<Option<Arc<Pmf>>, DiceError> {
        Ok(match self.handle(v)? {
            Some(Handle::Pmf(p)) => Some(p),
            _ => None,
        })
    }
}

/// Runs `f` with `name` as a NUL-terminated C string, on the stack when it is short (no allocation).
fn with_c_name<R>(name: &str, f: impl FnOnce(*const std::os::raw::c_char) -> R) -> R {
    let mut buf = [0u8; 64];
    if name.len() < buf.len() && !name.as_bytes().contains(&0) {
        buf[..name.len()].copy_from_slice(name.as_bytes());
        return f(buf.as_ptr().cast());
    }
    let key = c_name(name);
    f(key.as_ptr())
}

fn c_name(name: &str) -> CString {
    // INFALLIBLE: callers pass identifier literals, which hold no NUL.
    CString::new(name.replace('\0', "")).unwrap_or_default()
}

/// A native value behind a JS value.
#[derive(Clone)]
pub enum Handle {
    Pmf(Arc<Pmf>),
    Roll(Box<RollBuilder>),
    Attack(Box<AttackBuilder>),
    Save(Box<SaveBuilder>),
}

// ---- persistent references -----------------------------------------------------------------------

/// A strong reference to a JS object or function that outlives the native call that made it.
pub struct JsRef {
    env: sys::napi_env,
    inner: sys::napi_ref,
}

// SAFETY: a `JsRef` is created, read and dropped only on the JS thread: every `#[napi]` method of
// `NativeTurn` runs there and the engine never hands one to another thread (nothing in `Turn`
// spawns). The Rust traits the wrappers implement ask for `Send + Sync` only because the engine's
// types are, in general, shareable; the JS value itself is only touched through `Js::current()`.
unsafe impl Send for JsRef {}
// SAFETY: see above.
unsafe impl Sync for JsRef {}

impl JsRef {
    pub fn new(js: &Js, value: Val) -> Result<JsRef, DiceError> {
        let mut inner = ptr::null_mut();
        // SAFETY: see `out!`.
        js.check(unsafe { sys::napi_create_reference(js.env, value, 1, &mut inner) })?;
        KEPT.set(KEPT.get() + 1);
        Ok(JsRef { env: js.env, inner })
    }

    pub fn get(&self, js: &Js) -> Result<Val, DiceError> {
        let mut value = ptr::null_mut();
        // SAFETY: `inner` is a live reference of `js.env`.
        js.check(unsafe { sys::napi_get_reference_value(js.env, self.inner, &mut value) })?;
        if value.is_null() {
            return Err(DiceError::error("dice-node: a JS value was collected"));
        }
        Ok(value)
    }
}

impl Drop for JsRef {
    fn drop(&mut self) {
        // SAFETY: `inner` is a live reference of `env`, deleted once, on the JS thread (see above).
        unsafe { sys::napi_delete_reference(self.env, self.inner) };
    }
}

// ---- row context out, row check in -----------------------------------------------------------------

/// A [`RowContext`] as the TS object.
pub fn context_to_js(js: &Js, c: &RowContext) -> Result<Val, DiceError> {
    let o = js.object()?;
    js.set(o, "rollType", js.string(c.roll_type.as_str())?)?;
    js.set(o, "autoHit", js.boolean(c.auto_hit)?)?;
    js.set(o, "critOnHit", js.boolean(c.crit_on_hit)?)?;
    js.set(o, "autoFail", js.boolean(c.auto_fail)?)?;
    js.set(o, "vulnerable", js.boolean(c.vulnerable)?)?;
    let dice = js.array(c.penalty_dice.len())?;
    for (i, d) in c.penalty_dice.iter().enumerate() {
        let die = js.object()?;
        js.set(die, "count", js.double(d.count)?)?;
        js.set(die, "sides", js.double(d.sides)?)?;
        js.set_index(dice, i, die)?;
    }
    js.set(o, "penaltyDice", dice)?;
    let joined = js.array(c.joined.len())?;
    for (i, id) in c.joined.iter().enumerate() {
        js.set_index(joined, i, js.string(id)?)?;
    }
    js.set(o, "joined", joined)?;
    Ok(o)
}

fn roll_type_of(js: &Js, v: Val) -> Result<RollType, DiceError> {
    let name = js.to_string(v)?;
    RollType::parse(&name)
        .ok_or_else(|| DiceError::error(format!("dice-node: unknown roll type {name:?}")))
}

fn flag(js: &Js, o: Val, name: &str) -> Result<bool, DiceError> {
    let v = js.get(o, name)?;
    Ok(js.kind(v)? == Kind::Bool && js.to_bool(v)?)
}

fn optional_string(js: &Js, o: Val, name: &str) -> Result<Option<String>, DiceError> {
    let v = js.get(o, name)?;
    Ok(if js.kind(v)? == Kind::Str {
        Some(js.to_string(v)?)
    } else {
        None
    })
}

/// A [`RowCheck`] from the plain object a hand-written source declares.
pub fn row_check_from_js(js: &Js, o: Val) -> Result<RowCheck, DiceError> {
    let kind = match optional_string(js, o, "kind")?.as_deref() {
        Some("attack") => RowKind::Attack,
        Some("save") => RowKind::Save,
        Some("auto") => RowKind::Auto,
        other => {
            return Err(DiceError::error(format!(
                "dice-node: rowCheck.kind is {other:?}, not attack, save or auto"
            )));
        }
    };
    let range = match optional_string(js, o, "range")?.as_deref() {
        Some("melee") => Some(RowRange::Melee),
        Some("ranged") => Some(RowRange::Ranged),
        _ => None,
    };
    let roll_type = roll_type_of(js, js.get(o, "rollType")?)?;
    let dice = js.get(o, "advantageDice")?;
    let advantage_dice = if js.kind(dice)? == Kind::Number && js.to_f64(dice)? == 3.0 {
        3
    } else {
        2
    };
    Ok(RowCheck {
        kind,
        range,
        ability: optional_string(js, o, "ability")?,
        roll_type,
        advantage_dice,
        pinned: flag(js, o, "pinned")?,
        auto_hit: flag(js, o, "autoHit")?,
        auto_crit: flag(js, o, "autoCrit")?,
        auto_fail: flag(js, o, "autoFail")?,
    })
}

// ---- JS-backed traits ------------------------------------------------------------------------------

/// A hand-written `{ toPMF(eps) }`.
pub struct JsToPmf {
    pub object: JsRef,
    /// The id a `not-an-attack` error names (what the TS engine knew at that call).
    pub id: String,
}

impl ToPmf for JsToPmf {
    fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        if !js.has_function(object, "toPMF")? {
            return Err(not_an_attack(
                &self.id,
                &format!(
                    "\"{}\" is neither a PMF nor a builder with toPMF().",
                    self.id
                ),
            ));
        }
        let result = js.call_method(object, "toPMF", &[js.double(eps)?])?;
        match js.pmf(result)? {
            Some(p) => Ok((*p).clone()),
            None => Err(not_an_attack(
                &self.id,
                &format!("\"{}\" has a toPMF() that did not return a PMF.", self.id),
            )),
        }
    }
}

/// A hand-written `ContextualSource`.
pub struct JsContextual {
    pub object: JsRef,
    pub id: String,
    pub check: RowCheck,
    pub has_rerolled_under: bool,
    pub has_dealt: bool,
    pub has_miss_rerolled_under: bool,
    pub ignores_joined: bool,
}

impl JsContextual {
    /// The PMF a hand-written source returned, shared with the JS object that holds it.
    fn pmf_from(&self, what: &str, result: Val, js: &Js) -> Result<Arc<Pmf>, DiceError> {
        match js.pmf(result)? {
            Some(p) => Ok(p),
            None => Err(not_an_attack(
                &self.id,
                &format!("\"{}\" has {what} that did not return a PMF.", self.id),
            )),
        }
    }

    fn call_under(&self, context: &RowContext, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let result = js.call_method(
            object,
            "under",
            &[context_to_js(&js, context)?, js.double(eps)?],
        )?;
        self.pmf_from("an under()", result, &js)
    }
}

impl ContextualSource for JsContextual {
    fn row_check(&self) -> RowCheck {
        self.check.clone()
    }

    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        self.call_under(context, eps).map(|p| (*p).clone())
    }

    fn under_shared(&self, context: &RowContext, eps: f64) -> Result<Arc<Pmf>, DiceError> {
        self.call_under(context, eps)
    }

    fn has_rerolled_under(&self) -> bool {
        self.has_rerolled_under
    }

    fn rerolled_under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let result = js.call_method(
            object,
            "rerolledUnder",
            &[context_to_js(&js, context)?, js.double(eps)?],
        )?;
        self.pmf_from("a rerolledUnder()", result, &js)
            .map(|p| (*p).clone())
    }

    fn dice_match_info(&self, eps: f64) -> Result<MatchPair, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        if !js.has_function(object, "diceMatchInfo")? {
            return Ok((None, None));
        }
        let result = js.call_method(object, "diceMatchInfo", &[js.double(eps)?])?;
        Ok((
            match_info(&js, js.get(result, "hit")?)?,
            match_info(&js, js.get(result, "crit")?)?,
        ))
    }

    fn dice_match_refusals(&self) -> Result<(Option<String>, Option<String>), DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        if !js.has_function(object, "diceMatchRefusals")? {
            return Ok((None, None));
        }
        let result = js.call_method(object, "diceMatchRefusals", &[])?;
        let text = |name: &str| -> Result<Option<String>, DiceError> {
            let v = js.get(result, name)?;
            if js.is_nil(v)? {
                Ok(None)
            } else {
                js.to_string(v).map(Some)
            }
        };
        Ok((text("hit")?, text("crit")?))
    }

    fn has_dealt(&self) -> bool {
        self.has_dealt
    }

    fn dealt(&self, type_: &str, context: &RowContext) -> Result<Dealt, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let result = js.call_method(
            object,
            "dealt",
            &[js.string(type_)?, context_to_js(&js, context)?],
        )?;
        dealt_of(&js, result)
    }

    fn roll_under(&self, context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        if !js.has_function(object, "rollUnder")? {
            return Ok(None);
        }
        let result = js.call_method(object, "rollUnder", &[context_to_js(&js, context)?])?;
        if js.is_nil(result)? {
            return Ok(None);
        }
        match js.handle(result)? {
            Some(Handle::Attack(a)) => Ok(Some(RollUnder::Attack(a))),
            Some(Handle::Save(s)) => Ok(Some(RollUnder::Save(s))),
            Some(Handle::Roll(r)) => Ok(Some(RollUnder::Roll(*r))),
            _ => Err(DiceError::error(
                "dice-node: rollUnder() must return an AttackBuilder, SaveBuilder or RollBuilder",
            )),
        }
    }

    fn has_miss_rerolled_under(&self) -> bool {
        self.has_miss_rerolled_under
    }

    fn miss_rerolled_under(
        &self,
        context: &RowContext,
        mode: MissRerollMode,
        eps: f64,
    ) -> Result<Pmf, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let result = js.call_method(
            object,
            "missRerolledUnder",
            &[
                context_to_js(&js, context)?,
                js.string(mode.as_str())?,
                js.double(eps)?,
            ],
        )?;
        self.pmf_from("a missRerolledUnder()", result, &js)
            .map(|p| (*p).clone())
    }

    fn ignores_joined(&self) -> bool {
        self.ignores_joined
    }
}

fn dealt_of(js: &Js, v: Val) -> Result<Dealt, DiceError> {
    if js.kind(v)? != Kind::Object {
        return Err(DiceError::error(
            "dice-node: dealt() must return { hit, crit }",
        ));
    }
    Ok(Dealt {
        hit: js.to_f64(js.get(v, "hit")?)?,
        crit: js.to_f64(js.get(v, "crit")?)?,
    })
}

/// A hand-written `ContextualPayload`.
pub struct JsPayload {
    pub object: JsRef,
    pub has_dealt: bool,
    pub has_roll_at: bool,
}

/// A landing payload's PMF as the JS object's own `Arc`: the same JS PMF always gives the same
/// address, so the engine's per-PMF weights merge as the TS's per-object ones do.
fn pmf_prop(js: &Js, o: Val, name: &str) -> Result<Arc<Pmf>, DiceError> {
    match js.pmf(js.get(o, name)?)? {
        Some(p) => Ok(p),
        None => Err(DiceError::error(format!(
            "dice-node: a landing payload's {name} is not a PMF"
        ))),
    }
}

/// A `DiceMatchInfo` (`{ matchProbabilityByDamage: Map<number, number> }`), or `None` for null.
fn match_info(js: &Js, v: Val) -> Result<Option<DiceMatchInfo>, DiceError> {
    if js.is_nil(v)? {
        return Ok(None);
    }
    let map = js.get(v, "matchProbabilityByDamage")?;
    let iterator = js.call_method(map, "entries", &[])?;
    let mut by_damage = indexmap::IndexMap::new();
    loop {
        let step = js.call_method(iterator, "next", &[])?;
        if js.to_bool(js.get(step, "done")?)? {
            break;
        }
        let entry = js.get(step, "value")?;
        by_damage.insert(
            Damage(js.to_f64(js.get_index(entry, 0)?)?),
            js.to_f64(js.get_index(entry, 1)?)?,
        );
    }
    Ok(Some(DiceMatchInfo {
        match_probability_by_damage: by_damage,
    }))
}

fn roll_prop(js: &Js, o: Val, name: &str) -> Result<RollBuilder, DiceError> {
    match js.handle(js.get(o, name)?)? {
        Some(Handle::Roll(r)) => Ok(*r),
        _ => Err(DiceError::error(format!(
            "dice-node: a landing roll's {name} is not a RollBuilder"
        ))),
    }
}

impl ContextualPayload for JsPayload {
    fn at(&self, attack_id: &str) -> Result<LandingPayload, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let at = js.call_method(object, "at", &[js.string(attack_id)?])?;
        let vulnerable = js.get(at, "vulnerable")?;
        Ok(LandingPayload {
            on_hit: pmf_prop(&js, at, "onHit")?,
            on_crit: pmf_prop(&js, at, "onCrit")?,
            vulnerable: VulnerableLanding {
                on_hit: pmf_prop(&js, vulnerable, "onHit")?,
                on_crit: pmf_prop(&js, vulnerable, "onCrit")?,
            },
        })
    }

    fn has_dealt(&self) -> bool {
        self.has_dealt
    }

    fn dealt(&self, type_: &str, attack_id: &str) -> Result<Dealt, DiceError> {
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let result =
            js.call_method(object, "dealt", &[js.string(type_)?, js.string(attack_id)?])?;
        dealt_of(&js, result)
    }

    fn roll_at(&self, attack_id: &str) -> Result<Option<LandingRoll>, DiceError> {
        if !self.has_roll_at {
            return Ok(None);
        }
        let js = Js::current()?;
        let object = self.object.get(&js)?;
        let result = js.call_method(object, "rollAt", &[js.string(attack_id)?])?;
        if js.is_nil(result)? {
            return Ok(None);
        }
        let vulnerable = js.get(result, "vulnerable")?;
        let vulnerable = if js.is_nil(vulnerable)? {
            None
        } else {
            Some(VulnerableRoll {
                on_hit: roll_prop(&js, vulnerable, "onHit")?,
                on_crit: roll_prop(&js, vulnerable, "onCrit")?,
            })
        };
        Ok(Some(LandingRoll {
            on_hit: roll_prop(&js, result, "onHit")?,
            on_crit: roll_prop(&js, result, "onCrit")?,
            vulnerable,
        }))
    }
}

/// A `GrantSaveSpec.failChance` function.
pub fn fail_chance(function: JsRef) -> FailChance {
    FailChance::new(move |context| {
        let js = Js::current()?;
        let f = function.get(&js)?;
        let result = js.call(js.undefined()?, f, &[context_to_js(&js, context)?])?;
        js.to_f64(result)
    })
}

// ---- rng ---------------------------------------------------------------------------------------------

/// `Rng` over two JS callbacks. After a JS throw the sampler finishes on dummy draws; the held
/// exception is rethrown by [`Entry::finish`].
pub struct RawRng {
    pub js: Js,
    pub die: Val,
    pub chance: Val,
    pub failed: Option<DiceError>,
}

impl Rng for RawRng {
    fn die(&mut self, sides: f64) -> f64 {
        if self.failed.is_some() {
            return 1.0;
        }
        let drawn = self
            .js
            .undefined()
            .and_then(|this| Ok((this, self.js.double(sides)?)))
            .and_then(|(this, arg)| self.js.call(this, self.die, &[arg]))
            .and_then(|v| self.js.to_f64(v));
        match drawn {
            Ok(v) => v,
            Err(e) => {
                self.failed = Some(e);
                1.0
            }
        }
    }

    fn chance(&mut self, p: f64) -> bool {
        if self.failed.is_some() {
            return false;
        }
        let drawn = self
            .js
            .undefined()
            .and_then(|this| Ok((this, self.js.double(p)?)))
            .and_then(|(this, arg)| self.js.call(this, self.chance, &[arg]))
            .and_then(|v| self.js.to_bool(v));
        match drawn {
            Ok(v) => v,
            Err(e) => {
                self.failed = Some(e);
                false
            }
        }
    }
}
