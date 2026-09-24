import { LRUCache } from "../common/lru-cache";
import { PMF } from "../pmf/pmf";
import { resolveRootD20 } from "./ast";
import { splitAtThreshold } from "./prob";
import { RollBuilder } from "./roll";
import { SaveBuilder } from "./save";

interface SaveConfig {
  dc: number;
}

/**
 * DC-check PMF cache. The two-outcome success/fail PMF is re-derived on every `toPMF()`, and a save-based
 * DPR sweep asks for the SAME check thousands of times. Keyed by {@link DCBuilder.cacheKey} + `eps`.
 */
const dcPMFCache = new LRUCache<string, PMF>(4000);

/** Clears the DC-check PMF cache (test/bench seam). */
export function clearDCCache(): void {
  dcPMFCache.clear();
}

export class DCBuilder extends RollBuilder {
  private readonly saveConfig: SaveConfig;

  constructor(baseRoll: RollBuilder, saveConfig?: SaveConfig) {
    super(baseRoll.getSubRollConfigs());
    this.saveConfig = saveConfig ? { ...saveConfig } : { dc: 10 };
  }

  override dc(saveDC: number): DCBuilder {
    if (this.rollType && this.rollType === "elven accuracy") {
      throw new Error(
        "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead."
      );
    }
    return new DCBuilder(this, { dc: saveDC });
  }

  get saveDC(): number {
    return this.saveConfig.dc;
  }

  override add(anotherRoll: RollBuilder): DCBuilder {
    const newBuilder = super.add(anotherRoll);
    return new DCBuilder(newBuilder, this.saveConfig);
  }

  override addRoll(count?: number): DCBuilder {
    const newBuilder = super.addRoll(count);
    return new DCBuilder(newBuilder, this.saveConfig);
  }

  onSaveFailure(val: number): SaveBuilder;
  onSaveFailure(val: string): SaveBuilder;
  onSaveFailure(val: RollBuilder): SaveBuilder;
  onSaveFailure(count: number, die: RollBuilder): SaveBuilder;
  onSaveFailure(count: number, sides: number): SaveBuilder;
  onSaveFailure(count: number, die: RollBuilder, modifier: number): SaveBuilder;
  onSaveFailure(count: number, sides: number, modifier: number): SaveBuilder;
  onSaveFailure(...args: any[]): SaveBuilder {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new SaveBuilder(this, damageRoll);
  }

  override withElvenAccuracy(): never {
    throw new Error(
      "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks)."
    );
  }

  // Legacy expressions
  override toExpression(): string {
    const subConfigs = this.getSubRollConfigs();
    const allConfigs = [...subConfigs];
    const expression = new RollBuilder(allConfigs).toExpression();
    return `(${expression} DC ${this.saveConfig.dc})`;
  }

  /**
   * The DC check's PMF is fully determined by the save DC plus everything `toPMF` below reads off the roll
   * configs (`rollType`, `baseReroll`, `modifier`, bonus dice) — all of which `super.cacheKey()` already
   * serializes. So extend the base key with the DC, mirroring {@link AlwaysHitBuilder.cacheKey}.
   */
  override cacheKey(): string | null {
    const base = super.cacheKey();
    return base === null ? null : `DC|${this.saveConfig.dc}|${base}`;
  }

  /**
   * P(success) and P(failure) of this save: success iff natural roll + bonus dice + modifier ≥ DC,
   * with no natural-1/natural-20 rule (a check with no die compares its flat total alone). Each side
   * is summed from its own outcomes, so a certain success has a failure chance of exactly 0.
   */
  saveProbabilities(): { pSuccess: number; pFail: number } {
    const natural = resolveRootD20(this);
    const bonusDicePMFs = this.getBonusDicePMFs(this, 0);
    const bonusPMF = bonusDicePMFs.length ? PMF.convolveMany(bonusDicePMFs, 0) : PMF.delta(0, 0);
    let pSuccess = 0;
    let pFail = 0;
    for (const [r, bin] of natural) {
      const { atLeast, below } = splitAtThreshold(bonusPMF, this.saveDC - this.modifier - r);
      pSuccess += bin.p * atLeast;
      pFail += bin.p * below;
    }
    return { pSuccess, pFail };
  }

  /**
   * The check outcome as a PMF: a success at 0, a failure at 1 (so `hitProbability()` is the
   * chance the save fails — the chance the effect lands). `SaveBuilder.resolve().check` is this PMF.
   */
  override toPMF(eps: number = 0): PMF {
    const key = this.cacheKey();
    const fullKey = key === null ? null : `${key}*e${eps}`;
    if (fullKey !== null) {
      const cached = dcPMFCache.get(fullKey);
      if (cached) return cached;
    }

    const { pSuccess, pFail } = this.saveProbabilities();
    const m = new Map<number, number>();
    if (pSuccess > 0) m.set(0, pSuccess);
    if (pFail > 0) m.set(1, pFail);
    const pmf = PMF.fromMap(m, eps);
    if (fullKey !== null) dcPMFCache.set(fullKey, pmf);
    return pmf;
  }
}

// Augment the RollBuilder prototype to implement the dc method
RollBuilder.prototype.dc = function (saveDC: number): DCBuilder {
  if (isNaN(saveDC)) throw new Error("Invalid NaN value for saveDC");
  return new DCBuilder(this).dc(saveDC);
};
