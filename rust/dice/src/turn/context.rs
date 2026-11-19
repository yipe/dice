//! Port of `src/turn/context.ts`: the row context a turn state puts a row in.
//!
//! `rowCheckOf`, `isContextual`, `hasRerolledUnder` and `IGNORES_JOINED` probe a JS object's shape at
//! runtime. Here a source that rolls under a turn state implements [`ContextualSource`] (the
//! library's `AttackBuilder` and `SaveBuilder`, or a hand-written one wrapped in
//! `Source::Contextual`), and the four probes are [`row_check_of`], [`is_contextual`],
//! [`has_rerolled_under`] and [`ignores_joined`], reading a [`Source`]. A bare `Pmf` or roll is
//! never contextual (TS: `source instanceof PMF`, or no `under`).

use super::types::Source;
use crate::Pmf;
use crate::builder::attack::AttackBuilder;
use crate::builder::roll::RollBuilder;
use crate::builder::save::SaveBuilder;
use crate::builder::types::MissRerollMode;
use crate::error::DiceError;
use crate::js::num_to_string;

pub use crate::common::RollType;

/// `turn/types.ts` `RowContext`.
#[derive(Clone, Debug, PartialEq)]
pub struct RowContext {
    pub roll_type: RollType,
    pub auto_hit: bool,
    pub crit_on_hit: bool,
    pub auto_fail: bool,
    pub vulnerable: bool,
    pub penalty_dice: Vec<PenaltyDice>,
    pub joined: Vec<String>,
}

/// `turn/types.ts` `RowCheck.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Attack,
    Save,
    Auto,
}

/// `turn/types.ts` `RowCheck.range`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowRange {
    Melee,
    Ranged,
}

/// `turn/types.ts` `RowCheck`; `advantage_dice` is 2 or 3.
#[derive(Clone, Debug, PartialEq)]
pub struct RowCheck {
    pub kind: RowKind,
    pub range: Option<RowRange>,
    pub ability: Option<String>,
    pub roll_type: RollType,
    pub advantage_dice: u8,
    pub pinned: bool,
    pub auto_hit: bool,
    pub auto_crit: bool,
    pub auto_fail: bool,
}

/// `RollUnder`: the builder behind `under(context)` (`AttackBuilder | SaveBuilder | RollBuilder`).
#[derive(Clone, Debug)]
pub enum RollUnder {
    Attack(Box<AttackBuilder>),
    Save(Box<SaveBuilder>),
    Roll(RollBuilder),
}

/// P(the row deals more than 0 damage of a type), given it lands as a hit and as a crit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dealt {
    pub hit: f64,
    pub crit: f64,
}

/// `ContextualSource`: a source whose PMF depends on the state it rolls in; the turn resolves a
/// [`RowContext`] and asks for it. The library's `AttackBuilder` and `SaveBuilder` implement it.
///
/// `eps` is the epsilon the PMF is built at (TS: `AttackBuilder.under`'s optional second
/// argument; a hand-written source may ignore it).
pub trait ContextualSource: Send + Sync {
    /// What the row declares; read once, when the turn is built. Not the builders' `check`.
    fn row_check(&self) -> RowCheck;

    /// The row's outcome-labelled PMF in the given context.
    fn under(&self, context: &RowContext, eps: f64) -> Result<Pmf, DiceError>;

    /// [`ContextualSource::under`] as a shared PMF; a source that caches its PMFs returns the
    /// cached `Arc` itself, so per-PMF memos stay warm across turns.
    fn under_shared(
        &self,
        context: &RowContext,
        eps: f64,
    ) -> Result<std::sync::Arc<Pmf>, DiceError> {
        self.under(context, eps).map(std::sync::Arc::new)
    }

    /// Whether [`ContextualSource::rerolled_under`] is provided (TS: `rerolledUnder` is present).
    fn has_rerolled_under(&self) -> bool {
        false
    }

    /// The row's PMF in `context` once a first-hit substitute (`reroll-keep-higher`) is spent on
    /// it. Absent (`has_rerolled_under` false): keep-higher of the base payload.
    fn rerolled_under(&self, _context: &RowContext, _eps: f64) -> Result<Pmf, DiceError> {
        Err(DiceError::error("rerolledUnder is not provided"))
    }

    /// Whether [`ContextualSource::dealt`] is provided (TS: only a `typed` attack has `dealt`).
    fn has_dealt(&self) -> bool {
        false
    }

    /// P(the row deals more than 0 damage of `type_` after the target's scale), given it lands as
    /// a hit and as a crit, in `context`.
    fn dealt(&self, _type_: &str, _context: &RowContext) -> Result<Dealt, DiceError> {
        Err(DiceError::error("dealt is not provided"))
    }

    /// The builder behind `under(context)`, when the row has dice structure to roll; `None` means
    /// "sample the PMF and show a chip" (TS: absent, or `undefined`). Contract: its PMF is exactly
    /// `under(context)`.
    fn roll_under(&self, _context: &RowContext) -> Result<Option<RollUnder>, DiceError> {
        Ok(None)
    }

    /// Whether [`ContextualSource::miss_rerolled_under`] is provided.
    fn has_miss_rerolled_under(&self) -> bool {
        false
    }

    /// The row's outcome-labelled PMF over its miss branch once that miss is rolled again by
    /// `mode` in `context` (see `AttackBuilder.missRerolled`).
    fn miss_rerolled_under(
        &self,
        _context: &RowContext,
        _mode: MissRerollMode,
        _eps: f64,
    ) -> Result<Pmf, DiceError> {
        Err(DiceError::error("missRerolledUnder is not provided"))
    }

    /// `diceMatchInfo(eps)`: `(hit, crit)` match descriptors, read by a `dice-match` rider over this
    /// row. Absent (the default): `(None, None)`, "no match info".
    fn dice_match_info(&self, _eps: f64) -> Result<MatchPair, DiceError> {
        Ok((None, None))
    }

    /// `diceMatchRefusals()`: why the row has no descriptor on `(hit, crit)`. Absent: `(None, None)`.
    fn dice_match_refusals(&self) -> Result<(Option<String>, Option<String>), DiceError> {
        Ok((None, None))
    }

    /// `IGNORES_JOINED`: `under` does not roll `context.joined` riders' dice into its own roll
    /// (the library's `AttackBuilder` and `SaveBuilder`): no rider may join its row.
    fn ignores_joined(&self) -> bool {
        false
    }
}

/// `(hit, crit)` dice-match descriptors of a row; `None` where it has none.
pub type MatchPair = (
    Option<crate::common::DiceMatchInfo>,
    Option<crate::common::DiceMatchInfo>,
);

/// `rowCheckOf(source)`: the facts a source declares about its row, or `None` for a source that
/// declares none.
pub fn row_check_of(source: &Source) -> Option<RowCheck> {
    source.as_contextual().map(ContextualSource::row_check)
}

/// `isContextual(source)`: whether `source` rolls under a turn state.
pub fn is_contextual(source: &Source) -> bool {
    row_check_of(source).is_some()
}

/// `hasRerolledUnder(source)`: whether `source` says what its row rolls once a first-hit reroll is
/// spent on it (`ContextualSource.rerolledUnder`).
pub fn has_rerolled_under(source: &Source) -> bool {
    source
        .as_contextual()
        .is_some_and(ContextualSource::has_rerolled_under)
}

/// `source[IGNORES_JOINED] === true`: no rider may join its row (`Rider.joins`).
pub fn ignores_joined(source: &Source) -> bool {
    source
        .as_contextual()
        .is_some_and(ContextualSource::ignores_joined)
}

pub const MOD_ADVANTAGE: u32 = 1;
pub const MOD_DISADVANTAGE: u32 = 2;
pub const MOD_CRIT_ON_HIT: u32 = 4;
pub const MOD_VULNERABLE: u32 = 8;
pub const MOD_SAVE_DISADVANTAGE: u32 = 16;
pub const MOD_AUTO_FAIL: u32 = 32;
/// The bits of a context key above the modifiers: one per penalty-dice flag a step reads.
pub const MOD_PENALTY_SHIFT: u32 = 6;

/// Penalty dice a save takes off its d20: `count`d`sides`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PenaltyDice {
    pub count: f64,
    pub sides: f64,
}

/// TS `byDie`: the numeric comparator result (`a.sides - b.sides || a.count - b.count`).
pub fn by_die(a: &PenaltyDice, b: &PenaltyDice) -> f64 {
    let d = a.sides - b.sides;
    if d != 0.0 && !d.is_nan() {
        d
    } else {
        a.count - b.count
    }
}

fn advantage_of(r: RollType) -> i32 {
    match r {
        RollType::Flat => 0,
        RollType::Advantage => 1,
        RollType::ElvenAccuracy => 2,
        RollType::Disadvantage => -1,
    }
}

/// A row's d20 from its own roll and the advantage/disadvantage the state puts in force.
pub fn combine_roll_type(
    base: RollType,
    advantage: bool,
    disadvantage: bool,
    elven: bool,
) -> RollType {
    let own = advantage_of(base);
    let net = if advantage && elven {
        2
    } else if own > 0 {
        own
    } else if advantage {
        1
    } else {
        0
    };
    let against = disadvantage || own < 0;
    if net > 0 && against {
        return RollType::Flat;
    }
    if net == 2 {
        return RollType::ElvenAccuracy;
    }
    if net == 1 {
        return RollType::Advantage;
    }
    if against {
        RollType::Disadvantage
    } else {
        RollType::Flat
    }
}

/// The context a row with `check` rolls in when modifier key `key` is in force, with
/// `penalty_dice` (any order) taken off a save's d20. (TS default `penaltyDice = []`.)
pub fn context_of(check: &RowCheck, key: u32, penalty_dice: &[PenaltyDice]) -> RowContext {
    let save = check.kind == RowKind::Save;
    let roll_type = if check.pinned {
        check.roll_type
    } else {
        combine_roll_type(
            check.roll_type,
            !save && (key & MOD_ADVANTAGE) != 0,
            (key & MOD_DISADVANTAGE) != 0 || (save && (key & MOD_SAVE_DISADVANTAGE) != 0),
            check.advantage_dice == 3,
        )
    };
    let penalty = if save {
        let mut v = penalty_dice.to_vec();
        // JS sort: comparator result NaN/0 keeps order; stable.
        v.sort_by(|a, b| {
            by_die(a, b)
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        v
    } else {
        Vec::new()
    };
    RowContext {
        roll_type,
        auto_hit: check.auto_hit,
        crit_on_hit: check.auto_crit || (key & MOD_CRIT_ON_HIT) != 0,
        auto_fail: check.auto_fail || (save && (key & MOD_AUTO_FAIL) != 0),
        vulnerable: check.kind == RowKind::Attack && (key & MOD_VULNERABLE) != 0,
        penalty_dice: penalty,
        joined: Vec::new(),
    }
}

/// A context as a string; `joined` is JSON-encoded so `["a,b"]` and `["a","b"]` differ.
pub fn context_key(context: &RowContext) -> String {
    let dice = context
        .penalty_dice
        .iter()
        .map(|d| format!("{}d{}", num_to_string(d.count), num_to_string(d.sides)))
        .collect::<Vec<_>>()
        .join("+");
    let joined = serde_json::to_string(&context.joined).unwrap_or_default();
    [
        context.roll_type.as_str().to_string(),
        u8::from(context.auto_hit).to_string(),
        u8::from(context.crit_on_hit).to_string(),
        u8::from(context.auto_fail).to_string(),
        u8::from(context.vulnerable).to_string(),
        dice,
        joined,
    ]
    .join("|")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(kind: RowKind, rt: RollType) -> RowCheck {
        RowCheck {
            kind,
            range: None,
            ability: None,
            roll_type: rt,
            advantage_dice: 2,
            pinned: false,
            auto_hit: false,
            auto_crit: false,
            auto_fail: false,
        }
    }

    #[test]
    fn combine() {
        use RollType::*;
        assert_eq!(combine_roll_type(Flat, true, false, true), ElvenAccuracy);
        assert_eq!(
            combine_roll_type(ElvenAccuracy, false, false, false),
            ElvenAccuracy
        );
        assert_eq!(combine_roll_type(ElvenAccuracy, false, true, false), Flat);
        assert_eq!(
            combine_roll_type(Advantage, true, false, true),
            ElvenAccuracy
        );
        assert_eq!(combine_roll_type(Disadvantage, true, false, false), Flat);
        assert_eq!(
            combine_roll_type(Disadvantage, false, false, false),
            Disadvantage
        );
    }

    #[test]
    fn key_and_sort() {
        let pd = [
            PenaltyDice {
                count: 2.0,
                sides: 6.0,
            },
            PenaltyDice {
                count: 1.0,
                sides: 4.0,
            },
        ];
        let c = context_of(
            &check(RowKind::Save, RollType::Flat),
            MOD_SAVE_DISADVANTAGE,
            &pd,
        );
        assert_eq!(c.roll_type, RollType::Disadvantage);
        assert_eq!(context_key(&c), "disadvantage|0|0|0|0|1d4+2d6|[]");
        let a = context_of(
            &check(RowKind::Attack, RollType::Flat),
            MOD_ADVANTAGE | MOD_VULNERABLE,
            &pd,
        );
        assert_eq!(context_key(&a), "advantage|0|0|0|1||[]");
        let mut j = a.clone();
        j.joined = vec!["a,b".into()];
        assert_eq!(context_key(&j), "advantage|0|0|0|1||[\"a,b\"]");
    }
}
