import { b as RollType, P as PMF, l as DiceQuery, C as CritConfig, L as LRUCache } from '../pmf-D5VRghZI.cjs';

type RollFactory = {
    (count: number, sides?: number, modifier?: number): RollBuilder;
    (count: number, die: RollBuilder, modifier?: number): RollBuilder;
    d(sides: number | string): RollBuilder;
    hd20(): RollBuilder;
    d4(): RollBuilder;
    d6(): RollBuilder;
    d8(): RollBuilder;
    d10(): RollBuilder;
    d12(): RollBuilder;
    d20(): RollBuilder;
    d100(): RollBuilder;
    flat(n: number): RollBuilder;
};
type KeepMode = "highest" | "lowest";
type RollConfig = {
    count: number;
    sides: number;
    modifier: number;
    reroll: number;
    explode: number;
    minimum: number;
    bestOf: number;
    keep: {
        total: number;
        count: number;
        mode: KeepMode;
    } | undefined;
    rollType: RollType;
    isSubtraction?: boolean;
};
type Resolution = {
    pmf: PMF;
    check: PMF;
    weights: {
        [key: string]: number;
    };
};
type AttackResolution = Resolution & {
    hit: PMF;
    crit: PMF;
    miss: PMF;
    weights: {
        hit: number;
        crit: number;
        miss: number;
    };
};
type SaveResolution = Resolution & {
    saveFail: PMF;
    saveSuccess: PMF;
    weights: {
        success: number;
        fail: number;
    };
};
interface CheckBuilder {
    resolve(eps?: number): Resolution;
    toExpression(): string;
    readonly pmf: PMF;
}

type SaveOutcome = "normal" | "half";
declare class SaveBuilder implements CheckBuilder {
    readonly check: DCBuilder;
    private readonly failureEffect?;
    private readonly saveOutcome;
    constructor(check: DCBuilder, failureEffect?: RollBuilder | undefined, saveOutcome?: SaveOutcome);
    saveHalf(): SaveBuilder;
    toExpression(): string;
    resolve(eps?: number): SaveResolution;
    toPMF(eps?: number): PMF;
    get pmf(): PMF;
    toQuery(eps?: number): DiceQuery;
}

interface SaveConfig {
    dc: number;
}
declare class DCBuilder extends RollBuilder {
    private readonly saveConfig;
    constructor(baseRoll: RollBuilder, saveConfig?: SaveConfig);
    dc(saveDC: number): DCBuilder;
    get saveDC(): number;
    add(anotherRoll: RollBuilder): DCBuilder;
    addRoll(count?: number): DCBuilder;
    onSaveFailure(val: number): SaveBuilder;
    onSaveFailure(val: string): SaveBuilder;
    onSaveFailure(val: RollBuilder): SaveBuilder;
    onSaveFailure(count: number, die: RollBuilder): SaveBuilder;
    onSaveFailure(count: number, sides: number): SaveBuilder;
    onSaveFailure(count: number, die: RollBuilder, modifier: number): SaveBuilder;
    onSaveFailure(count: number, sides: number, modifier: number): SaveBuilder;
    withElvenAccuracy(): never;
    toExpression(): string;
    toPMF(eps?: number): PMF;
}

type ExpressionNode = DieNode | ConstantNode | SumNode | AddNode | KeepNode | D20RollNode | HalfNode | MaxOfNode | ScaleNode;
type DieNode = {
    type: "die";
    sides: number;
    reroll?: number;
    minimum?: number;
    explode?: number;
};
type ConstantNode = {
    type: "constant";
    value: number;
};
type SumNode = {
    type: "sum";
    count: number;
    child: ExpressionNode;
};
type AddNode = {
    type: "add";
    children: {
        node: ExpressionNode;
        sign: 1 | -1;
    }[];
};
type KeepNode = {
    type: "keep";
    mode: "highest" | "lowest";
    count: number;
    child: SumNode | KeepNode;
};
type D20RollNode = {
    type: "d20Roll";
    rollType: "advantage" | "disadvantage" | "elven accuracy";
    child: ExpressionNode;
};
type HalfNode = {
    type: "half";
    child: ExpressionNode;
};
type MaxOfNode = {
    type: "maxOf";
    count: number;
    child: ExpressionNode;
};
/**
 * Scale the child's result by `numerator / denominator`, then round.
 *
 * Unlike {@link HalfNode} (a fixed `// 2` with floor), this is a general, composable
 * multiplier/divider — the building block for damage-type resistance (`1/2`, floor),
 * vulnerability (`2/1`), and similar per-source transforms. It renders as
 * `N * (child)` when the denominator is 1, `(child) // D` when the numerator is 1,
 * and `(child) * N // D` otherwise.
 */
type ScaleNode = {
    type: "scale";
    numerator: number;
    denominator: number;
    rounding: "floor" | "round" | "ceil";
    child: ExpressionNode;
};

declare const defaultConfig: RollConfig;
declare class RollBuilder {
    protected readonly subRollConfigs: readonly RollConfig[];
    constructor(countOrConfigs?: number | readonly RollConfig[]);
    protected create(configs: readonly RollConfig[]): RollBuilder;
    protected get lastConfig(): RollConfig;
    hasHiddenState(): boolean;
    getSubRollConfigs(): readonly RollConfig[];
    static fromConfig(config: Partial<RollConfig>): RollBuilder;
    static fromConfigs(configs: Partial<RollConfig>[]): RollBuilder;
    static fromArgs(...args: any[]): RollBuilder;
    d(sides: number | undefined): RollBuilder;
    plus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
    plus(count: number, die: RollBuilder): RollBuilder;
    minus(modOrRoll: number | RollBuilder | undefined): RollBuilder;
    minus(count: number, die: RollBuilder): RollBuilder;
    /** Apply one-pass reroll threshold (k): reroll faces 1..k once, must keep. */
    reroll(value: number): RollBuilder;
    /** Set finite explode count for max-face explosions (Infinity allowed). */
    explode(count?: number | undefined): RollBuilder;
    /** Apply per-die minimum value (min > 0). */
    minimum(val: number | undefined): RollBuilder;
    bestOf(count: number | undefined): RollBuilder;
    keepHighest(total: number, count: number): RollBuilder;
    keepLowest(total: number, count: number): RollBuilder;
    keepHighestAll(total: number, count: number): PooledRollBuilder;
    keepLowestAll(total: number, count: number): PooledRollBuilder;
    withAdvantage(): RollBuilder;
    withDisadvantage(): RollBuilder;
    add(anotherRoll: RollBuilder | undefined): RollBuilder;
    withBonus(anotherRoll: RollBuilder): RollBuilder;
    addRoll(count?: number): RollBuilder;
    scaleDice(scale: number): RollBuilder;
    doubleDice(): RollBuilder;
    alwaysHits(): AlwaysHitBuilder;
    alwaysCrits(): AlwaysCritBuilder;
    copy(): RollBuilder;
    d4: () => RollBuilder;
    d6: () => RollBuilder;
    d8: () => RollBuilder;
    d10: () => RollBuilder;
    d12: () => RollBuilder;
    d20: () => RollBuilder;
    d100: () => RollBuilder;
    withElvenAccuracy(): RollBuilder;
    toExpression(): string;
    toPMF(eps?: number): PMF;
    get pmf(): PMF;
    toQuery(eps?: number): DiceQuery;
    toAST(): ExpressionNode;
    private configToSingleExpressionWithoutModifier;
    getRootDieConfig(): RollConfig | undefined;
    getAllDieConfigs(): readonly RollConfig[];
    getBonusDiceConfigs(): RollConfig[];
    getBonusDicePMFs(check: RollBuilder, eps?: number): PMF[];
    get modifier(): number;
    get rollType(): RollType;
    get baseReroll(): number;
    half(): HalfRollBuilder;
    /**
     * Scale this roll's result by `numerator / denominator`, rounding each outcome.
     * A general, composable form of {@link half} — used to model damage-type resistance
     * (`scaleResult(1, 2)` → `(expr) // 2`) and vulnerability (`scaleResult(2)` → `2 * (expr)`).
     * Compose several of these (and plain rolls) into one payload with {@link sumRolls}.
     */
    scaleResult(numerator: number, denominator?: number, rounding?: "floor" | "round" | "ceil"): ScaleRollBuilder;
    maxOf(count: number): MaxOfRollBuilder;
    ac(_targetAC: number): ACBuilder;
    dc(_saveDC: number): DCBuilder;
}
declare class HalfRollBuilder extends RollBuilder {
    private readonly innerRoll;
    constructor(innerRoll: RollBuilder);
    hasHiddenState(): boolean;
    get lastConfig(): RollConfig;
    getSubRollConfigs(): readonly RollConfig[];
    toExpression(): string;
    toAST(): ExpressionNode;
    toPMF(eps?: number): PMF;
    copy(): HalfRollBuilder;
}
/**
 * A roll whose result is scaled by `numerator / denominator` and rounded — the composable
 * generalization of {@link HalfRollBuilder}. Renders as `N * (inner)`, `(inner) // D`, or
 * `(inner) * N // D`. Terminal (like `half`): use {@link sumRolls} to combine with other rolls.
 */
declare class ScaleRollBuilder extends RollBuilder {
    private readonly innerRoll;
    private readonly numerator;
    private readonly denominator;
    private readonly rounding;
    constructor(innerRoll: RollBuilder, numerator: number, denominator?: number, rounding?: "floor" | "round" | "ceil");
    hasHiddenState(): boolean;
    get lastConfig(): RollConfig;
    getSubRollConfigs(): readonly RollConfig[];
    toExpression(): string;
    toAST(): ExpressionNode;
    toPMF(eps?: number): PMF;
    copy(): ScaleRollBuilder;
}
declare class MaxOfRollBuilder extends RollBuilder {
    private readonly innerRoll;
    private readonly count;
    private readonly diceCount?;
    private readonly diceSides?;
    constructor(innerRoll: RollBuilder, count: number, diceCount?: number | undefined, diceSides?: number | undefined);
    hasHiddenState(): boolean;
    get lastConfig(): RollConfig;
    getSubRollConfigs(): readonly RollConfig[];
    toExpression(): string;
    toAST(): ExpressionNode;
    toPMF(eps?: number): PMF;
    copy(): MaxOfRollBuilder;
}
declare class AlwaysHitBuilder extends RollBuilder {
    readonly attackConfig: CritConfig;
    constructor(baseRoll: RollBuilder, attackConfig?: CritConfig);
    protected create(configs: readonly RollConfig[]): RollBuilder;
    onHit(val: number): AttackBuilder;
    onHit(val: string): AttackBuilder;
    onHit(val: RollBuilder): AttackBuilder;
    onHit(count: number, die: RollBuilder): AttackBuilder;
    onHit(count: number, sides: number): AttackBuilder;
    onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
    onHit(count: number, sides: number, modifier: number): AttackBuilder;
    get critThreshold(): number;
    critOn(critThreshold: number): AlwaysHitBuilder;
    alwaysCrits(): AlwaysCritBuilder;
    toExpression(): string;
    toPMF(): PMF;
    copy(): AlwaysHitBuilder;
}
declare class AlwaysCritBuilder extends RollBuilder {
    readonly attackConfig: CritConfig & {
        ac?: number;
    };
    readonly fromAlwaysHit: boolean;
    constructor(baseRoll: RollBuilder, attackConfig?: CritConfig & {
        ac?: number;
    }, fromAlwaysHit?: boolean);
    protected create(configs: readonly RollConfig[]): RollBuilder;
    onHit(val: number): AttackBuilder;
    onHit(val: string): AttackBuilder;
    onHit(val: RollBuilder): AttackBuilder;
    onHit(count: number, die: RollBuilder): AttackBuilder;
    onHit(count: number, sides: number): AttackBuilder;
    onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
    onHit(count: number, sides: number, modifier: number): AttackBuilder;
    get critThreshold(): number;
    critOn(critThreshold: number): AlwaysCritBuilder;
    toExpression(): string;
    toPMF(): PMF;
    copy(): AlwaysCritBuilder;
}
declare class ParsedRollBuilder extends RollBuilder {
    private readonly cachedPMF;
    private readonly originalExpression;
    constructor(expression: string);
    hasHiddenState(): boolean;
    protected create(configs: readonly RollConfig[]): RollBuilder;
    toPMF(_eps?: number): PMF;
    toExpression(): string;
    toAST(): ExpressionNode;
    copy(): ParsedRollBuilder;
    doubleDice(): ParsedRollBuilder;
}
declare class PooledRollBuilder extends RollBuilder {
    private readonly baseAST;
    private readonly baseExpression;
    constructor(baseAST: ExpressionNode, baseExpression: string, configs?: readonly RollConfig[]);
    protected create(configs: readonly RollConfig[]): PooledRollBuilder;
    hasHiddenState(): boolean;
    d(_sides: number | undefined): RollBuilder;
    reroll(_value: number): RollBuilder;
    explode(_count?: number | undefined): RollBuilder;
    minimum(_val: number | undefined): RollBuilder;
    bestOf(_count: number | undefined): RollBuilder;
    keepHighest(_total: number, _count: number): RollBuilder;
    keepLowest(_total: number, _count: number): RollBuilder;
    withAdvantage(): RollBuilder;
    withDisadvantage(): RollBuilder;
    withElvenAccuracy(): RollBuilder;
    toAST(): ExpressionNode;
    toExpression(): string;
    copy(): PooledRollBuilder;
    scaleDice(scale: number): RollBuilder;
    times(count: number): PooledRollBuilder;
}
/**
 * Combine several rolls into one additive payload whose PMF is their convolution and whose
 * expression is them joined with ` + `. Unlike `a.plus(b)`, this preserves parts that carry
 * hidden state (e.g. `roll.scaleResult(1, 2)` / `roll.half()`), so per-damage-type resistance
 * and vulnerability survive into both the distribution and the rendered expression.
 * Empty parts collapse to `0`; a single part is returned unwrapped.
 */
declare function sumRolls(parts: readonly RollBuilder[]): RollBuilder;

type ActionEffect = RollBuilder;
declare class AttackBuilder implements CheckBuilder {
    readonly check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder;
    private readonly hitEffect?;
    private readonly critEffect?;
    private readonly missEffect?;
    constructor(check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder, hitEffect?: ActionEffect | undefined, critEffect?: (ActionEffect | null) | undefined, missEffect?: ActionEffect | undefined);
    onCrit(val: number): AttackBuilder;
    onCrit(val: string): AttackBuilder;
    onCrit(val: RollBuilder): AttackBuilder;
    onCrit(count: number, die: RollBuilder): AttackBuilder;
    onCrit(count: number, sides: number): AttackBuilder;
    onCrit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
    onCrit(count: number, sides: number, modifier: number): AttackBuilder;
    onMiss(val: number): AttackBuilder;
    onMiss(val: string): AttackBuilder;
    onMiss(val: RollBuilder): AttackBuilder;
    onMiss(count: number, die: RollBuilder): AttackBuilder;
    onMiss(count: number, sides: number): AttackBuilder;
    onMiss(count: number, die: RollBuilder, modifier: number): AttackBuilder;
    onMiss(count: number, sides: number, modifier: number): AttackBuilder;
    noCrit(): AttackBuilder;
    toExpression(): string;
    resolveProbabilities(check: ACBuilder | AlwaysHitBuilder | AlwaysCritBuilder, eps?: number): {
        pSuccess: number;
        pHit: number;
        pCrit: number;
        pMiss: number;
    };
    resolve(eps?: number): AttackResolution;
    toPMF(eps?: number): PMF;
    get pmf(): PMF;
    toQuery(eps?: number): DiceQuery;
}

interface AttackConfig {
    ac: number;
    critThreshold: number;
}
declare class ACBuilder extends RollBuilder {
    readonly attackConfig: AttackConfig;
    constructor(baseRoll: RollBuilder, ac: number, attackConfig?: AttackConfig);
    onHit(val: number): AttackBuilder;
    onHit(val: string): AttackBuilder;
    onHit(val: RollBuilder): AttackBuilder;
    onHit(count: number, die: RollBuilder): AttackBuilder;
    onHit(count: number, sides: number): AttackBuilder;
    onHit(count: number, die: RollBuilder, modifier: number): AttackBuilder;
    onHit(count: number, sides: number, modifier: number): AttackBuilder;
    get critThreshold(): number;
    critOn(threshold: number): ACBuilder;
    alwaysCrits(): AlwaysCritBuilder;
    toExpression(): string;
    toPMF(eps?: number): PMF;
    copy(): ACBuilder;
}

declare function d(sides: number | string): RollBuilder;
declare const d4: RollBuilder;
declare const d6: RollBuilder;
declare const d8: RollBuilder;
declare const d10: RollBuilder;
declare const d12: RollBuilder;
declare const d20: RollBuilder;
declare const hd20: RollBuilder;
declare const d100: RollBuilder;
declare const flat: (n: number) => RollBuilder;
declare const roll: RollFactory;
declare const builderPMFCache: LRUCache<string, PMF>;

export { ACBuilder, AlwaysCritBuilder, AlwaysHitBuilder, AttackBuilder, type AttackConfig, type AttackResolution, type CheckBuilder, DCBuilder, HalfRollBuilder, type KeepMode, MaxOfRollBuilder, ParsedRollBuilder, PooledRollBuilder, type Resolution, RollBuilder, type RollConfig, type RollFactory, RollType, SaveBuilder, type SaveOutcome, type SaveResolution, ScaleRollBuilder, builderPMFCache, d, d10, d100, d12, d20, d4, d6, d8, defaultConfig, flat, hd20, roll, sumRolls };
