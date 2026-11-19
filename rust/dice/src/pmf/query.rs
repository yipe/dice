//! Point queries on a PMF. Port of pmf.ts: pAt (1568), hitProbability (1577),
//! missProbability (1582), cdfAt (1619), quantile (1635) with cumulative (1665), tailProbGE (2034).

use super::Pmf;
use crate::Damage;

/// `QUANTILE_RELATIVE_SLACK` in pmf.ts.
const QUANTILE_RELATIVE_SLACK: f64 = 1e-12;

impl Pmf {
    pub fn p_at(&self, x: impl Into<f64>) -> f64 {
        let x = x.into();
        self.map.get(&Damage(x)).map_or(0.0, |b| b.p)
    }

    pub fn hit_probability(&self) -> f64 {
        1.0 - self.p_at(0.0)
    }

    pub fn miss_probability(&self) -> f64 {
        self.p_at(0.0)
    }

    /// CDF at x: P(X ≤ x), summed in insertion order.
    pub fn cdf_at(&self, x: impl Into<f64>) -> f64 {
        let x = x.into();
        let mut acc = 0.0;
        for (val, bin) in &self.map {
            if val.0 <= x {
                acc += bin.p;
            }
        }
        acc
    }

    /// `tailProbGE(t)`, summed in insertion order.
    pub fn tail_prob_ge(&self, t: impl Into<f64>) -> f64 {
        let t = t.into();
        let mut s = 0.0;
        for (x, bin) in &self.map {
            if bin.p > 0.0 && x.0 >= t {
                s += bin.p;
            }
        }
        s
    }

    /// `values` ascending (sorted support), `below[i]` = Σ p over values ≤ values[i]
    /// summed from the low end, `above[i]` = Σ p over values > values[i] summed from the high end.
    fn cumulative(&self) -> (Vec<Damage>, Vec<f64>, Vec<f64>) {
        let values = self.support();
        let n = values.len();
        let mut below = vec![0.0; n];
        let mut above = vec![0.0; n];
        let mut sum = 0.0;
        for i in 0..n {
            let p = self.map.get(&values[i]).map_or(0.0, |b| b.p);
            sum += p;
            below[i] = sum;
        }
        let mut sum = 0.0;
        for i in (0..n).rev() {
            above[i] = sum;
            let p = self.map.get(&values[i]).map_or(0.0, |b| b.p);
            sum += p;
        }
        (values, below, above)
    }

    /// Returns 0 for an empty PMF or non-positive total mass, like the original.
    pub fn quantile(&self, p: impl Into<f64>) -> f64 {
        let p = p.into();
        let (values, below, above) = self.cumulative();
        let n = values.len();
        if n == 0 {
            return 0.0;
        }
        let total = below[n - 1];
        // The negation is deliberate: NaN must return 0 exactly like the TS `!(total > 0)`.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(total > 0.0) {
            return 0.0;
        }
        if p <= 0.0 {
            return values[0].0;
        }
        if p >= 1.0 {
            return values[n - 1].0;
        }

        let slack = QUANTILE_RELATIVE_SLACK.max(4.0 * n as f64 * f64::EPSILON);
        let low_target = p * total * (1.0 - slack);
        let high_target = (1.0 - p) * total * (1.0 + slack);
        let low_side = p <= 0.5;

        let mut lo = 0usize;
        let mut hi = n;
        while lo < hi {
            let mid = (lo + hi) / 2;
            let reached = if low_side {
                below[mid] >= low_target
            } else {
                above[mid] <= high_target
            };
            if reached {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        values[lo.min(n - 1)].0
    }
}
