import { describe, expect, it } from "vitest";
import { d6, d8, d20, keepBestDamage, roll, turn, Turn } from "../builder";
import type { ContextualSource, RowContext } from "../builder";
import type { PMF } from "../pmf/pmf";

// Every first-hit substitute path a source without `rerolledUnder` takes, pinned bit for bit to the
// values 0.23.0 gives (captured on 0.23.0 itself). A change here means an existing caller moved.

/** A 53-bit hash (cyrb53) of `text`. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Every value's exact probability and the hit and crit masses, as one hash. */
function fingerprint(pmf: PMF): string {
  const bins = [...pmf.support()].sort((x, y) => x - y).map((value) => [value, pmf.pAt(value)]);
  return hash(JSON.stringify([bins, pmf.filterOutcome("hit").mass(), pmf.filterOutcome("crit").mass()]));
}

const sword = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3));
const channelled = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3)).plusSeparateDamage(roll(1, d6));
const pooled = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3).plus(3, d6));
/** A row rider "sa"'s dice join, with no `rerolledUnder`: keep-higher of its whole payload. */
const poolingRow: ContextualSource = {
  rowCheck: sword.rowCheck,
  under: (context: RowContext) => (context.joined.includes("sa") ? pooled : sword).under(context),
};

const SCENARIOS: Record<string, () => Turn> = {
  "keep-higher over two swords": () => turn([sword, sword]).onFirstHit(keepBestDamage()),
  "keep-higher below a threshold": () => turn([sword, sword, sword]).onFirstHit(keepBestDamage().ifBelow({ hit: 10, crit: 18 })),
  "keep-higher with a separate channel and an every-hit rider": () =>
    turn([channelled, channelled]).onEveryHit(roll(1, d6)).onFirstHit(keepBestDamage()),
  "keep-higher over a contextual row a rider joins, with a granted advantage": () =>
    Turn.from({
      attacks: [
        { id: "a", source: poolingRow },
        { id: "b", source: poolingRow },
      ],
      riders: [{ id: "sa", on: "first-hit", damage: roll(3, d6), joins: ["a", "b"] }],
      conditions: [{ id: "vex", on: "first-miss", of: ["a"], grants: [{ advantage: true, until: "next-attack" }] }],
      substitutes: [{ id: "savage", on: "first-hit", substitute: "reroll-keep-higher" }],
    }),
  "convert the first miss": () => turn([sword, sword]).convertFirstMiss().onFirstHit(roll(3, d6)),
};

/** The turn's PMF, then each attack's marginal, as `fingerprint`s from 0.23.0 (`bcc1eeb`). */
const PINNED: Record<string, string> = {
  "keep-higher over two swords": "cab874ee9180c83e 8d5b9a3888633267 28f2bce6b863db25",
  "keep-higher below a threshold": "3741ed34700d1897 6dfaf4d8e205ba27 63adea5bf8d2e984 8dc69efd3dcd0125",
  "keep-higher with a separate channel and an every-hit rider": "6592eaea2faaead8 b34917d61fbab1af 45b5f6658bb46e53",
  "keep-higher over a contextual row a rider joins, with a granted advantage":
    "a401b3e1bf95b398 290e4376fe42455e ad5e0babba2201d8",
  "convert the first miss": "db477a986adb4987 30d5aeb3d087d2db 66f7a0827cce9b38",
};

describe("first-hit substitutes without rerolledUnder are bit-identical to 0.23.0", () => {
  for (const [name, build] of Object.entries(SCENARIOS)) {
    it(name, () => {
      const t = build();
      const marginals = t.attackIds.map((id) => fingerprint(t.marginal(id).pmf));
      expect([fingerprint(t.pmf), ...marginals].join(" ")).toBe(PINNED[name]);
    });
  }
});
