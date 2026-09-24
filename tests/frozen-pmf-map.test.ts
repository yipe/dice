import { describe, expect, it } from "vitest";
import { d20, d6, roll } from "../src/builder";
import type { Bin } from "../src/index";
import { PMF } from "../src/index";

describe("a cached PMF's map cannot be changed", () => {
  it("set, delete and clear throw on a cached die and leave it intact", () => {
    const die = roll(1, d6).toPMF();
    const map = die.map as Map<number, Bin>;
    const six = map.get(6) as Bin;
    expect(() => map.set(6, { ...six, p: 0.5 })).toThrow(TypeError);
    expect(() => map.delete(1)).toThrow(TypeError);
    expect(() => map.clear()).toThrow(TypeError);
    expect(die.support()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(roll(1, d6).toPMF().pAt(1)).toBe(1 / 6);
  });

  it("the map property cannot be replaced", () => {
    const die = roll(1, d6).toPMF();
    expect(() => {
      (die as { map: ReadonlyMap<number, Bin> }).map = new Map();
    }).toThrow(TypeError);
    expect(die.map.size).toBe(6);
  });

  it("a refused mutation leaves every later roll exact", () => {
    const die = roll(1, d6).toPMF();
    const map = die.map as Map<number, Bin>;
    try {
      map.set(6, { ...(map.get(6) as Bin), p: 0.5 });
    } catch {
      // refused
    }
    try {
      map.delete(1);
    } catch {
      // refused
    }
    expect(roll(3, d6).toPMF().mean()).toBeCloseTo(21 / 2, 12);
    expect(roll(2, d6).plus(1).toPMF().mean()).toBeCloseTo(8, 12);
    expect(d20.plus(5).ac(15).onHit(roll(1, d6)).toPMF().mean()).toBeCloseTo(21 / 10, 12);
  });

  it("a frozen map still reads like a Map", () => {
    const die = roll(1, d6).toPMF();
    expect(die.map instanceof Map).toBe(true);
    expect([...die.map.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    const copy = new Map(die.map);
    copy.set(7, { p: 0, count: {} });
    expect(copy.size).toBe(7);
    expect(die.map.size).toBe(6);
  });

  it("an unfrozen PMF keeps its own map until it is frozen", () => {
    const map = new Map<number, Bin>([[1, { p: 1, count: { hit: 1 } }]]);
    const pmf = new PMF(map, 1e-12, true, "unfrozen");
    expect(pmf.map).toBe(map);
    expect(pmf.freeze()).toBe(pmf);
    expect(() => (pmf.map as Map<number, Bin>).set(2, { p: 1, count: {} })).toThrow(TypeError);
    // The caller's own Map is not locked by freezing a PMF built on it.
    map.set(2, { p: 0, count: {} });
    expect(pmf.map.size).toBe(1);
    expect(pmf.pAt(1)).toBe(1);
  });
});
