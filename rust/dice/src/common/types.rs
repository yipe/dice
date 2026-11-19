//! The constants and helpers of `src/common/types.ts` that are not types: `critProbability`, the
//! outcome lists and `sortOutcomes`. (`RollType`, `CritConfig`, `Rng`, `MISS_NONE_OUTCOME`,
//! `DiceMatchInfo` and `HasDiceMatchInfo` are in the parent module; `EPS` is [`crate::EPS`].)

use std::cmp::Ordering;

use super::RollType;

/// `critProbability(critRange, rollType)`: P(critical hit) for the crit window and d20 roll type.
/// `crit_range` is the number of top faces that crit (1 for a natural 20, 2 for 19-20, ...).
pub fn crit_probability(crit_range: f64, roll_type: RollType) -> f64 {
    let base = crit_range / 20.0;
    match roll_type {
        RollType::Advantage => 1.0 - (1.0 - base).powf(2.0),
        RollType::ElvenAccuracy => 1.0 - (1.0 - base).powf(3.0),
        RollType::Disadvantage => base.powf(2.0),
        RollType::Flat => base,
    }
}

/// `OutcomeType`: the canonical outcome labels supported by the query helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeType {
    Crit,
    Hit,
    MissNone,
    MissDamage,
    SaveHalf,
    SaveFail,
    Pc,
}

impl OutcomeType {
    /// The TS string.
    pub fn as_str(self) -> &'static str {
        match self {
            OutcomeType::Crit => "crit",
            OutcomeType::Hit => "hit",
            OutcomeType::MissNone => "missNone",
            OutcomeType::MissDamage => "missDamage",
            OutcomeType::SaveHalf => "saveHalf",
            OutcomeType::SaveFail => "saveFail",
            OutcomeType::Pc => "pc",
        }
    }
}

/// `ALL_OUTCOME_TYPES`: every outcome type once, in canonical severity order (clean miss to crit);
/// the natural stacking order for attribution charts.
pub const ALL_OUTCOME_TYPES: [OutcomeType; 7] = [
    OutcomeType::MissNone,
    OutcomeType::MissDamage,
    OutcomeType::SaveFail,
    OutcomeType::SaveHalf,
    OutcomeType::Pc,
    OutcomeType::Hit,
    OutcomeType::Crit,
];

/// `OUTCOME_DISPLAY_ORDER`: display order for stats rows, most prominent first.
pub const OUTCOME_DISPLAY_ORDER: [OutcomeType; 7] = [
    OutcomeType::Crit,
    OutcomeType::Hit,
    OutcomeType::MissDamage,
    OutcomeType::SaveHalf,
    OutcomeType::SaveFail,
    OutcomeType::Pc,
    OutcomeType::MissNone,
];

/// `onAnyHit`.
pub const ON_ANY_HIT: [OutcomeType; 2] = [OutcomeType::Hit, OutcomeType::Crit];
/// `onCritOnly`.
pub const ON_CRIT_ONLY: [OutcomeType; 1] = [OutcomeType::Crit];
/// `onHitOnly`.
pub const ON_HIT_ONLY: [OutcomeType; 1] = [OutcomeType::Hit];
/// `onMissOnly`.
pub const ON_MISS_ONLY: [OutcomeType; 2] = [OutcomeType::MissNone, OutcomeType::MissDamage];
/// `onMissDamageOnly`.
pub const ON_MISS_DAMAGE_ONLY: [OutcomeType; 1] = [OutcomeType::MissDamage];
/// `onSaveHalfOnly`.
pub const ON_SAVE_HALF_ONLY: [OutcomeType; 1] = [OutcomeType::SaveHalf];
/// `onSaveFailOnly`.
pub const ON_SAVE_FAIL_ONLY: [OutcomeType; 1] = [OutcomeType::SaveFail];
/// `onPotentCantripOnly`.
pub const ON_POTENT_CANTRIP_ONLY: [OutcomeType; 1] = [OutcomeType::Pc];

/// The `DicePoolDescriptor` interface: one homogeneous die-type's resolved shape within a damage
/// pool: count of dice, faces per die, and the per-die `minimum`/threshold-`reroll`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DicePoolDescriptor {
    pub count: f64,
    pub faces: f64,
    pub minimum: f64,
    pub reroll: f64,
}

/// The default order of [`sort_outcomes`]: [`ALL_OUTCOME_TYPES`] as strings.
pub fn default_outcome_order() -> Vec<&'static str> {
    ALL_OUTCOME_TYPES.iter().map(|o| o.as_str()).collect()
}

/// `sortOutcomes(outcomes, order)`: sort outcome labels by a canonical order. Labels not in
/// `order` sort after known ones, alphabetically (see [`locale_compare`]).
pub fn sort_outcomes<S: AsRef<str> + Clone>(outcomes: &[S], order: &[&str]) -> Vec<S> {
    let rank = |s: &str| order.iter().position(|o| *o == s);
    let mut out = outcomes.to_vec();
    out.sort_by(|a, b| match (rank(a.as_ref()), rank(b.as_ref())) {
        (Some(ra), Some(rb)) => ra.cmp(&rb),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => locale_compare(a.as_ref(), b.as_ref()),
    });
    out
}

/// Primary collation weight of one character, after the CLDR root collation: whitespace, then
/// punctuation and symbols in CLDR's order, then digits, then letters (case-insensitive).
fn primary_weight(c: char) -> u32 {
    // CLDR root order of ASCII punctuation, symbols and the currency sign.
    const SYMBOLS: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if c.is_whitespace() {
        0
    } else if let Some(i) = SYMBOLS.chars().position(|s| s == c) {
        1 + i as u32
    } else if c.is_ascii_digit() {
        100 + (c as u32 - '0' as u32)
    } else if c.is_ascii_alphabetic() {
        200 + (c.to_ascii_lowercase() as u32 - 'a' as u32)
    } else {
        // Outside ASCII: after every ASCII letter, in code point order of the lowercase form.
        1000 + c.to_lowercase().next().map_or(c as u32, |l| l as u32)
    }
}

/// `a.localeCompare(b)` as `sortOutcomes` uses it, approximated for the default (ICU root) locale:
/// compare the strings by primary weights (punctuation < digits < letters, letters case-insensitive),
/// then break ties with lowercase before uppercase at the first differing character.
///
/// Differs from ICU for non-ASCII labels: ICU gives accented Latin letters the primary weight of
/// their base letter (`"é"` sorts with `"e"`) and orders other scripts by script; here every
/// non-ASCII character sorts after all ASCII letters by code point. Digit strings compare
/// character by character, as ICU does without numeric collation. Outcome labels are ASCII
/// identifiers, where the two agree.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = a
        .chars()
        .map(primary_weight)
        .cmp(b.chars().map(primary_weight));
    if primary != Ordering::Equal {
        return primary;
    }
    // Tertiary: lowercase before uppercase.
    for (x, y) in a.chars().zip(b.chars()) {
        if x != y {
            return match (x.is_lowercase(), y.is_lowercase()) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                _ => x.cmp(&y),
            };
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crit_windows() {
        assert_eq!(crit_probability(1.0, RollType::Flat), 0.05);
        assert!((crit_probability(1.0, RollType::Advantage) - 0.0975).abs() < 1e-12);
        assert!(
            (crit_probability(2.0, RollType::ElvenAccuracy) - (1.0 - 0.9f64.powi(3))).abs() < 1e-12
        );
        assert!((crit_probability(1.0, RollType::Disadvantage) - 0.0025).abs() < 1e-12);
    }

    #[test]
    fn known_outcomes_sort_by_severity_and_unknown_after_alphabetically() {
        let sorted = sort_outcomes(
            &["crit", "zeta", "missNone", "alpha", "hit", "Beta"],
            &default_outcome_order(),
        );
        assert_eq!(sorted, ["missNone", "hit", "crit", "alpha", "Beta", "zeta"]);
        let display: Vec<&str> = OUTCOME_DISPLAY_ORDER.iter().map(|o| o.as_str()).collect();
        let sorted = sort_outcomes(&["missNone", "crit", "hit"], &display);
        assert_eq!(sorted, ["crit", "hit", "missNone"]);
    }

    #[test]
    fn locale_compare_ascii_matches_icu() {
        // Values checked against `"a".localeCompare("b")` in node.
        assert_eq!(locale_compare("a", "B"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("A", "b"), Ordering::Less);
        assert_eq!(locale_compare("_x", "a"), Ordering::Less);
        assert_eq!(locale_compare("1", "a"), Ordering::Less);
        assert_eq!(locale_compare("a1", "a"), Ordering::Greater);
        assert_eq!(locale_compare("x", "x"), Ordering::Equal);
    }

    #[test]
    fn outcome_lists() {
        assert_eq!(ON_ANY_HIT.map(OutcomeType::as_str), ["hit", "crit"]);
        assert_eq!(
            ON_MISS_ONLY.map(OutcomeType::as_str),
            ["missNone", "missDamage"]
        );
        assert_eq!(ALL_OUTCOME_TYPES.len(), 7);
    }

    /// Every pair of these labels, as `a.localeCompare(b)` ordered them in node (ICU).
    #[test]
    fn locale_compare_matches_node_icu_on_ascii_pairs() {
        let cases: [(&str, &str, i32); 576] = [
            ("a", "a", 0),
            ("a", "B", -1),
            ("a", "A", -1),
            ("a", "_x", 1),
            ("a", "1", 1),
            ("a", "a1", -1),
            ("a", "a", 0),
            ("a", "a_b", -1),
            ("a", "a-b", -1),
            ("a", "ab", -1),
            ("a", "aB", -1),
            ("a", "Ab", -1),
            ("a", "hit", -1),
            ("a", "Hit", -1),
            ("a", "x y", -1),
            ("a", "x_y", -1),
            ("a", "$a", 1),
            ("a", ".a", 1),
            ("a", "10", 1),
            ("a", "9", 1),
            ("a", "zeta", -1),
            ("a", "Zeta", -1),
            ("a", "a.b", -1),
            ("a", "a b", -1),
            ("B", "a", 1),
            ("B", "B", 0),
            ("B", "A", 1),
            ("B", "_x", 1),
            ("B", "1", 1),
            ("B", "a1", 1),
            ("B", "a", 1),
            ("B", "a_b", 1),
            ("B", "a-b", 1),
            ("B", "ab", 1),
            ("B", "aB", 1),
            ("B", "Ab", 1),
            ("B", "hit", -1),
            ("B", "Hit", -1),
            ("B", "x y", -1),
            ("B", "x_y", -1),
            ("B", "$a", 1),
            ("B", ".a", 1),
            ("B", "10", 1),
            ("B", "9", 1),
            ("B", "zeta", -1),
            ("B", "Zeta", -1),
            ("B", "a.b", 1),
            ("B", "a b", 1),
            ("A", "a", 1),
            ("A", "B", -1),
            ("A", "A", 0),
            ("A", "_x", 1),
            ("A", "1", 1),
            ("A", "a1", -1),
            ("A", "a", 1),
            ("A", "a_b", -1),
            ("A", "a-b", -1),
            ("A", "ab", -1),
            ("A", "aB", -1),
            ("A", "Ab", -1),
            ("A", "hit", -1),
            ("A", "Hit", -1),
            ("A", "x y", -1),
            ("A", "x_y", -1),
            ("A", "$a", 1),
            ("A", ".a", 1),
            ("A", "10", 1),
            ("A", "9", 1),
            ("A", "zeta", -1),
            ("A", "Zeta", -1),
            ("A", "a.b", -1),
            ("A", "a b", -1),
            ("_x", "a", -1),
            ("_x", "B", -1),
            ("_x", "A", -1),
            ("_x", "_x", 0),
            ("_x", "1", -1),
            ("_x", "a1", -1),
            ("_x", "a", -1),
            ("_x", "a_b", -1),
            ("_x", "a-b", -1),
            ("_x", "ab", -1),
            ("_x", "aB", -1),
            ("_x", "Ab", -1),
            ("_x", "hit", -1),
            ("_x", "Hit", -1),
            ("_x", "x y", -1),
            ("_x", "x_y", -1),
            ("_x", "$a", -1),
            ("_x", ".a", -1),
            ("_x", "10", -1),
            ("_x", "9", -1),
            ("_x", "zeta", -1),
            ("_x", "Zeta", -1),
            ("_x", "a.b", -1),
            ("_x", "a b", -1),
            ("1", "a", -1),
            ("1", "B", -1),
            ("1", "A", -1),
            ("1", "_x", 1),
            ("1", "1", 0),
            ("1", "a1", -1),
            ("1", "a", -1),
            ("1", "a_b", -1),
            ("1", "a-b", -1),
            ("1", "ab", -1),
            ("1", "aB", -1),
            ("1", "Ab", -1),
            ("1", "hit", -1),
            ("1", "Hit", -1),
            ("1", "x y", -1),
            ("1", "x_y", -1),
            ("1", "$a", 1),
            ("1", ".a", 1),
            ("1", "10", -1),
            ("1", "9", -1),
            ("1", "zeta", -1),
            ("1", "Zeta", -1),
            ("1", "a.b", -1),
            ("1", "a b", -1),
            ("a1", "a", 1),
            ("a1", "B", -1),
            ("a1", "A", 1),
            ("a1", "_x", 1),
            ("a1", "1", 1),
            ("a1", "a1", 0),
            ("a1", "a", 1),
            ("a1", "a_b", 1),
            ("a1", "a-b", 1),
            ("a1", "ab", -1),
            ("a1", "aB", -1),
            ("a1", "Ab", -1),
            ("a1", "hit", -1),
            ("a1", "Hit", -1),
            ("a1", "x y", -1),
            ("a1", "x_y", -1),
            ("a1", "$a", 1),
            ("a1", ".a", 1),
            ("a1", "10", 1),
            ("a1", "9", 1),
            ("a1", "zeta", -1),
            ("a1", "Zeta", -1),
            ("a1", "a.b", 1),
            ("a1", "a b", 1),
            ("a", "a", 0),
            ("a", "B", -1),
            ("a", "A", -1),
            ("a", "_x", 1),
            ("a", "1", 1),
            ("a", "a1", -1),
            ("a", "a", 0),
            ("a", "a_b", -1),
            ("a", "a-b", -1),
            ("a", "ab", -1),
            ("a", "aB", -1),
            ("a", "Ab", -1),
            ("a", "hit", -1),
            ("a", "Hit", -1),
            ("a", "x y", -1),
            ("a", "x_y", -1),
            ("a", "$a", 1),
            ("a", ".a", 1),
            ("a", "10", 1),
            ("a", "9", 1),
            ("a", "zeta", -1),
            ("a", "Zeta", -1),
            ("a", "a.b", -1),
            ("a", "a b", -1),
            ("a_b", "a", 1),
            ("a_b", "B", -1),
            ("a_b", "A", 1),
            ("a_b", "_x", 1),
            ("a_b", "1", 1),
            ("a_b", "a1", -1),
            ("a_b", "a", 1),
            ("a_b", "a_b", 0),
            ("a_b", "a-b", -1),
            ("a_b", "ab", -1),
            ("a_b", "aB", -1),
            ("a_b", "Ab", -1),
            ("a_b", "hit", -1),
            ("a_b", "Hit", -1),
            ("a_b", "x y", -1),
            ("a_b", "x_y", -1),
            ("a_b", "$a", 1),
            ("a_b", ".a", 1),
            ("a_b", "10", 1),
            ("a_b", "9", 1),
            ("a_b", "zeta", -1),
            ("a_b", "Zeta", -1),
            ("a_b", "a.b", -1),
            ("a_b", "a b", 1),
            ("a-b", "a", 1),
            ("a-b", "B", -1),
            ("a-b", "A", 1),
            ("a-b", "_x", 1),
            ("a-b", "1", 1),
            ("a-b", "a1", -1),
            ("a-b", "a", 1),
            ("a-b", "a_b", 1),
            ("a-b", "a-b", 0),
            ("a-b", "ab", -1),
            ("a-b", "aB", -1),
            ("a-b", "Ab", -1),
            ("a-b", "hit", -1),
            ("a-b", "Hit", -1),
            ("a-b", "x y", -1),
            ("a-b", "x_y", -1),
            ("a-b", "$a", 1),
            ("a-b", ".a", 1),
            ("a-b", "10", 1),
            ("a-b", "9", 1),
            ("a-b", "zeta", -1),
            ("a-b", "Zeta", -1),
            ("a-b", "a.b", -1),
            ("a-b", "a b", 1),
            ("ab", "a", 1),
            ("ab", "B", -1),
            ("ab", "A", 1),
            ("ab", "_x", 1),
            ("ab", "1", 1),
            ("ab", "a1", 1),
            ("ab", "a", 1),
            ("ab", "a_b", 1),
            ("ab", "a-b", 1),
            ("ab", "ab", 0),
            ("ab", "aB", -1),
            ("ab", "Ab", -1),
            ("ab", "hit", -1),
            ("ab", "Hit", -1),
            ("ab", "x y", -1),
            ("ab", "x_y", -1),
            ("ab", "$a", 1),
            ("ab", ".a", 1),
            ("ab", "10", 1),
            ("ab", "9", 1),
            ("ab", "zeta", -1),
            ("ab", "Zeta", -1),
            ("ab", "a.b", 1),
            ("ab", "a b", 1),
            ("aB", "a", 1),
            ("aB", "B", -1),
            ("aB", "A", 1),
            ("aB", "_x", 1),
            ("aB", "1", 1),
            ("aB", "a1", 1),
            ("aB", "a", 1),
            ("aB", "a_b", 1),
            ("aB", "a-b", 1),
            ("aB", "ab", 1),
            ("aB", "aB", 0),
            ("aB", "Ab", -1),
            ("aB", "hit", -1),
            ("aB", "Hit", -1),
            ("aB", "x y", -1),
            ("aB", "x_y", -1),
            ("aB", "$a", 1),
            ("aB", ".a", 1),
            ("aB", "10", 1),
            ("aB", "9", 1),
            ("aB", "zeta", -1),
            ("aB", "Zeta", -1),
            ("aB", "a.b", 1),
            ("aB", "a b", 1),
            ("Ab", "a", 1),
            ("Ab", "B", -1),
            ("Ab", "A", 1),
            ("Ab", "_x", 1),
            ("Ab", "1", 1),
            ("Ab", "a1", 1),
            ("Ab", "a", 1),
            ("Ab", "a_b", 1),
            ("Ab", "a-b", 1),
            ("Ab", "ab", 1),
            ("Ab", "aB", 1),
            ("Ab", "Ab", 0),
            ("Ab", "hit", -1),
            ("Ab", "Hit", -1),
            ("Ab", "x y", -1),
            ("Ab", "x_y", -1),
            ("Ab", "$a", 1),
            ("Ab", ".a", 1),
            ("Ab", "10", 1),
            ("Ab", "9", 1),
            ("Ab", "zeta", -1),
            ("Ab", "Zeta", -1),
            ("Ab", "a.b", 1),
            ("Ab", "a b", 1),
            ("hit", "a", 1),
            ("hit", "B", 1),
            ("hit", "A", 1),
            ("hit", "_x", 1),
            ("hit", "1", 1),
            ("hit", "a1", 1),
            ("hit", "a", 1),
            ("hit", "a_b", 1),
            ("hit", "a-b", 1),
            ("hit", "ab", 1),
            ("hit", "aB", 1),
            ("hit", "Ab", 1),
            ("hit", "hit", 0),
            ("hit", "Hit", -1),
            ("hit", "x y", -1),
            ("hit", "x_y", -1),
            ("hit", "$a", 1),
            ("hit", ".a", 1),
            ("hit", "10", 1),
            ("hit", "9", 1),
            ("hit", "zeta", -1),
            ("hit", "Zeta", -1),
            ("hit", "a.b", 1),
            ("hit", "a b", 1),
            ("Hit", "a", 1),
            ("Hit", "B", 1),
            ("Hit", "A", 1),
            ("Hit", "_x", 1),
            ("Hit", "1", 1),
            ("Hit", "a1", 1),
            ("Hit", "a", 1),
            ("Hit", "a_b", 1),
            ("Hit", "a-b", 1),
            ("Hit", "ab", 1),
            ("Hit", "aB", 1),
            ("Hit", "Ab", 1),
            ("Hit", "hit", 1),
            ("Hit", "Hit", 0),
            ("Hit", "x y", -1),
            ("Hit", "x_y", -1),
            ("Hit", "$a", 1),
            ("Hit", ".a", 1),
            ("Hit", "10", 1),
            ("Hit", "9", 1),
            ("Hit", "zeta", -1),
            ("Hit", "Zeta", -1),
            ("Hit", "a.b", 1),
            ("Hit", "a b", 1),
            ("x y", "a", 1),
            ("x y", "B", 1),
            ("x y", "A", 1),
            ("x y", "_x", 1),
            ("x y", "1", 1),
            ("x y", "a1", 1),
            ("x y", "a", 1),
            ("x y", "a_b", 1),
            ("x y", "a-b", 1),
            ("x y", "ab", 1),
            ("x y", "aB", 1),
            ("x y", "Ab", 1),
            ("x y", "hit", 1),
            ("x y", "Hit", 1),
            ("x y", "x y", 0),
            ("x y", "x_y", -1),
            ("x y", "$a", 1),
            ("x y", ".a", 1),
            ("x y", "10", 1),
            ("x y", "9", 1),
            ("x y", "zeta", -1),
            ("x y", "Zeta", -1),
            ("x y", "a.b", 1),
            ("x y", "a b", 1),
            ("x_y", "a", 1),
            ("x_y", "B", 1),
            ("x_y", "A", 1),
            ("x_y", "_x", 1),
            ("x_y", "1", 1),
            ("x_y", "a1", 1),
            ("x_y", "a", 1),
            ("x_y", "a_b", 1),
            ("x_y", "a-b", 1),
            ("x_y", "ab", 1),
            ("x_y", "aB", 1),
            ("x_y", "Ab", 1),
            ("x_y", "hit", 1),
            ("x_y", "Hit", 1),
            ("x_y", "x y", 1),
            ("x_y", "x_y", 0),
            ("x_y", "$a", 1),
            ("x_y", ".a", 1),
            ("x_y", "10", 1),
            ("x_y", "9", 1),
            ("x_y", "zeta", -1),
            ("x_y", "Zeta", -1),
            ("x_y", "a.b", 1),
            ("x_y", "a b", 1),
            ("$a", "a", -1),
            ("$a", "B", -1),
            ("$a", "A", -1),
            ("$a", "_x", 1),
            ("$a", "1", -1),
            ("$a", "a1", -1),
            ("$a", "a", -1),
            ("$a", "a_b", -1),
            ("$a", "a-b", -1),
            ("$a", "ab", -1),
            ("$a", "aB", -1),
            ("$a", "Ab", -1),
            ("$a", "hit", -1),
            ("$a", "Hit", -1),
            ("$a", "x y", -1),
            ("$a", "x_y", -1),
            ("$a", "$a", 0),
            ("$a", ".a", 1),
            ("$a", "10", -1),
            ("$a", "9", -1),
            ("$a", "zeta", -1),
            ("$a", "Zeta", -1),
            ("$a", "a.b", -1),
            ("$a", "a b", -1),
            (".a", "a", -1),
            (".a", "B", -1),
            (".a", "A", -1),
            (".a", "_x", 1),
            (".a", "1", -1),
            (".a", "a1", -1),
            (".a", "a", -1),
            (".a", "a_b", -1),
            (".a", "a-b", -1),
            (".a", "ab", -1),
            (".a", "aB", -1),
            (".a", "Ab", -1),
            (".a", "hit", -1),
            (".a", "Hit", -1),
            (".a", "x y", -1),
            (".a", "x_y", -1),
            (".a", "$a", -1),
            (".a", ".a", 0),
            (".a", "10", -1),
            (".a", "9", -1),
            (".a", "zeta", -1),
            (".a", "Zeta", -1),
            (".a", "a.b", -1),
            (".a", "a b", -1),
            ("10", "a", -1),
            ("10", "B", -1),
            ("10", "A", -1),
            ("10", "_x", 1),
            ("10", "1", 1),
            ("10", "a1", -1),
            ("10", "a", -1),
            ("10", "a_b", -1),
            ("10", "a-b", -1),
            ("10", "ab", -1),
            ("10", "aB", -1),
            ("10", "Ab", -1),
            ("10", "hit", -1),
            ("10", "Hit", -1),
            ("10", "x y", -1),
            ("10", "x_y", -1),
            ("10", "$a", 1),
            ("10", ".a", 1),
            ("10", "10", 0),
            ("10", "9", -1),
            ("10", "zeta", -1),
            ("10", "Zeta", -1),
            ("10", "a.b", -1),
            ("10", "a b", -1),
            ("9", "a", -1),
            ("9", "B", -1),
            ("9", "A", -1),
            ("9", "_x", 1),
            ("9", "1", 1),
            ("9", "a1", -1),
            ("9", "a", -1),
            ("9", "a_b", -1),
            ("9", "a-b", -1),
            ("9", "ab", -1),
            ("9", "aB", -1),
            ("9", "Ab", -1),
            ("9", "hit", -1),
            ("9", "Hit", -1),
            ("9", "x y", -1),
            ("9", "x_y", -1),
            ("9", "$a", 1),
            ("9", ".a", 1),
            ("9", "10", 1),
            ("9", "9", 0),
            ("9", "zeta", -1),
            ("9", "Zeta", -1),
            ("9", "a.b", -1),
            ("9", "a b", -1),
            ("zeta", "a", 1),
            ("zeta", "B", 1),
            ("zeta", "A", 1),
            ("zeta", "_x", 1),
            ("zeta", "1", 1),
            ("zeta", "a1", 1),
            ("zeta", "a", 1),
            ("zeta", "a_b", 1),
            ("zeta", "a-b", 1),
            ("zeta", "ab", 1),
            ("zeta", "aB", 1),
            ("zeta", "Ab", 1),
            ("zeta", "hit", 1),
            ("zeta", "Hit", 1),
            ("zeta", "x y", 1),
            ("zeta", "x_y", 1),
            ("zeta", "$a", 1),
            ("zeta", ".a", 1),
            ("zeta", "10", 1),
            ("zeta", "9", 1),
            ("zeta", "zeta", 0),
            ("zeta", "Zeta", -1),
            ("zeta", "a.b", 1),
            ("zeta", "a b", 1),
            ("Zeta", "a", 1),
            ("Zeta", "B", 1),
            ("Zeta", "A", 1),
            ("Zeta", "_x", 1),
            ("Zeta", "1", 1),
            ("Zeta", "a1", 1),
            ("Zeta", "a", 1),
            ("Zeta", "a_b", 1),
            ("Zeta", "a-b", 1),
            ("Zeta", "ab", 1),
            ("Zeta", "aB", 1),
            ("Zeta", "Ab", 1),
            ("Zeta", "hit", 1),
            ("Zeta", "Hit", 1),
            ("Zeta", "x y", 1),
            ("Zeta", "x_y", 1),
            ("Zeta", "$a", 1),
            ("Zeta", ".a", 1),
            ("Zeta", "10", 1),
            ("Zeta", "9", 1),
            ("Zeta", "zeta", 1),
            ("Zeta", "Zeta", 0),
            ("Zeta", "a.b", 1),
            ("Zeta", "a b", 1),
            ("a.b", "a", 1),
            ("a.b", "B", -1),
            ("a.b", "A", 1),
            ("a.b", "_x", 1),
            ("a.b", "1", 1),
            ("a.b", "a1", -1),
            ("a.b", "a", 1),
            ("a.b", "a_b", 1),
            ("a.b", "a-b", 1),
            ("a.b", "ab", -1),
            ("a.b", "aB", -1),
            ("a.b", "Ab", -1),
            ("a.b", "hit", -1),
            ("a.b", "Hit", -1),
            ("a.b", "x y", -1),
            ("a.b", "x_y", -1),
            ("a.b", "$a", 1),
            ("a.b", ".a", 1),
            ("a.b", "10", 1),
            ("a.b", "9", 1),
            ("a.b", "zeta", -1),
            ("a.b", "Zeta", -1),
            ("a.b", "a.b", 0),
            ("a.b", "a b", 1),
            ("a b", "a", 1),
            ("a b", "B", -1),
            ("a b", "A", 1),
            ("a b", "_x", 1),
            ("a b", "1", 1),
            ("a b", "a1", -1),
            ("a b", "a", 1),
            ("a b", "a_b", -1),
            ("a b", "a-b", -1),
            ("a b", "ab", -1),
            ("a b", "aB", -1),
            ("a b", "Ab", -1),
            ("a b", "hit", -1),
            ("a b", "Hit", -1),
            ("a b", "x y", -1),
            ("a b", "x_y", -1),
            ("a b", "$a", 1),
            ("a b", ".a", 1),
            ("a b", "10", 1),
            ("a b", "9", 1),
            ("a b", "zeta", -1),
            ("a b", "Zeta", -1),
            ("a b", "a.b", -1),
            ("a b", "a b", 0),
        ];
        for (a, b, want) in cases {
            let got = match locale_compare(a, b) {
                Ordering::Less => -1,
                Ordering::Equal => 0,
                Ordering::Greater => 1,
            };
            assert_eq!(got, want, "{a:?} vs {b:?}");
        }
    }
}
