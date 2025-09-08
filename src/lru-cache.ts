/**
 * Simple LRU cache implementation
 */

export class LRUCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private readonly maxSize = 1000) {}

  get(key: K): V | undefined {
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
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey as K);
    }
    this.cache.delete(key);
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
    return this.cache.has(key);
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }
}
