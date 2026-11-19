//! A damage value: a JS number used as a `Map` key.

use serde::{Deserialize, Serialize};

/// A damage value. Equality and hashing follow JS `Map` keys (SameValueZero): `-0` equals `0`
/// and NaN equals NaN. Ordering is numeric (`a - b` in a JS sort comparator).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Damage(pub f64);

impl Damage {
    fn key_bits(self) -> u64 {
        if self.0 == 0.0 {
            0
        } else if self.0.is_nan() {
            f64::NAN.to_bits()
        } else {
            self.0.to_bits()
        }
    }
}

impl PartialEq for Damage {
    fn eq(&self, other: &Self) -> bool {
        self.key_bits() == other.key_bits()
    }
}

impl Eq for Damage {}

impl std::hash::Hash for Damage {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.key_bits().hash(state);
    }
}

impl PartialOrd for Damage {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Damage {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

impl From<f64> for Damage {
    fn from(x: f64) -> Self {
        Damage(x)
    }
}

impl std::fmt::Display for Damage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::js::num_to_string(self.0))
    }
}

impl std::ops::Add for Damage {
    type Output = Damage;
    fn add(self, other: Damage) -> Damage {
        Damage(self.0 + other.0)
    }
}
