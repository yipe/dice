//! Port of `src/dnd5e/index.ts`: the D&D 5e rules the generic turn contract leaves out: what each
//! condition does to a row, a target's saves by ability, the chance a target loses a contest, and
//! the features built from them.
//!
//! `RULES` is [`rules`] (insertion-ordered, the table's 13 keys) and [`rule`] (one by name). A TS
//! throw is `Err(`[`DiceError`]`)` (`Range` or `Type`).
//! Not ported: the type-only exports (`AbilityName`, `ConditionEffect`, `ConditionRule`,
//! `GrantSaveSpec` re-exports; use the `turn` ones) and `Tag` (a string-literal union; use
//! [`TAGS`]).

use crate::error::DiceError;
use indexmap::IndexMap;

use crate::js::num_to_string;
use crate::turn::effects::{
    ConditionEffect, Grant, SaveGated, TriggerSave, TriggerSaves, advantage, condition, save,
};
use crate::turn::types::{
    AttackRule, AttackRuleModifier as A, ConditionRule, GrantSaveSpec, GrantSaves, OnEnd,
    OwnModifier, OwnRule, SaveRuleModifier,
};

/// `Edition`: the rulebook edition a condition's text is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Y2014,
    Y2024,
}

impl Edition {
    /// The TS string, `"2014"` or `"2024"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Y2014 => "2014",
            Edition::Y2024 => "2024",
        }
    }
}

/// `ConditionName`: the SRD conditions [`rules`], [`grappled_rule`] and [`exhaustion_rule`] cover.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConditionName {
    Blinded,
    Charmed,
    Deafened,
    Exhaustion,
    Frightened,
    Grappled,
    Incapacitated,
    Invisible,
    Paralyzed,
    Petrified,
    Poisoned,
    Prone,
    Restrained,
    Stunned,
    Unconscious,
}

impl ConditionName {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            ConditionName::Blinded => "blinded",
            ConditionName::Charmed => "charmed",
            ConditionName::Deafened => "deafened",
            ConditionName::Exhaustion => "exhaustion",
            ConditionName::Frightened => "frightened",
            ConditionName::Grappled => "grappled",
            ConditionName::Incapacitated => "incapacitated",
            ConditionName::Invisible => "invisible",
            ConditionName::Paralyzed => "paralyzed",
            ConditionName::Petrified => "petrified",
            ConditionName::Poisoned => "poisoned",
            ConditionName::Prone => "prone",
            ConditionName::Restrained => "restrained",
            ConditionName::Stunned => "stunned",
            ConditionName::Unconscious => "unconscious",
        }
    }
}

fn attack(melee: &[A], ranged: &[A]) -> Option<AttackRule> {
    Some(AttackRule {
        melee: Some(melee.to_vec()),
        ranged: Some(ranged.to_vec()),
    })
}

fn own(attack: &[OwnModifier], check: &[OwnModifier]) -> Option<OwnRule> {
    Some(OwnRule {
        attack: (!attack.is_empty()).then(|| attack.to_vec()),
        check: (!check.is_empty()).then(|| check.to_vec()),
    })
}

fn save_rule(
    entries: &[(&str, SaveRuleModifier)],
) -> Option<IndexMap<String, Vec<SaveRuleModifier>>> {
    Some(
        entries
            .iter()
            .map(|(k, m)| (k.to_string(), vec![*m]))
            .collect(),
    )
}

const DISADV: OwnModifier = OwnModifier::Disadvantage;

fn prone_rule() -> ConditionRule {
    ConditionRule {
        attack: attack(&[A::Advantage], &[A::Disadvantage]),
        own: own(&[DISADV], &[]),
        ..Default::default()
    }
}

fn str_dex_auto_fail() -> Option<IndexMap<String, Vec<SaveRuleModifier>>> {
    save_rule(&[
        ("strength", SaveRuleModifier::AutoFail),
        ("dexterity", SaveRuleModifier::AutoFail),
    ])
}

/// One of `RULES`' 13 conditions (`None` for `grappled` and `exhaustion`, which differ by edition:
/// see [`grappled_rule`] and [`exhaustion_rule`]).
///
/// The `melee`/`ranged` keys stand for the rules' distance test: `melee` is an attack from within 5
/// feet of the target, `ranged` one from farther away. `own` is the creature's own attack rolls and
/// ability checks: no row of a turn is one, so a turn never reads it. Unconscious that ends on
/// damage leaves the creature Prone for the rest of the turn (`onEnd`).
pub fn rule(name: ConditionName) -> Option<ConditionRule> {
    Some(match name {
        ConditionName::Blinded => ConditionRule {
            attack: attack(&[A::Advantage], &[A::Advantage]),
            own: own(&[DISADV], &[]),
            ..Default::default()
        },
        ConditionName::Charmed | ConditionName::Deafened | ConditionName::Incapacitated => {
            ConditionRule::default()
        }
        ConditionName::Frightened | ConditionName::Poisoned => ConditionRule {
            own: own(&[DISADV], &[DISADV]),
            ..Default::default()
        },
        ConditionName::Invisible => ConditionRule {
            attack: attack(&[A::Disadvantage], &[A::Disadvantage]),
            own: own(&[OwnModifier::Advantage], &[]),
            ..Default::default()
        },
        ConditionName::Paralyzed => ConditionRule {
            attack: attack(&[A::Advantage, A::CritOnHit], &[A::Advantage]),
            save: str_dex_auto_fail(),
            ..Default::default()
        },
        ConditionName::Petrified | ConditionName::Stunned => ConditionRule {
            attack: attack(&[A::Advantage], &[A::Advantage]),
            save: str_dex_auto_fail(),
            ..Default::default()
        },
        ConditionName::Prone => prone_rule(),
        ConditionName::Restrained => ConditionRule {
            attack: attack(&[A::Advantage], &[A::Advantage]),
            save: save_rule(&[("dexterity", SaveRuleModifier::SaveDisadvantage)]),
            own: own(&[DISADV], &[]),
            ..Default::default()
        },
        ConditionName::Unconscious => ConditionRule {
            // An unconscious creature drops prone: a ranged attack's advantage and prone's
            // disadvantage cancel.
            attack: attack(
                &[A::Advantage, A::CritOnHit],
                &[A::Advantage, A::Disadvantage],
            ),
            save: str_dex_auto_fail(),
            on_end: Some(Box::new(OnEnd {
                condition: "prone".to_string(),
                rule: prone_rule(),
            })),
            ..Default::default()
        },
        ConditionName::Grappled | ConditionName::Exhaustion => return None,
    })
}

/// `RULES`: each condition as data, in the table's key order (13 keys).
pub fn rules() -> IndexMap<&'static str, ConditionRule> {
    use ConditionName::*;
    [
        Blinded,
        Charmed,
        Deafened,
        Frightened,
        Incapacitated,
        Invisible,
        Paralyzed,
        Petrified,
        Poisoned,
        Prone,
        Restrained,
        Stunned,
        Unconscious,
    ]
    .into_iter()
    .filter_map(|n| rule(n).map(|r| (n.as_str(), r)))
    .collect()
}

/// `grappledRule(edition)`. 2014: "speed becomes 0", no roll modifier. 2024: "You have Disadvantage
/// on attack rolls against any target other than the grappler." `own.attack` disadvantage does NOT
/// apply to attacks against the grappler; the rule data cannot say so, so consumers must apply
/// that exception.
pub fn grappled_rule(edition: Edition) -> ConditionRule {
    match edition {
        Edition::Y2014 => ConditionRule::default(),
        Edition::Y2024 => ConditionRule {
            own: own(&[DISADV], &[]),
            ..Default::default()
        },
    }
}

const SAVE_ABILITIES: [&str; 6] = [
    "strength",
    "dexterity",
    "constitution",
    "intelligence",
    "wisdom",
    "charisma",
];

/// `exhaustionRule(level, edition)`, level 1 to 6.
///
/// - 2014 (cumulative table): level 1 and up, disadvantage on ability checks; level 3 and up,
///   disadvantage on attack rolls and saving throws.
/// - 2024: `d20Penalty` of 2 times the level.
///
/// `Err` (a `RangeError`) for a level that is not an integer from 1 to 6.
pub fn exhaustion_rule(level: f64, edition: Edition) -> Result<ConditionRule, DiceError> {
    if !(level.is_finite() && level.fract() == 0.0) || level < 1.0 || level > 6.0 {
        return Err(DiceError::range(format!(
            "exhaustion level must be an integer from 1 to 6, got {}",
            num_to_string(level)
        )));
    }
    if edition == Edition::Y2024 {
        return Ok(ConditionRule {
            d20_penalty: Some(2.0 * level),
            ..Default::default()
        });
    }
    if level < 3.0 {
        return Ok(ConditionRule {
            own: own(&[], &[DISADV]),
            ..Default::default()
        });
    }
    Ok(ConditionRule {
        own: own(&[DISADV], &[DISADV]),
        save: Some(
            SAVE_ABILITIES
                .iter()
                .map(|a| (a.to_string(), vec![SaveRuleModifier::SaveDisadvantage]))
                .collect(),
        ),
        ..Default::default()
    })
}

fn of(name: ConditionName) -> ConditionEffect {
    // INFALLIBLE: every caller passes a name `rule` covers.
    condition(name.as_str(), rule(name).unwrap_or_default())
}

/// Blinded, as [`rules`] has it: `blinded().until_end_of_turn()`.
pub fn blinded() -> ConditionEffect {
    of(ConditionName::Blinded)
}

/// Paralyzed, as [`rules`] has it.
pub fn paralyzed() -> ConditionEffect {
    of(ConditionName::Paralyzed)
}

/// Prone, as [`rules`] has it.
pub fn prone() -> ConditionEffect {
    of(ConditionName::Prone)
}

/// Restrained, as [`rules`] has it.
pub fn restrained() -> ConditionEffect {
    of(ConditionName::Restrained)
}

/// Stunned, as [`rules`] has it.
pub fn stunned() -> ConditionEffect {
    of(ConditionName::Stunned)
}

/// Unconscious, as [`rules`] has it; `until_damaged()` leaves the creature Prone.
pub fn unconscious() -> ConditionEffect {
    of(ConditionName::Unconscious)
}

/// Charmed, as [`rules`] has it.
pub fn charmed() -> ConditionEffect {
    of(ConditionName::Charmed)
}

/// Deafened, as [`rules`] has it.
pub fn deafened() -> ConditionEffect {
    of(ConditionName::Deafened)
}

/// Frightened, as [`rules`] has it.
pub fn frightened() -> ConditionEffect {
    of(ConditionName::Frightened)
}

/// Incapacitated, as [`rules`] has it.
pub fn incapacitated() -> ConditionEffect {
    of(ConditionName::Incapacitated)
}

/// `invisibleRule({ attackerSees })`. 2024: an attacker who can see the Invisible creature gets
/// neither the disadvantage against it nor the Advantage it would have, so the empty rule;
/// otherwise the `RULES.invisible` rule.
pub fn invisible_rule(attacker_sees: bool) -> ConditionRule {
    if attacker_sees {
        ConditionRule::default()
    } else {
        rule(ConditionName::Invisible).unwrap_or_default()
    }
}

/// Invisible, as [`rules`] has it (the attacker cannot see the creature; see [`invisible_rule`]).
pub fn invisible() -> ConditionEffect {
    of(ConditionName::Invisible)
}

/// Petrified, as [`rules`] has it.
pub fn petrified() -> ConditionEffect {
    of(ConditionName::Petrified)
}

/// Poisoned, as [`rules`] has it.
pub fn poisoned() -> ConditionEffect {
    of(ConditionName::Poisoned)
}

/// Grappled for `edition`: `condition("grappled", grappledRule(edition))`.
pub fn grappled(edition: Edition) -> ConditionEffect {
    condition("grappled", grappled_rule(edition))
}

/// Exhaustion at `level` for `edition`: `condition("exhaustion", exhaustionRule(level, edition))`.
pub fn exhaustion(level: f64, edition: Edition) -> Result<ConditionEffect, DiceError> {
    Ok(condition("exhaustion", exhaustion_rule(level, edition)?))
}

/// `TAGS`: the tags these rules name, for `AttackBuilder.tagged()` and a trigger's `of`. Tags are
/// free-form: this is the expected vocabulary, not a limit.
pub const TAGS: [&str; 18] = [
    "weapon",
    "unarmed",
    "spell",
    "cantrip",
    "simple",
    "martial",
    "melee-weapon",
    "ranged-weapon",
    "monk-weapon",
    "ammunition",
    "finesse",
    "heavy",
    "light",
    "loading",
    "reach",
    "thrown",
    "two-handed",
    "versatile",
];

/// `vex()` (2024 weapon mastery): a hit gives advantage on your next attack roll;
/// `advantage().untilNextAttack()`.
pub fn vex() -> Grant {
    advantage().until_next_attack()
}

/// `stunningStrike(check)` (2024 Monk), once per turn: the target saves against `check`; a failure
/// leaves it Stunned for the rest of the turn, a pass still gives the next attack advantage.
/// `Err` as [`save`] is (an empty list of checks).
pub fn stunning_strike(check: TriggerSaves) -> Result<SaveGated, DiceError> {
    save(
        check,
        vec![stunned().until_end_of_turn()],
        Some(vec![advantage().until_next_attack().0]),
    )
}

/// `contestLossChance({ attacker, defender })`: the chance the target loses a contest: a flat d20 +
/// `defender` totals lower than a flat d20 + `attacker`. A tie keeps things as they were, so it goes
/// to the defender. A contest is an ability check, not a save: nothing that changes a save changes
/// it. (A NaN bonus makes every comparison false: 0.)
pub fn contest_loss_chance(attacker: f64, defender: f64) -> f64 {
    let mut lost = 0u32;
    for theirs in 1..=20 {
        for yours in 1..=20 {
            if f64::from(theirs) + defender < f64::from(yours) + attacker {
                lost += 1;
            }
        }
    }
    f64::from(lost) / 400.0
}

/// `FULL_NAMES`: an ability's short or full name to its full name.
fn full_name(key: &str) -> Option<&'static str> {
    Some(match key {
        "str" | "strength" => "strength",
        "dex" | "dexterity" => "dexterity",
        "con" | "constitution" => "constitution",
        "int" | "intelligence" => "intelligence",
        "wis" | "wisdom" => "wisdom",
        "cha" | "charisma" => "charisma",
        _ => return None,
    })
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// `saveDC(dc, bonuses)`: a trigger's save against `dc`, by the target's save bonus per ability (in
/// the order given): `save_dc(15.0, &[("con", 2.0)])` is `{ ability: "constitution", dc: 15,
/// bonus: 2 }`. Several abilities give a list, of which the target makes the one it passes most.
/// Convert with `TriggerSaves::from` wherever a trigger takes `save`.
///
/// `Err` (a `TypeError`) on no ability, an unknown or repeated one, or a `dc` or bonus that is not
/// an integer.
pub fn save_dc(dc: f64, bonuses: &[(&str, f64)]) -> Result<GrantSaves, DiceError> {
    if !is_integer(dc) {
        return Err(DiceError::type_error(format!(
            "saveDC: dc must be an integer, got {}.",
            num_to_string(dc)
        )));
    }
    let mut saves: Vec<GrantSaveSpec> = Vec::with_capacity(bonuses.len());
    for (key, bonus) in bonuses {
        let Some(ability) = full_name(key) else {
            return Err(DiceError::type_error(format!(
                "saveDC: \"{key}\" is not an ability."
            )));
        };
        if !is_integer(*bonus) {
            return Err(DiceError::type_error(format!(
                "saveDC: the {ability} bonus must be an integer, got {}.",
                num_to_string(*bonus)
            )));
        }
        saves.push(GrantSaveSpec::Dc {
            ability: Some(ability.to_string()),
            dc,
            bonus: *bonus,
            roll_type: None,
        });
    }
    if saves.is_empty() {
        return Err(DiceError::type_error(
            "saveDC: name at least one ability the target saves with.".to_string(),
        ));
    }
    let ability_of = |s: &GrantSaveSpec| match s {
        GrantSaveSpec::Dc { ability, .. } => ability.clone(),
        GrantSaveSpec::FailChance { ability, .. } => ability.clone(),
    };
    for (index, s) in saves.iter().enumerate() {
        let first = saves.iter().position(|o| ability_of(o) == ability_of(s));
        if first != Some(index) {
            return Err(DiceError::type_error(format!(
                "saveDC: {} is named twice.",
                ability_of(s).unwrap_or_default()
            )));
        }
    }
    Ok(if saves.len() == 1 {
        GrantSaves::One(saves.remove(0))
    } else {
        GrantSaves::Many(saves)
    })
}

impl From<GrantSaves> for TriggerSaves {
    fn from(saves: GrantSaves) -> TriggerSaves {
        match saves {
            GrantSaves::One(s) => TriggerSaves::One(TriggerSave::Spec(s)),
            GrantSaves::Many(v) => {
                TriggerSaves::Many(v.into_iter().map(TriggerSave::Spec).collect())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn::effects::effect_spec;
    use crate::turn::types::{ConditionUntil, EffectSpec};

    // ---- src/dnd5e/saveDC.test.ts (the last case, a Turn mean, is deferred: needs `turn()`).

    fn dc(ability: &str, dc: f64, bonus: f64) -> GrantSaveSpec {
        GrantSaveSpec::Dc {
            ability: Some(ability.to_string()),
            dc,
            bonus,
            roll_type: None,
        }
    }

    #[allow(
        clippy::needless_pass_by_value,
        reason = "test helper takes its fixtures by value, like the fluent builders it is called with"
    )]
    fn assert_one(got: Result<GrantSaves, DiceError>, want: GrantSaveSpec) {
        match got {
            Ok(GrantSaves::One(s)) => assert_eq!(format!("{s:?}"), format!("{want:?}")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn one_ability_is_one_save_by_its_full_name() {
        for (key, ability, bonus) in [
            ("con", "constitution", 2.0),
            ("constitution", "constitution", 2.0),
            ("str", "strength", -1.0),
            ("dex", "dexterity", 0.0),
            ("int", "intelligence", 4.0),
            ("wis", "wisdom", 3.0),
            ("charisma", "charisma", 1.0),
        ] {
            assert_one(save_dc(15.0, &[(key, bonus)]), dc(ability, 15.0, bonus));
        }
    }

    #[test]
    fn several_abilities_are_the_list_in_the_order_given() {
        let Ok(GrantSaves::Many(v)) = save_dc(15.0, &[("str", 5.0), ("dex", 1.0)]) else {
            panic!("expected a list");
        };
        assert_eq!(
            format!("{v:?}"),
            format!(
                "{:?}",
                vec![dc("strength", 15.0, 5.0), dc("dexterity", 15.0, 1.0)]
            )
        );
    }

    #[test]
    fn throws_a_type_error() {
        let cases: Vec<(&str, Result<GrantSaves, DiceError>)> = vec![
            ("no ability", save_dc(15.0, &[])),
            ("unknown ability", save_dc(15.0, &[("luck", 2.0)])),
            ("prototype key", save_dc(15.0, &[("toString", 2.0)])),
            (
                "same ability twice",
                save_dc(15.0, &[("con", 2.0), ("constitution", 2.0)]),
            ),
            ("fractional dc", save_dc(15.5, &[("con", 2.0)])),
            ("NaN dc", save_dc(f64::NAN, &[("con", 2.0)])),
            ("fractional bonus", save_dc(15.0, &[("con", 2.5)])),
            ("infinite bonus", save_dc(15.0, &[("con", f64::INFINITY)])),
        ];
        for (name, r) in cases {
            assert_eq!(r.expect_err(name).name(), "TypeError", "{name}");
        }
        assert_eq!(
            save_dc(15.0, &[("con", 2.0), ("constitution", 1.0)])
                .unwrap_err()
                .message(),
            "saveDC: constitution is named twice."
        );
        assert_eq!(
            save_dc(15.0, &[("luck", 2.0)]).unwrap_err().js_string(),
            "TypeError: saveDC: \"luck\" is not an ability."
        );
    }

    #[test]
    fn save_dc_converts_to_trigger_saves() {
        let t: TriggerSaves = save_dc(15.0, &[("str", 5.0), ("dex", 1.0)]).unwrap().into();
        assert!(matches!(t, TriggerSaves::Many(ref v) if v.len() == 2));
        assert!(stunning_strike(t).is_ok());
    }

    // ---- src/dnd5e/index.test.ts (the README turn is deferred: needs `turn()`).

    fn enumerated(attacker: f64, defender: f64) -> f64 {
        let mut lost = 0;
        for d in 1..=20 {
            for a in 1..=20 {
                if f64::from(a) + attacker > f64::from(d) + defender {
                    lost += 1;
                }
            }
        }
        f64::from(lost) / 400.0
    }

    #[test]
    fn has_the_srd_conditions() {
        let r = rules();
        assert_eq!(r.len(), 13);
        for k in [
            "blinded",
            "paralyzed",
            "prone",
            "restrained",
            "stunned",
            "unconscious",
        ] {
            assert!(r.contains_key(k), "{k}");
        }
        let on_end = r["unconscious"].on_end.as_ref().expect("onEnd");
        assert_eq!(on_end.condition, "prone");
        assert_eq!(on_end.rule, r["prone"]);
    }

    #[test]
    fn contest_favours_the_bigger_bonus_and_ties_go_to_the_defender() {
        assert!(contest_loss_chance(10.0, 0.0) > 0.5);
        assert_eq!(contest_loss_chance(0.0, 0.0), enumerated(0.0, 0.0));
        assert_eq!(enumerated(0.0, 0.0), 190.0 / 400.0);
        assert_eq!(contest_loss_chance(100.0, 0.0), 1.0);
        assert_eq!(contest_loss_chance(0.0, 100.0), 0.0);
        assert_eq!(contest_loss_chance(f64::NAN, 0.0), 0.0);
    }

    #[test]
    fn contest_matches_enumeration_and_closed_form() {
        let closed = |attacker: f64, defender: f64| {
            let m = defender - attacker + 1.0;
            if m > 20.0 {
                return 0.0;
            }
            if m < -19.0 {
                return 1.0;
            }
            (if m >= 1.0 {
                ((20.0 - m) * (21.0 - m)) / 2.0
            } else {
                400.0 - ((19.0 + m) * (20.0 + m)) / 2.0
            }) / 400.0
        };
        for a in -5..=15 {
            for d in -5..=15 {
                let (a, d) = (f64::from(a), f64::from(d));
                assert_eq!(contest_loss_chance(a, d), enumerated(a, d));
                assert_eq!(contest_loss_chance(a, d), closed(a, d));
            }
        }
    }

    #[test]
    fn tags_are_unique_and_include_the_ones_the_rules_use() {
        let set: std::collections::HashSet<_> = TAGS.iter().collect();
        assert_eq!(set.len(), TAGS.len());
        for t in ["finesse", "unarmed", "monk-weapon", "weapon", "spell"] {
            assert!(TAGS.contains(&t));
        }
    }

    // ---- src/dnd5e/conditions-srd.test.ts (the Turn means are deferred: need `turn()`).

    fn mods(v: &[A]) -> Option<Vec<A>> {
        Some(v.to_vec())
    }

    #[test]
    fn rules_are_the_tables() {
        let r = rules();
        let mut keys: Vec<_> = r.keys().copied().collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "blinded",
                "charmed",
                "deafened",
                "frightened",
                "incapacitated",
                "invisible",
                "paralyzed",
                "petrified",
                "poisoned",
                "prone",
                "restrained",
                "stunned",
                "unconscious"
            ]
        );
        for k in ["charmed", "deafened", "incapacitated"] {
            assert_eq!(r[k], ConditionRule::default());
        }
        let own_both = Some(OwnRule {
            attack: Some(vec![OwnModifier::Disadvantage]),
            check: Some(vec![OwnModifier::Disadvantage]),
        });
        assert_eq!(
            r["frightened"],
            ConditionRule {
                own: own_both.clone(),
                ..Default::default()
            }
        );
        assert_eq!(
            r["poisoned"],
            ConditionRule {
                own: own_both,
                ..Default::default()
            }
        );
        let own_attack = |m| {
            Some(OwnRule {
                attack: Some(vec![m]),
                check: None,
            })
        };
        assert_eq!(
            r["blinded"],
            ConditionRule {
                attack: Some(AttackRule {
                    melee: mods(&[A::Advantage]),
                    ranged: mods(&[A::Advantage])
                }),
                own: own_attack(OwnModifier::Disadvantage),
                ..Default::default()
            }
        );
        assert_eq!(
            r["invisible"],
            ConditionRule {
                attack: Some(AttackRule {
                    melee: mods(&[A::Disadvantage]),
                    ranged: mods(&[A::Disadvantage])
                }),
                own: own_attack(OwnModifier::Advantage),
                ..Default::default()
            }
        );
        let str_dex = Some(IndexMap::from([
            ("strength".to_string(), vec![SaveRuleModifier::AutoFail]),
            ("dexterity".to_string(), vec![SaveRuleModifier::AutoFail]),
        ]));
        assert_eq!(
            r["petrified"],
            ConditionRule {
                attack: Some(AttackRule {
                    melee: mods(&[A::Advantage]),
                    ranged: mods(&[A::Advantage])
                }),
                save: str_dex.clone(),
                ..Default::default()
            }
        );
        assert_eq!(
            r["prone"],
            ConditionRule {
                attack: Some(AttackRule {
                    melee: mods(&[A::Advantage]),
                    ranged: mods(&[A::Disadvantage])
                }),
                own: own_attack(OwnModifier::Disadvantage),
                ..Default::default()
            }
        );
        assert_eq!(
            r["restrained"],
            ConditionRule {
                attack: Some(AttackRule {
                    melee: mods(&[A::Advantage]),
                    ranged: mods(&[A::Advantage])
                }),
                save: Some(IndexMap::from([(
                    "dexterity".to_string(),
                    vec![SaveRuleModifier::SaveDisadvantage]
                )])),
                own: own_attack(OwnModifier::Disadvantage),
                ..Default::default()
            }
        );
        assert_eq!(
            r["paralyzed"].attack,
            Some(AttackRule {
                melee: mods(&[A::Advantage, A::CritOnHit]),
                ranged: mods(&[A::Advantage])
            })
        );
        assert_eq!(r["stunned"].save, str_dex);
        assert_eq!(
            r["unconscious"].attack,
            Some(AttackRule {
                melee: mods(&[A::Advantage, A::CritOnHit]),
                ranged: mods(&[A::Advantage, A::Disadvantage])
            })
        );
        assert_eq!(
            r["unconscious"].on_end.as_ref().map(|o| o.rule.clone()),
            Some(r["prone"].clone())
        );
    }

    #[test]
    fn grappled_rule_differs_by_edition() {
        assert_eq!(grappled_rule(Edition::Y2014), ConditionRule::default());
        assert_eq!(
            grappled_rule(Edition::Y2024),
            ConditionRule {
                own: Some(OwnRule {
                    attack: Some(vec![OwnModifier::Disadvantage]),
                    check: None
                }),
                ..Default::default()
            }
        );
    }

    #[test]
    fn exhaustion_rule_2014_is_cumulative_2024_is_two_per_level() {
        let saves: IndexMap<String, Vec<SaveRuleModifier>> = SAVE_ABILITIES
            .iter()
            .map(|a| (a.to_string(), vec![SaveRuleModifier::SaveDisadvantage]))
            .collect();
        for level in [1.0, 2.0] {
            assert_eq!(
                exhaustion_rule(level, Edition::Y2014).unwrap(),
                ConditionRule {
                    own: Some(OwnRule {
                        attack: None,
                        check: Some(vec![OwnModifier::Disadvantage])
                    }),
                    ..Default::default()
                }
            );
        }
        for level in [3.0, 4.0, 5.0, 6.0] {
            assert_eq!(
                exhaustion_rule(level, Edition::Y2014).unwrap(),
                ConditionRule {
                    own: Some(OwnRule {
                        attack: Some(vec![OwnModifier::Disadvantage]),
                        check: Some(vec![OwnModifier::Disadvantage])
                    }),
                    save: Some(saves.clone()),
                    ..Default::default()
                }
            );
        }
        for level in 1..=6 {
            let level = f64::from(level);
            assert_eq!(
                exhaustion_rule(level, Edition::Y2024).unwrap(),
                ConditionRule {
                    d20_penalty: Some(2.0 * level),
                    ..Default::default()
                }
            );
        }
    }

    #[test]
    fn exhaustion_rule_refuses_a_level_outside_1_to_6() {
        for (level, edition) in [
            (0.0, Edition::Y2024),
            (7.0, Edition::Y2014),
            (1.5, Edition::Y2014),
        ] {
            assert_eq!(
                exhaustion_rule(level, edition).unwrap_err().name(),
                "RangeError"
            );
        }
        assert_eq!(
            exhaustion_rule(1.5, Edition::Y2014)
                .unwrap_err()
                .js_string(),
            "RangeError: exhaustion level must be an integer from 1 to 6, got 1.5"
        );
    }

    #[test]
    fn each_effect_is_its_rule_as_a_condition() {
        let r = rules();
        let effects: [(&str, ConditionEffect); 7] = [
            ("charmed", charmed()),
            ("deafened", deafened()),
            ("frightened", frightened()),
            ("incapacitated", incapacitated()),
            ("invisible", invisible()),
            ("petrified", petrified()),
            ("poisoned", poisoned()),
        ];
        for (name, e) in effects {
            assert_eq!(
                effect_spec(&e.until_end_of_turn()),
                EffectSpec::Condition {
                    condition: name.to_string(),
                    rule: r[name].clone(),
                    until: ConditionUntil::EndOfTurn
                }
            );
        }
        assert_eq!(
            effect_spec(&grappled(Edition::Y2024).until_end_of_turn()),
            EffectSpec::Condition {
                condition: "grappled".to_string(),
                rule: grappled_rule(Edition::Y2024),
                until: ConditionUntil::EndOfTurn
            }
        );
        assert_eq!(
            effect_spec(&exhaustion(3.0, Edition::Y2014).unwrap().until_end_of_turn()),
            EffectSpec::Condition {
                condition: "exhaustion".to_string(),
                rule: exhaustion_rule(3.0, Edition::Y2014).unwrap(),
                until: ConditionUntil::EndOfTurn
            }
        );
    }

    // ---- src/dnd5e/rules-scope.test.ts: the rule halves (the means need `turn()`).

    #[test]
    fn invisible_rule_by_attacker_sight() {
        assert_eq!(invisible_rule(true), ConditionRule::default());
        assert_eq!(invisible_rule(false), rules()["invisible"]);
    }

    #[test]
    fn vex_is_advantage_until_next_attack() {
        assert_eq!(vex().0.spec, advantage().until_next_attack().0.spec);
    }
}
