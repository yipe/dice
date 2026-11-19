//! `src/builder/example.test.ts`: 3 tests, 22 compat calls (17 + 4 + 1), the "Effects cookbook examples" block.
//! The 13 builder-only cases of the "Builder examples integration" block are already in
//! `builder/tests/t_row_facts.rs` (example.test.ts:104-186) and `builder/tests/checks_deferred.rs` (196-205).
//! There is no Rust port of `src/builder/example.ts`, so the cookbook turns are built here from its source
//! (lines 462-640), with the documented expected numbers beside them.
//! The TS `it.each(means)` rows are evaluated at collection time, where the recorder files them under the empty test
//! name `""`; `documented_means` checks those 17 reads in that order.

use super::helpers::*;
use crate::builder::attack::{AttackBuilder, ConditionGate, Grants};
use crate::builder::factory::*;
use crate::error::DiceError;
use crate::turn::effects::{
    ConditionOptions, EveryHitOptions, FirstHitOptions, TriggerSave, TriggerSaves, advantage,
    crit_on_hit,
};
use crate::turn::types::AttacksOptions;
use crate::turn::types::{AttackOptions, RiderOptions};
use crate::turn::{EffectPart, Turn, turn};

const FILE: &str = "src/builder/example.test.ts";
const SUITE: &str = "Effects cookbook examples";

type R<X> = Result<X, Box<dyn std::error::Error>>;

// All attacks are +8 vs AC 16, crit on 20.
fn shortsword() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(5.0)?)
}
fn dagger() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d4().plus(5.0)?)
}
fn staff() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d8().plus(5.0)?)
}
fn fist() -> Result<AttackBuilder, DiceError> {
    shortsword()
}
fn small_fist() -> Result<AttackBuilder, DiceError> {
    attack_roll(8.0, 16.0, d6().plus(4.0)?)
}
fn rapier() -> Result<AttackBuilder, DiceError> {
    staff()
}

fn next_attack() -> Grants {
    Grants::One(advantage().until_next_attack().into())
}

fn end_of_turn() -> crate::turn::effects::Grant {
    advantage().until_end_of_turn()
}

fn save_dc(bonus: f64, dc: f64) -> Result<TriggerSaves, DiceError> {
    Ok(TriggerSaves::One(TriggerSave::Dc(
        d20().plus(bonus)?.dc(dc)?,
    )))
}

/// `{ save: d20.plus(bonus).dc(dc), onSave: advantage().untilNextAttack() }` (`id` optional).
fn save_or_next_attack(bonus: f64, id: Option<&str>) -> Result<FirstHitOptions, DiceError> {
    Ok(FirstHitOptions {
        condition: ConditionOptions {
            rider: RiderOptions {
                id: id.map(str::to_string),
                ..RiderOptions::default()
            },
            save: Some(save_dc(bonus, 15.0)?),
            on_save: Some(vec![advantage().until_next_attack().into()]),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    })
}

fn bare(attacks: Vec<AttackBuilder>) -> Result<Turn, DiceError> {
    turn(attacks.into_iter().map(atk).collect(), 0.0)
}

fn next_attack_advantage_sword() -> Result<AttackBuilder, DiceError> {
    shortsword()?.on_every_hit_with(next_attack(), None)
}

fn advantage_chain() -> Result<Turn, DiceError> {
    let sword = next_attack_advantage_sword()?;
    bare(vec![sword.clone(), sword, dagger()?])
}

fn plain_trio() -> Result<Turn, DiceError> {
    bare(vec![shortsword()?, shortsword()?, dagger()?])
}

fn advantage_chain_of_four() -> Result<Turn, DiceError> {
    turn(vec![], 0.0)?.attacks(4.0, next_attack_advantage_sword()?)
}

fn advantage_only_among_swords() -> Result<Turn, DiceError> {
    let options = EveryHitOptions {
        first_hit: FirstHitOptions {
            condition: ConditionOptions {
                rider: RiderOptions {
                    of: Some(vec!["sword".to_string()]),
                    ..RiderOptions::default()
                },
                ..ConditionOptions::default()
            },
            ..FirstHitOptions::default()
        },
        ..EveryHitOptions::default()
    };
    turn(vec![], 0.0)?
        .attacks_with(
            2.0,
            shortsword()?,
            AttacksOptions {
                tag: Some("sword".to_string()),
                chance: None,
            },
        )?
        .attack(dagger()?)?
        .on_every_hit_with(advantage().until_next_attack().to(&["sword"]), options)
}

fn chance_gated_advantage() -> Result<Turn, DiceError> {
    let gate = ConditionGate {
        chance: Some(0.4),
        ..ConditionGate::default()
    };
    bare(vec![
        shortsword()?.on_every_hit_with(next_attack(), Some(gate))?,
        shortsword()?,
    ])
}

fn save_gated_rest_of_turn() -> Result<Turn, DiceError> {
    let gate = ConditionGate {
        save: Some(save_dc(3.0, 15.0)?),
        ..ConditionGate::default()
    };
    let gated = staff()?.on_every_hit_with(Grants::One(end_of_turn().into()), Some(gate))?;
    bare(vec![gated.clone(), gated, dagger()?])
}

fn crit_grants_advantage() -> Result<Turn, DiceError> {
    let granting = shortsword()?.on_any_crit_with(Grants::One(end_of_turn().into()), None)?;
    bare(vec![granting, shortsword()?, shortsword()?])
}

fn advantage_and_crits_on_hit() -> Result<Turn, DiceError> {
    let grant = advantage().crit_on_hit().until_end_of_turn();
    bare(vec![
        shortsword()?.on_every_hit_with(Grants::One(grant.into()), None)?,
        shortsword()?,
    ])
}

fn first_hit_auto_crit() -> Result<Turn, DiceError> {
    bare(vec![shortsword()?, shortsword()?])?.on_first_hit_with(
        crit_on_hit().until_end_of_turn(),
        FirstHitOptions::default(),
    )
}

fn first_hit_save_or_next_attack() -> Result<Turn, DiceError> {
    bare(vec![fist()?, fist()?, fist()?])?
        .on_first_hit_with(end_of_turn(), save_or_next_attack(2.0, None)?)
}

fn first_hit_damage_and_advantage() -> Result<Turn, DiceError> {
    advantage_chain()?.on_first_hit_with(
        vec![
            EffectPart::Damage(damage(rs(3.0, 6.0)?)),
            EffectPart::Grant(end_of_turn().into()),
        ],
        FirstHitOptions::default(),
    )
}

fn damage_always_advantage_on_failed_save() -> Result<Turn, DiceError> {
    let options = FirstHitOptions {
        condition: ConditionOptions {
            rider: rid("advantage"),
            save: Some(save_dc(4.0, 15.0)?),
            ..ConditionOptions::default()
        },
        ..FirstHitOptions::default()
    };
    bare(vec![shortsword()?, shortsword()?, dagger()?])?
        .on_first_hit_with(d8(), FirstHitOptions::default())?
        .on_first_hit_with(end_of_turn(), options)
}

fn two_first_hit_conditions() -> Result<Turn, DiceError> {
    bare(vec![
        small_fist()?,
        small_fist()?,
        small_fist()?,
        small_fist()?,
    ])?
    .on_first_hit_with(
        vec![
            EffectPart::Damage(damage(rs(3.0, 6.0)?)),
            EffectPart::Grant(end_of_turn().into()),
        ],
        FirstHitOptions::default(),
    )?
    .on_first_hit_with(end_of_turn(), save_or_next_attack(2.0, None)?)
}

fn everything_at_once() -> Result<Turn, DiceError> {
    let sword = rapier()?.on_every_hit_with(next_attack(), None)?;
    bare(vec![sword.clone(), sword, small_fist()?, small_fist()?])?
        .on_first_hit_with(d6(), FirstHitOptions::default())?
        .on_first_hit_with(end_of_turn(), save_or_next_attack(2.0, None)?)
}

fn condition_at_turn_start(chance: f64) -> Result<Turn, DiceError> {
    let grant = advantage().crit_on_hit().until_end_of_turn();
    let gate = ConditionGate {
        chance: Some(chance),
        ..ConditionGate::default()
    };
    let start = d20()
        .always_hits()?
        .on_hit(flat(0.0)?)?
        .on_every_hit_with(Grants::One(grant.into()), Some(gate))?;
    bare(vec![start, shortsword()?, shortsword()?])
}

fn sometimes_attack() -> Result<Turn, DiceError> {
    let sword = attack_roll(9.0, 16.0, d6().plus(5.0)?)?.on_every_hit_with(next_attack(), None)?;
    let knife = attack_roll(9.0, 16.0, d4().plus(5.0)?)?;
    bare(vec![sword.clone(), knife])?.attack_with(
        sword,
        AttackOptions {
            chance: Some(0.5),
            ..AttackOptions::default()
        },
    )
}

const EVERYTHING_AT_ONCE_ADVANTAGE_EXPECTED: [f64; 4] = [0.0, 0.65, 0.8457, 0.6061];

#[test]
fn documented_means() -> R<()> {
    let mut want = expect(FILE, "");
    let mut check = |turn: Result<Turn, DiceError>, expected: f64| -> R<()> {
        close(want.mean(&turn?), expected, 4);
        Ok(())
    };
    check(advantage_chain(), 19.2211)?;
    check(plain_trio(), 16.4)?;
    check(advantage_chain_of_four(), 27.5867)?;
    check(advantage_only_among_swords(), 17.765)?;
    check(chance_gated_advantage(), 11.946)?;
    check(save_gated_rest_of_turn(), 19.7207)?;
    check(crit_grants_advantage(), 17.31)?;
    check(advantage_and_crits_on_hit(), 14.5395)?;
    check(first_hit_auto_crit(), 12.765)?;
    check(first_hit_save_or_next_attack(), 19.7618)?;
    check(first_hit_damage_and_advantage(), 30.1893)?;
    check(damage_always_advantage_on_failed_save(), 22.5216)?;
    check(two_first_hit_conditions(), 35.9905)?;
    check(everything_at_once(), 30.8749)?;
    check(condition_at_turn_start(1.0), 21.06)?;
    check(condition_at_turn_start(0.6), 17.196)?;
    check(sometimes_attack(), 15.7481)?;
    want.done();
    Ok(())
}

#[test]
fn reports_p_the_save_gated_grant_was_applied_where_a_later_attack_reads_it() -> R<()> {
    let mut want = expect(
        FILE,
        &format!(
            "{SUITE} > reports P(the save-gated grant was applied where a later attack reads it)"
        ),
    );
    close(
        want.fire(&damage_always_advantage_on_failed_save()?, "advantage"),
        0.4388,
        4,
    );
    want.done();
    Ok(())
}

#[test]
fn reads_each_swings_odds_of_having_advantage_through_step_stats() -> R<()> {
    let mut want = expect(
        FILE,
        &format!("{SUITE} > reads each swing's odds of having advantage through stepStats"),
    );
    let t = everything_at_once()?;
    let ids = t.attack_ids()?;
    let live: Vec<f64> = ids
        .iter()
        .map(|id| want.step_stats(&t, id).live.advantage())
        .collect();
    assert_eq!(live.len(), EVERYTHING_AT_ONCE_ADVANTAGE_EXPECTED.len());
    for (value, expected) in live.iter().zip(EVERYTHING_AT_ONCE_ADVANTAGE_EXPECTED) {
        close(*value, expected, 4);
    }
    want.done();
    Ok(())
}
