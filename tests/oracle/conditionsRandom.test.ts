// Brute-force oracle test, shared with the yipe/dpr repository (packages/ddb/src/__tests__/oracle/conditionsRandom.test.ts).
/**
 * The seeded generators behind the calculation's sweeps are deterministic: a failing sweep names its seed, and that seed has to
 * rebuild the same turn on another run or machine.
 */
import { describe, expect, it } from 'vitest'
import { generator, randomCurseTurn, randomFormatTurn, randomTurn } from './conditionsRandom'
import { syntheticHash } from './v2/expected'

describe('the seeded generators', () => {
  it('two generators with the same seed give the same sequence, and another seed gives another', () => {
    const draw = (seed: number): number[] => {
      const g = generator(seed)
      return Array.from({ length: 20 }, () => g.next())
    }
    expect(draw(1234)).toEqual(draw(1234))
    expect(draw(1234)).not.toEqual(draw(1235))
  })

  it.each([
    ['randomTurn', randomTurn],
    ['randomFormatTurn', randomFormatTurn],
    ['randomCurseTurn', randomCurseTurn]
  ])('%s rebuilds the same turn from a seed, and another seed gives another', (_name, build) => {
    // Hashed: a per-row payload function compares by its value on every row, not by identity.
    const turnOf = (seed: number): string => syntheticHash(build(seed))
    for (const seed of [1000, 7000, 7050]) expect(turnOf(seed)).toBe(turnOf(seed))
    expect(turnOf(1000)).not.toBe(turnOf(1001))
  })
})
