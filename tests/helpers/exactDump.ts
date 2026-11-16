/**
 * Randomized, dprcalc-shaped first-miss-reroll turns, dumped bit for bit. The same generator feeds the cold-vs-warm
 * cache test (`miss-reroll-cache-exactness.test.ts`) and `bench/exact-dump.mts`, whose output is diffed between two builds.
 */
import { d4, d6, d8, d10, d12, d20, roll, Turn, turn } from "../../src/builder";
import type { AttackBuilder, ContextualSource, RowContext } from "../../src/builder";
import type { PMF } from "../../src/pmf/pmf";
import { lcgRng } from "./lcg";

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** A number's exact bits: `-0`, `NaN` payloads and the last ulp all show. */
export const bits = (x: number): string => {
  f64[0] = x;
  return u32[1].toString(16).padStart(8, "0") + u32[0].toString(16).padStart(8, "0");
};

/** Every value's probability under every outcome label and overall, as exact bits. */
export function pmfBits(pmf: PMF): string[] {
  const labels = [...pmf.outcomes()].sort();
  const lines: string[] = [`mean ${bits(pmf.mean())} mass ${bits(pmf.mass())}`];
  for (const value of [...pmf.support()].sort((a, b) => a - b)) {
    lines.push(`${value} ${bits(pmf.pAt(value))} ${labels.map((label) => `${label}=${bits(pmf.filterOutcome(label).pAt(value))}`).join(" ")}`);
  }
  return lines;
}

export interface Case {
  name: string;
  build: () => Turn;
}

/** A row rider "sa"'s dice join: `under` and `missRerolledUnder` roll the pooled attack when `context.joined` names it. */
const joiningRow = (plain: AttackBuilder, pooled: AttackBuilder): ContextualSource & {
  missRerolledUnder(context: RowContext, mode: "reroll" | "add-d20"): PMF;
} => ({
  rowCheck: plain.rowCheck,
  under: (context) => (context.joined.includes("sa") ? pooled : plain).under(context),
  missRerolledUnder: (context, mode) => (context.joined.includes("sa") ? pooled : plain).missRerolled(mode, context),
});

/** The `index`th random case: rows built from scratch each call (equal content, new objects). */
export function randomCase(seed: number): Case {
  const rng = lcgRng(seed);
  const int = (n: number): number => rng.die(n) - 1;
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)];
  const dies = [d4, d6, d8, d10, d12];
  // A small pool of row shapes, so rows repeat by content (as dprcalc's do) without being the same object.
  const shapes = Array.from({ length: 1 + int(4) }, () => ({
    toHit: 3 + int(12),
    ac: 10 + int(13),
    adv: pick(["flat", "advantage", "disadvantage", "elven"] as const),
    crit: pick([20, 20, 19, 18]),
    toHitDie: int(3) === 0,
    count: 1 + int(3),
    die: int(5),
    flat: int(8),
    separate: int(4) === 0,
    nat20: int(6) === 0,
    ranged: int(2) === 0,
  }));
  const rowCount = 1 + int(8);
  const order = Array.from({ length: rowCount }, () => int(shapes.length));
  const riderDie = pick([d6, d8]);
  const withRider = int(2) === 0;
  const joined = withRider && int(2) === 0;
  const modes = pick([["reroll"], ["add-d20"], ["reroll", "add-d20"]] as const);
  const substitute = int(4) === 0;

  const attack = (s: (typeof shapes)[number], extra: boolean): AttackBuilder => {
    let check = d20.plus(s.toHit);
    if (s.toHitDie) check = check.plus(1, d4);
    if (s.adv === "advantage" || s.adv === "elven") check = check.withAdvantage();
    if (s.adv === "disadvantage") check = check.withDisadvantage();
    let ac = check.ac(s.ac);
    if (s.adv === "elven") ac = ac.threeDiceAdvantage();
    if (s.crit !== 20) ac = ac.critOn(s.crit);
    if (s.ranged) ac = ac.ranged();
    let damage = roll(s.count, dies[s.die]).plus(s.flat);
    if (extra) damage = damage.plus(3, d6);
    let a = ac.onHit(damage);
    if (s.separate) a = a.plusSeparateDamage(roll(1, d6));
    if (s.nat20) a = a.plusNatural20Damage(roll(1, d6));
    return a;
  };
  return {
    name: `seed ${seed}`,
    build: () => {
      if (joined) {
        return Turn.from({
          attacks: order.map((index, i) => ({ id: `a${i}`, source: joiningRow(attack(shapes[index], false), attack(shapes[index], true)) })),
          riders: [{ id: "sa", on: "first-hit", damage: roll(3, d6), joins: order.map((_, i) => `a${i}`) }],
          substitutes: modes.map((mode, k) => ({ id: `rr${k}`, on: "first-miss" as const, substitute: "reroll" as const, mode })),
        } as never);
      }
      let t = turn(order.map((index) => attack(shapes[index], false)));
      if (withRider) t = t.onFirstHit(roll(2, riderDie));
      if (substitute) t = t.onFirstHit(roll(1, d6).plus(1), { id: "x" });
      modes.forEach((mode, k) => {
        t = t.rerollFirstMiss({ id: `rr${k}`, mode });
      });
      return t;
    },
  };
}

/** Every observable of a turn as exact bits: its PMF, each attack's marginal, each reroll's firing mass. */
export function dumpTurn(t: Turn): string[] {
  const lines = ["pmf", ...pmfBits(t.pmf), `mean ${bits(t.mean())}`];
  for (const id of t.attackIds) lines.push(`marginal ${id}`, ...pmfBits(t.marginal(id).pmf));
  for (const id of t.riderIds) lines.push(`rider ${id}`, ...pmfBits(t.marginal(id).pmf));
  for (const id of ["rr0", "rr1", "hi", "lucky"]) {
    try {
      lines.push(`fire ${id} ${bits(t.fireProbability(id) ?? NaN)}`);
    } catch {
      // not an id of this turn
    }
  }
  return lines;
}
