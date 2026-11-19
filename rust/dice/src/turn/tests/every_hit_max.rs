//! `src/turn/every-hit-max.test.ts`: 67 tests, 372 compat calls.
//!
//! Not translated: every-hit-max.test.ts:1153-1161 (`refuses a max on any other trigger`): a
//! `max` on a first-hit rider, on `onFirstHit` or on a chained `onAnyCrit` is a TS type error
//! (`@ts-expect-error`); `Trigger::FirstHit`, `FirstHitOptions` and `ConditionOptions` have no
//! `max` field in Rust, so the call cannot be written.
//! Not translated: every-hit-max.test.ts:1194-1202 (`refuses a payload per source on a trigger
//! that takes none`): `perSource` on an any-crit spec rider or on `onAnyCrit` is a TS type error;
//! `Trigger::AnyCrit` and `ConditionOptions` have no `per_source` field in Rust.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::save::SaveBuilder;
use crate::error::DiceError;
use crate::pmf::mixture::Mixture;
use crate::turn::compat::Expected;
use crate::turn::effects::{EveryHitOptions, FirstHitOptions, advantage, keep_best_damage};
use crate::turn::types::AttacksOptions;
use crate::turn::types::{
    Attack, AttackOptions, DamageSource, MAX_CAPPED_COUNTERS, MAX_TRIGGER_GROUPS, PerSource, Rider,
    RiderDamage, RiderDamageSpec, RiderOptions, RiderPayload, SaveLanding, Trigger, TurnSpec,
};
use crate::turn::{Turn, bounce, turn};
use crate::{EPS, Pmf};
use std::collections::BTreeMap;

const FILE: &str = "src/turn/every-hit-max.test.ts";

fn name(test: &str) -> String {
    format!("onEveryHit max: an exact cap on applications > {test}")
}

type R = Result<Turn, DiceError>;

// --- an oracle that shares no code with the walk -------------------------------------------------
// A distribution is a plain map; nothing below touches Pmf arithmetic. It enumerates every outcome
// sequence of the attacks (miss, hit, crit, or "did not happen") and applies each capped rider to
// the first `max` landings in turn order.

type Dist = BTreeMap<i64, f64>;

fn point(value: i64) -> Dist {
    Dist::from([(value, 1.0)])
}

fn convolve(a: &Dist, b: &Dist) -> Dist {
    let mut out = Dist::new();
    for (x, p) in a {
        for (y, q) in b {
            *out.entry(x + y).or_insert(0.0) += p * q;
        }
    }
    out
}

fn scaled(dist: &Dist, by: f64) -> Dist {
    dist.iter().map(|(v, p)| (*v, p * by)).collect()
}

fn add_into(into: &mut Dist, dist: &Dist) {
    for (v, p) in dist {
        *into.entry(*v).or_insert(0.0) += p;
    }
}

/// `count` dice with `sides` faces plus a flat bonus.
fn dice(count: usize, sides: i64, bonus: i64) -> Dist {
    let mut dist = point(bonus);
    for _ in 0..count {
        let face: Dist = (1..=sides).map(|k| (k, 1.0 / sides as f64)).collect();
        dist = convolve(&dist, &face);
    }
    dist
}

#[derive(Clone, Copy)]
struct Odds {
    hit: f64,
    crit: f64,
}

#[derive(Clone)]
struct OracleAttack {
    odds: Odds,
    hit_damage: Dist,
    crit_damage: Dist,
    /// Chance the attack happens at all.
    chance: f64,
    /// Odds when the attack before it landed, for a grant of advantage on the next attack.
    after_landing: Option<Odds>,
}

struct Payload {
    hit: Dist,
    crit: Dist,
}

struct OracleRider {
    /// Indices of the attacks it watches.
    of: Vec<usize>,
    /// Applies to at most this many landings; unlimited when `None`.
    max: Option<usize>,
    /// The payload when attack `index` lands.
    payload: Box<dyn Fn(usize) -> Payload>,
}

const MISS: u8 = 0;
const HIT: u8 = 1;
const CRIT: u8 = 2;
const NONE: u8 = 3;

/// d20 + `bonus` against `ac`: a natural 20 crits, a natural 1 misses.
fn odds(bonus: i64, ac: i64) -> Odds {
    let mut hit = 0.0;
    for face in 2..=19 {
        if face + bonus >= ac {
            hit += 1.0 / 20.0;
        }
    }
    Odds {
        hit,
        crit: 1.0 / 20.0,
    }
}

/// The same roll with advantage: the better of two d20s.
fn advantage_odds(bonus: i64, ac: i64) -> Odds {
    let Odds { hit, crit } = odds(bonus, ac);
    let miss = 1.0 - hit - crit;
    Odds {
        hit: 1.0 - miss.powi(2) - (1.0 - (1.0 - crit).powi(2)),
        crit: 1.0 - (1.0 - crit).powi(2),
    }
}

fn oracle_attack(odds: Odds, hit_damage: Dist, crit_damage: Dist) -> OracleAttack {
    OracleAttack {
        odds,
        hit_damage,
        crit_damage,
        chance: 1.0,
        after_landing: None,
    }
}

fn sword_oracle() -> OracleAttack {
    oracle_attack(odds(7, 15), dice(1, 8, 4), dice(2, 8, 4))
}

/// The sword when a landing before it grants advantage on the next attack.
fn advantaged_oracle() -> OracleAttack {
    OracleAttack {
        after_landing: Some(advantage_odds(7, 15)),
        ..sword_oracle()
    }
}

fn knife_oracle() -> OracleAttack {
    oracle_attack(odds(5, 14), dice(1, 6, 3), dice(2, 6, 3))
}

fn chancy(attack: OracleAttack, chance: f64) -> OracleAttack {
    OracleAttack { chance, ..attack }
}

/// A payload that doubles its dice on a crit.
fn doubling(count: usize, sides: i64) -> Payload {
    Payload {
        hit: dice(count, sides, 0),
        crit: dice(2 * count, sides, 0),
    }
}

fn rider_of(
    of: &[usize],
    max: Option<usize>,
    payload: impl Fn(usize) -> Payload + 'static,
) -> OracleRider {
    OracleRider {
        of: of.to_vec(),
        max,
        payload: Box::new(payload),
    }
}

fn in_order(outcomes: &[u8]) -> Vec<usize> {
    (0..outcomes.len()).collect()
}

fn oracle(attacks: &[OracleAttack], riders: &[OracleRider]) -> Dist {
    oracle_ordered(attacks, riders, &in_order)
}

fn oracle_ordered(
    attacks: &[OracleAttack],
    riders: &[OracleRider],
    order: &dyn Fn(&[u8]) -> Vec<usize>,
) -> Dist {
    let mut total = Dist::new();
    walk(attacks, riders, order, &mut Vec::new(), 1.0, &mut total);
    total
}

fn walk(
    attacks: &[OracleAttack],
    riders: &[OracleRider],
    order: &dyn Fn(&[u8]) -> Vec<usize>,
    outcomes: &mut Vec<u8>,
    probability: f64,
    total: &mut Dist,
) {
    if outcomes.len() == attacks.len() {
        let mut damage = point(0);
        let mut applied = vec![0usize; riders.len()];
        for index in order(outcomes) {
            let outcome = outcomes[index];
            if outcome != HIT && outcome != CRIT {
                continue;
            }
            let own = &attacks[index];
            damage = convolve(
                &damage,
                if outcome == HIT {
                    &own.hit_damage
                } else {
                    &own.crit_damage
                },
            );
            for (r, rider) in riders.iter().enumerate() {
                if !rider.of.contains(&index) {
                    continue;
                }
                if rider.max.is_some_and(|max| applied[r] >= max) {
                    continue;
                }
                applied[r] += 1;
                let payload = (rider.payload)(index);
                damage = convolve(
                    &damage,
                    if outcome == HIT {
                        &payload.hit
                    } else {
                        &payload.crit
                    },
                );
            }
        }
        for (value, p) in damage {
            *total.entry(value).or_insert(0.0) += p * probability;
        }
        return;
    }
    let index = outcomes.len();
    let attack = &attacks[index];
    let landed_before = index > 0 && matches!(outcomes[index - 1], HIT | CRIT);
    let own = match attack.after_landing {
        Some(after) if landed_before => after,
        _ => attack.odds,
    };
    let chance = attack.chance;
    let branches = [
        (MISS, chance * (1.0 - own.hit - own.crit)),
        (HIT, chance * own.hit),
        (CRIT, chance * own.crit),
        (NONE, 1.0 - chance),
    ];
    for (outcome, p) in branches {
        if p > 0.0 {
            outcomes.push(outcome);
            walk(attacks, riders, order, outcomes, probability * p, total);
            outcomes.pop();
        }
    }
}

fn support_of(pmf: &Pmf) -> Vec<i64> {
    pmf.support().iter().map(|d| d.0 as i64).collect()
}

#[track_caller]
fn expect_matches(actual: &Pmf, expected: &Dist, tolerance: f64) {
    let mut support = support_of(actual);
    support.extend(expected.keys());
    let mut worst = 0.0f64;
    for value in support {
        let want = expected.get(&value).copied().unwrap_or(0.0);
        worst = worst.max((actual.p_at(value as f64) - want).abs());
    }
    assert!(worst < tolerance, "worst difference {worst} >= {tolerance}");
}

fn max_diff(a: &Pmf, b: &Pmf) -> f64 {
    let mut support = support_of(a);
    support.extend(support_of(b));
    let mut worst = 0.0f64;
    for value in support {
        worst = worst.max((a.p_at(value as f64) - b.p_at(value as f64)).abs());
    }
    worst
}

fn bins(pmf: &Pmf) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = pmf.bins().iter().map(|(d, b)| (d.0, b.p)).collect();
    out.sort_by(|x, y| x.0.total_cmp(&y.0));
    out
}

// --- the sources ---------------------------------------------------------------------------------

/// d20+7 vs AC 15, 1d8+4 (hit 0.6, crit 0.05).
fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(7.0, 15.0, d8().plus(4.0)?)
}

/// d20+5 vs AC 14, 1d6+3 (hit 0.55, crit 0.05).
fn knife() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 14.0, d6().plus(3.0)?)
}

fn swords(n: usize) -> Result<Vec<Attack>, DiceError> {
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(atk(sword()?));
    }
    Ok(out)
}

fn mk(attacks: Vec<Attack>) -> R {
    turn(attacks, 0.0)
}

fn empty() -> R {
    mk(Vec::new())
}

/// `turn().attacks(count, sword)`.
fn n_swords(count: usize) -> Result<Turn, Box<dyn std::error::Error>> {
    Ok(empty()?.attacks(count as f64, sword()?)?)
}

/// `roll(count, die)`.
fn dice_of(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn rd(damage: impl Into<RiderDamage>) -> RiderDamage {
    damage.into()
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

/// `perSource`: `(source, damage, critDamage)` in key order.
fn per(entries: Vec<(&str, RiderDamage, Option<RiderDamage>)>) -> PerSource {
    entries
        .into_iter()
        .map(|(id, damage, crit_damage)| {
            (
                id.to_string(),
                RiderPayload {
                    damage,
                    crit_damage,
                },
            )
        })
        .collect()
}

/// The option fields every-hit and first-hit riders share.
trait Opts: Sized {
    fn rider_mut(&mut self) -> &mut RiderOptions;
    fn per_source_mut(&mut self) -> &mut Option<PerSource>;

    fn id(mut self, id: &str) -> Self {
        self.rider_mut().id = Some(id.to_string());
        self
    }
    fn of(mut self, of: &[&str]) -> Self {
        self.rider_mut().of = Some(strs(of));
        self
    }
    fn crit(mut self, crit: RiderDamage) -> Self {
        self.rider_mut().crit_damage = Some(crit);
        self
    }
    fn landing(mut self, landing: SaveLanding) -> Self {
        self.rider_mut().landing = Some(landing);
        self
    }
    fn per_source(mut self, per_source: PerSource) -> Self {
        *self.per_source_mut() = Some(per_source);
        self
    }
}

impl Opts for EveryHitOptions {
    fn rider_mut(&mut self) -> &mut RiderOptions {
        &mut self.first_hit.condition.rider
    }
    fn per_source_mut(&mut self) -> &mut Option<PerSource> {
        &mut self.first_hit.per_source
    }
}

impl Opts for FirstHitOptions {
    fn rider_mut(&mut self) -> &mut RiderOptions {
        &mut self.condition.rider
    }
    fn per_source_mut(&mut self) -> &mut Option<PerSource> {
        &mut self.per_source
    }
}

trait Capped: Sized {
    fn max(self, max: f64) -> Self;
}

impl Capped for EveryHitOptions {
    fn max(mut self, max: f64) -> Self {
        self.max = Some(max);
        self
    }
}

fn every() -> EveryHitOptions {
    EveryHitOptions::default()
}

fn first() -> FirstHitOptions {
    FirstHitOptions::default()
}

/// The refusal of a call: its code and message.
#[track_caller]
fn refusal(result: R) -> (String, String) {
    match result {
        Err(DiceError::TurnSpec(e)) => (e.code.as_str().to_string(), e.message),
        Err(other) => panic!("expected a TurnSpecError, got {other:?}"),
        Ok(_) => panic!("expected a refusal, the call succeeded"),
    }
}

#[track_caller]
fn assert_refused(result: R, code: &str, message: &str) {
    let (got, text) = refusal(result);
    assert_eq!(got, code);
    assert!(text.contains(message), "message {text:?} lacks {message:?}");
}

/// `expect(() => ...).toThrow(/message/)`: any error whose message contains `message`.
#[track_caller]
fn assert_throws(result: R, message: &str) {
    match result {
        Err(e) => assert!(
            e.message().contains(message),
            "message {:?} lacks {message:?}",
            e.message()
        ),
        Ok(_) => panic!("expected an error, the call succeeded"),
    }
}

#[track_caller]
fn assert_code(result: R, code: &str) {
    assert_eq!(code_of(result), code);
}

fn rider_spec(trigger: Trigger, id: Option<&str>, damage: impl Into<RiderDamage>) -> Rider {
    Rider {
        trigger,
        id: id.map(str::to_string),
        damage: RiderDamageSpec::Plain(damage.into()),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

fn spec_turn(attacks: Vec<Attack>, riders: Vec<Rider>) -> R {
    Turn::from_spec(
        TurnSpec {
            attacks,
            riders: Some(riders),
            ..TurnSpec::default()
        },
        0.0,
    )
}

// --- hand-computed: at most 2 over 3 attacks, with crits ---------------------------------------

/// Each attack: hit 1/2 for 1, crit 1/4 for 2, miss 1/4. The rider adds 10 on a hit and 30 on a
/// crit, to the first two landings only.
fn hand_capped() -> Result<Turn, Box<dyn std::error::Error>> {
    let attack = Mixture::mix(
        &[
            ("hit", &Pmf::delta(1.0, EPS)?, 0.5),
            ("crit", &Pmf::delta(2.0, EPS)?, 0.25),
            ("missNone", &Pmf::delta(0.0, EPS)?, 0.25),
        ],
        EPS,
    )?;
    let options = every().id("dice").max(2.0).crit(rd(Pmf::delta(30.0, EPS)?));
    Ok(
        mk(vec![atk(attack.clone()), atk(attack.clone()), atk(attack)])?
            .on_every_hit_with(Pmf::delta(10.0, EPS)?, options)?,
    )
}

#[test]
fn hand_computed_prices_each_ordering_of_landings_by_which_two_the_rider_reaches() -> T {
    let mut want = expect(
        FILE,
        &name(
            "hand-computed: at most 2 over 3 attacks, with crits > prices each ordering of landings by which two the rider reaches",
        ),
    );
    let pmf = want.pmf(&hand_capped()?);
    // MMM: 0.
    close(pmf.p_at(0.0), 1.0 / 64.0, 14);
    // One landing, a hit: 1 + 10. Three positions, two misses.
    close(pmf.p_at(11.0), 3.0 * 0.5 * 0.25 * 0.25, 14);
    // HHH: base 3, the rider on the first two hits only: 3 + 20.
    close(pmf.p_at(23.0), 0.125, 14);
    // HHC: 4 + 10 + 10 (the crit is third).
    close(pmf.p_at(24.0), 0.0625, 14);
    // HCH and CHH: the crit is among the first two landings, 4 + 10 + 30.
    close(pmf.p_at(44.0), 0.125, 14);
    close(pmf.mass(), 1.0, 14);
    want.done();
    Ok(())
}

#[test]
fn hand_computed_reports_p_applied_at_least_once_and_the_expected_applications() -> T {
    let mut want = expect(
        FILE,
        &name(
            "hand-computed: at most 2 over 3 attacks, with crits > reports P(applied at least once) and the expected applications",
        ),
    );
    let capped = hand_capped()?;
    // P(some landing) = 1 - (1/4)^3.
    close(want.fire(&capped, "dice"), 63.0 / 64.0, 14);
    // K landings ~ Bin(3, 3/4): E[min(K, 2)] = P(K = 1) + 2 P(K >= 2).
    close(
        want.applications(&capped, "dice"),
        9.0 / 64.0 + 2.0 * (27.0 / 64.0 + 27.0 / 64.0),
        14,
    );
    want.done();
    Ok(())
}

#[test]
fn hand_computed_has_the_mean_of_its_parts() -> T {
    let mut want = expect(
        FILE,
        &name(
            "hand-computed: at most 2 over 3 attacks, with crits > has the mean of its parts: base plus applications times a landing's payload",
        ),
    );
    let capped = hand_capped()?;
    let per_landing = (2.0 / 3.0) * 10.0 + (1.0 / 3.0) * 30.0;
    let mean = want.mean(&capped);
    close(
        mean,
        3.0 * 1.0 + want.applications(&capped, "dice") * per_landing,
        12,
    );
    want.done();
    Ok(())
}

// --- against the enumeration oracle ------------------------------------------------------------

fn identical_attacks(attacks: usize, max: usize) -> T {
    let mut want = expect(
        FILE,
        &name(&format!(
            "against the enumeration oracle > {attacks} identical attacks, at most {max}"
        )),
    );
    let actual =
        n_swords(attacks)?.on_every_hit_with(dice_of(3.0, d6())?, every().max(max as f64))?;
    let all: Vec<usize> = (0..attacks).collect();
    let expected = oracle(
        &vec![sword_oracle(); attacks],
        &[rider_of(&all, Some(max), |_| doubling(3, 6))],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

macro_rules! oracle_cases {
    ($($test:ident: $attacks:expr, $max:expr;)*) => {
        $(#[test] fn $test() -> T { identical_attacks($attacks, $max) })*
    };
}

oracle_cases! {
    oracle_3_identical_attacks_at_most_2: 3, 2;
    oracle_4_identical_attacks_at_most_1: 4, 1;
    oracle_4_identical_attacks_at_most_2: 4, 2;
    oracle_4_identical_attacks_at_most_3: 4, 3;
    oracle_5_identical_attacks_at_most_2: 5, 2;
    oracle_5_identical_attacks_at_most_4: 5, 4;
}

fn four_mixed() -> Result<Vec<Attack>, DiceError> {
    Ok(vec![
        atk(sword()?),
        atk(knife()?),
        atk(sword()?),
        atk(knife()?),
    ])
}

fn four_mixed_oracle() -> Vec<OracleAttack> {
    vec![
        sword_oracle(),
        knife_oracle(),
        sword_oracle(),
        knife_oracle(),
    ]
}

#[test]
fn oracle_mixed_attacks_with_different_odds_and_damage() -> T {
    let mut want = expect(
        FILE,
        &name("against the enumeration oracle > mixed attacks with different odds and damage"),
    );
    let actual = mk(four_mixed()?)?.on_every_hit_with(d10(), every().max(2.0))?;
    let expected = oracle(
        &four_mixed_oracle(),
        &[rider_of(&[0, 1, 2, 3], Some(2), |_| doubling(1, 10))],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_counts_only_the_attacks_it_watches() -> T {
    let mut want = expect(
        FILE,
        &name("against the enumeration oracle > counts only the attacks it watches"),
    );
    let actual = mk(four_mixed()?)?
        .on_every_hit_with(d10(), every().max(1.0).of(&["attack 2", "attack 4"]))?;
    let expected = oracle(
        &four_mixed_oracle(),
        &[rider_of(&[1, 3], Some(1), |_| doubling(1, 10))],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_expands_a_tag_in_of() -> T {
    let mut want = expect(
        FILE,
        &name("against the enumeration oracle > expands a tag in `of`"),
    );
    let actual = empty()?
        .attacks_with(
            3.0,
            sword()?,
            AttacksOptions {
                tag: Some("melee".to_string()),
                chance: None,
            },
        )?
        .attack_as(knife()?, "bow")?
        .on_every_hit_with(d10(), every().max(2.0).of(&["melee"]))?;
    let expected = oracle(
        &[
            sword_oracle(),
            sword_oracle(),
            sword_oracle(),
            knife_oracle(),
        ],
        &[rider_of(&[0, 1, 2], Some(2), |_| doubling(1, 10))],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

fn with_chance(source: AttackBuilder, chance: f64) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            chance: Some(chance),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

#[test]
fn oracle_does_not_count_an_attack_that_did_not_happen() -> T {
    let mut want = expect(
        FILE,
        &name("against the enumeration oracle > does not count an attack that did not happen"),
    );
    let actual = mk(vec![
        with_chance(sword()?, 0.5),
        atk(sword()?),
        with_chance(sword()?, 0.25),
    ])?
    .on_every_hit_with(d10(), every().max(1.0))?;
    let expected = oracle(
        &[
            chancy(sword_oracle(), 0.5),
            sword_oracle(),
            chancy(sword_oracle(), 0.25),
        ],
        &[rider_of(&[0, 1, 2], Some(1), |_| doubling(1, 10))],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_keeps_riders_with_different_caps_and_one_uncapped_apart() -> T {
    let mut want = expect(
        FILE,
        &name(
            "against the enumeration oracle > keeps riders with different caps, and one uncapped, apart",
        ),
    );
    let actual = mk(swords(4)?)?
        .on_every_hit_with(d10(), every().max(1.0).id("one"))?
        .on_every_hit_with(dice_of(2.0, d4())?, every().max(3.0).id("three"))?
        .on_every_hit_with(d6(), every().id("all"))?;
    let all = [0, 1, 2, 3];
    let expected = oracle(
        &vec![sword_oracle(); 4],
        &[
            rider_of(&all, Some(1), |_| doubling(1, 10)),
            rider_of(&all, Some(3), |_| doubling(2, 4)),
            rider_of(&all, None, |_| doubling(1, 6)),
        ],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    close(want.fire(&actual, "one"), 1.0 - 0.35f64.powi(4), 12);
    close(want.applications(&actual, "one"), 1.0 - 0.35f64.powi(4), 12);
    // E[min(K, 3)] with K ~ Bin(4, 0.65).
    let pk = |k: usize| -> f64 {
        [1.0, 4.0, 6.0, 4.0, 1.0][k] * 0.65f64.powi(k as i32) * 0.35f64.powi(4 - k as i32)
    };
    close(
        want.applications(&actual, "three"),
        pk(1) + 2.0 * pk(2) + 3.0 * (pk(3) + pk(4)),
        12,
    );
    close(want.applications(&actual, "all"), 4.0 * 0.65, 12);
    want.done();
    Ok(())
}

#[test]
fn oracle_gives_riders_over_different_sources_different_counters() -> T {
    let mut want = expect(
        FILE,
        &name(
            "against the enumeration oracle > gives riders over different sources different counters",
        ),
    );
    let actual = mk(swords(4)?)?
        .on_every_hit_with(
            d10(),
            every().max(1.0).of(&["attack 1", "attack 2"]).id("early"),
        )?
        .on_every_hit_with(
            d6(),
            every()
                .max(2.0)
                .of(&["attack 2", "attack 3", "attack 4"])
                .id("late"),
        )?;
    let expected = oracle(
        &vec![sword_oracle(); 4],
        &[
            rider_of(&[0, 1], Some(1), |_| doubling(1, 10)),
            rider_of(&[1, 2, 3], Some(2), |_| doubling(1, 6)),
        ],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_shares_one_counter_between_riders_with_the_same_sources_and_cap() -> T {
    let mut want = expect(
        FILE,
        &name(
            "against the enumeration oracle > shares one counter between riders with the same sources and cap",
        ),
    );
    let actual = mk(swords(3)?)?
        .on_every_hit_with(d10(), every().max(2.0))?
        .on_every_hit_with(dice_of(2.0, d4())?, every().max(2.0))?;
    let all = [0, 1, 2];
    let expected = oracle(
        &vec![sword_oracle(); 3],
        &[
            rider_of(&all, Some(2), |_| doubling(1, 10)),
            rider_of(&all, Some(2), |_| doubling(2, 4)),
        ],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_uses_an_explicit_crit_damage_on_the_landings_it_applies_to() -> T {
    let mut want = expect(
        FILE,
        &name(
            "against the enumeration oracle > uses an explicit critDamage on the landings it applies to",
        ),
    );
    let actual =
        mk(swords(3)?)?.on_every_hit_with(d10(), every().max(2.0).crit(rd(flat(25.0)?)))?;
    let expected = oracle(
        &vec![sword_oracle(); 3],
        &[rider_of(&[0, 1, 2], Some(2), |_| Payload {
            hit: dice(1, 10, 0),
            crit: point(25),
        })],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_applies_a_list_payload_as_one_application() -> T {
    let mut want = expect(
        FILE,
        &name("against the enumeration oracle > applies a list payload as one application"),
    );
    let list = RiderDamage::Many(vec![d10().into(), d4().into()]);
    let actual = mk(swords(3)?)?.on_every_hit_with(list, every().max(2.0))?;
    let expected = oracle(
        &vec![sword_oracle(); 3],
        &[rider_of(&[0, 1, 2], Some(2), |_| Payload {
            hit: convolve(&dice(1, 10, 0), &dice(1, 4, 0)),
            crit: convolve(&dice(2, 10, 0), &dice(2, 4, 0)),
        })],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

/// The turn order of two swords and a reroll of the first miss placed directly after it.
fn reroll_order(outcomes: &[u8]) -> Vec<usize> {
    if outcomes[0] == MISS {
        vec![0, 2, 1]
    } else if outcomes[1] == MISS {
        vec![0, 1, 2]
    } else {
        vec![0, 1]
    }
}

#[test]
fn oracle_follows_turn_order_through_a_reroll_that_resolves_right_after_the_miss() -> T {
    let mut want = expect(
        FILE,
        &name(
            "against the enumeration oracle > follows turn order through a reroll that resolves right after the miss",
        ),
    );
    // Two swords and a reroll of the first miss, placed directly after it: the cap of 2 counts
    // landings as sword 1, the reroll, sword 2 when sword 1 missed. The oracle draws the reroll's
    // outcome always and drops it from the turn when no sword missed.
    let actual = mk(swords(2)?)?
        .on_first_miss_with(sword()?, rid("reroll"))?
        .on_every_hit_with(
            d10(),
            every().max(2.0).of(&["attack 1", "attack 2", "reroll"]),
        )?;
    let expected = oracle_ordered(
        &[sword_oracle(), sword_oracle(), sword_oracle()],
        &[rider_of(&[0, 1, 2], Some(2), |_| doubling(1, 10))],
        &reroll_order,
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn oracle_selects_the_roll_context_and_the_cap_together() -> T {
    let mut want = expect(
        FILE,
        &name(
            "against the enumeration oracle > selects the roll context and the cap together: advantage granted by a landing",
        ),
    );
    // A landing gives the next attack advantage, and the rider covers the first two landings.
    let actual = mk(swords(3)?)?
        .on_every_hit_with(advantage().until_next_attack(), every())?
        .on_every_hit_with(d10(), every().max(2.0).id("dice"))?;
    let expected = oracle(
        &vec![advantaged_oracle(); 3],
        &[rider_of(&[0, 1, 2], Some(2), |_| doubling(1, 10))],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

// --- equal to the uncapped rider when the cap cannot bind (bit for bit) ------------------------

fn cannot_bind(attacks: usize, max: usize) -> T {
    let mut want = expect(
        FILE,
        &name(&format!(
            "equal to the uncapped rider when the cap cannot bind (bit for bit) > {attacks} attacks, max {max}"
        )),
    );
    let every_t = n_swords(attacks)?.on_every_hit_with(dice_of(3.0, d6())?, every().id("r"))?;
    let capped = n_swords(attacks)?
        .on_every_hit_with(dice_of(3.0, d6())?, every().id("r").max(max as f64))?;
    assert_eq!(bins(&want.pmf(&capped)), bins(&want.pmf(&every_t)));
    assert_eq!(want.fire(&capped, "r"), want.fire(&every_t, "r"));
    assert_eq!(
        want.applications(&capped, "r"),
        want.applications(&every_t, "r")
    );
    assert_eq!(
        want.step_stats(&capped, "attack 1"),
        want.step_stats(&every_t, "attack 1")
    );
    want.done();
    Ok(())
}

macro_rules! bind_cases {
    ($($test:ident: $attacks:expr, $max:expr;)*) => {
        $(#[test] fn $test() -> T { cannot_bind($attacks, $max) })*
    };
}

bind_cases! {
    cannot_bind_1_attacks_max_2: 1, 2;
    cannot_bind_1_attacks_max_50: 1, 50;
    cannot_bind_2_attacks_max_2: 2, 2;
    cannot_bind_2_attacks_max_3: 2, 3;
    cannot_bind_2_attacks_max_50: 2, 50;
    cannot_bind_3_attacks_max_3: 3, 3;
    cannot_bind_3_attacks_max_4: 3, 4;
    cannot_bind_3_attacks_max_50: 3, 50;
    cannot_bind_4_attacks_max_4: 4, 4;
    cannot_bind_4_attacks_max_5: 4, 5;
    cannot_bind_4_attacks_max_50: 4, 50;
}

#[test]
fn cannot_bind_with_granted_advantage_and_a_substitute_in_the_same_turn() -> T {
    let mut want = expect(
        FILE,
        &name(
            "equal to the uncapped rider when the cap cannot bind (bit for bit) > with granted advantage and a substitute in the same turn",
        ),
    );
    let build = |max: Option<f64>| -> R {
        let options = match max {
            Some(max) => every().id("r").max(max),
            None => every().id("r"),
        };
        mk(swords(3)?)?
            .on_every_hit_with(advantage().until_next_attack(), every())?
            .on_first_hit_transform(keep_best_damage().if_below_split(9.0, 15.0)?, first())?
            .on_every_hit_with(d6(), options)
    };
    let capped = build(Some(3.0))?;
    let plain = build(None)?;
    assert_eq!(bins(&want.pmf(&capped)), bins(&want.pmf(&plain)));
    want.done();
    Ok(())
}

// --- max: 1 is onFirstHit, bit for bit ---------------------------------------------------------

/// Every observable of a turn: its whole distribution, fire probabilities and step statistics.
#[derive(Debug, PartialEq)]
struct Observed {
    bins: Vec<(f64, f64)>,
    fires: Vec<f64>,
    applications: Vec<f64>,
    stats: Vec<crate::turn::StepStats>,
}

fn observe(want: &mut Expected, t: &Turn) -> Result<Observed, DiceError> {
    let bins = bins(&want.pmf(t));
    let mut fire_ids = t.rider_ids()?;
    fire_ids.extend(t.substitute_ids()?);
    fire_ids.extend(t.condition_ids()?);
    let fires = fire_ids.iter().map(|id| want.fire(t, id)).collect();
    let applications = t
        .rider_ids()?
        .iter()
        .map(|id| want.applications(t, id))
        .collect();
    let stats = t
        .attack_ids()?
        .iter()
        .map(|id| want.step_stats(t, id))
        .collect();
    Ok(Observed {
        bins,
        fires,
        applications,
        stats,
    })
}

/// The turn before the rider of each `max: 1` case.
fn max_one_base(case: usize) -> R {
    let sources = |n: usize| swords(n);
    match case {
        0 => mk(sources(3)?),
        1 => mk(vec![atk(knife()?), atk(sword()?), atk(knife()?)]),
        2 => mk(sources(3)?)
            .and_then(|t| t.on_every_hit_with(advantage().until_next_attack(), every())),
        3 => mk(sources(3)?).and_then(|t| {
            let sub = keep_best_damage().if_below_split(9.0, 15.0)?;
            t.on_first_hit_transform(sub, first())
        }),
        4 => mk(sources(2)?).and_then(|t| t.on_first_miss_with(knife()?, RiderOptions::default())),
        5 => mk(vec![with_chance(sword()?, 0.5), atk(sword()?)]),
        _ => Err(DiceError::Error(format!("no case {case}"))),
    }
}

fn max_one_case(case: usize, title: &str) -> T {
    let mut want = expect(
        FILE,
        &name(&format!("max: 1 is onFirstHit, bit for bit > {title}")),
    );
    let crit = || -> Result<RiderDamage, DiceError> { Ok(rd(flat(25.0)?)) };
    let first_t = max_one_base(case)?
        .on_first_hit_with(dice_of(3.0, d6())?, first().id("r").crit(crit()?))?;
    let capped = max_one_base(case)?
        .on_every_hit_with(dice_of(3.0, d6())?, every().id("r").crit(crit()?).max(1.0))?;
    let observed_capped = observe(&mut want, &capped)?;
    let observed_first = observe(&mut want, &first_t)?;
    assert_eq!(observed_capped, observed_first);
    want.done();
    Ok(())
}

macro_rules! max_one_cases {
    ($($test:ident: $case:expr, $title:expr;)*) => {
        $(#[test] fn $test() -> T { max_one_case($case, $title) })*
    };
}

max_one_cases! {
    max_one_several_attacks_crits_included: 0, "several attacks, crits included";
    max_one_mixed_attacks: 1, "mixed attacks";
    max_one_granted_advantage_changing_later_attack_rolls: 2, "granted advantage changing later attack rolls";
    max_one_a_threshold_substitute_beside_it: 3, "a threshold substitute beside it";
    max_one_a_first_miss_reroll: 4, "a first-miss reroll";
    max_one_an_attack_that_only_happens_sometimes: 5, "an attack that only happens sometimes";
}

#[test]
fn max_one_is_the_same_rider_in_a_spec() -> T {
    let mut want = expect(
        FILE,
        &name("max: 1 is onFirstHit, bit for bit > is the same rider in a spec"),
    );
    let first_t = spec_turn(
        swords(2)?,
        vec![rider_spec(
            Trigger::FirstHit {
                of: None,
                per_source: None,
            },
            None,
            d10(),
        )],
    )?;
    let capped = spec_turn(
        swords(2)?,
        vec![rider_spec(
            Trigger::EveryHit {
                of: None,
                max: Some(1.0),
                per_source: None,
            },
            None,
            d10(),
        )],
    )?;
    let observed_capped = observe(&mut want, &capped)?;
    assert_eq!(observed_capped, observe(&mut want, &first_t)?);
    want.done();
    Ok(())
}

#[test]
fn max_one_can_be_negated_by_otherwise_as_on_first_hit_is() -> T {
    let mut want = expect(
        FILE,
        &name("max: 1 is onFirstHit, bit for bit > can be negated by otherwise, as onFirstHit is"),
    );
    let first_t = mk(swords(2)?)?
        .on_first_hit_with(d10(), first().id("r"))?
        .otherwise_with(d4(), rid("alt"))?;
    let capped = mk(swords(2)?)?
        .on_every_hit_with(d10(), every().id("r").max(1.0))?
        .otherwise_with(d4(), rid("alt"))?;
    let observed_capped = observe(&mut want, &capped)?;
    assert_eq!(observed_capped, observe(&mut want, &first_t)?);
    close(want.fire(&capped, "alt"), 0.35f64.powi(2), 12);
    want.done();
    Ok(())
}

#[test]
fn max_one_can_be_negated_by_a_not_fired_rider_in_a_spec() -> T {
    let mut want = expect(
        FILE,
        &name("max: 1 is onFirstHit, bit for bit > can be negated by a not-fired rider in a spec"),
    );
    let riders = |capped: bool| -> Vec<Rider> {
        let trigger = if capped {
            Trigger::EveryHit {
                of: None,
                max: Some(1.0),
                per_source: None,
            }
        } else {
            Trigger::FirstHit {
                of: None,
                per_source: None,
            }
        };
        vec![
            rider_spec(trigger, Some("r"), d10()),
            rider_spec(
                Trigger::NotFired {
                    of: "r".to_string(),
                },
                None,
                d4(),
            ),
        ]
    };
    let first_t = spec_turn(swords(2)?, riders(false))?;
    let capped = spec_turn(swords(2)?, riders(true))?;
    let observed_capped = observe(&mut want, &capped)?;
    assert_eq!(observed_capped, observe(&mut want, &first_t)?);
    want.done();
    Ok(())
}

#[test]
fn max_one_can_be_watched_by_another_rider_when_it_rolls_its_own_attack() -> T {
    let mut want = expect(
        FILE,
        &name(
            "max: 1 is onFirstHit, bit for bit > can be watched by another rider, when it rolls its own attack",
        ),
    );
    let rider = |every_hit: bool| -> R {
        let t = mk(swords(2)?)?;
        let bonus = if every_hit {
            t.on_every_hit_with(knife()?, every().id("bonus").max(1.0))?
        } else {
            t.on_first_hit_with(knife()?, first().id("bonus"))?
        };
        bonus.on_every_hit_with(
            d6(),
            every().of(&["attack 1", "attack 2", "bonus"]).id("mark"),
        )
    };
    let capped = rider(true)?;
    let observed_capped = observe(&mut want, &capped)?;
    assert_eq!(observed_capped, observe(&mut want, &rider(false)?)?);
    want.done();
    Ok(())
}

#[test]
fn max_one_is_bit_for_bit_on_first_hit_when_the_arithmetic_is_exact_too() -> T {
    let mut want = expect(
        FILE,
        &name(
            "max: 1 is onFirstHit, bit for bit > is bit for bit onFirstHit when the arithmetic is exact, too",
        ),
    );
    let attack = Mixture::mix(
        &[
            ("hit", &Pmf::delta(3.0, EPS)?, 0.5),
            ("crit", &Pmf::delta(6.0, EPS)?, 0.25),
            ("missNone", &Pmf::delta(0.0, EPS)?, 0.25),
        ],
        EPS,
    )?;
    let three = || {
        vec![
            atk(attack.clone()),
            atk(attack.clone()),
            atk(attack.clone()),
        ]
    };
    let first_t = mk(three())?.on_first_hit_with(
        Pmf::delta(8.0, EPS)?,
        first().crit(rd(Pmf::delta(16.0, EPS)?)),
    )?;
    let capped = mk(three())?.on_every_hit_with(
        Pmf::delta(8.0, EPS)?,
        every().max(1.0).crit(rd(Pmf::delta(16.0, EPS)?)),
    )?;
    assert_eq!(bins(&want.pmf(&capped)), bins(&want.pmf(&first_t)));
    want.done();
    Ok(())
}

// --- the walk ----------------------------------------------------------------------------------

#[test]
fn the_walk_drops_a_count_once_the_remaining_attacks_cannot_reach_the_cap() -> T {
    let mut want = expect(
        FILE,
        &name("the walk > drops a count once the remaining attacks cannot reach the cap"),
    );
    // After the last watched attack no cap can bind, so the walk's final states are the uncapped
    // rider's: a count that split them would mean the cap still shaped a decision.
    let mut last = |t: &Turn| -> Result<usize, Box<dyn std::error::Error>> {
        want.mean(t);
        let (_, counts) = t.inspect_turn()?;
        counts
            .last()
            .copied()
            .ok_or_else(|| DiceError::error("no state counts").into())
    };
    let every_last = last(&n_swords(6)?.on_every_hit_with(d6(), every())?)?;
    for max in [2.0, 4.0, 5.0] {
        assert_eq!(
            last(&n_swords(6)?.on_every_hit_with(d6(), every().max(max))?)?,
            every_last
        );
    }
    want.done();
    Ok(())
}

// --- a payload per landing source --------------------------------------------------------------

fn name_p(test: &str) -> String {
    name(&format!("a payload per landing source > {test}"))
}

fn fire_damage() -> RollBuilder {
    d10()
}

fn cold_damage() -> Result<RollBuilder, DiceError> {
    dice_of(2.0, d4())
}

#[test]
fn per_source_deals_each_sources_own_payload_with_its_own_crit_default() -> T {
    let mut want = expect(
        FILE,
        &name_p("deals each source's own payload, with its own crit default"),
    );
    let actual = mk(vec![atk(sword()?), atk(knife()?), atk(sword()?)])?.on_every_hit_with(
        d6(),
        every().max(2.0).per_source(per(vec![
            ("attack 2", rd(fire_damage()), None),
            ("attack 3", rd(cold_damage()?), None),
        ])),
    )?;
    let expected = oracle(
        &[sword_oracle(), knife_oracle(), sword_oracle()],
        &[rider_of(&[0, 1, 2], Some(2), |index| match index {
            0 => doubling(1, 6),
            1 => doubling(1, 10),
            _ => doubling(2, 4),
        })],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

fn forty_on_two(index: usize) -> Payload {
    if index == 1 {
        Payload {
            hit: dice(1, 10, 0),
            crit: point(40),
        }
    } else {
        doubling(1, 6)
    }
}

#[test]
fn per_source_is_a_first_hit_payload_per_landing_source_with_max_1() -> T {
    let mut want = expect(
        FILE,
        &name_p("is a first-hit payload per landing source with max: 1"),
    );
    let actual = mk(vec![atk(sword()?), atk(knife()?), atk(sword()?)])?.on_every_hit_with(
        d6(),
        every().max(1.0).per_source(per(vec![(
            "attack 2",
            rd(fire_damage()),
            Some(rd(flat(40.0)?)),
        )])),
    )?;
    let expected = oracle(
        &[sword_oracle(), knife_oracle(), sword_oracle()],
        &[rider_of(&[0, 1, 2], Some(1), forty_on_two)],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn per_source_works_without_a_cap() -> T {
    let mut want = expect(
        FILE,
        &name_p("works without a cap: a payload per row for an every-hit rider"),
    );
    let actual = mk(vec![atk(sword()?), atk(knife()?)])?.on_every_hit_with(
        d6(),
        every().per_source(per(vec![("attack 2", rd(fire_damage()), None)])),
    )?;
    let expected = oracle(
        &[sword_oracle(), knife_oracle()],
        &[rider_of(&[0, 1], None, |index| {
            if index == 1 {
                doubling(1, 10)
            } else {
                doubling(1, 6)
            }
        })],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn per_source_first_hit_equals_the_plain_first_hit_when_every_payload_is_the_same() -> T {
    let mut want = expect(
        FILE,
        &name_p(
            "first-hit with a payload per source equals the plain first hit when every payload is the same",
        ),
    );
    let plain = mk(swords(3)?)?.on_first_hit_with(d6(), first().id("r"))?;
    let same = mk(swords(3)?)?.on_first_hit_with(
        d6(),
        first().id("r").per_source(per(vec![
            ("attack 2", rd(d6()), None),
            ("attack 3", rd(d6()), None),
        ])),
    )?;
    assert!(max_diff(&want.pmf(&same), &want.pmf(&plain)) < 1e-15);
    close(want.fire(&same, "r"), want.fire(&plain, "r"), 15);
    let negated = |t: &Turn| -> R { t.otherwise_with(d4(), rid("alt")) };
    let negated_same = negated(&same)?;
    let negated_plain = negated(&plain)?;
    assert!(max_diff(&want.pmf(&negated_same), &want.pmf(&negated_plain)) < 1e-15);
    close(
        want.fire(&negated_same, "alt"),
        want.fire(&negated_plain, "alt"),
        15,
    );
    want.done();
    Ok(())
}

#[test]
fn per_source_first_hit_is_one_rider() -> T {
    let mut want = expect(
        FILE,
        &name_p(
            "a per-source first hit is one rider: fireProbability, expectedApplications, otherwise",
        ),
    );
    let first_t = mk(vec![atk(sword()?), atk(knife()?), atk(sword()?)])?.on_first_hit_with(
        d6(),
        first()
            .id("first")
            .per_source(per(vec![("attack 2", rd(fire_damage()), None)])),
    )?;
    let p_some = 1.0 - 0.35 * 0.4 * 0.35;
    close(want.fire(&first_t, "first"), p_some, 12);
    let applications = want.applications(&first_t, "first");
    assert_eq!(applications, want.fire(&first_t, "first"));
    let either = first_t.otherwise_with(d4(), rid("none"))?;
    close(want.fire(&either, "none"), 1.0 - p_some, 12);
    want.done();
    Ok(())
}

#[test]
fn per_source_first_hit_takes_a_payload_per_source_in_the_chained_and_the_spec_spelling() -> T {
    let mut want = expect(
        FILE,
        &name_p("first-hit takes a payload per source, in the chained and the spec spelling"),
    );
    let sources = || -> Result<Vec<Attack>, DiceError> {
        Ok(vec![atk(sword()?), atk(knife()?), atk(sword()?)])
    };
    let payloads = || -> Result<PerSource, DiceError> {
        Ok(per(vec![(
            "attack 2",
            rd(fire_damage()),
            Some(rd(flat(40.0)?)),
        )]))
    };
    let chained = mk(sources()?)?.on_first_hit_with(d6(), first().per_source(payloads()?))?;
    let spec = spec_turn(
        sources()?,
        vec![rider_spec(
            Trigger::FirstHit {
                of: None,
                per_source: Some(payloads()?),
            },
            None,
            d6(),
        )],
    )?;
    let expected = oracle(
        &[sword_oracle(), knife_oracle(), sword_oracle()],
        &[rider_of(&[0, 1, 2], Some(1), forty_on_two)],
    );
    expect_matches(&want.pmf(&chained), &expected, 1e-12);
    assert_eq!(bins(&want.pmf(&spec)), bins(&want.pmf(&chained)));
    want.done();
    Ok(())
}

#[test]
fn per_source_first_hit_beside_a_granted_advantage_that_changes_later_attack_rolls() -> T {
    let mut want = expect(
        FILE,
        &name_p(
            "a per-source first hit beside a granted advantage that changes later attack rolls",
        ),
    );
    let actual = mk(vec![atk(sword()?), atk(knife()?), atk(sword()?)])?
        .on_every_hit_with(advantage().until_next_attack(), every())?
        .on_first_hit_with(
            d6(),
            first().per_source(per(vec![("attack 2", rd(fire_damage()), None)])),
        )?;
    let shifted = |attack: OracleAttack| OracleAttack {
        after_landing: Some(advantage_odds(7, 15)),
        ..attack
    };
    let expected = oracle(
        &[
            shifted(sword_oracle()),
            OracleAttack {
                after_landing: Some(advantage_odds(5, 14)),
                ..knife_oracle()
            },
            shifted(sword_oracle()),
        ],
        &[rider_of(&[0, 1, 2], Some(1), |index| {
            if index == 1 {
                doubling(1, 10)
            } else {
                doubling(1, 6)
            }
        })],
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

#[test]
fn per_source_follows_turn_order_through_a_first_miss_reroll() -> T {
    let mut want = expect(
        FILE,
        &name_p("follows turn order through a first-miss reroll"),
    );
    let actual = mk(swords(2)?)?
        .on_first_miss_with(sword()?, rid("reroll"))?
        .on_first_hit_with(
            d10(),
            first()
                .of(&["attack 1", "attack 2", "reroll"])
                .per_source(per(vec![(
                    "reroll",
                    rd(flat(100.0)?),
                    Some(rd(flat(100.0)?)),
                )])),
        )?;
    let expected = oracle_ordered(
        &[sword_oracle(), sword_oracle(), sword_oracle()],
        &[rider_of(&[0, 1, 2], Some(1), |index| {
            if index == 2 {
                Payload {
                    hit: point(100),
                    crit: point(100),
                }
            } else {
                doubling(1, 10)
            }
        })],
        &reroll_order,
    );
    expect_matches(&want.pmf(&actual), &expected, 1e-12);
    want.done();
    Ok(())
}

// An any-miss reroll resolves after every declared attack, so an ordered rider cannot watch it.

fn reroll_of() -> [&'static str; 3] {
    ["attack 1", "attack 2", "reroll"]
}

#[test]
fn any_miss_reroll_refuses_a_first_hit_payload_per_source() -> T {
    let base = || -> R {
        mk(vec![atk(sword()?), atk(knife()?)])?.on_any_miss_with(sword()?, rid("reroll"))
    };
    let build = base()?.on_every_hit_with(
        flat(1.0)?,
        every().of(&reroll_of()).max(1.0).per_source(per(vec![(
            "attack 2",
            rd(flat(100.0)?),
            None,
        )])),
    );
    assert_refused(build, "unsupported-trigger", "onFirstMiss");
    let first_t = base()?.on_first_hit_with(
        flat(1.0)?,
        first()
            .of(&reroll_of())
            .per_source(per(vec![("attack 2", rd(flat(100.0)?), None)])),
    );
    assert_code(first_t, "unsupported-trigger");
    Ok(())
}

#[test]
fn any_miss_reroll_refuses_a_cap_that_can_bind() -> T {
    let build = |max: f64| -> R {
        mk(vec![atk(sword()?), atk(sword()?), atk(knife()?)])?
            .on_any_miss_with(sword()?, rid("reroll"))?
            .on_every_hit_with(
                d6(),
                every()
                    .of(&["attack 1", "attack 2", "reroll", "attack 3"])
                    .max(max),
            )
    };
    assert_code(build(2.0), "unsupported-trigger");
    assert_code(build(3.0), "unsupported-trigger");
    Ok(())
}

#[test]
fn any_miss_reroll_allows_what_does_not_read_the_order() -> T {
    let base = || -> R {
        mk(vec![atk(sword()?), atk(knife()?)])?.on_any_miss_with(sword()?, rid("reroll"))
    };
    base()?.on_every_hit_with(d6(), every().of(&reroll_of()))?;
    base()?.on_every_hit_with(d6(), every().of(&reroll_of()).max(3.0))?;
    base()?.on_every_hit_with(
        d6(),
        every()
            .of(&reroll_of())
            .per_source(per(vec![("attack 2", rd(d8()), None)])),
    )?;
    base()?.on_every_hit_with(d6(), every().of(&reroll_of()).max(1.0))?;
    base()?.on_first_hit_with(d6(), first().of(&reroll_of()))?;
    Ok(())
}

// A per-source first hit beside a threshold substitute that watches what it negates. F is the
// per-source first hit, N its negation (a bonus attack when F never applied), and S a threshold
// reroll over the attacks and N. The look-ahead has to know F's fire slot, or N looks like it can
// still fire after F applied and S holds a roll it can never spend.

fn negation_build(attacks: usize, per_source: bool) -> R {
    let mut t = empty()?.attack_as(sword()?, "a1")?;
    if attacks > 1 {
        t = t.attack_as(sword()?, "a2")?;
    }
    let of: &[&str] = if attacks > 1 {
        &["a1", "a2", "N"]
    } else {
        &["a1", "N"]
    };
    let two_d6 = || dice_of(2.0, d6());
    let mut options = first().id("F");
    if per_source {
        options = options.per_source(per(vec![("a1", rd(two_d6()?), None)]));
    }
    t.on_first_hit_with(two_d6()?, options)?
        .otherwise_with(knife()?, rid("N"))?
        .on_first_hit_transform(
            keep_best_damage().if_below_split(8.0, 14.0)?,
            first().id("S").of(of),
        )
}

fn same_as_the_step_spelling(attacks: usize) -> T {
    let suffix = if attacks > 1 { "s" } else { "" };
    let mut want = expect(
        FILE,
        &name_p(&format!(
            "a per-source first hit beside a threshold substitute that watches what it negates > {attacks} attack{suffix}: the same as the step spelling"
        )),
    );
    let folded = negation_build(attacks, true)?;
    let step = negation_build(attacks, false)?;
    assert!(max_diff(&want.pmf(&folded), &want.pmf(&step)) < 1e-14);
    close(want.mean(&folded), want.mean(&step), 12);
    for id in ["F", "N", "S"] {
        close(want.fire(&folded, id), want.fire(&step, id), 13);
    }
    want.done();
    Ok(())
}

#[test]
fn negation_1_attack_the_same_as_the_step_spelling() -> T {
    same_as_the_step_spelling(1)
}

#[test]
fn negation_2_attacks_the_same_as_the_step_spelling() -> T {
    same_as_the_step_spelling(2)
}

#[test]
fn negation_sees_a_later_attack_that_always_lands_mark_the_first_hit_it_negates() -> T {
    let mut want = expect(
        FILE,
        &name_p(
            "a per-source first hit beside a threshold substitute that watches what it negates > sees a later attack that always lands mark the first hit it negates",
        ),
    );
    // a2 always lands, so F applies there and N never fires: S holding a1's roll for N is
    // worthless. The look-ahead reaches that through a2's draws, not through the walk state.
    let build = |per_source: bool| -> R {
        let always = d20().always_hits()?.on_hit(d6())?;
        let mut options = first().id("F").of(&["a2"]);
        if per_source {
            options = options.per_source(per(vec![("a2", rd(dice_of(2.0, d6())?), None)]));
        }
        empty()?
            .attack_as(sword()?, "a1")?
            .attack_as(always, "a2")?
            .on_first_hit_with(dice_of(2.0, d6())?, options)?
            .otherwise_with(knife()?, rid("N"))?
            .on_first_hit_transform(
                keep_best_damage().if_below_split(8.0, 14.0)?,
                first().id("S").of(&["a1", "N"]),
            )
    };
    let folded = build(true)?;
    let step = build(false)?;
    assert!(max_diff(&want.pmf(&folded), &want.pmf(&step)) < 1e-14);
    for id in ["F", "N", "S"] {
        close(want.fire(&folded, id), want.fire(&step, id), 13);
    }
    want.done();
    Ok(())
}

// A per-source first hit that rolls its own attack.

#[test]
fn rolling_its_own_attack_is_refused_in_the_riders_own_damage_in_a_payload_and_in_a_list() -> T {
    let own = mk(swords(2)?)?.on_first_hit_with(
        knife()?,
        first().per_source(per(vec![("attack 2", rd(d6()), None)])),
    );
    let payload = mk(swords(2)?)?.on_first_hit_with(
        d6(),
        first().per_source(per(vec![("attack 2", rd(knife()?), None)])),
    );
    let list = mk(swords(2)?)?.on_first_hit_with(
        d6(),
        first().per_source(per(vec![(
            "attack 2",
            RiderDamage::Many(vec![knife()?.into(), knife()?.into()]),
            None,
        )])),
    );
    for build in [own, payload, list] {
        assert_refused(build, "unsupported-trigger", "plain onFirstHit");
    }
    Ok(())
}

#[test]
fn rolling_its_own_attack_is_refused_for_a_capped_or_per_source_every_hit_rider_too() -> T {
    let capped = mk(swords(3)?)?.on_every_hit_with(knife()?, every().max(2.0));
    let capped_payload = mk(swords(3)?)?.on_every_hit_with(
        d6(),
        every()
            .max(2.0)
            .per_source(per(vec![("attack 2", rd(knife()?), None)])),
    );
    let per_source = mk(swords(2)?)?.on_every_hit_with(
        d6(),
        every().per_source(per(vec![(
            "attack 2",
            RiderDamage::Many(vec![knife()?.into(), d6().into()]),
            None,
        )])),
    );
    let cannot_bind = mk(swords(2)?)?.on_every_hit_with(knife()?, every().max(2.0));
    for build in [capped, capped_payload, per_source, cannot_bind] {
        assert_refused(build, "unsupported-trigger", "plain onFirstHit");
    }
    mk(swords(2)?)?.on_every_hit_with(knife()?, every())?;
    mk(swords(2)?)?.on_every_hit_with(knife()?, every().max(1.0))?;
    Ok(())
}

#[test]
fn rolling_its_own_attack_is_refused_when_only_the_crit_damage_rolls_an_attack() -> T {
    let mut want = expect(
        FILE,
        &name_p(
            "a per-source first hit that rolls its own attack > is refused when only the critDamage rolls an attack, rider-level or per source",
        ),
    );
    let sword_at = |ac: f64| attack_roll(7.0, ac, d8().plus(4.0)?);
    let knife_at = |ac: f64| attack_roll(5.0, ac, d6().plus(3.0)?);
    let spellings = [
        mk(swords(3)?)?.on_every_hit_with(d6(), every().max(2.0).crit(rd(knife_at(14.0)?))),
        mk(swords(3)?)?.on_every_hit_with(
            d6(),
            every()
                .max(2.0)
                .crit(RiderDamage::Many(vec![d6().into(), knife_at(14.0)?.into()])),
        ),
        mk(swords(2)?)?.on_every_hit_with(
            d6(),
            every().per_source(per(vec![("attack 2", rd(d6()), Some(rd(knife_at(14.0)?)))])),
        ),
        mk(swords(2)?)?.on_first_hit_with(
            d6(),
            first().per_source(per(vec![("attack 2", rd(d6()), Some(rd(knife_at(14.0)?)))])),
        ),
        mk(swords(2)?)?.on_first_hit_with(
            d6(),
            first()
                .crit(rd(knife_at(14.0)?))
                .per_source(per(vec![("attack 2", rd(d8()), None)])),
        ),
    ];
    for build in spellings {
        assert_refused(build, "unsupported-trigger", "critDamage");
    }
    // What is not folded still takes an attack as its crit damage, and vsAC still rebinds it.
    let plain = |every_hit: bool, sword: AttackBuilder, crit: AttackBuilder| -> R {
        let t = mk(vec![atk(sword.clone()), atk(sword)])?;
        if every_hit {
            t.on_every_hit_with(d6(), every().crit(rd(crit)))
        } else {
            t.on_first_hit_with(d6(), first().crit(rd(crit)))
        }
    };
    for every_hit in [false, true] {
        let rebound = want.mean(&plain(every_hit, sword_at(15.0)?, knife_at(14.0)?)?.vs_ac(20.0)?);
        close(
            rebound,
            want.mean(&plain(every_hit, sword_at(20.0)?, knife_at(20.0)?)?),
            12,
        );
        let rebound = want.mean(&plain(every_hit, sword_at(15.0)?, knife_at(14.0)?)?.vs_ac(20.0)?);
        let other = want.mean(&plain(every_hit, sword_at(20.0)?, knife_at(14.0)?)?);
        assert!(
            (rebound - other).abs() >= 0.0005,
            "expected {rebound} not to be close to {other} (3 digits)"
        );
    }
    mk(swords(2)?)?.on_every_hit_with(d6(), every().max(1.0).crit(rd(knife_at(14.0)?)))?;
    want.done();
    Ok(())
}

#[test]
fn rolling_its_own_attack_is_what_the_plain_on_first_hit_step_spelling_is_for() -> T {
    let mut want = expect(
        FILE,
        &name_p(
            "a per-source first hit that rolls its own attack > is what the plain onFirstHit step spelling is for",
        ),
    );
    let t = mk(swords(2)?)?.on_first_hit_with(knife()?, first().id("bonus"))?;
    close(
        want.step_stats(&t, "bonus").rolled,
        1.0 - 0.35f64.powi(2),
        12,
    );
    want.done();
    Ok(())
}

// --- JSON spec ---------------------------------------------------------------------------------

#[test]
fn spec_every_hit_of_max_is_the_chained_cap() -> T {
    let mut want = expect(
        FILE,
        &name("JSON spec > `{ on: 'every-hit', of, max }` is the chained cap"),
    );
    let spec = spec_turn(
        swords(3)?,
        vec![rider_spec(
            Trigger::EveryHit {
                of: Some(strs(&["attack 1", "attack 2", "attack 3"])),
                max: Some(2.0),
                per_source: None,
            },
            Some("dice"),
            d6(),
        )],
    )?;
    let chained = mk(swords(3)?)?.on_every_hit_with(d6(), every().max(2.0).id("dice"))?;
    assert_eq!(bins(&want.pmf(&spec)), bins(&want.pmf(&chained)));
    assert_eq!(
        want.applications(&spec, "dice"),
        want.applications(&chained, "dice")
    );
    want.done();
    Ok(())
}

#[test]
fn spec_an_omitted_of_watches_every_declared_attack() -> T {
    let mut want = expect(
        FILE,
        &name("JSON spec > an omitted `of` watches every declared attack"),
    );
    let spec = spec_turn(
        swords(3)?,
        vec![rider_spec(
            Trigger::EveryHit {
                of: None,
                max: Some(2.0),
                per_source: None,
            },
            None,
            d6(),
        )],
    )?;
    let chained = mk(swords(3)?)?.on_every_hit_with(d6(), every().max(2.0))?;
    assert_eq!(bins(&want.pmf(&spec)), bins(&want.pmf(&chained)));
    want.done();
    Ok(())
}

// --- beside a bounce chain long enough to reuse trigger group slots ----------------------------
// A ten-link bounce chain has ten dice-match source sets and the capped rider adds another: more
// than MAX_TRIGGER_GROUPS, so the plan shares slots between groups whose lives do not overlap. The
// cap's count and the per-source first hit's fire slot are not group slots, so a slot that is
// released and reused cannot reset them; the enumeration resolves the same turn.

const LINKS: usize = 10;
const CAP_BEAMS: [usize; 7] = [0, 2, 3, 5, 6, 8, 10]; // beam 0 is "attack 1", beam k is "bounce k"
const FIRST_BEAMS: [usize; 3] = [3, 4, 9];

fn bounce_name(test: &str) -> String {
    name(&format!(
        "beside a bounce chain long enough to reuse trigger group slots > {test}"
    ))
}

/// Joint (total, dice matched) mass of `count` d8s: the orb's damage given a landing.
fn dice_table(count: u32) -> (Dist, Dist) {
    fn go(left: u32, total: i64, seen: u32, matched: bool, count: u32, out: &mut (Dist, Dist)) {
        if left == 0 {
            let into = if matched { &mut out.0 } else { &mut out.1 };
            *into.entry(total).or_insert(0.0) += 8f64.powi(-(count as i32));
            return;
        }
        for face in 1..=8u32 {
            go(
                left - 1,
                total + i64::from(face),
                seen | (1 << face),
                matched || (seen & (1 << face)) != 0,
                count,
                out,
            );
        }
    }
    let mut out = (Dist::new(), Dist::new());
    go(count, 0, 0, false, count, &mut out);
    out
}

fn bounce_payload(beam: usize) -> Payload {
    match beam {
        4 => doubling(1, 10),
        9 => Payload {
            hit: point(7),
            crit: point(20),
        },
        _ => doubling(1, 4),
    }
}

fn orb() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 17.0, dice_of(3.0, d8())?)
}

fn bounce_build() -> Result<Turn, Box<dyn std::error::Error>> {
    let cap_ids: Vec<String> = CAP_BEAMS
        .iter()
        .map(|beam| {
            if *beam == 0 {
                "attack 1".to_string()
            } else {
                format!("bounce {beam}")
            }
        })
        .collect();
    let first_ids: Vec<String> = FIRST_BEAMS
        .iter()
        .map(|beam| format!("bounce {beam}"))
        .collect();
    let cap_refs: Vec<&str> = cap_ids.iter().map(String::as_str).collect();
    let first_refs: Vec<&str> = first_ids.iter().map(String::as_str).collect();
    Ok(bounce(DamageSource::from(orb()?), LINKS as f64)?
        .on_every_hit_with(d6(), every().max(2.0).of(&cap_refs).id("dice"))?
        .on_first_hit_with(
            d4(),
            first().of(&first_refs).id("first").per_source(per(vec![
                ("bounce 4", rd(d10()), None),
                ("bounce 9", rd(flat(7.0)?), Some(rd(flat(20.0)?))),
            ])),
        )?)
}

/// Forward enumeration over the beams; state: chain alive, cap applications used, first hit used.
fn bounce_enumerate() -> (Dist, f64, f64, f64) {
    let orb_odds = odds(5, 17);
    let (hit_matched, hit_unmatched) = dice_table(3);
    let (crit_matched, crit_unmatched) = dice_table(6);
    let mut states: BTreeMap<(u8, usize, u8), Dist> = BTreeMap::from([((1, 0, 0), point(0))]);
    for beam in 0..=LINKS {
        let mut next: BTreeMap<(u8, usize, u8), Dist> = BTreeMap::new();
        let mut put = |key: (u8, usize, u8), dist: Dist| match next.get_mut(&key) {
            Some(known) => add_into(known, &dist),
            None => {
                next.insert(key, dist);
            }
        };
        for ((alive, count, first_used), dist) in &states {
            if *alive == 0 {
                put((*alive, *count, *first_used), dist.clone());
                continue;
            }
            put(
                (0, *count, *first_used),
                scaled(dist, 1.0 - orb_odds.hit - orb_odds.crit),
            );
            let modes: [(bool, f64, &Dist, &Dist); 2] = [
                (false, orb_odds.hit, &hit_matched, &hit_unmatched),
                (true, orb_odds.crit, &crit_matched, &crit_unmatched),
            ];
            for (is_crit, p, matched_table, unmatched_table) in modes {
                for (matched, table) in [(true, matched_table), (false, unmatched_table)] {
                    let mut landed = convolve(dist, &scaled(table, p));
                    let mut used = *count;
                    let mut first_now = *first_used;
                    if CAP_BEAMS.contains(&beam) && used < 2 {
                        let payload = doubling(1, 6);
                        landed =
                            convolve(&landed, if is_crit { &payload.crit } else { &payload.hit });
                        used += 1;
                    }
                    if FIRST_BEAMS.contains(&beam) && first_now == 0 {
                        let payload = bounce_payload(beam);
                        landed =
                            convolve(&landed, if is_crit { &payload.crit } else { &payload.hit });
                        first_now = 1;
                    }
                    put((u8::from(matched), used, first_now), landed);
                }
            }
        }
        states = next;
    }
    let mut total = Dist::new();
    let (mut p_first, mut p_cap, mut e_cap) = (0.0, 0.0, 0.0);
    for ((_, count, first_used), dist) in &states {
        let mass: f64 = dist.values().sum();
        add_into(&mut total, dist);
        if *first_used != 0 {
            p_first += mass;
        }
        if *count > 0 {
            p_cap += mass;
        }
        e_cap += *count as f64 * mass;
    }
    (total, p_first, p_cap, e_cap)
}

#[test]
fn bounce_really_shares_slots() -> T {
    let mut want = expect(FILE, &bounce_name("really shares slots"));
    let t = bounce_build()?;
    let source_sets = t
        .rider_ids()?
        .iter()
        .filter(|id| id.starts_with("bounce"))
        .count()
        + 1;
    assert!(source_sets > MAX_TRIGGER_GROUPS);
    want.mean(&t);
    let (group_count, _) = t.inspect_turn()?;
    assert!(group_count <= MAX_TRIGGER_GROUPS);
    want.done();
    Ok(())
}

#[test]
fn bounce_matches_the_enumeration_with_the_cap_and_the_per_source_first_hit_both_binding() -> T {
    let mut want = expect(
        FILE,
        &bounce_name(
            "matches the enumeration at 1e-12 with the cap and the per-source first hit both binding",
        ),
    );
    let (total, p_first, p_cap, e_cap) = bounce_enumerate();
    let t = bounce_build()?;
    expect_matches(&want.pmf(&t), &total, 1e-12);
    close(want.fire(&t, "first"), p_first, 12);
    close(want.fire(&t, "dice"), p_cap, 12);
    close(want.applications(&t, "dice"), e_cap, 12);
    close(want.applications(&t, "first"), p_first, 12);
    want.done();
    Ok(())
}

// --- over save rows, by landing kind -----------------------------------------------------------
// A save has no hit or crit: a rider reads it under `landing`. `fail` counts a failed save
// whatever it dealt; `damage` counts a failure or a saveHalf pass that dealt more than 0. Each
// capped rider counts its own landings, so two kinds over one row keep two counters.

fn save_name(test: &str) -> String {
    name(&format!("over save rows, by landing kind > {test}"))
}

fn plain_save() -> Result<SaveBuilder, DiceError> {
    d20()
        .dc(13.0)?
        .on_save_failure_args(&[Arg::Roll(d4().plus(-1.0)?)])
}

fn half_save() -> Result<SaveBuilder, DiceError> {
    plain_save()?.save_half()
}

/// One way a row can turn out: its probability, its damage, and where it lands for a rider.
struct RowOutcome {
    p: f64,
    dist: Dist,
    /// Lands for a rider reading the row under `fail`, and under `damage`.
    fail: bool,
    hurt: bool,
    crit: bool,
}

fn attack_row(odds: Odds, damage: Dist, crit_damage: Dist) -> Vec<RowOutcome> {
    vec![
        RowOutcome {
            p: 1.0 - odds.hit - odds.crit,
            dist: point(0),
            fail: false,
            hurt: false,
            crit: false,
        },
        RowOutcome {
            p: odds.hit,
            dist: damage,
            fail: true,
            hurt: true,
            crit: false,
        },
        RowOutcome {
            p: odds.crit,
            dist: crit_damage,
            fail: true,
            hurt: true,
            crit: true,
        },
    ]
}

/// A save: the failure damage is d4 - 1 (0 to 3); a pass under saveHalf takes half of it, floored.
fn save_row(save_half: bool) -> Vec<RowOutcome> {
    let mut outcomes = Vec::new();
    for face in 0..=3i64 {
        outcomes.push(RowOutcome {
            p: 0.6 / 4.0,
            dist: point(face),
            fail: true,
            hurt: face > 0,
            crit: false,
        });
        let passed = if save_half { face / 2 } else { 0 };
        outcomes.push(RowOutcome {
            p: 0.4 / 4.0,
            dist: point(passed),
            fail: false,
            hurt: passed > 0,
            crit: false,
        });
    }
    outcomes
}

fn save_rows() -> Vec<Vec<RowOutcome>> {
    let attack = || attack_row(odds(7, 15), dice(1, 8, 4), dice(2, 8, 4));
    vec![attack(), save_row(true), attack(), save_row(false)]
}

const IDS: [&str; 4] = ["attack 1", "attack 2", "attack 3", "attack 4"];

fn save_source() -> R {
    mk(vec![
        atk(sword()?),
        atk(half_save()?),
        atk(sword()?),
        atk(plain_save()?),
    ])
}

struct Rule {
    id: &'static str,
    landing: SaveLanding,
    max: usize,
    payload: fn(usize) -> Payload,
}

fn cap_damage() -> Rule {
    Rule {
        id: "cap damage",
        landing: SaveLanding::Damage,
        max: 2,
        payload: |_| doubling(1, 6),
    }
}

fn cap_fail() -> Rule {
    Rule {
        id: "cap fail",
        landing: SaveLanding::Fail,
        max: 2,
        payload: |_| doubling(2, 4),
    }
}

fn first_rule() -> Rule {
    Rule {
        id: "first",
        landing: SaveLanding::Fail,
        max: 1,
        payload: |row| {
            if row == 1 {
                doubling(1, 10)
            } else {
                doubling(1, 4)
            }
        },
    }
}

fn with_riders(base: &Turn) -> R {
    let damage = cap_damage();
    let fail = cap_fail();
    base.on_every_hit_with(
        d6(),
        every()
            .id(damage.id)
            .landing(damage.landing)
            .max(damage.max as f64)
            .of(&IDS),
    )?
    .on_every_hit_with(
        dice_of(2.0, d4())?,
        every()
            .id(fail.id)
            .landing(fail.landing)
            .max(fail.max as f64)
            .of(&IDS),
    )?
    .on_first_hit_with(
        d4(),
        first()
            .id("first")
            .landing(SaveLanding::Fail)
            .of(&IDS)
            .per_source(per(vec![("attack 2", rd(d10()), None)])),
    )
}

/// Forward enumeration over the rows; state: applications used by each rule.
fn save_enumerate(rules: &[Rule]) -> (Dist, Vec<f64>, Vec<f64>) {
    let mut states: BTreeMap<Vec<usize>, Dist> = BTreeMap::from([(vec![0; rules.len()], point(0))]);
    for (row_index, row) in save_rows().iter().enumerate() {
        let mut next: BTreeMap<Vec<usize>, Dist> = BTreeMap::new();
        for (counts, dist) in &states {
            for outcome in row {
                let mut landed = convolve(dist, &scaled(&outcome.dist, outcome.p));
                let mut used = counts.clone();
                for (r, rule) in rules.iter().enumerate() {
                    let lands = if rule.landing == SaveLanding::Fail {
                        outcome.fail
                    } else {
                        outcome.hurt
                    };
                    if !lands || used[r] >= rule.max {
                        continue;
                    }
                    used[r] += 1;
                    let payload = (rule.payload)(row_index);
                    landed = convolve(
                        &landed,
                        if outcome.crit {
                            &payload.crit
                        } else {
                            &payload.hit
                        },
                    );
                }
                match next.get_mut(&used) {
                    Some(known) => add_into(known, &landed),
                    None => {
                        next.insert(used, landed);
                    }
                }
            }
        }
        states = next;
    }
    let mut total = Dist::new();
    let mut used_at_least_once = vec![0.0; rules.len()];
    let mut applied = vec![0.0; rules.len()];
    for (counts, dist) in &states {
        let mass: f64 = dist.values().sum();
        add_into(&mut total, dist);
        for (r, count) in counts.iter().enumerate() {
            if *count > 0 {
                used_at_least_once[r] += mass;
            }
            applied[r] += *count as f64 * mass;
        }
    }
    (total, used_at_least_once, applied)
}

#[test]
fn saves_match_the_enumeration_two_capped_kinds_and_a_per_source_first_hit_over_attacks_and_saves()
-> T {
    let mut want = expect(
        FILE,
        &save_name(
            "matches the enumeration at 1e-12: two capped kinds and a per-source first hit over attacks and saves",
        ),
    );
    let rules = [cap_damage(), cap_fail(), first_rule()];
    let (total, used, applied) = save_enumerate(&rules);
    let t = with_riders(&save_source()?)?;
    expect_matches(&want.pmf(&t), &total, 1e-12);
    for (r, rule) in rules.iter().enumerate() {
        close(want.fire(&t, rule.id), used[r], 12);
        close(want.applications(&t, rule.id), applied[r], 12);
    }
    want.done();
    Ok(())
}

#[test]
fn saves_damage_and_fail_over_one_row_are_different_riders() -> T {
    let mut want = expect(
        FILE,
        &save_name(
            "`damage` and `fail` over one row are different riders: a zero-damage failure lands only under `fail`",
        ),
    );
    let one = |landing: SaveLanding| -> R {
        mk(vec![atk(plain_save()?)])?
            .on_every_hit_with(flat(10.0)?, every().landing(landing).max(1.0).id("rider"))
    };
    // P(fail) = 0.6; a failure lands for `damage` only when it dealt more than 0 (3 of 4 faces).
    close(want.fire(&one(SaveLanding::Fail)?, "rider"), 0.6, 12);
    close(
        want.fire(&one(SaveLanding::Damage)?, "rider"),
        0.6 * 0.75,
        12,
    );
    want.done();
    Ok(())
}

#[test]
fn saves_a_per_source_first_hit_marks_its_fire_slot_only_when_the_row_lands_under_its_kind() -> T {
    let mut want = expect(
        FILE,
        &save_name(
            "a per-source first hit over a save row marks its fire slot only when the row lands under its kind",
        ),
    );
    let build = |landing: SaveLanding| -> R {
        mk(vec![atk(half_save()?), atk(sword()?)])?
            .on_first_hit_with(
                d6(),
                first()
                    .landing(landing)
                    .of(&["attack 1", "attack 2"])
                    .id("first")
                    .per_source(per(vec![("attack 1", rd(d8()), None)])),
            )?
            .otherwise_with(d4(), rid("none"))
    };
    for landing in [SaveLanding::Fail, SaveLanding::Damage] {
        let t = build(landing)?;
        // The save lands for `fail` on a failure (0.6), for `damage` on a failure of 1 to 3 or a
        // pass of 2 to 3.
        let p_save = if landing == SaveLanding::Fail {
            0.6
        } else {
            0.6 * 0.75 + 0.4 * 0.5
        };
        let p_any = 1.0 - (1.0 - p_save) * 0.35;
        close(want.fire(&t, "first"), p_any, 12);
        close(want.fire(&t, "none"), 1.0 - p_any, 12);
    }
    want.done();
    Ok(())
}

#[test]
fn saves_the_threshold_look_ahead_reads_a_save_rows_landing_under_the_kind_of_the_fold_that_watches_it()
-> T {
    let mut want = expect(
        FILE,
        &save_name(
            "the threshold look-ahead reads a save row's landing under the kind of the fold that watches it",
        ),
    );
    // F is a first hit over the save row (folded, because it has a payload per source), N its
    // negation, S a threshold reroll over the sword and N. Holding the sword's roll is only worth
    // it while N can still fire, which depends on whether the save landed under F's kind.
    let build = |folded: bool, landing: SaveLanding| -> R {
        let mut options = first().id("F").landing(landing).of(&["attack 2"]);
        if folded {
            options = options.per_source(per(vec![("attack 2", rd(d6()), None)]));
        }
        mk(vec![atk(sword()?), atk(half_save()?)])?
            .on_first_hit_with(d6(), options)?
            .otherwise_with(knife()?, rid("N"))?
            .on_first_hit_transform(
                keep_best_damage().if_below_split(9.0, 15.0)?,
                first().id("S").of(&["attack 1", "N"]),
            )
    };
    for landing in [SaveLanding::Fail, SaveLanding::Damage] {
        let folded = build(true, landing)?;
        let step = build(false, landing)?;
        assert!(max_diff(&want.pmf(&folded), &want.pmf(&step)) < 1e-13);
        for id in ["F", "N", "S"] {
            close(want.fire(&folded, id), want.fire(&step, id), 12);
        }
    }
    want.done();
    Ok(())
}

#[test]
fn saves_a_probe_beside_the_capped_riders_reads_the_same_walk_and_leaves_everything_else_alone() -> T
{
    let mut want = expect(
        FILE,
        &save_name(
            "a probe beside the capped riders reads the same walk and leaves everything else alone",
        ),
    );
    let plain = with_riders(&save_source()?)?;
    let probed =
        with_riders(&save_source()?)?.observe_any_crit("crit", Some(&["attack 1", "attack 3"]))?;
    close(want.fire(&probed, "crit"), 1.0 - 0.95f64.powi(2), 12);
    assert_eq!(bins(&want.pmf(&probed)), bins(&want.pmf(&plain)));
    for id in [cap_damage().id, cap_fail().id, first_rule().id] {
        assert_eq!(want.fire(&probed, id), want.fire(&plain, id));
        assert_eq!(
            want.applications(&probed, id),
            want.applications(&plain, id)
        );
    }
    // A probe over the rows a capped rider watches, read before anything else: same number.
    let probe_first =
        with_riders(&save_source()?)?.observe_any_crit("crit", Some(&["attack 1", "attack 3"]))?;
    close(want.fire(&probe_first, "crit"), 1.0 - 0.95f64.powi(2), 12);
    close(
        want.applications(&probe_first, cap_damage().id),
        want.applications(&plain, cap_damage().id),
        15,
    );
    want.done();
    Ok(())
}

#[test]
fn saves_a_save_row_with_a_landing_kind_is_still_refused_without_one_capped_or_not() -> T {
    let build = |max: f64| -> R {
        mk(vec![atk(sword()?), atk(half_save()?)])?.on_every_hit_with(d6(), every().max(max))
    };
    assert_code(build(1.0), "not-an-attack");
    assert_code(build(2.0), "not-an-attack");
    Ok(())
}

// --- refusals ----------------------------------------------------------------------------------

fn refusals(test: &str) -> String {
    name(&format!("refusals > {test}"))
}

#[test]
fn refusals_needs_a_positive_integer_max() -> T {
    for max in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
        let result = mk(swords(1)?)?.on_every_hit_with(d6(), every().max(max));
        assert!(
            matches!(result, Err(DiceError::Range(_))),
            "max {max}: {:?}",
            result.as_ref().err()
        );
    }
    Ok(())
}

#[test]
fn refusals_a_max_or_a_payload_per_source_beside_a_grant() -> T {
    let grant = || advantage().until_next_attack();
    let two = || mk(swords(2)?);
    let with_grant = vec![
        crate::turn::EffectPart::Damage(d6().into()),
        crate::turn::EffectPart::Grant(grant().into()),
    ];
    assert_throws(
        two()?.on_every_hit_with(grant(), every().max(1.0)),
        "never capped",
    );
    assert_throws(
        two()?.on_every_hit_with(with_grant, every().max(1.0)),
        "never capped",
    );
    assert_throws(
        two()?.on_every_hit_with(
            grant(),
            every().per_source(per(vec![("attack 1", rd(d6()), None)])),
        ),
        "no payload",
    );
    assert_throws(
        two()?.on_first_hit_with(
            grant(),
            first().per_source(per(vec![("attack 1", rd(d6()), None)])),
        ),
        "no payload",
    );
    Ok(())
}

#[test]
fn refusals_a_payload_per_source_beside_a_transform() -> T {
    assert_throws(
        mk(swords(2)?)?.on_first_hit_transform(
            keep_best_damage(),
            first().per_source(per(vec![("attack 1", rd(d6()), None)])),
        ),
        "no payload per source",
    );
    Ok(())
}

#[test]
fn refusals_a_payload_for_a_source_the_rider_does_not_watch() -> T {
    let unwatched = || per(vec![("attack 2", rd(d4()), None)]);
    let nowhere = || per(vec![("nowhere", rd(d4()), None)]);
    for every_hit in [true, false] {
        let call = |options_every: EveryHitOptions, options_first: FirstHitOptions| -> R {
            let t = mk(swords(2)?)?;
            if every_hit {
                t.on_every_hit_with(d6(), options_every)
            } else {
                t.on_first_hit_with(d6(), options_first)
            }
        };
        assert_code(
            call(
                every().of(&["attack 1"]).per_source(unwatched()),
                first().of(&["attack 1"]).per_source(unwatched()),
            ),
            "unknown-id",
        );
        assert_code(
            call(every().per_source(nowhere()), first().per_source(nowhere())),
            "unknown-id",
        );
    }
    Ok(())
}

#[test]
fn refusals_cannot_negate_or_watch_a_rider_that_can_apply_more_than_once_or_one_folded_per_source()
-> T {
    let capped = mk(swords(3)?)?.on_every_hit_with(d6(), every().max(2.0).id("capped"))?;
    assert_code(
        capped.otherwise_with(d4(), RiderOptions::default()),
        "not-an-attack",
    );
    assert_code(
        capped.on_first_hit_with(d4(), first().of(&["capped"])),
        "not-an-attack",
    );
    let folded = mk(swords(2)?)?.on_first_hit_with(
        d6(),
        first()
            .id("folded")
            .per_source(per(vec![("attack 2", rd(d8()), None)])),
    )?;
    // A first-hit rider folded per source lands once: naming it makes it a partner (`Rider.of`),
    // so the d4 lands alongside it.
    assert_code(
        folded.on_first_hit_with(d4(), first().of(&["folded"])),
        "none",
    );
    Ok(())
}

#[test]
fn refusals_bounds_the_capped_riders_that_watch_one_attack() -> T {
    // Caps of 1 are first hits and take no counter, so the counters start at 2.
    let mut t = n_swords(9)?;
    for cap in 2..2 + MAX_CAPPED_COUNTERS {
        t = t.on_every_hit_with(d4(), every().max(cap as f64))?;
    }
    assert_code(
        t.on_every_hit_with(d4(), every().max((2 + MAX_CAPPED_COUNTERS) as f64)),
        "too-many-counters",
    );
    Ok(())
}

#[test]
fn refusals_answers_expected_applications_for_every_rider_and_only_for_riders() -> T {
    let mut want = expect(
        FILE,
        &refusals("answers expectedApplications for every rider, and only for riders"),
    );
    let t = mk(swords(2)?)?
        .on_first_hit_with(d6(), first().id("sneak"))?
        .on_every_hit_with(d4(), every().id("mark"))?
        .on_any_crit_with(d8(), cond_id("smite"))?;
    close(want.applications(&t, "mark"), 2.0 * 0.65, 12);
    let sneak = want.applications(&t, "sneak");
    assert_eq!(sneak, want.fire(&t, "sneak"));
    let smite = want.applications(&t, "smite");
    assert_eq!(smite, want.fire(&t, "smite"));
    assert_eq!(code_of(t.expected_applications("attack 1")), "unknown-id");
    let substituted =
        mk(swords(2)?)?.on_first_hit_transform(keep_best_damage(), first().id("reroll"))?;
    assert_eq!(
        code_of(substituted.expected_applications("reroll")),
        "unknown-id"
    );
    want.done();
    Ok(())
}
