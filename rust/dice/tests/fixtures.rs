//! Replays fixtures/cases.jsonl (written by fixtures/gen.mts from the TypeScript original).
//! `cargo test --test fixtures -- --nocapture` prints a per-op table.
//! `FIXTURE_OP`=<op> runs one op. `FIXTURE_STRICT=1` also fails on ops not ported yet.
//! Floats match within 1e-9 relative (absolute below 1): ADR-005. Strings and integers exactly.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use yipe_dice::pmf::{Pmf, PmfJson};

const TOL: f64 = 1e-9;

fn pmf(v: &Value) -> Pmf {
    Pmf::from_json(serde_json::from_value::<PmfJson>(v.clone()).expect("pmf json"))
}

fn num(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else {
        json!(yipe_dice::js::num_to_string(x))
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn out_pmf(p: Pmf) -> Value {
    json!({ "pmf": { "bins": p.bins(), "normalized": p.normalized } })
}

/// Runs one case against the port. `None`: op not ported yet. Add one arm per ported op.
#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn run(op: &str, a: &Pmf, b: Option<Pmf>, x: &Value) -> Option<Value> {
    let xf = || x.as_f64().expect("numeric x");
    let xs = || x.as_str().expect("string x");
    let b = || b.clone().expect("case has b");
    Some(match op {
        "mass" => num(a.mass()),
        "mean" => num(a.mean()),
        "variance" => num(a.variance()),
        "stdev" => num(a.stdev()),
        "min" => num(a.min()),
        "max" => num(a.max()),
        "support" => json!(a.support()),
        "fingerprint" => json!(a.fingerprint()),
        "pAt" => num(a.p_at(xf())),
        "hitProbability" => num(a.hit_probability()),
        "missProbability" => num(a.miss_probability()),
        "cdfAt" => num(a.cdf_at(xf())),
        "tailProbGE" => num(a.tail_prob_ge(xf())),
        "quantile" => num(a.quantile(xf())),
        "outcomes" => json!(a.outcomes()),
        "outcomeProbability" => num(a.outcome_probability(xs())),
        "filterOutcome" => out_pmf(a.filter_outcome(xs())),
        "normalize" => out_pmf(a.normalize()),
        "scaleMass" => out_pmf(a.scale_mass(xf())),
        "add" => out_pmf(a.add(&b())),
        "addScaled" => out_pmf(a.add_scaled(&b(), xf())),
        "convolve" => out_pmf(a.convolve(&b(), None, false)),
        "maxOfTwo" => out_pmf(a.max_of_two()),
        "power" => match a.power(xf(), None) {
            Ok(p) => out_pmf(p),
            Err(e) => json!({ "error": e.to_string() }),
        },
        _ => return None,
    })
}

fn close(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            x == y || (x - y).abs() <= TOL * x.abs().max(y.abs()).max(1.0)
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| close(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            // "identifier" is provenance, not behavior.
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
fn first_diff(want: &Value, got: &Value, path: &str) -> Option<String> {
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

#[test]
fn fixtures() {
    std::panic::set_hook(Box::new(|_| {}));
    let text =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/cases.jsonl"))
            .unwrap();
    let only = std::env::var("FIXTURE_OP").ok();
    let strict = std::env::var("FIXTURE_STRICT").is_ok();
    let mut table: BTreeMap<String, (u32, u32, u32)> = BTreeMap::new(); // pass, fail, todo
    let mut failures = Vec::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let case: Value = serde_json::from_str(line).unwrap();
        let op = case["op"].as_str().unwrap().to_string();
        if only.as_deref().is_some_and(|o| o != op) {
            continue;
        }
        let a = pmf(&case["a"]);
        let b = case.get("b").map(pmf);
        let row = table.entry(op.clone()).or_default();
        let x = case.get("x").cloned().unwrap_or(Value::Null);
        let result = std::panic::catch_unwind(|| run(&op, &a, b.clone(), &x));
        let result = match result {
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
        match result {
            None => row.2 += 1,
            Some(got) if close(&got, &case["out"]) => row.0 += 1,
            Some(got) => {
                row.1 += 1;
                if failures.len() < 5 {
                    let cut = |v: &Value| v.to_string().chars().take(300).collect::<String>();
                    failures.push(format!(
                        "{op} x={x}\n  first difference: {}\n  expected {}\n  got      {}",
                        first_diff(&case["out"], &got, "").unwrap_or_default(),
                        cut(&case["out"]),
                        cut(&got)
                    ));
                }
            }
        }
    }
    println!("{:<20} {:>5} {:>5} {:>5}", "op", "pass", "fail", "todo");
    for (op, (p, f, t)) in &table {
        println!("{op:<20} {p:>5} {f:>5} {t:>5}");
    }
    drop(std::panic::take_hook()); // restore the default hook so the assertions below print
    let fails: u32 = table.values().map(|r| r.1).sum();
    let todo: u32 = table.values().map(|r| r.2).sum();
    assert!(fails == 0, "{fails} mismatches:\n{}", failures.join("\n"));
    assert!(!strict || todo == 0, "{todo} cases not ported yet");
}
