//! The README examples, using only public `yipe_dice` paths.
//! Run: `cargo run -q --release --example readme`
use yipe_dice::prelude::*;

/// Round to 4 decimals, as the TS README does.
fn r4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

fn main() -> Result<(), DiceError> {
    // Top snippet: two-weapon fighting + Sneak Attack
    let dagger = d20().plus(8)?.ac(16)?.on_hit(d4().plus(4)?)?;
    let sneak = roll(3, d6())?;
    let rogue = Turn::new()?
        .attacks(2, dagger.clone())?
        .on_first_hit(sneak.clone())?;
    println!("rogue mean        {}", r4(rogue.mean()?));
    println!("rogue p(0)        {}", r4(rogue.pmf()?.p_at(0)));
    let q = rogue.to_query()?;
    println!("rogue P(20+)      {}", r4(q.prob_total_at_least(20)));
    println!("rogue percentiles {:?}", q.percentiles(&[0.25, 0.5, 0.75]));

    // Quick start
    let expr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
    println!("parse             {}", r4(parse(expr)?.mean()));
    let longsword = d20().plus(8)?.ac(16)?.on_hit(d8().plus(4)?)?;
    println!("longsword mean    {}", r4(longsword.mean()?));
    println!("expression        {}", longsword.to_expression()?);

    // Look past the average
    let q = longsword.to_query()?;
    println!("q mean            {}", r4(q.mean()));
    println!(
        "q land            {}",
        r4(q.prob_at_least_one(["hit", "crit"]))
    );
    println!("q crit            {}", r4(q.prob_at_least_one("crit")));
    println!("q from crit       {}", r4(q.expected_damage_from("crit")));
    println!("q stdev           {}", r4(q.stdev()));
    println!("q P(10+)          {}", r4(q.prob_total_at_least(10)));
    println!(
        "q percentiles     {:?}",
        q.percentiles(&[0.25, 0.5, 0.75, 0.95])
    );

    // Advantage, Elven Accuracy, Halfling Luck, crit ranges
    let hit = d8().plus(4)?;
    let attack = |die: RollBuilder| -> Result<f64, DiceError> {
        die.plus(8)?.ac(16)?.on_hit(hit.clone())?.mean()
    };
    println!("normal            {}", r4(attack(d20())?));
    println!("advantage         {}", r4(attack(d20().with_advantage()?)?));
    println!(
        "disadvantage      {}",
        r4(attack(d20().with_disadvantage()?)?)
    );
    println!(
        "elven accuracy    {}",
        r4(attack(d20().with_elven_accuracy()?)?)
    );
    println!("halfling luck     {}", r4(attack(hd20())?));
    let champion = d20().plus(8)?.ac(16)?.crit_on(19)?.on_hit(hit.clone())?;
    println!("crit on 19        {}", r4(champion.mean()?));

    // Saving throw: Fireball against a +2 save, DC 15
    let fireball = d20()
        .plus(2)?
        .dc(15)?
        .on_save_failure_args(&[Arg::from(roll(8, d6())?)])?
        .save_half()?;
    println!("fireball mean     {}", r4(fireball.mean()?));
    println!("fireball expr     {}", fireball.to_expression()?);

    // Whole turns: Extra Attack, riders
    let sword = d20().plus(9)?.ac(16)?.on_hit(d6().plus(5)?)?;
    let fighter = Turn::new()?.attacks(4, sword.clone())?.on_every_hit(d6())?; // Hunter's Mark
    println!("fighter mean      {}", r4(fighter.mean()?));

    let unarmed = d20().plus(8)?.ac(16)?.on_hit(d6().plus(4)?)?;
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
    println!("paladin mean      {}", r4(paladin.mean()?));
    println!(
        "paladin P(smite)  {}",
        r4(paladin.fire_probability("smite")?)
    );

    // Everything on one turn is joint; Vex: each hit gives the next swing advantage
    let shortsword = d20().plus(8)?.ac(16)?.on_hit(d6().plus(5)?)?;
    let vex = shortsword.on_every_hit(advantage().until_next_attack())?;
    let four = |a: AttackBuilder| Turn::new()?.attacks(4, a)?.mean();
    println!("4 attacks         {}", r4(four(shortsword)?));
    println!("4 attacks, vex    {}", r4(four(vex)?));

    // Sweep a turn across armor classes
    let sword = d20().plus(9)?.ac(16)?.on_hit(d6().plus(5)?)?;
    let base = Turn::new()?.attacks(2, sword)?.on_first_hit(sneak)?;
    let sweep = [12, 14, 16, 18, 20]
        .into_iter()
        .map(|ac| Ok(r4(base.vs_ac(ac)?.mean()?)))
        .collect::<Result<Vec<f64>, DiceError>>()?;
    println!("sweep             {sweep:?}");
    Ok(())
}
