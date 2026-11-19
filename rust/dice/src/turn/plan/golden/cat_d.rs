//! Golden catalog d: the per-hit fold and the draws (`fold.rs`). Mirrors the `catalog` of
//! `dump_d.gen.ts.txt` entry for entry (same names, same order); `plans_d.json` is its output.
//! Regenerate with the command at the top of the `.txt`, then
//! `cargo test -q --lib turn::plan::golden`.

use super::{compare, dump};
use crate::builder::attack::AttackBuilder;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::save::SaveBuilder;
use crate::builder::types::MissRerollMode;
use crate::error::DiceError;
use crate::pmf::mixture::Mixture;
use crate::turn::context::{ContextualSource, Dealt, RowCheck, RowContext};
use crate::turn::plan::{FoldMode, build_plan};
use crate::turn::types::{
    ArcContextual, Attack, AttackOptions, AttackRule, AttackRuleModifier, AttackTriggerOn,
    ConditionOn, ConditionRule, ConditionSpec, ConditionUntil, ContextualPayload, DamageSource,
    EffectSpec, LandingPayload, Rider, RiderDamage, RiderDamageSpec, RiderLanding, RiderPayload,
    SaveLanding, SaveUntil, Source, SubstituteKind, SubstituteOn, SubstitutePolicy, SubstituteSpec,
    Trigger, TurnSpec, VulnerableLanding,
};
use crate::{EPS, Pmf};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

type R<T> = Result<T, DiceError>;

fn rs(count: f64, sides: f64) -> R<RollBuilder> {
    roll_dice(count, sides, None)
}

fn sword() -> R<AttackBuilder> {
    d20().plus(7.0)?.ac(15.0)?.on_hit(d8().plus(4.0)?)?.melee()
}

fn axe() -> R<AttackBuilder> {
    d20().plus(5.0)?.ac(14.0)?.on_hit(d6().plus(3.0)?)?.melee()
}

fn orb() -> R<AttackBuilder> {
    d20().plus(5.0)?.ac(17.0)?.on_hit(rs(3.0, 8.0)?)
}

fn fireball() -> R<SaveBuilder> {
    d20()
        .plus(5.0)?
        .dc(14.0)?
        .on_save_failure_args(&[Arg::Roll(rs(2.0, 6.0)?)])?
        .save_half()
}

fn named(id: &str, source: impl Into<Source>, extra: impl FnOnce(&mut AttackOptions)) -> Attack {
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

fn plain(id: &str, source: impl Into<Source>) -> Attack {
    named(id, source, |_| {})
}

fn two() -> R<Vec<Attack>> {
    Ok(vec![plain("a", sword()?), plain("b", axe()?)])
}

fn three() -> R<Vec<Attack>> {
    Ok(vec![
        plain("a", sword()?),
        plain("b", axe()?),
        plain("c", sword()?),
    ])
}

fn four() -> R<Vec<Attack>> {
    Ok(vec![
        plain("a", sword()?),
        plain("b", axe()?),
        plain("c", sword()?),
        plain("d", axe()?),
    ])
}

fn rows(of: &[&str]) -> Option<Vec<String>> {
    Some(of.iter().map(std::string::ToString::to_string).collect())
}

fn strings(of: &[&str]) -> Vec<String> {
    of.iter().map(std::string::ToString::to_string).collect()
}

fn rule(melee: Option<AttackRuleModifier>, ranged: Option<AttackRuleModifier>) -> ConditionRule {
    ConditionRule {
        attack: Some(AttackRule {
            melee: melee.map(|m| vec![m]),
            ranged: ranged.map(|m| vec![m]),
        }),
        ..ConditionRule::default()
    }
}

fn prone() -> ConditionRule {
    rule(Some(AttackRuleModifier::Advantage), None)
}

fn grappled() -> ConditionRule {
    rule(None, Some(AttackRuleModifier::Disadvantage))
}

/// A hand-written `ContextualSource` over a builder (the TS `ctx`).
struct Ctx {
    inner: AttackBuilder,
    pooled: Option<(String, AttackBuilder)>,
    rerolled: Option<AttackBuilder>,
    dealt: Option<(f64, f64)>,
}

impl Ctx {
    fn of(inner: AttackBuilder) -> Ctx {
        Ctx {
            inner,
            pooled: None,
            rerolled: None,
            dealt: None,
        }
    }

    fn source(self) -> Source {
        Source::Contextual(ArcContextual(Arc::new(self)))
    }
}

impl ContextualSource for Ctx {
    fn row_check(&self) -> RowCheck {
        ContextualSource::row_check(&self.inner)
    }

    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        let chosen = match &self.pooled {
            Some((id, pooled)) if context.joined.contains(id) => pooled,
            _ => &self.inner,
        };
        ContextualSource::under(chosen, context, eps)
    }

    fn has_rerolled_under(&self) -> bool {
        self.rerolled.is_some()
    }

    fn rerolled_under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
        match &self.rerolled {
            Some(rerolled) => ContextualSource::under(rerolled, context, eps),
            None => Err(DiceError::error("no rerolledUnder")),
        }
    }

    fn has_dealt(&self) -> bool {
        self.dealt.is_some()
    }

    fn dealt(&self, type_: &str, _context: &RowContext) -> Result<Dealt, DiceError> {
        let (hit, crit) = self.dealt.unwrap_or((0.0, 0.0));
        Ok(if type_ == "fire" {
            Dealt { hit, crit }
        } else {
            Dealt {
                hit: 0.0,
                crit: 0.0,
            }
        })
    }
}

/// A hand-written `ContextualPayload` (the TS `payload`): 1d6 on a hit, 2d6 on a crit.
struct Payload {
    hit: f64,
    crit: f64,
}

impl ContextualPayload for Payload {
    fn at(&self, _attack_id: &str) -> Result<LandingPayload, DiceError> {
        let on_hit = d6().to_pmf(0.0)?;
        let on_crit = rs(2.0, 6.0)?.to_pmf(0.0)?;
        Ok(LandingPayload {
            vulnerable: VulnerableLanding {
                on_hit: (on_hit.map_damage(|v| 2.0 * v)).into(),
                on_crit: (on_crit.map_damage(|v| 2.0 * v)).into(),
            },
            on_hit: on_hit.into(),
            on_crit: on_crit.into(),
        })
    }

    fn has_dealt(&self) -> bool {
        true
    }

    fn dealt(&self, type_: &str, _attack_id: &str) -> Result<Dealt, DiceError> {
        Ok(if type_ == "fire" {
            Dealt {
                hit: self.hit,
                crit: self.crit,
            }
        } else {
            Dealt {
                hit: 0.0,
                crit: 0.0,
            }
        })
    }
}

fn rider(id: &str, trigger: Trigger, damage: impl Into<DamageSource>) -> Rider {
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

fn first_hit(of: Option<Vec<String>>) -> Trigger {
    Trigger::FirstHit {
        of,
        per_source: None,
    }
}

fn every_hit(of: Option<Vec<String>>, max: Option<f64>) -> Trigger {
    Trigger::EveryHit {
        of,
        max,
        per_source: None,
    }
}

fn per_source(entries: Vec<(&str, RiderPayload)>) -> IndexMap<String, RiderPayload> {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

fn payload_of(damage: impl Into<DamageSource>) -> RiderPayload {
    RiderPayload {
        damage: RiderDamage::One(damage.into()),
        crit_damage: None,
    }
}

fn landing(mut r: Rider, l: RiderLanding) -> Rider {
    r.landing = Some(l);
    r
}

fn fail_kind() -> RiderLanding {
    RiderLanding::Save(SaveLanding::Fail)
}

fn damage_kind() -> RiderLanding {
    RiderLanding::Save(SaveLanding::Damage)
}

fn spec(attacks: Vec<Attack>) -> TurnSpec {
    TurnSpec {
        attacks,
        ..TurnSpec::default()
    }
}

fn with_riders(attacks: Vec<Attack>, riders: Vec<Rider>) -> TurnSpec {
    TurnSpec {
        riders: Some(riders),
        ..spec(attacks)
    }
}

fn kh(policy: Option<SubstitutePolicy>) -> SubstituteSpec {
    SubstituteSpec {
        id: Some("kh".to_string()),
        on: SubstituteOn::FirstHit,
        of: None,
        substitute: SubstituteKind::RerollKeepHigher,
        mode: None,
        policy,
    }
}

fn first_miss_sub(id: &str, kind: SubstituteKind, mode: Option<MissRerollMode>) -> SubstituteSpec {
    SubstituteSpec {
        id: Some(id.to_string()),
        on: SubstituteOn::FirstMiss,
        of: None,
        substitute: kind,
        mode,
        policy: None,
    }
}

fn with_subs(
    attacks: Vec<Attack>,
    substitutes: Vec<SubstituteSpec>,
    riders: Vec<Rider>,
) -> TurnSpec {
    TurnSpec {
        substitutes: Some(substitutes),
        riders: if riders.is_empty() {
            None
        } else {
            Some(riders)
        },
        ..spec(attacks)
    }
}

fn with_conditions(
    attacks: Vec<Attack>,
    conditions: Vec<ConditionSpec>,
    riders: Vec<Rider>,
) -> TurnSpec {
    TurnSpec {
        conditions: Some(conditions),
        riders: if riders.is_empty() {
            None
        } else {
            Some(riders)
        },
        ..spec(attacks)
    }
}

fn condition(id: &str, on: ConditionOn, of: &[&str], grants: Vec<EffectSpec>) -> ConditionSpec {
    ConditionSpec {
        id: Some(id.to_string()),
        on,
        of: rows(of),
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

fn named_rule(name: &str, r: ConditionRule, until: ConditionUntil) -> EffectSpec {
    EffectSpec::Condition {
        condition: name.to_string(),
        rule: r,
        until,
    }
}

fn first_on(id: &str, name: &str, r: ConditionRule) -> ConditionSpec {
    condition(
        id,
        ConditionOn::Attack(AttackTriggerOn::FirstHit),
        &["a"],
        vec![named_rule(name, r, ConditionUntil::EndOfTurn)],
    )
}

fn frostbite(of: &str) -> ConditionSpec {
    let mut c = condition(
        "frostbite",
        ConditionOn::Attack(AttackTriggerOn::FirstHit),
        &[of],
        vec![EffectSpec::SavePenalty {
            count: 1.0,
            sides: 4.0,
            until: SaveUntil::NextSave,
            to: None,
        }],
    );
    c.dealing = Some("fire".to_string());
    c
}

fn gated(id: &str, of: &[&str], names: &[&str], damage: impl Into<DamageSource>) -> Rider {
    let mut r = rider(id, every_hit(rows(of), None), damage);
    r.target_has = rows(names);
    r
}

/// One catalog entry: name, spec, folds and declined.
pub struct Entry {
    name: &'static str,
    spec: R<TurnSpec>,
    folds: FoldMode,
    declined: Vec<String>,
}

fn entry(name: &'static str, build: impl FnOnce() -> R<TurnSpec>) -> Entry {
    Entry {
        name,
        spec: build(),
        folds: FoldMode::Joint,
        declined: Vec::new(),
    }
}

fn masses(name: &'static str, build: impl FnOnce() -> R<TurnSpec>) -> Entry {
    Entry {
        folds: FoldMode::Masses,
        ..entry(name, build)
    }
}

fn doomed_pmf() -> R<Pmf> {
    Mixture::mix(
        &[
            ("crit", &Pmf::delta(5.0, 0.0)?, 0.05),
            ("missNone", &Pmf::delta(0.0, 0.0)?, 0.95),
        ],
        0.0,
    )
}

/// Only attacks, riders, substitutes and conditions of the fold stretch.
pub fn catalog() -> Vec<Entry> {
    let d6s: fn() -> RollBuilder = d6;
    let _ = (&d6s, MissRerollMode::Reroll);
    vec![
        // capped riders: counters shared or split
        entry("d_cap_shared", || {
            Ok(with_riders(
                three()?,
                vec![
                    rider("r1", every_hit(None, Some(2.0)), d6()),
                    rider("r2", every_hit(None, Some(2.0)), d4()),
                ],
            ))
        }),
        entry("d_cap_split_max", || {
            Ok(with_riders(
                four()?,
                vec![
                    rider("r1", every_hit(None, Some(2.0)), d6()),
                    rider("r2", every_hit(None, Some(3.0)), d4()),
                ],
            ))
        }),
        entry("d_cap_split_sources", || {
            Ok(with_riders(
                four()?,
                vec![
                    rider("r1", every_hit(rows(&["a", "b", "c"]), Some(2.0)), d6()),
                    rider("r2", every_hit(rows(&["b", "c", "d"]), Some(2.0)), d4()),
                ],
            ))
        }),
        entry("d_cap_crit_only", || {
            Ok(with_riders(
                three()?,
                vec![
                    rider(
                        "cr",
                        Trigger::AnyCrit {
                            of: None,
                            max: Some(2.0),
                        },
                        d6(),
                    ),
                    rider("eh", every_hit(None, Some(2.0)), d4()),
                ],
            ))
        }),
        entry("d_any_crit_max3", || {
            Ok(with_riders(
                four()?,
                vec![
                    rider(
                        "cr",
                        Trigger::AnyCrit {
                            of: None,
                            max: Some(3.0),
                        },
                        d6(),
                    ),
                    rider("eh", every_hit(None, None), d4()),
                ],
            ))
        }),
        entry("d_cap_save_kinds", || {
            let all = rows(&["fb", "a", "c"]);
            Ok(with_riders(
                vec![
                    plain("fb", fireball()?),
                    plain("a", sword()?),
                    plain("c", sword()?),
                ],
                vec![
                    landing(
                        rider("f", every_hit(all.clone(), Some(2.0)), d6()),
                        fail_kind(),
                    ),
                    landing(rider("g", every_hit(all, Some(2.0)), d4()), damage_kind()),
                ],
            ))
        }),
        entry("d_cap_dealt_only", || {
            Ok(with_riders(
                three()?,
                vec![
                    landing(rider("dm", every_hit(None, Some(2.0)), d6()), damage_kind()),
                    rider("pl", every_hit(None, Some(2.0)), d4()),
                ],
            ))
        }),
        entry("d_landing_any_uncapped", || {
            Ok(with_riders(
                two()?,
                vec![landing(
                    rider("an", every_hit(None, None), d6()),
                    RiderLanding::Any,
                )],
            ))
        }),
        entry("d_landing_any_save_capped", || {
            Ok(with_riders(
                vec![
                    plain("fb", fireball()?),
                    plain("a", sword()?),
                    plain("c", sword()?),
                ],
                vec![landing(
                    rider("an", every_hit(rows(&["fb", "a", "c"]), Some(2.0)), d6()),
                    RiderLanding::Any,
                )],
            ))
        }),
        entry("d_landing_any_save_uncapped", || {
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![landing(
                    rider("an", every_hit(rows(&["fb"]), None), d6()),
                    RiderLanding::Any,
                )],
            ))
        }),
        // coin bits and gate bits in one source's variant mask
        entry("d_coin_capped", || {
            let mut c1 = rider("c1", every_hit(None, Some(2.0)), d6());
            c1.happens = Some(0.5);
            let mut c2 = rider("c2", every_hit(None, Some(2.0)), d4());
            c2.happens = Some(0.25);
            let mut c3 = rider("c3", every_hit(None, None), d8());
            c3.happens = Some(0.3);
            Ok(with_riders(three()?, vec![c1, c2, c3]))
        }),
        entry("d_gates_two_sets", || {
            let mut g3 = gated("g3", &["b", "c"], &["grappled", "prone"], d8());
            g3.trigger = every_hit(rows(&["b", "c"]), Some(1.0));
            Ok(with_conditions(
                three()?,
                vec![
                    first_on("pr", "prone", prone()),
                    first_on("gr", "grappled", grappled()),
                ],
                vec![
                    gated("g1", &["b", "c"], &["prone"], d6()),
                    gated("g2", &["b", "c"], &["grappled"], d4()),
                    g3,
                ],
            ))
        }),
        entry("d_bits_mixed", || {
            let of = rows(&["b", "c", "d"]);
            let mut c1 = rider("c1", every_hit(of.clone(), Some(2.0)), d6());
            c1.happens = Some(0.5);
            let c2 = rider("c2", every_hit(of.clone(), Some(3.0)), d4());
            let g1 = gated("g1", &["b", "c", "d"], &["prone"], d6());
            let mut g2 = gated("g2", &["b", "c", "d"], &["grappled"], d8());
            g2.happens = Some(0.5);
            Ok(with_conditions(
                four()?,
                vec![
                    first_on("pr", "prone", prone()),
                    first_on("gr", "grappled", grappled()),
                ],
                vec![c1, c2, g1, g2],
            ))
        }),
        // partner riders
        entry("d_partner_where_capped", || {
            let smite = rider(
                "smite",
                Trigger::FirstHit {
                    of: None,
                    per_source: Some(per_source(vec![("b", payload_of(d8()))])),
                },
                d6(),
            );
            let mut adept = rider("adept", first_hit(rows(&["smite"])), d4());
            let mut wh = IndexMap::new();
            wh.insert("smite".to_string(), strings(&["b", "c"]));
            adept.r#where = Some(wh);
            Ok(with_riders(three()?, vec![smite, adept]))
        }),
        entry("d_partner_uncapped", || {
            let smite = rider(
                "smite",
                Trigger::FirstHit {
                    of: None,
                    per_source: Some(per_source(vec![("b", payload_of(d8()))])),
                },
                d6(),
            );
            let adept = rider("adept", first_hit(rows(&["smite"])), d4());
            Ok(with_riders(three()?, vec![smite, adept]))
        }),
        // payloads per source over save rows
        entry("d_per_source_save_damage", || {
            let ps = landing(
                rider(
                    "ps",
                    Trigger::FirstHit {
                        of: rows(&["fb", "a"]),
                        per_source: Some(per_source(vec![("fb", payload_of(d8()))])),
                    },
                    d6(),
                ),
                damage_kind(),
            );
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![ps],
            ))
        }),
        entry("d_per_source_save_fail_every", || {
            let c = RiderPayload {
                damage: RiderDamage::One(d4().into()),
                crit_damage: Some(RiderDamage::One(rs(3.0, 4.0)?.into())),
            };
            let ps = landing(
                rider(
                    "ps",
                    Trigger::EveryHit {
                        of: rows(&["fb", "a", "c"]),
                        max: Some(2.0),
                        per_source: Some(per_source(vec![("fb", payload_of(d8())), ("c", c)])),
                    },
                    d6(),
                ),
                fail_kind(),
            );
            Ok(with_riders(
                vec![
                    plain("fb", fireball()?),
                    plain("a", sword()?),
                    plain("c", axe()?),
                ],
                vec![ps],
            ))
        }),
        // joined dice, vulnerability
        entry("d_joins_pool", || {
            let pooled = d20()
                .plus(7.0)?
                .ac(15.0)?
                .on_hit(d8().plus(4.0)?.plus_dice(1.0, &d6())?)?
                .melee()?;
            let a = Ctx {
                pooled: Some(("j".to_string(), pooled)),
                ..Ctx::of(sword()?)
            };
            let mut j = rider("j", first_hit(rows(&["a", "b"])), d6());
            j.joins = rows(&["a"]);
            Ok(with_riders(
                vec![plain("a", a.source()), plain("b", axe()?)],
                vec![j],
            ))
        }),
        entry("d_vulnerable_riders", || {
            Ok(with_conditions(
                three()?,
                vec![condition(
                    "cnd",
                    ConditionOn::Attack(AttackTriggerOn::EveryHit),
                    &["a"],
                    vec![EffectSpec::Vulnerability],
                )],
                vec![
                    rider("eh", every_hit(rows(&["b", "c"]), None), d6()),
                    rider("cap", every_hit(None, Some(2.0)), d4()),
                    rider(
                        "pity",
                        Trigger::AnyMiss {
                            of: rows(&["b", "c"]),
                        },
                        d4(),
                    ),
                ],
            ))
        }),
        // separate channels, natural 20 damage, with dice-match and substitutes
        entry("d_separate_dice_match", || {
            Ok(with_riders(
                vec![plain("a", orb()?.plus_separate_damage(d6()))],
                vec![rider(
                    "dm",
                    Trigger::DiceMatch {
                        of: strings(&["a"]),
                    },
                    rs(2.0, 6.0)?,
                )],
            ))
        }),
        entry("d_separate_sub_below", sep_below),
        entry("d_separate_sub_always", || {
            Ok(with_subs(
                vec![
                    plain("a", sword()?.plus_separate_damage(d6())),
                    plain("b", axe()?),
                ],
                vec![kh(None)],
                vec![rider("sneak", first_hit(None), d6())],
            ))
        }),
        entry("d_nat20_damage_sub", || {
            Ok(with_subs(
                vec![
                    plain("a", sword()?.plus_natural20_damage(d6())?),
                    plain("b", axe()?),
                ],
                vec![kh(None)],
                vec![rider("eh", every_hit(None, Some(1.0)), d4())],
            ))
        }),
        entry("d_sub_below_dice_match", || {
            let mut sub = kh(Some(SubstitutePolicy::Below {
                hit: 12.0,
                crit: 24.0,
            }));
            sub.of = rows(&["a", "b"]);
            Ok(with_subs(
                vec![plain("a", orb()?), plain("b", orb()?)],
                vec![sub],
                vec![rider(
                    "dm",
                    Trigger::DiceMatch {
                        of: strings(&["a"]),
                    },
                    d6(),
                )],
            ))
        }),
        // rerolledUnder, missRerolled, converted miss
        entry("d_rerolled_under_sub", || {
            let a = Ctx {
                rerolled: Some(
                    d20()
                        .plus(7.0)?
                        .ac(15.0)?
                        .on_hit(d10().plus(4.0)?)?
                        .melee()?,
                ),
                ..Ctx::of(sword()?)
            };
            Ok(with_subs(
                vec![plain("a", a.source()), plain("b", Ctx::of(axe()?).source())],
                vec![kh(None)],
                vec![rider("eh", every_hit(None, None), d4())],
            ))
        }),
        entry("d_miss_reroll_add_d20_adv", || {
            let a = d20()
                .with_advantage()?
                .plus(7.0)?
                .ac(15.0)?
                .on_hit(d8().plus(4.0)?)?;
            Ok(with_subs(
                vec![plain("a", a), plain("b", sword()?)],
                vec![first_miss_sub(
                    "rr",
                    SubstituteKind::Reroll,
                    Some(MissRerollMode::AddD20),
                )],
                vec![rider("sneak", first_hit(None), d6())],
            ))
        }),
        entry("d_miss_reroll_disadv", || {
            let a = d20()
                .with_disadvantage()?
                .plus(7.0)?
                .ac(15.0)?
                .on_hit(d8().plus(4.0)?)?;
            Ok(with_subs(
                vec![plain("a", a), plain("b", sword()?)],
                vec![first_miss_sub(
                    "rr",
                    SubstituteKind::Reroll,
                    Some(MissRerollMode::Reroll),
                )],
                vec![rider("eh", every_hit(None, None), d4())],
            ))
        }),
        entry("d_convert_crit_only", || {
            let a = d20().plus(0.0)?.ac(30.0)?.on_hit(d8().plus(3.0)?)?;
            Ok(with_subs(
                vec![plain("a", a)],
                vec![first_miss_sub("conv", SubstituteKind::Hit, None)],
                vec![rider("sneak", first_hit(None), d6())],
            ))
        }),
        entry("d_convert_always_crits", || {
            let a = d20()
                .plus(5.0)?
                .ac(15.0)?
                .always_crits()?
                .on_hit(d8().plus(3.0)?)?;
            Ok(with_subs(
                vec![plain("a", a), plain("b", axe()?)],
                vec![first_miss_sub("conv", SubstituteKind::Hit, None)],
                vec![],
            ))
        }),
        // dealing typed splits, landing damage splits, wounded splits, chance rows
        entry("d_dealing_typed_attack", || {
            Ok(with_conditions(
                vec![
                    plain("a", sword()?.typed("fire")?),
                    plain("fb", fireball()?.ability("dex")?),
                ],
                vec![frostbite("a")],
                vec![],
            ))
        }),
        entry("d_dealing_rider_payload", || {
            let a = Ctx {
                dealt: Some((1.0, 1.0)),
                ..Ctx::of(sword()?)
            };
            let polar = Rider {
                damage: RiderDamageSpec::Contextual(Arc::new(Payload {
                    hit: 0.5,
                    crit: 1.0,
                })),
                ..rider("polar", every_hit(rows(&["a"]), None), d6())
            };
            Ok(with_conditions(
                vec![
                    plain("a", a.source()),
                    plain("fb", fireball()?.ability("dex")?),
                ],
                vec![frostbite("a")],
                vec![polar],
            ))
        }),
        entry("d_dealing_rider_any", || {
            let a = Ctx {
                dealt: Some((1.0, 1.0)),
                ..Ctx::of(sword()?)
            };
            let polar = Rider {
                damage: RiderDamageSpec::Contextual(Arc::new(Payload {
                    hit: 1.0,
                    crit: 0.0,
                })),
                ..landing(
                    rider("polar", every_hit(rows(&["a"]), None), d6()),
                    RiderLanding::Any,
                )
            };
            Ok(with_conditions(
                vec![
                    plain("a", a.source()),
                    plain("fb", fireball()?.ability("dex")?),
                ],
                vec![frostbite("a")],
                vec![polar],
            ))
        }),
        entry("d_landing_damage_split", || {
            let ps = landing(
                rider(
                    "ps",
                    Trigger::FirstHit {
                        of: rows(&["a", "b"]),
                        per_source: Some(per_source(vec![("a", payload_of(d8()))])),
                    },
                    d6(),
                ),
                damage_kind(),
            );
            Ok(with_riders(
                vec![plain("a", sword()?.half_on_miss()?), plain("b", axe()?)],
                vec![ps],
            ))
        }),
        entry("d_wounded_riders", || {
            Ok(with_conditions(
                three()?,
                vec![condition(
                    "ko",
                    ConditionOn::Attack(AttackTriggerOn::FirstHit),
                    &["a"],
                    vec![named_rule("asleep", prone(), ConditionUntil::UntilDamaged)],
                )],
                vec![
                    rider("eh", every_hit(rows(&["b", "c"]), None), d6()),
                    rider("cap", every_hit(rows(&["b", "c"]), Some(1.0)), d4()),
                ],
            ))
        }),
        entry("d_chance_none", || {
            Ok(with_riders(
                vec![
                    named("a", sword()?, |o| o.chance = Some(0.5)),
                    named("b", axe()?, |o| o.chance = Some(0.25)),
                    plain("c", sword()?),
                ],
                vec![
                    rider("eh", every_hit(None, None), d6()),
                    rider("cap", every_hit(None, Some(2.0)), d4()),
                ],
            ))
        }),
        // Masses vs Joint folds
        masses("d_cap_shared_masses", || {
            Ok(with_riders(
                three()?,
                vec![
                    rider("r1", every_hit(None, Some(2.0)), d6()),
                    rider("r2", every_hit(None, Some(2.0)), d4()),
                ],
            ))
        }),
        masses("d_landing_any_uncapped_masses", || {
            Ok(with_riders(
                two()?,
                vec![landing(
                    rider("an", every_hit(None, None), d6()),
                    RiderLanding::Any,
                )],
            ))
        }),
        masses("d_per_source_save_damage_masses", || {
            let ps = landing(
                rider(
                    "ps",
                    Trigger::FirstHit {
                        of: rows(&["fb", "a"]),
                        per_source: Some(per_source(vec![("fb", payload_of(d8()))])),
                    },
                    d6(),
                ),
                damage_kind(),
            );
            Ok(with_riders(
                vec![plain("fb", fireball()?), plain("a", sword()?)],
                vec![ps],
            ))
        }),
        masses("d_separate_sub_below_masses", sep_below),
        // error specs of the fold branches
        entry("d_err_cap_any_miss", || {
            Ok(with_riders(
                two()?,
                vec![
                    rider("reroll", Trigger::AnyMiss { of: None }, sword()?),
                    rider(
                        "er",
                        every_hit(rows(&["a", "b", "reroll"]), Some(2.0)),
                        d6(),
                    ),
                ],
            ))
        }),
        entry("d_err_too_many_counters", || {
            let mut attacks = Vec::new();
            for i in 0..9 {
                attacks.push(plain(&format!("a{i}"), sword()?));
            }
            let riders = (0..7)
                .map(|i| {
                    rider(
                        &format!("r{i}"),
                        every_hit(None, Some(f64::from(2 + i))),
                        d6(),
                    )
                })
                .collect();
            Ok(with_riders(attacks, riders))
        }),
        entry("d_err_too_many_variant_bits", || {
            let riders = (0..31)
                .map(|i| gated(&format!("g{i}"), &["b"], &[&format!("c{i}")], d6()))
                .collect();
            Ok(with_riders(two()?, riders))
        }),
        entry("d_err_dealing_no_odds", || {
            Ok(with_conditions(
                vec![
                    plain("a", Ctx::of(sword()?).source()),
                    plain("fb", fireball()?.ability("dex")?),
                ],
                vec![frostbite("a")],
                vec![],
            ))
        }),
        entry("d_err_dealing_rider_no_odds", || {
            Ok(with_conditions(
                vec![
                    plain("a", sword()?.typed("fire")?),
                    plain("fb", fireball()?.ability("dex")?),
                ],
                vec![frostbite("a")],
                vec![rider("plain", every_hit(rows(&["a"]), None), d6())],
            ))
        }),
        entry("d_err_per_source_attack", || {
            Ok(with_riders(
                two()?,
                vec![rider(
                    "ps",
                    Trigger::FirstHit {
                        of: None,
                        per_source: Some(per_source(vec![("b", payload_of(axe()?))])),
                    },
                    d6(),
                )],
            ))
        }),
        entry("d_err_per_source_unwatched", || {
            Ok(with_riders(
                two()?,
                vec![rider(
                    "ps",
                    Trigger::FirstHit {
                        of: rows(&["a"]),
                        per_source: Some(per_source(vec![("b", payload_of(d8()))])),
                    },
                    d6(),
                )],
            ))
        }),
        entry("d_err_reroll_bare_pmf", || {
            Ok(with_subs(
                vec![plain("a", Source::from(sword()?.to_pmf(0.0)?))],
                vec![first_miss_sub("rr", SubstituteKind::Reroll, None)],
                vec![],
            ))
        }),
        entry("d_err_convert_no_hit", || {
            let fixed = doomed_pmf()?;
            let a = Fixed {
                check: ContextualSource::row_check(&sword()?),
                pmf: fixed,
            };
            Ok(with_subs(
                vec![plain("a", Source::Contextual(ArcContextual(Arc::new(a))))],
                vec![first_miss_sub("conv", SubstituteKind::Hit, None)],
                vec![],
            ))
        }),
        entry("d_err_rerolled_no_outcome", || {
            let a = Ctx {
                rerolled: Some(
                    d20()
                        .plus(0.0)?
                        .ac(30.0)?
                        .on_hit(d8().plus(3.0)?)?
                        .no_crit()?,
                ),
                ..Ctx::of(sword()?)
            };
            Ok(with_subs(
                vec![plain("a", a.source())],
                vec![kh(None)],
                vec![],
            ))
        }),
        entry("d_err_below_with_rerolled", || {
            let a = Ctx {
                rerolled: Some(axe()?),
                ..Ctx::of(sword()?)
            };
            Ok(with_subs(
                vec![plain("a", a.source())],
                vec![kh(Some(SubstitutePolicy::Below {
                    hit: 8.0,
                    crit: 12.0,
                }))],
                vec![],
            ))
        }),
    ]
}

/// A source whose PMF ignores the context (the TS `under: () => Mixture.mix(...)`).
struct Fixed {
    check: RowCheck,
    pmf: Pmf,
}

impl ContextualSource for Fixed {
    fn row_check(&self) -> RowCheck {
        self.check.clone()
    }

    fn under(&self, _context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        Ok(self.pmf.clone())
    }
}

fn sep_below() -> R<TurnSpec> {
    Ok(with_subs(
        vec![
            plain("a", sword()?.plus_separate_damage(d6())),
            plain("b", axe()?),
        ],
        vec![kh(Some(SubstitutePolicy::Below {
            hit: 8.0,
            crit: 12.0,
        }))],
        vec![rider("eh", every_hit(None, None), d4())],
    ))
}

#[test]
fn golden_plans_d() {
    let golden: Value = match serde_json::from_str(include_str!("plans_d.json")) {
        Ok(value) => value,
        Err(e) => panic!("plans_d.json is not JSON: {e}"),
    };
    let mut failures: Vec<String> = Vec::new();
    let mut names: HashSet<&str> = HashSet::new();
    for Entry {
        name,
        spec,
        folds,
        declined,
    } in catalog()
    {
        names.insert(name);
        let Some(expected) = golden.get(name) else {
            failures.push(format!("{name}: not in plans_d.json (regenerate it)"));
            continue;
        };
        let actual = match spec {
            Err(message) => serde_json::json!({ "error": {
                "class": "Error", "code": Value::Null, "id": Value::Null, "message": message.message(),
            } }),
            Ok(spec) => {
                let declined: HashSet<String> = declined.into_iter().collect();
                let built: Result<_, DiceError> = build_plan(&spec, EPS, &declined, folds);
                match built {
                    Ok(plan) => serde_json::json!({ "plan": dump::dump_plan(&plan) }),
                    Err(error) => dump::error_dump(&error),
                }
            }
        };
        let diffs = compare::compare(&actual, expected, name);
        if !diffs.is_empty() {
            failures.push(format!("{name}: {} mismatches", diffs.len()));
            failures.extend(diffs.into_iter().take(super::SHOWN_PER_SPEC));
        }
    }
    if let Some(map) = golden.as_object() {
        for key in map.keys() {
            if !names.contains(key.as_str()) {
                failures.push(format!(
                    "{key}: in plans_d.json but not in the Rust catalog"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "plan golden mismatches:\n{}",
        failures.join("\n")
    );
}
