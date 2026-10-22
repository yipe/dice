import { afterEach, describe, expect, it } from "vitest";
import { LRUCache, setCachingEnabled } from "./lru-cache";

afterEach(() => setCachingEnabled(true));

describe("LRUCache hit path", () => {
  it("never evicts a key read at least once every floor(maxSize / 4) appends", () => {
    for (const maxSize of [8, 9, 10, 16, 33, 100]) {
      const cache = new LRUCache<number, number>(maxSize);
      const gap = Math.floor(maxSize / 4);
      cache.set(-1, -1);
      for (let i = 0; i < maxSize * 20; i++) {
        cache.set(i, i);
        if (i % gap === gap - 1) expect(cache.get(-1)).toBe(-1);
      }
      expect(cache.has(-1)).toBe(true);
      expect(cache.size).toBe(maxSize);
    }
  });

  it("still evicts keys that are never read", () => {
    const cache = new LRUCache<number, number>(8);
    for (let i = 0; i < 20; i++) cache.set(i, i);
    expect(cache.size).toBe(8);
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(19)).toBe(19);
  });

  it("stores nothing at capacity 0 or NaN", () => {
    for (const size of [0, -1, NaN]) {
      const cache = new LRUCache<string, number>(size);
      cache.set("a", 1);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.has("a")).toBe(false);
      expect(cache.size).toBe(0);
    }
  });

  it("empties a toggle-following cache when caching is turned off", () => {
    const cache = new LRUCache<string, number>(8, { followsCachingToggle: true });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    setCachingEnabled(false);
    expect(cache.get("a")).toBeUndefined();
    cache.set("b", 2);
    expect(cache.size).toBe(0);
    setCachingEnabled(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("returns the stored objects from get, values and keys", () => {
    const a = { n: 1 };
    const b = { n: 2 };
    const cache = new LRUCache<string, object>(16);
    cache.set("a", a).set("b", b);
    expect(cache.get("a")).toBe(a);
    const values = [...cache.values()];
    expect(values[0]).toBe(a);
    expect(values[1]).toBe(b);
    expect([...cache.keys()]).toEqual(["a", "b"]);
  });

  it("onInsert sees the stored value", () => {
    const seen: object[] = [];
    const cache = new LRUCache<string, object>(8, { onInsert: (v) => seen.push(v) });
    const v = {};
    cache.set("a", v);
    expect(seen[0]).toBe(v);
  });

  it("delete then set behaves like a fresh insert", () => {
    const cache = new LRUCache<number, number>(8);
    for (let i = 0; i < 8; i++) cache.set(i, i);
    for (let i = 0; i < 6; i++) cache.get(0);
    cache.delete(0);
    expect(cache.has(0)).toBe(false);
    cache.set(0, 100);
    expect(cache.get(0)).toBe(100);
    // 0 is now the newest entry: the next eight inserts evict 1..7 before it.
    for (let i = 8; i < 15; i++) cache.set(i, i);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(cache.size).toBe(8);
  });

  it("clear drops entries and later reads behave normally", () => {
    const cache = new LRUCache<number, number>(8);
    for (let i = 0; i < 8; i++) cache.set(i, i);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(3)).toBeUndefined();
    cache.set(3, 9);
    expect(cache.get(3)).toBe(9);
  });
});
