/**
 * 0.16 shapes: uses only the 0.16 API, so the same file runs on 0.16 (origin/main 1485160) and now. Budget: now ≤ 1.25×
 * 0.16. Readers: joint `pmf`, `mean`, every rider's `fireProbability` (0.16 has no `marginal`).
 */
import { bench, describe } from "vitest";
import { advantage, d20, d6, d8, roll, turn, type Turn } from "../src/builder";

const sword = d20.plus(8).ac(16).onHit(d8.plus(4));
const ACS = Array.from({ length: 21 }, (_, i) => 10 + i);

const shapes: Record<string, Turn> = {
  "vex 12 + sneak + capped": turn()
    .attacks(12, sword)
    .onEveryHit(advantage().untilNextAttack(), { id: "vex" })
    .onFirstHit(roll(3, d6), { id: "sneak" })
    .onEveryHit(d6, { max: 2, id: "capped" }),
  "vex 4 + sneak": turn().attacks(4, sword).onEveryHit(advantage().untilNextAttack()).onFirstHit(roll(3, d6), { id: "sneak" }),
};

describe("0.16 shapes ×21 AC", () => {
  for (const [name, base] of Object.entries(shapes)) {
    bench(`${name} pmf+mean+fire`, () => {
      for (const ac of ACS) {
        const t = base.vsAC(ac);
        t.pmf;
        t.mean();
        for (const id of t.riderIds) t.fireProbability(id);
      }
    });
  }
});
