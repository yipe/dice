/**
 * The D&D 5e rules the generic turn contract leaves out: what each condition does to a row,
 * a target's saves by ability, and the chance a target loses a contest.
 */
import type { AbilityName } from "../builder/types";
import type { ConditionEffect } from "../turn/effects";
import { condition } from "../turn/effects";
import type { ConditionRule, GrantSaveSpec } from "../turn/types";

export type { AbilityName, ConditionEffect, ConditionRule, GrantSaveSpec };

const proneRule: ConditionRule = { attack: { melee: ["advantage"], ranged: ["disadvantage"] } };

/**
 * Each condition as data. Unconscious that ends on damage leaves the creature Prone for the rest of the turn (`onEnd`).
 *
 * The `melee`/`ranged` keys stand for the rules' distance test: `melee` is an attack from within 5 feet of the
 * target, `ranged` one from farther away. A row declares which with `melee()` or `ranged()`; a reach attack made
 * from 10 feet is `ranged()` here (no advantage against a Prone target, no automatic crit against a Paralyzed one).
 */
export const RULES: Readonly<
  Record<"blinded" | "paralyzed" | "prone" | "restrained" | "stunned" | "unconscious", ConditionRule>
> = {
  blinded: { attack: { melee: ["advantage"], ranged: ["advantage"] } },
  paralyzed: {
    attack: { melee: ["advantage", "critOnHit"], ranged: ["advantage"] },
    save: { strength: ["autoFail"], dexterity: ["autoFail"] },
  },
  prone: proneRule,
  restrained: { attack: { melee: ["advantage"], ranged: ["advantage"] }, save: { dexterity: ["saveDisadvantage"] } },
  stunned: {
    attack: { melee: ["advantage"], ranged: ["advantage"] },
    save: { strength: ["autoFail"], dexterity: ["autoFail"] },
  },
  unconscious: {
    // An unconscious creature drops prone: a ranged attack's advantage and prone's disadvantage cancel.
    attack: { melee: ["advantage", "critOnHit"], ranged: ["advantage", "disadvantage"] },
    save: { strength: ["autoFail"], dexterity: ["autoFail"] },
    onEnd: { condition: "prone", rule: proneRule },
  },
};

/** Blinded, as {@link RULES} has it: `blinded().untilEndOfTurn()`. */
export function blinded(): ConditionEffect {
  return condition("blinded", RULES.blinded);
}

/** Paralyzed, as {@link RULES} has it. */
export function paralyzed(): ConditionEffect {
  return condition("paralyzed", RULES.paralyzed);
}

/** Prone, as {@link RULES} has it. */
export function prone(): ConditionEffect {
  return condition("prone", RULES.prone);
}

/** Restrained, as {@link RULES} has it. */
export function restrained(): ConditionEffect {
  return condition("restrained", RULES.restrained);
}

/** Stunned, as {@link RULES} has it. */
export function stunned(): ConditionEffect {
  return condition("stunned", RULES.stunned);
}

/** Unconscious, as {@link RULES} has it; `untilDamaged()` leaves the creature Prone. */
export function unconscious(): ConditionEffect {
  return condition("unconscious", RULES.unconscious);
}

/**
 * The chance the target loses a contest: a flat d20 + `defender` (the target's bonus) totals
 * lower than a flat d20 + `attacker`. A tie keeps things as they were, so it goes to the
 * defender. A contest is an ability check, not a save: nothing that changes a save changes it.
 */
export function contestLossChance({ attacker, defender }: { attacker: number; defender: number }): number {
  let lost = 0;
  for (let theirs = 1; theirs <= 20; theirs++) {
    for (let yours = 1; yours <= 20; yours++) if (theirs + defender < yours + attacker) lost++;
  }
  return lost / 400;
}

const ABILITIES = {
  str: "strength",
  dex: "dexterity",
  con: "constitution",
  int: "intelligence",
  wis: "wisdom",
  cha: "charisma",
} as const;

const FULL_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(ABILITIES).flatMap(([short, full]) => [
    [short, full],
    [full, full],
  ])
);

/**
 * A trigger's save against `dc`, by the target's save bonus per ability:
 * `saveDC(15, { con: 2 })` is `{ ability: "constitution", dc: 15, bonus: 2 }`. Several abilities
 * give a list, of which the target makes the one it passes most (`saveDC(15, { str: 5, dex: 1 })`,
 * escaping a grapple). Accepted wherever a trigger takes `save`.
 *
 * @throws {TypeError} on no ability, an unknown or repeated one, or a `dc` or bonus that is not an integer.
 */
export function saveDC(dc: number, bonuses: Partial<Record<AbilityName, number>>): GrantSaveSpec | GrantSaveSpec[] {
  if (!Number.isInteger(dc)) throw new TypeError(`saveDC: dc must be an integer, got ${dc}.`);
  const saves = Object.entries(bonuses).map(([key, bonus]): GrantSaveSpec => {
    const ability = FULL_NAMES.get(key);
    if (ability === undefined) throw new TypeError(`saveDC: "${key}" is not an ability.`);
    if (!Number.isInteger(bonus)) throw new TypeError(`saveDC: the ${ability} bonus must be an integer, got ${bonus}.`);
    return { ability, dc, bonus: bonus as number };
  });
  if (saves.length === 0) throw new TypeError("saveDC: name at least one ability the target saves with.");
  const repeated = saves.find((save, index) => saves.findIndex((other) => other.ability === save.ability) !== index);
  if (repeated !== undefined) throw new TypeError(`saveDC: ${repeated.ability} is named twice.`);
  return saves.length === 1 ? saves[0] : saves;
}
