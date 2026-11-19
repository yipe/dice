//! Port of `src/builder/arguments.ts`.

use crate::error::DiceError;
use crate::js::num_to_string;

/// JS `Number.isInteger`.
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// `requireFinite`: `Err` for a non-finite builder argument, naming it.
pub fn require_finite(value: f64, what: &str) -> Result<(), DiceError> {
    if !value.is_finite() {
        return Err(DiceError::error(format!(
            "{what} must be finite, got {}",
            num_to_string(value)
        )));
    }
    Ok(())
}

/// The `{ budget, rolls }` that `rerollUpToArguments` returns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RerollUpToArguments {
    pub budget: f64,
    pub rolls: f64,
}

/// `rerollUpToArguments`: `rolls` is `options?.rolls` (`None` reads as 1).
pub fn reroll_up_to_arguments(
    budget: f64,
    rolls: Option<f64>,
    verb: &str,
) -> Result<RerollUpToArguments, DiceError> {
    let rolls = rolls.unwrap_or(1.0);
    if budget.is_nan() {
        return Err(DiceError::error(format!(
            "Invalid NaN value for {verb} budget"
        )));
    }
    if rolls.is_nan() {
        return Err(DiceError::error(format!(
            "Invalid NaN value for {verb} rolls"
        )));
    }
    require_finite(budget, &format!("{verb} budget"))?;
    require_finite(rolls, &format!("{verb} rolls"))?;
    if !is_integer(budget) || budget < 0.0 {
        return Err(DiceError::error(format!(
            "{verb} budget must be a non-negative integer, got {}",
            num_to_string(budget)
        )));
    }
    if !is_integer(rolls) || rolls < 1.0 {
        return Err(DiceError::error(format!(
            "{verb} rolls must be a positive integer, got {}",
            num_to_string(rolls)
        )));
    }
    Ok(RerollUpToArguments { budget, rolls })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_rolls_to_one() {
        let a = reroll_up_to_arguments(2.0, None, "rerollUpTo()").unwrap_or(RerollUpToArguments {
            budget: -1.0,
            rolls: -1.0,
        });
        assert_eq!(
            a,
            RerollUpToArguments {
                budget: 2.0,
                rolls: 1.0
            }
        );
    }

    #[test]
    fn errors_name_the_argument() {
        let e = |b: f64, r: Option<f64>| {
            reroll_up_to_arguments(b, r, "v()")
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default()
        };
        assert_eq!(e(f64::NAN, None), "Invalid NaN value for v() budget");
        assert_eq!(e(1.0, Some(f64::NAN)), "Invalid NaN value for v() rolls");
        assert_eq!(
            e(f64::INFINITY, None),
            "v() budget must be finite, got Infinity"
        );
        assert_eq!(
            e(1.0, Some(f64::NEG_INFINITY)),
            "v() rolls must be finite, got -Infinity"
        );
        assert_eq!(
            e(1.5, None),
            "v() budget must be a non-negative integer, got 1.5"
        );
        assert_eq!(
            e(-1.0, None),
            "v() budget must be a non-negative integer, got -1"
        );
        assert_eq!(
            e(1.0, Some(0.0)),
            "v() rolls must be a positive integer, got 0"
        );
        assert_eq!(
            require_finite(f64::NAN, "x"),
            Err(DiceError::error("x must be finite, got NaN"))
        );
    }
}
