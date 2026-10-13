import React from "react";
import { ATTACKS } from "../advancedData";
import { C, F, Fulcrum, Text, pct } from "../kit";

// Shared pieces for Parts 7-9: the five attack cards and the turn's damage buckets.
export const VEX = "#c09bff"; // midnight chart purple
export const SNEAK = "#87dda8"; // midnight chart green (the gold was off-palette)

/** Two decimals, rounding half up. */
export const f2 = (x: number) => (Math.round(x * 100 + 1e-6) / 100).toFixed(2);

export const CARD = { w: 290, h: 140, gap: 22, top: 232 };
export const cardX = (i: number) => (1920 - (5 * CARD.w + 4 * CARD.gap)) / 2 + i * (CARD.w + CARD.gap);
export const CARD_BOTTOM = CARD.top + CARD.h;

/** The turn as five cards. `meters` (0..1 per attack) shows how often each attack has advantage. */
export const Cards: React.FC<{ appear: (i: number) => number; lit?: (i: number) => boolean; meters?: number[]; meterOpacity?: number; brackets?: number; showAvg?: number; tags?: string[]; ids?: boolean; extra?: (i: number) => { label: string; color: string; opacity: number } | undefined; slot?: (i: number) => number; stripe?: (i: number) => string | undefined }> = ({ appear, lit, meters, meterOpacity = 0, brackets = 0, showAvg = 0, tags = ["Vex", "Nick"], ids = false, extra, slot = (i) => i, stripe }) => (
  <>
    {brackets > 0 && (
      <div style={{ opacity: brackets }}>
        <Bracket from={0} to={2} label="Attack Action" color={C.accent} />
        <Bracket from={3} to={4} label="Bonus Action: Flurry of Blows" color={C.muted} />
      </div>
    )}
    {ATTACKS.map((a, i) => {
      const o = appear(i);
      const col = a.tag === "Vex" ? VEX : a.tag === "Nick" ? C.crit : C.muted;
      return (
        <div key={a.id} style={{ position: "absolute", left: cardX(slot(i)), top: CARD.top, width: CARD.w, height: CARD.h, opacity: o, transform: `translateY(${(1 - o) * 20}px)`, borderRadius: 14, background: C.elevated, border: `2px solid ${lit?.(i) ? C.hot : C.border}`, padding: "12px 16px", boxSizing: "border-box", boxShadow: lit?.(i) ? `0 0 22px ${C.hot}66` : undefined }}>
          {stripe?.(i) && <div style={{ position: "absolute", left: 14, right: 14, top: 0, height: 6, borderRadius: "0 0 4px 4px", background: stripe(i) }} />}
          {/* without ids, the attack's name takes the top row next to its tag */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: ids ? 0 : 14 }}>
            {ids ? <span style={{ fontFamily: F.mono, fontSize: 30, fontWeight: 700, color: C.fg }}>{a.id}</span> : <span style={{ fontSize: a.name.length > 12 && (tags.includes(a.tag) || extra?.(i)) ? 23 : 30, fontWeight: 600, whiteSpace: "nowrap" }}>{a.name}</span>}
            <span style={{ display: "flex", gap: 6 }}>
              {extra?.(i) && <span style={{ fontFamily: F.mono, fontSize: 20, color: extra(i)!.color, border: `1.5px solid ${extra(i)!.color}`, borderRadius: 999, padding: "2px 10px", opacity: extra(i)!.opacity }}>{extra(i)!.label}</span>}
              {tags.includes(a.tag) && <span style={{ fontFamily: F.mono, fontSize: 20, color: col, border: `1.5px solid ${col}`, borderRadius: 999, padding: "2px 10px" }}>{a.tag}</span>}
            </span>
          </div>
          {ids && <div style={{ fontSize: 27, fontWeight: 600, marginTop: 4 }}>{a.name}</div>}
          <div style={{ fontFamily: F.mono, fontSize: 24, color: C.muted, marginTop: ids ? 2 : 14 }}>
            {a.dmg}
            <span style={{ opacity: showAvg, marginLeft: 12, color: C.fg }}>avg {f2(a.single)}</span>
          </div>
          {meters && (
            <div style={{ position: "absolute", left: 0, right: 0, top: CARD.h + 12, opacity: meterOpacity }}>
              <div style={{ height: 10, borderRadius: 5, background: C.border, overflow: "hidden" }}>
                <div style={{ width: `${meters[i] * 100}%`, height: "100%", background: VEX }} />
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 24, color: meters[i] > 0 ? VEX : C.muted, marginTop: 6, textAlign: "center" }}>Advantage {pct(meters[i], 2)}</div>
            </div>
          )}
        </div>
      );
    })}
  </>
);

const Bracket: React.FC<{ from: number; to: number; label: string; color: string }> = ({ from, to, label, color }) => {
  const x1 = cardX(from), x2 = cardX(to) + CARD.w;
  return (
    <>
      <div style={{ position: "absolute", left: x1, top: CARD.top - 26, width: x2 - x1, height: 14, borderTop: `2px solid ${color}`, borderLeft: `2px solid ${color}`, borderRight: `2px solid ${color}`, borderRadius: "6px 6px 0 0" }} />
      <Text x={(x1 + x2) / 2} y={CARD.top - 56} w={x2 - x1} size={24} color={color}>{label}</Text>
    </>
  );
};

// ---------- the turn's damage buckets ----------
// The axis stops at 70: every turn above that has under 0.01% total chance, far below a pixel.
export const TB = { left: 220, right: 1700, base: 860, top: 480 };
export const SHOW_MAX = 70;
export const TP = (TB.right - TB.left) / (SHOW_MAX + 1);
export const tx = (v: number) => TB.left + v * TP;
export type Layer = { arr: number[]; color: string; scale?: number; fill?: string };

/** The balance point moving from one turn to the next: the old DPR (blue) fades as the new one (in `color`) slides from
 * `from` to `to`; once `done`, only the new value shows, with the change: "33.54 DPR (+1.40)". */
export const DprShift: React.FC<{ from: number; to: number; morph: number; done: number; color: string; opacity?: number }> = ({ from, to, morph, done, color, opacity = 1 }) => {
  const xAt = (m: number) => tx(0) + TP / 2 + m * TP;
  const y = TB.base + 70, x0 = xAt(from), x1 = xAt(from + (to - from) * morph);
  const tri = (x: number, c: string, op: number) => <polygon points={`${x},${y + 2} ${x - 13},${y + 30} ${x + 13},${y + 30}`} fill={c} opacity={op} />;
  const d = to - from;
  return (
    <div style={{ opacity }}>
      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        {tri(x0, C.accent, 1 - morph)}
        {morph > 0 && tri(x1, color, 1)}
      </svg>
      <Text x={x0} y={y + 42} w={300} size={30} mono weight={700} color={C.accent} opacity={1 - morph}>{`${f2(from)} DPR`}</Text>
      <div style={{ position: "absolute", left: x1, top: y + 42, transform: "translateX(-50%)", display: "flex", gap: 14, fontFamily: F.mono, fontSize: 30, fontWeight: 700, opacity: done, whiteSpace: "nowrap" }}>
        <span style={{ color }}>{`${f2(to)} DPR`}</span>
        <span style={{ color: C.muted }}>{`(${d >= 0 ? "+" : "−"}${f2(Math.abs(d))})`}</span>
      </div>
    </div>
  );
};

/** Stacked buckets. `K` maps probability to pixels; tall buckets clip with their value shown. */
export const TurnBuckets: React.FC<{ layers: Layer[]; K: number; mean?: number; meanOpacity?: number; opacity?: number }> = ({ layers, K, mean, meanOpacity = 1, opacity = 1 }) => {
  const room = TB.base - TB.top;
  return (
    <div style={{ opacity }}>
      <div style={{ position: "absolute", left: tx(0) - 8, top: TB.base + 2, width: TB.right - TB.left + 16, height: 3, background: C.border }} />
      {[0, 10, 20, 30, 40, 50, 60, 70].map((v) => <Text key={v} x={tx(v) + TP / 2} y={TB.base + 12} w={60} size={26} mono weight={600}>{v}</Text>)}
      <Text x={TB.right + 8} y={TB.base + 48} w={300} align="right" size={26} color={C.muted}>turn damage</Text>
      {Array.from({ length: SHOW_MAX + 1 }, (_, v) => {
        let y = TB.base;
        let total = 0;
        const out: React.ReactNode[] = [];
        layers.forEach((l, i) => {
          const p = (l.arr[v] ?? 0) * (l.scale ?? 1);
          total += p;
          const h = Math.min(p * K, Math.max(0, y - TB.top));
          if (h > 0.25) out.push(<div key={i} style={{ position: "absolute", left: tx(v), top: y - h, width: TP - 2, height: h, background: `${l.color}${l.fill ?? "88"}`, borderTop: `2px solid ${l.color}`, borderRadius: 2 }} />);
          y -= h;
        });
        return (
          <React.Fragment key={v}>
            {out}
            {total * K > room && <Text x={tx(v) + TP / 2} y={TB.top - 34} w={160} size={24} mono weight={600}>{pct(total, 0)}</Text>}
          </React.Fragment>
        );
      })}
      {mean !== undefined && <Fulcrum x={tx(0) + TP / 2 + mean * TP} y={TB.base + 70} label={`${f2(mean)} DPR`} opacity={meanOpacity} />}
    </div>
  );
};
