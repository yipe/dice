//! JavaScript semantics the port must reproduce exactly.

/// `String(x)` for a JS number (ECMAScript `Number::toString`, radix 10).
pub fn num_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        return (x as i64).to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", num_to_string(-x));
    }
    // Shortest round-trip digits: "d.ddde±x" -> digits "dddd", n = exponent + 1.
    let sci = format!("{x:e}");
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        let frac = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{frac}e{sign}{}", e.abs())
    }
}

#[cfg(test)]
mod tests {
    use super::num_to_string as s;

    #[test]
    fn matches_js() {
        assert_eq!(s(1.0 / 6.0), "0.16666666666666666");
        assert_eq!(s(1e21), "1e+21");
        assert_eq!(s(1e20), "100000000000000000000");
        assert_eq!(s(1e-7), "1e-7");
        assert_eq!(s(1.5e-7), "1.5e-7");
        assert_eq!(s(0.000001), "0.000001");
        assert_eq!(s(-2.5), "-2.5");
        assert_eq!(s(123.0), "123");
        assert_eq!(s(-0.0), "0");
    }
}

/// JS regex `\s` (ECMAScript `WhiteSpace` + `LineTerminator`). Differs from `char::is_whitespace`:
/// includes U+FEFF (BOM), excludes U+0085 (NEL).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

#[cfg(test)]
mod space_tests {
    #[test]
    fn js_whitespace() {
        assert!(super::is_space('\u{FEFF}'));
        assert!(!super::is_space('\u{85}'));
        assert!(super::is_space('\u{3000}'));
        assert!(!super::is_space('x'));
    }
}
