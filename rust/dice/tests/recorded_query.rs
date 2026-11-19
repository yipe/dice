//! Replays fixtures/recorded-query.jsonl: real `DiceQuery` calls captured while the TypeScript test
//! suite ran (fixtures/record-pmf.ts). Ops are named `DiceQuery.<method>`.
//! `cargo test --release --test recorded_query -- --nocapture` prints a per-op table.

mod common;

use common::*;
use serde_json::{Value, json};
use yipe_dice::DiceError;
use yipe_dice::EPS;
use yipe_dice::query::{DamageStats, DiceQuery, Labels};

/// `{"$query": {singles, eps, combined?}}` -> `new DiceQuery(singles, combined, eps)`.
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

fn decode_labels(v: &Value) -> Option<Labels> {
    match v {
        Value::String(s) => Some(Labels::One(s.clone())),
        Value::Array(a) => Some(Labels::Many(
            a.iter()
                .map(|x| x.as_str().map(str::to_string))
                .collect::<Option<_>>()?,
        )),
        _ => None,
    }
}

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

fn enc_f64_result(r: Result<f64, DiceError>) -> Value {
    match r {
        Ok(x) => enc_num(x),
        Err(e) => json!({ "$error": e.to_string() }),
    }
}

fn enc_stats(s: DamageStats) -> Value {
    json!({ "min": enc_num(s.min), "max": enc_num(s.max), "avg": enc_num(s.avg), "count": enc_num(s.count) })
}

fn run(op: &str, a: Option<&Value>, args: &[Value]) -> Option<Value> {
    let q = a.and_then(decode_query)?;
    let num = |i: usize| args.get(i).and_then(decode_num);
    let labels = |i: usize| args.get(i).and_then(decode_labels);
    let string = |i: usize| args.get(i).and_then(Value::as_str);
    let flag = |i: usize, default: bool| {
        if is_absent(args.get(i)) {
            Some(default)
        } else {
            args.get(i)?.as_bool()
        }
    };
    let opt_num = |i: usize| {
        if is_absent(args.get(i)) {
            Some(None)
        } else {
            num(i).map(Some)
        }
    };
    let method = op.strip_prefix("DiceQuery.")?;
    Some(match method {
        "combinedWithAttribution" => enc_pmf(q.combined_with_attribution()),
        "attributionByValue" => {
            json!({ "$map": q.attribution_by_value().into_iter().map(|(label, m)| {
            json!([label, { "$map": m.into_iter().map(|(d, v)| json!([enc_num(d.0), enc_num(v)])).collect::<Vec<_>>() }])
        }).collect::<Vec<_>>() })
        }
        "countSinglesWith" => enc_num(q.count_singles_with(string(0)?)),
        "mean" => enc_num(q.mean()),
        "variance" => enc_num(q.variance()),
        "stddev" => enc_num(q.stddev()),
        "stdev" => enc_num(q.stdev()),
        "cdf" => enc_num(q.cdf(num(0)?)),
        "probTotalAtMost" => enc_num(q.prob_total_at_most(num(0)?)),
        "ccdf" => enc_num(q.ccdf(num(0)?)),
        "probTotalAtLeast" => enc_num(q.prob_total_at_least(num(0)?)),
        "percentiles" => {
            let ps = args
                .first()?
                .as_array()?
                .iter()
                .map(decode_num)
                .collect::<Option<Vec<_>>>()?;
            Value::Array(q.percentiles(&ps).into_iter().map(enc_num).collect())
        }
        "min" => enc_num(q.min()),
        "max" => enc_num(q.max()),
        "missChance" => enc_num(q.miss_chance()),
        "probDamageGreaterThan" => enc_num(q.prob_damage_greater_than(opt_num(0)?.unwrap_or(0.0))),
        "totalMass" => enc_num(q.total_mass()),
        "probAtLeastK" => enc_num(q.prob_at_least_k(&labels(0)?, num(1)?)),
        "probAtLeastOne" => enc_num(q.prob_at_least_one(&labels(0)?)),
        "probExactlyK" => enc_f64_result(q.prob_exactly_k(&labels(0)?, num(1)?)),
        "probAtMostK" => enc_f64_result(q.prob_at_most_k(&labels(0)?, num(1)?)),
        "expectedDamageFrom" => enc_num(q.expected_damage_from(&labels(0)?)),
        "damageStatsFrom" => enc_stats(q.damage_stats_from(&labels(0)?)),
        "combinedDamageStats" => enc_stats(q.combined_damage_stats(string(0)?)),
        "probabilityOf" => enc_num(q.probability_of(&labels(0)?)),
        "firstSuccessSplit" => {
            match q.first_success_split(&labels(0)?, &labels(1)?, opt_num(2)?.unwrap_or(EPS)) {
                Ok(v) => Value::Array(v.into_iter().map(enc_num).collect()),
                Err(e) => json!({ "$error": e.to_string() }),
            }
        }
        "toChartSeries" => Value::Array(
            q.to_chart_series()
                .into_iter()
                .map(|(x, y)| json!({ "x": enc_num(x), "y": enc_num(y) }))
                .collect(),
        ),
        "toCDFSeries" | "toCCDFSeries" => {
            let s = if method == "toCDFSeries" {
                q.to_cdf_series(flag(0, true)?)
            } else {
                q.to_ccdf_series(flag(0, true)?)
            };
            json!({ "support": s.support.into_iter().map(enc_num).collect::<Vec<_>>(), "data": s.data.into_iter().map(enc_num).collect::<Vec<_>>() })
        }
        "outcomeKeys" => json!(q.outcome_keys(decode_strings(args.first())?.as_deref())),
        "snapshot" => {
            let s = q.snapshot(decode_strings(args.first())?.as_deref());
            json!({
                "averageDPR": enc_num(s.average_dpr),
                "damageChance": enc_num(s.damage_chance),
                "percentiles": { "p25": enc_num(s.p25), "p50": enc_num(s.p50), "p75": enc_num(s.p75) },
                "outcomes": { "$map": s.outcomes.into_iter().map(|(k, o)| json!([k, {
                    "atLeastOneProbability": enc_num(o.at_least_one_probability),
                    "allProbability": enc_num(o.all_probability),
                    "damageRange": { "min": enc_num(o.damage_min), "avg": enc_num(o.damage_avg), "max": enc_num(o.damage_max) },
                }])).collect::<Vec<_>>() },
            })
        }
        "normalize" => enc_query(&q.normalize()),
        "compact" => enc_query(&q.compact(opt_num(0)?, flag(1, false)?)),
        "addScaled" => enc_query(&q.add_scaled(&decode_query(args.first()?)?, num(1)?)),
        "scaleMass" => enc_query(&q.scale_mass(num(0)?)),
        "convolve" => enc_query(&q.convolve(&decode_query(args.first()?)?)),
        _ => return None,
    })
}

#[test]
fn recorded_query() {
    replay("recorded-query.jsonl", run);
}

/// Hand-picked cases (fixtures/gen-query.mts) for methods the test suite never calls.
#[test]
fn synthetic_query() {
    replay("synthetic-query.jsonl", run);
}
