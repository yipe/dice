import { advantage, d20, d6, d8, turn } from "@yipe/dice/builder";
import { saveDC, stunned } from "@yipe/dice/dnd5e";
import { ATTACKS, TURN } from "./advancedData";
import { AC, AT_AC, BONUS, DAMAGE } from "./attackData";

// ---------------- Stunning Strike (2024) on the monk-rogue's turn ----------------
// Once per turn, on a hit with a Monk weapon or Unarmed Strike: the target makes a Constitution save.
// Fail: Stunned until the start of your next turn (attacks against it have advantage).
// Pass: the next attack against it has advantage. Either way, the next attack gets advantage.
export const SAVE = { dc: 14, con: 3 }; // DC 8 + prof 3 + Wis 3; a typical AC 15 foe saves at +3
export const SAVE_FAIL = (SAVE.dc - SAVE.con - 1) / 20; // d20 + 3 < 14: a 1 to 10, 50%

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const sword = d20.plus(BONUS).ac(AC).onHit(d8.plus(DAMAGE.dex));
const vexSword = sword.onEveryHit(advantage().untilNextAttack());
const scimitar = d20.plus(BONUS).ac(AC).onHit(d8);
const fist = d20.plus(BONUS).ac(AC).onHit(d8.plus(DAMAGE.dex));
const ids = (...n: number[]) => n.map((i) => `attack ${i}`);
const stun = (of: string[]) => ({ of, id: "stun", save: saveDC(SAVE.dc, { con: SAVE.con }), onSave: advantage().untilNextAttack() });

export const TURNS = {
  normal: turn([sword, sword, scimitar, fist, fist]).onFirstHit(d6, { of: ids(1, 2, 3), id: "sneak" }),
  vex: turn([vexSword, vexSword, scimitar, fist, fist]).onFirstHit(d6, { of: ids(1, 2, 3), id: "sneak" }),
  vexStun: turn([vexSword, vexSword, scimitar, fist, fist]).onFirstHit(d6, { of: ids(1, 2, 3), id: "sneak" }).onFirstHit(stunned().untilEndOfTurn(), stun(ids(4, 5))),
  stunVex: turn([fist, fist, vexSword, vexSword, scimitar]).onFirstHit(d6, { of: ids(3, 4, 5), id: "sneak" }).onFirstHit(stunned().untilEndOfTurn(), stun(ids(1, 2))),
};
export type TurnKey = keyof typeof TURNS;
export const ROW_LABEL: Record<TurnKey, string> = { normal: "Normal", vex: "Vex", vexStun: "Vex → Stun", stunVex: "Stun → Vex" };

const statsOf = (k: TurnKey) => {
  const t = TURNS[k];
  const steps = t.attackIds.map((id) => t.stepStats(id));
  return {
    dpr: t.mean(),
    // a probe sees the turn's conditions; toQuery's singles would not
    anyCrit: t.observe({ on: "any-crit", id: "crit" }).fireProbability("crit"),
    sneak: t.fireProbability("sneak"),
    stunned: k === "vexStun" || k === "stunVex" ? t.fireProbability("stun") : 0, // stunned with an attack still to come
    adv: steps.map((s) => s.live.advantage ?? 0),
    land: steps.map((s) => s.hit),
    crit: steps.map((s) => s.crit),
  };
};
export const STATS = Object.fromEntries((Object.keys(TURNS) as TurnKey[]).map((k) => [k, statsOf(k)])) as Record<TurnKey, ReturnType<typeof statsOf>>;
export const advCount = (k: TurnKey) => STATS[k].adv.reduce((a, b) => a + b, 0);

const MAX = Math.max(...Object.values(TURNS).map((t) => t.pmf.max()));
const arr = (k: TurnKey) => {
  const out = new Array(MAX + 1).fill(0) as number[];
  for (const [v, b] of TURNS[k].pmf.map.entries()) out[v] += b.p;
  return out;
};
export const STUN_PMF = { vex: arr("vex"), vexStun: arr("vexStun"), stunVex: arr("stunVex") };

// ---------------- the branching tree, by hand ----------------
// Every path of miss / hit / crit through the five attacks, with each save split. The expected damage
// over these paths must equal the engine's mean, so the tree we draw is the turn the engine computes.
type Kind = "sword" | "scimitar" | "fist";
type Outcome = "miss" | "hit" | "crit";
export type TreeNode = {
  depth: number; // 0 = before the turn, 1..5 = after attack 1..5
  outcome?: Outcome;
  p: number; // probability of this whole path
  adv: boolean; // this attack rolled with advantage
  sneak: boolean; // Sneak Attack landed on this attack
  save?: "fail" | "pass"; // Stunning Strike was attempted on this attack
  stunned: boolean; // target stunned after this step
  ev: number; // expected total turn damage given this path
  children: TreeNode[];
  y: number;
};
const ODDS = { normal: [AT_AC.odds.miss, AT_AC.odds.hit, AT_AC.odds.crit], adv: [AT_AC.odds.miss ** 2, 0, 1 - (1 - AT_AC.odds.crit) ** 2] };
ODDS.adv[1] = 1 - ODDS.adv[0] - ODDS.adv[2];
const MEAN_DMG: Record<Kind, [number, number, number]> = { sword: [0, 8.5, 13], scimitar: [0, 4.5, 9], fist: [0, 8.5, 13] };
const SNEAK_DMG: [number, number, number] = [0, 3.5, 7];

export const ORDERS: Record<"vexStun" | "stunVex", Kind[]> = {
  vexStun: ["sword", "sword", "scimitar", "fist", "fist"],
  stunVex: ["fist", "fist", "sword", "sword", "scimitar"],
};

export function buildTree(order: Kind[]): TreeNode {
  const walk = (i: number, p: number, dealt: number, advNext: boolean, stunnedNow: boolean, sneakUsed: boolean, stunUsed: boolean): TreeNode[] => {
    if (i === order.length) return [];
    const kind = order[i];
    const adv = advNext || stunnedNow;
    const odds = adv ? ODDS.adv : ODDS.normal;
    const out: TreeNode[] = [];
    (["miss", "hit", "crit"] as Outcome[]).forEach((o, oi) => {
      const po = p * odds[oi];
      if (po === 0) return;
      const lands = oi > 0;
      const sneak = lands && !sneakUsed && kind !== "fist";
      const dmg = dealt + MEAN_DMG[kind][oi] + (sneak ? SNEAK_DMG[oi] : 0);
      const vexNext = lands && kind === "sword";
      const branches: { save?: "fail" | "pass"; q: number }[] = lands && kind === "fist" && !stunUsed ? [{ save: "fail", q: SAVE_FAIL }, { save: "pass", q: 1 - SAVE_FAIL }] : [{ q: 1 }];
      for (const b of branches) {
        const st = stunnedNow || b.save === "fail";
        const next = vexNext || b.save === "pass";
        const node: TreeNode = { depth: i + 1, outcome: o, p: po * b.q, adv, sneak, save: b.save, stunned: st, ev: 0, children: [], y: 0 };
        node.children = walk(i + 1, node.p, dmg, next, st, sneakUsed || sneak, stunUsed || !!b.save);
        node.ev = node.children.length ? node.children.reduce((a, c) => a + c.p * c.ev, 0) / node.p : dmg;
        out.push(node);
      }
    });
    return out;
  };
  const root: TreeNode = { depth: 0, p: 1, adv: false, sneak: false, stunned: false, ev: 0, children: walk(0, 1, 0, false, false, false, false), y: 0 };
  root.ev = root.children.reduce((a, c) => a + c.p * c.ev, 0);
  return root;
}

export const TREE = buildTree(ORDERS.vexStun);
export const TREE_STUN_FIRST = buildTree(ORDERS.stunVex);
if (!near(TREE.ev, STATS.vexStun.dpr) || !near(TREE_STUN_FIRST.ev, STATS.stunVex.dpr)) throw new Error("tree EV must equal the engine's mean");
if (!near(STATS.vexStun.stunned, STATS.vexStun.land[3] * SAVE_FAIL)) throw new Error("Vex -> Stun: stunned needs D to land and the save to fail");

/** All nodes at each depth, leaves spread evenly down [top, bottom], parents centred on their children. */
export function layoutTree(root: TreeNode, top: number, bottom: number) {
  const leaves: TreeNode[] = [];
  const collect = (n: TreeNode) => (n.children.length ? n.children.forEach(collect) : leaves.push(n));
  collect(root);
  leaves.forEach((l, i) => (l.y = top + ((bottom - top) * i) / (leaves.length - 1)));
  const place = (n: TreeNode): number => (n.children.length ? (n.y = n.children.reduce((a, c) => a + place(c), 0) / n.children.length) : n.y);
  place(root);
  const byDepth: TreeNode[][] = [];
  const visit = (n: TreeNode) => { (byDepth[n.depth] ??= []).push(n); n.children.forEach(visit); };
  visit(root);
  return { leaves: leaves.length, byDepth };
}

// ---------------- how many dice outcomes? ----------------
// Count every die the turn might need: two d20s per attack (advantage), the crit's two damage dice,
// Sneak Attack's two d6 on a crit, one more d20 for the save. Each step multiplies the count.
export const COMBOS = (() => {
  const steps = [
    { label: "Attack A", f: 20 * 20 * 8 * 8 * 6 * 6 }, // d20s, damage dice, Sneak Attack dice
    { label: "Attack B", f: 20 * 20 * 8 * 8 },
    { label: "Attack C", f: 20 * 20 * 8 * 8 },
    { label: "Attack D", f: 20 * 20 * 8 * 8 * 20 }, // plus the Constitution save
    { label: "Attack E", f: 20 * 20 * 8 * 8 },
  ];
  let n = 1;
  let exact = 1n;
  return steps.map((s) => ({ ...s, total: (n *= s.f), exact: (exact *= BigInt(s.f)) }));
})();
if (COMBOS[4].exact !== 20n ** 11n * 8n ** 10n * 6n ** 2n) throw new Error("exact dice count");
if (Math.abs(COMBOS[4].total / (20 ** 11 * 8 ** 10 * 6 ** 2) - 1) > 1e-12) throw new Error("dice count");

// ---------------- where the whole turn's DPR comes from ----------------
// Each attack's own average, then what each condition adds on top. Means add, so the pieces sum exactly.
// In the winning order (Flurry first), so the finale's breakdown sums to the turn it folds into: Stun → Vex.
const FLURRY_FIRST = [ATTACKS[3], ATTACKS[4], ATTACKS[0], ATTACKS[1], ATTACKS[2]];
const vexFirstFists = turn([fist, fist, vexSword, vexSword, scimitar]);
const sneakFirstFists = vexFirstFists.onFirstHit(d6, { of: ids(3, 4, 5) });
export const PIECES = [
  ...FLURRY_FIRST.map((a) => ({ key: a.id, label: a.name, v: a.single, kind: "attack" as const })),
  { key: "vex", label: "Vex", v: vexFirstFists.mean() - TURN.independent, kind: "vex" as const },
  { key: "sneak", label: "Sneak Attack", v: sneakFirstFists.mean() - vexFirstFists.mean(), kind: "sneak" as const },
  { key: "stun", label: "Stunning Strike", v: STATS.stunVex.dpr - sneakFirstFists.mean(), kind: "stun" as const },
];
if (!near(PIECES.reduce((a, p) => a + p.v, 0), STATS.stunVex.dpr)) throw new Error("the pieces must add up to the turn's DPR");
// Vex and Sneak Attack add the same in either order; only Stunning Strike gains from going first.
if (!near(PIECES[5].v, TURN.vex - TURN.independent) || !near(PIECES[6].v, TURN.full - TURN.vex)) throw new Error("Vex / Sneak pieces should not depend on order");
if (!near(ATTACKS.reduce((a, x) => a + x.single, 0), TURN.independent)) throw new Error("independent attacks add");
// The joke formula's turn is the winning order (Unarmed Strikes first). scripts/check-formula.py sums the formula with exact fractions.
export const DPR_EXACT = { num: 90546632123, den: 2560000000 };
if (!near(TREE_STUN_FIRST.ev, DPR_EXACT.num / DPR_EXACT.den, 1e-12) || !near(STATS.stunVex.dpr, DPR_EXACT.num / DPR_EXACT.den, 1e-12)) throw new Error("the formula's exact DPR must match the tree and the engine");

// ---------------- beyond the average: how much one turn swings ----------------
// Read straight off the engine's full damage distribution, then re-derived by hand from the same array.
export const KILL_HP = 40;
const spreadOf = (k: "vexStun" | "stunVex") => {
  const p = TURNS[k].pmf;
  return { p10: p.quantile(0.1), p50: p.quantile(0.5), p90: p.quantile(0.9), atLeast: p.tailProbGE(KILL_HP), sd: p.stdev() };
};
export const SPREAD = { stunVex: spreadOf("stunVex"), vexStun: spreadOf("vexStun") };
{
  const a = STUN_PMF.stunVex;
  const q = (t: number) => { let c = 0; for (let v = 0; v < a.length; v++) if ((c += a[v]) >= t - 1e-12) return v; return a.length - 1; };
  const tail = a.slice(KILL_HP).reduce((x, y) => x + y, 0);
  const s = SPREAD.stunVex;
  if (q(0.1) !== s.p10 || q(0.5) !== s.p50 || q(0.9) !== s.p90 || !near(tail, s.atLeast)) throw new Error("spread must match the distribution");
}
