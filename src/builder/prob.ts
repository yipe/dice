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

/**
 * `P(X ≥ t)` and `P(X < t)` for `pmf`, each summed from its own bins — so a side with no bins is
 * exactly 0, never the `1 - p` float residue of the other. Used to split a check's bonus dice at the
 * total its natural roll still needs.
 */
export function splitAtThreshold(pmf: PMF, t: number): { atLeast: number; below: number } {
  let atLeast = 0;
  let below = 0;
  for (const [x, bin] of pmf) {
    if (x >= t) atLeast += bin.p;
    else below += bin.p;
  }
  return { atLeast, below };
}
