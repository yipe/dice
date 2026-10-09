/**
 * `yarn oracle:expected`: runs the brute-force oracle on every acceptance case and writes
 * `tests/oracle/v2/expected/<family>.json`. Deterministic: keys in a fixed order, PMFs sorted by value, every
 * probability as the 16 hex digits of its float64 bits (`bitsOf`), so a second run is byte-identical.
 *
 * Per case: the turn's `mean` (the joint PMF is left out: the readers under test are marginals); per row id (`row:<source>`) its marginal `pmf`, its d20 roll type odds
 * and every effect's odds with their sources (the oracle's `starting` / `grant:<i>` keys); per rider id its `pmf` and
 * `landing` (P(at least one landing)).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enumerateSyntheticTurn, type SyntheticTurn } from '../bruteForce'
import { FAMILIES } from './cases/index'
import { riderId, rowId } from './toSpec'

export const EXPECTED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'expected')

/** The float64 bits of `p`, big-endian, as 16 hex digits: exact and stable across runs and platforms. */
export function bitsOf(p: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, p)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

/** The inverse of {@link bitsOf}. */
export function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

export type ExpectedPmf = Array<[number, string]>

export interface ExpectedRow {
  pmf: ExpectedPmf
  rollType: Record<'flat' | 'advantage' | 'disadvantage' | 'elven', string>
  effects: Record<string, { odds: string; sources: Record<string, string> }>
}

export interface ExpectedCase {
  mean: string
  rows: Record<string, ExpectedRow>
  riders: Record<string, { pmf: ExpectedPmf; landing: string }>
}

const pmfOf = (map: Map<number, number>): ExpectedPmf => [...map].sort(([a], [b]) => a - b).map(([value, p]) => [value, bitsOf(p)])
const sortedRecord = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/**
 * The grants the oracle walks for `turn`, by their index in `turn.grants`: with optional grants it enumerates only the
 * subset it keeps (the highest mean, the full set first), so its `grant:<i>` source keys index that subset.
 */
function keptGrants(turn: SyntheticTurn): number[] {
  const grants = turn.grants ?? []
  const all = grants.map((_, i) => i)
  const optional = all.filter((i) => grants[i]!.optional === true)
  if (optional.length === 0) return all
  let best: { kept: number[]; mean: number } | undefined
  for (let mask = (1 << optional.length) - 1; mask >= 0; mask--) {
    const kept = all.filter((i) => !optional.includes(i) || (mask & (1 << optional.indexOf(i))) !== 0)
    const { mean } = enumerateSyntheticTurn({ ...turn, grants: kept.map((i) => ({ ...grants[i]!, optional: false })) })
    if (!best || mean > best.mean) best = { kept, mean }
  }
  return best!.kept
}

export function expectedOf(turn: SyntheticTurn): ExpectedCase {
  const result = enumerateSyntheticTurn(turn, { detail: true })
  const detail = result.detail!
  // A source key names the grant by its index in the turn, not in the subset the oracle kept.
  const kept = keptGrants(turn)
  const sourceKey = (key: string): string => (key.startsWith('grant:') ? `grant:${kept[Number(key.slice(6))]}` : key)
  return {
    mean: bitsOf(result.mean),
    rows: sortedRecord(
      result.sources.map((pmf, k): [string, ExpectedRow] => {
        const row = detail.rows[k]!
        return [
          rowId(k),
          {
            pmf: pmfOf(pmf),
            rollType: {
              flat: bitsOf(row.rollType.flat),
              advantage: bitsOf(row.rollType.advantage),
              disadvantage: bitsOf(row.rollType.disadvantage),
              elven: bitsOf(row.rollType.elven)
            },
            effects: sortedRecord(
              Object.entries(row.effects).map(([name, odds]) => [
                name,
                { odds: bitsOf(odds.odds), sources: sortedRecord([...odds.sources].map(([key, p]) => [sourceKey(key), bitsOf(p)])) }
              ])
            )
          }
        ]
      })
    ),
    riders: sortedRecord(detail.riders.map((rider, i) => [riderId(i), { pmf: pmfOf(rider.pmf), landing: bitsOf(rider.landing) }]))
  }
}

export const expectedPath = (family: string): string => join(EXPECTED_DIR, `${family}.json`)

function main(): void {
  mkdirSync(EXPECTED_DIR, { recursive: true })
  for (const [family, cases] of Object.entries(FAMILIES)) {
    const names = new Set<string>()
    const out: Record<string, ExpectedCase> = {}
    for (const { name, synthetic } of cases) {
      if (names.has(name)) throw new Error(`oracle:expected: duplicate case name "${name}" in ${family}`)
      names.add(name)
      out[name] = expectedOf(synthetic)
    }
    // One line per case: small, and a changed case is a one-line diff.
    const lines = Object.entries(out).map(([name, expected]) => `${JSON.stringify(name)}: ${JSON.stringify(expected)}`)
    writeFileSync(expectedPath(family), `{\n${lines.join(',\n')}\n}\n`)
    console.log(`${family}: ${cases.length} cases`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
