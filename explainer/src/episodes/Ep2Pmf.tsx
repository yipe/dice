import React from "react";
import { useCurrentFrame } from "remotion";
import { MOD, PAIRS, PAIR_COUNT, SUMS, SUM_P, SUM_WAYS, sumColor } from "../data8";
import { C, F, Stage, Text, lerp, pct, ramp, useSp, type Caption } from "../kit";

export const EP2_DURATION = 620;

const T = { blocks: 0, bars: 75, toPct: 120, slide: 175, rows: 205, total: 300, peak: 400, edges: 470, outro: 540 };
const PEAK = SUM_WAYS.indexOf(Math.max(...SUM_WAYS)); // the top of the triangle
const EDGE = [0, SUMS.length - 1];

export const CAPTIONS: Caption[] = [
  { from: 0, to: 75, text: `Here is Part 1's 2d8 + ${MOD}: ${PAIR_COUNT} equally likely pairs, counted into buckets.` },
  { from: 75, to: 175, text: `Divide each bucket by ${PAIR_COUNT} to turn its count into a chance.` },
  { from: 175, to: 310, text: "This list is a PMF (probability mass function): every result, and its chance." },
  { from: 310, to: T.peak, text: "The chances always add up to 100%." },
  { from: T.peak, to: T.edges, text: `The top of the triangle is the most likely result: ${SUMS[PEAK] + MOD} damage, ${pct(SUM_P[PEAK])} of the time.` },
  { from: T.edges, to: T.outro, text: `The edges are the least likely: ${SUMS[EDGE[0]] + MOD} or ${SUMS[EDGE[1]] + MOD} happen just ${pct(SUM_P[EDGE[0]])} of the time each.` },
  { from: T.outro, to: EP2_DURATION + 1, text: "But all of this assumes the attack hits. How do we model the attack rolls?" },
];

// histogram geometry, interpolated between "centered" (Part 1's ending) and "left" (next to the table)
const GEO = {
  // matches Part 1's ending: 15 buckets, 60px blocks on a 76px pitch
  center: { left: (1920 - (SUMS.length * 66 + (SUMS.length - 1) * 10)) / 2 + 3, col: 60, gap: 16, unit: 64, base: 930 },
  // beside the table: the base sits on the table's sum line and the tallest bar reaches its first row
  side: { left: 140, col: 44, gap: 10, unit: 80, base: 854 },
};
const geo = (t: number) => ({
  left: lerp(GEO.center.left, GEO.side.left, t), col: lerp(GEO.center.col, GEO.side.col, t), gap: lerp(GEO.center.gap, GEO.side.gap, t),
  unit: lerp(GEO.center.unit, GEO.side.unit, t), base: lerp(GEO.center.base, GEO.side.base, t),
});

const TABLE = { x: 1110, top: 250, row: 40, w: 520, colTotal: 1200, colChance: 1450 };

export const Ep2Pmf: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const slide = sp(T.slide);
  const g = geo(slide);
  const colX = (i: number) => g.left + i * (g.col + g.gap);
  const solid = ramp(frame, T.bars, T.bars + 20);
  const toPct = ramp(frame, T.toPct, T.toPct + 16);

  // which buckets are in the spotlight: the peak, then the two edges
  const spot = (i: number) => (frame >= T.peak && frame < T.edges ? i === PEAK : frame >= T.edges && frame < T.outro ? EDGE.includes(i) : false);
  const spotOn = frame >= T.peak && frame < T.outro;
  const totalT = ramp(frame, T.total, T.total + 40);
  const totalP = SUM_P.reduce((a, b) => a + b, 0) * totalT;

  return (
    <Stage part="Part 2: Probability" captions={CAPTIONS}>
      <div style={{ position: "absolute", inset: 0 }}>
        {SUMS.map((s, i) => {
          const ways = SUM_WAYS[i];
          const h = ways * g.unit - (g.unit - g.col);
          const hot = spot(i);
          return (
            <React.Fragment key={s}>
              {/* Part 1's blocks, which melt into one solid bar */}
              {solid < 1 &&
                PAIRS.filter((p) => p.sum === s).map((p, k) => (
                  <div key={k} style={{ position: "absolute", left: colX(i), top: g.base - (k + 1) * g.unit + (g.unit - g.col), width: g.col, height: g.col, opacity: (1 - solid) * sp(T.blocks + i * 3) }}>
                    <div style={{ width: g.col, height: g.col, borderRadius: 9, background: `${sumColor(s)}2e`, border: `2px solid ${sumColor(s)}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.mono, fontWeight: 600, fontSize: g.col * 0.4, color: C.fg }}>{s + MOD}</div>
                  </div>
                ))}
              <div style={{ position: "absolute", left: colX(i), top: g.base - h, width: g.col, height: h, borderRadius: 10, background: `${sumColor(s)}40`, border: `2px solid ${sumColor(s)}`, opacity: solid * (spotOn && !hot ? 0.45 : 1), boxShadow: hot ? `0 0 26px ${C.hot}88` : undefined, borderColor: hot ? C.hot : sumColor(s) }} />
              <Text x={colX(i) + g.col / 2} y={g.base + 12} w={g.col + 20} size={lerp(32, 26, slide)} mono weight={600} color={hot ? C.hot : C.fg}>{s + MOD}</Text>
              <Text x={colX(i) + g.col / 2} y={g.base - h - 36} w={120} size={lerp(24, 18, slide)} mono color={C.muted} opacity={sp(T.blocks + 20 + i * 2) * (1 - toPct)}>{ways}/{PAIR_COUNT}</Text>
              <Text x={colX(i) + g.col / 2} y={g.base - h - 36} w={120} size={lerp(24, 18, slide)} mono weight={hot ? 700 : 400} color={hot ? C.hot : C.fg} opacity={toPct}>{pct(SUM_P[i])}</Text>
            </React.Fragment>
          );
        })}
        <div style={{ position: "absolute", left: colX(0) - 16, top: g.base + 2, width: colX(SUMS.length - 1) + g.col - colX(0) + 32, height: 3, background: C.border }} />
      </div>

      {/* ---------- the PMF as a table ---------- */}
      {frame >= T.rows - 5 && (
        <>
          <Text x={TABLE.colTotal} y={TABLE.top - 50} w={220} size={26} color={C.muted} opacity={sp(T.rows)}>dmg outcome</Text>
          <Text x={TABLE.colChance} y={TABLE.top - 50} w={200} size={26} color={C.muted} opacity={sp(T.rows)}>chance</Text>
          {SUMS.map((s, i) => {
            const a = sp(T.rows + i * 7);
            const y = TABLE.top + i * TABLE.row;
            const lit = spot(i);
            return (
              <div key={s} style={{ opacity: a, transform: `translateX(${(1 - a) * -40}px)` }}>
                <div style={{ position: "absolute", left: TABLE.x, top: y - 6, width: TABLE.w, height: TABLE.row - 6, borderRadius: 8, background: lit ? `${C.hot}26` : i % 2 ? "#ffffff05" : "transparent" }} />
                <Text x={TABLE.colTotal} y={y} w={160} size={25} mono weight={lit ? 700 : 600} color={lit ? C.hot : sumColor(s)}>{s + MOD}</Text>
                <Text x={TABLE.colChance} y={y} w={200} size={25} mono weight={lit ? 700 : 400} color={lit ? C.hot : C.fg}>{pct(SUM_P[i])}</Text>
              </div>
            );
          })}
          <div style={{ position: "absolute", left: TABLE.x, top: TABLE.top + SUMS.length * TABLE.row + 4, width: TABLE.w, height: 2, background: C.borderStrong, opacity: totalT }} />
          <Text x={TABLE.colChance} y={TABLE.top + SUMS.length * TABLE.row + 18} w={200} size={28} mono weight={600} opacity={totalT} color={frame < T.peak ? C.hot : C.fg}>{pct(totalP, 0)}</Text>
          <Text x={TABLE.colTotal} y={TABLE.top + SUMS.length * TABLE.row + 20} w={160} size={26} color={C.muted} opacity={totalT}>sum</Text>
        </>
      )}
    </Stage>
  );
};
