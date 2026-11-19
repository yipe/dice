//! The one error type of the crate: a thrown JS error, as its TS class and message.
//!
//! The TypeScript original reports failures by throwing: `Error`, `RangeError`, `TypeError` and
//! the library's own subclasses. A [`DiceError`] is that throw, one variant per class, so a
//! binding maps a failure to the right JS class by `match`, never by reading the message.
//!
//! `Display` is the JS `error.message`, byte for byte (the recorded, compat and parser fixtures
//! compare it). [`DiceError::name`] is the JS `name` and [`DiceError::js_string`] is
//! `String(error)` (`"RangeError: msg"`), which the parser embeds in its wrapped messages.
//!
//! `DiceError` compares equal to a string (`err == "msg"`) when the message is equal, whatever the
//! class; compare the variants to test the class.

use crate::turn::types::TurnSpecError;

/// The fields of `DiceParseError` beyond the message.
#[derive(Clone, Debug, PartialEq)]
pub struct DiceParseError {
    pub message: String,
    /// The original expression that failed to parse, when available.
    pub expression: Option<String>,
    /// The error that triggered this one, when available.
    pub cause: Option<DiceError>,
}

/// The fields of `ParsedCheckError`: a parsed string used as an attack or save check.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedCheckError {
    pub expression: String,
    /// `"ac"` or `"dc"`.
    pub verb: String,
    pub message: String,
}

/// A thrown JS error. See the module comment. The variants with more than a message are boxed, so
/// that a `Result<T, DiceError>` stays small on the hot paths.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum DiceError {
    /// `new Error(message)`.
    #[error("{0}")]
    Error(String),
    /// `new RangeError(message)`: a V8 `RangeError` (`Invalid array length`, a stack overflow) or
    /// one the library throws.
    #[error("{0}")]
    Range(String),
    /// `new TypeError(message)`: a V8 `TypeError` (`Cannot read properties of undefined`) or one
    /// the library throws.
    #[error("{0}")]
    Type(String),
    /// `new DiceParseError(message, { expression, cause })`.
    #[error("{}", .0.message)]
    DiceParse(Box<DiceParseError>),
    /// `new ParsedCheckError(expression, verb, message)`.
    #[error("{}", .0.message)]
    ParsedCheck(Box<ParsedCheckError>),
    /// `new AmbiguousKeepError(message)`: a per-die keep whose reading is not unique.
    #[error("{0}")]
    AmbiguousKeep(String),
    /// `new AmbiguousCritDoublingError(message)`: a crit that doubles an expression with more than
    /// one reading.
    #[error("{0}")]
    AmbiguousCritDoubling(String),
    /// `new UndoubleableExpressionError(message)`: an expression whose dice cannot be doubled.
    #[error("{0}")]
    UndoubleableExpression(String),
    /// `new TurnSpecError(code, id, message)`: a malformed turn.
    #[error("{}", .0.message)]
    TurnSpec(Box<TurnSpecError>),
    /// A callback into the embedding host threw; the host holds the thrown value and rethrows it.
    #[error("a host callback threw")]
    HostThrew,
}

impl DiceError {
    /// `new Error(message)`.
    pub fn error(message: impl Into<String>) -> Self {
        DiceError::Error(message.into())
    }

    /// `new RangeError(message)`.
    pub fn range(message: impl Into<String>) -> Self {
        DiceError::Range(message.into())
    }

    /// `new TypeError(message)`.
    pub fn type_error(message: impl Into<String>) -> Self {
        DiceError::Type(message.into())
    }

    /// V8's `RangeError: Maximum call stack size exceeded` (ADR-016: input nested past `MAX_DEPTH`).
    pub fn stack_overflow() -> Self {
        DiceError::range("Maximum call stack size exceeded")
    }

    /// V8's `RangeError: Invalid array length`.
    pub fn invalid_array_length() -> Self {
        DiceError::range("Invalid array length")
    }

    /// `new DiceParseError(message, { expression, cause })`.
    pub fn dice_parse_of(
        message: impl Into<String>,
        expression: &str,
        cause: Option<DiceError>,
    ) -> Self {
        DiceError::DiceParse(Box::new(DiceParseError {
            message: message.into(),
            expression: Some(expression.to_string()),
            cause,
        }))
    }

    /// `new DiceParseError(message)`, without an expression or cause.
    pub fn dice_parse(message: impl Into<String>) -> Self {
        DiceError::DiceParse(Box::new(DiceParseError {
            message: message.into(),
            expression: None,
            cause: None,
        }))
    }

    /// The JS `name`. The two crit-doubling classes never set one, so theirs is `Error`.
    pub fn name(&self) -> &'static str {
        match self {
            DiceError::Error(_)
            | DiceError::HostThrew
            | DiceError::AmbiguousCritDoubling(_)
            | DiceError::UndoubleableExpression(_) => "Error",
            DiceError::Range(_) => "RangeError",
            DiceError::Type(_) => "TypeError",
            DiceError::DiceParse(_) => "DiceParseError",
            DiceError::ParsedCheck(_) => "ParsedCheckError",
            DiceError::AmbiguousKeep(_) => "AmbiguousKeepError",
            DiceError::TurnSpec(_) => "TurnSpecError",
        }
    }

    /// The TS class this throws: the constructor's name, which a binding maps to a JS class.
    /// (`name` differs for the two crit-doubling classes, which never set one.)
    pub fn class(&self) -> &'static str {
        match self {
            DiceError::AmbiguousCritDoubling(_) => "AmbiguousCritDoublingError",
            DiceError::UndoubleableExpression(_) => "UndoubleableExpressionError",
            other => other.name(),
        }
    }

    /// The JS `message`: the same text as `Display`.
    pub fn message(&self) -> &str {
        match self {
            DiceError::Error(m)
            | DiceError::Range(m)
            | DiceError::Type(m)
            | DiceError::AmbiguousKeep(m)
            | DiceError::AmbiguousCritDoubling(m)
            | DiceError::UndoubleableExpression(m) => m,
            DiceError::DiceParse(e) => &e.message,
            DiceError::ParsedCheck(e) => &e.message,
            DiceError::TurnSpec(e) => &e.message,
            DiceError::HostThrew => "a host callback threw",
        }
    }

    /// `String(error)`: `"<name>: <message>"`.
    pub fn js_string(&self) -> String {
        format!("{}: {}", self.name(), self.message())
    }
}

impl From<TurnSpecError> for DiceError {
    fn from(e: TurnSpecError) -> Self {
        DiceError::TurnSpec(Box::new(e))
    }
}

impl PartialEq<str> for DiceError {
    fn eq(&self, other: &str) -> bool {
        self.message() == other
    }
}

impl PartialEq<&str> for DiceError {
    fn eq(&self, other: &&str) -> bool {
        self.message() == *other
    }
}

impl PartialEq<String> for DiceError {
    fn eq(&self, other: &String) -> bool {
        self.message() == other
    }
}

impl PartialEq<DiceError> for &str {
    fn eq(&self, other: &DiceError) -> bool {
        *self == other.message()
    }
}

impl PartialEq<DiceError> for String {
    fn eq(&self, other: &DiceError) -> bool {
        self == other.message()
    }
}

/// Unit tests report failures as `Result<_, String>` and `?` the message, in both directions.
#[cfg(test)]
impl From<DiceError> for String {
    fn from(e: DiceError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
impl From<String> for DiceError {
    fn from(message: String) -> DiceError {
        DiceError::Error(message)
    }
}

#[cfg(test)]
impl From<&str> for DiceError {
    fn from(message: &str) -> DiceError {
        DiceError::Error(message.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_is_the_message_and_js_string_adds_the_class() {
        let e = DiceError::range("Invalid array length");
        assert_eq!(e.to_string(), "Invalid array length");
        assert_eq!(e.name(), "RangeError");
        assert_eq!(e.js_string(), "RangeError: Invalid array length");
        assert_eq!(DiceError::error("boom").js_string(), "Error: boom");
        assert!(e == "Invalid array length");
    }

    #[test]
    fn parse_error_carries_expression_and_cause() {
        let e = DiceError::DiceParse(Box::new(DiceParseError {
            message: "Cannot parse dice expression [d6@3]: Error: bad token".to_string(),
            expression: Some("d6@3".to_string()),
            cause: Some(DiceError::error("bad token")),
        }));
        assert_eq!(e.name(), "DiceParseError");
        assert_eq!(e.to_string(), e.message());
    }
}
