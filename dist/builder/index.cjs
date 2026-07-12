'use strict';

// src/common/lru-cache.ts
var LRUCache = class {
  constructor(maxSize = 1e3) {
    this.maxSize = maxSize;
    this.cache = /* @__PURE__ */ new Map();
  }
  get(key) {
    const value = this.cache.get(key);
    if (value === void 0) return void 0;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  delete(key) {
    this.cache.delete(key);
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.delete(key);
    this.cache.set(key, value);
    return this;
  }
  clear() {
    this.cache.clear();
  }
  get size() {
    return this.cache.size;
  }
  has(key) {
    return this.cache.has(key);
  }
  keys() {
    return this.cache.keys();
  }
  values() {
    return this.cache.values();
  }
};

// src/common/types.ts
var EPS = 1e-12;
var MISS_NONE_OUTCOME = "missNone";

// src/pmf/query.ts
var _DiceQuery = class _DiceQuery {
  constructor(singles, combined, eps = EPS) {
    this.singles = Array.isArray(singles) ? singles : [singles];
    if (this.singles.some((s) => s === void 0)) {
      throw new Error("DiceQuery contains undefined singles");
    }
    this._eps = eps;
    this._combinedProvided = combined !== void 0;
    if (combined !== void 0) {
      this._combined = Math.abs(combined.mass() - 1) <= eps ? combined : combined.normalize();
    }
  }
  /**
   * The combined damage distribution of all single PMFs (their convolution),
   * normalized to total probability 1.
   *
   * Computed lazily on first access and cached. Queries that only need
   * additive statistics — {@link DiceQuery.mean}, {@link DiceQuery.variance},
   * {@link DiceQuery.stddev} — never trigger this convolution.
   */
  get combined() {
    if (this._combined === void 0) {
      const c = PMF.convolveMany(this.singles);
      this._combined = Math.abs(c.mass() - 1) <= this._eps ? c : c.normalize();
    }
    return this._combined;
  }
  /**
   * Returns a new PMF with damage attribution metadata populated.
   *
   * This method computes attribution on-demand for builder-generated PMFs,
   * enabling them to work with damage attribution charts. The `attr` field
   * tracks how much damage each outcome type contributes at each damage value.
   *
   * For each bin at damage D: sum(attr.values()) ≈ D × P(damage = D)
   *
   * Performance: Cached after first call. Adds minimal overhead vs `combined`.
   *
   * @returns PMF with attr field populated for damage attribution charts
   *
   * @example
   * const attack = d20.plus(5).ac(15).onHit(d(2,6).plus(3)).onCrit(d(2,6))
   * const query = attack.toQuery()
   * const pmf = query.combinedWithAttribution()
   * // Now pmf can be used with toDamageAttributionChartSeries()
   */
  combinedWithAttribution() {
    if (this._combinedWithAttr) {
      return this._combinedWithAttr;
    }
    if (this.singles.every((pmf) => pmf.hasAttribution())) {
      this._combinedWithAttr = this.combined;
      return this._combinedWithAttr;
    }
    const singlesWithAttr = this.singles.map((pmf) => pmf.withAttribution());
    const combined = PMF.convolveMany(singlesWithAttr, this.combined.epsilon);
    const normalized = Math.abs(combined.mass() - 1) <= this.combined.epsilon ? combined : combined.normalize();
    this._combinedWithAttr = normalized;
    return normalized;
  }
  /**
   * Per-label `damage value → probability mass` series for the combined,
   * attribution-carrying distribution — the provenance core of the stacked
   * damage-attribution chart. Convenience for
   * `combinedWithAttribution().attributionByValue()`; see
   * {@link PMF.attributionByValue}.
   */
  attributionByValue() {
    return this.combinedWithAttribution().attributionByValue();
  }
  /**
   * How many of the independent single PMFs can produce the given outcome
   * label. Useful for "all of them succeeded" style probabilities where the
   * exponent is the number of contributing attacks (see
   * {@link DiceQuery.probExactlyK}).
   */
  countSinglesWith(label) {
    let count = 0;
    for (const single of this.singles) {
      if (single.hasOutcome(label)) count++;
    }
    return count;
  }
  /**
   * Returns the expected damage across all possible outcomes.
   *
   * Example: `query.mean()` → 12.5
   * Use case: "What's my average damage per round?"
   */
  mean() {
    if (this._combinedProvided) {
      let m = 0;
      for (const [damageValue, bin] of this.combined) m += damageValue * bin.p;
      return m;
    }
    let totalMean = 0;
    for (const single of this.singles) {
      const mass = single.mass();
      if (mass <= 0) continue;
      totalMean += Math.abs(mass - 1) <= this._eps ? single.mean() : single.mean() / mass;
    }
    return totalMean;
  }
  /**
   * Returns the variance of the damage distribution.
   *
   * Example: `query.variance()` → 45.2
   * Use case: "How much does my damage vary from the average?"
   * High variance means higher risk/reward. Lower variance means more consistent damage.
   */
  variance() {
    if (this._combinedProvided) {
      const mu = this.mean();
      let v = 0;
      for (const [damageValue, bin] of this.combined) {
        const dev = damageValue - mu;
        v += dev * dev * bin.p;
      }
      return v;
    }
    let totalVariance = 0;
    for (const single of this.singles) {
      const mass = single.mass();
      if (mass <= 0) continue;
      if (Math.abs(mass - 1) <= this._eps) {
        totalVariance += single.variance();
      } else {
        let mu = 0;
        for (const [d2, b] of single) mu += d2 * (b.p / mass);
        let v = 0;
        for (const [d2, b] of single) {
          const dev = d2 - mu;
          v += dev * dev * (b.p / mass);
        }
        totalVariance += v;
      }
    }
    return totalVariance;
  }
  /**
   * Returns the standard deviation of the damage distribution.
   *
   * Example: `query.stdev()` → 6.7
   * Use case: "What's the typical spread around my average damage?"
   * Used to determine how consistent the damage is.
   */
  stddev() {
    return Math.sqrt(this.variance());
  }
  /** Alias of {@link DiceQuery.stddev}, matching {@link PMF.stdev}. */
  stdev() {
    return this.stddev();
  }
  /**
   * Returns the Cumulative Distribution Function.
   */
  cdf(x) {
    return this.probTotalAtMost(x);
  }
  /**
   * Returns the probability of dealing X damage or less.
   * In statistics, this is called the cumulative distribution function (CDF).
   * Example: `query.cdf(20)` → 0.75
   * Use case: "What's the chance I deal 20 damage or less?"
   */
  probTotalAtMost(x) {
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
  ccdf(x) {
    return this.probTotalAtLeast(x);
  }
  /**
   * Returns the probability of dealing at least X damage.
   *
   * Example: `query.probTotalAtLeast(25)` → 0.35
   * Use case: "What's the chance I deal at least 25 damage to finish the enemy?"
   */
  probTotalAtLeast(threshold) {
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
  percentiles(percentileValues) {
    const sortedDamageValues = this.combined.support();
    if (sortedDamageValues.length === 0) return percentileValues.map(() => 0);
    const cumulativeProbabilities = [];
    let runningProbabilitySum = 0;
    for (const damageValue of sortedDamageValues) {
      runningProbabilitySum += this.combined.map.get(damageValue).p;
      cumulativeProbabilities.push(runningProbabilitySum);
    }
    return percentileValues.map((targetPercentile) => {
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
      return leftBound < sortedDamageValues.length ? sortedDamageValues[leftBound] : sortedDamageValues[sortedDamageValues.length - 1];
    });
  }
  /**
   * Returns the minimum possible damage.
   *
   * Example: `query.min()` → 0
   * Use case: "What's the worst-case damage if everything misses?"
   */
  min() {
    return this.combined.min();
  }
  /**
   * Returns the maximum possible damage.
   *
   * Example: `query.max()` → 56
   * Use case: "What's the best-case damage if everything crits and rolls max?"
   */
  max() {
    return this.combined.max();
  }
  singleProb(diceIndex, label) {
    const single = this.singles[diceIndex];
    let probabilitySum = 0;
    for (const [, probabilityBin] of single) {
      probabilitySum += probabilityBin.count[label] || 0;
    }
    const mass = single.mass();
    return mass > 0 ? probabilitySum / mass : 0;
  }
  /**
   * Full count distribution [P(0), P(1), …, P(n)] for "an attack succeeds if it
   * carries ANY of `labels`", over the n independent singles.
   *
   * Each single's per-event success probability is the Poisson-binomial
   * marginal P(≥1 of labels) from {@link probabilityOf} (i.e. probAtLeastOne),
   * computed exactly once. The binomial DP then runs once to produce the whole
   * distribution, so the array-label paths of probExactlyK / probAtLeastK /
   * probAtMostK can slice or sum from it instead of rebuilding a DiceQuery and
   * re-running the DP per requested k.
   */
  countDistribution(labels) {
    const n = this.singles.length;
    const successProbabilities = this.singles.map(
      (single) => new _DiceQuery([single]).probabilityOf(labels)
    );
    const dist = new Array(n + 1).fill(0);
    dist[0] = 1;
    for (const successProb of successProbabilities) {
      for (let outcomeCount = n; outcomeCount >= 1; outcomeCount--) {
        dist[outcomeCount] = dist[outcomeCount] * (1 - successProb) + dist[outcomeCount - 1] * successProb;
      }
      dist[0] *= 1 - successProb;
    }
    return dist;
  }
  probAtLeastK(labels, k) {
    const L = Array.isArray(labels) ? [...new Set(labels)] : [labels];
    const n = this.singles.length;
    if (k <= 0) return 1;
    if (k > n) return 0;
    const dist = this.countDistribution(L);
    let tail = 0;
    for (let i = k; i <= n; i++) {
      tail += dist[i];
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
  probAtLeastOne(labels) {
    if (typeof labels === "string") {
      labels = [labels];
    }
    let productOfNonOccurrence = 1;
    for (let diceIndex = 0; diceIndex < this.singles.length; diceIndex++) {
      let combinedProbability = 0;
      for (const label of labels) {
        combinedProbability += this.singleProb(diceIndex, label);
      }
      if (combinedProbability < 0) combinedProbability = 0;
      else if (combinedProbability > 1) combinedProbability = 1;
      productOfNonOccurrence *= 1 - combinedProbability;
    }
    const result = 1 - productOfNonOccurrence;
    return result < 0 ? 0 : result > 1 ? 1 : result;
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
  computeBinomialProbabilities(label, maxK) {
    const individualProbabilities = this.singles.map(
      (_, diceIndex) => this.singleProb(diceIndex, label)
    );
    const binomialProbs = new Array(maxK + 1).fill(0);
    binomialProbs[0] = 1;
    for (const singleProbability of individualProbabilities) {
      for (let outcomeCount = maxK; outcomeCount >= 1; outcomeCount--) {
        binomialProbs[outcomeCount] = binomialProbs[outcomeCount] * (1 - singleProbability) + binomialProbs[outcomeCount - 1] * singleProbability;
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
   * - probExactlyK(['missDamage', 'missNone'], 0) = probability no attacks miss
   *
   * Use cases:
   * - "What's the chance exactly one of my attacks hits?"
   * - "How likely am I to get exactly 2 successes out of 3 attacks?"
   * - "What's the probability that exactly half my attacks succeed?"
   *
   * Note: For arrays, an attack counts as a "success" if it has any of the specified labels.
   * This is different from probAtMostK, which counts an attack as a "success" if it has ALL of the specified labels.
   */
  probExactlyK(labels, k) {
    if (typeof labels === "string") {
      const probabilityArray = this.computeBinomialProbabilities(labels, k);
      return probabilityArray[k];
    }
    const dist = this.countDistribution(labels);
    return k >= 0 && k < dist.length ? dist[k] : 0;
  }
  /**
   * Returns the probability that AT MOST K attacks result in the specified outcome(s).
   *
   * Single label examples:
   * - probAtMostK('hit', 1) = probability 0 or 1 attacks hit (at most 1)
   * - probAtMostK('crit', 0) = probability no attacks crit
   * - probAtMostK('missDamage', 2) = probability at most 2 attacks miss
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
  probAtMostK(labels, k) {
    if (typeof labels === "string") {
      const probabilityArray = this.computeBinomialProbabilities(labels, k);
      let cumulativeSum2 = 0;
      for (let outcomeCount = 0; outcomeCount <= k; outcomeCount++) {
        cumulativeSum2 += probabilityArray[outcomeCount];
      }
      return cumulativeSum2;
    }
    const dist = this.countDistribution(labels);
    const upper = Math.min(k, dist.length - 1);
    let cumulativeSum = 0;
    for (let outcomeCount = 0; outcomeCount <= upper; outcomeCount++) {
      cumulativeSum += dist[outcomeCount];
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
  expectedDamageFrom(labels) {
    const wanted = Array.isArray(labels) ? labels : [labels];
    let total = 0;
    for (const single of this.singles) {
      for (const [dmg, bin] of single) {
        let p = 0;
        for (const label of wanted) p += bin.count[label] ?? 0;
        total += dmg * p;
      }
    }
    return total;
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
   * - damageStatsFrom(['missDamage', 'missNone']) = damage range when at least one attack misses
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
   * KNOWN LIMITATION (multi-attack, single label): the returned `count` is an
   * EXPECTED COUNT (E[#label], so > 1 for N≥2 attacks, not a probability), and
   * `avg` is the size-biased conditional mean E[dmg·#label]/E[#label] rather than
   * E[dmg | the label occurs]. For a single attack both are the plain
   * conditional figures. Use {@link probAtLeastOne} for the scenario probability.
   *
   * @example
   * // High-level tactical planning
   * const successStats = query.damageStatsFrom('hit')
   * const successChance = query.probAtLeastOne('hit')
   * console.log(`${(successChance*100).toFixed(1)}% chance to do ${successStats.min}-${successStats.max} damage`)
   */
  damageStatsFrom(labels) {
    const labelArray = typeof labels === "string" ? [labels] : labels;
    let minDamage = Infinity;
    let maxDamage = -Infinity;
    let totalDamage = 0;
    let totalCount = 0;
    for (const [damage, probabilityBin] of this.combined) {
      let binHasAnyLabel = false;
      let binContribution = 0;
      for (const label of labelArray) {
        const count = probabilityBin.count[label];
        if (count && count > 0) {
          binHasAnyLabel = true;
          binContribution += count;
        }
      }
      if (damage > 0 && binHasAnyLabel) {
        minDamage = Math.min(minDamage, damage);
        maxDamage = Math.max(maxDamage, damage);
        const weightToUse = labelArray.length === 1 ? binContribution : probabilityBin.p;
        totalDamage += damage * weightToUse;
        totalCount += weightToUse;
      }
    }
    return {
      min: minDamage === Infinity ? 0 : minDamage,
      max: maxDamage === -Infinity ? 0 : maxDamage,
      avg: totalCount > 0 ? totalDamage / totalCount : 0,
      count: totalCount
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
  combinedDamageStats(targetLabel) {
    const singleStats = this.singles.map(
      (single) => new _DiceQuery([single]).damageStatsFrom(targetLabel)
    );
    if (singleStats.some((stats) => stats.count === 0)) {
      return { min: 0, max: 0, avg: 0, count: 0 };
    }
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
      count: combinedProb
    };
  }
  /**
   * Returns the probability that at least one attack carries ANY of the
   * specified labels (the marginal P(≥1) across the independent attacks).
   *
   * Examples:
   * - `query.probabilityOf('hit')` → 0.88 (probability at least one hit occurs)
   * - `query.probabilityOf(['hit', 'crit'])` → 0.96 (probability of any success)
   *
   * Use cases:
   * - "What's the chance my resolution includes a success label?"
   * - "How likely am I to get any hits or crits across all attacks?"
   *
   * Note: this must NOT be computed by summing `combined` bin probabilities. A
   * single combined damage total is reachable by many outcome combinations and
   * a bin can hold several labels at once, so summing `bin.p` over bins that
   * contain a label over-counts. The correct marginal is the Poisson-binomial
   * complement over the per-attack probabilities, i.e. {@link probAtLeastOne}.
   */
  probabilityOf(labels) {
    return this.probAtLeastOne(labels);
  }
  /**
   * Returns the probability of missing (any type of miss).
   *
   * Example: `query.missChance()` → 0.04
   * Use case: "What's the chance I miss completely this turn?"
   */
  missChance() {
    return this.probabilityOf(["missDamage", "missNone"]);
  }
  /**
   * Returns data formatted for plotting damage probability distribution.
   *
   * Example: `query.toChartSeries()` → [{x: 0, y: 0.04}, {x: 6, y: 0.1}, ...]
   * Use case: "I want to visualize my damage distribution in a chart."
   */
  toChartSeries() {
    return this.combined.support().map((damageValue) => ({
      x: damageValue,
      y: this.combined.map.get(damageValue).p
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
  toLabeledTable(labels = []) {
    return this.combined.support().map((damageValue) => {
      const probabilityBin = this.combined.map.get(damageValue);
      const tableRow = {
        damage: damageValue,
        total: probabilityBin.p
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
  toStackedChartData(labels = [], epsilon = EPS) {
    const damageValues = this.combined.support();
    const datasets = labels.map((outcomeLabel) => ({
      label: outcomeLabel,
      data: damageValues.map((dmg) => {
        const bin = this.combined.map.get(dmg);
        const v = bin ? bin.count[outcomeLabel] || 0 : 0;
        return v <= epsilon ? 0 : v;
      })
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
  toAttributionChartSeries(options = {}) {
    const {
      stackOrder = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit"
      ],
      filterRules = (outcome, damage) => !(outcome === "missNone" && damage !== 0),
      asPercentages = true
    } = options;
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], outcomes: [], data: {} };
    }
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );
    const allOutcomeTypes = /* @__PURE__ */ new Set();
    for (const [, bin] of this.combined.map) {
      for (const outcomeType in bin.count) {
        if (bin.count[outcomeType] && bin.count[outcomeType] > 0) {
          allOutcomeTypes.add(outcomeType);
        }
      }
    }
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
    const data = {};
    for (const outcome of existingOutcomes) {
      data[outcome] = support.map((damage) => {
        const bin = this.combined.map.get(damage);
        if (!bin) return 0;
        if (!filterRules(outcome, damage)) {
          return 0;
        }
        const outcomeCount = bin.count[outcome] || 0;
        let totalChartableCount = 0;
        for (const [outcomeName, count] of Object.entries(bin.count)) {
          if (filterRules(outcomeName, damage)) {
            totalChartableCount += count || 0;
          }
        }
        if (totalChartableCount === 0) return 0;
        const outcomeFraction = outcomeCount / totalChartableCount;
        const outcomeProbability = bin.p * outcomeFraction;
        return asPercentages ? outcomeProbability * 100 : outcomeProbability;
      });
    }
    return {
      support,
      outcomes: existingOutcomes,
      data
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
  toDamageAttributionChartSeries(options = {}) {
    const {
      stackOrder = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit"
      ],
      filterRules = (outcome, damage) => !(outcome === "missNone" && damage !== 0),
      asPercentages = true
    } = options;
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], outcomes: [], data: {} };
    }
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );
    const allOutcomeTypes = /* @__PURE__ */ new Set();
    for (const [, bin] of this.combined.map) {
      if (bin.attr) {
        for (const outcomeType in bin.attr) {
          if (bin.attr[outcomeType] && bin.attr[outcomeType] > 0) {
            allOutcomeTypes.add(outcomeType);
          }
        }
      }
    }
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
    const data = {};
    for (const outcome of existingOutcomes) {
      data[outcome] = support.map((damage) => {
        const bin = this.combined.map.get(damage);
        if (!bin || !bin.attr) return 0;
        if (!filterRules(outcome, damage)) {
          return 0;
        }
        const outcomeDamageAttribution = bin.attr[outcome] || 0;
        if (asPercentages) {
          let totalDamageAttribution = 0;
          for (const [outcomeName, damageAttr] of Object.entries(bin.attr)) {
            if (filterRules(outcomeName, damage)) {
              totalDamageAttribution += damageAttr || 0;
            }
          }
          if (totalDamageAttribution === 0) return 0;
          const damagePercentage = outcomeDamageAttribution / totalDamageAttribution * 100;
          return damagePercentage * bin.p * 100;
        } else {
          return outcomeDamageAttribution;
        }
      });
    }
    return {
      support,
      outcomes: existingOutcomes,
      data
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
  toOutcomeAttributionChartSeries(options = {}) {
    const {
      stackOrder = [
        "missNone",
        "missDamage",
        "saveFail",
        "saveHalf",
        "pc",
        "hit",
        "crit"
      ],
      filterRules = (outcome, damage) => !(outcome === "missNone" && damage !== 0),
      asPercentages = true
    } = options;
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], outcomes: [], data: {} };
    }
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );
    const allOutcomeTypes = /* @__PURE__ */ new Set();
    for (const [, bin] of this.combined.map) {
      for (const outcomeType in bin.count) {
        if (bin.count[outcomeType] && bin.count[outcomeType] > 0) {
          allOutcomeTypes.add(outcomeType);
        }
      }
    }
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
    const data = {};
    for (const outcome of existingOutcomes) {
      data[outcome] = support.map((damage) => {
        const bin = this.combined.map.get(damage);
        if (!bin) return 0;
        if (!filterRules(outcome, damage)) {
          return 0;
        }
        if (outcome === "missNone") {
          const outcomeCount = bin.count[outcome] || 0;
          if (outcomeCount === 0) return 0;
          if (asPercentages) {
            let totalChartableCount = 0;
            for (const [outcomeName, count] of Object.entries(bin.count)) {
              if (filterRules(outcomeName, damage)) {
                totalChartableCount += count || 0;
              }
            }
            if (totalChartableCount === 0) return 0;
            const outcomeFraction = outcomeCount / totalChartableCount;
            return outcomeFraction * bin.p * 100;
          } else {
            return outcomeCount;
          }
        }
        if (!bin.attr) return 0;
        const outcomeDamageContribution = bin.attr[outcome] || 0;
        if (asPercentages) {
          let totalDamageAttribution = 0;
          for (const [, damageAttr] of Object.entries(bin.attr)) {
            totalDamageAttribution += damageAttr || 0;
          }
          if (totalDamageAttribution === 0) return 0;
          const outcomeFraction = outcomeDamageContribution / totalDamageAttribution;
          return outcomeFraction * bin.p * 100;
        } else {
          return outcomeDamageContribution;
        }
      });
    }
    return {
      support,
      outcomes: existingOutcomes,
      data
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
  toCDFSeries(asPercentages = true) {
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], data: [] };
    }
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );
    let cumulativeProbability = 0;
    const cdfData = [];
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
      data: cdfData
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
  toCCDFSeries(asPercentages = true) {
    const originalSupport = this.combined.support();
    if (originalSupport.length === 0) {
      return { support: [], data: [] };
    }
    const minDamage = Math.min(...originalSupport);
    const maxDamage = Math.max(...originalSupport);
    const support = Array.from(
      { length: maxDamage - minDamage + 1 },
      (_, i) => minDamage + i
    );
    let cumulativeProbability = 0;
    const ccdfData = [];
    for (const damage of support) {
      const ccdf = 1 - cumulativeProbability;
      ccdfData.push(asPercentages ? ccdf * 100 : ccdf);
      const bin = this.combined.map.get(damage);
      if (bin) {
        cumulativeProbability += bin.p;
      }
    }
    return {
      support,
      data: ccdfData
    };
  }
  /*
        Statistics snapshot of the query.
            */
  /** Probability of doing strictly more than threshold damage (default >0). */
  probDamageGreaterThan(threshold = 0) {
    let acc = 0;
    for (const [x, bin] of this.combined.map) if (x > threshold) acc += bin.p;
    return acc;
  }
  /** All outcome keys actually present (typed & ordered if you pass an order). */
  outcomeKeys(order) {
    const found = /* @__PURE__ */ new Set();
    for (const [, bin] of this.combined.map) {
      for (const k in bin.count)
        if (bin.count[k] && bin.count[k] > 0) found.add(k);
    }
    if (found.size === 0)
      ["hit", "crit", "missNone"].forEach((k) => found.add(k));
    const keys = Array.from(found).filter(
      (k) => order?.includes(k) ?? true
    );
    if (order && order.length)
      keys.sort((a, b) => order.indexOf(a) + 999 - (order.indexOf(b) + 999));
    return keys;
  }
  /** Total probability per outcome across the PMF. */
  outcomeTotals(outcomes = this.outcomeKeys()) {
    const totals = /* @__PURE__ */ new Map();
    outcomes.forEach((o) => totals.set(o, 0));
    for (const [, row] of this.combined.map) {
      for (const o of outcomes) {
        const p = row.count[o] || 0;
        totals.set(o, (totals.get(o) || 0) + p);
      }
    }
    return totals;
  }
  /** Conditional damage range per outcome (min/avg/max of X | outcome). */
  outcomeDamageRanges(outcomes = this.outcomeKeys()) {
    const table = this.toLabeledTable(outcomes);
    const ranges = /* @__PURE__ */ new Map();
    outcomes.forEach((o) => ranges.set(o, { sum: 0, mass: 0 }));
    for (const row of table) {
      const dmg = row.damage;
      for (const o of outcomes) {
        const p = row[o] || 0;
        if (p > 0) {
          const r = ranges.get(o);
          r.sum += dmg * p;
          r.mass += p;
          if (r.min === void 0 || dmg < r.min) r.min = dmg;
          if (r.max === void 0 || dmg > r.max) r.max = dmg;
        }
      }
    }
    const out = /* @__PURE__ */ new Map();
    for (const o of outcomes) {
      const r = ranges.get(o);
      const avg = r.mass > 0 ? r.sum / r.mass : 0;
      out.set(o, { min: r.min ?? 0, avg, max: r.max ?? 0 });
    }
    return out;
  }
  /**
   * Snapshot of the distribution in the exact shape the UI consumes.
   * - outcome probabilities are "at least one" (and equal to "all" for a single PMF)
   * - damageRange is conditional on the outcome occurring
   *
   * The outcome probabilities use the correct Poisson-binomial marginals
   * (`atLeastOneProbability` = P(≥1 attack has it), `allProbability` = P(all do)),
   * so they are always valid probabilities in [0,1].
   *
   * KNOWN LIMITATION (multi-attack): `damageRange.avg` is still aggregated from
   * the combined PMF's `count`, which the convolution accumulates as an EXPECTED
   * COUNT, so for N≥2 attacks it is the size-biased mean E[dmg·#label]/E[#label]
   * rather than a clean conditional expectation. It is correct for a single
   * attack.
   */
  snapshot(order) {
    const discovered = /* @__PURE__ */ new Set();
    for (const [, bin] of this.combined.map) {
      for (const k in bin.count) {
        if (bin.count[k] && bin.count[k] > 0) discovered.add(k);
      }
    }
    if (discovered.size === 0) {
      for (const k of _DiceQuery.DEFAULT_OUTCOMES) discovered.add(k);
    }
    let outcomes = Array.from(discovered);
    if (order && order.length) {
      const inOrder = new Set(order);
      outcomes = outcomes.filter((k) => inOrder.has(k));
      const rank = new Map(order.map((k, i) => [k, i]));
      outcomes.sort(
        (a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999)
      );
    }
    const rows = this.toLabeledTable(outcomes);
    const rangeAcc = /* @__PURE__ */ new Map();
    for (const ot of outcomes) {
      rangeAcc.set(ot, { sum: 0, mass: 0 });
    }
    for (const row of rows) {
      const dmg = row.damage;
      for (const ot of outcomes) {
        const p = row[ot] || 0;
        if (p <= 0) continue;
        const r = rangeAcc.get(ot);
        r.sum += dmg * p;
        r.mass += p;
        if (r.min === void 0 || dmg < r.min) r.min = dmg;
        if (r.max === void 0 || dmg > r.max) r.max = dmg;
      }
    }
    const n = this.singles.length;
    const outcomeMap = /* @__PURE__ */ new Map();
    for (const ot of outcomes) {
      const r = rangeAcc.get(ot);
      const avg = r.mass > 0 ? r.sum / r.mass : 0;
      outcomeMap.set(ot, {
        atLeastOneProbability: this.probAtLeastOne(ot),
        allProbability: this.probAtLeastK(ot, n),
        damageRange: { min: r.min ?? 0, avg, max: r.max ?? 0 }
      });
    }
    const averageDPR = this.mean();
    let damageChance = 0;
    for (const [x, bin] of this.combined.map) if (x > 0) damageChance += bin.p;
    const { support, data } = this.toCDFSeries(false);
    const quantile = (p) => {
      if (support.length === 0) return 0;
      for (let i = 0; i < support.length; i++)
        if (data[i] >= p) return support[i];
      return support[support.length - 1];
    };
    const percentiles = {
      p25: quantile(0.25),
      p50: quantile(0.5),
      p75: quantile(0.75)
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
  normalize() {
    return new _DiceQuery([this.combined.normalize()]);
  }
  /**
   * Returns a new DiceQuery with low-probability outcomes removed.
   *
   * @param eps Minimum probability threshold (defaults to PMF epsilon)
   * @param keepFinalBin Whether to keep the highest damage bin regardless of probability
   * @returns New DiceQuery with compacted combined PMF
   */
  compact(eps, keepFinalBin) {
    return new _DiceQuery([this.combined.compact(eps, keepFinalBin)]);
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
  addScaled(branch, probability) {
    return new _DiceQuery([
      this.combined.addScaled(branch.combined, probability)
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
  scaleMass(factor) {
    return new _DiceQuery([this.combined.scaleMass(factor)]);
  }
  totalMass() {
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
  mapDamage(damageTransformFunction) {
    return new _DiceQuery([this.combined.mapDamage(damageTransformFunction)]);
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
  scaleDamage(factor, rounding = "floor") {
    return new _DiceQuery([this.combined.scaleDamage(factor, rounding)]);
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
  convolve(other) {
    const singles = [...this.singles, ...other.singles];
    return new _DiceQuery(singles);
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
  firstSuccessSplit(successOutcome, subsetOutcome, eps = EPS) {
    const pmfs = this.singles;
    if (!pmfs.length) {
      throw new Error("firstSuccessSplitFromPMFs: pmfs must be non-empty");
    }
    const toArr = (x) => Array.isArray(x) ? x : [x];
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const tol = Math.max(eps, 8 * Number.EPSILON);
    const per = pmfs.map((pmf) => {
      const dq = new _DiceQuery([pmf]);
      const pS = dq.probAtLeastOne(toArr(successOutcome));
      const pB = dq.probAtLeastOne(toArr(subsetOutcome));
      if (pB - pS > eps) {
        throw new Error(
          "firstSuccessSplitFromPMFs: P(subset) > P(success) for an event. Ensure subset \u2286 success."
        );
      }
      return { pS, pB };
    });
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
    const a = clamp01(pFirstNonSubset);
    const b = clamp01(pFirstSubset);
    const any = clamp01(pAny);
    const none = clamp01(pNone);
    if (Math.abs(a + b - any) > tol * Math.max(1, any)) {
      throw new Error(
        `firstSuccessSplitFromPMFs: parts do not sum to pAny. got a+b=${a + b}, pAny=${any}`
      );
    }
    return [a, b, any, none];
  }
};
_DiceQuery.DEFAULT_OUTCOMES = [
  "hit",
  "crit",
  "missNone"
];
var DiceQuery = _DiceQuery;
var pmfCache = new LRUCache(1e3);
var _PMF = class _PMF {
  constructor(map = /* @__PURE__ */ new Map(), epsilon = EPS, normalized = false, identifier = `anon#${_PMF.__anonIdCounter++}`, _preservedProvenance = true) {
    this.map = map;
    this.epsilon = epsilon;
    this.normalized = normalized;
    this.identifier = identifier;
    this._preservedProvenance = _preservedProvenance;
  }
  static empty(epsilon = EPS, identifier = "empty") {
    return new _PMF(/* @__PURE__ */ new Map(), epsilon, false, identifier);
  }
  // This has a single bin at value 0, mass of 1
  static zero(epsilon = EPS) {
    const m = /* @__PURE__ */ new Map();
    m.set(0, { p: 1, count: { miss: 1 }, attr: {} });
    return new _PMF(m, epsilon, false, "zero");
  }
  static delta(value, epsilon = EPS) {
    return _PMF.fromMap(/* @__PURE__ */ new Map([[value, 1]]), epsilon);
  }
  /**
   * Point mass at damage 0 tagged with the canonical `missNone` outcome.
   *
   * Differs from {@link PMF.zero}, which labels its zero bin `miss` — the
   * builder's attack-resolution vocabulary. This uses the `missNone`
   * {@link OutcomeType} that the attribution charts and outcome stats key on,
   * so it is the correct "clean miss / no damage" delta for provenance-aware
   * mixtures feeding those consumers.
   */
  static missNone(epsilon = EPS) {
    const m = /* @__PURE__ */ new Map();
    m.set(0, { p: 1, count: { [MISS_NONE_OUTCOME]: 1 }, attr: {} });
    return new _PMF(m, epsilon, false, "missNone");
  }
  // This creates a single bin at value 0, but with weight 0.
  static emptyMass() {
    return _PMF.zero().scaleMass(0);
  }
  //  Makes PMF iterable over [damage, bin] pairs.
  [Symbol.iterator]() {
    return this.map[Symbol.iterator]();
  }
  static clearCache() {
    pmfCache.clear();
  }
  /**
   * Creates a conditional PMF from two branches (success and failure) and a probability.
   * This is the core logic for modeling any probabilistic event where there are two
   * distinct outcomes.
   */
  static branch(successPMF, failurePMF, successProbability) {
    let p = successProbability;
    if (!Number.isFinite(p)) p = 0;
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    const q = 1 - p;
    if (p === 0) return failurePMF.scaleMass(1);
    if (p === 1) return successPMF.scaleMass(1);
    const eps = successPMF.epsilon ?? failurePMF.epsilon;
    const id = `branch(${failurePMF.identifier}*${q.toFixed(6)} + ${successPMF.identifier}*${p.toFixed(6)})`;
    const resultMap = /* @__PURE__ */ new Map();
    for (const [damageValue, bin] of failurePMF.map) {
      _PMF.mergeInto(resultMap, damageValue, _PMF.scaleBin(bin, q));
    }
    for (const [damageValue, bin] of successPMF.map) {
      _PMF.mergeInto(resultMap, damageValue, _PMF.scaleBin(bin, p));
    }
    return new _PMF(resultMap, eps, false, id);
  }
  /**
   * withProbability()
   *
   * A convenience wrapper around branch() for the common case where the "failure" branch is always zero().
   *
   *  Think of this as a shortcut for:
   *    pmf.gate(p, PMF.zero())
   *
   * Use this to model a *single* Bernoulli event — an outcome that either happens or doesn't,
   * like an opportunity attack that occurs with probability p, or a single attack that either hits or misses.
   *
   * This is **not** for combining multiple independent attacks or mutually exclusive multi-outcome scenarios.
   * - For multiple independent swings, use DiceQuery with separate PMFs for each attack.
   * - For modeling "first success" logic across multiple attacks (like Sneak Attack or Smite)
   *   use query.firstSuccessSplit() to get the exact probabilities.
   * - For scenarios with several mutually exclusive outcomes (like crit vs hit vs none), use PMF.exclusive().
   *
   */
  static withProbability(successPMF, probability) {
    return _PMF.branch(successPMF, _PMF.zero(), probability);
  }
  /**
   * gate()
   *
   * A conditional wrapper around branch() that applies this PMF with probability `p`,
   * and applies a provided fallback PMF otherwise.
   *
   * This is useful for modeling a binary choice between two outcomes:
   * - The "success" outcome (this PMF) happens with probability `p`.
   * - The "failure" outcome (fallback PMF) happens with probability `1 - p`.
   *
   * Examples:
   * - 25% chance to include an opportunity attack, otherwise nothing:
   *     attackPMF.gate(0.25, PMF.zero())
   *
   * - 50% chance to deal fireball damage, otherwise cone of cold damage:
   *     fireballPMF.gate(0.5, coneOfColdPMF)
   *
   * Relationship to other helpers:
   * - **withProbability()** is a shortcut for the common case where the fallback is `PMF.zero()`.
   * - **exclusive()** is for three or more mutually exclusive outcomes (e.g., crit vs hit vs none).
   *
   * @param p Probability of applying this PMF (between 0 and 1).
   * @param fallback PMF to apply when this PMF is *not* selected.
   * @returns A new PMF representing the weighted mixture of this PMF and the fallback.
   */
  gate(p, fallback) {
    return _PMF.branch(this, fallback, p);
  }
  /**
   * PMF.exclusive()
   *
   * Builds a single PMF from a set of mutually exclusive weighted outcomes.
   * Exactly one of the provided options will occur.
   *
   * Each option has:
   *  - A PMF representing its outcome (e.g., damage dice).
   *  - A weight representing its probability of being selected.
   *
   * Notes:
   *  - If total weight < 1 (within eps), leftover mass is assumed to be PMF.zero()
   *
   * @param options Array of `{ pmf, weight }` or `[PMF, number]`.
   * @param eps Optional tolerance for floating point rounding.
   */
  static exclusive(options, eps = EPS) {
    const items = options.map(
      (o) => Array.isArray(o) ? { pmf: o[0], weight: o[1] } : o
    );
    for (const { weight } of items) {
      if (!Number.isFinite(weight) || weight < -eps) {
        throw new Error(`PMF.exclusive: invalid weight ${weight}.`);
      }
    }
    let totalWeight = items.reduce((s, { weight }) => s + weight, 0);
    if (Math.abs(totalWeight) <= eps) totalWeight = 0;
    if (Math.abs(1 - totalWeight) <= eps) totalWeight = 1;
    if (totalWeight > 1 + EPS) {
      throw new Error(
        `PMF.exclusive: total weight ${totalWeight} exceeds 1. (epsilon: ${eps})`
      );
    }
    let out = _PMF.empty(eps);
    for (const { pmf, weight } of items) {
      if (weight > eps) out = out.addScaled(pmf, weight);
    }
    const leftover = Math.max(0, 1 - totalWeight);
    if (leftover > eps) {
      out = out.addScaled(_PMF.zero(), leftover);
    }
    return out;
  }
  /**
   * PMF.mix()
   *
   * Builds a PMF as a linear combination of input PMFs with the given weights.
   * Unlike `exclusive`, this does NOT:
   *  - enforce that weights sum to 1
   *  - add leftover probability to δ0 (PMF.zero())
   *
   * Use when outcomes are not mutually exclusive, or for interpolation/blending.
   *
   * @param options Array of `{ pmf, weight }` or `[PMF, number]`.
   * @param eps Optional tolerance for skipping tiny weights.
   */
  static mix(options, eps = EPS) {
    const items = options.map(
      (o) => Array.isArray(o) ? { pmf: o[0], weight: o[1] } : o
    );
    for (const { weight } of items) {
      if (!Number.isFinite(weight)) {
        throw new Error(`PMF.mix: invalid weight ${weight}.`);
      }
    }
    let out = _PMF.empty(eps);
    for (const { pmf, weight } of items) {
      if (Math.abs(weight) <= eps) continue;
      out = out.addScaled(pmf, weight);
    }
    return out;
  }
  /**
   * Adds damage attribution metadata to this PMF based on existing count metadata.
   * For each bin, sets attr[outcome] = damage × count[outcome].
   *
   * This enables damage attribution charts to work with builder-generated PMFs.
   * The parser generates attr automatically, but builder PMFs only have count.
   *
   * @returns New PMF with attr field populated in each bin
   */
  /**
   * Returns true if this PMF already carries damage attribution metadata.
   *
   * Only the first positive-damage bin is inspected (parser-generated PMFs
   * populate `attr` uniformly), so this is O(1) in practice.
   */
  hasAttribution() {
    for (const [damage, bin] of this.map) {
      if (damage !== 0 && bin.attr && Object.keys(bin.attr).length > 0) {
        return true;
      }
      if (damage > 0) break;
    }
    return false;
  }
  withAttribution() {
    if (this.hasAttribution()) return this;
    const newMap = /* @__PURE__ */ new Map();
    for (const [damage, bin] of this.map) {
      const attr = {};
      for (const outcome in bin.count) {
        const probability = bin.count[outcome];
        if (probability > 0) {
          attr[outcome] = damage * probability;
        }
      }
      newMap.set(damage, {
        p: bin.p,
        count: { ...bin.count },
        attr: Object.keys(attr).length > 0 ? attr : void 0
      });
    }
    return new _PMF(
      newMap,
      this.epsilon,
      this.normalized,
      `${this.identifier}~attr`
    );
  }
  /**
   * General-purpose N-way mixture.
   * weights: Array of [weight, PMF].
   *
   * Example: PMF.mixN([
   *   [pMiss, zero],
   *   [pHit, hitPMF],
   *   [pCrit, critPMF],
   * ]);
   */
  static mixN(weights, eps = EPS) {
    const filtered = weights.filter(([w]) => w > eps);
    if (filtered.length === 0) {
      return _PMF.emptyMass();
    }
    let acc = null;
    let sum = 0;
    for (const [w, pmf] of filtered) {
      if (acc === null) {
        acc = pmf;
        sum = w;
      } else {
        const q = w / (sum + w);
        acc = _PMF.branch(pmf, acc, q);
        sum += w;
      }
    }
    return acc ?? _PMF.emptyMass();
  }
  // This is a convenience method for when we use power
  // TODO: It can be smarter in the future, and we can also add it to query
  // That way statistics operations on invalid PMFs can throw an error
  // TODO… how can we detect if manually merging two queries' combined PMFs, as that loses provenance?
  setPreservedProvenance(preserved) {
    if (!this._preservedProvenance && preserved) {
      throw new Error(
        "Preserved provenance is already set to false, cannot fix that"
      );
    }
    this._preservedProvenance = preserved;
  }
  preservedProvenance() {
    return this._preservedProvenance;
  }
  getPowerCacheKey(n, eps) {
    const id = this.identifier;
    let key = `${id}`;
    for (let i = 1; i < n; i++) key += `+${id}`;
    return `${key}@${eps}`;
  }
  /**
   * Efficiently computes this PMF convolved with itself `n` times.
   * Uses exponentiation by squaring to reduce total convolutions.
   * n must be a positive integer.
   * *
   * * NOTE: This folds multiple independent attacks into a single PMF.
   * As a result, The power() method causes a loss of data provenance.
   * This is ONLY SAFE if you are trying to calculate masses.
   * If you want to query any atLeast probabilities, you should use the DiceQuery class instead without power().
   */
  power(n, eps = this.epsilon) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("power(n): n must be a positive integer");
    }
    if (n === 1) return this;
    const epsilon = eps ?? this.epsilon;
    const key = this.getPowerCacheKey(n, epsilon);
    {
      const cached = pmfCache?.get(key);
      if (cached) return cached;
    }
    let base = this.normalized ? this : this.normalize();
    let result = base;
    let exp = n - 1;
    while (exp > 0) {
      if (exp & 1) {
        result = result.convolve(base, epsilon);
      }
      exp >>= 1;
      if (exp > 0) {
        base = base.convolve(base, epsilon);
      }
    }
    result.setPreservedProvenance(false);
    {
      pmfCache?.set(key, result);
    }
    return result;
  }
  /*
   * Helper for chaining multiple identical attacks
   */
  replicate(n) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("replicate(n): n must be a positive integer");
    }
    if (n === 1) return [this];
    return Array.from({ length: n }, () => this);
  }
  mass() {
    if (this._totalMass === void 0) {
      let totalProbabilityMass = 0;
      for (const { p } of this.map.values()) {
        totalProbabilityMass += p;
      }
      this._totalMass = totalProbabilityMass;
    }
    return this._totalMass;
  }
  outcomeMass(outcome) {
    let totalProbabilityMass = 0;
    for (const { p, count } of this.map.values()) {
      totalProbabilityMass += p * (count[outcome] ?? 0);
    }
    return totalProbabilityMass;
  }
  // Helper for testing
  faceTotal() {
    return [...this.map.keys()].reduce((sum, key) => sum + key, 0);
  }
  normalize() {
    if (this.normalized) return this;
    const normalizationFactor = this.mass();
    if (normalizationFactor === 0) return this;
    const normalizedMap = /* @__PURE__ */ new Map();
    for (const [damageValue, probabilityBin] of this.map) {
      const normalizedCount = {};
      for (const labelKey in probabilityBin.count) {
        normalizedCount[labelKey] = probabilityBin.count[labelKey] / normalizationFactor;
      }
      let normalizedAttributes;
      if (probabilityBin.attr) {
        normalizedAttributes = {};
        for (const labelKey in probabilityBin.attr) {
          normalizedAttributes[labelKey] = probabilityBin.attr[labelKey] / normalizationFactor;
        }
      }
      normalizedMap.set(damageValue, {
        p: probabilityBin.p / normalizationFactor,
        count: normalizedCount,
        attr: normalizedAttributes
      });
    }
    return new _PMF(normalizedMap, this.epsilon, true, this.identifier);
  }
  /**
   * Returns a copy with negligible probabilities removed (p < eps).
   * If keepFinalBin is true, the bin with the largest key is always kept,
   * even if its probability is below eps. count/attr submaps are still cleaned.
   */
  compact(eps = this.epsilon, keepFinalBin = false) {
    let maxKey = -Infinity;
    if (keepFinalBin) {
      for (const key of this.map.keys()) {
        if (key > maxKey) maxKey = key;
      }
    }
    const compactedMap = /* @__PURE__ */ new Map();
    for (const [damageValue, probabilityBin] of this.map) {
      const shouldKeep = probabilityBin.p >= eps || keepFinalBin && damageValue === maxKey;
      if (!shouldKeep) continue;
      const cleanedBin = _PMF.cloneBin(probabilityBin);
      for (const labelKey in cleanedBin.count) {
        if (Math.abs(cleanedBin.count[labelKey] || 0) < eps) {
          delete cleanedBin.count[labelKey];
        }
      }
      if (cleanedBin.attr) {
        for (const labelKey in cleanedBin.attr) {
          if (Math.abs(cleanedBin.attr[labelKey] || 0) < eps) {
            delete cleanedBin.attr[labelKey];
          }
        }
        if (Object.keys(cleanedBin.attr).length === 0) {
          cleanedBin.attr = void 0;
        }
      }
      compactedMap.set(damageValue, cleanedBin);
    }
    return new _PMF(compactedMap, eps, this.normalized, this.identifier);
  }
  // Note: The "support" of a PMF is the set of all non-zero probability outcomes.
  // This returns all damage values with non-zero probability, sorted ascending.
  support() {
    if (this._support === void 0) {
      this._support = [...this.map.keys()].sort((a, b) => a - b);
    }
    return this._support;
  }
  // Minimum possible damage value.
  min() {
    if (this._min === void 0) {
      const support = this.support();
      this._min = support.length > 0 ? support[0] : 0;
    }
    return this._min;
  }
  // Maximum possible damage value.
  max() {
    if (this._max === void 0) {
      const support = this.support();
      this._max = support.length > 0 ? support[support.length - 1] : 0;
    }
    return this._max;
  }
  /**
   * Returns the expected (mean) damage value.
   * Cached for performance since this requires iterating through all bins.
   */
  mean() {
    if (this._mean === void 0) {
      let totalSum = 0;
      for (const [damageValue, probabilityBin] of this.map) {
        totalSum += damageValue * probabilityBin.p;
      }
      this._mean = totalSum;
    }
    return this._mean;
  }
  /**
   * Returns the variance of the damage distribution.
   * Cached for performance since this requires mean calculation plus iteration.
   */
  variance() {
    if (this._variance === void 0) {
      const meanValue = this.mean();
      let varianceSum = 0;
      for (const [damageValue, probabilityBin] of this.map) {
        const deviationFromMean = damageValue - meanValue;
        varianceSum += deviationFromMean * deviationFromMean * probabilityBin.p;
      }
      this._variance = varianceSum;
    }
    return this._variance;
  }
  /**
   * Returns the standard deviation of the damage distribution.
   */
  stdev() {
    if (this._stdev === void 0) {
      this._stdev = Math.sqrt(this.variance());
    }
    return this._stdev;
  }
  /** Deep-copies a Bin, cloning its count and (optional) attr maps. */
  static cloneBin(bin) {
    return {
      p: bin.p,
      count: { ...bin.count },
      attr: bin.attr ? { ...bin.attr } : void 0
    };
  }
  /** Returns a new Bin with p, count, and attr all multiplied by `factor`. */
  static scaleBin(bin, factor) {
    const count = {};
    for (const k in bin.count) {
      count[k] = bin.count[k] * factor;
    }
    let attr;
    if (bin.attr) {
      attr = {};
      for (const k in bin.attr) {
        attr[k] = bin.attr[k] * factor;
      }
    }
    return { p: bin.p * factor, count, attr };
  }
  static mergeInto(destinationMap, damageValue, binToAdd) {
    const existingBin = destinationMap.get(damageValue);
    if (!existingBin) {
      destinationMap.set(damageValue, _PMF.cloneBin(binToAdd));
      return;
    }
    existingBin.p += binToAdd.p;
    for (const labelKey in binToAdd.count) {
      existingBin.count[labelKey] = (existingBin.count[labelKey] || 0) + binToAdd.count[labelKey];
    }
    if (binToAdd.attr) {
      if (!existingBin.attr) {
        existingBin.attr = {};
      }
      for (const labelKey in binToAdd.attr) {
        existingBin.attr[labelKey] = (existingBin.attr[labelKey] || 0) + binToAdd.attr[labelKey];
      }
    }
  }
  // Convenience method
  add(other) {
    return this.addScaled(other, 1);
  }
  /**
   * Returns a new PMF with a scaled branch added to this one.
   * The branch PMF is scaled by the given probability before merging
   * This will be very useful for conditional effects and for being
   * able to model "I can probably have this opportunity attack 40% of rounds"
   * Example: `pmf.addScaled(critBranch, 0.05)` → PMF including 5% crit outcomes
   */
  addScaled(branch, probability) {
    if (probability === 0) return this;
    const resultMap = /* @__PURE__ */ new Map();
    for (const [dmg, bin] of this.map) {
      resultMap.set(dmg, _PMF.cloneBin(bin));
    }
    for (const [damageValue, probabilityBin] of branch.map) {
      _PMF.mergeInto(
        resultMap,
        damageValue,
        _PMF.scaleBin(probabilityBin, probability)
      );
    }
    return new _PMF(
      resultMap,
      this.epsilon,
      false,
      `${this.identifier}+scaled(${branch.identifier},${probability})`
    );
  }
  /**
   * Redistributes probability mass to model an effect that only occurs with
   * probability `frequency` — a conditional attack, an on-hit rider, or a
   * sub-one AoE target fraction.
   *
   * Every hit outcome (damage > 0) is scaled by `frequency` — probability mass,
   * per-label `count`, AND per-label `attr` — and the freed mass is moved into
   * the miss bin at damage 0, tagged with the canonical `missNone` outcome.
   * Total probability mass is preserved.
   *
   * Unlike a bare {@link scaleMass} or {@link mapDamage}, this keeps damage
   * attribution (`attr`) intact, so a frequency-scaled PMF still renders
   * correctly in the damage-attribution charts.
   *
   * `frequency >= 1` (or non-finite) returns this PMF unchanged; `frequency <= 0`
   * collapses all mass into the miss bin. The miss outcome is assumed to be
   * encoded at damage value 0.
   *
   * @param frequency Probability in [0, 1] that the effect occurs.
   */
  applyHitFrequency(frequency) {
    if (!Number.isFinite(frequency) || frequency >= 1) return this;
    const freq = Math.max(0, frequency);
    const pMiss = this.pAt(0);
    const pHit = 1 - pMiss;
    const newMissMass = pMiss + (1 - freq) * pHit;
    const newMap = /* @__PURE__ */ new Map();
    newMap.set(0, {
      p: newMissMass,
      count: { [MISS_NONE_OUTCOME]: newMissMass },
      attr: {}
    });
    for (const [damage, bin] of this.map) {
      if (damage <= 0) continue;
      newMap.set(damage, _PMF.scaleBin(bin, freq));
    }
    return new _PMF(
      newMap,
      this.epsilon,
      false,
      `freq(${this.identifier},${freq})`
    );
  }
  scaleMass(factor) {
    if (factor === 1) return this;
    const scaledMap = /* @__PURE__ */ new Map();
    for (const [damageValue, probabilityBin] of this.map) {
      scaledMap.set(damageValue, _PMF.scaleBin(probabilityBin, factor));
    }
    return new _PMF(
      scaledMap,
      this.epsilon,
      false,
      `scale(${this.identifier},${factor})`
    );
  }
  mapDamage(damageTransformFunction) {
    const transformedMap = /* @__PURE__ */ new Map();
    for (const [originalDamage, probabilityBin] of this.map) {
      const transformedDamage = damageTransformFunction(originalDamage);
      _PMF.mergeInto(
        transformedMap,
        transformedDamage,
        _PMF.cloneBin(probabilityBin)
      );
    }
    return new _PMF(
      transformedMap,
      this.epsilon,
      this.normalized,
      `map(${this.identifier})`
    );
  }
  scaleDamage(factor, rounding = "floor") {
    const roundFunction = rounding === "round" ? Math.round : rounding === "ceil" ? Math.ceil : Math.floor;
    return this.mapDamage((damageValue) => roundFunction(damageValue * factor));
  }
  getPMFCombineCacheKey(p1, p2, eps, raw) {
    const [id1, id2] = [p1.identifier, p2.identifier].sort();
    return `v4:${raw ? "RAW" : "N"}:${id1}+${id2}@${eps}|${p1.fingerprint()}|${p2.fingerprint()}`;
  }
  /**
   * A small content fingerprint (mass + bin count + face sum) so convolution
   * cache keys change if the underlying numbers do. Memoized because a PMF is
   * immutable once constructed — this avoids re-summing every key on each
   * convolve() call (including cache hits).
   */
  fingerprint() {
    if (this._fingerprint === void 0) {
      let faceSum = 0;
      for (const k of this.map.keys()) faceSum += k;
      this._fingerprint = `${this.mass().toFixed(12)}|${this.map.size}|${faceSum}`;
    }
    return this._fingerprint;
  }
  convolve(other, eps, raw = false) {
    const epsilon = eps ?? this.epsilon;
    const norm = (x) => raw ? x : Math.abs(x.mass() - 1) <= epsilon ? x : x.normalize();
    const A0 = norm(this);
    const B0 = norm(other);
    const [A, B] = A0.identifier <= B0.identifier ? [A0, B0] : [B0, A0];
    const cacheKey = this.getPMFCombineCacheKey(A, B, epsilon, raw);
    const cached = pmfCache?.get(cacheKey);
    if (cached) return cached;
    const combinedMap = /* @__PURE__ */ new Map();
    for (const [aVal, aBin] of A.map) {
      const ap = aBin.p;
      const aCount = aBin.count;
      const aAttr = aBin.attr;
      for (const [bVal, bBin] of B.map) {
        const bp = bBin.p;
        const dmg = aVal + bVal;
        let dest = combinedMap.get(dmg);
        if (dest === void 0) {
          dest = { p: 0, count: {} };
          combinedMap.set(dmg, dest);
        }
        dest.p += ap * bp;
        const dc = dest.count;
        for (const k in aCount) dc[k] = (dc[k] || 0) + aCount[k] * bp;
        for (const k in bBin.count)
          dc[k] = (dc[k] || 0) + bBin.count[k] * ap;
        if (aAttr || bBin.attr) {
          let da = dest.attr;
          if (da === void 0) {
            da = {};
            dest.attr = da;
          }
          if (aAttr)
            for (const k in aAttr) da[k] = (da[k] || 0) + aAttr[k] * bp;
          if (bBin.attr)
            for (const k in bBin.attr)
              da[k] = (da[k] || 0) + bBin.attr[k] * ap;
        }
      }
    }
    let result = new _PMF(
      combinedMap,
      epsilon,
      !raw,
      `${A.identifier}${raw ? "*" : "+"}${B.identifier}`
    );
    const mExp = (raw ? A.mass() : 1) * (raw ? B.mass() : 1);
    const mGot = result.mass();
    if (mExp !== 0 && mGot !== 0 && Math.abs(mGot - mExp) > epsilon) {
      result = result.scaleMass(mExp / mGot);
    }
    if (!raw && mGot !== 0 && Math.abs(result.mass() - 1) > epsilon)
      result = result.normalize();
    pmfCache?.set(cacheKey, result);
    return result;
  }
  // 3) Nice wrapper so you can call pmf.combineRaw(other)
  combineRaw(other, eps) {
    return this.convolve(other, eps, true);
  }
  // Reduce a list of PMFs by left-folding convolve() with the given eps
  static reduceConvolveLeft(pmfList, eps) {
    let result = pmfList[0];
    for (let i = 1; i < pmfList.length; i++) {
      result = result.convolve(pmfList[i], eps);
    }
    return result;
  }
  /**
   * Convolves multiple PMFs using linear convolution with automatic caching.
   * Uses a left-to-right accumulation approach for maximum cache reuse.
   * Each convolve() call automatically uses the convolution cache for performance.
   *
   * This linear approach provides better cache hits than pairwise because:
   * - Intermediate results are more predictable and stable
   * - Similar PMF lists share common prefixes (A+B, (A+B)+C, etc.)
   * - Order-independent cache keys work better with consistent build patterns
   */
  static convolveMany(pmfList, eps = EPS) {
    if (pmfList.length === 0) return _PMF.empty(eps);
    if (pmfList.length === 1) return pmfList[0];
    return _PMF.reduceConvolveLeft(pmfList, eps);
  }
  /**
   * Returns a plain, JSON-serializable representation of this PMF.
   *
   * Follows the standard `toJSON` contract, so `JSON.stringify(pmf)` produces
   * the expected output (no double-encoding). Use {@link PMF.fromJSON} to
   * reconstruct, or {@link PMF.toJSONString} if you need the string directly.
   */
  toJSON() {
    return {
      bins: [...this.map.entries()],
      normalized: this.normalized,
      identifier: this.identifier
    };
  }
  /** Serializes this PMF to a JSON string (equivalent to `JSON.stringify(pmf)`). */
  toJSONString() {
    return JSON.stringify(this);
  }
  static fromJSON(jsonData) {
    return new _PMF(
      new Map(jsonData.bins),
      EPS,
      !!jsonData.normalized,
      jsonData.identifier || "fromJSON"
    );
  }
  /**
   * Relative pruning with optional top-K floor.
   * Keeps bins with p >= epsRel * peak, always keeps min and max damage,
   * optionally guarantees at least `minBins` survivors by adding top-K.
   * Returns a new, non-normalized PMF.
   */
  prune(epsRel, minBins = 0) {
    const size = this.map.size;
    if (size === 0) return this;
    let peak = 0;
    let minDamage = Number.POSITIVE_INFINITY;
    let maxDamage = Number.NEGATIVE_INFINITY;
    for (const [dmg, bin] of this.map) {
      if (bin.p > peak) peak = bin.p;
      if (dmg < minDamage) minDamage = dmg;
      if (dmg > maxDamage) maxDamage = dmg;
    }
    if (peak === 0)
      return new _PMF(new Map(this.map), epsRel, false, this.identifier);
    const thresh = epsRel * peak;
    const entries = [...this.map.entries()];
    const survivorsByDmg = /* @__PURE__ */ new Map();
    const protect = (d2) => {
      const b = this.map.get(d2);
      if (b) survivorsByDmg.set(d2, b);
    };
    protect(minDamage);
    if (maxDamage !== minDamage) protect(maxDamage);
    for (const [dmg, bin] of entries) {
      if (bin.p >= thresh) survivorsByDmg.set(dmg, bin);
    }
    if (minBins > 0 && survivorsByDmg.size < minBins) {
      entries.sort((a, b) => b[1].p - a[1].p);
      for (const [dmg, bin] of entries) {
        if (!survivorsByDmg.has(dmg)) {
          survivorsByDmg.set(dmg, bin);
          if (survivorsByDmg.size >= minBins) break;
        }
      }
    }
    const prunedMap = /* @__PURE__ */ new Map();
    for (const [dmg, bin] of survivorsByDmg) {
      const newCount = {};
      for (const k in bin.count) {
        const v = bin.count[k];
        if (Math.abs(v) >= thresh) newCount[k] = v;
      }
      let newAttr;
      if (bin.attr) {
        for (const k in bin.attr) {
          const v = bin.attr[k];
          if (Math.abs(v) >= thresh) {
            if (!newAttr) newAttr = {};
            newAttr[k] = v;
          }
        }
      }
      prunedMap.set(dmg, { p: bin.p, count: newCount, attr: newAttr });
    }
    return new _PMF(prunedMap, epsRel, false, `prune(${this.identifier})`);
  }
  /** Probability mass at exactly x. */
  pAt(x) {
    return this.map.get(x)?.p ?? 0;
  }
  /**
   * P(any damage) — the mass on all non-zero outcomes, i.e. `1 - P(0)`.
   * Assumes a miss is encoded as the damage-0 bin (the convention used across
   * attack/save PMFs). The dual of {@link missProbability}.
   */
  hitProbability() {
    return 1 - this.pAt(0);
  }
  /** P(no damage) — the mass at damage 0. The dual of {@link hitProbability}. */
  missProbability() {
    return this.pAt(0);
  }
  /**
   * Coarsen the distribution into at most `maxBuckets` contiguous, equal-width
   * damage buckets, aggregating probability mass (and `count`/`attr`
   * provenance) into each bucket's start value. Returns this PMF unchanged when
   * its integer support already fits within `maxBuckets`.
   *
   * This is a lossy display/downsampling transform (bucket start replaces the
   * exact damage value) — use it for charting wide distributions, not for DPR
   * math.
   */
  rebin(maxBuckets) {
    if (!(maxBuckets > 0)) return this;
    const support = this.support();
    if (support.length === 0) return this;
    const min = support[0];
    const max = support[support.length - 1];
    const range = max - min;
    if (range + 1 <= maxBuckets) return this;
    const binSize = Math.ceil((range + 1) / maxBuckets);
    return this.mapDamage((d2) => min + Math.floor((d2 - min) / binSize) * binSize);
  }
  /** Dense integer support from min..max (inclusive).
   * Useful for showing empty bars in charts.
   */
  denseSupport() {
    const s = this.support();
    if (s.length === 0) return [];
    const lo = Math.min(...s), hi = Math.max(...s);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).sort(
      (a, b) => a - b
    );
  }
  /** CDF at x: P(X ≤ x). */
  cdfAt(x) {
    let acc = 0;
    for (const [val, bin] of this.map) if (val <= x) acc += bin.p;
    return acc;
  }
  /** Quantile / inverse CDF for p in [0,1]. Returns smallest x with CDF ≥ p. */
  quantile(p) {
    if (this.map.size === 0) return 0;
    const s = this.support().sort((a, b) => a - b);
    let acc = 0;
    for (const x of s) {
      acc += this.pAt(x);
      if (acc >= p) return x;
    }
    return s[s.length - 1];
  }
  /** Get outcome probability at specific damage value. */
  outcomeAt(damage, outcome) {
    return this.map.get(damage)?.count[outcome] ?? 0;
  }
  /** Get all outcome types present in this PMF. */
  outcomes() {
    const outcomeSet = /* @__PURE__ */ new Set();
    for (const [, bin] of this.map) {
      for (const outcome in bin.count) {
        if (bin.count[outcome] > 0) {
          outcomeSet.add(outcome);
        }
      }
    }
    return Array.from(outcomeSet).sort();
  }
  /** Get total probability of an outcome across all damage values. */
  outcomeProbability(outcome) {
    let total = 0;
    for (const [, bin] of this.map) {
      total += bin.count[outcome] ?? 0;
    }
    return total;
  }
  /** Get damage attribution for an outcome at specific damage value. */
  outcomeAttributionAt(damage, outcome) {
    return this.map.get(damage)?.attr?.[outcome] ?? 0;
  }
  /** Get all outcome data at specific damage value. */
  binAt(damage) {
    const bin = this.map.get(damage);
    if (!bin) return null;
    return {
      p: bin.p,
      count: { ...bin.count },
      attr: bin.attr ? { ...bin.attr } : void 0
    };
  }
  /** Check if outcome exists in this PMF. */
  hasOutcome(outcome) {
    for (const [, bin] of this.map) {
      if ((bin.count[outcome] ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }
  /**
   * Split each damage value's probability mass across outcome labels, returning
   * per-label maps of `damage value → probability mass attributable to that
   * label`. Summing over labels at a given value recovers that value's `p`.
   *
   * Damage-bearing bins are split by `attr` weight (the share of damage each
   * outcome contributed); the clean-miss bin at 0 is split by `count` weight
   * (there is no damage to attribute). Attribution is computed on demand via
   * {@link withAttribution} when absent, so builder-generated PMFs work too.
   *
   * This is the provenance core of the stacked damage-attribution chart — the
   * caller only maps these series into its rendering format (colors, binning,
   * axis labels).
   */
  attributionByValue() {
    const src = this.hasAttribution() ? this : this.withAttribution();
    const result = /* @__PURE__ */ new Map();
    const add = (label, damage, mass) => {
      if (!(mass > 0)) return;
      let series = result.get(label);
      if (!series) {
        series = /* @__PURE__ */ new Map();
        result.set(label, series);
      }
      series.set(damage, (series.get(damage) ?? 0) + mass);
    };
    for (const [damage, bin] of src.map) {
      const p = bin.p || 0;
      if (p <= 0) continue;
      const isMissBin = damage === 0;
      if (isMissBin) {
        let totalCount = 0;
        for (const k in bin.count) totalCount += bin.count[k] || 0;
        if (totalCount > 0) {
          const c = bin.count[MISS_NONE_OUTCOME] || 0;
          add(MISS_NONE_OUTCOME, damage, c / totalCount * p);
        }
        continue;
      }
      let totalAttr = 0;
      if (bin.attr) for (const k in bin.attr) totalAttr += bin.attr[k] || 0;
      if (bin.attr && totalAttr > 0) {
        for (const k in bin.attr) {
          if (k === MISS_NONE_OUTCOME) continue;
          add(k, damage, (bin.attr[k] || 0) / totalAttr * p);
        }
      }
    }
    return result;
  }
  tailProbGE(t) {
    let s = 0;
    for (const [x, bin] of this) {
      if (bin.p > 0 && x >= t) s += bin.p;
    }
    return s;
  }
  tailProbGT(t) {
    let s = 0;
    for (const [x, rec] of this) {
      if (x > t) s += rec.p;
    }
    return s;
  }
  /**
   * Returns a new PMF containing only bins where the specified outcome has non-zero probability.
   * This creates a marginal distribution for the given outcome type, with probabilities
   * scaled to represent the unconditional mass attributable to that outcome.
   */
  filterOutcome(outcome) {
    const filteredMap = /* @__PURE__ */ new Map();
    for (const [damageValue, bin] of this.map) {
      const outcomeCount = bin.count[outcome] ?? 0;
      const totalCount = Object.values(bin.count ?? {}).reduce(
        (a, b) => (a ?? 0) + (b ?? 0),
        0
      );
      if (outcomeCount > 0 && totalCount !== void 0 && totalCount > 0) {
        const proportion = outcomeCount / totalCount;
        const newP = bin.p * proportion;
        const newCount = { [outcome]: outcomeCount };
        let newAttr;
        if (bin.attr && bin.attr[outcome] !== void 0) {
          newAttr = { [outcome]: bin.attr[outcome] * proportion };
        }
        filteredMap.set(damageValue, {
          p: newP,
          count: newCount,
          attr: newAttr
        });
      }
    }
    return new _PMF(
      filteredMap,
      this.epsilon,
      false,
      // don't normalize by default
      `filter(${this.identifier},${outcome})`
    );
  }
  /**
   * Calculates probabilities for first-success outcomes across n independent attempts.
   *
   * @param pSuccess - Total probability of any success on a single attempt.
   * @param pSpecial - Probability of a specific subset of successes (e.g., critical success).
   * @param n - Number of independent attempts.
   *
   * Returns:
   *  - pSpecificSuccess: Probability that the first success was of the "special" type
   *  - pGeneralSuccess: Probability that the first success was of the non-special type
   *  - pNone: Probability that no successes occurred
   *  - pAny: Probability that at least one success occurred
   */
  static firstSuccessWeights(pSuccess, pSpecial, n) {
    if (!Number.isFinite(pSuccess) || !Number.isFinite(pSpecial) || pSuccess < 0 || pSuccess > 1 || pSpecial < 0 || pSpecial - pSuccess > EPS) {
      throw new Error(
        `firstSuccessWeights: require 0 <= pSpecial <= pSuccess <= 1 (got pSuccess=${pSuccess}, pSpecial=${pSpecial})`
      );
    }
    const pFail = 1 - pSuccess;
    const pFailAll = Math.pow(pFail, n);
    const pAny = 1 - pFailAll;
    const denom = pSuccess === 0 ? 1 : pSuccess;
    const pSpecificSuccess = pSpecial * pAny / denom;
    const pGeneralSuccess = (pSuccess - pSpecial) * pAny / denom;
    const pNone = 1 - pSpecificSuccess - pGeneralSuccess;
    return { pSpecificSuccess, pGeneralSuccess, pNone, pAny };
  }
  mapValues(f, eps = EPS, opts) {
    const rounding = opts?.rounding ?? "none";
    const preserveCounts = opts?.preserveCounts ?? true;
    const round = (x) => rounding === "floor" ? Math.floor(x) : rounding === "ceil" ? Math.ceil(x) : rounding === "round" ? Math.round(x) : x;
    const probs = /* @__PURE__ */ new Map();
    const counts = /* @__PURE__ */ new Map();
    for (const [v, bin] of this) {
      if (Math.abs(bin.p) < eps) continue;
      const u = round(f(v));
      probs.set(u, (probs.get(u) ?? 0) + bin.p);
      if (preserveCounts) {
        const src = bin.count;
        if (src) {
          const dest = counts.get(u) ?? {};
          for (const k in src) {
            dest[k] = (dest[k] ?? 0) + src[k];
          }
          counts.set(u, dest);
        }
      }
    }
    const internal = /* @__PURE__ */ new Map();
    for (const [u, p] of probs) {
      internal.set(u, { p, count: counts.get(u) ?? {} });
    }
    return _PMF.fromMap(
      new Map(Array.from(internal, ([u, b]) => [u, b.p])),
      eps
    );
  }
  static fromMap(m, eps = EPS, { requireIntegerValues = true } = {}) {
    const filtered = [];
    for (const [v, p] of m) {
      if (!Number.isFinite(v) || !Number.isFinite(p)) continue;
      if (p <= 0 || Math.abs(p) < eps) continue;
      if (requireIntegerValues && !Number.isInteger(v)) {
        throw new Error(`fromMap: non-integer outcome ${v}`);
      }
      filtered.push([v, p]);
    }
    if (filtered.length === 0) {
      throw new Error("fromMap: empty or invalid input map");
    }
    let sum = 0;
    let c = 0;
    for (const [, p] of filtered) {
      const y = p - c;
      const t = sum + y;
      c = t - sum - y;
      sum = t;
    }
    if (sum <= 0) throw new Error("pmfFromMap: probabilities sum to 0");
    filtered.sort((a, b) => a[0] - b[0]);
    const internal = /* @__PURE__ */ new Map();
    for (const [v, p] of filtered) {
      internal.set(v, { p: p / sum, count: {} });
    }
    return new _PMF(internal, eps);
  }
  query() {
    return new DiceQuery(this);
  }
};
// Unique ID generator for anonymous PMFs to avoid cache key collisions
_PMF.__anonIdCounter = 1;
var PMF = _PMF;

// src/pmf/mixture.ts
var Mixture = class _Mixture {
  constructor(eps = EPS) {
    this.totals = /* @__PURE__ */ new Map();
    // raw mass per outcome (pre-normalization)
    this.labelMass = /* @__PURE__ */ new Map();
    this.eps = Number.isFinite(eps) ? eps : EPS;
  }
  /** Remove all accumulated state. */
  clear() {
    this.totals.clear();
    this.labelMass.clear();
    return this;
  }
  /** Number of distinct outcome values currently accumulated. */
  size() {
    return this.totals.size;
  }
  /** Whether a label was ever added. */
  hasLabel(label) {
    for (const bag of this.labelMass.values()) if (bag[label]) return true;
    return false;
  }
  /**
   * Add a labeled component with a mixture weight.
   * Weight can be any positive finite number. Very small contributions are pruned by eps.
   */
  add(label, pmf, weight = 1) {
    if (!Number.isFinite(weight) || weight <= 0) return this;
    for (const [v, bin] of pmf) {
      const p = bin.p;
      if (p <= 0) continue;
      const add = weight * p;
      if (!Number.isFinite(add) || Math.abs(add) < this.eps) continue;
      this.totals.set(v, (this.totals.get(v) ?? 0) + add);
      const bag = this.labelMass.get(v) ?? {};
      bag[label] = (bag[label] ?? 0) + add;
      this.labelMass.set(v, bag);
    }
    return this;
  }
  buildPMF(eps = EPS) {
    let grand = 0;
    let c = 0;
    for (const m of this.totals.values()) {
      const y = m - c;
      const t = grand + y;
      c = t - grand - y;
      grand = t;
    }
    if (!(grand > 0)) throw new Error("Mixture: zero total mass");
    const internal = /* @__PURE__ */ new Map();
    for (const [v, m] of this.totals) {
      if (m <= 0 || Math.abs(m) < this.eps) continue;
      const count = this.labelMass.get(v) ?? {};
      internal.set(v, { p: m / grand, count });
    }
    return new PMF(internal, eps);
  }
  /**
   * Produce normalized *per-label* PMFs (labels independent).
   * These are unlabeled PMFs built from the raw mass of that label alone.
   */
  byOutcome() {
    const labels = /* @__PURE__ */ new Set();
    for (const bag of this.labelMass.values()) {
      for (const k of Object.keys(bag)) labels.add(k);
    }
    const out = {};
    for (const label of labels) {
      const m = /* @__PURE__ */ new Map();
      for (const [v, bag] of this.labelMass) {
        const w = bag[label];
        if (w && Math.abs(w) >= this.eps) m.set(v, w);
      }
      if (m.size > 0) out[label] = PMF.fromMap(m, this.eps);
    }
    return out;
  }
  /**
   * Mixture weights per label, normalized to sum to 1 over labels that appeared.
   * Uses raw mass before per-outcome normalization.
   */
  weights() {
    const res = {};
    for (const [, bag] of this.labelMass) {
      for (const [lab, w] of Object.entries(bag)) {
        if (!Number.isFinite(w) || w <= 0) continue;
        res[lab] = (res[lab] ?? 0) + w;
      }
    }
    let total = 0;
    let c = 0;
    for (const v of Object.values(res)) {
      const y = v - c;
      const t = total + y;
      c = t - total - y;
      total = t;
    }
    if (total > 0) {
      for (const k in res) res[k] = res[k] / total;
    }
    return res;
  }
  toJSON() {
    return {
      totals: Array.from(this.totals.entries()).sort((a, b) => a[0] - b[0]),
      labels: Array.from(this.labelMass.entries()).sort((a, b) => a[0] - b[0]),
      eps: this.eps
    };
  }
  static mix(items, eps = EPS) {
    const mix = new _Mixture(eps);
    for (const [lab, pmf, w] of items) mix.add(lab, pmf, w);
    return mix.buildPMF();
  }
};

// src/common/errors.ts
var DiceParseError = class _DiceParseError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "DiceParseError";
    this.expression = options?.expression;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, _DiceParseError.prototype);
  }
};

// src/parser/dice.ts
var MAX_BINARY_OUTCOMES = 1e8;
var Dice = class _Dice {
  constructor(x = 0) {
    this.faces = {};
    this.privateData = {};
    // Partial: the object starts empty and gains keys as outcomes are recorded,
    // so the type must not claim every OutcomeType is present. (Previously typed
    // as a full Record via an `as` cast, which lied about missing keys.)
    this.outcomeData = {};
    this.hasHitDistributionCalculated = false;
    if (x <= 0) return;
    for (let i = 1; i <= x; i++) {
      this.faces[i] = 1;
    }
  }
  getOutcomeDistribution(key) {
    if (key === "hit") {
      this.ensureHitDistribution();
    }
    const distribution = this.outcomeData[key];
    if (distribution === void 0) return void 0;
    return { ...distribution };
  }
  getFullOutcomeDistribution() {
    return { ...this.outcomeData };
  }
  setOutcomeDistribution(key, data) {
    if (data) {
      this.outcomeData[key] = data;
    } else {
      delete this.outcomeData[key];
    }
  }
  hasOutcomeData(key) {
    if (key === "hit") {
      this.ensureHitDistribution();
    }
    const data = this.outcomeData[key];
    return data !== void 0 && Object.keys(data).length > 0;
  }
  getOutcomeCount(key, face) {
    return this.outcomeData[key]?.[face] ?? 0;
  }
  getAverage(key) {
    const distribution = this.getOutcomeDistribution(key);
    if (!distribution) return 0;
    const totalCount = Object.values(distribution).reduce(
      (sum, count) => sum + count,
      0
    );
    const expectedDamage = Object.entries(distribution).reduce(
      (sum, [damage, count]) => sum + Number(damage) * count,
      0
    );
    if (totalCount === 0) return 0;
    return expectedDamage / totalCount;
  }
  // TODO this can be private later if we change how testing works
  calculateHitDistribution() {
    const hitValues = {};
    const subtractedOutcomes = [
      this.outcomeData.crit,
      this.outcomeData.missNone,
      this.outcomeData.missDamage,
      this.outcomeData.saveHalf,
      this.outcomeData.saveFail,
      this.outcomeData.pc
    ];
    for (const [face, totalCount] of Object.entries(this.faces)) {
      const numFace = Number(face);
      let hitCount = totalCount;
      for (const distribution of subtractedOutcomes) {
        const outcomeCount = distribution?.[numFace];
        if (outcomeCount) {
          hitCount -= outcomeCount;
        }
      }
      if (numFace === 0) {
        hitCount = 0;
      }
      if (hitCount < 0) {
        hitCount = 0;
      }
      hitValues[numFace] = hitCount;
    }
    return hitValues;
  }
  ensureHitDistribution() {
    if (!this.hasHitDistributionCalculated) {
      const hitValues = this.calculateHitDistribution();
      this.setOutcomeDistribution("hit", hitValues);
      this.hasHitDistributionCalculated = true;
    }
  }
  // PRIVATE FUNCTIONS
  binaryOp(other, op, diceConstructor) {
    const result = diceConstructor ? diceConstructor() : new _Dice();
    const isScalar = typeof other === "number";
    const keys1 = this.keys();
    const keys2 = isScalar ? [] : other.keys();
    if (!isScalar && keys1.length * keys2.length > MAX_BINARY_OUTCOMES) {
      throw new DiceParseError(
        `Dice operation over ${keys1.length}\xD7${keys2.length} face pairs exceeds the maximum of ${MAX_BINARY_OUTCOMES}`
      );
    }
    for (const key1 of keys1) {
      const value1 = this.faces[key1];
      if (isScalar) {
        const resultKey = op(key1, other);
        result.increment(resultKey, value1);
      } else {
        for (const key2 of keys2) {
          const value2 = other.faces[key2];
          const resultKey = op(key1, key2);
          result.increment(resultKey, value1 * value2);
        }
      }
    }
    return result;
  }
  removeFaces(facesToRemove) {
    const result = new _Dice();
    for (const [key, value] of Object.entries(this.faces)) {
      const numKey = Number(key);
      if (!facesToRemove.includes(numKey)) {
        result.faces[numKey] = value;
      }
    }
    result.privateData = { ...this.privateData };
    result.outcomeData = { ...this.outcomeData };
    return result;
  }
  // PUBLIC FUNCTIONS
  getFaceEntries() {
    return Object.entries(this.faces).map(([k, v]) => [Number(k), v]);
  }
  getFaceMap() {
    return { ...this.faces };
  }
  get(face) {
    return this.faces[face] ?? 0;
  }
  keys() {
    return Object.keys(this.faces).map(Number);
  }
  values() {
    return Object.values(this.faces);
  }
  total() {
    return Object.values(this.faces).reduce((sum, value) => sum + value, 0);
  }
  setFace(key, value) {
    this.faces[key] = value;
  }
  static scalar(value) {
    const result = new _Dice();
    result.increment(value, 1);
    return result;
  }
  maxFace() {
    const numericKeys = this.keys();
    if (numericKeys.length === 0) {
      throw new Error("No numeric faces found");
    }
    return Math.max(...numericKeys);
  }
  minFace() {
    const numericKeys = this.keys();
    if (numericKeys.length === 0) {
      throw new Error("No numeric faces found");
    }
    return Math.min(...numericKeys);
  }
  increment(face, count) {
    const current = this.faces[face] || 0;
    this.faces[face] = current + count;
  }
  normalize(scalar) {
    const result = new _Dice();
    for (const [face, count] of Object.entries(this.faces)) {
      result.faces[Number(face)] = count * scalar;
    }
    result.privateData = { ...this.privateData };
    result.outcomeData = { ...this.outcomeData };
    return result;
  }
  // OPERATIONS
  add(other) {
    return this.binaryOp(other, (a, b) => a + b);
  }
  subtract(other) {
    return this.binaryOp(other, (a, b) => a - b);
  }
  conditionalApply(other) {
    return this.binaryOp(other, (a, b) => (a === 0 ? 0 : 1) * b);
  }
  multiply(other) {
    return this.binaryOp(other, (a, b) => a * b);
  }
  addNonZero(other) {
    return this.binaryOp(other, (a, b) => a !== 0 ? a + b : a);
  }
  eq(other) {
    return this.binaryOp(other, (a, b) => a === b ? 1 : 0);
  }
  max(other) {
    return this.binaryOp(other, (a, b) => Math.max(a, b));
  }
  min(other) {
    return this.binaryOp(other, (a, b) => Math.min(a, b));
  }
  advantage() {
    return this.max(this);
  }
  ge(other) {
    return this.binaryOp(other, (a, b) => a >= b ? 0 : 1);
  }
  divide(other) {
    return this.binaryOp(other, (a, b) => a / b);
  }
  divideRoundUp(other) {
    return this.binaryOp(other, (a, b) => Math.ceil(a / b));
  }
  divideRoundDown(other) {
    return this.binaryOp(other, (a, b) => Math.floor(a / b));
  }
  and(other) {
    return this.binaryOp(other, (a, b) => a && b ? 1 : 0);
  }
  checkTarget(other, comparisonLogic) {
    const createResult = () => {
      const result = new _Dice();
      result.increment(0, 0);
      result.increment(1, 0);
      return result;
    };
    return this.binaryOp(other, comparisonLogic, createResult);
  }
  dc(other) {
    const dcCheck = (a, b) => a >= b ? 0 : 1;
    const result = this.checkTarget(other, dcCheck);
    result.privateData.isDCCheck = true;
    return result;
  }
  ac(other) {
    const acCheck = (a, b) => a >= b ? a : 0;
    return this.checkTarget(other, acCheck);
  }
  deleteFace(face) {
    const result = new _Dice();
    for (const [key, value] of Object.entries(this.faces)) {
      const numKey = Number(key);
      if (numKey !== face) {
        result.increment(numKey, value);
      }
    }
    result.privateData = { ...this.privateData };
    result.outcomeData = { ...this.outcomeData };
    return result;
  }
  reroll(toReroll) {
    const rerollDice = typeof toReroll === "number" ? _Dice.scalar(toReroll) : toReroll;
    const rerollKeys = rerollDice.keys();
    const rerollSet = new Set(rerollKeys);
    const removed = this.removeFaces(rerollKeys);
    let result = new _Dice();
    for (const face of this.keys()) {
      const wasRerolled = rerollSet.has(face);
      result = result.combine(removed);
      if (wasRerolled) {
        result = result.combine(this);
      }
    }
    return result;
  }
  // This is not addition and not rolling two dice at once.
  // Instead, it’s mixing two distributions into a single weighted die.
  combine(other) {
    if (typeof other === "number") {
      other = _Dice.scalar(other);
    }
    const result = new _Dice();
    for (const [key, value] of Object.entries(other.faces)) {
      result.faces[Number(key)] = value;
    }
    const except = new _Dice();
    for (const [key, value] of Object.entries(this.faces)) {
      const numKey = Number(key);
      result.increment(numKey, value);
      if (!(numKey in other.faces)) {
        except.increment(numKey, value);
      }
    }
    result.privateData = { ...this.privateData, except: other };
    result.outcomeData = { ...this.outcomeData };
    return result;
  }
  combineInPlace(other) {
    for (const [key, value] of Object.entries(other.faces)) {
      const numKey = Number(key);
      const current = this.faces[numKey] || 0;
      this.faces[numKey] = current + value;
    }
  }
  percent() {
    const total = this.total();
    const result = {};
    for (const [face, count] of Object.entries(this.faces)) {
      result[Number(face)] = count / total;
    }
    return result;
  }
  average() {
    const total = this.total();
    if (total === 0) return 0;
    let sum = 0;
    for (const [key, value] of Object.entries(this.faces)) {
      sum += Number(key) * value;
    }
    return sum / total;
  }
  /*
   * Convert dice to PMF using OutcomeType labels directly from damage distribution.
   * This is much cleaner than the original complex distribution conversion.
   */
  toPMF(numEpsilon = EPS) {
    const total = this.total();
    if (total === 0) return PMF.empty(numEpsilon);
    this.ensureHitDistribution();
    const map = /* @__PURE__ */ new Map();
    const hitDistro = this.getOutcomeDistribution("hit") || {};
    const critDistro = this.getOutcomeDistribution("crit") || {};
    const missDistro = this.getOutcomeDistribution("missDamage") || {};
    const saveDistro = this.getOutcomeDistribution("saveHalf") || {};
    const pcDistro = this.getOutcomeDistribution("pc") || {};
    const isSaveHalf = Object.keys(saveDistro).length > 0;
    const isDCCheck = this.privateData.isDCCheck === true;
    const clampNonNeg = (x) => x < 0 && x > -1e-15 ? 0 : x;
    for (const [faceStr, faceCountRaw] of Object.entries(this.faces)) {
      const face = Number(faceStr);
      const faceCount = Number(faceCountRaw);
      if (faceCount <= 0) continue;
      let p = faceCount / total;
      p = clampNonNeg(p);
      if (!(p > 0)) continue;
      if (numEpsilon >= 0 && p < numEpsilon) continue;
      const count = {};
      const attr = {};
      if (hitDistro[face]) {
        const c = clampNonNeg(hitDistro[face] / total);
        if (c > 0) {
          if (isSaveHalf || isDCCheck) {
            count.saveFail = c;
            attr.saveFail = clampNonNeg(face * hitDistro[face] / total);
          } else {
            count.hit = c;
            attr.hit = clampNonNeg(face * hitDistro[face] / total);
          }
        }
      }
      if (critDistro[face]) {
        const c = clampNonNeg(critDistro[face] / total);
        if (c > 0) {
          count.crit = c;
          attr.crit = clampNonNeg(face * critDistro[face] / total);
        }
      }
      if (missDistro[face]) {
        const c = clampNonNeg(missDistro[face] / total);
        if (c > 0) {
          count.missDamage = c;
          attr.missDamage = clampNonNeg(face * missDistro[face] / total);
        }
      }
      if (saveDistro[face]) {
        const c = clampNonNeg(saveDistro[face] / total);
        if (c > 0) {
          if (isSaveHalf) {
            count.saveHalf = c;
            attr.saveHalf = clampNonNeg(face * saveDistro[face] / total);
          } else {
            count.saveFail = (count.saveFail ?? 0) + c;
            attr.saveFail = clampNonNeg(
              (attr.saveFail ?? 0) + face * saveDistro[face] / total
            );
          }
        }
      }
      if (pcDistro[face]) {
        const c = clampNonNeg(pcDistro[face] / total);
        if (c > 0) {
          count.pc = c;
          attr.pc = clampNonNeg(face * pcDistro[face] / total);
        }
      }
      if (!isSaveHalf && !isDCCheck) {
        const distroCountRaw = (hitDistro[face] || 0) + (critDistro[face] || 0) + (missDistro[face] || 0) + (saveDistro[face] || 0) + (pcDistro[face] || 0);
        const unaccountedCount = clampNonNeg(faceCount - distroCountRaw);
        if (unaccountedCount > 0) {
          const frac = clampNonNeg(unaccountedCount / total);
          if (frac > 0) {
            count.missNone = (count.missNone ?? 0) + frac;
          }
        }
      }
      const bin = { p, count };
      if (Object.keys(attr).length > 0) {
        bin.attr = attr;
      }
      map.set(face, bin);
    }
    const identifier = this.identifier || "ERROR";
    return new PMF(map, numEpsilon, true, identifier).compact(numEpsilon, true);
  }
};

// src/parser/parser.ts
var MAX_DIE_SIDES = 1e6;
var MAX_DICE_COUNT = 1e4;
var MAX_KEEP_OUTCOMES = 1e6;
var parseCache = new LRUCache(1e3);
function parse(expression, n = 0) {
  const cleaned = expression.replace(/ /g, "").toLowerCase();
  {
    const cacheKey = `${cleaned}:${n}`;
    const cached = parseCache.get(cacheKey);
    if (cached) return cached;
  }
  const chars = [...cleaned];
  let result;
  try {
    result = parseExpression(chars, n);
  } catch (error) {
    throw new DiceParseError(
      `Cannot parse dice expression [${expression}]: ${error}`,
      { expression, cause: error }
    );
  }
  result.privateData = result.privateData || {};
  result.identifier = cleaned;
  if (chars.length > 0) {
    throw new DiceParseError(
      `Unexpected token: '${chars[0]}' from expression: '${expression}'`,
      { expression }
    );
  }
  const resultPMF = result.toPMF(-1);
  {
    const cacheKey = `${cleaned}:${n}`;
    parseCache.set(cacheKey, resultPMF);
  }
  return resultPMF;
}
function combineDiceWithNormalization(dice, normValue, outcomeType, currentNorm, finalResult) {
  dice = dice.normalize(currentNorm);
  finalResult = finalResult.normalize(normValue);
  finalResult.setOutcomeDistribution(outcomeType, dice.getFaceMap());
  finalResult = finalResult.combine(dice);
  return { newNorm: currentNorm * normValue, updatedResult: finalResult };
}
function parseExpression(arr, n) {
  const result = (() => {
    const res = parseArgument(arr, n);
    return typeof res === "number" ? Dice.scalar(res) : res;
  })();
  let op = parseOperation(arr);
  let finalResult = result;
  while (op != null) {
    const arg = !op.unary ? parseArgument(arr, n) : finalResult;
    let crit;
    let critNorm = 1;
    if (arr[0] === "x" || arr[0] === "c") {
      const isXcrit = arr[0] === "x";
      if (isXcrit) assertToken(arr, "x");
      assertToken(arr, "c");
      assertToken(arr, "r");
      assertToken(arr, "i");
      assertToken(arr, "t");
      const count = isXcrit ? parseNumber(arr, n) : 1;
      crit = new Dice();
      for (let i = 0; i < count; i++) {
        const max = finalResult.maxFace();
        crit.setFace(max, finalResult.get(max));
        finalResult = finalResult.deleteFace(max);
      }
      critNorm = crit.total();
      crit = op.call(crit, parseBinaryArgument(arg, arr, n));
      critNorm = crit && critNorm ? crit.total() / critNorm : 1;
    }
    let save;
    let saveNorm = 1;
    if (arr[0] === "s") {
      assertToken(arr, "s");
      assertToken(arr, "a");
      assertToken(arr, "v");
      assertToken(arr, "e");
      save = new Dice();
      const min = finalResult.minFace();
      save.increment(min > 0 ? min : 1, finalResult.get(min));
      saveNorm = save.total();
      finalResult = finalResult.deleteFace(min);
      save = op.call(save, parseBinaryArgument(arg, arr, n));
      saveNorm = save && saveNorm ? save.total() / saveNorm : 1;
    }
    let pc;
    let pcNorm = 1;
    if (arr.length >= 2 && arr[0] === "p" && arr[1] === "c") {
      assertToken(arr, "p");
      assertToken(arr, "c");
      pc = new Dice();
      const min = finalResult.minFace();
      pc.increment(min > 0 ? min : 1, finalResult.get(min));
      const missBefore = pc.total();
      finalResult = finalResult.deleteFace(min);
      pc = op.call(pc, parseBinaryArgument(arg, arr, n)).divideRoundDown(2);
      const missAfter = pc ? pc.total() : 0;
      pcNorm = missBefore ? missAfter / missBefore : 1;
    }
    let miss;
    let missNorm = 1;
    if (arr[0] === "m") {
      assertToken(arr, "m");
      assertToken(arr, "i");
      assertToken(arr, "s");
      assertToken(arr, "s");
      miss = new Dice();
      const min = finalResult.minFace();
      miss.increment(min > 0 ? min : 1, finalResult.get(min));
      missNorm = miss.total();
      finalResult = finalResult.deleteFace(min);
      miss = op.call(miss, parseBinaryArgument(arg, arr, n));
      missNorm = miss && missNorm ? miss.total() / missNorm : 1;
    }
    let norm = finalResult.total();
    finalResult = op.call(finalResult, arg);
    norm = norm ? finalResult.total() / norm : 1;
    if (crit) {
      const result2 = combineDiceWithNormalization(
        crit,
        critNorm,
        "crit",
        norm,
        finalResult
      );
      norm = result2.newNorm;
      finalResult = result2.updatedResult;
    }
    if (save) {
      const result2 = combineDiceWithNormalization(
        save,
        saveNorm,
        "saveHalf",
        norm,
        finalResult
      );
      norm = result2.newNorm;
      finalResult = result2.updatedResult;
    }
    if (miss) {
      const result2 = combineDiceWithNormalization(
        miss,
        missNorm,
        "missDamage",
        norm,
        finalResult
      );
      norm = result2.newNorm;
      finalResult = result2.updatedResult;
    }
    if (pc) {
      const result2 = combineDiceWithNormalization(
        pc,
        pcNorm,
        "pc",
        norm,
        finalResult
      );
      norm = result2.newNorm;
      finalResult = result2.updatedResult;
    }
    op = parseOperation(arr);
  }
  return finalResult;
}
function parseArgument(s, n) {
  let result = parseArgumentInternal(s, n);
  while (true) {
    const next = parseArgumentInternal(s, n);
    if (next === void 0) break;
    result = multiplyDiceByDice(result, next);
  }
  return result;
}
function multiplyDiceByDice(d1, d2) {
  if (typeof d1 === "number") d1 = Dice.scalar(d1);
  if (typeof d2 === "number") d2 = Dice.scalar(d2);
  const result = new Dice();
  const faces = /* @__PURE__ */ new Map();
  let normalizationFactor = 1;
  for (const key of d1.keys()) {
    let face;
    if (typeof key !== "number") {
      continue;
    }
    if (d2.privateData.keep) {
      const faceCount = d2.keys().length;
      if (Math.pow(faceCount, key) > MAX_KEEP_OUTCOMES) {
        throw new DiceParseError(
          `Keep enumeration of ${faceCount}^${key} outcomes exceeds the maximum of ${MAX_KEEP_OUTCOMES}`
        );
      }
      const repeat = Array(key).fill(d2);
      face = opDice(repeat, d2.privateData.keep);
    } else {
      face = multiplyDice(key, d2);
    }
    normalizationFactor *= face.total();
    faces.set(key, face);
  }
  for (const [k, face] of faces) {
    const count = d1.get(k);
    result.combineInPlace(
      face.normalize(count * normalizationFactor / face.total())
    );
  }
  result.privateData.except = {};
  return result;
}
function multiplyDice(n, d2) {
  if (n > MAX_DICE_COUNT) {
    throw new DiceParseError(
      `Dice count ${n} exceeds the maximum of ${MAX_DICE_COUNT}`
    );
  }
  if (n === 0) return new Dice(0);
  if (n === 1) return d2;
  const half = Math.floor(n / 2);
  let result = multiplyDice(half, d2);
  result = result.add(result);
  if (n % 2 === 1) {
    result = result.add(d2);
  }
  return result;
}
function opDice(diceList, keepFn) {
  return opDiceInternal(diceList, new Dice(), 0, [], 1, keepFn);
}
function opDiceInternal(diceList, result, index, values, weight, combineFn) {
  if (index === diceList.length) {
    return result.combine(Dice.scalar(combineFn(values)).normalize(weight));
  }
  const currentDice = diceList[index];
  for (const face of currentDice.keys()) {
    values.push(face);
    result = opDiceInternal(
      diceList,
      result,
      index + 1,
      values,
      weight * currentDice.get(face),
      combineFn
    );
    values.pop();
  }
  return result;
}
function parseArgumentInternal(s, n) {
  if (s.length === 0) return;
  const c = s[0];
  switch (c) {
    case "(":
      s.shift();
      return assertToken(s, ")", parseExpression(s, n));
    case "h":
    case "d":
      return parseDice(s, n);
    case "k":
      assertToken(s, "k");
      return parseKeep(s, n);
    case "n":
      return parseNumber(s, n);
    default:
      if (isDigit(c)) return parseNumber(s, n);
      return;
  }
}
function parseBinaryArgument(arg, arr, n) {
  if (arr.length >= 4 && arr[0] === "h" && peek(arr, "half")) {
    assertToken(arr, "half");
    const diceArg = typeof arg === "number" ? Dice.scalar(arg) : arg;
    return diceArg.divideRoundDown(2);
  }
  const parsed = parseArgument(arr, n);
  return typeof parsed === "number" ? Dice.scalar(parsed) : parsed;
}
function assertToken(s, expected, ret) {
  for (const ch of expected) {
    const found = s.shift();
    if (found !== ch) {
      throw new Error(`Expected character '${ch}', found '${found}'`);
    }
  }
  return ret;
}
function parseDice(s, n) {
  let rerollOne = false;
  if (peek(s, "hd") && peekIsNumber(s, 2)) {
    assertToken(s, "h");
    assertToken(s, "d");
    rerollOne = true;
  } else if (peek(s, "d") && peekIsNumber(s, 1)) {
    assertToken(s, "d");
  } else {
    return;
  }
  const sides = parseNumber(s, n);
  if (sides > MAX_DIE_SIDES) {
    throw new DiceParseError(
      `Die size ${sides} exceeds the maximum of ${MAX_DIE_SIDES}`
    );
  }
  let result = new Dice(sides);
  if (rerollOne) {
    result = result.reroll(1);
  }
  return result;
}
function peek(arr, expected) {
  if (expected.length > arr.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (arr[i] !== expected.charAt(i)) return false;
  }
  return true;
}
function peekIsNumber(arr, index) {
  if (index >= arr.length) return false;
  return isDigit(arr[index]) || arr[index] === "n";
}
function parseNumber(s, n) {
  let ret = "";
  while (s.length > 0 && (isDigit(s[0]) || s[0] === "n")) {
    const ch = s.shift();
    ret += ch === "n" ? n.toString() : ch;
  }
  if (ret.length === 0) {
    throw new Error(`Expected number, found: '${s[0]}'`);
  }
  return parseInt(ret, 10);
}
function isDigit(c) {
  return c >= "0" && c <= "9";
}
function parseKeep(s, n) {
  let keepLowest = false;
  if (peek(s, "l")) {
    assertToken(s, "l");
    keepLowest = true;
  } else if (peek(s, "h")) {
    assertToken(s, "h");
    keepLowest = false;
  } else {
    return;
  }
  const keepCount = parseNumber(s, n);
  const result = parseArgumentInternal(s, n);
  if (result instanceof Dice) {
    result.privateData.keep = keepN(keepCount, keepLowest);
    return result;
  }
  throw new Error("Expected Dice after keep modifier");
}
function keepN(n, low) {
  return (values) => {
    const sorted = [...values].sort((a, b) => low ? a - b : b - a);
    return sorted.slice(0, n).reduce((sum, val) => sum + val, 0);
  };
}
function parseOperation(s) {
  switch (s[0]) {
    case ")":
      return;
    case "a":
      assertToken(s, "ac");
      return Dice.prototype.ac;
    case "d":
      assertToken(s, "dc");
      return Dice.prototype.dc;
    case "!":
      assertToken(s, "!");
      const adv = Dice.prototype.advantage;
      adv.unary = true;
      return adv;
    case ">":
      assertToken(s, ">");
      return Dice.prototype.max;
    case "<":
      assertToken(s, "<");
      return Dice.prototype.min;
    case "+":
      assertToken(s, "+");
      return Dice.prototype.addNonZero;
    case "~":
      assertToken(s, "~");
      assertToken(s, "+");
      return Dice.prototype.add;
    case "-":
      assertToken(s, "-");
      return Dice.prototype.subtract;
    case "&":
      assertToken(s, "&");
      return Dice.prototype.combine;
    case "r":
      assertToken(s, "reroll");
      return Dice.prototype.reroll;
    case "*":
      assertToken(s, "*");
      if (peek(s, "*")) {
        assertToken(s, "*");
        return Dice.prototype.multiply;
      }
      return Dice.prototype.conditionalApply;
    case "/":
      assertToken(s, "/");
      if (s[0] === "/") {
        assertToken(s, "/");
        return Dice.prototype.divideRoundDown;
      }
      return Dice.prototype.divideRoundUp;
    case "=":
      assertToken(s, "=");
      return Dice.prototype.eq;
  }
  return;
}

// src/builder/prob.ts
function d20PmfFromCdf(cdfPow, eps = EPS) {
  const out = /* @__PURE__ */ new Map();
  let prev = 0;
  for (let k = 1; k <= 20; k++) {
    const cur = cdfPow(k);
    const pk = cur - prev;
    if (pk > 0) {
      out.set(k, pk);
    }
    prev = cur;
  }
  return PMF.fromMap(out, eps);
}

// src/builder/d20.ts
var cacheKeyMap = {
  "flat-flat": "d20",
  "flat-reroll": "hd20",
  "advantage-flat": "d20 > d20",
  "advantage-reroll": "hd20 > hd20",
  "disadvantage-flat": "d20 < d20",
  "disadvantage-reroll": "hd20 < hd20",
  "elven accuracy-flat": "d20 > d20 > d20",
  "elven accuracy-reroll": "hd20 > hd20 > hd20"
};
function d20RollPMF(rollType, rerollOne = false) {
  rollType = rollType || "flat";
  const cacheKeyLookup = `${rollType}-${rerollOne ? "reroll" : "flat"}`;
  const cacheKey = cacheKeyMap[cacheKeyLookup];
  if (!cacheKey) {
    throw new Error(`Invalid roll type: ${rollType}`);
  }
  const cached = pmfCache.get(cacheKey);
  if (cached) return cached;
  const base = d20PMF(rerollOne);
  if (!rollType || rollType === "flat") {
    pmfCache.set(cacheKey, base);
    return base;
  }
  const p = new Array(21).fill(0);
  for (const [r, rec] of base) {
    const pr = typeof rec === "number" ? rec : rec.p;
    if (r >= 1 && r <= 20) p[r] = pr;
  }
  const F = new Array(21).fill(0);
  for (let k = 1; k <= 20; k++) F[k] = F[k - 1] + p[k];
  const eps = 0;
  let result = base;
  if (rollType === "advantage") {
    result = d20PmfFromCdf((k) => Math.pow(F[k], 2), eps);
  } else if (rollType === "elven accuracy") {
    result = d20PmfFromCdf((k) => Math.pow(F[k], 3), eps);
  } else if (rollType === "disadvantage") {
    result = d20PmfFromCdf((k) => 1 - Math.pow(1 - F[k], 2), eps);
  }
  pmfCache.set(cacheKey, result);
  return result;
}
function d20PMF(rerollOne) {
  const cacheKey = `flat-${rerollOne ? "reroll" : "flat"}`;
  const cached = pmfCache.get(cacheKey);
  if (cached) return cached;
  const m = /* @__PURE__ */ new Map();
  const base = 1 / 20;
  const rerollShare = base * base;
  if (!rerollOne) {
    for (let r = 1; r <= 20; r++) {
      m.set(r, base);
    }
  } else {
    for (let r = 1; r <= 20; r++) {
      m.set(r, (r === 1 ? 0 : base) + rerollShare);
    }
  }
  const result = PMF.fromMap(m, EPS);
  pmfCache.set(cacheKey, result);
  return result;
}

// src/builder/roll.ts
var defaultConfig = {
  count: 1,
  sides: 0,
  modifier: 0,
  reroll: 0,
  explode: 0,
  minimum: 0,
  bestOf: 0,
  keep: void 0,
  rollType: "flat"
};
var rollConfigsEqual = (a, b) => {
  return a.count === b.count && a.sides === b.sides && a.modifier === b.modifier && a.reroll === b.reroll && a.explode === b.explode && a.minimum === b.minimum && a.bestOf === b.bestOf && a.keep === b.keep && a.rollType === b.rollType;
};
var configComplexityScore = (config) => {
  return (config.reroll > 0 ? 1 : 0) + (config.explode > 0 ? 1 : 0) + (config.minimum > 0 ? 1 : 0) + (config.bestOf > 0 ? 1 : 0) + (config.keep !== void 0 ? 1 : 0) + (config.rollType !== "flat" ? 1 : 0);
};
var RollBuilder = class _RollBuilder {
  constructor(countOrConfigs = 1) {
    // --- Dice Shortcut Methods ---
    this.d4 = () => this.d(4);
    this.d6 = () => this.d(6);
    this.d8 = () => this.d(8);
    this.d10 = () => this.d(10);
    this.d12 = () => this.d(12);
    this.d20 = () => this.d(20);
    this.d100 = () => this.d(100);
    if (typeof countOrConfigs === "number") {
      const count = countOrConfigs;
      if (isNaN(count)) throw new Error("Invalid NaN value for count");
      this.subRollConfigs = [
        { ...defaultConfig, count, isSubtraction: count < 0 }
      ];
    } else {
      this.subRollConfigs = countOrConfigs.map((c) => ({ ...c }));
    }
  }
  create(configs) {
    return new _RollBuilder(configs);
  }
  get lastConfig() {
    return this.subRollConfigs[this.subRollConfigs.length - 1];
  }
  hasHiddenState() {
    return false;
  }
  getSubRollConfigs() {
    return this.subRollConfigs.map((c) => ({ ...c }));
  }
  // for testing
  static fromConfig(config) {
    return new _RollBuilder([{ ...defaultConfig, ...config }]);
  }
  static fromConfigs(configs) {
    return new _RollBuilder(
      configs.map((config) => ({ ...defaultConfig, ...config }))
    );
  }
  static fromArgs(...args) {
    if (args.length === 1) {
      const arg = args[0];
      if (typeof arg === "number") {
        if (isNaN(arg)) throw new Error("Invalid NaN value for argument");
        return new _RollBuilder(0).plus(arg);
      }
      if (typeof arg === "string") {
        return new ParsedRollBuilder(arg);
      }
      if (arg instanceof _RollBuilder) {
        return arg;
      }
    }
    if (args.length === 2 || args.length === 3) {
      const [count, sidesOrDie, modifier] = args;
      if (typeof count !== "number") {
        throw new Error("First argument must be a number for multi-arg call");
      }
      if (isNaN(count)) throw new Error("Invalid NaN value for count argument");
      if (sidesOrDie instanceof _RollBuilder) {
        if (sidesOrDie.hasHiddenState()) {
          throw new Error(
            "Cannot use a roll with hidden state (like a pooled roll) as a die type."
          );
        }
        const subRollConfigs = sidesOrDie.getSubRollConfigs();
        if (subRollConfigs.length === 0) {
          const result = new _RollBuilder(0);
          return modifier !== void 0 ? result.plus(modifier) : result;
        }
        const absCount = Math.abs(count);
        const newConfigs = subRollConfigs.map((config) => ({
          ...config,
          count: config.count * absCount,
          modifier: config.modifier * absCount
        }));
        let resultBuilder = new _RollBuilder(newConfigs);
        if (count < 0) {
          const negatedConfigs = resultBuilder.getSubRollConfigs().map((c) => ({ ...c, isSubtraction: !c.isSubtraction }));
          resultBuilder = new _RollBuilder(negatedConfigs);
        }
        return modifier !== void 0 ? resultBuilder.plus(modifier) : resultBuilder;
      } else if (typeof sidesOrDie === "number" || sidesOrDie === void 0) {
        if (typeof sidesOrDie === "number" && isNaN(sidesOrDie))
          throw new Error("Invalid NaN value for sides argument");
        let builder = new _RollBuilder(count);
        if (sidesOrDie && sidesOrDie > 0) {
          builder = builder.d(sidesOrDie);
        }
        return modifier !== void 0 ? builder.plus(modifier) : builder;
      }
    }
    throw new Error(`Invalid arguments passed: ${args.join(", ")}`);
  }
  // --- Core Dice Methods ---
  d(sides) {
    if (sides !== void 0 && isNaN(sides))
      throw new Error("Invalid NaN value for sides");
    if (sides === void 0) return this;
    if (this.lastConfig.sides && this.lastConfig.sides > 0) {
      throw new Error("Cannot add a die after adding a die");
    }
    if (sides === 0) return this;
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].sides = sides;
    return this.create(newConfigs);
  }
  plus(modOrRoll, die) {
    if (typeof modOrRoll === "number" && isNaN(modOrRoll))
      throw new Error("Invalid NaN value for modOrRoll");
    if (die instanceof _RollBuilder && typeof modOrRoll === "number") {
      if (die.hasHiddenState()) {
        throw new Error(
          "Cannot use a roll with hidden state (like a pooled roll) as a die type."
        );
      }
      const count = modOrRoll;
      const subRollConfigs = die.getSubRollConfigs();
      if (subRollConfigs.length === 0) return this;
      const absCount = Math.abs(count);
      const newConfigs = subRollConfigs.map((config) => ({
        ...config,
        count: config.count * absCount,
        modifier: config.modifier * absCount
      }));
      let rollToAdd = new _RollBuilder(newConfigs);
      if (count < 0) {
        const negatedConfigs = rollToAdd.getSubRollConfigs().map((c) => ({ ...c, isSubtraction: !c.isSubtraction }));
        rollToAdd = new _RollBuilder(negatedConfigs);
      }
      return this.add(rollToAdd);
    }
    if (die !== void 0) {
      throw new Error("Invalid arguments to plus()");
    }
    if (modOrRoll === void 0) return this;
    if (typeof modOrRoll === "number") {
      if (modOrRoll === 0) return this;
      const newConfigs = this.getSubRollConfigs();
      newConfigs[newConfigs.length - 1].modifier += modOrRoll;
      return this.create(newConfigs);
    }
    return this.add(modOrRoll);
  }
  minus(modOrRoll, die) {
    const isNumber = typeof modOrRoll === "number";
    const dieIsRoll = die instanceof _RollBuilder;
    if (dieIsRoll && isNumber) return this.plus(-modOrRoll, die);
    if (die !== void 0) throw new Error("Invalid arguments to minus()");
    if (modOrRoll === void 0) return this;
    return isNumber ? this.plus(-modOrRoll) : this.plus(-1, modOrRoll);
  }
  /** Apply one-pass reroll threshold (k): reroll faces 1..k once, must keep. */
  reroll(value) {
    if (isNaN(value)) throw new Error("Invalid NaN value for reroll");
    if (value === this.lastConfig.reroll) return this;
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].reroll = value;
    return this.create(newConfigs);
  }
  /** Set finite explode count for max-face explosions (Infinity allowed). */
  explode(count = Infinity) {
    if (count !== void 0 && isNaN(count))
      throw new Error("Invalid NaN value for explode count");
    if (count === void 0) return this;
    if (count === 0) return this;
    if (count < 0) throw new Error("Explode count must be >= 0");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].explode = count;
    return this.create(newConfigs);
  }
  /** Apply per-die minimum value (min > 0). */
  minimum(val) {
    if (val !== void 0 && isNaN(val))
      throw new Error("Invalid NaN value for minimum");
    if (val === void 0) return this;
    if (val === 0) return this;
    if (val < 0) throw new Error("Minimum value must be >= 0");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].minimum = val + 1;
    return this.create(newConfigs);
  }
  bestOf(count) {
    if (count !== void 0 && isNaN(count))
      throw new Error("Invalid NaN value for bestOf count");
    if (count === void 0) return this;
    if (count <= 0) throw new Error("Best of count must be > 0");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].bestOf = count;
    return this.create(newConfigs);
  }
  keepHighest(total, count) {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighest");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].keep = { total, count, mode: "highest" };
    return this.create(newConfigs);
  }
  keepLowest(total, count) {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepLowest");
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].keep = { total, count, mode: "lowest" };
    return this.create(newConfigs);
  }
  keepHighestAll(total, count) {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepHighestAll");
    const currentAST = this.toAST();
    const trialPool = {
      type: "sum",
      count: total,
      child: currentAST
    };
    const keepNode = {
      type: "keep",
      mode: "highest",
      count,
      child: trialPool
    };
    const currentExpr = this.toExpression();
    const expression = `${total}kh${count}(${currentExpr})`;
    return new PooledRollBuilder(keepNode, expression);
  }
  keepLowestAll(total, count) {
    if (isNaN(total) || isNaN(count))
      throw new Error("Invalid NaN value for keepLowestAll");
    const currentAST = this.toAST();
    const trialPool = {
      type: "sum",
      count: total,
      child: currentAST
    };
    const keepNode = {
      type: "keep",
      mode: "lowest",
      count,
      child: trialPool
    };
    const currentExpr = this.toExpression();
    const expression = `${total}kl${count}(${currentExpr})`;
    return new PooledRollBuilder(keepNode, expression);
  }
  withAdvantage() {
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].rollType = "advantage";
    return this.create(newConfigs);
  }
  withDisadvantage() {
    const configs = this.getSubRollConfigs();
    configs[configs.length - 1].rollType = "disadvantage";
    return this.create(configs);
  }
  add(anotherRoll) {
    if (anotherRoll === void 0) return this;
    if (anotherRoll.hasHiddenState()) {
      throw new Error(
        "Cannot add a roll with hidden state (like a pooled roll) to a standard roll. Try adding the standard roll to the pooled roll instead: pool.plus(roll)."
      );
    }
    const configs = [...this.subRollConfigs, ...anotherRoll.subRollConfigs];
    return this.create(configs);
  }
  withBonus(anotherRoll) {
    const configs = [...this.subRollConfigs, ...anotherRoll.subRollConfigs];
    return this.create(configs);
  }
  addRoll(count = 1) {
    if (isNaN(count)) throw new Error("Invalid NaN value for count");
    const configs = [
      ...this.subRollConfigs,
      {
        ...defaultConfig,
        count,
        isSubtraction: count < 0
      }
    ];
    return this.create(configs);
  }
  scaleDice(scale) {
    const scaleInt = Math.floor(scale);
    if (scaleInt !== scale) throw new Error("Scale must be an integer");
    if (scaleInt <= 0) throw new Error("Scale must be > 0");
    const newConfigs = this.getSubRollConfigs().map((config) => {
      if (!config.sides || config.sides <= 0) return config;
      return { ...config, count: config.count * scaleInt };
    });
    return this.create(newConfigs);
  }
  doubleDice() {
    return this.scaleDice(2);
  }
  alwaysHits() {
    return new AlwaysHitBuilder(this);
  }
  alwaysCrits() {
    return new AlwaysCritBuilder(this);
  }
  copy() {
    return this.create(this.getSubRollConfigs());
  }
  withElvenAccuracy() {
    const newConfigs = this.getSubRollConfigs();
    newConfigs[newConfigs.length - 1].rollType = "elven accuracy";
    return this.create(newConfigs);
  }
  toExpression() {
    const originalDiceConfigs = this.subRollConfigs.filter(
      (config) => config.sides && config.sides > 0
    );
    const configGroups = /* @__PURE__ */ new Map();
    for (const config of originalDiceConfigs) {
      const keyConfig = { ...config };
      delete keyConfig.count;
      delete keyConfig.modifier;
      const key = JSON.stringify(keyConfig);
      const existingGroup = configGroups.get(key);
      if (existingGroup) {
        existingGroup.totalCount += config.count;
      } else {
        configGroups.set(key, { config, totalCount: config.count });
      }
    }
    const rootConfig = this.getRootDieConfig();
    const groupedConfigs = Array.from(configGroups.values());
    let rootD20Group;
    if (rootConfig && rootConfig.sides === 20) {
      const rootIndex = groupedConfigs.findIndex(
        ({ config }) => rollConfigsEqual(config, rootConfig) && JSON.stringify(config.keep) === JSON.stringify(rootConfig.keep)
      );
      if (rootIndex !== -1) {
        rootD20Group = groupedConfigs.splice(rootIndex, 1)[0];
      }
    }
    const sortedDiceConfigs = groupedConfigs.map(({ config, totalCount }) => ({
      ...config,
      count: totalCount
    })).sort((a, b) => {
      const aHasPriority = a.reroll > 0 || a.minimum > 0;
      const bHasPriority = b.reroll > 0 || b.minimum > 0;
      if (aHasPriority !== bHasPriority) return aHasPriority ? -1 : 1;
      if (b.sides !== a.sides) return b.sides - a.sides;
      return configComplexityScore(b) - configComplexityScore(a);
    });
    const diceConfigs = rootD20Group ? [
      { ...rootD20Group.config, count: rootD20Group.totalCount },
      ...sortedDiceConfigs
    ] : sortedDiceConfigs;
    const totalModifier = this.subRollConfigs.reduce(
      (sum, config) => sum + config.modifier,
      0
    );
    if (diceConfigs.length === 0) return totalModifier.toString();
    const rootDieConfig = this.getRootDieConfig();
    const newRootConfig = rootDieConfig ? diceConfigs.find((c) => rollConfigsEqual(c, rootDieConfig)) : void 0;
    const diceExpressions = diceConfigs.map(
      (config) => this.configToSingleExpressionWithoutModifier(
        config,
        config === newRootConfig
      )
    );
    let result = "";
    for (let i = 0; i < diceExpressions.length; i++) {
      const config = diceConfigs[i];
      const expression = diceExpressions[i];
      if (i === 0) {
        result = (config.isSubtraction ? "-" : "") + expression;
        if (config.sides === 20 && totalModifier !== 0) {
          if (totalModifier > 0) result += ` + ${totalModifier}`;
          else result += ` - ${Math.abs(totalModifier)}`;
        }
      } else {
        const operator = config.isSubtraction ? " - " : " + ";
        result += operator + expression;
      }
    }
    if (diceConfigs.length === 0 || diceConfigs[0].sides !== 20) {
      if (totalModifier > 0) result += ` + ${totalModifier}`;
      else if (totalModifier < 0) result += ` - ${Math.abs(totalModifier)}`;
    }
    return result.replace(/\+ -/g, "-");
  }
  toPMF(eps = 0) {
    return pmfFromRollBuilder(this, eps);
  }
  get pmf() {
    return this.toPMF();
  }
  toQuery(eps = 0) {
    return this.toPMF(eps).query();
  }
  toAST() {
    const configs = this.getSubRollConfigs();
    return astFromRollConfigs(configs) || { type: "constant", value: 0 };
  }
  configToSingleExpressionWithoutModifier(config, isRootDie) {
    if (!config.sides || config.sides <= 0) return "";
    let baseDie = `d${config.sides}`;
    if (config.reroll > 0) {
      if (config.minimum > 0 && config.explode > 0) ; else if (config.minimum > 0) {
        for (let i = config.reroll; i >= 1; i--) baseDie += ` reroll ${i}`;
      } else {
        for (let i = 1; i <= config.reroll; i++) baseDie += ` reroll ${i}`;
      }
    }
    if (config.minimum > 0) {
      if (config.reroll > 0 && !config.explode) {
        baseDie = `${config.minimum}>(${baseDie})`;
      } else {
        baseDie = `${config.minimum}>${baseDie}`;
      }
      if (config.reroll > 0 && config.explode > 0) {
        for (let i = 1; i <= config.reroll; i++) {
          baseDie += ` reroll ${i}`;
        }
      }
    }
    if (baseDie === "d20 reroll 1" && config.minimum <= 1) baseDie = "hd20";
    let mainExpression = "";
    switch (config.rollType) {
      case "advantage":
        mainExpression = `${baseDie} > ${baseDie}`;
        break;
      case "disadvantage":
        mainExpression = `${baseDie} < ${baseDie}`;
        break;
      case "elven accuracy":
        mainExpression = `${baseDie} > ${baseDie} > ${baseDie}`;
        break;
      case "flat":
        if (config.keep) {
          const mode = config.keep.mode === "highest" ? "kh" : "kl";
          const baseDieExpression = this.configToSingleExpressionWithoutModifier(
            {
              ...config,
              count: config.count,
              modifier: 0,
              rollType: "flat",
              keep: void 0
            },
            false
          );
          mainExpression = `${config.keep.total}${mode}${config.keep.count}(${baseDieExpression})`;
        } else {
          const isComplex = baseDie.length > `d${config.sides}`.length;
          const isHalflingShorthand = baseDie === "hd20";
          const isD20Shorthand = baseDie === "d20" && isRootDie;
          const hasMinimum = config.minimum > 0;
          const hasReroll = config.reroll > 0;
          const effectiveCount = config.isSubtraction ? Math.abs(config.count) : config.count < 0 ? 1 : Math.abs(config.count);
          if (effectiveCount > 1) {
            const shouldAddParentheses = isComplex;
            mainExpression = shouldAddParentheses ? `${effectiveCount}(${baseDie})` : `${effectiveCount}${baseDie}`;
          } else if (effectiveCount === 1) {
            const needsParens = hasReroll && hasMinimum;
            if (config.isSubtraction) {
              mainExpression = needsParens ? `1(${baseDie})` : `1${baseDie}`;
            } else if (isComplex || isHalflingShorthand || isD20Shorthand || config.count < 0) {
              mainExpression = needsParens ? `1(${baseDie})` : baseDie;
            } else {
              mainExpression = needsParens ? `1(${baseDie})` : `1${baseDie}`;
            }
          } else {
            mainExpression = baseDie;
          }
        }
        if (config.bestOf && config.count && config.bestOf < config.count) {
          mainExpression += `kh${config.bestOf}`;
        }
        break;
    }
    return mainExpression;
  }
  getRootDieConfig() {
    const configs = this.subRollConfigs;
    return configs.find((config) => config.sides > 0) || configs[0];
  }
  getAllDieConfigs() {
    return this.getSubRollConfigs();
  }
  getBonusDiceConfigs() {
    const allConfigs = this.subRollConfigs;
    const rootConfig = allConfigs.find((config) => config.sides > 0) || allConfigs[0];
    if (!rootConfig) return [];
    return allConfigs.filter((config) => config.sides > 0).filter((config) => config !== rootConfig);
  }
  getBonusDicePMFs(check, eps = 0) {
    return check.getBonusDiceConfigs().map(
      (config) => pmfFromRollBuilder(_RollBuilder.fromConfigs([config]), eps)
    );
  }
  get modifier() {
    return this.subRollConfigs.reduce(
      (sum, config) => sum + config.modifier,
      0
    );
  }
  get rollType() {
    const rootConfig = this.getRootDieConfig();
    return rootConfig?.rollType || "flat";
  }
  get baseReroll() {
    const rootConfig = this.getRootDieConfig();
    return rootConfig?.reroll || 0;
  }
  half() {
    return new HalfRollBuilder(this);
  }
  /**
   * Scale this roll's result by `numerator / denominator`, rounding each outcome.
   * A general, composable form of {@link half} — used to model damage-type resistance
   * (`scaleResult(1, 2)` → `(expr) // 2`) and vulnerability (`scaleResult(2)` → `2 * (expr)`).
   * Compose several of these (and plain rolls) into one payload with {@link sumRolls}.
   */
  scaleResult(numerator, denominator = 1, rounding = "floor") {
    return new ScaleRollBuilder(this, numerator, denominator, rounding);
  }
  // Create a "max of N rolls" version of this roll for crit damage with keep operations
  maxOf(count) {
    return new MaxOfRollBuilder(this, count);
  }
  // These methods are implemented via prototype augmentation in ac.ts and dc.ts
  // They are declared here to provide proper TypeScript types
  ac(_targetAC) {
    throw new Error("ac() should be implemented via prototype augmentation");
  }
  dc(_saveDC) {
    throw new Error("dc() should be implemented via prototype augmentation");
  }
};
var HalfRollBuilder = class _HalfRollBuilder extends RollBuilder {
  constructor(innerRoll) {
    super(0);
    this.innerRoll = innerRoll;
  }
  hasHiddenState() {
    return this.innerRoll.hasHiddenState();
  }
  // No need to override create if we don't expose RollBuilder methods that use it,
  // but HalfRollBuilder extends RollBuilder so it does.
  // However, HalfRollBuilder seems to just wrap another roll.
  // If we call .plus() on HalfRollBuilder, it returns a HalfRollBuilder?
  // No, RollBuilder.plus returns RollBuilder.
  // The inheritance here is a bit tricky.
  // Existing code for HalfRollBuilder doesn't seem to implement plus/etc.
  // So .plus() on a HalfRollBuilder would return a RollBuilder (base class).
  // Which is fine.
  // The only issue is if we want it to return HalfRollBuilder, but it doesn't seem designed for that.
  get lastConfig() {
    return this.innerRoll.lastConfig;
  }
  getSubRollConfigs() {
    return this.innerRoll.getSubRollConfigs();
  }
  toExpression() {
    const innerExpression = this.innerRoll.toExpression();
    return `(${innerExpression}) // 2`;
  }
  toAST() {
    return {
      type: "half",
      child: this.innerRoll.toAST()
    };
  }
  toPMF(eps = 0) {
    return pmfFromRollBuilder(this, eps);
  }
  copy() {
    return new _HalfRollBuilder(this.innerRoll.copy());
  }
};
var ScaleRollBuilder = class _ScaleRollBuilder extends RollBuilder {
  constructor(innerRoll, numerator, denominator = 1, rounding = "floor") {
    super(0);
    this.innerRoll = innerRoll;
    this.numerator = numerator;
    this.denominator = denominator;
    this.rounding = rounding;
  }
  hasHiddenState() {
    return this.innerRoll.hasHiddenState();
  }
  get lastConfig() {
    return this.innerRoll.lastConfig;
  }
  getSubRollConfigs() {
    return this.innerRoll.getSubRollConfigs();
  }
  toExpression() {
    const inner = this.innerRoll.toExpression();
    if (this.denominator === 1) return `${this.numerator} * (${inner})`;
    if (this.numerator === 1) return `(${inner}) // ${this.denominator}`;
    return `(${inner}) * ${this.numerator} // ${this.denominator}`;
  }
  toAST() {
    return {
      type: "scale",
      numerator: this.numerator,
      denominator: this.denominator,
      rounding: this.rounding,
      child: this.innerRoll.toAST()
    };
  }
  toPMF(eps = 0) {
    return pmfFromRollBuilder(this, eps);
  }
  copy() {
    return new _ScaleRollBuilder(
      this.innerRoll.copy(),
      this.numerator,
      this.denominator,
      this.rounding
    );
  }
};
var MaxOfRollBuilder = class _MaxOfRollBuilder extends RollBuilder {
  constructor(innerRoll, count, diceCount, diceSides) {
    super(0);
    this.innerRoll = innerRoll;
    this.count = count;
    this.diceCount = diceCount;
    this.diceSides = diceSides;
  }
  hasHiddenState() {
    return this.innerRoll.hasHiddenState();
  }
  get lastConfig() {
    return this.innerRoll.lastConfig;
  }
  getSubRollConfigs() {
    return this.innerRoll.getSubRollConfigs();
  }
  toExpression() {
    if (this.diceCount && this.diceSides) {
      return `max${this.count}(${this.diceCount}d${this.diceSides})`;
    }
    return `max${this.count}(?d?)`;
  }
  toAST() {
    if (this.diceCount && this.diceSides) {
      const sumChild = {
        type: "sum",
        count: this.diceCount,
        child: { type: "die", sides: this.diceSides }
      };
      return {
        type: "maxOf",
        count: this.count,
        child: sumChild
      };
    }
    try {
      const configs = this.innerRoll.getSubRollConfigs();
      if (configs.length === 1 && configs[0].sides) {
        const config = configs[0];
        const sumChild = {
          type: "sum",
          count: config.count,
          child: { type: "die", sides: config.sides }
        };
        return {
          type: "maxOf",
          count: this.count,
          child: sumChild
        };
      }
    } catch {
    }
    throw new Error(
      `MaxOfRollBuilder.toAST(): Unsupported innerRoll configuration`
    );
  }
  toPMF(eps = 0) {
    return pmfFromRollBuilder(this, eps);
  }
  copy() {
    return new _MaxOfRollBuilder(this.innerRoll.copy(), this.count);
  }
};
var AlwaysHitBuilder = class _AlwaysHitBuilder extends RollBuilder {
  constructor(baseRoll, attackConfig) {
    if (baseRoll.hasHiddenState()) {
      throw new Error(
        "Cannot create AlwaysHitBuilder from a roll with hidden state."
      );
    }
    super(baseRoll.getSubRollConfigs());
    if (attackConfig) {
      this.attackConfig = { ...attackConfig };
    } else {
      this.attackConfig = { critThreshold: 20 };
    }
  }
  create(configs) {
    return new RollBuilder(configs);
  }
  onHit(...args) {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(this, damageRoll);
  }
  get critThreshold() {
    return this.attackConfig.critThreshold;
  }
  // TODO - move this to AC Builder… or if we create a DC builder that has critOn, throw an error?
  critOn(critThreshold) {
    const newConfig = { critThreshold };
    return new _AlwaysHitBuilder(this, newConfig);
  }
  alwaysCrits() {
    return new AlwaysCritBuilder(this, void 0, true);
  }
  // Legacy expressions
  toExpression() {
    const configs = this.getSubRollConfigs();
    return new RollBuilder(configs).toExpression();
  }
  toPMF() {
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    return d20RollPMF(rollType, rerollOne);
  }
  copy() {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const critThreshold = this.critThreshold;
    const newConfig = { critThreshold };
    return new _AlwaysHitBuilder(baseCopy, newConfig);
  }
};
var AlwaysCritBuilder = class _AlwaysCritBuilder extends RollBuilder {
  constructor(baseRoll, attackConfig, fromAlwaysHit = false) {
    if (baseRoll.hasHiddenState()) {
      throw new Error(
        "Cannot create AlwaysCritBuilder from a roll with hidden state."
      );
    }
    super(baseRoll.getSubRollConfigs());
    if (attackConfig) {
      this.attackConfig = { ...attackConfig };
    } else {
      this.attackConfig = { critThreshold: 20 };
    }
    this.fromAlwaysHit = fromAlwaysHit || baseRoll instanceof AlwaysHitBuilder;
  }
  create(configs) {
    return new RollBuilder(configs);
  }
  onHit(...args) {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(this, damageRoll);
  }
  get critThreshold() {
    return this.attackConfig.critThreshold;
  }
  critOn(critThreshold) {
    const newConfig = { critThreshold, ac: this.attackConfig.ac };
    return new _AlwaysCritBuilder(this, newConfig, this.fromAlwaysHit);
  }
  // Legacy expressions
  toExpression() {
    const configs = this.getSubRollConfigs();
    return new RollBuilder(configs).toExpression();
  }
  toPMF() {
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    return d20RollPMF(rollType, rerollOne);
  }
  copy() {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const critThreshold = this.critThreshold;
    const newConfig = { critThreshold, ac: this.attackConfig.ac };
    return new _AlwaysCritBuilder(baseCopy, newConfig, this.fromAlwaysHit);
  }
};
var ParsedRollBuilder = class _ParsedRollBuilder extends RollBuilder {
  constructor(expression) {
    super([]);
    this.originalExpression = expression;
    this.cachedPMF = parse(expression, 0);
  }
  hasHiddenState() {
    return true;
  }
  create(configs) {
    return new RollBuilder(configs);
  }
  toPMF(_eps = 0) {
    return this.cachedPMF;
  }
  toExpression() {
    return this.originalExpression;
  }
  toAST() {
    throw new Error(
      "ParsedRollBuilder does not support AST conversion. Use the builder API instead."
    );
  }
  copy() {
    return new _ParsedRollBuilder(this.originalExpression);
  }
  doubleDice() {
    throw new Error(
      "ParsedRollBuilder does not support doubleDice(). Use explicit onCrit() with the crit damage expression instead."
    );
  }
};
var PooledRollBuilder = class _PooledRollBuilder extends RollBuilder {
  constructor(baseAST, baseExpression, configs = []) {
    super(configs.length > 0 ? configs : 0);
    this.baseAST = baseAST;
    this.baseExpression = baseExpression;
  }
  create(configs) {
    return new _PooledRollBuilder(this.baseAST, this.baseExpression, configs);
  }
  hasHiddenState() {
    return true;
  }
  d(_sides) {
    throw new Error("Cannot add dice to a pooled roll. The pool is finalized.");
  }
  reroll(_value) {
    throw new Error("Cannot set reroll on a pooled roll.");
  }
  explode(_count = Infinity) {
    throw new Error("Cannot set explode on a pooled roll.");
  }
  minimum(_val) {
    throw new Error("Cannot set minimum on a pooled roll.");
  }
  bestOf(_count) {
    throw new Error("Cannot set bestOf on a pooled roll.");
  }
  keepHighest(_total, _count) {
    throw new Error(
      "Cannot use keepHighest on a pooled roll. Use keepHighestAll again if you want nested pooling."
    );
  }
  keepLowest(_total, _count) {
    throw new Error(
      "Cannot use keepLowest on a pooled roll. Use keepLowestAll again if you want nested pooling."
    );
  }
  withAdvantage() {
    throw new Error("Cannot set advantage on a pooled roll.");
  }
  withDisadvantage() {
    throw new Error("Cannot set disadvantage on a pooled roll.");
  }
  withElvenAccuracy() {
    throw new Error("Cannot set elven accuracy on a pooled roll.");
  }
  toAST() {
    const configsAST = super.toAST();
    const isZero = configsAST.type === "constant" && configsAST.value === 0;
    if (isZero) {
      return this.baseAST;
    }
    const children = [
      { node: this.baseAST, sign: 1 },
      { node: configsAST, sign: 1 }
    ];
    return { type: "add", children };
  }
  toExpression() {
    const configsExpression = super.toExpression();
    if (configsExpression === "0") {
      return this.baseExpression;
    }
    if (configsExpression.startsWith("-")) {
      return `${this.baseExpression} - ${configsExpression.substring(1)}`;
    }
    return `${this.baseExpression} + ${configsExpression}`;
  }
  copy() {
    return new _PooledRollBuilder(
      this.baseAST,
      this.baseExpression,
      this.getSubRollConfigs()
    );
  }
  scaleDice(scale) {
    const scaleInt = Math.floor(scale);
    if (scaleInt !== scale) throw new Error("Scale must be an integer");
    if (scaleInt <= 0) throw new Error("Scale must be > 0");
    const newBaseAST = {
      type: "sum",
      count: scaleInt,
      child: this.baseAST
    };
    const newBaseExpr = scaleInt === 1 ? this.baseExpression : `${scaleInt}(${this.baseExpression})`;
    return new _PooledRollBuilder(
      newBaseAST,
      newBaseExpr,
      this.getSubRollConfigs()
    );
  }
  times(count) {
    if (isNaN(count)) throw new Error("Invalid NaN value for times");
    if (Math.floor(count) !== count)
      throw new Error("times() requires an integer");
    if (count < 0) throw new Error("times() requires a non-negative integer");
    const currentAST = this.toAST();
    const currentExpr = this.toExpression();
    const sumNode = {
      type: "sum",
      count,
      child: currentAST
    };
    const newExpr = count === 1 ? currentExpr : `${count}(${currentExpr})`;
    return new _PooledRollBuilder(sumNode, newExpr);
  }
};
var CompositeSumRollBuilder = class _CompositeSumRollBuilder extends RollBuilder {
  constructor(parts) {
    super(0);
    this.parts = parts;
  }
  hasHiddenState() {
    return true;
  }
  getSubRollConfigs() {
    return [];
  }
  toAST() {
    return {
      type: "add",
      children: this.parts.map((p) => ({
        node: p.toAST(),
        sign: 1
      }))
    };
  }
  toExpression() {
    const exprs = this.parts.map((p) => p.toExpression()).filter((e) => e && e !== "0");
    if (exprs.length === 0) return "0";
    let result = exprs[0];
    for (let i = 1; i < exprs.length; i++) {
      const e = exprs[i];
      result += e.startsWith("-") ? ` - ${e.substring(1)}` : ` + ${e}`;
    }
    return result.replace(/\+ -/g, "-");
  }
  toPMF(eps = 0) {
    return pmfFromRollBuilder(this, eps);
  }
  copy() {
    return new _CompositeSumRollBuilder(this.parts.map((p) => p.copy()));
  }
};
function sumRolls(parts) {
  const meaningful = parts.filter((p) => p !== void 0);
  if (meaningful.length === 0) return new RollBuilder(0);
  if (meaningful.length === 1) return meaningful[0];
  return new CompositeSumRollBuilder(meaningful);
}

// src/builder/factory.ts
var rollFn = (count, sidesOrDie, modifier) => {
  if (sidesOrDie instanceof RollBuilder) {
    if (sidesOrDie.hasHiddenState()) {
      throw new Error(
        "Cannot use a roll with hidden state (like a pooled roll) as a die type."
      );
    }
    const subRollConfigs = sidesOrDie.getSubRollConfigs();
    if (subRollConfigs.length === 0) return new RollBuilder(0).plus(modifier);
    const absCount = Math.abs(count);
    const newConfigs = subRollConfigs.map((config) => ({
      ...config,
      count: config.count * absCount,
      modifier: config.modifier * absCount
    }));
    let resultBuilder = new RollBuilder(newConfigs);
    if (count < 0) {
      const negatedConfigs = resultBuilder.getSubRollConfigs().map((c) => ({ ...c, isSubtraction: !c.isSubtraction }));
      resultBuilder = new RollBuilder(negatedConfigs);
    }
    return resultBuilder.plus(modifier);
  } else {
    let builder = new RollBuilder(count);
    if (sidesOrDie && sidesOrDie > 0) {
      builder = builder.d(sidesOrDie);
    }
    return builder.plus(modifier);
  }
};
rollFn.d = (sides) => {
  if (typeof sides === "string") {
    return RollBuilder.fromArgs(sides);
  }
  return new RollBuilder(1).d(sides);
};
rollFn.hd20 = () => new RollBuilder(1).d20().reroll(1);
rollFn.d4 = () => new RollBuilder(1).d4();
rollFn.d6 = () => new RollBuilder(1).d6();
rollFn.d8 = () => new RollBuilder(1).d8();
rollFn.d10 = () => new RollBuilder(1).d10();
rollFn.d12 = () => new RollBuilder(1).d12();
rollFn.d20 = () => new RollBuilder(1).d20();
rollFn.d100 = () => new RollBuilder(1).d100();
rollFn.flat = (n) => new RollBuilder(0).plus(n);
function d(sides) {
  if (typeof sides === "string") {
    return RollBuilder.fromArgs(sides);
  }
  return new RollBuilder(1).d(sides);
}
var d4 = new RollBuilder(1).d4();
var d6 = new RollBuilder(1).d6();
var d8 = new RollBuilder(1).d8();
var d10 = new RollBuilder(1).d10();
var d12 = new RollBuilder(1).d12();
var d20 = new RollBuilder(1).d20();
var hd20 = new RollBuilder(1).d20().reroll(1);
var d100 = new RollBuilder(1).d100();
var flat = (n) => new RollBuilder(0).plus(n);
var roll = rollFn;
var builderPMFCache = new LRUCache(1e3);

// src/builder/ast.ts
var defaultEps = 0;
var singleDiePMFCache = new LRUCache(1e3);
function astFromRollConfigs(configs) {
  if (!configs || configs.length === 0) return void 0;
  const children = [];
  let constantSum = 0;
  for (const cfg of configs) {
    const sign = cfg.isSubtraction || cfg.count < 0 ? -1 : 1;
    const count = Math.abs(cfg.count || 0);
    constantSum += cfg.modifier || 0;
    if ((cfg.sides || 0) <= 0) continue;
    const die = {
      type: "die",
      sides: cfg.sides,
      reroll: cfg.reroll > 0 ? cfg.reroll : void 0,
      minimum: cfg.minimum > 0 ? cfg.minimum : void 0,
      explode: cfg.explode && Number.isFinite(cfg.explode) && cfg.explode > 0 ? cfg.explode : void 0
    };
    let node = die;
    let appliedRollType = false;
    if (cfg.rollType && cfg.rollType !== "flat") {
      if (cfg.sides === 20) {
        node = {
          type: "d20Roll",
          rollType: cfg.rollType,
          child: node
        };
      } else {
        const n = cfg.rollType === "elven accuracy" ? 3 : 2;
        const mode = cfg.rollType === "disadvantage" ? "lowest" : "highest";
        const base = { type: "sum", count: n, child: node };
        node = { type: "keep", mode, count: 1, child: base };
      }
      appliedRollType = true;
    }
    if (cfg.rollType === "flat" && cfg.keep && cfg.keep.total > 0) {
      const baseCount = Math.max(1, Math.floor(Math.abs(count || 1)));
      const trials = Math.max(1, Math.floor(cfg.keep.total));
      const k = Math.max(0, Math.floor(cfg.keep.count));
      if (k === 1 && cfg.keep.mode === "highest") {
        const perTrial = {
          type: "sum",
          count: baseCount,
          child: node
        };
        if (trials === 1) {
          node = perTrial;
        } else {
          node = {
            type: "maxOf",
            count: trials,
            child: perTrial
          };
        }
      } else if (trials === baseCount) {
        const base = { type: "sum", count: trials, child: node };
        node = {
          type: "keep",
          mode: cfg.keep.mode,
          count: k,
          child: base
        };
      } else {
        const perTrial = {
          type: "sum",
          count: baseCount,
          child: node
        };
        if (trials === 1) {
          node = perTrial;
        } else {
          const trialPool = {
            type: "sum",
            count: trials,
            child: perTrial
          };
          node = {
            type: "keep",
            mode: cfg.keep.mode,
            count: k,
            child: trialPool
          };
        }
      }
    } else {
      const c = appliedRollType ? 1 : Math.max(1, count || 1);
      node = { type: "sum", count: c, child: node };
    }
    children.push({ node, sign });
  }
  if (children.length === 0) {
    return { type: "constant", value: constantSum };
  }
  const add = { type: "add", children };
  if (constantSum !== 0)
    add.children.push({
      node: { type: "constant", value: constantSum },
      sign: 1
    });
  return add;
}
function resolve(node, eps = defaultEps) {
  const signature = getASTSignature(node);
  const cacheKey = `${signature}_${eps}`;
  const cached = builderPMFCache.get(cacheKey);
  if (cached) return cached;
  const result = (() => {
    switch (node.type) {
      case "constant":
        return PMF.delta(node.value, eps);
      case "die": {
        return resolveSingleDie(node, eps);
      }
      case "sum": {
        const base = resolve(node.child, eps);
        const n = Math.max(0, Math.floor(node.count));
        if (n === 0) return PMF.delta(0, eps);
        if (n === 1) return base;
        return base.power(n, eps);
      }
      case "add": {
        let shift = 0;
        const parts = [];
        for (const c of node.children) {
          if (c.node.type === "constant") {
            shift += c.sign * c.node.value;
          } else {
            const p = resolve(c.node, eps);
            parts.push(c.sign === 1 ? p : p.mapDamage((v) => -v));
          }
        }
        if (parts.length === 0) return PMF.delta(shift, eps);
        let res = parts.length === 1 ? parts[0] : PMF.convolveMany(parts, eps);
        if (shift !== 0) res = res.mapDamage((v) => v + shift);
        return res;
      }
      case "keep": {
        const totalTrials = getTotalCount(node);
        const keepCount = Math.max(0, Math.min(node.count, totalTrials));
        if (keepCount === 0 || totalTrials === 0) return PMF.delta(0, eps);
        const perTrialNode = node.child.child;
        const perTrialPMF = resolve(perTrialNode, eps);
        return keepSumPMF(
          perTrialPMF,
          totalTrials,
          keepCount,
          node.mode === "highest",
          eps
        );
      }
      case "d20Roll": {
        const childDie = findDie(node.child);
        const rerollOne = !!childDie && (childDie.reroll || 0) >= 1;
        return d20RollPMF(node.rollType, rerollOne);
      }
      case "half": {
        const childPMF = resolve(node.child, eps);
        return childPMF.scaleDamage(0.5, "floor");
      }
      case "maxOf": {
        const childPMF = resolve(node.child, eps);
        const count = Math.max(1, Math.floor(node.count));
        if (count === 1) return childPMF;
        return computeMaxOfPMF(childPMF, count, eps);
      }
      case "scale": {
        const childPMF = resolve(node.child, eps);
        const denom = node.denominator === 0 ? 1 : node.denominator;
        return childPMF.scaleDamage(node.numerator / denom, node.rounding);
      }
    }
  })();
  builderPMFCache.set(cacheKey, result);
  return result;
}
function pmfFromRollBuilder(rb, eps = defaultEps) {
  const ast = rb.toAST();
  return resolve(ast, eps);
}
function resolveSingleDie(die, eps = defaultEps) {
  const signature = getASTSignature(die);
  const cacheKey = `${signature}_${eps}`;
  const cached = singleDiePMFCache.get(cacheKey);
  if (cached) return cached;
  const s = Math.max(0, Math.floor(die.sides));
  if (s <= 0) return PMF.delta(0, eps);
  let probs = /* @__PURE__ */ new Map();
  for (let v = 1; v <= s; v++) probs.set(v, 1 / s);
  const r = Math.max(0, Math.floor(die.reroll || 0));
  if (r > 0) {
    const k = Math.min(r, s);
    const rerollMass = k / s;
    const uniformReroll = rerollMass / s;
    const next = /* @__PURE__ */ new Map();
    for (let v = 1; v <= s; v++) {
      const keep = v <= k ? 0 : 1 / s;
      next.set(v, keep + uniformReroll);
    }
    probs = next;
  }
  let pmf = PMF.fromMap(new Map(probs), eps);
  const minV = Math.max(0, Math.floor(die.minimum || 0));
  if (minV > 0) pmf = pmf.mapDamage((v) => Math.max(v, minV));
  const explode = die.explode;
  if (explode && Number.isFinite(explode) && explode > 0) {
    const times = Math.floor(explode);
    const maxFace = s;
    const nonMax = /* @__PURE__ */ new Map();
    const pMax = pmf.pAt(maxFace);
    for (const v of pmf.support()) {
      if (v !== maxFace) nonMax.set(v, pmf.pAt(v));
    }
    let nonMaxPMF = PMF.fromMap(nonMax, eps);
    if (Math.abs(nonMaxPMF.mass() - (1 - pMax)) > eps) {
      nonMaxPMF = nonMaxPMF.scaleMass(1 - pMax);
    }
    let tail = PMF.delta(0, eps);
    const addOnce = pmf;
    for (let t = 1; t <= times; t++) {
      tail = tail.convolve(addOnce, eps);
    }
    const exploded = PMF.branch(
      tail.mapDamage((v) => v + maxFace),
      nonMaxPMF,
      pMax
    );
    pmf = exploded;
  }
  singleDiePMFCache.set(cacheKey, pmf);
  return pmf;
}
function findDie(node) {
  switch (node.type) {
    case "die":
      return node;
    case "constant":
      return void 0;
    case "sum":
    case "d20Roll":
    case "half":
    case "maxOf":
    case "scale":
      return findDie(node.child);
    case "keep":
      return findDie(node.child.child);
    case "add":
      for (const c of node.children) {
        const d2 = findDie(c.node);
        if (d2) return d2;
      }
      return void 0;
  }
}
function getTotalCount(node) {
  let cur = node.child;
  while (cur.type === "keep") cur = cur.child;
  return cur.type === "sum" ? Math.max(0, Math.floor(cur.count)) : 0;
}
function computeMaxOfPMF(pmf, count, eps = defaultEps) {
  if (count <= 1) return pmf;
  const support = pmf.support();
  const out = /* @__PURE__ */ new Map();
  if (count <= 6 && support.length <= 20) {
    let dfs2 = function(rollsLeft, currentMax, probability) {
      if (rollsLeft === 0) {
        out.set(currentMax, (out.get(currentMax) || 0) + probability);
        return;
      }
      for (const value of support) {
        const p = pmf.pAt(value);
        if (p > 0) {
          const newMax = Math.max(currentMax, value);
          dfs2(rollsLeft - 1, newMax, probability * p);
        }
      }
    };
    dfs2(count, -Infinity, 1);
  } else {
    const sortedSupport = [...support].sort((a, b) => a - b);
    let runningCdf = 0;
    for (const value of sortedSupport) {
      const prevCdf = runningCdf;
      runningCdf += pmf.pAt(value);
      const probMax = Math.pow(runningCdf, count) - Math.pow(prevCdf, count);
      if (probMax > eps) {
        out.set(value, probMax);
      }
    }
  }
  return PMF.fromMap(out, eps);
}
function keepSumPMF(single, total, keep, highest, eps = defaultEps) {
  if (keep >= total) return single.power(total, eps);
  if (keep <= 0) return PMF.delta(0, eps);
  const sortedSupport = [...single.support()].sort((a, b) => a - b);
  const pmfSig = sortedSupport.map((val) => `${val}:${single.pAt(val).toPrecision(6)}`).join(",");
  const cacheKey = `keep|${pmfSig}|t:${total}|k:${keep}|h:${highest ? 1 : 0}|e:${eps}`;
  const cached = builderPMFCache.get(cacheKey);
  if (cached) return cached;
  if (keep === 1) {
    if (highest) {
      return computeMaxOfPMF(single, total, eps);
    } else {
      const neg = single.mapDamage((v) => -v);
      const minPMF = computeMaxOfPMF(neg, total, eps).mapDamage((v) => -v);
      builderPMFCache.set(cacheKey, minPMF);
      return minPMF;
    }
  }
  let state = /* @__PURE__ */ new Map();
  const stride = total + 1;
  const keyOf = (used, r) => used * stride + r;
  state.set(keyOf(0, total), /* @__PURE__ */ new Map([[0, 1]]));
  const valuesDesc = highest ? [...sortedSupport].sort((a, b) => b - a) : [...sortedSupport].sort((a, b) => a - b);
  const binomPMF = (r, p) => {
    if (r <= 0) return [1];
    if (p <= eps) {
      const arr2 = new Array(r + 1).fill(0);
      arr2[0] = 1;
      return arr2;
    }
    if (1 - p <= eps) {
      const arr2 = new Array(r + 1).fill(0);
      arr2[r] = 1;
      return arr2;
    }
    const q = 1 - p;
    const arr = new Array(r + 1).fill(0);
    arr[0] = Math.pow(q, r);
    const ratio = p / q;
    for (let x = 1; x <= r; x++)
      arr[x] = arr[x - 1] * (r - x + 1) / x * ratio;
    let s = 0;
    for (let x = 0; x <= r; x++) s += arr[x];
    if (Math.abs(1 - s) > 1e-12) for (let x = 0; x <= r; x++) arr[x] /= s;
    return arr;
  };
  const pruneMap = (m, threshold) => {
    if (threshold <= 0) return m;
    const out = /* @__PURE__ */ new Map();
    for (const [sum, pr] of m) if (pr >= threshold) out.set(sum, pr);
    return out.size === m.size ? m : out;
  };
  const pruneState = (st, threshold) => {
    if (threshold <= 0) return st;
    const out = /* @__PURE__ */ new Map();
    for (const [k, m] of st) {
      const mm = pruneMap(m, threshold);
      if (mm.size > 0) out.set(k, mm);
    }
    return out;
  };
  let processedMass = 0;
  for (const v of valuesDesc) {
    const p = single.pAt(v);
    if (p <= 0) continue;
    const q = Math.max(eps, 1 - processedMass);
    const pCond = Math.min(1, p / q);
    const next = /* @__PURE__ */ new Map();
    for (const [k, m] of state) {
      const used = Math.floor(k / stride);
      const r = k - used * stride;
      if (r === 0) {
        const destKey = keyOf(used, 0);
        const dest = next.get(destKey) ?? /* @__PURE__ */ new Map();
        for (const [sum, pr] of m) dest.set(sum, (dest.get(sum) || 0) + pr);
        next.set(destKey, dest);
        continue;
      }
      const bin = binomPMF(r, pCond);
      const remainingCapacity = keep - used;
      for (let x = 0; x <= r; x++) {
        const px = bin[x];
        if (px <= eps) continue;
        const t = Math.min(x, remainingCapacity);
        const used2 = used + t;
        const r2 = r - x;
        const add = t * v;
        const destKey = keyOf(used2, r2);
        const dest = next.get(destKey) ?? /* @__PURE__ */ new Map();
        for (const [sum, pr] of m) {
          const s2 = sum + add;
          const prob = pr * px;
          const cur = dest.get(s2) || 0;
          const nv = cur + prob;
          if (nv >= eps) dest.set(s2, nv);
        }
        if (dest.size > 0) next.set(destKey, dest);
      }
    }
    state = pruneState(next, eps * 1e-6);
    processedMass += p;
  }
  const finalKey = keyOf(keep, 0);
  const dist = state.get(finalKey) ?? /* @__PURE__ */ new Map();
  if (dist.size === 0) {
    return PMF.emptyMass();
  }
  const result = PMF.fromMap(dist, eps);
  builderPMFCache.set(cacheKey, result);
  return result;
}
function getASTSignature(node) {
  switch (node.type) {
    case "constant":
      return `c:${node.value}`;
    case "die": {
      const parts = [];
      parts.push(`s:${node.sides}`);
      if (node.reroll) parts.push(`r:${node.reroll}`);
      if (node.minimum) parts.push(`m:${node.minimum}`);
      if (node.explode) parts.push(`e:${node.explode}`);
      return `d{${parts.join(",")}}`;
    }
    case "sum":
      return `sum{c:${node.count},ch:${getASTSignature(node.child)}}`;
    case "d20Roll":
      return `d20{t:${node.rollType},ch:${getASTSignature(node.child)}}`;
    case "keep":
      return `keep{c:${node.count},m:${node.mode},ch:${getASTSignature(
        node.child
      )}}`;
    case "half":
      return `half{ch:${getASTSignature(node.child)}}`;
    case "maxOf":
      return `maxOf{c:${node.count},ch:${getASTSignature(node.child)}}`;
    case "scale":
      return `scale{n:${node.numerator},d:${node.denominator},r:${node.rounding},ch:${getASTSignature(node.child)}}`;
    case "add": {
      let constantValue = 0;
      const otherChildrenSigs = [];
      for (const c of node.children) {
        if (c.node.type === "constant") {
          constantValue += c.sign * c.node.value;
        } else {
          otherChildrenSigs.push(
            `${c.sign === -1 ? "-" : "+"}${getASTSignature(c.node)}`
          );
        }
      }
      if (constantValue !== 0) {
        otherChildrenSigs.push(
          constantValue > 0 ? `+c:${constantValue}` : `-c:${-constantValue}`
        );
      }
      otherChildrenSigs.sort();
      return `add[${otherChildrenSigs.join("")}]`;
    }
  }
}

// src/builder/attack.ts
var AttackBuilder = class _AttackBuilder {
  constructor(check, hitEffect, critEffect, missEffect) {
    this.check = check;
    this.hitEffect = hitEffect;
    this.critEffect = critEffect;
    this.missEffect = missEffect;
  }
  onCrit(...args) {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new _AttackBuilder(
      this.check,
      this.hitEffect,
      damageRoll,
      this.missEffect
    );
  }
  onMiss(...args) {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new _AttackBuilder(
      this.check,
      this.hitEffect,
      this.critEffect,
      damageRoll
    );
  }
  noCrit() {
    return new _AttackBuilder(this.check, this.hitEffect, null, this.missEffect);
  }
  // Legacy expressions
  toExpression() {
    const checkPart = this.check.toExpression();
    let effectPart = "";
    if (this.hitEffect) {
      effectPart = `(${this.hitEffect.toExpression()})`;
      if (this.critEffect !== null) {
        let crit;
        if (this.critEffect) {
          crit = this.critEffect;
        } else {
          if (this.hitEffect instanceof ParsedRollBuilder) {
            crit = RollBuilder.fromArgs(0);
          } else {
            crit = this.hitEffect?.copy().doubleDice() ?? RollBuilder.fromArgs(0);
          }
        }
        const critThreshold = this.check.critThreshold;
        if (critThreshold < 1 || critThreshold > 20) {
          throw new Error(
            `Invalid crit threshold: ${critThreshold}. Must be between 1 and 20.`
          );
        }
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
  resolveProbabilities(check, eps = 0) {
    const rollType = check.rollType;
    const rerollOne = check.baseReroll > 0;
    const critThreshold = check.critThreshold;
    const d202 = d20RollPMF(rollType, rerollOne);
    if (check instanceof AlwaysCritBuilder) {
      if (check.fromAlwaysHit) {
        return { pSuccess: 1, pHit: 0, pCrit: 1, pMiss: 0 };
      }
      const ac2 = check.attackConfig.ac ?? 0;
      const staticMod2 = this.check.modifier;
      const bonusDicePMFs2 = this.check.getBonusDicePMFs(this.check, eps);
      const bonusPMF2 = bonusDicePMFs2.length ? PMF.convolveMany(bonusDicePMFs2, eps) : PMF.delta(0, eps);
      let pcrit2 = 0;
      let pmiss2 = 0;
      for (const [r, bin] of d202) {
        const pr = bin.p;
        if (pr <= 0) continue;
        if (r === 1) {
          pmiss2 += pr;
          continue;
        }
        const need = ac2 - staticMod2 - r;
        const pBonusHit = bonusPMF2.tailProbGE(need);
        pcrit2 += pr * pBonusHit;
        pmiss2 += pr * (1 - pBonusHit);
      }
      return { pSuccess: pcrit2, pHit: 0, pCrit: pcrit2, pMiss: pmiss2 };
    }
    if (check instanceof AlwaysHitBuilder) {
      let pCrit = 0;
      for (const [r, bin] of d202) {
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
    const bonusPMF = bonusDicePMFs.length ? PMF.convolveMany(bonusDicePMFs, eps) : PMF.delta(0, eps);
    let pcrit = 0;
    let phit = 0;
    let pmiss = 0;
    for (const [r, bin] of d202) {
      const pr = bin.p;
      if (pr <= 0) continue;
      if (r === 1) {
        pmiss += pr;
        continue;
      }
      if (r >= critThreshold) {
        pcrit += pr;
        continue;
      }
      const need = ac - staticMod - r;
      const pBonusHit = bonusPMF.tailProbGE(need);
      phit += pr * pBonusHit;
      pmiss += pr * (1 - pBonusHit);
    }
    const psuccess = phit + pcrit;
    return { pSuccess: psuccess, pHit: phit, pCrit: pcrit, pMiss: pmiss };
  }
  resolve(eps = EPS) {
    const {
      pHit,
      pCrit,
      pMiss: pmiss
    } = this.resolveProbabilities(this.check, eps);
    const hitPMF = this.hitEffect ? this.hitEffect instanceof ParsedRollBuilder ? this.hitEffect.toPMF(eps) : pmfFromRollBuilder(this.hitEffect, eps) : PMF.delta(0, eps);
    let critPMF = null;
    let phit = pHit;
    let pcrit = pCrit;
    if (this.critEffect === null) {
      critPMF = null;
      phit += pcrit;
      pcrit = 0;
    } else {
      let critBuilder;
      if (this.critEffect) {
        critBuilder = this.critEffect;
      } else if (this.hitEffect instanceof ParsedRollBuilder) {
        critPMF = null;
        phit += pcrit;
        pcrit = 0;
        critBuilder = void 0;
      } else {
        critBuilder = this.hitEffect?.copy().doubleDice();
      }
      if (critBuilder) {
        critPMF = critBuilder instanceof ParsedRollBuilder ? critBuilder.toPMF(eps) : pmfFromRollBuilder(critBuilder, eps);
      }
    }
    const missPMF = this.missEffect ? this.missEffect instanceof ParsedRollBuilder ? this.missEffect.toPMF(eps) : pmfFromRollBuilder(this.missEffect, eps) : PMF.delta(0, eps);
    const mix = new Mixture(eps);
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
      weights: { hit: phit, crit: pcrit, miss: pmiss }
    };
  }
  // By default, create PMF with no pruning
  toPMF(eps = 0) {
    return this.resolve(eps).pmf;
  }
  get pmf() {
    return this.toPMF();
  }
  // By default, create query on PMF with no pruning
  toQuery(eps = 0) {
    return this.toPMF(eps).query();
  }
};

// src/builder/ac.ts
var ACBuilder = class _ACBuilder extends RollBuilder {
  constructor(baseRoll, ac, attackConfig) {
    super(baseRoll.getSubRollConfigs());
    if (attackConfig) {
      this.attackConfig = { ...attackConfig, ac };
    } else {
      this.attackConfig = { ac, critThreshold: 20 };
    }
  }
  onHit(...args) {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new AttackBuilder(this, damageRoll);
  }
  get critThreshold() {
    return this.attackConfig.critThreshold;
  }
  // TODO - move this to AC Builder… or if we create a DC builder that has critOn, throw an error?
  critOn(threshold) {
    const newConfig = {
      ...this.attackConfig,
      critThreshold: threshold
    };
    return new _ACBuilder(this, this.attackConfig.ac, newConfig);
  }
  alwaysCrits() {
    return new AlwaysCritBuilder(
      this,
      {
        critThreshold: this.attackConfig.critThreshold,
        ac: this.attackConfig.ac
      },
      false
    );
  }
  // Legacy expressions
  toExpression() {
    const configs = this.getSubRollConfigs();
    const expression = new RollBuilder(configs).toExpression();
    return this.attackConfig.ac ? `(${expression} AC ${this.attackConfig.ac})` : expression;
  }
  toPMF(eps = 0) {
    const ac = this.attackConfig.ac;
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    const d202 = d20RollPMF(rollType, rerollOne);
    const staticMod = this.modifier;
    const bonusPMFs = this.getBonusDicePMFs(this, eps);
    const parts = [d202, ...bonusPMFs];
    let attackRollPMF = parts.length === 1 ? d202 : PMF.convolveMany(parts, eps);
    if (staticMod !== 0)
      attackRollPMF = attackRollPMF.mapDamage(
        (rollValue) => rollValue + staticMod
      );
    const out = /* @__PURE__ */ new Map();
    for (const rollValue of attackRollPMF.support()) {
      const p = attackRollPMF.pAt(rollValue);
      const key = rollValue >= ac ? rollValue : 0;
      out.set(key, (out.get(key) || 0) + p);
    }
    return PMF.fromMap(out, eps);
  }
  copy() {
    const baseCopy = new RollBuilder(this.getSubRollConfigs());
    const newConfig = {
      ac: this.attackConfig.ac,
      critThreshold: this.attackConfig.critThreshold
    };
    return new _ACBuilder(baseCopy, newConfig.ac, newConfig);
  }
};
RollBuilder.prototype.ac = function(targetAC) {
  if (isNaN(targetAC)) throw new Error("Invalid NaN value for targetAC");
  return new ACBuilder(this, targetAC);
};

// src/builder/save.ts
var SaveBuilder = class _SaveBuilder {
  constructor(check, failureEffect, saveOutcome = "normal") {
    this.check = check;
    this.failureEffect = failureEffect;
    this.saveOutcome = saveOutcome;
  }
  saveHalf() {
    return new _SaveBuilder(this.check, this.failureEffect, "half");
  }
  toExpression() {
    const checkPart = this.check.toExpression();
    if (!this.failureEffect) return checkPart;
    const failureEffectPart = this.failureEffect.toExpression();
    const result = `${checkPart} * (${failureEffectPart})`;
    return this.saveOutcome === "half" ? `${result} save half` : result;
  }
  resolve(eps = EPS) {
    const { pSuccess: psuccess = 0, pFail: pfail = 1 } = resolveProbabilities(
      this.check
    );
    const failPMF = this.failureEffect ? this.failureEffect instanceof ParsedRollBuilder ? this.failureEffect.toPMF(eps) : pmfFromRollBuilder(this.failureEffect) : PMF.delta(0);
    const onSuccess = this.saveOutcome ?? "half";
    let successPMF = PMF.delta(0, eps);
    if (onSuccess === "half") successPMF = failPMF.scaleDamage(0.5, "floor");
    const successLabel = onSuccess === "normal" ? "missNone" : "saveHalf";
    const failLabel = "saveFail";
    const baseMix = new Mixture(eps);
    const mixture = baseMix.add(successLabel, successPMF, psuccess).add(failLabel, failPMF, pfail);
    return {
      pmf: mixture.buildPMF(eps) ?? PMF.delta(0, eps),
      check: PMF.exclusive([[PMF.delta(1), psuccess]], eps) ?? PMF.delta(0, eps),
      saveFail: failPMF ?? PMF.delta(0, eps),
      saveSuccess: successPMF ?? PMF.delta(0, eps),
      weights: { success: psuccess, fail: pfail }
    };
  }
  // By default, create PMF with no pruning
  toPMF(eps = 0) {
    return this.resolve(eps).pmf;
  }
  get pmf() {
    return this.toPMF();
  }
  // By default, create query on PMF with no pruning
  toQuery(eps = 0) {
    return this.toPMF(eps).query();
  }
};
function resolveProbabilities(check) {
  const saveBonus = check.modifier;
  const dc = check.saveDC;
  const d20Type = check.rollType;
  const baseReroll = check.baseReroll;
  const die = d20RollPMF(d20Type, baseReroll > 0);
  const faceP = /* @__PURE__ */ new Map();
  for (const [r, bin] of die) {
    const pr = bin.p;
    if (pr > 0) faceP.set(r, pr);
  }
  const eps = 0;
  const bonusDicePMFs = check.getBonusDicePMFs(check, eps);
  const bonusPMF = bonusDicePMFs.length > 0 ? PMF.convolveMany(bonusDicePMFs, eps) : PMF.zero(eps);
  let pSuccess = 0;
  for (let r = 1; r <= 20; r++) {
    const pr = faceP.get(r);
    if (!pr) continue;
    const need = dc - saveBonus - r;
    pSuccess += pr * bonusPMF.tailProbGE(need);
  }
  const pFail = Math.max(0, 1 - pSuccess);
  return { pSuccess, pFail };
}

// src/builder/dc.ts
var DCBuilder = class _DCBuilder extends RollBuilder {
  constructor(baseRoll, saveConfig) {
    super(baseRoll.getSubRollConfigs());
    this.saveConfig = saveConfig ? { ...saveConfig } : { dc: 10 };
  }
  dc(saveDC) {
    if (this.rollType && this.rollType === "elven accuracy") {
      throw new Error(
        "Cannot use dc() on an AttackRollBuilder. Use ac() for attack rolls instead."
      );
    }
    return new _DCBuilder(this, { dc: saveDC });
  }
  get saveDC() {
    return this.saveConfig.dc;
  }
  add(anotherRoll) {
    const newBuilder = super.add(anotherRoll);
    return new _DCBuilder(newBuilder, this.saveConfig);
  }
  addRoll(count) {
    const newBuilder = super.addRoll(count);
    return new _DCBuilder(newBuilder, this.saveConfig);
  }
  onSaveFailure(...args) {
    const damageRoll = RollBuilder.fromArgs(...args);
    return new SaveBuilder(this, damageRoll);
  }
  withElvenAccuracy() {
    throw new Error(
      "Elven Accuracy cannot be used with saving throws (DC checks). It is only valid for attack rolls (AC checks)."
    );
  }
  // Legacy expressions
  toExpression() {
    const subConfigs = this.getSubRollConfigs();
    const allConfigs = [...subConfigs];
    const expression = new RollBuilder(allConfigs).toExpression();
    return `(${expression} DC ${this.saveConfig.dc})`;
  }
  toPMF(eps = 0) {
    const saveDC = this.saveDC;
    const rollType = this.rollType;
    const rerollOne = this.baseReroll > 0;
    const d202 = d20RollPMF(rollType, rerollOne);
    const staticMod = this.modifier;
    const bonusDicePMFs = this.getBonusDiceConfigs().map(
      (cfg) => pmfFromRollBuilder(RollBuilder.fromConfigs([cfg]), eps)
    );
    const bonusPMF = bonusDicePMFs.length ? PMF.convolveMany(bonusDicePMFs, eps) : PMF.delta(0, eps);
    let psuccess = 0;
    for (const [r, bin] of d202) {
      const pr = bin.p;
      if (pr <= 0) continue;
      const need = saveDC - staticMod - r;
      psuccess += pr * bonusPMF.tailProbGE(need);
    }
    const pfail = Math.max(0, 1 - psuccess);
    const m = /* @__PURE__ */ new Map([
      [0, psuccess > 0 ? psuccess : 0],
      [1, pfail > 0 ? pfail : 0]
    ]);
    return PMF.fromMap(m, eps);
  }
};
RollBuilder.prototype.dc = function(saveDC) {
  if (isNaN(saveDC)) throw new Error("Invalid NaN value for saveDC");
  return new DCBuilder(this).dc(saveDC);
};

exports.ACBuilder = ACBuilder;
exports.AlwaysCritBuilder = AlwaysCritBuilder;
exports.AlwaysHitBuilder = AlwaysHitBuilder;
exports.AttackBuilder = AttackBuilder;
exports.DCBuilder = DCBuilder;
exports.HalfRollBuilder = HalfRollBuilder;
exports.MaxOfRollBuilder = MaxOfRollBuilder;
exports.ParsedRollBuilder = ParsedRollBuilder;
exports.PooledRollBuilder = PooledRollBuilder;
exports.RollBuilder = RollBuilder;
exports.SaveBuilder = SaveBuilder;
exports.ScaleRollBuilder = ScaleRollBuilder;
exports.builderPMFCache = builderPMFCache;
exports.d = d;
exports.d10 = d10;
exports.d100 = d100;
exports.d12 = d12;
exports.d20 = d20;
exports.d4 = d4;
exports.d6 = d6;
exports.d8 = d8;
exports.defaultConfig = defaultConfig;
exports.flat = flat;
exports.hd20 = hd20;
exports.roll = roll;
exports.sumRolls = sumRolls;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map