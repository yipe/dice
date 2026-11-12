import { describe, expect, it } from 'vitest'
import { d20, keepBestDamage, roll, turn } from '../../src/builder'
import { enumerateSyntheticTurn } from './bruteForce'

const TOLERANCE = 1e-12

describe('keepHigherFirstHit on an attack with an explicit crit payload', () => {
  it('rolls the crit payload twice and keeps the higher, like the turn', () => {
    // d20 + 0 vs AC 11: 9/20 hit, 1/20 crit. Hit 1d4 (E max of 2d4 = 25/8), explicit crit 1d6 (E max of 2d6 = 161/36).
    const oracle = enumerateSyntheticTurn({
      attacks: [
        {
          toHit: 0,
          ac: 11,
          critRange: 20,
          advantage: 'flat',
          damage: { count: 1, sides: 4 },
          critDamage: { count: 1, sides: 6 }
        }
      ],
      keepHigherFirstHit: { of: [0] }
    })
    const attack = d20.plus(0).ac(11).onHit(roll(1).d4()).onCrit(roll(1).d6())
    const expected = (9 / 20) * (25 / 8) + (1 / 20) * (161 / 36)
    expect(Math.abs(turn([attack]).onFirstHit(keepBestDamage()).mean() - expected)).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(oracle.mean - expected)).toBeLessThanOrEqual(TOLERANCE)
  })
})
