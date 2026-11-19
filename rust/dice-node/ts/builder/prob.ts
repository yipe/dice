import { native, type NativePmfHandle } from "../native";
import { PMF } from "../pmf/pmf";
import { EPS } from "../../../../src/common/types";

/**
 * Facade over `rust/dice-node/src/ast.rs` (`prob*`). `cdfPow` is called back synchronously, once
 * per face 1..20; an error it throws is rethrown after the Rust call finishes.
 */

export function d20PmfFromCdf(cdfPow: (k: number) => number, eps: number = EPS): PMF {
  return PMF._wrap(native.probD20PmfFromCdf((k: number) => cdfPow(k), eps) as NativePmfHandle);
}

/**
 * `P(X >= t)` and `P(X < t)` for `pmf`, each summed from its own bins - so a side with no bins is
 * exactly 0, never the `1 - p` float residue of the other. Used to split a check's bonus dice at
 * the total its natural roll still needs.
 */
export function splitAtThreshold(pmf: PMF, t: number): { atLeast: number; below: number } {
  return native.probSplitAtThreshold(pmf._handle, t) as { atLeast: number; below: number };
}
