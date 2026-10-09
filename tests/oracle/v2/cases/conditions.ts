// Ported from yipe/dpr packages/ddb/src/__tests__/oracle/conditionsVsOracle.test.ts (commit 52cc91228): its shape
// table verbatim, plus the turns its other oracle-free tests evaluate. The seeded sweep is the random family.
import type { AttackSpec, GrantSpec, SyntheticTurn } from '../../bruteForce'
import { CONSTITUTION, DEXTERITY, NEXT_ADVANTAGE, STRENGTH, attack, condition, grant, save, sneak } from '../shapes'
import { oracleCase, type OracleCase } from './types'

/** An attack whose damage is a weapon die plus 1d6 of cold, the cold optionally scaled by the enemy. */
const cold = (extra: Partial<AttackSpec> & { scale?: { num: number; den: number } } = {}): AttackSpec => {
  const { scale, ...rest } = extra
  return attack({ damage: { count: 1, sides: 8, flat: 3, parts: [{ count: 1, sides: 6, type: 'cold', ...(scale ? { scale } : {}) }] }, ...rest })
}
/** An attack whose only damage is 1d8 of cold (so a hit can deal nothing once the enemy halves it), the cold optionally scaled. */
const coldOnly = (extra: Partial<AttackSpec> & { scale?: { num: number; den: number } } = {}): AttackSpec => {
  const { scale, ...rest } = extra
  return attack({ damage: { count: 0, sides: 0, parts: [{ count: 1, sides: 8, type: 'cold', ...(scale ? { scale } : {}) }] }, ...rest })
}
/** Cold Caster's Frostbite over the given attacks: once a turn, a hit that deals cold damage puts 1d4 on the target's next save. */
const FROSTBITE = (...of: number[]): GrantSpec => ({
  of,
  trigger: 'hit',
  dealing: 'cold',
  cap: 'once',
  effects: [{ kind: 'savePenalty', count: 1, sides: 4, lifetime: 'next-save' }]
})

/** Four attacks (melee, melee, ranged, melee) then a Strength, a Dexterity and a Constitution save. */
const MIXED_ROWS = {
  attacks: [attack(), attack(), attack({ range: 'ranged', toHit: 8 }), attack({ toHit: 4 })],
  saves: [save({ ability: 'strength' }), save({ ability: 'dexterity' }), save({ ability: 'constitution' })]
} as const

export const shapes: Array<[string, SyntheticTurn]> = [
  // The grants of the table.
  [
    'Vex: a hit that deals damage gives the next attack advantage',
    { attacks: [attack(), attack(), attack()], grants: [grant({ trigger: 'damage', of: [0, 1] })] }
  ],
  [
    'Vex on a hit that may deal nothing (hit and damage triggers differ)',
    { attacks: [attack({ damage: { count: 1, sides: 4, flat: -2 } }), attack(), attack()], grants: [grant({ trigger: 'damage', of: [0, 1] })] }
  ],
  [
    'Topple: a hit, a Constitution save, Prone, until it lands; melee and ranged rows',
    {
      ...MIXED_ROWS,
      grants: [{ of: [0, 1, 3], trigger: 'hit', save: CONSTITUTION, cap: 'unlimited', effects: [condition('prone')] }]
    }
  ],
  [
    '2024 Stunning Strike: once per turn, Stunned on a failed save, next-attack advantage on a passed one',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save({ ability: 'dexterity' }), save({ ability: 'constitution' })],
      order: [0, 1, 3, 2, 4],
      grants: [{ of: [0, 1, 2], trigger: 'hit', save: CONSTITUTION, cap: 'once', effects: [condition('stunned')], onPass: [NEXT_ADVANTAGE] }]
    }
  ],
  [
    '2014 Stunning Strike: any hit, until it lands, Stunned',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save({ ability: 'strength' }), save({ ability: 'dexterity' }), save({ ability: 'wisdom' })],
      order: [0, 3, 1, 4, 2, 5],
      grants: [{ of: [0, 1, 2], trigger: 'hit', save: CONSTITUTION, cap: 'unlimited', effects: [condition('stunned')] }]
    }
  ],
  [
    'Trip Attack: a Strength save, Prone',
    { ...MIXED_ROWS, grants: [{ of: [0, 3], trigger: 'hit', save: STRENGTH, cap: 'unlimited', effects: [condition('prone')] }] }
  ],
  // Both caps and both lifetimes, with a fixed chance so the branches are easy to read.
  ...(['unlimited', 'once'] as const).flatMap((cap) =>
    (['turn', 'next-attack'] as const).map((lifetime): [string, SyntheticTurn] => [
      `${cap} cap, ${lifetime} lifetime, advantage on a chance, disadvantage on the other branch`,
      {
        attacks: [attack(), attack(), attack(), attack()],
        grants: [
          {
            of: [0, 1, 2],
            trigger: 'hit',
            chance: 0.4,
            cap,
            effects: [{ kind: 'advantage', lifetime }],
            onPass: [{ kind: 'disadvantage', lifetime }]
          }
        ]
      }
    ])
  ),
  [
    'a lasting effect that cancels a base advantage, and one scoped to two rows',
    {
      attacks: [attack(), attack({ advantage: 'advantage' }), attack({ advantage: 'elven' }), attack({ advantage: 'disadvantage' })],
      grants: [
        grant({ of: [0], effects: [{ kind: 'disadvantage', lifetime: 'turn', to: [1, 2] }] }),
        grant({
          of: [0, 1],
          chance: 0.5,
          effects: [
            { kind: 'advantage', lifetime: 'next-attack', to: [2, 3] },
            { kind: 'critOnHit', lifetime: 'turn', to: [3] }
          ]
        })
      ]
    }
  ],
  // Conditions a grant inflicts, on attack rows of both ranges and on saves of each ability.
  ...(['blinded', 'paralyzed', 'prone', 'restrained', 'stunned'] as const).map((name): [string, SyntheticTurn] => [
    `a grant inflicts ${name} on a chance`,
    { ...MIXED_ROWS, grants: [grant({ of: [0], chance: 0.55, cap: 'unlimited', effects: [condition(name)] })] }
  ]),
  // The target starts the turn with one.
  ...(['blinded', 'paralyzed', 'prone', 'restrained', 'stunned'] as const).map((name): [string, SyntheticTurn] => [
    `the target starts ${name}`,
    { ...MIXED_ROWS, startingCondition: name, riders: [sneak()] }
  ]),
  [
    'a starting condition with grants adding to it, riders and a second creature that has no starting condition',
    {
      attacks: [attack(), attack({ target: 1 }), attack({ range: 'ranged' }), attack({ target: 1, range: 'ranged' })],
      saves: [save({ ability: 'dexterity', target: 1 })],
      order: [0, 1, 4, 2, 3],
      startingCondition: 'restrained',
      grants: [grant({ of: [0, 1], chance: 0.3, effects: [condition('prone')] })],
      riders: [sneak({ of: [0, 1, 2, 3] })]
    }
  ],
  // Save-side effects that are not conditions.
  [
    'Fairy Trickster: the target rolls its saves at disadvantage',
    {
      attacks: [attack(), attack()],
      saves: [save(), save({ ability: 'wisdom', dc: 16 })],
      order: [0, 2, 1, 3],
      grants: [grant({ of: [0], effects: [{ kind: 'saveDisadvantage' }] })]
    }
  ],
  [
    'a save penalty die from a hit, on the row saves and on a grant save that follows',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save({ dc: 15 })],
      order: [0, 3, 1, 2],
      grants: [
        grant({ of: [0], effects: [{ kind: 'savePenalty', count: 1, sides: 6 }] }),
        { of: [1], trigger: 'hit', save: { ability: 'wisdom', dc: 14, saveBonus: 2 }, cap: 'unlimited', effects: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  [
    'two penalty dice and disadvantage at once',
    {
      attacks: [attack(), attack()],
      saves: [save({ dc: 17, rollType: 'advantage' })],
      order: [0, 1, 2],
      grants: [
        grant({ of: [0], effects: [{ kind: 'savePenalty', count: 1, sides: 4 }, { kind: 'saveDisadvantage' }] }),
        grant({ of: [1], chance: 0.5, effects: [{ kind: 'savePenalty', count: 2, sides: 6 }] })
      ]
    }
  ],
  [
    'a grant save under a condition it inflicted earlier: Restrained gives a Dexterity save disadvantage, Stunned fails it',
    {
      attacks: [attack(), attack(), attack()],
      grants: [
        grant({ of: [0], effects: [condition('restrained')] }),
        { of: [1], trigger: 'hit', save: DEXTERITY, cap: 'unlimited', effects: [condition('prone')] },
        { of: [1, 2], trigger: 'damage', save: { ...STRENGTH, dc: 12 }, cap: 'once', effects: [NEXT_ADVANTAGE], onPass: [condition('blinded')] }
      ]
    }
  ],
  [
    'a grant save under a starting Stunned (Strength and Dexterity fail, Constitution rolls)',
    {
      attacks: [attack(), attack(), attack(), attack()],
      startingCondition: 'stunned',
      grants: [
        { of: [0], trigger: 'hit', save: STRENGTH, cap: 'unlimited', effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] },
        { of: [1], trigger: 'hit', save: CONSTITUTION, cap: 'unlimited', effects: [condition('paralyzed')], onPass: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  [
    'an effect read early that can also be set late shares its place with a later grant',
    {
      // Grant 1's flag is read by rows 0 and 1 only but can be set at rows 0, 2 and 3, where grant 0's flag has taken over its place.
      attacks: [attack(), attack(), attack(), attack()],
      grants: [
        { of: [2, 3], trigger: 'hit', chance: 0.84, cap: 'unlimited', effects: [{ kind: 'disadvantage', lifetime: 'next-attack' }] },
        { of: [0, 2, 3], trigger: 'hit', cap: 'unlimited', effects: [{ kind: 'disadvantage', lifetime: 'turn', to: [0, 1] }] }
      ]
    }
  ],
  // Cold Caster's Frostbite: a hit that deals cold damage, once per turn, penalises the next save.
  [
    'Frostbite: the first cold hit puts a die on the next save row only',
    {
      attacks: [cold(), cold(), cold()],
      saves: [save({ dc: 15 }), save({ ability: 'wisdom', dc: 15 })],
      order: [0, 1, 3, 2, 4],
      grants: [FROSTBITE(0, 1, 2)]
    }
  ],
  [
    'Frostbite against resistance, immunity and a crit range of 19',
    {
      attacks: [
        cold({ scale: { num: 1, den: 2 }, critRange: 19 }),
        cold({ scale: { num: 0, den: 1 } }),
        cold({ scale: { num: 2, den: 1 }, critRange: 19 })
      ],
      saves: [save({ dc: 14 }), save({ dc: 14 })],
      order: [0, 3, 1, 2, 4],
      grants: [FROSTBITE(0, 1, 2)]
    }
  ],
  [
    'Frostbite keeps its use for a second creature when no save follows the first hit',
    {
      attacks: [cold(), cold({ target: 1 }), cold({ target: 1 })],
      saves: [save({ target: 1 })],
      order: [0, 1, 3, 2],
      grants: [FROSTBITE(0, 1, 2)]
    }
  ],
  [
    'Frostbite beside Stunning Strike, whose own save reads only what lasts the turn',
    {
      attacks: [cold(), cold(), cold()],
      saves: [save({ ability: 'strength', dc: 15 })],
      order: [0, 1, 3, 2],
      grants: [
        FROSTBITE(0, 1, 2),
        {
          of: [0, 1, 2],
          trigger: 'hit',
          save: CONSTITUTION,
          cap: 'unlimited',
          effects: [condition('stunned')],
          onPass: [{ kind: 'savePenalty', count: 1, sides: 6 }]
        }
      ]
    }
  ],
  [
    'a next-save disadvantage is used up by the first save row that happens',
    {
      attacks: [attack(), attack()],
      saves: [save({ chance: 0.5 }), save({ ability: 'dexterity' }), save({ ability: 'wisdom', dc: 16 })],
      order: [0, 2, 3, 1, 4],
      grants: [grant({ of: [0, 1], chance: 0.6, effects: [{ kind: 'saveDisadvantage', lifetime: 'next-save' }] })]
    }
  ],
  [
    'a once-per-turn grant is not spent where no row after it would get anything',
    {
      attacks: [attack(), attack({ target: 1 }), attack({ target: 1 })],
      saves: [save({ ability: 'constitution' })],
      order: [0, 3, 1, 2],
      grants: [{ of: [0, 1], trigger: 'hit', save: CONSTITUTION, cap: 'once', effects: [condition('blinded')], onPass: [NEXT_ADVANTAGE] }]
    }
  ],
  [
    'a cold hit that can deal 0 (resistance halves a 1 to 0) triggers a damage grant only when cold was dealt',
    {
      attacks: [coldOnly({ scale: { num: 1, den: 2 } }), attack(), attack()],
      grants: [{ of: [0], trigger: 'damage', dealing: 'cold', cap: 'unlimited', effects: [NEXT_ADVANTAGE] }]
    }
  ],
  [
    'Frostbite on a damage trigger beside a damage rider, on rows whose cold can round to 0',
    {
      attacks: [coldOnly({ scale: { num: 1, den: 2 } }), coldOnly({ scale: { num: 1, den: 2 } }), attack()],
      saves: [save({ dc: 14 })],
      order: [0, 3, 1, 2],
      grants: [{ ...FROSTBITE(0, 1), trigger: 'damage' }],
      riders: [sneak({ of: [0, 1, 2], trigger: 'damage' })]
    }
  ],
  [
    'a crit that deals 0 in total deals no cold either',
    {
      attacks: [coldOnly({ scale: { num: 0, den: 1 }, critRange: 19 }), attack(), attack()],
      grants: [{ of: [0], trigger: 'hit', dealing: 'cold', cap: 'once', effects: [NEXT_ADVANTAGE] }],
      riders: [sneak({ of: [0, 1, 2], trigger: 'damage' })]
    }
  ],
  // Overrides change the row's own roll and never the state.
  [
    'overrides: a roll override replaces the state advantage, crit on hit still applies',
    {
      attacks: [
        attack(),
        attack({ rollOverride: 'flat' }),
        attack({ rollOverride: 'disadvantage' }),
        attack({ advantage: 'advantage', rollOverride: 'flat' })
      ],
      saves: [save({ ability: 'dexterity', rollOverride: 'advantage' })],
      startingCondition: 'paralyzed',
      grants: [grant({ of: [0], chance: 0.5, effects: [{ kind: 'saveDisadvantage' }, NEXT_ADVANTAGE] })]
    }
  ],
  [
    'overrides: auto hit, auto crit, both, and auto fail',
    {
      attacks: [
        attack(),
        attack({ autoHit: true }),
        attack({ autoCrit: true }),
        attack({ autoHit: true, autoCrit: true }),
        attack({ autoHit: true, critRange: 19 })
      ],
      saves: [save({ ability: 'wisdom', autoFail: true }), save({ ability: 'dexterity', autoFail: true })],
      startingCondition: 'prone',
      grants: [grant({ of: [0, 1, 2, 3], effects: [{ kind: 'critOnHit', lifetime: 'turn', to: [4] }, NEXT_ADVANTAGE] })]
    }
  ],
  [
    'an auto fail save does not change the state a grant reads',
    {
      attacks: [attack(), attack()],
      saves: [save({ autoFail: true })],
      order: [0, 2, 1],
      grants: [{ of: [0], trigger: 'hit', save: CONSTITUTION, cap: 'unlimited', effects: [condition('stunned')] }]
    }
  ],
  // Riders, correlated with grants from rows they do not watch.
  [
    'a rider watches two rows while a grant fires from a row it does not',
    {
      attacks: [attack(), attack(), attack()],
      grants: [grant({ of: [0], trigger: 'damage' })],
      riders: [sneak({ of: [1, 2] })]
    }
  ],
  [
    'Stunning Strike on the first attacks and Sneak Attack on later ones, several rider groups',
    {
      attacks: [attack(), attack(), attack(), attack(), attack()],
      grants: [{ of: [0, 1], trigger: 'hit', save: CONSTITUTION, cap: 'once', effects: [condition('stunned')], onPass: [NEXT_ADVANTAGE] }],
      riders: [
        sneak({ of: [2, 3, 4] }),
        sneak({ of: [1, 3], damage: { count: 1, sides: 8, flat: 2 } }),
        sneak({ of: [0, 1, 2, 3, 4], trigger: 'damage' })
      ]
    }
  ],
  [
    'riders with each trigger, a chance, and a save row among the rows watched',
    {
      attacks: [attack(), attack(), attack()],
      saves: [save()],
      order: [0, 3, 1, 2],
      grants: [grant({ of: [0, 1], chance: 0.6, cap: 'once', effects: [condition('restrained')], onPass: [NEXT_ADVANTAGE] })],
      riders: [
        sneak({ of: [0, 1, 2, 3], trigger: 'damage' }),
        sneak({ of: [0, 1, 2, 3], trigger: 'cast', damage: { count: 1, sides: 4 }, chance: 0.5 }),
        sneak({ of: [1, 2], trigger: 'hit', damage: { count: 0, sides: 0, flat: 5 } })
      ]
    }
  ],
  // Triggers from a save row.
  [
    'a failed save grants Prone, a passed save grants advantage',
    {
      attacks: [attack(), attack()],
      saves: [save({ ability: 'strength' }), save({ ability: 'dexterity' })],
      order: [2, 3, 0, 1],
      grants: [
        { of: [2], trigger: 'failedSave', cap: 'unlimited', effects: [condition('prone')] },
        { of: [2, 3], trigger: 'passedSave', cap: 'once', effects: [NEXT_ADVANTAGE] },
        { of: [3], trigger: 'damage', cap: 'unlimited', effects: [{ kind: 'saveDisadvantage' }] }
      ]
    }
  ],
  [
    'a save that deals nothing on a pass is a pass for a passed-save grant',
    {
      attacks: [attack()],
      saves: [save({ onSuccess: 'none' }), save({ ability: 'strength' })],
      order: [1, 2, 0],
      grants: [{ of: [1], trigger: 'passedSave', cap: 'unlimited', effects: [NEXT_ADVANTAGE] }]
    }
  ],
  // Rows that may not happen.
  [
    'a row that does not happen consumes nothing, lands nothing and is no trigger',
    {
      attacks: [attack(), attack({ chance: 0.5 }), attack({ chance: 0.7 }), attack()],
      saves: [save({ chance: 0.6 })],
      order: [0, 4, 1, 2, 3],
      grants: [grant({ of: [0, 1, 2] }), grant({ of: [4], trigger: 'failedSave', cap: 'once', effects: [condition('stunned')] })],
      riders: [sneak({ of: [0, 1, 2, 3] })]
    }
  ],
  // Retries that must not repeat.
  [
    'an unlimited grant with a pass effect is not tried again once its lasting effect is in force',
    {
      attacks: [attack(), attack(), attack(), attack()],
      grants: [{ of: [0, 1, 2], trigger: 'hit', chance: 0.4, cap: 'unlimited', effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] }]
    }
  ],
  [
    'the same effect from two grants keeps them apart for the skip and for the odds',
    {
      attacks: [attack(), attack(), attack(), attack()],
      grants: [
        { of: [0, 1], trigger: 'hit', chance: 0.5, cap: 'unlimited', effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] },
        { of: [0, 1], trigger: 'hit', chance: 0.5, cap: 'unlimited', effects: [condition('prone')], onPass: [NEXT_ADVANTAGE] }
      ]
    }
  ],
  // Another creature has its own state.
  [
    'a grant against the primary target does not reach a second creature',
    {
      attacks: [attack(), attack({ target: 1 }), attack(), attack({ target: 1 })],
      startingCondition: 'blinded',
      grants: [grant({ of: [0], chance: 0.5, cap: 'unlimited', effects: [condition('prone')] }), grant({ of: [1], effects: [NEXT_ADVANTAGE] })]
    }
  ],
  [
    'one grant whose rows are aimed at two creatures puts its effect on each row creature',
    {
      attacks: [attack(), attack({ target: 1 }), attack(), attack({ target: 1 })],
      grants: [grant({ of: [0, 1], chance: 0.5, cap: 'unlimited', effects: [condition('paralyzed')] })]
    }
  ],
  [
    'many attacks and grants together',
    {
      attacks: Array.from({ length: 6 }, (_, i) => attack({ range: i % 3 === 2 ? 'ranged' : 'melee', toHit: 4 + i })),
      saves: [save({ ability: 'dexterity' })],
      order: [0, 1, 6, 2, 3, 4, 5],
      grants: [
        { of: [0, 1], trigger: 'hit', save: CONSTITUTION, cap: 'unlimited', effects: [condition('prone')] },
        grant({ of: [2, 3], trigger: 'damage' }),
        {
          of: [0, 1, 2, 3, 4, 5],
          trigger: 'hit',
          save: { ...CONSTITUTION, dc: 16 },
          cap: 'once',
          effects: [condition('stunned')],
          onPass: [NEXT_ADVANTAGE]
        }
      ],
      riders: [sneak({ of: [0, 1, 2, 3, 4, 5] })]
    }
  ]
]

export const cases: OracleCase[] = shapes.map(([name, turn]) => oracleCase(name, turn))
