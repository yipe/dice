// Brute-force oracle test, shared with the yipe/dpr repository (packages/ddb/src/__tests__/oracle/conditionsRandom.ts).
/**
 * Seeded generators of random valid `SyntheticTurn`s for the calculation-against-enumerator sweeps. {@link randomTurn} is the
 * sweep of the first grant format (hit, damage and save triggers, conditions, riders); {@link randomFormatTurn} draws the
 * widened format: the miss, crit, kill and rider triggers, Unconscious and its lifetime, next-attack effects against any
 * creature, Elven Accuracy, a choice of save abilities and save effects scoped to rows.
 */
import type {
  AdvantageKind,
  AttackSpec,
  DiceSpec,
  EffectSpec,
  GrantSpec,
  RiderSpec,
  SaveAbilityName,
  SaveSpec,
  StartingConditionName,
  SyntheticTurn
} from './bruteForce'

/** A small deterministic generator (the classic LCG), so a failing sweep index names one turn. */
export function generator(seed: number) {
  let state = seed
  const next = (): number => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
  const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1))
  const subset = (size: number): number[] => {
    const chosen = Array.from({ length: size }, (_, i) => i).filter(() => next() < 0.5)
    return chosen.length > 0 ? chosen : [int(0, size - 1)]
  }
  return { next, pick, int, subset }
}

export const ABILITIES: readonly SaveAbilityName[] = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
export const CONDITIONS: readonly StartingConditionName[] = ['blinded', 'paralyzed', 'prone', 'restrained', 'stunned']

/**
 * A random attack payload. A quarter carry cold damage that the enemy may resist, double or ignore, and half of those deal
 * nothing else, so that a resisted hit can deal 0 in total (the case a flat bonus would hide).
 */
export function randomDamage(g: ReturnType<typeof generator>): DiceSpec {
  const cold = g.next() < 0.25
  const coldAlone = cold && g.next() < 0.5
  const scale =
    g.next() < 0.5
      ? g.pick([
          { num: 1, den: 2 },
          { num: 0, den: 1 },
          { num: 2, den: 1 }
        ] as const)
      : undefined
  const parts = cold ? [{ count: 1, sides: g.pick([2, 6, 8] as const), type: 'cold', ...(scale ? { scale } : {}) }] : undefined
  if (coldAlone) return { count: 0, sides: 0, parts: parts! }
  return { count: g.int(1, 2), sides: g.pick([4, 6, 8] as const), flat: g.int(0, 4), ...(parts ? { parts } : {}) }
}

/** A random turn the enumerator accepts: up to four attacks and two saves in a random order, up to three grants, up to two riders. */
export function randomTurn(seed: number): SyntheticTurn {
  const g = generator(seed)
  const attackCount = g.int(1, 4)
  const saveCount = g.int(0, 2)
  const total = attackCount + saveCount
  const creature = (): { target?: number } => (g.next() < 0.2 ? { target: 1 } : {})
  const attacks = Array.from({ length: attackCount }, (): AttackSpec => {
    const roll: AdvantageKind = g.pick(['flat', 'flat', 'flat', 'advantage', 'disadvantage', 'elven'] as const)
    return {
      toHit: g.int(2, 10),
      ac: g.int(12, 16),
      critRange: g.pick([20, 20, 19] as const),
      advantage: roll,
      damage: randomDamage(g),
      range: g.pick(['melee', 'melee', 'ranged'] as const),
      ...creature(),
      ...(g.next() < 0.08 ? { autoHit: true } : {}),
      ...(g.next() < 0.08 ? { autoCrit: true } : {}),
      ...(g.next() < 0.08 ? { rollOverride: g.pick(['flat', 'advantage', 'disadvantage'] as const) } : {}),
      ...(g.next() < 0.12 ? { chance: g.pick([0.5, 0.7] as const) } : {})
    }
  })
  const saves = Array.from({ length: saveCount }, (): SaveSpec => ({
    dc: g.int(12, 17),
    saveBonus: g.int(0, 5),
    onSuccess: g.pick(['half', 'none'] as const),
    damage: { count: g.int(2, 3), sides: 6 },
    ability: g.pick(ABILITIES),
    ...(g.next() < 0.15 ? { rollType: g.pick(['advantage', 'disadvantage'] as const) } : {}),
    ...creature(),
    ...(g.next() < 0.08 ? { autoFail: true } : {}),
    ...(g.next() < 0.08 ? { rollOverride: g.pick(['flat', 'advantage', 'disadvantage'] as const) } : {}),
    ...(g.next() < 0.12 ? { chance: 0.6 } : {})
  }))

  const effect = (): EffectSpec => {
    const kind = g.pick(['condition', 'condition', 'advantage', 'disadvantage', 'critOnHit', 'saveDisadvantage', 'savePenalty'] as const)
    if (kind === 'condition') return { kind, condition: g.pick(CONDITIONS) }
    const lifetime = g.next() < 0.4 ? ({ lifetime: 'next-save' } as const) : {}
    if (kind === 'saveDisadvantage') return { kind, ...lifetime }
    if (kind === 'savePenalty') return { kind, count: g.int(1, 2), sides: g.pick([4, 6] as const), ...lifetime }
    return { kind, lifetime: g.pick(['turn', 'next-attack'] as const), ...(g.next() < 0.3 ? { to: g.subset(total) } : {}) }
  }
  const effects = (): EffectSpec[] => Array.from({ length: g.int(1, 2) }, effect)
  const coldAttacks = attacks.flatMap((a, i) => (a.damage.parts ? [i] : []))
  const grants = Array.from({ length: g.int(0, 3) }, (): GrantSpec => {
    // A grant that needs cold damage dealt watches attacks that carry cold.
    const dealing = coldAttacks.length > 0 && g.next() < 0.3
    const of = dealing ? coldAttacks.filter(() => g.next() < 0.7) : g.subset(total)
    const watched = of.length > 0 ? of : dealing ? [coldAttacks[0]!] : of
    const fromSaves = watched.every((source) => source >= attackCount)
    const how = g.pick(['certain', 'chance', 'save', 'save'] as const)
    return {
      of: watched,
      trigger: dealing
        ? g.pick(['hit', 'damage'] as const)
        : fromSaves
          ? g.pick(['failedSave', 'passedSave', 'damage'] as const)
          : g.pick(['hit', 'hit', 'damage'] as const),
      ...(dealing ? { dealing: 'cold' } : {}),
      ...(how === 'chance' ? { chance: g.pick([0.3, 0.5, 0.8] as const) } : {}),
      ...(how === 'save' ? { save: { ability: g.pick(ABILITIES), dc: g.int(11, 17), saveBonus: g.int(0, 5) } } : {}),
      cap: g.pick(['unlimited', 'once'] as const),
      effects: effects(),
      ...(how !== 'certain' && g.next() < 0.4 ? { onPass: effects() } : {})
    }
  })
  const riders = Array.from({ length: g.int(0, 2) }, (): RiderSpec => ({
    of: g.subset(total),
    trigger: g.pick(['hit', 'hit', 'damage', 'cast'] as const),
    damage: { count: g.int(1, 3), sides: 6 },
    ...(g.next() < 0.25 ? { chance: 0.6 } : {})
  }))

  const order = Array.from({ length: total }, (_, i) => i).sort(() => g.next() - 0.5)
  return {
    attacks,
    ...(saves.length > 0 ? { saves } : {}),
    order,
    ...(g.next() < 0.35 ? { startingCondition: g.pick(CONDITIONS) } : {}),
    grants,
    // A fifth of the riders wait for a crit (drawn last, so the turns already drawn from a seed keep their shape).
    riders: riders.map((rider) => (g.next() < 0.2 ? { ...rider, onCrit: true } : rider))
  }
}

/**
 * A random turn that uses the widened grant format: two to four attacks (some with Elven Accuracy or a miss payload) and up to
 * two saves in a random order, up to two riders, and one to three grants whose triggers, effects and saves are drawn from the
 * whole format. A grant coupled to a rider watches some of the rider's rows, and only a rider that is certain is coupled to.
 */
export function randomFormatTurn(seed: number): SyntheticTurn {
  const g = generator(seed)
  const attackCount = g.int(2, 4)
  const saveCount = g.int(0, 2)
  const total = attackCount + saveCount
  const creature = (): { target?: number } => (g.next() < 0.25 ? { target: 1 } : {})
  const attacks = Array.from({ length: attackCount }, (): AttackSpec => {
    const roll: AdvantageKind = g.pick(['flat', 'flat', 'flat', 'advantage', 'disadvantage', 'elven'] as const)
    return {
      toHit: g.int(2, 10),
      ac: g.int(12, 16),
      critRange: g.pick([20, 20, 19] as const),
      advantage: roll,
      damage: randomDamage(g),
      range: g.pick(['melee', 'melee', 'ranged'] as const),
      ...creature(),
      ...(g.next() < 0.3 ? { elvenAccuracy: true } : {}),
      ...(g.next() < 0.15 ? { missDamage: { kind: 'flat' as const, amount: g.int(0, 3) } } : {}),
      ...(g.next() < 0.06 ? { autoHit: true } : {}),
      ...(g.next() < 0.08 ? { autoCrit: true } : {}),
      ...(g.next() < 0.06 ? { rollOverride: g.pick(['flat', 'advantage', 'disadvantage'] as const) } : {}),
      ...(g.next() < 0.1 ? { chance: g.pick([0.5, 0.7] as const) } : {})
    }
  })
  const saves = Array.from({ length: saveCount }, (): SaveSpec => ({
    dc: g.int(12, 17),
    saveBonus: g.int(0, 5),
    onSuccess: g.pick(['half', 'none'] as const),
    damage: { count: g.int(2, 3), sides: 6 },
    ability: g.pick(ABILITIES),
    ...(g.next() < 0.15 ? { rollType: g.pick(['advantage', 'disadvantage'] as const) } : {}),
    ...creature(),
    ...(g.next() < 0.06 ? { autoFail: true } : {}),
    ...(g.next() < 0.1 ? { chance: 0.6 } : {})
  }))
  const riders = Array.from({ length: g.int(0, 2) }, (): RiderSpec => ({
    of: g.subset(total),
    trigger: g.pick(['hit', 'hit', 'damage', 'cast'] as const),
    // A fifth of the riders deal damage only some of the time (a die less a flat, floored at 0) or never (the enemy is immune).
    damage:
      g.next() < 0.2
        ? g.pick([
            { count: 1, sides: 4, flat: -2, floorAtZero: true },
            { count: 1, sides: 2, flat: -1, floorAtZero: true },
            { count: 0, sides: 0, parts: [{ count: 2, sides: 6, type: 'fire', scale: { num: 0, den: 1 } }] }
          ] as const)
        : { count: g.int(1, 3), sides: 6 },
    ...(g.next() < 0.2 ? { chance: 0.6 } : {})
  }))

  const effect = (): EffectSpec => {
    const kind = g.pick([
      'condition',
      'condition',
      'unconscious',
      'advantage',
      'disadvantage',
      'critOnHit',
      'saveDisadvantage',
      'savePenalty'
    ] as const)
    if (kind === 'condition') return { kind, condition: g.pick(CONDITIONS) }
    if (kind === 'unconscious')
      return { kind: 'condition', condition: 'unconscious', ...(g.next() < 0.75 ? { lifetime: 'until-damaged' as const } : {}) }
    if (kind === 'saveDisadvantage' || kind === 'savePenalty') {
      const scope = g.next() < 0.3 ? { to: g.subset(total) } : {}
      const lifetime = g.next() < 0.4 ? ({ lifetime: 'next-save' } as const) : {}
      return kind === 'saveDisadvantage'
        ? { kind, ...lifetime, ...scope }
        : { kind, count: g.int(1, 2), sides: g.pick([4, 6] as const), ...lifetime, ...scope }
    }
    return {
      kind,
      lifetime: g.pick(['turn', 'next-attack', 'next-attack'] as const),
      ...(g.next() < 0.25 ? { to: g.subset(total) } : {}),
      ...(g.next() < 0.3 ? { against: 'any' as const } : {})
    }
  }
  const effects = (): EffectSpec[] => Array.from({ length: g.int(1, 2) }, effect)
  const coldAttacks = attacks.flatMap((a, i) => (a.damage.parts ? [i] : []))
  // Only a certain rider can have a grant coupled to it.
  const certainRiders = riders.flatMap((rider, i) => (rider.chance === undefined ? [i] : []))
  const grants = Array.from({ length: g.int(1, 3) }, (): GrantSpec => {
    const how = g.pick(['certain', 'chance', 'save', 'save'] as const)
    const ability = g.pick(ABILITIES)
    const gate = {
      ...(how === 'chance' ? { chance: g.pick([0.3, 0.5, 0.8] as const) } : {}),
      ...(how === 'save'
        ? {
            save: {
              ability,
              dc: g.int(11, 17),
              saveBonus: g.int(0, 5),
              // The target may save with another ability instead (Grappler).
              ...(g.next() < 0.35
                ? {
                    alternatives: [
                      { ability: g.pick((['strength', 'dexterity', 'wisdom'] as const).filter((other) => other !== ability)), saveBonus: g.int(0, 5) }
                    ]
                  }
                : {})
            }
          }
        : {})
    }
    const cap = g.pick(['unlimited', 'once'] as const)
    const tail = { cap, effects: effects(), ...(how !== 'certain' && g.next() < 0.4 ? { onPass: effects() } : {}) }
    if (certainRiders.length > 0 && g.next() < 0.3) {
      const rider = g.pick(certainRiders)
      const of = riders[rider]!.of.filter(() => g.next() < 0.7)
      return { of: of.length > 0 ? of : [riders[rider]!.of[0]!], trigger: 'rider', rider, ...gate, ...tail }
    }
    const dealing = coldAttacks.length > 0 && g.next() < 0.25
    const of = dealing ? coldAttacks.filter(() => g.next() < 0.7) : g.subset(total)
    const watched = of.length > 0 ? of : dealing ? [coldAttacks[0]!] : of
    const fromSaves = watched.every((source) => source >= attackCount)
    const trigger: GrantSpec['trigger'] = dealing
      ? g.pick(['hit', 'damage', 'crit'] as const)
      : fromSaves
        ? g.pick(['failedSave', 'passedSave', 'damage', 'kill'] as const)
        : g.pick(['hit', 'damage', 'miss', 'miss', 'crit', 'kill'] as const)
    return { of: watched, trigger, ...(dealing ? { dealing: 'cold' } : {}), ...gate, ...tail }
  })

  const order = Array.from({ length: total }, (_, i) => i).sort(() => g.next() - 0.5)
  return {
    attacks,
    ...(saves.length > 0 ? { saves } : {}),
    order,
    ...(g.next() < 0.3 ? { startingCondition: g.pick(CONDITIONS) } : {}),
    grants,
    // A fifth of the riders wait for a crit (drawn last, so the turns already drawn from a seed keep their shape).
    riders: riders.map((rider) => (g.next() < 0.2 ? { ...rider, onCrit: true } : rider))
  }
}

/**
 * {@link randomFormatTurn} with a curse on top (2014 Path to the Grave): vulnerability to the next attack that hits, in force from
 * the start on the creature of the first attack, declared among the turn's other grants. It draws from its own stream, so the turns
 * {@link randomFormatTurn} builds from a seed are the ones it builds here, curse apart.
 */
export function randomCurseTurn(seed: number): SyntheticTurn {
  const turn = randomFormatTurn(seed)
  const g = generator(seed * 31 + 7)
  const creature = turn.attacks[0]!.target ?? 0
  const of = turn.attacks.flatMap((attack, i) => ((attack.target ?? 0) === creature ? [i] : []))
  const grants = [...(turn.grants ?? [])]
  grants.splice(g.int(0, grants.length), 0, { of, trigger: 'start', cap: 'once', effects: [{ kind: 'vulnerability', lifetime: 'next-hit' }] })
  return { ...turn, grants }
}
