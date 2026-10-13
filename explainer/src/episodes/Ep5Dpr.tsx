import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AC, AC_RANGE, AT_AC, BONUS, CRIT_AVG, HIT_AVG, SWEEP, type Bin } from "../attackData";
import { C, F, Fulcrum, Stage, Text, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { AX, Axis, ChanceGuide, Legend, Seg, colX } from "./Ep4Damage";

export const EP5_DURATION = 980;
const T = { chart: 0, rows: 70, step: 9, total: 240, fulcrum: 300, group: 400, panel: 410, lines: 425, groupTotal: 500, shrink: 560, toTen: 595, sweep: [645, 830], missNote: 855 } as const;

export const CAPTIONS: Caption[] = [
  { from: 0, to: T.rows, text: "So one attack has many possible results. What does it deal on average?" },
  { from: T.rows, to: T.total, text: "Multiply each damage outcome by its chance, and drop it into the total." },
  { from: T.total, to: T.fulcrum, text: "Add them all up. Now you have the DPR of this attack." },
  { from: T.fulcrum, to: T.group, text: "DPR is the balance point of the damage distribution." },
  { from: T.group, to: T.shrink, text: "Shortcut: group the buckets by outcome. Miss, hit and crit, each at its average damage. Same answer." },
  { from: T.shrink, to: T.sweep[1], text: "If you raise the target's AC, hits turn into misses, and the DPR drops accordingly." },
  { from: T.sweep[1], to: EP5_DURATION + 1, text: `At AC 25 you need ${25 - BONUS} or more on the d20: ${SWEEP[SWEEP.length - 1].dpr.toFixed(2)} DPR.` },
];

const ZOOM = 5;
const PANEL = { left: 1180, top: 210, w: 600 }; // the weighted-average panel, top right

// bucket by bucket: every damage value, its chance, and what it adds to the average
const ROWS = AT_AC.bins.map((b, v) => ({ v, p: b.miss + b.hit + b.crit })).filter((r) => r.p > 1e-12);
const ROW_TOTAL = ROWS.reduce((a, r) => a + r.v * r.p, 0);
if (Math.abs(ROW_TOTAL - AT_AC.dpr) > 1e-9) throw new Error("bucket by bucket must add up to the attack's DPR");
const TBL = { left: 1150, top: 196, w: 660, row: 34, head: 40 };
const rowAt = (i: number) => T.rows + i * T.step; // when row i appears
const DRIP = 16; // frames for a row's amount to drop into the total
const tblTotalY = TBL.top + TBL.head + ROWS.length * TBL.row + 14;
const H = (p: number) => p * AX.K * ZOOM;
const dmgX = (d: number) => colX(0) + AX.col / 2 + d * (AX.col + AX.gap);

const binsAt = (ac: number): { bins: Bin[]; dpr: number } => {
  const i = Math.min(SWEEP.length - 2, Math.max(0, Math.floor(ac - AC_RANGE[0])));
  const t = Math.min(1, Math.max(0, ac - AC_RANGE[i]));
  const a = SWEEP[i], b = SWEEP[i + 1];
  return {
    bins: a.bins.map((x, v) => ({ miss: lerp(x.miss, b.bins[v].miss, t), hit: lerp(x.hit, b.bins[v].hit, t), crit: lerp(x.crit, b.bins[v].crit, t) })),
    dpr: lerp(a.dpr, b.dpr, t),
  };
};

// DPR-by-AC line chart (right side, after the shrink)
const LC = { left: 1300, right: 1770, base: 860, top: 400, maxDpr: 8 };
const lcX = (ac: number) => lerp(LC.left, LC.right, (ac - AC_RANGE[0]) / (AC_RANGE[AC_RANGE.length - 1] - AC_RANGE[0]));
const lcY = (d: number) => lerp(LC.base, LC.top, d / LC.maxDpr);

export const Ep5Dpr: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
  const ac = frame < T.sweep[0] ? interpolate(frame, [T.toTen, T.toTen + 40], [AC, 10], ease) : interpolate(frame, [T.sweep[0], T.sweep[1]], [10, 25], ease);
  const { bins, dpr } = binsAt(ac);
  // readouts always show the exact library value for the whole-number AC on screen
  const shownAc = Math.round(ac);
  const shownDpr = SWEEP[shownAc - AC_RANGE[0]].dpr;
  // the chart moves into its smaller left-hand pose as the table arrives, and keeps it for the AC sweep
  const shrink = sp(T.rows - 30);
  const s = lerp(1, 0.64, shrink);
  const ft = frame - T.fulcrum - 15;
  const tilt = ft > 0 && frame < T.shrink ? 5 * Math.exp(-ft / 22) * Math.cos(ft / 6) : 0;
  const panelOut = 1 - ramp(frame, T.shrink - 10, T.shrink + 10);
  const tableOut = 1 - ramp(frame, T.group - 10, T.group + 10);
  const shownRows = ROWS.filter((_, i) => frame >= rowAt(i)).length;
  const active = frame < T.total ? shownRows - 1 : -1; // the row (and bucket) being added right now
  const dripped = ROWS.reduce((a, r, i) => (frame >= rowAt(i) + DRIP ? a + r.v * r.p : a), 0);
  const sweeping = frame >= T.toTen;

  const lines = [
    { k: "miss" as const, p: AT_AC.odds.miss, avg: 0, val: 0 },
    { k: "hit" as const, p: AT_AC.odds.hit, avg: HIT_AVG, val: AT_AC.parts.hit },
    { k: "crit" as const, p: AT_AC.odds.crit, avg: CRIT_AVG, val: AT_AC.parts.crit },
  ];

  // trail of the line chart up to the current AC (only once the 10 -> 25 sweep starts)
  const trailTo = frame >= T.sweep[0] ? ac : 10;
  const trail = SWEEP.filter((p) => p.ac <= trailTo).map((p) => [lcX(p.ac), lcY(p.dpr)] as const);
  if (frame >= T.sweep[0]) trail.push([lcX(ac), lcY(dpr)]);

  return (
    <Stage part="Part 5: The Average: Damage per Round" captions={CAPTIONS}>
      <div style={{ position: "absolute", inset: 0, transformOrigin: `${colX(0)}px ${AX.base}px`, transform: `translate(${(150 - colX(0)) * shrink}px, ${-20 * shrink}px) scale(${s})` }}>
        <div style={{ position: "absolute", inset: 0, transformOrigin: `${dmgX(dpr)}px ${AX.base}px`, transform: `rotate(${tilt}deg)`, opacity: sp(T.chart) }}>
          <Axis opacity={1} />
          {bins.map((b, v) => (
            <React.Fragment key={v}>
              {b.miss > 0 && <Seg x={colX(v)} w={AX.col} bottom={AX.base} h={H(b.miss)} color={C.miss} />}
              {b.hit > 1e-6 && <Seg x={colX(v)} w={AX.col} bottom={AX.base} h={H(b.hit)} color={C.hit} />}
              {b.crit > 1e-6 && <Seg x={colX(v)} w={AX.col} bottom={AX.base - H(b.hit)} h={H(b.crit)} color={C.crit} />}
            </React.Fragment>
          ))}
          {/* the bucket whose row is being added glows */}
          {active >= 0 && (() => {
            const r = ROWS[active];
            return <div style={{ position: "absolute", left: colX(r.v) - 5, top: AX.base - Math.min(H(r.p), AX.base - AX.top + 20) - 5, width: AX.col + 10, height: Math.min(H(r.p), AX.base - AX.top + 20) + 5, border: `3px solid ${C.hot}`, borderBottom: "none", borderRadius: "8px 8px 0 0", boxShadow: `0 0 18px ${C.hot}66` }} />;
          })()}
          <Text x={colX(0) + AX.col / 2} y={AX.top - 48} w={160} size={26} mono weight={600} color={C.miss}>{pct(bins[0].miss, 0)}</Text>
          {/* while the AC rises: the 5..12 bars' height, as a chance */}
          {frame >= T.shrink && <ChanceGuide base={AX.base} top={AX.top} y={AX.base - H(bins[5].hit)} toX={colX(12) + AX.col} label={pct(bins[5].hit, 1)} opacity={sp(T.shrink + 10)} size={36} />}
        </div>
        {(frame >= T.fulcrum || sweeping) && <Fulcrum x={dmgX(dpr)} y={AX.base + 50} label={`DPR ${(sweeping ? shownDpr : AT_AC.dpr).toFixed(2)}`} opacity={sp(T.fulcrum)} size={34} />}
      </div>
      <Legend opacity={sp(T.chart) * (1 - shrink)} at={{ x: (colX(0) + AX.col + PANEL.left) / 2, y: AX.top - 46 }} />

      {/* ---------- bucket by bucket: damage x chance, dripping into the total ---------- */}
      {frame >= T.rows - 10 && frame < T.group + 12 && (
        <div style={{ position: "absolute", left: TBL.left, top: TBL.top, width: TBL.w, opacity: tableOut, fontFamily: F.mono }}>
          <div style={{ position: "absolute", left: -24, top: -14, width: TBL.w + 48, height: tblTotalY - TBL.top + 66, background: `${C.elevated}ee`, border: `1.5px solid ${C.borderStrong}`, borderRadius: 16, opacity: sp(T.rows - 10) }} />
          <div style={{ position: "relative", display: "grid", gridTemplateColumns: "150px 170px 340px", height: TBL.head, fontFamily: F.body, fontSize: 22, color: C.muted, opacity: sp(T.rows - 10) }}>
            <span style={{ textAlign: "right" }}>dmg outcome</span><span style={{ textAlign: "right" }}>chance</span><span style={{ textAlign: "right" }}>dmg outcome × chance</span>
          </div>
          {ROWS.map((r, i) => {
            const a = sp(rowAt(i));
            if (frame < rowAt(i)) return null;
            const lit = i === active;
            const amount = r.v * r.p;
            const d = ramp(frame, rowAt(i) + 2, rowAt(i) + DRIP);
            const y = TBL.head + i * TBL.row;
            return (
              <React.Fragment key={r.v}>
                <div style={{ position: "absolute", left: -10, right: -10, top: y - 2, height: TBL.row - 2, borderRadius: 6, background: lit ? `${C.hot}22` : i % 2 ? "#ffffff05" : "transparent" }} />
                <div style={{ position: "absolute", left: 0, top: y, display: "grid", gridTemplateColumns: "150px 170px 340px", fontSize: 24, lineHeight: `${TBL.row - 4}px`, opacity: a, color: lit ? C.hot : C.fg }}>
                  <span style={{ textAlign: "right", fontWeight: 600 }}>{r.v}</span>
                  <span style={{ textAlign: "right" }}>{pct(r.p, 2)}</span>
                  <span style={{ textAlign: "right", color: lit ? C.hot : C.muted }}>{amount.toFixed(3)}</span>
                </div>
                {/* the amount drops down into the running total */}
                {d > 0 && d < 1 && (
                  <div style={{ position: "absolute", left: 0, width: 660, top: lerp(y, tblTotalY - TBL.top + TBL.head - TBL.head, d * d), textAlign: "right", fontSize: 24, fontWeight: 700, color: C.hot, opacity: 1 - d * 0.6 }}>{`+${amount.toFixed(3)}`}</div>
                )}
              </React.Fragment>
            );
          })}
          <div style={{ position: "absolute", left: 0, width: 660, top: tblTotalY - TBL.top - 8, height: 2, background: C.borderStrong, opacity: sp(T.rows) }} />
          <div style={{ position: "absolute", left: 0, width: 660, top: tblTotalY - TBL.top + 2, display: "flex", justifyContent: "space-between", fontSize: frame >= T.total ? 40 : 32, fontWeight: 700, color: frame >= T.total ? C.hot : C.fg, opacity: sp(T.rows) }}>
            <span style={{ fontFamily: F.body, fontSize: 24, fontWeight: 400, color: C.muted, alignSelf: "center" }}>{frame >= T.total ? "DPR" : "running total"}</span><span>{(frame >= T.total ? AT_AC.dpr : dripped).toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* ---------- the shortcut: the same sum grouped by outcome ---------- */}
      {frame >= T.panel && frame < T.shrink + 12 && (
        <div style={{ position: "absolute", left: PANEL.left, top: PANEL.top, width: PANEL.w, padding: "22px 30px", background: `${C.elevated}ee`, border: `1.5px solid ${C.borderStrong}`, borderRadius: 16, fontFamily: F.mono, fontSize: 30, lineHeight: 1.75, opacity: sp(T.panel) * panelOut }}>
          <div style={{ display: "grid", gridTemplateColumns: "90px 90px 36px 104px 30px 1fr", fontSize: 22, color: C.muted, lineHeight: 1.2, marginBottom: 6 }}>
            <span /><span>chance</span><span /><span style={{ whiteSpace: "nowrap" }}>avg dmg</span><span style={{ gridColumn: "5 / 7", textAlign: "right" }}>expected dmg</span>
          </div>
          {lines.map((l, i) => {
            const a = sp(T.lines + i * 22);
            return (
              <div key={l.k} style={{ display: "grid", gridTemplateColumns: "90px 90px 36px 104px 30px 1fr", opacity: a, transform: `translateX(${(1 - a) * 20}px)` }}>
                <span style={{ color: C[l.k] }}>{l.k}</span>
                <span>{pct(l.p, 0)}</span><span style={{ color: C.muted }}>×</span><span>{Number(l.avg.toFixed(2))}</span><span style={{ color: C.muted }}>=</span>
                <span style={{ textAlign: "right", color: C[l.k] }}>{l.val.toFixed(2)}</span>
              </div>
            );
          })}
          <div style={{ height: 2, background: C.borderStrong, margin: "8px 0", opacity: sp(T.groupTotal) }} />
          <div style={{ display: "flex", justifyContent: "space-between", opacity: sp(T.groupTotal), fontWeight: 700, fontSize: 40, color: C.hot }}>
            <span>DPR</span><span>{AT_AC.dpr.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* at AC 25: point at the miss bar's label */}
      {frame >= T.missNote && (
        <div style={{ opacity: sp(T.missNote) }}>
          <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
            <defs><marker id="missArrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.fg} /></marker></defs>
            <path d={`M 318 ${392 + (1 - sp(T.missNote)) * 10} Q 240 400 196 462`} fill="none" stroke={C.fg} strokeWidth={3} markerEnd="url(#missArrow)" />
          </svg>
          <Text x={330} y={360} w={520} align="left" size={36} weight={600}>
            <span style={{ fontFamily: F.mono }}>{pct(SWEEP[SWEEP.length - 1].bins[0].miss, 0)}</span> chance of missing
          </Text>
        </div>
      )}

      {/* ---------- DPR by AC ---------- */}
      {sweeping && (
        <div style={{ opacity: sp(T.shrink + 10) }}>
          <Text x={LC.left - 40} y={250} w={600} align="left" size={56} mono weight={600}>AC {shownAc}</Text>
          <Text x={LC.right} y={262} w={420} align="right" size={36} mono weight={600} color={C.hot}>DPR {shownDpr.toFixed(2)}</Text>
          <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
            {[0, 2, 4, 6, 8].map((d) => (
              <g key={d}>
                <line x1={LC.left} x2={LC.right} y1={lcY(d)} y2={lcY(d)} stroke={C.border} strokeWidth={d === 0 ? 2.5 : 1} />
                <text x={LC.left - 16} y={lcY(d) + 7} textAnchor="end" fontFamily={F.mono} fontSize={24} fill={C.muted}>{d}</text>
              </g>
            ))}
            {[10, 15, 20, 25].map((a) => (
              <text key={a} x={lcX(a)} y={LC.base + 34} textAnchor="middle" fontFamily={F.mono} fontSize={24} fill={C.muted}>{a}</text>
            ))}
            <text x={(LC.left + LC.right) / 2} y={LC.base + 70} textAnchor="middle" fontFamily={F.body} fontSize={24} fill={C.muted}>target AC</text>
            <text x={LC.left - 60} y={(LC.top + LC.base) / 2} textAnchor="middle" fontFamily={F.body} fontSize={24} fill={C.muted} transform={`rotate(-90 ${LC.left - 60} ${(LC.top + LC.base) / 2})`}>DPR</text>
            {trail.length > 1 && <polyline points={trail.map((p) => p.join(",")).join(" ")} fill="none" stroke={C.accent} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />}
            {SWEEP.filter((p) => frame >= T.sweep[0] && p.ac <= trailTo).map((p) => <circle key={p.ac} cx={lcX(p.ac)} cy={lcY(p.dpr)} r={4} fill={C.accent} />)}
            {[13, 16, 19, 22].filter((a) => frame >= T.sweep[0] && a <= trailTo + 0.01).map((a) => (
              <text key={a} x={lcX(a) + 8} y={lcY(SWEEP[a - AC_RANGE[0]].dpr) - 12} textAnchor="start" fontFamily={F.mono} fontSize={20} fontWeight={600} fill={C.fg}>{SWEEP[a - AC_RANGE[0]].dpr.toFixed(2)}</text>
            ))}
            <line x1={lcX(ac)} x2={lcX(ac)} y1={LC.top} y2={LC.base} stroke={C.hot} strokeWidth={1.5} strokeDasharray="5 6" opacity={0.6} />
            <circle cx={lcX(ac)} cy={lcY(dpr)} r={9} fill={C.hot} />
          </svg>
        </div>
      )}
    </Stage>
  );
};
