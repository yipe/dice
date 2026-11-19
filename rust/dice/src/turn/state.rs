//! Port of `src/turn/state.ts`: per-group trigger state packed into one byte.
//! Layout: `first << 2 | anyCrit << 1 | anyMiss | anyMatch << 4 | anyCritMatch << 5`.

pub const FIRST_NONE: u32 = 0;
pub const FIRST_HIT: u32 = 1;
pub const FIRST_CRIT: u32 = 2;

pub const CRIT_BIT: u32 = 2;
pub const MISS_BIT: u32 = 1;
/// Bit 4.
pub const MATCH_BIT: u32 = 16;
/// Bit 5: set with [`MATCH_BIT`] when the matching landing was a crit.
pub const CRIT_MATCH_BIT: u32 = 32;

/// A group that has seen nothing yet.
pub const START_CODE: u32 = FIRST_NONE << 2;

/// TS `StepOutcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepOutcome {
    Hit,
    Crit,
    Miss,
    None,
}

/// Fold one source outcome into a group's state. `matched` only matters for hit/crit; `None`
/// advances nothing. (TS default `matched = false`: pass `false`.)
pub fn advance(code: u32, outcome: StepOutcome, matched: bool) -> u32 {
    if outcome == StepOutcome::None {
        return code;
    }
    if outcome == StepOutcome::Miss {
        return code | MISS_BIT;
    }
    let first = (code >> 2) & 0b11;
    let crit = outcome == StepOutcome::Crit;
    let with_crit = if crit { code | CRIT_BIT } else { code };
    let match_bits = if matched {
        if crit {
            MATCH_BIT | CRIT_MATCH_BIT
        } else {
            MATCH_BIT
        }
    } else {
        0
    };
    let with_match = with_crit | match_bits;
    if first != FIRST_NONE {
        return with_match;
    }
    let next_first = if crit { FIRST_CRIT } else { FIRST_HIT };
    (next_first << 2) | (with_match & (CRIT_MATCH_BIT | MATCH_BIT | CRIT_BIT | MISS_BIT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_and_miss() {
        assert_eq!(advance(START_CODE, StepOutcome::None, true), START_CODE);
        assert_eq!(advance(START_CODE, StepOutcome::Miss, true), MISS_BIT);
    }

    #[test]
    fn first_landing_and_match() {
        let c = advance(START_CODE, StepOutcome::Crit, true);
        assert_eq!(c, (FIRST_CRIT << 2) | CRIT_BIT | MATCH_BIT | CRIT_MATCH_BIT);
        let h = advance(START_CODE, StepOutcome::Hit, false);
        assert_eq!(h, FIRST_HIT << 2);
        let h2 = advance(h, StepOutcome::Crit, false);
        assert_eq!(h2, (FIRST_HIT << 2) | CRIT_BIT);
        assert_eq!(advance(h2, StepOutcome::Miss, false) & MISS_BIT, MISS_BIT);
    }
}
