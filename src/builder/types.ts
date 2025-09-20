import type { PMF } from "../";

export type RollType = "flat" | "advantage" | "disadvantage" | "elven accuracy";
export type KeepMode = "highest" | "lowest";

// Intermediate Representation, gets converetd into an AST as needed
export type RollConfig = {
  count: number;
  sides: number;
  modifier: number;
  reroll: number; // Reroll threshold k (k >= 0). Implements one-pass, reroll-once, must-keep on faces {1..k}.
  explode: number;
  minimum: number;
  bestOf: number;
  keep: { total: number; count: number; mode: KeepMode } | undefined;
  rollType: RollType;
  isSubtraction?: boolean; // true if this negative count should be treated as subtraction
};

export type Resolution = {
  pmf: PMF;
  check: PMF;
  weights: { [key: string]: number };
};

export type AttackResolution = Resolution & {
  hit: PMF;
  crit: PMF;
  miss: PMF;
  weights: { hit: number; crit: number; miss: number };
};

export type SaveResolution = Resolution & {
  saveFail: PMF;
  saveSuccess: PMF;
  weights: { success: number; fail: number };
};

export interface CheckBuilder {
  resolve(eps?: number): Resolution;
  toExpression(): string;
}
