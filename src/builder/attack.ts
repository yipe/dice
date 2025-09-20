import type { OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import type { ACBuilder } from "./ac";
import { pmfFromRollBuilder } from "./ast";
import { d20RollPMF } from "./d20";
import { RollBuilder } from "./roll";
import type { AttackResolution, CheckBuilder } from "./types";

type ActionEffect = RollBuilder;

export class AttackBuilder implements CheckBuilder {
  constructor(
    readonly check: ACBuilder,
    private readonly hitEffect?: ActionEffect,
    private readonly critEffect?: ActionEffect | null,
    private readonly missEffect?: ActionEffect
  ) {}

  onCrit(val: number): AttackBuilder;
  onCrit(val: RollBuilder): AttackBuilder;
  onCrit(count: number, die: RollBuilder): AttackBuilder;
  onCrit(count: number, sides: number): AttackBuilder;
  onCrit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onCrit(count: number, sides: number, modifier: number): AttackBuilder;
  onCrit(...args: any[]): AttackBuilder {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      damageRoll,
      this.missEffect
    );
  }

  onMiss(val: number): AttackBuilder;
  onMiss(val: RollBuilder): AttackBuilder;
  onMiss(count: number, die: RollBuilder): AttackBuilder;
  onMiss(count: number, sides: number): AttackBuilder;
  onMiss(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onMiss(count: number, sides: number, modifier: number): AttackBuilder;
  onMiss(...args: any[]): AttackBuilder {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      this.critEffect,
      damageRoll
    );
  }

  noCrit(): AttackBuilder {
    return new AttackBuilder(this.check, this.hitEffect, null, this.missEffect);
  }

  // Legacy expressions
  toExpression(): string {
    const checkPart = this.check.toExpression();

    let effectPart = "";

    if (this.hitEffect) {
      effectPart = `(${this.hitEffect.toExpression()})`;
      let crit = undefined;
      if (this.critEffect !== null) {
        crit = this.critEffect ?? this.hitEffect.copy().doubleDice();

        const critThreshold = this.check.critThreshold;
        if (critThreshold < 15 || critThreshold > 20) {
          throw new Error(
            `Invalid crit threshold: ${critThreshold}. Must be between 15 and 20.`
          );
        }

        if (critThreshold === 20) {
          effectPart += ` crit (${crit.toExpression()})`;
        } else {
          const xcritNumber = 21 - critThreshold;
          effectPart += ` xcrit${xcritNumber} (${crit.toExpression()})`;
        }
      }

      if (this.missEffect) {
        effectPart += ` miss (${this.missEffect.toExpression()})`;
      }
    }

    return `${checkPart} * ${effectPart}`;
  }

  resolveProbabilities(
    check: ACBuilder,
    eps: number = 0
  ): { pSuccess: number; pHit: number; pCrit: number; pMiss: number } {
    const ac = check.attackConfig.ac;
    const rollType = check.rollType;
    const rerollOne = check.baseReroll > 0;

    const critThreshold = check.critThreshold;
    const d20 = d20RollPMF(rollType, rerollOne);
    const staticMod = this.check.modifier;

    const bonusDicePMFs = this.check.getBonusDicePMFs(this.check, eps);
    const bonusPMF = bonusDicePMFs.length
      ? PMF.convolveMany(bonusDicePMFs, eps)
      : PMF.delta(0, eps);

    let pcrit = 0;
    let phit = 0;
    let pmiss = 0;

    for (const [r, rec] of d20 as any as Iterable<[number, any]>) {
      const pr = typeof rec === "number" ? rec : rec.p;
      if (pr <= 0) continue;

      // Handle crit
      if (r >= critThreshold) {
        pcrit += pr;
        continue;
      }

      // Handle auto-miss
      if (r === 1) {
        pmiss += pr;
        continue;
      }

      // Handle normal hit/miss
      const need = ac - staticMod - r;
      const pBonusHit = bonusPMF.tailProbGE(need);

      phit += pr * pBonusHit;
      pmiss += pr * (1 - pBonusHit);
    }

    const psuccess = phit + pcrit;
    return { pSuccess: psuccess, pHit: phit, pCrit: pcrit, pMiss: pmiss };
  }

  resolve(eps: number = EPS): AttackResolution {
    const {
      pHit,
      pCrit,
      pMiss: pmiss,
    } = this.resolveProbabilities(this.check, eps);
    const hitPMF = this.hitEffect
      ? pmfFromRollBuilder(this.hitEffect, eps)
      : PMF.delta(0, eps);

    let critPMF: PMF | null = null;
    let phit = pHit;
    let pcrit = pCrit;

    if (this.critEffect === null) {
      critPMF = null;
      phit += pcrit;
      pcrit = 0;
    } else {
      const critBuilder =
        this.critEffect ?? this.hitEffect?.copy().doubleDice();
      critPMF = critBuilder
        ? pmfFromRollBuilder(critBuilder, eps)
        : PMF.delta(0, eps);
    }
    const missPMF = this.missEffect
      ? pmfFromRollBuilder(this.missEffect, eps)
      : PMF.delta(0, eps);

    // Mix them up
    const mix = new Mixture<OutcomeType>(eps);
    if (phit > 0) mix.add("hit", hitPMF, phit);
    if (critPMF && pcrit > 0) mix.add("crit", critPMF, pcrit);
    if (pmiss > 0)
      mix.add(this.missEffect ? "missDamage" : "missNone", missPMF, pmiss);

    return {
      pmf: mix.buildPMF(eps) ?? PMF.delta(0, eps),
      check: this.check.toPMF(eps) ?? PMF.delta(0, eps),
      hit: hitPMF ?? PMF.delta(0, eps),
      crit: critPMF ?? PMF.delta(0, eps),
      miss: missPMF ?? PMF.delta(0, eps),
      weights: { hit: phit, crit: pcrit, miss: pmiss },
    };
  }

  // By default, create PMF with no pruning
  toPMF(eps: number = 0): PMF {
    return this.resolve(eps).pmf;
  }

  // By default, create query on PMF with no pruning
  toQuery(eps: number = 0): DiceQuery {
    return this.toPMF(eps).query();
  }
}
