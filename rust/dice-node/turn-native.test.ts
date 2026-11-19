// Compares the Rust turn engine (facade `ts/turn/turn.ts` over `NativeTurn`) with the TS engine
// on the same specs. Run: DICE_ENGINE=ts yarn vitest run -c rust/dice-node/vitest.rust.config.ts rust/dice-node/turn-native.test.ts
import { describe, expect, it } from "vitest";
import { TurnSpecError } from "../../src/turn/types";
import * as tsTurn from "../../src/turn/turn";
import * as tsFactory from "../../src/builder/factory";
import * as tsEffects from "../../src/turn/effects";
import * as tsContext from "../../src/turn/context";
import * as rsTurn from "./ts/turn/turn";
import * as rsFactory from "./ts/builder/factory";
import * as rsEffects from "./ts/turn/effects";

/** The two engines are driven through one untyped harness; `Dyn` is the only place the types are given up. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dyn = any;
type Lib = { turn: Dyn; Turn: Dyn; bounce: Dyn; f: Dyn; e: Dyn; IGNORES_JOINED: symbol };
const ts: Lib = { turn: tsTurn.turn, Turn: tsTurn.Turn, bounce: tsTurn.bounce, f: tsFactory, e: tsEffects, IGNORES_JOINED: tsContext.IGNORES_JOINED };
const rs: Lib = { turn: rsTurn.turn, Turn: rsTurn.Turn, bounce: rsTurn.bounce, f: rsFactory, e: rsEffects, IGNORES_JOINED: tsContext.IGNORES_JOINED };

function lcg(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return { die: (n: number) => 1 + Math.floor(next() * n), chance: (p: number) => next() < p };
}

/** A value with PMFs, Maps and nested data as comparable plain data. */
function norm(x: Dyn): Dyn {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(norm);
  if (x instanceof Map) return [...x].map(([k, v]) => [k, norm(v)]);
  if (typeof x.support === "function" && typeof x.pAt === "function") {
    return { pmf: x.support().map((k: number) => [k, x.pAt(k)]) };
  }
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, norm(v)]));
}

function close(a: Dyn, b: Dyn, path = "$"): void {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    expect(Math.abs(a - b), `${path}: ${a} vs ${b}`).toBeLessThanOrEqual(1e-9);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length, `${path} length`).toBe(b.length);
    a.forEach((x, i) => close(x, b[i], `${path}[${i}]`));
    return;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    expect(Object.keys(a).sort(), `${path} keys`).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  expect(a, path).toEqual(b);
}

function attackOf(lib: Lib, bonus = 8, ac = 14) {
  const { d20, d6, d8 } = lib.f;
  return { sword: d20.plus(bonus).ac(ac).melee().onHit(d8.plus(3)), bow: d20.plus(bonus - 2).ac(ac).ranged().onHit(d6) };
}

type Make = (lib: Lib) => Dyn;

const cases: Record<string, Make> = {
  "sneak attack": (lib) => {
    const { sword } = attackOf(lib);
    return lib.turn([sword, sword]).onFirstHit(lib.f.roll(3, lib.f.d6), { id: "sneak" });
  },
  "hand-written toPMF rider": (lib) => {
    const { sword } = attackOf(lib);
    // A class instance: `encode` sends it as a ref (a plain literal would be walked as JSON).
    class HandWritten {
      toPMF(eps: number) {
        return lib.f.d6.toPMF(eps);
      }
    }
    const handWritten = new HandWritten();
    return lib.turn([sword, sword, sword]).onEveryHit(handWritten, { max: 2 });
  },
  "failChance gate": (lib) => {
    const { sword } = attackOf(lib);
    const failChance = (ctx: Dyn) => (ctx.rollType === "disadvantage" ? 0.8 : 0.5);
    return lib.turn([sword, sword, sword]).onEveryHit(lib.e.advantage().untilNextAttack(), { save: { failChance } });
  },
  "DC check gate and condition": (lib) => {
    const { sword } = attackOf(lib);
    const dc = lib.f.d20.plus(2).dc(14);
    return lib
      .turn([sword, sword])
      .onFirstHit(lib.e.save(dc, { fail: [lib.e.advantage().untilEndOfTurn()] }))
      .onAnyCrit(lib.f.roll(2, lib.f.d8));
  },
  "hand-written contextual source": (lib) => {
    const { sword } = attackOf(lib);
    const own = lib.f.d20.plus(5).ac(13).onHit(lib.f.d10);
    class Contextual {
      rowCheck = own.rowCheck;
      under(context: Dyn, eps: number) {
        return own.under(context, eps);
      }
    }
    const contextual = new Contextual();
    return lib
      .turn([sword, contextual])
      .onFirstHit(lib.e.advantage().untilNextAttack(), { chance: 0.5 })
      .onAnyMiss(lib.f.d6);
  },
  "spec with substitutes, probes and conditions": (lib) => {
    const { sword, bow } = attackOf(lib);
    return lib.Turn.from(
      {
        attacks: [{ id: "a", source: sword }, { id: "b", source: bow, tag: "ranged" }, sword],
        riders: [{ on: "first-hit", damage: lib.f.d6, id: "r" }, { on: "every-hit", of: ["ranged"], damage: [lib.f.d4, lib.f.d4], max: 1 }],
        substitutes: [{ on: "first-miss", substitute: "reroll", of: ["a"] }],
        conditions: [{ on: "every-hit", grants: [{ advantage: true, until: "next-attack" }], chance: 0.4 }],
        observe: [{ on: "any-crit", id: "crit" }],
      },
      0
    );
  },
  "chained verbs": (lib) => {
    const { sword } = attackOf(lib);
    return lib
      .turn()
      .attacks(3, sword, { tag: "swing" })
      .onFirstHit(lib.e.keepBestDamage())
      .onFirstHit(lib.f.d6, { id: "sneak", of: "swing" })
      .otherwise(lib.f.d4)
      .rerollFirstMiss()
      .observeAnyCrit("crit")
      .vsAC(16);
  },

  "plain-literal hand-written source and payload": (lib) => {
    const { sword } = attackOf(lib);
    const own = lib.f.d20.plus(5).ac(13).onHit(lib.f.d10);
    const contextual = {
      rowCheck: own.rowCheck,
      under: (context: Dyn, eps: number) => own.under(context, eps),
      rerolledUnder: (context: Dyn, eps: number) => own.under(context, eps).maxOfTwo?.() ?? own.under(context, eps),
      [lib.IGNORES_JOINED]: true,
    };
    const payload = {
      at: () => ({ onHit: lib.f.d6.toPMF(), onCrit: lib.f.roll(2, lib.f.d6).toPMF(), vulnerable: { onHit: lib.f.roll(2, lib.f.d6).toPMF(), onCrit: lib.f.roll(4, lib.f.d6).toPMF() } }),
    };
    return lib.turn([sword, contextual]).rider({ on: "first-hit", damage: payload, id: "ctx" }).onFirstHit(lib.e.keepBestDamage());
  },
  "save gated pass effects": (lib) => {
    const { sword } = attackOf(lib);
    const dc = lib.f.d20.plus(1).dc(13);
    return lib
      .turn([sword, sword, sword])
      .onEveryHit(lib.e.save(dc, { fail: [lib.e.advantage().untilNextAttack()], pass: [lib.e.disadvantage().untilNextAttack()] }));
  },
  "perSource and critDamage": (lib) => {
    const { sword, bow } = attackOf(lib);
    return lib
      .turn([{ id: "s", source: sword }, { id: "b", source: bow }])
      .onFirstHit(lib.f.d6, { perSource: { b: { damage: lib.f.d8, critDamage: lib.f.roll(3, lib.f.d8) } }, critDamage: lib.f.roll(2, lib.f.d4) });
  },
  "dealing is joint-unsupported": (lib) => {
    const sword = lib.f.d20.plus(8).ac(14).melee().onHit(lib.f.d8).typed("fire");
    return lib.Turn.from({
      attacks: [sword],
      conditions: [{ on: "every-hit", dealing: "fire", grants: [{ advantage: true, until: "end-of-turn" }] }],
    });
  },
  bounce: (lib) => lib.bounce({ source: lib.f.d20.plus(5).ac(10).onHit(lib.f.roll(2, lib.f.d6)), max: 3 }),
  "starting conditions": (lib) => {
    const { sword } = attackOf(lib);
    const restrained = lib.e.condition("restrained", { attack: { melee: ["advantage"], ranged: ["disadvantage"] } });
    return lib.turn([sword, sword]).atStart(restrained.untilEndOfTurn(), { target: "target" });
  },
};

function readAll(t: Dyn, label: string): Record<string, Dyn> {
  const out: Record<string, Dyn> = {};
  const note = (key: string, f: () => Dyn) => {
    try {
      out[key] = norm(f());
    } catch (e) {
      out[key] = { threw: (e as Error).constructor.name + ":" + (e as TurnSpecError).code + ":" + (e as TurnSpecError).id + ":" + (e as Error).message };
    }
  };
  note("pmf", () => t.pmf);
  note("mean", () => t.mean());
  note("attackIds", () => t.attackIds);
  note("riderIds", () => t.riderIds);
  note("substituteIds", () => t.substituteIds);
  note("conditionIds", () => t.conditionIds);
  note("probeIds", () => t.probeIds);
  note("peakStates", () => t.peakStates);
  const ids = [...t.attackIds, ...t.riderIds];
  for (const id of ids) {
    note(`marginal ${id}`, () => t.marginal(id));
    note(`fire ${id}`, () => t.fireProbability(id));
    note(`apps ${id}`, () => t.expectedApplications(id));
    note(`stats ${id}`, () => t.stepStats(id));
    note(`landings ${id}`, () => t.landings(id));
  }
  for (const id of t.probeIds) note(`probe ${id}`, () => t.fireProbability(id));
  for (const id of t.conditionIds) note(`attempt ${id}`, () => t.attemptProbability(id));
  note("sample", () => t.sample(lcg(7)));
  note("sample 2", () => t.sample(lcg(99)));
  note("query", () => {
    const q = t.toQuery();
    return [q.mean(), q.singles?.length ?? null];
  });
  note("missing id", () => t.marginal("no such id"));
  void label;
  return out;
}

describe("Rust turn engine equals the TS engine", () => {
  for (const [name, make] of Object.entries(cases)) {
    it(name, () => {
      const expected = readAll(make(ts), name);
      const actual = readAll(make(rs), name);
      close(actual, expected);
    });
  }
});

describe("errors", () => {
  it("TurnSpecError carries code and id", () => {
    const { sword } = attackOf(rs);
    const t = rs.turn([sword]);
    let error: Dyn;
    try {
      t.onFirstHit(rs.f.d6, { of: "nope" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TurnSpecError);
    expect(error.code).toBe("unknown-id");
    let expected: Dyn;
    try {
      ts.turn([attackOf(ts).sword]).onFirstHit(ts.f.d6, { of: "nope" });
    } catch (e) {
      expected = e;
    }
    expect(error.id).toBe(expected.id);
    expect(error.message).toBe(expected.message);
  });

  it("RangeError", () => {
    const { sword } = attackOf(rs);
    expect(() => rs.turn().attacks(0, sword)).toThrow(RangeError);
    expect(() => rs.turn([sword]).vsAC(Number.NaN)).toThrow(RangeError);
  });

  it("a throw inside failChance surfaces unchanged, from the call that ran it", () => {
    const { sword } = attackOf(rs);
    const boom = new Error("boom");
    const t = rs.turn([sword, sword]).onEveryHit(rs.e.advantage().untilNextAttack(), {
      save: {
        failChance: () => {
          throw boom;
        },
      },
    });
    let caught: unknown;
    try {
      t.mean();
    } catch (e) {
      caught = e;
    }
    // The gate may be evaluated while building (the turn is validated then) or lazily; either way the very error.
    if (caught === undefined) {
      try {
        t.pmf;
      } catch (e) {
        caught = e;
      }
    }
    expect(caught).toBe(boom);
  });

  it("a throw inside an rng surfaces unchanged", () => {
    const { sword } = attackOf(rs);
    const boom = new Error("rng");
    const t = rs.turn([sword]);
    expect(() =>
      t.sample({
        die: () => {
          throw boom;
        },
        chance: () => true,
      })
    ).toThrow(boom);
  });

  it("a hand-written toPMF that returns a non-PMF is not-an-attack", () => {
    const { sword } = attackOf(rs);
    let error: Dyn;
    try {
      class Bad {
        toPMF() {
          return 5;
        }
      }
      rs.turn([sword]).onFirstHit(new Bad() as Dyn).mean();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TurnSpecError);
    expect(error.code).toBe("not-an-attack");
  });
});

describe("spec errors match the TS engine", () => {
  const specs: Record<string, (lib: Lib) => unknown> = {
    "unknown key": (lib) => lib.turn([{ source: attackOf(lib).sword, bogus: 1 }]),
    "non-string id": (lib) => lib.turn([{ source: attackOf(lib).sword, id: 5 }]),
    "duplicate id": (lib) => lib.turn([{ id: "x", source: attackOf(lib).sword }, { id: "x", source: attackOf(lib).sword }]),
    "no source": (lib) => lib.turn([{ id: "x" }]),
    "bad chance": (lib) => lib.turn([{ source: attackOf(lib).sword, chance: 2 }]),
    "attack after rider": (lib) => lib.turn([attackOf(lib).sword]).onFirstHit(lib.f.d6).attack(attackOf(lib).sword),
    "cycle-ish unknown of": (lib) => lib.Turn.from({ attacks: [attackOf(lib).sword], riders: [{ on: "first-hit", of: ["zz"], damage: lib.f.d6 }] }),
    "state limit": (lib) => lib.turn([attackOf(lib).sword]).stateLimit(0),
    "dice-match no descriptor": (lib) => lib.turn([lib.f.d6.toPMF()]).onDiceMatch(["attack 1"], lib.f.d6),
  };
  const outcome = (make: () => unknown) => {
    try {
      make();
      return "ok";
    } catch (e) {
      const err = e as TurnSpecError;
      return `${err.constructor.name}|${err.code}|${err.id}|${err.message}`;
    }
  };
  for (const [name, make] of Object.entries(specs)) {
    it(name, () => {
      expect(outcome(() => make(rs))).toBe(outcome(() => make(ts)));
    });
  }
});

describe("lifetime", () => {
  it("many turns holding JS functions build, read and collect", () => {
    const { sword } = attackOf(rs);
    let total = 0;
    for (let i = 0; i < 3000; i++) {
      const t = rs.turn([sword, sword]).onEveryHit(rs.e.advantage().untilNextAttack(), { save: { failChance: () => 0.5 } });
      total += t.mean();
    }
    expect(Number.isFinite(total)).toBe(true);
  });
});
