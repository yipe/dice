import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { d10, d20, d4, d6, d8, roll } from "../src/builder/factory";
import { turn } from "../src/turn";
import { PMF } from "../src/pmf/pmf";
import { DiceQuery } from "../src/pmf/query";
import { onAnyHit, onCritOnly } from "../src/common/types";
import type { StepOutcome } from "../src/turn/state";

const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const daggerPMF = dagger.pmf;

const SLICES: Record<StepOutcome, PMF> = {
  hit: daggerPMF.filterOutcome("hit"),
  crit: daggerPMF.filterOutcome("crit"),
  miss: daggerPMF.filterOutcome("missNone"),
};

const OUTCOMES: StepOutcome[] = ["hit", "crit", "miss"];

/**
 * Independent oracle: enumerate every outcome sequence for `n` identical attacks
 * and let the caller add rider damage for that sequence. Shares no code with the
 * Turn DP beyond `filterOutcome`.
 */
function bruteForce(
  n: number,
  riderFor: (sequence: StepOutcome[]) => PMF[]
): PMF {
  const branches: [PMF, number][] = [];

  const walk = (sequence: StepOutcome[]): void => {
    if (sequence.length === n) {
      const parts = sequence.map((outcome) => SLICES[outcome]);
      let branch = parts.reduce((all, part) => all.convolve(part, undefined, true));
      for (const rider of riderFor(sequence)) {
        branch = branch.convolve(rider, undefined, true);
      }
      branches.push([branch.normalize(), branch.mass()]);
      return;
    }
    for (const outcome of OUTCOMES) walk([...sequence, outcome]);
  };
  walk([]);

  return PMF.exclusive(branches);
}

function expectSamePMF(actual: PMF, expected: PMF): void {
  const support = new Set([...actual.support(), ...expected.support()]);
  for (const value of support) {
    expect(actual.pAt(value)).toBeCloseTo(expected.pAt(value), 10);
  }
  expect(actual.mass()).toBeCloseTo(1, 10);
}

const sneak = roll(3, d6);
const firstLanding = (sequence: StepOutcome[]): StepOutcome | undefined =>
  sequence.find((outcome) => outcome !== "miss");

describe("Turn exactness vs brute force", () => {
  it("matches a hand-enumerated first-hit rider over two attacks", () => {
    const actual = turn([dagger, dagger]).rider({
      damage: sneak,
      on: "first-hit",
    }).pmf;

    const expected = bruteForce(2, (sequence) => {
      const first = firstLanding(sequence);
      if (!first) return [];
      return [first === "crit" ? sneak.doubleDice().pmf : sneak.pmf];
    });

    expectSamePMF(actual, expected);
  });

  it("matches over three attacks with two riders sharing one trigger", () => {
    const actual = turn([dagger, dagger, dagger])
      .rider({ damage: sneak, on: "first-hit" })
      .rider({ damage: d10, on: "first-hit" }).pmf;

    const expected = bruteForce(3, (sequence) => {
      const first = firstLanding(sequence);
      if (!first) return [];
      const crit = first === "crit";
      return [
        crit ? sneak.doubleDice().pmf : sneak.pmf,
        crit ? d10.doubleDice().pmf : d10.pmf,
      ];
    });

    expectSamePMF(actual, expected);
  });

  it("matches any-crit plus its not-fired complement", () => {
    const smite = roll(2, d8);
    const unarmed = d20.plus(8).ac(16).onHit(d6.plus(4));

    const actual = turn([dagger, dagger])
      .rider({ id: "smite", damage: smite, on: "any-crit" })
      .rider({ damage: [unarmed, unarmed], on: "not-fired", of: "smite" }).pmf;

    const flurry = unarmed.pmf.convolve(unarmed.pmf);
    const expected = bruteForce(2, (sequence) =>
      sequence.includes("crit") ? [smite.doubleDice().pmf] : [flurry]
    );

    expectSamePMF(actual, expected);
  });

  it("matches any-miss (the reroll gate)", () => {
    const actual = turn([dagger, dagger]).rider({
      damage: dagger,
      on: "any-miss",
    }).pmf;

    const expected = bruteForce(2, (sequence) =>
      sequence.includes("miss") ? [daggerPMF] : []
    );

    expectSamePMF(actual, expected);
  });

  it("matches every-hit (once per landing attack)", () => {
    const mark = d6;

    const actual = turn([dagger, dagger]).rider({
      damage: mark,
      on: "every-hit",
    }).pmf;

    const expected = bruteForce(2, (sequence) =>
      sequence
        .filter((outcome) => outcome !== "miss")
        .map((outcome) =>
          outcome === "crit" ? mark.doubleDice().pmf : mark.pmf
        )
    );

    expectSamePMF(actual, expected);
  });
});

describe("Turn vs the independent-convolution pattern", () => {
  it("keeps the mean but fixes the distribution", () => {
    const exact = turn([dagger, dagger]).rider({
      damage: sneak,
      on: "first-hit",
    });

    const attacks = new DiceQuery([daggerPMF, daggerPMF]);
    const [pHit, pCrit] = attacks.firstSuccessSplit(onAnyHit, onCritOnly);
    const independent = new DiceQuery([
      daggerPMF,
      daggerPMF,
      PMF.exclusive([
        [sneak.pmf, pHit],
        [sneak.doubleDice().pmf, pCrit],
      ]),
    ]);

    expect(exact.mean()).toBeCloseTo(independent.mean(), 10);
    expect(exact.mean()).toBeCloseTo(18.6225, 4);

    // The old pattern under-reports whiff turns by 8x and the spread by 19%.
    expect(exact.pmf.pAt(0)).toBeCloseTo(0.1225, 10);
    expect(independent.combined.pAt(0)).toBeCloseTo(0.01500625, 10);
    expect(exact.pmf.stdev()).toBeCloseTo(8.886, 3);
    expect(independent.stddev()).toBeCloseTo(7.1825, 3);
  });
});

describe("Turn probabilities", () => {
  it("fires any-crit on P(>=1 crit), not P(first success was a crit)", () => {
    const smite = roll(2, d8);
    const built = turn([dagger, dagger]).rider({
      id: "smite",
      damage: smite,
      on: "any-crit",
    });

    const attacks = new DiceQuery([daggerPMF, daggerPMF]);
    const pAnyCrit = attacks.probAtLeastOne(onCritOnly);
    const [, pFirstCrit] = attacks.firstSuccessSplit(onAnyHit, onCritOnly);

    expect(built.fireProbability("smite")).toBeCloseTo(pAnyCrit, 10);
    expect(pAnyCrit).toBeCloseTo(0.0975, 6);
    expect(pFirstCrit).toBeCloseTo(0.0675, 6);

    const riderMean = built.mean() - attacks.mean();
    expect(riderMean).toBeCloseTo(pAnyCrit * smite.doubleDice().pmf.mean(), 8);
  });

  it("makes smite and its not-fired complement mutually exclusive", () => {
    const smite = roll(2, d8);
    const built = turn([dagger, dagger])
      .rider({ id: "smite", damage: smite, on: "any-crit" })
      .rider({ id: "flurry", damage: d6, on: "not-fired", of: "smite" });

    const pSmite = built.fireProbability("smite");
    const pFlurry = built.fireProbability("flurry");

    expect(pSmite + pFlurry).toBeCloseTo(1, 10);
  });

  it("reports P(at least one hit) for an every-hit rider", () => {
    const built = turn([dagger, dagger]).rider({
      id: "mark",
      damage: d6,
      on: "every-hit",
    });

    const pAnyHit = new DiceQuery([daggerPMF, daggerPMF]).probAtLeastOne(onAnyHit);
    expect(built.fireProbability("mark")).toBeCloseTo(pAnyHit, 10);
  });

  it("applies an every-hit rider once per landing attack, not once per turn", () => {
    const attacks = new DiceQuery([daggerPMF, daggerPMF]);
    const perHit = turn([dagger, dagger]).rider({ damage: d6, on: "every-hit" });
    const once = turn([dagger, dagger]).rider({ damage: d6, on: "first-hit" });

    // Per attack: P(hit) * E[d6] + P(crit) * E[2d6] = 0.6*3.5 + 0.05*7 = 2.45.
    expect(perHit.mean() - attacks.mean()).toBeCloseTo(2 * 2.45, 8);

    // Once per turn: P(first is a plain hit) * E[d6] + P(first is a crit) * E[2d6].
    const [pHit, pCrit] = attacks.firstSuccessSplit(onAnyHit, onCritOnly);
    expect(once.mean() - attacks.mean()).toBeCloseTo(pHit * 3.5 + pCrit * 7, 8);

    // Two attacks land often enough that "every hit" is only ~1.5x "once", not 2x.
    expect((perHit.mean() - attacks.mean()) / (once.mean() - attacks.mean())).toBeCloseTo(
      1.4815,
      3
    );
  });
});

describe("Turn with no riders", () => {
  it("equals a plain convolution of the attacks", () => {
    const actual = turn([dagger, dagger, dagger]).pmf;
    const expected = PMF.convolveMany([daggerPMF, daggerPMF, daggerPMF]);
    expectSamePMF(actual, expected.normalize());
  });

  it("exposes the declared attacks as query singles", () => {
    const query = turn([dagger, dagger]).query();
    expect(query.singles).toHaveLength(2);
    expect(query.mean()).toBeCloseTo(new DiceQuery([daggerPMF, daggerPMF]).mean(), 10);
  });
});
