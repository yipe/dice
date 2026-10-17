/**
 * One play of a turn: the sampling twin of `Turn.walk`. The walk sums over every path through
 * the plan's steps; `sampleTurn` draws one, in the walk's order, with the walk's own state
 * (group codes, fire slots, flags, counters), so the sample's law is the joint PMF. Only the
 * dice are new: a row with a builder behind it rolls its dice (`AttackBuilder.sample`,
 * `SaveBuilder.sample`, `RollBuilder.sample`) and the dice decide which of the step's draws the
 * walk took; a row with no dice structure picks a draw by its mass and draws its total from the
 * draw's PMF (a "chip", no dice).
 */
import { AttackBuilder } from "../builder/attack";
import type { AttackSample } from "../builder/attack";
import { ParsedRollBuilder, RollBuilder } from "../builder/roll";
import type { RollSample, SampledDie } from "../builder/sample";
import { SaveBuilder } from "../builder/save";
import type { Rng } from "../common/rng";
import type { PMF } from "../pmf/pmf";
import { samplePMF, scaleValue } from "../pmf/sample";
import { contextOf, isContextual } from "./context";
import { fireMode, grantApplies, released } from "./plan";
import type { Draw, EvaluatedRider, FireMode, Step, TurnPlan } from "./plan";
import { advance, FIRST_NONE, START_CODE } from "./state";
import type { StepOutcome } from "./state";
import { SAMPLER_VERSION } from "./trace";
import type { DieRole, DieRoll, OutcomeResult, Trace, Wave } from "./trace";
import type { ContextualSource, Damage, RiderDamage, RiderPayload, RowContext } from "./types";

// Bump when `tests/sample-draw-order.test.ts`'s snapshot changes for a reason other than a bug in the
// snapshot itself; update the snapshot in the same commit.
export { SAMPLER_VERSION } from "./trace";

/**
 * Test seam: how many rows fell back to a PMF draw because none of the step's draws matched
 * what the dice showed (a structural mismatch between the plan and the sampler). Never on a
 * well-formed turn; a fixture suite asserts it stays 0.
 */
export const sampleFallbacks = { count: 0 };

/** A coin with probability `p`, certain at either end so a scripted `Rng` is not asked. */
function coin(rng: Rng, p: number): boolean {
  if (p >= 1) return true;
  if (p <= 0) return false;
  return rng.chance(p);
}

/** One of `draws` by relative mass, by the same inverse walk `samplePMF` takes over bins. */
function pickByMass(draws: readonly Draw[], rng: Rng): Draw {
  let remaining = draws.reduce((sum, draw) => sum + draw.slice.mass(), 0);
  for (let i = 0; i < draws.length - 1; i++) {
    const mass = draws[i].slice.mass();
    if (remaining <= 0) break;
    if (rng.chance(mass / remaining)) return draws[i];
    remaining -= mass;
  }
  return draws[draws.length - 1];
}

/** A sampled builder's dice as trace dice. A die that replaced a rerolled one is a `reroll`. */
function traced(dice: readonly SampledDie[], role: DieRole, by: DieRoll["by"], source: string): DieRoll[] {
  return dice.map((die) => ({
    sides: die.sides,
    face: die.face,
    role: die.reroll ? "reroll" : role,
    by,
    source,
    kept: die.kept,
  }));
}

/** The outcome a labelled PMF's draw stands for. A miss label under a save's "hit" draw is a pass. */
function resultOf(label: string, outcome: StepOutcome): OutcomeResult {
  switch (label) {
    case "crit":
      return "crit";
    case "hit":
    case "pc":
      return "hit";
    case "saveFail":
      return "save-fail";
    case "saveHalf":
      return "save-pass";
    default:
      return outcome === "miss" ? "miss" : outcome === "none" ? "skipped" : "save-pass";
  }
}

/** `pmf` with the `(1 - happens)` mass `thin` put at 0 taken out again: the rider's own payload. */
function unthin(pmf: PMF, happens: number): PMF {
  if (happens >= 1) return pmf;
  const zero = pmf.pAt(0);
  const share = zero > 0 ? Math.max(0, (zero - (1 - happens)) / zero) : 0;
  return pmf.splitByFactor((value) => (value === 0 ? share : 1))[0].normalize();
}

/**
 * A rider's dice for one landing in `mode`, or `undefined` where some part has no dice to roll
 * (a bare PMF, a payload read per attack): the caller draws a chip from the plan's payload PMF
 * instead. Mirrors `critPMF`: an explicit `critDamage` as it is; else each part's dice doubled
 * on a crit (a parsed string only where it can), flats untouched.
 */
function sampleRiderDice(payload: RiderPayload, mode: "hit" | "crit", rng: Rng): RollSample | undefined {
  const crit = mode === "crit" ? payload.critDamage : undefined;
  const damage: RiderDamage = crit ?? payload.damage;
  const parts = Array.isArray(damage) ? damage : [damage as Damage];
  if (!parts.every((part) => part instanceof RollBuilder)) return undefined;
  const dice: SampledDie[] = [];
  let total = 0;
  for (const part of parts as readonly RollBuilder[]) {
    const doubled = mode === "crit" && crit === undefined && (!(part instanceof ParsedRollBuilder) || part.canDoubleDice());
    const s = (doubled ? part.doubleDice() : part).sample(rng);
    total += s.total;
    dice.push(...s.dice);
  }
  return { total, dice };
}

/** The payload `rider` deals when `sourceId` lands: its own, or the one it names for that source. */
function payloadFor(rider: EvaluatedRider, sourceId: string): RiderPayload {
  if ((rider.on === "first-hit" || rider.on === "every-hit") && rider.perSource?.[sourceId] !== undefined) {
    return rider.perSource[sourceId];
  }
  return rider;
}

/** Whether two or more kept dice of the base pool show the same face. */
function diceMatched(base: RollSample): boolean {
  const seen = new Set<string>();
  for (const die of base.dice) {
    if (!die.kept) continue;
    const key = `${die.sides}:${die.face}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** Whether the base dice matched, where the attack has a descriptor for that landing; never otherwise. */
function matchedOf(builder: AttackBuilder, sample: AttackSample): boolean {
  if (sample.payload === undefined || sample.outcome === "miss") return false;
  return builder.diceMatchInfo()[sample.outcome] !== null && diceMatched(sample.payload.base);
}

/** The builder a row rolls with in `context`, or `undefined` for a row that is a chip. */
function rollerOf(
  source: Damage | ContextualSource | readonly Damage[] | undefined,
  context: RowContext | undefined
): AttackBuilder | SaveBuilder | RollBuilder | undefined {
  if (source === undefined || Array.isArray(source)) return undefined;
  if (source instanceof AttackBuilder || source instanceof SaveBuilder) return source;
  if (isContextual(source) && typeof source.rollUnder === "function") {
    return source.rollUnder(context ?? contextOf(source.rowCheck, 0));
  }
  // A plain `RollBuilder` row is one unlabelled payload; a parsed string has no dice to show.
  if (source instanceof RollBuilder && !(source instanceof ParsedRollBuilder)) return source;
  return undefined;
}

/** Whether `draw` is the landing kind of an attack whose draws are split by its own damage dealt (`DEALT` / `NOT_DEALT`). */
function dealtKind(draw: Draw, outcome: StepOutcome, dealt: boolean): boolean {
  if (draw.byKind === undefined) return true;
  return draw.byKind.damage === (dealt ? outcome : "none");
}

/** Whether `draw` is the class a save's dice landed in (see `CLASS_OUTCOMES` in `plan.ts`). */
function saveKind(draw: Draw, saveClass: 0 | 1 | 2 | 3): boolean {
  if (draw.byKind === undefined) return true;
  const failed = saveClass < 2;
  const dealt = saveClass === 0 || saveClass === 2;
  return draw.byKind.fail === (failed ? "hit" : "miss") && draw.byKind.damage === (dealt ? "hit" : "miss");
}

/** What one row's dice said, before the walk's draw is matched to it. */
interface RowRoll {
  outcome: StepOutcome;
  result: OutcomeResult;
  /** The row's own damage, separate channels in, vulnerability applied. */
  total: number;
  dice: DieRoll[];
  /** A landing attack's roll (for a substitute's spend and a `dice-match` read); absent otherwise. */
  attack?: { builder: AttackBuilder; sample: AttackSample };
  /** A watched save's class: failed and dealt, failed for nothing, passed and dealt, the rest. */
  saveClass?: 0 | 1 | 2 | 3;
}

/** One roll of a row with its builder: the dice, the landing and its own damage. */
function sampleRow(
  step: Step,
  roller: AttackBuilder | SaveBuilder | RollBuilder,
  context: RowContext | undefined,
  vulnerable: boolean,
  rng: Rng
): RowRoll {
  if (roller instanceof AttackBuilder) {
    const sample = roller.sample(rng, context);
    return {
      outcome: sample.outcome,
      result: sample.outcome,
      total: sample.total,
      dice: [...traced(sample.check, "attack", "you", step.id), ...traced(sample.damage, "damage", "you", step.id)],
      attack: { builder: roller, sample },
    };
  }
  if (roller instanceof SaveBuilder) {
    const sample = roller.sample(rng, context);
    const failed = sample.outcome === "save-fail";
    const dealt = sample.total > 0;
    return {
      outcome: "hit",
      result: sample.outcome,
      total: sample.total,
      dice: [...traced(sample.check, "save", "enemy", step.id), ...traced(sample.damage, "damage", "you", step.id)],
      saveClass: failed ? (dealt ? 0 : 1) : dealt ? 2 : 3,
    };
  }
  const sample = roller.sample(rng);
  return {
    outcome: "hit",
    result: "hit",
    total: vulnerable ? scaleValue(sample.total, 2, "floor") : sample.total,
    dice: traced(sample.dice, "damage", "you", step.id),
  };
}

export function sampleTurn(plan: TurnPlan, eps: number, rng: Rng): Trace {
  let codes: number[] = new Array<number>(plan.groupCount).fill(START_CODE);
  let fired: FireMode[] = new Array<FireMode>(plan.slotCount).fill(null);
  let flags = plan.startFlags;
  let counts: number[] = new Array<number>(plan.counterMax.length).fill(0);
  // A rider that may not happen takes its coin before the first row (the walk's split).
  for (const { bit, happens } of plan.coins) if (coin(rng, happens)) flags |= bit;

  const waves: Wave[] = [];
  let total = 0;

  plan.steps.forEach((step, stepIndex) => {
    const wave: Wave = { dice: [], outcomes: [] };
    waves.push(wave);
    const outcomeOf = (source: string, result: OutcomeResult, damage: number): void => {
      wave.outcomes.push({ source, result, damage });
      total += damage;
    };
    /** The walk's `merge`: dead groups and flags reset, a count the cap can no longer reach zeroed. */
    const settle = (): void => {
      codes = released(codes, step.releases);
      flags &= plan.flagLiveAfter[stepIndex];
      if (counts.length) counts = counts.map((count, counter) => (count <= step.settled[counter] ? 0 : count));
    };

    if (step.gate !== undefined) {
      const code = codes[step.gate.slot];
      if (step.gate.any ? code === START_CODE : ((code >> 2) & 0b11) === FIRST_NONE) {
        outcomeOf(step.id, "skipped", 0);
        settle();
        return;
      }
    }
    const mode = fireMode(step, codes, fired);
    if (mode === null) {
      outcomeOf(step.id, "skipped", 0);
      settle();
      return;
    }
    if (step.slot !== -1) {
      fired = [...fired];
      fired[step.slot] = mode;
    }

    if (step.variants.length === 0) {
      // Pure damage: the rider's payload in the mode it fired in. Its coin first where it may not happen.
      const rider = plan.riderOf.get(step.id) as EvaluatedRider;
      const happens = rider.happens ?? 1;
      if (!coin(rng, happens)) {
        outcomeOf(step.id, "skipped", 0);
        settle();
        return;
      }
      const drawn = sampleRiderDice(rider, mode, rng);
      let damage: number;
      if (drawn === undefined) {
        damage = samplePMF(unthin((step.damage as { hit: PMF; crit: PMF })[mode], happens), rng).total;
      } else {
        damage = drawn.total;
        wave.dice.push(...traced(drawn.dice, "rider", "you", step.id));
      }
      outcomeOf(step.id, "fired", damage);
      settle();
      return;
    }

    // A row: which context it rolls in and which draw set it draws from (built on first use).
    const flagsBefore = flags;
    const codesBefore = codes;
    const context = step.contextIndexOf(codes, fired, flags, counts);
    const variantIndex = step.select(codes, fired, flags, counts);
    const variant = step.variants[variantIndex].filter((draw) => draw.slice.mass() > eps);
    const rowContext = step.contextRowContexts[context];
    const vulnerable = step.contextVulnerable[context];
    const roller = rollerOf(plan.sourceOf.get(step.id), rowContext);

    let draw: Draw;
    let rowDamage: number;
    let rowResult: OutcomeResult;
    let rowDice: DieRoll[] = [];
    /** Per folded rider, its damage once its dice are drawn; a chip rider draws from the chosen draw's payload. */
    const riderDamage = new Map<string, number>();
    const riderDice: DieRoll[] = [];
    let spent = false;

    if (roller === undefined || !coin(rng, step.chance)) {
      // A chip row, or a row that did not happen: the draw first, then its total from the draw's own part.
      const none = variant.filter((each) => each.outcome === "none");
      draw = pickByMass(roller === undefined || none.length === 0 ? variant : none, rng);
      const own = samplePMF(draw.own ?? draw.slice, rng);
      rowDamage = own.total;
      rowResult = resultOf(own.outcome, draw.outcome);
      spent = draw.spends;
    } else {
      const roll = sampleRow(step, roller, rowContext, vulnerable, rng);
      const { outcome, attack } = roll;
      let ownTotal = roll.total;
      rowDice = roll.dice;
      rowResult = roll.result;

      // Which draws the dice could have come from: the outcome; the base dice's match where the
      // step tracks it; a save's class, or an attack's "dealt damage" kind, where the draws carry one.
      let candidates = variant.filter((each) => each.outcome === outcome);
      const matchTracked = candidates.some((each) => each.matched);
      let matched = attack !== undefined && matchTracked && matchedOf(attack.builder, attack.sample);

      // A substitute: spend the landing (re-roll the base payload, keep the better) by its policy.
      // The variant says whether holding is worth anything here: it carries hold draws only while
      // a later watched step can still land.
      if (attack?.sample.payload !== undefined && step.policy !== null && variantIndex !== 0 && (outcome === "hit" || outcome === "crit")) {
        const { base, separate } = attack.sample.payload;
        const holdAvailable = candidates.some((each) => !each.spends && each.matched === matched);
        spent =
          step.policy.kind === "always" ||
          (step.policy.kind === "below" && (base.total < step.policy[outcome] || !holdAvailable));
        if (spent) {
          const fresh = attack.builder.samplePayload(outcome, rng, rowContext).base;
          const better = fresh.total > base.total;
          ownTotal = (better ? fresh : base).total + separate.reduce((sum, s) => sum + s.total, 0);
          if (vulnerable) ownTotal = scaleValue(ownTotal, 2, "floor");
          const dropped = (dice: readonly SampledDie[]): SampledDie[] => dice.map((die) => ({ ...die, kept: false }));
          rowDice = [
            ...traced(attack.sample.check, "attack", "you", step.id),
            ...traced(better ? dropped(base.dice) : base.dice, "damage", "you", step.id),
            ...traced(better ? fresh.dice : dropped(fresh.dice), "damage", "you", step.id),
            ...traced(
              separate.flatMap((s) => s.dice),
              "damage",
              "you",
              step.id
            ),
          ];
          if (matchTracked) matched = diceMatched(better ? fresh : base);
        }
      }
      candidates = candidates.filter((each) => each.spends === spent);
      if (matchTracked) candidates = candidates.filter((each) => each.matched === matched);
      if (roll.saveClass !== undefined) {
        const saveClass = roll.saveClass;
        candidates = candidates.filter((each) => saveKind(each, saveClass));
      } else {
        candidates = candidates.filter((each) => dealtKind(each, outcome, ownTotal > 0));
      }

      // The folded riders' dice are drawn now (their law does not depend on which piece is
      // chosen); a chip rider's total comes from the chosen draw's payload below.
      let ridersDealt = false;
      let chips = false;
      for (const [id] of candidates[0]?.riders ?? []) {
        const rider = plan.riderOf.get(id) as EvaluatedRider;
        const any = rider.landing === "any";
        // A rider whose dice joined the row's roll deals nothing beside it.
        const drawn =
          rowContext !== undefined && rowContext.joined.includes(id)
            ? { total: 0, dice: [] }
            : sampleRiderDice(payloadFor(rider, step.id), !any && outcome === "crit" ? "crit" : "hit", rng);
        if (drawn === undefined) {
          chips = true;
          continue;
        }
        const damage = vulnerable && !any ? drawn.total * 2 : drawn.total;
        riderDamage.set(id, damage);
        if (damage > 0) ridersDealt = true;
        riderDice.push(...traced(drawn.dice, "rider", "you", id));
      }
      if (candidates.some((each) => each.wounded !== undefined)) {
        const wounded = ownTotal > 0 || ridersDealt;
        // Nothing dealt so far and a chip rider still to draw: the pieces' masses decide.
        if (wounded || !chips) candidates = candidates.filter((each) => each.wounded === wounded);
      }

      if (candidates.length === 0) {
        // Structural mismatch: no draw fits the dice. Fall back to the walk's own law for this
        // outcome, the dice discarded.
        sampleFallbacks.count += 1;
        const byOutcome = variant.filter((each) => each.outcome === outcome);
        draw = pickByMass(byOutcome.length === 0 ? variant : byOutcome, rng);
        const own = samplePMF(draw.own ?? draw.slice, rng);
        rowDamage = own.total;
        rowResult = resultOf(own.outcome, draw.outcome);
        rowDice = [];
        riderDice.length = 0;
        riderDamage.clear();
        spent = draw.spends;
      } else {
        draw = pickByMass(candidates, rng);
        rowDamage = ownTotal;
      }
    }

    wave.dice.push(...rowDice, ...riderDice);
    outcomeOf(step.id, rowResult, rowDamage);
    for (const [id, payload] of draw.riders ?? []) {
      outcomeOf(id, "fired", riderDamage.get(id) ?? samplePMF(payload, rng).total);
    }

    // Then exactly as the walk: flags consumed, groups advanced, slots marked, grants applied.
    const { outcome, matched, byKind } = draw;
    const consumed = flagsBefore & ~step.consumes;
    flags =
      (outcome === "none" ? flagsBefore : outcome === "miss" ? consumed : consumed & ~step.hitConsumes) &
      (draw.wounded ? ~step.wounds : ~0);
    if (draw.bumps.length !== 0) {
      counts = [...counts];
      for (const counter of draw.bumps) counts[counter]++;
    }
    codes = codesBefore.slice();
    step.updates.forEach((group, index) => {
      const kind = step.updateKinds[index];
      codes[group] = advance(codes[group], kind === null || byKind === undefined ? outcome : byKind[kind], matched);
    });
    if (spent || draw.fires.length !== 0) {
      fired = [...fired];
      const landed: FireMode = outcome === "crit" ? "crit" : "hit";
      if (spent) fired[step.spendSlot] = landed;
      for (const slot of draw.fires) fired[slot] = landed;
    }
    for (const app of step.grants) {
      if (!grantApplies(app, outcome, codesBefore, byKind, flagsBefore, draw.riders, draw.typed)) continue;
      // A grant save fails by the state the row started in; one a row that dealt damage forces is made once it is dealt.
      const chance = app.chanceOf === undefined ? app.chance : app.chanceOf(draw.wounded ? flagsBefore & ~step.wounds : flagsBefore);
      if (app.countOnly) continue;
      if (app.inForce !== 0 && (flags & app.inForce) === app.inForce) continue;
      const taken = coin(rng, chance);
      if (chance > 0 && chance < 1) outcomeOf(plan.conditionIds[app.condition], taken ? "save-fail" : "save-pass", 0);
      flags |= (taken ? app.grants : app.onSave) | (app.tried > 0 ? app.tried : 0);
    }
    settle();
  });

  return { total, samplerVersion: SAMPLER_VERSION, waves };
}
