import { createHash } from "node:crypto";
import type { PMF } from "../../src/pmf/pmf";
import { d, d20, d4, d6, d8, roll } from "../../src/builder/factory";
import "../../src/builder/dc";
import type { DCBuilder } from "../../src/builder/dc";
import type { RollBuilder } from "../../src/builder/roll";
import type { SaveBuilder } from "../../src/builder/save";

/**
 * The saves whose numbers `save-half-golden.json` pins bit for bit: every check shape (plain, advantage,
 * disadvantage, halfling reroll, bonus die, certain success, certain failure) crossed with every payload
 * shape (a plain pool, a flat bonus, a parsed string, a zero-able and a negative payload, a rerolled die, a
 * scaled pool, a max of two, a keep), each read under `saveHalf()` and under the plain save.
 */
export const CHECKS: Record<string, () => DCBuilder> = {
  "d20+5 DC15": () => d20.plus(5).dc(15),
  "d20+7 adv DC15": () => d20.plus(7).withAdvantage().dc(15),
  "d20+3 dis DC14": () => d20.plus(3).withDisadvantage().dc(14),
  "hd20+2 DC12": () => d20.reroll(1).plus(2).dc(12),
  "d20+2+d4 DC12": () => d20.plus(2).plus(d4).dc(12),
  "d20 DC10": () => d20.dc(10),
  "certain success": () => d20.plus(30).dc(10),
  "certain failure": () => d20.dc(30),
};

export const PAYLOADS: Record<string, () => RollBuilder> = {
  "8d6": () => roll(8, d6),
  "3d6+4": () => roll(3, d6).plus(4),
  '"8d6" parsed': () => d("8d6"),
  "1d6-1": () => roll(1, d6).minus(1),
  "2d6-3": () => roll(2, d6).minus(3),
  "2d8 reroll 1": () => roll(2, d8.reroll(1)),
  "4d6 doubled dice": () => roll(4, d6).scaleDice(2),
  "d8 max d6": () => d8.maxOf(d6),
  "4d6 keep 3": () => d6.keepHighest(4, 3),
  "7": () => roll.flat(7),
};

const EPSILONS = [undefined, 0, 1e-6] as const;

const view = new DataView(new ArrayBuffer(8));

/** A double as its 16 hex digits, so two values are equal here only if every bit is. */
export function bits(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

function labelBits(map: object | undefined): unknown {
  if (map === undefined) return null;
  return Object.entries(map)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, value]) => [label, bits(value as number)]);
}

/** Every bin of a PMF, in support order: value, `p`, per-label `count` and `attr`, all as bit strings. */
export function pmfBits(pmf: PMF): unknown {
  return [...pmf]
    .sort(([a], [b]) => a - b)
    .map(([value, bin]) => [value, bits(bin.p), labelBits(bin.count), labelBits(bin.attr)]);
}

/** Everything a consumer reads off a save, at every eps: the resolution's five fields, `toPMF()` and the expression. */
function signature(save: SaveBuilder): Record<string, unknown> {
  const out: Record<string, unknown> = { expression: save.toExpression() };
  for (const eps of EPSILONS) {
    const res = save.resolve(eps);
    out[`resolve(${eps})`] = {
      pmf: pmfBits(res.pmf),
      check: pmfBits(res.check),
      saveFail: pmfBits(res.saveFail),
      saveSuccess: pmfBits(res.saveSuccess),
      weights: [bits(res.weights.success), bits(res.weights.fail)],
    };
    out[`toPMF(${eps})`] = pmfBits(save.toPMF(eps));
  }
  return out;
}

/** A SHA-256 over {@link signature}: equal only if every bit of every bin of every PMF is. */
export function digest(save: SaveBuilder): string {
  return createHash("sha256").update(JSON.stringify(signature(save))).digest("hex");
}

export interface SaveCase {
  name: string;
  build: (kind: "half" | "normal") => SaveBuilder;
}

export function saveCases(): SaveCase[] {
  const cases: SaveCase[] = [];
  for (const [checkName, check] of Object.entries(CHECKS)) {
    for (const [payloadName, payload] of Object.entries(PAYLOADS)) {
      cases.push({
        name: `${checkName} * (${payloadName})`,
        build: (kind) => {
          const save = check().onSaveFailure(payload());
          return kind === "half" ? save.saveHalf() : save;
        },
      });
    }
  }
  return cases;
}
