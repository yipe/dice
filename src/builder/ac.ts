import { PMF } from "../pmf/pmf";
import { AttackBuilder } from "./attack";
import { d20RollPMF } from "./d20";
import { RollBuilder } from "./roll";

export interface AttackConfig {
  ac: number;
  critThreshold: number;
}
export class ACBuilder extends RollBuilder {
  readonly attackConfig: AttackConfig;

  constructor(baseRoll: RollBuilder, ac: number, attackConfig?: AttackConfig) {
    super(baseRoll.getSubRollConfigs());

    if (attackConfig) {
      this.attackConfig = { ...attackConfig, ac };
    } else {
      this.attackConfig = { ac, critThreshold: 20 };
    }
  }

  //   onHit(effect: RollBuilder): AttackBuilder {
  //     return new AttackBuilder(this).onHit(effect)
  //   }

  onHit(val: number): AttackBuilder;
  onHit(val: RollBuilder): AttackBuilder;
  onHit(count: number, die: RollBuilder): AttackBuilder;
  onHit(count: number, sides: number): AttackBuilder;
  onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onHit(count: number, sides: number, modifier: number): AttackBuilder;
  onHit(...args: any[]): AttackBuilder {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(this, damageRoll);
  }

  get critThreshold(): number {
    return this.attackConfig.critThreshold;
  }

  // TODO - move this to AC Builder… or if we create a DC builder that has critOn, throw an error?
  critOn(threshold: number): ACBuilder {
    const newConfig: AttackConfig = {
      ...this.attackConfig,
      critThreshold: threshold,
    };
    return new ACBuilder(this, this.attackConfig.ac, newConfig);
  }

  // Legacy expressions
  override toExpression(): string {
    const configs = this.getSubRollConfigs(); // This already includes bonus dice, no need to add them again
    const expression = new RollBuilder(configs).toExpression();
    return this.attackConfig.ac
      ? `(${expression} AC ${this.attackConfig.ac})`
      : expression;
  }

  override toPMF(eps: number = 0): PMF {
    const ac = this.attackConfig.ac;

    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    const d20 = d20RollPMF(rollType, rerollOne);

    const staticMod = this.modifier;
    const bonusPMFs = this.getBonusDicePMFs(this, eps);

    // Build total to-hit value distribution attackRollPMF = d20 ⊕ bonusDice, then shift by staticMod
    const parts = [d20, ...bonusPMFs];
    let attackRollPMF = parts.length === 1 ? d20 : PMF.convolveMany(parts, eps);
    if (staticMod !== 0)
      attackRollPMF = attackRollPMF.mapDamage(
        (rollValue) => rollValue + staticMod
      );

    // Map to 0 when below AC
    const out = new Map<number, number>();
    for (const rollValue of attackRollPMF.support()) {
      const p = attackRollPMF.pAt(rollValue);
      const key = rollValue >= ac ? rollValue : 0;
      out.set(key, (out.get(key) || 0) + p);
    }
    return PMF.fromMap(out, eps);
  }

  override copy(): ACBuilder {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const newConfig = {
      ac: this.attackConfig.ac,
      critThreshold: this.attackConfig.critThreshold,
    };
    return new ACBuilder(baseCopy, newConfig.ac, newConfig);
  }
}

// Augment the RollBuilder interface to include the ac method
declare module "./roll" {
  interface RollBuilder {
    ac(targetAC: number): ACBuilder;
  }
}

// Augment the RollBuilder prototype to implement the ac method
RollBuilder.prototype.ac = function (targetAC: number): ACBuilder {
  if (isNaN(targetAC)) throw new Error("Invalid NaN value for targetAC");
  return new ACBuilder(this, targetAC);
};
