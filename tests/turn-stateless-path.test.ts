/**
 * The stateless path: a turn with no rider, substitute, condition, probe or gate builds no plan
 * and walks nothing; every reader is a closed form of its rows. This proves, on seeded random
 * turns, that every reader reads what the forced full walk reads (`walkEverything`), and that
 * a malformed stateless spec fails with the same error on both paths.
 *
 * Tolerance: `whenHappens` is the same PMF object on both paths, and `pmf`, `mean` and
 * `toQuery` come from the same joint walk, so they are bit-exact. `occurs`, `rolled`, `hit`,
 * `crit` and the marginal `pmf` are compared at 1e-12 relative: the walk reads them as masses
 * divided by its terminal mass, which drifts from 1 by an ulp or two as the slice masses of each
 * row are summed, while the stateless path reports the row's `chance` itself. For the same
 * reason the walk's marginal of a row with chance 1 can carry a `missNone` bin at 0 of ulp mass
 * (its `occurs` came out a hair under 1); the stateless path has no such bin, as the engine has
 * none, so a marginal is compared as a function (a bin absent on one side is mass 0).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d, d20, d4, d6, d8, flat, roll } from "../src/builder";
import { PMF } from "../src/pmf/pmf";
import { inspectPlan, Turn, walkEverything, type AttackMarginal } from "../src/turn/turn";
import { TurnSpecError, type Attack, type RowContext, type Source, type TurnSpec } from "../src/turn/types";
import type { RollType } from "../src/common/types";

/** A seeded generator (mulberry32), so a failure names its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, options: readonly T[]): T => options[Math.floor(random() * options.length)] as T;
const int = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;

/** One random row source: an attack, a save, a row that always lands, a bare PMF, a parsed string, or a contextual wrapper. */
function randomSource(random: () => number): Source {
  const damage = pick(random, [d8.plus(4), roll(2, d6), d4, flat(5), d6.plus(int(random, -3, 3))]);
  const kind = random();
  if (kind < 0.4) {
    let check = d20.plus(int(random, 0, 12)).ac(int(random, 8, 30));
    if (random() < 0.3) check = check.critOn(19);
    if (random() < 0.3) check = pick(random, [check.melee(), check.ranged()]);
    let attack = check.onHit(damage);
    if (random() < 0.2) attack = attack.onMiss(flat(2));
    return attack;
  }
  if (kind < 0.5) {
    const own = pick(random, [d20.withAdvantage(), d20.withDisadvantage(), d20.withElvenAccuracy()]).plus(int(random, 0, 8));
    return own.ac(int(random, 10, 25)).onHit(damage);
  }
  if (kind < 0.65) {
    const save = d20.plus(int(random, 0, 8)).dc(int(random, 10, 20)).ability(pick(random, ABILITIES)).onSaveFailure(damage);
    return random() < 0.5 ? save.saveHalf() : save;
  }
  if (kind < 0.75) return d20.alwaysHits().onHit(damage);
  if (kind < 0.85) return d20.plus(5).ac(15).onHit(damage).toPMF();
  if (kind < 0.92) return d(pick(random, ["1d20 + 5 AC 15 * 1d8 + 3", "2d6", "1d20 + 2 AC 12 * 2d6"]));
  const builder = d20.plus(int(random, 0, 10)).ac(int(random, 10, 25)).onHit(damage);
  return { rowCheck: builder.rowCheck, under: (context: RowContext) => builder.under(context) };
}

/** A random stateless spec: 1 to 6 rows, some with a chance, an id, a tag or a target. */
function randomSpec(random: () => number): TurnSpec {
  const count = int(random, 1, 6);
  const attacks: Attack[] = [];
  const sources: Source[] = [];
  for (let i = 0; i < count; i++) {
    // One source declared as several rows resolves once: reuse an earlier one now and then.
    const source = random() < 0.2 && sources.length > 0 ? (sources[0] as Source) : randomSource(random);
    sources.push(source);
    if (random() < 0.15) {
      attacks.push(source);
      continue;
    }
    attacks.push({
      source,
      ...(random() < 0.8 ? { id: `r${i}` } : {}),
      ...(random() < 0.5 ? { chance: pick(random, [0, 0.25, 0.5, random(), 1]) } : {}),
      ...(random() < 0.2 ? { tag: pick(random, ["main", "off"]) } : {}),
      ...(random() < 0.2 ? { target: pick(random, ["target", "second"]) } : {}),
    });
  }
  return { attacks, ...(random() < 0.2 ? { stateLimit: int(random, 1, 100) } : {}) };
}

/** Builds `spec` on the forced full walk. */
function walked(spec: TurnSpec): Turn {
  walkEverything.forced = true;
  try {
    return Turn.from(spec);
  } finally {
    walkEverything.forced = false;
  }
}

const TOLERANCE = 1e-12;
const observed = { maxRelative: 0, exact: 0, compared: 0 };

function expectClose(fast: number, slow: number, what: string): void {
  const relative = Math.abs(fast - slow) / Math.max(1, Math.abs(slow));
  observed.compared++;
  if (relative === 0) observed.exact++;
  observed.maxRelative = Math.max(observed.maxRelative, relative);
  expect(relative, what).toBeLessThanOrEqual(TOLERANCE);
}

function expectPmfClose(fast: PMF, slow: PMF, what: string): void {
  const values = new Set([...fast.map.keys(), ...slow.map.keys()]);
  const empty = { p: 0, count: {} as Record<string, number> };
  for (const value of values) {
    const a = fast.map.get(value) ?? empty;
    const b = slow.map.get(value) ?? empty;
    expectClose(a.p, b.p, `${what} p(${value})`);
    for (const label of new Set([...Object.keys(a.count), ...Object.keys(b.count)])) {
      expectClose(a.count[label] ?? 0, b.count[label] ?? 0, `${what} ${label}(${value})`);
    }
  }
}

/** The error `build` throws, as what a consumer compares: its class, code and message. */
function failure(build: () => unknown): { name: string; code?: string; message: string } | undefined {
  try {
    build();
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { name: error.name, message: error.message, ...(error instanceof TurnSpecError ? { code: error.code } : {}) };
  }
}

describe("the stateless path reads what the full walk reads", () => {
  beforeAll(() => {
    walkEverything.forced = false;
  });
  afterAll(() => {
    console.info("stateless path vs walk:", JSON.stringify(observed));
  });

  const SEEDS = Array.from({ length: 600 }, (_, i) => 1000 + i);

  it.each(SEEDS)("seed %i", (seed) => {
    const spec = randomSpec(rng(seed));
    const fast = Turn.from(spec);
    const slow = walked(spec);

    expect(fast.attackIds).toEqual(slow.attackIds);
    expect(fast.riderIds).toEqual(slow.riderIds);
    expect(fast.substituteIds).toEqual(slow.substituteIds);
    expect(fast.conditionIds).toEqual(slow.conditionIds);
    expect(fast.probeIds).toEqual(slow.probeIds);
    expect(fast.peakStates).toBe(slow.peakStates);

    for (const id of slow.attackIds) {
      const a = fast.marginal(id) as AttackMarginal;
      const b = slow.marginal(id) as AttackMarginal;
      expect(a.whenHappens, `${id} whenHappens`).toBe(b.whenHappens);
      expectClose(a.occurs, b.occurs, `${id} occurs`);
      expectPmfClose(a.pmf, b.pmf, `${id} marginal pmf`);
      expect(Object.keys(a.rollType).sort()).toEqual(Object.keys(b.rollType).sort());
      for (const type of Object.keys(b.rollType) as RollType[]) expectClose(a.rollType[type], b.rollType[type], `${id} rollType ${type}`);

      const s = fast.stepStats(id);
      const t = slow.stepStats(id);
      expectClose(s.rolled, t.rolled, `${id} rolled`);
      expectClose(s.hit, t.hit, `${id} hit`);
      expectClose(s.crit, t.crit, `${id} crit`);
      expect({ ...s.live, sources: undefined }).toEqual({ ...t.live, sources: undefined });
      expect(s.live.sources).toEqual(t.live.sources);
      expect(s.conditions).toEqual(t.conditions);

      // Landings and the joint readers walk the plan on both paths: the same numbers to the bit.
      expect(fast.landings(id)).toEqual(slow.landings(id));
    }
    expect(fast.pmf.toString()).toBe(slow.pmf.toString());
    expect(fast.mean()).toBe(slow.mean());
    expect(fast.toQuery().singles.map((single) => single.toString())).toEqual(slow.toQuery().singles.map((single) => single.toString()));

    // Unknown ids fail the same way on both paths.
    for (const read of ["marginal", "stepStats", "fireProbability", "expectedApplications", "attemptProbability", "landings"] as const) {
      expect(failure(() => fast[read]("nobody")), read).toEqual(failure(() => slow[read]("nobody")));
    }
    expect(inspectPlan(fast).attackIds).toEqual(slow.attackIds);
  });
});

describe("a malformed stateless spec fails the same way on both paths", () => {
  const sword = d20.plus(5).ac(15).onHit(d8);
  const malformed: Record<string, TurnSpec> = {
    "unknown key": { attacks: [{ source: sword, bogus: 1 } as unknown as Attack] },
    "non-string id": { attacks: [{ source: sword, id: 3 } as unknown as Attack] },
    "non-string tag": { attacks: [{ source: sword, tag: 3 } as unknown as Attack] },
    "non-string target": { attacks: [{ source: sword, target: 3 } as unknown as Attack] },
    "duplicate id": { attacks: [{ source: sword, id: "a" }, { source: sword, id: "a" }] },
    "duplicate default id": { attacks: [sword, { source: sword, id: "attack 1" }] },
    "chance above 1": { attacks: [{ source: sword, chance: 1.5 }] },
    "chance NaN": { attacks: [{ source: sword, chance: Number.NaN }] },
    "not an attack": { attacks: [{ source: { not: "a source" } as unknown as Source }] },
    "a wrapper without a source": { attacks: [{ id: "a" } as unknown as Attack] },
    "toPMF returns no PMF": { attacks: [{ toPMF: () => 7 } as unknown as Source] },
    "under returns no PMF": { attacks: [{ rowCheck: sword.rowCheck, under: () => 7 } as unknown as Source] },
    "stateLimit 0": { attacks: [sword], stateLimit: 0 },
    "stateLimit fractional": { attacks: [sword], stateLimit: 1.5 },
    "second error after a valid row": { attacks: [sword, { source: sword, chance: -1 }, { source: sword, id: 3 } as unknown as Attack] },
  };

  it.each(Object.keys(malformed))("%s", (name) => {
    const spec = malformed[name] as TurnSpec;
    const fast = failure(() => Turn.from(spec));
    expect(fast).toBeDefined();
    expect(fast).toEqual(failure(() => walked(spec)));
  });

  it("an empty turn reads on both paths alike", () => {
    const fast = Turn.from({ attacks: [] });
    const slow = walked({ attacks: [] });
    expect(fast.attackIds).toEqual([]);
    expect(fast.peakStates).toBe(slow.peakStates);
    expect(fast.pmf.toString()).toBe(slow.pmf.toString());
    expect(failure(() => fast.marginal("a"))).toEqual(failure(() => slow.marginal("a")));
  });
});
