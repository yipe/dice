import React from "react";
import { useCurrentFrame } from "remotion";
import { AT_AC, DAMAGE, MAX_DMG, type Bin } from "../attackData";
import { C, F, Stage, Text, clamp01, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { Water } from "./Ep1Dice";

export const EP4_DURATION = 760;

const T = { bins: 0, axis: 60, miss: 95, hit: 185, shift: 262, zoom: 340, crit: 420, whole: 570, prov: 660 } as const;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 95, text: "Next, let's turn those outcomes into damage. Each one pours its chance into damage buckets." },
  { from: 95, to: 185, text: `A miss deals 0: ${pct(AT_AC.odds.miss, 0)} lands in the 0 bucket.` },
  { from: 185, to: 262, text: `A hit rolls 1d8: the ${pct(AT_AC.odds.hit, 0)} splits evenly into 8 buckets, ${pct(AT_AC.odds.hit / 8, 1)} each.` },
  { from: 262, to: 340, text: `Then add Dexterity, +${DAMAGE.dex}: every bucket slides right by 4.` },
  { from: 340, to: 420, text: "Zoom in 5×. The 0-damage bucket now runs off the top." },
  { from: 420, to: 570, text: `A crit rolls ${DAMAGE.crit}: Part 1's triangle, shifted by 4.` },
  { from: 570, to: 660, text: "Stack every bucket: the damage PMF for one attack." },
  { from: 660, to: EP4_DURATION + 1, text: "Where did each bucket's damage come from? Provenance: every bucket keeps track of which outcomes poured into it." },
];

// ---- geometry ----
export const AX = { col: 56, gap: 14, base: 900, top: 300, K: 380 / 0.45 };
export const colX = (v: number) => (1920 - ((MAX_DMG + 1) * (AX.col + AX.gap) - AX.gap)) / 2 + v * (AX.col + AX.gap);
// Part 4 draws two charts: the three outcomes on top, the empty damage chart below it
const BIG = { w: 210, x: { miss: 560, hit: 960, crit: 1360 } };
const TOP = { base: 470, K: 270 }; // a full bucket (100%) is K tall
const DM = { base: 920, top: 600, K: 780 };
const HIT_FACES = Array.from({ length: 8 }, (_, i) => i + 1 + DAMAGE.dex); // 1d8 + 4: 5..12
const CRIT_VALUES = Array.from({ length: 15 }, (_, i) => i + 2 + DAMAGE.dex); // 2d8 + 4: 6..20

type Rect = { x: number; w: number; bottom: number; h: number; color: string; opacity?: number; glow?: boolean; clipTop?: number };
/** A bar segment clipped at the chart top, with a break mark when clipped. */
export const Seg: React.FC<Rect> = ({ x, w, bottom, h, color, opacity = 1, glow, clipTop = AX.top }) => {
  const top = Math.max(clipTop, bottom - h);
  const clipped = bottom - h < clipTop - 0.5;
  return (
    <>
      <div style={{ position: "absolute", left: x, top, width: w, height: Math.max(0, bottom - top), background: `${color}55`, border: `2px solid ${color}`, borderTop: clipped ? "none" : `2px solid ${color}`, borderRadius: clipped ? 0 : 6, opacity, boxShadow: glow ? `0 0 24px ${color}aa` : undefined }} />
      {clipped && (
        <svg style={{ position: "absolute", left: x - 4, top: top - 10, opacity }} width={w + 8} height={20}>
          <path d={`M0 14 L${(w + 8) / 4} 4 L${(w + 8) / 2} 14 L${(3 * (w + 8)) / 4} 4 L${w + 8} 14`} stroke={color} strokeWidth={3} fill="none" />
        </svg>
      )}
    </>
  );
};

export const Axis: React.FC<{ opacity: number; highlight?: number; base?: number }> = ({ opacity, highlight, base = AX.base }) => (
  <div style={{ opacity }}>
    <div style={{ position: "absolute", left: colX(0) - 16, top: base + 2, width: colX(MAX_DMG) + AX.col - colX(0) + 32, height: 3, background: C.border }} />
    {Array.from({ length: MAX_DMG + 1 }, (_, v) => (
      <Text key={v} x={colX(v) + AX.col / 2} y={base + 12} w={AX.col + 14} size={28} mono weight={600} color={v === highlight ? C.hot : C.fg}>{v}</Text>
    ))}
    <Text x={colX(MAX_DMG) + AX.col + 30} y={base + 16} w={200} align="left" size={24} color={C.muted}>damage</Text>
  </div>
);

/** Outcome colour key; top-right unless `at` gives a centre point. */
/** A chance axis on the left with a dotted guide at one bar height, labelled with that chance. */
export const ChanceGuide: React.FC<{ base: number; top: number; y: number; toX: number; label: string; opacity: number; size?: number }> = ({ base, top, y, toX, label, opacity, size = 26 }) => {
  const ax = colX(0) - 26;
  return (
    <div style={{ opacity }}>
      <div style={{ position: "absolute", left: ax, top, width: 2, height: base - top + 4, background: C.border }} />
      <Text x={ax + 4} y={top - size * 1.6} w={200} align="right" size={size * 0.85} color={C.muted}>chance</Text>
      <div style={{ position: "absolute", left: ax - 8, top: y - 1, width: toX - ax + 8, borderTop: `2px dashed ${C.hit}`, opacity: 0.85 }} />
      <Text x={ax - 14} y={y - size * 0.62} w={160} align="right" size={size} mono weight={700} color={C.hit}>{label}</Text>
    </div>
  );
};

export const Legend: React.FC<{ opacity: number; at?: { x: number; y: number } }> = ({ opacity, at }) => (
  <div style={{ position: "absolute", ...(at ? { left: at.x, top: at.y, transform: "translateX(-50%)" } : { right: 150, top: 220 }), display: "flex", gap: 28, opacity, fontSize: 26 }}>
    {(["miss", "hit", "crit"] as const).map((k) => (
      <div key={k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 22, height: 22, borderRadius: 5, background: `${C[k]}55`, border: `2px solid ${C[k]}` }} />
        <span style={{ color: C[k] }}>{k}</span>
      </div>
    ))}
  </div>
);

export const Ep4Damage: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const bins: Bin[] = AT_AC.bins;
  const odds = AT_AC.odds;
  const zoom = lerp(1, 5, sp(T.zoom, 70));
  const Hb = (p: number) => p * DM.K * zoom; // bottom chart (zooms)
  const Ht = (p: number) => p * TOP.K; // top chart (fixed)
  const appear = sp(T.bins);
  /** A piece that leaves the top chart and lands in the bottom one; only clips once it has landed. */
  const fall = (f: number, x0: number, x1: number, b0: number, b1: number, h0: number, h1: number, color: string): Rect => ({
    x: lerp(x0, x1, f), w: lerp(BIG.w, AX.col, f), bottom: lerp(b0, b1, f), h: lerp(h0, h1, f), color, clipTop: f > 0.999 ? DM.top : -1e4,
  });

  // ---- miss: the whole bar drops into damage 0 ----
  const m = sp(T.miss);
  const missRect = fall(m, BIG.x.miss - BIG.w / 2, colX(0), TOP.base, DM.base, Ht(odds.miss), Hb(odds.miss), C.miss);

  // ---- hit: slice into 8 equal pieces, land on 1..8, then slide +4 (Dexterity) ----
  const offset = DAMAGE.dex * sp(T.shift);
  let hitAcc = 0;
  const hitPieces = HIT_FACES.map((v, j) => {
    const f = sp(T.hit + 20 + j * 4);
    const h0 = Ht(bins[v].hit);
    const b0 = TOP.base - hitAcc;
    hitAcc += h0;
    return { v, rect: fall(f, BIG.x.hit - BIG.w / 2, colX(v - DAMAGE.dex + offset), b0, DM.base, h0, Hb(bins[v].hit), C.hit) };
  });
  const hitSplit = frame >= T.hit + 20;

  // ---- crit: slice in proportion to each damage value's crit chance, stack on the hits ----
  let critAcc = 0;
  const critPieces = CRIT_VALUES.map((v, j) => {
    const f = sp(T.crit + 25 + j * 4);
    const h0 = Ht(bins[v].crit);
    const b0 = TOP.base - critAcc;
    critAcc += h0;
    return { v, rect: fall(f, BIG.x.crit - BIG.w / 2, colX(v), b0, DM.base - Hb(bins[v].hit), h0, Hb(bins[v].crit), C.crit) };
  });
  const critSplit = frame >= T.crit + 25;

  const PROBE = 10;
  const probing = frame >= T.prov + 30;
  const total = (v: number) => bins[v].miss + bins[v].hit + bins[v].crit;
  // each outcome's label fades as its bar starts to fall
  const leaves = { miss: T.miss, hit: T.hit + 10, crit: T.crit + 15 };
  // before slicing, each outcome is water in a bucket: it pours in and sloshes, then settles flat by the time the
  // scene is fully revealed; just before it falls, the bucket fades and the water hardens into the box that gets sliced
  const pour = clamp01(frame / 40);
  const slosh = 9 * (1 - ramp(frame, 8, 85));
  const toBox = (k: "miss" | "hit" | "crit") => ramp(frame, leaves[k] - 14, leaves[k]);

  return (
    <Stage part="Part 4: Turning Hits into Damage" captions={CAPTIONS}>
      {/* ---------- top chart: the three outcomes ---------- */}
      <div style={{ position: "absolute", left: BIG.x.miss - BIG.w / 2 - 60, top: TOP.base + 2, width: BIG.x.crit - BIG.x.miss + BIG.w + 120, height: 3, background: C.border, opacity: appear * (1 - ramp(frame, T.crit + 60, T.crit + 90)) }} />
      {(["miss", "hit", "crit"] as const).map((k) => {
        const o = appear * (1 - ramp(frame, leaves[k], leaves[k] + 15));
        return o > 0 ? (
          <Text key={k} x={BIG.x[k]} y={TOP.base + 14} w={300} size={32} weight={600} color={C[k]} opacity={o}>
            {k} <span style={{ fontFamily: F.mono }}>{pct(odds[k], 0)}</span>
          </Text>
        ) : null;
      })}

      {/* ---------- bottom chart: damage ---------- */}
      <Axis opacity={sp(T.bins + 10)} base={DM.base} highlight={probing ? PROBE : undefined} />
      <Legend opacity={sp(T.whole)} />

      {(["miss", "hit", "crit"] as const).map((k, i) => {
        const o = 1 - toBox(k);
        return o > 0 ? (
          <div key={k} style={{ position: "absolute", left: BIG.x[k] - BIG.w / 2, top: TOP.base - TOP.K, width: BIG.w, height: TOP.K, opacity: appear * o }}>
            <Water w={BIG.w} h={TOP.K} level={odds[k] * (1 - (1 - pour) ** 3)} frame={frame} seed={i * 2.1} amp={slosh} color={C[k]} />
            <div style={{ position: "absolute", left: -5, right: -5, top: -6, bottom: -5, border: `3px solid ${C.borderStrong}`, borderTop: "none", borderRadius: "0 0 18px 18px" }} />
          </div>
        ) : null;
      })}
      <Seg {...missRect} opacity={appear * toBox("miss")} />
      {!hitSplit && <Seg x={BIG.x.hit - BIG.w / 2} w={BIG.w} bottom={TOP.base} h={Ht(odds.hit)} color={C.hit} opacity={appear * toBox("hit")} clipTop={-1e4} />}
      {hitSplit && hitPieces.map((p) => <Seg key={p.v} {...p.rect} glow={probing && p.v === PROBE} />)}
      {!critSplit && <Seg x={BIG.x.crit - BIG.w / 2} w={BIG.w} bottom={TOP.base} h={Ht(odds.crit)} color={C.crit} opacity={appear * toBox("crit")} clipTop={-1e4} />}
      {critSplit && critPieces.map((p) => <Seg key={p.v} {...p.rect} glow={probing && p.v === PROBE} />)}

      {frame >= T.miss + 20 && (
        <Text x={colX(0) + AX.col / 2} y={Math.max(DM.top, DM.base - Hb(odds.miss)) - 48} w={160} size={30} mono weight={600} color={C.miss} opacity={sp(T.miss + 20)}>{pct(odds.miss, 0)}</Text>
      )}
      {/* the flat 1d8 block, then the slide */}
      {frame >= T.hit + 60 && frame < T.zoom + 20 && (() => {
        const cx = (colX(1 + offset) + colX(8 + offset) + AX.col) / 2;
        const y = DM.base - Hb(bins[1 + DAMAGE.dex].hit) - 54;
        const label = frame < T.shift ? `1d8 × ${pct(AT_AC.odds.hit, 0)}` : `1d8 + ${DAMAGE.dex}`;
        return <Text x={cx} y={y} w={500} size={30} mono weight={600} color={C.hit} opacity={sp(T.hit + 60) * (1 - ramp(frame, T.zoom, T.zoom + 20))}>{label}</Text>;
      })()}

      {/* after the zoom: what height the 5..12 bars stand at */}
      {frame >= T.zoom + 30 && (
        <ChanceGuide base={DM.base} top={DM.top} y={DM.base - Hb(bins[5].hit)} toX={colX(12) + AX.col} label={pct(bins[5].hit, 1)} opacity={sp(T.zoom + 40)} />
      )}

      {/* provenance probe */}
      {probing && (
        <div style={{ position: "absolute", left: colX(PROBE) + AX.col + 30, top: DM.base - Hb(total(PROBE)) - 250, opacity: sp(T.prov + 30), background: C.elevated, border: `1.5px solid ${C.borderStrong}`, borderRadius: 14, padding: "16px 22px", fontFamily: F.mono, fontSize: 28, lineHeight: 1.55, boxShadow: "0 10px 30px #0008" }}>
          <div style={{ color: C.fg, fontWeight: 600 }}>{PROBE} damage: {pct(total(PROBE), 2)}</div>
          <div style={{ color: C.hit }}>from hits:  {pct(bins[PROBE].hit, 2)}</div>
          <div style={{ color: C.crit }}>from crits: {pct(bins[PROBE].crit, 2)}</div>
        </div>
      )}
    </Stage>
  );
};
