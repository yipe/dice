//! Port of `src/builder/roll-cache-key.ts`.
//!
//! TS keys an arbitrary JS object: a config with an unknown field or a wrong-typed value falls back
//! to `JSON.stringify`. [`Value`] models that dynamic shape so both paths stay reachable and the
//! fallback is tested; [`RollConfig`] is the typed config (`src/builder/types.ts`) and converts
//! with [`RollConfig::to_value`].

use super::nodes::KeepMode;
use crate::js::num_to_string;
// Writes to a `String` via `fmt::Write` are infallible, so `let _ =` discards no error.
use indexmap::IndexMap;
use std::fmt::Write;

/// A JS value as `JSON.stringify` sees it (functions, symbols and bigints do not occur).
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<Value>),
    /// Own enumerable string keys in insertion order.
    Object(IndexMap<String, Value>),
}

pub use super::types::{KeepSpec, RollConfig};

impl RollConfig {
    /// The JS object, keys in the order `defaultConfig` and later spreads give them.
    pub fn to_value(&self) -> Value {
        let mut o: IndexMap<String, Value> = IndexMap::new();
        let mut put = |k: &str, v: Value| {
            o.insert(k.to_string(), v);
        };
        put("count", Value::Num(self.count));
        put("sides", Value::Num(self.sides));
        put("modifier", Value::Num(self.modifier));
        put("reroll", Value::Num(self.reroll));
        put("explode", Value::Num(self.explode));
        put("explodePoolBudget", Value::Num(self.explode_pool_budget));
        put("minimum", Value::Num(self.minimum));
        put("bestOf", Value::Num(self.best_of));
        put(
            "keep",
            match self.keep {
                None => Value::Undefined,
                Some(k) => Value::Object(IndexMap::from_iter([
                    ("total".to_string(), Value::Num(k.total)),
                    ("count".to_string(), Value::Num(k.count)),
                    (
                        "mode".to_string(),
                        Value::Str(
                            match k.mode {
                                KeepMode::Highest => "highest",
                                KeepMode::Lowest => "lowest",
                            }
                            .to_string(),
                        ),
                    ),
                ])),
            },
        );
        put("rollType", Value::Str(self.roll_type.as_str().to_string()));
        if let Some(b) = self.is_subtraction {
            put("isSubtraction", Value::Bool(b));
        }
        if self.pinned {
            put("pinned", Value::Bool(true));
        }
        Value::Object(o)
    }
}

/// `rollConfigsKey` over typed configs.
pub fn roll_configs_key_typed(configs: &[RollConfig]) -> String {
    fast_key(configs).unwrap_or_else(|| slow_key(configs))
}

/// The key through the dynamic [`Value`] path; the reference `fast_key` must equal.
fn slow_key(configs: &[RollConfig]) -> String {
    let values: Vec<Value> = configs.iter().map(RollConfig::to_value).collect();
    roll_configs_key(&values)
}

fn push_num(out: &mut String, x: f64) {
    if x == 0.0 {
        out.push('0');
    } else if x.fract() == 0.0 && x.abs() < 1e15 {
        let _ = write!(out, "{}", x as i64);
    } else {
        out.push_str(&num_to_string(x));
    }
}

/// Typed fast path: the key of [`slow_key`] written straight from the configs. `None` when a
/// roll type is not a safe word (the slow path then falls back to JSON).
fn fast_key(configs: &[RollConfig]) -> Option<String> {
    let mut out = String::with_capacity(32 * configs.len() + 1);
    out.push('~');
    for c in configs {
        let rt = c.roll_type.as_str();
        if !is_safe_word(rt) {
            return None;
        }
        out.push('[');
        for (i, x) in [
            c.count,
            c.sides,
            c.modifier,
            c.reroll,
            c.explode,
            c.explode_pool_budget,
            c.minimum,
            c.best_of,
        ]
        .into_iter()
        .enumerate()
        {
            if i > 0 {
                out.push(';');
            }
            push_num(&mut out, x);
        }
        out.push(';');
        match c.keep {
            None => out.push('_'),
            Some(k) => {
                out.push('{');
                push_num(&mut out, k.total);
                out.push(';');
                push_num(&mut out, k.count);
                out.push_str(";'");
                out.push_str(match k.mode {
                    KeepMode::Highest => "highest",
                    KeepMode::Lowest => "lowest",
                });
                out.push('}');
            }
        }
        out.push_str(";'");
        out.push_str(rt);
        out.push(';');
        out.push(match c.is_subtraction {
            None => '_',
            Some(true) => 't',
            Some(false) => 'f',
        });
        out.push(';');
        out.push(if c.pinned { 't' } else { '_' });
        out.push(']');
    }
    Some(out)
}

/// A lazily computed value cached on builder data. Cloning yields an empty memo and equality
/// ignores it, so a copied or mutated builder never carries a stale value.
pub(crate) struct Memo<T>(std::sync::OnceLock<T>);

impl<T> Default for Memo<T> {
    fn default() -> Self {
        Memo(std::sync::OnceLock::new())
    }
}
impl<T> Clone for Memo<T> {
    fn clone(&self) -> Self {
        Self::default()
    }
}
impl<T> PartialEq for Memo<T> {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
impl<T> std::fmt::Debug for Memo<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Memo")
    }
}
impl<T> Memo<T> {
    pub(crate) fn get_or_init(&self, f: impl FnOnce() -> T) -> &T {
        self.0.get_or_init(f)
    }
    pub(crate) fn reset(&mut self) {
        self.0.take();
    }
}

fn json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(v, replacer)` with the replacer of `jsonRollKey` (a non-finite number becomes
/// the string `#<number>`). `Undefined` is written as `null`; callers skip it in objects.
fn json_value(v: &Value, out: &mut String) {
    match v {
        Value::Undefined | Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) if n.is_finite() => out.push_str(&num_to_string(*n)),
        Value::Num(n) => json_string(&format!("#{}", num_to_string(*n)), out),
        Value::Str(s) => json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut first = true;
            for (k, item) in map {
                if *item == Value::Undefined {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                json_string(k, out);
                out.push(':');
                json_value(item, out);
            }
            out.push('}');
        }
    }
}

/// `jsonRollKey`: the original serializer, kept as the fallback for any config the fast path does
/// not recognize.
pub fn json_roll_key(configs: &[Value]) -> String {
    let mut out = String::new();
    json_value(&Value::Array(configs.to_vec()), &mut out);
    out
}

const FIELDS: [&str; 12] = [
    "count",
    "sides",
    "modifier",
    "reroll",
    "explode",
    "explodePoolBudget",
    "minimum",
    "bestOf",
    "keep",
    "rollType",
    "isSubtraction",
    "pinned",
];
const KEEP_FIELDS: [&str; 3] = ["total", "count", "mode"];

/// Absent or undefined.
const ABSENT: &str = "_";

static UNDEFINED: Value = Value::Undefined;

/// `v[key]`: `Undefined` when absent (and for arrays, whose own keys are indices).
fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    match v {
        Value::Object(m) => m.get(key).unwrap_or(&UNDEFINED),
        _ => &UNDEFINED,
    }
}

/// `undefined` (here `None`) when the value is not an absent-or-number.
fn num(v: &Value) -> Option<String> {
    match v {
        Value::Undefined => Some(ABSENT.to_string()),
        Value::Num(n) => Some(num_to_string(*n)),
        _ => None,
    }
}

/// `/^[A-Za-z0-9_-]+$/`.
fn is_safe_word(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn word(v: &Value) -> Option<String> {
    match v {
        Value::Undefined => Some(ABSENT.to_string()),
        // A quote prefix keeps a present string distinct from ABSENT.
        Value::Str(s) if is_safe_word(s) => Some(format!("'{s}")),
        _ => None,
    }
}

fn boolean(v: &Value) -> Option<String> {
    match v {
        Value::Undefined => Some(ABSENT.to_string()),
        Value::Bool(b) => Some(if *b { "t" } else { "f" }.to_string()),
        _ => None,
    }
}

/// `hasOnly`: every own key of an object (an array's are its indices) is allowed.
fn has_only(o: &Value, allowed: &[&str]) -> bool {
    match o {
        Value::Object(m) => m.keys().all(|k| allowed.contains(&k.as_str())),
        Value::Array(items) => items.is_empty(),
        _ => true,
    }
}

/// `typeof v === "object" && v !== null`.
fn is_object(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

fn keep_text(keep: &Value) -> Option<String> {
    if *keep == Value::Undefined {
        return Some(ABSENT.to_string());
    }
    if !is_object(keep) || !has_only(keep, &KEEP_FIELDS) {
        return None;
    }
    let parts = [
        num(get(keep, "total"))?,
        num(get(keep, "count"))?,
        word(get(keep, "mode"))?,
    ];
    Some(format!("{{{}}}", parts.join(";")))
}

fn config_parts(c: &Value) -> Option<[String; 12]> {
    Some([
        num(get(c, "count"))?,
        num(get(c, "sides"))?,
        num(get(c, "modifier"))?,
        num(get(c, "reroll"))?,
        num(get(c, "explode"))?,
        num(get(c, "explodePoolBudget"))?,
        num(get(c, "minimum"))?,
        num(get(c, "bestOf"))?,
        keep_text(get(c, "keep"))?,
        word(get(c, "rollType"))?,
        boolean(get(c, "isSubtraction"))?,
        boolean(get(c, "pinned"))?,
    ])
}

/// `rollConfigsKey`: a key that identifies a roll's config array by value, without JSON. Equal
/// values give equal keys and equal keys mean equal field values; own-key order is ignored. It
/// never contains `*` or `|`, starts with `~` (which no JSON key does) and ends in `]` or is `~`.
/// A config with a field or type it does not know falls back to [`json_roll_key`].
pub fn roll_configs_key(configs: &[Value]) -> String {
    let mut key = String::from("~");
    for config in configs {
        if !is_object(config) || !has_only(config, &FIELDS) {
            return json_roll_key(configs);
        }
        let Some(parts) = config_parts(config) else {
            return json_roll_key(configs);
        };
        key.push('[');
        key.push_str(&parts.join(";"));
        key.push(']');
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::RollType;

    /// `rng` of the TS test (mulberry32).
    fn rng(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_add(0x6d2b_79f5);
            let mut t = s;
            t = (t ^ (t >> 15)).wrapping_mul(t | 1);
            t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
            f64::from(t ^ (t >> 14)) / 4_294_967_296.0
        }
    }

    fn n(x: f64) -> Value {
        Value::Num(x)
    }
    fn s(x: &str) -> Value {
        Value::Str(x.to_string())
    }
    fn obj(fields: Vec<(&str, Value)>) -> Value {
        Value::Object(
            fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }
    fn cfg(fields: Vec<(&str, Value)>) -> Vec<Value> {
        vec![obj(fields)]
    }

    fn nums() -> [Value; 14] {
        [
            n(0.0),
            n(-0.0),
            n(1.0),
            n(2.0),
            n(6.0),
            n(20.0),
            n(-3.0),
            n(0.5),
            n(1e21),
            n(1e-7),
            n(f64::NAN),
            n(f64::INFINITY),
            n(f64::NEG_INFINITY),
            Value::Undefined,
        ]
    }

    fn pick<T: Clone>(r: &mut impl FnMut() -> f64, xs: &[T]) -> T {
        xs[(r() * xs.len() as f64).floor() as usize].clone()
    }

    fn random_config(r: &mut impl FnMut() -> f64) -> Value {
        let modes = [
            s("highest"),
            s("lowest"),
            s("normal"),
            s("advantage"),
            s("disadvantage"),
            s("a_b"),
            s("x*y"),
            Value::Undefined,
        ];
        let mut c: IndexMap<String, Value> = IndexMap::new();
        for f in [
            "count",
            "sides",
            "modifier",
            "reroll",
            "explode",
            "explodePoolBudget",
            "minimum",
            "bestOf",
        ] {
            if r() < 0.9 {
                c.insert(f.to_string(), pick(r, &nums()));
            }
        }
        let k = r();
        if k < 0.3 {
            let total = pick(r, &nums());
            let count = pick(r, &nums());
            let mode = pick(r, &modes);
            c.insert(
                "keep".into(),
                obj(vec![("total", total), ("count", count), ("mode", mode)]),
            );
        } else if k < 0.4 {
            c.insert("keep".into(), Value::Undefined);
        }
        if r() < 0.8 {
            c.insert(
                "rollType".into(),
                pick(
                    r,
                    &[
                        s("normal"),
                        s("advantage"),
                        s("disadvantage"),
                        Value::Undefined,
                    ],
                ),
            );
        }
        if r() < 0.5 {
            c.insert(
                "isSubtraction".into(),
                pick(
                    r,
                    &[Value::Bool(true), Value::Bool(false), Value::Undefined],
                ),
            );
        }
        if r() < 0.3 {
            c.insert(
                "pinned".into(),
                pick(r, &[Value::Bool(true), Value::Undefined]),
            );
        }
        Value::Object(c)
    }

    /// Field values compared with `Object.is`, except that -0 equals 0.
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Num(x), Value::Num(y)) => {
                (*x == 0.0 && *y == 0.0) || x == y || (x.is_nan() && y.is_nan())
            }
            _ => a == b,
        }
    }

    fn equal_configs(a: &[Value], b: &[Value]) -> bool {
        a.len() == b.len()
            && a.iter().zip(b).all(|(x, y)| {
                FIELDS.iter().all(|f| {
                    if *f == "keep" {
                        let (kx, ky) = (get(x, "keep"), get(y, "keep"));
                        if *kx == Value::Undefined || *ky == Value::Undefined {
                            return kx == ky;
                        }
                        return ["total", "count", "mode"]
                            .iter()
                            .all(|g| same(get(kx, g), get(ky, g)));
                    }
                    same(get(x, f), get(y, f))
                })
            })
    }

    #[test]
    fn exact_refinement_of_the_old_key_on_seeded_random_configs() {
        let mut r = rng(42);
        let mut pool: Vec<Vec<Value>> = Vec::new();
        for _ in 0..400 {
            let len = 1 + (r() * 3.0).floor() as usize;
            pool.push((0..len).map(|_| random_config(&mut r)).collect());
        }
        for _ in 0..200 {
            let i = (r() * 400.0).floor() as usize;
            pool.push(pool[i].clone());
        }
        for i in 0..pool.len() {
            let a = &pool[i];
            let ka = roll_configs_key(a);
            if ka.starts_with('~') {
                assert!(!ka.contains('*') && !ka.contains('|'), "{ka}");
            } else {
                assert_eq!(ka, json_roll_key(a));
            }
            let mut j = i;
            while j < pool.len() {
                let b = &pool[j];
                let kb = roll_configs_key(b);
                if json_roll_key(a) == json_roll_key(b) {
                    assert_eq!(ka, kb);
                }
                if ka == kb {
                    assert!(equal_configs(a, b), "{ka}");
                }
                j += 3;
            }
        }
    }

    #[test]
    fn nan_and_infinities_stay_distinct() {
        let keys: Vec<String> = [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            0.0,
            1.0,
            -1.0,
            1e308,
        ]
        .iter()
        .map(|v| roll_configs_key(&cfg(vec![("count", n(*v))])))
        .collect();
        let set: std::collections::HashSet<&String> = keys.iter().collect();
        assert_eq!(set.len(), keys.len());
    }

    #[test]
    fn negative_zero_shares_a_key_with_zero() {
        assert_eq!(
            roll_configs_key(&cfg(vec![("modifier", n(-0.0))])),
            roll_configs_key(&cfg(vec![("modifier", n(0.0))]))
        );
    }

    #[test]
    fn absent_and_undefined_alike_distinct_from_present() {
        let k = |f: Vec<(&str, Value)>| roll_configs_key(&cfg(f));
        let absent = k(vec![("count", n(1.0))]);
        assert_eq!(
            k(vec![
                ("count", n(1.0)),
                ("explodePoolBudget", Value::Undefined)
            ]),
            absent
        );
        for v in [0.0, f64::NAN, 1.0] {
            assert_ne!(
                k(vec![("count", n(1.0)), ("explodePoolBudget", n(v))]),
                absent
            );
        }
        let sub = |v: Value| k(vec![("count", n(1.0)), ("isSubtraction", v)]);
        assert_eq!(sub(Value::Undefined), absent);
        assert_ne!(sub(Value::Bool(false)), sub(Value::Undefined));
        assert_ne!(sub(Value::Bool(true)), sub(Value::Bool(false)));
        assert_ne!(k(vec![("count", n(1.0)), ("rollType", s("_"))]), absent);
        assert_ne!(
            k(vec![("count", n(1.0)), ("pinned", Value::Bool(true))]),
            absent
        );
    }

    #[test]
    fn separates_keep_unset_undefined_and_each_field() {
        let k = |keep: Value| {
            roll_configs_key(&cfg(vec![
                ("count", n(4.0)),
                ("sides", n(6.0)),
                ("keep", keep),
            ]))
        };
        let kp =
            |t: f64, c: f64, m: &str| obj(vec![("total", n(t)), ("count", n(c)), ("mode", s(m))]);
        assert_eq!(
            k(Value::Undefined),
            roll_configs_key(&cfg(vec![("count", n(4.0)), ("sides", n(6.0))]))
        );
        let set = k(kp(4.0, 3.0, "highest"));
        assert_ne!(set, k(Value::Undefined));
        assert_ne!(set, k(kp(4.0, 3.0, "lowest")));
        assert_ne!(set, k(kp(4.0, 2.0, "highest")));
        assert_ne!(set, k(kp(3.0, 4.0, "highest")));
    }

    #[test]
    fn distinguishes_configs_by_position() {
        let a = obj(vec![("count", n(1.0)), ("sides", n(6.0))]);
        let b = obj(vec![("count", n(2.0)), ("sides", n(8.0))]);
        assert_ne!(
            roll_configs_key(&[a.clone(), b.clone()]),
            roll_configs_key(&[b, a.clone()])
        );
        assert_ne!(
            roll_configs_key(std::slice::from_ref(&a)),
            roll_configs_key(&[a.clone(), a])
        );
        assert_eq!(roll_configs_key(&[]), "~");
    }

    #[test]
    fn falls_back_to_json_for_unknown_key_keep_key_or_field_type() {
        let cases = vec![
            cfg(vec![("count", n(1.0)), ("mystery", n(3.0))]),
            cfg(vec![
                ("count", n(1.0)),
                (
                    "keep",
                    obj(vec![
                        ("total", n(1.0)),
                        ("count", n(1.0)),
                        ("mode", s("highest")),
                        ("extra", n(1.0)),
                    ]),
                ),
            ]),
            cfg(vec![("count", s("1"))]),
            cfg(vec![("count", n(1.0)), ("rollType", n(5.0))]),
            cfg(vec![("count", n(1.0)), ("rollType", s("a|b"))]),
            cfg(vec![("count", n(1.0)), ("isSubtraction", n(1.0))]),
            cfg(vec![("count", n(1.0)), ("pinned", s("yes"))]),
            cfg(vec![
                ("count", n(1.0)),
                (
                    "keep",
                    obj(vec![("total", n(1.0)), ("count", n(1.0)), ("mode", n(7.0))]),
                ),
            ]),
        ];
        for c in &cases {
            assert_eq!(roll_configs_key(c), json_roll_key(c));
            assert!(!roll_configs_key(c).starts_with('~'));
        }
        assert_eq!(json_roll_key(&cases[2]), r#"[{"count":"1"}]"#);
        assert_eq!(
            json_roll_key(&cfg(vec![("count", n(f64::NAN)), ("sides", n(-0.0))])),
            r##"[{"count":"#NaN","sides":0}]"##
        );
    }

    #[test]
    fn never_equals_a_json_fallback_key() {
        let mut r = rng(9);
        for _ in 0..300 {
            let c = vec![random_config(&mut r)];
            let key = roll_configs_key(&c);
            if !key.starts_with('~') {
                continue;
            }
            assert_ne!(key, json_roll_key(&c));
            assert!(!json_roll_key(&c).starts_with('~'));
        }
    }

    #[test]
    fn extra_star_pipe_or_eps_does_not_blur_a_composite() {
        let a = cfg(vec![("count", n(1.0)), ("sides", n(6.0))]);
        let b = cfg(vec![
            ("count", n(1.0)),
            ("sides", n(6.0)),
            ("modifier", n(1.0)),
        ]);
        let wrap = |k: String, e: f64| format!("{k}*e{}", num_to_string(e));
        assert_ne!(
            wrap(roll_configs_key(&a), 0.0),
            wrap(roll_configs_key(&b), 0.0)
        );
        assert_ne!(
            wrap(roll_configs_key(&a), 1.0),
            wrap(roll_configs_key(&a), 10.0)
        );
        assert!(roll_configs_key(&a).ends_with(']'));
    }

    #[test]
    fn typed_config_uses_the_fast_path_except_for_elven_accuracy() {
        let base = RollConfig {
            count: 2.0,
            sides: 6.0,
            modifier: 4.0,
            reroll: 0.0,
            explode: 0.0,
            explode_pool_budget: 0.0,
            minimum: 0.0,
            best_of: 0.0,
            keep: Some(KeepSpec {
                total: 4.0,
                count: 3.0,
                mode: KeepMode::Highest,
            }),
            roll_type: RollType::Flat,
            is_subtraction: None,
            pinned: false,
        };
        assert_eq!(
            roll_configs_key_typed(std::slice::from_ref(&base)),
            "~[2;6;4;0;0;0;0;0;{4;3;'highest};'flat;_;_]"
        );
        let elven = RollConfig {
            roll_type: RollType::ElvenAccuracy,
            ..base
        };
        assert!(roll_configs_key_typed(&[elven]).starts_with("[{"));
    }

    /// The typed fast path writes exactly the key of the dynamic path.
    #[test]
    fn fast_key_matches_slow_key() {
        let mut r = rng(7);
        let nums = [
            0.0,
            -0.0,
            1.0,
            -1.0,
            6.0,
            20.0,
            100.0,
            0.5,
            -2.5,
            1e15,
            1e21,
            1e-7,
            9_007_199_254_740_991.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ];
        let pick = |r: &mut dyn FnMut() -> f64| nums[(r() * nums.len() as f64) as usize];
        let types = [
            RollType::Flat,
            RollType::Advantage,
            RollType::Disadvantage,
            RollType::ElvenAccuracy,
        ];
        for _ in 0..5000 {
            let len = 1 + (r() * 3.0) as usize;
            let configs: Vec<RollConfig> = (0..len)
                .map(|_| RollConfig {
                    count: pick(&mut r),
                    sides: pick(&mut r),
                    modifier: pick(&mut r),
                    reroll: pick(&mut r),
                    explode: pick(&mut r),
                    explode_pool_budget: pick(&mut r),
                    minimum: pick(&mut r),
                    best_of: pick(&mut r),
                    keep: (r() < 0.5).then(|| KeepSpec {
                        total: pick(&mut r),
                        count: pick(&mut r),
                        mode: if r() < 0.5 {
                            KeepMode::Highest
                        } else {
                            KeepMode::Lowest
                        },
                    }),
                    roll_type: types[(r() * 4.0) as usize],
                    is_subtraction: match (r() * 3.0) as u8 {
                        0 => None,
                        1 => Some(true),
                        _ => Some(false),
                    },
                    pinned: r() < 0.5,
                })
                .collect();
            assert_eq!(
                roll_configs_key_typed(&configs),
                slow_key(&configs),
                "{configs:?}"
            );
            if configs
                .iter()
                .all(|c| c.roll_type != RollType::ElvenAccuracy)
            {
                assert_eq!(
                    fast_key(&configs).as_deref(),
                    Some(slow_key(&configs).as_str())
                );
            }
        }
    }
}
