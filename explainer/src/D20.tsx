import React from "react";
import { C, F } from "./kit";

// A real icosahedron, rotated in 3D and projected to SVG. Faces are numbered like a real d20
// (opposite faces sum to 21). At rest (spin = 0) the face showing `value` points at the camera.
type V = [number, number, number];
const PHI = (1 + Math.sqrt(5)) / 2;
const SHAPES: Record<8 | 20, V[]> = {
  20: [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ],
  8: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
};

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => { const n = Math.hypot(...a); return a.map((c) => c / n) as V; };
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

type Face = { idx: [number, number, number]; n: V; num: number };
/** Faces are vertex triples that are pairwise adjacent; opposite faces are numbered k and sides + 1 - k, like a real die. */
const build = (sides: 8 | 20) => {
  const verts = SHAPES[sides].map((v) => norm(v));
  const edge = Math.min(...verts.slice(1).map((v) => dist(verts[0], v)));
  const faces: Face[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const ok = [dist(verts[i], verts[j]), dist(verts[j], verts[k]), dist(verts[i], verts[k])].every((d) => Math.abs(d - edge) < 1e-6);
    if (ok) faces.push({ idx: [i, j, k], n: norm([0, 1, 2].map((a) => verts[i][a] + verts[j][a] + verts[k][a]) as V), num: 0 });
  }
  let next = 1;
  for (const f of faces) {
    if (f.num) continue;
    const opp = faces.find((g) => !g.num && g !== f && dot(g.n, f.n) < -0.999)!;
    f.num = next; opp.num = sides + 1 - next; next++;
  }
  return { verts, faces };
};
const GEO = { 8: build(8), 20: build(20) };

type M = number[]; // 3x3 row-major
const mul = (a: M, b: M): M => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
const apply = (m: M, v: V): V => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const axisAngle = (ax: V, t: number): M => {
  const [x, y, z] = norm(ax), c = Math.cos(t), s = Math.sin(t), u = 1 - c;
  return [c + x * x * u, x * y * u - z * s, x * z * u + y * s, y * x * u + z * s, c + y * y * u, y * z * u - x * s, z * x * u - y * s, z * y * u + x * s, c + z * z * u];
};
const rx = (t: number) => axisAngle([1, 0, 0], t), ry = (t: number) => axisAngle([0, 1, 0], t), rz = (t: number) => axisAngle([0, 0, 1], t);

/** Rotation that turns face `value` toward the viewer (+z), with a vertex pointing up so it rests nicely. */
const restFor = (sides: 8 | 20, value: number): M => {
  const { verts: VERTS, faces: FACES } = GEO[sides];
  const f = FACES.find((g) => g.num === value)!;
  const toward: V = [0, 0, 1];
  const ax = cross(f.n, toward);
  const r1 = Math.hypot(...ax) < 1e-9 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : axisAngle(ax, Math.acos(dot(f.n, toward)));
  // spin about the view axis so the face's first vertex points straight up
  const v = apply(r1, VERTS[f.idx[0]]);
  return mul(rz(-Math.atan2(v[0], -v[1])), r1);
};

const LIGHT = norm([-0.45, -0.6, 0.8]);

type DieProps = { value: number; size: number; spin: [number, number, number]; highlight?: string };
export const D20: React.FC<DieProps> = (p) => <Poly sides={20} {...p} />;
export const D8: React.FC<DieProps> = (p) => <Poly sides={8} {...p} />;

const Poly: React.FC<DieProps & { sides: 8 | 20 }> = ({ sides, value, size, spin, highlight }) => {
  const { verts: VERTS, faces: FACES } = GEO[sides];
  const R = mul(mul(mul(rx(spin[0]), ry(spin[1])), rz(spin[2])), restFor(sides, value));
  const r = size * 0.5;
  const P = VERTS.map((v) => apply(R, v));
  const proj = (v: V) => { const s = 3.2 / (3.2 - v[2]); return [r + v[0] * r * 0.9 * s, r + v[1] * r * 0.9 * s] as const; };
  const stroke = highlight ?? C.accent;
  const faces = FACES.map((f) => ({ f, n: apply(R, f.n) })).filter(({ n }) => n[2] > 0).sort((a, b) => a.n[2] - b.n[2]);
  return (
    <svg width={size} height={size} style={{ overflow: "visible", filter: highlight ? `drop-shadow(0 0 ${size * 0.12}px ${highlight}99)` : undefined }}>
      {faces.map(({ f, n }) => {
        const pts = f.idx.map((i) => proj(P[i]));
        const lit = Math.max(0, dot(n, LIGHT));
        const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
        const front = n[2];
        return (
          <g key={f.num}>
            <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={C.elevated} stroke={stroke} strokeWidth={size * 0.012} strokeLinejoin="round" />
            <polygon points={pts.map((p) => p.join(",")).join(" ")} fill="#ffffff" opacity={0.03 + lit * 0.12} />
            {front > 0.35 && (
              <text x={cx} y={cy + size * 0.04 * front} textAnchor="middle" fontFamily={F.body} fontWeight={700} fontSize={size * (sides === 8 ? 0.2 : 0.13) * front} fill={f.num === value && front > 0.98 && highlight ? highlight : C.fg} opacity={Math.min(1, (front - 0.35) * 2.5)}>
                {f.num}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};
