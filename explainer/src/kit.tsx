import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { midnight } from "./styles/midnight";
import { useShowChrome } from "./chrome";

export const S = midnight;
export const C = {
  fg: "#d6deec", muted: "#a8b8d6", subtle: "#8fa0be", border: "#2b3f62", borderStrong: "#3a5070",
  surface: "#07101c", elevated: "#0c1525", accent: "#6e9bc6", hot: "#ffc078",
  // outcome colours (midnight chart palette): miss = neutral, hit = accent blue, crit = warm
  miss: "#8893a8", hit: "#6e9bc6", crit: "#ffc078",
};
export const F = S.fonts;

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Percent with d decimals, rounding half up (6.125% reads 6.13% whatever the float noise). */
export const pct = (p: number, d = 1) => `${(Math.round(p * 100 * 10 ** d + 1e-6) / 10 ** d).toFixed(d)}%`;

/** Spring helper with the house (no-overshoot) feel. */
export const useSp = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (start: number, stiffness = S.spring.stiffness) => spring({ frame: frame - start, fps, config: { ...S.spring, stiffness } });
};
export const ramp = (frame: number, a: number, b: number) => clamp01((frame - a) / (b - a));

export type Caption = { from: number; to: number; text: React.ReactNode };

export const Stage: React.FC<{ part: string; captions: Caption[]; children: React.ReactNode }> = ({ part, captions, children }) => {
  const frame = useCurrentFrame();
  const chrome = useShowChrome();
  return (
    <AbsoluteFill style={{ fontFamily: F.body, color: C.fg, overflow: "hidden" }}>
      <S.Background />
      {children}
      {chrome && captions.map((c, i) => {
        const o = interpolate(frame, [c.from, c.from + 8, c.to - 8, c.to], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        if (o <= 0) return null;
        // a caption too long for one line shrinks so its two lines stay above the scene
        const long = typeof c.text === "string" && c.text.length > 72;
        return (
          <div key={i} style={{ position: "absolute", top: long ? 64 : 80, left: 110, right: 110, textAlign: "center", opacity: o, transform: `translateY(${(1 - o) * 12}px)`, fontFamily: F.display, ...S.captionStyle, fontSize: long ? 38 : 50, ...(long ? { lineHeight: 1.18, textWrap: "balance" } : {}) }}>
            {c.text}
          </div>
        );
      })}
      {chrome && <div style={{ position: "absolute", left: 150, bottom: 40, fontFamily: F.mono, fontSize: 22, color: C.muted, letterSpacing: 1 }}>@yipe/dice · {part}</div>}
    </AbsoluteFill>
  );
};

/** Balance-point marker: a triangle under the axis with a label. */
export const Fulcrum: React.FC<{ x: number; y: number; label: string; opacity: number; size?: number }> = ({ x, y, label, opacity, size = 28 }) => (
  <div style={{ position: "absolute", left: x - 140, top: y, width: 280, textAlign: "center", opacity }}>
    <svg width={280} height={40}><polygon points="140,2 118,38 162,38" fill={C.hot} /></svg>
    <div style={{ fontFamily: F.mono, fontSize: size, fontWeight: 700, color: C.hot }}>{label}</div>
  </div>
);

export const Text: React.FC<{ x: number; y: number; w?: number; align?: "left" | "center" | "right"; size?: number; color?: string; mono?: boolean; weight?: number; opacity?: number; children: React.ReactNode }> = ({ x, y, w = 400, align = "center", size = 24, color = C.fg, mono, weight = 400, opacity = 1, children }) => (
  <div style={{ position: "absolute", left: align === "center" ? x - w / 2 : align === "right" ? x - w : x, top: y, width: w, textAlign: align, fontSize: size, color, fontFamily: mono ? F.mono : F.body, fontWeight: weight, opacity, whiteSpace: "nowrap" }}>{children}</div>
);
