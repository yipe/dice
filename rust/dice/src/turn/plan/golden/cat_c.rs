//! Golden catalog `c` (layout stretch: groups, slots, flags, grants): mirrors the `catalog` of
//! `dump_c.gen.ts.txt` entry for entry; `plans_c.json` is what the TS wrote. Test: [`golden_plans_c`].

use super::catalog::{
    R, axe, every_hit, fireball, first_hit, ids, named, plain, rider, spec, sword, three, two,
    with_conditions, with_riders,
};
use super::{compare, dump};
use crate::EPS;
use crate::builder::factory::*;
use crate::common::RollType;
use crate::turn::plan::{FoldMode, build_plan};
use crate::turn::types::{
    AfterLanding, Attack, AttackRule, AttackRuleModifier as M, AttackTriggerOn, ConditionOn,
    ConditionRule, ConditionSpec, ConditionUntil, EffectSpec, FailChance, GrantSaveSpec,
    GrantSaves, GrantSpec, GrantUntil, OnEnd, ProbeOn, ProbeSpec, Rider, SaveLanding,
    SaveRuleModifier, SaveUntil, Trigger, TurnSpec,
};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

const EVERY: ConditionOn = ConditionOn::Attack(AttackTriggerOn::EveryHit);
const FIRST_HIT: ConditionOn = ConditionOn::Attack(AttackTriggerOn::FirstHit);
const FIRST_MISS: ConditionOn = ConditionOn::Attack(AttackTriggerOn::FirstMiss);

struct Entry {
    name: &'static str,
    spec: R<TurnSpec>,
    folds: FoldMode,
    declined: &'static [&'static str],
}

/// `cnd(id, on, of, grants, extra)`: an empty `of` is an omitted one.
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

fn adv(until: GrantUntil) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: true,
        disadvantage: false,
        crit_on_hit: false,
        until,
        to: None,
    })
}

fn adv_to(until: GrantUntil, to: &[&str]) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: true,
        disadvantage: false,
        crit_on_hit: false,
        until,
        to: ids(to),
    })
}

fn disadv(until: GrantUntil) -> EffectSpec {
    EffectSpec::Grant(GrantSpec {
        advantage: false,
        disadvantage: true,
        crit_on_hit: false,
        until,
        to: None,
    })
}

fn both(m: M) -> ConditionRule {
    ConditionRule {
        attack: Some(AttackRule {
            melee: Some(vec![m]),
            ranged: Some(vec![m]),
        }),
        ..ConditionRule::default()
    }
}

fn by_range(melee: M, ranged: M) -> ConditionRule {
    ConditionRule {
        attack: Some(AttackRule {
            melee: Some(vec![melee]),
            ranged: Some(vec![ranged]),
        }),
        ..ConditionRule::default()
    }
}

fn saves(entries: &[(&str, SaveRuleModifier)]) -> ConditionRule {
    let mut save = IndexMap::new();
    for (key, modifier) in entries {
        save.insert(key.to_string(), vec![*modifier]);
    }
    ConditionRule {
        save: Some(save),
        ..ConditionRule::default()
    }
}

fn rule_eff(name: &str, rule: ConditionRule, until: ConditionUntil) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.to_string(),
        rule,
        until,
    }
}

const EOT: ConditionUntil = ConditionUntil::EndOfTurn;
const DMG: ConditionUntil = ConditionUntil::UntilDamaged;

fn dc(ability: Option<&str>, dc: f64, bonus: f64, roll_type: Option<RollType>) -> GrantSaveSpec {
    GrantSaveSpec::Dc {
        ability: ability.map(str::to_string),
        dc,
        bonus,
        roll_type,
    }
}

fn with_save(mut c: ConditionSpec, save: GrantSaves) -> ConditionSpec {
    c.save = Some(save);
    c
}

fn dex_save(id: &str) -> R<Attack> {
    Ok(plain(id, fireball()?.ability("dex")?))
}

fn three_targets(targets: &[&str]) -> R<Vec<Attack>> {
    let mut attacks = Vec::new();
    for (i, target) in targets.iter().enumerate() {
        let id = ["a", "b", "c", "d"][i];
        let source = if i % 2 == 0 { sword()? } else { axe()? };
        attacks.push(named(id, source, |o| o.target = Some(target.to_string())));
    }
    Ok(attacks)
}

// ---- specs ---------------------------------------------------------------------------------

fn wounds() -> R<TurnSpec> {
    Ok(with_conditions(
        three()?,
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff("stunned", both(M::Advantage), DMG)],
        )],
    ))
}

fn on_end() -> R<TurnSpec> {
    let mut rule = both(M::Advantage);
    rule.on_end = Some(Box::new(OnEnd {
        condition: "prone".to_string(),
        rule: both(M::Disadvantage),
    }));
    Ok(with_conditions(
        three()?,
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff("stunned", rule, DMG)],
        )],
    ))
}

fn range_rule() -> R<TurnSpec> {
    Ok(with_conditions(
        vec![
            plain("a", sword()?),
            plain("b", axe()?.melee()?),
            plain("c", axe()?.ranged()?),
        ],
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff(
                "prone",
                by_range(M::Advantage, M::Disadvantage),
                EOT,
            )],
        )],
    ))
}

fn save_ability_rule() -> R<TurnSpec> {
    let rule = saves(&[
        ("dex", SaveRuleModifier::SaveDisadvantage),
        ("strength", SaveRuleModifier::AutoFail),
    ]);
    Ok(with_conditions(
        vec![
            plain("a", sword()?),
            dex_save("fb")?,
            plain("fs", fireball()?.ability("strength")?),
        ],
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff("restrained", rule, EOT)],
        )],
    ))
}

fn d20_penalty() -> R<TurnSpec> {
    let rule = ConditionRule {
        d20_penalty: Some(2.0),
        ..ConditionRule::default()
    };
    Ok(with_conditions(
        vec![plain("a", sword()?), dex_save("fb")?, plain("c", sword()?)],
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff("exhaustion", rule, EOT)],
        )],
    ))
}

fn three_saves() -> R<Vec<Attack>> {
    Ok(vec![
        plain("a", sword()?),
        plain("f1", fireball()?),
        plain("f2", fireball()?),
    ])
}

fn save_disadvantage_to() -> R<TurnSpec> {
    Ok(with_conditions(
        three_saves()?,
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![EffectSpec::SaveDisadvantage {
                until: SaveUntil::EndOfTurn,
                to: ids(&["f2"]),
            }],
        )],
    ))
}

fn save_penalty_tag() -> R<TurnSpec> {
    Ok(with_conditions(
        vec![
            plain("a", sword()?),
            named("f1", fireball()?, |o| o.tag = Some("area".to_string())),
            named("f2", fireball()?, |o| o.tag = Some("area".to_string())),
            plain("f3", fireball()?),
        ],
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![EffectSpec::SavePenalty {
                count: 2.0,
                sides: 6.0,
                until: SaveUntil::NextSave,
                to: ids(&["area"]),
            }],
        )],
    ))
}

fn grant_to_ids() -> R<TurnSpec> {
    Ok(with_conditions(
        three()?,
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![adv_to(GrantUntil::NextAttack, &["c"])],
        )],
    ))
}

fn multi_creature() -> R<TurnSpec> {
    let mut attacks = three_targets(&["x", "y", "x", "y"])?;
    attacks.truncate(4);
    Ok(with_conditions(
        attacks,
        vec![cnd(
            "cnd",
            EVERY,
            &["a", "b"],
            vec![adv(GrantUntil::EndOfTurn)],
        )],
    ))
}

fn start_target() -> R<TurnSpec> {
    let mut start = cnd(
        "st",
        ConditionOn::Start,
        &[],
        vec![adv(GrantUntil::EndOfTurn)],
    );
    start.target = Some("ogre".to_string());
    Ok(with_conditions(
        vec![
            named("a", sword()?, |o| o.target = Some("ogre".to_string())),
            named("b", axe()?, |o| o.target = Some("ogre".to_string())),
            plain("c", sword()?),
        ],
        vec![start],
    ))
}

fn start_no_id() -> R<TurnSpec> {
    let mut start = cnd(
        "",
        ConditionOn::Start,
        &[],
        vec![rule_eff(
            "prone",
            by_range(M::Advantage, M::Disadvantage),
            EOT,
        )],
    );
    start.id = None;
    Ok(with_conditions(
        vec![
            plain("a", axe()?.melee()?),
            plain("b", axe()?.melee()?),
            plain("c", axe()?.ranged()?),
        ],
        vec![start],
    ))
}

fn once_reader() -> R<TurnSpec> {
    Ok(with_conditions(
        three()?,
        vec![cnd(
            "cnd",
            FIRST_HIT,
            &["a", "b"],
            vec![adv(GrantUntil::NextAttack)],
        )],
    ))
}

fn once_no_reader() -> R<TurnSpec> {
    Ok(with_conditions(
        three()?,
        vec![cnd(
            "cnd",
            FIRST_HIT,
            &["c"],
            vec![adv(GrantUntil::NextAttack)],
        )],
    ))
}

fn once_tried() -> R<TurnSpec> {
    let mut attacks = three_targets(&["x", "y", "y"])?;
    attacks.truncate(3);
    Ok(with_conditions(
        attacks,
        vec![cnd(
            "cnd",
            FIRST_HIT,
            &["a", "b", "c"],
            vec![adv(GrantUntil::EndOfTurn)],
        )],
    ))
}

fn once_first_miss() -> R<TurnSpec> {
    Ok(with_conditions(
        three()?,
        vec![cnd(
            "cnd",
            FIRST_MISS,
            &["a", "b"],
            vec![adv(GrantUntil::EndOfTurn)],
        )],
    ))
}

fn cond_on_rider() -> R<TurnSpec> {
    let mut ps = rider(
        "ps",
        Trigger::FirstHit {
            of: None,
            per_source: Some({
                let mut m = IndexMap::new();
                m.insert(
                    "b".to_string(),
                    crate::turn::types::RiderPayload {
                        damage: crate::turn::types::RiderDamage::One(d8().into()),
                        crit_damage: None,
                    },
                );
                m
            }),
        },
        d6(),
    );
    ps.happens = None;
    let mut t = with_riders(two()?, vec![ps]);
    t.conditions = Some(vec![cnd(
        "cnd",
        FIRST_HIT,
        &["ps"],
        vec![adv(GrantUntil::EndOfTurn)],
    )]);
    Ok(t)
}

fn lasting_on_save() -> R<TurnSpec> {
    let mut c = with_save(
        cnd("cnd", EVERY, &["a"], vec![adv(GrantUntil::EndOfTurn)]),
        GrantSaves::One(dc(None, 13.0, 2.0, None)),
    );
    c.on_save = Some(vec![disadv(GrantUntil::EndOfTurn)]);
    Ok(with_conditions(three()?, vec![c]))
}

fn grant_save_options() -> R<TurnSpec> {
    let c1 = cnd(
        "c1",
        EVERY,
        &["a"],
        vec![
            EffectSpec::SaveDisadvantage {
                until: SaveUntil::EndOfTurn,
                to: None,
            },
            EffectSpec::SavePenalty {
                count: 1.0,
                sides: 4.0,
                until: SaveUntil::EndOfTurn,
                to: None,
            },
        ],
    );
    let c2 = with_save(
        cnd("c2", EVERY, &["b"], vec![adv(GrantUntil::NextAttack)]),
        GrantSaves::Many(vec![
            dc(None, 12.0, 1.0, None),
            dc(None, 14.0, 3.0, Some(RollType::Advantage)),
            dc(None, 20.0, 0.0, Some(RollType::Disadvantage)),
        ]),
    );
    Ok(with_conditions(three()?, vec![c1, c2]))
}

fn fail_chance(
    f: impl Fn(&crate::turn::context::RowContext) -> f64 + Send + Sync + 'static,
) -> GrantSaves {
    GrantSaves::One(GrantSaveSpec::FailChance {
        ability: None,
        fail_chance: FailChance::new(move |c| Ok(f(c))),
    })
}

fn grant_save_fail_chance() -> R<TurnSpec> {
    let c1 = cnd(
        "c1",
        EVERY,
        &["a"],
        vec![
            EffectSpec::SaveDisadvantage {
                until: SaveUntil::EndOfTurn,
                to: None,
            },
            EffectSpec::SavePenalty {
                count: 1.0,
                sides: 4.0,
                until: SaveUntil::EndOfTurn,
                to: None,
            },
        ],
    );
    let c2 = with_save(
        cnd("c2", EVERY, &["b"], vec![adv(GrantUntil::NextAttack)]),
        fail_chance(|c| {
            if c.auto_fail {
                0.9
            } else if c.roll_type == RollType::Disadvantage {
                0.7
            } else if !c.penalty_dice.is_empty() {
                0.55
            } else {
                0.4
            }
        }),
    );
    Ok(with_conditions(three()?, vec![c1, c2]))
}

fn grant_save_autofail() -> R<TurnSpec> {
    let c1 = cnd(
        "c1",
        EVERY,
        &["a"],
        vec![rule_eff(
            "paralyzed",
            saves(&[("dex", SaveRuleModifier::AutoFail)]),
            EOT,
        )],
    );
    let c2 = with_save(
        cnd("c2", EVERY, &["b"], vec![adv(GrantUntil::NextAttack)]),
        GrantSaves::One(dc(Some("dex"), 12.0, 1.0, None)),
    );
    Ok(with_conditions(three()?, vec![c1, c2]))
}

fn grant_save_autofail_fail_chance() -> R<TurnSpec> {
    let c1 = cnd(
        "c1",
        EVERY,
        &["a"],
        vec![rule_eff(
            "paralyzed",
            saves(&[("dex", SaveRuleModifier::AutoFail)]),
            EOT,
        )],
    );
    let c2 = with_save(
        cnd("c2", EVERY, &["b"], vec![adv(GrantUntil::NextAttack)]),
        GrantSaves::One(GrantSaveSpec::FailChance {
            ability: Some("dex".to_string()),
            fail_chance: FailChance::new(|c| Ok(if c.auto_fail { 0.9 } else { 0.3 })),
        }),
    );
    Ok(with_conditions(three()?, vec![c1, c2]))
}

fn grant_save_bad_chance() -> R<TurnSpec> {
    let c2 = with_save(
        cnd("c2", EVERY, &["a"], vec![adv(GrantUntil::NextAttack)]),
        fail_chance(|_| 1.5),
    );
    Ok(with_conditions(three()?, vec![c2]))
}

fn optional_melee_leaning() -> R<TurnSpec> {
    let mut c = cnd(
        "cnd",
        EVERY,
        &["a"],
        vec![rule_eff(
            "prone",
            by_range(M::Advantage, M::Disadvantage),
            EOT,
        )],
    );
    c.optional = true;
    Ok(with_conditions(
        vec![
            plain("a", sword()?),
            plain("b", axe()?.ranged()?),
            plain("c", axe()?.melee()?),
        ],
        vec![c],
    ))
}

fn optional_plain() -> R<TurnSpec> {
    let mut c = cnd("cnd", EVERY, &["a"], vec![adv(GrantUntil::NextAttack)]);
    c.optional = true;
    Ok(with_conditions(three()?, vec![c]))
}

fn state_limit() -> R<TurnSpec> {
    let mut t = with_conditions(
        three()?,
        vec![cnd("cnd", EVERY, &["a"], vec![adv(GrantUntil::NextAttack)])],
    );
    t.state_limit = Some(5000.0);
    Ok(t)
}

fn slot_chain() -> R<TurnSpec> {
    let mut attacks = vec![plain("a1", sword()?)];
    for i in 2..=6 {
        let prev = format!("a{}", i - 1);
        attacks.push(named(
            &format!("a{i}"),
            sword()?,
            super::catalog::gated(&prev, AfterLanding::Hit),
        ));
    }
    let mut t = with_conditions(
        attacks,
        vec![cnd(
            "cnd",
            FIRST_HIT,
            &["a2", "a3"],
            vec![adv(GrantUntil::NextAttack)],
        )],
    );
    t.observe = Some(vec![ProbeSpec {
        id: Some("last".to_string()),
        on: ProbeOn::AnyCrit,
        of: ids(&["a6"]),
    }]);
    Ok(t)
}

fn group_landing() -> R<TurnSpec> {
    let mut r1 = rider("r1", first_hit(ids(&["fb"])), d6());
    r1.landing = Some(crate::turn::types::RiderLanding::Save(SaveLanding::Fail));
    let mut r2 = rider("r2", first_hit(ids(&["fb"])), d6());
    r2.landing = Some(crate::turn::types::RiderLanding::Save(SaveLanding::Damage));
    let mut c = cnd("cnd", FIRST_HIT, &["fb"], vec![adv(GrantUntil::EndOfTurn)]);
    c.landing = Some(SaveLanding::Fail);
    let mut t = with_riders(
        vec![plain("fb", fireball()?), plain("a", sword()?)],
        vec![r1, r2],
    );
    t.conditions = Some(vec![c]);
    Ok(t)
}

fn probe_shared_group() -> R<TurnSpec> {
    let mut t = with_riders(
        two()?,
        vec![
            rider("sneak", first_hit(None), d6()),
            rider("eh", every_hit(None, None), d4()),
        ],
    );
    t.observe = Some(vec![ProbeSpec {
        id: Some("p".to_string()),
        on: ProbeOn::AnyCrit,
        of: None,
    }]);
    Ok(t)
}

fn coin_flags() -> R<TurnSpec> {
    let mut eh = rider("eh", every_hit(None, None), d6());
    eh.happens = Some(0.5);
    let mut capped = rider("cap", every_hit(None, Some(2.0)), d4());
    capped.happens = Some(0.25);
    let mut t = with_riders(three()?, vec![eh, capped]);
    t.conditions = Some(vec![cnd(
        "cnd",
        EVERY,
        &["a"],
        vec![adv(GrantUntil::NextAttack)],
    )]);
    Ok(t)
}

fn bit_share() -> R<TurnSpec> {
    let attacks = (1..=6)
        .map(|i| Ok(plain(&format!("a{i}"), sword()?)))
        .collect::<R<Vec<_>>>()?;
    let conditions = (1..=5)
        .map(|i| {
            cnd(
                &format!("c{i}"),
                EVERY,
                &[&format!("a{i}")],
                vec![adv_to(GrantUntil::NextAttack, &[&format!("a{}", i + 1)])],
            )
        })
        .collect();
    Ok(with_conditions(attacks, conditions))
}

fn too_many_states() -> R<TurnSpec> {
    let conditions = (0..31)
        .map(|i| {
            cnd(
                &format!("c{i}"),
                EVERY,
                &["a"],
                vec![adv(GrantUntil::NextAttack)],
            )
        })
        .collect();
    Ok(with_conditions(two()?, conditions))
}

fn target_has() -> R<TurnSpec> {
    let mut gate = cnd("gate", EVERY, &["b"], vec![adv(GrantUntil::NextAttack)]);
    gate.target_has = Some(vec!["prone".to_string()]);
    let mut gated: Rider = rider("sneak", first_hit(ids(&["c"])), d6());
    gated.target_has = Some(vec!["prone".to_string()]);
    let mut t = with_riders(
        vec![
            named("a", sword()?, |o| o.target = Some("x".into())),
            named("b", axe()?, |o| o.target = Some("x".into())),
            named("c", sword()?, |o| o.target = Some("x".into())),
        ],
        vec![gated],
    );
    t.conditions = Some(vec![
        cnd(
            "mark",
            EVERY,
            &["a"],
            vec![rule_eff("prone", both(M::Advantage), EOT)],
        ),
        gate,
    ]);
    Ok(t)
}

fn err_unknown_range() -> R<TurnSpec> {
    Ok(with_conditions(
        two()?,
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff(
                "prone",
                by_range(M::Advantage, M::Disadvantage),
                EOT,
            )],
        )],
    ))
}

fn err_save_without_ability() -> R<TurnSpec> {
    Ok(with_conditions(
        vec![plain("a", sword()?), plain("fb", fireball()?)],
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff(
                "stunned",
                saves(&[("dex", SaveRuleModifier::AutoFail)]),
                EOT,
            )],
        )],
    ))
}

fn err_unknown_ability() -> R<TurnSpec> {
    Ok(with_conditions(
        two()?,
        vec![cnd(
            "cnd",
            EVERY,
            &["a"],
            vec![rule_eff(
                "stunned",
                saves(&[("luck", SaveRuleModifier::AutoFail)]),
                EOT,
            )],
        )],
    ))
}

fn err_elven_save() -> R<TurnSpec> {
    let c = with_save(
        cnd("cnd", EVERY, &["a"], vec![adv(GrantUntil::EndOfTurn)]),
        GrantSaves::One(dc(None, 12.0, 1.0, Some(RollType::ElvenAccuracy))),
    );
    Ok(with_conditions(two()?, vec![c]))
}

fn err_too_many_groups_probe() -> R<TurnSpec> {
    let mut attacks = Vec::new();
    let mut riders = Vec::new();
    for i in 0..10 {
        let id = format!("a{i}");
        attacks.push(plain(&id, sword()?));
        if i < 9 {
            riders.push(rider(&format!("r{i}"), first_hit(ids(&[&id])), d6()));
        }
    }
    let mut t = with_riders(attacks, riders);
    t.observe = Some(vec![ProbeSpec {
        id: Some("p".to_string()),
        on: ProbeOn::AnyCrit,
        of: ids(&["a9"]),
    }]);
    Ok(t)
}

fn err_state_limit_zero() -> R<TurnSpec> {
    let mut t = spec(two()?);
    t.state_limit = Some(0.0);
    Ok(t)
}

fn catalog() -> Vec<Entry> {
    let e = |name, spec: R<TurnSpec>| Entry {
        name,
        spec,
        folds: FoldMode::Joint,
        declined: &[],
    };
    let masses = |name, spec: R<TurnSpec>| Entry {
        name,
        spec,
        folds: FoldMode::Masses,
        declined: &[],
    };
    vec![
        e("c_wounds", wounds()),
        e("c_on_end", on_end()),
        e("c_range_rule", range_rule()),
        e("c_save_ability_rule", save_ability_rule()),
        e("c_d20_penalty", d20_penalty()),
        e("c_save_disadvantage_to", save_disadvantage_to()),
        e("c_save_penalty_tag", save_penalty_tag()),
        e("c_grant_to_ids", grant_to_ids()),
        e("c_multi_creature", multi_creature()),
        e("c_start_target", start_target()),
        e("c_start_no_id", start_no_id()),
        e("c_once_reader", once_reader()),
        e("c_once_no_reader", once_no_reader()),
        e("c_once_tried", once_tried()),
        e("c_once_first_miss", once_first_miss()),
        e("c_cond_on_rider", cond_on_rider()),
        e("c_lasting_on_save", lasting_on_save()),
        e("c_grant_save_options", grant_save_options()),
        e("c_grant_save_fail_chance", grant_save_fail_chance()),
        e("c_grant_save_autofail", grant_save_autofail()),
        e(
            "c_grant_save_autofail_fail_chance",
            grant_save_autofail_fail_chance(),
        ),
        e("c_grant_save_bad_chance", grant_save_bad_chance()),
        e("c_optional_melee_leaning", optional_melee_leaning()),
        e("c_optional_plain", optional_plain()),
        Entry {
            declined: &["cnd"],
            ..e("c_optional_declined", optional_plain())
        },
        e("c_state_limit", state_limit()),
        e("c_slot_chain", slot_chain()),
        e("c_group_landing", group_landing()),
        e("c_probe_shared_group", probe_shared_group()),
        e("c_coin_flags", coin_flags()),
        e("c_bit_share", bit_share()),
        e("c_too_many_states", too_many_states()),
        e("c_target_has", target_has()),
        e("c_err_unknown_range", err_unknown_range()),
        e("c_err_save_without_ability", err_save_without_ability()),
        e("c_err_unknown_ability", err_unknown_ability()),
        e("c_err_elven_save", err_elven_save()),
        e("c_err_too_many_groups_probe", err_too_many_groups_probe()),
        e("c_err_state_limit_zero", err_state_limit_zero()),
        masses("c_masses_wounds", wounds()),
        masses("c_masses_grant_save_options", grant_save_options()),
        masses("c_masses_multi_creature", multi_creature()),
        masses("c_masses_once_tried", once_tried()),
    ]
}

#[test]
fn golden_plans_c() {
    let golden: Value = match serde_json::from_str(include_str!("plans_c.json")) {
        Ok(value) => value,
        Err(e) => panic!("plans_c.json is not JSON: {e}"),
    };
    let mut failures: Vec<String> = Vec::new();
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for entry in catalog() {
        names.insert(entry.name);
        let Some(expected) = golden.get(entry.name) else {
            failures.push(format!(
                "{}: not in plans_c.json (regenerate it)",
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
                    "{key}: in plans_c.json but not in the Rust catalog"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "plan golden c mismatches:\n{}",
        failures.join("\n")
    );
}
