//! Shared helpers for the translated builder tests.

use crate::Pmf;
use crate::builder::roll::RollBuilder;
use crate::error::DiceError;

/// `Result` alias the tests return so `?` replaces TS `throw`.
pub type T = Result<(), DiceError>;

/// Vitest `toBeCloseTo(expected, digits)`: `|a - b| < 10^-digits / 2`.
pub fn close(a: f64, b: f64, digits: i32) -> bool {
    (a - b).abs() < 10f64.powi(-digits) / 2.0
}

/// Asserts `toBeCloseTo`.
#[track_caller]
pub fn assert_close(a: f64, b: f64, digits: i32) {
    assert!(
        close(a, b, digits),
        "{a} is not close to {b} ({digits} digits)"
    );
}

/// Asserts two floats agree within 1e-9 (ADR-005).
#[track_caller]
pub fn assert_near(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 1e-9 * (1.0 + a.abs().max(b.abs())),
        "{a} != {b} (1e-9)"
    );
}

/// `[[value, p], ...]` of a PMF in support order.
pub fn faces(pmf: &Pmf) -> Vec<(f64, f64)> {
    pmf.support().iter().map(|d| (d.0, pmf.p_at(d.0))).collect()
}

/// `roll.toPMF()` that turns an `Err` into a test failure with its message.
#[track_caller]
pub fn pmf_of(r: &RollBuilder) -> Pmf {
    match r.to_pmf(0.0) {
        Ok(p) => p,
        Err(e) => panic!("toPMF failed: {e}"),
    }
}

/// The message of an `Err` (TS `expect(() => ...).toThrow()`), failing the test on `Ok`.
#[track_caller]
pub fn err_of<X>(r: Result<X, DiceError>) -> String {
    match r {
        Ok(_) => panic!("expected an Err, got Ok"),
        Err(e) => e.to_string(),
    }
}

/// The error of an `Err` (its class and message), failing the test on `Ok`.
#[track_caller]
pub fn error_of<X>(r: Result<X, DiceError>) -> DiceError {
    match r {
        Ok(_) => panic!("expected an Err, got Ok"),
        Err(e) => e,
    }
}

/// `expect(() => ...).toThrow("text")`: the `Err` message contains `text` (vitest's substring rule).
#[track_caller]
pub fn assert_throws<X>(r: Result<X, DiceError>, text: &str) {
    let e = err_of(r);
    assert!(e.contains(text), "error {e:?} does not contain {text:?}");
}
