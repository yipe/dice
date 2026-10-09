/**
 * Standalone scenario benchmark. Prints per-scenario median wall time and a content fingerprint of
 * the result, so a performance change can be checked bit-for-bit: run before and after and diff the
 * fingerprint column. Run with `yarn bench:scenarios [repeats]`.
 *
 * Each scenario clears the library caches first, so timings are cold-cache: what a fresh page
 * load (or a new AC sweep) pays, not what the LRU hands back on the second call.
 */
import { setCachingEnabled } from "../src/common/lru-cache";
import { PMF } from "../src/pmf/pmf";
import { parse } from "../src/parser/parser";
import { d20, d4, d6, d8, d10, d12, hd20, roll } from "../src/builder/factory";
import "../src/builder/ac";
import "../src/builder/dc";
import { turn } from "../src/turn";
import { advantage, savePenalty, vulnerability } from "../src/turn/effects";
import { prone, stunned } from "../src/dnd5e";

const REPEATS = Number(process.argv[2] ?? 7);
if (!Number.isInteger(REPEATS) || REPEATS < 1) throw new Error(`repeats must be a positive integer, got ${process.argv[2]}`);

const sword = d20.plus(8).ac(16).onHit(d8.plus(4));
const melee = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
const fist = d20.plus(8).ac(16).onHit(d6.plus(4));
const ray = d20.plus(7).ac(16).onHit(roll(2, d8)).typed("cold").onEveryHit(savePenalty(d4).untilNextSave(), { dealing: "cold" });
const breath = d20.plus(5).dc(15).ability("dex").onSaveFailure(roll(4, d6)).saveHalf();

const scenarios: Record<string, () => PMF | PMF[]> = {
  "parse: simple attack": () => parse("(d20 + 8 AC 16) * (1d8 + 4) crit (2d8 + 4)"),
  "parse: adv + reroll + min": () => parse("(d20 > d20 + 8 AC 16) * (2(d6 reroll d2) + 4) crit (4(d6 reroll d2) + 4)"),
  "parse: big pool 20d6": () => parse("(d20 + 10 AC 18) * (20d6 + 5) crit (40d6 + 5)"),
  "parse: keep + miss": () => parse("(d20 + 5 AC 15) * (4kh3d6 + 3 > d6 + 2) xcrit19 (8kh6d6 + 2) miss (4)"),
  "parse: save half": () => parse("(d20 + 2 DC 15) * (8d6) save half"),
  "builder: attack flat": () => sword.toPMF(),
  "builder: attack advantage": () => d20.withAdvantage().plus(8).ac(16).onHit(d8.plus(4)).toPMF(),
  "builder: elven accuracy crit19": () => d20.withElvenAccuracy().plus(8).ac(16).critOn(19).onHit(d8.plus(4)).toPMF(),
  "builder: halfling luck": () => hd20.plus(8).ac(16).onHit(d8.plus(4)).toPMF(),
  "builder: reroll pool": () => d20.plus(8).ac(16).onHit(roll(2, d6).reroll(2).plus(4)).toPMF(),
  "builder: explode pool": () => d20.plus(8).ac(16).onHit(roll(3, d6).explode(2).plus(4)).toPMF(),
  "builder: save half": () => d20.plus(2).dc(15).onSaveFailure(roll(8, d6)).saveHalf().toPMF(),
  "builder: AC sweep 10..30": () => Array.from({ length: 21 }, (_, i) => d20.plus(8).ac(10 + i).onHit(d8.plus(4)).toPMF()),
  "pmf: convolve 8x d8+4 attacks": () => PMF.convolveMany(Array.from({ length: 8 }, () => sword.toPMF())),
  "pmf: power(12) of attack": () => sword.toPMF().power(12),
  "pmf: 20d6 via power": () => parse("1d6").power(20),
  "query: stats on 4-attack combined": () => {
    const q = PMF.convolveMany(Array.from({ length: 4 }, () => sword.toPMF())).query();
    q.mean();
    q.variance();
    q.percentiles([0.25, 0.5, 0.75, 0.95]);
    q.probTotalAtLeast(20);
    q.damageAttributionChartModel();
    return q.combined;
  },
  "turn: rogue sneak attack (2 attacks)": () => turn([sword, sword]).onFirstHit(roll(3, d6)).pmf,
  "turn: fighter 4 attacks + hunter's mark": () => turn().attacks(4, sword).onEveryHit(d6).pmf,
  "turn: 8 attacks + GWM + smite on crit": () =>
    turn()
      .attacks(8, sword)
      .onAnyCrit(roll(2, d8), { id: "smite" })
      .onFirstHit(d10, { id: "bonus" }).pmf,
  "turn: vex chain 3 attacks": () => turn().attacks(3, sword.onEveryHit(advantage().untilNextAttack())).pmf,
  "turn: stunning strike 3 fists": () =>
    turn([fist, fist, fist]).onFirstHit(stunned().untilEndOfTurn(), {
      id: "stun",
      save: d20.plus(2).dc(15).ability("con"),
      onSave: advantage().untilNextAttack(),
    }).pmf,
  "turn: topple (save-gated prone)": () =>
    turn().attacks(4, melee).onFirstHit(prone().untilEndOfTurn(), {
      id: "topple",
      save: d20.plus(3).dc(15).ability("con"),
    }).pmf,
  "turn: frostbite ray + breath (marginals)": () => {
    const t = turn([ray, breath]);
    return [...t.attackIds, ...t.riderIds].map((id) => t.marginal(id).pmf);
  },
  "turn: path to the grave": () => turn([sword, sword]).atStart(vulnerability().untilNextHit()).pmf,
  "turn: 12 attacks, vex + topple + capped rider (joint)": () =>
    turn()
      .attacks(12, melee)
      .onEveryHit(advantage().untilNextAttack(), { id: "vex" })
      .onFirstHit(prone().untilEndOfTurn(), { id: "topple", save: d20.plus(3).dc(15).ability("con") })
      .onEveryHit(d6, { max: 2, id: "capped" }).pmf,
  "turn: 12 attacks AC sweep (marginals)": () => {
    const out: PMF[] = [];
    for (let ac = 10; ac <= 30; ac++) {
      const t = turn()
        .attacks(12, d20.plus(8).ac(ac).melee().onHit(d8.plus(4)))
        .onEveryHit(advantage().untilNextAttack(), { id: "vex" })
        .onFirstHit(prone().untilEndOfTurn(), { id: "topple", save: d20.plus(3).dc(15).ability("con") })
        .onEveryHit(d6, { max: 2, id: "capped" });
      for (const id of [...t.attackIds, ...t.riderIds]) out.push(t.marginal(id).pmf);
    }
    return out;
  },
  "turn: paladin 2 attacks d12 + smite + otherwise flurry": () =>
    turn([d20.plus(8).ac(16).onHit(d12.plus(5)), d20.plus(8).ac(16).onHit(d12.plus(5))])
      .onAnyCrit(roll(4, d8), { id: "smite" })
      .otherwise([fist, fist], { id: "flurry" })
      .onEveryHit(d6).pmf,
};

/** Length and hash of the results' content fingerprints: equal across runs iff every bit is. */
function fingerprint(result: PMF | PMF[]): string {
  const text = (Array.isArray(result) ? result : [result]).map((p) => p.fingerprint()).join("|");
  return `${text.length.toString(36)}:${hash(text)}`;
}

function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function clearCaches(): void {
  // Bumping the caching generation empties every library cache (parse, PMF, builder, attack, save, ...).
  setCachingEnabled(false);
  setCachingEnabled(true);
}

const rows: Array<[string, number, string]> = [];
let total = 0;
for (const [name, run] of Object.entries(scenarios)) {
  clearCaches();
  const fp = fingerprint(run());
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    clearCaches();
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
  total += median;
  rows.push([name, median, fp]);
}

const width = Math.max(...rows.map(([n]) => n.length));
for (const [name, ms, fp] of rows) {
  console.log(`${name.padEnd(width)}  ${ms.toFixed(2).padStart(9)} ms  ${fp}`);
}
console.log(`${"TOTAL (sum of medians)".padEnd(width)}  ${total.toFixed(2).padStart(9)} ms`);
