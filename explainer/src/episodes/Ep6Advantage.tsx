import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ADV, DIST_BY_AC, DPR_BY_AC, ROLL_TYPES, type RollType } from "../advancedData";
import { AC, AC_RANGE, BONUS, MAX_DMG, type Bin } from "../attackData";
import { D20 } from "../D20";
import { C, F, Stage, Text, lerp, pct, ramp, useSp, type Caption } from "../kit";

export const EP6_DURATION = 950;
const R1 = 6, R2 = 14, NEED = AC - BONUS;
const T = { roll: [15, 75], keep: 85, eq: 100, clear: 170, grid: 180, color: 275, panel: 290, missBox: 380, critBox: 480, chart: 580, drop: [660, 720], toTen: [740, 780], lines: [790, 920] } as const;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 170, text: "Now let's look at advantage: rolling two d20s and keeping the higher one." },
  { from: 170, to: 275, text: "Two dice make 20 × 20 = 400 equally likely pairs." },
  { from: 275, to: 380, text: "Color each pair by its higher die: miss, hit or crit." },
  { from: 380, to: 480, text: `To miss, both dice must miss: ${pct(ADV.normal.miss, 0)} × ${pct(ADV.normal.miss, 0)} = ${pct(ADV.advantage.miss, 2)}.` },
  { from: 480, to: 580, text: "To crit, you need at least one 20: 1 − 95% × 95% = 9.75%." },
  { from: 580, to: 660, text: "Each roll type has its own damage distribution, and its own DPR." },
  { from: 660, to: 740, text: `At AC ${AC}, advantage lifts DPR from ${ADV.normal.dpr.toFixed(2)} to ${ADV.advantage.dpr.toFixed(2)}.` },
  { from: 740, to: EP6_DURATION + 1, text: "Change the AC: each average traces its line." },
];

type Kind = "miss" | "hit" | "crit";
const kindOf = (n: number): Kind => (n === 20 ? "crit" : n >= NEED ? "hit" : "miss");
const G = { cell: 24, pitch: 26, left: 230, top: 360 };
const cellX = (a: number) => G.left + (a - 1) * G.pitch;
const cellY = (b: number) => G.top + (b - 1) * G.pitch;

// roll-type colours follow the dprcalc dice page (red / gray / green / purple), midnight shades
const RT: Record<RollType, { label: string; color: string }> = {
  disadvantage: { label: "Disadvantage", color: "#ffa0a0" },
  normal: { label: "Normal", color: "#8893a8" },
  advantage: { label: "Advantage", color: "#87dda8" },
  elven: { label: "Advantage (3d20)", color: "#c09bff" },
};

const LC = { left: 330, right: 1380, base: 900, top: 560, max: 10 };
// one small damage distribution per roll type, above the line chart
const MP = { left: 150, w: 380, gap: 30, base: 420, h: 170, K: 170 / 0.13 };
const mpLeft = (i: number) => MP.left + i * (MP.w + MP.gap);
const PITCH = (MP.w - 20) / (MAX_DMG + 1);
const mpX = (i: number, v: number) => mpLeft(i) + 10 + v * PITCH; // left edge of damage v's bar

/** Bins and DPR for a roll type at a fractional AC, blended between whole ACs. */
const distAt = (rt: RollType, ac: number): { bins: Bin[]; dpr: number } => {
  const i = Math.min(AC_RANGE.length - 2, Math.max(0, Math.floor(ac - AC_RANGE[0])));
  const f = Math.min(1, Math.max(0, ac - AC_RANGE[i]));
  const a = DIST_BY_AC[rt][i], b = DIST_BY_AC[rt][i + 1];
  return {
    bins: a.map((x, v) => ({ miss: lerp(x.miss, b[v].miss, f), hit: lerp(x.hit, b[v].hit, f), crit: lerp(x.crit, b[v].crit, f) })),
    dpr: lerp(DPR_BY_AC[rt][i], DPR_BY_AC[rt][i + 1], f),
  };
};
const lx = (ac: number) => lerp(LC.left, LC.right, (ac - AC_RANGE[0]) / (AC_RANGE[AC_RANGE.length - 1] - AC_RANGE[0]));
const ly = (d: number) => lerp(LC.base, LC.top, d / LC.max);

export const Ep6Advantage: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const tt = (start: number, end: number) => interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const t1 = tt(T.roll[0], T.roll[1]);
  const t2 = tt(T.roll[0] + 6, T.roll[1] + 4);
  const top = 1 - ramp(frame, T.clear, T.clear + 15);
  const kept = frame >= T.keep;
  const colored = sp(T.color);
  const midOut = 1 - ramp(frame, T.chart - 15, T.chart);
  const io = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
  // the AC on screen: 15, then down to 10, then the sweep to 25 that draws the lines
  const ac = frame < T.lines[0] ? interpolate(frame, [T.toTen[0], T.toTen[1]], [AC, AC_RANGE[0]], io) : interpolate(frame, [T.lines[0], T.lines[1]], [AC_RANGE[0], AC_RANGE[AC_RANGE.length - 1]], io);
  const sweep = frame >= T.lines[0] ? ac : AC_RANGE[0];
  const drop = interpolate(frame, [T.drop[0], T.drop[1]], [0, 1], io);

  const box = (a0: number, b0: number, a1: number, b1: number, color: string, o: number) => (
    <div style={{ position: "absolute", left: cellX(a0) - 5, top: cellY(b0) - 5, width: (a1 - a0) * G.pitch + G.cell + 10, height: (b1 - b0) * G.pitch + G.cell + 10, border: `3px solid ${color}`, borderRadius: 8, opacity: o, boxShadow: `0 0 18px ${color}88` }} />
  );

  return (
    <Stage part="Part 6: Advantage: Roll Twice, Keep the Higher" captions={CAPTIONS}>
      {/* ---------- two dice ---------- */}
      {frame < T.clear + 20 && (
        <>
          <div style={{ position: "absolute", left: 560 - 110, top: 330 - 110, opacity: top * (kept ? 0.35 : 1), transform: `scale(${sp(T.roll[0] - 12)})` }}>
            <D20 value={R1} size={220} spin={[8.5 * (1 - t1), -6.1 * (1 - t1), 2.7 * (1 - t1)]} />
          </div>
          <div style={{ position: "absolute", left: 840 - 110, top: 330 - 110, opacity: top, transform: `scale(${sp(T.roll[0] - 8)})` }}>
            <D20 value={R2} size={220} spin={[-7.4 * (1 - t2), 9.2 * (1 - t2), -3.3 * (1 - t2)]} highlight={kept ? C.hit : undefined} />
          </div>
          <div style={{ position: "absolute", left: 1040, top: 250, opacity: top }}>
            <div style={{ fontFamily: F.display, fontSize: 56, fontWeight: 700, opacity: sp(T.keep) }}>keep the higher: {R2}</div>
            <div style={{ fontFamily: F.display, fontSize: 44, fontWeight: 600, marginTop: 14, color: C.hit, opacity: sp(T.eq) }}>{R2} + {BONUS} = {R2 + BONUS} ≥ AC {AC}: a hit</div>
          </div>
        </>
      )}

      {/* ---------- 20 x 20 grid ---------- */}
      {frame >= T.grid && frame < T.chart + 5 && (
        <div style={{ opacity: midOut }}>
          <Text x={cellX(1) + 260} y={G.top - 74} w={520} size={26} color={C.muted}>first die</Text>
          <Text x={G.left - 130} y={cellY(10) + 4} w={200} size={26} color={C.muted}>second die</Text>
          {[1, 10, 20].map((n) => (
            <React.Fragment key={n}>
              <Text x={cellX(n) + G.cell / 2} y={G.top - 38} w={60} size={22} mono color={C.muted}>{n}</Text>
              <Text x={G.left - 24} y={cellY(n) + 1} w={60} size={22} mono color={C.muted}>{n}</Text>
            </React.Fragment>
          ))}
          {Array.from({ length: 400 }, (_, i) => {
            const a = (i % 20) + 1, b = Math.floor(i / 20) + 1;
            const k = kindOf(Math.max(a, b));
            const appear = sp(T.grid + i * 0.18);
            const isRoll = a === R1 && b === R2;
            return (
              <div key={i} style={{ position: "absolute", left: cellX(a), top: cellY(b), width: G.cell, height: G.cell, borderRadius: 4, transform: `scale(${appear})`,
                background: colored > 0 ? `${C[k]}${Math.round(lerp(0x10, 0x66, colored)).toString(16)}` : "#ffffff12",
                border: `1px solid ${colored > 0 ? `${C[k]}aa` : C.border}`, boxShadow: isRoll && frame < T.color + 60 ? `0 0 0 2px ${C.fg}` : undefined }} />
            );
          })}
          {frame >= T.missBox && box(1, 1, NEED - 1, NEED - 1, C.fg, sp(T.missBox) * (1 - ramp(frame, T.critBox - 10, T.critBox)))}
          {frame >= T.missBox && (
            <Text x={cellX(NEED / 2) + G.cell / 2} y={cellY(NEED / 2) - 4} w={200} size={26} mono weight={600} opacity={sp(T.missBox + 10) * (1 - ramp(frame, T.critBox - 10, T.critBox))}>{NEED - 1} × {NEED - 1} = {(NEED - 1) ** 2}</Text>
          )}
          {frame >= T.critBox && (
            <>
              {box(20, 1, 20, 20, C.crit, sp(T.critBox))}
              {box(1, 20, 20, 20, C.crit, sp(T.critBox))}
              <Text x={cellX(10)} y={cellY(20) + 40} w={400} size={26} mono weight={600} color={C.crit} opacity={sp(T.critBox + 10)}>20 + 20 − 1 = 39 pairs</Text>
            </>
          )}

          {/* ---------- normal vs advantage ---------- */}
          {(["miss", "hit", "crit"] as Kind[]).map((k, i) => {
            const y = 380 + i * 160;
            const a = sp(T.panel + i * 10);
            const lit = (k === "miss" && frame >= T.missBox && frame < T.critBox) || (k === "crit" && frame >= T.critBox);
            const W = 640;
            return (
              <div key={k} style={{ opacity: a * (frame >= T.missBox && !lit ? 0.45 : 1) }}>
                <Text x={900} y={y} w={200} align="left" size={30} weight={600} color={C[k]}>{k}</Text>
                <div style={{ position: "absolute", left: 1010, top: y + 2, width: W * ADV.normal[k] * a, height: 30, borderRadius: 6, border: `2px solid ${C.miss}`, background: "#ffffff0a" }} />
                <Text x={1020 + W * ADV.normal[k] + 10} y={y + 4} w={300} align="left" size={26} mono color={C.muted}>normal {pct(ADV.normal[k], 2)}</Text>
                <div style={{ position: "absolute", left: 1010, top: y + 44, width: W * ADV.advantage[k] * a, height: 30, borderRadius: 6, border: `2px solid ${C[k]}`, background: `${C[k]}55` }} />
                <Text x={1020 + W * ADV.advantage[k] + 10} y={y + 46} w={340} align="left" size={26} mono weight={600} color={C[k]}>advantage {pct(ADV.advantage[k], 2)}</Text>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- one damage distribution per roll type, feeding the DPR-by-AC chart ---------- */}
      {frame >= T.chart - 5 && (
        <div style={{ opacity: sp(T.chart) }}>
          {ROLL_TYPES.map((rt, i) => {
            const { bins, dpr } = distAt(rt, ac);
            const o = sp(T.chart + i * 8);
            const meanX = mpX(i, dpr) + PITCH / 2;
            return (
              <div key={rt} style={{ opacity: o }}>
                <div style={{ position: "absolute", left: mpLeft(i), top: MP.base - MP.h - 70, width: MP.w, height: MP.h + 130, borderRadius: 14, border: `2px solid ${RT[rt].color}66`, background: `${C.elevated}cc` }} />
                <Text x={mpLeft(i) + 16} y={MP.base - MP.h - 58} w={MP.w} align="left" size={24} weight={700} color={RT[rt].color}>{RT[rt].label}</Text>
                <Text x={mpLeft(i) + MP.w - 16} y={MP.base - MP.h - 56} w={200} align="right" size={22} mono weight={700} color={C.fg}>{`DPR ${dpr.toFixed(2)}`}</Text>
                {bins.map((b, v) => {
                  const H = (p: number) => p * MP.K;
                  const miss = Math.min(H(b.miss), MP.h), hit = Math.min(H(b.hit), MP.h), crit = Math.min(H(b.crit), MP.h - hit);
                  return (
                    <React.Fragment key={v}>
                      {miss > 0.3 && <div style={{ position: "absolute", left: mpX(i, v), top: MP.base - miss, width: PITCH - 3, height: miss, background: `${C.miss}66`, borderTop: `2px solid ${C.miss}` }} />}
                      {hit > 0.3 && <div style={{ position: "absolute", left: mpX(i, v), top: MP.base - hit, width: PITCH - 3, height: hit, background: `${C.hit}66`, borderTop: `2px solid ${C.hit}` }} />}
                      {crit > 0.3 && <div style={{ position: "absolute", left: mpX(i, v), top: MP.base - hit - crit, width: PITCH - 3, height: crit, background: `${C.crit}88`, borderTop: `2px solid ${C.crit}` }} />}
                    </React.Fragment>
                  );
                })}
                <Text x={mpX(i, 0) + PITCH + 4} y={MP.base - MP.h - 2} w={120} align="left" size={20} mono color={C.miss}>{`${pct(bins[0].miss, 0)} miss`}</Text>
                <div style={{ position: "absolute", left: mpX(i, 0), top: MP.base, width: MP.w - 20, height: 2, background: C.border }} />
                {[0, 10, 20].map((v) => <Text key={v} x={mpX(i, v) + PITCH / 2} y={MP.base + 6} w={40} size={18} mono color={C.muted}>{v}</Text>)}
                {/* the balance point: this is the number that drops into the chart below */}
                <div style={{ position: "absolute", left: meanX - 1.5, top: MP.base - MP.h + 34, width: 3, height: MP.h - 34, background: RT[rt].color, opacity: 0.8 }} />
                <svg style={{ position: "absolute", left: meanX - 12, top: MP.base + 28 }} width={24} height={20}><polygon points="12,0 0,20 24,20" fill={RT[rt].color} /></svg>
              </div>
            );
          })}

          <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
            {[0, 2, 4, 6, 8, 10].map((d) => (
              <g key={d}>
                <line x1={LC.left} x2={LC.right} y1={ly(d)} y2={ly(d)} stroke={C.border} strokeWidth={d === 0 ? 2.5 : 1} />
                <text x={LC.left - 16} y={ly(d) + 8} textAnchor="end" fontFamily={F.mono} fontSize={24} fill={C.muted}>{d}</text>
              </g>
            ))}
            {[10, 15, 20, 25].map((a) => <text key={a} x={lx(a)} y={LC.base + 34} textAnchor="middle" fontFamily={F.mono} fontSize={24} fill={a === Math.round(ac) && frame >= T.drop[0] ? C.hot : C.muted}>{a}</text>)}
            <text x={(LC.left + LC.right) / 2} y={LC.base + 70} textAnchor="middle" fontFamily={F.body} fontSize={24} fill={C.muted}>target AC</text>
            <text x={LC.left - 66} y={(LC.top + LC.base) / 2} textAnchor="middle" fontFamily={F.body} fontSize={24} fill={C.muted} transform={`rotate(-90 ${LC.left - 66} ${(LC.top + LC.base) / 2})`}>DPR</text>
            {frame >= T.drop[0] && <line x1={lx(ac)} x2={lx(ac)} y1={LC.top} y2={LC.base} stroke={C.hot} strokeDasharray="5 6" strokeWidth={1.5} opacity={0.7} />}
            {ROLL_TYPES.map((rt, i) => {
              const { dpr } = distAt(rt, ac);
              const from = { x: mpX(i, dpr) + PITCH / 2, y: MP.base + 48 };
              const to = { x: lx(ac), y: ly(dpr) };
              const pts = AC_RANGE.filter((a) => a <= sweep && frame >= T.lines[0]).map((a) => `${lx(a)},${ly(DPR_BY_AC[rt][a - AC_RANGE[0]])}`);
              if (frame >= T.lines[0]) pts.push(`${to.x},${to.y}`);
              const dot = { x: lerp(from.x, to.x, drop), y: lerp(from.y, to.y, drop) };
              return (
                <g key={rt}>
                  {pts.length > 1 && <polyline points={pts.join(" ")} fill="none" stroke={RT[rt].color} strokeWidth={rt === "normal" ? 3 : 4} strokeLinejoin="round" strokeLinecap="round" />}
                  {/* the feed: each distribution's balance point to its spot on the chart */}
                  {frame >= T.drop[0] && <line x1={from.x} y1={from.y} x2={dot.x} y2={dot.y} stroke={RT[rt].color} strokeWidth={2} strokeDasharray="4 6" opacity={frame < T.lines[0] ? 0.6 : 0.3} />}
                  {frame >= T.drop[0] && <circle cx={dot.x} cy={dot.y} r={8} fill={RT[rt].color} />}
                  {frame >= T.lines[1] && <circle cx={lx(AC)} cy={ly(DPR_BY_AC[rt][AC - AC_RANGE[0]])} r={7} fill={C.surface} stroke={RT[rt].color} strokeWidth={3} opacity={sp(T.lines[1])} />}
                </g>
              );
            })}
          </svg>
          <Text x={lx(ac)} y={LC.top - 40} w={200} size={28} mono weight={700} color={C.hot} opacity={ramp(frame, T.drop[0], T.drop[0] + 15)}>{`AC ${Math.round(ac)}`}</Text>
          {/* legend with the AC 15 values */}
          <Text x={1480} y={LC.top} w={400} align="left" size={24} color={C.muted} opacity={sp(T.lines[1])}>{`DPR at AC ${AC}`}</Text>
          {[...ROLL_TYPES].reverse().map((rt, i) => (
            <div key={rt} style={{ position: "absolute", left: 1480, top: LC.top + 50 + i * 62, display: "flex", alignItems: "center", gap: 14, opacity: sp(T.lines[1] + i * 4) }}>
              <div style={{ width: 30, height: 5, borderRadius: 3, background: RT[rt].color }} />
              <span style={{ fontSize: 26, color: RT[rt].color, width: 230 }}>{RT[rt].label}</span>
              <span style={{ fontFamily: F.mono, fontSize: 26, fontWeight: 600 }}>{ADV[rt].dpr.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </Stage>
  );
};
