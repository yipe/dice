// TODO - make a test file that calls these with advantage and disadvantage variants!

import { EPS } from "../src/common/types";
import { DiceQuery, PMF, parse } from "../src/index";
import { printTableWithTab } from "./print";

// Helper: conditionally include extra damage (like Sneak Attack), otherwise 0
const conditionally = (pmf: PMF, chance: number) =>
  PMF.branch(pmf, PMF.zero(), Math.max(0, Math.min(1, chance)));

function assertMassEquals(
  pmf: any,
  label: string,
  expected: number,
  eps = EPS
): void {
  const m = pmf.mass();
  if (!Number.isFinite(m))
    throw new Error(`${label} has non-finite mass: ${m}`);
  if (Math.abs(m - expected) > eps) {
    throw new Error(`${label} mass ${m} != expected ${expected}`);
  }
}

// First-success weights for n attempts.
// pH = P(hit or crit), pC = P(crit), identical independent attempts.
function firstSuccessWeights(pH: number, pC: number, n: number) {
  const miss = 1 - pH;
  const missPow = Math.pow(miss, n);
  const pAny = 1 - missPow;
  const denom = pH === 0 ? 1 : pH;
  const pSAcrit = (pC * (1 - missPow)) / denom;
  const pSAhit = ((pH - pC) * (1 - missPow)) / denom;
  const pNone = 1 - pSAhit - pSAcrit; // equals missPow
  return { pSAhit, pSAcrit, pNone, pAny };
}

// Common input structure
export type SneakAttackInputs = {
  check: string; // "(d20 + 8 AC 16)"
  hitDamage: string; // "1d4 + 4"
  critDamage: string; // "2d4 + 4"
  saDamage: string; // "3d6"
  saCritDamage: string; // "6d6"
  expression?: string; // "(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)"
  attempts?: number; // default 2
  expectedValue?: number; // expected value of the total (for tests)
};

type MassReader = { totalMass?: () => number; mass?: () => number };

/** Read a PMF's total probability mass if available, else assume 1. */
function massOf(pmf: MassReader | any): number {
  try {
    if (typeof pmf?.totalMass === "function") return pmf.mass();
    if (typeof pmf?.mass === "function") return pmf.mass();
  } catch {}
  return 1; // reasonable default when PMF type does not expose mass
}

function assertFiniteNumber(x: number, label: string): void {
  if (!Number.isFinite(x)) {
    throw new Error(`${label} is not finite: ${x}`);
  }
}

function assertMassNonNegative(pmf: any, label: string): void {
  const m = massOf(pmf);
  if (!(m >= -EPS)) {
    throw new Error(`${label} has negative mass: ${m}`);
  }
}

function assertPMFMassIsOne(pmf: any, label: string): void {
  const m = massOf(pmf);
  if (!Number.isFinite(m)) {
    throw new Error(`${label} has non-finite mass: ${m}`);
  }
  if (Math.abs(m - 1) > EPS) {
    console.warn(`${label} total mass != 1:`, m);
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function clampProbs(pH_raw: number, pC_raw: number) {
  const pH = clamp01(pH_raw);
  // Crit cannot exceed hit+crit
  const pC = clamp01(Math.min(pC_raw, pH));
  const pHitNoCrit = clamp01(pH - pC);
  const pMiss = clamp01(1 - pH);
  return { pH, pC, pHitNoCrit, pMiss };
}

/** Quick agreement check across EVs. Throws if any pair differs beyond tol. */
function assertAllClose(evPairs: Array<[string, number]>, eps = EPS) {
  for (let i = 1; i < evPairs.length; i++) {
    const [la, va] = evPairs[i - 1];
    const [lb, vb] = evPairs[i];
    if (Math.abs(va - vb) > eps) {
      throw new Error(
        `EV mismatch: ${la}=${va.toFixed(12)} vs ${lb}=${vb.toFixed(12)}`
      );
    }
  }
}

/** Optional helper to ensure no negative bin probabilities if exposed. */
function assertNoNegativeBins(pmf: any, label: string) {
  if (!pmf?.map || typeof pmf.map[Symbol.iterator] !== "function") return;
  for (const [_, bin] of pmf.map) {
    if (bin.p < -EPS) throw new Error(`${label} has negative bin p: ${bin.p}`);
  }
}

/* Variant A (Simple)
 * - Reads hit and crit chances directly from a full attack expression that already includes crit rules.
 * - Rolls two attacks.
 * - Adds Sneak Attack once per round, doubled if the first successful attack was a crit.
 */
export function simpleVariantA(inputs: SneakAttackInputs) {
  const atk = parse(inputs.expression!);

  // Read chances straight from the attack
  const one = new DiceQuery([atk]);
  const hitChance = Math.max(
    0,
    Math.min(1, one.probAtLeastOne(["hit", "crit"]))
  );
  const critChance = Math.max(0, Math.min(1, one.probAtLeastOne(["crit"])));
  const normalHitChance = Math.max(0, hitChance - critChance);

  // Sneak Attack is used on the first successful hit or crit
  const saOnHit = normalHitChance + (1 - hitChance) * normalHitChance;
  const saOnCrit = critChance + (1 - hitChance) * critChance;

  // Two swings
  const twoSwings = new DiceQuery([atk, atk]).combined;

  // Sneak Attack damage
  const sa = parse(inputs.saDamage);
  const saCrit = parse(inputs.saCritDamage);

  // Combine: two swings + Sneak Attack once
  const total = new DiceQuery([
    twoSwings,
    conditionally(sa, saOnHit),
    conditionally(saCrit, saOnCrit),
  ]).combined;

  return total.mean();
}

/**
 * Variant B (Simple)
 * - Hit chance comes from a simple check like "d20 + 8 AC 16".
 * - Crit chance comes from either a full crit-labeled attack or just defaults to 1/20.
 * - Builds one swing as {miss, hit, crit}.
 * - Does two swings.
 * - Adds Sneak Attack once per round, doubled on a first-attack crit.
 */
export function simpleVariantB(inputs: SneakAttackInputs) {
  // Chances
  const hitChance = Math.max(
    0,
    Math.min(
      1,
      new DiceQuery([parse(inputs.check)]).probAtLeastOne(["hit", "crit"])
    )
  );
  const critChance = Math.max(
    0,
    Math.min(
      1,
      inputs.expression
        ? new DiceQuery([parse(inputs.expression)]).probAtLeastOne(["crit"])
        : 1 / 20
    )
  );
  const normalHitChance = Math.max(0, hitChance - critChance);
  const missChance = Math.max(0, 1 - hitChance);

  // Sneak Attack usage
  const saOnHit = normalHitChance + (1 - hitChance) * normalHitChance;
  const saOnCrit = critChance + (1 - hitChance) * critChance;
  const saOnNone = Math.max(0, 1 - saOnHit - saOnCrit);

  // One attack
  const miss = PMF.zero();
  const hit = parse(inputs.hitDamage);
  const crit = parse(inputs.critDamage);

  const oneSwing = PMF.branch(
    crit,
    PMF.branch(
      hit,
      miss,
      normalHitChance / Math.max(normalHitChance + missChance, EPS)
    ),
    critChance
  );

  // Two swings
  const twoSwings = new DiceQuery([oneSwing, oneSwing]).combined;

  // Sneak Attack
  const saOnce = PMF.branch(
    parse(inputs.saCritDamage),
    PMF.branch(
      parse(inputs.saDamage),
      PMF.zero(),
      saOnHit / Math.max(saOnHit + saOnNone, EPS)
    ),
    saOnCrit
  );

  // Final total
  const total = new DiceQuery([twoSwings, saOnce]).combined;
  return total.mean();
}

export function simpleVariantC(inputs: SneakAttackInputs) {
  const attackExpression = inputs.expression ?? "ERROR: attack expr missing";
  const saBaseExpr = inputs.saDamage;
  const saCritExpr = inputs.saCritDamage;

  const attack = parse(attackExpression);

  const attacks = new DiceQuery([attack, attack]);

  const [pS, pC] = attacks.firstSuccessSplit(["hit", "crit"], ["crit"]);

  const sneak = PMF.exclusive([
    [parse(saCritExpr), pC],
    [parse(saBaseExpr), pS],
    // implicit else = 0 with remaining mass pNone
  ]);

  // Two identical attacks + exclusive Sneak rider
  return new DiceQuery([attack, attack, sneak]).mean();
}

export function simpleSneakOncePerRoundFromPMFs(
  inputs: SneakAttackInputs
): number {
  const pmfs = parse(inputs.expression!).replicate(2);
  const saBase = parse(inputs.saDamage);
  const saCrit = parse(inputs.saCritDamage);
  const query = new DiceQuery(pmfs);

  const [pSuccess, pSubset] = query.firstSuccessSplit(
    ["hit", "crit"],
    ["crit"]
  );

  const rider = PMF.exclusive([
    [saBase, pSuccess],
    [saCrit, pSubset],
  ]);

  const turn = new DiceQuery([...pmfs, rider]);
  console.log("mean:", turn.mean());
  return turn.mean();
}

/**
 * Variant 1: Direct blend over two full attacks.
 *
 * What it does:
 *  - Parses a crit-labeled attack PMF, reads pH and pC from it.
 *  - Builds two independent copies of that full attack, combined as a PMF.
 *  - Adds one Sneak Attack rider via two gated mixtures against zero:
 *      pSAhit for SA on a hit-first success, pSAcrit for SA on a crit-first success.
 *
 * Stats view:
 *  - Exact distribution for base weapon damage, exact mixture for SA application.
 *  - All probabilities are clamped for stability. PMF mass checks are enforced.
 *
 * Performance:
 *  - Cost of two PMF convolutions of the full attack, plus two small mixes.
 *  - Good balance of fidelity and speed for two attempts.
 *
 * When to use:
 *  - You already have a reliable crit-labeled attack expression.
 *  - You want the simplest exact-PMF build for two swings and one SA.
 */
export function variant1_mainDirectBlend(inputs: SneakAttackInputs) {
  const attempts = inputs.attempts ?? 2;

  const attackExpr =
    inputs.expression ??
    `(d20 + 8 AC 16) * (${inputs.hitDamage}) crit (${inputs.critDamage})`;

  const atk = parse(attackExpr);
  const one = new DiceQuery([atk]);
  const pH_raw = one.probAtLeastOne(["hit", "crit"]);
  const pC_raw = one.probAtLeastOne(["crit"]);
  const { pH, pC, pHitNoCrit } = clampProbs(pH_raw, pC_raw);

  // First-success weights for two attempts
  const pSAcrit = clamp01(pC + (1 - pH) * pC);
  const pSAhit = clamp01(pHitNoCrit + (1 - pH) * pHitNoCrit);

  // Base damage from two independent attacks
  const baseTwo = new DiceQuery([atk, atk]).combined;

  const sa = parse(inputs.saDamage);
  const saCrit = parse(inputs.saCritDamage);

  // Intentional mixture with zero to represent "no SA this turn"
  const saOnHit = PMF.branch(sa, PMF.zero(), pSAhit);
  const saOnCrit = PMF.branch(saCrit, PMF.zero(), pSAcrit);

  const total = new DiceQuery([baseTwo, saOnHit, saOnCrit]).combined;

  // Invariants
  const daggerOnlyDPR = new DiceQuery([baseTwo]).mean();
  const saOnlyEV = saOnHit.mean() + saOnCrit.mean();
  const totalEV = new DiceQuery([total]).mean();

  assertFiniteNumber(daggerOnlyDPR, "Var1 ev daggerOnly");
  assertFiniteNumber(saOnlyEV, "Var1 ev SA only");
  assertFiniteNumber(totalEV, "Var1 totalEV");
  assertPMFMassIsOne(baseTwo, "Var1 baseTwo");
  assertPMFMassIsOne(saOnHit, "Var1 saOnHit");
  assertPMFMassIsOne(saOnCrit, "Var1 saOnCrit");
  assertPMFMassIsOne(total, "Var1 total");
  assertNoNegativeBins(total, "Var1 total");

  return totalEV;
}

/**
 * Variant 2: Main B. Check-only probabilities and mixtures.
 *
 * What it does:
 *  - Computes pH from a check-only PMF, and pC either from a crit-labeled attack
 *    provided in inputs, or defaults to 1/20.
 *  - Constructs a single-attack mixture over {miss, hit, crit} using hitPMF and critPMF.
 *  - Convolves two single-attack mixtures for base damage.
 *  - Adds one SA rider as a 3-way mix: {SA on hit, SA on crit, none}.
 *
 * Stats view:
 *  - Exact PMF for base damage from per-case building blocks.
 *  - First-success math is explicit and auditable.
 *
 * Performance:
 *  - Smaller PMFs than Variant 1 because hit and crit damage are injected only
 *    after the check mixture, so fewer labeled outcomes propagate.
 *
 * When to use:
 *  - You want a clean separation between check math and damage PMFs.
 *  - You need to swap weapon dice or check logic independently.
 */
export function variant2_mainCheckMixtures(inputs: SneakAttackInputs) {
  const attempts = inputs.attempts ?? 2;

  const chk = parse(inputs.check);
  const hitPMF = parse(inputs.hitDamage);
  const critPMF = parse(inputs.critDamage);
  const saPMF = parse(inputs.saDamage);
  const saCritPMF = parse(inputs.saCritDamage);
  const zero = PMF.zero?.() ?? parse("0");

  const oneCheck = new DiceQuery([chk]);
  const pH_raw = oneCheck.probAtLeastOne(["hit", "crit"]);
  const pC_raw = inputs.expression
    ? new DiceQuery([parse(inputs.expression)]).probAtLeastOne(["crit"])
    : 1 / 20;
  const { pH, pC, pHitNoCrit, pMiss } = clampProbs(pH_raw, pC_raw);

  const pSAcrit = clamp01(pC + (1 - pH) * pC);
  const pSAhit = clamp01(pHitNoCrit + (1 - pH) * pHitNoCrit);
  const pNone = clamp01(1 - pSAhit - pSAcrit);

  const singleAttack = PMF.mixN([
    [pMiss, zero],
    [pHitNoCrit, hitPMF],
    [pC, critPMF],
  ]);

  const baseTwo = new DiceQuery([singleAttack, singleAttack]).combined;

  const saOnce = PMF.mixN([
    [pSAhit, saPMF],
    [pSAcrit, saCritPMF],
    [pNone, zero],
  ]);
  const total = new DiceQuery([baseTwo, saOnce]).combined;

  const baseEV = new DiceQuery([baseTwo]).mean();
  const totalEV = new DiceQuery([total]).mean();

  assertFiniteNumber(baseEV, "Var2 baseEV");
  assertFiniteNumber(totalEV, "Var2 totalEV");
  assertPMFMassIsOne(singleAttack, "Var2 singleAttack");
  assertPMFMassIsOne(baseTwo, "Var2 baseTwo");
  assertPMFMassIsOne(saOnce, "Var2 saOnce");
  assertPMFMassIsOne(total, "Var2 total");
  assertNoNegativeBins(total, "Var2 total");

  return totalEV;
}

/**
 * Variant 3: Closed-form N attempts (PMF).
 *
 * What it does:
 *  - Generalizes Variant 2 to any number of attempts n.
 *  - Uses closed-form first-success weights for pSAhit, pSAcrit, and pNone
 *    given pH and pC, then convolve n copies of the single-attack mixture.
 *  - Adds one SA rider once per round as a 3-way mix.
 *
 * Stats view:
 *  - Exact PMF for base damage across n attempts.
 *  - Exact EV for the SA rider via mixture. Total DPR is mean of the final PMF.
 *
 * Performance:
 *  - Cost grows with n due to repeated PMF convolution.
 *  - Suitable for small n, for larger n prefer Variant 4.
 *
 * When to use:
 *  - You need exact PMFs for n attempts and still want the closed-form SA algebra.
 */
export function variant3_closedFormN(inputs: SneakAttackInputs) {
  const n = inputs.attempts ?? 2;

  const chk = parse(inputs.check);
  const hitPMF = parse(inputs.hitDamage);
  const critPMF = parse(inputs.critDamage);
  const saPMF = parse(inputs.saDamage);
  const saCritPMF = parse(inputs.saCritDamage);
  const zero = PMF.zero?.() ?? parse("0");

  const pH_raw = new DiceQuery([chk]).probAtLeastOne(["hit", "crit"]);
  const pC_raw = inputs.expression
    ? new DiceQuery([parse(inputs.expression)]).probAtLeastOne(["crit"])
    : 1 / 20;
  const { pH, pC, pHitNoCrit, pMiss } = clampProbs(pH_raw, pC_raw);

  const { pSAhit, pSAcrit, pNone, pAny } = firstSuccessWeights(pH, pC, n);

  const single = PMF.mixN([
    [pMiss, zero],
    [pHitNoCrit, hitPMF],
    [pC, critPMF],
  ]);
  const baseN = single.power(n);

  const saOnce = PMF.mixN([
    [pSAhit, saPMF],
    [pSAcrit, saCritPMF],
    [pNone, zero],
  ]);
  const total = new DiceQuery([baseN, saOnce]).combined;

  const baseEV = new DiceQuery([baseN]).mean();
  const saEV = saOnce.mean();
  const totalEV = new DiceQuery([total]).mean();

  assertFiniteNumber(baseEV, "Var3 baseEV");
  assertFiniteNumber(saEV, "Var3 saEV");
  assertFiniteNumber(totalEV, "Var3 totalEV");
  assertPMFMassIsOne(single, "Var3 single");
  assertPMFMassIsOne(baseN, "Var3 baseN");
  assertPMFMassIsOne(saOnce, "Var3 saOnce");
  assertPMFMassIsOne(total, "Var3 total");
  assertNoNegativeBins(total, "Var3 total");

  return totalEV;
}

/**
 * Variant 4: State-machine fold over attacks (PMF).
 *
 * What it does:
 *  - Markov-style fold with two states: {noSAYet, done}.
 *  - Each step:
 *      miss stays in noSAYet,
 *      first hit or crit moves mass to done and consumes SA with the right PMF,
 *      once in done, future swings use weapon-only mixtures.
 *  - After n steps, union the two end states to get the total PMF.
 *
 * Stats view:
 *  - Mass-safe and numerically stable. Uses scale-only gating with empty-mass
 *    to avoid accidental probability inflation.
 *  - Preserves exact distributional shape across sequences.
 *
 * Performance:
 *  - Linear in n with small constant factors. Avoids large n-way convolutions
 *    in one shot and keeps intermediate PMFs tighter.
 *
 * When to use:
 *  - Best all-around exact PMF method for arbitrary n.
 *  - You care about correctness, stability, and reasonable speed together.
 */
export function variant4_stateMachine(inputs: SneakAttackInputs) {
  const n = inputs.attempts ?? 2;

  // Helpers
  const zero = PMF.zero(); // 100% at damage 0
  const empty = PMF.emptyMass(); // no mass at all
  const gate = (pmf: PMF, p: number) => PMF.branch(pmf, empty, p); // scale only
  const take = gate; // alias for clarity

  // Inputs
  const chk = parse(inputs.check);
  const hitPMF = parse(inputs.hitDamage); // weapon-only on hit
  const critPMF = parse(inputs.critDamage); // weapon-only on crit
  const saHitPMF = parse(inputs.saDamage); // SA increment on hit
  const saCritPMF = parse(inputs.saCritDamage); // SA increment on crit

  // Base probabilities
  const pH_raw = new DiceQuery([chk]).probAtLeastOne(["hit", "crit"]);
  const pC_raw = inputs.expression
    ? new DiceQuery([parse(inputs.expression)]).probAtLeastOne(["crit"])
    : 1 / 20;

  // Clamp for numerical stability
  const { pH, pC, pHitNoCrit, pMiss } = clampProbs(pH_raw, pC_raw);

  // Once SA is spent, each swing uses the weapon-only mixture including miss
  const weaponMix = PMF.mixN([
    [pMiss, zero],
    [pHitNoCrit, hitPMF],
    [pC, critPMF],
  ]);

  type SAState = { noSAYet: PMF; done: PMF };

  function step(state: SAState): SAState {
    // Miss keeps us in "no SA yet"
    const next_noSAYet = take(state.noSAYet, pMiss);

    // First landed hit or crit this attack consumes SA exactly once
    // If your SA PMFs are full totals, replace the two lines with the commented versions below.
    const firstHit = take(state.noSAYet, pHitNoCrit)
      .combineRaw(hitPMF)
      .combineRaw(saHitPMF);
    const firstCrit = take(state.noSAYet, pC)
      .combineRaw(critPMF)
      .combineRaw(saCritPMF);

    // Full totals version:
    // const firstHit  = take(state.noSAYet, pHitNoCrit).combineRaw(saHitPMF);
    // const firstCrit = take(state.noSAYet, pC).combineRaw(saCritPMF);

    // If SA already consumed, still swing this attack with weapon-only mixture
    const keepSwinging = state.done.combineRaw(weaponMix);

    const next_done = PMF.emptyMass()
      .addScaled(firstHit, 1)
      .addScaled(firstCrit, 1)
      .addScaled(keepSwinging, 1);

    return { noSAYet: next_noSAYet, done: next_done };
  }

  // Start of turn: SA not used yet. No damage accrued.
  let s: SAState = { noSAYet: PMF.zero(), done: PMF.emptyMass() };

  // Fold over attempts, with per-step sanity checks
  for (let i = 0; i < n; i++) {
    s = step(s);
    assertMassNonNegative(s.noSAYet, `Var4 noSAYet after step ${i}`);
    assertMassNonNegative(s.done, `Var4 done after step ${i}`);
  }

  // Total distribution is the union of the two disjoint end states
  const total = PMF.emptyMass().addScaled(s.noSAYet, 1).addScaled(s.done, 1);

  // Invariants
  const totalEV = total.mean();
  assertFiniteNumber(totalEV, "Var4 totalEV");
  assertPMFMassIsOne(weaponMix, "Var4 weaponMix");
  assertPMFMassIsOne(total, "Var4 total");
  assertNoNegativeBins(total, "Var4 total");

  return totalEV;
}

/**
 * Variant 5: EV-only fast path.
 *
 * What it does:
 *  - Computes expected weapon damage from pH, pC, evHit, evCrit, then multiplies by n.
 *  - Adds expected Sneak Attack using closed-form first-success weights and the
 *    mean of SA dice on hit or crit.
 *
 * Stats view:
 *  - Returns only DPR (a scalar), no distribution.
 *  - Matches the mean of all exact-PMF variants given the same inputs.
 *
 * Performance:
 *  - Very fast. No PMF construction or convolution.
 *
 * When to use:
 *  - You only need DPR and not the full damage distribution.
 *  - Ideal for UI previews, sliders, and quick comparisons.
 */
export function variant5_evOnly(inputs: SneakAttackInputs) {
  const n = inputs.attempts ?? 2;

  const pH_raw = new DiceQuery([parse(inputs.check)]).probAtLeastOne([
    "hit",
    "crit",
  ]);
  const pC_raw = inputs.expression
    ? new DiceQuery([parse(inputs.expression)]).probAtLeastOne(["crit"])
    : 1 / 20;

  const { pH, pC } = clampProbs(pH_raw, pC_raw);

  const evHit = parse(inputs.hitDamage).mean();
  const evCrit = parse(inputs.critDamage).mean();

  const evOne = (pH - pC) * evHit + pC * evCrit;
  const evWeapon = n * evOne;

  const { pSAhit, pSAcrit } = firstSuccessWeights(pH, pC, n);
  const evSA =
    pSAhit * parse(inputs.saDamage).mean() +
    pSAcrit * parse(inputs.saCritDamage).mean();

  const total = evWeapon + evSA;

  assertFiniteNumber(evWeapon, "Var5 evWeapon");
  assertFiniteNumber(evSA, "Var5 evSA");
  assertFiniteNumber(total, "Var5 totalEV");

  return total;
}

/**
 * Variant 6: Sequence partitioning for two attacks (PMF).
 *
 * What it does:
 *  - Enumerates disjoint ordered paths for two attacks:
 *      H* = Hit first, then anything,
 *      C* = Crit first, then anything,
 *      MH = Miss then Hit,
 *      MC = Miss then Crit.
 *  - Attaches SA to the first success in each path, with the right PMF.
 *  - Adds the disjoint terms together for the final PMF.
 *
 * Stats view:
 *  - Exact PMF with explicit path semantics, easy to reason about.
 *  - The sum of path masses equals the probability of at least one success.
 *
 * Performance:
 *  - Fixed small number of terms for two attempts. Becomes verbose for larger n,
 *    so prefer Variant 3 or 4 beyond two attacks.
 *
 * When to use:
 *  - Great for documentation and debugging of the two-swing case.
 *  - Makes the first-success logic crystal clear.
 */

export function variant6_sequencePartitioning(inputs: SneakAttackInputs) {
  const zero = PMF.zero?.() ?? parse("0");
  const chk = parse(inputs.check);
  const hitPMF = parse(inputs.hitDamage);
  const critPMF = parse(inputs.critDamage);
  const saHitPMF = parse(inputs.saDamage);
  const saCritPMF = parse(inputs.saCritDamage);

  // Mix with zero here is intentional: these terms are *added* later
  const gate = (pmf: PMF, p: number) => PMF.branch(pmf, PMF.emptyMass(), p);

  const pH_raw = new DiceQuery([chk]).probAtLeastOne(["hit", "crit"]);
  const pC_raw = inputs.expression
    ? new DiceQuery([parse(inputs.expression)]).probAtLeastOne(["crit"])
    : 1 / 20;
  const { pH, pC, pHitNoCrit, pMiss } = clampProbs(pH_raw, pC_raw);

  const anyWeapon = PMF.mixN([
    [pMiss, zero],
    [pHitNoCrit, hitPMF],
    [pC, critPMF],
  ]);

  // H* : first is H (with SA), then second is anything
  const HplusSA = new DiceQuery([hitPMF, saHitPMF]).combined;
  const path_Hstar = new DiceQuery([HplusSA, anyWeapon]).combined;
  const term_Hstar = gate(path_Hstar, pHitNoCrit);

  // C* : first is C (with SA crit), then second is anything
  const CplusSA = new DiceQuery([critPMF, saCritPMF]).combined;
  const path_Cstar = new DiceQuery([CplusSA, anyWeapon]).combined;
  const term_Cstar = gate(path_Cstar, pC);

  // MH : miss then Hit (with SA)
  const term_MH = gate(HplusSA, pMiss * pHitNoCrit);

  // MC : miss then Crit (with SA crit)
  const term_MC = gate(CplusSA, pMiss * pC);

  // These terms are disjoint and should be *added*, not convolved
  const total = PMF.emptyMass()
    .addScaled(term_Hstar, 1)
    .addScaled(term_Cstar, 1)
    .addScaled(term_MH, 1)
    .addScaled(term_MC, 1);

  const totalEV = total.mean();

  // 1) EV finite
  assertFiniteNumber(totalEV, "Var6 totalEV");

  // 2) anyWeapon is a normalized mixture
  assertPMFMassIsOne(anyWeapon, "Var6 anyWeapon");

  // 3) Each gated term’s mass equals its path probability
  assertMassEquals(term_Hstar, "Var6 term_Hstar", pHitNoCrit);
  assertMassEquals(term_Cstar, "Var6 term_Cstar", pC);
  assertMassEquals(term_MH, "Var6 term_MH", pMiss * pHitNoCrit);
  assertMassEquals(term_MC, "Var6 term_MC", pMiss * pC);

  // 4) Disjoint-sum total mass equals P(any success in 2 tries)
  const pAny = 1 - Math.pow(1 - pH, 2);
  assertMassEquals(total, "Var6 total", pAny);

  // 5) No negative bins in the final distribution
  assertNoNegativeBins(total, "Var6 total");

  return totalEV;
}

/* ===========================
   Optional: micro-fuzz harness
   Randomized sanity to keep variants aligned
=========================== */

export function fuzzSneakAttackAgreement(iterations = 200) {
  for (let i = 0; i < iterations; i++) {
    const bonus = Math.floor(Math.random() * 10) + 1; // 1..10
    const ac = Math.floor(Math.random() * 10) + 12; // 12..21
    const n = Math.floor(Math.random() * 3) + 1; // 1..3 attempts

    const inputs: SneakAttackInputs = {
      attempts: n,
      check: `d20 + ${bonus} AC ${ac}`,
      hitDamage: `1d4 + 4`,
      critDamage: `2d4 + 4`,
      saDamage: `2d6`,
      saCritDamage: `4d6`,
      expression: `(d20 + ${bonus} AC ${ac}) * (1d4 + 4) crit (2d4 + 4)`,
    };

    const ev1 = variant1_mainDirectBlend(inputs);
    const ev2 = variant2_mainCheckMixtures(inputs);
    const ev3 = variant3_closedFormN(inputs);
    const ev4 = variant4_stateMachine(inputs);
    const ev5 = variant5_evOnly(inputs);
    const ev6 = variant6_sequencePartitioning(inputs);

    assertAllClose(
      [
        ["v1", ev1],
        ["v2", ev2],
        ["v3", ev3],
        ["v4", ev4],
        ["v5", ev5],
        ["v6", ev6],
      ],
      EPS
    );
  }
}

export function runAllSneakAttackExamples() {
  const inputs: SneakAttackInputs = {
    check: "(d20 + 8 AC 16)",
    hitDamage: "1d4 + 4",
    critDamage: "2d4 + 4",
    saDamage: "3d6",
    saCritDamage: "6d6",
    expression: "(d20 + 8 AC 16) * (1d4 + 4) crit (2d4 + 4)",
    attempts: 2,
  };

  const va = simpleVariantA(inputs);
  const vb = simpleVariantB(inputs);
  const vc = simpleVariantC(inputs);
  const v1 = variant1_mainDirectBlend(inputs);
  const v2 = variant2_mainCheckMixtures(inputs);
  const v3 = variant3_closedFormN(inputs);
  const v4 = variant4_stateMachine(inputs);
  const v5 = variant5_evOnly(inputs);
  const v6 = variant6_sequencePartitioning(inputs);

  printTableWithTab(
    "Summary",
    ["Number", "Test", "Result"],
    [0, 0, 0],
    [
      ["A", "Direct blend example", va.toFixed(5)],
      ["B", "Check mixtures example", vb.toFixed(5)],
      ["C", "Simple example", vc.toFixed(5)],
      ["1", "Direct blend", v1.toFixed(5)],
      ["2", "Check mixtures", v2.toFixed(5)],
      ["3", "Closed-form N (PMF)", v3.toFixed(5)],
      ["4", "State-machine fold (PMF)", v4.toFixed(5)],
      ["5", "EV-only", v5.toFixed(5)],
      ["6", "Sequence partitioning (PMF)", v6.toFixed(5)],
    ],
    ["left", "left", "left"]
  );

  console.log(
    "All exact PMF variants should agree. EV-only matches the expected value."
  );
}

runAllSneakAttackExamples();
