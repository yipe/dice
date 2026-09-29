import type { OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { pmfFromRollBuilder } from "./ast";
import type { DCBuilder } from "./dc";
import { ParsedRollBuilder, RollBuilder } from "./roll";
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

/** What a save's payload deals: a builder reads through {@link pmfFromRollBuilder}, a parsed string through its own PMF. */
function payloadPMF(effect: RollBuilder, eps: number): PMF {
  return effect instanceof ParsedRollBuilder ? effect.toPMF(eps) : pmfFromRollBuilder(effect);
}

export class SaveBuilder implements CheckBuilder {
  /**
   * @param check the DC check
   * @param failureEffect what a failed save deals; none means a failure deals 0
   * @param saveOutcome what a success deals: nothing (`"normal"`), the failure payload halved and floored
   *   (`"half"`), or a payload of its own (a {@link RollBuilder}, see {@link onSaveSuccess})
   */
  constructor(
    readonly check: DCBuilder,
    private readonly failureEffect?: RollBuilder,
    private readonly saveOutcome: SaveOutcome | RollBuilder = "normal"
  ) {}

  /** A success deals the failure payload halved, rounded down. Replaces any {@link onSaveSuccess} payload. */
  saveHalf(): SaveBuilder {
    return new SaveBuilder(this.check, this.failureEffect, "half");
  }

  /**
   * A success deals `payload`, read the way the failure payload is (`onSaveFailure`). It replaces `saveHalf()`
   * and an earlier `onSaveSuccess`, so the last call wins; without either, a success deals nothing.
   *
   * The success is labelled `saveHalf`, as under `saveHalf()`: the label marks a success that still deals
   * damage, and `OutcomeType` has no other. A payload that rolls 0 keeps it, as a half of 1 does. A number is
   * a flat payload (`onSaveSuccess(0)` is a success that deals 0, not the plain save's `missNone`).
   *
   * {@link toExpression} spells it `save (payload)`, the grammar's clause for a success payload.
   */
  onSaveSuccess(payload: RollBuilder | number): SaveBuilder {
    return new SaveBuilder(this.check, this.failureEffect, RollBuilder.fromArgs(payload));
  }

  /**
   * The save as an expression string that `parse()` reads back to this save's distribution: the check, the
   * failure payload, then `save half` or `save (payload)` for a success that deals damage. A save with no
   * failure effect prints as its bare check, unless it has an {@link onSaveSuccess} payload: that prints
   * `* (0)` for the failure, so the success payload is not lost.
   */
  toExpression(): string {
    const checkPart = this.check.toExpression();
    const success = this.saveOutcome;
    if (!this.failureEffect && !(success instanceof RollBuilder)) return checkPart;

    const failureEffectPart = this.failureEffect ? this.failureEffect.toExpression() : "0";
    const result = `${checkPart} * (${failureEffectPart})`;
    if (success instanceof RollBuilder) return `${result} save (${success.toExpression()})`;
    return success === "half" ? `${result} save half` : result;
  }

  /**
   * The save's outcome: `check` is the DC check's own PMF (success at 0, failure at 1, as
   * {@link DCBuilder.toPMF}), `weights` its success/failure chances, `saveFail` the failure payload
   * and `saveSuccess` what a success deals (half, floored, under `saveHalf()`; the payload under
   * `onSaveSuccess()`; else 0).
   */
  resolve(eps: number = EPS): SaveResolution {
    const { pSuccess: psuccess, pFail: pfail } = this.check.saveProbabilities();
    const failPMF = this.failureEffect ? payloadPMF(this.failureEffect, eps) : PMF.delta(0);
    const onSuccess = this.saveOutcome ?? "half";

    let successPMF: PMF = PMF.delta(0, eps);
    if (onSuccess === "half") successPMF = failPMF.scaleDamage(0.5, "floor");
    else if (onSuccess instanceof RollBuilder) successPMF = payloadPMF(onSuccess, eps);

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
   * {@link resolve} reads exactly four things: the DC check (via `saveProbabilities`/`toPMF`), the failure
   * effect's PMF, the save outcome and, under `onSaveSuccess()`, the success payload's PMF — so composing
   * their keys pins it. A `ParsedRollBuilder` failure or success effect returns `null`, which correctly
   * forces this uncached.
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

    const outcome = this.saveOutcome;
    let outcomeKey: string;
    if (outcome instanceof RollBuilder) {
      const k = outcome.cacheKey();
      if (k === null) return null;
      outcomeKey = `S${k}`;
    } else {
      outcomeKey = outcome;
    }

    return `${checkKey}*F${failKey}*O${outcomeKey}*e${eps}`;
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
