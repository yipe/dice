// Emits the "Change the AC: each average traces its line" frame as a standalone SVG, styled like dprcalc's own
// DPR-by-AC chart (same line colours, dots, axes, fonts and per-theme colours), not the explainer's.
// Usage: npx tsx scripts/export-ac-chart.ts [dark|light|midnight] > out.svg   (default dark)
import { DIST_BY_AC, DPR_BY_AC, ROLL_TYPES, type RollType } from "../src/advancedData";
import { AC_RANGE, MAX_DMG } from "../src/attackData";

type ThemeName = "dark" | "light" | "midnight";
const theme: ThemeName = process.argv[2] === "light" || process.argv[2] === "midnight" ? process.argv[2] : "dark";

// dprcalc's theme tokens (packages/ui/src/theme/tokens.css): fg.default / fg.subtle / fg.muted / accent.subtle / surfaces.
const THEMES = {
  dark: { fg: "#edf2f7", subtle: "#a0aec0", muted: "#cbd5e0", split: "rgba(66, 153, 225, 0.15)", surface: "#1a202c", card: "#171923", border: "#2d3748", miss: "#8893a8", hit: "#6e9bc6", crit: "#ffc078" },
  light: { fg: "#1a202c", subtle: "#718096", muted: "#4a5568", split: "rgba(49, 130, 206, 0.1)", surface: "#fafbfc", card: "#ffffff", border: "#e2e8f0", miss: "#6f7a90", hit: "#3a6ea5", crit: "#d9861a" },
  midnight: { fg: "#d6deec", subtle: "#8fa0be", muted: "#a8b8d6", split: "rgba(110, 155, 198, 0.12)", surface: "#07101c", card: "#0c1525", border: "#2b3f62", miss: "#8893a8", hit: "#6e9bc6", crit: "#ffc078" },
};
const C = THEMES[theme];

// CHART_COLORS[...].border in packages/ui/src/theme/chartColors.ts, as the DPR-by-AC chart draws its lines.
const RT: Record<RollType, { label: string; color: string }> = {
  disadvantage: { label: "Disadvantage", color: "rgba(239, 154, 154, 0.75)" },
  normal: { label: "Normal", color: "rgba(189, 189, 189, 0.75)" },
  advantage: { label: "Advantage", color: "rgba(165, 214, 167, 0.75)" },
  elven: { label: "Advantage (3d20)", color: "rgba(183, 148, 244, 0.75)" },
};

// Chakra's body + mono stacks and the serif page headings use (single quotes: these sit inside XML attributes).
const SANS = `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace`;
const SERIF = `Georgia, 'Iowan Old Style', 'Palatino Linotype', Palatino, serif`;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const K = 1.6; // the live chart's px sizes (ticks 11, axis titles 14, line 2, dot 6) scaled up to this canvas
const TICK = 11 * K, TITLE = 14 * K;
const LC = { left: 294, right: 1344, base: 900, top: 560, max: 10 };
const SLOT = (LC.right - LC.left) / AC_RANGE.length;
const MP = { left: 150, w: 380, gap: 30, base: 420, h: 170, K: 170 / 0.13 };
const PITCH = (MP.w - 20) / (MAX_DMG + 1);
const mpLeft = (i: number) => MP.left + i * (MP.w + MP.gap);
const mpX = (i: number, v: number) => mpLeft(i) + 10 + v * PITCH;
// a category axis puts each AC in the middle of its slot
const lx = (ac: number) => LC.left + (ac - AC_RANGE[0] + 0.5) * SLOT;
const ly = (d: number) => lerp(LC.base, LC.top, d / LC.max);
const AC = 17; // the AC the frame is frozen at
const idx = AC - AC_RANGE[0];
const f = (n: number) => +n.toFixed(2);

const o: string[] = [];
const text = (x: number, y: number, s: string | number, size: number, fill: string, opts: { anchor?: string; font?: string; weight?: number; extra?: string } = {}) =>
  o.push(`<text x="${f(x)}" y="${f(y)}" text-anchor="${opts.anchor ?? "start"}" font-family="${opts.font ?? SANS}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${fill}" ${opts.extra ?? ""}>${s}</text>`);

const VB = { x: 110, y: 170, w: 1690, h: 840 };
o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB.x} ${VB.y} ${VB.w} ${VB.h}" role="img" aria-label="Average damage per round against target AC, for disadvantage, normal, advantage and 3d20 advantage. Each roll type's damage distribution feeds a point on its line.">`);
o.push(`<rect x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}" rx="24" fill="${C.surface}"/>`);

// distributions
ROLL_TYPES.forEach((rt, i) => {
  const bins = DIST_BY_AC[rt][idx], dpr = DPR_BY_AC[rt][idx], col = RT[rt].color;
  o.push(`<rect x="${mpLeft(i)}" y="${MP.base - MP.h - 70}" width="${MP.w}" height="${MP.h + 130}" rx="14" fill="${C.card}" stroke="${C.border}" stroke-width="2"/>`);
  text(mpLeft(i) + 16, MP.base - MP.h - 32, RT[rt].label, 25, col, { weight: 700, font: SERIF });
  text(mpLeft(i) + MP.w - 16, MP.base - MP.h - 32, `DPR ${dpr.toFixed(2)}`, 19, C.fg, { anchor: "end", font: MONO, weight: 700 });
  bins.forEach((b, v) => {
    const H = (p: number) => p * MP.K;
    const miss = Math.min(H(b.miss), MP.h), hit = Math.min(H(b.hit), MP.h - miss), crit = Math.min(H(b.crit), MP.h - miss - hit);
    const x = mpX(i, v), w = PITCH - 3;
    const bar = (y: number, h: number, c: string, a: number) =>
      h > 0.3 && o.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${c}" fill-opacity="${a}"/><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="2" fill="${c}"/>`);
    bar(MP.base - miss, miss, C.miss, 0.4);
    bar(MP.base - miss - hit, hit, C.hit, 0.4);
    bar(MP.base - miss - hit - crit, crit, C.crit, 0.53);
  });
  text(mpX(i, 0) + PITCH + 8, MP.base - MP.h + 14, `${(bins[0].miss * 100).toFixed(0)}% miss`, 18, C.muted, { font: MONO, weight: 600 });
  o.push(`<rect x="${mpLeft(i) + 10}" y="${MP.base}" width="${MP.w - 20}" height="2" fill="${C.border}"/>`);
  [0, 10, 20].forEach((v) => text(mpX(i, v) + PITCH / 2, MP.base + 22, v, 16, C.muted, { anchor: "middle", font: MONO }));
  // balance point
  const meanX = mpX(i, dpr) + PITCH / 2;
  o.push(`<rect x="${f(meanX - 1.5)}" y="${MP.base - MP.h + 34}" width="3" height="${MP.h - 34}" fill="${col}"/><polygon transform="translate(${f(meanX - 12)} ${MP.base + 28})" points="12,0 0,20 24,20" fill="${col}"/>`);
});

// chart: split lines at every y tick, category x axis with its between-slot ticks, as ECharts draws it
[0, 2, 4, 6, 8, 10].forEach((d) => {
  o.push(`<line x1="${LC.left}" x2="${LC.right}" y1="${f(ly(d))}" y2="${f(ly(d))}" stroke="${d === 0 ? C.subtle : C.split}" stroke-width="${d === 0 ? 1.5 : 1.6}"/>`);
  text(LC.left - 14, ly(d) + TICK / 3, d, TICK, C.fg, { anchor: "end" });
});
AC_RANGE.forEach((a, k) => {
  o.push(`<line x1="${f(LC.left + k * SLOT)}" x2="${f(LC.left + k * SLOT)}" y1="${LC.base}" y2="${LC.base + 8}" stroke="${C.subtle}" stroke-width="1.5"/>`);
  text(lx(a), LC.base + 12 + TICK, a, TICK, a === AC ? C.fg : C.fg, { anchor: "middle", weight: a === AC ? 700 : 400 });
});
o.push(`<line x1="${LC.right}" x2="${LC.right}" y1="${LC.base}" y2="${LC.base + 8}" stroke="${C.subtle}" stroke-width="1.5"/>`);
text((LC.left + LC.right) / 2, LC.base + 12 + TICK + 14 + TITLE, "Armor Class", TITLE, C.subtle, { anchor: "middle" });
const yTitleX = LC.left - 56, yTitleY = (LC.top + LC.base) / 2;
text(yTitleX, yTitleY, "Damage Per Round", TITLE, C.subtle, { anchor: "middle", extra: `transform="rotate(-90 ${yTitleX} ${yTitleY})"` });

// AC marker
o.push(`<line x1="${f(lx(AC))}" x2="${f(lx(AC))}" y1="${LC.top}" y2="${LC.base}" stroke="${C.subtle}" stroke-dasharray="5 6" stroke-width="1.5" opacity="0.8"/>`);

// lines (straight, 2px, a filled dot at every AC) + the feed from each distribution's balance point
ROLL_TYPES.forEach((rt, i) => {
  const col = RT[rt].color, dpr = DPR_BY_AC[rt][idx];
  const pts = AC_RANGE.map((a, k) => `${f(lx(a))},${f(ly(DPR_BY_AC[rt][k]))}`).join(" ");
  o.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${2 * K}" stroke-linejoin="round"/>`);
  AC_RANGE.forEach((a, k) => o.push(`<circle cx="${f(lx(a))}" cy="${f(ly(DPR_BY_AC[rt][k]))}" r="${3 * K}" fill="${col}"/>`));
  o.push(`<line x1="${f(mpX(i, dpr) + PITCH / 2)}" y1="${MP.base + 48}" x2="${f(lx(AC))}" y2="${f(ly(dpr))}" stroke="${col}" stroke-width="2" stroke-dasharray="4 6"/>`);
  o.push(`<circle cx="${f(lx(AC))}" cy="${f(ly(dpr))}" r="${3 * K + 5}" fill="none" stroke="${col}" stroke-width="2.5"/>`);
});
text(lx(AC), LC.top - 40, `AC ${AC}`, 28, C.fg, { anchor: "middle", font: MONO, weight: 700 });

// legend table: 310 wide, 40 clear of the chart
const LG = LC.right + 40;
text(LG, LC.top + 20, `DPR at AC ${AC}`, 24, C.subtle, { font: SERIF });
[...ROLL_TYPES].reverse().forEach((rt, i) => {
  const y = LC.top + 70 + i * 62;
  o.push(`<rect x="${LG}" y="${y - 10}" width="19" height="19" rx="3" fill="${RT[rt].color}"/>`);
  text(LG + 32, y + 9, RT[rt].label, 23, C.fg);
  text(LG + 310, y + 9, DPR_BY_AC[rt][idx].toFixed(2), 26, RT[rt].color, { anchor: "end", font: MONO, weight: 600 });
});
o.push("</svg>");
console.log(o.join("\n"));
