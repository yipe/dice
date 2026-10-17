import { d20, roll } from "../../src/builder/factory";
import { advantage, condition, keepBestDamage, vulnerability } from "../../src/turn/effects";
import { turn, type Turn } from "../../src/turn/turn";
import type { ConditionRule } from "../../src/turn/types";

const sword = d20.plus(5).ac(15).onHit(roll(1, 8, 3));
const dagger = d20.plus(5).ac(15).critOn(19).onHit(roll(1, 4, 3));
/** The trap this fixture names is the auto-crit, so the rule carries it (5e's stunned does not; paralyzed does). */
const stunnedRule: ConditionRule = { attack: { melee: ["advantage", "critOnHit"], ranged: ["advantage"] } };

/** The fixture turns every sampler conformance test runs: one per semantic trap the audit names. */
export const FIXTURES: Record<string, () => Turn> = {
  "two attacks + sneak attack": () =>
    turn([
      { source: sword, id: "a" },
      { source: dagger, id: "b" },
    ]).onFirstHit(roll(3, 6), { id: "sneak" }),
  "advantage grant until next attack": () =>
    turn([
      { source: sword.onEveryHit(advantage().untilNextAttack()), id: "a" },
      { source: sword, id: "b" },
    ]),
  "any-miss reroll (GWM-like)": () =>
    turn([
      { source: sword, id: "a" },
      { source: sword, id: "b" },
    ]).onAnyMiss(sword, { id: "reroll" }),
  "save with half and a rider on fail": () =>
    turn([{ source: d20.plus(3).dc(15).onSaveFailure(roll(8, 6)).saveHalf(), id: "fb" }]).onFirstHit(
      roll(2, 6),
      { id: "rider", landing: "fail" }
    ),
  "chance and after gates": () =>
    turn([
      { source: sword, id: "a", chance: 0.6 },
      { source: sword, id: "b", after: { of: "a", landing: "hit" } },
    ]),
  "happens coin on a damage rider": () =>
    turn([{ source: sword, id: "a" }]).onFirstHit(roll(1, 6), { id: "hex", happens: 0.7 }),
  "every-hit capped": () =>
    turn([
      { source: sword, id: "a" },
      { source: sword, id: "b" },
      { source: sword, id: "c" },
    ]).onEveryHit(roll(1, 6), { id: "hunter", max: 2 }),
  "substitute reroll-keep-higher": () =>
    turn([
      { source: sword, id: "a" },
      { source: sword, id: "b" },
    ]).onFirstHit(keepBestDamage(), { id: "sub" }),
  "dice-match bounce": () =>
    turn([{ source: d20.plus(7).ac(15).onHit(roll(3, 8)), id: "orb" }]).onDiceMatch(
      ["orb"],
      d20.plus(7).ac(15).onHit(roll(3, 8)),
      { id: "leap" }
    ),
  "rerollUpTo + explode pool payload": () =>
    turn([
      {
        source: d20
          .plus(6)
          .ac(14)
          .onHit(roll(3, 6).rerollUpTo(2))
          .plusSeparateDamage(roll(2, 6).explodePool(2)),
        id: "a",
      },
    ]),
  "vulnerability until next hit": () =>
    turn([
      { source: sword.onEveryHit(vulnerability().untilNextHit()), id: "a" },
      { source: sword, id: "b" },
    ]),
  "stunned condition (auto-crit on later melee)": () =>
    turn([
      { source: sword.onEveryHit(condition("stunned", stunnedRule).untilEndOfTurn()), id: "a" },
      { source: sword.melee(), id: "b" },
    ]),
};

/** Builders with a `.sample`: the draw-order snapshot runs over these before Turn.sample exists. A5a lands with the
 *  roll entries only (it dev-starts on A1, before A3); A3 appends the attack and save entries when it merges. */
export const BUILDER_FIXTURES = {
  "roll 3d8 reroll 1 minimum 2 plus 2": roll(3, 8).reroll(1).minimum(2).plus(2),
  "rerollUpTo savage": roll(2, 6).rerollUpTo(1, { rolls: 2 }),
};
