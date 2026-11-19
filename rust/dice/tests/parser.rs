//! Replays fixtures/parser.jsonl (fixtures/gen-parser.mts): every string literal in the repo's test
//! files run through the TypeScript `parse`, `tryParse`, `withRollType` and `scaleParsedDice`.

mod common;

use common::*;
use serde_json::{Value, json};
use yipe_dice::DiceError;
use yipe_dice::parser;

fn enc_pmf_result(r: Result<yipe_dice::Pmf, DiceError>) -> Value {
    match r {
        Ok(p) => enc_pmf(p),
        Err(e) => json!({ "$error": e.to_string() }),
    }
}

fn enc_string_result(r: Result<String, DiceError>) -> Value {
    match r {
        Ok(s) => json!(s),
        Err(e) => json!({ "$error": e.to_string() }),
    }
}

fn run(op: &str, _a: Option<&Value>, args: &[Value]) -> Option<Value> {
    let text = args.first()?.as_str()?;
    Some(match op {
        "parse" => enc_pmf_result(parser::parse_with(
            text,
            args.get(1).and_then(decode_num).unwrap_or(0.0),
        )),
        "tryParse" => enc_pmf_result(parser::try_parse(text)),
        "withRollType" => enc_string_result(parser::with_roll_type(text, args.get(1)?.as_str()?)),
        "scaleParsedDice" => {
            enc_string_result(parser::scale_parsed_dice(text, decode_num(args.get(1)?)?))
        }
        _ => return None,
    })
}

#[test]
fn parser() {
    replay("parser.jsonl", run);
}
