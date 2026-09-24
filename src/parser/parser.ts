import { DiceParseError } from "../common/errors";
import { getCachingEnabled } from "../common/lru-cache";
import type { OutcomeType } from "../common/types";
import { PMF } from "../pmf/pmf";
import { Dice } from "./dice";
import type { CritTrack } from "./dice";
import { scaleParsedDice, UndoubleableExpressionError } from "./scaleDice";

type DiceOperation = ((this: Dice, other: Dice | number) => Dice) & {
  unary?: boolean;
};

/**
 * Resource-exhaustion guards. Adversarial expressions (a huge die, a huge dice
 * count, or a keep over a huge pool) can otherwise blow up memory and CPU.
 * These caps are deliberately generous so every legitimate expression the suite
 * exercises (e.g. d100000) still parses.
 */
// Must stay >= 100000: the suite asserts d100000 (100k faces) parses.
const MAX_DIE_SIDES = 1_000_000;
const MAX_DICE_COUNT = 10_000;
// Bound on keepDice's work, faces · kept² · (kept · face span + 1): its states times its steps.
const MAX_KEEP_WORK = 100_000_000;
// Face counts are whole numbers up to here; a repeat whose counts would pass it keeps probabilities.
const MAX_EXACT_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Internal parse cache for PMFs produced from string expressions.
 * Keyed by cleaned expression (spaces stripped, lowercased) and optional `n` value.
 */
const parseCache = PMF.createCache(1000);

/** Clears the internal parse cache. */
export function clearParserCache(): void {
  parseCache.clear();
}

/**
 * Parse a dice expression into a PMF.
 *
 * - Expression is case-insensitive and ignores spaces.
 */
export function parse(expression: string, n: number = 0): PMF {
  // Check cache first if enabled
  const cleaned = expression.replace(/ /g, "").toLowerCase();

  if (getCachingEnabled()) {
    const cacheKey = `${cleaned}:${n}`;
    const cached = parseCache.get(cacheKey);
    if (cached) return cached;
  }

  const chars = [...cleaned];

  let result: Dice;
  try {
    result = parseExpression(chars, n);
  } catch (error) {
    throw new DiceParseError(
      `Cannot parse dice expression [${expression}]: ${error}`,
      { expression, cause: error }
    );
  }

  result.privateData = result.privateData || {};
  result.identifier = cleaned;

  if (chars.length > 0) {
    throw new DiceParseError(
      `Unexpected token: '${chars[0]}' from expression: '${expression}'`,
      { expression }
    );
  }

  const total = result.total();
  if (total === 0) {
    throw new DiceParseError(
      `Cannot parse dice expression [${expression}]: it has no outcomes (a d0 has no faces; it is only a reroll set, as in \`reroll d0\`)`,
      { expression }
    );
  }
  if (!Number.isFinite(total)) {
    throw new DiceParseError(
      `Cannot parse dice expression [${expression}]: its outcome counts overflow (too many dice combined to count exactly)`,
      { expression }
    );
  }

  // When creating the PMF, do not epsilon prune
  const resultPMF = result.toPMF(-1);
  if (getCachingEnabled()) {
    // Store under the same cleaned key used for the lookup above.
    const cacheKey = `${cleaned}:${n}`;
    parseCache.set(cacheKey, resultPMF);
  }

  return resultPMF;
}

function combineDiceWithNormalization(
  dice: Dice,
  normValue: number,
  outcomeType: OutcomeType,
  currentNorm: number,
  finalResult: Dice
): { newNorm: number; updatedResult: Dice } {
  dice = dice.normalize(currentNorm);
  finalResult = finalResult.normalize(normValue);
  finalResult.setOutcomeDistribution(outcomeType, dice.getFaceMap());
  finalResult = finalResult.combine(dice);
  return { newNorm: currentNorm * normValue, updatedResult: finalResult };
}

/**
 * Face-wise histogram difference. NOT the same as {@link Dice.subtract}, which convolves VALUES
 * (`a - b` as numbers); this subtracts raw face COUNTS, used to take a sub-distribution (a crit
 * slice, one outcome's share) back out of the distribution it is part of.
 */
function subtractCounts(a: Dice, b: Dice): Dice {
  const result = new Dice();
  for (const [key, value] of a.getFaceEntries()) result.increment(key, value);
  for (const [key, value] of b.getFaceEntries()) result.increment(key, -value);
  return result;
}

/**
 * Ops that leave a 0 (a miss) at 0 whatever their argument. A term joined to an attack by one of
 * these applies only where the attack lands, so it is part of the payload, since the grammar reads
 * left to right: `(check) * (1d4 - 1) + 1d6` is `(check) * ((1d4 - 1) ~+ 1d6)`, a `+` adding to
 * every landed outcome, one at 0 included (see {@link applyToLanded}).
 */
const HIT_ONLY_OPS: ReadonlySet<DiceOperation> = new Set<DiceOperation>([
  Dice.prototype.addNonZero,
  Dice.prototype.conditionalApply,
  Dice.prototype.multiply,
  Dice.prototype.divideRoundUp,
  Dice.prototype.divideRoundDown,
]);

/** An AC or DC gate: its target, on the right, is never the check's natural roll. */
const GATE_OPS: ReadonlySet<DiceOperation> = new Set<DiceOperation>([Dice.prototype.ac, Dice.prototype.dc]);

/**
 * The count of tokens left in `arr` where the last `AC`/`DC` gate at this nesting level starts, or
 * undefined with none. Every term read while more tokens are left builds that check's total.
 */
function lastGateAt(arr: readonly string[]): number | undefined {
  let depth = 0;
  let at: number | undefined;
  for (let i = 0; i < arr.length - 1; i++) {
    const c = arr[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "a" || c === "d") && arr[i + 1] === "c") {
      at = arr.length - i;
    }
  }
  return at;
}

/**
 * `inCheck`: `arr` is part of a check total (a group left of an `AC`/`DC`), so its `+` always adds.
 */
function parseExpression(arr: string[], n: number, inCheck = false): Dice {
  const gate = lastGateAt(arr);
  const buildsCheck = (): boolean => inCheck || (gate !== undefined && arr.length > gate);
  // `+` adds only to a non-zero total, so a miss (0) stays 0 -- except in a check total, where a
  // running total of exactly 0 (`d20 - 5` on a natural 5) is a roll like any other.
  const readOperation = (): DiceOperation | undefined => {
    const checkTerm = buildsCheck();
    const parsed = parseOperation(arr);
    return parsed === Dice.prototype.addNonZero && checkTerm ? Dice.prototype.add : parsed;
  };

  const first = parseArgument(arr, n, buildsCheck());
  let finalResult = typeof first === "number" ? Dice.scalar(first) : first;
  if (typeof first === "number") finalResult.privateData.noDie = true;

  // While `finalResult` crits with its doubled hit payload, the text of each op and its argument,
  // so a trailing hit-only term joins the payload it is part of. Joined only for that case.
  let opText = finalResult.privateData.implicitCrit ? arr.join("") : undefined;
  let op = readOperation();

  while (op != null) {
    // An AC check times a payload is an attack's hit: keep the payload's text, so its crit can
    // double the dice when the string has no crit clause. Joined only for that case.
    const pending =
      op === Dice.prototype.conditionalApply && finalResult.privateData.isACCheck ? arr.join("") : undefined;
    const arg = !op.unary ? parseArgument(arr, n, buildsCheck()) : finalResult;
    const hitText = pending?.slice(0, pending.length - arr.length);
    const termText = opText?.slice(0, opText.length - arr.length);
    const before = finalResult;
    // An attack's check or payload: at 0 it holds its misses and its landed hits at 0 (`hit` at 0).
    const attack = isAttack(finalResult);
    const acCheck = finalResult.privateData.isACCheck === true;
    if (op === Dice.prototype.combine) assertMixable(before, arg, arr);

    // Handle crit (e.g. xcrit, crit). With no clause, an attack's crit is its hit payload with
    // every dice term doubled, at the check's natural-max rate, like the builder's. A check
    // with no die in it has no natural roll: its crit mass is exactly 0, so it takes no crit, and a
    // crit clause on it can never fire -- it is read and ignored, and the hit payload applies.
    let crit: Dice | undefined;
    let critNorm = 1;
    const critClause = arr[0] === "x" || arr[0] === "c";
    const implicitCrit = !critClause && hitText !== undefined && !finalResult.privateData.noDie;
    if (critClause || implicitCrit) {
      let count = 1;
      if (critClause) {
        const isXcrit = arr[0] === "x";
        if (isXcrit) assertToken(arr, "x");
        assertToken(arr, "c");
        assertToken(arr, "r");
        assertToken(arr, "i");
        assertToken(arr, "t");
        if (isXcrit) count = parseNumber(arr, n);
      }

      if (finalResult.privateData.noDie) {
        parseBinaryArgument(arg, arr, n);
      } else {
        ({ crit, rest: finalResult } = splitCrit(finalResult, count));

        critNorm = crit.total();
        const critArg = critClause ? parseBinaryArgument(arg, arr, n) : critPayload(hitText!, n);
        // Every crit landed, one whose total is 0 included: it takes the payload like any hit.
        crit = HIT_ONLY_OPS.has(op) ? applyToLanded(crit, op, critArg, crit.get(0), acCheck) : op.call(crit, critArg);

        critNorm = crit && critNorm ? crit.total() / critNorm : 1;
      }
    }

    // Handle save
    let save: Dice | undefined;
    let saveNorm = 1;
    if (arr[0] === "s") {
      assertToken(arr, "s");
      assertToken(arr, "a");
      assertToken(arr, "v");
      assertToken(arr, "e");

      const { miss: missed, rest } = splitMiss(finalResult, attack);
      finalResult = rest;
      saveNorm = missed.total();
      save = op.call(missed, parseBinaryArgument(arg, arr, n));
      saveNorm = save && saveNorm ? save.total() / saveNorm : 1;
    }

    // Handle half damage on hit (potent cantrip)
    let pc: Dice | undefined;
    let pcNorm = 1;

    if (arr.length >= 2 && arr[0] === "p" && arr[1] === "c") {
      assertToken(arr, "p");
      assertToken(arr, "c");

      const { miss: missed, rest } = splitMiss(finalResult, attack);
      finalResult = rest;
      const missBefore = missed.total();

      pc = op.call(missed, parseBinaryArgument(arg, arr, n)).divideRoundDown(2); // parse the damage

      const missAfter = pc ? pc.total() : 0;
      pcNorm = missBefore ? missAfter / missBefore : 1;
    }

    // Handle miss
    let miss: Dice | undefined;
    let missNorm = 1;

    if (arr[0] === "m") {
      assertToken(arr, "m");
      assertToken(arr, "i");
      assertToken(arr, "s");
      assertToken(arr, "s");

      const { miss: missed, rest } = splitMiss(finalResult, attack);
      finalResult = rest;
      missNorm = missed.total();

      miss = op.call(missed, parseBinaryArgument(arg, arr, n));
      missNorm = miss && missNorm ? miss.total() / missNorm : 1;
    }

    let norm = finalResult.total();

    const clause = crit !== undefined || save !== undefined || pc !== undefined || miss !== undefined;
    const labelled = hasOutcomeLabels(finalResult);
    const operand = finalResult;
    if (!clause && labelled && HIT_ONLY_OPS.has(op)) {
      finalResult = applyByOutcome(finalResult, op, arg, termText, n);
    } else if (HIT_ONLY_OPS.has(op)) {
      finalResult = applyToLanded(finalResult, op, arg, landedAtZero(finalResult), acCheck);
    } else {
      finalResult = op.call(finalResult, arg);
    }
    // A save's payload: every failed save (a 1) is `saveFail`, whatever the payload rolls there.
    if (operand.privateData.isDCCheck && HIT_ONLY_OPS.has(op)) {
      finalResult.setOutcomeDistribution("saveFail", op.call(operand.deleteFace(0), arg).getFaceMap());
    }
    // A landed hit that deals 0 is still a hit: record it at 0, where the misses also sit, from the
    // AC check on through every hit-only term after it.
    if (attack && HIT_ONLY_OPS.has(op)) {
      finalResult.privateData.attackPayload = true;
      const landed = landedHitsAtZero(operand, op, arg, acCheck);
      if (landed > 0) finalResult.setOutcomeDistribution("hit", { 0: landed });
    } else if (op === Dice.prototype.combine && typeof arg !== "number") {
      // `combine` keeps the left side's data; an `&` mix lands the hits at 0 of both sides.
      if (arg.privateData.attackPayload) finalResult.privateData.attackPayload = true;
      const landed = landedAtZero(operand) + landedAtZero(arg);
      if (landed > 0) finalResult.setOutcomeDistribution("hit", { 0: landed });
    }
    // An `&` mix is an attack check whichever side the gate is on: `combine` copies the left's data.
    const gated = op === Dice.prototype.combine && typeof arg !== "number" && arg.privateData.isACCheck;
    if (op === Dice.prototype.ac || gated) finalResult.privateData.isACCheck = true;
    followNaturalRoll(before, op, arg, finalResult, clause);
    norm = norm ? finalResult.total() / norm : 1;

    // Combine dice with normalization
    if (crit) {
      const result = combineDiceWithNormalization(
        crit,
        critNorm,
        "crit",
        norm,
        finalResult
      );
      norm = result.newNorm;
      finalResult = result.updatedResult;
    }

    if (save) {
      const result = combineDiceWithNormalization(
        save,
        saveNorm,
        "saveHalf",
        norm,
        finalResult
      );
      norm = result.newNorm;
      finalResult = result.updatedResult;
    }

    if (miss) {
      const result = combineDiceWithNormalization(
        miss,
        missNorm,
        "missDamage",
        norm,
        finalResult
      );
      norm = result.newNorm;
      finalResult = result.updatedResult;
    }

    if (pc) {
      const result = combineDiceWithNormalization(
        pc,
        pcNorm,
        "pc",
        norm,
        finalResult
      );
      norm = result.newNorm;
      finalResult = result.updatedResult;
    }

    if (implicitCrit) finalResult.privateData.implicitCrit = { payload: hitText! };
    opText = finalResult.privateData.implicitCrit ? arr.join("") : undefined;
    op = readOperation();
  }

  return finalResult;
}

/** The size of `value`'s natural die, whether or not its natural roll is tracked; 0 with no die. */
function naturalSides(value: Dice | number): number {
  if (typeof value === "number") return 0;
  const { critTrack, untrackedSides } = value.privateData;
  return critTrack ? critTrack.sides : (untrackedSides ?? 0);
}

/**
 * Whether a die of `sides` takes the natural roll from one of `other` sides (0: no die): a d20
 * outranks every other die, and with no d20 the larger die does. A d30 or d100 beside the d20 is a
 * bonus die.
 */
function outranks(sides: number, other: number): boolean {
  if (sides === other) return false;
  if (sides === 20 || other === 20) return sides === 20;
  return sides > other;
}

/** A check that is its natural roll itself: face f's share is its own count at f. */
function bareTrack(die: Dice): CritTrack {
  return {
    sides: die.maxFace(),
    bare: true,
    slice: (face) => {
      const slice = new Dice();
      const weight = die.get(face);
      if (weight) slice.setFace(face, weight);
      return slice;
    },
  };
}

/** A number operand as a value: a die-less branch of an `&` mix. */
function asValue(value: Dice | number): Dice {
  if (typeof value !== "number") return value;
  const scalar = Dice.scalar(value);
  scalar.privateData.noDie = true;
  return scalar;
}

function branchesOf(value: Dice | number): readonly Dice[] {
  return typeof value === "number" ? [asValue(value)] : (value.privateData.branches ?? [value]);
}

const hasOutcomeLabels = (value: Dice | number): boolean =>
  typeof value !== "number" && Object.keys(value.getFullOutcomeDistribution()).some((label) => label !== "hit");

const isSave = (value: Dice | number): boolean => typeof value !== "number" && value.privateData.isDCCheck === true;

/** An AC check, or an attack's payload: its outcomes at 0 are its misses and its landed hits at 0. */
const isAttack = (value: Dice): boolean =>
  value.privateData.isDCCheck !== true && (value.privateData.isACCheck === true || value.privateData.attackPayload === true);

/**
 * The count of `value`'s outcomes at 0 that are landed hits, not misses: an AC check's total of
 * exactly 0 that met its target, or a payload's hit that deals 0 (its `hit` at 0).
 */
const landedAtZero = (value: Dice | number): number => (typeof value === "number" ? 0 : value.getOutcomeCount("hit", 0));

/**
 * `op(value, arg)` for a hit-only op, where `landed` of `value`'s outcomes at 0 are landed hits and
 * the rest there are misses. A miss stays 0; a landed hit at 0 takes `+` like any other hit, so the
 * term is added to it, and on an AC check (`gate`) takes the payload of the check's `*`. Everywhere
 * else it is 0 damage, which `*`, `**`, `/` and `//` keep at 0.
 */
function applyToLanded(value: Dice, op: DiceOperation, arg: Dice | number, landed: number, gate: boolean): Dice {
  const lands = op === Dice.prototype.addNonZero || (gate && op === Dice.prototype.conditionalApply);
  if (!(landed > 0) || !lands) return op.call(value, arg);
  const misses = value.deleteFace(0);
  const missed = value.get(0) - landed;
  if (missed > 0) misses.setFace(0, missed);
  const result = op.call(misses, arg);
  result.combineInPlace(asValue(arg).normalize(landed));
  return result;
}

/**
 * `op(value, arg)` for a hit-only op on an attack's check (`gate`) or payload with no outcome labels
 * (a crit slice): its landed hits at 0 take the op as hits, and the result records its own.
 */
function applyToAttack(value: Dice, op: DiceOperation, arg: Dice | number, gate: boolean): Dice {
  const result = applyToLanded(value, op, arg, landedAtZero(value), gate);
  result.privateData.attackPayload = true;
  const landed = landedHitsAtZero(value, op, arg, gate);
  if (landed > 0) result.setOutcomeDistribution("hit", { 0: landed });
  return result;
}

/**
 * Split the misses a `miss`, `pc` or `save` clause applies to off `check`: an attack's (`attack`) at
 * 0, less its landed hits there, which stay with the hits; any other check's on its lowest face (a
 * save's success). The misses are moved to face 1, so the clause's `*` deals them its payload.
 */
function splitMiss(check: Dice, attack: boolean): { miss: Dice; rest: Dice } {
  const face = attack ? 0 : check.minFace();
  const landed = face === 0 ? landedAtZero(check) : 0;
  const miss = new Dice();
  miss.increment(face > 0 ? face : 1, check.get(face) - landed);
  const rest = check.deleteFace(face);
  if (landed > 0) rest.setFace(0, landed);
  return { miss, rest };
}

/**
 * An `&` mix weights each side by its count of outcomes and keeps the left side's labels. An attack
 * already split into crit, miss or save outcomes has no count to weight by (the split renormalises
 * it), a save beside a non-save has no one set of labels, and a crit, save, pc or miss clause after
 * the mix would split the left side alone. Each reading would depend on operand order, so all three
 * are refused. `rest` is the text after the mix's right side.
 */
function assertMixable(left: Dice, right: Dice | number, rest: readonly string[]): void {
  if (hasOutcomeLabels(left) || hasOutcomeLabels(right)) {
    throw new Error(
      "an `&` mix of an attack already split into crit, miss or save outcomes has no single reading: " +
        "mix the checks before the payload, like `((d20 AC 10) & (d20 AC 15)) * (1d6)`"
    );
  }
  if (isSave(left) !== isSave(right)) {
    throw new Error("an `&` mix of a saving throw (DC) with anything but another saving throw has no single set of outcomes");
  }
  const [next, after] = rest;
  if (next === "x" || next === "c" || next === "s" || next === "m" || (next === "p" && after === "c")) {
    throw new Error("a crit, save, pc or miss clause on an `&` mix has no single reading: put it after the payload's `*`");
  }
}

/**
 * Record on `after = op(before, arg)` the natural roll a crit is read from, or the size of the die
 * whose natural roll it lost, replacing whatever `op` copied from `before`. The natural roll is the
 * check's one d20 wherever it sits in the sum, or with no d20 its largest die: other dice are bonus
 * dice, and an AC or DC target is never the roll. Two dice of that size have no single natural roll
 * (`d20 + d20`, like `2d20`), except as advantage or disadvantage between two natural rolls
 * (`d20 > d20`), whose result is the new kept roll. Advantage and rerolls choose which natural roll
 * is kept, so they apply only to a bare die (no op since it). A max or min against anything else
 * follows the natural roll only where its value is the one kept: `d20 > d4` crits on every natural
 * 20, `d20 < 15` never. Every other op acts face by face, so replaying it on one natural face's
 * slice follows that face exactly. A clause splits the check's outcomes off by face, so its natural
 * roll no longer maps onto them.
 *
 * An `&` mix adds its operands' counts, so it keeps them as branches, and every later op but a
 * reroll (which draws again from the whole mix) is replayed on each branch, or each pair of branches:
 * `(d20 & d4) > d20` is `(d20 > d20) & (d4 > d20)`. The mix crits where a branch rolls the natural
 * roll's top faces, at that branch's share: `d4 & d20` crits on the d20 branch's 20, 1 in 24.
 */
function followNaturalRoll(before: Dice, op: DiceOperation, arg: Dice | number, after: Dice, clause: boolean): void {
  const data = after.privateData;
  delete data.critTrack;
  delete data.untrackedSides;
  delete data.noDie;
  delete data.branches;
  const gate = GATE_OPS.has(op);
  if (!clause && before.privateData.noDie && (gate || typeof arg === "number" || arg.privateData.noDie)) {
    data.noDie = true;
  }

  const mixed =
    before.privateData.branches !== undefined ||
    (!gate && typeof arg !== "number" && arg.privateData.branches !== undefined);
  if (!clause && op === Dice.prototype.combine) {
    data.branches = [...branchesOf(before), ...branchesOf(arg)];
  } else if (!clause && mixed && op !== Dice.prototype.reroll) {
    // Advantage is a max of two independent rolls of the mix: every pair of its branches.
    const advantage = op === Dice.prototype.advantage;
    const pairOp = advantage ? Dice.prototype.max : op;
    const lefts = branchesOf(before);
    const rights = advantage ? lefts : gate ? [asValue(arg)] : branchesOf(arg);
    data.branches = lefts.flatMap((left) =>
      rights.map((right) => {
        const part =
          HIT_ONLY_OPS.has(pairOp) && isAttack(left)
            ? applyToAttack(left, pairOp, right, left.privateData.isACCheck === true)
            : pairOp.call(left, right);
        followNaturalRoll(left, pairOp, right, part, false);
        return part;
      })
    );
  }
  if (data.branches) {
    mixNaturalRolls(after, data.branches);
    return;
  }

  const track = before.privateData.critTrack;
  const argTrack = typeof arg === "number" || gate ? undefined : arg.privateData.critTrack;
  const sides = naturalSides(before);
  const argSides = gate ? 0 : naturalSides(arg);
  const extremum = op === Dice.prototype.max || op === Dice.prototype.min;
  const own = track !== undefined && outranks(sides, argSides);
  const followed = own ? track : argTrack && outranks(argSides, sides) ? argTrack : undefined;

  if (clause) {
    // A clause leaves no natural roll: untracked below.
  } else if (op === Dice.prototype.advantage || op === Dice.prototype.reroll) {
    if (track?.bare) data.critTrack = bareTrack(after);
  } else if (extremum && track?.bare && argTrack?.bare && sides === argSides) {
    data.critTrack = bareTrack(after);
  } else if (followed) {
    // A hit-only op on an attack's slice carries its landed hits at 0 (see `applyToAttack`).
    const attack = HIT_ONLY_OPS.has(op) && isAttack(before);
    const gated = before.privateData.isACCheck === true;
    const call = (value: Dice, other: Dice | number): Dice =>
      attack ? applyToAttack(value, op, other, gated) : op.call(value, other);
    const apply = own ? (value: Dice) => call(value, arg) : (value: Dice) => call(before, value);
    const step = extremum ? (slice: Dice) => keptPart(slice, apply) : apply;
    data.critTrack = { sides: followed.sides, bare: false, slice: (face) => step(followed.slice(face)) };
  }
  if (!data.critTrack) {
    const top = outranks(argSides, sides) ? argSides : sides;
    if (top > 0) data.untrackedSides = top;
  }
}

/**
 * The natural roll of an `&` mix `after` of `branches`: the top-ranked natural die among them. A
 * branch without that die never crits; one that has it but not as one natural roll (`d20 + d20`)
 * leaves the mix without one.
 */
function mixNaturalRolls(after: Dice, branches: readonly Dice[]): void {
  const sides = branches.reduce((top, branch) => (outranks(naturalSides(branch), top) ? naturalSides(branch) : top), 0);
  if (sides === 0) return;
  const tracks: CritTrack[] = [];
  for (const branch of branches) {
    if (naturalSides(branch) !== sides) continue;
    const track = branch.privateData.critTrack;
    if (!track) {
      after.privateData.untrackedSides = sides;
      return;
    }
    tracks.push(track);
  }
  after.privateData.critTrack = {
    sides,
    bare: tracks.length === branches.length && tracks.every((track) => track.bare),
    slice: (face) => {
      const slice = new Dice();
      let landed = 0;
      for (const track of tracks) {
        const part = track.slice(face);
        slice.combineInPlace(part);
        landed += landedAtZero(part);
      }
      if (landed > 0) slice.setOutcomeDistribution("hit", { 0: landed });
      return slice;
    },
  };
}

/**
 * The share of a max or min, `apply(face)` per face of `slice`, whose result is that face's own
 * value: where the natural roll is the value kept (ties included), not the other side's.
 */
function keptPart(slice: Dice, apply: (face: Dice) => Dice): Dice {
  const result = new Dice();
  for (const [value, count] of slice.getFaceEntries()) {
    const face = new Dice();
    face.setFace(value, count);
    const kept = apply(face).get(value);
    if (kept) result.increment(value, kept);
  }
  return result;
}

/**
 * Split an attack check's crit mass off `check`: the slices of its `count` highest natural faces
 * (`count` is 1 for a natural max, N for `xcrit N`), each replayed through every op since the die --
 * bonus dice, modifiers, the AC gate -- so a crit is a natural roll in range at any bonus roll, the
 * builder's rule. A check whose natural roll is not one die throws rather than guessing from its
 * highest totals, which smear a natural roll across several totals once bonus dice are added.
 *
 * A crit face whose total missed the target reads 0 (parse() has no natural-20 auto-hit): it stays
 * miss mass and is never labelled a crit. One whose total is exactly 0 and met a target of 0 or less
 * landed: it stays a crit at 0. `xcrit0` crits on no face, so it needs no natural roll.
 */
function splitCrit(check: Dice, count: number): { crit: Dice; rest: Dice } {
  if (count === 0) {
    const none = new Dice();
    const rest = subtractCounts(check, none);
    if (landedAtZero(check) > 0) rest.setOutcomeDistribution("hit", { 0: landedAtZero(check) });
    return { crit: none, rest };
  }
  const track = check.privateData.critTrack;
  if (!track) {
    throw new Error(
      "crit rate cannot be computed exactly for this attack check: its natural roll is not one die " +
        "(a dice-valued check like 2d20 or 2kh2d20, two d20s like d20 + d20, or advantage " +
        "over a total). Build the attack with the builder API instead."
    );
  }
  const { sides } = track;
  if (count > sides) {
    // Usually a count run into the next number: `xcrit2 1d6` reads as `xcrit21 d6`.
    throw new Error(`xcrit${count} is wider than the d${sides} it reads its natural roll from`);
  }
  let crit = new Dice();
  let landed = 0;
  for (let face = sides; face > sides - count; face--) {
    const slice = track.slice(face);
    crit.combineInPlace(slice);
    landed += landedAtZero(slice);
  }
  const rest = subtractCounts(check, crit);
  const missed = crit.get(0) - landed;
  if (missed) {
    crit = crit.deleteFace(0);
    if (landed > 0) crit.setFace(0, landed);
    rest.increment(0, missed);
  }
  const restLanded = landedAtZero(check) - landed;
  if (restLanded > 0) rest.setOutcomeDistribution("hit", { 0: restLanded });
  return { crit, rest };
}

/**
 * The crit payload of an attack string with no crit clause is its hit payload `text` with
 * every dice term doubled and its flats kept -- the rewrite the parsed builder's `doubleDice()`
 * uses, so `(d20 + 5 AC 12) * (1d8 + 3)` crits as `(2d8 + 3)`, exactly like the builder. A payload
 * that rewrite cannot double (a dice-valued count like `d4d6`, a nested check) is added as-is,
 * like a bare PMF.
 */
function critPayload(text: string, n: number): Dice {
  let doubled = text;
  try {
    // The rewrite reads `n` as a digit; substitute it first so a count of `n` doubles by value.
    doubled = scaleParsedDice(text.replace(/n/g, String(n)), 2);
  } catch (error) {
    if (!(error instanceof UndoubleableExpressionError)) throw error;
  }
  const chars = [...doubled];
  const payload = parseExpression(chars, n);
  if (chars.length > 0) {
    throw new Error(`Unexpected token '${chars[0]}' in the crit payload '${doubled}'`);
  }
  return payload;
}

/**
 * Outcomes that carry a payload, so a trailing `+` adds to them even where they rolled 0: a crit, a
 * miss clause's damage, a potent-cantrip half, and a save's failure or half. A miss with no payload
 * (`missNone`) never takes it.
 */
const PAYLOAD_OUTCOMES: Readonly<Record<string, true>> = {
  crit: true,
  missDamage: true,
  pc: true,
  saveFail: true,
  saveHalf: true,
};

/**
 * `op(labelled, arg)` for a hit-only op, outcome by outcome, so an attack's labels survive a
 * trailing term. A doubled crit (no crit clause) takes the term into its payload and doubles the
 * whole payload again, exactly as if the term were written inside it; every other outcome,
 * an explicit crit clause's included, takes the term as written. A trailing `+` adds to every
 * outcome with a payload, one that rolled 0 included -- each hit and crit, each miss a `miss (…)`
 * clause deals damage to, a potent-cantrip half, and a save's failure or half -- the way the
 * builder's `plus` does, while a miss with no payload stays 0.
 */
function applyByOutcome(
  labelled: Dice,
  op: DiceOperation,
  arg: Dice | number,
  termText: string | undefined,
  n: number
): Dice {
  const implicit = labelled.privateData.implicitCrit;
  const argTotal = typeof arg === "number" ? 1 : arg.total();
  const result = new Dice();
  let rest = labelled;
  let payload: string | undefined;
  for (const [label, distribution] of Object.entries(labelled.getFullOutcomeDistribution())) {
    if (label === "hit" || distribution === undefined) continue;
    const part = new Dice();
    for (const [face, count] of Object.entries(distribution)) part.increment(Number(face), count);
    rest = subtractCounts(rest, part);
    let applied: Dice;
    if (label === "crit" && implicit && termText !== undefined) {
      // Written into the payload, a `+` term always adds: `~+`.
      payload = implicit.payload + (op === Dice.prototype.addNonZero ? "~" : "") + termText;
      const doubled = critPayload(payload, n);
      // `op` scales every other outcome's counts by the argument's; keep the crit's share.
      applied = doubled.normalize((part.total() * argTotal) / doubled.total());
    } else if (PAYLOAD_OUTCOMES[label] === true) {
      applied = applyToLanded(part, op, arg, part.get(0), false);
    } else {
      applied = op.call(part, arg);
    }
    result.combineInPlace(applied);
    result.setOutcomeDistribution(label as OutcomeType, applied.getFaceMap());
  }
  result.combineInPlace(applyToLanded(rest, op, arg, landedAtZero(labelled), false));
  if (labelled.privateData.isDCCheck) result.privateData.isDCCheck = true;
  if (payload !== undefined) result.privateData.implicitCrit = { payload };
  return result;
}

/**
 * The count of `op(operand, arg)`'s outcomes at 0 that are landed hits: each of `operand`'s hits (a
 * landed hit at 0 included, which takes the op as `applyToLanded` says) times the count of `arg`'s
 * values that `op` takes it to 0 with. `gate`: `operand` is an AC check.
 */
function landedHitsAtZero(operand: Dice, op: DiceOperation, arg: Dice | number, gate: boolean): number {
  let landed = 0;
  for (const [face, count] of Object.entries(operand.calculateHitDistribution())) {
    if (!(count > 0)) continue;
    const hit = new Dice();
    hit.setFace(Number(face), count);
    landed += applyToLanded(hit, op, arg, Number(face) === 0 ? count : 0, gate).get(0);
  }
  return landed;
}

/**
 * One argument: a repeat chain (`2d6`, `2(1d4 + 1)`, `(1d4)d6`, `4kh3d6`), or a unary minus and the
 * argument it negates, whole chain included: `-2d6` is `-(2d6)`, `1d6 + -3` is `1d6 - 3`.
 */
function parseArgument(s: string[], n: number, inCheck = false): Dice | number {
  if (s[0] === "-") {
    s.shift();
    const operand = parseArgument(s, n, inCheck);
    if (typeof operand === "number") return 0 - operand;
    const zero = asValue(0);
    const negated = zero.subtract(operand);
    followNaturalRoll(zero, Dice.prototype.subtract, operand, negated, false);
    return negated;
  }

  let result = parseArgumentInternal(s, n, inCheck);
  if (result === undefined) {
    const at = s.length === 0 ? "the end of the expression" : `'${s.slice(0, 20).join("")}'`;
    throw new Error(`Expected a number, a die, a keep or '(' at ${at}`);
  }

  for (let next = parseArgumentInternal(s, n, inCheck); next !== undefined; next = parseArgumentInternal(s, n, inCheck)) {
    result = multiplyDiceByDice(result, next);
  }

  return result;
}

function multiplyDiceByDice(d1: Dice | number, d2: Dice | number): Dice {
  // `2(15)`: copies of a constant are still a constant.
  const noDie =
    (typeof d1 === "number" || d1.privateData.noDie) && (typeof d2 === "number" || d2.privateData.noDie);
  if (typeof d1 === "number") d1 = Dice.scalar(d1);
  if (typeof d2 === "number") d2 = Dice.scalar(d2);

  const result = new Dice();
  // Keyed by face value. A Map avoids the number→string→parseFloat round-trip of
  // an object and preserves insertion order, which matches d1.keys() ascending
  // order — so the combine order below is identical to the previous version.
  const faces = new Map<number, Dice>();
  let common = 1;

  const { keep } = d2.privateData;
  for (const key of d1.keys()) {
    const face = keep ? keepDice(d2, key, keep) : multiplyDice(key, d2);

    common *= face.total();
    faces.set(key, face);
  }

  // Scaled to one common total the counts stay whole numbers; past MAX_EXACT_COUNT they could not,
  // and the product would overflow, so each count becomes its probability instead.
  const exact = common <= MAX_EXACT_COUNT;
  for (const [k, face] of faces) {
    const count = d1.get(k);
    result.combineInPlace(face.normalize(((exact ? common : 1) * count) / face.total()));
  }

  result.privateData.except = {};
  // `1d20` is the die itself, and a keep of one of N rolls of it (`2kh1d20` advantage, `2kl1(1d20)`
  // disadvantage, `3kh1(1d20)` elven accuracy) is one kept natural roll, like `d20 > d20`: a crit
  // is read from either. Any other count or keep has no single natural roll.
  const [only, ...more] = d1.keys();
  const { critTrack } = d2.privateData;
  const rolls = keep === undefined ? only : Math.min(only, keep.kept);
  const sides = outranks(naturalSides(d2), naturalSides(d1)) ? naturalSides(d2) : naturalSides(d1);
  if (rolls === 1 && more.length === 0 && critTrack?.bare) {
    result.privateData.critTrack = bareTrack(result);
  } else if (sides > 0) {
    result.privateData.untrackedSides = sides;
  }
  if (noDie) result.privateData.noDie = true;
  return result;
}

/** A repeat count is a whole number of copies, 0 included (no dice: the point mass at 0). */
function assertRepeatCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new DiceParseError(`A repeat count must be a whole number of 0 or more; this one can be ${n}`);
  }
  if (n > MAX_DICE_COUNT) {
    throw new DiceParseError(
      `Dice count ${n} exceeds the maximum of ${MAX_DICE_COUNT}`
    );
  }
}

function multiplyDice(n: number, d: Dice): Dice {
  assertRepeatCount(n);
  if (n === 0) return Dice.scalar(0);
  if (n === 1) return d;

  const half = Math.floor(n / 2);
  let result = multiplyDice(half, d);
  result = result.add(result);

  if (n % 2 === 1) {
    result = result.add(d);
  }

  // Counts past MAX_EXACT_COUNT are no longer whole numbers and a few more doublings overflow:
  // keep them as probabilities, which lose nothing more.
  const total = result.total();
  return total > MAX_EXACT_COUNT ? result.normalize(1 / total) : result;
}

/**
 * The sum of the `kept` highest (or lowest) of `count` independent copies of `die`, exactly, for
 * any per-copy distribution. Faces are visited from the kept end. With `placed` copies already on
 * earlier faces, how many of the other m = count - placed land on this face is Binomial(m, q), q
 * being this face's share of the mass from here on. Once `kept` copies are placed the kept sum is
 * final, so only states with fewer placed are carried: kept × (sums so far) states per face.
 */
function keepDice(die: Dice, count: number, { kept, lowest }: { kept: number; lowest: boolean }): Dice {
  assertRepeatCount(count);
  if (kept >= count) return multiplyDice(count, die);
  if (kept <= 0) return Dice.scalar(0);

  const faces = die
    .getFaceEntries()
    .filter(([, weight]) => weight > 0)
    .sort(([a], [b]) => (lowest ? a - b : b - a));
  if (faces.length === 0) return new Dice(); // copies of a d0: no outcomes, reported by parse()
  const span = Math.abs(faces[faces.length - 1][0] - faces[0][0]);
  const work = faces.length * kept * kept * (kept * span + 1);
  if (work > MAX_KEEP_WORK) {
    throw new DiceParseError(
      `Keep of ${kept} of ${count} copies of a ${faces.length}-face roll exceeds the maximum work of ${MAX_KEEP_WORK}`
    );
  }

  // The mass from each face on, summed from the far end so the last face's share is exactly 1.
  const tails: number[] = new Array(faces.length);
  for (let i = faces.length - 1, tail = 0; i >= 0; i--) tails[i] = tail += faces[i][1];

  const addTo = (map: Map<number, number>, key: number, p: number): void => {
    map.set(key, (map.get(key) ?? 0) + p);
  };
  // states[placed]: kept sum so far → probability, with `placed` < `kept` copies placed.
  let states = Array.from({ length: kept }, () => new Map<number, number>());
  states[0].set(0, 1);
  const done = new Map<number, number>();

  faces.forEach(([value, weight], i) => {
    const q = weight / tails[i];
    const next = Array.from({ length: kept }, () => new Map<number, number>());
    states.forEach((sums, placed) => {
      if (sums.size === 0) return;
      const left = count - placed;
      const need = kept - placed;
      // P(exactly c of the `left` copies land here) for c < need; the rest completes the keep.
      const few: number[] = [];
      let logChoose = 0;
      for (let c = 0; c < need; c++) {
        if (c > 0) logChoose += Math.log((left - c + 1) / c);
        few.push(q >= 1 ? 0 : Math.exp(logChoose + c * Math.log(q) + (left - c) * Math.log1p(-q)));
      }
      const enough = Math.max(0, 1 - few.reduce((total, p) => total + p, 0));
      for (const [sum, p] of sums) {
        few.forEach((pc, c) => {
          if (pc > 0) addTo(next[placed + c], sum + c * value, p * pc);
        });
        if (enough > 0) addTo(done, sum + need * value, p * enough);
      }
    });
    states = next;
  });

  const result = new Dice();
  for (const [sum, p] of done) result.increment(sum, p);
  return result;
}

function parseArgumentInternal(
  s: string[],
  n: number,
  inCheck = false
): Dice | number | undefined {
  if (s.length === 0) return;

  const c = s[0];

  switch (c) {
    case "(":
      s.shift();
      return assertToken(s, ")", parseExpression(s, n, inCheck));

    case "h":
    case "d":
      return parseDice(s, n);

    case "k":
      assertToken(s, "k");
      return parseKeep(s, n, inCheck);

    case "n":
      return parseNumber(s, n);

    default:
      if (isDigit(c)) return parseNumber(s, n);
      return;
  }
}

function parseBinaryArgument(
  arg: Dice | number,
  arr: string[],
  n: number
): Dice {
  if (arr.length >= 4 && arr[0] === "h" && peek(arr, "half")) {
    assertToken(arr, "half");

    const diceArg = typeof arg === "number" ? Dice.scalar(arg) : arg;
    return diceArg.divideRoundDown(2);
  }

  const parsed = parseArgument(arr, n);
  return typeof parsed === "number" ? Dice.scalar(parsed) : parsed;
}

function assertToken<T>(s: string[], expected: string, ret?: T): T | undefined {
  for (const ch of expected) {
    const found = s.shift();
    if (found !== ch) {
      throw new Error(`Expected character '${ch}', found '${found}'`);
    }
  }
  return ret;
}

function parseDice(s: string[], n: number): Dice | undefined {
  let rerollOne = false;

  if (peek(s, "hd") && peekIsNumber(s, 2)) {
    assertToken(s, "h");
    assertToken(s, "d");
    rerollOne = true;
  } else if (peek(s, "d") && peekIsNumber(s, 1)) {
    assertToken(s, "d");
  } else {
    return;
  }

  const sides = parseNumber(s, n);
  if (sides > MAX_DIE_SIDES) {
    throw new DiceParseError(
      `Die size ${sides} exceeds the maximum of ${MAX_DIE_SIDES}`
    );
  }
  let result = new Dice(sides);
  // A d0 has no faces: it is only a face set (`reroll d0` rerolls nothing), never a roll.
  if (sides === 0) return result;

  if (rerollOne) {
    // Reroll a rolled 1 exactly once, keeping the second roll (e.g. halfling
    // luck). This is the same semantics as the `reroll 1` operator; the previous
    // deleteFace(1).combine(result) computed a weighted union (P(1)=1/(2s−1)),
    // not a reroll (correct P(1)=1/s²).
    result = result.reroll(1);
  }

  result.privateData.critTrack = bareTrack(result);
  return result;
}

function peek(arr: string[], expected: string): boolean {
  if (expected.length > arr.length) return false;

  for (let i = 0; i < expected.length; i++) {
    if (arr[i] !== expected.charAt(i)) return false;
  }

  return true;
}

function peekIsNumber(arr: string[], index: number): boolean {
  if (index >= arr.length) return false;
  return isDigit(arr[index]) || arr[index] === "n";
}

function parseNumber(s: string[], n: number): number {
  let ret = "";

  while (s.length > 0 && (isDigit(s[0]) || s[0] === "n")) {
    const ch = s.shift()!;
    ret += ch === "n" ? n.toString() : ch;
  }

  if (ret.length === 0) {
    throw new Error(`Expected number, found: '${s[0]}'`);
  }

  return parseInt(ret, 10);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function parseKeep(s: string[], n: number, inCheck: boolean): Dice | undefined {
  let lowest = false;

  if (peek(s, "l")) {
    assertToken(s, "l");
    lowest = true;
  } else if (peek(s, "h")) {
    assertToken(s, "h");
  } else {
    return;
  }

  const kept = parseNumber(s, n);
  const result = parseArgumentInternal(s, n, inCheck);

  if (result instanceof Dice) {
    result.privateData.keep = { kept, lowest };
    return result;
  }

  throw new Error("Expected Dice after keep modifier");
}

function parseOperation(s: string[]): DiceOperation | undefined {
  switch (s[0]) {
    case ")":
      return;

    case "a":
      assertToken(s, "ac");
      return Dice.prototype.ac;

    case "d":
      assertToken(s, "dc");
      return Dice.prototype.dc;

    case "!":
      assertToken(s, "!");
      const adv = Dice.prototype.advantage as DiceOperation;
      adv.unary = true;
      return adv;

    case ">":
      assertToken(s, ">");
      return Dice.prototype.max;

    case "<":
      assertToken(s, "<");
      return Dice.prototype.min;

    case "+":
      assertToken(s, "+");
      return Dice.prototype.addNonZero;

    case "~":
      assertToken(s, "~");
      assertToken(s, "+");
      return Dice.prototype.add;

    case "-":
      assertToken(s, "-");
      return Dice.prototype.subtract;

    case "&":
      assertToken(s, "&");
      return Dice.prototype.combine;

    case "r":
      assertToken(s, "reroll");
      return Dice.prototype.reroll;

    case "*":
      assertToken(s, "*");

      if (peek(s, "*")) {
        assertToken(s, "*");
        return Dice.prototype.multiply;
      }

      return Dice.prototype.conditionalApply;

    case "/":
      assertToken(s, "/");
      if (s[0] === "/") {
        assertToken(s, "/");
        return Dice.prototype.divideRoundDown;
      }
      return Dice.prototype.divideRoundUp;

    case "=":
      assertToken(s, "=");
      return Dice.prototype.eq;
  }

  return;
}
