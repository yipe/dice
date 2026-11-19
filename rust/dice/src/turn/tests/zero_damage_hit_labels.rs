//! `tests/zero-damage-hit-labels.test.ts`: 1 test, 2 compat calls. The other 14 cases (no Turn reader) are in
//! `builder/tests/t_miss_reroll.rs` (zero-damage-hit-labels.test.ts:29-95 and following).

use super::helpers::*;
use crate::parser::parse_with;
use crate::turn::turn;

#[test]
fn a_first_hit_rider_fires_on_every_landed_hit_of_the_parsed_string() -> T {
    let mut want = expect(
        "tests/zero-damage-hit-labels.test.ts",
        "a landed hit that deals 0 damage is a hit in a parsed attack > a first-hit rider fires on every landed hit of the parsed string",
    );
    let parsed = parse_with("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1)", 0.0)?;
    let riders = turn(vec![atk(pmf_damage(parsed))], 0.0)?
        .on_first_hit_with(rs(1.0, 4.0)?, first_hit_id("rider"))?;
    close(want.fire(&riders, "rider"), 14.0 / 20.0, 12);
    // The attack's own 1.175, plus the rider's 1d4 on each hit (13/20) and 2d4 on the crit (1/20).
    close(
        want.pmf(&riders).mean(),
        1.175 + (13.0 / 20.0) * 2.5 + (1.0 / 20.0) * 5.0,
        12,
    );
    want.done();
    Ok(())
}
