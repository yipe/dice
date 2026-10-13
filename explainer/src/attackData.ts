import { parse } from "@yipe/dice";

// The running example: a level 6 monk-rogue (Monk 5 / Rogue 1, 2024 rules).
//   to hit: +7 = Dexterity +4 + proficiency +3, against AC 15
//   hit:    the Martial Arts die, 1d8 + 4 Dexterity
//   crit:   dice double, bonuses do not: 2d8 + 4 (the two dice from Part 1)
// Every number on screen comes from @yipe/dice.
export const DEX = 4;
export const PROF = 3;
export const BONUS = DEX + PROF;
export const AC = 15;
export const DAMAGE = { hit: `1d8 + ${DEX}`, crit: `2d8 + ${DEX}`, dex: DEX };
export const expr = (ac: number) => `(d20 + ${BONUS} AC ${ac}) * (${DAMAGE.hit}) crit (${DAMAGE.crit})`;

export const MAX_DMG = parse(DAMAGE.crit).max(); // 2d8 + 4 tops out at 20
export type Bin = { miss: number; hit: number; crit: number };

/** Damage PMF split by where the damage came from (the library's per-outcome provenance). */
export function damageBins(ac: number): Bin[] {
  return binsOf(expr(ac));
}
/** The same split for any attack expression. */
export function binsOf(e: string): Bin[] {
  const pmf = parse(e);
  const bins: Bin[] = Array.from({ length: MAX_DMG + 1 }, () => ({ miss: 0, hit: 0, crit: 0 }));
  for (const [v, b] of pmf.map.entries()) {
    const c = b.count as Record<string, number>;
    bins[v].miss += (c.missNone ?? 0) + (c.missDamage ?? 0);
    bins[v].hit += c.hit ?? 0;
    bins[v].crit += c.crit ?? 0;
  }
  return bins;
}

export function outcomeOdds(ac: number) {
  const q = parse(expr(ac)).query();
  const crit = q.probAtLeastOne("crit");
  const hit = q.probAtLeastOne(["hit", "crit"]) - crit;
  return { miss: 1 - hit - crit, hit, crit };
}

export const dpr = (ac: number) => parse(expr(ac)).mean();
export const dprParts = (ac: number) => {
  const q = parse(expr(ac)).query();
  return { miss: q.expectedDamageFrom("missDamage"), hit: q.expectedDamageFrom("hit"), crit: q.expectedDamageFrom("crit") };
};

export const AT_AC = { bins: damageBins(AC), odds: outcomeOdds(AC), dpr: dpr(AC), parts: dprParts(AC) };
export const HIT_AVG = parse(DAMAGE.hit).mean(); // 8.5
export const CRIT_AVG = parse(DAMAGE.crit).mean(); // 13

export const AC_RANGE = Array.from({ length: 16 }, (_, i) => 10 + i);
export const SWEEP = AC_RANGE.map((ac) => ({ ac, bins: damageBins(ac), dpr: dpr(ac) }));

// sanity: the example the videos narrate
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
if (!near(AT_AC.odds.miss, 0.35) || !near(AT_AC.odds.hit, 0.6) || !near(AT_AC.odds.crit, 0.05)) throw new Error("AC 15 odds drifted");
if (!near(AT_AC.dpr, 0.6 * HIT_AVG + 0.05 * CRIT_AVG)) throw new Error("AC 15 DPR drifted");
