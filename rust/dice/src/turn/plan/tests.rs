//! Tests of the plan's pure helpers (`released`, `grantApplies`, `fireMode`, `gateOpen`,
//! `checkStateLimit`, `declaredAttacks`, `checkDuplicateIds`, `isStateless`, ...) and of
//! `buildPlan`.
//!
//! plan.ts has no test file of its own: the TS tests reach it through `Turn` (readers, turn and
//! sample are the next task), so every expected value below is derived by reading the TS, and the
//! derivation is in the comment above each test. `src/turn/fluent-conditions.test.ts` mocks
//! `buildPlan` to read the specs the fluent verbs write: every case there needs `Turn` (deferred
//! with the Turn port: <file:22-446>).

use super::source::{
    attack_part_count, check_known_ability, keep_better_of_fresh, save_classes,
    save_slices_by_landing, slice_source, to_pmf,
};
use super::*;
use crate::builder::factory::*;
use crate::builder::roll::{Arg, RollBuilder};
use crate::error::DiceError;
use crate::turn::state::{
    CRIT_BIT, CRIT_MATCH_BIT, FIRST_CRIT, FIRST_HIT, MATCH_BIT, MISS_BIT, StepOutcome,
};
use crate::turn::types::{
    After, AfterLanding, Attack, AttackOptions, AttackTriggerOn, DamageSource, Rider, RiderDamage,
    RiderDamageSpec, Source, TurnSpec,
};

type T = Result<(), DiceError>;

// ---- helpers ------------------------------------------------------------------------------

fn pmf0() -> Result<Pmf, DiceError> {
    Pmf::delta(0.0, 0.0)
}

fn rider_with(trigger: Trigger) -> Result<EvaluatedRider, DiceError> {
    Ok(EvaluatedRider {
        trigger,
        id: None,
        damage: RiderDamage::One(DamageSource::Pmf(std::sync::Arc::new(pmf0()?))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    })
}

/// A step with only what `fireMode` and `gateOpen` read.
fn step_of(
    trigger: Option<Trigger>,
    reads: Option<usize>,
    slot: Option<usize>,
    negates: Option<usize>,
) -> Result<Step, DiceError> {
    let select: SelectFn = Arc::new(|_, _, _, _| Ok(0));
    Ok(Step {
        id: "s".to_string(),
        trigger: match trigger {
            Some(t) => Some(rider_with(t)?),
            None => None,
        },
        variants: Lazy::new(),
        select: select.clone(),
        damage: None,
        updates: vec![],
        update_kinds: vec![],
        settled: vec![],
        releases: vec![],
        reads,
        slot,
        negates,
        spend_slot: None,
        consumes: 0,
        hit_consumes: 0,
        wounds: 0,
        gate: None,
        grants: vec![],
        read_advantage: 0,
        read_disadvantage: 0,
        read_crit_on_hit: 0,
        flag_reads: vec![],
        context_pmfs: Lazy::new(),
        context_roll_types: vec![],
        context_vulnerable: vec![],
        context_row_contexts: vec![],
        context_index_of: select,
        transformed: false,
        converts: false,
        rerolls: vec![],
        policy: None,
        chance: 1.0,
    })
}

fn app(on: ConditionOn) -> GrantApplication {
    GrantApplication {
        condition: 0,
        on,
        reads: Some(0),
        landing: None,
        chance: 1.0,
        chance_of: None,
        grants: 0,
        on_save: 0,
        in_force: 0,
        effective: true,
        tried: Tried::Group,
        rider: None,
        dealing: false,
        counted: true,
        counted_in_force: true,
        count_only: false,
        gate_mask: None,
    }
}

const EVERY_HIT: ConditionOn = ConditionOn::Attack(AttackTriggerOn::EveryHit);
const FIRST_HIT_ON: ConditionOn = ConditionOn::Attack(AttackTriggerOn::FirstHit);
const ANY_CRIT: ConditionOn = ConditionOn::Attack(AttackTriggerOn::AnyCrit);
const ANY_MISS: ConditionOn = ConditionOn::Attack(AttackTriggerOn::AnyMiss);
const FIRST_MISS_ON: ConditionOn = ConditionOn::Attack(AttackTriggerOn::FirstMiss);

fn rs(count: f64, sides: f64) -> Result<RollBuilder, DiceError> {
    roll_dice(count, sides, None)
}

/// `d20.plus(5).ac(15).onHit(1d8)`.
fn sword() -> Result<crate::builder::attack::AttackBuilder, DiceError> {
    d20().plus(5.0)?.ac(15.0)?.on_hit(rs(1.0, 8.0)?)
}

fn spec_of(attacks: Vec<Attack>) -> TurnSpec {
    TurnSpec {
        attacks,
        ..TurnSpec::default()
    }
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() <= 1e-9, "{a} != {b}");
}

// ---- released -----------------------------------------------------------------------------

// plan.ts:409: every slot in `releases` whose code is not START_CODE (0) is reset to START_CODE; a
// slot already at START_CODE is skipped, so with nothing to reset `codes` itself comes back.
#[test]
fn released_resets_listed_slots() {
    assert_eq!(released(&[5, 0, 7], &[0, 1]), vec![0, 0, 7]);
    assert_eq!(released(&[5, 0, 7], &[2, 0]), vec![0, 0, 0]);
    assert_eq!(released(&[5, 3, 7], &[]), vec![5, 3, 7]);
    assert!(released_opt(&[0, 0], &[0, 1]).is_none());
    assert_eq!(released_opt(&[1, 0], &[0, 1]), Some(vec![0, 0]));
}

// ---- grantApplies -------------------------------------------------------------------------

// plan.ts:476. Group-read grants (`tried` = 0): every-hit applies on any outcome but a miss (and
// "none" applies nothing); first-hit on a non-miss while the group's `first` field (bits 2-3 of the
// code) is FIRST_NONE; any-crit on a crit; first-crit on a crit while CRIT_BIT is unset; any-miss
// on a miss; first-miss on a miss while MISS_BIT is unset.
#[test]
fn grant_applies_reads_the_group() {
    let hit = StepOutcome::Hit;
    let crit = StepOutcome::Crit;
    let miss = StepOutcome::Miss;
    let none = StepOutcome::None;
    let a = app(EVERY_HIT);
    assert!(grant_applies(&a, hit, &[0], None, 0, None, None));
    assert!(grant_applies(&a, crit, &[0], None, 0, None, None));
    assert!(!grant_applies(&a, miss, &[0], None, 0, None, None));
    assert!(!grant_applies(&a, none, &[0], None, 0, None, None));

    let a = app(FIRST_HIT_ON);
    assert!(grant_applies(&a, hit, &[0], None, 0, None, None));
    assert!(!grant_applies(
        &a,
        hit,
        &[FIRST_HIT << 2],
        None,
        0,
        None,
        None
    ));
    assert!(!grant_applies(&a, miss, &[0], None, 0, None, None));

    let a = app(ANY_CRIT);
    assert!(grant_applies(&a, crit, &[CRIT_BIT], None, 0, None, None));
    assert!(!grant_applies(&a, hit, &[0], None, 0, None, None));

    let a = app(ConditionOn::FirstCrit);
    assert!(grant_applies(&a, crit, &[0], None, 0, None, None));
    assert!(!grant_applies(
        &a,
        crit,
        &[CRIT_BIT | (FIRST_CRIT << 2)],
        None,
        0,
        None,
        None
    ));
    assert!(!grant_applies(&a, hit, &[0], None, 0, None, None));

    let a = app(ANY_MISS);
    assert!(grant_applies(&a, miss, &[MISS_BIT], None, 0, None, None));
    assert!(!grant_applies(&a, hit, &[0], None, 0, None, None));

    let a = app(FIRST_MISS_ON);
    assert!(grant_applies(&a, miss, &[0], None, 0, None, None));
    assert!(!grant_applies(&a, miss, &[MISS_BIT], None, 0, None, None));
    assert!(!grant_applies(&a, hit, &[0], None, 0, None, None));
}

// plan.ts:492: a landing kind with a `byKind` entry replaces the drawn outcome (a save row's draw
// is a "hit" that the `damage` kind may read as no landing).
#[test]
fn grant_applies_reads_the_landing_kind() {
    let by_kind = ByKind {
        fail: StepOutcome::Hit,
        damage: StepOutcome::Miss,
    };
    let mut a = app(EVERY_HIT);
    a.landing = Some(SaveLanding::Damage);
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        Some(by_kind),
        0,
        None,
        None
    ));
    a.landing = Some(SaveLanding::Fail);
    assert!(grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        Some(by_kind),
        0,
        None,
        None
    ));
    // With no byKind the drawn outcome stands.
    a.landing = Some(SaveLanding::Damage);
    assert!(grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));
}

// plan.ts:496: a condition with a `tried` bit is tried at most once (flag unset), and only where a
// later row reads it (`-1` is never tried); first-crit reads crits, first-miss misses, anything
// else a non-miss.
#[test]
fn grant_applies_with_a_tried_bit() {
    let mut a = app(FIRST_HIT_ON);
    a.tried = Tried::Bit(0b100);
    assert!(grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0b100,
        None,
        None
    ));
    assert!(!grant_applies(
        &a,
        StepOutcome::Miss,
        &[0],
        None,
        0,
        None,
        None
    ));
    a.tried = Tried::Never;
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));

    let mut a = app(ConditionOn::FirstCrit);
    a.tried = Tried::Bit(1);
    assert!(grant_applies(
        &a,
        StepOutcome::Crit,
        &[0],
        None,
        0,
        None,
        None
    ));
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));

    let mut a = app(FIRST_MISS_ON);
    a.tried = Tried::Bit(1);
    assert!(grant_applies(
        &a,
        StepOutcome::Miss,
        &[0],
        None,
        0,
        None,
        None
    ));
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));
}

// plan.ts:485-491: `dealing` needs a typed draw; a gate mask needs one of its bits in the flags; a
// condition on a folded rider fires where that rider is among the draw's riders, once (tried bit
// unset) where it is once per turn.
#[test]
fn grant_applies_dealing_gate_and_rider() -> T {
    let mut a = app(EVERY_HIT);
    a.dealing = true;
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        Some(false)
    ));
    assert!(grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        Some(true)
    ));

    let mut a = app(EVERY_HIT);
    a.gate_mask = Some(0b10);
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0b01,
        None,
        None
    ));
    assert!(grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0b11,
        None,
        None
    ));

    let riders: Riders = Arc::new(vec![("smite".to_string(), Arc::new(pmf0()?))]);
    let mut a = app(EVERY_HIT);
    a.rider = Some("smite".to_string());
    // The draw carries no riders / another rider: no.
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        None,
        None
    ));
    let other: Riders = Arc::new(vec![("other".to_string(), Arc::new(pmf0()?))]);
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        Some(&other),
        None
    ));
    // It fires where its rider landed, whatever the outcome (a rider on a miss counts).
    assert!(grant_applies(
        &a,
        StepOutcome::Miss,
        &[0],
        None,
        0,
        Some(&riders),
        None
    ));
    a.tried = Tried::Bit(0b1000);
    assert!(grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        Some(&riders),
        None
    ));
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0b1000,
        Some(&riders),
        None
    ));
    a.tried = Tried::Never;
    assert!(!grant_applies(
        &a,
        StepOutcome::Hit,
        &[0],
        None,
        0,
        Some(&riders),
        None
    ));
    Ok(())
}

// ---- fireMode / gateOpen ------------------------------------------------------------------

// plan.ts:753: no trigger: always fires as "hit". not-fired: fires where the negated slot is empty.
// first-hit: `first` (bits 2-3) FIRST_NONE -> null, FIRST_CRIT -> crit, else hit. any-crit: CRIT_BIT
// -> crit. any-miss: MISS_BIT -> hit. first-miss: MISS_BIT and its own slot empty. dice-match:
// MATCH_BIT -> crit when CRIT_MATCH_BIT, else hit. every-hit: never.
#[test]
fn fire_mode_per_trigger() -> T {
    let always = step_of(None, None, None, None)?;
    assert_eq!(fire_mode(&always, &[], &[]), Some(Fire::Hit));

    let not_fired = step_of(
        Some(Trigger::NotFired { of: "x".into() }),
        None,
        None,
        Some(1),
    )?;
    assert_eq!(fire_mode(&not_fired, &[], &[None, None]), Some(Fire::Hit));
    assert_eq!(fire_mode(&not_fired, &[], &[None, Some(Fire::Hit)]), None);

    let first_hit = step_of(
        Some(Trigger::FirstHit {
            of: None,
            per_source: None,
        }),
        Some(0),
        Some(0),
        None,
    )?;
    assert_eq!(fire_mode(&first_hit, &[0], &[None]), None);
    assert_eq!(
        fire_mode(&first_hit, &[FIRST_HIT << 2], &[None]),
        Some(Fire::Hit)
    );
    assert_eq!(
        fire_mode(&first_hit, &[(FIRST_CRIT << 2) | CRIT_BIT], &[None]),
        Some(Fire::Crit)
    );

    let any_crit = step_of(
        Some(Trigger::AnyCrit {
            of: None,
            max: None,
        }),
        Some(1),
        Some(0),
        None,
    )?;
    assert_eq!(fire_mode(&any_crit, &[0, 0], &[None]), None);
    assert_eq!(
        fire_mode(&any_crit, &[0, CRIT_BIT], &[None]),
        Some(Fire::Crit)
    );

    let any_miss = step_of(Some(Trigger::AnyMiss { of: None }), Some(0), Some(0), None)?;
    assert_eq!(fire_mode(&any_miss, &[0], &[None]), None);
    assert_eq!(fire_mode(&any_miss, &[MISS_BIT], &[None]), Some(Fire::Hit));

    let first_miss = step_of(
        Some(Trigger::FirstMiss { of: None }),
        Some(0),
        Some(0),
        None,
    )?;
    assert_eq!(
        fire_mode(&first_miss, &[MISS_BIT], &[None]),
        Some(Fire::Hit)
    );
    assert_eq!(
        fire_mode(&first_miss, &[MISS_BIT], &[Some(Fire::Hit)]),
        None
    );
    assert_eq!(fire_mode(&first_miss, &[0], &[None]), None);

    let dice_match = step_of(
        Some(Trigger::DiceMatch {
            of: vec!["a".into()],
        }),
        Some(0),
        Some(0),
        None,
    )?;
    assert_eq!(fire_mode(&dice_match, &[0], &[None]), None);
    assert_eq!(
        fire_mode(&dice_match, &[MATCH_BIT], &[None]),
        Some(Fire::Hit)
    );
    assert_eq!(
        fire_mode(&dice_match, &[MATCH_BIT | CRIT_MATCH_BIT], &[None]),
        Some(Fire::Crit)
    );

    let every_hit = step_of(
        Some(Trigger::EveryHit {
            of: None,
            max: None,
            per_source: None,
        }),
        Some(0),
        None,
        None,
    )?;
    assert_eq!(fire_mode(&every_hit, &[FIRST_HIT << 2], &[]), None);
    Ok(())
}

// plan.ts:798: a `fired` gate reads the fire slot; a group gate reads the slot's code as `reads`
// says: first (a landing: bits 2-3 not FIRST_NONE), any (code != START_CODE), crit, miss, match.
#[test]
fn gate_open_reads_codes_and_slots() {
    let fired = [None, Some(Fire::Hit)];
    assert!(!gate_open(&Gate::Fired { slot: 0 }, &[], &fired));
    assert!(gate_open(&Gate::Fired { slot: 1 }, &[], &fired));
    let group = |reads| Gate::Group { slot: 1, reads };
    assert!(!gate_open(&group(GateReads::First), &[0, 0], &[]));
    assert!(gate_open(
        &group(GateReads::First),
        &[0, FIRST_HIT << 2],
        &[]
    ));
    assert!(!gate_open(&group(GateReads::Any), &[0, 0], &[]));
    assert!(gate_open(&group(GateReads::Any), &[0, MISS_BIT], &[]));
    assert!(gate_open(&group(GateReads::Crit), &[0, CRIT_BIT], &[]));
    assert!(!gate_open(&group(GateReads::Crit), &[0, MISS_BIT], &[]));
    assert!(gate_open(&group(GateReads::Miss), &[0, MISS_BIT], &[]));
    assert!(gate_open(&group(GateReads::Match), &[0, MATCH_BIT], &[]));
    assert!(!gate_open(&group(GateReads::Match), &[0, CRIT_BIT], &[]));
}

// plan.ts:385: `advanced` folds the outcome into each group in `updates`; a group with a landing
// kind folds in the draw's byKind entry for it instead.
#[test]
fn advanced_folds_outcomes_and_kinds() {
    let codes = [0u32, 0, 0];
    let next = advanced(
        &codes,
        &[0, 2],
        &[None, None],
        StepOutcome::Crit,
        false,
        None,
    );
    assert_eq!(
        next,
        vec![
            (FIRST_CRIT << 2) | CRIT_BIT,
            0,
            (FIRST_CRIT << 2) | CRIT_BIT
        ]
    );
    let by_kind = ByKind {
        fail: StepOutcome::Miss,
        damage: StepOutcome::Hit,
    };
    let next = advanced(
        &codes,
        &[0, 1],
        &[Some(SaveLanding::Fail), Some(SaveLanding::Damage)],
        StepOutcome::Hit,
        false,
        Some(by_kind),
    );
    assert_eq!(next, vec![MISS_BIT, FIRST_HIT << 2, 0]);
    // A landing kind with no byKind reads the outcome as drawn.
    let next = advanced(
        &codes,
        &[0],
        &[Some(SaveLanding::Fail)],
        StepOutcome::Hit,
        false,
        None,
    );
    assert_eq!(next, vec![FIRST_HIT << 2, 0, 0]);
}

// ---- draws --------------------------------------------------------------------------------

// plan.ts:255: `scaleDraw` scales the slice and its own part.
#[test]
fn scale_draw_scales_the_slice_and_own_part() -> T {
    let mut draw = Draw::plain(
        StepOutcome::Hit,
        false,
        false,
        Arc::new(Pmf::delta(3.0, 0.0)?),
    );
    draw.own = Some(Arc::new(Pmf::delta(1.0, 0.0)?));
    let scaled = scale_draw(&draw, 0.25);
    near(scaled.slice.mass(), 0.25);
    near(scaled.own.as_ref().map_or(0.0, |p| p.mass()), 0.25);
    let bare = scale_draw(
        &Draw::plain(
            StepOutcome::Miss,
            false,
            false,
            Arc::new(Pmf::delta(0.0, 0.0)?),
        ),
        0.5,
    );
    assert!(bare.own.is_none());
    near(bare.slice.mass(), 0.5);
    Ok(())
}

// plan.ts:265: a draw with no folded riders splits by dealt > 0; the "none" outcome is wounded:false.
#[test]
fn split_wounded_by_dealt() -> T {
    let mixed = Pmf::from_map(
        indexmap::IndexMap::from([(crate::Damage(0.0), 0.5), (crate::Damage(4.0), 0.5)]),
        0.0,
        true,
    )?;
    let draw = Draw::plain(StepOutcome::Hit, false, false, Arc::new(mixed));
    let pieces = split_wounded(&draw).map_err(|e| e.to_string())?;
    assert_eq!(pieces.len(), 2);
    assert_eq!(pieces[0].wounded, Some(true));
    near(pieces[0].slice.mass(), 0.5);
    assert_eq!(pieces[1].wounded, Some(false));
    near(pieces[1].slice.mass(), 0.5);
    // A part that dealt nothing at all is one wounded:false piece.
    let nothing = Draw::plain(
        StepOutcome::Hit,
        false,
        false,
        Arc::new(Pmf::delta(0.0, 0.0)?),
    );
    let pieces = split_wounded(&nothing).map_err(|e| e.to_string())?;
    assert_eq!(pieces.len(), 1);
    assert_eq!(pieces[0].wounded, Some(false));
    let none = Draw::plain(
        StepOutcome::None,
        false,
        false,
        Arc::new(Pmf::delta(0.0, 0.0)?),
    );
    let pieces = split_wounded(&none).map_err(|e| e.to_string())?;
    assert_eq!(pieces.len(), 1);
    assert_eq!(pieces[0].wounded, Some(false));
    Ok(())
}

// plan.ts:351: draws that advance the walk identically are summed; unlike ones stay apart.
#[test]
fn merge_draws_sums_equal_draws() -> T {
    let a = Draw::plain(
        StepOutcome::Hit,
        false,
        false,
        Arc::new(Pmf::delta(3.0, 0.0)?.scale_mass(0.25)),
    );
    let b = Draw::plain(
        StepOutcome::Hit,
        false,
        false,
        Arc::new(Pmf::delta(5.0, 0.0)?.scale_mass(0.25)),
    );
    let c = Draw::plain(
        StepOutcome::Crit,
        false,
        false,
        Arc::new(Pmf::delta(7.0, 0.0)?.scale_mass(0.5)),
    );
    let merged = merge_draws(vec![a, b, c]);
    assert_eq!(merged.len(), 2);
    near(merged[0].slice.mass(), 0.5);
    assert_eq!(merged[1].outcome, StepOutcome::Crit);
    // A draw with an own part sums it with the other's slice where that has none.
    let mut with_own = Draw::plain(
        StepOutcome::Hit,
        false,
        false,
        Arc::new(Pmf::delta(3.0, 0.0)?.scale_mass(0.5)),
    );
    with_own.own = Some(Arc::new(Pmf::delta(1.0, 0.0)?.scale_mass(0.5)));
    let plain = Draw::plain(
        StepOutcome::Hit,
        false,
        false,
        Arc::new(Pmf::delta(3.0, 0.0)?.scale_mass(0.5)),
    );
    let merged = merge_draws(vec![with_own, plain]);
    assert_eq!(merged.len(), 1);
    near(merged[0].own.as_ref().map_or(0.0, |p| p.mass()), 1.0);
    Ok(())
}

// ---- checkStateLimit / checkDuplicateIds --------------------------------------------------

// plan.ts:1205: a stateLimit is undefined or a whole number of 1 or more; the message prints the
// JS number (`Infinity`, `NaN`, `1.5`, `-1`).
#[test]
fn check_state_limit_accepts_whole_numbers() {
    assert!(check_state_limit(None).is_ok());
    assert!(check_state_limit(Some(1.0)).is_ok());
    assert!(check_state_limit(Some(16384.0)).is_ok());
    for (bad, shown) in [
        (0.0, "0"),
        (-1.0, "-1"),
        (1.5, "1.5"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
    ] {
        let err = check_state_limit(Some(bad));
        assert_eq!(
            err,
            Err(DiceError::Range(format!(
                "A turn's stateLimit must be a whole number of 1 or more, got {shown}."
            )))
        );
    }
}

// plan.ts:1250: the first repeated id throws `duplicate-id` carrying that id.
#[test]
fn check_duplicate_ids_names_the_first_repeat() {
    let ids = |v: &[&str]| {
        v.iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
    };
    assert!(check_duplicate_ids(&ids(&["a", "b", "c"])).is_ok());
    assert!(check_duplicate_ids(&[]).is_ok());
    let err = check_duplicate_ids(&ids(&["a", "b", "b", "a"]));
    assert_eq!(
        err,
        Err(fail(
            TurnSpecErrorCode::DuplicateId,
            "b",
            "Duplicate id \"b\"."
        ))
    );
    match err {
        Err(DiceError::TurnSpec(e)) => assert_eq!(e.code, TurnSpecErrorCode::DuplicateId),
        other => panic!("{other:?}"),
    }
}

// plan.ts:1278: the message names the owner and the ability.
#[test]
fn check_known_ability_accepts_5e_names() {
    for ok in [
        "str", "dex", "con", "int", "wis", "cha", "strength", "wisdom", "charisma",
    ] {
        assert!(check_known_ability("o", ok).is_ok());
    }
    assert_eq!(
        check_known_ability("fireball", "luck"),
        Err(fail(
            TurnSpecErrorCode::UnknownAbility,
            "fireball",
            "\"fireball\" saves with \"luck\", which is not a 5e ability (str, dex, con, int, wis, cha or the full name)."
        ))
    );
    assert!(check_known_ability("o", "Dex").is_err());
}

// ---- isStateless / declaredAttacks --------------------------------------------------------

// plan.ts:1264: no rider, substitute, condition or probe, no attack gated on another, and no
// source with attached conditions.
#[test]
fn is_stateless_reads_the_shape() -> T {
    let bare = spec_of(vec![Attack::Bare(sword()?.into())]);
    assert!(is_stateless(&bare));
    assert!(is_stateless(&spec_of(vec![])));

    let mut with_rider = bare.clone();
    with_rider.riders = Some(vec![Rider {
        trigger: Trigger::FirstHit {
            of: None,
            per_source: None,
        },
        id: None,
        damage: RiderDamageSpec::Plain(RiderDamage::One(DamageSource::Pmf(std::sync::Arc::new(
            pmf0()?,
        )))),
        crit_damage: None,
        landing: None,
        happens: None,
        joins: None,
        r#where: None,
        target_has: None,
    }]);
    assert!(!is_stateless(&with_rider));

    // An empty list is nothing.
    let mut empty_lists = bare.clone();
    empty_lists.riders = Some(vec![]);
    empty_lists.substitutes = Some(vec![]);
    empty_lists.conditions = Some(vec![]);
    empty_lists.observe = Some(vec![]);
    assert!(is_stateless(&empty_lists));

    let gated = spec_of(vec![
        Attack::Bare(sword()?.into()),
        Attack::Declared {
            options: AttackOptions {
                after: Some(After {
                    of: "attack 1".into(),
                    landing: AfterLanding::Hit,
                }),
                ..AttackOptions::default()
            },
            source: sword()?.into(),
        },
    ]);
    assert!(!is_stateless(&gated));

    // An option set with no `after` stays stateless.
    let declared = spec_of(vec![Attack::Declared {
        options: AttackOptions {
            id: Some("a".into()),
            chance: Some(0.5),
            ..AttackOptions::default()
        },
        source: sword()?.into(),
    }]);
    assert!(is_stateless(&declared));

    // A source carrying an attached condition (`onEveryHit`) is not stateless, bare or declared.
    let carrying = sword()?.on_every_hit_with(
        crate::builder::attack::Grants::One(
            crate::turn::effects::advantage().until_next_attack().into(),
        ),
        None,
    )?;
    assert!(!is_stateless(&spec_of(vec![Attack::Bare(
        carrying.clone().into()
    )])));
    assert!(!is_stateless(&spec_of(vec![Attack::Declared {
        options: AttackOptions::default(),
        source: carrying.into(),
    }])));
    Ok(())
}

// plan.ts:1216: ids default to `attack N` (1-based), a declared id wins; tags are the wrapper's
// `tag` then the source's own, once each; chance defaults to 1 and must be in [0, 1]; target
// defaults to "target"; the source's PMF and slices come with it. A bare PMF has no hit or crit
// outcome: slices null.
#[test]
fn declared_attacks_resolve_and_validate() -> T {
    let tagged = sword()?.tagged(&["melee", "main"])?;
    let spec = spec_of(vec![
        Attack::Bare(tagged.clone().into()),
        Attack::Declared {
            options: AttackOptions {
                id: Some("off".into()),
                tag: Some("main".into()),
                chance: Some(0.5),
                target: Some("goblin".into()),
                after: Some(After {
                    of: "attack 1".into(),
                    landing: AfterLanding::Damage,
                }),
            },
            source: tagged.clone().into(),
        },
        Attack::Bare(Source::from(Pmf::delta(4.0, 0.0)?)),
    ]);
    let rows = declared_attacks(&spec, 0.0).map_err(|e| e.to_string())?;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].id, "attack 1");
    assert_eq!(rows[0].tags, vec!["melee".to_string(), "main".to_string()]);
    assert_eq!(rows[0].chance, 1.0);
    assert_eq!(rows[0].target, "target");
    assert!(rows[0].after.is_none());
    assert_eq!(rows[1].id, "off");
    // The wrapper's tag, then the source's own once each: "main" is not repeated.
    assert_eq!(rows[1].tags, vec!["main".to_string(), "melee".to_string()]);
    assert_eq!(rows[1].chance, 0.5);
    assert_eq!(rows[1].target, "goblin");
    assert_eq!(
        rows[1].after,
        Some(After {
            of: "attack 1".into(),
            landing: AfterLanding::Damage
        })
    );
    // 1d8 + 5 vs AC 15: hit on 10+ (55%), crit on 20 (5%) -> the slices' masses.
    let slices = rows[0].slices.as_ref().ok_or("an attack is sliced")?;
    near(slices.hit.mass(), 0.5);
    near(slices.crit.mass(), 0.05);
    near(slices.miss.mass(), 0.45);
    near(rows[0].pmf.mass(), 1.0);
    assert_eq!(rows[2].id, "attack 3");
    assert!(rows[2].slices.is_none());
    near(rows[2].pmf.p_at(4.0), 1.0);
    Ok(())
}

#[test]
fn declared_attacks_refuse_a_chance_outside_0_1() -> T {
    for (chance, shown) in [(1.5, "1.5"), (-0.1, "-0.1"), (f64::NAN, "NaN")] {
        let spec = spec_of(vec![Attack::Declared {
            options: AttackOptions {
                chance: Some(chance),
                ..AttackOptions::default()
            },
            source: sword()?.into(),
        }]);
        assert_eq!(
            declared_attacks(&spec, 0.0).map(|_| ()),
            Err(DiceError::Range(format!(
                "Attack \"attack 1\" needs a chance in [0, 1], got {shown}."
            )))
        );
    }
    Ok(())
}

// ---- source slicing -----------------------------------------------------------------------

// plan.ts:960: an attack-shaped PMF slices into hit / crit / miss; a damage roll (no hit or crit
// label) does not. A list holding two attacks is not one attack: null.
#[test]
fn slice_source_splits_attack_shaped_pmfs() -> T {
    let attack = sword()?;
    let pmf = attack.to_pmf(0.0)?;
    let slices = slice_source(&pmf, None, 0.0)
        .map_err(|e| e.to_string())?
        .ok_or("sliced")?;
    near(
        slices.hit.mass() + slices.crit.mass() + slices.miss.mass(),
        1.0,
    );
    near(slices.crit.mass(), 0.05);

    let plain = rs(2.0, 6.0)?.to_pmf(0.0)?;
    assert!(
        slice_source(&plain, None, 0.0)
            .map_err(|e| e.to_string())?
            .is_none()
    );

    let two = PlanDamage::Many(vec![attack.clone().into(), attack.clone().into()]);
    let both = to_pmf(&two, 0.0, "x").map_err(|e| e.to_string())?;
    assert!(
        slice_source(&both, Some(&two), 0.0)
            .map_err(|e| e.to_string())?
            .is_none()
    );
    let one = PlanDamage::Many(vec![attack.clone().into()]);
    let single = to_pmf(&one, 0.0, "x").map_err(|e| e.to_string())?;
    assert!(
        slice_source(&single, Some(&one), 0.0)
            .map_err(|e| e.to_string())?
            .is_some()
    );
    assert_eq!(
        attack_part_count(&[attack.clone().into(), rs(1.0, 4.0)?.into()], 0.0, "x"),
        Ok(1)
    );
    Ok(())
}

// plan.ts:1049-1078: the four save classes sum to the row; each landing kind sees a hit slice of
// the classes it lands (fail: classes 0, 1; damage: classes 0, 2) and the rest as misses.
#[test]
fn save_classes_partition_a_save_row() -> T {
    let save = d20()
        .plus(5.0)?
        .dc(15.0)?
        .on_save_failure_args(&[Arg::Roll(rs(2.0, 6.0)?)])?
        .save_half()?;
    let pmf = save.to_pmf(0.0)?;
    let classes = save_classes(&pmf);
    let total: f64 = classes.iter().map(|c| c.mass()).sum();
    near(total, 1.0);
    let fail = save_slices_by_landing(&classes, SaveLanding::Fail);
    near(fail.hit.mass() + fail.miss.mass(), 1.0);
    near(fail.hit.mass(), classes[0].mass() + classes[1].mass());
    let damage = save_slices_by_landing(&classes, SaveLanding::Damage);
    near(damage.hit.mass(), classes[0].mass() + classes[2].mass());
    near(fail.crit.mass(), 0.0);
    Ok(())
}

// plan.ts:1120: keepBetterOfFresh over the whole of `base` is its max-of-two: kept + beaten has
// the mass of `spend` and, taken over all of base, equals base.maxOfTwo().
#[test]
fn keep_better_of_fresh_is_max_of_two_over_all_of_base() -> T {
    let base = rs(1.0, 6.0)?.to_pmf(0.0)?;
    let (kept, beaten) = keep_better_of_fresh(&base, &base);
    let sum = kept.add(&beaten);
    let max = base.max_of_two();
    near(sum.mass(), 1.0);
    for face in 1..=6 {
        near(sum.p_at(f64::from(face)), max.p_at(f64::from(face)));
    }
    Ok(())
}

#[test]
fn by_kind_outcomes_follow_the_kinds() {
    assert_eq!(dealt_by_kind(false), DEALT_HIT);
    assert_eq!(not_dealt_by_kind(true), NOT_DEALT_CRIT);
    assert_eq!(NOT_DEALT_HIT.of(SaveLanding::Damage), StepOutcome::None);
    assert_eq!(NOT_DEALT_HIT.of(SaveLanding::Fail), StepOutcome::Hit);
    assert_eq!(
        super::source::class_outcomes(1),
        ByKind {
            fail: StepOutcome::Hit,
            damage: StepOutcome::Miss
        }
    );
    assert_eq!(
        super::source::class_outcomes(2),
        ByKind {
            fail: StepOutcome::Miss,
            damage: StepOutcome::Hit
        }
    );
}

#[test]
fn lazy_tables_have_holes() {
    let lazy: Lazy<u8> = Lazy::new();
    assert!(lazy.is_empty());
    assert_eq!(lazy.push(1), 0);
    lazy.set(3, 9);
    assert_eq!(lazy.len(), 4);
    assert!(lazy.get(1).is_none());
    assert_eq!(lazy.get(3).map(|v| *v), Some(9));
    lazy.set_len(2);
    assert_eq!(lazy.len(), 2);
    assert_eq!(lazy.built().len(), 1);
}

// The plan is shared by the walk, the sampler and the readers, possibly across threads (the lazy
// tables of a step are filled while a walk runs): everything it holds is `Send + Sync`.
#[test]
fn plans_are_send_and_sync() {
    fn assert_send_sync<X: Send + Sync>() {}
    assert_send_sync::<TurnPlan>();
    assert_send_sync::<Step>();
    assert_send_sync::<Draw>();
    assert_send_sync::<DiceError>();
}
