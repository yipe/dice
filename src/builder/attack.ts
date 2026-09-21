import type { DiceMatchInfo, OutcomeType } from "../common/types";
import { EPS } from "../common/types";
import { diceSumDistribution, faceWeights, jointSumAndMatch } from "../common/bounce";
import { LRUCache } from "../common/lru-cache";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import type { DiceQuery } from "../pmf/query";
import type { ACBuilder } from "./ac";
import { pmfFromRollBuilder, resolveRootD20 } from "./ast";
import {
  AlwaysCritBuilder,
  AlwaysHitBuilder,
  ParsedRollBuilder,
  RollBuilder,
} from "./roll";
import type { AttackResolution, CheckBuilder } from "./types";

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
    private readonly missEffect?: ActionEffect
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
      this.missEffect
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
      if (this.critEffect !== null) {
        let crit: RollBuilder;
        if (this.critEffect) {
          crit = this.critEffect;
        } else {
          // For ParsedRollBuilder, we can't double dice, so skip the crit expression
          if (this.hitEffect instanceof ParsedRollBuilder) {
            // Don't try to double ParsedRollBuilder - leave it out of expression
            crit = RollBuilder.fromArgs(0);
          } else {
            crit =
              this.hitEffect?.copy().doubleDice() ?? RollBuilder.fromArgs(0);
          }
        }

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
    const hitPMF = this.hitEffect
      ? this.hitEffect instanceof ParsedRollBuilder
        ? this.hitEffect.toPMF(eps)
        : pmfFromRollBuilder(this.hitEffect, eps)
      : PMF.delta(0, eps);

    let critPMF: PMF | null = null;
    let phit = pHit;
    let pcrit = pCrit;

    if (this.critEffect === null) {
      critPMF = null;
      phit += pcrit;
      pcrit = 0;
    } else {
      let critBuilder: RollBuilder | undefined;
      
      if (this.critEffect) {
        critBuilder = this.critEffect;
      } else if (this.hitEffect instanceof ParsedRollBuilder) {
        // For ParsedRollBuilder, we can't automatically double dice
        // So treat it as noCrit() - roll crit probability into hit
        critPMF = null;
        phit += pcrit;
        pcrit = 0;
        critBuilder = undefined;
      } else {
        critBuilder = this.hitEffect?.copy().doubleDice();
      }

      if (critBuilder) {
        critPMF = critBuilder instanceof ParsedRollBuilder
          ? critBuilder.toPMF(eps)
          : pmfFromRollBuilder(critBuilder, eps);
      }
    }
    const missPMF = this.missEffect
      ? this.missEffect instanceof ParsedRollBuilder
        ? this.missEffect.toPMF(eps)
        : pmfFromRollBuilder(this.missEffect, eps)
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
   */
  diceMatchInfo(_eps: number = EPS): { hit: DiceMatchInfo | null; crit: DiceMatchInfo | null } {
    const hit = this.matchInfoForEffect(this.hitEffect);

    let critEffect: RollBuilder | undefined;
    if (this.critEffect === null) {
      critEffect = undefined; // noCrit(): no separate crit branch
    } else if (this.critEffect) {
      critEffect = this.critEffect;
    } else if (this.hitEffect instanceof ParsedRollBuilder) {
      critEffect = undefined; // string-parsed hit: doubleDice() throws, crit folds into hit
    } else {
      critEffect = this.hitEffect?.copy().doubleDice();
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

    return `${checkKey}*H${hitKey}*C${critKey}*M${missKey}*e${eps}`;
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
