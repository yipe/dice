//! Port of `src/parser/` (`parse`, `tryParse`, `withRollType`, `scaleParsedDice`). A TS throw is
//! `Err(message)` with the exact `Error.message` text.

mod dice;
mod grammar;
mod roll_type;
mod scale_dice;

pub use grammar::{parse, parse_shared, parse_with};
pub use roll_type::{try_parse, with_roll_type};
pub use scale_dice::scale_parsed_dice;
