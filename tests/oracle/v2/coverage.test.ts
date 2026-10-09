/**
 * Table and contract coverage of the oracle acceptance suite: every `RULES` cell and every new `TurnSpec` v2 field is
 * exercised by at least one case, so a flipped rule or a dropped field cannot pass the oracle gate unnoticed.
 *
 * A RULES cell is (condition, `attack.melee` / `attack.ranged` / `save.<ability>`). A case exercises it when a
 * condition of that name can be in force on a creature (a `start` condition, or one granted by a row before) and a
 * later row aimed at that creature is an attack of that range or a save of that ability.
 */
import { describe, expect, it } from 'vitest'
import { RULES } from '../../../src/dnd5e/index'
import type { Attack, EffectSpec, RowCheck, TurnSpec } from '../../../src/turn/types'
import { FAMILIES, type OracleCase } from './cases/index'

const EVERY_CASE: readonly OracleCase[] = Object.values(FAMILIES).flat()
/** Cases the port is judged on: engine-only features are excluded from coverage and from the port test. */
const ALL = EVERY_CASE.filter((c) => c.engineOnly === undefined)
/** The engine-only cases, pinned so a change to the generators or the exclusion rule is a reviewed diff. */
const ENGINE_ONLY_COUNT = 171

/** Every attack `oracleTurnToSpec` writes is a wrapper with an id around a `ContextualSource`. */
function wrapped(attack: Attack): { id: string; target?: string; check: RowCheck } {
  if (!('source' in attack) || attack.id === undefined || !('rowCheck' in attack.source)) throw new Error('coverage: not an oracleTurnToSpec row')
  return { id: attack.id, ...(attack.target ? { target: attack.target } : {}), check: attack.source.rowCheck }
}

const rowsOf = (spec: TurnSpec) => spec.attacks.map(wrapped).map((row) => ({ ...row, target: row.target ?? 'target' }))

function conditionNames(effects: readonly EffectSpec[] | undefined): string[] {
  return (effects ?? []).flatMap((effect) => ('condition' in effect ? [effect.condition] : []))
}

/** The RULES cells a spec exercises. */
function cellsOf(spec: TurnSpec): Set<string> {
  const rows = rowsOf(spec)
  const riders = new Map((spec.riders ?? []).map((rider) => [rider.id, [rider.of ?? []].flat()]))
  const index = new Map(rows.map((row, i) => [row.id, i]))
  const cells = new Set<string>()
  const readers = (names: string[], after: number, target: string) => {
    for (const row of rows.slice(after + 1)) {
      if (row.target !== target) continue
      for (const name of names) {
        cells.add(row.check.kind === 'attack' ? `${name} attack.${row.check.range}` : `${name} save.${row.check.ability}`)
      }
    }
  }
  for (const condition of spec.conditions ?? []) {
    const names = [...conditionNames(condition.grants), ...conditionNames(condition.onSave)]
    if (names.length === 0) continue
    if (condition.on === 'start') {
      readers(names, -1, condition.target ?? 'target')
      continue
    }
    // A watched rider stands for the rows it watches.
    const sources = (condition.of ?? []).flatMap((id) => (riders.has(id) ? riders.get(id)! : [id]))
    for (const id of sources) {
      const at = index.get(id)
      if (at !== undefined) readers(names, at, rows[at]!.target)
    }
  }
  return cells
}

const EVERY_CELL: readonly string[] = Object.entries(RULES).flatMap(([name, rule]) => [
  ...Object.keys(rule.attack ?? {}).map((range) => `${name} attack.${range}`),
  ...Object.keys(rule.save ?? {}).map((ability) => `${name} save.${ability}`)
])

const lifetimeOf = (effect: EffectSpec): string => {
  const kind =
    'condition' in effect
      ? 'condition'
      : 'vulnerability' in effect
        ? 'vulnerability'
        : 'saveDisadvantage' in effect
          ? 'saveDisadvantage'
          : 'savePenalty' in effect
            ? 'savePenalty'
            : (['advantage', 'disadvantage', 'critOnHit'] as const).find((k) => k in effect)!
  return `${kind} until ${effect.until}`
}

/** The new contract fields a spec uses. */
function fieldsOf(spec: TurnSpec): Set<string> {
  const fields = new Set<string>()
  const rows = new Set(spec.attacks.map((attack) => wrapped(attack).id))
  const riderIds = new Set((spec.riders ?? []).map((rider) => rider.id))
  for (const attack of spec.attacks) {
    if (wrapped(attack).target) fields.add('target (attack)')
    if ('after' in attack && attack.after) fields.add(`after: ${attack.after.landing}`)
  }
  for (const rider of spec.riders ?? []) {
    if (rider.landing) fields.add(`landing: ${rider.landing} (rider)`)
    if (rider.where) fields.add('where (rider)')
    if (rider.on === 'any-crit' && 'max' in rider && rider.max !== undefined) fields.add('max on any-crit')
    if (rider.happens !== undefined) fields.add('happens')
    if (rider.joins?.length) fields.add('joins')
    if ([rider.of ?? []].flat().some((id) => riderIds.has(id) && !rows.has(id))) fields.add('rider id in of (rider)')
  }
  for (const condition of spec.conditions ?? []) {
    fields.add(`on: ${condition.on}`)
    if (condition.landing) fields.add(`landing: ${condition.landing} (condition)`)
    if (condition.dealing !== undefined) fields.add('dealing')
    if (condition.where) fields.add('where (condition)')
    if (condition.target) fields.add('target (start)')
    if (Array.isArray(condition.save)) fields.add('save array')
    else if (condition.save) fields.add('save object')
    if (condition.optional) fields.add('optional')
    if (condition.onSave?.length) fields.add('onSave')
    if ([condition.of ?? []].flat().some((id) => riderIds.has(id) && !rows.has(id))) fields.add('rider id in of (condition)')
    for (const effect of [...condition.grants, ...(condition.onSave ?? [])]) fields.add(lifetimeOf(effect))
  }
  return fields
}

const EVERY_FIELD: readonly string[] = [
  'target (attack)',
  'target (start)',
  'landing: damage (rider)',
  'landing: any (rider)',
  'after: hit',
  'after: damage',
  'after: any',
  'where (rider)',
  'where (condition)',
  'max on any-crit',
  'landing: damage (condition)',
  'landing: fail (condition)',
  'happens',
  'joins',
  'rider id in of (rider)',
  'rider id in of (condition)',
  'on: start',
  'on: first-hit',
  'on: every-hit',
  'on: first-crit',
  'on: any-crit',
  'on: first-miss',
  'on: any-miss',
  'dealing',
  'save array',
  'save object',
  'optional',
  'onSave',
  'advantage until next-attack',
  'advantage until end-of-turn',
  'disadvantage until next-attack',
  'disadvantage until end-of-turn',
  'critOnHit until next-attack',
  'critOnHit until end-of-turn',
  'condition until end-of-turn',
  'condition until until-damaged',
  'vulnerability until next-hit',
  'saveDisadvantage until end-of-turn',
  'saveDisadvantage until next-save',
  'savePenalty until end-of-turn',
  'savePenalty until next-save'
]

const uncovered = (every: readonly string[], seen: (c: OracleCase) => Set<string>, cases: readonly OracleCase[]): string[] => {
  const all = new Set(cases.flatMap((c) => [...seen(c)]))
  return every.filter((item) => !all.has(item))
}

describe('oracle acceptance suite coverage', () => {
  it('has unique case names within each family', () => {
    for (const cases of Object.values(FAMILIES)) expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
  })

  it(`excludes exactly ${ENGINE_ONLY_COUNT} engine-only cases`, () => {
    expect(EVERY_CASE.length - ALL.length).toBe(ENGINE_ONLY_COUNT)
  })

  it('exercises every RULES cell', () => {
    expect(uncovered(EVERY_CELL, (c) => cellsOf(c.spec), ALL)).toEqual([])
  })

  it('exercises every RULES cell in a case the contract spells exactly', () => {
    expect(uncovered(EVERY_CELL, (c) => cellsOf(c.spec), ALL.filter((c) => c.gaps.length === 0))).toEqual([])
  })

  it('uses every new contract field, every effect kind and every lifetime', () => {
    expect(uncovered(EVERY_FIELD, (c) => fieldsOf(c.spec), ALL)).toEqual([])
  })
})
