//! `dumpPlan` of `dump.gen.ts.txt`: a [`TurnPlan`] as the normalized JSON the TypeScript side
//! writes to `plans.json`. The format and the probe grid are specified at the top of the `.txt`.

use crate::Pmf;
use crate::error::DiceError;
use crate::turn::context::RowContext;
use crate::turn::plan::{
    Draw, EffectSource, Fire, FireMode, Gate, GateReads, Step, Tried, TurnPlan,
};
use crate::turn::state::{StepOutcome, advance};
use crate::turn::types::{SaveLanding, SubstitutePolicy};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

/// How many probes a step gets at most.
const MAX_PROBES: usize = 400;

/// A number as the TS dump writes it: non-finite values are strings.
pub fn num(x: f64) -> Value {
    if x.is_finite() {
        serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
    } else if x.is_nan() {
        json!("NaN")
    } else if x > 0.0 {
        json!("Infinity")
    } else {
        json!("-Infinity")
    }
}

/// An optional slot / index as the TS sentinel: `None` is -1.
fn slot(value: Option<usize>) -> Value {
    json!(value.map_or(-1i64, |v| v as i64))
}

fn nums(values: &[f64]) -> Value {
    Value::Array(values.iter().map(|v| num(*v)).collect())
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().map(|v| json!(v)).collect())
}

fn usizes(values: &[usize]) -> Value {
    Value::Array(values.iter().map(|v| json!(v)).collect())
}

fn outcome(o: StepOutcome) -> &'static str {
    match o {
        StepOutcome::Hit => "hit",
        StepOutcome::Crit => "crit",
        StepOutcome::Miss => "miss",
        StepOutcome::None => "none",
    }
}

fn landing(l: Option<SaveLanding>) -> Value {
    l.map_or(Value::Null, |l| json!(l.as_str()))
}

fn error_text(e: &DiceError) -> Value {
    json!(format!("error: {}", e.message()))
}

/// `{ mass, bins: [[value, p], ...] }` sorted by value.
pub fn pmf_dump(pmf: &Pmf) -> Value {
    let mut bins = pmf.bins();
    bins.sort_by(|a, b| a.0.0.total_cmp(&b.0.0));
    json!({
        "mass": num(pmf.mass()),
        "bins": bins.iter().map(|(v, bin)| json!([num(v.0), num(bin.p)])).collect::<Vec<_>>(),
    })
}

/// One draw: every `Draw` field.
pub fn draw_dump(d: &Draw) -> Value {
    json!({
        "outcome": outcome(d.outcome),
        "matched": d.matched,
        "spends": d.spends,
        "rerollSlot": slot(d.reroll_slot),
        "applies": usizes(&d.applies),
        "bumps": usizes(&d.bumps),
        "fires": usizes(&d.fires),
        "slice": pmf_dump(&d.slice),
        "byKind": d.by_kind.map_or(Value::Null, |k| json!({
            "fail": outcome(k.fail),
            "damage": outcome(k.damage),
        })),
        "own": d.own.as_ref().map_or(Value::Null, |p| pmf_dump(p)),
        "riders": d.riders.as_ref().map_or(Value::Null, |riders| Value::Array(
            riders.iter().map(|(id, p)| json!([id, pmf_dump(p)])).collect()
        )),
        "wounded": d.wounded,
        "typed": d.typed,
    })
}

fn row_context_dump(c: &Option<RowContext>) -> Value {
    let Some(c) = c else { return Value::Null };
    json!({
        "rollType": c.roll_type.as_str(),
        "autoHit": c.auto_hit,
        "critOnHit": c.crit_on_hit,
        "autoFail": c.auto_fail,
        "vulnerable": c.vulnerable,
        "penaltyDice": c.penalty_dice.iter()
            .map(|d| json!({ "count": num(d.count), "sides": num(d.sides) })).collect::<Vec<_>>(),
        "joined": strings(&c.joined),
    })
}

fn single_bits(mask: u32) -> Vec<u32> {
    (0..32)
        .filter(|k| (mask >> k) & 1 == 1)
        .map(|k| 1u32 << k)
        .collect()
}

fn unique<T: PartialEq + Copy>(values: Vec<T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

fn gate_dump(gate: &Option<Gate>) -> Value {
    match gate {
        None => Value::Null,
        Some(Gate::Fired { slot }) => json!({ "kind": "fired", "slot": slot }),
        Some(Gate::Group { slot, reads }) => json!({
            "kind": "group",
            "slot": slot,
            "reads": match reads {
                GateReads::First => "first",
                GateReads::Any => "any",
                GateReads::Crit => "crit",
                GateReads::Miss => "miss",
                GateReads::Match => "match",
            },
        }),
    }
}

fn policy_dump(policy: &Option<SubstitutePolicy>) -> Value {
    match policy {
        None => Value::Null,
        Some(SubstitutePolicy::Always) => json!({ "kind": "always" }),
        Some(SubstitutePolicy::Optimal) => json!({ "kind": "optimal" }),
        Some(SubstitutePolicy::Below { hit, crit }) => {
            json!({ "kind": "below", "hit": num(*hit), "crit": num(*crit) })
        }
    }
}

fn grant_dump(g: &crate::turn::plan::GrantApplication, live_bits: u32) -> Value {
    let chance_of = g.chance_of.as_ref().map_or(Value::Null, |f| {
        let mut flags = vec![0u32];
        flags.extend(single_bits(live_bits));
        flags.push(live_bits);
        let at: Vec<Value> = unique(flags)
            .into_iter()
            .map(|flags| {
                let value = match f(flags) {
                    Ok(v) => num(v),
                    Err(e) => error_text(&e),
                };
                json!([flags, value])
            })
            .collect();
        json!({ "at": at })
    });
    json!({
        "condition": g.condition,
        "on": g.on.as_str(),
        "reads": slot(g.reads),
        "landing": landing(g.landing),
        "chance": num(g.chance),
        "chanceOf": chance_of,
        "grants": g.grants,
        "onSave": g.on_save,
        "inForce": g.in_force,
        "effective": g.effective,
        "tried": match g.tried {
            Tried::Group => 0i64,
            Tried::Never => -1,
            Tried::Bit(bit) => i64::from(bit),
        },
        "rider": g.rider,
        "dealing": g.dealing,
        "counted": g.counted,
        "countedInForce": g.counted_in_force,
        "countOnly": g.count_only,
        "gateMask": g.gate_mask,
    })
}

/// One state a step is probed in.
struct Probe {
    codes: Vec<u32>,
    fired: Vec<FireMode>,
    flags: u32,
    counts: Vec<u32>,
}

/// The probes of `step`: the PROBE GRID of `dump.gen.ts.txt`.
fn probes_of(plan: &TurnPlan, step: &Step) -> Vec<Probe> {
    let groups = plan.group_count;
    let slots = plan.slot_count;
    let counters = plan.counter_max.len();
    let hit = advance(0, StepOutcome::Hit, false);
    let crit = advance(0, StepOutcome::Crit, false);
    let miss = advance(0, StepOutcome::Miss, false);
    let states = [
        hit,
        crit,
        miss,
        advance(hit, StepOutcome::Miss, false),
        advance(0, StepOutcome::Hit, true),
        advance(0, StepOutcome::Crit, true),
    ];
    let mut codes_list: Vec<Vec<u32>> = vec![vec![0; groups]];
    for g in 0..groups {
        for v in states {
            let mut codes = vec![0u32; groups];
            codes[g] = v;
            codes_list.push(codes);
        }
    }
    let mut fired_list: Vec<Vec<FireMode>> = vec![vec![None; slots]];
    for s in 0..slots {
        let mut fired: Vec<FireMode> = vec![None; slots];
        fired[s] = Some(Fire::Hit);
        fired_list.push(fired);
    }
    let mut mask = 0u32;
    for f in &plan.flag_live_after {
        mask |= f;
    }
    mask |= step.consumes
        | step.hit_consumes
        | step.read_advantage
        | step.read_disadvantage
        | step.read_crit_on_hit;
    for read in &step.flag_reads {
        if read.bit >= 0 {
            mask |= 1u32.wrapping_shl(read.bit as u32);
        }
    }
    for coin in &plan.coins {
        mask |= coin.bit;
    }
    mask |= plan.start_flags;
    let mut flags_list = vec![0u32];
    flags_list.extend(single_bits(mask));
    flags_list.push(mask);
    let flags_list = unique(flags_list);
    let cap = |c: usize| -> u32 {
        let max = plan.counter_max[c];
        if max.is_finite() {
            max as u32
        } else {
            1_000_000
        }
    };
    let mut counts_list: Vec<Vec<u32>> = vec![vec![0; counters]];
    for c in 0..counters {
        let mut counts = vec![0u32; counters];
        counts[c] = cap(c);
        counts_list.push(counts);
    }
    counts_list.push((0..counters).map(cap).collect());

    let mut seen: HashSet<String> = HashSet::new();
    let mut probes: Vec<Probe> = Vec::new();
    let mut push =
        |codes: &Vec<u32>, fired: &Vec<FireMode>, flags: u32, counts: &Vec<u32>| -> bool {
            if probes.len() >= MAX_PROBES {
                return false;
            }
            let key = format!("{codes:?}|{fired:?}|{flags}|{counts:?}");
            if seen.insert(key) {
                probes.push(Probe {
                    codes: codes.clone(),
                    fired: fired.clone(),
                    flags,
                    counts: counts.clone(),
                });
            }
            true
        };
    for codes in &codes_list {
        push(codes, &fired_list[0], flags_list[0], &counts_list[0]);
    }
    for fired in &fired_list {
        push(&codes_list[0], fired, flags_list[0], &counts_list[0]);
    }
    for flags in &flags_list {
        push(&codes_list[0], &fired_list[0], *flags, &counts_list[0]);
    }
    for counts in &counts_list {
        push(&codes_list[0], &fired_list[0], flags_list[0], counts);
    }
    'cross: for codes in &codes_list {
        for fired in &fired_list {
            for flags in &flags_list {
                for counts in &counts_list {
                    if !push(codes, fired, *flags, counts) {
                        break 'cross;
                    }
                }
            }
        }
    }
    probes
}

fn index_dump(result: Result<usize, DiceError>) -> Value {
    match result {
        Ok(i) => json!(i),
        Err(e) => error_text(&e),
    }
}

fn step_dump(plan: &TurnPlan, step: &Step, live_bits: u32) -> Value {
    let probes: Vec<Value> = probes_of(plan, step)
        .into_iter()
        .map(|p| {
            let select = index_dump((step.select)(&p.codes, &p.fired, p.flags, &p.counts));
            let context = index_dump((step.context_index_of)(
                &p.codes, &p.fired, p.flags, &p.counts,
            ));
            json!({
                "codes": p.codes,
                "fired": p.fired.iter().map(|f| match f {
                    None => Value::Null,
                    Some(Fire::Hit) => json!("hit"),
                    Some(Fire::Crit) => json!("crit"),
                }).collect::<Vec<_>>(),
                "flags": p.flags,
                "counts": p.counts,
                "select": select,
                "contextIndex": context,
            })
        })
        .collect();
    let variants: Vec<Value> = (0..step.variants.len())
        .map(|i| {
            step.variants.get(i).map_or(Value::Null, |v| {
                Value::Array(v.iter().map(draw_dump).collect())
            })
        })
        .collect();
    let context_pmfs: Vec<Value> = (0..step.context_pmfs.len())
        .map(|i| {
            step.context_pmfs
                .get(i)
                .map_or(Value::Null, |p| pmf_dump(&p))
        })
        .collect();
    let mut m = Map::new();
    let mut put = |k: &str, v: Value| {
        m.insert(k.to_string(), v);
    };
    put("id", json!(step.id));
    put(
        "trigger",
        step.trigger.as_ref().map_or(Value::Null, |t| json!(t.on())),
    );
    put("probes", Value::Array(probes));
    put("variants", Value::Array(variants));
    put(
        "damage",
        step.damage.as_ref().map_or(
            Value::Null,
            |d| json!({ "hit": pmf_dump(&d.hit), "crit": pmf_dump(&d.crit) }),
        ),
    );
    put("updates", usizes(&step.updates));
    put(
        "updateKinds",
        Value::Array(step.update_kinds.iter().map(|k| landing(*k)).collect()),
    );
    put("settled", nums(&step.settled));
    put("releases", usizes(&step.releases));
    put("reads", slot(step.reads));
    put("slot", slot(step.slot));
    put("negates", slot(step.negates));
    put("spendSlot", slot(step.spend_slot));
    put("consumes", json!(step.consumes));
    put("hitConsumes", json!(step.hit_consumes));
    put("wounds", json!(step.wounds));
    put("gate", gate_dump(&step.gate));
    put(
        "grants",
        Value::Array(
            step.grants
                .iter()
                .map(|g| grant_dump(g, live_bits))
                .collect(),
        ),
    );
    put("readAdvantage", json!(step.read_advantage));
    put("readDisadvantage", json!(step.read_disadvantage));
    put("readCritOnHit", json!(step.read_crit_on_hit));
    put(
        "flagReads",
        Value::Array(
            step.flag_reads
                .iter()
                .map(|r| {
                    json!({
                        "bit": r.bit,
                        "modifiers": r.modifiers,
                        "penalty": r.penalty,
                        "source": r.source,
                    })
                })
                .collect(),
        ),
    );
    put("contextPmfs", Value::Array(context_pmfs));
    put(
        "contextRollTypes",
        Value::Array(
            step.context_roll_types
                .iter()
                .map(|t| json!(t.as_str()))
                .collect(),
        ),
    );
    put("contextVulnerable", json!(step.context_vulnerable));
    put(
        "contextRowContexts",
        Value::Array(
            step.context_row_contexts
                .iter()
                .map(row_context_dump)
                .collect(),
        ),
    );
    put(
        "rerolls",
        Value::Array(
            step.rerolls
                .iter()
                .map(|r| {
                    json!({
                        "slot": r.slot,
                        "mode": r.mode.as_str(),
                    })
                })
                .collect(),
        ),
    );
    put("policy", policy_dump(&step.policy));
    put("transformed", json!(step.transformed));
    put("converts", json!(step.converts));
    put("chance", num(step.chance));
    Value::Object(m)
}

/// `dumpPlan(plan)`: the whole plan; probes every step (which builds the lazy tables they reach).
pub fn dump_plan(plan: &TurnPlan) -> Value {
    let live_bits = plan.flag_live_after.iter().fold(0u32, |a, b| a | b);
    let pairs_usize = |m: &indexmap::IndexMap<String, usize>| -> Value {
        Value::Array(m.iter().map(|(k, v)| json!([k, v])).collect())
    };
    let mut m = Map::new();
    let mut put = |k: &str, v: Value| {
        m.insert(k.to_string(), v);
    };
    put(
        "effectSources",
        Value::Array(
            plan.effect_sources
                .iter()
                .map(|s| match s {
                    EffectSource::Starting => json!({ "kind": "starting" }),
                    EffectSource::Grant(g) => json!({ "kind": "grant", "grant": g }),
                })
                .collect(),
        ),
    );
    put("optionalIds", strings(&plan.optional_ids));
    put("groupCount", json!(plan.group_count));
    put(
        "attackPMFs",
        Value::Array(plan.attack_pmfs.iter().map(|p| pmf_dump(p)).collect()),
    );
    put(
        "attackSingles",
        Value::Array(plan.attack_singles.iter().map(|p| pmf_dump(p)).collect()),
    );
    put("attackIds", strings(&plan.attack_ids));
    put("riderIds", strings(&plan.rider_ids));
    put("substituteIds", strings(&plan.substitute_ids));
    put("probeIds", strings(&plan.probe_ids));
    put("rerollIds", strings(&plan.reroll_ids));
    put("fireSlots", pairs_usize(&plan.fire_slots));
    put("slotCount", json!(plan.slot_count));
    put("perHitGroups", pairs_usize(&plan.per_hit_groups));
    put(
        "perHitCritOnly",
        Value::Array(plan.per_hit_crit_only.iter().map(|s| json!(s)).collect()),
    );
    put(
        "perHitAny",
        Value::Array(plan.per_hit_any.iter().map(|s| json!(s)).collect()),
    );
    put(
        "riderRows",
        Value::Array(
            plan.rider_rows
                .iter()
                .map(|(k, v)| json!([k, strings(v)]))
                .collect(),
        ),
    );
    put(
        "probes",
        Value::Array(
            plan.probes
                .iter()
                .map(|(k, v)| json!([k, slot(*v)]))
                .collect(),
        ),
    );
    put("everyHitIds", strings(&plan.every_hit_ids));
    put("counterMax", nums(&plan.counter_max));
    put("groupLastReadStep", json!(plan.group_last_read_step));
    put("conditionIds", strings(&plan.condition_ids));
    put("flagLiveAfter", json!(plan.flag_live_after));
    put(
        "coins",
        Value::Array(
            plan.coins
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "bit": c.bit,
                        "happens": num(c.happens),
                    })
                })
                .collect(),
        ),
    );
    put("startFlags", json!(plan.start_flags));
    put("startConditions", usizes(&plan.start_conditions));
    put("stateLimit", num(plan.state_limit));
    put("dealing", json!(plan.dealing));
    put("meleeLeaning", json!(plan.melee_leaning));
    put(
        "sourceOf",
        Value::Array(plan.source_of.keys().map(|k| json!(k)).collect()),
    );
    put(
        "riderOf",
        Value::Array(plan.rider_of.keys().map(|k| json!(k)).collect()),
    );
    put(
        "payloadAt",
        Value::Array(plan.payload_at.keys().map(|k| json!(k)).collect()),
    );
    put(
        "steps",
        Value::Array(
            plan.steps
                .iter()
                .map(|s| step_dump(plan, s, live_bits))
                .collect(),
        ),
    );
    Value::Object(m)
}

/// `{ error: { class, code, id, message } }` of a failed build.
pub fn error_dump(error: &DiceError) -> Value {
    let (code, id) = match error {
        DiceError::TurnSpec(e) => (json!(e.code.as_str()), json!(e.id)),
        _ => (Value::Null, Value::Null),
    };
    json!({ "error": {
        "class": error.name(),
        "code": code,
        "id": id,
        "message": error.message(),
    } })
}
