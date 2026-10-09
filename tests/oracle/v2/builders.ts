// Builder half of yipe/dpr packages/ddb/src/__tests__/oracle/oracleHelpers.ts (commit 52cc91228), the
// `@yipe/dice` spelling of an oracle `DiceSpec` payload. Copied verbatim from the line after its imports up to
// `attackBuilder`; only the imports differ. The engine's `TurnAction` half is not needed in the library.
import { d20, flat, roll, sumRolls, type RollBuilder } from '../../../src/builder/index'
import { ownPayload, payloadHasDoubledGroup, type DamageScaleSpec, type DiceSpec, type DieRules, type PartSpec } from '../bruteForce'

/**
 * The dice of one payload part as a builder, read by `rules`: `minimum` under every die and `rerollBelow` (the first
 * reroll of the low faces). Without the reroll budget that is the whole part; see {@link diceRoll} for the budget.
 */
function ruledDice(d: Pick<DiceSpec, 'count' | 'sides'> & DieRules): RollBuilder {
  let dice = roll(d.count, d.sides)
  if (d.rerollBelow) dice = dice.reroll(d.rerollBelow)
  if (d.minimumDie) dice = dice.minimum(d.minimumDie)
  return dice
}

/**
 * `count`d`sides` + `flat`, its faces read by `rules`. With a `rerollDice` budget the dice are `@yipe/dice`'s
 * `rerollUpTo(budget)`: the roller sees them all, rerolls the best up to the budget and keeps each new roll (a budget of
 * every die is `reroll(f)` on each).
 */
export function diceRoll(d: Pick<DiceSpec, 'count' | 'sides' | 'flat'> & DieRules) {
  if (d.count <= 0 || d.sides <= 0) return flat(d.flat ?? 0)
  if (d.rerollDice === undefined && !d.minimumDie && !d.rerollBelow) return d.flat ? roll(d.count, d.sides, d.flat) : roll(d.count, d.sides)
  const dice = ruledDice(d)
  const pooled = d.rerollDice === undefined ? dice : dice.rerollUpTo(d.rerollDice)
  return d.flat ? pooled.plus(d.flat) : pooled
}

/**
 * `count`d`sides` + `flat` with the dice doubled on a crit (the reroll budget is not: the oracle needs it to cover
 * them), or (Max + roll) rolled once with their max faces added.
 */
function partRoll(count: number, sides: number, flatBonus: number, crit: boolean, dealMax: boolean, rules: DieRules = {}): RollBuilder {
  const { minimumDie, rerollBelow } = rules
  const rolled = { sides, ...(minimumDie !== undefined ? { minimumDie } : {}), ...(rerollBelow !== undefined ? { rerollBelow } : {}) }
  if (crit && dealMax) return diceRoll({ count, flat: flatBonus + count * sides, ...rolled })
  return diceRoll({ count: crit ? count * 2 : count, flat: flatBonus, ...rolled })
}

/** A payload's main dice as a part, then its typed parts. */
function mainAndParts(d: DiceSpec): PartSpec[] {
  const { count, sides, flat: mainFlat, minimumDie, rerollBelow, rerollDice } = d
  const main: PartSpec = {
    count,
    sides,
    ...(mainFlat !== undefined ? { flat: mainFlat } : {}),
    ...(minimumDie !== undefined ? { minimumDie } : {}),
    ...(rerollBelow !== undefined ? { rerollBelow } : {}),
    ...(rerollDice !== undefined ? { rerollDice } : {})
  }
  return [main, ...(d.parts ?? [])]
}

/**
 * The reroll pool of a payload as `@yipe/dice` builders: every part that carries a `rerollDice` budget (the main dice
 * included), each under its own floor and first reroll, in one `rerollUpTo` with the smallest budget. Their flats stay
 * out of it (the caller adds them). `rolls` 2 is Savage Attacker's best of two rolls of the pool, then the reroll.
 * `undefined` when no part carries a budget.
 */
function carrierPool(d: DiceSpec, crit: boolean, dealMax: boolean, rolls: 1 | 2 = 1): { pool: RollBuilder; carriers: PartSpec[] } | undefined {
  const k = crit && !dealMax ? 2 : 1
  const carriers = mainAndParts(d).filter((part) => part.rerollDice !== undefined && part.count * k > 0 && part.sides > 0)
  if (carriers.length === 0) return undefined
  const dice = carriers.map((part) => ruledDice({ ...part, count: part.count * k })).reduce((acc, group) => acc.plus(group))
  const budget = Math.min(...carriers.map((part) => part.rerollDice!))
  return { pool: dice.rerollUpTo(budget, rolls === 2 ? { rolls: 2 } : undefined), carriers }
}

/** True when a payload needs {@link payloadBuilder} (typed parts, a floor or a best-of-two pool) rather than {@link diceRoll}. */
export function hasTypedParts(d: DiceSpec): boolean {
  return (d.parts?.length ?? 0) > 0 || d.floorAtZero === true || d.bestOfTwo === true
}

/**
 * A best-of-two payload (Savage Attacker, card A11) as `@yipe/dice` builders. With no outside part the whole
 * payload is the pool: each type's dice summed and scaled once, the sum's `maxOf(2)` the higher scaled total.
 * With outside parts the pool must sit in one type group, where the higher scaled total is the higher pool
 * (a scale never reorders totals): that group is the pool's `maxOf(2)` (flats outside it) beside its outside
 * dice, scaled once.
 */
function bestOfTwoBuilder(d: DiceSpec, crit: boolean): RollBuilder {
  // With a reroll budget the weapon's dice are the reroll pool, rolled twice: choose the roll, then reroll a die in it.
  const rerolled = carrierPool(d, crit, false, 2)
  if (rerolled) {
    const all = mainAndParts(d)
    const k = crit ? 2 : 1
    const flats = all.reduce((sum, part) => sum + (part.flat ?? 0), 0)
    const outside = all.filter((part) => part.outsidePool && part.count > 0).map((part) => diceRoll({ count: part.count * k, sides: part.sides }))
    return sumRolls([flats !== 0 ? rerolled.pool.plus(flats) : rerolled.pool, ...outside])
  }
  const untyped: PartSpec = { count: d.count, sides: d.sides, flat: d.flat ?? 0 }
  const groups = new Map<string, { scale?: DamageScaleSpec; pool: PartSpec[]; outside: PartSpec[] }>()
  for (const part of [untyped, ...(d.parts ?? [])]) {
    const type = part.type ?? ''
    const group = groups.get(type) ?? { ...(part.scale ? { scale: part.scale } : {}), pool: [], outside: [] }
    ;(part.outsidePool ? group.outside : group.pool).push(part)
    groups.set(type, group)
  }
  const scaled = (sum: RollBuilder, scale?: DamageScaleSpec): RollBuilder =>
    scale ? sum.scaleResult(scale.num, scale.den, scale.round ?? 'floor') : sum
  const rollOf = (part: PartSpec): RollBuilder => partRoll(part.count, part.sides, part.flat ?? 0, crit, false)
  const diceOf = (parts: readonly PartSpec[]): PartSpec[] => parts.filter((p) => p.count > 0 && p.sides > 0)

  let total: RollBuilder
  if (![...groups.values()].some((g) => g.outside.length > 0)) {
    total = sumRolls([...groups.values()].map((g) => scaled(sumRolls(g.pool.map(rollOf)), g.scale))).maxOf(2)
  } else {
    if ([...groups.values()].filter((g) => diceOf(g.pool).length > 0).length > 1) {
      throw new Error('bestOfTwoBuilder: a pool beside outside parts must sit in one type')
    }
    total = sumRolls(
      [...groups.values()].map((g) => {
        if (diceOf(g.pool).length === 0) return scaled(sumRolls([...g.pool, ...g.outside].map(rollOf)), g.scale)
        const poolFlat = g.pool.reduce((sum, p) => sum + (p.flat ?? 0), 0)
        const best = sumRolls(diceOf(g.pool).map((p) => partRoll(p.count, p.sides, 0, crit, false)))
          .maxOf(2)
          .plus(poolFlat)
        return scaled(sumRolls([best, ...g.outside.map(rollOf)]), g.scale)
      })
    )
  }
  return d.floorAtZero ? total.maxOf(flat(0)) : total
}

/**
 * A payload as `@yipe/dice` builders, the way analyze compiles an enemy-scaled row: each damage type's parts
 * summed, then `scaleResult` once per type, then summed with the untyped dice; `maxOf(0)` floors it. With
 * `halve`, each group is halved before its scale (half of a miss pool, card A8's order). With `dealMax`, a
 * crit part rolls once and adds its own max faces inside its group, so the group's scale applies to them too
 * (Max + roll, card A9).
 */
export function payloadBuilder(d: DiceSpec, crit: boolean, halve = false, dealMax = false, saveSuccess = false): RollBuilder {
  if (d.bestOfTwo) {
    if (halve || saveSuccess) throw new Error('payloadBuilder: half of a best-of-two pool is not a shape any card needs')
    if (dealMax) throw new Error('payloadBuilder: Max + roll on a best-of-two pool is not a shape any card needs')
    return bestOfTwoBuilder(d, crit)
  }
  // The reroll pool spans every part that carries a budget: those parts contribute only their flats to their own group,
  // and the pool joins the group of the first one.
  const rerolled = carrierPool(d, crit, dealMax)
  if (rerolled && (halve || saveSuccess)) throw new Error('payloadBuilder: half of a reroll pool is not a shape any card needs')
  const carries = (part: PartSpec) =>
    rerolled?.carriers.some((c) => c.sides === part.sides && c.count === part.count && c.type === part.type && c.rerollDice === part.rerollDice) ===
    true
  const dice = (part: PartSpec): RollBuilder =>
    carries(part)
      ? flat((part.flat ?? 0) + (crit && dealMax ? part.count * part.sides : 0))
      : partRoll(part.count, part.sides, part.flat ?? 0, crit, dealMax, part)
  const poolType = rerolled?.carriers[0]!.type ?? ''
  const byType = new Map<string, { scale?: DamageScaleSpec; rolls: RollBuilder[] }>()
  for (const part of d.parts ?? []) {
    const type = part.type ?? ''
    const group = byType.get(type) ?? { ...(part.scale ? { scale: part.scale } : {}), rolls: [] }
    group.rolls.push(dice(part))
    byType.set(type, group)
  }
  const untyped = dice({
    count: d.count,
    sides: d.sides,
    ...(d.flat !== undefined ? { flat: d.flat } : {}),
    ...(d.minimumDie !== undefined ? { minimumDie: d.minimumDie } : {}),
    ...(d.rerollBelow !== undefined ? { rerollBelow: d.rerollBelow } : {}),
    ...(d.rerollDice !== undefined ? { rerollDice: d.rerollDice } : {})
  })
  if (rerolled) {
    const group = byType.get(poolType)
    if (group && poolType !== '') group.rolls.push(rerolled.pool)
    else if (poolType === '' && byType.has('')) byType.get('')!.rolls.push(rerolled.pool)
    else byType.set(poolType, { rolls: [rerolled.pool] })
  }
  const groups: RollBuilder[] = [halve ? untyped.half() : untyped]
  // A successful save: each doubled group halved, then doubled; the rest scaled on their own and halved once.
  const rest: RollBuilder[] = [untyped]
  for (const { scale, rolls } of byType.values()) {
    if (saveSuccess) {
      const sum = sumRolls(rolls)
      const scaled = scale ? sum.scaleResult(scale.num, scale.den, scale.round ?? 'floor') : sum
      if (scale && scale.num > scale.den) groups.push(sum.half().scaleResult(scale.num, scale.den, scale.round ?? 'floor'))
      else rest.push(scaled)
      continue
    }
    const sum = halve ? sumRolls(rolls).half() : sumRolls(rolls)
    groups.push(scale ? sum.scaleResult(scale.num, scale.den, scale.round ?? 'floor') : sum)
  }
  if (saveSuccess) {
    groups.splice(0, 1) // the untyped dice sit in `rest`, halved once with every other group that is not doubled
    groups.push(sumRolls(rest).half())
  }
  const total = sumRolls(groups)
  return d.floorAtZero ? total.maxOf(flat(0)) : total
}
