/** Bumped whenever the sampler's draw order changes, so a stored seed replays the same trace. */
export const SAMPLER_VERSION = 1;

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
