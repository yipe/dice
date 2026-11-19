//! `tests/dice-match-descriptor.test.ts`: 7 tests (the two per-case `it` loops are one Rust test each: 3 `#[test]`s), 1 compat call.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::error::DiceError;
use crate::turn::bounce;

const FILE: &str = "tests/dice-match-descriptor.test.ts";

/// `roll(3, d8)`.
fn three_d8() -> Result<RollBuilder, DiceError> {
    roll_with(3.0, Some(SidesOrDie::Die(d8())), None)
}

/// `bounce({ source, max: 1 }).mean()`, as the code of its `TurnSpecError` (`"none"` if it resolves).
fn bounce_code(attack: &AttackBuilder) -> String {
    code_of(bounce(attack.clone().into(), 1.0).and_then(|t| t.mean()))
}

fn cases() -> Result<Vec<(&'static str, AttackBuilder)>, DiceError> {
    let orb = || d20().plus(5.0)?.ac(17.0);
    Ok(vec![
        (
            "an exploding pool",
            orb()?.on_hit(three_d8()?.explode(1.0)?)?,
        ),
        (
            "an advantaged pool",
            orb()?.on_hit(three_d8()?.with_advantage()?)?.no_crit()?,
        ),
        (
            "a subtracted pool",
            orb()?.on_hit(flat(30.0)?.minus_roll(&three_d8()?)?)?,
        ),
    ])
}

#[test]
fn bounce_on_a_non_plain_pool_is_refused() -> T {
    for (name, attack) in cases()? {
        assert_eq!(bounce_code(&attack), "no-dice-descriptor", "{name}");
    }
    Ok(())
}

#[test]
fn dice_match_info_on_a_non_plain_pool_has_no_hit_descriptor() -> T {
    for (name, attack) in cases()? {
        assert!(attack.dice_match_info(0.0)?.0.is_none(), "{name}");
    }
    Ok(())
}

#[test]
fn a_plain_pool_still_has_one() -> T {
    let mut want = expect(
        FILE,
        "a pool that is not a plain sum of faces has no dice-match descriptor > a plain pool still has one",
    );
    let attack = d20().plus(5.0)?.ac(17.0)?.on_hit(three_d8()?)?;
    assert!(attack.dice_match_info(0.0)?.0.is_some());
    // `codeOf(() => bounce(..).mean())` is `undefined`: the chain resolves (the one recorded `mean`).
    want.mean(&bounce(attack.into(), 1.0)?);
    want.done();
    Ok(())
}
