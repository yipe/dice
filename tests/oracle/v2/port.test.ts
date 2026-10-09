/**
 * The acceptance gate: every oracle case through `Turn.from(spec)` must give the oracle's
 * readers at 1e-12, field for field: per row id its marginal, the odds of the d20 it rolls and of every effect in
 * force with the part each source accounts for; per rider id its marginal and P(at least one landing). Off until
 * the port lands: `PORT_READY=1 yarn vitest run tests/oracle`. A case the contract cannot spell yet (`gaps`) is a
 * todo; an engine-only case is not listed.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RollType } from '../../../src/common/types'
import type { PMF } from '../../../src/pmf/pmf'
import { Turn, type AttackMarginal, type RiderMarginal } from '../../../src/turn/index'
import { FAMILIES } from './cases/index'
import { expectedPath, fromBits, type ExpectedCase, type ExpectedPmf, type ExpectedRow } from './expected'
import { START_ID } from './toSpec'

const TOLERANCE = 1e-12
const PORT_READY = Boolean(process.env.PORT_READY)

/** The oracle's roll type keys, by the library's roll type. */
const ROLL_TYPE_KEYS: Record<RollType, keyof ExpectedRow['rollType']> = {
  flat: 'flat',
  advantage: 'advantage',
  disadvantage: 'disadvantage',
  'elven accuracy': 'elven'
}

function expectClose(actual: number, expected: string, label: string): void {
  expect(Math.abs(actual - fromBits(expected)), label).toBeLessThanOrEqual(TOLERANCE)
}

function expectPmf(actual: PMF, expected: ExpectedPmf, label: string): void {
  const want = new Map(expected.map(([value, bits]) => [value, fromBits(bits)]))
  for (const value of new Set([...want.keys(), ...actual.support()])) {
    expect(Math.abs(actual.pAt(value) - (want.get(value) ?? 0)), `${label} at ${value}`).toBeLessThanOrEqual(TOLERANCE)
  }
}

/** A source as the oracle keys it: the starting condition is `start` in the spec. */
const sourceKey = (source: { kind: 'starting' } | { kind: 'grant'; grant: string }): string =>
  source.kind === 'starting' || source.grant === START_ID ? 'starting' : source.grant

function expectRow(turn: Turn, id: string, row: ExpectedRow, label: string): void {
  const marginal = turn.marginal(id) as AttackMarginal
  expectPmf(marginal.pmf, row.pmf, label)
  for (const [type, key] of Object.entries(ROLL_TYPE_KEYS) as [RollType, keyof ExpectedRow['rollType']][]) {
    expectClose(marginal.rollType[type], row.rollType[key], `${label} rollType ${key}`)
  }
  const { live } = turn.stepStats(id)
  for (const [name, { odds, sources }] of Object.entries(row.effects)) {
    const effect = name as keyof typeof live.sources
    expectClose(live[effect], odds, `${label} ${name}`)
    const got = new Map(live.sources[effect].map(({ source, odds: p }) => [sourceKey(source), p]))
    for (const key of new Set([...got.keys(), ...Object.keys(sources)])) {
      expectClose(got.get(key) ?? 0, sources[key] ?? '0000000000000000', `${label} ${name} from ${key}`)
    }
  }
}

for (const [family, cases] of Object.entries(FAMILIES)) {
  const expected: Record<string, ExpectedCase> = JSON.parse(readFileSync(expectedPath(family), 'utf8'))
  describe(`oracle ${family}`, () => {
    for (const c of cases) {
      if (c.engineOnly !== undefined) continue
      if (c.gaps.length > 0) {
        it.todo(`${c.name} (gaps: ${c.gaps.join('; ')})`)
        continue
      }
      it.skipIf(!PORT_READY)(c.name, () => {
        const want = expected[c.name]!
        const turn = Turn.from(c.spec)
        for (const [id, row] of Object.entries(want.rows)) expectRow(turn, id, row, `${c.name} ${id}`)
        for (const [id, rider] of Object.entries(want.riders)) {
          const marginal = turn.marginal(id) as RiderMarginal
          expectPmf(marginal.pmf, rider.pmf, `${c.name} ${id}`)
          expectClose(marginal.anyLanding, rider.landing, `${c.name} ${id} landing`)
          expectClose(turn.fireProbability(id), rider.landing, `${c.name} ${id} fireProbability`)
        }
        // A mean is a sum of damage times probability: compared at 1e-12 of its size.
        const mean = fromBits(want.mean)
        expect(Math.abs(turn.mean() - mean), `${c.name} mean`).toBeLessThanOrEqual(TOLERANCE * Math.max(1, mean))
      })
    }
  })
}
