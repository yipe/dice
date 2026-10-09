/**
 * The row context a turn state puts a row in: which modifiers the flags a row reads
 * put in force, and how they combine with the row's own facts ({@link RowCheck}) into the
 * {@link RowContext} a {@link ContextualSource} rolls under. The combining rule is the engine's
 * (`turn-calc/src/engine/conditionTable.ts` `rowContext` / `combineRollType`).
 */
import type { RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import type { ContextualSource, RowCheck, RowContext } from "./types";

/** A read flag's modifiers, as a key: which roll context a set of flags selects. */
export const MOD_ADVANTAGE = 1;
export const MOD_DISADVANTAGE = 2;
export const MOD_CRIT_ON_HIT = 4;
export const MOD_VULNERABLE = 8;
export const MOD_SAVE_DISADVANTAGE = 16;
export const MOD_AUTO_FAIL = 32;
/** The bits of a context key above the modifiers: one per penalty-dice flag a step reads. */
export const MOD_PENALTY_SHIFT = 6;

/** Penalty dice a save takes off its d20: `count`d`sides`. */
export interface PenaltyDice {
  readonly count: number;
  readonly sides: number;
}

/** Penalty dice in their context order: by sides, then count. */
export const byDie = (a: PenaltyDice, b: PenaltyDice): number => a.sides - b.sides || a.count - b.count;

/** The facts a source declares about its row (`rowCheck`), or `undefined` for a source that declares none. */
export function rowCheckOf(source: unknown): RowCheck | undefined {
  if (typeof source !== "object" || source === null || source instanceof PMF) return undefined;
  const candidate = source as { rowCheck?: unknown; under?: unknown };
  if (typeof candidate.under !== "function") return undefined;
  const check = candidate.rowCheck;
  return typeof check === "object" && check !== null ? (check as RowCheck) : undefined;
}

/** Whether `source` rolls under a turn state ({@link ContextualSource}). */
export function isContextual(source: unknown): source is ContextualSource {
  return rowCheckOf(source) !== undefined;
}

/**
 * Set on a {@link ContextualSource} whose `under` does not roll `context.joined` riders' dice into its
 * own roll (the library's `AttackBuilder` and `SaveBuilder`): no rider may join its row (`Rider.joins`).
 */
export const IGNORES_JOINED: unique symbol = Symbol("ignoresJoined");

const ADVANTAGE_OF: Record<RollType, number> = { flat: 0, advantage: 1, "elven accuracy": 2, disadvantage: -1 };

/**
 * A row's d20 from its own roll and the advantage and disadvantage the state puts in force.
 * Advantage and disadvantage cancel to a plain d20, Elven Accuracy included; an own Elven
 * Accuracy stays three dice when nothing cancels it; `elven` (three advantage dice) upgrades an
 * advantage the state puts in force, never the row's own plain advantage.
 */
export function combineRollType(base: RollType, advantage: boolean, disadvantage: boolean, elven: boolean): RollType {
  const own = ADVANTAGE_OF[base];
  const net = advantage && elven ? 2 : own > 0 ? own : advantage ? 1 : 0;
  const against = disadvantage || own < 0;
  if (net > 0 && against) return "flat";
  if (net === 2) return "elven accuracy";
  if (net === 1) return "advantage";
  return against ? "disadvantage" : "flat";
}

/**
 * The context a row with `check` rolls in when the flags it reads put modifier key `key` in
 * force, with `penaltyDice` (in any order) taken off a save's d20.
 */
export function contextOf(check: RowCheck, key: number, penaltyDice: readonly PenaltyDice[] = []): RowContext {
  const save = check.kind === "save";
  return {
    rollType: check.pinned
      ? check.rollType
      : combineRollType(
          check.rollType,
          !save && (key & MOD_ADVANTAGE) !== 0,
          (key & MOD_DISADVANTAGE) !== 0 || (save && (key & MOD_SAVE_DISADVANTAGE) !== 0),
          check.advantageDice === 3
        ),
    autoHit: check.autoHit,
    critOnHit: check.autoCrit || (key & MOD_CRIT_ON_HIT) !== 0,
    autoFail: check.autoFail || (save && (key & MOD_AUTO_FAIL) !== 0),
    vulnerable: check.kind === "attack" && (key & MOD_VULNERABLE) !== 0,
    penaltyDice: save ? [...penaltyDice].sort(byDie) : [],
    joined: [],
  };
}

/**
 * A context as a string: two contexts with the same key roll the same PMF. `joined` holds
 * consumer-supplied rider ids, so it is JSON-encoded: a delimiter join would let `["a,b"]` and
 * `["a", "b"]` share a key.
 */
export function contextKey(context: RowContext): string {
  const dice = context.penaltyDice.map((die) => `${die.count}d${die.sides}`).join("+");
  return [
    context.rollType,
    +context.autoHit,
    +context.critOnHit,
    +context.autoFail,
    +context.vulnerable,
    dice,
    JSON.stringify(context.joined),
  ].join("|");
}
