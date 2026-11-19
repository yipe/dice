//! `buildPlan` 3184-3955 (src/turn/plan.ts), plus `withFolded` and `saveRowDraws` (4000-4075): the
//! per-hit fold of `every-hit` and per-source `first-hit` riders into their sources' slices, and
//! every draw a step can make. Output: [`Folds`].
//!
//! The TS memo tables `foldsMade`, `rerolledPmfs` and `missRerolledPmfs` only avoid recomputation
//! and are skipped. `typedPayloads` is kept (draws merge by the identity of the payloads it
//! returns) and so is `basePayloads`.

use super::layout::Layout;
use super::resolve::Resolved;
use super::source::{
    BasePayload, SaveClasses, SourceSlices, attack_part_count, base_payload_of, class_lands,
    class_outcomes, crit_pmf, keep_better_of_fresh, mix_one, pmf_under, rerolled_pmf_under,
    rider_damage_pmf, slice_source,
};
use super::{
    Draw, Fire, FireMode, FoldMode, MAX_VARIANT_BITS, PlanDamage, Riders, dealt_by_kind, fail,
    not_dealt_by_kind, scale_draw,
};
use crate::builder::types::MissRerollMode;
use crate::error::DiceError;
use crate::turn::context::{ContextualSource, RollUnder, RowContext, context_of};
use crate::turn::state::StepOutcome;
use crate::turn::types::{
    ContextualPayload, DamageSource, MAX_CAPPED_COUNTERS, RiderLanding, SaveLanding, Source,
    SubstitutePolicy, TurnSpecErrorCode,
};
use crate::{Damage, Pmf};
use indexmap::IndexMap;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// `HitPayload.vulnerable`: the payloads where the row's hit used up a vulnerability (doubled).
/// Computed on first use, then shared.
pub type VulnerableFn = Arc<dyn Fn() -> Result<(Arc<Pmf>, Arc<Pmf>), DiceError> + Send + Sync>;

/// `HitPayload.typedOdds`: `(hit, crit)` odds a payload deals `type`.
pub type TypedOddsFn = Arc<dyn Fn(&str) -> Result<(f64, f64), DiceError> + Send + Sync>;

/// `HitPayload`: one rider's payload on one source.
#[derive(Clone)]
pub struct HitPayload {
    /// Index into `every_hit_ids`, or `None` for a first-hit rider (TS -1).
    pub rider: Option<usize>,
    pub id: String,
    /// The fire slot a first-hit rider marks when it applies, or `None`.
    pub slot: Option<usize>,
    /// The rider's counter's bit in a source's variant mask, or 0 when uncapped.
    pub bit: u32,
    pub landing: Option<RiderLanding>,
    pub crit_only: bool,
    pub hit: Arc<Pmf>,
    pub crit: Arc<Pmf>,
    pub vulnerable: VulnerableFn,
    /// The bit of a source's variant mask that says its coin came up, or 0 when it has none.
    pub coin_bit: u32,
    /// The bit that says its `targetHas` gate is open on that row, or 0 when it has none.
    pub gate_bit: u32,
    /// On a row a partner opens to it: the partners, one of which must land in the same draw.
    pub partners: Vec<String>,
    pub typed_odds: Option<TypedOddsFn>,
}

/// `HoldChoice`: an above-threshold landing of a substitute's watched step.
#[derive(Clone)]
pub struct HoldChoice {
    /// Hit or crit.
    pub outcome: StepOutcome,
    pub matched: bool,
    pub hold: Vec<Draw>,
    pub spend: Vec<Draw>,
}

/// The `reroll` argument of `drawsFor`: the reroll's slices and its fire slot.
#[derive(Clone)]
pub struct RerollArg {
    pub slices: SourceSlices,
    pub slot: usize,
}

/// What a draw of one outcome from one variant applies, counts and marks as fired (`landingOf`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Landing {
    pub applies: Vec<usize>,
    pub bumps: Vec<usize>,
    pub fires: Vec<usize>,
}

/// What `fold` returns: the draw fields `slice`, `own` and `riders`.
#[derive(Clone)]
pub struct Folded {
    pub slice: Arc<Pmf>,
    pub own: Option<Arc<Pmf>>,
    pub riders: Option<Riders>,
}

/// A rider's payload split by whether it dealt the `dealing` type (`typedPayloadOf`).
#[derive(Clone)]
struct TypedSplit {
    odds: f64,
    typed: Arc<Pmf>,
    untyped: Arc<Pmf>,
}

/// One `typedPayloads` entry: the payload it was made for (kept alive so its address stays its
/// identity) and the split.
type TypedEntry = (Arc<Pmf>, TypedSplit);

/// The fold tables and the draw builders over them.
pub struct Folds {
    pub res: Arc<Resolved>,
    /// `everyHitIds`.
    pub every_hit_ids: Vec<String>,
    /// `counterMax`.
    pub counter_max: Vec<f64>,
    pub counter_landing: Vec<Option<RiderLanding>>,
    pub counter_crit_only: Vec<bool>,
    pub counter_dealt: Vec<bool>,
    pub counter_partnered: Vec<bool>,
    pub counter_gated: Vec<bool>,
    /// `perHitBySource`.
    pub per_hit_by_source: IndexMap<String, Vec<HitPayload>>,
    /// `countersBySource`: per source, the distinct counters watching it, in payload order.
    pub counters_by_source: IndexMap<String, Vec<usize>>,
    /// `coinsBySource`: per source, the coins (rider indexes) folded into it.
    pub coins_by_source: IndexMap<String, Vec<usize>>,
    /// `gateSetsBySource`: per source, key -> the distinct `targetHas` sets, first-seen order.
    pub gate_sets_by_source: IndexMap<String, IndexMap<String, Vec<String>>>,
    /// `matchNeeded`.
    pub match_needed: HashSet<String>,
    /// `basePayloads`.
    base_payloads: Mutex<HashMap<String, BasePayload>>,
    /// `typedPayloads`: by the payload's address and the odds' bits.
    typed_payloads: Mutex<HashMap<(usize, u64), TypedEntry>>,
}

/// JS `Math.min` of two numbers: NaN propagates.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// `1 << n` with JS's shift count (mod 32).
fn bit_of(n: usize) -> u32 {
    1u32.wrapping_shl(n as u32)
}

/// JS default sort order: UTF-16 code units.
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `gateKeyOf(names)`.
fn gate_key_of(names: &[String]) -> String {
    let mut seen: Vec<String> = Vec::new();
    for name in names {
        if !seen.contains(name) {
            seen.push(name.clone());
        }
    }
    seen.sort_by(|a, b| utf16_cmp(a, b));
    seen.join("\u{0}")
}

/// The kind a rider reads a save row under: `landing ?? "fail"` (`any` is tested before).
fn save_kind(landing: Option<RiderLanding>) -> SaveLanding {
    match landing {
        Some(RiderLanding::Save(kind)) => kind,
        _ => SaveLanding::Fail,
    }
}

fn outcome_label(outcome: StepOutcome) -> &'static str {
    match outcome {
        StepOutcome::Crit => "crit",
        StepOutcome::Miss => "miss",
        StepOutcome::None => "none",
        StepOutcome::Hit => "hit",
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn contextual_of(damage: &PlanDamage) -> Option<&dyn ContextualSource> {
    match damage {
        PlanDamage::One(source) => source.as_contextual(),
        PlanDamage::Many(_) => None,
    }
}

/// `ownSourcesOf(rider, index)`.
fn own_sources_of(res: &Resolved, index: usize) -> Result<Vec<String>, DiceError> {
    let Some(rider) = res.riders.get(index) else {
        return Ok(Vec::new());
    };
    let declared = rider.of_list();
    // An explicit `of: []` watches nothing, so the rider never lands; an omitted `of` defaults.
    if declared.as_ref().is_some_and(std::vec::Vec::is_empty) {
        return Ok(Vec::new());
    }
    let declared = declared.unwrap_or_else(|| res.default_of(index));
    let partners = res.partners_of.get(index).map(Vec::as_slice).unwrap_or(&[]);
    let of: Vec<String> = declared
        .into_iter()
        .filter(|entry| !partners.contains(entry))
        .collect();
    // Only partners: the rider lands on no row of its own.
    if of.is_empty() && !partners.is_empty() {
        return Ok(Vec::new());
    }
    let landing = match rider.landing {
        Some(RiderLanding::Any) => Some(SaveLanding::Fail),
        Some(RiderLanding::Save(kind)) => Some(kind),
        None => None,
    };
    let id = res.rider_ids.get(index).map(String::as_str).unwrap_or("");
    res.resolve_sources(id, &of, rider.on() == "dice-match", landing, false)
}

/// A plain payload's hit, crit and doubled payloads.
#[derive(Clone)]
struct Payload {
    hit: Arc<Pmf>,
    crit: Arc<Pmf>,
    vulnerable: VulnerableFn,
}

/// `payloadOf(payload, id)`.
fn payload_of(
    damage: &crate::turn::types::RiderDamage,
    crit_damage: Option<&crate::turn::types::RiderDamage>,
    eps: f64,
    id: &str,
) -> Result<Payload, DiceError> {
    let hit = Arc::new(rider_damage_pmf(damage, eps, id)?);
    let crit = Arc::new(crit_pmf(damage, crit_damage, &hit, eps)?);
    // A plain payload doubles with the attack it lands on, as the whole roll does.
    let doubled: Mutex<Option<(Arc<Pmf>, Arc<Pmf>)>> = Mutex::new(None);
    let (h, c) = (hit.clone(), crit.clone());
    let vulnerable: VulnerableFn = Arc::new(move || {
        let mut cell = lock(&doubled);
        if let Some(pair) = cell.as_ref() {
            return Ok(pair.clone());
        }
        let pair = (
            Arc::new(h.map_damage(|d| 2.0 * d)),
            Arc::new(c.map_damage(|d| 2.0 * d)),
        );
        *cell = Some(pair.clone());
        Ok(pair)
    });
    Ok(Payload {
        hit,
        crit,
        vulnerable,
    })
}

/// `thin(pmf, happens)`: `pmf` dealt with probability `happens`, else nothing: one landing of a
/// rider that may not happen.
pub fn thin(pmf: &Pmf, happens: f64, eps: f64) -> Result<Pmf, DiceError> {
    if happens == 1.0 {
        return Ok(pmf.clone());
    }
    Ok(pmf
        .scale_mass(happens)
        .add(&Pmf::delta(0.0, eps)?.scale_mass(1.0 - happens)))
}

/// `buildPlan`'s third stretch (plan.ts 3184-3680): the per-hit fold tables.
pub(super) fn build_folds(res: &Arc<Resolved>, lay: &Layout) -> Result<Folds, DiceError> {
    /// `coinBit` / `gateBit` while still to be assigned (TS -1).
    const PENDING: u32 = u32::MAX;

    let eps = res.eps;
    let every_hit_ids: Vec<String> = res
        .rider_ids
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            res.riders
                .get(*index)
                .is_some_and(|r| r.on() == "every-hit")
        })
        .map(|(_, id)| id.clone())
        .collect();
    let mut counter_max: Vec<f64> = Vec::new();
    let mut counter_landing: Vec<Option<RiderLanding>> = Vec::new();
    let mut counter_crit_only: Vec<bool> = Vec::new();
    let mut counter_dealt: Vec<bool> = Vec::new();
    let mut counter_partnered: Vec<bool> = Vec::new();
    let mut counter_gated: Vec<bool> = Vec::new();
    let mut counter_id_by_key: HashMap<String, usize> = HashMap::new();
    let mut per_hit_by_source: IndexMap<String, Vec<HitPayload>> = IndexMap::new();
    let mut counters_by_source: IndexMap<String, Vec<usize>> = IndexMap::new();
    let mut coins_by_source: IndexMap<String, Vec<usize>> = IndexMap::new();
    let mut gate_sets_by_source: IndexMap<String, IndexMap<String, Vec<String>>> = IndexMap::new();

    for &node in &res.order {
        if node >= res.rider_count {
            continue;
        }
        let Some(rider) = res.riders.get(node) else {
            continue;
        };
        if rider.on() != "every-hit" && !rider.is_first_hit_fold() {
            continue;
        }
        let id = res.rider_ids.get(node).cloned().unwrap_or_default();
        let sources: Vec<String> = res
            .source_ids_by_node
            .get(node)
            .cloned()
            .unwrap_or_default();
        let own: IndexMap<String, &crate::turn::types::RiderPayload> = rider
            .per_source()
            .map(|per| per.iter().map(|(k, v)| (k.clone(), v)).collect())
            .unwrap_or_default();
        for key in own.keys() {
            if !sources.contains(key) {
                return Err(fail(
                    TurnSpecErrorCode::UnknownId,
                    key,
                    format!(
                        "Rider \"{id}\" has a payload for \"{key}\", which it does not watch. Watched: {}.",
                        sources
                            .iter()
                            .map(|each| format!("\"{each}\""))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
        }
        // A capped rider, or one with a payload per source, is folded into its sources' draws (a
        // per-source first hit always is). A rider that rolls its own attack needs its own step:
        // grants, step statistics and the crit check live there, and a fold skips all three. A
        // plain every-hit rider keeps folding whatever it rolls, as it always has.
        let folded = rider.on() == "first-hit"
            || (rider.on() == "every-hit" && rider.max().is_some())
            || !own.is_empty()
            || rider.target_has.is_some();
        if folded {
            let mut payloads: Vec<(String, Option<&crate::turn::types::RiderDamage>)> = vec![
                ("its damage".to_string(), Some(&rider.damage)),
                ("its critDamage".to_string(), rider.crit_damage.as_ref()),
            ];
            for (source_id, payload) in &own {
                payloads.push((
                    format!("its payload for \"{source_id}\""),
                    Some(&payload.damage),
                ));
                payloads.push((
                    format!("its critDamage for \"{source_id}\""),
                    payload.crit_damage.as_ref(),
                ));
            }
            for (name, damage) in payloads {
                let Some(damage) = damage else { continue };
                if attack_part_count(damage.parts(), eps, &id)? > 0 {
                    let kind = if rider.target_has.is_some() {
                        "a targetHas gate"
                    } else if rider.on() == "first-hit" {
                        "a payload per source"
                    } else {
                        "a cap or a payload per source"
                    };
                    return Err(fail(
                        TurnSpecErrorCode::UnsupportedTrigger,
                        &id,
                        format!(
                            "Rider \"{id}\" has {kind} and {name} rolls an attack. Such a rider is folded into its attacks' draws, which skips granted modifiers, step statistics and the critDamage check. Declare the attack as a plain onFirstHit rider instead."
                        ),
                    ));
                }
            }
        }
        let mut shared: Option<Payload> = None;
        let contextual: Option<&Arc<dyn ContextualPayload>> = res.contextual_payloads.get(&node);
        let partners_empty = res
            .partners_of
            .get(node)
            .is_none_or(std::vec::Vec::is_empty);
        let own_rows: Vec<String> = if partners_empty {
            sources.clone()
        } else {
            own_sources_of(res, node)?
        };
        let crit_only = res.crit_only.contains(&node);
        let mut counter: Option<usize> = None;
        // The cap: an every-hit rider's `max`, or 1 for a first-hit rider (a `max: 1` every-hit rider
        // was lowered to one, so a folded first-hit rider is the per-source spelling of it).
        let cap = if rider.on() == "every-hit" {
            rider.max()
        } else {
            Some(1.0)
        };
        // A cap at or above the number of watched steps never binds: the count before any watched
        // step is below that number, so every step draws with the rider. It is folded like an
        // uncapped rider, which is what makes `max: n` over n attacks `onEveryHit` bit for bit.
        let watched: HashSet<&String> = sources.iter().collect();
        let watch_count = lay
            .sequence
            .iter()
            .filter(|entry| watched.contains(&entry.id))
            .count();
        if let Some(cap) = cap.filter(|cap| *cap < watch_count as f64) {
            // A cap counts landings in turn order. An `any-miss` reroll resolves after every declared
            // attack, so it would be counted at the end of the turn instead of where it happens.
            let late = sources.iter().find(|source_id| {
                res.rider_index_by_id
                    .get(*source_id)
                    .and_then(|index| res.riders.get(*index))
                    .is_some_and(|r| r.on() == "any-miss")
            });
            if let Some(late) = late {
                let what = if rider.on() == "every-hit" {
                    "is capped"
                } else {
                    "has a payload per source"
                };
                return Err(fail(
                    TurnSpecErrorCode::UnsupportedTrigger,
                    &id,
                    format!(
                        "Rider \"{id}\" {what} and watches \"{late}\", an any-miss reroll. An any-miss rider resolves after every declared attack, so the cap would count its landing at the end of the turn instead of right after the miss. Use onFirstMiss (on: \"first-miss\"), which resolves directly after the attack that missed."
                    ),
                ));
            }
            // Riders share a counter only when they land on the same rows: over a save row, on the
            // same classes of it, so the landing kind is part of the key there.
            let kind = match rider.landing {
                Some(RiderLanding::Any) => Some(RiderLanding::Any),
                Some(landing) if sources.iter().any(|s| res.is_save_row(s)) => Some(landing),
                _ => None,
            };
            let dealt_only = rider.landing == Some(RiderLanding::Save(SaveLanding::Damage))
                && sources.iter().any(|s| res.dealt_sources.contains(s));
            let mut sorted_sources = sources.clone();
            sorted_sources.sort_by(|a, b| utf16_cmp(a, b));
            let mut key: Vec<serde_json::Value> = vec![
                serde_json::json!(sorted_sources),
                serde_json::json!(crate::js::num_to_string(cap)),
                match kind {
                    Some(RiderLanding::Any) => serde_json::json!("any"),
                    Some(RiderLanding::Save(l)) => serde_json::json!(l.as_str()),
                    None => serde_json::Value::Null,
                },
            ];
            if crit_only {
                key.push(serde_json::json!("crit"));
            }
            if dealt_only {
                key.push(serde_json::json!("dealt"));
            }
            if !partners_empty {
                key.push(serde_json::json!(id));
            }
            if let Some(names) = &rider.target_has {
                let mut sorted = names.clone();
                sorted.sort_by(|a, b| utf16_cmp(a, b));
                key.push(serde_json::json!("gate"));
                key.push(serde_json::json!(sorted));
            }
            let key = serde_json::to_string(&key).unwrap_or_default();
            let known = if let Some(known) = counter_id_by_key.get(&key) {
                *known
            } else {
                let known = counter_max.len();
                counter_max.push(cap);
                counter_landing.push(kind);
                counter_crit_only.push(crit_only);
                counter_dealt.push(dealt_only);
                counter_partnered.push(!partners_empty);
                counter_gated.push(rider.target_has.is_some());
                counter_id_by_key.insert(key, known);
                known
            };
            counter = Some(known);
        }
        let apply_index = every_hit_ids.iter().position(|each| *each == id);
        let slot = if rider.on() == "first-hit" || rider.target_has.is_some() {
            lay.fire_slots.get(&id).copied()
        } else {
            None
        };
        let happens_of = lay.happens_of.get(node).copied().unwrap_or(1.0);
        for source_id in &sources {
            let each = own.get(source_id).copied();
            let landing = match contextual {
                Some(contextual) => Some(contextual.at(source_id)?),
                None => None,
            };
            let payload: Payload = if let Some(landing) = landing {
                let (vh, vc) = (landing.vulnerable.on_hit, landing.vulnerable.on_crit);
                Payload {
                    hit: landing.on_hit,
                    crit: landing.on_crit,
                    vulnerable: Arc::new(move || Ok((vh.clone(), vc.clone()))),
                }
            } else if let Some(each) = each {
                payload_of(&each.damage, each.crit_damage.as_ref(), eps, &id)?
            } else if let Some(shared) = &shared {
                shared.clone()
            } else {
                let made = payload_of(&rider.damage, rider.crit_damage.as_ref(), eps, &id)?;
                shared = Some(made.clone());
                made
            };
            let mut bit = 0u32;
            if let Some(counter) = counter {
                let counters = counters_by_source.entry(source_id.clone()).or_default();
                let local = if let Some(local) = counters.iter().position(|c| *c == counter) {
                    local
                } else {
                    counters.push(counter);
                    counters.len() - 1
                };
                bit = bit_of(local);
            }
            // A rider that lands once at most takes its coin in its payload; one with a coin bit, in its variant.
            let coined = lay
                .coin_flags
                .get(node)
                .copied()
                .flatten()
                .and_then(|flag| lay.flags.get(flag))
                .is_some_and(|flag| flag.bit != -1);
            let happens = if coined { 1.0 } else { happens_of };
            let thinned: Payload = if happens == 1.0 {
                payload.clone()
            } else {
                let inner = payload.vulnerable.clone();
                Payload {
                    hit: Arc::new(thin(&payload.hit, happens, eps)?),
                    crit: Arc::new(thin(&payload.crit, happens, eps)?),
                    vulnerable: Arc::new(move || {
                        let (h, c) = inner()?;
                        Ok((
                            Arc::new(thin(&h, happens, eps)?),
                            Arc::new(thin(&c, happens, eps)?),
                        ))
                    }),
                }
            };
            if coined {
                coins_by_source
                    .entry(source_id.clone())
                    .or_default()
                    .push(node);
            }
            if let Some(names) = &rider.target_has {
                gate_sets_by_source
                    .entry(source_id.clone())
                    .or_default()
                    .insert(gate_key_of(names), names.clone());
            }
            let typed_odds: Option<TypedOddsFn> = match contextual {
                Some(contextual) if contextual.has_dealt() => {
                    let contextual = contextual.clone();
                    let source_id = source_id.clone();
                    Some(Arc::new(move |type_: &str| {
                        let odds = contextual.dealt(type_, &source_id)?;
                        Ok((odds.hit * happens, odds.crit * happens))
                    }))
                }
                _ => None,
            };
            let entry = HitPayload {
                rider: apply_index,
                id: id.clone(),
                slot,
                bit,
                landing: rider.landing,
                crit_only,
                hit: thinned.hit,
                crit: thinned.crit,
                vulnerable: thinned.vulnerable,
                coin_bit: if coined { PENDING } else { 0 },
                gate_bit: if rider.target_has.is_some() {
                    PENDING
                } else {
                    0
                },
                // A row of its own it lands on for its trigger; a row only a partner opens, alongside that partner.
                partners: if own_rows.contains(source_id) {
                    Vec::new()
                } else {
                    res.opened_by
                        .get(node)
                        .and_then(|opened| opened.get(source_id))
                        .cloned()
                        .unwrap_or_default()
                },
                typed_odds,
            };
            per_hit_by_source
                .entry(source_id.clone())
                .or_default()
                .push(entry);
        }
    }
    // A coin's bit in a source's variant mask comes after its counters' bits.
    for (source_id, coins) in &coins_by_source {
        let base = counters_by_source.get(source_id).map_or(0, Vec::len);
        for payload in per_hit_by_source.get_mut(source_id).into_iter().flatten() {
            if payload.coin_bit == PENDING {
                let index = res
                    .rider_index_by_id
                    .get(&payload.id)
                    .and_then(|node| coins.iter().position(|c| c == node));
                // INFALLIBLE: a coined payload's rider is in `coins`; -1 would shift as JS does.
                let at = match index {
                    Some(index) => (base + index) as u32,
                    None => (base as u32).wrapping_sub(1),
                };
                payload.coin_bit = 1u32.wrapping_shl(at);
            }
        }
    }
    // A gate's bit comes after the counters' and the coins': one per distinct `targetHas` set.
    for (source_id, sets) in &gate_sets_by_source {
        let base = counters_by_source.get(source_id).map_or(0, Vec::len)
            + coins_by_source.get(source_id).map_or(0, Vec::len);
        if base + sets.len() > MAX_VARIANT_BITS {
            return Err(fail(
                TurnSpecErrorCode::TooManyStates,
                source_id,
                format!(
                    "\"{source_id}\" carries {} variant bits (capped counters, coins and distinct targetHas sets); a turn may have at most {MAX_VARIANT_BITS} per attack. Each doubles the draws that attack may carry.",
                    base + sets.len()
                ),
            ));
        }
        for payload in per_hit_by_source.get_mut(source_id).into_iter().flatten() {
            if payload.gate_bit == PENDING {
                let names = res
                    .rider_index_by_id
                    .get(&payload.id)
                    .and_then(|node| res.riders.get(*node))
                    .and_then(|rider| rider.target_has.as_deref())
                    .unwrap_or(&[]);
                let index = sets.get_index_of(&gate_key_of(names));
                let at = match index {
                    Some(index) => (base + index) as u32,
                    None => (base as u32).wrapping_sub(1),
                };
                payload.gate_bit = 1u32.wrapping_shl(at);
            }
        }
    }
    for (source_id, counters) in &counters_by_source {
        if counters.len() > MAX_CAPPED_COUNTERS {
            return Err(fail(
                TurnSpecErrorCode::TooManyCounters,
                source_id,
                format!(
                    "\"{source_id}\" is watched by {} capped every-hit riders with different caps or sources; a turn may have at most {MAX_CAPPED_COUNTERS} per attack. Each doubles the draws that attack carries.",
                    counters.len()
                ),
            ));
        }
    }
    let mut match_needed: HashSet<String> = HashSet::new();
    for (index, rider) in res.riders.iter().enumerate() {
        if rider.on() == "dice-match" {
            for id in res.source_ids_by_node.get(index).into_iter().flatten() {
                match_needed.insert(id.clone());
            }
        }
    }
    Ok(Folds {
        res: res.clone(),
        every_hit_ids,
        counter_max,
        counter_landing,
        counter_crit_only,
        counter_dealt,
        counter_partnered,
        counter_gated,
        per_hit_by_source,
        counters_by_source,
        coins_by_source,
        gate_sets_by_source,
        match_needed,
        base_payloads: Mutex::new(HashMap::new()),
        typed_payloads: Mutex::new(HashMap::new()),
    })
}

impl Folds {
    fn eps(&self) -> f64 {
        self.res.eps
    }

    fn payloads_of(&self, source_id: &str) -> &[HitPayload] {
        self.per_hit_by_source
            .get(source_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// `basePayload(sourceId)`.
    pub fn base_payload(&self, source_id: &str) -> Result<BasePayload, DiceError> {
        if let Some(known) = lock(&self.base_payloads).get(source_id) {
            return Ok(known.clone());
        }
        let made = base_payload_of(&self.res.damage_of(source_id), self.eps())?;
        lock(&self.base_payloads).insert(source_id.to_string(), made.clone());
        Ok(made)
    }

    /// `alongsidePartners(lands)`: `lands` without the payloads a partner opens the row to whose
    /// partner is not among them: on a row a partner opens, a payload lands only where that
    /// partner lands too (in the same draw).
    #[allow(
        clippy::needless_pass_by_value,
        reason = "callers build the Vec to hand over"
    )]
    pub fn alongside_partners<'a>(&self, lands: Vec<&'a HitPayload>) -> Vec<&'a HitPayload> {
        let landed: HashSet<&str> = lands
            .iter()
            .filter(|payload| payload.partners.is_empty())
            .map(|payload| payload.id.as_str())
            .collect();
        lands
            .iter()
            .copied()
            .filter(|payload| {
                payload.partners.is_empty()
                    || payload
                        .partners
                        .iter()
                        .any(|partner| landed.contains(partner.as_str()))
            })
            .collect()
    }

    /// `activeAt(sourceId, mask, outcome, dealt, coins)`; `outcome` is hit, crit or miss. The
    /// payloads of `sourceId` that land on a draw of `outcome` from variant `mask`: within their
    /// cap, on a crit for a crit-only rider, where damage was dealt for a `damage` rider, on a miss
    /// only for an `any` rider, and on a row a partner opens only where that partner lands too.
    /// With `coins`, a rider whose coin did not come up is left out (it lands, but deals nothing).
    pub fn active_at(
        &self,
        source_id: &str,
        mask: u32,
        outcome: StepOutcome,
        dealt: Option<bool>,
        coins: bool,
    ) -> Vec<&HitPayload> {
        let lands: Vec<&HitPayload> = self
            .payloads_of(source_id)
            .iter()
            .filter(|payload| {
                (payload.bit == 0 || (mask & payload.bit) != 0)
                    && (payload.gate_bit == 0 || (mask & payload.gate_bit) != 0)
                    && (!payload.crit_only || outcome == StepOutcome::Crit)
                    // "When you deal damage": a hit that dealt nothing is no landing for it.
                    && !(dealt == Some(false)
                        && payload.landing == Some(RiderLanding::Save(SaveLanding::Damage)))
                    && (outcome != StepOutcome::Miss
                        || (payload.landing == Some(RiderLanding::Any) && !payload.crit_only))
            })
            .collect();
        self.alongside_partners(lands)
            .into_iter()
            .filter(|payload| !coins || payload.coin_bit == 0 || (mask & payload.coin_bit) != 0)
            .collect()
    }

    /// `fold(...)`: `slice` with the riders that land on it folded in (see [`Folds::active_at`]);
    /// with the own part and the riders' payloads when any is folded.
    #[allow(clippy::too_many_arguments)] // the TS `fold`'s seven, plus `self`
    pub fn fold(
        &self,
        source_id: &str,
        outcome: StepOutcome,
        slice: &Arc<Pmf>,
        mask: u32,
        vulnerable: bool,
        dealt: Option<bool>,
        joined: &[String],
    ) -> Result<Folded, DiceError> {
        let eps = self.eps();
        let mut folded = slice.clone();
        let mut parts: Vec<(String, Arc<Pmf>)> = Vec::new();
        for payload in self.active_at(source_id, mask, outcome, dealt, true) {
            // A rider that lands on anything is no part of the attack's damage: its plain payload, never doubled.
            let any = payload.landing == Some(RiderLanding::Any) && !payload.crit_only;
            // A rider whose dice joined the row's roll (`joins`) deals nothing beside it there; its landing still counts.
            let paid: Arc<Pmf> = if joined.contains(&payload.id) {
                Arc::new(Pmf::delta(0.0, eps)?)
            } else if any {
                payload.hit.clone()
            } else if vulnerable {
                let (hit, crit) = (payload.vulnerable)()?;
                // INFALLIBLE: only hit and crit reach here (a miss lands `any` riders only).
                if outcome == StepOutcome::Crit {
                    crit
                } else {
                    hit
                }
            } else if outcome == StepOutcome::Crit {
                payload.crit.clone()
            } else {
                payload.hit.clone()
            };
            folded = self.fold_one(&folded, &paid);
            parts.push((payload.id.clone(), paid));
        }
        Ok(if parts.is_empty() {
            Folded {
                slice: folded,
                own: None,
                riders: None,
            }
        } else {
            Folded {
                slice: folded,
                own: Some(slice.clone()),
                riders: Some(Arc::new(parts)),
            }
        })
    }

    /// One rider's payload folded into `all`: convolved (joint) or as its mass.
    fn fold_one(&self, all: &Arc<Pmf>, paid: &Arc<Pmf>) -> Arc<Pmf> {
        if self.res.folds == FoldMode::Joint {
            return Arc::new(all.convolve(paid, Some(self.eps()), true));
        }
        let paid_mass = paid.mass();
        if paid_mass != 1.0 {
            Arc::new(all.scale_mass(paid_mass))
        } else {
            all.clone()
        }
    }

    /// `landingOf(sourceId, mask, outcome, dealt?)`: what a draw of `outcome` from variant `mask`
    /// of `sourceId` applies, counts and marks as fired.
    pub fn landing_of(
        &self,
        source_id: &str,
        mask: u32,
        outcome: StepOutcome,
        dealt: Option<bool>,
    ) -> Landing {
        let active = self.active_at(source_id, mask, outcome, dealt, false);
        let counters = self
            .counters_by_source
            .get(source_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        Landing {
            applies: active.iter().filter_map(|p| p.rider).collect(),
            bumps: counters
                .iter()
                .enumerate()
                .filter(|(local, counter)| {
                    let counter = **counter;
                    let bit = bit_of(*local);
                    (mask & bit) != 0
                        && (!self.counter_crit_only[counter] || outcome == StepOutcome::Crit)
                        && !(dealt == Some(false) && self.counter_dealt[counter])
                        && (outcome != StepOutcome::Miss
                            || (self.counter_landing[counter] == Some(RiderLanding::Any)
                                && !self.counter_crit_only[counter]))
                        // A counter of a rider a partner gates here counts only where it landed.
                        && (!self.counter_partnered[counter]
                            || active.iter().any(|p| p.bit == bit))
                        // A gated counter counts only the landings its gate opened.
                        && (!self.counter_gated[counter] || active.iter().any(|p| p.bit == bit))
                })
                .map(|(_, counter)| *counter)
                .collect(),
            fires: active.iter().filter_map(|p| p.slot).collect(),
        }
    }

    /// `withFolded(fired, sourceId, draw?)`: `fired` after `sourceId` lands: a first-hit rider with
    /// a payload per source is folded into its sources' draws, so it is not a step and marks its
    /// fire slot only there. The look-ahead reads the plain variant, which does not carry it, so
    /// it applies the slots itself: one that is still empty is the first landing among that
    /// rider's sources; one a partner opens the row to marks only where that partner marks too.
    pub fn with_folded(
        &self,
        fired: &[FireMode],
        source_id: &str,
        draw: Option<&Draw>,
    ) -> Vec<FireMode> {
        // A draw that is no landing marks nothing. A save row's draws are all "hit" and say whether they
        // land per landing kind, so each rider reads its own kind there.
        if let Some(draw) = draw
            && draw.by_kind.is_none()
            && draw.outcome != StepOutcome::Hit
            && draw.outcome != StepOutcome::Crit
        {
            return fired.to_vec();
        }
        let mut marked: Vec<FireMode> = fired.to_vec();
        let lands = self.alongside_partners(
            self.payloads_of(source_id)
                .iter()
                .filter(|payload| {
                    payload.slot.is_some_and(|slot| matches!(fired.get(slot), Some(None)))
                        // A gated rider's slot is marked where its gate opened, which the plain variant cannot say.
                        && payload.gate_bit == 0
                        && match draw.and_then(|d| d.by_kind) {
                            None => true,
                            Some(by_kind) => {
                                payload.landing == Some(RiderLanding::Any)
                                    || by_kind.of(save_kind(payload.landing)) == StepOutcome::Hit
                            }
                        }
                })
                .collect(),
        );
        for payload in lands {
            let Some(slot) = payload.slot else { continue };
            if let Some(cell) = marked.get_mut(slot)
                && cell.is_none()
            {
                *cell = Some(Fire::Hit);
            }
        }
        marked
    }

    /// `saveRowDraws(sourceId, mask, classes)`: a watched save row's draws, one per class (see
    /// `SaveClasses`): every class carries what it is to a rider reading the row under each kind,
    /// and the `every-hit` riders that land on it under their own kind are folded in. Every class
    /// keeps the `outcome` a row nobody watches has, a hit, so the row's own statistics do not
    /// depend on which riders read it. `classes` defaults to `res.classes_of(sourceId)`.
    pub fn save_row_draws(
        &self,
        source_id: &str,
        mask: u32,
        classes: Option<&SaveClasses>,
    ) -> Result<Vec<Draw>, DiceError> {
        let eps = self.eps();
        let own_classes;
        let classes = if let Some(classes) = classes {
            classes
        } else {
            own_classes = self.res.classes_of(source_id);
            &own_classes
        };
        let counters = self
            .counters_by_source
            .get(source_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut draws = Vec::with_capacity(classes.len());
        for (index, slice) in classes.iter().enumerate() {
            // The riders that apply on this class: every uncapped one, and each capped one whose bit is
            // set in `mask`, only where the class lands under the rider's own kind, and a rider a partner
            // opens the row to only where that partner lands too (as `active_at` gates it).
            let active = self.alongside_partners(
                self.payloads_of(source_id)
                    .iter()
                    .filter(|payload| {
                        (payload.bit == 0 || (mask & payload.bit) != 0)
                            && (payload.coin_bit == 0 || (mask & payload.coin_bit) != 0)
                            && (payload.gate_bit == 0 || (mask & payload.gate_bit) != 0)
                            && !payload.crit_only
                            && (payload.landing == Some(RiderLanding::Any)
                                || class_lands(index, save_kind(payload.landing)))
                    })
                    .collect(),
            );
            let mut folded = slice.clone();
            let parts: Vec<(String, Arc<Pmf>)> = active
                .iter()
                .map(|payload| (payload.id.clone(), payload.hit.clone()))
                .collect();
            for payload in &active {
                folded = Arc::new(folded.convolve(&payload.hit, Some(eps), true));
            }
            let mut draw = Draw::plain(StepOutcome::Hit, false, false, folded);
            draw.applies = active.iter().filter_map(|p| p.rider).collect();
            // A counter counts the landings of its riders: the classes that land under its kind.
            draw.bumps = counters
                .iter()
                .enumerate()
                .filter(|(local, counter)| {
                    let counter = **counter;
                    let bit = bit_of(*local);
                    (mask & bit) != 0
                        && !self.counter_crit_only[counter]
                        && (self.counter_landing[counter] == Some(RiderLanding::Any)
                            || class_lands(index, save_kind(self.counter_landing[counter])))
                        // A counter of a rider a partner gates here counts only where it landed.
                        && (!self.counter_partnered[counter] || active.iter().any(|p| p.bit == bit))
                        && (!self.counter_gated[counter] || active.iter().any(|p| p.bit == bit))
                })
                .map(|(_, counter)| *counter)
                .collect();
            draw.fires = active.iter().filter_map(|p| p.slot).collect();
            if !parts.is_empty() {
                draw.own = Some(slice.clone());
                draw.riders = Some(Arc::new(parts));
            }
            draw.by_kind = Some(class_outcomes(index));
            draws.push(draw);
        }
        Ok(draws)
    }

    /// `typedPayloadOf(paid, odds)`: `paid` (a folded rider's payload) given that it dealt the
    /// `dealing` type, and given that it did not, with `odds` the chance it did. Typed damage
    /// above 0 is damage dealt, so the typed part is the payload's part above 0, at most all of it.
    fn typed_payload_of(&self, paid: &Arc<Pmf>, odds: f64) -> TypedSplit {
        let key = (
            Arc::as_ptr(paid) as usize,
            if odds == 0.0 { 0.0f64 } else { odds }.to_bits(),
        );
        if let Some((_, known)) = lock(&self.typed_payloads).get(&key) {
            return known.clone();
        }
        let (above, none) = paid.split_by_dealt();
        let mass = paid.mass();
        let dealt_share = if mass > 0.0 { above.mass() / mass } else { 0.0 };
        let t = js_min(odds, dealt_share);
        let typed = if t > 0.0 {
            Arc::new(above.scale_mass(mass / above.mass()))
        } else {
            paid.clone()
        };
        let untyped = if t <= 0.0 {
            paid.clone()
        } else {
            let rest = if t < dealt_share {
                above.scale_mass(1.0 - t / dealt_share).add(&none)
            } else {
                none
            };
            Arc::new(rest.scale_mass(1.0 / (1.0 - t)))
        };
        let known = TypedSplit {
            odds: t,
            typed,
            untyped,
        };
        lock(&self.typed_payloads).insert(key, (paid.clone(), known.clone()));
        known
    }

    /// `foldPayloads(own, riders)`: `own` with `riders`' payloads folded in, as `fold` folds them.
    fn fold_payloads(&self, own: &Arc<Pmf>, riders: &[(String, Arc<Pmf>)]) -> Arc<Pmf> {
        riders
            .iter()
            .fold(own.clone(), |all, (_, paid)| self.fold_one(&all, paid))
    }

    /// `typedSplit(sourceId, outcome, draws, rowContext)`: `draws` of a hit or crit of `sourceId`,
    /// split by whether the landing dealt the `dealing` type: the row's own odds in its context
    /// (within a part that dealt damage, scaled to it), or a rider's that landed with it, each
    /// independent. The split is by odds alone: exact for every marginal. A rider's payload is
    /// split with it (typed damage above 0 is damage dealt), so a landing that dealt the type
    /// through a rider also dealt that rider's damage: one event for a condition that damage ends.
    pub fn typed_split(
        &self,
        source_id: &str,
        outcome: StepOutcome,
        draws: &[Draw],
        row_context: Option<&RowContext>,
    ) -> Result<Vec<Draw>, DiceError> {
        // INFALLIBLE: `dealing_sources` is non-empty only when `dealing_type` is set.
        let type_ = self.res.dealing_type.as_deref().unwrap_or("");
        let crit = outcome == StepOutcome::Crit;
        let source = self.res.damage_of(source_id);
        let contextual = contextual_of(&source).filter(|c| c.has_dealt());
        let (Some(contextual), Some(row_context)) = (contextual, row_context) else {
            return Err(fail(
                TurnSpecErrorCode::NotAnAttack,
                source_id,
                format!(
                    "\"{source_id}\" is read by a condition that needs {type_} damage dealt, but its source cannot say the odds it deals it (ContextualSource.dealt)."
                ),
            ));
        };
        let odds = contextual.dealt(type_, row_context)?;
        let row_odds = if crit { odds.crit } else { odds.hit };
        let not_dealt = Some(not_dealt_by_kind(crit));
        let mut whole = 0.0;
        let mut dealt_mass = 0.0;
        for draw in draws {
            let mass = draw.own.as_ref().unwrap_or(&draw.slice).mass();
            whole += mass;
            dealt_mass += if draw.by_kind == not_dealt { 0.0 } else { mass };
        }
        let mut out: Vec<Draw> = Vec::new();
        for draw in draws {
            // Typed damage above 0 is damage dealt: a part that dealt none is typed only by a rider.
            let own = if draw.by_kind == not_dealt {
                0.0
            } else {
                js_min(
                    1.0,
                    if dealt_mass > 0.0 {
                        (row_odds * whole) / dealt_mass
                    } else {
                        0.0
                    },
                )
            };
            let empty: Vec<(String, Arc<Pmf>)> = Vec::new();
            let riders: &Vec<(String, Arc<Pmf>)> = draw.riders.as_deref().unwrap_or(&empty);
            // The riders that may deal the type here: by index into `riders`, each payload split by whether it did.
            let mut typing: Vec<(usize, TypedSplit)> = Vec::new();
            for (index, (id, paid)) in riders.iter().enumerate() {
                let Some(payload) = self
                    .payloads_of(source_id)
                    .iter()
                    .find(|each| each.id == *id)
                else {
                    continue;
                };
                let Some(typed_odds) = &payload.typed_odds else {
                    return Err(fail(
                        TurnSpecErrorCode::NotAnAttack,
                        id,
                        format!(
                            "Rider \"{id}\" lands on \"{source_id}\", which a condition needing {type_} damage reads, but it cannot say the odds it deals it (ContextualPayload.dealt)."
                        ),
                    ));
                };
                // A rider that lands on anything deals its plain payload on a crit too (see `fold`): its plain hit's odds.
                let plain = payload.landing == Some(RiderLanding::Any) && !payload.crit_only;
                let (hit_odds, crit_odds) = typed_odds(type_)?;
                let mode_odds = if !plain && crit { crit_odds } else { hit_odds };
                let split = self.typed_payload_of(paid, mode_odds);
                if split.odds > 0.0 {
                    typing.push((index, split));
                }
            }
            let typed_draw = |factor: f64, typed: bool| {
                let mut d = scale_draw(draw, factor);
                d.typed = Some(typed);
                d
            };
            if typing.is_empty() {
                if own > 0.0 {
                    out.push(typed_draw(own, true));
                }
                if own < 1.0 {
                    out.push(typed_draw(1.0 - own, false));
                }
                continue;
            }
            // Disjoint pieces: the own damage dealt the type; else the first typing rider did; else the next; ...; else none did.
            if own > 0.0 {
                out.push(typed_draw(own, true));
            }
            let piece = |share: f64, paid: &[(String, Arc<Pmf>)], typed: bool| -> Draw {
                let own_part = super::scale_shared(draw.own.as_ref().unwrap_or(&draw.slice), share);
                let mut d = draw.clone();
                d.slice = self.fold_payloads(&own_part, paid);
                d.own = Some(own_part);
                d.riders = Some(Arc::new(paid.to_vec()));
                d.typed = Some(typed);
                d
            };
            let mut paid: Vec<(String, Arc<Pmf>)> = riders.clone();
            let mut rest = 1.0 - own;
            for (index, split) in typing {
                if rest <= 0.0 {
                    break;
                }
                let Some(id) = riders.get(index).map(|(id, _)| id.clone()) else {
                    continue;
                };
                if let Some(cell) = paid.get_mut(index) {
                    *cell = (id.clone(), split.typed.clone());
                }
                out.push(piece(rest * split.odds, &paid, true));
                if let Some(cell) = paid.get_mut(index) {
                    *cell = (id, split.untyped.clone());
                }
                rest *= 1.0 - split.odds;
            }
            if rest > 0.0 {
                out.push(piece(rest, &paid, false));
            }
        }
        Ok(out)
    }

    /// `rerollSlicesOf(pmf)`: a rerolled miss's PMF by outcome: an empty one (a row that cannot
    /// miss) has nothing to roll again.
    pub fn reroll_slices_of(&self, pmf: &Pmf) -> Result<SourceSlices, DiceError> {
        Ok(match slice_source(pmf, None, self.eps())? {
            Some(slices) => slices,
            None => SourceSlices {
                hit: Arc::new(Pmf::empty_mass()),
                crit: Arc::new(Pmf::empty_mass()),
                miss: Arc::new(pmf.clone()),
            },
        })
    }

    /// `rerolledOf(sourceId, rowContext)`: the row's whole PMF once the first-hit reroll is spent
    /// on it in `rowContext`; `None` for a source that does not say.
    pub fn rerolled_of(
        &self,
        source_id: &str,
        row_context: Option<&RowContext>,
    ) -> Result<Option<Pmf>, DiceError> {
        let damage = self.res.damage_of(source_id);
        let Some(source) = contextual_of(&damage).filter(|c| c.has_rerolled_under()) else {
            return Ok(None);
        };
        let context = match row_context {
            Some(context) => context.clone(),
            None => context_of(&source.row_check(), 0, &[]),
        };
        Ok(Some(rerolled_pmf_under(
            source,
            &context,
            self.eps(),
            source_id,
        )?))
    }

    /// `missRerolledOf(sourceId, rowContext, mode)`: the row's outcome-labelled PMF over its miss
    /// branch once that miss is rolled again by `mode` in `rowContext`: the source's own
    /// `missRerolledUnder`, else its builder's `missRerolled`, else that of the builder
    /// `rollUnder` returns. A source with none of them cannot say what a rerolled miss rolls.
    pub fn miss_rerolled_of(
        &self,
        source_id: &str,
        row_context: Option<&RowContext>,
        mode: MissRerollMode,
    ) -> Result<Pmf, DiceError> {
        let eps = self.eps();
        let damage = self.res.damage_of(source_id);
        let declared =
            contextual_of(&damage).map(super::super::context::ContextualSource::row_check);
        let context = row_context
            .cloned()
            .or_else(|| declared.as_ref().map(|check| context_of(check, 0, &[])));
        let (Some(context), PlanDamage::One(source)) = (context, &damage) else {
            return Err(fail(
                TurnSpecErrorCode::NoRebindableSource,
                source_id,
                format!(
                    "\"{source_id}\" has no attack roll to reroll: a first-miss reroll needs an attack with a d20."
                ),
            ));
        };
        let contextual = source.as_contextual();
        let attempt: Result<Pmf, DiceError> = if let Some(c) =
            contextual.filter(|c| c.has_miss_rerolled_under())
        {
            c.miss_rerolled_under(&context, mode, eps)
        } else if let Source::Damage(DamageSource::Attack(attack)) = source {
            attack.miss_rerolled(mode, Some(&context), eps)
        } else {
            let built = match contextual {
                Some(c) => c
                    .roll_under(&context)
                    .map_err(|e| self.reroll_error(source_id, e))?,
                None => None,
            };
            match built {
                Some(RollUnder::Attack(attack)) => attack.miss_rerolled(mode, None, eps),
                _ => {
                    return Err(fail(
                        TurnSpecErrorCode::NoRebindableSource,
                        source_id,
                        format!(
                            "\"{source_id}\" has no rollUnder() that returns an attack and no missRerolledUnder(), so a rerolled miss cannot be priced."
                        ),
                    ));
                }
            }
        };
        attempt.map_err(|e| self.reroll_error(source_id, e))
    }

    /// The TS `catch` of `missRerolledOf`: an error about `rerollMisses` is the source already
    /// rerolling its own misses; any other is rethrown as it is.
    fn reroll_error(&self, source_id: &str, error: DiceError) -> DiceError {
        if error.message().contains("rerollMisses") {
            fail(
                TurnSpecErrorCode::UnsupportedTrigger,
                source_id,
                format!(
                    "\"{source_id}\" already rerolls its own misses, so a turn-level reroll cannot also watch it."
                ),
            )
        } else {
            error
        }
    }

    /// `convertedHit(sourceId, payload, rowContext)`: the unit-mass hit damage a converted miss
    /// deals where the row itself cannot hit (only a natural 20 lands, as a crit): the base payload
    /// when the draws split it, else the row's hit outcome re-rolled as an auto-hit in its own
    /// context.
    fn converted_hit(
        &self,
        source_id: &str,
        payload: Option<&BasePayload>,
        row_context: Option<&RowContext>,
    ) -> Result<Pmf, DiceError> {
        let eps = self.eps();
        if let Some(base) = payload.and_then(|p| p.base.as_ref()) {
            return mix_one("hit", &base.hit, eps);
        }
        let damage = self.res.damage_of(source_id);
        if let (Some(context), PlanDamage::One(source)) = (row_context, &damage)
            && let Some(contextual) = source.as_contextual()
        {
            // Never a crit: an attack that crits on every hit (its own `alwaysCrits()`, or a crit-on-hit grant) rolls with no crit.
            let no_crit;
            let rolled: &dyn ContextualSource = match source {
                Source::Damage(DamageSource::Attack(attack)) => {
                    no_crit = attack.no_crit()?;
                    &no_crit
                }
                _ => contextual,
            };
            let auto = RowContext {
                auto_hit: true,
                crit_on_hit: false,
                ..context.clone()
            };
            let hit = pmf_under(rolled, &auto, eps, source_id)?.filter_outcome_shared("hit");
            if hit.mass() > 0.0 {
                return Ok(hit.scale_mass(1.0 / hit.mass()));
            }
        }
        Err(fail(
            TurnSpecErrorCode::NotAnAttack,
            source_id,
            format!(
                "\"{source_id}\" never hits without a crit and has no hit payload to re-roll, so a converted miss has no hit damage."
            ),
        ))
    }

    /// One draw of `outcome`: `landingOf` and `fold` over `folded`.
    fn drawn(
        &self,
        source_id: &str,
        mask: u32,
        outcome: StepOutcome,
        (matched, spends): (bool, bool),
        dealt: Option<bool>,
        folded: Folded,
    ) -> Draw {
        let landing = self.landing_of(source_id, mask, outcome, dealt);
        let mut draw = Draw::plain(outcome, matched, spends, folded.slice);
        draw.applies = landing.applies;
        draw.bumps = landing.bumps;
        draw.fires = landing.fires;
        draw.own = folded.own;
        draw.riders = folded.riders;
        draw
    }

    /// `drawsFor(sourceId, slices, policy, mask, vulnerable, joined, rowContext, convert, reroll)`.
    ///
    /// The draws for `sourceId`: hit and crit, each split by exact match probability when a
    /// `dice-match` trigger reads it, and into spend/hold parts under a substitute's `policy`;
    /// then the separate channels; then the `every-hit` fold (the capped riders selected by
    /// `mask`, see [`Folds::fold`]); then miss. Every split happens on the base payload, so
    /// neither the match odds nor the transform ever see a separate channel's or the fold's dice.
    ///
    /// Returns `(fixed, choices)`. `fixed` draws belong to every variant. Each of `choices` is an
    /// above-threshold landing that is held or spent depending on the walk state, so a variant
    /// takes either its `hold` or its `spend` draws. With `convert`, the miss mass is drawn as the
    /// row's hit damage instead, in draws that spend: a converted miss (`first-miss` substitute).
    #[allow(clippy::too_many_arguments)]
    pub fn draws_for(
        &self,
        source_id: &str,
        slices: &SourceSlices,
        policy: Option<SubstitutePolicy>,
        mask: u32,
        vulnerable: bool,
        joined: &[String],
        row_context: Option<&RowContext>,
        convert: bool,
        reroll: Option<&RerollArg>,
    ) -> Result<(Vec<Draw>, Vec<HoldChoice>), DiceError> {
        let eps = self.eps();
        let match_info = if self.match_needed.contains(source_id) {
            Some(self.res.match_info_of(source_id)?)
        } else {
            None
        };
        // With neither split, the slices already carry the channels: draw them as they are.
        let payload: Option<BasePayload> = if policy.is_some() || match_info.is_some() {
            Some(self.base_payload(source_id)?)
        } else {
            None
        };
        // Under a substitute, a source that says what its reroll rolls (`rerolledUnder`) spends into that:
        // the whole row, its separate channels and joined dice in, so nothing convolves onto it.
        let rerolled: Option<Pmf> = if policy.is_some() {
            self.rerolled_of(source_id, row_context)?
        } else {
            None
        };
        let mut fixed: Vec<Draw> = Vec::new();
        let mut choices: Vec<HoldChoice> = Vec::new();
        // With a reroll spent, the row's own hit and crit draws stay and its miss is rolled again: the reroll's
        // hit, crit and miss draws follow, each marked with the reroll's slot.
        let mut parts: Vec<(&SourceSlices, Option<usize>)> = vec![(slices, None)];
        if let Some(reroll) = reroll {
            parts.push((&reroll.slices, Some(reroll.slot)));
        }
        // (slot, fixed.len(), choices.len()) at the start of each (part, outcome).
        let mut spans: Vec<(Option<usize>, usize, usize)> = Vec::new();
        let dealing = self.res.dealing_sources.contains(source_id);
        let dealt_source = self.res.dealt_sources.contains(source_id);
        for (part, part_slot) in &parts {
            for outcome in [StepOutcome::Hit, StepOutcome::Crit] {
                let crit = outcome == StepOutcome::Crit;
                let label = outcome_label(outcome);
                spans.push((*part_slot, fixed.len(), choices.len()));
                let slice = if crit { &part.crit } else { &part.hit };
                let mass = slice.mass();
                let separate: Option<&Arc<Pmf>> = if rerolled.is_some() {
                    None
                } else {
                    payload
                        .as_ref()
                        .and_then(|p| p.separate.as_ref())
                        .map(|s| if crit { &s.crit } else { &s.hit })
                };
                // The base payload as an outcome-labelled slice of this outcome's mass.
                let base: Arc<Pmf> = match payload.as_ref().and_then(|p| p.base.as_ref()) {
                    Some(b) if mass > 0.0 => Arc::new(
                        mix_one(label, if crit { &b.crit } else { &b.hit }, eps)?.scale_mass(mass),
                    ),
                    _ => slice.clone(),
                };
                let info = match_info
                    .as_ref()
                    .and_then(|(hit, crit_info)| if crit { crit_info } else { hit }.as_ref());
                let own = |part: &Arc<Pmf>| -> Arc<Pmf> {
                    match separate {
                        Some(separate) => Arc::new(part.convolve(separate, Some(eps), true)),
                        None => part.clone(),
                    }
                };
                // `part` as draws: one, or, for a row a `damage` condition reads, split by whether its own damage was above 0.
                let plain_draw = |part: &Arc<Pmf>,
                                  matched: bool,
                                  spends: bool|
                 -> Result<Vec<Draw>, DiceError> {
                    if !dealt_source {
                        let folded = self.fold(
                            source_id,
                            outcome,
                            &own(part),
                            mask,
                            vulnerable,
                            None,
                            joined,
                        )?;
                        return Ok(vec![self.drawn(
                            source_id,
                            mask,
                            outcome,
                            (matched, spends),
                            None,
                            folded,
                        )]);
                    }
                    let whole = own(part);
                    let (dealt, none) = whole.split_by_dealt();
                    // A part that is all of it stays the very PMF.
                    let pieces: Vec<(Arc<Pmf>, bool)> = if none.mass() <= 0.0 {
                        vec![(whole, true)]
                    } else if dealt.mass() <= 0.0 {
                        vec![(whole, false)]
                    } else {
                        vec![(Arc::new(dealt), true), (Arc::new(none), false)]
                    };
                    let mut draws = Vec::with_capacity(pieces.len());
                    for (piece, is_dealt) in pieces {
                        let folded = self.fold(
                            source_id,
                            outcome,
                            &piece,
                            mask,
                            vulnerable,
                            Some(is_dealt),
                            joined,
                        )?;
                        let mut draw = self.drawn(
                            source_id,
                            mask,
                            outcome,
                            (matched, spends),
                            Some(is_dealt),
                            folded,
                        );
                        draw.by_kind = Some(if is_dealt {
                            dealt_by_kind(crit)
                        } else {
                            not_dealt_by_kind(crit)
                        });
                        draws.push(draw);
                    }
                    Ok(draws)
                };
                let draw = |part: &Arc<Pmf>, matched: bool, spends: bool| {
                    let plain = plain_draw(part, matched, spends)?;
                    if dealing {
                        self.typed_split(source_id, outcome, &plain, row_context)
                    } else {
                        Ok(plain)
                    }
                };
                let matched_split = |part: &Pmf, info: &crate::common::DiceMatchInfo| {
                    part.split_by_factor(|damage| {
                        info.match_probability_by_damage
                            .get(&Damage(damage))
                            .copied()
                            .unwrap_or(0.0)
                    })
                };
                // `part`'s draws: split by match odds on its value, unless its dice's match status is `known`.
                // A part that is already shared (`draws_of_shared`) stays the very PMF in its draws, as
                // TS hands the same object to every variant that draws it (the readers key tallies by it).
                let draws_of_shared = |part: &Arc<Pmf>,
                                       spends: bool,
                                       known: Option<bool>|
                 -> Result<Vec<Draw>, DiceError> {
                    let Some(info) = info.filter(|_| known.is_none()) else {
                        return draw(part, known.unwrap_or(false), spends);
                    };
                    let (matched, unmatched) = matched_split(part, info);
                    let mut draws = draw(&Arc::new(matched), true, spends)?;
                    draws.extend(draw(&Arc::new(unmatched), false, spends)?);
                    Ok(draws)
                };
                let draws_of = |part: &Pmf,
                                spends: bool,
                                known: Option<bool>|
                 -> Result<Vec<Draw>, DiceError> {
                    draws_of_shared(&Arc::new(part.clone()), spends, known)
                };

                // A converted miss: the miss mass drawn as this row's hit damage, and it spends.
                let miss_mass = if convert && outcome == StepOutcome::Hit {
                    slices.miss.mass()
                } else {
                    0.0
                };
                if miss_mass > 0.0 {
                    let hit = if mass > 0.0 {
                        base.scale_mass(1.0 / mass)
                    } else {
                        self.converted_hit(source_id, payload.as_ref(), row_context)?
                    };
                    fixed.extend(draws_of(&hit.scale_mass(miss_mass), true, None)?);
                }
                let Some(policy) = (if mass <= 0.0 { None } else { policy }) else {
                    fixed.extend(draws_of_shared(&base, false, None)?);
                    continue;
                };
                let threshold = if let SubstitutePolicy::Below { hit, crit: c } = policy {
                    if crit { c } else { hit }
                } else {
                    let Some(rerolled) = &rerolled else {
                        fixed.extend(draws_of(&base.max_of_two(), true, None)?);
                        continue;
                    };
                    // The d20 stands as the row rolled it: the reroll's own outcome odds are normalised away.
                    let alternative = rerolled.filter_outcome_shared(label);
                    let alternative_mass = alternative.mass();
                    if alternative_mass <= 0.0 {
                        return Err(fail(
                            TurnSpecErrorCode::NotAnAttack,
                            source_id,
                            format!(
                                "\"{source_id}\" can land as a {label}, but its rerolledUnder() has no {label} outcome."
                            ),
                        ));
                    }
                    fixed.extend(draws_of(
                        &alternative
                            .scale_mass(1.0 / alternative_mass)
                            .scale_mass(mass),
                        true,
                        None,
                    )?);
                    continue;
                };
                // The threshold reads the base payload total as it stands (dice plus the
                // payload's own flat bonus), so each mode splits on its own values.
                let (below, above) =
                    base.split_by_factor(|value| if value < threshold { 1.0 } else { 0.0 });
                if below.mass() > 0.0 {
                    let (kept, beaten) = keep_better_of_fresh(&below, &base);
                    fixed.extend(draws_of(&kept.add(&beaten), true, None)?);
                }
                // Holding keeps these very dice, so with match odds in play their match
                // status is part of what a later step can still do with them.
                let held_parts: Vec<(bool, Pmf)> = match info {
                    Some(info) => {
                        let (matched, unmatched) = matched_split(&above, info);
                        vec![(true, matched), (false, unmatched)]
                    }
                    None => vec![(false, above)],
                };
                for (matched, part) in held_parts {
                    if part.mass() <= 0.0 {
                        continue;
                    }
                    let (kept, beaten) = keep_better_of_fresh(&part, &base);
                    let hold = draws_of(&part, false, Some(matched))?;
                    let spend = if info.is_some() {
                        let mut spend = draws_of(&kept, true, Some(matched))?;
                        spend.extend(draws_of(&beaten, true, None)?);
                        spend
                    } else {
                        draws_of(&kept.add(&beaten), true, Some(false))?
                    };
                    choices.push(HoldChoice {
                        outcome,
                        matched,
                        hold,
                        spend,
                    });
                }
            }
        }
        for (index, (slot, from_fixed, from_choices)) in spans.iter().enumerate() {
            let Some(slot) = slot else { continue };
            let next = spans.get(index + 1);
            let to_fixed = next.map_or(fixed.len(), |n| n.1);
            let to_choices = next.map_or(choices.len(), |n| n.2);
            for draw in fixed.iter_mut().take(to_fixed).skip(*from_fixed) {
                draw.reroll_slot = Some(*slot);
            }
            for choice in choices.iter_mut().take(to_choices).skip(*from_choices) {
                for draw in choice.hold.iter_mut().chain(choice.spend.iter_mut()) {
                    draw.reroll_slot = Some(*slot);
                }
            }
        }
        // A converted miss is the miss mass drawn as the row's hit (above); otherwise a miss lands the
        // riders that land on anything, and the rest it lands nothing. A rerolled miss is the reroll's.
        if convert {
            return Ok((fixed, choices));
        }
        let miss_slice = match reroll {
            None => slices.miss.clone(),
            Some(reroll) => reroll.slices.miss.clone(),
        };
        let marked = |mut draw: Draw| {
            if let Some(reroll) = reroll {
                draw.reroll_slot = Some(reroll.slot);
            }
            draw
        };
        if self
            .payloads_of(source_id)
            .iter()
            .any(|payload| payload.landing == Some(RiderLanding::Any) && !payload.crit_only)
        {
            let folded = self.fold(
                source_id,
                StepOutcome::Miss,
                &miss_slice,
                mask,
                false,
                None,
                joined,
            )?;
            fixed.push(marked(self.drawn(
                source_id,
                mask,
                StepOutcome::Miss,
                (false, false),
                None,
                folded,
            )));
        } else {
            fixed.push(marked(Draw::plain(
                StepOutcome::Miss,
                false,
                false,
                miss_slice,
            )));
        }
        Ok((fixed, choices))
    }
}
