import { EFFECT_NAMES, type EffectName, type LandingPattern } from "../../../../src/turn/readers";
import type { LiveOdds, StepStats } from "../../../../src/turn/turn";
import { fromNative, native, translateError } from "../native";
import { PMF } from "../pmf/pmf";
import { toMarginal, type AttackMarginal, type NativeAttackMarginal, type NativeRiderMarginal, type PackedAttackMarginal, type RiderMarginal, type Turn } from "./turn";

/**
 * Batch reads (ADR-018): `Turn.evaluateMany(turns, request)` hands the Rust engine a list of turns
 * and the readings wanted from each, and answers them all from one native call.
 *
 * Use it when a caller scores many turns (candidates, a grind's levels) or sweeps one turn over armor
 * classes: the per-call facade pays a native crossing per reader (plus one `vsAC` handle per AC) and
 * runs on one thread. The batch pays one crossing, packs numbers into one `Float64Array`, and
 * evaluates turns on a thread pool. Results are
 * bit-for-bit what `turn.vsAC(ac).mean()`, `.pmf`, `.marginal(id)`, ... return one by one.
 *
 * Threading: turns that hold a JS callback or hand-written source (`failChance`, a `{ toPMF }`
 * object, ...) are read on the JS thread, serially, after the others have finished; every other turn
 * runs in parallel unless `parallel: false`. With few or tiny turns the pool is not worth it:
 * measure (`bench/batch.mjs`).
 */

/** What to read from each turn. Every field is optional; an empty request answers empty readings. */
export interface ReadRequest {
  /** `turn.mean()`. */
  mean?: boolean;
  /** `turn.pmf`. */
  pmf?: boolean;
  /** `turn.marginal(id)` per id. */
  marginals?: readonly string[];
  /** `turn.stepStats(id)` per id. */
  stepStats?: readonly string[];
  /** `turn.fireProbability(id)` per id. */
  fireProbability?: readonly string[];
  /** `turn.expectedApplications(id)` per id. */
  expectedApplications?: readonly string[];
  /** Also every attack id's and rider id's marginal, after `marginals` (for turns that do not share ids). */
  allMarginals?: boolean;
  /** Also every attack id's `stepStats`, after `stepStats`. */
  allStepStats?: boolean;
  /** `turn.landings(id)` for every attack id. */
  allLandings?: boolean;
  /** `turn.peakStates`. */
  peakStates?: boolean;
  /** Evaluate each turn at each of these armor classes (`turn.vsAC(ac)` first). Absent: read the turn as given. */
  acs?: readonly number[];
  /** Run turns on the thread pool (default true). */
  parallel?: boolean;
}

/** The readings of one turn (at one AC). Maps are keyed by the ids of the request. */
export interface TurnReading {
  /** The AC of this reading; absent when the request has no `acs`. */
  ac?: number;
  mean?: number;
  pmf?: PMF;
  peakStates?: number;
  /** By attack id (`allLandings`). */
  landings: Map<string, LandingPattern[]>;
  marginals: Map<string, AttackMarginal | RiderMarginal>;
  stepStats: Map<string, StepStats>;
  fireProbability: Map<string, number>;
  expectedApplications: Map<string, number>;
}

/**
 * One turn's answer: `readings[i]` for `request.acs[i]` (a single reading without `acs`), or the
 * error its first failing reader would have thrown (`TurnSpecError`, `RangeError`, ...).
 */
export type TurnOutcome = { ok: true; readings: TurnReading[] } | { ok: false; error: Error };

interface NativeBatch {
  cells: number;
  stride: number;
  scalars: Float64Array;
  pmfs?: unknown[];
  marginals: unknown[][];
  stepStats: unknown[][];
  landings: unknown[][];
  errors: (string | undefined)[];
}

function errorOf(message: string): Error {
  const translated = translateError(new Error(message));
  return translated instanceof Error ? translated : new Error(message);
}

const NONE: readonly never[] = Object.freeze([]);

const NO_LIVE: LiveOdds = Object.freeze({
  ...(Object.fromEntries(EFFECT_NAMES.map((name) => [name, 0])) as Record<EffectName, number>),
  sources: Object.freeze(Object.fromEntries(EFFECT_NAMES.map((name) => [name, NONE])) as Record<EffectName, readonly never[]>),
});

/** A native step stat: `[rolled, hit, crit]` for a stateless row, else the full object. */
export function stepStatsOf(v: unknown): StepStats {
  if (!Array.isArray(v)) return v as StepStats;
  const [rolled, hit, crit] = v as [number, number, number];
  return { rolled, hit, crit, live: NO_LIVE, conditions: NONE };
}

/** Calls `each(id, value)` for a flat `[id, value, id, value, ...]` list. */
function forPairs(list: unknown[], each: (id: string, value: unknown) => void): void {
  for (let k = 0; k < list.length; k += 2) each(list[k] as string, list[k + 1]);
}

/** `Turn.evaluateMany`; see this file's header. */
export function evaluateMany(turns: readonly Turn[], request: ReadRequest): TurnOutcome[] {
  const marginalIds = request.marginals ?? [];
  const stepIds = request.stepStats ?? [];
  const fireIds = request.fireProbability ?? [];
  const expectedIds = request.expectedApplications ?? [];
  const acs = request.acs ?? [];
  const wantsMean = request.mean === true;
  const wantsPmf = request.pmf === true;
  const wantsPeak = request.peakStates === true;
  const batch = fromNative(() =>
    native.evaluateTurns(
      turns.map((t) => t._handle),
      {
        mean: wantsMean,
        pmf: wantsPmf,
        marginals: [...marginalIds],
        stepStats: [...stepIds],
        allMarginals: request.allMarginals === true,
        allStepStats: request.allStepStats === true,
        allLandings: request.allLandings === true,
        peakStates: wantsPeak,
        fireProbability: [...fireIds],
        expectedApplications: [...expectedIds],
        acs: [...acs],
        parallel: request.parallel !== false,
      }
    )
  ) as NativeBatch;
  const { cells, stride, scalars } = batch;
  return turns.map((_, turnIndex): TurnOutcome => {
    const failure = batch.errors[turnIndex];
    if (failure !== undefined) return { ok: false, error: errorOf(failure) };
    const readings: TurnReading[] = [];
    for (let a = 0; a < cells; a++) {
      const cell = turnIndex * cells + a;
      let at = cell * stride;
      const reading: TurnReading = {
        landings: new Map(),
        marginals: new Map(),
        stepStats: new Map(),
        fireProbability: new Map(),
        expectedApplications: new Map(),
      };
      if (acs.length > 0) reading.ac = acs[a];
      if (wantsMean) reading.mean = scalars[at++];
      if (wantsPeak) reading.peakStates = scalars[at++];
      if (wantsPmf) reading.pmf = PMF._wrapShared(batch.pmfs![cell] as never);
      for (const id of fireIds) reading.fireProbability.set(id, scalars[at++]);
      for (const id of expectedIds) reading.expectedApplications.set(id, scalars[at++]);
      // Packed attacks (no `acs`) miss through the turn's own handle; with `acs` they cross whole.
      const handle = turns[turnIndex]._handle;
      forPairs(batch.marginals[cell], (id, v) => reading.marginals.set(id, toMarginal(v as PackedAttackMarginal | NativeAttackMarginal | NativeRiderMarginal, handle, id)));
      forPairs(batch.stepStats[cell], (id, v) => reading.stepStats.set(id, stepStatsOf(v)));
      forPairs(batch.landings[cell], (id, v) => reading.landings.set(id, v as LandingPattern[]));
      readings.push(reading);
    }
    return { ok: true, readings };
  });
}
