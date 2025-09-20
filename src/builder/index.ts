import type { PMF } from "../";
import { LRUCache } from "../";
import { RollBuilder } from "./roll";

export { ACBuilder } from "./ac";
export { DCBuilder } from "./dc";
export { RollBuilder } from "./roll";

export type { RollConfig } from "./types";

const rollFn = (
  count: number,
  sidesOrDie?: number | RollBuilder,
  modifier?: number
): RollBuilder => {
  if (sidesOrDie instanceof RollBuilder) {
    // roll(2, d6, 5)
    // Create a new config, using the base die's config but overriding the count
    const subRollConfigs = sidesOrDie.getSubRollConfigs();
    if (subRollConfigs.length === 0) return new RollBuilder(0).plus(modifier);

    const absCount = Math.abs(count);

    const newConfigs = subRollConfigs.map((config) => ({
      ...config,
      count: config.count * absCount,
      modifier: config.modifier * absCount,
    }));

    let resultBuilder = new RollBuilder(newConfigs);

    if (count < 0) {
      const negatedConfigs = resultBuilder
        .getSubRollConfigs()
        .map((c) => ({ ...c, isSubtraction: !c.isSubtraction }));
      resultBuilder = new RollBuilder(negatedConfigs);
    }

    return resultBuilder.plus(modifier);
  } else {
    // roll(2, 6, 5)
    let builder = new RollBuilder(count);
    if (sidesOrDie && sidesOrDie > 0) {
      builder = builder.d(sidesOrDie);
    }
    return builder.plus(modifier);
  }
};

rollFn.d = (sides: number): RollBuilder => new RollBuilder(1).d(sides);
rollFn.hd20 = (): RollBuilder => new RollBuilder(1).d20().reroll(1);
rollFn.d4 = (): RollBuilder => new RollBuilder(1).d4();
rollFn.d6 = (): RollBuilder => new RollBuilder(1).d6();
rollFn.d8 = (): RollBuilder => new RollBuilder(1).d8();
rollFn.d10 = (): RollBuilder => new RollBuilder(1).d10();
rollFn.d12 = (): RollBuilder => new RollBuilder(1).d12();
rollFn.d20 = (): RollBuilder => new RollBuilder(1).d20();
rollFn.d100 = (): RollBuilder => new RollBuilder(1).d100();
rollFn.flat = (n: number): RollBuilder => new RollBuilder(0).plus(n);

export type RollFactory = {
  (count: number, sides?: number, modifier?: number): RollBuilder;
  (count: number, die: RollBuilder, modifier?: number): RollBuilder; // The new signature
  d(sides: number): RollBuilder;
  hd20(): RollBuilder;
  d4(): RollBuilder;
  d6(): RollBuilder;
  d8(): RollBuilder;
  d10(): RollBuilder;
  d12(): RollBuilder;
  d20(): RollBuilder;
  d100(): RollBuilder;
  flat(n: number): RollBuilder;
};

export function d(sides: number) {
  return new RollBuilder(1).d(sides);
}

export const d4 = new RollBuilder(1).d4();
export const d6 = new RollBuilder(1).d6();
export const d8 = new RollBuilder(1).d8();
export const d10 = new RollBuilder(1).d10();
export const d12 = new RollBuilder(1).d12();
export const d20 = new RollBuilder(1).d20();
export const hd20 = new RollBuilder(1).d20().reroll(1);
export const d100 = new RollBuilder(1).d100();
export const flat = (n: number) => new RollBuilder(0).plus(n);

export const roll: RollFactory = rollFn as RollFactory;

export const builderPMFCache = new LRUCache<string, PMF>(1000);
