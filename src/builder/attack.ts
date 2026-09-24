import type { DiceMatchInfo, OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { diceSumDistribution, faceWeights, jointSumAndMatch } from "../common/bounce";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { AmbiguousCritDoublingError } from "../parser/scaleDice";
import type { ACBuilder } from "./ac";
import { pmfFromRollBuilder, resolveRootD20 } from "./ast";
import { splitAtThreshold } from "./prob";
import { checkExpression, rootDieExpression } from "./expression";
import { requireFinite } from "./arguments";
import {
  AlwaysCritBuilder,
  AlwaysHitBuilder,
  naturalRollIndex,
  ParsedRollBuilder,
  RollBuilder,
} from "./roll";
import type { AttackResolution, Check, CheckBuilder, RollConfig, RollType } from "./types";

type ActionEffect = RollBuilder;

/**
 * Resolved-attack PMF cache. `resolve()`/`toPMF()` re-runs the damage convolution + hit/crit/miss mixture
 * every call; a DPR sweep resolves the SAME attack thousands of times (dprcalc measured ~99.9% repeats).
 * Keyed by {@link AttackBuilder.cacheKey} — a cheap serialization of the check + effect {@link RollConfig}s
 * (NOT the AST-walking `toExpression`), which fully determines the PMF. `null` key ⇒ an effect opted out
 * (parsed/pooled/half/scale/max/composite) ⇒ resolve uncached. Cached PMFs are immutable (every PMF op
 * returns a new instance), so sharing is safe.
 */
const attackPMFCache = PMF.createCache(4000);

/** Clears the resolved-attack PMF cache (test/bench seam; mirrors {@link clearParserCache}). */
export function clearAttackCache(): void {
  attackPMFCache.clear();
}

export class AttackBuilder implements CheckBuilder {
  constructor(
    readonly check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder,
    private readonly hitEffect?: ActionEffect,
    private readonly critEffect?: ActionEffect | null,
    private readonly missEffect?: ActionEffect,
    // Extra damage channels convolved into hit AND crit — their dice double on a crit like any
    // attack damage — but excluded from base-payload transforms (rerollDamage/minimumDamageDie
    // here; the turn-level reroll substitution). Several `plusSeparateDamage()` calls accumulate.
    private readonly separateDamage: readonly RollBuilder[] = [],
    // The raw (uncapped) argument rerollDamage() was last called with, tracked separately from
    // the transformed dice so a second call with a DIFFERENT value is refused while a repeat of
    // the SAME value stays a no-op.
    private readonly rerollThreshold?: number,
    private readonly minimumDieValue?: number,
    private readonly halfOnMissFlag: boolean = false
  ) {}

  onCrit(val: number): AttackBuilder;
  onCrit(val: string): AttackBuilder;
  onCrit(val: RollBuilder): AttackBuilder;
  onCrit(count: number, die: RollBuilder): AttackBuilder;
  onCrit(count: number, sides: number): AttackBuilder;
  onCrit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onCrit(count: number, sides: number, modifier: number): AttackBuilder;
  onCrit(...args: any[]): AttackBuilder {
    // The explicit crit is base payload: carry any rerollDamage/minimumDamageDie already set, so
    // the result does not depend on whether onCrit() came before or after them.
    const damageRoll = this.withStoredBaseTransforms(RollBuilder.fromArgs(...args));
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      damageRoll,
      this.missEffect,
      this.separateDamage,
      this.rerollThreshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  onMiss(val: number): AttackBuilder;
  onMiss(val: string): AttackBuilder;
  onMiss(val: RollBuilder): AttackBuilder;
  onMiss(count: number, die: RollBuilder): AttackBuilder;
  onMiss(count: number, sides: number): AttackBuilder;
  onMiss(count: number, die: RollBuilder, modifier: number): AttackBuilder;
  onMiss(count: number, sides: number, modifier: number): AttackBuilder;
  onMiss(...args: any[]): AttackBuilder {
    if (this.halfOnMissFlag) {
      throw new Error(
        "onMiss() cannot be combined with halfOnMiss(): the miss branch can only be one or the other."
      );
    }
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      this.critEffect,
      damageRoll,
      this.separateDamage,
      this.rerollThreshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  noCrit(): AttackBuilder {
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      null,
      this.missEffect,
      this.separateDamage,
      this.rerollThreshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  /**
   * Adds a second damage channel, convolved into the hit AND crit payloads (its dice double on
   * a crit like any attack damage) but excluded from base-payload transforms — base-payload
   * rerolls and once-per-turn reroll substitutions never touch it. Chainable; several calls
   * accumulate into one convolved channel.
   */
  plusSeparateDamage(damage: RollBuilder): AttackBuilder {
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      this.critEffect,
      this.missEffect,
      [...this.separateDamage, damage],
      this.rerollThreshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  /**
   * Lets every die group of the BASE payload (hit, and the crit branch when it is explicit)
   * reroll low faces once, leaving `plusSeparateDamage` channels untouched — so a weapon reads in
   * whichever order the caller likes. The threshold is a permission cap, not an obligation: a
   * group rerolls faces `1..min(threshold, cap)`, where `cap` is the largest face whose kept value
   * `max(face, floor)` is below the expected value of a fresh floored face (`floor` from the
   * group's own `minimum` and {@link minimumDamageDie}; with no floor, `floor(sides / 2)`). For a
   * die that does not explode that is optimal play, and the result is monotone in `threshold`.
   * A group's own `reroll` is kept when it is higher. `RollBuilder.reroll()` keeps its own
   * obligation semantics; this is the attack-level verb.
   */
  rerollDamage(threshold: number): AttackBuilder {
    if (isNaN(threshold)) throw new Error("Invalid NaN value for rerollDamage threshold");
    requireFinite(threshold, "rerollDamage() threshold");
    if (this.rerollThreshold !== undefined) {
      if (threshold === this.rerollThreshold) return this;
      throw new Error(
        `Conflicting rerollDamage() threshold: already set to ${this.rerollThreshold}, cannot change to ${threshold}. Repeating the same value is a no-op.`
      );
    }
    const transform = AttackBuilder.baseTransform(threshold, this.minimumDieValue);
    return new AttackBuilder(
      this.check,
      this.hitEffect
        ? AttackBuilder.mapEveryDieGroup(this.hitEffect, "rerollDamage", transform)
        : this.hitEffect,
      this.critEffect
        ? AttackBuilder.mapEveryDieGroup(this.critEffect, "rerollDamage", transform)
        : this.critEffect,
      this.missEffect,
      this.separateDamage,
      threshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  /**
   * Raises every die of the BASE payload (hit, and the crit branch when it is explicit) to at
   * least `minimum`, leaving `plusSeparateDamage` channels untouched. A group's own higher
   * `minimum` is kept. Order-independent with respect to `plusSeparateDamage` and
   * `rerollDamage` (whose cap accounts for the floor).
   */
  minimumDamageDie(minimum: number): AttackBuilder {
    if (isNaN(minimum)) throw new Error("Invalid NaN value for minimumDamageDie");
    requireFinite(minimum, "minimumDamageDie()");
    if (this.minimumDieValue !== undefined) {
      if (minimum === this.minimumDieValue) return this;
      throw new Error(
        `Conflicting minimumDamageDie() value: already set to ${this.minimumDieValue}, cannot change to ${minimum}. Repeating the same value is a no-op.`
      );
    }
    const transform = AttackBuilder.baseTransform(this.rerollThreshold, minimum);
    return new AttackBuilder(
      this.check,
      this.hitEffect
        ? AttackBuilder.mapEveryDieGroup(this.hitEffect, "minimumDamageDie", transform)
        : this.hitEffect,
      this.critEffect
        ? AttackBuilder.mapEveryDieGroup(this.critEffect, "minimumDamageDie", transform)
        : this.critEffect,
      this.missEffect,
      this.separateDamage,
      this.rerollThreshold,
      minimum,
      this.halfOnMissFlag
    );
  }

  /**
   * The miss payload becomes `floor(resolved hit payload / 2)` — base plus every
   * `plusSeparateDamage` channel, never the crit payload. Labelled `missDamage`: it is not a
   * landing, so no `first-hit`/`every-hit`/condition trigger reads it, and no reroll
   * substitution touches it. Mutually exclusive with `onMiss()`.
   */
  halfOnMiss(): AttackBuilder {
    if (this.missEffect) {
      throw new Error(
        "halfOnMiss() cannot be combined with onMiss(): the miss branch can only be one or the other."
      );
    }
    if (this.halfOnMissFlag) return this;
    return new AttackBuilder(
      this.check,
      this.hitEffect,
      this.critEffect,
      this.missEffect,
      this.separateDamage,
      this.rerollThreshold,
      this.minimumDieValue,
      true
    );
  }

  /**
   * The one way to re-derive hit/crit/miss probabilities for an existing attack: `vsAC` and the
   * turn-level condition variants are both callers. Throws if this attack's check has no AC (an
   * `AlwaysHitBuilder`, or a crit-from-always-hit override) — there is nothing to rebind.
   */
  withCheck(fn: (check: Check) => Check): AttackBuilder {
    const next = fn(this.toCheck());
    return new AttackBuilder(
      AttackBuilder.buildCheck(next),
      this.hitEffect,
      this.critEffect,
      this.missEffect,
      this.separateDamage,
      this.rerollThreshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  private toCheck(): Check {
    const check = this.check;
    if (check instanceof AlwaysHitBuilder) {
      throw new Error(
        "withCheck() requires an AC-bearing check; this attack always hits with no AC to rebind."
      );
    }
    const ac = check.attackConfig.ac;
    if (ac === undefined) {
      throw new Error(
        "withCheck() requires an AC-bearing check; this attack's crit-on-hit override carries no AC."
      );
    }
    // Duck-typed rather than `instanceof ACBuilder`: importing the `ACBuilder` VALUE here would
    // reintroduce the ac.ts <-> attack.ts <-> roll.ts load cycle at a point where `RollBuilder`
    // is not yet defined (`ACBuilder extends RollBuilder` would throw). `advantageDice` is the
    // one field only `AttackConfig` (ACBuilder's own attackConfig shape) declares.
    const attackConfig = check.attackConfig;
    const rootConfig = check.getRootDieConfig();
    const rawRollType: RollType = rootConfig?.rollType ?? "flat";
    const fromElvenAccuracy = rawRollType === "elven accuracy";
    return {
      roll: new RollBuilder(check.getSubRollConfigs()),
      ac,
      critThreshold: check.critThreshold,
      rollType: fromElvenAccuracy ? "advantage" : rawRollType,
      advantageDice: fromElvenAccuracy
        ? 3
        : "advantageDice" in attackConfig
          ? attackConfig.advantageDice
          : 2,
      critOnHit: check instanceof AlwaysCritBuilder,
    };
  }

  private static buildCheck(next: Check): ACBuilder | AlwaysCritBuilder {
    if (isNaN(next.ac)) throw new Error("Invalid NaN value for AC in withCheck()");
    requireFinite(next.ac, "AC in withCheck()");
    requireFinite(next.critThreshold, "crit threshold in withCheck()");
    const configs = next.roll.getSubRollConfigs();
    let rewritten: readonly RollConfig[] = configs;
    if (configs.length > 0) {
      const rootIdx = naturalRollIndex(configs);
      const idx = rootIdx === -1 ? 0 : rootIdx;
      const updated = [...configs];
      updated[idx] = { ...updated[idx], rollType: next.rollType };
      rewritten = updated;
    }
    // `.ac()`/`.critOn()`/`.threeDiceAdvantage()` are the `RollBuilder`-prototype surface
    // `ac.ts` augments (the same seam that already keeps roll.ts/ac.ts load-order-safe) — using
    // it instead of `new ACBuilder(...)` avoids importing the `ACBuilder` value here.
    let ac = new RollBuilder(rewritten).ac(next.ac).critOn(next.critThreshold);
    if (next.advantageDice === 3) ac = ac.threeDiceAdvantage();
    return next.critOnHit ? ac.alwaysCrits() : ac;
  }

  /**
   * The base-payload transform for a `rerollDamage` threshold and a `minimumDamageDie` floor
   * (either may be unset). Each only ever raises a group's own `minimum`/`reroll`, and the reroll
   * cap reads the final floor, so applying it again after the other call lands on the same config
   * whichever order the two calls came in.
   */
  private static baseTransform(
    threshold: number | undefined,
    minimum: number | undefined
  ): (config: RollConfig) => RollConfig {
    return (config) => {
      const floor = minimum === undefined ? config.minimum : Math.max(config.minimum, minimum);
      if (threshold === undefined) return { ...config, minimum: floor };
      // Face f is worth rerolling iff max(f, floor) < E[max(X, floor)] = total / sides; the kept
      // value never falls as f rises, so the worthwhile faces are exactly 1..cap. Integer-exact.
      let total = 0;
      for (let f = 1; f <= config.sides; f++) total += Math.max(f, floor);
      let cap = 0;
      for (let f = 1; f <= config.sides; f++) {
        if (Math.max(f, floor) * config.sides < total) cap = f;
      }
      return { ...config, minimum: floor, reroll: Math.max(config.reroll, Math.min(threshold, cap)) };
    };
  }

  /** Applies the `rerollDamage`/`minimumDamageDie` values already set on this builder to `effect`. */
  private withStoredBaseTransforms(effect: ActionEffect): ActionEffect {
    if (this.rerollThreshold === undefined && this.minimumDieValue === undefined) return effect;
    return AttackBuilder.mapEveryDieGroup(
      effect,
      this.rerollThreshold !== undefined ? "rerollDamage" : "minimumDamageDie",
      AttackBuilder.baseTransform(this.rerollThreshold, this.minimumDieValue)
    );
  }

  /**
   * Shared by `rerollDamage`/`minimumDamageDie`: rewrite every die-bearing `RollConfig` of a
   * base-payload effect. Refuses (rather than silently no-oping) an effect with no real dice
   * descriptor — a parsed string or a half/scale/maxOf/pooled/composite wrapper — matching the
   * "refuse rather than approximate" bar the reroll substitution's `no-dice-descriptor` uses.
   */
  private static mapEveryDieGroup(
    effect: ActionEffect,
    methodName: string,
    mapConfig: (config: RollConfig) => RollConfig
  ): ActionEffect {
    if (effect.cacheKey() === null) {
      throw new Error(
        `${methodName}() requires a dice descriptor: a parsed string or a half/scale/maxOf/pooled/composite payload has none.`
      );
    }
    const configs = effect.getSubRollConfigs().map((c) => (c.sides > 0 ? mapConfig(c) : c));
    return new RollBuilder(configs);
  }

  /**
   * The attack as a string `parse()` reads back to the same outcomes, up to the natural-1 miss and
   * natural-20 hit, which the grammar does not model. The crit clause is always printed, since a
   * string without one crits with its hit dice doubled: `noCrit()` prints `xcrit0 (<hit>)` (no
   * natural face crits, so every landing is a hit), and a crit range keeps its `xcritN`. A check
   * that crits on every hit (`alwaysCrits()`) prints `xcritS`, S the natural die's size; one that
   * always hits prints just its natural roll, which never totals 0.
   */
  toExpression(): string {
    // The string grammar has no separate-damage channel and no "half the hit payload on a miss"
    // clause; rendering without them would round-trip to a different distribution.
    if (this.separateDamage.length > 0 || this.halfOnMissFlag) {
      throw new Error(
        "toExpression() cannot represent plusSeparateDamage() or halfOnMiss(): the expression grammar has no separate damage channel or half-on-miss clause. Use toPMF() instead."
      );
    }
    const check = this.check;
    const naturalRoll = rootDieExpression(check);
    let checkPart: string;
    if (check instanceof AlwaysCritBuilder && !check.fromAlwaysHit) {
      checkPart = `(${checkExpression(check)} AC ${check.attackConfig.ac ?? 0})`;
    } else if (check instanceof AlwaysHitBuilder || check instanceof AlwaysCritBuilder) {
      checkPart = naturalRoll ?? check.toExpression();
    } else {
      checkPart = check.toExpression();
    }

    let effectPart = "";

    if (this.hitEffect) {
      const hitExpression = this.hitEffect.toExpression();
      effectPart = `(${hitExpression})`;
      if (this.critEffect === null) {
        effectPart += ` xcrit0 (${hitExpression})`;
      } else {
        // A crit doubles the hit payload's dice — parsed and pooled payloads included.
        const critExpression = (this.critEffect ?? this.hitEffect.copy().doubleDice()).toExpression();
        const critThreshold = check.critThreshold;
        if (critThreshold < 1 || critThreshold > 20) {
          throw new Error(
            `Invalid crit threshold: ${critThreshold}. Must be between 1 and 20.`
          );
        }
        if (check instanceof AlwaysCritBuilder && naturalRoll !== undefined) {
          effectPart += ` xcrit${check.getRootDieConfig()!.sides} (${critExpression})`;
        } else if (critThreshold === 20) {
          effectPart += ` crit (${critExpression})`;
        } else {
          effectPart += ` xcrit${21 - critThreshold} (${critExpression})`;
        }
      }

      if (this.missEffect) {
        effectPart += ` miss (${this.missEffect.toExpression()})`;
      }
    }

    return `${checkPart} * ${effectPart}`;
  }

  /**
   * Hit, crit and miss weights of `check`. A natural 1 misses; a natural 20 hits and crits
   * whatever the AC, the crit threshold, or crit-on-hit; any other natural roll hits when the total
   * reaches the AC, and crits when it is in the crit range (or every hit crits: `alwaysCrits()`).
   * An always-hitting check crits on a natural 20 or in its crit range. A check with no die has no
   * natural roll, so it hits exactly when its flat total and bonus dice reach the AC and never
   * crits unless every hit does.
   */
  resolveProbabilities(
    check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder,
    eps: number = 0
  ): { pSuccess: number; pHit: number; pCrit: number; pMiss: number } {
    const critThreshold = check.critThreshold;
    const natural = resolveRootD20(check);
    // A dieless check's natural roll is a certain 0: never a natural 1 or 20, never in crit range.
    const inCritRange = (r: number): boolean => r === 20 || (r >= 1 && r >= critThreshold);

    if (check instanceof AlwaysCritBuilder && check.fromAlwaysHit) {
      return { pSuccess: 1, pHit: 0, pCrit: 1, pMiss: 0 };
    }

    if (check instanceof AlwaysHitBuilder) {
      let pCrit = 0;
      let pHit = 0;
      for (const [r, bin] of natural) {
        if (inCritRange(r)) pCrit += bin.p;
        else pHit += bin.p;
      }
      return { pSuccess: 1, pHit, pCrit, pMiss: 0 };
    }

    // An AC check, or one where every hit crits (`alwaysCrits()` / a crit-on-hit grant).
    const critOnHit = check instanceof AlwaysCritBuilder;
    const ac = check.attackConfig.ac ?? 0;
    const staticMod = check.modifier;
    const bonusDicePMFs = check.getBonusDicePMFs(check, eps);
    const bonusPMF = bonusDicePMFs.length
      ? PMF.convolveMany(bonusDicePMFs, eps)
      : PMF.delta(0, eps);

    let pcrit = 0;
    let phit = 0;
    let pmiss = 0;

    for (const [r, bin] of natural) {
      const pr = bin.p;
      if (pr <= 0) continue;

      if (r === 1) {
        pmiss += pr;
        continue;
      }
      if (r === 20) {
        pcrit += pr;
        continue;
      }

      // Any other roll has to reach the AC to hit at all, even inside an expanded crit range.
      const { atLeast, below } = splitAtThreshold(bonusPMF, ac - staticMod - r);
      if (critOnHit || inCritRange(r)) {
        pcrit += pr * atLeast;
      } else {
        phit += pr * atLeast;
      }
      pmiss += pr * below;
    }

    return { pSuccess: phit + pcrit, pHit: phit, pCrit: pcrit, pMiss: pmiss };
  }

  /** Resolves the attack into its weighted slices. `eps` defaults to 0, as for {@link toPMF}: no reachable damage value is pruned. */
  resolve(eps: number = 0): AttackResolution {
    const {
      pHit,
      pCrit,
      pMiss: pmiss,
    } = this.resolveProbabilities(this.check, eps);

    const toEffectPMF = (effect: ActionEffect): PMF =>
      effect instanceof ParsedRollBuilder
        ? effect.toPMF(eps)
        : pmfFromRollBuilder(effect, eps);

    const hitBasePMF = this.hitEffect ? toEffectPMF(this.hitEffect) : PMF.delta(0, eps);

    let critBasePMF: PMF | null = null;
    let phit = pHit;
    let pcrit = pCrit;

    if (this.critEffect === null) {
      critBasePMF = null;
      phit += pcrit;
      pcrit = 0;
    } else {
      // Every damage payload with dice doubles them on a crit — a parsed string by rewriting its
      // dice terms, a pool by doubling inside then pooling. Throws for a parsed payload that
      // contains an attack check, which is not damage.
      const critBuilder = this.critEffect ?? this.hitEffect?.copy().doubleDice();

      if (critBuilder) {
        critBasePMF = toEffectPMF(critBuilder);
      }
    }

    // `plusSeparateDamage` channels convolve into hit AND crit — their dice double on a crit like
    // any attack damage (including under an explicit `onCrit`, which overrides only the base
    // payload's crit branch, not the channel) — but never feed the base-payload transforms above.
    // `crit` is the crit payload whether or not any roll reaches it, so a zero-weight crit branch
    // still reads base ⊛ doubled channels. The one exception: when no roll can crit and a channel
    // has no single doubled form (a die rolled with advantage, an ambiguous keep), the branch
    // nobody reads is not forced through `doubleDice()`, and `crit`/`critSeparate` are `delta(0)`.
    const hasChannels = this.separateDamage.length > 0;
    const hitChannelsPMF = hasChannels
      ? PMF.convolveMany(this.separateDamage.map((r) => toEffectPMF(r)), eps)
      : null;
    let critChannelsPMF: PMF | null = null;
    let critPMF: PMF | null = critBasePMF;
    if (critBasePMF !== null && hasChannels) {
      try {
        critChannelsPMF = PMF.convolveMany(
          this.separateDamage.map((r) => toEffectPMF(r.copy().doubleDice())),
          eps
        );
        critPMF = PMF.convolveMany([critBasePMF, critChannelsPMF], eps);
      } catch (error) {
        if (pcrit > 0 || !(error instanceof AmbiguousCritDoublingError)) throw error;
        critPMF = null;
      }
    }

    const hitPMF = hitChannelsPMF
      ? PMF.convolveMany([hitBasePMF, hitChannelsPMF], eps)
      : hitBasePMF;

    let missPMF: PMF;
    let missIsDamage: boolean;
    if (this.halfOnMissFlag) {
      // Half of the RESOLVED hit payload (base + every separate channel), never the crit
      // payload — computed after `hitPMF` above, not from `hitBasePMF`.
      missPMF = hitPMF.scaleDamage(0.5, "floor");
      missIsDamage = true;
    } else if (this.missEffect) {
      missPMF = toEffectPMF(this.missEffect);
      missIsDamage = true;
    } else {
      missPMF = PMF.delta(0, eps);
      missIsDamage = false;
    }

    // Weight the hit/crit/miss PMFs into the final mixture.
    const mix = new Mixture<OutcomeType>(eps);
    if (phit > 0) mix.add("hit", hitPMF, phit);
    if (critPMF && pcrit > 0) mix.add("crit", critPMF, pcrit);
    if (pmiss > 0) mix.add(missIsDamage ? "missDamage" : "missNone", missPMF, pmiss);

    return {
      pmf: mix.buildPMF(eps) ?? PMF.delta(0, eps),
      check: this.check.toPMF(eps) ?? PMF.delta(0, eps),
      hit: hitPMF ?? PMF.delta(0, eps),
      crit: critPMF ?? PMF.delta(0, eps),
      miss: missPMF ?? PMF.delta(0, eps),
      weights: { hit: phit, crit: pcrit, miss: pmiss },
      hitBase: hitBasePMF,
      critBase: critBasePMF ?? PMF.delta(0, eps),
      hitSeparate: hitChannelsPMF ?? PMF.delta(0, eps),
      critSeparate: critChannelsPMF ?? PMF.delta(0, eps),
    };
  }

  /**
   * For `dice-match` trigger slicing (`turn/types.ts`'s `HasDiceMatchInfo`): the exact
   * per-damage-value match probability for the hit and crit branches, or `null` per branch when no
   * descriptor is available — a string-parsed effect, a wrapped transform whose PMF isn't fully
   * captured by its `RollConfig`s (half/scale/maxOf/pooled — `cacheKey()` returns `null` for
   * exactly these), a `keep`/`bestOf` pool (ambiguous "the dice" under crit doubling), an
   * exploding pool (per-die `explode` or a pool-wide budget: extra dice join the total), a pool
   * rolled with advantage/disadvantage (one kept die, not a pool), a subtracted pool (its faces
   * lower the damage), a multi-die-type pool, or (crit) `noCrit()`. A single die is supported and
   * can never match (an empty map).
   *
   * The crit branch is built from the SAME crit-effect selection `resolve()` uses (an explicit
   * `onCrit` roll, or the hit dice auto-doubled via `copy().doubleDice()`), so its descriptor
   * reflects the crit branch's REAL doubled pool, not the hit pool re-used blindly.
   *
   * Reads ONLY `hitEffect`/`critEffect` (the base pool) — `plusSeparateDamage` channels are a
   * separate channel, so their dice never count toward a match.
   */
  diceMatchInfo(_eps: number = EPS): { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } {
    const hit = this.matchInfoForEffect(this.hitEffect);

    let critEffect: RollBuilder | undefined;
    if (this.critEffect === null) {
      critEffect = undefined; // noCrit(): no separate crit branch
    } else if (this.critEffect) {
      critEffect = this.critEffect;
    } else if (this.hitEffect instanceof ParsedRollBuilder) {
      critEffect = undefined; // string-parsed hit: no dice descriptor on either branch
    } else {
      try {
        critEffect = this.hitEffect?.copy().doubleDice();
      } catch (error) {
        // An ambiguous keep or advantage payload has no doubled crit, so no crit descriptor either.
        if (!(error instanceof AmbiguousCritDoublingError)) throw error;
      }
    }
    const crit = this.matchInfoForEffect(critEffect);

    return { hit, crit };
  }

  private matchInfoForEffect(effect: RollBuilder | undefined): DiceMatchInfo | null {
    if (!effect || effect instanceof ParsedRollBuilder) return null;
    // `cacheKey() === null` is exactly the signal this class already uses for "PMF not fully
    // captured by subRollConfigs" (half/scale/maxOf/pooled/composite) — the same condition that
    // would make treating getSubRollConfigs() as the branch's real dice pool WRONG here.
    if (effect.cacheKey() === null) return null;

    const diceConfigs = effect.getSubRollConfigs().filter((c) => c.sides > 0);
    if (diceConfigs.length !== 1) return null;
    const config = diceConfigs[0];
    if (config.keep || config.bestOf > 0) return null;
    if (config.explode > 0 || config.explodePoolBudget > 0) return null;
    if (config.rollType !== "flat") return null;
    if (config.isSubtraction || config.count < 0) return null;

    // A single die is a SUPPORTED source that can simply never match — `null` is reserved for
    // "no descriptor available at all" (parsed/pooled/keep/bestOf/exploding). Conflating the two
    // previously made a valid 1-die hit pool with an auto-doubled 2-die crit pool (which CAN
    // match) throw `no-dice-descriptor` on the hit branch alone. An empty map still answers every
    // `matchProbabilityByDamage.get(d) ?? 0` lookup with the correct zero.
    if (config.count <= 1) return { matchProbabilityByDamage: new Map() };

    const weights = faceWeights(config.sides, config.minimum, config.reroll);
    const totalDist = diceSumDistribution(config.count, weights);
    const joint = jointSumAndMatch(config.count, weights);
    const modifier = effect.modifier;

    const matchProbabilityByDamage = new Map<number, number>();
    for (const [sum, totalMass] of totalDist) {
      if (totalMass <= 0) continue;
      const matchMass = joint.get(sum) ?? 0;
      matchProbabilityByDamage.set(sum + modifier, matchMass / totalMass);
    }

    return { matchProbabilityByDamage };
  }

  /**
   * A cheap, complete key for this attack's resolved PMF, or `null` when it can't be cached soundly (an
   * effect whose PMF isn't captured by its {@link RollConfig}s — see {@link RollBuilder.cacheKey}). Composed
   * from the check + hit/crit/miss effect keys + `eps`. `critEffect === null` (noCrit) and `undefined`
   * (auto-double the hit dice) are distinct crit states, encoded separately.
   */
  private cacheKey(eps: number): string | null {
    const checkKey = this.check.cacheKey();
    if (checkKey === null) return null;

    let hitKey = "";
    if (this.hitEffect) {
      const k = this.hitEffect.cacheKey();
      if (k === null) return null;
      hitKey = k;
    }

    let critKey: string;
    if (this.critEffect === null) critKey = "n";
    else if (this.critEffect === undefined) critKey = "a";
    else {
      const k = this.critEffect.cacheKey();
      if (k === null) return null;
      critKey = k;
    }

    let missKey = "";
    if (this.missEffect) {
      const k = this.missEffect.cacheKey();
      if (k === null) return null;
      missKey = k;
    }

    let channelsKey = "";
    for (const r of this.separateDamage) {
      const k = r.cacheKey();
      if (k === null) return null;
      channelsKey += `|${k}`;
    }

    return `${checkKey}*H${hitKey}*C${critKey}*M${missKey}*S${channelsKey}*half${
      this.halfOnMissFlag ? 1 : 0
    }*e${eps}`;
  }

  // By default, create PMF with no pruning. Cached by the cheap config key across identical rebuilds.
  toPMF(eps: number = 0): PMF {
    const key = this.cacheKey(eps);
    if (key === null) return this.resolve(eps).pmf;
    const cached = attackPMFCache.get(key);
    if (cached) return cached;
    const pmf = this.resolve(eps).pmf;
    attackPMFCache.set(key, pmf);
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
