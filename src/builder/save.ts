import type { OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { pmfFromRollBuilder } from "./ast";
import type { DCBuilder } from "./dc";
import { ParsedRollBuilder, type RollBuilder } from "./roll";
import type { CheckBuilder, SaveResolution } from "./types";

export type SaveOutcome = "normal" | "half";

/**
 * Resolved-save PMF cache, the save-side sibling of {@link attackPMFCache}. `resolve()` re-runs the failure
 * PMF, the half-damage scale and the success/fail mixture on every call; a save-based DPR sweep (a caster's
 * Fireball, a Paladin's smite) resolves the SAME save thousands of times. Keyed by
 * {@link SaveBuilder.cacheKey}; a `null` key resolves uncached.
 */
const savePMFCache = PMF.createCache(4000);

/** Clears the resolved-save PMF cache (test/bench seam; mirrors {@link clearAttackCache}). */
export function clearSaveCache(): void {
  savePMFCache.clear();
}

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

  /**
   * The save's outcome: `check` is the DC check's own PMF (success at 0, failure at 1, as
   * {@link DCBuilder.toPMF}), `weights` its success/failure chances, `saveFail` the failure payload
   * and `saveSuccess` what a success deals (half, floored, under `saveHalf()`; else 0).
   */
  resolve(eps: number = EPS): SaveResolution {
    const { pSuccess: psuccess, pFail: pfail } = this.check.saveProbabilities();
    const failPMF = this.failureEffect
      ? this.failureEffect instanceof ParsedRollBuilder
        ? this.failureEffect.toPMF(eps)
        : pmfFromRollBuilder(this.failureEffect)
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
      check: this.check.toPMF(eps),
      saveFail: failPMF ?? PMF.delta(0, eps),
      saveSuccess: successPMF ?? PMF.delta(0, eps),
      weights: { success: psuccess, fail: pfail },
    };
  }

  /**
   * A cheap, complete key for this save's resolved PMF, or `null` when it can't be cached soundly.
   * {@link resolve} reads exactly three things: the DC check (via `saveProbabilities`/`toPMF`), the failure
   * effect's PMF, and the save outcome — so composing their keys pins it. A `ParsedRollBuilder` failure
   * effect returns `null`, which correctly forces this uncached.
   */
  private cacheKey(eps: number): string | null {
    const checkKey = this.check.cacheKey();
    if (checkKey === null) return null;

    let failKey = "";
    if (this.failureEffect) {
      const k = this.failureEffect.cacheKey();
      if (k === null) return null;
      failKey = k;
    }

    return `${checkKey}*F${failKey}*O${this.saveOutcome}*e${eps}`;
  }

  // By default, create PMF with no pruning. Cached by the cheap config key across identical rebuilds.
  toPMF(eps: number = 0): PMF {
    const key = this.cacheKey(eps);
    if (key === null) return this.resolve(eps).pmf;
    const cached = savePMFCache.get(key);
    if (cached) return cached;
    const pmf = this.resolve(eps).pmf;
    savePMFCache.set(key, pmf);
    return pmf;
  }

  get pmf() {
    return this.toPMF();
  }

  // By default, create query on PMF with no pruning
  toQuery(eps: number = 0): DiceQuery {
    return this.toPMF(eps).query();
  }
}
