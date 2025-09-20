import { EPS, PMF } from "../";

export function d20PmfFromCdf(
  cdfPow: (k: number) => number,
  eps: number = EPS
): PMF {
  const out = new Map<number, number>();
  let prev = 0;
  for (let k = 1; k <= 20; k++) {
    const cur = cdfPow(k);
    const pk = cur - prev;
    if (pk > 0) {
      out.set(k, pk);
    }
    prev = cur;
  }

  return PMF.fromMap(out, eps);
}
