use super::support::*;
use crate::builder::factory::*;
use crate::builder::roll::RollBuilder;
use crate::parser::parse_with;

#[test]
fn greatsword() -> T {
    let r = roll_with(2.0, None, None)?.d(6.0)?.plus(5.0)?;
    assert_eq!(r.to_expression()?, "2d6 + 5");
    assert_close(r.to_pmf(0.0)?.mean(), 12.0, 9);
    Ok(())
}

#[test]
fn parser_round_trips() -> T {
    for (r, text) in [
        (roll_with(2.0, None, None)?.d(6.0)?.plus(3.0)?, "2d6 + 3"),
        (
            roll_with(4.0, None, None)?.d(6.0)?.keep_highest(4.0, 3.0)?,
            "4kh3(1d6)",
        ),
        (d8().reroll(1.0)?, "d8 reroll 1"),
        (d20().with_advantage()?.plus(5.0)?, "d20 > d20 + 5"),
    ] {
        let built = r.to_pmf(0.0)?;
        let parsed = parse_with(&r.to_expression()?, 0.0)?;
        assert_eq!(r.to_expression()?, text);
        assert_eq!(built.support(), parsed.support(), "{text}");
        for d in built.support() {
            assert_near(built.p_at(d.0), parsed.p_at(d.0));
        }
    }
    let _ = RollBuilder::zero();
    Ok(())
}
