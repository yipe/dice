//! Translated TS cases: the attack-level parts of `src/builder/miss-reroll.test.ts`, plus
//! `miss-reroll-guards`, `miss-reroll-natural`, `sample-miss-reroll`, `tests/sample-attack`,
//! `tests/miss-reroll-cache-exactness` (non-turn part), `tests/parse-landed-at-zero`,
//! `tests/parse-trailing-payload-term`, `tests/zero-damage-hit-labels` (non-turn parts) and
//! `tests/frozen-pmf-map` (the assertions that are not JS-frozen-`Map` mutations).

use super::support::*;
use crate::Damage;
use crate::Pmf;
use crate::builder::attack::{AttackBuilder, AttackOutcome, AttackSample};
use crate::builder::factory::{self, *};
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::sample::SampledDie;
use crate::builder::types::{Check, MissRerollMode};
use crate::common::{Rng, RollType};
use crate::error::DiceError;
use crate::parser::parse;
use crate::turn::context::RowContext;
use indexmap::IndexMap;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const TOLERANCE: f64 = 1e-12;
const ADD: MissRerollMode = MissRerollMode::AddD20;
const REROLL: MissRerollMode = MissRerollMode::Reroll;

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/// The message contains `first`, then `second` after it (the TS regex `/first.*second/`).
#[track_caller]
fn assert_throws_seq<X>(r: Result<X, DiceError>, first: &str, second: &str) {
    let e = err_of(r);
    let ok = e
        .find(first)
        .is_some_and(|i| e[i + first.len()..].contains(second));
    assert!(ok, "error {e:?} does not match /{first}.*{second}/");
}

/// `roll(count, die)`.
fn rd(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

/// `roll(count, sides, modifier)`.
fn rs(count: f64, sides: f64, modifier: Option<f64>) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, modifier)
}

/// `check.onHit(1, d8)`.
fn hit_1d8(check: &RollBuilder) -> Result<AttackBuilder, DiceError> {
    check.on_hit_args(&[Arg::Num(1.0), Arg::Roll(d8())])
}

/// `attackOf(check, mode)`: `check.rerollMisses(mode).onHit(1, d8)`.
fn attack_of(check: &RollBuilder, mode: MissRerollMode) -> Result<AttackBuilder, DiceError> {
    hit_1d8(&check.reroll_misses(mode)?)
}

/// `flatContext` of the TS test.
fn flat_context() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: vec![],
        joined: vec![],
    }
}

/// `{ ...flat, rollType }`.
fn with_type(roll_type: RollType) -> RowContext {
    RowContext {
        roll_type,
        ..flat_context()
    }
}

fn a_attack() -> Result<AttackBuilder, DiceError> {
    attack_of(&d20().plus(5.0)?.plus_roll(&d4())?.ac(15.0)?, ADD)
}

fn b_attack() -> Result<AttackBuilder, DiceError> {
    hit_1d8(&d20().plus(5.0)?.plus_roll(&d4())?.ac(15.0)?)
}

/// mulberry32 of `tests/helpers/lcg.ts` (`lcgRng`).
struct Lcg {
    s: u32,
}

impl Lcg {
    fn new(seed: u32) -> Lcg {
        Lcg { s: seed }
    }

    fn next(&mut self) -> u32 {
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
}

impl Rng for Lcg {
    fn die(&mut self, sides: f64) -> f64 {
        let sides = sides as u64;
        let limit = 4_294_967_296 - (4_294_967_296 % sides);
        let mut x = u64::from(self.next());
        while x >= limit {
            x = u64::from(self.next());
        }
        (x % sides) as f64 + 1.0
    }

    fn chance(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        let a = self.next();
        let b = self.next();
        (f64::from(a >> 5) * 67_108_864.0 + f64::from(b >> 6)) / 9_007_199_254_740_992.0 < p
    }
}

/// An rng that shows the given faces in order (whatever the die). `chance_ok` false: `chance()`
/// is a recorded error (`sample-attack` throws "no coins"). A run out of faces is a recorded error.
struct Script {
    faces: VecDeque<f64>,
    chance_ok: bool,
    bad: Option<String>,
}

impl Script {
    fn done(&self) -> T {
        match &self.bad {
            Some(m) => Err(m.clone().into()),
            None => Ok(()),
        }
    }
}

impl Rng for Script {
    fn die(&mut self, _sides: f64) -> f64 {
        if let Some(f) = self.faces.pop_front() {
            f
        } else {
            self.bad = Some("scripted rng ran out".to_string());
            1.0
        }
    }

    fn chance(&mut self, _p: f64) -> bool {
        if !self.chance_ok {
            self.bad = Some("no coins".to_string());
        }
        false
    }
}

/// `scripted(faces)` of the miss-reroll tests (`chance()` is false).
fn scripted(faces: &[f64]) -> Script {
    Script {
        faces: faces.iter().copied().collect(),
        chance_ok: true,
        bad: None,
    }
}

/// `dice(faces)` of `sample-attack.test.ts` (`chance()` throws).
fn dice(faces: &[f64]) -> Script {
    Script {
        faces: faces.iter().copied().collect(),
        chance_ok: false,
        bad: None,
    }
}

/// A sampled attack with `rng`, checking the script was not over-drawn.
fn sample_with(
    a: &AttackBuilder,
    faces: &[f64],
    context: Option<&RowContext>,
) -> Result<AttackSample, DiceError> {
    let mut rng = dice(faces);
    let s = a.sample(&mut rng, context)?;
    rng.done()?;
    Ok(s)
}

fn die_of(sides: f64, face: f64, kept: bool) -> SampledDie {
    SampledDie {
        sides,
        face,
        kept,
        reroll: false,
        miss_reroll: false,
    }
}

// ---------------------------------------------------------------------------------------------
// src/builder/miss-reroll.test.ts (attack level)
// ---------------------------------------------------------------------------------------------

struct Pinned {
    name: &'static str,
    check: RollBuilder,
    mode: MissRerollMode,
    hit: f64,
    crit: f64,
    mean: f64,
}

fn pinned_cases() -> Result<Vec<Pinned>, DiceError> {
    Ok(vec![
        Pinned {
            name: "A flat +5 +1d4 vs 15, add-d20",
            check: d20().plus(5.0)?.plus_roll(&d4())?.ac(15.0)?,
            mode: ADD,
            hit: 0.825,
            crit: 0.06625,
            mean: 4.30875,
        },
        Pinned {
            name: "C flat +6 vs 15, add-d20",
            check: d20().plus(6.0)?.ac(15.0)?,
            mode: ADD,
            hit: 0.77,
            crit: 0.07,
            mean: 4.095,
        },
        Pinned {
            name: "D disadvantage +5 +1d4 vs 15, reroll",
            check: d20()
                .plus(5.0)?
                .plus_roll(&d4())?
                .with_disadvantage()?
                .ac(15.0)?,
            mode: REROLL,
            hit: 0.744375,
            crit: 0.004125,
            mean: 3.3868125,
        },
        Pinned {
            name: "E disadvantage +5 +1d4 vs 15, add-d20",
            check: d20()
                .plus(5.0)?
                .plus_roll(&d4())?
                .with_disadvantage()?
                .ac(15.0)?,
            mode: ADD,
            hit: 0.9021875,
            crit: 0.0604375,
            mean: 4.60378125,
        },
        Pinned {
            name: "F advantage +7 +1d4 +1d12 vs 20, add-d20",
            check: d20()
                .plus(7.0)?
                .plus_roll(&d4())?
                .plus_roll(&d12())?
                .with_advantage()?
                .ac(20.0)?,
            mode: ADD,
            hit: 0.88121875,
            crit: 0.100177083333333,
            mean: 4.867078125,
        },
        Pinned {
            name: "G elven accuracy +5 vs 18, crit 19, reroll",
            check: d20()
                .plus(5.0)?
                .with_elven_accuracy()?
                .ac(18.0)?
                .crit_on(19.0)?,
            mode: REROLL,
            hit: 0.5778,
            crit: 0.2926,
            mean: 5.2335,
        },
        Pinned {
            name: "H halfling +4 -1d4 vs 14, add-d20",
            check: hd20().plus(4.0)?.minus_roll(&d4())?.ac(14.0)?,
            mode: ADD,
            hit: 0.60834375,
            crit: 0.081571875,
            mean: 3.47169375,
        },
        Pinned {
            name: "I flat +6 +1d4 vs 26, crit 19, add-d20",
            check: d20().plus(6.0)?.plus_roll(&d4())?.ac(26.0)?.crit_on(19.0)?,
            mode: ADD,
            hit: 0.13375,
            crit: 0.1825,
            mean: 2.244375,
        },
        Pinned {
            name: "A-adv advantage +5 +1d4 vs 15, add-d20",
            check: d20()
                .plus(5.0)?
                .plus_roll(&d4())?
                .with_advantage()?
                .ac(15.0)?,
            mode: ADD,
            hit: 0.8596875,
            crit: 0.1029375,
            mean: 4.79503125,
        },
        Pinned {
            name: "A-elven elven accuracy +5 +1d4 vs 15, add-d20",
            check: d20()
                .plus(5.0)?
                .plus_roll(&d4())?
                .with_elven_accuracy()?
                .ac(15.0)?,
            mode: ADD,
            hit: 0.842353125,
            crit: 0.14449375,
            mean: 5.0910328125,
        },
    ])
}

/// miss-reroll.test.ts:171 (every pinned row): the attack half, `resolve().weights` and `mean()`.
/// The `missRerollOdds` half and the oracle comparison are in `miss_reroll_core`.
#[test]
fn pinned_odds_attack_weights_and_mean() -> T {
    for c in pinned_cases()? {
        let attack = attack_of(&c.check, c.mode)?;
        let w = attack.resolve(0.0)?.weights;
        let name = c.name;
        assert!(close(w.hit, c.hit, 12), "{name}: hit {}", w.hit);
        assert!(close(w.crit, c.crit, 12), "{name}: crit {}", w.crit);
        assert_close(w.hit + w.crit + w.miss, 1.0, 12);
        assert!(close(attack.mean()?, c.mean, 12), "{name}: mean");
    }
    Ok(())
}

/// miss-reroll.test.ts:189
#[test]
fn b_the_same_row_without_reroll_misses() -> T {
    let w = b_attack()?.resolve(0.0)?.weights;
    assert_close(w.hit, 0.625, 12);
    assert_close(w.crit, 0.05, 12);
    assert_close(b_attack()?.mean()?, 3.2625, 12);
    Ok(())
}

/// miss-reroll.test.ts:196 (the oracle half is `crit_on_hit_reroll_odds_match_the_oracle`).
#[test]
fn j_crit_on_hit_reroll() -> T {
    let attack = hit_1d8(
        &d20()
            .plus(5.0)?
            .plus_roll(&d4())?
            .ac(15.0)?
            .reroll_misses(REROLL)?
            .always_crits()?,
    )?;
    let w = attack.resolve(0.0)?.weights;
    assert_close(w.hit, 0.0, 12);
    assert_close(w.crit, 0.89125, 12);
    assert_close(attack.mean()?, 8.02125, 12);
    Ok(())
}

/// miss-reroll.test.ts:207
#[test]
fn k_natural_20_damage_rides_the_rerolls_own_natural_20s() -> T {
    let attack = hit_1d8(&d20().plus(5.0)?.ac(15.0)?)?
        .plus_natural20_damage(flat(5.0)?)?
        .reroll_misses(ADD)?;
    let w = attack.resolve(0.0)?.weights;
    assert_close(w.hit, 0.725, 12);
    assert_close(w.crit, 0.0725, 12);
    assert_close(attack.mean()?, 4.2775, 12);
    Ok(())
}

/// miss-reroll.test.ts:217
#[test]
fn under_re_derives_the_check_in_a_context() -> T {
    let advantage = hit_1d8(
        &d20()
            .plus(5.0)?
            .plus_roll(&d4())?
            .with_advantage()?
            .ac(15.0)?
            .reroll_misses(ADD)?,
    )?;
    let under = a_attack()?.under(&with_type(RollType::Advantage), 0.0)?;
    let expected = advantage.to_pmf(0.0)?;
    assert_close(under.mean(), expected.mean(), 12);
    assert_close(under.mean(), 4.79503125, 12);
    for d in expected.support() {
        assert_close(under.p_at(d.0), expected.p_at(d.0), 12);
    }
    Ok(())
}

/// miss-reroll.test.ts:226
#[test]
fn miss_rerolled_the_miss_branch_once_its_d20_is_rolled_again() -> T {
    let b = b_attack()?;
    let rerolled = b.miss_rerolled(ADD, None, 0.0)?;
    assert_close(rerolled.mass(), 0.325, 12);
    assert_close(rerolled.filter_outcome("hit").mass(), 0.2, 12);
    assert_close(rerolled.filter_outcome("crit").mass(), 0.01625, 12);
    assert_close(rerolled.filter_outcome("missNone").mass(), 0.10875, 12);
    // The landing parts carry the row's own hit payload.
    let hit = rerolled.filter_outcome("hit").normalize();
    let own = b.resolve(0.0)?.hit;
    for d in own.support() {
        assert!((hit.p_at(d.0) - own.p_at(d.0)).abs() < TOLERANCE);
    }
    Ok(())
}

/// miss-reroll.test.ts:238
#[test]
fn miss_rerolled_under_disadvantage_reroll_mode_case_d() -> T {
    let rerolled = hit_1d8(
        &d20()
            .plus(5.0)?
            .plus_roll(&d4())?
            .with_disadvantage()?
            .ac(15.0)?,
    )?
    .miss_rerolled(REROLL, None, 0.0)?;
    assert_close(rerolled.filter_outcome("hit").mass(), 0.288125, 12);
    assert_close(rerolled.filter_outcome("crit").mass(), 0.001625, 12);
    Ok(())
}

/// miss-reroll.test.ts:244
#[test]
fn miss_rerolled_is_empty_for_an_always_hit_check() -> T {
    let attack = hit_1d8(&d20().plus(5.0)?.always_hits()?)?;
    assert_eq!(attack.miss_rerolled(ADD, None, 0.0)?.support().len(), 0);
    Ok(())
}

/// miss-reroll.test.ts:248
#[test]
fn miss_rerolled_refuses_a_check_that_already_rerolls_its_misses() -> T {
    assert_throws(a_attack()?.miss_rerolled(ADD, None, 0.0), "rerollMisses");
    Ok(())
}

/// miss-reroll.test.ts:252 (`toBe`: the Rust call returns an equal clone, so the identity is
/// asserted as equal expression and PMF).
#[test]
fn reroll_misses_on_an_always_hit_attack_is_that_attack() -> T {
    let always = hit_1d8(&d20().plus(5.0)?.always_hits()?)?;
    let same = always.reroll_misses(ADD)?;
    assert_eq!(same.to_expression()?, always.to_expression()?);
    assert_eq!(same.check.cache_key(), always.check.cache_key());
    assert_eq!(faces(&same.to_pmf(0.0)?), faces(&always.to_pmf(0.0)?));
    Ok(())
}

/// miss-reroll.test.ts:257
#[test]
fn reroll_misses_refuses_a_check_with_no_d20() -> T {
    assert_throws(flat(5.0)?.ac(10.0)?.reroll_misses(ADD), "d20");
    Ok(())
}

/// miss-reroll.test.ts:261
#[test]
fn with_check_keeps_the_reroll() -> T {
    let same = a_attack()?.with_check(|c| c)?;
    assert_close(same.mean()?, a_attack()?.mean()?, 12);
    let easier = a_attack()?.with_check(|c| Check { ac: 12.0, ..c })?;
    assert!(easier.mean()? > a_attack()?.mean()?);
    Ok(())
}

/// miss-reroll.test.ts:267
#[test]
fn cache_key_tells_the_modes_apart() -> T {
    let plain = d20().plus(5.0)?.plus_roll(&d4())?.ac(15.0)?;
    let key = |c: &RollBuilder| c.cache_key();
    assert_ne!(key(&plain.reroll_misses(ADD)?), key(&plain));
    assert_ne!(
        key(&plain.reroll_misses(ADD)?),
        key(&plain.reroll_misses(REROLL)?)
    );
    Ok(())
}

/// miss-reroll.test.ts:274
#[test]
fn crit_on_and_copy_keep_the_reroll() -> T {
    let check = d20().plus(5.0)?.ac(15.0)?.reroll_misses(REROLL)?;
    let mode = |c: &RollBuilder| c.attack_config().and_then(|a| a.miss_reroll);
    assert_eq!(mode(&check.copy()?), Some(REROLL));
    assert_eq!(mode(&check.crit_on(19.0)?), Some(REROLL));
    assert_eq!(mode(&check.pinned()?), Some(REROLL));
    assert_eq!(mode(&check.always_crits()?), Some(REROLL));
    Ok(())
}

/// miss-reroll.test.ts:342
#[test]
fn sample_lands_the_hit_share_of_the_pmf() -> T {
    let mut rng = Lcg::new(1);
    let draws = 20_000;
    let a = a_attack()?;
    let mut hits = 0;
    for _ in 0..draws {
        if a.sample(&mut rng, None)?.outcome == AttackOutcome::Hit {
            hits += 1;
        }
    }
    assert!((f64::from(hits) / f64::from(draws) - 0.825).abs() < 0.01);
    Ok(())
}

/// miss-reroll.test.ts:350
#[test]
fn sample_miss_reroll_lands_a_sampled_miss_in_the_proportions_of_miss_rerolled() -> T {
    let mut rng = Lcg::new(2);
    let attack = b_attack()?;
    let mut misses = 0;
    let mut hits = 0;
    while misses < 20_000 {
        let first = attack.sample(&mut rng, None)?;
        if first.outcome != AttackOutcome::Miss {
            continue;
        }
        misses += 1;
        let again = attack.sample_miss_reroll(first, ADD, &mut rng, None)?;
        if again.outcome == AttackOutcome::Hit {
            hits += 1;
        }
    }
    assert!((f64::from(hits) / f64::from(misses) - 0.2 / 0.325).abs() < 0.01);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// src/builder/miss-reroll-guards.test.ts
// ---------------------------------------------------------------------------------------------

/// miss-reroll-guards.test.ts:6
#[test]
fn refuses_a_d20_minimum_above_20() -> T {
    let r = d20()
        .minimum(21.0)?
        .ac(50.0)?
        .reroll_misses(ADD)
        .and_then(|c| hit_1d8(&c))
        .and_then(|a| a.mean());
    assert_throws_seq(r, "rerollMisses", "minimum");
    Ok(())
}

/// miss-reroll-guards.test.ts:10
#[test]
fn refuses_an_exploding_d20() -> T {
    let r = d20()
        .explode(1.0)?
        .ac(15.0)?
        .reroll_misses(ADD)
        .and_then(|c| hit_1d8(&c))
        .and_then(|a| a.mean());
    assert_throws_seq(r, "rerollMisses", "explodes");
    Ok(())
}

/// miss-reroll-guards.test.ts:14
#[test]
fn refuses_to_render_a_kept_one_bonus_pool() -> T {
    let bonus = rs(2.0, 4.0, None)?.best_of(1.0)?;
    let attack = attack_of(&d20().plus_roll(&bonus)?.ac(15.0)?, ADD)?;
    assert_throws(attack.to_expression(), "toExpression");
    Ok(())
}

/// miss-reroll-guards.test.ts:19
#[test]
fn still_renders_a_plain_bonus_and_parses_back_exactly_case_a() -> T {
    let attack = attack_of(&d20().plus(5.0)?.plus_dice(1.0, &d4())?.ac(15.0)?, ADD)?;
    let expr = attack.to_expression()?;
    assert!(expr.contains("d20 reroll"), "{expr}");
    assert!((parse(&expr)?.mean() - attack.mean()?).abs() < 1e-12);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// src/builder/miss-reroll-natural.test.ts
// ---------------------------------------------------------------------------------------------

/// A flat d20 vs AC 15 that rolled a 8 and missed.
fn missed_eight() -> AttackSample {
    AttackSample {
        outcome: AttackOutcome::Miss,
        check: vec![die_of(20.0, 8.0, true)],
        damage: vec![],
        total: 0.0,
        payload: None,
    }
}

fn mode_attack(mode: MissRerollMode) -> Result<AttackBuilder, DiceError> {
    hit_1d8(&d20().ac(15.0)?.reroll_misses(mode)?)
}

/// The first seed whose replacement d20 shows `face`.
fn seed_for(face: f64, mode: MissRerollMode) -> Result<u32, DiceError> {
    for seed in 1..10_000 {
        let s = mode_attack(mode)?.sample_miss_reroll(
            missed_eight(),
            mode,
            &mut Lcg::new(seed),
            None,
        )?;
        if s.check.get(1).map(|d| d.face) == Some(face) {
            return Ok(seed);
        }
    }
    Err(DiceError::error(format!("no seed rolls a {face}")))
}

fn faces_and_kept(s: &AttackSample) -> (Vec<f64>, Vec<bool>) {
    (
        s.check.iter().map(|d| d.face).collect(),
        s.check.iter().map(|d| d.kept).collect(),
    )
}

/// miss-reroll-natural.test.ts:26
#[test]
fn flat_reroll_a_missed_8_that_rerolls_to_2_reports_natural_2_with_the_replacement_kept() -> T {
    let seed = seed_for(2.0, REROLL)?;
    let s = mode_attack(REROLL)?.sample_miss_reroll(
        missed_eight(),
        REROLL,
        &mut Lcg::new(seed),
        None,
    )?;
    assert_eq!(s.outcome, AttackOutcome::Miss);
    assert_eq!(faces_and_kept(&s), (vec![8.0, 2.0], vec![false, true]));
    Ok(())
}

/// miss-reroll-natural.test.ts:33
#[test]
fn flat_reroll_the_reported_natural_is_the_replacement_d20_for_every_seed() -> T {
    for seed in 1..=200 {
        let s = mode_attack(REROLL)?.sample_miss_reroll(
            missed_eight(),
            REROLL,
            &mut Lcg::new(seed),
            None,
        )?;
        let replacement = s.check.get(1).map(|d| d.face).unwrap_or(0.0);
        assert_eq!(
            s.check.iter().map(|d| d.kept).collect::<Vec<_>>(),
            [false, true]
        );
        // 15 is the lowest face that hits AC 15 with no modifier; 1 always misses and 20 always crits.
        let want = if replacement == 20.0 {
            AttackOutcome::Crit
        } else if replacement >= 15.0 {
            AttackOutcome::Hit
        } else {
            AttackOutcome::Miss
        };
        assert_eq!(s.outcome, want, "seed {seed}");
    }
    Ok(())
}

/// miss-reroll-natural.test.ts:43
#[test]
fn add_d20_the_best_of_both_d20s_is_the_natural_as_before() -> T {
    let seed = seed_for(2.0, ADD)?;
    let s = mode_attack(ADD)?.sample_miss_reroll(missed_eight(), ADD, &mut Lcg::new(seed), None)?;
    assert_eq!(faces_and_kept(&s), (vec![8.0, 2.0], vec![true, false]));
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// src/builder/sample-miss-reroll.test.ts
// ---------------------------------------------------------------------------------------------

/// sample-miss-reroll.test.ts:18
#[test]
fn a_subtracted_d20_is_a_bonus_die_not_a_natural_face() -> T {
    // Brute force: hit share with the reroll, 77/200 = 0.385 (crit 0.084375).
    let attack = hit_1d8(
        &d20()
            .plus(5.0)?
            .minus_roll(&d20())?
            .ac(10.0)?
            .reroll_misses(ADD)?,
    )?;
    let mut rng = Lcg::new(7);
    let draws = 20_000;
    let mut hits = 0;
    for _ in 0..draws {
        if attack.sample(&mut rng, None)?.outcome == AttackOutcome::Hit {
            hits += 1;
        }
    }
    assert!((f64::from(hits) / f64::from(draws) - 0.385).abs() < 0.01);
    Ok(())
}

/// sample-miss-reroll.test.ts:28
#[test]
fn a_bonus_die_with_advantage_counts_its_kept_face() -> T {
    let attack = hit_1d8(
        &d20()
            .plus_roll(&d4().with_advantage()?)?
            .ac(15.0)?
            .reroll_misses(ADD)?,
    )?;
    // Natural 5; bonus d4 faces 1 and 4, the 4 kept: a miss at 9. Rerolled natural 11 + 4 = 15 hits.
    let first = AttackSample {
        outcome: AttackOutcome::Miss,
        check: vec![
            die_of(20.0, 5.0, true),
            die_of(4.0, 1.0, false),
            die_of(4.0, 4.0, true),
        ],
        damage: vec![],
        total: 0.0,
        payload: None,
    };
    let mut rng = scripted(&[11.0, 6.0]);
    let again = attack.sample_miss_reroll(first, ADD, &mut rng, None)?;
    rng.done()?;
    assert_eq!(again.outcome, AttackOutcome::Hit);
    Ok(())
}

fn stacked_attack() -> Result<AttackBuilder, DiceError> {
    hit_1d8(&d20().plus_roll(&d4())?.ac(15.0)?)
}

fn stacked_first() -> AttackSample {
    AttackSample {
        outcome: AttackOutcome::Miss,
        check: vec![die_of(20.0, 5.0, true), die_of(4.0, 4.0, true)],
        damage: vec![],
        total: 0.0,
        payload: None,
    }
}

fn kept_d20s(s: &AttackSample) -> Vec<f64> {
    s.check
        .iter()
        .filter(|d| d.sides == 20.0 && d.kept)
        .map(|d| d.face)
        .collect()
}

/// sample-miss-reroll.test.ts:60
#[test]
fn two_add_d20_rerolls_keep_the_bonus_d4_as_4_and_one_kept_d20() -> T {
    let attack = stacked_attack()?;
    let one = attack.sample_miss_reroll(stacked_first(), ADD, &mut scripted(&[6.0]), None)?;
    assert_eq!(one.outcome, AttackOutcome::Miss);
    assert_eq!(kept_d20s(&one), [6.0]);
    // 10 + 4 = 14 < 15: a miss (reading the 6 as a bonus would give 16, a hit).
    let two = attack.sample_miss_reroll(one, ADD, &mut scripted(&[10.0]), None)?;
    assert_eq!(two.outcome, AttackOutcome::Miss);
    assert_eq!(kept_d20s(&two), [10.0]);
    assert_eq!(
        two.check.iter().map(|d| d.face).collect::<Vec<_>>(),
        [5.0, 6.0, 10.0, 4.0]
    );
    Ok(())
}

/// sample-miss-reroll.test.ts:71
#[test]
fn a_reroll_then_an_add_d20_keeps_only_the_d20_in_play() -> T {
    let attack = stacked_attack()?;
    let one = attack.sample_miss_reroll(stacked_first(), REROLL, &mut scripted(&[3.0]), None)?;
    assert_eq!(kept_d20s(&one), [3.0]);
    let two = attack.sample_miss_reroll(one, ADD, &mut scripted(&[2.0]), None)?;
    assert_eq!(two.outcome, AttackOutcome::Miss);
    // The 5 the reroll dropped is not in play: the natural is max(3, 2).
    assert_eq!(kept_d20s(&two), [3.0]);
    let three = attack.sample_miss_reroll(two, ADD, &mut scripted(&[11.0, 1.0]), None)?;
    assert_eq!(three.outcome, AttackOutcome::Hit);
    assert_eq!(kept_d20s(&three), [11.0]);
    Ok(())
}

/// sample-miss-reroll.test.ts:83
#[test]
fn a_miss_rerolled_twice_lands_the_hit_share_of_the_exact_value() -> T {
    // Brute force: hit 0.7090625 after two add-d20 rerolls.
    let attack = stacked_attack()?;
    let mut rng = Lcg::new(11);
    let draws = 20_000;
    let mut hits = 0;
    for _ in 0..draws {
        let mut sample = attack.sample(&mut rng, None)?;
        let mut again = 0;
        while again < 2 && sample.outcome == AttackOutcome::Miss {
            sample = attack.sample_miss_reroll(sample, ADD, &mut rng, None)?;
            again += 1;
        }
        if sample.outcome == AttackOutcome::Hit {
            hits += 1;
        }
    }
    assert!((f64::from(hits) / f64::from(draws) - 0.7090625).abs() < 0.01);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/sample-attack.test.ts
// ---------------------------------------------------------------------------------------------

/// `d20.plus(5).ac(15).onHit(roll(2, 6, 3))`.
fn sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(rs(2.0, 6.0, Some(3.0))?)
}

fn d6_hit(check: &RollBuilder) -> Result<AttackBuilder, DiceError> {
    check.on_hit(d(6.0)?)
}

fn dmg_faces(s: &AttackSample) -> Vec<f64> {
    s.damage.iter().map(|d| d.face).collect()
}

/// sample-attack.test.ts:46
#[test]
fn misses_below_ac_and_rolls_no_damage() -> T {
    let s = sample_with(&sword()?, &[9.0], None)?; // 9 + 5 = 14 < 15
    assert_eq!(s.outcome, AttackOutcome::Miss);
    assert_eq!(s.total, 0.0);
    assert_eq!(s.damage, vec![]);
    assert_eq!(s.check, vec![die_of(20.0, 9.0, true)]);
    Ok(())
}

/// sample-attack.test.ts:53
#[test]
fn hits_at_ac_and_rolls_the_base_pool() -> T {
    let s = sample_with(&sword()?, &[10.0, 3.0, 4.0], None)?;
    assert_eq!(s.outcome, AttackOutcome::Hit);
    assert_eq!(s.total, 10.0);
    assert_eq!(dmg_faces(&s), [3.0, 4.0]);
    Ok(())
}

/// sample-attack.test.ts:59
#[test]
fn crits_on_a_natural_20_with_doubled_dice() -> T {
    let s = sample_with(&sword()?, &[20.0, 1.0, 2.0, 3.0, 4.0], None)?;
    assert_eq!(s.outcome, AttackOutcome::Crit);
    assert_eq!(s.total, 13.0);
    assert_eq!(s.damage.len(), 4);
    Ok(())
}

/// sample-attack.test.ts:65
#[test]
fn a_natural_1_misses_even_when_it_would_reach_ac() -> T {
    let a = d6_hit(&d20().plus(30.0)?.ac(10.0)?)?;
    assert_eq!(sample_with(&a, &[1.0], None)?.outcome, AttackOutcome::Miss);
    Ok(())
}

/// sample-attack.test.ts:69
#[test]
fn honours_crit_on_range_and_crit_on_hit_from_the_context() -> T {
    let a = d6_hit(&d20().plus(5.0)?.ac(15.0)?.crit_on(19.0)?)?;
    assert_eq!(
        sample_with(&a, &[19.0, 2.0, 2.0], None)?.outcome,
        AttackOutcome::Crit
    );
    let ctx = RowContext {
        crit_on_hit: true,
        ..flat_context()
    };
    let s = sword()?;
    assert_eq!(
        sample_with(&s, &[12.0, 1.0, 1.0, 1.0, 1.0], Some(&ctx))?.outcome,
        AttackOutcome::Crit
    );
    // crit-on-hit still has to reach the AC, and a natural 1 still misses
    assert_eq!(
        sample_with(&s, &[9.0], Some(&ctx))?.outcome,
        AttackOutcome::Miss
    );
    assert_eq!(
        sample_with(&s, &[1.0], Some(&ctx))?.outcome,
        AttackOutcome::Miss
    );
    Ok(())
}

/// sample-attack.test.ts:77
#[test]
fn rolls_advantage_from_the_context_unless_pinned() -> T {
    let ctx = with_type(RollType::Advantage);
    let s = sample_with(&sword()?, &[3.0, 17.0, 6.0, 6.0], Some(&ctx))?;
    assert_eq!(s.outcome, AttackOutcome::Hit);
    assert_eq!(
        s.check.iter().map(|x| x.kept).collect::<Vec<_>>(),
        [false, true]
    );
    let pinned = d20()
        .plus(5.0)?
        .pinned()?
        .ac(15.0)?
        .on_hit(rs(2.0, 6.0, Some(3.0))?)?;
    assert_eq!(
        sample_with(&pinned, &[3.0], Some(&ctx))?.outcome,
        AttackOutcome::Miss
    );
    Ok(())
}

/// sample-attack.test.ts:86
#[test]
fn rolls_three_dice_for_a_three_dice_advantage_attacker() -> T {
    let elf = d6_hit(
        &d20()
            .plus(5.0)?
            .with_advantage()?
            .ac(15.0)?
            .three_dice_advantage()?,
    )?;
    let s = sample_with(&elf, &[2.0, 3.0, 18.0, 4.0], None)?;
    assert_eq!(s.outcome, AttackOutcome::Hit);
    assert_eq!(
        s.check.iter().map(|x| x.kept).collect::<Vec<_>>(),
        [false, false, true]
    );
    Ok(())
}

/// sample-attack.test.ts:93
#[test]
fn draws_bonus_dice_after_the_d20_and_adds_them_to_the_check() -> T {
    let blessed = d6_hit(&d20().plus_roll(&d(4.0)?)?.plus(3.0)?.ac(15.0)?)?;
    let s = sample_with(&blessed, &[10.0, 2.0, 5.0], None)?; // 10 + 2 + 3 = 15 hits
    assert_eq!(s.outcome, AttackOutcome::Hit);
    assert_eq!(
        s.check
            .iter()
            .map(|x| (x.sides, x.face))
            .collect::<Vec<_>>(),
        [(20.0, 10.0), (4.0, 2.0)]
    );
    assert_eq!(
        sample_with(&blessed, &[10.0, 1.0], None)?.outcome,
        AttackOutcome::Miss
    );
    Ok(())
}

/// sample-attack.test.ts:104
#[test]
fn doubles_a_vulnerable_landing_as_a_whole_roll() -> T {
    let ctx = RowContext {
        vulnerable: true,
        ..flat_context()
    };
    assert_eq!(
        sample_with(&sword()?, &[10.0, 3.0, 4.0], Some(&ctx))?.total,
        20.0
    );
    Ok(())
}

/// sample-attack.test.ts:108
#[test]
fn half_on_miss_floors_half_the_hit_payload() -> T {
    let a = sword()?.half_on_miss()?;
    let s = sample_with(&a, &[2.0, 4.0, 5.0], None)?;
    assert_eq!(s.outcome, AttackOutcome::Miss);
    assert_eq!(s.total, 6.0);
    Ok(())
}

/// sample-attack.test.ts:113
#[test]
fn on_miss_draws_the_miss_payload() -> T {
    let a = sword()?.on_miss(&[Arg::Roll(d(4.0)?)])?;
    let s = sample_with(&a, &[2.0, 3.0], None)?;
    assert_eq!(s.outcome, AttackOutcome::Miss);
    assert_eq!(s.total, 3.0);
    assert_eq!(s.damage, vec![die_of(4.0, 3.0, true)]);
    Ok(())
}

/// sample-attack.test.ts:119
#[test]
fn separate_channels_follow_the_base_pool_and_double_on_a_crit() -> T {
    let a = d20()
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(d(8.0)?)?
        .plus_separate_damage(d(6.0)?);
    let hit = sample_with(&a, &[10.0, 5.0, 2.0], None)?;
    assert_eq!((hit.outcome, hit.total), (AttackOutcome::Hit, 7.0));
    let crit = sample_with(&a, &[20.0, 5.0, 5.0, 2.0, 2.0], None)?;
    assert_eq!((crit.outcome, crit.total), (AttackOutcome::Crit, 14.0));
    assert_eq!(
        crit.damage.iter().map(|x| x.sides).collect::<Vec<_>>(),
        [8.0, 8.0, 6.0, 6.0]
    );
    Ok(())
}

/// sample-attack.test.ts:127
#[test]
fn no_crit_lands_a_natural_20_as_a_hit() -> T {
    let s = sample_with(&sword()?.no_crit()?, &[20.0, 3.0, 4.0], None)?;
    assert_eq!((s.outcome, s.total), (AttackOutcome::Hit, 10.0));
    Ok(())
}

/// sample-attack.test.ts:132
#[test]
fn always_hits_never_misses_and_crits_in_the_crit_range() -> T {
    let sure = d6_hit(&d20().plus(5.0)?.ac(15.0)?.always_hits()?)?;
    let a = sample_with(&sure, &[1.0, 2.0], None)?;
    assert_eq!((a.outcome, a.total), (AttackOutcome::Hit, 2.0));
    let b = sample_with(&sure, &[20.0, 2.0, 3.0], None)?;
    assert_eq!((b.outcome, b.total), (AttackOutcome::Crit, 5.0));
    // an autoHit context on a plain attack is the same
    let ctx = RowContext {
        auto_hit: true,
        ..flat_context()
    };
    let c = sample_with(&sword()?, &[1.0, 2.0, 2.0], Some(&ctx))?;
    assert_eq!((c.outcome, c.total), (AttackOutcome::Hit, 7.0));
    Ok(())
}

/// sample-attack.test.ts:140
#[test]
fn always_crits_crits_every_hit_but_still_needs_the_ac_and_misses_a_natural_1() -> T {
    let brutal = d6_hit(&d20().plus(5.0)?.ac(15.0)?.always_crits()?)?;
    let a = sample_with(&brutal, &[10.0, 2.0, 3.0], None)?;
    assert_eq!((a.outcome, a.total), (AttackOutcome::Crit, 5.0));
    assert_eq!(
        sample_with(&brutal, &[9.0], None)?.outcome,
        AttackOutcome::Miss
    );
    assert_eq!(
        sample_with(&brutal, &[1.0], None)?.outcome,
        AttackOutcome::Miss
    );
    // alwaysHits().alwaysCrits() draws no check at all
    let sure = d6_hit(&d20().plus(5.0)?.ac(15.0)?.always_hits()?.always_crits()?)?;
    let s = sample_with(&sure, &[2.0, 3.0], None)?;
    assert_eq!((s.outcome, s.total), (AttackOutcome::Crit, 5.0));
    assert_eq!(s.check, vec![]);
    Ok(())
}

/// sample-attack.test.ts:152 (`toBe(sword)`: the unchanged attack is asserted as an equal
/// expression and check key).
#[test]
fn roll_under_returns_the_attack_re_derived_in_the_context() -> T {
    let s = sword()?;
    let under = s.roll_under(&with_type(RollType::Advantage))?;
    assert_eq!(under.check.roll_type(), RollType::Advantage);
    let same = s.roll_under(&flat_context())?;
    assert_eq!(same.to_expression()?, s.to_expression()?);
    assert_eq!(same.check.cache_key(), s.check.cache_key());
    Ok(())
}

/// sample-attack.test.ts:157
#[test]
fn tracks_the_pmf_mean() -> T {
    struct Seeded {
        st: u32,
    }
    impl Rng for Seeded {
        fn die(&mut self, n: f64) -> f64 {
            self.st = self.st.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(self.st % n as u32) + 1.0
        }
        fn chance(&mut self, _p: f64) -> bool {
            false
        }
    }
    let mut rng = Seeded { st: 99 };
    let a = d20()
        .plus(7.0)?
        .with_advantage()?
        .ac(16.0)?
        .crit_on(19.0)?
        .on_hit(rs(2.0, 8.0, Some(4.0))?)?
        .plus_separate_damage(rs(1.0, 6.0, None)?);
    let n = 40_000;
    let mut sum = 0.0;
    for _ in 0..n {
        sum += a.sample(&mut rng, None)?.total;
    }
    assert_close(sum / f64::from(n), a.pmf()?.mean(), 0);
    Ok(())
}

/// mulberry32 of `sample-attack.test.ts` (`floor(u32 / 2^32 * n) + 1`).
struct Mulberry {
    a: u32,
}

impl Rng for Mulberry {
    fn die(&mut self, n: f64) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        let u = t ^ (t >> 14);
        (f64::from(u) / 4_294_967_296.0 * n).floor() + 1.0
    }
    fn chance(&mut self, _p: f64) -> bool {
        false
    }
}

/// sample-attack.test.ts:173
#[test]
fn tracks_under_context_for_every_context_flag() -> T {
    let mut rng = Mulberry { a: 5 };
    let a = d20()
        .plus_roll(&d(4.0)?)?
        .plus(6.0)?
        .ac(17.0)?
        .crit_on(19.0)?
        .on_hit(rs(1.0, 10.0, Some(4.0))?)?
        .plus_separate_damage(rs(2.0, 6.0, None)?)
        .half_on_miss()?;
    let f = flat_context();
    let contexts = [
        with_type(RollType::Advantage),
        RowContext {
            roll_type: RollType::Disadvantage,
            vulnerable: true,
            ..f.clone()
        },
        RowContext {
            roll_type: RollType::ElvenAccuracy,
            crit_on_hit: true,
            ..f.clone()
        },
        RowContext {
            auto_hit: true,
            ..f.clone()
        },
        RowContext {
            auto_hit: true,
            crit_on_hit: true,
            vulnerable: true,
            ..f
        },
    ];
    let n = 20_000;
    for ctx in &contexts {
        let mut sum = 0.0;
        for _ in 0..n {
            sum += a.sample(&mut rng, Some(ctx))?.total;
        }
        assert_close(sum / f64::from(n), a.under(ctx, 0.0)?.mean(), 0);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/miss-reroll-cache-exactness.test.ts (non-turn part)
// ---------------------------------------------------------------------------------------------

/// `pmfBits`: every value's probability under every label and overall, as exact bits.
fn pmf_bits(pmf: &Pmf) -> Vec<String> {
    let mut labels = pmf.outcomes();
    labels.sort();
    let mut lines = vec![format!(
        "mean {:016x} mass {:016x}",
        pmf.mean().to_bits(),
        pmf.mass().to_bits()
    )];
    let mut values: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    values.sort_by(f64::total_cmp);
    for v in values {
        let per_label: Vec<String> = labels
            .iter()
            .map(|l| format!("{l}={:016x}", pmf.filter_outcome(l).p_at(v).to_bits()))
            .collect();
        lines.push(format!(
            "{v} {:016x} {}",
            pmf.p_at(v).to_bits(),
            per_label.join(" ")
        ));
    }
    lines
}

/// miss-reroll-cache-exactness.test.ts:43: the PMF half. The Rust port has no rerolled-miss cache
/// (`toBe` / `not.toBe` identity of two `missRerolled` results is deferred); a rebuilt row gives
/// the same PMF bit for bit.
#[test]
fn equal_rows_give_one_rerolled_pmf_bit_for_bit() -> T {
    let row = |ac: f64| -> Result<AttackBuilder, DiceError> {
        let a = d20()
            .plus(7.0)?
            .with_advantage()?
            .ac(ac)?
            .crit_on(19.0)?
            .on_hit(rd(1.0, d8())?.plus(4.0)?)?;
        Ok(a.plus_separate_damage(rd(1.0, d6())?))
    };
    let first = row(15.0)?.miss_rerolled(REROLL, None, 0.0)?;
    let cold = pmf_bits(&first);
    let fresh = row(15.0)?.miss_rerolled(REROLL, None, 0.0)?;
    assert_eq!(pmf_bits(&fresh), cold);
    assert_eq!(fresh.mean().to_bits(), first.mean().to_bits());
    assert_eq!(fresh.mass().to_bits(), first.mass().to_bits());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// tests/enumerate-dice.ts (the brute-force oracle) and the parse tests
// ---------------------------------------------------------------------------------------------

type Dist = BTreeMap<i64, f64>;
type Lab = BTreeMap<i64, BTreeMap<String, f64>>;

fn point(v: i64) -> Dist {
    BTreeMap::from([(v, 1.0)])
}

fn uniform(sides: i64) -> Dist {
    (1..=sides).map(|f| (f, 1.0 / sides as f64)).collect()
}

fn combine(x: &Dist, y: &Dist, f: impl Fn(i64, i64) -> i64) -> Dist {
    let mut out = Dist::new();
    for (a, pa) in x {
        for (b, pb) in y {
            *out.entry(f(*a, *b)).or_insert(0.0) += pa * pb;
        }
    }
    out
}

fn add(parts: &[&Dist]) -> Dist {
    parts
        .iter()
        .fold(point(0), |acc, p| combine(&acc, p, |a, b| a + b))
}

fn repeat(x: &Dist, times: usize) -> Dist {
    add(&vec![x; times])
}

fn map_dist(x: &Dist, f: impl Fn(i64) -> i64) -> Dist {
    let mut out = Dist::new();
    for (v, p) in x {
        *out.entry(f(*v)).or_insert(0.0) += p;
    }
    out
}

fn negate(x: &Dist) -> Dist {
    map_dist(x, |v| -v)
}

fn max_dist(x: &Dist, y: &Dist) -> Dist {
    combine(x, y, i64::max)
}

/// `plus(...parts)` of the trailing-payload test: a sum of distributions and flats.
fn plus(parts: &[&Dist]) -> Dist {
    add(parts)
}

/// `AttackSpec` of `enumerate-dice.ts`.
struct AttackSpec {
    natural: Dist,
    bonus: Dist,
    target: i64,
    crit_from: i64,
    hit: Dist,
    crit: Dist,
    miss: Option<(Dist, &'static str)>,
}

fn spec(
    natural: &Dist,
    bonus: &Dist,
    target: i64,
    crit_from: i64,
    hit: &Dist,
    crit: &Dist,
) -> AttackSpec {
    AttackSpec {
        natural: natural.clone(),
        bonus: bonus.clone(),
        target,
        crit_from,
        hit: hit.clone(),
        crit: crit.clone(),
        miss: None,
    }
}

impl AttackSpec {
    fn miss(mut self, miss: &Dist, label: &'static str) -> AttackSpec {
        self.miss = Some((miss.clone(), label));
        self
    }
}

fn put(out: &mut Lab, value: i64, label: &str, p: f64) {
    *out.entry(value)
        .or_default()
        .entry(label.to_string())
        .or_insert(0.0) += p;
}

/// `attack(spec)`: an attack under `parse()`'s rules, by listing every natural roll and bonus.
fn attack(s: &AttackSpec) -> Lab {
    let mut out = Lab::new();
    for (natural, pn) in &s.natural {
        for (bonus, pb) in &s.bonus {
            let p = pn * pb;
            if natural + bonus >= s.target {
                let (label, damage) = if *natural >= s.crit_from {
                    ("crit", &s.crit)
                } else {
                    ("hit", &s.hit)
                };
                for (v, pv) in damage {
                    put(&mut out, *v, label, p * pv);
                }
            } else if let Some((miss, label)) = &s.miss {
                for (v, pv) in miss {
                    put(&mut out, *v, label, p * pv);
                }
            } else {
                put(&mut out, 0, "missNone", p);
            }
        }
    }
    out
}

/// `mixLabelled`: each part weighted by its share.
fn mix_labelled(parts: &[(&Lab, f64)]) -> Lab {
    let mut out = Lab::new();
    for (part, weight) in parts {
        for (v, labels) in *part {
            for (l, p) in labels {
                put(&mut out, *v, l, weight * p);
            }
        }
    }
    out
}

fn labels_of(pmf: &Pmf, value: i64) -> BTreeMap<String, f64> {
    pmf.map
        .get(&Damage(value as f64))
        .map(|b| b.count.iter().map(|(k, p)| (k.clone(), *p)).collect())
        .unwrap_or_default()
}

/// `expectLabelled`: every bin of `actual` and every label in it equals `expected` to 1e-12.
fn expect_labelled(actual: &Pmf, expected: &Lab) -> T {
    let mut support: BTreeSet<i64> = actual.support().iter().map(|d| d.0 as i64).collect();
    support.extend(expected.keys().copied());
    for v in support {
        let want = expected.get(&v).cloned().unwrap_or_default();
        let total: f64 = want.values().sum();
        let diff = (actual.p_at(v as f64) - total).abs();
        if diff > TOLERANCE {
            return Err(DiceError::error(format!(
                "bin {v}: {} vs {total}",
                actual.p_at(v as f64)
            )));
        }
        let got = labels_of(actual, v);
        let labels: BTreeSet<&String> = got.keys().chain(want.keys()).collect();
        for l in labels {
            let g = got.get(l).copied().unwrap_or(0.0);
            let w = want.get(l).copied().unwrap_or(0.0);
            if (g - w).abs() > TOLERANCE {
                return Err(DiceError::error(format!("bin {v} {l}: {g} vs {w}")));
            }
        }
    }
    if (actual.mass() - 1.0).abs() > TOLERANCE {
        return Err(DiceError::error(format!("mass {}", actual.mass())));
    }
    Ok(())
}

/// `expectSameLabelled`: two PMFs agree bin for bin and label for label.
fn expect_same_labelled(actual: &Pmf, expected: &Pmf) -> T {
    let mut lab = Lab::new();
    for d in expected.support() {
        lab.insert(d.0 as i64, labels_of(expected, d.0 as i64));
    }
    expect_labelled(actual, &lab)
}

fn p(expr: &str) -> Result<Pmf, DiceError> {
    parse(expr)
}

fn built(a: &AttackBuilder) -> Result<Pmf, DiceError> {
    a.to_pmf(0.0)
}

fn lab_of(entries: &[(i64, &[(&str, f64)])]) -> Lab {
    entries
        .iter()
        .map(|(v, ls)| (*v, ls.iter().map(|(l, p)| (l.to_string(), *p)).collect()))
        .collect()
}

// ---- tests/parse-landed-at-zero.test.ts ----

fn zero_attack(natural: &Dist, bonus: &Dist, target: i64, crit_from: i64) -> AttackSpec {
    let d6 = uniform(6);
    spec(natural, bonus, target, crit_from, &d6, &repeat(&d6, 2))
}

/// `d20.<minus>.ac(target).onHit(roll(1, d6))`.
fn d20_minus_ac(minus: f64, ac: f64) -> Result<AttackBuilder, DiceError> {
    d20().minus(minus)?.ac(ac)?.on_hit(rd(1.0, d6())?)
}

/// parse-landed-at-zero.test.ts:21
#[test]
fn d20_minus_5_ac_0_a_natural_5_hits_like_the_builders_attack() -> T {
    let parsed = p("(d20 - 5 AC 0) * (1d6)")?;
    expect_labelled(
        &parsed,
        &attack(&zero_attack(&uniform(20), &point(-5), 0, 20)),
    )?;
    expect_same_labelled(&parsed, &built(&d20_minus_ac(5.0, 0.0)?)?)?;
    assert_close(parsed.mean(), 2.975, 12);
    assert_close(parsed.outcome_probability("hit"), 0.75, 12);
    assert_close(parsed.outcome_probability("missNone"), 0.2, 12);
    Ok(())
}

/// parse-landed-at-zero.test.ts:30
#[test]
fn the_builders_printed_string_reads_back_to_the_builder() -> T {
    let b = d20_minus_ac(5.0, 0.0)?;
    expect_same_labelled(&p(&b.to_expression()?)?, &built(&b)?)
}

/// parse-landed-at-zero.test.ts:35
#[test]
fn a_crit_clause_applies_to_the_hits_that_total_0() -> T {
    let parsed = p("(d20 - 5 AC 0) * (1d6) crit (2d6)")?;
    expect_labelled(
        &parsed,
        &attack(&zero_attack(&uniform(20), &point(-5), 0, 20)),
    )
}

/// parse-landed-at-zero.test.ts:40
#[test]
fn a_natural_20_that_totals_exactly_0_crits() -> T {
    let parsed = p("(d20 - 20 AC 0) * (1d6)")?;
    expect_labelled(
        &parsed,
        &attack(&zero_attack(&uniform(20), &point(-20), 0, 20)),
    )?;
    expect_same_labelled(&parsed, &built(&d20_minus_ac(20.0, 0.0)?)?)
}

/// parse-landed-at-zero.test.ts:46
#[test]
fn an_xcrit_range_crits_on_a_natural_face_whose_total_is_exactly_0() -> T {
    let parsed = p("(d20 - 19 AC 0) * (1d6) xcrit2 (2d6)")?;
    expect_labelled(
        &parsed,
        &attack(&zero_attack(&uniform(20), &point(-19), 0, 19)),
    )
}

/// parse-landed-at-zero.test.ts:51
#[test]
fn after_xcrit0_every_landing_is_a_hit_one_that_totals_0_included() -> T {
    let parsed = p("(d20 - 5 AC 0) * (1d6) xcrit0 (1d6)")?;
    let d6 = uniform(6);
    expect_labelled(
        &parsed,
        &attack(&spec(&uniform(20), &point(-5), 0, 21, &d6, &d6)),
    )?;
    expect_same_labelled(&parsed, &built(&d20_minus_ac(5.0, 0.0)?.no_crit()?)?)
}

/// parse-landed-at-zero.test.ts:57
#[test]
fn with_advantage_the_kept_natural_roll_lands_at_0_and_crits_on_a_20() -> T {
    let parsed = p("(d20 > d20 - 5 AC 0) * (1d6)")?;
    let natural = max_dist(&uniform(20), &uniform(20));
    expect_labelled(&parsed, &attack(&zero_attack(&natural, &point(-5), 0, 20)))?;
    let b = d20()
        .with_advantage()?
        .minus(5.0)?
        .ac(0.0)?
        .on_hit(rd(1.0, d6())?)?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-landed-at-zero.test.ts:64 (`it.each`: three rows)
#[test]
fn a_total_of_0_from_bonus_or_subtracted_dice_lands() -> T {
    let rows: [(&str, Dist, i64); 3] = [
        (
            "(d20 - 8 + 1d4 AC 0) * (1d6)",
            add(&[&point(-8), &uniform(4)]),
            0,
        ),
        ("(d20 - 1d10 AC 0) * (1d6)", negate(&uniform(10)), 0),
        (
            "(d20 - 12 - 1d4 AC -3) * (1d6)",
            add(&[&point(-12), &negate(&uniform(4))]),
            -3,
        ),
    ];
    for (expression, bonus, target) in rows {
        expect_labelled(
            &p(expression)?,
            &attack(&zero_attack(&uniform(20), &bonus, target, 20)),
        )
        .map_err(|e| format!("{expression}: {e}"))?;
    }
    Ok(())
}

/// parse-landed-at-zero.test.ts:73
#[test]
fn a_check_with_no_die_that_totals_0_always_lands() -> T {
    expect_labelled(
        &p("(5 - 5 AC 0) * (1d6)")?,
        &attack(&zero_attack(&point(0), &point(0), 0, 21)),
    )
}

/// parse-landed-at-zero.test.ts:77
#[test]
fn the_check_on_its_own_labels_a_landed_total_of_0_a_hit() -> T {
    let mut expected = Lab::new();
    for n in 1..=20i64 {
        if n - 5 > 0 {
            put(&mut expected, n - 5, "hit", 1.0 / 20.0);
        }
    }
    expected.insert(
        0,
        BTreeMap::from([
            ("hit".to_string(), 1.0 / 20.0),
            ("missNone".to_string(), 4.0 / 20.0),
        ]),
    );
    expect_labelled(&p("d20 - 5 AC 0")?, &expected)
}

/// parse-landed-at-zero.test.ts:86
#[test]
fn a_miss_clause_deals_its_damage_to_the_misses_only() -> T {
    let parsed = p("(d20 - 5 AC 0) * (1d6) crit (2d6) miss (1)")?;
    let s = zero_attack(&uniform(20), &point(-5), 0, 20).miss(&point(1), "missDamage");
    expect_labelled(&parsed, &attack(&s))?;
    let b = d20_minus_ac(5.0, 0.0)?.on_miss(&[Arg::Num(1.0)])?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-landed-at-zero.test.ts:93
#[test]
fn with_a_negative_target_the_misses_are_the_checks_that_fall_short() -> T {
    let parsed = p("(d20 - 10 AC -5) * (1d6) crit (2d6) miss (1)")?;
    let s = zero_attack(&uniform(20), &point(-10), -5, 20).miss(&point(1), "missDamage");
    expect_labelled(&parsed, &attack(&s))?;
    let b = d20_minus_ac(10.0, -5.0)?.on_miss(&[Arg::Num(1.0)])?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-landed-at-zero.test.ts:100
#[test]
fn pc_deals_half_its_damage_to_the_misses_only() -> T {
    let halved = map_dist(&uniform(6), |v| v.div_euclid(2));
    let s = zero_attack(&uniform(20), &point(-5), 0, 20).miss(&halved, "pc");
    expect_labelled(
        &p("(d20 - 5 AC 0) * (1d6) crit (2d6) pc (1d6)")?,
        &attack(&s),
    )
}

/// parse-landed-at-zero.test.ts:108
#[test]
fn an_and_mix_of_attack_checks_lands_each_sides_totals_of_0() -> T {
    let low = attack(&zero_attack(&uniform(20), &point(-5), 0, 20));
    let plain = attack(&zero_attack(&uniform(20), &point(0), 10, 20));
    let mixed = mix_labelled(&[(&low, 0.5), (&plain, 0.5)]);
    expect_labelled(&p("((d20 - 5 AC 0) & (d20 AC 10)) * (1d6)")?, &mixed)?;
    expect_labelled(&p("((d20 AC 10) & (d20 - 5 AC 0)) * (1d6)")?, &mixed)
}

// ---- tests/parse-trailing-payload-term.test.ts ----

/// `onD20Plus5(target, hit, crit, critFrom)`.
fn on_d20_plus_5(target: i64, hit: &Dist, crit: &Dist, crit_from: i64) -> Lab {
    attack(&spec(&uniform(20), &point(5), target, crit_from, hit, crit))
}

/// `roll(1, d4).minus(1).plus(d6)`.
fn d4_minus_1_plus_d6() -> Result<RollBuilder, DiceError> {
    rd(1.0, d4())?.minus(1.0)?.plus_roll(&d6())
}

/// parse-trailing-payload-term.test.ts:23
#[test]
fn trailing_d6_is_added_to_a_hit_whose_payload_rolled_0_like_the_builder() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) + 1d6")?;
    let (d4, d6) = (uniform(4), uniform(6));
    // The crit doubles every die of the whole payload: 2d4 - 1 + 2d6.
    let hit = plus(&[&d4, &point(-1), &d6]);
    let crit = plus(&[&repeat(&d4, 2), &point(-1), &repeat(&d6, 2)]);
    expect_labelled(&parsed, &on_d20_plus_5(12, &hit, &crit, 20))?;
    let b = d20().plus(5.0)?.ac(12.0)?.on_hit(d4_minus_1_plus_d6()?)?;
    expect_same_labelled(&parsed, &built(&b)?)?;
    assert_close(parsed.mean(), 3.8, 12);
    Ok(())
}

/// parse-trailing-payload-term.test.ts:31
#[test]
fn a_trailing_flat_is_added_once_on_hits_and_crits_alike() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) + 3")?;
    let d4 = uniform(4);
    let hit = plus(&[&d4, &point(2)]);
    let crit = plus(&[&repeat(&d4, 2), &point(2)]);
    expect_labelled(&parsed, &on_d20_plus_5(12, &hit, &crit, 20))?;
    let b = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rd(1.0, factory::d4())?.minus(1.0)?.plus(3.0)?)?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-trailing-payload-term.test.ts:37
#[test]
fn each_of_several_trailing_terms_adds_even_where_the_running_payload_is_0() -> T {
    // 1d2 - 1 is 0 half the time: the payload is 0 until the 1d6.
    let (d6, d2) = (uniform(6), uniform(2));
    let coin = plus(&[&d2, &point(-1)]);
    let parsed = p("(d20 + 5 AC 12) * (1d2 - 1) + (1d2 - 1) + 1d6")?;
    let doubled_coin = plus(&[&repeat(&d2, 2), &point(-1)]);
    let hit = plus(&[&coin, &coin, &d6]);
    let crit = plus(&[&doubled_coin, &doubled_coin, &repeat(&d6, 2)]);
    expect_labelled(&parsed, &on_d20_plus_5(12, &hit, &crit, 20))
}

/// parse-trailing-payload-term.test.ts:45
#[test]
fn after_a_crit_clause_the_term_is_added_to_the_crit_as_written_a_crit_of_0_included() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) crit (1d4 - 1) + 1d6")?;
    let (d4, d6) = (uniform(4), uniform(6));
    let both = plus(&[&d4, &point(-1), &d6]);
    expect_labelled(&parsed, &on_d20_plus_5(12, &both, &both, 20))?;
    let b = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(d4_minus_1_plus_d6()?)?
        .on_crit(&[Arg::Roll(d4_minus_1_plus_d6()?)])?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-trailing-payload-term.test.ts:52
#[test]
fn after_xcrit0_every_landing_is_a_hit_that_takes_the_term() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) xcrit0 (1d4 - 1) + 1d6")?;
    let hit = plus(&[&uniform(4), &point(-1), &uniform(6)]);
    expect_labelled(&parsed, &on_d20_plus_5(12, &hit, &point(0), 21))?;
    let b = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(d4_minus_1_plus_d6()?)?
        .no_crit()?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-trailing-payload-term.test.ts:58
#[test]
fn a_slash_slash_2_payload_that_rounds_to_0_still_takes_the_term() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4) // 2 + 1d6")?;
    let halve = |d: &Dist| map_dist(d, |v| v.div_euclid(2));
    let (d4, d6) = (uniform(4), uniform(6));
    let hit = plus(&[&halve(&d4), &d6]);
    let crit = plus(&[&halve(&repeat(&d4, 2)), &repeat(&d6, 2)]);
    expect_labelled(&parsed, &on_d20_plus_5(12, &hit, &crit, 20))
}

/// parse-trailing-payload-term.test.ts:64
#[test]
fn a_miss_stays_0_and_a_miss_clauses_damage_takes_the_term_a_miss_of_0_included() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d6) miss (1d4 - 1) + 3")?;
    let (d6, d4) = (uniform(6), uniform(4));
    let s = spec(
        &uniform(20),
        &point(5),
        12,
        20,
        &plus(&[&d6, &point(3)]),
        &plus(&[&repeat(&d6, 2), &point(3)]),
    )
    .miss(&plus(&[&d4, &point(2)]), "missDamage");
    expect_labelled(&parsed, &attack(&s))?;
    let b = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rd(1.0, factory::d6())?.plus(3.0)?)?
        .on_miss(&[Arg::Roll(rd(1.0, factory::d4())?.minus(1.0)?.plus(3.0)?)])?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// parse-trailing-payload-term.test.ts:71
#[test]
fn a_check_that_lands_at_a_total_of_0_takes_the_term_on_its_0_damage_hits_too() -> T {
    let parsed = p("(d20 - 5 AC 0) * (1d4 - 1) + 1d6")?;
    let (d4, d6) = (uniform(4), uniform(6));
    let s = spec(
        &uniform(20),
        &point(-5),
        0,
        20,
        &plus(&[&d4, &point(-1), &d6]),
        &plus(&[&repeat(&d4, 2), &point(-1), &repeat(&d6, 2)]),
    );
    expect_labelled(&parsed, &attack(&s))?;
    let b = d20().minus(5.0)?.ac(0.0)?.on_hit(d4_minus_1_plus_d6()?)?;
    expect_same_labelled(&parsed, &built(&b)?)
}

/// A parsed PMF's bins as `{ value: { label: p } }`, labels rounded to 1e-12 (`Math.round`).
fn bins(expr: &str) -> Result<Lab, DiceError> {
    let pmf = p(expr)?;
    let mut out = Lab::new();
    for d in pmf.support() {
        let v = d.0 as i64;
        let rounded = labels_of(&pmf, v)
            .into_iter()
            .map(|(k, x)| (k, (x * 1e12 + 0.5).floor() / 1e12))
            .collect();
        out.insert(v, rounded);
    }
    Ok(out)
}

/// parse-trailing-payload-term.test.ts:91
#[test]
fn a_potent_cantrip_half_that_rounds_to_0_takes_the_term() -> T {
    // +5 vs AC 15 lands on 10..20: hit 1/2, crit 1/20, miss 9/20 dealing half of the pc (1), i.e. 0.
    assert_eq!(
        bins("(d20 + 5 AC 15) * (1d2) pc (1) + 3")?,
        lab_of(&[
            (3, &[("pc", 0.45)]),
            (4, &[("hit", 0.25)]),
            (5, &[("hit", 0.25), ("crit", 0.0125)]),
            (6, &[("crit", 0.025)]),
            (7, &[("crit", 0.0125)]),
        ])
    );
    Ok(())
}

/// parse-trailing-payload-term.test.ts:102
#[test]
fn a_failed_save_whose_payload_rolled_0_takes_the_term_a_success_stays_0() -> T {
    // d20 vs DC 15 fails on 1..14 (7/10); 1d2 - 1 is 0 or 1.
    assert_eq!(
        bins("(d20 DC 15) * (1d2 - 1) + 3")?,
        lab_of(&[
            (0, &[("missNone", 0.3)]),
            (3, &[("saveFail", 0.35)]),
            (4, &[("saveFail", 0.35)]),
        ])
    );
    assert_close(p("(d20 DC 15) * (1d2 - 1) + 3")?.mean(), 0.7 * 3.5, 12);
    Ok(())
}

/// parse-trailing-payload-term.test.ts:112
#[test]
fn a_halved_save_that_rounds_to_0_takes_the_term_like_every_other_halved_result() -> T {
    // Success 3/10 halves 1d2 to 0 or 1; failure 7/10 deals 1d2.
    assert_eq!(
        bins("(d20 DC 15) * (1d2) save half + 3")?,
        lab_of(&[
            (3, &[("saveHalf", 0.15)]),
            (4, &[("saveHalf", 0.15), ("saveFail", 0.35)]),
            (5, &[("saveFail", 0.35)]),
        ])
    );
    Ok(())
}

// ---- tests/zero-damage-hit-labels.test.ts ----

/// `labelMass`: outcome label -> total probability, over every bin.
fn label_mass(pmf: &Pmf) -> BTreeMap<String, f64> {
    let mut mass = BTreeMap::new();
    for bin in pmf.map.values() {
        for (l, x) in &bin.count {
            *mass.entry(l.clone()).or_insert(0.0) += x;
        }
    }
    mass
}

fn expect_labels(actual: &BTreeMap<String, f64>, expected: &[(&str, f64)], context: &str) -> T {
    let want: BTreeMap<String, f64> = expected.iter().map(|(l, x)| (l.to_string(), *x)).collect();
    expect_label_maps(actual, &want, context)
}

fn expect_label_maps(
    actual: &BTreeMap<String, f64>,
    want: &BTreeMap<String, f64>,
    context: &str,
) -> T {
    let labels: BTreeSet<&String> = actual.keys().chain(want.keys()).collect();
    for l in labels {
        let a = actual.get(l).copied().unwrap_or(0.0);
        let w = want.get(l).copied().unwrap_or(0.0);
        if (a - w).abs() > TOLERANCE {
            return Err(DiceError::error(format!("{context}: {l}: {a} vs {w}")));
        }
    }
    Ok(())
}

/// zero-damage-hit-labels.test.ts:29
#[test]
fn a_hit_payload_that_rolls_0_is_labelled_hit_not_miss_none() -> T {
    // d20 + 5 vs AC 12: hits on 7..19 (13/20), crits on 20; 1d4 - 1 rolls 0 a quarter of the time.
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1)")?;
    expect_labels(
        &label_mass(&parsed),
        &[
            ("hit", 13.0 / 20.0),
            ("crit", 1.0 / 20.0),
            ("missNone", 6.0 / 20.0),
        ],
        "totals",
    )?;
    expect_labels(
        &labels_of(&parsed, 0),
        &[("hit", 13.0 / 80.0), ("missNone", 6.0 / 20.0)],
        "bin 0",
    )
}

/// zero-damage-hit-labels.test.ts:36
#[test]
fn matches_the_builder_it_was_printed_from_bin_by_bin() -> T {
    let attack = d20()
        .plus(5.0)?
        .ac(12.0)?
        .on_hit(rd(1.0, d4())?.minus(1.0)?)?;
    let expression = attack.to_expression()?;
    assert_eq!(expression, "(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1)");
    let parsed = p(&expression)?;
    let built = attack.to_pmf(0.0)?;
    let mut values: BTreeSet<i64> = parsed.support().iter().map(|d| d.0 as i64).collect();
    values.extend(built.support().iter().map(|d| d.0 as i64));
    for v in values {
        assert!(
            (parsed.p_at(v as f64) - built.p_at(v as f64)).abs() <= TOLERANCE,
            "bin {v}"
        );
        expect_label_maps(
            &labels_of(&parsed, v),
            &labels_of(&built, v),
            &format!("bin {v}"),
        )?;
    }
    Ok(())
}

/// zero-damage-hit-labels.test.ts:60
#[test]
fn a_crit_that_rolls_0_stays_a_crit() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) crit (1d4 - 1)")?;
    expect_labels(
        &label_mass(&parsed),
        &[
            ("hit", 13.0 / 20.0),
            ("crit", 1.0 / 20.0),
            ("missNone", 6.0 / 20.0),
        ],
        "totals",
    )?;
    expect_labels(
        &labels_of(&parsed, 0),
        &[
            ("hit", 13.0 / 80.0),
            ("crit", 1.0 / 80.0),
            ("missNone", 6.0 / 20.0),
        ],
        "bin 0",
    )
}

/// zero-damage-hit-labels.test.ts:66
#[test]
fn a_payload_of_0_hits_and_crits_for_nothing() -> T {
    let parsed = p("(d20 + 5 AC 12) * (0) crit (0)")?;
    expect_labels(
        &labels_of(&parsed, 0),
        &[
            ("hit", 13.0 / 20.0),
            ("crit", 1.0 / 20.0),
            ("missNone", 6.0 / 20.0),
        ],
        "bin 0",
    )
}

/// zero-damage-hit-labels.test.ts:71
#[test]
fn with_a_miss_payload_the_0_damage_hits_are_hits_and_the_misses_are_miss_damage() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1) miss (1d4 - 1)")?;
    expect_labels(
        &label_mass(&parsed),
        &[
            ("hit", 13.0 / 20.0),
            ("crit", 1.0 / 20.0),
            ("missDamage", 6.0 / 20.0),
        ],
        "totals",
    )?;
    expect_labels(
        &labels_of(&parsed, 0),
        &[("hit", 13.0 / 80.0), ("missDamage", 6.0 / 80.0)],
        "bin 0",
    )
}

/// zero-damage-hit-labels.test.ts:77
#[test]
fn an_attack_with_no_crit_clause_labels_its_0_damage_hits_too() -> T {
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1)")?;
    expect_labels(
        &label_mass(&parsed),
        &[
            ("hit", 13.0 / 20.0),
            ("crit", 1.0 / 20.0),
            ("missNone", 6.0 / 20.0),
        ],
        "totals",
    )
}

/// zero-damage-hit-labels.test.ts:82
#[test]
fn a_trailing_plus_adds_to_the_0_damage_hits_too_and_the_misses_stay_at_0() -> T {
    // The 0-damage hits deal 3; 1d4 - 1 + 3 is 3..6, a quarter each of the 13/20 hits.
    let parsed = p("(d20 + 5 AC 12) * (1d4 - 1) crit (2d4 - 1) + 3")?;
    expect_labels(&labels_of(&parsed, 0), &[("missNone", 6.0 / 20.0)], "bin 0")?;
    expect_labels(&labels_of(&parsed, 3), &[("hit", 13.0 / 80.0)], "bin 3")
}

/// zero-damage-hit-labels.test.ts:89
#[test]
fn a_trailing_term_that_brings_a_landed_hit_to_0_keeps_it_a_hit() -> T {
    // 1d4 // 4 is 0 on 1..3 and 1 on a 4.
    let parsed = p("(d20 + 5 AC 12) * (1d4) crit (2d4) // 4")?;
    expect_labels(
        &labels_of(&parsed, 0),
        &[
            ("hit", (13.0 / 20.0) * (3.0 / 4.0)),
            ("crit", (1.0 / 20.0) * (3.0 / 16.0)),
            ("missNone", 6.0 / 20.0),
        ],
        "bin 0",
    )
}

/// zero-damage-hit-labels.test.ts:95
#[test]
fn a_check_with_no_die_labels_its_0_damage_hits() -> T {
    let parsed = p("(15 AC 12) * (1d4 - 1)")?;
    expect_labels(&labels_of(&parsed, 0), &[("hit", 1.0 / 4.0)], "bin 0")
}

/// zero-damage-hit-labels.test.ts:105 (`it.each`: three rows)
#[test]
fn printed_attacks_re_parse_with_the_builders_labels() -> T {
    let payload = || -> Result<RollBuilder, DiceError> { rd(1.0, d4())?.minus(1.0) };
    let rows: Vec<(&str, AttackBuilder)> = vec![
        (
            "noCrit()",
            d20().plus(5.0)?.ac(12.0)?.on_hit(payload()?)?.no_crit()?,
        ),
        (
            "an expanded crit range",
            d20()
                .plus(5.0)?
                .ac(12.0)?
                .crit_on(18.0)?
                .on_hit(payload()?)?,
        ),
        (
            "advantage",
            d20()
                .with_advantage()?
                .plus(5.0)?
                .ac(12.0)?
                .on_hit(payload()?)?,
        ),
    ];
    for (name, attack) in rows {
        let expression = attack.to_expression()?;
        expect_label_maps(
            &label_mass(&p(&expression)?),
            &label_mass(&attack.to_pmf(0.0)?),
            &format!("{name}: {expression}"),
        )?;
    }
    Ok(())
}

/// zero-damage-hit-labels.test.ts:112
#[test]
fn a_plain_roll_that_can_be_0_still_labels_its_0_miss_none() -> T {
    expect_labels(
        &labels_of(&p("1d4 - 1")?, 0),
        &[("missNone", 1.0 / 4.0)],
        "bin 0",
    )
}

/// zero-damage-hit-labels.test.ts:116
#[test]
fn a_save_that_fails_for_0_damage_is_save_fail() -> T {
    let parsed = p("(d20 + 3 DC 15) * (1d4 - 1) save half")?;
    let zero = labels_of(&parsed, 0);
    assert!(zero.get("saveFail").copied().unwrap_or(0.0) > 0.0);
    assert_eq!(zero.get("hit").copied().unwrap_or(0.0), 0.0);
    Ok(())
}

// ---- tests/frozen-pmf-map.test.ts (non-mutation assertions) ----

/// frozen-pmf-map.test.ts:7: the support and `pAt(1)` of a die PMF (the `set`/`delete`/`clear`
/// `TypeError`s are JS frozen `Map`, deferred).
#[test]
fn a_cached_die_keeps_its_support_and_p_at_1() -> T {
    let die = rs(1.0, 6.0, None)?.to_pmf(0.0)?;
    assert_eq!(
        die.support().iter().map(|d| d.0).collect::<Vec<_>>(),
        [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    );
    assert_eq!(rs(1.0, 6.0, None)?.to_pmf(0.0)?.p_at(1.0), 1.0 / 6.0);
    Ok(())
}

/// frozen-pmf-map.test.ts:26: the later rolls stay exact (the refused mutations are deferred).
#[test]
fn later_rolls_stay_exact() -> T {
    assert_close(rs(3.0, 6.0, None)?.to_pmf(0.0)?.mean(), 21.0 / 2.0, 12);
    assert_close(rs(2.0, 6.0, None)?.plus(1.0)?.to_pmf(0.0)?.mean(), 8.0, 12);
    let a = d20().plus(5.0)?.ac(15.0)?.on_hit(rd(1.0, d6())?)?;
    assert_close(a.to_pmf(0.0)?.mean(), 21.0 / 10.0, 12);
    Ok(())
}

/// frozen-pmf-map.test.ts:44: a die PMF's keys in order (`instanceof Map` and the copy are JS).
#[test]
fn a_die_pmfs_map_keys_read_in_order() -> T {
    let die = rs(1.0, 6.0, None)?.to_pmf(0.0)?;
    assert_eq!(
        die.map.keys().map(|d| d.0).collect::<Vec<_>>(),
        [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    );
    assert_eq!(die.map.len(), 6);
    Ok(())
}

/// frozen-pmf-map.test.ts:54: a PMF built on a map reads that map (`freeze()` and the mutation
/// `TypeError` are JS).
#[test]
fn an_unfrozen_pmf_reads_its_own_map() -> T {
    let mut map = IndexMap::new();
    map.insert(
        Damage(1.0),
        crate::pmf::Bin {
            p: 1.0,
            count: IndexMap::from([("hit".to_string(), 1.0)]),
            attr: None,
        },
    );
    let pmf = Pmf::new(map, 1e-12, true);
    assert_eq!(pmf.map.len(), 1);
    assert_eq!(pmf.p_at(1.0), 1.0);
    Ok(())
}
