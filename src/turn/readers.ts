/**
 * The reader walk's ledger and tallies. One walk that carries
 * only mass, plus a plain damage array per capped (`every-hit`) rider, yields every marginal reader:
 * a row's marginal is the mass of each context it rolls in times that context's PMF, a rider that
 * lands once is the mass of each payload it lands with, and a rider that lands again and again is its
 * carried array. No PMF arithmetic runs inside the walk.
 */
import type { Bin, RollType } from "../common/types";
import { PMF } from "../pmf/pmf";
import {
  MOD_ADVANTAGE,
  MOD_AUTO_FAIL,
  MOD_CRIT_ON_HIT,
  MOD_DISADVANTAGE,
  MOD_SAVE_DISADVANTAGE,
  MOD_VULNERABLE,
} from "./context";
import type { Draw, Step, TurnPlan } from "./plan";
import { CRIT_BIT, CRIT_MATCH_BIT, FIRST_CRIT, FIRST_HIT, FIRST_NONE, MATCH_BIT, MISS_BIT } from "./state";

/** What a later reader needs of a group code (bits of a needs mask). */
const NEED_FIRST_MODE = 1;
const NEED_FIRST = 2;
const NEED_CRIT = 4;
const NEED_MISS = 8;
const NEED_MATCH = 16;

/** What a trigger (a step rider's or a condition's) reads of its group code. */
const TRIGGER_NEEDS: Record<string, number> = {
  "first-hit": NEED_FIRST,
  "first-crit": NEED_CRIT,
  "any-crit": NEED_CRIT,
  "first-miss": NEED_MISS,
  "any-miss": NEED_MISS,
  "dice-match": NEED_MATCH,
};

/**
 * Per step, per group slot, what the readers after the step need of its code; undefined where a
 * substitute reads codes to look ahead (it needs them whole). The reader walk keeps only that of each
 * code, so states that differ only in what nothing reads again merge: dead-bit merging, by bit. The
 * full walk keeps codes whole, so its numbers stay bit for bit.
 */
export function codeNeeds(plan: TurnPlan): number[][] | undefined {
  if (plan.substituteIds.length !== 0) return undefined;
  const width = plan.groupCount;
  let after = new Array<number>(width).fill(0);
  // At the end: what the firing masses read (see Turn.tally).
  for (const [id, slot] of plan.perHitGroups) {
    if (slot === -1) continue;
    after[slot] |= plan.perHitCritOnly.has(id) ? NEED_CRIT : plan.perHitAny.has(id) ? NEED_FIRST | NEED_MISS : NEED_FIRST;
  }
  const needs: number[][] = new Array<number[]>(plan.steps.length);
  for (let s = plan.steps.length - 1; s >= 0; s--) {
    needs[s] = after;
    const step = plan.steps[s];
    const at = [...after];
    // A first-hit step rider reads which outcome came first: its mode.
    if (step.trigger !== null && step.reads !== -1) {
      at[step.reads] |= step.trigger.on === "first-hit" ? NEED_FIRST | NEED_FIRST_MODE : (TRIGGER_NEEDS[step.trigger.on] ?? 0);
    }
    for (const app of step.grants) {
      if (app.rider === undefined && app.tried === 0 && app.reads !== -1) at[app.reads] |= TRIGGER_NEEDS[app.on] ?? 0;
    }
    if (step.gate !== undefined) at[step.gate.slot] |= step.gate.any ? NEED_FIRST | NEED_MISS : NEED_FIRST;
    after = at;
  }
  return needs;
}

/** `codes` with each code cut down to what `needs` says is still read; the same array if nothing changes. */
export function canonicalCodes(codes: readonly number[], needs: readonly number[]): readonly number[] {
  let out: number[] | undefined;
  for (let g = 0; g < codes.length; g++) {
    const code = codes[g];
    const need = needs[g];
    const first = (code >> 2) & 0b11;
    let next = 0;
    if (need & NEED_FIRST_MODE) next |= first << 2;
    else if (need & NEED_FIRST && first !== FIRST_NONE) next |= FIRST_HIT << 2;
    if (need & NEED_CRIT) next |= code & CRIT_BIT;
    if (need & NEED_MISS) next |= code & MISS_BIT;
    if (need & NEED_MATCH) next |= code & (MATCH_BIT | CRIT_MATCH_BIT);
    if (next !== code) (out ??= [...codes])[g] = next;
  }
  return out ?? codes;
}

/** A rider that fires as a step of its own, reading a group slot a row advances. */
interface StepRider {
  id: string;
  slot: number;
  on: string;
}

/**
 * Where a step rider lands: on the row whose draw first gives its group what its trigger reads
 * (the first landing, the first crit, the first miss, the first match), in that draw's mode.
 */
function stepLanding(on: string, before: number, after: number, outcome: Draw["outcome"]): "hit" | "crit" | null {
  switch (on) {
    case "first-hit": {
      if (((before >> 2) & 0b11) !== FIRST_NONE) return null;
      const first = (after >> 2) & 0b11;
      return first === FIRST_NONE ? null : first === FIRST_CRIT ? "crit" : "hit";
    }
    case "any-crit":
      return (before & CRIT_BIT) === 0 && (after & CRIT_BIT) !== 0 ? "crit" : null;
    case "any-miss":
    case "first-miss":
      return (before & MISS_BIT) === 0 && (after & MISS_BIT) !== 0 ? "hit" : null;
    case "dice-match":
      if ((before & MATCH_BIT) !== 0 || (after & MATCH_BIT) === 0) return null;
      return (after & CRIT_MATCH_BIT) !== 0 && outcome === "crit" ? "crit" : "hit";
    default:
      return null;
  }
}

/** The effects a row can find in force, as the engine names them. */
export const EFFECT_NAMES = [
  "advantage",
  "disadvantage",
  "critOnHit",
  "autoFail",
  "saveDisadvantage",
  "savePenalty",
  "vulnerable",
] as const;
export type EffectName = (typeof EFFECT_NAMES)[number];

/** The `MOD_*` bit each effect is (`savePenalty` is a read's penalty dice instead). */
const EFFECT_MODIFIER: Record<Exclude<EffectName, "savePenalty">, number> = {
  advantage: MOD_ADVANTAGE,
  disadvantage: MOD_DISADVANTAGE,
  critOnHit: MOD_CRIT_ON_HIT,
  autoFail: MOD_AUTO_FAIL,
  saveDisadvantage: MOD_SAVE_DISADVANTAGE,
  vulnerable: MOD_VULNERABLE,
};

/** A read's effects, as bits over {@link EFFECT_NAMES}. */
function effectBits(read: Step["flagReads"][number]): number {
  let bits = 0;
  EFFECT_NAMES.forEach((name, index) => {
    const lit = name === "savePenalty" ? read.penalty : (read.modifiers & EFFECT_MODIFIER[name]) !== 0;
    if (lit) bits |= 1 << index;
  });
  return bits;
}

/** P(damage = d) at index d: a capped rider's damage, carried without labels until the end. */
type Dist = Float64Array;

/** What a capped rider has dealt in a state: the chance it has not landed yet, and its damage given it has. */
export interface Carry {
  none: number;
  dealt: Dist | undefined;
}

/**
 * The reader walk's damage: the mass of the paths a state stands for, and one carry per capped
 * rider. States that merge keep their parts until a carry is read, then mix them all at once.
 */
export interface ReaderDamage {
  mass: number;
  carries?: readonly Carry[];
  /** The merged states not mixed yet; only a merge creates it, and only that merge's state holds it. */
  parts?: ReaderDamage[];
}

/** `damage`'s carries, its parts mixed by mass where it has them. */
export function carriesOf(damage: ReaderDamage): readonly Carry[] {
  if (damage.carries !== undefined) return damage.carries;
  const parts = damage.parts as ReaderDamage[];
  const first = parts[0].carries as readonly Carry[];
  damage.carries = parts.every((part) => part.carries === first)
    ? first
    : first.map((_, c) => {
        let total = 0;
        let none = 0;
        let landed = 0;
        let length = 0;
        for (const part of parts) {
          const held = (part.carries as readonly Carry[])[c];
          total += part.mass;
          none += part.mass * held.none;
          if (held.dealt !== undefined && held.none < 1) {
            landed += part.mass * (1 - held.none);
            length = Math.max(length, held.dealt.length);
          }
        }
        if (!(total > 0)) return first[c];
        if (!(landed > 0)) return { none: none / total, dealt: undefined };
        const dealt = new Float64Array(length);
        for (const part of parts) {
          const held = (part.carries as readonly Carry[])[c];
          if (held.dealt !== undefined && held.none < 1) addInto(dealt, held.dealt, (part.mass * (1 - held.none)) / landed);
        }
        return { none: none / total, dealt };
      });
  damage.parts = undefined;
  return damage.carries;
}

const distOfPmf = new WeakMap<PMF, Dist | null>();
/** A payload's damage as an array, or null where it is not whole numbers of 0 or more. */
function distOf(pmf: PMF): Dist | null {
  let dist = distOfPmf.get(pmf);
  if (dist !== undefined) return dist;
  const support = [...pmf.map.keys()];
  if (support.some((damage) => !Number.isInteger(damage) || damage < 0)) {
    dist = null;
  } else {
    dist = new Float64Array(Math.max(0, ...support) + 1);
    for (const [damage, bin] of pmf.map) dist[damage] += bin.p;
  }
  distOfPmf.set(pmf, dist);
  return dist;
}

function addInto(into: Float64Array, dist: Dist, weight: number): void {
  for (let d = 0; d < dist.length; d++) into[d] += dist[d] * weight;
}

/** Landings already made: the same carry landing the same payload is the same carry. */
const landingsMade = new WeakMap<Carry, WeakMap<Dist, Carry>>();

/** A capped rider lands `pay`: where it had not landed that is its damage, else `pay` adds to it. */
function landOn(held: Carry, pay: Dist): Carry {
  let byPayload = landingsMade.get(held);
  if (byPayload === undefined) landingsMade.set(held, (byPayload = new WeakMap()));
  const known = byPayload.get(pay);
  if (known !== undefined) return known;
  const out = new Float64Array((held.dealt?.length ?? 1) + pay.length - 1);
  if (held.none > 0) addInto(out, pay, held.none);
  if (held.dealt !== undefined && held.none < 1) {
    const weight = 1 - held.none;
    for (let a = 0; a < held.dealt.length; a++) {
      const pa = held.dealt[a] * weight;
      if (pa === 0) continue;
      for (let b = 0; b < pay.length; b++) out[a + b] += pa * pay[b];
    }
  }
  const next: Carry = { none: 0, dealt: out };
  byPayload.set(pay, next);
  return next;
}

/**
 * The ledger of the reader walk. `capped` lists the riders carried as arrays (the `every-hit` ones);
 * one whose payload is not whole numbers lands in `unexact`, and its marginal is read another way.
 */
export function readerLedger(capped: readonly string[]): {
  start: ReaderDamage;
  unexact: Set<string>;
  mass(damage: ReaderDamage): number;
  add(a: ReaderDamage, b: ReaderDamage): ReaderDamage;
  scale(damage: ReaderDamage, factor: number): ReaderDamage;
  convolve(damage: ReaderDamage, slice: PMF, step: Step, draw?: Draw): ReaderDamage;
} {
  const indexOf = new Map(capped.map((id, index) => [id, index]));
  const unexact = new Set<string>();
  const none: Carry = { none: 1, dealt: undefined };
  return {
    start: { mass: 1, carries: capped.map(() => none) },
    unexact,
    mass: (damage) => damage.mass,
    add: (a, b) => {
      if (a.carries !== undefined && a.carries === b.carries) return { mass: a.mass + b.mass, carries: a.carries };
      const tail = b.parts ?? [b];
      if (a.parts !== undefined) {
        a.parts.push(...tail);
        a.mass += b.mass;
        return a;
      }
      return { mass: a.mass + b.mass, parts: [a, ...tail] };
    },
    scale: (damage, factor) => ({ mass: damage.mass * factor, carries: carriesOf(damage) }),
    convolve: (damage, slice, _step, draw) => {
      const mass = damage.mass * slice.mass();
      const held = carriesOf(damage);
      let carries = held;
      for (const [id, payload] of draw?.riders ?? []) {
        const c = indexOf.get(id);
        if (c === undefined) continue;
        const pay = distOf(payload);
        if (pay === null) {
          unexact.add(id);
          continue;
        }
        if (carries === held) carries = [...held];
        (carries as Carry[])[c] = landOn(carries[c], pay);
      }
      return { mass, carries };
    },
  };
}

/** A capped rider's damage over the terminal states, labelled once: landed damage is `hit`, none `missNone`. */
export function cappedPmf(states: Iterable<ReaderDamage>, c: number, total: number): PMF {
  let length = 1;
  const held: [Carry, number][] = [];
  for (const damage of states) {
    const { mass } = damage;
    const carry = carriesOf(damage)[c];
    if (carry.dealt === undefined || carry.none >= 1) continue;
    held.push([carry, mass]);
    length = Math.max(length, carry.dealt.length);
  }
  const dealt = new Float64Array(length);
  let landed = 0;
  for (const [carry, mass] of held) {
    const weight = (mass * (1 - carry.none)) / total;
    addInto(dealt, carry.dealt as Dist, weight);
    landed += weight;
  }
  const bins = new Map<number, Bin>();
  dealt.forEach((p, damage) => {
    if (p > 0) bins.set(damage, { p, count: { hit: p } });
  });
  const missing = Math.max(0, 1 - landed);
  if (missing > 0) {
    const zero = bins.get(0);
    bins.set(
      0,
      zero === undefined
        ? { p: missing, count: { missNone: missing } }
        : { p: zero.p + missing, count: { ...zero.count, missNone: missing } }
    );
  }
  return new PMF(bins).withAttribution();
}

/** Where a rider landed on one row: by outcome, and the part of those where the target was vulnerable. */
export interface RowLanding {
  hit: number;
  crit: number;
  doubled: { hit: number; crit: number };
}

/** One way a row's landing went: its outcome, whether it dealt damage, the riders that landed with it. */
export interface LandingPattern {
  label: string;
  dealt: boolean;
  riders: readonly string[];
  mass: number;
}

/** The outcome labels that are a landing; any other outcome is the row's rest (`miss`, or `savePass`). */
const LANDING_LABELS: ReadonlySet<string> = new Set(["hit", "crit", "saveFail", "saveHalf"]);
/** The labels that make a row a save. */
const SAVE_LABELS = ["saveFail", "saveHalf", "savePass"];

/** One branch of a draw, as the engine names a row's branches, and its share of the draw. */
interface DrawBranch {
  label: string;
  dealt: boolean;
  share: number;
}

const drawBranches = new WeakMap<Draw, readonly DrawBranch[]>();
/**
 * A draw's branches, read off the outcome labels of the row's own damage in it, as the engine's
 * `compileBranches` reads a row: a landing label (hit, crit, saveFail, saveHalf) split by whether
 * it dealt more than 0; everything else is the rest, `savePass` on a save and `miss` otherwise,
 * which deals nothing as a landing. A PMF without labels is the draw's own outcome.
 */
function branchesOf(draw: Draw, isSave: boolean): readonly DrawBranch[] {
  let branches = drawBranches.get(draw);
  if (branches !== undefined) return branches;
  const own = draw.own ?? draw.slice;
  const rest = isSave ? "savePass" : "miss";
  const byKey = new Map<string, DrawBranch>();
  let total = 0;
  const add = (label: string, dealt: boolean, mass: number): void => {
    if (!(mass > 0)) return;
    total += mass;
    const key = `${label}|${dealt}`;
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, { label, dealt, share: mass });
    else known.share += mass;
  };
  for (const [damage, bin] of own.map) {
    const labels = Object.keys(bin.count ?? {});
    if (labels.length === 0) {
      const label = draw.outcome === "hit" || draw.outcome === "crit" ? draw.outcome : rest;
      add(label, LANDING_LABELS.has(label) && damage > 0, bin.p);
      continue;
    }
    for (const label of labels) {
      const mass = bin.count[label] as number;
      if (LANDING_LABELS.has(label)) add(label, damage > 0, mass);
      else add(rest, false, mass);
    }
  }
  branches = [...byKey.values()].map((branch) => ({ ...branch, share: branch.share / total }));
  drawBranches.set(draw, branches);
  return branches;
}

/**
 * Everything the reader walk tallies, in the walk's unnormalized mass units: per step, the d20 it
 * rolls, the effects in force and where they come from, the mass of each context it rolls in and of
 * its draws that happen, each condition's attempts; per rider, the rows it lands on and the payloads
 * a rider that lands once lands with; per row, its landing patterns.
 */
export class ReaderTally {
  readonly rollTypes: Record<RollType, number>[];
  readonly effects: number[][];
  readonly effectSources: Map<number, number[]>[];
  readonly contextMass: number[][];
  readonly happened: number[];
  readonly attempts: Map<number, { attempted: number; taken: number }>[];
  readonly landings = new Map<string, Map<string, RowLanding>>();
  readonly onceWeights = new Map<string, Map<PMF, number>>();
  readonly patterns = new Map<string, Map<string, LandingPattern>>();
  private readonly readBits: number[][];
  /** Per step, whether the row is a save (its rest is `savePass`, not `miss`); read for patterns only. */
  private readonly isSave: boolean[];
  /** Per row, the step riders that read a slot it advances, with the slot. */
  private readonly stepRiders: StepRider[][];

  constructor(
    private readonly steps: readonly Step[],
    /** The riders carried as arrays: they land again and again, so their payloads are not tallied. */
    private readonly capped: ReadonlySet<string>,
    /** The riders that land on anything (`landing: "any"`): each landing is booked as a hit. */
    private readonly cast: ReadonlySet<string>,
    /** With landing patterns too (they cost a little on every landing): the riders' declaration order. */
    private readonly riderOrder?: ReadonlyMap<string, number>
  ) {
    this.isSave = steps.map((step) => {
      if (riderOrder === undefined) return false;
      const labels = step.contextPmfs[0]?.outcomes() ?? [];
      return SAVE_LABELS.some((label) => labels.includes(label));
    });
    this.rollTypes = steps.map(() => ({ flat: 0, advantage: 0, disadvantage: 0, "elven accuracy": 0 }));
    this.effects = steps.map(() => EFFECT_NAMES.map(() => 0));
    this.effectSources = steps.map(() => new Map());
    // A context's PMF is there once a state rolled in it (see Step.contextPmfs): size by the count.
    this.contextMass = steps.map((step) => new Array<number>(step.contextPmfs.length).fill(0));
    this.happened = steps.map(() => 0);
    this.attempts = steps.map(() => new Map());
    this.readBits = steps.map((step) => step.flagReads.map(effectBits));
    // A slot a row advances is read by the later step riders of the same group: up to the step
    // that releases it.
    this.stepRiders = steps.map((step, x) =>
      step.updates.flatMap((slot) => {
        const readers: StepRider[] = [];
        for (let r = x + 1; r < steps.length; r++) {
          const rider = steps[r];
          if (rider.variants.length === 0 && rider.trigger !== null && rider.reads === slot) {
            readers.push({ id: rider.id, slot, on: rider.trigger.on });
          }
          if (rider.releases.includes(slot)) break;
        }
        return readers;
      })
    );
  }

  /** A state reaches row `s`, in context `context`: the d20 it rolls there and the effects in force. */
  reach(s: number, context: number, flags: number, mass: number): void {
    const step = this.steps[s];
    if (step.contextRollTypes.length !== 0) this.rollTypes[s][step.contextRollTypes[context]] += mass;
    if (step.flagReads.length === 0) return;
    const reads = step.flagReads;
    const readBits = this.readBits[s];
    let any = 0;
    for (let r = 0; r < reads.length; r++) if (flags & (1 << reads[r].bit)) any |= readBits[r];
    if (any === 0) return;
    const effects = this.effects[s];
    for (let e = 0; e < EFFECT_NAMES.length; e++) if (any & (1 << e)) effects[e] += mass;
    // A source's effects count once however many of its flags this row reads.
    const sources = this.effectSources[s];
    for (let r = 0; r < reads.length; r++) {
      if ((flags & (1 << reads[r].bit)) === 0) continue;
      let bits = readBits[r];
      for (let q = 0; q < r; q++) {
        if (reads[q].source === reads[r].source && flags & (1 << reads[q].bit)) bits &= ~readBits[q];
      }
      if (bits === 0) continue;
      let row = sources.get(reads[r].source);
      if (row === undefined) sources.set(reads[r].source, (row = EFFECT_NAMES.map(() => 0)));
      for (let e = 0; e < EFFECT_NAMES.length; e++) if (bits & (1 << e)) row[e] += mass;
    }
  }

  /** A state rolls row `s` in context `context`. */
  roll(s: number, context: number, mass: number): void {
    if (this.contextMass[s].length !== 0) this.contextMass[s][context] += mass;
  }

  /** A pure-damage step fires: its payload, for a rider that lands once. */
  fire(step: Step, payload: PMF, mass: number): void {
    this.weigh(step.id, payload, mass);
  }

  /**
   * A draw of row `s` in context `context`, at `mass`, taking the group codes from `before` to
   * `after`: the riders folded into it land here, and so do the step riders whose trigger it
   * meets first.
   */
  draw(s: number, draw: Draw, mass: number, context: number, before: readonly number[], after: readonly number[]): void {
    if (draw.outcome === "none") return;
    const step = this.steps[s];
    this.happened[s] += mass;
    const folded = draw.riders ?? [];
    const stepped: [string, "hit" | "crit"][] = [];
    for (const { id, slot, on } of this.stepRiders[s]) {
      const mode = stepLanding(on, before[slot], after[slot], draw.outcome);
      if (mode !== null) stepped.push([id, mode]);
    }
    if (folded.length === 0 && stepped.length === 0) return;
    const vulnerable = step.contextVulnerable[context] === true;
    const crit = draw.outcome === "crit";
    for (const [id, payload] of folded) {
      // A rider that lands on anything is no part of the attack's damage: every landing is a hit,
      // never doubled (the engine's `cast` rider).
      const cast = this.cast.has(id);
      this.land(id, step.id, crit && !cast, vulnerable && draw.outcome !== "miss" && !cast, mass);
      if (!this.capped.has(id)) this.weigh(id, payload, mass);
    }
    for (const [id, mode] of stepped) {
      const cast = this.cast.has(id);
      this.land(id, step.id, mode === "crit" && !cast, vulnerable && draw.outcome !== "miss" && !cast, mass);
    }
    const order = this.riderOrder;
    if (order === undefined) return;
    // The riders that land together, in declaration order (the engine's rider order).
    const ids = [...folded.map(([id]) => id), ...stepped.map(([id]) => id)].sort(
      (a, b) => (order.get(a) as number) - (order.get(b) as number)
    );
    let patterns = this.patterns.get(step.id);
    if (patterns === undefined) this.patterns.set(step.id, (patterns = new Map()));
    for (const { label, dealt, share } of branchesOf(draw, this.isSave[s])) {
      const key = `${label}|${dealt}|${ids.join("\u0000")}`;
      const pattern = patterns.get(key);
      if (pattern === undefined) patterns.set(key, { label, dealt, riders: ids, mass: mass * share });
      else pattern.mass += mass * share;
    }
  }

  /** Condition `c` is tried at row `s` on `mass`, and takes on `chance` of it. */
  attempt(s: number, c: number, mass: number, chance: number): void {
    const tally = this.attempts[s].get(c);
    if (tally === undefined) this.attempts[s].set(c, { attempted: mass, taken: mass * chance });
    else {
      tally.attempted += mass;
      tally.taken += mass * chance;
    }
  }

  private land(id: string, row: string, crit: boolean, doubled: boolean, mass: number): void {
    let rows = this.landings.get(id);
    if (rows === undefined) this.landings.set(id, (rows = new Map()));
    let landing = rows.get(row);
    if (landing === undefined) rows.set(row, (landing = { hit: 0, crit: 0, doubled: { hit: 0, crit: 0 } }));
    if (crit) landing.crit += mass;
    else landing.hit += mass;
    if (doubled) {
      if (crit) landing.doubled.crit += mass;
      else landing.doubled.hit += mass;
    }
  }

  private weigh(id: string, payload: PMF, mass: number): void {
    let weights = this.onceWeights.get(id);
    if (weights === undefined) this.onceWeights.set(id, (weights = new Map()));
    weights.set(payload, (weights.get(payload) ?? 0) + mass);
  }
}
