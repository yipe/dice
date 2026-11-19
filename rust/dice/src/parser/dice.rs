//! Port of `src/parser/dice.ts` (class `Dice`): the parsed expression's value and its PMF.
//!
//! `Dist` reproduces a JS object keyed by numbers: array-index keys (integers 0..=2^32-2) iterate
//! first in ascending order, every other key (negatives, fractions, NaN) after them in insertion
//! order. That order decides float summation order and which bin is "last", so it is kept exactly.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use indexmap::IndexMap;

use crate::error::DiceError;
use crate::js::num_to_string;
use crate::pmf::{Bin, LabelMap};
use crate::{Damage, Pmf};

/// Work budget for a single dice×dice operation (dice.ts:21).
const MAX_BINARY_OUTCOMES: f64 = 100_000_000.0;

/// Integer keys below this live in a dense vector; larger array-index keys in a `BTreeMap`.
const DENSE_CAP: usize = 1 << 20;
const MAX_INDEX: f64 = 4_294_967_294.0;

/// A parser throw: a [`DiceError`] (`Error`, `DiceParseError`, `RangeError` or `TypeError`).
pub type R<T> = Result<T, DiceError>;

fn index_key(k: f64) -> Option<u32> {
    if (0.0..=MAX_INDEX).contains(&k) && k.fract() == 0.0 {
        Some(k as u32)
    } else {
        None
    }
}

fn canon_bits(k: f64) -> u64 {
    if k.is_nan() {
        f64::NAN.to_bits()
    } else {
        k.to_bits()
    }
}

/// JS truthiness of a number.
pub fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// `DamageDistribution`: a JS object from number keys to counts.
#[derive(Clone, Default)]
pub struct Dist {
    dense: Vec<f64>,
    present: Vec<bool>,
    dense_count: usize,
    sparse: BTreeMap<u32, f64>,
    others: Vec<(f64, f64)>,
    other_idx: HashMap<u64, usize>,
    /// For a negative integer key -i: 1 + its position in `others`, at index i; 0 for none.
    neg_idx: Vec<u32>,
}

impl Dist {
    pub fn new() -> Dist {
        Dist::default()
    }

    /// `{ [key]: value }`.
    pub fn single(key: f64, value: f64) -> Dist {
        let mut d = Dist::new();
        d.set(key, value);
        d
    }

    fn other_pos(&self, k: f64) -> Option<usize> {
        if k < 0.0 && k.fract() == 0.0 && -k < DENSE_CAP as f64 {
            let i = (-k) as usize;
            self.neg_idx
                .get(i)
                .copied()
                .filter(|&v| v != 0)
                .map(|v| v as usize - 1)
        } else {
            self.other_idx.get(&canon_bits(k)).copied()
        }
    }

    pub fn get(&self, k: f64) -> Option<f64> {
        match index_key(k) {
            Some(i) if (i as usize) < DENSE_CAP => {
                let i = i as usize;
                if self.present.get(i).copied().unwrap_or(false) {
                    self.dense.get(i).copied()
                } else {
                    None
                }
            }
            Some(i) => self.sparse.get(&i).copied(),
            None => self.other_pos(k).map(|p| self.others[p].1),
        }
    }

    pub fn set(&mut self, k: f64, v: f64) {
        match index_key(k) {
            Some(i) if (i as usize) < DENSE_CAP => {
                let i = i as usize;
                if i >= self.dense.len() {
                    self.dense.resize(i + 1, 0.0);
                    self.present.resize(i + 1, false);
                }
                if !self.present[i] {
                    self.present[i] = true;
                    self.dense_count += 1;
                }
                self.dense[i] = v;
            }
            Some(i) => {
                self.sparse.insert(i, v);
            }
            None => {
                if let Some(p) = self.other_pos(k) {
                    self.others[p].1 = v;
                } else {
                    let pos = self.others.len();
                    self.others.push((k, v));
                    if k < 0.0 && k.fract() == 0.0 && -k < DENSE_CAP as f64 {
                        let i = (-k) as usize;
                        if i >= self.neg_idx.len() {
                            self.neg_idx.resize(i + 1, 0);
                        }
                        self.neg_idx[i] = pos as u32 + 1;
                    } else {
                        self.other_idx.insert(canon_bits(k), pos);
                    }
                }
            }
        }
    }

    /// `d[k] = (d[k] || 0) + count`.
    pub fn increment(&mut self, k: f64, count: f64) {
        let cur = self.get(k).filter(|c| truthy(*c)).unwrap_or(0.0);
        self.set(k, cur + count);
    }

    /// `Object.entries(d)` with keys as numbers, in JS order.
    pub fn entries(&self) -> Vec<(f64, f64)> {
        let mut out = Vec::with_capacity(self.len());
        for (i, v) in self.dense.iter().enumerate() {
            if self.present[i] {
                out.push((i as f64, *v));
            }
        }
        out.extend(self.sparse.iter().map(|(k, v)| (f64::from(*k), *v)));
        out.extend(self.others.iter().copied());
        out
    }

    pub fn len(&self) -> usize {
        self.dense_count + self.sparse.len() + self.others.len()
    }

    /// `Object.values(d).reduce((s, v) => s + v, 0)`.
    pub fn total(&self) -> f64 {
        let mut sum = 0.0;
        for (i, v) in self.dense.iter().enumerate() {
            if self.present[i] {
                sum += *v;
            }
        }
        for v in self.sparse.values() {
            sum += *v;
        }
        for (_, v) in &self.others {
            sum += *v;
        }
        sum
    }
}

/// `Math.max(a, b)`.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// A `Dice | number` operand.
#[derive(Clone, Copy)]
pub enum Other<'a> {
    Num(f64),
    Dice(&'a Dice),
}

/// `CritTrack` (dice.ts:63).
pub struct CritTrack {
    pub sides: f64,
    pub bare: bool,
    pub slice: Rc<dyn Fn(f64) -> R<Dice>>,
}

#[derive(Clone, Copy)]
pub struct Keep {
    pub kept: f64,
    pub lowest: bool,
}

/// `DicePrivateData` (dice.ts:24).
#[derive(Clone, Default)]
pub struct PrivateData {
    pub is_dc_check: bool,
    pub keep: Option<Keep>,
    pub crit_track: Option<Rc<CritTrack>>,
    pub untracked_sides: Option<f64>,
    pub no_die: bool,
    pub branches: Option<Rc<Vec<Dice>>>,
    pub is_ac_check: bool,
    /// `implicitCrit.payload`.
    pub implicit_crit: Option<String>,
    pub attack_payload: bool,
}

#[derive(Clone, Default)]
pub struct DiceData {
    faces: Dist,
    pub private_data: PrivateData,
    outcome_data: IndexMap<String, Dist>,
    pub identifier: Option<String>,
}

/// A parsed value. Boxed so a `Dice` (and every `Result` holding one) is a pointer: the recursive
/// descent keeps many of them live per nesting level, and a debug build gives each its own slot.
#[derive(Clone, Default)]
pub struct Dice(Box<DiceData>);

impl std::ops::Deref for Dice {
    type Target = DiceData;
    fn deref(&self) -> &DiceData {
        &self.0
    }
}

impl std::ops::DerefMut for Dice {
    fn deref_mut(&mut self) -> &mut DiceData {
        &mut self.0
    }
}

impl Dice {
    /// `new Dice(x)`: faces 1..=x with count 1.
    pub fn new(x: f64) -> Dice {
        let mut d = Dice::default();
        if x <= 0.0 {
            return d;
        }
        let mut i = 1.0;
        while i <= x {
            d.faces.set(i, 1.0);
            i += 1.0;
        }
        d
    }

    pub fn scalar(value: f64) -> Dice {
        let mut result = Dice::default();
        result.increment(value, 1.0);
        result
    }

    /// `getFullOutcomeDistribution()`.
    pub fn outcomes(&self) -> &IndexMap<String, Dist> {
        &self.outcome_data
    }

    pub fn set_outcome_distribution(&mut self, key: &str, data: Dist) {
        self.outcome_data.insert(key.to_string(), data);
    }

    pub fn get_outcome_count(&self, key: &str, face: f64) -> f64 {
        self.outcome_data
            .get(key)
            .and_then(|d| d.get(face))
            .unwrap_or(0.0)
    }

    fn outcome(&self, key: &str) -> Option<&Dist> {
        self.outcome_data.get(key)
    }

    /// `calculateHitDistribution()`.
    pub fn calculate_hit_distribution(&self) -> Dist {
        let mut hit_values = Dist::new();
        let subtracted: [Option<&Dist>; 6] = [
            self.outcome("crit"),
            self.outcome("missNone"),
            self.outcome("missDamage"),
            self.outcome("saveHalf"),
            self.outcome("saveFail"),
            self.outcome("pc"),
        ];
        for (num_face, total_count) in self.faces.entries() {
            let mut hit_count = total_count;
            for distribution in subtracted.iter().flatten() {
                if let Some(c) = distribution.get(num_face).filter(|c| truthy(*c)) {
                    hit_count -= c;
                }
            }
            if num_face == 0.0 {
                hit_count = self.outcome("hit").and_then(|d| d.get(0.0)).unwrap_or(0.0);
            }
            if hit_count < 0.0 {
                hit_count = 0.0;
            }
            hit_values.set(num_face, hit_count);
        }
        hit_values
    }

    fn binary_op(&self, other: Other, op: impl Fn(f64, f64) -> f64, mut result: Dice) -> R<Dice> {
        let keys1 = self.faces.entries();
        match other {
            Other::Num(b) => {
                for (key1, value1) in keys1 {
                    result.increment(op(key1, b), value1);
                }
            }
            Other::Dice(o) => {
                let keys2 = o.faces.entries();
                if (keys1.len() as f64) * (keys2.len() as f64) > MAX_BINARY_OUTCOMES {
                    return Err(DiceError::dice_parse(format!(
                        "Dice operation over {}×{} face pairs exceeds the maximum of {}",
                        keys1.len(),
                        keys2.len(),
                        num_to_string(MAX_BINARY_OUTCOMES)
                    )));
                }
                for (key1, value1) in &keys1 {
                    for (key2, value2) in &keys2 {
                        result.increment(op(*key1, *key2), value1 * value2);
                    }
                }
            }
        }
        Ok(result)
    }

    pub fn get_face_entries(&self) -> Vec<(f64, f64)> {
        self.faces.entries()
    }

    pub fn get_face_map(&self) -> Dist {
        self.faces.clone()
    }

    /// `get(face)`.
    pub fn get(&self, face: f64) -> f64 {
        self.faces.get(face).unwrap_or(0.0)
    }

    pub fn keys(&self) -> Vec<f64> {
        self.faces.entries().into_iter().map(|(k, _)| k).collect()
    }

    pub fn total(&self) -> f64 {
        self.faces.total()
    }

    pub fn set_face(&mut self, key: f64, value: f64) {
        self.faces.set(key, value);
    }

    pub fn max_face(&self) -> R<f64> {
        let keys = self.keys();
        let Some(first) = keys.first() else {
            return Err(DiceError::error("No numeric faces found"));
        };
        Ok(keys.iter().fold(*first, |a, b| js_max(a, *b)))
    }

    pub fn min_face(&self) -> R<f64> {
        let keys = self.keys();
        let Some(first) = keys.first() else {
            return Err(DiceError::error("No numeric faces found"));
        };
        Ok(keys.iter().fold(*first, |a, b| js_min(a, *b)))
    }

    pub fn increment(&mut self, face: f64, count: f64) {
        self.faces.increment(face, count);
    }

    /// Scales every face count, and every outcome's counts with it.
    pub fn normalize(&self, scalar: f64) -> Dice {
        let mut result = Dice::default();
        for (face, count) in self.faces.entries() {
            result.faces.set(face, count * scalar);
        }
        result.private_data = self.private_data.clone();
        for (key, distribution) in &self.outcome_data {
            let mut scaled = Dist::new();
            for (face, count) in distribution.entries() {
                scaled.set(face, count * scalar);
            }
            result.outcome_data.insert(key.clone(), scaled);
        }
        result
    }

    // OPERATIONS

    pub fn add(&self, other: Other) -> R<Dice> {
        self.binary_op(other, |a, b| a + b, Dice::default())
    }

    pub fn subtract(&self, other: Other) -> R<Dice> {
        self.binary_op(other, |a, b| a - b, Dice::default())
    }

    pub fn conditional_apply(&self, other: Other) -> R<Dice> {
        self.binary_op(
            other,
            |a, b| (if a == 0.0 { 0.0 } else { 1.0 }) * b,
            Dice::default(),
        )
    }

    pub fn multiply(&self, other: Other) -> R<Dice> {
        self.binary_op(other, |a, b| a * b, Dice::default())
    }

    pub fn add_non_zero(&self, other: Other) -> R<Dice> {
        self.binary_op(
            other,
            |a, b| if a != 0.0 { a + b } else { a },
            Dice::default(),
        )
    }

    pub fn eq(&self, other: Other) -> R<Dice> {
        self.binary_op(
            other,
            |a, b| if a == b { 1.0 } else { 0.0 },
            Dice::default(),
        )
    }

    pub fn max(&self, other: Other) -> R<Dice> {
        self.binary_op(other, js_max, Dice::default())
    }

    pub fn min(&self, other: Other) -> R<Dice> {
        self.binary_op(other, js_min, Dice::default())
    }

    pub fn advantage(&self) -> R<Dice> {
        self.max(Other::Dice(self))
    }

    pub fn divide_round_up(&self, other: Other) -> R<Dice> {
        self.assert_non_zero_divisor(other)?;
        self.binary_op(
            other,
            |a, b| if b == 0.0 { 0.0 } else { (a / b).ceil() },
            Dice::default(),
        )
    }

    pub fn divide_round_down(&self, other: Other) -> R<Dice> {
        self.assert_non_zero_divisor(other)?;
        self.binary_op(
            other,
            |a, b| if b == 0.0 { 0.0 } else { (a / b).floor() },
            Dice::default(),
        )
    }

    fn assert_non_zero_divisor(&self, other: Other) -> R<()> {
        let zero = match other {
            Other::Num(x) => x == 0.0,
            Other::Dice(d) => d.get(0.0) > 0.0,
        };
        if zero {
            return Err(DiceError::dice_parse(
                "Division by zero: the divisor can be 0",
            ));
        }
        Ok(())
    }

    fn check_target(&self, other: Other, logic: impl Fn(f64, f64) -> f64) -> R<Dice> {
        let mut result = Dice::default();
        result.increment(0.0, 0.0);
        result.increment(1.0, 0.0);
        self.binary_op(other, logic, result)
    }

    pub fn dc(&self, other: Other) -> R<Dice> {
        let mut result = self.check_target(other, |a, b| if a >= b { 0.0 } else { 1.0 })?;
        result.private_data.is_dc_check = true;
        Ok(result)
    }

    /// An attack check: a total that meets the target lands at its own value, a miss is 0.
    pub fn ac(&self, other: Other) -> R<Dice> {
        let mut result = self.check_target(other, |a, b| if a >= b { a } else { 0.0 })?;
        let zero = self.get(0.0);
        if zero > 0.0 {
            let mut met = 0.0;
            match other {
                Other::Num(t) => met = if t <= 0.0 { 1.0 } else { 0.0 },
                Other::Dice(o) => {
                    for (target, count) in o.get_face_entries() {
                        if target <= 0.0 {
                            met += count;
                        }
                    }
                }
            }
            if met > 0.0 {
                result.set_outcome_distribution("hit", Dist::single(0.0, zero * met));
            }
        }
        Ok(result)
    }

    pub fn delete_face(&self, face: f64) -> Dice {
        let mut result = Dice::default();
        for (key, value) in self.faces.entries() {
            if key != face {
                result.increment(key, value);
            }
        }
        result.private_data = self.private_data.clone();
        result.outcome_data.clone_from(&self.outcome_data);
        result
    }

    /// Roll once and, on a result in `to_reroll`'s faces, roll again and keep the second roll.
    pub fn reroll(&self, to_reroll: Other) -> Dice {
        let rerolled: HashSet<Damage> = match to_reroll {
            Other::Num(x) => HashSet::from([Damage(x)]),
            Other::Dice(d) => d.keys().into_iter().map(Damage).collect(),
        };
        let total = self.total();
        let entries = self.get_face_entries();
        let mut rerolled_count = 0.0;
        for (face, count) in &entries {
            if rerolled.contains(&Damage(*face)) {
                rerolled_count += count;
            }
        }
        let mut result = Dice::default();
        for (face, count) in &entries {
            let base = if rerolled.contains(&Damage(*face)) {
                0.0
            } else {
                total
            };
            result.increment(*face, count * (base + rerolled_count));
        }
        result
    }

    /// Mixing two distributions into a single weighted die (not addition).
    pub fn combine(&self, other: Other) -> Dice {
        let scalar;
        let other = match other {
            Other::Num(x) => {
                scalar = Dice::scalar(x);
                &scalar
            }
            Other::Dice(d) => d,
        };
        let mut result = Dice::default();
        for (key, value) in other.faces.entries() {
            result.faces.set(key, value);
        }
        for (key, value) in self.faces.entries() {
            result.increment(key, value);
        }
        result.private_data = self.private_data.clone();
        result.outcome_data.clone_from(&self.outcome_data);
        result
    }

    pub fn combine_in_place(&mut self, other: &Dice) {
        for (key, value) in other.faces.entries() {
            self.faces.increment(key, value);
        }
    }

    /// `toPMF(numEpsilon)`.
    pub fn build_pmf(&mut self, num_epsilon: f64) -> Pmf {
        let total = self.total();
        if total == 0.0 {
            return Pmf::empty(num_epsilon);
        }
        let hit = self.calculate_hit_distribution();
        self.set_outcome_distribution("hit", hit);

        let empty = Dist::new();
        let hit_distro = self.outcome("hit").unwrap_or(&empty);
        let crit_distro = self.outcome("crit").unwrap_or(&empty);
        let miss_distro = self.outcome("missDamage").unwrap_or(&empty);
        let save_distro = self.outcome("saveHalf").unwrap_or(&empty);
        let save_fail_distro = self.outcome("saveFail").unwrap_or(&empty);
        let pc_distro = self.outcome("pc").unwrap_or(&empty);

        let is_save_half = save_distro.len() > 0;
        let is_dc_check = self.private_data.is_dc_check;
        let clamp = |x: f64| if x < 0.0 && x > -1e-15 { 0.0 } else { x };
        // `d[face]` as a number, 0 where absent.
        let at = |d: &Dist, face: f64| d.get(face).unwrap_or(0.0);

        let mut map: IndexMap<Damage, Bin> = IndexMap::new();
        for (face, face_count) in self.faces.entries() {
            if face_count <= 0.0 {
                continue;
            }
            let p = clamp(face_count / total);
            if p.is_nan() || p <= 0.0 {
                continue;
            }
            if num_epsilon >= 0.0 && p < num_epsilon {
                continue;
            }

            let mut count: LabelMap = IndexMap::new();
            let mut attr: LabelMap = IndexMap::new();

            let h = at(hit_distro, face);
            if truthy(h) {
                let c = clamp(h / total);
                if c > 0.0 {
                    let label = if is_save_half || is_dc_check {
                        "saveFail"
                    } else {
                        "hit"
                    };
                    count.insert(label.into(), c);
                    attr.insert(label.into(), clamp((face * h) / total));
                }
            }

            let cr = at(crit_distro, face);
            if truthy(cr) {
                let c = clamp(cr / total);
                if c > 0.0 {
                    count.insert("crit".into(), c);
                    attr.insert("crit".into(), clamp((face * cr) / total));
                }
            }

            let m = at(miss_distro, face);
            if truthy(m) {
                let c = clamp(m / total);
                if c > 0.0 {
                    count.insert("missDamage".into(), c);
                    attr.insert("missDamage".into(), clamp((face * m) / total));
                }
            }

            let s = at(save_distro, face);
            if truthy(s) {
                let c = clamp(s / total);
                if c > 0.0 {
                    count.insert("saveHalf".into(), c);
                    attr.insert("saveHalf".into(), clamp((face * s) / total));
                }
            }

            let sf = at(save_fail_distro, face);
            if truthy(sf) {
                let c = clamp(sf / total);
                if c > 0.0 {
                    let prev = count.get("saveFail").copied().unwrap_or(0.0);
                    count.insert("saveFail".into(), prev + c);
                    let prev_attr = attr.get("saveFail").copied().unwrap_or(0.0);
                    attr.insert("saveFail".into(), clamp(prev_attr + (face * sf) / total));
                }
            }

            let pc = at(pc_distro, face);
            if truthy(pc) {
                let c = clamp(pc / total);
                if c > 0.0 {
                    count.insert("pc".into(), c);
                    attr.insert("pc".into(), clamp((face * pc) / total));
                }
            }

            if !is_dc_check {
                let distro_count_raw = h + cr + m + s + sf + pc;
                let unaccounted = clamp(face_count - distro_count_raw);
                if unaccounted > 0.0 {
                    let frac = clamp(unaccounted / total);
                    if frac > 0.0 {
                        let prev = count.get("missNone").copied().unwrap_or(0.0);
                        count.insert("missNone".into(), prev + frac);
                    }
                }
            }

            let bin = Bin {
                p,
                count,
                attr: if attr.is_empty() { None } else { Some(attr) },
            };
            map.insert(Damage(face), bin);
        }

        let identifier = self
            .identifier
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "ERROR".to_string());
        let mut pmf = Pmf::new(map, num_epsilon, true);
        pmf.identifier = Some(identifier);
        pmf.compact(Some(num_epsilon), true)
    }
}
