import { describe, expect, it } from "vitest";
import "../src/builder/ac";
import "../src/builder/dc";
import { advantage, keepBestDamage } from "../src/builder";
import { d10, d20, d4, d6, d8, roll } from "../src/builder/factory";
import { turn } from "../src/turn";
import type { Turn } from "../src/turn";

/**
 * Every-hit riders without a cap must keep the numbers they had before `max` existed. The
 * figures below were read off 0.14.2 (the release before capped riders), and were also checked
 * against that release bit for bit over these turns' whole distributions, fire probabilities and
 * step statistics. Here they are pinned to 1e-12 so a later change to convolution order does not
 * fail this file for a reason that has nothing to do with riders.
 */
const sword = d20.plus(7).ac(15).onHit(d8.plus(4));
const dagger = d20.plus(8).ac(16).onHit(d4.plus(4));
const halves = d20.plus(5).ac(13).onHit(roll(2, d6).plus(3));
const orb = d20.plus(5).ac(17).onHit(roll(3, d8));

interface Golden {
  name: string;
  build: () => Turn;
  mean: number;
  pWhiff: number;
  fire: Record<string, number>;
}

const goldens: Golden[] = [
  {
    name: "two attacks, an every-hit d6",
    build: () => turn([sword, sword]).onEveryHit(d6),
    mean: 16.4,
    pWhiff: 0.1225,
    fire: { "rider 1": 0.8775 },
  },
  {
    name: "four attacks",
    build: () => turn().attacks(4, sword).onEveryHit(d6),
    mean: 32.8,
    pWhiff: 0.01500625,
    fire: { "rider 1": 0.98499375 },
  },
  {
    name: "two every-hit riders over three attacks",
    build: () => turn([sword, sword, sword]).onEveryHit(d6).onEveryHit(roll(2, d4), { id: "second" }),
    mean: 35.1,
    pWhiff: 0.042875,
    fire: { "rider 1": 0.957125, second: 0.957125 },
  },
  {
    name: "an attack that only happens half the time",
    build: () => turn([{ source: sword, chance: 0.5 }, sword, sword]).onEveryHit(d6),
    mean: 20.5,
    pWhiff: 0.0826875,
    fire: { "rider 1": 0.9173125 },
  },
  {
    name: "beside a once-per-turn reroll",
    build: () => turn([sword, sword, sword]).onFirstHit(keepBestDamage()).onEveryHit(d6),
    mean: 25.895483642578117,
    pWhiff: 0.042875,
    fire: { "rider 1": 0.957125, "substitute 1": 0.957125 },
  },
  {
    name: "beside a threshold reroll",
    build: () =>
      turn([halves, halves, halves]).onFirstHit(keepBestDamage().ifBelow({ hit: 10, crit: 18 })).onEveryHit(d6),
    mean: 29.65608310441979,
    pWhiff: 0.042875,
    fire: { "rider 1": 0.957125, "substitute 1": 0.8174577755421473 },
  },
  {
    name: "beside a dice-match rider",
    build: () => turn([orb, orb]).onDiceMatch(["attack 1", "attack 2"], d6).onEveryHit(d4),
    mean: 17.483159287124856,
    pWhiff: 0.3025,
    fire: { "rider 1": 0.3335804902017115, "rider 2": 0.6975 },
  },
  {
    name: "beside a granted advantage",
    build: () => turn([sword, sword, sword]).onEveryHit(advantage().untilNextAttack()).onEveryHit(d6),
    mean: 29.10289125,
    pWhiff: 0.042875,
    fire: { "rider 1": 0.957125, "condition 1": 0.8775 },
  },
  {
    name: "beside a granted crit-on-hit that sometimes takes",
    build: () =>
      turn([sword, sword, sword])
        .onEveryHit(advantage().critOnHit().untilEndOfTurn(), { chance: 0.4 })
        .onEveryHit(d6),
    mean: 31.26094,
    pWhiff: 0.042875,
    fire: { "rider 1": 0.957125, "condition 1": 0.4524 },
  },
  {
    name: "beside a first-miss reroll",
    build: () => turn([sword, sword]).onFirstMiss(sword).onEveryHit(d6),
    mean: 21.1355,
    pWhiff: 0.042875,
    fire: { "rider 1": 0.5775, "rider 2": 0.957125 },
  },
  {
    name: "the goliath: every trigger at once",
    build: () =>
      turn([dagger, dagger])
        .onFirstHit(roll(3, d6))
        .onFirstHit(d10)
        .onAnyCrit(roll(2, d8))
        .otherwise([dagger, dagger])
        .onEveryHit(d6),
    mean: 38.32675,
    pWhiff: 0.015006249999999999,
    fire: {
      "rider 1": 0.8775,
      "rider 2": 0.8775,
      "rider 3": 0.0975,
      "rider 4": 0.9025,
      "rider 5": 0.8775,
    },
  },
];

describe("uncapped every-hit riders keep their 0.14.2 numbers", () => {
  for (const golden of goldens) {
    it(golden.name, () => {
      const t = golden.build();
      expect(t.mean()).toBeCloseTo(golden.mean, 11);
      expect(t.pmf.pAt(0)).toBeCloseTo(golden.pWhiff, 12);
      for (const [id, probability] of Object.entries(golden.fire)) {
        expect(t.fireProbability(id)).toBeCloseTo(probability, 12);
      }
    });
  }
});
