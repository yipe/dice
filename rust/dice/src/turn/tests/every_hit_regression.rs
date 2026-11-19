//! `tests/turn-every-hit-regression.test.ts`: 11 tests, 44 compat calls.

use super::helpers::*;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, advantage, keep_best_damage,
};
use crate::turn::types::{Attack, AttackOptions, DamageSource, RiderDamage, RiderOptions};
use crate::turn::{Turn, turn};

const FILE: &str = "tests/turn-every-hit-regression.test.ts";
const SUITE: &str = "uncapped every-hit riders keep their 0.14.2 numbers";

fn sword() -> Result<AttackBuilder, DiceError> {
    attack_roll(7.0, 15.0, d8().plus(4.0)?)
}
fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(4.0)?)
}
fn halves() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 13.0, rs(2.0, 6.0)?.plus(3.0)?)
}
fn orb() -> Result<AttackBuilder, DiceError> {
    attack_roll(5.0, 17.0, rs(3.0, 8.0)?)
}

fn n(count: usize, source: &AttackBuilder) -> Vec<Attack> {
    (0..count).map(|_| atk(source.clone())).collect()
}

fn eh() -> EveryHitOptions {
    EveryHitOptions::default()
}
fn fh() -> FirstHitOptions {
    FirstHitOptions::default()
}
fn ro() -> RiderOptions {
    RiderOptions::default()
}

struct Golden {
    name: &'static str,
    build: fn() -> Result<Turn, DiceError>,
    mean: f64,
    p_whiff: f64,
    fire: &'static [(&'static str, f64)],
}

fn check(golden: &Golden) -> T {
    let mut want = expect(FILE, &format!("{SUITE} > {}", golden.name));
    let t = (golden.build)()?;
    close(want.mean(&t), golden.mean, 11);
    close(want.pmf(&t).p_at(0.0), golden.p_whiff, 12);
    for (id, probability) in golden.fire {
        close(want.fire(&t, id), *probability, 12);
    }
    want.done();
    Ok(())
}

macro_rules! golden {
    ($test:ident, $name:expr, $build:expr, $mean:expr, $whiff:expr, $fire:expr) => {
        #[test]
        fn $test() -> T {
            check(&Golden {
                name: $name,
                build: $build,
                mean: $mean,
                p_whiff: $whiff,
                fire: $fire,
            })
        }
    };
}

golden!(
    two_attacks_an_every_hit_d6,
    "two attacks, an every-hit d6",
    || turn(n(2, &sword()?), 0.0)?.on_every_hit_with(d6(), eh()),
    16.4,
    0.1225,
    &[("rider 1", 0.8775)]
);

golden!(
    four_attacks,
    "four attacks",
    || turn(vec![], 0.0)?
        .attacks(4.0, sword()?)?
        .on_every_hit_with(d6(), eh()),
    32.8,
    0.01500625,
    &[("rider 1", 0.98499375)]
);

golden!(
    two_every_hit_riders_over_three_attacks,
    "two every-hit riders over three attacks",
    || turn(n(3, &sword()?), 0.0)?
        .on_every_hit_with(d6(), eh())?
        .on_every_hit_with(rs(2.0, 4.0)?, every_hit(Some("second"), None)),
    35.1,
    0.042875,
    &[("rider 1", 0.957125), ("second", 0.957125)]
);

golden!(
    an_attack_that_only_happens_half_the_time,
    "an attack that only happens half the time",
    || {
        let half = Attack::Declared {
            options: AttackOptions {
                chance: Some(0.5),
                ..AttackOptions::default()
            },
            source: sword()?.into(),
        };
        let s = sword()?;
        turn(vec![half, atk(s.clone()), atk(s)], 0.0)?.on_every_hit_with(d6(), eh())
    },
    20.5,
    0.0826875,
    &[("rider 1", 0.9173125)]
);

golden!(
    beside_a_once_per_turn_reroll,
    "beside a once-per-turn reroll",
    || turn(n(3, &sword()?), 0.0)?
        .on_first_hit_transform(keep_best_damage(), fh())?
        .on_every_hit_with(d6(), eh()),
    25.895483642578117,
    0.042875,
    &[("rider 1", 0.957125), ("substitute 1", 0.957125)]
);

golden!(
    beside_a_threshold_reroll,
    "beside a threshold reroll",
    || turn(n(3, &halves()?), 0.0)?
        .on_first_hit_transform(keep_best_damage().if_below_split(10.0, 18.0)?, fh())?
        .on_every_hit_with(d6(), eh()),
    29.65608310441979,
    0.042875,
    &[("rider 1", 0.957125), ("substitute 1", 0.8174577755421473)]
);

golden!(
    beside_a_dice_match_rider,
    "beside a dice-match rider",
    || turn(n(2, &orb()?), 0.0)?
        .on_dice_match_with(&["attack 1", "attack 2"], d6(), ro())?
        .on_every_hit_with(d4(), eh()),
    17.483159287124856,
    0.3025,
    &[("rider 1", 0.3335804902017115), ("rider 2", 0.6975)]
);

golden!(
    beside_a_granted_advantage,
    "beside a granted advantage",
    || turn(n(3, &sword()?), 0.0)?
        .on_every_hit_with(advantage().until_next_attack(), eh())?
        .on_every_hit_with(d6(), eh()),
    29.10289125,
    0.042875,
    &[("rider 1", 0.957125), ("condition 1", 0.8775)]
);

golden!(
    beside_a_granted_crit_on_hit_that_sometimes_takes,
    "beside a granted crit-on-hit that sometimes takes",
    || {
        let chance = EveryHitOptions {
            first_hit: FirstHitOptions {
                condition: ConditionOptions {
                    chance: Some(0.4),
                    ..ConditionOptions::default()
                },
                ..FirstHitOptions::default()
            },
            ..EveryHitOptions::default()
        };
        turn(n(3, &sword()?), 0.0)?
            .on_every_hit_with(advantage().crit_on_hit().until_end_of_turn(), chance)?
            .on_every_hit_with(d6(), eh())
    },
    31.26094,
    0.042875,
    &[("rider 1", 0.957125), ("condition 1", 0.4524)]
);

golden!(
    beside_a_first_miss_reroll,
    "beside a first-miss reroll",
    || turn(n(2, &sword()?), 0.0)?
        .on_first_miss_with(sword()?, ro())?
        .on_every_hit_with(d6(), eh()),
    21.1355,
    0.042875,
    &[("rider 1", 0.5775), ("rider 2", 0.957125)]
);

golden!(
    the_goliath_every_trigger_at_once,
    "the goliath: every trigger at once",
    || {
        let d = dagger()?;
        let pair = RiderDamage::Many(vec![
            DamageSource::Attack(Box::new(d.clone())),
            DamageSource::Attack(Box::new(d.clone())),
        ]);
        turn(n(2, &d), 0.0)?
            .on_first_hit_with(rs(3.0, 6.0)?, fh())?
            .on_first_hit_with(d10(), fh())?
            .on_any_crit_with(rs(2.0, 8.0)?, ConditionOptions::default())?
            .otherwise_with(pair, ro())?
            .on_every_hit_with(d6(), eh())
    },
    38.32675,
    0.015006249999999999,
    &[
        ("rider 1", 0.8775),
        ("rider 2", 0.8775),
        ("rider 3", 0.0975),
        ("rider 4", 0.9025),
        ("rider 5", 0.8775)
    ]
);
