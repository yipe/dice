import { DiceQuery, OutcomeType, parse, PMF, TEST_EPS } from "../src/index";
import { fxd, pct, sep } from "./print";

/** Build a DiceQuery from a single expression (keeps provenance as one "single"). */
function makeQuery(expr: string): DiceQuery {
  return new DiceQuery([parse(expr)]);
}

/** Probability that a single-expression query has at least one of the given outcomes. */
function probAtLeastOne(
  expr: string,
  events: OutcomeType | OutcomeType[]
): number {
  return new DiceQuery([parse(expr)]).probAtLeastOne(events);
}

// --------------------------------------------------------
// 1) Basic Attack
// --------------------------------------------------------
function basicAttack() {
  sep("Basic Attack");
  const attackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const q = makeQuery(attackExpr);
  console.table({
    "Attack Expression": attackExpr,
    "Hit Chance (incl. crit)": pct(q.probAtLeastOne(["hit", "crit"])),
    "Average Damage": fxd(q.mean()),
  });
}

// --------------------------------------------------------
// 2) Fireball (single target, then 5 targets)
// --------------------------------------------------------
function fireball() {
  sep("Fireball");

  const expr = "(d20 + 5 DC 16) * (8d6) save half";
  const one = makeQuery(expr);
  console.table({
    "Fireball Expression": expr,
    "1 Enemy DPR": fxd(one.mean()),
    "Save Success Rate": pct(one.probAtLeastOne("saveHalf")),
  });

  // 5 independent targets
  const savePMF = parse(expr);
  const five = new DiceQuery(savePMF.replicate(5));
  console.table({
    "5 Enemies DPR": fxd(five.mean()),
    "Odds at least 1 enemy saves": pct(five.probAtLeastOne("saveHalf")),
    "Odds at least 2 enemies save": pct(five.probAtLeastK("saveHalf", 2)),
    "Odds at least 3 enemies save": pct(five.probAtLeastK("saveHalf", 3)),
    "Odds at least 4 enemies save": pct(five.probAtLeastK("saveHalf", 4)),
    "Odds at least 5 enemies save": pct(five.probAtLeastK("saveHalf", 5)),
  });
}

// --------------------------------------------------------
// 3) Share of damage from crit outcomes
// --------------------------------------------------------
function critShare() {
  sep("Share of damage from crit outcomes");
  const expr = "(d20 + 6 AC 15) * (1d8 + 3) crit (2d8 + 3)";
  const pmf = parse(expr);
  const totalDamage = pmf.mean();
  const critDamage = pmf.filterOutcome("crit").mean();
  const share = totalDamage === 0 ? 0 : critDamage / totalDamage;
  console.table({
    Expression: expr,
    "Share of damage from crit outcomes": pct(share),
  });
}

// --------------------------------------------------------
// 4) Fighter Multi-Attack Examples
// --------------------------------------------------------
function fighterMultiAttack() {
  sep("Fighter 11: Three attacks with longsword");
  const attackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const atk = parse(attackExpr);
  const multi = new DiceQuery(atk.replicate(3));
  const probAtLeast2Hits = 1 - multi.probAtMostK(["hit", "crit"], 1);
  console.table({
    "3x expressions": attackExpr,
    "Chance of at least 2 hits": pct(probAtLeast2Hits),
    "Average DPR": fxd(multi.mean()),
  });

  sep("Fighter 5: Two attacks plus off-hand without fighting style");
  const mainAttackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const offAttackExpr = "(d20 + 8 AC 16) * (1d6) crit (2d6)";
  const twf = new DiceQuery([
    parse(mainAttackExpr),
    parse(mainAttackExpr),
    parse(offAttackExpr),
  ]);
  console.table({
    "First attack": mainAttackExpr,
    "Second attack": mainAttackExpr,
    "Off-hand attack": offAttackExpr,
    "Average DPR": fxd(twf.mean()),
  });
}

// --------------------------------------------------------
// 5) Stats block (normal / advantage / elven accuracy)
// --------------------------------------------------------
function statsBlockOutcomes(title: string, expr: string) {
  console.log(title);
  const q = makeQuery(expr);
  console.table({
    Expression: expr,
    "Mean damage": fxd(q.mean()),
    "Standard deviation": fxd(q.stddev()),
    "25th/50th/75th percentile": q.percentiles([0.25, 0.5, 0.75]).join(", "),
    "Chance of no damage": pct(1 - q.probTotalAtLeast(1)),
    "Chance of 20+ damage": pct(q.probTotalAtLeast(20)),
    "Chance of exactly 1 crit": pct(q.probExactlyK("crit", 1)),
  });
  console.log("");
}

function statsBlock() {
  sep("Stats block for an attack");
  const normal = "(d20 + 10 AC 18) * (2d6 + 1d10 + 6) crit (4d6 + 2d10 + 6)";
  const adv = "(d20 > d20 + 10 AC 18) * (2d6 + 1d10 + 6) crit (4d6 + 2d10 + 6)";
  const elvenAcc =
    "(d20 > d20 > d20 + 10 AC 18) * (2d6 + 1d10 + 6) crit (4d6 + 2d10 + 6)";
  statsBlockOutcomes("Normal attack", normal);
  statsBlockOutcomes("Advantage", adv);
  statsBlockOutcomes("Advantage (Elven Accuracy)", elvenAcc);
}

// --------------------------------------------------------
// 6) Halfling Luck vs Normal
// --------------------------------------------------------
function halflingLuck() {
  sep("Halfling Luck on attack rolls");
  const halflingExpr = "(hd20 + 5 AC 15) * (1d6 + 3) crit (2d6 + 3)";
  const normalExpr = "(d20  + 5 AC 15) * (1d6 + 3) crit (2d6 + 3)";
  const hq = makeQuery(halflingExpr);
  const nq = makeQuery(normalExpr);

  const hitH = hq.probAtLeastOne(["hit", "crit"]);
  const hitN = nq.probAtLeastOne(["hit", "crit"]);
  const dprH = hq.mean();
  const dprN = nq.mean();

  console.table({
    "Halfling hit rate": pct(hitH),
    "Normal hit rate": pct(hitN),
    "Hit rate improvement": pct(hitH / hitN - 1),
    "Halfling DPR": fxd(dprH),
    "Normal DPR": fxd(dprN),
    "DPR improvement": pct(dprH / dprN - 1),
  });
}

// --------------------------------------------------------
// 7) Weapon comparison
// --------------------------------------------------------
function weaponComparison() {
  sep("Greatsword vs Longbow at AC 16. +8 to hit");
  const greatsword = "(d20 + 8 AC 16) * (2d6 + 4) crit (4d6 + 4)";
  const longbow = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const gsQ = makeQuery(greatsword);
  const lbQ = makeQuery(longbow);
  console.table({
    "Greatsword DPR": fxd(gsQ.mean()),
    "Longbow DPR": fxd(lbQ.mean()),
    "Greatsword stdev": fxd(gsQ.stddev()),
    "Longbow stdev": fxd(lbQ.stddev()),
  });
}

// --------------------------------------------------------
// 8) Hold Person check
// --------------------------------------------------------
function holdPersonExample() {
  sep("Hold Person. Target +3 Wis save vs DC 15");
  const expr = "(d20 + 3 DC 15)";
  const q = makeQuery(expr);
  console.table({
    Expression: expr,
    "Fail rate (paralyzed)": pct(q.probAtLeastOne("saveFail")),
  });
}

// --------------------------------------------------------
// 9) OA scaling (use withProbability)
// --------------------------------------------------------
function opportunityAttackScaling() {
  sep("Opportunity attack that only occurs 30 percent of the time");
  const expr = "(d20 + 8 AC 16) * (2d8 + 5) crit (4d6 + 5)";
  const oa = PMF.withProbability(parse(expr), 0.3);
  console.table({
    Expression: expr,
    "Average DPR of normal attack": fxd(parse(expr).mean()),
    "DPR with 30% chance of OA": fxd(oa.mean()),
  });
}

// --------------------------------------------------------
// 10) Elven Accuracy vs advantage vs straight
// --------------------------------------------------------
function elvenAccuracy() {
  sep("Elven Accuracy vs advantage vs straight. Longsword example");
  const elven = "(d20 > d20 > d20 + 8 AC 16) * (1d10 + 4) crit (2d10 + 4)";
  const adv = "(d20 > d20 + 8 AC 16) * (1d10 + 4) crit (2d10 + 4)";
  const normal = "(d20 + 8 AC 16) * (1d10 + 4) crit (2d10 + 4)";
  const eQ = makeQuery(elven);
  const aQ = makeQuery(adv);
  const nQ = makeQuery(normal);

  console.table({
    "Elven Accuracy hit rate": pct(eQ.probAtLeastOne(["hit", "crit"])),
    "Advantage hit rate": pct(aQ.probAtLeastOne(["hit", "crit"])),
    "Normal hit rate": pct(nQ.probAtLeastOne(["hit", "crit"])),
    "DPR elven": fxd(eQ.mean()),
    "DPR adv": fxd(aQ.mean()),
    "DPR normal": fxd(nQ.mean()),
  });
}

// --------------------------------------------------------
// 11) Great Weapon Master scan
// --------------------------------------------------------
function greatWeaponMaster() {
  sep("Great Weapon Master. AC scan for breakpoint (+8 to hit)");

  const baseline = (ac: number) =>
    makeQuery(`(d20 + 8 AC ${ac}) * (2d6 + 4)  crit (2d6)`);
  const gwm = (ac: number) =>
    makeQuery(`(d20 + 3 AC ${ac}) * (2d6 + 14) crit (2d6)`);

  const results = [];

  let foundAC = undefined;
  for (let ac = 10; ac <= 20; ac++) {
    const n = baseline(ac).mean();
    const g = gwm(ac).mean();
    results.push({ AC: ac, "Normal DPR": fxd(n), "GWM DPR": fxd(g) });

    if (!foundAC && n > g) foundAC = ac;
  }
  console.table(results);
  console.log(`GWM stops being optimal at AC ${foundAC}`);
}

// --------------------------------------------------------
// 12) Sentinel reaction chain with smite (clean gates)
// --------------------------------------------------------
function sentinelSmite() {
  sep("Sentinel OA with Divine Smite gating and crit doubling");

  const oaExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const opportunityAttack = parse(oaExpr);
  const pOA = 0.2; // 20% chance of an opportunity attack

  const pHit = probAtLeastOne(oaExpr, "hit");
  const pCrit = probAtLeastOne(oaExpr, "crit");

  // Smite: split into normal hit smite and crit smite
  const smite = new DiceQuery([
    PMF.withProbability(parse("2d8"), pHit), // base smite
    PMF.withProbability(parse("4d8"), pCrit), // doubled smite dice
  ]);

  // Final query: keep singles separate for provenance
  const total = new DiceQuery([
    PMF.withProbability(opportunityAttack, pOA),
    PMF.withProbability(parse("2d8"), pOA * pHit),
    PMF.withProbability(parse("4d8"), pOA * pCrit),
  ]);

  console.table({
    "Sentinel OA + Smite Expression": oaExpr,
    "Sentinel OA": pct(pOA),
    "Smite hit rate": pct(pHit),
    "Smite crit rate": pct(pCrit),
    "Expected damage (Sentinel OA + Smite)": fxd(total.mean()),
  });
}

// --------------------------------------------------------
// 13) Eldritch Blast suite (Hex uptime via exclusive)
// --------------------------------------------------------
function eldritchBlastSuite(uptime = 0.8) {
  sep("Eldritch Blast L11 — 3 beams; beam 1 has advantage; Agonizing included");

  const beamExpr = (adv: boolean, withHex: boolean) => {
    const hit = withHex ? "(1d10 + 1d6 + 4)" : "(1d10 + 4)";
    const crit = withHex ? "(2d10 + 2d6 + 4)" : "(2d10 + 4)";
    const chk = adv ? "(d20 > d20 + 8 AC 15)" : "(d20 + 8 AC 15)";
    return `${chk} * ${hit} crit ${crit}`;
  };

  const parseBeam = (adv: boolean, withHex: boolean) =>
    parse(beamExpr(adv, withHex));

  // --- State OFF (no Hex) — keep singles, no collapse ---
  const b1_off = parseBeam(true, false); // advantage on first beam
  const b2_off = parseBeam(false, false);
  const b3_off = parseBeam(false, false);
  const stateOff = new DiceQuery([b1_off, b2_off, b3_off]); // provenance intact

  // --- State ON (Hex) — keep singles, no collapse ---
  const b1_on = parseBeam(true, true);
  const b2_on = parseBeam(false, true);
  const b3_on = parseBeam(false, true);
  const stateOn = new DiceQuery([b1_on, b2_on, b3_on]); // provenance intact

  // --- Per-state metrics (do these BEFORE any mixing) ---
  const dprOff = stateOff.mean();
  const dprOn = stateOn.mean();

  const dprUptime = uptime * dprOn + (1 - uptime) * dprOff;
  const dprUptimeDist = new DiceQuery([
    PMF.withProbability(stateOn.combined, uptime),
    PMF.withProbability(stateOff.combined, 1 - uptime),
  ]);
  console.table({
    "DPR (no Hex)": fxd(dprOff),
    "DPR (with Hex)": fxd(dprOn),
    "P(any beam hits) no Hex": pct(stateOff.probAtLeastOne(["hit", "crit"])),
    "P(any beam hits) with Hex": pct(stateOn.probAtLeastOne(["hit", "crit"])),
    "DPR with Hex (dist)": fxd(dprUptimeDist.mean()),
    "DPR with Hex (analytic)": fxd(dprUptime),
  });

  // --- Advantage delta (uses OFF state singles) ---
  sep("Advantage impact on first beam only (no Hex)");
  const b1_noAdv_off = parseBeam(false, false);
  const withoutAdvOff = new DiceQuery([b1_noAdv_off, b2_off, b3_off]);
  const withAdvOff = stateOff;
  console.table({
    "With advantage on beam 1": fxd(withAdvOff.mean()),
    "Without advantage": fxd(withoutAdvOff.mean()),
    "Advantage adds": `${fxd(withAdvOff.mean() - withoutAdvOff.mean())} DPR`,
  });

  // This was done carefully to ensure we maintain provenance for any future queries.
  // If we just needed DPR it could haef been simpler.
  return { stateOff, stateOn, dprOff, dprOn, dprUptime };
}

// --------------------------------------------------------
// 14) Cantrip comparison at level 11
// --------------------------------------------------------
function cantripComparison() {
  sep("Cantrip comparison L11. AC 15 and DC 16, enemy Dex save +5");
  const fireBolt = "(d20 + 8 AC 15) * (2d10) crit (4d10)";
  const sacredFlame = "(d20 + 6 DC 16) * (2d8)";
  const fbQ = makeQuery(fireBolt);
  const sfQ = makeQuery(sacredFlame);
  console.table({
    "Fire Bolt DPR": fxd(fbQ.mean()),
    "Sacred Flame DPR": fxd(sfQ.mean()),
  });

  sep("Evoker Potent Cantrip with Mind Sliver");
  const potent = "(d20 + 6 DC 15) * (2d6) pc (2d6)";
  const pfQ = makeQuery(potent);
  console.table({
    "Firebolt with Potent Cantrip": fxd(pfQ.mean()),
    "Half damage case probability": pct(pfQ.probAtLeastOne("pc")),
  });
}

// --------------------------------------------------------
// 15) Searing Smite: simple two-round sketch (exclusive gate)
// --------------------------------------------------------
function searingSmiteSketch() {
  sep("Searing Smite round 1 hit plus potential ongoing start-of-turn fire");
  const r1Expr = "(d20 + 8 AC 16) * (1d8 + 4 + 1d6) crit (1d8 + 1d6)";
  const r1 = makeQuery(r1Expr);

  // Ongoing 1d6 at start of target's turn gated by a save fail
  const saveExpr = "(d20 + 2 DC 16)";
  const pFail = probAtLeastOne(saveExpr, "saveFail");
  const ongoing = PMF.withProbability(parse("1d6"), pFail);

  const twoRound = new DiceQuery([r1.combined, ongoing]);
  console.table({
    Expression: r1Expr,
    "Save expression": saveExpr,
    "Save fail rate": pct(pFail),
    "Ongoing DPR": fxd(ongoing.mean()),
    "Two round DPR": fxd(twoRound.mean()),
  });
}

// --------------------------------------------------------
// 16) Ice Knife (primary attack + AoE saves for 4)
// --------------------------------------------------------
function iceKnifeFiveTargetsExample() {
  sep(
    "Ice Knife. One attack vs AC. Explosion forces 5 Dex saves (primary + 4 nearby)"
  );

  const spellAttackBonus = 7;
  const targetAC = 15;
  const spellSaveDC = 15;

  const dexMods = [+2, +3, +1, +5, 0];

  const attack = parse(
    `(d20 + ${spellAttackBonus} AC ${targetAC}) * (1d10) crit (2d10)`
  );
  const attackQ = new DiceQuery([attack]);

  const savePrimary = parse(`(d20 + ${dexMods[0]} DC ${spellSaveDC}) * (2d6)`);
  const saveE = dexMods
    .slice(1)
    .map((m) => parse(`(d20 + ${m} DC ${spellSaveDC}) * (2d6)`));

  const primarySaveQ = new DiceQuery([savePrimary]);
  const aoeFourQ = new DiceQuery(saveE);

  const full = new DiceQuery([attack, savePrimary, ...saveE]);

  const pAttackSuccess = attackQ.probAtLeastOne(["hit", "crit"]);
  const pAttackCrit = attackQ.probAtLeastOne("crit");
  const pPrimaryFails = primarySaveQ.probAtLeastOne("saveFail");
  const pAnyExplosion4 = aoeFourQ.probAtLeastOne("saveFail");
  const pPrimaryDamaged = 1 - (1 - pAttackSuccess) * (1 - pPrimaryFails);

  const ePrimaryPierce = attackQ.mean();
  const ePrimaryCold = primarySaveQ.mean();
  const eNearby = saveE.reduce((s, pmf) => s + new DiceQuery([pmf]).mean(), 0);

  console.table({
    "Primary attack hit rate (incl crit)": pct(pAttackSuccess),
    "Primary attack crit rate": pct(pAttackCrit),
    "Primary fails Dex save": pct(pPrimaryFails),
    "Any of the 4 nearby fails": pct(pAnyExplosion4),
    "Primary takes any damage (pierce or cold)": pct(pPrimaryDamaged),
    "Total expected damage to all targets": fxd(full.mean()),
    "Std dev": fxd(full.stddev()),
    "25th/50th/75th percentiles": full
      .percentiles([0.25, 0.5, 0.75])
      .join(", "),
    "Piercing DPR against target": fxd(ePrimaryPierce),
    "Cold DPR against target": fxd(ePrimaryCold),
    "AoE Cold DPR (4 nearby enemies)": fxd(eNearby),
  });
}

// --------------------------------------------------------
// 17) Exact once-per-turn Sneak (two swings, doubles on crit)
// --------------------------------------------------------
function exactOncePerTurnSneakAttack() {
  sep("Exact Once-Per-Turn Sneak (two identical swings, 3d6/6d6)");
  const attackExpr = "(d20 > d20 + 9 AC 18) * (1d8 + 5) crit (2d8 + 5)";
  const sneak = PMF.zero(); // TODO use firstSuccessSplitFromPMFs
  const total = new DiceQuery([parse(attackExpr), parse(attackExpr), sneak]);
  console.table({
    Expression: attackExpr,
    "SA exact DPR (doubles on crit)": fxd(total.mean()),
  });
}

// --------------------------------------------------------
// 18) Smite only on crit (once), two attacks (simple)
// --------------------------------------------------------
function smiteOnlyOnCritExample() {
  sep("Smite only on crit (once across two attacks)");
  const attackExpr = "(d20 + 8 AC 18) * (1d8 + 5) crit (1d8)";
  const smiteExpr = "4d8";
  const a1 = parse(attackExpr);
  const a2 = parse(attackExpr);

  // Inclusion–exclusion for “any crit across the two” (approx for once/any crit)
  const pCrit1 = a1.query().probAtLeastOne("crit");
  const pCrit2 = a2.query().probAtLeastOne("crit");
  const pAnyCrit = pCrit1 + pCrit2 - pCrit1 * pCrit2;

  // base DPR without smite
  const baseDPR = a1.query().mean() + a2.query().mean();

  const smiteOnce = PMF.withProbability(parse(smiteExpr), pAnyCrit);
  const total = new DiceQuery([a1, a2, smiteOnce]);

  // Now calculate smite on any hit
  const pAnyHit = a1.query().probAtLeastOne(["hit", "crit"]);
  const smiteOnHit = PMF.withProbability(parse(smiteExpr), pAnyHit);
  const totalOnHit = new DiceQuery([a1, a2, smiteOnHit]);

  console.table({
    "Base DPR without smite": fxd(baseDPR),
    "DPR. Smite only on crit": fxd(total.mean()),
    "DPR. Smite on any hit": fxd(totalOnHit.mean()),
  });
}

// --------------------------------------------------------
// 19) Full Round Simulation Example (approx weights, exclusive smite)
// --------------------------------------------------------
function roundDefinition(
  baseAttacks: string[],
  oncePerTurnRider: string, // "3d6"
  oaExpr: string, // attack expression
  oaChance: number
): DiceQuery {
  const basePMFs = baseAttacks.map(parse);
  const baseQ = new DiceQuery(basePMFs);

  const pAnyHit = baseQ.probAtLeastOne(["hit", "crit"]);
  const pAnyCrit = baseQ.probAtLeastOne(["crit"]);
  const pCritFirstApprox = pAnyCrit; // simple approx
  const pHitFirstApprox = Math.max(0, pAnyHit - pAnyCrit);

  const riderBase = parse(oncePerTurnRider);
  const riderCrit = riderBase.convolve(riderBase); // “double” dice

  const smite = PMF.exclusive(
    [
      [riderCrit, pCritFirstApprox],
      [riderBase, pHitFirstApprox],
    ],
    TEST_EPS
  );

  const oa = PMF.withProbability(parse(oaExpr), oaChance);

  return new DiceQuery([...basePMFs, smite, oa]);
}

export function fullRoundSimulationExample() {
  const attacks = [
    "(d20 + 8 AC 16) * (2d8 + 1d6 + 4) crit (4d8 + 2d6 + 4)",
    "(d20 + 8 AC 16) * (1d8 + 4)       crit (2d8 + 4)",
  ];
  const smiteDamage = "3d6";
  const oaExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const oaChance = 0.25;

  const q = roundDefinition(attacks, smiteDamage, oaExpr, oaChance);

  console.table({
    "Full Round Simulation Example": fxd(q.mean()),
    "Std Dev": fxd(q.stddev()),
    Min: fxd(q.min()),
    Max: fxd(q.max()),
    Percentiles: q.percentiles([0.25, 0.5, 0.75]).join(", "),
    "Total Mass": fxd(q.totalMass()),
  });

  return q;
}

/** E[min(S, X)] for X ~ Binomial(n, p). */
function expectedTruncatedBinomial(n: number, p: number, S: number): number {
  // E[min(S, X)] = sum_{k=0}^{n} min(S, k) * C(n,k) p^k (1-p)^(n-k)
  let out = 0;
  for (let k = 0; k <= n; k++) {
    const comb = binom(n, k);
    out += Math.min(S, k) * comb * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return out;
}

function binom(n: number, k: number): number {
  n = Math.floor(n);
  k = Math.floor(k);
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let num = 1,
    den = 1;
  for (let i = 1; i <= k; i++) {
    num *= n - (k - i);
    den *= i;
  }
  return num / den;
}

export function paladinNovaL4() {
  const attackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const turns = 4;
  const slots = 3;
  const smiteHitDice = "2d8";
  const smiteCritDice = "4d8";

  // Per-attack probabilities (hit includes crit)
  const pH = probAtLeastOne(attackExpr, ["hit", "crit"]);
  const pC = probAtLeastOne(attackExpr, "crit");

  // Weapon-only average damage per attack
  const evWeaponOne = makeQuery(attackExpr).mean();

  // Expected smites consumed across the window (first S hits over N turns)
  const expSmites = expectedTruncatedBinomial(turns, pH, slots);

  // Average smite damage when you do smite (accounts for crits)
  const pCritGivenHit = pH > 0 ? pC / pH : 0;
  const smiteHitEV = makeQuery(smiteHitDice).mean(); // e.g. 2d8
  const smiteCritEV = makeQuery(smiteCritDice).mean(); // e.g. 4d8
  const evSmitePerSmitedHit =
    (1 - pCritGivenHit) * smiteHitEV + pCritGivenHit * smiteCritEV;

  // Totals over the window
  const evWeaponTotal = turns * evWeaponOne;
  const evSmiteTotal = expSmites * evSmitePerSmitedHit;
  const evTotal = evWeaponTotal + evSmiteTotal;

  console.table({
    "Turns (rounds)": turns,
    "Spell slots available (1st-level)": slots,
    "Chance to hit (incl. crits)": pct(pH),
    "Chance to crit": pct(pC),

    "Avg damage per attack (weapon only)": fxd(evWeaponOne),
    "Expected smites consumed": fxd(expSmites),
    "Avg smite damage when used": fxd(evSmitePerSmitedHit),

    "Total weapon damage (4 turns)": fxd(evWeaponTotal),
    "Total smite damage (4 turns)": fxd(evSmiteTotal),
    "Total damage (4 turns)": fxd(evTotal),
    "Average DPR": fxd(evTotal / turns),
  });
}

// =====================================================================
// PART 2 — Level 5 Paladin Nova: 2 attacks/turn for 4 turns
// One smite per turn if EITHER attack hits. Use the highest-level slots
// you want (pass dice); slots total across the 4-turn window is up to you.
// =====================================================================

export function paladinNovaL5() {
  const attackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const turns = 4;
  const slots = 2;
  const smiteHitDice = "3d8";
  const smiteCritDice = "6d8";

  const atk = parse(attackExpr);

  // Per-attack probabilities
  const pH = new DiceQuery([atk]).probAtLeastOne(["hit", "crit"]);
  const pC = new DiceQuery([atk]).probAtLeastOne("crit");

  // Per-turn (two attacks) probabilities
  const two = new DiceQuery([atk, atk]);
  const pAnyHit = two.probAtLeastOne(["hit", "crit"]); // 1 - (1 - pH)^2
  const pAnyCrit = two.probAtLeastOne("crit"); // 1 - (1 - pC)^2

  // Weapon-only average damage per turn (two attacks)
  const evWeaponPerTurn = new DiceQuery([atk, atk]).mean();

  // If any hit that turn, you smite; if any crit, smite a crit
  const pCritGivenAnyHit = pAnyHit > 0 ? pAnyCrit / pAnyHit : 0;
  const smiteHitEV = makeQuery(smiteHitDice).mean(); // e.g. 3d8
  const smiteCritEV = makeQuery(smiteCritDice).mean(); // e.g. 6d8
  const evSmitePerTurnGivenTrigger =
    (1 - pCritGivenAnyHit) * smiteHitEV + pCritGivenAnyHit * smiteCritEV;

  // Expected number of turns you actually smite (capped by slots)
  const expSmitingTurns = expectedTruncatedBinomial(turns, pAnyHit, slots);

  // Totals over the window
  const evWeaponTotal = turns * evWeaponPerTurn;
  const evSmiteTotal = expSmitingTurns * evSmitePerTurnGivenTrigger;
  const evTotal = evWeaponTotal + evSmiteTotal;

  console.table({
    Turns: turns,
    "Spell slots usable (highest-level)": slots,

    "Chance to hit (per attack)": pct(pH),
    "Chance to crit (per attack)": pct(pC),
    "Chance at least one hit (per turn)": pct(pAnyHit),
    "Chance at least one crit (per turn)": pct(pAnyCrit),

    "Avg damage per turn (2 attacks, no smite)": fxd(evWeaponPerTurn),
    "Expected turns you'll smite": fxd(expSmitingTurns),
    "Avg smite damage when it triggers": fxd(evSmitePerTurnGivenTrigger),

    "Total weapon damage (4 turns)": fxd(evWeaponTotal),
    "Total smite damage (4 turns)": fxd(evSmiteTotal),
    "Total damage (4 turns)": fxd(evTotal),
    "Average damage per round (DPR)": fxd(evTotal / turns),
  });
}

// =====================================================================
// PART 2 — Level 5 Paladin Nova (Tiered Slots): 2 attacks/turn for 4 turns
// - Smite if EITHER attack hits in a turn
// - Prefer a crit (if any) for the smite that turn
// - Spend 2nd-level slots first; when those are gone, spend 1st-level slots
// =====================================================================
export function paladinNovaL5_TieredSlots() {
  const turns = 4;
  const slots2 = 2; // 2nd-level slots
  const slots1 = 3; // 1st-level slots

  const attackExpr = "(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)";
  const smite1_hit = "2d8",
    smite1_crit = "4d8";
  const smite2_hit = "3d8",
    smite2_crit = "6d8";

  // --- per-attack & per-turn probabilities ---
  const atk = parse(attackExpr);
  const pH = atk.query().probAtLeastOne(["hit", "crit"]);
  const pC = atk.query().probAtLeastOne("crit");

  const two = new DiceQuery([atk, atk]);
  const pAnyHit = two.probAtLeastOne(["hit", "crit"]); // 1 - (1-pH)^2
  const pAnyCrit = two.probAtLeastOne("crit"); // 1 - (1-pC)^2

  // --- weapon EV per turn (two attacks, no smite) ---
  const evWeaponPerTurn = new DiceQuery([atk, atk]).mean();

  // --- smite choice within a triggering turn (prefer crit if any) ---
  const pCritGivenAnyHit = pAnyHit > 0 ? pAnyCrit / pAnyHit : 0;

  // EV of smite payloads (by slot & condition)
  const evSmite1_hit = makeQuery(smite1_hit).mean(); // e.g. 2d8
  const evSmite1_crit = makeQuery(smite1_crit).mean(); // e.g. 4d8
  const evSmite2_hit = makeQuery(smite2_hit).mean(); // e.g. 3d8
  const evSmite2_crit = makeQuery(smite2_crit).mean(); // e.g. 6d8

  // EV of “the smite used this turn” by slot level, conditioned on “this turn has any hit”
  const evSmitePerTurn_lvl1 =
    (1 - pCritGivenAnyHit) * evSmite1_hit + pCritGivenAnyHit * evSmite1_crit;

  const evSmitePerTurn_lvl2 =
    (1 - pCritGivenAnyHit) * evSmite2_hit + pCritGivenAnyHit * evSmite2_crit;

  // --- how many turns actually need smites? X ~ Binomial(turns, pAnyHit) ---
  // Use 2nd-level first, then 1st-level.
  const E_min_S2 = expectedTruncatedBinomial(turns, pAnyHit, slots2);
  const E_min_Ssum = expectedTruncatedBinomial(turns, pAnyHit, slots2 + slots1);

  const expTurnsSmiteLvl2 = E_min_S2; // expected # consuming 2nd-level
  const expTurnsSmiteLvl1 = Math.max(0, E_min_Ssum - E_min_S2); // expected # consuming 1st-level

  // --- totals over window ---
  const evWeaponTotal = turns * evWeaponPerTurn;
  const evSmiteTotal =
    expTurnsSmiteLvl2 * evSmitePerTurn_lvl2 +
    expTurnsSmiteLvl1 * evSmitePerTurn_lvl1;

  const evTotal = evWeaponTotal + evSmiteTotal;

  console.table({
    Turns: turns,
    "2nd-level slots": slots2,
    "1st-level slots": slots1,

    "Hit chance (per attack)": pct(pH),
    "Crit chance (per attack)": pct(pC),
    "P(at least one hit per turn)": pct(pAnyHit),
    "P(at least one crit per turn)": pct(pAnyCrit),

    "Avg weapon damage per turn (no smite)": fxd(evWeaponPerTurn),
    "Expected turns smiting with 2nd-level": fxd(expTurnsSmiteLvl2),
    "Expected turns smiting with 1st-level": fxd(expTurnsSmiteLvl1),

    "Avg 2nd-level smite dmg when used": fxd(evSmitePerTurn_lvl2),
    "Avg 1st-level smite dmg when used": fxd(evSmitePerTurn_lvl1),

    "Total weapon damage (4 turns)": fxd(evWeaponTotal),
    "Total smite damage (4 turns)": fxd(evSmiteTotal),
    "Total damage (4 turns)": fxd(evTotal),
    "Average damage per round (DPR)": fxd(evTotal / turns),
  });
}

// --------------------------------------------------------
// Run all demos
// --------------------------------------------------------
function runAll() {
  basicAttack();
  fireball();
  critShare();
  fighterMultiAttack();
  statsBlock();
  halflingLuck();
  weaponComparison();
  holdPersonExample();
  opportunityAttackScaling();
  elvenAccuracy();
  greatWeaponMaster();
  sentinelSmite();
  eldritchBlastSuite();
  cantripComparison();
  searingSmiteSketch();
  iceKnifeFiveTargetsExample();
  exactOncePerTurnSneakAttack();
  smiteOnlyOnCritExample();
  fullRoundSimulationExample();
  paladinNovaL4();
  paladinNovaL5();
  paladinNovaL5_TieredSlots();
}

runAll();
