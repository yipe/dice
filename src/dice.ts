// dice.ts (internal)

import { PMF } from "./pmf";
import type { Bin, OutcomeLabelMap, OutcomeType, DamageDistribution } from "./types";
import { EPS } from "./types";

/**
 * @internal
 */
export class Dice {
  private pmf: PMF;
  public privateData: Record<string, any> = {};
  private hasHitDistributionCalculated = false;
  public identifier?: string;
  // Track explicit outcome presence and cached distributions for API parity
  private outcomePresence: Set<OutcomeType> = new Set();
  private outcomeCache: Partial<Record<OutcomeType, DamageDistribution>> = {};

  constructor(x: number = 0) {
    const map = new Map<number, Bin>();
    if (x > 0) {
      for (let i = 1; i <= x; i++) map.set(i, { p: 1, count: {} });
    }
    this.pmf = new PMF(map, EPS, false, "dice");
  }

  // Outcome distribution API implemented on top of internal PMF bin.count
  getOutcomeDistribution(key: OutcomeType): DamageDistribution | undefined {
    if (key === "hit") this.ensureHitDistribution();
    // Return cached object if available (ensures identity for 'hit')
    if (this.outcomeCache[key] !== undefined) return this.outcomeCache[key];

    const out: DamageDistribution = {} as any;
    let has = false;
    for (const [face, bin] of this.pmf.map) {
      const v = (bin.count[key] as number) ?? 0;
      if (v !== 0) {
        out[face] = v;
        has = true;
      }
    }
    if (!has) return this.outcomePresence.has(key) ? ({} as any) : undefined;
    return out;
  }

  getFullOutcomeDistribution(): Record<OutcomeType, DamageDistribution | undefined> {
    const read = (k: OutcomeType): DamageDistribution | undefined => {
      if (k === "hit") return this.outcomeCache["hit"]; // don't auto-compute
      // if explicitly set but empty, return {}
      if (this.outcomePresence.has(k) && this.outcomeCache[k] === undefined) {
        // not cached but presence recorded (empty object)
        return {} as any;
      }
      // derive without caching
      const out: DamageDistribution = {} as any;
      let has = false;
      for (const [face, bin] of this.pmf.map) {
        const v = (bin.count[k] as number) ?? 0;
        if (v !== 0) {
          out[face] = v;
          has = true;
        }
      }
      return has ? out : undefined;
    };
    return {
      crit: read("crit"),
      hit: read("hit"),
      missNone: read("missNone"),
      missDamage: read("missDamage"),
      saveHalf: read("saveHalf"),
      saveFail: read("saveFail"),
      pc: read("pc"),
    } as any;
  }

  setOutcomeDistribution(key: OutcomeType, data: DamageDistribution | undefined): void {
    // Mutate internal PMF bin.count for the given outcome
    // If undefined, remove the key
    if (data === undefined) {
      for (const [, bin] of this.pmf.map) {
        if (bin.count && key in bin.count) delete bin.count[key];
      }
      delete this.outcomeCache[key];
      this.outcomePresence.delete(key);
      if (key === "hit") this.hasHitDistributionCalculated = false;
      return;
    }

    // Apply counts to bins (raw counts; parser will normalize at the end)
    this.outcomePresence.add(key);
    this.outcomeCache[key] = data;
    for (const [kStr, v] of Object.entries(data)) {
      const face = Number(kStr);
      const bin = this.pmf.map.get(face) || { p: 0, count: {} };
      bin.count[key] = v;
      this.pmf.map.set(face, bin);
    }
    if (key === "hit") this.hasHitDistributionCalculated = true;
  }

  hasOutcomeData(key: OutcomeType): boolean {
    if (key === "hit") this.ensureHitDistribution();
    for (const [, bin] of this.pmf.map) {
      const v = (bin.count[key] as number) ?? 0;
      if (v !== 0) return true;
    }
    return false;
  }

  getOutcomeCount(key: OutcomeType, face: number): number {
    return (this.pmf.map.get(face)?.count[key] as number) ?? 0;
  }

  getAverage(key: OutcomeType): number {
    const dist = this.getOutcomeDistribution(key);
    if (!dist) return 0;
    const total = Object.values(dist).reduce((s, c) => s + c, 0);
    if (total === 0) return 0;
    let sum = 0;
    for (const [k, c] of Object.entries(dist)) sum += Number(k) * (c as number);
    return sum / total;
  }

  // TODO this can be private later if we change how testing works
  calculateHitDistribution(): DamageDistribution {
    const hitValues: DamageDistribution = {} as any;
    for (const [face, bin] of this.pmf.map) {
      let hitCount = bin.p;
      const subtractLabels: OutcomeType[] = [
        "crit",
        "missNone",
        "missDamage",
        "saveHalf",
        "saveFail",
        "pc",
      ];
      for (const outcomeType of subtractLabels) {
        const v = (bin.count[outcomeType] as number) ?? 0;
        if (v) hitCount -= v;
      }
      if (face === 0) hitCount = 0;
      if (hitCount < 0) hitCount = 0;
      hitValues[face] = hitCount;
    }
    return hitValues;
  }

  private ensureHitDistribution(): void {
    if (!this.hasHitDistributionCalculated) {
      const hitValues = this.calculateHitDistribution();
      // Cache and apply counts without clearing existing presence
      this.outcomePresence.add("hit");
      this.outcomeCache["hit"] = hitValues;
      for (const [kStr, v] of Object.entries(hitValues)) {
        const face = Number(kStr);
        const bin = this.pmf.map.get(face) || { p: 0, count: {} };
        bin.count["hit"] = v as number;
        this.pmf.map.set(face, bin);
      }
      this.hasHitDistributionCalculated = true;
    }
  }

  // PRIVATE FUNCTIONS

  private binaryOp(
    other: Dice | number,
    op: (a: number, b: number) => number,
    diceConstructor?: () => Dice
  ): Dice {
    const result = diceConstructor ? diceConstructor() : new Dice();

    const isScalar = typeof other === "number";
    const keys1 = this.keys();

    for (const key1 of keys1) {
      const value1 = this.get(key1)!;

      if (isScalar) {
        const resultKey = op(key1, other as number);
        result.increment(resultKey, value1);
      } else {
        const keys2 = (other as Dice).keys();
        for (const key2 of keys2) {
          const value2 = (other as Dice).get(key2)!;
          const resultKey = op(key1, key2);
          result.increment(resultKey, value1 * value2);
        }
      }
    }

    return result;
  }

  private removeFaces(facesToRemove: number[]): Dice {
    const result = new Dice();

    for (const [key, bin] of this.pmf.map) {
      if (!facesToRemove.includes(key)) {
        result.setFace(key, bin.p);
      }
    }

    result.privateData = { ...this.privateData };
    return result;
  }

  // PUBLIC FUNTIONS

  getFaceEntries(): [number, number][] {
    return [...this.pmf.map.entries()].map(([k, b]) => [k, b.p]);
  }

  getFaceMap(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [k, b] of this.pmf.map) out[k] = b.p;
    return out;
  }

  get(face: number): number {
    return this.pmf.map.get(face)?.p ?? 0;
  }

  keys(): number[] {
    return [...this.pmf.map.keys()];
  }

  values(): number[] {
    return [...this.pmf.map.values()].map((b) => b.p);
  }

  total(): number {
    return this.pmf.mass();
  }

  public setFace(key: number, value: number): void {
    const newMap = new Map<number, Bin>();
    // copy existing bins
    for (const [k, b] of this.pmf.map) {
      newMap.set(k, {
        p: b.p,
        count: { ...(b.count || {}) },
        attr: b.attr ? { ...b.attr } : undefined,
      });
    }
    // set or overwrite target bin
    const existing = newMap.get(key) || { p: 0, count: {} };
    existing.p = value;
    newMap.set(key, existing);
    // replace PMF instance to refresh caches
    this.pmf = new PMF(newMap, this.pmf.epsilon, false, this.pmf.identifier);
  }

  public static scalar(value: number): Dice {
    const result = new Dice();
    result.increment(value, 1);
    return result;
  }

  public maxFace(): number {
    const numericKeys = this.keys();

    if (numericKeys.length === 0) {
      throw new Error("No numeric faces found");
    }

    return Math.max(...numericKeys);
  }

  public minFace(): number {
    const numericKeys = this.keys();

    if (numericKeys.length === 0) {
      throw new Error("No numeric faces found");
    }

    return Math.min(...numericKeys);
  }

  public increment(face: number, count: number): void {
    const current = this.get(face) || 0;
    this.setFace(face, current + count);
  }

  public normalize(scalar: number): Dice {
    const result = new Dice();

    for (const [face, bin] of this.pmf.map) {
      result.setFace(face, bin.p * scalar);
    }

    result.privateData = { ...this.privateData };
    // Preserve explicit outcome presence and cached distributions
    (result as any).outcomePresence = new Set(this.outcomePresence);
    (result as any).outcomeCache = { ...this.outcomeCache };
    return result;
  }

  // OPERATIONS

  public add(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => a + b);
  }

  public subtract(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => a - b);
  }

  public conditionalApply(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => (a === 0 ? 0 : 1) * b);
  }

  public multiply(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => a * b);
  }

  public addNonZero(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => (a !== 0 ? a + b : a));
  }

  public eq(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => (a === b ? 1 : 0));
  }

  public max(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => Math.max(a, b));
  }

  public min(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => Math.min(a, b));
  }

  public advantage(): Dice {
    return this.max(this);
  }

  public ge(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => (a >= b ? 0 : 1));
  }

  public divide(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => a / b);
  }

  public divideRoundUp(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => Math.ceil(a / b));
  }

  public divideRoundDown(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => Math.floor(a / b));
  }

  public and(other: Dice | number): Dice {
    return this.binaryOp(other, (a, b) => (a && b ? 1 : 0));
  }

  private checkTarget(
    other: Dice | number,
    comparisonLogic: (roll: number, target: number) => number
  ): Dice {
    const createResult = () => {
      const result = new Dice();
      result.increment(0, 0); // Success
      result.increment(1, 0); // Failure
      return result;
    };

    return this.binaryOp(other, comparisonLogic, createResult);
  }

  public dc(other: Dice | number): Dice {
    const dcCheck = (a: number, b: number) => (a >= b ? 0 : 1);
    const result = this.checkTarget(other, dcCheck);
    // Mark this as a DC check (save mechanic) for proper attribute assignment
    result.privateData.isDCCheck = true;
    return result;
  }

  public ac(other: Dice | number): Dice {
    const acCheck = (a: number, b: number) => (a >= b ? a : 0);
    return this.checkTarget(other, acCheck);
  }

  public deleteFace(face: number): Dice {
    const result = new Dice();

    for (const [k, bin] of this.pmf.map) {
      if (k !== face) result.increment(k, bin.p);
    }

    result.privateData = { ...this.privateData };
    (result as any).outcomePresence = new Set(this.outcomePresence);
    (result as any).outcomeCache = { ...this.outcomeCache };
    return result;
  }

  public reroll(toReroll: Dice | number): Dice {
    const rerollDice =
      typeof toReroll === "number" ? Dice.scalar(toReroll) : toReroll;

    const removed = this.removeFaces(rerollDice.keys());
    let result = new Dice();

    for (const face of this.keys()) {
      const wasRerolled = rerollDice.keys().includes(face);
      result = result.combine(removed);
      if (wasRerolled) {
        result = result.combine(this);
      }
    }

    return result;
  }

  // This is not addition and not rolling two dice at once.
  // Instead, it’s mixing two distributions into a single weighted die.
  public combine(other: Dice | number): Dice {
    if (typeof other === "number") {
      other = Dice.scalar(other);
    }

    const result = new Dice();
    // Start by copying other's pmf
    for (const [k, bin] of (other as Dice).pmf.map) {
      result.setFace(k, bin.p);
      const rbin = result.pmf.map.get(k)!;
      rbin.count = { ...(bin.count || {}) };
      if (bin.attr) rbin.attr = { ...bin.attr };
    }
    // Merge this pmf
    for (const [k, bin] of this.pmf.map) {
      const existing = result.pmf.map.get(k);
      if (!existing) {
        result.pmf.map.set(k, {
          p: bin.p,
          count: { ...(bin.count || {}) },
          attr: bin.attr ? { ...bin.attr } : undefined,
        });
      } else {
        existing.p += bin.p;
        for (const t in bin.count) {
          existing.count[t] = (existing.count[t] || 0) + (bin.count[t] as number);
        }
        if (bin.attr) {
          existing.attr = existing.attr || {};
          for (const t in bin.attr) {
            existing.attr[t] =
              (existing.attr[t] || 0) + (bin.attr[t] as number);
          }
        }
      }
    }

    result.privateData = { ...this.privateData, except: other };
    return result;
  }

  public combineInPlace(other: Dice): void {
    // Build a new map by adding other's mass to ours
    const newMap = new Map<number, Bin>();
    for (const [k, b] of this.pmf.map) {
      newMap.set(k, {
        p: b.p,
        count: { ...(b.count || {}) },
        attr: b.attr ? { ...b.attr } : undefined,
      });
    }
    for (const [k, bin] of other.pmf.map) {
      const cur = newMap.get(k);
      if (!cur) newMap.set(k, { p: bin.p, count: {}, attr: undefined });
      else cur.p += bin.p;
    }
    this.pmf = new PMF(newMap, this.pmf.epsilon, false, this.pmf.identifier);
    // Preserve/merge outcome presence/cache as in combine semantics (counts are not merged here)
    for (const label of other.outcomePresence) this.outcomePresence.add(label);
  }

  public percent(): Record<number, number> {
    const total = this.total();
    const result: Record<number, number> = {};
    if (total === 0) return result;
    for (const [face, bin] of this.pmf.map) {
      result[face] = bin.p / total;
    }
    return result;
  }

  public average(): number {
    const total = this.total();
    if (total === 0) return 0;
    let sum = 0;
    for (const [k, bin] of this.pmf.map) sum += k * bin.p;
    return sum / total;
  }

  /*
   * Convert dice to PMF using OutcomeType labels directly from damage distribution.
   * This is much cleaner than the original complex distribution conversion.
   */
  public toPMF(numEpsilon: number = EPS): PMF {
    // Normalize internal counts to probabilities and derive attribution
    // Ensure hit is computed before deriving labels
    this.ensureHitDistribution();

    const total = this.pmf.mass();
    if (total === 0) return PMF.empty(numEpsilon);

    // Detect save-half scenario (presence of saveHalf that matches half of a hit face)
    let isSaveHalf = false;
    const faces = [...this.pmf.map.keys()];
    const hasHitAt = (d: number) => {
      const b = this.pmf.map.get(d);
      return b ? ((b.count["hit"] as number) ?? 0) > 0 : false;
    };
    for (const [d, b] of this.pmf.map) {
      const sh = (b.count["saveHalf"] as number) ?? 0;
      if (sh > 0) {
        const two = d * 2;
        if (faces.includes(two) && hasHitAt(two)) {
          isSaveHalf = true;
          break;
        }
      }
    }

    const isDCCheck = this.privateData.isDCCheck === true;

    const out = new Map<number, Bin>();
    for (const [face, bin] of this.pmf.map) {
      const p = bin.p / total;
      if (!(p > 0)) continue;
      if (numEpsilon >= 0 && p < numEpsilon) continue;

      const count: OutcomeLabelMap = {};
      let labeledMass = 0;

      // Copy and normalize counts, with hit→saveFail mapping if needed
      for (const k in bin.count) {
        const raw = (bin.count[k] as number) || 0;
        if (raw === 0) continue;
        const v = raw / total;
        if (k === "hit" && (isSaveHalf || isDCCheck)) {
          count["saveFail"] = ((count["saveFail"] as number) || 0) + v;
        } else {
          count[k] = ((count[k] as number) || 0) + v;
        }
        labeledMass += v;
      }

      // For non-save scenarios, attribute any unlabeled mass to missNone
      if (!isSaveHalf && !isDCCheck) {
        const leftover = p - labeledMass;
        if (leftover > 0) count["missNone"] = ((count["missNone"] as number) || 0) + leftover;
        labeledMass += leftover;
      }

      // Build attr as damage attribution per outcome (unconditional mass * damage)
      let attr: OutcomeLabelMap | undefined;
      for (const k in count) {
        const v = (count[k] as number) || 0;
        if (v !== 0) {
          if (!attr) attr = {};
          attr[k] = v * face;
        }
      }

      out.set(face, { p, count, attr });
    }

    const id = this.identifier || "dice";
    return new PMF(out, numEpsilon, true, id).compact(numEpsilon, true);
  }
}

export type _DiceInternal = never;
