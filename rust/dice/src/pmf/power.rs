//! Port of pmf.ts: power (571) and maxOfTwo (1015).

use crate::error::DiceError;
use indexmap::IndexMap;

use std::sync::Arc;

use super::Pmf;
use super::cache::PMF_CACHE;
use super::transform::scale_bin;
use crate::js::num_to_string;

impl Pmf {
    /// `power(n, eps)`; `eps` None means `self.epsilon`. No cache.
    ///
    /// Convolves this PMF with itself `n` times by exponentiation by squaring;
    /// `n` must be a positive integer. Folds `n` independent, identical attacks
    /// into one PMF, so it loses data provenance — safe for mass computation
    /// only; use a `DiceQuery` for `atLeast`-style queries.
    pub fn power(&self, n: f64, eps: Option<f64>) -> Result<Pmf, DiceError> {
        if n == 1.0 {
            return Ok(self.clone());
        }
        self.power_shared(n, eps).map(|p| (*p).clone())
    }

    /// [`Pmf::power`] through `pmfCache`, keyed `pow{n}@{eps}|{fingerprint of the normalized base}`.
    pub fn power_shared(&self, n: f64, eps: Option<f64>) -> Result<Arc<Pmf>, DiceError> {
        if n.fract() != 0.0 || !n.is_finite() || n <= 0.0 {
            return Err(DiceError::error("power(n): n must be a positive integer"));
        }
        if n == 1.0 {
            return Ok(Arc::new(self.clone()));
        }

        let epsilon = eps.unwrap_or(self.epsilon);
        let mut base = if self.normalized {
            self.clone()
        } else {
            self.normalize()
        };
        let key = format!(
            "pow{}@{}|{}",
            num_to_string(n),
            num_to_string(epsilon),
            base.fingerprint_ref()
        );
        if let Some(hit) = PMF_CACHE.get(&key) {
            return Ok(hit);
        }

        // Start from the base PMF and accumulate n-1 additional powers.
        let mut result = base.clone();
        let mut exp = n as u64 - 1;

        while exp > 0 {
            if exp & 1 == 1 {
                result = result.convolve(&base, Some(epsilon), false);
            }
            exp >>= 1;
            if exp > 0 {
                base = base.convolve(&base, Some(epsilon), false);
            }
        }

        let folded = Arc::new(Pmf::new(result.map, result.epsilon, result.normalized));
        PMF_CACHE.set(&key, Arc::clone(&folded));
        Ok(folded)
    }

    /// `maxOfTwo`: max of two independent draws from this PMF.
    ///
    /// PRESERVES outcome labels and attribution: the winning value was drawn
    /// from this same distribution, so each bin keeps its `count`/`attr`
    /// composition — only the mass is recomputed via the squared-CDF step and
    /// every label rescaled by the same factor.
    ///
    /// Works on a non-unit-mass slice (e.g. `filterOutcome`'s output): the CDF
    /// is squared on the NORMALIZED distribution, then the result is rescaled
    /// back to this PMF's original total mass, not to 1.
    pub fn max_of_two(&self) -> Pmf {
        let total_mass = self.mass();
        if total_mass <= 0.0 {
            return self.clone();
        }

        let mut result_map = IndexMap::new();
        let mut cdf = 0.0; // running NORMALIZED cdf through the previous support value

        for damage in self.support() {
            let Some(bin) = self.map.get(&damage) else {
                continue;
            };
            let normalized_p = bin.p / total_mass;
            if normalized_p <= 0.0 {
                continue;
            }

            let prev_cdf = cdf;
            cdf += normalized_p;

            // P(max = damage), normalized: F(damage)^2 - F(damage^-)^2,
            // factored as p*(F(damage) + F(damage^-)). The difference of
            // squares near 1 would cancel the tail bins away; the factored
            // form keeps full precision.
            // It also is the scale factor from the original bin to the new one:
            // reusing the bin's count/attr via scale_bin (rather than rebuilding
            // from a bare number) is what keeps every label's proportion intact.
            result_map.insert(damage, scale_bin(bin, cdf + prev_cdf));
        }

        Pmf::new(result_map, self.epsilon, self.normalized)
    }
}
