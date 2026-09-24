/**
 * Simple LRU cache implementation
 */

let cachingEnabled = true;

/** Every cache constructed with `followsCachingToggle`, so disabling caching can empty them. */
const toggledCaches = new Set<LRUCache<unknown, unknown>>();

/**
 * Enable or disable the library's internal caches: the parse cache, the PMF convolution/power
 * cache, and the builder, die, roll, attack, save and check caches. While disabled those caches
 * store nothing and every lookup misses, and disabling empties them. Caches you construct
 * yourself are unaffected unless created with `followsCachingToggle`.
 */
export function setCachingEnabled(enabled: boolean): void {
  cachingEnabled = enabled;
  if (!enabled) for (const cache of toggledCaches) cache.clear();
}

/** Returns whether the library's internal caches are currently enabled. */
export function getCachingEnabled(): boolean {
  return cachingEnabled;
}

export interface LRUCacheOptions<V> {
  /** Called with every value as it is stored, e.g. to freeze a shared result. */
  onInsert?: (value: V) => void;
  /**
   * Store and return nothing while {@link setCachingEnabled} has turned caching off, and empty
   * this cache when it does. Meant for module-level caches: the cache stays registered for the
   * life of the process.
   */
  followsCachingToggle?: boolean;
}

export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly onInsert?: (value: V) => void;
  private readonly followsCachingToggle: boolean;

  /**
   * @param maxSize Entries kept before the least recently used is evicted. A capacity of 0 or
   *   less (or NaN) makes the cache store nothing.
   */
  constructor(
    private readonly maxSize = 1000,
    options: LRUCacheOptions<V> = {}
  ) {
    this.onInsert = options.onInsert;
    this.followsCachingToggle = options.followsCachingToggle ?? false;
    if (this.followsCachingToggle) {
      toggledCaches.add(this as LRUCache<unknown, unknown>);
    }
  }

  private get storing(): boolean {
    return this.maxSize > 0 && (cachingEnabled || !this.followsCachingToggle);
  }

  get(key: K): V | undefined {
    if (!this.storing) return undefined;
    const value = this.cache.get(key);
    if (value === undefined) return undefined;

    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  delete(key: K): void {
    this.cache.delete(key);
  }

  set(key: K, value: V): this {
    if (!this.storing) return this;
    this.onInsert?.(value);
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey as K);
    }
    this.cache.set(key, value);
    return this;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  has(key: K): boolean {
    return this.storing && this.cache.has(key);
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }
}
