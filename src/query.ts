import { PMF } from "./pmf";
import type { OutcomeType } from "./types";
import { COMPUTATIONAL_EPS } from "./types";

/**
 * Query interface for analyzing dice roll probability distributions.
 *
 * Combines multiple attack PMFs and provides statistical analysis methods for:
 * - Basic statistics (mean, variance, min/max, percentiles)
 * - Probability queries (hit chances, success rates, exact counts)
 * - Damage analysis (ranges by outcome type, expected values)
 * - Data export (charts, tables, visualizations)
 *
 */

export class DiceQuery {
  public readonly singles: PMF[];
  public readonly combined: PMF;

  constructor(singles: PMF | PMF[], combined?: PMF) {
    this.singles = Array.isArray(singles) ? singles : [singles];
    const c = combined ?? PMF.convolveMany(this.singles);
    this.combined = Math.abs(c.mass() - 1) <= 1e-12 ? c : c.normalize();
    if (this.singles.some((s) => s === undefined)) {
      throw new Error("DiceQuery contains undefined singles");
    }
  }

  private static readonly DEFAULT_OUTCOMES: readonly OutcomeType[] = [
    "hit",
    "crit",
    "missNone",
  ] as const;

  /**
   * Returns the expected damage across all possible outcomes.
   *
   * Example: `query.mean()` → 12.5
   * Use case: "What's my average damage per round?"
   */
  mean(): number {
    let totalSum = 0;
    for (const [damageValue, probabilityBin] of this.combined) {
      totalSum += damageValue * probabilityBin.p;
    }
    return totalSum;
  }

  /**
   * Returns the variance of the damage distribution.
   *
   * Example: `query.variance()` → 45.2
   * Use case: "How much does my damage vary from the average?"
   * High variance means higher risk/reward. Lower variance means more consistent damage.
   */
  variance(): number {
    const meanValue = this.mean();
    let varianceSum = 0;
    for (const [damageValue, probabilityBin] of this.combined) {
      const deviationFromMean = damageValue - meanValue;
      varianceSum += deviationFromMean * deviationFromMean * probabilityBin.p;
    }
    return varianceSum;
  }

  /**
   * Returns the standard deviation of the damage distribution.
   *
   * Example: `query.stdev()` → 6.7
   * Use case: "What's the typical spread around my average damage?"
   * Used to determine how consistent the damage is.
   */
  stddev(): number {
    return Math.sqrt(this.variance());
  }

  /**
   * Returns the Cumulative Distribution Function.
   */
  cdf(x: number): number {
    return this.probTotalAtMost(x);
  }

  /**
   * Returns the probability of dealing X damage or less.
   * In statistics, this is called the cumulative distribution function (CDF).
   * Example: `query.cdf(20)` → 0.75
   * Use case: "What's the chance I deal 20 damage or less?"
   */
  probTotalAtMost(x: number): number {
    let cumulativeProbability = 0;
    for (const [damageValue, probabilityBin] of this.combined) {
      if (damageValue <= x) {
        cumulativeProbability += probabilityBin.p;
      }
    }
    return cumulativeProbability;
  }

  /**
   * Returns the Complementary Cumulative Distribution Function.
   */
  ccdf(x: number): number {
    return this.probTotalAtLeast(x);
  }

  /**
   * Returns the probability of dealing at least X damage.
   *
   * Example: `query.probTotalAtLeast(25)` → 0.35
   * Use case: "What's the chance I deal at least 25 damage to finish the enemy?"
   */
  probTotalAtLeast(threshold: number): number {
    let probabilitySum = 0;
    for (const [damageValue, probabilityBin] of this.combined) {
      if (damageValue >= threshold) {
        probabilitySum += probabilityBin.p;
      }
    }
    return probabilitySum;
  }

  /**
   * Returns damage values at specific percentiles.
   *
   * Example: `query.percentiles([0.25, 0.5, 0.75])` → [8, 12, 18]
   * Use case: "What are my 25th, 50th, and 75th percentile damage values?"
   */
  percentiles(percentileValues: number[]): number[] {
    const sortedDamageValues = this.combined.support();
    if (sortedDamageValues.length === 0) return percentileValues.map(() => 0);

    const cumulativeProbabilities: number[] = [];
    let runningProbabilitySum = 0;
    for (const damageValue of sortedDamageValues) {
      runningProbabilitySum += this.combined.map.get(damageValue)!.p;
      cumulativeProbabilities.push(runningProbabilitySum);
    }

    return percentileValues.map((targetPercentile) => {
      // Binary search for efficiency
      let leftBound = 0;
      let rightBound = cumulativeProbabilities.length - 1;

      while (leftBound <= rightBound) {
        const middleIndex = Math.floor((leftBound + rightBound) / 2);
        if (cumulativeProbabilities[middleIndex] >= targetPercentile) {
          rightBound = middleIndex - 1;
        } else {
          leftBound = middleIndex + 1;
        }
      }

      return leftBound < sortedDamageValues.length
        ? sortedDamageValues[leftBound]
        : sortedDamageValues[sortedDamageValues.length - 1];
    });
  }

  /**
   * Returns the minimum possible damage.
   *
   * Example: `query.min()` → 0
   * Use case: "What's the worst-case damage if everything misses?"
   */
  min(): number {
    return this.combined.min();
  }

  /**
   * Returns the maximum possible damage.
   *
   * Example: `query.max()` → 56
   * Use case: "What's the best-case damage if everything crits and rolls max?"
   */
  max(): number {
    return this.combined.max();
  }

  private singleProb(diceIndex: number, label: OutcomeType): number {
    let probabilitySum = 0;
    for (const [, probabilityBin] of this.singles[diceIndex]) {
      probabilitySum += probabilityBin.count[label] || 0;
    }
    return probabilitySum;
  }

  probAtLeastK(labels: OutcomeType | OutcomeType[], k: number): number {
    const L = Array.isArray(labels) ? [...new Set(labels)] : [labels];
    const n = this.singles.length;

    if (k <= 0) return 1;
    if (k > n) return 0;

    let tail = 0;
    for (let i = k; i <= n; i++) {
      tail += this.probExactlyK(L, i);
    }

    if (tail < 0) return 0;
    if (tail > 1) return 1;
    return tail;
  }

  /**
   * Returns the probability that at least one attack has the specified outcome(s).
   * - This is the complement of probAtMostK(labels, 0)
   *
   * Examples:
   * - `query.probAtLeastOne('hit')` → 0.88 (88% chance at least one attack hits)
   * - `query.probAtLeastOne(['hit', 'crit'])` → 0.96 (96% chance at least one succeeds)
   *
   * Use cases:
   * - "What's the chance at least one of my attacks connects?"
   *
   * Note:
   *
   * - You have to pass in an array of labels to avoid double-counting if you are
   *   using multiple labels. You cannot just add them.
   */
  probAtLeastOne(labels: OutcomeType | OutcomeType[]): number {
    // Handle single label case (backward compatibility)
    if (typeof labels === "string") {
      labels = [labels];
    }

    let productOfNonOccurrence = 1;
    for (let diceIndex = 0; diceIndex < this.singles.length; diceIndex++) {
      // Calculate total probability of any of the specified labels occurring
      let combinedProbability = 0;
      for (const label of labels) {
        combinedProbability += this.singleProb(diceIndex, label);
      }
      productOfNonOccurrence *= 1 - combinedProbability;
    }
    return 1 - productOfNonOccurrence;
  }

  /**
   * Computes binomial probabilities for exactly 0, 1, 2, ..., maxK occurrences of a label.
   *
   * Uses dynamic programming to efficiently calculate the probability distribution
   * of how many attacks will have the specified outcome, accounting for different
   * success probabilities across individual attacks.
   *
   * Example: For 3 attacks with 50% hit chance each, returns:
   * [0.125, 0.375, 0.375, 0.125] = [P(0 hits), P(1 hit), P(2 hits), P(3 hits)]
   *
   * @param label - The outcome type to count
   * @param maxK - Maximum number of occurrences to calculate (usually number of attacks)
   * @returns Array where index K contains P(exactly K attacks have the label)
   */
  private computeBinomialProbabilities(
    label: OutcomeType,
    maxK: number
  ): number[] {
    const individualProbabilities = this.singles.map((_, diceIndex) =>
      this.singleProb(diceIndex, label)
    );
    const binomialProbs = new Array(maxK + 1).fill(0);
    binomialProbs[0] = 1;

    for (const singleProbability of individualProbabilities) {
      for (let outcomeCount = maxK; outcomeCount >= 1; outcomeCount--) {
        binomialProbs[outcomeCount] =
          binomialProbs[outcomeCount] * (1 - singleProbability) +
          binomialProbs[outcomeCount - 1] * singleProbability;
      }
      binomialProbs[0] *= 1 - singleProbability;
    }

    return binomialProbs;
  }

  /**
   * Returns the probability that exactly K attacks result in the specified outcome(s).
   *
   * Single label examples:
   * - probExactlyK('hit', 2) = probability exactly 2 attacks hit
   * - probExactlyK('crit', 1) = probability exactly 1 attack crits
   * - probExactlyK('crit', 0) = probability no attacks crit
   *
   * Array examples:
   * - probExactlyK(['hit', 'crit'], 2) = probability exactly 2 attacks succeed
   * - probExactlyK(['hit', 'crit'], 1) = probability exactly 1 attack succeeds
   * - probExactlyK(['miss', 'missNone'], 0) = probability no attacks miss
   *
   * Use cases:
   * - "What's the chance exactly one of my attacks hits?"
   * - "How likely am I to get exactly 2 successes out of 3 attacks?"
   * - "What's the probability that exactly half my attacks succeed?"
   *
   * Note: For arrays, an attack counts as a "success" if it has any of the specified labels.
   * This is different from probAtMostK, which counts an attack as a "success" if it has ALL of the specified labels.
   */
  probExactlyK(labels: OutcomeType | OutcomeType[], k: number): number {
    // Handle single label case (backward compatibility)
    if (typeof labels === "string") {
      const probabilityArray = this.computeBinomialProbabilities(labels, k);
      return probabilityArray[k];
    }

    // For multiple labels, we need to compute success probability for each single attack
    const successProbabilities = this.singles.map((single) => {
      const singleQuery = new DiceQuery([single]);
      return singleQuery.probabilityOf(labels);
    });

    // Use binomial distribution with combined success probability
    const binomialProbs = new Array(k + 1).fill(0);
    binomialProbs[0] = 1;

    for (const successProb of successProbabilities) {
      for (let outcomeCount = k; outcomeCount >= 1; outcomeCount--) {
        binomialProbs[outcomeCount] =
          binomialProbs[outcomeCount] * (1 - successProb) +
          binomialProbs[outcomeCount - 1] * successProb;
      }
      binomialProbs[0] *= 1 - successProb;
    }

    return binomialProbs[k];
  }

  /**
   * Returns the probability that AT MOST K attacks result in the specified outcome(s).
   *
   * Single label examples:
   * - probAtMostK('hit', 1) = probability 0 or 1 attacks hit (at most 1)
   * - probAtMostK('crit', 0) = probability no attacks crit
   * - probAtMostK('miss', 2) = probability at most 2 attacks miss
   *
   * Array examples:
   * - probAtMostK(['hit', 'crit'], 1) = probability at most 1 attack succeeds
   * - probAtMostK(['hit', 'crit'], 0) = probability no attacks succeed (all miss)
   *
   * Use cases:
   * - "What's the chance that at most one attack hits?" (rest miss)
   * - "How likely am I to have mostly failures?" (at most 1 success)
   * - "What's the probability of a really bad turn?" (at most 0 successes)
   *
   */
  probAtMostK(labels: OutcomeType | OutcomeType[], k: number): number {
    // Handle single label case (backward compatibility)
    if (typeof labels === "string") {
      const probabilityArray = this.computeBinomialProbabilities(labels, k);
      let cumulativeSum = 0;
      for (let outcomeCount = 0; outcomeCount <= k; outcomeCount++) {
        cumulativeSum += probabilityArray[outcomeCount];
      }
      return cumulativeSum;
    }

    // For multiple labels, compute probabilities for 0 to k
    let cumulativeSum = 0;
    for (let outcomeCount = 0; outcomeCount <= k; outcomeCount++) {
      cumulativeSum += this.probExactlyK(labels, outcomeCount);
    }
    return cumulativeSum;
  }

  /**
   * Returns the expected damage attributed to specific outcome types.
   *
   * Single label examples:
   * - expectedDamageFrom('hit') = expected damage from hit components
   * - expectedDamageFrom('crit') = expected damage from crit components
   *
   * Array examples:
   * - expectedDamageFrom(['hit', 'crit']) = expected damage from any success
   * - expectedDamageFrom(['missDamage', 'missNone']) = expected damage from misses
   *
   * Use cases:
   * - "How much damage do I expect from successful attacks?"
   * - "What's the damage contribution from critical hits specifically?"
   * - "How much damage comes from miss effects (like save-for-half spells)?"
   */
  expectedDamageFrom(labels: OutcomeType | OutcomeType[]): number {
    // Handle single label case (backward compatibility)
    if (typeof labels === "string") {
      return this._expectedDamageFromSingle(labels);
    }

    // For multiple labels, sum the attr values for all specified labels
    let totalExpectedDamage = 0;
    for (const [, probabilityBin] of this.combined) {
      for (const label of labels) {
        totalExpectedDamage += probabilityBin.attr?.[label] || 0;
      }
    }
    return totalExpectedDamage;
  }

  private _expectedDamageFromSingle(label: OutcomeType): number {
    let totalExpectedDamage = 0;
    for (const [, probabilityBin] of this.combined) {
      totalExpectedDamage += probabilityBin.attr?.[label] || 0;
    }
    return totalExpectedDamage;
  }

  /**
   * Returns damage statistics for scenarios where AT LEAST ONE attack results in
   * the specified outcome(s).
   *
   * This method answers "What happens when things go reasonably well?" rather than
   * "What's the theoretical maximum?" It includes mixed scenarios which are more
   * common and tactically relevant than pure scenarios.
   *
   * Single label examples:
   * - damageStatsFrom('hit') = damage range when at least one attack hits
   * - damageStatsFrom('crit') = damage range when at least one attack crits
   *
   * Array examples:
   * - damageStatsFrom(['hit', 'crit']) = damage range when at least one attack succeeds
   * - damageStatsFrom(['miss', 'missNone']) = damage range when at least one attack misses
   *
   * Tactical Use Cases:
   * - "Given that I don't completely whiff (99% of turns), what damage should I expect?"
   * - "When planning to kill a 60 HP enemy, what's my damage range on successful turns?"
   * - "Should I use this risky spell if it has good damage when it works?"
   * - "What's my damage potential when something goes right?" (vs pure failure)
   *
   * Combat Planning Examples:
   * - 4 attacks with 90% hit chance: "96% of the time you'll do 25-150 damage, avg 52"
   *   (Much more useful than "You average 50 damage including complete misses")
   * - Risk assessment: "80% of successful turns do 40-80 damage, but 20% do 80-150"
   * - Resource management: "If I hit anything, I'll likely finish this enemy"
   *
   * Statistical Note:
   * This includes mixed scenarios (2 hits + 1 crit, 3 hits + 1 miss, etc.) which
   * occur far more frequently than pure scenarios. For pure scenarios, use combinedDamageStats.
   *
   * @example
   * // High-level tactical planning
   * const successStats = query.damageStatsFrom('hit')
   * const successChance = query.probAtLeastOne('hit')
   * console.log(`${(successChance*100).toFixed(1)}% chance to do ${successStats.min}-${successStats.max} damage`)
   */
  damageStatsFrom(labels: OutcomeType | OutcomeType[]): {
    min: number;
    max: number;
    avg: number;
    count: number;
  } {
    // Normalize input to array for uniform handling
    const labelArray = typeof labels === "string" ? [labels] : labels;

    let minDamage = Infinity;
    let maxDamage = -Infinity;
    let totalDamage = 0;
    let totalCount = 0;

    for (const [damage, probabilityBin] of this.combined) {
      // Check if this bin has any of the specified labels
      let binHasAnyLabel = false;
      let binContribution = 0;

      for (const label of labelArray) {
        const count = probabilityBin.count[label] as number;
        if (count && count > 0) {
          binHasAnyLabel = true;
          binContribution += count;
        }
      }

      if (damage > 0 && binHasAnyLabel) {
        minDamage = Math.min(minDamage, damage);
        maxDamage = Math.max(maxDamage, damage);

        // For single labels, use the specific count; for multiple labels, use total probability
        const weightToUse =
          labelArray.length === 1 ? binContribution : probabilityBin.p;
        totalDamage += damage * weightToUse;
        totalCount += weightToUse;
      }
    }

    return {
      min: minDamage === Infinity ? 0 : minDamage,
      max: maxDamage === -Infinity ? 0 : maxDamage,
      avg: totalCount > 0 ? totalDamage / totalCount : 0,
      count: totalCount,
    };
  }

  /**
   * Returns damage statistics for scenarios where ALL attacks result in the specified
   * outcome, calculated by leveraging the pure partition of singles.
   *
   * This method answers "What's the theoretical best/worst case?" and "What are the
   * clean mathematical boundaries?" It provides pure scenarios without mixing outcomes.
   *
   * Examples:
   * - combinedDamageStats('hit') = damage range when all attacks hit (none crit, none miss)
   * - combinedDamageStats('crit') = damage range when all attacks crit (none just hit)
   *
   * UI and Display Use Cases:
   * - Statistics panels showing "MAX Hit Damage" (users expect pure hits, not mixed)
   * - "Best case scenario" vs "worst case scenario" analysis
   * - Mathematical verification: "Does our hit damage calculation match manual math?"
   * - Clean damage type attribution: "How much comes from base hits vs crits?"
   *
   * Design and Balance Use Cases:
   * - Game designers: "What's the damage ceiling if someone gets lucky?"
   * - Character optimization: "What's my absolute maximum potential?"
   * - Ability comparison: "Which build has higher crit ceiling?"
   * - Minimum guaranteed damage: "What's the worst I can do if everything hits?"
   *
   * Mathematical Use Cases:
   * - Validating complex calculations against simple manual math
   * - Understanding damage component contributions in isolation
   * - Separating luck (crit variance) from consistency (hit variance)
   * - Building intuition about damage sources
   *
   * When to Use This vs damageStatsFrom():
   * - Use THIS for: UI max/min displays, theoretical limits, clean comparisons
   * - Use damageStatsFrom() for: tactical planning, realistic expectations, mixed scenarios
   *
   * Statistical Note:
   * Pure scenarios (all hits, all crits) are rare but represent clear mathematical
   * boundaries. These stats help understand the "shape" of your damage potential.
   *
   * @example
   * // UI display logic
   * const pureHitMax = query.combinedDamageStats('hit').max    // Clean "MAX Hit Damage: 90"
   * const pureCritMax = query.combinedDamageStats('crit').max  // Clean "MAX Crit Damage: 168"
   *
   * // vs tactical planning (use damageStatsFrom instead)
   * const realisticRange = query.damageStatsFrom('hit')  // Includes mixed scenarios
   */
  combinedDamageStats(targetLabel: OutcomeType): {
    min: number;
    max: number;
    avg: number;
    count: number;
  } {
    // Get pure statistics from each single attack (singles are already pure partitions)
    const singleStats = this.singles.map((single) =>
      new DiceQuery([single]).damageStatsFrom(targetLabel)
    );

    // If any single attack has no outcomes of this type, return zeros
    if (singleStats.some((stats) => stats.count === 0)) {
      return { min: 0, max: 0, avg: 0, count: 0 };
    }

    // Calculate combined statistics for N attacks all of target type
    const combinedMin = singleStats.reduce((sum, stats) => sum + stats.min, 0);
    const combinedMax = singleStats.reduce((sum, stats) => sum + stats.max, 0);
    const combinedAvg = singleStats.reduce((sum, stats) => sum + stats.avg, 0);
    const combinedProb = singleStats.reduce(
      (product, stats) => product * stats.count,
      1
    );

    return {
      min: combinedMin,
      max: combinedMax,
      avg: combinedAvg,
      count: combinedProb,
    };
  }

  /**
   * Returns the probability that a result includes ANY of the specified labels.
   *
   * Examples:
   * - `query.probabilityOf('hit')` → 0.88 (probability at least one hit occurs)
   * - `query.probabilityOf(['hit', 'crit'])` → 0.96 (probability of any success)
   *
   * Use cases:
   * - "What's the chance my resolution includes a success label?"
   * - "How likely am I to get any hits or crits across all attacks?"
   */
  probabilityOf(labels: OutcomeType | OutcomeType[]): number {
    // Handle single label case (backward compatibility)
    if (typeof labels === "string") {
      labels = [labels];
    }

    let totalProbability = 0;
    for (const [, probabilityBin] of this.combined) {
      // Calculate probability that this bin contains ANY of the specified labels
      // Use inclusion-exclusion principle to avoid double-counting overlaps
      let binHasAnyLabel = false;
      for (const label of labels) {
        if (
          probabilityBin.count[label] &&
          (probabilityBin.count[label] as number) > 0
        ) {
          binHasAnyLabel = true;
          break;
        }
      }
      if (binHasAnyLabel) {
        totalProbability += probabilityBin.p;
      }
    }
    return totalProbability;
  }

  /**
   * Returns the probability of missing (any type of miss).
   *
   * Example: `query.missChance()` → 0.04
   * Use case: "What's the chance I miss completely this turn?"
   */
  missChance(): number {
    // Miss can be either explicit misses with damage or zero-damage misses
    return this.probabilityOf(["missDamage", "missNone"]);
  }

  /**
   * Returns data formatted for plotting damage probability distribution.
   *
   * Example: `query.toChartSeries()` → [{x: 0, y: 0.04}, {x: 6, y: 0.1}, ...]
   * Use case: "I want to visualize my damage distribution in a chart."
   */
  toChartSeries(): Array<{ x: number; y: number }> {
    return this.combined.support().map((damageValue) => ({
      x: damageValue,
      y: this.combined.map.get(damageValue)!.p,
    }));
  }

  /**
   * Returns tabular data showing damage values and their probability breakdowns.
   *
   * Example: `query.toLabeledTable(['hit', 'crit'])` →
   *   [{damage: 6, total: 0.01, hit: 0.008, crit: 0}, ...]
   *
   * Use case: "I want to see exactly how hit/crit probabilities contribute to each damage value."
   */
  toLabeledTable(
    labels: OutcomeType[] = []
  ): Array<{ damage: number; total: number } & Record<string, number>> {
    return this.combined.support().map((damageValue) => {
      const probabilityBin = this.combined.map.get(damageValue)!;
      const tableRow: { damage: number; total: number } & Record<
        string,
        number
      > = {
        damage: damageValue,
        total: probabilityBin.p,
      };
      for (const outcomeLabel of labels) {
        tableRow[outcomeLabel] = probabilityBin.count[outcomeLabel] || 0;
      }
      return tableRow;
    });
  }

  /**
   * Returns data for stacked charts with unconditional per-label probability mass per damage.
   *
   * - Each dataset value equals the unconditional probability mass for that label at that damage
   *   (i.e., `bin.count[label]`).
   * - Column sums may be less than the total probability `bin.p` when you omit labels or when
   *   there is unlabeled mass. Include all relevant outcome labels if you need the sum to match.
   * - This behavior matches tests that expect raw per-label mass (not proportional scaling).
   * - NOTE: This implementation may break dprcalc.com chart binning at large n, need to test it more.
   *
   * @example
   * query.toStackedChartData(['hit', 'crit'])
   * // → {labels: [0, 6, 12, ...], datasets: [{label: 'hit', data: [0, 0.03, ...]}, ...]}
   */
  toStackedChartData(
    labels: OutcomeType[] = [],
    epsilon = 1e-12
  ): { labels: number[]; datasets: Array<{ label: string; data: number[] }> } {
    const damageValues = this.combined.support();

    // Precompute totalCount per bin for the labels you intend to stack for efficiency.
    damageValues.map((dmg) => {
      const bin = this.combined.map.get(dmg)!;
      return labels.reduce((sum, lab) => sum + (bin.count[lab] || 0), 0);
    });

    const datasets = labels.map((outcomeLabel) => ({
      label: outcomeLabel,
      data: damageValues.map((dmg) => {
        const bin = this.combined.map.get(dmg);
        const v = bin ? (bin.count[outcomeLabel] as number) || 0 : 0;
        return v <= epsilon ? 0 : v;
      }),
    }));

    return { labels: damageValues, datasets };
  }

  /**
   * Returns pure mathematical data for attribution charts showing outcome contributions.
   *
   * Automatically discovers all outcome types present in the PMF, applies filtering rules,
   * and returns proportional data suitable for stacked visualization.
   *
   * @param options Configuration options
   * @param options.stackOrder Preferred order for outcome types (unknowns placed at end)
   * @param options.filterRules Function to determine if outcome should be included for a given damage value
   * @param options.asPercentages Whether to return percentages (0-100) or probabilities (0-1)
   * @returns Pure data structure with support, outcomes, and proportional data
   *
   * @example
   * query.toAttributionChartSeries()
   * // → {support: [0, 6, 12], outcomes: ['hit', 'crit'], data: {hit: [5.2, 8.1, ...], crit: [0, 2.3, ...]}}
   */
  toAttributionChartSeries(
    options: {
      stackOrder?: string[];
      filterRules?: (outcome: string, damage: number) => boolean;
      asPercentages?: boolean;
    } = {}
  ): {
    support: number[];
    outcomes: string[];
    data: { [outcome: string]: number[] };
  } {
    const {
      stackOrder = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit",
      ],
      filterRules = (outcome: string, damage: number) =>
        !(outcome === "missNone" && damage !== 0),
      asPercentages = true,
    } = options;

    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], outcomes: [], data: {} };
    }

    // Create complete integer range from min to max
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );

    // Find ALL outcome types that exist in the PMF
    const allOutcomeTypes = new Set<string>();
    for (const [, bin] of this.combined.map) {
      for (const outcomeType in bin.count) {
        if (bin.count[outcomeType] && (bin.count[outcomeType] as number) > 0) {
          allOutcomeTypes.add(outcomeType);
        }
      }
    }

    // Sort existing outcomes by preferred stack order, with unknowns at end
    const existingOutcomes = Array.from(allOutcomeTypes).sort((a, b) => {
      const indexA = stackOrder.indexOf(a);
      const indexB = stackOrder.indexOf(b);

      // If both are in stackOrder, use that order
      if (indexA >= 0 && indexB >= 0) return indexA - indexB;

      // Put unknowns at the end
      if (indexA >= 0) return -1;
      if (indexB >= 0) return 1;

      // Both unknown, alphabetical
      return a.localeCompare(b);
    });

    if (existingOutcomes.length === 0) {
      return { support, outcomes: [], data: {} };
    }

    // Calculate data for each outcome type
    const data: { [outcome: string]: number[] } = {};

    for (const outcome of existingOutcomes) {
      data[outcome] = support.map((damage) => {
        const bin = this.combined.map.get(damage);
        if (!bin) return 0;

        // Apply filter rules
        if (!filterRules(outcome, damage)) {
          return 0;
        }

        // Calculate proportion only among outcomes that will actually be charted
        const outcomeCount = (bin.count[outcome] as number) || 0;

        // Calculate total count excluding outcomes that will be filtered out
        let totalChartableCount = 0;
        for (const [outcomeName, count] of Object.entries(bin.count)) {
          if (filterRules(outcomeName, damage)) {
            totalChartableCount += (count as number) || 0;
          }
        }

        if (totalChartableCount === 0) return 0;

        // Calculate what fraction of chartable probability comes from this outcome
        const outcomeFraction = outcomeCount / totalChartableCount;
        const outcomeProbability = bin.p * outcomeFraction;

        return asPercentages ? outcomeProbability * 100 : outcomeProbability;
      });
    }

    return {
      support,
      outcomes: existingOutcomes,
      data,
    };
  }

  /**
   * Returns pure mathematical data for damage attribution charts showing damage contribution
   * from each outcome type at each damage value.
   *
   * Similar to toAttributionChartSeries() but uses bin.attr (damage attribution) instead of
   * bin.count (probability attribution).
   *
   * @param options Configuration options
   * @param options.stackOrder Preferred order for outcome types (unknowns placed at end)
   * @param options.filterRules Function to determine if outcome should be included for a given damage value
   * @param options.asPercentages Whether to return percentages (0-100) or raw damage values (0+)
   * @returns Pure data structure with support, outcomes, and damage attribution data
   *
   * @example
   * query.toDamageAttributionChartSeries()
   * // → {support: [0, 6, 12], outcomes: ['hit', 'crit'], data: {hit: [3.2, 5.1, ...], crit: [0, 1.8, ...]}}
   */
  toDamageAttributionChartSeries(
    options: {
      stackOrder?: string[];
      filterRules?: (outcome: string, damage: number) => boolean;
      asPercentages?: boolean;
    } = {}
  ): {
    support: number[];
    outcomes: string[];
    data: { [outcome: string]: number[] };
  } {
    const {
      stackOrder = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit",
      ],
      filterRules = (outcome: string, damage: number) =>
        !(outcome === "missNone" && damage !== 0),
      asPercentages = true,
    } = options;

    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], outcomes: [], data: {} };
    }

    // Create complete integer range from min to max
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );

    // Find ALL outcome types that exist in the PMF (from attr, not count)
    const allOutcomeTypes = new Set<string>();
    for (const [, bin] of this.combined.map) {
      if (bin.attr) {
        for (const outcomeType in bin.attr) {
          if (bin.attr[outcomeType] && (bin.attr[outcomeType] as number) > 0) {
            allOutcomeTypes.add(outcomeType);
          }
        }
      }
    }

    // Sort existing outcomes by preferred stack order, with unknowns at end
    const existingOutcomes = Array.from(allOutcomeTypes).sort((a, b) => {
      const indexA = stackOrder.indexOf(a);
      const indexB = stackOrder.indexOf(b);

      // If both are in stackOrder, use that order
      if (indexA >= 0 && indexB >= 0) return indexA - indexB;

      // Put unknowns at the end
      if (indexA >= 0) return -1;
      if (indexB >= 0) return 1;

      // Both unknown, alphabetical
      return a.localeCompare(b);
    });

    if (existingOutcomes.length === 0) {
      return { support, outcomes: [], data: {} };
    }

    // Calculate data for each outcome type
    const data: { [outcome: string]: number[] } = {};

    for (const outcome of existingOutcomes) {
      data[outcome] = support.map((damage) => {
        const bin = this.combined.map.get(damage);
        if (!bin || !bin.attr) return 0;

        // Apply filter rules
        if (!filterRules(outcome, damage)) {
          return 0;
        }

        // Get the damage attribution for this outcome at this damage value
        const outcomeDamageAttribution = (bin.attr[outcome] as number) || 0;

        if (asPercentages) {
          // Calculate total damage attribution at this damage value (for percentage calculation)
          let totalDamageAttribution = 0;
          for (const [outcomeName, damageAttr] of Object.entries(bin.attr)) {
            if (filterRules(outcomeName, damage)) {
              totalDamageAttribution += (damageAttr as number) || 0;
            }
          }

          if (totalDamageAttribution === 0) return 0;

          // Calculate the damage attribution percentage
          const damagePercentage =
            (outcomeDamageAttribution / totalDamageAttribution) * 100;

          // Scale by the probability of this damage value occurring
          // This makes bar height proportional to P(damage = x) while preserving attribution percentages
          return damagePercentage * bin.p * 100; // Scale by probability, *100 to make visible
        } else {
          return outcomeDamageAttribution;
        }
      });
    }

    return {
      support,
      outcomes: existingOutcomes,
      data,
    };
  }

  /**
   * Returns pure mathematical data for outcome attribution charts showing which
   * attack outcome combinations can produce each damage value.
   *
   * Unlike toDamageAttributionChartSeries() which tracks damage sources, this tracks
   * outcome combinations - answering "what attack outcomes produced this damage?"
   *
   * @param options Configuration options
   * @param options.stackOrder Preferred order for outcome types (unknowns placed at end)
   * @param options.filterRules Function to determine if outcome should be included for a given damage value
   * @param options.asPercentages Whether to return percentages (0-100) or probabilities (0-1)
   * @returns Pure data structure with support, outcomes, and outcome combination probabilities
   *
   * @example
   * query.toOutcomeAttributionChartSeries()
   * // → {support: [0, 6, 12], outcomes: ['all_miss', 'mixed', 'all_hit'], data: {all_miss: [15, 0, 0], mixed: [60, 80, 20], all_hit: [25, 20, 80]}}
   */
  toOutcomeAttributionChartSeries(
    options: {
      stackOrder?: string[];
      filterRules?: (outcome: string, damage: number) => boolean;
      asPercentages?: boolean;
    } = {}
  ): {
    support: number[];
    outcomes: string[];
    data: { [outcome: string]: number[] };
  } {
    const {
      stackOrder = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit",
      ],
      filterRules = (outcome: string, damage: number) =>
        !(outcome === "missNone" && damage !== 0),
      asPercentages = true,
    } = options;

    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], outcomes: [], data: {} };
    }

    // Create complete integer range from min to max
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );

    // Find ALL outcome types that exist in the PMF (from count, for outcome tracking)
    const allOutcomeTypes = new Set<string>();
    for (const [, bin] of this.combined.map) {
      for (const outcomeType in bin.count) {
        if (bin.count[outcomeType] && (bin.count[outcomeType] as number) > 0) {
          allOutcomeTypes.add(outcomeType);
        }
      }
    }

    // Sort existing outcomes by preferred stack order, with unknowns at end
    const existingOutcomes = Array.from(allOutcomeTypes).sort((a, b) => {
      const indexA = stackOrder.indexOf(a);
      const indexB = stackOrder.indexOf(b);

      if (indexA >= 0 && indexB >= 0) return indexA - indexB;
      if (indexA >= 0) return -1;
      if (indexB >= 0) return 1;
      return a.localeCompare(b);
    });

    if (existingOutcomes.length === 0) {
      return { support, outcomes: [], data: {} };
    }

    // Calculate data for each outcome type
    const data: { [outcome: string]: number[] } = {};

    for (const outcome of existingOutcomes) {
      data[outcome] = support.map((damage) => {
        const bin = this.combined.map.get(damage);
        if (!bin) return 0;

        // Apply filter rules
        if (!filterRules(outcome, damage)) {
          return 0;
        }

        // Handle missNone specially since it doesn't appear in bin.attr (0 damage)
        if (outcome === "missNone") {
          // For missNone, use bin.count since it contributes 0 damage
          const outcomeCount = (bin.count[outcome] as number) || 0;
          if (outcomeCount === 0) return 0;

          if (asPercentages) {
            // For missNone, show probability proportion since damage attribution would be 0
            let totalChartableCount = 0;
            for (const [outcomeName, count] of Object.entries(bin.count)) {
              if (filterRules(outcomeName, damage)) {
                totalChartableCount += (count as number) || 0;
              }
            }
            if (totalChartableCount === 0) return 0;
            const outcomeFraction = outcomeCount / totalChartableCount;
            return outcomeFraction * bin.p * 100;
          } else {
            return outcomeCount;
          }
        }

        // Use damage attribution to calculate proportional contribution for non-missNone outcomes
        if (!bin.attr) return 0;

        const outcomeDamageContribution = (bin.attr[outcome] as number) || 0;

        if (asPercentages) {
          // Calculate total damage attribution at this damage value
          let totalDamageAttribution = 0;
          for (const [, damageAttr] of Object.entries(bin.attr)) {
            totalDamageAttribution += (damageAttr as number) || 0;
          }

          if (totalDamageAttribution === 0) return 0;

          // The proportion is: damage from this outcome / total damage from all outcomes
          // This gives us exactly what you want: for damage 13 = hit(11) + miss(2),
          // hit proportion = 11/13, miss proportion = 2/13
          const outcomeFraction =
            outcomeDamageContribution / totalDamageAttribution;

          // Scale by probability for bar height while preserving damage attribution percentages
          return outcomeFraction * bin.p * 100;
        } else {
          return outcomeDamageContribution;
        }
      });
    }

    return {
      support,
      outcomes: existingOutcomes,
      data,
    };
  }

  /**
   * Returns pure mathematical data for cumulative distribution function (CDF).
   * Shows P(X ≤ x) - the probability of getting at most x damage.
   *
   * @param asPercentages Whether to return percentages (0-100) or probabilities (0-1)
   * @returns Pure data structure with support and cumulative probabilities
   *
   * @example
   * query.toCDFSeries()
   * // → {support: [0, 6, 12], data: [5.2, 18.3, 45.1]}
   */
  toCDFSeries(asPercentages: boolean = true): {
    support: number[];
    data: number[];
  } {
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], data: [] };
    }

    // Create complete integer range from min to max
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );

    let cumulativeProbability = 0;
    const cdfData: number[] = [];

    for (const damage of support) {
      const bin = this.combined.map.get(damage);
      if (bin) {
        cumulativeProbability += bin.p;
      }
      cdfData.push(
        asPercentages ? cumulativeProbability * 100 : cumulativeProbability
      );
    }

    return {
      support,
      data: cdfData,
    };
  }

  /**
   * Returns pure mathematical data for complementary cumulative distribution function (CCDF).
   * Shows P(X ≥ x) - the probability of getting at least x damage.
   *
   * @param asPercentages Whether to return percentages (0-100) or probabilities (0-1)
   * @returns Pure data structure with support and complementary cumulative probabilities
   *
   * @example
   * query.toCCDFSeries()
   * // → {support: [0, 6, 12], data: [100, 94.8, 81.7]}
   */
  toCCDFSeries(asPercentages: boolean = true): {
    support: number[];
    data: number[];
  } {
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], data: [] };
    }

    // Create complete integer range from min to max
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );

    // Calculate CCDF: P(X ≥ x) = 1 - P(X < x)
    let cumulativeProbability = 0;
    const ccdfData: number[] = [];

    for (const damage of support) {
      // For CCDF at point x, we want P(X ≥ x) = 1 - P(X < x)
      // which is the total probability minus cumulative up to (but not including) x
      const ccdf = 1 - cumulativeProbability;
      ccdfData.push(asPercentages ? ccdf * 100 : ccdf);

      // Now add current probability for next iteration
      const bin = this.combined.map.get(damage);
      if (bin) {
        cumulativeProbability += bin.p;
      }
    }

    return {
      support,
      data: ccdfData,
    };
  }

  /*
        Statistics snapshot of the query.
            */

  /** Probability of doing strictly more than threshold damage (default >0). */
  probDamageGreaterThan(threshold = 0): number {
    let acc = 0;
    for (const [x, bin] of this.combined.map) if (x > threshold) acc += bin.p;
    return acc;
  }

  /** All outcome keys actually present (typed & ordered if you pass an order). */
  outcomeKeys(order?: OutcomeType[]): OutcomeType[] {
    const found = new Set<string>();
    for (const [, bin] of this.combined.map) {
      for (const k in bin.count)
        if (bin.count[k] && (bin.count[k] as number) > 0) found.add(k);
    }
    if (found.size === 0)
      ["hit", "crit", "missNone"].forEach((k) => found.add(k));
    const keys = Array.from(found).filter(
      (k) => order?.includes(k as OutcomeType) ?? true
    ) as OutcomeType[];
    if (order && order.length)
      keys.sort((a, b) => order.indexOf(a) + 999 - (order.indexOf(b) + 999));
    return keys;
  }

  /** Total probability per outcome across the PMF. */
  outcomeTotals(
    outcomes: OutcomeType[] = this.outcomeKeys()
  ): Map<OutcomeType, number> {
    const totals = new Map<OutcomeType, number>();
    outcomes.forEach((o) => totals.set(o, 0));
    for (const [, row] of this.combined.map) {
      for (const o of outcomes) {
        const p = (row.count[o] as number) || 0; // if your bins store per-outcome p; else derive via toLabeledTable
        totals.set(o, (totals.get(o) || 0) + p);
      }
    }
    return totals;
  }

  /** Conditional damage range per outcome (min/avg/max of X | outcome). */
  outcomeDamageRanges(
    outcomes: OutcomeType[] = this.outcomeKeys()
  ): Map<OutcomeType, { min: number; avg: number; max: number }> {
    // Use toLabeledTable to stay consistent with your existing attribution
    const table = this.toLabeledTable(outcomes);
    const ranges = new Map<
      OutcomeType,
      { min?: number; max?: number; sum: number; mass: number }
    >();
    outcomes.forEach((o) => ranges.set(o, { sum: 0, mass: 0 }));

    for (const row of table) {
      const dmg = row.damage as number;
      for (const o of outcomes) {
        const p = (row[o] as number) || 0; // joint mass at (damage, outcome)
        if (p > 0) {
          const r = ranges.get(o)!;
          r.sum += dmg * p;
          r.mass += p;
          if (r.min === undefined || dmg < r.min) r.min = dmg;
          if (r.max === undefined || dmg > r.max) r.max = dmg;
        }
      }
    }

    const out = new Map<
      OutcomeType,
      { min: number; avg: number; max: number }
    >();
    for (const o of outcomes) {
      const r = ranges.get(o)!;
      const avg = r.mass > 0 ? r.sum / r.mass : 0;
      out.set(o, { min: r.min ?? 0, avg, max: r.max ?? 0 });
    }
    return out;
  }

  /**
   * Snapshot of the distribution in the exact shape the UI consumes.
   * - outcome probabilities are "at least one" (and equal to "all" for a single PMF)
   * - damageRange is conditional on the outcome occurring
   */
  snapshot(order?: readonly OutcomeType[]): Snapshot {
    // 1) Discover which outcomes actually appear in this PMF
    const discovered = new Set<string>();
    for (const [, bin] of this.combined.map) {
      for (const k in bin.count) {
        if (bin.count[k] && (bin.count[k] as number) > 0) discovered.add(k);
      }
    }
    if (discovered.size === 0) {
      for (const k of DiceQuery.DEFAULT_OUTCOMES) discovered.add(k);
    }

    let outcomes = Array.from(discovered);

    // Optional filtering + ordering if a preferred order was provided
    if (order && order.length) {
      const inOrder = new Set(order);
      outcomes = outcomes.filter((k) => inOrder.has(k as OutcomeType));
      const rank = new Map(order.map((k, i) => [k, i]));
      outcomes.sort(
        (a, b) =>
          (rank.get(a as OutcomeType) ?? 999) -
          (rank.get(b as OutcomeType) ?? 999)
      );
    }

    // 2) Aggregate per-outcome mass and conditional damage ranges via labeled table
    const rows = this.toLabeledTable(outcomes as OutcomeType[]);

    const totals = new Map<OutcomeType, number>();
    const rangeAcc = new Map<
      OutcomeType,
      { min?: number; max?: number; sum: number; mass: number }
    >();
    for (const ot of outcomes) {
      totals.set(ot as OutcomeType, 0);
      rangeAcc.set(ot as OutcomeType, { sum: 0, mass: 0 });
    }

    for (const row of rows) {
      const dmg = row.damage as number;
      for (const ot of outcomes) {
        const p = (row[ot] as number) || 0;
        if (p <= 0) continue;
        totals.set(ot as OutcomeType, (totals.get(ot as OutcomeType) || 0) + p);

        const r = rangeAcc.get(ot as OutcomeType)!;
        r.sum += dmg * p;
        r.mass += p;
        if (r.min === undefined || dmg < r.min) r.min = dmg;
        if (r.max === undefined || dmg > r.max) r.max = dmg;
      }
    }

    const outcomeMap = new Map<OutcomeType, OutcomeSnapshot>();
    for (const ot of outcomes) {
      const total = totals.get(ot as OutcomeType) || 0;
      const r = rangeAcc.get(ot as OutcomeType)!;
      const avg = r.mass > 0 ? r.sum / r.mass : 0;
      outcomeMap.set(ot as OutcomeType, {
        atLeastOneProbability: total,
        allProbability: total, // single aggregate PMF: same value
        damageRange: { min: r.min ?? 0, avg, max: r.max ?? 0 },
      });
    }

    // 3) Scalars: mean, damageChance, and percentiles from the dense CDF
    const averageDPR = this.mean();

    let damageChance = 0; // P(total damage > 0)
    for (const [x, bin] of this.combined.map) if (x > 0) damageChance += bin.p;

    const { support, data } = this.toCDFSeries(false); // P(X ≤ x) in 0..1
    const quantile = (p: number) => {
      if (support.length === 0) return 0;
      for (let i = 0; i < support.length; i++)
        if (data[i] >= p) return support[i];
      return support[support.length - 1];
    };
    const percentiles = {
      p25: quantile(0.25),
      p50: quantile(0.5),
      p75: quantile(0.75),
    };

    return { averageDPR, damageChance, percentiles, outcomes: outcomeMap };
  }

  /**
   * PMF Transformation Methods
   *
   * These methods provide a fluent API for transforming dice queries by wrapping
   * the underlying PMF transformation methods. All operations work on the combined
   * PMF and return new DiceQuery instances.
   */

  /**
   * Returns a new DiceQuery with normalized probabilities (ensuring they sum to 1.0).
   *
   * @returns New DiceQuery with normalized combined PMF
   */
  normalize(): DiceQuery {
    return new DiceQuery([this.combined.normalize()]);
  }

  /**
   * Returns a new DiceQuery with low-probability outcomes removed.
   *
   * @param eps Minimum probability threshold (defaults to PMF epsilon)
   * @param keepFinalBin Whether to keep the highest damage bin regardless of probability
   * @returns New DiceQuery with compacted combined PMF
   */
  compact(eps?: number, keepFinalBin?: boolean): DiceQuery {
    return new DiceQuery([this.combined.compact(eps, keepFinalBin)]);
  }

  /**
   * Returns a new DiceQuery with an additional scaled branch added.
   * Useful for conditional outcomes like "30% chance of opportunity attack".
   *
   * @param branch DiceQuery to add as a scaled branch
   * @param probability Probability of the branch occurring (0-1)
   * @returns New DiceQuery combining this query with the scaled branch
   *
   * @example
   * const baseAttack = parse("(d20 + 5 AC 15) * (2d6 + 3)");
   * const opportunityAttack = parse("(d20 + 5 AC 15) * (1d8 + 3)");
   * const withOpportunity = baseAttack.addScaled(opportunityAttack, 0.3);
   */
  addScaled(branch: DiceQuery, probability: number): DiceQuery {
    return new DiceQuery([
      this.combined.addScaled(branch.combined, probability),
    ]);
  }

  /**
   * Returns a new DiceQuery with all probabilities scaled by a factor.
   * Used for conditional scenarios where the entire outcome has reduced probability.
   *
   * @param factor Scaling factor for probabilities
   * @returns New DiceQuery with scaled probabilities
   *
   * @example
   * const fullAttack = parse("(d20 + 5 AC 15) * (2d6 + 3)");
   * const conditionalAttack = fullAttack.scaleMass(0.3); // 30% chance scenario
   */
  scaleMass(factor: number): DiceQuery {
    return new DiceQuery([this.combined.scaleMass(factor)]);
  }

  totalMass(): number {
    return this.combined.mass();
  }

  /**
   * Returns a new DiceQuery with damage values transformed by a function.
   * Useful for applying modifiers, resistances, or other damage transformations.
   *
   * @param damageTransformFunction Function to transform each damage value
   * @returns New DiceQuery with transformed damage values
   *
   * @example
   * const baseAttack = parse("2d6 + 3");
   * const withResistance = baseAttack.mapDamage(dmg => Math.floor(dmg / 2)); // Half damage
   * const withBonus = baseAttack.mapDamage(dmg => dmg + 5); // +5 damage
   */
  mapDamage(
    damageTransformFunction: (damageValue: number) => number
  ): DiceQuery {
    return new DiceQuery([this.combined.mapDamage(damageTransformFunction)]);
  }

  /**
   * Returns a new DiceQuery with damage values scaled by a factor.
   * Convenient wrapper around mapDamage for multiplicative scaling.
   *
   * @param factor Scaling factor for damage values
   * @param rounding Rounding method: "floor" (default), "round", or "ceil"
   * @returns New DiceQuery with scaled damage values
   *
   * @example
   * const baseAttack = parse("2d6 + 3");
   * const doubled = baseAttack.scaleDamage(2); // Double damage
   * const halfDamage = baseAttack.scaleDamage(0.5, "round"); // Half damage, rounded
   */
  scaleDamage(
    factor: number,
    rounding: "floor" | "round" | "ceil" = "floor"
  ): DiceQuery {
    return new DiceQuery([this.combined.scaleDamage(factor, rounding)]);
  }

  /**
   * Returns a new DiceQuery combining this query with another via convolution.
   * Equivalent to rolling both queries independently and adding results.
   * It is important to use this rather than combing()ing the PMFs directly!
   * This method maintains the provenance of the PMFs which is needed for damage attribution.
   * Combining the .combined PMFs directly is still valid for DPR calculations but
   * is not statistically sound for queries.
   *
   * @param other DiceQuery to combine with
   * @param eps Optional epsilon for precision control
   * @returns New DiceQuery representing the combined outcome
   *
   * @example
   * const mainAttack = parse("(d20 + 5 AC 15) * (2d6 + 3)");
   * const bonusAttack = parse("(d20 + 3 AC 15) * (1d6 + 1)");
   * const bothAttacks = mainAttack.convolve(bonusAttack);
   */
  convolve(other: DiceQuery): DiceQuery {
    const singles = [...this.singles, ...other.singles];
    return new DiceQuery(singles);
  }

  /**
   * First-success split over an ordered list of DISTINCT single-swing PMFs.
   * Each PMF may have different success/subset probabilities (from labels).
   *
   * successOutcome: e.g., ["success"] or ["hit", "crit"]
   * subsetOutcome:  e.g., ["subset"] or ["crit"] where subset ⊆ success
   *
   * Returns tuple: [pFirstNonSubset, pFirstSubset, pAnySuccess, pNone]
   */
  public firstSuccessSplit(
    successOutcome: string | string[],
    subsetOutcome: string | string[],
    eps = COMPUTATIONAL_EPS
  ): readonly [pSuccess: number, pSubset: number, pAny: number, pNone: number] {
    const pmfs = this.singles;
    if (!pmfs.length) {
      throw new Error("firstSuccessSplitFromPMFs: pmfs must be non-empty");
    }

    const toArr = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    const tol = Math.max(eps, 8 * Number.EPSILON);

    // Per-event probabilities from each PMF via DiceQuery([pmf])
    const per = pmfs.map((pmf) => {
      const dq = new DiceQuery([pmf]);
      const pS = dq.probAtLeastOne(toArr(successOutcome) as any);
      const pB = dq.probAtLeastOne(toArr(subsetOutcome) as any);
      if (pB - pS > eps) {
        throw new Error(
          "firstSuccessSplitFromPMFs: P(subset) > P(success) for an event. Ensure subset ⊆ success."
        );
      }
      return { pS, pB };
    });

    // Aggregate with running miss prefix
    let missSoFar = 1;
    let pFirstSubset = 0;
    let pFirstNonSubset = 0;
    let pNone = 1;

    for (const { pS, pB } of per) {
      pFirstSubset += missSoFar * pB;
      pFirstNonSubset += missSoFar * (pS - pB);
      const miss = 1 - pS;
      missSoFar *= miss;
      pNone *= miss;
    }

    const pAny = 1 - pNone;

    // Clamp and sanity check
    const a = clamp01(pFirstNonSubset);
    const b = clamp01(pFirstSubset);
    const any = clamp01(pAny);
    const none = clamp01(pNone);

    if (Math.abs(a + b - any) > tol * Math.max(1, any)) {
      throw new Error(
        `firstSuccessSplitFromPMFs: parts do not sum to pAny. got a+b=${
          a + b
        }, pAny=${any}`
      );
    }

    return [a, b, any, none] as const;
  }
}
// Make sure these types are exported in your public index, or inline them here.
export type OutcomeSnapshot = {
  atLeastOneProbability: number; // P(outcome occurs at least once)
  allProbability: number; // equal to atLeastOneProbability for a single aggregated PMF
  damageRange: { min: number; avg: number; max: number }; // conditional on the outcome occurring
};

export type Snapshot = {
  averageDPR: number;
  damageChance: number; // P(total damage > 0)
  percentiles: { p25: number; p50: number; p75: number };
  outcomes: Map<OutcomeType, OutcomeSnapshot>;
};
