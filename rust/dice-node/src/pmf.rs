//! PMF, DiceQuery and parser handles.
//!
//! Bulk data (a PMF's bins) crosses as one JSON string (`serde_json`, exact float round trip).
//! A Rust `Err(msg)` is a thrown JS `Error(msg)`; the facade rethrows it as the TS error class.
//! No `unwrap`/`expect`/`panic` on input-reachable paths: a panic across napi aborts Node.

use std::cell::RefCell;
use std::sync::Arc;

use napi::bindgen_prelude::{
    ClassInstance, Either, Float64Array, Function, Int32Array, Uint8Array,
};
use napi_derive::napi;

use crate::{DiceError, err, thrown};
use indexmap::IndexMap;
use yipe_dice::query::{DamageStats, Labels};
use yipe_dice::{Bin, Damage, DiceQuery, LabelMap, Pmf};

fn json_err(e: serde_json::Error) -> napi::Error {
    napi::Error::from_reason(format!("dice-node: invalid PMF data: {e}"))
}

fn labels(l: Either<String, Vec<String>>) -> Labels {
    match l {
        Either::A(s) => Labels::One(s),
        Either::B(v) => Labels::Many(v),
    }
}

fn pmfs(list: &[ClassInstance<NativePmf>]) -> Vec<Pmf> {
    list.iter().map(|p| (*p.inner).clone()).collect()
}

fn pairs(
    list: &[ClassInstance<NativePmf>],
    weights: &[f64],
) -> Result<Vec<(Pmf, f64)>, napi::Error> {
    if list.len() != weights.len() {
        return Err(err(
            "dice-node: pmfs and weights differ in length".to_string()
        ));
    }
    Ok(list
        .iter()
        .zip(weights)
        .map(|(p, w)| ((*p.inner).clone(), *w))
        .collect())
}

// ---- JSON transport ----------------------------------------------------------------------------

fn push_num(out: &mut String, x: f64) {
    if x.is_nan() {
        out.push_str("\"NaN\"");
    } else if x == f64::INFINITY {
        out.push_str("\"Infinity\"");
    } else if x == f64::NEG_INFINITY {
        out.push_str("\"-Infinity\"");
    } else if x == 0.0 && x.is_sign_negative() {
        out.push_str("\"-0\"");
    } else {
        out.push_str(&format!("{x:?}"));
    }
}

fn push_str(out: &mut String, s: &str) {
    // Serializing a `&str` cannot fail; fall back to an empty string rather than panic.
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()));
}

fn push_labels(out: &mut String, m: &LabelMap) {
    out.push('{');
    for (i, (k, v)) in m.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_str(out, k);
        out.push(':');
        push_num(out, *v);
    }
    out.push('}');
}

fn push_bin(out: &mut String, bin: &Bin) {
    out.push_str("{\"p\":");
    push_num(out, bin.p);
    out.push_str(",\"count\":");
    push_labels(out, &bin.count);
    if let Some(attr) = &bin.attr {
        out.push_str(",\"attr\":");
        push_labels(out, attr);
    }
    out.push('}');
}

/// A PMF's bins as flat typed arrays, in the PMF's own map order: bin `i` has probability `p[i]`,
/// `count` entries `countStart[i]..countStart[i + 1]` and, when `hasAttr[i]`, `attr` entries
/// `attrStart[i]..attrStart[i + 1]`; entry labels index `labels`. Lossless for NaN, ±Infinity, -0.
#[napi(object)]
pub struct NativeBins {
    pub damages: Float64Array,
    pub p: Float64Array,
    pub has_attr: Uint8Array,
    pub count_start: Int32Array,
    pub count_label: Int32Array,
    pub count_value: Float64Array,
    pub attr_start: Int32Array,
    pub attr_label: Int32Array,
    pub attr_value: Float64Array,
    pub labels: Vec<String>,
}

fn bins_out(pmf: &Pmf) -> NativeBins {
    let n = pmf.map.len();
    let mut damages = Vec::with_capacity(n);
    let mut p = Vec::with_capacity(n);
    let mut has_attr = Vec::with_capacity(n);
    let mut count_start = Vec::with_capacity(n + 1);
    let mut attr_start = Vec::with_capacity(n + 1);
    let (mut count_label, mut count_value) = (Vec::new(), Vec::new());
    let (mut attr_label, mut attr_value) = (Vec::new(), Vec::new());
    let mut table: IndexMap<String, i32> = IndexMap::new();
    let index_of = |label: &str, table: &mut IndexMap<String, i32>| -> i32 {
        let next = table.len() as i32;
        *table.entry(label.to_string()).or_insert(next)
    };
    for (d, bin) in &pmf.map {
        damages.push(d.0);
        p.push(bin.p);
        count_start.push(count_label.len() as i32);
        attr_start.push(attr_label.len() as i32);
        for (k, v) in &bin.count {
            count_label.push(index_of(k, &mut table));
            count_value.push(*v);
        }
        match &bin.attr {
            Some(attr) => {
                has_attr.push(1u8);
                for (k, v) in attr {
                    attr_label.push(index_of(k, &mut table));
                    attr_value.push(*v);
                }
            }
            None => has_attr.push(0u8),
        }
    }
    count_start.push(count_label.len() as i32);
    attr_start.push(attr_label.len() as i32);
    NativeBins {
        damages: Float64Array::new(damages),
        p: Float64Array::new(p),
        has_attr: Uint8Array::new(has_attr),
        count_start: Int32Array::new(count_start),
        count_label: Int32Array::new(count_label),
        count_value: Float64Array::new(count_value),
        attr_start: Int32Array::new(attr_start),
        attr_label: Int32Array::new(attr_label),
        attr_value: Float64Array::new(attr_value),
        labels: table.into_keys().collect(),
    }
}

fn label_at(labels: &[String], i: i32) -> Result<&String, DiceError> {
    usize::try_from(i)
        .ok()
        .and_then(|i| labels.get(i))
        .ok_or_else(|| DiceError::error("dice-node: invalid PMF data: label index"))
}

fn entries(
    labels: &[String],
    start: &[i32],
    label: &[i32],
    value: &[f64],
    i: usize,
) -> Result<LabelMap, DiceError> {
    let bad = || DiceError::error("dice-node: invalid PMF data: entry range");
    let from = usize::try_from(*start.get(i).ok_or_else(bad)?).map_err(|_| bad())?;
    let to = usize::try_from(*start.get(i + 1).ok_or_else(bad)?).map_err(|_| bad())?;
    let mut m = LabelMap::new();
    for k in from..to {
        let l = label.get(k).ok_or_else(bad)?;
        m.insert(
            label_at(labels, *l)?.clone(),
            *value.get(k).ok_or_else(bad)?,
        );
    }
    Ok(m)
}

fn pmf_from_bins(
    b: &NativeBins,
    epsilon: f64,
    normalized: bool,
    identifier: Option<String>,
) -> Result<Pmf, DiceError> {
    let n = b.damages.len();
    if b.p.len() != n || b.has_attr.len() != n {
        return Err(DiceError::error("dice-node: invalid PMF data: lengths"));
    }
    let mut map = IndexMap::new();
    for i in 0..n {
        let count = entries(&b.labels, &b.count_start, &b.count_label, &b.count_value, i)?;
        let attr = if b.has_attr[i] != 0 {
            Some(entries(
                &b.labels,
                &b.attr_start,
                &b.attr_label,
                &b.attr_value,
                i,
            )?)
        } else {
            None
        };
        map.insert(
            Damage(b.damages[i]),
            Bin {
                p: b.p[i],
                count,
                attr,
            },
        );
    }
    let mut pmf = Pmf::new(map, epsilon, normalized);
    pmf.identifier = identifier;
    Ok(pmf)
}

#[napi(object)]
pub struct NativeDamageStats {
    pub min: f64,
    pub max: f64,
    pub avg: f64,
    pub count: f64,
}

impl From<DamageStats> for NativeDamageStats {
    fn from(s: DamageStats) -> Self {
        Self {
            min: s.min,
            max: s.max,
            avg: s.avg,
            count: s.count,
        }
    }
}

#[napi(object)]
pub struct NativeSeries {
    pub support: Vec<f64>,
    pub data: Vec<f64>,
}

#[napi(object)]
pub struct NativeOutcomeSnapshot {
    pub key: String,
    pub at_least_one_probability: f64,
    pub all_probability: f64,
    pub damage_min: f64,
    pub damage_avg: f64,
    pub damage_max: f64,
}

#[napi(object)]
pub struct NativeSnapshot {
    pub average_dpr: f64,
    pub damage_chance: f64,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    pub outcomes: Vec<NativeOutcomeSnapshot>,
}

#[napi]
pub struct NativePmf {
    pub(crate) inner: Arc<Pmf>,
}

impl NativePmf {
    pub(crate) fn wrap(inner: Pmf) -> Self {
        Self {
            inner: Arc::new(inner),
        }
    }

    /// A PMF the Rust caches may also hold: see [`NativePmf::shared_id`].
    pub(crate) fn wrap_shared(inner: Arc<Pmf>) -> Self {
        Self { inner }
    }
}

#[napi]
impl NativePmf {
    // ---- construction / materialization -------------------------------------------------

    /// A PMF from its bins (see [`NativeBins`]).
    #[napi(factory)]
    pub fn from_bins(
        bins: NativeBins,
        epsilon: f64,
        normalized: bool,
        identifier: Option<String>,
    ) -> napi::Result<NativePmf> {
        pmf_from_bins(&bins, epsilon, normalized, identifier)
            .map(Self::wrap)
            .map_err(thrown)
    }

    /// The bins in map order (see [`NativeBins`]).
    #[napi]
    pub fn to_bins(&self) -> NativeBins {
        bins_out(&self.inner)
    }

    /// The same PMF named `identifier` (`None` clears the name).
    #[napi]
    pub fn with_identifier(&self, identifier: Option<String>) -> NativePmf {
        let mut inner = (*self.inner).clone();
        inner.identifier = identifier;
        Self::wrap(inner)
    }

    #[napi]
    pub fn epsilon(&self) -> f64 {
        self.inner.epsilon
    }

    #[napi]
    pub fn normalized(&self) -> bool {
        self.inner.normalized
    }

    #[napi]
    pub fn identifier(&self) -> String {
        self.inner.identifier()
    }

    #[napi(factory)]
    pub fn from_map(
        keys: Vec<f64>,
        probs: Vec<f64>,
        eps: f64,
        require_integer_values: bool,
    ) -> napi::Result<NativePmf> {
        if keys.len() != probs.len() {
            return Err(err("dice-node: keys and probs differ in length".to_string()));
        }
        let m = keys
            .into_iter()
            .zip(probs)
            .map(|(k, p)| (k.into(), p))
            .collect();
        Pmf::from_map(m, eps, require_integer_values)
            .map(Self::wrap)
            .map_err(thrown)
    }

    #[napi(factory)]
    pub fn empty(eps: f64) -> NativePmf {
        Self::wrap(Pmf::empty(eps))
    }

    #[napi(factory)]
    pub fn zero(eps: f64) -> NativePmf {
        Self::wrap(Pmf::zero(eps))
    }

    #[napi(factory)]
    pub fn delta(value: f64, eps: f64) -> napi::Result<NativePmf> {
        Pmf::delta(value, eps).map(Self::wrap).map_err(thrown)
    }

    #[napi(factory)]
    pub fn miss_none(eps: f64) -> NativePmf {
        Self::wrap(Pmf::miss_none(eps))
    }

    #[napi(factory)]
    pub fn empty_mass() -> NativePmf {
        Self::wrap(Pmf::empty_mass())
    }

    // ---- static combinators ---------------------------------------------------------------

    #[napi(factory)]
    pub fn branch(success: &NativePmf, failure: &NativePmf, success_probability: f64) -> NativePmf {
        Self::wrap(Pmf::branch(
            &success.inner,
            &failure.inner,
            success_probability,
        ))
    }

    #[napi(factory)]
    pub fn with_probability(success: &NativePmf, probability: f64) -> NativePmf {
        Self::wrap(Pmf::with_probability(&success.inner, probability))
    }

    #[napi(factory)]
    pub fn exclusive(
        options: Vec<ClassInstance<NativePmf>>,
        weights: Vec<f64>,
        eps: f64,
    ) -> napi::Result<NativePmf> {
        Pmf::exclusive(&pairs(&options, &weights)?, eps)
            .map(Self::wrap)
            .map_err(thrown)
    }

    #[napi(factory)]
    pub fn mix(
        options: Vec<ClassInstance<NativePmf>>,
        weights: Vec<f64>,
        eps: f64,
    ) -> napi::Result<NativePmf> {
        Pmf::mix(&pairs(&options, &weights)?, eps)
            .map(Self::wrap)
            .map_err(thrown)
    }

    #[napi(factory)]
    pub fn mix_n(
        options: Vec<ClassInstance<NativePmf>>,
        weights: Vec<f64>,
        eps: f64,
    ) -> napi::Result<NativePmf> {
        let list: Vec<(f64, Pmf)> = pairs(&options, &weights)?
            .into_iter()
            .map(|(p, w)| (w, p))
            .collect();
        Pmf::mix_n(&list, eps).map(Self::wrap).map_err(thrown)
    }

    #[napi(factory)]
    pub fn convolve_many(list: Vec<ClassInstance<NativePmf>>, eps: f64) -> NativePmf {
        let mut items = list.iter();
        let Some(first) = items.next() else {
            return Self::wrap(Pmf::empty(eps));
        };
        let mut acc = Arc::clone(&first.inner);
        for next in items {
            acc = acc.convolve_shared(&next.inner, Some(eps), false);
        }
        Self::wrap_shared(acc)
    }

    // ---- scalar queries ---------------------------------------------------------------------

    #[napi]
    pub fn mass(&self) -> f64 {
        self.inner.mass()
    }
    #[napi]
    pub fn min(&self) -> f64 {
        self.inner.min()
    }
    #[napi]
    pub fn max(&self) -> f64 {
        self.inner.max()
    }
    #[napi]
    pub fn mean(&self) -> f64 {
        self.inner.mean()
    }
    #[napi]
    pub fn variance(&self) -> f64 {
        self.inner.variance()
    }
    #[napi]
    pub fn stdev(&self) -> f64 {
        self.inner.stdev()
    }
    #[napi]
    pub fn fingerprint(&self) -> String {
        self.inner.fingerprint()
    }
    #[napi]
    pub fn support(&self) -> Vec<f64> {
        self.inner.support().into_iter().map(|d| d.0).collect()
    }
    #[napi]
    pub fn dense_support(&self) -> Vec<f64> {
        self.inner.dense_support()
    }
    #[napi]
    pub fn has_attribution(&self) -> bool {
        self.inner.has_attribution()
    }
    #[napi]
    pub fn outcome_mass(&self, outcome: String) -> f64 {
        self.inner.outcome_mass(&outcome)
    }
    #[napi]
    pub fn face_total(&self) -> f64 {
        self.inner.face_total()
    }
    #[napi]
    pub fn outcome_at(&self, damage: f64, outcome: String) -> f64 {
        self.inner.outcome_at(damage, &outcome)
    }
    #[napi]
    pub fn outcome_attribution_at(&self, damage: f64, outcome: String) -> f64 {
        self.inner.outcome_attribution_at(damage, &outcome)
    }
    #[napi]
    pub fn has_outcome(&self, outcome: String) -> bool {
        self.inner.has_outcome(&outcome)
    }
    #[napi]
    pub fn outcomes(&self) -> Vec<String> {
        self.inner.outcomes()
    }
    #[napi]
    pub fn outcome_probability(&self, outcome: String) -> f64 {
        self.inner.outcome_probability(&outcome)
    }
    #[napi]
    pub fn p_at(&self, x: f64) -> f64 {
        self.inner.p_at(x)
    }
    #[napi]
    pub fn hit_probability(&self) -> f64 {
        self.inner.hit_probability()
    }
    #[napi]
    pub fn miss_probability(&self) -> f64 {
        self.inner.miss_probability()
    }
    #[napi]
    pub fn cdf_at(&self, x: f64) -> f64 {
        self.inner.cdf_at(x)
    }
    #[napi]
    pub fn tail_prob_ge(&self, t: f64) -> f64 {
        self.inner.tail_prob_ge(t)
    }
    #[napi]
    pub fn tail_prob_gt(&self, t: f64) -> f64 {
        self.inner.tail_prob_gt(t)
    }
    #[napi]
    pub fn quantile(&self, p: f64) -> f64 {
        self.inner.quantile(p)
    }

    /// `binAt`: JSON of `{p, count, attr?}` (numbers as in `toJson`), or null.
    #[napi]
    pub fn bin_at(&self, damage: f64) -> Option<String> {
        self.inner.bin_at(damage).map(|bin| {
            let mut out = String::new();
            push_bin(&mut out, &bin);
            out
        })
    }

    // ---- transforms --------------------------------------------------------------------------

    /// Non-zero when a Rust cache holds this very PMF too (so the same result can come back
    /// again): the address of the shared allocation, which is the result's identity. The facade
    /// keeps one JS object per id. 0 for a PMF only this handle owns.
    #[napi]
    pub fn shared_id(&self) -> f64 {
        if Arc::strong_count(&self.inner) > 1 {
            Arc::as_ptr(&self.inner) as usize as f64
        } else {
            0.0
        }
    }

    #[napi]
    pub fn convolve(&self, other: &NativePmf, eps: Option<f64>, raw: bool) -> NativePmf {
        Self::wrap_shared(self.inner.convolve_shared(&other.inner, eps, raw))
    }
    #[napi]
    pub fn convolve_raw(&self, other: &NativePmf, eps: Option<f64>) -> NativePmf {
        Self::wrap(self.inner.convolve_raw(&other.inner, eps))
    }
    #[napi]
    pub fn combine_raw(&self, other: &NativePmf, eps: Option<f64>) -> NativePmf {
        Self::wrap_shared(self.inner.convolve_shared(&other.inner, eps, true))
    }
    #[napi]
    pub fn gate(&self, p: f64, fallback: &NativePmf) -> NativePmf {
        Self::wrap(self.inner.gate(p, &fallback.inner))
    }
    #[napi]
    pub fn filter_outcome(&self, outcome: String) -> NativePmf {
        Self::wrap(self.inner.filter_outcome(&outcome))
    }
    #[napi]
    pub fn power(&self, n: f64, eps: Option<f64>) -> napi::Result<NativePmf> {
        self.inner
            .power_shared(n, eps)
            .map(Self::wrap_shared)
            .map_err(thrown)
    }
    #[napi]
    pub fn max_of_two(&self) -> NativePmf {
        Self::wrap(self.inner.max_of_two())
    }
    #[napi]
    pub fn with_attribution(&self) -> NativePmf {
        Self::wrap(self.inner.with_attribution())
    }
    #[napi]
    pub fn compact(&self, eps: Option<f64>, keep_final_bin: bool) -> NativePmf {
        Self::wrap(self.inner.compact(eps, keep_final_bin))
    }
    #[napi]
    pub fn apply_hit_frequency(&self, frequency: f64) -> NativePmf {
        Self::wrap(self.inner.apply_hit_frequency(frequency))
    }
    #[napi]
    pub fn split_by_dealt(&self) -> Vec<NativePmf> {
        let (a, b) = self.inner.split_by_dealt();
        vec![Self::wrap(a), Self::wrap(b)]
    }
    /// `mapDamage`; a throw inside `f` is rethrown after the map finishes.
    #[napi]
    pub fn map_damage(&self, f: Function<f64, f64>) -> napi::Result<NativePmf> {
        let failure: RefCell<Option<napi::Error>> = RefCell::new(None);
        let out = self.inner.map_damage(|v| {
            if failure.borrow().is_some() {
                return f64::NAN;
            }
            match f.call(v) {
                Ok(x) => x,
                Err(e) => {
                    *failure.borrow_mut() = Some(e);
                    f64::NAN
                }
            }
        });
        match failure.into_inner() {
            Some(e) => Err(e),
            None => Ok(Self::wrap(out)),
        }
    }
    #[napi]
    pub fn scale_damage(
        &self,
        factor: f64,
        rounding: String,
        denominator: f64,
    ) -> napi::Result<NativePmf> {
        self.inner
            .scale_damage(factor, &rounding, denominator)
            .map(Self::wrap)
            .map_err(thrown)
    }
    #[napi]
    pub fn prune(&self, eps_rel: f64, min_bins: f64) -> NativePmf {
        Self::wrap(self.inner.prune(eps_rel, min_bins))
    }
    #[napi]
    pub fn rebin(&self, max_buckets: f64) -> NativePmf {
        Self::wrap(self.inner.rebin(max_buckets))
    }
    #[napi]
    pub fn normalize(&self) -> NativePmf {
        Self::wrap(self.inner.normalize())
    }
    #[napi]
    pub fn scale_mass(&self, factor: f64) -> NativePmf {
        Self::wrap(self.inner.scale_mass(factor))
    }
    #[napi]
    pub fn add(&self, other: &NativePmf) -> NativePmf {
        Self::wrap(self.inner.add(&other.inner))
    }
    #[napi]
    pub fn add_scaled(&self, branch: &NativePmf, probability: f64) -> NativePmf {
        Self::wrap(self.inner.add_scaled(&branch.inner, probability))
    }
}

fn attribution_json(q: &DiceQuery) -> napi::Result<String> {
    let by = q.attribution_by_value();
    let rows: Vec<(String, Vec<(f64, f64)>)> = by
        .into_iter()
        .map(|(label, m)| (label, m.into_iter().map(|(d, p)| (d.0, p)).collect()))
        .collect();
    serde_json::to_string(&rows).map_err(json_err)
}

#[napi]
pub struct NativeQuery {
    pub(crate) inner: DiceQuery,
}

impl NativeQuery {
    pub(crate) fn wrap(inner: DiceQuery) -> Self {
        Self { inner }
    }
}

#[napi]
impl NativeQuery {
    #[napi(constructor)]
    pub fn new(
        singles: Vec<ClassInstance<NativePmf>>,
        combined: Option<&NativePmf>,
        eps: f64,
    ) -> Self {
        Self::wrap(DiceQuery::new(
            pmfs(&singles),
            combined.map(|c| (*c.inner).clone()),
            eps,
        ))
    }

    #[napi]
    pub fn singles(&self) -> Vec<NativePmf> {
        self.inner
            .singles
            .iter()
            .cloned()
            .map(NativePmf::wrap)
            .collect()
    }
    #[napi]
    pub fn combined(&self) -> NativePmf {
        NativePmf::wrap(self.inner.combined().clone())
    }
    #[napi]
    pub fn combined_with_attribution(&self) -> NativePmf {
        NativePmf::wrap(self.inner.combined_with_attribution())
    }
    #[napi]
    pub fn attribution_by_value(&self) -> napi::Result<String> {
        attribution_json(&self.inner)
    }
    #[napi]
    pub fn count_singles_with(&self, label: String) -> f64 {
        self.inner.count_singles_with(&label)
    }
    #[napi]
    pub fn mean(&self) -> f64 {
        self.inner.mean()
    }
    #[napi]
    pub fn variance(&self) -> f64 {
        self.inner.variance()
    }
    #[napi]
    pub fn stddev(&self) -> f64 {
        self.inner.stddev()
    }
    #[napi]
    pub fn cdf(&self, x: f64) -> f64 {
        self.inner.cdf(x)
    }
    #[napi]
    pub fn prob_total_at_most(&self, x: f64) -> f64 {
        self.inner.prob_total_at_most(x)
    }
    #[napi]
    pub fn ccdf(&self, x: f64) -> f64 {
        self.inner.ccdf(x)
    }
    #[napi]
    pub fn prob_total_at_least(&self, threshold: f64) -> f64 {
        self.inner.prob_total_at_least(threshold)
    }
    #[napi]
    pub fn percentiles(&self, values: Vec<f64>) -> Vec<f64> {
        self.inner.percentiles(&values)
    }
    #[napi]
    pub fn min(&self) -> f64 {
        self.inner.min()
    }
    #[napi]
    pub fn max(&self) -> f64 {
        self.inner.max()
    }
    #[napi]
    pub fn miss_chance(&self) -> f64 {
        self.inner.miss_chance()
    }
    #[napi]
    pub fn prob_damage_greater_than(&self, threshold: f64) -> f64 {
        self.inner.prob_damage_greater_than(threshold)
    }
    #[napi]
    pub fn total_mass(&self) -> f64 {
        self.inner.total_mass()
    }
    #[napi]
    pub fn prob_at_least_k(&self, l: Either<String, Vec<String>>, k: f64) -> f64 {
        self.inner.prob_at_least_k(labels(l), k)
    }
    #[napi]
    pub fn prob_at_least_one(&self, l: Either<String, Vec<String>>) -> f64 {
        self.inner.prob_at_least_one(labels(l))
    }
    #[napi]
    pub fn prob_exactly_k(&self, l: Either<String, Vec<String>>, k: f64) -> napi::Result<f64> {
        self.inner.prob_exactly_k(labels(l), k).map_err(thrown)
    }
    #[napi]
    pub fn prob_at_most_k(&self, l: Either<String, Vec<String>>, k: f64) -> napi::Result<f64> {
        self.inner.prob_at_most_k(labels(l), k).map_err(thrown)
    }
    #[napi]
    pub fn expected_damage_from(&self, l: Either<String, Vec<String>>) -> f64 {
        self.inner.expected_damage_from(labels(l))
    }
    #[napi]
    pub fn damage_stats_from(&self, l: Either<String, Vec<String>>) -> NativeDamageStats {
        self.inner.damage_stats_from(labels(l)).into()
    }
    #[napi]
    pub fn combined_damage_stats(&self, target_label: String) -> NativeDamageStats {
        self.inner.combined_damage_stats(&target_label).into()
    }
    #[napi]
    pub fn probability_of(&self, l: Either<String, Vec<String>>) -> f64 {
        self.inner.probability_of(labels(l))
    }
    #[napi]
    pub fn first_success_split(
        &self,
        success: Either<String, Vec<String>>,
        subset: Either<String, Vec<String>>,
        eps: f64,
    ) -> napi::Result<Vec<f64>> {
        self.inner
            .first_success_split(&labels(success), &labels(subset), eps)
            .map(|a| a.to_vec())
            .map_err(thrown)
    }

    /// Flat `[x0, y0, x1, y1, ...]`.
    #[napi]
    pub fn to_chart_series(&self) -> Vec<f64> {
        self.inner
            .to_chart_series()
            .into_iter()
            .flat_map(|(x, y)| [x, y])
            .collect()
    }
    #[napi]
    pub fn to_cdf_series(&self, as_percentages: bool) -> NativeSeries {
        let s = self.inner.to_cdf_series(as_percentages);
        NativeSeries {
            support: s.support,
            data: s.data,
        }
    }
    #[napi]
    pub fn to_ccdf_series(&self, as_percentages: bool) -> NativeSeries {
        let s = self.inner.to_ccdf_series(as_percentages);
        NativeSeries {
            support: s.support,
            data: s.data,
        }
    }
    #[napi]
    pub fn outcome_keys(&self, order: Option<Vec<String>>) -> Vec<String> {
        self.inner.outcome_keys(order.as_deref())
    }
    #[napi]
    pub fn snapshot(&self, order: Option<Vec<String>>) -> NativeSnapshot {
        let s = self.inner.snapshot(order.as_deref());
        NativeSnapshot {
            average_dpr: s.average_dpr,
            damage_chance: s.damage_chance,
            p25: s.p25,
            p50: s.p50,
            p75: s.p75,
            outcomes: s
                .outcomes
                .into_iter()
                .map(|(key, o)| NativeOutcomeSnapshot {
                    key,
                    at_least_one_probability: o.at_least_one_probability,
                    all_probability: o.all_probability,
                    damage_min: o.damage_min,
                    damage_avg: o.damage_avg,
                    damage_max: o.damage_max,
                })
                .collect(),
        }
    }
    #[napi]
    pub fn normalize(&self) -> NativeQuery {
        Self::wrap(self.inner.normalize())
    }
    #[napi]
    pub fn compact(&self, eps: Option<f64>, keep_final_bin: bool) -> NativeQuery {
        Self::wrap(self.inner.compact(eps, keep_final_bin))
    }
    #[napi]
    pub fn add_scaled(&self, branch: &NativeQuery, probability: f64) -> NativeQuery {
        Self::wrap(self.inner.add_scaled(&branch.inner, probability))
    }
    #[napi]
    pub fn scale_mass(&self, factor: f64) -> NativeQuery {
        Self::wrap(self.inner.scale_mass(factor))
    }
    #[napi]
    pub fn convolve(&self, other: &NativeQuery) -> NativeQuery {
        Self::wrap(self.inner.convolve(&other.inner))
    }
}

// ---- parser -------------------------------------------------------------------------------------

#[napi]
pub fn parse(expression: String, n: f64) -> napi::Result<NativePmf> {
    yipe_dice::parser::parse_shared(&expression, n)
        .map(NativePmf::wrap_shared)
        .map_err(thrown)
}

#[napi]
pub fn try_parse(expression: String) -> napi::Result<NativePmf> {
    yipe_dice::parser::try_parse(&expression)
        .map(NativePmf::wrap)
        .map_err(thrown)
}

#[napi]
pub fn with_roll_type(expression: String, roll_type: String) -> napi::Result<String> {
    yipe_dice::parser::with_roll_type(&expression, &roll_type).map_err(thrown)
}

#[napi]
pub fn scale_parsed_dice(expression: String, scale: f64) -> napi::Result<String> {
    yipe_dice::parser::scale_parsed_dice(&expression, scale).map_err(thrown)
}

// ---- attribution, chart models, tables, mapping (ported in rust/dice) ---------------------------

#[napi(object)]
pub struct JsKeyedSeries {
    pub key: String,
    pub values: Vec<f64>,
}

#[napi(object)]
pub struct JsBinRange {
    pub start: f64,
    pub end: f64,
}

#[napi(object)]
pub struct JsPercentiles {
    pub p80: f64,
    pub p50: f64,
    pub p20: f64,
}

#[napi(object)]
pub struct JsChartModel {
    pub labels: Vec<f64>,
    pub bin_ranges: Option<Vec<JsBinRange>>,
    pub outcomes: Vec<String>,
    pub series: Vec<JsKeyedSeries>,
    pub shares: Vec<JsKeyedSeries>,
    pub totals: Vec<f64>,
    pub percentiles: JsPercentiles,
    pub mean: f64,
}

#[napi(object)]
pub struct JsFirstSuccessWeights {
    pub p_specific_success: f64,
    pub p_general_success: f64,
    pub p_none: f64,
    pub p_any: f64,
}

#[napi(object)]
pub struct JsKeyValue {
    pub key: String,
    pub value: f64,
}

#[napi(object)]
pub struct JsDamageRange {
    pub key: String,
    pub min: f64,
    pub avg: f64,
    pub max: f64,
}

#[napi(object)]
pub struct JsStackedData {
    pub labels: Vec<f64>,
    pub datasets: Vec<JsKeyedSeries>,
}

fn keyed(m: IndexMap<String, Vec<f64>>) -> Vec<JsKeyedSeries> {
    m.into_iter()
        .map(|(key, values)| JsKeyedSeries { key, values })
        .collect()
}

/// Runs a JS `f64 -> f64` callback inside a Rust loop; the first throw is held and rethrown.
struct Callback<'a, 'f> {
    f: &'a Function<'f, f64, f64>,
    failure: RefCell<Option<napi::Error>>,
}

impl Callback<'_, '_> {
    fn call(&self, v: f64) -> f64 {
        if self.failure.borrow().is_some() {
            return f64::NAN;
        }
        match self.f.call(v) {
            Ok(x) => x,
            Err(e) => {
                *self.failure.borrow_mut() = Some(e);
                f64::NAN
            }
        }
    }

    fn finish<T>(self, out: Result<T, DiceError>) -> napi::Result<T> {
        match self.failure.into_inner() {
            Some(e) => Err(e),
            None => out.map_err(thrown),
        }
    }
}

fn rounding_of(s: &str) -> napi::Result<yipe_dice::builder::nodes::Rounding> {
    crate::roll::rounding(s)
}

#[napi]
impl NativePmf {
    /// `attributionByValue`: `[[label, [[damage, mass], ...]], ...]` as nested arrays of numbers.
    #[napi]
    pub fn attribution_by_value(&self) -> Vec<JsKeyedSeries> {
        self.inner
            .attribution_by_value()
            .into_iter()
            .map(|(key, m)| JsKeyedSeries {
                key,
                values: m.into_iter().flat_map(|(d, p)| [d.0, p]).collect(),
            })
            .collect()
    }

    #[napi]
    pub fn damage_attribution_chart_model(
        &self,
        max_buckets: Option<f64>,
        stack_order: Option<Vec<String>>,
        epsilon: Option<f64>,
    ) -> napi::Result<JsChartModel> {
        let options = yipe_dice::pmf::ChartModelOptions {
            max_buckets,
            stack_order,
            epsilon,
        };
        let m = self
            .inner
            .damage_attribution_chart_model(&options)
            .map_err(thrown)?;
        Ok(JsChartModel {
            labels: m.labels,
            bin_ranges: m.bin_ranges.map(|v| {
                v.into_iter()
                    .map(|r| JsBinRange {
                        start: r.start,
                        end: r.end,
                    })
                    .collect()
            }),
            outcomes: m.outcomes,
            series: keyed(m.series),
            shares: keyed(m.shares),
            totals: m.totals,
            percentiles: JsPercentiles {
                p80: m.percentiles.p80,
                p50: m.percentiles.p50,
                p20: m.percentiles.p20,
            },
            mean: m.mean,
        })
    }

    /// `splitByFactor(f)`: `f` is clamped to [0, 1] by Rust.
    #[napi]
    pub fn split_by_factor(&self, factor: Function<f64, f64>) -> napi::Result<Vec<NativePmf>> {
        let cb = Callback {
            f: &factor,
            failure: RefCell::new(None),
        };
        let (a, b) = self.inner.split_by_factor(|d| cb.call(d));
        cb.finish(Ok(vec![Self::wrap(a), Self::wrap(b)]))
    }

    #[napi]
    pub fn map_values(
        &self,
        f: Function<f64, f64>,
        eps: f64,
        rounding: Option<String>,
        preserve_counts: bool,
    ) -> napi::Result<NativePmf> {
        let rounding = match rounding.as_deref() {
            None | Some("none") => None,
            Some(r) => Some(rounding_of(r)?),
        };
        let cb = Callback {
            f: &f,
            failure: RefCell::new(None),
        };
        let out = self
            .inner
            .map_values(|v| cb.call(v), eps, rounding, preserve_counts);
        cb.finish(out).map(Self::wrap)
    }

    #[napi]
    pub fn first_success_weights(
        p_success: f64,
        p_special: f64,
        n: f64,
    ) -> napi::Result<JsFirstSuccessWeights> {
        let w = Pmf::first_success_weights(p_success, p_special, n).map_err(thrown)?;
        Ok(JsFirstSuccessWeights {
            p_specific_success: w.p_specific_success,
            p_general_success: w.p_general_success,
            p_none: w.p_none,
            p_any: w.p_any,
        })
    }
}

#[napi]
impl NativeQuery {
    /// `toLabeledTable(labels)`: one row per damage value as `[damage, total, ...]`-free entries:
    /// each row is its `[key, value]` pairs flattened as keyed series of one value (key order kept).
    #[napi]
    pub fn to_labeled_table(&self, labels: Vec<String>) -> Vec<Vec<JsKeyValue>> {
        self.inner
            .to_labeled_table(&labels)
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|(key, value)| JsKeyValue { key, value })
                    .collect()
            })
            .collect()
    }

    #[napi]
    pub fn to_stacked_chart_data(&self, labels: Vec<String>, epsilon: f64) -> JsStackedData {
        let d = self.inner.to_stacked_chart_data(&labels, epsilon);
        JsStackedData {
            labels: d.labels,
            datasets: d
                .datasets
                .into_iter()
                .map(|s| JsKeyedSeries {
                    key: s.label,
                    values: s.data,
                })
                .collect(),
        }
    }

    #[napi]
    pub fn outcome_totals(&self, outcomes: Option<Vec<String>>) -> Vec<JsKeyValue> {
        self.inner
            .outcome_totals(outcomes.as_deref())
            .into_iter()
            .map(|(key, value)| JsKeyValue { key, value })
            .collect()
    }

    #[napi]
    pub fn outcome_damage_ranges(&self, outcomes: Option<Vec<String>>) -> Vec<JsDamageRange> {
        self.inner
            .outcome_damage_ranges(outcomes.as_deref())
            .into_iter()
            .map(|(key, r)| JsDamageRange {
                key,
                min: r.min,
                avg: r.avg,
                max: r.max,
            })
            .collect()
    }

    #[napi]
    pub fn outcome_stats(
        &self,
        outcomes: Option<Vec<String>>,
    ) -> napi::Result<Vec<NativeOutcomeSnapshot>> {
        let stats = self
            .inner
            .outcome_stats(outcomes.as_deref())
            .map_err(thrown)?;
        Ok(stats
            .into_iter()
            .map(|(key, o)| NativeOutcomeSnapshot {
                key,
                at_least_one_probability: o.at_least_one_probability,
                all_probability: o.all_probability,
                damage_min: o.damage_min,
                damage_avg: o.damage_avg,
                damage_max: o.damage_max,
            })
            .collect())
    }
}

// ---- caches -----------------------------------------------------------------------------------

/// `setCachingEnabled`: off empties the Rust caches and stops them storing.
#[napi]
pub fn set_caching_enabled(enabled: bool) {
    yipe_dice::common::set_caching_enabled(enabled);
}

#[napi]
pub fn get_caching_enabled() -> bool {
    yipe_dice::common::get_caching_enabled()
}

fn cache_named(name: &str) -> napi::Result<&'static yipe_dice::pmf::cache::PmfCache> {
    use yipe_dice::pmf::cache::*;
    Ok(match name {
        "pmf" => &PMF_CACHE,
        "parse" => &PARSE_CACHE,
        "builder" => &BUILDER_CACHE,
        "singleDie" => &SINGLE_DIE_CACHE,
        "d20Lift" => &D20_LIFT_CACHE,
        "roll" => &ROLL_CACHE,
        "attack" => &ATTACK_CACHE,
        "missRerolled" => &MISS_REROLLED_CACHE,
        "dc" => &DC_CACHE,
        "save" => &SAVE_CACHE,
        other => return Err(err(format!("dice-node: unknown cache {other:?}"))),
    })
}

/// Empties the named cache: `pmf`, `parse`, `builder`, `singleDie`, `d20Lift`, `roll`, `attack`,
/// `missRerolled`, `dc`, `save` (the TS `clear*Cache` functions).
#[napi]
pub fn clear_cache(name: String) -> napi::Result<()> {
    cache_named(&name)?.clear();
    Ok(())
}

/// The number of entries in the named cache (`cache.size`).
#[napi]
pub fn cache_size(name: String) -> napi::Result<f64> {
    Ok(cache_named(&name)?.len() as f64)
}

/// `setMissRerolledCacheEnabled`.
#[napi]
pub fn set_miss_rerolled_cache_enabled(enabled: bool) {
    yipe_dice::pmf::cache::set_miss_rerolled_cache_enabled(enabled);
}
