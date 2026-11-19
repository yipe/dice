//! Shared by the replay tests: the recorder's value encoding (fixtures/record-pmf.ts), 1e-9
//! comparison (ADR-005), and the per-op table runner.
#![allow(dead_code)] // each test binary uses a different subset of these helpers

use std::collections::BTreeMap;
use yipe_dice::DiceError;

use serde_json::{Value, json};
use yipe_dice::pmf::{Pmf, PmfJson};

pub const TOL: f64 = 1e-9;

pub fn decode_pmf(v: &Value) -> Option<Pmf> {
    let inner = v.get("$pmf")?;
    serde_json::from_value::<PmfJson>(inner.clone())
        .ok()
        .map(Pmf::from_json)
}

/// A recorded number argument; `{"$num": ...}` decodes to its float.
pub fn decode_num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Object(o) => match o.get("$num")?.as_str()? {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            _ => None,
        },
        _ => None,
    }
}

pub fn is_absent(v: Option<&Value>) -> bool {
    v.is_none_or(|v| v.get("$undefined").is_some())
}

pub fn enc_num(x: f64) -> Value {
    if x.is_finite() && !(x == 0.0 && x.is_sign_negative()) {
        json!(x)
    } else if x == 0.0 {
        json!({ "$num": "-0" })
    } else {
        json!({ "$num": yipe_dice::js::num_to_string(x) })
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
pub fn enc_pmf(p: Pmf) -> Value {
    json!({ "$pmf": { "bins": p.bins(), "normalized": p.normalized, "epsilon": enc_num(p.epsilon) } })
}

pub fn labels(m: &yipe_dice::LabelMap) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), enc_num(*v))).collect())
}

pub fn enc_result(r: Result<Pmf, DiceError>) -> Value {
    match r {
        Ok(p) => enc_pmf(p),
        Err(e) => json!({ "$error": e.to_string() }),
    }
}

pub fn close(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (decode_num(a), decode_num(b)) {
        return x == y
            || (x.is_nan() && y.is_nan())
            || (x - y).abs() <= TOL * x.abs().max(y.abs()).max(1.0);
    }
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| close(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            let keys = |o: &serde_json::Map<String, Value>| {
                o.keys()
                    .filter(|k| *k != "identifier")
                    .cloned()
                    .collect::<Vec<_>>()
            };
            keys(x) == keys(y) && keys(x).iter().all(|k| close(&x[k], &y[k]))
        }
        _ => a == b,
    }
}

/// Where `got` first differs from `want`, as a path like `$pmf.bins[3][1].count.hit`.
pub fn first_diff(want: &Value, got: &Value, path: &str) -> Option<String> {
    if close(want, got) {
        return None;
    }
    match (want, got) {
        (Value::Array(x), Value::Array(y)) if x.len() != y.len() => {
            Some(format!("{path}: length {} vs {}", x.len(), y.len()))
        }
        (Value::Array(x), Value::Array(y)) => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (p, q))| first_diff(p, q, &format!("{path}[{i}]"))),
        (Value::Object(x), Value::Object(y)) => {
            let missing = x
                .keys()
                .chain(y.keys())
                .filter(|k| *k != "identifier")
                .find(|k| x.contains_key(*k) != y.contains_key(*k));
            if let Some(k) = missing {
                return Some(format!("{path}.{k}: present in only one side"));
            }
            x.iter()
                .filter(|(k, _)| *k != "identifier")
                .find_map(|(k, v)| first_diff(v, &y[k], &format!("{path}.{k}")))
        }
        _ => Some(format!("{path}: expected {want}, got {got}")),
    }
}

/// Replays `fixtures/<file>` through `run(op, receiver, args)` and prints a per-op table.
/// `run` returns None for an op (or argument shape) not ported yet. `FIXTURE_OP`=<op> runs one op;
/// `FIXTURE_STRICT=1` also fails on cases not ported yet.
pub fn replay(
    file: &str,
    run: impl Fn(&str, Option<&Value>, &[Value]) -> Option<Value> + std::panic::RefUnwindSafe,
) {
    std::panic::set_hook(Box::new(|_| {}));
    let text = std::fs::read_to_string(format!("{}/fixtures/{file}", env!("CARGO_MANIFEST_DIR")))
        .unwrap_or_else(|e| panic!("fixtures/{file}: {e} (regenerate: see rust/dice/.gitignore)"));
    let only = std::env::var("FIXTURE_OP").ok();
    let strict = std::env::var("FIXTURE_STRICT").is_ok();
    let mut table: BTreeMap<String, (u32, u32, u32)> = BTreeMap::new();
    let mut failures = Vec::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let case: Value = serde_json::from_str(line).unwrap();
        let op = case["op"].as_str().unwrap().to_string();
        if only.as_deref().is_some_and(|o| o != op) {
            continue;
        }
        let args = case["args"].as_array().cloned().unwrap_or_default();
        let row = table.entry(op.clone()).or_default();
        let got = match std::panic::catch_unwind(|| run(&op, case.get("a"), &args)) {
            Ok(r) => r,
            Err(e) => {
                let msg = e
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| {
                        e.downcast_ref::<&str>()
                            .map(std::string::ToString::to_string)
                    })
                    .unwrap_or_default();
                if msg.contains("not ported") {
                    None
                } else {
                    Some(json!({ "panic": msg }))
                }
            }
        };
        match got {
            None => row.2 += 1,
            Some(got) if close(&got, &case["out"]) => row.0 += 1,
            Some(got) => {
                row.1 += 1;
                if failures.len() < 5 {
                    let cut = |v: &Value| v.to_string().chars().take(400).collect::<String>();
                    failures.push(format!(
                        "{op} args={}\n  first difference: {}\n  expected {}\n  got      {}",
                        cut(&case["args"]),
                        first_diff(&case["out"], &got, "").unwrap_or_default(),
                        cut(&case["out"]),
                        cut(&got)
                    ));
                }
            }
        }
    }
    drop(std::panic::take_hook()); // restore the default hook so the assertions below print
    println!("{:<34} {:>5} {:>5} {:>5}", "op", "pass", "fail", "todo");
    for (op, (p, f, t)) in &table {
        println!("{op:<34} {p:>5} {f:>5} {t:>5}");
    }
    let fails: u32 = table.values().map(|r| r.1).sum();
    let todo: u32 = table.values().map(|r| r.2).sum();
    println!(
        "total: {} pass, {fails} fail, {todo} todo",
        table.values().map(|r| r.0).sum::<u32>()
    );
    assert!(fails == 0, "{fails} mismatches:\n{}", failures.join("\n"));
    assert!(!strict || todo == 0, "{todo} cases not ported yet");
}
