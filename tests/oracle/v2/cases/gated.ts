// Ported from yipe/dpr packages/ddb/src/__tests__/oracle/conditionsGatedVsOracle.test.ts (commit 52cc91228): its shape
// table verbatim, plus the turns its other oracle-free tests evaluate. The seeded sweep is the random family.
import type { AttackSpec, GrantSpec, SyntheticTurn } from '../../bruteForce'
import { CONSTITUTION, NEXT_ADVANTAGE, attack, condition, grant, save } from '../shapes'
import { oracleCase, type OracleCase } from './types'

const cold = (extra: Partial<AttackSpec> = {}): AttackSpec =>
  attack({ damage: { count: 0, sides: 0, parts: [{ count: 1, sides: 8, type: 'cold' }] }, ...extra })
const fire = (extra: Partial<AttackSpec> = {}): AttackSpec =>
  attack({ damage: { count: 0, sides: 0, parts: [{ count: 1, sides: 8, type: 'fire' }] }, ...extra })
const FROSTBITE = (...of: number[]): GrantSpec => ({
  of,
  trigger: 'hit',
  dealing: 'cold',
  cap: 'once',
  effects: [{ kind: 'savePenalty', count: 1, sides: 4, lifetime: 'next-save' }]
})

/**
 * Sources are the attacks, then the saves; `order` walks them. Every shape has a gated save whose parent comes before it.
 */
export const shapes: Array<[string, SyntheticTurn]> = [
  [
    'the parent is the Frostbite trigger: the gated save is penalised whenever it happens',
    {
      attacks: [cold()],
      saves: [save({ gatedOn: { source: 0, trigger: 'hit' } })],
      grants: [FROSTBITE(0)]
    }
  ],
  [
    'the parent is a trigger and the gate waits for damage, not a hit',
    {
      attacks: [cold({ damage: { count: 0, sides: 0, parts: [{ count: 1, sides: 8, type: 'cold', scale: { num: 1, den: 2 } }] } })],
      saves: [save({ gatedOn: { source: 0, trigger: 'damage' } })],
      grants: [FROSTBITE(0)]
    }
  ],
  [
    'the parent is not a trigger: a gated save that may not happen leaves the penalty for the save after it',
    {
      attacks: [cold(), fire()],
      saves: [save({ gatedOn: { source: 1, trigger: 'hit' } }), save()],
      grants: [FROSTBITE(0)]
    }
  ],
  [
    'two saves gated on the same parent: the first takes the penalty and the second, which happens with it, gets none',
    {
      attacks: [cold()],
      saves: [save({ gatedOn: { source: 0, trigger: 'hit' } }), save({ gatedOn: { source: 0, trigger: 'hit' } })],
      grants: [FROSTBITE(0)]
    }
  ],
  [
    'two saves gated on different parents, the trigger is the second parent',
    {
      attacks: [fire(), cold()],
      saves: [save({ gatedOn: { source: 0, trigger: 'hit' } }), save({ gatedOn: { source: 1, trigger: 'hit' } })],
      order: [0, 1, 2, 3],
      grants: [FROSTBITE(1)]
    }
  ],
  [
    'a cast gate waits for the parent to happen, not to land',
    {
      attacks: [cold({ chance: 0.5 })],
      saves: [save({ gatedOn: { source: 0, trigger: 'cast' } })],
      grants: [FROSTBITE(0)]
    }
  ],
  [
    'a gated save between two triggers',
    {
      attacks: [cold(), cold()],
      saves: [save({ gatedOn: { source: 0, trigger: 'hit' } }), save()],
      order: [0, 2, 1, 3],
      grants: [FROSTBITE(0, 1)]
    }
  ],
  [
    'Stunning Strike from the parent: the gated Dexterity save fails automatically where the target was stunned',
    {
      attacks: [attack(), attack()],
      saves: [save({ ability: 'dexterity', gatedOn: { source: 0, trigger: 'hit' } })],
      order: [0, 2, 1],
      grants: [{ of: [0, 1], trigger: 'hit', save: CONSTITUTION, cap: 'unlimited', effects: [condition('stunned')] }]
    }
  ],
  [
    'Stunning Strike from another row than the parent, the gated save is stunned only where that row stunned it',
    {
      attacks: [attack(), attack()],
      saves: [save({ ability: 'strength', gatedOn: { source: 1, trigger: 'hit' } })],
      order: [0, 1, 2],
      grants: [{ of: [0], trigger: 'hit', save: CONSTITUTION, cap: 'once', effects: [condition('stunned')], onPass: [NEXT_ADVANTAGE] }]
    }
  ],
  [
    'Vex from the parent reaches an attack after the gated save, and the gate does not stop the next attack reading it',
    {
      attacks: [attack(), attack()],
      saves: [save({ gatedOn: { source: 0, trigger: 'damage' } })],
      order: [0, 2, 1],
      grants: [grant({ trigger: 'damage', of: [0] })]
    }
  ]
]

export const cases: OracleCase[] = shapes.map(([name, turn]) => oracleCase(name, turn))
