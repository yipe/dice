import type { OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { pmfFromRollBuilder } from "./ast";
import type { AttachedCondition } from "./attack";
import type { DCBuilder } from "./dc";
import { naturalRollIndex, ParsedRollBuilder, RollBuilder } from "./roll";
import type { AbilityName, CheckBuilder, SaveResolution } from "./types";
import type { ContextualSource, RowCheck, RowContext } from "../turn/types";

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

export class SaveBuilder implements CheckBuilder, ContextualSource {
  /**
   * @param check the DC check
   * @param failureEffect what a failed save deals; none means a failure deals 0
   * @param saveOutcome what a success deals: nothing (`"normal"`), the failure payload halved and floored
   *   (`"half"`), or a payload of its own (a {@link RollBuilder}, see {@link onSaveSuccess}); never both
   * @param attached conditions a failed save applies in a turn (see {@link DCBuilder.onSaveFailure})
   */
  constructor(
    readonly check: DCBuilder,
    private readonly failureEffect?: RollBuilder,
    private readonly saveOutcome: SaveOutcome | RollBuilder = "normal",
    readonly attached: readonly AttachedCondition[] = []
  ) {}

  /**
   * A success deals the failure payload halved, rounded down. Mutually exclusive with {@link onSaveSuccess}, as
   * `halfOnMiss()` is with `onMiss()`: the success can be one or the other, so this throws after `onSaveSuccess()`.
   */
  saveHalf(): SaveBuilder {
    if (this.saveOutcome instanceof RollBuilder) {
      throw new Error(
        "saveHalf() cannot be combined with onSaveSuccess(): the success branch can only be one or the other."
      );
    }
    return new SaveBuilder(this.check, this.failureEffect, "half", this.attached);
  }

  /**
   * A success deals a payload of its own, where `saveHalf()` fixes it at half the failure. The arguments are
   * `onSaveFailure`'s: a number, a string, a `RollBuilder`, `(count, die)`, `(count, sides)` or either with a
   * modifier, read the way the failure payload is. A second `onSaveSuccess` replaces the first, as a second
   * `onMiss` does; without either it and `saveHalf()`, a success deals nothing. It throws after `saveHalf()`
   * (the success can be one or the other).
   *
   * The success is labelled `saveHalf`, as under `saveHalf()`: the label marks a success that still deals
   * damage, and `OutcomeType` has no other. A payload that rolls 0 keeps it, as a half of 1 does. A number is
   * a flat payload (`onSaveSuccess(0)` is a success that deals 0, not the plain save's `missNone`).
   *
   * {@link toExpression} spells it `save (payload)`, the grammar's clause for a success payload.
   */
  onSaveSuccess(val: number): SaveBuilder;
  onSaveSuccess(val: string): SaveBuilder;
  onSaveSuccess(val: RollBuilder): SaveBuilder;
  onSaveSuccess(count: number, die: RollBuilder): SaveBuilder;
  onSaveSuccess(count: number, sides: number): SaveBuilder;
  onSaveSuccess(count: number, die: RollBuilder, modifier: number): SaveBuilder;
  onSaveSuccess(count: number, sides: number, modifier: number): SaveBuilder;
  onSaveSuccess(...args: any[]): SaveBuilder {
    if (this.saveOutcome === "half") {
      throw new Error(
        "onSaveSuccess() cannot be combined with saveHalf(): the success branch can only be one or the other."
      );
    }
    return new SaveBuilder(this.check, this.failureEffect, RollBuilder.fromArgs(...args), this.attached);
  }

  /** The save's ability (`"con"` or `"constitution"`): see {@link DCBuilder.ability}. */
  ability(name: AbilityName): SaveBuilder {
    return new SaveBuilder(this.check.ability(name), this.failureEffect, this.saveOutcome, this.attached);
  }

  /** The save fails without rolling: see {@link DCBuilder.alwaysFails}. */
  alwaysFails(): SaveBuilder {
    return new SaveBuilder(this.check.alwaysFails(), this.failureEffect, this.saveOutcome, this.attached);
  }

  /** No grant or condition in a turn changes this save's roll type: see {@link RollBuilder.pinned}. */
  pinned(): SaveBuilder {
    return new SaveBuilder(this.check.pinned(), this.failureEffect, this.saveOutcome, this.attached);
  }

  /**
   * What this save declares to a turn ({@link ContextualSource}): its ability (when
   * {@link ability} set one), its own roll type, `pinned` and `alwaysFails()`.
   */
  get rowCheck(): RowCheck {
    const check = this.check;
    const rollType = check.rollType;
    return {
      kind: "save",
      ...(check.saveAbility === undefined ? {} : { ability: check.saveAbility }),
      rollType,
      advantageDice: rollType === "elven accuracy" ? 3 : 2,
      pinned: check.getRootDieConfig()?.pinned === true,
      autoHit: false,
      autoCrit: false,
      autoFail: check.autoFail,
    };
  }

  /**
   * This save's outcome-labelled PMF (as {@link toPMF}, at `eps`) re-derived in a turn's `context`.
   * `context.rollType` is the target's roll, taken literally unless the save is {@link pinned};
   * `autoFail` makes it fail without rolling (on top of its own `alwaysFails()`); each of
   * `penaltyDice` is subtracted from the roll (`d20.plus(5).minus(1, d4)`); `vulnerable` doubles the
   * failure damage as a whole roll, the success unchanged. `autoHit` and `critOnHit` are attack
   * facts, and `joined` is ignored: a builder does not pool rider dice into its own roll.
   */
  under(context: RowContext, eps: number = 0): PMF {
    const own = this.rowCheck;
    const rollType = own.pinned ? own.rollType : context.rollType;
    const autoFail = own.autoFail || context.autoFail;
    let save: SaveBuilder = this;
    if (rollType !== own.rollType || autoFail !== own.autoFail || context.penaltyDice.length > 0) {
      if (rollType === "elven accuracy") {
        throw new RangeError("A save cannot roll with Elven Accuracy: it is only valid for attack rolls.");
      }
      const configs = this.check.getSubRollConfigs();
      const root = naturalRollIndex(configs);
      if (root !== -1) configs[root].rollType = rollType;
      let roll = new RollBuilder(configs);
      for (const { count, sides } of context.penaltyDice) roll = roll.minus(count, new RollBuilder(1).d(sides));
      let check = roll.dc(this.check.saveDC);
      const ability = this.check.saveAbility;
      if (ability !== undefined) check = check.ability(ability);
      if (autoFail) check = check.alwaysFails();
      save = new SaveBuilder(check, this.failureEffect, this.saveOutcome, this.attached);
    }
    return context.vulnerable ? save.resolveScaled(eps, 2).pmf : save.toPMF(eps);
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
    return this.resolveScaled(eps, 1);
  }

  /**
   * {@link resolve}, with the failure damage of `pmf` multiplied by `failScale` as a whole roll (2: a
   * vulnerable target, see {@link under}). The success and every other field are unscaled.
   */
  private resolveScaled(eps: number, failScale: 1 | 2): SaveResolution {
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
      .add(failLabel, failScale === 1 ? failPMF : failPMF.scaleDamage(failScale, "floor"), pfail);

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

  /** Expected damage of the save effect, from the exact PMF. */
  mean(): number {
    return this.pmf.mean();
  }

  // By default, create query on PMF with no pruning
  toQuery(eps: number = 0): DiceQuery {
    return this.toPMF(eps).query();
  }
}
