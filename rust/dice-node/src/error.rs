//! How a [`DiceError`] crosses napi.
//!
//! A napi error carries only a message, so the class travels in it: the message of the JS `Error`
//! the binding throws is [`TAG`] followed by a JSON object, `{ "class", "message", ...fields }`,
//! built here from the variant. `ts/native.ts` (`translateError`) reads the tag and builds the TS
//! class from `class`; it never inspects the message text. Fields per class:
//!
//! | `class`                       | extra fields                                  |
//! | ----------------------------- | --------------------------------------------- |
//! | `DiceParseError`              | `expression?`, `cause?` (a nested tag object) |
//! | `ParsedCheckError`            | `expression`, `verb`                          |
//! | `TurnSpecError`               | `code`, `id`                                  |
//! | `Error`, `RangeError`, `TypeError`, `AmbiguousKeepError`, `AmbiguousCritDoublingError`, `UndoubleableExpressionError` | none |

use serde_json::{Value, json};
use yipe_dice::DiceError;

/// Starts the message of every error the binding throws for a [`DiceError`].
pub(crate) const TAG: &str = "\u{1}dice:";

/// The class tag object of `e` (see the module comment).
fn class_of(e: &DiceError) -> Value {
    let mut tag = json!({ "class": e.class(), "message": e.message() });
    let fields = tag.as_object_mut();
    match (e, fields) {
        (DiceError::DiceParse(p), Some(fields)) => {
            fields.insert("expression".into(), json!(p.expression));
            fields.insert(
                "cause".into(),
                p.cause.as_ref().map_or(Value::Null, class_of),
            );
        }
        (DiceError::ParsedCheck(p), Some(fields)) => {
            fields.insert("expression".into(), json!(p.expression));
            fields.insert("verb".into(), json!(p.verb));
        }
        (DiceError::TurnSpec(s), Some(fields)) => {
            fields.insert("code".into(), json!(s.code.as_str()));
            fields.insert("id".into(), json!(s.id));
        }
        _ => {}
    }
    tag
}

/// The message of the JS `Error` thrown for `e`: [`TAG`] and the JSON tag object.
pub(crate) fn tagged(e: &DiceError) -> String {
    format!("{TAG}{}", class_of(e))
}

/// The napi error that throws `e` as its TS class.
pub(crate) fn thrown(e: DiceError) -> napi::Error {
    napi::Error::from_reason(tagged(&e))
}

/// The napi error for a failure of the binding itself: a plain `Error`.
pub(crate) fn err(message: String) -> napi::Error {
    thrown(DiceError::error(message))
}
