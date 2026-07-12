import { P as PMF } from './pmf-D5VRghZI.cjs';
export { A as ALL_OUTCOME_TYPES, B as Bin, C as CritConfig, D as DamageDistribution, l as DiceQuery, E as EPS, L as LRUCache, M as MISS_NONE_OUTCOME, d as OUTCOME_DISPLAY_ORDER, O as OutcomeLabelMap, m as OutcomeSnapshot, a as OutcomeType, b as RollType, R as Rounding, S as Snapshot, c as critProbability, o as onAnyHit, e as onCritOnly, f as onHitOnly, h as onMissDamageOnly, g as onMissOnly, k as onPotentCantripOnly, j as onSaveFailOnly, i as onSaveHalfOnly, p as pmfCache, s as sortOutcomes } from './pmf-D5VRghZI.cjs';

/**
 * Bounce odds — the "birthday problem" for bouncing damage dice (e.g. Chromatic
 * Orb): the probability that at least two of K dice with S faces show the same
 * value, which is what lets the spell jump to another target.
 *
 * Accounts for two modifiers:
 * - **Elemental Adept** (`minimumDieRoll >= 2`): rolls below the minimum are
 *   bumped up to it, collapsing the low faces onto a single heavier value.
 * - **Empowered Spell** (`rerollDamageDice > 0`): a number of dice may be
 *   rerolled once, giving a second chance at a match.
 *
 * The base and Elemental-Adept cases are computed exactly (see
 * {@link pAllDistinct}); the Empowered-Spell reroll is an explicit model layered
 * on the exact base match probability.
 */
/** Options that modify bounce odds via metamagic / feats. */
interface BounceOddsOptions {
    /** Minimum die roll — e.g. 2 for Elemental Adept, 3 for Great Weapon Fighting 2024. */
    minimumDieRoll?: number;
    /** Number of dice that may be rerolled once — e.g. CHA modifier for Empowered Spell. */
    rerollDamageDice?: number;
}
/**
 * P(at least two of `diceCount` dice with `dieFaces` faces match), honoring
 * Elemental Adept and Empowered Spell. Returns a probability in [0, 1].
 *
 * @param diceCount Number of dice rolled.
 * @param dieFaces Faces per die (e.g. 8 for d8).
 * @param options Optional metamagic / feat modifiers.
 */
declare function calculateBounceOdds(diceCount: number, dieFaces: number, options?: BounceOddsOptions): number;

/**
 * Error thrown when a dice expression cannot be parsed.
 *
 * Extends the built-in {@link Error}, so existing `catch (e)` / message checks
 * continue to work, while callers can now narrow with `instanceof DiceParseError`.
 *
 * @example
 * try {
 *   parse("d6@3");
 * } catch (e) {
 *   if (e instanceof DiceParseError) {
 *     // e.expression === "d6@3"
 *   }
 * }
 */
declare class DiceParseError extends Error {
    /** The original expression that failed to parse, when available. */
    readonly expression?: string;
    /** The underlying error that triggered this one, when available. */
    readonly cause?: unknown;
    constructor(message: string, options?: {
        expression?: string;
        cause?: unknown;
    });
}

/** Enable or disable the internal parse cache. */
declare function setCachingEnabled(enabled: boolean): void;
/** Returns whether the internal parse cache is currently enabled. */
declare function getCachingEnabled(): boolean;
/** Clears the internal parse cache. */
declare function clearParserCache(): void;
/**
 * Parse a dice expression into a PMF.
 *
 * - Expression is case-insensitive and ignores spaces.
 */
declare function parse(expression: string, n?: number): PMF;

/** A labeled mixture builder that preserves provenance in Bin.count. */
declare class Mixture<L extends string = string> {
    private readonly totals;
    private readonly labelMass;
    private readonly eps;
    constructor(eps?: number);
    /** Remove all accumulated state. */
    clear(): this;
    /** Number of distinct outcome values currently accumulated. */
    size(): number;
    /** Whether a label was ever added. */
    hasLabel(label: L): boolean;
    /**
     * Add a labeled component with a mixture weight.
     * Weight can be any positive finite number. Very small contributions are pruned by eps.
     */
    add(label: L, pmf: PMF, weight?: number): this;
    buildPMF(eps?: number): PMF;
    /**
     * Produce normalized *per-label* PMFs (labels independent).
     * These are unlabeled PMFs built from the raw mass of that label alone.
     */
    byOutcome(): Record<L, PMF>;
    /**
     * Mixture weights per label, normalized to sum to 1 over labels that appeared.
     * Uses raw mass before per-outcome normalization.
     */
    weights(): Record<L, number>;
    toJSON(): {
        totals: Array<[number, number]>;
        labels: Array<[number, Record<L, number>]>;
        eps: number;
    };
    static mix<L extends string = string>(items: Array<[label: L, pmf: PMF, weight: number]>, eps?: number): PMF;
}

export { type BounceOddsOptions, DiceParseError, Mixture, PMF, calculateBounceOdds, clearParserCache, getCachingEnabled, parse, setCachingEnabled };
