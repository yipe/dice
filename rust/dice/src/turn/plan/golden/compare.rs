//! `compare(rust, golden, path)`: the golden test's comparator.

use serde_json::Value;

/// Numbers are equal within this, absolute or relative.
const TOLERANCE: f64 = 1e-9;

fn close(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let diff = (a - b).abs();
    diff <= TOLERANCE || diff <= TOLERANCE * a.abs().max(b.abs())
}

fn show(v: &Value) -> String {
    let text = v.to_string();
    if text.chars().count() > 120 {
        format!("{}...", text.chars().take(120).collect::<String>())
    } else {
        text
    }
}

/// Every difference between `rust` and `golden`, as `path: message`. Floats compare within 1e-9
/// (relative or absolute), everything else exactly; JSON `null` and a missing key are equal.
pub fn compare(rust: &Value, golden: &Value, path: &str) -> Vec<String> {
    let mut out = Vec::new();
    walk(rust, golden, path, &mut out);
    out
}

fn walk(rust: &Value, golden: &Value, path: &str, out: &mut Vec<String>) {
    match (rust, golden) {
        (Value::Null, Value::Null) => {}
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (
                a.as_f64().unwrap_or(f64::NAN),
                b.as_f64().unwrap_or(f64::NAN),
            );
            if !close(a, b) {
                out.push(format!("{path}: rust {a} != golden {b}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!(
                    "{path}: rust has {} items, golden {} (rust {}, golden {})",
                    a.len(),
                    b.len(),
                    show(rust),
                    show(golden)
                ));
                return;
            }
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                walk(x, y, &format!("{path}/{i}"), out);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().collect();
            for k in b.keys() {
                if !a.contains_key(k) {
                    keys.push(k);
                }
            }
            for k in keys {
                walk(
                    a.get(k).unwrap_or(&Value::Null),
                    b.get(k).unwrap_or(&Value::Null),
                    &format!("{path}/{k}"),
                    out,
                );
            }
        }
        (a, b) if a == b => {}
        (a, b) => out.push(format!("{path}: rust {} != golden {}", show(a), show(b))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_within_tolerance_null_is_missing() {
        assert!(
            compare(
                &json!({"a": 1.0, "b": null}),
                &json!({"a": 1.0 + 1e-12}),
                "x"
            )
            .is_empty()
        );
        assert_eq!(
            compare(&json!({"a": 1.0}), &json!({"a": 1.1}), "x").len(),
            1
        );
        assert_eq!(
            compare(&json!({"a": [1, 2]}), &json!({"a": [1]}), "x").len(),
            1
        );
        assert_eq!(compare(&json!({"a": 1}), &json!({"a": "1"}), "x").len(), 1);
        assert_eq!(compare(&json!({"a": 1}), &json!({}), "x").len(), 1);
    }
}
