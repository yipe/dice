import type { PMF } from "../";
import type { RollBuilder } from "./roll";

export type RollFactory = {
  (count: number, sides?: number, modifier?: number): RollBuilder;
  (count: number, die: RollBuilder, modifier?: number): RollBuilder;
  d(sides: number): RollBuilder;
  hd20(): RollBuilder;
  d4(): RollBuilder;
  d6(): RollBuilder;
  d8(): RollBuilder;
  d10(): RollBuilder;
  d12(): RollBuilder;
  d20(): RollBuilder;
  d100(): RollBuilder;
  flat(n: number): RollBuilder;
};

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
