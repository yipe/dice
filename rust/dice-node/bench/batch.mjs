// Batch API benchmark: per-call loops vs `Turn.evaluateMany` (ADR-018).
//
//   bash rust/dice-node/build.sh                       # builds dice.node
//   npx tsx rust/dice-node/bench/batch.mjs             # from the repo root; N in {100, 1000}, AC 10..30
//   npx tsx rust/dice-node/bench/batch.mjs --n=100 --acs=5 --reps=3
//   npx tsx rust/dice-node/bench/batch.mjs --only=dpr  # just the dpr-shaped tables
//
// Variants, each reading mean, pmf, marginal("attack 1"), stepStats("attack 1"), fireProbability("sneak"),
// expectedApplications("sneak") of every turn at every AC of the sweep:
//   a. TS engine (`src/`), one call per reader (`turn.vsAC(ac).mean()`, ...)
//   b. Rust facade, one call per reader
//   c. Rust `Turn.evaluateMany`, `parallel: false` (one crossing, one thread)
//   d. Rust `Turn.evaluateMany`, parallel (rayon)
// Timings are the whole read, building the turns excluded. "cold" is the first run (Rust caches
// cleared before it); "warm" the median of the rest (global PMF caches full, per-turn caches cold).
// Every run's answers are compared bit for bit (Object.is on numbers) against variant a's.
import { performance } from "node:perf_hooks";

import * as tsFactory from "../../../src/builder/factory.ts";
import * as tsEffects from "../../../src/turn/effects.ts";
import * as tsTurn from "../../../src/turn/turn.ts";
import * as rsFactory from "../ts/builder/factory.ts";
import * as rsEffects from "../ts/turn/effects.ts";
import * as rsTurn from "../ts/turn/turn.ts";
import { native } from "../ts/native.ts";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const SIZES = arg("n", 0) ? [arg("n", 0)] : [100, 1000];
const AC_COUNT = arg("acs", 21);
const REPS = arg("reps", 4);
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const ACS = Array.from({ length: AC_COUNT }, (_, i) => 10 + Math.round((i * 20) / Math.max(1, AC_COUNT - 1)));

/** N realistic turns from one engine's builders; every turn has attack 1 and the rider "sneak". */
function makeTurns(n, { d20, d4, d6, d8, d10, roll, turn, advantage }) {
  const turns = [];
  for (let i = 0; i < n; i++) {
    const bonus = 5 + (i % 8);
    const die = [d6, d8, d10][i % 3];
    const blade = d20.plus(bonus).ac(16).onHit(die.plus(3 + (i % 4)));
    const off = d20.plus(bonus - 1).ac(16).onHit(d6.plus(2));
    const sneak = roll(1 + (i % 4), d6);
    switch (i % 5) {
      case 0: // two attacks + sneak attack
        turns.push(turn([blade, blade]).onFirstHit(sneak, { id: "sneak" }));
        break;
      case 1: // vex chain
        turns.push(turn().attacks(3, blade).onEveryHit(advantage().untilNextAttack(), { id: "vex" }).onFirstHit(sneak, { id: "sneak" }));
        break;
      case 2: // multi-attack, crit smite, capped every-hit rider
        turns
          .push(
            turn().attacks(4, blade).onAnyCrit(roll(2, d8), { id: "smite" }).onEveryHit(d4, { max: 2, id: "capped" }).onFirstHit(sneak, { id: "sneak" })
          );
        break;
      case 3: // attack + save-half breath
        turns.push(
          turn([blade, d20.plus(5).dc(13 + (i % 5)).ability("dex").onSaveFailure(roll(4, d6)).saveHalf()]).onFirstHit(sneak, { id: "sneak", of: ["attack 1"] })
        );
        break;
      default: // three attacks, start-of-turn advantage, off-hand
        turns.push(turn([blade, off, blade]).atStart(advantage()).onFirstHit(sneak, { id: "sneak" }));
    }
  }
  return turns;
}

const ts = { ...tsFactory, ...tsEffects, turn: tsTurn.turn };
const rs = { ...rsFactory, ...rsEffects, turn: rsTurn.turn };
const Turn = rsTurn.Turn;

/** One reading, raw: what the reader calls answered (compared after the clock stops, see `canon`). */
function readOne(t) {
  return {
    mean: t.mean(),
    pmf: t.pmf,
    marginal: t.marginal("attack 1"),
    step: t.stepStats("attack 1"),
    fire: t.fireProbability("sneak"),
    expected: t.expectedApplications("sneak"),
  };
}

const canonMarginal = (m) => ({ pmf: m.pmf.fingerprint(), whenHappens: m.whenHappens.fingerprint(), occurs: m.occurs, rollType: m.rollType, landings: m.landings && [...m.landings], anyLanding: m.anyLanding });
const canon = (r) => ({ ...r, pmf: r.pmf.fingerprint(), marginal: canonMarginal(r.marginal) });

const perCall = (turns) => turns.map((t) => ACS.map((ac) => readOne(t.vsAC(ac))));

const REQUEST = { mean: true, pmf: true, marginals: ["attack 1"], stepStats: ["attack 1"], fireProbability: ["sneak"], expectedApplications: ["sneak"], acs: ACS };
function batched(parallel) {
  return (turns) =>
    Turn.evaluateMany(turns, { ...REQUEST, parallel }).map((o) => {
      if (!o.ok) throw o.error;
      return o.readings.map((r) => ({
        mean: r.mean,
        pmf: r.pmf,
        marginal: r.marginals.get("attack 1"),
        step: r.stepStats.get("attack 1"),
        fire: r.fireProbability.get("sneak"),
        expected: r.expectedApplications.get("sneak"),
      }));
    });
}

/** Text of a result that tells -0 from 0 and keeps every digit. */
const text = (value) => JSON.stringify(value, (_k, v) => (typeof v === "number" ? (Object.is(v, -0) ? "-0" : Number.isNaN(v) ? "NaN" : String(v)) : v));

function clearRustCaches() {
  for (const name of ["pmf", "parse", "builder", "singleDie", "d20Lift", "roll", "attack", "missRerolled", "dc", "save"]) native.clearCache(name);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function measure({ label, api, read, rust }, n) {
  let cold;
  const warm = [];
  let answers;
  for (let rep = 0; rep < REPS; rep++) {
    if (rep === 0 && rust) clearRustCaches();
    const turns = makeTurns(n, api);
    const start = performance.now();
    const out = read(turns);
    const ms = performance.now() - start;
    if (rep === 0) {
      cold = ms;
      answers = text(out.map((cells) => cells.map(canon)));
    } else {
      warm.push(ms);
    }
  }
  return { label, n, cold, warm: warm.length ? median(warm) : cold, answers };
}

const variants = [
  { label: "a. TS engine, per call", api: ts, read: perCall, rust: false },
  { label: "b. Rust facade, per call", api: rs, read: perCall, rust: true },
  { label: "c. Rust evaluateMany, serial", api: rs, read: batched(false), rust: true },
  { label: "d. Rust evaluateMany, parallel", api: rs, read: batched(true), rust: true },
];

console.log(`node ${process.version}, ${ACS.length} ACs (${ACS[0]}..${ACS.at(-1)}), reps=${REPS}\n`);
let allEqual = true;
const rows = [];
for (const n of ONLY === "dpr" ? [] : SIZES) {
  const results = variants.map((v) => measure(v, n));
  const [a, ...rest] = results;
  for (const r of results) {
    const equal = r.answers === a.answers;
    allEqual &&= equal;
    rows.push({
      "variant": r.label,
      "N": n,
      "cold ms": Number(r.cold.toFixed(1)),
      "warm ms": Number(r.warm.toFixed(1)),
      "warm x vs a": Number((a.warm / r.warm).toFixed(2)),
      "equal to a": equal ? "yes" : "NO",
    });
  }
  void rest;
}
console.table(rows);

// dpr's shape (packages/ddb/src/turn/evaluate/evaluateGroup.ts `priceTurn`): one `Turn.from(spec)` per
// (group, AC) with the AC baked into the rows, then every marginal, every attack's stepStats and
// peakStates (landings only when a group asks for patterns). Rows are native builders ("native") or hand-written `{ rowCheck, under }` sources
// as dpr passes them ("callbacks": JS-bound, so `evaluateMany` reads them serially on the JS thread).
function dprSpecs(n, { d20, d6, d8 }, callbacks) {
  const rows = (ac) => {
    const hit = d20.plus(8).ac(ac).onHit(d8.plus(4));
    const off = d20.plus(8).ac(ac).onHit(d6.plus(2));
    return [{ source: hit }, { source: hit }, { source: off, chance: 0.6 }, { source: hit, chance: 0.5 }, { source: off }];
  };
  const wrap = (row) => {
    if (!callbacks) return row;
    const b = row.source;
    return { ...row, source: { rowCheck: b.rowCheck, under: (context) => b.under(context) } };
  };
  return Array.from({ length: n }, (_, i) => ({ attacks: rows(ACS[i % ACS.length]).map((row, k) => ({ id: `r${k}`, ...wrap(row) })) }));
}
const readDpr = (t) => {
  const marginals = new Map();
  const stepStats = new Map();
  for (const id of t.attackIds) {
    marginals.set(id, t.marginal(id));
    stepStats.set(id, t.stepStats(id));
  }
  return { marginals, stepStats, peak: t.peakStates };
};
const canonDpr = (r) => ({
  marginals: [...r.marginals].map(([id, m]) => [id, canonMarginal(m)]),
  stepStats: [...r.stepStats],
  peak: r.peak,
});
const DPR_REQUEST = { allMarginals: true, allStepStats: true, peakStates: true };
const dprBatched = (parallel) => (turns) =>
  Turn.evaluateMany(turns, { ...DPR_REQUEST, parallel }).map((o) => {
    if (!o.ok) throw o.error;
    const [r] = o.readings;
    return { marginals: r.marginals, stepStats: r.stepStats, peak: r.peakStates };
  });

function measureDpr({ label, from, specs, read, rust }, n) {
  let cold;
  const warm = [];
  let answers;
  for (let rep = 0; rep < REPS; rep++) {
    if (rep === 0 && rust) clearRustCaches();
    const turns = specs(n).map((spec) => from(spec));
    const start = performance.now();
    const out = read(turns);
    const ms = performance.now() - start;
    if (rep === 0) {
      cold = ms;
      answers = text(out.map(canonDpr));
    } else warm.push(ms);
  }
  return { label, n, cold, warm: warm.length ? median(warm) : cold, answers };
}

for (const callbacks of [false, true]) {
  const dprRows = [];
  for (const n of SIZES) {
    const tsFrom = (spec) => tsTurn.Turn.from(spec);
    const rsFrom = (spec) => Turn.from(spec);
    const perCallDpr = (turns) => turns.map(readDpr);
    const vs = [
      { label: "a. TS engine, per call", from: tsFrom, specs: (m) => dprSpecs(m, ts, callbacks), read: perCallDpr, rust: false },
      { label: "b. Rust facade, per call", from: rsFrom, specs: (m) => dprSpecs(m, rs, callbacks), read: perCallDpr, rust: true },
      { label: "c. Rust evaluateMany, serial", from: rsFrom, specs: (m) => dprSpecs(m, rs, callbacks), read: dprBatched(false), rust: true },
      { label: "d. Rust evaluateMany, parallel", from: rsFrom, specs: (m) => dprSpecs(m, rs, callbacks), read: dprBatched(true), rust: true },
    ].map((v) => measureDpr(v, n));
    for (const r of vs) {
      const equal = r.answers === vs[0].answers;
      allEqual &&= equal;
      dprRows.push({ variant: r.label, N: n, "cold ms": Number(r.cold.toFixed(1)), "warm ms": Number(r.warm.toFixed(1)), "warm x vs a": Number((vs[0].warm / r.warm).toFixed(2)), "equal to a": equal ? "yes" : "NO" });
    }
  }
  console.log(`\ndpr-shaped: Turn.from(spec) per (group, AC), all marginals + stepStats + peakStates (landings only on demand, left out); rows are ${callbacks ? "JS callbacks" : "native builders"}`);
  console.table(dprRows);
}

// An error comes back per turn, as the error the single reader throws.
{
  const good = makeTurns(1, rs)[0];
  const bad = rs.turn([rs.d20.plus(5).ac(16).onHit(rs.d8)]);
  let thrown;
  try {
    bad.fireProbability("sneak");
  } catch (e) {
    thrown = e;
  }
  const [okOutcome, badOutcome] = Turn.evaluateMany([good, bad], { fireProbability: ["sneak"] });
  const same = okOutcome.ok && !badOutcome.ok && badOutcome.error.constructor === thrown.constructor && badOutcome.error.message === thrown.message && badOutcome.error.code === thrown.code;
  console.log(`per-turn errors match the single reader's: ${same ? "yes" : "NO"} (${thrown.constructor.name}: ${thrown.code ?? ""})`);
  allEqual &&= same;
}

console.log(`\nall-equal check (b-d bit-identical to a): ${allEqual ? "PASS" : "FAIL"}`);
process.exit(allEqual ? 0 : 1);
