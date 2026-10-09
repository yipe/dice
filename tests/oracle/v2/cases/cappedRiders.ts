// Ported from yipe/dpr packages/ddb/src/__tests__/oracle/conditionsCappedRidersVsOracle.test.ts (commit 52cc91228): every turn
// it runs through `expectCalculationMatchesOracle`, named `<test> / <label>`. The refusal tests (no oracle turn) are not cases.
import type { AttackSpec, DiceSpec, EffectSpec, GrantSpec, LandingTrigger, RiderSpec, SaveSpec, SyntheticTurn } from '../../bruteForce'
import { oracleCase, type OracleCase } from './types'

/** +6 against AC 15: a hit on a 9 to 19 (0.55), a crit on a 20 (0.05). */
const atk = (extra: Partial<AttackSpec> = {}): AttackSpec => ({
  toHit: 6,
  ac: 15,
  critRange: 20,
  advantage: 'flat',
  damage: { count: 1, sides: 6, flat: 2 },
  range: 'melee',
  ...extra
})
const save = (extra: Partial<SaveSpec> = {}): SaveSpec => ({ dc: 15, saveBonus: 2, onSuccess: 'half', damage: { count: 2, sides: 6 }, ...extra })
const typed = (type: string, count: number, sides: number, scale?: { num: number; den: number }): DiceSpec => ({
  count: 0,
  sides: 0,
  parts: [{ count, sides, type, ...(scale ? { scale } : {}) }]
})
const SUPERIORITY_DIE: DiceSpec = { count: 1, sides: 8 }
const PRONE: EffectSpec = { kind: 'condition', condition: 'prone' }

export const cases: OracleCase[] = []
const add = (test: string, turn: SyntheticTurn, label: string): void => void cases.push(oracleCase(`${test} / ${label}`, turn))

{
  const shapes: ReadonlyArray<{ label: string; attacks: AttackSpec[]; saves?: SaveSpec[]; order?: number[]; damage: RiderSpec['damage'] }> = [
    {
      label: 'four attacks at different rolls',
      attacks: [atk(), atk({ advantage: 'advantage', critRange: 19 }), atk({ advantage: 'disadvantage', toHit: 4 }), atk({ toHit: 9 })],
      damage: SUPERIORITY_DIE
    },
    {
      label: 'attacks and a half save, a payload typed per row',
      attacks: [atk(), atk({ advantage: 'elven' }), atk()],
      saves: [save()],
      damage: (row) =>
        [typed('slashing', 1, 8), typed('fire', 1, 8, { num: 1, den: 2 }), typed('cold', 1, 10, { num: 2, den: 1 }), typed('force', 1, 8)][row]!
    },
    {
      label: 'rows that may not happen, a save first in turn order',
      attacks: [atk({ chance: 0.5 }), atk({ chance: 0.8 }), atk()],
      saves: [save({ onSuccess: 'none' })],
      order: [3, 0, 1, 2],
      damage: { count: 1, sides: 10 }
    }
  ]
  const TRIGGERS: readonly LandingTrigger[] = ['hit', 'damage', 'cast']
  for (const shape of shapes) {
    for (const trigger of TRIGGERS) {
      const saves = shape.saves ?? []
      const of = Array.from({ length: shape.attacks.length + saves.length }, (_, i) => i)
      for (const max of [2, 3, Infinity]) {
        for (const chance of [1, 0.4]) {
          for (const onCrit of [false, true]) {
            const rider: RiderSpec = { of, trigger, damage: shape.damage, max, chance, ...(onCrit ? { onCrit } : {}) }
            const turn: SyntheticTurn = { attacks: shape.attacks, saves, ...(shape.order ? { order: shape.order } : {}), riders: [rider] }
            add(`${shape.label}, ${trigger}`, turn, `max ${max}, chance ${chance}${onCrit ? ', on crit' : ''}`)
          }
        }
      }
    }
  }
  add('max 2 over two rows', { attacks: [atk(), atk({ advantage: 'advantage' })], riders: [{ of: [0, 1], trigger: 'hit', damage: SUPERIORITY_DIE, max: 2 }] }, 'two rows')
  const three = [atk(), atk({ advantage: 'advantage' }), atk({ toHit: 3 })]
  add('max 1 is first-hit', { attacks: three, riders: [{ of: [0, 1, 2], trigger: 'hit', damage: SUPERIORITY_DIE }] }, 'plain')
  add('max 1 is first-hit', { attacks: three, riders: [{ of: [0, 1, 2], trigger: 'hit', damage: SUPERIORITY_DIE, max: 1 }] }, 'max 1')
}

{
  const attacks = [atk(), atk({ advantage: 'disadvantage' }), atk({ toHit: 8 }), atk()]
  const riders: RiderSpec[] = [
    { of: [0, 1, 2, 3], trigger: 'hit', damage: SUPERIORITY_DIE, max: 2 },
    { of: [0, 1, 2, 3], trigger: 'hit', damage: { count: 3, sides: 6 } },
    { of: [1, 2, 3], trigger: 'hit', damage: { count: 1, sides: 4 }, max: 3 }
  ]
  add('beside a first-hit rider', { attacks, riders }, 'three riders')
    const trip: GrantSpec = {
      of: [0, 1, 2, 3],
      trigger: 'rider',
      rider: 0,
      cap: 'unlimited',
      save: { ability: 'strength', dc: 15, saveBonus: 3 },
      effects: [PRONE]
    }
  for (const max of [2, 3]) {
    add('trip attack', { attacks, riders: [{ of: [0, 1, 2, 3], trigger: 'hit', damage: SUPERIORITY_DIE, max }], grants: [trip] }, `trip, max ${max}`)
  }
  const curse: GrantSpec = { of: [0, 1, 2, 3], trigger: 'start', cap: 'once', effects: [{ kind: 'vulnerability', lifetime: 'next-hit' }] }
  add('next-hit vulnerability', { attacks, riders: [{ of: [0, 1, 2, 3], trigger: 'hit', damage: SUPERIORITY_DIE, max: 2 }], grants: [curse] }, 'curse')
    const rerolling = (extra: Partial<AttackSpec> = {}): AttackSpec => atk({ damage: { count: 1, sides: 8, flat: 3, rerollDice: 1 }, ...extra })
    const pooled = [rerolling(), rerolling({ advantage: 'disadvantage' }), atk(), rerolling({ toHit: 9 })]
    for (const max of [2, 3]) {
      for (const pooledOn of [
        [0, 1, 3],
        [1, 3]
      ]) {
        const rider: RiderSpec = { of: [0, 1, 2, 3], trigger: 'hit', damage: SUPERIORITY_DIE, max, pooledOn }
        add("piercer", { attacks: pooled, riders: [rider] }, `max ${max}, pooled on ${pooledOn.join(',')}`)
      }
    }
  const topple: GrantSpec = { of: [0, 1, 2], trigger: 'hit', cap: 'once', save: { ability: 'constitution', dc: 14, saveBonus: 2 }, effects: [PRONE] }
  add('topple', { attacks, riders: [{ of: [0, 1, 2, 3], trigger: 'damage', damage: SUPERIORITY_DIE, max: 2 }], grants: [topple] }, 'topple')
    const slashing = [atk({ damage: typed('slashing', 1, 8) }), atk({ damage: typed('slashing', 1, 8) }), atk({ damage: typed('slashing', 1, 8) })]
    const crusher: GrantSpec = { of: [0, 1, 2], trigger: 'crit', dealing: 'bludgeoning', cap: 'once', effects: [{ kind: 'advantage', lifetime: 'turn' }] }
    const rider: RiderSpec = { of: [0, 1, 2], trigger: 'hit', damage: typed('slashing', 1, 8), max: 2 }
    add('crusher', { attacks: slashing, riders: [rider], grants: [crusher] }, 'crusher')
  const knockOut: GrantSpec = { of: [0], trigger: 'hit', cap: 'once', effects: [{ kind: 'condition', condition: 'unconscious', lifetime: 'until-damaged' }] }
  add('knock out', { attacks: [atk(), atk(), atk()], riders: [{ of: [1, 2], trigger: 'cast', damage: SUPERIORITY_DIE, max: 2 }], grants: [knockOut] }, 'knock out')
  const coldAttacks = [atk({ damage: typed('slashing', 1, 8) }), atk({ damage: typed('slashing', 1, 8) })]
  const frost: GrantSpec = { of: [0], trigger: 'hit', dealing: 'cold', cap: 'once', effects: [{ kind: 'advantage', lifetime: 'next-attack' }] }
  add('cold split', { attacks: coldAttacks, riders: [{ of: [0, 1], trigger: 'hit', damage: typed('cold', 1, 8), max: 2 }], grants: [frost] }, 'cold, certain')
}
