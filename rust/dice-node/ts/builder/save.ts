import type { Rng } from "../../../../src/common/rng";
import { IGNORES_JOINED } from "../../../../src/turn/context";
import type { RowCheck, RowContext } from "../../../../src/turn/types";
import type { SampledDie } from "../../../../src/builder/sample";
import type { AbilityName } from "../../../../src/builder/types";
import type { AttachedCondition } from "../../../../src/builder/attack";
import { EPS } from "../../../../src/common/types";
import { native, type NativePmfHandle, type NativeSaveHandle } from "../native";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { isGrant, lastingHandle } from "../turn/effects";
import type { DCBuilder } from "./roll";
import { RollBuilder, wrapRoll } from "./roll";

export type SaveOutcome = "normal" | "half";

/**
 * Facade over the Rust `NativeSave` (rust/dice-node/src/save.rs): one native call per method.
 * Not carried over from the TS: the resolved-save PMF cache (the Rust crate owns caching) and the
 * `failScale` constructor argument (only `rollUnder` makes a scaled save).
 * `sample` calls back into JS synchronously for the rng; a throw in `rng` is rethrown after the
 * native call returns.
 */

/** Empties the Rust resolved-save PMF cache. */
export function clearSaveCache(): void {
  native.clearCache("save");
}

/** One roll of a save: the enemy's check dice, the payload dice and what landed. */
export interface SaveSample {
  outcome: "save-fail" | "save-pass";
  check: SampledDie[];
  damage: SampledDie[];
  total: number;
}

interface NativeContext {
  rollType: string;
  autoHit: boolean;
  critOnHit: boolean;
  autoFail: boolean;
  vulnerable: boolean;
  penaltyDice: { count: number; sides: number }[];
  joined: string[];
}

function contextIn(context: RowContext): NativeContext {
  return { ...context, penaltyDice: context.penaltyDice.map((p) => ({ ...p })), joined: [...context.joined] };
}

function argIn(arg: unknown): unknown {
  return arg instanceof RollBuilder ? arg._handle : arg;
}

/** `SaveResolution` over the facade's PMF. */
export interface SaveResolution {
  pmf: PMF;
  check: PMF;
  saveFail: PMF;
  saveSuccess: PMF;
  weights: { success: number; fail: number };
}

export class SaveBuilder {
  /** @internal */
  _handle!: NativeSaveHandle;

  /**
   * Conditions a failed save applies in a turn (see {@link DCBuilder.onSaveFailure}). Kept on the facade (as
   * `AttackBuilder.attached` is): the native save carries its own copy for Rust-side evaluation, this one
   * is what the TS `Turn` reads and keeps the caller's `Lasting` objects.
   */
  readonly attached!: readonly AttachedCondition[];

  /**
   * @param check the DC check
   * @param failureEffect what a failed save deals; none means a failure deals 0
   * @param saveOutcome what a success deals: nothing (`"normal"`), the failure payload halved and floored
   *   (`"half"`), or a payload of its own (a {@link RollBuilder}, see {@link onSaveSuccess}); never both
   * @param attached conditions a failed save applies in a turn (see {@link DCBuilder.onSaveFailure})
   */
  constructor(
    check: DCBuilder,
    failureEffect?: RollBuilder,
    saveOutcome: SaveOutcome | RollBuilder = "normal",
    attached: readonly AttachedCondition[] = [],
    failScale: 1 | 2 = 1
  ) {
    if (failScale !== 1) {
      throw new Error("SaveBuilder: failScale is not supported by the constructor of the Rust facade (rollUnder sets it)");
    }
    this.attached = attached;
    this._handle =
      saveOutcome instanceof RollBuilder
        ? native.NativeSave.fromPayload(check._handle, failureEffect?._handle, saveOutcome._handle)
        : native.NativeSave.fromParts(check._handle, failureEffect?._handle, saveOutcome === "half");
  }

  /** @internal */
  static _wrap(handle: NativeSaveHandle, attached: readonly AttachedCondition[] = []): SaveBuilder {
    const s = Object.create(SaveBuilder.prototype) as SaveBuilder;
    s._handle = handle;
    (s as { attached: readonly AttachedCondition[] }).attached = attached;
    return s;
  }

  /** @internal `dc.onSaveFailure(...args)`. */
  static _fromDcFailure(dc: DCBuilder, args: unknown[]): SaveBuilder {
    const [first] = args;
    if (args.length === 1 && (Array.isArray(first) || isGrant(first))) {
      const parts: readonly unknown[] = Array.isArray(first) ? first : [first];
      const grants = parts.filter(isGrant);
      const damage = parts.filter((part) => !isGrant(part)).map(argIn);
      const attached: AttachedCondition[] =
        grants.length === 0 ? [] : [{ on: "every-hit", grants, gate: { landing: "fail" } }];
      return SaveBuilder._wrap(dc._handle.onSaveFailureEffects(grants.map(lastingHandle), damage), attached);
    }
    return SaveBuilder._wrap(dc._handle.onSaveFailure(args.map(argIn)));
  }

  /** The DC check. */
  get check(): DCBuilder {
    return wrapRoll(this._handle.check()) as DCBuilder;
  }

  /**
   * A success deals the failure payload halved, rounded down. Mutually exclusive with {@link onSaveSuccess}, as
   * `halfOnMiss()` is with `onMiss()`: the success can be one or the other, so this throws after `onSaveSuccess()`.
   */
  saveHalf(): SaveBuilder {
    return SaveBuilder._wrap(this._handle.saveHalf(), this.attached);
  }

  /**
   * A success deals a payload of its own, where `saveHalf()` fixes it at half the failure. The arguments are
   * `onSaveFailure`'s: a number, a string, a `RollBuilder`, `(count, die)`, `(count, sides)` or either with a
   * modifier. A second `onSaveSuccess` replaces the first; it throws after `saveHalf()`.
   */
  onSaveSuccess(val: number): SaveBuilder;
  onSaveSuccess(val: string): SaveBuilder;
  onSaveSuccess(val: RollBuilder): SaveBuilder;
  onSaveSuccess(count: number, die: RollBuilder): SaveBuilder;
  onSaveSuccess(count: number, sides: number): SaveBuilder;
  onSaveSuccess(count: number, die: RollBuilder, modifier: number): SaveBuilder;
  onSaveSuccess(count: number, sides: number, modifier: number): SaveBuilder;
  onSaveSuccess(...args: unknown[]): SaveBuilder {
    return SaveBuilder._wrap(this._handle.onSaveSuccess(args.map(argIn)), this.attached);
  }

  /** The save's ability (`"con"` or `"constitution"`): see {@link DCBuilder.ability}. */
  ability(name: AbilityName): SaveBuilder {
    return SaveBuilder._wrap(this._handle.ability(name), this.attached);
  }

  /** The save fails without rolling: see {@link DCBuilder.alwaysFails}. */
  alwaysFails(): SaveBuilder {
    return SaveBuilder._wrap(this._handle.alwaysFails(), this.attached);
  }

  /** No grant or condition in a turn changes this save's roll type: see {@link RollBuilder.pinned}. */
  pinned(): SaveBuilder {
    return SaveBuilder._wrap(this._handle.pinned(), this.attached);
  }

  /** What this save declares to a turn (`ContextualSource`): its ability, roll type, `pinned` and `alwaysFails()`. */
  get rowCheck(): RowCheck {
    const c = this._handle.rowCheck() as {
      ability?: string | null;
      rollType: RowCheck["rollType"];
      advantageDice: RowCheck["advantageDice"];
      pinned: boolean;
      autoHit: boolean;
      autoCrit: boolean;
      autoFail: boolean;
    };
    return {
      kind: "save",
      ...(c.ability === undefined || c.ability === null ? {} : { ability: c.ability as RowCheck["ability"] }),
      rollType: c.rollType,
      advantageDice: c.advantageDice,
      pinned: c.pinned,
      autoHit: c.autoHit,
      autoCrit: c.autoCrit,
      autoFail: c.autoFail,
    };
  }

  /**
   * This save's outcome-labelled PMF (as {@link toPMF}, at `eps`) re-derived in a turn's `context`
   * (roll type, `autoFail`, `penaltyDice`, `vulnerable`; `joined` is ignored).
   */
  under(context: RowContext, eps: number = 0): PMF {
    // As the TS: a context that changes nothing is this save, whose `toPMF` is one PMF per key.
    return this.rollUnder(context).toPMF(eps);
  }

  /** This save with its check rolled in `context`, a vulnerable context's doubling baked in: its PMF is exactly `under(context)`. */
  rollUnder(context: RowContext): SaveBuilder {
    const moved = this._handle.rollUnder(contextIn(context));
    return moved === null || moved === undefined ? this : SaveBuilder._wrap(moved, this.attached);
  }

  /** One roll of this save as {@link under} weighs it: the enemy's check, the failure dice, then an `onSaveSuccess` payload on a pass. */
  sample(rng: Rng, context?: RowContext): SaveSample {
    return this._handle.sample(
      (n: number) => rng.die(n),
      (p: number) => rng.chance(p),
      context === undefined ? undefined : contextIn(context)
    ) as SaveSample;
  }

  /** The save as an expression string that `parse()` reads back to this save's distribution. */
  toExpression(): string {
    return this._handle.toExpression();
  }

  /** The save's outcome: `check`, `weights`, `saveFail` and `saveSuccess`. */
  resolve(eps: number = EPS): SaveResolution {
    const r = this._handle.resolve(eps) as {
      pmf: NativePmfHandle;
      check: NativePmfHandle;
      saveFail: NativePmfHandle;
      saveSuccess: NativePmfHandle;
      weights: { success: number; fail: number };
    };
    return {
      pmf: PMF._wrap(r.pmf),
      check: PMF._wrap(r.check),
      saveFail: PMF._wrap(r.saveFail),
      saveSuccess: PMF._wrap(r.saveSuccess),
      weights: { success: r.weights.success, fail: r.weights.fail },
    };
  }

  // By default, create PMF with no pruning.
  toPMF(eps: number = 0): PMF {
    return PMF._wrapShared(this._handle.toPmf(eps));
  }

  get pmf(): PMF {
    return PMF._wrapShared(this._handle.pmf());
  }

  /** Expected damage of the save effect, from the exact PMF. */
  mean(): number {
    return this._handle.mean();
  }

  // By default, create query on PMF with no pruning
  toQuery(eps: number = 0): DiceQuery {
    return this.toPMF(eps).query();
  }
}

// On the prototype: saves made by `_wrap` (Object.create) skip field initializers.
/** A turn rolls no rider's dice into this row (`Rider.joins`): `under` ignores `context.joined`. */
Object.defineProperty(SaveBuilder.prototype, IGNORES_JOINED, { value: true });
