import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ADV_LAND, PMF, TURN } from "../advancedData";
import { AT_AC } from "../attackData";
import { C, F, Stage, Text, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { CARD, Cards, TB, TurnBuckets, VEX, cardX, f2 } from "./monkShared";

export const EP8_DURATION = 520;
const T = { cards: 0, grid: 40, breakAt: [110, 170], meters: 200, formula: 230, buckets: [300, 330], morph: [340, 400], outro: 430 } as const;
const odds = AT_AC.odds;
const land = 1 - odds.miss;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 75, text: "Now let's bring back Vex: when a shortsword hits, your next attack has advantage." },
  { from: 75, to: 200, text: `If the first shortsword hits, the second rolls with advantage: ${pct(ADV_LAND, 2)} to hit, not ${pct(land, 0)}.` },
  { from: 200, to: 300, text: `Carry the odds forward: the second shortsword has advantage ${pct(TURN.advantage[1], 0)} of the time, the scimitar ${pct(TURN.advantage[2], 2)}.` },
  { from: 300, to: 430, text: `With Vex, DPR rises from ${f2(TURN.independent)} to ${f2(TURN.vex)}.` },
  { from: 430, to: EP8_DURATION + 1, text: "Only the second shortsword and the scimitar gain. The scimitar has Nick, not Vex, so the Unarmed Strikes after it never get advantage." },
];

// Vex triggers on any hit, crits included (a crit is a hit). The tree sits at the old grid's height.
const M = { top: 590 };
const P = { left: 380, w: 1000 }; // the branching tree, left of centre so the arrows up to the meters stay short

export const Ep8Vex: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const gridOut = 1 - ramp(frame, T.buckets[0], T.buckets[1]);
  const morph = interpolate(frame, [T.morph[0], T.morph[1]], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const cur = PMF.independent.map((p, v) => lerp(p, PMF.vex[v], morph));
  const K = (0.92 * (TB.base - TB.top)) / Math.max(...PMF.independent, ...PMF.vex);

  return (
    <Stage part="Part 8: Vex: Conditional Odds" captions={CAPTIONS}>
      <Cards appear={() => sp(T.cards)} lit={(i) => (i === 0 || i === 1) && frame < T.meters} meters={TURN.advantage.map((m) => m * ramp(frame, T.meters, T.meters + 40))} meterOpacity={sp(T.meters)} />

      {/* ---------- the branches (the A x B grid was removed: the tree says the same thing more plainly) ---------- */}
      {gridOut > 0 && (
        <div style={{ opacity: gridOut * sp(T.grid) }}>
          {/* ---------- the branches: a % on every line, and where advantage comes from ---------- */}
          {(() => {
            const X = { root: P.left + 30, a: P.left + 250, b: P.left + 520, leaf: P.left + 540 };
            const Y = { root: M.top + 195, aHit: M.top + 85, aMiss: M.top + 305 };
            const leaves = [
              { from: Y.aHit, y: Y.aHit - 55, p: land * ADV_LAND, adv: true, edge: ADV_LAND, hit: true },
              { from: Y.aHit, y: Y.aHit + 55, p: land * (1 - ADV_LAND), adv: false, edge: 1 - ADV_LAND, hit: false },
              { from: Y.aMiss, y: Y.aMiss - 55, p: odds.miss * land, adv: true, edge: land, hit: true },
              { from: Y.aMiss, y: Y.aMiss + 55, p: odds.miss ** 2, adv: false, edge: odds.miss, hit: false },
            ];
            const oA = sp(T.grid), oB = sp(T.breakAt[0]), oC = sp(T.formula);
            const edge = (x1: number, y1: number, x2: number, y2: number, color: string, label: string, o: number, glow = false) => (
              <g opacity={o}>
                {glow && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={VEX} strokeWidth={12} strokeLinecap="round" opacity={0.25} />}
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={3} strokeLinecap="round" />
                {/* labels sit above rising lines and below falling ones, never on them */}
                <text x={(x1 + x2) / 2 - 8} y={(y1 + y2) / 2 + (y2 < y1 ? -14 : 32)} textAnchor="end" fontFamily={F.mono} fontSize={24} fontWeight={700} fill={color}>{label}</text>
              </g>
            );
            return (
              <>
                <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
                  {edge(X.root, Y.root, X.a, Y.aHit, C.hit, `hits ${pct(land, 0)}`, oA, frame >= T.meters)}
                  {edge(X.root, Y.root, X.a, Y.aMiss, C.miss, `misses ${pct(odds.miss, 0)}`, oA)}
                  {leaves.map((l, i) => edge(X.a, l.from, X.b, l.y, l.hit ? C.hit : C.miss, pct(l.edge, l.from === Y.aHit ? 2 : 0), oB, l.from === Y.aHit))}
                  <circle cx={X.root} cy={Y.root} r={8} fill={C.fg} opacity={oA} />
                  {[Y.aHit, Y.aMiss].map((y) => <circle key={y} cx={X.a} cy={y} r={7} fill={C.fg} opacity={oA} />)}
                  {leaves.map((l, i) => <circle key={i} cx={X.b} cy={l.y} r={7} fill={l.adv ? VEX : C.miss} opacity={oB} />)}
                  {/* C has advantage on two branches: a bracket joins them, their sum rides an arrow up to C's meter */}
                  {(() => {
                    const o = sp(T.formula + 30), draw = ramp(frame, T.formula + 30, T.formula + 60);
                    const bx = X.leaf + 360, yA = leaves[0].y, yB = leaves[2].y;
                    const x1 = cardX(2) + CARD.w / 2 + 70, y1 = CARD.top + CARD.h + 70;
                    const len = Math.hypot(x1 - bx, y1 - yA) * 1.3;
                    return (
                      <g opacity={o}>
                        <path d={`M ${bx - 22} ${yA} H ${bx} V ${yB} H ${bx - 22}`} fill="none" stroke={VEX} strokeWidth={3} strokeLinejoin="round" />
                        <path d={`M ${bx} ${yA} C ${bx} ${yA - 90}, ${x1 + 60} ${y1 + 50}, ${x1} ${y1}`} fill="none" stroke={VEX} strokeWidth={3} strokeDasharray={len} strokeDashoffset={len * (1 - draw)} markerEnd="url(#vexArrow)" />
                      </g>
                    );
                  })()}
                  {/* A hits 65% -> Vex -> B has advantage 65% of the time: an arrow from the branch up to B's meter */}
                  {(() => {
                    const o = sp(T.meters);
                    const x0 = X.a, y0 = Y.aHit - 14, x1 = cardX(1) + CARD.w / 2 + 40, y1 = CARD.top + CARD.h + 70;
                    // the last control point sits straight below the tip, so the arrowhead points up into the meter
                    const len = Math.hypot(x1 - x0, y1 - y0) * 1.2;
                    return (
                      <g opacity={o}>
                        <defs><marker id="vexArrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={VEX} /></marker></defs>
                        <circle cx={X.a} cy={Y.aHit} r={13} fill="none" stroke={VEX} strokeWidth={3} />
                        <path d={`M ${x0} ${y0} C ${x0} ${y0 - 70}, ${x1} ${y1 + 60}, ${x1} ${y1}`} fill="none" stroke={VEX} strokeWidth={3} strokeDasharray={len} strokeDashoffset={len * (1 - ramp(frame, T.meters, T.meters + 24))} markerEnd="url(#vexArrow)" />
                      </g>
                    );
                  })()}
                </svg>
                <Text x={(X.root + X.a) / 2} y={M.top - 46} w={300} size={26} weight={700} color={C.muted} opacity={oA}>Shortsword 1</Text>
                <Text x={(X.a + X.b) / 2} y={M.top - 46} w={300} size={26} weight={700} color={C.muted} opacity={oB}>Shortsword 2</Text>
                <Text x={X.leaf + 120} y={M.top - 46} w={300} size={26} weight={700} color={C.muted} opacity={oC}>Scimitar</Text>
                <Text x={X.leaf + 512} y={(leaves[0].y + leaves[2].y) / 2 - 34} w={260} align="right" size={26} mono weight={700} color={VEX} opacity={sp(T.formula + 40)}>
                  <div>{pct(leaves[0].p, 2)}</div>
                  <div style={{ borderBottom: `3px solid ${VEX}`, paddingBottom: 4, marginBottom: 6, marginLeft: "auto", width: "fit-content" }}>{`+ ${pct(leaves[2].p, 2)}`}</div>
                  <div>{pct(TURN.advantage[2], 2)}</div>
                </Text>
                {leaves.map((l, i) => (
                  <Text key={i} x={X.leaf} y={l.y - 16} w={420} align="left" size={26} mono weight={700} color={l.adv ? VEX : C.muted} opacity={oC}>
                    {`${pct(l.p, 2)}`}<span style={{ fontWeight: 400, fontSize: 22 }}>{l.adv ? "  scimitar has advantage" : "  no advantage"}</span>
                  </Text>
                ))}
              </>
            );
          })()}
        </div>
      )}

      {/* ---------- the turn's buckets slide right ---------- */}
      {frame >= T.buckets[0] && (
        <TurnBuckets
          opacity={ramp(frame, T.buckets[0], T.buckets[1])}
          layers={[{ arr: cur.map((p, v) => Math.min(p, PMF.independent[v])), color: C.accent }, { arr: cur.map((p, v) => Math.max(0, p - PMF.independent[v])), color: VEX }]}
          K={K}
          mean={lerp(TURN.independent, TURN.vex, morph)}
        />
      )}
    </Stage>
  );
};
