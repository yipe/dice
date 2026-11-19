//! `tests/turn-stateless-path.test.ts`: 610 of 618 tests (the 600 seeds are one Rust test, 9 of the 17
//! malformed specs another, the empty turn a third), 0 compat calls (no fixture entries; the fast path is compared with the forced walk
//! `Turn::from_spec_walked`, the Rust spelling of `walkEverything.forced`).
//!
//! The seeded generator is the TS mulberry32, called in the TS order, so a seed names the same spec.
//!
//! Not translated: tests/turn-stateless-path.test.ts:143: `afterAll` logs `observed` (max relative error); a
//! console report, not an assertion.
//! Not translated: tests/turn-stateless-path.test.ts:197-200: `"unknown key"`, `"non-string id"`, `"non-string tag"`,
//! `"non-string target"`: a Rust `AttackOptions` cannot hold a key it does not declare or a non-string id,
//! tag or target (`unknown-key` / `non-string-id` are unreachable by type).
//! Not translated: tests/turn-stateless-path.test.ts:205-208: `"not an attack"`, `"a wrapper without a source"`,
//! `"toPMF returns no PMF"`, `"under returns no PMF"`: a `Source` is an enum (a non-source cannot be written)
//! and `to_pmf` / `under` return `Result<Pmf, _>` (a non-PMF cannot be returned).
//! Of `"second error after a valid row"` (line 220) the non-string id third row is dropped; the
//! `chance: -1` row stays.

use super::hand_source::*;
use super::helpers::*;
use crate::Pmf;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::common::RollType;
use crate::error::DiceError;
use crate::turn::Turn;
use crate::turn::context::{RowCheck, RowKind};
use crate::turn::types::{Attack, AttackOptions, DamageSource, Source, TurnSpec};

type R<X> = Result<X, Box<dyn std::error::Error>>;

/// A seeded generator (mulberry32), so a failure names its seed.
struct Rng {
    a: u32,
}

impl Rng {
    fn new(seed: u32) -> Rng {
        Rng { a: seed }
    }

    fn random(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn pick<X: Clone>(&mut self, options: &[X]) -> X {
        let index = (self.random() * options.len() as f64).floor() as usize;
        options[index].clone()
    }

    fn int(&mut self, low: i32, high: i32) -> f64 {
        f64::from(low + (self.random() * f64::from(high - low + 1)).floor() as i32)
    }
}

const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

/// One random row source: an attack, a save, a row that always lands, a bare PMF, a parsed string, or a contextual wrapper.
fn random_source(random: &mut Rng) -> Result<Source, DiceError> {
    let bonus = d6().plus(random.int(-3, 3))?;
    let damage: RollBuilder =
        random.pick(&[d8().plus(4.0)?, rs(2.0, 6.0)?, d4(), flat(5.0)?, bonus]);
    let kind = random.random();
    if kind < 0.4 {
        let mut check = d20().plus(random.int(0, 12))?.ac(random.int(8, 30))?;
        if random.random() < 0.3 {
            check = check.crit_on(19.0)?;
        }
        if random.random() < 0.3 {
            check = random.pick(&[check.melee()?, check.ranged()?]);
        }
        let mut attack = check.on_hit(damage)?;
        if random.random() < 0.2 {
            attack = attack.on_miss(&[Arg::Roll(flat(2.0)?)])?;
        }
        return Ok(attack.into());
    }
    if kind < 0.5 {
        let own = random
            .pick(&[
                d20().with_advantage()?,
                d20().with_disadvantage()?,
                d20().with_elven_accuracy()?,
            ])
            .plus(random.int(0, 8))?;
        return Ok(own.ac(random.int(10, 25))?.on_hit(damage)?.into());
    }
    if kind < 0.65 {
        let plus = random.int(0, 8);
        let dc = random.int(10, 20);
        let ability = random.pick(&ABILITIES);
        let save = d20()
            .plus(plus)?
            .dc(dc)?
            .ability(ability)?
            .on_save_failure_args(&[Arg::Roll(damage)])?;
        return Ok(if random.random() < 0.5 {
            save.save_half()?.into()
        } else {
            save.into()
        });
    }
    if kind < 0.75 {
        return Ok(d20().always_hits()?.on_hit(damage)?.into());
    }
    if kind < 0.85 {
        return Ok(d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(damage)?
            .to_pmf(0.0)?
            .into());
    }
    if kind < 0.92 {
        let expression = random.pick(&["1d20 + 5 AC 15 * 1d8 + 3", "2d6", "1d20 + 2 AC 12 * 2d6"]);
        return Ok(Source::Damage(DamageSource::Roll(d_expression(
            expression,
        )?)));
    }
    let builder = d20()
        .plus(random.int(0, 10))?
        .ac(random.int(10, 25))?
        .on_hit(damage)?;
    let under = builder.clone();
    Ok(Hand::new(builder.row_check(), move |context| {
        under.under(context, 0.0)
    })
    .source())
}

/// A random stateless spec: 1 to 6 rows, some with a chance, an id, a tag or a target.
fn random_spec(random: &mut Rng) -> Result<TurnSpec, DiceError> {
    let count = random.int(1, 6) as usize;
    let mut attacks: Vec<Attack> = Vec::new();
    let mut sources: Vec<Source> = Vec::new();
    for i in 0..count {
        // One source declared as several rows resolves once: reuse an earlier one now and then.
        let source = if random.random() < 0.2 && !sources.is_empty() {
            sources[0].clone()
        } else {
            random_source(random)?
        };
        sources.push(source.clone());
        if random.random() < 0.15 {
            attacks.push(Attack::Bare(source));
            continue;
        }
        let mut options = AttackOptions::default();
        if random.random() < 0.8 {
            options.id = Some(format!("r{i}"));
        }
        if random.random() < 0.5 {
            let free = random.random();
            options.chance = Some(random.pick(&[0.0, 0.25, 0.5, free, 1.0]));
        }
        if random.random() < 0.2 {
            options.tag = Some(random.pick(&["main", "off"]).to_string());
        }
        if random.random() < 0.2 {
            options.target = Some(random.pick(&["target", "second"]).to_string());
        }
        attacks.push(Attack::Declared { options, source });
    }
    let state_limit = if random.random() < 0.2 {
        Some(random.int(1, 100))
    } else {
        None
    };
    Ok(TurnSpec {
        attacks,
        state_limit,
        ..TurnSpec::default()
    })
}

const TOLERANCE: f64 = 1e-12;

#[track_caller]
fn expect_close(fast: f64, slow: f64, what: &str) {
    let relative = (fast - slow).abs() / slow.abs().max(1.0);
    assert!(
        relative <= TOLERANCE,
        "{what}: {fast} vs {slow} ({relative})"
    );
}

/// A marginal is compared as a function: a bin absent on one side is mass 0.
#[track_caller]
fn expect_pmf_close(fast: &Pmf, slow: &Pmf, what: &str) {
    let mut values: Vec<f64> = fast
        .map
        .keys()
        .chain(slow.map.keys())
        .map(|d| d.0)
        .collect();
    values.sort_by(f64::total_cmp);
    values.dedup();
    for value in values {
        let key = crate::Damage(value);
        let (a_p, a_count) = fast
            .map
            .get(&key)
            .map_or((0.0, None), |bin| (bin.p, Some(&bin.count)));
        let (b_p, b_count) = slow
            .map
            .get(&key)
            .map_or((0.0, None), |bin| (bin.p, Some(&bin.count)));
        expect_close(a_p, b_p, &format!("{what} p({value})"));
        let mut labels: Vec<&String> = a_count
            .iter()
            .chain(b_count.iter())
            .flat_map(|count| count.keys())
            .collect();
        labels.sort();
        labels.dedup();
        for label in labels {
            let a = a_count
                .and_then(|count| count.get(label))
                .copied()
                .unwrap_or(0.0);
            let b = b_count
                .and_then(|count| count.get(label))
                .copied()
                .unwrap_or(0.0);
            expect_close(a, b, &format!("{what} {label}({value})"));
        }
    }
}

/// What a consumer compares of a failed read: its class, code and message (`DiceError` carries all three).
fn failure<X>(result: Result<X, DiceError>) -> Option<DiceError> {
    result.err()
}

#[test]
fn the_stateless_path_reads_what_the_full_walk_reads() -> T {
    for seed in 1000..1600u32 {
        check_seed(seed).map_err(|e| format!("seed {seed}: {e}"))?;
    }
    Ok(())
}

fn check_seed(seed: u32) -> R<()> {
    let spec = random_spec(&mut Rng::new(seed))?;
    let fast = Turn::from_spec(spec.clone(), 0.0)?;
    let slow = Turn::from_spec_walked(spec, 0.0)?;

    assert_eq!(fast.attack_ids()?, slow.attack_ids()?);
    assert_eq!(fast.rider_ids()?, slow.rider_ids()?);
    assert_eq!(fast.substitute_ids()?, slow.substitute_ids()?);
    assert_eq!(fast.condition_ids()?, slow.condition_ids()?);
    assert_eq!(fast.probe_ids()?, slow.probe_ids()?);
    assert_eq!(fast.peak_states()?, slow.peak_states()?);

    for id in slow.attack_ids()? {
        let a = fast.marginal(&id)?;
        let b = slow.marginal(&id)?;
        let a = a.as_attack().ok_or("an attack marginal")?;
        let b = b.as_attack().ok_or("an attack marginal")?;
        assert_eq!(a.when_happens, b.when_happens, "{id} whenHappens");
        expect_close(a.occurs, b.occurs, &format!("{id} occurs"));
        expect_pmf_close(&a.pmf, &b.pmf, &format!("{id} marginal pmf"));
        for roll_type in [
            RollType::Flat,
            RollType::Advantage,
            RollType::Disadvantage,
            RollType::ElvenAccuracy,
        ] {
            expect_close(
                a.roll_type(roll_type),
                b.roll_type(roll_type),
                &format!("{id} rollType {roll_type:?}"),
            );
        }

        let s = fast.step_stats(&id)?;
        let t = slow.step_stats(&id)?;
        expect_close(s.rolled, t.rolled, &format!("{id} rolled"));
        expect_close(s.hit, t.hit, &format!("{id} hit"));
        expect_close(s.crit, t.crit, &format!("{id} crit"));
        assert_eq!(s.live, t.live, "{id} live");
        assert_eq!(s.conditions, t.conditions, "{id} conditions");

        // Landings and the joint readers walk the plan on both paths: the same numbers to the bit.
        assert_eq!(fast.landings(&id)?, slow.landings(&id)?, "{id} landings");
    }
    assert_eq!(fast.pmf()?, slow.pmf()?);
    assert_eq!(fast.mean()?, slow.mean()?);
    assert_eq!(fast.to_query()?.singles, slow.to_query()?.singles);

    // Unknown ids fail the same way on both paths.
    let nobody = "nobody";
    assert_eq!(
        failure(fast.marginal(nobody)),
        failure(slow.marginal(nobody)),
        "marginal"
    );
    assert_eq!(
        failure(fast.step_stats(nobody)),
        failure(slow.step_stats(nobody)),
        "stepStats"
    );
    assert_eq!(
        failure(fast.fire_probability(nobody)),
        failure(slow.fire_probability(nobody)),
        "fireProbability"
    );
    assert_eq!(
        failure(fast.expected_applications(nobody)),
        failure(slow.expected_applications(nobody)),
        "expectedApplications"
    );
    assert_eq!(
        failure(fast.attempt_probability(nobody)),
        failure(slow.attempt_probability(nobody)),
        "attemptProbability"
    );
    assert_eq!(
        failure(fast.landings(nobody)),
        failure(slow.landings(nobody)),
        "landings"
    );
    assert_eq!(fast.inspect_plan()?.attack_ids, slow.attack_ids()?);
    Ok(())
}

// ---- a malformed stateless spec fails the same way on both paths ---------------------------------

fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    attack_roll(5.0, 15.0, d8())
}

fn breath() -> Result<crate::builder::save::SaveBuilder, DiceError> {
    d20()
        .plus(3.0)?
        .dc(14.0)?
        .ability("dex")?
        .on_save_failure_args(&[Arg::Roll(d8())])
}

fn with_chance(source: impl Into<Source>, chance: f64) -> Attack {
    Attack::Declared {
        options: AttackOptions {
            chance: Some(chance),
            ..AttackOptions::default()
        },
        source: source.into(),
    }
}

fn only(attacks: Vec<Attack>) -> TurnSpec {
    TurnSpec {
        attacks,
        ..TurnSpec::default()
    }
}

/// A save row declaring an ability the engine does not know, over the real save's PMFs.
fn luck_save() -> Result<Source, DiceError> {
    let real = breath()?;
    let check = RowCheck {
        kind: RowKind::Save,
        ability: Some("luck".to_string()),
        ..real.row_check()
    };
    Ok(Hand::new(check, move |context| real.under(context, 0.0)).source())
}

fn malformed() -> R<Vec<(&'static str, TurnSpec)>> {
    Ok(vec![
        (
            "duplicate id",
            only(vec![declared("a", sword()?), declared("a", sword()?)]),
        ),
        (
            "duplicate default id",
            only(vec![
                Attack::Bare(sword()?.into()),
                declared("attack 1", sword()?),
            ]),
        ),
        ("chance above 1", only(vec![with_chance(sword()?, 1.5)])),
        ("chance NaN", only(vec![with_chance(sword()?, f64::NAN)])),
        (
            "stateLimit 0",
            TurnSpec {
                state_limit: Some(0.0),
                ..only(vec![Attack::Bare(sword()?.into())])
            },
        ),
        (
            "stateLimit fractional",
            TurnSpec {
                state_limit: Some(1.5),
                ..only(vec![Attack::Bare(sword()?.into())])
            },
        ),
        (
            "a save with an unknown ability",
            only(vec![declared("breath", luck_save()?)]),
        ),
        (
            "an unknown ability after a duplicate id",
            only(vec![declared("a", luck_save()?), declared("a", sword()?)]),
        ),
        (
            "second error after a valid row",
            only(vec![
                Attack::Bare(sword()?.into()),
                with_chance(sword()?, -1.0),
            ]),
        ),
    ])
}

#[test]
fn a_malformed_stateless_spec_fails_the_same_way_on_both_paths() -> T {
    for (name, spec) in malformed()? {
        let fast = failure(Turn::from_spec(spec.clone(), 0.0));
        assert!(fast.is_some(), "{name}: the fast path accepted it");
        assert_eq!(fast, failure(Turn::from_spec_walked(spec, 0.0)), "{name}");
    }
    Ok(())
}

#[test]
fn an_empty_turn_reads_on_both_paths_alike() -> T {
    let fast = Turn::from_spec(only(vec![]), 0.0)?;
    let slow = Turn::from_spec_walked(only(vec![]), 0.0)?;
    assert_eq!(fast.attack_ids()?, Vec::<String>::new());
    assert_eq!(fast.peak_states()?, slow.peak_states()?);
    assert_eq!(fast.pmf()?, slow.pmf()?);
    assert_eq!(failure(fast.marginal("a")), failure(slow.marginal("a")));
    Ok(())
}
