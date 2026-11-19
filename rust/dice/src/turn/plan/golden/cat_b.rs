//! Golden catalog b: mirrors the `catalog` of `dump_b.gen.ts.txt` entry for entry (same names, same
//! order). Covers the `resolve.rs` stretch of `buildPlan`: rider lowering and placement, partners,
//! joins, landings, `after` gates, `dealing`, `targetHas`, condition sources, probes, substitute
//! conflicts, attack lists, rerolls and attached conditions, with the error specs of those branches.
//! Regenerate `plans_b.json` with the command at the top of the `.txt`.

use super::catalog::*;
use super::{compare, dump};
use crate::EPS;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::attack::{ConditionGate, Grants};
use crate::builder::factory::*;
use crate::builder::roll::Arg;
use crate::builder::roll::RollBuilder;
use crate::dnd5e::{ConditionName, rule};
use crate::error::DiceError;
use crate::turn::context::{ContextualSource, RowCheck, RowContext};
use crate::turn::effects::advantage;
use crate::turn::plan::{FoldMode, build_plan};
use crate::turn::types::GrantUntil;
use crate::turn::types::{
    AfterLanding, ArcContextual, Attack, AttackTriggerOn, ConditionOn, ConditionSpec,
    ConditionUntil, ContextualPayload, DamageSource, Dealt, EffectSpec, LandingPayload, ProbeOn,
    ProbeSpec, Rider, RiderDamage, RiderDamageSpec, RiderLanding, RiderPayload, SaveLanding,
    Source, SubstituteKind, SubstituteOn, SubstitutePolicy, Trigger, TurnSpec, VulnerableLanding,
};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

type Entry = (&'static str, R<TurnSpec>, FoldMode, Vec<String>);

fn e(name: &'static str, build: impl FnOnce() -> R<TurnSpec>) -> Entry {
    (name, build(), FoldMode::Joint, Vec::new())
}

fn e_with(
    name: &'static str,
    folds: FoldMode,
    declined: &[&str],
    build: impl FnOnce() -> R<TurnSpec>,
) -> Entry {
    (
        name,
        build(),
        folds,
        declined
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
    )
}

fn src(builder: RollBuilder) -> Source {
    Source::from(DamageSource::from(builder))
}

fn eh() -> ConditionOn {
    ConditionOn::Attack(AttackTriggerOn::EveryHit)
}

fn adv(until: GrantUntil) -> EffectSpec {
    grant(true, false, until)
}

fn fear() -> R<crate::builder::save::SaveBuilder> {
    d20()
        .plus(2.0)?
        .dc(15.0)?
        .ability("wis")?
        .on_save_failure_args(&[Arg::Num(0.0)])
}

fn condition_effect(name: ConditionName, until: ConditionUntil) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.as_str().to_string(),
        rule: rule(name).unwrap_or_default(),
        until,
    }
}

fn fear_cond() -> ConditionSpec {
    let mut c = condition(
        "fc",
        eh(),
        &["fear"],
        vec![condition_effect(
            ConditionName::Frightened,
            ConditionUntil::EndOfTurn,
        )],
    );
    c.landing = Some(SaveLanding::Fail);
    c
}

fn fear_attacks() -> R<Vec<Attack>> {
    Ok(vec![
        plain("fear", fear()?),
        plain("a", sword()?),
        plain("b", axe()?),
    ])
}

fn melee_sword() -> R<AttackBuilder> {
    d20().plus(8.0)?.ac(16.0)?.melee()?.on_hit(d8().plus(4.0)?)
}

fn melee_two() -> R<Vec<Attack>> {
    Ok(vec![
        plain("a", melee_sword()?),
        plain("b", axe()?.melee()?),
    ])
}

/// A source that pools joined riders' dice: one d6 per rider in `context.joined`.
struct Pooling;

impl ContextualSource for Pooling {
    fn row_check(&self) -> RowCheck {
        melee_sword()
            .map(|s| s.row_check())
            .unwrap_or_else(|_| fallback_row())
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        if context.joined.is_empty() {
            melee_sword()?.under(context, eps)
        } else {
            let damage = d8()
                .plus(4.0)?
                .add(&rs(context.joined.len() as f64, 6.0)?)?;
            d20()
                .plus(8.0)?
                .ac(16.0)?
                .melee()?
                .on_hit(damage)?
                .under(context, eps)
        }
    }
}

/// A source that says what its own reroll rolls.
struct Rerolling;

impl ContextualSource for Rerolling {
    fn row_check(&self) -> RowCheck {
        melee_sword()
            .map(|s| s.row_check())
            .unwrap_or_else(|_| fallback_row())
    }
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        melee_sword()?.under(context, eps)
    }
    fn has_rerolled_under(&self) -> bool {
        true
    }
    fn rerolled_under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        melee_sword()?.under(context, eps)
    }
}

/// Never reached: `melee_sword` is a fixed valid builder.
fn fallback_row() -> RowCheck {
    RowCheck {
        kind: crate::turn::context::RowKind::Attack,
        range: None,
        ability: None,
        roll_type: crate::common::RollType::Flat,
        advantage_dice: 2,
        pinned: false,
        auto_hit: false,
        auto_crit: false,
        auto_fail: false,
    }
}

fn pooling() -> Source {
    Source::Contextual(ArcContextual(Arc::new(Pooling)))
}

fn rerolling() -> Source {
    Source::Contextual(ArcContextual(Arc::new(Rerolling)))
}

/// `ctxPayload(withDealt)`.
struct Ctx {
    dealt: bool,
}

impl ContextualPayload for Ctx {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        Ok(LandingPayload {
            on_hit: (rs(1.0, 6.0)?.to_pmf(EPS)?).into(),
            on_crit: (rs(2.0, 6.0)?.to_pmf(EPS)?).into(),
            vulnerable: VulnerableLanding {
                on_hit: (rs(2.0, 6.0)?.to_pmf(EPS)?).into(),
                on_crit: (rs(4.0, 6.0)?.to_pmf(EPS)?).into(),
            },
        })
    }
    fn has_dealt(&self) -> bool {
        self.dealt
    }
    fn dealt(&self, _type_: &str, _attack_id: &str) -> Result<Dealt, DiceError> {
        Ok(Dealt {
            hit: 0.5,
            crit: 0.75,
        })
    }
}

fn ctx_rider(trigger: Trigger, dealt: bool) -> Rider {
    let mut r = rider("cx", trigger, d6());
    r.damage = RiderDamageSpec::Contextual(Arc::new(Ctx { dealt }));
    r
}

fn per_source(of: &[&str], table: &[&str]) -> Trigger {
    let map: IndexMap<String, RiderPayload> = table
        .iter()
        .map(|id| {
            (
                id.to_string(),
                RiderPayload {
                    damage: RiderDamage::One(d8().into()),
                    crit_damage: None,
                },
            )
        })
        .collect();
    Trigger::FirstHit {
        of: ids(of),
        per_source: Some(map),
    }
}

fn smite() -> Rider {
    rider("smite", per_source(&["a", "b"], &["a", "b"]), d6())
}

fn tgt(mut r: Rider, names: &[&str]) -> Rider {
    r.target_has = ids(names);
    r
}

fn th_rider(trigger: Trigger, names: &[&str]) -> R<Rider> {
    Ok(tgt(rider("rider", trigger, flat(4.0)?), names))
}

fn dealing_cond(id: &str, on: ConditionOn, of: &[&str], dealing: &str) -> ConditionSpec {
    let mut c = condition(id, on, of, vec![adv(GrantUntil::NextAttack)]);
    c.dealing = Some(dealing.to_string());
    c
}

fn next_attack_cond(id: &str, of: &[&str]) -> ConditionSpec {
    condition(id, eh(), of, vec![adv(GrantUntil::NextAttack)])
}

fn with_everything(
    attacks: Vec<Attack>,
    riders: Vec<Rider>,
    conditions: Vec<ConditionSpec>,
) -> TurnSpec {
    TurnSpec {
        riders: if riders.is_empty() {
            None
        } else {
            Some(riders)
        },
        conditions: if conditions.is_empty() {
            None
        } else {
            Some(conditions)
        },
        ..spec(attacks)
    }
}

fn with_probe(attacks: Vec<Attack>, riders: Vec<Rider>, of: Option<&[&str]>) -> TurnSpec {
    TurnSpec {
        observe: Some(vec![ProbeSpec {
            id: Some("p".to_string()),
            on: ProbeOn::AnyCrit,
            of: of.and_then(ids),
        }]),
        riders: if riders.is_empty() {
            None
        } else {
            Some(riders)
        },
        ..spec(attacks)
    }
}

fn sub(
    id: &str,
    on: SubstituteOn,
    kind: SubstituteKind,
    of: Option<&[&str]>,
) -> crate::turn::types::SubstituteSpec {
    let mut s = substitute(id, on, kind);
    s.of = of.and_then(ids);
    s
}

const KH: SubstituteKind = SubstituteKind::RerollKeepHigher;

fn below() -> SubstitutePolicy {
    SubstitutePolicy::Below {
        hit: 6.0,
        crit: 8.0,
    }
}

fn two_gated(attacks: Vec<Attack>, riders: Vec<Rider>) -> TurnSpec {
    with_riders(attacks, riders)
}

fn gate_chance(chance: f64) -> ConditionGate {
    ConditionGate {
        chance: Some(chance),
        ..ConditionGate::default()
    }
}

fn one(grant: crate::turn::effects::Grant) -> Grants {
    Grants::One(grant.into())
}

fn miss_of(of: &[&str]) -> Trigger {
    Trigger::AnyMiss { of: ids(of) }
}

fn catalog_b() -> Vec<Entry> {
    use AfterLanding::{Any as AfterAny, Hit as AfterHit};
    let d6s: fn() -> RollBuilder = d6;
    let _ = two_gated;
    vec![
        // --- rider lowering and placement ---
        e("eh_max1_lowered", || {
            Ok(with_riders(
                three()?,
                vec![rider("eh", every_hit(None, Some(1.0)), d6s())],
            ))
        }),
        e("th_first_hit_gated", || {
            Ok(with_everything(
                fear_attacks()?,
                vec![th_rider(first_hit(ids(&["a", "b"])), &["frightened"])?],
                vec![fear_cond()],
            ))
        }),
        e_with("th_first_hit_gated_masses", FoldMode::Masses, &[], || {
            Ok(with_everything(
                fear_attacks()?,
                vec![th_rider(first_hit(ids(&["a", "b"])), &["frightened"])?],
                vec![fear_cond()],
            ))
        }),
        e("th_every_hit_any_of", || {
            Ok(with_everything(
                fear_attacks()?,
                vec![th_rider(
                    every_hit(ids(&["a", "b"]), None),
                    &["frightened", "prone"],
                )?],
                vec![fear_cond()],
            ))
        }),
        e("th_condition_gate", || {
            let mut g = condition("g", eh(), &["a"], vec![adv(GrantUntil::EndOfTurn)]);
            g.target_has = ids(&["frightened"]);
            Ok(with_everything(
                fear_attacks()?,
                vec![],
                vec![fear_cond(), g],
            ))
        }),
        e("err_th_any_crit", || {
            let trigger = Trigger::AnyCrit {
                of: ids(&["a", "b"]),
                max: None,
            };
            Ok(with_everything(
                fear_attacks()?,
                vec![th_rider(trigger, &["frightened"])?],
                vec![fear_cond()],
            ))
        }),
        e("err_th_empty", || {
            Ok(with_everything(
                fear_attacks()?,
                vec![th_rider(every_hit(ids(&["a", "b"]), None), &[])?],
                vec![fear_cond()],
            ))
        }),
        e("err_th_watches_rider", || {
            Ok(with_everything(
                fear_attacks()?,
                vec![
                    rider("r0", first_hit(ids(&["a"])), d6s()),
                    th_rider(every_hit(ids(&["r0"]), None), &["frightened"])?,
                ],
                vec![fear_cond()],
            ))
        }),
        e("err_th_named", || {
            Ok(with_everything(
                fear_attacks()?,
                vec![th_rider(
                    every_hit(ids(&["a", "b"]), None),
                    &["frightened"],
                )?],
                vec![fear_cond(), next_attack_cond("c2", &["rider"])],
            ))
        }),
        e("err_th_condition_first_hit", || {
            let mut g = condition(
                "g",
                ConditionOn::Attack(AttackTriggerOn::FirstHit),
                &["a"],
                vec![adv(GrantUntil::EndOfTurn)],
            );
            g.target_has = ids(&["frightened"]);
            Ok(with_everything(
                fear_attacks()?,
                vec![],
                vec![fear_cond(), g],
            ))
        }),
        // --- contextual payloads ---
        e("ctx_any_crit", || {
            Ok(with_riders(two()?, vec![ctx_rider(any_crit(None), false)]))
        }),
        e("ctx_first_hit", || {
            Ok(with_riders(two()?, vec![ctx_rider(first_hit(None), false)]))
        }),
        e("ctx_every_hit", || {
            Ok(with_riders(
                two()?,
                vec![ctx_rider(every_hit(None, None), false)],
            ))
        }),
        e("err_ctx_any_miss", || {
            Ok(with_riders(
                two()?,
                vec![ctx_rider(Trigger::AnyMiss { of: None }, false)],
            ))
        }),
        e("ctx_dealt_condition", || {
            Ok(with_everything(
                vec![
                    plain("a", sword()?.typed("fire")?),
                    plain("b", axe()?.typed("fire")?),
                ],
                vec![ctx_rider(every_hit(None, None), true)],
                vec![dealing_cond("cnd", eh(), &["a", "b"], "fire")],
            ))
        }),
        // --- wakes, folds, conditions naming riders ---
        e("wakes_folds_first_hit", || {
            Ok(with_everything(
                melee_two()?,
                vec![rider("sneak", first_hit(None), d6s())],
                vec![condition(
                    "w",
                    eh(),
                    &["a"],
                    vec![condition_effect(
                        ConditionName::Unconscious,
                        ConditionUntil::UntilDamaged,
                    )],
                )],
            ))
        }),
        e("first_hit_landing_any", || {
            let mut r = rider("sneak", first_hit(None), d6s());
            r.landing = Some(RiderLanding::Any);
            Ok(with_riders(two()?, vec![r]))
        }),
        e("condition_names_rider", || {
            Ok(with_everything(
                two()?,
                vec![rider("sneak", first_hit(ids(&["a", "b"])), d6s())],
                vec![next_attack_cond("cnd", &["sneak"])],
            ))
        }),
        e("condition_names_rider_where", || {
            let mut c = next_attack_cond("cnd", &["sneak"]);
            c.r#where = Some(IndexMap::from([(
                "sneak".to_string(),
                vec!["a".to_string()],
            )]));
            Ok(with_everything(
                two()?,
                vec![rider("sneak", first_hit(ids(&["a", "b"])), d6s())],
                vec![c],
            ))
        }),
        e("err_condition_rider_beside_others", || {
            Ok(with_everything(
                two()?,
                vec![rider("sneak", first_hit(ids(&["a", "b"])), d6s())],
                vec![next_attack_cond("cnd", &["sneak", "a"])],
            ))
        }),
        e("err_condition_where_unknown", || {
            let mut c = next_attack_cond("cnd", &["sneak"]);
            c.r#where = Some(IndexMap::from([(
                "sneak".to_string(),
                vec!["nowhere".to_string()],
            )]));
            Ok(with_everything(
                two()?,
                vec![rider("sneak", first_hit(ids(&["a", "b"])), d6s())],
                vec![c],
            ))
        }),
        e("err_condition_where_not_rider", || {
            let mut c = next_attack_cond("cnd", &["a"]);
            c.r#where = Some(IndexMap::from([("b".to_string(), Vec::new())]));
            Ok(with_everything(two()?, vec![], vec![c]))
        }),
        // --- partners ---
        e("partner_spellfire", || {
            let mut adept = rider("adept", first_hit(ids(&["smite"])), d4());
            adept.r#where = Some(IndexMap::from([(
                "smite".to_string(),
                vec!["a".to_string()],
            )]));
            Ok(with_riders(two()?, vec![smite(), adept]))
        }),
        e("partner_default_rows", || {
            Ok(with_riders(
                two()?,
                vec![smite(), rider("adept", first_hit(ids(&["smite"])), d4())],
            ))
        }),
        e("partner_plus_own_row", || {
            let first = rider("smite", per_source(&["a"], &["a"]), d6s());
            Ok(with_riders(
                two()?,
                vec![first, rider("adept", first_hit(ids(&["smite", "b"])), d4())],
            ))
        }),
        e("err_partner_where_key", || {
            let mut adept = rider("adept", first_hit(ids(&["a"])), d4());
            adept.r#where = Some(IndexMap::from([(
                "smite".to_string(),
                vec!["a".to_string()],
            )]));
            Ok(with_riders(two()?, vec![adept]))
        }),
        e("err_partner_every_hit", || {
            Ok(with_riders(
                two()?,
                vec![
                    smite(),
                    rider("adept", every_hit(ids(&["smite"]), None), d4()),
                ],
            ))
        }),
        e("err_partner_chain", || {
            Ok(with_riders(
                two()?,
                vec![
                    smite(),
                    rider("adept", first_hit(ids(&["smite"])), d4()),
                    rider("third", first_hit(ids(&["adept"])), d4()),
                ],
            ))
        }),
        e("err_partner_rolls_attack", || {
            Ok(with_riders(
                two()?,
                vec![smite(), rider("adept", first_hit(ids(&["smite"])), axe()?)],
            ))
        }),
        // --- joins ---
        e("joins_pooling", || {
            let mut r = rider("a", first_hit(ids(&["attack 1"])), d6s());
            r.joins = ids(&["attack 1"]);
            Ok(with_riders(
                vec![Attack::Bare(pooling()), Attack::Bare(pooling())],
                vec![r],
            ))
        }),
        e("err_joins_not_pooling", || {
            let mut r = rider("a", first_hit(ids(&["attack 1", "attack 2"])), d6s());
            r.joins = ids(&["attack 1"]);
            Ok(with_riders(
                vec![
                    Attack::Bare(melee_sword()?.into()),
                    Attack::Bare(melee_sword()?.into()),
                ],
                vec![r],
            ))
        }),
        e("err_joins_unwatched", || {
            let mut r = rider("a", first_hit(ids(&["attack 1"])), d6s());
            r.joins = ids(&["attack 2"]);
            Ok(with_riders(
                vec![Attack::Bare(pooling()), Attack::Bare(pooling())],
                vec![r],
            ))
        }),
        e("err_joins_landing_any", || {
            let mut r = rider("a", first_hit(ids(&["attack 1"])), d6s());
            r.landing = Some(RiderLanding::Any);
            r.joins = ids(&["attack 1"]);
            Ok(with_riders(
                vec![Attack::Bare(pooling()), Attack::Bare(pooling())],
                vec![r],
            ))
        }),
        // --- landings and save rows ---
        e("save_two_landings", || {
            let mut r1 = rider("r1", first_hit(ids(&["fb"])), d6s());
            r1.landing = Some(RiderLanding::Save(SaveLanding::Fail));
            let mut r2 = rider(
                "r2",
                Trigger::AnyCrit {
                    of: ids(&["fb", "a"]),
                    max: None,
                },
                d4(),
            );
            r2.landing = Some(RiderLanding::Save(SaveLanding::Damage));
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![r1, r2],
            ))
        }),
        e("err_save_no_landing", || {
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![rider("r1", first_hit(ids(&["fb"])), d6s())],
            ))
        }),
        e("err_landing_not_fired", || {
            let mut nf = rider(
                "nf",
                Trigger::NotFired {
                    of: "sneak".to_string(),
                },
                d4(),
            );
            nf.landing = Some(RiderLanding::Save(SaveLanding::Fail));
            Ok(with_riders(
                vec![plain("a", sword()?)],
                vec![rider("sneak", first_hit(None), d6s()), nf],
            ))
        }),
        e("after_save_row_damage", || {
            Ok(spec(vec![
                plain("fb", fireball()?),
                named("a", sword()?, gated("fb", AfterLanding::Damage)),
            ]))
        }),
        e("after_rider_any", || {
            Ok(with_riders(
                vec![
                    plain("a", sword()?),
                    named("w", src(d6s()), gated("sneak", AfterAny)),
                ],
                vec![rider("sneak", first_hit(ids(&["a"])), d6s())],
            ))
        }),
        e("err_after_rolls_attack", || {
            Ok(with_riders(
                vec![
                    plain("a", sword()?),
                    named("w", src(d6s()), gated("sneak", AfterHit)),
                ],
                vec![rider("sneak", first_hit(ids(&["a"])), axe()?)],
            ))
        }),
        e("err_after_happens", || {
            let mut sneak = rider("sneak", first_hit(ids(&["a"])), d6s());
            sneak.happens = Some(0.5);
            Ok(with_riders(
                vec![
                    plain("a", sword()?),
                    named("w", src(d6s()), gated("sneak", AfterHit)),
                ],
                vec![sneak],
            ))
        }),
        e("err_after_not_fired", || {
            Ok(with_riders(
                vec![
                    plain("a", sword()?),
                    named("w", src(d6s()), gated("nf", AfterHit)),
                ],
                vec![
                    rider("sneak", first_hit(ids(&["a"])), d6s()),
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
        e("err_after_later_row", || {
            Ok(with_riders(
                vec![
                    plain("a", sword()?),
                    named("w", src(d6s()), gated("sneak", AfterHit)),
                    plain("b", axe()?),
                ],
                vec![rider("sneak", first_hit(ids(&["a", "b"])), d6s())],
            ))
        }),
        // --- dealing ---
        e("dealing_typed", || {
            Ok(with_conditions(
                vec![
                    plain("a", sword()?.typed("fire")?),
                    plain("b", axe()?.typed("fire")?),
                ],
                vec![dealing_cond("cnd", eh(), &["a", "b"], "fire")],
            ))
        }),
        e("err_dealing_untyped", || {
            Ok(with_conditions(
                two()?,
                vec![dealing_cond("cnd", eh(), &["a", "b"], "fire")],
            ))
        }),
        e("err_dealing_two_types", || {
            Ok(with_conditions(
                vec![
                    plain("a", sword()?.typed("fire")?),
                    plain("b", axe()?.typed("cold")?),
                ],
                vec![
                    dealing_cond("c1", eh(), &["a"], "fire"),
                    dealing_cond("c2", eh(), &["b"], "cold"),
                ],
            ))
        }),
        e("err_dealing_any_miss", || {
            Ok(with_conditions(
                vec![plain("a", sword()?.typed("fire")?)],
                vec![dealing_cond(
                    "cnd",
                    ConditionOn::Attack(AttackTriggerOn::AnyMiss),
                    &["a"],
                    "fire",
                )],
            ))
        }),
        e("rider_landing_damage_attack_row", || {
            let mut r = rider("r", first_hit(ids(&["a"])), d6s());
            r.landing = Some(RiderLanding::Save(SaveLanding::Damage));
            Ok(with_riders(two()?, vec![r]))
        }),
        // --- conditions: sources, declined, start ---
        e_with("declined_optional", FoldMode::Joint, &["opt"], || {
            let mut c = next_attack_cond("opt", &["a"]);
            c.optional = true;
            Ok(with_conditions(three()?, vec![c]))
        }),
        e("condition_of_empty", || {
            Ok(with_conditions(two()?, vec![next_attack_cond("cnd", &[])]))
        }),
        e("start_prone_effect_sources", || {
            let mut start = condition(
                "x",
                ConditionOn::Start,
                &[],
                vec![condition_effect(
                    ConditionName::Prone,
                    ConditionUntil::EndOfTurn,
                )],
            );
            start.id = None;
            start.of = None;
            Ok(with_conditions(
                melee_two()?,
                vec![start, next_attack_cond("cnd", &["a"])],
            ))
        }),
        e("start_target_other", || {
            let mut st = condition(
                "st",
                ConditionOn::Start,
                &[],
                vec![adv(GrantUntil::EndOfTurn)],
            );
            st.of = None;
            st.target = Some("second".to_string());
            Ok(with_conditions(
                vec![
                    plain("a", sword()?),
                    named("b", axe()?, |o| o.target = Some("second".to_string())),
                ],
                vec![st],
            ))
        }),
        e("err_start_unknown_target", || {
            let mut st = condition(
                "st",
                ConditionOn::Start,
                &[],
                vec![adv(GrantUntil::EndOfTurn)],
            );
            st.of = None;
            st.target = Some("nobody".to_string());
            Ok(with_conditions(two()?, vec![st]))
        }),
        e("err_start_with_chance", || {
            let mut st = condition(
                "st",
                ConditionOn::Start,
                &[],
                vec![adv(GrantUntil::EndOfTurn)],
            );
            st.of = None;
            st.chance = Some(0.5);
            Ok(with_conditions(two()?, vec![st]))
        }),
        e("err_condition_chance_range", || {
            let mut c = next_attack_cond("cnd", &["a"]);
            c.chance = Some(1.5);
            Ok(with_conditions(two()?, vec![c]))
        }),
        e("err_condition_target_on_trigger", || {
            let mut c = condition(
                "cnd",
                ConditionOn::Attack(AttackTriggerOn::FirstHit),
                &["a"],
                vec![adv(GrantUntil::EndOfTurn)],
            );
            c.target = Some("target".to_string());
            Ok(with_conditions(two()?, vec![c]))
        }),
        e("err_condition_onsave_alone", || {
            let mut c = next_attack_cond("cnd", &["a"]);
            c.on_save = Some(vec![adv(GrantUntil::EndOfTurn)]);
            Ok(with_conditions(two()?, vec![c]))
        }),
        // --- probes ---
        e("probe_skips_uncrittable", || {
            Ok(with_probe(
                vec![
                    plain("fb", fireball()?),
                    plain("a", sword()?),
                    named("f", src(flat(5.0)?), |_| {}),
                ],
                vec![],
                None,
            ))
        }),
        e("probe_default_rerolls", || {
            Ok(with_probe(
                vec![plain("a", sword()?)],
                vec![rider("rr", Trigger::FirstMiss { of: None }, axe()?)],
                None,
            ))
        }),
        e("err_probe_no_crit_source", || {
            Ok(with_probe(
                vec![plain("a", sword()?), named("f", src(flat(5.0)?), |_| {})],
                vec![],
                Some(&["f"]),
            ))
        }),
        // --- substitutes ---
        e("sub_beside_miss_reroll", || {
            Ok(with_substitutes(
                two()?,
                vec![
                    sub("kh", SubstituteOn::FirstHit, KH, None),
                    sub("rr", SubstituteOn::FirstMiss, SubstituteKind::Reroll, None),
                ],
            ))
        }),
        e("err_sub_duplicate_transform", || {
            Ok(with_substitutes(
                two()?,
                vec![
                    sub("kh1", SubstituteOn::FirstHit, KH, None),
                    sub("kh2", SubstituteOn::FirstHit, KH, Some(&["a"])),
                ],
            ))
        }),
        e("err_sub_reroll_after_convert", || {
            Ok(with_substitutes(
                two()?,
                vec![
                    sub("conv", SubstituteOn::FirstMiss, SubstituteKind::Hit, None),
                    sub("rr", SubstituteOn::FirstMiss, SubstituteKind::Reroll, None),
                ],
            ))
        }),
        e("err_sub_convert_after_reroll", || {
            Ok(with_substitutes(
                two()?,
                vec![
                    sub("rr", SubstituteOn::FirstMiss, SubstituteKind::Reroll, None),
                    sub("conv", SubstituteOn::FirstMiss, SubstituteKind::Hit, None),
                ],
            ))
        }),
        e("err_sub_below_with_miss_reroll", || {
            let mut kh = sub("kh", SubstituteOn::FirstHit, KH, None);
            kh.policy = Some(below());
            Ok(with_substitutes(
                two()?,
                vec![
                    kh,
                    sub("rr", SubstituteOn::FirstMiss, SubstituteKind::Reroll, None),
                ],
            ))
        }),
        e("err_sub_miss_policy", || {
            let mut conv = sub("conv", SubstituteOn::FirstMiss, SubstituteKind::Hit, None);
            conv.policy = Some(SubstitutePolicy::Always);
            Ok(with_substitutes(two()?, vec![conv]))
        }),
        e("err_sub_optimal", || {
            let mut kh = sub("kh", SubstituteOn::FirstHit, KH, None);
            kh.policy = Some(SubstitutePolicy::Optimal);
            Ok(with_substitutes(two()?, vec![kh]))
        }),
        e("err_sub_miss_of_flat", || {
            Ok(with_substitutes(
                vec![plain("a", sword()?), named("f", src(flat(5.0)?), |_| {})],
                vec![sub(
                    "conv",
                    SubstituteOn::FirstMiss,
                    SubstituteKind::Hit,
                    Some(&["f"]),
                )],
            ))
        }),
        e("err_sub_any_miss_reroll_converted", || {
            Ok(TurnSpec {
                substitutes: Some(vec![sub(
                    "conv",
                    SubstituteOn::FirstMiss,
                    SubstituteKind::Hit,
                    Some(&["rr"]),
                )]),
                ..with_riders(
                    vec![plain("a", sword()?)],
                    vec![rider("rr", miss_of(&["a"]), axe()?)],
                )
            })
        }),
        e("err_sub_converts_rider_reroll", || {
            Ok(TurnSpec {
                substitutes: Some(vec![sub(
                    "conv",
                    SubstituteOn::FirstMiss,
                    SubstituteKind::Hit,
                    Some(&["a"]),
                )]),
                ..with_riders(
                    vec![plain("a", sword()?)],
                    vec![rider("rr", Trigger::FirstMiss { of: ids(&["a"]) }, axe()?)],
                )
            })
        }),
        e("err_sub_watches_condition", || {
            Ok(TurnSpec {
                substitutes: Some(vec![sub("kh", SubstituteOn::FirstHit, KH, Some(&["cnd"]))]),
                ..with_conditions(two()?, vec![next_attack_cond("cnd", &["a"])])
            })
        }),
        e("sub_rerolled_under", || {
            Ok(with_substitutes(
                vec![named("a", rerolling(), |_| {}), plain("b", axe()?)],
                vec![sub("kh", SubstituteOn::FirstHit, KH, None)],
            ))
        }),
        e("err_sub_rerolled_under_below", || {
            let mut kh = sub("kh", SubstituteOn::FirstHit, KH, None);
            kh.policy = Some(below());
            Ok(with_substitutes(
                vec![named("a", rerolling(), |_| {}), plain("b", axe()?)],
                vec![kh],
            ))
        }),
        // --- attack lists, rerolls, tags ---
        e("attack_list_flurry", || {
            let mut fl = rider("fl", first_hit(ids(&["a"])), d6s());
            fl.damage = RiderDamageSpec::Plain(RiderDamage::Many(vec![
                DamageSource::from(sword()?),
                DamageSource::from(sword()?),
            ]));
            Ok(with_riders(vec![plain("a", sword()?)], vec![fl]))
        }),
        e("err_watch_list_rider", || {
            let mut fl = rider("fl", first_hit(ids(&["a"])), d6s());
            fl.damage = RiderDamageSpec::Plain(RiderDamage::Many(vec![
                DamageSource::from(sword()?),
                DamageSource::from(sword()?),
            ]));
            Ok(with_riders(
                vec![plain("a", sword()?)],
                vec![fl, rider("after", first_hit(ids(&["fl"])), d6s())],
            ))
        }),
        e("reroll_tags_default_of", || {
            Ok(with_riders(
                vec![plain("a", sword()?.tagged(&["blade"])?)],
                vec![
                    rider("s0", first_hit(None), d6s()),
                    rider(
                        "rr",
                        Trigger::FirstMiss { of: None },
                        axe()?.tagged(&["blade"])?,
                    ),
                    rider("s2", first_hit(None), d6s()),
                    rider("s3", first_hit(ids(&["blade"])), d4()),
                ],
            ))
        }),
        // --- attached conditions ---
        e("attached_every_hit", || {
            let a = sword()?.on_every_hit_with(one(advantage().until_next_attack()), None)?;
            Ok(spec(vec![plain("a", a), plain("b", axe()?)]))
        }),
        e("attached_any_crit_chance", || {
            let a = sword()?
                .on_any_crit_with(one(advantage().until_end_of_turn()), Some(gate_chance(0.5)))?;
            Ok(spec(vec![plain("a", a), plain("b", axe()?)]))
        }),
        e("attached_first_crit_optional", || {
            let gate = ConditionGate {
                optional: true,
                ..ConditionGate::default()
            };
            let a =
                sword()?.on_first_crit_with(one(advantage().until_end_of_turn()), Some(gate))?;
            Ok(spec(vec![plain("a", a), plain("b", axe()?)]))
        }),
        e("attached_dealing", || {
            let gate = ConditionGate {
                dealing: Some("fire".to_string()),
                ..ConditionGate::default()
            };
            let a = sword()?
                .typed("fire")?
                .on_every_hit_with(one(advantage().until_next_attack()), Some(gate))?;
            Ok(spec(vec![plain("a", a), plain("b", axe()?)]))
        }),
        e("attached_two_attacks", || {
            let a = sword()?.on_every_hit_with(one(advantage().until_next_attack()), None)?;
            let b = axe()?.on_any_crit_with(one(advantage().until_end_of_turn()), None)?;
            Ok(with_conditions(
                vec![plain("a", a), plain("b", b), plain("c", sword()?)],
                vec![condition(
                    "decl",
                    eh(),
                    &["c"],
                    vec![adv(GrantUntil::EndOfTurn)],
                )],
            ))
        }),
    ]
}

#[test]
fn golden_plans_b() {
    let golden: Value = match serde_json::from_str(include_str!("plans_b.json")) {
        Ok(value) => value,
        Err(e) => panic!("plans_b.json is not JSON: {e}"),
    };
    let mut failures: Vec<String> = Vec::new();
    let mut names: HashSet<&str> = HashSet::new();
    for (name, spec, folds, declined) in catalog_b() {
        names.insert(name);
        let Some(expected) = golden.get(name) else {
            failures.push(format!("{name}: not in plans_b.json (regenerate it)"));
            continue;
        };
        let actual = match spec {
            Err(message) => serde_json::json!({ "error": {
                "class": "Error", "code": Value::Null, "id": Value::Null, "message": message.message(),
            } }),
            Ok(spec) => {
                let declined: HashSet<String> = declined.into_iter().collect();
                match build_plan(&spec, EPS, &declined, folds) {
                    Ok(plan) => serde_json::json!({ "plan": dump::dump_plan(&plan) }),
                    Err(error) => dump::error_dump(&error),
                }
            }
        };
        let diffs = compare::compare(&actual, expected, name);
        if !diffs.is_empty() {
            failures.push(format!("{name}: {} mismatches", diffs.len()));
            failures.extend(diffs.into_iter().take(15));
        }
    }
    if let Some(map) = golden.as_object() {
        for key in map.keys() {
            if !names.contains(key.as_str()) {
                failures.push(format!(
                    "{key}: in plans_b.json but not in the Rust catalog"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "plan golden b mismatches:\n{}",
        failures.join("\n")
    );
}
