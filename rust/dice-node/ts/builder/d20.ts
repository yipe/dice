import { native, type NativePmfHandle } from "../native";
import { PMF } from "../pmf/pmf";
import type { RollType } from "../../../../src/builder/types";

/** Facade over `rust/dice-node/src/ast.rs` (`d20*`). The Rust crate recomputes: 20 bins. */

/** Lift a single d20 PMF into advantage, disadvantage, or elven (triple-advantage). */
export function d20RollPMF(rollType: RollType | undefined, rerollOne: boolean = false): PMF {
  return PMF._wrapShared(native.d20RollPmfOf(rollType, rerollOne) as NativePmfHandle);
}

export function d20PMF(rerollOne: boolean): PMF {
  return PMF._wrapShared(native.d20PmfOf(rerollOne) as NativePmfHandle);
}
