import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { CASCADE, PMF, TURN } from "../advancedData";
import { AT_AC } from "../attackData";
import { C, F, Stage, Text, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { Cards, DprShift, SNEAK, TB, TurnBuckets, VEX, f2 } from "./monkShared";

export const EP9_DURATION = 560;
const STEP = 70;
const T = { cards: 0, block: 50, cascade: 90, never: 300, same: 320, out: [410, 435], morph: [445, 505] } as const;
const odds = AT_AC.odds;
const land = 1 - odds.miss;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 90, text: "Next up, Sneak Attack: +1d6, once per turn, on the first hit with a finesse weapon." },
  { from: 90, to: 160, text: `Pour 100% of turns through the weapon attacks. The first shortsword hits ${pct(land, 0)}: Sneak Attack lands there.` },
  { from: 160, to: 320, text: `The other ${pct(odds.miss, 0)} try again with the second shortsword, then the scimitar. Only ${pct(CASCADE[3], 2)} of turns miss all three.` },
  { from: 320, to: 440, text: "Now we know how often Sneak Attack lands, and on which attack, so we can weight its damage correctly in the DPR." },
  { from: 440, to: EP9_DURATION + 1, text: `Sneak Attack adds ${f2(TURN.full - TURN.vex)} (its dice double on a crit): ${f2(TURN.full)} per turn.` },
];

// ---------- the cascade ----------
const COLS = [430, 780, 1130, 1480]; // centres: shortsword 1, shortsword 2, scimitar, never
const W = 220;
const BASE = 880;
const H = 400; // 100% of turns
const waiting = [1, odds.miss, odds.miss ** 2, odds.miss ** 3];
const LABEL = ["on Shortsword 1", "on Shortsword 2", "on the Scimitar", "never"];

export const Ep9Sneak: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const out = 1 - ramp(frame, T.out[0], T.out[1]);
  const morph = interpolate(frame, [T.morph[0], T.morph[1]], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const K = (0.92 * (TB.base - TB.top)) / Math.max(...PMF.vex, ...PMF.full);
  const step = Math.floor((frame - T.cascade) / STEP);

  // the block of turns still waiting: it sits in column i, keeps CASCADE[i] (gold), and the rest slides to i + 1
  const blocks: React.ReactNode[] = [];
  for (let i = 0; i < 3; i++) {
    const s = T.cascade + i * STEP;
    const split = ramp(frame, s + 10, s + 30);
    const move = interpolate(frame, [s + 30, s + 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
    const arrived = i === 0 ? sp(T.block) : frame >= s - STEP + 60 ? 1 : 0;
    if (arrived <= 0) continue;
    const keepH = H * CASCADE[i];
    const restH = H * waiting[i + 1];
    // the gold part that stays (Sneak Attack lands on this attack)
    blocks.push(<div key={`k${i}`} style={{ position: "absolute", left: COLS[i] - W / 2, top: BASE - keepH, width: W, height: keepH, background: lerp(0, 1, split) > 0.5 ? `${SNEAK}55` : `${C.accent}44`, border: `2px solid ${split > 0.5 ? SNEAK : C.accent}`, borderRadius: 8, opacity: arrived }} />);
    // the part that missed and moves on
    if (frame < s + 60 || i === 2) {
      const x = lerp(COLS[i], COLS[i + 1], move) - W / 2;
      const yTop = lerp(BASE - keepH - restH, BASE - restH, move);
      blocks.push(<div key={`r${i}`} style={{ position: "absolute", left: x, top: yTop - split * 8, width: W, height: restH, background: `${C.miss}44`, border: `2px solid ${C.miss}`, borderRadius: 8, opacity: arrived }} />);
    }
    if (frame >= s + 30) blocks.push(<Text key={`t${i}`} x={COLS[i]} y={BASE - keepH - 46} w={260} size={30} mono weight={700} color={SNEAK} opacity={ramp(frame, s + 30, s + 45)}>{pct(CASCADE[i], 2)}</Text>);
  }

  return (
    <Stage part="Part 9: Sneak Attack: First Hit" captions={CAPTIONS}>
      <Cards appear={() => sp(T.cards)} lit={(i) => i < 3 && step === i} tags={["Vex", "Nick"]} />

      {out > 0 && (
        <div style={{ opacity: out }}>
          {COLS.map((x, i) => <Text key={i} x={x} y={BASE + 56} w={240} size={28} weight={700} color={i < 3 ? SNEAK : C.miss} opacity={sp(T.block)}>{i < 3 ? <>Sneak Attack<br />{LABEL[i]}</> : <>no<br />Sneak Attack</>}</Text>)}
          <div style={{ position: "absolute", left: COLS[0] - W / 2 - 20, top: BASE + 2, width: COLS[3] - COLS[0] + W + 40, height: 3, background: C.border }} />
          {blocks}
          {frame >= T.never && <Text x={COLS[3]} y={BASE - H * CASCADE[3] - 46} w={260} size={30} mono weight={700} color={C.miss} opacity={sp(T.never)}>{pct(CASCADE[3], 2)}</Text>}
          {frame >= T.same && (
            <div style={{ position: "absolute", left: 1000, top: 430, width: 700, opacity: sp(T.same), fontFamily: F.mono, fontSize: 26, lineHeight: 1.6 }}>
              <div>Sneak Attack lands</div>
              <div style={{ fontSize: 44, fontWeight: 700, color: SNEAK }}>{pct(TURN.sneakFires, 2)}</div>
              <div style={{ color: C.muted }}>of turns</div>
            </div>
          )}
        </div>
      )}

      {frame >= T.out[0] && (
        <TurnBuckets
          opacity={ramp(frame, T.out[0] + 10, T.out[1] + 10)}
          layers={[
            { arr: PMF.vex.map((p, v) => Math.min(lerp(p, PMF.full[v], morph), p)), color: C.accent },
            { arr: PMF.vex.map((p, v) => Math.max(0, lerp(p, PMF.full[v], morph) - p)), color: SNEAK },
          ]}
          K={K}
        />
      )}

      {/* the balance point: Vex's 28.53 (blue) gives way to the Sneak Attack turn's (green), which slides right to 32.14 */}
      {frame >= T.out[0] && <DprShift from={TURN.vex} to={TURN.full} morph={morph} done={ramp(frame, T.morph[1], T.morph[1] + 14)} color={SNEAK} opacity={ramp(frame, T.out[0] + 10, T.out[1] + 10)} />}

    </Stage>
  );
};
