//! Every number in the README, checked. Run: `cargo run -q --release --example readme`
use yipe_dice::parser::{try_parse, with_roll_type};
use yipe_dice::prelude::*;

/// Round to 4 decimals, as the README does.
fn r4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

fn check(label: &str, got: f64, want: f64) {
    assert_eq!(r4(got), want, "{label}");
    println!("ok  {label:58} {want}");
}

fn check_str(label: &str, got: &str, want: &str) {
    assert_eq!(got, want, "{label}");
    println!("ok  {label:58} {want:?}");
}

fn main() -> Result<(), DiceError> {
    // Top snippet
    let dagger = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)")?;
    let rogue = Turn::new()?
        .attacks(2, dagger)? // two-weapon fighting
        .on_first_hit(roll(3, d6())?)?; // Sneak Attack
    check("rogue mean", rogue.mean()?, 18.6225);
    check("rogue p(0)", rogue.pmf()?.p_at(0), 0.1225);
    let q = rogue.to_query()?;
    check("rogue P(20+)", q.prob_total_at_least(20), 0.5062);
    assert_eq!(q.percentiles(&[0.25, 0.5, 0.75]), [15.0, 20.0, 24.0]);

    // The dice string table
    for (expr, mean) in [
        ("2d6 + 3", 10.0),
        ("4kh3d6", 12.2446),
        ("2(d6 reroll d2)", 8.3333),
        ("2(3 > d6)", 8.0),
        ("d8 > d8", 5.8125),
        ("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)", 5.75),
        ("(d20 > d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)", 7.8975),
        ("(d20 < d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)", 3.6025),
        ("(hd20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)", 6.0375),
        ("(d20 + 8 AC 16) * (1d8 + 4) xcrit2 (2d8 + 4)", 5.975),
        ("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4) miss (4)", 7.15),
        ("(d20 + 2 DC 15) * (8d6) save half", 22.3),
    ] {
        check(expr, parse(expr)?.mean(), mean);
    }

    // A parsed string is a value
    let longsword = parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)")?;
    check("longsword p(0)", longsword.p_at(0), 0.35);
    check("longsword stdev", longsword.stdev(), 4.7342);

    // Strings and builders are the same language
    let built = d20().plus(8)?.ac(16)?.on_hit(d8().plus(4)?)?;
    check_str(
        "builder to_expression",
        &built.to_expression()?,
        "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)",
    );
    check("builder mean", built.mean()?, 5.75);
    check_str(
        "advantage",
        &d20()
            .with_advantage()?
            .plus(8)?
            .ac(16)?
            .on_hit(d8().plus(4)?)?
            .to_expression()?,
        "(d20 > d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)",
    );
    check_str(
        "crit_on(19)",
        &d20()
            .plus(8)?
            .ac(16)?
            .crit_on(19)?
            .on_hit(d8().plus(4)?)?
            .to_expression()?,
        "(d20 + 8 AC 16) * (1d8 + 4) xcrit2 (2d8 + 4)",
    );
    check_str(
        "keep_highest",
        &roll(4, d6())?.keep_highest(4, 3)?.to_expression()?,
        "4kh3(1d6)",
    );
    check_str(
        "reroll",
        &roll(2, d6())?.reroll(2)?.to_expression()?,
        "2(d6 reroll d2)",
    );
    check_str(
        "fireball",
        &d20()
            .plus(2)?
            .dc(15)?
            .on_save_failure(roll(8, d6())?)?
            .save_half()?
            .to_expression()?,
        "(d20 + 2 DC 15) * (8d6) save half",
    );

    // Strings from a UI
    check_str(
        "with_roll_type",
        &with_roll_type("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)", "advantage")?,
        "(d20 > d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)",
    );
    check("try_parse half-typed", try_parse("1d")?.mass(), 0.0);
    check_str(
        "parse error",
        &parse("d6@3").unwrap_err().to_string(),
        "Unexpected token: '@' from expression: 'd6@3'",
    );

    // Look past the average
    let q = built.to_query()?;
    check(
        "q P(hit or crit)",
        q.prob_at_least_one(["hit", "crit"]),
        0.65,
    );
    check("q P(crit)", q.prob_at_least_one("crit"), 0.05);
    check("q from crit", q.expected_damage_from("crit"), 0.65);
    check("q P(10+)", q.prob_total_at_least(10), 0.2672);
    assert_eq!(
        q.percentiles(&[0.25, 0.5, 0.75, 0.95]),
        [0.0, 6.0, 10.0, 12.0]
    );

    // Whole turns
    let sword = parse("(d20 + 9 AC 16) * (1d6 + 5) crit (2d6 + 5)")?;
    let fighter = Turn::new()?.attacks(4, sword.clone())?.on_every_hit(d6())?; // Hunter's Mark
    check("fighter mean", fighter.mean()?, 35.0);
    let flat_mark = Turn::new()?
        .attacks(4, sword.clone())?
        .on_every_hit(parse("1d6")?)?;
    check("fighter, parsed rider", flat_mark.mean()?, 34.3);

    let dagger = parse("(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)")?;
    let unarmed = parse("(d20 + 8 AC 16) * (1d6 + 4) crit (2d6 + 4)")?;
    let smite = ConditionOptions {
        rider: RiderOptions {
            id: Some("smite".into()),
            ..RiderOptions::default()
        },
        ..ConditionOptions::default()
    };
    let paladin = Turn::new()?
        .attacks(2, dagger)?
        .on_any_crit_with(roll(2, d8())?, smite)?
        .otherwise(vec![
            DamageSource::from(unarmed.clone()),
            DamageSource::from(unarmed),
        ])?;
    check("paladin mean", paladin.mean()?, 19.5703);
    check(
        "paladin P(smite)",
        paladin.fire_probability("smite")?,
        0.0975,
    );

    let shortsword = d20().plus(8)?.ac(16)?.on_hit(d6().plus(5)?)?;
    let vex = shortsword.on_every_hit(advantage().until_next_attack())?;
    check(
        "4 attacks",
        Turn::new()?.attacks(4, shortsword)?.mean()?,
        22.8,
    );
    check(
        "4 attacks, vex",
        Turn::new()?.attacks(4, vex)?.mean()?,
        27.5867,
    );

    // Sweep a turn across armor classes: vs_ac needs a builder attack, a parsed one has no AC to rebind
    let sword = d20().plus(9)?.ac(16)?.on_hit(d6().plus(5)?)?;
    let base = Turn::new()?
        .attacks(2, sword)?
        .on_first_hit(roll(3, d6())?)?;
    let sweep = [12, 14, 16, 18, 20]
        .into_iter()
        .map(|ac| Ok(r4(base.vs_ac(ac)?.mean()?)))
        .collect::<Result<Vec<f64>, DiceError>>()?;
    assert_eq!(sweep, [26.6225, 24.66, 22.4875, 20.105, 17.5125]);
    println!("ok  sweep {sweep:?}");
    Ok(())
}
