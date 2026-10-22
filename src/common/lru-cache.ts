/**
 * Simple LRU cache implementation
 */

let cachingEnabled = true;

/**
 * Bumped each time caching is turned off. A cache created with `followsCachingToggle` empties
 * itself the next time it is touched after a bump, so no registry holds the caches alive.
 */
let cacheGeneration = 0;

/**
 * Enable or disable the library's internal caches: the parse cache, the PMF convolution/power
 * cache, and the builder, die, roll, attack, save and check caches. While disabled those caches
 * store nothing and every lookup misses, and disabling empties them. Caches you construct
 * yourself are unaffected unless created with `followsCachingToggle`.
 */
export function setCachingEnabled(enabled: boolean): void {
  cachingEnabled = enabled;
  if (!enabled) cacheGeneration++;
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
   * this cache when it does.
   */
  followsCachingToggle?: boolean;
}

interface Entry<V> {
  value: V;
  /** The cache's `appends` count when this entry was last put at the newest end. */
  stamp: number;
}

export class LRUCache<K, V> {
  private cache = new Map<K, Entry<V>>();
  /** Entries appended to the newest end of `cache`: by a `set` that stores, or a move on a hit. */
  private appends = 0;
  private readonly onInsert?: (value: V) => void;
  private readonly followsCachingToggle: boolean;
  private generation = cacheGeneration;

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
  }

  /** Drops the entries of a toggle-following cache when caching was turned off since last use. */
  private sync(): void {
    if (this.followsCachingToggle && this.generation !== cacheGeneration) {
      this.cache.clear();
      this.generation = cacheGeneration;
    }
  }

  private get storing(): boolean {
    this.sync();
    return this.maxSize > 0 && (cachingEnabled || !this.followsCachingToggle);
  }

  get(key: K): V | undefined {
    if (!this.storing) return undefined;
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;

    // Recency is approximate: a hit moves its entry to the newest end only once more than a quarter
    // of the capacity has been appended since it was last placed. A key read at least once every
    // `floor(maxSize / 4)` appends is therefore never evicted (for maxSize >= 8), and a hot key's
    // hits cost one lookup. Which entry is evicted may differ from strict LRU; what a lookup
    // returns never does.
    if (this.appends - entry.stamp > this.maxSize / 4) {
      this.cache.delete(key);
      entry.stamp = ++this.appends;
      this.cache.set(key, entry);
    }
    return entry.value;
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
    this.cache.set(key, { value, stamp: ++this.appends });
    return this;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    this.sync();
    return this.cache.size;
  }

  has(key: K): boolean {
    return this.storing && this.cache.has(key);
  }

  keys(): IterableIterator<K> {
    this.sync();
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    this.sync();
    const entries = this.cache.values();
    return {
      next: () => {
        const r = entries.next();
        return r.done ? r : { done: false, value: r.value.value };
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }
}
