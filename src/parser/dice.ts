// dice.ts (internal)

import type {
  Bin,
  DamageDistribution,
  OutcomeLabelMap,
  OutcomeType,
} from "../common/types";
import { EPS } from "../common/types";
import { PMF } from "../pmf/pmf";

/** Internal bookkeeping attached to a {@link Dice} during parsing. */
export interface DicePrivateData {
  /** Marks a DC (saving-throw) check so outcomes are attributed correctly. */
  isDCCheck?: boolean;
  /** The "other" distribution recorded by {@link Dice.combine}. */
  except?: Dice | Record<string, never>;
  /** Keep-highest/lowest selector applied when a die is multiplied out. */
  keep?: (values: number[]) => number;
}

/**
 * @internal
 */
export class Dice {
  private readonly faces: DamageDistribution = {};
  public privateData: DicePrivateData = {};
  private outcomeData: Record<OutcomeType, DamageDistribution> = {} as Record<
    OutcomeType,
    DamageDistribution
  >;
  private hasHitDistributionCalculated = false;
  public identifier?: string;

  constructor(x: number = 0) {
    if (x <= 0) return;
    for (let i = 1; i <= x; i++) {
      this.faces[i] = 1;
    }
  }

  getOutcomeDistribution(key: OutcomeType): DamageDistribution | undefined {
    if (key === "hit") {
      this.ensureHitDistribution();
    }

    const distribution = this.outcomeData[key];
    if (distribution === undefined) return undefined;

    return { ...distribution };
  }

  getFullOutcomeDistribution(): Record<
    OutcomeType,
    DamageDistribution | undefined
  > {
    return { ...this.outcomeData };
  }

  setOutcomeDistribution(
    key: OutcomeType,
    data: DamageDistribution | undefined
  ): void {
    if (data) {
      this.outcomeData[key] = data;
    } else {
      delete this.outcomeData[key];
    }
  }

  hasOutcomeData(key: OutcomeType): boolean {
    if (key === "hit") {
      this.ensureHitDistribution();
    }
    const data = this.outcomeData[key];
    return data !== undefined && Object.keys(data).length > 0;
  }

  getOutcomeCount(key: OutcomeType, face: number): number {
    return this.outcomeData[key]?.[face] ?? 0;
  }

  getAverage(key: OutcomeType): number {
    const distribution = this.getOutcomeDistribution(key);
    if (!distribution) return 0;
    // TODO caching opportunity

    const totalCount = Object.values(distribution).reduce(
      (sum, count) => sum + count,
      0
    );
    const expectedDamage = Object.entries(distribution).reduce(
      (sum, [damage, count]) => sum + Number(damage) * count,
      0
    );
    if (totalCount === 0) return 0;
    return expectedDamage / totalCount;
  }

  // TODO this can be private later if we change how testing works
  calculateHitDistribution(): DamageDistribution {
    const hitValues: DamageDistribution = {};

    // Hoist the per-outcome distributions out of the face loop: they are
    // constant across faces, so fetching (and previously cloning) them once is
    // O(faces + outcomes) instead of O(faces × outcomes). The stored maps are
    // only read here, never mutated, so reading them directly is safe and
    // produces identical counts.
    const subtractedOutcomes: (DamageDistribution | undefined)[] = [
      this.outcomeData.crit,
      this.outcomeData.missNone,
      this.outcomeData.missDamage,
      this.outcomeData.saveHalf,
      this.outcomeData.saveFail,
      this.outcomeData.pc,
    ];

    for (const [face, totalCount] of Object.entries(this.faces)) {
      const numFace = Number(face);
      let hitCount = totalCount;

      for (const distribution of subtractedOutcomes) {
        const outcomeCount = distribution?.[numFace];
        if (outcomeCount) {
          hitCount -= outcomeCount;
        }
      }

      // Zero damage should not be counted as hits - they represent misses
      if (numFace === 0) {
        hitCount = 0;
      }

      // Defensive clamp: guards against negative hit counts from older
      // inclusion-exclusion logic. Should never trigger in practice.
      if (hitCount < 0) {
        hitCount = 0;
      }
      hitValues[numFace] = hitCount;
    }

    return hitValues;
  }

  private ensureHitDistribution(): void {
    if (!this.hasHitDistributionCalculated) {
      const hitValues = this.calculateHitDistribution();
      this.setOutcomeDistribution("hit", hitValues);
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
      const value1 = this.faces[key1]!;

      if (isScalar) {
        const resultKey = op(key1, other as number);
        result.increment(resultKey, value1);
      } else {
        const keys2 = other.keys();
        for (const key2 of keys2) {
          const value2 = other.faces[key2]!;
          const resultKey = op(key1, key2);
          result.increment(resultKey, value1 * value2);
        }
      }
    }

    return result;
  }

  private removeFaces(facesToRemove: number[]): Dice {
    const result = new Dice();

    for (const [key, value] of Object.entries(this.faces)) {
      const numKey = Number(key);
      if (!facesToRemove.includes(numKey)) {
        result.faces[numKey] = value;
      }
    }

    result.privateData = { ...this.privateData };
    result.outcomeData = { ...this.outcomeData };
    return result;
  }

  // PUBLIC FUNCTIONS

  getFaceEntries(): [number, number][] {
    return Object.entries(this.faces).map(([k, v]) => [Number(k), v]);
  }

  getFaceMap(): DamageDistribution {
    return { ...this.faces };
  }

  get(face: number): number {
    return this.faces[face] ?? 0;
  }

  keys(): number[] {
    return Object.keys(this.faces).map(Number);
  }

  values(): number[] {
    return Object.values(this.faces);
  }

  total(): number {
    return Object.values(this.faces).reduce((sum, value) => sum + value, 0);
  }

  public setFace(key: number, value: number): void {
    this.faces[key] = value;
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
    const current = this.faces[face] || 0;
    this.faces[face] = current + count;
  }

  public normalize(scalar: number): Dice {
    const result = new Dice();

    for (const [face, count] of Object.entries(this.faces)) {
      result.faces[Number(face)] = count * scalar;
    }

    result.privateData = { ...this.privateData };
    result.outcomeData = { ...this.outcomeData };
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

    for (const [key, value] of Object.entries(this.faces)) {
      const numKey = Number(key);
      if (numKey !== face) {
        result.increment(numKey, value);
      }
    }

    result.privateData = { ...this.privateData };
    result.outcomeData = { ...this.outcomeData };
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

    // Start by copying "other" into a new Dice object
    const result = new Dice();
    for (const [key, value] of Object.entries(other.faces)) {
      result.faces[Number(key)] = value;
    }

    // Build the "except" dice and add faces from `this` to result
    const except = new Dice();
    for (const [key, value] of Object.entries(this.faces)) {
      const numKey = Number(key);
      result.increment(numKey, value);

      // If the key did not already exist in `other`, we remove it from `except`
      if (!(numKey in other.faces)) {
        except.increment(numKey, value); // still tracked in except
      }
    }

    result.privateData = { ...this.privateData, except: other };
    result.outcomeData = { ...this.outcomeData };
    return result;
  }

  public combineInPlace(other: Dice): void {
    for (const [key, value] of Object.entries(other.faces)) {
      const numKey = Number(key);
      const current = this.faces[numKey] || 0;
      this.faces[numKey] = current + value;
    }
  }

  public percent(): DamageDistribution {
    const total = this.total();
    const result: DamageDistribution = {};

    for (const [face, count] of Object.entries(this.faces)) {
      result[Number(face)] = count / total;
    }

    return result;
  }

  public average(): number {
    const total = this.total();
    if (total === 0) return 0;

    let sum = 0;
    for (const [key, value] of Object.entries(this.faces)) {
      sum += Number(key) * value;
    }

    return sum / total;
  }

  /*
   * Convert dice to PMF using OutcomeType labels directly from damage distribution.
   * This is much cleaner than the original complex distribution conversion.
   */
  public toPMF(numEpsilon: number = EPS): PMF {
    const total = this.total();
    if (total === 0) return PMF.empty(numEpsilon);

    // Ensure hit distribution is calculated before using it
    this.ensureHitDistribution();

    const map = new Map<number, Bin>();

    // Outcome distributions (counts, not probabilities)
    const hitDistro = this.getOutcomeDistribution("hit") || {};
    const critDistro = this.getOutcomeDistribution("crit") || {};
    const missDistro = this.getOutcomeDistribution("missDamage") || {};
    const saveDistro = this.getOutcomeDistribution("saveHalf") || {};
    const pcDistro = this.getOutcomeDistribution("pc") || {};

    // A non-empty save distribution means the "save" mechanic was used (e.g.
    // "save half"): its success mass is a saveHalf outcome and the remaining
    // (full-damage) mass is a saveFail. The previous heuristic — "isSaveHalf iff
    // 2×(a half value) appears in the hit distribution" — false-negatived on odd
    // or constant damage, mislabeling saveHalf as saveFail and saveFail as hit.
    const isSaveHalf = Object.keys(saveDistro).length > 0;

    const isDCCheck = this.privateData.isDCCheck === true;

    const clampNonNeg = (x: number) => (x < 0 && x > -1e-15 ? 0 : x);

    // Process each face value (iterate the internal map directly; this loop
    // only reads it, so the defensive clone from getFaceMap() is unnecessary)
    for (const [faceStr, faceCountRaw] of Object.entries(this.faces)) {
      const face = Number(faceStr);
      const faceCount = Number(faceCountRaw);

      // Skip structurally present but empty bins early
      if (faceCount <= 0) continue;

      let p = faceCount / total;
      p = clampNonNeg(p);

      // Always drop exact zeros to keep PMF semantics clean
      if (!(p > 0)) continue;

      // Optional pruning only when epsilon is enabled
      if (numEpsilon >= 0 && p < numEpsilon) continue;

      const count: OutcomeLabelMap = {};
      const attr: OutcomeLabelMap = {};

      // Add distribution counts and attributions
      if (hitDistro[face]) {
        const c = clampNonNeg(hitDistro[face] / total);
        if (c > 0) {
          if (isSaveHalf || isDCCheck) {
            count.saveFail = c; // full damage on failed save
            attr.saveFail = clampNonNeg((face * hitDistro[face]) / total);
          } else {
            count.hit = c;
            attr.hit = clampNonNeg((face * hitDistro[face]) / total);
          }
        }
      }

      if (critDistro[face]) {
        const c = clampNonNeg(critDistro[face] / total);
        if (c > 0) {
          count.crit = c;
          attr.crit = clampNonNeg((face * critDistro[face]) / total);
        }
      }

      if (missDistro[face]) {
        const c = clampNonNeg(missDistro[face] / total);
        if (c > 0) {
          count.missDamage = c;
          attr.missDamage = clampNonNeg((face * missDistro[face]) / total);
        }
      }

      if (saveDistro[face]) {
        const c = clampNonNeg(saveDistro[face] / total);
        if (c > 0) {
          if (isSaveHalf) {
            count.saveHalf = c; // half damage on successful save
            attr.saveHalf = clampNonNeg((face * saveDistro[face]) / total);
          } else {
            count.saveFail = (count.saveFail ?? 0) + c; // regular fail
            attr.saveFail = clampNonNeg(
              (attr.saveFail ?? 0) + (face * saveDistro[face]) / total
            );
          }
        }
      }

      if (pcDistro[face]) {
        const c = clampNonNeg(pcDistro[face] / total);
        if (c > 0) {
          count.pc = c;
          attr.pc = clampNonNeg((face * pcDistro[face]) / total);
        }
      }

      // Handle faces with no specific distribution (missNone) for non-save and non-DC checks
      if (!isSaveHalf && !isDCCheck) {
        const distroCountRaw =
          (hitDistro[face] || 0) +
          (critDistro[face] || 0) +
          (missDistro[face] || 0) +
          (saveDistro[face] || 0) +
          (pcDistro[face] || 0);

        const unaccountedCount = clampNonNeg(faceCount - distroCountRaw);
        if (unaccountedCount > 0) {
          const frac = clampNonNeg(unaccountedCount / total);
          if (frac > 0) {
            count.missNone = (count.missNone ?? 0) + frac;
            // missNone does 0 damage, so no attr contribution
          }
        }
      }

      const bin: Bin = { p, count };
      if (Object.keys(attr).length > 0) {
        bin.attr = attr;
      }

      map.set(face, bin);
    }

    // Fall back to a sentinel identifier if none was assigned. This indicates
    // a Dice constructed outside the normal parse/build flow.
    const identifier = this.identifier || "ERROR";

    // Normalize, drop zeros again if any snuck in, then compaction and pruning
    return new PMF(map, numEpsilon, true, identifier).compact(numEpsilon, true);
  }
}

export type _DiceInternal = never;
