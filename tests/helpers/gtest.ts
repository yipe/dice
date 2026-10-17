import type { PMF } from "../../src/pmf/pmf";

function lgamma(z: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.001208650973866179, -0.000005395239384953,
  ];
  const x = z;
  let y = z;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

/** Regularized upper incomplete gamma Q(a, x) (series/continued fraction, Numerical Recipes), as the bake-off harness used. */
export function gammaQ(a: number, x: number): number {
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 500; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** G-test of `observed` counts against `expected` (a PMF), pooling expected counts under 5 into the next bin. */
export function gTest(
  observed: ReadonlyMap<number, number>,
  expected: PMF,
  n: number
): { g: number; df: number; p: number } {
  const values = [...new Set([...expected.map.keys(), ...observed.keys()])].sort((a, b) => a - b);
  const bins: { o: number; e: number }[] = [];
  let acc = { o: 0, e: 0 };
  for (const v of values) {
    acc.o += observed.get(v) ?? 0;
    acc.e += (expected.map.get(v)?.p ?? 0) * n;
    if (acc.e >= 5) {
      bins.push(acc);
      acc = { o: 0, e: 0 };
    }
  }
  if (acc.e > 0 || acc.o > 0) {
    const last = bins[bins.length - 1];
    if (last) {
      last.o += acc.o;
      last.e += acc.e;
    } else bins.push(acc);
  }
  let g = 0;
  for (const { o, e } of bins) if (o > 0) g += 2 * o * Math.log(o / e);
  const df = Math.max(1, bins.length - 1);
  return { g, df, p: gammaQ(df / 2, g / 2) };
}
