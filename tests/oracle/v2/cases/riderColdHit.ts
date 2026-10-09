// Ported from yipe/dpr packages/ddb/src/__tests__/oracle/riderColdHit.test.ts (commit 532a1b1dd): every turn its
// "against the enumerator" tests run through `expectCalculationMatchesOracle`, named `<test> / <label>`. A rider's dice are
// damage of the hit they land on, so a rider that deals cold makes that hit a cold hit for Cold Caster's Frostbite.
import type { AttackSpec, DamageScaleSpec, GrantSpec, PartSpec, RiderSpec, SyntheticTurn } from '../../bruteForce'
import { attack, grant, save } from '../shapes'
import { oracleCase, type OracleCase } from './types'

const HALF: DamageScaleSpec = { num: 1, den: 2 }
const IMMUNE: DamageScaleSpec = { num: 0, den: 1 }

/** A weapon attack at +5 against AC 15 (a hit on 10 to 19, a crit on a 20: 0.55 lands) whose damage is one typed part. */
const weapon = (part: Partial<PartSpec> = {}, extra: Partial<AttackSpec> = {}): AttackSpec =>
  attack({ toHit: 5, damage: { count: 0, sides: 0, parts: [{ count: 1, sides: 8, flat: 3, type: 'slashing', ...part }] }, ...extra })

/** A rider whose payload is the typed `parts`, over `of`. */
const rider = (of: readonly number[], parts: readonly PartSpec[], extra: Partial<RiderSpec> = {}): RiderSpec => ({
  of: [...of],
  trigger: 'hit',
  damage: { count: 0, sides: 0, parts: [...parts] },
  ...extra
})
const cold = (extra: Partial<PartSpec> = {}): PartSpec => ({ count: 1, sides: 6, type: 'cold', ...extra })

/** Frostbite over the rows `of`: a hit that deals cold damage spends the use and the next save loses 1d4. */
const frostbite = (of: readonly number[]): GrantSpec =>
  grant({ of: [...of], trigger: 'hit', dealing: 'cold', cap: 'once', effects: [{ kind: 'savePenalty', count: 1, sides: 4, lifetime: 'next-save' }] })

const frostbiteTurn = (extra: Partial<SyntheticTurn> & Pick<SyntheticTurn, 'attacks'>): SyntheticTurn => ({
  saves: [save()],
  grants: [frostbite(extra.attacks.map((_, i) => i))],
  order: [...extra.attacks.map((_, i) => i), extra.attacks.length],
  ...extra
})

export const cases: OracleCase[] = []
const add = (test: string, turn: SyntheticTurn, label: string): void => void cases.push(oracleCase(`${test} / ${label}`, turn))

add('a cold rider on one attack, then a save', frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold()])] }), 'one attack')
add('a hit with advantage', frostbiteTurn({ attacks: [weapon({}, { advantage: 'advantage' })], riders: [rider([0], [cold()])] }), 'advantage')
add('a rider that may not happen', frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold()], { chance: 0.5 })] }), 'chance 0.5')
add(
  'two attacks the rider watches: it lands on the first hit, and the penalty is spent there',
  frostbiteTurn({ attacks: [weapon(), weapon({}, { toHit: 8 })], riders: [rider([0, 1], [cold()])] }),
  'two attacks'
)
add(
  'a save between the attacks reads the penalty the first hit set; the second hit has no cold to set another',
  { attacks: [weapon(), weapon()], saves: [save(), save()], riders: [rider([0, 1], [cold()])], grants: [frostbite([0, 1])], order: [0, 2, 1, 3] },
  'saves between'
)
add('a grant over rows the rider does not all watch', frostbiteTurn({ attacks: [weapon(), weapon()], riders: [rider([0], [cold()])] }), 'rider of the first only')
add(
  'a resisted die that rounds to nothing on a hit and not on a crit',
  frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold({ sides: 2, scale: HALF })])] }),
  'resisted'
)
add(
  'a hit whose own damage is cut to nothing, with the rider the only cold',
  frostbiteTurn({ attacks: [weapon({ scale: IMMUNE })], riders: [rider([0], [cold()])] }),
  'own damage immune'
)
add(
  'a rider with a cold part and another part, each scaled on its own',
  frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold({ sides: 2, scale: HALF }), { count: 1, sides: 2, type: 'slashing', scale: HALF }])] }),
  'two parts'
)
add(
  'two riders, one cold and one not, the cold one that may not happen',
  frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold()], { chance: 0.5 }), rider([0], [{ count: 2, sides: 6, type: 'fire' }])] }),
  'two riders'
)
add(
  'a rider that lands on damage dealt, behind a weapon that deals damage on a hit',
  frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold()], { trigger: 'damage' })] }),
  'damage trigger'
)
add(
  'a rider that lands on a cast, hit or miss: the hit it lands on is a cold hit',
  frostbiteTurn({ attacks: [weapon()], riders: [rider([0], [cold()], { trigger: 'cast' })] }),
  'cast trigger'
)
add(
  "a cold weapon: the rider's cold on the same hit changes nothing about which hits are cold",
  frostbiteTurn({ attacks: [weapon({ type: 'cold' })], riders: [rider([0], [cold()])] }),
  'cold weapon'
)
{
  // Row 0 puts the creature unconscious until it is damaged (a hit it lands). Row 1 is a ranged attack, so a hit on the sleeping
  // creature is no crit, and its weapon deals nothing (the enemy is immune to it): only the rider can damage the creature there,
  // and it deals cold or slashing damage or neither, each halved to a 2 in 4 on its own. The save after it is an automatic failure
  // while the creature sleeps and a plain roll once it is awake, with the penalty on it when the rider's cold set it.
  const knockOut = grant({ of: [0], trigger: 'hit', cap: 'once', effects: [{ kind: 'condition', condition: 'unconscious', lifetime: 'until-damaged' }] })
  const wakeAndType = (parts: readonly PartSpec[]): SyntheticTurn => ({
    attacks: [weapon({ type: 'bludgeoning' }), weapon({ scale: IMMUNE }, { range: 'ranged' })],
    saves: [save({ ability: 'dexterity' })],
    riders: [rider([1], parts)],
    grants: [knockOut, frostbite([1])],
    order: [0, 1, 2]
  })
  const test = 'a rider that wakes a creature the first hit put to sleep, and deals the type only sometimes'
  add(test, wakeAndType([cold({ sides: 2, scale: HALF }), { count: 1, sides: 2, type: 'slashing', scale: HALF }]), 'wake and type')
  // The rider's cold is the only damage it can deal: it wakes the creature exactly where it sets the penalty.
  add(test, wakeAndType([cold({ sides: 2, scale: HALF })]), 'cold only')
}
