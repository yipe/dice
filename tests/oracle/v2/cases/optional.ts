// Supplementary cases (no dpr condition-matrix test uses an optional grant): "you can" grants, which the oracle resolves by
// trying every subset and keeping the best mean. Topple before ranged follow-ups is declined; before melee it is taken.
import type { GrantSpec, SyntheticTurn } from '../../bruteForce'
import { CONSTITUTION, attack, condition, grant, sneak } from '../shapes'
import { oracleCase, type OracleCase } from './types'

const topple = (extra: Partial<GrantSpec> = {}): GrantSpec => ({ of: [0], trigger: 'hit', cap: 'once', save: CONSTITUTION, optional: true, effects: [condition('prone')], ...extra })

const shapes: Array<[string, SyntheticTurn]> = [
  ['optional Topple before melee attacks (taken)', { attacks: [attack(), attack(), attack()], grants: [topple()] }],
  ['optional Topple before ranged attacks (declined)', { attacks: [attack(), attack({ range: 'ranged' }), attack({ range: 'ranged' })], grants: [topple()] }],
  [
    'optional Topple beside a certain advantage grant and Sneak Attack, mixed ranges',
    {
      attacks: [attack(), attack({ range: 'ranged', toHit: 8 }), attack()],
      grants: [topple({ of: [0, 1] }), grant({ of: [1], trigger: 'damage' })],
      riders: [sneak()]
    }
  ]
]

export const cases: OracleCase[] = shapes.map(([name, turn]) => oracleCase(name, turn))
