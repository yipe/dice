//! `src/turn/save-landing.test.ts`: 25 tests (the TS counts 21; every `it` is translated), 52 compat calls.
//!
//! Not translated: save-landing.test.ts:219: `landing: "nope"` (`SaveLanding` is a closed enum; an
//! unknown landing kind cannot be spelled in a typed spec).
//! Not translated: save-landing.test.ts:296: the `JSON.parse(JSON.stringify(..))` round trip of a plain
//! object (no Rust counterpart; the rider is built as a typed `Rider`).

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::save::SaveBuilder;
use crate::error::DiceError;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, advantage, keep_best_damage,
};
use crate::turn::types::{
    AttackOptions, Rider, RiderDamage, RiderDamageSpec, RiderLanding, RiderOptions, SaveLanding,
    Trigger, TurnSpec,
};
use crate::turn::{Turn, turn};
use std::collections::BTreeMap;

const FILE: &str = "src/turn/save-landing.test.ts";

type R<X> = Result<X, DiceError>;

// The attack: `d20+5` vs AC 12: miss 0.30, hit 0.65, crit 0.05; mean damage 5.475 (`1d8+3`, `2d8+3` on a crit).
// The saves: `d20` vs DC 13: the target fails 0.60 and passes 0.40. On a failure it takes 8d6 (mean 28);
// under saveHalf a pass takes half, floored. Means: 16.8 without saveHalf, 22.3 with it.
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?)
}
const SWORD: f64 = 5.475;
fn normal() -> Result<SaveBuilder, DiceError> {
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])
}
fn half() -> Result<SaveBuilder, DiceError> {
    normal()?.save_half()
}
const NORMAL: f64 = 16.8;
const HALF: f64 = 22.3;

fn row(sources: Vec<crate::turn::types::Source>) -> R<Turn> {
    turn(sources.into_iter().map(atk).collect(), 0.0)
}
fn one(source: impl Into<crate::turn::types::Source>) -> R<Turn> {
    turn(vec![atk(source)], 0.0)
}
fn empty() -> R<Turn> {
    turn(vec![], 0.0)
}

fn max_diff(a: &Pmf, b: &Pmf) -> f64 {
    let mut worst: f64 = 0.0;
    for value in a.support().into_iter().chain(b.support()) {
        worst = worst.max((a.p_at(value.0) - b.p_at(value.0)).abs());
    }
    worst
}

fn rider_opts(landing: Option<SaveLanding>, id: Option<&str>, of: Option<&[&str]>) -> RiderOptions {
    RiderOptions {
        id: id.map(str::to_string),
        of: of.map(|ids| ids.iter().map(|s| (*s).to_string()).collect()),
        landing,
        ..RiderOptions::default()
    }
}

fn first_hit(
    landing: Option<SaveLanding>,
    id: Option<&str>,
    of: Option<&[&str]>,
) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: rider_opts(landing, id, of),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn every_hit_landing(landing: Option<SaveLanding>, id: Option<&str>) -> EveryHitOptions {
    EveryHitOptions {
        first_hit: first_hit(landing, id, None),
        max: None,
    }
}

const FAIL: Option<SaveLanding> = Some(SaveLanding::Fail);
const DAMAGE: Option<SaveLanding> = Some(SaveLanding::Damage);

// ---- a rider over a save row, by landing kind ------------------------------------------------------------

const KIND: &str = "a rider over a save row, by landing kind";

#[test]
fn fail_a_failed_save_lands_a_pass_never_does() -> T {
    let mut want = expect(
        FILE,
        &format!("{KIND} > `fail`: a failed save lands, a pass never does"),
    );
    for save in [normal()?, half()?] {
        let t = one(save)?.on_first_hit_with(flat(10.0)?, first_hit(FAIL, Some("rider"), None))?;
        close(want.fire(&t, "rider"), 0.6, 12);
    }
    let t = one(normal()?)?.on_first_hit_with(flat(10.0)?, first_hit(FAIL, None, None))?;
    close(want.mean(&t), NORMAL + 0.6 * 10.0, 12);
    want.done();
    Ok(())
}

#[test]
fn damage_a_failed_save_lands_and_so_does_a_pass_that_deals_save_for_half_damage() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{KIND} > `damage`: a failed save lands, and so does a pass that deals save-for-half damage"
        ),
    );
    let with_half =
        one(half()?)?.on_first_hit_with(flat(10.0)?, first_hit(DAMAGE, Some("rider"), None))?;
    close(want.fire(&with_half, "rider"), 1.0, 12);
    close(want.mean(&with_half), HALF + 10.0, 12);
    // Without saveHalf a pass deals nothing: it is no landing under either kind.
    let without =
        one(normal()?)?.on_first_hit_with(flat(10.0)?, first_hit(DAMAGE, Some("rider"), None))?;
    close(want.fire(&without, "rider"), 0.6, 12);
    want.done();
    Ok(())
}

#[test]
fn a_save_beside_an_attack_the_first_landing_of_either_fires_the_rider() -> T {
    let mut want = expect(
        FILE,
        &format!("{KIND} > a save beside an attack: the first landing of either fires the rider"),
    );
    // Fires unless the attack missed (0.30) and the target passed (0.40).
    let t = row(vec![sword()?.into(), normal()?.into()])?
        .on_first_hit_with(flat(10.0)?, first_hit(DAMAGE, Some("rider"), None))?;
    close(want.fire(&t, "rider"), 1.0 - 0.3 * 0.4, 12);
    close(want.mean(&t), SWORD + NORMAL + 0.88 * 10.0, 12);
    want.done();
    Ok(())
}

#[test]
fn the_first_landing_decides_the_mode() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{KIND} > the first landing decides the mode: an attack's crit doubles the rider's dice, a save's landing does not"
        ),
    );
    // 2d6 has mean 7, and 4d6 on a crit has mean 14.
    let attack_first = row(vec![sword()?.into(), normal()?.into()])?
        .on_first_hit_with(rs(2.0, 6.0)?, first_hit(DAMAGE, None, None))?;
    close(
        want.mean(&attack_first),
        SWORD + NORMAL + (0.05 * 14.0 + 0.65 * 7.0 + 0.3 * 0.6 * 7.0),
        12,
    );
    // The save lands first (0.60): mode hit. Otherwise the attack is the first landing.
    let save_first = row(vec![normal()?.into(), sword()?.into()])?
        .on_first_hit_with(rs(2.0, 6.0)?, first_hit(DAMAGE, None, None))?;
    close(
        want.mean(&save_first),
        SWORD + NORMAL + (0.6 * 7.0 + 0.4 * (0.05 * 14.0 + 0.65 * 7.0)),
        12,
    );
    want.done();
    Ok(())
}

#[test]
fn every_hit_fires_once_per_landing_the_saves_included() -> T {
    let mut want = expect(
        FILE,
        &format!("{KIND} > `every-hit` fires once per landing, the save's included"),
    );
    let t = row(vec![sword()?.into(), normal()?.into()])?
        .on_every_hit_with(flat(2.0)?, every_hit_landing(FAIL, Some("mark")))?;
    close(want.mean(&t), SWORD + NORMAL + 2.0 * (0.7 + 0.6), 12);
    close(want.fire(&t, "mark"), 1.0 - 0.3 * 0.4, 12);
    want.done();
    Ok(())
}

#[test]
fn first_miss_and_any_miss_fire_on_a_save_the_rider_does_not_count_as_landed() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{KIND} > `first-miss` and `any-miss` fire on a save the rider does not count as landed"
        ),
    );
    let failed =
        one(normal()?)?.on_any_miss_with(flat(3.0)?, rider_opts(FAIL, Some("rider"), None))?;
    close(want.fire(&failed, "rider"), 0.4, 12);
    let after_pass =
        one(normal()?)?.on_first_miss_with(flat(3.0)?, rider_opts(FAIL, Some("rider"), None))?;
    close(want.fire(&after_pass, "rider"), 0.4, 12);
    // A pass under saveHalf lands for a `damage` rider, so there is no miss to fire on.
    let dealt =
        one(half()?)?.on_any_miss_with(flat(3.0)?, rider_opts(DAMAGE, Some("rider"), None))?;
    close(want.fire(&dealt, "rider"), 0.0, 12);
    want.done();
    Ok(())
}

#[test]
fn a_save_never_crits_any_crit_over_a_save_and_an_attack_fires_on_the_attacks_crit_alone() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{KIND} > a save never crits: `any-crit` over a save and an attack fires on the attack's crit alone"
        ),
    );
    let t = row(vec![sword()?.into(), normal()?.into()])?.on_any_crit_with(
        flat(9.0)?,
        ConditionOptions {
            rider: rider_opts(DAMAGE, Some("rider"), None),
            ..ConditionOptions::default()
        },
    )?;
    close(want.fire(&t, "rider"), 0.05, 12);
    want.done();
    Ok(())
}

#[test]
fn an_attack_that_may_not_happen_a_save_row_that_may_not_happen_a_skipped_row_lands_nothing() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{KIND} > an attack that may not happen, a save row that may not happen: a skipped row lands nothing"
        ),
    );
    let t = empty()?
        .attack_with(
            normal()?,
            AttackOptions {
                chance: Some(0.5),
                ..AttackOptions::default()
            },
        )?
        .on_first_hit_with(flat(1.0)?, first_hit(FAIL, Some("rider"), None))?;
    close(want.fire(&t, "rider"), 0.5 * 0.6, 12);
    want.done();
    Ok(())
}

#[test]
fn a_save_that_cannot_fail_or_cannot_pass_is_still_a_save_row() -> T {
    let mut want = expect(
        FILE,
        &format!("{KIND} > a save that cannot fail, or cannot pass, is still a save row"),
    );
    let immune = d20()
        .plus(30.0)?
        .dc(5.0)?
        .on_save_failure_args(&[Arg::Roll(rs(3.0, 6.0)?)])?;
    assert_eq!(immune.to_pmf(0.0)?.outcomes(), vec!["missNone".to_string()]);
    let never = one(immune)?.on_first_hit_with(flat(1.0)?, first_hit(FAIL, Some("rider"), None))?;
    close(want.fire(&never, "rider"), 0.0, 12);
    let doomed = d20()
        .plus(-30.0)?
        .dc(40.0)?
        .on_save_failure_args(&[Arg::Roll(rs(3.0, 6.0)?)])?
        .save_half()?;
    let always =
        one(doomed)?.on_first_hit_with(flat(1.0)?, first_hit(DAMAGE, Some("rider"), None))?;
    close(want.fire(&always, "rider"), 1.0, 12);
    want.done();
    Ok(())
}

#[test]
fn a_save_rows_own_step_stats_do_not_depend_on_the_riders_that_watch_it() -> T {
    let mut want = expect(
        FILE,
        &format!("{KIND} > a save row's own stepStats do not depend on the riders that watch it"),
    );
    let both = || row(vec![sword()?.into(), normal()?.into()]);
    let bare = want.step_stats(&both()?, "attack 2");
    close(bare.hit, 1.0, 12);
    assert_eq!(bare.crit, 0.0);
    let watched = [
        both()?.on_first_hit_with(flat(1.0)?, first_hit(FAIL, None, None))?,
        both()?.on_first_hit_with(flat(1.0)?, first_hit(DAMAGE, None, None))?,
        both()?
            .on_first_hit_with(flat(1.0)?, first_hit(FAIL, None, None))?
            .on_every_hit_with(flat(2.0)?, every_hit_landing(DAMAGE, None))?,
    ];
    // Splitting the row's draws by class changes the last bit of a sum, never the value.
    for t in &watched {
        let stats = want.step_stats(t, "attack 2");
        close(stats.rolled, bare.rolled, 12);
        close(stats.hit, bare.hit, 12);
        assert_eq!(stats.crit, 0.0);
    }
    want.done();
    Ok(())
}

// ---- a save's landing is what an attack that lands with the same odds does -------------------------------

const SAME: &str = "a save's landing is what an attack that lands with the same odds does";

/// The rider's own contribution, `mean(with) - mean(without)`.
fn contribution(
    want: &mut impl Reads,
    rows: &dyn Fn() -> R<Turn>,
    rider: &dyn Fn(&Turn) -> R<Turn>,
) -> Result<f64, DiceError> {
    let with = want.mean(&rider(&rows()?)?);
    Ok(with - want.mean(&rows()?))
}

#[test]
fn fail_on_a_0_60_save_is_an_attack_that_hits_0_60_and_never_crits() -> T {
    let mut want = expect(
        FILE,
        &format!("{SAME} > `fail` on a 0.60 save is an attack that hits 0.60 and never crits"),
    );
    let attack = attack_roll(0.0, 9.0, d6())?.no_crit()?;
    close(attack.resolve(0.0)?.weights.hit, 0.6, 12);
    let via_save =
        |t: &Turn| t.on_first_hit_with(rs(2.0, 6.0)?, first_hit(FAIL, Some("rider"), None));
    let via_attack =
        |t: &Turn| t.on_first_hit_with(rs(2.0, 6.0)?, first_hit(None, Some("rider"), None));
    let with_save = || row(vec![sword()?.into(), normal()?.into()]);
    let with_attack = || row(vec![sword()?.into(), attack.clone().into()]);
    let a = contribution(&mut want, &with_save, &via_save)?;
    let b = contribution(&mut want, &with_attack, &via_attack)?;
    close(a, b, 12);
    let fa = want.fire(&via_save(&with_save()?)?, "rider");
    let fb = want.fire(&via_attack(&with_attack()?)?, "rider");
    close(fa, fb, 12);
    want.done();
    Ok(())
}

#[test]
fn damage_on_a_save_for_half_is_an_attack_that_always_lands() -> T {
    let mut want = expect(
        FILE,
        &format!("{SAME} > `damage` on a save-for-half is an attack that always lands"),
    );
    let always = d20().always_hits()?.on_hit(d6())?.no_crit()?;
    let via_save =
        |t: &Turn| t.on_first_hit_with(rs(2.0, 6.0)?, first_hit(DAMAGE, Some("rider"), None));
    let via_attack =
        |t: &Turn| t.on_first_hit_with(rs(2.0, 6.0)?, first_hit(None, Some("rider"), None));
    let with_save = || row(vec![sword()?.into(), half()?.into()]);
    let with_attack = || row(vec![sword()?.into(), always.clone().into()]);
    let a = contribution(&mut want, &with_save, &via_save)?;
    let b = contribution(&mut want, &with_attack, &via_attack)?;
    close(a, b, 12);
    want.done();
    Ok(())
}

#[test]
fn a_landing_kind_on_attack_sources_changes_nothing() -> T {
    let mut want = expect(
        FILE,
        &format!("{SAME} > a landing kind on attack sources changes nothing"),
    );
    let plain = row(vec![sword()?.into(), sword()?.into()])?
        .on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())?;
    let declared = row(vec![sword()?.into(), sword()?.into()])?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit(DAMAGE, None, None))?;
    let declared_pmf = want.pmf(&declared);
    let plain_pmf = want.pmf(&plain);
    assert_eq!(max_diff(&declared_pmf, &plain_pmf), 0.0);
    want.done();
    Ok(())
}

#[test]
fn the_row_itself_is_walked_exactly_as_before() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SAME} > the row itself is walked exactly as before: a rider over other rows leaves the save's damage alone"
        ),
    );
    let with_rider = row(vec![sword()?.into(), half()?.into()])?.on_first_hit_with(
        flat(4.0)?,
        first_hit(None, Some("rider"), Some(&["attack 1"])),
    )?;
    close(want.mean(&with_rider), SWORD + HALF + 4.0 * 0.7, 12);
    want.done();
    Ok(())
}

// ---- watching a save is refused unless the rider says how it lands -------------------------------------------

#[test]
fn without_a_landing_kind_a_save_row_is_not_an_attack_and_the_error_says_how_to_watch_it() -> T {
    let both = || row(vec![sword()?.into(), normal()?.into()]);
    let refused = both()?.on_first_hit_with(d6(), FirstHitOptions::default());
    match &refused {
        Err(e) => assert!(e.message().contains("landing"), "{}", e.message()),
        Ok(_) => return Err(DiceError::error("expected a refusal").into()),
    }
    assert_eq!(code_of(refused), "not-an-attack");
    // A reader of another kind cannot borrow the landing another rider declared.
    let landed = both()?.on_first_hit_with(d6(), first_hit(FAIL, None, Some(&["attack 2"])))?;
    assert_eq!(
        code_of(landed.on_every_hit_with(
            advantage().until_next_attack(),
            EveryHitOptions {
                first_hit: first_hit(None, None, Some(&["attack 2"])),
                max: None
            }
        )),
        "not-an-attack"
    );
    assert_eq!(
        code_of(both()?.on_first_hit_transform(
            keep_best_damage(),
            first_hit(None, None, Some(&["attack 2"]))
        )),
        "not-an-attack"
    );
    Ok(())
}

#[test]
fn refuses_a_landing_kind_that_means_nothing() -> T {
    let spec = |rider: Rider| -> R<Turn> {
        Turn::from_spec(
            TurnSpec {
                attacks: vec![atk(sword()?), atk(normal()?)],
                riders: Some(vec![rider]),
                ..TurnSpec::default()
            },
            0.0,
        )
    };
    let landing_on_not_fired = Rider {
        trigger: Trigger::NotFired {
            of: "y".to_string(),
        },
        id: Some("x".to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(d6().into())),
        crit_damage: None,
        landing: Some(RiderLanding::Save(SaveLanding::Fail)),
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    };
    assert_eq!(code_of(spec(landing_on_not_fired)), "unsupported-trigger");
    let both = row(vec![sword()?.into(), normal()?.into()])?;
    assert_eq!(
        code_of(
            both.on_first_hit_with(d6(), first_hit(FAIL, None, None))?
                .otherwise_with(d6(), rider_opts(FAIL, None, None))
        ),
        "unsupported-trigger"
    );
    Ok(())
}

#[test]
fn refuses_a_landing_kind_on_a_transform_on_a_grant_it_is_a_condition_field() -> T {
    let swords = || row(vec![sword()?.into(), sword()?.into()]);
    assert_eq!(
        code_of(
            swords()?
                .on_first_hit_with(advantage().until_end_of_turn(), first_hit(FAIL, None, None))
        ),
        "none"
    );
    assert_eq!(
        code_of(swords()?.on_first_hit_transform(keep_best_damage(), first_hit(FAIL, None, None))),
        "unsupported-trigger"
    );
    Ok(())
}

#[test]
fn dice_match_still_needs_dice_a_save_has_no_descriptor() -> T {
    let both = row(vec![sword()?.into(), normal()?.into()])?;
    assert_eq!(
        code_of(both.on_dice_match_with(&["attack 2"], d6(), rider_opts(FAIL, None, None))),
        "no-dice-descriptor"
    );
    Ok(())
}

// ---- a landing needs damage ------------------------------------------------------------------------------------

#[test]
fn a_pass_that_deals_nothing_is_no_landing_though_its_label_is_save_half() -> T {
    let mut want = expect(
        FILE,
        "a landing needs damage: `damage` is 'when you deal damage' > a pass that deals nothing is no landing, though its label is saveHalf",
    );
    // 1d4 on a failure, half floored on a pass: a pass after a 1 deals 0. The target passes 0.4,
    // and a quarter of those passes rolled a 1, so 0.3 of the turns deal half damage.
    let small = || {
        d20()
            .dc(13.0)?
            .on_save_failure_args(&[Arg::Roll(rs(1.0, 4.0)?)])?
            .save_half()
    };
    let damage =
        one(small()?)?.on_first_hit_with(flat(10.0)?, first_hit(DAMAGE, Some("r"), None))?;
    close(want.fire(&damage, "r"), 0.6 + 0.4 * 0.75, 12);
    let fail = one(small()?)?.on_first_hit_with(flat(10.0)?, first_hit(FAIL, Some("r"), None))?;
    close(want.fire(&fail, "r"), 0.6, 12);
    want.done();
    Ok(())
}

// ---- two riders read one save row under different landing kinds -------------------------------------------------

const TWO: &str = "two riders read one save row under different landing kinds";

// The failure deals 0, 1, 2 or 3 (d4 - 1), so every class of the row occurs: a failure that
// deals damage, a failure that deals none, a pass that deals damage, a pass that deals none.
// The oracle enumerates the eight (outcome, payload) cases by hand.
fn save4() -> Result<SaveBuilder, DiceError> {
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(rs(1.0, 4.0)?.plus(-1.0)?)])?
        .save_half()
}

fn enumerate(per_case: impl Fn(bool, f64) -> f64) -> BTreeMap<i64, f64> {
    let payloads = [0.0, 1.0, 2.0, 3.0];
    let mut out = BTreeMap::new();
    for payload in payloads {
        for failed in [true, false] {
            let dealt = if failed {
                payload
            } else {
                f64::floor(payload / 2.0)
            };
            let total = dealt + per_case(failed, dealt);
            *out.entry(total as i64).or_insert(0.0) +=
                (if failed { 0.6 } else { 0.4 }) / payloads.len() as f64;
        }
    }
    out
}

fn expect_same(pmf: &Pmf, expected: &BTreeMap<i64, f64>) {
    let mut values: Vec<i64> = pmf.support().iter().map(|v| v.0 as i64).collect();
    values.extend(expected.keys());
    for value in values {
        close(
            pmf.p_at(value as f64),
            expected.get(&value).copied().unwrap_or(0.0),
            12,
        );
    }
}

#[test]
fn first_hit_riders_one_on_failure_one_on_damage() -> T {
    let mut want = expect(
        FILE,
        &format!("{TWO} > first-hit riders: one on failure (`fail`), one on damage (`damage`)"),
    );
    let t = one(save4()?)?
        .on_first_hit_with(flat(10.0)?, first_hit(FAIL, Some("failure"), None))?
        .on_first_hit_with(flat(20.0)?, first_hit(DAMAGE, Some("damage"), None))?;
    let pmf = want.pmf(&t);
    expect_same(
        &pmf,
        &enumerate(|failed, dealt| {
            (if failed { 10.0 } else { 0.0 }) + (if dealt > 0.0 { 20.0 } else { 0.0 })
        }),
    );
    close(want.fire(&t, "failure"), 0.6, 12);
    close(want.fire(&t, "damage"), 0.6 * 0.75 + 0.4 * 0.5, 12);
    want.done();
    Ok(())
}

#[test]
fn an_every_hit_rider_on_one_kind_beside_a_first_hit_rider_on_the_other() -> T {
    let mut want = expect(
        FILE,
        &format!("{TWO} > an every-hit rider on one kind beside a first-hit rider on the other"),
    );
    let t = one(save4()?)?
        .on_every_hit_with(flat(3.0)?, every_hit_landing(FAIL, Some("mark")))?
        .on_first_hit_with(flat(10.0)?, first_hit(DAMAGE, Some("damage"), None))?;
    let pmf = want.pmf(&t);
    expect_same(
        &pmf,
        &enumerate(|failed, dealt| {
            (if failed { 3.0 } else { 0.0 }) + (if dealt > 0.0 { 10.0 } else { 0.0 })
        }),
    );
    close(want.fire(&t, "mark"), 0.6, 12);
    close(want.fire(&t, "damage"), 0.6 * 0.75 + 0.4 * 0.5, 12);
    want.done();
    Ok(())
}

#[test]
fn a_save_row_that_happens_half_the_time() -> T {
    let mut want = expect(
        FILE,
        &format!("{TWO} > a save row that happens half the time"),
    );
    let t = empty()?
        .attack_with(
            save4()?,
            AttackOptions {
                id: Some("row".to_string()),
                chance: Some(0.5),
                ..AttackOptions::default()
            },
        )?
        .on_first_hit_with(flat(10.0)?, first_hit(FAIL, None, Some(&["row"])))?
        .on_first_hit_with(flat(20.0)?, first_hit(DAMAGE, None, Some(&["row"])))?;
    let happens = enumerate(|failed, dealt| {
        (if failed { 10.0 } else { 0.0 }) + (if dealt > 0.0 { 20.0 } else { 0.0 })
    });
    let mut expected: BTreeMap<i64, f64> = happens
        .into_iter()
        .map(|(total, mass)| (total, mass * 0.5))
        .collect();
    *expected.entry(0).or_insert(0.0) += 0.5;
    let pmf = want.pmf(&t);
    expect_same(&pmf, &expected);
    want.done();
    Ok(())
}

#[test]
fn beside_an_attack_each_rider_reads_the_save_as_its_own_kind_says() -> T {
    let mut want = expect(
        FILE,
        &format!("{TWO} > beside an attack, each rider reads the save as its own kind says"),
    );
    let t = row(vec![sword()?.into(), save4()?.into()])?
        .on_first_hit_with(flat(10.0)?, first_hit(FAIL, Some("failure"), None))?
        .on_first_hit_with(flat(20.0)?, first_hit(DAMAGE, Some("damage"), None))?;
    // Both fire unless the attack missed (0.30); then the save decides each.
    close(want.fire(&t, "failure"), 1.0 - 0.3 * 0.4, 12);
    close(
        want.fire(&t, "damage"),
        1.0 - 0.3 * (1.0 - (0.6 * 0.75 + 0.4 * 0.5)),
        12,
    );
    want.done();
    Ok(())
}

// ---- landing kinds as plain data --------------------------------------------------------------------------------

#[test]
fn turn_from_reads_landing_on_a_rider_like_the_fluent_verb_does() -> T {
    let mut want = expect(
        FILE,
        "landing kinds as plain data > Turn.from reads `landing` on a rider like the fluent verb does",
    );
    let from_data = Turn::from_spec(
        TurnSpec {
            attacks: vec![atk(sword()?), atk(half()?)],
            riders: Some(vec![Rider {
                trigger: Trigger::FirstHit {
                    of: None,
                    per_source: None,
                },
                id: Some("rider".to_string()),
                damage: RiderDamageSpec::Plain(RiderDamage::One(rs(2.0, 6.0)?.into())),
                crit_damage: None,
                landing: Some(RiderLanding::Save(SaveLanding::Damage)),
                happens: None,
                joins: None,
                r#where: None,
                target_has: None,
            }]),
            ..TurnSpec::default()
        },
        0.0,
    )?;
    let fluent = row(vec![sword()?.into(), half()?.into()])?
        .on_first_hit_with(rs(2.0, 6.0)?, first_hit(DAMAGE, Some("rider"), None))?;
    let a = want.pmf(&from_data);
    let b = want.pmf(&fluent);
    assert_eq!(max_diff(&a, &b), 0.0);
    assert_eq!(want.fire(&from_data, "rider"), want.fire(&fluent, "rider"));
    want.done();
    Ok(())
}

#[test]
fn a_watched_save_row_takes_no_group_of_its_own_beyond_the_riders_source_set() -> T {
    let mut want = expect(
        FILE,
        "landing kinds as plain data > a watched save row takes no group of its own beyond the rider's source set",
    );
    let t = row(vec![sword()?.into(), normal()?.into()])?
        .on_first_hit_with(d6(), first_hit(DAMAGE, None, None))?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    want.done();
    Ok(())
}
