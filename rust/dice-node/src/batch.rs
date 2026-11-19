//! `evaluateTurns`: read many `NativeTurn`s in one napi crossing (ADR-018; Rust side in
//! `yipe_dice::turn::batch`).
//!
//! # Threading
//! Turns that hold no JS value are read on rayon's pool (with the engine's `parallel` feature, unless
//! `request.parallel` is false); the JS thread waits for them. A turn that holds a JS callback or a
//! hand-written source (`NativeTurn::js_bound`, inherited by every turn derived from it) may call
//! back into JS whenever it is read, and a napi `Env` is usable on the JS thread only, so those turns
//! are read afterwards, one after the other, on the JS thread (the pool does not run them). A JS throw
//! inside such a callback aborts the whole call and is rethrown unchanged, as a single reader call
//! would. Results do not depend on how the turns were scheduled.
//!
//! # Result
//! One plain object; numbers cross as one `Float64Array`, the rest as flat arrays indexed by
//! `cell = turnIndex * cells + acIndex` (`cells` is `max(1, acs.length)`):
//! - `cells`, `stride`: `scalars[cell * stride ..]` is
//!   `[mean?, peakStates?, fireProbability..., expectedApplications...]` (NaN for a failed turn);
//! - `pmfs[cell]` (only with `request.pmf`): a `NativePmf`; without `acs` it is the turn's own shared
//!   PMF (the one `NativeTurn#pmf` answers);
//! - `marginals[cell]`, `stepStats[cell]`, `landings[cell]`: flat `[id, value, id, value, ...]` lists, the
//!   request's ids first and then (`allMarginals`, `allStepStats`, `allLandings`) the turn's own ids; the
//!   values are what `NativeTurn#marginal` / `#stepStats` / `#landings` answer;
//! - `errors[turnIndex]`: `undefined`, or for a turn that failed (the error its first failing reader
//!   would throw) the message of the `Error` that throw would be: `crate::error::tagged`.

use std::sync::Arc;

use napi::Env;
use napi::bindgen_prelude::{ClassInstance, Float64Array, Unknown};
use napi_derive::napi;
use yipe_dice::error::DiceError;
use yipe_dice::turn::Turn;
use yipe_dice::turn::batch::{ReadRequest, TurnReadings, evaluate_turn_refs};

use crate::error::tagged;
use crate::pmf::NativePmf;
use crate::turn_native::js::{self, Js, Val};
use crate::turn_native::{NativeTurn, out, out_value, run};

/// What to read from every turn (see `ReadRequest` in `yipe_dice::turn::batch`).
#[napi(object)]
pub struct NativeReadRequest {
    pub mean: bool,
    pub pmf: bool,
    pub marginals: Vec<String>,
    pub step_stats: Vec<String>,
    pub fire_probability: Vec<String>,
    pub expected_applications: Vec<String>,
    pub acs: Vec<f64>,
    pub all_marginals: bool,
    pub all_step_stats: bool,
    pub all_landings: bool,
    pub peak_states: bool,
    /// Use rayon for the turns that can run off the JS thread.
    pub parallel: bool,
}

type Outcome = Result<TurnReadings, DiceError>;

fn read_request(r: NativeReadRequest) -> (ReadRequest, bool) {
    let parallel = r.parallel;
    let request = ReadRequest {
        mean: r.mean,
        pmf: r.pmf,
        marginals: r.marginals,
        step_stats: r.step_stats,
        fire_probability: r.fire_probability,
        expected_applications: r.expected_applications,
        all_marginals: r.all_marginals,
        all_step_stats: r.all_step_stats,
        all_landings: r.all_landings,
        peak_states: r.peak_states,
        acs: r.acs,
    };
    (request, parallel)
}

/// Reads `request` off every turn; see the module comment for the result.
#[napi(js_name = "evaluateTurns")]
pub fn evaluate_turns(
    env: Env,
    turns: Vec<ClassInstance<'_, NativeTurn>>,
    request: NativeReadRequest,
) -> napi::Result<Unknown<'static>> {
    run(env, |js| {
        let (request, parallel) = read_request(request);
        let natives: Vec<&NativeTurn> = turns.iter().map(|t| &**t).collect();
        let outcomes = evaluate(&natives, &request, parallel)?;
        let packed = pack(js, &natives, &request, outcomes)?;
        Ok(out_value(env, packed))
    })
}

/// Pure turns on the pool, JS-bound turns serially here; answers in input order.
fn evaluate(
    natives: &[&NativeTurn],
    request: &ReadRequest,
    parallel: bool,
) -> Result<Vec<Outcome>, DiceError> {
    let mut outcomes: Vec<Option<Outcome>> = natives.iter().map(|_| None).collect();
    let (bound, pure): (Vec<usize>, Vec<usize>) =
        (0..natives.len()).partition(|&i| natives[i].js_bound);
    let pure_turns: Vec<&Turn> = pure.iter().map(|&i| &natives[i].turn).collect();
    for (i, outcome) in pure
        .iter()
        .zip(evaluate_turn_refs(&pure_turns, request, parallel))
    {
        outcomes[*i] = Some(outcome);
    }
    for i in bound {
        outcomes[i] = evaluate_turn_refs(&[&natives[i].turn], request, false).pop();
        if js::throw_pending() {
            // `run` rethrows the held JS exception, which wins over this placeholder.
            return Err(DiceError::HostThrew);
        }
    }
    outcomes
        .into_iter()
        .map(|o| {
            o.ok_or_else(|| {
                DiceError::Error("dice-node: a batch turn was not evaluated".to_string())
            })
        })
        .collect()
}

/// `[id, value, id, value, ...]` in a JS array.
fn id_list<'a, T: 'a>(
    js: &Js,
    items: impl ExactSizeIterator<Item = &'a (String, T)>,
    each: impl Fn(&T) -> Result<Val, DiceError>,
) -> Result<Val, DiceError> {
    let list = js.array(items.len() * 2)?;
    for (k, (id, value)) in items.enumerate() {
        js.set_index(list, 2 * k, js.string(id)?)?;
        js.set_index(list, 2 * k + 1, each(value)?)?;
    }
    Ok(list)
}

fn pack(
    js: &Js,
    natives: &[&NativeTurn],
    request: &ReadRequest,
    outcomes: Vec<Outcome>,
) -> Result<Val, DiceError> {
    let cells = request.cells_per_turn();
    let stride = usize::from(request.mean)
        + usize::from(request.peak_states)
        + request.fire_probability.len()
        + request.expected_applications.len();
    let total = natives.len() * cells;

    let mut scalars = vec![f64::NAN; total * stride];
    let pmfs = if request.pmf {
        Some(js.array(total)?)
    } else {
        None
    };
    let marginals = js.array(total)?;
    let step_stats = js.array(total)?;
    let landings = js.array(total)?;
    let errors = js.array(natives.len())?;

    for (turn_index, outcome) in outcomes.into_iter().enumerate() {
        let readings = match outcome {
            Ok(r) => r,
            Err(e) => {
                js.set_index(errors, turn_index, js.string(&tagged(&e))?)?;
                continue;
            }
        };
        for (ac_index, r) in readings.readings.iter().enumerate() {
            let cell = turn_index * cells + ac_index;
            let at = cell * stride;
            let peak = r.peak_states.map(|p| p as f64);
            for (offset, x) in r
                .mean
                .iter()
                .chain(&peak)
                .chain(&r.fire_probability)
                .chain(&r.expected_applications)
                .enumerate()
            {
                scalars[at + offset] = *x;
            }
            if let (Some(pmfs), Some(pmf)) = (pmfs, &r.pmf) {
                let shared = if request.acs.is_empty() {
                    let mut slot = natives[turn_index]
                        .pmf
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    slot.get_or_insert_with(|| Arc::new(pmf.clone())).clone()
                } else {
                    Arc::new(pmf.clone())
                };
                js.set_index(pmfs, cell, js.class(NativePmf::wrap_shared(shared))?)?;
            }
            // Without `acs` the marginals are the turn's own memoized ones, so their PMF addresses
            // stay valid for the facade's `marginalPmf` on a miss; a cell at an AC reads a throwaway
            // `vsAC` turn, so its marginals cross whole.
            let packed = request.acs.is_empty();
            js.set_index(
                marginals,
                cell,
                id_list(js, r.marginals.iter(), |m| {
                    if packed {
                        out::marginal_packed(js, m)
                    } else {
                        out::marginal(js, m)
                    }
                })?,
            )?;
            js.set_index(
                step_stats,
                cell,
                id_list(js, r.step_stats.iter(), |s| out::step_stats(js, s))?,
            )?;
            js.set_index(
                landings,
                cell,
                id_list(js, r.landings.iter(), |l| out::landings(js, l))?,
            )?;
        }
    }

    let result = js.object()?;
    js.set(result, "cells", js.double(cells as f64)?)?;
    js.set(result, "stride", js.double(stride as f64)?)?;
    js.set(result, "scalars", js.class(Float64Array::new(scalars))?)?;
    if let Some(pmfs) = pmfs {
        js.set(result, "pmfs", pmfs)?;
    }
    js.set(result, "marginals", marginals)?;
    js.set(result, "stepStats", step_stats)?;
    js.set(result, "landings", landings)?;
    js.set(result, "errors", errors)?;
    Ok(result)
}
