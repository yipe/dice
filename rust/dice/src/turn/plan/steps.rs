//! `buildPlan` 3957-4700 (src/turn/plan.ts): the steps and the [`TurnPlan`]. [`build_plan`] runs
//! the four stretches in order: `resolve`, `layout`, `fold`, then this one.
//!
//! A step's `variants` and `context_pmfs` are built lazily (block 0 and the base context now, every
//! other block or context the first time a walk selects it); the closures that do so share the
//! step's [`Lazy`] tables. Every build that can run during a walk serialises on the step's `grow`
//! lock, so two walks never claim the same slots of a table.
//!
//! Deviations from the TS (ADR-017 / the typed spec):
//! - `rederive` for a source with no row check: Rust has no source with `withCheck` but no row
//!   check, so that case is the `no-rebindable-source` failure a source with neither gets.
//! - `laterLandings` (`canLand`) recurses once per step: past `MAX_DEPTH` it is the JS
//!   `RangeError: Maximum call stack size exceeded` (ADR-016).
//! - The TS memo maps `rederivedBuilders` and `pmfsUnder` (pure caches) are not kept.

use super::fold::{Folds, HoldChoice, RerollArg};
use super::layout::{Entry, Layout};
use super::resolve::Resolved;
use super::source::{self, PlanDamage, SourceSlices};
use super::{
    Coin, ContextIndexFn, Draw, FireMode, FlagRead, FoldMode, Gate, GateReads, Lazy,
    MAX_TURN_STATES, SelectFn, Step, StepDamage, StepReroll, StepVariant, TurnPlan, advanced, fail,
    fire_mode, gate_open, merge_draws, released, scale_draw, split_wounded,
};
use crate::Pmf;
use crate::builder::num::MAX_DEPTH;
use crate::common::RollType;
use crate::error::DiceError;
use crate::turn::context::{
    MOD_ADVANTAGE, MOD_CRIT_ON_HIT, MOD_DISADVANTAGE, MOD_PENALTY_SHIFT, PenaltyDice, RowCheck,
    RowContext, RowKind, RowRange, context_key, context_of, row_check_of,
};
use crate::turn::state::StepOutcome;
use crate::turn::types::{
    AfterLanding, ConditionSpec, RiderLanding, SaveLanding, SubstituteOn, SubstitutePolicy,
    Trigger, TurnSpec, TurnSpecErrorCode,
};
use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// `buildPlan(spec, eps, declined, folds)`: builds the plan of `spec`. `declined` names optional
/// conditions the turn does not attempt: each stays, with no row it watches, so it never lands.
pub fn build_plan(
    spec: &TurnSpec,
    eps: f64,
    declined: &HashSet<String>,
    folds: FoldMode,
) -> Result<TurnPlan, DiceError> {
    let res = Arc::new(super::resolve::resolve(spec, eps, declined, folds)?);
    let lay = Arc::new(super::layout::layout(&res)?);
    let folds = Arc::new(super::fold::build_folds(&res, &lay)?);
    build_steps(&res, &lay, &folds)
}

// --- small helpers ------------------------------------------------------------------------

/// A poisoned lock still holds a consistent table: every write under these locks is one store.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// JS `1 << bit` for a flag bit (32-bit shift: the count wraps mod 32, `-1` is the sign bit).
fn bit_mask(bit: i32) -> u32 {
    1u32.wrapping_shl(bit as u32)
}

/// JS `1 << n`.
fn bit_at(n: usize) -> u32 {
    1u32.wrapping_shl(n as u32)
}

/// `fired[slot] === null`: false for a slot that does not exist (`undefined`).
fn is_unfired(fired: &[FireMode], slot: Option<usize>) -> bool {
    slot.is_some_and(|s| matches!(fired.get(s), Some(None)))
}

/// An invariant of the layout that the TS takes for granted (`as number`, `as Flag`).
fn internal(what: &str) -> DiceError {
    DiceError::Error(format!("internal plan error: {what}"))
}

/// JS default `Array.prototype.sort` on strings: UTF-16 code unit order.
fn sort_utf16(values: &mut [String]) {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `plainSelect`: the plain variant.
fn plain_select() -> SelectFn {
    Arc::new(|_, _, _, _| Ok(0))
}

/// The select of a step in the snapshot `laterLandings` reads: never called.
fn inert_select() -> SelectFn {
    Arc::new(|_, _, _, _| Err(internal("select of a plan snapshot")))
}

/// `thin(pmf, happens)`: `pmf` with the probability `1 - happens` moved to a 0 damage.
fn thin(pmf: &Arc<Pmf>, happens: f64, eps: f64) -> Result<Arc<Pmf>, DiceError> {
    if happens == 1.0 {
        return Ok(Arc::clone(pmf));
    }
    let zero = Pmf::delta(0.0, eps)?;
    Ok(Arc::new(
        pmf.scale_mass(happens).add(&zero.scale_mass(1.0 - happens)),
    ))
}

// --- laterLandings -------------------------------------------------------------------------

/// `laterLandings[substitute]`: can a step the substitute watches still land, from step `from`
/// on, in the state (`codes`, `fired`)? Exact reachability over the walk's own transitions: every
/// positive-mass draw of each later step's plain variant, memoized on the state. It reads the
/// same group codes and fire slots the walk keys on, so a threshold never holds for a watched
/// step that can no longer fire.
struct LaterLandings {
    watched: HashSet<String>,
    /// The last step watched (`None`: TS -1).
    last_watched: Option<usize>,
    memo: Mutex<HashMap<String, bool>>,
    /// A light copy of the finished steps (selects are inert), set once the loop is done.
    steps: Arc<OnceLock<Vec<Step>>>,
    eps: f64,
    folds: Arc<Folds>,
}

impl LaterLandings {
    fn can_land(
        &self,
        from: usize,
        codes: &[u32],
        fired: &[FireMode],
        depth: usize,
    ) -> Result<bool, DiceError> {
        if self.last_watched.is_none_or(|last| from > last) {
            return Ok(false);
        }
        if depth > MAX_DEPTH {
            return Err(DiceError::Range(
                "Maximum call stack size exceeded".to_string(),
            ));
        }
        let key = format!(
            "{from}|{}|{}",
            codes
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
            fired
                .iter()
                .map(|mode| if mode.is_none() { '-' } else { '+' })
                .collect::<String>()
        );
        if let Some(known) = lock(&self.memo).get(&key).copied() {
            return Ok(known);
        }
        let steps = self
            .steps
            .get()
            .ok_or_else(|| internal("canLand before the steps were built"))?;
        let step = steps
            .get(from)
            .ok_or_else(|| internal("canLand past the last step"))?;
        // A gated attack that is closed does not happen: it lands nothing, and the next step
        // reads the same state.
        let mode = if step
            .gate
            .as_ref()
            .is_some_and(|gate| !gate_open(gate, codes, fired))
        {
            None
        } else {
            fire_mode(step, codes, fired)
        };
        let result = if mode.is_none() {
            self.can_land(from + 1, &released(codes, &step.releases), fired, depth + 1)?
        } else {
            let next: Vec<FireMode> = match step.slot {
                None => fired.to_vec(),
                Some(slot) => fired
                    .iter()
                    .enumerate()
                    .map(|(index, current)| if index == slot { mode } else { *current })
                    .collect(),
            };
            if step.variants.is_empty() {
                self.can_land(from + 1, &released(codes, &step.releases), &next, depth + 1)?
            } else {
                let plain = step
                    .variants
                    .get(0)
                    .ok_or_else(|| internal("variant 0 is not built"))?;
                let watches = self.watched.contains(&step.id);
                let mut found = false;
                for draw in plain.iter() {
                    if draw.slice.mass() > self.eps {
                        if matches!(draw.outcome, StepOutcome::Hit | StepOutcome::Crit) && watches {
                            found = true;
                            break;
                        }
                        let after = released(
                            &advanced(
                                codes,
                                &step.updates,
                                &step.update_kinds,
                                draw.outcome,
                                draw.matched,
                                draw.by_kind,
                            ),
                            &step.releases,
                        );
                        let folded = self.folds.with_folded(&next, &step.id, Some(draw));
                        if self.can_land(from + 1, &after, &folded, depth + 1)? {
                            found = true;
                            break;
                        }
                    }
                }
                found
            }
        };
        lock(&self.memo).insert(key, result);
        Ok(result)
    }
}

// --- one step's tables ---------------------------------------------------------------------

/// Builds one block of variants for a cap mask: `tableAt`'s `{ variants, select }`.
type MakeFn = Arc<dyn Fn(u32) -> Result<(Vec<StepVariant>, SelectFn), DiceError> + Send + Sync>;

/// What the closures that build a step's tables (during the build and the walk) read of it.
struct StepCtx {
    folds: Arc<Folds>,
    lay: Arc<Layout>,
    id: String,
    step_index: usize,
    /// `slices` (`None`: a rider that is not attack-shaped).
    slices: Option<SourceSlices>,
    /// `watchedKinds !== undefined`.
    watched_kinds: bool,
    unwatched_save: bool,
    substitute: Option<usize>,
    spend_slot: Option<usize>,
    converts: bool,
    /// `substitutes[substitute].policy ?? { kind: "always" }`.
    policy: SubstitutePolicy,
    rerolls: Vec<StepReroll>,
    updates: Vec<usize>,
    update_kinds: Vec<Option<SaveLanding>>,
    releases: Vec<usize>,
    capped: Vec<usize>,
    coined: Vec<usize>,
    gate_masks: Vec<u32>,
    chance: f64,
    /// The draw of the row not happening at all.
    none: Draw,
    wounds: u32,
    later: Option<Arc<LaterLandings>>,
    base_context: Option<RowContext>,
    /// `Step.variants`, filled as the build and the walk reach blocks.
    variants: Lazy<StepVariant>,
    /// Serialises every append to `variants`.
    grow: Mutex<()>,
}

impl StepCtx {
    /// A variant as the walk draws it: a row that finds a condition damage ends splits each draw
    /// by whether it dealt damage, and a row that may not happen draws "none" beside its outcomes.
    fn finish(&self, variant: &[Draw]) -> Result<Vec<Draw>, DiceError> {
        let split: Vec<Draw> = if self.wounds != 0 {
            let mut out = Vec::new();
            for draw in variant {
                out.extend(split_wounded(draw)?);
            }
            out
        } else {
            variant.to_vec()
        };
        if self.chance < 1.0 {
            let mut scaled: Vec<Draw> = split
                .iter()
                .map(|draw| scale_draw(draw, self.chance))
                .collect();
            scaled.push(self.none.clone());
            Ok(merge_draws(scaled))
        } else {
            Ok(split)
        }
    }

    /// The plain draws and, under a substitute, one variant per hold mask (variant 1 + mask: bit
    /// i set <=> choice i is held; only a threshold policy has choices), for one roll context's
    /// slices, with the capped riders of `cap` folded in.
    fn table_at(
        self: &Arc<Self>,
        context_slices: &SourceSlices,
        cap: u32,
        vulnerable: bool,
        joined: &[String],
        row_context: Option<&RowContext>,
    ) -> Result<(Vec<StepVariant>, SelectFn), DiceError> {
        let id = self.id.as_str();
        let folds = &self.folds;
        if !self.rerolls.is_empty() {
            // One variant per reroll still unspent (-1: none left), beside a first-hit transform
            // spent or not: at a miss the first unspent reroll rolls it again, and the reroll's
            // hit and crit draws spend the transform like the row's own.
            let stride = if self.substitute.is_none() { 1 } else { 2 };
            let mut rerolled: Vec<Option<RerollArg>> = vec![None];
            for reroll in &self.rerolls {
                let missed = folds.miss_rerolled_of(id, row_context, reroll.mode)?;
                rerolled.push(Some(RerollArg {
                    slices: folds.reroll_slices_of(&missed)?,
                    slot: reroll.slot,
                }));
            }
            let mut variants: Vec<StepVariant> = Vec::new();
            for reroll in &rerolled {
                let (plain, _) = folds.draws_for(
                    id,
                    context_slices,
                    None,
                    cap,
                    vulnerable,
                    joined,
                    row_context,
                    false,
                    reroll.as_ref(),
                )?;
                if self.substitute.is_none() {
                    variants.push(plain);
                    continue;
                }
                let (spent, _) = folds.draws_for(
                    id,
                    context_slices,
                    Some(SubstitutePolicy::Always),
                    cap,
                    vulnerable,
                    joined,
                    row_context,
                    false,
                    reroll.as_ref(),
                )?;
                variants.push(plain);
                variants.push(merge_draws(spent));
            }
            let ctx = Arc::clone(self);
            let select: SelectFn = Arc::new(move |_codes, fired, _flags, _counts| {
                let next = ctx
                    .rerolls
                    .iter()
                    .position(|reroll| is_unfired(fired, Some(reroll.slot)))
                    .map_or(0, |index| index + 1);
                let transformed =
                    usize::from(ctx.substitute.is_some() && is_unfired(fired, ctx.spend_slot));
                Ok(next * stride + transformed)
            });
            return Ok((variants, select));
        }
        let (plain, _) = folds.draws_for(
            id,
            context_slices,
            None,
            cap,
            vulnerable,
            joined,
            row_context,
            false,
            None,
        )?;
        if self.substitute.is_none() {
            return Ok((vec![plain], plain_select()));
        }
        if self.converts {
            // Variant 1 converts the miss; it is drawn while the conversion is unspent.
            let (converted, _) = folds.draws_for(
                id,
                context_slices,
                None,
                cap,
                vulnerable,
                joined,
                row_context,
                true,
                None,
            )?;
            let spend_slot = self.spend_slot;
            let select: SelectFn = Arc::new(move |_codes, fired, _flags, _counts| {
                Ok(usize::from(is_unfired(fired, spend_slot)))
            });
            return Ok((vec![plain, converted], select));
        }
        let (fixed, choices) = folds.draws_for(
            id,
            context_slices,
            Some(self.policy),
            cap,
            vulnerable,
            joined,
            row_context,
            false,
            None,
        )?;
        let mut own: Vec<StepVariant> = vec![plain];
        let masks = 1usize.checked_shl(choices.len() as u32).unwrap_or(0);
        for mask in 0..masks {
            let mut draws = fixed.clone();
            for (bit, choice) in choices.iter().enumerate() {
                let held = mask & bit_at(bit) as usize != 0;
                draws.extend(if held {
                    choice.hold.iter().cloned()
                } else {
                    choice.spend.iter().cloned()
                });
            }
            own.push(merge_draws(draws));
        }
        let ctx = Arc::clone(self);
        let can_land = self.later.clone();
        let choices: Vec<HoldChoice> = choices;
        // Hold an above-threshold landing only while a later watched step can still land in the
        // state holding leaves: this step's outcome recorded, the substitute unspent, and the
        // fire slot of any per-source first hit this landing marks. Otherwise holding is worth
        // nothing, so it spends.
        let select: SelectFn = Arc::new(move |codes, fired, _flags, _counts| {
            if !is_unfired(fired, ctx.spend_slot) {
                return Ok(0);
            }
            let Some(later) = &can_land else {
                return Err(internal("a substitute without laterLandings"));
            };
            let landed = ctx.folds.with_folded(fired, &ctx.id, None);
            let mut mask = 0usize;
            for (bit, choice) in choices.iter().enumerate() {
                let after = released(
                    &advanced(
                        codes,
                        &ctx.updates,
                        &ctx.update_kinds,
                        choice.outcome,
                        choice.matched,
                        None,
                    ),
                    &ctx.releases,
                );
                if later.can_land(ctx.step_index + 1, &after, &landed, 0)? {
                    mask |= bit_at(bit) as usize;
                }
            }
            Ok(1 + mask)
        });
        Ok((own, select))
    }

    /// The cap mask of a state: bit i is `capped[i]`'s counter still below its cap, then one per
    /// coin that came up, then one per `targetHas` set that is open.
    fn cap_of(&self, flags: u32, counts: &[u32]) -> u32 {
        let mut cap = 0u32;
        for (bit, &counter) in self.capped.iter().enumerate() {
            let below = match (counts.get(counter), self.folds.counter_max.get(counter)) {
                (Some(&count), Some(&max)) => f64::from(count) < max,
                _ => false,
            };
            if below {
                cap |= bit_at(bit);
            }
        }
        for (k, &node) in self.coined.iter().enumerate() {
            let flag = self
                .lay
                .coin_flags
                .get(node)
                .copied()
                .flatten()
                .and_then(|index| self.lay.flags.get(index));
            // INFALLIBLE: a coin folded into a source has a flag; none reads as the coin not up.
            if let Some(flag) = flag
                && flags & bit_mask(flag.bit) != 0
            {
                cap |= bit_at(self.capped.len() + k);
            }
        }
        for (k, &open) in self.gate_masks.iter().enumerate() {
            if flags & open != 0 {
                cap |= bit_at(self.capped.len() + self.coined.len() + k);
            }
        }
        cap
    }

    /// Writes the finished variants of one block into `variants` from `at` on; remembers where.
    fn fill(
        &self,
        block_at: &Mutex<HashMap<u32, usize>>,
        cap: u32,
        at: usize,
        variants: &[StepVariant],
        size: usize,
    ) -> Result<usize, DiceError> {
        for i in 0..size {
            let variant = variants
                .get(i)
                .ok_or_else(|| internal("a block with fewer variants than block 0"))?;
            self.variants.set(at + i, self.finish(variant)?);
        }
        lock(block_at).insert(cap, at);
        Ok(at)
    }

    /// One roll context's variants for every cap mask, block by block: variant `offset + cap *
    /// size + i` of `variants` is `make`'s variant `i` with the riders of `cap` folded in,
    /// finished. A block is chosen by which capped counters are still below their cap, so variant
    /// 0 (cap 0) applies no capped rider. An uncapped step is one block.
    ///
    /// Block 0 is built now (it validates the row, and `laterLandings` reads a step's first
    /// variant); every other block the first time a walk selects it, appended where the table
    /// stands. `select` returns the index into `variants`.
    fn blocked(self: &Arc<Self>, make: MakeFn, offset: usize) -> Result<SelectFn, DiceError> {
        let (first, local) = make(0)?;
        // Every block has the same hold choices (they read the base payload, not the fold), so
        // block 0's variant count and choice rule serve for all.
        let size = first.len();
        let block_at: Arc<Mutex<HashMap<u32, usize>>> = Arc::new(Mutex::new(HashMap::new()));
        self.fill(&block_at, 0, offset, &first, size)?;
        if self.capped.len() + self.coined.len() + self.gate_masks.len() == 0 {
            let select: SelectFn = Arc::new(move |codes, fired, flags, counts| {
                Ok(offset + local(codes, fired, flags, counts)?)
            });
            return Ok(select);
        }
        let ctx = Arc::clone(self);
        let select: SelectFn = Arc::new(move |codes, fired, flags, counts| {
            let cap = ctx.cap_of(flags, counts);
            let known = lock(&block_at).get(&cap).copied();
            let at = if let Some(at) = known {
                at
            } else {
                let _grow = lock(&ctx.grow);
                let again = lock(&block_at).get(&cap).copied();
                if let Some(at) = again {
                    at
                } else {
                    let (variants, _) = make(cap)?;
                    let at = ctx.variants.len();
                    ctx.fill(&block_at, cap, at, &variants, size)?
                }
            };
            Ok(at + local(codes, fired, flags, counts)?)
        });
        Ok(select)
    }

    /// `table`: `tableAt` over one roll context's slices, blocked by cap mask.
    fn table(
        self: &Arc<Self>,
        context_slices: SourceSlices,
        offset: usize,
        vulnerable: bool,
        joined: Vec<String>,
        row_context: Option<RowContext>,
    ) -> Result<SelectFn, DiceError> {
        let ctx = Arc::clone(self);
        let make: MakeFn = Arc::new(move |cap| {
            ctx.table_at(
                &context_slices,
                cap,
                vulnerable,
                &joined,
                row_context.as_ref(),
            )
        });
        self.blocked(make, offset)
    }

    /// The row's table in a context, its finished variants written into `variants` from `offset`
    /// on (see [`StepCtx::blocked`]). A watched save row draws by class (one set per cap mask, no
    /// hold choice); any other row by its hit / crit / miss slices (an unwatched save row is one
    /// "hit" draw of its whole PMF). `None`: the row's own slices.
    fn table_of(
        self: &Arc<Self>,
        pmf: Option<Arc<Pmf>>,
        offset: usize,
        vulnerable: bool,
        joined: Vec<String>,
        row_context: Option<RowContext>,
    ) -> Result<SelectFn, DiceError> {
        if self.watched_kinds {
            let classes = pmf.as_deref().map(source::save_classes);
            let ctx = Arc::clone(self);
            let make: MakeFn = Arc::new(move |cap| {
                let draws = ctx.folds.save_row_draws(&ctx.id, cap, classes.as_ref())?;
                Ok((vec![draws], plain_select()))
            });
            return self.blocked(make, offset);
        }
        let Some(pmf) = pmf else {
            let slices = self
                .slices
                .clone()
                .ok_or_else(|| internal("a table of a row with no slices"))?;
            return self.table(slices, offset, false, Vec::new(), self.base_context.clone());
        };
        let slices = if self.unwatched_save {
            SourceSlices {
                hit: pmf,
                crit: Arc::new(Pmf::empty_mass()),
                miss: Arc::new(Pmf::empty_mass()),
            }
        } else {
            source::slice_source(&pmf, None, self.folds.res.eps)?
                .ok_or_else(|| internal("a context PMF that is not attack-shaped"))?
        };
        self.table(slices, offset, vulnerable, joined, row_context)
    }
}

// --- read flags select a roll context -------------------------------------------------------

/// Whether joining rider has a landing left (`leftAt`).
#[derive(Clone, Copy)]
enum Left {
    /// The rider has no payload on this row.
    Never,
    /// Its cap is not reached: the counter's count is below its max.
    Counter(Option<usize>),
    /// Its first landing is not made: the fire slot is empty.
    Slot(usize),
    /// Uncapped.
    Always,
}

/// The tables of a step whose roll context depends on the flags it reads: one per distinct
/// resolved context the read flags can reach, built the first time a state rolls in it.
struct ContextTables {
    ctx: Arc<StepCtx>,
    context_pmfs: Lazy<Pmf>,
    check: RowCheck,
    /// Per read: (the flag's mask, its key bits).
    reads: Vec<(u32, u32)>,
    /// Per penalty flag the step reads, its dice.
    penalties: Vec<PenaltyDice>,
    /// Per joining rider, its id.
    joiner_ids: Vec<String>,
    lefts: Vec<Left>,
    /// Context key -> context index.
    table_of_key: HashMap<u32, usize>,
    /// Per context index past the base, the key it was first reached with.
    pending: HashMap<usize, u32>,
    /// Per context index, its table once built.
    tables: Mutex<Vec<Option<SelectFn>>>,
}

impl ContextTables {
    /// Each joining rider has a key bit above the penalties: set while it has a landing left.
    fn joiner_bit(&self, j: usize) -> u32 {
        bit_at(MOD_PENALTY_SHIFT as usize + self.penalties.len() + j)
    }

    fn joined_of(&self, key: u32) -> Vec<String> {
        let mut joined: Vec<String> = self
            .joiner_ids
            .iter()
            .enumerate()
            .filter(|(j, _)| key & self.joiner_bit(*j) != 0)
            .map(|(_, id)| id.clone())
            .collect();
        sort_utf16(&mut joined);
        joined
    }

    /// The context a row rolls in under `key`, with its joined riders.
    fn row_context_of(&self, key: u32) -> RowContext {
        let penalties: Vec<PenaltyDice> = self
            .penalties
            .iter()
            .enumerate()
            .filter(|(j, _)| key & bit_at(MOD_PENALTY_SHIFT as usize + *j) != 0)
            .map(|(_, dice)| *dice)
            .collect();
        let mut context = context_of(&self.check, key, &penalties);
        context.joined = self.joined_of(key);
        context
    }

    fn key_in(&self, fired: &[FireMode], flags: u32, counts: &[u32]) -> u32 {
        let mut key = 0u32;
        for &(mask, bits) in &self.reads {
            if flags & mask != 0 {
                key |= bits;
            }
        }
        for (j, left) in self.lefts.iter().enumerate() {
            let has_left = match *left {
                Left::Never => false,
                Left::Always => true,
                Left::Slot(slot) => is_unfired(fired, Some(slot)),
                Left::Counter(counter) => match counter {
                    Some(counter) => {
                        match (counts.get(counter), self.ctx.folds.counter_max.get(counter)) {
                            (Some(&count), Some(&max)) => f64::from(count) < max,
                            _ => false,
                        }
                    }
                    None => false,
                },
            };
            if has_left {
                key |= self.joiner_bit(j);
            }
        }
        key
    }

    fn index_of(&self, fired: &[FireMode], flags: u32, counts: &[u32]) -> Result<usize, DiceError> {
        self.table_of_key
            .get(&self.key_in(fired, flags, counts))
            .copied()
            .ok_or_else(|| internal("a state reached a context key no flag set can make"))
    }

    /// Context `index`'s table, built (and its variants appended) the first time it is asked for.
    fn table_in(&self, index: usize) -> Result<SelectFn, DiceError> {
        if let Some(Some(known)) = lock(&self.tables).get(index) {
            return Ok(Arc::clone(known));
        }
        let _grow = lock(&self.ctx.grow);
        if let Some(Some(known)) = lock(&self.tables).get(index) {
            return Ok(Arc::clone(known));
        }
        let key = self
            .pending
            .get(&index)
            .copied()
            .ok_or_else(|| internal("a context index that was never reached"))?;
        let row_context = self.row_context_of(key);
        let source = self.ctx.folds.res.damage_of(&self.ctx.id);
        let contextual = match &source {
            PlanDamage::One(source) => source.as_contextual(),
            PlanDamage::Many(_) => None,
        }
        .ok_or_else(|| internal("a contextual row whose source is not contextual"))?;
        let pmf = source::pmf_under(
            contextual,
            &row_context,
            self.ctx.folds.res.eps,
            &self.ctx.id,
        )?;
        self.context_pmfs.set(index, pmf);
        let pmf = self
            .context_pmfs
            .get(index)
            .ok_or_else(|| internal("a context PMF that was just set"))?;
        let vulnerable = row_context.vulnerable;
        let joined = row_context.joined.clone();
        let built = self.ctx.table_of(
            Some(pmf),
            self.ctx.variants.len(),
            vulnerable,
            joined,
            Some(row_context),
        )?;
        let mut tables = lock(&self.tables);
        if tables.len() <= index {
            tables.resize_with(index + 1, || None);
        }
        if let Some(slot) = tables.get_mut(index) {
            *slot = Some(Arc::clone(&built));
        }
        Ok(built)
    }
}

// --- the steps ------------------------------------------------------------------------------

struct Builder<'a> {
    res: &'a Arc<Resolved>,
    lay: &'a Arc<Layout>,
    folds: &'a Arc<Folds>,
    /// `updatesById`: per source id, the group slots its outcome advances and their landing kinds.
    updates_by_id: HashMap<String, (Vec<usize>, Vec<Option<SaveLanding>>)>,
    /// `laterLandings`, per substitute.
    laters: Vec<Arc<LaterLandings>>,
    /// `watchPositions`: per counter, the sequence positions of the steps that watch it.
    watch_positions: Vec<Vec<usize>>,
}

impl Builder<'_> {
    /// What a gate on rider `node` reads of its group's code: what the rider's trigger reads, or
    /// for an every-hit rider, its landing.
    fn rider_reads(&self, node: usize) -> GateReads {
        let Some(rider) = self.res.riders.get(node) else {
            return GateReads::First;
        };
        match rider.trigger {
            Trigger::AnyCrit { .. } => GateReads::Crit,
            Trigger::AnyMiss { .. } | Trigger::FirstMiss { .. } => GateReads::Miss,
            Trigger::DiceMatch { .. } => GateReads::Match,
            // As `Turn.tally` reads it: a crit-only rider fired iff something crit, one that
            // lands on anything iff a watched row happened.
            Trigger::EveryHit { .. } => {
                if self.res.crit_only.contains(&node) {
                    GateReads::Crit
                } else if rider.landing == Some(RiderLanding::Any) {
                    GateReads::Any
                } else {
                    GateReads::First
                }
            }
            _ => GateReads::First,
        }
    }

    /// The gate of declared attack `attack` (`AttackOptions.after`), or `None` where it has none.
    fn gate_at(&self, attack: usize) -> Result<Option<Gate>, DiceError> {
        let Some(Some(after)) = self.res.attack_afters.get(attack) else {
            return Ok(None);
        };
        let rider = self.lay.gate_riders.get(attack).copied().flatten();
        let group = self.lay.gate_groups.get(attack).copied().flatten();
        let slot = || {
            self.lay
                .slot_of(group)
                .ok_or_else(|| internal("a gate whose group has no slot"))
        };
        let Some(rider) = rider else {
            return Ok(Some(Gate::Group {
                slot: slot()?,
                reads: if after.landing == AfterLanding::Any {
                    GateReads::Any
                } else {
                    GateReads::First
                },
            }));
        };
        // A first-hit rider folded into its sources' draws has no group: it marks its fire slot
        // where it lands.
        if group.is_none() {
            let fired = self
                .lay
                .fire_slots
                .get(&after.of)
                .copied()
                .ok_or_else(|| internal("a gate on a rider with no fire slot"))?;
            return Ok(Some(Gate::Fired { slot: fired }));
        }
        Ok(Some(Gate::Group {
            slot: slot()?,
            reads: self.rider_reads(rider),
        }))
    }

    fn fire_slot(&self, id: &str) -> Result<usize, DiceError> {
        // INFALLIBLE: layout gives every rider and substitute a fire slot.
        self.lay
            .fire_slots
            .get(id)
            .copied()
            .ok_or_else(|| internal("a node with no fire slot"))
    }

    #[allow(clippy::too_many_lines)]
    fn step(&self, step_index: usize, entry: &Entry) -> Result<Step, DiceError> {
        let res = self.res;
        let lay = self.lay;
        let folds = self.folds;
        let eps = res.eps;
        let rider = entry.rider.and_then(|index| res.riders.get(index));
        let slices: Option<SourceSlices> = match entry.attack {
            Some(attack) => Some(match res.attack_slices.get(attack).cloned().flatten() {
                Some(slices) => slices,
                None => SourceSlices {
                    hit: res
                        .attack_pmfs
                        .get(attack)
                        .cloned()
                        .ok_or_else(|| internal("an attack with no PMF"))?,
                    crit: Arc::new(Pmf::empty_mass()),
                    miss: Arc::new(Pmf::empty_mass()),
                },
            }),
            None => res.slices_of(&entry.id)?,
        };

        if let (Some(rider), Some(index)) = (rider, entry.rider)
            && (slices.is_some() || res.attack_lists.get(index).copied().unwrap_or(false))
            && rider.crit_damage.is_some()
        {
            // An attack-shaped rider rolls its own d20 and crits on its own terms: a bonus
            // attack triggered by a crit does not deal doubled dice, so there is nothing for
            // `critDamage` to mean. Silently dropping it would hide a real misunderstanding.
            return Err(fail(
                TurnSpecErrorCode::UnusedCritDamage,
                &entry.id,
                format!(
                    "Rider \"{}\" rolls its own attack, so its critDamage would never be used. Remove it, or pass plain damage dice instead.",
                    entry.id
                ),
            ));
        }

        let read_mask = lay.read_mask_at.get(step_index).copied().unwrap_or(0);
        let reads: &[(usize, u32)] = lay
            .reads_at
            .get(step_index)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut read_advantage = 0u32;
        let mut read_disadvantage = 0u32;
        let mut read_crit_on_hit = 0u32;
        for &(flag, modifiers) in reads {
            let Some(flag) = lay.flags.get(flag) else {
                continue;
            };
            if modifiers & MOD_ADVANTAGE != 0 {
                read_advantage |= bit_mask(flag.bit);
            }
            if modifiers & MOD_DISADVANTAGE != 0 {
                read_disadvantage |= bit_mask(flag.bit);
            }
            if modifiers & MOD_CRIT_ON_HIT != 0 {
                read_crit_on_hit |= bit_mask(flag.bit);
            }
        }
        if matches!(rider.map(|r| &r.trigger), Some(Trigger::AnyMiss { .. })) && slices.is_some() {
            // Its step runs after every declared attack, but in play the reroll happens right
            // after the miss: it would read, or grant to, the wrong attack rolls.
            let grant_source = res
                .condition_sources
                .iter()
                .any(|sources| sources.contains(&entry.id));
            if read_mask != 0 || grant_source {
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    &entry.id,
                    format!(
                        "Rider \"{}\" rerolls on any miss and {}. An any-miss rider resolves after every declared attack, so it would see the grants in force at the end of the turn instead of right after the miss. Use onFirstMiss (on: \"first-miss\"), which resolves directly after the attack that missed.",
                        entry.id,
                        if read_mask != 0 {
                            "reads a granted modifier"
                        } else {
                            "applies a condition's grants"
                        }
                    ),
                ));
            }
        }

        let (updates, update_kinds) = self
            .updates_by_id
            .get(&entry.id)
            .cloned()
            .unwrap_or_default();
        let watched_kinds = entry.attack.is_some() && res.landing_kinds_of(&entry.id).is_some();
        let substitute = if slices.is_some() {
            res.substitute_by_source.get(&entry.id).copied()
        } else {
            None
        };
        let spend_slot = match substitute {
            None => None,
            Some(substitute) => Some(
                self.fire_slot(
                    res.substitute_ids
                        .get(substitute)
                        .ok_or_else(|| internal("a substitute with no id"))?,
                )?,
            ),
        };
        let substitute_spec = substitute.and_then(|index| res.substitutes.get(index));
        let converts = substitute_spec.is_some_and(|spec| spec.on == SubstituteOn::FirstMiss);
        // The first-miss rerolls watching this row, in declaration order.
        let mut rerolls: Vec<StepReroll> = Vec::new();
        if slices.is_some() {
            for &index in res
                .miss_rerolls_by_source
                .get(&entry.id)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let spec = res
                    .substitutes
                    .get(index)
                    .ok_or_else(|| internal("a reroll with no substitute"))?;
                rerolls.push(StepReroll {
                    slot: self.fire_slot(
                        res.substitute_ids
                            .get(index)
                            .ok_or_else(|| internal("a substitute with no id"))?,
                    )?,
                    mode: spec
                        .mode
                        .unwrap_or(crate::builder::types::MissRerollMode::Reroll),
                });
            }
        }

        // The distinct capped counters watching this step's source: bit i of a cap mask is
        // `capped[i]`'s with-rider flag.
        let capped: Vec<usize> = folds
            .counters_by_source
            .get(&entry.id)
            .cloned()
            .unwrap_or_default();
        // The coins of the riders folded here: bit `capped.length + k` of a variant mask says coin
        // k came up.
        let coined: Vec<usize> = folds
            .coins_by_source
            .get(&entry.id)
            .cloned()
            .unwrap_or_default();
        // Per distinct `targetHas` set of the riders folded here, the flag bits that open it at
        // this step: bit `capped.length + coined.length + k` says gate set k is open.
        let gate_masks: Vec<u32> = folds
            .gate_sets_by_source
            .get(&entry.id)
            .map(|sets| {
                sets.values()
                    .map(|names| lay.gate_mask_at(names, step_index))
                    .collect()
            })
            .unwrap_or_default();

        // A watched save row draws by class; any other row by its hit / crit / miss slices (an
        // unwatched save row is one "hit" draw of its whole PMF).
        let unwatched_save = matches!(entry.attack, Some(attack) if res.attack_slices.get(attack).is_some_and(Option::is_none));
        let damage = res.damage_of(&entry.id);
        let base_check: Option<RowCheck> = match &damage {
            PlanDamage::One(source) => row_check_of(source),
            PlanDamage::Many(_) => None,
        };
        // The row's own context, where no flag is read: what the base table rolls in.
        let base_context = base_check.as_ref().map(|check| context_of(check, 0, &[]));
        let base_roll_type = base_context
            .as_ref()
            .map_or(RollType::Flat, |context| context.roll_type);
        // The row's own PMF in each context its tables roll in, and which context a state picks.
        let own_pmf: Option<Arc<Pmf>> = match entry.attack {
            Some(attack) => Some(
                res.attack_pmfs
                    .get(attack)
                    .cloned()
                    .ok_or_else(|| internal("an attack with no PMF"))?,
            ),
            None if slices.is_some() => Some(
                res.rider_pmf(
                    entry
                        .rider
                        .ok_or_else(|| internal("a step that is no attack and no rider"))?,
                )?,
            ),
            None => None,
        };
        let context_pmfs: Lazy<Pmf> = Lazy::new();
        let mut context_vulnerable: Vec<bool> = Vec::new();
        let mut context_roll_types: Vec<RollType> = Vec::new();
        let mut context_row_contexts: Vec<Option<RowContext>> = Vec::new();
        if let Some(own) = &own_pmf {
            context_pmfs.set_arc(0, Arc::clone(own));
            context_vulnerable.push(false);
            context_roll_types.push(base_roll_type);
            context_row_contexts.push(base_context.clone());
        }
        let mut context_index_of: ContextIndexFn = Arc::new(|_, _, _, _| Ok(0));

        // Occurrence probability: with probability 1 - chance the attack does not happen at all.
        // That branch is a "none" draw (no miss, no landing, no crit, no match, 0 damage)
        // labelled missNone so the chart conserves mass the way applyHitFrequency's freed mass
        // does. Declared attacks only; riders already fire on their trigger's terms.
        let chance = match entry.attack {
            Some(attack) => res.attack_chances.get(attack).copied().unwrap_or(1.0),
            None => 1.0,
        };
        let none = Draw::plain(
            StepOutcome::None,
            false,
            false,
            Arc::new(Pmf::miss_none(eps).scale_mass(1.0 - chance)),
        );

        let ctx = Arc::new(StepCtx {
            folds: Arc::clone(folds),
            lay: Arc::clone(lay),
            id: entry.id.clone(),
            step_index,
            slices: slices.clone(),
            watched_kinds,
            unwatched_save,
            substitute,
            spend_slot,
            converts,
            policy: substitute_spec
                .and_then(|spec| spec.policy)
                .unwrap_or(SubstitutePolicy::Always),
            rerolls: rerolls.clone(),
            updates: updates.clone(),
            update_kinds: update_kinds.clone(),
            releases: lay.releases_at.get(step_index).cloned().unwrap_or_default(),
            capped,
            coined,
            gate_masks,
            chance,
            none,
            wounds: lay.wounds_at.get(step_index).copied().unwrap_or(0),
            later: substitute.and_then(|index| self.laters.get(index).cloned()),
            base_context: base_context.clone(),
            variants: Lazy::new(),
            grow: Mutex::new(()),
        });

        // The riders whose dice join this row's roll while they have a landing left
        // (`Rider.joins`).
        let joiners: Vec<usize> = res
            .riders
            .iter()
            .enumerate()
            .filter(|(index, rider)| {
                rider
                    .joins
                    .as_ref()
                    .is_some_and(|joins| joins.contains(&entry.id))
                    && res
                        .source_ids_by_node
                        .get(*index)
                        .is_some_and(|ids| ids.contains(&entry.id))
            })
            .map(|(index, _)| index)
            .collect();

        let mut select: SelectFn = plain_select();
        if (watched_kinds || slices.is_some()) && read_mask == 0 && joiners.is_empty() {
            select = ctx.table_of(None, 0, false, Vec::new(), base_context.clone())?;
        } else if watched_kinds || slices.is_some() {
            // Read flags select a roll context. A contextual source rolls under it. One table per
            // distinct resolved context the read flags can reach, not per flag set.
            let Some(check) = base_check else {
                return Err(fail(
                    TurnSpecErrorCode::NoRebindableSource,
                    &entry.id,
                    format!(
                        "\"{}\" reads a granted modifier, but it has no attack check to re-derive (an attack that always hits, a bare PMF or a list of payloads). Scope the grant with `to`.",
                        entry.id
                    ),
                ));
            };
            // Each penalty flag the step reads has a key bit of its own above the modifiers.
            let penalty_flags: Vec<usize> = reads
                .iter()
                .filter(|(flag, _)| {
                    lay.flags
                        .get(*flag)
                        .is_some_and(|flag| flag.penalty.is_some())
                })
                .map(|(flag, _)| *flag)
                .collect();
            let penalties: Vec<PenaltyDice> = penalty_flags
                .iter()
                .filter_map(|flag| lay.flags.get(*flag).and_then(|flag| flag.penalty))
                .collect();
            let mut read_keys: Vec<(u32, u32)> = Vec::new();
            for &(flag_index, modifiers) in reads {
                let Some(flag) = lay.flags.get(flag_index) else {
                    continue;
                };
                let key = if flag.penalty.is_none() {
                    modifiers
                } else {
                    let at = penalty_flags
                        .iter()
                        .position(|each| *each == flag_index)
                        .unwrap_or(0);
                    bit_at(MOD_PENALTY_SHIFT as usize + at)
                };
                read_keys.push((bit_mask(flag.bit), key));
            }
            let per_hit = folds
                .per_hit_by_source
                .get(&entry.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let capped_of = folds
                .counters_by_source
                .get(&entry.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let joiner_ids: Vec<String> = joiners
                .iter()
                .map(|&index| res.rider_ids.get(index).cloned().unwrap_or_default())
                .collect();
            let lefts: Vec<Left> = joiner_ids
                .iter()
                .map(|id| {
                    let Some(payload) = per_hit.iter().find(|each| &each.id == id) else {
                        return Left::Never;
                    };
                    if payload.bit != 0 {
                        let counter = if payload.bit.is_power_of_two() {
                            capped_of
                                .get(payload.bit.trailing_zeros() as usize)
                                .copied()
                        } else {
                            None
                        };
                        return Left::Counter(counter);
                    }
                    match payload.slot {
                        Some(slot) => Left::Slot(slot),
                        None => Left::Always,
                    }
                })
                .collect();

            let mut tables = ContextTables {
                ctx: Arc::clone(&ctx),
                context_pmfs: context_pmfs.clone(),
                check: check.clone(),
                reads: read_keys,
                penalties,
                joiner_ids,
                lefts,
                table_of_key: HashMap::new(),
                pending: HashMap::new(),
                tables: Mutex::new(Vec::new()),
            };
            let plain = context_key(&tables.row_context_of(0));
            let mut reachable: IndexSet<u32> = IndexSet::new();
            reachable.insert(0);
            let keys: Vec<u32> = tables
                .reads
                .iter()
                .map(|&(_, key)| key)
                .chain((0..joiners.len()).map(|j| tables.joiner_bit(j)))
                .collect();
            for bits in keys {
                let extended: Vec<u32> = reachable.iter().map(|key| key | bits).collect();
                reachable.extend(extended);
            }
            // The base context's table is built now (it validates the row); every other context's
            // the first time a state rolls in it, as the engine compiles a context only where one
            // is reached.
            let base = ctx.table_of(None, 0, false, Vec::new(), base_context.clone())?;
            let mut built: Vec<Option<SelectFn>> = vec![Some(base)];
            let mut table_by_context: HashMap<String, usize> = HashMap::new();
            table_by_context.insert(plain, 0);
            let roll_type_in = |key: u32| context_of(&check, key, &[]).roll_type;
            if let Some(first) = context_roll_types.first_mut() {
                *first = roll_type_in(0);
            } else {
                context_roll_types.push(roll_type_in(0));
            }
            for &key in &reachable {
                let row_context = tables.row_context_of(key);
                let signature = context_key(&row_context);
                let index = if let Some(&index) = table_by_context.get(&signature) {
                    index
                } else {
                    let index = built.len();
                    built.push(None);
                    tables.pending.insert(index, key);
                    context_vulnerable.push(row_context.vulnerable);
                    context_roll_types.push(roll_type_in(key));
                    context_row_contexts.push(Some(row_context));
                    table_by_context.insert(signature, index);
                    index
                };
                tables.table_of_key.insert(key, index);
            }
            context_pmfs.set_len(built.len());
            tables.tables = Mutex::new(built);
            let tables = Arc::new(tables);
            let for_select = Arc::clone(&tables);
            select = Arc::new(move |codes, fired, flags, counts| {
                let index = for_select.index_of(fired, flags, counts)?;
                for_select.table_in(index)?(codes, fired, flags, counts)
            });
            let for_index = Arc::clone(&tables);
            context_index_of = Arc::new(move |_codes, fired, flags, counts| {
                for_index.index_of(fired, flags, counts)
            });
        } else if read_mask != 0 {
            return Err(fail(
                TurnSpecErrorCode::NoRebindableSource,
                &entry.id,
                format!(
                    "\"{}\" reads a granted modifier, but it is a list of several attacks, with no single attack check to re-derive. Declare each attack as its own rider, or scope the grant with `to`.",
                    entry.id
                ),
            ));
        }

        let happens = match entry.rider {
            Some(index) => lay.happens_of.get(index).copied().unwrap_or(1.0),
            None => 1.0,
        };
        if happens < 1.0 && slices.is_some() {
            return Err(fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                &entry.id,
                format!(
                    "Rider \"{}\" rolls its own attack and sets \"happens\"; only a damage rider may not happen.",
                    entry.id
                ),
            ));
        }
        let hit = match (rider, entry.rider) {
            (Some(_), Some(index)) if slices.is_none() => Some(res.rider_pmf(index)?),
            _ => None,
        };
        let negated = match rider.map(|r| &r.trigger) {
            Some(Trigger::NotFired { of }) => lay.fire_slots.get(of).copied(),
            _ => None,
        };
        let step_damage = match (&hit, rider) {
            (Some(hit), Some(rider)) => {
                let thinned = thin(hit, happens, eps)?;
                let crit = source::crit_pmf(&rider.damage, rider.crit_damage.as_ref(), hit, eps)?;
                Some(StepDamage {
                    hit: thinned,
                    crit: thin(&Arc::new(crit), happens, eps)?,
                })
            }
            _ => None,
        };

        let settled: Vec<f64> = folds
            .counter_max
            .iter()
            .enumerate()
            .map(|(counter, max)| {
                let after = self.watch_positions.get(counter).map_or(0, |positions| {
                    positions.iter().filter(|&&p| p > step_index).count()
                });
                max - after as f64
            })
            .collect();

        Ok(Step {
            id: entry.id.clone(),
            trigger: rider.cloned(),
            variants: ctx.variants.clone(),
            select,
            damage: step_damage,
            updates,
            update_kinds,
            releases: ctx.releases.clone(),
            settled,
            reads: entry
                .rider
                .and_then(|index| lay.reads_by_rider.get(&index))
                .and_then(|&group| lay.slot_of(Some(group))),
            slot: if rider.is_some() {
                Some(self.fire_slot(&entry.id)?)
            } else {
                None
            },
            negates: negated,
            spend_slot,
            consumes: lay.consumes_at.get(step_index).copied().unwrap_or(0),
            hit_consumes: lay.hit_consumes_at.get(step_index).copied().unwrap_or(0),
            wounds: ctx.wounds,
            gate: match entry.attack {
                None => None,
                Some(attack) => self.gate_at(attack)?,
            },
            grants: lay.grants_at.get(step_index).cloned().unwrap_or_default(),
            read_advantage,
            read_disadvantage,
            read_crit_on_hit,
            flag_reads: reads
                .iter()
                .filter_map(|&(flag, modifiers)| {
                    let flag = lay.flags.get(flag)?;
                    Some(FlagRead {
                        bit: flag.bit,
                        modifiers,
                        penalty: flag.penalty.is_some(),
                        source: res.effect_source_of(&flag.condition),
                    })
                })
                .collect(),
            context_pmfs,
            context_roll_types,
            context_vulnerable,
            context_row_contexts,
            context_index_of,
            transformed: substitute.is_some() && !converts,
            converts,
            rerolls,
            policy: if substitute.is_none() || converts {
                None
            } else {
                Some(ctx.policy)
            },
            chance,
        })
    }
}

/// The steps stretch (plan.ts 3957-4700).
fn build_steps(
    res: &Arc<Resolved>,
    lay: &Arc<Layout>,
    folds: &Arc<Folds>,
) -> Result<TurnPlan, DiceError> {
    let mut updates_by_id: HashMap<String, (Vec<usize>, Vec<Option<SaveLanding>>)> = HashMap::new();
    for (group, source_ids) in lay.group_sources.iter().enumerate() {
        let Some(slot) = lay.slot_of_group.get(group).copied().flatten() else {
            continue;
        };
        for source_id in source_ids {
            let existing = updates_by_id.entry(source_id.clone()).or_default();
            existing.0.push(slot);
            let landing = if res.is_save_row(source_id) || res.dealt_sources.contains(source_id) {
                lay.group_landings.get(group).copied().flatten()
            } else {
                None
            };
            existing.1.push(landing);
        }
    }

    let snapshot: Arc<OnceLock<Vec<Step>>> = Arc::new(OnceLock::new());
    let laters: Vec<Arc<LaterLandings>> = (0..res.substitutes.len())
        .map(|substitute| {
            let watched: HashSet<String> = res
                .source_ids_by_node
                .get(res.rider_count + substitute)
                .map(|ids| ids.iter().cloned().collect())
                .unwrap_or_default();
            let mut last_watched = None;
            for (step_index, entry) in lay.sequence.iter().enumerate() {
                if watched.contains(&entry.id) {
                    last_watched = Some(step_index);
                }
            }
            Arc::new(LaterLandings {
                watched,
                last_watched,
                memo: Mutex::new(HashMap::new()),
                steps: Arc::clone(&snapshot),
                eps: res.eps,
                folds: Arc::clone(folds),
            })
        })
        .collect();

    let mut watch_positions: Vec<Vec<usize>> =
        folds.counter_max.iter().map(|_| Vec::new()).collect();
    for (position, entry) in lay.sequence.iter().enumerate() {
        for &counter in folds
            .counters_by_source
            .get(&entry.id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            if let Some(positions) = watch_positions.get_mut(counter) {
                positions.push(position);
            }
        }
    }

    let builder = Builder {
        res,
        lay,
        folds,
        updates_by_id,
        laters,
        watch_positions,
    };
    let mut steps: Vec<Step> = Vec::with_capacity(lay.sequence.len());
    for (step_index, entry) in lay.sequence.iter().enumerate() {
        steps.push(builder.step(step_index, entry)?);
    }
    let light: Vec<Step> = steps
        .iter()
        .map(|step| Step {
            select: inert_select(),
            context_index_of: inert_select(),
            ..step.clone()
        })
        .collect();
    // The set fails only if it was set before: it is set here, once.
    let _ = snapshot.set(light);

    let slot_of_group = |group: usize| lay.slot_of_group.get(group).copied().flatten();
    let mut per_hit_groups: IndexMap<String, usize> = IndexMap::new();
    for (id, &group) in &lay.every_hit_groups {
        // INFALLIBLE: an every-hit group is read at the final collapse, so it has a slot.
        let slot =
            slot_of_group(group).ok_or_else(|| internal("an every-hit group with no slot"))?;
        per_hit_groups.insert(id.clone(), slot);
    }
    let mut rider_rows: IndexMap<String, Vec<String>> = IndexMap::new();
    for (index, id) in res.rider_ids.iter().enumerate() {
        let negates = matches!(
            res.riders.get(index).map(|rider| &rider.trigger),
            Some(Trigger::NotFired { .. })
        );
        let watched: HashSet<&String> = if negates {
            HashSet::new()
        } else {
            res.source_ids_by_node
                .get(index)
                .map(|ids| ids.iter().collect())
                .unwrap_or_default()
        };
        rider_rows.insert(
            id.clone(),
            res.attack_ids
                .iter()
                .filter(|attack_id| watched.contains(attack_id))
                .cloned()
                .collect(),
        );
    }
    let mut probes: IndexMap<String, Option<usize>> = IndexMap::new();
    for (index, id) in res.probe_ids.iter().enumerate() {
        probes.insert(
            id.clone(),
            lay.slot_of(lay.probe_groups.get(index).copied().flatten()),
        );
    }
    let flag_bit = |flag: usize| lay.flags.get(flag).map(|flag| flag.bit);
    let mut coins: Vec<Coin> = Vec::new();
    for (index, flag) in lay.coin_flags.iter().enumerate() {
        let Some(bit) = flag.and_then(flag_bit) else {
            continue;
        };
        if bit != -1 {
            coins.push(Coin {
                id: res.rider_ids.get(index).cloned().unwrap_or_default(),
                bit: bit_mask(bit),
                happens: lay.happens_of.get(index).copied().unwrap_or(1.0),
            });
        }
    }
    let mut start_flags = 0u32;
    let mut start_conditions: Vec<usize> = Vec::new();
    for (index, condition) in lay.condition_flags.iter().enumerate() {
        if !condition.start {
            continue;
        }
        for &flag in &condition.main {
            if let Some(bit) = flag_bit(flag)
                && bit != -1
            {
                start_flags |= bit_mask(bit);
            }
        }
        if condition
            .main
            .iter()
            .any(|&flag| flag_bit(flag).is_some_and(|bit| bit != -1))
        {
            start_conditions.push(index);
        }
    }

    let per_hit_crit_only: IndexSet<String> = res
        .crit_only
        .iter()
        .filter_map(|&index| res.rider_ids.get(index).cloned())
        .collect();
    let per_hit_any: IndexSet<String> = res
        .riders
        .iter()
        .enumerate()
        .filter(|(index, rider)| {
            rider.landing == Some(RiderLanding::Any) && !res.crit_only.contains(index)
        })
        .filter_map(|(index, _)| res.rider_ids.get(index).cloned())
        .collect();
    let mut payload_at = IndexMap::new();
    for (&index, payload) in &res.contextual_payloads {
        if let Some(id) = res.rider_ids.get(index) {
            payload_at.insert(id.clone(), Arc::clone(payload));
        }
    }
    let mut source_of: IndexMap<String, PlanDamage> = IndexMap::new();
    for entry in &lay.sequence {
        source_of.insert(entry.id.clone(), res.damage_of(&entry.id));
    }
    let mut rider_of = IndexMap::new();
    for (index, id) in res.rider_ids.iter().enumerate() {
        if let Some(rider) = res.riders.get(index) {
            rider_of.insert(id.clone(), rider.clone());
        }
    }
    let optional_ids: Vec<String> = res
        .condition_ids
        .iter()
        .zip(&res.conditions)
        .filter(|(_, condition)| condition.optional)
        .map(|(id, _)| id.clone())
        .collect();
    // The engine's fallback for optional conditions past the search (`evaluate.ts`
    // `meleeLeaning`): attempted where the later attack rolls on the creature of its first source
    // are at least as often melee as not.
    let melee_leaning: Vec<bool> = res
        .conditions
        .iter()
        .enumerate()
        .map(|(index, _): (usize, &ConditionSpec)| {
            let Some(first) = lay
                .condition_flags
                .get(index)
                .and_then(|flags| flags.apply_at.first().copied())
            else {
                return false;
            };
            let mut melee = 0usize;
            let mut ranged = 0usize;
            for (position, entry) in lay.sequence.iter().enumerate() {
                if position <= first
                    || entry.attack.is_none()
                    || lay.creature_at.get(position) != lay.creature_at.get(first)
                {
                    continue;
                }
                let facts = lay.row_facts.get(position).and_then(Option::as_ref);
                if facts.is_some_and(|facts| facts.kind != RowKind::Attack) {
                    continue;
                }
                if facts.is_none() && !lay.rolls_attack.get(position).copied().unwrap_or(false) {
                    continue;
                }
                if facts.is_some_and(|facts| facts.range == Some(RowRange::Melee)) {
                    melee += 1;
                } else {
                    ranged += 1;
                }
            }
            melee >= ranged
        })
        .collect();

    Ok(TurnPlan {
        effect_sources: res.effect_sources.clone(),
        optional_ids,
        steps,
        group_count: lay.slot_last_step.len(),
        attack_pmfs: res.attack_pmfs.clone(),
        attack_singles: res.attack_singles.clone(),
        attack_ids: res.attack_ids.clone(),
        rider_ids: res.rider_ids.clone(),
        substitute_ids: res.substitute_ids.clone(),
        probe_ids: res.probe_ids.clone(),
        reroll_ids: res.reroll_ids.clone(),
        fire_slots: lay.fire_slots.clone(),
        slot_count: lay.fire_slots.len(),
        per_hit_groups,
        per_hit_crit_only,
        per_hit_any,
        rider_rows,
        probes,
        every_hit_ids: folds.every_hit_ids.clone(),
        counter_max: folds.counter_max.clone(),
        group_last_read_step: lay.slot_last_step.clone(),
        condition_ids: res.condition_ids.clone(),
        flag_live_after: lay.flag_live_after.clone(),
        coins,
        start_flags,
        start_conditions,
        state_limit: res.state_limit.unwrap_or(MAX_TURN_STATES),
        dealing: res.dealing_type.is_some(),
        melee_leaning,
        source_of,
        rider_of,
        payload_at,
    })
}
