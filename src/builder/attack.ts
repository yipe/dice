import type { DiceMatchInfo, OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { diceSumDistribution, faceWeights, jointSumAndMatch } from "../common/bounce";
import { LRUCache } from "../common/lru-cache";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import { AmbiguousCritDoublingError } from "../parser/scaleDice";
import type { ACBuilder } from "./ac";
import { pmfFromRollBuilder, resolveRootD20 } from "./ast";
import {
  AlwaysCritBuilder,
  AlwaysHitBuilder,
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
const attackPMFCache = new LRUCache<string, PMF>(4000);

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
    // R14: extra damage channels convolved into hit AND crit (doubling like any attack damage
    // on a crit) but excluded from base-payload transforms (rerollDamage/minimumDamageDie here;
    // the turn-level reroll substitution). Several `plusSeparateDamage()` calls accumulate.
    private readonly separateDamage: readonly RollBuilder[] = [],
    // The raw (pre-R24-cap) argument each was last called with — tracked separately from the
    // transformed dice so a second call with a DIFFERENT value can be refused (R23) while a
    // repeat of the SAME value stays a no-op.
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
    const damageRoll = RollBuilder.fromArgs(...args);
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
   * R14: a second damage channel, convolved into the hit AND crit payloads (its dice double on
   * a crit like any attack damage) but excluded from base-payload transforms — a separate
   * damage channel that base-payload rerolls and once-per-turn reroll substitutions never
   * touch. Chainable; several calls accumulate into one convolved channel.
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
   * R16/R24: applies `reroll(k)` to every die group of the BASE payload (hit, and the crit
   * branch when it is explicit), leaving `plusSeparateDamage` channels untouched — so a weapon
   * reads in whichever order the caller likes. The threshold is a PERMISSION CAP, not an
   * obligation: the effective per-group threshold is `min(threshold, floor(sides / 2))`, so the
   * result is monotone in `threshold` and always describes optimal play (R24).
   * `RollBuilder.reroll()` keeps its own obligation semantics; this is the attack-level verb.
   */
  rerollDamage(threshold: number): AttackBuilder {
    if (isNaN(threshold)) throw new Error("Invalid NaN value for rerollDamage threshold");
    if (this.rerollThreshold !== undefined) {
      if (threshold === this.rerollThreshold) return this;
      throw new Error(
        `Conflicting rerollDamage() threshold: already set to ${this.rerollThreshold}, cannot change to ${threshold}. Repeating the same value is a no-op.`
      );
    }
    const capped = (config: RollConfig): RollConfig => ({
      ...config,
      reroll: Math.min(threshold, Math.floor(config.sides / 2)),
    });
    return new AttackBuilder(
      this.check,
      this.hitEffect
        ? AttackBuilder.mapEveryDieGroup(this.hitEffect, "rerollDamage", capped)
        : this.hitEffect,
      this.critEffect
        ? AttackBuilder.mapEveryDieGroup(this.critEffect, "rerollDamage", capped)
        : this.critEffect,
      this.missEffect,
      this.separateDamage,
      threshold,
      this.minimumDieValue,
      this.halfOnMissFlag
    );
  }

  /**
   * R16: applies `minimum(v)` to every die group of the BASE payload (hit, and the crit branch
   * when it is explicit), leaving `plusSeparateDamage` channels untouched. Order-independent
   * with respect to `plusSeparateDamage` and `rerollDamage` (R16).
   */
  minimumDamageDie(minimum: number): AttackBuilder {
    if (isNaN(minimum)) throw new Error("Invalid NaN value for minimumDamageDie");
    if (this.minimumDieValue !== undefined) {
      if (minimum === this.minimumDieValue) return this;
      throw new Error(
        `Conflicting minimumDamageDie() value: already set to ${this.minimumDieValue}, cannot change to ${minimum}. Repeating the same value is a no-op.`
      );
    }
    const floored = (config: RollConfig): RollConfig => ({ ...config, minimum });
    return new AttackBuilder(
      this.check,
      this.hitEffect
        ? AttackBuilder.mapEveryDieGroup(this.hitEffect, "minimumDamageDie", floored)
        : this.hitEffect,
      this.critEffect
        ? AttackBuilder.mapEveryDieGroup(this.critEffect, "minimumDamageDie", floored)
        : this.critEffect,
      this.missEffect,
      this.separateDamage,
      this.rerollThreshold,
      minimum,
      this.halfOnMissFlag
    );
  }

  /**
   * R28: the miss payload becomes `floor(resolved hit payload / 2)` — base plus every
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
   * R30: the ONE way to re-derive hit/crit/miss probabilities for an existing attack. `vsAC`
   * and every §7 condition variant are both callers. Throws if this attack's check has no AC
   * (an `AlwaysHitBuilder`, or a crit-from-always-hit override) — there is nothing to rebind.
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
    const configs = next.roll.getSubRollConfigs();
    let rewritten: readonly RollConfig[] = configs;
    if (configs.length > 0) {
      const rootIdx = configs.findIndex((c) => c.sides > 0);
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

  // Legacy expressions
  toExpression(): string {
    const checkPart = this.check.toExpression();

    let effectPart = "";

    if (this.hitEffect) {
      effectPart = `(${this.hitEffect.toExpression()})`;
      if (this.critEffect !== null) {
        // R33: auto-crit doubles the hit payload's dice — parsed and pooled payloads included.
        const crit: RollBuilder = this.critEffect ?? this.hitEffect.copy().doubleDice();

        const critThreshold = this.check.critThreshold;
        if (critThreshold < 1 || critThreshold > 20) {
          throw new Error(
            `Invalid crit threshold: ${critThreshold}. Must be between 1 and 20.`
          );
        }

        // Only include crit expression if crit is not zero
        const critExpression = crit.toExpression();
        if (critExpression !== "0") {
          if (critThreshold === 20) {
            effectPart += ` crit (${critExpression})`;
          } else {
            const xcritNumber = 21 - critThreshold;
            effectPart += ` xcrit${xcritNumber} (${critExpression})`;
          }
        }
      }

      if (this.missEffect) {
        effectPart += ` miss (${this.missEffect.toExpression()})`;
      }
    }

    return `${checkPart} * ${effectPart}`;
  }

  resolveProbabilities(
    check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder,
    eps: number = 0
  ): { pSuccess: number; pHit: number; pCrit: number; pMiss: number } {
    const critThreshold = check.critThreshold;
    const d20 = resolveRootD20(check);

    if (check instanceof AlwaysCritBuilder) {
      // If fromAlwaysHit is true, everything is a crit (no misses)
      if (check.fromAlwaysHit) {
        return { pSuccess: 1, pHit: 0, pCrit: 1, pMiss: 0 };
      }

      // If fromAlwaysHit is false (came from ACBuilder), we need to check AC
      // Natural 1s always miss, everything else that would hit becomes a crit
      const ac = check.attackConfig.ac ?? 0;
      const staticMod = this.check.modifier;
      const bonusDicePMFs = this.check.getBonusDicePMFs(this.check, eps);
      const bonusPMF = bonusDicePMFs.length
        ? PMF.convolveMany(bonusDicePMFs, eps)
        : PMF.delta(0, eps);

      let pcrit = 0;
      let pmiss = 0;

      for (const [r, bin] of d20) {
        const pr = bin.p;
        if (pr <= 0) continue;

        // Natural 1 always misses
        if (r === 1) {
          pmiss += pr;
          continue;
        }

        // Check if this roll would hit the AC
        const need = ac - staticMod - r;
        const pBonusHit = bonusPMF.tailProbGE(need);

        // Everything that hits becomes a crit
        pcrit += pr * pBonusHit;
        pmiss += pr * (1 - pBonusHit);
      }

      return { pSuccess: pcrit, pHit: 0, pCrit: pcrit, pMiss: pmiss };
    }

    if (check instanceof AlwaysHitBuilder) {
      // Preserve rollType for crit odds
      let pCrit = 0;
      for (const [r, bin] of d20) {
        const pr = bin.p;
        if (pr <= 0) continue;
        if (r >= critThreshold) pCrit += pr;
      }
      const pHit = 1 - pCrit;
      const pMiss = 0;

      return { pSuccess: 1, pHit, pCrit, pMiss };
    }

    const ac = check.attackConfig.ac;
    const staticMod = this.check.modifier;

    const bonusDicePMFs = this.check.getBonusDicePMFs(this.check, eps);
    const bonusPMF = bonusDicePMFs.length
      ? PMF.convolveMany(bonusDicePMFs, eps)
      : PMF.delta(0, eps);

    let pcrit = 0;
    let phit = 0;
    let pmiss = 0;

    for (const [r, bin] of d20) {
      const pr = bin.p;
      if (pr <= 0) continue;

      // Handle auto-miss
      if (r === 1) {
        pmiss += pr;
        continue;
      }

      // A natural 20 always hits and always crits (RAW), independent of AC or critThreshold.
      if (r === 20) {
        pcrit += pr;
        continue;
      }

      // Handle normal hit/miss, and an expanded crit range (critThreshold < 20): a non-natural-20
      // roll in the crit range still has to beat AC to hit at all -- it is not an auto-hit.
      const need = ac - staticMod - r;
      const pBonusHit = bonusPMF.tailProbGE(need);

      if (r >= critThreshold) {
        pcrit += pr * pBonusHit;
      } else {
        phit += pr * pBonusHit;
      }
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
      // R33: every damage payload with dice doubles them on a crit — a parsed string by rewriting
      // its dice terms, a pool by doubling inside then pooling. Throws for a parsed payload that
      // contains an attack check, which is not damage.
      const critBuilder = this.critEffect ?? this.hitEffect?.copy().doubleDice();

      if (critBuilder) {
        critBasePMF = toEffectPMF(critBuilder);
      }
    }

    // R14: `plusSeparateDamage` channels convolve into hit AND crit — their dice double on a
    // crit like any attack damage (including under an explicit `onCrit`, which overrides only
    // the base payload's crit branch, not the channel) — but never feed the base-payload
    // transforms above. When the attack has no crit mass at all (`noCrit()`, or a check whose
    // crit weight resolves to 0), the crit branch is unreachable, so a channel that cannot be
    // doubled unambiguously must not be forced through `doubleDice()` for a branch nobody reads.
    const hasChannels = this.separateDamage.length > 0;
    const hasCritMass = critBasePMF !== null && pcrit > 0;
    const hitChannelsPMF = hasChannels
      ? PMF.convolveMany(this.separateDamage.map((r) => toEffectPMF(r)), eps)
      : null;
    const critChannelsPMF =
      hasChannels && hasCritMass
        ? PMF.convolveMany(this.separateDamage.map((r) => toEffectPMF(r.copy().doubleDice())), eps)
        : null;

    const hitPMF = hitChannelsPMF
      ? PMF.convolveMany([hitBasePMF, hitChannelsPMF], eps)
      : hitBasePMF;
    const critPMF =
      critBasePMF === null
        ? null
        : critChannelsPMF
          ? PMF.convolveMany([critBasePMF, critChannelsPMF], eps)
          : critBasePMF;

    let missPMF: PMF;
    let missIsDamage: boolean;
    if (this.halfOnMissFlag) {
      // R28: half of the RESOLVED hit payload (base + every separate channel), never the crit
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

    // Mix them up
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
   * exactly these), a `keep`/`bestOf` pool (ambiguous "the dice" under crit doubling), a
   * pool-wide exploding budget (composition with match not yet threaded through here), a
   * multi-die-type pool, a single die (can never match), or (crit) `noCrit()`.
   *
   * The crit branch is built from the SAME crit-effect selection `resolve()` uses (an explicit
   * `onCrit` roll, or the hit dice auto-doubled via `copy().doubleDice()`), so its descriptor
   * reflects the crit branch's REAL doubled pool, not the hit pool re-used blindly.
   *
   * R14: reads ONLY `hitEffect`/`critEffect` (the base pool) — `plusSeparateDamage` channels are
   * a separate channel, so exempt dice never count toward a match.
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
    if (config.explodePoolBudget > 0) return null;

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
