// The shape factories of yipe/dpr packages/ddb/src/__tests__/oracle/conditionsHarness.ts (commit 52cc91228), verbatim,
// so the ported cases read exactly as the engine's tests do.
import type { AttackSpec, ConditionName, EffectSpec, GrantSpec, RiderSpec, SaveSpec } from '../bruteForce'

/** Shapes the matrix tests build turns from: a melee attack, a Dexterity save, a Sneak Attack rider. */
export const attack = (extra: Partial<AttackSpec> = {}): AttackSpec => ({
  toHit: 6,
  ac: 15,
  critRange: 20,
  advantage: 'flat',
  damage: { count: 1, sides: 8, flat: 3 },
  ...extra
})
export const save = (extra: Partial<SaveSpec> = {}): SaveSpec => ({
  dc: 14,
  saveBonus: 3,
  onSuccess: 'half',
  damage: { count: 3, sides: 6 },
  ability: 'dexterity',
  ...extra
})
export const sneak = (extra: Partial<RiderSpec> = {}): RiderSpec => ({ of: [0, 1, 2], trigger: 'hit', damage: { count: 2, sides: 6 }, ...extra })

export const NEXT_ADVANTAGE: EffectSpec = { kind: 'advantage', lifetime: 'next-attack' }
export const condition = (name: ConditionName): EffectSpec => ({ kind: 'condition', condition: name })
export const CONSTITUTION = { ability: 'constitution', dc: 13, saveBonus: 3 } as const
export const STRENGTH = { ability: 'strength', dc: 13, saveBonus: 2 } as const
export const DEXTERITY = { ability: 'dexterity', dc: 15, saveBonus: 4 } as const

export const grant = (extra: Partial<GrantSpec> = {}): GrantSpec => ({
  of: [0],
  trigger: 'hit',
  cap: 'unlimited',
  effects: [NEXT_ADVANTAGE],
  ...extra
})
