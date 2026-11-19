//! `Rng` over two JS callbacks. The facade passes `(sides) => rng.die(sides)` and
//! `(p) => rng.chance(p)` so a user's `this` survives. A throw in a callback is held, the sampler
//! finishes on dummy draws, and [`JsRng::finish`] rethrows it in place of the sampler's result.

use napi::bindgen_prelude::Function;
use yipe_dice::common::Rng;

use crate::{DiceError, thrown};

pub struct JsRng<'a> {
    die: Function<'a, f64, f64>,
    chance: Function<'a, f64, bool>,
    failure: Option<napi::Error>,
}

impl<'a> JsRng<'a> {
    pub fn new(die: Function<'a, f64, f64>, chance: Function<'a, f64, bool>) -> Self {
        Self {
            die,
            chance,
            failure: None,
        }
    }

    /// The sampler's result, or the JS error a callback threw.
    pub fn finish<T>(self, result: Result<T, DiceError>) -> napi::Result<T> {
        match self.failure {
            Some(e) => Err(e),
            None => result.map_err(thrown),
        }
    }
}

impl Rng for JsRng<'_> {
    fn die(&mut self, sides: f64) -> f64 {
        if self.failure.is_some() {
            return 1.0;
        }
        match self.die.call(sides) {
            Ok(v) => v,
            Err(e) => {
                self.failure = Some(e);
                1.0
            }
        }
    }

    fn chance(&mut self, p: f64) -> bool {
        if self.failure.is_some() {
            return false;
        }
        match self.chance.call(p) {
            Ok(v) => v,
            Err(e) => {
                self.failure = Some(e);
                false
            }
        }
    }
}
