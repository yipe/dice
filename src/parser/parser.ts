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
 * count, or a keep over a large enumerated pool) can otherwise blow up memory
 * and CPU. These caps are deliberately generous so every legitimate expression
 * the suite exercises (e.g. d100000) still parses.
 */
// Must stay >= 100000: the suite asserts d100000 (100k faces) parses.
const MAX_DIE_SIDES = 1_000_000;
const MAX_DICE_COUNT = 10_000;
// multiplyDiceByDice enumerates faces^count outcomes when a keep is applied.
const MAX_KEEP_OUTCOMES = 1_000_000;

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
 * these applies only where the attack deals damage, so it is part of that damage: `(check) *
 * (1d8) + 1d6` is `(check) * ((1d8) + 1d6)`, since the grammar reads left to right.
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

function parseExpression(arr: string[], n: number): Dice {
  const first = parseArgument(arr, n);
  let finalResult = typeof first === "number" ? Dice.scalar(first) : first;
  if (typeof first === "number") finalResult.privateData.noDie = true;

  // While `finalResult` crits with its doubled hit payload, the text of each op and its argument,
  // so a trailing hit-only term joins the payload it is part of. Joined only for that case.
  let opText = finalResult.privateData.implicitCrit ? arr.join("") : undefined;
  let op = parseOperation(arr);

  while (op != null) {
    // An AC check times a payload is an attack's hit: keep the payload's text, so its crit can
    // double the dice when the string has no crit clause. Joined only for that case.
    const pending =
      op === Dice.prototype.conditionalApply && finalResult.privateData.isACCheck ? arr.join("") : undefined;
    const arg = !op.unary ? parseArgument(arr, n) : finalResult;
    const hitText = pending?.slice(0, pending.length - arr.length);
    const termText = opText?.slice(0, opText.length - arr.length);
    const before = finalResult;
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
        crit = op.call(crit, critClause ? parseBinaryArgument(arg, arr, n) : critPayload(hitText!, n));

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

      save = new Dice();
      const min = finalResult.minFace();
      save.increment(min > 0 ? min : 1, finalResult.get(min));

      saveNorm = save.total();
      finalResult = finalResult.deleteFace(min);
      save = op.call(save, parseBinaryArgument(arg, arr, n));
      saveNorm = save && saveNorm ? save.total() / saveNorm : 1;
    }

    // Handle half damage on hit (potent cantrip)
    let pc: Dice | undefined;
    let pcNorm = 1;

    if (arr.length >= 2 && arr[0] === "p" && arr[1] === "c") {
      assertToken(arr, "p");
      assertToken(arr, "c");

      pc = new Dice();
      const min = finalResult.minFace();
      pc.increment(min > 0 ? min : 1, finalResult.get(min));

      const missBefore = pc.total();
      finalResult = finalResult.deleteFace(min);

      pc = op.call(pc, parseBinaryArgument(arg, arr, n)).divideRoundDown(2); // parse the damage

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

      miss = new Dice();
      const min = finalResult.minFace();
      miss.increment(min > 0 ? min : 1, finalResult.get(min));

      missNorm = miss.total();
      finalResult = finalResult.deleteFace(min);

      miss = op.call(miss, parseBinaryArgument(arg, arr, n));
      missNorm = miss && missNorm ? miss.total() / missNorm : 1;
    }

    let norm = finalResult.total();

    const clause = crit !== undefined || save !== undefined || pc !== undefined || miss !== undefined;
    const labelled = hasOutcomeLabels(finalResult);
    if (!clause && labelled && HIT_ONLY_OPS.has(op)) {
      finalResult = applyByOutcome(finalResult, op, arg, termText, n);
    } else {
      finalResult = op.call(finalResult, arg);
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
    op = parseOperation(arr);
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
        const part = pairOp.call(left, right);
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
    const apply = own ? (value: Dice) => op.call(value, arg) : (value: Dice) => op.call(before, value);
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
      for (const track of tracks) slice.combineInPlace(track.slice(face));
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
 * A crit face the AC gate turned into 0 missed (parse() has no natural-20 auto-hit): it stays
 * miss mass and is never labelled a crit.
 */
function splitCrit(check: Dice, count: number): { crit: Dice; rest: Dice } {
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
  for (let face = sides; face > sides - count; face--) crit.combineInPlace(track.slice(face));
  const rest = subtractCounts(check, crit);
  const missed = crit.get(0);
  if (missed) {
    crit = crit.deleteFace(0);
    rest.increment(0, missed);
  }
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
 * `op(labelled, arg)` for a hit-only op, outcome by outcome, so an attack's labels survive a
 * trailing term. A doubled crit (no crit clause) takes the term into its payload and doubles the
 * whole payload again, exactly as if the term were written inside it; every other outcome,
 * an explicit crit clause's included, takes the term as written.
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
      payload = implicit.payload + termText;
      const doubled = critPayload(payload, n);
      // `op` scales every other outcome's counts by the argument's; keep the crit's share.
      applied = doubled.normalize((part.total() * argTotal) / doubled.total());
    } else {
      applied = op.call(part, arg);
    }
    result.combineInPlace(applied);
    result.setOutcomeDistribution(label as OutcomeType, applied.getFaceMap());
  }
  result.combineInPlace(op.call(rest, arg));
  if (labelled.privateData.isDCCheck) result.privateData.isDCCheck = true;
  if (payload !== undefined) result.privateData.implicitCrit = { payload };
  return result;
}

function parseArgument(s: string[], n: number): Dice | number {
  let result = parseArgumentInternal(s, n);

  while (true) {
    const next = parseArgumentInternal(s, n);
    if (next === undefined) break;

    result = multiplyDiceByDice(result as Dice | number, next);
  }

  return result as Dice | number;
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
  let normalizationFactor = 1;

  for (const key of d1.keys()) {
    let face: Dice;

    if (typeof key !== "number") {
      continue; // Skip invalid scalar
    }

    if (d2.privateData.keep) {
      // Repeat dice2 "key" times and apply keep. opDice enumerates the full
      // faces^count outcome space, so guard against a combinatorial blow-up.
      const faceCount = d2.keys().length;
      if (Math.pow(faceCount, key) > MAX_KEEP_OUTCOMES) {
        throw new DiceParseError(
          `Keep enumeration of ${faceCount}^${key} outcomes exceeds the maximum of ${MAX_KEEP_OUTCOMES}`
        );
      }
      const repeat: Dice[] = Array(key).fill(d2);
      face = opDice(repeat, d2.privateData.keep);
    } else {
      face = multiplyDice(key, d2);
    }

    normalizationFactor *= face.total();
    faces.set(key, face);
  }

  for (const [k, face] of faces) {
    const count = d1.get(k);
    result.combineInPlace(
      face.normalize((count * normalizationFactor) / face.total())
    );
  }

  result.privateData.except = {};
  // `1d20` is the die itself, and a keep of one of N rolls of it (`2kh1d20` advantage, `2kl1(1d20)`
  // disadvantage, `3kh1(1d20)` elven accuracy) is one kept natural roll, like `d20 > d20`: a crit
  // is read from either. Any other count or keep has no single natural roll.
  const [only, ...more] = d1.keys();
  const { keepCount, critTrack } = d2.privateData;
  const rolls = keepCount === undefined ? only : Math.min(only, keepCount);
  const sides = outranks(naturalSides(d2), naturalSides(d1)) ? naturalSides(d2) : naturalSides(d1);
  if (rolls === 1 && more.length === 0 && critTrack?.bare) {
    result.privateData.critTrack = bareTrack(result);
  } else if (sides > 0) {
    result.privateData.untrackedSides = sides;
  }
  if (noDie) result.privateData.noDie = true;
  return result;
}

function multiplyDice(n: number, d: Dice): Dice {
  if (n > MAX_DICE_COUNT) {
    throw new DiceParseError(
      `Dice count ${n} exceeds the maximum of ${MAX_DICE_COUNT}`
    );
  }
  if (n === 0) return new Dice(0);
  if (n === 1) return d;

  const half = Math.floor(n / 2);
  let result = multiplyDice(half, d);
  result = result.add(result);

  if (n % 2 === 1) {
    result = result.add(d);
  }

  return result;
}

function opDice(diceList: Dice[], keepFn: (values: number[]) => number): Dice {
  return opDiceInternal(diceList, new Dice(), 0, [], 1, keepFn);
}

function opDiceInternal(
  diceList: Dice[],
  result: Dice,
  index: number,
  values: number[],
  weight: number,
  combineFn: (values: number[]) => number
): Dice {
  if (index === diceList.length) {
    return result.combine(Dice.scalar(combineFn(values)).normalize(weight));
  }

  const currentDice = diceList[index];
  for (const face of currentDice.keys()) {
    values.push(face as number);
    result = opDiceInternal(
      diceList,
      result,
      index + 1,
      values,
      weight * currentDice.get(face),
      combineFn
    );
    values.pop();
  }

  return result;
}

function parseArgumentInternal(
  s: string[],
  n: number
): Dice | number | undefined {
  if (s.length === 0) return;

  const c = s[0];

  switch (c) {
    case "(":
      s.shift();
      return assertToken(s, ")", parseExpression(s, n));

    case "h":
    case "d":
      return parseDice(s, n);

    case "k":
      assertToken(s, "k");
      return parseKeep(s, n);

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

function parseKeep(s: string[], n: number): Dice | undefined {
  let keepLowest = false;

  if (peek(s, "l")) {
    assertToken(s, "l");
    keepLowest = true;
  } else if (peek(s, "h")) {
    assertToken(s, "h");
    keepLowest = false;
  } else {
    return;
  }

  const keepCount = parseNumber(s, n);
  const result = parseArgumentInternal(s, n);

  if (result instanceof Dice) {
    result.privateData.keep = keepN(keepCount, keepLowest);
    result.privateData.keepCount = keepCount;
    return result;
  }

  throw new Error("Expected Dice after keep modifier");
}

function keepN(n: number, low: boolean): (values: number[]) => number {
  return (values: number[]): number => {
    const sorted = [...values].sort((a, b) => (low ? a - b : b - a));
    return sorted.slice(0, n).reduce((sum, val) => sum + val, 0);
  };
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
