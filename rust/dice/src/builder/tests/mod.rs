//! Rust translations of the TS `it(...)` cases that exercise `src/builder/{roll, ast, expression,
//! sample, factory, types, miss-reroll}`. One file per group of TS test files.

mod checks_deferred;
mod checks_own;
mod core;
mod golden;
mod golden_checks;
mod index_typed_scale;
mod miss_reroll_core;
mod pooled_crit;
mod roll_1;
mod roll_2;
mod round_trips;
mod small_tests;
mod smoke;
mod support;
mod t_ac;
mod t_attack;
mod t_crit_misc;
mod t_dc_save;
mod t_miss_reroll;
mod t_row_facts;
