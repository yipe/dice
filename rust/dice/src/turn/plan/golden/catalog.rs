//! The spec catalog of the plan golden test: mirrors the `catalog` of `dump.gen.ts.txt` entry for
//! entry (same names, same order). To add a spec: add it to both, regenerate `plans.json` (see the
//! top of the `.txt`), and `cargo test --lib turn::plan::golden`.

use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::save::SaveBuilder;
use crate::builder::types::MissRerollMode;
use crate::error::DiceError;
use crate::turn::types::{
    After, AfterLanding, Attack, AttackOptions, AttackRule, AttackRuleModifier, AttackTriggerOn,
    ConditionOn, ConditionRule, ConditionSpec, ConditionUntil, DamageSource, EffectSpec,
    GrantSaveSpec, GrantSaves, GrantSpec, GrantUntil, MAX_TRIGGER_GROUPS, ProbeOn, ProbeSpec,
    Rider, RiderDamage, RiderDamageSpec, RiderLanding, RiderPayload, SaveLanding, SaveUntil,
    Source, SubstituteKind, SubstituteOn, SubstitutePolicy, SubstituteSpec, Trigger, TurnSpec,
};
use indexmap::IndexMap;

pub(super) type R<T> = Result<T, DiceError>;

/// `roll(count, sides)`.
pub(super) fn rs(count: f64, sides: f64) -> R<RollBuilder> {
    roll_dice(count, sides, None)
}

/// `d20.plus(7).ac(15).onHit(d8.plus(4))`.
pub(super) fn sword() -> R<AttackBuilder> {
    d20().plus(7.0)?.ac(15.0)?.on_hit(d8().plus(4.0)?)
}

/// `d20.plus(5).ac(14).onHit(d6.plus(3))`.
pub(super) fn axe() -> R<AttackBuilder> {
    d20().plus(5.0)?.ac(14.0)?.on_hit(d6().plus(3.0)?)
}

/// `d20.plus(5).ac(17).onHit(roll(3, d8))`.
pub(super) fn orb() -> R<AttackBuilder> {
    d20().plus(5.0)?.ac(17.0)?.on_hit(rs(3.0, 8.0)?)
}

/// `d20.plus(5).dc(14).onSaveFailure(roll(2, 6)).saveHalf()`.
pub(super) fn fireball() -> R<SaveBuilder> {
    d20()
        .plus(5.0)?
        .dc(14.0)?
        .on_save_failure_args(&[Arg::Roll(rs(2.0, 6.0)?)])?
        .save_half()
}

/// `{ id, source, ...extra }`.
pub(super) fn named(
    id: &str,
    source: impl Into<Source>,
    extra: impl FnOnce(&mut AttackOptions),
) -> Attack {
    let mut options = AttackOptions {
        id: Some(id.to_string()),
        ..AttackOptions::default()
    };
    extra(&mut options);
    Attack::Declared {
        options,
        source: source.into(),
    }
}

pub(super) fn plain(id: &str, source: impl Into<Source>) -> Attack {
    named(id, source, |_| {})
}

pub(super) fn two() -> R<Vec<Attack>> {
    Ok(vec![plain("a", sword()?), plain("b", axe()?)])
}

pub(super) fn three() -> R<Vec<Attack>> {
    Ok(vec![
        plain("a", sword()?),
        plain("b", axe()?),
        plain("c", sword()?),
    ])
}

pub(super) fn ids(of: &[&str]) -> Option<Vec<String>> {
    Some(of.iter().map(std::string::ToString::to_string).collect())
}

/// A rider with one plain payload.
pub(super) fn rider(id: &str, trigger: Trigger, damage: impl Into<DamageSource>) -> Rider {
    Rider {
        trigger,
        id: Some(id.to_string()),
        damage: RiderDamageSpec::Plain(RiderDamage::One(damage.into())),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }
}

pub(super) fn first_hit(of: Option<Vec<String>>) -> Trigger {
    Trigger::FirstHit {
        of,
        per_source: None,
    }
}

pub(super) fn every_hit(of: Option<Vec<String>>, max: Option<f64>) -> Trigger {
    Trigger::EveryHit {
        of,
        max,
        per_source: None,
    }
}

pub(super) fn any_crit(max: Option<f64>) -> Trigger {
    Trigger::AnyCrit { of: None, max }
}

pub(super) fn spec(attacks: Vec<Attack>) -> TurnSpec {
    TurnSpec {
        attacks,
        ..TurnSpec::default()
    }
}

pub(super) fn with_riders(attacks: Vec<Attack>, riders: Vec<Rider>) -> TurnSpec {
    TurnSpec {
        riders: Some(riders),
        ..spec(attacks)
    }
}

pub(super) fn with_substitutes(attacks: Vec<Attack>, substitutes: Vec<SubstituteSpec>) -> TurnSpec {
    TurnSpec {
        substitutes: Some(substitutes),
        ..spec(attacks)
    }
}

pub(super) fn with_conditions(attacks: Vec<Attack>, conditions: Vec<ConditionSpec>) -> TurnSpec {
    TurnSpec {
        conditions: Some(conditions),
        ..spec(attacks)
    }
}

pub(super) fn gated(of: &str, landing: AfterLanding) -> impl FnOnce(&mut AttackOptions) {
    let after = After {
        of: of.to_string(),
        landing,
    };
    move |options| options.after = Some(after)
}

pub(super) fn substitute(id: &str, on: SubstituteOn, kind: SubstituteKind) -> SubstituteSpec {
    SubstituteSpec {
        id: Some(id.to_string()),
        on,
        of: None,
        substitute: kind,
        mode: None,
        policy: None,
    }
}

pub(super) fn condition(
    id: &str,
    on: ConditionOn,
    of: &[&str],
    grants: Vec<EffectSpec>,
) -> ConditionSpec {
    ConditionSpec {
        id: Some(id.to_string()),
        on,
        of: ids(of),
        r#where: None,
        chance: None,
        target_has: None,
        landing: None,
        dealing: None,
        target: None,
        save: None,
        grants,
        on_save: None,
        optional: false,
    }
}

pub(super) fn grant(advantage: bool, crit_on_hit: bool, until: GrantUntil) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage,
        disadvantage: false,
        crit_on_hit,
        until,
        to: None,
    })
}

type Entry = (&'static str, R<TurnSpec>);

fn entry(name: &'static str, build: impl FnOnce() -> R<TurnSpec>) -> Entry {
    (name, build())
}

/// The catalog: `(name, spec)`; a builder error is the entry's `Err`.
pub fn catalog() -> Vec<Entry> {
    let d6s: fn() -> RollBuilder = d6;
    vec![
        entry("plain_one", || {
            Ok(spec(vec![Attack::Bare(sword()?.into())]))
        }),
        entry("plain_two", || {
            Ok(spec(vec![plain("x", sword()?), plain("y", axe()?)]))
        }),
        entry("chance_attack", || {
            Ok(spec(vec![named("x", sword()?, |o| o.chance = Some(0.5))]))
        }),
        entry("first_hit_default", || {
            Ok(with_riders(
                two()?,
                vec![rider("sneak", first_hit(None), rs(2.0, 6.0)?)],
            ))
        }),
        entry("any_crit_crit_damage", || {
            let mut smite = rider("smite", any_crit(None), rs(1.0, 6.0)?);
            smite.crit_damage = Some(RiderDamage::One(rs(3.0, 6.0)?.into()));
            Ok(with_riders(vec![plain("a", sword()?)], vec![smite]))
        }),
        entry("any_crit_max2", || {
            Ok(with_riders(
                three()?,
                vec![rider("cr", any_crit(Some(2.0)), d6s())],
            ))
        }),
        entry("any_crit_max1", || {
            Ok(with_riders(
                three()?,
                vec![rider("cr", any_crit(Some(1.0)), d6s())],
            ))
        }),
        entry("any_crit_max_inf", || {
            Ok(with_riders(
                three()?,
                vec![rider("cr", any_crit(Some(f64::INFINITY)), d6s())],
            ))
        }),
        entry("every_hit_uncapped", || {
            Ok(with_riders(
                two()?,
                vec![rider("eh", every_hit(None, None), d6s())],
            ))
        }),
        entry("every_hit_max2", || {
            Ok(with_riders(
                three()?,
                vec![rider("eh", every_hit(None, Some(2.0)), d6s())],
            ))
        }),
        entry("every_hit_happens_half", || {
            let mut eh = rider("eh", every_hit(None, None), d6s());
            eh.happens = Some(0.5);
            Ok(with_riders(two()?, vec![eh]))
        }),
        entry("first_hit_per_source", || {
            let mut per_source: IndexMap<String, RiderPayload> = IndexMap::new();
            per_source.insert(
                "b".to_string(),
                RiderPayload {
                    damage: RiderDamage::One(d8().into()),
                    crit_damage: None,
                },
            );
            let trigger = Trigger::FirstHit {
                of: None,
                per_source: Some(per_source),
            };
            Ok(with_riders(two()?, vec![rider("ps", trigger, d6s())]))
        }),
        entry("not_fired", || {
            Ok(with_riders(
                vec![plain("a", sword()?)],
                vec![
                    rider("sneak", first_hit(None), d6s()),
                    rider(
                        "nf",
                        Trigger::NotFired {
                            of: "sneak".to_string(),
                        },
                        d4(),
                    ),
                ],
            ))
        }),
        entry("any_miss_reroll", || {
            Ok(with_riders(
                two()?,
                vec![rider("rr", Trigger::AnyMiss { of: None }, axe()?)],
            ))
        }),
        entry("first_miss_rider", || {
            Ok(with_riders(
                vec![plain("a", sword()?)],
                vec![rider("fm", Trigger::FirstMiss { of: None }, axe()?)],
            ))
        }),
        entry("dice_match", || {
            Ok(with_riders(
                vec![plain("a", orb()?)],
                vec![rider(
                    "dm",
                    Trigger::DiceMatch {
                        of: vec!["a".to_string()],
                    },
                    rs(2.0, 6.0)?,
                )],
            ))
        }),
        entry("sub_keep_higher_always", || {
            Ok(with_substitutes(
                two()?,
                vec![substitute(
                    "kh",
                    SubstituteOn::FirstHit,
                    SubstituteKind::RerollKeepHigher,
                )],
            ))
        }),
        entry("sub_keep_higher_below", || {
            let mut kh = substitute(
                "kh",
                SubstituteOn::FirstHit,
                SubstituteKind::RerollKeepHigher,
            );
            kh.policy = Some(SubstitutePolicy::Below {
                hit: 6.0,
                crit: 8.0,
            });
            Ok(with_substitutes(two()?, vec![kh]))
        }),
        entry("sub_convert", || {
            Ok(with_substitutes(
                two()?,
                vec![substitute(
                    "conv",
                    SubstituteOn::FirstMiss,
                    SubstituteKind::Hit,
                )],
            ))
        }),
        entry("sub_reroll_add_d20", || {
            let mut rr = substitute("rr", SubstituteOn::FirstMiss, SubstituteKind::Reroll);
            rr.mode = Some(MissRerollMode::AddD20);
            Ok(with_substitutes(two()?, vec![rr]))
        }),
        entry("save_alone", || Ok(spec(vec![plain("fb", fireball()?)]))),
        entry("save_watched_fail", || {
            let mut r = rider("r", first_hit(ids(&["fb"])), d6s());
            r.landing = Some(RiderLanding::Save(SaveLanding::Fail));
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![r],
            ))
        }),
        entry("save_watched_damage", || {
            let mut r = rider("r", first_hit(ids(&["fb"])), d6s());
            r.landing = Some(RiderLanding::Save(SaveLanding::Damage));
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![r],
            ))
        }),
        entry("after_hit", || {
            Ok(spec(vec![
                plain("a", sword()?),
                named("b", axe()?, gated("a", AfterLanding::Hit)),
            ]))
        }),
        entry("after_damage", || {
            Ok(spec(vec![
                plain("a", sword()?),
                named("b", axe()?, gated("a", AfterLanding::Damage)),
            ]))
        }),
        entry("after_any", || {
            Ok(spec(vec![
                plain("a", sword()?),
                named("b", axe()?, gated("a", AfterLanding::Any)),
            ]))
        }),
        entry("rider_after", || {
            Ok(with_riders(
                vec![
                    plain("a", sword()?),
                    named("b", axe()?, gated("sneak", AfterLanding::Hit)),
                ],
                vec![rider("sneak", first_hit(ids(&["a"])), d6s())],
            ))
        }),
        entry("probe_any_crit", || {
            Ok(TurnSpec {
                observe: Some(vec![ProbeSpec {
                    id: Some("p".to_string()),
                    on: ProbeOn::AnyCrit,
                    of: None,
                }]),
                ..spec(two()?)
            })
        }),
        entry("cond_next_attack_advantage", || {
            Ok(with_conditions(
                three()?,
                vec![condition(
                    "cnd",
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    &["a"],
                    vec![grant(true, false, GrantUntil::NextAttack)],
                )],
            ))
        }),
        entry("cond_first_crit_end_of_turn", || {
            let mut cnd = condition(
                "cnd",
                ConditionOn::FirstCrit,
                &["a", "b"],
                vec![grant(false, true, GrantUntil::EndOfTurn)],
            );
            cnd.chance = Some(0.5);
            Ok(with_conditions(three()?, vec![cnd]))
        }),
        entry("cond_grant_save", || {
            let mut cnd = condition(
                "cnd",
                ConditionOn::Attack(AttackTriggerOn::EveryHit),
                &["a"],
                vec![grant(true, false, GrantUntil::NextAttack)],
            );
            cnd.save = Some(GrantSaves::One(GrantSaveSpec::Dc {
                ability: Some("dex".to_string()),
                dc: 13.0,
                bonus: 2.0,
                roll_type: None,
            }));
            Ok(with_conditions(two()?, vec![cnd]))
        }),
        entry("cond_vulnerability", || {
            Ok(with_conditions(
                three()?,
                vec![condition(
                    "cnd",
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    &["a"],
                    vec![EffectSpec::Vulnerability],
                )],
            ))
        }),
        entry("cond_save_penalty", || {
            Ok(with_conditions(
                vec![
                    plain("a", sword()?),
                    plain("fb", fireball()?.ability("dex")?),
                ],
                vec![condition(
                    "cnd",
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    &["a"],
                    vec![EffectSpec::SavePenalty {
                        count: 1.0,
                        sides: 4.0,
                        until: SaveUntil::NextSave,
                        to: None,
                    }],
                )],
            ))
        }),
        entry("cond_start_advantage", || {
            let mut cnd = condition(
                "cnd",
                ConditionOn::Start,
                &[],
                vec![grant(true, false, GrantUntil::EndOfTurn)],
            );
            cnd.of = None;
            Ok(with_conditions(two()?, vec![cnd]))
        }),
        entry("cond_rule_melee_advantage", || {
            let rule = ConditionRule {
                attack: Some(AttackRule {
                    melee: Some(vec![AttackRuleModifier::Advantage]),
                    ranged: Some(vec![AttackRuleModifier::Disadvantage]),
                }),
                ..ConditionRule::default()
            };
            Ok(with_conditions(
                two()?,
                vec![condition(
                    "cnd",
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    &["a"],
                    vec![EffectSpec::Condition {
                        condition: "prone".to_string(),
                        rule,
                        until: ConditionUntil::EndOfTurn,
                    }],
                )],
            ))
        }),
        entry("cond_optional", || {
            let mut cnd = condition(
                "cnd",
                ConditionOn::Attack(AttackTriggerOn::EveryHit),
                &["a"],
                vec![grant(true, false, GrantUntil::NextAttack)],
            );
            cnd.optional = true;
            Ok(with_conditions(three()?, vec![cnd]))
        }),
        entry("rider_joins", || {
            let mut j = rider("j", first_hit(ids(&["a"])), rs(2.0, 6.0)?);
            j.joins = ids(&["a"]);
            Ok(with_riders(vec![plain("a", orb()?)], vec![j]))
        }),
        entry("two_substitutes", || {
            let rr1 = substitute("rr1", SubstituteOn::FirstMiss, SubstituteKind::Reroll);
            let mut rr2 = substitute("rr2", SubstituteOn::FirstMiss, SubstituteKind::Reroll);
            rr2.mode = Some(MissRerollMode::AddD20);
            Ok(with_substitutes(three()?, vec![rr1, rr2]))
        }),
        entry("cond_with_capped_rider", || {
            let cnd = condition(
                "cnd",
                ConditionOn::Attack(AttackTriggerOn::FirstHit),
                &["a", "b"],
                vec![grant(true, false, GrantUntil::EndOfTurn)],
            );
            Ok(TurnSpec {
                conditions: Some(vec![cnd]),
                ..with_riders(
                    three()?,
                    vec![
                        rider("eh", every_hit(None, Some(1.0)), d6s()),
                        rider("cr", any_crit(Some(2.0)), d4()),
                    ],
                )
            })
        }),
        entry("err_unknown_id", || {
            Ok(with_riders(
                vec![plain("d1", sword()?)],
                vec![rider("sneak", first_hit(ids(&["gone"])), d6s())],
            ))
        }),
        entry("err_duplicate_id", || {
            Ok(spec(vec![plain("d1", sword()?), plain("d1", sword()?)]))
        }),
        entry("err_cycle", || {
            Ok(with_riders(
                vec![plain("d1", sword()?)],
                vec![
                    rider(
                        "a",
                        Trigger::NotFired {
                            of: "b".to_string(),
                        },
                        d6s(),
                    ),
                    rider(
                        "b",
                        Trigger::NotFired {
                            of: "a".to_string(),
                        },
                        d6s(),
                    ),
                ],
            ))
        }),
        entry("err_not_an_attack", || {
            Ok(with_riders(
                vec![plain("d1", sword()?)],
                vec![
                    rider("sneak", first_hit(None), rs(3.0, 6.0)?),
                    rider("extra", first_hit(ids(&["sneak"])), d6s()),
                ],
            ))
        }),
        entry("err_too_many_groups", || {
            let mut attacks = Vec::new();
            let mut riders = Vec::new();
            for i in 0..=MAX_TRIGGER_GROUPS {
                let id = format!("a{i}");
                attacks.push(plain(&id, sword()?));
                riders.push(rider(&format!("r{i}"), first_hit(ids(&[&id])), d6s()));
            }
            Ok(with_riders(attacks, riders))
        }),
        entry("err_unused_crit_damage", || {
            let mut x = rider("x", any_crit(None), sword()?);
            x.crit_damage = Some(RiderDamage::One(rs(20.0, 6.0)?.into()));
            Ok(with_riders(
                vec![plain("a", sword()?), plain("b", sword()?)],
                vec![x],
            ))
        }),
    ]
}
