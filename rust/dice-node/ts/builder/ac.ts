import type { RollType } from "../../../../src/builder/types";

export { ACBuilder } from "./roll";
export type { AcAttackConfig as AttackConfig } from "./roll";

/**
 * Combines a source's own roll type with granted advantage/disadvantage flags by cancellation.
 * Pure; verbatim from `src/builder/ac.ts` (the Rust `combine` has no napi entry: it is a plain
 * function over three small values).
 */
export function combine(
  rollType: RollType,
  advantageDice: 2 | 3,
  flags: { advantage: boolean; disadvantage: boolean }
): { rollType: RollType; dice: number } {
  const ownAdvantage = rollType === "advantage" || rollType === "elven accuracy";
  const ownDisadvantage = rollType === "disadvantage";
  const netAdvantage = ownAdvantage || flags.advantage;
  const netDisadvantage = ownDisadvantage || flags.disadvantage;

  if (netAdvantage && netDisadvantage) return { rollType: "flat", dice: 1 };
  if (netAdvantage) return { rollType: "advantage", dice: rollType === "elven accuracy" ? 3 : advantageDice };
  if (netDisadvantage) return { rollType: "disadvantage", dice: 2 };
  return { rollType: "flat", dice: 1 };
}
