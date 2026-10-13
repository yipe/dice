import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { COMBOS } from "../stunData";
import { C, F, Stage, ramp, useSp, type Caption } from "../kit";
import { PATHS, PATHS_BY_DEPTH, TR, Tree } from "./treeShared";

export const EP0_DURATION = 680;
// one column every 90 frames
const COL = [70, 160, 250, 340, 430] as const;
const T = { calm: 560 } as const;
// every die in the turn, in septillions (10^24): 7.9
const SEPTILLION = (COMBOS[COMBOS.length - 1].total / 1e24).toFixed(1);

export const CAPTIONS: Caption[] = [
  { from: 0, to: 160, text: "One turn of our monk-rogue: five attacks. Each can miss, hit or crit." },
  { from: 160, to: 250, text: "Vex: a shortsword hit gives the next attack advantage." },
  { from: 250, to: 340, text: "Sneak Attack lands only on the first weapon hit." },
  { from: 340, to: 470, text: "Stunning Strike: once per turn, the first Unarmed Strike that hits forces a saving throw." },
  { from: 470, to: 560, text: `Count every way the dice can land, and one turn has ${SEPTILLION} septillion possible rolls. They sort into ${PATHS} paths: every mix of miss, hit, crit and saving throw.` },
];

export const Ep0Prologue: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const io = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
  const grow = COL.map((s) => interpolate(frame, [s, s + 60], [0, 1], io));
  const headers = COL.map((s) => sp(s - 10));
  // the counter climbs on a log scale while each column grows
  const k = COL.filter((s) => frame >= s).length - 1; // the column now growing
  const t = k < 0 ? 0 : interpolate(frame, [COL[k], COL[k] + 60], [0, 1], io);
  const from = k <= 0 ? 0 : Math.log10(COMBOS[k - 1].total);
  const count = k < 0 ? 1 : 10 ** (from + (Math.log10(COMBOS[k].total) - from) * t);
  const paths = k < 0 ? 1 : Math.round(PATHS_BY_DEPTH[k] + (PATHS_BY_DEPTH[k + 1] - PATHS_BY_DEPTH[k]) * t);
  const calm = ramp(frame, T.calm, T.calm + 30);
  // once a column has finished growing, show its exact count rather than the float's
  const exactAt = k >= 0 && t >= 1 ? COMBOS[k].exact.toLocaleString("en-US") : undefined;

  return (
    <Stage part="Prologue: One Turn, Lots of Dice" captions={CAPTIONS}>
      <Tree grow={grow} headers={headers} marks={{ adv: sp(COL[1] + 20), sneak: sp(COL[2] + 20), save: sp(COL[3] + 30) }} opacity={1 - 0.75 * calm} />

      {/* the counter: every digit, so the size of it lands */}
      <div style={{ position: "absolute", left: TR.left - 20, right: 150, top: TR.bottom + 36, display: "flex", alignItems: "baseline", gap: 26, opacity: sp(COL[0]) * (1 - 0.6 * calm) }}>
        <div style={{ fontSize: 26, color: C.muted, width: 150, lineHeight: 1.15 }}>possible dice rolls</div>
        <div style={{ fontFamily: F.mono, fontSize: 60, fontWeight: 700, color: C.hot, flex: 1, whiteSpace: "nowrap" }}>{exactAt ?? Math.round(count).toLocaleString("en-US")}</div>
        <div style={{ fontSize: 26, color: C.muted }}>paths</div>
        <div style={{ fontFamily: F.mono, fontSize: 44, fontWeight: 700, width: 90, textAlign: "right" }}>{paths}</div>
      </div>

      {/* the turn, as a single question */}
      {frame >= T.calm && (
        <div style={{ position: "absolute", left: 160, right: 160, top: 400, textAlign: "center", opacity: sp(T.calm + 10), fontFamily: F.display, fontSize: 58, fontWeight: 700, lineHeight: 1.2, textWrap: "balance" }}>
          <div>That's way too much to simulate,<br />so we'll use probabilities instead.</div>
          <div style={{ color: C.hot, marginTop: 24, opacity: sp(T.calm + 40) }}>So, how do we figure out how much damage this build does on average?</div>
        </div>
      )}
    </Stage>
  );
};
