/**
 * 0.17 turn budgets. Each shape is measured twice: every marginal reader (`marginal(id)` for
 * all ids) and the joint `pmf`. Budget: the 12-row 21-AC marginal sweep ≤ 16 ms (2× the engine's 4-8 ms). Joint pmf:
 * reported, no budget. Run with `yarn bench`.
 */
import { bench, describe } from "vitest";
import { advantage, d20, d4, d6, d8, roll, savePenalty, turn, vulnerability, type Turn } from "../src/builder";
import { contestLossChance, prone, restrained, stunned, unconscious } from "../src/dnd5e";
import { Turn as TurnClass } from "../src/turn/index";
import { FAMILIES } from "../tests/oracle/v2/cases/index";

const ids = (t: Turn): string[] => [...t.attackIds, ...t.riderIds];
const readMarginals = (build: () => Turn): void => {
  const t = build();
  for (const id of ids(t)) t.marginal(id);
};
const refuses = (read: () => void): boolean => {
  try {
    read();
    return false;
  } catch {
    return true;
  }
};
const readPmf = (build: () => Turn): void => {
  build().pmf;
};

// (a) Condition shapes.
const sword = d20.plus(8).ac(16).onHit(d8.plus(4));
const bow = d20.plus(8).ac(16).ranged().onHit(d8.plus(4));
const fist = d20.plus(8).ac(16).onHit(d6.plus(4));
const melee = d20.plus(8).ac(16).melee().onHit(d8.plus(4));
// Prone reads range: an unranged row is refused, so the Prone shapes use `melee()` rows.
const toppling = melee.onEveryHit(prone().untilEndOfTurn(), {
  save: d20.plus(3).dc(15).ability("con"),
  optional: true,
});
const ray = d20.plus(7).ac(16).onHit(roll(2, d8)).onEveryHit(savePenalty(d4).untilNextSave(), { dealing: "cold" });
const breath = d20.plus(5).dc(15).ability("dex").onSaveFailure(roll(4, d6)).saveHalf();

const examples: Record<string, { build: () => Turn; joint: boolean }> = {
  vex: { build: () => turn([sword.onEveryHit(advantage().untilNextAttack()), sword]), joint: true },
  topple: { build: () => turn([toppling, toppling, bow]), joint: true },
  stunningStrike: {
    build: () =>
      turn([fist, fist, fist]).onFirstHit(stunned().untilEndOfTurn(), {
        id: "stun",
        save: d20.plus(2).dc(15).ability("con"),
        onSave: advantage().untilNextAttack(),
      }),
    joint: true,
  },
  grappler: {
    build: () =>
      turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), {
        save: [d20.plus(5).dc(15).ability("str"), d20.plus(1).dc(15).ability("dex")],
      }),
    joint: true,
  },
  grapple2014: {
    build: () =>
      turn([sword, sword]).onFirstHit(advantage().untilEndOfTurn(), {
        chance: contestLossChance({ attacker: 5, defender: 7 }),
      }),
    joint: true,
  },
  knockOut: {
    build: () =>
      turn([melee, melee, melee])
        .onFirstHit(roll(3, d6), { id: "sneak" })
        .onFirstHit(unconscious().untilDamaged(), { of: ["sneak"], save: d20.plus(2).dc(15).ability("con") }),
    joint: true,
  },
  // `dealing` has no joint pmf ('dealing-joint-unsupported'): marginals only. Skipped while this build refuses it.
  frostbite: { build: () => turn([ray, breath]), joint: false },
  pathToTheGrave: { build: () => turn([sword, sword]).atStart(vulnerability().untilNextHit()), joint: true },
  restrainedTwoTargets: {
    build: () => turn().attacks(2, sword).attack(sword, { target: "second" }).atStart(restrained()),
    joint: true,
  },
};

describe("condition examples", () => {
  for (const [name, { build, joint }] of Object.entries(examples)) {
    if (refuses(() => readMarginals(build))) {
      bench.skip(`${name} (refused by this build)`, () => {});
      continue;
    }
    bench(`${name} marginals`, () => readMarginals(build));
    if (joint) bench(`${name} pmf`, () => readPmf(build));
  }
});

// (b) 12 attacks, Vex every-hit advantage, once-per-turn Topple (save-gated Prone),
// a capped rider; swept over AC 10..30.
const ACS = Array.from({ length: 21 }, (_, i) => 10 + i);
const twelve = (): Turn =>
  turn()
    .attacks(12, melee)
    .onEveryHit(advantage().untilNextAttack(), { id: "vex" })
    .onFirstHit(prone().untilEndOfTurn(), { id: "topple", save: d20.plus(3).dc(15).ability("con") })
    .onEveryHit(d6, { max: 2, id: "capped" });
const base = twelve();

describe("12-row sweep (21 ACs)", () => {
  bench("12-row marginals ×21 AC [budget ≤ 16 ms]", () => {
    for (const ac of ACS) readMarginals(() => base.vsAC(ac));
  });
  bench("12-row stepStats for every id ×21 AC [budget ≤ 2× engine]", () => {
    for (const ac of ACS) {
      const t = base.vsAC(ac);
      for (const id of t.attackIds) t.stepStats(id);
    }
  });
  bench("12-row pmf ×21 AC", () => {
    for (const ac of ACS) readPmf(() => base.vsAC(ac));
  });
});

// (c) the heaviest port-ready oracle case, picked by timing marginals once.
const oracle = Object.values(FAMILIES)
  .flat()
  .filter((c) => c.engineOnly === undefined && c.gaps.length === 0)
  .map((c) => {
    const start = performance.now();
    try {
      readMarginals(() => TurnClass.from(c.spec));
    } catch {
      return { c, ms: -1 };
    }
    return { c, ms: performance.now() - start };
  })
  .reduce((a, b) => (b.ms > a.ms ? b : a));
const oracleTurn = (): Turn => TurnClass.from(oracle.c.spec);
let oracleJoint = true;
try {
  oracleTurn().pmf;
} catch {
  oracleJoint = false;
}

describe(`heaviest oracle case: ${oracle.c.name}`, () => {
  bench(`${oracle.c.name} marginals`, () => readMarginals(oracleTurn));
  if (oracleJoint) bench(`${oracle.c.name} pmf`, () => readPmf(oracleTurn));
});
