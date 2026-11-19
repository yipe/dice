//! `src/turn/probes.test.ts`: 27 tests (the nine `onAnyCrit` stand-in cases are one loop), 278 compat calls.
//!
//! Not translated: probes.test.ts:221: `observe: [{ on: "any-miss" }]` (`ProbeOn` has only `AnyCrit`; the
//! unsupported-trigger refusal of an unknown probe kind cannot be spelled in a typed spec).
//! Not translated: probes.test.ts:230: `observe: [{ id: 7 }]` non-string-id (`ProbeSpec.id` is a string).
//! Not translated: probes.test.ts:20-25: the `afterEach(vi.restoreAllMocks)` hook (no mocks here).

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::common::bounce::calculate_bounce_odds;
use crate::error::DiceError;
use crate::turn::effects::{
    ConditionOptions, FirstHitOptions, advantage, crit_on_hit, keep_best_damage,
};
use crate::turn::types::{
    MAX_TRIGGER_GROUPS, ProbeOn, ProbeSpec, Rider, RiderDamage, RiderDamageSpec, RiderOptions,
    Trigger, TurnSpec,
};
use crate::turn::{Turn, bounce, turn};
use crate::{EPS, Pmf};

const FILE: &str = "src/turn/probes.test.ts";

type R<X> = Result<X, DiceError>;

// `d20+5` vs AC 12: miss 0.30, hit 0.65, crit 0.05 (advantage: 0.09 / 0.8125 / 0.0975); `1d8+3`
// on a hit, `2d8+3` on a crit. Every expected probability below is worked by hand from those.
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?)
}
fn adv_sword() -> Result<AttackBuilder, DiceError> {
    d20()
        .with_advantage()?
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)
}
fn orb() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 17.0, rs(3.0, 8.0)?)
}
fn nothing() -> Result<Pmf, DiceError> {
    Pmf::delta(0.0, EPS)
}

fn bare(source: AttackBuilder) -> R<Turn> {
    turn(vec![atk(source)], 0.0)
}
fn bares(sources: &[AttackBuilder]) -> R<Turn> {
    turn(sources.iter().map(|s| atk(s.clone())).collect(), 0.0)
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

fn of(ids: &[&str]) -> Option<Vec<String>> {
    Some(ids.iter().map(|s| (*s).to_string()).collect())
}

fn rider_of(ids: &[&str], id: Option<&str>) -> RiderOptions {
    RiderOptions {
        id: id.map(str::to_string),
        of: of(ids),
        ..RiderOptions::default()
    }
}

fn first_hit_of(ids: &[&str], id: Option<&str>) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: rider_of(ids, id),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn chance(c: f64) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            chance: Some(c),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn every_chance(c: f64) -> crate::turn::effects::EveryHitOptions {
    crate::turn::effects::EveryHitOptions {
        first_hit: chance(c),
        ..Default::default()
    }
}

fn probe(t: &Turn, id: &str, ids: Option<&[&str]>) -> R<Turn> {
    t.observe_any_crit(id, ids)
}

fn att_chance(c: f64) -> crate::turn::types::AttackOptions {
    crate::turn::types::AttackOptions {
        chance: Some(c),
        ..Default::default()
    }
}

// ---- observeAnyCrit: P(at least one of the sources crit) -----------------------------------------

const OBS: &str = "observeAnyCrit: P(at least one of the sources crit)";

#[test]
fn is_1_minus_0_95_n_over_n_plain_swings() -> T {
    let mut want = expect(FILE, &format!("{OBS} > is 1 - 0.95^N over N plain swings"));
    for swings in [1.0, 2.0, 4.0] {
        let t = empty()?
            .attacks(swings, sword()?)?
            .observe_any_crit("crit", None)?;
        close(want.fire(&t, "crit"), 1.0 - 0.95f64.powf(swings), 12);
    }
    want.done();
    Ok(())
}

#[test]
fn reads_only_the_sources_named_in_of() -> T {
    let mut want = expect(
        FILE,
        &format!("{OBS} > reads only the sources named in `of`"),
    );
    let t = bares(&[sword()?, sword()?, sword()?])?
        .observe_any_crit("outer", Some(&["attack 1", "attack 3"]))?;
    close(want.fire(&t, "outer"), 1.0 - 0.95f64.powi(2), 12);
    want.done();
    Ok(())
}

#[test]
fn follows_each_sources_own_crit_odds() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{OBS} > follows each source's own crit odds: advantage doubles a swing's 0.05 to 0.0975"
        ),
    );
    let t = bares(&[adv_sword()?, sword()?])?.observe_any_crit("crit", None)?;
    close(want.fire(&t, "crit"), 1.0 - 0.9025 * 0.95, 12);
    want.done();
    Ok(())
}

#[test]
fn counts_an_attack_that_only_happens_half_the_time_at_half_its_crit_odds() -> T {
    let mut want = expect(
        FILE,
        &format!("{OBS} > counts an attack that only happens half the time at half its crit odds"),
    );
    let t = empty()?
        .attack(sword()?)?
        .attack_with(sword()?, att_chance(0.5))?
        .observe_any_crit("crit", None)?;
    close(want.fire(&t, "crit"), 1.0 - 0.95 * (1.0 - 0.5 * 0.05), 12);
    want.done();
    Ok(())
}

#[test]
fn sees_a_crit_on_hit_grant_a_first_hit_makes_the_next_landing_a_crit() -> T {
    let mut want = expect(
        FILE,
        &format!("{OBS} > sees a crit-on-hit grant: a first hit makes the next landing a crit"),
    );
    // attack 1 crits (0.05), or hits (0.65) and attack 2 then crits when it lands (0.70), or
    // misses (0.30) and attack 2 crits on a natural 20 (0.05).
    let t = bares(&[sword()?, sword()?])?
        .on_first_hit_with(
            crit_on_hit().until_end_of_turn(),
            FirstHitOptions::default(),
        )?
        .observe_any_crit("crit", None)?;
    close(want.fire(&t, "crit"), 0.05 + 0.65 * 0.7 + 0.3 * 0.05, 12);
    want.done();
    Ok(())
}

#[test]
fn sees_a_crit_on_hit_grant_that_takes_only_with_probability_chance() -> T {
    let mut want = expect(
        FILE,
        &format!("{OBS} > sees a crit-on-hit grant that takes only with probability `chance`"),
    );
    let t = bares(&[sword()?, sword()?])?
        .on_first_hit_with(crit_on_hit().until_end_of_turn(), chance(0.4))?
        .observe_any_crit("crit", None)?;
    close(
        want.fire(&t, "crit"),
        0.05 + 0.65 * (0.4 * 0.7 + 0.6 * 0.05) + 0.3 * 0.05,
        12,
    );
    want.done();
    Ok(())
}

#[test]
fn counts_a_rerolls_crit_when_the_reroll_is_named_and_not_when_it_is_not() -> T {
    let mut want = expect(
        FILE,
        &format!("{OBS} > counts a reroll's crit when the reroll is named, and not when it is not"),
    );
    let base = bare(sword()?)?.on_first_miss_with(sword()?, rid("reroll"))?;
    // The default `of` is the attacks plus the rerolls declared so far.
    let all = probe(&base, "all", None)?;
    close(want.fire(&all, "all"), 0.05 + 0.3 * 0.05, 12);
    let both = probe(&base, "both", Some(&["attack 1", "reroll"]))?;
    close(want.fire(&both, "both"), 0.05 + 0.3 * 0.05, 12);
    let first = probe(&base, "first", Some(&["attack 1"]))?;
    close(want.fire(&first, "first"), 0.05, 12);
    want.done();
    Ok(())
}

#[test]
fn sees_a_bounce_chains_beams_a_beam_fires_only_after_the_one_before_matched() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{OBS} > sees a bounce chain's beams: a beam fires only after the one before matched"
        ),
    );
    // No crit anywhere: a beam misses (0.55), or hits (0.40) and either stops (dice unmatched) or
    // goes on (matched, 3d8 matches with calculateBounceOdds(3, 8)); a crit ends the search.
    let matches = calculate_bounce_odds(3.0, 8.0, None)?;
    let mut no_crit = 0.95;
    for _follow in 1..=3 {
        no_crit = 0.55 + 0.4 * (1.0 - matches) + 0.4 * matches * no_crit;
    }
    let t = bounce(attack_to_roll(orb()?), 3.0)?.observe_any_crit(
        "crit",
        Some(&["attack 1", "bounce 1", "bounce 2", "bounce 3"]),
    )?;
    close(want.fire(&t, "crit"), 1.0 - no_crit, 12);
    want.done();
    Ok(())
}

// ---- a probe agrees with the zero-damage `onAnyCrit` rider ------------------------------------------

fn attack_to_roll(a: AttackBuilder) -> crate::turn::types::DamageSource {
    crate::turn::types::DamageSource::Attack(Box::new(a))
}

type Base = fn() -> R<Turn>;

fn three_swords() -> R<Turn> {
    bares(&[sword()?, sword()?, sword()?])
}
fn adv_and_plain() -> R<Turn> {
    bares(&[adv_sword()?, sword()?])
}
fn may_not_happen() -> R<Turn> {
    empty()?
        .attack(sword()?)?
        .attack_with(sword()?, att_chance(0.5))
}
fn saved_grant_and_next_attack() -> R<Turn> {
    three_swords()?
        .on_first_hit_with(crit_on_hit().until_end_of_turn(), chance(0.4))?
        .on_every_hit_with(advantage().until_next_attack(), Default::default())
}
fn first_miss_reroll() -> R<Turn> {
    bares(&[sword()?, sword()?])?.on_first_miss_with(sword()?, rid("reroll"))
}
fn any_miss_reroll() -> R<Turn> {
    bares(&[sword()?, sword()?])?.on_any_miss_with(sword()?, rid("reroll"))
}
fn threshold_substitute() -> R<Turn> {
    bares(&[sword()?, sword()?])?.on_first_hit_transform(
        keep_best_damage().if_below_split(9.0, 20.0)?,
        FirstHitOptions::default(),
    )
}
fn sneak_beside() -> R<Turn> {
    bares(&[sword()?, sword()?])?.on_first_hit_with(rs(3.0, 6.0)?, FirstHitOptions::default())
}
fn bounce_chain() -> R<Turn> {
    bounce(attack_to_roll(orb()?), 3.0)
}

#[test]
fn a_probe_agrees_with_the_zero_damage_on_any_crit_rider_that_used_to_stand_in_for_it() -> T {
    let beams = ["attack 1", "bounce 1", "bounce 2", "bounce 3"];
    let cases: [(&str, Base, Option<&[&str]>); 9] = [
        ("plain", three_swords, None),
        ("advantage and plain", adv_and_plain, None),
        ("an attack that may not happen", may_not_happen, None),
        (
            "a saved crit-on-hit grant and a next-attack grant",
            saved_grant_and_next_attack,
            None,
        ),
        ("a first-miss reroll", first_miss_reroll, None),
        ("an any-miss reroll", any_miss_reroll, None),
        ("a threshold substitute", threshold_substitute, None),
        ("a sneak attack beside it", sneak_beside, None),
        ("a bounce chain", bounce_chain, Some(&beams)),
    ];
    for (name, base, of_ids) in cases {
        let mut want = expect(
            FILE,
            &format!(
                "a probe agrees with the zero-damage `onAnyCrit` rider that used to stand in for it > {name}: same probability at 1e-12, and the same damage as without it"
            ),
        );
        let probed = base()?.observe_any_crit("probe", of_ids)?;
        let stood = base()?.on_any_crit_with(
            nothing()?,
            ConditionOptions {
                rider: RiderOptions {
                    id: Some("ref".to_string()),
                    of: of_ids.and_then(of_owned),
                    ..RiderOptions::default()
                },
                ..ConditionOptions::default()
            },
        )?;
        close(want.fire(&probed, "probe"), want.fire(&stood, "ref"), 12);
        // No damage is added: the probe's turn deals exactly what the same turn without it deals.
        let probed_pmf = want.pmf(&probed);
        let base_pmf = want.pmf(&base()?);
        assert!(max_diff(&probed_pmf, &base_pmf) < 1e-12, "{name}");
        close(want.mean(&probed), want.mean(&base()?), 12);
        want.done();
    }
    Ok(())
}

fn of_owned(ids: &[&str]) -> Option<Vec<String>> {
    of(ids)
}

// ---- a probe is read from a walk that carries no damage ----------------------------------------------

const NO_DAMAGE: &str = "a probe is read from a walk that carries no damage";

fn convolving() -> R<Turn> {
    three_swords()?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_every_hit_with(crit_on_hit().until_next_attack(), every_chance(0.5))?
        .observe_any_crit("crit", None)
}

#[test]
fn agrees_with_the_full_walks_value_for_a_rider_over_the_same_sources() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{NO_DAMAGE} > agrees with the full walk's value for a rider over the same sources"
        ),
    );
    let stood = three_swords()?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_every_hit_with(crit_on_hit().until_next_attack(), every_chance(0.5))?
        .on_any_crit_with(nothing()?, cond_id("ref"))?;
    close(
        want.fire(&convolving()?, "crit"),
        want.fire(&stood, "ref"),
        12,
    );
    want.done();
    Ok(())
}

#[test]
fn does_not_depend_on_whether_the_damage_was_resolved_first() -> T {
    let mut want = expect(
        FILE,
        &format!("{NO_DAMAGE} > does not depend on whether the damage was resolved first"),
    );
    let first = convolving()?;
    let before = want.fire(&first, "crit");
    want.mean(&first);
    assert_eq!(want.fire(&first, "crit"), before);
    want.done();
    Ok(())
}

// ---- probes as plain data -----------------------------------------------------------------------------

const DATA: &str = "probes as plain data";

#[test]
fn turn_from_takes_observe_and_reads_the_same_as_the_fluent_spelling() -> T {
    let mut want = expect(
        FILE,
        &format!("{DATA} > Turn.from takes `observe` and reads the same as the fluent spelling"),
    );
    let spec = TurnSpec {
        attacks: vec![named("a", sword()?), named("b", sword()?)],
        observe: Some(vec![
            ProbeSpec {
                id: Some("crit".to_string()),
                on: ProbeOn::AnyCrit,
                of: of(&["a", "b"]),
            },
            ProbeSpec {
                id: None,
                on: ProbeOn::AnyCrit,
                of: of(&["a"]),
            },
        ]),
        ..TurnSpec::default()
    };
    let from_data = Turn::from_spec(spec, 0.0)?;
    assert_eq!(
        from_data.probe_ids()?,
        vec!["crit".to_string(), "probe 2".to_string()]
    );
    let crit = want.fire(&from_data, "crit");
    close(crit, 1.0 - 0.95f64.powi(2), 12);
    close(want.fire(&from_data, "probe 2"), 0.05, 12);

    let fluent = empty()?
        .attack_as(sword()?, "a")?
        .attack_as(sword()?, "b")?
        .observe_any_crit("crit", None)?;
    assert_eq!(want.fire(&fluent, "crit"), want.fire(&from_data, "crit"));
    want.done();
    Ok(())
}

#[test]
fn an_omitted_of_watches_every_attack_plus_every_attack_shaped_reroll() -> T {
    let mut want = expect(
        FILE,
        &format!("{DATA} > an omitted `of` watches every attack plus every attack-shaped reroll"),
    );
    let spec = TurnSpec {
        attacks: vec![atk(sword()?), atk(sword()?)],
        riders: Some(vec![Rider {
            trigger: Trigger::FirstMiss { of: None },
            id: Some("reroll".to_string()),
            damage: RiderDamageSpec::Plain(RiderDamage::One(sword()?.into())),
            crit_damage: None,
            landing: None,
            happens: None,
            joins: None,
            r#where: None,
            target_has: None,
        }]),
        observe: Some(vec![ProbeSpec {
            id: Some("crit".to_string()),
            on: ProbeOn::AnyCrit,
            of: None,
        }]),
        ..TurnSpec::default()
    };
    let t = Turn::from_spec(spec, 0.0)?;
    // No crit anywhere: attack 1 crits (0.05) or not; on a miss (0.30) the reroll and attack 2
    // both fail to crit (0.95 each); on a hit (0.65) attack 2 either lands non-crit (0.65), or
    // misses (0.30) and the reroll fails to crit (0.95). Without the reroll it would be 0.0975.
    let no_crit = 0.3 * 0.95 * 0.95 + 0.65 * (0.65 + 0.3 * 0.95);
    close(want.fire(&t, "crit"), 1.0 - no_crit, 12);
    close(1.0 - no_crit, 0.1215, 12);
    want.done();
    Ok(())
}

#[test]
fn the_chaining_call_snapshots_the_default_of_so_an_attack_added_after_it_throws() -> T {
    let observed = bare(sword()?)?.observe_any_crit("crit", None)?;
    assert_eq!(code_of(observed.attack(sword()?)), "attack-after-rider");
    let named_of = bare(sword()?)?.observe_any_crit("crit", Some(&["attack 1"]))?;
    assert!(named_of.attack(sword()?).is_ok());
    Ok(())
}

#[test]
fn vs_ac_keeps_the_probes() -> T {
    let mut want = expect(FILE, &format!("{DATA} > vsAC keeps the probes"));
    let t = bares(&[adv_sword()?])?
        .observe_any_crit("crit", None)?
        .vs_ac(9.0)?;
    close(want.fire(&t, "crit"), 0.0975, 12);
    want.done();
    Ok(())
}

// ---- probe validation ------------------------------------------------------------------------------------

#[test]
fn shares_one_id_space_with_attacks_riders_substitutes_and_conditions() -> T {
    assert_eq!(
        code_of(
            bare(sword()?)?
                .on_first_hit_with(d6(), first_hit_id("x"))?
                .observe_any_crit("x", None)
        ),
        "duplicate-id"
    );
    assert_eq!(
        code_of(bare(sword()?)?.observe_any_crit("attack 1", None)),
        "duplicate-id"
    );
    assert_eq!(
        code_of(
            bare(sword()?)?
                .observe_any_crit("x", None)?
                .observe_any_crit("x", None)
        ),
        "duplicate-id"
    );
    Ok(())
}

#[test]
fn cannot_be_watched_and_its_of_follows_a_riders_rules() -> T {
    assert_eq!(
        code_of(
            bare(sword()?)?
                .observe_any_crit("p", None)?
                .on_first_hit_with(d6(), first_hit_of(&["p"], None))
        ),
        "not-an-attack"
    );
    assert_eq!(
        code_of(bare(sword()?)?.observe_any_crit("p", Some(&["nowhere"]))),
        "unknown-id"
    );
    assert_eq!(
        code_of(bare(sword()?)?.observe_any_crit("p", Some(&[]))),
        "unknown-id"
    );
    assert_eq!(
        code_of(
            bare(sword()?)?
                .on_first_hit_with(d6(), first_hit_id("dmg"))?
                .observe_any_crit("p", Some(&["dmg"]))
        ),
        "not-an-attack"
    );
    Ok(())
}

#[test]
fn is_named_by_fire_probabilitys_unknown_id_error() -> T {
    let t = bare(sword()?)?.observe_any_crit("crit", None)?;
    assert_eq!(code_of(t.fire_probability("attack 1")), "unknown-id");
    let message = match t.fire_probability("nothing") {
        Err(e) => e.message().to_string(),
        Ok(p) => return Err(format!("expected an error, got {p}").into()),
    };
    assert!(message.contains("\"crit\""), "{message}");
    Ok(())
}

// ---- a probe keeps its group live to the end, and the cap counts it ------------------------------------

const CAP: &str = "a probe keeps its group live to the end, and the cap counts it";

#[test]
fn keeps_each_probed_beams_group_live_to_the_end_one_slot_per_probed_source_set() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{CAP} > keeps each probed beam's group live to the end: one slot per probed source set"
        ),
    );
    let beams = bounce(attack_to_roll(orb()?), 3.0)?;
    want.mean(&beams);
    assert_eq!(beams.inspect_turn()?.0, 2);
    // A probe over the last beam takes a slot a dead group has freed, so it costs nothing extra.
    let last = probe(&beams, "last", Some(&["bounce 3"]))?;
    want.mean(&last);
    assert_eq!(last.inspect_turn()?.0, 2);
    let mut probed = beams;
    for beam in [1, 2, 3] {
        probed = probe(
            &probed,
            &format!("beam {beam}"),
            Some(&[&format!("bounce {beam}")]),
        )?;
    }
    want.mean(&probed);
    assert_eq!(probed.inspect_turn()?.0, 3);
    want.done();
    Ok(())
}

#[test]
fn shares_the_group_a_rider_over_the_same_sources_already_has() -> T {
    let mut want = expect(
        FILE,
        &format!("{CAP} > shares the group a rider over the same sources already has"),
    );
    let t = bares(&[sword()?, sword()?])?
        .on_first_hit_with(d6(), FirstHitOptions::default())?
        .observe_any_crit("crit", None)?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    want.done();
    Ok(())
}

#[test]
fn lets_a_group_that_would_die_in_the_chain_live_on_nine_probes_over_a_long_chain_no_longer_fit()
-> T {
    let mut want = expect(
        FILE,
        &format!(
            "{CAP} > lets a group that would die in the chain live on: nine probes over a long chain no longer fit"
        ),
    );
    let chain = bounce(attack_to_roll(orb()?), 12.0)?;
    want.mean(&chain);
    assert_eq!(chain.inspect_turn()?.0, 2);
    let probe_beams = |count: usize| -> R<Turn> {
        let mut t: Option<Turn> = None;
        for k in 1..=count {
            t = Some(probe(
                t.as_ref().unwrap_or(&chain),
                &format!("probe {k}"),
                Some(&[&format!("bounce {k}")]),
            )?);
        }
        t.ok_or_else(|| DiceError::Error("no probes".to_string()))
    };
    let one = probe_beams(1)?;
    want.fire(&one, "probe 1");
    assert_eq!(code_of(probe_beams(MAX_TRIGGER_GROUPS)), "too-many-groups");
    want.done();
    Ok(())
}

#[test]
fn a_tenth_source_set_live_at_once_throws() -> T {
    let mut want = expect(
        FILE,
        &format!("{CAP} > a tenth source set live at once throws"),
    );
    let ids = ["attack 1", "attack 2", "attack 3", "attack 4"];
    let mut sets: Vec<Vec<&str>> = Vec::new();
    for mask in 1..(1usize << ids.len()) {
        sets.push(
            ids.iter()
                .enumerate()
                .filter(|(bit, _)| mask & (1 << bit) != 0)
                .map(|(_, id)| *id)
                .collect(),
        );
    }
    let mut t = bares(&[sword()?, sword()?, sword()?, sword()?])?;
    for (i, set) in sets.iter().take(MAX_TRIGGER_GROUPS).enumerate() {
        t = t.on_first_hit_with(d6(), first_hit_of(set, Some(&format!("group {}", i + 1))))?;
    }
    assert_eq!(
        code_of(probe(&t, "tenth", Some(&sets[MAX_TRIGGER_GROUPS]))),
        "too-many-groups"
    );
    let shared = probe(&t, "shared", Some(&sets[0]))?;
    want.mean(&shared);
    assert_eq!(shared.inspect_turn()?.0, MAX_TRIGGER_GROUPS);
    want.done();
    Ok(())
}

// ---- a probe skips the rows that cannot crit -------------------------------------------------------------

const SKIP: &str = "a probe skips the rows that cannot crit";

fn save() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[crate::builder::roll::Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()
}

#[test]
fn a_save_row_beside_an_attack_by_default_of() -> T {
    let mut want = expect(
        FILE,
        &format!("{SKIP} > a save row beside an attack, by default `of`"),
    );
    let t = turn(vec![atk(sword()?), atk(save()?)], 0.0)?.observe_any_crit("crit", None)?;
    close(want.fire(&t, "crit"), 0.05, 12);
    want.done();
    Ok(())
}

#[test]
fn a_flat_payload_beside_an_attack_by_default_of() -> T {
    let mut want = expect(
        FILE,
        &format!("{SKIP} > a flat payload beside an attack, by default `of`"),
    );
    let t = turn(vec![atk(sword()?), atk(Pmf::delta(7.0, EPS)?)], 0.0)?
        .observe_any_crit("crit", None)?;
    close(want.fire(&t, "crit"), 0.05, 12);
    want.done();
    Ok(())
}

#[test]
fn the_same_turn_as_plain_data() -> T {
    let mut want = expect(FILE, &format!("{SKIP} > the same turn as plain data"));
    let spec = TurnSpec {
        attacks: vec![
            atk(sword()?),
            atk(save()?),
            atk(Pmf::delta(7.0, EPS)?),
            atk(sword()?),
        ],
        observe: Some(vec![ProbeSpec {
            id: Some("crit".to_string()),
            on: ProbeOn::AnyCrit,
            of: None,
        }]),
        ..TurnSpec::default()
    };
    let t = Turn::from_spec(spec, 0.0)?;
    close(want.fire(&t, "crit"), 1.0 - 0.95f64.powi(2), 12);
    want.done();
    Ok(())
}

#[test]
fn an_explicit_of_names_such_rows_too_and_a_probe_with_nothing_that_can_crit_reports_0() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{SKIP} > an explicit `of` names such rows too, and a probe with nothing that can crit reports 0"
        ),
    );
    let t = turn(vec![atk(sword()?), atk(save()?)], 0.0)?
        .observe_any_crit("crit", Some(&["attack 1", "attack 2"]))?;
    close(want.fire(&t, "crit"), 0.05, 12);
    let none = turn(vec![atk(sword()?), atk(save()?)], 0.0)?
        .observe_any_crit("none", Some(&["attack 2"]))?;
    assert_eq!(want.fire(&none, "none"), 0.0);
    want.mean(&none);
    assert_eq!(none.inspect_turn()?.0, 0);
    want.done();
    Ok(())
}

// ---- a probe leaves everything else the turn reports as it was, bit for bit -------------------------------

fn plain() -> R<Turn> {
    three_swords()?
        .on_first_hit_with(rs(3.0, 6.0)?, first_hit_id("sneak"))?
        .on_every_hit_with(crit_on_hit().until_next_attack(), every_chance(0.5))
}

#[test]
fn the_distribution_other_ids_and_step_stats_are_exactly_the_same_with_a_probe() -> T {
    let mut want = expect(
        FILE,
        "a probe leaves everything else the turn reports as it was, bit for bit > the distribution, other ids and stepStats are exactly the same with a probe",
    );
    let without = plain()?;
    let probed = plain()?.observe_any_crit("crit", None)?;
    assert_eq!(want.fire(&probed, "sneak"), want.fire(&without, "sneak"));
    assert_eq!(
        want.step_stats(&probed, "attack 2"),
        want.step_stats(&without, "attack 2")
    );
    assert_eq!(want.pmf(&probed).mean(), want.pmf(&without).mean());
    assert_eq!(want.pmf(&probed).variance(), want.pmf(&without).variance());
    for value in want.pmf(&without).support() {
        assert_eq!(
            want.pmf(&probed).p_at(value.0),
            want.pmf(&without).p_at(value.0),
            "p({})",
            value.0
        );
    }
    want.done();
    Ok(())
}
