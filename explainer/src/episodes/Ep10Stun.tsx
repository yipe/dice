import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { SAVE, SAVE_FAIL, STATS, STUN_PMF } from "../stunData";
import { C, F, Stage, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { Cards, DprShift, TB, TurnBuckets, VEX, f2 } from "./monkShared";
import { STUN } from "./treeShared";

export const EP10_DURATION = 600;
const T = { cards: 0, lands: 80, save: 120, split: 190, either: 300, late: 350, buckets: [410, 440], morph: [450, 520] } as const;
const S = STATS.vexStun;
const D_LANDS = S.land[3];

export const CAPTIONS: Caption[] = [
  { from: 0, to: 80, text: "Now what if we tried Stunning Strike on an Unarmed Strike hit?" },
  { from: 80, to: 190, text: `Stunning Strike needs two things: an Unarmed Strike hit, then a failed Constitution save. The target fails ${pct(SAVE_FAIL, 0)} of the time.` },
  { from: 190, to: 300, text: "Fail: it is stunned. Pass: the next attack still gets advantage." },
  { from: 300, to: 410, text: `Either way, only the second Unarmed Strike is left to benefit: advantage ${pct(S.adv[4], 0)} of the time.` },
  { from: 410, to: EP10_DURATION + 1, text: `The buckets shift right again: ${f2(STATS.vex.dpr)} becomes ${f2(S.dpr)}.` },
];

const Box: React.FC<{ x: number; y: number; w: number; color: string; opacity: number; children: React.ReactNode }> = ({ x, y, w, color, opacity, children }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, padding: "16px 22px", boxSizing: "border-box", borderRadius: 14, background: C.elevated, border: `2px solid ${color}`, opacity, transform: `translateY(${(1 - opacity) * 14}px)`, fontSize: 28, lineHeight: 1.35 }}>{children}</div>
);
const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; color: string; opacity: number }> = ({ x1, y1, x2, y2, color, opacity }) => (
  <svg style={{ position: "absolute", left: 0, top: 0, opacity }} width={1920} height={1080}>
    <defs><marker id={`h${color.slice(1)}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={color} /></marker></defs>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={3} markerEnd={`url(#h${color.slice(1)})`} />
  </svg>
);

export const Ep10Stun: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const flowOut = 1 - ramp(frame, T.buckets[0], T.buckets[1]);
  const morph = interpolate(frame, [T.morph[0], T.morph[1]], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const cur = STUN_PMF.vex.map((p, v) => lerp(p, STUN_PMF.vexStun[v], morph));
  const K = (0.92 * (TB.base - TB.top)) / Math.max(...STUN_PMF.vex, ...STUN_PMF.vexStun);
  const eMeter = ramp(frame, T.either, T.either + 40);
  const meters = STATS.vex.adv.map((a, i) => (i === 4 ? S.adv[4] * eMeter : a));

  return (
    <Stage part="Part 10: Stunning Strike: Branching on a Save" captions={CAPTIONS}>
      <Cards appear={() => sp(T.cards)} lit={(i) => (i === 3 && frame >= T.lands && frame < T.either) || (i === 4 && frame >= T.either && frame < T.buckets[0])} meters={meters} meterOpacity={1}
        extra={(i) => (i >= 3 ? { label: "Stun", color: STUN, opacity: sp(T.cards + 10) } : undefined)} />

      {flowOut > 0 && (
        <div style={{ opacity: flowOut }}>
          <Box x={200} y={600} w={330} color={C.hit} opacity={sp(T.lands)}>
            <div style={{ fontWeight: 700 }}>First Unarmed Strike hits</div>
            <div style={{ fontFamily: F.mono, fontSize: 30, color: C.hit }}>{pct(D_LANDS, 0)}</div>
          </Box>
          <Arrow x1={540} y1={655} x2={610} y2={655} color={C.muted} opacity={sp(T.save)} />
          <Box x={620} y={590} w={400} color={C.borderStrong} opacity={sp(T.save)}>
            <div style={{ fontWeight: 700 }}>Constitution save</div>
            <div style={{ fontFamily: F.mono, fontSize: 26, color: C.muted }}>{`d20 + ${SAVE.con} vs DC ${SAVE.dc}`}</div>
          </Box>
          <Arrow x1={1030} y1={630} x2={1110} y2={555} color={STUN} opacity={sp(T.split)} />
          <Arrow x1={1030} y1={685} x2={1110} y2={760} color={VEX} opacity={sp(T.split)} />
          <Box x={1120} y={490} w={620} color={STUN} opacity={sp(T.split)}>
            <div><b style={{ color: STUN }}>{`Fails ${pct(SAVE_FAIL, 0)}:`}</b> Stunned until the start of your next turn.</div>
            <div style={{ color: C.muted, fontSize: 24 }}>Every attack against it has advantage.</div>
          </Box>
          <Box x={1120} y={710} w={620} color={VEX} opacity={sp(T.split + 12)}>
            <div><b style={{ color: VEX }}>{`Passes ${pct(1 - SAVE_FAIL, 0)}:`}</b> not stunned.</div>
            <div style={{ color: C.muted, fontSize: 24 }}>Your next attack still has advantage.</div>
          </Box>
          <div style={{ position: "absolute", left: 200, top: 800, width: 820, fontSize: 28, lineHeight: 1.45, opacity: sp(T.either) }}>
            <div>Either way, <b style={{ color: VEX }}>the second Unarmed Strike rolls with advantage</b>.</div>
            <div style={{ color: C.muted, fontSize: 24, opacity: sp(T.late) }}>Stunning Strike is once per turn. If the first Unarmed Strike misses, the second one tries it, but no attack is left to benefit.</div>
          </div>
        </div>
      )}

      {frame >= T.buckets[0] && (
        <TurnBuckets opacity={ramp(frame, T.buckets[0], T.buckets[1])} K={K}
          layers={[{ arr: cur.map((p, v) => Math.min(p, STUN_PMF.vex[v])), color: C.accent }, { arr: cur.map((p, v) => Math.max(0, p - STUN_PMF.vex[v])), color: STUN }]} />
      )}
      {frame >= T.buckets[0] && <DprShift from={STATS.vex.dpr} to={S.dpr} morph={morph} done={ramp(frame, T.morph[1], T.morph[1] + 14)} color={STUN} opacity={ramp(frame, T.buckets[0], T.buckets[1])} />}
    </Stage>
  );
};
