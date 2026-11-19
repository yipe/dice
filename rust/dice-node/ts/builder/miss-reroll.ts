import { native } from "../native";
import type { MissRerollMode } from "../../../../src/builder/types";
import type { ACBuilder } from "./ac";
import type { AlwaysCritBuilder } from "./roll";

/**
 * Facade over `rust/dice-node/src/ast.rs` (`missReroll*`): `rerollMisses`, a missed attack roll
 * rolled again. The check is read from its native handle.
 */

export interface MissRerollOdds {
  /** P(the attack misses as rolled AND misses after the reroll). */
  miss: number;
  /** P(misses as rolled AND the reroll lands as a plain hit). */
  hit: number;
  /** P(misses as rolled AND the reroll crits). */
  crit: number;
  /** P(misses as rolled AND the reroll's kept natural roll is a 20): part of `crit`. */
  natural20: number;
}

type RerollCheck = ACBuilder | AlwaysCritBuilder;

/** The check's `rerollMisses` mode, if it has one (an always-hit check never has). */
export function missRerollOf(check: { attackConfig: object }): MissRerollMode | undefined {
  const { attackConfig } = check;
  return "missReroll" in attackConfig ? (attackConfig.missReroll as MissRerollMode | undefined) : undefined;
}

/**
 * The odds of a miss, and of what its reroll lands as. `check` is the check as rolled (its roll
 * type decides how many d20s it rolled); `mode` is how the miss is rolled again.
 */
export function missRerollOdds(check: RerollCheck, mode: MissRerollMode, eps: number = 0): MissRerollOdds {
  return native.missRerollOddsOf(check._handle, mode, eps) as MissRerollOdds;
}

/** The check inside `( … AC n)` for a check with `missReroll` set. */
export function missRerollCheckExpression(check: RerollCheck): string {
  return native.missRerollExpressionOf(check._handle) as string;
}
