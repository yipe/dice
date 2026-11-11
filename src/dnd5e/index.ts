/**
 * The D&D 5e rules the generic turn contract leaves out: what each condition does to a row,
 * a target's saves by ability, the chance a target loses a contest, and the features built from them.
 */
import type { AbilityName } from "../builder/types";
import type { ConditionEffect, Grant, SaveGated, TriggerSave } from "../turn/effects";
import { advantage, condition, save } from "../turn/effects";
import type { ConditionRule, GrantSaveSpec } from "../turn/types";

export type { AbilityName, ConditionEffect, ConditionRule, GrantSaveSpec };

const proneRule: ConditionRule = {
  attack: { melee: ["advantage"], ranged: ["disadvantage"] },
  own: { attack: ["disadvantage"] },
};

/** The rulebook edition a condition's text is read from. */
export type Edition = "2014" | "2024";

/** The SRD conditions {@link RULES}, {@link grappledRule} and {@link exhaustionRule} cover. */
export type ConditionName =
  | "blinded"
  | "charmed"
  | "deafened"
  | "exhaustion"
  | "frightened"
  | "grappled"
  | "incapacitated"
  | "invisible"
  | "paralyzed"
  | "petrified"
  | "poisoned"
  | "prone"
  | "restrained"
  | "stunned"
  | "unconscious";

/**
 * Each condition as data (PHB and XPHB agree unless noted). Unconscious that ends on damage leaves the creature Prone
 * for the rest of the turn (`onEnd`). Grappled and Exhaustion differ by edition: see {@link grappledRule} and
 * {@link exhaustionRule}.
 *
 * The `melee`/`ranged` keys stand for the rules' distance test: `melee` is an attack from within 5 feet of the
 * target, `ranged` one from farther away. A row declares which with `melee()` or `ranged()`; a reach attack made
 * from 10 feet is `ranged()` here (no advantage against a Prone target, no automatic crit against a Paralyzed one).
 *
 * `own` is the creature's own attack rolls and ability checks: no row of a turn is one, so a turn never reads it.
 */
export const RULES: Readonly<Record<Exclude<ConditionName, "grappled" | "exhaustion">, ConditionRule>> = {
  /** "Attack rolls against you have Advantage, and your attack rolls have Disadvantage." */
  blinded: { attack: { melee: ["advantage"], ranged: ["advantage"] }, own: { attack: ["disadvantage"] } },
  /** "You can't attack the charmer …": no roll modifier. */
  charmed: {},
  /** "You can't hear …": no roll modifier. */
  deafened: {},
  /** "You have Disadvantage on ability checks and attack rolls while the source of fear is within line of sight." */
  frightened: { own: { attack: ["disadvantage"], check: ["disadvantage"] } },
  /** "You can't take any action, Bonus Action, or Reaction.": no roll modifier. */
  incapacitated: {},
  /** "Attack rolls against you have Disadvantage, and your attack rolls have Advantage." (at any range) */
  invisible: {
    attack: { melee: ["disadvantage"], ranged: ["disadvantage"] },
    own: { attack: ["advantage"] },
  },
  paralyzed: {
    attack: { melee: ["advantage", "critOnHit"], ranged: ["advantage"] },
    save: { strength: ["autoFail"], dexterity: ["autoFail"] },
  },
  /**
   * "Attack rolls against you have Advantage … You automatically fail Strength and Dexterity saving throws."
   * Not modelled: "You have Resistance to all damage." A rule changes rolls, not the damage scale.
   */
  petrified: {
    attack: { melee: ["advantage"], ranged: ["advantage"] },
    save: { strength: ["autoFail"], dexterity: ["autoFail"] },
  },
  /** "You have Disadvantage on attack rolls and ability checks." */
  poisoned: { own: { attack: ["disadvantage"], check: ["disadvantage"] } },
  /** "You have Disadvantage on attack rolls." */
  prone: proneRule,
  /** "… your attack rolls have Disadvantage" */
  restrained: {
    attack: { melee: ["advantage"], ranged: ["advantage"] },
    save: { dexterity: ["saveDisadvantage"] },
    own: { attack: ["disadvantage"] },
  },
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

/**
 * Grappled. 2014: "speed becomes 0", which is no roll modifier (`{}`). 2024: "You have Disadvantage on attack rolls
 * against any target other than the grappler." A turn never reads `own`, so it is data for consumers.
 */
export function grappledRule(edition: Edition): ConditionRule {
  return edition === "2014" ? {} : { own: { attack: ["disadvantage"] } };
}

const SAVE_ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"] as const;

/**
 * Exhaustion at `level` (1 to 6).
 *
 * - 2014 (cumulative table): level 1 and up, "Disadvantage on ability checks"; level 3 and up, "Disadvantage on
 *   attack rolls and saving throws".
 * - 2024: "When you make a D20 Test, the roll is reduced by 2 times your Exhaustion level" (`d20Penalty`).
 *
 * Speed, hit point maximum and death (levels 2, 4, 5, 6) are not roll effects and are not modelled.
 */
export function exhaustionRule(level: number, edition: Edition): ConditionRule {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new RangeError(`exhaustion level must be an integer from 1 to 6, got ${level}`);
  }
  if (edition === "2024") return { d20Penalty: 2 * level };
  if (level < 3) return { own: { check: ["disadvantage"] } };
  return {
    own: { attack: ["disadvantage"], check: ["disadvantage"] },
    save: Object.fromEntries(SAVE_ABILITIES.map((a) => [a, ["saveDisadvantage"] as const])),
  };
}

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

/** Charmed, as {@link RULES} has it. */
export function charmed(): ConditionEffect {
  return condition("charmed", RULES.charmed);
}

/** Deafened, as {@link RULES} has it. */
export function deafened(): ConditionEffect {
  return condition("deafened", RULES.deafened);
}

/** Frightened, as {@link RULES} has it. */
export function frightened(): ConditionEffect {
  return condition("frightened", RULES.frightened);
}

/** Incapacitated, as {@link RULES} has it. */
export function incapacitated(): ConditionEffect {
  return condition("incapacitated", RULES.incapacitated);
}

/** Invisible, as {@link RULES} has it. */
export function invisible(): ConditionEffect {
  return condition("invisible", RULES.invisible);
}

/** Petrified, as {@link RULES} has it. */
export function petrified(): ConditionEffect {
  return condition("petrified", RULES.petrified);
}

/** Poisoned, as {@link RULES} has it. */
export function poisoned(): ConditionEffect {
  return condition("poisoned", RULES.poisoned);
}

/** Grappled for `edition`: `condition("grappled", grappledRule(edition))`. */
export function grappled(edition: Edition): ConditionEffect {
  return condition("grappled", grappledRule(edition));
}

/** Exhaustion at `level` for `edition`: `condition("exhaustion", exhaustionRule(level, edition))`. */
export function exhaustion(level: number, edition: Edition): ConditionEffect {
  return condition("exhaustion", exhaustionRule(level, edition));
}

/**
 * The tags these rules name, for `AttackBuilder.tagged()` and a trigger's `of`. Tags are free-form:
 * this is the expected vocabulary, not a limit. `monk-weapon` is a simple melee weapon, or a martial
 * melee weapon with the Light property.
 *
 * ```ts
 * const fist = d20.plus(7).ac(15).onHit(d8.plus(4)).tagged("unarmed");
 * ```
 */
export const TAGS = [
  "weapon",
  "unarmed",
  "spell",
  "cantrip",
  "simple",
  "martial",
  "melee-weapon",
  "ranged-weapon",
  "monk-weapon",
  "ammunition",
  "finesse",
  "heavy",
  "light",
  "loading",
  "reach",
  "thrown",
  "two-handed",
  "versatile",
] as const;

/** One of {@link TAGS}. */
export type Tag = (typeof TAGS)[number];

/**
 * Vex (2024 weapon mastery): a hit gives advantage on your next attack roll.
 * `sword.onEveryHit(vex())` is `sword.onEveryHit(advantage().untilNextAttack())`.
 */
export function vex(): Grant {
  return advantage().untilNextAttack();
}

/**
 * Stunning Strike (2024 Monk), once per turn: the target saves against `check`; a failure leaves it
 * Stunned for the rest of the turn, a pass still gives the next attack advantage.
 *
 * ```ts
 * turn([fist, fist]).onFirstHit(stunningStrike(saveDC(14, { con: +3 })), { of: "unarmed" });
 * // is
 * turn([fist, fist]).onFirstHit(
 *   save(saveDC(14, { con: +3 }), { fail: stunned().untilEndOfTurn(), pass: advantage().untilNextAttack() }),
 *   { of: "unarmed" }
 * );
 * ```
 */
export function stunningStrike(check: TriggerSave | readonly TriggerSave[]): SaveGated {
  return save(check, { fail: stunned().untilEndOfTurn(), pass: advantage().untilNextAttack() });
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
