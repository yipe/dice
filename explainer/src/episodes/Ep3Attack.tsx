import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AC, AT_AC, BONUS, DEX, PROF } from "../attackData";
import { D20 } from "../D20";
import { C, F, Stage, Text, lerp, pct, ramp, useSp, type Caption } from "../kit";

export const EP3_DURATION = 690;
const ROLL = 13;
const NEED = AC - BONUS; // 10

const T = { roll: [18, 78], eq: 84, verdict: 108, clear: 160, tiles: 175, need: 225, color: 270, fly: 380, labels: 480, outro: 575 } as const;

export const CAPTIONS: Caption[] = [
  { from: 0, to: 160, text: `Every attack starts with a d20. Our monk-rogue adds ${BONUS} (Dexterity +${DEX}, proficiency +${PROF}).` },
  { from: 160, to: 270, text: `To hit AC ${AC} with +${BONUS}, you need to roll ${NEED} or higher.` },
  { from: 270, to: 380, text: "A natural 20 always hits, and it is a critical hit. A natural 1 always misses." },
  { from: 380, to: 575, text: "So we can sort all 20 faces by what they do." },
  { from: 575, to: EP3_DURATION + 1, text: "One attack is a tiny PMF with three entries: miss, hit, crit." },
];

type Kind = "miss" | "hit" | "crit";
const NAT1 = "#4c5466";
const kindOf = (n: number): Kind => (n === 20 ? "crit" : n === 1 || n < NEED ? "miss" : "hit");
const FACES = Array.from({ length: 20 }, (_, i) => i + 1);

const TILE = { w: 70, gap: 10, y: 560 };
const tileX = (n: number) => (1920 - (20 * TILE.w + 19 * TILE.gap)) / 2 + (n - 1) * (TILE.w + TILE.gap);
const BIN = { w: 210, slab: 30, gap: 4, base: 950, x: { miss: 560, hit: 960, crit: 1360 } as Record<Kind, number> };

export const Ep3Attack: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  const t = interpolate(frame, [T.roll[0], T.roll[1]], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const spin: [number, number, number] = [9.5 * (1 - t), -7.3 * (1 - t), 3.1 * (1 - t)];
  const bounce = frame > T.roll[0] && frame < T.roll[1] ? -Math.abs(Math.sin((frame - T.roll[0]) / 5)) * 50 * (1 - t) : 0;
  const top = 1 - ramp(frame, T.clear, T.clear + 15);
  const dieIn = sp(T.roll[0] - 12);
  const colored = sp(T.color);
  const odds = AT_AC.odds;

  return (
    <Stage part="Part 3: One Attack, Three Outcomes" captions={CAPTIONS}>
      {/* ---------- the roll ---------- */}
      <div style={{ position: "absolute", left: 640 - 125, top: 330 - 125 + bounce, opacity: top, transform: `scale(${dieIn})` }}>
        <D20 value={ROLL} size={250} spin={spin} highlight={frame >= T.verdict ? C.hit : undefined} />
      </div>
      <div style={{ position: "absolute", left: 860, top: 260, opacity: top }}>
        <div style={{ fontFamily: F.display, fontSize: 76, fontWeight: 700, opacity: sp(T.eq), transform: `translateX(${(1 - sp(T.eq)) * 30}px)` }}>
          {ROLL} + {BONUS} = {ROLL + BONUS}
        </div>
        <div style={{ fontFamily: F.display, fontSize: 44, fontWeight: 600, marginTop: 14, color: C.hit, opacity: sp(T.verdict) }}>
          {ROLL + BONUS} ≥ AC {AC}: a hit
        </div>
      </div>

      {/* ---------- the 20 faces ---------- */}
      {frame >= T.tiles &&
        FACES.map((n, i) => {
          const kind = kindOf(n);
          const col = n === 1 ? NAT1 : C[kind]; // a natural 1 is a darker gray: it always misses
          const appear = sp(T.tiles + i * 2);
          const others = FACES.filter((m) => kindOf(m) === kind);
          const k = others.indexOf(n);
          const order = FACES.indexOf(n);
          const fly = sp(T.fly + order * 3);
          const x = lerp(tileX(n), BIN.x[kind] - BIN.w / 2, fly);
          const y = lerp(TILE.y, BIN.base - (k + 1) * (BIN.slab + BIN.gap), fly);
          const w = lerp(TILE.w, BIN.w, fly);
          const h = lerp(TILE.w, BIN.slab, fly);
          const below = n < NEED && frame >= T.need && frame < T.color + 10;
          const isRoll = n === ROLL && frame < T.fly;
          return (
            <div key={n} style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: lerp(10, 6, fly), transform: `scale(${appear})`,
              background: colored > 0 ? `${col}${Math.round(lerp(0x14, 0x40, colored)).toString(16)}` : "#ffffff08",
              border: `2px solid ${colored > 0 ? col : C.border}`, opacity: below ? 0.45 : 1,
              boxShadow: isRoll && frame > T.tiles + 40 ? `0 0 0 3px ${C.fg}` : undefined,
              display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.mono, fontWeight: 600, fontSize: lerp(28, 18, fly), color: colored > 0 ? col : C.fg }}>
              {n}
            </div>
          );
        })}
      {frame >= T.need && frame < T.fly + 20 && (
        <div style={{ opacity: sp(T.need) * (1 - ramp(frame, T.fly, T.fly + 15)) }}>
          <div style={{ position: "absolute", left: tileX(NEED) - TILE.gap / 2 - 1.5, top: TILE.y - 40, width: 3, height: TILE.w + 80, background: C.hot }} />
          <Text x={tileX(NEED) - TILE.gap / 2} y={TILE.y - 82} w={400} size={26} mono color={C.hot}>{`need ${NEED}+ (${NEED} + ${BONUS} = ${AC})`}</Text>
        </div>
      )}
      {frame >= T.color + 20 && frame < T.fly + 20 && (
        <div style={{ opacity: sp(T.color + 20) * (1 - ramp(frame, T.fly, T.fly + 15)) }}>
          <Text x={tileX(1)} y={TILE.y + TILE.w + 58} w={340} align="left" size={26} color={C.miss}>natural 1: always a miss</Text>
          <Text x={tileX(20) + TILE.w} y={TILE.y + TILE.w + 58} w={340} align="right" size={26} color={C.crit}>natural 20: critical hit</Text>
          <Text x={(tileX(NEED) + tileX(19) + TILE.w) / 2} y={TILE.y + TILE.w + 20} w={300} size={26} color={C.hit}>hit</Text>
          <Text x={(tileX(2) + tileX(NEED - 1) + TILE.w) / 2} y={TILE.y + TILE.w + 20} w={300} size={26} color={C.miss}>{`2 → ${NEED - 1}: miss`}</Text>
        </div>
      )}

      {/* ---------- bins ---------- */}
      {frame >= T.fly &&
        (["miss", "hit", "crit"] as Kind[]).map((kind, i) => {
          const n = FACES.filter((m) => kindOf(m) === kind).length;
          const a = sp(T.labels + i * 8);
          return (
            <React.Fragment key={kind}>
              <div style={{ position: "absolute", left: BIN.x[kind] - BIN.w / 2 - 20, top: BIN.base + 2, width: BIN.w + 40, height: 3, background: C.border, opacity: sp(T.fly) }} />
              <Text x={BIN.x[kind]} y={BIN.base + 16} w={300} size={32} weight={600} color={C[kind]} opacity={sp(T.fly)}>{kind}</Text>
              <div style={{ position: "absolute", left: BIN.x[kind] - 200, width: 400, top: BIN.base - n * (BIN.slab + BIN.gap) - 112, textAlign: "center", opacity: a, transform: `translateY(${(1 - a) * 12}px)` }}>
                <div style={{ fontFamily: F.mono, fontSize: 52, fontWeight: 600, color: C[kind] }}>{pct(odds[kind], 0)}</div>
                <div style={{ fontFamily: F.mono, fontSize: 26, color: C.muted, marginTop: 4 }}>{n} of 20 faces</div>
              </div>
            </React.Fragment>
          );
        })}
    </Stage>
  );
};
