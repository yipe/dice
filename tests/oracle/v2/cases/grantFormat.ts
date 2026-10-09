// Ported from yipe/dpr packages/ddb/src/__tests__/oracle/conditionsGrantFormatVsOracle.test.ts (commit 52cc91228): its shape
// table verbatim, plus the turns its other oracle-free tests evaluate. The seeded sweep is the random family.
import type { AttackSpec, EffectSpec, SyntheticTurn } from '../../bruteForce'
import { CONSTITUTION, DEXTERITY, NEXT_ADVANTAGE, STRENGTH, attack, condition, grant, save, sneak } from '../shapes'
import { oracleCase, type OracleCase } from './types'

const UNCONSCIOUS: EffectSpec = { kind: 'condition', condition: 'unconscious', lifetime: 'until-damaged' }
const LASTING_UNCONSCIOUS = condition('unconscious')
const WISDOM = { ability: 'wisdom', dc: 14, saveBonus: 2 } as const

/** An attack whose damage is a weapon die plus 1d6 of bludgeoning, the enemy optionally resisting, doubling or ignoring it. */
const bludgeoning = (extra: Partial<AttackSpec> & { scale?: { num: number; den: number } } = {}): AttackSpec => {
  const { scale, ...rest } = extra
  return attack({
    damage: { count: 1, sides: 8, flat: 3, parts: [{ count: 1, sides: 6, type: 'bludgeoning', ...(scale ? { scale } : {}) }] },
    ...rest
  })
}
/** A weapon whose only damage is slashing that the enemy is immune to: a hit lands and deals 0. */
const immune = (extra: Partial<AttackSpec> = {}): AttackSpec =>
  attack({ damage: { count: 0, sides: 0, parts: [{ count: 1, sides: 6, type: 'slashing', scale: { num: 0, den: 1 } }] }, ...extra })
/** An attack that can hit and deal nothing: 1d4 - 2 is above 0 only on a 3 or a 4. */
const glancing = (extra: Partial<AttackSpec> = {}): AttackSpec => attack({ damage: { count: 1, sides: 4, flat: -2 }, ...extra })

export const shapes: Array<[string, SyntheticTurn]> = [
  // ---- the miss trigger --------------------------------------------------------------------------------------------------
  [
    'Studied Attacks: every miss gives the next attack advantage',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged', toHit: 8 }), attack({ toHit: 4 })],
      grants: [grant({ of: [0, 1, 2, 3], trigger: 'miss' })]
    }
  ],
  [
    'a miss grant once per turn',
    { attacks: [attack(), attack(), attack(), attack()], grants: [grant({ of: [0, 1, 2], trigger: 'miss', cap: 'once' })] }
  ],
  [
    "Swift: a miss with one weapon gives that weapon's later attacks advantage",
    {
      attacks: [attack(), attack({ toHit: 3 }), attack(), attack()],
      grants: [grant({ of: [0, 2], trigger: 'miss', effects: [{ kind: 'advantage', lifetime: 'next-attack', to: [2, 3] }] })]
    }
  ],
  [
    'a miss that deals damage is still a miss, and an attack that may not happen is none',
    {
      attacks: [
        attack({ missDamage: { kind: 'flat', amount: 3 } }),
        attack({ chance: 0.6 }),
        attack({ missDamage: { kind: 'halfOnMiss' } }),
        attack()
      ],
      grants: [grant({ of: [0, 1, 2], trigger: 'miss' })],
      riders: [sneak({ of: [0, 1, 2, 3] })]
    }
  ],
  [
    'a miss grant beside save rows: a pass is no miss, so only the attacks land it',
    {
      attacks: [attack(), attack()],
      saves: [save({ onSuccess: 'none' }), save({ ability: 'strength', onSuccess: 'half' })],
      order: [0, 2, 1, 3],
      grants: [grant({ of: [0, 1, 2, 3], trigger: 'miss', effects: [NEXT_ADVANTAGE, { kind: 'saveDisadvantage', lifetime: 'next-save' }] })]
    }
  ],
  [
    'a miss with a Prone on a chance, then melee and ranged rows',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged' }), attack()],
      grants: [grant({ of: [0, 1], trigger: 'miss', chance: 0.4, effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] })]
    }
  ],
  // ---- the crit trigger ---------------------------------------------------------------------------------------------------
  [
    'Crusher: a crit that deals bludgeoning damage gives attacks against the creature advantage for the turn',
    {
      attacks: [bludgeoning(), bludgeoning(), bludgeoning({ critRange: 19 }), attack()],
      grants: [grant({ of: [0, 1, 2], trigger: 'crit', dealing: 'bludgeoning', effects: [{ kind: 'advantage', lifetime: 'turn' }] })]
    }
  ],
  [
    'Crusher against resistance, immunity and vulnerability',
    {
      attacks: [
        bludgeoning({ scale: { num: 1, den: 2 }, critRange: 19 }),
        bludgeoning({ scale: { num: 0, den: 1 }, critRange: 19 }),
        bludgeoning({ scale: { num: 2, den: 1 } }),
        attack()
      ],
      grants: [grant({ of: [0, 1, 2], trigger: 'crit', dealing: 'bludgeoning', effects: [{ kind: 'advantage', lifetime: 'turn' }] })]
    }
  ],
  [
    'a crit gives the next attack advantage and a crit of its own; an auto crit row crits every hit',
    {
      attacks: [attack({ critRange: 19 }), attack({ autoCrit: true }), attack(), attack({ range: 'ranged' })],
      grants: [
        grant({ of: [0, 1], trigger: 'crit', effects: [NEXT_ADVANTAGE, { kind: 'critOnHit', lifetime: 'next-attack' }] }),
        grant({ of: [2], trigger: 'crit', cap: 'once', effects: [{ kind: 'disadvantage', lifetime: 'turn', to: [3] }] })
      ]
    }
  ],
  [
    'a save row never crits',
    {
      attacks: [attack(), attack()],
      saves: [save({ ability: 'strength' })],
      order: [2, 0, 1],
      grants: [grant({ of: [0, 1, 2], trigger: 'crit' }), grant({ of: [2], trigger: 'failedSave', effects: [condition('prone')] })]
    }
  ],
  // ---- the kill trigger ---------------------------------------------------------------------------------------------------
  [
    "Killer's Fortune: a kill never happens, beside grants that do",
    {
      attacks: [attack({ target: 1 }), attack(), attack({ target: 1 })],
      grants: [
        grant({ of: [0, 1, 2], trigger: 'kill', effects: [{ kind: 'advantage', lifetime: 'next-attack', against: 'any' }] }),
        grant({ of: [0], chance: 0.5, cap: 'once', effects: [{ kind: 'advantage', lifetime: 'next-attack', against: 'any' }] }),
        grant({ of: [1], trigger: 'kill', cap: 'once', save: CONSTITUTION, effects: [condition('stunned')], onPass: [NEXT_ADVANTAGE] })
      ],
      riders: [sneak()]
    }
  ],
  // ---- Unconscious ---------------------------------------------------------------------------------------------------------
  [
    'Knock Out: Sneak Attack lands, a Constitution save, Unconscious until damaged; melee, ranged and save rows follow',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged' }), attack({ toHit: 5 })],
      saves: [save({ ability: 'strength' }), save({ ability: 'wisdom' }), save({ ability: 'dexterity', onSuccess: 'none' })],
      order: [0, 1, 4, 2, 5, 3, 6],
      riders: [sneak({ of: [0, 1, 2, 3] })],
      grants: [{ of: [0, 1, 2, 3], trigger: 'rider', rider: 0, save: CONSTITUTION, cap: 'once', effects: [UNCONSCIOUS] }]
    }
  ],
  [
    'Unconscious without a lifetime never ends, and leaves no Prone of its own',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged' }), attack({ target: 1 })],
      saves: [save({ ability: 'dexterity' })],
      order: [0, 1, 4, 2, 3],
      grants: [grant({ of: [0], chance: 0.7, effects: [LASTING_UNCONSCIOUS] })]
    }
  ],
  [
    'a hit that deals nothing, a miss that deals its payload and a row that may not happen, against an until-damaged Unconscious',
    {
      attacks: [attack(), glancing(), attack({ missDamage: { kind: 'flat', amount: 2 } }), attack({ chance: 0.5 }), attack({ range: 'ranged' })],
      grants: [grant({ of: [0], chance: 0.8, effects: [UNCONSCIOUS] })]
    }
  ],
  [
    'an until-damaged Unconscious on two creatures: damage to one does not wake the other',
    {
      attacks: [attack(), attack({ target: 1 }), attack({ target: 1 }), attack(), attack({ range: 'ranged', target: 1 })],
      grants: [grant({ of: [0, 1], chance: 0.6, cap: 'unlimited', effects: [UNCONSCIOUS] })]
    }
  ],
  [
    'Knock Out then a Trip Attack whose Strength save is made once the damage has woken the target',
    {
      attacks: [attack(), attack(), glancing(), attack()],
      grants: [
        grant({ of: [0], effects: [UNCONSCIOUS] }),
        { of: [1, 2], trigger: 'hit', save: STRENGTH, cap: 'unlimited', effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] }
      ],
      startingCondition: 'blinded'
    }
  ],
  [
    'an unlimited grant that may knock the target out again while it still is, because no row in between damaged it',
    {
      attacks: [attack(), attack(), attack(), attack({ range: 'ranged' })],
      saves: [save({ ability: 'wisdom' })],
      order: [0, 1, 2, 3, 4],
      // A pass puts a penalty die on the target's save, which a second knock out attempt in force would roll for again.
      grants: [grant({ of: [0, 1, 2], trigger: 'miss', chance: 0.5, effects: [UNCONSCIOUS], onPass: [{ kind: 'savePenalty', count: 1, sides: 6 }] })]
    }
  ],
  [
    'an Unconscious that damage ends beside a Prone that does not, with a save row that Unconscious gives nothing to',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged' })],
      saves: [save({ ability: 'wisdom', onSuccess: 'half' }), save({ ability: 'strength' })],
      order: [0, 3, 1, 4, 2],
      grants: [grant({ of: [0], effects: [UNCONSCIOUS] }), grant({ of: [1], chance: 0.5, cap: 'once', effects: [condition('prone')] })]
    }
  ],
  [
    'Unconscious and a rider that watches the rows it wakes on',
    {
      attacks: [attack(), attack(), attack(), attack({ range: 'ranged' })],
      grants: [grant({ of: [0], trigger: 'hit', save: CONSTITUTION, effects: [UNCONSCIOUS], onPass: [NEXT_ADVANTAGE] })],
      riders: [sneak({ of: [1, 2, 3] }), sneak({ of: [0, 1, 2, 3], trigger: 'damage', damage: { count: 1, sides: 6 } })]
    }
  ],
  // ---- a rider that lands damages its creature too: it wakes an until-damaged Unconscious ---------------------------------
  [
    'Knock Out, then a smite rider on a hit whose weapon damage the enemy cuts to 0, then a melee row',
    {
      attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0 } }), immune(), attack()],
      riders: [{ of: [1], trigger: 'hit', damage: { count: 2, sides: 8 } }],
      grants: [grant({ of: [0], effects: [UNCONSCIOUS] })]
    }
  ],
  [
    'a rider whose own damage the enemy cuts to 0, and one that deals damage on some rolls only, over rows that may wake it',
    {
      attacks: [
        attack({ autoHit: true, damage: { count: 0, sides: 0 } }),
        immune(),
        immune({ range: 'ranged' }),
        attack(),
        attack({ range: 'ranged' })
      ],
      riders: [
        { of: [1], trigger: 'hit', damage: { count: 0, sides: 0, parts: [{ count: 2, sides: 8, type: 'fire', scale: { num: 0, den: 1 } }] } },
        { of: [2, 3], trigger: 'hit', damage: { count: 1, sides: 4, flat: -2, floorAtZero: true } }
      ],
      grants: [grant({ of: [0], chance: 0.8, effects: [UNCONSCIOUS] })]
    }
  ],
  [
    'a cast rider on a miss and on a passed save, with a chance, against an Unconscious that may already be gone',
    {
      attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0 } }), attack(), attack({ chance: 0.7 }), attack(), attack({ range: 'ranged' })],
      saves: [save({ ability: 'wisdom', onSuccess: 'none' })],
      order: [0, 1, 5, 2, 3, 4],
      riders: [
        { of: [1, 5], trigger: 'cast', damage: { count: 1, sides: 2 }, chance: 0.5 },
        { of: [2, 3], trigger: 'cast', damage: { count: 1, sides: 4, flat: -1, floorAtZero: true } }
      ],
      grants: [grant({ of: [0], effects: [UNCONSCIOUS] })]
    }
  ],
  [
    'two riders land on the same row, one of them a damage rider that only lands where the weapon dealt damage',
    {
      attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0 } }), glancing(), attack(), attack({ range: 'ranged' })],
      riders: [
        { of: [1, 2], trigger: 'hit', damage: { count: 1, sides: 2, flat: -1, floorAtZero: true } },
        { of: [1, 2], trigger: 'damage', damage: { count: 1, sides: 6 } }
      ],
      grants: [grant({ of: [0], trigger: 'hit', save: CONSTITUTION, effects: [UNCONSCIOUS], onPass: [NEXT_ADVANTAGE] })]
    }
  ],
  [
    'two riders that each deal damage on some rolls only land on the same ranged row',
    {
      attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0 } }), immune({ range: 'ranged' }), attack(), attack({ range: 'ranged' })],
      riders: [
        { of: [1], trigger: 'hit', damage: { count: 1, sides: 2, flat: -1, floorAtZero: true } },
        { of: [1], trigger: 'hit', damage: { count: 1, sides: 4, flat: -2, floorAtZero: true }, chance: 0.7 }
      ],
      grants: [grant({ of: [0], effects: [UNCONSCIOUS] })]
    }
  ],
  [
    'a Trip Attack save made after a rider has woken the target: it rolls Strength instead of failing it',
    {
      attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0 } }), immune(), attack()],
      riders: [{ of: [1], trigger: 'hit', damage: { count: 2, sides: 6 } }],
      grants: [
        grant({ of: [0], effects: [UNCONSCIOUS] }),
        { of: [1], trigger: 'hit', save: STRENGTH, cap: 'unlimited', effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  // ---- next-attack effects against any creature ----------------------------------------------------------------------------
  [
    "an attacker's next-attack advantage on a hit: the next row at any creature reads it",
    {
      attacks: [attack(), attack({ target: 1 }), attack(), attack({ target: 1 })],
      grants: [grant({ of: [0, 1], effects: [{ kind: 'advantage', lifetime: 'next-attack', against: 'any' }] })]
    }
  ],
  [
    'a once-per-turn grant with an attacker-side effect is tried where only another creature has a row after it',
    {
      attacks: [attack(), attack({ target: 1 }), attack({ target: 1 })],
      grants: [grant({ of: [0, 1], chance: 0.6, cap: 'once', effects: [{ kind: 'advantage', lifetime: 'next-attack', against: 'any' }] })]
    }
  ],
  [
    "attacker-side advantage, disadvantage and crit, for the turn and for the next attack, over two creatures' rows",
    {
      attacks: [attack(), attack({ target: 1 }), attack(), attack({ target: 1 }), attack({ range: 'ranged' })],
      grants: [
        grant({
          of: [0],
          effects: [
            { kind: 'advantage', lifetime: 'turn', against: 'any', to: [2, 3] },
            { kind: 'critOnHit', lifetime: 'next-attack', against: 'any' }
          ]
        }),
        grant({ of: [1, 2], chance: 0.5, effects: [{ kind: 'disadvantage', lifetime: 'next-attack', against: 'any' }], onPass: [NEXT_ADVANTAGE] })
      ]
    }
  ],
  // ---- Elven Accuracy ------------------------------------------------------------------------------------------------------
  [
    'Elven Accuracy: a granted advantage rolls three dice on the flagged rows, two on the others',
    {
      attacks: [
        attack(),
        attack({ elvenAccuracy: true }),
        attack({ elvenAccuracy: true, advantage: 'disadvantage' }),
        attack({ elvenAccuracy: true, advantage: 'advantage' }),
        attack({ elvenAccuracy: true, advantage: 'elven' }),
        attack({ advantage: 'disadvantage' })
      ],
      grants: [grant({ of: [0], effects: [{ kind: 'advantage', lifetime: 'turn' }] })]
    }
  ],
  [
    'Elven Accuracy: advantage from a condition counts, a roll override replaces it, and Prone at range cancels it',
    {
      attacks: [
        attack({ elvenAccuracy: true }),
        attack({ elvenAccuracy: true, rollOverride: 'advantage' }),
        attack({ elvenAccuracy: true, range: 'ranged' }),
        attack({ elvenAccuracy: true, autoHit: true })
      ],
      startingCondition: 'restrained',
      grants: [grant({ of: [0], chance: 0.5, effects: [condition('prone')] })]
    }
  ],
  [
    'Elven Accuracy under an Unconscious that cancels at range',
    {
      attacks: [attack(), attack({ elvenAccuracy: true }), attack({ elvenAccuracy: true, range: 'ranged' }), attack({ elvenAccuracy: true })],
      grants: [grant({ of: [0], effects: [UNCONSCIOUS] })]
    }
  ],
  // ---- the target picks its save ability -----------------------------------------------------------------------------------
  [
    'Grappler: a Strength or Dexterity save, the target picks, Grappled gives later attacks advantage',
    {
      attacks: [attack(), attack(), attack()],
      grants: [
        {
          of: [0, 1],
          trigger: 'hit',
          save: { ...STRENGTH, alternatives: [{ ability: 'dexterity', saveBonus: 5 }] },
          cap: 'once',
          effects: [{ kind: 'advantage', lifetime: 'turn' }]
        }
      ]
    }
  ],
  [
    'a choice of abilities under Restrained and Stunned: the target picks the one the state leaves it',
    {
      attacks: [attack(), attack(), attack(), attack()],
      grants: [
        grant({ of: [0], effects: [condition('restrained')] }),
        {
          of: [1],
          trigger: 'hit',
          save: { ...DEXTERITY, alternatives: [{ ability: 'strength', saveBonus: 1 }] },
          cap: 'unlimited',
          effects: [condition('stunned')]
        },
        {
          of: [2],
          trigger: 'hit',
          save: { ...STRENGTH, alternatives: [{ ability: 'dexterity', saveBonus: 2 }] },
          cap: 'unlimited',
          effects: [NEXT_ADVANTAGE]
        }
      ]
    }
  ],
  [
    'a choice of abilities where only one is failed automatically',
    {
      attacks: [attack(), attack(), attack()],
      startingCondition: 'stunned',
      grants: [
        {
          of: [0, 1],
          trigger: 'hit',
          save: { ...STRENGTH, alternatives: [{ ability: 'constitution', saveBonus: 3 }] },
          cap: 'unlimited',
          effects: [condition('prone')],
          onPass: [NEXT_ADVANTAGE]
        }
      ]
    }
  ],
  // ---- save effects scoped to rows ------------------------------------------------------------------------------------------
  [
    'Focused Strike merged into Stunning Strike: a save disadvantage on the spell saves whether the target passes or fails',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save({ ability: 'wisdom' }), save({ ability: 'dexterity' }), save({ ability: 'wisdom' })],
      order: [0, 3, 1, 4, 2, 5],
      grants: [
        {
          of: [0, 1, 2],
          trigger: 'hit',
          save: CONSTITUTION,
          cap: 'once',
          effects: [condition('stunned'), { kind: 'saveDisadvantage', to: [3, 5] }],
          onPass: [NEXT_ADVANTAGE, { kind: 'saveDisadvantage', to: [3, 5] }]
        }
      ]
    }
  ],
  [
    'a scoped save penalty that lasts until the next save that reads it, and a grant save that it does not reach',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save({ ability: 'wisdom' }), save({ ability: 'wisdom' }), save({ ability: 'wisdom' })],
      order: [0, 3, 1, 4, 2, 5],
      grants: [
        grant({
          of: [0],
          effects: [
            { kind: 'savePenalty', count: 1, sides: 6, lifetime: 'next-save', to: [4] },
            { kind: 'saveDisadvantage', to: [5] }
          ]
        }),
        { of: [1], trigger: 'hit', save: WISDOM, cap: 'unlimited', effects: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  [
    'a save row that a scoped save disadvantage reaches also triggers a grant, whose own save it does not reach',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save({ ability: 'wisdom' })],
      order: [0, 3, 1, 2],
      grants: [
        grant({ of: [0], effects: [{ kind: 'saveDisadvantage', to: [3] }] }),
        { of: [3], trigger: 'failedSave', save: WISDOM, cap: 'unlimited', effects: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  [
    'Terrify: Sneak Attack lands, a Wisdom save, advantage on the attacker own later rows and not the companion rows',
    {
      // Rows 2 and 4 are a companion's: Terrify's advantage is "you have Advantage", so it is scoped to the attacker's rows.
      attacks: [attack(), attack(), attack({ toHit: 4 }), attack(), attack({ toHit: 4 })],
      riders: [sneak({ of: [0, 1, 3] })],
      grants: [
        {
          of: [0, 1, 3],
          trigger: 'rider',
          rider: 0,
          save: WISDOM,
          cap: 'once',
          effects: [{ kind: 'advantage', lifetime: 'turn', to: [1, 3] }]
        }
      ]
    }
  ],
  // ---- grants coupled to a rider ------------------------------------------------------------------------------------------
  [
    'Cunning Strike Trip: a Dexterity save on the row where Sneak Attack lands, Prone, melee and ranged rows after',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged' }), attack()],
      riders: [sneak({ of: [0, 1, 2, 3] })],
      grants: [{ of: [0, 1, 2, 3], trigger: 'rider', rider: 0, save: DEXTERITY, cap: 'once', effects: [condition('prone')] }]
    }
  ],
  [
    'Cunning Strike Obscure and Trip on the same Sneak Attack, and a Vex grant from a row it does not watch',
    {
      attacks: [attack(), attack(), attack(), attack({ range: 'ranged' })],
      riders: [sneak({ of: [1, 2, 3] })],
      grants: [
        grant({ of: [0], trigger: 'damage', effects: [NEXT_ADVANTAGE] }),
        { of: [1, 2, 3], trigger: 'rider', rider: 0, save: DEXTERITY, cap: 'once', effects: [condition('blinded')] },
        { of: [1, 2, 3], trigger: 'rider', rider: 0, save: { ...DEXTERITY, dc: 12 }, cap: 'unlimited', effects: [condition('prone')] }
      ]
    }
  ],
  [
    'Rend Mind: Sneak Attack must land on a blade row, which a Wisdom save then stuns',
    {
      attacks: [attack(), attack(), attack(), attack(), attack()],
      riders: [sneak({ of: [0, 1, 2, 3, 4] })],
      grants: [{ of: [1, 2, 3], trigger: 'rider', rider: 0, save: WISDOM, cap: 'once', effects: [condition('stunned')] }]
    }
  ],
  [
    'a coupled grant fires on a creature where no row follows, not on a later row the rider did not land on',
    {
      attacks: [attack(), attack({ target: 1 }), attack({ target: 1 }), attack({ target: 1, range: 'ranged' })],
      riders: [sneak({ of: [0, 1, 2, 3] })],
      grants: [{ of: [0, 1, 2, 3], trigger: 'rider', rider: 0, cap: 'once', save: DEXTERITY, effects: [condition('prone')] }]
    }
  ],
  [
    "a smite: a rider that lands on a hit, a Wisdom save, Stunned until the end of the turn, and a second rider that shares the first's rows",
    {
      attacks: [attack(), attack(), attack(), attack()],
      riders: [sneak({ of: [0, 1, 2, 3] }), sneak({ of: [0, 1, 2, 3], damage: { count: 2, sides: 8 } })],
      grants: [
        { of: [0, 1, 2, 3], trigger: 'rider', rider: 0, save: WISDOM, cap: 'unlimited', effects: [condition('stunned')] },
        { of: [0, 1, 2, 3], trigger: 'rider', rider: 1, cap: 'once', effects: [{ kind: 'advantage', lifetime: 'next-attack' }] }
      ]
    }
  ],
  [
    'Arcane Shot: a rider that lands on damage, coupled grant with both branches, and a rider with a cast trigger that nothing is coupled to',
    {
      attacks: [attack(), attack({ chance: 0.7 }), attack(), attack()],
      saves: [save({ ability: 'strength' })],
      order: [0, 1, 4, 2, 3],
      riders: [sneak({ of: [0, 1, 2, 3, 4], trigger: 'damage' }), sneak({ of: [0, 1], trigger: 'cast', damage: { count: 1, sides: 4 } })],
      grants: [
        { of: [0, 1, 2, 3, 4], trigger: 'rider', rider: 0, save: STRENGTH, cap: 'once', effects: [condition('restrained')], onPass: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  [
    'a coupled grant to a cast rider fires on the first row that happens',
    {
      attacks: [attack({ chance: 0.5 }), attack({ chance: 0.5 }), attack(), attack()],
      riders: [sneak({ of: [0, 1, 2], trigger: 'cast' })],
      grants: [{ of: [0, 1, 2], trigger: 'rider', rider: 0, cap: 'once', chance: 0.5, effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] }]
    }
  ],
  [
    'coupled grants with riders, starting condition, a Knock Out and saves together',
    {
      attacks: [attack(), attack(), attack({ range: 'ranged' }), attack({ target: 1 }), attack({ toHit: 5 })],
      saves: [save({ ability: 'strength' })],
      order: [0, 1, 5, 3, 2, 4],
      startingCondition: 'restrained',
      riders: [sneak({ of: [0, 1, 2, 4] }), sneak({ of: [3, 4], trigger: 'damage' })],
      grants: [
        { of: [0, 1, 2], trigger: 'rider', rider: 0, save: CONSTITUTION, cap: 'once', effects: [UNCONSCIOUS] },
        { of: [4], trigger: 'rider', rider: 1, cap: 'unlimited', effects: [condition('stunned')] },
        grant({ of: [1], trigger: 'miss', chance: 0.5, effects: [{ kind: 'advantage', lifetime: 'next-attack', against: 'any' }] })
      ]
    }
  ]
]

// "What the calculation gives alone": the turns those tests evaluate, as cases.
{
  const base: SyntheticTurn = { attacks: [attack(), attack(), attack({ range: 'ranged' })], grants: [grant({ of: [0], chance: 0.6 })], riders: [sneak()] }
  const kill = grant({ of: [0, 1], trigger: 'kill', effects: [{ kind: 'advantage', lifetime: 'turn', against: 'any' }, condition('stunned')] })
  shapes.push(['a kill-triggered grant changes nothing / without', base], ['a kill-triggered grant changes nothing / with', { ...base, grants: [...base.grants!, kill] }])
  const wakes: SyntheticTurn = {
    attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0 } }), immune({ toHit: 0, ac: 11 }), attack({ toHit: 0, ac: 11 })],
    riders: [{ of: [1], trigger: 'hit', damage: { count: 2, sides: 8 } }],
    grants: [grant({ of: [0], effects: [UNCONSCIOUS] })]
  }
  shapes.push(['a rider that lands on a row wakes the target / with', wakes], ['a rider that lands on a row wakes the target / without', { ...wakes, riders: [] }])
  shapes.push([
    'an until-damaged Unconscious is gone from the next row once a row that dealt damage has read it',
    {
      attacks: [attack({ autoHit: true, damage: { count: 0, sides: 0, flat: 0 } }), attack({ toHit: 0, ac: 11 }), attack({ toHit: 0, ac: 11 })],
      grants: [grant({ of: [0], effects: [UNCONSCIOUS] })]
    }
  ])
}

export const cases: OracleCase[] = shapes.map(([name, turn]) => oracleCase(name, turn))
