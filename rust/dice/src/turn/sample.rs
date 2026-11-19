//! Port of `src/turn/sample.ts`: one play of a turn, the sampling twin of `Turn.walk`. The walk
//! sums over every path through the plan's steps; [`sample_turn`] draws one, in the walk's order,
//! with the walk's own state (group codes, fire slots, flags, counters), so the sample's law is
//! the joint PMF. Only the dice are new: a row with a builder behind it rolls its dice
//! (`AttackBuilder::sample`, `SaveBuilder::sample`, `RollBuilder::sample`) and the dice decide
//! which of the step's draws the walk took; a row with no dice structure picks a draw by its mass
//! and draws its total from the draw's PMF (a "chip", no dice).
//!
//! # Shape
//! - TS `undefined` for "no such roller / sample / draw" is `Option`; a builder error inside a draw
//!   (TS: a throw) is `Err(DiceError::Error(message))`.
//! - `matchable` (a `WeakMap` caching `diceMatchInfo()` per builder) is a [`MatchCache`] keyed by
//!   step id: a `Turn` keeps one for its sample plan; [`sample_turn`] makes a fresh one per call.
//! - `sampleFallbacks` is [`SAMPLE_FALLBACKS`].

use super::context::{context_of, has_rerolled_under};
use super::plan::{
    Draw, EvaluatedRider, Fire, FireMode, PlanDamage, Step, TurnPlan, fire_mode, gate_open,
    grant_applies, released,
};
use super::state::{StepOutcome, advance};
pub use super::trace::SAMPLER_VERSION;
use super::trace::{
    DieBy, DieRole, DieRoll, Outcome, OutcomeResult, SAMPLER_VERSION as VERSION, Trace, Wave,
};
use super::types::{
    ContextualPayload, DamageSource, RiderDamage, RiderLanding, RollUnder, RowContext, Source,
    SubstitutePolicy, Trigger,
};
use crate::Pmf;
use crate::builder::attack::{AttackBuilder, AttackOutcome, AttackSample};
use crate::builder::nodes::Rounding;
use crate::builder::roll::RollBuilder;
use crate::builder::sample::{RollSample, SampledDie, sample_pmf, scale_value};
use crate::builder::save::{SaveBuilder, SaveSampleOutcome};
use crate::common::Rng;
use crate::error::DiceError;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Test seam: how many rows fell back to a PMF draw because none of the step's draws matched what
/// the dice showed (a structural mismatch between the plan and the sampler). Never on a
/// well-formed turn; a fixture suite asserts it stays 0.
pub static SAMPLE_FALLBACKS: AtomicUsize = AtomicUsize::new(0);

fn internal(message: &str) -> DiceError {
    DiceError::Error(format!("internal: {message}"))
}

/// A coin with probability `p`, certain at either end so a scripted `Rng` is not asked.
fn coin(rng: &mut dyn Rng, p: f64) -> bool {
    if p >= 1.0 {
        return true;
    }
    if p <= 0.0 {
        return false;
    }
    rng.chance(p)
}

/// One of `draws` by relative mass, by the same inverse walk `samplePMF` takes over bins.
fn pick_by_mass<'a>(draws: &[&'a Draw], rng: &mut dyn Rng) -> Result<&'a Draw, DiceError> {
    let mut remaining = draws.iter().fold(0.0, |sum, draw| sum + draw.slice.mass());
    let Some((last, init)) = draws.split_last() else {
        return Err(internal("a row with no draw to pick"));
    };
    for draw in init {
        let mass = draw.slice.mass();
        if remaining <= 0.0 {
            break;
        }
        if rng.chance(mass / remaining) {
            return Ok(draw);
        }
        remaining -= mass;
    }
    Ok(last)
}

/// A sampled builder's dice as trace dice. A die that replaced a rerolled one is a `reroll`.
fn traced(dice: &[SampledDie], role: DieRole, by: DieBy, source: &str) -> Vec<DieRoll> {
    dice.iter()
        .map(|die| DieRoll {
            sides: die.sides,
            face: die.face,
            role: if die.reroll { DieRole::Reroll } else { role },
            by,
            source: source.to_string(),
            kept: die.kept,
        })
        .collect()
}

/// The outcome a labelled PMF's draw stands for. A miss label under a save's "hit" draw is a pass.
fn result_of(label: &str, outcome: StepOutcome) -> OutcomeResult {
    match label {
        "crit" => OutcomeResult::Crit,
        "hit" | "pc" => OutcomeResult::Hit,
        "saveFail" => OutcomeResult::SaveFail,
        "saveHalf" => OutcomeResult::SavePass,
        _ => match outcome {
            StepOutcome::Miss => OutcomeResult::Miss,
            StepOutcome::None => OutcomeResult::Skipped,
            _ => OutcomeResult::SavePass,
        },
    }
}

/// `pmf` with the `(1 - happens)` mass `thin` put at 0 taken out again: the rider's own payload.
fn unthin(pmf: &Pmf, happens: f64) -> Pmf {
    if happens >= 1.0 {
        return pmf.clone();
    }
    let zero = pmf.p_at(0.0);
    let share = if zero > 0.0 {
        crate::builder::num::js_max(0.0, (zero - (1.0 - happens)) / zero)
    } else {
        0.0
    };
    pmf.split_by_factor(|value| if value == 0.0 { share } else { 1.0 })
        .0
        .normalize()
}

fn floor_double(total: f64) -> f64 {
    scale_value(total, 2.0, Rounding::Floor, 1.0)
}

/// A rider's dice for one landing in `crit` mode or not, or `None` where some part has no dice to
/// roll (a bare PMF, a payload read per attack): the caller draws a chip from the plan's payload
/// PMF instead. Mirrors `critPMF`: an explicit `critDamage` as it is; else each part's dice
/// doubled on a crit (a parsed string only where it can), flats untouched.
fn sample_rider_dice(
    damage: &RiderDamage,
    crit_damage: Option<&RiderDamage>,
    crit: bool,
    rng: &mut dyn Rng,
) -> Result<Option<RollSample>, DiceError> {
    let explicit = if crit { crit_damage } else { None };
    let chosen = explicit.unwrap_or(damage);
    let parts = chosen.parts();
    let mut builders: Vec<&RollBuilder> = Vec::with_capacity(parts.len());
    for part in parts {
        match part {
            DamageSource::Roll(builder) => builders.push(builder),
            _ => return Ok(None),
        }
    }
    let mut dice: Vec<SampledDie> = Vec::new();
    let mut total = 0.0;
    for part in builders {
        let doubled =
            crit && explicit.is_none() && (!part.is_parsed() || part.can_double_dice()?);
        let sampled = if doubled {
            part.double_dice()?.sample(rng)?
        } else {
            part.sample(rng)?
        };
        total += sampled.total;
        dice.extend(sampled.dice);
    }
    Ok(Some(RollSample { total, dice }))
}

/// The payload `rider` deals when `source_id` lands: its own, or the one it names for that
/// source.
fn payload_for<'a>(
    rider: &'a EvaluatedRider,
    source_id: &str,
) -> (&'a RiderDamage, Option<&'a RiderDamage>) {
    let per_source = match &rider.trigger {
        Trigger::FirstHit { per_source, .. } | Trigger::EveryHit { per_source, .. } => {
            per_source.as_ref()
        }
        _ => None,
    };
    if let Some(payload) = per_source.and_then(|per_source| per_source.get(source_id)) {
        return (&payload.damage, payload.crit_damage.as_ref());
    }
    (&rider.damage, rider.crit_damage.as_ref())
}

/// The dice of folded rider `id` landing on `source_id` in crit mode or not, or `None` for a chip
/// (see [`sample_rider_dice`]). A plain payload's total is doubled where `vulnerable`, as the
/// plan's `vulnerable()` payload is. A payload read per attack rolls what its `rollAt(sourceId)`
/// returns, which is exact for that landing (`onCrit` as given, never doubled again; its
/// `vulnerable` pair where the landing used up a vulnerability). Without that pair a vulnerable
/// landing is a chip: `at(sourceId).vulnerable` is the law and need not be the plain roll
/// doubled.
fn sample_folded_rider(
    plan: &TurnPlan,
    id: &str,
    rider: &EvaluatedRider,
    source_id: &str,
    crit: bool,
    vulnerable: bool,
    rng: &mut dyn Rng,
) -> Result<Option<RollSample>, DiceError> {
    let Some(contextual) = plan.payload_at.get(id) else {
        let (damage, crit_damage) = payload_for(rider, source_id);
        let drawn = sample_rider_dice(damage, crit_damage, crit, rng)?;
        return Ok(match drawn {
            Some(drawn) if vulnerable => Some(RollSample {
                total: floor_double(drawn.total),
                ..drawn
            }),
            other => other,
        });
    };
    let contextual: &dyn ContextualPayload = &**contextual;
    let Some(rolls) = contextual.roll_at(source_id)? else {
        return Ok(None);
    };
    let pair = if vulnerable {
        match &rolls.vulnerable {
            Some(pair) => (&pair.on_hit, &pair.on_crit),
            None => return Ok(None),
        }
    } else {
        (&rolls.on_hit, &rolls.on_crit)
    };
    let chosen = if crit { pair.1 } else { pair.0 };
    Ok(Some(chosen.sample(rng)?))
}

/// Whether two or more kept dice of the base pool show the same face.
fn dice_matched(base: &RollSample) -> bool {
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    for die in &base.dice {
        if !die.kept {
            continue;
        }
        // `${sides}:${face}` as a key: a number's identity is its bits (0 and -0 print alike).
        let norm = |x: f64| {
            if x == 0.0 {
                0.0f64.to_bits()
            } else {
                x.to_bits()
            }
        };
        if !seen.insert((norm(die.sides), norm(die.face))) {
            return true;
        }
    }
    false
}

/// Whether the base dice matched, where the attack has a descriptor for that landing; never
/// otherwise.
fn matched_of(
    builder: &AttackBuilder,
    sample: &AttackSample,
    known: &MatchCache,
    step_id: &str,
) -> Result<bool, DiceError> {
    let Some(payload) = &sample.payload else {
        return Ok(false);
    };
    if sample.outcome == AttackOutcome::Miss {
        return Ok(false);
    }
    let cached = known
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(step_id)
        .copied();
    let (hit, crit) = if let Some(found) = cached {
        found
    } else {
        let (hit, crit) = builder.dice_match_info(0.0)?;
        let found = (hit.is_some(), crit.is_some());
        known
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(step_id.to_string(), found);
        found
    };
    let tracked = if sample.outcome == AttackOutcome::Crit {
        crit
    } else {
        hit
    };
    Ok(tracked && dice_matched(&payload.base))
}

/// The builder a row rolls with: a library builder (borrowed from the plan, or owned where a
/// source's `rollUnder` made it).
enum Builder<'a> {
    Attack(Box<Cow<'a, AttackBuilder>>),
    Save(Box<Cow<'a, SaveBuilder>>),
    Roll(Box<Cow<'a, RollBuilder>>),
}

/// The builder a row rolls with, and the context its `sample` still has to apply: the row's own
/// context for a bare builder (its `sample(rng, context)` re-derives and scales for it); `None` for
/// one `rollUnder(context)` returned, whose PMF is already exactly `under(context)` (roll type,
/// penalty dice and vulnerability included), so it is sampled bare and never scaled here.
struct Roller<'a> {
    builder: Builder<'a>,
    context: Option<RowContext>,
    /// Whether the sampler itself doubles this roller's own totals for the row's vulnerability:
    /// only a bare `RollBuilder` row (its `sample` takes no context, and the plan's `under`
    /// doubles it). An attack or save builder scales inside `sample(rng, context)` /
    /// `samplePayload` (`scale`), and a `rollUnder` roller is exact as it is: neither is ever
    /// scaled here.
    doubles: bool,
}

/// The builder a row rolls with in `context`, or `None` for a row that is a chip.
fn roller_of<'a>(
    source: Option<&'a PlanDamage>,
    context: Option<&RowContext>,
) -> Result<Option<Roller<'a>>, DiceError> {
    let Some(PlanDamage::One(source)) = source else {
        return Ok(None);
    };
    match source {
        Source::Damage(DamageSource::Attack(attack)) => Ok(Some(Roller {
            builder: Builder::Attack(Box::new(Cow::Borrowed(&**attack))),
            context: context.cloned(),
            doubles: false,
        })),
        Source::Damage(DamageSource::Save(save)) => Ok(Some(Roller {
            builder: Builder::Save(Box::new(Cow::Borrowed(&**save))),
            context: context.cloned(),
            doubles: false,
        })),
        Source::Contextual(contextual) => {
            let contextual = &*contextual.0;
            let under = match context {
                Some(context) => context.clone(),
                None => context_of(&contextual.row_check(), 0, &[]),
            };
            let builder = match contextual.roll_under(&under)? {
                None => return Ok(None),
                Some(RollUnder::Attack(a)) => Builder::Attack(Box::new(Cow::Owned(*a))),
                Some(RollUnder::Save(s)) => Builder::Save(Box::new(Cow::Owned(*s))),
                Some(RollUnder::Roll(r)) => Builder::Roll(Box::new(Cow::Owned(r))),
            };
            Ok(Some(Roller {
                builder,
                context: None,
                doubles: false,
            }))
        }
        // A plain `RollBuilder` row is one unlabelled payload; a parsed string has no dice to
        // show.
        Source::Damage(DamageSource::Roll(roll)) if !roll.is_parsed() => Ok(Some(Roller {
            builder: Builder::Roll(Box::new(Cow::Borrowed(roll))),
            context: context.cloned(),
            doubles: context.is_some_and(|c| c.vulnerable),
        })),
        Source::Damage(_) => Ok(None),
    }
}

/// Whether `draw` is the landing kind of an attack whose draws are split by its own damage dealt
/// (`DEALT` / `NOT_DEALT`).
fn dealt_kind(draw: &Draw, outcome: StepOutcome, dealt: bool) -> bool {
    match draw.by_kind {
        None => true,
        Some(by_kind) => by_kind.damage == if dealt { outcome } else { StepOutcome::None },
    }
}

/// Whether `draw` is the class a save's dice landed in (see `CLASS_OUTCOMES` in `plan.ts`).
fn save_kind(draw: &Draw, save_class: u8) -> bool {
    let Some(by_kind) = draw.by_kind else {
        return true;
    };
    let failed = save_class < 2;
    let dealt = save_class == 0 || save_class == 2;
    by_kind.fail
        == if failed {
            StepOutcome::Hit
        } else {
            StepOutcome::Miss
        }
        && by_kind.damage
            == if dealt {
                StepOutcome::Hit
            } else {
                StepOutcome::Miss
            }
}

fn step_outcome(outcome: AttackOutcome) -> StepOutcome {
    match outcome {
        AttackOutcome::Hit => StepOutcome::Hit,
        AttackOutcome::Crit => StepOutcome::Crit,
        AttackOutcome::Miss => StepOutcome::Miss,
    }
}

fn attack_result(outcome: AttackOutcome) -> OutcomeResult {
    match outcome {
        AttackOutcome::Hit => OutcomeResult::Hit,
        AttackOutcome::Crit => OutcomeResult::Crit,
        AttackOutcome::Miss => OutcomeResult::Miss,
    }
}

/// What one row's dice said, before the walk's draw is matched to it.
struct RowRoll<'r> {
    outcome: StepOutcome,
    result: OutcomeResult,
    /// The row's own damage, separate channels in, vulnerability applied.
    total: f64,
    dice: Vec<DieRoll>,
    /// A landing attack's roll (for a substitute's spend and a `dice-match` read); absent
    /// otherwise.
    attack: Option<(&'r AttackBuilder, AttackSample)>,
    /// A watched save's class: failed and dealt (0), failed for nothing (1), passed and dealt (2),
    /// the rest (3).
    save_class: Option<u8>,
}

/// One roll of a row with its builder: the dice, the landing and its own damage. A bare builder's
/// `sample(rng, context)` applies the context, `context.vulnerable` included; a `rollUnder`
/// builder (`context` `None`) is exact as it is. A plain `RollBuilder` row is one unlabelled
/// payload, doubled here where `doubles` says so (see [`Roller`]).
fn sample_row<'r>(
    step: &Step,
    roller: &'r Roller<'_>,
    rng: &mut dyn Rng,
) -> Result<RowRoll<'r>, DiceError> {
    let context = roller.context.as_ref();
    match &roller.builder {
        Builder::Attack(builder) => {
            let sample = builder.sample(rng, context)?;
            let mut dice = traced(&sample.check, DieRole::Attack, DieBy::You, &step.id);
            dice.extend(traced(
                &sample.damage,
                DieRole::Damage,
                DieBy::You,
                &step.id,
            ));
            Ok(RowRoll {
                outcome: step_outcome(sample.outcome),
                result: attack_result(sample.outcome),
                total: sample.total,
                dice,
                attack: Some((&**builder, sample)),
                save_class: None,
            })
        }
        Builder::Save(builder) => {
            let sample = builder.sample(rng, context)?;
            let failed = sample.outcome == SaveSampleOutcome::Fail;
            let dealt = sample.total > 0.0;
            let mut dice = traced(&sample.check, DieRole::Save, DieBy::Enemy, &step.id);
            dice.extend(traced(
                &sample.damage,
                DieRole::Damage,
                DieBy::You,
                &step.id,
            ));
            Ok(RowRoll {
                outcome: StepOutcome::Hit,
                result: if failed {
                    OutcomeResult::SaveFail
                } else {
                    OutcomeResult::SavePass
                },
                total: sample.total,
                dice,
                attack: None,
                save_class: Some(match (failed, dealt) {
                    (true, true) => 0,
                    (true, false) => 1,
                    (false, true) => 2,
                    (false, false) => 3,
                }),
            })
        }
        Builder::Roll(builder) => {
            let sample = builder.sample(rng)?;
            Ok(RowRoll {
                outcome: StepOutcome::Hit,
                result: OutcomeResult::Hit,
                total: if roller.doubles {
                    floor_double(sample.total)
                } else {
                    sample.total
                },
                dice: traced(&sample.dice, DieRole::Damage, DieBy::You, &step.id),
                attack: None,
                save_class: None,
            })
        }
    }
}

fn fire_of(outcome: StepOutcome) -> FireMode {
    Some(if outcome == StepOutcome::Crit {
        Fire::Crit
    } else {
        Fire::Hit
    })
}

/// `separate.reduce((sum, s) => sum + s.total, 0)`.
fn separate_total(separate: &[RollSample]) -> f64 {
    separate.iter().fold(0.0, |sum, s| sum + s.total)
}

/// The trace's record of one outcome (`outcomeOf`).
fn outcome_of(wave: &mut Wave, total: &mut f64, source: &str, result: OutcomeResult, damage: f64) {
    wave.outcomes.push(Outcome {
        source: source.to_string(),
        result,
        damage,
    });
    *total += damage;
}

/// One play of `plan`: see the module doc.
pub fn sample_turn(plan: &TurnPlan, eps: f64, rng: &mut dyn Rng) -> Result<Trace, DiceError> {
    sample_turn_cached(plan, eps, rng, &MatchCache::default())
}

/// Which landings of a row have a `dice-match` descriptor (`(hit, crit)`), by step id. The answer
/// is fixed for a plan, and `diceMatchInfo()` enumerates the pool's face sums: far too slow to
/// redo for every sampled landing.
pub type MatchCache = Mutex<HashMap<String, (bool, bool)>>;

/// [`sample_turn`] reading and filling `matchable` (keep one per plan).
pub fn sample_turn_cached(
    plan: &TurnPlan,
    eps: f64,
    rng: &mut dyn Rng,
    matchable: &MatchCache,
) -> Result<Trace, DiceError> {
    let mut codes: Vec<u32> = vec![super::state::START_CODE; plan.group_count];
    let mut fired: Vec<FireMode> = vec![None; plan.slot_count];
    let mut flags = plan.start_flags;
    let mut counts: Vec<u32> = vec![0; plan.counter_max.len()];
    // A rider that may not happen takes its coin before the first row (the walk's split).
    for c in &plan.coins {
        if coin(rng, c.happens) {
            flags |= c.bit;
        }
    }

    let mut waves: Vec<Wave> = Vec::with_capacity(plan.steps.len());
    let mut total = 0.0;

    for (step_index, step) in plan.steps.iter().enumerate() {
        let mut wave = Wave::default();
        // The walk's `merge`: dead groups and flags reset, a count the cap can no longer reach
        // zeroed.
        macro_rules! settle {
            () => {{
                codes = released(&codes, &step.releases);
                flags &= plan.flag_live_after.get(step_index).copied().unwrap_or(0);
                if !counts.is_empty() {
                    counts = counts
                        .iter()
                        .enumerate()
                        .map(|(counter, &count)| {
                            if step
                                .settled
                                .get(counter)
                                .is_some_and(|settled| f64::from(count) <= *settled)
                            {
                                0
                            } else {
                                count
                            }
                        })
                        .collect();
                }
            }};
        }

        if let Some(gate) = &step.gate
            && !gate_open(gate, &codes, &fired)
        {
            outcome_of(&mut wave, &mut total, &step.id, OutcomeResult::Skipped, 0.0);
            settle!();
            waves.push(wave);
            continue;
        }
        let Some(mode) = fire_mode(step, &codes, &fired) else {
            outcome_of(&mut wave, &mut total, &step.id, OutcomeResult::Skipped, 0.0);
            settle!();
            waves.push(wave);
            continue;
        };
        if let Some(slot) = step.slot
            && let Some(cell) = fired.get_mut(slot)
        {
            *cell = Some(mode);
        }

        if step.variants.is_empty() {
            // Pure damage: the rider's payload in the mode it fired in. Its coin first where it
            // may not happen.
            let rider = plan
                .rider_of
                .get(&step.id)
                .ok_or_else(|| internal("a pure-damage step with no rider"))?;
            let happens = rider.happens.unwrap_or(1.0);
            if !coin(rng, happens) {
                outcome_of(&mut wave, &mut total, &step.id, OutcomeResult::Skipped, 0.0);
                settle!();
                waves.push(wave);
                continue;
            }
            let crit = mode == Fire::Crit;
            let drawn = sample_rider_dice(&rider.damage, rider.crit_damage.as_ref(), crit, rng)?;
            let damage = match drawn {
                None => {
                    let payload = step
                        .damage
                        .as_ref()
                        .ok_or_else(|| internal("a pure-damage step with no payload"))?;
                    let chosen = if crit { &payload.crit } else { &payload.hit };
                    sample_pmf(&unthin(chosen, happens), rng).total
                }
                Some(drawn) => {
                    wave.dice
                        .extend(traced(&drawn.dice, DieRole::Rider, DieBy::You, &step.id));
                    drawn.total
                }
            };
            outcome_of(
                &mut wave,
                &mut total,
                &step.id,
                OutcomeResult::Fired,
                damage,
            );
            settle!();
            waves.push(wave);
            continue;
        }

        // A row: which context it rolls in and which draw set it draws from (built on first use).
        let flags_before = flags;
        let codes_before = codes.clone();
        let context = (step.context_index_of)(&codes, &fired, flags, &counts)?;
        let variant_index = (step.select)(&codes, &fired, flags, &counts)?;
        let variant_block = step
            .variants
            .get(variant_index)
            .ok_or_else(|| internal("a selected variant that was not built"))?;
        let variant: Vec<&Draw> = variant_block
            .iter()
            .filter(|draw| draw.slice.mass() > eps)
            .collect();
        let row_context: Option<&RowContext> = step
            .context_row_contexts
            .get(context)
            .and_then(|c| c.as_ref());
        // The row's vulnerability as the plan folds it. Read ONLY for the folded riders' payloads
        // (the plan picks each rider's `vulnerable()` payload by the row's context, whatever the
        // row's own roller is) and, through `roller_of`, for a bare `RollBuilder` row. Never
        // applied to an attack, save or `rollUnder` roller here: those carry their own scale (see
        // `Roller`).
        let vulnerable = step
            .context_vulnerable
            .get(context)
            .copied()
            .unwrap_or(false);
        let source = plan.source_of.get(&step.id);
        let roller = roller_of(source, row_context)?;

        let draw: &Draw;
        let row_damage: f64;
        let row_result: OutcomeResult;
        let mut row_dice: Vec<DieRoll> = Vec::new();
        // Per folded rider, its damage once its dice are drawn; a chip rider draws from the chosen
        // draw's payload.
        let mut rider_damage: HashMap<String, f64> = HashMap::new();
        // Folded riders whose own `happens` coin failed on this landing: traced `skipped`, as a
        // step rider is.
        let mut rider_skipped: HashSet<String> = HashSet::new();
        // Chip riders whose coin came up here, by `happens`: their draw takes the plan's `thin` out
        // again.
        let mut rider_passed: HashMap<String, f64> = HashMap::new();
        let mut rider_dice: Vec<DieRoll> = Vec::new();
        let mut spent = false;

        let rolls = match &roller {
            Some(roller) if coin(rng, step.chance) => Some(roller),
            _ => None,
        };
        match rolls {
            None => {
                // A chip row, or a row that did not happen: the draw first, then its total from
                // the draw's own part.
                let none: Vec<&Draw> = variant
                    .iter()
                    .copied()
                    .filter(|each| each.outcome == StepOutcome::None)
                    .collect();
                let pool = if roller.is_none() || none.is_empty() {
                    &variant
                } else {
                    &none
                };
                draw = pick_by_mass(pool, rng)?;
                let own = sample_pmf(draw.own.as_ref().unwrap_or(&draw.slice), rng);
                row_damage = own.total;
                row_result = result_of(&own.outcome, draw.outcome);
                spent = draw.spends;
            }
            Some(roller) => {
                let roll = sample_row(step, roller, rng)?;
                let mut outcome = roll.outcome;
                let mut attack = roll.attack;
                let mut own_total = roll.total;
                row_dice = roll.dice;
                let mut result = roll.result;

                // A first-miss reroll: the first unspent one rolls a miss again (the plan's
                // variant for this state was picked by the same rule), and what it gives is the
                // row's roll. The draws below are then the reroll's own.
                let next_reroll = step.rerolls.iter().find(|each| {
                    fired
                        .get(each.slot)
                        .is_some_and(std::option::Option::is_none)
                });
                let mut rerolled: Option<usize> = None;
                if let (Some(next), StepOutcome::Miss) = (next_reroll, outcome)
                    && let Some((builder, first)) = attack.take()
                {
                    let again = builder.sample_miss_reroll(
                        first,
                        next.mode,
                        rng,
                        roller.context.as_ref(),
                    )?;
                    outcome = step_outcome(again.outcome);
                    own_total = again.total;
                    result = attack_result(again.outcome);
                    row_dice = traced(&again.check, DieRole::Attack, DieBy::You, &step.id);
                    row_dice.extend(traced(&again.damage, DieRole::Damage, DieBy::You, &step.id));
                    rerolled = Some(next.slot);
                    attack = Some((builder, again));
                }

                // A conversion: the first watched miss while it is unspent hits instead, a plain
                // hit with the row's hit payload rolled fresh (the d20s stand as rolled).
                let convertible = step.converts
                    && outcome == StepOutcome::Miss
                    && step.spend_slot.is_some_and(|slot| {
                        fired.get(slot).is_some_and(std::option::Option::is_none)
                    });
                if convertible && let Some((builder, first)) = attack.take() {
                    let payload = builder.sample_payload(
                        AttackOutcome::Hit,
                        rng,
                        roller.context.as_ref(),
                        false,
                    )?;
                    let total = scale_value(
                        payload.base.total + separate_total(&payload.separate),
                        f64::from(payload.scale),
                        Rounding::Floor,
                        1.0,
                    );
                    let mut damage: Vec<SampledDie> = payload.base.dice.clone();
                    for s in &payload.separate {
                        damage.extend(s.dice.iter().cloned());
                    }
                    let converted = AttackSample {
                        outcome: AttackOutcome::Hit,
                        damage: damage.clone(),
                        total,
                        payload: Some(payload),
                        ..first
                    };
                    outcome = StepOutcome::Hit;
                    own_total = total;
                    result = OutcomeResult::Hit;
                    row_dice = traced(&converted.check, DieRole::Attack, DieBy::You, &step.id);
                    row_dice.extend(traced(&damage, DieRole::Damage, DieBy::You, &step.id));
                    spent = true;
                    attack = Some((builder, converted));
                }

                // Which draws the dice could have come from: the outcome; the base dice's match
                // where the step tracks it; a save's class, or an attack's "dealt damage" kind,
                // where the draws carry one.
                let mut candidates: Vec<&Draw> = variant
                    .iter()
                    .copied()
                    .filter(|each| each.outcome == outcome && each.reroll_slot == rerolled)
                    .collect();
                let match_tracked = candidates.iter().any(|each| each.matched);
                let mut matched = match &attack {
                    Some((builder, sample)) if match_tracked => {
                        matched_of(builder, sample, matchable, &step.id)?
                    }
                    _ => false,
                };

                // A substitute: spend the landing (re-roll the base payload, keep the better) by
                // its policy. The variant says whether holding is worth anything here: it carries
                // hold draws only while a later watched step can still land. Live while its fire
                // slot is empty (`select` reads the same slot: the variant index itself is offset
                // by cap block and context, so it does not say).
                let unspent = step
                    .spend_slot
                    .is_some_and(|slot| fired.get(slot).is_some_and(std::option::Option::is_none));
                let landed = matches!(outcome, StepOutcome::Hit | StepOutcome::Crit);
                let rerolled_under =
                    matches!(source, Some(PlanDamage::One(s)) if has_rerolled_under(s));
                let spend_draws: Vec<&Draw> =
                    if step.policy.is_some() && unspent && landed && rerolled_under {
                        candidates
                            .iter()
                            .copied()
                            .filter(|each| each.spends)
                            .collect()
                    } else {
                        Vec::new()
                    };
                if !spend_draws.is_empty() {
                    // The source says what its reroll rolls (`rerolledUnder`), which is no
                    // keep-higher of these dice: the row's damage is drawn from the plan's spend
                    // law for this landing, and the first roll's damage dice stand as not kept.
                    // Such a row has no policy but spend, and no match.
                    spent = true;
                    let spend = pick_by_mass(&spend_draws, rng)?;
                    own_total = sample_pmf(spend.own.as_ref().unwrap_or(&spend.slice), rng).total;
                    row_dice = row_dice
                        .into_iter()
                        .map(|die| {
                            if die.role == DieRole::Attack {
                                die
                            } else {
                                DieRoll { kept: false, ..die }
                            }
                        })
                        .collect();
                } else if let (Some((builder, sample)), Some(policy), true, true) =
                    (&attack, &step.policy, unspent, landed)
                    && let Some(payload) = &sample.payload
                {
                    let crit = outcome == StepOutcome::Crit;
                    let base = &payload.base;
                    let hold_available = candidates
                        .iter()
                        .any(|each| !each.spends && each.matched == matched);
                    spent = match policy {
                        SubstitutePolicy::Always => true,
                        SubstitutePolicy::Below {
                            hit,
                            crit: crit_below,
                        } => base.total < if crit { *crit_below } else { *hit } || !hold_available,
                        SubstitutePolicy::Optimal => false,
                    };
                    if spent {
                        let landing = if crit {
                            AttackOutcome::Crit
                        } else {
                            AttackOutcome::Hit
                        };
                        let fresh = builder
                            .sample_payload(landing, rng, roller.context.as_ref(), false)?
                            .base;
                        let better = fresh.total > base.total;
                        // The payload's own whole-roll scale (a vulnerable context, or a
                        // `rollUnder` built for one), never the step's flag.
                        let kept = if better { &fresh } else { base };
                        own_total = scale_value(
                            kept.total + separate_total(&payload.separate),
                            f64::from(payload.scale),
                            Rounding::Floor,
                            1.0,
                        );
                        let dropped = |dice: &[SampledDie]| -> Vec<SampledDie> {
                            dice.iter()
                                .map(|die| SampledDie {
                                    kept: false,
                                    ..die.clone()
                                })
                                .collect()
                        };
                        let mut dice = traced(&sample.check, DieRole::Attack, DieBy::You, &step.id);
                        dice.extend(traced(
                            &if better {
                                dropped(&base.dice)
                            } else {
                                base.dice.clone()
                            },
                            DieRole::Damage,
                            DieBy::You,
                            &step.id,
                        ));
                        dice.extend(traced(
                            &if better {
                                fresh.dice.clone()
                            } else {
                                dropped(&fresh.dice)
                            },
                            DieRole::Damage,
                            DieBy::You,
                            &step.id,
                        ));
                        let separate_dice: Vec<SampledDie> = payload
                            .separate
                            .iter()
                            .flat_map(|s| s.dice.iter().cloned())
                            .collect();
                        dice.extend(traced(
                            &separate_dice,
                            DieRole::Damage,
                            DieBy::You,
                            &step.id,
                        ));
                        row_dice = dice;
                        if match_tracked {
                            matched = dice_matched(kept);
                        }
                    }
                }
                candidates.retain(|each| each.spends == spent);
                if match_tracked {
                    candidates.retain(|each| each.matched == matched);
                }
                if let Some(save_class) = roll.save_class {
                    candidates.retain(|each| save_kind(each, save_class));
                } else {
                    candidates.retain(|each| dealt_kind(each, outcome, own_total > 0.0));
                }

                // The folded riders' dice are drawn now (their law does not depend on which piece
                // is chosen); a chip rider's total comes from the chosen draw's payload below.
                let mut riders_dealt = false;
                let mut chips = false;
                let folded: &[(String, std::sync::Arc<Pmf>)] = candidates
                    .first()
                    .and_then(|first| first.riders.as_ref())
                    .map_or(&[], |riders| &riders[..]);
                for (id, _) in folded {
                    let rider = plan
                        .rider_of
                        .get(id)
                        .ok_or_else(|| internal("a folded rider the plan does not know"))?;
                    // Lands on anything, as the plan folds it (`fold`): never a rider folded to
                    // land on crits only.
                    let any = rider.landing == Some(RiderLanding::Any)
                        && !plan.per_hit_crit_only.contains(id);
                    // A rider whose coin is not a walk flag takes it per landing: the plan thins
                    // its payload (`thin`), so a failed coin deals 0 and the landing still counts.
                    // A rider whose dice joined the row's roll deals nothing beside it.
                    let coined = plan.coins.iter().any(|each| &each.id == id);
                    let joined = row_context.is_some_and(|c| c.joined.contains(id));
                    let skipped = !joined && !coined && !coin(rng, rider.happens.unwrap_or(1.0));
                    if skipped {
                        rider_skipped.insert(id.clone());
                    }
                    let crit_mode = !any && outcome == StepOutcome::Crit;
                    let drawn = if joined || skipped {
                        Some(RollSample {
                            total: 0.0,
                            dice: Vec::new(),
                        })
                    } else {
                        sample_folded_rider(
                            plan,
                            id,
                            rider,
                            &step.id,
                            crit_mode,
                            vulnerable && !any,
                            rng,
                        )?
                    };
                    let Some(drawn) = drawn else {
                        chips = true;
                        if !joined && !coined {
                            rider_passed.insert(id.clone(), rider.happens.unwrap_or(1.0));
                        }
                        continue;
                    };
                    let damage = drawn.total;
                    rider_damage.insert(id.clone(), damage);
                    if damage > 0.0 {
                        riders_dealt = true;
                    }
                    rider_dice.extend(traced(&drawn.dice, DieRole::Rider, DieBy::You, id));
                }
                if candidates.iter().any(|each| each.wounded.is_some()) {
                    let wounded = own_total > 0.0 || riders_dealt;
                    // Nothing dealt so far and a chip rider still to draw: the pieces' masses
                    // decide. Known approximation: those masses count a dice rider's zero as part
                    // of `allZero` too, so this is exact only where the dice riders cannot roll 0.
                    if wounded || !chips {
                        candidates.retain(|each| each.wounded == Some(wounded));
                    }
                }

                if candidates.is_empty() {
                    // Structural mismatch: no draw fits the dice. Fall back to the walk's own law
                    // for this outcome, the dice discarded.
                    SAMPLE_FALLBACKS.fetch_add(1, Ordering::Relaxed);
                    let by_outcome: Vec<&Draw> = variant
                        .iter()
                        .copied()
                        .filter(|each| each.outcome == outcome)
                        .collect();
                    draw = pick_by_mass(
                        if by_outcome.is_empty() {
                            &variant
                        } else {
                            &by_outcome
                        },
                        rng,
                    )?;
                    let own = sample_pmf(draw.own.as_ref().unwrap_or(&draw.slice), rng);
                    row_damage = own.total;
                    row_result = result_of(&own.outcome, draw.outcome);
                    row_dice = Vec::new();
                    rider_dice.clear();
                    rider_damage.clear();
                    rider_skipped.clear();
                    rider_passed.clear();
                    spent = draw.spends;
                } else {
                    draw = pick_by_mass(&candidates, rng)?;
                    row_damage = own_total;
                    row_result = result;
                }
            }
        }

        wave.dice.extend(row_dice);
        wave.dice.extend(rider_dice);
        outcome_of(&mut wave, &mut total, &step.id, row_result, row_damage);
        if let Some(riders) = &draw.riders {
            for (id, payload) in riders.iter() {
                if rider_skipped.contains(id) {
                    outcome_of(&mut wave, &mut total, id, OutcomeResult::Skipped, 0.0);
                } else {
                    let damage = if let Some(damage) = rider_damage.get(id) {
                        *damage
                    } else {
                        let happens = rider_passed.get(id).copied().unwrap_or(1.0);
                        sample_pmf(&unthin(payload, happens), rng).total
                    };
                    outcome_of(&mut wave, &mut total, id, OutcomeResult::Fired, damage);
                }
            }
        }

        // Then exactly as the walk: flags consumed, groups advanced, slots marked, grants applied.
        let (outcome, matched, by_kind) = (draw.outcome, draw.matched, draw.by_kind);
        let consumed = flags_before & !step.consumes;
        flags = (match outcome {
            StepOutcome::None => flags_before,
            StepOutcome::Miss => consumed,
            _ => consumed & !step.hit_consumes,
        }) & (if draw.wounded == Some(true) {
            !step.wounds
        } else {
            !0
        });
        if !draw.bumps.is_empty() {
            for &counter in &draw.bumps {
                if let Some(cell) = counts.get_mut(counter) {
                    *cell += 1;
                }
            }
        }
        codes.clone_from(&codes_before);
        for (index, &group) in step.updates.iter().enumerate() {
            let kind = step.update_kinds.get(index).copied().flatten();
            let folded = match (kind, by_kind) {
                (Some(kind), Some(by_kind)) => by_kind.of(kind),
                _ => outcome,
            };
            if let Some(code) = codes.get_mut(group) {
                *code = advance(*code, folded, matched);
            }
        }
        if spent || !draw.fires.is_empty() || draw.reroll_slot.is_some() {
            let landed = fire_of(outcome);
            if spent && let Some(cell) = step.spend_slot.and_then(|slot| fired.get_mut(slot)) {
                *cell = landed;
            }
            if let Some(cell) = draw.reroll_slot.and_then(|slot| fired.get_mut(slot)) {
                *cell = landed;
            }
            for &slot in &draw.fires {
                if let Some(cell) = fired.get_mut(slot) {
                    *cell = landed;
                }
            }
        }
        for app in &step.grants {
            if !grant_applies(
                app,
                outcome,
                &codes_before,
                by_kind,
                flags_before,
                draw.riders.as_ref(),
                draw.typed,
            ) {
                continue;
            }
            // A grant save fails by the state the row started in; one a row that dealt damage
            // forces is made once it is dealt.
            let chance = match &app.chance_of {
                None => app.chance,
                Some(chance_of) => chance_of(if draw.wounded == Some(true) {
                    flags_before & !step.wounds
                } else {
                    flags_before
                })?,
            };
            if app.count_only {
                continue;
            }
            if app.in_force != 0 && flags & app.in_force == app.in_force {
                continue;
            }
            let taken = coin(rng, chance);
            if chance > 0.0
                && chance < 1.0
                && let Some(id) = plan.condition_ids.get(app.condition)
            {
                outcome_of(
                    &mut wave,
                    &mut total,
                    id,
                    if taken {
                        OutcomeResult::SaveFail
                    } else {
                        OutcomeResult::SavePass
                    },
                    0.0,
                );
            }
            let tried = match app.tried {
                super::plan::Tried::Bit(bit) => bit,
                _ => 0,
            };
            flags |= (if taken { app.grants } else { app.on_save }) | tried;
        }
        settle!();
        waves.push(wave);
    }

    Ok(Trace {
        total,
        sampler_version: VERSION,
        waves,
    })
}
