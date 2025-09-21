import type { OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { pmfFromRollBuilder } from "./ast";
import { d20RollPMF } from "./d20";
import type { DCBuilder } from "./dc";
import type { RollBuilder } from "./roll";
import type { CheckBuilder, SaveResolution } from "./types";

export type SaveOutcome = "normal" | "half";

export class SaveBuilder implements CheckBuilder {
  constructor(
    readonly check: DCBuilder,
    private readonly failureEffect?: RollBuilder,
    private readonly saveOutcome: SaveOutcome = "normal"
  ) {}

  saveHalf(): SaveBuilder {
    return new SaveBuilder(this.check, this.failureEffect, "half");
  }

  toExpression(): string {
    const checkPart = this.check.toExpression();
    if (!this.failureEffect) return checkPart;

    const failureEffectPart = this.failureEffect.toExpression();
    const result = `${checkPart} * (${failureEffectPart})`;
    return this.saveOutcome === "half" ? `${result} save half` : result;
  }

  resolve(eps: number = EPS): SaveResolution {
    const { pSuccess: psuccess = 0, pFail: pfail = 1 } = resolveProbabilities(
      this.check
    );
    const failPMF = this.failureEffect
      ? pmfFromRollBuilder(this.failureEffect)
      : PMF.delta(0);
    const onSuccess = this.saveOutcome ?? "half";

    let successPMF: PMF = PMF.delta(0, eps);
    if (onSuccess === "half") successPMF = failPMF.scaleDamage(0.5, "floor");

    const successLabel: OutcomeType =
      onSuccess === "normal" ? "missNone" : "saveHalf";
    const failLabel: OutcomeType = "saveFail";
    const baseMix = new Mixture<OutcomeType>(eps);
    const mixture = baseMix
      .add(successLabel, successPMF, psuccess)
      .add(failLabel, failPMF, pfail);

    return {
      pmf: mixture.buildPMF(eps) ?? PMF.delta(0, eps),
      check:
        PMF.exclusive([[PMF.delta(1), psuccess]], eps) ?? PMF.delta(0, eps),
      saveFail: failPMF ?? PMF.delta(0, eps),
      saveSuccess: successPMF ?? PMF.delta(0, eps),
      weights: { success: psuccess, fail: pfail },
    };
  }

  // By default, create PMF with no pruning
  toPMF(eps: number = 0): PMF {
    return this.resolve(eps).pmf;
  }

  get pmf() {
    return this.toPMF();
  }

  // By default, create query on PMF with no pruning
  toQuery(eps: number = 0): DiceQuery {
    return this.toPMF(eps).query();
  }
}

function resolveProbabilities(check: DCBuilder): {
  pSuccess: number;
  pFail: number;
} {
  const saveBonus = check.modifier;
  const dc = check.saveDC;
  const d20Type = check.rollType;
  const baseReroll = check.baseReroll;
  // TODO later check if base reroll is not 0 or 1.

  const die = d20RollPMF(d20Type, baseReroll > 0);
  const faceP = new Map<number, number>();
  for (const [r, rec] of die as any as Iterable<[number, any]>) {
    const pr = typeof rec === "number" ? rec : rec.p;
    if (pr > 0) faceP.set(r, pr);
  }

  // Now add bonus dice to the PMF (bless, bane, bardic, etc)
  const eps = 0;
  const bonusDicePMFs = check.getBonusDicePMFs(check, eps);
  const bonusPMF =
    bonusDicePMFs.length > 0
      ? PMF.convolveMany(bonusDicePMFs, eps)
      : PMF.zero(eps);

  let pSuccess = 0;
  for (let r = 1; r <= 20; r++) {
    const pr = faceP.get(r);
    if (!pr) continue;
    const need = dc - saveBonus - r;
    pSuccess += pr * bonusPMF.tailProbGE(need);
  }

  const pFail = Math.max(0, 1 - pSuccess);
  return { pSuccess, pFail: pFail };
}
