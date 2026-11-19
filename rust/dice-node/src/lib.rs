//! napi binding of `yipe-dice`. Native handles wrap the Rust values; the TypeScript facade in
//! `ts/` gives them the public API of `@yipe/dice`.
//!
//! A Rust `Err(DiceError)` is a thrown JS `Error` whose message carries the error's class (see
//! `error.rs`); `ts/native.ts` rethrows it as that TS error class.
//! No `unwrap`/`expect`/`panic` on input-reachable paths: a panic across napi aborts Node.

mod ast;
mod attack;
mod batch;
mod conv;
mod effects;
mod error;
mod pmf;
mod rng;
mod roll;
mod roll_check;
mod save;
mod turn_native;

pub(crate) use error::{err, thrown};
pub(crate) use yipe_dice::DiceError;
