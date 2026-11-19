//! Golden catalog `e` (steps stretch: contexts, joins, cap masks, substitutes, gates, errors):
//! mirrors the `catalog` of `dump_e.gen.ts.txt` entry for entry; `plans_e.json` is what the TS
//! wrote. Test: [`golden_plans_e`].

use super::catalog::{R, axe, ids, named, orb, plain, rs, sword, three, two};
use super::{compare, dump};
use crate::EPS;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::types::MissRerollMode;
use crate::error::DiceError;
use crate::turn::context::{ContextualSource, RowCheck, RowContext};
use crate::turn::plan::{FoldMode, build_plan};
use crate::turn::types::{
    After, AfterLanding, ArcContextual, Attack, AttackOptions, AttackRule, AttackRuleModifier as M,
    AttackTriggerOn, ConditionOn, ConditionRule, ConditionSpec, ConditionUntil, DamageSource,
    EffectSpec, GrantSaveSpec, GrantSaves, GrantSpec, GrantUntil, Rider, RiderDamage,
    RiderDamageSpec, RiderLanding, RiderPayload, SaveUntil, Source, SubstituteKind, SubstituteOn,
    SubstitutePolicy, SubstituteSpec, Trigger, TurnSpec,
};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;

const EVERY: ConditionOn = ConditionOn::Attack(AttackTriggerOn::EveryHit);

struct Entry {
    name: &'static str,
    spec: R<TurnSpec>,
    folds: FoldMode,
    declined: &'static [&'static str],
}

fn e(name: &'static str, spec: R<TurnSpec>) -> Entry {
    Entry {
        name,
        spec,
        folds: FoldMode::Joint,
        declined: &[],
    }
}

fn masses(name: &'static str, spec: R<TurnSpec>) -> Entry {
    Entry {
        name,
        spec,
        folds: FoldMode::Masses,
        declined: &[],
    }
}

// --- builders -----------------------------------------------------------------------------

/// `d20.plus(7).ac(15).melee().onHit(d8.plus(4))`.
fn msword() -> R<AttackBuilder> {
    d20().plus(7.0)?.ac(15.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

/// `d20.plus(5).dc(14).ability("dex").onSaveFailure(roll(2, 6)).saveHalf()`.
fn dex_save() -> R<crate::builder::save::SaveBuilder> {
    d20()
        .plus(5.0)?
        .dc(14.0)?
        .ability("dex")?
        .on_save_failure_args(&[Arg::Roll(rs(2.0, 6.0)?)])?
        .save_half()
}

/// `d20.plus(3).dc(15).ability("con").onSaveFailure(roll(8, 6)).saveHalf()`.
fn con_save() -> R<crate::builder::save::SaveBuilder> {
    d20()
        .plus(3.0)?
        .dc(15.0)?
        .ability("con")?
        .on_save_failure_args(&[Arg::Roll(rs(8.0, 6.0)?)])?
        .save_half()
}

fn three_melee() -> R<Vec<Attack>> {
    Ok(vec![
        plain("a", msword()?),
        plain("b", msword()?),
        plain("c", msword()?),
    ])
}

/// A source whose rider "sa" pools its dice into the row (src/turn/keep-higher-pin.test.ts).
struct Pooling {
    plain: AttackBuilder,
    pooled: AttackBuilder,
}

impl ContextualSource for Pooling {
    fn row_check(&self) -> RowCheck {
        ContextualSource::row_check(&self.plain)
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        let base = if context.joined.iter().any(|id| id == "sa") {
            &self.pooled
        } else {
            &self.plain
        };
        ContextualSource::under(base, context, eps)
    }
}

fn pooling_row() -> R<Source> {
    let plain = d20()
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?)?;
    let pooled = d20()
        .plus(5.0)?
        .ac(15.0)?
        .on_hit(rs(1.0, 8.0)?.plus(3.0)?.plus_dice(3.0, &d6())?)?;
    Ok(Source::Contextual(ArcContextual(Arc::new(Pooling {
        plain,
        pooled,
    }))))
}

// --- spec pieces --------------------------------------------------------------------------

fn atk_with(id: &str, source: impl Into<Source>, extra: impl FnOnce(&mut AttackOptions)) -> Attack {
    named(id, source, extra)
}

fn spec_of(attacks: Vec<Attack>) -> TurnSpec {
    TurnSpec {
        attacks,
        ..TurnSpec::default()
    }
}

fn grant_spec(
    advantage: bool,
    disadvantage: bool,
    crit_on_hit: bool,
    until: GrantUntil,
) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage,
        disadvantage,
        crit_on_hit,
        until,
        to: None,
    })
}

fn adv(until: GrantUntil) -> EffectSpec {
    grant_spec(true, false, false, until)
}

fn dis(until: GrantUntil) -> EffectSpec {
    grant_spec(false, true, false, until)
}

fn crit_on(until: GrantUntil) -> EffectSpec {
    grant_spec(false, false, true, until)
}

const NEXT: GrantUntil = GrantUntil::NextAttack;
const EOT: GrantUntil = GrantUntil::EndOfTurn;

fn cnd(id: &str, on: ConditionOn, of: &[&str], grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: Some(id.to_string()),
        on,
        of: if of.is_empty() { None } else { ids(of) },
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

fn with_conds(attacks: Vec<Attack>, conditions: Vec<ConditionSpec>) -> TurnSpec {
    TurnSpec {
        conditions: Some(conditions),
        ..spec_of(attacks)
    }
}

fn with_riders_of(attacks: Vec<Attack>, riders: Vec<Rider>) -> TurnSpec {
    TurnSpec {
        riders: Some(riders),
        ..spec_of(attacks)
    }
}

fn rd(id: &str, trigger: Trigger, damage: impl Into<DamageSource>) -> Rider {
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

fn fh(of: &[&str]) -> Trigger {
    Trigger::FirstHit {
        of: if of.is_empty() { None } else { ids(of) },
        per_source: None,
    }
}

fn eh(of: &[&str], max: Option<f64>) -> Trigger {
    Trigger::EveryHit {
        of: if of.is_empty() { None } else { ids(of) },
        max,
        per_source: None,
    }
}

fn ac_trigger(of: &[&str]) -> Trigger {
    Trigger::AnyCrit {
        of: if of.is_empty() { None } else { ids(of) },
        max: None,
    }
}

fn sub(id: &str, on: SubstituteOn, kind: SubstituteKind, of: &[&str]) -> SubstituteSpec {
    SubstituteSpec {
        id: Some(id.to_string()),
        on,
        of: if of.is_empty() { None } else { ids(of) },
        substitute: kind,
        mode: None,
        policy: None,
    }
}

fn kh(of: &[&str], policy: Option<SubstitutePolicy>) -> SubstituteSpec {
    SubstituteSpec {
        policy,
        ..sub(
            "kh",
            SubstituteOn::FirstHit,
            SubstituteKind::RerollKeepHigher,
            of,
        )
    }
}

const BELOW: SubstitutePolicy = SubstitutePolicy::Below {
    hit: 6.0,
    crit: 8.0,
};

fn with_subs(attacks: Vec<Attack>, substitutes: Vec<SubstituteSpec>) -> TurnSpec {
    TurnSpec {
        substitutes: Some(substitutes),
        ..spec_of(attacks)
    }
}

fn rule_of(melee: M, ranged: M) -> ConditionRule {
    ConditionRule {
        attack: Some(AttackRule {
            melee: Some(vec![melee]),
            ranged: Some(vec![ranged]),
        }),
        ..ConditionRule::default()
    }
}

fn prone() -> ConditionRule {
    rule_of(M::Advantage, M::Disadvantage)
}

fn awake() -> ConditionRule {
    rule_of(M::Advantage, M::Advantage)
}

fn condition_effect(name: &str, rule: ConditionRule, until: ConditionUntil) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.to_string(),
        rule,
        until,
    }
}

fn save_penalty(sides: f64, until: SaveUntil) -> EffectSpec {
    EffectSpec::SavePenalty {
        count: 1.0,
        sides,
        until,
        to: None,
    }
}

fn gate_after(of: &str, landing: AfterLanding) -> impl FnOnce(&mut AttackOptions) {
    let after = After {
        of: of.to_string(),
        landing,
    };
    move |options| options.after = Some(after)
}

fn chance(c: f64) -> impl FnOnce(&mut AttackOptions) {
    move |options| options.chance = Some(c)
}

fn catalog() -> Vec<Entry> {
    vec![
        e(
            "ctx_adv_eot",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])],
                ))
            })(),
        ),
        e(
            "ctx_disadv_next",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![cnd("cnd", EVERY, &["a"], vec![dis(NEXT)])],
                ))
            })(),
        ),
        e(
            "ctx_crit_on_hit_next",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![cnd("cnd", EVERY, &["a"], vec![crit_on(NEXT)])],
                ))
            })(),
        ),
        e(
            "ctx_adv_and_disadv",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![
                        cnd("c1", EVERY, &["a"], vec![adv(EOT)]),
                        cnd("c2", EVERY, &["b"], vec![dis(EOT)]),
                    ],
                ))
            })(),
        ),
        e(
            "ctx_three_flags",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![
                        cnd("c1", EVERY, &["a"], vec![adv(EOT)]),
                        cnd("c2", EVERY, &["a"], vec![crit_on(EOT)]),
                        cnd("c3", EVERY, &["b"], vec![EffectSpec::Vulnerability]),
                    ],
                ))
            })(),
        ),
        e(
            "ctx_penalty_two_flags",
            (|| {
                Ok(with_conds(
                    vec![
                        plain("a", sword()?),
                        plain("b", sword()?),
                        plain("fb", dex_save()?),
                    ],
                    vec![
                        cnd(
                            "p1",
                            EVERY,
                            &["a"],
                            vec![save_penalty(4.0, SaveUntil::EndOfTurn)],
                        ),
                        cnd(
                            "p2",
                            EVERY,
                            &["b"],
                            vec![save_penalty(6.0, SaveUntil::EndOfTurn)],
                        ),
                    ],
                ))
            })(),
        ),
        e(
            "ctx_penalty_save_disadv",
            (|| {
                Ok(with_conds(
                    vec![
                        plain("a", sword()?),
                        plain("b", sword()?),
                        plain("fb", dex_save()?),
                    ],
                    vec![
                        cnd(
                            "p1",
                            EVERY,
                            &["a"],
                            vec![save_penalty(4.0, SaveUntil::NextSave)],
                        ),
                        cnd(
                            "p2",
                            EVERY,
                            &["b"],
                            vec![EffectSpec::SaveDisadvantage {
                                until: SaveUntil::EndOfTurn,
                                to: None,
                            }],
                        ),
                    ],
                ))
            })(),
        ),
        e(
            "ctx_exhaustion_start",
            (|| {
                let rule = ConditionRule {
                    d20_penalty: Some(2.0),
                    ..ConditionRule::default()
                };
                Ok(with_conds(
                    vec![plain("fb", con_save()?)],
                    vec![cnd(
                        "ex",
                        ConditionOn::Start,
                        &[],
                        vec![condition_effect(
                            "exhaustion",
                            rule,
                            ConditionUntil::EndOfTurn,
                        )],
                    )],
                ))
            })(),
        ),
        e(
            "ctx_vuln_next_hit",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![cnd("cnd", EVERY, &["a"], vec![EffectSpec::Vulnerability])],
                ))
            })(),
        ),
        e(
            "ctx_vuln_and_crit",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![cnd(
                        "cnd",
                        EVERY,
                        &["a"],
                        vec![EffectSpec::Vulnerability, crit_on(NEXT)],
                    )],
                ))
            })(),
        ),
        e(
            "ctx_adv_chance_row",
            (|| {
                Ok(with_conds(
                    vec![
                        plain("a", sword()?),
                        atk_with("b", axe()?, chance(0.5)),
                        plain("c", sword()?),
                    ],
                    vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])],
                ))
            })(),
        ),
        e(
            "ctx_grant_chance_source",
            (|| {
                Ok(with_conds(
                    vec![
                        atk_with("a", sword()?, chance(0.5)),
                        plain("b", axe()?),
                        plain("c", sword()?),
                    ],
                    vec![cnd("cnd", EVERY, &["a"], vec![adv(NEXT)])],
                ))
            })(),
        ),
        e(
            "ctx_rider_attack_shaped",
            (|| {
                Ok(TurnSpec {
                    conditions: Some(vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])]),
                    ..with_riders_of(three()?, vec![rd("rr", ac_trigger(&[]), axe()?)])
                })
            })(),
        ),
        e(
            "joins_pooling",
            (|| {
                let mut sa = rd("sa", fh(&[]), rs(3.0, 6.0)?);
                sa.joins = ids(&["a", "b"]);
                Ok(TurnSpec {
                    conditions: Some(vec![cnd(
                        "vex",
                        ConditionOn::Attack(AttackTriggerOn::FirstMiss),
                        &["a"],
                        vec![adv(NEXT)],
                    )]),
                    substitutes: Some(vec![SubstituteSpec {
                        id: Some("savage".to_string()),
                        ..sub(
                            "",
                            SubstituteOn::FirstHit,
                            SubstituteKind::RerollKeepHigher,
                            &[],
                        )
                    }]),
                    ..with_riders_of(
                        vec![plain("a", pooling_row()?), plain("b", pooling_row()?)],
                        vec![sa],
                    )
                })
            })(),
        ),
        e(
            "joins_pooling_plain",
            (|| {
                let mut sa = rd("sa", fh(&[]), rs(3.0, 6.0)?);
                sa.joins = ids(&["a", "b"]);
                Ok(with_riders_of(
                    vec![plain("a", pooling_row()?), plain("b", pooling_row()?)],
                    vec![sa],
                ))
            })(),
        ),
        e(
            "joins_pooling_counter",
            (|| {
                let mut sa = rd("sa", eh(&[], Some(2.0)), rs(1.0, 6.0)?);
                sa.joins = ids(&["a", "b", "c"]);
                Ok(with_riders_of(
                    vec![
                        plain("a", pooling_row()?),
                        plain("b", pooling_row()?),
                        plain("c", pooling_row()?),
                    ],
                    vec![sa],
                ))
            })(),
        ),
        e(
            "joins_pooling_per_source",
            (|| {
                let mut per_source: IndexMap<String, RiderPayload> = IndexMap::new();
                per_source.insert(
                    "b".to_string(),
                    RiderPayload {
                        damage: RiderDamage::One(d8().into()),
                        crit_damage: None,
                    },
                );
                let mut sa = rd(
                    "sa",
                    Trigger::FirstHit {
                        of: None,
                        per_source: Some(per_source),
                    },
                    d6(),
                );
                sa.joins = ids(&["b"]);
                Ok(with_riders_of(
                    vec![plain("a", pooling_row()?), plain("b", pooling_row()?)],
                    vec![sa],
                ))
            })(),
        ),
        e(
            "cap_two_counters",
            (|| {
                Ok(with_riders_of(
                    three()?,
                    vec![
                        rd("eh2", eh(&[], Some(2.0)), d6()),
                        rd("eh3", eh(&[], Some(3.0)), d4()),
                    ],
                ))
            })(),
        ),
        e(
            "cap_coin_counter",
            (|| {
                let mut r = rd("eh", eh(&[], Some(2.0)), d6());
                r.happens = Some(0.5);
                Ok(with_riders_of(three()?, vec![r]))
            })(),
        ),
        e(
            "cap_target_has",
            (|| {
                let mut top = cnd(
                    "top",
                    EVERY,
                    &["a"],
                    vec![condition_effect(
                        "prone",
                        prone(),
                        ConditionUntil::EndOfTurn,
                    )],
                );
                top.save = Some(GrantSaves::One(GrantSaveSpec::Dc {
                    ability: Some("con".to_string()),
                    dc: 15.0,
                    bonus: 3.0,
                    roll_type: None,
                }));
                let mut r = rd("eh", eh(&["b", "c"], None), d6());
                r.target_has = ids(&["prone"]);
                Ok(TurnSpec {
                    conditions: Some(vec![top]),
                    ..with_riders_of(three_melee()?, vec![r])
                })
            })(),
        ),
        e(
            "cap_target_has_capped",
            (|| {
                let top = cnd(
                    "top",
                    EVERY,
                    &["a"],
                    vec![condition_effect(
                        "prone",
                        prone(),
                        ConditionUntil::EndOfTurn,
                    )],
                );
                let mut r = rd("eh", eh(&["b", "c"], Some(1.0)), d6());
                r.target_has = ids(&["prone"]);
                Ok(TurnSpec {
                    conditions: Some(vec![top]),
                    ..with_riders_of(three_melee()?, vec![r])
                })
            })(),
        ),
        e(
            "sub_below_three",
            (|| Ok(with_subs(three()?, vec![kh(&[], Some(BELOW))])))(),
        ),
        e(
            "sub_below_subset",
            (|| Ok(with_subs(three()?, vec![kh(&["a", "b"], Some(BELOW))])))(),
        ),
        e(
            "sub_below_folded_rider",
            (|| {
                let mut per_source: IndexMap<String, RiderPayload> = IndexMap::new();
                per_source.insert(
                    "b".to_string(),
                    RiderPayload {
                        damage: RiderDamage::One(d8().into()),
                        crit_damage: None,
                    },
                );
                let ps = rd(
                    "ps",
                    Trigger::FirstHit {
                        of: None,
                        per_source: Some(per_source),
                    },
                    d6(),
                );
                Ok(TurnSpec {
                    substitutes: Some(vec![kh(&[], Some(BELOW))]),
                    ..with_riders_of(three()?, vec![ps])
                })
            })(),
        ),
        e(
            "sub_below_gate",
            (|| {
                Ok(with_subs(
                    vec![
                        plain("a", sword()?),
                        atk_with("b", axe()?, gate_after("a", AfterLanding::Hit)),
                        plain("c", sword()?),
                    ],
                    vec![kh(&[], Some(BELOW))],
                ))
            })(),
        ),
        e(
            "sub_below_ctx",
            (|| {
                Ok(TurnSpec {
                    conditions: Some(vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])]),
                    ..with_subs(three()?, vec![kh(&[], Some(BELOW))])
                })
            })(),
        ),
        e(
            "sub_always_and_reroll",
            (|| {
                Ok(with_subs(
                    three()?,
                    vec![
                        kh(&[], None),
                        sub("rr", SubstituteOn::FirstMiss, SubstituteKind::Reroll, &[]),
                    ],
                ))
            })(),
        ),
        e(
            "sub_convert_and_reroll",
            (|| {
                let mut rr = sub(
                    "rr",
                    SubstituteOn::FirstMiss,
                    SubstituteKind::Reroll,
                    &["b", "c"],
                );
                rr.mode = Some(MissRerollMode::AddD20);
                Ok(with_subs(
                    three()?,
                    vec![
                        sub("conv", SubstituteOn::FirstMiss, SubstituteKind::Hit, &["a"]),
                        rr,
                    ],
                ))
            })(),
        ),
        e(
            "sub_reroll_subset_and_keep_higher",
            (|| {
                Ok(with_subs(
                    three()?,
                    vec![
                        kh(&["a"], None),
                        sub(
                            "rr",
                            SubstituteOn::FirstMiss,
                            SubstituteKind::Reroll,
                            &["b"],
                        ),
                    ],
                ))
            })(),
        ),
        e(
            "wounds_until_damaged",
            (|| {
                Ok(with_conds(
                    three_melee()?,
                    vec![cnd(
                        "cnd",
                        EVERY,
                        &["a"],
                        vec![condition_effect(
                            "asleep",
                            awake(),
                            ConditionUntil::UntilDamaged,
                        )],
                    )],
                ))
            })(),
        ),
        e(
            "wounds_chance_row",
            (|| {
                Ok(TurnSpec {
                    conditions: Some(vec![cnd(
                        "cnd",
                        EVERY,
                        &["a"],
                        vec![condition_effect(
                            "asleep",
                            awake(),
                            ConditionUntil::UntilDamaged,
                        )],
                    )]),
                    ..with_riders_of(
                        vec![
                            plain("a", msword()?),
                            atk_with("b", msword()?, chance(0.5)),
                            plain("c", msword()?),
                        ],
                        vec![rd("eh", eh(&["b"], None), d6())],
                    )
                })
            })(),
        ),
        e(
            "damage_riders_happens",
            (|| {
                let mut first = rd("fh", fh(&[]), d6());
                first.happens = Some(0.5);
                let mut crit = rd("cr", ac_trigger(&[]), d4());
                crit.crit_damage = Some(RiderDamage::One(rs(2.0, 4.0)?.into()));
                crit.happens = Some(0.25);
                Ok(with_riders_of(
                    vec![plain("a", sword()?)],
                    vec![first, crit],
                ))
            })(),
        ),
        e(
            "not_fired_substitute",
            (|| {
                Ok(TurnSpec {
                    substitutes: Some(vec![kh(&[], None)]),
                    ..with_riders_of(
                        two()?,
                        vec![rd(
                            "nf",
                            Trigger::NotFired {
                                of: "kh".to_string(),
                            },
                            d4(),
                        )],
                    )
                })
            })(),
        ),
        e(
            "first_miss_multi",
            (|| {
                Ok(with_riders_of(
                    three()?,
                    vec![rd("fm", Trigger::FirstMiss { of: None }, d6())],
                ))
            })(),
        ),
        e(
            "any_miss_damage",
            (|| {
                Ok(with_riders_of(
                    three()?,
                    vec![rd("am", Trigger::AnyMiss { of: None }, d6())],
                ))
            })(),
        ),
        e(
            "gate_fired_folded",
            (|| {
                let mut per_source: IndexMap<String, RiderPayload> = IndexMap::new();
                per_source.insert(
                    "b".to_string(),
                    RiderPayload {
                        damage: RiderDamage::One(d8().into()),
                        crit_damage: None,
                    },
                );
                let ps = rd(
                    "ps",
                    Trigger::FirstHit {
                        of: ids(&["a", "b"]),
                        per_source: Some(per_source),
                    },
                    d6(),
                );
                Ok(with_riders_of(
                    vec![
                        plain("a", sword()?),
                        plain("b", axe()?),
                        atk_with("c", sword()?, gate_after("ps", AfterLanding::Hit)),
                    ],
                    vec![ps],
                ))
            })(),
        ),
        e(
            "gate_any_crit_rider",
            (|| {
                Ok(with_riders_of(
                    vec![
                        plain("a", sword()?),
                        plain("b", axe()?),
                        atk_with("c", sword()?, gate_after("cr", AfterLanding::Any)),
                    ],
                    vec![rd("cr", ac_trigger(&["a", "b"]), d6())],
                ))
            })(),
        ),
        e(
            "gate_dice_match_rider",
            (|| {
                Ok(with_riders_of(
                    vec![
                        plain("a", orb()?),
                        atk_with("b", axe()?, gate_after("dm", AfterLanding::Hit)),
                    ],
                    vec![rd(
                        "dm",
                        Trigger::DiceMatch {
                            of: vec!["a".to_string()],
                        },
                        rs(2.0, 6.0)?,
                    )],
                ))
            })(),
        ),
        e(
            "gate_every_hit_rider",
            (|| {
                Ok(with_riders_of(
                    vec![
                        plain("a", sword()?),
                        plain("b", axe()?),
                        atk_with("c", sword()?, gate_after("eh", AfterLanding::Hit)),
                    ],
                    vec![rd("eh", eh(&["a", "b"], None), d6())],
                ))
            })(),
        ),
        e(
            "gate_every_hit_any",
            (|| {
                let mut r = rd("eh", eh(&["a", "b"], None), d6());
                r.landing = Some(RiderLanding::Any);
                Ok(with_riders_of(
                    vec![
                        plain("a", sword()?),
                        plain("b", axe()?),
                        atk_with("c", sword()?, gate_after("eh", AfterLanding::Any)),
                    ],
                    vec![r],
                ))
            })(),
        ),
        e(
            "err_unused_crit_damage_first_miss",
            (|| {
                let mut x = rd("x", Trigger::FirstMiss { of: None }, sword()?);
                x.crit_damage = Some(RiderDamage::One(rs(2.0, 6.0)?.into()));
                Ok(with_riders_of(three()?, vec![x]))
            })(),
        ),
        e(
            "err_happens_attack_rider",
            (|| {
                let mut x = rd("x", Trigger::FirstMiss { of: None }, sword()?);
                x.happens = Some(0.5);
                Ok(with_riders_of(three()?, vec![x]))
            })(),
        ),
        e(
            "err_list_rider_reads_grant",
            (|| {
                let mut lr = rd("lr", fh(&[]), d6());
                lr.damage = RiderDamageSpec::Plain(RiderDamage::Many(vec![
                    DamageSource::from(sword()?),
                    DamageSource::from(axe()?),
                ]));
                Ok(TurnSpec {
                    conditions: Some(vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])]),
                    ..with_riders_of(two()?, vec![lr])
                })
            })(),
        ),
        e(
            "err_any_miss_reads_grant",
            (|| {
                Ok(TurnSpec {
                    conditions: Some(vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])]),
                    ..with_riders_of(
                        three()?,
                        vec![rd("rr", Trigger::AnyMiss { of: None }, axe()?)],
                    )
                })
            })(),
        ),
        e(
            "err_any_miss_grant_source",
            (|| {
                let mut to_c = cnd(
                    "cnd",
                    EVERY,
                    &[],
                    vec![EffectSpec::Grant(GrantSpec {
                        advantage: true,
                        disadvantage: false,
                        crit_on_hit: false,
                        until: NEXT,
                        to: ids(&["c"]),
                    })],
                );
                to_c.of = None;
                Ok(TurnSpec {
                    conditions: Some(vec![to_c]),
                    ..with_riders_of(
                        three()?,
                        vec![rd("rr", Trigger::AnyMiss { of: None }, axe()?)],
                    )
                })
            })(),
        ),
        e(
            "ctx_plain_roll_row",
            (|| {
                Ok(with_conds(
                    vec![
                        plain("a", sword()?),
                        plain("b", Source::Damage(DamageSource::Roll(rs(2.0, 6.0)?))),
                    ],
                    vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])],
                ))
            })(),
        ),
        Entry {
            name: "cond_optional_declined",
            spec: (|| {
                let mut c = cnd("cnd", EVERY, &["a"], vec![adv(EOT)]);
                c.optional = true;
                Ok(with_conds(three()?, vec![c]))
            })(),
            folds: FoldMode::Joint,
            declined: &["cnd"],
        },
        masses(
            "ctx_adv_eot_masses",
            (|| {
                Ok(with_conds(
                    three()?,
                    vec![cnd("cnd", EVERY, &["a"], vec![adv(EOT)])],
                ))
            })(),
        ),
        masses(
            "sub_below_three_masses",
            (|| Ok(with_subs(three()?, vec![kh(&[], Some(BELOW))])))(),
        ),
        masses(
            "cap_two_counters_masses",
            (|| {
                Ok(with_riders_of(
                    three()?,
                    vec![
                        rd("eh2", eh(&[], Some(2.0)), d6()),
                        rd("eh3", eh(&[], Some(3.0)), d4()),
                    ],
                ))
            })(),
        ),
        masses(
            "wounds_until_damaged_masses",
            (|| {
                Ok(with_conds(
                    three_melee()?,
                    vec![cnd(
                        "cnd",
                        EVERY,
                        &["a"],
                        vec![condition_effect(
                            "asleep",
                            awake(),
                            ConditionUntil::UntilDamaged,
                        )],
                    )],
                ))
            })(),
        ),
    ]
}

#[test]
fn golden_plans_e() {
    let golden: Value = match serde_json::from_str(include_str!("plans_e.json")) {
        Ok(value) => value,
        Err(e) => panic!("plans_e.json is not JSON: {e}"),
    };
    let mut failures: Vec<String> = Vec::new();
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for entry in catalog() {
        names.insert(entry.name);
        let Some(expected) = golden.get(entry.name) else {
            failures.push(format!(
                "{}: not in plans_e.json (regenerate it)",
                entry.name
            ));
            continue;
        };
        let actual = match &entry.spec {
            Err(message) => serde_json::json!({ "error": {
                "class": "Error", "code": Value::Null, "id": Value::Null, "message": message.message(),
            } }),
            Ok(spec) => {
                let declined: HashSet<String> = entry
                    .declined
                    .iter()
                    .map(std::string::ToString::to_string)
                    .collect();
                match build_plan(spec, EPS, &declined, entry.folds) {
                    Ok(plan) => serde_json::json!({ "plan": dump::dump_plan(&plan) }),
                    Err(error) => dump::error_dump(&error),
                }
            }
        };
        let diffs = compare::compare(&actual, expected, entry.name);
        if !diffs.is_empty() {
            failures.push(format!("{}: {} mismatches", entry.name, diffs.len()));
            failures.extend(diffs.into_iter().take(15));
        }
    }
    if let Some(map) = golden.as_object() {
        for key in map.keys() {
            if !names.contains(key.as_str()) {
                failures.push(format!(
                    "{key}: in plans_e.json but not in the Rust catalog"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "plan golden e mismatches:\n{}",
        failures.join("\n")
    );
}
