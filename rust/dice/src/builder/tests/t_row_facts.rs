//! Builder-level cases of `row-facts`, `string-damage`, `example` (from line 104), `example-conditions`,
//! `attached-target-has`, `check-order`, `attribution-conservation`, `combined-with-attribution`,
//! `dice-match-descriptor` and `dice-match-pools` (the turn-level cases are deferred, see the report).

use super::support::*;
use crate::EPS;
use crate::Pmf;
use crate::builder::ac::combine;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::nodes::Rounding;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::save::SaveBuilder;
use crate::builder::types::{AttackRange, Check};
use crate::common::RollType;
use crate::error::DiceError;
use crate::turn::context::{PenaltyDice, RowCheck, RowContext, RowKind, RowRange};

fn rl(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn hit() -> Result<RollBuilder, DiceError> {
    rl(2.0, d6())?.plus(3.0)
}

/// `scaleResult(2)`.
fn doubled(r: &RollBuilder) -> Result<RollBuilder, DiceError> {
    r.scale_result(2.0, 1.0, Rounding::Floor)
}

type Bits = Vec<(
    u64,
    u64,
    Option<Vec<(String, u64)>>,
    Option<Vec<(String, u64)>>,
)>;

fn label_bits(m: Option<&crate::pmf::LabelMap>) -> Option<Vec<(String, u64)>> {
    m.map(|m| {
        let mut v: Vec<(String, u64)> = m.iter().map(|(k, x)| (k.clone(), x.to_bits())).collect();
        v.sort();
        v
    })
}

/// `pmfBits`: every bin in support order, `p`, `count` and `attr` as bit patterns.
fn pmf_bits(pmf: &Pmf) -> Bits {
    let mut v: Vec<_> = pmf
        .map
        .iter()
        .map(|(d, b)| {
            (
                d.0,
                b.p,
                label_bits(Some(&b.count)),
                label_bits(b.attr.as_ref()),
            )
        })
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v.into_iter()
        .map(|(d, p, c, a)| (d.to_bits(), p.to_bits(), c, a))
        .collect()
}

#[track_caller]
fn same(actual: &Pmf, expected: &Pmf) {
    assert_eq!(pmf_bits(actual), pmf_bits(expected));
}

/// The mass `pmf` puts on `label` at each damage value, bit for bit.
fn branch(pmf: &Pmf, label: &str, scale: f64) -> Vec<(u64, u64)> {
    let mut v: Vec<(f64, u64)> = pmf
        .map
        .iter()
        .filter(|(_, b)| b.count.get(label).copied().unwrap_or(0.0) > 0.0)
        .map(|(d, b)| (d.0 * scale, b.count[label].to_bits()))
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v.into_iter().map(|(d, b)| (d.to_bits(), b)).collect()
}

fn plain() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: Vec::new(),
        joined: Vec::new(),
    }
}

fn ctx(f: impl FnOnce(&mut RowContext)) -> RowContext {
    let mut c = plain();
    f(&mut c);
    c
}

fn attack_row() -> RowCheck {
    RowCheck {
        kind: RowKind::Attack,
        range: None,
        ability: None,
        roll_type: RollType::Flat,
        advantage_dice: 2,
        pinned: false,
        auto_hit: false,
        auto_crit: false,
        auto_fail: false,
    }
}

fn attack_row_with(f: impl FnOnce(&mut RowCheck)) -> RowCheck {
    let mut c = attack_row();
    f(&mut c);
    c
}

fn save_with(f: impl FnOnce(&mut RowCheck)) -> RowCheck {
    attack_row_with(|c| {
        c.kind = RowKind::Save;
        f(c);
    })
}

fn ac_base() -> Result<RollBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)
}

fn dc_base() -> Result<RollBuilder, DiceError> {
    d20().plus(5.0)?.dc(15.0)
}

// ------------------------------------------------------------------ row-facts.test.ts

/// src/builder/row-facts.test.ts:109 (one `it.each` row per case, in a loop).
#[test]
fn row_facts_each_verbs_row_check() -> T {
    let h = hit()?;
    let ranged = |c: &mut RowCheck| c.range = Some(RowRange::Ranged);
    let melee = |c: &mut RowCheck| c.range = Some(RowRange::Melee);
    let attacks: Vec<(&str, AttackBuilder, RowCheck)> = vec![
        ("plain attack", ac_base()?.on_hit(h.clone())?, attack_row()),
        (
            "ACBuilder.ranged()",
            ac_base()?.ranged()?.on_hit(h.clone())?,
            attack_row_with(ranged),
        ),
        (
            "ACBuilder.melee()",
            ac_base()?.melee()?.on_hit(h.clone())?,
            attack_row_with(melee),
        ),
        (
            "AttackBuilder.ranged()",
            ac_base()?.on_hit(h.clone())?.ranged()?,
            attack_row_with(ranged),
        ),
        (
            "AttackBuilder.melee()",
            ac_base()?.on_hit(h.clone())?.melee()?,
            attack_row_with(melee),
        ),
        (
            "the last range wins",
            ac_base()?.ranged()?.on_hit(h.clone())?.melee()?,
            attack_row_with(melee),
        ),
        (
            "range survives critOn()",
            ac_base()?.ranged()?.crit_on(19.0)?.on_hit(h.clone())?,
            attack_row_with(ranged),
        ),
        (
            "range survives alwaysCrits()",
            ac_base()?.ranged()?.always_crits()?.on_hit(h.clone())?,
            attack_row_with(|c| {
                ranged(c);
                c.auto_crit = true;
            }),
        ),
        (
            "AlwaysHitBuilder.ranged()",
            d20()
                .plus(5.0)?
                .always_hits()?
                .ranged()?
                .crit_on(19.0)?
                .always_crits()?
                .on_hit(h.clone())?,
            attack_row_with(|c| {
                ranged(c);
                c.auto_hit = true;
                c.auto_crit = true;
            }),
        ),
        (
            "RollBuilder.pinned() before ac()",
            d20()
                .plus(8.0)?
                .with_advantage()?
                .pinned()?
                .ac(16.0)?
                .on_hit(h.clone())?,
            attack_row_with(|c| {
                c.roll_type = RollType::Advantage;
                c.pinned = true;
            }),
        ),
        (
            "ACBuilder.pinned()",
            d20().plus(8.0)?.ac(16.0)?.pinned()?.on_hit(h.clone())?,
            attack_row_with(|c| c.pinned = true),
        ),
        (
            "AttackBuilder.pinned()",
            d20().plus(8.0)?.ac(16.0)?.on_hit(h.clone())?.pinned()?,
            attack_row_with(|c| c.pinned = true),
        ),
        (
            "AlwaysHitBuilder.pinned()",
            d20()
                .plus(8.0)?
                .always_hits()?
                .pinned()?
                .on_hit(h.clone())?,
            attack_row_with(|c| {
                c.pinned = true;
                c.auto_hit = true;
            }),
        ),
        (
            "own three dice: withAdvantage() + threeDiceAdvantage()",
            d20()
                .plus(8.0)?
                .with_advantage()?
                .ac(16.0)?
                .three_dice_advantage()?
                .on_hit(h.clone())?,
            attack_row_with(|c| {
                c.roll_type = RollType::ElvenAccuracy;
                c.advantage_dice = 3;
            }),
        ),
        (
            "threeDiceAdvantage() alone",
            d20()
                .plus(8.0)?
                .ac(16.0)?
                .three_dice_advantage()?
                .on_hit(h.clone())?,
            attack_row_with(|c| c.advantage_dice = 3),
        ),
        (
            "withElvenAccuracy()",
            d20()
                .with_elven_accuracy()?
                .plus(8.0)?
                .ac(16.0)?
                .on_hit(h.clone())?,
            attack_row_with(|c| {
                c.roll_type = RollType::ElvenAccuracy;
                c.advantage_dice = 3;
            }),
        ),
        (
            "withDisadvantage()",
            d20()
                .plus(8.0)?
                .with_disadvantage()?
                .ac(16.0)?
                .on_hit(h.clone())?,
            attack_row_with(|c| c.roll_type = RollType::Disadvantage),
        ),
        (
            "alwaysHits()",
            d20().plus(5.0)?.always_hits()?.on_hit(h.clone())?,
            attack_row_with(|c| c.auto_hit = true),
        ),
        (
            "ac().alwaysCrits()",
            ac_base()?.always_crits()?.on_hit(h.clone())?,
            attack_row_with(|c| c.auto_crit = true),
        ),
        (
            "alwaysHits().alwaysCrits()",
            d20()
                .plus(5.0)?
                .always_hits()?
                .always_crits()?
                .on_hit(h.clone())?,
            attack_row_with(|c| {
                c.auto_hit = true;
                c.auto_crit = true;
            }),
        ),
        (
            "facts survive withCheck()",
            d20()
                .plus(5.0)?
                .pinned()?
                .ac(15.0)?
                .ranged()?
                .on_hit(h.clone())?
                .with_check(|c| Check { ac: 18.0, ..c })?,
            attack_row_with(|c| {
                ranged(c);
                c.pinned = true;
            }),
        ),
    ];
    for (name, attack, expected) in attacks {
        assert_eq!(attack.row_check(), expected, "{name}");
    }
    let fail = |c: RollBuilder| c.on_save_failure_args(&[Arg::Roll(h.clone())]);
    let ability = |a: &str| save_with(|c| c.ability = Some(a.to_string()));
    let saves: Vec<(&str, SaveBuilder, RowCheck)> = vec![
        ("plain save", fail(dc_base()?)?, save_with(|_| {})),
        (
            "DCBuilder.ability('con')",
            fail(dc_base()?.ability("con")?)?,
            ability("constitution"),
        ),
        (
            "DCBuilder.ability(full name)",
            fail(dc_base()?.ability("wisdom")?)?,
            ability("wisdom"),
        ),
        (
            "SaveBuilder.ability('dex')",
            fail(dc_base()?)?.save_half()?.ability("dex")?,
            ability("dexterity"),
        ),
        (
            "DCBuilder.alwaysFails()",
            fail(dc_base()?.always_fails()?)?,
            save_with(|c| c.auto_fail = true),
        ),
        (
            "SaveBuilder.alwaysFails()",
            fail(dc_base()?)?.always_fails()?,
            save_with(|c| c.auto_fail = true),
        ),
        (
            "DCBuilder.pinned()",
            fail(d20().plus(5.0)?.with_advantage()?.dc(15.0)?.pinned()?)?,
            save_with(|c| {
                c.roll_type = RollType::Advantage;
                c.pinned = true;
            }),
        ),
        (
            "SaveBuilder.pinned()",
            fail(dc_base()?)?.pinned()?,
            save_with(|c| c.pinned = true),
        ),
        (
            "save withDisadvantage()",
            fail(d20().plus(5.0)?.with_disadvantage()?.dc(15.0)?)?,
            save_with(|c| c.roll_type = RollType::Disadvantage),
        ),
        (
            "save facts survive dc() and add()",
            fail(
                dc_base()?
                    .ability("str")?
                    .always_fails()?
                    .pinned()?
                    .dc(16.0)?
                    .add(&d4())?,
            )?,
            save_with(|c| {
                c.ability = Some("strength".to_string());
                c.auto_fail = true;
                c.pinned = true;
            }),
        ),
    ];
    for (name, save, expected) in saves {
        assert_eq!(save.row_check(), expected, "{name}");
    }
    Ok(())
}

/// src/builder/row-facts.test.ts:113 (a `TypeError` in TS: the class is not asserted).
#[test]
fn ability_throws_a_type_error_naming_the_value() -> T {
    for name in ["s", "CON", "Strength", "constitutionx", "", "luck"] {
        assert_throws(dc_base()?.ability(name), &format!("\"{name}\""));
    }
    Ok(())
}

/// src/builder/row-facts.test.ts:119
#[test]
fn pinned_refuses_a_roll_with_no_die_to_pin() -> T {
    assert_throws(flat(5.0)?.pinned(), "no natural roll");
    Ok(())
}

/// src/builder/row-facts.test.ts:123 (the `!==` identity checks have no Rust counterpart: builders are values).
#[test]
fn verbs_are_immutable() -> T {
    let h = hit()?;
    let check = ac_base()?;
    let attack = check.on_hit(h.clone())?;
    let dc = dc_base()?;
    let save = dc.on_save_failure_args(&[Arg::Roll(h)])?;
    check.ranged()?;
    check.pinned()?;
    attack.melee()?;
    attack.pinned()?;
    dc.ability("con")?;
    dc.always_fails()?;
    save.ability("dex")?;
    save.always_fails()?;
    assert_eq!(attack.row_check(), attack_row());
    assert_eq!(save.row_check(), save_with(|_| {}));
    assert_eq!(
        check.attack_config().and_then(|c| c.range),
        None::<AttackRange>
    );
    assert_eq!(dc.save_ability(), None);
    assert!(!dc.auto_fail());
    Ok(())
}

/// src/builder/row-facts.test.ts:139
#[test]
fn range_ability_and_pinned_leave_the_distribution_alone() -> T {
    let attack = ac_base()?.on_hit(hit()?)?;
    let base = attack.to_pmf(0.0)?;
    let variants = [
        attack.ranged()?,
        attack.melee()?,
        attack.pinned()?,
        d20().plus(5.0)?.pinned()?.ac(15.0)?.on_hit(hit()?)?,
    ];
    for v in variants {
        same(&v.to_pmf(0.0)?, &base);
    }
    let save = dc_base()?
        .on_save_failure_args(&[Arg::Roll(hit()?)])?
        .save_half()?;
    let base = save.to_pmf(0.0)?;
    for v in [save.ability("con")?, save.pinned()?] {
        same(&v.to_pmf(0.0)?, &base);
    }
    Ok(())
}

/// src/builder/row-facts.test.ts:150
#[test]
fn always_fails_is_a_save_that_always_fails_and_has_no_expression() -> T {
    let save = dc_base()?
        .on_save_failure_args(&[Arg::Roll(hit()?)])?
        .save_half()?;
    let certain = d20()
        .plus(5.0)?
        .dc(1000.0)?
        .on_save_failure_args(&[Arg::Roll(hit()?)])?
        .save_half()?;
    same(&save.always_fails()?.to_pmf(0.0)?, &certain.to_pmf(0.0)?);
    let p = dc_base()?.always_fails()?.save_probabilities()?;
    assert_eq!((p.p_success, p.p_fail), (0.0, 1.0));
    assert_throws(save.always_fails()?.to_expression(), "alwaysFails");
    Ok(())
}

fn sword() -> Result<AttackBuilder, DiceError> {
    ac_base()?.on_hit(hit()?)
}

fn save_sample() -> Result<SaveBuilder, DiceError> {
    dc_base()?
        .on_save_failure_args(&[Arg::Roll(rl(4.0, d6())?)])?
        .save_half()
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
)]
fn save_with_roll(r: RollBuilder) -> Result<SaveBuilder, DiceError> {
    r.on_save_failure_args(&[Arg::Roll(rl(4.0, d6())?)])?
        .save_half()
}

// ------------------------------------------------------------------ under(context)

/// src/builder/row-facts.test.ts:169
#[test]
fn the_plain_context_is_to_pmf_at_any_eps() -> T {
    let s = sword()?;
    same(&s.under(&plain(), 0.0)?, &s.to_pmf(0.0)?);
    same(&s.under(&plain(), 1e-6)?, &s.to_pmf(1e-6)?);
    Ok(())
}

/// src/builder/row-facts.test.ts:174
#[test]
fn roll_type_is_taken_literally() -> T {
    let s = sword()?;
    let h = hit()?;
    let rt = |t| ctx(|c| c.roll_type = t);
    same(
        &s.under(&rt(RollType::Advantage), 0.0)?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(15.0)?
            .on_hit(h.clone())?
            .to_pmf(0.0)?,
    );
    same(
        &s.under(&rt(RollType::Disadvantage), 0.0)?,
        &d20()
            .plus(5.0)?
            .with_disadvantage()?
            .ac(15.0)?
            .on_hit(h.clone())?
            .to_pmf(0.0)?,
    );
    same(
        &s.under(&rt(RollType::ElvenAccuracy), 0.0)?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(15.0)?
            .three_dice_advantage()?
            .on_hit(h.clone())?
            .to_pmf(0.0)?,
    );
    // `advantage` is two dice even for an attacker with three-dice advantage: the turn upgrades it.
    let three = ac_base()?.three_dice_advantage()?.on_hit(h.clone())?;
    same(
        &three.under(&rt(RollType::Advantage), 0.0)?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(15.0)?
            .on_hit(h.clone())?
            .to_pmf(0.0)?,
    );
    // An attacker that rolls with advantage on its own rolls flat when the context says so.
    let own = d20().plus(5.0)?.with_advantage()?.ac(15.0)?.on_hit(h)?;
    same(&own.under(&plain(), 0.0)?, &s.to_pmf(0.0)?);
    Ok(())
}

/// src/builder/row-facts.test.ts:189
#[test]
fn pinned_keeps_the_attacks_own_roll() -> T {
    let h = hit()?;
    let pinned = d20()
        .plus(5.0)?
        .with_advantage()?
        .pinned()?
        .ac(15.0)?
        .on_hit(h.clone())?;
    for rt in [
        RollType::Flat,
        RollType::Advantage,
        RollType::Disadvantage,
        RollType::ElvenAccuracy,
    ] {
        same(
            &pinned.under(&ctx(|c| c.roll_type = rt), 0.0)?,
            &pinned.to_pmf(0.0)?,
        );
    }
    same(
        &pinned.under(
            &ctx(|c| {
                c.roll_type = RollType::Disadvantage;
                c.crit_on_hit = true;
            }),
            0.0,
        )?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(15.0)?
            .always_crits()?
            .on_hit(h)?
            .to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:197
#[test]
fn auto_hit_is_always_hits() -> T {
    let h = hit()?;
    same(
        &sword()?.under(&ctx(|c| c.auto_hit = true), 0.0)?,
        &d20()
            .plus(5.0)?
            .always_hits()?
            .on_hit(h.clone())?
            .to_pmf(0.0)?,
    );
    let keen = ac_base()?.crit_on(19.0)?.on_hit(h.clone())?;
    same(
        &keen.under(
            &ctx(|c| {
                c.auto_hit = true;
                c.roll_type = RollType::Advantage;
            }),
            0.0,
        )?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .always_hits()?
            .crit_on(19.0)?
            .on_hit(h)?
            .to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:203
#[test]
fn crit_on_hit_is_always_crits_every_hit_crits_a_natural_1_still_misses() -> T {
    let h = hit()?;
    let s = sword()?;
    let crit = ctx(|c| c.crit_on_hit = true);
    same(
        &s.under(&crit, 0.0)?,
        &ac_base()?.always_crits()?.on_hit(h.clone())?.to_pmf(0.0)?,
    );
    assert!(s.under(&crit, 0.0)?.outcome_probability("missNone") > 0.0);
    same(
        &s.under(
            &ctx(|c| {
                c.auto_hit = true;
                c.crit_on_hit = true;
            }),
            0.0,
        )?,
        &d20()
            .plus(5.0)?
            .always_hits()?
            .always_crits()?
            .on_hit(h)?
            .to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:209
#[test]
fn the_attacks_own_auto_hit_auto_crit_stay_on() -> T {
    let h = hit()?;
    let adv = ctx(|c| c.roll_type = RollType::Advantage);
    let always = d20().plus(5.0)?.always_hits()?.on_hit(h.clone())?;
    same(&always.under(&plain(), 0.0)?, &always.to_pmf(0.0)?);
    same(
        &always.under(&adv, 0.0)?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .always_hits()?
            .on_hit(h.clone())?
            .to_pmf(0.0)?,
    );
    let crits = ac_base()?.always_crits()?.on_hit(h.clone())?;
    same(
        &crits.under(&adv, 0.0)?,
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(15.0)?
            .always_crits()?
            .on_hit(h)?
            .to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:217
#[test]
fn vulnerable_doubles_hit_and_crit_damage_as_a_whole_roll_a_miss_is_unchanged() -> T {
    let h = hit()?;
    let vuln = ctx(|c| c.vulnerable = true);
    same(
        &sword()?.under(&vuln, 0.0)?,
        &ac_base()?
            .on_hit(doubled(&h)?)?
            .on_crit(&[Arg::Roll(doubled(&h.double_dice()?)?)])?
            .to_pmf(0.0)?,
    );
    let grazing = ac_base()?.on_hit(h)?.half_on_miss()?;
    let vulnerable = grazing.under(&vuln, 0.0)?;
    let base = grazing.to_pmf(0.0)?;
    assert_eq!(
        branch(&vulnerable, "missDamage", 1.0),
        branch(&base, "missDamage", 1.0)
    );
    assert_eq!(branch(&vulnerable, "hit", 1.0), branch(&base, "hit", 2.0));
    assert_eq!(branch(&vulnerable, "crit", 1.0), branch(&base, "crit", 2.0));
    Ok(())
}

/// src/builder/row-facts.test.ts:229
#[test]
fn auto_fail_penalty_dice_and_joined_do_not_touch_an_attack() -> T {
    let s = sword()?;
    let c = ctx(|c| {
        c.auto_fail = true;
        c.penalty_dice = vec![PenaltyDice {
            count: 1.0,
            sides: 4.0,
        }];
        c.joined = vec!["sneak".to_string()];
    });
    same(&s.under(&c, 0.0)?, &s.to_pmf(0.0)?);
    Ok(())
}

/// src/builder/row-facts.test.ts:233
#[test]
fn range_survives_a_re_derivation() -> T {
    let bow = ac_base()?.ranged()?.on_hit(hit()?)?;
    let re = bow.with_check(|c| Check {
        roll_type: RollType::Advantage,
        ..c
    })?;
    assert_eq!(re.row_check().range, Some(RowRange::Ranged));
    Ok(())
}

/// src/builder/row-facts.test.ts:240
#[test]
fn a_save_the_plain_context_is_to_pmf() -> T {
    let save = save_sample()?;
    same(&save.under(&plain(), 0.0)?, &save.to_pmf(0.0)?);
    same(&save.under(&plain(), EPS)?, &save.to_pmf(EPS)?);
    Ok(())
}

/// src/builder/row-facts.test.ts:245 (the elven-accuracy case is a `RangeError` in TS: only that it throws is asserted).
#[test]
fn a_save_roll_type_is_the_targets_roll() -> T {
    let save = save_sample()?;
    same(
        &save.under(&ctx(|c| c.roll_type = RollType::Advantage), 0.0)?,
        &save_with_roll(d20().plus(5.0)?.with_advantage()?.dc(15.0)?)?.to_pmf(0.0)?,
    );
    same(
        &save.under(&ctx(|c| c.roll_type = RollType::Disadvantage), 0.0)?,
        &save_with_roll(d20().plus(5.0)?.with_disadvantage()?.dc(15.0)?)?.to_pmf(0.0)?,
    );
    err_of(save.under(&ctx(|c| c.roll_type = RollType::ElvenAccuracy), 0.0));
    Ok(())
}

/// src/builder/row-facts.test.ts:251
#[test]
fn a_save_penalty_dice_come_off_the_roll() -> T {
    let save = save_sample()?;
    same(
        &save.under(
            &ctx(|c| {
                c.penalty_dice = vec![PenaltyDice {
                    count: 1.0,
                    sides: 4.0,
                }];
            }),
            0.0,
        )?,
        &save_with_roll(d20().plus(5.0)?.minus_dice(1.0, &d4())?.dc(15.0)?)?.to_pmf(0.0)?,
    );
    same(
        &save.under(
            &ctx(|c| {
                c.penalty_dice = vec![
                    PenaltyDice {
                        count: 1.0,
                        sides: 4.0,
                    },
                    PenaltyDice {
                        count: 2.0,
                        sides: 6.0,
                    },
                ];
                c.roll_type = RollType::Disadvantage;
            }),
            0.0,
        )?,
        &save_with_roll(
            d20()
                .plus(5.0)?
                .with_disadvantage()?
                .minus_dice(1.0, &d4())?
                .minus_dice(2.0, &d6())?
                .dc(15.0)?,
        )?
        .to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:262
#[test]
fn a_save_auto_fail_is_always_fails() -> T {
    let save = save_sample()?;
    let fail = ctx(|c| c.auto_fail = true);
    same(&save.under(&fail, 0.0)?, &save.always_fails()?.to_pmf(0.0)?);
    same(
        &save.under(&fail, 0.0)?,
        &save_with_roll(d20().plus(5.0)?.dc(1000.0)?)?.to_pmf(0.0)?,
    );
    let fails = save.always_fails()?;
    same(
        &fails.under(&ctx(|c| c.roll_type = RollType::Advantage), 0.0)?,
        &fails.to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:269
#[test]
fn a_save_pinned_keeps_the_targets_own_roll() -> T {
    let save = save_sample()?;
    same(
        &save
            .pinned()?
            .under(&ctx(|c| c.roll_type = RollType::Advantage), 0.0)?,
        &save.to_pmf(0.0)?,
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:274
#[test]
fn a_save_vulnerable_doubles_the_failure_damage_the_success_is_unchanged() -> T {
    let four_d6 = rl(4.0, d6())?;
    let plain_save = dc_base()?.on_save_failure_args(&[Arg::Roll(four_d6.clone())])?;
    let vuln = ctx(|c| c.vulnerable = true);
    same(
        &plain_save.under(&vuln, 0.0)?,
        &dc_base()?
            .on_save_failure_args(&[Arg::Roll(doubled(&four_d6)?)])?
            .to_pmf(0.0)?,
    );
    let save = save_sample()?;
    let vulnerable = save.under(&vuln, 0.0)?;
    let base = save.to_pmf(0.0)?;
    assert_eq!(
        branch(&vulnerable, "saveHalf", 1.0),
        branch(&base, "saveHalf", 1.0)
    );
    assert_eq!(
        branch(&vulnerable, "saveFail", 1.0),
        branch(&base, "saveFail", 2.0)
    );
    Ok(())
}

/// src/builder/row-facts.test.ts:282
#[test]
fn a_save_auto_hit_crit_on_hit_and_joined_do_not_touch_it() -> T {
    let save = save_sample()?;
    let c = ctx(|c| {
        c.auto_hit = true;
        c.crit_on_hit = true;
        c.joined = vec!["x".to_string()];
    });
    same(&save.under(&c, 0.0)?, &save.to_pmf(0.0)?);
    Ok(())
}

// ------------------------------------------------------------------ 0.16 withCheck rebinding

/// The 0.16 path a `Turn` takes for a source that reads a granted modifier (`rederive`): the
/// modifier key's flags combined into the source's own roll type through `with_check`, and the plain
/// source itself wherever the resolved context equals the plain one.
fn rebinding(
    source: &AttackBuilder,
    advantage: bool,
    disadvantage: bool,
    crit_on_hit: bool,
    eps: f64,
) -> Result<(Pmf, RowContext), DiceError> {
    let mut combined = None;
    let mut same_plain = false;
    let rederived = source.with_check(|base| {
        let c = combine(base.roll_type, base.advantage_dice, advantage, disadvantage);
        let plain = combine(base.roll_type, base.advantage_dice, false, false);
        let next = Check {
            roll_type: c.roll_type,
            crit_on_hit: base.crit_on_hit || crit_on_hit,
            ..base.clone()
        };
        same_plain = next.roll_type == plain.roll_type && next.crit_on_hit == base.crit_on_hit;
        combined = Some(c);
        next
    })?;
    let expected = if same_plain {
        source.to_pmf(eps)?
    } else {
        rederived.to_pmf(eps)?
    };
    let c = combined.ok_or("with_check never ran its closure")?;
    // What the walk hands `under`: the combined roll, upgraded to three dice where the attacker has them.
    let roll_type = if c.roll_type == RollType::Advantage && c.dice == 3 {
        RollType::ElvenAccuracy
    } else {
        c.roll_type
    };
    Ok((
        expected,
        ctx(|x| {
            x.roll_type = roll_type;
            x.crit_on_hit = crit_on_hit;
        }),
    ))
}

fn expect_matches_rebinding(source: &AttackBuilder) -> T {
    for eps in [0.0, EPS] {
        for key in 0..8u32 {
            let (expected, context) =
                rebinding(source, key & 1 != 0, key & 2 != 0, key & 4 != 0, eps)?;
            assert_eq!(
                pmf_bits(&source.under(&context, eps)?),
                pmf_bits(&expected),
                "key {key} eps {eps}"
            );
        }
    }
    Ok(())
}

/// mulberry32: a small seeded generator, so the sweep is the same on every run.
struct Seeded(u32);

impl Seeded {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn pick<X: Clone>(&mut self, items: &[X]) -> X {
        let i = (self.next() * items.len() as f64).floor() as usize;
        items[i].clone()
    }
}

/// The attack exports of `example.ts` with no auto-hit (the ones the 0.16 rebinding applies to).
fn rebindable() -> Result<Vec<(&'static str, AttackBuilder)>, DiceError> {
    let d12p5 = d12().plus(5.0)?;
    Ok(vec![
        (
            "fullAttack",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?,
        ),
        (
            "fullAttackWithCrit",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?
                .on_crit(&[Arg::Num(5.0), Arg::Roll(d6())])?,
        ),
        (
            "fullAttackWithCritAndMiss",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?
                .on_miss(&[Arg::Num(5.0)])?,
        ),
        (
            "basicAttack",
            d20()
                .plus(6.0)?
                .ac(16.0)?
                .on_hit(rl(2.0, d6())?.plus(4.0)?)?,
        ),
        (
            "detailedAttack",
            d20()
                .plus(9.0)?
                .ac(17.0)?
                .crit_on(19.0)?
                .on_hit(d12p5)?
                .on_crit(&[Arg::Roll(rl(2.0, d12())?.plus(5.0)?)])?
                .on_miss(&[Arg::Num(0.0)])?,
        ),
        (
            "alwaysCritsAttack",
            d20().plus(5.0)?.ac(10.0)?.always_crits()?.on_hit(d8())?,
        ),
    ])
}

/// The remaining attack / save exports of `example.ts`: auto-hit attacks and saves.
type Other = (&'static str, Result<AttackBuilder, SaveBuilder>);

fn others() -> Result<Vec<Other>, DiceError> {
    let three_d6 = Arg::Roll(rl(3.0, d6())?);
    Ok(vec![
        (
            "alwaysHitsAlwaysCrits",
            Ok(d20().always_hits()?.always_crits()?.on_hit(d8())?),
        ),
        (
            "saveFailOnly",
            Err(dc_base()?.on_save_failure_args(std::slice::from_ref(&three_d6))?),
        ),
        (
            "saveHalf",
            Err(dc_base()?
                .on_save_failure_args(std::slice::from_ref(&three_d6))?
                .save_half()?),
        ),
    ])
}

/// src/builder/row-facts.test.ts:339
#[test]
fn example_ts_has_rows_of_both_kinds_to_check() -> T {
    assert!(rebindable()?.len() >= 4);
    assert!(others()?.len() >= 2);
    Ok(())
}

/// src/builder/row-facts.test.ts:344 (one `it.each` row per example, in a loop).
#[test]
fn example_others_its_own_context() -> T {
    for (name, source) in others()? {
        for eps in [0.0, EPS] {
            let own = match &source {
                Ok(a) => a.row_check(),
                Err(s) => s.row_check(),
            };
            let context = ctx(|c| {
                c.roll_type = own.roll_type;
                c.auto_hit = own.auto_hit;
                c.crit_on_hit = own.auto_crit;
                c.auto_fail = own.auto_fail;
            });
            let (under, base) = match &source {
                Ok(a) => (a.under(&context, eps)?, a.to_pmf(eps)?),
                Err(s) => (s.under(&context, eps)?, s.to_pmf(eps)?),
            };
            assert_eq!(pmf_bits(&under), pmf_bits(&base), "{name}");
        }
    }
    Ok(())
}

/// src/builder/row-facts.test.ts:352 (one `it.each` row per example, in a loop).
#[test]
fn example_every_advantage_disadvantage_crit_on_hit_combination() -> T {
    for (_name, source) in rebindable()? {
        expect_matches_rebinding(&source)?;
    }
    Ok(())
}

/// src/builder/row-facts.test.ts:356
#[test]
fn two_hundred_seeded_random_attacks_every_combination() -> T {
    let mut rng = Seeded(0x0b4);
    let dice = [d4(), d6(), d8(), d10(), d12()];
    for _ in 0..200 {
        let mut roll20 = d20().plus(rng.pick(&[-2.0, 0.0, 3.0, 5.0, 8.0, 12.0]))?;
        if rng.next() < 0.3 {
            roll20 = if rng.next() < 0.5 {
                roll20.plus_roll(&d4())?
            } else {
                roll20.minus_roll(&d4())?
            };
        }
        roll20 = match rng.pick(&[0, 1, 2, 3, 4]) {
            0 => roll20,
            1 => roll20.with_advantage()?,
            2 => roll20.with_disadvantage()?,
            3 => roll20.with_elven_accuracy()?,
            _ => roll20.reroll(1.0)?,
        };
        let ac = rng.pick(&[10.0, 13.0, 15.0, 17.0, 20.0, 22.0]);
        let mut check = roll20.ac(ac)?.crit_on(rng.pick(&[18.0, 19.0, 20.0]))?;
        if rng.next() < 0.3 {
            check = check.three_dice_advantage()?;
        }
        if rng.next() < 0.3 {
            check = if rng.next() < 0.5 {
                check.ranged()?
            } else {
                check.melee()?
            };
        }
        let count = 1.0 + (rng.next() * 3.0).floor();
        let die = rng.pick(&dice);
        let damage = rl(count, die)?.plus((rng.next() * 6.0).floor())?;
        let mut attack = if rng.next() < 0.15 {
            check.always_crits()?.on_hit(damage)?
        } else {
            check.on_hit(damage)?
        };
        let shape = rng.next();
        if shape < 0.15 {
            let die = rng.pick(&dice);
            attack = attack.on_crit(&[Arg::Roll(rl(3.0, die)?)])?;
        } else if shape < 0.25 {
            attack = attack.no_crit()?;
        }
        let miss = rng.next();
        if miss < 0.15 {
            attack = attack.half_on_miss()?;
        } else if miss < 0.3 {
            let n = rng.pick(&[1.0, 2.0, 3.0]);
            attack = attack.on_miss(&[Arg::Num(n)])?;
        }
        if rng.next() < 0.2 {
            let die = rng.pick(&dice);
            attack = attack.plus_separate_damage(rl(1.0, die)?);
        }
        if rng.next() < 0.15 {
            attack = attack.reroll_damage(2.0)?;
        }
        if rng.next() < 0.15 {
            attack = attack.minimum_damage_die(2.0)?;
        }
        expect_matches_rebinding(&attack)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ string-damage.test.ts

fn rd(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_with(count, None, None)?.d(sides)
}

fn s(text: &str) -> Arg {
    Arg::Str(text.to_string())
}

fn r(roll: RollBuilder) -> Arg {
    Arg::Roll(roll)
}

fn n(x: f64) -> Arg {
    Arg::Num(x)
}

/// `stringRes.pmf.mean()` close to `builderRes.pmf.mean()`.
fn pmf_means_match(string: &AttackBuilder, built: &AttackBuilder, digits: i32) -> T {
    assert_close(
        string.resolve(0.0)?.pmf.mean(),
        built.resolve(0.0)?.pmf.mean(),
        digits,
    );
    Ok(())
}

/// src/builder/string-damage.test.ts:6
#[test]
fn should_parse_2d6_plus_3_with_explicit_crit_and_match_the_builder() -> T {
    let string = ac(5.0, 15.0)?
        .on_hit_args(&[s("2d6+3")])?
        .on_crit(&[s("4d6+3")])?;
    let built = ac(5.0, 15.0)?.on_hit_args(&[r(rd(2.0, 6.0)?.plus(3.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.weights.hit, b.weights.hit, 10);
    assert_close(a.weights.crit, b.weights.crit, 10);
    assert_close(a.weights.miss, b.weights.miss, 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    assert_eq!(a.hit.min(), b.hit.min());
    assert_eq!(a.hit.max(), b.hit.max());
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    Ok(())
}

/// `d20.plus(modifier).ac(ac)`.
fn ac(modifier: f64, ac: f64) -> Result<RollBuilder, DiceError> {
    d20().plus(modifier)?.ac(ac)
}

/// src/builder/string-damage.test.ts:27
#[test]
fn should_parse_1d8_plus_5_with_explicit_crit_and_match_the_builder() -> T {
    let string = ac(3.0, 12.0)?
        .on_hit_args(&[s("1d8+5")])?
        .on_crit(&[s("2d8+5")])?;
    let built = ac(3.0, 12.0)?.on_hit_args(&[r(rd(1.0, 8.0)?.plus(5.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:38
#[test]
fn should_parse_3d4_with_explicit_crit_and_match_the_builder() -> T {
    let string = ac(7.0, 18.0)?
        .on_hit_args(&[s("3d4")])?
        .on_crit(&[s("6d4")])?;
    let built = ac(7.0, 18.0)?.on_hit_args(&[r(rd(3.0, 4.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:49
#[test]
fn should_parse_constant_damage_10_and_match_roll_0_plus_10() -> T {
    let string = ac(5.0, 15.0)?.on_hit_args(&[s("10")])?;
    let built = ac(5.0, 15.0)?.on_hit_args(&[n(10.0)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:62
#[test]
fn should_parse_2hd6_plus_5_with_explicit_crit_and_match_the_builder_reroll_1() -> T {
    let string = ac(5.0, 15.0)?
        .on_hit_args(&[s("2hd6+5")])?
        .on_crit(&[s("4hd6+5")])?;
    let built = ac(5.0, 15.0)?.on_hit_args(&[r(rd(2.0, 6.0)?.reroll(1.0)?.plus(5.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.weights.hit, b.weights.hit, 10);
    assert_close(a.weights.crit, b.weights.crit, 10);
    assert_close(a.weights.miss, b.weights.miss, 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    assert_eq!(a.hit.min(), b.hit.min());
    assert_eq!(a.hit.max(), b.hit.max());
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:91
#[test]
fn should_parse_1hd12_plus_3_with_explicit_crit_and_match_the_builder_reroll_1() -> T {
    let string = ac(8.0, 16.0)?
        .on_hit_args(&[s("1hd12+3")])?
        .on_crit(&[s("2hd12+3")])?;
    let built = ac(8.0, 16.0)?.on_hit_args(&[r(rd(1.0, 12.0)?.reroll(1.0)?.plus(3.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:112
#[test]
fn should_parse_2kh1_1d12_plus_5_great_weapon_fighting_style() -> T {
    let string = ac(11.0, 15.0)?
        .on_hit_args(&[s("2kh1(1d12)+5")])?
        .on_crit(&[s("2kh1(2d12)+5")])?;
    let built =
        ac(11.0, 15.0)?.on_hit_args(&[r(rd(1.0, 12.0)?.keep_highest(2.0, 1.0)?.plus(5.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.hit.mean(), b.hit.mean(), 5);
    assert_close(a.pmf.mean(), b.pmf.mean(), 5);
    Ok(())
}

/// src/builder/string-damage.test.ts:130
#[test]
fn should_parse_3kl2_1d6_plus_3_and_match_keep_lowest_with_the_same_explicit_crit() -> T {
    let string = ac(10.0, 18.0)?
        .on_hit_args(&[s("3kl2(1d6)+3")])?
        .on_crit(&[s("3kl2(2d6)+3")])?;
    // A keepLowest has no single doubled crit, so the builder states the same crit.
    let built = ac(10.0, 18.0)?
        .on_hit_args(&[r(rd(1.0, 6.0)?.keep_lowest(3.0, 2.0)?.plus(3.0)?)])?
        .on_crit(&[r(rd(2.0, 6.0)?.keep_lowest_all(3.0, 2.0)?.plus(3.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.hit.mean(), b.hit.mean(), 5);
    assert_close(a.crit.mean(), b.crit.mean(), 10);
    assert_close(a.pmf.mean(), b.pmf.mean(), 5);
    Ok(())
}

/// src/builder/string-damage.test.ts:153
#[test]
fn should_parse_on_hit_1d8_plus_3_and_on_crit_3d8_plus_3() -> T {
    let string = ac(5.0, 15.0)?
        .on_hit_args(&[s("1d8+3")])?
        .on_crit(&[s("3d8+3")])?;
    let built = ac(5.0, 15.0)?
        .on_hit_args(&[r(rd(1.0, 8.0)?.plus(3.0)?)])?
        .on_crit(&[r(rd(3.0, 8.0)?.plus(3.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.weights.hit, b.weights.hit, 10);
    assert_close(a.weights.crit, b.weights.crit, 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    assert_close(a.crit.mean(), b.crit.mean(), 10);
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:175
#[test]
fn should_error_when_trying_to_use_default_crit_doubling_with_parsed_strings() -> T {
    let string = ac(5.0, 15.0)?.on_hit_args(&[s("2d6+3")])?;
    let explicit = string.on_crit(&[s("4d6+3")])?;
    assert!(explicit.resolve(0.0)?.pmf.mean() > 0.0);
    Ok(())
}

/// src/builder/string-damage.test.ts:187
#[test]
fn should_parse_on_hit_2d6_plus_3_on_crit_4d6_plus_3_and_on_miss_1d6() -> T {
    let string = ac(5.0, 15.0)?
        .on_hit_args(&[s("2d6+3")])?
        .on_crit(&[s("4d6+3")])?
        .on_miss(&[s("1d6")])?;
    let built = ac(5.0, 15.0)?
        .on_hit_args(&[r(rd(2.0, 6.0)?.plus(3.0)?)])?
        .on_miss(&[r(rd(1.0, 6.0)?)])?;
    let (a, b) = (string.resolve(0.0)?, built.resolve(0.0)?);
    assert_close(a.weights.hit, b.weights.hit, 10);
    assert_close(a.weights.miss, b.weights.miss, 10);
    assert_close(a.hit.mean(), b.hit.mean(), 10);
    assert_close(a.miss.mean(), b.miss.mean(), 10);
    assert_close(a.pmf.mean(), b.pmf.mean(), 10);
    Ok(())
}

/// src/builder/string-damage.test.ts:212
#[test]
fn should_work_with_advantage_and_string_damage() -> T {
    let base = || d20().with_advantage()?.plus(5.0)?.ac(15.0);
    let string = base()?.on_hit_args(&[s("2d6+3")])?.on_crit(&[s("4d6+3")])?;
    let built = base()?
        .on_hit_args(&[r(rd(2.0, 6.0)?.plus(3.0)?)])?
        .on_crit(&[r(rd(4.0, 6.0)?.plus(3.0)?)])?;
    pmf_means_match(&string, &built, 10)
}

/// src/builder/string-damage.test.ts:232
#[test]
fn should_work_with_disadvantage_and_string_damage() -> T {
    let base = || d20().with_disadvantage()?.plus(5.0)?.ac(15.0);
    let string = base()?.on_hit_args(&[s("1d8+3")])?.on_crit(&[s("2d8+3")])?;
    let built = base()?
        .on_hit_args(&[r(rd(1.0, 8.0)?.plus(3.0)?)])?
        .on_crit(&[r(rd(2.0, 8.0)?.plus(3.0)?)])?;
    pmf_means_match(&string, &built, 10)
}

/// src/builder/string-damage.test.ts:252
#[test]
fn should_work_with_bonus_dice_e_g_bless_and_string_damage() -> T {
    let bless = rd(1.0, 4.0)?;
    let base = || d20().plus(5.0)?.with_bonus(&bless)?.ac(15.0);
    let string = base()?.on_hit_args(&[s("2d6+3")])?.on_crit(&[s("4d6+3")])?;
    let built = base()?.on_hit_args(&[r(rd(2.0, 6.0)?.plus(3.0)?)])?;
    pmf_means_match(&string, &built, 10)
}

/// src/builder/string-damage.test.ts:272
#[test]
fn should_work_with_always_hits_and_string_damage() -> T {
    let string = d20()
        .always_hits()?
        .on_hit_args(&[s("2d6+3")])?
        .on_crit(&[s("4d6+3")])?;
    let built = d20()
        .always_hits()?
        .on_hit_args(&[r(rd(2.0, 6.0)?.plus(3.0)?)])?
        .on_crit(&[r(rd(4.0, 6.0)?.plus(3.0)?)])?;
    pmf_means_match(&string, &built, 10)
}

/// src/builder/string-damage.test.ts:285
#[test]
fn should_work_with_always_crits_and_string_damage() -> T {
    let string = ac(5.0, 10.0)?
        .always_crits()?
        .on_hit_args(&[s("2d6+3")])?
        .on_crit(&[s("4d6+3")])?;
    let built = ac(5.0, 10.0)?
        .always_crits()?
        .on_hit_args(&[r(rd(2.0, 6.0)?.plus(3.0)?)])?
        .on_crit(&[r(rd(4.0, 6.0)?.plus(3.0)?)])?;
    pmf_means_match(&string, &built, 10)
}

/// src/builder/string-damage.test.ts:307
#[test]
fn should_preserve_original_string_in_to_expression() -> T {
    let expression = ac(5.0, 15.0)?.on_hit_args(&[s("2d6+3")])?.to_expression()?;
    assert!(expression.contains("2d6+3"), "{expression}");
    Ok(())
}

/// src/builder/string-damage.test.ts:317
#[test]
fn should_handle_subtraction_in_string_expressions() -> T {
    let string = ac(5.0, 15.0)?
        .on_hit_args(&[s("2d6-1")])?
        .on_crit(&[s("4d6-1")])?;
    let built = ac(5.0, 15.0)?.on_hit_args(&[r(rd(2.0, 6.0)?.plus(-1.0)?)])?;
    pmf_means_match(&string, &built, 10)
}

/// src/builder/string-damage.test.ts:330
#[test]
fn should_handle_zero_damage() -> T {
    let string = ac(5.0, 15.0)?.on_hit_args(&[s("0")])?;
    let built = ac(5.0, 15.0)?.on_hit_args(&[n(0.0)])?;
    pmf_means_match(&string, &built, 10)
}

// ------------------------------------------------------------------ example.test.ts (from line 104)
//
// `example.ts` has no Rust port: the builders and `analyze*` helpers each case needs are inlined here.

use crate::query::{DamageStats, DiceQuery, Labels};

fn one(label: &str) -> Labels {
    Labels::One(label.to_string())
}

fn hit_or_crit() -> Labels {
    Labels::Many(vec!["hit".to_string(), "crit".to_string()])
}

fn die_roll(count: f64, die: RollBuilder, modifier: Option<f64>) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), modifier)
}

fn basic_attack() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(6.0)?
        .ac(16.0)?
        .on_hit(die_roll(2.0, d6(), None)?.plus(4.0)?)
}

const BASIC_ATTACK_EXPR: &str = "(d20 + 6 AC 16) * (2d6 + 4) crit (4d6 + 4)";

fn save_half_example() -> Result<SaveBuilder, DiceError> {
    dc_base()?
        .on_save_failure_args(&[Arg::Roll(die_roll(3.0, d6(), None)?)])?
        .save_half()
}

fn complex_damage() -> Result<RollBuilder, DiceError> {
    die_roll(2.0, d6(), None)?
        .plus_roll(&d8())?
        .plus_dice(4.0, &d4())?
        .reroll(1.0)?
        .plus(5.0)
}

struct AttackStats {
    expr: String,
    dpr: f64,
    p_hit_or_crit: f64,
    p_crit: f64,
    hit_damage: DamageStats,
    crit_damage: DamageStats,
}

fn analyze_attack(attack: &AttackBuilder) -> Result<AttackStats, DiceError> {
    let query = DiceQuery::of(vec![attack.to_pmf(0.0)?]);
    Ok(AttackStats {
        expr: attack.to_expression()?,
        dpr: query.mean(),
        p_hit_or_crit: query.prob_at_least_one(hit_or_crit()),
        p_crit: query.prob_at_least_one(one("crit")),
        hit_damage: query.combined_damage_stats("hit"),
        crit_damage: query.combined_damage_stats("crit"),
    })
}

/// `{ dpr, pHitOrCrit }` of an attack through `toQuery()`.
fn dpr_and_p(attack: &AttackBuilder) -> Result<(f64, f64), DiceError> {
    let q = attack.to_query_with(0.0)?;
    Ok((q.mean(), q.prob_at_least_one(hit_or_crit())))
}

/// `compareAdvantageStates`: `(disadvantage, normal, advantage)`.
fn compare_advantage_states(
    to_hit: f64,
    target_ac: f64,
    damage: &RollBuilder,
) -> Result<[(f64, f64); 3], DiceError> {
    let normal = d20().plus(to_hit)?.ac(target_ac)?.on_hit(damage.clone())?;
    let adv = d20()
        .with_advantage()?
        .plus(to_hit)?
        .ac(target_ac)?
        .on_hit(damage.clone())?;
    let dis = d20()
        .with_disadvantage()?
        .plus(to_hit)?
        .ac(target_ac)?
        .on_hit(damage.clone())?;
    Ok([dpr_and_p(&dis)?, dpr_and_p(&normal)?, dpr_and_p(&adv)?])
}

/// `analyzeRoll`: `(expr, min, max, mean, pAtLeastThreshold)`.
fn analyze_roll(
    builder: &RollBuilder,
    threshold: f64,
) -> Result<(String, f64, f64, f64, f64), DiceError> {
    let pmf = builder.to_pmf(0.0)?;
    Ok((
        builder.to_expression()?,
        pmf.min(),
        pmf.max(),
        pmf.mean(),
        pmf.tail_prob_ge(threshold),
    ))
}

/// `analyzeSave`: `(expr, resolved mean, query mean, pFail, pHalf)`.
fn analyze_save(save: &SaveBuilder) -> Result<(String, f64, f64, f64, f64), DiceError> {
    let resolved = save.resolve(0.0)?.pmf.mean();
    let query = DiceQuery::of(vec![save.to_pmf(0.0)?]);
    Ok((
        save.to_expression()?,
        resolved,
        query.mean(),
        query.prob_at_least_one(one("saveFail")),
        query.prob_at_least_one(one("saveHalf")),
    ))
}

/// src/builder/example.test.ts:104 (the `builderMap` / `expectedExpressions` pairs, built inline).
#[test]
fn should_produce_expected_expressions_for_all_catalog_examples() -> T {
    let sides = |s: f64| Some(SidesOrDie::Sides(s));
    let (d6b, d8b) = (d6(), d8());
    let rows: Vec<(&str, String, &str)> = vec![
        (
            "basic2d6Plus3",
            die_roll(2.0, d6b.clone(), None)?
                .plus(3.0)?
                .to_expression()?,
            "2d6 + 3",
        ),
        (
            "basicShorthandRoll",
            roll_with(2.0, sides(6.0), Some(3.0))?.to_expression()?,
            "2d6 + 3",
        ),
        ("shortcutDie", d8b.plus(2.0)?.to_expression()?, "1d8 + 2"),
        ("flatFive", flat(5.0)?.to_expression()?, "5"),
        (
            "negativeBaseDieInline",
            die_roll(-1.0, d8(), None)?.to_expression()?,
            "0 - 1d8",
        ),
        (
            "negativeBaseDie",
            roll_with(-1.0, None, None)?.d8()?.to_expression()?,
            "0 - 1d8",
        ),
        (
            "subtractBonusDie",
            d20().minus_roll(&d4())?.to_expression()?,
            "d20 - 1d4",
        ),
        ("singleD20", d20().to_expression()?, "d20"),
        (
            "addAWholeBunch",
            d6().plus_roll(&d8())?
                .plus_roll(&d10())?
                .plus_roll(&d12())?
                .plus_roll(&d20())?
                .to_expression()?,
            "d20 + 1d12 + 1d10 + 1d8 + 1d6",
        ),
        (
            "subtractAWholeBunch",
            d6().minus_roll(&d8())?
                .minus_roll(&d10())?
                .minus_roll(&d12())?
                .minus_roll(&d20())?
                .to_expression()?,
            "1d6 - 1d20 - 1d12 - 1d10 - 1d8",
        ),
        ("halflingD20", d20().reroll(1.0)?.to_expression()?, "hd20"),
        ("halflingD20Shorthand", hd20().to_expression()?, "hd20"),
        (
            "twoD6Reroll12",
            die_roll(2.0, d6(), None)?.reroll(2.0)?.to_expression()?,
            "2(d6 reroll d2)",
        ),
        ("min2OnD6", d6().minimum(2.0)?.to_expression()?, "2>d6"),
        (
            "kh3Of4d6",
            die_roll(4.0, d6(), None)?
                .keep_highest(4.0, 3.0)?
                .to_expression()?,
            "4kh3(1d6)",
        ),
        (
            "kl2Of4d8",
            die_roll(4.0, d8(), None)?
                .keep_lowest(4.0, 2.0)?
                .to_expression()?,
            "4kl2(1d8)",
        ),
        (
            "advD20",
            d20().with_advantage()?.to_expression()?,
            "d20 > d20",
        ),
        (
            "halflingAdv",
            d20().reroll(1.0)?.with_advantage()?.to_expression()?,
            "hd20 > hd20",
        ),
        (
            "disD20",
            d20().with_disadvantage()?.to_expression()?,
            "d20 < d20",
        ),
        (
            "complexDamage",
            complex_damage()?.to_expression()?,
            "4(d4 reroll 1) + 1d8 + 2d6 + 5",
        ),
        (
            "doubledD8",
            d8().plus(5.0)?.double_dice()?.to_expression()?,
            "2d8 + 5",
        ),
        (
            "bestOfExample",
            die_roll(4.0, d6(), None)?.best_of(3.0)?.to_expression()?,
            "4kh3(1d6)",
        ),
        (
            "basicAttackCheck",
            d20().plus(7.0)?.ac(15.0)?.to_expression()?,
            "(d20 + 7 AC 15)",
        ),
        (
            "blessedAttack",
            d20()
                .plus_roll(&d4())?
                .plus(7.0)?
                .ac(15.0)?
                .to_expression()?,
            "(d20 + 7 + 1d4 AC 15)",
        ),
        (
            "elvenAccuracyAttack",
            d20()
                .with_elven_accuracy()?
                .plus(8.0)?
                .ac(18.0)?
                .to_expression()?,
            "(d20 > d20 > d20 + 8 AC 18)",
        ),
        (
            "basicAttack",
            basic_attack()?.to_expression()?,
            BASIC_ATTACK_EXPR,
        ),
        (
            "detailedAttack",
            d20()
                .plus(9.0)?
                .ac(17.0)?
                .crit_on(19.0)?
                .on_hit(d12().plus(5.0)?)?
                .on_crit(&[Arg::Roll(die_roll(2.0, d12(), None)?.plus(5.0)?)])?
                .on_miss(&[Arg::Num(0.0)])?
                .to_expression()?,
            "(d20 + 9 AC 17) * (1d12 + 5) xcrit2 (2d12 + 5) miss (0)",
        ),
        (
            "alwaysCritsAttack",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .always_crits()?
                .on_hit(d8())?
                .to_expression()?,
            "(d20 + 5 AC 10) * (1d8) xcrit20 (2d8)",
        ),
        (
            "alwaysHitsAlwaysCrits",
            d20()
                .always_hits()?
                .always_crits()?
                .on_hit(d8())?
                .to_expression()?,
            "d20 * (1d8) xcrit20 (2d8)",
        ),
        (
            "basicSaveCheck",
            dc_base()?.to_expression()?,
            "(d20 + 5 DC 15)",
        ),
        (
            "saveFailOnly",
            dc_base()?
                .on_save_failure_args(&[Arg::Roll(die_roll(3.0, d6(), None)?)])?
                .to_expression()?,
            "(d20 + 5 DC 15) * (3d6)",
        ),
        (
            "saveHalf",
            save_half_example()?.to_expression()?,
            "(d20 + 5 DC 15) * (3d6) save half",
        ),
        (
            "disadvantagedSave",
            d20().with_disadvantage()?.dc(14.0)?.to_expression()?,
            "(d20 < d20 DC 14)",
        ),
        (
            "factoryOverload",
            die_roll(4.0, d4(), Some(1.0))?.to_expression()?,
            "4d4 + 1",
        ),
        (
            "doubleD6",
            die_roll(2.0, d6(), None)?.to_expression()?,
            "2d6",
        ),
        (
            "doubleD6Plus1",
            die_roll(2.0, d6().plus(1.0)?, None)?.to_expression()?,
            "2d6 + 2",
        ),
        (
            "double2d6",
            die_roll(2.0, die_roll(2.0, d6(), None)?, None)?.to_expression()?,
            "4d6",
        ),
        (
            "double2d6plus3",
            die_roll(2.0, die_roll(2.0, d6(), None)?.plus(3.0)?, None)?.to_expression()?,
            "4d6 + 6",
        ),
        (
            "tripleComplexRoll",
            die_roll(3.0, d8().plus_roll(&d4())?.plus(2.0)?, None)?.to_expression()?,
            "3d8 + 3d4 + 6",
        ),
        (
            "realisticChaining",
            die_roll(3.0, d6(), None)?
                .plus_dice(2.0, &d8())?
                .plus(4.0)?
                .to_expression()?,
            "2d8 + 3d6 + 4",
        ),
        (
            "fullAttack",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?
                .to_expression()?,
            "(d20 + 5 AC 10) * (2d6) crit (4d6)",
        ),
        (
            "fullAttackWithCrit",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?
                .on_crit(&[Arg::Num(5.0), Arg::Roll(d6())])?
                .to_expression()?,
            "(d20 + 5 AC 10) * (2d6) crit (5d6)",
        ),
        (
            "fullAttackWithCritAndMiss",
            d20()
                .plus(5.0)?
                .ac(10.0)?
                .on_hit_args(&[Arg::Num(2.0), Arg::Roll(d6())])?
                .on_miss(&[Arg::Num(5.0)])?
                .to_expression()?,
            "(d20 + 5 AC 10) * (2d6) crit (4d6) miss (5)",
        ),
        (
            "basicDamageRoll",
            d6().plus(3.0)?.to_expression()?,
            "1d6 + 3",
        ),
        (
            "basicShorthandD6Roll",
            roll_with(2.0, Some(SidesOrDie::Die(d6())), Some(3.0))?.to_expression()?,
            "2d6 + 3",
        ),
        (
            "basicShorthandD6Plus3Roll",
            die_roll(2.0, d6().plus(3.0)?, None)?.to_expression()?,
            "2d6 + 6",
        ),
    ];
    for (name, got, expected) in rows {
        assert_eq!(got, expected, "{name}");
    }
    Ok(())
}

/// src/builder/example.test.ts:112
#[test]
fn should_confirm_that_halfling_d20_shorthand_and_longhand_expressions_match() -> T {
    assert_eq!(hd20().to_expression()?, d20().reroll(1.0)?.to_expression()?);
    Ok(())
}

/// src/builder/example.test.ts:118
#[test]
fn should_analyze_a_roll_pmf_with_threshold_queries() -> T {
    let (expr, min, max, mean, p) = analyze_roll(&die_roll(2.0, d6(), None)?.plus(3.0)?, 10.0)?;
    assert_eq!(expr, "2d6 + 3");
    assert_eq!(min, 5.0);
    assert_eq!(max, 15.0);
    assert_close(mean, 10.0, 5);
    assert!(p > 0.0 && p <= 1.0);
    Ok(())
}

/// src/builder/example.test.ts:128
#[test]
fn should_analyze_a_single_attack_via_dice_query() -> T {
    let stats = analyze_attack(&basic_attack()?)?;
    assert_eq!(stats.expr, BASIC_ATTACK_EXPR);
    assert!(stats.dpr > 0.0);
    assert!(stats.p_hit_or_crit > 0.0 && stats.p_hit_or_crit <= 1.0);
    assert_close(stats.p_crit, 0.05, 2);
    assert!(stats.hit_damage.min > 0.0);
    assert!(stats.crit_damage.min > 0.0);
    Ok(())
}

/// src/builder/example.test.ts:139
#[test]
fn should_compare_disadvantage_normal_advantage_correctly() -> T {
    let damage = die_roll(2.0, d6(), None)?.plus(4.0)?;
    let [dis, normal, adv] = compare_advantage_states(6.0, 16.0, &damage)?;
    assert!(dis.0 > 0.0);
    assert!(normal.0 > dis.0);
    assert!(adv.0 > normal.0);
    assert!(dis.1 < normal.1);
    assert!(adv.1 > normal.1);
    Ok(())
}

/// src/builder/example.test.ts:151
#[test]
fn should_aggregate_two_attacks() -> T {
    let pmf = basic_attack()?.to_pmf(0.0)?;
    let query = DiceQuery::of(vec![pmf.clone(), pmf]);
    assert!(query.mean() > 0.0);
    let one_hit_or_crit = query.prob_at_least_one(hit_or_crit());
    assert!(one_hit_or_crit > 0.0 && one_hit_or_crit <= 1.0);
    assert!(query.prob_at_least_one(one("crit")) > 0.0);
    Ok(())
}

/// src/builder/example.test.ts:160
#[test]
fn should_quantify_bless_what_if() -> T {
    let damage = die_roll(2.0, d6(), None)?.plus(4.0)?;
    let base = d20().plus(6.0)?;
    let blessed = base.plus_roll(&d4())?.ac(16.0)?.on_hit(damage.clone())?;
    let normal = base.ac(16.0)?.on_hit(damage)?;
    let (n, b) = (dpr_and_p(&normal)?, dpr_and_p(&blessed)?);
    assert!(b.0 > n.0);
    assert!(b.1 > n.1);
    let lift = blessed.to_query_with(0.0)?.mean() - normal.to_query_with(0.0)?.mean();
    assert_close(lift, b.0 - n.0, 8);
    Ok(())
}

/// src/builder/example.test.ts:170
#[test]
fn should_analyze_saves_via_resolve_and_query() -> T {
    let (expr, resolved_mean, query_mean, p_fail, p_half) = analyze_save(&save_half_example()?)?;
    assert_eq!(expr, "(d20 + 5 DC 15) * (3d6) save half");
    assert!(resolved_mean >= 0.0);
    assert!(query_mean >= 0.0);
    assert_close(p_fail + p_half, 1.0, 5);
    Ok(())
}

/// src/builder/example.test.ts:179 (`Object.keys(weights).length > 0`: `SaveWeights` always has its two fields).
#[test]
fn should_resolve_a_save_example_and_return_stats() -> T {
    let res = save_half_example()?.resolve(0.0)?;
    assert!(res.pmf.mean() > 0.0);
    assert!(res.weights.success.is_finite() && res.weights.fail.is_finite());
    Ok(())
}

/// src/builder/example.test.ts:186
#[test]
fn should_run_demo_analyses_without_errors_and_with_sensible_bounds() -> T {
    let damage = die_roll(2.0, d6(), None)?.plus(4.0)?;
    let [dis, _normal, adv] = compare_advantage_states(6.0, 16.0, &damage)?;
    let basic_atk = analyze_attack(&basic_attack()?)?;
    let (_, min, ..) = analyze_roll(&complex_damage()?, 10.0)?;
    let (_, resolved_mean, ..) = analyze_save(&save_half_example()?)?;
    assert!(basic_atk.dpr > 0.0);
    assert!(adv.0 > dis.0);
    assert!(min >= 0.0);
    assert!(resolved_mean >= 0.0);
    Ok(())
}

// ------------------------------------------------------------------ tests/check-order.test.ts
//
// A check is a sum: the natural d20, its bonus dice (Bless, Bane, Guidance) and its flat bonus. The
// references come from an independent enumeration over the natural d20 and the bonus dice.

use crate::parser::parse_with;
use std::collections::BTreeMap;

/// `.plus(n)`, `.minus(n)`, `.plus(dN)` or `.minus(dN)` (`Die(-4)` is `.minus(d4)`).
#[derive(Clone, Copy)]
enum Step {
    Plus(f64),
    Minus(f64),
    Die(i32),
}

fn die_of(sides: i32) -> RollBuilder {
    match sides.abs() {
        4 => d4(),
        _ => d6(),
    }
}

fn spell(root: RollBuilder, steps: &[Step]) -> Result<RollBuilder, DiceError> {
    let mut r = root;
    for step in steps {
        r = match *step {
            Step::Plus(n) => r.plus(n)?,
            Step::Minus(n) => r.minus(n)?,
            Step::Die(s) if s > 0 => r.plus_roll(&die_of(s))?,
            Step::Die(s) => r.minus_roll(&die_of(s))?,
        };
    }
    Ok(r)
}

fn root_of(kind: RollType) -> Result<RollBuilder, DiceError> {
    match kind {
        RollType::Flat => Ok(d20()),
        RollType::Advantage => d20().with_advantage(),
        RollType::Disadvantage => d20().with_disadvantage(),
        RollType::ElvenAccuracy => d20().with_elven_accuracy(),
    }
}

/// P(natural = r) for a d20 rolled once, or kept high/low from two or three.
fn natural_d20(kind: RollType) -> Vec<(i32, f64)> {
    let lifted = |c: f64| match kind {
        RollType::Advantage => c.powi(2),
        RollType::ElvenAccuracy => c.powi(3),
        RollType::Disadvantage => 1.0 - (1.0 - c).powi(2),
        RollType::Flat => c,
    };
    (1..=20)
        .map(|r| {
            (
                r,
                lifted(f64::from(r) / 20.0) - lifted(f64::from(r - 1) / 20.0),
            )
        })
        .collect()
}

/// Bonus dice as signed sides: 4 is +d4 (Bless), -4 is -d4 (Bane).
fn bonus_sum(dice: &[i32]) -> Vec<(i32, f64)> {
    let mut dist: BTreeMap<i32, f64> = BTreeMap::from([(0, 1.0)]);
    for &signed in dice {
        let sides = signed.abs();
        let mut next: BTreeMap<i32, f64> = BTreeMap::new();
        for (&v, &p) in &dist {
            for f in 1..=sides {
                *next.entry(v + signed.signum() * f).or_insert(0.0) += p / f64::from(sides);
            }
        }
        dist = next;
    }
    dist.into_iter().collect()
}

/// `(hit, crit, miss)` by enumeration.
fn enumerate_attack(
    kind: RollType,
    dice: &[i32],
    flat_bonus: i32,
    ac: i32,
    crit_on: i32,
) -> (f64, f64, f64) {
    let bonus = bonus_sum(dice);
    let (mut hit, mut crit, mut miss) = (0.0, 0.0, 0.0);
    for (r, pr) in natural_d20(kind) {
        if r == 1 {
            miss += pr;
            continue;
        }
        if r == 20 {
            crit += pr;
            continue;
        }
        let reaches: f64 = bonus
            .iter()
            .filter(|(v, _)| r + v + flat_bonus >= ac)
            .map(|(_, p)| p)
            .sum();
        if r >= crit_on {
            crit += pr * reaches;
        } else {
            hit += pr * reaches;
        }
        miss += pr * (1.0 - reaches);
    }
    (hit, crit, miss)
}

fn enumerate_save_fail(kind: RollType, dice: &[i32], flat_bonus: i32, dc: i32) -> f64 {
    let bonus = bonus_sum(dice);
    let mut fail = 0.0;
    for (r, pr) in natural_d20(kind) {
        for (v, p) in &bonus {
            if r + v + flat_bonus < dc {
                fail += pr * p;
            }
        }
    }
    fail
}

#[track_caller]
fn expect_same_pmf(actual: &Pmf, expected: &Pmf, what: &str) {
    let mut support: Vec<f64> = actual.support().iter().map(|d| d.0).collect();
    support.extend(expected.support().iter().map(|d| d.0));
    for value in support {
        let diff = (actual.p_at(value) - expected.p_at(value)).abs();
        assert!(diff <= 1e-12, "{what}: bin {value}: {diff}");
    }
}

const ROOT_KINDS: [RollType; 4] = [
    RollType::Flat,
    RollType::Advantage,
    RollType::Disadvantage,
    RollType::ElvenAccuracy,
];

type Spellings = Vec<(&'static str, Vec<Step>)>;

/// Each row: the bonus dice, the net flat bonus and one check written every way.
fn orderings() -> Vec<(Vec<i32>, i32, Spellings)> {
    use Step::*;
    vec![
        (
            vec![4],
            5,
            vec![
                ("d20.plus(5).plus(d4)", vec![Plus(5.0), Die(4)]),
                ("d20.plus(d4).plus(5)", vec![Die(4), Plus(5.0)]),
            ],
        ),
        (
            vec![4, 6],
            5,
            vec![
                (
                    "d20.plus(5).plus(d4).plus(d6)",
                    vec![Plus(5.0), Die(4), Die(6)],
                ),
                (
                    "d20.plus(d4).plus(5).plus(d6)",
                    vec![Die(4), Plus(5.0), Die(6)],
                ),
                (
                    "d20.plus(d4).plus(d6).plus(5)",
                    vec![Die(4), Die(6), Plus(5.0)],
                ),
            ],
        ),
        (
            vec![4],
            3,
            vec![
                ("d20.plus(3).plus(d4)", vec![Plus(3.0), Die(4)]),
                (
                    "d20.plus(5).plus(d4).minus(2)",
                    vec![Plus(5.0), Die(4), Minus(2.0)],
                ),
                (
                    "d20.plus(d4).minus(2).plus(5)",
                    vec![Die(4), Minus(2.0), Plus(5.0)],
                ),
            ],
        ),
        (
            vec![-4],
            5,
            vec![
                ("d20.plus(5).minus(d4)", vec![Plus(5.0), Die(-4)]),
                ("d20.minus(d4).plus(5)", vec![Die(-4), Plus(5.0)]),
            ],
        ),
    ]
}

const AC: i32 = 15;

/// tests/check-order.test.ts:143
#[test]
fn d20_plus_d4_plus_5_vs_ac_15_2d6_on_a_hit() -> T {
    let pmf = spell(d20(), &[Step::Die(4), Step::Plus(5.0)])?
        .ac(15.0)?
        .on_hit(die_roll(2.0, d6(), None)?)?
        .to_pmf(0.0)?;
    assert_close(pmf.outcome_probability("hit"), 5.0 / 8.0, 12);
    assert_close(pmf.outcome_probability("crit"), 1.0 / 20.0, 12);
    assert_close(pmf.outcome_probability("missNone"), 13.0 / 40.0, 12);
    assert_close(pmf.mean(), 203.0 / 40.0, 12);
    Ok(())
}

/// tests/check-order.test.ts:165 (one row per kind x crit threshold x ordering x spelling, in loops).
#[test]
fn spelling_hit_crit_miss_match_the_enumeration_and_the_attack_matches_the_first_spelling() -> T {
    let with_crit = |check: RollBuilder, crit_on: i32| -> Result<RollBuilder, DiceError> {
        if crit_on == 20 {
            check.ac(f64::from(AC))
        } else {
            check.ac(f64::from(AC))?.crit_on(f64::from(crit_on))
        }
    };
    let two_d6 = || die_roll(2.0, d6(), None);
    for kind in ROOT_KINDS {
        for crit_on in [20, 19] {
            for (dice, flat_bonus, spellings) in orderings() {
                let exact = enumerate_attack(kind, &dice, flat_bonus, AC, crit_on);
                let reference_attack = with_crit(spell(root_of(kind)?, &spellings[0].1)?, crit_on)?
                    .on_hit(two_d6()?)?;
                let reference = reference_attack.to_pmf(0.0)?;
                // parse() has no natural-1 auto-miss, so it agrees with the builder only where a natural
                // 1 cannot reach the AC anyway. Every spelling still has to parse to the same attack.
                let natural_one_can_hit =
                    1 + flat_bonus + dice.iter().map(|s| (*s).max(-1)).sum::<i32>() >= AC;
                for (name, steps) in &spellings {
                    let check = with_crit(spell(root_of(kind)?, steps)?, crit_on)?;
                    let attack = check.on_hit(two_d6()?)?;
                    let pmf = attack.to_pmf(0.0)?;
                    assert_close(pmf.outcome_probability("hit"), exact.0, 12);
                    assert_close(pmf.outcome_probability("crit"), exact.1, 12);
                    assert_close(pmf.outcome_probability("missNone"), exact.2, 12);
                    expect_same_pmf(&pmf, &reference, name);
                    let first = with_crit(spell(root_of(kind)?, &spellings[0].1)?, crit_on)?;
                    expect_same_pmf(
                        &check.to_pmf(0.0)?,
                        &first.to_pmf(0.0)?,
                        &format!("{name} check"),
                    );
                    let round_trip = parse_with(&attack.to_expression()?, 0.0)?;
                    let round_trip_ref = parse_with(&reference_attack.to_expression()?, 0.0)?;
                    expect_same_pmf(&round_trip, &round_trip_ref, &format!("{name} round trip"));
                    if !natural_one_can_hit {
                        expect_same_pmf(
                            &round_trip,
                            &pmf,
                            &format!("{name} round trip vs builder"),
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

/// tests/check-order.test.ts:191 (one row per kind x ordering x spelling, in loops; `dc()` refuses elven accuracy).
#[test]
fn save_spelling_vs_dc_15_p_fail_matches_the_enumeration() -> T {
    for kind in ROOT_KINDS
        .into_iter()
        .filter(|k| *k != RollType::ElvenAccuracy)
    {
        for (dice, flat_bonus, spellings) in orderings() {
            let fail = enumerate_save_fail(kind, &dice, flat_bonus, AC);
            for (_name, steps) in &spellings {
                let save = spell(root_of(kind)?, steps)?.dc(f64::from(AC))?;
                let mean = save
                    .on_save_failure_args(&[Arg::Roll(flat(10.0)?)])?
                    .to_pmf(0.0)?
                    .mean();
                assert_close(mean, 10.0 * fail, 12);
                assert_close(save.to_pmf(0.0)?.p_at(1.0), fail, 12);
            }
        }
    }
    Ok(())
}

/// tests/check-order.test.ts:208 (one row per `{ name, dice, p, spellings }`, in a loop).
#[test]
fn always_crit_attack_resolves_the_same_however_its_flat_bonus_and_bonus_dice_are_ordered() -> T {
    use Step::*;
    type CritRow = (&'static str, Vec<i32>, f64, Vec<Vec<Step>>);
    let rows: Vec<CritRow> = vec![
        (
            "d20 + d4 + 5: 27/40 × 14 = 9.45",
            vec![4],
            27.0 / 40.0,
            vec![vec![Die(4), Plus(5.0)], vec![Plus(5.0), Die(4)]],
        ),
        (
            "d20 - d4 + 5: 17/40 × 14 = 5.95",
            vec![-4],
            17.0 / 40.0,
            vec![vec![Die(-4), Plus(5.0)], vec![Plus(5.0), Die(-4)]],
        ),
    ];
    for (_name, dice, p, spellings) in rows {
        let exact = enumerate_attack(RollType::Flat, &dice, 5, AC, 20);
        assert_close(exact.0 + exact.1, p, 12);
        for steps in spellings {
            let pmf = spell(d20(), &steps)?
                .ac(f64::from(AC))?
                .always_crits()?
                .on_hit(die_roll(2.0, d6(), None)?)?
                .to_pmf(0.0)?;
            assert_close(pmf.outcome_probability("crit"), p, 12);
            assert_close(pmf.outcome_probability("hit"), 0.0, 12);
            assert_close(pmf.mean(), p * 14.0, 12);
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ tests/attribution-conservation.test.ts
//
// `PMF.damageAttributionChartModel` is not in the Rust port. `DiceQuery::attribution_by_value` is
// (`combinedWithAttribution().attributionByValue()`), so the cases that read the model through a
// `DiceQuery` build its dense, un-binned columns here from that split (`Chart`). The cases that call
// the model on a bare PMF stay deferred (see the report).

/// The dense columns of `damageAttributionChartModel()` (no `maxBuckets`).
struct Chart {
    labels: Vec<f64>,
    series: BTreeMap<String, Vec<f64>>,
    shares: BTreeMap<String, Vec<f64>>,
    totals: Vec<f64>,
}

impl Chart {
    fn mass(&self) -> f64 {
        self.totals.iter().sum()
    }

    fn series(&self, outcome: &str) -> &[f64] {
        self.series.get(outcome).map_or(&[], Vec::as_slice)
    }

    fn share(&self, outcome: &str) -> &[f64] {
        self.shares.get(outcome).map_or(&[], Vec::as_slice)
    }

    fn index_of(&self, label: f64) -> Option<usize> {
        self.labels.iter().position(|l| *l == label)
    }
}

/// `damageAttributionChartModel()` of the query's `combinedWithAttribution()`.
fn chart(query: &DiceQuery) -> Chart {
    const ORDER: [&str; 7] = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit",
    ];
    let pmf = query.combined_with_attribution();
    let split = query.attribution_by_value();
    let mut outcomes: Vec<String> = Vec::new();
    for bin in pmf.map.values() {
        for k in bin
            .count
            .keys()
            .chain(bin.attr.iter().flat_map(|a| a.keys()))
        {
            if !outcomes.contains(k) {
                outcomes.push(k.clone());
            }
        }
    }
    let rank = |o: &String| ORDER.iter().position(|x| x == o);
    outcomes.sort_by(|a, b| match (rank(a), rank(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(b),
    });
    let has_attribution = !outcomes.is_empty();
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut widen = |d: f64| {
        min = min.min(d);
        max = max.max(d);
    };
    if has_attribution {
        for s in split.values() {
            for (d, m) in s {
                if *m > 0.0 {
                    widen(d.0);
                }
            }
        }
    } else {
        for (d, b) in &pmf.map {
            if b.p > 0.0 {
                widen(d.0);
            }
        }
    }
    let empty = Chart {
        labels: vec![],
        series: BTreeMap::new(),
        shares: BTreeMap::new(),
        totals: vec![],
    };
    if max < min {
        return empty;
    }
    let num = (max - min) as usize + 1;
    let labels: Vec<f64> = (0..num).map(|i| min + i as f64).collect();
    let bucket = |d: f64| (d - min).floor() as usize;
    let mut series = BTreeMap::new();
    for outcome in &outcomes {
        let mut arr = vec![0.0; num];
        if let Some(s) = split.get(outcome) {
            for (d, m) in s {
                let b = bucket(d.0);
                if d.0 >= min && b < num {
                    arr[b] += m;
                }
            }
        }
        series.insert(outcome.clone(), arr);
    }
    let mut totals = vec![0.0; num];
    if has_attribution {
        for arr in series.values() {
            for i in 0..num {
                totals[i] += arr[i];
            }
        }
    } else {
        for (d, b) in &pmf.map {
            if b.p > 0.0 && d.0 >= min && bucket(d.0) < num {
                totals[bucket(d.0)] += b.p;
            }
        }
    }
    let shares = series
        .iter()
        .map(|(o, arr)| {
            let sh = (0..num)
                .map(|i| {
                    if totals[i] > 1e-9 {
                        arr[i] / totals[i]
                    } else {
                        0.0
                    }
                })
                .collect();
            (o.clone(), sh)
        })
        .collect();
    Chart {
        labels,
        series,
        shares,
        totals,
    }
}

/// d20+8 vs AC 16, 1d6+5 — the attack the review measured the bug with.
fn review_sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .plus(8.0)?
        .ac(16.0)?
        .on_hit(roll_with(1.0, Some(SidesOrDie::Sides(6.0)), None)?.plus(5.0)?)
}

/// tests/attribution-conservation.test.ts:18 (deferred: `chartMass(conv)` calls the model on a bare PMF; the mass assertion is translated).
#[test]
fn convolve_many_sum_bucket_totals_equals_mass() -> T {
    let pmf = review_sword()?.to_pmf(0.0)?;
    let conv = Pmf::convolve_many(&[pmf.clone(), pmf], EPS);
    assert_close(conv.mass(), 1.0, 12);
    Ok(())
}

/// tests/attribution-conservation.test.ts:30
#[test]
fn provided_combined_sum_bucket_totals_equals_mass() -> T {
    let pmf = review_sword()?.to_pmf(0.0)?;
    let singles = vec![pmf.clone(), pmf];
    let q = DiceQuery::new(
        singles.clone(),
        Some(Pmf::convolve_many(&singles, EPS)),
        EPS,
    );
    assert_close(chart(&q).mass(), 1.0, 12);
    Ok(())
}

/// tests/attribution-conservation.test.ts:36
#[test]
fn frequency_gated_row_sum_bucket_totals_equals_mass() -> T {
    let pmf = review_sword()?.to_pmf(0.0)?;
    let singles = vec![pmf.apply_hit_frequency(0.5), pmf];
    let q = DiceQuery::new(
        singles.clone(),
        Some(Pmf::convolve_many(&singles, EPS)),
        EPS,
    );
    assert_close(chart(&q).mass(), 1.0, 12);
    Ok(())
}

/// tests/attribution-conservation.test.ts:45
#[test]
fn a_guaranteed_miss_convolved_with_an_always_10_hit_attributes_the_bin_entirely_to_hit() -> T {
    // The miss deals 0, so the 10-damage bin is 100% hit and 0% missNone, not the 50/50 count split.
    let always10 = d20().always_hits()?.on_hit(flat(10.0)?)?.no_crit()?;
    let model = chart(&DiceQuery::of(vec![
        Pmf::miss_none(EPS),
        always10.to_pmf(0.0)?,
    ]));
    let bin = model.index_of(10.0).ok_or("no bin at 10")?;
    assert_close(model.share("hit")[bin], 1.0, 12);
    assert_eq!(model.share("missNone")[bin], 0.0);
    Ok(())
}

/// tests/attribution-conservation.test.ts:58
#[test]
fn a_crit_11_and_a_hit_6_that_share_a_17_damage_bin_split_11_17_and_6_17() -> T {
    // Damage share, not outcome-count share.
    let crit11 = d20().always_hits()?.always_crits()?.on_hit(flat(11.0)?)?;
    let hit6 = d20().always_hits()?.on_hit(flat(6.0)?)?.no_crit()?;
    let model = chart(&DiceQuery::of(vec![crit11.to_pmf(0.0)?, hit6.to_pmf(0.0)?]));
    let bin = model.index_of(17.0).ok_or("no bin at 17")?;
    assert_close(model.share("crit")[bin], 11.0 / 17.0, 12);
    assert_close(model.share("hit")[bin], 6.0 / 17.0, 12);
    Ok(())
}

/// tests/attribution-conservation.test.ts:97
#[test]
fn dice_query_singles_path_keeps_its_per_value_splits() -> T {
    let model = chart(&DiceQuery::of(vec![review_sword()?.to_pmf(0.0)?]));
    let at = |label: f64| model.index_of(label).ok_or("missing bucket");
    assert_close(model.series("hit")[at(6.0)?], 0.1, 12);
    assert_close(model.series("missNone")[at(0.0)?], 0.35, 12);
    Ok(())
}

/// tests/attribution-conservation.test.ts:117 (deferred: `chartMass(conv)` calls the model on a bare PMF; the mass assertion is translated).
#[test]
fn a_zero_damage_source_convolved_with_a_normal_attack_conserves_mass() -> T {
    let zero_hit = d20().plus(5.0)?.ac(15.0)?.on_hit(flat(0.0)?)?;
    let conv = Pmf::convolve_many(&[zero_hit.to_pmf(0.0)?, review_sword()?.to_pmf(0.0)?], EPS);
    assert_close(conv.mass(), 1.0, 12);
    Ok(())
}

/// tests/attribution-conservation.test.ts:133
#[test]
fn a_negative_damage_hit_convolved_with_a_positive_save_falls_back_to_count() -> T {
    // A hit that always deals -1 (resistance) convolved with a save that always deals 3 lands at
    // damage 2 with attr { hit: -1, saveFail: 3 }; the split falls back to count, so each label
    // keeps half and the chart conserves mass.
    let neg_hit = d20().always_hits()?.on_hit(flat(-1.0)?)?.no_crit()?;
    let pos_save = flat(10.0)?
        .dc(12.0)?
        .on_save_failure_args(&[Arg::Roll(flat(3.0)?)])?;
    let model = chart(&DiceQuery::of(vec![
        neg_hit.to_pmf(0.0)?,
        pos_save.to_pmf(0.0)?,
    ]));
    assert_close(model.mass(), 1.0, 12);
    let bin = model.index_of(2.0).ok_or("no bin at 2")?;
    assert_eq!(bin, 0);
    assert_close(model.series("hit")[bin], 0.5, 12);
    assert_close(model.series("saveFail")[bin], 0.5, 12);
    Ok(())
}

// ------------------------------------------------------------------ tests/combined-with-attribution.test.ts

use crate::Damage;
use crate::pmf::Bin;

fn attr_sum(bin: &Bin) -> f64 {
    bin.attr.as_ref().map_or(0.0, |a| a.values().sum())
}

fn attr_of(bin: &Bin, label: &str) -> f64 {
    bin.attr
        .as_ref()
        .and_then(|a| a.get(label))
        .copied()
        .unwrap_or(0.0)
}

/// d20+5 vs AC 15, 2d6+3.
fn attack_2d6p3() -> Result<AttackBuilder, DiceError> {
    ac_base()?.on_hit(rd(2.0, 6.0)?.plus(3.0)?)
}

fn attack_2d6p3_crit_2d6() -> Result<AttackBuilder, DiceError> {
    attack_2d6p3()?.on_crit(&[r(rd(2.0, 6.0)?)])
}

fn attributed(attack: &AttackBuilder) -> Result<Pmf, DiceError> {
    Ok(attack.to_query_with(0.0)?.combined_with_attribution())
}

/// `|Σ attr| < tol` against `damage × p` for each bin of `pmf` the `keep` predicate selects.
#[track_caller]
fn assert_attr_sums_to_damage_times_p(pmf: &Pmf, tol: f64, only_positive: bool) {
    for (damage, bin) in &pmf.map {
        if bin.attr.is_some() && (!only_positive || damage.0 > 0.0) {
            let diff = (attr_sum(bin) - damage.0 * bin.p).abs();
            assert!(diff < tol, "damage {}: {diff}", damage.0);
        }
    }
}

/// tests/combined-with-attribution.test.ts:8
#[test]
fn should_populate_attr_field_for_all_bins() -> T {
    let pmf = attributed(&attack_2d6p3()?)?;
    for (damage, bin) in &pmf.map {
        if damage.0 > 0.0 {
            assert!(
                bin.attr.as_ref().is_some_and(|a| !a.is_empty()),
                "damage {}",
                damage.0
            );
        }
    }
    Ok(())
}

/// tests/combined-with-attribution.test.ts:20
#[test]
fn should_satisfy_constraint_sum_attr_values_approx_damage_times_probability() -> T {
    assert_attr_sums_to_damage_times_p(&attributed(&attack_2d6p3()?)?, 1e-10, false);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:36
#[test]
fn should_have_non_negative_attribution_values() -> T {
    let pmf = attributed(&attack_2d6p3()?)?;
    for bin in pmf.map.values() {
        for v in bin.attr.iter().flat_map(|a| a.values()) {
            assert!(*v >= 0.0, "{v}");
        }
    }
    Ok(())
}

/// tests/combined-with-attribution.test.ts:49
#[test]
fn should_preserve_p_and_count_fields_from_combined() -> T {
    let query = attack_2d6p3()?.to_query_with(0.0)?;
    let with_attr = query.combined_with_attribution();
    let regular = query.combined();
    assert_eq!(with_attr.support(), regular.support());
    for damage in regular.support() {
        let a = with_attr.map.get(&damage).ok_or("missing bin")?;
        let b = regular.map.get(&damage).ok_or("missing bin")?;
        assert!((a.p - b.p).abs() < 1e-10);
        for (outcome, count) in &b.count {
            let got = a.count.get(outcome).copied().ok_or("missing count")?;
            assert!((got - count).abs() < 1e-10, "{outcome}");
        }
    }
    Ok(())
}

/// tests/combined-with-attribution.test.ts:74
#[test]
fn should_only_have_hit_attribution_for_non_zero_damage() -> T {
    let pmf = attributed(&attack_2d6p3()?.no_crit()?)?;
    for (damage, bin) in &pmf.map {
        if let (true, Some(attr)) = (damage.0 > 0.0, &bin.attr) {
            assert!(attr.get("hit").is_some_and(|h| *h > 0.0));
            assert!(!attr.contains_key("crit"));
        }
    }
    Ok(())
}

/// tests/combined-with-attribution.test.ts:89
#[test]
fn should_match_expected_damage_from_hit_when_summed() -> T {
    let query = attack_2d6p3()?.no_crit()?.to_query_with(0.0)?;
    let pmf = query.combined_with_attribution();
    let total: f64 = pmf.map.values().map(|b| attr_of(b, "hit")).sum();
    assert!((total - query.expected_damage_from(one("hit"))).abs() < 1e-9);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:107
#[test]
fn should_have_both_hit_and_crit_attribution() -> T {
    let pmf = attributed(&attack_2d6p3_crit_2d6()?)?;
    let (mut hit, mut crit, mut both) = (false, false, false);
    for (damage, bin) in &pmf.map {
        if damage.0 > 0.0 && bin.attr.is_some() {
            let (h, c) = (attr_of(bin, "hit") > 0.0, attr_of(bin, "crit") > 0.0);
            hit |= h;
            crit |= c;
            both |= h && c;
        }
    }
    assert!(hit && crit && both);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:139
#[test]
fn should_satisfy_attribution_constraint_at_bins_with_both_outcomes() -> T {
    let pmf = attributed(&attack_2d6p3_crit_2d6()?)?;
    for (damage, bin) in &pmf.map {
        let (h, c) = (attr_of(bin, "hit"), attr_of(bin, "crit"));
        if h != 0.0 && c != 0.0 {
            assert!((h + c - damage.0 * bin.p).abs() < 1e-10);
        }
    }
    Ok(())
}

/// tests/combined-with-attribution.test.ts:159
#[test]
fn should_match_expected_damage_from_for_each_outcome() -> T {
    let query = attack_2d6p3_crit_2d6()?.to_query_with(0.0)?;
    let pmf = query.combined_with_attribution();
    let hit: f64 = pmf.map.values().map(|b| attr_of(b, "hit")).sum();
    let crit: f64 = pmf.map.values().map(|b| attr_of(b, "crit")).sum();
    assert!((hit - query.expected_damage_from(one("hit"))).abs() < 1e-9);
    assert!((crit - query.expected_damage_from(one("crit"))).abs() < 1e-9);
    Ok(())
}

fn two_independent_attacks() -> Result<DiceQuery, DiceError> {
    let attack1 = attack_2d6p3()?.no_crit()?;
    let attack2 = d20()
        .plus(3.0)?
        .ac(15.0)?
        .on_hit(rd(1.0, 8.0)?.plus(2.0)?)?
        .no_crit()?;
    Ok(attack1
        .to_query_with(0.0)?
        .convolve(&attack2.to_query_with(0.0)?))
}

/// tests/combined-with-attribution.test.ts:186
#[test]
fn should_work_with_multiple_independent_attacks() -> T {
    assert_attr_sums_to_damage_times_p(
        &two_independent_attacks()?.combined_with_attribution(),
        1e-9,
        true,
    );
    Ok(())
}

/// tests/combined-with-attribution.test.ts:204
#[test]
fn should_preserve_total_expected_damage() -> T {
    let query = two_independent_attacks()?;
    let pmf = query.combined_with_attribution();
    let total: f64 = pmf
        .map
        .values()
        .flat_map(|b| b.attr.iter().flatten())
        .filter(|(k, _)| k.as_str() != "missNone")
        .map(|(_, v)| *v)
        .sum();
    assert!((total - query.mean()).abs() < 1e-6);
    Ok(())
}

fn save_4d6_half() -> Result<SaveBuilder, DiceError> {
    dc_base()?
        .on_save_failure_args(&[r(rd(4.0, 6.0)?)])?
        .save_half()
}

/// tests/combined-with-attribution.test.ts:229
#[test]
fn should_work_with_save_based_attacks() -> T {
    let pmf = save_4d6_half()?
        .to_query_with(0.0)?
        .combined_with_attribution();
    assert_attr_sums_to_damage_times_p(&pmf, 1e-9, true);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:250
#[test]
fn should_have_save_fail_and_save_half_attribution() -> T {
    let pmf = save_4d6_half()?
        .to_query_with(0.0)?
        .combined_with_attribution();
    let fail = pmf.map.values().any(|b| attr_of(b, "saveFail") > 0.0);
    let half = pmf.map.values().any(|b| attr_of(b, "saveHalf") > 0.0);
    assert!(fail && half);
    Ok(())
}

fn positive_outcomes(pmf: &Pmf) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for (damage, bin) in &pmf.map {
        if damage.0 > 0.0 {
            for (k, v) in bin.attr.iter().flatten() {
                if *v > 1e-10 {
                    out.insert(k.clone());
                }
            }
        }
    }
    out
}

/// tests/combined-with-attribution.test.ts:277
#[test]
fn should_produce_similar_attribution_structure_to_parser() -> T {
    let builder_pmf = attributed(&attack_2d6p3_crit_2d6()?)?;
    let parser_pmf = parse_with("d20+5 AC 15 * (2d6+3) crit (2d6)", 0.0)?;
    assert_eq!(
        positive_outcomes(&builder_pmf),
        positive_outcomes(&parser_pmf)
    );
    Ok(())
}

/// tests/combined-with-attribution.test.ts:317
#[test]
fn should_have_approximately_equal_attribution_for_equivalent_expressions() -> T {
    let builder_query = attack_2d6p3_crit_2d6()?.to_query_with(0.0)?;
    let builder_pmf = builder_query.combined_with_attribution();
    let parser_pmf = parse_with("d20+5 AC 15 * (2d6+3) crit (2d6)", 0.0)?;
    let parser_query = DiceQuery::of(vec![parser_pmf.clone()]);
    for outcome in ["hit", "crit", "missNone"] {
        let b = builder_query.expected_damage_from(one(outcome));
        let p = parser_query.expected_damage_from(one(outcome));
        assert!((b - p).abs() < 0.1, "{outcome}");
    }
    let total =
        |pmf: &Pmf, label: &str| -> f64 { pmf.map.values().map(|b| attr_of(b, label)).sum() };
    assert!((total(&builder_pmf, "hit") - total(&parser_pmf, "hit")).abs() < 0.1);
    assert!((total(&builder_pmf, "crit") - total(&parser_pmf, "crit")).abs() < 0.1);
    Ok(())
}

fn has_positive_attr(pmf: &Pmf) -> bool {
    pmf.map
        .iter()
        .any(|(d, b)| d.0 > 0.0 && b.attr.as_ref().is_some_and(|a| !a.is_empty()))
}

/// tests/combined-with-attribution.test.ts:375 (the `toBe` instance identity has no Rust counterpart: asserted as equal values).
#[test]
fn should_skip_recomputation_when_attr_already_exists_parser_pmfs() -> T {
    let parser_pmf = parse_with("d20+5 AC 15 * (2d6+3) crit (2d6)", 0.0)?;
    assert!(has_positive_attr(&parser_pmf));
    assert_eq!(parser_pmf.with_attribution(), parser_pmf);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:393 (`not.toBe` identity is unobservable here: the new attr is asserted instead).
#[test]
fn should_compute_attr_for_builder_pmfs_slow_path() -> T {
    let builder_pmf = attack_2d6p3()?.to_pmf(0.0)?;
    assert!(!has_positive_attr(&builder_pmf));
    assert!(has_positive_attr(&builder_pmf.with_attribution()));
    Ok(())
}

/// tests/combined-with-attribution.test.ts:423
#[test]
fn should_work_with_zero_damage_outcomes() -> T {
    let attack = ac_base()?.on_hit_args(&[n(0.0)])?;
    let pmf = attributed(&attack)?;
    let zero = pmf.map.get(&Damage(0.0)).ok_or("no bin at 0")?;
    if zero.attr.is_some() {
        assert_eq!(attr_sum(zero), 0.0);
    }
    Ok(())
}

/// tests/combined-with-attribution.test.ts:441
#[test]
fn should_work_with_single_pmf() -> T {
    let attack = ac_base()?.on_hit(rd(1.0, 6.0)?)?;
    assert_attr_sums_to_damage_times_p(&attributed(&attack)?, 1e-10, true);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:457
#[test]
fn should_work_with_advantage_disadvantage() -> T {
    let attack = d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(rd(2.0, 6.0)?.plus(3.0)?)?;
    assert_attr_sums_to_damage_times_p(&attributed(&attack)?, 1e-10, true);
    Ok(())
}

/// tests/combined-with-attribution.test.ts:479
#[test]
fn should_work_with_damage_attribution_chart_model() -> T {
    let query = attack_2d6p3_crit_2d6()?.to_query_with(0.0)?;
    let attr_query = DiceQuery::new(
        query.singles.clone(),
        Some(query.combined_with_attribution()),
        EPS,
    );
    let model = chart(&attr_query);
    assert!(!model.labels.is_empty());
    assert!(!model.series.is_empty());
    assert!(model.series.contains_key("hit"));
    assert!(model.series.contains_key("crit"));
    Ok(())
}

/// tests/combined-with-attribution.test.ts:506
#[test]
fn should_complete_in_reasonable_time_for_typical_scenarios() -> T {
    let attacks = [
        attack_2d6p3_crit_2d6()?,
        ac_base()?.on_hit(rd(1.0, 8.0)?.plus(4.0)?)?,
        d20()
            .plus(3.0)?
            .ac(15.0)?
            .on_hit(rd(1.0, 6.0)?.plus(2.0)?)?,
    ];
    let mut query = attacks[0].to_query_with(0.0)?;
    for a in &attacks {
        query = query.convolve(&a.to_query_with(0.0)?);
    }
    let start = std::time::Instant::now();
    let pmf = query.combined_with_attribution();
    assert!(start.elapsed().as_millis() < 100);
    assert!(!pmf.support().is_empty());
    Ok(())
}

// ------------------------------------------------------------------ tests/dice-match-descriptor + dice-match-pools
//
// `bounce(...)`, `turn(...)` and `calculateBounceOdds` are turn-engine / `common/bounce` APIs with no
// Rust counterpart: those assertions are deferred (see the report). `poolMatchOracle` (tests/enumerate-match.ts)
// is ported below with u128 weights (every mass here is far below 2^128).

use crate::builder::roll::RollRerollUpToOptions;
use crate::common::DiceMatchInfo;

#[derive(Clone, Copy)]
struct PoolSpec {
    sides: usize,
    count: usize,
    minimum: usize,
    reroll: usize,
    budget: usize,
    rolls: usize,
}

struct MatchOracle {
    total: BTreeMap<i64, f64>,
    matched: BTreeMap<i64, f64>,
}

struct Listed {
    kept: Vec<usize>,
    rerolled: usize,
    weight: u128,
    score: u128,
}

fn subsets_up_to(count: usize, budget: usize) -> Vec<Vec<usize>> {
    fn visit(
        start: usize,
        chosen: &mut Vec<usize>,
        count: usize,
        budget: usize,
        out: &mut Vec<Vec<usize>>,
    ) {
        out.push(chosen.clone());
        if chosen.len() == budget {
            return;
        }
        for i in start..count {
            chosen.push(i);
            visit(i + 1, chosen, count, budget, out);
            chosen.pop();
        }
    }
    let mut out = Vec::new();
    visit(0, &mut Vec::new(), count, budget, &mut out);
    out
}

struct Oracle<'a> {
    spec: PoolSpec,
    faces: Vec<usize>,
    weights: Vec<u128>,
    denominator: u128,
    mean_numerator: u128,
    subsets: Vec<Vec<usize>>,
    max_rerolled: usize,
    listed: Vec<Listed>,
    total: BTreeMap<usize, u128>,
    matched: BTreeMap<usize, u128>,
    _p: std::marker::PhantomData<&'a ()>,
}

impl Oracle<'_> {
    fn list(&mut self, dice: &mut Vec<usize>, weight: u128) {
        if dice.len() < self.spec.count {
            for k in 0..self.faces.len() {
                let face = self.faces[k];
                dice.push(face);
                self.list(dice, weight * self.weights[face]);
                dice.pop();
            }
            return;
        }
        let mut best: Option<&Vec<usize>> = None;
        let mut best_score = 0u128;
        for subset in &self.subsets {
            let kept: usize = dice
                .iter()
                .enumerate()
                .filter(|(i, _)| !subset.contains(i))
                .map(|(_, f)| *f)
                .sum();
            let score =
                kept as u128 * self.denominator + subset.len() as u128 * self.mean_numerator;
            if best.is_none_or(|b| {
                score > best_score || (score == best_score && subset.len() < b.len())
            }) {
                best = Some(subset);
                best_score = score;
            }
        }
        let chosen = best.cloned().unwrap_or_default();
        let kept = dice
            .iter()
            .enumerate()
            .filter(|(i, _)| !chosen.contains(i))
            .map(|(_, f)| *f)
            .collect();
        self.listed.push(Listed {
            kept,
            rerolled: chosen.len(),
            weight,
            score: best_score,
        });
    }

    fn land(&mut self, roll: usize, weight: u128) {
        let (kept, rerolled) = (self.listed[roll].kept.clone(), self.listed[roll].rerolled);
        let mut fresh = Vec::new();
        self.place(&kept, rerolled, &mut fresh, weight);
    }

    fn place(&mut self, kept: &[usize], rerolled: usize, fresh: &mut Vec<usize>, w: u128) {
        if fresh.len() < rerolled {
            for k in 0..self.faces.len() {
                let face = self.faces[k];
                fresh.push(face);
                self.place(kept, rerolled, fresh, w * self.weights[face]);
                fresh.pop();
            }
            return;
        }
        let landed: Vec<usize> = kept.iter().chain(fresh.iter()).copied().collect();
        let sum: usize = landed.iter().sum();
        let scaled = w * self.denominator.pow((self.max_rerolled - rerolled) as u32);
        *self.total.entry(sum).or_insert(0) += scaled;
        let mut distinct = landed.clone();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() < landed.len() {
            *self.matched.entry(sum).or_insert(0) += scaled;
        }
    }

    fn choose(&mut self, chosen: &mut Vec<usize>, weight: u128) {
        if chosen.len() < self.spec.rolls {
            for i in 0..self.listed.len() {
                chosen.push(i);
                self.choose(chosen, weight * self.listed[i].weight);
                chosen.pop();
            }
            return;
        }
        let mut best = chosen[0];
        for &r in chosen.iter() {
            if self.listed[r].score > self.listed[best].score {
                best = r;
            }
        }
        self.land(best, weight);
    }
}

fn pool_match_oracle(spec: PoolSpec) -> MatchOracle {
    let rerolled_faces = spec.reroll.min(spec.sides);
    let mut weights = vec![0u128; spec.sides.max(spec.minimum) + 1];
    for raw in 1..=spec.sides {
        let value = raw.max(spec.minimum);
        if raw > rerolled_faces {
            weights[value] += spec.sides as u128;
        } else {
            for fresh in 1..=spec.sides {
                weights[fresh.max(spec.minimum)] += 1;
            }
        }
    }
    let faces: Vec<usize> = (1..=spec.sides).filter(|v| weights[*v] > 0).collect();
    let mean_numerator = faces.iter().map(|f| *f as u128 * weights[*f]).sum();
    let max_rerolled = spec.budget.min(spec.count);
    let mut o = Oracle {
        spec,
        faces,
        weights,
        denominator: (spec.sides as u128).pow(2),
        mean_numerator,
        subsets: subsets_up_to(spec.count, max_rerolled),
        max_rerolled,
        listed: Vec::new(),
        total: BTreeMap::new(),
        matched: BTreeMap::new(),
        _p: std::marker::PhantomData,
    };
    o.list(&mut Vec::new(), 1);
    if spec.rolls <= 1 {
        for i in 0..o.listed.len() {
            let w = o.listed[i].weight;
            o.land(i, w);
        }
    } else {
        o.choose(&mut Vec::new(), 1);
    }
    let grand: u128 = o.total.values().sum();
    let ratio = |m: u128| m as f64 / grand as f64;
    MatchOracle {
        total: o
            .total
            .iter()
            .map(|(s, m)| (*s as i64, ratio(*m)))
            .collect(),
        matched: o
            .matched
            .iter()
            .map(|(s, m)| (*s as i64, ratio(*m)))
            .collect(),
    }
}

fn spec(sides: usize, count: usize, budget: usize) -> PoolSpec {
    PoolSpec {
        sides,
        count,
        minimum: 0,
        reroll: 0,
        budget,
        rolls: 1,
    }
}

const PRECISION: i32 = 12;

fn attack_with(payload: RollBuilder) -> Result<AttackBuilder, DiceError> {
    ac_base()?.on_hit(payload)
}

fn descriptor(info: Option<DiceMatchInfo>) -> Result<DiceMatchInfo, DiceError> {
    info.ok_or_else(|| DiceError::error("expected a dice-match descriptor, got none"))
}

/// The descriptor's map as sorted `[damage, probability]` rows.
fn rows(info: Option<DiceMatchInfo>) -> Result<Vec<(f64, f64)>, DiceError> {
    let mut v: Vec<(f64, f64)> = descriptor(info)?
        .match_probability_by_damage
        .iter()
        .map(|(d, p)| (d.0, *p))
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(v)
}

/// The branch's own PMF, cut by the descriptor, is the oracle's law.
fn expect_agrees(pmf: &Pmf, info: Option<DiceMatchInfo>, oracle: &MatchOracle, modifier: f64) -> T {
    let by_damage = descriptor(info)?.match_probability_by_damage;
    let mut damages: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    damages.extend(oracle.total.keys().map(|s| *s as f64 + modifier));
    for damage in damages {
        let key = (damage - modifier) as i64;
        assert_close(
            pmf.p_at(damage),
            oracle.total.get(&key).copied().unwrap_or(0.0),
            PRECISION,
        );
        let matched = by_damage.get(&Damage(damage)).copied().unwrap_or(0.0);
        assert_close(
            pmf.p_at(damage) * matched,
            oracle.matched.get(&key).copied().unwrap_or(0.0),
            PRECISION,
        );
    }
    Ok(())
}

/// P(match) of the branch: the descriptor averaged over the branch's own PMF.
fn p_match(pmf: &Pmf, info: Option<DiceMatchInfo>) -> Result<f64, DiceError> {
    let by_damage = descriptor(info)?.match_probability_by_damage;
    Ok(pmf.support().iter().fold(0.0, |s, d| {
        s + pmf.p_at(d.0) * by_damage.get(d).copied().unwrap_or(0.0)
    }))
}

fn pool(count: f64, die: &RollBuilder) -> Result<RollBuilder, DiceError> {
    die_roll(count, die.clone(), None)
}

// ---- dice-match-descriptor.test.ts

fn descriptor_cases() -> Result<Vec<(&'static str, AttackBuilder)>, DiceError> {
    let ac17 = || d20().plus(5.0)?.ac(17.0);
    Ok(vec![
        (
            "an exploding pool",
            ac17()?.on_hit(pool(3.0, &d8())?.explode(1.0)?)?,
        ),
        (
            "an advantaged pool",
            ac17()?
                .on_hit(pool(3.0, &d8())?.with_advantage()?)?
                .no_crit()?,
        ),
        (
            "a subtracted pool",
            ac17()?.on_hit(flat(30.0)?.minus_roll(&pool(3.0, &d8())?)?)?,
        ),
    ])
}

/// tests/dice-match-descriptor.test.ts:25 (`diceMatchInfo() on ${name} has no hit descriptor`, one row per case in a loop; the `bounce() ... is refused` twin is deferred: needs `bounce`).
#[test]
fn dice_match_info_on_a_non_plain_pool_has_no_hit_descriptor() -> T {
    for (name, attack) in descriptor_cases()? {
        assert!(attack.dice_match_info(0.0)?.0.is_none(), "{name}");
    }
    Ok(())
}

/// tests/dice-match-descriptor.test.ts:35 (the `bounce` half of the assertion is deferred: needs `bounce`).
#[test]
fn a_plain_pool_still_has_one() -> T {
    let attack = ac_base()?.on_hit(pool(3.0, &d8())?)?;
    assert!(attack.dice_match_info(0.0)?.0.is_some());
    Ok(())
}

// ---- dice-match-pools.test.ts

/// tests/dice-match-pools.test.ts:85 (one row per pair, in a loop).
#[test]
fn groups_with_the_same_faces_have_the_descriptor_of_the_whole_pool() -> T {
    let d8m1 = d8().minimum(1.0)?;
    let d8m2 = d8().minimum(2.0)?;
    let d8r1 = d8().reroll(1.0)?;
    let pairs: Vec<(&str, RollBuilder, RollBuilder)> = vec![
        (
            "2d6 as 1d6 + 1d6",
            pool(1.0, &d6())?.plus_roll(&pool(1.0, &d6())?)?,
            pool(2.0, &d6())?,
        ),
        (
            "3d8 as 2d8 + 1d8",
            pool(2.0, &d8())?.plus_roll(&pool(1.0, &d8())?)?,
            pool(3.0, &d8())?,
        ),
        (
            "3d8 + 4 as 1d8 + 2d8 + 4",
            pool(1.0, &d8())?.plus_roll(&pool(2.0, &d8())?)?.plus(4.0)?,
            pool(3.0, &d8())?.plus(4.0)?,
        ),
        (
            "4d6 as three groups",
            pool(1.0, &d6())?
                .plus_roll(&pool(2.0, &d6())?)?
                .plus_roll(&pool(1.0, &d6())?)?,
            pool(4.0, &d6())?,
        ),
        (
            "3d8 beside a group of no dice",
            pool(0.0, &d6())?.plus_roll(&pool(3.0, &d8())?)?,
            pool(3.0, &d8())?,
        ),
        (
            "3d8 whose 1d8 has a minimum of 1, which floors nothing",
            pool(2.0, &d8())?.plus_roll(&pool(1.0, &d8m1)?)?,
            pool(3.0, &d8())?,
        ),
        (
            "2d8 with a minimum of 2 in two groups",
            pool(1.0, &d8m2)?.plus_roll(&pool(1.0, &d8m2)?)?,
            pool(2.0, &d8m2)?,
        ),
        (
            "2d8 with a reroll of 1 in two groups",
            pool(1.0, &d8r1)?.plus_roll(&pool(1.0, &d8r1)?)?,
            pool(2.0, &d8r1)?,
        ),
    ];
    for (name, split, whole) in pairs {
        let a = attack_with(split)?.dice_match_info(0.0)?;
        let b = attack_with(whole)?.dice_match_info(0.0)?;
        assert_eq!(rows(a.0)?, rows(b.0)?, "{name} hit");
        assert_eq!(rows(a.1)?, rows(b.1)?, "{name} crit");
    }
    Ok(())
}

/// tests/dice-match-pools.test.ts:93
#[test]
fn agrees_with_every_roll_listed_on_the_hit_and_on_the_doubled_crit() -> T {
    let attack = attack_with(pool(2.0, &d6())?.plus_roll(&pool(1.0, &d6())?)?.plus(2.0)?)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    let resolved = attack.resolve(0.0)?;
    expect_agrees(&resolved.hit, hit, &pool_match_oracle(spec(6, 3, 0)), 2.0)?;
    expect_agrees(&resolved.crit, crit, &pool_match_oracle(spec(6, 6, 0)), 2.0)
}

/// tests/dice-match-pools.test.ts:101
#[test]
fn agrees_on_an_explicit_crit_written_as_two_groups() -> T {
    let attack = attack_with(pool(2.0, &d6())?)?
        .on_crit(&[r(pool(3.0, &d6())?.plus_roll(&pool(2.0, &d6())?)?)])?;
    expect_agrees(
        &attack.resolve(0.0)?.crit,
        attack.dice_match_info(0.0)?.1,
        &pool_match_oracle(spec(6, 5, 0)),
        0.0,
    )
}

/// tests/dice-match-pools.test.ts:112
#[test]
fn the_single_group_descriptor_is_the_one_0_15_0_built() -> T {
    assert_eq!(
        rows(attack_with(pool(3.0, &d8())?)?.dice_match_info(0.0)?.0)?.len(),
        22
    );
    for count in [1.0, 0.0] {
        let hit = attack_with(pool(count, &d8())?)?.dice_match_info(0.0)?.0;
        assert_eq!(descriptor(hit)?.match_probability_by_damage.len(), 0);
    }
    Ok(())
}

/// tests/dice-match-pools.test.ts:127 (one row per case, in a loop; the bounce-chain half is deferred: needs `bounce`).
#[test]
fn dice_of_different_kinds_have_no_descriptor() -> T {
    let rows_: Vec<(&str, RollBuilder, &str)> = vec![
        (
            "2d8 + 1d6",
            pool(2.0, &d8())?.plus_roll(&pool(1.0, &d6())?)?,
            "different kinds (d8 and d6)",
        ),
        (
            "2d8 with a minimum of 2 + 1d8",
            pool(2.0, &d8().minimum(2.0)?)?.plus_roll(&pool(1.0, &d8())?)?,
            "different kinds (d8 minimum 2 and d8)",
        ),
        (
            "2d8 with a reroll of 1 + 1d8",
            pool(2.0, &d8().reroll(1.0)?)?.plus_roll(&pool(1.0, &d8())?)?,
            "different kinds (d8 reroll 1 and d8)",
        ),
    ];
    for (name, payload, message) in rows_ {
        let attack = attack_with(payload)?;
        assert!(attack.dice_match_info(0.0)?.0.is_none(), "{name}");
        let why = attack.dice_match_refusals()?.0.ok_or("no refusal")?;
        assert!(why.contains(message), "{name}: {why}");
    }
    Ok(())
}

/// tests/dice-match-pools.test.ts:137
#[test]
fn a_reroll_pool_of_two_kinds_has_none_either() -> T {
    let attack = attack_with(pool(2.0, &d8())?.plus_roll(&pool(1.0, &d6())?)?)?
        .reroll_damage_up_to(1.0, None)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert!(hit.is_none() && crit.is_none());
    assert!(
        attack
            .dice_match_refusals()?
            .0
            .ok_or("no refusal")?
            .contains("different kinds")
    );
    Ok(())
}

struct RerollCase {
    name: &'static str,
    sides: usize,
    count: usize,
    budget: usize,
    minimum: usize,
    reroll: usize,
    rolls: usize,
    crit: bool,
}

fn reroll_cases() -> Vec<RerollCase> {
    let c = |name, sides, count, budget, minimum, reroll, rolls, crit| RerollCase {
        name,
        sides,
        count,
        budget,
        minimum,
        reroll,
        rolls,
        crit,
    };
    vec![
        c("2d4, reroll 1", 4, 2, 1, 0, 0, 0, true),
        c("2d6, reroll 1", 6, 2, 1, 0, 0, 0, true),
        c("3d6, reroll 2", 6, 3, 2, 0, 0, 0, true),
        c("2d8, reroll 1", 8, 2, 1, 0, 0, 0, true),
        c("3d8, reroll 1", 8, 3, 1, 0, 0, 0, false),
        c("2d8 with a minimum of 2, reroll 1", 8, 2, 1, 2, 0, 0, true),
        c("2d6 with a reroll of 1, reroll 2", 6, 2, 2, 0, 1, 0, true),
        c("3d6, a budget of every die", 6, 3, 3, 0, 0, 0, false),
        c("2d4, best of two rolls, reroll 1", 4, 2, 1, 0, 0, 2, true),
        c("2d6, best of two rolls, reroll 1", 6, 2, 1, 0, 0, 2, false),
        c("3d4, best of two rolls, reroll 2", 4, 3, 2, 0, 0, 2, false),
        c("3d4, best of two rolls, no reroll", 4, 3, 0, 0, 0, 2, false),
    ]
}

impl RerollCase {
    fn faces(&self) -> Result<RollBuilder, DiceError> {
        let die = match self.sides {
            4 => d4(),
            6 => d6(),
            _ => d8(),
        };
        die.reroll(self.reroll as f64)?.minimum(self.minimum as f64)
    }

    fn rolls(&self) -> Option<f64> {
        (self.rolls > 0).then_some(self.rolls as f64)
    }

    fn spec(&self, count: usize) -> PoolSpec {
        PoolSpec {
            sides: self.sides,
            count,
            minimum: self.minimum,
            reroll: self.reroll,
            budget: self.budget,
            rolls: self.rolls.max(1),
        }
    }

    fn via_attack(&self) -> Result<AttackBuilder, DiceError> {
        attack_with(pool(self.count as f64, &self.faces()?)?.plus(3.0)?)?
            .reroll_damage_up_to(self.budget as f64, self.rolls())
    }
}

/// tests/dice-match-pools.test.ts:176 (one row per case, in a loop).
#[test]
fn reroll_pool_cases_agree_with_every_roll_listed() -> T {
    for c in reroll_cases() {
        let attack = c.via_attack()?;
        let (hit, crit) = attack.dice_match_info(0.0)?;
        let resolved = attack.resolve(0.0)?;
        expect_agrees(&resolved.hit, hit, &pool_match_oracle(c.spec(c.count)), 3.0)?;
        // The crit doubles the dice and keeps the budget.
        assert!(crit.is_some(), "{}", c.name);
        if c.crit {
            expect_agrees(
                &resolved.crit,
                crit,
                &pool_match_oracle(c.spec(2 * c.count)),
                3.0,
            )?;
        }
    }
    Ok(())
}

/// tests/dice-match-pools.test.ts:186 (one row per case, in a loop).
#[test]
fn a_reroll_up_to_payload_has_the_descriptor_of_the_attack_level_budget() -> T {
    for c in reroll_cases() {
        let via_attack = c.via_attack()?;
        let options = RollRerollUpToOptions {
            rolls: c.rolls(),
            rolled_once: None,
        };
        let via_payload = attack_with(
            pool(c.count as f64, &c.faces()?)?
                .plus(3.0)?
                .reroll_up_to(c.budget as f64, Some(&options))?,
        )?;
        let (pa, pc) = via_payload.dice_match_info(0.0)?;
        let (aa, ac_) = via_attack.dice_match_info(0.0)?;
        assert_eq!(rows(pa)?, rows(aa)?, "{} hit", c.name);
        assert_eq!(rows(pc)?, rows(ac_)?, "{} crit", c.name);
    }
    Ok(())
}

/// tests/dice-match-pools.test.ts:194
#[test]
fn the_crit_of_an_explicit_on_crit_pool_matches_on_that_pools_dice_with_the_attacks_budget() -> T {
    let attack = attack_with(pool(2.0, &d6())?)?
        .on_crit(&[r(pool(3.0, &d6())?.plus(1.0)?)])?
        .reroll_damage_up_to(1.0, None)?;
    expect_agrees(
        &attack.resolve(0.0)?.crit,
        attack.dice_match_info(0.0)?.1,
        &pool_match_oracle(spec(6, 3, 1)),
        1.0,
    )
}

/// tests/dice-match-pools.test.ts:204
#[test]
fn a_budget_of_none_or_of_a_pool_no_bigger_than_the_dice_reads_the_pool_it_names() -> T {
    let hit_rows = |a: AttackBuilder| rows(a.dice_match_info(0.0)?.0);
    let three = || attack_with(pool(3.0, &d6())?);
    let plain = hit_rows(three()?)?;
    assert_eq!(hit_rows(three()?.reroll_damage_up_to(0.0, None)?)?, plain);
    assert_eq!(
        hit_rows(three()?.reroll_damage_up_to(0.0, Some(2.0))?)?,
        plain
    );
    let two = || attack_with(pool(2.0, &d6())?);
    assert_eq!(
        hit_rows(two()?.reroll_damage_up_to(9.0, None)?)?,
        hit_rows(two()?.reroll_damage_up_to(2.0, None)?)?
    );
    Ok(())
}

/// tests/dice-match-pools.test.ts:212
#[test]
fn one_die_can_never_match_however_it_rerolls_and_its_doubled_crit_can() -> T {
    let attack = attack_with(pool(1.0, &d8())?)?.reroll_damage_up_to(1.0, None)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert_eq!(descriptor(hit)?.match_probability_by_damage.len(), 0);
    expect_agrees(
        &attack.resolve(0.0)?.crit,
        crit,
        &pool_match_oracle(spec(8, 2, 1)),
        0.0,
    )
}

/// tests/dice-match-pools.test.ts:219
#[test]
fn a_total_that_cannot_hold_a_repeated_face_has_no_match_odds_and_one_that_must_has_all_of_them()
-> T {
    let hit = attack_with(pool(2.0, &d4())?)?
        .reroll_damage_up_to(1.0, None)?
        .dice_match_info(0.0)?
        .0;
    let info = descriptor(hit)?.match_probability_by_damage;
    let at = |d: f64| info.get(&Damage(d)).copied();
    assert_eq!(at(8.0), Some(1.0));
    assert_close(at(2.0).ok_or("no 2")?, 1.0, 12);
    assert_close(at(3.0).ok_or("no 3")?, 0.0, 12);
    Ok(())
}

/// tests/dice-match-pools.test.ts:229
#[test]
fn two_d8_rerolling_1_matches_5_32_of_the_time() -> T {
    let attack = attack_with(pool(2.0, &d8())?)?.reroll_damage_up_to(1.0, None)?;
    assert_close(
        p_match(&attack.resolve(0.0)?.hit, attack.dice_match_info(0.0)?.0)?,
        5.0 / 32.0,
        12,
    );
    Ok(())
}

/// tests/dice-match-pools.test.ts:237 (the `calculateBounceOdds(2, 8, { rerollDamageDice: 1 })` call is deferred: `common/bounce` has no Rust counterpart; its asserted value 15/64 is used).
#[test]
fn a_caster_who_rerolls_to_make_the_dice_match_does_better_and_that_is_not_what_is_modelled() -> T {
    let attack = attack_with(pool(2.0, &d8())?)?.reroll_damage_up_to(1.0, None)?;
    let damage_policy = p_match(&attack.resolve(0.0)?.hit, attack.dice_match_info(0.0)?.0)?;
    let match_policy = 15.0 / 64.0;
    assert!(damage_policy < match_policy);
    let plain = attack_with(pool(2.0, &d8())?)?;
    assert_close(
        p_match(&plain.resolve(0.0)?.hit, plain.dice_match_info(0.0)?.0)?,
        1.0 / 8.0,
        12,
    );
    Ok(())
}

/// tests/dice-match-pools.test.ts:251 (only the oracle comparison; the `bounce({ source, max: 3 }).mean()` assertion is deferred: needs `bounce`).
#[test]
fn a_chain_of_beams_follows_the_damage_policys_odds() -> T {
    let attack = attack_with(pool(3.0, &d6())?)?.reroll_damage_up_to(1.0, None)?;
    let res = attack.resolve(0.0)?;
    let (hit_info, crit_info) = attack.dice_match_info(0.0)?;
    let per_landing = res.weights.hit * p_match(&res.hit, hit_info)?
        + res.weights.crit * p_match(&res.crit, crit_info)?;
    let oracle_hit: f64 = pool_match_oracle(spec(6, 3, 1)).matched.values().sum();
    let oracle_crit: f64 = pool_match_oracle(spec(6, 6, 1)).matched.values().sum();
    assert_close(
        per_landing,
        res.weights.hit * oracle_hit + res.weights.crit * oracle_crit,
        12,
    );
    Ok(())
}

/// tests/dice-match-pools.test.ts:290
#[test]
fn a_reroll_pool_too_big_to_enumerate_has_no_descriptor() -> T {
    let attack = attack_with(roll_with(6.0, Some(SidesOrDie::Sides(1000.0)), None)?)?
        .reroll_damage_up_to(2.0, None)?;
    assert!(attack.dice_match_info(0.0)?.0.is_none());
    let why = attack.dice_match_refusals()?.0.ok_or("no refusal")?;
    assert!(
        why.contains("a rerollUpTo pool of 6 dice, too many to enumerate"),
        "{why}"
    );
    Ok(())
}

/// tests/dice-match-pools.test.ts:296
#[test]
fn a_reroll_pool_the_size_of_a_9th_level_chromatic_orb_crit_is_not_too_big() -> T {
    let attack = attack_with(pool(11.0, &d8())?)?.reroll_damage_up_to(5.0, None)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert!(hit.is_some() && crit.is_some());
    Ok(())
}

/// tests/dice-match-pools.test.ts:317 (one row per refused payload, in a loop).
#[test]
fn refused_payloads_have_no_descriptor_and_the_refusal_names_the_cause() -> T {
    // (name, attack, branch is the crit, accepted refusal texts)
    let rows_: Vec<(&str, AttackBuilder, bool, Vec<&str>)> = vec![
        (
            "a string payload",
            ac_base()?.on_hit_args(&[s("2d6+3")])?,
            false,
            vec!["string expression"],
        ),
        (
            "a halved payload",
            attack_with(pool(4.0, &d6())?.half()?)?,
            false,
            vec!["half(), scaleResult(), maxOf()"],
        ),
        (
            "a rerollUpTo payload with a flat added after it",
            attack_with(pool(3.0, &d8())?.reroll_up_to(1.0, None)?.plus(2.0)?)?,
            false,
            vec!["summed roll"],
        ),
        (
            "a keep pool",
            attack_with(pool(4.0, &d8())?.keep_highest(4.0, 3.0)?)?,
            false,
            vec!["keeps some of its dice"],
        ),
        (
            "an exploding pool",
            attack_with(pool(3.0, &d8())?.explode(1.0)?)?,
            false,
            vec!["explodes"],
        ),
        (
            "an advantaged pool",
            attack_with(pool(3.0, &d8())?.with_advantage()?)?.no_crit()?,
            false,
            vec!["advantage or disadvantage"],
        ),
        (
            "a subtracted pool",
            attack_with(flat(30.0)?.minus_roll(&pool(3.0, &d8())?)?)?,
            false,
            vec!["subtracts dice"],
        ),
        (
            "a minimum above the die's faces",
            attack_with(pool(3.0, &d4().minimum(6.0)?)?)?,
            false,
            vec!["minimum of 6 on a d4"],
        ),
        (
            "a flat payload",
            attack_with(flat(7.0)?)?,
            false,
            vec!["rolls no dice"],
        ),
        (
            "noCrit()",
            attack_with(pool(3.0, &d8())?)?.no_crit()?,
            true,
            vec!["cannot crit"],
        ),
        (
            "a crit that cannot double",
            attack_with(pool(4.0, &d8())?.keep_highest(4.0, 3.0)?)?,
            true,
            vec!["no single doubled form", "keeps some of its dice"],
        ),
    ];
    for (name, attack, crit, messages) in rows_ {
        let (info_hit, info_crit) = attack.dice_match_info(0.0)?;
        let (why_hit, why_crit) = attack.dice_match_refusals()?;
        let (info, why) = if crit {
            (info_crit, why_crit)
        } else {
            (info_hit, why_hit)
        };
        assert!(info.is_none(), "{name}");
        let why = why.ok_or("no refusal")?;
        assert!(messages.iter().any(|m| why.contains(m)), "{name}: {why}");
    }
    Ok(())
}

/// tests/dice-match-pools.test.ts:324
#[test]
fn a_minimum_above_the_faces_only_matters_to_a_pool_of_more_than_one_die() -> T {
    let faces = d4().minimum(6.0)?;
    let lone = attack_with(pool(1.0, &faces)?)?.dice_match_info(0.0)?.0;
    assert_eq!(descriptor(lone)?.match_probability_by_damage.len(), 0);
    // Every die shows 6, so three of them always match: the descriptor refused is the one that said never.
    let attack = attack_with(pool(3.0, &faces)?)?;
    let support: Vec<f64> = attack
        .resolve(0.0)?
        .hit
        .support()
        .iter()
        .map(|d| d.0)
        .collect();
    assert_eq!(support, vec![18.0]);
    assert!(attack.dice_match_info(0.0)?.0.is_none());
    Ok(())
}

/// tests/dice-match-pools.test.ts:333
#[test]
fn a_branch_with_a_descriptor_has_no_refusal() -> T {
    let attack = attack_with(pool(3.0, &d8())?)?;
    assert_eq!(attack.dice_match_refusals()?, (None, None));
    Ok(())
}
