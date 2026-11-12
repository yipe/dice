/**
 * Brute-force oracle for a row that rerolls its missed attack roll (`rerollMisses`). It enumerates every
 * d20 face of every die, every bonus-die face and every face of the new d20, and imports nothing from `src/`.
 */
export interface RowCase {
  toHit: number;
  toHitDice?: readonly { count: number; sides: number; sign: 1 | -1 }[];
  ac: number;
  /** The natural face at or above which a hit crits; 21 = never. */
  critRange: number;
  advantage: "flat" | "advantage" | "disadvantage" | "elven";
  rerollOnes?: boolean;
  autoCrit?: boolean;
  mode?: "reroll" | "add-d20";
}

type Odds = { miss: number; hit: number; crit: number; natural20: number };

/** One d20 as the row rolls it: a 1 is rolled once more under `rerollOnes`. */
function dieFaces(rerollOnes: boolean): Map<number, number> {
  const faces = new Map<number, number>();
  const add = (face: number, p: number): void => void faces.set(face, (faces.get(face) ?? 0) + p);
  for (let first = 1; first <= 20; first++) {
    if (first === 1 && rerollOnes) for (let again = 1; again <= 20; again++) add(again, 1 / 400);
    else add(first, 1 / 20);
  }
  return faces;
}

/** Every total of the bonus dice, with its probability. */
function bonusTotals(c: RowCase): Map<number, number> {
  let totals = new Map<number, number>([[c.toHit, 1]]);
  for (const { count, sides, sign } of c.toHitDice ?? []) {
    for (let i = 0; i < count; i++) {
      const next = new Map<number, number>();
      for (const [total, p] of totals) {
        for (let face = 1; face <= sides; face++) {
          const value = total + sign * face;
          next.set(value, (next.get(value) ?? 0) + p / sides);
        }
      }
      totals = next;
    }
  }
  return totals;
}

function outcome(c: RowCase, face: number, bonus: number): "miss" | "hit" | "crit" {
  if (face === 20) return "crit";
  if (face === 1 || face + bonus < c.ac) return "miss";
  return c.autoCrit === true || face >= c.critRange ? "crit" : "hit";
}

/** The kept face of the dice rolled: the best of them, or the worst under disadvantage. */
function kept(c: RowCase, dice: readonly number[]): number {
  return c.advantage === "disadvantage" ? Math.min(...dice) : Math.max(...dice);
}

export function rowOdds(c: RowCase): Odds {
  const mode = c.mode ?? "add-d20";
  const dist = [...dieFaces(c.rerollOnes === true)];
  const rolled = c.advantage === "flat" ? 1 : c.advantage === "elven" ? 3 : 2;
  const out: Odds = { miss: 0, hit: 0, crit: 0, natural20: 0 };

  const visit = (dice: number[], p: number, bonus: number, pBonus: number): void => {
    if (dice.length < rolled) {
      for (const [face, pFace] of dist) visit([...dice, face], p * pFace, bonus, pBonus);
      return;
    }
    if (outcome(c, kept(c, dice), bonus) !== "miss") return;
    for (const [again, pAgain] of dist) {
      let next: number;
      if (mode === "add-d20") next = Math.max(...dice, again);
      else {
        // The kept die is replaced: the others still count.
        const keptFace = kept(c, dice);
        const others = [...dice];
        others.splice(others.indexOf(keptFace), 1);
        next = kept(c, [...others, again]);
      }
      const weight = p * pAgain * pBonus;
      const result = outcome(c, next, bonus);
      out[result] += weight;
      if (result === "crit" && next === 20) out.natural20 += weight;
    }
  };

  for (const [bonus, pBonus] of bonusTotals(c)) visit([], 1, bonus, pBonus);
  return out;
}
