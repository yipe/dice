/**
 * Bumped whenever the sampler's draw order changes, so a stored seed replays the same trace. Bump when
 * `tests/sample-draw-order.test.ts`'s snapshot changes for a reason other than a bug in the snapshot
 * itself; update the snapshot in the same commit.
 */
export const SAMPLER_VERSION = 1;

/** `reroll`: the die that replaced a rerolled one (per-die reroll); the original keeps its functional role with `kept: false`. */
export type DieRole = "attack" | "save" | "damage" | "rider" | "reroll";

export interface DieRoll {
  sides: number;
  face: number;
  role: DieRole;
  by: "you" | "enemy";
  source: string;
  kept: boolean;
}

export type OutcomeResult = "hit" | "crit" | "miss" | "save-fail" | "save-pass" | "fired" | "skipped";

export interface Outcome {
  source: string;
  result: OutcomeResult;
  damage: number;
}

export interface Wave {
  dice: DieRoll[];
  outcomes: Outcome[];
}

export interface Trace {
  total: number;
  samplerVersion: number;
  waves: Wave[];
}
