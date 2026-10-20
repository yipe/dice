// Boon of Combat Prowess (`SyntheticTurn.convertFirstMiss`): the first watched miss of the turn hits instead, as a plain hit.
import type { AttackSpec, SyntheticTurn } from '../../bruteForce'
import { attack, grant, save, sneak } from '../shapes'
import { oracleCase, type OracleCase } from './types'

/** Three rows with distinct odds and damage: 60% / 60% / 50% to land against AC 15. */
export const THREE_ROWS: readonly AttackSpec[] = [
  attack({ toHit: 6, damage: { count: 2, sides: 6, flat: 5 } }),
  attack({ toHit: 6, damage: { count: 1, sides: 10, flat: 4 } }),
  attack({ toHit: 4, damage: { count: 2, sides: 10, flat: 9 } })
]

const all = (turn: Pick<SyntheticTurn, 'attacks'>): number[] => turn.attacks.map((_, i) => i)

export const cases: OracleCase[] = []
const add = (test: string, turn: SyntheticTurn, label: string): void => void cases.push(oracleCase(`${test} / ${label}`, turn))

add('three rows, distinct odds and damage', { attacks: THREE_ROWS, convertFirstMiss: { of: [0, 1, 2] } }, 'all rows')
add('three rows, distinct odds and damage', { attacks: THREE_ROWS, convertFirstMiss: { of: [1, 2] } }, 'the last two')
add('three rows, distinct odds and damage', { attacks: THREE_ROWS, order: [2, 0, 1], convertFirstMiss: { of: [0, 1, 2] } }, 'reordered')
add('only a natural 20 hits', { attacks: [attack({ toHit: 0, ac: 30 }), attack({ toHit: 0, ac: 30 })], convertFirstMiss: { of: [0, 1] } }, 'nat 1 converts')
add('only a natural 1 misses', { attacks: [attack({ toHit: 20 }), attack()], convertFirstMiss: { of: [0, 1] } }, 'nat 1 converts')
add(
  'a crit-only rider never lands on a converted hit',
  { attacks: THREE_ROWS, riders: [{ of: [0, 1, 2], trigger: 'hit', damage: { count: 2, sides: 8 }, onCrit: true }], convertFirstMiss: { of: [0, 1, 2] } },
  'any-crit rider'
)
add('advantage resolves first', { attacks: [attack({ advantage: 'advantage' }), attack()], convertFirstMiss: { of: [0, 1] } }, 'advantage')
add('a reroll of ones resolves first', { attacks: [attack({ rerollOnes: true }), attack()], convertFirstMiss: { of: [0, 1] } }, 'halfling luck')
add('a miss payload is replaced by the hit', { attacks: [attack({ missDamage: { kind: 'flat', amount: 4 } }), attack()], convertFirstMiss: { of: [0] } }, 'graze')
add('a row that may not happen converts only when it rolls', { attacks: [attack({ chance: 0.5 }), attack()], convertFirstMiss: { of: [0, 1] } }, 'chance 0.5')
{
  const turn: SyntheticTurn = { attacks: THREE_ROWS, riders: [sneak()], convertFirstMiss: { of: [0, 1, 2] } }
  add('sneak attack over the same rows', turn, 'first landing may be the converted one')
}
add('sneak attack over the same rows', { attacks: THREE_ROWS, riders: [sneak({ of: [1, 2] })], convertFirstMiss: { of: [0] } }, 'rider on other rows')
add('advantage on the next attack after a hit', { attacks: THREE_ROWS, grants: [grant({ of: [0, 1] })], convertFirstMiss: { of: [0, 1, 2] } }, 'vex')
add(
  'a save between the rows reads nothing of the conversion',
  { attacks: THREE_ROWS, saves: [save()], order: [0, 3, 1, 2], riders: [sneak()], convertFirstMiss: { of: all({ attacks: THREE_ROWS }) } },
  'save between'
)
