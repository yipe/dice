//! The PMF caches of the TypeScript library (`LRUCache` in `src/common/lru-cache.ts`, `pmfCache` in
//! `pmf.ts`, the parser, builder and attack/save/DC caches), with the same capacities, keys and
//! `setCachingEnabled` toggle. Values are `Arc<Pmf>`: a hit costs a pointer clone and the Arc's
//! address is the identity of the cached result (the node facade maps it to one JS object).
//!
//! Eviction is the TS one: a hit moves its entry to the newest end only once more than a quarter of
//! the capacity has been appended since it was last placed; a full cache drops its oldest entry.
//! What a lookup returns never depends on recency.

use crate::error::DiceError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use indexmap::IndexMap;

use super::Pmf;

pub use crate::common::{get_caching_enabled as caching_enabled, set_caching_enabled};

struct Entry {
    value: Arc<Pmf>,
    stamp: u64,
}

struct State {
    map: IndexMap<String, Entry>,
    appends: u64,
    generation: u64,
}

/// `PMF.createCache(maxSize)`: an LRU of shared PMFs that follows the caching toggle.
pub struct PmfCache {
    max_size: usize,
    state: Mutex<State>,
}

impl PmfCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            max_size,
            state: Mutex::new(State {
                map: IndexMap::new(),
                appends: 0,
                generation: crate::common::lru_cache::cache_generation(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let generation = crate::common::lru_cache::cache_generation();
        if state.generation != generation {
            state.map.clear();
            state.generation = generation;
        }
        state
    }

    fn storing(&self) -> bool {
        self.max_size > 0 && caching_enabled()
    }

    pub fn get(&self, key: &str) -> Option<Arc<Pmf>> {
        if !self.storing() {
            return None;
        }
        let mut state = self.lock();
        let appends = state.appends;
        let quarter = self.max_size as f64 / 4.0;
        let (index, stale, value) = {
            let (i, _, entry) = state.map.get_full(key)?;
            (
                i,
                (appends - entry.stamp) as f64 > quarter,
                Arc::clone(&entry.value),
            )
        };
        if stale && let Some((k, mut entry)) = state.map.shift_remove_index(index) {
            state.appends += 1;
            entry.stamp = state.appends;
            state.map.insert(k, entry);
        }
        Some(value)
    }

    pub fn set(&self, key: &str, value: Arc<Pmf>) {
        if !self.storing() {
            return;
        }
        let mut state = self.lock();
        state.map.shift_remove(key);
        if state.map.len() >= self.max_size {
            state.map.shift_remove_index(0);
        }
        state.appends += 1;
        let stamp = state.appends;
        state.map.insert(key.to_string(), Entry { value, stamp });
    }

    pub fn clear(&self) {
        self.lock().map.clear();
    }

    pub fn len(&self) -> usize {
        self.lock().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// [`PmfCache::get_or_compute`] for a computation that already returns a shared PMF.
    pub fn get_or_compute_arc(
        &self,
        key: Option<&str>,
        compute: impl FnOnce() -> Result<Arc<Pmf>, DiceError>,
    ) -> Result<Arc<Pmf>, DiceError> {
        let Some(key) = key else {
            return compute();
        };
        if let Some(hit) = self.get(key) {
            return Ok(hit);
        }
        let value = compute()?;
        self.set(key, Arc::clone(&value));
        Ok(value)
    }

    /// The cached value for `key`, else `compute()` stored under it. A `None` key (an uncacheable
    /// input) computes without touching the cache.
    pub fn get_or_compute(
        &self,
        key: Option<&str>,
        compute: impl FnOnce() -> Result<Pmf, DiceError>,
    ) -> Result<Arc<Pmf>, DiceError> {
        let Some(key) = key else {
            return compute().map(Arc::new);
        };
        if let Some(hit) = self.get(key) {
            return Ok(hit);
        }
        let value = Arc::new(compute()?);
        self.set(key, Arc::clone(&value));
        Ok(value)
    }
}

static MISS_REROLLED_ENABLED: AtomicBool = AtomicBool::new(true);

/// `setMissRerolledCacheEnabled`: with `false`, `missRerolled` bypasses its cache.
pub fn set_miss_rerolled_cache_enabled(enabled: bool) {
    MISS_REROLLED_ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn miss_rerolled_cache_enabled() -> bool {
    MISS_REROLLED_ENABLED.load(Ordering::SeqCst)
}

/// `pmfCache` (pmf.ts, 1000): convolutions, powers and the d20 PMFs.
pub static PMF_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(1000));
/// `parseCache` (parser.ts, 1000).
pub static PARSE_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(1000));
/// `builderPMFCache` (factory.ts, 1000): resolved expression trees.
pub static BUILDER_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(1000));
/// `singleDiePMFCache` (ast.ts, 1000).
pub static SINGLE_DIE_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(1000));
/// `d20RollLiftCache` (ast.ts, 500).
pub static D20_LIFT_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(500));
/// `rollPMFCache` (roll.ts, 4000).
pub static ROLL_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(4000));
/// `attackPMFCache` (attack.ts, 4000).
pub static ATTACK_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(4000));
/// `missRerolledCache` (attack.ts, 4000).
pub static MISS_REROLLED_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(4000));
/// `dcPMFCache` (dc.ts, 4000).
pub static DC_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(4000));
/// `savePMFCache` (save.ts, 4000).
pub static SAVE_CACHE: LazyLock<PmfCache> = LazyLock::new(|| PmfCache::new(4000));

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EPS;

    fn pmf() -> Arc<Pmf> {
        Arc::new(Pmf::empty(EPS))
    }

    #[test]
    fn hit_returns_the_stored_arc_and_eviction_drops_the_oldest() {
        let _guard = crate::common::lru_cache::TOGGLE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cache = PmfCache::new(2);
        let (a, b, c) = (pmf(), pmf(), pmf());
        cache.set("a", Arc::clone(&a));
        cache.set("b", Arc::clone(&b));
        assert!(cache.get("a").is_some_and(|x| Arc::ptr_eq(&x, &a)));
        cache.set("c", Arc::clone(&c));
        // The hit on "a" came more than a quarter of the capacity after it was placed, so it moved
        // to the newest end and "b" is the oldest.
        assert!(cache.get("b").is_none(), "b is the oldest entry");
        assert!(cache.get("a").is_some());
        assert!(cache.get("c").is_some());
    }

    #[test]
    fn turning_caching_off_empties_and_stops_storing() {
        let _guard = crate::common::lru_cache::TOGGLE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cache = PmfCache::new(4);
        cache.set("a", pmf());
        assert_eq!(cache.len(), 1);
        set_caching_enabled(false);
        assert!(cache.get("a").is_none());
        cache.set("b", pmf());
        set_caching_enabled(true);
        assert!(
            cache.is_empty(),
            "off emptied it and nothing was stored while off"
        );
    }

    #[test]
    fn a_none_key_never_stores() {
        let cache = PmfCache::new(2);
        let v = cache.get_or_compute(None, || Ok(Pmf::empty(EPS)));
        assert!(v.is_ok());
        assert!(cache.is_empty());
    }
}
