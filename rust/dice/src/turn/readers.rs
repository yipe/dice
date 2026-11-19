//! Port of `src/turn/readers.ts`: the reader walk's ledger and tallies. One walk that carries only
//! mass, plus a plain damage array per capped (`every-hit`) rider, yields every marginal reader: a
//! row's marginal is the mass of each context it rolls in times that context's PMF, a rider that
//! lands once is the mass of each payload it lands with, and a rider that lands again and again is
//! its carried array. No PMF arithmetic runs inside the walk.
//!
//! # Shape
//! - TS object identity is kept where a number depends on it: a [`Carries`] array and each
//!   [`Carry`] are `Arc`s, and `ReaderDamage::add` / `carries_of` take their shortcuts on
//!   `Arc::ptr_eq`, as the TS does on `===`. The `WeakMap` memo caches (`distOfPmf`,
//!   `landingsMade`, `drawBranches`) live in the [`ReaderLedger`] (per walk) or are plain
//!   computation (`branches_of`); a cache hit and a recomputation give the same value, and the
//!   identity the hit hands back is what the per-walk caches reproduce.
//! - The maps keyed by a PMF object (`ownDraws`, `onceWeights`) are keyed by the `Arc`'s address and
//!   keep the `Arc`, so the address cannot be reused while the map lives.
//!
//! # ADR-017 deviations
//! - A capped rider payload whose largest damage exceeds [`MAX_DIST_LEN`] is read as not whole
//!   numbers (`unexact`): TS allocates a `Float64Array` of that many entries (an out-of-memory
//!   abort at the extreme) where Rust reads its marginal the other way, which gives the same
//!   distribution. Covered by `huge_payload_is_unexact`.

use super::context::{
    MOD_ADVANTAGE, MOD_AUTO_FAIL, MOD_CRIT_ON_HIT, MOD_DISADVANTAGE, MOD_SAVE_DISADVANTAGE,
    MOD_VULNERABLE,
};
use super::plan::{Draw, GateReads, Step, TurnPlan};
use super::state::{
    CRIT_BIT, CRIT_MATCH_BIT, FIRST_CRIT, FIRST_HIT, FIRST_NONE, MATCH_BIT, MISS_BIT, StepOutcome,
};
use crate::common::RollType;
use crate::{Bin, Damage, LabelMap, Pmf};
use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// What a later reader needs of a group code (bits of a needs mask).
const NEED_FIRST_MODE: u32 = 1;
const NEED_FIRST: u32 = 2;
const NEED_CRIT: u32 = 4;
const NEED_MISS: u32 = 8;
const NEED_MATCH: u32 = 16;

/// The longest damage array a capped rider's payload may need (ADR-017, see the module doc).
pub const MAX_DIST_LEN: usize = 1 << 24;

/// What a trigger (a step rider's or a condition's) reads of its group code (`TRIGGER_NEEDS[on]`;
/// any other `on` reads nothing).
fn trigger_needs(on: &str) -> u32 {
    match on {
        "first-hit" => NEED_FIRST,
        "first-crit" | "any-crit" => NEED_CRIT,
        "first-miss" | "any-miss" => NEED_MISS,
        "dice-match" => NEED_MATCH,
        _ => 0,
    }
}

/// What a gate reads of its group's code (see `gateOpen`); a gate on a fire slot reads no code.
fn gate_needs(reads: GateReads) -> u32 {
    match reads {
        GateReads::First => NEED_FIRST,
        GateReads::Any => NEED_FIRST | NEED_MISS,
        GateReads::Crit => NEED_CRIT,
        GateReads::Miss => NEED_MISS,
        GateReads::Match => NEED_MATCH,
    }
}

/// Per step, per group slot, what the readers after the step need of its code; `None` where a
/// substitute reads codes to look ahead (it needs them whole). The reader walk keeps only that of
/// each code, so states that differ only in what nothing reads again merge: dead-bit merging, by
/// bit. The full walk keeps codes whole, so its numbers stay bit for bit.
pub fn code_needs(plan: &TurnPlan) -> Option<Vec<Vec<u32>>> {
    if !plan.substitute_ids.is_empty() {
        return None;
    }
    let width = plan.group_count;
    let mut after = vec![0u32; width];
    // At the end: what the firing masses read (see `Turn::tally`).
    for (id, &slot) in &plan.per_hit_groups {
        let need = if plan.per_hit_crit_only.contains(id) {
            NEED_CRIT
        } else if plan.per_hit_any.contains(id) {
            NEED_FIRST | NEED_MISS
        } else {
            NEED_FIRST
        };
        if let Some(cell) = after.get_mut(slot) {
            *cell |= need;
        }
    }
    let mut needs: Vec<Vec<u32>> = vec![Vec::new(); plan.steps.len()];
    for s in (0..plan.steps.len()).rev() {
        needs[s].clone_from(&after);
        let step = &plan.steps[s];
        let mut at = after.clone();
        // A first-hit step rider reads which outcome came first: its mode.
        if let (Some(trigger), Some(reads)) = (&step.trigger, step.reads) {
            let on = trigger.on();
            if let Some(cell) = at.get_mut(reads) {
                *cell |= if on == "first-hit" {
                    NEED_FIRST | NEED_FIRST_MODE
                } else {
                    trigger_needs(on)
                };
            }
        }
        for app in &step.grants {
            if app.rider.is_none()
                && matches!(app.tried, super::plan::Tried::Group)
                && let Some(reads) = app.reads
                && let Some(cell) = at.get_mut(reads)
            {
                *cell |= trigger_needs(app.on.as_str());
            }
        }
        if let Some(super::plan::Gate::Group { slot, reads }) = step.gate
            && let Some(cell) = at.get_mut(slot)
        {
            *cell |= gate_needs(reads);
        }
        after = at;
    }
    Some(needs)
}

/// `codes` with each code cut down to what `needs` says is still read.
pub fn canonical_codes(codes: Vec<u32>, needs: &[u32]) -> Vec<u32> {
    let mut codes = codes;
    for (g, code) in codes.iter_mut().enumerate() {
        let need = needs.get(g).copied().unwrap_or(0);
        let first = (*code >> 2) & 0b11;
        let mut next = 0;
        if need & NEED_FIRST_MODE != 0 {
            next |= first << 2;
        } else if need & NEED_FIRST != 0 && first != FIRST_NONE {
            next |= FIRST_HIT << 2;
        }
        if need & NEED_CRIT != 0 {
            next |= *code & CRIT_BIT;
        }
        if need & NEED_MISS != 0 {
            next |= *code & MISS_BIT;
        }
        if need & NEED_MATCH != 0 {
            next |= *code & (MATCH_BIT | CRIT_MATCH_BIT);
        }
        *code = next;
    }
    codes
}

/// A rider that fires as a step of its own, reading a group slot a row advances.
#[derive(Clone, Debug)]
struct StepRider {
    id: String,
    slot: usize,
    on: &'static str,
}

/// How a step rider lands on a draw: as a hit or as a crit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Landed {
    Hit,
    Crit,
}

/// Where a step rider lands: on the row whose draw first gives its group what its trigger reads
/// (the first landing, the first crit, the first miss, the first match), in that draw's mode.
fn step_landing(on: &str, before: u32, after: u32, outcome: StepOutcome) -> Option<Landed> {
    match on {
        "first-hit" => {
            if (before >> 2) & 0b11 != FIRST_NONE {
                return None;
            }
            let first = (after >> 2) & 0b11;
            if first == FIRST_NONE {
                None
            } else if first == FIRST_CRIT {
                Some(Landed::Crit)
            } else {
                Some(Landed::Hit)
            }
        }
        "any-crit" => {
            if before & CRIT_BIT == 0 && after & CRIT_BIT != 0 {
                Some(Landed::Crit)
            } else {
                None
            }
        }
        "any-miss" | "first-miss" => {
            if before & MISS_BIT == 0 && after & MISS_BIT != 0 {
                Some(Landed::Hit)
            } else {
                None
            }
        }
        "dice-match" => {
            if before & MATCH_BIT != 0 || after & MATCH_BIT == 0 {
                return None;
            }
            if after & CRIT_MATCH_BIT != 0 && outcome == StepOutcome::Crit {
                Some(Landed::Crit)
            } else {
                Some(Landed::Hit)
            }
        }
        _ => None,
    }
}

/// The effects a row can find in force, as the engine names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EffectName {
    Advantage,
    Disadvantage,
    CritOnHit,
    AutoFail,
    SaveDisadvantage,
    SavePenalty,
    Vulnerable,
}

/// `EFFECT_NAMES`, in the engine's order (an effect's index is its bit in a read's effect bits).
pub const EFFECT_NAMES: [EffectName; 7] = [
    EffectName::Advantage,
    EffectName::Disadvantage,
    EffectName::CritOnHit,
    EffectName::AutoFail,
    EffectName::SaveDisadvantage,
    EffectName::SavePenalty,
    EffectName::Vulnerable,
];

impl EffectName {
    /// The TS name.
    pub fn as_str(self) -> &'static str {
        match self {
            EffectName::Advantage => "advantage",
            EffectName::Disadvantage => "disadvantage",
            EffectName::CritOnHit => "critOnHit",
            EffectName::AutoFail => "autoFail",
            EffectName::SaveDisadvantage => "saveDisadvantage",
            EffectName::SavePenalty => "savePenalty",
            EffectName::Vulnerable => "vulnerable",
        }
    }

    /// Its index in [`EFFECT_NAMES`].
    pub fn index(self) -> usize {
        match self {
            EffectName::Advantage => 0,
            EffectName::Disadvantage => 1,
            EffectName::CritOnHit => 2,
            EffectName::AutoFail => 3,
            EffectName::SaveDisadvantage => 4,
            EffectName::SavePenalty => 5,
            EffectName::Vulnerable => 6,
        }
    }

    /// The `MOD_*` bit this effect is (`savePenalty` is a read's penalty dice instead).
    fn modifier(self) -> Option<u32> {
        match self {
            EffectName::Advantage => Some(MOD_ADVANTAGE),
            EffectName::Disadvantage => Some(MOD_DISADVANTAGE),
            EffectName::CritOnHit => Some(MOD_CRIT_ON_HIT),
            EffectName::AutoFail => Some(MOD_AUTO_FAIL),
            EffectName::SaveDisadvantage => Some(MOD_SAVE_DISADVANTAGE),
            EffectName::SavePenalty => None,
            EffectName::Vulnerable => Some(MOD_VULNERABLE),
        }
    }
}

/// A read's effects, as bits over [`EFFECT_NAMES`].
fn effect_bits(read: &super::plan::FlagRead) -> u32 {
    let mut bits = 0;
    for (index, name) in EFFECT_NAMES.iter().enumerate() {
        let lit = match name.modifier() {
            None => read.penalty,
            Some(modifier) => read.modifiers & modifier != 0,
        };
        if lit {
            bits |= 1 << index;
        }
    }
    bits
}

/// P(damage = d) at index d: a capped rider's damage, carried without labels until the end.
pub type Dist = Vec<f64>;

/// What a capped rider has dealt in a state: the chance it has not landed yet, and its damage
/// given it has.
#[derive(Clone, Debug)]
pub struct Carry {
    pub none: f64,
    pub dealt: Option<Arc<Dist>>,
}

/// One [`Carry`] per capped rider; shared by identity between the states that did not change it.
pub type Carries = Arc<Vec<Arc<Carry>>>;

/// The reader walk's damage: the mass of the paths a state stands for, and one carry per capped
/// rider. States that merge keep their parts until a carry is read, then mix them all at once.
#[derive(Clone, Debug, Default)]
pub struct ReaderDamage {
    pub mass: f64,
    pub carries: Option<Carries>,
    /// The merged states not mixed yet; only a merge creates it, and only that merge's state
    /// holds it.
    pub parts: Option<Vec<ReaderDamage>>,
}

fn add_into(into: &mut [f64], dist: &[f64], weight: f64) {
    for (cell, value) in into.iter_mut().zip(dist) {
        *cell += value * weight;
    }
}

/// `damage`'s carries, its parts mixed by mass where it has them.
pub fn carries_of(damage: &mut ReaderDamage) -> Carries {
    if let Some(carries) = &damage.carries {
        return carries.clone();
    }
    let parts = damage.parts.take().unwrap_or_default();
    // INFALLIBLE: a part is a state with carries (a merge flattens parts; only the walk's own
    // states are parts), so a missing one is an empty list.
    let first: Carries = parts
        .first()
        .and_then(|part| part.carries.clone())
        .unwrap_or_default();
    let same = parts.iter().all(|part| {
        part.carries
            .as_ref()
            .is_some_and(|carries| Arc::ptr_eq(carries, &first))
    });
    let mixed: Carries = if same {
        first
    } else {
        let mut out: Vec<Arc<Carry>> = Vec::with_capacity(first.len());
        for (c, first_carry) in first.iter().enumerate() {
            let mut total = 0.0;
            let mut none = 0.0;
            let mut landed = 0.0;
            let mut length = 0;
            for part in &parts {
                let Some(held) = part.carries.as_ref().and_then(|carries| carries.get(c)) else {
                    continue;
                };
                total += part.mass;
                none += part.mass * held.none;
                if let Some(dealt) = &held.dealt
                    && held.none < 1.0
                {
                    landed += part.mass * (1.0 - held.none);
                    length = length.max(dealt.len());
                }
            }
            // `!(total > 0)`: also true for NaN.
            if total.is_nan() || total <= 0.0 {
                out.push(first_carry.clone());
                continue;
            }
            if landed.is_nan() || landed <= 0.0 {
                out.push(Arc::new(Carry {
                    none: none / total,
                    dealt: None,
                }));
                continue;
            }
            let mut dealt = vec![0.0; length];
            for part in &parts {
                let Some(held) = part.carries.as_ref().and_then(|carries| carries.get(c)) else {
                    continue;
                };
                if let Some(held_dealt) = &held.dealt
                    && held.none < 1.0
                {
                    add_into(
                        &mut dealt,
                        held_dealt,
                        (part.mass * (1.0 - held.none)) / landed,
                    );
                }
            }
            out.push(Arc::new(Carry {
                none: none / total,
                dealt: Some(Arc::new(dealt)),
            }));
        }
        Arc::new(out)
    };
    damage.carries = Some(mixed.clone());
    mixed
}

/// The ledger of the reader walk. `capped` lists the riders carried as arrays (the `every-hit`
/// ones); one whose payload is not whole numbers lands in `unexact`, and its marginal is read
/// another way.
pub struct ReaderLedger {
    index_of: HashMap<String, usize>,
    /// The riders whose payload was not whole numbers of 0 or more.
    pub unexact: IndexSet<String>,
    none: Arc<Carry>,
    width: usize,
    /// `distOfPmf`: a payload as an array, by the payload's identity (the `Arc` is kept so its
    /// address stays unique).
    dists: HashMap<usize, DistEntry>,
    /// `landingsMade`: the carry a carry lands a payload as, by identity of both.
    landings: HashMap<(usize, usize), LandingEntry>,
}

/// A payload and its array (`None` where it is not whole numbers of 0 or more).
type DistEntry = (Arc<Pmf>, Option<Arc<Dist>>);

/// A carry, the payload it landed, and the carry that gave.
type LandingEntry = (Arc<Carry>, Arc<Dist>, Arc<Carry>);

fn addr<T: ?Sized>(arc: &Arc<T>) -> usize {
    Arc::as_ptr(arc) as *const () as usize
}

impl ReaderLedger {
    pub fn new(capped: &[String]) -> ReaderLedger {
        let mut index_of = HashMap::new();
        for (index, id) in capped.iter().enumerate() {
            // `new Map(entries)`: a repeated id keeps its last index.
            index_of.insert(id.clone(), index);
        }
        ReaderLedger {
            index_of,
            unexact: IndexSet::new(),
            none: Arc::new(Carry {
                none: 1.0,
                dealt: None,
            }),
            width: capped.len(),
            dists: HashMap::new(),
            landings: HashMap::new(),
        }
    }

    /// `start`.
    pub fn start(&self) -> ReaderDamage {
        ReaderDamage {
            mass: 1.0,
            carries: Some(Arc::new(vec![self.none.clone(); self.width])),
            parts: None,
        }
    }

    pub fn mass(&self, damage: &ReaderDamage) -> f64 {
        damage.mass
    }

    pub fn add(&self, a: ReaderDamage, b: ReaderDamage) -> ReaderDamage {
        let mut a = a;
        let mut b = b;
        if let (Some(ac), Some(bc)) = (&a.carries, &b.carries)
            && Arc::ptr_eq(ac, bc)
        {
            return ReaderDamage {
                mass: a.mass + b.mass,
                carries: a.carries,
                parts: None,
            };
        }
        let b_mass = b.mass;
        let tail = match b.parts.take() {
            Some(parts) => parts,
            None => vec![b],
        };
        if let Some(parts) = a.parts.as_mut() {
            parts.extend(tail);
            a.mass += b_mass;
            return a;
        }
        let mass = a.mass + b_mass;
        let mut parts = Vec::with_capacity(1 + tail.len());
        parts.push(a);
        parts.extend(tail);
        ReaderDamage {
            mass,
            carries: None,
            parts: Some(parts),
        }
    }

    pub fn scale(&self, damage: &mut ReaderDamage, factor: f64) -> ReaderDamage {
        let mass = damage.mass * factor;
        ReaderDamage {
            mass,
            carries: Some(carries_of(damage)),
            parts: None,
        }
    }

    /// A payload's damage as an array, or `None` where it is not whole numbers of 0 or more.
    fn dist_of(&mut self, pmf: &Arc<Pmf>) -> Option<Arc<Dist>> {
        if let Some((_, known)) = self.dists.get(&addr(pmf)) {
            return known.clone();
        }
        let mut dist: Option<Dist> = None;
        let mut max = 0.0f64;
        let mut whole = true;
        for damage in pmf.map.keys() {
            if damage.0.is_nan()
                || damage.0.fract() != 0.0
                || damage.0.is_infinite()
                || damage.0 < 0.0
            {
                whole = false;
                break;
            }
            max = max.max(damage.0);
        }
        if whole && max < MAX_DIST_LEN as f64 {
            let mut out = vec![0.0; max as usize + 1];
            for (damage, bin) in &pmf.map {
                out[damage.0 as usize] += bin.p;
            }
            dist = Some(out);
        }
        let dist = dist.map(Arc::new);
        self.dists.insert(addr(pmf), (pmf.clone(), dist.clone()));
        dist
    }

    /// A capped rider lands `pay`: where it had not landed that is its damage, else `pay` adds to
    /// it.
    fn land_on(&mut self, held: &Arc<Carry>, pay: &Arc<Dist>) -> Arc<Carry> {
        let key = (addr(held), addr(pay));
        if let Some((_, _, known)) = self.landings.get(&key) {
            return known.clone();
        }
        let held_len = held.dealt.as_ref().map_or(1, |dealt| dealt.len());
        let mut out = vec![0.0; held_len + pay.len() - 1];
        if held.none > 0.0 {
            add_into(&mut out, pay, held.none);
        }
        if let Some(dealt) = &held.dealt
            && held.none < 1.0
        {
            let weight = 1.0 - held.none;
            for (a, &d) in dealt.iter().enumerate() {
                let pa = d * weight;
                if pa == 0.0 {
                    continue;
                }
                for (b, &p) in pay.iter().enumerate() {
                    out[a + b] += pa * p;
                }
            }
        }
        let next = Arc::new(Carry {
            none: 0.0,
            dealt: Some(Arc::new(out)),
        });
        self.landings
            .insert(key, (held.clone(), pay.clone(), next.clone()));
        next
    }

    /// `damage` with a draw's sub-mass `slice` folded in; a draw's folded riders that are capped
    /// land their payloads on the carries.
    pub fn convolve(
        &mut self,
        damage: &mut ReaderDamage,
        slice: &Pmf,
        draw: Option<&Draw>,
    ) -> ReaderDamage {
        let mass = damage.mass * slice.mass();
        let held = carries_of(damage);
        let mut carries = held.clone();
        let mut copied = false;
        if let Some(riders) = draw.and_then(|draw| draw.riders.as_ref()) {
            for (id, payload) in riders.iter() {
                let Some(&c) = self.index_of.get(id) else {
                    continue;
                };
                let Some(pay) = self.dist_of(payload) else {
                    self.unexact.insert(id.clone());
                    continue;
                };
                if !copied {
                    carries = Arc::new((*held).clone());
                    copied = true;
                }
                let Some(current) = carries.get(c).cloned() else {
                    continue;
                };
                let landed = self.land_on(&current, &pay);
                if let Some(cell) = Arc::make_mut(&mut carries).get_mut(c) {
                    *cell = landed;
                }
            }
        }
        ReaderDamage {
            mass,
            carries: Some(carries),
            parts: None,
        }
    }
}

/// A capped rider's damage over the terminal states, labelled once: landed damage is `hit`, none
/// `missNone`. `states` have their carries resolved (see `carries_of`).
pub fn capped_pmf(states: &[ReaderDamage], c: usize, total: f64) -> Pmf {
    let mut length = 1;
    let mut held: Vec<(Arc<Carry>, f64)> = Vec::new();
    for damage in states {
        let mass = damage.mass;
        let Some(carry) = damage.carries.as_ref().and_then(|carries| carries.get(c)) else {
            continue;
        };
        let Some(dealt) = &carry.dealt else { continue };
        if carry.none >= 1.0 {
            continue;
        }
        length = length.max(dealt.len());
        held.push((carry.clone(), mass));
    }
    let mut dealt = vec![0.0; length];
    let mut landed = 0.0;
    for (carry, mass) in &held {
        let weight = (mass * (1.0 - carry.none)) / total;
        if let Some(carry_dealt) = &carry.dealt {
            add_into(&mut dealt, carry_dealt, weight);
        }
        landed += weight;
    }
    let mut bins: IndexMap<Damage, Bin> = IndexMap::new();
    for (damage, &p) in dealt.iter().enumerate() {
        if p > 0.0 {
            let mut count = LabelMap::new();
            count.insert("hit".to_string(), p);
            bins.insert(
                Damage(damage as f64),
                Bin {
                    p,
                    count,
                    attr: None,
                },
            );
        }
    }
    // `Math.max(0, 1 - landed)`: NaN stays NaN.
    let missing = if (1.0 - landed).is_nan() {
        f64::NAN
    } else {
        (1.0 - landed).max(0.0)
    };
    if missing > 0.0 {
        let zero = Damage(0.0);
        let bin = match bins.get(&zero) {
            None => {
                let mut count = LabelMap::new();
                count.insert("missNone".to_string(), missing);
                Bin {
                    p: missing,
                    count,
                    attr: None,
                }
            }
            Some(known) => {
                let mut count = known.count.clone();
                count.insert("missNone".to_string(), missing);
                Bin {
                    p: known.p + missing,
                    count,
                    attr: None,
                }
            }
        };
        bins.insert(zero, bin);
    }
    Pmf::new(bins, crate::EPS, false).with_attribution()
}

/// Where a rider landed on one row: by outcome, and the part of those where the target was
/// vulnerable.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RowLanding {
    pub hit: f64,
    pub crit: f64,
    pub doubled: DoubledLanding,
}

/// The part of a [`RowLanding`] where the target was vulnerable.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DoubledLanding {
    pub hit: f64,
    pub crit: f64,
}

/// One way a row's landing went: its outcome, whether it dealt damage, the riders that landed
/// with it.
#[derive(Clone, Debug, PartialEq)]
pub struct LandingPattern {
    pub label: String,
    pub dealt: bool,
    pub riders: Vec<String>,
    pub mass: f64,
}

/// The outcome labels that are a landing; any other outcome is the row's rest (`miss`, or
/// `savePass`).
fn is_landing_label(label: &str) -> bool {
    matches!(label, "hit" | "crit" | "saveFail" | "saveHalf")
}

/// The labels that make a row a save.
const SAVE_LABELS: [&str; 3] = ["saveFail", "saveHalf", "savePass"];

/// One branch of a draw, as the engine names a row's branches, and its share of the draw.
#[derive(Clone, Debug)]
struct DrawBranch {
    label: String,
    dealt: bool,
    share: f64,
}

/// A draw's branches, read off the outcome labels of the row's own damage in it, as the engine's
/// `compileBranches` reads a row: a landing label (hit, crit, saveFail, saveHalf) split by whether
/// it dealt more than 0; everything else is the rest, `savePass` on a save and `miss` otherwise,
/// which deals nothing as a landing. A PMF without labels is the draw's own outcome.
fn branches_of(draw: &Draw, is_save: bool) -> Vec<DrawBranch> {
    let own = draw.own.as_ref().unwrap_or(&draw.slice);
    let rest = if is_save { "savePass" } else { "miss" };
    let mut by_key: IndexMap<(String, bool), DrawBranch> = IndexMap::new();
    let mut total = 0.0;
    let mut add = |label: &str, dealt: bool, mass: f64| {
        // `!(mass > 0)`: also true for NaN.
        if mass.is_nan() || mass <= 0.0 {
            return;
        }
        total += mass;
        match by_key.get_mut(&(label.to_string(), dealt)) {
            None => {
                by_key.insert(
                    (label.to_string(), dealt),
                    DrawBranch {
                        label: label.to_string(),
                        dealt,
                        share: mass,
                    },
                );
            }
            Some(known) => known.share += mass,
        }
    };
    for (damage, bin) in &own.map {
        if bin.count.is_empty() {
            let label = match draw.outcome {
                StepOutcome::Hit => "hit",
                StepOutcome::Crit => "crit",
                _ => rest,
            };
            add(label, is_landing_label(label) && damage.0 > 0.0, bin.p);
            continue;
        }
        for (label, &mass) in &bin.count {
            if is_landing_label(label) {
                add(label, damage.0 > 0.0, mass);
            } else {
                add(rest, false, mass);
            }
        }
    }
    by_key
        .into_values()
        .map(|branch| DrawBranch {
            share: branch.share / total,
            ..branch
        })
        .collect()
}

/// Per roll type, in TS key order (`flat`, `advantage`, `disadvantage`, `elven accuracy`).
pub const ROLL_TYPES: [RollType; 4] = [
    RollType::Flat,
    RollType::Advantage,
    RollType::Disadvantage,
    RollType::ElvenAccuracy,
];

/// A [`RollType`]'s index in [`ROLL_TYPES`].
pub fn roll_type_index(roll_type: RollType) -> usize {
    match roll_type {
        RollType::Flat => 0,
        RollType::Advantage => 1,
        RollType::Disadvantage => 2,
        RollType::ElvenAccuracy => 3,
    }
}

/// A condition's tries at a row, in the walk's mass units.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Attempt {
    pub attempted: f64,
    pub taken: f64,
}

/// Everything the reader walk tallies, in the walk's unnormalized mass units: per step, the d20 it
/// rolls, the effects in force and where they come from, the mass of each context it rolls in and
/// of its draws that happen, each condition's attempts; per rider, the rows it lands on and the
/// payloads a rider that lands once lands with; per row, its landing patterns.
pub struct ReaderTally {
    pub roll_types: Vec<[f64; 4]>,
    pub effects: Vec<[f64; 7]>,
    /// Per step, by source (an index into `TurnPlan::effect_sources`; `usize::MAX` for a read
    /// with no source).
    pub effect_sources: Vec<IndexMap<usize, [f64; 7]>>,
    pub context_mass: Vec<Vec<f64>>,
    pub happened: Vec<f64>,
    /// Per step whose miss may convert (`Step.converts`), or that a reroll watches, the row's own
    /// damage of each draw that happens, by its part (`Draw.own`, else its slice), with the mass
    /// that drew it: the row's marginal, which its context PMFs are not.
    pub own_draws: Vec<IndexMap<usize, (Arc<Pmf>, f64)>>,
    pub attempts: Vec<IndexMap<usize, Attempt>>,
    pub landings: IndexMap<String, IndexMap<String, RowLanding>>,
    pub once_weights: IndexMap<String, IndexMap<usize, (Arc<Pmf>, f64)>>,
    pub patterns: IndexMap<String, IndexMap<String, LandingPattern>>,
    read_bits: Vec<Vec<u32>>,
    /// Per step, whether the row is a save (its rest is `savePass`, not `miss`); read for
    /// patterns only.
    is_save: Vec<bool>,
    /// Per row, the step riders that read a slot it advances, with the slot.
    step_riders: Vec<Vec<StepRider>>,
    /// The riders carried as arrays: they land again and again, so their payloads are not tallied.
    capped: HashSet<String>,
    /// The riders that land on anything (`landing: "any"`): each landing is booked as a hit.
    cast: IndexSet<String>,
    /// With landing patterns too (they cost a little on every landing): the riders' declaration
    /// order.
    rider_order: Option<IndexMap<String, usize>>,
}

impl ReaderTally {
    pub fn new(
        steps: &[Step],
        capped: HashSet<String>,
        cast: IndexSet<String>,
        rider_order: Option<IndexMap<String, usize>>,
    ) -> ReaderTally {
        let is_save = steps
            .iter()
            .map(|step| {
                if rider_order.is_none() {
                    return false;
                }
                let labels = step
                    .context_pmfs
                    .get(0)
                    .map(|pmf| pmf.outcomes())
                    .unwrap_or_default();
                SAVE_LABELS
                    .iter()
                    .any(|label| labels.iter().any(|l| l == label))
            })
            .collect();
        // A slot a row advances is read by the later step riders of the same group: up to the
        // step that releases it.
        let step_riders = steps
            .iter()
            .enumerate()
            .map(|(x, step)| {
                let mut readers = Vec::new();
                for &slot in &step.updates {
                    for rider in &steps[x + 1..] {
                        if rider.variants.is_empty()
                            && rider.reads == Some(slot)
                            && let Some(trigger) = &rider.trigger
                        {
                            readers.push(StepRider {
                                id: rider.id.clone(),
                                slot,
                                on: trigger.on(),
                            });
                        }
                        if rider.releases.contains(&slot) {
                            break;
                        }
                    }
                }
                readers
            })
            .collect();
        ReaderTally {
            roll_types: steps.iter().map(|_| [0.0; 4]).collect(),
            effects: steps.iter().map(|_| [0.0; 7]).collect(),
            effect_sources: steps.iter().map(|_| IndexMap::new()).collect(),
            // A context's PMF is there once a state rolled in it (see `Step::context_pmfs`): size
            // by the count.
            context_mass: steps
                .iter()
                .map(|step| vec![0.0; step.context_pmfs.len()])
                .collect(),
            happened: steps.iter().map(|_| 0.0).collect(),
            own_draws: steps.iter().map(|_| IndexMap::new()).collect(),
            attempts: steps.iter().map(|_| IndexMap::new()).collect(),
            landings: IndexMap::new(),
            once_weights: IndexMap::new(),
            patterns: IndexMap::new(),
            read_bits: steps
                .iter()
                .map(|step| step.flag_reads.iter().map(effect_bits).collect())
                .collect(),
            is_save,
            step_riders,
            capped,
            cast,
            rider_order,
        }
    }

    /// A state reaches row `s`, in context `context`: the d20 it rolls there and the effects in
    /// force.
    pub fn reach(&mut self, step: &Step, s: usize, context: usize, flags: u32, mass: f64) {
        if !step.context_roll_types.is_empty()
            && let Some(roll_type) = step.context_roll_types.get(context)
        {
            self.roll_types[s][roll_type_index(*roll_type)] += mass;
        }
        if step.flag_reads.is_empty() {
            return;
        }
        let reads = &step.flag_reads;
        let read_bits = &self.read_bits[s];
        let lit = |bit: i32| flags & (1u32 << (bit as u32 & 31)) != 0;
        let mut any = 0;
        for (r, read) in reads.iter().enumerate() {
            if lit(read.bit) {
                any |= read_bits[r];
            }
        }
        if any == 0 {
            return;
        }
        for e in 0..EFFECT_NAMES.len() {
            if any & (1 << e) != 0 {
                self.effects[s][e] += mass;
            }
        }
        // A source's effects count once however many of its flags this row reads.
        for (r, read) in reads.iter().enumerate() {
            if !lit(read.bit) {
                continue;
            }
            let mut bits = read_bits[r];
            for q in 0..r {
                if reads[q].source == read.source && lit(reads[q].bit) {
                    bits &= !read_bits[q];
                }
            }
            if bits == 0 {
                continue;
            }
            let row = self.effect_sources[s]
                .entry(read.source.unwrap_or(usize::MAX))
                .or_insert([0.0; 7]);
            for (e, cell) in row.iter_mut().enumerate() {
                if bits & (1 << e) != 0 {
                    *cell += mass;
                }
            }
        }
    }

    /// A state rolls row `s` in context `context`.
    pub fn roll(&mut self, s: usize, context: usize, mass: f64) {
        if !self.context_mass[s].is_empty()
            && let Some(cell) = self.context_mass[s].get_mut(context)
        {
            *cell += mass;
        }
    }

    /// A pure-damage step fires: its payload, for a rider that lands once.
    pub fn fire(&mut self, step: &Step, payload: &Arc<Pmf>, mass: f64) {
        self.weigh(&step.id, payload, mass);
    }

    /// A draw of row `s` in context `context`, at `mass`, taking the group codes from `codes.0` to
    /// `codes.1`: the riders folded into it land here, and so do the step riders whose trigger it
    /// meets first.
    pub fn draw(
        &mut self,
        step: &Step,
        s: usize,
        draw: &Draw,
        mass: f64,
        context: usize,
        codes: (&[u32], &[u32]),
    ) {
        let (before, after) = codes;
        if draw.outcome == StepOutcome::None {
            return;
        }
        self.happened[s] += mass;
        if step.converts || !step.rerolls.is_empty() {
            let own = draw.own.as_ref().unwrap_or(&draw.slice);
            let entry = self.own_draws[s]
                .entry(addr(own))
                .or_insert_with(|| (own.clone(), 0.0));
            entry.1 += mass;
        }
        let folded: &[(String, Arc<Pmf>)] = draw.riders.as_ref().map_or(&[], |riders| &riders[..]);
        let mut stepped: Vec<(String, Landed)> = Vec::new();
        for rider in &self.step_riders[s] {
            let (Some(&b), Some(&a)) = (before.get(rider.slot), after.get(rider.slot)) else {
                continue;
            };
            if let Some(mode) = step_landing(rider.on, b, a, draw.outcome) {
                stepped.push((rider.id.clone(), mode));
            }
        }
        if folded.is_empty() && stepped.is_empty() {
            return;
        }
        let vulnerable = step.context_vulnerable.get(context) == Some(&true);
        let crit = draw.outcome == StepOutcome::Crit;
        let not_miss = draw.outcome != StepOutcome::Miss;
        for (id, payload) in folded {
            // A rider that lands on anything is no part of the attack's damage: every landing is a
            // hit, never doubled (the engine's `cast` rider).
            let cast = self.cast.contains(id);
            self.land(
                id,
                &step.id,
                crit && !cast,
                vulnerable && not_miss && !cast,
                mass,
            );
            if !self.capped.contains(id) {
                self.weigh(id, payload, mass);
            }
        }
        for (id, mode) in &stepped {
            let cast = self.cast.contains(id);
            self.land(
                id,
                &step.id,
                *mode == Landed::Crit && !cast,
                vulnerable && not_miss && !cast,
                mass,
            );
        }
        let Some(order) = &self.rider_order else {
            return;
        };
        // The riders that land together, in declaration order (the engine's rider order).
        let mut ids: Vec<String> = folded
            .iter()
            .map(|(id, _)| id.clone())
            .chain(stepped.iter().map(|(id, _)| id.clone()))
            .collect();
        let rank = |id: &String| order.get(id).map_or(f64::NAN, |&index| index as f64);
        // A stable sort; a NaN difference (an id with no order) compares equal, as in JS.
        ids.sort_by(|a, b| {
            (rank(a) - rank(b))
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let joined = ids.join("\u{0}");
        let is_save = self.is_save[s];
        let patterns = self.patterns.entry(step.id.clone()).or_default();
        for DrawBranch {
            label,
            dealt,
            share,
        } in branches_of(draw, is_save)
        {
            let key = format!("{label}|{dealt}|{joined}");
            match patterns.get_mut(&key) {
                None => {
                    patterns.insert(
                        key,
                        LandingPattern {
                            label,
                            dealt,
                            riders: ids.clone(),
                            mass: mass * share,
                        },
                    );
                }
                Some(pattern) => pattern.mass += mass * share,
            }
        }
    }

    /// Condition `c` is tried at row `s` on `mass`, and takes on `chance` of it.
    pub fn attempt(&mut self, s: usize, c: usize, mass: f64, chance: f64) {
        match self.attempts[s].get_mut(&c) {
            None => {
                self.attempts[s].insert(
                    c,
                    Attempt {
                        attempted: mass,
                        taken: mass * chance,
                    },
                );
            }
            Some(tally) => {
                tally.attempted += mass;
                tally.taken += mass * chance;
            }
        }
    }

    fn land(&mut self, id: &str, row: &str, crit: bool, doubled: bool, mass: f64) {
        let landing = self
            .landings
            .entry(id.to_string())
            .or_default()
            .entry(row.to_string())
            .or_default();
        if crit {
            landing.crit += mass;
        } else {
            landing.hit += mass;
        }
        if doubled {
            if crit {
                landing.doubled.crit += mass;
            } else {
                landing.doubled.hit += mass;
            }
        }
    }

    fn weigh(&mut self, id: &str, payload: &Arc<Pmf>, mass: f64) {
        let weights = self.once_weights.entry(id.to_string()).or_default();
        let entry = weights
            .entry(addr(payload))
            .or_insert_with(|| (payload.clone(), 0.0));
        entry.1 += mass;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pmf_of(pairs: &[(f64, f64)]) -> Arc<Pmf> {
        let mut map = IndexMap::new();
        for &(damage, p) in pairs {
            map.insert(
                Damage(damage),
                Bin {
                    p,
                    count: LabelMap::new(),
                    attr: None,
                },
            );
        }
        Arc::new(Pmf::new(map, crate::EPS, false))
    }

    fn draw_with(rider: &str, payload: Arc<Pmf>) -> Draw {
        let mut draw = Draw::plain(StepOutcome::Hit, false, false, pmf_of(&[(3.0, 1.0)]));
        draw.riders = Some(Arc::new(vec![(rider.to_string(), payload)]));
        draw
    }

    #[test]
    fn canonical_codes_cut_to_needs() {
        // A first-hit-by-crit code that only a first-hit reader needs becomes a plain first hit.
        let code = (FIRST_CRIT << 2) | CRIT_BIT | MISS_BIT;
        assert_eq!(
            canonical_codes(vec![code], &[NEED_FIRST]),
            vec![FIRST_HIT << 2]
        );
        assert_eq!(
            canonical_codes(vec![code], &[NEED_FIRST | NEED_FIRST_MODE]),
            vec![FIRST_CRIT << 2]
        );
        assert_eq!(
            canonical_codes(vec![code], &[NEED_CRIT | NEED_MISS]),
            vec![CRIT_BIT | MISS_BIT]
        );
        assert_eq!(canonical_codes(vec![code], &[0]), vec![0]);
        assert_eq!(canonical_codes(vec![0], &[NEED_FIRST]), vec![0]);
    }

    #[test]
    fn landing_stacks_payloads() {
        let mut ledger = ReaderLedger::new(&["rider".to_string()]);
        let mut start = ledger.start();
        let draw = draw_with("rider", pmf_of(&[(1.0, 0.5), (2.0, 0.5)]));
        let slice = pmf_of(&[(3.0, 1.0)]);
        let mut once = ledger.convolve(&mut start, &slice, Some(&draw));
        let mut twice = ledger.convolve(&mut once, &slice, Some(&draw));
        let carries = carries_of(&mut twice);
        let dealt = carries[0].dealt.as_ref().expect("landed");
        assert_eq!(carries[0].none, 0.0);
        assert_eq!(**dealt, vec![0.0, 0.0, 0.25, 0.5, 0.25]);
        assert!(ledger.unexact.is_empty());
    }

    #[test]
    fn merging_states_with_one_carry_array_keeps_it() {
        let ledger = ReaderLedger::new(&["rider".to_string()]);
        let a = ledger.start();
        let carries = a.carries.clone();
        let merged = ledger.add(
            a,
            ReaderDamage {
                mass: 0.5,
                carries: carries.clone(),
                parts: None,
            },
        );
        assert_eq!(merged.mass, 1.5);
        assert!(merged.parts.is_none());
        assert!(Arc::ptr_eq(
            merged.carries.as_ref().expect("carries"),
            carries.as_ref().expect("carries")
        ));
    }

    #[test]
    fn merged_parts_mix_by_mass() {
        let mut ledger = ReaderLedger::new(&["rider".to_string()]);
        let slice = pmf_of(&[(0.0, 1.0)]);
        let draw = draw_with("rider", pmf_of(&[(2.0, 1.0)]));
        let mut landed = ledger.convolve(&mut ledger.start(), &slice, Some(&draw));
        landed.mass = 0.25;
        let mut idle = ledger.start();
        idle.mass = 0.75;
        let mut merged = ledger.add(landed, idle);
        assert!(merged.carries.is_none());
        let carries = carries_of(&mut merged);
        assert_eq!(carries[0].none, 0.75);
        assert_eq!(
            **carries[0].dealt.as_ref().expect("landed"),
            vec![0.0, 0.0, 1.0]
        );
        // Mixed once: parts are gone, a second read is the same array.
        assert!(merged.parts.is_none());
        assert!(Arc::ptr_eq(&carries, &carries_of(&mut merged)));
    }

    #[test]
    fn capped_pmf_labels_landed_and_none() {
        let mut ledger = ReaderLedger::new(&["rider".to_string()]);
        let slice = pmf_of(&[(0.0, 1.0)]);
        let draw = draw_with("rider", pmf_of(&[(2.0, 1.0)]));
        let mut landed = ledger.convolve(&mut ledger.start(), &slice, Some(&draw));
        landed.mass = 0.5;
        let mut idle = ledger.start();
        idle.mass = 0.5;
        let states = vec![landed, idle];
        let pmf = capped_pmf(&states, 0, 1.0);
        assert_eq!(pmf.p_at(2.0), 0.5);
        assert_eq!(pmf.p_at(0.0), 0.5);
        assert_eq!(pmf.map[&Damage(0.0)].count["missNone"], 0.5);
        assert_eq!(pmf.map[&Damage(2.0)].count["hit"], 0.5);
    }

    #[test]
    fn non_integer_payload_is_unexact() {
        let mut ledger = ReaderLedger::new(&["rider".to_string()]);
        let slice = pmf_of(&[(0.0, 1.0)]);
        let draw = draw_with("rider", pmf_of(&[(2.5, 1.0)]));
        let mut out = ledger.convolve(&mut ledger.start(), &slice, Some(&draw));
        assert!(ledger.unexact.contains("rider"));
        assert!(carries_of(&mut out)[0].dealt.is_none());
        // Negative damage too.
        let mut ledger = ReaderLedger::new(&["rider".to_string()]);
        let draw = draw_with("rider", pmf_of(&[(-1.0, 1.0)]));
        ledger.convolve(&mut ledger.start(), &slice, Some(&draw));
        assert!(ledger.unexact.contains("rider"));
    }

    #[test]
    fn huge_payload_is_unexact() {
        let mut ledger = ReaderLedger::new(&["rider".to_string()]);
        let slice = pmf_of(&[(0.0, 1.0)]);
        let draw = draw_with("rider", pmf_of(&[(1e12, 1.0)]));
        ledger.convolve(&mut ledger.start(), &slice, Some(&draw));
        assert!(ledger.unexact.contains("rider"));
    }

    #[test]
    fn step_landing_reads_the_trigger() {
        let miss = MISS_BIT;
        assert_eq!(
            step_landing("first-hit", 0, FIRST_HIT << 2, StepOutcome::Hit),
            Some(Landed::Hit)
        );
        assert_eq!(
            step_landing(
                "first-hit",
                0,
                (FIRST_CRIT << 2) | CRIT_BIT,
                StepOutcome::Crit
            ),
            Some(Landed::Crit)
        );
        assert_eq!(
            step_landing(
                "first-hit",
                FIRST_HIT << 2,
                FIRST_HIT << 2,
                StepOutcome::Hit
            ),
            None
        );
        assert_eq!(
            step_landing("any-miss", 0, miss, StepOutcome::Miss),
            Some(Landed::Hit)
        );
        assert_eq!(
            step_landing("any-miss", miss, miss, StepOutcome::Miss),
            None
        );
        assert_eq!(
            step_landing(
                "dice-match",
                0,
                MATCH_BIT | CRIT_MATCH_BIT,
                StepOutcome::Crit
            ),
            Some(Landed::Crit)
        );
        assert_eq!(
            step_landing("dice-match", 0, MATCH_BIT, StepOutcome::Hit),
            Some(Landed::Hit)
        );
        assert_eq!(step_landing("every-hit", 0, 0, StepOutcome::Hit), None);
    }

    #[test]
    fn branches_split_by_dealt() {
        let mut draw = Draw::plain(
            StepOutcome::Hit,
            false,
            false,
            pmf_of(&[(0.0, 0.25), (4.0, 0.75)]),
        );
        draw.own = None;
        let branches = branches_of(&draw, false);
        assert_eq!(branches.len(), 2);
        assert_eq!(
            (
                branches[0].label.as_str(),
                branches[0].dealt,
                branches[0].share
            ),
            ("hit", false, 0.25)
        );
        assert_eq!(
            (
                branches[1].label.as_str(),
                branches[1].dealt,
                branches[1].share
            ),
            ("hit", true, 0.75)
        );
        let miss = Draw::plain(StepOutcome::Miss, false, false, pmf_of(&[(0.0, 1.0)]));
        assert_eq!(branches_of(&miss, true)[0].label, "savePass");
        assert_eq!(branches_of(&miss, false)[0].label, "miss");
    }
}
