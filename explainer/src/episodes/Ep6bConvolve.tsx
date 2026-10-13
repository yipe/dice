import React from "react";
import { Easing, useCurrentFrame } from "remotion";
import { BUILD } from "../advancedData";
import { C, F, Fulcrum, Stage, Text, clamp01, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { f2 } from "./monkShared";

// Convolution, before Part 7 does it five times: the two shortswords as a square. Each side is one attack's results,
// laid out by chance (miss 35%, eight hits at 7.5%, fifteen crit totals sharing 5%). Each rectangle is one pair:
// its area is the product of the two chances, and its total is the sum of the two damages. Pouring every rectangle
// into the bucket for its total gives the two-attack distribution, which must equal Part 7's BUILD[1].

export const EP6B_DURATION = 880;
const T = { strips: 10, grid: 100, corner: 210, block: 300, pick: 400, pour: 490, humps: 640, hump2: 695, mean: 760 } as const;
const PICK = 13;

type Seg = { v: number; p: number; kind: "miss" | "hit" | "crit" };
const segs: Seg[] = [{ v: 0, p: 7 / 20, kind: "miss" }];
for (let d = 1; d <= 8; d++) segs.push({ v: d + 4, p: 12 / 20 / 8, kind: "hit" });
for (let s = 2; s <= 16; s++) segs.push({ v: s + 4, p: (1 / 20) * ((8 - Math.abs(s - 9)) / 64), kind: "crit" });

const S = 560;
const G = { left: 440, top: 330 };
const offs: number[] = [];
segs.reduce((acc, s) => (offs.push(acc), acc + s.p), 0);
const at = (i: number) => offs[i] * S;
const len = (i: number) => segs[i].p * S;

// every pair, its chance and total; how many of the two landed decides its colour
// like Part 1's grid, every box with the same total shares a colour (5 = cool blue up to 24 = warm orange)
// neighbouring totals alternate light and dark, so the diagonals read as stripes
const totalColor = (v: number, a = 1) => `hsla(${Math.round(205 - ((v - 5) / 19) * 175)}, 80%, ${v % 2 ? 72 : 58}%, ${a})`;
const LABEL_MIN = 14; // boxes thinner than this (the crit slivers) are too small for a number
type Cell = { i: number; j: number; p: number; v: number; land: number };
const cells: Cell[] = [];
segs.forEach((a, i) => segs.forEach((b, j) => cells.push({ i, j, p: a.p * b.p, v: a.v + b.v, land: (a.kind !== "miss" ? 1 : 0) + (b.kind !== "miss" ? 1 : 0) })));

// the buckets, stacked bottom to top: neither lands, one lands, both land (so each hump lights up as a block)
const MAX_V = 40;
const bucket = new Array(MAX_V + 1).fill(0) as number[];
const B = { left: 1080, right: 1830, base: 890, h: 470 };
// once everything has poured, the chart glides to the middle of the stage
const SHIFT = 960 - (B.left + B.right) / 2;
const bw = (B.right - B.left) / (MAX_V + 1);
const P_MAX = 7 / 20 * (7 / 20);
const hOf = (p: number) => (p / P_MAX) * B.h;
const order = [...cells].sort((a, b) => a.land - b.land || a.i - b.i || a.j - b.j);
const target = new Map<Cell, { x: number; y: number; h: number }>();
for (const c of order) {
  const h = hOf(c.p);
  target.set(c, { x: B.left + c.v * bw, y: B.base - hOf(bucket[c.v]) - h, h });
  bucket[c.v] += c.p;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
if (!near(segs.reduce((a, s) => a + s.p, 0), 1)) throw new Error("one attack's results must total 100%");
if (bucket.some((p, v) => !near(p, BUILD[1][v] ?? 0)) || BUILD[1].length - 1 > MAX_V) throw new Error("the square must pour into Part 7's two-attack buckets");
// each hump's label sits above its tallest bucket: one sword lands (5 to 12), both land (10 and up)
const onlyLand = (n: number) => { const a = new Array(MAX_V + 1).fill(0) as number[]; cells.forEach((c) => c.land === n && (a[c.v] += c.p)); return a; };
const peakOf = (a: number[]) => a.indexOf(Math.max(...a));
const HUMP_LABELS = [1, 2].map((n) => { const a = onlyLand(n); const v = peakOf(a); return { v, top: bucket[v], text: n === 1 ? "one sword lands" : "both swords land" }; });
const MEAN = bucket.reduce((a, p, v) => a + p * v, 0);
const PICK_P = bucket[PICK];
const PICK_N = cells.filter((c) => c.v === PICK).length;

export const CAPTIONS: Caption[] = [
  { from: 0, to: T.grid, text: "Take both shortswords. Each one misses, hits or crits." },
  { from: T.grid, to: T.corner, text: "Lay one along the top and one down the side. Each rectangle is one pair of results, and its area is their chance: the two chances multiplied." },
  { from: T.corner, to: T.block, text: `Both miss: 35% × 35% = ${pct(P_MAX, 2)} of turns deal 0. That's the top-left corner.` },
  { from: T.block, to: T.pick, text: "Both hit: that block is Part 1's 8 by 8 grid again, so equal totals line up on diagonals." },
  { from: T.pick, to: T.pour, text: `Every rectangle that adds up to ${PICK} lands in the same bucket: ${PICK_N} pairs, ${pct(PICK_P, 2)} of turns in all.` },
  { from: T.pour, to: T.humps, text: "Pour every rectangle into the bucket for its total. That's convolution: multiply every pair, then add them up by total." },
  { from: T.humps, to: T.mean, text: "One sword landing makes the left hump, both landing make the right one." },
  { from: T.mean, to: EP6B_DURATION + 1, text: `And the average simply adds: ${f2(MEAN / 2)} + ${f2(MEAN / 2)} = ${f2(MEAN)}. The next part repeats this for every attack.` },
];

export const Ep6bConvolve: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const strips = sp(T.strips);
  const corner = frame >= T.corner && frame < T.block ? 1 : 0;
  const block = frame >= T.block && frame < T.pick ? 1 : 0;
  const pick = frame >= T.pick && frame < T.pour + 20;
  // the two humps light up in turn: one sword landing, then both
  const humps = frame >= T.humps && frame < T.hump2 ? 1 : frame >= T.hump2 && frame < T.mean ? 2 : 0;
  const chart = sp(T.pour - 20);
  const grid = (i: number, j: number) => clamp01((frame - T.grid - (i + j) * 1.6) / 18);
  const labelFade = 1 - ramp(frame, T.pour, T.pour + 30);
  const dx = SHIFT * Easing.inOut(Easing.cubic)(ramp(frame, T.humps - 25, T.humps + 15));
  const strip = (horizontal: boolean) =>
    segs.map((s, i) => (
      <rect key={`${horizontal}-${i}`} x={horizontal ? G.left + at(i) : G.left - 34} y={horizontal ? G.top - 34 : G.top + at(i)} width={horizontal ? Math.max(0.6, len(i) - 1) : 24} height={horizontal ? 24 : Math.max(0.6, len(i) - 1)} fill={C[s.kind]} opacity={0.85} />
    ));
  const groupLabel = (kind: Seg["kind"], text: string) => {
    const idx = segs.map((s, i) => (s.kind === kind ? i : -1)).filter((i) => i >= 0);
    return { from: at(idx[0]), to: at(idx[idx.length - 1]) + len(idx[idx.length - 1]), text, kind };
  };
  const groups = [groupLabel("miss", "miss 35%"), groupLabel("hit", "hit 60%: 5 to 12"), groupLabel("crit", "crit 5%")];
  return (
    <Stage part="Combining Attacks: Convolution" captions={CAPTIONS}>
      {/* axis titles and group labels */}
      <div style={{ opacity: strips * labelFade }}>
        <Text x={G.left + S / 2} y={G.top - 128} w={400} size={30} weight={700}>Shortsword 1</Text>
        <div style={{ position: "absolute", left: G.left - 440, top: G.top + S / 2 - 20, width: 300, textAlign: "center", fontSize: 30, fontWeight: 700, transform: "rotate(-90deg)" }}>Shortsword 2</div>
        {groups.map((g) => (
          <React.Fragment key={g.kind}>
            <div style={{ position: "absolute", left: G.left + g.from, width: Math.max(g.to - g.from, 1), top: G.top - 76, textAlign: g.kind === "crit" ? "left" : "center", fontFamily: F.mono, fontSize: 21, color: C[g.kind], whiteSpace: "nowrap" }}>{g.text}</div>
            <div style={{ position: "absolute", left: G.left - 50 - 220, top: G.top + (g.from + g.to) / 2 - 13, width: 220, textAlign: "right", fontFamily: F.mono, fontSize: 21, color: C[g.kind], whiteSpace: "nowrap" }}>{g.text}</div>
          </React.Fragment>
        ))}
      </div>

      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        <g opacity={strips * labelFade}>
          {strip(true)}
          {strip(false)}
        </g>
        {/* every pair: a rectangle in the square, then a slab in its bucket */}
        {cells.map((c, k) => {
          const g = grid(c.i, c.j);
          if (g <= 0) return null;
          const t = ramp(frame, T.pour + c.v * 2.2, T.pour + c.v * 2.2 + 40);
          const e = t * t * (3 - 2 * t);
          const to = target.get(c)!;
          const x = lerp(G.left + at(c.i), to.x + 1 + dx, e);
          const y = lerp(G.top + at(c.j), to.y, e);
          const w = lerp(len(c.i), bw - 2, e);
          const h = lerp(len(c.j), to.h, e);
          const isPick = c.v === PICK;
          const lit = humps ? (c.land === humps ? 1 : 0.2) : pick ? (isPick ? 1 : 0.18) : corner ? (c.i === 0 && c.j === 0 ? 1 : 0.25) : block ? (segs[c.i].kind === "hit" && segs[c.j].kind === "hit" ? 1 : 0.25) : 1;
          const tinted = c.land > 0 && Math.min(len(c.i), len(c.j)) >= LABEL_MIN;
          const labelled = tinted && e === 0;
          const col = totalColor(c.v);
          return (
            <React.Fragment key={k}>
              {/* coloured by its total, like Part 1's grid: faint in the square, solid once it lands in its bucket */}
              <rect x={x} y={y} width={Math.max(0.5, w - (e < 1 ? 1 : 0))} height={Math.max(0.3, h - (e < 1 ? 1 : 0))}
                fill={pick && isPick ? C.hot : c.v === 0 ? C.miss : totalColor(c.v)} fillOpacity={pick && isPick ? 1 : c.v === 0 ? 1 : lerp(tinted ? 0.3 : 0.55, 0.8, e)} opacity={g * (0.35 + 0.55 * lit)} />
              {labelled && (
                <g opacity={g * labelFade * (0.3 + 0.7 * lit)}>
                  <rect x={x + 1.5} y={y + 1.5} width={w - 4} height={h - 4} rx={3} fill="none" stroke={col} strokeWidth={1.5} />
                  <text x={x + (w - 1) / 2} y={y + (h - 1) / 2 + 6} textAnchor="middle" fontFamily={F.mono} fontSize={17} fontWeight={700} fill={pick && isPick ? "#1a1206" : col}>{c.v}</text>
                </g>
              )}
            </React.Fragment>
          );
        })}
        {/* bucket axis */}
        <line x1={B.left - 6 + dx} x2={B.right + 6 + dx} y1={B.base + 1} y2={B.base + 1} stroke={C.border} strokeWidth={3} opacity={chart} />
      </svg>

      {/* the corner's sum */}
      <div style={{ position: "absolute", left: G.left + at(0) + 16, top: G.top + 16, fontFamily: F.mono, fontSize: 26, fontWeight: 700, color: C.fg, opacity: sp(T.corner) * (1 - ramp(frame, T.block - 10, T.block)) }}>
        35% × 35%<br />= {pct(P_MAX, 2)}<br /><span style={{ color: C.muted, fontWeight: 400 }}>0 damage</span>
      </div>
      {/* the picked total */}
      <div style={{ position: "absolute", left: G.left + S + 40, top: G.top + 40, width: 360, fontFamily: F.mono, fontSize: 26, fontWeight: 700, color: C.hot, opacity: frame >= T.pick ? sp(T.pick) * (1 - ramp(frame, T.pour + 10, T.pour + 30)) : 0 }}>
        {`total ${PICK}`}<br /><span style={{ fontWeight: 400, color: C.muted, fontSize: 22 }}>{`${PICK_N} rectangles add to`}</span><br />{pct(PICK_P, 2)}
      </div>

      {/* the bucket chart */}
      <div style={{ opacity: chart, transform: `translateX(${dx}px)` }}>
        {Array.from({ length: MAX_V / 5 + 1 }, (_, i) => i * 5).map((v) => (
          <Text key={v} x={B.left + (v + 0.5) * bw} y={B.base + 12} w={60} size={22} mono color={C.muted}>{v}</Text>
        ))}
        <Text x={B.right} y={B.base + 46} w={500} align="right" size={24} color={C.muted}>damage from both swords</Text>
        {HUMP_LABELS.map((l, k) => (
          // the left hump's label ends over its peak; the right hump's starts just past its left edge, clear of the taller left hump
          <Text key={l.text} x={k ? B.left + 14 * bw : B.left + (l.v + 1) * bw} y={B.base - hOf(k ? Math.max(bucket[12], l.top) : l.top) - 44} w={300} align={k ? "left" : "right"} size={26} weight={700} color={C.fg} opacity={humps === k + 1 ? sp(k ? T.hump2 : T.humps) : 0}>{l.text}</Text>
        ))}
      </div>
      <Fulcrum x={B.left + (MEAN + 0.5) * bw + dx} y={B.base + 40} label={`${f2(MEAN)} DPR`} opacity={sp(T.mean)} />
    </Stage>
  );
};
