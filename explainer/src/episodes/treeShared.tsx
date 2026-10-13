import React from "react";
import { COMBOS, TREE, TREE_STUN_FIRST, layoutTree, type TreeNode } from "../stunData";
import { C, F, Text, clamp01, lerp } from "../kit";
import { SNEAK, VEX } from "./monkShared";

// The whole turn as a tree: one column per attack, every miss / hit / crit path, every save split.
export const STUN = "#ff8f8f";
export const TR = { left: 170, right: 1750, top: 250, bottom: 830 };
const model = (tree: TreeNode) => {
  const layout = layoutTree(tree, TR.top, TR.bottom);
  const parents = new Map<TreeNode, TreeNode>();
  const visit = (n: TreeNode) => n.children.forEach((c) => { parents.set(c, n); visit(c); });
  visit(tree);
  return { tree, layout, parents, all: layout.byDepth.flat(), pMax: layout.byDepth.map((nodes) => Math.max(...nodes.map((n) => n.p))) };
};
const MODELS = { vexStun: model(TREE), stunVex: model(TREE_STUN_FIRST) };
type Order = keyof typeof MODELS;
const layout = MODELS.vexStun.layout;
export const PATHS = layout.leaves;
export const PATHS_STUN_FIRST = MODELS.stunVex.layout.leaves;
export const PATHS_BY_DEPTH = layout.byDepth.map((d) => d.length);
export const colX = (d: number) => lerp(TR.left, TR.right, d / 5);
/** Where each tree's root dot sits. */
export const ROOT_Y: Record<Order, number> = { vexStun: TREE.y, stunVex: TREE_STUN_FIRST.y };
const OUT_COLOR = { miss: C.miss, hit: C.hit, crit: C.crit } as const;

const COL = {
  sword: { name: "Shortsword", tag: "Vex", color: VEX },
  scimitar: { name: "Scimitar", tag: "Nick", color: C.crit },
  fist: { name: "Unarmed Strike", tag: "Stun", color: STUN },
};
export const COLUMNS = [COL.sword, COL.sword, COL.scimitar, COL.fist, COL.fist].map((c, i) => ({ ...c, id: "ABCDE"[i] }));
const COLUMNS_BY_ORDER: Record<Order, { id: string; name: string; tag: string; color: string }[]> = {
  vexStun: COLUMNS,
  stunVex: [COLUMNS[3], COLUMNS[4], COLUMNS[0], COLUMNS[1], COLUMNS[2]],
};

/**
 * `grow[d]` (0..1) draws the edges into depth d. `fold` (0..5) collapses the tree right to left:
 * depth d has folded into its parent once fold passes 6 - d. `marks` shows advantage / Sneak / save marks.
 */
export const Tree: React.FC<{ grow: number[]; fold?: number; marks?: { adv: number; sneak: number; save: number }; opacity?: number; headers?: number[]; order?: Order }> = ({ grow, fold = 0, marks = { adv: 0, sneak: 0, save: 0 }, opacity = 1, headers = [], order = "vexStun" }) => {
  const { tree, parents, all, pMax } = MODELS[order];
  const k = (d: number) => clamp01(fold - (5 - d)); // how far depth d has folded into its parent
  const pos = new Map<TreeNode, { x: number; y: number }>();
  const at = (n: TreeNode): { x: number; y: number } => {
    const hit = pos.get(n);
    if (hit) return hit;
    const own = { x: colX(n.depth), y: n.y };
    const parent = parents.get(n);
    const p = parent ? at(parent) : own;
    const f = n.depth ? k(n.depth) : 0;
    const out = { x: lerp(own.x, p.x, f), y: lerp(own.y, p.y, f) };
    pos.set(n, out);
    return out;
  };
  const under: React.ReactNode[] = [];
  const edges: React.ReactNode[] = [];
  const dots: React.ReactNode[] = [];
  all.forEach((n, i) => {
    if (!n.depth) return;
    const g = grow[n.depth - 1] ?? 0;
    if (g <= 0) return;
    const a = at(parents.get(n)!), b = at(n);
    const end = { x: lerp(a.x, b.x, g), y: lerp(a.y, b.y, g) };
    const rel = Math.sqrt(n.p / pMax[n.depth]);
    const w = 0.7 + 3.3 * rel;
    if (n.adv && marks.adv > 0) under.push(<line key={`u${i}`} x1={a.x} y1={a.y} x2={end.x} y2={end.y} stroke={VEX} strokeWidth={w + 1.5 + 4 * rel} strokeLinecap="round" opacity={(0.08 + 0.3 * rel) * marks.adv} />);
    edges.push(<line key={`e${i}`} x1={a.x} y1={a.y} x2={end.x} y2={end.y} stroke={OUT_COLOR[n.outcome!]} strokeWidth={w} strokeLinecap="round" opacity={0.3 + 0.7 * rel} />);
    if (g >= 1 && n.sneak && marks.sneak > 0) dots.push(<circle key={`s${i}`} cx={b.x} cy={b.y} r={2 + 3 * rel} fill={SNEAK} opacity={marks.sneak} />);
    if (g >= 1 && n.save && marks.save > 0) dots.push(<circle key={`v${i}`} cx={b.x} cy={b.y} r={2 + 3 * rel} fill={n.save === "fail" ? STUN : C.fg} opacity={marks.save} />);
  });
  const root = at(tree);
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      {COLUMNS_BY_ORDER[order].map((c, i) => (
        <div key={c.id} style={{ opacity: (headers[i] ?? 0) * (1 - k(i + 1)) }}>
          <Text x={colX(i + 1)} y={TR.top - 92} w={240} size={30} weight={700}>{c.name}</Text>
          <div style={{ position: "absolute", left: colX(i + 1) - 40, top: TR.top - 50, width: 80, textAlign: "center", fontFamily: F.mono, fontSize: 20, color: c.color, border: `1.5px solid ${c.color}`, borderRadius: 999, padding: "1px 0" }}>{c.tag}</div>
        </div>
      ))}
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        {under}
        {edges}
        {dots}
        <circle cx={root.x} cy={root.y} r={9} fill={C.fg} />
      </svg>
    </div>
  );
};

export const COMBO_TOTAL = COMBOS[COMBOS.length - 1].total;
/** Every digit: 7,916,483,719,987,200,000,000,000. Exact (BigInt) at each column's end. */
export const COMBO_DIGITS = COMBOS[COMBOS.length - 1].exact.toLocaleString("en-US");
