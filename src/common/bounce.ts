/**
 * Bounce odds — the "birthday problem" for bouncing damage dice (e.g. Chromatic
 * Orb): the probability that at least two of K dice with S faces show the same
 * value, which is what lets the spell jump to another target.
 *
 * Accounts for two modifiers:
 * - **Elemental Adept** (`minimumDieRoll >= 2`): rolls below the minimum are
 *   bumped up to it, collapsing the low faces onto a single heavier value.
 * - **Empowered Spell** (`rerollDamageDice > 0`): a number of dice may be
 *   rerolled once, giving a second chance at a match.
 *
 * The base and Elemental-Adept cases are computed exactly (see
 * {@link pAllDistinct}); the Empowered-Spell reroll is an explicit model layered
 * on the exact base match probability.
 */

/** Options that modify bounce odds via metamagic / feats. */
export interface BounceOddsOptions {
  /** Minimum die roll — e.g. 2 for Elemental Adept, 3 for Great Weapon Fighting 2024. */
  minimumDieRoll?: number;
  /** Number of dice that may be rerolled once — e.g. CHA modifier for Empowered Spell. */
  rerollDamageDice?: number;
}

/** Binomial coefficient C(n, k), 0 for out-of-range k. */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

/**
 * Exact P(all K dice show distinct values) for a die with `uniformCount`
 * ordinary faces (each probability `1/faces`) plus one optional heavy face whose
 * probability is `heavyWeight` (used for the Elemental-Adept collapse; pass 0
 * for a plain die). Uses the elementary symmetric polynomial e_K over the face
 * probabilities: P(all distinct) = K! · e_K.
 */
function pAllDistinct(
  dice: number,
  faces: number,
  uniformCount: number,
  heavyWeight: number
): number {
  const light = 1 / faces;
  // e_K = (choose K distinct light faces) + (heavy face + K-1 light faces).
  const eK =
    binom(uniformCount, dice) * Math.pow(light, dice) +
    heavyWeight * binom(uniformCount, dice - 1) * Math.pow(light, dice - 1);
  let kFactorial = 1;
  for (let i = 2; i <= dice; i++) kFactorial *= i;
  return kFactorial * eK;
}

/** Exact P(at least one duplicate) among `dice` dice, honoring Elemental Adept. */
function pMatch(dice: number, faces: number, minimumDieRoll: number): number {
  if (dice <= 1) return 0;
  if (dice > faces) return 1;

  if (minimumDieRoll >= 2) {
    // Rolls 1..minimumDieRoll collapse onto the value `minimumDieRoll`, giving it
    // weight minimumDieRoll/faces; the faces above it stay uniform at 1/faces.
    const uniformCount = faces - minimumDieRoll; // values minimumDieRoll+1 .. faces
    const effectiveValues = uniformCount + 1; // + the collapsed value
    if (dice > effectiveValues) return 1;
    const heavyWeight = minimumDieRoll / faces;
    const distinct = pAllDistinct(dice, faces, uniformCount, heavyWeight);
    return Math.min(1, Math.max(0, 1 - distinct));
  }

  // Plain die: P(all distinct) = falling_factorial(faces, dice) / faces^dice.
  let pDistinct = 1;
  for (let i = 0; i < dice; i++) pDistinct *= (faces - i) / faces;
  return 1 - pDistinct;
}

/**
 * P(at least two of `diceCount` dice with `dieFaces` faces match), honoring
 * Elemental Adept and Empowered Spell. Returns a probability in [0, 1].
 *
 * @param diceCount Number of dice rolled.
 * @param dieFaces Faces per die (e.g. 8 for d8).
 * @param options Optional metamagic / feat modifiers.
 */
export function calculateBounceOdds(
  diceCount: number,
  dieFaces: number,
  options?: BounceOddsOptions
): number {
  if (diceCount <= 1) return 0;
  if (diceCount > dieFaces) return 1; // pigeonhole

  const minimumDieRoll = options?.minimumDieRoll ?? 0;
  const rerollDamageDice = options?.rerollDamageDice ?? 0;

  const pMatchFirst = pMatch(diceCount, dieFaces, minimumDieRoll);

  // Without Empowered Spell we're done.
  const rerollCount = Math.min(rerollDamageDice, diceCount);
  if (rerollCount <= 0) return pMatchFirst;

  // Empowered Spell: reroll `rerollCount` non-matching dice once. Model the
  // second chance as (a rerolled die matching one of the kept dice) OR (the
  // rerolled dice matching among themselves).
  const pNoMatchFirst = 1 - pMatchFirst;
  const keptDice = diceCount - rerollCount;
  const effectiveFaces = minimumDieRoll >= 2 ? dieFaces - (minimumDieRoll - 1) : dieFaces;

  // With no kept dice, a rerolled die vacuously "misses" all of them (prob 1), so
  // the only way to match is among the rerolled dice themselves (pRerolledMatch below).
  const pRerollDieMissesAll =
    keptDice > 0 ? Math.pow((effectiveFaces - keptDice) / effectiveFaces, rerollCount) : 1;
  const pAtLeastOneRerollMatches = 1 - pRerollDieMissesAll;
  const pRerolledMatch = rerollCount >= 2 ? pMatch(rerollCount, dieFaces, minimumDieRoll) : 0;
  const pMatchAfterReroll = Math.min(
    1,
    pAtLeastOneRerollMatches + pRerolledMatch * (1 - pAtLeastOneRerollMatches)
  );

  return Math.min(1, pMatchFirst + pNoMatchFirst * pMatchAfterReroll);
}
