import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { SAVE_FAIL, STATS, STUN_PMF, advCount } from "../stunData";
import { AT_AC } from "../attackData";
import { C, F, Stage, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { Cards, DprShift, SNEAK, TB, TurnBuckets, VEX, f2 } from "./monkShared";
import { STUN } from "./treeShared";

export const EP11_DURATION = 770;
const T = { cards: 0, reorder: [70, 130], meters: 190, tree: 200, treeOut: [335, 355], tiles: 355, sneak: 450, buckets: [570, 600], morph: [610, 690] } as const;
const A = STATS.vexStun, B = STATS.stunVex;
// stunVex's attacks run D, E, A, B, C; map them back to the cards' A..E
const FROM_ORDER = [2, 3, 4, 0, 1];
const advB = FROM_ORDER.map((j) => B.adv[j]);

export const CAPTIONS: Caption[] = [
  { from: 0, to: 130, text: "But what if the Unarmed Strikes, and Stunning Strike, came first?" },
  { from: 130, to: 200, text: "Bonus Action first: Stunning Strike is tried once, on the first Unarmed Strike that hits, before any weapon attack." },
  { from: 200, to: 355, text: `A stun now lands ${pct(B.stunned, 2)} of the time, with weapon attacks still to come.` },
  { from: 355, to: 450, text: `And more attacks roll with advantage: ${f2(advCount("vexStun"))} per turn becomes ${f2(advCount("stunVex"))}.` },
  { from: 450, to: 570, text: `Even Sneak Attack lands more often: ${pct(A.sneak, 2)} becomes ${pct(B.sneak, 2)}.` },
  { from: 570, to: EP11_DURATION + 1, text: `Same dice, new order: ${f2(A.dpr)} becomes ${f2(B.dpr)}.` },
];

// Two ways to stun before any weapon attack: D hits and the save fails, or D misses, E hits and the save fails.
// Stunning Strike is once per turn on the first unarmed hit, so E only tries it when D missed (and then E has no advantage).
const land = 1 - AT_AC.odds.miss, miss = AT_AC.odds.miss;
const PATHS = { dStun: land * SAVE_FAIL, dPass: land * (1 - SAVE_FAIL), eStun: miss * land * SAVE_FAIL, ePass: miss * land * (1 - SAVE_FAIL), none: miss * miss };
if (Math.abs(PATHS.dStun + PATHS.eStun - B.stunned) > 1e-12) throw new Error("Part 11 stun tree != engine");
if (Math.abs(Object.values(PATHS).reduce((a, b) => a + b, 0) - 1) > 1e-12) throw new Error("Part 11 stun tree must total 100%");

const StunTree: React.FC<{ frame: number; sp: (f: number) => number; opacity: number }> = ({ frame, sp, opacity }) => {
  const X = { root: 250, d: 560, e: 860, leaf: 1160 };
  const Y = { root: 700, d: 545, dm: 815, e: 770 };
  const leaves = [
    { from: [X.d, Y.d], y: 500, p: PATHS.dStun, stun: true, edge: `save fails ${pct(SAVE_FAIL, 0)}`, note: "stunned" },
    { from: [X.d, Y.d], y: 590, p: PATHS.dPass, stun: false, edge: `passes ${pct(1 - SAVE_FAIL, 0)}`, note: "not stunned" },
    { from: [X.e, Y.e], y: 725, p: PATHS.eStun, stun: true, edge: `save fails ${pct(SAVE_FAIL, 0)}`, note: "stunned" },
    { from: [X.e, Y.e], y: 815, p: PATHS.ePass, stun: false, edge: `passes ${pct(1 - SAVE_FAIL, 0)}`, note: "not stunned" },
    { from: [X.d, Y.dm], y: 905, p: PATHS.none, stun: false, edge: `2nd misses ${pct(miss, 0)}`, note: "no hit, no Stunning Strike" },
  ] as const;
  const oA = sp(T.tree), oB = sp(T.tree + 25), oC = sp(T.tree + 50), oS = sp(T.tree + 80);
  const edge = (x1: number, y1: number, x2: number, y2: number, color: string, label: string, o: number, glow = false) => (
    <g opacity={o}>
      {glow && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={STUN} strokeWidth={12} strokeLinecap="round" opacity={0.22} />}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={3} strokeLinecap="round" />
      <text x={(x1 + x2) / 2 - 8} y={(y1 + y2) / 2 + (y2 < y1 ? -14 : 32)} textAnchor="end" fontFamily={F.mono} fontSize={24} fontWeight={700} fill={color}>{label}</text>
    </g>
  );
  const bx = X.leaf + 330;
  return (
    <div style={{ opacity }}>
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        {edge(X.root, Y.root, X.d, Y.d, C.hit, `1st hits ${pct(land, 0)}`, oA, true)}
        {edge(X.root, Y.root, X.d, Y.dm, C.miss, `1st misses ${pct(miss, 0)}`, oA)}
        {edge(X.d, Y.dm, X.e, Y.e, C.hit, `2nd hits ${pct(land, 0)}`, oB, true)}
        {leaves.map((l, i) => edge(l.from[0], l.from[1], X.leaf, l.y, l.stun ? STUN : C.miss, l.edge, i < 2 ? oB : oC, l.stun))}
        <circle cx={X.root} cy={Y.root} r={8} fill={C.fg} opacity={oA} />
        {[[X.d, Y.d], [X.d, Y.dm]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={7} fill={C.fg} opacity={oA} />)}
        <circle cx={X.e} cy={Y.e} r={7} fill={C.fg} opacity={oB} />
        {leaves.map((l, i) => <circle key={i} cx={X.leaf} cy={l.y} r={7} fill={l.stun ? STUN : C.miss} opacity={i < 2 ? oB : oC} />)}
        {/* both stunned leaves: a bracket and their sum */}
        <path d={`M ${bx - 22} ${leaves[0].y} H ${bx} V ${leaves[2].y} H ${bx - 22}`} fill="none" stroke={STUN} strokeWidth={3} strokeLinejoin="round" opacity={oS} />
      </svg>
      {leaves.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: X.leaf + 20, top: l.y - 18, fontFamily: F.mono, fontSize: 26, fontWeight: 700, color: l.stun ? STUN : C.muted, opacity: i < 2 ? oB : oC, whiteSpace: "nowrap" }}>
          {pct(l.p, 2)}<span style={{ fontWeight: 400, fontSize: 22 }}>{`  ${l.note}`}</span>
        </div>
      ))}
      <div style={{ position: "absolute", left: bx + 18, top: (leaves[0].y + leaves[2].y) / 2 - 56, fontFamily: F.mono, fontSize: 26, fontWeight: 700, color: STUN, textAlign: "right", opacity: oS, lineHeight: 1.35 }}>
        <div>{pct(PATHS.dStun, 2)}</div>
        <div style={{ borderBottom: `3px solid ${STUN}`, paddingBottom: 4, marginBottom: 6 }}>{`+ ${pct(PATHS.eStun, 2)}`}</div>
        <div>{pct(B.stunned, 2)}</div>
      </div>
      <div style={{ position: "absolute", left: X.root - 60, top: 950, width: 900, fontSize: 24, color: C.muted, opacity: oC, lineHeight: 1.4 }}>
        Once per turn, on the first Unarmed Strike that hits: the 2nd only gets to try when the 1st missed.
      </div>
    </div>
  );
};

const Tile: React.FC<{ x: number; label: string; from: string; to: string; color: string; opacity: number; lit?: boolean; note?: string }> = ({ x, label, from, to, color, opacity, lit, note }) => (
  <div style={{ position: "absolute", left: x, top: 560, width: 470, padding: "20px 26px", boxSizing: "border-box", borderRadius: 16, background: C.elevated, border: `2px solid ${lit ? color : C.borderStrong}`, boxShadow: lit ? `0 0 26px ${color}55` : undefined, opacity, transform: `translateY(${(1 - opacity) * 16}px)` }}>
    <div style={{ fontSize: 26, color: C.muted }}>{label}</div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 12, color: C.muted }}>
      <span style={{ fontSize: 24 }}>stun last</span><span style={{ fontFamily: F.mono, fontSize: 32 }}>{from}</span>
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6, color }}>
      <span style={{ fontSize: 26, fontWeight: 700 }}>stun first</span><span style={{ fontFamily: F.mono, fontSize: 46, fontWeight: 700 }}>{to}</span>
    </div>
    {note && <div style={{ fontSize: 22, color: C.muted, marginTop: 8 }}>{note}</div>}
  </div>
);

export const Ep11StunFirst: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const io = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
  const re = interpolate(frame, [T.reorder[0], T.reorder[1]], [0, 1], io);
  const slot = (i: number) => lerp(i, [2, 3, 4, 0, 1][i], re);
  const m = ramp(frame, T.meters, T.meters + 40);
  const meters = A.adv.map((a, i) => lerp(a, advB[i], m));
  const tilesOut = 1 - ramp(frame, T.buckets[0], T.buckets[1]);
  const morph = interpolate(frame, [T.morph[0], T.morph[1]], [0, 1], io);
  const cur = STUN_PMF.vexStun.map((p, v) => lerp(p, STUN_PMF.stunVex[v], morph));
  const K = (0.92 * (TB.base - TB.top)) / Math.max(...STUN_PMF.vexStun, ...STUN_PMF.stunVex);

  return (
    <Stage part="Part 11: Order Matters: Stun First" captions={CAPTIONS}>
      <Cards appear={() => sp(T.cards)} slot={slot} lit={(i) => i >= 3 && frame >= T.reorder[0] && frame < T.meters} meters={meters} meterOpacity={1}
        extra={(i) => (i >= 3 ? { label: "Stun", color: STUN, opacity: 1 } : undefined)} />

      {frame >= T.tree && frame < T.treeOut[1] && <StunTree frame={frame} sp={sp} opacity={1 - ramp(frame, T.treeOut[0], T.treeOut[1])} />}

      {tilesOut > 0 && frame >= T.tiles - 5 && (
        <div style={{ opacity: tilesOut }}>
          <Tile x={190} label="Stunned, attacks still to come" from={pct(A.stunned, 2)} to={pct(B.stunned, 2)} color={STUN} opacity={sp(T.tiles)} lit={frame >= T.tiles && frame < T.sneak} />
          <Tile x={725} label="Rolls with advantage, per turn" from={f2(advCount("vexStun"))} to={f2(advCount("stunVex"))} color={VEX} opacity={sp(T.tiles + 12)} />
          <Tile x={1260} label="Sneak Attack lands" from={pct(A.sneak, 2)} to={pct(B.sneak, 2)} color={SNEAK} opacity={sp(T.sneak)} lit={frame >= T.sneak} />
        </div>
      )}

      {frame >= T.buckets[0] && (
        <TurnBuckets opacity={ramp(frame, T.buckets[0], T.buckets[1])} K={K}
          layers={[{ arr: cur.map((p, v) => Math.min(p, STUN_PMF.vexStun[v])), color: C.accent }, { arr: cur.map((p, v) => Math.max(0, p - STUN_PMF.vexStun[v])), color: STUN }]} />
      )}
      {frame >= T.buckets[0] && <DprShift from={A.dpr} to={B.dpr} morph={morph} done={ramp(frame, T.morph[1], T.morph[1] + 14)} color={STUN} opacity={ramp(frame, T.buckets[0], T.buckets[1])} />}
    </Stage>
  );
};
