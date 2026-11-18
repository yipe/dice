/**
 * Brute-force oracle for the composed and add-die miss rerolls (`rerollMisses("advantage")`, a list of modes, `add-dN`). It
 * plays the rules text over explicit dice: every d20 face, every bonus-die face, every die the modes add. It imports nothing
 * from `src/`.
 */
export interface ModesCase {
  toHit: number;
  toHitDice?: readonly { sides: number }[];
  ac: number;
  /** The natural face at or above which a landing roll crits; 21 = never. */
  critRange: number;
  roll: "flat" | "advantage" | "disadvantage" | "elven";
  modes: readonly ("reroll" | "add-d20" | "advantage" | "add-d4" | "add-d6" | "add-d8" | "add-d10" | "add-d12")[];
}

export interface ModesOdds {
  miss: number;
  hit: number;
  crit: number;
  /** P(the first roll misses and no die is ever spent on it): an add-dN left unspent. */
  unspent: number;
}

type Kind = "flat" | "min" | "max";

function bonusTotals(c: ModesCase): Map<number, number> {
  let totals = new Map<number, number>([[c.toHit, 1]]);
  for (const { sides } of c.toHitDice ?? []) {
    const next = new Map<number, number>();
    for (const [total, p] of totals) for (let f = 1; f <= sides; f++) next.set(total + f, (next.get(total + f) ?? 0) + p / sides);
    totals = next;
  }
  return totals;
}

function outcome(c: ModesCase, face: number, total: number): "miss" | "hit" | "crit" {
  if (face === 20) return "crit";
  if (face === 1 || total < c.ac) return "miss";
  return face >= c.critRange ? "crit" : "hit";
}

export function modesOdds(c: ModesCase): ModesOdds {
  const out: ModesOdds = { miss: 0, hit: 0, crit: 0, unspent: 0 };
  const rolled = c.roll === "flat" ? 1 : c.roll === "elven" ? 3 : 2;
  const keptOf = (kind: Kind, dice: readonly number[]): number => (kind === "min" ? Math.min(...dice) : Math.max(...dice));

  /** Plays `modes[at..]` on live `dice` of `kind`, each fresh d20 face weighted 1/20. */
  const play = (dice: number[], kind: Kind, at: number, p: number, bonus: number): void => {
    const natural = keptOf(kind, dice);
    const result = outcome(c, natural, natural + bonus);
    // Only a roll that missed as rolled is rerolled: the rest is not this oracle's business.
    if (at === 0 && result !== "miss") return;
    if (result !== "miss" || at === c.modes.length) {
      out[result] += p;
      return;
    }
    const mode = c.modes[at];
    const addDie = /^add-d(\d+)$/.exec(mode);
    if (addDie !== null && mode !== "add-d20") {
      const sides = Number(addDie[1]);
      const short = c.ac - (natural + bonus);
      if (natural === 1 || short > sides) {
        out.miss += p;
        out.unspent += p;
        return;
      }
      for (let face = 1; face <= sides; face++) {
        out[face >= short ? (natural >= c.critRange ? "crit" : "hit") : "miss"] += p / sides;
      }
      return;
    }
    if (mode === "advantage") {
      const count = kind === "min" ? 1 : c.roll === "elven" ? 3 : 2;
      fresh(count, p, (dice2, weight) => play(dice2, "max", at + 1, weight, bonus));
      return;
    }
    if (mode === "reroll") {
      // A flat roll has the one die; a pair keeps the other die; the best of several keeps the rest.
      const rest = [...dice];
      rest.splice(rest.indexOf(natural), 1);
      const keep = kind === "flat" ? [] : kind === "min" ? [Math.max(...dice)] : rest;
      fresh(1, p, (added, weight) => play([...keep, ...added], kind, at + 1, weight, bonus));
      return;
    }
    fresh(1, p, (added, weight) => play([...dice, ...added], "max", at + 1, weight, bonus));
  };

  /** Every face of `count` fresh d20s, calling `then` with them and their weight. */
  const fresh = (count: number, p: number, then: (dice: number[], weight: number) => void, dice: number[] = []): void => {
    if (dice.length === count) return then(dice, p);
    for (let f = 1; f <= 20; f++) fresh(count, p / 20, then, [...dice, f]);
  };

  for (const [bonus, pBonus] of bonusTotals(c)) {
    const kind: Kind = c.roll === "disadvantage" ? "min" : c.roll === "flat" ? "flat" : "max";
    fresh(rolled, pBonus, (dice, p) => play(dice, kind, 0, p, bonus));
  }
  return out;
}
