import React from "react";
import { Easing, useCurrentFrame } from "remotion";
import { ATTACKS, BUILD, BUILD_MEANS, SINGLES, SPLITS, TURN } from "../advancedData";
import { C, F, Fulcrum, Text, Stage, clamp01, lerp, pct, ramp, useSp, type Caption } from "../kit";
import { CARD, CARD_BOTTOM, Cards, TB, TP, cardX, f2, tx } from "./monkShared";

// Part 7: how independent attacks combine, on one chart that never resets. Each attack's own damage chart slides in from
// the side. Then every bucket of the turn so far "rolls" it: the bucket lifts off and breaks into a copy of that chart,
// shrunk to the bucket's chance and shifted to the bucket's damage, and the pieces settle back onto the same chart.
// The settled pieces add up to exactly BUILD[k] (the convolution), which advancedData asserts against the engine.

const POOL = { base: 860, h: 330 };
const MINI = { left: TB.left, base: 520, h: 90 }; // the attack on its own, top left, on the same damage axis as the chart below
const FLY = 28;
const NAME = ["the first shortsword", "the second shortsword", "the scimitar", "the first Unarmed Strike", "the second Unarmed Strike"];

const source = (k: number) => (k === 0 ? [1] : BUILD[k - 1]);
// Damage provenance, drawn as mass: every bar is split by how much of its damage each attack dealt. A turn at 13 made of
// 8 from A and 5 from B is 8/13 A and 5/13 B. When a bucket at v rolls a piece worth d more damage, the piece keeps the old
// attacks' split for its first v and adds the new attack for its last d. Layer 0 is "no damage yet" (only ever at 0).
export const ATTACK_COLORS = ["#7aa7e0", "#a58bdb", "#5fc4b4", "#e48aa8", "#e6b65c"];
const LAYER_COLORS = ["#c8d0de", ...ATTACK_COLORS];
const NL = LAYER_COLORS.length;
// px per unit chance for step k: the taller of the before and after charts fills 80%, leaving headroom for a bucket that
// briefly holds both landed pieces and its own not-yet-rolled bar
const Kstep = (k: number) => (0.8 * POOL.h) / Math.max(...BUILD[k], ...(k === 0 ? [] : source(k)));

type Piece = { w: number; d: number; amt: number; below: number; layer: number }; // lands at w = v + d; `below` = offset inside its lifted bar
type Roll = { v: number; p: number; start: number; slow: boolean; pieces: Piece[] };
type Step = { start: number; rolls: Roll[]; done: number; lastRoll: number; before: number[][]; after: number[][] }; // [layer][bucket]

// slow rolls get their own beat, then the rest go left to right
const PLAN: { slow: number[]; stagger: number }[] = [
  { slow: [0], stagger: 0 },
  { slow: [0, 8], stagger: 3 },
  { slow: [], stagger: 1.6 },
  { slow: [], stagger: 1.1 },
  { slow: [], stagger: 0.85 },
];
const STEPS: Step[] = [];
{
  let start = 175;
  let layers: number[][] = Array.from({ length: NL }, (_, j) => (j === 0 ? [1] : []));
  PLAN.forEach((plan, k) => {
    const src = source(k);
    const next: number[][] = Array.from({ length: NL }, () => []);
    const vs = src.map((p, v) => (p > 0 ? v : -1)).filter((v) => v >= 0);
    const order = [...plan.slow, ...vs.filter((v) => !plan.slow.includes(v))];
    const landed: number[] = [];
    // the first roll waits for the attack's chart to slide in, and for the previous attack's last pieces to land
    let t = k === 0 ? start + 40 : STEPS[k - 1].done + 12;
    const rolls = order.map((v) => {
      const slow = plan.slow.includes(v);
      const at = t;
      t += slow ? 55 : plan.stagger;
      let inside = 0;
      const pieces = SINGLES[k].flatMap((q, d) => {
        if (q === 0) return [];
        // the piece's damage is v already dealt (split as the bucket was) plus d from this attack
        const total = v + d, amt0 = src[v] * q;
        const parts = total === 0
          ? [{ layer: 0, amt: amt0 }]
          : [
              ...layers.map((L, j) => ({ layer: j, amt: j === 0 ? 0 : (((L[v] ?? 0) / src[v]) * amt0 * v) / total })),
              { layer: k + 1, amt: (amt0 * d) / total },
            ].filter((x) => x.amt > 0);
        return parts.map(({ layer, amt }) => {
          const piece = { w: v + d, d, amt, below: inside, layer };
          inside += amt;
          landed[v + d] = (landed[v + d] ?? 0) + amt;
          next[layer][v + d] = (next[layer][v + d] ?? 0) + amt;
          return piece;
        });
      });
      return { v, p: src[v], start: at, slow, pieces };
    });
    BUILD[k].forEach((p, v) => { if (Math.abs((landed[v] ?? 0) - p) > 1e-12) throw new Error(`Part 7 pieces != BUILD[${k}] at ${v}`); });
    const lastRoll = Math.max(...rolls.map((r) => r.start));
    const done = Math.round(lastRoll + FLY + 8);
    // provenance check: within each bucket, attack a's share times the bucket's damage, summed, is a's average damage
    for (let a = 0; a <= k; a++) {
      const dealt = next[a + 1].reduce((acc, m, w) => acc + (m ?? 0) * w, 0);
      if (Math.abs(dealt - ATTACKS[a].single) > 1e-9) throw new Error(`Part 7 provenance: attack ${a} deals ${dealt}, not ${ATTACKS[a].single}`);
    }
    STEPS.push({ start, rolls, done, lastRoll, before: layers, after: next });
    layers = next;
    start = Math.round(lastRoll + 4); // the next attack slides in as soon as this one's last pieces have left its chart
  });
}
const FINAL = STEPS[4].done + 30;
export const EP7_DURATION = FINAL + 150;
const T = { cards: 0, brackets: 50 } as const;
const R1 = STEPS[1].rolls;

// captions change when each attack starts rolling (its chart slides in a little earlier, while the last one lands)
const S = (i: number) => STEPS[i].rolls[0].start - 20;
export const CAPTIONS: Caption[] = [
  { from: 0, to: 70, text: "Five attacks, one chart. Each new attack rolls every bucket again." },
  { from: 70, to: 175, text: "For now, leave out weapon masteries, so each attack rolls on its own." },
  { from: 175, to: S(1), text: "The first shortsword slides in. On its own, its chart is the whole turn so far." },
  { from: S(1), to: R1[1].start - 4, text: `Now every turn so far rolls the second shortsword. The 0 bucket (${pct(R1[0].p, 0)}) breaks into a ${pct(R1[0].p, 0)}-sized copy of its chart.` },
  { from: R1[1].start - 4, to: R1[2].start, text: `The 8 bucket (${pct(R1[1].p, 1)}) breaks into a ${pct(R1[1].p, 1)}-sized copy, shifted to start at 8.` },
  { from: R1[2].start, to: S(2), text: "Every bucket does the same: a copy shrunk to its size, shifted to its damage. That's convolution, one bucket at a time." },
  { from: S(2), to: S(3), text: "The scimitar slides in, and every bucket rolls again." },
  { from: S(3), to: FINAL, text: "Then both Unarmed Strikes: five attacks, four convolutions. That is how dice add up." },
  { from: FINAL, to: EP7_DURATION + 1, text: "Independent attacks just add their averages." },
];

const ease = Easing.inOut(Easing.cubic);
const span = (arr: number[]) => { const vs = arr.map((p, v) => (p > 0 ? v : -1)).filter((v) => v >= 0); return [vs[0], vs[vs.length - 1]]; };
const CEIL = POOL.base - POOL.h - 20; // a pool bar never pokes up into the legend
const Bar: React.FC<{ x: number; bottom: number; h: number; color: string; opacity?: number; glow?: boolean; waiting?: boolean; ceil?: number }> = ({ x, bottom, h, color, opacity = 1, glow, waiting, ceil = CEIL }) =>
  h > 0.3 ? (
    <div style={{ position: "absolute", left: x, top: Math.max(ceil, bottom - h), width: TP - 2, height: Math.max(0, Math.min(h, bottom - ceil)), boxSizing: "border-box", borderRadius: 2, opacity, boxShadow: glow ? `0 0 14px ${color}aa` : undefined,
      ...(waiting ? { background: `${color}22`, border: `1.5px dashed ${color}` } : { background: `${color}88`, borderTop: `2px solid ${color}` }) }} />
  ) : null;

export const Ep7Five: React.FC = () => {
  const frame = useCurrentFrame();
  const sp = useSp();
  // the attack charts overlap: the next one slides in while the last one's pieces are still landing, so the chart below
  // switches to the new attack only shortly before its first bucket rolls
  const kMini = STEPS.reduce((acc, s, i) => (frame >= s.start ? i : acc), -1);
  const poolStart = (i: number) => STEPS[i].rolls[0].start - 12; // never before the previous attack is done
  const k = STEPS.reduce((acc, _, i) => (frame >= poolStart(i) ? i : acc), -1);
  const step = k >= 0 ? STEPS[k] : null;
  const final = frame >= FINAL;
  // the chart zooms in as it spreads out (its tallest bar keeps shrinking). The zoom happens while the next attack slides
  // in, and a labelled chance line moves with it, so it reads as a zoom rather than bars growing
  const zoom = kMini <= 0 ? 1 : ease(ramp(frame, STEPS[kMini].start, STEPS[kMini].start + 30));
  const K = kMini <= 0 ? Kstep(0) : lerp(Kstep(kMini - 1), Kstep(kMini), zoom);
  const NICE = [1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01];
  const gridFor = (i: number) => NICE.find((g) => g <= Math.max(...(i <= 0 ? BUILD[0] : source(i))) * 0.75) ?? 0.01;
  const dimIn = step ? ease(ramp(frame, poolStart(k), poolStart(k) + 14)) : 0;

  // per bin: what has landed this step (at the bottom, by layer) and what has not rolled yet (on top)
  const src = source(Math.max(0, k));
  const landedL: number[][] = Array.from({ length: NL }, () => []);
  const landed: number[] = [];
  const flying: React.ReactNode[] = [];
  const lifted = new Set<number>();
  let flyMean = 0; // rolled pieces count at their destination, so the balance point is the live DPR of the turn so far
  // Mass moves smoothly: a rolling bucket's share that misses never leaves its bar; the rest peels away over the first part of
  // the flight, and each piece pours into its band over the last part, so no bar ever jumps in height.
  const PEEL = 0.3, POUR = 0.3;
  const rollAt = new Map<number, number>(); // bucket -> how far its peel has gone (0..1), for buckets that have started rolling
  const moving: { r: Roll; pc: Piece; f: number; peel: number; pour: number }[] = [];
  step?.rolls.forEach((r) => {
    if (frame < r.start) return;
    lifted.add(r.v);
    const f = ease(clamp01((frame - r.start) / FLY));
    const peel = clamp01(f / PEEL), pour = clamp01((f - (1 - POUR)) / POUR);
    rollAt.set(r.v, f >= 1 ? 2 : peel);
    r.pieces.forEach((pc) => {
      const stays = k > 0 && pc.d === 0 && pc.layer !== k + 1; // a miss: this share never moves (the first attack has nothing to stay)
      const settled = f >= 1 ? pc.amt : stays ? 0 : pc.amt * pour;
      if (settled > 0) { landed[pc.w] = (landed[pc.w] ?? 0) + settled; landedL[pc.layer][pc.w] = (landedL[pc.layer][pc.w] ?? 0) + settled; }
      flyMean += pc.amt * pc.w; // every rolled piece counts at its destination
      if (f >= 1) return;
      if (!stays) moving.push({ r, pc, f, peel, pour });
    });
  });
  // what is still sitting in a bucket from before this attack: all of it until the bucket rolls; then just its miss share,
  // plus whatever has not peeled off yet; nothing once its pieces have all settled
  const q0 = k >= 0 ? SINGLES[k][0] ?? 0 : 0;
  const waiting = (j: number, v: number) => {
    if (!step || k === 0) return 0; // the chart starts empty: the first attack's chart is the starting data
    const base = step.before[j][v] ?? 0;
    const at = rollAt.get(v);
    if (at === undefined) return base;
    if (at > 1) return 0;
    return base * (q0 + (1 - q0) * (1 - at));
  };
  // every bar is one stack in a fixed colour order (oldest attack at the bottom)
  const band = (j: number, v: number) => (landedL[j][v] ?? 0) + waiting(j, v);
  const bandTop = (j: number, v: number) => { let t = 0; for (let i = 0; i <= j; i++) t += band(i, v); return t; };
  // pieces in flight: old damage peels off the top of its colour band at the bucket and slides over; new damage drops out of
  // the attack's own chart (its d column). Each pours into the top of its own colour's band at v + d.
  moving.forEach(({ r, pc, f, peel, pour }) => {
    if (pc.w > 70) return;
    const hot = r.slow && frame < r.start + FLY + 24;
    const fromAttack = pc.layer === k + 1 || k === 0;
    const x = lerp(fromAttack ? MINI.left + pc.d * TP : tx(r.v), tx(pc.w), f);
    const y0 = fromAttack ? MINI.base : POOL.base - bandTop(pc.layer, r.v) * K;
    const y1 = POOL.base - bandTop(pc.layer, pc.w) * K;
    const lift = fromAttack ? Math.sin(Math.PI * f) * (r.slow ? 70 : 40) : 0;
    // a slow roll's new damage leaves the attack's chart at full size and shrinks to the bucket's share on the way down
    const hEnd = pc.amt * K;
    const hStart = r.slow && fromAttack ? (SINGLES[k][pc.d] * MINI.h * (k === 0 ? 1 : pc.d / pc.w)) / Math.max(...SINGLES[k]) : hEnd;
    const h = lerp(hStart, hEnd, f) * (fromAttack ? 1 : peel) * (1 - pour);
    flying.push(<Bar key={`${r.v}-${pc.w}-${pc.layer}`} x={x} bottom={lerp(y0, y1, f) - lift} h={h} color={LAYER_COLORS[pc.layer]} glow={hot} ceil={0} />);
  });
  const settledTo = step && frame >= step.done ? step.after : null;
  /** One bucket drawn as stacked layers (fixed order), from `bottom` up. */
  const stack = (v: number, amount: (j: number) => number, bottom: number, opts: { waiting?: boolean; glow?: boolean } = {}) => {
    let y = bottom;
    return LAYER_COLORS.map((_, j) => {
      const h = amount(j) * K;
      const el = <Bar key={`${v}-${j}-${opts.waiting ? "w" : "l"}`} x={tx(v)} bottom={y} h={h} color={LAYER_COLORS[j]} waiting={opts.waiting} glow={opts.glow} />;
      y -= h;
      return el;
    });
  };

  return (
    <Stage part="Part 7: Multiple Attacks in a Turn" captions={CAPTIONS}>
      <Cards appear={(i) => sp(T.cards + i * 6)} lit={(i) => i === kMini && !final} brackets={sp(T.brackets)} tags={[]} ids={false} stripe={(i) => (frame >= STEPS[i].start ? ATTACK_COLORS[i] : undefined)} />

      {/* ---------- the attack on its own: slides in from the right, leaves once its rolls are done ---------- */}
      {!final && STEPS.map((st, k) => {
        // slides in from the left; when the next attack slides in, it drops down toward the chart and fades
        const leave = STEPS[k + 1]?.start ?? st.done;
        if (frame < st.start || frame > leave + 30) return null;
        const inn = ease(ramp(frame, st.start, st.start + 30));
        const out = ease(ramp(frame, leave, leave + 30));
        const a = ATTACKS[k], s = SPLITS[k];
        const km = MINI.h / Math.max(...SINGLES[k]);
        return (
          <div key={k} style={{ position: "absolute", inset: 0, transform: `translate(${-(1 - inn) * 520}px, ${out * 140}px)`, opacity: inn * (1 - out) }}>
            <Text x={MINI.left} y={MINI.base - MINI.h - 44} w={600} align="left" size={24} color={C.fg} opacity={1 - clamp01(out * 4)}>{`${a.name} alone: ${a.dmg}`}</Text>
            <div style={{ position: "absolute", left: MINI.left - 6, top: MINI.base + 2, width: 21 * TP + 6, height: 2, background: C.border }} />
            {SINGLES[k].map((_, d) => {
              const m = (s.miss[d] ?? 0) * km, h = (s.hit[d] ?? 0) * km, c = (s.crit[d] ?? 0) * km;
              return (
                <React.Fragment key={d}>
                  <Bar x={MINI.left + d * TP} bottom={MINI.base} h={m} color={C.miss} ceil={0} />
                  <Bar x={MINI.left + d * TP} bottom={MINI.base - m} h={h + c} color={ATTACK_COLORS[k]} ceil={0} />
                </React.Fragment>
              );
            })}
            {[0, 10, 20].map((d) => <Text key={d} x={MINI.left + d * TP + TP / 2} y={MINI.base + 6} w={60} size={20} mono color={C.muted}>{d}</Text>)}
          </div>
        );
      })}

      {/* ---------- the turn so far: one chart, rolled in place ---------- */}
      <div style={{ opacity: sp(150) }}>
        <div style={{ position: "absolute", left: tx(0) - 8, top: POOL.base + 2, width: TB.right - TB.left + 16, height: 3, background: C.border }} />
        {[0, 10, 20, 30, 40, 50, 60, 70].map((v) => <Text key={v} x={tx(v) + TP / 2} y={POOL.base + 12} w={60} size={26} mono weight={600}>{v}</Text>)}
        <Text x={TB.right + 8} y={POOL.base + 48} w={300} align="right" size={26} color={C.muted}>turn damage</Text>
        {step && !final && !settledTo && (
          <div style={{ position: "absolute", right: 1920 - TB.right, top: POOL.base - POOL.h - 70, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, fontSize: 24, color: C.muted, opacity: dimIn }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 18, height: 18, borderRadius: 3, background: `${ATTACK_COLORS[k]}88`, borderTop: `2px solid ${ATTACK_COLORS[k]}` }} />{"color: which attack dealt that damage"}</span>
          </div>
        )}
      </div>

      {/* chance gridline: it slides with the zoom, and swaps to a finer value once the zoom is done */}
      {(() => {
        const g0 = gridFor(kMini - 1), g1 = gridFor(kMini), sw = kMini <= 0 ? 1 : ramp(frame, STEPS[kMini].start + 4, STEPS[kMini].start + 18);
        const lines = g0 === g1 ? [{ g: g1, o: 1 }] : [{ g: g0, o: 1 - sw }, { g: g1, o: sw }];
        // a line fades as it nears the top of the chart, so a zoom never pushes it into the cards
        return lines.map(({ g, o }) => ({ g, o: o * clamp01((POOL.base - g * K - CEIL) / 40) })).map(({ g, o }) => (o > 0.01 ? (
          <div key={g} style={{ position: "absolute", left: tx(0) - 70, top: POOL.base - g * K - 14, width: TB.right - TB.left + 70, opacity: o * sp(160), display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 56, textAlign: "right", fontFamily: F.mono, fontSize: 22, color: C.muted }}>{pct(g, 0)}</span>
            <span style={{ flex: 1, borderTop: `2px dotted ${C.border}` }} />
          </div>
        ) : null));
      })()}

      {step && (settledTo
        ? BUILD[k].map((_, v) => (v <= 70 ? <React.Fragment key={v}>{stack(v, (j) => settledTo[j][v] ?? 0, POOL.base)}</React.Fragment> : null))
        : Array.from({ length: 71 }, (_, v) => {
            const slowNext = !!step.rolls.find((r) => r.v === v && r.slow && frame >= r.start - 14);
            return (
              <React.Fragment key={v}>
                {stack(v, (j) => band(j, v), POOL.base, { glow: slowNext && !lifted.has(v) })}
              </React.Fragment>
            );
          }))}
      {flying}


      {/* during a slow roll, spell out where its pieces go */}
      {k > 0 && step?.rolls.filter((r) => r.slow && frame >= r.start - 10 && frame < r.start + FLY + 40).map((r) => {
        const o = ramp(frame, r.start - 10, r.start) * (1 - ramp(frame, r.start + FLY + 26, r.start + FLY + 40));
        const [h0, h1] = span(SPLITS[k].hit), [c0, c1] = span(SPLITS[k].crit);
        const line = (label: string, a: number, b: number) => (r.v === 0 ? `${label}: ${a} to ${b}` : `${label}: ${r.v} + (${a} to ${b}) = ${r.v + a} to ${r.v + b}`);
        return (
          <div key={r.v} style={{ position: "absolute", left: tx(30), top: POOL.base - POOL.h + 30, opacity: o, fontFamily: "inherit", fontSize: 28, lineHeight: 1.5, padding: "12px 20px", borderRadius: 12, background: `${C.elevated}e6`, border: `1.5px solid ${C.borderStrong}` }}>
            <div style={{ fontWeight: 700 }}>{`The ${r.v} bucket rolls ${NAME[k]}`}</div>
            <div style={{ color: C.muted }}>{`Miss (${pct(SPLITS[k].miss.reduce((a, b) => a + b, 0), 0)}): stays at ${r.v}`}</div>
            <div style={{ color: ATTACK_COLORS[k] }}>{`${line("Hit", h0, h1)}`}</div>
            <div style={{ color: ATTACK_COLORS[k] }}>{`${line("Crit", c0, c1)}`}</div>
          </div>
        );
      })}

      {/* the balance point, live: it creeps right as each bucket rolls */}
      {step && (() => {
        const mean = settledTo
          ? BUILD_MEANS[k]
          : flyMean + src.reduce((a, p, v) => a + (lifted.has(v) ? 0 : p * v), 0);
        return <Fulcrum x={tx(0) + TP / 2 + mean * TP} y={POOL.base + 70} label={`${f2(mean)} DPR`} opacity={sp(STEPS[0].rolls[0].start)} />;
      })()}

      {/* each attack's average under its card, added up, then the total on its own line */}
      {final && (
        <>
          {ATTACKS.map((a, i) => (
            <React.Fragment key={a.id}>
              <Text x={cardX(i) + CARD.w / 2} y={CARD_BOTTOM + 14} w={200} size={36} mono weight={700} color={ATTACK_COLORS[i]} opacity={sp(FINAL + i * 6)}>{f2(a.single)}</Text>
              {i > 0 && <Text x={cardX(i) - CARD.gap / 2} y={CARD_BOTTOM + 14} w={60} size={36} mono weight={700} color={C.muted} opacity={sp(FINAL + i * 6)}>+</Text>}
            </React.Fragment>
          ))}
          <Text x={cardX(4) + CARD.w} y={CARD_BOTTOM + 104} w={600} align="right" size={52} mono weight={700} color={C.hot} opacity={sp(FINAL + 36)}><span style={{ color: C.muted }}>=</span> {`${f2(TURN.independent)} DPR`}</Text>
        </>
      )}
    </Stage>
  );
};
