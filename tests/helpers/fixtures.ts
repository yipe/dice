import { d4, d6, d8, d20, roll } from "../../src/builder/factory";
import { paralyzed } from "../../src/dnd5e/index";
import { advantage, keepBestDamage, savePenalty, vulnerability } from "../../src/turn/effects";
import type { Rng } from "../../src/common/rng";
import { Turn, turn } from "../../src/turn/turn";
import type { ContextualPayload, ContextualSource, RowCheck, RowContext } from "../../src/turn/types";

const sword = d20.plus(5).ac(15).onHit(roll(1, 8, 3));
const dagger = d20.plus(5).ac(15).critOn(19).onHit(roll(1, 4, 3));

const check: RowCheck = {
  kind: "attack",
  rollType: "flat",
  advantageDice: 2,
  pinned: false,
  autoHit: false,
  autoCrit: false,
  autoFail: false,
};
/** The sword with rider "sa"'s 3d6 in its own roll. */
const pooled = d20.plus(5).ac(15).onHit(roll(1, d8).plus(3).plus(3, d6));
/** A row that rolls rider "sa"'s dice in its own damage when the rider joins it (`Rider.joins`). */
const poolingRow: ContextualSource = {
  rowCheck: check,
  under: (context: RowContext) => (context.joined.includes("sa") ? pooled : sword).under(context),
  rollUnder: (context: RowContext) => (context.joined.includes("sa") ? pooled : sword).rollUnder(context),
};

const breathCheck = d20.plus(3).dc(15).ability("wis");
/**
 * A save row that builds its own check per context (`DCBuilder.rolledIn`), as a consumer's
 * `ContextualSource` does: the builder `rollUnder` returns is already in the context, penalty dice included.
 */
const penalisedSave: ContextualSource = {
  rowCheck: breathCheck.onSaveFailure(roll(3, 6)).rowCheck,
  under: (context: RowContext, eps?: number) => breathCheck.rolledIn(context).onSaveFailure(roll(3, 6)).toPMF(eps),
  rollUnder: (context: RowContext) => breathCheck.rolledIn(context).onSaveFailure(roll(3, 6)),
};

const sneakHit = roll(3, 6);
const sneakCrit = roll(6, 6);
/** A rider payload read per attack with the rolls behind it (`ContextualPayload.rollAt`): rider dice, not a chip. */
const sneakPerAttack: ContextualPayload = {
  at: () => {
    const onHit = sneakHit.toPMF();
    const onCrit = sneakCrit.toPMF();
    return { onHit, onCrit, vulnerable: { onHit: onHit.mapDamage((x) => 2 * x), onCrit: onCrit.mapDamage((x) => 2 * x) } };
  },
  rollAt: () => ({ onHit: sneakHit, onCrit: sneakCrit }),
};

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
  "convert first miss + sneak attack": () =>
    turn([
      { source: sword, id: "a" },
      { source: dagger, id: "b" },
    ])
      .convertFirstMiss({ id: "boon" })
      .onFirstHit(roll(3, 6), { id: "sneak" }),
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
  "paralyzed condition (auto-crit on later melee)": () =>
    turn([
      { source: sword.onEveryHit(paralyzed().untilEndOfTurn()), id: "a" },
      { source: sword.melee(), id: "b" },
    ]),
  "joins: sneak dice pooled into the first row": () =>
    Turn.from({
      attacks: [
        { id: "a", source: poolingRow },
        { id: "b", source: sword },
      ],
      riders: [{ id: "sa", on: "first-hit", damage: roll(3, d6), joins: ["a"] }],
    }),
  "joins + happens coin": () =>
    Turn.from({
      attacks: [
        { id: "a", source: poolingRow },
        { id: "b", source: sword },
      ],
      riders: [{ id: "sa", on: "first-hit", damage: roll(3, d6), joins: ["a"], happens: 0.7 }],
    }),
  "joins + row chance": () =>
    Turn.from({
      attacks: [
        { id: "a", source: poolingRow, chance: 0.6 },
        { id: "b", source: sword },
      ],
      riders: [{ id: "sa", on: "first-hit", damage: roll(3, d6), joins: ["a"] }],
    }),
  "folded chip rider + happens coin": () =>
    turn([
      { source: sword, id: "a" },
      { source: sword, id: "b" },
    ]).rider({ id: "hex", on: "first-hit", damage: roll(2, d6).toPMF(), happens: 0.75, landing: "any" }),
  "save penalty die on a contextual save row": () =>
    turn([
      { source: sword, id: "a" },
      { source: penalisedSave, id: "breath" },
    ]).onFirstHit(savePenalty(d4).untilNextSave(), { of: ["a"] }),
  "rider payload per attack with rollAt": () =>
    turn([
      { source: sword, id: "a" },
      { source: dagger, id: "b" },
    ]).rider({ id: "sneak", on: "first-hit", damage: sneakPerAttack }),
};

/** Builders with a `.sample` (a DC check: `sampleCheck`): the draw-order snapshot covers each kind of builder's own draw order. */
export const BUILDER_FIXTURES = {
  "roll 3d8 reroll 1 minimum 2 plus 2": roll(3, 8).reroll(1).minimum(2).plus(2),
  "rerollUpTo savage": roll(2, 6).rerollUpTo(1, { rolls: 2 }),
  "attack with advantage, crit on 19, a separate channel": d20
    .plus(5)
    .withAdvantage()
    .ac(15)
    .critOn(19)
    .onHit(roll(1, 8, 3))
    .plusSeparateDamage(roll(1, 6)),
  "save with half on success": d20.plus(3).dc(15).ability("dex").onSaveFailure(roll(3, 6)).saveHalf(),
  "dc check (sampleCheck)": { sample: (rng: Rng) => d20.plus(3).dc(15).ability("dex").sampleCheck(rng) },
};
