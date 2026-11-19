//! Port of `src/builder/factory.ts`: the `roll(...)`, `d(...)` and `d4`..`d100` entry points.
//!
//! The TS `roll` is a callable object (`roll(3, 6, 2)`, `roll.d8()`, `roll.flat(5)`); here those are
//! [`roll`], [`d`] (also `roll.d`), the shortcut functions and [`flat`]. `RollFactory` in `types.ts`
//! has no Rust counterpart. The module-level constants `d4 = new RollBuilder(1).d4()` are functions
//! returning a fresh builder (builders are immutable values, so the two are the same).
//! `builderPMFCache` is skipped.

use super::roll::{Arg, RollBuilder};
use crate::error::DiceError;

/// The second argument of `roll(count, sidesOrDie, modifier)`.
#[derive(Clone, Debug)]
pub enum SidesOrDie {
    Sides(f64),
    Die(RollBuilder),
}

impl From<RollBuilder> for SidesOrDie {
    fn from(die: RollBuilder) -> Self {
        SidesOrDie::Die(die)
    }
}

impl From<&RollBuilder> for SidesOrDie {
    fn from(die: &RollBuilder) -> Self {
        SidesOrDie::Die(die.clone())
    }
}

macro_rules! sides_from_number {
    ($($t:ty),*) => {$(
        impl From<$t> for SidesOrDie {
            fn from(sides: $t) -> Self {
                SidesOrDie::Sides(f64::from(sides))
            }
        }
    )*};
}
sides_from_number!(f64, f32, i8, i16, i32, u8, u16, u32);

/// `roll(count, sidesOrDie)`: `roll(3, d6())?` is `3d6`, `roll(2, 8)?` is `2d8`.
pub fn roll(
    count: impl Into<f64>,
    sides_or_die: impl Into<SidesOrDie>,
) -> Result<RollBuilder, DiceError> {
    roll_with(count.into(), Some(sides_or_die.into()), None)
}

/// `roll(count, sidesOrDie?, modifier?)`: `RollBuilder.fromArgs(count, sidesOrDie, modifier)`.
pub fn roll_with(
    count: f64,
    sides_or_die: Option<SidesOrDie>,
    modifier: Option<f64>,
) -> Result<RollBuilder, DiceError> {
    let second = match sides_or_die {
        None => Arg::Undefined,
        Some(SidesOrDie::Sides(s)) => Arg::Num(s),
        Some(SidesOrDie::Die(d)) => Arg::Roll(d),
    };
    let third = modifier.map_or(Arg::Undefined, Arg::Num);
    RollBuilder::from_args(&[Arg::Num(count), second, third])
}

/// `roll(count, sides, modifier)` of plain numbers: `roll(3, 6, 2)` is `3d6 + 2`.
pub fn roll_dice(count: f64, sides: f64, modifier: Option<f64>) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Sides(sides)), modifier)
}

/// `d(sides)`: `new RollBuilder(1).d(sides)`.
pub fn d(sides: impl Into<f64>) -> Result<RollBuilder, DiceError> {
    RollBuilder::new(1.0)?.d(sides)
}

/// `d("...")`: a parsed expression (`RollBuilder.fromArgs(sides)`).
pub fn d_expression(expression: &str) -> Result<RollBuilder, DiceError> {
    RollBuilder::from_args(&[Arg::Str(expression.to_string())])
}

/// `d4`.
pub fn d4() -> RollBuilder {
    RollBuilder::single_die(4.0)
}

/// `d6`.
pub fn d6() -> RollBuilder {
    RollBuilder::single_die(6.0)
}

/// `d8`.
pub fn d8() -> RollBuilder {
    RollBuilder::single_die(8.0)
}

/// `d10`.
pub fn d10() -> RollBuilder {
    RollBuilder::single_die(10.0)
}

/// `d12`.
pub fn d12() -> RollBuilder {
    RollBuilder::single_die(12.0)
}

/// `d20`.
pub fn d20() -> RollBuilder {
    RollBuilder::single_die(20.0)
}

/// `d100`.
pub fn d100() -> RollBuilder {
    RollBuilder::single_die(100.0)
}

/// `hd20`: a d20 rerolling a 1 (`new RollBuilder(1).d20().reroll(1)`).
pub fn hd20() -> RollBuilder {
    RollBuilder::single_die(20.0).with_reroll_unchecked(1.0)
}

/// `flat(n)`: `new RollBuilder(0).plus(n)`.
pub fn flat(n: impl Into<f64>) -> Result<RollBuilder, DiceError> {
    let n = n.into();
    RollBuilder::new(0.0)?.plus(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_match_the_builder_chain() -> Result<(), DiceError> {
        assert_eq!(d6(), RollBuilder::new(1.0)?.d6()?);
        assert_eq!(d20(), RollBuilder::new(1.0)?.d20()?);
        assert_eq!(hd20(), RollBuilder::new(1.0)?.d20()?.reroll(1.0)?);
        assert_eq!(d(8.0)?, d8());
        Ok(())
    }
}
