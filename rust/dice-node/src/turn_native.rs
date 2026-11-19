//! `NativeTurn`: the Rust turn engine (`yipe_dice::turn`) behind the TS facade `Turn`
//! (`ts-turn/turn/turn.ts`). A `Turn` is immutable, so every verb answers a new handle.
//!
//! # Wire contract
//! - A spec or a verb's arguments cross as `(json: string, refs: unknown[])`; see `decode.rs`. Every
//!   function a spec holds (`failChance`, a hand-written source's methods, an rng) is called back
//!   synchronously, on the JS thread, by whichever native call needs it, possibly lazily in a later
//!   reader call: see `js.rs` for how the current `Env` is kept and how a JS throw travels.
//! - `NativeTurn.fromSpec(spec, refs, eps, walked)`, `turnOf(attacks, refs, eps)`,
//!   `bounceOf(source, refs, max)`; `verb(name, args, refs)` with the TS method name and the call's
//!   positional arguments as a JSON array; the readers by their TS names (camelCase), plus
//!   `eps()` and `attackSingles()` (the `singles` of `toQuery()`).
//!
//! # Errors
//! Every failure is a thrown JS error, thrown from the native call that hit it: an `Error` whose
//! message is the tagged class of the engine's `DiceError` (`crate::error`), which `ts/native.ts`
//! turns into the TS class (`TurnSpecError` with its `code` and `id`, `RangeError`, ...). A throw
//! inside a JS callback is rethrown unchanged (the very value).
//!
//! No `unwrap`/`expect`/`panic` on an input-reachable path; a panic that still happens is caught and
//! thrown as an `Error`, never unwound across napi.

mod decode;
pub(crate) mod js;
pub(crate) mod out;

use std::ffi::CString;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::sys;
use napi::{Env, Status};
use napi_derive::napi;
use serde_json::Value;
use yipe_dice::Pmf;
use yipe_dice::error::DiceError;
use yipe_dice::turn::{Marginal, Turn, bounce};

use crate::error::tagged;
use crate::pmf::NativePmf;
use decode::{Cx, Res};
use js::{Entry, Js, RawRng, Val};

// ---- errors ------------------------------------------------------------------------------------------

fn c_string(s: &str) -> CString {
    // INFALLIBLE: NULs are removed first.
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

/// Throws `e` as the JS error the module comment names, and answers the napi error that leaves it
/// pending.
pub(crate) fn raise(env: sys::napi_env, e: DiceError) -> napi::Error {
    let message = c_string(&tagged(&e));
    // SAFETY: `env` is the live env of the running native call; the string outlives the call.
    unsafe { sys::napi_throw_error(env, std::ptr::null(), message.as_ptr()) };
    napi::Error::new(Status::PendingException, "")
}

/// Runs a native call: sets the current `Env`, catches a panic, and rethrows a held JS exception
/// (which wins) or the engine's error.
pub(crate) fn run<T>(env: Env, f: impl FnOnce(&Js) -> Res<T>) -> napi::Result<T> {
    let raw = env.raw();
    let entry = Entry::enter(raw);
    let js = Js::from_env(raw);
    let outcome = match catch_unwind(AssertUnwindSafe(|| f(&js))) {
        Ok(r) => r,
        Err(_) => Err(DiceError::Error(
            "dice-node: internal error (a Rust panic was caught)".to_string(),
        )),
    };
    if let Some(held) = entry.held() {
        // SAFETY: `held` is a handle of this call's scope (see `js.rs`).
        unsafe { sys::napi_throw(raw, held) };
        return Err(napi::Error::new(Status::PendingException, ""));
    }
    outcome.map_err(|e| raise(raw, e))
}

fn json_of(text: &str) -> Res<Value> {
    serde_json::from_str(text)
        .map_err(|e| DiceError::Error(format!("dice-node: bad turn JSON: {e}")))
}

pub(crate) fn raw_of(env: Env, v: Unknown<'_>) -> Res<Val> {
    // SAFETY: `env` is the live env of this call and `v` one of its arguments.
    unsafe { Unknown::to_napi_value(env.raw(), v) }
        .map_err(|e| DiceError::Error(e.reason.to_string()))
}

pub(crate) fn out_value(env: Env, v: Val) -> Unknown<'static> {
    // SAFETY: `v` is a handle created in this call's scope.
    unsafe { Unknown::from_raw_unchecked(env.raw(), v) }
}

// ---- the handle -----------------------------------------------------------------------------------------

#[napi]
pub struct NativeTurn {
    pub(crate) turn: Turn,
    pub(crate) eps: f64,
    pub(crate) pmf: Mutex<Option<Arc<Pmf>>>,
    /// Holds a JS value (a callback or hand-written source), so it may call back into JS whenever it
    /// is read: it is read on the JS thread only (see `batch.rs`). Inherited by every derived turn.
    pub(crate) js_bound: bool,
}

impl NativeTurn {
    fn new(turn: Turn, eps: f64, js_bound: bool) -> NativeTurn {
        NativeTurn {
            turn,
            eps,
            pmf: Mutex::new(None),
            js_bound,
        }
    }
}

/// `turn(attacks, eps)`.
#[napi(js_name = "turnOf")]
pub fn turn_of(env: Env, attacks: String, refs: Unknown<'_>, eps: f64) -> napi::Result<NativeTurn> {
    run(env, |js| {
        let kept = js::kept();
        let cx = Cx {
            js: *js,
            refs: raw_of(env, refs)?,
            eps,
        };
        let list = decode::turn_attacks(&cx, &json_of(&attacks)?)?;
        Ok(NativeTurn::new(
            yipe_dice::turn::turn(list, eps)?,
            eps,
            js::kept() != kept,
        ))
    })
}

/// `bounce({ source, max })`.
#[napi(js_name = "bounceOf")]
pub fn bounce_of(
    env: Env,
    source: String,
    refs: Unknown<'_>,
    max: f64,
) -> napi::Result<NativeTurn> {
    run(env, |js| {
        let kept = js::kept();
        let cx = Cx {
            js: *js,
            refs: raw_of(env, refs)?,
            eps: 0.0,
        };
        let source = decode::bounce_source(&cx, &json_of(&source)?)?;
        Ok(NativeTurn::new(
            bounce(source, max)?,
            0.0,
            js::kept() != kept,
        ))
    })
}

#[napi]
impl NativeTurn {
    /// `Turn.from(spec, eps)`; `walked` is `walkEverything.forced`.
    #[napi(factory)]
    pub fn from_spec(
        env: Env,
        spec: String,
        refs: Unknown<'_>,
        eps: f64,
        walked: bool,
    ) -> napi::Result<NativeTurn> {
        run(env, |js| {
            let kept = js::kept();
            let cx = Cx {
                js: *js,
                refs: raw_of(env, refs)?,
                eps,
            };
            let spec = decode::turn_spec(&cx, &json_of(&spec)?)?;
            let turn = if walked {
                Turn::from_spec_walked(spec, eps)?
            } else {
                Turn::from_spec(spec, eps)?
            };
            Ok(NativeTurn::new(turn, eps, js::kept() != kept))
        })
    }

    /// A chaining verb by its TS method name; `args` is the JSON array of its positional arguments.
    #[napi]
    pub fn verb(
        &self,
        env: Env,
        name: String,
        args: String,
        refs: Unknown<'_>,
    ) -> napi::Result<NativeTurn> {
        run(env, |js| {
            let kept = js::kept();
            let cx = Cx {
                js: *js,
                refs: raw_of(env, refs)?,
                eps: self.eps,
            };
            let Value::Array(list) = json_of(&args)? else {
                return Err(DiceError::Error(
                    "dice-node: a verb's arguments are a JSON array".to_string(),
                ));
            };
            let turn = decode::apply(&cx, &self.turn, &name, &list)?;
            Ok(NativeTurn::new(
                turn,
                self.eps,
                self.js_bound || js::kept() != kept,
            ))
        })
    }

    /// The epsilon the turn was built at.
    #[napi]
    pub fn eps(&self) -> f64 {
        self.eps
    }

    /// The joint distribution (one shared PMF per turn, so identity holds).
    #[napi]
    pub fn pmf(&self, env: Env) -> napi::Result<NativePmf> {
        run(env, |_| {
            let known = self.pmf.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(p) = known {
                return Ok(NativePmf::wrap_shared(p));
            }
            // Computed outside the lock: a JS callback may read this turn again.
            let made = Arc::new(self.turn.pmf()?);
            let mut slot = self.pmf.lock().unwrap_or_else(|e| e.into_inner());
            let shared = slot.get_or_insert(made).clone();
            Ok(NativePmf::wrap_shared(shared))
        })
    }

    #[napi]
    pub fn mean(&self, env: Env) -> napi::Result<f64> {
        run(env, |_| self.turn.mean())
    }

    /// The declared attacks' PMFs: the `singles` of `toQuery()`.
    #[napi]
    pub fn attack_singles(&self, env: Env) -> napi::Result<Vec<NativePmf>> {
        run(env, |_| {
            Ok(self
                .turn
                .inspect_plan()?
                .attack_singles
                .iter()
                .cloned()
                .map(NativePmf::wrap_shared)
                .collect())
        })
    }

    #[napi]
    pub fn attack_ids(&self, env: Env) -> napi::Result<Vec<String>> {
        run(env, |_| self.turn.attack_ids())
    }

    #[napi]
    pub fn rider_ids(&self, env: Env) -> napi::Result<Vec<String>> {
        run(env, |_| self.turn.rider_ids())
    }

    #[napi]
    pub fn substitute_ids(&self, env: Env) -> napi::Result<Vec<String>> {
        run(env, |_| self.turn.substitute_ids())
    }

    #[napi]
    pub fn condition_ids(&self, env: Env) -> napi::Result<Vec<String>> {
        run(env, |_| self.turn.condition_ids())
    }

    #[napi]
    pub fn probe_ids(&self, env: Env) -> napi::Result<Vec<String>> {
        run(env, |_| self.turn.probe_ids())
    }

    /// An attack: `[occurs, rollTypeIdx, pmfAddr, whenAddr]` (see `out::marginal_packed`); a rider:
    /// `{ kind: "rider", pmf, landings: [[id, RowLanding]...], anyLanding }`.
    #[napi]
    pub fn marginal(&self, env: Env, id: String) -> napi::Result<Unknown<'static>> {
        run(env, |js| {
            let m = self.turn.marginal(&id)?;
            Ok(out_value(env, out::marginal_packed(js, &m)?))
        })
    }

    /// The attack marginal's `pmf` (`which == "pmf"`) or `whenHappens` as a handle on the `Arc` the
    /// turn memoizes, which is the address `marginal` answered for it.
    #[napi]
    pub fn marginal_pmf(&self, env: Env, id: String, which: String) -> napi::Result<NativePmf> {
        run(env, |_| match &*self.turn.marginal(&id)? {
            Marginal::Attack(a) if which == "pmf" => Ok(NativePmf::wrap_shared(a.pmf.clone())),
            Marginal::Attack(a) if which == "whenHappens" => {
                Ok(NativePmf::wrap_shared(a.when_happens.clone()))
            }
            _ => Err(DiceError::Error(format!(
                "dice-node: \"{id}\" has no attack marginal \"{which}\""
            ))),
        })
    }

    #[napi]
    pub fn fire_probability(&self, env: Env, id: String) -> napi::Result<f64> {
        run(env, |_| self.turn.fire_probability(&id))
    }

    #[napi]
    pub fn expected_applications(&self, env: Env, id: String) -> napi::Result<f64> {
        run(env, |_| self.turn.expected_applications(&id))
    }

    #[napi]
    pub fn attempt_probability(&self, env: Env, id: String) -> napi::Result<f64> {
        run(env, |_| self.turn.attempt_probability(&id))
    }

    /// TS `StepStats`.
    #[napi]
    pub fn step_stats(&self, env: Env, id: String) -> napi::Result<Unknown<'static>> {
        run(env, |js| {
            let stats = self.turn.step_stats(&id)?;
            Ok(out_value(env, out::step_stats(js, &stats)?))
        })
    }

    /// TS `LandingPattern[]`.
    #[napi]
    pub fn landings(&self, env: Env, id: String) -> napi::Result<Unknown<'static>> {
        run(env, |js| {
            let patterns = self.turn.landings(&id)?;
            Ok(out_value(env, out::landings(js, &patterns)?))
        })
    }

    #[napi]
    pub fn peak_states(&self, env: Env) -> napi::Result<f64> {
        run(env, |_| Ok(self.turn.peak_states()? as f64))
    }

    /// One play of the turn (TS `Trace`); `die(sides)` and `chance(p)` are the rng.
    #[napi]
    pub fn sample(
        &self,
        env: Env,
        die: Unknown<'_>,
        chance: Unknown<'_>,
    ) -> napi::Result<Unknown<'static>> {
        run(env, |js| {
            let mut rng = RawRng {
                js: *js,
                die: raw_of(env, die)?,
                chance: raw_of(env, chance)?,
                failed: None,
            };
            let drawn = self.turn.sample(&mut rng);
            if let Some(error) = rng.failed.take() {
                // A JS throw is rethrown by `run`; any other failure of a callback ends here.
                return Err(error);
            }
            Ok(out_value(env, out::trace(js, &drawn?)?))
        })
    }

    /// `{ groupCount, stateCounts }`.
    #[napi]
    pub fn inspect_turn(&self, env: Env) -> napi::Result<Unknown<'static>> {
        run(env, |js| {
            let (groups, counts) = self.turn.inspect_turn()?;
            Ok(out_value(env, out::inspection(js, groups, &counts)?))
        })
    }
}
