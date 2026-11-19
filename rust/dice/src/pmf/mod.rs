//! Port of `src/pmf/pmf.ts` (class `PMF`). Damage keys are integers; maps keep JS `Map`
//! insertion order (`IndexMap`), which decides float summation order.

use crate::Damage;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::EPS;
use crate::js::num_to_string;

/// `OutcomeLabelMap`: label -> value, in the object's key order.
pub type LabelMap = IndexMap<String, f64>;

/// `Bin` in `src/common/types.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bin {
    pub p: f64,
    pub count: LabelMap,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attr: Option<LabelMap>,
}

/// `PMF`. Immutable; methods return new values. The TS caches (`_mean`, ...) are omitted.
#[derive(Clone, Debug, PartialEq)]
pub struct Pmf {
    pub map: IndexMap<Damage, Bin>,
    pub epsilon: f64,
    pub normalized: bool,
    pub identifier: Option<String>,
    /// The memoized [`Pmf::fingerprint`] (TS `_fingerprint`). A PMF is immutable once built: build
    /// a new one (`Pmf::new`) rather than editing `map` of one whose fingerprint was read.
    pub fp: FingerprintCell,
}

/// Values derived from a PMF's content, computed once: its fingerprint and its normalized copy
/// (TS `_fingerprint` and the per-operand convolve key memo). Never part of equality; cloning
/// keeps them (same content).
#[derive(Clone, Default)]
pub struct FingerprintCell {
    fingerprint: std::sync::OnceLock<String>,
    normalized: std::sync::OnceLock<std::sync::Arc<Pmf>>,
    /// `sliceEveryOutcome()` result (TS `_outcomeSlices`). Clones carry it: same content, and the
    /// slices are immutable shared values.
    slices: std::sync::OnceLock<IndexMap<String, std::sync::Arc<Pmf>>>,
    /// `outcomes()` (TS `_outcomes`).
    outcomes: std::sync::OnceLock<Vec<String>>,
}

impl PartialEq for FingerprintCell {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

impl std::fmt::Debug for FingerprintCell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FingerprintCell")
    }
}

/// `PMF.toJSON()` shape.
#[derive(Serialize, Deserialize)]
pub struct PmfJson {
    pub bins: Vec<(Damage, Bin)>,
    #[serde(default)]
    pub normalized: bool,
    #[serde(default)]
    pub identifier: Option<String>,
    /// Not in TS `toJSON()`; the recorder adds it. Absent means `EPS`, as `PMF.fromJSON` assumes.
    #[serde(default)]
    pub epsilon: Option<f64>,
}

impl Pmf {
    pub fn new(map: IndexMap<Damage, Bin>, epsilon: f64, normalized: bool) -> Self {
        Self {
            map,
            epsilon,
            normalized,
            identifier: None,
            fp: FingerprintCell::default(),
        }
    }

    /// The explicit identifier `name` (a constructor's, or a parsed expression).
    pub fn with_identifier(mut self, name: &str) -> Self {
        self.identifier = Some(name.to_string());
        self
    }

    /// `identifier`: the explicit one if set, else `pmf#` and the hash of the fingerprint.
    pub fn identifier(&self) -> String {
        match &self.identifier {
            Some(id) => id.clone(),
            None => format!("pmf#{}", hash_text(&self.fingerprint())),
        }
    }

    /// `PMF.fromJSON`.
    pub fn from_json(j: PmfJson) -> Self {
        Self {
            fp: Default::default(),
            map: j.bins.into_iter().collect(),
            epsilon: j.epsilon.unwrap_or(EPS),
            normalized: j.normalized,
            identifier: Some(
                j.identifier
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "fromJSON".to_string()),
            ),
        }
    }

    /// `toJSON().bins` (the identifier is not compared by the fixtures).
    pub fn bins(&self) -> Vec<(Damage, Bin)> {
        self.map.iter().map(|(k, b)| (*k, b.clone())).collect()
    }

    /// `mass()`.
    pub fn mass(&self) -> f64 {
        self.map.values().fold(0.0, |s, b| s + b.p)
    }

    /// `support()`: damage values ascending.
    pub fn support(&self) -> Vec<Damage> {
        let mut v: Vec<Damage> = self.map.keys().copied().collect();
        v.sort_unstable();
        v
    }

    /// `min()`: 0 when empty.
    pub fn min(&self) -> f64 {
        self.support().first().map_or(0.0, |d| d.0)
    }

    /// `max()`: 0 when empty.
    pub fn max(&self) -> f64 {
        self.support().last().map_or(0.0, |d| d.0)
    }

    /// `mean()`: partial expectation, sum of v * p in map order.
    pub fn mean(&self) -> f64 {
        self.map.iter().fold(0.0, |s, (v, b)| s + v.0 * b.p)
    }

    /// `variance()`: conditioned on the mass unless within EPS of 1 (see pmf.ts:785).
    pub fn variance(&self) -> f64 {
        let mass = self.mass();
        let conditional = mass > 0.0 && (mass - 1.0).abs() > EPS;
        let mean = if conditional {
            self.mean() / mass
        } else {
            self.mean()
        };
        let sum = self.map.iter().fold(0.0, |s, (v, b)| {
            let d = v.0 - mean;
            s + d * d * b.p
        });
        if conditional { sum / mass } else { sum }
    }

    /// `stdev()`.
    pub fn stdev(&self) -> f64 {
        self.variance().sqrt()
    }

    /// `fingerprint()`: see `PMF.binSegment` and `labelText` (src/pmf/dense.ts).
    fn compute_fingerprint(&self) -> String {
        let mut text = String::with_capacity(2 + self.map.len() * 48);
        text.push_str(if self.normalized { "1|" } else { "0|" });
        for (i, d) in self.support().iter().enumerate() {
            if i > 0 {
                text.push(';');
            }
            if let Some(b) = self.map.get(d) {
                Pmf::write_bin_segment(&mut text, d.0, b);
            }
        }
        text
    }

    /// `fingerprint()`, computed once per PMF (and its clones).
    pub fn fingerprint_ref(&self) -> &str {
        self.fp
            .fingerprint
            .get_or_init(|| self.compute_fingerprint())
    }

    /// `normalize()` as a shared copy computed once per PMF, so its own fingerprint is memoized too.
    pub fn normalize_shared(&self) -> std::sync::Arc<Pmf> {
        if self.normalized || self.mass() == 0.0 {
            return std::sync::Arc::new(self.clone());
        }
        std::sync::Arc::clone(
            self.fp
                .normalized
                .get_or_init(|| std::sync::Arc::new(self.normalize())),
        )
    }

    /// `fingerprint()` as an owned string.
    pub fn fingerprint(&self) -> String {
        self.fingerprint_ref().to_string()
    }
}

impl Pmf {
    /// `PMF.binSegment`: one bin's part of the fingerprint, `damage:p[count labels]{attr labels}`.
    pub(crate) fn bin_segment(damage: f64, bin: &Bin) -> String {
        let mut out = String::new();
        Pmf::write_bin_segment(&mut out, damage, bin);
        out
    }

    fn write_bin_segment(out: &mut String, damage: f64, bin: &Bin) {
        out.push_str(&num_to_string(damage));
        out.push(':');
        out.push_str(&num_to_string(bin.p));
        out.push('[');
        write_label_text(out, Some(&bin.count));
        out.push_str("]{");
        write_label_text(out, bin.attr.as_ref());
        out.push('}');
    }

    /// `PMF.contentAtOrBefore(a, b)`: whether `a`'s fingerprint sorts at or before `b`'s (UTF-16
    /// order), reading no further than the first bin that differs.
    pub(crate) fn content_at_or_before(a: &Pmf, b: &Pmf) -> bool {
        if a.normalized != b.normalized {
            return !a.normalized;
        }
        let (ad, bd) = (a.support(), b.support());
        for i in 0..ad.len().min(bd.len()) {
            let (Some(abin), Some(bbin)) = (a.map.get(&ad[i]), b.map.get(&bd[i])) else {
                continue;
            };
            let x = Pmf::bin_segment(ad[i].0, abin);
            let y = Pmf::bin_segment(bd[i].0, bbin);
            if x == y {
                continue;
            }
            return segments_at_or_before(&x, i + 1 < ad.len(), &y, i + 1 < bd.len());
        }
        ad.len() <= bd.len()
    }
}

/// `x + (more_x ? ";" : "") <= y + (more_y ? ";" : "")` in UTF-16 code-unit order: comparing two
/// differing bin segments with the next fingerprint character appended is comparing the full
/// strings.
pub(crate) fn segments_at_or_before(x: &str, more_x: bool, y: &str, more_y: bool) -> bool {
    let xs = x.encode_utf16().chain(more_x.then_some(u16::from(b';')));
    let ys = y.encode_utf16().chain(more_y.then_some(u16::from(b';')));
    xs.cmp(ys) != std::cmp::Ordering::Greater
}

/// `hashText` in pmf.ts: a 64-bit text hash (two 32-bit lanes) as 16 hex digits, over UTF-16 units.
fn hash_text(text: &str) -> String {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c6ce57;
    for code in text.encode_utf16() {
        let code = u32::from(code);
        h1 = (h1 ^ code).wrapping_mul(2654435761);
        h2 = (h2 ^ code).wrapping_mul(1597334677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2246822507) ^ (h2 ^ (h2 >> 13)).wrapping_mul(3266489909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2246822507) ^ (h1 ^ (h1 >> 13)).wrapping_mul(3266489909);
    format!("{h2:08x}{h1:08x}")
}

/// `labelText` in src/pmf/dense.ts: `"label":value` sorted by label (UTF-16 order), comma separated.
pub fn label_text(m: Option<&LabelMap>) -> String {
    let mut out = String::new();
    write_label_text(&mut out, m);
    out
}

/// [`label_text`] appended to `out`, without per-label allocation for plain keys.
fn write_label_text(out: &mut String, m: Option<&LabelMap>) {
    let Some(m) = m else { return };
    let mut entries: Vec<(&String, f64)> = m.iter().map(|(k, v)| (k, *v)).collect();
    if entries.len() > 1 {
        entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    }
    for (i, (k, v)) in entries.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        if k.chars()
            .all(|c| c >= ' ' && c != '"' && c != '\\' && c != '\u{7f}')
        {
            out.push('"');
            out.push_str(k);
            out.push('"');
        } else {
            out.push_str(&serde_json::Value::String(k.clone()).to_string());
        }
        out.push(':');
        out.push_str(&num_to_string(v));
    }
}

pub use attribution::{
    AttributionPercentiles, BinRange, ChartModelOptions, DamageAttributionChartModel,
    MAX_CHART_BUCKETS,
};
pub use dense_total::DenseTotal;
pub use gaps::FirstSuccessWeights;

mod attribution;
pub mod cache;
mod constructors;
mod convolve;
pub(crate) mod dense;
mod dense_total;
mod gaps;
mod lookups;
mod mixing;
pub mod mixture;
mod outcomes;
mod power;
mod query;
mod reshape;
pub mod sample;
mod transform;

#[cfg(test)]
mod identifier_tests {
    use super::*;
    use crate::EPS;

    /// Identifiers as the TS engine reports them (`npx tsx`).
    #[test]
    fn identifiers_match_ts() {
        assert_eq!(Pmf::empty(EPS).identifier(), "empty");
        assert_eq!(Pmf::zero(EPS).identifier(), "zero");
        assert_eq!(Pmf::miss_none(EPS).identifier(), "missNone");
        assert_eq!(
            Pmf::delta(3.0, EPS).unwrap().identifier(),
            "pmf#17c8c1eee75ec953"
        );
        let p = crate::parser::parse("2d6+3").unwrap();
        assert_eq!(p.identifier(), "2d6+3");
        let a = crate::parser::parse("1d6").unwrap();
        let b = crate::parser::parse("1d4").unwrap();
        assert_eq!(
            a.convolve(&b, None, false).identifier(),
            "pmf#45dfef9440cfaa3d"
        );
        let skipped = Pmf::mix(&[(Pmf::delta(1.0, EPS).unwrap(), 0.0)], EPS).unwrap();
        assert_eq!(skipped.identifier(), "empty");
    }

    #[test]
    fn from_json_defaults_identifier() {
        let j = |id: Option<&str>| PmfJson {
            bins: vec![],
            normalized: false,
            identifier: id.map(String::from),
            epsilon: None,
        };
        assert_eq!(Pmf::from_json(j(None)).identifier(), "fromJSON");
        assert_eq!(Pmf::from_json(j(Some(""))).identifier(), "fromJSON");
        assert_eq!(Pmf::from_json(j(Some("x"))).identifier(), "x");
    }
}
