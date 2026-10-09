// Ported from yipe/dpr packages/ddb/src/__tests__/oracle/conditionsAlongsideVsOracle.test.ts (commit 52cc91228): every turn
// it runs through the enumerator. The refusal tests and the canary (TurnEngine) tests have no oracle turn and are not cases.
import type { AttackSpec, LandingTrigger, RiderSpec, SaveSpec, SyntheticTurn } from '../../bruteForce'
import { oracleCase, type OracleCase } from './types'

const atk = (extra: Partial<AttackSpec> = {}): AttackSpec => ({
  toHit: 6,
  ac: 15,
  critRange: 20,
  advantage: 'flat',
  damage: { count: 1, sides: 8, flat: 3 },
  range: 'melee',
  ...extra
})
const save = (extra: Partial<SaveSpec> = {}): SaveSpec => ({ dc: 15, saveBonus: 2, onSuccess: 'half', damage: { count: 3, sides: 6 }, ...extra })
const SMITE = { count: 2, sides: 6 }
const FLARE = { count: 2, sides: 8 }

export const cases: OracleCase[] = []
const add = (test: string, turn: SyntheticTurn, label: string): void => void cases.push(oracleCase(`${test} / ${label}`, turn))

// Rows 0 to 2 are weapon attacks the smite watches; row 3 is a radiant spell (a save) the flare reaches on its own.
const attacks = [atk(), atk({ advantage: 'disadvantage' }), atk({ toHit: 9, critRange: 19 })]
const saves = [save()]
const TRIGGERS: readonly LandingTrigger[] = ['hit', 'damage']

for (const trigger of TRIGGERS) {
  for (const onCrit of [false, true]) {
    const smite: RiderSpec = { of: [0, 1, 2], trigger: 'hit', damage: SMITE, ...(onCrit ? { onCrit } : {}) }
    const flare: RiderSpec = { of: [0, 1, 2, 3], trigger, damage: FLARE, alongside: [{ rider: 0, sources: [0, 1, 2] }] }
    add(`smite and flare, ${trigger} trigger`, { attacks, saves, riders: [smite, flare] }, onCrit ? 'on crit' : 'on hit')
  }
}
const spellFirst: SyntheticTurn = {
  attacks,
  saves,
  order: [3, 0, 1, 2],
  riders: [
    { of: [0, 1, 2], trigger: 'hit', damage: SMITE },
    { of: [0, 1, 2, 3], trigger: 'damage', damage: FLARE, alongside: [{ rider: 0, sources: [0, 1, 2] }] }
  ]
}
add("the spell first in turn order", spellFirst, 'spell first')
{
    const turn: SyntheticTurn = {
      attacks,
      riders: [
        { of: [0, 1], trigger: 'hit', damage: SMITE },
        { of: [1, 2], trigger: 'hit', damage: { count: 3, sides: 8 }, onCrit: true },
        {
          of: [0, 1, 2],
          trigger: 'hit',
          damage: FLARE,
          alongside: [
            { rider: 0, sources: [0, 1] },
            { rider: 1, sources: [1, 2] }
          ]
        }
      ]
    }
  add('two smites as partners', turn, 'two partners')
}
{
    const riders = (perPartner: boolean): RiderSpec[] => [
      { of: [0, 1], trigger: 'hit', damage: SMITE, onCrit: true },
      { of: [0, 1, 2], trigger: 'hit', damage: { count: 1, sides: 6 } },
      {
        of: [0, 1, 2],
        trigger: 'hit',
        damage: FLARE,
        alongside: perPartner
          ? [
              { rider: 0, sources: [0, 1] },
              { rider: 1, sources: [2] }
            ]
          : [
              { rider: 0, sources: [0, 1] },
              { rider: 1, sources: [0, 1, 2] }
            ]
      }
    ]
  add('a partner opens only its own rows', { attacks, riders: riders(true) }, 'each partner its own rows')
  add('a partner opens only its own rows', { attacks, riders: riders(false) }, 'every partner every row')
}
{
    const riders = (alongside: boolean): RiderSpec[] => [
      { of: [0, 1, 2], trigger: 'hit', damage: SMITE, onCrit: true },
      { of: [0, 1, 2], trigger: 'hit', damage: FLARE, ...(alongside ? { alongside: [{ rider: 0, sources: [0, 1, 2] }] } : {}) }
    ]
  add('alongside matters', { attacks, riders: riders(true) }, 'coupled')
  add('alongside matters', { attacks, riders: riders(false) }, 'plain')
}
