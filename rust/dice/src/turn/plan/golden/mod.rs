//! TS-vs-Rust golden harness for `buildPlan`: `plans.json` is what `dump.gen.ts.txt` writes (the
//! TypeScript plan of every spec of the catalog, with every step probed over a fixed grid of
//! walk states); [`golden_plans`] builds the same specs through [`build_plan`], dumps them with
//! [`dump::dump_plan`] and compares.
//!
//! Adding a spec: add it to `catalog` in `dump.gen.ts.txt` and to [`catalog::catalog`] (same
//! name, same position), regenerate `plans.json` (the command is at the top of the `.txt`), run
//! `cargo test -q --lib turn::plan::golden`. A mismatch is reported as `name/path: ...`.

mod cat_b;
mod cat_c;
mod cat_d;
mod cat_e;
mod catalog;
mod compare;
mod dump;

use super::{FoldMode, build_plan};
use crate::EPS;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

/// How many mismatches of one spec are printed.
const SHOWN_PER_SPEC: usize = 15;

#[test]
fn golden_plans() {
    let golden: Value = match serde_json::from_str(include_str!("plans.json")) {
        Ok(value) => value,
        Err(e) => panic!("plans.json is not JSON: {e}"),
    };
    let mut failures: Vec<String> = Vec::new();
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for (name, spec) in catalog::catalog() {
        names.insert(name);
        let Some(expected) = golden.get(name) else {
            failures.push(format!("{name}: not in plans.json (regenerate it)"));
            continue;
        };
        let actual = match spec {
            Err(message) => serde_json::json!({ "error": {
                "class": "Error", "code": Value::Null, "id": Value::Null, "message": message.message(),
            } }),
            Ok(spec) => match build_plan(&spec, EPS, &HashSet::new(), FoldMode::Joint) {
                Ok(plan) => serde_json::json!({ "plan": dump::dump_plan(&plan) }),
                Err(error) => dump::error_dump(&error),
            },
        };
        let diffs = compare::compare(&actual, expected, name);
        if !diffs.is_empty() {
            failures.push(format!("{name}: {} mismatches", diffs.len()));
            failures.extend(diffs.into_iter().take(SHOWN_PER_SPEC));
        }
    }
    if let Some(map) = golden.as_object() {
        for key in map.keys() {
            if !names.contains(key.as_str()) {
                failures.push(format!("{key}: in plans.json but not in the Rust catalog"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "plan golden mismatches:\n{}",
        failures.join("\n")
    );
}
