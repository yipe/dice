//! Tests of the checks port itself: the turn-side effect values (`src/turn/effects.ts`, from
//! src/turn/fluent-conditions.test.ts:84-151 and tests/condition-review-regressions.test.ts:109),
//! the `ContextualSource` probes of `context.ts`, and every ADR-016/017 deviation of the checks.

use super::support::*;
use crate::Pmf;
use crate::builder::attack::{AttackBuilder, ConditionGate, Grants};
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::builder::save::SaveBuilder;
use crate::common::RollType;
use crate::error::DiceError;
use crate::turn::context::{
    ContextualSource, RowCheck, RowContext, has_rerolled_under, ignores_joined, is_contextual,
    row_check_of,
};
use crate::turn::effects::*;
use crate::turn::types::*;
use std::sync::Arc;

fn rl(count: f64, die: RollBuilder) -> Result<RollBuilder, DiceError> {
    roll_with(count, Some(SidesOrDie::Die(die)), None)
}

fn ctx() -> RowContext {
    RowContext {
        roll_type: RollType::Flat,
        auto_hit: false,
        crit_on_hit: false,
        auto_fail: false,
        vulnerable: false,
        penalty_dice: Vec::new(),
        joined: Vec::new(),
    }
}

fn sword() -> Result<AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(d8())
}

fn fireball() -> Result<SaveBuilder, DiceError> {
    d20()
        .plus(5.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rl(8.0, d6())?)])
}

mod effects {
    use super::*;

    /// src/turn/fluent-conditions.test.ts:89 (the non-dnd5e factories).
    #[test]
    fn each_factory_writes_its_effect_spec() -> T {
        let frightened = ConditionRule {
            attack: Some(AttackRule {
                melee: Some(vec![AttackRuleModifier::Disadvantage]),
                ranged: None,
            }),
            ..ConditionRule::default()
        };
        assert_eq!(
            effect_spec(&condition("frightened", frightened.clone()).until_end_of_turn()),
            EffectSpec::Condition {
                condition: "frightened".to_string(),
                rule: frightened.clone(),
                until: ConditionUntil::EndOfTurn,
            }
        );
        assert_eq!(
            effect_spec(&condition("frightened", frightened.clone()).until_damaged()),
            EffectSpec::Condition {
                condition: "frightened".to_string(),
                rule: frightened,
                until: ConditionUntil::UntilDamaged,
            }
        );
        assert_eq!(
            effect_spec(&vulnerability().until_next_hit()),
            EffectSpec::Vulnerability
        );
        assert_eq!(
            effect_spec(&save_disadvantage().until_next_save().to(&["spells"]).into()),
            EffectSpec::SaveDisadvantage {
                until: SaveUntil::NextSave,
                to: Some(vec!["spells".to_string()]),
            }
        );
        assert_eq!(
            effect_spec(&save_disadvantage().until_end_of_turn().into()),
            EffectSpec::SaveDisadvantage {
                until: SaveUntil::EndOfTurn,
                to: None,
            }
        );
        assert_eq!(
            effect_spec(&save_penalty(&d4())?.until_next_save().into()),
            EffectSpec::SavePenalty {
                count: 1.0,
                sides: 4.0,
                until: SaveUntil::NextSave,
                to: None,
            }
        );
        assert_eq!(
            effect_spec(
                &save_penalty(&rl(2.0, d4())?)?
                    .until_end_of_turn()
                    .to(&["attack 2"])
                    .into()
            ),
            EffectSpec::SavePenalty {
                count: 2.0,
                sides: 4.0,
                until: SaveUntil::EndOfTurn,
                to: Some(vec!["attack 2".to_string()]),
            }
        );
        Ok(())
    }

    /// src/turn/fluent-conditions.test.ts:149
    #[test]
    fn save_penalty_takes_one_plain_die_group() {
        let plus_one = d4().plus(1.0).map_err(|e| e.to_string());
        assert!(plus_one.is_ok());
        for bad in [d4().plus(1.0), d4().add(&d6())] {
            match bad.and_then(|r| save_penalty(&r)) {
                Err(e) => assert!(e.message().contains("one plain die group"), "{e}"),
                Ok(_) => panic!("expected an error"),
            }
        }
    }

    /// The grant factories write the TS `GrantSpec` (advantage, critOnHit, until, to).
    #[test]
    fn grant_factories_write_grant_specs() {
        let g = advantage()
            .crit_on_hit()
            .until_next_attack()
            .to(&["a", "b"]);
        assert_eq!(
            grant_spec(&g),
            Some(GrantSpec {
                advantage: true,
                disadvantage: false,
                crit_on_hit: true,
                until: GrantUntil::NextAttack,
                to: Some(vec!["a".to_string(), "b".to_string()]),
            })
        );
        let h = disadvantage().until_end_of_turn();
        assert_eq!(
            grant_spec(&h).map(|s| (s.disadvantage, s.advantage, s.to)),
            Some((true, false, None))
        );
        // Repeating a modifier is a no-op.
        assert_eq!(
            advantage().advantage().until_end_of_turn(),
            advantage().until_end_of_turn()
        );
        assert_eq!(
            grant_spec(&crit_on_hit().until_end_of_turn()).map(|s| s.crit_on_hit),
            Some(true)
        );
        // A save-modifier grant has no GrantSpec.
        assert_eq!(grant_spec(&save_disadvantage().until_next_save()), None);
    }

    /// `lastingForTurn`: an effect without a lifetime lasts the turn.
    #[test]
    fn lasting_for_turn_gives_a_bare_effect_the_turn() {
        let eot = advantage().until_end_of_turn();
        assert_eq!(
            lasting_for_turn(&StartEffect::Modifiers(advantage())),
            eot.clone().into()
        );
        assert_eq!(
            lasting_for_turn(&StartEffect::Lasting(eot.clone().into())),
            eot.into()
        );
        assert_eq!(
            lasting_for_turn(&StartEffect::SaveModifier(save_disadvantage())),
            save_disadvantage().until_end_of_turn().into()
        );
        let rule = ConditionRule::default();
        assert_eq!(
            lasting_for_turn(&StartEffect::Condition(condition("x", rule.clone()))),
            condition("x", rule).until_end_of_turn()
        );
    }

    /// `keepBestDamage()` and its policies (src/turn/effects.ts).
    #[test]
    fn keep_best_damage_policies() -> T {
        let t = keep_best_damage();
        assert_eq!(
            substitute_fields(&t),
            (SubstituteKind::RerollKeepHigher, None)
        );
        let below = t.if_below(10.0)?;
        assert_eq!(
            substitute_fields(&below),
            (
                SubstituteKind::RerollKeepHigher,
                Some(SubstitutePolicy::Below {
                    hit: 10.0,
                    crit: 10.0
                })
            )
        );
        let split = t.if_below_split(10.0, 18.0)?;
        assert_eq!(
            split.policy,
            SubstitutePolicy::Below {
                hit: 10.0,
                crit: 18.0
            }
        );
        assert_throws(
            t.if_below(f64::NAN),
            "ifBelow() needs numeric thresholds, got NaN.",
        );
        assert_throws(
            t.if_below_split(1.0, f64::NAN),
            "ifBelow() needs numeric thresholds",
        );
        match t.optimally() {
            Err(e) => {
                assert_eq!(e.code, TurnSpecErrorCode::UnsupportedPolicy);
                assert_eq!(e.code.as_str(), "unsupported-policy");
                assert!(
                    e.message
                        .contains("optimally() is not supported in this release")
                );
                assert_eq!(e.id, "");
            }
            Ok(_) => panic!("optimally() must refuse"),
        }
        Ok(())
    }

    /// tests/condition-review-regressions.test.ts:108: a plain check keeps its plain-data form.
    #[test]
    fn the_plain_check_keeps_its_plain_data_form() -> T {
        let check = d20().plus(2.0)?.dc(15.0)?.ability("con")?;
        match grant_save_spec(&TriggerSave::Dc(check), 0.0)? {
            GrantSaveSpec::Dc {
                ability,
                dc,
                bonus,
                roll_type,
            } => {
                assert_eq!(ability.as_deref(), Some("constitution"));
                assert_eq!((dc, bonus, roll_type), (15.0, 2.0, None));
            }
            other => panic!("expected a plain spec, got {other:?}"),
        }
        let adv = d20().plus(2.0)?.with_advantage()?.dc(15.0)?;
        match grant_save_spec(&TriggerSave::Dc(adv), 0.0)? {
            GrantSaveSpec::Dc { roll_type, .. } => {
                assert_eq!(roll_type, Some(RollType::Advantage));
            }
            other => panic!("expected a plain spec, got {other:?}"),
        }
        // A GrantSaveSpec passes through.
        let spec = GrantSaveSpec::Dc {
            ability: None,
            dc: 12.0,
            bonus: 1.0,
            roll_type: None,
        };
        assert!(matches!(
            grant_save_spec(&TriggerSave::Spec(spec), 0.0)?,
            GrantSaveSpec::Dc { dc, .. } if dc == 12.0
        ));
        Ok(())
    }

    /// tests/condition-review-regressions.test.ts:95-107: every non-plain check becomes a
    /// `failChance` that rolls the check itself in the target's state; `ability()` and the list form
    /// change nothing.
    #[test]
    fn a_non_plain_check_is_a_fail_chance_rolled_in_the_context() -> T {
        let checks: Vec<(&str, RollBuilder, bool)> = vec![
            ("bless", d20().plus(2.0)?.plus_roll(&d4())?.dc(15.0)?, false),
            ("bane", d20().plus(2.0)?.minus_roll(&d4())?.dc(15.0)?, false),
            ("halfling", d20().reroll(1.0)?.plus(2.0)?.dc(15.0)?, false),
            (
                "alwaysFails",
                d20().plus(2.0)?.dc(15.0)?.always_fails()?,
                false,
            ),
            (
                "pinnedAdvantage",
                d20().plus(2.0)?.with_advantage()?.pinned()?.dc(15.0)?,
                true,
            ),
        ];
        for (name, check, pinned) in checks {
            assert!(!check.is_plain_save(), "{name}");
            let spec = grant_save_spec(&TriggerSave::Dc(check.ability("con")?), 0.0)?;
            let GrantSaveSpec::FailChance {
                ability,
                fail_chance,
            } = spec
            else {
                panic!("{name}: expected a failChance");
            };
            assert_eq!(ability.as_deref(), Some("constitution"), "{name}");
            // Flat context: the check's own odds.
            assert_near(fail_chance.call(&ctx())?, check.to_pmf(0.0)?.p_at(1.0));
            // Disadvantage joins the check's own roll unless it is pinned.
            let dis = RowContext {
                roll_type: RollType::Disadvantage,
                ..ctx()
            };
            let own = check.roll_type();
            let rolled = check.rolled_in(&crate::builder::dc::RolledIn {
                roll_type: if pinned {
                    own
                } else {
                    crate::turn::context::combine_roll_type(own, false, true, false)
                },
                auto_fail: false,
                penalty_dice: &[],
            })?;
            assert_near(fail_chance.call(&dis)?, rolled.to_pmf(0.0)?.p_at(1.0));
            // Auto-fail context fails for certain.
            let auto = RowContext {
                auto_fail: true,
                ..ctx()
            };
            assert_near(fail_chance.call(&auto)?, 1.0);
        }
        Ok(())
    }

    /// The failChance of a bless check in a penalty-dice context matches the same save rolled by hand.
    #[test]
    fn fail_chance_takes_penalty_dice_off_the_roll() -> T {
        let check = d20().plus(2.0)?.plus_roll(&d4())?.dc(15.0)?;
        let GrantSaveSpec::FailChance { fail_chance, .. } =
            grant_save_spec(&TriggerSave::Dc(check), 0.0)?
        else {
            panic!("expected failChance");
        };
        let context = RowContext {
            penalty_dice: vec![PenaltyDice {
                count: 1.0,
                sides: 6.0,
            }],
            ..ctx()
        };
        let by_hand = d20()
            .plus(2.0)?
            .plus_roll(&d4())?
            .minus_dice(1.0, &d6())?
            .dc(15.0)?
            .to_pmf(0.0)?
            .p_at(1.0);
        assert_near(fail_chance.call(&context)?, by_hand);
        Ok(())
    }

    /// `save(check, { fail, pass })` guards (src/turn/effects.ts).
    #[test]
    fn save_needs_a_check_and_a_fail_effect() -> T {
        let check = TriggerSaves::One(TriggerSave::Dc(d20().plus(3.0)?.dc(14.0)?));
        let fail: Vec<Lasting> = vec![advantage().until_next_attack().into()];
        assert_throws(
            save(TriggerSaves::Many(vec![]), fail.clone(), None),
            "save() needs a DC check such as d20.plus(2).dc(15), a GrantSaveSpec, or a non-empty list of them.",
        );
        assert_throws(
            save(check.clone(), vec![], None),
            "save() needs at least one effect on a failed save.",
        );
        let gated = save(check, fail.clone(), Some(vec![]))?;
        assert!(gated.pass.is_empty());
        assert_eq!(gated.fail, fail);
        Ok(())
    }

    /// `unpackSave` puts the check in `save` and `pass` in `onSave`, and refuses a gated call.
    #[test]
    fn unpack_save_moves_the_check_and_pass_into_the_gate() -> T {
        let check = TriggerSaves::One(TriggerSave::Dc(d20().plus(3.0)?.dc(14.0)?));
        let fail: Vec<Lasting> = vec![advantage().until_next_attack().into()];
        let pass: Vec<Lasting> = vec![disadvantage().until_end_of_turn().into()];
        let gated = save(check, fail.clone(), Some(pass.clone()))?;
        let (effects, gate) = unpack_save(&gated, ConditionGate::default())?;
        assert_eq!(effects, fail);
        assert!(gate.save.is_some());
        assert_eq!(gate.on_save, Some(pass));
        // No pass effects: the gate's own onSave stays absent.
        let none = save(
            TriggerSaves::One(TriggerSave::Dc(d20().plus(3.0)?.dc(14.0)?)),
            fail,
            None,
        )?;
        let (_, gate) = unpack_save(&none, ConditionGate::default())?;
        assert!(gate.on_save.is_none());
        for bad in [
            ConditionGate {
                chance: Some(0.5),
                ..ConditionGate::default()
            },
            ConditionGate {
                on_save: Some(vec![]),
                ..ConditionGate::default()
            },
            ConditionGate {
                save: Some(TriggerSaves::Many(vec![])),
                ..ConditionGate::default()
            },
        ] {
            assert_throws(
                unpack_save(&none, bad),
                "A save() value carries its own save and pass effects: drop save, chance and onSave from the options.",
            );
        }
        let (_, options) = unpack_save_options(&none, ConditionOptions::default())?;
        assert!(options.save.is_some());
        assert_throws(
            unpack_save_options(
                &none,
                ConditionOptions {
                    chance: Some(0.5),
                    ..ConditionOptions::default()
                },
            ),
            "carries its own save",
        );
        Ok(())
    }

    /// `gateFields` (src/turn/effects.ts): the fields a gate sets, and its refusals.
    #[test]
    fn gate_fields_reads_the_gate() -> T {
        assert_throws(
            gate_fields(
                &ConditionGate {
                    save: Some(TriggerSaves::One(TriggerSave::Dc(d20().dc(10.0)?))),
                    chance: Some(0.5),
                    ..ConditionGate::default()
                },
                0.0,
            ),
            "Pass either save or chance, not both: each is the chance the grants take.",
        );
        assert_throws(
            gate_fields(
                &ConditionGate {
                    on_save: Some(vec![advantage().until_next_attack().into()]),
                    ..ConditionGate::default()
                },
                0.0,
            ),
            "onSave needs a save or a chance: without one there is no other branch to apply it on.",
        );
        let empty = gate_fields(&ConditionGate::default(), 0.0)?;
        assert!(empty.chance.is_none() && empty.save.is_none() && empty.on_save.is_none());
        assert!(!empty.optional);

        let one = gate_fields(
            &ConditionGate {
                save: Some(TriggerSaves::One(TriggerSave::Dc(
                    d20().plus(2.0)?.dc(15.0)?.ability("dex")?,
                ))),
                on_save: Some(vec![advantage().until_next_attack().into()]),
                landing: Some(SaveLanding::Fail),
                dealing: Some("fire".to_string()),
                optional: true,
                target_has: Some(vec!["prone".to_string()]),
                chance: None,
            },
            0.0,
        )?;
        assert!(matches!(
            one.save,
            Some(GrantSaves::One(GrantSaveSpec::Dc { .. }))
        ));
        assert_eq!(one.on_save.as_ref().map(Vec::len), Some(1));
        assert_eq!(one.landing, Some(SaveLanding::Fail));
        assert_eq!(one.dealing.as_deref(), Some("fire"));
        assert!(one.optional);
        assert_eq!(one.target_has, Some(vec!["prone".to_string()]));

        // A list stays a list, even of one.
        let many = gate_fields(
            &ConditionGate {
                save: Some(TriggerSaves::Many(vec![TriggerSave::Dc(d20().dc(10.0)?)])),
                ..ConditionGate::default()
            },
            0.0,
        )?;
        assert!(matches!(many.save, Some(GrantSaves::Many(ref v)) if v.len() == 1));
        // `chance` alone is the only fixed gate.
        let chance = gate_fields(
            &ConditionGate {
                chance: Some(0.25),
                ..ConditionGate::default()
            },
            0.0,
        )?;
        assert_eq!(chance.chance, Some(0.25));
        Ok(())
    }

    /// `ConditionOptions.gate()` carries exactly the gate fields.
    #[test]
    fn condition_options_gate_copies_the_gate_fields() {
        let options = ConditionOptions {
            rider: RiderOptions {
                landing: Some(SaveLanding::Damage),
                target_has: Some(vec!["prone".to_string()]),
                ..RiderOptions::default()
            },
            chance: Some(0.5),
            dealing: Some("cold".to_string()),
            optional: true,
            ..ConditionOptions::default()
        };
        let gate = options.gate();
        assert_eq!(gate.chance, Some(0.5));
        assert_eq!(gate.landing, Some(SaveLanding::Damage));
        assert_eq!(gate.dealing.as_deref(), Some("cold"));
        assert!(gate.optional);
        assert_eq!(gate.target_has, Some(vec!["prone".to_string()]));
    }

    /// The contract constants of src/turn/types.ts.
    #[test]
    fn contract_constants() {
        assert_eq!(CONTRACT_REVISION, 6);
        assert_eq!(MAX_TRIGGER_GROUPS, 9);
        assert_eq!(MAX_CAPPED_COUNTERS, 6);
        assert_eq!(
            TurnSpecErrorCode::SaveWithoutAbility.as_str(),
            "save-without-ability"
        );
        assert_eq!(
            TurnSpecErrorCode::DealingJointUnsupported.as_str(),
            "dealing-joint-unsupported"
        );
        let e = TurnSpecError::new(TurnSpecErrorCode::Cycle, "a", "loop");
        assert_eq!(e.to_string(), "loop");
        assert_eq!((e.code.as_str(), e.id.as_str()), ("cycle", "a"));
    }
}

mod sources {
    use super::*;

    /// `rowCheckOf`, `isContextual`, `hasRerolledUnder`, `IGNORES_JOINED` on the library's own
    /// builders and on plain damage.
    #[test]
    fn the_four_probes_on_builders_and_plain_damage() -> T {
        let attack: Source = sword()?.into();
        let save: Source = fireball()?.into();
        let pmf: Source = Pmf::delta(3.0, 0.0)?.into();
        let rollable: Source = Source::Damage(DamageSource::Roll(d6()));
        for contextual in [&attack, &save] {
            assert!(is_contextual(contextual));
            assert!(ignores_joined(contextual));
            assert!(!has_rerolled_under(contextual));
            assert!(row_check_of(contextual).is_some());
        }
        for plain in [&pmf, &rollable] {
            assert!(!is_contextual(plain));
            assert!(!ignores_joined(plain));
            assert!(!has_rerolled_under(plain));
            assert!(row_check_of(plain).is_none());
        }
        assert_eq!(row_check_of(&attack).map(|c| c.kind), Some(RowKind::Attack));
        assert_eq!(row_check_of(&save).map(|c| c.kind), Some(RowKind::Save));
        Ok(())
    }

    /// A hand-written contextual source: `has_rerolled_under` and the optional methods default to absent.
    struct Handwritten {
        reroll: bool,
    }

    impl ContextualSource for Handwritten {
        fn row_check(&self) -> RowCheck {
            RowCheck {
                kind: RowKind::Auto,
                range: None,
                ability: None,
                roll_type: RollType::Flat,
                advantage_dice: 2,
                pinned: false,
                auto_hit: true,
                auto_crit: false,
                auto_fail: false,
            }
        }
        fn under(&self, _context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
            Pmf::delta(4.0, eps)
        }
        fn has_rerolled_under(&self) -> bool {
            self.reroll
        }
        fn rerolled_under(&self, _context: &RowContext, eps: f64) -> Result<Pmf, DiceError> {
            Pmf::delta(5.0, eps)
        }
    }

    #[test]
    fn a_handwritten_source_is_contextual_and_does_not_ignore_joined() -> T {
        let plain = Source::Contextual(ArcContextual(Arc::new(Handwritten { reroll: false })));
        let rerolling = Source::Contextual(ArcContextual(Arc::new(Handwritten { reroll: true })));
        assert!(is_contextual(&plain));
        assert!(!ignores_joined(&plain));
        assert!(!has_rerolled_under(&plain));
        assert!(has_rerolled_under(&rerolling));
        let c = rerolling.as_contextual().ok_or("contextual")?;
        assert_eq!(c.rerolled_under(&ctx(), 0.0)?.mean(), 5.0);
        assert_eq!(c.under(&ctx(), 0.0)?.mean(), 4.0);
        assert!(!c.has_dealt() && !c.has_miss_rerolled_under());
        assert_throws(c.dealt("fire", &ctx()), "dealt is not provided");
        assert!(c.roll_under(&ctx())?.is_none());
        assert!(rerolling.damage().is_none());
        Ok(())
    }

    /// `AttackBuilder.dealt` exists only on a `typed` attack (a `dealing` condition reads it).
    #[test]
    fn dealt_is_present_only_on_a_typed_attack() -> T {
        let plain = sword()?;
        assert!(!ContextualSource::has_dealt(&plain));
        let typed = plain.typed("fire")?;
        assert!(ContextualSource::has_dealt(&typed));
        let odds = ContextualSource::dealt(&typed, "fire", &ctx())?;
        let hit = typed.under(&ctx(), 0.0)?.outcome_probability("hit");
        assert!(hit > 0.0);
        // d8: every hit deals > 0; a crit too.
        assert_near(odds.hit, 1.0);
        assert_near(odds.crit, 1.0);
        let other = ContextualSource::dealt(&typed, "cold", &ctx())?;
        assert_eq!((other.hit, other.crit), (0.0, 0.0));
        // A modifier that takes a roll to 0 or below deals nothing there: d4 - 2 deals 0 on 1 and 2.
        let low = d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(d4().minus(2.0)?)?
            .typed("fire")?;
        let odds = ContextualSource::dealt(&low, "fire", &ctx())?;
        assert_near(odds.hit, 0.5);
        Ok(())
    }

    /// `under` and `roll_under` of the trait agree with the inherent methods.
    #[test]
    fn the_trait_under_and_roll_under_delegate() -> T {
        let attack = sword()?;
        let context = RowContext {
            vulnerable: true,
            ..ctx()
        };
        let via_trait = ContextualSource::under(&attack, &context, 0.0)?;
        assert_near(via_trait.mean(), attack.under(&context, 0.0)?.mean());
        match ContextualSource::roll_under(&attack, &context)? {
            Some(RollUnder::Attack(built)) => {
                assert_eq!(built.landing_scale(), 2);
                assert_near(built.to_pmf(0.0)?.mean(), via_trait.mean());
            }
            other => panic!("expected an attack, got {other:?}"),
        }
        let save = fireball()?;
        match ContextualSource::roll_under(&save, &context)? {
            Some(RollUnder::Save(built)) => {
                assert_near(
                    built.to_pmf(0.0)?.mean(),
                    ContextualSource::under(&save, &context, 0.0)?.mean(),
                );
            }
            other => panic!("expected a save, got {other:?}"),
        }
        Ok(())
    }

    /// `DamageSource::to_pmf` of each variant, and `ToPmf` of a hand-written source.
    #[test]
    fn damage_sources_produce_their_pmf() -> T {
        struct Fixed;
        impl ToPmf for Fixed {
            fn to_pmf(&self, eps: f64) -> Result<Pmf, DiceError> {
                Pmf::delta(9.0, eps)
            }
        }

        let sources: Vec<DamageSource> = vec![
            Pmf::delta(3.0, 0.0)?.into(),
            DamageSource::Roll(d6()),
            sword()?.into(),
            fireball()?.into(),
        ];
        let means = [3.0, 3.5];
        for (s, m) in sources.iter().zip(means) {
            assert_near(s.to_pmf(0.0)?.mean(), m);
        }
        assert_near(sources[2].to_pmf(0.0)?.mean(), sword()?.mean()?);
        assert_near(sources[3].to_pmf(0.0)?.mean(), fireball()?.mean()?);
        assert_eq!(
            DamageSource::Other(Arc::new(Fixed)).to_pmf(0.0)?.mean(),
            9.0
        );
        let two = RiderDamage::Many(vec![
            Pmf::delta(1.0, 0.0)?.into(),
            Pmf::delta(2.0, 0.0)?.into(),
        ]);
        assert_eq!(two.parts().len(), 2);
        assert_eq!(RiderDamage::One(DamageSource::Roll(d4())).parts().len(), 1);
        Ok(())
    }
}

mod adr {
    use super::*;

    /// ADR-017: `rerollDamage` on a die of over 1e6 sides returns `Err` (TS loops once per face).
    #[test]
    fn reroll_damage_on_a_huge_die_is_an_error() -> T {
        let huge = RollBuilder::new(1.0)?.d(2e9)?;
        let attack = d20().plus(5.0)?.ac(15.0)?.on_hit(huge)?;
        assert_throws(attack.reroll_damage(2.0), "too large to enumerate");
        // minimumDamageDie alone loops nowhere (no threshold): it is fine.
        assert!(attack.minimum_damage_die(2.0).is_ok());
        // 1e6 sides itself still works in the transform.
        let big = d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(RollBuilder::new(1.0)?.d(1000.0)?)?;
        assert!(big.reroll_damage(2.0).is_ok());
        Ok(())
    }

    /// ADR-017: `diceMatchInfo` refuses a pool of too many dice times faces, where TS enumerates
    /// for minutes; the refusal is a description like the other "too many to enumerate" ones.
    #[test]
    fn dice_match_info_refuses_a_pool_too_big_to_enumerate() -> T {
        let attack = d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(rl(500.0, RollBuilder::new(1.0)?.d(100.0)?)?)?;
        let (hit, crit) = attack.dice_match_info(0.0)?;
        assert!(hit.is_none() && crit.is_none());
        let (why_hit, why_crit) = attack.dice_match_refusals()?;
        for why in [why_hit, why_crit] {
            let why = why.ok_or("a refusal")?;
            assert!(
                why.contains("too many to enumerate its match odds exactly"),
                "{why}"
            );
        }
        // A die with over 1e6 faces is refused too.
        let huge = d20()
            .plus(5.0)?
            .ac(15.0)?
            .on_hit(rl(2.0, RollBuilder::new(1.0)?.d(2e6)?)?)?;
        let (hit, _) = huge.dice_match_refusals()?;
        assert!(hit.ok_or("a refusal")?.contains("too many faces"));
        // A small pool still has its descriptor: 2d6 doubles.
        let small = d20().plus(5.0)?.ac(15.0)?.on_hit(rl(2.0, d6())?)?;
        let (hit, crit) = small.dice_match_info(0.0)?;
        let hit = hit.ok_or("hit descriptor")?;
        assert_near(hit.match_probability_by_damage[&crate::Damage(2.0)], 1.0);
        assert_near(hit.match_probability_by_damage[&crate::Damage(7.0)], 0.0);
        assert!(crit.is_some());
        Ok(())
    }

    /// `dice_match_info` follows the TS descriptors: a single die never matches, noCrit has no crit
    /// descriptor, a keep pool and a parsed payload have none.
    #[test]
    fn dice_match_descriptors_and_refusals() -> T {
        let check = d20().plus(5.0)?.ac(15.0)?;
        let one = check.on_hit(d8())?;
        let (hit, crit) = one.dice_match_info(0.0)?;
        assert!(
            hit.ok_or("single die")?
                .match_probability_by_damage
                .is_empty()
        );
        // The auto-doubled crit is 2d8: it can match.
        assert!(!crit.ok_or("crit")?.match_probability_by_damage.is_empty());

        let nocrit = check.on_hit(rl(2.0, d6())?)?.no_crit()?;
        let (_, why) = nocrit.dice_match_refusals()?;
        assert_eq!(why.as_deref(), Some("it cannot crit (noCrit())"));

        let kept = check.on_hit(rl(4.0, d6())?.keep_highest(4.0, 3.0)?)?;
        let (why, _) = kept.dice_match_refusals()?;
        assert!(why.ok_or("keep")?.contains("keeps some of its dice"));

        let parsed = check.on_hit_args(&[Arg::Str("2d6".to_string())])?;
        let (why_hit, why_crit) = parsed.dice_match_refusals()?;
        assert!(why_hit.ok_or("parsed")?.contains("string expression"));
        assert!(why_crit.ok_or("parsed crit")?.contains("string expression"));

        let mixed = check.on_hit(rl(2.0, d6())?.plus_roll(&d8())?)?;
        let (why, _) = mixed.dice_match_refusals()?;
        assert!(
            why.ok_or("kinds")?
                .contains("dice of different kinds (d6 and d8)")
        );
        Ok(())
    }

    /// ADR-016: builder nesting past the cap is an `Err` for the wrapping call (the attack's
    /// payload wrappers inherit the roll builder's cap).
    #[test]
    fn deep_payload_wrapping_hits_the_depth_cap() -> T {
        let mut payload = d6();
        let mut hit_cap = false;
        for _ in 0..200 {
            match payload.half() {
                Ok(next) => payload = next,
                Err(e) => {
                    assert!(
                        e.message().contains("Maximum call stack size exceeded"),
                        "{e}"
                    );
                    hit_cap = true;
                    break;
                }
            }
        }
        assert!(hit_cap);
        // A payload at the cap still builds an attack and resolves.
        let attack = d20().plus(5.0)?.ac(15.0)?.on_hit(payload)?;
        assert!(attack.to_pmf(0.0).is_ok());
        Ok(())
    }
}

mod corners {
    use super::*;

    /// `ability()` names the bad value in a `TypeError`.
    #[test]
    fn ability_refuses_unknown_names() -> T {
        let check = d20().dc(10.0)?;
        assert_throws(
            check.ability("luck"),
            "ability(\"luck\"): expected str, dex, con, int, wis or cha, or a full name (strength, dexterity, constitution, intelligence, wisdom, charisma).",
        );
        assert_eq!(
            check
                .ability("wis")?
                .save_ability()
                .map(crate::builder::types::Ability::as_str),
            Some("wisdom")
        );
        assert_eq!(
            check
                .ability("charisma")?
                .save_ability()
                .map(crate::builder::types::Ability::as_str),
            Some("charisma")
        );
        // A DC method on a roll that is not a DC check is a refusal, not a panic.
        assert_throws(d20().ability("con"), "only available on a DC check");
        assert_throws(d20().always_fails(), "only available on a DC check");
        Ok(())
    }

    /// DC and AC refuse a parsed roll before anything else, and `dc` guards its argument.
    #[test]
    fn dc_and_ac_guards() -> T {
        let parsed = RollBuilder::parsed("2d6+3")?;
        assert_throws(parsed.ac(15.0), "ac");
        assert_throws(parsed.dc(15.0), "dc");
        assert_throws(d20().dc(f64::NAN), "Invalid NaN value for saveDC");
        assert_throws(d20().ac(f64::NAN), "Invalid NaN value for targetAC");
        assert_throws(d20().ac(f64::INFINITY), "ac()");
        assert_throws(d20().dc(f64::INFINITY), "dc()");
        assert_throws(
            d20().with_elven_accuracy()?.dc(15.0),
            "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead.",
        );
        assert_throws(
            d20().dc(15.0)?.with_elven_accuracy(),
            "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks).",
        );
        // dc() on a DC check keeps the ability and alwaysFails.
        let kept = d20().dc(10.0)?.ability("dex")?.always_fails()?.dc(12.0)?;
        assert_eq!(kept.save_dc(), Some(12.0));
        assert_eq!(
            kept.save_ability()
                .map(crate::builder::types::Ability::as_str),
            Some("dexterity")
        );
        assert!(kept.auto_fail());
        Ok(())
    }

    /// `rolledIn` refuses Elven Accuracy; `inContext` is `None` when the context changes nothing.
    #[test]
    fn rolled_in_and_in_context() -> T {
        let check = d20().plus(5.0)?.dc(15.0)?;
        assert_throws(
            check.rolled_in(&crate::builder::dc::RolledIn {
                roll_type: RollType::ElvenAccuracy,
                auto_fail: false,
                penalty_dice: &[],
            }),
            "A save cannot roll with Elven Accuracy: it is only valid for attack rolls.",
        );
        assert!(check.in_context(&ctx())?.is_none());
        let adv = RowContext {
            roll_type: RollType::Advantage,
            ..ctx()
        };
        let moved = check.in_context(&adv)?.ok_or("a new check")?;
        assert_eq!(moved.roll_type(), RollType::Advantage);
        assert_eq!(moved.save_dc(), Some(15.0));
        // Pinned keeps its own roll type.
        let pinned = d20().plus(5.0)?.with_disadvantage()?.pinned()?.dc(15.0)?;
        assert!(pinned.in_context(&adv)?.is_none());
        Ok(())
    }

    /// `onSaveFailure([...])` takes effects beside at most one damage roll.
    #[test]
    fn on_save_failure_effects() -> T {
        use crate::builder::dc::FailurePart;
        let check = d20().plus(5.0)?.dc(15.0)?;
        let grant: Lasting = advantage().until_next_attack().into();
        let save = check.on_save_failure_effects(&[
            FailurePart::Damage(Arg::Roll(rl(8.0, d6())?)),
            FailurePart::Effect(grant.clone()),
        ])?;
        assert_eq!(save.attached.len(), 1);
        assert_eq!(save.attached[0].grants, vec![grant.clone()]);
        assert_eq!(
            save.attached[0].gate.as_ref().and_then(|g| g.landing),
            Some(SaveLanding::Fail)
        );
        assert_near(save.mean()?, 28.0 * (1.0 - 0.55));
        // Effects only: a save with no damage.
        let bare = check.on_save_failure_effects(&[FailurePart::Effect(grant.clone())])?;
        assert!(bare.failure_effect().is_none());
        assert_near(bare.mean()?, 0.0);
        // Damage only: no attached condition.
        let plain = check.on_save_failure_effects(&[FailurePart::Damage(Arg::Roll(d6()))])?;
        assert!(plain.attached.is_empty());
        assert_throws(
            check.on_save_failure_effects(&[
                FailurePart::Damage(Arg::Roll(d6())),
                FailurePart::Damage(Arg::Roll(d8())),
            ]),
            "onSaveFailure takes at most one damage roll beside its effects; add the rolls together.",
        );
        Ok(())
    }

    /// `onEveryHit` copies its grants, unpacks a `save()` value and refuses a gated call.
    #[test]
    fn attack_attachments() -> T {
        let attack = sword()?;
        let grant: Lasting = advantage().until_next_attack().into();
        let a = attack.on_every_hit_with(Grants::One(grant.clone()), None)?;
        assert_eq!(a.attached.len(), 1);
        assert_eq!(a.attached[0].on.as_str(), "every-hit");
        assert!(attack.attached.is_empty(), "the receiver is unchanged");
        let b = a
            .on_any_crit_with(Grants::Many(vec![grant.clone()]), None)?
            .on_first_crit_with(
                Grants::One(grant.clone()),
                Some(ConditionGate {
                    chance: Some(0.5),
                    ..ConditionGate::default()
                }),
            )?;
        assert_eq!(
            b.attached.iter().map(|c| c.on.as_str()).collect::<Vec<_>>(),
            ["every-hit", "any-crit", "first-crit"]
        );
        let gated = save(
            TriggerSaves::One(TriggerSave::Dc(d20().plus(3.0)?.dc(14.0)?)),
            vec![grant.clone()],
            Some(vec![disadvantage().until_end_of_turn().into()]),
        )?;
        let c = attack.on_every_hit_with(Grants::Gated(gated.clone()), None)?;
        assert_eq!(c.attached[0].grants, vec![grant.clone()]);
        let gate = c.attached[0].gate.as_ref().ok_or("gate")?;
        assert!(gate.save.is_some() && gate.on_save.is_some());
        assert_throws(
            attack.on_every_hit_with(
                Grants::Gated(gated),
                Some(ConditionGate {
                    chance: Some(0.1),
                    ..ConditionGate::default()
                }),
            ),
            "drop save, chance and onSave from the options",
        );
        // Attachments never change the PMF.
        assert_near(c.mean()?, attack.mean()?);
        Ok(())
    }

    /// `typed` and `tagged` guards, and tags accumulate without duplicates.
    #[test]
    fn typed_and_tagged() -> T {
        let attack = sword()?;
        assert_throws(
            attack.typed(""),
            "typed() takes a damage type name, such as \"cold\".",
        );
        assert_throws(
            attack.tagged(&[]),
            "tagged() takes at least one tag, such as \"finesse\".",
        );
        assert_throws(
            attack.tagged(&["a", ""]),
            "tagged() takes non-empty strings, got \"\".",
        );
        let t = attack.tagged(&["a", "b"])?.tagged(&["b", "c"])?;
        assert_eq!(t.tags, ["a", "b", "c"]);
        assert_eq!(attack.typed("fire")?.damage_type.as_deref(), Some("fire"));
        Ok(())
    }

    /// A check that is not an attack check makes the check-reading methods `Err`, never a panic.
    #[test]
    fn a_non_attack_check_is_refused() -> T {
        let attack = AttackBuilder::without_damage(d20());
        assert!(attack.crit_threshold().is_err());
        assert!(attack.to_pmf(0.0).is_err());
        assert!(attack.with_check(|c| c).is_err());
        assert_throws(
            d20().on_hit(d6()),
            "onHit() is only available on a check built with ac(), alwaysHits() or alwaysCrits()",
        );
        Ok(())
    }

    /// A penalty die makes a save harder.
    #[test]
    fn penalty_dice_make_a_save_harder() -> T {
        let check = d20().plus(5.0)?.dc(15.0)?;
        let plain = check.save_probabilities()?;
        let harder = check
            .rolled_in(&crate::builder::dc::RolledIn {
                roll_type: RollType::Flat,
                auto_fail: false,
                penalty_dice: &[crate::turn::context::PenaltyDice {
                    count: 1.0,
                    sides: 4.0,
                }],
            })?
            .save_probabilities()?;
        assert!(harder.p_fail > plain.p_fail);
        assert_near(harder.p_fail + harder.p_success, 1.0);
        Ok(())
    }
}

mod keys {
    use super::*;
    use crate::builder::types::MissRerollMode;

    /// `cacheKey()` of the check builders, as printed by the TS (`/tmp` golden of
    /// `ACBuilder.cacheKey`, `DCBuilder.cacheKey`, `AlwaysHitBuilder.cacheKey`,
    /// `AlwaysCritBuilder.cacheKey`): the key forks on every PMF-affecting difference (AC, crit
    /// threshold, three-dice advantage, miss reroll, DC, `alwaysFails`, pinned) and on nothing a row
    /// fact (ranged, ability) sets. The Rust port has no PMF caches; these are the keys they used.
    #[test]
    fn check_cache_keys_match_the_typescript() -> T {
        let flat = "~[1;20;5;0;0;0;0;0;_;'flat;f;_]";
        let base = || d20().plus(5.0);
        let key = |r: RollBuilder| r.cache_key();
        assert_eq!(key(base()?.ac(15.0)?), Some(format!("A|15|20|2|{flat}")));
        assert_eq!(
            key(base()?.ac(15.0)?.crit_on(19.0)?),
            Some(format!("A|15|19|2|{flat}"))
        );
        assert_eq!(
            key(base()?.with_advantage()?.ac(15.0)?.three_dice_advantage()?),
            Some("A|15|20|3|~[1;20;5;0;0;0;0;0;_;'advantage;f;_]".to_string())
        );
        assert_eq!(
            key(base()?.ac(15.0)?.reroll_misses(MissRerollMode::Reroll)?),
            Some(format!("A|15|20|2|{flat}|m=reroll"))
        );
        assert_eq!(
            key(base()?.ac(15.0)?.reroll_misses(MissRerollMode::AddD20)?),
            Some(format!("A|15|20|2|{flat}|m=add-d20"))
        );
        // Row facts do not fork the key.
        assert_eq!(key(base()?.ac(15.0)?.ranged()?), key(base()?.ac(15.0)?));
        assert_eq!(
            key(base()?.dc(15.0)?.ability("con")?),
            key(base()?.dc(15.0)?)
        );
        assert_eq!(
            key(base()?.plus_roll(&d4())?.ac(15.5)?),
            Some(
                "A|15.5|20|2|~[1;20;5;0;0;0;0;0;_;'flat;f;_][1;4;0;0;0;0;0;0;_;'flat;f;_]"
                    .to_string()
            )
        );
        assert_eq!(key(base()?.dc(15.0)?), Some(format!("DC|15|{flat}")));
        assert_eq!(
            key(base()?.dc(15.0)?.always_fails()?),
            Some(format!("DC|15|F|{flat}"))
        );
        assert_eq!(
            key(base()?.dc(15.0)?.pinned()?),
            Some("DC|15|~[1;20;5;0;0;0;0;0;_;'flat;f;t]".to_string())
        );
        assert_eq!(
            key(base()?.ac(15.0)?.pinned()?),
            Some("A|15|20|2|~[1;20;5;0;0;0;0;0;_;'flat;f;t]".to_string())
        );
        assert_eq!(key(base()?), Some(flat.to_string()));
        assert_eq!(
            key(base()?.ac(15.0)?.always_hits()?),
            Some(format!("H|20|{flat}"))
        );
        assert_eq!(
            key(base()?.ac(15.0)?.crit_on(18.0)?.always_crits()?),
            Some(format!("C|0|18|15|{flat}"))
        );
        Ok(())
    }

    /// `AlwaysCritBuilder` from a three-dice AC check keeps the resolved `elven accuracy` roll, and
    /// the AC check's root die reads it (`ACBuilder.resolvedConfigs`).
    #[test]
    fn three_dice_advantage_resolves_to_elven_accuracy() -> T {
        let check = d20().with_advantage()?.ac(15.0)?.three_dice_advantage()?;
        assert_eq!(check.roll_type(), RollType::ElvenAccuracy);
        assert_eq!(
            check.get_root_die_config().map(|c| c.roll_type),
            Some(RollType::ElvenAccuracy)
        );
        // The stored config keeps `advantage`.
        assert_eq!(
            check.get_sub_roll_configs()[0].roll_type,
            RollType::Advantage
        );
        let crit = check.always_crits()?;
        assert_eq!(
            crit.get_sub_roll_configs()[0].roll_type,
            RollType::ElvenAccuracy
        );
        assert_eq!(crit.from_always_hit(), Some(false));
        // Three dice only upgrade a NET advantage.
        let flat = d20().ac(15.0)?.three_dice_advantage()?;
        assert_eq!(flat.roll_type(), RollType::Flat);
        // Idempotent.
        assert_eq!(check.three_dice_advantage()?.cache_key(), check.cache_key());
        Ok(())
    }

    /// `combine` (ac.ts): the 4 x 2 x 4 table of own roll type, advantage dice and granted flags.
    #[test]
    fn combine_table() {
        use crate::builder::ac::combine;
        use crate::builder::types::AdvantageDice::{Three, Two};
        use RollType::*;
        for (own, dice, adv, dis, want, n) in [
            (Flat, Two, false, false, Flat, 1),
            (Flat, Two, true, false, Advantage, 2),
            (Flat, Three, true, false, Advantage, 3),
            (Flat, Two, false, true, Disadvantage, 2),
            (Flat, Two, true, true, Flat, 1),
            (Advantage, Two, false, false, Advantage, 2),
            (Advantage, Three, false, false, Advantage, 3),
            (Advantage, Two, false, true, Flat, 1),
            (ElvenAccuracy, Two, false, false, Advantage, 3),
            (ElvenAccuracy, Two, true, false, Advantage, 3),
            (ElvenAccuracy, Three, false, true, Flat, 1),
            (Disadvantage, Two, false, false, Disadvantage, 2),
            (Disadvantage, Three, true, false, Flat, 1),
            (Disadvantage, Two, false, true, Disadvantage, 2),
        ] {
            let got = combine(own, dice, adv, dis);
            assert_eq!((got.roll_type, got.dice), (want, n), "{own:?} {adv} {dis}");
        }
    }
}
