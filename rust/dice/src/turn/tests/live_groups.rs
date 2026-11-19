//! `src/turn/live-groups.test.ts`: 15 tests, 58 compat calls.

use super::helpers::*;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{ConditionOptions, FirstHitOptions, advantage, keep_best_damage};
use crate::turn::types::{AttackOptions, MAX_TRIGGER_GROUPS, RiderOptions};
use crate::turn::{Turn, bounce, turn};
use std::collections::{BTreeMap, BTreeSet};

const FILE: &str = "src/turn/live-groups.test.ts";

type R<X> = Result<X, DiceError>;
type Dist = BTreeMap<i64, f64>;

// `d20+5` vs AC 12: miss 0.30, hit 0.65 (`1d8+3`), crit 0.05 (`2d8+3`).
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 12.0, rs(1.0, 8.0)?.plus(3.0)?)
}
// A Chromatic Orb: `d20+5` vs AC 17: miss 0.55, hit 0.40 (`3d8`), crit 0.05 (`6d8`).
fn orb() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 17.0, rs(3.0, 8.0)?)
}

fn from_pmf(pmf: &Pmf) -> Dist {
    pmf.support()
        .iter()
        .map(|v| (v.0 as i64, pmf.p_at(v.0)))
        .collect()
}

fn max_diff(actual: &Pmf, expected: &Dist) -> f64 {
    let mut values: BTreeSet<i64> = actual.support().iter().map(|v| v.0 as i64).collect();
    values.extend(expected.keys());
    values
        .into_iter()
        .map(|v| (actual.p_at(v as f64) - expected.get(&v).copied().unwrap_or(0.0)).abs())
        .fold(0.0, f64::max)
}

fn add(dist: &mut Dist, key: i64, mass: f64) {
    *dist.entry(key).or_insert(0.0) += mass;
}

/// Every roll of `dice` d`faces`, as the mass of each sum split by whether two dice matched.
fn brute_force_match(dice: usize, faces: usize) -> (Dist, Dist) {
    let mut matched = Dist::new();
    let mut unmatched = Dist::new();
    let total = faces.pow(dice as u32);
    for n in 0..total {
        let mut rolls = Vec::new();
        let mut rest = n;
        for _ in 0..dice {
            rolls.push(rest % faces + 1);
            rest /= faces;
        }
        let sum: usize = rolls.iter().sum();
        let distinct: BTreeSet<usize> = rolls.iter().copied().collect();
        let target = if distinct.len() < dice {
            &mut matched
        } else {
            &mut unmatched
        };
        add(target, sum as i64, 1.0 / total as f64);
    }
    (matched, unmatched)
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

fn first_hit_chance(ids: &[&str], chance: f64) -> FirstHitOptions {
    FirstHitOptions {
        condition: ConditionOptions {
            rider: rider_of(ids, None),
            chance: Some(chance),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    }
}

fn declared(id: &str, chance: Option<f64>) -> AttackOptions {
    AttackOptions {
        id: Some(id.to_string()),
        chance,
        ..AttackOptions::default()
    }
}

fn empty() -> R<Turn> {
    turn(vec![], 0.0)
}
fn bare(source: AttackBuilder) -> R<Turn> {
    turn(vec![atk(source)], 0.0)
}
fn orb_bounce(max: f64) -> R<Turn> {
    bounce(orb()?.into(), max)
}

// ---- a bounce chain keeps two groups live, however long ---------------------------------------------------

const BOUNCE: &str = "a bounce chain keeps two groups live, however long";

// Beams past the first are dice-match riders: beam i + 1 fires iff beam i's dice matched. The
// oracle is a recursion over brute-forced per-sum match masses, with no walk in it:
// chain(k) = sum over a beam's outcomes of (its damage) + (chain(k - 1) if its dice matched).
struct Beam {
    p: f64,
    damage: i64,
    matched: bool,
}

fn beam_outcomes() -> Vec<Beam> {
    let mut outcomes = vec![Beam {
        p: 0.55,
        damage: 0,
        matched: false,
    }];
    for (chance, (matched, unmatched)) in [
        (0.4, brute_force_match(3, 8)),
        (0.05, brute_force_match(6, 8)),
    ] {
        for (damage, mass) in matched {
            outcomes.push(Beam {
                p: chance * mass,
                damage,
                matched: true,
            });
        }
        for (damage, mass) in unmatched {
            outcomes.push(Beam {
                p: chance * mass,
                damage,
                matched: false,
            });
        }
    }
    outcomes
}

fn bounce_chain(outcomes: &[Beam], beams: usize) -> Dist {
    if beams == 0 {
        let mut first = Dist::new();
        for b in outcomes {
            add(&mut first, b.damage, b.p);
        }
        return first;
    }
    let rest = bounce_chain(outcomes, beams - 1);
    let mut out = Dist::new();
    for b in outcomes {
        if !b.matched {
            add(&mut out, b.damage, b.p);
            continue;
        }
        for (more, q) in &rest {
            add(&mut out, b.damage + more, b.p * q);
        }
    }
    out
}

#[test]
fn resolves_a_chain_past_the_old_budget_of_total_groups() -> T {
    let mut want = expect(
        FILE,
        &format!("{BOUNCE} > resolves a chain past the old budget of total groups"),
    );
    let outcomes = beam_outcomes();
    for max in [MAX_TRIGGER_GROUPS + 1, MAX_TRIGGER_GROUPS + 3] {
        let t = orb_bounce(max as f64)?;
        assert!(max_diff(&want.pmf(&t), &bounce_chain(&outcomes, max)) < 1e-12);
        close(want.pmf(&t).mass(), 1.0, 12);
    }
    want.done();
    Ok(())
}

#[test]
fn holds_two_live_groups_at_a_time_the_group_count_is_the_peak_not_the_number_of_beams() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{BOUNCE} > holds two live groups at a time: the group count is the peak, not the number of beams"
        ),
    );
    let one = orb_bounce(1.0)?;
    want.mean(&one);
    assert_eq!(one.inspect_turn()?.0, 1);
    for max in [2.0, 5.0, 9.0, 12.0] {
        let t = orb_bounce(max)?;
        want.mean(&t);
        assert_eq!(t.inspect_turn()?.0, 2, "max {max}");
    }
    want.done();
    Ok(())
}

#[test]
fn beam_k_fires_with_probability_p_match_to_the_k() -> T {
    let mut want = expect(
        FILE,
        &format!("{BOUNCE} > beam k fires with probability P(match)^k"),
    );
    let p_match: f64 = beam_outcomes()
        .iter()
        .filter(|b| b.matched)
        .map(|b| b.p)
        .sum();
    let t = orb_bounce(11.0)?;
    for k in [1, 4, 10, 11] {
        close(want.fire(&t, &format!("bounce {k}")), p_match.powi(k), 12);
    }
    want.done();
    Ok(())
}

// ---- groups with disjoint lives share a slot -----------------------------------------------------------------

const DISJOINT: &str = "groups with disjoint lives share a slot";

// "On a hit, a bonus attack": link k + 1 is an attack-shaped rider that fires on the first landing
// of link k, and each link's group dies after that one reader. No dice-match involved. The
// oracle is a recursion over one swing's outcomes:
// chain(k) = sum over a swing's outcomes of its damage + (chain(k - 1) if it landed).
const P_LAND: f64 = 0.7;

fn swing() -> Result<Dist, DiceError> {
    Ok(from_pmf(&sword()?.to_pmf(0.0)?))
}

fn landing_chain(swing: &Dist, links: usize, per_landing: i64) -> Dist {
    let mut out = Dist::new();
    let rest = if links == 1 {
        None
    } else {
        Some(landing_chain(swing, links - 1, per_landing))
    };
    for (&value, &mass) in swing {
        if value == 0 {
            add(&mut out, 0, mass);
            continue;
        }
        match &rest {
            Some(rest) => {
                for (more, q) in rest {
                    add(&mut out, value + per_landing + more, mass * q);
                }
            }
            None => add(&mut out, value + per_landing, mass),
        }
    }
    out
}

fn hit_chain(links: usize) -> R<Turn> {
    let mut t = bare(sword()?)?;
    let mut previous = "attack 1".to_string();
    for k in 2..=links {
        t = t.on_first_hit_with(
            sword()?,
            first_hit_of(&[&previous], Some(&format!("link {k}"))),
        )?;
        previous = format!("link {k}");
    }
    Ok(t)
}

#[test]
fn resolves_more_source_sets_than_the_budget_when_no_more_than_the_budget_are_live() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{DISJOINT} > resolves more source sets than the budget when no more than the budget are live"
        ),
    );
    let links = MAX_TRIGGER_GROUPS + 3;
    let t = hit_chain(links)?;
    assert!(max_diff(&want.pmf(&t), &landing_chain(&swing()?, links, 0)) < 1e-12);
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 2);
    for k in [2, 6, links] {
        close(
            want.fire(&t, &format!("link {k}")),
            P_LAND.powi(k as i32 - 1),
            12,
        );
    }
    want.done();
    Ok(())
}

#[test]
fn a_group_that_lives_to_the_end_shares_the_walk_with_dying_ones() -> T {
    let mut want = expect(
        FILE,
        &format!("{DISJOINT} > a group that lives to the end shares the walk with dying ones"),
    );
    // Every-hit reads its group at the final collapse, so its slot is never reused.
    let links = MAX_TRIGGER_GROUPS + 1;
    let mut ids = vec!["attack 1".to_string()];
    ids.extend((0..links - 1).map(|i| format!("link {}", i + 2)));
    let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let t = hit_chain(links)?.on_every_hit_with(
        flat(2.0)?,
        crate::turn::effects::EveryHitOptions {
            first_hit: first_hit_of(&id_refs, Some("mark")),
            max: None,
        },
    )?;
    assert!(max_diff(&want.pmf(&t), &landing_chain(&swing()?, links, 2)) < 1e-12);
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 3);
    close(want.fire(&t, "mark"), P_LAND, 12);
    want.done();
    Ok(())
}

#[test]
fn a_reused_slot_starts_from_a_group_that_has_seen_nothing() -> T {
    let mut want = expect(
        FILE,
        &format!("{DISJOINT} > a reused slot starts from a group that has seen nothing"),
    );
    // Attack i's grant is `first-hit` over attack i alone, which is "attack i landed": the
    // next attack has advantage exactly when it did. A stale code from the group before, still
    // in the slot, would read as "already landed" and skip the grant. The oracle needs no group.
    let mut grants = empty()?.attacks(6.0, sword()?)?;
    for i in 1..=5 {
        grants = grants.on_first_hit_with(
            advantage().until_next_attack(),
            first_hit_of(&[&format!("attack {i}")], None),
        )?;
    }
    let every_hit = empty()?
        .attacks(6.0, sword()?)?
        .on_every_hit_with(advantage().until_next_attack(), Default::default())?;
    let grants_pmf = want.pmf(&grants);
    let every_pmf = want.pmf(&every_hit);
    assert!(max_diff(&grants_pmf, &from_pmf(&every_pmf)) < 1e-12);
    want.mean(&grants);
    assert_eq!(grants.inspect_turn()?.0, 1);
    want.mean(&every_hit);
    assert_eq!(every_hit.inspect_turn()?.0, 0);
    want.done();
    Ok(())
}

#[test]
fn a_group_nothing_reads_is_not_live_a_grant_no_later_attack_reads_takes_no_slot() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{DISJOINT} > a group nothing reads is not live: a grant no later attack reads takes no slot"
        ),
    );
    let two = || turn(vec![atk(sword()?), atk(sword()?)], 0.0);
    let granted = two()?.on_first_hit_with(
        advantage().until_next_attack(),
        first_hit_of(&["attack 2"], None),
    )?;
    want.mean(&granted);
    assert_eq!(granted.inspect_turn()?.0, 0);
    let granted_pmf = want.pmf(&granted);
    let plain_pmf = want.pmf(&two()?);
    assert_eq!(max_diff(&granted_pmf, &from_pmf(&plain_pmf)), 0.0);
    want.done();
    Ok(())
}

// ---- a threshold substitute's look-ahead reads released slots as empty --------------------------------------

const LOOK: &str = "a threshold substitute's look-ahead reads released slots as empty";

// The substitute holds a landing only while a later step it watches can still land, which it
// decides by simulating the steps ahead over the same group codes. Attack 2 never happens, so
// nothing after attack 1 can land and the substitute must spend on any landing: exactly
// `keepBestDamage()` on attack 1. A stale code in a reused slot would let `bonus` (a rider over
// attack 2's group) look able to fire, and the substitute would hold instead.
fn low() -> Result<crate::turn::effects::Transform, DiceError> {
    keep_best_damage().if_below_split(1.0, 1.0)
}

fn two_attacks_second_never() -> R<Turn> {
    empty()?
        .attack_as(sword()?, "attack 1")?
        .attack_with(sword()?, declared("attack 2", Some(0.0)))
}

#[test]
fn across_a_step_that_does_not_fire_whose_groups_last_read_releases_the_slot() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{LOOK} > across a step that does not fire, whose group's last read releases the slot"
        ),
    );
    let t = two_attacks_second_never()?
        .on_first_miss_with(sword()?, rider_of(&["attack 1"], Some("reroll")))?
        .on_first_hit_with(sword()?, first_hit_of(&["attack 2"], Some("bonus")))?
        .on_first_hit_transform(low()?, first_hit_of(&["attack 1", "bonus"], Some("keep")))?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    // The reroll adds its own damage on a miss; the substitute only rewrites attack 1's landing.
    let rerolled = two_attacks_second_never()?
        .on_first_miss_with(sword()?, rider_of(&["attack 1"], Some("reroll")))?
        .on_first_hit_transform(
            keep_best_damage(),
            first_hit_of(&["attack 1"], Some("keep")),
        )?;
    let t_pmf = want.pmf(&t);
    let rerolled_pmf = want.pmf(&rerolled);
    assert!(max_diff(&t_pmf, &from_pmf(&rerolled_pmf)) < 1e-12);
    close(want.fire(&t, "keep"), 0.7, 12);
    want.done();
    Ok(())
}

#[test]
fn at_the_step_whose_own_group_is_released() -> T {
    let mut want = expect(
        FILE,
        &format!("{LOOK} > at the step whose own group is released"),
    );
    let oracle = two_attacks_second_never()?
        .on_first_hit_transform(keep_best_damage(), first_hit_of(&["attack 1"], None))?;
    // attack 1's grant reads its group at attack 1's own step and is done there.
    let t = two_attacks_second_never()?
        .on_first_hit_with(
            advantage().until_next_attack(),
            first_hit_of(&["attack 1"], None),
        )?
        .on_first_hit_with(sword()?, first_hit_of(&["attack 2"], Some("bonus")))?
        .on_first_hit_transform(low()?, first_hit_of(&["attack 1", "bonus"], Some("keep")))?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    let t_pmf = want.pmf(&t);
    let oracle_pmf = want.pmf(&oracle);
    assert!(max_diff(&t_pmf, &from_pmf(&oracle_pmf)) < 1e-12);
    want.done();
    Ok(())
}

#[test]
fn across_a_step_that_fires_which_releases_its_own_groups_slot() -> T {
    let mut want = expect(
        FILE,
        &format!("{LOOK} > across a step that fires, which releases its own group's slot"),
    );
    // Attacks 1 and 2 each have a grant over just themselves: two groups, one slot, each dead
    // after its own step. Attack 2 lands (or not) in the look-ahead and would leave a stale
    // "landed" code behind for `bonus`'s group, which reuses the slot.
    let grants = |t: Turn| -> R<Turn> {
        t.on_first_hit_with(
            advantage().until_next_attack(),
            first_hit_of(&["attack 1"], None),
        )?
        .on_first_hit_with(
            advantage().until_next_attack(),
            first_hit_of(&["attack 2"], None),
        )
    };
    let base = || -> R<Turn> {
        empty()?
            .attack_as(sword()?, "attack 1")?
            .attack_as(sword()?, "attack 2")?
            .attack_with(sword()?, declared("attack 3", Some(0.0)))
    };
    let t = grants(base()?)?
        .on_first_hit_with(sword()?, first_hit_of(&["attack 3"], Some("bonus")))?
        .on_first_hit_transform(low()?, first_hit_of(&["attack 1", "bonus"], Some("keep")))?;
    let spent = grants(base()?)?
        .on_first_hit_transform(keep_best_damage(), first_hit_of(&["attack 1"], None))?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    let t_pmf = want.pmf(&t);
    let spent_pmf = want.pmf(&spent);
    assert!(max_diff(&t_pmf, &from_pmf(&spent_pmf)) < 1e-12);
    want.done();
    Ok(())
}

#[test]
fn across_a_damage_rider_that_is_the_last_to_read_a_group() -> T {
    let mut want = expect(
        FILE,
        &format!("{LOOK} > across a damage rider that is the last to read a group"),
    );
    // `damage` reads attack 1's group and deals plain damage; `flurry` fires only when it did not
    // (never, once attack 1 has landed), and `follow` reads the flurry's group, in the same slot.
    let chain = || -> R<Turn> {
        bare(sword()?)?
            .on_first_hit_with(flat(1.0)?, first_hit_of(&["attack 1"], Some("damage")))?
            .otherwise_with(sword()?, rid("flurry"))?
            .on_first_hit_with(sword()?, first_hit_of(&["flurry"], Some("follow")))
    };
    let t = chain()?
        .on_first_hit_transform(low()?, first_hit_of(&["attack 1", "follow"], Some("keep")))?;
    let spent = chain()?.on_first_hit_transform(
        keep_best_damage(),
        first_hit_of(&["attack 1", "follow"], None),
    )?;
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    let t_pmf = want.pmf(&t);
    let spent_pmf = want.pmf(&spent);
    assert!(max_diff(&t_pmf, &from_pmf(&spent_pmf)) < 1e-12);
    want.done();
    Ok(())
}

// ---- turns that fit the old cap are bit for bit what the walk gave before groups shared slots --------------

const PINNED: &str =
    "turns that fit the old cap are bit for bit what the walk gave before groups shared slots";

// Recorded from 6a6233f (#20: 0.14.2 plus content-addressed PMF identifiers): the same turns, before groups shared slots.
fn pin(want: &mut impl Reads, t: &Turn, mean: f64, variance: f64, p0: f64) {
    assert_eq!(want.pmf(t).mean(), mean);
    assert_eq!(want.pmf(t).variance(), variance);
    assert_eq!(want.pmf(t).p_at(0.0), p0);
}

#[test]
fn a_9_beam_bounce_chain() -> T {
    let mut want = expect(FILE, &format!("{PINNED} > a 9-beam bounce chain"));
    let t = orb_bounce(9.0)?;
    pin(&mut want, &t, 8.268560386709098, 138.0756075547243, 0.55);
    // fireProbability reads the mass walk, to 1e-12 of 0.16's.
    close(want.fire(&t, "bounce 1"), 0.1836547851562501, 12);
    close(want.fire(&t, "bounce 9"), 2.3769510383393754e-7, 12);
    want.done();
    Ok(())
}

#[test]
fn nine_overlapping_first_hit_groups_over_four_attacks() -> T {
    let mut want = expect(
        FILE,
        &format!("{PINNED} > nine overlapping first-hit groups, over four attacks"),
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
    let mut t = turn(
        vec![atk(sword()?), atk(sword()?), atk(sword()?), atk(sword()?)],
        0.0,
    )?;
    for (i, set) in sets.iter().take(MAX_TRIGGER_GROUPS).enumerate() {
        t = t.on_first_hit_with(
            rs(1.0, 6.0)?,
            first_hit_of(set, Some(&format!("group {}", i + 1))),
        )?;
    }
    pin(
        &mut want,
        &t,
        49.69874999999998,
        250.84099843749993,
        0.008100000000000008,
    );
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, MAX_TRIGGER_GROUPS);
    want.done();
    Ok(())
}

#[test]
fn a_reroll_per_attack_with_a_threshold_substitute_reading_the_walk_ahead() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{PINNED} > a reroll per attack, with a threshold substitute reading the walk ahead"
        ),
    );
    // The substitute's look-ahead simulates the later steps' group codes, across the slot reuse.
    let mut t = empty()?.attacks(5.0, sword()?)?;
    for i in 1..=4 {
        t = t.on_first_miss_with(
            sword()?,
            rider_of(&[&format!("attack {i}")], Some(&format!("re {i}"))),
        )?;
    }
    t = t.on_first_hit_transform(
        keep_best_damage().if_below_split(9.0, 20.0)?,
        FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    id: Some("keep".to_string()),
                    ..RiderOptions::default()
                },
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
    )?;
    pin(
        &mut want,
        &t,
        35.899652185697796,
        63.87095718219878,
        0.000019683,
    );
    // fireProbability reads the mass walk, to 1e-12 of 0.16's.
    close(want.fire(&t, "keep"), 0.9917782308532256, 12);
    want.mean(&t);
    assert_eq!(t.inspect_turn()?.0, 1);
    want.done();
    Ok(())
}

#[test]
fn grants_over_disjoint_source_sets_half_of_them_behind_a_save() -> T {
    let mut want = expect(
        FILE,
        &format!("{PINNED} > grants over disjoint source sets, half of them behind a save"),
    );
    let mut t = empty()?.attacks(6.0, sword()?)?;
    for i in 1..=5 {
        t = t.on_first_hit_with(
            advantage().until_next_attack(),
            first_hit_chance(
                &[&format!("attack {i}")],
                if i % 2 == 1 { 1.0 } else { 0.5 },
            ),
        )?;
    }
    pin(
        &mut want,
        &t,
        38.45982264174283,
        113.43905373544192,
        0.0007289999999999989,
    );
    want.done();
    Ok(())
}
