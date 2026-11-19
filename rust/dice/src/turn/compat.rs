//! Test support: the TS repo's compat fixture (`tests/compat/fixtures-0.16.json`, written by
//! `tests/compat/recorder.ts`), the exact values every 0.16 `Turn` reader returned, keyed by test
//! file and test name. A Rust test translated from a TS turn test checks its readers against it:
//!
//! ```ignore
//! let mut want = compat::expect("tests/turn-riders.test.ts", "riders > a rider on every hit");
//! want.check("mean", &[], compat::number(turn.mean()));
//! want.check("pmf", &[], compat::pmf(&turn.pmf()));
//! want.done();
//! ```
//!
//! Entries are consumed in recorded order (`ordinal`), as the TS recorder compares them. Numbers
//! are float64 bit patterns (16 hex chars): `pmf`, `mean` and `toQuery` match bit for bit,
//! `stepStats`, `fireProbability` and `expectedApplications` within 1e-12 relative (format.ts
//! `TOLERANCE`). Retired tests (`tests/compat/retired.json`) have no expectations.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde_json::{Map, Value};

use crate::{LabelMap, Pmf};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/compat/fixtures-0.16.json"
);
const RETIRED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/compat/retired.json"
);

/// One recorded reader call.
#[derive(Clone, Debug)]
pub struct Entry {
    pub ordinal: u64,
    pub reader: String,
    pub args: Vec<Value>,
    pub value: Value,
}

type Fixture = BTreeMap<String, BTreeMap<String, Vec<Entry>>>;

static FIXTURE_DATA: LazyLock<Fixture> = LazyLock::new(|| {
    let text = std::fs::read_to_string(FIXTURE).unwrap_or_else(|e| panic!("{FIXTURE}: {e}"));
    let raw: Map<String, Value> =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{FIXTURE}: {e}"));
    let mut out = Fixture::new();
    for (file, tests) in raw {
        let Value::Object(tests) = tests else {
            continue;
        }; // `capturedOn`
        let per = out.entry(file).or_default();
        for (test, entries) in tests {
            let entries = entries
                .as_array()
                .unwrap_or_else(|| panic!("compat: {test} is not a list"))
                .iter()
                .map(|e| Entry {
                    ordinal: e["ordinal"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("compat: bad ordinal in {test}")),
                    reader: e["reader"].as_str().unwrap_or_default().to_string(),
                    args: e["args"].as_array().cloned().unwrap_or_default(),
                    value: e["value"].clone(),
                })
                .collect();
            per.insert(test, entries);
        }
    }
    out
});

fn fixture() -> &'static Fixture {
    &FIXTURE_DATA
}

static RETIRED_KEYS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let text = std::fs::read_to_string(RETIRED).unwrap_or_else(|e| panic!("{RETIRED}: {e}"));
    let raw: Vec<Value> = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{RETIRED}: {e}"));
    raw.iter()
        .filter_map(|r| r["key"].as_str().map(str::to_string))
        .collect()
});

fn retired() -> &'static Vec<String> {
    &RETIRED_KEYS
}

/// The test names the fixture has for `file` (TS path from the repo root), for coverage checks.
pub fn tests_in(file: &str) -> Vec<String> {
    fixture()
        .get(file)
        .map(|t| t.keys().cloned().collect())
        .unwrap_or_default()
}

/// The recorded calls of one TS test. `test` is the vitest full name below the file: describe
/// titles and the test title joined by " > " (as in the fixture keys). Panics if the fixture has no
/// such test, so a typo cannot silently skip a check.
pub fn expect(file: &str, test: &str) -> Expected {
    let key = format!("{file} > {test}");
    if retired().contains(&key) {
        return Expected {
            name: key,
            entries: Vec::new(),
            next: 0,
            retired: true,
        };
    }
    let entries = fixture()
        .get(file)
        .and_then(|t| t.get(test))
        .unwrap_or_else(|| {
            panic!("compat: no fixture entry for {key:?}; see compat::tests_in({file:?})")
        })
        .clone();
    Expected {
        name: key,
        entries,
        next: 0,
        retired: false,
    }
}

/// The remaining recorded calls of one test; check them in order, then call [`Expected::done`].
pub struct Expected {
    name: String,
    entries: Vec<Entry>,
    next: usize,
    retired: bool,
}

impl Expected {
    /// Checks the next recorded call: same reader, same arguments, value within the reader's
    /// tolerance. `args` and `got` are serialized like the TS recorder (see [`number`], [`pmf`]).
    #[allow(
        clippy::needless_pass_by_value,
        reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
    )]
    pub fn check(&mut self, reader: &str, args: &[Value], got: Value) {
        if self.retired {
            return;
        }
        let at = self.next;
        let want = self.entries.get(at).unwrap_or_else(|| {
            panic!(
                "{} #{at} {reader}: no fixture entry (the TS made fewer calls)",
                self.name
            )
        });
        assert_eq!(want.reader, reader, "{} #{at}: reader", self.name);
        assert_eq!(want.args, args, "{} #{at} {reader}: args", self.name);
        let tol = tolerance(reader);
        assert!(
            within(&want.value, &got, tol),
            "{} #{at} {reader}: value differs{}\n  want {}\n  got  {}",
            self.name,
            first_difference(&want.value, &got, tol, "")
                .map(|p| format!(" at {p}"))
                .unwrap_or_default(),
            cut(&want.value),
            cut(&got)
        );
        self.next += 1;
    }

    /// Asserts every recorded call was checked.
    pub fn done(self) {
        if !self.retired {
            assert_eq!(
                self.next,
                self.entries.len(),
                "{}: {} recorded calls never checked",
                self.name,
                self.entries.len() - self.next
            );
        }
    }
}

fn tolerance(reader: &str) -> f64 {
    match reader {
        "stepStats" | "fireProbability" | "expectedApplications" => 1e-12,
        _ => 0.0,
    }
}

/// `hex(n)` in format.ts: the float64 bit pattern as 16 lowercase hex chars.
pub fn hex(n: f64) -> String {
    format!("{:016x}", n.to_bits())
}

fn unhex(s: &str) -> Option<f64> {
    (s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| u64::from_str_radix(s, 16).ok().map(f64::from_bits))?
}

/// A number as the recorder serializes it.
pub fn number(n: f64) -> Value {
    Value::String(hex(n))
}

/// `serializeLeaves`: every numeric leaf as hex, object keys sorted (`serde_json` `Map` sorts when
/// `preserve_order` is off; it is on here, so keys are sorted explicitly).
pub fn leaves(v: &Value) -> Value {
    match v {
        Value::Number(n) => n.as_f64().map_or(Value::Null, number),
        Value::Array(a) => Value::Array(a.iter().map(leaves).collect()),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), leaves(&o[k])))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn labels(m: Option<&LabelMap>) -> Value {
    match m {
        None => Value::Null,
        Some(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), number(m[k])))
                    .collect(),
            )
        }
    }
}

/// `serializePMF`: `[value, probHex, count, attr]` per bin, sorted by value.
pub fn pmf(p: &Pmf) -> Value {
    Value::Array(
        p.support()
            .into_iter()
            .filter_map(|d| p.map.get(&d).map(|b| (d, b)))
            .map(|(d, b)| {
                let value = serde_json::Number::from_f64(d.0).map_or(Value::Null, Value::Number);
                Value::Array(vec![
                    value,
                    number(b.p),
                    labels(Some(&b.count)),
                    labels(b.attr.as_ref()),
                ])
            })
            .collect(),
    )
}

fn within(want: &Value, got: &Value, tol: f64) -> bool {
    match (want, got) {
        (Value::String(w), Value::String(g)) => match (unhex(w), unhex(g)) {
            (Some(a), Some(b)) => {
                a.to_bits() == b.to_bits() || (a - b).abs() <= tol * b.abs().max(1.0) && tol > 0.0
            }
            _ => w == g,
        },
        (Value::Number(w), Value::Number(g)) => w.as_f64() == g.as_f64(),
        (Value::Array(w), Value::Array(g)) => {
            w.len() == g.len() && w.iter().zip(g).all(|(a, b)| within(a, b, tol))
        }
        (Value::Object(w), Value::Object(g)) => {
            w.len() == g.len()
                && w.iter()
                    .all(|(k, v)| g.get(k).is_some_and(|x| within(v, x, tol)))
        }
        _ => want == got,
    }
}

fn first_difference(want: &Value, got: &Value, tol: f64, path: &str) -> Option<String> {
    if within(want, got, tol) {
        return None;
    }
    match (want, got) {
        (Value::Array(w), Value::Array(g)) if w.len() == g.len() => w
            .iter()
            .zip(g)
            .enumerate()
            .find_map(|(i, (a, b))| first_difference(a, b, tol, &format!("{path}[{i}]"))),
        (Value::Object(w), Value::Object(g)) if w.len() == g.len() => {
            w.iter().find_map(|(k, v)| {
                g.get(k).map_or(Some(format!("{path}.{k} (missing)")), |x| {
                    first_difference(v, x, tol, &format!("{path}.{k}"))
                })
            })
        }
        (Value::String(w), Value::String(g)) => match (unhex(w), unhex(g)) {
            (Some(a), Some(b)) => Some(format!("{path}: {a:e} vs {b:e}")),
            _ => Some(path.to_string()),
        },
        _ => Some(path.to_string()),
    }
}

fn cut(v: &Value) -> String {
    v.to_string().chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_matches_format_ts() {
        assert_eq!(hex(1.0), "3ff0000000000000");
        assert_eq!(unhex("3ff0000000000000"), Some(1.0));
        assert_eq!(hex(-0.0), "8000000000000000");
    }

    #[test]
    fn fixture_loads() {
        let entries: usize = fixture()
            .values()
            .flat_map(|t| t.values())
            .map(Vec::len)
            .sum();
        assert_eq!(entries, 2787);
        assert_eq!(retired().len(), 4);
        assert!(!tests_in("tests/turn-chance.test.ts").is_empty());
    }

    #[test]
    #[should_panic(expected = "no fixture entry")]
    fn unknown_test_is_an_error() {
        let _ = expect("tests/turn-riders.test.ts", "no such test");
    }

    #[test]
    fn pmf_serializes_like_format_ts() {
        let mut map = indexmap::IndexMap::new();
        map.insert(
            crate::Damage(3.0),
            crate::Bin {
                p: 0.5,
                count: [("hit".into(), 0.5)].into_iter().collect(),
                attr: None,
            },
        );
        map.insert(
            crate::Damage(0.0),
            crate::Bin {
                p: 0.5,
                count: [("missNone".into(), 0.5)].into_iter().collect(),
                attr: Some(LabelMap::new()),
            },
        );
        let p = Pmf::new(map, crate::EPS, true);
        assert_eq!(
            pmf(&p).to_string(),
            r#"[[0.0,"3fe0000000000000",{"missNone":"3fe0000000000000"},{}],[3.0,"3fe0000000000000",{"hit":"3fe0000000000000"},null]]"#
        );
    }
}
