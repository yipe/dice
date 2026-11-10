import { describe, expect, it } from "vitest";
import { d, d6, d8, d20, keepBestDamage, roll, turn, Turn, TurnSpecError } from "../builder";
import type { ContextualSource, RowCheck, RowContext, TurnSpec } from "../builder";
import { Mixture } from "../pmf/mixture";
import { PMF } from "../pmf/pmf";
import { lcgRng } from "../../tests/helpers/lcg";

// `ContextualSource.rerolledUnder`: what a row rolls once the first-hit reroll is spent on it, in
// place of keep-higher of its whole payload. Every expected value is worked out from the parts.

const check: RowCheck = {
  kind: "attack",
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
};

/** `payload` on a hit with odds `p`, else nothing. */
const hits = (payload: PMF, p: number): PMF =>
  Mixture.mix([
    ["hit", payload, p],
    ["missNone", PMF.delta(0), 1 - p],
  ]);

/** The weapon's die, which the reroll rolls twice, and dice it leaves alone. */
const a = d("1d8").toPMF();
const b = d("1d6").toPMF();
const P = 0.55;
/** E[max of two 1d8] = (2·204 − 36) / 64 and E[1d6]: the rerolled payload's mean. */
const REROLLED = 372 / 64 + 3.5;
const PLAIN = 4.5 + 3.5;

/** A row whose reroll keeps the better weapon die only: `maxOf2(a) ⊕ b`. Its own d20 odds are a decoy. */
const pool: ContextualSource = {
  rowCheck: check,
  under: () => hits(a.convolve(b), P),
  rerolledUnder: () => hits(a.maxOfTwo().convolve(b), 0.3),
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TurnSpecError);
    return (error as TurnSpecError).code;
  }
  return undefined;
}

function pmfMaxDiff(actual: PMF, expected: PMF): number {
  let worst = 0;
  for (const value of new Set([...actual.support(), ...expected.support()])) {
    worst = Math.max(worst, Math.abs(actual.pAt(value) - expected.pAt(value)));
  }
  return worst;
}

describe("rerolledUnder: the row's own reroll", () => {
  it("a reroll of maxOf2(a) ⊕ b deals P·(E[maxOf2 a] + E b), at the row's own hit odds", () => {
    const t = turn([pool]).onFirstHit(keepBestDamage());
    expect(t.mean()).toBeCloseTo(P * REROLLED, 12);
    expect(pmfMaxDiff(t.pmf, hits(a.maxOfTwo().convolve(b), P))).toBeLessThan(1e-12);
    // Without a substitute over it the row rolls its plain payload.
    expect(turn([pool]).mean()).toBeCloseTo(P * PLAIN, 12);
  });

  it("is spent once: a later row rolls plain unless every earlier row missed", () => {
    const t = turn([pool, pool]).onFirstHit(keepBestDamage());
    expect(t.mean()).toBeCloseTo(P * REROLLED + P * (P * PLAIN + (1 - P) * REROLLED), 12);
    expect(t.fireProbability("substitute 1")).toBeCloseTo(1 - (1 - P) ** 2, 12);
  });

  it("reads hit and crit apart, each normalised to the row's own odds", () => {
    const H = d("1d6").toPMF();
    const C = d("2d6").toPMF();
    const rerolledHit = d("1d6+10").toPMF();
    const rerolledCrit = d("2d6+20").toPMF();
    const crits: ContextualSource = {
      rowCheck: check,
      under: () =>
        Mixture.mix([
          ["hit", H, 0.5],
          ["crit", C, 0.05],
          ["missNone", PMF.delta(0), 0.45],
        ]),
      rerolledUnder: () =>
        Mixture.mix([
          ["hit", rerolledHit, 0.2],
          ["crit", rerolledCrit, 0.6],
          ["missNone", PMF.delta(0), 0.2],
        ]),
    };
    const t = turn([crits]).onFirstHit(keepBestDamage());
    expect(t.mean()).toBeCloseTo(0.5 * 13.5 + 0.05 * 27, 12);
    expect(t.marginal("attack 1").pmf.filterOutcome("crit").mass()).toBeCloseTo(0.05, 12);
  });

  it("is asked in the row's context, as under() is", () => {
    // Attack 1 lands 0.4 and gives attack 2 advantage: 0.75 to land there, else 0.5.
    const opener: ContextualSource = { rowCheck: { ...check, pinned: true }, under: () => hits(PMF.delta(5), 0.4) };
    const asked: string[] = [];
    const follow: ContextualSource = {
      rowCheck: check,
      under: (context) => hits(PMF.delta(1), context.rollType === "advantage" ? 0.75 : 0.5),
      rerolledUnder: (context: RowContext) => {
        asked.push(context.rollType);
        return hits(PMF.delta(context.rollType === "advantage" ? 100 : 10), 0.5);
      },
    };
    const t = Turn.from({
      attacks: [
        { id: "opener", source: opener },
        { id: "follow", source: follow },
      ],
      conditions: [{ id: "vex", on: "first-hit", of: ["opener"], grants: [{ advantage: true, until: "next-attack" }] }],
      substitutes: [{ id: "reroll", on: "first-hit", substitute: "reroll-keep-higher", of: ["follow"] }],
    });
    expect(t.mean()).toBeCloseTo(0.4 * 5 + 0.4 * 0.75 * 100 + 0.6 * 0.5 * 10, 12);
    expect([...new Set(asked)].sort()).toStrictEqual(["advantage", "flat"]);
  });

  it("keeps the dice a rider joins in its row (Savage Attacker over a Sneak Attack pool)", () => {
    const sword = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3));
    const pooled = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3).plus(3, d6));
    const savaged = d20.plus(5).ac(15).onHit(roll(1, d8).maxOf(2).plus(3).plus(3, d6));
    const savagedSword = d20.plus(5).ac(15).onHit(roll(1, d8).maxOf(2).plus(3));
    const row: ContextualSource = {
      rowCheck: check,
      under: (context) => (context.joined.includes("sa") ? pooled : sword).under(context),
      rerolledUnder: (context) => (context.joined.includes("sa") ? savaged : savagedSword).under(context),
    };
    const t = Turn.from({
      attacks: [
        { id: "a", source: row },
        { id: "b", source: row },
      ],
      riders: [{ id: "sa", on: "first-hit", damage: roll(3, d6), joins: ["a", "b"] }],
      substitutes: [{ id: "savage", on: "first-hit", substitute: "reroll-keep-higher" }],
    });
    // The first landing rolls the pool and the reroll together; a landing after it rolls the plain sword.
    const lands = sword.toPMF().filterOutcome("hit").mass() + sword.toPMF().filterOutcome("crit").mass();
    const first = savaged.toPMF().mean();
    expect(t.mean()).toBeCloseTo(first + (1 - lands) * first + lands * sword.toPMF().mean(), 10);
  });
});

describe("rerolledUnder: refusals", () => {
  const spec = (extra: Partial<TurnSpec> = {}): TurnSpec => ({
    attacks: [{ id: "a", source: pool }],
    substitutes: [{ id: "savage", on: "first-hit", substitute: "reroll-keep-higher" }],
    ...extra,
  });

  it("a below policy over a source with rerolledUnder is unsupported-policy", () => {
    const below = spec({
      substitutes: [{ id: "savage", on: "first-hit", substitute: "reroll-keep-higher", policy: { kind: "below", hit: 8, crit: 16 } }],
    });
    expect(codeOf(() => Turn.from(below))).toBe("unsupported-policy");
    expect(codeOf(() => turn([pool]).onFirstHit(keepBestDamage().ifBelow({ hit: 8, crit: 16 })))).toBe("unsupported-policy");
    // The same policy over a source that does not say stays as it was.
    const plain: ContextualSource = { rowCheck: check, under: pool.under };
    expect(codeOf(() => turn([plain]).onFirstHit(keepBestDamage().ifBelow({ hit: 8, crit: 16 })))).toBeUndefined();
  });

  it("a dice-match rider over it is unsupported-trigger", () => {
    const orb = d20.plus(7).ac(15).onHit(roll(3, d8));
    const matchable: ContextualSource & Pick<typeof orb, "diceMatchInfo"> = {
      rowCheck: orb.rowCheck,
      under: (context) => orb.under(context),
      diceMatchInfo: (eps) => orb.diceMatchInfo(eps),
      rerolledUnder: (context) => orb.under(context),
    };
    const matched = spec({
      attacks: [{ id: "a", source: matchable }],
      riders: [{ id: "bounce", on: "dice-match", of: ["a"], damage: roll(1, 6) }],
    });
    expect(codeOf(() => Turn.from(matched))).toBe("unsupported-trigger");
  });

  it("a rerolledUnder() that returns no PMF, or no PMF for a landing the row makes, is not-an-attack", () => {
    const notPmf: ContextualSource = { ...pool, rerolledUnder: () => 3 as unknown as PMF };
    expect(codeOf(() => turn([notPmf]).onFirstHit(keepBestDamage()))).toBe("not-an-attack");
    const neverHits: ContextualSource = { ...pool, rerolledUnder: () => hits(PMF.delta(1), 0) };
    expect(codeOf(() => turn([neverHits]).onFirstHit(keepBestDamage()))).toBe("not-an-attack");
  });

  it("is never asked without a substitute over the row", () => {
    const loud: ContextualSource = {
      ...pool,
      rerolledUnder: () => {
        throw new Error("asked");
      },
    };
    expect(turn([loud]).mean()).toBeCloseTo(P * PLAIN, 12);
  });
});

describe("rerolledUnder: Turn.sample", () => {
  it("draws a spent row's damage from the reroll, the first roll's damage dice not kept", () => {
    const sword = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3));
    const boosted = d20.plus(5).ac(15).onHit(roll(1, d8).plus(103));
    const row: ContextualSource = {
      rowCheck: sword.rowCheck,
      under: (context) => sword.under(context),
      rollUnder: (context) => sword.rollUnder(context),
      rerolledUnder: (context) => boosted.under(context),
    };
    const t = turn([row, row]).onFirstHit(keepBestDamage());
    const rng = lcgRng(7);
    let spentRows = 0;
    for (let i = 0; i < 2000; i++) {
      const [wave] = t.sample(rng).waves;
      const landed = wave.outcomes.filter((each) => each.result === "hit" || each.result === "crit");
      if (landed.length === 0) continue;
      spentRows++;
      // The first landing is the rerolled one: its damage is the boosted payload's.
      expect(landed[0].damage).toBeGreaterThanOrEqual(104);
      for (const later of landed.slice(1)) expect(later.damage).toBeLessThan(104);
      const firstDamage = wave.dice.filter((die) => die.source === landed[0].source && die.role !== "attack");
      expect(firstDamage.every((die) => !die.kept)).toBe(true);
    }
    expect(spentRows).toBeGreaterThan(0);
  });
});

describe("docs/guide.md: a row that says what its reroll rolls", () => {
  it("quotes the right means", () => {
    const sword = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3).plus(2, d6));
    const savaged = d20.plus(5).ac(15).onHit(roll(1, d8).maxOf(2).plus(3).plus(2, d6));
    const row: ContextualSource = {
      rowCheck: sword.rowCheck,
      under: (context) => sword.under(context),
      rerolledUnder: (context) => savaged.under(context),
    };
    expect(turn([sword, sword]).onFirstHit(keepBestDamage()).mean()).toBeCloseTo(18.6634, 4);
    expect(turn([row, row]).onFirstHit(keepBestDamage()).mean()).toBeCloseTo(18.1854, 4);
  });
});
