// Brute-force reference oracle, shared with the yipe/dpr repository (packages/ddb-testing/src/oracle/bruteForce.ts).
/**
 * Brute-force enumerator for small synthetic turns — the project-1 oracle.
 *
 * Enumerates the JOINT outcome space of a small turn exactly (every d20 face, every damage-die
 * face), with no dependency on `@yipe/dice`. It is deliberately dumb and exhaustive: the dice
 * library and today's engine are the things under test, so the oracle must not share their math.
 * It exists so project 2's `Turn`/`compileTurn` path is checked against ground truth rather than
 * against itself.
 *
 * Probabilities are accumulated as doubles. On these small turns (a few thousand joint outcomes,
 * each a product of fractions with denominators ≤ 8000) the accumulated error stays well under
 * 1e-13, so a 1e-12 comparison gate is comfortable.
 */

/** How a d20 attack roll resolves. */
export type AdvantageKind = 'flat' | 'advantage' | 'disadvantage' | 'elven'

/** A resolved per-type multiplier `num / den`, rounded down unless `round` says `ceil` (P3-R15). */
export interface DamageScaleSpec {
  num: number
  den: number
  round?: 'floor' | 'ceil'
}

/**
 * How a dice group's faces are read: a floor under every die, a mandatory first reroll of the low faces (the 2014
 * Great Weapon Fighting), and the reroll budget of Piercer and Empowered Spell (phase 2a cards A12 and A12b).
 *
 * `rerollDice` is the budget and marks the part's dice as reroll-eligible: RAW, the roller rolls every die of the
 * attack, SEES them, may reroll up to that many of the eligible ones and must keep each new roll ("reroll one of the
 * attack's damage dice, and you must use the new roll"; "reroll a number of the damage dice up to your Charisma
 * modifier"). Every part that carries `rerollDice` is one pool with the smallest budget among them, on the dice of the
 * roll being scored (a crit doubles the dice, not the budget); a part without it is rolled once beside the pool and
 * never rerolled. The policy is the damage-maximising one, found here by trying every subset of up to that many dice
 * (see {@link poolDistribution}). A rerolled die is a fresh roll of the same die under its own `rerollBelow` and
 * `minimumDie`.
 */
export interface DieRules {
  /** Each die reads as at least this face (Elemental Adept's 2, the 2024 Great Weapon Fighting 3). */
  minimumDie?: number
  /** A die that shows this face or lower is rerolled once, and the new roll stands (the 2014 Great Weapon Fighting). */
  rerollBelow?: number
  rerollDice?: number
}

/**
 * One typed part of a payload: dice plus a flat, of one damage type, optionally scaled by the enemy. With the
 * payload's `bestOfTwo`, a part is one of the weapon's dice unless it is `outsidePool`.
 */
export interface PartSpec extends DieRules {
  count: number
  sides: number
  flat?: number
  type?: string
  scale?: DamageScaleSpec
  /** Rolled once beside a best-of-two pool (a bonus die), not one of the weapon's dice. */
  outsidePool?: boolean
  /**
   * What makes the part land (the engine's `DamageTrigger`, default `roll`): `roll` is the action's own damage or a
   * modifier of its roll, `hit` a rider that lands on a hit or crit ("when you hit"), `damage` one that lands on
   * anything that deals damage, `cast` one that lands whenever the row happens. Only a half on a miss reads it: it halves the `roll` parts and the payload's untyped
   * dice and no rider, since a miss lands none.
   */
  trigger?: 'roll' | 'hit' | 'damage' | 'cast'
}

/**
 * A damage payload: `count`d`sides` dice plus an optional flat bonus, plus any typed `parts`. The dice
 * above are untyped and never scaled. Parts are grouped by type; every part of one type carries the same
 * `scale`, applied once to the type's total (the 5e rule, P3-R12). A crit doubles every part's dice
 * before the scale. With `floorAtZero`, the payload's total never goes below 0 (phase 2a card A5). The
 * untyped dice and each part read their faces by their own {@link DieRules}.
 *
 * With `bestOfTwo` (Savage Attacker, phase 2a card A11) the payload's dice roll twice as ONE pool and the
 * kept roll is the one with the higher total after each type's scale, the damage the target takes. The
 * pool is the main dice and every part that is not `outsidePool`, every type together; flats stay in both
 * rolls, and the outside parts are rolled once and shared by both. A crit doubles the pool's dice before
 * it rolls twice.
 */
export interface DiceSpec extends DieRules {
  count: number
  sides: number
  flat?: number
  parts?: readonly PartSpec[]
  floorAtZero?: boolean
  bestOfTwo?: boolean
}

/**
 * Damage on a miss (phase 2a cards A4, A8): a flat amount, a dice pool, half of a dice pool, or half of
 * the hit payload. A miss that deals damage is still a miss: it is labelled `missDamage` and never lands.
 * A flat amount takes the enemy's multiplier as a whole: `floor(amount x num / den)`, the same result as
 * `scaleResult` on the flat (card A8). A pool carries its scale on its typed parts. Half of the hit payload's own
 * damage (`halfOnMiss`, Potent Cantrip: the untyped dice and every part whose trigger is `roll`, never a rider, which
 * a miss does not land) halves before the enemy's doubling like a successful save: each doubled group is halved and
 * then doubled, the rest halved once, and a payload with no doubled group is `floor(total / 2)`.
 */
export type MissSpec =
  | { kind: 'flat'; amount: number; scale?: DamageScaleSpec }
  | { kind: 'dice'; damage: DiceSpec }
  | { kind: 'halfOfPool'; damage: DiceSpec }
  | { kind: 'halfOnMiss' }

/** An independent attack row. */
export interface AttackSpec {
  toHit: number
  ac: number
  /** Natural d20 face at or above which a hit is a crit (default 20). */
  critRange: number
  advantage: AdvantageKind
  damage: DiceSpec
  /** Explicit crit payload; default doubles `damage`'s dice, flat unchanged. */
  critDamage?: DiceSpec
  /**
   * Max + roll (analyze's `critDiceDealMax`, phase 2a card A9): a crit rolls each part's dice once and adds
   * that part's max faces, inside the part's own type group and so inside that group's scale. An immune
   * group therefore adds nothing. Ignored when `critDamage` is set.
   */
  critDealsMax?: boolean
  /** Every hit is a crit (`alwaysCrits`); a natural 1 still misses. */
  autoCrit?: boolean
  /** Each d20 rerolls a natural 1 once and keeps the new roll (Halfling Luck, `reroll(1)`). */
  rerollOnes?: boolean
  missDamage?: MissSpec
  /**
   * The probability the attack happens at all (default 1), the frequency or AoE fraction `@yipe/dice` spells
   * `attack(source, { chance })`. An attack that does not happen deals nothing, is not a miss and is not a landing,
   * so a rider never sees it and a skipped attack never spends a rider's application.
   */
  chance?: number
  /** Whether the attack is melee or ranged (default melee); conditions read it (paralyzed crits only in melee, prone reads it). */
  range?: 'melee' | 'ranged'
  /** The creature the attack targets (default 0, the primary target); grants and conditions live on one creature. */
  target?: number
  /** Every roll hits, a natural 1 included. A face at or above `critRange` still crits, and `autoCrit` crits every roll. */
  autoHit?: boolean
  /** Replaces `advantage` and every advantage or disadvantage a condition or grant would add. */
  rollOverride?: AdvantageKind
  /**
   * The attacker has Elven Accuracy: an advantage a condition or grant puts on this attack rolls three dice, the way the
   * engine writes `advantageValue` (2 for a character with the feat, 1 without) whenever it grants advantage to a row.
   * It does not turn a plain `advantage` base into three dice on its own, and a `rollOverride` replaces it like the rest.
   */
  elvenAccuracy?: boolean
}

/**
 * A save row: the target rolls d20 + `saveBonus` against `dc`. On a success with `onSuccess: 'half'` the target takes
 * half the damage. When any part is scaled up (x2: vulnerable) the success halves BEFORE the doubling (a successful
 * saving throw halves before doubling): each doubled type group is halved on its own and then
 * doubled, `2 x floor(g / 2)`, and every other group (x1, x1/2, x0, untyped) keeps its own scale, with their sum
 * halved once, `floor(S / 2)`. A payload with no doubled group keeps `floor(total / 2)`, the resisted and immune
 * rows included.
 */
export interface SaveSpec {
  dc: number
  saveBonus: number
  /** How the target rolls its save (default a plain d20). */
  rollType?: 'flat' | 'advantage' | 'disadvantage'
  onSuccess: 'half' | 'none'
  /** Full damage on a failed save. */
  damage: DiceSpec
  /** The probability the save happens at all (default 1): the AoE fraction. A save that does not happen deals nothing and is not a landing. */
  chance?: number
  /**
   * The save happens only where source `source` (an earlier one, by source index) landed for `trigger` (Poisoner's dose:
   * the parent's `damage`), the engine's parent-hit gate. Where it did not, the save deals nothing and is not a landing.
   */
  gatedOn?: { source: number; trigger: LandingTrigger }
  /** The save's ability; conditions read it (paralyzed and stunned fail strength and dexterity saves, restrained gives dexterity saves disadvantage). */
  ability?: SaveAbilityName
  /** The creature that rolls the save (default 0, the primary target). */
  target?: number
  /** The target always fails: no d20 is rolled. */
  autoFail?: boolean
  /** Replaces `rollType` and every disadvantage a condition or grant would add. */
  rollOverride?: 'flat' | 'advantage' | 'disadvantage'
}

/** A frequency (occurrence) row: a full attack that happens with probability `frequency`. */
export interface FrequencyRowSpec {
  frequency: number
  attack: AttackSpec
}

/** A row that fires once (crit mode) if any watched attack crits. */
export interface OnCritRowSpec {
  of: readonly number[]
  damage: DiceSpec
}

/**
 * What a trigger's wording lands on:
 * - `hit` (an "on hit" trigger: Hex, Hunter's Mark, Sneak Attack, a smite) reads the outcome's label: it lands on an
 *   attack's hit or crit, whatever the hit deals (a fully immune hit still lands). Never on a save row, and never on an
 *   attack that misses, whatever the miss deals (Graze, half on a miss, miss dice).
 * - `damage` (a "when you deal damage to it" trigger: Radiant Soul, Celestial Revelation) lands on a hit, a crit, a
 *   failed save and a save-for-half success that actually deal damage, more than 0 after the enemy's scale and any
 *   halving. Resistance, immunity and a halved 1 can reduce damage to 0, and then none was dealt. A save that deals
 *   nothing on a success does not land there, and a miss that deals damage is still a miss (`missDamage`, which no
 *   trigger lands on yet).
 * - `cast` (a "whenever you start casting" or "when you make an attack roll" trigger: Heart of the Storm, Power from
 *   Pain) waits for neither a hit nor damage: it lands on every outcome of a source that happens, a miss included, and
 *   on none of a source that does not (its `chance`). It is dealt in the hit mode, since a crit doubles only the
 *   dice of the attack itself.
 */
export type LandingTrigger = 'hit' | 'damage' | 'cast'

/**
 * How a source resolved, for the triggers that read it: an attack's `hit` or `crit`, a save's `saveFail` or
 * `saveHalf` (success on a half save: `@yipe/dice`'s `saveHalf` label), `missDamage` (a miss that deals its miss
 * payload), `none` (a miss with no payload, a success on a `none` save), or `skipped` (a source that did not happen).
 */
export type Landing = 'none' | 'hit' | 'crit' | 'saveFail' | 'saveHalf' | 'missDamage' | 'skipped'

/**
 * Whether a source that resolved as `landing`, dealing damage (more than 0) or not (`dealt`), is a landing for
 * `trigger` ({@link LandingTrigger}). Teaching a trigger to land on a `missDamage` outcome is one line here.
 */
export function landsOn(landing: Landing, dealt: boolean, trigger: LandingTrigger): boolean {
  if (trigger === 'cast') return landing !== 'skipped'
  if (trigger === 'hit') return landing === 'hit' || landing === 'crit'
  return dealt && (landing === 'hit' || landing === 'crit' || landing === 'saveFail' || landing === 'saveHalf')
}

/**
 * A rider: damage that applies on the landings among `of`, in turn order, at most `max` times. `of` indexes the turn's
 * sources: its attacks, then its saves (`attacks.length + k` is save `k`). Each application is in its landing's
 * mode: a crit doubles the rider's dice, and only an attack crits.
 *
 * - `max` is the number of applications, N >= 1. The default 1 is a first-hit rider (Sneak Attack); N applies to the
 *   first N landings (superiority dice, a capped every-hit); `Infinity` applies to every landing (Hunter's Mark).
 * - `damage` is the payload, or a function of the landing row when the rider's damage type, and so the enemy's scale
 *   for it, depends on which row landed. The payload may carry several typed groups, each scaled once.
 * - `chance` is the probability the rider happens at all this turn (default 1): a frequency on the rider row. It
 *   is one coin for the whole rider, not one per landing, so a rider that did not happen applies to none of them.
 */
export interface RiderSpec {
  of: readonly number[]
  trigger: LandingTrigger
  damage: DiceSpec | ((row: number) => DiceSpec)
  max?: number
  chance?: number
  /**
   * An On Crit rider (Divine Smite held for a crit): it lands only on a crit that also lands for `trigger`, in crit mode whatever
   * the trigger. A crit that deals nothing does not land a `damage` trigger, so it does not spend the rider either.
   */
  onCrit?: boolean
  /**
   * The rows (sources, a subset of `of`) whose own damage roll the rider's dice are part of: Piercer's "reroll one of the attack's
   * damage dice" reaches a Sneak Attack die, because Sneak Attack's dice are damage dice of the attack that hit. On such a landing
   * the rider's dice are rolled with the row's, doubled by a crit as the row's are, and every part of theirs joins the row's reroll
   * pool (the row's smallest budget, `rerollDice`, is theirs too); the rider deals nothing of its own there and is counted as a
   * landing all the same. The rider's `chance` thins the dice that join. The row must be an attack with no explicit `critDamage`, and
   * the rider's trigger must not be `cast` (a cast lands on a miss, which has no damage roll to join). Where the rider lands on a
   * row it is not pooled on, it is damage of its own as always.
   */
  pooledOn?: readonly number[]
  /**
   * Where the rider lands only alongside another rider: each partner (`rider`, an index into the turn's riders, not alongside a partner
   * itself, happening on every turn) with the sources (a subset of both riders' `of`) it opens, where the rider lands only if that
   * partner applies on the same source. Spellfire Adept's flare adds to a spell's radiant damage; on a weapon attack that radiant is a
   * smite's, a rider of its own, so the flare lands there only where the smite does. The rider lands once (`max` 1).
   */
  alongside?: ReadonlyArray<{ rider: number; sources: readonly number[] }>
}

/**
 * A row that happens once, on the first landing among `of` (the same source indexes as {@link RiderSpec}) for its
 * `trigger`, whatever that landing's mode (phase 2a card P1). Exactly one of: `damage`, dealt as-is with no roll of its
 * own (Wails from the Grave, the Green-Flame Blade leap: a parent's crit does not double it); `attack` or `save`, a check
 * of its own that decides its hit and crit (Poisoner's save).
 */
export interface DependentSpec {
  of: readonly number[]
  trigger: LandingTrigger
  damage?: DiceSpec
  attack?: AttackSpec
  save?: SaveSpec
}

/** One beam of a bounce chain. Beam 0 always fires; beam N fires iff its parent fired, landed,
 *  and its parent's own damage dice showed a repeat (crit doubles the match pool). */
export interface BeamSpec {
  toHit: number
  ac: number
  critRange: number
  advantage: AdvantageKind
  damage: DiceSpec
}

/**
 * `attacks` and `saves` are the turn's sources, indexed attacks first, then saves (`attacks.length + k` is save `k`).
 * `order` is their turn order, a permutation of those indexes (default: the attacks in order, then the saves): a rider
 * takes the landings among the rows it watches in turn order, so it decides which landing is first and in which mode.
 */
export interface SyntheticTurn {
  attacks: readonly AttackSpec[]
  saves?: readonly SaveSpec[]
  order?: readonly number[]
  frequencyRows?: readonly FrequencyRowSpec[]
  onCritRows?: readonly OnCritRowSpec[]
  riders?: readonly RiderSpec[]
  dependents?: readonly DependentSpec[]
  beams?: readonly BeamSpec[]
  /** Conditional grants: effects a landing puts on its target, read by the rows that follow in turn order. */
  grants?: readonly GrantSpec[]
  /** The primary target (creature 0) has this condition from the start of the turn, for certain. Not Unconscious, which a damaging row would end. */
  startingCondition?: StartingConditionName
}

export type ConditionName = 'blinded' | 'paralyzed' | 'prone' | 'restrained' | 'stunned' | 'unconscious'
/** A condition the target can start the turn with: all but Unconscious, which the first damaging row ends. */
export type StartingConditionName = Exclude<ConditionName, 'unconscious'>
export type SaveAbilityName = 'strength' | 'dexterity' | 'constitution' | 'intelligence' | 'wisdom' | 'charisma'

/** Rest of the turn, or consumed by the next attack roll that reads it (hit or miss). */
export type EffectLifetime = 'turn' | 'next-attack'

/**
 * A save-side effect lasts the rest of the turn (default) or is read and used up by the next save row its creature makes
 * (a row that happens, hit or miss; a save row that does not happen consumes nothing). A grant's own save is not a row:
 * it reads only the effects that last the turn and consumes nothing.
 */
export type SaveEffectLifetime = 'turn' | 'next-save'

/**
 * What an effect is read by. A next-attack advantage, disadvantage or crit effect is the creature's by default: it is read
 * by the next attack at the creature the grant's row was aimed at (`target`). `any` makes it the attacker's: the next
 * attack at ANY creature reads and uses it up (Killer's Fortune: "advantage on your next attack roll").
 */
export type EffectAgainst = 'target' | 'any'

export type EffectSpec =
  /**
   * `until-damaged` ends the condition after the first later row that damages its creature: the row's own damage (more than 0, the
   * landing rule, a miss that deals its miss payload included) or a rider's that lands on the row with a payload above 0 (see
   * `riderVariants`); that row still reads it. Unconscious leaves the creature Prone
   * when it ends, so an `until-damaged` Unconscious puts a lasting Prone on the creature with it.
   */
  | { kind: 'condition'; condition: ConditionName; lifetime?: 'turn' | 'until-damaged' }
  | { kind: 'advantage' | 'disadvantage' | 'critOnHit'; lifetime: EffectLifetime; to?: readonly number[]; against?: EffectAgainst }
  /** `to` lists the save rows that read it (a grant's own save is not one): Focused Strike reaches only the saves against your spells. */
  | { kind: 'saveDisadvantage'; lifetime?: SaveEffectLifetime; to?: readonly number[] }
  | { kind: 'savePenalty'; count: number; sides: number; lifetime?: SaveEffectLifetime; to?: readonly number[] }
  /**
   * Vulnerability to all the damage of the next attack that HITS the creature, after which the effect ends (2014 Path to the Grave:
   * "The next time you or an ally of yours hits the cursed creature with an attack, the creature has vulnerability to all of that
   * attack's damage, and then the curse ends."). An attack row reads it; a hit or a crit uses it up and a miss leaves it for the next
   * attack; a save row never reads it. The hit's whole damage doubles, the damage of every rider that lands on it included, with the
   * enemy's per-type scales off (the engine's rule for whole-roll vulnerability, `shouldConsiderDamageModifiers`); a miss deals its
   * payload as it would. See {@link vulnerableDicePayloads}.
   */
  | { kind: 'vulnerability'; lifetime: 'next-hit' }

/**
 * What lands a grant. `hit` and `crit` are attack rows only; `miss` is an attack roll that misses (a miss that deals its miss
 * payload is still a miss); `failedSave` and `passedSave` are save rows only; `damage` is a landing that deals more than 0.
 * `kill` never lands: the enumerator has no hit points, so a kill-triggered grant never fires. `rider` lands on the row
 * where rider `GrantSpec.rider` (an index into the turn's riders) applies: for a first-hit rider, its one landing. `start` lands on
 * no row: the grant's effects are on the creature of each row in `of` before the first row rolls, for certain (a curse cast
 * earlier: Path to the Grave). It takes no save, chance, `dealing`, `onPass` or rider, and its `cap` is `once`.
 */
export type GrantTrigger = 'hit' | 'damage' | 'miss' | 'crit' | 'kill' | 'failedSave' | 'passedSave' | 'rider' | 'start'

export interface GrantSaveSpec {
  ability?: SaveAbilityName
  dc: number
  saveBonus: number
  /**
   * The target may save with one of these abilities instead (2024 Grappler: "a Strength or Dexterity saving throw (it
   * chooses which)"). It saves with whichever of `ability` and these it is likeliest to pass in the state the row starts in.
   */
  alternatives?: readonly { ability: SaveAbilityName; saveBonus: number }[]
  /**
   * A contested ability check instead of a save (2014 grapple): the target rolls a flat d20 + `saveBonus` (or an alternative's)
   * against the attacker's flat d20 + `contest`, and fails when its total is lower; a tie fails nothing. `dc` is unused. A check is
   * not a save, so no condition or save penalty changes it.
   */
  contest?: number
}

/**
 * A conditional grant: when a row among `of` lands for `trigger`, its `effects` are tried on the row's target. The try is
 * a `save` (a fail applies `effects`, a pass applies `onPass`), a fixed `chance` (the rest is the pass branch) or, with
 * neither, certain. `cap: 'once'` tries it on the first eligible landing only, and a landing is eligible only where a
 * later row on the landing's creature reads one of the grant's effects (either list): a landing with no reader after it
 * does not try the grant and keeps the use for a later landing. A next-attack effect `against: 'any'` has no creature, so a
 * later row on any creature is a reader of it.
 *
 * Cold Caster's Frostbite is one of these: "Once per turn when you hit a creature with an attack roll and deal Cold
 * damage ... the creature subtracts 1d4 from the next saving throw it makes" is `trigger: 'hit'`, `dealing: 'cold'`,
 * `cap: 'once'` and a `savePenalty` effect with `lifetime: 'next-save'`.
 */
export interface GrantSpec {
  of: readonly number[]
  trigger: GrantTrigger
  /** With `trigger: 'rider'`: the rider (an index into the turn's riders) whose landing fires the grant; `of` are the rows among its own. The rider must have no `chance`. */
  rider?: number
  /**
   * With `hit`, `damage` or `crit` on an attack row: the landing must also have dealt more than 0 damage of this damage type
   * (after the enemy's scale). A hit that deals none of it never lands for the grant. A turn's grants name one type between them.
   * The damage is the hit's whole: the row's own and a rider's that lands on it (the rider's `damage` parts of this `type`, "when
   * you hit a creature with an attack roll and deal Cold damage" counts a Cold rider's dice).
   */
  dealing?: string
  save?: GrantSaveSpec
  chance?: number
  cap: 'unlimited' | 'once'
  /**
   * A "you can" grant (Topple, Hill's Tumble, Trip, a Cunning Strike option): the player attempts it only when it helps the
   * turn, so the enumeration runs with each subset of the optional grants attempted and keeps the subset with the highest
   * mean (the full set first, so a tie keeps it). A Prone creature gives melee advantage and ranged disadvantage, so a ranged
   * follow-up makes the player decline the Prone.
   */
  optional?: boolean
  effects: readonly EffectSpec[]
  onPass?: readonly EffectSpec[]
}

export type EffectName = 'advantage' | 'disadvantage' | 'critOnHit' | 'autoFail' | 'saveDisadvantage' | 'savePenalty' | 'vulnerable'

/** P(a row reads the effect) and the share of it each source (`starting` or `grant:<index>`) contributes on its own. */
export interface EffectOddsDetail {
  odds: number
  sources: Map<string, number>
}

export interface RowDetail {
  /** P(the resolved d20 type of the row), over every path, whether or not the row happens. */
  rollType: { flat: number; advantage: number; disadvantage: number; elven: number }
  effects: Record<EffectName, EffectOddsDetail>
}

export interface RiderDetail {
  /** The rider's own damage marginal, its `chance` included. */
  pmf: Map<number, number>
  /** P(at least one landing among the rider's `of`). */
  landing: number
}

/** `rows` are indexed by SOURCE index (attacks, then saves), not turn order. */
export interface EnumerationDetail {
  rows: RowDetail[]
  riders: RiderDetail[]
}

export interface EnumerationResult {
  mean: number
  /** Damage value → probability mass (sums to 1). */
  pmf: Map<number, number>
  /** Each source's own damage, by source index: its marginal distribution, whatever the correlation between sources. */
  sources: Array<Map<number, number>>
  /** P(beam i fires), only when the turn has beams. */
  beamFireProbs?: number[]
  /** Per-row and per-rider marginals, only when `enumerateSyntheticTurn` was asked for `detail`. */
  detail?: EnumerationDetail
}

export function enumerateSyntheticTurn(turn: SyntheticTurn, options: { detail?: boolean } = {}): EnumerationResult {
  const grants = turn.grants ?? []
  const optional = grants.flatMap((grant, i) => (grant.optional === true ? [i] : []))
  if (optional.length === 0) return enumerateOnce(turn, options)
  if (optional.length > 8)
    throw new Error(`enumerateSyntheticTurn: ${optional.length} optional grants (at most 8) makes the subset search 2^${optional.length}`)
  // A "you can" grant is attempted only when it helps: enumerate each subset of the optional grants attempted, keep the
  // highest mean. The full set is tried first, so a tie keeps it (the engine's `optionalPolicies` does the same).
  let best: EnumerationResult | undefined
  for (let mask = (1 << optional.length) - 1; mask >= 0; mask--) {
    const subset = new Set(optional.filter((_, k) => (mask & (1 << k)) !== 0))
    const result = enumerateOnce({ ...turn, grants: grants.filter((_, i) => !optional.includes(i) || subset.has(i)) }, options)
    if (!best || result.mean > best.mean) best = result
  }
  return best!
}

function enumerateOnce(turn: SyntheticTurn, options: { detail?: boolean } = {}): EnumerationResult {
  const walked = enumerateSourcesWithRiders(turn, options.detail === true)
  let pmf = walked.pmf

  for (const freq of turn.frequencyRows ?? []) {
    pmf = convolveMaps(pmf, enumerateFrequencyRow(freq))
  }
  const result: EnumerationResult = { mean: meanOfMap(pmf), pmf, sources: walked.perSource }
  if (walked.detail) result.detail = walked.detail
  if (turn.beams && turn.beams.length > 0) {
    const chain = enumerateBeamChain(turn.beams)
    result.beamFireProbs = chain.fireProbs
    pmf = convolveMaps(pmf, chain.pmf)
    result.pmf = pmf
    result.mean = meanOfMap(pmf)
  }
  return result
}

// ── d20 ──────────────────────────────────────────────────────────────────────

/**
 * Exact probability mass of each natural face under the given roll type. With `rerollOnes` each d20 rerolls a natural
 * 1 once and keeps the new roll (Halfling Luck), so a die reads 1 with 1/400 and every other face with 1/20 + 1/400;
 * the roll type then keeps the higher or lower of its dice.
 */
export function d20Distribution(advantage: AdvantageKind, rerollOnes = false): Map<number, number> {
  const out = new Map<number, number>()
  if (rerollOnes) {
    // P(die <= f): 1/400 at face 1, then 21/400 for each face above it. The extreme of n dice: max is Q(f)^n - Q(f-1)^n,
    // min is (1 - Q(f-1))^n - (1 - Q(f))^n.
    const cdf = (f: number): number => (f < 1 ? 0 : (1 + (f - 1) * 21) / 400)
    const dice = advantage === 'flat' ? 1 : advantage === 'elven' ? 3 : 2
    for (let f = 1; f <= 20; f++) {
      const p = advantage === 'disadvantage' ? (1 - cdf(f - 1)) ** dice - (1 - cdf(f)) ** dice : cdf(f) ** dice - cdf(f - 1) ** dice
      out.set(f, p)
    }
    return out
  }
  for (let f = 1; f <= 20; f++) {
    let p: number
    if (advantage === 'flat') p = 1 / 20
    else if (advantage === 'advantage') p = (2 * f - 1) / 400
    else if (advantage === 'disadvantage') p = (41 - 2 * f) / 400
    else p = (3 * f * f - 3 * f + 1) / 8000 // elven: max of 3
    out.set(f, p)
  }
  return out
}

/**
 * P(miss) / P(plain hit) / P(crit) for an attack, honouring natural-1 and natural-20. A face in the crit range crits
 * only if it hits: a natural 20 always does, a lower face must reach the AC (`@yipe/dice` `critOn`).
 */
export function d20LandingProbs(
  advantage: AdvantageKind,
  toHit: number,
  ac: number,
  critRange: number,
  autoCrit = false,
  rerollOnes = false,
  autoHit = false
): {
  pMiss: number
  pHit: number
  pCrit: number
} {
  let pMiss = 0
  let pHit = 0
  let pCrit = 0
  for (const [f, p] of d20Distribution(advantage, rerollOnes)) {
    if (f === 1 && !autoHit) pMiss += p
    else if (f >= critRange && (autoHit || f === 20 || f + toHit >= ac)) pCrit += p
    else if (autoHit || f + toHit >= ac) pHit += p
    else pMiss += p
  }
  return autoCrit ? { pMiss, pHit: 0, pCrit: pCrit + pHit } : { pMiss, pHit, pCrit }
}

/** How an attack's probability mass splits over `@yipe/dice`'s outcome labels. */
export interface AttackOutcomes {
  missNone: number
  missDamage: number
  hit: number
  crit: number
}

/** The attack's outcome masses: a miss with a miss payload is `missDamage`, otherwise `missNone`. */
export function attackOutcomes(attack: AttackSpec): AttackOutcomes {
  const { pMiss, pHit, pCrit } = attackLandingProbs(attack)
  return attack.missDamage ? { missNone: 0, missDamage: pMiss, hit: pHit, crit: pCrit } : { missNone: pMiss, missDamage: 0, hit: pHit, crit: pCrit }
}

/** How a save's probability mass splits over `@yipe/dice`'s outcome labels: a success on a `none` save is `missNone`. */
export interface SaveOutcomes {
  saveFail: number
  saveHalf: number
  missNone: number
}

/** The save's outcome masses: a success is `saveHalf` on a half save, `missNone` on a save that deals nothing on a success. */
export function saveOutcomes(save: SaveSpec): SaveOutcomes {
  const pSuccess = saveSuccessProbability(save)
  const saveFail = 1 - pSuccess
  return save.onSuccess === 'half' ? { saveFail, saveHalf: pSuccess, missNone: 0 } : { saveFail, saveHalf: 0, missNone: pSuccess }
}

/**
 * A bounce chain among a turn's crit sources (Chromatic Orb's leap, Chaos Bolt): its links, and which of them are sources
 * (`watched`, indexes into `beams`; default every link). A link that is not a source still has to land and match for the links
 * after it to exist.
 */
export interface CritChainSpec {
  beams: readonly BeamSpec[]
  watched?: readonly number[]
}

const matchedShares = new Map<string, number>()

/**
 * Of every roll of `count` dice of `sides` faces, the share in which two dice show the same value, each die reading at least
 * `minimumDie`. With a `rerollDice` budget the caster, who sees the roll, rerolls the lowest dice that show less than the die's
 * mean (each reroll has a positive expected gain), up to the budget, and keeps each new roll: the dice that count are the ones
 * that land after the rerolls, for the most damage and never to make a match.
 */
function matchedShare(count: number, sides: number, minimumDie: number, rerollDice: number): number {
  if (count < 2) return 0
  if (rerollDice > 0 && minimumDie > 1) throw new Error('bruteForce: a match pool with both a floor and a reroll budget is not modelled')
  const key = `${count}|${sides}|${minimumDie}|${rerollDice}`
  const known = matchedShares.get(key)
  if (known !== undefined) return known

  const repeats = (values: readonly number[]): boolean => new Set(values).size < values.length
  /** The share of the rerolls of a roll, made as the caster would, in which two dice match. */
  const afterRerolls = (rolled: readonly number[]): number => {
    const sorted = rolled.map((face) => Math.max(face, minimumDie)).sort((a, b) => a - b)
    const rerolled = sorted.slice(0, rerollDice).filter((face) => face < (sides + 1) / 2).length
    const kept = sorted.slice(rerolled)
    let matched = 0
    const reroll = (left: number, values: readonly number[]): void => {
      if (left === 0) {
        if (repeats(values)) matched++
        return
      }
      for (let face = 1; face <= sides; face++) reroll(left - 1, [...values, face])
    }
    reroll(rerolled, kept)
    return matched / sides ** rerolled
  }
  let share = 0
  let total = 0
  const roll = (remaining: number, values: readonly number[]): void => {
    if (remaining === 0) {
      total++
      share += afterRerolls(values)
      return
    }
    for (let face = 1; face <= sides; face++) roll(remaining - 1, [...values, face])
  }
  roll(count, [])
  matchedShares.set(key, share / total)
  return share / total
}

/**
 * P(none of a bounce chain's watched links crits), from the chain as the rules play it: the first link is cast, and link N
 * exists only if link N-1 hit or crit and its own damage dice showed a repeat (a crit rolls double the dice). Each link's
 * d20 is resolved on its own roll; the walk runs back from the last link, each link's outcomes weighted by the rolls of its
 * dice that match. A watched link that crits is the event itself; an unwatched one lets the chain go on.
 */
export function bounceChainNoCritProbability(beams: readonly BeamSpec[], watched: readonly number[] = beams.map((_, i) => i)): number {
  const counted = new Set(watched)
  let noCrit = 1
  for (let i = beams.length - 1; i >= 0; i--) {
    const beam = beams[i]!
    const { pMiss, pHit, pCrit } = d20LandingProbs(beam.advantage, beam.toHit, beam.ac, beam.critRange)
    const minimumDie = beam.damage.minimumDie ?? 0
    const rerollDice = beam.damage.rerollDice ?? 0
    const hitMatch = matchedShare(beam.damage.count, beam.damage.sides, minimumDie, rerollDice)
    const critMatch = matchedShare(beam.damage.count * 2, beam.damage.sides, minimumDie, rerollDice)
    const onHit = hitMatch * noCrit + (1 - hitMatch)
    const onCrit = counted.has(i) ? 0 : critMatch * noCrit + (1 - critMatch)
    noCrit = pMiss + pHit * onHit + pCrit * onCrit
  }
  return noCrit
}

/**
 * P(at least one of `attacks` crits): every crit / no-crit assignment of the attacks, each a product of the attacks' own
 * crit odds (an attack crits with its `chance` times its d20's crit mass, see {@link d20LandingProbs}), summed over the
 * assignments with a crit. A save never crits, so a turn's saves are not an argument, and an auto row (no d20) is not
 * one either. A bounce chain is one more independent source: its own rolls are its links', gated link by link
 * ({@link bounceChainNoCritProbability}).
 */
export function anyCritProbability(attacks: readonly AttackSpec[], chains: readonly CritChainSpec[] = []): number {
  const pCrit = attacks.map((a) => occurrenceChance(a) * attackLandingProbs(a).pCrit)
  let any = 0
  for (let mask = 1; mask < 1 << pCrit.length; mask++) {
    let p = 1
    pCrit.forEach((crit, i) => {
      p *= mask & (1 << i) ? crit : 1 - crit
    })
    any += p
  }
  const chainsQuiet = chains.reduce((p, chain) => p * bounceChainNoCritProbability(chain.beams, chain.watched), 1)
  return 1 - (1 - any) * chainsQuiet
}

/**
 * P(a source is a landing for `trigger`): the chance it happens at all times the mass of the outcomes the trigger lands
 * on ({@link LandingTrigger}). {@link attackOutcomes} and {@link saveOutcomes} are the source's own labels and leave
 * `chance` out, as a `@yipe/dice` builder's PMF does.
 */
export function landingMass(source: AttackSpec | SaveSpec, trigger: LandingTrigger): number {
  const branches = 'dc' in source ? saveBranches(source) : attackBranches(source)
  return branches.reduce((sum, branch) => (landsOn(branch.landing, branch.dealt, trigger) ? sum + branch.p : sum), 0)
}

// ── dice ─────────────────────────────────────────────────────────────────────

/** Exact sum distribution of `count`d`sides` + `flat`. Mass sums to 1. */
export function diceSumDistribution(count: number, sides: number, flat = 0): Map<number, number> {
  let map = new Map<number, number>([[flat, 1]])
  if (count <= 0 || sides <= 0) return map
  for (let i = 0; i < count; i++) {
    const next = new Map<number, number>()
    for (const [d, p] of map) {
      for (let f = 1; f <= sides; f++) {
        addScaled(next, d + f, p / sides)
      }
    }
    map = next
  }
  return map
}

/**
 * Exact sum distribution of `count` dice of `sides` faces in a roll-again-on-max pool (Sorcerous Burst): each die
 * that shows its top face adds one more die while `budget` extra dice remain, an extra die included, and the budget
 * is the whole pool's. A recursion over the dice still to roll, independent of the engine: each wave counts how
 * many of its dice show the top face (a die that shows it after the budget is spent still scores it), the others
 * are uniform over the lower faces, and the extra dice roll as a smaller pool with the budget that is left.
 */
export function explodePoolDistribution(count: number, sides: number, budget: number): Map<number, number> {
  const out = new Map<number, number>()
  if (count <= 0) return out.set(0, 1)
  let ways = 1 // C(count, top)
  for (let top = 0; top <= count; top++) {
    if (top > 0) ways = (ways * (count - top + 1)) / top
    const pWave = ways * (1 / sides) ** top * ((sides - 1) / sides) ** (count - top)
    const extras = Math.min(top, budget)
    const rest = explodePoolDistribution(extras, sides, budget - extras)
    for (const [lower, pLower] of diceSumDistribution(count - top, sides - 1))
      for (const [more, pMore] of rest) addScaled(out, lower + top * sides + more, pWave * pLower * pMore)
  }
  return out
}

/**
 * The raw first faces of a `sides`-sided die a must-use reroll gives up (phase 2a card A12): the die reads as
 * `max(face, minimumDie)`, and the roller rerolls exactly when that is worth less than a fresh die, whose value
 * is `total / sides` (`total` sums the floored faces). Compared in integers, so a face worth exactly the
 * average is kept. Any other policy has a lower mean: a face is worth keeping or not on its own, because the
 * dice are independent and the score is their sum.
 */
export function rerollFaces(sides: number, minimumDie = 0): number[] {
  let total = 0
  for (let face = 1; face <= sides; face++) total += Math.max(face, minimumDie)
  const faces: number[] = []
  for (let face = 1; face <= sides; face++) if (Math.max(face, minimumDie) * sides < total) faces.push(face)
  return faces
}

/**
 * One die's own distribution, read face by face: the raw first face, its mandatory first reroll (`rerollBelow`: a face
 * at or below it rolls again, once, and the new roll stands) and the floor at `minimumDie`, which applies to the face
 * that is kept. Enumerates every (first, second) pair.
 */
function ownDieDistribution(sides: number, minimumDie = 0, rerollBelow = 0): Map<number, number> {
  const out = new Map<number, number>()
  for (let first = 1; first <= sides; first++) {
    for (let second = 1; second <= sides; second++) {
      const face = first <= rerollBelow ? second : first
      addScaled(out, Math.max(face, minimumDie), 1 / (sides * sides))
    }
  }
  return out
}

/** One kind of die in a reroll pool: how many, and the distribution of one die's shown value ({@link ownDieDistribution}). */
export interface PoolDie {
  count: number
  own: Map<number, number>
}

/** The sum of independent draws from each of `dists`. */
function convolveAll(dists: readonly Map<number, number>[]): Map<number, number> {
  return dists.reduce((acc, dist) => convolveMaps(acc, dist), new Map<number, number>([[0, 1]]))
}

/**
 * Every way `count` dice can show, as the sorted list of shown values and its probability: the mass of every ordered roll
 * that sorts to it. Built one die at a time, so the multinomial is never written down.
 */
function diceShowings(count: number, own: Map<number, number>): Array<{ values: number[]; p: number }> {
  let states = new Map<string, { values: number[]; p: number }>([['', { values: [], p: 1 }]])
  for (let die = 0; die < count; die++) {
    const next = new Map<string, { values: number[]; p: number }>()
    for (const state of states.values()) {
      for (const [value, q] of own) {
        const values = [...state.values, value].sort((a, b) => a - b)
        const key = values.join(',')
        const entry = next.get(key)
        if (entry) entry.p += state.p * q
        else next.set(key, { values, p: state.p * q })
      }
    }
    states = next
  }
  return [...states.values()]
}

/** A gain below this is no gain: the expected values are sums of a few dozen exact fractions. */
const GAIN_EPSILON = 1e-9

/** What the roller does to one roll of the pool: the dice it rerolls (by kind) and the damage that is worth in expectation. */
interface RerollChoice {
  /** The kinds of the dice rerolled. */
  kinds: number[]
  /** The sum of their shown values, which the new rolls replace. */
  removed: number
  /** The expected gain: what the new rolls are worth, less what they replace. */
  gain: number
}

/**
 * The best set of up to `budget` dice to reroll, found by trying EVERY subset, not by sorting the gains: a subset is worth
 * the sum over its dice of (the mean of a fresh die of that kind) less (what the die shows). Dice of one kind showing the
 * same face are interchangeable, so a subset is how many of each (kind, face) it takes; every such count is tried. Ties go
 * to the smaller set (a die that shows its own mean keeps its roll), then to the dearer kinds of die.
 */
function bestReroll(shown: readonly { kind: number; value: number }[], means: readonly number[], budget: number): RerollChoice {
  const faces = new Map<string, { kind: number; value: number; count: number }>()
  for (const { kind, value } of shown) {
    const key = `${kind}:${value}`
    const face = faces.get(key)
    if (face) face.count++
    else faces.set(key, { kind, value, count: 1 })
  }
  const distinct = [...faces.values()]
  let best: RerollChoice = { kinds: [], removed: 0, gain: 0 }
  let bestKindMean = 0
  const walk = (index: number, left: number, kinds: number[], removed: number, gain: number, kindMean: number): void => {
    if (index === distinct.length) {
      const better =
        gain > best.gain + GAIN_EPSILON ||
        (Math.abs(gain - best.gain) <= GAIN_EPSILON &&
          (kinds.length < best.kinds.length || (kinds.length === best.kinds.length && kindMean > bestKindMean + GAIN_EPSILON)))
      if (better) {
        best = { kinds: [...kinds], removed, gain }
        bestKindMean = kindMean
      }
      return
    }
    const { kind, value, count } = distinct[index]!
    for (let take = 0; take <= Math.min(count, left); take++) {
      const mean = means[kind]!
      walk(
        index + 1,
        left - take,
        [...kinds, ...Array<number>(take).fill(kind)],
        removed + take * value,
        gain + take * (mean - value),
        kindMean + take * mean
      )
    }
  }
  walk(0, budget, [], 0, 0, 0)
  return best
}

/** One joint roll of a pool: each kind's dice show, every combination of the kinds' showings. */
function poolShowings(kinds: readonly PoolDie[]): Array<{ shown: Array<{ kind: number; value: number }>; p: number }> {
  let rolls: Array<{ shown: Array<{ kind: number; value: number }>; p: number }> = [{ shown: [], p: 1 }]
  kinds.forEach((kind, index) => {
    const showings = diceShowings(kind.count, kind.own)
    rolls = rolls.flatMap((roll) =>
      showings.map((showing) => ({ shown: [...roll.shown, ...showing.values.map((value) => ({ kind: index, value }))], p: roll.p * showing.p }))
    )
  })
  return rolls
}

/**
 * The exact distribution of a pool of dice once the roller has seen them and rerolled the best up to `budget` of them
 * ({@link bestReroll}), keeping each new roll. With `rolls` 2 (Savage Attacker with Piercer) the pool is rolled twice, each
 * roll is worth its dice plus its best reroll, the roll worth more is kept and only that one is rerolled: choose the roll,
 * then reroll a die in it. Enumerates every showing of every roll, face by face.
 */
export function poolDistribution(kinds: readonly PoolDie[], budget: number, rolls = 1): Map<number, number> {
  const means = kinds.map((kind) => meanOfMap(kind.own))
  const outcomes = poolShowings(kinds).map(({ shown, p }) => {
    const choice = bestReroll(shown, means, budget)
    const sum = shown.reduce((total, die) => total + die.value, 0)
    // What the roll is worth in expectation, and the distribution it leaves once its chosen dice are rerolled.
    const fresh = convolveAll(choice.kinds.map((kind) => kinds[kind]!.own))
    const kept = new Map<number, number>()
    for (const [value, q] of fresh) addScaled(kept, sum - choice.removed + value, q)
    return { p, score: sum + choice.gain, kept }
  })
  const out = new Map<number, number>()
  if (rolls === 1) {
    for (const { p, kept } of outcomes) for (const [value, q] of kept) addScaled(out, value, p * q)
    return out
  }
  if (rolls !== 2) throw new Error('bruteForce: a pool is rolled once or twice')
  for (const first of outcomes) {
    for (const second of outcomes) {
      const chosen = second.score > first.score + GAIN_EPSILON ? second : first
      for (const [value, q] of chosen.kept) addScaled(out, value, first.p * second.p * q)
    }
  }
  return out
}

/** A budget that covers every die rerolls each die on its own: the faces worth less than a fresh die, and no other. */
function coveredDistribution(kinds: readonly PoolDie[]): Map<number, number> {
  const dists: Array<Map<number, number>> = []
  for (const { count, own } of kinds) {
    const mean = meanOfMap(own)
    const each = new Map<number, number>()
    for (const [value, p] of own) {
      if (mean - value > GAIN_EPSILON) for (const [fresh, q] of own) addScaled(each, fresh, p * q)
      else addScaled(each, value, p)
    }
    for (let i = 0; i < count; i++) dists.push(each)
  }
  return convolveAll(dists)
}

/** The pool a payload's carriers make on one roll and its distribution: every kind of die, and the smallest budget. */
function carrierPool(carriers: readonly PartSpec[], k: number, rolls: number): Map<number, number> {
  const kinds: PoolDie[] = carriers.map((part) => ({
    count: part.count * k,
    own: ownDieDistribution(part.sides, part.minimumDie ?? 0, part.rerollBelow ?? 0)
  }))
  const budget = Math.min(...carriers.map((part) => part.rerollDice!))
  const dice = kinds.reduce((sum, kind) => sum + kind.count, 0)
  return rolls === 1 && budget >= dice ? coveredDistribution(kinds) : poolDistribution(kinds, budget, rolls)
}

/** Exact sum distribution of a part's `count`d`sides` + `flat`, read by its {@link DieRules} but for the pool budget, which {@link carrierPool} owns. `dice` is the count on this roll. */
function partDistribution(part: PartSpec, dice: number, extraFlat = 0): Map<number, number> {
  const { sides, minimumDie = 0, rerollBelow = 0 } = part
  const flat = (part.flat ?? 0) + extraFlat
  if (minimumDie === 0 && rerollBelow === 0) return diceSumDistribution(dice, sides, flat)
  return convolveMaps(
    new Map<number, number>([[flat, 1]]),
    convolveAll(Array.from({ length: dice }, () => ownDieDistribution(sides, minimumDie, rerollBelow)))
  )
}

/** `num / den` of `v`, rounded down or up, in exact integer arithmetic. */
function applyScale(v: number, scale: DamageScaleSpec): number {
  const q = (v * scale.num) / scale.den
  return scale.round === 'ceil' ? Math.ceil(q) : Math.floor(q)
}

/**
 * A payload's exact distribution, its dice doubled on a crit: typed groups scaled once each, then summed.
 * With `halve`, each group's total is halved (rounded down) before its scale: half of a miss pool, then
 * the enemy's multiplier (phase 2a card A8's order). With `dealMax` (Max + roll, card A9) a crit rolls each
 * part's dice once and adds that part's max faces before its group's scale, instead of doubling the dice. With
 * `saveSuccess` (a successful save-half) each doubled group is halved and then doubled, and the other groups, each
 * scaled on its own, are summed and halved once.
 */
export function payloadDistribution(spec: DiceSpec, crit: boolean, halve = false, dealMax = false, saveSuccess = false): Map<number, number> {
  const k = crit && !dealMax ? 2 : 1
  const addMax = crit && dealMax
  const groups = new Map<string, { scale?: DamageScaleSpec; parts: PartSpec[] }>()
  const untyped = '\u0000untyped'
  const { count, sides, flat, minimumDie, rerollBelow, rerollDice } = spec
  groups.set(untyped, {
    parts: [
      {
        count,
        sides,
        flat: flat ?? 0,
        ...(minimumDie !== undefined ? { minimumDie } : {}),
        ...(rerollBelow !== undefined ? { rerollBelow } : {}),
        ...(rerollDice !== undefined ? { rerollDice } : {})
      }
    ]
  })
  for (const part of spec.parts ?? []) {
    const key = part.type ?? untyped
    if (key === untyped && part.scale) throw new Error('bruteForce: an untyped part cannot carry a scale')
    const group = groups.get(key)
    if (!group) groups.set(key, { ...(part.scale ? { scale: part.scale } : {}), parts: [part] })
    else {
      if (JSON.stringify(group.scale) !== JSON.stringify(part.scale)) throw new Error(`bruteForce: every ${key} part needs the same scale`)
      group.parts.push(part)
    }
  }
  // The pool: every part that carries a budget and rolls dice on this roll. They are one pool with the smallest budget.
  const carriers = [...groups.values()].flatMap((group) => group.parts).filter((part) => part.rerollDice !== undefined && part.count * k > 0)
  const carrierGroups = [...groups.values()].filter((group) => group.parts.some((part) => carriers.includes(part)))
  let total: Map<number, number>
  if (spec.bestOfTwo) {
    if (halve || saveSuccess) throw new Error('bruteForce: half of a best-of-two pool is not a shape any card needs')
    if (addMax) throw new Error('bruteForce: Max + roll on a best-of-two pool is not a shape any card needs')
    total = carriers.length > 0 ? savagePoolTotal([...groups.values()], carriers, k) : bestOfTwoTotal([...groups.values()], k)
  } else {
    if (carrierGroups.length > 1 && ([...groups.values()].some((group) => group.scale) || halve || saveSuccess)) {
      // One pool across several typed groups cannot be split back into each group's own scale or half.
      throw new Error('bruteForce: a reroll pool across several damage types needs them unscaled and whole')
    }
    total = new Map<number, number>([[0, 1]])
    let undoubled = new Map<number, number>([[0, 1]])
    const pool = carriers.length > 0 ? carrierPool(carriers, k, 1) : undefined
    for (const group of groups.values()) {
      const { scale, parts } = group
      let sum = new Map<number, number>([[0, 1]])
      for (const part of parts) {
        const maxFlat = addMax ? part.count * part.sides : 0
        // A carrier's dice are the pool's; its flat stays with its group.
        sum = convolveMaps(
          sum,
          carriers.includes(part) ? new Map([[(part.flat ?? 0) + maxFlat, 1]]) : partDistribution(part, part.count * k, maxFlat)
        )
      }
      if (pool && group === carrierGroups[0]) sum = convolveMaps(sum, pool)
      if (halve) {
        const halved = new Map<number, number>()
        for (const [v, p] of sum) addScaled(halved, Math.floor(v / 2), p)
        sum = halved
      }
      const doubled = scale !== undefined && scale.num > scale.den
      if (saveSuccess && doubled) {
        const halved = new Map<number, number>()
        for (const [v, p] of sum) addScaled(halved, Math.floor(v / 2), p)
        sum = halved
      }
      if (scale) {
        const scaled = new Map<number, number>()
        for (const [v, p] of sum) addScaled(scaled, applyScale(v, scale), p)
        sum = scaled
      }
      if (saveSuccess && !doubled) undoubled = convolveMaps(undoubled, sum)
      else total = convolveMaps(total, sum)
    }
    if (saveSuccess) {
      const halved = new Map<number, number>()
      for (const [v, p] of undoubled) addScaled(halved, Math.floor(v / 2), p)
      total = convolveMaps(total, halved)
    }
  }
  if (!spec.floorAtZero) return total
  const floored = new Map<number, number>()
  for (const [v, p] of total) addScaled(floored, Math.max(0, v), p)
  return floored
}

/** Every combination of faces of the dice `pick` selects, as each group's dice sum (flats left out). */
function diceSumVectors(
  groups: readonly { parts: PartSpec[] }[],
  k: number,
  pick: (part: PartSpec) => boolean
): Array<{ sums: number[]; p: number }> {
  let vectors: Array<{ sums: number[]; p: number }> = [{ sums: [], p: 1 }]
  for (const group of groups) {
    let dist = new Map<number, number>([[0, 1]])
    for (const part of group.parts) if (pick(part)) dist = convolveMaps(dist, diceSumDistribution(part.count * k, part.sides))
    const next: Array<{ sums: number[]; p: number }> = []
    for (const v of vectors) for (const [sum, p] of dist) next.push({ sums: [...v.sums, sum], p: v.p * p })
    vectors = next
  }
  return vectors
}

/**
 * Savage Attacker with a reroll budget (Piercer): the weapon's dice are one pool rolled twice, the roll worth more after its
 * own best reroll is kept, and a die of THAT roll is rerolled (choose the roll, then reroll a die in it). Every die the
 * budget may reroll is one of the weapon's dice: a carrier beside the pool, or a pool die with no budget, is a policy the
 * engine does not model, so the oracle refuses it. Unscaled: a scale would change which roll is worth more.
 */
function savagePoolTotal(
  groups: readonly { scale?: DamageScaleSpec; parts: PartSpec[] }[],
  carriers: readonly PartSpec[],
  k: number
): Map<number, number> {
  const parts = groups.flatMap((group) => group.parts)
  const pool = parts.filter((part) => !part.outsidePool && part.count * k > 0)
  if (groups.some((group) => group.scale)) throw new Error('bruteForce: a reroll budget beside a best-of-two pool needs an unscaled payload')
  if (pool.length !== carriers.length || pool.some((part) => !carriers.includes(part))) {
    throw new Error("bruteForce: the reroll budget must be on exactly the best-of-two pool's dice; a die beside it is not modelled")
  }
  let total = convolveMaps(new Map<number, number>([[parts.reduce((sum, part) => sum + (part.flat ?? 0), 0), 1]]), carrierPool(carriers, k, 2))
  for (const part of parts) if (part.outsidePool) total = convolveMaps(total, partDistribution(part, part.count * k))
  return total
}

/**
 * A best-of-two payload's distribution, from its definition: two independent rolls of the pool, the outside
 * parts rolled once and shared, and the kept roll the one whose total (each type's group summed, flats
 * included, then scaled once) is higher.
 */
function bestOfTwoTotal(groups: readonly { scale?: DamageScaleSpec; parts: PartSpec[] }[], k: number): Map<number, number> {
  // Every part is in the pool or outside it, so a group's flat is the sum over all its parts.
  const flats = groups.map((group) => group.parts.reduce((sum, part) => sum + (part.flat ?? 0), 0))
  const total = (pool: readonly number[], outside: readonly number[]): number =>
    groups.reduce((sum, group, g) => {
      const groupSum = pool[g]! + outside[g]! + flats[g]!
      return sum + (group.scale ? applyScale(groupSum, group.scale) : groupSum)
    }, 0)

  const poolRolls = diceSumVectors(groups, k, (part) => !part.outsidePool)
  const out = new Map<number, number>()
  for (const outside of diceSumVectors(groups, k, (part) => part.outsidePool === true)) {
    for (const first of poolRolls) {
      for (const second of poolRolls) {
        addScaled(out, Math.max(total(first.sums, outside.sums), total(second.sums, outside.sums)), outside.p * first.p * second.p)
      }
    }
  }
  return out
}

/** Dice payload's hit distribution and its crit distribution (dice doubled, flat unchanged). */
function dicePayloads(spec: DiceSpec, critDamage?: DiceSpec, dealMax = false): { hit: Map<number, number>; crit: Map<number, number> } {
  const hit = payloadDistribution(spec, false)
  const crit = critDamage ? payloadDistribution(critDamage, false) : payloadDistribution(spec, true, false, dealMax)
  return { hit, crit }
}

/** `spec` with the enemy's per-type scale taken off every part. */
function unscaled(spec: DiceSpec): DiceSpec {
  return spec.parts ? { ...spec, parts: spec.parts.map(({ scale: _scale, ...part }) => part) } : spec
}

/** Every amount of `pmf` doubled: whole-roll vulnerability is x2 on the finished total, which rounding never touches. */
function doubledTotals(pmf: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [damage, p] of pmf) addScaled(out, damage * 2, p)
  return out
}

/**
 * The hit and crit distributions of a payload dealt to a creature that is vulnerable to the attack (the `vulnerability` effect):
 * the payload's damage with the enemy's per-type scales off, then all of it doubled. The engine's rule: a row with whole-roll
 * vulnerability does not consider the enemy's defenses (`shouldConsiderDamageModifiers`), so a resisting or immune enemy does not
 * take less of a vulnerable hit. (RAW stacks them, "Resistance and then vulnerability are applied after all other modifiers",
 * which is another number for a resisted type: halved, then doubled.) A crit doubles the dice before the whole roll doubles.
 */
function vulnerableDicePayloads(spec: DiceSpec, critDamage?: DiceSpec, dealMax = false): { hit: Map<number, number>; crit: Map<number, number> } {
  const { hit, crit } = dicePayloads(unscaled(spec), critDamage && unscaled(critDamage), dealMax)
  return { hit: doubledTotals(hit), crit: doubledTotals(crit) }
}

/** An attack's damage on a miss (mass 1), or `undefined` when a miss deals nothing. */
function missPayload(attack: AttackSpec): Map<number, number> | undefined {
  const miss = attack.missDamage
  if (!miss) return undefined
  switch (miss.kind) {
    case 'flat':
      return new Map([[miss.scale ? applyScale(miss.amount, miss.scale) : miss.amount, 1]])
    case 'dice':
      return payloadDistribution(miss.damage, false)
    case 'halfOfPool':
      return payloadDistribution(miss.damage, false, true)
    case 'halfOnMiss':
      return halvedPayload(ownPayload(attack.damage))
  }
}

/** Enumerate every roll of `count`d`sides`, tagging each with its sum and whether any face repeats. */
function enumerateDiceOutcomes(count: number, sides: number): Array<{ damage: number; matched: boolean }> {
  const out: Array<{ damage: number; matched: boolean }> = []
  if (count <= 0) {
    out.push({ damage: 0, matched: false })
    return out
  }
  const counts = new Array<number>(sides + 1).fill(0)
  let matched = false
  const rec = (remaining: number, damage: number): void => {
    if (remaining === 0) {
      out.push({ damage, matched })
      return
    }
    for (let f = 1; f <= sides; f++) {
      counts[f]!++
      const wasMatched = matched
      if (counts[f] === 2) matched = true
      rec(remaining - 1, damage + f)
      matched = wasMatched
      counts[f]!--
    }
  }
  rec(count, 0)
  return out
}

// ── map helpers ──────────────────────────────────────────────────────────────

function addScaled(map: Map<number, number>, d: number, p: number): void {
  map.set(d, (map.get(d) ?? 0) + p)
}

function convolveMaps(a: Map<number, number>, b: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [da, pa] of a) {
    for (const [db, pb] of b) {
      addScaled(out, da + db, pa * pb)
    }
  }
  return out
}

function scaleMap(m: Map<number, number>, factor: number): Map<number, number> {
  const out = new Map<number, number>()
  for (const [d, p] of m) out.set(d, p * factor)
  return out
}

function meanOfMap(m: Map<number, number>): number {
  let sum = 0
  for (const [d, p] of m) sum += d * p
  return sum
}

/** `other` shifted by `base`, scaled by `p`, merged into `map`. */
function convolveInto(map: Map<number, number>, base: number, p: number, other: Map<number, number>): void {
  for (const [d, q] of other) {
    addScaled(map, base + d, p * q)
  }
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** A payload's own damage: the untyped dice and the parts whose trigger is `roll` (the default). A rider is not in it. */
export function ownPayload(spec: DiceSpec): DiceSpec {
  return { ...spec, parts: (spec.parts ?? []).filter((part) => (part.trigger ?? 'roll') === 'roll') }
}

/** True when any part is scaled up (x2): the payloads whose save-half success halves before the doubling. */
export function payloadHasDoubledGroup(spec: DiceSpec): boolean {
  return (spec.parts ?? []).some((part) => part.scale !== undefined && part.scale.num > part.scale.den)
}

/**
 * Half of a payload, where a modifier that halves before the enemy's multiplier applies (a successful save-half and
 * the 2024 Potent Cantrip's half on a miss; the 2014 feature is saves only, PR #1837: the halving is a damage
 * adjustment, and resistance and then vulnerability come after every adjustment): the half of a payload with no
 * doubled group (`payloadHasDoubledGroup`) is `floor(total / 2)`; otherwise each doubled group is halved before its
 * doubling beside the rest halved once (`payloadDistribution`'s `saveSuccess`).
 */
function halvedPayload(damage: DiceSpec): Map<number, number> {
  if (payloadHasDoubledGroup(damage)) return payloadDistribution(damage, false, false, false, true)
  const halved = new Map<number, number>()
  for (const [d, p] of payloadDistribution(damage, false)) addScaled(halved, Math.floor(d / 2), p)
  return halved
}

/** What a successful save deals (mass 1): nothing, or {@link halvedPayload}. */
function saveSuccessPayload(save: SaveSpec): Map<number, number> {
  return save.onSuccess === 'none' ? new Map([[0, 1]]) : halvedPayload(save.damage)
}

function enumerateSave(save: SaveSpec): Map<number, number> {
  const pFail = 1 - saveSuccessProbability(save)
  const pSuccess = saveSuccessProbability(save)
  const out = new Map<number, number>()
  for (const [d, p] of payloadDistribution(save.damage, false)) addScaled(out, d, p * pFail)
  for (const [d, p] of saveSuccessPayload(save)) addScaled(out, d, p * pSuccess)
  return withChance(out, occurrenceChance(save))
}

/** A source's `chance` (default 1), which must be a probability. */
function occurrenceChance(source: { chance?: number | undefined }): number {
  const chance = source.chance ?? 1
  if (!(chance >= 0 && chance <= 1)) throw new Error(`bruteForce: a chance must be in [0, 1], got ${chance}`)
  return chance
}

/** `pmf` when a row happens with probability `chance`: the rest of the mass is damage 0. */
function withChance(pmf: Map<number, number>, chance: number): Map<number, number> {
  if (chance === 1) return pmf
  const out = scaleMap(pmf, chance)
  addScaled(out, 0, 1 - chance)
  return out
}

/** P(d20 of `kind` + `saveBonus` - the `penalty` dice >= dc): the target makes its save. Exact over every face and every penalty total. */
function d20PassProbability(kind: AdvantageKind, saveBonus: number, dc: number, penalty?: Map<number, number>): number {
  let p = 0
  for (const [f, pf] of d20Distribution(kind)) {
    if (!penalty) {
      if (f + saveBonus >= dc) p += pf
      continue
    }
    for (const [lost, pl] of penalty) {
      if (f + saveBonus - lost >= dc) p += pf * pl
    }
  }
  return p
}

/** P(the target makes its save): never with `autoFail`, otherwise the d20 of `rollOverride ?? rollType`, less any `penalty` dice. */
function saveSuccessProbability(save: SaveSpec, penalty?: Map<number, number>): number {
  if (save.autoFail) return 0
  return d20PassProbability(save.rollOverride ?? save.rollType ?? 'flat', save.saveBonus, save.dc, penalty)
}

/** An attack's miss / hit / crit odds under its own roll type, or under `kind` and with `critOnHit` when a walk has resolved them. */
function attackLandingProbs(a: AttackSpec, kind: AdvantageKind = a.rollOverride ?? a.advantage, critOnHit = false) {
  return d20LandingProbs(kind, a.toHit, a.ac, a.critRange, a.autoCrit === true || critOnHit, a.rerollOnes, a.autoHit)
}

function enumerateFrequencyRow(row: FrequencyRowSpec): Map<number, number> {
  const attack = enumerateSingleAttack(row.attack)
  const out = scaleMap(attack, row.frequency)
  addScaled(out, 0, 1 - row.frequency)
  return out
}

function enumerateSingleAttack(attack: AttackSpec): Map<number, number> {
  const { pMiss, pHit, pCrit } = attackLandingProbs(attack)
  const { hit, crit } = dicePayloads(attack.damage, attack.critDamage, attack.critDealsMax)
  const miss = missPayload(attack)
  const out = new Map<number, number>()
  if (miss) for (const [d, p] of miss) addScaled(out, d, p * pMiss)
  else addScaled(out, 0, pMiss)
  for (const [d, p] of hit) addScaled(out, d, p * pHit)
  for (const [d, p] of crit) addScaled(out, d, p * pCrit)
  return withChance(out, occurrenceChance(attack))
}

// ── attacks + correlated riders ──────────────────────────────────────────────

/** One way a source can resolve: its landing, whether it deals damage, its probability (`chance` included) and the damage it deals then. */
interface SourceBranch {
  landing: Landing
  dealt: boolean
  /** Only where a grant asked for `dealing`: whether the row's damage of that type was above 0. */
  typeDealt?: boolean
  /** A hit or a crit that used up a `vulnerability`: its damage was doubled, and so is the damage of every rider that lands on it. */
  vulnerable?: boolean
  p: number
  outcomes: Map<number, number>
}

const NO_DAMAGE: Map<number, number> = new Map([[0, 1]])

/** A source that does not happen: nothing lands and nothing is dealt. */
const NOT_HAPPENING: SourceBranch[] = [{ landing: 'none', dealt: false, p: 1, outcomes: NO_DAMAGE }]

/** `outcomes` as one branch of `landing`, or two when some of its damage is 0 and some is not: a trigger may need it dealt. */
function withDealt(landing: Landing, p: number, outcomes: Map<number, number>): SourceBranch[] {
  const dealt = new Map<number, number>()
  const none = new Map<number, number>()
  let dealtMass = 0
  let noneMass = 0
  for (const [damage, mass] of outcomes) {
    if (damage > 0) {
      dealt.set(damage, mass)
      dealtMass += mass
    } else {
      none.set(damage, mass)
      noneMass += mass
    }
  }
  if (noneMass === 0) return [{ landing, dealt: true, p, outcomes }]
  if (dealtMass === 0) return [{ landing, dealt: false, p, outcomes }]
  return [
    { landing, dealt: false, p: p * noneMass, outcomes: scaleMap(none, 1 / noneMass) },
    { landing, dealt: true, p: p * dealtMass, outcomes: scaleMap(dealt, 1 / dealtMass) }
  ]
}

/**
 * An attack's branches: it did not happen, missed (`missDamage` when it has a miss payload), hit, or crit. `kind` and `critOnHit` are
 * the resolved roll type and crit rule when a walk has read the state. With `vulnerable` the hit and the crit are the vulnerable
 * payloads ({@link vulnerableDicePayloads}), and what they land is tagged so the riders on it double too; a miss is as it was.
 */
function attackBranches(a: AttackSpec, kind: AdvantageKind = a.rollOverride ?? a.advantage, critOnHit = false, vulnerable = false): SourceBranch[] {
  const chance = occurrenceChance(a)
  const { pMiss, pHit, pCrit } = attackLandingProbs(a, kind, critOnHit)
  const { hit, crit } = vulnerable
    ? vulnerableDicePayloads(a.damage, a.critDamage, a.critDealsMax)
    : dicePayloads(a.damage, a.critDamage, a.critDealsMax)
  const tagged = (branches: SourceBranch[]): SourceBranch[] => (vulnerable ? branches.map((branch) => ({ ...branch, vulnerable: true })) : branches)
  return [
    ...withDealt('skipped', 1 - chance, NO_DAMAGE),
    ...withDealt(a.missDamage ? 'missDamage' : 'none', chance * pMiss, missPayload(a) ?? NO_DAMAGE),
    ...tagged(withDealt('hit', chance * pHit, hit)),
    ...tagged(withDealt('crit', chance * pCrit, crit))
  ]
}

/**
 * The distribution of a payload's damage of `type` and of the rest, for a hit or a crit, and P(the type dealt more than 0):
 * the payload's typed group is independent of the rest, so the total given the type dealt damage is that group's
 * positive totals convolved with the rest, and the total given it did not is the rest alone. A best-of-two pool spans
 * every type, so it has no such split and is refused.
 */
function typeSplit(
  spec: DiceSpec,
  crit: boolean,
  dealMax: boolean,
  type: string
): { dealt: Map<number, number>; none: Map<number, number>; pDealt: number } {
  if (spec.bestOfTwo) throw new Error('bruteForce: a best-of-two pool spans every damage type, so a trigger cannot ask whether one type dealt damage')
  const own = (spec.parts ?? []).filter((part) => part.type === type)
  const others = (spec.parts ?? []).filter((part) => part.type !== type)
  const { floorAtZero, ...unfloored } = spec
  const typed = payloadDistribution({ count: 0, sides: 1, parts: own }, crit, false, dealMax)
  const rest = payloadDistribution({ ...unfloored, parts: others }, crit, false, dealMax)
  const floor = (m: Map<number, number>): Map<number, number> => {
    if (!floorAtZero) return m
    const out = new Map<number, number>()
    for (const [v, p] of m) addScaled(out, Math.max(0, v), p)
    return out
  }
  let pDealt = 0
  const positive = new Map<number, number>()
  for (const [v, p] of typed) {
    if (v > 0) {
      addScaled(positive, v, p)
      pDealt += p
    }
  }
  return {
    dealt: floor(convolveMaps(scaleMap(positive, pDealt === 0 ? 1 : 1 / pDealt), rest)),
    none: floor(rest),
    pDealt
  }
}

/**
 * An attack's branches, each hit and crit split by whether its `type` damage was dealt (`typeDealt`), for a grant's
 * `dealing` trigger ("hit ... and deal Cold damage"). The other branches are as {@link attackBranches}; a vulnerable hit deals
 * the type whatever the enemy's scale for it, since the scales are off.
 */
function attackBranchesDealing(
  a: AttackSpec,
  type: string,
  kind: AdvantageKind = a.rollOverride ?? a.advantage,
  critOnHit = false,
  vulnerable = false
): SourceBranch[] {
  const chance = occurrenceChance(a)
  const { pMiss, pHit, pCrit } = attackLandingProbs(a, kind, critOnHit)
  const landed = (landing: 'hit' | 'crit', p: number): SourceBranch[] => {
    const critical = landing === 'crit'
    const spec = critical && a.critDamage ? a.critDamage : a.damage
    const split = typeSplit(vulnerable ? unscaled(spec) : spec, critical && !a.critDamage, critical && !a.critDamage && a.critDealsMax === true, type)
    const dealt = vulnerable ? doubledTotals(split.dealt) : split.dealt
    const none = vulnerable ? doubledTotals(split.none) : split.none
    const tag = (branch: SourceBranch, typeDealt: boolean): SourceBranch => ({ ...branch, typeDealt, ...(vulnerable ? { vulnerable: true } : {}) })
    return [
      ...withDealt(landing, p * split.pDealt, dealt).map((branch) => tag(branch, true)),
      ...withDealt(landing, p * (1 - split.pDealt), none).map((branch) => tag(branch, false))
    ]
  }
  return [
    ...withDealt('skipped', 1 - chance, NO_DAMAGE),
    ...withDealt(a.missDamage ? 'missDamage' : 'none', chance * pMiss, missPayload(a) ?? NO_DAMAGE),
    ...landed('hit', chance * pHit),
    ...landed('crit', chance * pCrit)
  ]
}

/**
 * A save's branches: it did not happen, failed, or succeeded (`saveHalf` on a half save, else nothing lands).
 * `pSuccess` is the resolved pass odds when a walk has read the state.
 */
function saveBranches(s: SaveSpec, pSuccess = saveSuccessProbability(s)): SourceBranch[] {
  const chance = occurrenceChance(s)
  return [
    ...withDealt('skipped', 1 - chance, NO_DAMAGE),
    ...withDealt('saveFail', chance * (1 - pSuccess), payloadDistribution(s.damage, false)),
    ...withDealt(s.onSuccess === 'half' ? 'saveHalf' : 'none', chance * pSuccess, saveSuccessPayload(s))
  ]
}

/** The turn order of `count` sources: `order`, a permutation of their indexes, or the indexes as they come. */
function turnOrder(order: readonly number[] | undefined, count: number): number[] {
  const indexes = Array.from({ length: count }, (_, i) => i)
  if (order === undefined) return indexes
  if (order.length !== count || [...order].sort((a, b) => a - b).some((j, i) => j !== indexes[i])) {
    throw new Error(`bruteForce: the turn order [${order.join(', ')}] is not a permutation of the ${count} sources`)
  }
  return [...order]
}

/** The source indexes a row watches, in turn order (the distinct ones, whatever order `of` lists them in). */
function watchedSources(of: readonly number[], order: readonly number[], what: string): number[] {
  for (const j of of) {
    if (!order.includes(j)) throw new Error(`bruteForce: ${what} watches source ${j}, but the turn has ${order.length}`)
  }
  return order.filter((j) => of.includes(j))
}

/** `pmf` when the row it belongs to happens with probability `chance`: the rest of the mass is damage 0. */
function thinList(pmf: Array<[number, number]>, chance: number): Array<[number, number]> {
  if (chance === 1) return pmf
  const out = new Map<number, number>()
  addScaled(out, 0, 1 - chance)
  for (const [d, p] of pmf) addScaled(out, d, p * chance)
  return [...out]
}

/** A rider as the walk reads it: the rows it watches in turn order, and its payload for each. */
interface RiderPlan {
  rows: number[]
  /** The sources where it lands only alongside a partner, and each partner with the sources it opens ({@link RiderSpec.alongside}). */
  alongside?: { rows: ReadonlySet<number>; partners: Array<{ plan: RiderPlan; rows: ReadonlySet<number> }> }
  trigger: LandingTrigger
  onCrit: boolean
  max: number
  chance: number
  payloads: Map<number, RiderPayload>
  /** The rows whose own damage roll the rider's dice join ({@link RiderSpec.pooledOn}). */
  pooled: ReadonlySet<number>
  /** The rider's payload spec on each row it watches. */
  specs: ReadonlyMap<number, DiceSpec>
  /**
   * Where a grant asks whether a damage type was dealt (`GrantSpec.dealing`): the payload on each row split into the typed damage of
   * that type and the rest, for a payload that has a part of the type. A rider with none deals none of it and has no entry.
   */
  typed: Map<number, { hit: TypedPayload; crit: TypedPayload }>
}

/** What a rider deals when a given row is the one it lands on, in each mode, and the same when that landing row's hit used up a vulnerability. */
interface RiderPayload {
  hit: Array<[number, number]>
  crit: Array<[number, number]>
  vulnerable: { hit: Array<[number, number]>; crit: Array<[number, number]> }
}

/** A payload as the damage of one type and the rest, each its own distribution: they are rolled apart and add up to the payload. */
interface TypedPayload {
  typed: Array<[number, number]>
  rest: Array<[number, number]>
}

/** What a rider's walk has decided about its payload on a row: whether it dealt the asked type, and whether it dealt any damage (each `undefined` until something depended on it). */
interface RiderFate {
  typed?: boolean
  woke?: boolean
}

/** The payload on a row split into the damage of `type` and the rest, plain and doubled by a crit; `undefined` when it has no part of that type. */
function riderTypedPayload(spec: DiceSpec, type: string, dealMax = false): { hit: TypedPayload; crit: TypedPayload } | undefined {
  const own = (spec.parts ?? []).filter((part) => part.type === type)
  if (own.length === 0) return undefined
  if (spec.bestOfTwo || spec.floorAtZero)
    throw new Error('bruteForce: a rider whose payload is a best-of-two pool or floored cannot be asked whether it dealt a type')
  const others = (spec.parts ?? []).filter((part) => part.type !== type)
  const split = (crit: boolean): TypedPayload => ({
    typed: [...payloadDistribution({ count: 0, sides: 1, parts: own }, crit, false, crit && dealMax)],
    rest: [...payloadDistribution({ ...spec, parts: others }, crit, false, crit && dealMax)]
  })
  return { hit: split(false), crit: split(true) }
}

/** `split` conditioned on what the walk decided: the typed damage above 0 or not, and the whole above 0 or not. */
function payloadGiven(split: TypedPayload, fate: RiderFate): Array<[number, number]> {
  const out = new Map<number, number>()
  let mass = 0
  for (const [t, pt] of split.typed) {
    if (fate.typed !== undefined && t > 0 !== fate.typed) continue
    for (const [r, pr] of split.rest) {
      if (fate.woke !== undefined && t + r > 0 !== fate.woke) continue
      addScaled(out, t + r, pt * pr)
      mass += pt * pr
    }
  }
  return [...out].map(([damage, p]): [number, number] => [damage, p / mass])
}

/** The part of a payload that deals damage (`positive`) or does not (0 or less), as a distribution of its own (mass 1). */
function payloadPart(payload: Array<[number, number]>, positive: boolean): Array<[number, number]> {
  const part = payload.filter(([damage]) => damage > 0 === positive)
  const mass = part.reduce((sum, [, p]) => sum + p, 0)
  return part.map(([damage, p]) => [damage, p / mass])
}

/** P(a payload deals damage: more than 0). */
function payloadDealsDamage(payload: Array<[number, number]>): number {
  return payload.reduce((sum, [damage, p]) => (damage > 0 ? sum + p : sum), 0)
}

/** Whether a row that resolved as `landing`, dealing damage or not (`dealt`), is a landing for the rider: its trigger, and a crit for an On Crit rider. */
function riderLandsOn(rider: RiderPlan, landing: Landing, dealt: boolean): boolean {
  return landsOn(landing, dealt, rider.trigger) && (!rider.onCrit || landing === 'crit')
}

/**
 * Whether `rider` lands on source `row`, which resolved as `branch`, given how the rows before it resolved (`landings`): it lands for its
 * trigger, and on a row where it lands only alongside a partner ({@link RiderSpec.alongside}), a partner applies on that row too.
 */
function riderLandsAt(rider: RiderPlan, row: number, branch: SourceBranch, landings: readonly SourceBranch[]): boolean {
  if (!riderLandsOn(rider, branch.landing, branch.dealt)) return false
  if (!rider.alongside?.rows.has(row)) return true
  return rider.alongside.partners.some(({ plan, rows }) => rows.has(row) && riderAppliesOn(plan, row, branch, landings))
}

/**
 * The payload a rider lands with on a row that resolved as `branch`: a crit doubles its dice, except a `cast` rider's (an On Crit one
 * always lands as a crit); a hit that used up a vulnerability (`branch.vulnerable`) doubles the rider's damage with the rest of the attack's,
 * but not a `cast` rider's, which is dealt on its own.
 */
function riderPayloadOf(rider: RiderPlan, row: number, branch: Pick<SourceBranch, 'landing' | 'vulnerable'>): Array<[number, number]> {
  const payload = rider.payloads.get(row)!
  // A `cast` rider is not the attack's damage (a crit does not double it and a vulnerability does not either).
  const ofTheAttack = rider.onCrit || rider.trigger !== 'cast'
  const modes = branch.vulnerable && ofTheAttack ? payload.vulnerable : payload
  return branch.landing === 'crit' && ofTheAttack ? modes.crit : modes.hit
}

/**
 * The first `max` landings of `rider` among the rows it watches, in turn order, each in its own mode: their damage and how many there
 * were. `fateOf(row)` says that the walk has already decided whether the payload on that row dealt damage (the rider woke a creature
 * that damage ends, or did not), and then the payload is the part of it that fits.
 */
function riderApplications(
  rider: RiderPlan,
  landings: readonly SourceBranch[],
  fateOf: (row: number) => RiderFate | undefined = () => undefined
): { pmf: Array<[number, number]>; applied: number } {
  let applied = 0
  let pmf: Array<[number, number]> = [[0, 1]]
  for (const row of rider.rows) {
    if (applied >= rider.max) break
    const branch = landings[row]!
    const { landing } = branch
    if (!riderLandsAt(rider, row, branch, landings)) continue
    applied++
    // Its dice are in the row's own roll there.
    if (rider.pooled.has(row)) continue
    const payload = riderPayloadOf(rider, row, branch)
    const fate = fateOf(row)
    const split = rider.typed.get(row)
    const asMode = landing === 'crit' && (rider.onCrit || rider.trigger !== 'cast') ? 'crit' : 'hit'
    pmf = convolveLists(pmf, fate === undefined ? payload : split ? payloadGiven(split[asMode], fate) : payloadPart(payload, fate.woke === true))
  }
  return { pmf, applied }
}

/** What the walk has decided about riders along a path, where the creature a rider's damage could wake made it matter. */
interface RiderFates {
  /** `<rider>:<source row>` to what the walk decided about the rider's payload on that row: whether it dealt the asked type, whether it dealt damage. */
  fates: ReadonlyMap<string, RiderFate>
  /** Rider to whether it happens at all this turn (its `chance`), decided where it first mattered. */
  coins: ReadonlyMap<number, boolean>
}

/**
 * The riders, on-crit rows and dependent rows of a turn, and the damage they add for a pattern of landings (`landings`
 * indexed by source, every source resolved). They read only how the sources landed, never their damage totals.
 */
function landingPlans(
  turn: SyntheticTurn,
  order: readonly number[],
  askedType: string | undefined
): {
  riderPlans: RiderPlan[]
  riderDamage: (landings: readonly SourceBranch[], decided: RiderFates) => Array<[number, number]>
  riderContribution: (i: number, landings: readonly SourceBranch[], decided: RiderFates) => { pmf: Array<[number, number]>; applied: number }
} {
  const { onCritRows = [], riders = [], dependents = [] } = turn
  const onCrit = onCritRows.map((r, i) => ({ rows: watchedSources(r.of, order, `on-crit row ${i}`), pmf: [...dicePayloads(r.damage).crit] }))
  const riderPlans: RiderPlan[] = riders.map((r, i) => {
    const max = r.max ?? 1
    if (!(max >= 1) || (max !== Infinity && !Number.isInteger(max)))
      throw new Error(`bruteForce: rider ${i} applies ${max} times, not a whole number >= 1`)
    const rows = watchedSources(r.of, order, `rider ${i}`)
    const payloads = new Map<number, RiderPayload>()
    const specs = new Map<number, DiceSpec>()
    const typed = new Map<number, { hit: TypedPayload; crit: TypedPayload }>()
    for (const row of rows) {
      const spec = typeof r.damage === 'function' ? r.damage(row) : r.damage
      specs.set(row, spec)
      // A rider is damage of the attack it lands on, so a crit of an attack that deals Max + roll (`critDealsMax`) deals its dice the
      // same way. A `cast` rider is not the attack's damage and never takes a crit's mode, so it never gets the rule (and its unused crit payload is never built under it).
      const ofTheAttack = r.onCrit === true || r.trigger !== 'cast'
      const dealMax = ofTheAttack && row < turn.attacks.length && turn.attacks[row]!.critDealsMax === true && !turn.attacks[row]!.critDamage
      const { hit, crit } = dicePayloads(spec, undefined, dealMax)
      const vulnerable = vulnerableDicePayloads(spec, undefined, dealMax)
      payloads.set(row, { hit: [...hit], crit: [...crit], vulnerable: { hit: [...vulnerable.hit], crit: [...vulnerable.crit] } })
      const split = askedType === undefined ? undefined : riderTypedPayload(spec, askedType, dealMax)
      if (split) typed.set(row, split)
    }
    const pooled = new Set(r.pooledOn ?? [])
    for (const row of pooled) {
      if (!rows.includes(row)) throw new Error(`bruteForce: rider ${i} is pooled on source ${row}, which it does not watch`)
      if (row >= turn.attacks.length)
        throw new Error(`bruteForce: rider ${i} is pooled on source ${row}, which is a save: only an attack roll has dice to join`)
      if (turn.attacks[row]!.critDamage) throw new Error(`bruteForce: rider ${i} is pooled on source ${row}, which has an explicit crit payload`)
    }
    if (pooled.size > 0 && r.trigger === 'cast') throw new Error(`bruteForce: rider ${i} is pooled but its trigger is cast, which lands on a miss`)
    return { rows, trigger: r.trigger, onCrit: r.onCrit === true, max, chance: occurrenceChance(r), payloads, typed, pooled, specs }
  })
  riders.forEach((r, i) => {
    if (!r.alongside) return
    if ((r.max ?? 1) !== 1) throw new Error(`bruteForce: rider ${i} lands alongside a partner, so it lands once`)
    const partners = r.alongside.map(({ rider: p, sources }) => {
      if (p === i || !riders[p] || riders[p]!.alongside)
        throw new Error(`bruteForce: rider ${i} lands alongside ${p}, which is not another plain rider`)
      if (occurrenceChance(riders[p]!) !== 1) throw new Error(`bruteForce: rider ${i} lands alongside ${p}, which does not happen on every turn`)
      const rows = new Set(watchedSources(sources, order, `rider ${i} alongside ${p}`))
      for (const row of rows) {
        if (!riderPlans[i]!.rows.includes(row))
          throw new Error(`bruteForce: rider ${i} lands alongside ${p} on source ${row}, which it does not watch`)
        if (!riderPlans[p]!.rows.includes(row))
          throw new Error(`bruteForce: rider ${i} lands alongside ${p} on source ${row}, which ${p} does not watch`)
      }
      return { plan: riderPlans[p]!, rows }
    })
    riderPlans[i]!.alongside = { rows: new Set(partners.flatMap(({ rows }) => [...rows])), partners }
  })
  const dependent = dependents.map((d, i) => {
    if ([d.damage, d.attack, d.save].filter((x) => x !== undefined).length !== 1) {
      throw new Error('bruteForce: a dependent row needs exactly one of damage, attack and save')
    }
    const pmf = d.damage ? payloadDistribution(d.damage, false) : d.attack ? enumerateSingleAttack(d.attack) : enumerateSave(d.save!)
    return { rows: watchedSources(d.of, order, `dependent row ${i}`), trigger: d.trigger, pmf: [...pmf] }
  })

  /**
   * What rider `i` adds along a path: nothing if it never landed or did not happen, else its payloads. Its `chance` is a coin for the
   * whole turn: where the walk decided it (`coins`) that is used, otherwise it thins the result.
   */
  const riderContribution = (
    i: number,
    landings: readonly SourceBranch[],
    decided: RiderFates
  ): { pmf: Array<[number, number]>; applied: number } => {
    const rider = riderPlans[i]!
    const { pmf, applied } = riderApplications(rider, landings, (row) => decided.fates.get(`${i}:${row}`))
    if (applied === 0) return { pmf: [[0, 1]], applied }
    const coin = decided.coins.get(i)
    return { pmf: coin === undefined ? thinList(pmf, rider.chance) : coin ? pmf : [[0, 1]], applied }
  }

  const riderCache = new Map<string, Array<[number, number]>>()
  const riderDamage = (landings: readonly SourceBranch[], decided: RiderFates): Array<[number, number]> => {
    const key = [
      landings.map((l) => `${l.landing}${l.dealt ? '+' : '-'}${l.vulnerable ? 'v' : ''}`).join(),
      [...decided.fates]
        .map(([where, fate]) => `${where}=${fate.typed}/${fate.woke}`)
        .sort()
        .join(),
      [...decided.coins].sort().join()
    ].join('|')
    const cached = riderCache.get(key)
    if (cached) return cached
    let out: Array<[number, number]> = [[0, 1]]
    for (const oc of onCrit) {
      if (oc.rows.some((j) => landings[j]!.landing === 'crit')) out = convolveLists(out, oc.pmf)
    }
    riderPlans.forEach((_, i) => {
      const { pmf, applied } = riderContribution(i, landings, decided)
      if (applied > 0) out = convolveLists(out, pmf)
    })
    for (const dep of dependent) {
      if (dep.rows.some((j) => landsOn(landings[j]!.landing, landings[j]!.dealt, dep.trigger))) out = convolveLists(out, dep.pmf)
    }
    riderCache.set(key, out)
    return out
  }
  return { riderPlans, riderDamage, riderContribution }
}

// ── riders whose dice join a row's roll ──────────────────────────────────────

/** The smallest reroll budget among the parts of `spec` that carry one and roll dice: the budget of the pool its dice make (`undefined`: no pool). */
function poolBudget(spec: DiceSpec): number | undefined {
  const budgets = [spec.count > 0 ? spec.rerollDice : undefined, ...(spec.parts ?? []).map((part) => (part.count > 0 ? part.rerollDice : undefined))]
  const carried = budgets.filter((budget): budget is number => budget !== undefined)
  return carried.length === 0 ? undefined : Math.min(...carried)
}

/** A rider's dice as parts of a row's roll: its untyped dice as one part, then its typed parts, each in the row's reroll pool (`budget`) when it has one. */
function ridersDiceAsParts(spec: DiceSpec, budget: number | undefined): PartSpec[] {
  if (spec.bestOfTwo) throw new Error('bruteForce: a rider whose own dice are a best-of-two pool cannot join a row')
  const join = budget === undefined ? {} : { rerollDice: budget }
  const parts: PartSpec[] = []
  if (spec.count > 0 || (spec.flat ?? 0) !== 0) {
    parts.push({
      count: spec.count,
      sides: spec.sides,
      ...(spec.flat !== undefined ? { flat: spec.flat } : {}),
      ...(spec.minimumDie !== undefined ? { minimumDie: spec.minimumDie } : {}),
      ...(spec.rerollBelow !== undefined ? { rerollBelow: spec.rerollBelow } : {}),
      ...join
    })
  }
  for (const part of spec.parts ?? []) parts.push({ ...part, ...join })
  return parts
}

/**
 * An attack's damage on a hit (or a crit) when the riders `joined` roll their dice with it, each happening with its own `chance`: the
 * riders that happen add their dice to the attack's parts, in its reroll pool, and the roll is one (a crit doubles every die, the budget
 * stays). The row must always deal damage on a hit and on a crit: a rider that lands where the row's own damage is 0 would need the
 * joint split by it, which no rider needs.
 */
function joinedAttackDamage(a: AttackSpec, crit: boolean, joined: readonly RiderPlan[], row: number): Map<number, number> {
  if (a.damage.bestOfTwo) throw new Error('bruteForce: a rider cannot join a best-of-two row')
  const own = payloadDistribution(a.damage, crit, false, crit && a.critDealsMax === true)
  if ([...own.keys()].some((damage) => damage <= 0)) throw new Error('bruteForce: a rider joins only a row whose hit and crit always deal damage')
  const budget = poolBudget(a.damage)
  const out = new Map<number, number>()
  for (let mask = 0; mask < 1 << joined.length; mask++) {
    let p = 1
    const parts: PartSpec[] = []
    joined.forEach((rider, j) => {
      if (mask & (1 << j)) {
        p *= rider.chance
        parts.push(...ridersDiceAsParts(rider.specs.get(row)!, budget))
      } else p *= 1 - rider.chance
    })
    if (p === 0) continue
    const spec: DiceSpec = { ...a.damage, parts: [...(a.damage.parts ?? []), ...parts] }
    for (const [damage, q] of payloadDistribution(spec, crit, false, crit && a.critDealsMax === true)) addScaled(out, damage, p * q)
  }
  return out
}

// ── conditional grants: path enumeration ─────────────────────────────────────
//
// The walk below is the definition of the grant semantics, written as plainly as possible: a path is the sequence of
// row outcomes so far, carrying an explicit list of the effects that are active and a flag per `once` grant. Every
// branch (a row outcome, a grant that lands, a grant's save or chance) copies that state and recurses. No masks, no
// merging of paths, no shared tables.

/** An effect a grant put on a creature: which grant, which of its two effect lists and which entry, and the effect. */
interface EffectInstance {
  grant: number
  branch: 'effects' | 'onPass'
  /** The entry of the grant's list; `-1 - entry` for the lasting Prone an `until-damaged` Unconscious leaves behind. */
  index: number
  /** The creature it is on, or `any` for an attacker-side next-attack effect (`against: 'any'`), which every creature's rows read. */
  creature: number | 'any'
  spec: EffectSpec
}

interface PathState extends RiderFates {
  active: readonly EffectInstance[]
  /** Per grant: it has been tried this turn (read by `cap: 'once'`). */
  tried: readonly boolean[]
}

/** What a row is when it reads effects: the side it rolls on, its source index (for `to`), its range and, on a save, its ability. */
interface ReadContext {
  side: 'attack' | 'save'
  sourceIndex: number
  range: 'melee' | 'ranged'
  ability: SaveAbilityName | undefined
}

/** One thing a read effect gives the row, and where it came from (`starting` or `grant:<index>`). */
interface Contribution {
  effect: EffectName
  source: string
  dice?: { count: number; sides: number }
}

const EFFECT_NAMES: readonly EffectName[] = ['advantage', 'disadvantage', 'critOnHit', 'autoFail', 'saveDisadvantage', 'savePenalty', 'vulnerable']

/** What a condition gives a row that reads it. */
function conditionContributions(condition: ConditionName, ctx: ReadContext): EffectName[] {
  const melee = ctx.range === 'melee'
  if (ctx.side === 'attack') {
    switch (condition) {
      case 'blinded':
      case 'restrained':
      case 'stunned':
        return ['advantage']
      case 'paralyzed':
        return melee ? ['advantage', 'critOnHit'] : ['advantage']
      case 'prone':
        return [melee ? 'advantage' : 'disadvantage']
      // 2024 Unconscious: "You have the Incapacitated and Prone conditions ... Attack rolls against you have Advantage. Any attack
      // roll that hits you is a Critical Hit if the attacker is within 5 feet of you." Prone is what makes a ranged attack roll
      // "have Disadvantage" ("Otherwise"), and it meets the Advantage above, so the two cancel to a plain d20.
      case 'unconscious':
        return melee ? ['advantage', 'critOnHit'] : ['advantage', 'disadvantage']
    }
  }
  const strengthOrDexterity = ctx.ability === 'strength' || ctx.ability === 'dexterity'
  switch (condition) {
    // "You automatically fail Strength and Dexterity saving throws."
    case 'paralyzed':
    case 'stunned':
    case 'unconscious':
      return strengthOrDexterity ? ['autoFail'] : []
    case 'restrained':
      return ctx.ability === 'dexterity' ? ['saveDisadvantage'] : []
    default:
      return []
  }
}

/**
 * Everything a row on `creature` reads at its start: the starting condition (creature 0 only) and the active effects on
 * the creature that this kind of row reads. `consumed` are the read effects that last until the next attack roll, and
 * `consumedOnHit` those that last until the next attack that hits (a miss leaves them).
 */
function readEffects(
  ctx: ReadContext,
  creature: number,
  startingCondition: ConditionName | undefined,
  active: readonly EffectInstance[]
): { contributions: Contribution[]; consumed: EffectInstance[]; consumedOnHit: EffectInstance[] } {
  const contributions: Contribution[] = []
  const consumed: EffectInstance[] = []
  const consumedOnHit: EffectInstance[] = []
  if (creature === 0 && startingCondition !== undefined) {
    for (const effect of conditionContributions(startingCondition, ctx)) contributions.push({ effect, source: 'starting' })
  }
  for (const instance of active) {
    if (instance.creature !== creature && instance.creature !== 'any') continue
    const source = `grant:${instance.grant}`
    const spec = instance.spec
    switch (spec.kind) {
      case 'condition':
        for (const effect of conditionContributions(spec.condition, ctx)) contributions.push({ effect, source })
        break
      case 'advantage':
      case 'disadvantage':
      case 'critOnHit':
        if (ctx.side !== 'attack') break
        if (spec.to !== undefined && !spec.to.includes(ctx.sourceIndex)) break
        contributions.push({ effect: spec.kind, source })
        if (spec.lifetime === 'next-attack') consumed.push(instance)
        break
      case 'saveDisadvantage':
        if (ctx.side !== 'save') break
        if (spec.to !== undefined && !spec.to.includes(ctx.sourceIndex)) break
        contributions.push({ effect: 'saveDisadvantage', source })
        if (spec.lifetime === 'next-save') consumed.push(instance)
        break
      case 'savePenalty':
        if (ctx.side !== 'save') break
        if (spec.to !== undefined && !spec.to.includes(ctx.sourceIndex)) break
        contributions.push({ effect: 'savePenalty', source, dice: { count: spec.count, sides: spec.sides } })
        if (spec.lifetime === 'next-save') consumed.push(instance)
        break
      case 'vulnerability':
        if (ctx.side !== 'attack') break
        contributions.push({ effect: 'vulnerable', source })
        consumedOnHit.push(instance)
        break
    }
  }
  return { contributions, consumed, consumedOnHit }
}

function contributes(contributions: readonly Contribution[], effect: EffectName): boolean {
  return contributions.some((c) => c.effect === effect)
}

/**
 * The roll type from a base and whether the state gives advantage and disadvantage: any of each cancels to a flat roll.
 * An attacker with Elven Accuracy (`elvenAccuracy`) rolls three dice for an advantage the state gives.
 */
function combineRollTypes(base: AdvantageKind, advantage: boolean, disadvantage: boolean, elvenAccuracy = false): AdvantageKind {
  const advantageSide = base === 'advantage' || base === 'elven' || advantage
  const disadvantageSide = base === 'disadvantage' || disadvantage
  if (advantageSide && disadvantageSide) return 'flat'
  if (disadvantageSide) return 'disadvantage'
  if (advantageSide) return base === 'elven' || (advantage && elvenAccuracy) ? 'elven' : 'advantage'
  return base
}

/** The total of the penalty dice the contributions carry: every die of every one, exact. */
function penaltyDistribution(contributions: readonly Contribution[]): Map<number, number> {
  return convolveAll(contributions.flatMap((c) => (c.dice ? [diceSumDistribution(c.dice.count, c.dice.sides)] : [])))
}

/**
 * Whether the branch is a landing for the grant's trigger: a hit, a crit and a miss need an attack row, the save triggers need
 * a save row, `dealing` needs that type dealt, a `kill` never lands (no hit points), and a rider's trigger lands where the
 * rider applies (`riderApplies`, asked only for that trigger).
 */
function grantLands(grant: GrantSpec, isSave: boolean, branch: SourceBranch, riderApplies: () => boolean): boolean {
  if (grant.dealing !== undefined && branch.typeDealt !== true) return false
  switch (grant.trigger) {
    case 'hit':
      return !isSave && landsOn(branch.landing, branch.dealt, 'hit')
    case 'crit':
      return !isSave && branch.landing === 'crit'
    case 'miss':
      // A miss that deals its miss payload is still a miss. A save row never misses, and a row that did not happen is no miss.
      return !isSave && (branch.landing === 'none' || branch.landing === 'missDamage')
    case 'damage':
      return landsOn(branch.landing, branch.dealt, 'damage')
    case 'failedSave':
      return isSave && branch.landing === 'saveFail'
    case 'passedSave':
      return isSave && (branch.landing === 'saveHalf' || branch.landing === 'none')
    case 'kill':
      return false
    case 'start':
      // In force before the first row: no row lands it.
      return false
    case 'rider':
      return riderApplies()
  }
}

/**
 * Whether `rider` applies on source `s`, which resolved as `branch`: among the rows it watches, in turn order, `s` lands for
 * its trigger and fewer than `max` landings came before it. `landings` holds the rows resolved so far on this path.
 */
function riderAppliesOn(rider: RiderPlan, s: number, branch: SourceBranch, landings: readonly SourceBranch[]): boolean {
  if (!rider.rows.includes(s)) return false
  let earlier = 0
  for (const row of rider.rows) {
    if (row === s) return earlier < rider.max && riderLandsAt(rider, s, branch, landings)
    const before = landings[row]!
    if (riderLandsAt(rider, row, before, landings)) earlier++
  }
  return false
}

/** Effects that last the rest of the turn (everything but a next-attack advantage, disadvantage or crit, a next-save effect and a condition that damage ends). */
function lastsTheTurn(effect: EffectSpec): boolean {
  if (effect.kind === 'condition') return effect.lifetime !== 'until-damaged'
  if (effect.kind === 'saveDisadvantage' || effect.kind === 'savePenalty') return effect.lifetime !== 'next-save'
  return effect.lifetime === 'turn'
}

/** What a row reads with: the side it rolls on, its source index (for `to`), its range and, on a save, its ability. */
function readContextOf(row: WalkRow, index: number): ReadContext {
  return row.kind === 'attack'
    ? { side: 'attack', sourceIndex: index, range: row.attack.range ?? 'melee', ability: undefined }
    : { side: 'save', sourceIndex: index, range: 'melee', ability: row.save.ability }
}

/**
 * Whether row `index` would take something from `effect` at its start (what {@link readEffects} gathers): a condition
 * only if it contributes to that row (Blinded gives a save row nothing, Paralyzed gives a strength or dexterity save an
 * automatic fail); advantage, disadvantage and critOnHit to attack rows that `to` lists; saveDisadvantage and
 * savePenalty, next-save ones included, to save rows.
 */
function rowReads(row: WalkRow, index: number, effect: EffectSpec): boolean {
  switch (effect.kind) {
    case 'condition':
      return conditionContributions(effect.condition, readContextOf(row, index)).length > 0
    case 'advantage':
    case 'disadvantage':
    case 'critOnHit':
      return row.kind === 'attack' && (effect.to === undefined || effect.to.includes(index))
    case 'saveDisadvantage':
    case 'savePenalty':
      return row.kind === 'save' && (effect.to === undefined || effect.to.includes(index))
    case 'vulnerability':
      return row.kind === 'attack'
  }
}

/** Whether the effect is the attacker's (`against: 'any'`): no creature owns it, and the next attack at any creature reads it. */
function isAttackerSide(effect: EffectSpec): boolean {
  return (effect.kind === 'advantage' || effect.kind === 'disadvantage' || effect.kind === 'critOnHit') && effect.against === 'any'
}

/** Whether damage to `creature` ends the instance: an `until-damaged` condition on that creature. */
function endsOnDamage(instance: EffectInstance, creature: number): boolean {
  return instance.creature === creature && instance.spec.kind === 'condition' && instance.spec.lifetime === 'until-damaged'
}

/**
 * The instances entry `e` of a grant's list puts on a creature. An `until-damaged` Unconscious also leaves a Prone that
 * damage does not end: 2024 Unconscious, "When this condition ends, you remain Prone" (2014: an unconscious creature "falls
 * prone"). The remainder has its own entry number, `-1 - e`, so the two come and go on their own.
 */
function instancesOf(spec: EffectSpec, e: number): Array<[number, EffectSpec]> {
  if (spec.kind === 'condition' && spec.condition === 'unconscious' && spec.lifetime === 'until-damaged') {
    return [
      [e, spec],
      [-1 - e, { kind: 'condition', condition: 'prone' }]
    ]
  }
  return [[e, spec]]
}

function validateGrants(
  grants: readonly GrantSpec[],
  sourceCount: number,
  riders: readonly RiderSpec[],
  startingCondition: ConditionName | undefined
): void {
  if (startingCondition === 'unconscious') throw new Error('bruteForce: a starting condition cannot be unconscious, which a damaging row ends')
  const types = new Set(grants.flatMap((g) => (g.dealing === undefined ? [] : [g.dealing])))
  if (types.size > 1) throw new Error(`bruteForce: the grants name more than one damage type to deal (${[...types].join(', ')})`)
  grants.forEach((g, i) => {
    const what = `grant ${i}`
    for (const j of g.of) {
      if (!Number.isInteger(j) || j < 0 || j >= sourceCount)
        throw new Error(`bruteForce: ${what} watches source ${j}, but the turn has ${sourceCount}`)
    }
    if (g.chance !== undefined && !(g.chance >= 0 && g.chance <= 1))
      throw new Error(`bruteForce: ${what} has a chance outside [0, 1], got ${g.chance}`)
    if (g.save !== undefined && g.chance !== undefined) throw new Error(`bruteForce: ${what} has both a save and a chance`)
    if (g.onPass !== undefined && g.save === undefined && g.chance === undefined)
      throw new Error(`bruteForce: ${what} has onPass but neither a save nor a chance`)
    if (g.effects.length === 0) throw new Error(`bruteForce: ${what} has no effects`)
    if (g.dealing !== undefined && g.trigger !== 'hit' && g.trigger !== 'damage' && g.trigger !== 'crit')
      throw new Error(`bruteForce: ${what} asks for ${g.dealing} damage on a ${g.trigger} trigger`)
    if (g.trigger === 'start') {
      if (g.save !== undefined || g.chance !== undefined || g.onPass !== undefined)
        throw new Error(`bruteForce: ${what} starts in force, so it has no save, chance or onPass`)
      if (g.cap !== 'once') throw new Error(`bruteForce: ${what} starts in force and is never tried, so its cap is once`)
    }
    if (g.trigger === 'rider') {
      const rider = g.rider === undefined ? undefined : riders[g.rider]
      if (rider === undefined) throw new Error(`bruteForce: ${what} has a rider trigger but names no rider of the turn (${g.rider})`)
      if (rider.chance !== undefined && rider.chance !== 1)
        throw new Error(`bruteForce: ${what} is coupled to a rider with a chance of ${rider.chance}, which this walk does not model`)
      for (const j of g.of) {
        if (!rider.of.includes(j)) throw new Error(`bruteForce: ${what} watches source ${j}, which its rider does not`)
      }
    } else if (g.rider !== undefined) {
      throw new Error(`bruteForce: ${what} names a rider but its trigger is ${g.trigger}`)
    }
    for (const alternative of g.save?.alternatives ?? []) {
      if (g.save!.ability === undefined) throw new Error(`bruteForce: ${what} lists alternative save abilities but no ability of its own`)
      if (alternative.ability === g.save!.ability) throw new Error(`bruteForce: ${what} lists ${alternative.ability} twice`)
    }
    for (const effect of [...g.effects, ...(g.onPass ?? [])]) {
      if (effect.kind === 'savePenalty' && !(effect.count >= 1 && effect.sides >= 1)) {
        throw new Error(`bruteForce: ${what} has a save penalty of ${effect.count}d${effect.sides}`)
      }
      if ('to' in effect) {
        for (const j of effect.to ?? []) {
          if (!Number.isInteger(j) || j < 0 || j >= sourceCount)
            throw new Error(`bruteForce: ${what} scopes an effect to source ${j}, but the turn has ${sourceCount}`)
        }
      }
    }
  })
}

/** A row of the turn as the walk sees it. */
type WalkRow = { kind: 'attack'; attack: AttackSpec; creature: number } | { kind: 'save'; save: SaveSpec; creature: number }

/**
 * The joint outcome of every attack and save, with the riders and dependent rows that watch them. Each source resolves
 * to a {@link Landing} with its own damage; riders and dependent rows read only which sources landed and how, never
 * their damage totals. The turn is walked in turn order (a row reads what the rows before it granted, and a save gated on
 * a parent reads the parent's landing), one path at a time, carrying the grants' active effects and their `once` flags
 * (see {@link GrantSpec}, the condition effects and the starting condition). With no grants the state stays empty and
 * the walk is the plain joint of the sources' branches. `landings` is filled by source index and a rider reads it once
 * every source has resolved. `perSource` accumulates each source's own marginal damage, exact whatever the correlations
 * between sources; with `wantDetail` the per-row roll types, effect odds and the riders' marginals are gathered too.
 */
function enumerateSourcesWithRiders(
  turn: SyntheticTurn,
  wantDetail: boolean
): { pmf: Map<number, number>; perSource: Array<Map<number, number>>; detail: EnumerationDetail | undefined } {
  const grants = turn.grants ?? []
  const rows: WalkRow[] = [
    ...turn.attacks.map((attack): WalkRow => ({ kind: 'attack', attack, creature: attack.target ?? 0 })),
    ...(turn.saves ?? []).map((save): WalkRow => ({ kind: 'save', save, creature: save.target ?? 0 }))
  ]
  const order = turnOrder(turn.order, rows.length)
  validateGrants(grants, rows.length, turn.riders ?? [], turn.startingCondition)
  const { riderPlans, riderDamage, riderContribution } = landingPlans(turn, order, grants.find((g) => g.dealing !== undefined)?.dealing)

  // The damage type a grant asks about, and the rows whose hits are split by whether it was dealt.
  const askedType = grants.find((g) => g.dealing !== undefined)?.dealing
  const typedRows = new Set(grants.filter((g) => g.dealing !== undefined).flatMap((g) => g.of))
  // A row's branches depend only on the roll type, the crit rule and the pass odds the state gives it: build each once.
  const branchCache = new Map<string, SourceBranch[]>()
  const cached = (key: string, build: () => SourceBranch[]): SourceBranch[] => {
    let branches = branchCache.get(key)
    if (!branches) {
      branches = build()
      branchCache.set(key, branches)
    }
    return branches
  }

  // A row's joint roll with the riders that roll their dice with it, by the landing and the riders.
  const jointCache = new Map<string, Map<number, number>>()
  const perSource: Array<Map<number, number>> = rows.map(() => new Map())
  const rowDetail: RowDetail[] = rows.map(() => ({
    rollType: { flat: 0, advantage: 0, disadvantage: 0, elven: 0 },
    effects: Object.fromEntries(EFFECT_NAMES.map((name) => [name, { odds: 0, sources: new Map<string, number>() }])) as Record<
      EffectName,
      EffectOddsDetail
    >
  }))
  const riderDetail: RiderDetail[] = riderPlans.map(() => ({ pmf: new Map(), landing: 0 }))

  const result = new Map<number, number>()
  const landings: SourceBranch[] = new Array<SourceBranch>(rows.length)

  /**
   * The ways source `s`, resolved as `branch`, leaves the creature it targets with or without damage from a rider, and the row with
   * or without the damage type a grant asks about (`GrantSpec.dealing`) dealt by a rider. A row that dealt damage has woken the
   * creature already, and with no condition damage ends on the creature nothing depends on the rider's damage; a hit that dealt the
   * asked type needs nothing from it either. Otherwise each rider that applies on this row (it lands for its trigger, within its
   * `max`) damages the creature when it happens (its `chance`, one coin for the turn) and its payload on this row is above 0 (after the
   * enemy's scale; a crit doubles the dice for a rider that is not `cast`), and it deals the asked type when the part of its payload of
   * that type is above 0: the rider's dice are damage of the hit, and "when you hit ... and deal Cold damage" counts them. The coin
   * and the payload are decided here and recorded on the path, so the damage the rider adds at the end is the damage that fits what
   * woke the creature or did not and what the row dealt.
   */
  const riderVariants = (
    state: PathState,
    creature: number,
    s: number,
    branch: SourceBranch
  ): Array<{ p: number; woke: boolean; typed: boolean; state: PathState }> => {
    const needWake = !branch.dealt && state.active.some((instance) => endsOnDamage(instance, creature))
    const needType =
      askedType !== undefined && typedRows.has(s) && branch.typeDealt === false && (branch.landing === 'hit' || branch.landing === 'crit')
    let variants: Array<{ p: number; woke: boolean; typed: boolean; state: PathState }> = [
      { p: 1, woke: branch.dealt, typed: branch.typeDealt === true, state }
    ]
    if (!needWake && !needType) return variants
    riderPlans.forEach((plan, i) => {
      if (!riderAppliesOn(plan, s, branch, landings)) return
      const payload = riderPayloadOf(plan, s, branch)
      const split = plan.typed.get(s)
      const mode = branch.landing === 'crit' && (plan.onCrit || plan.trigger !== 'cast') ? 'crit' : 'hit'
      // What the walk may need to know of this payload: whether the asked type was dealt, whether any damage was.
      const wantType = needType && split !== undefined
      const wantWake = needWake
      if (!wantType && !wantWake) return
      // The outcomes of its payload that matter, with their odds: the asked type dealt (which is damage), damage without the type,
      // none. Without a typed part the type is never dealt.
      const outcomes: Array<{ p: number; fate: RiderFate }> = []
      if (wantType && wantWake) {
        const typedAbove = split![mode].typed.reduce((sum, [t, pt]) => (t > 0 ? sum + pt : sum), 0)
        const restAbove = split![mode].rest.reduce((sum, [r, pr]) => (r > 0 ? sum + pr : sum), 0)
        // typed damage never goes below 0 and the rest never does either, so the whole is above 0 exactly when either part is.
        outcomes.push(
          { p: typedAbove, fate: { typed: true, woke: true } },
          { p: (1 - typedAbove) * restAbove, fate: { typed: false, woke: true } },
          { p: (1 - typedAbove) * (1 - restAbove), fate: { typed: false, woke: false } }
        )
      } else if (wantType) {
        const typedAbove = split![mode].typed.reduce((sum, [t, pt]) => (t > 0 ? sum + pt : sum), 0)
        outcomes.push({ p: typedAbove, fate: { typed: true } }, { p: 1 - typedAbove, fate: { typed: false } })
      } else {
        const pDeals = payloadDealsDamage(payload)
        outcomes.push({ p: pDeals, fate: { woke: true } }, { p: 1 - pDeals, fate: { woke: false } })
      }
      const next: typeof variants = []
      for (const v of variants) {
        const decided = v.state.coins.get(i)
        const coins: Array<{ p: number; happens: boolean }> =
          decided !== undefined
            ? [{ p: 1, happens: decided }]
            : plan.chance < 1
              ? [
                  { p: plan.chance, happens: true },
                  { p: 1 - plan.chance, happens: false }
                ]
              : [{ p: 1, happens: true }]
        for (const coin of coins) {
          if (coin.p === 0) continue
          const withCoin = decided === undefined && plan.chance < 1 ? { ...v.state, coins: new Map(v.state.coins).set(i, coin.happens) } : v.state
          if (!coin.happens) {
            next.push({ p: v.p * coin.p, woke: v.woke, typed: v.typed, state: withCoin })
            continue
          }
          for (const { p, fate } of outcomes) {
            if (p === 0) continue
            next.push({
              p: v.p * coin.p * p,
              woke: v.woke || fate.woke === true || fate.typed === true,
              typed: v.typed || fate.typed === true,
              // A payload that is certain to deal damage (and, asked, a type) needs no record: nothing could be conditioned on it.
              state: p === 1 ? withCoin : { ...withCoin, fates: new Map(withCoin.fates).set(`${i}:${s}`, fate) }
            })
          }
        }
      }
      variants = next
    })
    return variants
  }

  const walk = (k: number, prob: number, state: PathState, damage: Map<number, number>): void => {
    if (k === order.length) {
      for (const [d, pd] of damage) {
        for (const [r, pr] of riderDamage(landings, state)) addScaled(result, d + r, prob * pd * pr)
      }
      if (wantDetail) {
        riderPlans.forEach((_, i) => {
          const { pmf, applied } = riderContribution(i, landings, state)
          for (const [d, pd] of pmf) addScaled(riderDetail[i]!.pmf, d, prob * pd)
          if (applied > 0) riderDetail[i]!.landing += prob
        })
      }
      return
    }
    const s = order[k]!
    const row = rows[s]!
    const ctx = readContextOf(row, s)
    const { contributions, consumed, consumedOnHit } = readEffects(ctx, row.creature, turn.startingCondition, state.active)

    let branches: SourceBranch[]
    let rollType: AdvantageKind
    if (row.kind === 'attack') {
      const a = row.attack
      const critOnHit = contributes(contributions, 'critOnHit')
      const vulnerable = contributes(contributions, 'vulnerable')
      rollType =
        a.rollOverride ??
        combineRollTypes(a.advantage, contributes(contributions, 'advantage'), contributes(contributions, 'disadvantage'), a.elvenAccuracy === true)
      branches = cached(`${s}|${rollType}|${critOnHit}|${vulnerable}`, () =>
        typedRows.has(s) && askedType !== undefined
          ? attackBranchesDealing(a, askedType, rollType, critOnHit, vulnerable)
          : attackBranches(a, rollType, critOnHit, vulnerable)
      )
    } else {
      const sv = row.save
      rollType = sv.rollOverride ?? combineRollTypes(sv.rollType ?? 'flat', false, contributes(contributions, 'saveDisadvantage'))
      const autoFail = sv.autoFail === true || contributes(contributions, 'autoFail')
      const pSuccess = autoFail ? 0 : d20PassProbability(rollType, sv.saveBonus, sv.dc, penaltyDistribution(contributions))
      branches = cached(`${s}|${pSuccess}`, () => saveBranches(sv, pSuccess))
    }

    // A save gated on a parent (Poisoner's dose) happens only where the parent landed for the gate's trigger.
    const gate = row.kind === 'save' ? row.save.gatedOn : undefined
    const gateOpen = gate === undefined || landsOn(landings[gate.source]!.landing, landings[gate.source]!.dealt, gate.trigger)
    // Whether a later row reads any effect of `grant` (either list): a later row on this row's creature, or on any creature for an
    // attacker-side effect (`against: 'any'`).
    const readerFollows = (grant: GrantSpec): boolean =>
      order
        .slice(k + 1)
        .some((j) =>
          [...grant.effects, ...(grant.onPass ?? [])].some(
            (effect) => (isAttackerSide(effect) || rows[j]!.creature === row.creature) && rowReads(rows[j]!, j, effect)
          )
        )
    /** The creature an effect of a grant fired on this row is put on: this row's, or `any` for an attacker-side effect. */
    const creatureOf = (effect: EffectSpec): number | 'any' => (isAttackerSide(effect) ? 'any' : row.creature)

    if (wantDetail) {
      const detail = rowDetail[s]!
      detail.rollType[rollType] += prob
      for (const name of EFFECT_NAMES) {
        const sources = new Set(contributions.filter((c) => c.effect === name).map((c) => c.source))
        if (sources.size === 0) continue
        detail.effects[name].odds += prob
        for (const source of sources) detail.effects[name].sources.set(source, (detail.effects[name].sources.get(source) ?? 0) + prob)
      }
    }

    for (const resolved of gateOpen ? branches : NOT_HAPPENING) {
      if (resolved.p === 0) continue
      // The riders whose dice are part of this roll (`RiderSpec.pooledOn`) land on it now, and the row's damage is the joint roll.
      let branch = resolved
      if (row.kind === 'attack' && (resolved.landing === 'hit' || resolved.landing === 'crit')) {
        const joined = riderPlans.filter((plan) => plan.pooled.has(s) && riderAppliesOn(plan, s, resolved, landings))
        if (joined.length > 0) {
          const key = `${s}|${resolved.landing}|${joined.map((plan) => riderPlans.indexOf(plan)).join()}`
          let outcomes = jointCache.get(key)
          if (!outcomes) jointCache.set(key, (outcomes = joinedAttackDamage(row.attack, resolved.landing === 'crit', joined, s)))
          branch = { ...resolved, outcomes }
        }
      }
      for (const [d, pd] of branch.outcomes) addScaled(perSource[s]!, d, prob * branch.p * pd)
      landings[s] = branch
      const rowDamage = convolveMaps(damage, branch.outcomes)
      if (!gateOpen || branch.landing === 'skipped') {
        // A row that does not happen consumes nothing and lands nowhere.
        walk(k + 1, prob * branch.p, state, rowDamage)
        continue
      }
      // The row uses up what it read (a vulnerability only if it hit: a miss leaves it for the next attack), and a row that damages
      // its creature ends the conditions that damage ends (after it read them: it still benefits). The damage is the row's own
      // (`branch.dealt`) or a rider's that lands on it (`woke`). A grant's save, made once the damage is dealt, sees the creature as
      // that leaves it.
      const hit = branch.landing === 'hit' || branch.landing === 'crit'
      for (const variant of riderVariants(state, row.creature, s, branch)) {
        // A rider that deals the asked type makes the row's hit one that dealt it.
        const landed = variant.typed && branch.typeDealt !== true ? { ...branch, typeDealt: true } : branch
        const afterRow: PathState = {
          ...variant.state,
          active: variant.state.active.filter(
            (instance) =>
              !consumed.includes(instance) &&
              !(hit && consumedOnHit.includes(instance)) &&
              !((branch.dealt || variant.woke) && endsOnDamage(instance, row.creature))
          )
        }

        const applyGrants = (g: number, p: number, st: PathState): void => {
          for (; g < grants.length; g++) {
            const grant = grants[g]!
            if (
              !grant.of.includes(s) ||
              !grantLands(grant, row.kind === 'save', landed, () => riderAppliesOn(riderPlans[grant.rider!]!, s, branch, landings))
            )
              continue
            let current = st
            if (grant.cap === 'once') {
              if (current.tried[g]) continue
              // Spent only where a later row on this creature reads one of its effects.
              if (!readerFollows(grant)) continue
              current = { ...current, tried: current.tried.map((t, j) => t || j === g) }
            } else if (
              grant.effects.every(lastsTheTurn) &&
              grant.effects.every((effect, e) =>
                current.active.some((i) => i.grant === g && i.branch === 'effects' && i.index === e && i.creature === creatureOf(effect))
              )
            ) {
              continue
            }
            const tries: Array<{ p: number; list: readonly EffectSpec[] | undefined; branch: 'effects' | 'onPass' }> = []
            if (grant.save) {
              const pFail = grantSaveFailure(grant.save, row.creature, turn.startingCondition, afterRow.active)
              tries.push({ p: pFail, list: grant.effects, branch: 'effects' }, { p: 1 - pFail, list: grant.onPass, branch: 'onPass' })
            } else if (grant.chance !== undefined) {
              tries.push({ p: grant.chance, list: grant.effects, branch: 'effects' }, { p: 1 - grant.chance, list: grant.onPass, branch: 'onPass' })
            } else {
              tries.push({ p: 1, list: grant.effects, branch: 'effects' })
            }
            for (const t of tries) {
              if (t.p === 0) continue
              let active = current.active
              ;(t.list ?? []).forEach((spec, e) => {
                for (const [index, instance] of instancesOf(spec, e)) {
                  const creature = creatureOf(spec)
                  const exists = active.some((i) => i.grant === g && i.branch === t.branch && i.index === index && i.creature === creature)
                  if (!exists) active = [...active, { grant: g, branch: t.branch, index, creature, spec: instance }]
                }
              })
              applyGrants(g + 1, p * t.p, { ...current, active })
            }
            return
          }
          walk(k + 1, p, st, rowDamage)
        }
        applyGrants(0, prob * branch.p * variant.p, afterRow)
      }
    }
  }
  // A `start` grant's effects are in force before the first row, on the creature of each row it lists.
  const starting: EffectInstance[] = grants.flatMap((grant, g) =>
    grant.trigger !== 'start'
      ? []
      : grant.effects.flatMap((spec, e) =>
          instancesOf(spec, e).flatMap(([index, instance]) =>
            (isAttackerSide(spec) ? ['any' as const] : [...new Set(grant.of.map((j) => rows[j]!.creature))]).map((creature): EffectInstance => ({
              grant: g,
              branch: 'effects',
              index,
              creature,
              spec: instance
            }))
          )
        )
  )
  walk(0, 1, { active: starting, tried: grants.map(() => false), fates: new Map(), coins: new Map() }, NO_DAMAGE)
  return { pmf: result, perSource, detail: wantDetail ? { rows: rowDetail, riders: riderDetail } : undefined }
}

/**
 * P(the target fails a grant's save), rolled in the save-side state at the start of the triggering row (`active` is that
 * state, less whatever the row's own damage ended): the target's conditions give an automatic fail or dexterity
 * disadvantage, saveDisadvantage and savePenalty effects apply, and no roll override does. A penalty that lasts until the
 * creature's next save belongs to the save rows, not to this one, and an effect scoped (`to`) to rows is read by those rows
 * only, since a grant's save is none of them. With `alternatives` the target saves with the ability it fails least.
 */
function grantSaveFailure(
  save: GrantSaveSpec,
  creature: number,
  startingCondition: ConditionName | undefined,
  active: readonly EffectInstance[]
): number {
  if (save.contest !== undefined) {
    // Every pair of the two d20s, counted: the target fails where its total is strictly lower. It takes the ability it fails least with.
    let failure = 1
    for (const option of [save, ...(save.alternatives ?? [])]) {
      let lower = 0
      for (let target = 1; target <= 20; target++)
        for (let attacker = 1; attacker <= 20; attacker++) if (target + option.saveBonus < attacker + save.contest) lower++
      failure = Math.min(failure, lower / 400)
    }
    return failure
  }
  const held = active.filter((i) => !((i.spec.kind === 'savePenalty' || i.spec.kind === 'saveDisadvantage') && i.spec.lifetime === 'next-save'))
  let failure = 1
  for (const option of [{ ability: save.ability, saveBonus: save.saveBonus }, ...(save.alternatives ?? [])]) {
    const { contributions } = readEffects(
      { side: 'save', sourceIndex: -1, range: 'melee', ability: option.ability },
      creature,
      startingCondition,
      held
    )
    if (contributes(contributions, 'autoFail')) continue
    const kind = combineRollTypes('flat', false, contributes(contributions, 'saveDisadvantage'))
    failure = Math.min(failure, 1 - d20PassProbability(kind, option.saveBonus, save.dc, penaltyDistribution(contributions)))
  }
  return failure
}

function convolveLists(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
  const out = new Map<number, number>()
  for (const [da, pa] of a) {
    for (const [db, pb] of b) addScaled(out, da + db, pa * pb)
  }
  return [...out]
}

// ── beam chain ───────────────────────────────────────────────────────────────

function enumerateBeamChain(beams: readonly BeamSpec[]): { pmf: Map<number, number>; fireProbs: number[] } {
  const infos = beams.map((b) => {
    const probs = d20LandingProbs(b.advantage, b.toHit, b.ac, b.critRange)
    const hitOutcomes = enumerateDiceOutcomes(b.damage.count, b.damage.sides)
    const critOutcomes = enumerateDiceOutcomes(b.damage.count * 2, b.damage.sides)
    const pMatchHit = countMatched(hitOutcomes) / hitOutcomes.length
    const pMatchCrit = countMatched(critOutcomes) / critOutcomes.length
    return { ...probs, hitOutcomes, critOutcomes, pMatchHit, pMatchCrit, flat: b.damage.flat ?? 0 }
  })

  const fireProbs: number[] = [1]
  for (let i = 1; i < beams.length; i++) {
    const prev = infos[i - 1]!
    fireProbs.push(fireProbs[i - 1]! * (prev.pHit * prev.pMatchHit + prev.pCrit * prev.pMatchCrit))
  }

  // R(i): total damage from beams i..end, given beam i fires (mass 1).
  let rest: Map<number, number> = new Map([[0, 1]])
  for (let i = beams.length - 1; i >= 0; i--) {
    const info = infos[i]!
    const cur = new Map<number, number>()
    addScaled(cur, 0, info.pMiss)
    const hitProb = info.hitOutcomes.length ? 1 / info.hitOutcomes.length : 1
    for (const o of info.hitOutcomes) {
      const dmg = o.damage + info.flat
      if (o.matched) convolveInto(cur, dmg, hitProb * info.pHit, rest)
      else addScaled(cur, dmg, hitProb * info.pHit)
    }
    const critProb = info.critOutcomes.length ? 1 / info.critOutcomes.length : 1
    for (const o of info.critOutcomes) {
      const dmg = o.damage + info.flat
      if (o.matched) convolveInto(cur, dmg, critProb * info.pCrit, rest)
      else addScaled(cur, dmg, critProb * info.pCrit)
    }
    rest = cur
  }

  return { pmf: rest, fireProbs }
}

function countMatched(outcomes: Array<{ damage: number; matched: boolean }>): number {
  let n = 0
  for (const o of outcomes) if (o.matched) n++
  return n
}
