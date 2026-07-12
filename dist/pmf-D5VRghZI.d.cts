/**
 * Simple LRU cache implementation
 */
declare class LRUCache<K, V> {
    private readonly maxSize;
    private cache;
    constructor(maxSize?: number);
    get(key: K): V | undefined;
    delete(key: K): void;
    set(key: K, value: V): this;
    clear(): void;
    get size(): number;
    has(key: K): boolean;
    keys(): IterableIterator<K>;
    values(): IterableIterator<V>;
}

/** Mapping from outcome label to probability mass or damage attribution. */
type OutcomeLabelMap = Partial<Record<string, number>>;
/** Computational epsilon for pruning negligible probabilities. */
declare const EPS = 1e-12;
/** A probability bin for a specific damage value. */
interface Bin {
    /** Total probability mass at this damage value. */
    p: number;
    /** Per-outcome probability mass contributions at this damage. */
    count: OutcomeLabelMap;
    /** Optional per-outcome damage attribution at this damage. */
    attr?: OutcomeLabelMap;
}
interface CritConfig {
    critThreshold: number;
}
/** Simple mapping from damage value to probability. */
type DamageDistribution = Record<number, number>;
/** Canonical outcome labels supported by the query helpers. */
type OutcomeType = "crit" | "hit" | "missNone" | "missDamage" | "saveHalf" | "saveFail" | "pc";
type Rounding = "none" | "floor" | "round" | "ceil";
/** How a d20 attack roll resolves: single die, keep-highest of 2/3, or keep-lowest of 2. */
type RollType = "flat" | "advantage" | "disadvantage" | "elven accuracy";
/**
 * P(critical hit) for the given crit window and d20 {@link RollType}.
 *
 * `critRange` is the number of top faces that crit (1 for a natural 20, 2 for
 * 19–20, …), so a single die crits with probability `critRange / 20`. Advantage
 * rolls two d20s / elven accuracy three, keeping the best; disadvantage keeps
 * the worst of two.
 */
declare function critProbability(critRange: number, rollType?: RollType): number;
/**
 * The canonical "clean miss" outcome — a point of zero damage with no rider.
 * This is the {@link OutcomeType} that attribution charts and outcome stats key
 * on, and is distinct from the builder's attack-resolution `miss` weight label.
 */
declare const MISS_NONE_OUTCOME: OutcomeType;
/**
 * All outcome types in canonical severity order — clean miss → crit. This is
 * also the natural stacking order for attribution charts (least- to
 * most-impactful, bottom → top). Enumerates every {@link OutcomeType} exactly
 * once; use it instead of hand-maintained per-consumer outcome tables.
 */
declare const ALL_OUTCOME_TYPES: OutcomeType[];
/**
 * Outcome types in display order for stats / breakdown rows — most prominent
 * first (crit, hit, …) down to the clean miss.
 */
declare const OUTCOME_DISPLAY_ORDER: OutcomeType[];
/**
 * Sort outcome labels by a canonical order (defaults to {@link ALL_OUTCOME_TYPES}).
 * Labels not present in `order` sort after known ones, alphabetically — so
 * ad-hoc/test labels outside the {@link OutcomeType} union stay stable.
 */
declare function sortOutcomes<T extends string>(outcomes: Iterable<T>, order?: readonly string[]): T[];
declare const onAnyHit: OutcomeType[];
declare const onCritOnly: OutcomeType[];
declare const onHitOnly: OutcomeType[];
declare const onMissOnly: OutcomeType[];
declare const onMissDamageOnly: OutcomeType[];
declare const onSaveHalfOnly: OutcomeType[];
declare const onSaveFailOnly: OutcomeType[];
declare const onPotentCantripOnly: OutcomeType[];

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
declare class DiceQuery {
    readonly singles: PMF[];
    private readonly _eps;
    private readonly _combinedProvided;
    private _combined?;
    private _combinedWithAttr?;
    constructor(singles: PMF | PMF[], combined?: PMF, eps?: number);
    /**
     * The combined damage distribution of all single PMFs (their convolution),
     * normalized to total probability 1.
     *
     * Computed lazily on first access and cached. Queries that only need
     * additive statistics — {@link DiceQuery.mean}, {@link DiceQuery.variance},
     * {@link DiceQuery.stddev} — never trigger this convolution.
     */
    get combined(): PMF;
    private static readonly DEFAULT_OUTCOMES;
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
    combinedWithAttribution(): PMF;
    /**
     * Per-label `damage value → probability mass` series for the combined,
     * attribution-carrying distribution — the provenance core of the stacked
     * damage-attribution chart. Convenience for
     * `combinedWithAttribution().attributionByValue()`; see
     * {@link PMF.attributionByValue}.
     */
    attributionByValue(): Map<string, Map<number, number>>;
    /**
     * How many of the independent single PMFs can produce the given outcome
     * label. Useful for "all of them succeeded" style probabilities where the
     * exponent is the number of contributing attacks (see
     * {@link DiceQuery.probExactlyK}).
     */
    countSinglesWith(label: string): number;
    /**
     * Returns the expected damage across all possible outcomes.
     *
     * Example: `query.mean()` → 12.5
     * Use case: "What's my average damage per round?"
     */
    mean(): number;
    /**
     * Returns the variance of the damage distribution.
     *
     * Example: `query.variance()` → 45.2
     * Use case: "How much does my damage vary from the average?"
     * High variance means higher risk/reward. Lower variance means more consistent damage.
     */
    variance(): number;
    /**
     * Returns the standard deviation of the damage distribution.
     *
     * Example: `query.stdev()` → 6.7
     * Use case: "What's the typical spread around my average damage?"
     * Used to determine how consistent the damage is.
     */
    stddev(): number;
    /** Alias of {@link DiceQuery.stddev}, matching {@link PMF.stdev}. */
    stdev(): number;
    /**
     * Returns the Cumulative Distribution Function.
     */
    cdf(x: number): number;
    /**
     * Returns the probability of dealing X damage or less.
     * In statistics, this is called the cumulative distribution function (CDF).
     * Example: `query.cdf(20)` → 0.75
     * Use case: "What's the chance I deal 20 damage or less?"
     */
    probTotalAtMost(x: number): number;
    /**
     * Returns the Complementary Cumulative Distribution Function.
     */
    ccdf(x: number): number;
    /**
     * Returns the probability of dealing at least X damage.
     *
     * Example: `query.probTotalAtLeast(25)` → 0.35
     * Use case: "What's the chance I deal at least 25 damage to finish the enemy?"
     */
    probTotalAtLeast(threshold: number): number;
    /**
     * Returns damage values at specific percentiles.
     *
     * Example: `query.percentiles([0.25, 0.5, 0.75])` → [8, 12, 18]
     * Use case: "What are my 25th, 50th, and 75th percentile damage values?"
     */
    percentiles(percentileValues: number[]): number[];
    /**
     * Returns the minimum possible damage.
     *
     * Example: `query.min()` → 0
     * Use case: "What's the worst-case damage if everything misses?"
     */
    min(): number;
    /**
     * Returns the maximum possible damage.
     *
     * Example: `query.max()` → 56
     * Use case: "What's the best-case damage if everything crits and rolls max?"
     */
    max(): number;
    private singleProb;
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
    private countDistribution;
    probAtLeastK(labels: OutcomeType | OutcomeType[], k: number): number;
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
    probAtLeastOne(labels: OutcomeType | OutcomeType[]): number;
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
    private computeBinomialProbabilities;
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
    probExactlyK(labels: OutcomeType | OutcomeType[], k: number): number;
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
    probAtMostK(labels: OutcomeType | OutcomeType[], k: number): number;
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
    expectedDamageFrom(labels: OutcomeType | OutcomeType[]): number;
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
    damageStatsFrom(labels: OutcomeType | OutcomeType[]): {
        min: number;
        max: number;
        avg: number;
        count: number;
    };
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
    };
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
    probabilityOf(labels: OutcomeType | OutcomeType[]): number;
    /**
     * Returns the probability of missing (any type of miss).
     *
     * Example: `query.missChance()` → 0.04
     * Use case: "What's the chance I miss completely this turn?"
     */
    missChance(): number;
    /**
     * Returns data formatted for plotting damage probability distribution.
     *
     * Example: `query.toChartSeries()` → [{x: 0, y: 0.04}, {x: 6, y: 0.1}, ...]
     * Use case: "I want to visualize my damage distribution in a chart."
     */
    toChartSeries(): Array<{
        x: number;
        y: number;
    }>;
    /**
     * Returns tabular data showing damage values and their probability breakdowns.
     *
     * Example: `query.toLabeledTable(['hit', 'crit'])` →
     *   [{damage: 6, total: 0.01, hit: 0.008, crit: 0}, ...]
     *
     * Use case: "I want to see exactly how hit/crit probabilities contribute to each damage value."
     */
    toLabeledTable(labels?: OutcomeType[]): Array<{
        damage: number;
        total: number;
    } & Record<string, number>>;
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
    toStackedChartData(labels?: OutcomeType[], epsilon?: number): {
        labels: number[];
        datasets: Array<{
            label: string;
            data: number[];
        }>;
    };
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
    toAttributionChartSeries(options?: {
        stackOrder?: string[];
        filterRules?: (outcome: string, damage: number) => boolean;
        asPercentages?: boolean;
    }): {
        support: number[];
        outcomes: string[];
        data: {
            [outcome: string]: number[];
        };
    };
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
    toDamageAttributionChartSeries(options?: {
        stackOrder?: string[];
        filterRules?: (outcome: string, damage: number) => boolean;
        asPercentages?: boolean;
    }): {
        support: number[];
        outcomes: string[];
        data: {
            [outcome: string]: number[];
        };
    };
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
    toOutcomeAttributionChartSeries(options?: {
        stackOrder?: string[];
        filterRules?: (outcome: string, damage: number) => boolean;
        asPercentages?: boolean;
    }): {
        support: number[];
        outcomes: string[];
        data: {
            [outcome: string]: number[];
        };
    };
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
    toCDFSeries(asPercentages?: boolean): {
        support: number[];
        data: number[];
    };
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
    toCCDFSeries(asPercentages?: boolean): {
        support: number[];
        data: number[];
    };
    /** Probability of doing strictly more than threshold damage (default >0). */
    probDamageGreaterThan(threshold?: number): number;
    /** All outcome keys actually present (typed & ordered if you pass an order). */
    outcomeKeys(order?: OutcomeType[]): OutcomeType[];
    /** Total probability per outcome across the PMF. */
    outcomeTotals(outcomes?: OutcomeType[]): Map<OutcomeType, number>;
    /** Conditional damage range per outcome (min/avg/max of X | outcome). */
    outcomeDamageRanges(outcomes?: OutcomeType[]): Map<OutcomeType, {
        min: number;
        avg: number;
        max: number;
    }>;
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
    snapshot(order?: readonly OutcomeType[]): Snapshot;
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
    normalize(): DiceQuery;
    /**
     * Returns a new DiceQuery with low-probability outcomes removed.
     *
     * @param eps Minimum probability threshold (defaults to PMF epsilon)
     * @param keepFinalBin Whether to keep the highest damage bin regardless of probability
     * @returns New DiceQuery with compacted combined PMF
     */
    compact(eps?: number, keepFinalBin?: boolean): DiceQuery;
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
    addScaled(branch: DiceQuery, probability: number): DiceQuery;
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
    scaleMass(factor: number): DiceQuery;
    totalMass(): number;
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
    mapDamage(damageTransformFunction: (damageValue: number) => number): DiceQuery;
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
    scaleDamage(factor: number, rounding?: "floor" | "round" | "ceil"): DiceQuery;
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
    convolve(other: DiceQuery): DiceQuery;
    /**
     * First-success split over an ordered list of DISTINCT single-swing PMFs.
     * Each PMF may have different success/subset probabilities (from labels).
     *
     * successOutcome: e.g., ["success"] or ["hit", "crit"]
     * subsetOutcome:  e.g., ["subset"] or ["crit"] where subset ⊆ success
     *
     * Returns tuple: [pFirstNonSubset, pFirstSubset, pAnySuccess, pNone]
     */
    firstSuccessSplit(successOutcome: OutcomeType | OutcomeType[], subsetOutcome: OutcomeType | OutcomeType[], eps?: number): readonly [pSuccess: number, pSubset: number, pAny: number, pNone: number];
}
type OutcomeSnapshot = {
    atLeastOneProbability: number;
    allProbability: number;
    damageRange: {
        min: number;
        avg: number;
        max: number;
    };
};
type Snapshot = {
    averageDPR: number;
    damageChance: number;
    percentiles: {
        p25: number;
        p50: number;
        p75: number;
    };
    outcomes: Map<OutcomeType, OutcomeSnapshot>;
};

declare const pmfCache: LRUCache<string, PMF>;
/**
 * Probability Mass Function for discrete damage distributions.
 */
declare class PMF {
    readonly map: Map<number, Bin>;
    readonly epsilon: number;
    readonly normalized: boolean;
    readonly identifier: string;
    private _preservedProvenance;
    private static __anonIdCounter;
    private _support?;
    private _min?;
    private _max?;
    private _totalMass?;
    private _mean?;
    private _variance?;
    private _stdev?;
    private _fingerprint?;
    constructor(map?: Map<number, Bin>, epsilon?: number, normalized?: boolean, identifier?: string, _preservedProvenance?: boolean);
    static empty(epsilon?: number, identifier?: string): PMF;
    static zero(epsilon?: number): PMF;
    static delta(value: number, epsilon?: number): PMF;
    /**
     * Point mass at damage 0 tagged with the canonical `missNone` outcome.
     *
     * Differs from {@link PMF.zero}, which labels its zero bin `miss` — the
     * builder's attack-resolution vocabulary. This uses the `missNone`
     * {@link OutcomeType} that the attribution charts and outcome stats key on,
     * so it is the correct "clean miss / no damage" delta for provenance-aware
     * mixtures feeding those consumers.
     */
    static missNone(epsilon?: number): PMF;
    static emptyMass(): PMF;
    [Symbol.iterator](): IterableIterator<[number, Bin]>;
    static clearCache(): void;
    /**
     * Creates a conditional PMF from two branches (success and failure) and a probability.
     * This is the core logic for modeling any probabilistic event where there are two
     * distinct outcomes.
     */
    static branch(successPMF: PMF, failurePMF: PMF, successProbability: number): PMF;
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
    static withProbability(successPMF: PMF, probability: number): PMF;
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
    gate(p: number, fallback: PMF): PMF;
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
    static exclusive(options: Array<{
        pmf: PMF;
        weight: number;
    } | [PMF, number]>, eps?: number): PMF;
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
    static mix(options: Array<{
        pmf: PMF;
        weight: number;
    } | [PMF, number]>, eps?: number): PMF;
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
    hasAttribution(): boolean;
    withAttribution(): PMF;
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
    static mixN(weights: [number, PMF][], eps?: number): PMF;
    private setPreservedProvenance;
    preservedProvenance(): boolean;
    private getPowerCacheKey;
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
    power(n: number, eps?: number): PMF;
    replicate(n: number): PMF[];
    mass(): number;
    outcomeMass(outcome: string): number;
    faceTotal(): number;
    normalize(): PMF;
    /**
     * Returns a copy with negligible probabilities removed (p < eps).
     * If keepFinalBin is true, the bin with the largest key is always kept,
     * even if its probability is below eps. count/attr submaps are still cleaned.
     */
    compact(eps?: number, keepFinalBin?: boolean): PMF;
    support(): number[];
    min(): number;
    max(): number;
    /**
     * Returns the expected (mean) damage value.
     * Cached for performance since this requires iterating through all bins.
     */
    mean(): number;
    /**
     * Returns the variance of the damage distribution.
     * Cached for performance since this requires mean calculation plus iteration.
     */
    variance(): number;
    /**
     * Returns the standard deviation of the damage distribution.
     */
    stdev(): number;
    /** Deep-copies a Bin, cloning its count and (optional) attr maps. */
    private static cloneBin;
    /** Returns a new Bin with p, count, and attr all multiplied by `factor`. */
    private static scaleBin;
    private static mergeInto;
    add(other: PMF): PMF;
    /**
     * Returns a new PMF with a scaled branch added to this one.
     * The branch PMF is scaled by the given probability before merging
     * This will be very useful for conditional effects and for being
     * able to model "I can probably have this opportunity attack 40% of rounds"
     * Example: `pmf.addScaled(critBranch, 0.05)` → PMF including 5% crit outcomes
     */
    addScaled(branch: PMF, probability: number): PMF;
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
    applyHitFrequency(frequency: number): PMF;
    scaleMass(factor: number): PMF;
    mapDamage(damageTransformFunction: (damageValue: number) => number): PMF;
    scaleDamage(factor: number, rounding?: "floor" | "round" | "ceil"): PMF;
    private getPMFCombineCacheKey;
    /**
     * A small content fingerprint (mass + bin count + face sum) so convolution
     * cache keys change if the underlying numbers do. Memoized because a PMF is
     * immutable once constructed — this avoids re-summing every key on each
     * convolve() call (including cache hits).
     */
    fingerprint(): string;
    convolve(other: PMF, eps?: number, raw?: boolean): PMF;
    combineRaw(other: PMF, eps?: number): PMF;
    private static reduceConvolveLeft;
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
    static convolveMany(pmfList: PMF[], eps?: number): PMF;
    /**
     * Returns a plain, JSON-serializable representation of this PMF.
     *
     * Follows the standard `toJSON` contract, so `JSON.stringify(pmf)` produces
     * the expected output (no double-encoding). Use {@link PMF.fromJSON} to
     * reconstruct, or {@link PMF.toJSONString} if you need the string directly.
     */
    toJSON(): {
        bins: Array<[number, Bin]>;
        normalized: boolean;
        identifier: string;
    };
    /** Serializes this PMF to a JSON string (equivalent to `JSON.stringify(pmf)`). */
    toJSONString(): string;
    static fromJSON(jsonData: {
        bins: Array<[number, Bin]>;
        normalized?: boolean;
        identifier?: string;
    }): PMF;
    /**
     * Relative pruning with optional top-K floor.
     * Keeps bins with p >= epsRel * peak, always keeps min and max damage,
     * optionally guarantees at least `minBins` survivors by adding top-K.
     * Returns a new, non-normalized PMF.
     */
    prune(epsRel: number, minBins?: number): PMF;
    /** Probability mass at exactly x. */
    pAt(x: number): number;
    /**
     * P(any damage) — the mass on all non-zero outcomes, i.e. `1 - P(0)`.
     * Assumes a miss is encoded as the damage-0 bin (the convention used across
     * attack/save PMFs). The dual of {@link missProbability}.
     */
    hitProbability(): number;
    /** P(no damage) — the mass at damage 0. The dual of {@link hitProbability}. */
    missProbability(): number;
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
    rebin(maxBuckets: number): PMF;
    /** Dense integer support from min..max (inclusive).
     * Useful for showing empty bars in charts.
     */
    denseSupport(): number[];
    /** CDF at x: P(X ≤ x). */
    cdfAt(x: number): number;
    /** Quantile / inverse CDF for p in [0,1]. Returns smallest x with CDF ≥ p. */
    quantile(p: number): number;
    /** Get outcome probability at specific damage value. */
    outcomeAt(damage: number, outcome: string): number;
    /** Get all outcome types present in this PMF. */
    outcomes(): string[];
    /** Get total probability of an outcome across all damage values. */
    outcomeProbability(outcome: string): number;
    /** Get damage attribution for an outcome at specific damage value. */
    outcomeAttributionAt(damage: number, outcome: string): number;
    /** Get all outcome data at specific damage value. */
    binAt(damage: number): {
        p: number;
        count: Record<string, number>;
        attr?: Record<string, number>;
    } | null;
    /** Check if outcome exists in this PMF. */
    hasOutcome(outcome: string): boolean;
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
    attributionByValue(): Map<string, Map<number, number>>;
    tailProbGE(t: number): number;
    tailProbGT(t: number): number;
    /**
     * Returns a new PMF containing only bins where the specified outcome has non-zero probability.
     * This creates a marginal distribution for the given outcome type, with probabilities
     * scaled to represent the unconditional mass attributable to that outcome.
     */
    filterOutcome(outcome: string): PMF;
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
    static firstSuccessWeights(pSuccess: number, pSpecial: number, n: number): {
        pSpecificSuccess: number;
        pGeneralSuccess: number;
        pNone: number;
        pAny: number;
    };
    mapValues(f: (v: number) => number, eps?: number, opts?: {
        rounding?: Rounding;
        preserveCounts?: boolean;
    }): PMF;
    static fromMap(m: Map<number, number>, eps?: number, { requireIntegerValues }?: {
        requireIntegerValues?: boolean;
    }): PMF;
    query(): DiceQuery;
}

export { ALL_OUTCOME_TYPES as A, type Bin as B, type CritConfig as C, type DamageDistribution as D, EPS as E, LRUCache as L, MISS_NONE_OUTCOME as M, type OutcomeLabelMap as O, PMF as P, type Rounding as R, type Snapshot as S, type OutcomeType as a, type RollType as b, critProbability as c, OUTCOME_DISPLAY_ORDER as d, onCritOnly as e, onHitOnly as f, onMissOnly as g, onMissDamageOnly as h, onSaveHalfOnly as i, onSaveFailOnly as j, onPotentCantripOnly as k, DiceQuery as l, type OutcomeSnapshot as m, onAnyHit as o, pmfCache as p, sortOutcomes as s };
