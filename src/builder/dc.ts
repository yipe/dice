import { PMF } from "../pmf/pmf";
import { pmfFromRollBuilder } from "./ast";
import { d20RollPMF } from "./d20";
import { RollBuilder } from "./roll";
import { SaveBuilder } from "./save";

interface SaveConfig {
  dc: number;
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

  override toPMF(eps: number = 0): PMF {
    const saveDC = this.saveDC;
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    const d20 = d20RollPMF(rollType, rerollOne);
    const staticMod = this.modifier;
    const bonusDicePMFs = this.getBonusDiceConfigs().map((cfg) =>
      pmfFromRollBuilder(RollBuilder.fromConfigs([cfg]), eps)
    );
    const bonusPMF = bonusDicePMFs.length
      ? PMF.convolveMany(bonusDicePMFs, eps)
      : PMF.delta(0, eps);

    let psuccess = 0;
    for (const [r, rec] of d20 as any as Iterable<[number, any]>) {
      const pr = typeof rec === "number" ? rec : rec.p;
      if (pr <= 0) continue;
      const need = saveDC - staticMod - r;
      psuccess += pr * bonusPMF.tailProbGE(need);
    }

    const pfail = Math.max(0, 1 - psuccess);
    const m = new Map<number, number>([
      [0, psuccess > 0 ? psuccess : 0],
      [1, pfail > 0 ? pfail : 0],
    ]);
    return PMF.fromMap(m, eps);
  }
}

// Augment the RollBuilder interface to include the dc method
declare module "./roll" {
  interface RollBuilder {
    dc(saveDC: number): DCBuilder;
  }
}

// Augment the RollBuilder prototype to implement the dc method
RollBuilder.prototype.dc = function (saveDC: number): DCBuilder {
  if (isNaN(saveDC)) throw new Error("Invalid NaN value for saveDC");
  return new DCBuilder(this).dc(saveDC);
};
