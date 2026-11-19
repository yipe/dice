//! Rust port of `@yipe/dice`. See `rust/MAP.md` and `rust/DECISIONS.md` (ADR-009).
#![forbid(unsafe_code)]
pub mod builder;
pub mod common;
pub mod damage;
pub mod dnd5e;
pub mod error;
pub mod js;
pub mod parser;
pub mod pmf;
pub mod query;
pub mod turn;

pub use damage::Damage;
pub use error::DiceError;
pub use pmf::{Bin, LabelMap, Pmf};
pub use query::DiceQuery;

/// `EPS` in `src/common/types.ts`.
pub const EPS: f64 = 1e-12;

/// The items most programs use: `use yipe_dice::prelude::*;`.
pub mod prelude {
    pub use crate::builder::attack::{AttackBuilder, Grants};
    pub use crate::builder::factory::{
        d, d4, d6, d8, d10, d12, d20, d100, flat, hd20, roll, roll_with,
    };
    pub use crate::builder::roll::{Arg, RollBuilder};
    pub use crate::builder::save::SaveBuilder;
    pub use crate::parser::{parse, parse_with};
    pub use crate::turn::effects::{
        ConditionOptions, EveryHitOptions, FirstHitOptions, advantage, crit_on_hit, disadvantage,
        save,
    };
    pub use crate::turn::types::{AttackOptions, AttacksOptions, DamageSource, RiderOptions};
    pub use crate::turn::{Turn, turn};
    pub use crate::{DiceError, DiceQuery, EPS, Pmf, query::Labels};
}
