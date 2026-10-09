import { PMF } from "../pmf/pmf";
import { resolveRootD20 } from "./ast";
import { splitAtThreshold } from "./prob";
import { requireFinite } from "./arguments";
import { naturalRollIndex, RollBuilder } from "./roll";
import { SaveBuilder } from "./save";
import type { AttachedCondition } from "./attack";
import type { Lasting } from "../turn/effects";
import { isGrant } from "../turn/effects";
import type { Ability, AbilityName } from "./types";
import type { RowContext } from "../turn/types";

interface SaveConfig {
  dc: number;
  /** `ability()`: the save's ability, by its full name. A row fact; the PMF does not read it. */
  ability?: Ability;
  /** `alwaysFails()`: the save fails without rolling. */
  autoFail?: true;
}

const ABILITIES: Readonly<Record<AbilityName, Ability>> = {
  str: "strength",
  dex: "dexterity",
  con: "constitution",
  int: "intelligence",
  wis: "wisdom",
  cha: "charisma",
  strength: "strength",
  dexterity: "dexterity",
  constitution: "constitution",
  intelligence: "intelligence",
  wisdom: "wisdom",
  charisma: "charisma",
};

/** The full ability name for `name`; a `TypeError` naming the value for anything else. */
function abilityOf(name: AbilityName): Ability {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(ABILITIES, name)) {
    throw new TypeError(
      `ability(${typeof name === "string" ? JSON.stringify(name) : String(name)}): expected str, dex, con, int, wis or cha, or a full name (strength, dexterity, constitution, intelligence, wisdom, charisma).`
    );
  }
  return ABILITIES[name];
}

/**
 * DC-check PMF cache. The two-outcome success/fail PMF is re-derived on every `toPMF()`, and a save-based
 * DPR sweep asks for the SAME check thousands of times. Keyed by {@link DCBuilder.cacheKey} + `eps`.
 */
const dcPMFCache = PMF.createCache(4000);

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
    if (isNaN(saveDC)) throw new Error("Invalid NaN value for saveDC");
    requireFinite(saveDC, "dc()");
    if (this.rollType && this.rollType === "elven accuracy") {
      throw new Error(
        "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead."
      );
    }
    return new DCBuilder(this, { ...this.saveConfig, dc: saveDC });
  }

  get saveDC(): number {
    return this.saveConfig.dc;
  }

  /** The save's ability, by its full name, or `undefined` when {@link ability} was never called. */
  get saveAbility(): Ability | undefined {
    return this.saveConfig.ability;
  }

  /** Whether {@link alwaysFails} was called: the save fails without rolling. */
  get autoFail(): boolean {
    return this.saveConfig.autoFail === true;
  }

  /**
   * The save's ability, for a turn's condition rules keyed by ability (Paralyzed fails Strength
   * and Dexterity saves): `"con"` or `"constitution"`, stored as the full name. A row fact: the
   * save's distribution does not change. Anything else throws a `TypeError`.
   */
  ability(name: AbilityName): DCBuilder {
    return new DCBuilder(this, { ...this.saveConfig, ability: abilityOf(name) });
  }

  /** The save fails without rolling: its failure chance is 1, whatever the roll and the DC. */
  alwaysFails(): DCBuilder {
    if (this.saveConfig.autoFail) return this;
    return new DCBuilder(this, { ...this.saveConfig, autoFail: true });
  }

  /** See {@link RollBuilder.pinned}; keeps the DC and the save's facts. */
  override pinned(): DCBuilder {
    return new DCBuilder(new RollBuilder(this.pinnedConfigs()), this.saveConfig);
  }

  /**
   * Whether this check is a lone d20 plus a flat bonus and nothing else: no bonus or penalty dice, no
   * reroll or other die option, not {@link pinned} and not {@link alwaysFails}. Exactly what a plain
   * `{ dc, bonus, rollType }` save spells.
   */
  get isPlainSave(): boolean {
    if (this.saveConfig.autoFail) return false;
    const configs = this.getSubRollConfigs();
    const root = naturalRollIndex(configs);
    if (root === -1) return false;
    const { sides, count, reroll, explode, explodePoolBudget, minimum, bestOf, keep, pinned } = configs[root];
    if (sides !== 20 || count !== 1 || reroll || explode || explodePoolBudget || minimum || bestOf || keep || pinned) {
      return false;
    }
    return configs.every((config, index) => index === root || config.sides === 0 || config.count === 0);
  }

  /**
   * This check rolled in a turn's row context, as a save row rolls: the natural roll takes `rollType`
   * literally, each of `penaltyDice` comes off the roll (`d20.plus(5).minus(1, d4)`), and `autoFail`
   * makes it fail without rolling (on top of its own {@link alwaysFails}). The DC and ability are kept.
   */
  rolledIn(context: Pick<RowContext, "rollType" | "autoFail" | "penaltyDice">): DCBuilder {
    if (context.rollType === "elven accuracy") {
      throw new RangeError("A save cannot roll with Elven Accuracy: it is only valid for attack rolls.");
    }
    const configs = this.getSubRollConfigs();
    const root = naturalRollIndex(configs);
    if (root !== -1) configs[root].rollType = context.rollType;
    let roll = new RollBuilder(configs);
    for (const { count, sides } of context.penaltyDice) roll = roll.minus(count, new RollBuilder(1).d(sides));
    const autoFail = this.saveConfig.autoFail || context.autoFail;
    return new DCBuilder(roll, { ...this.saveConfig, ...(autoFail ? { autoFail: true } : {}) });
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
  /**
   * Effects with a lifetime in the list, beside at most one damage roll, apply in a turn on a
   * failed save: `onSaveFailure([roll(8, d6), prone().untilEndOfTurn()])` is the condition
   * `{ on: "every-hit", of: [this save], landing: "fail" }`.
   */
  onSaveFailure(effects: Lasting | readonly (RollBuilder | Lasting)[]): SaveBuilder;
  onSaveFailure(...args: any[]): SaveBuilder {
    const [first] = args;
    if (args.length === 1 && (Array.isArray(first) || isGrant(first))) {
      const parts: readonly unknown[] = Array.isArray(first) ? first : [first];
      const grants = parts.filter(isGrant);
      const damage = parts.filter((part) => !isGrant(part));
      if (damage.length > 1) {
        throw new Error("onSaveFailure takes at most one damage roll beside its effects; add the rolls together.");
      }
      const [roll] = damage;
      const attached: AttachedCondition[] =
        grants.length === 0 ? [] : [{ on: "every-hit", grants, gate: { landing: "fail" } }];
      return new SaveBuilder(this, roll === undefined ? undefined : RollBuilder.fromArgs(roll), "normal", attached);
    }
    const damageRoll = RollBuilder.fromArgs(...args);
    return new SaveBuilder(this, damageRoll);
  }

  override withElvenAccuracy(): never {
    throw new Error(
      "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks)."
    );
  }

  // Legacy expressions. The grammar has no "always fails" clause; printing the DC would round-trip
  // to a save that can pass.
  override toExpression(): string {
    if (this.saveConfig.autoFail) {
      throw new Error("toExpression() cannot represent alwaysFails(): the expression grammar has no always-fail clause. Use toPMF() instead.");
    }
    const subConfigs = this.getSubRollConfigs();
    const allConfigs = [...subConfigs];
    const expression = new RollBuilder(allConfigs).toExpression();
    return `(${expression} DC ${this.saveConfig.dc})`;
  }

  /**
   * The DC check's PMF is fully determined by the save DC, `alwaysFails()`, plus everything `toPMF`
   * below reads off the roll configs (`rollType`, `baseReroll`, `modifier`, bonus dice) — all of which
   * `super.cacheKey()` already serializes. So extend the base key, mirroring {@link AlwaysHitBuilder.cacheKey}.
   */
  override cacheKey(): string | null {
    const base = super.cacheKey();
    return base === null ? null : `DC|${this.saveConfig.dc}|${this.saveConfig.autoFail ? "F|" : ""}${base}`;
  }

  /**
   * P(success) and P(failure) of this save: success iff natural roll + bonus dice + modifier ≥ DC,
   * with no natural-1/natural-20 rule (a check with no die compares its flat total alone). Each side
   * is summed from its own outcomes, so a certain success has a failure chance of exactly 0. Under
   * {@link alwaysFails} the failure chance is 1.
   */
  saveProbabilities(): { pSuccess: number; pFail: number } {
    if (this.saveConfig.autoFail) return { pSuccess: 0, pFail: 1 };
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
  return new DCBuilder(this).dc(saveDC);
};
