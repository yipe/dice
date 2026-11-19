//! Batch entry point: read many turns in one call (ADR-018).
//!
//! A caller that scores a list of candidate turns (and, for each, a sweep of armor classes) asks
//! once for the readings it wants instead of one `Turn` method call per number. The answers are
//! exactly what the same readers return one by one; only the scheduling differs:
//!
//! - one task per `(turn, ac)` cell, run with rayon when the `parallel` feature is on (the
//!   default) and `parallel` is requested, serially otherwise;
//! - results come back in input order, whatever order the tasks finish in.
//!
//! A turn's result is `Err` if any reading asked for fails (the first failing reading, in the order
//! mean, pmf, marginals, step stats, fire probabilities, expected applications; the first failing
//! AC for a sweep), which is the error the corresponding single call would raise.

use std::sync::Arc;

use super::engine::{Marginal, StepStats, Turn};
use super::readers::LandingPattern;
use crate::Pmf;
use crate::error::DiceError;

/// What to read from every turn. Lists keep their order in the answer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReadRequest {
    /// `Turn::mean`.
    pub mean: bool,
    /// `Turn::pmf`.
    pub pmf: bool,
    /// `Turn::marginal(id)` for each id.
    pub marginals: Vec<String>,
    /// `Turn::step_stats(id)` for each id.
    pub step_stats: Vec<String>,
    /// `Turn::fire_probability(id)` for each id.
    pub fire_probability: Vec<String>,
    /// `Turn::expected_applications(id)` for each id.
    pub expected_applications: Vec<String>,
    /// `Turn::marginal(id)` for every attack id, then every rider id, after the ids of `marginals`.
    /// For a batch of turns that do not share ids (a caller that reads everything).
    pub all_marginals: bool,
    /// `Turn::step_stats(id)` for every attack id, after the ids of `step_stats`.
    pub all_step_stats: bool,
    /// `Turn::landings(id)` for every attack id.
    pub all_landings: bool,
    /// `Turn::peak_states`.
    pub peak_states: bool,
    /// Armor classes to evaluate every turn at (`Turn::vs_ac(ac)` first). Empty: read the turn as
    /// given.
    pub acs: Vec<f64>,
}

impl ReadRequest {
    /// How many readings a turn answers: one per AC, or one when there is no AC sweep.
    pub fn cells_per_turn(&self) -> usize {
        self.acs.len().max(1)
    }
}

/// The readings of one turn (at one AC), each in the order of its request list.
#[derive(Clone, Debug, Default)]
pub struct Readings {
    /// The AC the turn was evaluated at; `None` when the request has no `acs`.
    pub ac: Option<f64>,
    pub mean: Option<f64>,
    pub pmf: Option<Pmf>,
    /// By id: the request's ids first, then (`all_marginals`) every attack and rider id.
    pub marginals: Vec<(String, Arc<Marginal>)>,
    /// By id: the request's ids first, then (`all_step_stats`) every attack id.
    pub step_stats: Vec<(String, StepStats)>,
    /// By attack id, in declaration order (`all_landings`).
    pub landings: Vec<(String, Vec<LandingPattern>)>,
    pub peak_states: Option<usize>,
    pub fire_probability: Vec<f64>,
    pub expected_applications: Vec<f64>,
}

/// The readings of one turn: one entry per AC of the request (in order), or one entry when the
/// request has no `acs`.
#[derive(Clone, Debug, Default)]
pub struct TurnReadings {
    pub readings: Vec<Readings>,
}

/// Reads `request` off `turn` (at `ac`, if given), the way the single calls would.
pub fn read_cell(
    turn: &Turn,
    request: &ReadRequest,
    ac: Option<f64>,
) -> Result<Readings, DiceError> {
    match ac {
        None => read_now(turn, request, None),
        Some(ac) => read_now(&turn.vs_ac(ac)?, request, Some(ac)),
    }
}

fn read_now(turn: &Turn, request: &ReadRequest, ac: Option<f64>) -> Result<Readings, DiceError> {
    let mean = if request.mean {
        Some(turn.mean()?)
    } else {
        None
    };
    let pmf = if request.pmf { Some(turn.pmf()?) } else { None };
    let attack_ids = if request.all_marginals || request.all_step_stats || request.all_landings {
        turn.attack_ids()?
    } else {
        Vec::new()
    };
    let mut marginal_ids: Vec<String> = request.marginals.clone();
    if request.all_marginals {
        marginal_ids.extend(attack_ids.iter().cloned());
        marginal_ids.extend(turn.rider_ids()?);
    }
    let mut step_ids: Vec<String> = request.step_stats.clone();
    if request.all_step_stats {
        step_ids.extend(attack_ids.iter().cloned());
    }
    let marginals = marginal_ids
        .into_iter()
        .map(|id| turn.marginal(&id).map(|m| (id, m)))
        .collect::<Result<_, _>>()?;
    let step_stats = step_ids
        .into_iter()
        .map(|id| turn.step_stats(&id).map(|s| (id, s)))
        .collect::<Result<_, _>>()?;
    let landings = if request.all_landings {
        attack_ids
            .iter()
            .map(|id| turn.landings(id).map(|l| (id.clone(), l)))
            .collect::<Result<_, _>>()?
    } else {
        Vec::new()
    };
    Ok(Readings {
        ac,
        mean,
        pmf,
        marginals,
        step_stats,
        landings,
        peak_states: if request.peak_states {
            Some(turn.peak_states()?)
        } else {
            None
        },
        fire_probability: request
            .fire_probability
            .iter()
            .map(|id| turn.fire_probability(id))
            .collect::<Result<_, _>>()?,
        expected_applications: request
            .expected_applications
            .iter()
            .map(|id| turn.expected_applications(id))
            .collect::<Result<_, _>>()?,
    })
}

/// Reads `request` off every turn: `result[i]` is the answer for `turns[i]`. Runs on rayon's pool
/// when the `parallel` feature is on.
pub fn evaluate_turns(
    turns: &[Turn],
    request: &ReadRequest,
) -> Vec<Result<TurnReadings, DiceError>> {
    let refs: Vec<&Turn> = turns.iter().collect();
    evaluate_turn_refs(&refs, request, cfg!(feature = "parallel"))
}

/// [`evaluate_turns`] over borrowed turns; `parallel` picks rayon (ignored without the `parallel`
/// feature). A caller that must keep some turns on its own thread evaluates those with
/// `parallel = false` (or [`read_cell`]) and the rest in parallel.
pub fn evaluate_turn_refs(
    turns: &[&Turn],
    request: &ReadRequest,
    parallel: bool,
) -> Vec<Result<TurnReadings, DiceError>> {
    let per_turn = request.cells_per_turn();
    let cell = |index: usize| -> Result<Readings, DiceError> {
        let turn = turns[index / per_turn];
        read_cell(turn, request, request.acs.get(index % per_turn).copied())
    };
    let cells = run_cells(turns.len() * per_turn, parallel, cell);
    let mut cells = cells.into_iter();
    turns
        .iter()
        .map(|_| {
            let mut readings = Vec::with_capacity(per_turn);
            let mut failed = None;
            for cell in cells.by_ref().take(per_turn) {
                match cell {
                    Ok(r) if failed.is_none() => readings.push(r),
                    Err(e) if failed.is_none() => failed = Some(e),
                    _ => {}
                }
            }
            match failed {
                Some(e) => Err(e),
                None => Ok(TurnReadings { readings }),
            }
        })
        .collect()
}

#[cfg(feature = "parallel")]
fn run_cells<F>(count: usize, parallel: bool, cell: F) -> Vec<Result<Readings, DiceError>>
where
    F: Fn(usize) -> Result<Readings, DiceError> + Sync + Send,
{
    use rayon::prelude::*;
    if parallel {
        (0..count).into_par_iter().map(cell).collect()
    } else {
        (0..count).map(cell).collect()
    }
}

#[cfg(not(feature = "parallel"))]
fn run_cells<F>(count: usize, _parallel: bool, cell: F) -> Vec<Result<Readings, DiceError>>
where
    F: Fn(usize) -> Result<Readings, DiceError>,
{
    (0..count).map(cell).collect()
}
