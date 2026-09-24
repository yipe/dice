import { PMF } from "../pmf/pmf";
import { AttackBuilder } from "./attack";
import { resolveRootD20 } from "./ast";
import { AlwaysCritBuilder, RollBuilder } from "./roll";
import type { RollConfig, RollType } from "./types";

export interface AttackConfig {
  ac: number;
  critThreshold: number;
  // Attacker property (R30), not a roll type: how many dice a NET advantage rolls. Persists
  // across `withCheck` re-derivations, whether the advantage came from this source's own roll
  // type or was granted later (`combine()` below). Default 2.
  advantageDice: 2 | 3;
}

/**
 * R30: combine a source's own roll type with granted advantage/disadvantage flags by
 * cancellation — `{advantage, disadvantage}` from any combination of source and grants resolve
 * to `advantage` / `disadvantage` / `flat`. `advantageDice` governs how many dice a NET
 * advantage rolls, whether the advantage came from `rollType` itself or from `flags`. Pure;
 * independently testable against the full 3×2×4 table.
 */
export function combine(
  rollType: RollType,
  advantageDice: 2 | 3,
  flags: { advantage: boolean; disadvantage: boolean }
): { rollType: RollType; dice: number } {
  const ownAdvantage = rollType === "advantage" || rollType === "elven accuracy";
  const ownDisadvantage = rollType === "disadvantage";
  const netAdvantage = ownAdvantage || flags.advantage;
  const netDisadvantage = ownDisadvantage || flags.disadvantage;

  if (netAdvantage && netDisadvantage) return { rollType: "flat", dice: 1 };
  if (netAdvantage) return { rollType: "advantage", dice: advantageDice };
  if (netDisadvantage) return { rollType: "disadvantage", dice: 2 };
  return { rollType: "flat", dice: 1 };
}

export class ACBuilder extends RollBuilder {
  readonly attackConfig: AttackConfig;

  constructor(baseRoll: RollBuilder, ac: number, attackConfig?: AttackConfig) {
    super(baseRoll.getSubRollConfigs());

    if (attackConfig) {
      this.attackConfig = { ...attackConfig, ac };
    } else {
      this.attackConfig = { ac, critThreshold: 20, advantageDice: 2 };
    }
  }

  //   onHit(effect: RollBuilder): AttackBuilder {
  //     return new AttackBuilder(this).onHit(effect)
  //   }

  onHit(val: number): AttackBuilder;
  onHit(val: string): AttackBuilder;
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

  /**
   * R30: three-dice advantage is an attacker property, not a roll type. Setting it now applies
   * whenever the NET result later resolves to advantage — whether this source already has
   * advantage baked in, or advantage is granted afterward (via `withCheck`).
   */
  threeDiceAdvantage(): ACBuilder {
    if (this.attackConfig.advantageDice === 3) return this;
    return new ACBuilder(this, this.attackConfig.ac, {
      ...this.attackConfig,
      advantageDice: 3,
    });
  }

  /**
   * The dice configs with `advantageDice` mechanically folded in (`elven accuracy` in place of
   * `advantage` when the net roll should use 3 dice). Shared by every consumer that needs the
   * REAL resolvable dice rather than the raw stored config: {@link getRootDieConfig} (read by
   * `rollType`/`resolveRootD20`) and {@link alwaysCrits} (whose target class has no override).
   */
  private resolvedConfigs(): readonly RollConfig[] {
    const configs = this.getSubRollConfigs();
    if (configs.length === 0) return configs;
    const rootIdx = configs.findIndex((c) => c.sides > 0);
    const idx = rootIdx === -1 ? 0 : rootIdx;
    // `elven accuracy` (the AST layer's only 3-dice-advantage shape) only ever replaces an
    // already-`advantage` root — never downgrades a config that already reads `elven accuracy`
    // directly (the legacy `withElvenAccuracy()` path stays untouched).
    const mech =
      configs[idx].rollType === "advantage" && this.attackConfig.advantageDice === 3
        ? "elven accuracy"
        : configs[idx].rollType;
    if (mech === configs[idx].rollType) return configs;
    const updated = [...configs];
    updated[idx] = { ...updated[idx], rollType: mech };
    return updated;
  }

  override getRootDieConfig(): RollConfig | undefined {
    const configs = this.resolvedConfigs();
    return configs.find((c) => c.sides > 0) || configs[0];
  }

  override cacheKey(): string | null {
    const base = super.cacheKey();
    return base === null
      ? null
      : `A|${this.attackConfig.ac}|${this.attackConfig.critThreshold}|${this.attackConfig.advantageDice}|${base}`;
  }

  // TODO - move this to AC Builder… or if we create a DC builder that has critOn, throw an error?
  critOn(threshold: number): ACBuilder {
    const newConfig: AttackConfig = {
      ...this.attackConfig,
      critThreshold: threshold,
    };
    return new ACBuilder(this, this.attackConfig.ac, newConfig);
  }

  alwaysCrits(): AlwaysCritBuilder {
    const resolvedBase = new RollBuilder(this.resolvedConfigs());
    return new AlwaysCritBuilder(
      resolvedBase,
      {
        critThreshold: this.attackConfig.critThreshold,
        ac: this.attackConfig.ac,
      },
      false
    );
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
    const d20 = resolveRootD20(this);
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

  /** R18: accepts a replacement AC (today's took no argument — `vsAC` needs to rebind it). */
  override copy(ac?: number): ACBuilder {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const newConfig: AttackConfig = {
      ac: ac ?? this.attackConfig.ac,
      critThreshold: this.attackConfig.critThreshold,
      advantageDice: this.attackConfig.advantageDice,
    };
    return new ACBuilder(baseCopy, newConfig.ac, newConfig);
  }
}

// Augment the RollBuilder prototype to implement the ac method
RollBuilder.prototype.ac = function (targetAC: number): ACBuilder {
  if (isNaN(targetAC)) throw new Error("Invalid NaN value for targetAC");
  return new ACBuilder(this, targetAC);
};
