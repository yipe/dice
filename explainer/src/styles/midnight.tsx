// "Midnight": DPRcalc midnight theme (tokens.css [data-theme='midnight']). Precise, calm, no overshoot.
import React from "react";
import { AbsoluteFill } from "remotion";
import { INTER, MONO } from "../fonts";
import { PIPS, type Style } from "../style";

const C = {
  canvas: "#06080f", surface: "#07101c", elevated: "#0c1525", fg: "#d6deec", muted: "#a8b8d6",
  border: "#2b3f62", borderStrong: "#3a5070", accent: "#6e9bc6", hot: "#ffc078",
};
// midnight chart palette, ordered as a cool -> warm -> cool ramp so 7 sits on the warmest hue
const RAMP = ["#4a6fa5", "#6e9bc6", "#06a6bd", "#87dda8", "#ffe889", "#ffc078", "#ffe889", "#87dda8", "#06a6bd", "#6e9bc6", "#4a6fa5"];

export const midnight: Style = {
  id: "midnight",
  fonts: { display: INTER, body: INTER, mono: MONO },
  colors: { fg: C.fg, muted: C.muted, accent: C.accent, highlight: C.hot, surface: C.surface, border: C.border },
  sumColor: (s) => RAMP[s - 2],
  spring: { damping: 200, stiffness: 110, mass: 1 },
  captionStyle: { fontSize: 46, fontWeight: 600, letterSpacing: -0.5, color: C.fg },
  Background: () => (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 40%, ${C.elevated} 0%, ${C.canvas} 70%)` }}>
      <AbsoluteFill style={{ backgroundImage: `radial-gradient(${C.border} 1.2px, transparent 1.2px)`, backgroundSize: "48px 48px", opacity: 0.35 }} />
    </AbsoluteFill>
  ),
  dieCore: "#0c1525",
  Die: ({ value, size, highlight, ghost }) => {
    const pad = size * 0.22, step = (size - 2 * pad) / 2, r = size * 0.085;
    return (
      <svg width={size} height={size} style={{ overflow: "visible", opacity: ghost ? 0.55 : 1, filter: highlight ? `drop-shadow(0 0 ${size * 0.15}px ${C.hot}aa)` : undefined }}>
        <rect x={1.5} y={1.5} width={size - 3} height={size - 3} rx={size * 0.18} fill={C.elevated} stroke={highlight ? C.hot : C.accent} strokeWidth={Math.max(1.5, size * 0.025)} />
        {PIPS[value].map(([cx, cy], i) => <circle key={i} cx={pad + cx * step} cy={pad + cy * step} r={r} fill={highlight ? C.hot : C.fg} />)}
      </svg>
    );
  },
  Cell: ({ sum, size, highlight }) => {
    const col = RAMP[sum - 2];
    return (
      <div style={{ width: size, height: size, borderRadius: 10, background: `${col}26`, border: `2px solid ${highlight ? C.hot : col}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontWeight: 600, fontSize: size * 0.4, color: highlight ? C.hot : C.fg, boxShadow: highlight ? `0 0 24px ${C.hot}88` : undefined }}>
        {sum}
      </div>
    );
  },
  Slot: ({ highlight, filled }) => (
    <div style={{ position: "absolute", inset: 0, borderRadius: 18, background: C.surface, border: `2px solid ${highlight ? C.hot : C.border}` }}>
      <div style={{ position: "absolute", left: 18, right: 18, bottom: 16, height: 6, borderRadius: 3, background: C.border }}>
        <div style={{ width: `${filled * 100}%`, height: "100%", borderRadius: 3, background: C.accent }} />
      </div>
    </div>
  ),
};
