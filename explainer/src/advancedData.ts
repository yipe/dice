import { parse } from "@yipe/dice";
import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";
import { AC, AC_RANGE, AT_AC, BONUS, DAMAGE, binsOf, expr } from "./attackData";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const pmfArray = (map: ReadonlyMap<number, { p: number }>, max: number) => {
  const out = new Array(max + 1).fill(0);
  for (const [v, b] of map.entries()) out[v] += b.p;
  return out as number[];
};

// ---------------- Part 6: advantage ----------------
export type RollType = "disadvantage" | "normal" | "advantage" | "elven";
export const CHECK: Record<RollType, string> = { disadvantage: "d20 < d20", normal: "d20", advantage: "d20 > d20", elven: "d20 > d20 > d20" };
export const attackExpr = (rt: RollType, ac: number) => expr(ac).replace("(d20 + ", `(${CHECK[rt]} + `);
const oddsOf = (e: string) => {
  const q = parse(e).query();
  const crit = q.probAtLeastOne("crit");
  const land = q.probAtLeastOne(["hit", "crit"]);
  return { miss: 1 - land, hit: land - crit, crit, dpr: parse(e).mean() };
};
export const ROLL_TYPES: RollType[] = ["disadvantage", "normal", "advantage", "elven"];
export const ADV = Object.fromEntries(ROLL_TYPES.map((rt) => [rt, oddsOf(attackExpr(rt, 15))])) as Record<RollType, ReturnType<typeof oddsOf>>;
export const DPR_BY_AC = Object.fromEntries(ROLL_TYPES.map((rt) => [rt, AC_RANGE.map((ac) => parse(attackExpr(rt, ac)).mean())])) as Record<RollType, number[]>;
/** The damage distribution behind every point on those lines: per roll type, per AC. */
export const DIST_BY_AC = Object.fromEntries(ROLL_TYPES.map((rt) => [rt, AC_RANGE.map((ac) => binsOf(attackExpr(rt, ac)))])) as Record<RollType, ReturnType<typeof binsOf>[]>;
ROLL_TYPES.forEach((rt) => DIST_BY_AC[rt].forEach((bins, i) => {
  const mean = bins.reduce((a, b, v) => a + v * (b.miss + b.hit + b.crit), 0);
  if (Math.abs(mean - DPR_BY_AC[rt][i]) > 1e-9) throw new Error("distribution mean mismatch");
}));

if (!near(ADV.advantage.miss, ADV.normal.miss ** 2) || !near(ADV.advantage.crit, 1 - 0.95 * 0.95)) throw new Error("advantage odds drifted");
if (!near(ADV.normal.dpr, AT_AC.dpr)) throw new Error("normal DPR drifted");

// ---------------- Parts 7-9: the monk-rogue's turn ----------------
// Monk 5 / Rogue 1. Rogue 1 brings Sneak Attack (1d6) and two weapon masteries: Vex (shortsword), Nick (scimitar).
export const plainSword = d20.plus(BONUS).ac(AC).onHit(d8.plus(DAMAGE.dex));
if (plainSword.toExpression() !== expr(AC)) throw new Error("builder and string attacks differ");
export const vexSword = plainSword.onEveryHit(advantage().untilNextAttack()); // Vex: a hit grants advantage on the next attack
export const scimitar = d20.plus(BONUS).ac(AC).onHit(d8); // Nick's extra Light attack adds no Dexterity
export const fist = d20.plus(BONUS).ac(AC).onHit(d8.plus(DAMAGE.dex)); // Flurry of Blows, Martial Arts d8

export const ATTACKS = [
  { id: "A", name: "Shortsword", tag: "Vex", dmg: `1d8 + ${DAMAGE.dex}`, kind: "weapon" as const, single: plainSword.mean() },
  { id: "B", name: "Shortsword", tag: "Vex", dmg: `1d8 + ${DAMAGE.dex}`, kind: "weapon" as const, single: plainSword.mean() },
  { id: "C", name: "Scimitar", tag: "Nick", dmg: "1d8", kind: "weapon" as const, single: scimitar.mean() },
  { id: "D", name: "Unarmed Strike", tag: "Flurry", dmg: `1d8 + ${DAMAGE.dex}`, kind: "fist" as const, single: fist.mean() },
  { id: "E", name: "Unarmed Strike", tag: "Flurry", dmg: `1d8 + ${DAMAGE.dex}`, kind: "fist" as const, single: fist.mean() },
];
const WEAPONS = { of: ["attack 1", "attack 2", "attack 3"] }; // Sneak Attack needs a finesse weapon; fists never qualify
const independent = turn([plainSword, plainSword, scimitar, fist, fist]);
const withVex = turn([vexSword, vexSword, scimitar, fist, fist]);
const full = turn([vexSword, vexSword, scimitar, fist, fist]).onFirstHit(d6, { ...WEAPONS, id: "sneak" });
const noVexSneak = turn([plainSword, plainSword, scimitar, fist, fist]).onFirstHit(d6, { ...WEAPONS, id: "sneak" });

export const TURN_MAX = full.pmf.max();
const arr = (pmf: { map: ReadonlyMap<number, { p: number }> }) => pmfArray(pmf.map, TURN_MAX);
export const PMF = { independent: arr(independent.pmf), vex: arr(withVex.pmf), full: arr(full.pmf) };
export const TURN = {
  independent: independent.mean(), vex: withVex.mean(), full: full.mean(), noVexSneak: noVexSneak.mean(),
  sneakFires: full.fireProbability("sneak"), sneakFiresNoVex: noVexSneak.fireProbability("sneak"),
  advantage: full.attackIds.map((id) => full.stepStats(id).live.advantage ?? 0), // per attack, A..E
  // per attack: chance of advantage, of landing (hit or crit) and of a crit, A..E
  steps: full.attackIds.map((id) => { const s = full.stepStats(id); return { adv: s.live.advantage ?? 0, land: s.hit, crit: s.crit }; }),
};
// each step is a mix of a normal roll and an advantaged one, weighted by its chance of advantage
TURN.steps.forEach((s) => {
  const o = AT_AC.odds;
  if (!near(s.land, (1 - s.adv) * (1 - o.miss) + s.adv * (1 - o.miss ** 2)) || !near(s.crit, (1 - s.adv) * o.crit + s.adv * (1 - (1 - o.crit) ** 2))) throw new Error("step odds mismatch");
});
const odds = AT_AC.odds;
const land = 1 - odds.miss; // 65%
export const ADV_LAND = 1 - odds.miss ** 2; // 87.75%
// the Sneak Attack cascade: the first finesse hit gets it. A miss grants no advantage, so every pending branch is unaided.
export const CASCADE = [land, odds.miss * land, odds.miss ** 2 * land, odds.miss ** 3];
export const BREAKDOWN = [
  { k: "attacks" as const, label: "five attacks", v: TURN.independent },
  { k: "vex" as const, label: "Vex", v: TURN.vex - TURN.independent },
  { k: "sneak" as const, label: "Sneak Attack", v: TURN.full - TURN.vex },
];

// ---- Part 7: the turn built attack by attack, by hand, must equal the engine's independent turn ----
const convolve = (a: number[], b: number[]) => {
  const out = new Array(a.length + b.length - 1).fill(0) as number[];
  a.forEach((x, i) => { if (x) b.forEach((y, j) => (out[i + j] += x * y)); });
  return out;
};
const single = (b: typeof plainSword) => pmfArray(b.pmf.map, b.pmf.max());
export const SINGLES = [single(plainSword), single(plainSword), single(scimitar), single(fist), single(fist)];
export const BUILD: number[][] = [];
SINGLES.reduce((acc, s) => { const next = convolve(acc, s); BUILD.push(next); return next; }, [1]);
export const BUILD_MEANS = BUILD.map((a) => a.reduce((s, p, v) => s + p * v, 0));

if (BUILD[4].some((p, v) => !near(p, PMF.independent[v] ?? 0, 1e-12))) throw new Error("hand-built turn != engine turn");
if (!near(TURN.independent, ATTACKS.reduce((a, x) => a + x.single, 0))) throw new Error("independent attacks should just add");
if (!near(TURN.advantage[1], land) || !near(TURN.advantage[2], land * ADV_LAND + odds.miss * land)) throw new Error("Vex advantage chain drifted");
if (TURN.advantage[3] !== 0 || TURN.advantage[4] !== 0 || TURN.advantage[0] !== 0) throw new Error("only B and C should ever have advantage");
if (!near(TURN.sneakFires, 1 - odds.miss ** 3) || !near(TURN.sneakFires, TURN.sneakFiresNoVex)) throw new Error("Vex should not change how often Sneak Attack lands");
if (!near(CASCADE.reduce((a, b) => a + b, 0), 1)) throw new Error("cascade must total 100%");

// each attack's damage split by outcome (library provenance), and each build step's layers
type Split = { miss: number[]; hit: number[]; crit: number[] };
const splitOf = (b: typeof plainSword): Split => {
  const n = b.pmf.max() + 1;
  const out: Split = { miss: new Array(n).fill(0), hit: new Array(n).fill(0), crit: new Array(n).fill(0) };
  for (const [v, bin] of b.pmf.map.entries()) {
    const c = bin.count as Record<string, number>;
    out.miss[v] += c.missNone ?? 0;
    out.hit[v] += c.hit ?? 0;
    out.crit[v] += c.crit ?? 0;
  }
  return out;
};
export const SPLITS = [plainSword, plainSword, scimitar, fist, fist].map(splitOf);
export const BUILD_LAYERS = SPLITS.map((sp, k) => {
  const prev = k === 0 ? [1] : BUILD[k - 1];
  return { prev, miss: convolve(prev, sp.miss), hit: convolve(prev, sp.hit), crit: convolve(prev, sp.crit) };
});
BUILD_LAYERS.forEach((L, k) => {
  const sum = BUILD[k].map((_, v) => (L.miss[v] ?? 0) + (L.hit[v] ?? 0) + (L.crit[v] ?? 0));
  if (sum.some((p, v) => !near(p, BUILD[k][v], 1e-12))) throw new Error(`build layers != step ${k}`);
});
