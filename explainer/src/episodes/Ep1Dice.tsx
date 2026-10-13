import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { FACES, FACE_P, MOD, PAIRS, PAIR_COUNT, ROLL_1, ROLL_2, SIDES, SUMS, SUM_P, SUM_WAYS, sumColor } from "../data8";
import { D8 } from "../D20";
import { C, F, Stage, Text, clamp01, lerp, pct, ramp, useSp, type Caption } from "../kit";

export const EP1_DURATION = 880;
// everything starts after a 60-frame opening line
const T = { roll1: [72, 118], toSlot: [124, 146], fill: 152, phaseB: 265, roll2: [282, 322], eq: 326, grid: 362, clearTop: 452, fly: 462, counts: 580, focus: 605, mod: 685, roll: [700, 760] } as const;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 60, text: "First let's look at how to represent odds: as buckets!" },
  { from: 60, to: 124, text: "Roll a d8: our monk's Martial Arts die." },
  { from: 124, to: 212, text: `It lands on ${ROLL_1}. It could have been any of eight faces.` },
  { from: 212, to: 265, text: `Eight faces, eight buckets. Each gets the same chance: 1 in ${SIDES}.` },
  { from: 265, to: 326, text: "And what if you crit? Roll a second d8." },
  { from: 326, to: 362, text: `${ROLL_1} + ${ROLL_2} = ${ROLL_1 + ROLL_2}. That is one outcome.` },
  { from: 362, to: 456, text: `Two d8s make ${SIDES} × ${SIDES} = ${PAIR_COUNT} pairs. Each pair is equally likely.` },
  { from: 456, to: 584, text: `Pour all ${PAIR_COUNT} pairs into buckets by their total.` },
  { from: 584, to: 685, text: `This shows us ${SIDES + 1} is the most likely total, happening ${SUM_WAYS[SIDES - 1]} of every ${PAIR_COUNT} rolls.` },
  { from: 685, to: 785, text: `Now add your modifier: +${MOD} to every total.` },
  { from: 785, to: EP1_DURATION + 1, text: `This is 2d8 + ${MOD}: the same triangle, shifted by ${MOD}.` },
];

const SLOT = { w: 170, h: 290, gap: 16, top: 370 };
const slotLeft = (1920 - (SIDES * SLOT.w + (SIDES - 1) * SLOT.gap)) / 2;
const slotCx = (i: number) => slotLeft + SLOT.w / 2 + i * (SLOT.w + SLOT.gap);
const SLOT_DIE_Y = SLOT.top + 100;

// the opening: five buckets whose water level is their chance
const OPEN_WAYS = [1, 3, 5, 3, 1];
const OPEN_TOTAL = OPEN_WAYS.reduce((a, b) => a + b, 0);
const OPEN = { top: 330, H: 300, left: 960 - 2 * 230 - 85, right: 960 + 2 * 230 + 85 };

const CELL = 60;
const GRID = { gap: 6, cx: 1290, cy: 600 };
const gridSpan = SIDES * CELL + (SIDES - 1) * GRID.gap;
const gridX = (b: number) => GRID.cx - gridSpan / 2 + (b - 1) * (CELL + GRID.gap);
const gridY = (a: number) => GRID.cy - gridSpan / 2 + (a - 1) * (CELL + GRID.gap);

const HIST = { col: 66, gap: 10, base: 930, stack: 4 };
const histSpan = SUMS.length * HIST.col + (SUMS.length - 1) * HIST.gap;
const histX = (sum: number) => (1920 - histSpan) / 2 + (sum - 2) * (HIST.col + HIST.gap) + (HIST.col - CELL) / 2;
const histY = (k: number) => HIST.base - (k + 1) * CELL - k * HIST.stack;
const LEFT = { d1: [380, 440], d2: [620, 440], eq: [500, 600] } as const;

/** A number that rolls up like an odometer: 9.4 shows 9 sliding out and 10 sliding in. */
const Roll: React.FC<{ v: number }> = ({ v }) => {
  const lo = Math.floor(v + 1e-6), f = v - lo;
  if (f < 0.01) return <>{lo}</>;
  return (
    <span style={{ display: "inline-block", overflow: "hidden", height: "1.2em", lineHeight: "1.2em", verticalAlign: "bottom" }}>
      <span style={{ display: "block", transform: `translateY(${-f * 1.2}em)` }}>
        <span style={{ display: "block" }}>{lo}</span>
        <span style={{ display: "block" }}>{lo + 1}</span>
      </span>
    </span>
  );
};

/** Water filling a bucket from the bottom. The surface waves with the frame, so on the web page it moves while you
 * scroll and holds still when you stop. `level` is the filled share of the height (0..1). */
export const Water: React.FC<{ w: number; h: number; level: number; frame: number; seed?: number; amp?: number; color?: string }> = ({ w, h, level, frame, seed = 0, amp = 6, color = C.accent }) => {
  if (level <= 0) return null;
  const a = Math.min(amp, level * h * 0.5); // a near-empty bucket barely ripples
  const surf = (x: number) => h - level * h + a * (0.7 * Math.sin(x / 26 + frame * 0.16 + seed) + 0.3 * Math.sin(x / 11 - frame * 0.23 + seed * 2));
  const xs = Array.from({ length: Math.ceil(w / 4) + 1 }, (_, i) => Math.min(w, i * 4));
  const top = xs.map((x, i) => `${i ? "L" : "M"}${x},${surf(x).toFixed(1)}`).join(" ");
  return (
    <svg style={{ position: "absolute", left: 0, top: 0 }} width={w} height={h}>
      <path d={`${top} L${w},${h} L0,${h} Z`} fill={`${color}55`} />
      <path d={top} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" />
    </svg>
  );
};

const Cell: React.FC<{ sum: number; hot?: boolean; add?: number }> = ({ sum, hot, add = 0 }) => {
  const col = sumColor(sum);
  return (
    <div style={{ width: CELL, height: CELL, borderRadius: 9, background: `${col}2e`, border: `2px solid ${hot ? C.hot : col}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.mono, fontWeight: 600, fontSize: 26, color: hot ? C.hot : C.fg, boxShadow: hot ? `0 0 22px ${C.hot}88` : undefined }}>
      <Roll v={sum + add} />
    </div>
  );
};

export const Ep1Dice: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const tumble = (start: number, end: number, from: [number, number, number]) => {
    const t = interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
    return from.map((a) => a * (1 - t)) as [number, number, number];
  };
  const bounce = (start: number, end: number) => (frame > start && frame < end ? -Math.abs(Math.sin((frame - start) / 5)) * 40 * (1 - (frame - start) / (end - start)) : 0);

  const toSlot = sp(T.toSlot[0]);
  const toLeft = sp(T.phaseB);
  const slot = { x: slotCx(ROLL_1 - 1), y: SLOT_DIE_Y, s: 100 };
  let d1 = { x: 960, y: 250, s: 170 };
  d1 = { x: lerp(d1.x, slot.x, toSlot), y: lerp(d1.y, slot.y, toSlot), s: lerp(d1.s, slot.s, toSlot) };
  d1 = { x: lerp(d1.x, LEFT.d1[0], toLeft), y: lerp(d1.y, LEFT.d1[1], toLeft), s: lerp(d1.s, 150, toLeft) };
  const top = 1 - clamp01((frame - T.clearTop) / 14);
  const slotsFade = 1 - clamp01((frame - T.phaseB) / 16);
  const highlight = frame >= T.eq && frame < T.clearTop ? C.hot : undefined;

  const fillOrder = FACES.filter((f) => f !== ROLL_1);
  const slotFill = (face: number) => (face === ROLL_1 ? clamp01((frame - T.toSlot[0]) / 18) : sp(T.fill + fillOrder.indexOf(face) * 9));
  const sortedForFly = [...PAIRS].sort((p, q) => p.sum - q.sum || p.a - q.a);
  const kWithin = (a: number, sum: number) => PAIRS.filter((p) => p.sum === sum && p.a < a).length;
  const focus = clamp01((frame - T.focus) / 16) * (1 - clamp01((frame - T.mod) / 14));
  // the modifier: every total rolls up by MOD, one bucket after another
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const addFor = (sum: number) => MOD * ease(ramp(frame, T.roll[0] + (sum - 2) * 2, T.roll[1] - 28 + (sum - 2) * 2));
  const PEAK = SIDES + 1;

  const die = (x: number, y: number, s: number, value: number, spin: [number, number, number], scale: number, opacity: number) => (
    <div style={{ position: "absolute", left: x - s / 2, top: y - s / 2, opacity, transform: `scale(${scale})` }}>
      <D8 value={value} size={s} spin={spin} highlight={highlight} />
    </div>
  );

  return (
    <Stage part="Part 1: Buckets and Odds" captions={CAPTIONS}>
      {/* ---------- the opening: odds as buckets, fuller means likelier ---------- */}
      {frame < T.roll1[0] + 10 && (
        <div style={{ position: "absolute", inset: 0, opacity: clamp01(frame / 12) * (1 - clamp01((frame - (T.roll1[0] - 14)) / 20)) }}>
          {/* chance guides: a bucket's water level is its probability, so empty is never and full is every time */}
          {([[0, "0%: never"], [0.5, "50%: half the time"], [1, "100%: every time"]] as const).map(([p, label]) => {
            const y = OPEN.top + OPEN.H - 3 - p * (OPEN.H - 3);
            return (
              <React.Fragment key={p}>
                <div style={{ position: "absolute", left: OPEN.left - 20, width: OPEN.right - OPEN.left + 40, top: y - 1, borderTop: `2px dotted ${C.muted}`, opacity: 0.7 }} />
                <Text x={OPEN.left - 36} y={y - 17} w={300} align="right" size={26} color={C.muted}>{label}</Text>
              </React.Fragment>
            );
          })}
          {OPEN_WAYS.map((ways, i) => {
            const x = 960 + (i - 2) * 230, W = 170, H = OPEN.H, top = OPEN.top;
            // the level is the bucket's chance: its ways out of all 13 equally likely ways
            const fill = (ways / OPEN_TOTAL) * clamp01((frame - 8 - i * 4) / 26);
            return (
              <React.Fragment key={i}>
                <div style={{ position: "absolute", left: x - W / 2, top, width: W, height: H, borderRadius: "0 0 22px 22px", border: `3px solid ${C.borderStrong}`, borderTop: "none", overflow: "hidden" }}>
                  <Water w={W - 6} h={H - 3} level={fill} frame={frame} seed={i * 1.7} />
                </div>
                <Text x={x} y={top + H + 20} w={200} size={30} mono weight={600} color={C.muted}>{`${ways} ${ways === 1 ? "way" : "ways"}`}</Text>
              </React.Fragment>
            );
          })}
          <Text x={960} y={250} w={1200} size={34} weight={600} color={C.accent}>the fuller the bucket, the more likely the outcome</Text>
        </div>
      )}

      {/* ---------- eight buckets ---------- */}
      {frame < T.phaseB + 20 &&
        FACES.map((face, i) => {
          const appear = sp(T.toSlot[0] - 30 + i * 3);
          const filled = slotFill(face);
          return (
            <div key={face} style={{ position: "absolute", left: slotCx(i) - SLOT.w / 2, top: SLOT.top, width: SLOT.w, height: SLOT.h, opacity: appear * slotsFade, transform: `translateY(${(1 - appear) * 30}px)` }}>
              <div style={{ position: "absolute", inset: 0, borderRadius: 18, background: C.surface, border: `2px solid ${face === ROLL_1 && frame >= T.toSlot[1] && frame < T.fill ? C.hot : C.border}`, overflow: "hidden" }}>
                {/* water up to this face's chance, 1/8 of the bucket */}
                <Water w={SLOT.w - 4} h={SLOT.h - 4} level={FACE_P[i] * filled} frame={frame} seed={i * 1.3} amp={5} />
              </div>
              {face !== ROLL_1 && filled > 0.01 && (
                <div style={{ position: "absolute", left: SLOT.w / 2 - 50, top: 100 - 50, transform: `scale(${filled})`, opacity: frame < T.fill + 70 ? 0.6 : 1 }}>
                  <D8 value={face} size={100} spin={[0, 0, 0]} />
                </div>
              )}
              <div style={{ position: "absolute", top: 165, width: "100%", textAlign: "center", opacity: filled }}>
                <div style={{ fontFamily: F.mono, fontSize: 36, fontWeight: 600 }}>1/{SIDES}</div>
                <div style={{ fontFamily: F.mono, fontSize: 24, color: C.muted, marginTop: 2 }}>{pct(FACE_P[i])}</div>
              </div>
            </div>
          );
        })}

      {/* ---------- the two dice ---------- */}
      {die(d1.x, d1.y + bounce(T.roll1[0], T.roll1[1]), d1.s, ROLL_1, tumble(T.roll1[0], T.roll1[1], [9.3, -7.1, 2.4]), sp(T.roll1[0] - 10), top)}
      {frame >= T.roll2[0] - 10 && die(LEFT.d2[0], LEFT.d2[1] + bounce(T.roll2[0], T.roll2[1]), 150, ROLL_2, tumble(T.roll2[0], T.roll2[1], [-8.2, 9.6, -2.9]), sp(T.roll2[0] - 8), top)}
      {frame >= T.eq && (
        <div style={{ position: "absolute", left: LEFT.eq[0] - 260, width: 520, top: LEFT.eq[1] - 45, textAlign: "center", fontFamily: F.display, fontSize: 84, fontWeight: 700, opacity: sp(T.eq) * top }}>
          {ROLL_1} + {ROLL_2} = <span style={{ color: C.hot }}>{ROLL_1 + ROLL_2}</span>
        </div>
      )}

      {/* ---------- 8 x 8 grid headers ---------- */}
      {frame >= T.grid - 10 && (
        <div style={{ opacity: sp(T.grid) * top }}>
          <Text x={GRID.cx} y={gridY(1) - 100} w={400} size={30} color={C.muted}>second die</Text>
          <div style={{ position: "absolute", left: gridX(1) - 200, width: 220, top: GRID.cy - 16, textAlign: "center", fontSize: 30, color: C.muted, transform: "rotate(-90deg)" }}>first die</div>
          {FACES.map((f) => (
            <React.Fragment key={f}>
              <Text x={gridX(f) + CELL / 2} y={gridY(1) - 48} w={60} size={30} mono weight={600} color={f === ROLL_2 ? C.hot : C.fg}>{f}</Text>
              <Text x={gridX(1) - 36} y={gridY(f) + 12} w={60} size={30} mono weight={600} color={f === ROLL_1 ? C.hot : C.fg}>{f}</Text>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* ---------- 64 cells: grid, then buckets ---------- */}
      {frame >= T.grid &&
        PAIRS.map((p, idx) => {
          const appear = sp(T.grid + idx * 0.9);
          const fly = sp(T.fly + sortedForFly.indexOf(p) * 1.4);
          const x = lerp(gridX(p.b), histX(p.sum), fly);
          const y = lerp(gridY(p.a), histY(kWithin(p.a, p.sum)), Math.min(fly, 1));
          const isRoll = p.a === ROLL_1 && p.b === ROLL_2;
          const dim = focus > 0 && p.sum !== PEAK;
          return (
            <div key={idx} style={{ position: "absolute", left: x, top: y, transform: `scale(${appear})`, opacity: dim ? 1 - 0.55 * focus : 1, zIndex: isRoll ? 2 : 1 }}>
              <Cell sum={p.sum} hot={isRoll && frame < T.fly + 60} add={addFor(p.sum)} />
            </div>
          );
        })}

      {/* ---------- bucket labels ---------- */}
      {frame >= T.fly &&
        SUMS.map((s, i) => {
          const c = sp(T.counts + i * 2);
          const hot = s === PEAK;
          return (
            <React.Fragment key={s}>
              <Text x={histX(s) + CELL / 2} y={HIST.base + 14} w={80} size={32} mono weight={600} color={hot && focus > 0 ? C.hot : C.fg} opacity={sp(T.fly + 10 + i * 2)}><Roll v={s + addFor(s)} /></Text>
              <Text x={histX(s) + CELL / 2} y={histY(SUM_WAYS[i] - 1) - 40} w={100} size={26} mono color={hot ? C.hot : C.muted} opacity={c * (focus > 0 && !hot ? 0.5 : 1)}>{SUM_WAYS[i]}/{PAIR_COUNT}</Text>
            </React.Fragment>
          );
        })}
      {frame >= T.fly && <div style={{ position: "absolute", left: histX(2) - 16, width: histSpan + 26, top: HIST.base + 4, height: 3, background: C.border, transformOrigin: "left", transform: `scaleX(${sp(T.fly)})` }} />}
      {/* the name on top ("2d8", then "+ 4" slides in with the modifier) and the peak's chance, whose total rolls 9 -> 13 */}
      {frame >= T.focus && (
        <>
          <Text x={histX(PEAK) + CELL / 2} y={histY(SIDES - 1) - 215} w={700} size={64} weight={700} color={C.hot} opacity={clamp01((frame - T.focus) / 16)}>
            <span style={{ fontFamily: F.display }}>
              2d8
              <span style={{ display: "inline-block", whiteSpace: "pre", overflow: "hidden", verticalAlign: "bottom", maxWidth: `${3.2 * sp(T.mod)}em`, opacity: sp(T.mod), transform: `translateX(${(1 - sp(T.mod)) * 30}px)` }}>{` + ${MOD}`}</span>
            </span>
          </Text>
          <Text x={histX(PEAK) + CELL / 2} y={histY(SIDES - 1) - 104} w={600} size={34} weight={600} color={C.hot} opacity={clamp01((frame - T.focus) / 16)}>
            P(<Roll v={PEAK + addFor(PEAK)} />) = {SUM_WAYS[PEAK - 2]}/{PAIR_COUNT} = {pct(SUM_P[PEAK - 2])}
          </Text>
        </>
      )}
    </Stage>
  );
};
