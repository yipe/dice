//! Replays fixtures/recorded-gaps.jsonl (calls captured from the TypeScript test suite) and
//! fixtures/synthetic-gaps.jsonl: the PMF/DiceQuery methods the first recording missed.
//! Ops are `DiceQuery.<method>` or a bare PMF method name.
//! `cargo test --release --test recorded_gaps -- --nocapture` prints a per-op table.

mod common;

use common::*;
use indexmap::IndexMap;
use serde_json::{Value, json};
use yipe_dice::pmf::{ChartModelOptions, DamageAttributionChartModel};
use yipe_dice::query::DiceQuery;
use yipe_dice::{EPS, Pmf};

fn decode_query(v: &Value) -> Option<DiceQuery> {
    let q = v.get("$query")?;
    let singles = q
        .get("singles")?
        .as_array()?
        .iter()
        .map(decode_pmf)
        .collect::<Option<Vec<_>>>()?;
    let eps = q.get("eps").and_then(decode_num).unwrap_or(EPS);
    let combined = match q.get("combined") {
        None => None,
        Some(c) => Some(decode_pmf(c)?),
    };
    Some(DiceQuery::new(singles, combined, eps))
}

fn enc_query(q: &DiceQuery) -> Value {
    let mut o = json!({
        "singles": q.singles.iter().cloned().map(enc_pmf).collect::<Vec<_>>(),
        "eps": enc_num(q.eps),
    });
    if let Some(c) = q.combined_provided() {
        o["combined"] = enc_pmf(c.clone());
    }
    json!({ "$query": o })
}

/// `undefined` or a missing argument is `Some(None)`; a string list is `Some(Some(list))`.
fn decode_strings(v: Option<&Value>) -> Option<Option<Vec<String>>> {
    match v {
        None => Some(None),
        Some(v) if v.get("$undefined").is_some() => Some(None),
        Some(v) => Some(Some(
            v.as_array()?
                .iter()
                .map(|x| x.as_str().map(str::to_string))
                .collect::<Option<_>>()?,
        )),
    }
}

fn enc_map<V>(m: IndexMap<String, V>, f: impl Fn(V) -> Value) -> Value {
    json!({ "$map": m.into_iter().map(|(k, v)| json!([k, f(v)])).collect::<Vec<_>>() })
}

fn enc_nums(v: Vec<f64>) -> Value {
    Value::Array(v.into_iter().map(enc_num).collect())
}

fn enc_by_value(m: IndexMap<String, IndexMap<yipe_dice::Damage, f64>>) -> Value {
    enc_map(
        m,
        |series| json!({ "$map": series.into_iter().map(|(d, v)| json!([enc_num(d.0), enc_num(v)])).collect::<Vec<_>>() }),
    )
}

/// The recorder's JSON of the model: an undefined `binRanges` is `{"$undefined": true}`, except in
/// the empty model, which has no such key.
fn enc_model(m: DamageAttributionChartModel) -> Value {
    let undefined_ranges = !m.labels.is_empty();
    let mut o = json!({ "labels": enc_nums(m.labels) });
    if m.bin_ranges.is_none() && undefined_ranges {
        o["binRanges"] = json!({ "$undefined": true });
    }
    if let Some(r) = m.bin_ranges {
        o["binRanges"] = Value::Array(
            r.into_iter()
                .map(|b| json!({ "start": enc_num(b.start), "end": enc_num(b.end) }))
                .collect(),
        );
    }
    o["outcomes"] = json!(m.outcomes);
    o["series"] = enc_map(m.series, enc_nums);
    o["shares"] = enc_map(m.shares, enc_nums);
    o["totals"] = enc_nums(m.totals);
    o["percentiles"] = json!({ "p80": enc_num(m.percentiles.p80), "p50": enc_num(m.percentiles.p50), "p20": enc_num(m.percentiles.p20) });
    o["mean"] = enc_num(m.mean);
    o
}

fn chart_options(v: Option<&Value>) -> Option<ChartModelOptions> {
    let Some(o) = v.filter(|v| v.get("$undefined").is_none()) else {
        return Some(ChartModelOptions::default());
    };
    let num = |k: &str| match o.get(k) {
        None => Some(None),
        Some(v) if v.get("$undefined").is_some() => Some(None),
        Some(v) => decode_num(v).map(Some),
    };
    Some(ChartModelOptions {
        max_buckets: num("maxBuckets")?,
        stack_order: decode_strings(o.get("stackOrder"))?,
        epsilon: num("epsilon")?,
    })
}

fn run(op: &str, a: Option<&Value>, args: &[Value]) -> Option<Value> {
    let num = |i: usize| args.get(i).and_then(decode_num);
    let opt_num = |i: usize| {
        if is_absent(args.get(i)) {
            Some(None)
        } else {
            num(i).map(Some)
        }
    };
    if op == "firstSuccessWeights" {
        return Some(
            match Pmf::first_success_weights(num(0)?, num(1)?, num(2)?) {
                Ok(w) => json!({
                    "pSpecificSuccess": enc_num(w.p_specific_success),
                    "pGeneralSuccess": enc_num(w.p_general_success),
                    "pNone": enc_num(w.p_none),
                    "pAny": enc_num(w.p_any),
                }),
                Err(e) => json!({ "$error": e.to_string() }),
            },
        );
    }
    if matches!(op, "attributionByValue" | "damageAttributionChartModel") {
        let pmf = a.and_then(decode_pmf)?;
        return Some(if op == "attributionByValue" {
            enc_by_value(pmf.attribution_by_value())
        } else {
            match pmf.damage_attribution_chart_model(&chart_options(args.first())?) {
                Ok(m) => enc_model(m),
                Err(e) => json!({ "$error": e.to_string() }),
            }
        });
    }
    let q = a.and_then(decode_query)?;
    let outcomes = |i: usize| decode_strings(args.get(i));
    Some(match op.strip_prefix("DiceQuery.")? {
        "attributionByValue" => enc_by_value(q.attribution_by_value()),
        "toLabeledTable" => {
            let labels = outcomes(0)?.unwrap_or_default();
            Value::Array(q.to_labeled_table(&labels).iter().map(labels_obj).collect())
        }
        "toStackedChartData" => {
            let labels = outcomes(0)?.unwrap_or_default();
            let d = q.to_stacked_chart_data(&labels, opt_num(1)?.unwrap_or(EPS));
            json!({
                "labels": enc_nums(d.labels),
                "datasets": d.datasets.into_iter().map(|s| json!({ "label": s.label, "data": enc_nums(s.data) })).collect::<Vec<_>>(),
            })
        }
        "outcomeTotals" => enc_map(q.outcome_totals(outcomes(0)?.as_deref()), enc_num),
        "outcomeDamageRanges" => enc_map(
            q.outcome_damage_ranges(outcomes(0)?.as_deref()),
            |r| json!({ "min": enc_num(r.min), "avg": enc_num(r.avg), "max": enc_num(r.max) }),
        ),
        "outcomeStats" => match q.outcome_stats(outcomes(0)?.as_deref()) {
            Ok(m) => enc_map(m, |s| {
                json!({
                    "atLeastOneProbability": enc_num(s.at_least_one_probability),
                    "allProbability": enc_num(s.all_probability),
                    "damageRange": { "min": enc_num(s.damage_min), "avg": enc_num(s.damage_avg), "max": enc_num(s.damage_max) },
                })
            }),
            Err(e) => json!({ "$error": e.to_string() }),
        },
        "scaleDamage" => {
            let rounding = if is_absent(args.get(1)) {
                "floor"
            } else {
                args.get(1)?.as_str()?
            };
            match q.scale_damage(num(0)?, rounding, opt_num(2)?.unwrap_or(1.0)) {
                Ok(r) => enc_query(&r),
                Err(e) => json!({ "$error": e.to_string() }),
            }
        }
        _ => return None,
    })
}

fn labels_obj(row: &yipe_dice::LabelMap) -> Value {
    labels(row)
}

#[test]
fn recorded_gaps() {
    replay("recorded-gaps.jsonl", run);
}

#[test]
fn synthetic_gaps() {
    replay("synthetic-gaps.jsonl", run);
}
