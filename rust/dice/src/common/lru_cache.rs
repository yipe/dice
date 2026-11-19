//! Port of the toggle in `src/common/lru-cache.ts`: `setCachingEnabled` / `getCachingEnabled`.
//!
//! The global flag and the cache generation. The caches themselves are `pmf::cache::PmfCache`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static CACHING_ENABLED: AtomicBool = AtomicBool::new(true);
/// Bumped when caching is turned off: every cache that follows the toggle empties itself on its
/// next access (`cacheGeneration`).
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// `setCachingEnabled(enabled)`: while off, the caches store nothing and are emptied.
pub fn set_caching_enabled(enabled: bool) {
    CACHING_ENABLED.store(enabled, Ordering::SeqCst);
    if !enabled {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

/// The current cache generation (see [`set_caching_enabled`]).
pub fn cache_generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// Serializes the tests that flip the global flag.
#[cfg(test)]
pub static TOGGLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `getCachingEnabled()`: whether the library's internal caches are enabled (default true).
pub fn get_caching_enabled() -> bool {
    CACHING_ENABLED.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_round_trips() {
        let _guard = TOGGLE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(get_caching_enabled());
        set_caching_enabled(false);
        assert!(!get_caching_enabled());
        set_caching_enabled(true);
        assert!(get_caching_enabled());
    }
}
