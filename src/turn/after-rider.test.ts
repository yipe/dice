import { describe, expect, it } from "vitest";
import { d20, flat, roll, turn, Turn, TurnSpecError } from "../builder";
import type { AttackMarginal, Rider, Source, TurnSpec } from "../builder";
import type { PMF } from "../pmf/pmf";
import { lcgRng } from "../../tests/helpers/lcg";

// `d20+5` against AC 14 lands on a roll of 9 or more: 0.6 (a natural 20 is the 0.05 of it that crits).
// Flat damage, so a crit adds nothing and every landing deals 2.
const P = 0.6;
const swing = d20.plus(5).ac(14).onHit(flat(2));
// The same landing odds with dice a `dice-match` rider can read.
const diced = d20.plus(5).ac(14).onHit(roll(2, 6));

const row = (id: string, source: Source = swing) => ({ source, id });
/** Wails from the Grave: an auto-hit 1d6 straight after the rider's damage, never without it. */
const wails = (after: { of: string; landing: "hit" | "damage" | "any" } = { of: "sneak", landing: "damage" }) => ({
  source: roll(1, 6),
  id: "wails",
  after,
});
const sneak = (of: readonly string[] = ["a", "b"]): Rider => ({ id: "sneak", on: "first-hit", of, damage: flat(10) });

/** P(the row happens): `chance`, its gate and its parent's landing. */
const occurs = (t: Turn, id: string): number => (t.marginal(id) as AttackMarginal).occurs;

function maxDiff(a: PMF, b: PMF): number {
  let worst = 0;
  for (const value of new Set([...a.support(), ...b.support()])) {
    worst = Math.max(worst, Math.abs(a.pAt(value) - b.pAt(value)));
  }
  return worst;
}

function codeOf(fn: () => unknown): { code: string; message: string } | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TurnSpecError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

describe("an attack gated on a rider (`after.of` names a rider)", () => {
  const open = 1 - (1 - P) * (1 - P);
  const spec = (): TurnSpec => ({ attacks: [row("a"), row("b"), wails()], riders: [sneak()] });

  it("opens where any of the rider's attacks landed, not where the first one did", () => {
    const t = Turn.from(spec());
    expect(t.fireProbability("sneak")).toBeCloseTo(open, 12);
    expect(occurs(t, "wails")).toBeCloseTo(open, 12);
    // E = P(Sneak Attack fired) * 3.5 = (1 - 0.4 * 0.4) * 3.5 = 2.94.
    expect(t.marginal("wails").pmf.mean()).toBeCloseTo(2.94, 9);
    expect(t.mean()).toBeCloseTo(2 * 2 * P + open * 10 + 2.94, 9);
  });

  it("is the exact joint of the attacks, the rider and the gated row", () => {
    const reference = new Map<number, number>();
    const add = (total: number, p: number): void => void reference.set(total, (reference.get(total) ?? 0) + p);
    for (const a of [0, 1]) {
      for (const b of [0, 1]) {
        const p = (a ? P : 1 - P) * (b ? P : 1 - P);
        const base = 2 * (a + b);
        if (a + b === 0) add(base, p);
        else for (let face = 1; face <= 6; face++) add(base + 10 + face, p / 6);
      }
    }
    const { pmf } = Turn.from(spec());
    for (const value of new Set([...reference.keys(), ...pmf.support()])) {
      expect(pmf.pAt(value)).toBeCloseTo(reference.get(value) ?? 0, 12);
    }
  });

  it("reads 'hit', 'damage' and 'any' alike: the rider fired", () => {
    const pmfs = (["hit", "damage", "any"] as const).map(
      (landing) => Turn.from({ ...spec(), attacks: [row("a"), row("b"), wails({ of: "sneak", landing })] }).pmf
    );
    expect(maxDiff(pmfs[0], pmfs[1])).toBe(0);
    expect(maxDiff(pmfs[0], pmfs[2])).toBe(0);
  });

  it("lands 0 when the rider cannot fire", () => {
    const never = Turn.from({
      attacks: [{ ...row("a"), chance: 0 }, { ...row("b"), chance: 0 }, wails()],
      riders: [sneak()],
    });
    expect(never.fireProbability("sneak")).toBe(0);
    expect(occurs(never, "wails")).toBe(0);
    expect(never.marginal("wails").pmf.mean()).toBe(0);
    expect(never.pmf.pAt(0)).toBeCloseTo(1, 12);
    // Two attacks that land on a natural 20 only: 1 - 0.95 * 0.95.
    const rare = d20.plus(5).ac(30).onHit(flat(2));
    const t = Turn.from({ attacks: [row("a", rare), row("b", rare), wails()], riders: [sneak()] });
    expect(t.marginal("wails").pmf.mean()).toBeCloseTo((1 - 0.95 * 0.95) * 3.5, 9);
  });

  it("is an event, not a count: a rider capped at one landing never opens the row more than once", () => {
    const capped = Turn.from({
      attacks: [row("a"), row("b"), row("c"), wails()],
      riders: [{ id: "sneak", on: "every-hit", of: ["a", "b", "c"], max: 1, damage: flat(10) }],
    });
    const closed = 1 - (1 - P) ** 3;
    expect(occurs(capped, "wails")).toBeLessThanOrEqual(1);
    expect(occurs(capped, "wails")).toBeCloseTo(closed, 12);
    expect(capped.marginal("wails").pmf.mean()).toBeCloseTo(closed * 3.5, 9);
    // `max: 1` IS first-hit, and so is its gate.
    const first = Turn.from({
      attacks: [row("a"), row("b"), row("c"), wails()],
      riders: [{ id: "sneak", on: "first-hit", of: ["a", "b", "c"], damage: flat(10) }],
    });
    expect(maxDiff(capped.pmf, first.pmf)).toBeLessThan(1e-15);
    // Capped at two of three, or uncapped: the rider still fires once or more, and the row opens once.
    for (const max of [2, undefined]) {
      const t = Turn.from({
        attacks: [row("a"), row("b"), row("c"), wails()],
        riders: [{ id: "sneak", on: "every-hit", of: ["a", "b", "c"], max, damage: flat(10) }],
      });
      expect(occurs(t, "wails")).toBeCloseTo(closed, 12);
      expect(t.marginal("wails").pmf.mean()).toBeCloseTo(closed * 3.5, 9);
    }
  });

  it("several rows gated on one rider all open together", () => {
    const t = Turn.from({
      attacks: [row("a"), row("b"), wails(), { ...wails({ of: "sneak", landing: "hit" }), id: "echo", chance: 0.5 }],
      riders: [sneak()],
    });
    expect(occurs(t, "wails")).toBeCloseTo(open, 12);
    expect(occurs(t, "echo")).toBeCloseTo(open * 0.5, 12);
    expect(t.mean()).toBeCloseTo(2 * 2 * P + open * 10 + open * 3.5 + open * 0.5 * 3.5, 9);
  });

  it("works through the fluent calls, as a rider with an explicit `of` allows more attacks after it", () => {
    const fluent = turn()
      .attack(swing, "a")
      .attack(swing, "b")
      .onFirstHit(flat(10), { id: "sneak", of: ["a", "b"] })
      .attack(roll(1, 6), { id: "wails", after: { of: "sneak", landing: "damage" } });
    expect(maxDiff(fluent.pmf, Turn.from(spec()).pmf)).toBe(0);
  });

  it("follows the rider's own landing: a damage rider over a save row opens where the save was failed", () => {
    const breath = d20.dc(13).onSaveFailure(roll(4, 6));
    const t = Turn.from({
      attacks: [row("s", breath), wails({ of: "r", landing: "hit" })],
      riders: [{ id: "r", on: "first-hit", of: ["s"], landing: "fail", damage: flat(10) }],
    });
    // d20 against DC 13 fails on a roll under 13: 0.6.
    expect(occurs(t, "wails")).toBeCloseTo(0.6, 12);
    expect(t.fireProbability("r")).toBeCloseTo(0.6, 12);
  });

  it("keeps a substitute's look-ahead exact beside a gated row", () => {
    const t = Turn.from({
      attacks: [row("a", diced), row("b", diced), row("c", diced), { ...wails({ of: "r", landing: "damage" }), source: roll(1, 6) }],
      riders: [{ id: "r", on: "first-hit", of: ["a", "b", "c"], damage: roll(3, 6) }],
      substitutes: [{ id: "s", on: "first-hit", substitute: "reroll-keep-higher", of: ["a", "b", "c"], policy: { kind: "below", hit: 12, crit: 20 } }],
    });
    const marginals = [...t.attackIds, ...t.riderIds].reduce((sum, id) => sum + t.marginal(id).pmf.mean(), 0);
    expect(t.pmf.mean()).toBeCloseTo(marginals, 9);
    expect(occurs(t, "wails")).toBeCloseTo(1 - (1 - P) ** 3, 12);
  });

  it("a substitute does not hold a landing for a gated row that is closed", () => {
    // `g2` can never happen (what gates it never fires, or never happened), so `g1` is the only row
    // the substitute can still wait for: the turn is the one that never had `g2`.
    const six = d20.plus(5).ac(14).onHit(roll(1, 6));
    const policy = { kind: "below", hit: 4, crit: 8 } as const;
    const substitute = (of: string[]) => ({ id: "s", on: "first-hit", substitute: "reroll-keep-higher", of, policy }) as const;
    const base = [
      { source: six, id: "x" },
      { source: six, id: "y", chance: 0 },
      { source: six, id: "g1", after: { of: "r1", landing: "hit" } },
    ] as const;
    const r1: Rider = { id: "r1", on: "first-hit", of: ["x"], damage: flat(1) };
    const without = Turn.from({ attacks: base, riders: [r1], substitutes: [substitute(["g1"])] });
    const gates = {
      rider: { of: "r2", landing: "hit" },
      attack: { of: "y", landing: "hit" },
    } as const;
    for (const [kind, after] of Object.entries(gates)) {
      const riders: Rider[] = kind === "rider" ? [r1, { id: "r2", on: "first-hit", of: ["y"], damage: flat(1) }] : [r1];
      const t = Turn.from({
        attacks: [...base, { source: six, id: "g2", after }],
        riders,
        substitutes: [substitute(["g1", "g2"])],
      });
      expect(t.marginal("g1").pmf.mean(), kind).toBeCloseTo(without.marginal("g1").pmf.mean(), 12);
      expect(maxDiff(t.pmf, without.pmf), kind).toBeLessThan(1e-12);
    }
  });
});

// Every rider kind a gate can read: the gated row happens exactly where `fireProbability` says the rider fired.
const KINDS: Record<string, Rider> = {
  "first-hit": { id: "r", on: "first-hit", of: ["a", "b", "c"], damage: flat(100) },
  "first-hit over a damage landing": { id: "r", on: "first-hit", of: ["a", "b", "c"], damage: flat(100), landing: "damage" },
  "first-hit that lands on anything (folded)": { id: "r", on: "first-hit", of: ["a", "b", "c"], damage: flat(100), landing: "any" },
  "first-hit with a payload per attack (folded)": {
    id: "r",
    on: "first-hit",
    of: ["a", "b", "c"],
    damage: flat(100),
    perSource: { a: { damage: flat(100) }, b: { damage: flat(100) }, c: { damage: flat(100) } },
  },
  "any-crit": { id: "r", on: "any-crit", of: ["a", "b", "c"], damage: flat(100) },
  "any-crit capped (folded)": { id: "r", on: "any-crit", of: ["a", "b", "c"], max: 2, damage: flat(100) },
  "any-miss": { id: "r", on: "any-miss", of: ["a", "b", "c"], damage: flat(100) },
  "first-miss": { id: "r", on: "first-miss", of: ["a", "b", "c"], damage: flat(100) },
  "dice-match": { id: "r", on: "dice-match", of: ["a", "b", "c"], damage: flat(100) },
  "every-hit": { id: "r", on: "every-hit", of: ["a", "b", "c"], damage: flat(100) },
  "every-hit capped": { id: "r", on: "every-hit", of: ["a", "b", "c"], max: 2, damage: flat(100) },
};
const kindTurn = (rider: Rider): Turn =>
  Turn.from({
    attacks: [row("a", diced), row("b", diced), row("c", diced), { source: flat(1000), id: "w", after: { of: "r", landing: "damage" } }],
    riders: [rider],
  });

describe("a gate reads the rider's own firing, whatever its trigger", () => {
  for (const [name, rider] of Object.entries(KINDS)) {
    it(`${name}: the row opens exactly where the rider fired`, () => {
      const t = kindTurn(rider);
      const fired = t.fireProbability("r");
      expect(fired).toBeGreaterThan(0);
      expect(fired).toBeLessThanOrEqual(1);
      expect(occurs(t, "w")).toBeCloseTo(fired, 12);
      // The joint: the total carries the row's 1000 exactly where it carries the rider's 100 (the attacks deal under 100).
      let opened = 0;
      for (const total of t.pmf.support()) {
        const p = t.pmf.pAt(total);
        if (p <= 0) continue;
        const gated = total >= 1000;
        expect(gated, `total ${total}`).toBe(Math.floor((total % 1000) / 100) >= 1);
        if (gated) opened += p;
      }
      expect(opened).toBeCloseTo(fired, 12);
      // The reader walk (marginals) and the joint walk (the PMF) agree.
      const marginals = [...t.attackIds, ...t.riderIds].reduce((sum, id) => sum + t.marginal(id).pmf.mean(), 0);
      expect(t.pmf.mean()).toBeCloseTo(marginals, 9);
    });

    it(`${name}: a sampled turn opens the row exactly where the rider fired`, () => {
      const t = kindTurn(rider);
      const rng = lcgRng(0x5eed + name.length);
      const samples = 20_000;
      let opened = 0;
      for (let i = 0; i < samples; i++) {
        const outcomes = t.sample(rng).waves.flatMap((wave) => wave.outcomes);
        const gated = outcomes.some((outcome) => outcome.source === "w" && outcome.result !== "skipped");
        const fired = outcomes.some((outcome) => outcome.source === "r" && outcome.result === "fired");
        expect(gated).toBe(fired);
        if (gated) opened++;
      }
      const p = occurs(t, "w");
      expect(Math.abs(opened / samples - p)).toBeLessThan(5 * Math.sqrt((p * (1 - p)) / samples) + 1e-12);
    });
  }
});

describe("a gate on a rider is validated like one on an attack", () => {
  it("refuses a rider that watches a row not before the gated attack", () => {
    const before = codeOf(() => Turn.from({ attacks: [row("a"), wails(), row("b")], riders: [sneak()] }));
    expect(before?.code).toBe("unknown-id");
    expect(before?.message).toContain('"sneak"');
    expect(before?.message).toContain('"b"');
    expect(before?.message).toContain("does not come before");
    // Its own `of` left out is every attack, the gated one included.
    const defaulted = codeOf(() =>
      Turn.from({ attacks: [row("a"), { ...row("w"), after: { of: "sneak", landing: "hit" } }], riders: [{ id: "sneak", on: "first-hit", damage: flat(10) }] })
    );
    expect(defaulted?.code).toBe("unknown-id");
    expect(defaulted?.message).toContain('"w"');
  });

  it("refuses a rider that watches a rider: it resolves after every declared attack", () => {
    const refused = codeOf(() =>
      Turn.from({
        attacks: [row("a"), { source: flat(1000), id: "w", after: { of: "r2", landing: "hit" } }],
        riders: [
          { id: "r1", on: "any-miss", of: ["a"], damage: swing },
          { id: "r2", on: "first-hit", of: ["r1"], damage: flat(100) },
        ],
      })
    );
    expect(refused?.code).toBe("unknown-id");
    expect(refused?.message).toContain('"r2"');
    expect(refused?.message).toContain('"r1"');
  });

  it("names a missing id as neither an attack nor a rider", () => {
    const refused = codeOf(() => Turn.from({ attacks: [row("a"), wails({ of: "nowhere", landing: "hit" })] }));
    expect(refused?.code).toBe("unknown-id");
    expect(refused?.message).toContain('"nowhere"');
  });

  it("refuses a rider whose firing is not one event over attacks", () => {
    const notFired = codeOf(() =>
      Turn.from({
        attacks: [row("a"), wails({ of: "else", landing: "hit" })],
        riders: [sneak(["a"]), { id: "else", on: "not-fired", of: "sneak", damage: flat(5) }],
      })
    );
    expect(notFired?.code).toBe("unsupported-trigger");
    const rollsAttack = codeOf(() => Turn.from({ attacks: [row("a"), wails()], riders: [{ id: "sneak", on: "first-hit", of: ["a"], damage: swing }] }));
    expect(rollsAttack?.code).toBe("unsupported-trigger");
    expect(rollsAttack?.message).toContain("rolls its own attack");
    const mayNotHappen = codeOf(() => Turn.from({ attacks: [row("a"), wails()], riders: [{ ...sneak(["a"]), happens: 0.5 } as Rider] }));
    expect(mayNotHappen?.code).toBe("unsupported-trigger");
    expect(mayNotHappen?.message).toContain("happens");
  });

  it("still refuses a bad landing", () => {
    const refused = codeOf(() => Turn.from({ attacks: [row("a"), wails({ of: "sneak", landing: "never" as "hit" })], riders: [sneak(["a"])] }));
    expect(refused?.code).toBe("unsupported-trigger");
  });
});

describe("an attack gated on an attack is as it was", () => {
  it("opens where the parent landed for the landing asked", () => {
    const gated = (landing: "hit" | "damage" | "any") =>
      Turn.from({ attacks: [row("a"), { ...row("b"), after: { of: "a", landing } }] });
    // a deals 2 on 0.6; b deals 2 on its own 0.6, but only where a landed (any: where a happened).
    expect(gated("hit").mean()).toBeCloseTo(2 * P + 2 * P * P, 12);
    expect(gated("damage").mean()).toBeCloseTo(2 * P + 2 * P * P, 12);
    expect(gated("any").mean()).toBeCloseTo(2 * P + 2 * P, 12);
    expect(occurs(gated("hit"), "b")).toBeCloseTo(P, 12);
  });

  it("is the same turn as a first-hit rider over that one attack", () => {
    const viaAttack = Turn.from({ attacks: [row("a"), row("w", diced), { ...row("g"), after: { of: "a", landing: "hit" } }] });
    const viaRider = Turn.from({
      attacks: [row("a"), row("w", diced), { ...row("g"), after: { of: "sneak", landing: "hit" } }],
      riders: [{ id: "sneak", on: "first-hit", of: ["a"], damage: flat(0) }],
    });
    expect(maxDiff(viaAttack.pmf, viaRider.pmf)).toBeLessThan(1e-12);
  });

  it("is still `unknown-id` for a parent that does not come before it", () => {
    const refused = codeOf(() => Turn.from({ attacks: [{ ...row("a"), after: { of: "b", landing: "hit" } }, row("b")] }));
    expect(refused?.code).toBe("unknown-id");
    expect(refused?.message).toContain("does not come before it");
  });
});
