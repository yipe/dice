import React from "react";
import { useCurrentFrame } from "remotion";
import { KILL_HP, ROW_LABEL, SPREAD, STATS, STUN_PMF, advCount, type TurnKey } from "../stunData";
import { C, F, Stage, pct, ramp, useSp, type Caption } from "../kit";
import { SNEAK, VEX, f2 } from "./monkShared";
import { STUN } from "./treeShared";

export const EP12_DURATION = 800;
const ROWS: TurnKey[] = ["normal", "vex", "vexStun", "stunVex"];
const T = { header: 30, rows: 90, step: 55, best: 340, out: [470, 510], dist: 510, band: 600, tail: 680 } as const;
const BEST: TurnKey = "stunVex";
const gain = STATS.stunVex.dpr - STATS.vexStun.dpr;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 90, text: "So which turn is best? Ask @yipe/dice." },
  { from: 90, to: 340, text: "Every number here is computed, not simulated or guessed." },
  { from: 340, to: 470, text: `Unarmed Strikes first is worth ${f2(gain)} more damage per round, every round.` },
  { from: 470, to: 600, text: "But an average hides the swing. Here is every total the best turn can deal, and how likely each one is." },
  { from: 600, to: 680, text: `Most turns land between ${SPREAD.stunVex.p10} and ${SPREAD.stunVex.p90} damage. The middle turn deals ${SPREAD.stunVex.p50}.` },
  { from: 680, to: EP12_DURATION + 1, text: `Need ${KILL_HP} damage to drop a foe? This turn gets there ${pct(SPREAD.stunVex.atLeast, 1)} of the time (${pct(SPREAD.vexStun.atLeast, 1)} with Unarmed Strikes last).` },
];

const COLS = [
  { key: "turn", label: "Turn", w: 290 },
  { key: "dpr", label: "Damage per round", w: 560 },
  { key: "crit", label: "At least one crit", w: 220 },
  { key: "sneak", label: "Sneak Attack lands", w: 220 },
  { key: "stun", label: "Stunned, attacks left", w: 210 },
  { key: "adv", label: "Rolls with advantage", w: 220 },
];
const X0 = 140;
const colLeft = (i: number) => X0 + COLS.slice(0, i).reduce((a, c) => a + c.w, 0);
const ROW_H = 112, TOP = 300;
const DPR_MAX = Math.max(...ROWS.map((k) => STATS[k].dpr));

export const Ep12Compare: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  return (
    <Stage part="Part 12: Comparing Turns" captions={CAPTIONS}>
      <div style={{ position: "absolute", inset: 0, opacity: 1 - ramp(frame, T.out[0], T.out[1]), transform: `translateY(${-60 * ramp(frame, T.out[0], T.out[1])}px)` }}>
      {COLS.map((c, i) => (
        <div key={c.key} style={{ position: "absolute", left: colLeft(i), top: TOP - 66, width: c.w - 16, fontSize: 24, color: C.muted, textAlign: i === 0 ? "left" : i === 1 ? "left" : "right", opacity: sp(T.header), lineHeight: 1.15 }}>{c.label}</div>
      ))}
      {ROWS.map((k, r) => {
        const s = STATS[k];
        const a = sp(T.rows + r * T.step);
        const best = k === BEST && frame >= T.best;
        const y = TOP + r * ROW_H;
        const barW = 380 * (s.dpr / DPR_MAX) * ramp(frame, T.rows + r * T.step, T.rows + r * T.step + 30);
        const cell = (i: number, text: string, color: string) => (
          <div style={{ position: "absolute", left: colLeft(i), top: y + 30, width: COLS[i].w - 16, textAlign: "right", fontFamily: F.mono, fontSize: 34, fontWeight: 600, color }}>{text}</div>
        );
        return (
          <div key={k} style={{ opacity: a, transform: `translateX(${(1 - a) * -30}px)` }}>
            <div style={{ position: "absolute", left: X0 - 20, top: y, width: colLeft(COLS.length) - X0 + 20, height: ROW_H - 12, borderRadius: 14, background: best ? `${C.hot}14` : r % 2 ? "#ffffff06" : "transparent", border: `2px solid ${best ? C.hot : "transparent"}`, boxShadow: best ? `0 0 30px ${C.hot}33` : undefined }} />
            <div style={{ position: "absolute", left: colLeft(0), top: y + 28, fontSize: 36, fontWeight: 700, color: best ? C.hot : C.fg }}>{ROW_LABEL[k]}</div>
            <div style={{ position: "absolute", left: colLeft(1), top: y + 30, width: barW, height: 40, borderRadius: 8, background: best ? `${C.hot}66` : `${C.accent}55`, border: `2px solid ${best ? C.hot : C.accent}` }} />
            <div style={{ position: "absolute", left: colLeft(1) + barW + 16, top: y + 28, fontFamily: F.mono, fontSize: 38, fontWeight: 700, color: best ? C.hot : C.fg }}>{f2(s.dpr)}</div>
            {cell(2, pct(s.anyCrit, 2), C.crit)}
            {cell(3, pct(s.sneak, 2), SNEAK)}
            {cell(4, k === "vexStun" || k === "stunVex" ? pct(s.stunned, 2) : "n/a", k === "vexStun" || k === "stunVex" ? STUN : C.muted)}
            {cell(5, f2(advCount(k)), advCount(k) > 0 ? VEX : C.muted)}
          </div>
        );
      })}
      </div>
      {frame >= T.out[0] && <Spread frame={frame} />}
    </Stage>
  );
};

// ---------- beyond the average: the best turn's whole distribution ----------
const D = { left: 200, right: 1720, base: 880, h: 440 };
const DIST = STUN_PMF.stunVex;
const LAST = DIST.reduce((m, p, v) => (p > 1e-5 ? v : m), 0); // past this, bars are too thin to see
const P_MAX = Math.max(...DIST);
const bw = (D.right - D.left) / (LAST + 1);
const dx = (v: number) => D.left + v * bw;

const Spread: React.FC<{ frame: number }> = ({ frame }) => {
  const sp = useSp();
  const show = sp(T.dist);
  const band = sp(T.band);
  const tail = sp(T.tail);
  const s = SPREAD.stunVex;
  const mean = STATS.stunVex.dpr;
  const inBand = (v: number) => v >= s.p10 && v <= s.p90;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: show }}>
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        {/* the typical range, 10th to 90th percentile */}
        <rect x={dx(s.p10)} y={D.base - D.h - 40} width={dx(s.p90 + 1) - dx(s.p10)} height={D.h + 40} fill={C.accent} opacity={0.1 * band} />
        {DIST.slice(0, LAST + 1).map((p, v) => {
          const h = (p / P_MAX) * D.h * ramp(frame, T.dist + v * 0.6, T.dist + 30 + v * 0.6);
          const hot = v >= KILL_HP && tail > 0;
          const col = hot ? C.hot : inBand(v) && band > 0 ? C.accent : "#8fa3c4";
          return <rect key={v} x={dx(v) + 1} y={D.base - h} width={Math.max(1, bw - 2)} height={h} rx={2} fill={col} opacity={hot ? 0.45 + 0.5 * tail : 0.75} />;
        })}
        <line x1={D.left} x2={D.right} y1={D.base} y2={D.base} stroke={C.muted} strokeWidth={2} opacity={0.6} />
        {/* the average, for reference */}
        <line x1={dx(mean + 0.5)} x2={dx(mean + 0.5)} y1={D.base - D.h - 50} y2={D.base} stroke={C.fg} strokeWidth={2} strokeDasharray="6 6" opacity={0.8} />
      </svg>
      {Array.from({ length: Math.floor(LAST / 10) + 1 }, (_, i) => i * 10).map((v) => (
        <div key={v} style={{ position: "absolute", left: dx(v + 0.5) - 30, top: D.base + 10, width: 60, textAlign: "center", fontFamily: F.mono, fontSize: 22, color: C.muted }}>{v}</div>
      ))}
      <div style={{ position: "absolute", left: D.left, right: 1920 - D.right, top: D.base + 44, textAlign: "center", fontSize: 24, color: C.muted }}>damage this turn (Unarmed Strikes first)</div>
      <div style={{ position: "absolute", left: dx(mean + 0.5) - 150, top: D.base - D.h - 92, width: 300, textAlign: "center", fontFamily: F.mono, fontSize: 26, color: C.fg }}>{`average ${f2(mean)}`}</div>
      <div style={{ position: "absolute", left: dx(s.p10), width: dx(s.p90 + 1) - dx(s.p10), top: D.base - D.h - 40 + 10, textAlign: "center", fontSize: 26, fontWeight: 600, color: C.accent, opacity: band }}>
        <span style={{ background: C.surface, padding: "0 10px", borderRadius: 8 }}>{`most turns: ${s.p10} to ${s.p90}`}</span>
      </div>
      <div style={{ position: "absolute", left: dx(KILL_HP + 15), top: D.base - D.h * 0.5, fontFamily: F.mono, fontSize: 34, fontWeight: 700, color: C.hot, opacity: tail }}>
        {`${KILL_HP}+ damage: ${pct(s.atLeast, 1)}`}
        <div style={{ fontSize: 22, fontWeight: 400, color: C.muted, marginTop: 6 }}>{`${pct(SPREAD.vexStun.atLeast, 1)} with Unarmed Strikes last`}</div>
      </div>
    </div>
  );
};
