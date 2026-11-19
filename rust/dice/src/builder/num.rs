//! JS number semantics the builder port shares: `Math.max/min/round/floor` with NaN, and a sort
//! that never panics on a comparator that is not a total order.

use std::cmp::Ordering;

/// Deepest nesting any recursive builder, AST or sampler function follows (ADR-016).
pub const MAX_DEPTH: usize = 500;

/// Largest die size or count the resolvers enumerate (ADR-017: TS allocates until it dies).
pub const MAX_ENUMERATED: f64 = 1e6;

/// `Math.max`: NaN propagates.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min`: NaN propagates.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.round`: halves toward +Infinity.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// JS `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// JS `!(x > 0)`: true for NaN as well as for zero and negatives.
pub fn not_positive(x: f64) -> bool {
    x.is_nan() || x <= 0.0
}

/// `x || 0`: NaN and zero read as +0.
pub fn or_zero(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 { 0.0 } else { x }
}

/// `Array.prototype.sort` for a numeric-style comparator: stable, and never panics on a
/// comparator that is not a total order (binary insertion sort, as V8 uses for short arrays).
pub fn stable_sort_by<T>(items: &mut Vec<T>, mut cmp: impl FnMut(&T, &T) -> Ordering) {
    let mut out: Vec<T> = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        let mut lo = 0;
        let mut hi = out.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if cmp(&item, &out[mid]) == Ordering::Less {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        out.insert(lo, item);
    }
    *items = out;
}

/// A JS comparator result (`a - b`-style number): `Less` below 0, `Greater` above, `Equal` for 0
/// and NaN.
pub fn ordering_of(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// JS string `<` / `>` order (UTF-16 code units).
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `Math.floor(x)` of an integer-valued `f64` as `usize`, or `None` when out of range.
pub fn to_usize(x: f64) -> Option<usize> {
    if x.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&x) {
        Some(x as usize)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_halves_up() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert!(js_max(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn sort_is_stable() {
        let mut v = vec![(1, 'a'), (0, 'b'), (1, 'c'), (0, 'd')];
        stable_sort_by(&mut v, |a, b| a.0.cmp(&b.0));
        assert_eq!(v, vec![(0, 'b'), (0, 'd'), (1, 'a'), (1, 'c')]);
    }
}
