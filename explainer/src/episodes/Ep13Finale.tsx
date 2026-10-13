import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { COMBOS, PIECES, STATS } from "../stunData";
import { C, F, Stage, ramp, useSp, type Caption } from "../kit";
import { SNEAK, VEX, f2 } from "./monkShared";
import { COMBO_DIGITS, PATHS_STUN_FIRST, ROOT_Y, STUN, TR, Tree } from "./treeShared";

export const EP13_DURATION = 720;
const T = { show: 0, fold: [110, 330], number: 330, boom: 360, split: [440, 480], bar: 490 } as const;
const DPR = STATS.stunVex.dpr; // the winning order: Unarmed Strikes first
// The number is laid out around a fixed slot for its decimal point, so the tree's root dot can fly in and BE the period.
const NUM = { fs: 220, side: 300, slot: 64, r: 16 };
const DOT_TOP = Math.round(NUM.fs * 0.8) - NUM.r + 2; // the period's centre, from the top of the number's line box

// The prologue's roll counter, in this tree's order (Unarmed Strikes first). Every attack rolls two d20s and two d8s;
// the first Unarmed Strike adds the save's d20, the first shortsword adds Sneak Attack's two d6. As the tree folds
// right to left, the count unwinds column by column, down to 1.
const PER_ATTACK = 20n * 20n * 8n * 8n;
const FACTORS = [PER_ATTACK * 20n, PER_ATTACK, PER_ATTACK * 36n, PER_ATTACK, PER_ATTACK];
const UPTO = FACTORS.reduce<bigint[]>((acc, f) => [...acc, acc[acc.length - 1] * f], [1n]); // rolls for the first d columns
if (UPTO[5] !== COMBOS[COMBOS.length - 1].exact) throw new Error("same dice in either order: the finale's count must match the prologue's");

export const CAPTIONS: Caption[] = [
  { from: 0, to: 110, text: `Here is the prologue's tree again, with the Unarmed Strikes first: ${PATHS_STUN_FIRST} paths, ${COMBO_DIGITS} rolls.` },
  { from: 110, to: 330, text: "Fold it up, step by step: every branch becomes its average." },
  { from: 330, to: 440, text: `The whole turn, every roll accounted for: ${f2(DPR)} damage per round.` },
  { from: 440, to: EP13_DURATION + 1, text: "And here is where every point of it comes from." },
];

export const Ep13Finale: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const fold = interpolate(frame, [T.fold[0], T.fold[1]], [0, 5], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const show = sp(T.show);
  const boom = frame - T.boom;
  const pulse = boom > 0 ? 1 + 0.18 * Math.exp(-boom / 9) * Math.cos(boom / 3) : 1;
  const n = interpolate(frame, [T.number, T.number + 30], [0, DPR], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const rootY = (TR.top + TR.bottom) / 2;
  const up = interpolate(frame, [T.split[0], T.split[1]], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  // as the tree folds into its root, the root drifts to where the period will be, growing and turning orange
  const move = Easing.inOut(Easing.cubic)(ramp(frame, T.fold[0] + 30, T.number));
  const root = { x: TR.left, y: ROOT_Y.stunVex };
  const dotAt = { x: 960, y: rootY - 150 + DOT_TOP };
  const shift = { x: (dotAt.x - root.x) * move, y: (dotAt.y - root.y) * move };
  const dotR = 9 + (NUM.r - 9) * move;
  const [intPart, fracPart] = f2(n).split(".");
  // columns still standing: 5 before the fold, 0 once it is done
  const depth = 5 - fold;
  const d0 = Math.floor(depth), dt = depth - d0;
  const count = dt < 1e-6 ? UPTO[d0].toLocaleString("en-US") : Math.round(10 ** (Math.log10(Number(UPTO[d0])) + (Math.log10(Number(UPTO[d0 + 1])) - Math.log10(Number(UPTO[d0]))) * dt)).toLocaleString("en-US");
  const counterOut = ramp(frame, T.number + 15, T.number + 35); // "1" holds a beat as the DPR lands
  return (
    <Stage part="Finale: Folding It All into One Number" captions={CAPTIONS}>
      <div style={{ position: "absolute", inset: 0, transform: `translate(${shift.x}px, ${shift.y}px)` }}>
        <Tree order="stunVex" grow={[1, 1, 1, 1, 1]} fold={fold} headers={[1, 1, 1, 1, 1].map(() => show)} marks={{ adv: show, sneak: show, save: show }} opacity={show * (1 - ramp(frame, T.number - 10, T.number + 10))} />
      </div>
      {/* the prologue's counter, unwinding to 1 as the tree folds */}
      {frame < T.number + 35 && (
        <div style={{ position: "absolute", left: TR.left - 20, right: 150, top: TR.bottom + 36, display: "flex", alignItems: "baseline", gap: 26, opacity: show * (1 - counterOut) }}>
          <div style={{ fontSize: 26, color: C.muted, width: 150, lineHeight: 1.15 }}>possible dice rolls</div>
          <div style={{ fontFamily: F.mono, fontSize: 60, fontWeight: 700, color: C.hot, flex: 1, whiteSpace: "nowrap" }}>{count}</div>
        </div>
      )}
      {/* the root dot, on its way to becoming the period */}
      {frame < T.number && (
        <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
          <circle cx={root.x + shift.x} cy={root.y + shift.y} r={dotR} fill={C.fg} opacity={show} />
          <circle cx={root.x + shift.x} cy={root.y + shift.y} r={dotR} fill={C.hot} opacity={show * move} style={{ filter: `drop-shadow(0 0 ${14 * move}px ${C.hot})` }} />
        </svg>
      )}

      {frame >= T.number && (
        <div style={{ position: "absolute", left: 0, right: 0, top: rootY - 150, textAlign: "center", transformOrigin: "50% 0", transform: `translateY(${-130 * up}px) scale(${1 - 0.45 * up})` }}>
          <div style={{ position: "relative", display: "inline-flex", transform: `scale(${pulse})`, fontFamily: F.display, fontSize: NUM.fs, fontWeight: 700, color: C.hot, lineHeight: 1, textShadow: boom > 0 ? `0 0 ${60 * Math.exp(-boom / 25)}px ${C.hot}` : undefined }}>
            {/* digits fade in around the dot, which is already in place as the period */}
            <span style={{ width: NUM.side, textAlign: "right", opacity: ramp(frame, T.number - 6, T.number + 8) }}>{intPart}</span>
            <span style={{ width: NUM.slot }} />
            <span style={{ width: NUM.side, textAlign: "left", opacity: ramp(frame, T.number - 6, T.number + 8) }}>{fracPart}</span>
            <div style={{ position: "absolute", left: NUM.side + NUM.slot / 2 - NUM.r, top: DOT_TOP - NUM.r, width: 2 * NUM.r, height: 2 * NUM.r, borderRadius: "50%", background: C.hot, boxShadow: boom > 0 ? `0 0 ${40 * Math.exp(-boom / 25)}px ${C.hot}` : `0 0 14px ${C.hot}` }} />
          </div>
          <div style={{ fontFamily: F.mono, fontSize: 34, fontWeight: 600, marginTop: 18, opacity: sp(T.boom + 10) }}>damage per round</div>
          <div style={{ fontSize: 28, color: C.muted, marginTop: 26, opacity: sp(T.boom + 50) * (1 - up) }}>Monk 5 / Rogue 1 vs AC 15, Flurry of Blows first with Stunning Strike, then Vex, Nick, and Sneak Attack.</div>
        </div>
      )}

      {/* ---------- the breakdown: each attack, then what each condition adds ---------- */}
      {frame >= T.bar - 10 && (() => {
        const BAR = { left: 210, width: 1500, top: 640, height: 100, gap: 4 };
        const total = PIECES.reduce((a, p) => a + p.v, 0);
        const unit = (BAR.width - BAR.gap * (PIECES.length - 1)) / total;
        const color = { attack: C.accent, vex: VEX, sneak: SNEAK, stun: STUN } as const;
        let x = BAR.left;
        let extra = 0;
        return PIECES.map((p, i) => {
          const w = p.v * unit;
          const at = x;
          x += w + BAR.gap;
          const grow = sp(T.bar + i * 9);
          const col = color[p.kind];
          const isAttack = p.kind === "attack";
          // the conditions get stacked labels above the bar, each with a tick down to its piece
          const row = isAttack ? 0 : extra++;
          // the leftmost condition sits nearest the bar, so no tick crosses another label
          const labelY = BAR.top - 70 - row * 54;
          return (
            <React.Fragment key={p.key}>
              <div style={{ position: "absolute", left: at, top: BAR.top, width: Math.max(0, w * grow), height: BAR.height, background: `${col}${isAttack && i % 2 ? "3a" : "55"}`, border: `2px solid ${col}`, borderRadius: 8, boxSizing: "border-box" }} />
              {isAttack ? (
                <div style={{ position: "absolute", left: at, top: BAR.top + BAR.height + 16, width: w, textAlign: "center", opacity: grow, fontFamily: F.mono }}>
                  <div style={{ fontSize: 32, fontWeight: 700, color: C.fg }}>{f2(p.v)}</div>
                  <div style={{ fontSize: 21, color: C.muted, whiteSpace: "nowrap" }}>{p.label}</div>
                </div>
              ) : (
                <div style={{ opacity: grow }}>
                  <div style={{ position: "absolute", left: at + w / 2 - 1, top: labelY + 40, width: 2, height: BAR.top - labelY - 40, background: col, opacity: 0.6 }} />
                  <div style={{ position: "absolute", right: 1920 - (at + w / 2) - 14, top: labelY, whiteSpace: "nowrap", fontFamily: F.mono, fontSize: 30, textAlign: "right" }}>
                    <b style={{ color: col }}>{`+${f2(p.v)}`}</b> <span style={{ color: C.muted, fontSize: 24 }}>{p.label}</span>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        });
      })()}
    </Stage>
  );
};
