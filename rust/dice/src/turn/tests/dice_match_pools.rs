//! `tests/dice-match-pools.test.ts`: 68 tests (the `it` loops over the pairs, the reroll cases and the refused payloads are one Rust test each: 26 `#[test]`s), 5 compat calls.
//!
//! The oracle (`tests/enumerate-match.ts`, every roll of the pool listed) is the u128 port that
//! `builder::tests::t_row_facts` already carries, copied here.
//!
//! Not translated: `tests/dice-match-pools.test.ts:356` and `:360`: the reroll-pool match cache
//! (`rerollUpToMatch` returning one shared object while `setCachingEnabled` is on and a fresh one
//! while it is off). `reroll_up_to_match` returns an owned value with no cache and identity; the
//! test keeps the value half (`total` and `match` are the same on every call) and does not flip the
//! process-wide caching flag under a parallel test run.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::reroll_pool::{PoolDieKind, reroll_up_to_match};
use crate::builder::roll::{Arg, RollBuilder, RollRerollUpToOptions};
use crate::common::DiceMatchInfo;
use crate::common::bounce::{BounceOddsOptions, calculate_bounce_odds};
use crate::error::DiceError;
use crate::turn::{bounce, turn};
use crate::{Damage, Pmf};
use std::collections::BTreeMap;

const FILE: &str = "tests/dice-match-pools.test.ts";

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

fn r(roll: RollBuilder) -> Arg {
    Arg::Roll(roll)
}

fn attack_with(payload: RollBuilder) -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(payload)
}

/// `roll(count, die)`.
fn pool(count: f64, die: &RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die.clone())), None)
}

/// `roll(count, sides)`.
fn sided(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

fn descriptor(info: Option<DiceMatchInfo>) -> Result<DiceMatchInfo, DiceError> {
    info.ok_or_else(|| DiceError::error("expected a dice-match descriptor, got none"))
}

/// The descriptor's map as sorted `[damage, probability]` rows, to compare two descriptors exactly.
fn rows(info: Option<DiceMatchInfo>) -> Result<Vec<(f64, f64)>, DiceError> {
    let mut v: Vec<(f64, f64)> = descriptor(info)?
        .match_probability_by_damage
        .iter()
        .map(|(d, p)| (d.0, *p))
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(v)
}

/// The branch's own PMF, cut by the descriptor, is the oracle's law: for every damage, P(damage)
/// is the oracle's total and P(damage) times P(match | damage) is its match mass.
fn expect_agrees(
    pmf: &Pmf,
    info: Option<DiceMatchInfo>,
    oracle: &MatchOracle,
    modifier: f64,
) -> Result<(), DiceError> {
    let by_damage = descriptor(info)?.match_probability_by_damage;
    let mut damages: Vec<f64> = pmf.support().iter().map(|d| d.0).collect();
    damages.extend(oracle.total.keys().map(|s| *s as f64 + modifier));
    for damage in damages {
        let key = (damage - modifier) as i64;
        close(
            pmf.p_at(damage),
            oracle.total.get(&key).copied().unwrap_or(0.0),
            PRECISION,
        );
        let matched = by_damage.get(&Damage(damage)).copied().unwrap_or(0.0);
        close(
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

/// `codeOf(() => bounce(..).mean())` of this file: a `TurnSpecError`'s code and message.
fn refusal<X>(result: Result<X, DiceError>) -> Result<Option<(String, String)>, DiceError> {
    match result {
        Ok(_) => Ok(None),
        Err(DiceError::TurnSpec(e)) => Ok(Some((e.code.as_str().to_string(), e.message))),
        Err(other) => Err(other),
    }
}

fn bounce_mean(attack: &AttackBuilder, max: f64) -> Result<f64, DiceError> {
    bounce(attack.clone().into(), max)?.mean()
}

fn odds(count: f64, faces: f64, options: Option<BounceOddsOptions>) -> Result<f64, DiceError> {
    calculate_bounce_odds(count, faces, options)
}

// ---- groups of dice with the same faces are one pool ---------------------------------------------

const GROUPS: &str = "groups of dice with the same faces are one pool";

#[test]
fn groups_with_the_same_faces_have_the_descriptor_of_the_whole_pool() -> T {
    let (d8, d6) = (d8(), d6());
    let d8m1 = d8.minimum(1.0)?;
    let d8m2 = d8.minimum(2.0)?;
    let d8r1 = d8.reroll(1.0)?;
    let pairs: Vec<(&str, RollBuilder, RollBuilder)> = vec![
        (
            "2d6 as 1d6 + 1d6",
            pool(1.0, &d6)?.plus_roll(&pool(1.0, &d6)?)?,
            pool(2.0, &d6)?,
        ),
        (
            "3d8 as 2d8 + 1d8",
            pool(2.0, &d8)?.plus_roll(&pool(1.0, &d8)?)?,
            pool(3.0, &d8)?,
        ),
        (
            "3d8 + 4 as 1d8 + 2d8 + 4",
            pool(1.0, &d8)?.plus_roll(&pool(2.0, &d8)?)?.plus(4.0)?,
            pool(3.0, &d8)?.plus(4.0)?,
        ),
        (
            "4d6 as three groups",
            pool(1.0, &d6)?
                .plus_roll(&pool(2.0, &d6)?)?
                .plus_roll(&pool(1.0, &d6)?)?,
            pool(4.0, &d6)?,
        ),
        (
            "3d8 beside a group of no dice",
            pool(0.0, &d6)?.plus_roll(&pool(3.0, &d8)?)?,
            pool(3.0, &d8)?,
        ),
        (
            "3d8 whose 1d8 has a minimum of 1, which floors nothing",
            pool(2.0, &d8)?.plus_roll(&pool(1.0, &d8m1)?)?,
            pool(3.0, &d8)?,
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

#[test]
fn agrees_with_every_roll_listed_on_the_hit_and_on_the_doubled_crit() -> T {
    let attack = attack_with(pool(2.0, &d6())?.plus_roll(&pool(1.0, &d6())?)?.plus(2.0)?)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    let resolved = attack.resolve(0.0)?;
    expect_agrees(&resolved.hit, hit, &pool_match_oracle(spec(6, 3, 0)), 2.0)?;
    expect_agrees(&resolved.crit, crit, &pool_match_oracle(spec(6, 6, 0)), 2.0)?;
    Ok(())
}

#[test]
fn agrees_on_an_explicit_crit_written_as_two_groups() -> T {
    let attack = attack_with(pool(2.0, &d6())?)?
        .on_crit(&[r(pool(3.0, &d6())?.plus_roll(&pool(2.0, &d6())?)?)])?;
    expect_agrees(
        &attack.resolve(0.0)?.crit,
        attack.dice_match_info(0.0)?.1,
        &pool_match_oracle(spec(6, 5, 0)),
        0.0,
    )?;
    Ok(())
}

#[test]
fn a_bounce_chain_over_the_split_pool_is_the_chain_over_the_whole_pool() -> T {
    let mut want = expect(
        FILE,
        &format!("{GROUPS} > a bounce chain over the split pool is the chain over the whole pool"),
    );
    let split = attack_with(pool(2.0, &d8())?.plus_roll(&pool(1.0, &d8())?)?)?;
    let whole = attack_with(pool(3.0, &d8())?)?;
    let split_mean = want.mean(&bounce(split.into(), 3.0)?);
    close(split_mean, want.mean(&bounce(whole.into(), 3.0)?), 12);
    want.done();
    Ok(())
}

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

// ---- dice of different kinds are not a pool to match ---------------------------------------------

#[test]
fn dice_of_different_kinds_have_no_descriptor_and_a_bounce_chain_says_why() -> T {
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
        let (code, text) = refusal(bounce_mean(&attack, 1.0))?.ok_or("the chain resolved")?;
        assert_eq!(code, "no-dice-descriptor", "{name}");
        assert!(text.contains(message), "{name}: {text}");
    }
    Ok(())
}

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

// ---- a pool that rerolls up to k dice matches on the dice that land ------------------------------

struct Case {
    name: &'static str,
    sides: usize,
    count: usize,
    budget: usize,
    minimum: usize,
    reroll: usize,
    /// `rolls`, 0 for none.
    rolls: usize,
    /// Also check the doubled crit against the oracle (a pool of twice the dice, which costs more to list).
    crit: bool,
}

fn cases() -> Vec<Case> {
    let c = |name, sides, count, budget, minimum, reroll, rolls, crit| Case {
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

impl Case {
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

    fn payload(&self) -> Result<RollBuilder, DiceError> {
        pool(self.count as f64, &self.faces()?)?.plus(3.0)
    }

    fn via_attack(&self) -> Result<AttackBuilder, DiceError> {
        attack_with(self.payload()?)?.reroll_damage_up_to(self.budget as f64, self.rolls())
    }
}

#[test]
fn reroll_pool_cases_agree_with_every_roll_listed() -> T {
    for c in cases() {
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

#[test]
fn a_reroll_up_to_payload_has_the_descriptor_of_the_attack_level_budget() -> T {
    for c in cases() {
        let via_attack = c.via_attack()?;
        let options = RollRerollUpToOptions {
            rolls: c.rolls(),
            rolled_once: None,
        };
        let via_payload = attack_with(c.payload()?.reroll_up_to(c.budget as f64, Some(&options))?)?;
        let (pa, pc) = via_payload.dice_match_info(0.0)?;
        let (aa, ac) = via_attack.dice_match_info(0.0)?;
        assert_eq!(rows(pa)?, rows(aa)?, "{} hit", c.name);
        assert_eq!(rows(pc)?, rows(ac)?, "{} crit", c.name);
    }
    Ok(())
}

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
    )?;
    Ok(())
}

#[test]
fn a_budget_of_none_or_of_a_pool_no_bigger_than_the_dice_reads_the_pool_it_names() -> T {
    let hit_rows = |a: AttackBuilder| -> Result<Vec<(f64, f64)>, DiceError> {
        rows(a.dice_match_info(0.0)?.0)
    };
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
    )?;
    Ok(())
}

#[test]
fn a_total_that_cannot_hold_a_repeated_face_has_no_match_odds_and_one_that_must_has_all_of_them()
-> T {
    // 2d4 rerolling 1 (the mean is 2.5): 8 is two 4s, both kept. 2 is two 1s, one rerolled and shown
    // as 1 again, since no other roll makes 2. 3 is a 1 and a 2, and no two dice make 3 with a repeat.
    let hit = attack_with(pool(2.0, &d4())?)?
        .reroll_damage_up_to(1.0, None)?
        .dice_match_info(0.0)?
        .0;
    let info = descriptor(hit)?.match_probability_by_damage;
    let at = |d: f64| info.get(&Damage(d)).copied();
    assert_eq!(at(8.0), Some(1.0));
    close(at(2.0).ok_or("no 2")?, 1.0, 12);
    close(at(3.0).ok_or("no 3")?, 0.0, 12);
    Ok(())
}

const POLICY: &str = "a pool that rerolls up to k dice matches on the dice that land > the policy is the one that maximises damage";

#[test]
fn two_d8_rerolling_1_matches_5_32_of_the_time() -> T {
    // Sort the two dice. With the lower one 1-4 (48 of 64 rolls) it is rerolled, even when it matches
    // the higher: the new die then matches the kept one 1 time in 8. With both dice 5-8 (16 rolls)
    // nothing is rerolled and they match when equal (4 rolls). (48/8 + 4) / 64 = 5/32.
    let attack = attack_with(pool(2.0, &d8())?)?.reroll_damage_up_to(1.0, None)?;
    close(
        p_match(&attack.resolve(0.0)?.hit, attack.dice_match_info(0.0)?.0)?,
        5.0 / 32.0,
        12,
    );
    Ok(())
}

#[test]
fn a_caster_who_rerolls_to_make_the_dice_match_does_better_and_that_is_not_what_is_modelled() -> T {
    let attack = attack_with(pool(2.0, &d8())?)?.reroll_damage_up_to(1.0, None)?;
    let damage_policy = p_match(&attack.resolve(0.0)?.hit, attack.dice_match_info(0.0)?.0)?;
    // A matching roll stands, and the caster rerolls a die of a distinct roll to hit the other: 1/8 + 7/8 * 1/8.
    let match_policy = odds(
        2.0,
        8.0,
        Some(BounceOddsOptions {
            minimum_die_roll: None,
            reroll_damage_dice: Some(1.0),
        }),
    )?;
    close(match_policy, 15.0 / 64.0, 12);
    assert!(damage_policy < match_policy);
    // The same pool with no reroll matches 1 time in 8: rerolling for damage moves the match too.
    let plain = attack_with(pool(2.0, &d8())?)?;
    close(
        p_match(&plain.resolve(0.0)?.hit, plain.dice_match_info(0.0)?.0)?,
        1.0 / 8.0,
        12,
    );
    Ok(())
}

#[test]
fn a_chain_of_beams_follows_the_damage_policys_odds() -> T {
    let mut want = expect(
        FILE,
        &format!(
            "{POLICY} > a chain of beams follows the damage policy's odds: mean = m * (1 + P + P^2 + P^3)"
        ),
    );
    let attack = attack_with(pool(3.0, &d6())?)?.reroll_damage_up_to(1.0, None)?;
    let resolved = attack.resolve(0.0)?;
    let weights = resolved.weights;
    let (hit_info, crit_info) = attack.dice_match_info(0.0)?;
    let per_landing = weights.hit * p_match(&resolved.hit, hit_info)?
        + weights.crit * p_match(&resolved.crit, crit_info)?;
    // P is also the oracle's, hit and crit, however the descriptor got there.
    let oracle_hit: f64 = pool_match_oracle(spec(6, 3, 1)).matched.values().sum();
    let oracle_crit: f64 = pool_match_oracle(spec(6, 6, 1)).matched.values().sum();
    close(
        per_landing,
        weights.hit * oracle_hit + weights.crit * oracle_crit,
        12,
    );
    let beam = attack.to_pmf(0.0)?.mean();
    let mut expected = 0.0;
    for k in 0..=3 {
        expected += beam * per_landing.powi(k);
    }
    close(want.mean(&bounce(attack.into(), 3.0)?), expected, 10);
    want.done();
    Ok(())
}

#[test]
fn a_chain_over_a_best_of_two_rolls_pool_follows_the_same_rule() -> T {
    let mut want = expect(
        FILE,
        &format!("{POLICY} > a chain over a best-of-two-rolls pool follows the same rule"),
    );
    let attack = attack_with(pool(2.0, &d4())?)?.reroll_damage_up_to(1.0, Some(2.0))?;
    let resolved = attack.resolve(0.0)?;
    let weights = resolved.weights;
    let (hit_info, crit_info) = attack.dice_match_info(0.0)?;
    let per_landing = weights.hit * p_match(&resolved.hit, hit_info)?
        + weights.crit * p_match(&resolved.crit, crit_info)?;
    let beam = attack.to_pmf(0.0)?.mean();
    close(
        want.mean(&bounce(attack.into(), 2.0)?),
        beam * (1.0 + per_landing + per_landing.powi(2)),
        10,
    );
    want.done();
    Ok(())
}

#[test]
fn a_rider_over_a_reroll_pool_reads_the_dice_after_the_rerolls() -> T {
    let mut want = expect(
        FILE,
        "a pool that rerolls up to k dice matches on the dice that land > a rider over a reroll pool reads the dice after the rerolls",
    );
    let source = attack_with(pool(2.0, &d4())?)?.reroll_damage_up_to(1.0, None)?;
    let t = turn(vec![atk(source.clone())], 0.0)?.on_dice_match_with(
        &["attack 1"],
        sided(1.0, 1.0)?,
        rid("on match"),
    )?;
    let resolved = source.resolve(0.0)?;
    let weights = resolved.weights;
    let (hit_info, crit_info) = source.dice_match_info(0.0)?;
    // The rider's 1d1 doubles on a crit; it fires when the branch matches.
    let expected = source.to_pmf(0.0)?.mean()
        + weights.hit * p_match(&resolved.hit, hit_info)? * 1.0
        + weights.crit * p_match(&resolved.crit, crit_info)? * 2.0;
    close(want.mean(&t), expected, 12);
    want.done();
    Ok(())
}

// ---- a pool that cannot be made exact is refused, and says why -----------------------------------

#[test]
fn a_reroll_pool_too_big_to_enumerate_has_no_descriptor() -> T {
    let attack = attack_with(sided(6.0, 1000.0)?)?.reroll_damage_up_to(2.0, None)?;
    assert!(attack.dice_match_info(0.0)?.0.is_none());
    let why = attack.dice_match_refusals()?.0.ok_or("no refusal")?;
    assert!(
        why.contains("a rerollUpTo pool of 6 dice, too many to enumerate"),
        "{why}"
    );
    Ok(())
}

#[test]
fn a_reroll_pool_the_size_of_a_9th_level_chromatic_orb_crit_is_not_too_big() -> T {
    let attack = attack_with(pool(11.0, &d8())?)?.reroll_damage_up_to(5.0, None)?;
    let (hit, crit) = attack.dice_match_info(0.0)?;
    assert!(hit.is_some() && crit.is_some());
    Ok(())
}

#[test]
fn refused_payloads_have_no_descriptor_and_the_refusal_names_the_cause() -> T {
    // (name, attack, branch is the crit, accepted refusal texts)
    let rows_: Vec<(&str, AttackBuilder, bool, Vec<&str>)> = vec![
        (
            "a string payload",
            d20()
                .plus(5.0)?
                .ac(15.0)?
                .on_hit_args(&[Arg::Str("2d6+3".to_string())])?,
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

#[test]
fn a_branch_with_a_descriptor_has_no_refusal() -> T {
    let attack = attack_with(pool(3.0, &d8())?)?;
    assert_eq!(attack.dice_match_refusals()?, (None, None));
    Ok(())
}

#[test]
fn a_bounce_chains_error_carries_the_reason_of_the_branch_it_needed() -> T {
    let attack = attack_with(pool(3.0, &d8())?.explode(1.0)?)?;
    let (code, message) = refusal(bounce_mean(&attack, 1.0))?.ok_or("the chain resolved")?;
    assert_eq!(code, "no-dice-descriptor");
    assert!(
        message.contains("(hit and crit: the damage explodes, so extra dice"),
        "{message}"
    );
    Ok(())
}

#[test]
fn a_source_that_cannot_say_why_keeps_the_generic_message() -> T {
    let bare = attack_with(pool(3.0, &d8())?)?.to_pmf(0.0)?;
    let result = turn(vec![atk(bare)], 0.0)
        .and_then(|t| t.on_dice_match_with(&["attack 1"], sided(1.0, 6.0)?, Default::default()))
        .and_then(|t| t.mean());
    let (code, message) = refusal(result)?.ok_or("the turn resolved")?;
    assert_eq!(code, "no-dice-descriptor");
    assert!(
        message.contains("a bare PMF, a string-parsed expression"),
        "{message}"
    );
    Ok(())
}

// ---- the reroll-pool match cache follows setCachingEnabled ---------------------------------------

#[test]
fn a_walked_pool_gives_the_same_value_every_call() -> T {
    // The TS asserts object identity (`toBe`) while caching is on; the Rust walk is uncached, so
    // only the value half (`total` and `match` equal, in order) applies.
    let pool = PoolDieKind {
        values: vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        probs: vec![1.0 / 6.0; 6],
        count: 4.0,
    };
    let first = reroll_up_to_match(&pool, 2.0, 1.0)?.ok_or("walk refused")?;
    let second = reroll_up_to_match(&pool, 2.0, 1.0)?.ok_or("walk refused")?;
    assert_eq!(first, second);
    assert!(first.total.iter().eq(second.total.iter()));
    Ok(())
}
