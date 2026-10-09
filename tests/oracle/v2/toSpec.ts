/**
 * `SyntheticTurn` (the brute-force oracle's input) -> `TurnSpec` v2: the library-side twin of dpr's
 * `conditionsHarness.toConditionInput` (packages/ddb/src/__tests__/oracle/conditionsHarness.ts), producing the plain
 * `TurnSpec` v2 data instead of the engine's `ConditionInput`. Every mapping decision:
 *
 * Ids
 * - Source `k` (attacks first, then saves: the oracle's source index) is the row `row:k`. Rows are declared in
 *   `turn.order`, so `spec.attacks` is in turn order and the ids never depend on it.
 * - Rider `i` is `rider:i`; grant `i` is the condition `grant:i` (the oracle's `sources` key spelling); the starting
 *   condition is the condition `start`.
 * - Creature `n` is the target `creature:n`; creature 0 is the default target and is left out.
 *
 * Rows (`oracleSource` / `oracleSaveSource`, test-only `ContextualSource`s)
 * - `rowCheck`: an attack is `{ kind: 'attack', range }` (melee by default), a save `{ kind: 'save', ability }`. The roll
 *   type is the row's own (`elven` -> `elven accuracy`), `advantageDice` 3 with Elven Accuracy, `pinned` when the row
 *   has a `rollOverride` (and then the roll type IS the override), `autoHit` / `autoCrit` / `autoFail` copied.
 * - `under(ctx)` builds the row with the library's own builders exactly as the harness's `attackPmf` / `savePmf` do:
 *   `ctx.rollType` on the d20, `ctx.autoHit` -> `alwaysHits()`, `ctx.critOnHit` -> `alwaysCrits()`, `ctx.vulnerable`
 *   doubles hit and crit with the enemy's scales off (a miss unchanged), `ctx.autoFail` -> DC 1000,
 *   `ctx.penaltyDice` taken off the target's d20. `ctx.joined` puts the joined riders' dice into the row's reroll
 *   pool, mixed over each joined rider's `happens` coin (the engine's `RowContext.joined` lists a joining rider
 *   whatever its coin, and the harness mixes the coin inside the row; this keeps those semantics).
 * - `dealt(type, ctx)` (attacks only, as the harness's `typeDealt`): P(the row's own parts of `type` deal more than 0)
 *   as a hit and as a crit, with the enemy's scales off in a vulnerable context. A save row has none.
 * - A row's `chance` -> the attack's `chance`; `target` -> `target`. A row gated on a parent (`gatedOn`) stays an
 *   attack at its own place with `after: { of: parent id, landing }` (`cast` -> `any`), as dpr's reference `toSpec`.
 *
 * Riders
 * - `of` -> row ids. A `hit` rider never lands on a save row (`landsOn`) and the library refuses a watched save row
 *   without a landing (`not-an-attack`), so save rows are dropped from its `of` (dpr's reference keeps them; the engine
 *   ignores them). `damage` -> `landing: 'damage'`, `cast` -> `landing: 'any'`.
 * - `onCrit` -> `any-crit` (with `max` when not 1); else `max` 1 -> `first-hit`, `max` N -> `every-hit` with `max: N`,
 *   `Infinity` -> `every-hit` without `max`.
 * - `damage` is always a `ContextualPayload`, the harness's `payload(row)`: per row its hit, crit and vulnerable
 *   payloads, and nothing on a row the rider joins (its dice are in that row's roll); `dealt` from its typed parts.
 * - `chance` -> `happens`; `pooledOn` -> `joins` (row ids); each `alongside` partner -> its rider id in `of`, in place
 *   of the rows it opens, and those rows under `where[partner]`.
 *
 * Grants -> `ConditionSpec`
 * - `cap: 'once'` -> the `first-*` spelling, `'unlimited'` -> `every-hit` / `any-*`: `hit` -> first/every-hit,
 *   `damage` -> the same with `landing: 'damage'`, `crit` -> first-crit / any-crit, `miss` -> first-miss / any-miss,
 *   `failedSave` -> first/every-hit with `landing: 'fail'`, `rider` -> first/every-hit with `of: [rider id]` (and
 *   `where` when the grant watches fewer rows than its rider), `start` -> `on: 'start'` (with `target` when the
 *   creature is not 0). `dealing` -> `dealing`.
 * - Rows that can never land the trigger (an attack under `failedSave`, a save under `hit`/`crit`/`miss`) are dropped
 *   from `of`; a grant left with no row is omitted (it can never land).
 * - `save` -> `save`: one `{ ability, dc, bonus }` (a one-element save stays an object), the ability plus its
 *   `alternatives` -> an array (same DC). A contest -> a fixed `chance` from `contestLossChance`. `chance` -> `chance`.
 * - Effects: `condition` -> `{ condition, rule: RULES[name], until: 'end-of-turn' | 'until-damaged' }`;
 *   `advantage` / `disadvantage` / `critOnHit` -> `GrantSpec` with `until` `next-attack` / `end-of-turn`;
 *   `vulnerability` -> `{ vulnerability: true, until: 'next-hit' }`; `saveDisadvantage` / `savePenalty` -> `until`
 *   `end-of-turn` (`turn`, the default) / `next-save`. `to` -> row ids. `onPass` -> `onSave`; `optional` -> `optional`.
 * - The starting condition -> `{ id: 'start', on: 'start', grants: [condition] }`.
 *
 * Engine-only (`oracleEngineOnly`, as dpr's reference `toSpec` throws `EngineOnlyError`): `passedSave` grants and
 * `against: 'any'` effects; such a case is not compared. A `kill` grant never lands, so it is left out (exact) rather
 * than engine-only as the reference has it. What the contract cannot say is reported by
 * `oracleTurnGaps` (never silently approximated): a `start` grant over several creatures.
 */
import { d, d20, type AttackBuilder, type RollBuilder } from '../../../src/builder/index'
import { contestLossChance, RULES } from '../../../src/dnd5e/index'
import type { RollType } from '../../../src/common/types'
import { PMF } from '../../../src/pmf/pmf'
import type {
  Attack,
  ConditionSpec,
  ContextualPayload,
  ContextualSource,
  EffectSpec as V2Effect,
  GrantSaveSpec as V2Save,
  Rider,
  RowCheck,
  RowContext,
  TurnSpec
} from '../../../src/turn/types'
import type {
  AdvantageKind,
  AttackSpec,
  DiceSpec,
  EffectSpec,
  GrantSpec,
  PartSpec,
  RiderSpec,
  SaveSpec,
  SyntheticTurn
} from '../bruteForce'
import { diceRoll, hasTypedParts, payloadBuilder } from './builders'

export const rowId = (source: number): string => `row:${source}`
export const riderId = (index: number): string => `rider:${index}`
export const grantId = (index: number): string => `grant:${index}`
export const START_ID = 'start'
const creature = (target: number | undefined): string | undefined => (target ? `creature:${target}` : undefined)

/** The creature of a start grant: the one its first row is aimed at. */
const startTarget = (turn: SyntheticTurn, source: number): string | undefined =>
  creature(source < turn.attacks.length ? turn.attacks[source]!.target : turn.saves![source - turn.attacks.length]!.target)

const rollTypeOf = (kind: AdvantageKind): RollType => (kind === 'elven' ? 'elven accuracy' : kind)

/** A d20 (plus `bonus`) at a roll type, with `penalty` dice taken off it. */
function targetD20(bonus: number, rollType: RollType, penalty: ReadonlyArray<{ count: number; sides: number }> = []) {
  let builder = d20.plus(bonus)
  if (rollType === 'advantage') builder = builder.withAdvantage()
  else if (rollType === 'disadvantage') builder = builder.withDisadvantage()
  else if (rollType === 'elven accuracy') builder = builder.withElvenAccuracy()
  for (const die of penalty) builder = builder.minus(die.count, d(die.sides))
  return builder
}

const withoutScales = (spec: DiceSpec): DiceSpec => (spec.parts ? { ...spec, parts: spec.parts.map(({ scale: _scale, ...part }) => part) } : spec)

/** The harness's `typeDealtOdds`: P(the payload's damage of `type` is above 0) as a hit and as a crit. */
function typeDealtOdds(damage: DiceSpec, type: string): { hit: number; crit: number } {
  const own: DiceSpec = { count: 0, sides: 0, parts: (damage.parts ?? []).filter((part) => part.type === type) }
  if (own.parts!.length === 0) return { hit: 0, crit: 0 }
  const above = (crit: boolean): number => {
    const pmf = payloadBuilder(own, crit).toPMF()
    return pmf.support().reduce((sum, value) => (value > 0 ? sum + pmf.pAt(value) : sum), 0)
  }
  return { hit: above(false), crit: above(true) }
}

/** The harness's `attackPmf`, verbatim. */
function attackPmf(a: AttackSpec, context: RowContext, critDamage: DiceSpec = a.damage): PMF {
  let base = d20
  if (a.rerollOnes) base = base.reroll(1)
  if (context.rollType === 'advantage') base = base.withAdvantage()
  else if (context.rollType === 'disadvantage') base = base.withDisadvantage()
  else if (context.rollType === 'elven accuracy') base = base.withElvenAccuracy()
  const typed = hasTypedParts(a.damage) || hasTypedParts(critDamage)
  const damage = context.vulnerable ? withoutScales(a.damage) : a.damage
  const doubled = (roll: RollBuilder): RollBuilder => (context.vulnerable ? roll.scaleResult(2) : roll)
  const hit = doubled(typed ? payloadBuilder(damage, false) : diceRoll(damage))
  const crit = typed
    ? doubled(payloadBuilder(context.vulnerable ? withoutScales(critDamage) : critDamage, true))
    : context.vulnerable
      ? doubled(diceRoll({ ...damage, count: damage.count * 2 }))
      : undefined
  const finish = (builder: { onHit: (roll: typeof hit) => AttackBuilder }): PMF => {
    let attack = builder.onHit(hit)
    if (crit) attack = attack.onCrit(crit)
    const miss = a.missDamage
    if (miss?.kind === 'flat') attack = attack.onMiss(miss.amount)
    else if (miss?.kind === 'halfOnMiss' && !typed) attack = context.vulnerable ? attack.onMiss(diceRoll(a.damage).half()) : attack.halfOnMiss()
    else if (miss) throw new Error(`oracleSource: a ${miss.kind} miss payload is not part of the ported shapes`)
    return attack.toPMF()
  }
  if (context.autoHit) {
    let always = base.alwaysHits()
    const alwaysCrit = context.critOnHit ? always.alwaysCrits() : undefined
    if (!alwaysCrit && a.critRange < 20) always = always.critOn(a.critRange)
    return finish(alwaysCrit ?? always)
  }
  let check = base.plus(a.toHit).ac(a.ac)
  const checkCrit = context.critOnHit ? check.alwaysCrits() : undefined
  if (!checkCrit && a.critRange < 20) check = check.critOn(a.critRange)
  return finish(checkCrit ?? check)
}

/** The harness's `savePmf`, verbatim. */
function savePmf(s: SaveSpec, context: RowContext): PMF {
  const hit = diceRoll(s.damage)
  const roll = targetD20(s.saveBonus, context.rollType, context.penaltyDice)
  const failure = roll.dc(context.autoFail ? 1000 : s.dc).onSaveFailure(hit)
  return (s.onSuccess === 'half' ? failure.saveHalf() : failure).toPMF()
}

/** The harness's `joinedAttacks`: the attack with the joined riders' dice in its pool, per set of them that happen. */
function joinedAttacks(
  a: AttackSpec,
  riders: readonly RiderSpec[],
  source: number,
  joined: readonly number[]
): Array<{ attack: AttackSpec; crit: DiceSpec; p: number }> {
  let subsets: Array<{ riders: number[]; p: number }> = [{ riders: [], p: 1 }]
  for (const k of joined) {
    const chance = riders[k]!.chance ?? 1
    subsets = subsets.flatMap((subset) => [
      ...(chance > 0 ? [{ riders: [...subset.riders, k], p: subset.p * chance }] : []),
      ...(chance < 1 ? [{ riders: subset.riders, p: subset.p * (1 - chance) }] : [])
    ])
  }
  const rowBudget = (() => {
    const budgets = [
      a.damage.count > 0 ? a.damage.rerollDice : undefined,
      ...(a.damage.parts ?? []).map((part) => (part.count > 0 ? part.rerollDice : undefined))
    ]
    const carried = budgets.filter((budget): budget is number => budget !== undefined)
    return carried.length === 0 ? undefined : Math.min(...carried)
  })()
  const partsOf = (ks: readonly number[]) =>
    ks.flatMap((k) => {
      const spec = riders[k]!.damage
      const dice = typeof spec === 'function' ? spec(source) : spec
      const join = rowBudget !== undefined ? { rerollDice: rowBudget } : {}
      const parts: PartSpec[] = []
      if (dice.count > 0 || (dice.flat ?? 0) !== 0) {
        parts.push({
          count: dice.count,
          sides: dice.sides,
          ...(dice.flat !== undefined ? { flat: dice.flat } : {}),
          ...(dice.minimumDie !== undefined ? { minimumDie: dice.minimumDie } : {}),
          ...(dice.rerollBelow !== undefined ? { rerollBelow: dice.rerollBelow } : {}),
          ...join
        })
      }
      for (const part of dice.parts ?? []) parts.push({ ...part, ...join })
      return parts
    })
  const withParts = (ks: readonly number[]): DiceSpec => ({ ...a.damage, parts: [...(a.damage.parts ?? []), ...partsOf(ks)] })
  return subsets.map(({ riders: happening, p }) => ({
    attack: { ...a, damage: withParts(happening.filter((k) => !riders[k]!.onCrit)) },
    crit: withParts(happening),
    p
  }))
}

/** An oracle attack as a `ContextualSource`. `riders` and `source` are needed only to resolve `joined`. */
export function oracleSource(a: AttackSpec, riders: readonly RiderSpec[] = [], source = -1): ContextualSource {
  const rowCheck: RowCheck = {
    kind: 'attack',
    range: a.range ?? 'melee',
    rollType: rollTypeOf(a.rollOverride ?? a.advantage),
    advantageDice: a.elvenAccuracy ? 3 : 2,
    pinned: a.rollOverride !== undefined,
    autoHit: a.autoHit === true,
    autoCrit: a.autoCrit === true,
    autoFail: false
  }
  return {
    rowCheck,
    under: (context) => {
      if (context.joined.length === 0) return attackPmf(a, context)
      const indexes = context.joined.map((id) => Number(id.slice('rider:'.length)))
      const mixed = joinedAttacks(a, riders, source, indexes).map(({ attack, crit, p }): [PMF, number] => [attackPmf(attack, context, crit), p])
      return mixed.length === 1 ? mixed[0]![0] : PMF.mix(mixed)
    },
    dealt: (type, context) => typeDealtOdds(context.vulnerable ? withoutScales(a.damage) : a.damage, type)
  }
}

/** An oracle save as a `ContextualSource`. */
export function oracleSaveSource(s: SaveSpec): ContextualSource {
  const rowCheck: RowCheck = {
    kind: 'save',
    ...(s.ability ? { ability: s.ability } : {}),
    rollType: s.rollOverride ?? s.rollType ?? 'flat',
    advantageDice: 2,
    pinned: s.rollOverride !== undefined,
    autoHit: false,
    autoCrit: false,
    autoFail: s.autoFail === true
  }
  return { rowCheck, under: (context) => savePmf(s, context) }
}

/** What a rider deals on a row its dice join: nothing beside the row's own roll. */
const NOTHING = { onHit: PMF.zero(), onCrit: PMF.zero(), vulnerable: { onHit: PMF.zero(), onCrit: PMF.zero() } }

/** The harness's rider `payload(row)` and `typeDealt`, keyed by row id. */
function riderPayload(rider: RiderSpec): ContextualPayload {
  const specAt = (id: string): DiceSpec => {
    const k = Number(id.slice('row:'.length))
    return typeof rider.damage === 'function' ? rider.damage(k) : rider.damage
  }
  const modes = (damage: DiceSpec, scaled: boolean): { onHit: PMF; onCrit: PMF } => {
    const finish = (roll: RollBuilder): PMF => (scaled ? roll.scaleResult(2) : roll).toPMF()
    return hasTypedParts(damage)
      ? { onHit: finish(payloadBuilder(damage, false)), onCrit: finish(payloadBuilder(damage, true)) }
      : { onHit: finish(diceRoll(damage)), onCrit: finish(diceRoll({ ...damage, count: damage.count * 2 })) }
  }
  return {
    at: (id) => {
      if (rider.pooledOn?.includes(Number(id.slice('row:'.length)))) return NOTHING
      const spec = specAt(id)
      return { ...modes(spec, false), vulnerable: modes(withoutScales(spec), true) }
    },
    dealt: (type, id) => typeDealtOdds(specAt(id), type)
  }
}

const sourceCount = (turn: SyntheticTurn): number => turn.attacks.length + (turn.saves?.length ?? 0)
const isSave = (turn: SyntheticTurn, source: number): boolean => source >= turn.attacks.length

function riderOf(turn: SyntheticTurn, rider: RiderSpec, index: number): Rider {
  const partners = rider.alongside ?? []
  const opened = new Set(partners.flatMap(({ sources }) => sources))
  const rows = rider.of.filter((k) => !opened.has(k) && (rider.trigger !== 'hit' || !isSave(turn, k))).map(rowId)
  const max = rider.max ?? 1
  const common = {
    id: riderId(index),
    of: [...rows, ...partners.map(({ rider: partner }) => riderId(partner))],
    ...(partners.length > 0 ? { where: Object.fromEntries(partners.map(({ rider: partner, sources }) => [riderId(partner), sources.map(rowId)])) } : {}),
    ...(rider.trigger === 'damage' ? { landing: 'damage' as const } : rider.trigger === 'cast' ? { landing: 'any' as const } : {}),
    damage: riderPayload(rider),
    ...(rider.chance !== undefined ? { happens: rider.chance } : {}),
    ...(rider.pooledOn?.length ? { joins: rider.pooledOn.map(rowId) } : {})
  }
  if (rider.onCrit) return { ...common, on: 'any-crit', ...(max !== 1 ? { max } : {}) }
  if (max === 1) return { ...common, on: 'first-hit' }
  return { ...common, on: 'every-hit', ...(Number.isFinite(max) ? { max } : {}) }
}

function effectOf(effect: EffectSpec): V2Effect {
  const to = (rows?: readonly number[]) => (rows ? { to: rows.map(rowId) } : {})
  switch (effect.kind) {
    case 'condition':
      return { condition: effect.condition, rule: RULES[effect.condition], until: effect.lifetime === 'until-damaged' ? 'until-damaged' : 'end-of-turn' }
    case 'advantage':
    case 'disadvantage':
    case 'critOnHit':
      return { [effect.kind]: true, until: effect.lifetime === 'next-attack' ? 'next-attack' : 'end-of-turn', ...to(effect.to) }
    case 'vulnerability':
      return { vulnerability: true, until: 'next-hit' }
    case 'saveDisadvantage':
      return { saveDisadvantage: true, until: effect.lifetime === 'next-save' ? 'next-save' : 'end-of-turn', ...to(effect.to) }
    case 'savePenalty':
      return { savePenalty: { count: effect.count, sides: effect.sides }, until: effect.lifetime === 'next-save' ? 'next-save' : 'end-of-turn', ...to(effect.to) }
  }
}

function saveOf(grant: GrantSpec): { save?: V2Save | readonly V2Save[]; chance?: number } {
  if (grant.chance !== undefined) return { chance: grant.chance }
  const save = grant.save
  if (!save) return {}
  // A contest: the target takes the option it loses least with, as the oracle rolls it.
  const contest = save.contest
  if (contest !== undefined) {
    const losses = [save, ...(save.alternatives ?? [])].map((o) => contestLossChance({ attacker: contest, defender: o.saveBonus }))
    return { chance: Math.min(...losses) }
  }
  const options: V2Save[] = [
    { ...(save.ability ? { ability: save.ability } : {}), dc: save.dc, bonus: save.saveBonus },
    ...(save.alternatives ?? []).map((alt) => ({ ability: alt.ability, dc: save.dc, bonus: alt.saveBonus }))
  ]
  return { save: options.length === 1 ? options[0]! : options }
}

function conditionOf(turn: SyntheticTurn, grant: GrantSpec, index: number): ConditionSpec | undefined {
  const once = grant.cap === 'once'
  const attacksOnly = (rows: readonly number[]) => rows.filter((k) => !isSave(turn, k))
  let on: ConditionSpec['on']
  let of: readonly string[]
  let landing: 'fail' | 'damage' | undefined
  let where: Record<string, readonly string[]> | undefined
  switch (grant.trigger) {
    case 'kill':
      // It never lands (no hit points), so leaving it out is exact. dpr's reference `toSpec` throws `EngineOnlyError`
      // instead; omitting it keeps the 70-odd random turns that draw one under test.
      return undefined
    case 'passedSave':
      // Engine-only (see `oracleEngineOnly`): the case is never compared.
      return undefined
    case 'start':
      return {
        id: grantId(index),
        on: 'start',
        ...(startTarget(turn, grant.of[0]!) ? { target: startTarget(turn, grant.of[0]!) } : {}),
        grants: grant.effects.map(effectOf)
      }
    case 'hit':
      ;[on, of] = [once ? 'first-hit' : 'every-hit', attacksOnly(grant.of).map(rowId)]
      break
    case 'damage':
      ;[on, of, landing] = [once ? 'first-hit' : 'every-hit', grant.of.map(rowId), 'damage']
      break
    case 'crit':
      ;[on, of] = [once ? 'first-crit' : 'any-crit', attacksOnly(grant.of).map(rowId)]
      break
    case 'miss':
      ;[on, of] = [once ? 'first-miss' : 'any-miss', attacksOnly(grant.of).map(rowId)]
      break
    case 'failedSave':
      ;[on, of, landing] = [once ? 'first-hit' : 'every-hit', grant.of.filter((k) => isSave(turn, k)).map(rowId), 'fail']
      break
    case 'rider': {
      ;[on, of] = [once ? 'first-hit' : 'every-hit', [riderId(grant.rider!)]]
      const own = new Set(turn.riders![grant.rider!]!.of)
      if (grant.of.length !== own.size || grant.of.some((k) => !own.has(k))) where = { [riderId(grant.rider!)]: grant.of.map(rowId) }
      break
    }
  }
  if (of.length === 0) return undefined
  return {
    id: grantId(index),
    on,
    of,
    ...(where ? { where } : {}),
    ...(landing ? { landing } : {}),
    ...(grant.dealing !== undefined ? { dealing: grant.dealing } : {}),
    ...saveOf(grant),
    grants: grant.effects.map(effectOf),
    ...(grant.onPass ? { onSave: grant.onPass.map(effectOf) } : {}),
    ...(grant.optional ? { optional: true as const } : {})
  }
}

/** The `TurnSpec` v2 of an oracle turn; see the header for every mapping decision. */
export function oracleTurnToSpec(turn: SyntheticTurn): TurnSpec {
  for (const unsupported of ['frequencyRows', 'onCritRows', 'dependents', 'beams'] as const) {
    if (turn[unsupported]?.length) throw new Error(`oracleTurnToSpec: ${unsupported} are not part of the ported shapes`)
  }
  const saves = turn.saves ?? []
  const riders = turn.riders ?? []
  const order = turn.order ?? Array.from({ length: sourceCount(turn) }, (_, i) => i)
  const attacks: Attack[] = order.map((k): Attack => {
    const row = k < turn.attacks.length ? turn.attacks[k]! : saves[k - turn.attacks.length]!
    const source = k < turn.attacks.length ? oracleSource(turn.attacks[k]!, riders, k) : oracleSaveSource(saves[k - turn.attacks.length]!)
    const gate = 'gatedOn' in row ? row.gatedOn : undefined
    const target = creature(row.target)
    return {
      source,
      id: rowId(k),
      ...(row.chance !== undefined ? { chance: row.chance } : {}),
      ...(target ? { target } : {}),
      ...(gate ? { after: { of: rowId(gate.source), landing: gate.trigger === 'cast' ? ('any' as const) : gate.trigger } } : {})
    }
  })
  const conditions: ConditionSpec[] = []
  if (turn.startingCondition) {
    conditions.push({ id: START_ID, on: 'start', grants: [{ condition: turn.startingCondition, rule: RULES[turn.startingCondition], until: 'end-of-turn' }] })
  }
  ;(turn.grants ?? []).forEach((grant, i) => {
    const condition = conditionOf(turn, grant, i)
    if (condition) conditions.push(condition)
  })
  return {
    attacks,
    ...(riders.length ? { riders: riders.map((rider, i) => riderOf(turn, rider, i)) } : {}),
    ...(conditions.length ? { conditions } : {})
  }
}

/** The engine-only features `turn` uses (dpr's reference `toSpec` throws `EngineOnlyError` on each); empty for most. */
export function oracleEngineOnly(turn: SyntheticTurn): string[] {
  const features = new Set<string>()
  for (const grant of turn.grants ?? []) {
    if (grant.trigger === 'passedSave') features.add('passed-save')
    if (grant.effects.concat(grant.onPass ?? []).some((e) => 'against' in e && e.against === 'any')) features.add('against-any')
  }
  return [...features].sort()
}

/** Everything in `turn` the `TurnSpec` v2 contract cannot say exactly; empty when `oracleTurnToSpec` is exact. */
export function oracleTurnGaps(turn: SyntheticTurn): string[] {
  const gaps = new Set<string>()
  for (const grant of turn.grants ?? []) {
    if (grant.trigger !== 'start') continue
    const targets = new Set(grant.of.map((k) => (k < turn.attacks.length ? turn.attacks[k]!.target : turn.saves![k - turn.attacks.length]!.target) ?? 0))
    if (targets.size > 1) gaps.add('start grant over several creatures: ConditionSpec.target names one')
  }
  return [...gaps].sort()
}
