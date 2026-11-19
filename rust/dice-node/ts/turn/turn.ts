import type { Check, MissRerollMode } from "../../../../src/builder/types";
import type { RollType } from "../../../../src/common/types";
import type { Rng } from "../../../../src/common/rng";
import type { ConditionOptions, EveryHitOptions, FirstHitOptions, Lasting, SaveGated, StartEffect, Transform } from "../../../../src/turn/effects";
import type { LandingPattern, RowLanding } from "../../../../src/turn/readers";
import type { TurnPlan } from "../../../../src/turn/plan";
import type { Trace } from "../../../../src/turn/trace";
import type {
  Attack,
  AttackOptions,
  AttackTriggerOn,
  Damage,
  ProbeSpec,
  Rider,
  RiderDamage,
  RiderOptions,
  Source,
  TurnSpec,
} from "../../../../src/turn/types";
import { native, type NativePmfHandle } from "../native";
import "./errors";
import { PMF } from "../pmf/pmf";
import { DiceQuery } from "../pmf/query";
import { evaluateMany, stepStatsOf, type ReadRequest, type TurnOutcome } from "./batch";

export type { AttackMarginal, ConditionAttempt, LiveOdds, RiderMarginal, StepStats } from "../../../../src/turn/turn";
import type { AttackMarginal, RiderMarginal, StepStats } from "../../../../src/turn/turn";

/**
 * Facade over the Rust turn engine (`src/turn_native.rs`): a `Turn` is a native handle, every
 * verb is one native call, and a spec crosses as JSON plus a table of the values JSON cannot
 * carry (builders and PMFs as their native handles, effect values, JS functions and hand-written
 * sources, which the native engine calls back into synchronously). See {@link encode}.
 */

type Json = string;
type Refs = unknown[];

function isHandWrittenSource(value: object): boolean {
  return ["toPMF", "under", "at"].some((name) => name in value && typeof Object.getOwnPropertyDescriptor(value, name)?.value === "function");
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function carriesBadTags(value: object): boolean {
  const { tags } = value as { tags?: unknown };
  return Array.isArray(tags) && tags.some((tag) => typeof tag !== "string");
}

/**
 * `{ json, refs }` for a value: arrays and plain objects become JSON; numbers JSON cannot carry
 * travel as "NaN", "Infinity", "-Infinity", "-0"; every other value (a facade object, an effect, a
 * function, a hand-written source) becomes `{"$": i}` with `refs[i]` its native handle (its
 * `_handle`) or, failing that, itself.
 */
export function encode(value: unknown): { json: Json; refs: Refs } {
  const refs: Refs = [];
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    switch (typeof v) {
      case "number":
        if (Object.is(v, -0)) return "-0";
        return Number.isFinite(v) ? v : String(v);
      case "string":
      case "boolean":
        return v;
      case "function":
        refs.push(v);
        return { $: refs.length - 1 };
      default:
    }
    const obj = v as object;
    if (Array.isArray(obj)) return obj.map(walk);
    // A hand-written source (`toPMF`, `under`, `at`) is one value even when it is a plain object.
    if (!isPlain(obj) || isHandWrittenSource(obj)) {
      // A source whose tags are not all strings goes as itself: the native side checks `tags` (non-string-id).
      refs.push("_handle" in obj && !carriesBadTags(obj) ? obj._handle : obj);
      return { $: refs.length - 1 };
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      if (entry !== undefined) out[key] = walk(entry);
    }
    return out;
  };
  return { json: JSON.stringify(walk(value)), refs };
}

/** Test seam: forces the full state walk (`Turn.from` uses `fromSpecWalked`). */
export const walkEverything = { forced: false };

const NO_PLAN =
  "is not available on the Rust turn engine: its plan lives in Rust and is not exposed as the TS plan object";

/**
 * The ids of a turn's plan (`attackIds`, `riderIds`, `substituteIds`, `conditionIds`, `probeIds`):
 * the part of the TS `TurnPlan` the public readers also give. The rest of the plan lives in Rust.
 */
export function inspectPlan(t: Turn): TurnPlan {
  const view = {
    attackIds: [...t.attackIds],
    riderIds: [...t.riderIds],
    substituteIds: [...t.substituteIds],
    conditionIds: [...t.conditionIds],
    probeIds: [...t.probeIds],
  };
  // Only the ids exist here; a test that reads other plan fields needs the TS engine.
  return view as unknown as TurnPlan;
}

/** Not available: the sample plan is native. */
export function inspectSamplePlan(_turn: Turn): never {
  throw new Error(`inspectSamplePlan ${NO_PLAN}`);
}

/** The number of trigger groups `t` tracks and, per step, the number of distinct walk states after it. */
export function inspectTurn(t: Turn): { groupCount: number; stateCounts: readonly number[] } {
  return t._handle.inspectTurn() as { groupCount: number; stateCounts: readonly number[] };
}

export interface NativeAttackMarginal {
  kind: "attack";
  pmf: NativePmfHandle;
  whenHappens: NativePmfHandle;
  occurs: number;
  /** `[flat, advantage, disadvantage, elven accuracy]`. */
  rollType: readonly [number, number, number, number];
}

/** `[occurs, rollTypeIdx, pmfAddr, whenAddr]`, plus `[flat, advantage, disadvantage, elven]` when the index is -1. */
export type PackedAttackMarginal = number[];

export interface NativeRiderMarginal {
  kind: "rider";
  pmf: NativePmfHandle;
  landings: Array<[string, RowLanding]>;
  anyLanding: number;
}

type Effect = RiderDamage | Lasting | readonly (Damage | Lasting)[] | SaveGated;

/**
 * @internal A native marginal as the TS `AttackMarginal | RiderMarginal` (PMFs wrapped). An attack
 * crosses packed (`[occurs, rollTypeIdx, pmfAddr, whenAddr]`, with the four d20 odds appended when
 * `rollTypeIdx` is -1): the PMFs are looked up by address and only a miss asks `handle` for them. A
 * batch cell at an AC (a throwaway turn) crosses as the whole object, PMF handles included.
 */
export function toMarginal(
  m: PackedAttackMarginal | NativeAttackMarginal | NativeRiderMarginal,
  handle: NativeTurnHandle,
  id: string
): AttackMarginal | RiderMarginal {
  if (!Array.isArray(m)) {
    if (m.kind === "rider") return { pmf: PMF._wrapShared(m.pmf), landings: new Map(m.landings), anyLanding: m.anyLanding };
    const [flat, advantage, disadvantage, elven] = m.rollType;
    return {
      pmf: PMF._wrapShared(m.pmf),
      whenHappens: PMF._wrapShared(m.whenHappens),
      occurs: m.occurs,
      rollType: { flat, advantage, disadvantage, "elven accuracy": elven },
    };
  }
  const [occurs, index, pmfAddress, whenAddress] = m;
  const mixed = index === -1;
  const flat = mixed ? m[4] : index === 0 ? 1 : 0;
  const advantage = mixed ? m[5] : index === 1 ? 1 : 0;
  const disadvantage = mixed ? m[6] : index === 2 ? 1 : 0;
  const elven = mixed ? m[7] : index === 3 ? 1 : 0;
  return {
    pmf: PMF._wrapAt(pmfAddress, () => handle.marginalPmf(id, "pmf")),
    whenHappens: PMF._wrapAt(whenAddress, () => handle.marginalPmf(id, "whenHappens")),
    occurs,
    rollType: { flat, advantage, disadvantage, "elven accuracy": elven },
  };
}

/** A turn: attacks, the riders and conditions that follow them, and the exact distribution of the total. */
export class Turn {
  /** @internal the native handle. */
  _handle: NativeTurnHandle;
  private readonly marginals = new Map<string, AttackMarginal | RiderMarginal>();
  private _pmf?: PMF;
  private _attackIds?: readonly string[];
  private _peakStates?: number;

  private constructor(handle: NativeTurnHandle) {
    this._handle = handle;
  }

  /** @internal */
  static _wrap(handle: NativeTurnHandle): Turn {
    return new Turn(handle);
  }

  /** A turn from a spec; `eps` is the epsilon its PMFs are built at. */
  static from(spec: TurnSpec, eps: number = 0): Turn {
    const { json, refs } = encode(spec);
    return Turn._wrap(native.NativeTurn.fromSpec(json, refs, eps, walkEverything.forced));
  }

  /**
   * Reads many turns in one native call (see `./batch.ts`): `result[i]` answers `turns[i]` with
   * exactly what the single readers return, one reading per AC of `request.acs` (or one reading).
   * Use it when you score a list of turns, or one turn over an AC sweep: it replaces
   * `turns.length * (acs.length || 1) * readers` native crossings and, for turns holding no JS callback,
   * runs them on all cores. For one turn and one reader, call the reader.
   */
  static evaluateMany(turns: readonly Turn[], request: ReadRequest): TurnOutcome[] {
    return evaluateMany(turns, request);
  }

  private verb(name: string, ...args: unknown[]): Turn {
    const { json, refs } = encode(args);
    return Turn._wrap(this._handle.verb(name, json, refs));
  }

  attack(source: Source, options?: string | AttackOptions): Turn {
    return this.verb("attack", source, options);
  }

  attacks(count: number, source: Source, options: { tag?: string; chance?: number } = {}): Turn {
    return this.verb("attacks", count, source, options);
  }

  rider(rider: Rider): Turn {
    return this.verb("rider", rider);
  }

  onFirstCrit(effect: Lasting | readonly Lasting[] | SaveGated, options: ConditionOptions = {}): Turn {
    return this.verb("onFirstCrit", effect, options);
  }

  atStart(effect: StartEffect | readonly StartEffect[], options: { target?: string } = {}): Turn {
    return this.verb("atStart", effect, options);
  }

  stateLimit(limit: number): Turn {
    return this.verb("stateLimit", limit);
  }

  onFirstHit(effect: Transform, options?: Omit<FirstHitOptions, "targetHas">): Turn;
  onFirstHit(effect: Effect, options?: FirstHitOptions): Turn;
  onFirstHit(effect: Effect | Transform, options: FirstHitOptions = {}): Turn {
    return this.verb("onFirstHit", effect, options);
  }

  convertFirstMiss(options: { id?: string; of?: string | readonly string[] } = {}): Turn {
    return this.verb("convertFirstMiss", options);
  }

  rerollFirstMiss(options: { id?: string; of?: string | readonly string[]; mode?: MissRerollMode } = {}): Turn {
    return this.verb("rerollFirstMiss", options);
  }

  onAnyCrit(effect: Effect, options: ConditionOptions = {}): Turn {
    return this.verb("onAnyCrit", effect, options);
  }

  onAnyMiss(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.verb("onAnyMiss", damage, options);
  }

  onFirstMiss(damage: RiderDamage, options: RiderOptions = {}): Turn {
    return this.verb("onFirstMiss", damage, options);
  }

  onEveryHit(effect: Effect, options: EveryHitOptions = {}): Turn {
    return this.verb("onEveryHit", effect, options);
  }

  otherwise(damage: RiderDamage, options: Omit<RiderOptions, "of" | "targetHas"> = {}): Turn {
    return this.verb("otherwise", damage, options);
  }

  onDiceMatch(of: readonly string[], damage: RiderDamage, options: Omit<RiderOptions, "of" | "targetHas"> = {}): Turn {
    return this.verb("onDiceMatch", of, damage, options);
  }

  observe(probe: ProbeSpec): Turn {
    return this.verb("observe", probe);
  }

  observeAnyCrit(id: string, options: { of?: readonly string[] } = {}): Turn {
    return this.verb("observeAnyCrit", id, options);
  }

  vsAC(ac: number): Turn {
    return this.verb("vsAC", ac);
  }

  /** The distribution of the turn's total damage. */
  get pmf(): PMF {
    return (this._pmf ??= PMF._wrapShared(this._handle.pmf()));
  }

  sample(rng: Rng): Trace {
    return this._handle.sample(
      (n: number) => rng.die(n),
      (p: number) => rng.chance(p)
    ) as Trace;
  }

  mean(): number {
    return this._handle.mean();
  }

  toQuery(): DiceQuery {
    const singles = (this._handle.attackSingles() as NativePmfHandle[]).map((h) => PMF._wrapShared(h));
    return new DiceQuery(singles, this.pmf, this.eps);
  }

  /** The epsilon the turn's PMFs are built at. */
  private get eps(): number {
    return this._handle.eps() as number;
  }

  get attackIds(): readonly string[] {
    return (this._attackIds ??= this._handle.attackIds() as string[]);
  }

  get riderIds(): readonly string[] {
    return this._handle.riderIds() as string[];
  }

  get substituteIds(): readonly string[] {
    return this._handle.substituteIds() as string[];
  }

  get conditionIds(): readonly string[] {
    return this._handle.conditionIds() as string[];
  }

  get probeIds(): readonly string[] {
    return this._handle.probeIds() as string[];
  }

  marginal(id: string): AttackMarginal | RiderMarginal {
    const known = this.marginals.get(id);
    if (known !== undefined) return known;
    const result = toMarginal(this._handle.marginal(id) as PackedAttackMarginal | NativeRiderMarginal, this._handle, id);
    this.marginals.set(id, result);
    return result;
  }

  fireProbability(id: string): number {
    return this._handle.fireProbability(id);
  }

  expectedApplications(id: string): number {
    return this._handle.expectedApplications(id);
  }

  stepStats(id: string): StepStats {
    return stepStatsOf(this._handle.stepStats(id));
  }

  attemptProbability(id: string): number {
    return this._handle.attemptProbability(id);
  }

  landings(id: string): readonly LandingPattern[] {
    return this._handle.landings(id) as LandingPattern[];
  }

  get peakStates(): number {
    return (this._peakStates ??= this._handle.peakStates());
  }
}

/** The engine's handle type (see `src/turn_native.rs`). */
type NativeTurnHandle = {
  verb(name: string, args: Json, refs: Refs): NativeTurnHandle;
  pmf(): NativePmfHandle;
  mean(): number;
  eps(): number;
  attackSingles(): unknown;
  attackIds(): unknown;
  riderIds(): unknown;
  substituteIds(): unknown;
  conditionIds(): unknown;
  probeIds(): unknown;
  marginal(id: string): unknown;
  marginalPmf(id: string, which: "pmf" | "whenHappens"): NativePmfHandle;
  fireProbability(id: string): number;
  expectedApplications(id: string): number;
  stepStats(id: string): unknown;
  attemptProbability(id: string): number;
  landings(id: string): unknown;
  peakStates(): number;
  sample(die: (n: number) => number, chance: (p: number) => boolean): unknown;
  inspectTurn(): unknown;
};

/** `turn(attacks, eps)`: a turn of one or several attacks. */
export function turn(attacks: Attack | readonly Attack[] = [], eps: number = 0): Turn {
  const { json, refs } = encode(Array.isArray(attacks) ? attacks : [attacks]);
  return Turn._wrap(native.turnOf(json, refs, eps));
}

/** `bounce({ source, max })`: a depth-capped chain of dice-match riders (see `src/turn/turn.ts`). */
export function bounce({ source, max }: { source: Damage; max: number }): Turn {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError(`bounce({ max }) needs a non-negative integer, got ${max}.`);
  }
  const { json, refs } = encode(source);
  return Turn._wrap(native.bounceOf(json, refs, max));
}
